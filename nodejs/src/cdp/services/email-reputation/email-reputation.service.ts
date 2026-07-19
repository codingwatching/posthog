import { ClickHouseClient } from '@clickhouse/client'
import { randomUUID } from 'crypto'
import { Counter } from 'prom-client'

import { PostgresRouter, PostgresUse } from '~/common/utils/db/postgres'
import { logger } from '~/common/utils/logger'

import { DEFAULT_THRESHOLDS, ReputationMetrics, ReputationThresholds, classifyReputation } from './classifier'
import { BatchEvaluationSummary, HourlyEmailMetricsRow } from './types'

const reputationSnapshotsCounter = new Counter({
    name: 'email_reputation_snapshots_total',
    help: 'Email reputation snapshot rows written by the evaluator',
    labelNames: ['scope', 'state'],
})

interface HogFlowRow {
    id: string
    team_id: number
}

export interface EmailReputationServiceConfig {
    /** Rates are computed over the most recent this-many sends per target (SES-style
     * "representative volume"), not a fixed time window. */
    targetVolume: number
    /** How far back to scan for that volume. Bounded by app_metrics2's 90-day TTL. */
    lookbackDays: number
    thresholds: ReputationThresholds
}

export const DEFAULT_EMAIL_REPUTATION_CONFIG: EmailReputationServiceConfig = {
    targetVolume: 1000,
    lookbackDays: 30,
    thresholds: DEFAULT_THRESHOLDS,
}

interface SnapshotRow {
    teamId: number
    hogFlowId: string | null
    scope: 'workflow' | 'team'
    state: string
    bounceRate: number
    complaintRate: number
    emailsSent: number
}

/**
 * Computes per-workflow and per-team email sender reputation snapshots from app_metrics2.
 * Calculation only — no enforcement. Each daily run appends one snapshot row per target to
 * posthog_emailreputationsnapshot, so the table doubles as a time series for trend dashboards.
 *
 * Rates are volume-based, mirroring how AWS SES judges the shared sending account: each target's
 * bounce/complaint rate covers its most recent `targetVolume` sends (walking hourly buckets
 * backwards from the evaluation time, capped at `lookbackDays`), so a weekly batch blast keeps
 * counting until enough newer volume dilutes it — it doesn't vanish when a fixed time window
 * slides past. Because each window ends at evaluation time, bounces that arrive hours after
 * their send are picked up by the next run automatically.
 *
 * Runs as Temporal activities: the workflow fetches the team list once, then evaluates teams in
 * paced batches. All rows of a run share the workflow's `evaluatedAt`, and inserts are
 * ON CONFLICT DO NOTHING against a unique (team, hog_flow, evaluated_at) index, so activity
 * retries are idempotent.
 */
export class EmailReputationService {
    constructor(
        private clickhouse: ClickHouseClient,
        private postgres: PostgresRouter,
        private config: EmailReputationServiceConfig = DEFAULT_EMAIL_REPUTATION_CONFIG
    ) {}

    /**
     * Teams to evaluate: those that sent workflow email within the lookback, plus teams with a
     * recent nonzero snapshot that have gone silent — the latter get an explicit carry-forward
     * snapshot so "latest reputation" never silently goes stale.
     */
    public async fetchTeamsToEvaluate(evaluatedAt: string): Promise<number[]> {
        const result = await this.clickhouse.query({
            query: `
                SELECT DISTINCT team_id
                FROM app_metrics2
                WHERE app_source = 'hog_flow'
                    AND metric_kind = 'email'
                    AND metric_name = 'email_sent'
                    AND timestamp >= parseDateTimeBestEffort({evaluatedAt:String}) - INTERVAL {lookbackDays:UInt32} DAY
                    AND timestamp < parseDateTimeBestEffort({evaluatedAt:String})
                ORDER BY team_id
            `,
            query_params: { evaluatedAt, lookbackDays: this.config.lookbackDays },
            format: 'JSONEachRow',
        })
        const rows = await result.json<{ team_id: number | string }>()
        const teamIds = new Set(rows.map((row) => Number(row.team_id)))

        const recentlyEvaluated = await this.postgres.query<{ team_id: number }>(
            PostgresUse.COMMON_READ,
            `SELECT DISTINCT team_id FROM posthog_emailreputationsnapshot
             WHERE hog_flow_id IS NULL AND emails_sent > 0
                 AND evaluated_at >= $1::timestamptz - make_interval(days => $2)`,
            [evaluatedAt, this.config.lookbackDays],
            'emailReputationFetchRecentTeams'
        )
        for (const row of recentlyEvaluated.rows) {
            teamIds.add(Number(row.team_id))
        }

        return [...teamIds].sort((a, b) => a - b)
    }

    /**
     * Evaluate one batch of teams: fetch their hourly metrics, attribute them to workflows,
     * accumulate each target's most recent sends up to the target volume, classify, and append
     * snapshot rows. Anchored on `evaluatedAt` so a retried batch reads the same buckets and
     * dedupes against rows it already wrote.
     */
    public async evaluateTeamBatch(teamIds: number[], evaluatedAt: string): Promise<BatchEvaluationSummary> {
        const summary: BatchEvaluationSummary = {
            teamsEvaluated: 0,
            workflowsEvaluated: 0,
            snapshotsWritten: 0,
            statesByScope: { team: {}, workflow: {} },
        }
        if (teamIds.length === 0) {
            return summary
        }

        const rows = await this.fetchHourlyEmailMetrics(teamIds, evaluatedAt)
        const { flows, sourceToFlow } = await this.resolveSources([...new Set(rows.map((r) => r.appSourceId))])
        const snapshots: SnapshotRow[] = []

        // Per-workflow: fold each source's hourly buckets into its workflow, then take the most
        // recent targetVolume sends per workflow.
        const workflowBuckets = new Map<string, Map<string, ReputationMetrics>>()
        for (const row of rows) {
            const flowId = sourceToFlow.get(row.appSourceId)
            if (!flowId) {
                continue
            }
            addBucket(getOrCreate(workflowBuckets, flowId), row)
        }
        for (const [flowId, buckets] of workflowBuckets) {
            const flow = flows.get(flowId)
            if (!flow) {
                continue
            }
            const totals = accumulateRecentVolume(buckets, this.config.targetVolume)
            const { state, bounceRate, complaintRate } = classifyReputation(totals, this.config.thresholds)
            snapshots.push({
                teamId: flow.team_id,
                hogFlowId: flow.id,
                scope: 'workflow',
                state,
                bounceRate,
                complaintRate,
                emailsSent: totals.sent,
            })
            summary.workflowsEvaluated++
        }

        // Per-team: the aggregate takes its own most-recent-volume window over ALL the team's
        // email (including sources that no longer resolve to a workflow), independent of the
        // per-workflow windows — mirroring the account-level rate SES computes.
        const teamBuckets = new Map<number, Map<string, ReputationMetrics>>()
        for (const row of rows) {
            addBucket(getOrCreate(teamBuckets, row.teamId), row)
        }
        for (const teamId of teamIds) {
            const buckets = teamBuckets.get(teamId)
            // No activity in the lookback: carry-forward snapshot. The team only entered the plan
            // via a recent nonzero snapshot, so record an explicit "no recent volume" row rather
            // than leaving a stale rate presented as current.
            const totals = buckets
                ? accumulateRecentVolume(buckets, this.config.targetVolume)
                : { sent: 0, bounced: 0, complained: 0 }
            const { state, bounceRate, complaintRate } = classifyReputation(totals, this.config.thresholds)
            snapshots.push({
                teamId,
                hogFlowId: null,
                scope: 'team',
                state,
                bounceRate,
                complaintRate,
                emailsSent: totals.sent,
            })
            summary.teamsEvaluated++
        }

        for (const snapshot of snapshots) {
            const inserted = await this.insertSnapshot(snapshot, evaluatedAt)
            if (inserted) {
                summary.snapshotsWritten++
                reputationSnapshotsCounter.labels(snapshot.scope, snapshot.state).inc()
            }
            const scopeStates = summary.statesByScope[snapshot.scope]
            scopeStates[snapshot.state as keyof typeof scopeStates] =
                (scopeStates[snapshot.state as keyof typeof scopeStates] ?? 0) + 1
        }

        logger.info('[EmailReputation] evaluated batch', {
            teams: summary.teamsEvaluated,
            workflows: summary.workflowsEvaluated,
            snapshotsWritten: summary.snapshotsWritten,
            evaluatedAt,
        })
        return summary
    }

    private async fetchHourlyEmailMetrics(teamIds: number[], evaluatedAt: string): Promise<HourlyEmailMetricsRow[]> {
        const result = await this.clickhouse.query({
            // email_blocked is how SES complaint events are recorded (see helpers/ses.ts), hence
            // the `complained` alias. No HAVING sent > 0: buckets holding only late-arriving
            // bounces/complaints must still count toward the window they fall into.
            query: `
                SELECT
                    team_id,
                    app_source_id,
                    toStartOfHour(timestamp) AS hour_bucket,
                    sumIf(count, metric_name = 'email_sent') AS sent,
                    sumIf(count, metric_name = 'email_bounced') AS bounced,
                    sumIf(count, metric_name = 'email_blocked') AS complained
                FROM app_metrics2
                WHERE app_source = 'hog_flow'
                    AND metric_kind = 'email'
                    AND metric_name IN ('email_sent', 'email_bounced', 'email_blocked')
                    AND team_id IN ({teamIds:Array(UInt64)})
                    AND timestamp >= parseDateTimeBestEffort({evaluatedAt:String}) - INTERVAL {lookbackDays:UInt32} DAY
                    AND timestamp < parseDateTimeBestEffort({evaluatedAt:String})
                GROUP BY team_id, app_source_id, hour_bucket
            `,
            query_params: { teamIds, evaluatedAt, lookbackDays: this.config.lookbackDays },
            format: 'JSONEachRow',
        })
        const rows = await result.json<{
            team_id: number | string
            app_source_id: string
            hour_bucket: string
            sent: number | string
            bounced: number | string
            complained: number | string
        }>()

        return rows.map((row) => ({
            teamId: Number(row.team_id),
            appSourceId: row.app_source_id,
            hourBucket: row.hour_bucket,
            sent: Number(row.sent),
            bounced: Number(row.bounced),
            complained: Number(row.complained),
        }))
    }

    /**
     * Resolve app_source_ids to workflows. Batch-triggered runs record metrics under the batch-job
     * id (`parentRunId`), not the workflow id — and batch broadcasts are the highest-risk email
     * blasts — so unmatched ids are resolved through workflows_hogflowbatchjob and folded into the
     * parent workflow. Ids matching neither (deleted flows, plain hog functions) resolve to
     * nothing and only count toward the team aggregate.
     */
    private async resolveSources(sourceIds: string[]): Promise<{
        flows: Map<string, HogFlowRow>
        sourceToFlow: Map<string, string>
    }> {
        const flows = await this.fetchHogFlows(sourceIds)
        const sourceToFlow = new Map<string, string>()
        for (const id of sourceIds) {
            if (flows.has(id)) {
                sourceToFlow.set(id, id)
            }
        }

        const unmatched = sourceIds.filter((id) => !sourceToFlow.has(id))
        const batchJobToFlow = await this.fetchBatchJobFlowIds(unmatched)
        const extraFlowIds = [...new Set(batchJobToFlow.values())].filter((id) => !flows.has(id))
        for (const [id, flow] of await this.fetchHogFlows(extraFlowIds)) {
            flows.set(id, flow)
        }
        for (const [batchJobId, flowId] of batchJobToFlow) {
            if (flows.has(flowId)) {
                sourceToFlow.set(batchJobId, flowId)
            }
        }

        return { flows, sourceToFlow }
    }

    private async fetchBatchJobFlowIds(ids: string[]): Promise<Map<string, string>> {
        if (ids.length === 0) {
            return new Map()
        }
        const result = await this.postgres.query<{ id: string; hog_flow_id: string }>(
            PostgresUse.COMMON_READ,
            `SELECT id, hog_flow_id FROM workflows_hogflowbatchjob WHERE id = ANY($1)`,
            [ids],
            'emailReputationFetchBatchJobs'
        )
        return new Map(result.rows.map((row) => [row.id, row.hog_flow_id]))
    }

    private async fetchHogFlows(ids: string[]): Promise<Map<string, HogFlowRow>> {
        if (ids.length === 0) {
            return new Map()
        }
        const result = await this.postgres.query<HogFlowRow>(
            PostgresUse.COMMON_READ,
            `SELECT id, team_id FROM posthog_hogflow WHERE id = ANY($1)`,
            [ids],
            'emailReputationFetchHogFlows'
        )
        return new Map(result.rows.map((row) => [row.id, row]))
    }

    /** Returns true if a row was written, false if it already existed (retry dedupe). */
    private async insertSnapshot(snapshot: SnapshotRow, evaluatedAt: string): Promise<boolean> {
        const result = await this.postgres.query(
            PostgresUse.COMMON_WRITE,
            `INSERT INTO posthog_emailreputationsnapshot
                (id, team_id, hog_flow_id, scope, state, bounce_rate, complaint_rate, emails_sent,
                 evaluated_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
             ON CONFLICT DO NOTHING`,
            [
                randomUUID(),
                snapshot.teamId,
                snapshot.hogFlowId,
                snapshot.scope,
                snapshot.state,
                snapshot.bounceRate,
                snapshot.complaintRate,
                snapshot.emailsSent,
                evaluatedAt,
            ],
            'emailReputationInsertSnapshot'
        )
        return (result.rowCount ?? 0) > 0
    }
}

function getOrCreate<K>(map: Map<K, Map<string, ReputationMetrics>>, key: K): Map<string, ReputationMetrics> {
    let value = map.get(key)
    if (!value) {
        value = new Map()
        map.set(key, value)
    }
    return value
}

function addBucket(buckets: Map<string, ReputationMetrics>, row: HourlyEmailMetricsRow): void {
    const acc = buckets.get(row.hourBucket) ?? { sent: 0, bounced: 0, complained: 0 }
    acc.sent += row.sent
    acc.bounced += row.bounced
    acc.complained += row.complained
    buckets.set(row.hourBucket, acc)
}

/**
 * Walk hourly buckets newest-first, accumulating until the target send volume is reached (the
 * crossing bucket is included whole — hourly granularity). Bounce-only buckets newer than the
 * last sends are naturally included, which is how late-arriving bounces get counted.
 */
export function accumulateRecentVolume(
    buckets: Map<string, ReputationMetrics>,
    targetVolume: number
): ReputationMetrics {
    const hours = [...buckets.keys()].sort().reverse()
    const totals: ReputationMetrics = { sent: 0, bounced: 0, complained: 0 }
    for (const hour of hours) {
        const bucket = buckets.get(hour)!
        totals.sent += bucket.sent
        totals.bounced += bucket.bounced
        totals.complained += bucket.complained
        if (totals.sent >= targetVolume) {
            break
        }
    }
    return totals
}
