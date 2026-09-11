import { describe, it, expect } from 'vitest';
import {
    forecastNetworth,
    dailySamples,
    dailyChanges,
    logReturns,
    recencyDrift,
    dayShocks,
    reachProbabilities,
    MIN_RETURNS,
} from './networth-forecast.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A snapshot series, one point per day, from a list of totals.
 * @param {Array<number>} totals - Daily totals, oldest first
 * @returns {Array<Object>} Snapshots
 */
function series(totals) {
    return totals.map((total, index) => ({ t: index * DAY_MS + 12 * HOUR_MS, total }));
}

/**
 * `count` totals compounding at `rate` per day from `start`.
 * @param {number} start - First total
 * @param {number} rate - Daily growth, e.g. 0.01
 * @param {number} count - How many days
 * @returns {Array<number>} Totals
 */
function compounding(start, rate, count) {
    return Array.from({ length: count }, (_, index) => start * (1 + rate) ** index);
}

/**
 * A change record as {@link dailyChanges} emits it.
 * @param {number} startDay - Start, in days
 * @param {number} days - Span in days
 * @param {number} logChange - Log growth over the span
 * @returns {Object} Change
 */
function change(startDay, days, logChange) {
    return { start: startDay * DAY_MS, end: (startDay + days) * DAY_MS, days, logChange };
}

describe('dailySamples', () => {
    it('keeps the last snapshot of each day', () => {
        const history = [
            { t: 1 * HOUR_MS, total: 100 },
            { t: 5 * HOUR_MS, total: 150 },
            { t: DAY_MS + 3 * HOUR_MS, total: 200 },
        ];
        expect(dailySamples(history).map((s) => s.value)).toEqual([150, 200]);
    });

    it('ignores snapshots missing the field', () => {
        const history = [{ t: 0, total: 100 }, { t: DAY_MS }, { t: 2 * DAY_MS, total: 300 }];
        expect(dailySamples(history)).toHaveLength(2);
    });
});

describe('dailyChanges', () => {
    it('measures a change in elapsed time, not UTC day numbers', () => {
        // 23:00 on day 0 to 01:00 on day 2 is 26 hours, two UTC days apart
        const [only] = dailyChanges([
            { t: 23 * HOUR_MS, value: 100 },
            { t: 2 * DAY_MS + HOUR_MS, value: 110 },
        ]);
        expect(only.days).toBeCloseTo(26 / 24, 12);
        expect(only.logChange).toBeCloseTo(Math.log(1.1), 12);
    });

    it('counts a 46-hour offline stretch as about 1.9 days', () => {
        const [only] = dailyChanges([
            { t: 0, value: 100 },
            { t: 46 * HOUR_MS, value: 100 },
        ]);
        expect(only.days).toBeCloseTo(46 / 24, 12);
    });

    it('folds a close under half a day after the previous one into the next change', () => {
        const changes = dailyChanges([
            { t: 23 * HOUR_MS, value: 100 },
            { t: DAY_MS + 30 * 60 * 1000, value: 150 },
            { t: 2 * DAY_MS + 23 * HOUR_MS, value: 121 },
        ]);
        expect(changes).toHaveLength(1);
        expect(changes[0].days).toBeCloseTo(2, 12);
        expect(changes[0].logChange).toBeCloseTo(Math.log(1.21), 12);
    });

    it('skips non-positive values', () => {
        const changes = dailyChanges([
            { t: 0, value: 100 },
            { t: DAY_MS, value: 0 },
            { t: 2 * DAY_MS, value: 121 },
        ]);
        expect(changes).toHaveLength(1);
        expect(changes[0].days).toBe(2);
    });
});

describe('logReturns', () => {
    it('divides a multi-day gap across its days', () => {
        const samples = [
            { t: 0, value: 100 },
            { t: 4 * DAY_MS, value: 100 * 1.01 ** 4 },
        ];
        expect(logReturns(samples)[0]).toBeCloseTo(Math.log(1.01), 12);
    });
});

describe('recencyDrift', () => {
    it('reads a constant rate as that rate, gaps or not', () => {
        const rate = Math.log(1.01);
        const changes = [change(0, 1, rate), change(1, 4, 4 * rate), change(5, 1, rate), change(6, 0.75, 0.75 * rate)];
        expect(recencyDrift(changes)).toBeCloseTo(rate, 12);
    });

    it('counts a slow offline stretch for every day it spans', () => {
        // Three +1% days and a flat four-day gap: seven days, three of growth.
        // A mean of per-change rates would read it as three growth entries in four.
        const rate = Math.log(1.01);
        const changes = [change(0, 1, rate), change(1, 1, rate), change(2, 4, 0), change(6, 1, rate)];
        expect(recencyDrift(changes, 1e9)).toBeCloseTo((3 * rate) / 7, 9);
    });

    it('leans towards the recent pace', () => {
        const fast = Math.log(1.01);
        const slow = Math.log(1.002);
        const changes = [
            ...Array.from({ length: 50 }, (_, day) => change(day, 1, fast)),
            ...Array.from({ length: 10 }, (_, day) => change(50 + day, 1, slow)),
        ];
        const drift = recencyDrift(changes);
        expect(drift).toBeLessThan((50 * fast + 10 * slow) / 60);
        expect(drift).toBeGreaterThan(slow);
        // Ten days at the default half-life carry half the weight
        expect(drift).toBeCloseTo((slow + fast * (1 - 2 ** -5)) / (2 - 2 ** -5), 3);
    });

    it('is 0 with nothing to measure', () => {
        expect(recencyDrift([])).toBe(0);
    });
});

describe('dayShocks', () => {
    it('is r − mean for one-day changes', () => {
        const values = [0.01, -0.02, 0.03, 0.0];
        const shocks = dayShocks(values.map((value, day) => change(day, 1, value)));
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        values.forEach((value, index) => expect(shocks[index]).toBeCloseTo(value - mean, 12));
    });

    it('scales a multi-day change to one day by the square root of its span and averages zero', () => {
        const shocks = dayShocks([change(0, 1, 0.01), change(1, 4, 0.08), change(5, 1, -0.01)]);
        expect(shocks.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0, 12);
        // Window growth 0.08 over 6 days; the gap's excess over its 4 days, halved by √4
        const windowDrift = 0.08 / 6;
        const raw = [0.01 - windowDrift, (0.08 - 4 * windowDrift) / 2, -0.01 - windowDrift];
        const rawMean = (raw[0] + raw[1] + raw[2]) / 3;
        expect(shocks[1]).toBeCloseTo(raw[1] - rawMean, 12);
    });
});

describe('forecastNetworth', () => {
    it('reports insufficient below the minimum return count', () => {
        const result = forecastNetworth(series([100, 101, 102, 103]), { seed: 7 });
        expect(result.status).toBe('insufficient');
        expect(result.required).toBe(MIN_RETURNS);
        expect(result.returns).toBe(3);
    });

    it('accepts exactly the minimum return count', () => {
        const result = forecastNetworth(series(compounding(100, 0.01, MIN_RETURNS + 1)), { seed: 7, days: 5 });
        expect(result.status).toBe('complete');
        expect(result.method).toBe('gbm');
    });

    it('reads the normal fallback pace off the median path, which tracks the input drift when shocks are symmetric', () => {
        const totals = compounding(1000, 0.005, 12).map((total, index) => total * (1 + (index % 2 ? 0.01 : -0.01)));
        const history = series(totals);
        const result = forecastNetworth(history, { seed: 9, days: 30, runs: 4000 });
        expect(result.method).toBe('gbm');
        const inputDrift = recencyDrift(dailyChanges(dailySamples(history)));
        const displayedGrowth = Math.log(1 + result.medianDailyGrowthPercent / 100);
        // Alternating +1%/-1% swings are symmetric, so the simulated median tracks
        // the drift it was built from — unlike scenario C's one-off jump, where the
        // two figures pull apart (see networth-forecast.scenarios.test.js).
        expect(displayedGrowth).toBeCloseTo(inputDrift, 2);
        expect(result.fan.p50.at(-1) / result.current).toBeCloseTo(Math.exp(30 * inputDrift), 1);
    });

    it('gives zero drift and a collapsed fan on a flat series', () => {
        const result = forecastNetworth(series(new Array(40).fill(1000)), { seed: 42, days: 30 });
        expect(result.status).toBe('complete');
        expect(result.method).toBe('block-bootstrap');
        expect(result.medianDailyGrowthPercent).toBeCloseTo(0, 12);
        expect(result.dailyVolatilityPercent).toBeCloseTo(0, 12);
        expect(result.doublingDays).toBeNull();
        for (const key of ['p10', 'p25', 'p50', 'p75', 'p90']) {
            expect(result.fan[key]).toHaveLength(31);
            for (const value of result.fan[key]) expect(value).toBeCloseTo(1000, 6);
        }
    });

    it('gives a median matching compound growth on a constant +1%/day series', () => {
        const result = forecastNetworth(series(compounding(1000, 0.01, 40)), { seed: 42, days: 30 });
        expect(result.status).toBe('complete');
        expect(result.medianDailyGrowthPercent).toBeCloseTo(1, 9);
        const last = result.current;
        expect(result.fan.p50.at(-1)).toBeCloseTo(last * 1.01 ** 30, 3);
        // A deterministic series has no spread, so the fan is one line
        expect(result.fan.p10.at(-1)).toBeCloseTo(result.fan.p90.at(-1), 3);
        expect(result.doublingDays).toBe(Math.ceil(Math.LN2 / Math.log(1.01)));
    });

    it('reads the displayed pace directly off the median path', () => {
        // A generic, non-lopsided check that the field is what it claims to be; the
        // scenario where this actually matters — a lopsided one-off jump pulling the
        // input drift away from the median — is covered in
        // networth-forecast.scenarios.test.js (scenario C).
        const result = forecastNetworth(series(compounding(1000, 0.01, 40)), { seed: 5, days: 45, runs: 3000 });
        const impliedGrowth = (result.fan.p50.at(-1) / result.current) ** (1 / result.days) - 1;
        expect(result.medianDailyGrowthPercent).toBeCloseTo(impliedGrowth * 100, 6);
    });

    it('reports the dates the window spans', () => {
        const history = series(compounding(1000, 0.01, 80));
        const result = forecastNetworth(history, { seed: 1 });
        expect(result.returnCount).toBe(60);
        expect(result.windowEnd).toBe(history.at(-1).t);
        expect(result.windowStart).toBe(history.at(-61).t);
    });

    it('reproduces the same fan for the same seed and differs for another', () => {
        const history = series(
            Array.from({ length: 40 }, (_, index) => 1000 * (1 + 0.02 * Math.sin(index)) * 1.005 ** index)
        );
        const first = forecastNetworth(history, { seed: 123, days: 30, runs: 300 });
        const second = forecastNetworth(history, { seed: 123, days: 30, runs: 300 });
        const other = forecastNetworth(history, { seed: 456, days: 30, runs: 300 });
        expect(second.fan).toEqual(first.fan);
        expect(other.fan.p90).not.toEqual(first.fan.p90);
    });

    it('reports target probabilities only at checkpoints inside the horizon', () => {
        const history = series(compounding(1000, 0.01, 40));
        const result = forecastNetworth(history, { seed: 1, days: 60, target: history.at(-1).total * 1.05 });
        expect(Object.keys(result.probabilities)).toEqual(['30', '60']);
        expect(result.probabilities[60]).toBe(100);
    });

    it.each([
        ['zero', 0],
        ['negative', -5e8],
    ])('projects from the last positive total when the latest one is %s', (_, glitch) => {
        const totals = compounding(1000, 0.01, 20);
        const result = forecastNetworth(series([...totals, glitch]), { seed: 3, days: 30 });
        expect(result.status).toBe('complete');
        expect(result.current).toBe(totals.at(-1));
        expect(result.medianDailyGrowthPercent).toBeCloseTo(1, 6);
        expect(result.fan.p10.at(-1)).toBeGreaterThan(result.current);
        expect(result.fan.p10.at(-1)).toBeLessThanOrEqual(result.fan.p90.at(-1));
    });

    it('ignores a non-positive target', () => {
        const result = forecastNetworth(series(compounding(1000, 0.01, 40)), { seed: 1, target: -5 });
        expect(result.target).toBeNull();
        expect(result.probabilities).toEqual({});
    });
});

describe('reachProbabilities', () => {
    const history = series(
        Array.from({ length: 40 }, (_, index) => 1000 * (1 + 0.02 * Math.sin(index)) * 1.005 ** index)
    );

    it('gives the same answer as simulating with the target', () => {
        const target = 1300;
        const withTarget = forecastNetworth(history, { seed: 5, days: 90, target });
        const without = forecastNetworth(history, { seed: 5, days: 90 });
        expect(reachProbabilities(without, target)).toEqual(withTarget.probabilities);
        expect(withTarget.probabilities[30]).toBeGreaterThan(0);
        expect(withTarget.probabilities[90]).toBeLessThanOrEqual(100);
    });

    it('counts values equal to the target as reached', () => {
        const forecast = { checkpoints: { 30: Float64Array.from([1, 2, 2, 3]) } };
        expect(reachProbabilities(forecast, 2)).toEqual({ 30: 75 });
        expect(reachProbabilities(forecast, 3.5)).toEqual({ 30: 0 });
        expect(reachProbabilities(forecast, 0.5)).toEqual({ 30: 100 });
    });

    it('is empty without a positive target or checkpoints', () => {
        const forecast = forecastNetworth(history, { seed: 5 });
        expect(reachProbabilities(forecast, null)).toEqual({});
        expect(reachProbabilities(forecast, -1)).toEqual({});
        expect(reachProbabilities({ status: 'insufficient' }, 100)).toEqual({});
    });
});
