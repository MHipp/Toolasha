/**
 * The combat loot recorder keeps readings of the run's running total, and the
 * attribution decides what they are worth; so what is pinned here is the
 * reading itself — whose loot it is, how two slots of one item add up, which
 * reading of a day survives — and the ownership rules that keep one
 * character's battle out of another's record.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { dropKey, ownLootCounts, foldObservation, offlineWindowOf, foldOffline } from './combat-loot-recorder.js';

/** What the fake chunked store was handed to write */
const hoisted = vi.hoisted(() => ({ saved: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        isQuotaExceeded: () => false,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        getJSON: async (_key, _store, fallback = null) => fallback,
        setJSON: async () => true,
        flushAll: async () => {},
    },
}));

vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: () => '2026-08-20',
    createChunkedHistory: () => ({
        load: async () => [],
        save: (_charId, rows) => hoisted.saved.push(JSON.parse(JSON.stringify(rows))),
        forget: () => {},
    }),
}));

/** One player's slot of a `totalLootMap` */
const slot = (itemHrid, count, enhancementLevel = 0) => ({ itemHrid, count, enhancementLevel });

/** A `new_battle` payload for a party */
const battle = (players, combatStartTime = '2026-08-20T08:00:00.000Z') => ({ combatStartTime, players });

describe('ownLootCounts', () => {
    test('reads the character by id, never somebody else in the party', () => {
        const data = battle([
            { character: { id: 7, name: 'Leader' }, totalLootMap: { a: slot('/items/cheese', 900) } },
            { character: { id: 42, name: 'Me' }, totalLootMap: { a: slot('/items/milk', 3) } },
        ]);
        expect(ownLootCounts(data, 42)).toEqual({ '/items/milk': 3 });
    });

    test('a party message the character is not in reads nothing, rather than the first player', () => {
        const data = battle([{ character: { id: 7 }, totalLootMap: { a: slot('/items/cheese', 900) } }]);
        expect(ownLootCounts(data, 42)).toBeNull();
        expect(ownLootCounts(data, null)).toBeNull();
    });

    test('two slots of one item add, and an enhanced drop keeps its level', () => {
        const data = battle([
            {
                character: { id: 42 },
                totalLootMap: {
                    a: slot('/items/milk', 2),
                    b: slot('/items/milk', 3),
                    c: slot('/items/sword', 1, 5),
                    d: slot('/items/coin', 250),
                },
            },
        ]);
        expect(ownLootCounts(data, 42)).toEqual({ '/items/milk': 5, '/items/sword::5': 1, '/items/coin': 250 });
    });

    test('drop keys match the loot log’s, so the attribution prices both alike', () => {
        expect(dropKey('/items/milk', 0)).toBe('/items/milk');
        expect(dropKey('/items/sword', 5)).toBe('/items/sword::5');
    });
});

describe('foldObservation', () => {
    const MINUTE = 60_000;

    test('within a stretch, the first reading stays and the latest replaces the last', () => {
        const row = { d: '2026-08-20', runs: {} };
        foldObservation(row, 'run', 1000, { '/items/milk': 1 });
        foldObservation(row, 'run', 2000, { '/items/milk': 4 });
        foldObservation(row, 'run', 3000, { '/items/milk': 9 });

        expect(row.runs.run.stretches).toEqual([
            { first: { t: 1000, loot: { '/items/milk': 1 } }, last: { t: 3000, loot: { '/items/milk': 9 } } },
        ]);
    });

    test('a silence opens a new stretch, so the total either side of it is kept', () => {
        // The tab closed at the first stretch's end and reopened hours later:
        // what the run gained in between is the difference across the gap, and
        // only readings on both sides of it can say so
        const row = { d: '2026-08-20', runs: {} };
        foldObservation(row, 'run', 0, { '/items/milk': 1 });
        foldObservation(row, 'run', 5 * MINUTE, { '/items/milk': 3 });
        foldObservation(row, 'run', 240 * MINUTE, { '/items/milk': 40 });
        foldObservation(row, 'run', 245 * MINUTE, { '/items/milk': 41 });

        const ends = row.runs.run.stretches.map(({ first, last }) => [first.t, last.t]);
        expect(ends).toEqual([
            [0, 5 * MINUTE],
            [240 * MINUTE, 245 * MINUTE],
        ]);
    });

    test('a reading older than the latest is out of order and ignored', () => {
        const row = { d: '2026-08-20', runs: {} };
        foldObservation(row, 'run', 2000, { '/items/milk': 4 });
        foldObservation(row, 'run', 1000, { '/items/milk': 1 });
        expect(row.runs.run.stretches[0].last.t).toBe(2000);
    });

    test('two runs on one day are kept apart, because they are two running totals', () => {
        const row = { d: '2026-08-20', runs: {} };
        foldObservation(row, 'morning', 1000, { '/items/milk': 5 });
        foldObservation(row, 'evening', 9000, { '/items/log': 2 });
        expect(Object.keys(row.runs)).toEqual(['morning', 'evening']);
    });

    test('a later reading never mutates the first one it replaced', () => {
        const counts = { '/items/milk': 1 };
        const row = foldObservation({ d: '2026-08-20' }, 'run', 1000, counts);
        counts['/items/milk'] = 99;
        foldObservation(row, 'run', 2000, { '/items/milk': 2 });
        expect(row.runs.run.stretches[0].first.loot).toEqual({ '/items/milk': 1 });
    });
});

describe('offline windows', () => {
    const payload = (offlineItems) => ({
        offlineItems,
        currentTimestamp: '2026-08-20T08:00:00.000Z',
        character: { id: 42, lastOfflineTime: '2026-08-20T00:00:00.000Z' },
    });

    test('a summary that carried items claims its window', () => {
        expect(offlineWindowOf(payload([{ itemHrid: '/items/milk', offlineCount: 3 }]))).toEqual([
            Date.parse('2026-08-20T00:00:00.000Z'),
            Date.parse('2026-08-20T08:00:00.000Z'),
        ]);
    });

    test('an offline period that gained nothing claims nothing', () => {
        // The offline row counted nothing for it, so there is nothing for the
        // combat row to stand aside for
        expect(offlineWindowOf(payload([]))).toBeNull();
        expect(
            offlineWindowOf({ ...payload([{ itemHrid: '/items/milk', offlineCount: 1 }]), character: {} })
        ).toBeNull();
    });

    test('the same window folded twice is kept once', () => {
        const row = { d: '2026-08-20' };
        foldOffline(row, [1, 2]);
        foldOffline(row, [1, 2]);
        expect(row.offline).toEqual([[1, 2]]);
    });
});

/**
 * Driven through the real WebSocket hook, like the chest recorder's ownership
 * test: hook → socket context → the ownership checks → the row that is or is not
 * written.
 */
describe('a battle from the old character’s socket', () => {
    const socketOld = { url: 'wss://api.milkywayidle.com/ws', id: 'old' };
    const socketNew = { url: 'wss://api.milkywayidle.com/ws', id: 'new' };

    /** One `new_battle`, as the server sends it */
    const battleMessage = (characterId) =>
        JSON.stringify({
            type: 'new_battle',
            ...battle([{ character: { id: characterId }, totalLootMap: { a: slot('/items/milk', 4) } }]),
        });

    beforeEach(async () => {
        const { default: dataManager } = await import('../../core/data-manager.js');
        const { default: recorder } = await import('./combat-loot-recorder.js');

        hoisted.saved = [];
        recorder.cleanup();
        recorder._rows = [];
        recorder._charId = null;
        recorder._loading = null;

        dataManager.currentCharacterId = 'char-new';
        dataManager.activeSocket = socketNew;
    });

    afterEach(async () => {
        const { default: dataManager } = await import('../../core/data-manager.js');
        const { default: recorder } = await import('./combat-loot-recorder.js');
        recorder.cleanup();
        dataManager.activeSocket = null;
        dataManager.currentCharacterId = null;
    });

    test('is not recorded against the character that was switched to', async () => {
        const { default: webSocketHook } = await import('../../core/websocket.js');
        const { default: recorder } = await import('./combat-loot-recorder.js');
        await recorder.initialize();

        webSocketHook.processMessage(battleMessage('char-new'), socketOld);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorder._rows).toEqual([]);
        expect(hoisted.saved).toEqual([]);
    });

    test("but the same battle on the active character's socket is", async () => {
        const { default: webSocketHook } = await import('../../core/websocket.js');
        const { default: recorder } = await import('./combat-loot-recorder.js');
        await recorder.initialize();

        webSocketHook.processMessage(battleMessage('char-new'), socketNew);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorder._rows).toHaveLength(1);
        const runs = Object.values(recorder._rows[0].runs);
        expect(runs).toHaveLength(1);
        expect(runs[0].stretches[0].last.loot).toEqual({ '/items/milk': 4 });
        expect(hoisted.saved).toHaveLength(1);
    });

    test('a battle the character is not in is not recorded at all', async () => {
        const { default: webSocketHook } = await import('../../core/websocket.js');
        const { default: recorder } = await import('./combat-loot-recorder.js');
        await recorder.initialize();

        webSocketHook.processMessage(battleMessage('someone-else'), socketNew);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(recorder._rows).toEqual([]);
    });
});
