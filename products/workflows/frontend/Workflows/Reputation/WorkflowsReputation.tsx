import { useValues } from 'kea'

import { LemonTable, LemonTag, LemonTagType, Link, Tooltip } from '@posthog/lemon-ui'

import { Sparkline } from 'lib/components/Sparkline'
import { TZLabel } from 'lib/components/TZLabel'
import { humanFriendlyNumber } from 'lib/utils/numbers'
import { urls } from 'scenes/urls'

import type {
    EmailReputationSnapshotApi,
    EmailReputationStateEnumApi,
    WorkflowEmailReputationSnapshotApi,
} from 'products/workflows/frontend/generated/api.schemas'

import { workflowsReputationLogic } from './workflowsReputationLogic'

const STATE_CONFIG: Record<EmailReputationStateEnumApi, { label: string; type: LemonTagType; tooltip: string }> = {
    insufficient_data: {
        label: 'Not enough data',
        type: 'muted',
        tooltip: 'Too few emails were sent in the window to judge the rates reliably.',
    },
    healthy: { label: 'Healthy', type: 'success', tooltip: 'Bounce and complaint rates are below all thresholds.' },
    warning: {
        label: 'Warning',
        type: 'warning',
        tooltip: 'The bounce or spam complaint rate is above the warning threshold.',
    },
    critical: {
        label: 'Critical',
        type: 'danger',
        tooltip: 'The bounce or spam complaint rate is above the critical threshold.',
    },
}

function StateTag({ state }: { state: EmailReputationStateEnumApi }): JSX.Element {
    const config = STATE_CONFIG[state] ?? STATE_CONFIG.insufficient_data
    return (
        <Tooltip title={config.tooltip}>
            <LemonTag type={config.type}>{config.label}</LemonTag>
        </Tooltip>
    )
}

function formatRate(rate: number): string {
    return `${(rate * 100).toFixed(2)}%`
}

function TeamReputationCard({
    reputation,
    history,
}: {
    reputation: EmailReputationSnapshotApi
    history: readonly EmailReputationSnapshotApi[]
}): JSX.Element {
    return (
        <div className="border rounded p-4 bg-surface-primary">
            <div className="flex items-center gap-2">
                <h3 className="mb-0">Project email reputation</h3>
                <StateTag state={reputation.state} />
            </div>
            <div className="flex flex-wrap gap-8 mt-3">
                <div>
                    <div className="text-secondary text-xs">Bounce rate</div>
                    <div className="text-lg font-semibold">{formatRate(reputation.bounce_rate)}</div>
                </div>
                <div>
                    <div className="text-secondary text-xs">Spam complaint rate</div>
                    <div className="text-lg font-semibold">{formatRate(reputation.complaint_rate)}</div>
                </div>
                <div>
                    <div className="text-secondary text-xs">Emails evaluated (recent volume)</div>
                    <div className="text-lg font-semibold">{humanFriendlyNumber(reputation.emails_sent)}</div>
                </div>
                <div>
                    <div className="text-secondary text-xs">Last evaluated</div>
                    <div className="text-lg font-semibold">
                        <TZLabel time={reputation.evaluated_at} />
                    </div>
                </div>
            </div>
            {history.length > 1 && (
                <div className="mt-4">
                    <div className="text-secondary text-xs mb-1">Bounce rate over recent evaluations</div>
                    <Sparkline
                        className="w-full h-12"
                        type="line"
                        data={history.map((snapshot) => snapshot.bounce_rate * 100)}
                        labels={history.map((snapshot) => new Date(snapshot.evaluated_at).toLocaleDateString())}
                        name="Bounce rate (%)"
                    />
                </div>
            )}
        </div>
    )
}

export function WorkflowsReputation(): JSX.Element {
    const { teamReputation, history, workflowSnapshots, reputationResponseLoading } =
        useValues(workflowsReputationLogic)

    return (
        <div className="space-y-4" data-attr="workflows-reputation">
            {teamReputation ? (
                <TeamReputationCard reputation={teamReputation} history={history} />
            ) : (
                !reputationResponseLoading && (
                    <div className="border rounded p-4 text-secondary">
                        No reputation data yet. Reputation is calculated daily from email bounces and spam complaints
                        once your workflows start sending email.
                    </div>
                )
            )}
            <LemonTable
                dataSource={[...workflowSnapshots]}
                loading={reputationResponseLoading}
                rowKey={(snapshot) => snapshot.hog_flow_id}
                emptyState="No workflows have sent enough email to be evaluated yet."
                columns={[
                    {
                        title: 'Workflow',
                        key: 'workflow',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) => (
                            <Link to={urls.workflow(snapshot.hog_flow_id, 'workflow')} className="font-semibold">
                                {snapshot.hog_flow_name || snapshot.hog_flow_id}
                            </Link>
                        ),
                    },
                    {
                        title: 'State',
                        key: 'state',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) => (
                            <StateTag state={snapshot.state} />
                        ),
                    },
                    {
                        title: 'Bounce rate',
                        key: 'bounce_rate',
                        align: 'right',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) => formatRate(snapshot.bounce_rate),
                    },
                    {
                        title: 'Complaint rate',
                        key: 'complaint_rate',
                        align: 'right',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) =>
                            formatRate(snapshot.complaint_rate),
                    },
                    {
                        title: 'Emails sent',
                        key: 'emails_sent',
                        align: 'right',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) =>
                            humanFriendlyNumber(snapshot.emails_sent),
                    },
                    {
                        title: 'Evaluated',
                        key: 'evaluated_at',
                        render: (_, snapshot: WorkflowEmailReputationSnapshotApi) => (
                            <TZLabel time={snapshot.evaluated_at} />
                        ),
                    },
                ]}
            />
        </div>
    )
}
