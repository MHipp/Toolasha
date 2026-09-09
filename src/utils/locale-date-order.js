/**
 * Which of month and day the runtime's locale prints first.
 *
 * Chat stamps carry two bare numbers ("[02/03 …]") and no clue which is which.
 * Guessing from the digits alone only ever works for days 13-31; on a dd/mm
 * client every day of 12 or less reads as a month, which is twelve days in
 * every month misread. The runtime locale is the missing clue: the game renders
 * the stamp through the same locale this reports on.
 */

/** A date whose month and day cannot be confused for one another. */
const PROBE_DATE = new Date(2020, 10, 22); // 22 November 2020

/** Resolved once per page: the locale cannot change without a reload. */
let dayFirstCache = null;

/**
 * Whether a locale prints the day before the month in a numeric date.
 *
 * @param {string|undefined} [locale] - A locale tag, or undefined for the runtime default
 * @returns {boolean} True when the day comes first (dd/mm), false for mm/dd
 */
export function detectDayFirst(locale) {
    try {
        const parts = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).formatToParts(PROBE_DATE);
        const dayAt = parts.findIndex((p) => p.type === 'day');
        const monthAt = parts.findIndex((p) => p.type === 'month');
        // A locale that names neither field is no evidence either way; en-US
        // order is the safer default because it is what this code assumed
        // before the locale was consulted at all.
        if (dayAt === -1 || monthAt === -1) return false;
        return dayAt < monthAt;
    } catch {
        return false;
    }
}

/**
 * Whether the runtime's locale prints the day before the month, resolved once.
 *
 * @returns {boolean} True when the client renders dates as dd/mm
 */
export function isDayFirstLocale() {
    if (dayFirstCache === null) dayFirstCache = detectDayFirst(undefined);
    return dayFirstCache;
}

/** Drop the resolved order so the next read re-detects it. Tests only. */
export function _resetDateFieldOrder() {
    dayFirstCache = null;
}
