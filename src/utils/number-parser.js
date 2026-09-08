/**
 * Number Parser Utility
 * Shared utilities for parsing numeric values from text, including item counts
 */

/**
 * Every whitespace character a locale might group digits with, including the
 * narrow and non-breaking spaces `Intl` emits for fr-FR and its neighbours. JS
 * `\s` already covers the whole Unicode space-separator category, so one the
 * DOM round-tripped as a different code point is still caught.
 */
const SPACING_SEPARATORS = /\s/g;

/** Resolved separators for one locale; re-resolved when the game's language changes. */
let separatorCache = null;

/**
 * The locale the game formats its numbers in, as `Intl` names it.
 * @returns {string} A locale `Intl` supports; en-US when the game's is unknown
 */
function gameNumberLocale() {
    let stored = null;
    try {
        stored = globalThis.localStorage?.getItem('i18nextLng')?.trim();
    } catch {
        // Site data blocked — en-US, same as a missing key
    }
    const candidate = (stored || 'en-US').replaceAll('_', '-');
    try {
        return Intl.NumberFormat.supportedLocalesOf([candidate])[0] ?? 'en-US';
    } catch {
        return 'en-US';
    }
}

/**
 * Parse item count from text
 * Handles various formats including:
 * - Plain numbers: "100", "1000"
 * - K/M suffixes: "1.5K", "2M"
 * - International formats with separators: "1,000", "1 000", "1.000"
 * - Mixed decimal formats: "1.234,56" (European) or "1,234.56" (US)
 * - Prefixed formats: "x5", "Amount: 1000", "Amount: 1 000"
 *
 * @param {string} text - Text containing a number
 * @param {number} defaultValue - Value to return if parsing fails (default: 1)
 * @returns {number} Parsed numeric value
 */
export function parseItemCount(text, defaultValue = 1) {
    if (!text) {
        return defaultValue;
    }

    // Convert to string and normalize
    text = String(text).toLowerCase().trim();

    // Extract number from common patterns like "x5", "Amount: 1000"
    const prefixMatch = text.match(/x([\d,\s.kmb]+)|amount:\s*([\d,\s.kmb]+)/i);
    if (prefixMatch) {
        text = prefixMatch[1] || prefixMatch[2];
    }

    // Determine whether periods and commas are thousands separators or decimal points.
    // Rules:
    // 1. If both exist: the one appearing first (or multiple times) is the thousands separator.
    //    e.g. "1.234,56" → period is thousands, comma is decimal → 1234.56
    //    e.g. "1,234.56" → comma is thousands, period is decimal → 1234.56
    // 2. If only commas exist and comma is followed by exactly 3 digits at end: thousands separator.
    //    e.g. "1,234" → 1234
    // 3. If only periods exist and period is followed by exactly 3 digits at end: thousands separator.
    //    e.g. "1.234" → 1234
    // 4. Otherwise treat as decimal separator.
    //    e.g. "1.5" → 1.5,  "1,5" → 1.5

    const hasPeriod = text.includes('.');
    const hasComma = text.includes(',');

    if (hasPeriod && hasComma) {
        // Both present — whichever comes last is the decimal separator
        const lastPeriod = text.lastIndexOf('.');
        const lastComma = text.lastIndexOf(',');
        if (lastPeriod > lastComma) {
            // Period is decimal: remove commas as thousands separators
            text = text.replace(/,/g, '');
        } else {
            // Comma is decimal: remove periods as thousands separators, replace comma with period
            text = text.replace(/\./g, '').replace(',', '.');
        }
    } else if (hasComma) {
        // Only commas: thousands separator if followed by exactly 3 digits at end, else decimal
        if (/,\d{3}$/.test(text)) {
            text = text.replace(/,/g, '');
        } else {
            text = text.replace(',', '.');
        }
    } else if (hasPeriod) {
        // Only periods: thousands separator if followed by exactly 3 digits at end, else decimal
        if (/\.\d{3}$/.test(text)) {
            text = text.replace(/\./g, '');
        }
        // else leave as-is (valid decimal like "1.5")
    }

    // Remove remaining whitespace separators
    text = text.replace(/\s/g, '');

    // Handle K/M/B/T suffixes (must end with the suffix letter). T support is
    // for the post-rework max listing price of 1T (was 100B).
    if (/\d[kmbt]$/.test(text)) {
        if (text.endsWith('k')) {
            return parseFloat(text) * 1000;
        } else if (text.endsWith('m')) {
            return parseFloat(text) * 1000000;
        } else if (text.endsWith('b')) {
            return parseFloat(text) * 1000000000;
        } else if (text.endsWith('t')) {
            return parseFloat(text) * 1000000000000;
        }
    }

    // Parse plain number
    const parsed = parseFloat(text);
    return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * The game's number separators, resolved once per locale.
 *
 * Not the browser's: the game formats its numbers by its own language setting,
 * which it keeps in the `i18nextLng` localStorage key, and that need not agree
 * with `navigator.language`. A player on a German browser with the game in
 * English reads "1,234"; one on an English browser with the game in German
 * reads "1.234". Reading the key is what makes the two cases separable.
 *
 * The detection — `Intl.NumberFormat(locale).formatToParts(1111.1)`, taking the
 * `group` and `decimal` parts — is adapted from MWITools (CC-BY-NC-SA-4.0);
 * see `third-party/mwitools/`.
 *
 * Falls back to en-US whenever the key is absent, unreadable (a browser with
 * site data blocked), or names a locale `Intl` does not support.
 *
 * @returns {{locale: string, group: string, decimal: string}} `group` is `''` for
 *   a locale that groups with nothing
 */
export function gameNumberSeparators() {
    const locale = gameNumberLocale();
    if (separatorCache && separatorCache.locale === locale) return separatorCache;
    let group = ',';
    let decimal = '.';
    try {
        const parts = new Intl.NumberFormat(locale).formatToParts(1111.1);
        group = parts.find((part) => part.type === 'group')?.value ?? '';
        decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
    } catch {
        // Keep the en-US defaults; a broken Intl is not worth a console line
        // on every number the plugin reads.
    }
    separatorCache = { locale, group, decimal };
    return separatorCache;
}

/**
 * Parse a number the game wrote for a human to read.
 *
 * Replaces the hardcoded `replace(/,/g, '')` that assumed en-US everywhere: in
 * a comma-decimal locale that strip reads "1,5" back as 15, and leaves the
 * period grouping of "1.234" to be parsed as 1.234. Grouping is dropped by the
 * locale's own group separator (plus any spacing character, since several
 * locales group with a narrow or non-breaking space that the DOM may round-trip
 * as a different code point), the locale's decimal separator becomes a period,
 * and everything else is discarded.
 *
 * Sign is preserved; suffixes like K/M/B are not handled here — callers that
 * need them capture the suffix themselves (see {@link parseItemCount} for the
 * heuristic parser used where the locale is genuinely unknown, such as text a
 * user typed).
 *
 * @param {string|number|null|undefined} text - Text containing one number
 * @param {number} [defaultValue=NaN] - Returned when there is no number in the text
 * @returns {number} The number, or `defaultValue`
 */
export function parseGameNumber(text, defaultValue = NaN) {
    if (typeof text === 'number') return Number.isFinite(text) ? text : defaultValue;
    if (text === null || text === undefined) return defaultValue;
    const { group, decimal } = gameNumberSeparators();
    let cleaned = String(text);
    if (group) cleaned = cleaned.split(group).join('');
    cleaned = cleaned.replace(SPACING_SEPARATORS, '');
    if (decimal !== '.') cleaned = cleaned.split(decimal).join('.');
    cleaned = cleaned.replace(/[^\d.+-]/g, '');
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

/** Drop the resolved separators. Tests only. */
export function _resetGameNumberSeparators() {
    separatorCache = null;
}
