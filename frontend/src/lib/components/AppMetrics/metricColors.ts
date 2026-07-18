import { getColorVar } from 'lib/colors'

// Single source of truth for metric colors across the workflow metric views. Keyed by the metric's
// display name so the same label reads the same color everywhere — in the summary tiles and in the
// trends chart below them. Pass this to `AppMetricsTrends` as `seriesColors` and use it for each
// tile's `color`, so tiles and charts never drift apart.
export const METRIC_COLORS: Record<string, string> = {
    // Whole-workflow summary
    'In progress': getColorVar('warning'),
    Started: getColorVar('success'),
    Emails: getColorVar('blue'),
    'Push notifications': getColorVar('orange'),
    Messages: getColorVar('blue'),
    // Completed keeps the trends chart legible: the tiles color both Started and Completed green, and
    // two green lines in one chart are indistinguishable, so Completed takes its own color here.
    Completed: getColorVar('warning'),
    Converted: getColorVar('purple'),
    // Email step
    Sent: getColorVar('primary'),
    Delivered: getColorVar('success'),
    Failed: getColorVar('danger'),
    Opened: getColorVar('blue'),
    'Link clicked': getColorVar('indigo'),
    Bounced: getColorVar('orange'),
    'Bounce prevented': getColorVar('purple'),
    Blocked: getColorVar('red'),
    'Marked as spam': getColorVar('danger'),
    // Push step
    Skipped: getColorVar('warning'),
}
