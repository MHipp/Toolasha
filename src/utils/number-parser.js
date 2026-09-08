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

/**
 * Escape a single character for literal use inside a RegExp (character class
 * or not).
 * @param {string} char - One character
 * @returns {string} The character, escaped if it is a regex metacharacter
 */
function escapeRegExpChar(char) {
    return char.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** Regex fragments for the current locale, cached the same way {@link gameNumberSeparators} is. */
let patternCache = null;

/**
 * The game's group and decimal separators, as ready-to-embed regex fragments.
 *
 * This is the shared source of truth every capture regex in the codebase
 * should be built from, instead of hardcoding `,` as the grouping character
 * (which only matches an en-US-grouped number — in a period-grouping locale
 * such as de-DE or fr-FR, `[\d,]*` stops at the first group boundary, so
 * "1.234.567" captures as just "1", long before {@link parseGameNumber} ever
 * sees the rest).
 *
 * `group` is ready to sit inside a `[...]` character class: the locale's own
 * group character, escaped, or `\s` when the locale groups with any
 * whitespace variant — several locales (fr-FR among them) group with a narrow
 * or non-breaking space that the DOM may round-trip as a different code
 * point, the same reasoning {@link SPACING_SEPARATORS} exists for. Empty
 * string when the locale does not group at all. `decimal` is the locale's
 * decimal character, escaped, ready to use outside a character class.
 *
 * Re-resolved whenever the game's language changes, mirroring
 * {@link gameNumberSeparators}'s own cache: this is not frozen at module
 * load, so a pattern built from it stays correct across a mid-session
 * language switch, the same way {@link parseGameNumber} does.
 *
 * @returns {{group: string, decimal: string}} Regex-ready fragments
 */
export function gameNumberPattern() {
    const { locale, group, decimal } = gameNumberSeparators();
    if (patternCache && patternCache.locale === locale) return patternCache.fragments;
    const fragments = {
        group: !group ? '' : /\s/.test(group) ? '\\s' : escapeRegExpChar(group),
        decimal: escapeRegExpChar(decimal || '.'),
    };
    patternCache = { locale, fragments };
    return fragments;
}

/**
 * A digit run as the game draws it in the current locale, as a regex source
 * string ready for `new RegExp(...)`.
 *
 * Built fresh from {@link gameNumberPattern} on every call rather than
 * compiled once into a module-level constant — a capture regex that pins the
 * separators at import time freezes whatever locale happened to be active on
 * first load, which is wrong the moment the game's language changes and wrong
 * from the start for anyone whose game language isn't en-US.
 *
 * @param {Object} [options]
 * @param {boolean} [options.decimal=true] - Allow an optional decimal tail
 * @returns {string} A regex source fragment, e.g. `\d[\d,]*(?:\.\d+)?`
 */
export function gameDigitsSource({ decimal = true } = {}) {
    const { group, decimal: decimalChar } = gameNumberPattern();
    const base = `\\d[\\d${group}]*`;
    return decimal ? `${base}(?:${decimalChar}\\d+)?` : base;
}

/** Drop the resolved separators and any regex fragments built from them. Tests only. */
export function _resetGameNumberSeparators() {
    separatorCache = null;
    patternCache = null;
}
