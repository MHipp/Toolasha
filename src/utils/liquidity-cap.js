/**
 * The market-liquidity cap, at the display seam.
 *
 * `features/planner/market-liquidity.js` already measures the thing that
 * matters — how many units of an item actually change hands in a day — and the
 * goal planner bounds its gold rates with it. Every other profit surface kept
 * quoting the fiction: an alchemy ranking, an action-bar profit line or an
 * all-zones combat table would happily print 134.3B/hr for a method whose
 * output trades once a week. The price is real; the pace is not.
 *
 * This module is the one place those surfaces apply the same bound. It reuses
 * the planner's measurement (`sellThrottle`, `describeVelocity`) and its
 * wording — a capped figure carries `limited by market volume (~1/week)` and a
 * detail sentence naming the limiting item — so every surface says the same
 * thing about the same number.
 *
 * ## A display truth, not a calculator truth
 *
 * Nothing here mutates a calculator result another feature consumes. Callers
 * get a *copy* with the capped pace and a `liquidityLimit` marker on it; the
 * raw object keeps the raw claim. Net-worth, expected-value, the sim-vs-measured
 * calibration loop and the planner (which runs its own copy of this bound)
 * must keep reading uncapped figures, and they do, because they never come
 * through here.
 *
 * ## Unknowns, the planner's way
 *
 * An item the pooled history could not measure at all — the setting is off, the
 * server did not answer — bounds nothing: `absorbablePerHour` answers Infinity
 * for it, and crushing every rate because a third-party server is down would be
 * conservative in the way that unplugging the computer is. An item the history
 * *watched and saw nothing trade* is a measured zero and bounds all the way
 * down. Both behaviours are `market-liquidity.js`'s own, taken as-is.
 *
 * ## One switch for the whole display
 *
 * {@link LIQUIDITY_CAP_SETTING} (default on) turns the capping off display-wide
 * for a user who wants raw rates. It sits with the pricing settings, because it
 * is a statement about what a displayed rate means.
 *
 * ## Which copy of the measurement answers
 *
 * Same trick as `action-context.js` with the loadout store: in the production
 * multi-bundle build every bundle that imports this file would get its own copy
 * of `market-liquidity.js` and therefore its own volume cache, so at call time
 * the initialized shared copy on `window.Toolasha.Actions.marketLiquidity` is
 * preferred and the bundled import is the dev-build (single bundle) fallback.
 */

import config from '../core/config.js';
import bundledMarketLiquidity from '../features/planner/market-liquidity.js';
import { marketLiquidity as sharedMarketLiquidity } from './bundle-bridge.js';
import { runPool } from './async-pool.js';

/** The one checkbox that turns display-wide capping off */
export const LIQUIDITY_CAP_SETTING = 'profitCalc_liquidityCap';

/**
 * Matches `VOLUME_CONCURRENCY` in `market-liquidity.js` (itself matching
 * `MOOKET_CONCURRENCY` in `market-undercut-alerts.js` and
 * `price-target-alerts.js`) — the same politeness bound for the same
 * third-party pooled-history server, wherever it is asked from.
 */
const PREFETCH_CONCURRENCY = 4;

/**
 * The market-liquidity module that actually holds the volume cache.
 * @returns {Object} The planner's liquidity module
 */
function liquidity() {
    return sharedMarketLiquidity() || bundledMarketLiquidity;
}

/**
 * Whether displayed rates are being bounded at all.
 * @returns {boolean} True unless the user turned the cap off
 */
export function liquidityCapEnabled() {
    return config.getSetting(LIQUIDITY_CAP_SETTING, true) !== false;
}

/**
 * What a profit calculation has to sell, whatever calculator said it.
 *
 * The three shapes the profit surfaces hold:
 *
 * - **gathering** (`calculateGatheringProfit`): `baseOutputs` is the drop table
 *   with per-hour unit rates. Gourmet copies and processed conversions carry no
 *   `itemHrid`, so they are left out — an undercount, which can only make the
 *   cap *less* aggressive, never invent one.
 * - **alchemy** (`alchemy-profit-calculator`): `dropRevenues`, minus the
 *   self-returned copies of the input, which are not sold.
 * - **production** (`profit-calculator`): one output item at `itemsPerHour`,
 *   gourmet copies included since they are the same item.
 *
 * Essence and rare-find bonus drops (`bonusRevenue.bonusDrops`) are added for
 * any shape that has them.
 *
 * @param {Object|null} profitData - A calculator result
 * @returns {Array<{itemHrid: string, name: string|null, unitsPerHour: number}>}
 */
export function sellsFromProfitData(profitData) {
    if (!profitData) return [];

    const sells = new Map();
    const add = (itemHrid, name, unitsPerHour) => {
        const units = Number(unitsPerHour) || 0;
        if (!itemHrid || units <= 0) return;
        const entry = sells.get(itemHrid) || { itemHrid, name: name || null, unitsPerHour: 0 };
        entry.unitsPerHour += units;
        entry.name = entry.name || name || null;
        sells.set(itemHrid, entry);
    };

    if (Array.isArray(profitData.baseOutputs)) {
        for (const output of profitData.baseOutputs) add(output.itemHrid, output.name, output.itemsPerHour);
    } else if (Array.isArray(profitData.dropRevenues)) {
        for (const drop of profitData.dropRevenues) {
            if (drop?.isSelfReturn) continue;
            add(drop?.itemHrid, drop?.itemName, drop?.dropsPerHour);
        }
    } else if (profitData.itemHrid) {
        const units = (Number(profitData.itemsPerHour) || 0) + (Number(profitData.gourmetBonusItems) || 0);
        add(profitData.itemHrid, profitData.itemName || null, units);
    }

    for (const drop of profitData.bonusRevenue?.bonusDrops || []) {
        add(drop?.itemHrid, drop?.itemName, drop?.dropsPerHour);
    }

    return [...sells.values()];
}

/**
 * Warm the shared volume cache for a batch of items, before bounding a lot of
 * rows one at a time.
 *
 * Mirrors `market-liquidity.js`'s own internal prefetch, for a caller that
 * does not hold that module directly — this file is already the one place
 * that resolves which copy of it (shared or bundled) is live, see
 * {@link liquidity}. A table with a hundred rows asking `capProfitRate` for
 * one item apiece used to let only one row's fetch occupy a network slot
 * while the other three sat idle until that row finished; letting every row's
 * item queue onto the same four slots keeps the bound continuously busy
 * instead of mostly idle between rows, without asking for more of it at once.
 *
 * @param {Array<{itemHrid: string, enhancementLevel?: number}>} items - Items to warm
 * @returns {Promise<void>}
 */
export async function prefetchLiquidity(items) {
    const { dailyVolume } = liquidity();
    const wanted = new Map();
    for (const item of items || []) {
        if (!item?.itemHrid) continue;
        const enhancementLevel = item.enhancementLevel || 0;
        wanted.set(`${item.itemHrid}:${enhancementLevel}`, { itemHrid: item.itemHrid, enhancementLevel });
    }

    await runPool([...wanted.values()], PREFETCH_CONCURRENCY, async ({ itemHrid, enhancementLevel }) => {
        try {
            await dailyVolume(itemHrid, enhancementLevel);
        } catch (error) {
            // dailyVolume already settles its own failures as "unknown"; this
            // is a second net, not the one doing the real work.
            console.error(`[LiquidityCap] Prefetching volume for ${itemHrid} failed:`, error);
        }
    });
}

/**
 * Bound one displayed rate by how fast its outputs actually sell.
 *
 * The uncapped answer comes back for: a rate that earns nothing (there is
 * nothing to bound), a rate that names nothing it sells (bounding a guess would
 * be a different bug), a liquid market, an unmeasurable one, or the setting
 * being off.
 *
 * @param {Object} rate - `{goldPerHour, sells: [{itemHrid, unitsPerHour}]}`
 * @returns {Promise<{goldPerHour: number, capped: boolean, limit: Object|null}>}
 *   The pace the market will pay, whether it was cut, and — when it was — a
 *   marker payload in the planner's wording: `note` for the visible text,
 *   `detail` for the tooltip naming the limiting item and its traded volume.
 */
export async function capProfitRate({ goldPerHour, sells } = {}) {
    const raw = Number(goldPerHour) || 0;
    const uncapped = { goldPerHour: raw, capped: false, limit: null };

    if (raw <= 0 || !liquidityCapEnabled()) return uncapped;

    const list = (Array.isArray(sells) ? sells : []).filter((sold) => sold?.itemHrid && Number(sold.unitsPerHour) > 0);
    if (!list.length) return uncapped;

    try {
        const { sellThrottle, describeVelocity } = liquidity();
        const { throttle, binding } = await sellThrottle(list);
        if (!(throttle < 1) || !binding) return uncapped;

        const velocity = describeVelocity(binding.volume);
        const itemName = binding.name || binding.itemHrid.split('/').pop();
        return {
            goldPerHour: raw * throttle,
            capped: true,
            limit: {
                kind: 'volume',
                note: `limited by market volume (${velocity})`,
                detail: `${itemName} trades ${velocity}, and you are not the only seller.`,
                itemHrid: binding.itemHrid,
                itemName,
                velocity,
                throttle,
            },
        };
    } catch (error) {
        console.error('[LiquidityCap] Bounding a displayed rate failed:', error);
        return uncapped;
    }
}

/**
 * A calculator result, copied with its displayed pace bounded.
 *
 * Only the pace claims move: `profitPerHour` and `profitPerDay` are throttled,
 * the raw hourly figure is kept on `uncappedProfitPerHour`, and the marker
 * payload lands on `liquidityLimit`. Per-action margins are left alone — the
 * margin on one action is real, it is the actions-per-hour of *selling* that
 * the market disputes. The original object is never touched.
 *
 * @param {Object|null} profitData - A calculator result
 * @param {Array<Object>} [sells] - Override the extracted sells list
 * @returns {Promise<Object|null>} The same object when nothing binds, a bounded
 *   copy when something does
 */
export async function capProfitData(profitData, sells = null) {
    if (!profitData) return profitData;

    const bounded = await capProfitRate({
        goldPerHour: profitData.profitPerHour,
        sells: sells ?? sellsFromProfitData(profitData),
    });
    if (!bounded.capped) return profitData;

    const copy = {
        ...profitData,
        profitPerHour: bounded.goldPerHour,
        uncappedProfitPerHour: Number(profitData.profitPerHour) || 0,
        liquidityLimit: bounded.limit,
    };
    if (Number.isFinite(profitData.profitPerDay)) {
        copy.profitPerDay = profitData.profitPerDay * bounded.limit.throttle;
    }
    return copy;
}

/** &, <, >, " made safe for text and title attributes */
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The visible marker a capped figure carries — never render one without it.
 *
 * Full form prints the planner's note (`limited by market volume (~1/week)`);
 * the compact form, for tight table cells, prints `vol-capped`. Both carry the
 * note and the item-naming detail in the tooltip.
 *
 * @param {Object|null} limit - The `limit` payload from {@link capProfitRate}
 * @param {Object} [options] - Options
 * @param {boolean} [options.compact=false] - Short text for narrow cells
 * @returns {string} HTML, empty when there is no cap to mark
 */
export function liquidityMarkerHtml(limit, { compact = false } = {}) {
    if (!limit) return '';
    const title = escapeHtml(`${limit.note} — ${limit.detail}`);
    const text = compact ? 'vol-capped' : escapeHtml(limit.note);
    return (
        `<span title="${title}" style="font-size:0.85em; margin-left:4px; padding:0 3px; border-radius:2px; ` +
        `background:rgba(255,183,77,0.14); color:#ffb74d; cursor:help; white-space:nowrap;">${text}</span>`
    );
}

export default {
    LIQUIDITY_CAP_SETTING,
    liquidityCapEnabled,
    sellsFromProfitData,
    prefetchLiquidity,
    capProfitRate,
    capProfitData,
    liquidityMarkerHtml,
};
