/**
 * How fast a market will actually absorb what a method produces.
 *
 * ## The hole this closes
 *
 * A gold rate is a claim about *realizing* gold, and every step between the
 * action and the coins was modelled except the last one: somebody has to buy
 * what you made. The planner would rank a method at 134.3B/hr because its
 * outputs are priced at 134.3B/hr of ask, on a book where one unit changes hands
 * a week. You cannot sell into a market that is not there. The price is real and
 * the rate is fiction.
 *
 * The `sustainable` cap already says "a rate is only a rate while its inputs
 * last". This is the same sentence about the other end: *a rate is only a rate
 * while somebody is buying.*
 *
 * ## Where the number comes from
 *
 * The pooled market history Toolasha already fetches for the history chart. Each
 * row carries a traded volume, and `buildHistorySeries` already turns rows into
 * per-day volume with the ask/bid split the chart's tooltip shows. Summing that
 * over a window and dividing gives units per day, client-side, with no
 * order-book round trips — the same data the user is looking at when they say
 * "this thing sells once a week".
 *
 * Total volume rather than only the sell-into-bid half: a player selling can
 * either hit the bid or post an ask and wait to be lifted, and both are units of
 * that item changing hands. Counting only one side would halve every answer for
 * no reason.
 *
 * ## The two judgement calls, and why
 *
 * **You are not the only seller.** {@link LIQUIDITY_SHARE} is the fraction of
 * observed trade this character is assumed to be able to capture. A quarter is
 * already aggressive — it says one in every four units traded market-wide is
 * yours — and anything higher is not a share of the market, it is a claim to
 * *be* the market. It is deliberately a single constant rather than something
 * clever about spreads: the point is a sanity bound, and a bound nobody can
 * explain is worse than a blunt one.
 *
 * **A week is the horizon.** {@link LIQUIDITY_HORIZON_DAYS} is how far ahead a
 * total is allowed to count. A windfall you can only unwind over eight months
 * is not money the next step of a plan can spend, so what a method is worth is
 * what it can be turned into inside a week at the pace the book will take.
 *
 * ## Absence of data is not data showing absence
 *
 * Two different unknowns, and conflating them would either break the planner or
 * lie to it:
 *
 * - **The history is not available** — the pooled-history setting is off, or the
 *   server did not answer. Nothing is known about any item, so nothing is
 *   bounded and the panel says out loud that it is not checking. Crushing every
 *   rate to zero because a third-party server is down would be conservative in
 *   the same way that unplugging the computer is.
 * - **The history is available and shows no trades** — that *is* an answer, and
 *   it is the answer the user is complaining about. It bounds normally, all the
 *   way to zero if the pool watched the item for a month and saw nothing.
 */

import marketHistoryAPI from '../market/mooket/market-history-api.js';
import { buildHistorySeries } from '../market/mooket/market-history-data.js';
import { runPool } from '../../utils/async-pool.js';

/** How much history to average over. Long enough that a quiet week is not a verdict. */
export const LIQUIDITY_WINDOW_DAYS = 30;

/**
 * The share of an item's observed trade one character is assumed to be able to take.
 * See the module doc: a quarter is already a strong claim.
 */
export const LIQUIDITY_SHARE = 0.25;

/** How far ahead a total is allowed to count as realizable */
export const LIQUIDITY_HORIZON_DAYS = 7;

/** Coins are not sold on the marketplace, so they never bound anything */
const COIN_HRID = '/items/coin';

/**
 * One session's answers. The planner asks about the same handful of items on
 * every replan, and the fetch behind this is a network round trip.
 * @type {Map<string, Object>}
 */
const cache = new Map();

/**
 * In-flight lookups, keyed the same way as {@link cache}. The planner, the
 * alchemy sort and every other profit surface can all ask about the same item
 * in the same instant — a shared method's output, say — and each used to pay
 * its own round trip. Caching the *promise* here, before it settles, folds
 * concurrent askers onto the one request, the same trick `marketAPI.fetch()`
 * already plays for the market-data load (see `feature-registry.js`).
 * @type {Map<string, Promise<Object>>}
 */
const pending = new Map();

/** Forget everything measured, for tests and for a hard refresh */
export function resetLiquidityCache() {
    cache.clear();
    pending.clear();
}

/**
 * The measurement behind {@link dailyVolume}, split out so its promise can be
 * handed to `pending` before it resolves rather than after.
 *
 * @param {string} itemHrid - The item
 * @param {number} enhancementLevel - Which variant
 * @param {string} key - The cache key for both maps
 * @returns {Promise<{itemHrid: string, unitsPerDay: number, days: number, known: boolean}>}
 */
async function measureDailyVolume(itemHrid, enhancementLevel, key) {
    const unknown = { itemHrid, unitsPerDay: 0, days: 0, known: false };

    // A source that carries no volume (mooket I) tells us nothing about how much
    // trades — which is a different thing from a source that watched and saw
    // nothing. Treating its silence as a measured zero would crush every rate to
    // nothing the moment someone switched sources, so it stays unknown.
    if (!marketHistoryAPI.currentSource().hasVolume) {
        cache.set(key, unknown);
        return unknown;
    }

    let answer = unknown;
    try {
        const rows = await marketHistoryAPI.fetchHistory(itemHrid, enhancementLevel, LIQUIDITY_WINDOW_DAYS);
        if (Array.isArray(rows) && rows.length) {
            const series = buildHistorySeries(rows, LIQUIDITY_WINDOW_DAYS);
            const traded = series.reduce((sum, point) => sum + (Number(point.volume) || 0), 0);

            // Divided by the span the data covers, not by the number of days it
            // has a point for. A thing traded on four days out of thirty traded
            // four times in a month, not four times in four days — counting only
            // the days something happened is how an item that sells once a week
            // comes out looking like an item that sells once a day.
            const first = series[0]?.time || 0;
            const last = series[series.length - 1]?.time || first;
            const span = Math.min(LIQUIDITY_WINDOW_DAYS, Math.max(1, (last - first) / 86_400 + 1));

            answer = { itemHrid, unitsPerDay: traded / span, days: span, known: true };
        }
    } catch (error) {
        console.error(`[MarketLiquidity] Reading the history for ${itemHrid} failed:`, error);
    }

    cache.set(key, answer);
    return answer;
}

/**
 * How many units of an item change hands in a day.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel=0] - Which variant
 * @returns {Promise<{itemHrid: string, unitsPerDay: number, days: number, known: boolean}>}
 *   `known` is false when nothing could be measured — no setting, no server, no
 *   rows — which is different from a measured zero and must not be treated as one.
 */
export async function dailyVolume(itemHrid, enhancementLevel = 0) {
    const key = `${itemHrid}:${enhancementLevel}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const lookup = measureDailyVolume(itemHrid, enhancementLevel, key);
    pending.set(key, lookup);
    try {
        return await lookup;
    } finally {
        pending.delete(key);
    }
}

/**
 * How many units an hour the market will take from you.
 * @param {{unitsPerDay: number, known: boolean}} volume - From {@link dailyVolume}
 * @returns {number} Units per hour, or `Infinity` when nothing is known
 */
export function absorbablePerHour(volume) {
    if (!volume?.known) return Number.POSITIVE_INFINITY;
    return (LIQUIDITY_SHARE * Math.max(0, volume.unitsPerDay)) / 24;
}

/**
 * A traded volume, said the way somebody looking at a history chart would say it.
 * @param {{unitsPerDay: number, known: boolean}} volume - From {@link dailyVolume}
 * @returns {string} e.g. "~1/week", "~340/day"
 */
export function describeVelocity(volume) {
    const perDay = Math.max(0, Number(volume?.unitsPerDay) || 0);
    if (perDay <= 0) return 'none traded';

    // The largest unit the count still rounds to at least one in. The threshold
    // is 0.995 rather than 1 because the number arrives as a quotient — an item
    // that traded four times in twenty-eight days is one a week, and float
    // arithmetic makes it 0.9999999999999999 of one.
    const roundsToOne = 0.995;
    if (perDay >= roundsToOne) return `~${Math.round(perDay)}/day`;
    const perWeek = perDay * 7;
    if (perWeek >= roundsToOne) return `~${Math.round(perWeek)}/week`;
    return `~${Math.round(perDay * 30)}/month`;
}

/**
 * Kept low so a method with many sale outputs — an alchemy drop table, a full
 * gathering method with its rare finds — does not burst the third-party history
 * server. Matches `MOOKET_CONCURRENCY` in `market-undercut-alerts.js` and
 * `price-target-alerts.js`, which bound the same server for the same reason;
 * this is a network round trip, not the CPU sweep `xph-calculator.js` batches
 * at 24, so it stays well under that.
 */
const VOLUME_CONCURRENCY = 4;

/**
 * What the market lets a method actually run at.
 *
 * The binding output is the slowest-selling one: running the action faster than
 * its worst product can be sold does not make coins, it makes a pile. So the
 * throttle is the minimum over everything the method has to sell.
 *
 * The volumes are fetched concurrently (bounded by {@link VOLUME_CONCURRENCY})
 * rather than one at a time — a method with several outputs used to pay a
 * network round trip per item, serially. The reduce below still walks the
 * outputs in their original order, so a tie between two equally-slow outputs
 * still resolves to whichever came first, exactly as it did serially.
 *
 * @param {Array<{itemHrid: string, unitsPerHour: number}>} sells - What one hour produces
 * @returns {Promise<{throttle: number, binding: Object|null}>} A multiplier in [0, 1],
 *   and the output that set it
 */
export async function sellThrottle(sells) {
    const wanted = (sells || [])
        .map((sold, index) => ({ sold, index }))
        .filter(({ sold }) => sold?.itemHrid && sold.itemHrid !== COIN_HRID && (Number(sold?.unitsPerHour) || 0) > 0);

    const volumes = new Array(wanted.length);
    await runPool(wanted, VOLUME_CONCURRENCY, async ({ sold, index }) => {
        try {
            volumes[index] = await dailyVolume(sold.itemHrid, sold.enhancementLevel || 0);
        } catch (error) {
            // dailyVolume already settles its own failures as "unknown"; this is
            // a second net so one bad item can never take the others down with it.
            console.error(`[MarketLiquidity] Measuring volume for ${sold.itemHrid} failed:`, error);
            volumes[index] = { itemHrid: sold.itemHrid, unitsPerDay: 0, days: 0, known: false };
        }
    });

    let throttle = 1;
    let binding = null;

    for (const { sold, index } of wanted) {
        const volume = volumes[index];
        const wantedRate = Number(sold.unitsPerHour) || 0;
        const allowed = absorbablePerHour(volume);
        if (!Number.isFinite(allowed)) continue;

        const share = Math.min(1, allowed / wantedRate);
        if (share < throttle) {
            throttle = share;
            binding = { ...sold, volume };
        }
    }

    return { throttle, binding };
}

/**
 * Bound a rate by how fast what it makes can be sold.
 *
 * Two bounds from the one measurement, because a rate makes two claims:
 *
 * - **the pace** — `goldPerHour` is throttled to what the book will absorb;
 * - **the total** — a rate that already carries a `sustainable` ceiling has that
 *   ceiling cut to what the throttled pace can realize inside
 *   {@link LIQUIDITY_HORIZON_DAYS}. An uncapped method is left uncapped: giving
 *   gathering a ceiling it never had would be a different bug.
 *
 * The rate is copied rather than edited. The ranking is rebuilt on every
 * refresh out of arrays other features hold, and quietly rewriting one of their
 * objects is how two surfaces start disagreeing about the same number.
 *
 * @param {Object} rate - A gold rate, carrying `sells: [{itemHrid, unitsPerHour}]`
 * @returns {Promise<Object>} The rate, bounded, with a `limits` note if it was
 */
export async function applySellLimit(rate) {
    const sells = Array.isArray(rate?.sells) ? rate.sells : [];
    if (!sells.length) return rate;

    const { throttle, binding } = await sellThrottle(sells);
    if (!(throttle < 1) || !binding) return rate;

    const goldPerHour = Math.max(0, Number(rate.goldPerHour) || 0) * throttle;
    const limited = {
        ...rate,
        goldPerHour,
        limits: [
            ...(rate.limits || []),
            {
                kind: 'volume',
                note: `limited by market volume (${describeVelocity(binding.volume)})`,
                detail:
                    `${binding.name || binding.itemHrid.split('/').pop()} trades ` +
                    `${describeVelocity(binding.volume)}, and you are not the only seller.`,
                throttle,
                itemHrid: binding.itemHrid,
            },
        ],
    };

    // Only a method that already had a ceiling gets a smaller one. An absent
    // ceiling (null/undefined) is unbounded and stays that way — Number(null)
    // is 0, and clamping to min(0, …) would zero a cap the rate never had.
    const rawCeiling = rate.sustainable?.gold;
    const ceiling = Number(rawCeiling);
    if (rate.sustainable && !rate.sustainable.unbounded && rawCeiling != null && Number.isFinite(ceiling)) {
        const realizable = Math.min(ceiling, goldPerHour * LIQUIDITY_HORIZON_DAYS * 24);
        const goldPerUnit = Number(rate.sustainable.goldPerUnit) || 0;
        limited.sustainable = {
            ...rate.sustainable,
            gold: realizable,
            ...(goldPerUnit > 0 ? { units: realizable / goldPerUnit } : {}),
        };
    }

    return limited;
}

/** Below this, restocking an input is not something you do on demand */
const THIN_INPUT_PER_DAY = 1;

/**
 * Say when a method's *input* is the thing that barely trades.
 *
 * A note rather than a cap, deliberately. What an input costs is already inside
 * the margin, and a method run on stock you already hold is bounded by that
 * stock rather than by the book — the `sustainable` ceiling covers it. What the
 * book does decide is whether you could ever do this *again*, and a plan that
 * quietly assumes you can restock a once-a-week item is worth one line of doubt.
 *
 * @param {Object} rate - A gold rate, whose `itemHrid` is what it consumes
 * @returns {Promise<Object>} The rate, with a note if its input is thin
 */
export async function applyInputNote(rate) {
    if (!rate?.itemHrid) return rate;

    const volume = await dailyVolume(rate.itemHrid);
    if (!volume.known || volume.unitsPerDay >= THIN_INPUT_PER_DAY) return rate;

    const name = rate.sustainable?.unitLabel || rate.itemName || rate.itemHrid.split('/').pop();
    return {
        ...rate,
        limits: [
            ...(rate.limits || []),
            {
                kind: 'input',
                note: `restocking ${name} means buying into a ${describeVelocity(volume)} book`,
                itemHrid: rate.itemHrid,
            },
        ],
    };
}

/**
 * Warm the shared volume cache for every item a batch of rates could ask
 * about, before bounding them one at a time.
 *
 * `applySellLimit` and `applyInputNote` already ask {@link dailyVolume} for
 * exactly these items, in the loop below — this changes nothing about what
 * gets asked, only when. Without it, a ranking of a few hundred rates paid the
 * {@link VOLUME_CONCURRENCY} bound per *rate* rather than once for the whole
 * sweep: a rate with a single output used one of four allowed slots and the
 * other three sat idle until that rate's own `await` returned, because the
 * next rate did not get a turn until this one finished completely. Fetching
 * the union of every rate's items up front lets all of them compete for the
 * same four slots continuously instead of a handful at a time between rates.
 *
 * A rate whose own fields throw when read (the loop below already has to
 * survive that) is skipped here rather than allowed to abort the prefetch —
 * the existing per-rate handling still runs into the same throw afterwards
 * and is where it is actually reported.
 *
 * @param {Array<Object>} rates - Gold rates, read for `sells` and `itemHrid`
 * @returns {Promise<void>}
 */
async function prefetchVolumes(rates) {
    const wanted = new Map();
    for (const rate of rates) {
        try {
            for (const sold of rate?.sells || []) {
                if (!sold?.itemHrid || sold.itemHrid === COIN_HRID) continue;
                const enhancementLevel = sold.enhancementLevel || 0;
                wanted.set(`${sold.itemHrid}:${enhancementLevel}`, { itemHrid: sold.itemHrid, enhancementLevel });
            }
            if (rate?.itemHrid) {
                wanted.set(`${rate.itemHrid}:0`, { itemHrid: rate.itemHrid, enhancementLevel: 0 });
            }
        } catch (error) {
            console.error('[MarketLiquidity] Reading a rate to prefetch its volumes failed:', error);
        }
    }

    await runPool([...wanted.values()], VOLUME_CONCURRENCY, async ({ itemHrid, enhancementLevel }) => {
        try {
            await dailyVolume(itemHrid, enhancementLevel);
        } catch (error) {
            // dailyVolume already settles its own failures as "unknown"; this is
            // a second net, the same one sellThrottle keeps below.
            console.error(`[MarketLiquidity] Prefetching volume for ${itemHrid} failed:`, error);
        }
    });
}

/**
 * Bound every rate in a ranking, and say whether the bounding could happen at all.
 *
 * @param {Array<Object>} rates - Gold rates
 * @returns {Promise<{rates: Array<Object>, measured: boolean}>} The rates, best
 *   first, and whether any volume figure was available — a run where none was is
 *   a run where nothing was checked, which the panel has to be able to say
 */
export async function applyLiquidityLimits(rates) {
    const list = Array.isArray(rates) ? rates : [];

    await prefetchVolumes(list);

    const bounded = [];
    for (const rate of list) {
        try {
            bounded.push(await applyInputNote(await applySellLimit(rate)));
        } catch (error) {
            console.error('[MarketLiquidity] Bounding a rate failed:', error);
            bounded.push(rate);
        }
    }

    bounded.sort((a, b) => (Number(b.goldPerHour) || 0) - (Number(a.goldPerHour) || 0));
    const measured = [...cache.values()].some((entry) => entry.known);
    return { rates: bounded, measured };
}

export default {
    LIQUIDITY_SHARE,
    LIQUIDITY_HORIZON_DAYS,
    LIQUIDITY_WINDOW_DAYS,
    dailyVolume,
    absorbablePerHour,
    describeVelocity,
    sellThrottle,
    applySellLimit,
    applyInputNote,
    applyLiquidityLimits,
    resetLiquidityCache,
};
