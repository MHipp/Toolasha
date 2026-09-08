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
 * Below this many log-returns the sample says nothing a fan could honestly draw.
 * Four points of history is a shape, not a distribution.
 */
export const MIN_RETURNS = 5;

/**
 * At this many returns the empirical sample is large enough to resample from,
 * so the projection switches off the normal assumption and bootstraps.
 */
const BOOTSTRAP_MIN_RETURNS = 15;

/** Resampled in blocks this long, so a run of good or bad days survives resampling. */
const BLOCK_DAYS = 5;

/** RiskMetrics decay for the volatility figure — recent days weigh more than a flat mean. */
const EWMA_LAMBDA = 0.94;

/** How many trailing daily samples the returns are drawn from. */
const DEFAULT_WINDOW_DAYS = 60;

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
 * Per-day log-returns across the daily samples.
 *
 * A gap of several days is divided out rather than treated as one day's move,
 * so a week away does not register as one enormous return.
 *
 * @param {Array<{day: number, value: number}>} samples - Daily samples, oldest first
 * @returns {Array<number>} Log-returns per day
 */
export function logReturns(samples) {
    const returns = [];
    for (let index = 1; index < (samples?.length ?? 0); index += 1) {
        const previous = samples[index - 1].value;
        const current = samples[index].value;
        if (!(previous > 0) || !(current > 0)) continue;
        const gapDays = Math.max(1, samples[index].day - samples[index - 1].day);
        returns.push(Math.log(current / previous) / gapDays);
    }
    return returns;
}

/**
 * Nearest-rank percentile of an already-sorted column.
 * @param {Array<number>} sorted - Ascending values
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
 * EWMA daily volatility of the log-returns.
 * @param {Array<number>} returns - Log-returns, oldest first
 * @returns {number} Standard deviation of the exponentially weighted variance
 */
function ewmaVolatility(returns) {
    let variance = returns[0] ** 2;
    for (let index = 1; index < returns.length; index += 1) {
        variance = EWMA_LAMBDA * variance + (1 - EWMA_LAMBDA) * returns[index] ** 2;
    }
    return Math.sqrt(variance);
}

/**
 * Project the net worth series forward as a percentile fan.
 *
 * Two generators, chosen by sample size. With `BOOTSTRAP_MIN_RETURNS` or more
 * returns the days are resampled in five-day blocks from the observed returns:
 * it makes no distributional assumption and it keeps the autocorrelation an
 * account actually has — a week of heavy play, a week away. Below that the
 * sample cannot carry a bootstrap (resampling four numbers just reprints them),
 * so it falls back to geometric Brownian motion off the sample mean and
 * variance. Both thresholds are MWITools'; the shape of this data gave no
 * reason to move them.
 *
 * The RNG is the engine's seeded generator, detached from the sim streams, so a
 * given seed reproduces a given fan without disturbing a running simulation.
 *
 * @param {Array<Object>} history - Snapshot series (hourly), any order
 * @param {Object} [options] - Projection options
 * @param {number} [options.days] - Horizon in days
 * @param {number} [options.runs] - Monte Carlo paths
 * @param {number} [options.windowDays] - Trailing daily samples the returns come from; 0 for all
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
    const returns = logReturns(source);
    if (returns.length < MIN_RETURNS) {
        return { status: 'insufficient', required: MIN_RETURNS, returns: returns.length };
    }

    const horizon = Math.min(365, Math.max(1, Math.floor(days)));
    const count = Math.min(10000, Math.max(100, Math.floor(runs)));
    const current = source.at(-1).value;

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const sigma = Math.sqrt(variance);
    const useBootstrap = returns.length >= BOOTSTRAP_MIN_RETURNS;

    const draw = createSeededDraw(seed);
    const paths = [];
    for (let run = 0; run < count; run += 1) {
        const path = new Float64Array(horizon + 1);
        path[0] = current;
        if (useBootstrap) {
            let day = 1;
            while (day <= horizon) {
                const start = Math.floor(draw() * returns.length);
                for (let block = 0; block < BLOCK_DAYS && day <= horizon; block += 1) {
                    path[day] = path[day - 1] * Math.exp(returns[(start + block) % returns.length]);
                    day += 1;
                }
            }
        } else {
            for (let day = 1; day <= horizon; day += 1) {
                path[day] = path[day - 1] * Math.exp(mean - 0.5 * variance + sigma * normalDeviate(draw));
            }
        }
        paths.push(path);
    }

    const fan = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    const keys = ['p10', 'p25', 'p50', 'p75', 'p90'];
    for (let day = 0; day <= horizon; day += 1) {
        const column = paths.map((path) => path[day]).sort((a, b) => a - b);
        for (let index = 0; index < FAN_LEVELS.length; index += 1) {
            fan[keys[index]].push(percentileOf(column, FAN_LEVELS[index]));
        }
    }

    const resolvedTarget = Number(target) > 0 ? Number(target) : null;
    const probabilities = {};
    if (resolvedTarget) {
        for (const checkpoint of TARGET_CHECKPOINTS.filter((day) => day <= horizon)) {
            const reached = paths.filter((path) => path[checkpoint] >= resolvedTarget).length;
            probabilities[checkpoint] = (reached / count) * 100;
        }
    }

    return {
        status: 'complete',
        method: useBootstrap ? 'block-bootstrap' : 'gbm',
        current,
        days: horizon,
        runs: count,
        samples: source.length,
        returnCount: returns.length,
        target: resolvedTarget,
        // Reported as percentages because that is how the panel reads them; the
        // drift is the median daily move, not the mean of the levels
        dailyDriftPercent: (Math.exp(mean) - 1) * 100,
        dailyVolatilityPercent: (Math.exp(ewmaVolatility(returns)) - 1) * 100,
        // Only a positive drift ever doubles; a flat or shrinking account has no
        // doubling day, and reporting Infinity or a negative one would invent one
        doublingDays: mean > 0 ? Math.ceil(Math.LN2 / mean) : null,
        fan,
        probabilities,
    };
}
