/**
 * Welcome Back, valued
 *
 * The game's Welcome Back modal is a receipt with no total on it. It says how
 * long you were away, lists what you gained and what got eaten, and gives the
 * experience — every figure except the one anybody actually wants, which is
 * whether the night was worth it and how that compares with the last one.
 *
 * This adds one line to the bottom of that modal: what the gains are worth at
 * market, what the consumables cost, the net, and both rates per hour offline.
 * One line, because the modal is already dense and because a second panel to
 * open would defeat the point — the whole value of putting it here is that it is
 * in front of you at the one moment you are looking.
 *
 * Three things it deliberately does not do:
 *
 * It does not re-price at "what I would get if I sold this instant" versus "what
 * I would pay to replace it" on its own terms — it uses `selectPrice`, so the
 * pricing mode set in Settings governs this the same as everything else in the
 * script.
 *
 * It does not guess. An item with no market price contributes nothing to the
 * total and is counted instead, so the line can say "3 items unpriced" rather
 * than quietly under-reporting. If nothing at all could be priced, no line is
 * drawn: an enrichment that says "0" is worse than one that is absent.
 *
 * It does not depend on the modal's own class name any more than it has to. The
 * modal is found through `Modal_modalContent` — the class the draggable-modals
 * feature already relies on for every dialog in the game — and identified by the
 * offline-progress markers or its own heading. If the game renames its welcome
 * modal, this stops appearing; it does not start decorating the wrong dialog.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { coinFormatter, formatKMB } from '../../utils/formatters.js';
import { parseItemCount, gameDigitsSource } from '../../utils/number-parser.js';
import { selectPrice } from '../../utils/pricing-helper.js';

/** The mark this feature leaves, so a redraw does not stack a second line */
export const ROW_CLASS = 'toolasha-welcome-back-value';

/** Coins are their own price, and are never in the market data */
const COIN_HRID = '/items/coin';

/**
 * How the welcome modal announces itself.
 *
 * The class is checked before the text because a class survives translation and
 * a heading does not; the heading is the fallback for the day the CSS module is
 * renamed, which is the more likely of the two.
 */
const MODAL_MARKER = /WelcomeBack|OfflineProgress/i;
const MODAL_HEADING = /welcome back/i;

/** Section labels that mean the items under them left rather than arrived */
const SPENT_HEADING = /consumed|used|spent|eaten|drank/i;

/**
 * How long the player was away, from whatever the modal wrote.
 *
 * Two formats are handled because the game has used both and because a duration
 * is the denominator of every rate on the line — getting it wrong is worse than
 * not having it, so anything unrecognised returns null and the rates are simply
 * left off.
 *
 * @param {string} text - Text from the modal
 * @returns {number|null} Milliseconds offline, or null when nothing parsed
 */
export function parseOfflineDuration(text) {
    if (typeof text !== 'string') return null;

    // "12:34:56" or "34:56" — a clock, which is unambiguous and checked first
    const clock = text.match(/\b(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\b/);
    if (clock) {
        const [, a, b, c] = clock;
        const hours = c === undefined ? 0 : Number(a);
        const minutes = c === undefined ? Number(a) : Number(b);
        const seconds = c === undefined ? Number(b) : Number(c);
        const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
        return ms > 0 ? ms : null;
    }

    // "1d 2h 3m 4s", "2 hours 15 minutes", "45 min"
    const units = [
        [/(\d+(?:\.\d+)?)\s*(?:d\b|days?\b)/i, 24 * 60 * 60 * 1000],
        [/(\d+(?:\.\d+)?)\s*(?:h\b|hrs?\b|hours?\b)/i, 60 * 60 * 1000],
        [/(\d+(?:\.\d+)?)\s*(?:m\b|mins?\b|minutes?\b)/i, 60 * 1000],
        [/(\d+(?:\.\d+)?)\s*(?:s\b|secs?\b|seconds?\b)/i, 1000],
    ];

    let total = 0;
    for (const [pattern, scale] of units) {
        const match = text.match(pattern);
        if (match) total += Number(match[1]) * scale;
    }

    return total > 0 ? total : null;
}

/**
 * Total experience named anywhere in the modal.
 *
 * Summed rather than taken from one place: the modal lists experience per skill,
 * and an idle night is usually more than one skill.
 *
 * @param {string} text - Text from the modal
 * @returns {number} Experience, zero when none was found
 */
export function parseExperience(text) {
    if (typeof text !== 'string') return 0;

    let total = 0;
    // Grouped by the game's current locale rather than a hardcoded comma/period
    // union — a plain union already tolerates en-US/de-DE, but not a
    // space-grouping locale such as fr-FR. parseItemCount is still what parses
    // the match: it is the heuristic parser (see number-parser.js), used
    // deliberately here since the group/decimal roles still need disambiguating
    // per figure, not just captured.
    const pattern = new RegExp(`(${gameDigitsSource()}\\s*[KMB]?)\\s*(?:XP|EXP|experience)\\b`, 'gi');
    for (const match of text.matchAll(pattern)) {
        const value = parseItemCount(match[1], 0);
        if (Number.isFinite(value) && value > 0) total += value;
    }
    return total;
}

/**
 * Whether an item tile sits under a heading that means it was spent.
 * @param {HTMLElement} tile - An item container inside the modal
 * @param {HTMLElement} root - The modal, so the walk has somewhere to stop
 * @returns {boolean} True when the enclosing section is about consumption
 */
function inSpentSection(tile, root) {
    for (let node = tile; node && node !== root; node = node.parentElement) {
        const heading = node.previousElementSibling;
        if (heading && SPENT_HEADING.test(heading.textContent || '')) return true;
    }
    return false;
}

/**
 * Every item the modal shows, signed by whether it arrived or left.
 *
 * The sign is taken from the count text first — a leading minus is the game
 * saying so outright — and from the enclosing section heading only when the text
 * did not say. Both are needed: the game has shown consumption as a negative
 * number and as its own labelled block, and reading a consumed tea as a gain
 * would put the night's profit out by twice the tea.
 *
 * @param {HTMLElement} root - The modal
 * @returns {Array<{hrid: string, count: number}>} Items, gains positive
 */
export function readModalItems(root) {
    if (!root?.querySelectorAll) return [];

    const items = [];
    for (const tile of root.querySelectorAll('[class*="Item_itemContainer"]')) {
        const use = tile.querySelector('use');
        const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
        const id = href.split('#')[1];
        if (!id) continue;

        const countText = tile.querySelector('[class*="Item_count"]')?.textContent?.trim() || '';
        if (!countText) continue;

        const magnitude = Math.abs(parseItemCount(countText, 0));
        if (!Number.isFinite(magnitude) || magnitude === 0) continue;

        const negative = countText.startsWith('-') || inSpentSection(tile, root);
        items.push({ hrid: `/items/${id}`, count: negative ? -magnitude : magnitude });
    }
    return items;
}

/**
 * What the night came to.
 *
 * `priceOf` is injected rather than reached for, because the arithmetic is the
 * part worth testing and the market API is the part that needs a loaded game.
 *
 * @param {Object} input - What was read off the modal
 * @param {Array<{hrid: string, count: number}>} input.items - Items, gains positive
 * @param {number} input.experience - Total experience
 * @param {number|null} input.durationMs - Time offline, null when unknown
 * @param {Function} input.priceOf - `(hrid) => number|null`, coins per unit
 * @returns {{gained: number, spent: number, net: number, perHour: number|null,
 *   xpPerHour: number|null, experience: number, unpriced: number, priced: number}} Summary
 */
export function summarizeWelcomeBack({ items = [], experience = 0, durationMs = null, priceOf }) {
    let gained = 0;
    let spent = 0;
    let priced = 0;
    let unpriced = 0;

    for (const { hrid, count } of items) {
        const unit = hrid === COIN_HRID ? 1 : priceOf(hrid);
        if (!Number.isFinite(unit) || unit <= 0) {
            unpriced += 1;
            continue;
        }
        priced += 1;
        if (count >= 0) gained += unit * count;
        else spent += unit * -count;
    }

    const hours = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 3_600_000 : null;
    const net = gained - spent;

    return {
        gained,
        spent,
        net,
        experience,
        priced,
        unpriced,
        perHour: hours ? net / hours : null,
        xpPerHour: hours && experience > 0 ? experience / hours : null,
    };
}

/**
 * The one line, as text.
 * @param {Object} summary - From `summarizeWelcomeBack`
 * @returns {string} What the row says
 */
export function formatSummary(summary) {
    const parts = [`Net ${coinFormatter(summary.net)}`];

    if (summary.spent > 0) {
        parts.push(`${coinFormatter(summary.gained)} gained − ${coinFormatter(summary.spent)} used`);
    }
    if (summary.perHour !== null) parts.push(`${coinFormatter(summary.perHour)}/hr`);
    if (summary.xpPerHour !== null) parts.push(`${formatKMB(summary.xpPerHour, 1)} xp/hr`);
    if (summary.unpriced > 0) parts.push(`${summary.unpriced} unpriced`);

    return parts.join(' · ');
}

/**
 * Is this element the welcome modal?
 * @param {HTMLElement} el - Candidate
 * @returns {boolean} True when it is
 */
export function isWelcomeBackModal(el) {
    if (!el?.className && !el?.querySelector) return false;

    const own = typeof el.className === 'string' ? el.className : '';
    if (MODAL_MARKER.test(own)) return true;
    if (el.querySelector?.(`[class*="WelcomeBack"], [class*="OfflineProgress"]`)) return true;

    for (const heading of el.querySelectorAll?.('h1, h2, h3, [class*="title"], [class*="header"]') || []) {
        if (MODAL_HEADING.test(heading.textContent || '')) return true;
    }
    return false;
}

/**
 * The welcome modal this inserted node belongs to, if any.
 * @param {HTMLElement} node - A node the observer saw appear
 * @returns {HTMLElement|null} The modal content element, or null
 */
export function findWelcomeBackModal(node) {
    const content = node?.closest?.('[class*="Modal_modalContent"]') || node;
    if (!content?.querySelectorAll) return null;
    return isWelcomeBackModal(content) ? content : null;
}

/**
 * Price a single item at whatever the pricing mode says it is worth.
 * @param {string} hrid - Item hrid
 * @returns {number|null} Coins per unit, or null when unpriced
 */
function marketPriceOf(hrid) {
    const price = marketAPI.getPrice(hrid, 0);
    if (!price) return null;
    const value = selectPrice(price);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Build the row element.
 * @param {string} text - What it says
 * @returns {HTMLElement} The row
 */
function buildRow(text) {
    const row = document.createElement('div');
    row.className = ROW_CLASS;
    row.textContent = `Toolasha · ${text}`;
    row.title =
        'Gains and consumables valued at market, using the pricing mode from Settings. ' +
        'Items with no market price are excluded and counted instead.';
    Object.assign(row.style, {
        marginTop: '8px',
        padding: '6px 8px',
        borderTop: '1px solid rgba(255, 255, 255, 0.15)',
        fontSize: '13px',
        lineHeight: '1.35',
        color: '#ffd700',
        textAlign: 'center',
        whiteSpace: 'normal',
    });
    return row;
}

/**
 * Read the modal, value it, and put one line at the bottom of it.
 *
 * Every way of failing here ends in the modal being left exactly as the game
 * drew it. That is the whole contract: this is an addition to somebody else's
 * dialog, and an addition that can break the dialog is not worth having.
 *
 * @param {HTMLElement} modal - The welcome modal content element
 * @param {Function} [priceOf] - Price lookup, injectable for tests
 * @returns {HTMLElement|null} The row that was added, or null
 */
export function enrichModal(modal, priceOf = marketPriceOf) {
    try {
        if (!modal || modal.querySelector(`.${ROW_CLASS}`)) return null;

        const text = modal.textContent || '';
        const summary = summarizeWelcomeBack({
            items: readModalItems(modal),
            experience: parseExperience(text),
            durationMs: parseOfflineDuration(text),
            priceOf,
        });

        // Nothing could be priced, so there is no total — and a line reading
        // "Net 0" beside a night of loot is worse than no line
        if (summary.priced === 0) return null;

        const row = buildRow(formatSummary(summary));
        modal.appendChild(row);
        return row;
    } catch (error) {
        console.error('[WelcomeBackValue] Could not value the welcome modal:', error);
        return null;
    }
}

let unregister = null;

const welcomeBackValue = {
    initialize() {
        if (!config.getSetting('welcomeBackValue')) return;
        if (unregister) return;

        // Debounced: the modal's items arrive in a burst, and the row has to be
        // written after the last of them or it would price half a night
        unregister = domObserver.onClass(
            'WelcomeBackValue',
            ['Modal_modalContent', 'WelcomeBack', 'OfflineProgress'],
            (node) => {
                const modal = findWelcomeBackModal(node);
                if (modal) enrichModal(modal);
            },
            { debounce: true, debounceDelay: 150 }
        );
    },

    cleanup() {
        if (unregister) {
            unregister();
            unregister = null;
        }
        document.querySelectorAll(`.${ROW_CLASS}`).forEach((row) => row.remove());
    },
};

export default welcomeBackValue;
