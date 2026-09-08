import { describe, test, expect, beforeEach, vi } from 'vitest';

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));

/** Win rate the mocked runner reports, as a function of room level */
const sim = vi.hoisted(() => ({ winRateAt: () => 1, probed: [], precisions: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
        setSettingValue: (key, value) => settings.map.set(key, value),
    },
}));

vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async ({ roomLevel, precision }) => {
        sim.probed.push(roomLevel);
        sim.precisions.push(precision || {});
        const attempts = 1000;
        return {
            labyAttemptCount: attempts,
            encounters: Math.round(sim.winRateAt(roomLevel) * attempts),
            simulatedTime: 20e9 * attempts,
        };
    },
}));

// The finder only wants the shared search range off this module; everything
// else in it drags in the whole labyrinth panel
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ SKIP_THRESHOLD_RANGE: 1000, default: {} }));

const { findMaxLabyrinthLevel, searchWindowFor, defaultThreshold } = await import('./labyrinth-level-finder.js');

const params = (over = {}) => ({
    gameData: {},
    playerDTOs: [],
    zoneHrid: '/actions/combat/fly',
    monsterHrid: '/monsters/imp',
    crates: [],
    communityBuffs: {},
    ...over,
});

beforeEach(() => {
    settings.map.clear();
    sim.probed = [];
    sim.precisions = [];
    sim.winRateAt = () => 1;
});

describe('the search window', () => {
    test('follows the character rather than a fixed 20-300', () => {
        // A level-1500 character was once capped at a fixed 300 — below their
        // own level, so Find Max could not answer the question at all
        expect(searchWindowFor(1500)).toEqual({ minLevel: 500, maxLevel: 2499 });
    });

    test('never goes below level 1, however low the character is', () => {
        expect(searchWindowFor(10).minLevel).toBe(1);
    });

    test('an unknown level searches the whole positive range rather than inventing one', () => {
        expect(searchWindowFor(null)).toEqual({ minLevel: 1, maxLevel: 1000 });
    });
});

describe('the clear-rate bar', () => {
    test('is the panel’s Target Win % setting, so Find Max and Recommend agree', () => {
        settings.map.set('labyrinthRecommendTargetRate', 82);
        expect(defaultThreshold()).toBeCloseTo(0.82, 10);
    });

    test('falls back to the schema default of 70, not to 95', () => {
        expect(defaultThreshold()).toBeCloseTo(0.7, 10);
    });
});

describe('findMaxLabyrinthLevel', () => {
    test('finds the highest level meeting the bar', async () => {
        sim.winRateAt = (level) => (level <= 150 ? 0.9 : 0.1);
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        expect(result.maxLevel).toBe(150);
        expect(result.cleared).toBe(true);
        expect(result.atCeiling).toBe(false);
    });

    test('nothing clearing reports so instead of a level of zero', async () => {
        sim.winRateAt = () => 0;
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        expect(result.cleared).toBe(false);
        expect(result.maxLevel).toBe(0);
        // The caller needs the window to say what was ruled out
        expect(result.minLevel).toBe(1);
        expect(result.maxSearched).toBe(1119);
    });

    test('still clearing at the top of the window is flagged, not reported as the answer', async () => {
        sim.winRateAt = () => 1;
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        expect(result.atCeiling).toBe(true);
        expect(result.maxLevel).toBe(result.maxSearched);
    });

    test('the bar comes from the setting when the caller passes none', async () => {
        settings.map.set('labyrinthRecommendTargetRate', 50);
        sim.winRateAt = (level) => (level <= 200 ? 0.6 : 0.1);
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        // 0.6 clears a 50% bar and would have failed the old hardcoded 95%
        expect(result.threshold).toBeCloseTo(0.5, 10);
        expect(result.maxLevel).toBe(200);
    });

    test('probes stay inside the window', async () => {
        sim.winRateAt = (level) => (level <= 150 ? 0.9 : 0.1);
        await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        expect(Math.min(...sim.probed)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...sim.probed)).toBeLessThanOrEqual(1119);
    });

    test('an explicit window overrides the derived one', async () => {
        sim.winRateAt = () => 1;
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120, minLevel: 10, maxLevel: 20 }));
        expect(result.minLevel).toBe(10);
        expect(result.maxSearched).toBe(20);
        expect(result.maxLevel).toBe(20);
    });

    test('reports the fight length at the level it lands on, for a throughput figure', async () => {
        sim.winRateAt = (level) => (level <= 150 ? 0.9 : 0.1);
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120 }));
        expect(result.avgFightSeconds).toBeCloseTo(20, 6);
    });
});

describe('cancelling a search', () => {
    test('stops probing the moment the abort signal is raised', async () => {
        sim.winRateAt = () => 1;
        const result = await findMaxLabyrinthLevel(
            params({ referenceLevel: 120, abortSignal: () => sim.probed.length >= 2 })
        );
        // Two probes, not the dozen a 1-1119 binary search would take
        expect(sim.probed.length).toBe(2);
        expect(result.aborted).toBe(true);
    });

    test('an unaborted search does not claim to have been aborted', async () => {
        sim.winRateAt = (level) => (level <= 150 ? 0.9 : 0.1);
        const result = await findMaxLabyrinthLevel(params({ referenceLevel: 120, abortSignal: () => false }));
        expect(result.aborted).toBe(false);
        expect(result.maxLevel).toBe(150);
    });

    test('the probe trial cap can be tightened to the tab’s Max fights', async () => {
        sim.winRateAt = () => 1;
        await findMaxLabyrinthLevel(params({ referenceLevel: 120, maxTrials: 250 }));
        expect(sim.precisions.every((p) => p.maxTrials === 250)).toBe(true);
    });
});
