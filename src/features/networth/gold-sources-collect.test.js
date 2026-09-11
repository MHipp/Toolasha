/**
 * The live combat session joining the archived ones.
 *
 * The attribution math is tested in `gold-sources.test.js`; what this pins is
 * the wiring bug it cannot see — a character deep in one long, never-archived
 * fight had today's whole loot in no session at all, so the combat row read 0
 * while the residual carried the day.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    archived: [],
    live: null,
    /** What the collector holds but withholds from the overlay: a restored run that has ended */
    lastRun: undefined,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getActionDetails: () => null },
}));
vi.mock('../market/trade-ledger-store.js', () => ({
    default: { isReady: () => false, getRecords: () => [] },
}));
vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => game.archived,
    sessionKey: (data) =>
        data?.players?.length && data?.combatStartTime
            ? `${data.players.map((p) => p.name).join(',')}|${data.combatStartTime}`
            : null,
    MAX_SESSIONS: 20,
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: {
        getLatestData: () => game.live,
        getLastRun: () => (game.lastRun === undefined ? game.live : game.lastRun),
    },
}));
vi.mock('../enhancement/enhancement-storage.js', () => ({ loadSessions: async () => ({}) }));
vi.mock('../alchemy/alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({ load: async () => [] }),
    NO_CHARACTER: 'none',
}));
vi.mock('../actions/loot-log-history.js', () => ({
    default: { getHistoricalEntries: async () => [] },
}));
vi.mock('./networth-history.js', () => ({ default: { getHistory: () => [] } }));
vi.mock('./production-income-recorder.js', () => ({ default: { load: async () => [] } }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0 }));
vi.mock('./networth-calculator.js', () => ({
    calculateCraftingCost: (itemHrid) => (itemHrid === '/items/culinary_cape' ? 300_000 : 0),
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { isInitialized: false, calculateExpectedValue: () => null },
}));

const { collectGoldSourceInputs, createBasisPricer } = await import('./gold-sources-collect.js');

const session = (start, names = ['Me']) => ({
    key: `${names.join(',')}|${start}`,
    combatStartTime: start,
    players: names.map((name) => ({ name, isCurrentPlayer: true, loot: {} })),
});

beforeEach(() => {
    game.archived = [];
    game.live = null;
    game.lastRun = undefined;
});

describe('the live combat session', () => {
    test('a run in progress counts even though nothing has archived it yet', async () => {
        game.live = {
            combatStartTime: '2026-08-28T01:00:00Z',
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }],
        };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
        expect(inputs.combatSessions[0].combatStartTime).toBe('2026-08-28T01:00:00Z');
    });

    test('a live run the archive already holds is not counted twice', async () => {
        game.archived = [session('2026-08-28T01:00:00Z')];
        game.live = {
            combatStartTime: '2026-08-28T01:00:00Z',
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }],
        };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
    });

    test('a run that ended before a reload counts though the overlay withholds it', async () => {
        // Restored from storage, over, and not yet archived — the archive only
        // takes a run when the next one starts. The overlay is right to hide it;
        // the ledger is not, or its loot is gone until the character fights again
        game.live = null;
        game.lastRun = {
            combatStartTime: '2026-08-28T01:00:00Z',
            restored: true,
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }],
        };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
        expect(inputs.combatSessions[0].combatStartTime).toBe('2026-08-28T01:00:00Z');
    });

    test('no live run means the archive alone, and an empty one stays out', async () => {
        game.archived = [session('2026-08-27T01:00:00Z')];
        game.live = { combatStartTime: '2026-08-28T01:00:00Z', players: [] };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
        expect(inputs.combatSessions[0].combatStartTime).toBe('2026-08-27T01:00:00Z');
    });
});

describe('the cost-basis pricer', () => {
    test('falls back to material cost for a base item the market cannot price', () => {
        const basis = createBasisPricer(() => null);
        expect(basis('/items/culinary_cape', 0)).toBe(300_000);
    });

    test('never answers an enhanced lookup with the base item’s cost', () => {
        // A decompose session records the enhancement level of what it ate,
        // and a +8 cape is worth far more than its +0 materials. Falling back
        // to the base figure silently mis-costed the session; null sends it
        // to the counted "could not be valued" path instead.
        const basis = createBasisPricer(() => null);
        expect(basis('/items/culinary_cape', 8)).toBeNull();
    });

    test('a real market price is used at any level before any fallback', () => {
        const basis = createBasisPricer((itemHrid, level) => (level === 8 ? 5_000_000 : null));
        expect(basis('/items/culinary_cape', 8)).toBe(5_000_000);
    });
});
