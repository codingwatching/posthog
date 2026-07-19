import { randomUUID } from 'crypto'

import { FixtureHogFlowBuilder } from '~/cdp/_tests/builders/hogflow.builder'
import { insertHogFlow } from '~/cdp/_tests/fixtures-hogflows'
import { HogFlow } from '~/cdp/schema/hogflow'
import { closeHub, createHub } from '~/common/utils/db/hub'
import { PostgresUse } from '~/common/utils/db/postgres'
import { createTeam, getTeam, resetTestDatabase } from '~/tests/helpers/sql'
import { Hub } from '~/types'

import { DEFAULT_THRESHOLDS } from './classifier'
import { EmailReputationService } from './email-reputation.service'
import { EmailMetricsRow } from './types'

const EVALUATED_AT = '2026-07-10T06:00:00.000Z'

describe('EmailReputationService', () => {
    jest.setTimeout(5000)

    let hub: Hub
    let service: EmailReputationService
    let mockClickhouse: { query: jest.Mock }
    let teamId: number

    const insertEmailFlow = async (): Promise<HogFlow> => {
        return await insertHogFlow(
            hub.postgres,
            new FixtureHogFlowBuilder()
                .withTeamId(teamId)
                .withStatus('active')
                .withWorkflow({
                    actions: {
                        trigger: { type: 'trigger', config: { type: 'event', filters: {} } },
                        send_email: { type: 'function_email', config: { template_id: 'template-email' } } as any,
                        exit: { type: 'exit', config: {} },
                    },
                    edges: [
                        { from: 'trigger', to: 'send_email', type: 'continue' },
                        { from: 'send_email', to: 'exit', type: 'continue' },
                    ],
                })
                .build()
        )
    }

    const insertBatchJob = async (hogFlowId: string): Promise<string> => {
        const batchJobId = randomUUID()
        await hub.postgres.query(
            PostgresUse.COMMON_WRITE,
            `INSERT INTO workflows_hogflowbatchjob (id, team_id, hog_flow_id, variables, filters, status, created_at, updated_at)
             VALUES ($1, $2, $3, '{}', '{}', 'completed', now(), now())`,
            [batchJobId, teamId, hogFlowId],
            'testInsertBatchJob'
        )
        return batchJobId
    }

    const mockMetrics = (rows: EmailMetricsRow[]): void => {
        mockClickhouse.query.mockResolvedValue({
            json: () =>
                Promise.resolve(
                    rows.map((row) => ({
                        team_id: row.teamId,
                        app_source_id: row.appSourceId,
                        sent: row.sent,
                        bounced: row.bounced,
                        complained: row.complained,
                    }))
                ),
        })
    }

    const getSnapshots = async (): Promise<any[]> => {
        const result = await hub.postgres.query(
            PostgresUse.COMMON_READ,
            `SELECT * FROM posthog_emailreputationsnapshot WHERE team_id = $1 ORDER BY scope, hog_flow_id`,
            [teamId],
            'testGetSnapshots'
        )
        return result.rows
    }

    beforeEach(async () => {
        hub = await createHub()
        await resetTestDatabase()
        const team = await getTeam(hub.postgres, 2)
        teamId = await createTeam(hub.postgres, team!.organization_id)
        mockClickhouse = { query: jest.fn() }
        service = new EmailReputationService(mockClickhouse as any, hub.postgres, {
            windowHours: 24,
            thresholds: DEFAULT_THRESHOLDS,
        })
    })

    afterEach(async () => {
        await closeHub(hub)
    })

    it('writes workflow and team snapshots, and a retried batch adds no duplicate rows', async () => {
        const flow = await insertEmailFlow()
        mockMetrics([{ teamId, appSourceId: flow.id, sent: 1000, bounced: 60, complained: 0 }])

        const summary = await service.evaluateTeamBatch([teamId], EVALUATED_AT)
        expect(summary).toMatchObject({ teamsEvaluated: 1, workflowsEvaluated: 1, snapshotsWritten: 2 })

        const rows = await getSnapshots()
        expect(rows).toHaveLength(2)
        const workflowRow = rows.find((r) => r.hog_flow_id === flow.id)
        expect(workflowRow).toMatchObject({ scope: 'workflow', state: 'critical', emails_sent: '1000' })
        expect(workflowRow.bounce_rate).toBeCloseTo(0.06)
        expect(rows.find((r) => r.hog_flow_id === null)).toMatchObject({ scope: 'team', state: 'critical' })

        // Same evaluatedAt (a Temporal activity retry) dedupes on the unique index
        const retry = await service.evaluateTeamBatch([teamId], EVALUATED_AT)
        expect(retry.snapshotsWritten).toEqual(0)
        expect(await getSnapshots()).toHaveLength(2)

        // A later run appends new history rows instead of updating in place
        await service.evaluateTeamBatch([teamId], '2026-07-11T06:00:00.000Z')
        expect(await getSnapshots()).toHaveLength(4)
    })

    it('folds batch-job metrics into the parent workflow and counts orphans only at team level', async () => {
        const flow = await insertEmailFlow()
        const batchJobId = await insertBatchJob(flow.id)
        mockMetrics([
            { teamId, appSourceId: flow.id, sent: 400, bounced: 4, complained: 0 },
            { teamId, appSourceId: batchJobId, sent: 600, bounced: 20, complained: 0 },
            // Matches neither a flow nor a batch job (e.g. deleted flow): team aggregate only
            { teamId, appSourceId: randomUUID(), sent: 100, bounced: 100, complained: 0 },
        ])

        await service.evaluateTeamBatch([teamId], EVALUATED_AT)

        const rows = await getSnapshots()
        const workflowRow = rows.find((r) => r.hog_flow_id === flow.id)
        // 400+600 sent, 4+20 bounced = 2.4% → warning
        expect(workflowRow).toMatchObject({ state: 'warning', emails_sent: '1000' })
        expect(workflowRow.bounce_rate).toBeCloseTo(0.024)

        const teamRow = rows.find((r) => r.hog_flow_id === null)
        // Orphan row included: 1100 sent, 124 bounced ≈ 11.3% → critical
        expect(teamRow).toMatchObject({ state: 'critical', emails_sent: '1100' })
    })
})
