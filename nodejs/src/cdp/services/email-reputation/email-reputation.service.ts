import { ClickHouseClient } from '@clickhouse/client'
import { randomUUID } from 'crypto'
import { Counter } from 'prom-client'

import { PostgresRouter, PostgresUse } from '~/common/utils/db/postgres'
import { logger } from '~/common/utils/logger'

import { DEFAULT_THRESHOLDS, ReputationThresholds, classifyReputation } from './classifier'
import { BatchEvaluationSummary, EmailMetricsRow } from './types'

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
    windowHours: number
    thresholds: ReputationThresholds
}

export const DEFAULT_EMAIL_REPUTATION_CONFIG: EmailReputationServiceConfig = {
    windowHours: 24,
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

    /** Teams that sent any workflow email in the window ending at `evaluatedAt` (ISO datetime). */
    public async fetchTeamsToEvaluate(evaluatedAt: string): Promise<number[]> {
        const result = await this.clickhouse.query({
            query: `
                SELECT DISTINCT team_id
                FROM app_metrics2
                WHERE app_source = 'hog_flow'
                    AND metric_kind = 'email'
                    AND metric_name = 'email_sent'
                    AND timestamp >= parseDateTimeBestEffort({evaluatedAt:String}) - INTERVAL {windowHours:UInt32} HOUR
                    AND timestamp < parseDateTimeBestEffort({evaluatedAt:String})
                ORDER BY team_id
            `,
            query_params: { evaluatedAt, windowHours: this.config.windowHours },
            format: 'JSONEachRow',
        })
        const rows = await result.json<{ team_id: number | string }>()
        return rows.map((row) => Number(row.team_id))
    }

    /**
     * Evaluate one batch of teams: fetch their metrics, attribute them to workflows, classify,
     * and append snapshot rows. Anchored on `evaluatedAt` so a retried batch reads the same
     * window and dedupes against rows it already wrote.
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

        const metrics = await this.fetchEmailMetrics(teamIds, evaluatedAt)
        if (metrics.length === 0) {
            return summary
        }

        const { flows, metricsByFlowId } = await this.attributeMetricsToFlows(metrics)
        const snapshots: SnapshotRow[] = []

        for (const [flowId, flowMetrics] of metricsByFlowId) {
            const flow = flows.get(flowId)
            if (!flow) {
                continue
            }
            const { state, bounceRate, complaintRate } = classifyReputation(flowMetrics, this.config.thresholds)
            snapshots.push({
                teamId: flow.team_id,
                hogFlowId: flow.id,
                scope: 'workflow',
                state,
                bounceRate,
                complaintRate,
                emailsSent: flowMetrics.sent,
            })
            summary.workflowsEvaluated++
        }

        const metricsByTeam = new Map<number, { sent: number; bounced: number; complained: number }>()
        for (const metric of metrics) {
            const acc = metricsByTeam.get(metric.teamId) ?? { sent: 0, bounced: 0, complained: 0 }
            acc.sent += metric.sent
            acc.bounced += metric.bounced
            acc.complained += metric.complained
            metricsByTeam.set(metric.teamId, acc)
        }
        for (const [teamId, totals] of metricsByTeam) {
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

    private async fetchEmailMetrics(teamIds: number[], evaluatedAt: string): Promise<EmailMetricsRow[]> {
        const result = await this.clickhouse.query({
            // email_blocked is how SES complaint events are recorded (see helpers/ses.ts), hence
            // the `complained` alias.
            query: `
                SELECT
                    team_id,
                    app_source_id,
                    sumIf(count, metric_name = 'email_sent') AS sent,
                    sumIf(count, metric_name = 'email_bounced') AS bounced,
                    sumIf(count, metric_name = 'email_blocked') AS complained
                FROM app_metrics2
                WHERE app_source = 'hog_flow'
                    AND metric_kind = 'email'
                    AND metric_name IN ('email_sent', 'email_bounced', 'email_blocked')
                    AND team_id IN ({teamIds:Array(UInt64)})
                    AND timestamp >= parseDateTimeBestEffort({evaluatedAt:String}) - INTERVAL {windowHours:UInt32} HOUR
                    AND timestamp < parseDateTimeBestEffort({evaluatedAt:String})
                GROUP BY team_id, app_source_id
                HAVING sent > 0
            `,
            query_params: { teamIds, evaluatedAt, windowHours: this.config.windowHours },
            format: 'JSONEachRow',
        })
        const rows = await result.json<{
            team_id: number | string
            app_source_id: string
            sent: number | string
            bounced: number | string
            complained: number | string
        }>()

        return rows.map((row) => ({
            teamId: Number(row.team_id),
            appSourceId: row.app_source_id,
            sent: Number(row.sent),
            bounced: Number(row.bounced),
            complained: Number(row.complained),
        }))
    }

    /**
     * Resolve metric rows to workflows and aggregate per workflow. Batch-triggered runs record
     * metrics under the batch-job id (`parentRunId`), not the workflow id — and batch broadcasts are
     * the highest-risk email blasts — so unmatched app_source_ids are resolved through
     * posthog_hogflowbatchjob and folded into the parent workflow's numbers. Ids matching neither
     * (deleted flows, plain hog functions) still count toward the team aggregate.
     */
    private async attributeMetricsToFlows(metrics: EmailMetricsRow[]): Promise<{
        flows: Map<string, HogFlowRow>
        metricsByFlowId: Map<string, { sent: number; bounced: number; complained: number }>
    }> {
        const sourceIds = [...new Set(metrics.map((m) => m.appSourceId))]
        const flows = await this.fetchHogFlows(sourceIds)

        const unmatched = sourceIds.filter((id) => !flows.has(id))
        const batchJobToFlow = await this.fetchBatchJobFlowIds(unmatched)
        const extraFlowIds = [...new Set(batchJobToFlow.values())].filter((id) => !flows.has(id))
        for (const [id, flow] of await this.fetchHogFlows(extraFlowIds)) {
            flows.set(id, flow)
        }

        const metricsByFlowId = new Map<string, { sent: number; bounced: number; complained: number }>()
        for (const metric of metrics) {
            const flowId = flows.has(metric.appSourceId) ? metric.appSourceId : batchJobToFlow.get(metric.appSourceId)
            if (!flowId || !flows.has(flowId)) {
                continue
            }
            const acc = metricsByFlowId.get(flowId) ?? { sent: 0, bounced: 0, complained: 0 }
            acc.sent += metric.sent
            acc.bounced += metric.bounced
            acc.complained += metric.complained
            metricsByFlowId.set(flowId, acc)
        }
        return { flows, metricsByFlowId }
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
