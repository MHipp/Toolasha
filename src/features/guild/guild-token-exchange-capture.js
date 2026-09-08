/**
 * Reading the guild token exchange off the Guild Shop dialog.
 *
 * The exchange rate a token buys credits at is per credit colour — a token buys
 * ten green credits and a sixtieth of a gold one — and no map in the client data
 * has been observed publishing it. `guild-token-value.js` probes for one and
 * prefers it whenever it answers; this module is what stands between that probe
 * and the `guildTokenCreditRate` setting, which is a guess with a number typed
 * into it.
 *
 * The dialog itself is unambiguous. Opening the Green Guild Credit exchange with
 * a Guild Token selected shows "1 → 10" and names both sides, which is the rate
 * stated by the game in the only place it states it. Reading it there costs one
 * callback on a modal that is already being watched.
 *
 * ## What is read
 *
 * Two strategies, tried in order, because the modal's markup has not been
 * verified field by field:
 *
 * - **the arrow**, `N → M` in the modal's own text, which is how the game writes
 *   an exchange everywhere else it writes one;
 * - **the tiles**, an item tile for each side carrying an `Item_count`.
 *
 * Whichever answers first wins, and the record says which so a wrong reading can
 * be recognised as one rather than argued with. Toolasha's own injected tables
 * write arrows too, so they are stripped before the text is read — otherwise the
 * script would read its own output back and call it game data.
 *
 * ## Why the ratio and not the counts
 *
 * The batches input scales both sides together, so a player who typed 7 into it
 * is looking at "7 → 70" and the rate is still ten. Only the ratio is kept as
 * the rate; the raw counts are kept beside it so the dump command can show what
 * was actually on screen.
 *
 * ## Persistence
 *
 * One record for the whole game rather than one per character: the Guild Shop
 * exchange is not a property of whoever opened it. It lives in `guildHistory`
 * beside the other guild-shaped things, is hydrated once into memory so the
 * valuation — which is synchronous, and called from tooltips — can read it
 * without awaiting anything, and is only written when a reading actually differs
 * from what is already known.
 */

import storage from '../../core/storage.js';
import { itemHridFromIcon } from '../../utils/item-icon.js';
import { parseGameNumber } from '../../utils/number-parser.js';

/** Object store the record lives in — shared with guild XP and trial history */
const STORE_NAME = 'guildHistory';

/** The one key the whole exchange table lives under */
export const CAPTURE_KEY = 'guildTokenExchange';

/** How an hrid spells a guild token */
const TOKEN_PATTERN = /guild_token/;

/** How an hrid spells a guild credit */
const CREDIT_PATTERN = /guild_credit/;

/** Arrows the game and this script both use to mean "becomes" */
const ARROW = /(\d[\d,]*)\s*(?:→|->|➔|=>)\s*(\d[\d,]*)/;

/** Nodes this script injected, which must not be read back as if the game wrote them */
const OWN_MARKUP = ['.mwi-guild-credit-value', '.mwi-exchange-advisor', '.mwi-shrine-planner', '.mwi-shrine-cost'];

/** A rate beyond this is a misread tile, not an exchange */
const MAX_PLAUSIBLE_RATE = 10_000;

/** creditItemHrid → captured reading. Read synchronously by the valuation. */
let captured = {};

/** Whether storage has been consulted yet this session */
let hydrated = false;

/**
 * Whether an hrid names a guild token.
 * @param {string} hrid - Item hrid
 * @returns {boolean} True for a guild token
 */
export function isTokenHrid(hrid) {
    return TOKEN_PATTERN.test(String(hrid || ''));
}

/**
 * Whether an hrid names a guild credit.
 * @param {string} hrid - Item hrid
 * @returns {boolean} True for a guild credit
 */
export function isCreditHrid(hrid) {
    return CREDIT_PATTERN.test(String(hrid || ''));
}

/**
 * A count as the game writes it — "1", "1,000", "10" — as a number.
 * @param {string} text - Displayed count
 * @returns {number} The number, or 0 when there is not one
 */
function parseCount(text) {
    const match = String(text ?? '')
        .trim()
        .match(/^[\d\s,.']+/);
    return match ? parseGameNumber(match[0], 0) : 0;
}

/**
 * The exchange the modal's own text states, if it states one.
 *
 * @param {Element} modalEl - The exchange modal
 * @returns {{tokens: number, credits: number}|null} Both sides, or null
 */
function readArrow(modalEl) {
    let text = '';
    try {
        const copy = modalEl.cloneNode(true);
        for (const selector of OWN_MARKUP) {
            copy.querySelectorAll?.(selector)?.forEach((el) => el.remove());
        }
        text = copy.textContent || '';
    } catch {
        text = modalEl.textContent || '';
    }

    const match = text.match(ARROW);
    if (!match) return null;

    return { tokens: parseCount(match[1]), credits: parseCount(match[2]) };
}

/**
 * Whether a tile shows the given item, judged by identity where possible.
 *
 * The icon's `<use>` sprite reference is locale independent, so when both an
 * hrid and a sprite are available the comparison is exact in any language. The
 * translated display name is only the fallback for markup with no sprite (or a
 * caller with no hrid) — where it still fails for non-English locales, as the
 * expected names come from `itemDetailMap` and are always English.
 *
 * @param {Element} tile - An item container
 * @param {string|null} itemHrid - The item's hrid, when the caller knows it
 * @param {string} itemName - The item's English display name
 * @returns {boolean} Whether the tile shows that item
 */
function tileShows(tile, itemHrid, itemName) {
    const spriteHrid = itemHridFromIcon(tile);
    if (spriteHrid && itemHrid) return spriteHrid === itemHrid;
    return tileName(tile) === itemName;
}

/**
 * The name an item tile shows, from whichever of the three ways the game labels
 * one is present.
 * @param {Element} tile - An item container
 * @returns {string} Item name, or ''
 */
function tileName(tile) {
    const svg = tile.querySelector?.('svg[aria-label]');
    const label = svg?.getAttribute?.('aria-label');
    if (label) return label.trim();

    const named = tile.querySelector?.('[class*="Item_name"]');
    return named?.textContent?.trim() || '';
}

/**
 * The count an item tile shows. A tile with no count is showing one of the item.
 * @param {Element} tile - An item container
 * @returns {number} Count
 */
function tileCount(tile) {
    const countEl = tile.querySelector?.('[class*="Item_count"]');
    if (!countEl) return 1;
    return parseCount(countEl.textContent) || 1;
}

/**
 * The exchange the modal's item tiles state, if they state one.
 *
 * @param {Element} modalEl - The exchange modal
 * @param {Object} sides - Both sides of the exchange, as the caller resolved them
 * @param {string} sides.creditName - The credit the modal is exchanging into
 * @param {string|null} [sides.creditItemHrid] - Its hrid
 * @param {string} sides.tokenName - What a guild token is called
 * @param {string|null} [sides.tokenHrid] - Its hrid
 * @returns {{tokens: number, credits: number}|null} Both sides, or null
 */
function readTiles(modalEl, { creditName, creditItemHrid, tokenName, tokenHrid }) {
    const tiles = Array.from(modalEl.querySelectorAll?.('[class*="Item_itemContainer"]') || []);
    if (tiles.length === 0) return null;

    let tokens = 0;
    let credits = 0;

    for (const tile of tiles) {
        if (!tokens && tileShows(tile, tokenHrid, tokenName)) tokens = tileCount(tile);
        else if (!credits && tileShows(tile, creditItemHrid, creditName)) credits = tileCount(tile);
    }

    if (!(tokens > 0) || !(credits > 0)) return null;
    return { tokens, credits };
}

/**
 * The token→credit exchange an open Guild Shop dialog is showing.
 *
 * Returns null for every dialog that is not one — an exchange of ordinary items
 * for credits, a dialog whose selected item is not a token, a reading whose two
 * halves do not make a plausible rate — because a wrong rate written down is
 * worse than no rate at all.
 *
 * @param {Element} modalEl - The exchange modal
 * @param {Object} context - What the caller already resolved
 * @param {string} context.creditItemHrid - The credit the modal exchanges into
 * @param {string} context.creditName - Its display name
 * @param {string} [context.selectedItemHrid] - The hrid of the item selected on the give side
 * @param {string} [context.selectedItemName] - Its display name (fallback when no hrid resolved)
 * @param {string} [context.tokenHrid] - The guild token's hrid
 * @param {string} [context.tokenName='Guild Token'] - What a token is called
 * @returns {{creditItemHrid: string, creditsPerToken: number, tokensPerExchange: number,
 *   creditsPerExchange: number, via: string}|null} The reading
 */
export function readTokenExchangeFromModal(modalEl, context = {}) {
    const {
        creditItemHrid,
        creditName,
        selectedItemHrid,
        selectedItemName,
        tokenHrid = null,
        tokenName = 'Guild Token',
    } = context;
    if (!modalEl || !isCreditHrid(creditItemHrid) || !creditName) return null;
    // Only the dialog that is actually offering the token exchange states its
    // rate; every other one is stating some item's rate. Judged by hrid when the
    // selection's icon resolved one (locale independent); by display name only
    // as the fallback for older markup.
    if (selectedItemHrid && tokenHrid) {
        if (selectedItemHrid !== tokenHrid) return null;
    } else if (selectedItemName && selectedItemName !== tokenName) {
        return null;
    }

    const arrow = readArrow(modalEl);
    const reading = arrow || readTiles(modalEl, { creditName, creditItemHrid, tokenName, tokenHrid });
    if (!reading) return null;

    const { tokens, credits } = reading;
    if (!(tokens > 0) || !(credits > 0)) return null;

    const creditsPerToken = credits / tokens;
    if (!Number.isFinite(creditsPerToken) || creditsPerToken > MAX_PLAUSIBLE_RATE) return null;

    return {
        creditItemHrid,
        creditsPerToken,
        tokensPerExchange: tokens,
        creditsPerExchange: credits,
        via: arrow ? 'arrow' : 'tiles',
    };
}

/**
 * Everything read off the Guild Shop so far, newest reading per credit type.
 * @returns {Array<Object>} Captured exchanges
 */
export function capturedTokenExchanges() {
    return Object.values(captured).map((entry) => ({ ...entry }));
}

/**
 * The captured exchange for one credit type.
 * @param {string} creditItemHrid - Credit hrid
 * @returns {Object|null} The reading, or null
 */
export function capturedTokenExchange(creditItemHrid) {
    const entry = captured[creditItemHrid];
    return entry ? { ...entry } : null;
}

/**
 * Read the stored table into memory, once.
 *
 * The valuation is synchronous and called from tooltips, so it cannot await
 * this; it is called at feature start-up instead, and until it resolves the
 * valuation simply falls through to the setting the way it did before.
 *
 * @returns {Promise<Object>} The table, keyed by credit hrid
 */
export async function hydrateCapturedTokenExchanges() {
    if (hydrated) return { ...captured };
    hydrated = true;

    try {
        const stored = await storage.get(CAPTURE_KEY, STORE_NAME, null);
        for (const [hrid, entry] of Object.entries(stored?.exchanges || {})) {
            if (!isCreditHrid(hrid) || !(Number(entry?.creditsPerToken) > 0)) continue;
            captured[hrid] = { ...entry, creditItemHrid: hrid };
        }
    } catch (error) {
        console.error('[GuildTokenExchange] Could not read the stored exchange:', error);
    }

    return { ...captured };
}

/**
 * Write a reading down, if it says anything the table does not already say.
 *
 * @param {Object|null} reading - From {@link readTokenExchangeFromModal}
 * @returns {Promise<boolean>} True when the table changed
 */
export async function rememberTokenExchange(reading) {
    if (!reading || !isCreditHrid(reading.creditItemHrid) || !(reading.creditsPerToken > 0)) return false;

    const existing = captured[reading.creditItemHrid];
    if (existing && existing.creditsPerToken === reading.creditsPerToken) return false;

    captured[reading.creditItemHrid] = { ...reading, capturedAt: Date.now() };

    try {
        await storage.set(CAPTURE_KEY, { exchanges: { ...captured }, updatedAt: Date.now() }, STORE_NAME);
    } catch (error) {
        console.error('[GuildTokenExchange] Could not store the exchange:', error);
    }

    return true;
}

/**
 * Read an open exchange dialog and remember what it said.
 * @param {Element} modalEl - The exchange modal
 * @param {Object} context - As {@link readTokenExchangeFromModal} takes it
 * @returns {Promise<Object|null>} What was read, or null
 */
export async function captureTokenExchangeFromModal(modalEl, context) {
    try {
        const reading = readTokenExchangeFromModal(modalEl, context);
        if (!reading) return null;
        await rememberTokenExchange(reading);
        return reading;
    } catch (error) {
        console.error('[GuildTokenExchange] Could not read the exchange dialog:', error);
        return null;
    }
}

/**
 * Forget everything, for tests.
 * @returns {void}
 */
export function _resetCapturedTokenExchanges() {
    captured = {};
    hydrated = false;
}
