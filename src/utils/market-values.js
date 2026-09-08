/**
 * Official market values and the tradable-range clamp.
 *
 * Since the 8/13/2026 update the game publishes an estimated value for every
 * item and enhancement level — the same figure behind the inventory's "Total
 * Market Value" tooltip. Two things follow from it:
 *
 *  - A **value** for items whose live order book is empty or stale, so networth
 *    can price an illiquid item the way the game does rather than falling all
 *    the way back to crafting cost.
 *  - A **tradable range** (about ±10% around the value): the game rejects buy
 *    or sell orders outside it, so a hypothetical sell above the band or buy
 *    below it cannot actually fill. A stale snapshot price parked outside the
 *    band would otherwise print an impossible profit or valuation.
 *
 * The range is computed the way the game computes it: ±10% of the value,
 * snapped outward to the price-increment ladder and widened by one increment
 * on each side (the 8/14/2026 hotfix — cheap items get a proportionally wider
 * range). The ladder is the game client's own `getBinnedPrice` tiering, read
 * out of its bundle and verified against live band bounds across nine decades
 * of price on 8/18/2026 — see {@link priceIncrement}. One caveat survives:
 * bands *recalibrate toward* the value at ≤1% per hourly pass, so right after
 * a value moves, the game's actual band lags what this computes from the new
 * value until the passes catch up.
 *
 * The map is reached through the game's own `localStorageUtil.getMarketItemValues()`
 * (via dataManager), which decompresses the localStorage blob for us — reading it
 * raw yields compressed bytes. The dev's advice was to cache it rather than
 * re-fetch, so the util is called at most once per refresh interval and the map
 * is swapped only when its version changes; everything else reads the cache.
 * A pushed `market_item_values_updated` message swaps the cache directly —
 * see {@link applyMarketValuesMessage} — so a mid-session refresh does not wait
 * out the interval.
 *
 * All of this is gated behind {@link isMarketplacePatchLive}: the util does not
 * exist on the live server until the patch lands, so before then every helper
 * here is an inert pass-through and the plugin behaves exactly as it did.
 */

import dataManager from '../core/data-manager.js';
import { isMarketplacePatchLive } from './server-gate.js';

/** The width of the tradable range either side of the value (~±10%). */
export const BAND_FACTOR = 1.1;

/** Re-read the value map at most this often; the game util decompresses on each call. */
const REFRESH_INTERVAL_MS = 30_000;

let cache = { version: null, values: null };
let lastRefresh = 0;

/**
 * Bands already computed for the current value map: itemHrid → band per
 * enhancement level (array index), `null` where the item has no value.
 * Every getItemPrice call goes through reconcileBook/clampToBand, and the band
 * arithmetic allocates a couple of strings each time, so the result is kept per
 * (item, level) and thrown away with the map it was derived from.
 * @type {Map<string, Array<{min:number,max:number}|null>>}
 */
let bandCache = new Map();

/**
 * Re-read the value map through the game util, throttled and version-guarded so
 * the decompress happens at most once per interval and only swaps the cache when
 * the map actually changed. A no-op until the patch is live. Cheap to call often.
 * @param {number} [now=Date.now()] - Injectable clock, for tests
 * @returns {Object|null} `{ itemHrid: { level: value } }`, or null before any read
 */
export function refreshMarketValues(now = Date.now()) {
    if (!isMarketplacePatchLive()) return cache.values;
    if (cache.values && now - lastRefresh < REFRESH_INTERVAL_MS) return cache.values;
    if (typeof dataManager.getMarketItemValues !== 'function') return cache.values;
    lastRefresh = now;
    try {
        const payload = dataManager.getMarketItemValues();
        const version = payload?.marketValuesVersion ?? null;
        const values = payload?.marketItemValues ?? null;
        if (values && version !== cache.version) {
            cache = { version, values };
            bandCache = new Map();
        }
        return cache.values;
    } catch (error) {
        console.error('[Market Values] Reading market values failed:', error);
        return cache.values;
    }
}

/**
 * The official value of one item at one enhancement level, from cache.
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {number|null}
 */
export function marketValueFor(itemHrid, enhancementLevel = 0) {
    const value = cache.values?.[itemHrid]?.[String(enhancementLevel)];
    return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * The marketplace's price increment at a price — the game client's own
 * `getBinnedPrice` ladder, by first digit and digit count:
 *
 *   first digit 1-2 → 5×10^(digits−4)      (1,000-2,999: 5; 10,000-29,999: 50 …)
 *   first digit 3-4 → 10^(digits−3)        (300-499: 1; 3,000-4,999: 10 …)
 *   first digit 5-9 → 2×10^(digits−3)      (500-999: 2; 5,000-9,999: 20 …)
 *
 * with a floor of 1, so every increment is roughly 0.17-0.5% of the price.
 * @param {number} price - Any price (fractions are floored, as the game does)
 * @returns {number} The increment the ladder assigns that price
 */
export function priceIncrement(price) {
    const whole = Math.floor(price);
    if (!(whole > 0)) return 1;
    const text = String(whole);
    const digits = text.length;
    const first = text[0];
    if (first === '1' || first === '2') return digits >= 4 ? 5 * 10 ** (digits - 4) : 1;
    if (first === '3' || first === '4') return digits >= 3 ? 10 ** (digits - 3) : 1;
    return digits >= 3 ? 2 * 10 ** (digits - 3) : 1;
}

/**
 * The tradable range implied by a market value, as the game computes it:
 * ±10%, snapped outward to the increment ladder, then one increment wider on
 * each side. The increment is taken from the raw ±10% figure before snapping —
 * mirroring `getBinnedPrice`, which sizes the step from its input.
 * @param {number|null} value - Market value
 * @returns {{min:number, max:number}|null}
 */
export function bandFromValue(value) {
    if (!(value > 0)) return null;
    const rawMax = value * BAND_FACTOR;
    const maxStep = priceIncrement(rawMax);
    const rawMin = value / BAND_FACTOR;
    const minStep = priceIncrement(rawMin);
    return {
        min: Math.max(0, Math.floor(rawMin / minStep) * minStep - minStep),
        max: Math.ceil(rawMax / maxStep) * maxStep + maxStep,
    };
}

/**
 * The tradable range of one item at one level, memoised per value map.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @returns {{min:number, max:number}|null}
 */
function bandFor(itemHrid, enhancementLevel) {
    let perLevel = bandCache.get(itemHrid);
    if (perLevel === undefined) {
        perLevel = [];
        bandCache.set(itemHrid, perLevel);
    }
    let band = perLevel[enhancementLevel];
    if (band === undefined) {
        band = bandFromValue(marketValueFor(itemHrid, enhancementLevel));
        perLevel[enhancementLevel] = band;
    }
    return band;
}

/**
 * Clamp one price into the item's tradable range, when one is known.
 *
 * The single-price face of {@link reconcileBook}: a present price parked
 * outside the band is pulled to the nearest edge (as far as an order could
 * actually reach); a missing price stays missing — this never invents a
 * price, so callers that treat null as "no market" keep that meaning.
 * Pass-through until the patch is live or when the item has no official value.
 *
 * @param {number|null} price - A raw ask or bid
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {number|null} The price, banded when a band is known
 */
export function clampToBand(price, itemHrid, enhancementLevel = 0) {
    if (typeof price !== 'number' || price < 0) return price ?? null;
    if (!isMarketplacePatchLive()) return price;
    // Self-sufficient: direct order-book consumers call this without going
    // through getPrice, and a clamp against an empty cache would be a no-op.
    // The refresh is throttled and version-guarded, so this is cheap.
    refreshMarketValues();
    const band = bandFor(itemHrid, enhancementLevel);
    if (!band) return price;
    return Math.min(Math.max(price, band.min), band.max);
}

/**
 * Reconcile a raw order-book ask/bid pair against the official value.
 *
 * A pass-through until the patch is live or when the item has no official value.
 * Otherwise each present side is clamped into the tradable range (a stale price
 * parked outside it is pulled to the nearest edge, which is as far as an order
 * could actually reach), and a missing side is filled with the value itself — so
 * an item with an empty book is still priced the way the game prices it.
 *
 * @param {number|null} ask - Raw best ask
 * @param {number|null} bid - Raw best bid
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {{ask:number|null, bid:number|null, askSource:string|null, bidSource:string|null}}
 *   Each `*Source` is `'book'` when the side came from the live order book (clamped or not),
 *   `'value'` when it was filled in from the official value map, and `null` when there is no
 *   price at all. Callers that must distinguish a real quote from an estimate read these —
 *   without them a value-filled side is indistinguishable from a genuine listing, and every
 *   "no market data" signal downstream silently stops firing.
 */
export function reconcileBook(ask, bid, itemHrid, enhancementLevel = 0) {
    const sourceOf = (x) => (typeof x === 'number' && x >= 0 ? 'book' : null);
    if (!isMarketplacePatchLive()) {
        return { ask, bid, askSource: sourceOf(ask), bidSource: sourceOf(bid) };
    }
    const value = marketValueFor(itemHrid, enhancementLevel);
    if (value === null) return { ask, bid, askSource: sourceOf(ask), bidSource: sourceOf(bid) };
    const band = bandFor(itemHrid, enhancementLevel);
    const clamp = (x) => (typeof x === 'number' && x >= 0 ? Math.min(Math.max(x, band.min), band.max) : null);
    const askIsBook = typeof ask === 'number' && ask >= 0;
    const bidIsBook = typeof bid === 'number' && bid >= 0;
    return {
        ask: askIsBook ? clamp(ask) : value,
        bid: bidIsBook ? clamp(bid) : value,
        askSource: askIsBook ? 'book' : 'value',
        bidSource: bidIsBook ? 'book' : 'value',
    };
}

/**
 * Apply a pushed `market_item_values_updated` payload.
 *
 * The map is otherwise only re-read out of localStorage on the throttle above,
 * so between a value refresh and the next read every price this module produces
 * is stale — for the whole session if the game writes the compressed blob once
 * and then only pushes. Handling the message closes that window: the map is
 * swapped, the version bumped, and the derived band cache — the only thing here
 * memoised across a map — dropped so it recomputes against the new values.
 *
 * Both fields are required. A payload carrying no map is ignored rather than
 * clearing the cache, so a partial or malformed push cannot blank out pricing.
 *
 * The message and its payload shape were learnt from MWITools (CC-BY-NC-SA-4.0)
 * — see `third-party/mwitools/`.
 *
 * @param {{marketValuesVersion?: number, marketItemValues?: Object}} payload - Message payload
 * @returns {boolean} True when the cache was swapped
 */
export function applyMarketValuesMessage(payload) {
    const values = payload?.marketItemValues;
    if (!values || typeof values !== 'object') return false;
    cache = { version: payload.marketValuesVersion ?? null, values };
    bandCache = new Map();
    // The pushed map is newer than anything localStorage holds, so restart the
    // throttle window rather than letting the next price query re-read over it.
    lastRefresh = Date.now();
    return true;
}

// Global market data, not one character's, so this is not re-armed on a switch.
// This module sits under market-data.js and so under nearly every pricing path;
// the typeof guard keeps a suite that mocks dataManager with only the two
// methods its own subject calls from failing at import time.
if (typeof dataManager?.on === 'function') {
    dataManager.on('market_item_values_updated', (payload) => applyMarketValuesMessage(payload));
}

/** Reset the cache and refresh throttle. Tests only. */
export function _resetMarketValues() {
    cache = { version: null, values: null };
    bandCache = new Map();
    lastRefresh = 0;
}
