/**
 * Which of month and day the runtime's locale prints first, and the date a chat
 * stamp means.
 *
 * Chat stamps carry two bare numbers ("[02/03 …]"), no clue which is which and
 * no year. Guessing the order from the digits alone only ever works for days
 * 13-31; on a dd/mm client every day of 12 or less reads as a month, which is
 * twelve days in every month misread. The runtime locale is the missing clue:
 * the game renders the stamp through the same locale this reports on.
 *
 * The runtime locale, specifically, and not the game's own language setting:
 * the client builds the stamp with `toLocaleDateString(undefined, …)`, and its
 * bundle passes a locale to no date formatter at all. Only its *numbers* follow
 * the game's language (see `number-parser.js`); its dates follow the browser.
 * Changing the game's language leaves the stamp format alone — confirmed both in
 * the client bundle and by changing it in the game's own settings.
 */
/** A date whose month and day cannot be confused for one another. */
const PROBE_DATE = new Date(2020, 10, 22); // 22 November 2020

/** A stamp this far ahead of now is last year's, not the future. See {@link chatStampToDate}. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

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

/**
 * The date a chat stamp's fields mean, in local time.
 *
 * The field order comes from the locale, but the digits overrule it whenever
 * they can: a field over 12 is a day whatever the locale claims, and what the
 * page actually rendered is stronger evidence than what the locale API predicts
 * it would. A stamp whose fields are both over 12 is no date under any reading
 * and is dropped rather than guessed at.
 *
 * A stamp carries no year, and chat is always the recent past: the current year
 * unless that would put the message in the future, which only a log spanning
 * New Year can do. A day of slack absorbs a clock that is a little behind the
 * game's, so a stamp from moments ago is never thrown back a year.
 *
 * @param {object} fields - The stamp's numbers, already parsed out of its regex
 * @param {number} fields.first - The first date field
 * @param {number} fields.second - The second date field
 * @param {boolean} fields.ambiguousOrder - True for the slash format, whose field order
 *   only the locale can settle; false for the dash and dot formats, which are day-first
 *   in every locale that renders them
 * @param {number} fields.hour - Hour, 12-hour when `period` is given
 * @param {number} fields.minute - Minute
 * @param {number} fields.sec - Second
 * @param {string} [fields.period] - 'AM' or 'PM' when the stamp carries one
 * @param {Date} [now] - The instant the stamp is read against; defaults to the clock
 * @returns {Date|null} The stamp's date, or null when no reading of it is one
 */
export function chatStampToDate({ first, second, ambiguousOrder, hour, minute, sec, period }, now = new Date()) {
    let month, day;
    if (!ambiguousOrder) {
        day = first;
        month = second;
    } else if (first > 12 && second > 12) {
        return null; // no reading of this is a date
    } else if (first > 12) {
        day = first;
        month = second;
    } else if (second > 12) {
        month = first;
        day = second;
    } else if (isDayFirstLocale()) {
        day = first;
        month = second;
    } else {
        month = first;
        day = second;
    }

    let hours = hour;
    if (period === 'PM' && hours < 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    let dateObj = new Date(now.getFullYear(), month - 1, day, hours, minute, sec, 0);
    if (dateObj.getTime() - now.getTime() > FUTURE_SLACK_MS) {
        dateObj = new Date(now.getFullYear() - 1, month - 1, day, hours, minute, sec, 0);
    }
    return dateObj;
}

/**
 * Drop the resolved order so the next read re-detects it, or force one. Tests only.
 *
 * The order comes from the runtime locale, which a test cannot change, so a
 * test that needs the other order seeds it here rather than mocking `Intl`.
 *
 * @param {boolean} [dayFirst] - Force this order; omit to re-detect
 */
export function _resetDateFieldOrder(dayFirst) {
    dayFirstCache = dayFirst === undefined ? null : dayFirst;
}
