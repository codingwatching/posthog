import { ReputationState } from './classifier'

/** Per-source email metrics aggregated from app_metrics2 over the evaluation window.
 * `appSourceId` is usually a HogFlow id but can be a batch-job id; rows that don't match a
 * HogFlow still count toward the team aggregate. */
export interface EmailMetricsRow {
    teamId: number
    appSourceId: string
    sent: number
    bounced: number
    complained: number
}

/** Counts returned by a batch evaluation — snapshot rows never ride Temporal workflow history. */
export interface BatchEvaluationSummary {
    teamsEvaluated: number
    workflowsEvaluated: number
    snapshotsWritten: number
    statesByScope: Record<'team' | 'workflow', Partial<Record<ReputationState, number>>>
}
