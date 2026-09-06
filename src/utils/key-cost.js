/**
 * Dungeon key cost
 *
 * What one entry key or chest key costs, given that there are two ways to get
 * one: buy it off the market, or craft it from materials.
 *
 * ## Why both numbers, always
 *
 * A dungeon profit figure that prices keys at the market ask is answering "what
 * would it cost me to replace these keys right now, impatiently". That is a
 * real question, but it is not the only one, and when a key's materials are
 * cheaper than the key the answer overstates the cost of running the dungeon —
 * sometimes badly, because keys are thin markets and the ask drifts far above
 * what the recipe implies.
 *
 * So this reports both sides and names the cheaper one rather than picking
 * silently. The caller gets `unitCost` (the cheaper), and `buyPrice`,
 * `craftCost` and `cheaper` next to it, so a display can show the choice it made
 * instead of presenting one number as if it were the only one.
 *
 * ## Time is reported, not priced
 *
 * Crafting a key costs materials *and* time, and the time has no honest gold
 * value — it depends entirely on what the player would otherwise be doing.
 * `craftSeconds` is therefore handed back as seconds and never folded into
 * `craftCost`. A caller that wants to say "cheaper, but it costs you twelve
 * minutes" has what it needs; nothing here invents an hourly wage to make the
 * comparison come out one way.
 *
 * `craftSeconds` is the time for the key's own crafting action, per key, at this
 * character's efficiency. Materials are costed at whichever of buying and
 * crafting is cheaper for them (that is what `computeBestCraftingPlan` decides),
 * so if a material is itself crafted, its time is not in this figure.
 *
 * ## Whose cost this is
 *
 * A crafting cost is personal — artisan tea removes materials, efficiency gives
 * free actions, gear changes the action time. Everything here goes through
 * `describeCraft`, which costs the recipe against the logged-in character, so
 * two players reading the same dungeon get different and correct answers.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';
import { describeCraft } from '../features/crafting-plan/craft-arbitrage-adapter.js';
import { getPricingMode } from './market-data.js';
import { coinFormatter, timeReadable } from './formatters.js';

/** The setting that says how a key is valued */
export const KEY_PRICING_SETTING = 'profitCalc_keyPricingMode';

/**
 * What the key pricing setting can be stored as.
 *
 * `ask` and `bid` are the two the setting shipped with and are never given new
 * meanings: a profile carrying either must keep valuing keys exactly as it did.
 * `synced` and `craft` are the additions.
 */
export const KEY_PRICING_MODES = ['ask', 'bid', 'synced', 'craft'];

/** Where an unrecognised stored value lands, and the setting's own default */
const DEFAULT_KEY_PRICING_MODE = 'ask';

/**
 * The stored setting turned into the two things a costing actually needs.
 *
 * The setting answers two separate questions that used to be one: *which side
 * of the book* a key's market price comes from, and *whether a market price is
 * the basis at all*. Splitting them here means every consumer resolves them the
 * same way instead of each reading the raw string and indexing a price map with
 * it — which is what `synced` and `craft` would have silently broken, since
 * `prices['craft']` is `undefined` and the `?? prices.ask` fallbacks would have
 * hidden that behind a plausible number.
 *
 * `synced` follows `profitCalc_pricingMode`'s **buy** side through
 * `getPricingMode`, the one authority on that setting. Keys are only ever
 * bought, so the general setting's sell side has nothing to say here.
 *
 * `craft` resolves a market side too: the recipe's materials still have to be
 * priced off one side of the book, and it follows the general setting's buy
 * side for the same reason `synced` does — the user expressed a basis
 * preference there and none here.
 *
 * An unrecognised stored value falls back to `ask` rather than being passed
 * through. Five features value keys through this; a typo in a hand-edited
 * profile must not take all five out.
 *
 * @returns {{setting: string, priceSide: 'ask'|'bid', basis: 'market'|'craft'}}
 */
export function resolveKeyPricing() {
    const stored = config.getSettingValue(KEY_PRICING_SETTING);
    const setting = KEY_PRICING_MODES.includes(stored) ? stored : DEFAULT_KEY_PRICING_MODE;

    if (setting === 'ask' || setting === 'bid') {
        return { setting, priceSide: setting, basis: 'market' };
    }

    // `getPricingMode` can answer 'average' for modes this setting has no
    // equivalent of; a key is bought at one side or the other, so anything that
    // is not 'bid' buys at the ask.
    const side = getPricingMode('profit', 'buy') === 'bid' ? 'bid' : 'ask';
    return { setting, priceSide: side, basis: setting === 'craft' ? 'craft' : 'market' };
}

/**
 * Which market price a key's materials and market quote are taken at.
 *
 * Always a real side of the book — never the raw setting — so a caller can hand
 * it straight to a price map without the lookup coming back undefined.
 *
 * @returns {string} 'ask' (instant buy) or 'bid' (patient buy)
 */
export function getKeyPricingMode() {
    return resolveKeyPricing().priceSide;
}

/**
 * The market price of a key in the caller's pricing mode.
 *
 * Deliberately the same lookup the key-cost callers already used — `marketAPI`
 * directly, falling back to the ask when the chosen side is missing — so that
 * turning the craft comparison on cannot move the buy figure underneath it.
 *
 * @param {string} keyHrid - Key item HRID
 * @param {string} mode - 'ask' or 'bid'
 * @returns {number|null} Price, or null when the market has nothing
 */
function buyPriceFor(keyHrid, mode) {
    const prices = marketAPI.getPrice(keyHrid);
    if (!prices) return null;

    const price = prices[mode] ?? prices.ask;
    return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * What one key costs, bought and crafted, and which of those the setting takes.
 *
 * Either side may be missing and the result is still usable: a key with no
 * recipe reports `craftCost: null` and settles on buying, a key nobody is
 * selling reports `buyPrice: null` and settles on crafting. When both are
 * missing `unitCost` is null, which is the caller's signal that this key cannot
 * be costed at all rather than that it is free.
 *
 * ## What the basis changes
 *
 * On the `market` basis — every mode but `craft` — `unitCost` is the cheaper of
 * the two, which is what this has always reported and what `ask` and `bid` must
 * keep reporting.
 *
 * On the `craft` basis `unitCost` is the craft cost even when the market is
 * cheaper, because the user has said they make their own keys and wants them
 * valued at what they actually pay. Two things that basis does **not** do:
 *
 * - It never part-prices a recipe. `describeCraft` rejects a recipe outright
 *   when a material has no price, so `craftCost` is null rather than a total
 *   with a free material in it. A missing material is unknown, never zero.
 * - It never leaves a costable key uncosted. When the recipe is missing or
 *   unpriceable the market quote is used instead and `cheaper` reports `'buy'`,
 *   so a display and a net worth both get the honest replacement cost rather
 *   than a null that every `?? 0` downstream would turn into a free key. Only
 *   when the market has nothing either is `unitCost` null.
 *
 * @param {string} keyHrid - Key item HRID
 * @param {Object} [options] - Costing options
 * @param {string} [options.mode] - Market side ('ask'/'bid'); defaults to the resolved setting
 * @param {string} [options.basis] - 'market' or 'craft'; defaults to the resolved setting, and
 *   to 'market' when `mode` was given on its own
 * @param {Map} [options.memo] - Shared unit-cost memo, for costing several keys
 * @param {Map} [options.actionStats] - Shared action-stats cache, same purpose
 * @returns {{itemHrid: string, itemName: string, pricingMode: string, basis: string,
 *   buyPrice: number|null, craftCost: number|null, craftSeconds: number|null,
 *   craftActionHrid: string|null, cheaper: string|null, unitCost: number|null, savings: number}}
 */
export function describeKeyCost(keyHrid, options = {}) {
    const resolved = resolveKeyPricing();
    const mode = options.mode || resolved.priceSide;
    // An explicit `mode` with no `basis` is a caller asking for a market side,
    // which is what every pre-existing caller of this meant.
    const basis = options.basis || (options.mode ? 'market' : resolved.basis);
    const itemName = dataManager.getItemDetails(keyHrid)?.name || keyHrid;

    const empty = {
        itemHrid: keyHrid,
        itemName,
        pricingMode: mode,
        basis,
        buyPrice: null,
        craftCost: null,
        craftSeconds: null,
        craftActionHrid: null,
        cheaper: null,
        unitCost: null,
        savings: 0,
    };

    if (!keyHrid) return empty;

    const buyPrice = buyPriceFor(keyHrid, mode);

    let craft = null;
    try {
        craft = describeCraft(keyHrid, { mode, memo: options.memo, actionStats: options.actionStats });
    } catch (error) {
        console.error(`[KeyCost] Could not cost the recipe for ${keyHrid}:`, error);
    }

    // `describeCraft` already rejects a recipe whose materials cannot be priced,
    // so anything finite here is a cost somebody could actually pay.
    const craftCost = Number.isFinite(craft?.unitCost) && craft.unitCost > 0 ? craft.unitCost : null;
    const craftSeconds = Number.isFinite(craft?.secondsPerUnit) ? craft.secondsPerUnit : null;

    if (buyPrice === null && craftCost === null) return empty;

    // A tie goes to buying: the two cost the same gold and only one of them
    // also costs the player an afternoon.
    let cheaper;
    if (craftCost === null) cheaper = 'buy';
    else if (buyPrice === null) cheaper = 'craft';
    else cheaper = craftCost < buyPrice ? 'craft' : 'buy';

    // The craft basis overrides the comparison, but only where there is a craft
    // cost to override it with — see the fallback rule above.
    const route = basis === 'craft' && craftCost !== null ? 'craft' : cheaper;

    const unitCost = route === 'craft' ? craftCost : buyPrice;
    const savings = buyPrice !== null && craftCost !== null ? Math.abs(buyPrice - craftCost) : 0;

    return {
        itemHrid: keyHrid,
        itemName,
        pricingMode: mode,
        basis,
        buyPrice,
        craftCost,
        craftSeconds,
        craftActionHrid: craft?.actionHrid ?? null,
        cheaper: route,
        unitCost,
        savings,
    };
}

/**
 * How long a craft-basis unit cost is reused before the recipe is walked again.
 *
 * Only the craft basis is cached. A market lookup is a map read; a craft cost
 * walks the recipe through the crafting planner against this character, which
 * is far too much work for a badge pass over an inventory or a panel that
 * redraws on a timer.
 */
const CRAFT_COST_TTL_MS = 60_000;

/**
 * `keyHrid|priceSide|characterId` to `{at, unitCost}`.
 *
 * The side is in the key so a setting change misses. The character is in it
 * for a stronger reason: a craft cost is personal — artisan tea removes
 * materials, efficiency gives free actions, gear moves the action time — so a
 * figure priced for one character is simply wrong for the next, and this cache
 * outlives a character switch. Net worth, the inventory badges, the item
 * tooltip and the chest model all read through here; without the character in
 * the key an alt spends its first minute deducting somebody else's key cost.
 */
const craftCostCache = new Map();

/**
 * What one key is worth under the user's setting, as a single number.
 *
 * For the callers that only ever wanted "what does this key cost me" — the
 * chest-key deductions in net worth, the inventory badges and the item tooltip,
 * and the chest risk-of-ruin model. Each used to read the raw setting and index
 * a price map with it, which resolves nothing: `prices['synced']` is undefined
 * and the `?? ask` beside it would have answered every non-market mode with the
 * ask while looking like it had honoured the setting.
 *
 * @param {string} keyHrid - Key item HRID
 * @returns {number|null} Gold per key, or null when neither route can be priced
 */
export function getKeyUnitCost(keyHrid) {
    if (!keyHrid) return null;

    const { priceSide, basis } = resolveKeyPricing();
    if (basis !== 'craft') return buyPriceFor(keyHrid, priceSide);

    const cacheKey = `${keyHrid}|${priceSide}|${dataManager.getCurrentCharacterId?.() ?? '?'}`;
    const cached = craftCostCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CRAFT_COST_TTL_MS) return cached.unitCost;

    const { unitCost } = describeKeyCost(keyHrid, { mode: priceSide, basis: 'craft' });
    // A null is "nothing could price this yet", not an answer worth keeping.
    // The market snapshot loads asynchronously at start-up, so the first pass
    // over an inventory can legitimately see an empty book; caching that for a
    // minute would leave every `?? 0` downstream deducting a free key long
    // after the prices arrived. The market basis has no cache and self-heals on
    // the next read; the craft basis has to be told to.
    if (unitCost === null) return null;
    craftCostCache.set(cacheKey, { at: Date.now(), unitCost });
    return unitCost;
}

/** Drop the craft-basis cache, for a surface that has just changed the setting. */
export function invalidateKeyCostCache() {
    craftCostCache.clear();
}

/**
 * Cost several keys in one pass.
 *
 * The caches are shared across the keys because dungeon key recipes overlap —
 * costing four keys separately re-derives the same materials four times.
 *
 * @param {Array<string>} keyHrids - Key item HRIDs
 * @param {Object} [options] - Same options as `describeKeyCost`, minus the caches
 * @returns {Map<string, Object>} keyHrid → `describeKeyCost` result
 */
export function describeKeyCosts(keyHrids, options = {}) {
    const memo = options.memo ?? new Map();
    const actionStats = options.actionStats ?? new Map();
    const results = new Map();

    for (const keyHrid of keyHrids || []) {
        if (!keyHrid || results.has(keyHrid)) continue;
        results.set(keyHrid, describeKeyCost(keyHrid, { ...options, memo, actionStats }));
    }

    return results;
}

/**
 * One line saying what the key cost and why.
 *
 * Written for a breakdown row that has already shown the price being used, so
 * this is the justification rather than the figure: both sides, the time the
 * craft takes, and which one the number above it came from.
 *
 * @param {Object} cost - From `describeKeyCost`
 * @param {Object} [options] - Formatting options
 * @param {Function} [options.formatNumber] - Gold formatter, defaults to `coinFormatter`
 * @param {Function} [options.formatSeconds] - Time formatter, defaults to `timeReadable`
 * @returns {string} Empty when there is nothing worth saying
 */
export function formatKeyCostNote(cost, options = {}) {
    if (!cost || cost.unitCost === null || cost.unitCost === undefined) return '';

    const money = options.formatNumber || ((value) => coinFormatter(Math.round(value)));
    const time = options.formatSeconds || ((seconds) => timeReadable(Math.round(seconds)));

    const craftPart =
        cost.craftCost !== null && cost.craftCost !== undefined
            ? `craft ${money(cost.craftCost)}${cost.craftSeconds ? ` (${time(cost.craftSeconds)})` : ''}`
            : null;
    const buyPart = cost.buyPrice !== null && cost.buyPrice !== undefined ? `buy ${money(cost.buyPrice)}` : null;

    if (craftPart && buyPart) {
        const saved = cost.savings > 0 ? `, saves ${money(cost.savings)} ea` : '';
        return `${craftPart} ea vs ${buyPart} — using ${cost.cheaper === 'craft' ? 'crafted' : 'bought'}${saved}`;
    }
    if (craftPart) return `${craftPart} ea — not on the market, using crafted`;
    return `${buyPart} ea — no recipe, using bought`;
}

export default {
    KEY_PRICING_SETTING,
    KEY_PRICING_MODES,
    resolveKeyPricing,
    getKeyPricingMode,
    getKeyUnitCost,
    invalidateKeyCostCache,
    describeKeyCost,
    describeKeyCosts,
    formatKeyCostNote,
};
