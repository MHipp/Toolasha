/**
 * Net worth forecast — a Monte Carlo fan over the stored daily net worth series.
 *
 * Pure module: no DOM, no storage, no clock beyond what the caller passes in.
 * `networth-forecast-section.js` renders it; the history chart owns the data.
 *
 * Adapted from MWITools asset-history analytics, CC-BY-NC-SA-4.0, see third-party/mwitools/.
 */

import { createSeededDraw } from '../combat-sim/engine/rng.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Below this many changes the sample says nothing a fan could honestly draw.
 * Four points of history is a shape, not a distribution.
 */
export const MIN_RETURNS = 5;

/**
 * At this many changes the empirical sample is large enough to resample from,
 * so the projection switches off the normal assumption and bootstraps.
 */
const BOOTSTRAP_MIN_RETURNS = 15;

/** Resampled in blocks this long, so a run of good or bad days survives resampling. */
const BLOCK_DAYS = 5;

/** RiskMetrics decay for the volatility figure — recent days weigh more than a flat mean. */
const EWMA_LAMBDA = 0.94;

/** How many trailing daily samples the changes are drawn from. */
const DEFAULT_WINDOW_DAYS = 60;

/**
 * Half-life of the drift's recency weighting: the last ten days carry half the
 * weight and the last month ~87%, so one quiet or busy week moves a 30-day
 * projection without deciding it on its own.
 */
export const DRIFT_HALF_LIFE_DAYS = 10;

/**
 * A change spanning less than this is merged into the next one. Two daily
 * closes can sit minutes apart across midnight, and scaling a two-hour move to
 * a day multiplies its noise rather than measuring growth.
 */
const MIN_CHANGE_DAYS = 0.5;

/** Horizons the target probability is reported at. */
const TARGET_CHECKPOINTS = [30, 60, 90];

/** The fan's five lines, low to high. */
export const FAN_LEVELS = Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9]);

/**
 * Reduce the hourly snapshot series to one sample per UTC day.
 *
 * The stored history is hourly and gappy; a daily return computed off hourly
 * points would count twenty-four steps a day and read the drift as
 * twenty-four times what it is. The last snapshot of each day is the day's
 * close.
 *
 * `total` is the default because it is exclusion-independent: `nonExcluded`
 * moves when the player edits their exclusions, which is not a return.
 *
 * @param {Array<Object>} history - Snapshots with `t` and value fields, any order
 * @param {string} [field] - Which snapshot field to sample
 * @returns {Array<{day: number, t: number, value: number}>} Daily samples, oldest first
 */
export function dailySamples(history, field = 'total') {
    if (!Array.isArray(history)) return [];

    const byDay = new Map();
    for (const point of history) {
        if (!point || !Number.isFinite(point.t)) continue;
        const value = point[field];
        if (!Number.isFinite(value)) continue;
        const day = Math.floor(point.t / DAY_MS);
        const held = byDay.get(day);
        if (!held || point.t >= held.t) byDay.set(day, { day, t: point.t, value });
    }

    return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/**
 * The log changes between consecutive daily samples, each with the real time
 * it spans.
 *
 * Measured off the snapshot timestamps, not the UTC day numbers: a close at
 * 23:00 and the next at 01:00 two days later is 26 hours, not two days, and a
 * 46-hour offline stretch is ~1.9 days. A sample closer than
 * `MIN_CHANGE_DAYS` to the previous one is skipped, folding its move into the
 * next change.
 *
 * @param {Array<{t: number, value: number}>} samples - Daily samples, oldest first
 * @returns {Array<{start: number, end: number, days: number, logChange: number}>} Changes, oldest first
 */
export function dailyChanges(samples) {
    const changes = [];
    let anchor = null;
    for (const sample of samples ?? []) {
        if (!(sample?.value > 0) || !Number.isFinite(sample.t)) continue;
        if (!anchor) {
            anchor = sample;
            continue;
        }
        const days = (sample.t - anchor.t) / DAY_MS;
        if (days < MIN_CHANGE_DAYS) continue;
        changes.push({ start: anchor.t, end: sample.t, days, logChange: Math.log(sample.value / anchor.value) });
        anchor = sample;
    }
    return changes;
}

/**
 * Per-day log-returns across the daily samples, each change divided by the
 * real days it spans.
 * @param {Array<{t: number, value: number}>} samples - Daily samples, oldest first
 * @returns {Array<number>} Log-returns per day
 */
export function logReturns(samples) {
    return dailyChanges(samples).map((change) => change.logChange / change.days);
}

/**
 * Daily log drift, weighted towards the recent changes and measured against
 * elapsed time.
 *
 * A ratio of weighted growth to weighted time rather than a mean of per-change
 * rates: a long slow offline stretch counts for every day it spans instead of
 * as one entry beside a single busy day, which is what let the old mean run
 * ahead of the growth the chart itself measures. Each change is weighted by
 * the age of its midpoint.
 *
 * @param {Array<{start: number, end: number, days: number, logChange: number}>} changes - From
 *   {@link dailyChanges}
 * @param {number} [halfLifeDays] - Age at which a change counts half
 * @returns {number} Log growth per day; 0 when there is nothing to measure
 */
export function recencyDrift(changes, halfLifeDays = DRIFT_HALF_LIFE_DAYS) {
    if (!changes?.length) return 0;
    const latest = changes.at(-1).end;
    let growth = 0;
    let time = 0;
    for (const change of changes) {
        const age = (latest - (change.start + change.end) / 2) / DAY_MS;
        const weight = 0.5 ** (age / halfLifeDays);
        growth += weight * change.logChange;
        time += weight * change.days;
    }
    return time > 0 ? growth / time : 0;
}

/**
 * The window's changes as one-day shocks around zero.
 *
 * Each change loses the window's own growth over its span and is scaled to one
 * day by the square root of that span — a random walk's spread grows with the
 * square root of time, so a four-day gap's move is not four days' shock drawn
 * as one. What is left is recentred to average exactly zero, so resampling it
 * gives the long window's shape and no drift of its own. For one-day changes
 * this is `r_i − mean`.
 *
 * @param {Array<{days: number, logChange: number}>} changes - From {@link dailyChanges}
 * @returns {Array<number>} Shocks, oldest first
 */
export function dayShocks(changes) {
    if (!changes?.length) return [];
    const totalDays = changes.reduce((sum, change) => sum + change.days, 0);
    const totalGrowth = changes.reduce((sum, change) => sum + change.logChange, 0);
    const windowDrift = totalDays > 0 ? totalGrowth / totalDays : 0;
    const raw = changes.map((change) => (change.logChange - windowDrift * change.days) / Math.sqrt(change.days));
    const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
    return raw.map((value) => value - mean);
}

/**
 * Nearest-rank percentile of an already-sorted column.
 * @param {ArrayLike<number>} sorted - Ascending values
 * @param {number} level - 0..1
 * @returns {number} The value at that level
 */
function percentileOf(sorted, level) {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * level))];
}

/**
 * Box-Muller standard normal from a uniform draw function.
 * @param {Function} draw - Uniform [0, 1) source
 * @returns {number} One standard normal deviate
 */
function normalDeviate(draw) {
    let left = draw();
    let right = draw();
    if (left <= 0) left = Number.EPSILON;
    if (right <= 0) right = Number.EPSILON;
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

/**
 * EWMA daily volatility of the shocks.
 * @param {Array<number>} shocks - Shocks, oldest first
 * @returns {number} Standard deviation of the exponentially weighted variance
 */
function ewmaVolatility(shocks) {
    let variance = shocks[0] ** 2;
    for (let index = 1; index < shocks.length; index += 1) {
        variance = EWMA_LAMBDA * variance + (1 - EWMA_LAMBDA) * shocks[index] ** 2;
    }
    return Math.sqrt(variance);
}

/**
 * Chance of being at or above a target at each checkpoint inside the horizon.
 *
 * Read off the sorted checkpoint columns a forecast keeps, so a new target
 * costs a binary search per checkpoint rather than a fresh simulation.
 *
 * @param {Object} forecast - A completed forecast
 * @param {number|null} target - Net worth target
 * @returns {Object<number, number>} Percentages keyed by checkpoint day; empty without a positive target
 */
export function reachProbabilities(forecast, target) {
    const probabilities = {};
    if (!(Number(target) > 0) || !forecast?.checkpoints) return probabilities;
    for (const [checkpoint, column] of Object.entries(forecast.checkpoints)) {
        let low = 0;
        let high = column.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (column[middle] < target) low = middle + 1;
            else high = middle;
        }
        probabilities[checkpoint] = ((column.length - low) / column.length) * 100;
    }
    return probabilities;
}

/**
 * Project the net worth series forward as a percentile fan.
 *
 * The centre and the spread come from different places. The centre is
 * {@link recencyDrift}: the recent pace, in real elapsed time. The spread is
 * the whole window's {@link dayShocks}, recentred to zero, so a quiet week
 * moves the median without shrinking the fan to one week's worth of variety.
 * Taking both from one plain 60-change mean let an older fast stretch hold the
 * median at a pace the player had left behind.
 *
 * With `BOOTSTRAP_MIN_RETURNS` or more changes the shocks are resampled in
 * five-day blocks, keeping the autocorrelation an account actually has — a
 * week of heavy play, a week away. Below that resampling four numbers just
 * reprints them, so it falls back to normal shocks of the same spread. Both
 * thresholds are MWITools'.
 *
 * The RNG is the engine's seeded generator, detached from the sim streams, so a
 * given seed reproduces a given fan without disturbing a running simulation.
 *
 * @param {Array<Object>} history - Snapshot series (hourly), any order
 * @param {Object} [options] - Projection options
 * @param {number} [options.days] - Horizon in days
 * @param {number} [options.runs] - Monte Carlo paths
 * @param {number} [options.windowDays] - Trailing daily samples the changes come from; 0 for all
 * @param {number|null} [options.target] - Net worth target for the reach probabilities
 * @param {number|null} [options.seed] - RNG seed; omit for an unseeded sample
 * @param {string} [options.field] - Snapshot field to project
 * @returns {Object} `{status: 'insufficient', required, returns}` or the full projection
 */
export function forecastNetworth(history, options = {}) {
    const {
        days = 30,
        runs = 2000,
        windowDays = DEFAULT_WINDOW_DAYS,
        target = null,
        seed = null,
        field = 'total',
    } = options;

    const samples = dailySamples(history, field);
    const source = windowDays > 0 ? samples.slice(-(windowDays + 1)) : samples;
    const changes = dailyChanges(source);
    if (changes.length < MIN_RETURNS) {
        return { status: 'insufficient', required: MIN_RETURNS, returns: changes.length };
    }

    const horizon = Math.min(365, Math.max(1, Math.floor(days)));
    const count = Math.min(10000, Math.max(100, Math.floor(runs)));
    const current = source.at(-1).value;

    const drift = recencyDrift(changes);
    const shocks = dayShocks(changes);
    const sigma = Math.sqrt(shocks.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, shocks.length - 1));
    const useBootstrap = changes.length >= BOOTSTRAP_MIN_RETURNS;

    const draw = createSeededDraw(seed);
    const paths = [];
    for (let run = 0; run < count; run += 1) {
        const path = new Float64Array(horizon + 1);
        path[0] = current;
        if (useBootstrap) {
            let day = 1;
            while (day <= horizon) {
                const start = Math.floor(draw() * shocks.length);
                for (let block = 0; block < BLOCK_DAYS && day <= horizon; block += 1) {
                    path[day] = path[day - 1] * Math.exp(drift + shocks[(start + block) % shocks.length]);
                    day += 1;
                }
            }
        } else {
            // `drift` is already a log drift, so the median path is exp(drift·t) with no Itô term
            for (let day = 1; day <= horizon; day += 1) {
                path[day] = path[day - 1] * Math.exp(drift + sigma * normalDeviate(draw));
            }
        }
        paths.push(path);
    }

    const fan = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    const keys = ['p10', 'p25', 'p50', 'p75', 'p90'];
    const checkpoints = {};
    for (let day = 0; day <= horizon; day += 1) {
        const column = Float64Array.from(paths, (path) => path[day]).sort();
        for (let index = 0; index < FAN_LEVELS.length; index += 1) {
            fan[keys[index]].push(percentileOf(column, FAN_LEVELS[index]));
        }
        if (TARGET_CHECKPOINTS.includes(day)) checkpoints[day] = column;
    }

    // The displayed pace tracks the fan's own median path, not the `drift` fed to
    // the simulation above: a lopsided input (one permanent jump among many quiet
    // days) pulls `recencyDrift` toward the jump while the typical day — and so the
    // p50 line — barely moves. Reading the figure back off p50 keeps it agreeing
    // with the yellow line the player is actually looking at.
    const medianDailyGrowth = (fan.p50.at(-1) / current) ** (1 / horizon) - 1;

    const resolvedTarget = Number(target) > 0 ? Number(target) : null;
    const forecast = {
        status: 'complete',
        method: useBootstrap ? 'block-bootstrap' : 'gbm',
        current,
        days: horizon,
        runs: count,
        samples: source.length,
        returnCount: changes.length,
        windowStart: changes[0].start,
        windowEnd: changes.at(-1).end,
        target: resolvedTarget,
        // Reported as a percentage because that is how the panel reads it
        medianDailyGrowthPercent: medianDailyGrowth * 100,
        dailyVolatilityPercent: (Math.exp(ewmaVolatility(shocks)) - 1) * 100,
        // Only positive growth ever doubles; a flat or shrinking median has no
        // doubling day, and reporting Infinity or a negative one would invent one
        doublingDays: medianDailyGrowth > 0 ? Math.ceil(Math.LN2 / Math.log(1 + medianDailyGrowth)) : null,
        fan,
        checkpoints,
        probabilities: {},
    };
    forecast.probabilities = reachProbabilities(forecast, resolvedTarget);
    return forecast;
}
