/** @vitest-environment happy-dom
 *
 * The store needs a DOM only for the page-lifecycle handlers that flush an
 * armed save; everything else here is arithmetic over a stored list.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    saved: {},
    actionDetails: {},
    characterId: 'market123',
    characterName: 'MarketCow',
    // Flipped to stand in for a dropped IndexedDB connection
    unreadable: false,
    // Every write, as [key, immediate]
    writes: [],
    // event name → handlers the store registered on the data manager
    listeners: {},
    /** Fired once inside the next read — lets a test land a switch inside it */
    onRead: null,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key, storeName) => {
            // A handler may return a promise to hold this read open, which is
            // how a test lands other work inside one. What the read answers is
            // snapshotted first, as IndexedDB does: a write that lands while
            // the read is outstanding is not visible to it.
            const hold = game.onRead?.();
            if (game.unreadable) return null;
            const value = game.saved[storeName]?.[key];
            const result = value == null ? { found: false, value: null } : { found: true, value };
            if (hold) await hold;
            return result;
        },
        getJSON: async (key, storeName, defaultValue) => game.saved[storeName]?.[key] ?? defaultValue,
        setJSON: async (key, value, storeName, immediate = false) => {
            game.writes.push([key, immediate]);
            game.saved[storeName] = game.saved[storeName] || {};
            // What IndexedDB would hold: a copy, not the live array
            game.saved[storeName][key] = structuredClone(value);
            return true;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => game.actionDetails[hrid],
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterName: () => game.characterName,
        on: (event, handler) => {
            (game.listeners[event] = game.listeners[event] || []).push(handler);
        },
    },
}));

const {
    default: dungeonTrackerStorage,
    runMatchesCharacter,
    filterRunsForCharacter,
    mergeRuns,
    mergeRunHistories,
    mergeClearEpochs,
    mergeAverageBaselines,
    applyClearEpoch,
    PERSIST_COALESCE_MS,
    RUNS_STORE,
    RUNS_KEY,
    RUNS_CLEARED_KEY,
    RUNS_DATE_REPAIR_KEY,
    AVERAGE_BASELINE_KEY,
    swapMonthDay,
    rederiveSwappedRun,
} = await import('./dungeon-tracker-storage.js');

const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

function seedRuns(runs) {
    game.saved.unifiedRuns = { allRuns: runs };
    dungeonTrackerStorage._resetCache();
}

beforeEach(() => {
    game.onRead = null;
    game.unreadable = false;
    game.writes = [];
    dungeonTrackerStorage._resetCache();
});

describe('getDungeonKey', () => {
    test('combines dungeon hrid and tier', () => {
        expect(dungeonTrackerStorage.getDungeonKey('/actions/combat/chimerical_den', 1)).toBe(
            '/actions/combat/chimerical_den::T1'
        );
    });
});

describe('getDungeonInfo', () => {
    beforeEach(() => {
        game.actionDetails = {};
    });

    test('returns null for an unknown dungeon', () => {
        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/nope')).toBeNull();
    });

    test('reads name and maxWaves from game data when present', () => {
        game.actionDetails['/actions/combat/chimerical_den'] = {
            name: 'Chimerical Den',
            combatZoneInfo: { dungeonInfo: { maxWaves: 50 } },
        };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/chimerical_den')).toEqual({
            name: 'Chimerical Den',
            maxWaves: 50,
        });
    });

    test('falls back to the hardcoded max-wave table when game data has none', () => {
        game.actionDetails['/actions/combat/pirate_cove'] = { name: 'Pirate Cove', combatZoneInfo: {} };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/pirate_cove').maxWaves).toBe(65);
    });

    test('derives a title-cased name from the hrid when the game gives none', () => {
        game.actionDetails['/actions/combat/enchanted_fortress'] = { combatZoneInfo: {} };

        expect(dungeonTrackerStorage.getDungeonInfo('/actions/combat/enchanted_fortress').name).toBe(
            'Enchanted Fortress'
        );
    });
});

describe('getTeamKey', () => {
    test('sorts names into a stable, order-independent key', () => {
        expect(dungeonTrackerStorage.getTeamKey(['Zed', 'Anna', 'Mike'])).toBe('Anna,Mike,Zed');
        expect(dungeonTrackerStorage.getTeamKey(['Mike', 'Zed', 'Anna'])).toBe('Anna,Mike,Zed');
    });
});

describe('getStatsByName', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('an unknown dungeon reports all zeros rather than throwing', async () => {
        seedRuns([]);
        expect(await dungeonTrackerStorage.getStatsByName('Nowhere')).toEqual({
            totalRuns: 0,
            avgTime: 0,
            fastestTime: 0,
            slowestTime: 0,
            avgWaveTime: 0,
        });
    });

    test('averages, fastest and slowest come from that dungeon only', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', duration: 100, avgWaveTime: 2 },
            { dungeonName: 'Chimerical Den', duration: 300, avgWaveTime: 6 },
            { dungeonName: 'Sinister Circus', duration: 9999, avgWaveTime: 99 },
        ]);

        const stats = await dungeonTrackerStorage.getStatsByName('Chimerical Den');

        expect(stats.totalRuns).toBe(2);
        expect(stats.avgTime).toBe(200);
        expect(stats.fastestTime).toBe(100);
        expect(stats.slowestTime).toBe(300);
        expect(stats.avgWaveTime).toBe(4);
    });

    test('websocket-based totalTime and chat-based duration are both understood', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', totalTime: 120 },
            { dungeonName: 'Chimerical Den', duration: 180 },
        ]);

        const stats = await dungeonTrackerStorage.getStatsByName('Chimerical Den');

        expect(stats.avgTime).toBe(150);
    });
});

describe('saveTeamRun', () => {
    test('a run recorded with per-wave times keeps them', async () => {
        seedRuns([]);
        const waveTimes = [3000, 5000, 4000];
        await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-05T00:00:00Z',
            duration: 12000,
            dungeonName: 'Chimerical Den',
            waveTimes,
            avgWaveTime: 4000,
        });

        const [saved] = await dungeonTrackerStorage.getAllRuns();
        expect(saved.waveTimes).toEqual(waveTimes);
        expect(saved.avgWaveTime).toBe(4000);
    });

    test('a chat run, which carries no waves, is stored with none', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-05T00:00:00Z',
            duration: 12000,
            dungeonName: 'Chimerical Den',
        });

        const [saved] = await dungeonTrackerStorage.getAllRuns();
        expect(saved.waveTimes).toBeNull();
        expect(saved.avgWaveTime).toBeNull();
    });

    test('a tracker run arriving as a duplicate of a chat run fills in its wave times', async () => {
        seedRuns([]);
        const base = { timestamp: '2026-01-05T00:00:00Z', duration: 12000, dungeonName: 'Chimerical Den' };
        await dungeonTrackerStorage.saveTeamRun('C,D', base); // chat saw it first: no waves, no tier
        await dungeonTrackerStorage.saveTeamRun('C,D', {
            ...base,
            tier: 2,
            waveTimes: [3000, 5000, 4000],
            avgWaveTime: 4000,
        });

        const runs = await dungeonTrackerStorage.getAllRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0].waveTimes).toEqual([3000, 5000, 4000]);
        expect(runs[0].avgWaveTime).toBe(4000);
        expect(runs[0].tier).toBe(2);
    });

    test('a chat run arriving as a duplicate does not erase a tracker run’s wave times', async () => {
        seedRuns([]);
        const base = { timestamp: '2026-01-05T00:00:00Z', duration: 12000, dungeonName: 'Chimerical Den' };
        await dungeonTrackerStorage.saveTeamRun('C,D', { ...base, waveTimes: [3000, 5000, 4000], avgWaveTime: 4000 });
        await dungeonTrackerStorage.saveTeamRun('C,D', base);

        const runs = await dungeonTrackerStorage.getAllRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0].waveTimes).toEqual([3000, 5000, 4000]);
    });

    beforeEach(() => {
        game.saved = {};
    });

    test('saves a new run to the front of the list', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
        const allRuns = game.saved.unifiedRuns.allRuns;
        expect(allRuns).toHaveLength(2);
        expect(allRuns[0].teamKey).toBe('C,D');
        expect(allRuns[0].team).toEqual(['C', 'D']);
        expect(allRuns[0].validated).toBe(true);
        expect(allRuns[0].source).toBe('chat');
    });

    test('a run within 10s, same team, and duration within 2s of an existing one is a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('A,B', {
            timestamp: '2026-01-01T00:00:05.000Z',
            duration: 501,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(false);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('a backfilled run and the tracker’s own record of it are one run', async () => {
        // The tracker banks the server's millisecond stamp for the key count
        // that opened the run; the chat backfill can only read that same
        // message's rendered stamp, which the game prints truncated to the
        // second. Same run, same start second, and the durations each route
        // measured need not agree to within the two seconds the tolerance
        // check allows.
        seedRuns([{ timestamp: '2026-01-01T00:00:00.431Z', teamKey: 'A,B', duration: 600_000 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('A,B', {
            timestamp: '2026-01-01T00:00:00.000Z',
            duration: 594_000,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(false);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('a different team at the same moment is not a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-01T00:00:01.000Z',
            duration: 500,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
    });

    test('a similar run outside the 10s window is not a duplicate', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00.000Z', teamKey: 'A,B', duration: 500 }]);

        const saved = await dungeonTrackerStorage.saveTeamRun('A,B', {
            timestamp: '2026-01-01T00:00:15.000Z',
            duration: 500,
            dungeonName: 'Chimerical Den',
        });

        expect(saved).toBe(true);
    });

    test('missing dungeonName defaults to Unknown', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns[0].dungeonName).toBe('Unknown');
    });

    test('reads work from memory; a save folds in whatever storage holds', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();

        // Storage emptied behind memory's back loses nothing: memory still has it
        game.saved.unifiedRuns.allRuns = [];
        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 });
        await dungeonTrackerStorage.flushPendingSave();

        expect((await dungeonTrackerStorage.getAllRuns()).map((r) => r.teamKey)).toEqual(['C,D', 'A,B']);
        expect(game.saved.unifiedRuns.allRuns.map((r) => r.teamKey)).toEqual(['C,D', 'A,B']);
    });

    test('a burst of appends costs one read-merge-write, not one per run', async () => {
        seedRuns([]);
        // A chat backfill: several runs recovered in one sweep. Each used to
        // read the whole history back and re-sort it before writing
        for (let i = 0; i < 5; i += 1) {
            await dungeonTrackerStorage.saveTeamRun('A,B', {
                timestamp: `2026-01-0${i + 1}T00:00:00Z`,
                duration: 500,
            });
        }

        // Nothing on disk yet, and every reader already sees all five
        expect(game.writes).toEqual([]);
        expect(await dungeonTrackerStorage.getAllRuns()).toHaveLength(5);

        await dungeonTrackerStorage.flushPendingSave();

        expect(game.writes).toHaveLength(1);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(5);
    });

    test('a deferred save still takes the store’s own write debounce', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });
        await new Promise((resolve) => setTimeout(resolve, PERSIST_COALESCE_MS + 20));

        expect(game.writes.map(([, immediate]) => immediate)).toEqual([false]);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('the page going away flushes a save still inside its coalescing window', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });

        // Nothing has reached the store yet, so storage.flushAll() has nothing
        // of ours to drain — the run exists only in this object
        expect(game.writes).toEqual([]);

        // No manual flush: the handler is the whole point
        window.dispatchEvent(new Event('pagehide'));
        await dungeonTrackerStorage._persistChain;

        expect(game.writes).toEqual([['allRuns', true]]);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('a tab hidden inside the window flushes too', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });

        expect(game.writes).toEqual([]);

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await dungeonTrackerStorage._persistChain;

        expect(game.writes).toEqual([['allRuns', true]]);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('a character switch writes the departing character’s run first', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });

        expect(game.listeners.character_switching || []).not.toHaveLength(0);
        for (const handler of game.listeners.character_switching) handler({});
        await dungeonTrackerStorage._persistChain;

        expect(game.saved.unifiedRuns.allRuns).toHaveLength(1);
    });

    test('forgetting everything disarms a save that would have merged it back', async () => {
        seedRuns([]);
        await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 });
        await dungeonTrackerStorage.clearAllRuns();

        await new Promise((resolve) => setTimeout(resolve, PERSIST_COALESCE_MS + 20));

        expect(game.saved.unifiedRuns.allRuns).toEqual([]);
    });

    test('a run is not written over a history that could not be read first', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        game.unreadable = true;

        const saved = await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
        });

        expect(saved).toBe(false);
        expect(game.writes).toEqual([]);
        expect(await dungeonTrackerStorage.getAllRuns()).toEqual([]);

        // Once storage reads again the history is there and the save lands
        game.unreadable = false;
        expect(
            await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 })
        ).toBe(true);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(2);
    });

    test('getAllRuns hands out a copy, so a caller sorting it cannot reorder the store', async () => {
        seedRuns([
            { timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 },
        ]);
        const runs = await dungeonTrackerStorage.getAllRuns();
        runs.reverse();
        expect((await dungeonTrackerStorage.getAllRuns())[0].timestamp).toBe('2026-01-02T00:00:00Z');
    });
});

describe('deleting runs', () => {
    test('deleteRun drops the run at a timestamp and writes at once', async () => {
        seedRuns([
            { timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 },
        ]);

        await dungeonTrackerStorage.deleteRun('2026-01-01T00:00:00Z');

        expect(game.writes).toEqual([['allRuns', true]]);
        expect(game.saved.unifiedRuns.allRuns.map((r) => r.timestamp)).toEqual(['2026-01-02T00:00:00Z']);
        // The duplicate check no longer sees the deleted run either
        expect(
            await dungeonTrackerStorage.saveTeamRun('A,B', { timestamp: '2026-01-01T00:00:00Z', duration: 500 })
        ).toBe(true);
    });

    test('clearAllRuns empties the list and writes at once', async () => {
        seedRuns([{ timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 }]);

        await dungeonTrackerStorage.clearAllRuns();

        // The clear epoch beside the emptied list, so a pull cannot undo it
        expect(game.writes).toEqual([
            ['allRunsClearedAt', true],
            ['allRuns', true],
        ]);
        expect(game.saved.unifiedRuns.allRuns).toEqual([]);
        expect(await dungeonTrackerStorage.getAllRuns()).toEqual([]);
    });
});

describe('a second tab writing the same account-wide key', () => {
    beforeEach(() => {
        game.saved = {};
    });

    // A real read hands back a fresh deserialized array, so the other tab's
    // append must not be visible through the array this tab already holds
    function otherTabAppends(run) {
        game.saved.unifiedRuns.allRuns = [...structuredClone(game.saved.unifiedRuns.allRuns), run];
    }

    test("a save keeps the other tab's runs instead of overwriting them", async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();

        // The other tab records a run after this one read the list
        otherTabAppends({ timestamp: '2026-01-01T12:00:00Z', teamKey: 'X,Y', duration: 400 });

        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns.map((r) => r.teamKey)).toEqual(['C,D', 'X,Y', 'A,B']);
        expect((await dungeonTrackerStorage.getAllRuns()).map((r) => r.teamKey)).toEqual(['C,D', 'X,Y', 'A,B']);
    });

    test('the same run seen by both tabs is kept once', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();

        // Byte-identical copy of what memory already holds
        otherTabAppends({ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 });

        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-02T00:00:00Z', duration: 700 });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns).toHaveLength(2);
    });

    test('a deleted run is not resurrected by a later merge', async () => {
        seedRuns([
            { timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 },
        ]);

        await dungeonTrackerStorage.deleteRun('2026-01-01T00:00:00Z');
        // A copy written before the delete landed comes back — a slow tab, a sync pull
        otherTabAppends({ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 });

        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-03T00:00:00Z', duration: 700 });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns.map((r) => r.timestamp)).toEqual([
            '2026-01-03T00:00:00Z',
            '2026-01-02T00:00:00Z',
        ]);
    });

    test('a scrubbed outlier stays scrubbed across a later merge', async () => {
        const group = Array.from({ length: 5 }, (_, i) => ({
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
            timestamp: `2026-01-0${i + 1}T00:00:00Z`,
            duration: 100,
        }));
        const outlier = {
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
            timestamp: '2026-01-06T00:00:00Z',
            duration: 5000,
        };
        seedRuns([...group, outlier]);

        expect(await dungeonTrackerStorage.scrubOutlierRuns()).toBe(1);
        otherTabAppends({ ...outlier });

        await dungeonTrackerStorage.saveTeamRun('C,D', { timestamp: '2026-01-07T00:00:00Z', duration: 700 });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns.some((r) => r.duration === 5000)).toBe(false);
    });

    test('clearAllRuns empties the key outright rather than merging it back', async () => {
        seedRuns([{ timestamp: '2026-01-02T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();
        otherTabAppends({ timestamp: '2026-01-01T00:00:00Z', teamKey: 'X,Y', duration: 500 });

        await dungeonTrackerStorage.clearAllRuns();

        expect(game.saved.unifiedRuns.allRuns).toEqual([]);
    });

    test('a save is skipped, not blindly written, when the pre-write read fails', async () => {
        seedRuns([{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        await dungeonTrackerStorage.getAllRuns();
        game.writes = [];

        game.unreadable = true;
        expect(await dungeonTrackerStorage.deleteRun('2026-01-01T00:00:00Z')).toBe(false);
        expect(game.writes).toEqual([]);
    });
});

describe('mergeRuns', () => {
    test('memory wins on a tie, so an amended run is not replaced by its stored copy', () => {
        const memory = [{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500, tier: 2 }];
        const stored = [{ timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', duration: 500, tier: null }];

        const merged = mergeRuns(memory, stored);

        expect(merged).toHaveLength(1);
        expect(merged[0].tier).toBe(2);
    });

    test('runs without a usable timestamp keep the order they came in', () => {
        const merged = mergeRuns([{ teamKey: 'A' }, { teamKey: 'B' }], [{ teamKey: 'C' }]);
        expect(merged.map((r) => r.teamKey)).toEqual(['A', 'B', 'C']);
    });
});

describe('getFilteredRuns', () => {
    beforeEach(() => {
        game.saved = {};
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B' },
            { dungeonName: 'Chimerical Den', teamKey: 'C,D' },
            { dungeonName: 'Sinister Circus', teamKey: 'A,B' },
        ]);
    });

    test('with no filters, returns everything', async () => {
        expect(await dungeonTrackerStorage.getFilteredRuns()).toHaveLength(3);
    });

    test('filters by dungeon name', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({ dungeonName: 'Chimerical Den' });
        expect(runs).toHaveLength(2);
    });

    test('"all" as a dungeon name is treated as no filter', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({ dungeonName: 'all' });
        expect(runs).toHaveLength(3);
    });

    test('filters by both dungeon and team together', async () => {
        const runs = await dungeonTrackerStorage.getFilteredRuns({
            dungeonName: 'Chimerical Den',
            teamKey: 'C,D',
        });
        expect(runs).toHaveLength(1);
        expect(runs[0].teamKey).toBe('C,D');
    });
});

describe('getAllTeamStats', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('solo runs with no teamKey are excluded', async () => {
        seedRuns([
            { teamKey: null, duration: 100 },
            { teamKey: 'A,B', duration: 200 },
        ]);

        const stats = await dungeonTrackerStorage.getAllTeamStats();

        expect(stats).toHaveLength(1);
        expect(stats[0].teamKey).toBe('A,B');
    });

    test('computes average, best (min) and worst (max) time per team', async () => {
        seedRuns([
            { teamKey: 'A,B', duration: 300 },
            { teamKey: 'A,B', duration: 100 },
            { teamKey: 'A,B', duration: 200 },
        ]);

        const [stats] = await dungeonTrackerStorage.getAllTeamStats();

        expect(stats.runCount).toBe(3);
        expect(stats.avgTime).toBe(200);
        expect(stats.bestTime).toBe(100);
        expect(stats.worstTime).toBe(300);
    });
});

describe('scrubOutlierRuns', () => {
    beforeEach(() => {
        game.saved = {};
    });

    test('an empty store removes nothing', async () => {
        seedRuns([]);
        expect(await dungeonTrackerStorage.scrubOutlierRuns()).toBe(0);
    });

    test('groups smaller than 5 are left alone regardless of spread', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100000 },
        ]);

        expect(await dungeonTrackerStorage.scrubOutlierRuns()).toBe(0);
    });

    test('a run over 3x the group median is scrubbed; the rest survive', async () => {
        seedRuns([
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 110 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 90 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 105 },
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 95 },
            // median of the above five is 100, threshold is 300
            { dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 5000 },
        ]);

        const removed = await dungeonTrackerStorage.scrubOutlierRuns();

        expect(removed).toBe(1);
        const remaining = game.saved.unifiedRuns.allRuns;
        expect(remaining).toHaveLength(5);
        expect(remaining.every((r) => r.duration < 1000)).toBe(true);
    });

    test('different dungeon+team groups are scrubbed independently', async () => {
        const groupA = Array.from({ length: 5 }, () => ({
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
            duration: 100,
        }));
        const groupB = Array.from({ length: 5 }, () => ({
            dungeonName: 'Sinister Circus',
            teamKey: 'C,D',
            duration: 200,
        }));
        seedRuns([...groupA, ...groupB, { dungeonName: 'Sinister Circus', teamKey: 'C,D', duration: 5000 }]);

        const removed = await dungeonTrackerStorage.scrubOutlierRuns();

        expect(removed).toBe(1);
        expect(game.saved.unifiedRuns.allRuns).toHaveLength(10);
    });

    test('a read still in flight does not put the scrubbed runs back', async () => {
        seedRuns([
            { timestamp: '2024-01-01T00:00:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 100 },
            { timestamp: '2024-01-01T00:01:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 110 },
            { timestamp: '2024-01-01T00:02:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 90 },
            { timestamp: '2024-01-01T00:03:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 105 },
            { timestamp: '2024-01-01T00:04:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 95 },
            { timestamp: '2024-01-01T00:05:00Z', dungeonName: 'Chimerical Den', teamKey: 'A,B', duration: 5000 },
        ]);

        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        // The scrub's own first read runs unheld; the panel read started right
        // behind it is the one left outstanding
        const scrub = dungeonTrackerStorage.scrubOutlierRuns();
        game.onRead = () => held;
        const panelRead = dungeonTrackerStorage.getAllRuns();
        game.onRead = null;

        expect(await scrub).toBe(1);

        release();
        await panelRead;

        // The store must not still be serving — and so merging back into the
        // next write — the run it just dropped
        const after = await dungeonTrackerStorage.getAllRuns();
        expect(after).toHaveLength(5);
        expect(after.every((run) => run.duration < 1000)).toBe(true);
    });
});

describe('who recorded a run', () => {
    beforeEach(() => {
        game.saved = {};
        game.characterId = 'market123';
        game.characterName = 'MarketCow';
    });

    test('a new run is stamped with the character that recorded it', async () => {
        await dungeonTrackerStorage.saveTeamRun('MarketCow,Friend', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns[0]).toMatchObject({
            recordedBy: 'market123',
            recordedByName: 'MarketCow',
        });
    });

    test('the stamp is read at save time, so a switch without a reload is followed', async () => {
        await dungeonTrackerStorage.saveTeamRun('MarketCow', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });

        game.characterId = 'iron456';
        game.characterName = 'IronCow';
        await dungeonTrackerStorage.saveTeamRun('IronCow', {
            timestamp: '2026-01-03T00:00:00Z',
            duration: 800,
            dungeonName: 'Chimerical Den',
        });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns.map((run) => run.recordedBy)).toEqual(['iron456', 'market123']);
    });
});

describe('a character switch landing inside the run history read', () => {
    test('the run is stamped with the character that recorded it, not the one who arrived', async () => {
        game.saved = {};
        game.characterId = 'market123';
        game.characterName = 'MarketCow';
        // The first save of a session reads the whole history first, and the
        // caller reaches here after awaits of its own
        game.onRead = () => {
            game.onRead = null;
            game.characterId = 'iron456';
            game.characterName = 'IronCow';
        };

        await dungeonTrackerStorage.saveTeamRun('MarketCow,Friend', {
            timestamp: '2026-01-02T00:00:00Z',
            duration: 700,
            dungeonName: 'Chimerical Den',
        });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns[0]).toMatchObject({
            recordedBy: 'market123',
            recordedByName: 'MarketCow',
        });
    });
});

describe('runMatchesCharacter', () => {
    test('the stamp decides when it is there', () => {
        const run = { recordedBy: 'market123', team: ['SomebodyElse'], teamKey: 'SomebodyElse' };
        expect(runMatchesCharacter(run, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter(run, 'iron456', 'IronCow')).toBe(false);
    });

    test('a stamped run belonging to nobody present does not match on name', () => {
        // The whole point of the stamp is that it beats the roster: two of your
        // characters in the same party recorded one run, and only one of them
        // recorded it
        const run = { recordedBy: 'market123', team: ['MarketCow', 'IronCow'] };
        expect(runMatchesCharacter(run, 'iron456', 'IronCow')).toBe(false);
    });

    test('a legacy run falls back to the roster', () => {
        expect(runMatchesCharacter({ team: ['MarketCow', 'Friend'] }, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter({ teamKey: 'MarketCow,Friend' }, 'market123', 'MarketCow')).toBe(true);
        expect(runMatchesCharacter({ team: ['Friend'] }, 'market123', 'MarketCow')).toBe(false);
    });

    test('a substring of a team-mate name is not a match', () => {
        expect(runMatchesCharacter({ teamKey: 'MarketCowboy,Friend' }, 'market123', 'MarketCow')).toBe(false);
    });

    test('with no character to compare against, nothing matches', () => {
        expect(runMatchesCharacter({ recordedBy: 'market123' }, null, null)).toBe(false);
        expect(runMatchesCharacter({ team: ['MarketCow'] }, 'market123', null)).toBe(false);
        expect(runMatchesCharacter(null, 'market123', 'MarketCow')).toBe(false);
    });
});

describe('filterRunsForCharacter', () => {
    beforeEach(() => {
        game.saved = {};
        game.characterId = 'market123';
        game.characterName = 'MarketCow';
    });

    const runs = [
        { id: 'mine', recordedBy: 'market123' },
        { id: 'theirs', recordedBy: 'iron456' },
        { id: 'legacy-mine', team: ['MarketCow', 'Friend'] },
        { id: 'legacy-theirs', team: ['Friend'] },
    ];

    test("'mine' keeps this character's runs and the legacy runs they were in", () => {
        const kept = filterRunsForCharacter(runs, 'mine', { id: 'market123', name: 'MarketCow' });
        expect(kept.map((run) => run.id)).toEqual(['mine', 'legacy-mine']);
    });

    test("'all' keeps everything", () => {
        expect(filterRunsForCharacter(runs, 'all', { id: 'market123', name: 'MarketCow' })).toHaveLength(4);
    });

    test('an empty or missing list is not an error', () => {
        expect(filterRunsForCharacter(null, 'mine', { id: 'market123', name: 'MarketCow' })).toEqual([]);
    });

    test('the storage accessor applies the same rule', async () => {
        seedRuns(runs);
        const kept = await dungeonTrackerStorage.getRunsForCharacter('mine');
        expect(kept.map((run) => run.id)).toEqual(['mine', 'legacy-mine']);
        expect(await dungeonTrackerStorage.getRunsForCharacter('all')).toHaveLength(4);
    });
});

/**
 * The run history is one key for the whole account in a store the `everything`
 * sync scope carries. Before it claimed a fold, every pull wrote the downloaded
 * list straight over the local one — data loss with nobody deleting anything.
 */
describe('sync fold for the run history', () => {
    const run = (id, timestamp) => ({ id, teamKey: 'A,B', timestamp, duration: 100 + id });

    test('the run history key resolves to a registered fold', () => {
        expect(mergeForKey(RUNS_STORE, RUNS_KEY)?.label).toBe('Dungeon run history');
        expect(mergeForKey(RUNS_STORE, RUNS_CLEARED_KEY)?.label).toBe('Dungeon run history clear');
    });

    test('two devices with disjoint histories end with both sets', () => {
        const mine = [run(1, '2026-01-02T00:00:00.000Z')];
        const theirs = [run(2, '2026-01-03T00:00:00.000Z')];
        const fold = mergeForKey(RUNS_STORE, RUNS_KEY).merge;

        expect(fold(mine, theirs).map((entry) => entry.id)).toEqual([2, 1]);
        // The same union whichever device pulls
        expect(fold(theirs, mine).map((entry) => entry.id)).toEqual([2, 1]);
    });

    test('a run both devices hold is kept once, the local copy standing', () => {
        const local = { ...run(1, '2026-01-02T00:00:00.000Z'), tier: 3 };
        const incoming = { ...run(1, '2026-01-02T00:00:00.000Z'), tier: null };

        const folded = mergeRunHistories([local], [incoming]);
        expect(folded).toHaveLength(1);
        expect(folded[0].tier).toBe(3);
    });

    test('a history with no deletions is unchanged by the fold', () => {
        const runs = [run(2, '2026-01-03T00:00:00.000Z'), run(1, '2026-01-02T00:00:00.000Z')];
        expect(mergeRunHistories(runs, runs)).toEqual(runs);
    });

    test('a missing or unusable side is not an error', () => {
        expect(mergeRunHistories(null, undefined)).toEqual([]);
        expect(mergeClearEpochs(undefined, null)).toBe(0);
    });

    test('the later clear epoch stands, whichever side it came from', () => {
        expect(mergeClearEpochs(10, 20)).toBe(20);
        expect(mergeClearEpochs(20, 10)).toBe(20);
    });

    test('the epoch drops the runs it forgot and keeps ones recorded since', () => {
        const cleared = Date.parse('2026-01-05T00:00:00.000Z');
        const runs = [run(1, '2026-01-04T00:00:00.000Z'), run(2, '2026-01-06T00:00:00.000Z')];
        expect(applyClearEpoch(runs, cleared).map((entry) => entry.id)).toEqual([2]);
    });

    test('an unstamped run is never guessed away by an epoch', () => {
        const runs = [{ id: 9, teamKey: 'A', timestamp: null, duration: 1 }];
        expect(applyClearEpoch(runs, Date.now())).toEqual(runs);
    });

    test('no epoch means no pruning, and the same array back', () => {
        const runs = [run(1, '2026-01-04T00:00:00.000Z')];
        expect(applyClearEpoch(runs, 0)).toBe(runs);
    });
});

describe('clearing all run history survives a pull', () => {
    const run = (id, timestamp) => ({ id, teamKey: 'A,B', timestamp, duration: 100 + id });

    test('the clear writes an epoch, and a peer pushing its copy back cannot undo it', async () => {
        vi.setSystemTime(Date.parse('2026-01-05T00:00:00.000Z'));
        seedRuns([run(1, '2026-01-04T00:00:00.000Z')]);
        await dungeonTrackerStorage.getAllRuns();

        await dungeonTrackerStorage.clearAllRuns();
        expect(game.saved.unifiedRuns[RUNS_KEY]).toEqual([]);
        expect(game.saved.unifiedRuns[RUNS_CLEARED_KEY]).toBe(Date.parse('2026-01-05T00:00:00.000Z'));

        // What a pull from a peer that never saw the clear leaves behind: the
        // union of both copies at the key, and the epoch untouched
        const fold = mergeForKey(RUNS_STORE, RUNS_KEY).merge;
        game.saved.unifiedRuns[RUNS_KEY] = fold([], [run(1, '2026-01-04T00:00:00.000Z')]);
        game.saved.unifiedRuns[RUNS_CLEARED_KEY] = mergeForKey(RUNS_STORE, RUNS_CLEARED_KEY).merge(
            game.saved.unifiedRuns[RUNS_CLEARED_KEY],
            0
        );
        dungeonTrackerStorage._resetCache();

        expect(await dungeonTrackerStorage.getAllRuns()).toEqual([]);
        // and the prune is written back, so it is not re-read or re-pushed
        expect(game.saved.unifiedRuns[RUNS_KEY]).toEqual([]);
        vi.useRealTimers();
    });

    test('runs the peer recorded after the clear survive it', async () => {
        vi.setSystemTime(Date.parse('2026-01-05T00:00:00.000Z'));
        seedRuns([run(1, '2026-01-04T00:00:00.000Z')]);
        await dungeonTrackerStorage.getAllRuns();
        await dungeonTrackerStorage.clearAllRuns();

        const fold = mergeForKey(RUNS_STORE, RUNS_KEY).merge;
        game.saved.unifiedRuns[RUNS_KEY] = fold([], [run(2, '2026-01-06T00:00:00.000Z')]);
        dungeonTrackerStorage._resetCache();

        expect((await dungeonTrackerStorage.getAllRuns()).map((entry) => entry.id)).toEqual([2]);
        vi.useRealTimers();
    });
});

/**
 * The per-dungeon "average starts here" markers.
 *
 * A marker is not a clear — every run stays in the history and keeps its
 * number — so it needs its own forward-only fold for exactly the reason the
 * clear watermark needed one: a device that never saw the marker would
 * otherwise push the stale average straight back.
 */
describe('average baselines', () => {
    beforeEach(() => {
        game.saved = {};
        dungeonTrackerStorage._resetCache();
    });

    test('nothing marked reads as an empty map', async () => {
        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({});
    });

    test('a marker is written at once and read back', async () => {
        expect(await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 1000)).toBe(true);

        expect(game.writes).toEqual([['dungeonAverageBaselines', true]]);
        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({ 'A,B::Chimerical Den': 1000 });
    });

    test('marking one dungeon leaves the others alone', async () => {
        await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 1000);
        await dungeonTrackerStorage.setAverageBaseline('A,B::Sinister Circus', 2000);

        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({
            'A,B::Chimerical Den': 1000,
            'A,B::Sinister Circus': 2000,
        });
    });

    test('a marker only ever moves forward', async () => {
        await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 5000);
        await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 1000);

        expect((await dungeonTrackerStorage.getAverageBaselines())['A,B::Chimerical Den']).toBe(5000);
    });

    test('a write folds in what another tab stored meanwhile', async () => {
        await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 1000);
        game.saved.unifiedRuns.dungeonAverageBaselines = {
            'A,B::Chimerical Den': 1000,
            'A,B::Pirate Cove': 7000,
        };

        await dungeonTrackerStorage.setAverageBaseline('A,B::Sinister Circus', 2000);

        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({
            'A,B::Chimerical Den': 1000,
            'A,B::Pirate Cove': 7000,
            'A,B::Sinister Circus': 2000,
        });
    });

    test('a read that could not be made is not cached as "nothing marked"', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        game.unreadable = true;

        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({});
        expect(warn).toHaveBeenCalled();

        game.unreadable = false;
        game.saved.unifiedRuns = { dungeonAverageBaselines: { 'A,B::Chimerical Den': 9 } };
        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({ 'A,B::Chimerical Den': 9 });
        warn.mockRestore();
    });

    test('a marker is not written when the stored map could not be read first', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        game.unreadable = true;

        expect(await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', 1000)).toBe(false);
        expect(game.writes).toEqual([]);
        warn.mockRestore();
    });

    test('the newest stored run names the dungeon the button marks', async () => {
        seedRuns([
            { timestamp: '2026-01-03T00:00:00Z', teamKey: 'A,B', dungeonName: 'Sinister Circus', duration: 500 },
            { timestamp: '2026-01-01T00:00:00Z', teamKey: 'A,B', dungeonName: 'Chimerical Den', duration: 500 },
        ]);

        expect(await dungeonTrackerStorage.latestStatsKey()).toBe('A,B::Sinister Circus');
    });

    test('no run carrying both a team and a dungeon is nothing to mark', async () => {
        seedRuns([{ timestamp: '2026-01-03T00:00:00Z', teamKey: 'A,B', duration: 500 }]);
        expect(await dungeonTrackerStorage.latestStatsKey()).toBeNull();
    });

    test('the baseline map resolves to a registered fold, and folds per dungeon by max', () => {
        expect(mergeForKey(RUNS_STORE, AVERAGE_BASELINE_KEY)?.label).toBe('Dungeon average baselines');

        // Device A marked Chimerical Den; device B never saw it and marked its
        // own. Neither marker may be lost, and A's may not be walked back.
        const deviceA = { 'A,B::Chimerical Den': 5000 };
        const deviceB = { 'A,B::Chimerical Den': 1000, 'A,B::Pirate Cove': 3000 };
        expect(mergeAverageBaselines(deviceA, deviceB)).toEqual({
            'A,B::Chimerical Den': 5000,
            'A,B::Pirate Cove': 3000,
        });
        // The same answer whichever device pulls
        expect(mergeAverageBaselines(deviceB, deviceA)).toEqual({
            'A,B::Chimerical Den': 5000,
            'A,B::Pirate Cove': 3000,
        });
    });

    test('a missing or unusable side is not an error', () => {
        expect(mergeAverageBaselines(null, undefined)).toEqual({});
        expect(mergeAverageBaselines({ x: 'nope' }, [1, 2])).toEqual({});
    });

    test('a marker from a badly skewed clock is not believed, and does not stick', () => {
        const now = 1_800_000_000_000;
        const skewed = { 'A,B::Chimerical Den': now + 365 * 24 * 60 * 60 * 1000 };
        const sane = { 'A,B::Chimerical Den': now - 1000 };

        // Taking the later of the two would leave this dungeon's average
        // blanked for a year, and no correct-clock press could lower it
        expect(mergeAverageBaselines(sane, skewed, now)).toEqual(sane);
        expect(mergeAverageBaselines(skewed, sane, now)).toEqual(sane);
        // A dungeon whose only marker is the impossible one is simply unmarked
        expect(mergeAverageBaselines(skewed, null, now)).toEqual({});
    });

    test('ordinary skew between two devices is still believed', () => {
        const now = 1_800_000_000_000;
        const ahead = { 'A,B::Chimerical Den': now + 30_000 };
        expect(mergeAverageBaselines(ahead, null, now)).toEqual(ahead);
    });

    test('a skewed marker already in storage is ignored, and a fresh press replaces it', async () => {
        game.saved.unifiedRuns = {
            dungeonAverageBaselines: { 'A,B::Chimerical Den': Date.now() + 365 * 24 * 60 * 60 * 1000 },
        };

        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({});

        const at = Date.now();
        expect(await dungeonTrackerStorage.setAverageBaseline('A,B::Chimerical Den', at)).toBe(true);
        expect(await dungeonTrackerStorage.getAverageBaselines()).toEqual({ 'A,B::Chimerical Den': at });
    });
});

describe('repairSwappedDateRuns', () => {
    // The stamps the four broken parsers produced were built with
    // `new Date(year, month - 1, day, …)`, so every date here is local time and
    // is constructed the same way rather than written as an ISO literal.
    const MINUTE = 60 * 1000;
    /** The maintainer's own case: a 14m 13s clear stored as a month and a bit. */
    const CLEAR_MS = 14 * MINUTE + 13 * 1000;

    /**
     * A run as a day-first client's misread wrote it down.
     *
     * `[01/03 23:56:00]` and `[02/03 00:10:13]` — 1 and 2 March, fourteen
     * minutes apart — read as mm/dd become 3 January and 3 February.
     * @param {Object} [extra] - Fields to override
     * @returns {Object} The run as it was stored
     */
    function misreadRun(extra = {}) {
        const wrongStart = new Date(2026, 0, 3, 23, 56, 0);
        const wrongEnd = new Date(2026, 1, 3, 0, 10, 13);
        return {
            timestamp: wrongStart.toISOString(),
            duration: wrongEnd.getTime() - wrongStart.getTime(),
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
            ...extra,
        };
    }

    beforeEach(() => {
        game.saved = {};
        game.writes = [];
    });

    test('swapMonthDay is only defined when neither field could have been a day', () => {
        expect(swapMonthDay(new Date(2026, 0, 3, 23, 56, 0))?.getTime()).toBe(
            new Date(2026, 2, 1, 23, 56, 0).getTime()
        );
        // 20 can only ever have been a day, so the digits already overruled the
        // locale and that endpoint has nothing to put back
        expect(swapMonthDay(new Date(2026, 0, 20, 12, 0, 0))).toBeNull();
        expect(swapMonthDay(new Date('nonsense'))).toBeNull();
        expect(swapMonthDay(null)).toBeNull();
    });

    test('a plausible run is never re-derived, however swappable it is', () => {
        const run = { timestamp: new Date(2026, 4, 3, 12, 0, 0).toISOString(), duration: CLEAR_MS };
        expect(rederiveSwappedRun(run)).toBeNull();
    });

    test('the 14m 13s clear stored as a month is put back', async () => {
        seedRuns([misreadRun()]);

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(1);

        const [stored] = game.saved.unifiedRuns.allRuns;
        expect(stored.duration).toBe(CLEAR_MS);
        expect(new Date(stored.timestamp).getTime()).toBe(new Date(2026, 2, 1, 23, 56, 0).getTime());
        // and the record itself survives — this is a repair, not a scrub
        expect(stored.dungeonName).toBe('Chimerical Den');
        expect(stored.teamKey).toBe('A,B');
    });

    test('the pre-repair identity is tombstoned, so the broken copy cannot merge back', async () => {
        seedRuns([misreadRun()]);
        await dungeonTrackerStorage.repairSwappedDateRuns();

        // A second tab's copy of the store still holds the broken record
        game.saved.unifiedRuns.allRuns = [misreadRun(), ...game.saved.unifiedRuns.allRuns];
        await dungeonTrackerStorage.saveTeamRun('C,D', {
            timestamp: new Date(2026, 4, 3, 12, 0, 0).toISOString(),
            duration: CLEAR_MS,
            dungeonName: 'Pirate Cove',
        });
        await dungeonTrackerStorage.flushPendingSave();

        expect(game.saved.unifiedRuns.allRuns.map((r) => r.duration)).toEqual([CLEAR_MS, CLEAR_MS]);
    });

    test('a run whose swap is undefined is left exactly as it was', async () => {
        // 20 January: the day field is over 12, so that endpoint was parsed
        // correctly whatever the locale said and no swap is defined
        const before = {
            timestamp: new Date(2026, 0, 20, 10, 0, 0).toISOString(),
            duration: 9 * 24 * 60 * MINUTE,
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
        };
        seedRuns([{ ...before }]);

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(0);
        expect(game.saved.unifiedRuns.allRuns).toEqual([before]);
    });

    test('a swap that is still implausible leaves the record alone rather than guessing', async () => {
        // Both endpoints swap, but 5 January → 6 January becomes 1 May → 1 June:
        // a month, which is no more a dungeon run than the day it replaced
        const wrongStart = new Date(2026, 0, 5, 10, 0, 0);
        const wrongEnd = new Date(2026, 0, 6, 10, 0, 0);
        const before = {
            timestamp: wrongStart.toISOString(),
            duration: wrongEnd.getTime() - wrongStart.getTime(),
            dungeonName: 'Chimerical Den',
            teamKey: 'A,B',
        };
        seedRuns([{ ...before }]);

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(0);
        expect(game.saved.unifiedRuns.allRuns).toEqual([before]);
    });

    test('a store of correct records comes through untouched', async () => {
        const correct = [
            {
                timestamp: new Date(2026, 4, 3, 12, 0, 0).toISOString(),
                duration: CLEAR_MS,
                dungeonName: 'Chimerical Den',
                teamKey: 'A,B',
            },
            {
                timestamp: new Date(2026, 4, 3, 11, 0, 0).toISOString(),
                duration: 11 * MINUTE,
                dungeonName: 'Chimerical Den',
                teamKey: 'A,B',
            },
            {
                timestamp: new Date(2026, 10, 25, 9, 0, 0).toISOString(),
                duration: 22 * MINUTE,
                dungeonName: 'Pirate Cove',
                teamKey: 'C,D',
            },
        ];
        seedRuns(correct.map((run) => ({ ...run })));

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(0);
        expect(game.saved.unifiedRuns.allRuns).toEqual(correct);
        // and the history itself was never rewritten
        expect(game.writes.map(([key]) => key)).toEqual([RUNS_DATE_REPAIR_KEY]);
    });

    test('the marker stops a second pass from touching records the first one mended', async () => {
        seedRuns([misreadRun()]);
        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(1);
        expect(Number(game.saved.unifiedRuns[RUNS_DATE_REPAIR_KEY])).toBeGreaterThan(0);

        const afterFirst = structuredClone(game.saved.unifiedRuns.allRuns);
        dungeonTrackerStorage._resetCache();

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(0);
        expect(game.saved.unifiedRuns.allRuns).toEqual(afterFirst);
    });

    test('a marker that could not be read means the pass does not run at all', async () => {
        seedRuns([misreadRun()]);
        game.unreadable = true;

        expect(await dungeonTrackerStorage.repairSwappedDateRuns()).toBe(0);

        game.unreadable = false;
        expect(game.saved.unifiedRuns.allRuns[0].duration).not.toBe(CLEAR_MS);
    });

    test('the repair marker folds forward, so a pull cannot set the pass going again', () => {
        const registered = mergeForKey(RUNS_STORE, RUNS_DATE_REPAIR_KEY);
        expect(registered?.label).toBe('Dungeon run date-order repair');
        expect(registered.merge(500, 0)).toBe(500);
        expect(registered.merge(0, 500)).toBe(500);
    });
});
