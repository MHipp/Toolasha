/**
 * Tests for the Upgrade tab's second ranking pass: room levels gained.
 */

import { describe, test, expect } from 'vitest';

import {
    ROOM_LEVEL_SHORTLIST_SIZE,
    measureRoomLevelGains,
    shortlistForRoomLevels,
} from './labyrinth-upgrade-levels.js';

/** A results row as `runLabyrinthUpgradeAnalysis` builds them */
const row = (description, winRateDelta, over = {}) => ({
    candidate: { description },
    metricType: 'winRate',
    winRateDelta,
    ...over,
});

/**
 * A stand-in for the level finder that reports a level per row description.
 * @param {Object} levels - description → max level cleared; `null` key is the baseline
 * @returns {{measure: Function, calls: Array}}
 */
const finder = (levels) => {
    const calls = [];
    return {
        calls,
        measure: async (result) => {
            const key = result ? result.candidate.description : null;
            calls.push(key);
            return { maxLevel: levels[key] ?? levels[null], cleared: true, aborted: false };
        },
    };
};

describe('the shortlist', () => {
    test('takes the best-ranked candidates only, in order', () => {
        const results = [row('a', 0.01), row('b', 0.05), row('c', 0.03)];
        expect(shortlistForRoomLevels(results, 2).map((r) => r.candidate.description)).toEqual(['b', 'c']);
    });

    test('leaves out candidates that did not move the fight at all', () => {
        const results = [row('a', 0), row('b', -0.02), row('c', 0.01)];
        expect(shortlistForRoomLevels(results, 5).map((r) => r.candidate.description)).toEqual(['c']);
    });

    test('leaves out rows ranked on something other than the win rate', () => {
        const results = [row('xp', 0, { metricType: 'xpPerRoom', xpPerRoomDelta: 10 }), row('a', 0.01)];
        expect(shortlistForRoomLevels(results, 5).map((r) => r.candidate.description)).toEqual(['a']);
    });

    test('has a bounded default size', () => {
        expect(ROOM_LEVEL_SHORTLIST_SIZE).toBeGreaterThan(0);
        expect(ROOM_LEVEL_SHORTLIST_SIZE).toBeLessThanOrEqual(10);
    });
});

describe('measuring room levels gained', () => {
    test('a candidate that raises the cleared level by K reports +K', async () => {
        const results = [row('a', 0.05)];
        const { measure } = finder({ null: 120, a: 127 });
        const summary = await measureRoomLevelGains(results, { measure });
        expect(summary.baselineLevel).toBe(120);
        expect(results[0].roomLevelDelta).toBe(7);
        expect(results[0].maxRoomLevel).toBe(127);
        expect(results[0].roomLevelMeasured).toBe(true);
    });

    test('a candidate that changes nothing reports +0, not a blank', async () => {
        const results = [row('a', 0.05)];
        const { measure } = finder({ null: 120, a: 120 });
        await measureRoomLevelGains(results, { measure });
        expect(results[0].roomLevelDelta).toBe(0);
        expect(results[0].roomLevelMeasured).toBe(true);
    });

    test('the floor a candidate reaches comes from the same band model', async () => {
        const results = [row('a', 0.05)];
        const { measure } = finder({ null: 100, a: 120 });
        const summary = await measureRoomLevelGains(results, { measure });
        expect(summary.baselineFloor).toBe(4);
        expect(results[0].floorReached).toBe(5);
    });

    test('the expensive search runs on the shortlist only, once per row plus the baseline', async () => {
        const results = [row('a', 0.05), row('b', 0.04), row('c', 0.03), row('d', 0.02), row('e', 0.01)];
        const { measure, calls } = finder({ null: 100 });
        await measureRoomLevelGains(results, { measure, shortlistSize: 2 });
        expect(calls).toEqual([null, 'a', 'b']);
        expect(results.filter((r) => r.roomLevelMeasured)).toHaveLength(2);
    });

    test('an unmeasured row still reads +0 rather than blank', async () => {
        const results = [row('a', 0.05), row('b', 0.04)];
        const { measure } = finder({ null: 100, a: 110 });
        await measureRoomLevelGains(results, { measure, shortlistSize: 1 });
        expect(results[1].roomLevelDelta).toBe(0);
        expect(results[1].roomLevelMeasured).toBe(false);
    });

    test('cancelling mid-search stops the remaining probes and says so', async () => {
        const results = [row('a', 0.05), row('b', 0.04), row('c', 0.03)];
        const { measure, calls } = finder({ null: 100, a: 110 });
        const summary = await measureRoomLevelGains(results, {
            measure,
            shortlistSize: 3,
            abortSignal: () => calls.length >= 2,
        });
        expect(calls).toEqual([null, 'a']);
        expect(summary.aborted).toBe(true);
        expect(results[0].roomLevelMeasured).toBe(true);
        expect(results[1].roomLevelMeasured).toBe(false);
    });

    test('a baseline that clears nothing leaves every row unmeasured rather than inventing a delta', async () => {
        const results = [row('a', 0.05)];
        const summary = await measureRoomLevelGains(results, {
            measure: async () => ({ maxLevel: 0, cleared: false, aborted: false }),
        });
        expect(summary.baselineCleared).toBe(false);
        expect(results[0].roomLevelMeasured).toBe(false);
        expect(results[0].roomLevelDelta).toBe(0);
    });

    test('sorts the measured rows to the top by levels gained', async () => {
        const results = [row('a', 0.05), row('b', 0.04)];
        const { measure } = finder({ null: 100, a: 101, b: 130 });
        await measureRoomLevelGains(results, { measure, shortlistSize: 2 });
        expect(results.map((r) => r.candidate.description)).toEqual(['b', 'a']);
    });
});
