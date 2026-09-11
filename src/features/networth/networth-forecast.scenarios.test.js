/**
 * The forecast on account-shaped series: hourly snapshots with jittered
 * timing, dropped hours, nightly offline and multi-day gaps, each ending at
 * 11.31B. These are the series the drift investigation separated its causes
 * on, and the ranges below are the model's contract on them — a change that
 * moves one out of range is a change in what the panel tells a player.
 */
import { describe, it, expect } from 'vitest';
import { forecastNetworth } from './networth-forecast.js';

const HOUR_MS = 60 * 60 * 1000;
const END = Date.UTC(2026, 8, 11, 20, 0, 0);

/**
 * Deterministic uniform source, so every scenario is the same series on every run.
 * @param {number} seed - Seed
 * @returns {Function} Uniform [0, 1)
 */
function mulberry(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * An hourly snapshot series.
 * @param {Object} spec - Series shape
 * @param {number} spec.days - Length in days
 * @param {Function} spec.rateAt - Daily log growth by whole days before the end
 * @param {Function} [spec.online] - Whether a snapshot is taken at an hour index
 * @param {Function} [spec.grows] - Whether the account grows at an hour index
 * @param {Object<number, number>} [spec.jumps] - One-off multipliers by hour index
 * @param {number} [spec.noise] - Size of the mean-reverting dips
 * @param {number} [spec.seed] - Seed for timing and dips
 * @returns {Array<{t: number, total: number}>} Snapshots, oldest first
 */
function build({ days, rateAt, online = () => true, grows = () => true, jumps = {}, noise = 0.004, seed = 1 }) {
    const draw = mulberry(seed);
    const hours = days * 24;
    let level = 1;
    const levels = [];
    for (let hour = 0; hour <= hours; hour += 1) {
        const daysFromEnd = Math.floor((hours - hour) / 24);
        if (hour > 0 && grows(hour)) level *= Math.exp(rateAt(daysFromEnd) / 24);
        if (jumps[hour]) level *= jumps[hour];
        levels.push(level);
    }
    const scale = 11.31e9 / levels.at(-1);
    const history = [];
    let dip = 0;
    for (let hour = 0; hour <= hours; hour += 1) {
        dip = 0.9 * dip + (draw() - 0.5) * noise;
        if (!online(hour) && hour !== hours) continue;
        if (hour !== hours && draw() < 0.15) continue;
        const t = END - (hours - hour) * HOUR_MS + Math.floor(draw() * 40 * 60 * 1000);
        history.push({ t, total: Math.round(levels[hour] * scale * (1 + dip)) });
    }
    return history;
}

/** The recent pace on the maintainer's panel: +1.5% over seven days. */
const SLOW = Math.log(1.0021);
const JUMP_HOUR = 70 * 24 - 20 * 24;

/**
 * @param {Array<Object>} history - Snapshots
 * @returns {Object} The 30-day forecast at a fixed seed, with drift and fan ends in readable units
 */
function run(history) {
    const forecast = forecastNetworth(history, { seed: 42, days: 30 });
    return {
        forecast,
        drift: forecast.dailyDriftPercent,
        p10: forecast.fan.p10.at(-1) / 1e9,
        p50: forecast.fan.p50.at(-1) / 1e9,
        p90: forecast.fan.p90.at(-1) / 1e9,
    };
}

describe('forecast scenarios', () => {
    it('A: eight days at the recent pace, with gaps, projects that pace (normal fallback)', () => {
        const { forecast, drift, p50 } = run(
            build({ days: 8, rateAt: () => SLOW, online: (hour) => !(hour > 60 && hour < 90) })
        );
        expect(forecast.method).toBe('gbm');
        expect(drift).toBeGreaterThan(0.19);
        expect(drift).toBeLessThan(0.24);
        expect(p50).toBeGreaterThan(11.95);
        expect(p50).toBeLessThan(12.2);
    });

    it('A2: seventy steady days with nightly offline and a three-day gap project the same pace', () => {
        const { forecast, drift, p50 } = run(
            build({ days: 70, rateAt: () => SLOW, online: (hour) => hour % 24 >= 8 && !(hour > 600 && hour < 672) })
        );
        expect(forecast.method).toBe('block-bootstrap');
        expect(drift).toBeGreaterThan(0.2);
        expect(drift).toBeLessThan(0.24);
        expect(p50).toBeGreaterThan(12.0);
        expect(p50).toBeLessThan(12.2);
    });

    it('B: a slow week after fifty-three fast days pulls the median down without deciding it', () => {
        // The old plain mean read 0.81%/day and a 14.44B median here
        const { drift, p50 } = run(build({ days: 70, rateAt: (day) => (day < 7 ? SLOW : Math.log(1.009)) }));
        expect(drift).toBeGreaterThan(0.55);
        expect(drift).toBeLessThan(0.68);
        expect(p50).toBeGreaterThan(13.3);
        expect(p50).toBeLessThan(13.9);
    });

    it('B2: three slow weeks after a fast stretch bring the median most of the way to the recent pace', () => {
        // The old plain mean read 0.78%/day and a 14.32B median here
        const { drift, p50 } = run(build({ days: 70, rateAt: (day) => (day < 21 ? SLOW : Math.log(1.011)) }));
        expect(drift).toBeGreaterThan(0.34);
        expect(drift).toBeLessThan(0.44);
        expect(p50).toBeGreaterThan(12.5);
        expect(p50).toBeLessThan(13.0);
    });

    it('C: a permanent one-off +30% jump lifts the drift figure but not the median', () => {
        // A known limitation, recorded rather than endorsed: the jump sits in the
        // drift (and so the doubling time) while the typical-day shocks hold the
        // median near the recent pace and the jump shows up as a long p90 tail
        const { drift, p50, p90 } = run(build({ days: 70, rateAt: () => SLOW, jumps: { [JUMP_HOUR]: 1.3 } }));
        expect(drift).toBeGreaterThan(0.58);
        expect(drift).toBeLessThan(0.72);
        expect(p50).toBeGreaterThan(12.0);
        expect(p50).toBeLessThan(12.3);
        expect(p90).toBeGreaterThan(15);
    });

    it('C2: a +30% jump that reverts the next day leaves the pace near the recent one', () => {
        const { drift, p50 } = run(
            build({ days: 70, rateAt: () => SLOW, jumps: { [JUMP_HOUR]: 1.3, [JUMP_HOUR + 26]: 1 / 1.3 } })
        );
        expect(drift).toBeGreaterThan(0.1);
        expect(drift).toBeLessThan(0.24);
        expect(p50).toBeGreaterThan(11.7);
        expect(p50).toBeLessThan(12.1);
    });

    it('D: growth only on online days, offline two days in four, reads the true time-weighted pace', () => {
        // True pace 0.216%/day; the old mean of per-change rates read 0.269%
        const { drift } = run(
            build({
                days: 70,
                rateAt: () => Math.log(1.0042),
                online: (hour) => Math.floor(hour / 24) % 4 < 2,
                grows: (hour) => Math.floor(hour / 24) % 4 < 2,
            })
        );
        expect(Math.abs(drift - 0.216)).toBeLessThan(0.012);
    });
});
