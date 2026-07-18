import { getColorVar } from 'lib/colors'

// Single source of truth for metric colors across the workflow metric views. Keyed by the metric's
// display name so the same label reads the same color everywhere — in the summary tiles and in the
// trends chart below them. Pass this to `AppMetricsTrends` as `seriesColors` and to `AppMetricSummary`
// so tiles and charts never drift apart.
//
// Only `success`/`blue`/`purple`/`warning`/`danger` exist as themed color vars; the rest (`orange`,
// `indigo`, `red`, `primary`) resolve to white in dark mode. The whole-workflow summary has five
// series, so it uses those five. The email and push funnels have more series than there are distinct
// semantic colors, so they use the data-visualization palette (`data-color-*`), which is built for it.
export const METRIC_COLORS: Record<string, string> = {
    // Whole-workflow summary
    'In progress': getColorVar('warning'),
    Started: getColorVar('success'),
    Emails: getColorVar('blue'),
    'Push notifications': getColorVar('danger'),
    Messages: getColorVar('blue'),
    Completed: getColorVar('warning'),
    Converted: getColorVar('purple'),
    // Email + push step funnels
    Sent: getColorVar('data-color-1'),
    Delivered: getColorVar('data-color-2'),
    Failed: getColorVar('data-color-3'),
    Opened: getColorVar('data-color-4'),
    'Link clicked': getColorVar('data-color-5'),
    Bounced: getColorVar('data-color-6'),
    'Bounce prevented': getColorVar('data-color-7'),
    Blocked: getColorVar('data-color-8'),
    'Marked as spam': getColorVar('data-color-9'),
    Skipped: getColorVar('data-color-2'),
}
