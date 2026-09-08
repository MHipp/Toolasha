import { describe, it, expect } from 'vitest';
import { forecastNetworth, dailySamples, logReturns, MIN_RETURNS } from './networth-forecast.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A snapshot series, one point per day, from a list of totals.
 * @param {Array<number>} totals - Daily totals, oldest first
 * @returns {Array<Object>} Snapshots
 */
function series(totals) {
    return totals.map((total, index) => ({ t: index * DAY_MS + 12 * 60 * 60 * 1000, total }));
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

describe('dailySamples', () => {
    it('keeps the last snapshot of each day', () => {
        const history = [
            { t: 1 * 60 * 60 * 1000, total: 100 },
            { t: 5 * 60 * 60 * 1000, total: 150 },
            { t: DAY_MS + 3 * 60 * 60 * 1000, total: 200 },
        ];
        expect(dailySamples(history).map((s) => s.value)).toEqual([150, 200]);
    });

    it('ignores snapshots missing the field', () => {
        const history = [{ t: 0, total: 100 }, { t: DAY_MS }, { t: 2 * DAY_MS, total: 300 }];
        expect(dailySamples(history)).toHaveLength(2);
    });
});

describe('logReturns', () => {
    it('divides a multi-day gap across its days', () => {
        const samples = [
            { day: 0, value: 100 },
            { day: 4, value: 100 * 1.01 ** 4 },
        ];
        expect(logReturns(samples)[0]).toBeCloseTo(Math.log(1.01), 12);
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

    it('gives zero drift and a collapsed fan on a flat series', () => {
        const result = forecastNetworth(series(new Array(40).fill(1000)), { seed: 42, days: 30 });
        expect(result.status).toBe('complete');
        expect(result.method).toBe('block-bootstrap');
        expect(result.dailyDriftPercent).toBeCloseTo(0, 12);
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
        expect(result.dailyDriftPercent).toBeCloseTo(1, 9);
        const last = result.current;
        expect(result.fan.p50.at(-1)).toBeCloseTo(last * 1.01 ** 30, 3);
        // A deterministic series has no spread, so the fan is one line
        expect(result.fan.p10.at(-1)).toBeCloseTo(result.fan.p90.at(-1), 3);
        expect(result.doublingDays).toBe(Math.ceil(Math.LN2 / Math.log(1.01)));
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
        const result = forecastNetworth(history, { seed: 1, days: 60, target: result0Target(history) });
        expect(Object.keys(result.probabilities)).toEqual(['30', '60']);
        expect(result.probabilities[60]).toBe(100);
    });

    it('ignores a non-positive target', () => {
        const result = forecastNetworth(series(compounding(1000, 0.01, 40)), { seed: 1, target: -5 });
        expect(result.target).toBeNull();
        expect(result.probabilities).toEqual({});
    });
});

/**
 * A target the +1%/day series clears well before day 30.
 * @param {Array<Object>} history - Snapshot series
 * @returns {number} Target net worth
 */
function result0Target(history) {
    return history.at(-1).total * 1.05;
}
