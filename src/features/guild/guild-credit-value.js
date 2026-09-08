/**
 * Guild Credit Value Display
 *
 * Injects cost-efficiency tables into guild credit exchange modals and shrine
 * upgrade modals. Shows both sell-side (opportunity cost) and buy-side
 * (acquisition cost) columns. Pricing mode is taken from the user's profit
 * calculation settings.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { getItemPrice } from '../../utils/market-data.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import { itemHridFromIcon } from '../../utils/item-icon.js';
import webSocketHook from '../../core/websocket.js';
import {
    navigateToMarketplace,
    createMaterialTab,
    createClearAllTabsControl,
    removeMaterialTabs,
    removeShrineMarketTabs,
    navigateToMarketListingsTab,
    updateTabBadge,
    visibleTabsContainer,
} from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';
import { heldInInventory } from '../../utils/dungeon-key-forecast.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { walkForQuantity, walkForBudget } from '../../utils/order-book.js';
import { estimatedListingAge } from '../../utils/bundle-bridge.js';
import { renderTierBadge, TIER_BADGE_CLASS } from './guild-trial-tier-badge.js';
import { GUILD_BUILDING_MAX_LEVEL } from './guild-trials-store.js';
import { describeGuildTokenGold, explainGuildTokenValue } from './guild-token-value.js';
import {
    capturedTokenExchange,
    capturedTokenExchanges,
    captureTokenExchangeFromModal,
    hydrateCapturedTokenExchanges,
} from './guild-token-exchange-capture.js';

const CSS_CLASS = 'mwi-guild-credit-value';

/**
 * One side of an item's order book, from the listing tracker's persisted cache.
 *
 * Guild conversion items are not the item whose marketplace panel is open, so
 * the only depth available anywhere is what that cache kept from earlier
 * browsing (a week, top rows per side). Null means no book has been seen — not
 * that the book is empty.
 *
 * @param {string} itemHrid - Conversion item
 * @param {boolean} isSell - True for the asks, false for the bids
 * @returns {Array<{price: number, quantity: number}>|null} Listings, best first
 */
function cachedListings(itemHrid, isSell) {
    if (!itemHrid) return null;
    return estimatedListingAge()?.cachedBookSide?.(itemHrid, 0, isSell)?.listings || null;
}

/**
 * What selling a quantity would gross, against the book where one is known.
 *
 * A short book is answered with what it does cover rather than extrapolated:
 * the game sends twenty listings a side and says nothing about the rest, so the
 * units past the end have no price to quote. {@link describeBookShortfall}
 * turns that into the caveat the panel shows.
 *
 * @param {string} itemHrid - Item being sold
 * @param {number} quantity - Units on the table
 * @param {number} topBid - Best bid, the fallback when no book has been seen
 * @returns {{gold: number, filled: number, quantity: number, source: 'book'|'top'}} Gross proceeds
 */
function quoteSaleAgainstBook(itemHrid, quantity, topBid) {
    const bids = cachedListings(itemHrid, false);
    if (!bids) return { gold: quantity * topBid, filled: quantity, quantity, source: 'top' };

    const { filled, gold } = walkForQuantity(bids, quantity);
    return { gold, filled, quantity, source: 'book' };
}

/**
 * How many units a budget buys, against the book where one is known.
 *
 * `units` is null when no book has been seen, which is the caller's signal to
 * fall back to dividing by the top ask.
 *
 * @param {string} itemHrid - Item being bought
 * @param {number} budget - Gold available
 * @param {number} topAsk - Best ask, used only to decide the fallback is viable
 * @returns {{units: number|null, exhausted: boolean, source: 'book'|'top'}} Units affordable
 */
function quotePurchaseAgainstBook(itemHrid, budget, topAsk) {
    const asks = cachedListings(itemHrid, true);
    if (!asks || !(topAsk > 0)) return { units: null, exhausted: false, source: 'top' };

    const { units, exhausted } = walkForBudget(asks, budget);
    return { units, exhausted, source: 'book' };
}

/**
 * Why the sell → rebuy comparison is a bound rather than a quote, if it is.
 *
 * @param {{filled: number, quantity: number, source: string}} sale - From {@link quoteSaleAgainstBook}
 * @param {{exhausted: boolean, source: string}} purchase - From {@link quotePurchaseAgainstBook}
 * @param {{name: string}} selectedRow - The row being sold
 * @param {{name: string}} bestRow - The row being bought
 * @param {number} quantity - Units on the table
 * @returns {string|null} A sentence for the panel, or null when both legs are covered
 */
function describeBookShortfall(sale, purchase, selectedRow, bestRow, quantity) {
    if (sale.source === 'book' && sale.filled < quantity) {
        return (
            `The visible book bids for only ${formatWithSeparator(Math.floor(sale.filled))} of ` +
            `${formatWithSeparator(quantity)} ${selectedRow.name} — the proceeds above are for those alone.`
        );
    }
    if (purchase.source === 'book' && purchase.exhausted) {
        return `The visible asks for ${bestRow.name} run out before the proceeds do — the rebuy count is a floor.`;
    }
    return null;
}

/**
 * The shrine planner's saved state, per character.
 *
 * A curated record, not a plain one: the targets are a list the user edits, and
 * a target they cleared must not come back from storage on the next save.
 * Scoped (the default) because a plan for which shrine levels to chase is one
 * character's business — the guild-shared trial plan is the unscoped case.
 *
 * Shape: `{ targets: { [buffHrid]: number }, collapsed: boolean,
 * suggestionsCollapsed: boolean, spendMode: 'auto'|'tokens'|'gold',
 * tokenCredits: { [creditHrid]: true } }`.
 * Stored key: `guildShrinePlan_<characterId>` in the `settings` store.
 *
 * `empty()` is a bare `{}` rather than the shape with its defaults filled in:
 * the pre-load merge is a shallow one with memory winning per key, so an
 * `empty()` carrying `targets: {}` would shadow the stored targets on the first
 * load and hand back an empty plan. Defaults are applied where the plan is
 * read instead ({@link planState}).
 */
const SHRINE_PLAN_KEY = 'guildShrinePlan';
const shrinePlanRecord = createCuratedRecord({
    base: SHRINE_PLAN_KEY,
    empty: () => ({}),
    merge: mergeMaps(),
    label: 'GuildShrinePlanner',
});

// A character switch re-initializes this feature (see feature-registry.js's
// character_switching / character_switched handlers) without a page reload,
// but the record is a module-level singleton: nothing else clears its
// in-memory copy between characters. Left alone, the next `load()` — a
// curated-record merge until the first readable load completes — would fold
// the departing character's still-resident targets, spend mode and fold
// state OVER the arriving character's own stored plan (memory wins per key),
// the same class of leak `loot-log-history.js` guards against for its own
// record. `reset()` is exactly what a character switch calls for — see its
// docstring in persisted-record.js.
//
// The pending edit is flushed *first*, and this is why the listener is async.
// This module's listener is registered at import time, which is before
// entrypoint.js installs feature-registry's — so on a switch it runs first,
// and a bare `reset()` here emptied the record before the registry's teardown
// could reach `cleanup()`'s "a plan edited in the last few hundred
// milliseconds is written now rather than dropped with the timer". Nothing was
// corrupted (an empty memory merges to whatever is stored, and `reset()`'s
// generation bump stands the save down rather than letting it write under the
// wrong key) — the edit was simply lost. Flushing here, before the reset,
// keeps that promise; `character_switching` is awaited by data-manager and
// fires before `currentCharacterId` moves, so the write lands under the
// departing character's key.
dataManager.on('character_switching', async () => {
    await guildCreditValue.flushPendingPlanSave();
    shrinePlanRecord.reset();
});

/**
 * The saved plan with its shape guaranteed — `targets` always an object.
 * @returns {{targets: Object<string, number>, collapsed: boolean}} The live record
 */
function planState() {
    const plan = shrinePlanRecord.get();
    if (!plan.targets || typeof plan.targets !== 'object') plan.targets = {};
    return plan;
}

/**
 * The three ways the planner may be told to settle a credit shortfall.
 *
 * `auto` is the recommendation — cheapest path per colour
 * ({@link chooseCreditPath}). The other two are the player overriding it: one
 * pocket for everything, because "spend tokens" and "spend gold" are real
 * positions to take (a token hoard with nothing else to buy, a gold pile and no
 * patience) that a per-colour cost comparison cannot know about.
 */
export const SPEND_MODES = ['auto', 'tokens', 'gold'];

/** What each mode is called on its button */
const SPEND_MODE_LABELS = { auto: 'Auto', tokens: 'Tokens', gold: 'Gold' };

/**
 * The saved spend mode, normalised.
 *
 * A plan written before this option existed carries no `spendMode` at all, and
 * `auto` — the only behaviour it could have been saved under — is what it means.
 * Read rather than defaulted into the record, so a plan is not rewritten with a
 * key the player never chose.
 *
 * @returns {string} One of {@link SPEND_MODES}
 */
function spendMode() {
    const mode = planState().spendMode;
    return SPEND_MODES.includes(mode) ? mode : 'auto';
}

/**
 * The credit colours the player has marked "cover with tokens", as a Set.
 *
 * A per-colour override over the spend mode, not a fourth mode: the player
 * knows they will exchange tokens for a colour — a hoard earmarked for it, or
 * simply a decision already made — and every one of that colour's credits is
 * then an exchange to make rather than materials to shop for, whatever the
 * per-colour price comparison says. Only an explicit `true` counts, so a
 * record touched by an older write (or a merge) cannot cover a colour the
 * player never ticked.
 *
 * @param {Object|null} plan - The live plan record, from {@link planState}
 * @returns {Set<string>} Credit hrids covered with tokens
 */
export function tokenCoveredCredits(plan) {
    const covered = plan?.tokenCredits;
    if (!covered || typeof covered !== 'object') return new Set();
    return new Set(Object.keys(covered).filter((creditHrid) => covered[creditHrid] === true));
}

/**
 * Split a bill of owed credits by the path each colour is settled down.
 *
 * The token side is what the guild shop exchanges for; the market side is what
 * the shopping list and the conversion steps are drawn from. A colour with no
 * usable path at all lands on the market side — the same rule as
 * {@link planNextBuys}: the shopping list skips what nothing converts into,
 * which is the same silence it gave before, and the token side must not claim
 * an exchange it cannot price.
 *
 * @param {Object<string, number>} owedCredits - creditHrid → credits still owed
 * @param {Function} pathFor - creditHrid → decision from {@link chooseCreditPath}
 * @returns {{marketOwed: Object<string, number>, tokenOwed: Object<string, number>}} The two bills
 */
export function splitOwedCredits(owedCredits, pathFor = () => ({ path: 'tokens' })) {
    const marketOwed = {};
    const tokenOwed = {};
    for (const [itemHrid, owed] of Object.entries(owedCredits || {})) {
        if ((pathFor(itemHrid) || {}).path === 'tokens') tokenOwed[itemHrid] = owed;
        else marketOwed[itemHrid] = owed;
    }
    return { marketOwed, tokenOwed };
}

/**
 * What one token spent on a colour saves against buying its materials.
 *
 * A token buys `1 / tokensPerCredit` credits of the colour, and the alternative
 * to having them is paying `marketGold` per credit for the conversion materials,
 * so the gold a token displaces here is the one divided by the other. The token's
 * own worth (`tokenGold`) is deliberately not subtracted: it is the same number
 * for every colour — the best gold-per-token across all of them — so subtracting
 * it cannot reorder the list, and leaving it out keeps the figure something the
 * row can state plainly ("1 tok here saves X gold") rather than a margin over an
 * average the player never sees.
 *
 * @param {Object|null} decision - From {@link chooseCreditPath}/{@link applySpendMode}
 * @returns {number|null} Gold saved per token, or null when the colour is unpriceable
 */
export function goldSavedPerToken(decision) {
    const perCredit = Number(decision?.tokensPerCredit);
    const market = Number(decision?.marketGold);
    if (!(perCredit > 0) || !(market > 0)) return null;
    return market / perCredit;
}

/** How close two gold-per-token figures have to be to share the crown */
const TOKEN_VALUE_TIE_TOLERANCE = 1e-9;

/**
 * Rank the colours by how well a token is spent on each.
 *
 * The question the per-colour token toggles raise and never answered: tokens are
 * finite, every colour will take them, and the exchange rates are asymmetric
 * enough that the same token buys ten blue credits or a sixtieth of a gold one.
 * Ranking by {@link goldSavedPerToken} answers it in the only currency both sides
 * share.
 *
 * A colour whose materials have no market price is not ranked last — it is not
 * ranked at all (`unpriced`), because "no price seen" is not "worth nothing" and
 * guessing one would be the same invention the rest of this file refuses.
 *
 * @param {Array<string>} creditHrids - The colours to rank
 * @param {Function} decisionFor - creditHrid → decision from {@link chooseCreditPath}
 * @returns {Array<{itemHrid: string, goldPerToken: number|null, unpriced: boolean, best: boolean}>}
 *   Best first, unpriced colours last
 */
export function rankTokenCoverValue(creditHrids, decisionFor = () => null) {
    const rows = (Array.isArray(creditHrids) ? creditHrids : []).map((itemHrid) => {
        const value = goldSavedPerToken(decisionFor(itemHrid));
        return { itemHrid, goldPerToken: value, unpriced: value === null, best: false };
    });
    rows.sort((a, b) => {
        if (a.unpriced !== b.unpriced) return a.unpriced ? 1 : -1;
        if (!a.unpriced && a.goldPerToken !== b.goldPerToken) return b.goldPerToken - a.goldPerToken;
        return a.itemHrid.localeCompare(b.itemHrid);
    });
    const top = rows.find((row) => !row.unpriced)?.goldPerToken;
    if (top > 0)
        for (const row of rows)
            if (!row.unpriced && row.goldPerToken >= top * (1 - TOKEN_VALUE_TIE_TOLERANCE)) row.best = true;
    return rows;
}

/** How long the target inputs sit still before the plan is written */
const PLAN_SAVE_DEBOUNCE_MS = 400;
/**
 * How long the shrine block waits for the modal to settle before recomputing.
 * An upgrade lands as a burst — the game rewrites the requirement rows and the
 * deduction arrives as its own `items_updated` — and the block is a full
 * re-render, so the two are coalesced the way the advisor's redraw is.
 */
const SHRINE_RERENDER_DEBOUNCE_MS = 50;

/**
 * Walk a token-cost-ascending list of single-level buys, taking each one the
 * remaining balance still covers.
 *
 * Deliberately single-level-ahead: buying a level changes what that buff's
 * *next* level costs, so this is an "if you spent everything right now" figure
 * and not a claim about an optimal spend.
 *
 * @param {Array<{tokenCost: number}>} options - Sorted by `tokenCost` ascending
 * @param {number} balance - Guild tokens held
 * @returns {{count: number, spent: number}} How many are covered and what they cost
 */
export function greedyAffordable(options, balance) {
    let spent = 0;
    let count = 0;
    for (const option of Array.isArray(options) ? options : []) {
        const cost = Number(option?.tokenCost) || 0;
        // Ascending order means the first miss is the last: nothing further down
        // the list is cheaper than the one that just failed to fit.
        if (spent + cost > balance) break;
        spent += cost;
        count += 1;
    }
    return { count, spent };
}

/**
 * A credit's name with the word "Credit" taken off, for a dense list that is
 * entirely about guild credits.
 *
 * "12,000 Blue Guild Credit, 1,200 Purple Guild Credit" is four fifths the same
 * two words repeated, and it was that repetition — not the numbers — that pushed
 * the suggestion rows past the modal's right edge. The full name still travels
 * with every shortened one, in a `title`.
 *
 * @param {string} name - The credit's display name
 * @returns {string} The distinguishing part of it, or the whole name when
 *   shortening would leave nothing
 */
export function shortCreditName(name) {
    const full = String(name || '').trim();
    const short = full
        .replace(/\s*guild\s+credits?$/i, '')
        .replace(/\s*credits?$/i, '')
        .trim();
    return short || full;
}

/**
 * The Guild Shop's token→credit exchange, as the game states it.
 *
 * Eight colours, four rates, confirmed against the in-game exchange dialog — the
 * gold credit's is the one it is hardest to believe and easiest to check: the
 * modal says 60 tokens → 1. Keyed by the colour word rather than the whole hrid
 * so the table survives an hrid being spelled differently, and so a colour the
 * game adds later falls through to {@link NO_RATE_NOTE} instead of quietly
 * inheriting a neighbour's rate.
 *
 * These are constants, not readings, and they are exact: nothing derived from
 * one carries the `≈` a captured reading does. A capture still beats them —
 * see {@link tokenRateFor} — because the game can rebalance and an observation
 * of today's shop is worth more than yesterday's constant.
 */
export const DEFAULT_TOKEN_RATES = {
    green: { tokensPerExchange: 1, creditsPerExchange: 10 },
    brown: { tokensPerExchange: 1, creditsPerExchange: 10 },
    white: { tokensPerExchange: 1, creditsPerExchange: 10 },
    blue: { tokensPerExchange: 1, creditsPerExchange: 10 },
    purple: { tokensPerExchange: 1, creditsPerExchange: 1 },
    red: { tokensPerExchange: 1, creditsPerExchange: 1 },
    silver: { tokensPerExchange: 10, creditsPerExchange: 1 },
    gold: { tokensPerExchange: 60, creditsPerExchange: 1 },
};

/**
 * How close the two paths may be and still count as level.
 *
 * `0.1 × 1500` is `150.00000000000003`, and the colour a token is worth the most
 * on prices out at exactly that against its own market cost — so without a
 * tolerance the recommendation would turn on the last bit of a double.
 */
const PATH_TIE_TOLERANCE = 1e-9;

/** The colour word in a credit hrid — `/items/gold_guild_credit` → `gold` */
const CREDIT_COLOUR = /(?:^|[/_])([a-z]+)_guild_credit(?:$|[/_])/;

/**
 * The standard exchange for one credit colour, from {@link DEFAULT_TOKEN_RATES}.
 *
 * Shaped exactly like a captured reading so the rest of this file cannot tell
 * the two apart except by `source`, which is the one thing the captions care
 * about.
 *
 * @param {string} creditItemHrid - Credit hrid
 * @returns {Object|null} The rate, or null for an hrid no colour in the table names
 */
export function defaultTokenRate(creditItemHrid) {
    const colour = CREDIT_COLOUR.exec(String(creditItemHrid || '').toLowerCase())?.[1];
    const rate = colour ? DEFAULT_TOKEN_RATES[colour] : null;
    if (!rate) return null;
    return {
        creditItemHrid,
        creditsPerToken: rate.creditsPerExchange / rate.tokensPerExchange,
        tokensPerExchange: rate.tokensPerExchange,
        creditsPerExchange: rate.creditsPerExchange,
        via: 'default',
        source: 'default',
    };
}

/**
 * The Guild Shop's token→credit rate for one colour: what was seen, else what is
 * standard.
 *
 * Precedence is observation over constant. A capture is a reading of the shop as
 * it is now; the table is a reading of the shop as it was when the rates were
 * written down, and the game can rebalance. Everything below the capture is
 * still answered, which is why the "rate not seen yet" annotation now only
 * belongs to a colour the table does not name either.
 *
 * @param {string} creditHrid - Credit hrid
 * @returns {Object|null} The rate, tagged with its `source`, or null
 */
export function tokenRateFor(creditHrid) {
    try {
        const seen = capturedTokenExchange(creditHrid);
        if (seen && Number(seen.creditsPerToken) > 0) return { ...seen, source: 'captured' };
    } catch {
        // A capture module that cannot answer is not a reason to lose the default
    }
    return defaultTokenRate(creditHrid);
}

/**
 * Every token→credit exchange this script believes in, captures first.
 *
 * The list the gold-per-token bridge is maximised over. One entry per colour:
 * a captured reading shadows the standard rate for its own colour and nothing
 * else, so the defaults fill every gap the shop has not been opened for.
 *
 * @param {Object} [itemDetailMap] - The game's items, for the credit hrids to default
 * @returns {Array<Object>} Exchanges, in the shape `guild-token-value.js` reads
 */
export function mergedTokenExchanges(itemDetailMap = {}) {
    const exchanges = [];
    const seen = new Set();

    let captures = [];
    try {
        captures = capturedTokenExchanges() || [];
    } catch {
        captures = [];
    }
    for (const entry of captures) {
        if (!entry?.creditItemHrid || !(Number(entry.creditsPerToken) > 0)) continue;
        exchanges.push({ ...entry, source: 'captured' });
        seen.add(entry.creditItemHrid);
    }

    for (const hrid of Object.keys(itemDetailMap || {})) {
        if (!hrid.includes('guild_credit') || seen.has(hrid)) continue;
        const rate = defaultTokenRate(hrid);
        if (rate) exchanges.push(rate);
    }

    return exchanges;
}

/**
 * What a token is worth in gold, so a token cost and a gold cost can be compared.
 *
 * Not computed here: `guild-token-value.js` already answers exactly this
 * question — the best gold-per-token across colours, `credits per token × that
 * colour's cheapest gold-per-credit`, maximised — and answering it twice is how
 * two parts of one modal end up disagreeing. All this adds is the exchange list
 * to maximise over, which is this file's merged captures-over-defaults table
 * rather than the capture module's captures alone.
 *
 * The pricing side is `ask` to match everything else the planner buys with: the
 * alternative to spending a token is buying the materials at their ask price, so
 * the token has to be valued against the same side of the book.
 *
 * @param {Object} itemDetailMap - The game's items
 * @param {string} [pricingMode='ask'] - Pricing side for the credit half
 * @returns {number|null} Gold per token, or null when nothing is priceable
 */
export function goldPerTokenFor(itemDetailMap, pricingMode = 'ask') {
    try {
        const valuation = explainGuildTokenValue(pricingMode, {
            capturedExchanges: mergedTokenExchanges(itemDetailMap),
        });
        return Number(valuation?.gold) > 0 ? valuation.gold : null;
    } catch {
        return null;
    }
}

/**
 * Tokens per single credit at a rate, un-rounded.
 *
 * The marginal cost, which is the figure a comparison wants —
 * {@link tokensForCredits} rounds up to whole exchanges, and rounding a single
 * blue credit up to a whole token would price it at ten times what the next one
 * costs.
 *
 * @param {Object|null} rate - A rate, captured or standard
 * @returns {number|null} Tokens per credit, or null without a usable rate
 */
export function tokensPerCredit(rate) {
    const tokens = Number(rate?.tokensPerExchange);
    const credits = Number(rate?.creditsPerExchange);
    if (tokens > 0 && credits > 0) return tokens / credits;
    const perToken = Number(rate?.creditsPerToken);
    return perToken > 0 ? 1 / perToken : null;
}

/**
 * The cheaper of the two ways to get one credit of a colour.
 *
 * The rates make token costs wildly asymmetric — a blue credit is a tenth of a
 * token and a gold one is sixty — so a flat "convert tokens" assumption is a
 * recommendation to burn sixty tokens on something the market sells for less
 * than one is worth. Both paths are priced in gold: the token path through the
 * token's own opportunity cost, the market path through the cheapest conversion
 * into that colour.
 *
 * Ties go to the token, and a tie is not a rare case: the token is valued at its
 * *best* use, so the colour that best use names prices out exactly level with
 * its own market cost. Sending that colour through the shop and every other one
 * to the market is the whole recommendation in one sentence — spend tokens where
 * they buy the most, buy the rest with gold — and it falls out of the comparison
 * rather than being asserted over it. Breaking the tie the other way would send
 * every colour to the market and leave the tokens with nothing to do; a token
 * cannot be sold, so at equal value the one already held beats gold that has to
 * be found. The tolerance is there because the tie is a floating-point one.
 *
 * @param {Object} [options]
 * @param {Object|null} [options.rate] - The colour's token→credit rate
 * @param {number|null} [options.marketGoldPerCredit] - Cheapest gold per credit on the market
 * @param {number|null} [options.goldPerToken] - What a token is worth, from {@link goldPerTokenFor}
 * @returns {{path: string, tokensPerCredit: number|null, tokenGold: number|null,
 *   marketGold: number|null}} `path` is `'tokens'`, `'market'` or `'unknown'`
 */
export function chooseCreditPath({ rate = null, marketGoldPerCredit = null, goldPerToken = null } = {}) {
    const perCredit = tokensPerCredit(rate);
    const market = Number(marketGoldPerCredit) > 0 ? Number(marketGoldPerCredit) : null;
    const perToken = Number(goldPerToken) > 0 ? Number(goldPerToken) : null;

    // No rate: the market is the only path there is, and when it has no price
    // either there is nothing to recommend and the row says so
    if (!(perCredit > 0))
        return {
            path: market === null ? 'unknown' : 'market',
            tokensPerCredit: null,
            tokenGold: null,
            marketGold: market,
        };

    // No price for this colour's conversions, or no token valuation to compare
    // against: fall back to the token path rather than invent a gold figure
    if (market === null || perToken === null)
        return {
            path: 'tokens',
            tokensPerCredit: perCredit,
            tokenGold: perToken === null ? null : perCredit * perToken,
            marketGold: market,
        };

    const tokenGold = perCredit * perToken;
    return {
        path: tokenGold <= market * (1 + PATH_TIE_TOLERANCE) ? 'tokens' : 'market',
        tokensPerCredit: perCredit,
        tokenGold,
        marketGold: market,
    };
}

/**
 * How much dearer the forced path has to be before the row says so.
 *
 * A percent, not {@link PATH_TIE_TOLERANCE}'s float epsilon: the disclosure is
 * about a decision the player would want to reconsider, and a rounding-error
 * difference is not one. It is deliberately low all the same — the point is that
 * an overpay is never silent, not that only large ones are mentioned.
 */
const OVERPAY_TOLERANCE = 0.01;

/**
 * The recommendation, bent to the mode the player picked.
 *
 * `auto` hands the decision straight back. The forced modes take the path they
 * are named after *when that path exists for the colour*, and fall back to the
 * other one when it does not — never to nothing. A colour with no token rate
 * (the ninth colour nobody has opened the exchange for) cannot be converted no
 * matter how firmly Tokens is selected, and a colour nothing on the market
 * converts into at a known price cannot be bought; dropping either from the plan
 * would make an unaffordable buy look affordable, which is the one thing this
 * section must never do. The fallback is recorded rather than hidden
 * (`fallback`), and so is the fact that the mode overrode the cheaper path
 * (`forced`, with `autoPath` naming what the recommendation would have done) —
 * both are said out loud in the row's tooltip.
 *
 * @param {Object} decision - From {@link chooseCreditPath}
 * @param {string} [mode='auto'] - One of {@link SPEND_MODES}
 * @returns {{path: string, tokensPerCredit: number|null, tokenGold: number|null,
 *   marketGold: number|null, mode: string, autoPath: string, forced: boolean,
 *   fallback: boolean}} The decision the whole section is then drawn from
 */
export function applySpendMode(decision, mode = 'auto') {
    const base = decision || { path: 'unknown', tokensPerCredit: null, tokenGold: null, marketGold: null };
    const autoPath = base.path;
    if (mode !== 'tokens' && mode !== 'gold')
        return { ...base, mode: 'auto', autoPath, forced: false, fallback: false };

    // What each path needs to be usable at all: a rate to exchange at, and a
    // priced conversion to shop for. The same two tests `buyTokenCost` makes.
    const canTokens = Number(base.tokensPerCredit) > 0;
    const canMarket = Number(base.marketGold) > 0;
    const wanted = mode === 'tokens' ? 'tokens' : 'market';
    const wantedUsable = wanted === 'tokens' ? canTokens : canMarket;
    const otherUsable = wanted === 'tokens' ? canMarket : canTokens;
    const other = wanted === 'tokens' ? 'market' : 'tokens';

    const path = wantedUsable ? wanted : otherUsable ? other : 'unknown';
    return { ...base, path, mode, autoPath, forced: path !== autoPath, fallback: !wantedUsable };
}

/**
 * The guild tokens it takes to buy a number of credits at a known rate.
 *
 * The guild shop trades in whole exchanges — "1 → 10" is one token for ten green
 * credits, and there is no way to hand over a third of a token — so a part-filled
 * exchange costs a whole one. When the reading kept both sides
 * (`tokensPerExchange`/`creditsPerExchange`) that granularity is honoured
 * exactly; a reading that only carries a ratio is rounded up to whole tokens,
 * which is the same rule at a batch size of one.
 *
 * @param {number} credits - Credits wanted
 * @param {Object|null} rate - A captured exchange, or null when none was ever read
 * @returns {number|null} Tokens needed, or null when no rate is known
 */
export function tokensForCredits(credits, rate) {
    const wanted = Number(credits) || 0;
    if (wanted <= 0) return 0;
    if (!rate) return null;

    const perExchange = Number(rate.creditsPerExchange);
    const tokensPer = Number(rate.tokensPerExchange);
    if (perExchange > 0 && tokensPer > 0) return Math.ceil(wanted / perExchange) * tokensPer;

    const perToken = Number(rate.creditsPerToken);
    if (perToken > 0) return Math.ceil(wanted / perToken);
    return null;
}

/**
 * The credits a token budget actually buys, in whole exchanges.
 *
 * The inverse of {@link tokensForCredits} and rounded the opposite way for the
 * same reason: the counter does not make change, so a budget that covers three
 * and a half exchanges buys three.
 *
 * @param {number} tokens - Tokens available to spend
 * @param {Object|null} rate - The colour's token→credit rate
 * @returns {number} Credits obtainable, 0 when the budget or the rate buys nothing
 */
export function creditsForTokens(tokens, rate) {
    const budget = Number(tokens) || 0;
    if (budget <= 0 || !rate) return 0;

    const perExchange = Number(rate.creditsPerExchange);
    const tokensPer = Number(rate.tokensPerExchange);
    if (perExchange > 0 && tokensPer > 0) return Math.floor(budget / tokensPer) * perExchange;

    const perToken = Number(rate.creditsPerToken);
    return perToken > 0 ? Math.floor(budget * perToken) : 0;
}

/**
 * Hold the token half of a plan to the tokens the player actually has spare.
 *
 * The token bill and the plan's own `guildTokenCost` come out of one pocket, and
 * nothing was making them share it: the still-needed box would net the level
 * costs against the balance, then recommend conversions worth multiples of that
 * same balance on top — a plan unaffordable in tokens before the first exchange.
 * The budget is therefore what is left *after* the levels take their cut, which
 * is the `spare` the row notes were already measured against.
 *
 * A colour the recommendation chose (`auto`) is advice, and advice that cannot be
 * taken is worse than none: it is capped to whole exchanges the budget covers and
 * the remainder goes back to the market side, where the shopping list can price
 * it. A colour the *player* chose — a ticked cover, or Tokens mode — is not
 * advice and is not overruled: it keeps its whole exchange, takes the budget
 * first, and is flagged so the step can say how far past the spare it reaches.
 *
 * @param {Object<string, number>} tokenOwed - creditHrid → credits owed on the token path
 * @param {number} budget - Tokens spare after the plan's own token cost
 * @param {Object} [options]
 * @param {Function} [options.rateFor] - creditHrid → token→credit rate
 * @param {Function} [options.decisionFor] - creditHrid → decision, for the ordering and `mode`
 * @returns {{tokenOwed: Object<string, number>, marketOwed: Object<string, number>,
 *   capped: Object<string, {chosen: boolean, tokens: number, credits: number, remainder: number,
 *   over: number}>}} The two bills and what had to be cut back
 */
export function capTokenPlanToBudget(tokenOwed, budget, { rateFor = tokenRateFor, decisionFor = () => null } = {}) {
    const keptTokenOwed = {};
    const marketOwed = {};
    const capped = {};
    let left = Math.max(0, Number(budget) || 0);

    const chosenHere = (hrid) => (decisionFor(hrid) || {}).mode === 'tokens';
    // Chosen colours first — they are not competing for the budget, they are
    // claiming it — then best value per token, then the hrid so the order is
    // stable when two colours are worth the same
    const entries = Object.entries(tokenOwed || {}).filter(([, owed]) => Number(owed) > 0);
    entries.sort(([aHrid], [bHrid]) => {
        if (chosenHere(aHrid) !== chosenHere(bHrid)) return chosenHere(aHrid) ? -1 : 1;
        const a = goldSavedPerToken(decisionFor(aHrid));
        const b = goldSavedPerToken(decisionFor(bHrid));
        if (a !== b) return (b === null ? -Infinity : b) - (a === null ? -Infinity : a);
        return aHrid.localeCompare(bHrid);
    });

    for (const [itemHrid, owed] of entries) {
        const rate = rateFor(itemHrid);
        const tokens = tokensForCredits(owed, rate);
        // No rate to exchange at: there is no token figure to hold to a budget,
        // and the conversion plan drops it anyway
        if (!(tokens > 0)) {
            keptTokenOwed[itemHrid] = owed;
            continue;
        }
        if (chosenHere(itemHrid)) {
            keptTokenOwed[itemHrid] = owed;
            if (tokens > left)
                capped[itemHrid] = { chosen: true, tokens, credits: owed, remainder: 0, over: tokens - left };
            left = Math.max(0, left - tokens);
            continue;
        }
        if (tokens <= left) {
            keptTokenOwed[itemHrid] = owed;
            left -= tokens;
            continue;
        }
        const credits = Math.min(creditsForTokens(left, rate), owed);
        const spent = credits > 0 ? tokensForCredits(credits, rate) || 0 : 0;
        if (credits > 0) keptTokenOwed[itemHrid] = credits;
        marketOwed[itemHrid] = owed - credits;
        capped[itemHrid] = { chosen: false, tokens: spent, credits, remainder: owed - credits, over: 0 };
        left = Math.max(0, left - spent);
    }

    return { tokenOwed: keptTokenOwed, marketOwed, capped };
}

/**
 * What one single-level buy costs under its cheapest acquisition plan.
 *
 * The level's own `guildTokenCost` is unavoidable. Its credit shortfall — what
 * is left after the inventory is netted off — is not: each colour is settled the
 * cheaper of the two ways, and `pathFor` is what says which
 * ({@link chooseCreditPath}). A colour the plan sends through the guild shop adds
 * its whole-exchange token cost to `effective`; a colour it sends to the market
 * adds gold to `marketGold` and nothing to the token bill.
 *
 * `effective` stays a *token* figure on purpose: it is what the token balance is
 * spent against, so it is what the ✓ and the ranking can honestly be judged on.
 * The gold half is carried beside it rather than folded in, because gold and
 * tokens are not the same pocket.
 *
 * A colour with neither a rate nor a market price adds nothing to either total
 * and is reported in `unknown` instead, to be said out loud on the row — a
 * guessed rate would turn a number this script does not have into one it appears
 * to. Such a buy is then judged on its direct token cost alone; declaring it
 * unaffordable would be its own overclaim from the same ignorance.
 *
 * @param {{tokenCost: number, creditCosts: Array<{itemHrid: string, count: number}>}} buy - One buy
 * @param {Object<string, number>} creditBalances - creditHrid → credits on hand
 * @param {Function} rateFor - creditHrid → token→credit rate or null
 * @param {Function} [pathFor] - creditHrid → decision from {@link chooseCreditPath};
 *   defaults to the token path, which is what a caller with no market data has
 * @returns {{direct: number, conversionTokens: number, effective: number, marketGold: number,
 *   conversions: Array<Object>, market: Array<Object>, unknown: Array<Object>}} The breakdown
 */
export function buyTokenCost(buy, creditBalances = {}, rateFor = () => null, pathFor = () => ({ path: 'tokens' })) {
    const direct = Number(buy?.tokenCost) || 0;
    const conversions = [];
    const market = [];
    const unknown = [];
    let conversionTokens = 0;
    let marketGold = 0;

    for (const { itemHrid, count } of buy?.creditCosts || []) {
        const gap = Math.max(0, (Number(count) || 0) - (Number(creditBalances?.[itemHrid]) || 0));
        if (gap <= 0) continue;
        const rate = rateFor(itemHrid) || null;
        const decision = pathFor(itemHrid) || { path: 'tokens' };

        if (decision.path === 'market' && Number(decision.marketGold) > 0) {
            const gold = decision.marketGold * gap;
            marketGold += gold;
            market.push({ itemHrid, gap, goldPerCredit: decision.marketGold, gold, decision });
            continue;
        }

        const tokens = tokensForCredits(gap, rate);
        if (!(tokens > 0)) {
            unknown.push({ itemHrid, gap });
            continue;
        }
        conversionTokens += tokens;
        conversions.push({ itemHrid, gap, tokens, rate, decision });
    }

    return {
        direct,
        conversionTokens,
        effective: direct + conversionTokens,
        marketGold,
        conversions,
        market,
        unknown,
    };
}

/**
 * Rank the single-level buys by what they genuinely cost in tokens, and walk the
 * balance down that ranking.
 *
 * The ranking is by *effective* token cost — the level's own token price plus
 * whatever the guild shop would charge in tokens to make up its credit shortfall
 * — because that is the number the token balance is actually spent against. A
 * cheap level whose credits you do not hold can easily cost more than a dearer
 * one whose credits you do.
 *
 * The walk then re-prices each buy against the balances the buys before it left
 * behind, so two levels wanting the same credit do not both claim the same stack.
 * The stopping rule is the old one: ascending order means the first buy the
 * remaining balance cannot cover is the last, since nothing further down is
 * cheaper.
 *
 * What the taken buys are still short of comes back split by which path the
 * recommendation sends it down: `owedCredits` for the colours the market wins —
 * the bill the marketplace hand-off under the list is drawn from — and
 * `owedTokenCredits` for the colours the guild shop wins, which the hand-off
 * lists as exchanges rather than shopping. The same arithmetic feeds both, so
 * the list and the plan under it cannot disagree.
 *
 * Still deliberately single-level-ahead: buying a level changes what that buff's
 * next level costs, so this is "if you spent everything right now" and not a
 * claim about an optimal spend.
 *
 * @param {Array<Object>} buys - Single-level buys, as `renderSuggestions` builds them
 * @param {Object} [context] - What is held and what is known
 * @param {number} [context.tokenBalance=0] - Guild tokens on hand
 * @param {Object<string, number>} [context.creditBalances={}] - creditHrid → credits on hand
 * @param {Function} [context.rateFor] - creditHrid → token→credit rate or null
 * @param {Function} [context.pathFor] - creditHrid → decision from {@link chooseCreditPath}
 * @returns {{rows: Array<Object>, count: number, spent: number, conversionSpent: number,
 *   directSpent: number, marketSpent: number, owedCredits: Object<string, number>,
 *   owedTokenCredits: Object<string, number>}} The ranked rows and the walk
 */
export function planNextBuys(
    buys,
    { tokenBalance = 0, creditBalances = {}, rateFor = () => null, pathFor = () => ({ path: 'tokens' }) } = {}
) {
    const rows = (Array.isArray(buys) ? buys : []).map((buy) => ({
        buy,
        ...buyTokenCost(buy, creditBalances, rateFor, pathFor),
        affordable: false,
    }));
    rows.sort(
        (a, b) => a.effective - b.effective || String(a.buy?.label ?? '').localeCompare(String(b.buy?.label ?? ''))
    );

    const remaining = { ...creditBalances };
    const owedCredits = {};
    const owedTokenCredits = {};
    let tokens = Number(tokenBalance) || 0;
    let count = 0;
    let spent = 0;
    let conversionSpent = 0;
    let marketSpent = 0;

    for (const row of rows) {
        const cost = buyTokenCost(row.buy, remaining, rateFor, pathFor);
        if (cost.effective > tokens) break;

        tokens -= cost.effective;
        spent += cost.effective;
        conversionSpent += cost.conversionTokens;
        marketSpent += cost.marketGold;
        count += 1;
        row.affordable = true;

        for (const { itemHrid, count: needed } of row.buy?.creditCosts || []) {
            const held = Number(remaining[itemHrid]) || 0;
            const used = Math.min(held, Number(needed) || 0);
            remaining[itemHrid] = held - used;
            const gap = (Number(needed) || 0) - used;
            if (gap <= 0) continue;
            // A colour with no path at all lands on the market side: the shopping
            // list skips what nothing converts into, which is the same silence it
            // gave before, and the token side must not claim a conversion it
            // cannot price
            const owed = (pathFor(itemHrid) || {}).path === 'tokens' ? owedTokenCredits : owedCredits;
            owed[itemHrid] = (owed[itemHrid] || 0) + gap;
        }
    }

    return {
        rows,
        count,
        spent,
        conversionSpent,
        directSpent: spent - conversionSpent,
        marketSpent,
        owedCredits,
        owedTokenCredits,
    };
}

/**
 * Build cheapest-gold-per-credit maps for both sell and buy sides.
 * @param {Object} itemDetailMap
 * @returns {{ sell: Object, buy: Object }}
 */
function buildCheapestPerCredit(itemDetailMap) {
    const sell = {};
    const buy = {};
    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        for (const conv of item.guildCreditConversions || []) {
            const creditHrid = conv.creditItemHrid;
            const sellPrice = getItemPrice(hrid, { mode: 'ask' });
            const buyPrice = getItemPrice(hrid, { mode: 'bid' });
            if (sellPrice > 0) {
                const gpc = (sellPrice * conv.itemCount) / conv.creditCount;
                if (!sell[creditHrid] || gpc < sell[creditHrid]) sell[creditHrid] = gpc;
            }
            if (buyPrice > 0) {
                const gpc = (buyPrice * conv.itemCount) / conv.creditCount;
                if (!buy[creditHrid] || gpc < buy[creditHrid]) buy[creditHrid] = gpc;
            }
        }
    }
    return { sell, buy };
}

/**
 * Build top-N conversion options per credit type, ranked by ask/credit ascending.
 * @param {Object} itemDetailMap
 * @param {number} n
 * @returns {Object} Map of creditHrid → array of up to n options
 */
function buildTopConversions(itemDetailMap, n) {
    const byCredit = {};
    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        for (const conv of item.guildCreditConversions || []) {
            const creditHrid = conv.creditItemHrid;
            const askPrice = getItemPrice(hrid, { mode: 'ask' });
            const bidPrice = getItemPrice(hrid, { mode: 'bid' });
            if (!askPrice && !bidPrice) continue;
            const askGPC = askPrice > 0 ? (askPrice * conv.itemCount) / conv.creditCount : null;
            const bidGPC = bidPrice > 0 ? (bidPrice * conv.itemCount) / conv.creditCount : null;
            if (!byCredit[creditHrid]) byCredit[creditHrid] = [];
            byCredit[creditHrid].push({
                hrid,
                name: item.name,
                itemCount: conv.itemCount,
                creditCount: conv.creditCount,
                askPrice,
                bidPrice,
                askGPC,
                bidGPC,
            });
        }
    }
    for (const creditHrid of Object.keys(byCredit)) {
        byCredit[creditHrid].sort((a, b) => {
            if (a.askGPC === null && b.askGPC === null) return 0;
            if (a.askGPC === null) return 1;
            if (b.askGPC === null) return -1;
            return a.askGPC - b.askGPC;
        });
        byCredit[creditHrid] = byCredit[creditHrid].slice(0, n);
    }
    return byCredit;
}

/**
 * The raw materials to buy for a bill of still-owed credits.
 *
 * The same walk the shrine cost table does for one upgrade, applied to the
 * planner's whole target list: each credit is bought through its cheapest
 * conversion (`buildTopConversions` has already ranked them ask-per-credit
 * ascending, so `[0]` is that one), the conversion is a fixed
 * `itemCount → creditCount` trade so a part-filled trade still costs a whole
 * one, and what is already sitting in the inventory comes off the end.
 *
 * Materials are pooled by hrid before the inventory is subtracted — two credits
 * whose cheapest conversion is the same bar want one number, not two competing
 * ones each claiming the whole stack.
 *
 * A credit with no conversion at all is skipped. Nothing is lost by that: the
 * amount is still owed and still listed in the totals above, it just has no
 * market item behind it to go and buy, so there is no tab to open for it.
 *
 * Guild tokens never appear here. They are not a market item and have no
 * `guildCreditConversions` entry — they come from trials — so they are the
 * planner's one cost the marketplace cannot answer.
 *
 * @param {Object<string, number>} owedCredits - creditHrid → credits still owed
 * @param {Object} topConversions - From {@link buildTopConversions}
 * @param {Array<Object>} inventory - The character's items
 * @returns {Array<{itemHrid: string, name: string, count: number}>} Shopping-list shape
 */
export function creditShortfallMaterials(owedCredits, topConversions, inventory) {
    const wanted = new Map();
    for (const [creditHrid, owed] of Object.entries(owedCredits || {})) {
        if (!(owed > 0)) continue;
        const top = (topConversions?.[creditHrid] || [])[0];
        if (!top?.hrid || !(top.creditCount > 0) || !(top.itemCount > 0)) continue;
        const qtyNeeded = Math.ceil(owed / top.creditCount) * top.itemCount;
        const prior = wanted.get(top.hrid);
        if (prior) prior.count += qtyNeeded;
        else wanted.set(top.hrid, { itemHrid: top.hrid, name: top.name, count: qtyNeeded });
    }

    const mats = [];
    for (const mat of wanted.values()) {
        const missing = mat.count - heldInInventory(inventory, mat.itemHrid);
        if (missing > 0) mats.push({ ...mat, count: missing });
    }
    return mats;
}

/**
 * The exchanges to make once the shortfall's materials are in the bag.
 *
 * `creditShortfallMaterials` answers "what do I buy"; this answers the step
 * after it, and off the same conversion option — `topConversions[hrid][0]`, the
 * cheapest ask-per-credit route — so the two can never name different items for
 * the same credit. The quantities are the *whole* trade, not the shopping list's:
 * a stack already in the inventory comes off what has to be bought and does not
 * come off what has to be handed over the counter.
 *
 * The rounding is the same part-filled-trade rule: 10 credits bought 4 at a time
 * is three trades, which is 12 credits, and the plan says 12 rather than pretend
 * the counter will make change.
 *
 * @param {Object<string, number>} owedCredits - creditHrid → credits still owed
 * @param {Object} topConversions - From {@link buildTopConversions}
 * @param {Object} [itemDetailMap] - The game's items, for display names
 * @returns {Array<{creditItemHrid: string, creditName: string, itemHrid: string, itemName: string,
 *   itemCount: number, creditCount: number, owed: number}>} One step per credit
 */
export function creditConversionPlan(owedCredits, topConversions, itemDetailMap = {}) {
    const steps = [];
    for (const [creditHrid, owed] of Object.entries(owedCredits || {})) {
        if (!(owed > 0)) continue;
        const top = (topConversions?.[creditHrid] || [])[0];
        if (!top?.hrid || !(top.creditCount > 0) || !(top.itemCount > 0)) continue;
        const trades = Math.ceil(owed / top.creditCount);
        steps.push({
            creditItemHrid: creditHrid,
            creditName: itemDetailMap?.[creditHrid]?.name || creditHrid.split('/').pop().replace(/_/g, ' '),
            itemHrid: top.hrid,
            itemName: top.name,
            itemCount: trades * top.itemCount,
            creditCount: trades * top.creditCount,
            owed,
        });
    }
    steps.sort((a, b) => a.creditName.localeCompare(b.creditName));
    return steps;
}

/**
 * The exchanges to make with tokens rather than with gold.
 *
 * The token-path twin of {@link creditConversionPlan}: same rounding rule —
 * whole exchanges, so a part-filled one costs a full one — applied to the
 * shortfall the recommendation sends through the guild shop instead of the
 * marketplace. The credits handed back are the whole trade's, not the owed
 * amount, for the same reason the market plan quotes the whole trade: the
 * counter does not make change.
 *
 * @param {Object<string, number>} owedTokenCredits - creditHrid → credits owed on the token path
 * @param {Object} [itemDetailMap] - The game's items, for display names
 * @param {Function} [rateFor] - creditHrid → token→credit rate
 * @returns {Array<{creditItemHrid: string, creditName: string, tokens: number, credits: number,
 *   owed: number, rate: Object}>} One step per credit
 */
export function tokenConversionPlan(owedTokenCredits, itemDetailMap = {}, rateFor = tokenRateFor) {
    const steps = [];
    for (const [creditHrid, owed] of Object.entries(owedTokenCredits || {})) {
        if (!(owed > 0)) continue;
        const rate = rateFor(creditHrid);
        const tokens = tokensForCredits(owed, rate);
        if (!(tokens > 0)) continue;
        const perExchange = Number(rate.creditsPerExchange);
        const tokensPer = Number(rate.tokensPerExchange);
        const credits = perExchange > 0 && tokensPer > 0 ? Math.ceil(owed / perExchange) * perExchange : owed;
        steps.push({
            creditItemHrid: creditHrid,
            creditName: itemDetailMap?.[creditHrid]?.name || creditHrid.split('/').pop().replace(/_/g, ' '),
            tokens,
            credits,
            owed,
            rate,
        });
    }
    steps.sort((a, b) => a.creditName.localeCompare(b.creditName));
    return steps;
}

/** What a colour with no rate at all is annotated with, and why */
const NO_RATE_NOTE = 'rate not seen yet';
const NO_RATE_TITLE =
    'No token→credit rate is known for this credit: it is not one of the eight colours whose standard rate ' +
    'is built in, and its exchange has never been opened here. Open it once with Guild Token selected on the ' +
    'give side and the rate is recorded — until then it is left out of the affordability math rather than ' +
    'guessed at.';

/**
 * How a rate should be spoken about, which depends on where it came from.
 *
 * A **captured** reading is approximate and says so with a `≈`: it is a number
 * scraped off a dialog, kept with the strategy that read it (`via`) and when it
 * was taken (`capturedAt`), and neither of those is a guarantee that the shop
 * still says the same thing. A reading taken from the item tiles rather than the
 * dialog's own stated arrow, or one with no capture time at all, carries that
 * caveat into the tooltip as well.
 *
 * A **standard** rate from {@link DEFAULT_TOKEN_RATES} is exact — it is the rate
 * the game charges, checked against the exchange dialog — so figures derived
 * from one drop the `≈`. The tooltip still names it as the standard rate rather
 * than as something observed, because the difference is the whole reason a
 * capture outranks it.
 *
 * @param {Object|null} rate - A rate, captured or standard
 * @returns {{rateText: string, title: string, approx: boolean}|null} Captions, or null without a rate
 */
function describeRate(rate) {
    if (!rate || !(Number(rate.creditsPerToken) > 0)) return null;

    const per = Number(rate.creditsPerToken);
    const rateText =
        Number(rate.tokensPerExchange) > 0 && Number(rate.creditsPerExchange) > 0
            ? `${rate.tokensPerExchange} token${rate.tokensPerExchange === 1 ? '' : 's'} → ${rate.creditsPerExchange}`
            : `${Number(per.toPrecision(3))} credits per token`;

    if (rate.source === 'default') {
        return {
            rateText,
            approx: false,
            title: `Standard exchange rate: the guild shop trades ${rateText}. Whole exchanges only, so a part-filled one costs a full one.`,
        };
    }

    const caveats = [];
    if (rate.via && rate.via !== 'arrow')
        caveats.push(`read from the exchange's item tiles rather than its stated rate`);
    if (!(Number(rate.capturedAt) > 0)) caveats.push('capture time unknown');
    else caveats.push(`read on ${new Date(Number(rate.capturedAt)).toLocaleDateString()}`);

    return {
        rateText,
        approx: true,
        title: `Approximate: the guild shop was seen exchanging ${rateText} (${caveats.join('; ')}). Whole exchanges only, so a part-filled one costs a full one.`,
    };
}

/**
 * What a forced mode could not honour, for a tooltip.
 *
 * Said because the alternative is a section that quietly disagrees with the
 * button the player pressed: in Tokens mode a colour on the market side looks
 * like a bug unless the row explains that there is no rate to convert at.
 *
 * @param {string} label - The credit's short name
 * @param {Object} decision - From {@link applySpendMode}
 * @returns {string} One sentence, or '' when the mode was honoured
 */
function describeFallback(label, decision) {
    if (!decision?.fallback || decision.path === 'unknown') return '';
    return decision.mode === 'tokens'
        ? `${label} — no token→credit rate is known for it, so Tokens mode buys this one on the market instead.`
        : `${label} — nothing on the market converts into it at a known price, so Gold mode exchanges tokens for this one instead.`;
}

/**
 * What the forced path costs over the recommended one, for a tooltip.
 *
 * The player is allowed to overpay — that is what the mode is for — but not
 * unknowingly, so a forced path that is meaningfully dearer names the path it
 * displaced and the difference. Both figures are the ones the comparison was
 * already made on, so the sentence cannot drift from the decision above it.
 *
 * @param {Object} decision - From {@link applySpendMode}
 * @returns {string} One sentence, or '' when nothing was overridden or nothing was lost
 */
function describeOverpay(decision) {
    if (!decision?.forced) return '';
    if (!(Number(decision.tokenGold) > 0) || !(Number(decision.marketGold) > 0)) return '';
    const chosen = decision.path === 'tokens' ? decision.tokenGold : decision.marketGold;
    const auto = decision.autoPath === 'tokens' ? decision.tokenGold : decision.marketGold;
    if (!(chosen > auto * (1 + OVERPAY_TOLERANCE))) return '';
    const would = decision.autoPath === 'tokens' ? 'convert tokens for it' : 'buy it on the market';
    return `Auto would ${would}: this mode pays about ${formatKMB(chosen - auto)} more gold-equivalent per credit.`;
}

/**
 * Why one path beat the other, for a tooltip — and, in a forced mode, what
 * taking the other one costs.
 * @param {string} label - The credit's short name
 * @param {Object} decision - From {@link chooseCreditPath}, possibly through {@link applySpendMode}
 * @returns {string} One to three sentences, or '' when there was nothing to say
 */
function describeDecision(label, decision) {
    const parts = [];
    if (Number(decision?.tokenGold) > 0 && Number(decision?.marketGold) > 0) {
        parts.push(
            `${label} — tokens: ${formatKMB(decision.tokenGold)} gold-equiv/credit vs market: ${formatKMB(decision.marketGold)}/credit.`
        );
        const overpay = describeOverpay(decision);
        if (overpay) parts.push(overpay);
    }
    const fallback = describeFallback(label, decision);
    if (fallback) parts.push(fallback);
    return parts.join(' ');
}

class GuildCreditValue {
    constructor() {
        this.initialized = false;
        this.unregisterObservers = [];
        this.autofillManager = createAutofillManager('GuildCreditValue-MissingMats');
        this._shrineTabCleanup = null;
        this._advisorObserver = null; // Re-renders the exchange advisor when the selected item changes
        this._advisorTimer = null;
        this._planSaveTimer = null;
        // Keeps the shrine cost table and its Missing Mats button current while
        // the modal stays open — see `_armShrineObservers`.
        this._shrineObserver = null;
        this._shrineTimer = null;
        this._shrineItemsHandler = null;
        // Keeps the shrine planner's owed rows, shopping list and conversion
        // steps current while purchases land — see `_armPlannerObservers`.
        this._plannerItemsHandler = null;
        this._plannerTimer = null;
        /** Item hrids whose holdings the last shrine render depended on */
        this._shrineWatchedHrids = null;
        /** Signature of the costs+holdings the last shrine render was built from */
        this._shrineSignature = null;
        /**
         * Bumped in `cleanup()` — a character switch tearing this feature down
         * mid-poll. The "Missing Mats Marketplace" click handler below waits up
         * to ~2s (polling for the marketplace tablist to render) before it
         * builds tabs from the `missingMats` it closed over at click time. A
         * switch landing inside that window leaves the handler's poll running:
         * `cleanup()` has already cleared this instance's own tab-tracking
         * state, but nothing stopped the poll itself, and when it finally finds
         * a tabsContainer — now the *arriving* character's — it would still
         * create tabs from the *departed* character's stale mats. Captured at
         * the top of the handler and checked again once the poll resolves, the
         * same generation-counter shape `production-arbitrage-board.js` uses
         * against its own in-flight async work.
         */
        this._switchGeneration = 0;
    }

    initialize() {
        if (this.initialized) return;

        this.autofillManager.initialize();

        // The saved shrine plan, read once so the synchronous planner render can
        // see it. Nothing waits on it: a modal opened before it lands restores
        // its inputs when the load finishes (see `_renderShrinePlanner`).
        shrinePlanRecord.load();

        // The stored token exchange, read once so the synchronous valuation can
        // see it. Nothing waits on it: until it lands, tokens are priced the way
        // they were before.
        hydrateCapturedTokenExchanges();

        const unregister = domObserver.onClass('GuildCreditValue', 'GuildPanel_exchangeModalContent', (el) => {
            // Before the table is drawn, because the reading is of the game's
            // own markup and this script is about to add markup of its own
            this._captureTokenExchange(el);
            this._render(el);
        });
        this.unregisterObservers.push(unregister);

        const unregisterShrine = domObserver.onClass('GuildCreditValue-Shrine', 'GuildPanel_guildModalContent', (el) =>
            this._renderShrine(el)
        );
        this.unregisterObservers.push(unregisterShrine);

        const unregisterTrial = domObserver.onClass('GuildCreditValue-Trial', 'GuildPanel_signupModal', (el) =>
            this._renderTrialSignup(el)
        );
        this.unregisterObservers.push(unregisterTrial);

        const unregisterTileSummary = domObserver.onClass(
            'GuildCreditValue-TileSummary',
            'GuildPanel_tileSummary',
            (el) => this._renderTrialTier(el)
        );
        this.unregisterObservers.push(unregisterTileSummary);

        this.initialized = true;
    }

    /**
     * Read the token→credit rate off an open exchange dialog.
     *
     * The Guild Shop states this rate and nothing in the client data has been
     * found that does, so this dialog is where it comes from. Runs regardless of
     * the `guildCreditValue` setting: that setting governs a table this script
     * draws, and reading a number off the game's own markup is not drawing
     * anything. Failures are swallowed inside the capture module — a dialog that
     * does not parse must never stop the table below it from rendering.
     *
     * @param {Element} modalEl - The exchange modal
     * @returns {void}
     */
    _captureTokenExchange(modalEl) {
        const gameData = dataManager.getInitClientData();
        const itemDetailMap = gameData?.itemDetailMap;
        if (!itemDetailMap) return;

        const titleText = modalEl.querySelector('[class*="GuildPanel_header"]')?.textContent?.trim() || '';
        if (!titleText) return;

        const creditHrid = Object.keys(itemDetailMap).find(
            (hrid) => hrid.includes('guild_credit') && itemDetailMap[hrid].name === titleText
        );
        if (!creditHrid) return;

        const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
        const selectorContainer = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
        // Identity from the icon sprite (locale independent); the translatable
        // aria-label only backs up the name comparison for older markup
        const selectedItemHrid = itemHridFromIcon(selectorContainer, itemDetailMap);
        const selectedItemName =
            selectorContainer?.querySelector('svg[aria-label]')?.getAttribute('aria-label') || null;

        captureTokenExchangeFromModal(modalEl, {
            creditItemHrid: creditHrid,
            creditName: titleText,
            selectedItemHrid,
            selectedItemName,
            tokenHrid: tokenHrid || null,
            tokenName: (tokenHrid && itemDetailMap[tokenHrid]?.name) || 'Guild Token',
        });
    }

    _render(modalEl) {
        if (!config.getSetting('guildCreditValue', true)) return;

        modalEl.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        const titleEl = modalEl.querySelector('[class*="GuildPanel_header"]');
        const titleText = titleEl?.textContent?.trim() || '';
        if (!titleText) return;

        const creditHrid = Object.keys(gameData.itemDetailMap || {}).find(
            (hrid) => hrid.includes('guild_credit') && gameData.itemDetailMap[hrid].name === titleText
        );
        if (!creditHrid) return;

        const rows = [];
        for (const [hrid, item] of Object.entries(gameData.itemDetailMap)) {
            const conv = (item.guildCreditConversions || []).find((c) => c.creditItemHrid === creditHrid);
            if (!conv) continue;

            const sellPrice = getItemPrice(hrid, { mode: 'ask' });
            const buyPrice = getItemPrice(hrid, { mode: 'bid' });
            if (!sellPrice && !buyPrice) continue;

            const sellGPC = sellPrice > 0 ? (sellPrice * conv.itemCount) / conv.creditCount : null;
            const buyGPC = buyPrice > 0 ? (buyPrice * conv.itemCount) / conv.creditCount : null;

            rows.push({
                hrid,
                name: item.name,
                itemCount: conv.itemCount,
                creditCount: conv.creditCount,
                sellPrice,
                buyPrice,
                sellGPC,
                buyGPC,
            });
        }

        if (rows.length === 0) return;

        const exchangeBtn = modalEl.querySelector('button');
        if (!exchangeBtn) return;

        let sortKey = 'ask';

        // What is on hand, once per build rather than once per row — the held
        // figure beside each name is what turns "cheapest per credit" into
        // "cheapest per credit that I can actually feed"
        const inventoryForCounts = dataManager.getInventory?.() || [];

        const buildTbody = () => {
            const sorted = [...rows].sort((a, b) => {
                const aVal = sortKey === 'bid' ? a.buyGPC : a.sellGPC;
                const bVal = sortKey === 'bid' ? b.buyGPC : b.sellGPC;
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return 1;
                if (bVal === null) return -1;
                return aVal - bVal;
            });
            const tbody = document.createElement('tbody');
            sorted.forEach((row, i) => {
                const isTop = i === 0;
                const tr = document.createElement('tr');
                tr.style.cssText = `border-bottom:1px solid rgba(255,255,255,0.05); color:${isTop ? '#4ade80' : '#e0e0e0'};`;
                const rate = row.creditCount === 1 ? `${row.itemCount} → 1` : `${row.itemCount} → ${row.creditCount}`;
                const held = heldInInventory(inventoryForCounts, row.hrid);
                const heldNote =
                    held > 0 ? ` <span style="color:#6b7280; font-size:10px;">${formatKMB(held)}</span>` : '';
                tr.innerHTML = `
                    <td style="padding:4px 6px; text-align:left;">${row.name}${heldNote}</td>
                    <td style="padding:4px 6px; text-align:center; color:#9ca3af;">${rate}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.sellPrice ? formatKMB(row.sellPrice) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buyPrice ? formatKMB(row.buyPrice) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; ${sortKey === 'bid' ? 'color:#9ca3af;' : `font-weight:${isTop ? '700' : '400'};`}">${row.sellGPC ? formatKMB(row.sellGPC) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; ${sortKey === 'ask' ? 'color:#9ca3af;' : `font-weight:${isTop ? '700' : '400'};`}">${row.buyGPC ? formatKMB(row.buyGPC) : '–'}</td>
                `;
                tbody.appendChild(tr);
            });
            return tbody;
        };

        const wrapper = document.createElement('div');
        wrapper.className = CSS_CLASS;
        wrapper.style.cssText = 'margin-top:12px; font-size:12px; width:100%; max-height:260px; overflow-y:auto;';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; color:#9ca3af; margin-bottom:6px; text-align:center;';
        hdr.textContent = 'Gold cost per credit — click to sort';
        wrapper.appendChild(hdr);

        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse;';

        const thead = document.createElement('thead');
        const thRow = document.createElement('tr');
        thRow.style.cssText = 'font-size:11px; border-bottom:1px solid rgba(255,255,255,0.1);';

        [
            { text: 'Item', align: 'left' },
            { text: 'Rate', align: 'center' },
            { text: 'Ask ea.', align: 'right' },
            { text: 'Bid ea.', align: 'right' },
        ].forEach(({ text, align }) => {
            const th = document.createElement('th');
            th.style.cssText = `text-align:${align}; padding:3px 6px; font-weight:500; color:#6b7280;`;
            th.textContent = text;
            thRow.appendChild(th);
        });

        const askTh = document.createElement('th');
        askTh.textContent = 'Ask/credit';
        const bidTh = document.createElement('th');
        bidTh.textContent = 'Bid/credit';
        thRow.appendChild(askTh);
        thRow.appendChild(bidTh);
        thead.appendChild(thRow);
        table.appendChild(thead);

        const updateThStyles = () => {
            const isAsk = sortKey === 'ask';
            const active = 'font-weight:600; color:#e0e0e0; text-decoration:underline;';
            const inactive = 'font-weight:500; color:#6b7280;';
            askTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${isAsk ? active : inactive}`;
            bidTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${!isAsk ? active : inactive}`;
        };
        updateThStyles();

        let currentTbody = buildTbody();
        table.appendChild(currentTbody);

        const setSort = (key) => {
            sortKey = key;
            updateThStyles();
            const newTbody = buildTbody();
            table.replaceChild(newTbody, currentTbody);
            currentTbody = newTbody;
        };

        askTh.addEventListener('click', () => setSort('ask'));
        bidTh.addEventListener('click', () => setSort('bid'));

        wrapper.appendChild(table);
        exchangeBtn.insertAdjacentElement('afterend', wrapper);

        // Exchange advisor — initial render + re-render on item selection change
        if (config.getSetting('guildCreditExchangeAdvisor', true)) {
            this._renderExchangeAdvisor(modalEl, creditHrid, rows);

            const itemSelector = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
            if (itemSelector) {
                // One observer at a time, released with the feature: a modal
                // reopened a few times used to leave each one's observer behind.
                // Debounced, since a selection change lands as a burst of
                // mutations and the advisor is a full re-render.
                this._disconnectAdvisorObserver();
                this._advisorObserver = new MutationObserver(() => {
                    if (this._advisorTimer) clearTimeout(this._advisorTimer);
                    this._advisorTimer = setTimeout(() => {
                        this._advisorTimer = null;
                        if (!modalEl.isConnected) return;
                        this._renderExchangeAdvisor(modalEl, creditHrid, rows);
                    }, 50);
                });
                this._advisorObserver.observe(itemSelector, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['href', 'aria-label', 'class'],
                });
            }
        }

        // Shrine upgrade planner
        if (config.getSetting('guildShrineUpgradePlanner', true)) {
            this._renderShrinePlanner(modalEl);
        }
    }

    /**
     * Write the shrine plan, once the inputs have sat still.
     *
     * The number input fires `input` on every keystroke — typing "12" is a pass
     * through "1" — and each write is a probe-merge-write against IndexedDB, so
     * they are coalesced the way the advisor's re-render is.
     * @returns {void}
     */
    _savePlanSoon() {
        if (this._planSaveTimer) clearTimeout(this._planSaveTimer);
        this._planSaveTimer = setTimeout(() => {
            this._planSaveTimer = null;
            shrinePlanRecord.save();
        }, PLAN_SAVE_DEBOUNCE_MS);
    }

    /**
     * Write a debounced plan edit that has not landed yet, and wait for it.
     *
     * The shared step behind `cleanup()`'s flush and the module-level
     * character-switch listener's. The trailing `flushed()` is not redundant:
     * the two run concurrently during a switch — the listener starts first,
     * `disableAllFeatures()` reaches `cleanup()` on its own chain — so
     * whichever of them finds the timer already cleared still has to wait for
     * the save the other one started before the record may be reset.
     *
     * @returns {Promise<void>} Settles once nothing is left to write
     */
    async flushPendingPlanSave() {
        if (this._planSaveTimer) {
            clearTimeout(this._planSaveTimer);
            this._planSaveTimer = null;
            await shrinePlanRecord.save();
        }
        await shrinePlanRecord.flushed();
    }

    /**
     * Keep the planner's numbers current while the exchange modal stays open.
     *
     * The plan's owed rows, the shopping-list button and the conversion steps
     * are all drawn from the live inventory, and until this hook existed they
     * were drawn exactly once per modal render: buy 40,000 Red Tea Leaf from
     * the plan's own shopping list and the plan still billed you for them until
     * something else redrew the modal. `items_updated` is when purchases are
     * claimed and exchanges hand their credits over, so it is the moment every
     * one of those figures changes. Debounced like the shrine block's redraw —
     * a claim lands as a burst — and self-releasing: a fire that finds the
     * planner gone from the document lets the hook go rather than keep a dead
     * closure on the listener list.
     *
     * One hook at a time, released with the feature — the exchange advisor's
     * rule, for the same reason.
     *
     * @param {Element} wrapper - The planner's root element
     * @param {Function} refresh - Redraws the totals and the suggestions
     * @private
     */
    _armPlannerObservers(wrapper, refresh) {
        this._disconnectPlannerObservers();
        this._plannerItemsHandler = () => {
            if (this._plannerTimer) clearTimeout(this._plannerTimer);
            this._plannerTimer = setTimeout(() => {
                this._plannerTimer = null;
                if (!wrapper.isConnected) {
                    this._disconnectPlannerObservers();
                    return;
                }
                refresh();
            }, SHRINE_RERENDER_DEBOUNCE_MS);
        };
        dataManager.on('items_updated', this._plannerItemsHandler);
    }

    /** Release the planner's inventory hook and any pending refresh */
    _disconnectPlannerObservers() {
        if (this._plannerTimer) {
            clearTimeout(this._plannerTimer);
            this._plannerTimer = null;
        }
        if (this._plannerItemsHandler) {
            dataManager.off('items_updated', this._plannerItemsHandler);
            this._plannerItemsHandler = null;
        }
    }

    /** Release the exchange advisor's selection observer and any pending re-render */
    _disconnectAdvisorObserver() {
        this._advisorObserver?.disconnect();
        this._advisorObserver = null;
        if (this._advisorTimer) {
            clearTimeout(this._advisorTimer);
            this._advisorTimer = null;
        }
    }

    _renderShrinePlanner(modalEl) {
        modalEl.querySelectorAll('.mwi-shrine-planner').forEach((el) => el.remove());

        const gameData = dataManager.getInitClientData();
        if (!gameData?.guildBuffDetailMap) return;

        // Group buffs by shrine
        const byShrine = {};
        for (const [buffHrid, buff] of Object.entries(gameData.guildBuffDetailMap)) {
            const shrineHrid = buff.shrineHrid;
            if (!byShrine[shrineHrid]) byShrine[shrineHrid] = [];
            byShrine[shrineHrid].push({ buffHrid, buff });
        }
        if (Object.keys(byShrine).length === 0) return;

        const SHRINE_LABELS = {
            '/guild_shrines/force': 'Force',
            '/guild_shrines/tempo': 'Tempo',
            '/guild_shrines/rarity': 'Rarity',
            '/guild_shrines/scholar': 'Scholar',
            '/guild_shrines/spirit': 'Spirit',
        };

        // Aggregate total costs across all target levels selected
        const aggregateCosts = (plans) => {
            const tokens = { total: 0 };
            const credits = {};
            for (const { buffHrid, fromLevel, toLevel } of plans) {
                const levelCosts = gameData.guildBuffDetailMap[buffHrid]?.levelCosts || {};
                for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
                    const cost = levelCosts[String(lvl)];
                    if (!cost) continue;
                    tokens.total += cost.guildTokenCost || 0;
                    for (const { itemHrid, count } of cost.creditCosts || []) {
                        credits[itemHrid] = (credits[itemHrid] || 0) + count;
                    }
                }
            }
            return { tokens, credits };
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-shrine-planner';
        // `box-sizing` and `max-width` together are what keep the whole planner
        // inside the modal's fixed width: the game's exchange modal does not grow
        // for injected content, so anything wider than 100% is a horizontal
        // scrollbar on the modal rather than a wider planner.
        wrapper.style.cssText = 'margin-top:10px; font-size:12px; width:100%; max-width:100%; box-sizing:border-box;';

        // Collapsible header
        const header = document.createElement('div');
        header.style.cssText = `
            display:flex; justify-content:space-between; align-items:center;
            padding:5px 6px; background:rgba(255,255,255,0.04); border-radius:4px;
            cursor:pointer; font-size:11px; color:#9ca3af; user-select:none;
            border:1px solid rgba(255,255,255,0.08); margin-bottom:4px;
        `;
        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Shrine Upgrade Planner';
        const headerArrow = document.createElement('span');
        headerArrow.textContent = '▶';
        header.appendChild(headerTitle);
        header.appendChild(headerArrow);
        wrapper.appendChild(header);

        const body = document.createElement('div');
        // Bounded like the ranking table above: the game's exchange modal does not grow
        // for injected content, so an unbounded planner body renders past the modal's
        // bottom edge instead of scrolling within it
        // `overflow-x:hidden` is the backstop, not the mechanism: every row inside
        // wraps rather than extends, and this is here so a row that one day forgets
        // to still cannot put a horizontal scrollbar on the modal.
        body.style.cssText =
            'display:none; max-height:260px; overflow-y:auto; overflow-x:hidden; width:100%; box-sizing:border-box;';
        wrapper.appendChild(body);

        const applyCollapsed = (collapsed) => {
            body.style.display = collapsed ? 'none' : 'block';
            headerArrow.textContent = collapsed ? '▶' : '▼';
        };

        header.addEventListener('click', () => {
            const isOpen = body.style.display !== 'none';
            applyCollapsed(isOpen);
            planState().collapsed = isOpen;
            this._savePlanSoon();
        });

        // The suggestion section is built before the manual rows so it sits at
        // the top of the body, but its contents come from the same per-buff walk
        // below — so it is filled in afterwards.
        const suggestEl = document.createElement('div');
        suggestEl.className = 'mwi-shrine-next-buys';
        suggestEl.style.cssText =
            'margin-bottom:8px; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);';
        body.appendChild(suggestEl);

        // Track target inputs for cost recalculation
        const planInputs = []; // [{buffHrid, currentLevel, capLevel, inputEl}]

        const totalsEl = document.createElement('div');
        totalsEl.style.cssText =
            'margin-top:8px; padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);';

        // The marketplace hand-off for whatever the totals still owe. Its own
        // element rather than part of `totalsEl`, so the button is not rebuilt
        // by the innerHTML wipe that clears the rows above it.
        const matsEl = document.createElement('div');
        matsEl.className = 'mwi-shrine-plan-mats';

        const recalculate = () => {
            const plans = planInputs
                .map(({ buffHrid, currentLevel, inputEl }) => ({
                    buffHrid,
                    fromLevel: currentLevel,
                    toLevel: Math.min(parseInt(inputEl.value, 10) || currentLevel, parseInt(inputEl.max, 10)),
                }))
                .filter(({ fromLevel, toLevel }) => toLevel > fromLevel);

            totalsEl.innerHTML = '';
            matsEl.innerHTML = '';

            if (plans.length === 0) {
                totalsEl.innerHTML =
                    '<div style="color:#6b7280; text-align:center; font-size:11px;">Set target levels above current to see costs</div>';
                return;
            }

            const { tokens, credits } = aggregateCosts(plans);
            const itemDetailMap = gameData.itemDetailMap || {};
            const inventory = dataManager.getInventory();

            // What the plan costs, less what is already in the bag. The shrine
            // cost table nets the same way for a single upgrade, and the two
            // reading differently for the same buy was the confusing part: the
            // planner asked for 50 credits you were holding 50 of.
            //
            // Netting is why the heading no longer says "Total upgrade cost".
            // That phrase was true of the gross figure and would be a lie about
            // this one, so the box says what it now shows, and every row that
            // had something come off it says how much.
            const owedRow = (itemHrid, gross) => {
                const owned = heldInInventory(inventory, itemHrid);
                return { owed: Math.max(0, gross - owned), owned };
            };
            const ownedNote = (owned) =>
                owned > 0
                    ? ` <span style="color:#6b7280; font-weight:400;">(own ${owned.toLocaleString()})</span>`
                    : '';

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'color:#9ca3af; font-size:11px; margin-bottom:6px;';
            titleEl.textContent = 'Still needed for these targets';
            totalsEl.appendChild(titleEl);

            // Guild tokens row. Tokens are not listed on the market, but the
            // guild shop trades them for credits and credits have a gold value,
            // so the row can carry an approximate one — labelled as derived,
            // never presented as a price
            const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
            const tokenRow = owedRow(tokenHrid, tokens.total);
            if (tokenRow.owed > 0) {
                const tokenGold = describeGuildTokenGold(tokenRow.owed, 'ask');
                const goldStr = tokenGold
                    ? ` <span style="color:#6b7280; font-weight:400;" title="${tokenGold.title.replace(/"/g, '&quot;')}">(${tokenGold.text})</span>`
                    : '';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
                row.innerHTML = `<span style="color:#aaa;">Guild Tokens</span><span style="color:#e0e0e0; font-weight:600;">${tokenRow.owed.toLocaleString()}${goldStr}${ownedNote(tokenRow.owned)}</span>`;
                totalsEl.appendChild(row);
            }

            // Tokens the plan does not already spend on itself — the only ones
            // there are to convert into credits. Against the plan's gross token
            // cost, not the netted `owed`: the tokens the plan consumes are spent
            // whether or not they were already in the bag.
            const heldTokens = tokenHrid ? heldInInventory(inventory, tokenHrid) : 0;
            const spareTokens = Math.max(0, heldTokens - tokens.total);

            // Which way each colour is cheapest to get, for the annotation below.
            // Built here rather than per row so the button under the box and the
            // notes inside it are drawn from the same prices.
            //
            // Through the selected spend mode, like every other part of the
            // section: the box above the suggestions and the suggestions
            // themselves settle the same shortfall, so they cannot be allowed to
            // settle it two different ways.
            const topConversions = buildTopConversions(itemDetailMap, 1);
            const goldPerToken = goldPerTokenFor(itemDetailMap);
            const mode = spendMode();
            // A ticked colour is settled with tokens whatever the mode says —
            // per colour, through the same applySpendMode the mode goes
            // through, so a covered colour with no rate still falls back to the
            // market rather than dropping off the plan.
            const covered = tokenCoveredCredits(planState());
            const pathFor = (creditHrid) =>
                applySpendMode(
                    chooseCreditPath({
                        rate: tokenRateFor(creditHrid),
                        marketGoldPerCredit: (topConversions?.[creditHrid] || [])[0]?.askGPC ?? null,
                        goldPerToken,
                    }),
                    covered.has(creditHrid) ? 'tokens' : mode
                );

            // Credit costs. Netted first, then drawn: the value ranking beside
            // the toggles compares the colours this plan still owes, so it has
            // to see all of them before the first row is written.
            const owedCredits = {};
            for (const [itemHrid, count] of Object.entries(credits))
                owedCredits[itemHrid] = owedRow(itemHrid, count).owed;
            const ranked = rankTokenCoverValue(
                Object.keys(owedCredits).filter((itemHrid) => owedCredits[itemHrid] > 0),
                pathFor
            );
            const valueByHrid = new Map(ranked.map((row) => [row.itemHrid, row]));
            const bestValue = ranked.find((row) => row.best) || null;

            for (const [itemHrid, count] of Object.entries(credits)) {
                const { owed, owned } = owedRow(itemHrid, count);
                if (owed <= 0) continue;
                const name = itemDetailMap[itemHrid]?.name || itemHrid.split('/').pop();
                const price = getItemPrice(itemHrid, { mode: 'ask' });
                const goldStr = price > 0 ? ` (${formatKMB(price * owed)})` : '';
                const rate = tokenRateFor(itemHrid);
                const described = describeRate(rate);
                const row = document.createElement('div');
                row.style.cssText =
                    'display:flex; justify-content:space-between; gap:6px; padding:2px 0; font-size:12px;';
                row.innerHTML = `<span style="color:#aaa;">${name}</span><span style="color:#e0e0e0; font-weight:600;">${owed.toLocaleString()}<span style="color:#6b7280; font-weight:400;">${goldStr}</span>${ownedNote(owned)}</span>`;
                totalsEl.appendChild(row);

                // The per-colour token cover. Ticked before buying, so the
                // shopping list is not padded with materials for a colour the
                // player already means to exchange tokens for. Persisted on the
                // same per-character plan record as the targets; the cost on
                // the label is the whole-exchange bill for what is still owed,
                // so it falls as credits land. A colour with no rate has
                // nothing to exchange at, so its box is disabled rather than
                // silently ignored when ticked.
                const cover = document.createElement('label');
                cover.className = 'mwi-shrine-token-cover';
                cover.dataset.creditHrid = itemHrid;
                cover.style.cssText =
                    'display:inline-flex; align-items:center; gap:3px; margin-left:6px; cursor:pointer; ' +
                    'color:#c4b5fd; font-size:10px; user-select:none; vertical-align:middle;';
                const coverBox = document.createElement('input');
                coverBox.type = 'checkbox';
                coverBox.style.cssText = 'margin:0; cursor:pointer;';
                coverBox.checked = covered.has(itemHrid);
                const coverCost = described ? tokensForCredits(owed, rate) : null;
                const coverText = document.createElement('span');
                coverText.textContent = `🪙${coverCost > 0 ? ` ${coverCost.toLocaleString()} tok` : ''}`;
                cover.appendChild(coverBox);
                cover.appendChild(coverText);
                if (!described) {
                    coverBox.disabled = true;
                    cover.style.cursor = 'not-allowed';
                    cover.style.color = '#4b5563';
                    cover.title = NO_RATE_TITLE;
                } else {
                    cover.title =
                        `Cover ${name} with guild tokens: its materials come off the shopping list and the ` +
                        `${owed.toLocaleString()} still owed is exchanged for ${described.approx ? '≈' : ''}` +
                        `${(coverCost || 0).toLocaleString()} tokens instead, whatever the spend mode says. ` +
                        `Saved with this character's plan. ${described.title}`;
                }
                coverBox.addEventListener('change', () => {
                    const plan = planState();
                    if (!plan.tokenCredits || typeof plan.tokenCredits !== 'object') plan.tokenCredits = {};
                    if (coverBox.checked) plan.tokenCredits[itemHrid] = true;
                    else delete plan.tokenCredits[itemHrid];
                    savePlanSoon();
                    // Both halves, like the spend-mode buttons: the still-needed
                    // box and the suggestions settle the same shortfall
                    recalculate();
                    renderSuggestions();
                });
                row.querySelector('span').appendChild(cover);

                // Which colours are worth the tokens. The toggles above made
                // every colour equally tickable and said nothing about which
                // tick is a good idea; this is the comparison, in gold, next to
                // the switch it applies to. A sibling of the label rather than a
                // child of it, so reading the number does not toggle the box.
                if (described) {
                    const value = valueByHrid.get(itemHrid);
                    const worth = document.createElement('span');
                    worth.className = 'mwi-shrine-token-worth';
                    worth.dataset.creditHrid = itemHrid;
                    if (!value || value.unpriced) {
                        worth.textContent = 'unpriced';
                        worth.style.cssText = 'margin-left:4px; font-size:10px; color:#4b5563;';
                        worth.title =
                            `Nothing on the market converts into ${shortCreditName(name)} at a known price, so ` +
                            'there is nothing to weigh a token against here. Unpriced rather than guessed.';
                    } else {
                        const saved = formatKMB(value.goldPerToken);
                        worth.textContent = `${value.best ? '★ ' : ''}${saved}/tok`;
                        worth.style.cssText =
                            `margin-left:4px; font-size:10px; color:${value.best ? '#4ade80' : '#6b7280'};` +
                            (value.best ? ' font-weight:600;' : '');
                        const lead = `1 tok here saves ${saved} gold vs buying ${shortCreditName(name)}'s mats.`;
                        worth.title = value.best
                            ? `${lead} Best use of your tokens on this plan.`
                            : `${lead} Best here is ${shortCreditName(
                                  itemDetailMap[bestValue.itemHrid]?.name || bestValue.itemHrid
                              )} at ${formatKMB(bestValue.goldPerToken)}/tok.`;
                    }
                    row.querySelector('span').appendChild(worth);
                }

                // The other way to settle this row: the guild shop sells credits
                // for tokens. Only said where that is the *cheaper* way — a gold
                // credit costs sixty tokens and the market sells its materials
                // for a fraction of what sixty tokens are worth, so offering the
                // exchange there would be advice to lose money — and only when
                // the tokens the plan is not already spending cover it. Where the
                // market wins, the row above it already says what the gold costs.
                const note = document.createElement('div');
                note.className = 'mwi-shrine-credit-convert';
                note.dataset.creditHrid = itemHrid;
                note.style.cssText =
                    'padding:0 0 2px 0; font-size:10px; color:#6b7280; white-space:normal; overflow-wrap:anywhere;';
                if (!described) {
                    note.textContent = `${shortCreditName(name)}: token ${NO_RATE_NOTE}`;
                    note.title = NO_RATE_TITLE;
                    totalsEl.appendChild(note);
                    continue;
                }
                const decision = pathFor(itemHrid);
                if (decision.path !== 'tokens') continue;
                const tokensNeeded = tokensForCredits(owed, rate);
                if (!(tokensNeeded > 0)) continue;
                // The spare-token guard is advice, and advice is what `auto` is
                // for: offering an exchange the plan's own tokens cannot cover
                // would be a suggestion to go and find more. A mode the player
                // chose is not advice — the line stays and says the shortfall,
                // rather than vanishing and leaving this box disagreeing with
                // the button that put it here. A ticked token cover is the same
                // kind of choice, made per colour.
                const beyondSpare = tokensNeeded > spareTokens;
                if (beyondSpare && mode !== 'tokens' && !covered.has(itemHrid)) continue;
                const spareNote = beyondSpare ? ' (more than this plan leaves spare)' : '';
                note.textContent = `or convert ${described.approx ? '≈' : ''}${tokensNeeded.toLocaleString()} tokens${spareNote}`;
                note.title = [described.title, describeDecision(shortCreditName(name), decision)]
                    .filter(Boolean)
                    .join(' ');
                totalsEl.appendChild(note);
            }

            if (totalsEl.childElementCount === 1) {
                const none = document.createElement('div');
                none.style.cssText = 'color:#4ade80; text-align:center; font-size:11px;';
                none.textContent = 'Everything these targets cost is already held';
                totalsEl.appendChild(none);
            }

            // Only the colours this mode (and the token covers) send to the
            // market go shopping. A colour settled with tokens has an exchange
            // to make rather than a shopping trip, and the note under its row
            // above already says so — putting its materials on the shopping
            // list too would be the same shortfall billed twice, in two
            // different currencies. The token side still gets its exchange
            // listed below, so covering a colour does not make its cost vanish.
            const { marketOwed, tokenOwed } = splitOwedCredits(owedCredits, pathFor);
            // The tokens the levels themselves need are already spoken for, so
            // the conversions get what is left and no more. What the budget will
            // not stretch to comes back here as materials to buy, which is why
            // the shopping bill is the sum of the two sides.
            const budgeted = capTokenPlanToBudget(tokenOwed, spareTokens, {
                rateFor: tokenRateFor,
                decisionFor: pathFor,
            });
            const shoppingOwed = { ...marketOwed };
            for (const [itemHrid, owed] of Object.entries(budgeted.marketOwed))
                shoppingOwed[itemHrid] = (shoppingOwed[itemHrid] || 0) + owed;
            renderPlanFlow(shoppingOwed, budgeted.tokenOwed, itemDetailMap, inventory, budgeted.capped);
        };

        /**
         * The "go and buy the shortfall" button under the totals, and the
         * conversion steps that follow the shopping trip.
         *
         * Rebuilt by `recalculate()` rather than kept in step, because what is
         * missing is a function of the targets, the inventory and the ask prices
         * all at once — the same three the totals above are drawn from, so the
         * two cannot disagree if they are drawn together. (`recalculate` itself
         * is now re-run on `items_updated` — see `_armPlannerObservers` — which
         * is what keeps all of this current while the purchases land.)
         *
         * The conversion half is the planner's twin of the suggestions'
         * `renderNextBuyFlow`, and off the same option — `topConversions[..][0]`
         * — so the list bought and the list handed over the counter cannot name
         * different items. The steps are guidance rather than navigation: the
         * exchange this modal *is* is where they happen, and the quantities are
         * whole trades of what is still owed, so each line ticks down as the
         * exchanged credits land in the bag and disappears at zero.
         *
         * @param {Object<string, number>} marketOwed - creditHrid → credits bought via materials
         * @param {Object<string, number>} tokenOwed - creditHrid → credits exchanged for tokens
         * @param {Object} itemDetailMap - The game's items
         * @param {Array<Object>} inventory - The character's items
         * @param {Object} [capped] - From {@link capTokenPlanToBudget}, what the token budget cut back
         */
        function renderPlanFlow(marketOwed, tokenOwed, itemDetailMap, inventory, capped = {}) {
            // Fresh per recalculation: the ranking is by live ask price, and a
            // cached one would send the user after yesterday's cheapest bar
            const topConversions = buildTopConversions(itemDetailMap, 1);
            const missingMats = creditShortfallMaterials(marketOwed, topConversions, inventory);
            const steps = creditConversionPlan(marketOwed, topConversions, itemDetailMap);
            const tokenSteps = tokenConversionPlan(tokenOwed, itemDetailMap);

            if (missingMats.length > 0) renderMissingMatsButton(missingMats);

            if (steps.length === 0 && tokenSteps.length === 0) return;

            const title = document.createElement('div');
            title.style.cssText = 'margin-top:5px; font-size:10px; color:#9ca3af;';
            title.textContent = 'then convert:';
            matsEl.appendChild(title);

            for (const step of tokenSteps) {
                const described = describeRate(step.rate);
                const line = document.createElement('div');
                line.className = 'mwi-shrine-plan-token-step';
                line.dataset.creditHrid = step.creditItemHrid;
                line.style.cssText =
                    'font-size:10px; color:#c4b5fd; white-space:normal; overflow-wrap:anywhere; padding:1px 0;';
                const cap = capped?.[step.creditItemHrid];
                const held = cap && !cap.chosen ? ' (token cap)' : '';
                line.textContent = `convert ${step.tokens.toLocaleString()} tok → ${step.credits.toLocaleString()} ${shortCreditName(step.creditName)}${held}`;
                line.title = [
                    `${step.tokens.toLocaleString()} guild tokens exchange here for ${step.credits.toLocaleString()} ${step.creditName} — ${
                        held
                            ? // `step.owed` is what survived the cap, so the owed figure is put back together here
                              `as much of the ${(cap.credits + cap.remainder).toLocaleString()} owed as the tokens this plan leaves spare will buy`
                            : `the ${step.owed.toLocaleString()} still owed, rounded up to whole exchanges`
                    }.`,
                    held &&
                        `The other ${cap.remainder.toLocaleString()} are on the shopping list as materials instead.`,
                    cap?.chosen &&
                        `${cap.over.toLocaleString()} tokens more than this plan leaves spare — you picked this colour's exchange, so it stays.`,
                    described?.title,
                ]
                    .filter(Boolean)
                    .join(' ');
                matsEl.appendChild(line);
            }

            for (const step of steps) {
                const line = document.createElement('div');
                line.className = 'mwi-shrine-plan-convert-step';
                line.dataset.creditHrid = step.creditItemHrid;
                line.style.cssText =
                    'font-size:10px; color:#c4b5fd; white-space:normal; overflow-wrap:anywhere; padding:1px 0;';
                line.textContent = `convert ${step.itemCount.toLocaleString()}× ${step.itemName} → ${step.creditCount.toLocaleString()} ${shortCreditName(step.creditName)}`;
                line.title = `${step.itemCount.toLocaleString()} ${step.itemName} exchanges here for ${step.creditCount.toLocaleString()} ${step.creditName} — the ${step.owed.toLocaleString()} still owed, rounded up to whole exchanges`;
                matsEl.appendChild(line);
            }
        }

        /**
         * @param {Array<{itemHrid: string, name: string, count: number}>} missingMats - What to buy
         */
        function renderMissingMatsButton(missingMats) {
            const button = document.createElement('button');
            button.className = 'mwi-shrine-plan-mats-btn';
            button.style.cssText = `
                width:100%; padding:8px 12px; margin-top:8px;
                background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
                color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
                cursor:pointer; font-size:12px; font-weight:600;
            `;
            button.textContent = 'Missing Mats Marketplace';
            button.addEventListener('mouseenter', () => {
                button.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
            });
            button.addEventListener('mouseleave', () => {
                button.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
            });
            // The shared list, not this file's older hand-rolled tab code above:
            // one module owns the marketplace tab bar, and a second watcher on it
            // is what the shopping list's own docstring is a note about. It also
            // takes its own tabs away when the marketplace closes, so the button
            // needs no teardown hooked into the modal's lifecycle.
            button.addEventListener('click', () => openShoppingList(missingMats, { heading: 'Shrine plan' }));
            matsEl.appendChild(button);
        }

        // Single-level-ahead buys, filled by the per-shrine walk below
        const nextBuys = [];

        // Build rows per shrine
        for (const [shrineHrid, buffs] of Object.entries(byShrine).sort()) {
            const shrineLabel = SHRINE_LABELS[shrineHrid] || shrineHrid.split('/').pop();
            const shrineCapLevel = dataManager.getGuildBuildingLevel(shrineHrid);

            const shrineSection = document.createElement('div');
            shrineSection.style.cssText = 'margin-bottom:6px;';

            const shrineTitleEl = document.createElement('div');
            shrineTitleEl.style.cssText =
                'color:#c4b5fd; font-size:11px; font-weight:600; margin-bottom:3px; padding:2px 0;';
            shrineTitleEl.textContent = `${shrineLabel} Shrine${shrineCapLevel > 0 ? ` (cap: ${shrineCapLevel})` : ''}`;
            shrineSection.appendChild(shrineTitleEl);

            for (const { buffHrid, buff } of buffs.sort((a, b) => a.buffHrid.localeCompare(b.buffHrid))) {
                const isCombat = buff.isCombat;
                const buffLabel = isCombat ? 'Combat' : 'Skilling';
                const currentLevel = dataManager.getCharacterGuildBuffLevel(buffHrid);
                const maxLevel = Math.max(...Object.keys(buff.levelCosts).map(Number));
                const rawCap = shrineCapLevel > 0 ? Math.min(shrineCapLevel, maxLevel) : maxLevel;
                // Buildings and shrines cap at level 20 in-game (Buildings tab:
                // "Lv. x / 20") — a different ladder from the 21 trial tiers, and a
                // shrine level or levelCosts table that claims more than that is
                // not one to plan an upgrade past.
                const capLevel = Math.min(rawCap, GUILD_BUILDING_MAX_LEVEL);

                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px;';

                const label = document.createElement('span');
                label.style.cssText = 'flex:1; color:#9ca3af;';
                label.textContent = `${buffLabel} (lvl ${currentLevel})`;

                const input = document.createElement('input');
                input.type = 'number';
                input.min = String(currentLevel);
                input.max = String(capLevel);
                input.value = String(currentLevel);
                input.dataset.buffHrid = buffHrid;
                input.style.cssText = `
                    width:52px; padding:2px 4px; background:#1a1a2e; border:1px solid #374151;
                    border-radius:3px; color:#e0e0e0; font-size:11px; text-align:center;
                `;
                input.addEventListener('input', () => {
                    recalculate();
                    const targets = planState().targets;
                    const value = parseInt(input.value, 10);
                    if (Number.isFinite(value) && value > currentLevel) targets[buffHrid] = Math.min(value, capLevel);
                    else delete targets[buffHrid];
                    this._savePlanSoon();
                });

                // The cost of this buff's next level only, for the suggestions
                // above — a buff already at its shrine's cap has no next level
                // and is left out.
                if (currentLevel < capLevel) {
                    const nextCost = buff.levelCosts?.[String(currentLevel + 1)];
                    if (nextCost) {
                        nextBuys.push({
                            buffHrid,
                            label: `${shrineLabel} · ${buffLabel}`,
                            fromLevel: currentLevel,
                            toLevel: currentLevel + 1,
                            tokenCost: nextCost.guildTokenCost || 0,
                            creditCosts: nextCost.creditCosts || [],
                        });
                    }
                }

                const capLabel = document.createElement('span');
                capLabel.style.cssText = 'color:#4b5563; font-size:10px;';
                capLabel.textContent = `/ ${capLevel}`;

                row.appendChild(label);
                row.appendChild(input);
                row.appendChild(capLabel);
                shrineSection.appendChild(row);

                planInputs.push({ buffHrid, currentLevel, capLevel, inputEl: input });
            }

            body.appendChild(shrineSection);
        }

        body.appendChild(totalsEl);
        body.appendChild(matsEl);

        /**
         * "What should I buy next" — every buff's single next level, cheapest
         * *effective* guild-token cost first.
         *
         * Ranked on tokens alone, and deliberately not on any blended score:
         * Force, Rarity and Scholar buy different things (combat power, loot,
         * experience) with no exchange rate between them, so a "best value"
         * number across shrines would be an invented one. Cheapest-unlock-first
         * is objective, and which of the cheap ones is worth having stays the
         * player's call.
         *
         * What changed is what "cheapest" counts. A level whose credits are short
         * is not simply unaffordable: the shortfall can be settled two ways, and
         * each row shows the cheaper one. The guild shop sells credits for
         * tokens, and the marketplace sells the materials that convert into them,
         * so every colour is a small comparison — tokens-per-credit times what a
         * token is worth in gold, against the cheapest gold-per-credit on the
         * market. The rates make that comparison lopsided and worth making: a
         * blue credit is a tenth of a token and a gold one is sixty, so burning
         * tokens on gold credits is almost never right while its materials are
         * buyable. What the row then prices, ranks and ticks is that one
         * recommended plan — the tokens it really needs, with the gold half said
         * beside it. See {@link planNextBuys} and {@link chooseCreditPath}. A
         * colour with neither a rate nor a market price is left out of the
         * arithmetic entirely and said so on the row, because a guess there makes
         * an unaffordable buy look affordable.
         *
         * ## Layout
         *
         * Each row is a wrapping flex line, not a two-column split: the label and
         * the token figure share the first line (the label on one line, clipped
         * rather than stacked), and the credit list and any conversion note take
         * whole continuation lines of their own (`flex:1 1 100%`). That is the
         * fix for the rows running past the modal's right edge — the modal has a
         * fixed width and does not grow, so the only place a long credit list can
         * go is downwards. Credit names are shortened here, where the whole
         * section is about guild credits, with the full name in a `title`.
         */
        // renderSuggestions is a plain function, so the instance's debounced
        // plan save has to be captured here where `this` still means the panel
        const savePlanSoon = () => this._savePlanSoon();

        function renderSuggestions() {
            const itemDetailMap = gameData.itemDetailMap || {};
            const tokenHrid = Object.keys(itemDetailMap).find((hrid) => hrid.includes('guild_token'));
            const tokenName = (tokenHrid && itemDetailMap[tokenHrid]?.name) || 'Guild Tokens';
            const inventory = dataManager.getInventory();
            const balance = tokenHrid ? heldInInventory(inventory, tokenHrid) : 0;

            suggestEl.innerHTML = '';

            const mode = spendMode();

            const heading = document.createElement('div');
            heading.style.cssText =
                'display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:11px; color:#9ca3af; margin-bottom:5px;';
            // The ranking is by effective *token* cost in every mode — tokens are
            // the scarce pocket, and the gold figure rides alongside rather than
            // being blended into it. What changes per mode is which colours
            // contribute to which half.
            const RANKING_TITLE =
                'Cheapest first by effective token cost: the level’s own token price plus the tokens its ' +
                'plan spends converting credits, with the gold half named beside it. Colours ' +
                'with neither a rate nor a market price are left out of the sum.';
            heading.title =
                {
                    auto:
                        `${RANKING_TITLE} Auto: each colour goes whichever way is cheaper — credits the ` +
                        'marketplace supplies more cheaply than the guild shop are bought there, and cost gold ' +
                        'rather than tokens.',
                    tokens:
                        `${RANKING_TITLE} Tokens: every colour with a known rate is exchanged for, however ` +
                        'dear — a colour with no rate is still bought on the market, since there is nothing to ' +
                        'exchange at.',
                    gold:
                        `${RANKING_TITLE} Gold: every colour with a priced conversion is bought, so the token ` +
                        'figure falls to the levels themselves — a colour nothing converts into is still ' +
                        'exchanged for tokens, since there is nothing to buy.',
                }[mode] || RANKING_TITLE;
            heading.className = 'mwi-shrine-suggest-heading';
            heading.style.cursor = 'pointer';
            heading.style.userSelect = 'none';
            const collapsed = planState().suggestionsCollapsed === true;
            heading.innerHTML =
                `<span>${collapsed ? '▶' : '▼'} Suggested Next Buys</span>` +
                `<span style="color:#e0e0e0; white-space:nowrap;">${tokenName}: <b>${balance.toLocaleString()}</b></span>`;
            suggestEl.appendChild(heading);

            // Everything below the heading folds as one block; the collapsed
            // state rides the same per-character plan record as the panel's own
            const suggestBody = document.createElement('div');
            suggestBody.className = 'mwi-shrine-suggest-body';
            suggestBody.style.display = collapsed ? 'none' : 'block';
            suggestEl.appendChild(suggestBody);
            heading.addEventListener('click', () => {
                const isOpen = suggestBody.style.display !== 'none';
                suggestBody.style.display = isOpen ? 'none' : 'block';
                heading.querySelector('span').textContent = `${isOpen ? '▶' : '▼'} Suggested Next Buys`;
                planState().suggestionsCollapsed = isOpen;
                savePlanSoon();
            });

            // How the credit gaps are settled, for the whole section. Inside the
            // folding body rather than in the heading, so it is out of the way
            // when the section is folded and its clicks cannot be mistaken for
            // the fold's. Pills in the shape the other panels' range selectors
            // use, in the planner's own purple.
            const modeRow = document.createElement('div');
            modeRow.className = 'mwi-shrine-spend-mode';
            modeRow.style.cssText = 'display:flex; gap:4px; align-items:center; margin-bottom:5px;';
            const modeLabel = document.createElement('span');
            modeLabel.style.cssText = 'font-size:10px; color:#6b7280; margin-right:2px;';
            modeLabel.textContent = 'Missing credits:';
            modeRow.appendChild(modeLabel);
            for (const option of SPEND_MODES) {
                const active = option === mode;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'mwi-shrine-spend-mode-btn';
                button.dataset.mode = option;
                button.dataset.active = active ? 'yes' : 'no';
                button.textContent = SPEND_MODE_LABELS[option];
                button.style.cssText =
                    'padding:2px 8px; font-size:10px; cursor:pointer; border-radius:3px; ' +
                    'border:1px solid rgba(255,255,255,0.16); ' +
                    `background:${active ? 'rgba(196,181,253,0.18)' : 'transparent'}; ` +
                    `color:${active ? '#c4b5fd' : '#9ca3af'};`;
                button.title = {
                    auto: 'Cheapest way per colour — the recommendation.',
                    tokens: 'Exchange guild tokens for every colour that has a known rate, cheaper or not.',
                    gold: 'Buy every colour that has a priced conversion on the marketplace, cheaper or not.',
                }[option];
                button.addEventListener('click', () => {
                    if (spendMode() === option) return;
                    planState().spendMode = option;
                    savePlanSoon();
                    // Both halves, because both are drawn from the mode: the
                    // suggestions below and the still-needed box above
                    renderSuggestions();
                    recalculate();
                });
                modeRow.appendChild(button);
            }
            suggestBody.appendChild(modeRow);

            if (nextBuys.length === 0) {
                const none = document.createElement('div');
                none.style.cssText = 'color:#6b7280; text-align:center; font-size:11px;';
                none.textContent = 'Every buff is at its shrine cap';
                suggestBody.appendChild(none);
                return;
            }

            const creditBalances = {};
            for (const buy of nextBuys) {
                for (const { itemHrid } of buy.creditCosts || []) {
                    if (!(itemHrid in creditBalances)) creditBalances[itemHrid] = heldInInventory(inventory, itemHrid);
                }
            }

            // The market half of every comparison, built once: the same ranked
            // conversions the hand-off below buys from, so the path a row
            // recommends and the shopping list it produces are one decision.
            const topConversions = buildTopConversions(itemDetailMap, 1);
            const goldPerToken = goldPerTokenFor(itemDetailMap);
            // The same per-colour token covers the still-needed box honours —
            // the two settle the same shortfall and must route it the same way
            const covered = tokenCoveredCredits(planState());
            const decisions = {};
            const pathFor = (creditHrid) => {
                if (!(creditHrid in decisions))
                    decisions[creditHrid] = applySpendMode(
                        chooseCreditPath({
                            rate: tokenRateFor(creditHrid),
                            marketGoldPerCredit: (topConversions?.[creditHrid] || [])[0]?.askGPC ?? null,
                            goldPerToken,
                        }),
                        covered.has(creditHrid) ? 'tokens' : mode
                    );
                return decisions[creditHrid];
            };

            const plan = planNextBuys(nextBuys, {
                tokenBalance: balance,
                creditBalances,
                rateFor: tokenRateFor,
                pathFor,
            });

            const creditLabel = (itemHrid, short) => {
                const name = itemDetailMap[itemHrid]?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
                return short ? shortCreditName(name) : name;
            };
            const creditText = (itemHrid, n, short) => `${Number(n).toLocaleString()} ${creditLabel(itemHrid, short)}`;

            plan.rows.forEach((entry) => {
                const { buy, affordable } = entry;
                const row = document.createElement('div');
                row.className = 'mwi-shrine-next-buy';
                row.dataset.affordable = affordable ? 'yes' : 'no';
                row.style.cssText =
                    'display:flex; flex-wrap:wrap; align-items:baseline; column-gap:6px; padding:2px 0; ' +
                    'font-size:11px; width:100%; max-width:100%; box-sizing:border-box;';

                // One line, always: a shrine and buff name that wrapped turned
                // into a tall vertical stack down the left of the row
                const label = document.createElement('span');
                label.className = 'mwi-shrine-next-buy-label';
                label.style.cssText =
                    'flex:0 1 auto; min-width:0; max-width:62%; white-space:nowrap; overflow:hidden; ' +
                    `text-overflow:ellipsis; color:${affordable ? '#4ade80' : '#9ca3af'};`;
                label.textContent = `${affordable ? '✓ ' : ''}${buy.label} · ${buy.fromLevel}→${buy.toLevel}`;
                label.title = label.textContent;
                row.appendChild(label);

                const tok = document.createElement('span');
                tok.className = 'mwi-shrine-next-buy-tok';
                tok.style.cssText = `margin-left:auto; flex:0 0 auto; white-space:nowrap; color:${affordable ? '#e0e0e0' : '#6b7280'};`;
                tok.textContent = `${entry.effective.toLocaleString()} tok`;
                // "about" only where a captured reading is doing the converting:
                // a standard rate is exact, so hedging it would be a caveat about
                // nothing. The gold half is named too, so the token figure is not
                // mistaken for the whole bill.
                const hedged = entry.conversions.some((c) => describeRate(c.rate)?.approx);
                const parts = [`${entry.direct.toLocaleString()} tokens for the level`];
                if (entry.conversionTokens > 0)
                    parts.push(
                        `plus ${hedged ? 'about ' : ''}${entry.conversionTokens.toLocaleString()} to convert into the credits it is short`
                    );
                if (entry.marketGold > 0)
                    parts.push(`plus ≈${formatKMB(entry.marketGold)} gold of materials bought on the market`);
                tok.title = parts.join(', ');
                row.appendChild(tok);

                if (buy.creditCosts?.length) {
                    const credits = document.createElement('span');
                    credits.className = 'mwi-shrine-next-buy-credits';
                    // A whole line of its own, wrapping within it — this is the
                    // half that used to run off the right of the modal
                    credits.style.cssText =
                        'flex:1 1 100%; min-width:0; white-space:normal; overflow-wrap:anywhere; color:#6b7280;';
                    credits.textContent = `+ ${buy.creditCosts.map(({ itemHrid, count: n }) => creditText(itemHrid, n, true)).join(', ')}`;
                    credits.title = buy.creditCosts
                        .map(({ itemHrid, count: n }) => creditText(itemHrid, n, false))
                        .join(', ');
                    row.appendChild(credits);
                }

                if (entry.conversions.length > 0 || entry.market.length > 0 || entry.unknown.length > 0) {
                    const note = document.createElement('span');
                    note.className = 'mwi-shrine-next-buy-convert';
                    note.style.cssText =
                        'flex:1 1 100%; min-width:0; white-space:normal; overflow-wrap:anywhere; font-size:10px;';
                    const noteParts = [];
                    const titles = [];
                    if (entry.conversions.length > 0) {
                        const covered = entry.conversions
                            .map(({ itemHrid, gap }) => creditText(itemHrid, gap, true))
                            .join(', ');
                        noteParts.push(`convert ${entry.conversionTokens.toLocaleString()} tok → ${covered}`);
                        for (const { itemHrid, rate, decision } of entry.conversions) {
                            const described = describeRate(rate);
                            if (described) titles.push(described.title);
                            const why = describeDecision(creditLabel(itemHrid, true), decision);
                            if (why) titles.push(why);
                        }
                    }
                    if (entry.market.length > 0) {
                        const covered = entry.market
                            .map(({ itemHrid, gap }) => creditText(itemHrid, gap, true))
                            .join(', ');
                        noteParts.push(`buy ≈${formatKMB(entry.marketGold)} gold of mats → ${covered}`);
                        for (const { itemHrid, decision } of entry.market) {
                            const why = describeDecision(creditLabel(itemHrid, true), decision);
                            if (why) titles.push(why);
                        }
                    }
                    if (entry.unknown.length > 0) {
                        noteParts.push(
                            `${entry.unknown.map(({ itemHrid }) => creditLabel(itemHrid, true)).join(', ')}: ${NO_RATE_NOTE} — select Guild Token in this exchange once to record it`
                        );
                        titles.push(NO_RATE_TITLE);
                    }
                    note.textContent = noteParts.join(' · ');
                    note.title = titles.join(' ');
                    note.style.color = entry.unknown.length > 0 ? '#9ca3af' : '#c4b5fd';
                    row.appendChild(note);
                }

                suggestBody.appendChild(row);
            });

            const walk = document.createElement('div');
            walk.className = 'mwi-shrine-spend-all';
            walk.style.cssText =
                'margin-top:5px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1); font-size:11px; color:#9ca3af; white-space:normal; overflow-wrap:anywhere;';
            const converted =
                plan.conversionSpent > 0
                    ? `, ${plan.conversionSpent.toLocaleString()} of them converted into credits`
                    : '';
            // The gold half of the same walk. Named separately because it is a
            // different pocket: the token figure is what the balance covers, this
            // is what the marketplace charges on top.
            const bought = plan.marketSpent > 0 ? ` plus ≈${formatKMB(plan.marketSpent)} gold of mats` : '';
            walk.textContent =
                plan.count === 0
                    ? `Nothing on this list is affordable with ${balance.toLocaleString()} tokens`
                    : `Spending everything now: ${plan.count} of ${plan.rows.length} next levels for ${plan.spent.toLocaleString()} tokens${converted}${bought}`;
            suggestBody.appendChild(walk);

            renderNextBuyFlow(plan.owedCredits, plan.owedTokenCredits, itemDetailMap, inventory, suggestBody);
        }

        /**
         * The step after the suggestions: buy the credits these buys are short
         * of, then exchange them.
         *
         * Scoped to the affordable (✓) set, because that is the list the player
         * can act on this minute — the rest of the list is a wish, and a
         * marketplace tab for a level no amount of shopping unlocks is noise.
         * The credits it covers are the ones the ✓ walk found short after the
         * inventory was netted off and the earlier buys had taken their share.
         *
         * Scoped, too, to the colours the recommendation actually sends to the
         * marketplace. A colour the guild shop supplies more cheaply has no
         * materials to go and buy — it has an exchange to make — so it is listed
         * as one instead of turned into a shopping trip that costs more than the
         * tokens it saves.
         *
         * Three parts, all from the same decision so they cannot disagree: the
         * marketplace hand-off for the raw materials
         * ({@link creditShortfallMaterials}, inventory netted off), the exchange
         * that follows it ({@link creditConversionPlan}, whole trades), and the
         * token exchanges for the colours that went the other way
         * ({@link tokenConversionPlan}). The last two are guidance, not navigation
         * — this modal *is* the exchange, so there is nowhere to send the player.
         *
         * @param {Object<string, number>} owedCredits - creditHrid → credits the ✓ set buys on the market
         * @param {Object<string, number>} owedTokenCredits - creditHrid → credits it converts with tokens
         * @param {Object} itemDetailMap - The game's items
         * @param {Array<Object>} inventory - The character's items
         * @returns {void}
         */
        function renderNextBuyFlow(owedCredits, owedTokenCredits, itemDetailMap, inventory, host) {
            const topConversions = buildTopConversions(itemDetailMap, 1);
            const mats = creditShortfallMaterials(owedCredits, topConversions, inventory);
            const steps = creditConversionPlan(owedCredits, topConversions, itemDetailMap);
            const tokenSteps = tokenConversionPlan(owedTokenCredits, itemDetailMap);
            if (mats.length === 0 && steps.length === 0 && tokenSteps.length === 0) return;

            const flow = document.createElement('div');
            flow.className = 'mwi-shrine-next-buy-flow';
            flow.style.cssText = 'margin-top:6px;';

            if (mats.length > 0) {
                const button = document.createElement('button');
                button.className = 'mwi-shrine-next-buy-mats-btn';
                button.style.cssText = `
                    width:100%; box-sizing:border-box; padding:6px 10px;
                    background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
                    color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
                    cursor:pointer; font-size:11px; font-weight:600;
                `;
                button.textContent = 'Missing Mats Marketplace';
                button.title = 'The raw materials the affordable buys above are short of, at the cheapest conversion';
                button.addEventListener('mouseenter', () => {
                    button.style.background =
                        'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
                });
                button.addEventListener('mouseleave', () => {
                    button.style.background =
                        'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
                });
                button.addEventListener('click', () => openShoppingList(mats, { heading: 'Next buys' }));
                flow.appendChild(button);
            }

            if (steps.length > 0 || tokenSteps.length > 0) {
                const title = document.createElement('div');
                title.style.cssText = 'margin-top:5px; font-size:10px; color:#9ca3af;';
                title.textContent = 'then convert:';
                flow.appendChild(title);

                for (const step of tokenSteps) {
                    const described = describeRate(step.rate);
                    const line = document.createElement('div');
                    line.className = 'mwi-shrine-token-convert-step';
                    line.dataset.creditHrid = step.creditItemHrid;
                    line.style.cssText =
                        'font-size:10px; color:#c4b5fd; white-space:normal; overflow-wrap:anywhere; padding:1px 0;';
                    line.textContent = `convert ${step.tokens.toLocaleString()} tok → ${step.credits.toLocaleString()} ${shortCreditName(step.creditName)}`;
                    line.title = [
                        `${step.tokens.toLocaleString()} guild tokens exchange here for ${step.credits.toLocaleString()} ${step.creditName} — the ${step.owed.toLocaleString()} still owed, rounded up to whole exchanges. Cheaper than buying its materials.`,
                        described?.title,
                    ]
                        .filter(Boolean)
                        .join(' ');
                    flow.appendChild(line);
                }

                for (const step of steps) {
                    const line = document.createElement('div');
                    line.className = 'mwi-shrine-convert-step';
                    line.dataset.creditHrid = step.creditItemHrid;
                    line.style.cssText =
                        'font-size:10px; color:#c4b5fd; white-space:normal; overflow-wrap:anywhere; padding:1px 0;';
                    line.textContent = `convert ${step.itemCount.toLocaleString()}× ${step.itemName} → ${step.creditCount.toLocaleString()} ${shortCreditName(step.creditName)}`;
                    line.title = `${step.itemCount.toLocaleString()} ${step.itemName} exchanges here for ${step.creditCount.toLocaleString()} ${step.creditName} — the ${step.owed.toLocaleString()} still owed, rounded up to whole exchanges`;
                    flow.appendChild(line);
                }
            }

            host.appendChild(flow);
        }

        /**
         * Put the saved plan back into the inputs.
         *
         * Two things are pruned rather than restored, so the record does not
         * accumulate cruft as levels rise: a target at or below the buff's
         * current level (already met — a no-op), and a target above what the
         * input now accepts is clamped to the cap (the shrine may have been
         * upgraded, or its `levelCosts` table changed, since the plan was made).
         */
        const restorePlan = () => {
            const plan = planState();
            const targets = plan.targets;
            let pruned = false;
            for (const { buffHrid, currentLevel, capLevel, inputEl } of planInputs) {
                const saved = Number(targets[buffHrid]);
                if (!Number.isFinite(saved)) continue;
                if (saved <= currentLevel) {
                    delete targets[buffHrid];
                    pruned = true;
                    continue;
                }
                const clamped = Math.min(saved, capLevel);
                inputEl.value = String(clamped);
                if (clamped !== saved) {
                    targets[buffHrid] = clamped;
                    pruned = true;
                }
            }
            applyCollapsed(plan.collapsed !== false);
            recalculate();
            if (pruned) this._savePlanSoon();
        };

        restorePlan();
        renderSuggestions();

        // A modal opened before the record's initial read landed shows the
        // defaults; when the read finishes, the inputs it belongs in are filled.
        //
        // Both halves, like the spend-mode buttons and the token covers: the
        // plan carries the spend mode and the per-colour covers, and
        // `restorePlan` only redraws the still-needed box. Redrawing that alone
        // left the suggestions still routing a colour the box above them had
        // just been told to settle the other way.
        if (!shrinePlanRecord.isLoaded()) {
            (async () => {
                const readable = await shrinePlanRecord.load();
                if (!readable || !wrapper.isConnected) return;
                restorePlan();
                renderSuggestions();
            })();
        }

        // Insert after the advisor (or after the ranking table if no advisor)
        const advisorEl = modalEl.querySelector('.mwi-exchange-advisor');
        const rankingEl = modalEl.querySelector(`.${CSS_CLASS}`);
        const insertAfter = advisorEl || rankingEl;
        insertAfter?.insertAdjacentElement('afterend', wrapper);

        // Both halves are redrawn together, because both are drawn from the
        // inventory: the still-needed box (owed rows, shopping list, conversion
        // steps) and the suggestions (token balance, ✓ walk, its own flow)
        this._armPlannerObservers(wrapper, () => {
            recalculate();
            renderSuggestions();
        });
    }

    /**
     * A Max button beside the exchange's "You give" input.
     *
     * The game caps the give amount at what is held, but typing the figure in
     * means reading it off the label and getting the multiple right. The button
     * fills in the largest amount the held stock covers, floored to a whole
     * number of exchanges so the game accepts it as-is.
     *
     * @param {Element} modalEl - The exchange modal
     * @param {Element|null} giveInput - The "You give" input
     * @param {Array<Object>} rows - Conversion rows from the table render
     * @param {{selectedItemHrid: string|null, selectedItemName: string|null}} selected - The chosen item
     * @private
     */
    _injectExchangeMaxButton(modalEl, giveInput, rows, { selectedItemHrid, selectedItemName }) {
        modalEl.querySelectorAll('.mwi-exchange-max').forEach((el) => el.remove());
        if (!giveInput) return;

        const row = selectedItemHrid
            ? rows.find((r) => r.hrid === selectedItemHrid)
            : rows.find((r) => r.name === selectedItemName);
        if (!row?.hrid) return;

        const held = heldInInventory(dataManager.getInventory?.() || [], row.hrid);
        const per = Math.max(1, row.itemCount || 1);
        const max = Math.floor(held / per) * per;
        if (max <= 0) return;

        const button = document.createElement('button');
        button.className = 'mwi-exchange-max';
        button.textContent = 'Max';
        button.title = `Give ${formatWithSeparator(max)} — everything held, in whole exchanges of ${per}.`;
        button.style.cssText =
            'margin-left:6px; padding:2px 8px; border-radius:4px; font-size:11px; cursor:pointer; ' +
            'background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.2); color:#e8ecf5; ' +
            'vertical-align:middle;';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setReactInputValue(giveInput, String(max));
        });
        giveInput.insertAdjacentElement('afterend', button);
    }

    _renderExchangeAdvisor(modalEl, creditHrid, rows) {
        modalEl.querySelectorAll('.mwi-exchange-advisor').forEach((el) => el.remove());

        // The source item is inside ItemSelector_itemContainer. Its identity comes from
        // the icon's <use> sprite reference (locale independent); the SVG's aria-label
        // is the translated display name and only backs it up.
        const selectorContainer = modalEl.querySelector('[class*="ItemSelector_itemContainer"]');
        const selectedItemHrid = itemHridFromIcon(selectorContainer, dataManager.getInitClientData()?.itemDetailMap);
        const itemSvg = selectorContainer?.querySelector('svg[aria-label]');
        const selectedItemName = itemSvg?.getAttribute('aria-label') || null;

        // The "You give" field holds a raw item count, not a count of whole
        // exchanges — confirmed by the Max button, which fills it with
        // `held` floored to a multiple of `itemCount` rather than with a
        // batch number. Both input types: the marketplace's inputs moved to
        // type="text" in a game update, and this dialog may follow.
        const quantityInput = modalEl.querySelector('input[type="number"], input[type="text"]');
        const rawQuantity = Math.max(1, parseInt(quantityInput?.value || '1', 10) || 1);

        this._injectExchangeMaxButton(modalEl, quantityInput, rows, { selectedItemHrid, selectedItemName });

        // Find best and selected rows (rows are pre-built from _render)
        const validRows = rows.filter((r) => r.sellGPC !== null || r.buyGPC !== null);
        if (validRows.length === 0) return;

        const bestRow = [...validRows].sort((a, b) => {
            const aVal = a.sellGPC ?? Infinity;
            const bVal = b.sellGPC ?? Infinity;
            return aVal - bVal;
        })[0];

        const advisor = document.createElement('div');
        advisor.className = 'mwi-exchange-advisor';
        advisor.style.cssText = `
            margin-top:8px; padding:8px 10px; border-radius:6px; font-size:12px;
            border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);
        `;

        if (!selectedItemHrid && !selectedItemName) {
            // No item selected yet
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Select an item to see exchange advice</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        const selectedRow = selectedItemHrid
            ? validRows.find((r) => r.hrid === selectedItemHrid)
            : validRows.find((r) => r.name === selectedItemName);

        if (!selectedRow) {
            // Item in modal has no conversion for this credit type
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Selected item has no conversion for this credit</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        if (selectedRow === bestRow) {
            advisor.style.borderColor = 'rgba(74,222,128,0.4)';
            advisor.innerHTML = `<div style="color:#4ade80; font-weight:600; text-align:center;">✓ Optimal choice for this credit type</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        // Calculate sell → rebuy scenario
        const SELLER_TAX = MARKET_TAX;
        const sellPrice = selectedRow.buyPrice; // bid price = what market will buy at
        // The exchange only ever redeems whole conversions — a typed quantity
        // that is not a multiple of `itemCount` still floors to the last one
        // the game would actually honour.
        const perExchange = Math.max(1, selectedRow.itemCount || 1);
        const directCredits = Math.floor(rawQuantity / perExchange) * selectedRow.creditCount;

        if (!sellPrice || sellPrice <= 0 || !bestRow.sellPrice || bestRow.sellPrice <= 0) {
            advisor.innerHTML = `<div style="color:#6b7280; text-align:center;">Best: <b style="color:#e0e0e0;">${bestRow.name}</b> — no price data for comparison</div>`;
            modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
            return;
        }

        // Both legs are batch-sized, so both are walked against the book rather
        // than multiplied by the top of it: the Max button fills this field with
        // everything held, and a thousand units quoted at the best bid is a
        // number the book cannot honour. Where no book has been seen the top of
        // book is still all there is — the figures then say so.
        const sale = quoteSaleAgainstBook(selectedRow.hrid, rawQuantity, sellPrice);
        const gross = sale.gold;
        const tax = Math.floor(gross * SELLER_TAX);
        const net = gross - tax;

        // How many batches of the best item can we buy with net proceeds?
        const bestBatchCost = bestRow.itemCount * bestRow.sellPrice;
        const purchase = quotePurchaseAgainstBook(bestRow.hrid, net, bestRow.sellPrice);
        const bestBatches = Math.floor(
            purchase.units === null ? net / bestBatchCost : purchase.units / Math.max(1, bestRow.itemCount || 1)
        );
        const bestCredits = bestBatches * bestRow.creditCount;
        const creditDiff = bestCredits - directCredits;
        // A leg the book could not answer in full makes the comparison a bound,
        // not a quote. The rows are still shown — they are what the visible book
        // says — but the verdict line refuses to rank on them.
        const bookNote = describeBookShortfall(sale, purchase, selectedRow, bestRow, rawQuantity);

        const diffColor = creditDiff > 0 ? '#4ade80' : '#ff6b6b';
        const diffSign = creditDiff > 0 ? '+' : '';
        const diffLabel = creditDiff > 0 ? '↑ better' : '↓ worse';

        advisor.style.borderColor = bookNote
            ? 'rgba(255,255,255,0.15)'
            : creditDiff > 0
              ? 'rgba(74,222,128,0.3)'
              : 'rgba(255,107,107,0.3)';
        advisor.innerHTML = `
            <div style="color:#9ca3af; margin-bottom:6px; font-size:11px;">Sell → rebuy best item (${Math.round(MARKET_TAX * 100)}% tax)${
                sale.source === 'top' || purchase.source === 'top' ? ', top of book' : ', order book depth'
            }</div>
            <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                <span style="color:#aaa;">Direct exchange</span>
                <span style="color:#e0e0e0; font-weight:600;">${directCredits.toLocaleString()} credits</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
                <span style="color:#aaa;">Sell proceeds (after tax)</span>
                <span style="color:#e0e0e0;">${formatKMB(net)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <span style="color:#aaa;">Buy <b style="color:#e0e0e0;">${bestRow.name}</b> → credits</span>
                <span style="color:#e0e0e0; font-weight:600;">${bestCredits.toLocaleString()} credits</span>
            </div>
            <div style="display:flex; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.1); padding-top:6px;">
                <span style="color:#aaa;">Difference</span>
                ${
                    bookNote
                        ? `<span style="color:#9ca3af; font-weight:600;">not comparable</span>`
                        : `<span style="color:${diffColor}; font-weight:700;">${diffSign}${creditDiff.toLocaleString()} credits ${diffLabel}</span>`
                }
            </div>
            ${bookNote ? `<div style="color:#9ca3af; font-size:11px; margin-top:6px;">${bookNote}</div>` : ''}
        `;

        modalEl.querySelector(`.${CSS_CLASS}`)?.insertAdjacentElement('afterend', advisor);
    }

    _renderTrialSignup(modalEl) {
        modalEl.querySelectorAll('.mwi-trial-copy-btn').forEach((el) => el.remove());

        const memberList = modalEl.querySelector('[class*="GuildPanel_memberList"]');
        if (!memberList) return;

        const buttonsContainer = modalEl.querySelector('[class*="GuildPanel_buttonsContainer"]');
        if (!buttonsContainer) return;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'mwi-trial-copy-btn';
        copyBtn.style.cssText = `
            width:100%; padding:8px 12px; margin-bottom:6px;
            background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
            color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
            cursor:pointer; font-size:12px; font-weight:600;
        `;
        copyBtn.textContent = 'Copy List';
        copyBtn.addEventListener('mouseenter', () => {
            copyBtn.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
        });
        copyBtn.addEventListener('mouseleave', () => {
            copyBtn.style.background = 'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
        });
        copyBtn.addEventListener('click', () => {
            const names = Array.from(memberList.querySelectorAll('[class*="GuildPanel_memberName"]'))
                .map((el) => el.textContent.trim())
                .filter(Boolean)
                .join('\n');
            if (!names) return;
            navigator.clipboard.writeText(names).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy List';
                }, 1500);
            });
        });

        buttonsContainer.insertAdjacentElement('beforebegin', copyBtn);
    }

    /**
     * A cheap signature of everything `_renderShrine` computes from: the costs
     * the modal is currently stating, and the holdings those costs are measured
     * against.
     *
     * Used as the loop guard for the re-render triggers. Only the item hrids the
     * last render actually depended on are read — the required materials and the
     * conversion items behind the credit rows — so an unrelated inventory change
     * is not mistaken for a reason to redraw.
     *
     * @param {Element} modalEl - The shrine modal content
     * @returns {string|null} The signature, or null when the modal has no cost area
     * @private
     */
    _shrineSignatureOf(modalEl) {
        const requirements = modalEl.querySelector?.('[class*="GuildPanel_itemRequirements"]');
        if (!requirements) return null;

        const containers = Array.from(requirements.querySelectorAll('[class*="Item_itemContainer"]'));
        const counts = Array.from(requirements.querySelectorAll('[class*="GuildPanel_inputCount"]'));
        const costs = containers
            .map((container, i) => {
                const sprite = container.querySelector('use')?.getAttribute('href')?.split('#')[1] || '?';
                return `${sprite}:${(counts[i]?.textContent || '').trim()}`;
            })
            .join('|');

        const watched = this._shrineWatchedHrids;
        if (!watched?.size) return `${costs}#`;

        const owned = new Map();
        for (const inv of dataManager.getInventory() || []) {
            if (inv.itemLocationHrid !== '/item_locations/inventory') continue;
            if (!watched.has(inv.itemHrid)) continue;
            owned.set(inv.itemHrid, (owned.get(inv.itemHrid) || 0) + (inv.count || 0));
        }
        const holdings = [...watched]
            .sort()
            .map((hrid) => `${hrid}:${owned.get(hrid) || 0}`)
            .join('|');
        return `${costs}#${holdings}`;
    }

    /**
     * Re-render the shrine block, but only when its inputs actually moved.
     *
     * The observers below watch the very modal this feature injects into, so an
     * unguarded re-render would feed itself. The signature comparison is what
     * makes the loop impossible: a redraw that changes no cost and no holding
     * produces the same signature and stops here.
     *
     * @param {Element} modalEl - The shrine modal content
     * @private
     */
    _renderShrineIfChanged(modalEl) {
        if (!modalEl?.isConnected) {
            this._disconnectShrineObservers();
            return;
        }
        const signature = this._shrineSignatureOf(modalEl);
        if (signature !== null && signature === this._shrineSignature) return;
        this._renderShrine(modalEl);
    }

    /** Coalesce a burst of mutations into one re-render, as the advisor does */
    _scheduleShrineRerender(modalEl) {
        if (this._shrineTimer) clearTimeout(this._shrineTimer);
        this._shrineTimer = setTimeout(() => {
            this._shrineTimer = null;
            this._renderShrineIfChanged(modalEl);
        }, SHRINE_RERENDER_DEBOUNCE_MS);
    }

    /**
     * Keep the injected block current for as long as the modal is open.
     *
     * Two things move under it. The game rewrites the requirement rows in place
     * after an upgrade — the next level's costs, which the first render knew
     * nothing about — and the upgrade's own deduction lands separately as an
     * `items_updated`. Watching only one of them is what left the maintainer
     * looking at a red "144K / 156K Blue Guild Credit" with no Missing Mats
     * button under it: the block had been computed while the holdings were still
     * enough, and nothing recomputed it.
     *
     * One set of observers at a time, released with the feature — the exchange
     * advisor's rule, for the same reason (a modal opened a few times used to
     * leave each one's observer behind).
     *
     * @param {Element} modalEl - The shrine modal content
     * @private
     */
    _armShrineObservers(modalEl) {
        this._disconnectShrineObservers();

        const requirements = modalEl.querySelector('[class*="GuildPanel_itemRequirements"]');
        if (requirements) {
            this._shrineObserver = new MutationObserver(() => this._scheduleShrineRerender(modalEl));
            this._shrineObserver.observe(requirements, {
                subtree: true,
                childList: true,
                characterData: true,
            });
        }

        this._shrineItemsHandler = () => this._scheduleShrineRerender(modalEl);
        dataManager.on('items_updated', this._shrineItemsHandler);
    }

    /** Release the shrine block's re-render triggers and any pending redraw */
    _disconnectShrineObservers() {
        this._shrineObserver?.disconnect();
        this._shrineObserver = null;
        if (this._shrineTimer) {
            clearTimeout(this._shrineTimer);
            this._shrineTimer = null;
        }
        if (this._shrineItemsHandler) {
            dataManager.off('items_updated', this._shrineItemsHandler);
            this._shrineItemsHandler = null;
        }
    }

    _renderShrine(modalEl) {
        if (!config.getSetting('guildCreditValue', true)) return;

        // Any previously armed triggers belong to the render being replaced; the
        // fresh ones go on at the end, once there is something to keep current.
        this._disconnectShrineObservers();
        this._shrineWatchedHrids = null;
        this._shrineSignature = null;

        modalEl.querySelectorAll('.mwi-shrine-cost').forEach((el) => el.remove());

        const requirements = modalEl.querySelector('[class*="GuildPanel_itemRequirements"]');
        if (!requirements) return;

        const upgradeBtn = modalEl.querySelector('button');
        if (!upgradeBtn) return;

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        const topConversions = buildTopConversions(gameData.itemDetailMap, 3);
        // Still need cheapest sell/buy for the credit row's own cost columns
        const { sell: cheapestSell, buy: cheapestBuy } = buildCheapestPerCredit(gameData.itemDetailMap);

        const itemContainers = Array.from(requirements.querySelectorAll('[class*="Item_itemContainer"]'));
        const inputCounts = Array.from(requirements.querySelectorAll('[class*="GuildPanel_inputCount"]'));
        if (itemContainers.length === 0) return;

        const inventory = dataManager.getInventory();
        const rows = [];
        let totalSell = 0;
        let totalBuy = 0;
        let allSellPriced = true;
        let allBuyPriced = true;

        itemContainers.forEach((container, i) => {
            const use = container.querySelector('use');
            const spriteId = use?.getAttribute('href')?.split('#')[1];
            if (!spriteId) return;

            const itemHrid = `/items/${spriteId}`;
            const required = parseInt(inputCounts[i]?.textContent?.replace(/[^0-9]/g, '') || '', 10) || 0;
            const owned = inventory
                .filter((inv) => inv.itemHrid === itemHrid && inv.itemLocationHrid === '/item_locations/inventory')
                .reduce((sum, inv) => sum + (inv.count || 0), 0);
            const effectiveRequired = Math.max(0, required - owned);
            const itemName = gameData.itemDetailMap?.[itemHrid]?.name || spriteId.replace(/_/g, ' ');
            const isToken = itemHrid.includes('guild_token');
            const isCredit = itemHrid.includes('guild_credit');

            let sellEach = getItemPrice(itemHrid, { mode: 'ask' });
            let buyEach = getItemPrice(itemHrid, { mode: 'bid' });

            if (isCredit) {
                if (!sellEach || sellEach <= 0) sellEach = cheapestSell[itemHrid] || null;
                if (!buyEach || buyEach <= 0) buyEach = cheapestBuy[itemHrid] || null;
            }

            let sellSub = sellEach && effectiveRequired ? sellEach * effectiveRequired : null;
            let buySub = buyEach && effectiveRequired ? buyEach * effectiveRequired : null;

            if (isCredit && effectiveRequired > 0) {
                const creditOptions = topConversions[itemHrid] || [];
                const askTop = creditOptions.find((o) => o.askGPC !== null);
                const bidTop = [...creditOptions].sort((a, b) => {
                    if (a.bidGPC === null) return 1;
                    if (b.bidGPC === null) return -1;
                    return a.bidGPC - b.bidGPC;
                })[0];
                sellSub = askTop?.askPrice
                    ? Math.ceil(effectiveRequired / askTop.creditCount) * askTop.itemCount * askTop.askPrice
                    : null;
                buySub = bidTop?.bidPrice
                    ? Math.ceil(effectiveRequired / bidTop.creditCount) * bidTop.itemCount * bidTop.bidPrice
                    : null;
            }

            if (sellSub !== null) totalSell += sellSub;
            else if (!isToken && effectiveRequired > 0) allSellPriced = false;

            if (buySub !== null) totalBuy += buySub;
            else if (!isToken && effectiveRequired > 0) allBuyPriced = false;

            rows.push({
                itemHrid,
                itemName,
                required,
                effectiveRequired,
                owned,
                sellEach,
                buyEach,
                sellSub,
                buySub,
                isCredit,
                creditHrid: isCredit ? itemHrid : null,
            });
        });

        if (rows.length === 0) return;

        let sortKey = 'ask';

        const buildTbody = () => {
            const tbody = document.createElement('tbody');
            rows.forEach((row) => {
                const tr = document.createElement('tr');
                tr.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05); color:#e0e0e0;';
                tr.innerHTML = `
                    <td style="padding:4px 6px; text-align:left;">${row.itemName}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.effectiveRequired.toLocaleString()}${row.owned > 0 ? ` <span style="color:#6b7280;font-size:10px;">(own ${row.owned.toLocaleString()})</span>` : ''}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.sellEach ? formatKMB(row.sellEach) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buyEach ? formatKMB(row.buyEach) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right;">${row.sellSub ? formatKMB(row.sellSub) : '–'}</td>
                    <td style="padding:4px 6px; text-align:right; color:#9ca3af;">${row.buySub ? formatKMB(row.buySub) : '–'}</td>
                `;
                tbody.appendChild(tr);

                if (row.isCredit && row.creditHrid) {
                    const options = [...(topConversions[row.creditHrid] || [])];
                    options.sort((a, b) => {
                        const aVal = sortKey === 'bid' ? a.bidGPC : a.askGPC;
                        const bVal = sortKey === 'bid' ? b.bidGPC : b.askGPC;
                        if (aVal === null && bVal === null) return 0;
                        if (aVal === null) return 1;
                        if (bVal === null) return -1;
                        return aVal - bVal;
                    });
                    options.forEach((opt, idx) => {
                        const qtyNeeded = Math.ceil(row.effectiveRequired / opt.creditCount) * opt.itemCount;
                        const askTotal = opt.askPrice ? opt.askPrice * qtyNeeded : null;
                        const bidTotal = opt.bidPrice ? opt.bidPrice * qtyNeeded : null;
                        const isTop = idx === 0;
                        const nameColor = isTop ? '#4ade80' : '#9ca3af';
                        const rankPrefix = `↳ #${idx + 1}`;
                        const subTr = document.createElement('tr');
                        subTr.style.cssText = `border-bottom:1px solid rgba(255,255,255,0.03); font-size:11px;`;
                        const askStyle = `color:${sortKey === 'bid' ? '#6b7280' : isTop ? '#4ade80' : '#9ca3af'}; font-weight:${sortKey === 'ask' && isTop ? '600' : '400'};`;
                        const bidStyle = `color:${sortKey === 'ask' ? '#6b7280' : isTop ? '#4ade80' : '#9ca3af'}; font-weight:${sortKey === 'bid' && isTop ? '600' : '400'};`;
                        subTr.innerHTML = `
                            <td style="padding:2px 6px 2px 16px; text-align:left; color:${nameColor};">${rankPrefix} ${opt.name}</td>
                            <td style="padding:2px 6px; text-align:right; color:${nameColor};">${qtyNeeded.toLocaleString()}</td>
                            <td style="padding:2px 6px; text-align:right; color:#6b7280;">${opt.askPrice ? formatKMB(opt.askPrice) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; color:#6b7280;">${opt.bidPrice ? formatKMB(opt.bidPrice) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; ${askStyle}">${askTotal ? formatKMB(askTotal) : '–'}</td>
                            <td style="padding:2px 6px; text-align:right; ${bidStyle}">${bidTotal ? formatKMB(bidTotal) : '–'}</td>
                        `;
                        tbody.appendChild(subTr);
                    });
                }
            });

            const totalRow = document.createElement('tr');
            totalRow.style.cssText = 'border-top:1px solid rgba(255,255,255,0.2); color:#4ade80; font-weight:700;';
            totalRow.innerHTML = `
                <td style="padding:5px 6px;" colspan="4">Total</td>
                <td style="padding:5px 6px; text-align:right;">${totalSell > 0 ? formatKMB(totalSell) : '–'}${!allSellPriced ? '*' : ''}</td>
                <td style="padding:5px 6px; text-align:right;">${totalBuy > 0 ? formatKMB(totalBuy) : '–'}${!allBuyPriced ? '*' : ''}</td>
            `;
            tbody.appendChild(totalRow);
            return tbody;
        };

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-shrine-cost';
        wrapper.style.cssText = 'margin-top:12px; font-size:12px; width:100%;';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px; color:#9ca3af; margin-bottom:6px; text-align:center;';
        hdr.textContent = 'Gold cost of upgrade — click to sort';
        wrapper.appendChild(hdr);

        const table = document.createElement('table');
        table.style.cssText = 'width:100%; border-collapse:collapse;';

        const thead = document.createElement('thead');
        const thRow = document.createElement('tr');
        thRow.style.cssText = 'font-size:11px; border-bottom:1px solid rgba(255,255,255,0.1);';

        [
            { text: 'Item', align: 'left' },
            { text: 'Qty', align: 'right' },
            { text: 'Ask ea.', align: 'right' },
            { text: 'Bid ea.', align: 'right' },
        ].forEach(({ text, align }) => {
            const th = document.createElement('th');
            th.style.cssText = `text-align:${align}; padding:3px 6px; font-weight:500; color:#6b7280;`;
            th.textContent = text;
            thRow.appendChild(th);
        });

        const askTh = document.createElement('th');
        askTh.textContent = 'Ask cost';
        const bidTh = document.createElement('th');
        bidTh.textContent = 'Bid cost';
        thRow.appendChild(askTh);
        thRow.appendChild(bidTh);
        thead.appendChild(thRow);
        table.appendChild(thead);

        const updateThStyles = () => {
            const isAsk = sortKey === 'ask';
            const active = 'font-weight:600; color:#e0e0e0; text-decoration:underline;';
            const inactive = 'font-weight:500; color:#6b7280;';
            askTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${isAsk ? active : inactive}`;
            bidTh.style.cssText = `text-align:right; padding:3px 6px; cursor:pointer; ${!isAsk ? active : inactive}`;
        };
        updateThStyles();

        let currentTbody = buildTbody();
        table.appendChild(currentTbody);

        const setSort = (key) => {
            sortKey = key;
            updateThStyles();
            const newTbody = buildTbody();
            table.replaceChild(newTbody, currentTbody);
            currentTbody = newTbody;
        };

        askTh.addEventListener('click', () => setSort('ask'));
        bidTh.addEventListener('click', () => setSort('bid'));

        wrapper.appendChild(table);

        if (!allSellPriced || !allBuyPriced) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:10px; color:#6b7280; margin-top:4px; text-align:center;';
            note.textContent = '* some items have no market price data';
            wrapper.appendChild(note);
        }

        // Build missing mats list from top-1 conversion per credit row
        const missingMats = [];
        for (const row of rows) {
            if (!row.isCredit || !row.creditHrid) continue;
            const top = (topConversions[row.creditHrid] || [])[0];
            if (!top?.hrid) continue;
            const qtyNeeded = Math.ceil(row.effectiveRequired / top.creditCount) * top.itemCount;
            const have = inventory
                .filter((i) => i.itemHrid === top.hrid && i.itemLocationHrid === '/item_locations/inventory')
                .reduce((sum, i) => sum + (i.count || 0), 0);
            const missing = Math.max(0, qtyNeeded - have);
            if (missing > 0) {
                missingMats.push({
                    itemHrid: top.hrid,
                    itemName: top.name,
                    missing,
                    required: qtyNeeded,
                    isTradeable: true,
                });
            }
        }

        if (missingMats.length > 0) {
            const missingBtn = document.createElement('button');
            missingBtn.style.cssText = `
                width:100%; padding:8px 12px; margin-top:8px;
                background:linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%);
                color:#fff; border:1px solid rgba(91,141,239,0.4); border-radius:6px;
                cursor:pointer; font-size:12px; font-weight:600;
            `;
            missingBtn.textContent = 'Missing Mats Marketplace';
            missingBtn.addEventListener('mouseenter', () => {
                missingBtn.style.background =
                    'linear-gradient(180deg,rgba(91,141,239,0.35) 0%,rgba(91,141,239,0.25) 100%)';
            });
            missingBtn.addEventListener('mouseleave', () => {
                missingBtn.style.background =
                    'linear-gradient(180deg,rgba(91,141,239,0.2) 0%,rgba(91,141,239,0.1) 100%)';
            });
            missingBtn.addEventListener('click', async () => {
                // Captured before the poll below: a character switch mid-poll
                // bumps this in `cleanup()`, and the check right after the poll
                // is what stops the departed character's mats from becoming
                // tabs in the arriving character's marketplace.
                const switchGeneration = this._switchGeneration;

                navigateToMarketplace(missingMats[0].itemHrid, 0);

                // Tear down any previous shrine tab listener before creating new tabs
                if (this._shrineTabCleanup) {
                    this._shrineTabCleanup();
                    this._shrineTabCleanup = null;
                }

                // Wait for the marketplace tablist to render
                let tabsContainer = null;
                let referenceTab = null;
                for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    tabsContainer = visibleTabsContainer();
                    referenceTab = tabsContainer
                        ? Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'))
                        : null;
                    if (referenceTab) break;
                }
                if (!referenceTab) return;
                // The feature was torn down (or re-initialized for a different
                // character) while this poll was running — the mats and the
                // container it just found both belong to a character this
                // click handler is no longer speaking for.
                if (switchGeneration !== this._switchGeneration) return;

                // Allow tabs to wrap and make the scroller visible
                const scroller = tabsContainer.closest('[class*="MuiTabs-scroller"]');
                const muiRoot = scroller?.closest('[class*="MuiTabs-root"]');
                tabsContainer.style.flexWrap = 'wrap';
                if (scroller) scroller.style.overflow = 'visible';
                if (muiRoot) muiRoot.style.height = 'auto';

                // Remove any existing action tabs and shrine tabs before inserting new ones
                removeMaterialTabs();
                removeShrineMarketTabs();

                for (const mat of missingMats) {
                    let tabEl = null;
                    const tab = createMaterialTab(mat, referenceTab, (_e, m) => {
                        // Armed for this tab's item. These tabs outlive the
                        // marketplace deliberately (see the opt-out below) and
                        // nothing here clears the arming, so without the item
                        // an armed count went on filling every later buy box.
                        this.autofillManager.setPendingCalculation(
                            () => parseInt(tabEl?.getAttribute('data-missing-quantity') || '0', 10),
                            { itemHrid: m.itemHrid }
                        );
                        navigateToMarketplace(m.itemHrid, 0);
                    });
                    // Opt out of global removeMaterialTabs() cleanup so tabs survive tab-to-tab navigation
                    tab.removeAttribute('data-mwi-custom-tab');
                    tab.setAttribute('data-mwi-shrine-tab', 'true');
                    tab.setAttribute('data-required-quantity', mat.required.toString());
                    tab.setAttribute('data-item-name', mat.itemName);
                    tabEl = tab;
                    tabsContainer.appendChild(tab);
                }

                // One click, every shrine tab gone (they opt out of the shared
                // `removeMaterialTabs()` above, so this control's own internal
                // call to it only removes itself — the shrine sweep is explicit)
                const clearAllControl = createClearAllTabsControl(referenceTab, () => {
                    removeShrineMarketTabs();
                    if (this._shrineTabCleanup) {
                        this._shrineTabCleanup();
                        this._shrineTabCleanup = null;
                    }
                    this.autofillManager.clearQuantity();
                    navigateToMarketListingsTab();
                });
                tabsContainer.appendChild(clearAllControl);

                // Watch for inventory/market changes and update shrine tabs accordingly
                const shrineTabs = Array.from(document.querySelectorAll('[data-mwi-shrine-tab="true"]'));
                const inventoryUpdateHandler = (message) => {
                    const msgType = message?.type || '';
                    if (
                        !msgType.includes('item') &&
                        !msgType.includes('inventory') &&
                        !msgType.includes('market') &&
                        !message?.inventory &&
                        !message?.characterItems
                    )
                        return;

                    // One pass over the inventory for every tab, not one per tab
                    const haveByHrid = new Map();
                    for (const i of dataManager.getInventory() || []) {
                        if (i.itemLocationHrid !== '/item_locations/inventory') continue;
                        haveByHrid.set(i.itemHrid, (haveByHrid.get(i.itemHrid) || 0) + (i.count || 0));
                    }
                    let anyRemaining = false;

                    for (const tab of shrineTabs) {
                        if (!tab.isConnected) continue;
                        const itemHrid = tab.getAttribute('data-item-hrid');
                        const required = parseInt(tab.getAttribute('data-required-quantity') || '0', 10);
                        const itemName = tab.getAttribute('data-item-name') || '';
                        const have = haveByHrid.get(itemHrid) || 0;
                        const missing = Math.max(0, required - have);

                        if (missing === 0) {
                            tab.remove();
                        } else {
                            updateTabBadge(tab, { itemHrid, itemName, missing, required, isTradeable: true });
                            anyRemaining = true;
                        }
                    }

                    if (!anyRemaining) {
                        webSocketHook.off('*', inventoryUpdateHandler);
                        this._shrineTabCleanup = null;
                    }
                };

                webSocketHook.on('*', inventoryUpdateHandler);
                this._shrineTabCleanup = () => webSocketHook.off('*', inventoryUpdateHandler);
            });
            wrapper.appendChild(missingBtn);
        }

        upgradeBtn.insertAdjacentElement('afterend', wrapper);

        // What this render depended on, recorded before the triggers go on: the
        // required materials, plus every conversion item a credit row was priced
        // through (the missing-mats list is built from those holdings).
        const watched = new Set(rows.map((row) => row.itemHrid).filter(Boolean));
        for (const row of rows) {
            if (!row.isCredit || !row.creditHrid) continue;
            for (const option of topConversions[row.creditHrid] || []) {
                if (option?.hrid) watched.add(option.hrid);
            }
        }
        this._shrineWatchedHrids = watched;
        this._shrineSignature = this._shrineSignatureOf(modalEl);
        this._armShrineObservers(modalEl);

        const levelEl = modalEl.querySelector('[class*="GuildPanel_level"]');
        if (!levelEl) return;

        // `upgradeBtn` is the game's own button and survives every re-render of
        // this block while the modal stays open — a requirement-row mutation, an
        // `items_updated` tick — so re-adding this listener on every
        // `_renderShrine` call stacked one `{once: true}` handler per render onto
        // the same node. A single click then fired all of them, each arming its
        // own `MutationObserver` on the same level line and each calling
        // `_renderShrine` once the level changed. The flag lives on the button
        // itself, the same way `guild-xp-display.js` tags a table element with
        // `_mwiTabObserver` to guard against a re-registration.
        if (!upgradeBtn._mwiShrineClickArmed) {
            upgradeBtn._mwiShrineClickArmed = true;
            upgradeBtn.addEventListener(
                'click',
                () => {
                    // Re-render on the next click cycles back through here and
                    // arms it again — this only stands the render being drawn
                    // now down from re-arming a second time before that click
                    upgradeBtn._mwiShrineClickArmed = false;
                    const observer = new MutationObserver(() => {
                        observer.disconnect();
                        this._renderShrine(modalEl);
                    });
                    observer.observe(levelEl, { subtree: true, childList: true, characterData: true });
                },
                { once: true }
            );
        }
    }

    _renderTrialTier(el) {
        // The badge itself, its ladder and its level cap all live in
        // `guild-trial-tier-badge.js`, because the trials feature draws the
        // same marker from its own tile pass and two copies of the rule would
        // drift. This tab observer is what puts one on every card, including
        // the ones the trials feature is not rendering a block beside.
        //
        // Guarded by the badge's own presence rather than a `data-` flag: React
        // reuses the level line and replaces its children on every redraw, so
        // the flag survived the span and the marker never came back. That is
        // why the maintainer's card read "Lv.260" with no tier on it.
        //
        // `GuildPanel_tileSummary` is not exclusive to trial tiles — the same
        // class also carries a guild building's "Lv. x / 20"
        // (GUILD_BUILDING_MAX_LEVEL, from guild-trials-store.js). The badge
        // helper keeps the two apart: a level below the first trial level
        // (100) resolves to no tier and gets no badge.
        const owner = el.closest?.('[data-mwi-trial-banked]');
        const banked = Number(owner?.dataset?.mwiTrialBanked);
        renderTierBadge(el, { bankedTiers: Number.isFinite(banked) ? banked : null });
    }

    cleanup() {
        // Invalidate any Missing Mats Marketplace click still polling for the
        // marketplace tablist — see `_switchGeneration`'s docstring.
        this._switchGeneration++;
        this.autofillManager.cleanup();
        this.unregisterObservers.forEach((fn) => fn());
        this.unregisterObservers = [];
        this._disconnectAdvisorObserver();
        this._disconnectShrineObservers();
        this._disconnectPlannerObservers();
        this._shrineWatchedHrids = null;
        this._shrineSignature = null;
        // A plan edited in the last few hundred milliseconds is written now
        // rather than dropped with the timer
        if (this._planSaveTimer) {
            clearTimeout(this._planSaveTimer);
            this._planSaveTimer = null;
            shrinePlanRecord.save();
        }
        if (this._shrineTabCleanup) {
            this._shrineTabCleanup();
            this._shrineTabCleanup = null;
        }
        removeShrineMarketTabs();
        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll('.mwi-shrine-cost').forEach((el) => el.remove());
        document.querySelectorAll('.mwi-trial-copy-btn').forEach((el) => el.remove());
        document.querySelectorAll(`.${TIER_BADGE_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll('.mwi-exchange-advisor').forEach((el) => el.remove());
        document.querySelectorAll('.mwi-shrine-planner').forEach((el) => el.remove());
        this.initialized = false;
    }
}

const guildCreditValue = new GuildCreditValue();

/**
 * The shrine plan record, for a character switch to `reset()` and for tests to
 * drive. Everything else goes through the planner.
 */
export { shrinePlanRecord };

export default {
    name: 'Guild Credit Value',
    initialize: () => guildCreditValue.initialize(),
    cleanup: () => {
        try {
            return guildCreditValue.cleanup();
        } catch (error) {
            console.error('[Guild Credit Value] Disable failed part-way:', error);
        } finally {
            guildCreditValue.initialized = false;
        }
    },
};
