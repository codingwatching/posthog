import { useValues } from 'kea'
import { useMemo } from 'react'

import { getColorVar } from 'lib/colors'
import { AppMetricsFilters } from 'lib/components/AppMetrics/AppMetricsFilters'
import { appMetricsLogic } from 'lib/components/AppMetrics/appMetricsLogic'
import { AppMetricsTrends } from 'lib/components/AppMetrics/AppMetricsTrends'
import { AppMetricSummary } from 'lib/components/AppMetrics/AppMetricSummary'
import { METRIC_COLORS } from 'lib/components/AppMetrics/metricColors'

const HOGFUNCTION_METRIC_KEYS = ['succeeded', 'failed', 'filtered', 'disabled_permanently', 'quota_limited'] as const

export const HOGFUNCTION_METRICS_INFO: Record<string, { name: string; description: string; color: string }> = {
    succeeded: {
        name: 'Success',
        description: 'Total number of events processed successfully',
        color: METRIC_COLORS['Success'],
    },
    failed: {
        name: 'Failure',
        description: 'Total number of events that had errors during processing',
        color: METRIC_COLORS['Failure'],
    },
    filtered: {
        name: 'Filtered',
        description: 'Total number of events that were filtered out',
        color: METRIC_COLORS['Filtered'],
    },
    disabled_permanently: {
        name: 'Disabled',
        description:
            'Total number of events that were skipped due to the destination being permanently disabled (due to prolonged issues with the destination)',
        color: METRIC_COLORS['Disabled'],
    },
    quota_limited: {
        name: 'Quota Limited',
        description: 'Total number of invocations blocked due to quota limits',
        color: METRIC_COLORS['Quota Limited'],
    },
}

export function HogFunctionMetrics({
    id,
    seriesColors,
}: {
    id: string
    seriesColors?: Record<string, string>
}): JSX.Element {
    const logic = appMetricsLogic({
        logicKey: `hog-function-metrics-${id}`,
        loadOnMount: true,
        loadOnChanges: true,
        forceParams: {
            appSource: 'hog_function',
            appSourceId: id,
            metricName: [...HOGFUNCTION_METRIC_KEYS],
            breakdownBy: 'metric_name',
        },
    })

    const { appMetricsTrends, appMetricsTrendsLoading, getSingleTrendSeries } = useValues(logic)

    // Only destinations pass `seriesColors`; without it the chart is left exactly as before, so the
    // transformations and site apps that share this component render identically.
    const trends = useMemo(() => {
        if (!appMetricsTrends || !seriesColors) {
            return appMetricsTrends
        }
        return {
            ...appMetricsTrends,
            series: appMetricsTrends.series.map((series) => ({
                ...series,
                name: HOGFUNCTION_METRICS_INFO[series.name]?.name ?? series.name,
            })),
        }
    }, [appMetricsTrends, seriesColors])

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-row gap-2 flex-wrap justify-end">
                <AppMetricsFilters logicKey={`hog-function-metrics-${id}`} />
            </div>

            <div className="flex flex-row gap-2 flex-wrap justify-center">
                {HOGFUNCTION_METRIC_KEYS.map((key) => (
                    <AppMetricSummary
                        key={key}
                        name={HOGFUNCTION_METRICS_INFO[key].name}
                        description={HOGFUNCTION_METRICS_INFO[key].description}
                        loading={appMetricsTrendsLoading}
                        timeSeries={getSingleTrendSeries(key)}
                        previousPeriodTimeSeries={getSingleTrendSeries(key, true)}
                        color={HOGFUNCTION_METRICS_INFO[key].color}
                        colorIfZero={getColorVar('muted')}
                        hideIfZero={!['succeeded', 'failed', 'filtered'].includes(key)}
                    />
                ))}
            </div>
            <AppMetricsTrends appMetricsTrends={trends} loading={appMetricsTrendsLoading} seriesColors={seriesColors} />
        </div>
    )
}
