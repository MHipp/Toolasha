/**
 * Networth History — `recentSeries`, the read the equipment savings ETA falls
 * back to when combat has nothing to say.
 *
 * The snapshot pipeline itself (hourly capture, compaction, IndexedDB writes)
 * is not exercised here; `recentSeries` is a pure filter over `history`, so
 * it is tested against that array directly rather than through a full
 * `initialize`/`takeSnapshot` cycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (key, store, fallback) => fallback),
    set: vi.fn(),
    delete: vi.fn(async () => true),
    getMany: vi.fn(async (keys, store) => {
        const result = new Map();
        for (const key of keys) result.set(key, await storageMock.get(key, store, null));
        return result;
    }),
    getAllKeys: vi.fn(async () => []),
    // Delegates, so the per-test `getAllKeys` implementations below drive
    // the listing `chunked-history.js` actually reads through
    tryGetAllKeys: vi.fn(async (...args) => storageMock.getAllKeys(...args)),
    putAll: vi.fn(async () => 0),
    isQuotaExceeded: vi.fn(() => false),
}));

const dataManagerMock = vi.hoisted(() => ({ currentCharacterId: 'char-1' }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => dataManagerMock.currentCharacterId },
}));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));

const { default: networthHistory, pruneHistory, seriesStore } = await import('./networth-history.js');

const HOUR = 3_600_000;

/** A snapshot `hoursAgo` hours before "now", with the given total */
const point = (hoursAgo, total) => ({ t: Date.now() - hoursAgo * HOUR, total });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    networthHistory.history = [];
    networthHistory.detailHistory = [];
    networthHistory.characterId = 'char-1';
    dataManagerMock.currentCharacterId = 'char-1';
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    storageMock.get.mockImplementation(async (key, store, fallback) => fallback);
    storageMock.getAllKeys.mockImplementation(async () => []);
    storageMock.tryGetAllKeys.mockImplementation(async (...args) => storageMock.getAllKeys(...args));
    storageMock.putAll.mockImplementation(async () => 0);
    storageMock.delete.mockImplementation(async () => true);
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    seriesStore.forget();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('recentSeries', () => {
    test('keeps only points inside the window, oldest first', () => {
        networthHistory.history = [point(72, 100), point(40, 200), point(10, 300), point(1, 400)];
        expect(networthHistory.recentSeries(48).map((p) => p.total)).toEqual([200, 300, 400]);
    });

    test('an empty history is an empty window', () => {
        expect(networthHistory.recentSeries(48)).toEqual([]);
    });

    test('everything outside the window leaves nothing, not the whole history', () => {
        // Reading `.history` directly here would return two points; the window
        // is what a caller outside this module actually asked for
        networthHistory.history = [point(100, 100), point(72, 200)];
        expect(networthHistory.recentSeries(48)).toEqual([]);
    });

    test('a non-positive window is nothing rather than everything', () => {
        networthHistory.history = [point(1, 100)];
        expect(networthHistory.recentSeries(0)).toEqual([]);
        expect(networthHistory.recentSeries(-5)).toEqual([]);
    });

    test('a point exactly at the edge of the window is kept', () => {
        networthHistory.history = [point(48, 100)];
        expect(networthHistory.recentSeries(48)).toHaveLength(1);
    });
});

const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

describe('pruneHistory', () => {
    test('leaves the recent year exactly as it is', () => {
        const now = Date.now();
        const history = Array.from({ length: 200 }, (_, i) => ({ t: now - (200 - i) * HOUR, total: i }));

        expect(pruneHistory(history, now)).toEqual(history);
    });

    test('thins anything past a year to one point a day', () => {
        const now = Date.now();
        // Two days of hourly points, all older than a year
        const old = Array.from({ length: 48 }, (_, i) => ({ t: now - YEAR - DAY * 2 + i * HOUR, total: i }));
        const recent = [{ t: now - HOUR, total: 999 }];

        const pruned = pruneHistory([...old, ...recent], now);

        // One per day-bucket for the old span, and the recent point untouched
        expect(pruned.length).toBeLessThanOrEqual(4);
        expect(pruned.at(-1)).toEqual(recent[0]);
        // The tail is still a trend, not a single point
        expect(pruned.length).toBeGreaterThan(1);
        for (let i = 1; i < pruned.length - 1; i++) {
            expect(pruned[i].t - pruned[i - 1].t).toBeGreaterThanOrEqual(DAY - HOUR);
        }
    });

    test('keeps the oldest point of the record rather than losing the start of the trend', () => {
        const now = Date.now();
        const oldest = { t: now - YEAR - DAY * 5, total: 1 };
        const pruned = pruneHistory([oldest, { t: now - YEAR - DAY * 5 + HOUR, total: 2 }, { t: now, total: 3 }], now);

        expect(pruned[0]).toEqual(oldest);
    });

    test('an empty or absent history prunes to nothing rather than throwing', () => {
        expect(pruneHistory([], Date.now())).toEqual([]);
        expect(pruneHistory(null, Date.now())).toEqual([]);
        expect(pruneHistory(undefined, Date.now())).toEqual([]);
    });

    test('points without a timestamp are dropped rather than kept forever', () => {
        const now = Date.now();
        expect(pruneHistory([{ total: 5 }, { t: now, total: 6 }], now)).toEqual([{ t: now, total: 6 }]);
    });
});

/**
 * The smallest networth payload `takeDetailSnapshot` will accept.
 * @returns {Object} Fake currentData
 */
function fakeNetworthData() {
    return {
        totalNetworth: 1050,
        coins: 1000,
        currentAssets: {
            inventory: { value: 10, breakdown: [{ itemHrid: '/items/milk', count: 3, value: 30 }] },
            equipped: { value: 20, breakdown: [] },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            houses: { totalCost: 0, breakdown: [] },
            abilities: { totalCost: 0, breakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
        },
    };
}

describe('detail snapshots are stored one key each', () => {
    test('a new snapshot writes only itself, not the whole window', () => {
        networthHistory.detailHistory = Array.from({ length: 5 }, (_, i) => ({ t: i, items: {} }));

        networthHistory.takeDetailSnapshot(fakeNetworthData());

        const detailWrites = storageMock.set.mock.calls.filter(([key]) => String(key).startsWith('networthDetail_'));
        expect(detailWrites).toHaveLength(1);
        expect(detailWrites[0][0]).toBe(`networthDetail_char-1_${Date.now()}`);
        // What is written is one snapshot, not an array of them
        expect(Array.isArray(detailWrites[0][1])).toBe(false);
        expect(detailWrites[0][1].t).toBe(Date.now());
    });

    test('a snapshot that falls out of the window takes its key with it', () => {
        // 25 is the cap, so pushing a 26th drops the oldest
        networthHistory.detailHistory = Array.from({ length: 25 }, (_, i) => ({ t: 1000 + i, items: {} }));

        networthHistory.takeDetailSnapshot(fakeNetworthData());

        expect(storageMock.delete).toHaveBeenCalledWith('networthDetail_char-1_1000', 'networthHistory');
        expect(networthHistory.detailHistory).toHaveLength(25);
    });

    test('the old single-array key is migrated into per-snapshot keys and removed', async () => {
        const legacy = [
            { t: 1, items: { a: 1 } },
            { t: 2, items: { b: 2 } },
        ];
        storageMock.get.mockImplementation(async (key, store, fallback) =>
            key === 'networthDetail_char-1' ? legacy : fallback
        );

        const loaded = await networthHistory._loadDetailHistory(networthHistory._generation, 'char-1');

        expect(loaded).toEqual(legacy);
        expect(storageMock.putAll).toHaveBeenCalledWith('networthHistory', {
            'networthDetail_char-1_1': legacy[0],
            'networthDetail_char-1_2': legacy[1],
        });
        expect(storageMock.delete).toHaveBeenCalledWith('networthDetail_char-1', 'networthHistory');
    });

    test('already-split snapshots are gathered back into timestamp order', async () => {
        const stored = {
            'networthDetail_char-1_300': { t: 300, items: {} },
            'networthDetail_char-1_100': { t: 100, items: {} },
            'networthDetail_char-1_200': { t: 200, items: {} },
            networth_char1: [], // a key of a different shape in the same store
        };
        storageMock.getAllKeys.mockImplementation(async () => Object.keys(stored));
        storageMock.get.mockImplementation(async (key, store, fallback) => stored[key] ?? fallback);

        const loaded = await networthHistory._loadDetailHistory(networthHistory._generation, 'char-1');

        expect(loaded.map((s) => s.t)).toEqual([100, 200, 300]);
        expect(storageMock.putAll).not.toHaveBeenCalled();
    });

    test('a switch during the legacy read does not migrate one character onto another', async () => {
        // Character A's legacy detail array, held open — this is the await
        // `_loadDetailHistory` is sitting behind when the switch lands
        const legacyA = [{ t: 1, items: { a: 1 } }];
        let releaseA;
        storageMock.get.mockImplementation(
            (key) =>
                new Promise((resolve) => {
                    releaseA = () => resolve(key === 'networthDetail_char-A' ? legacyA : null);
                })
        );

        networthHistory.characterId = 'char-A';
        const generation = networthHistory._generation;
        const stale = networthHistory._loadDetailHistory(generation, 'char-A');

        // The switch: disable() bumps the generation, and character B arrives
        networthHistory.disable();
        networthHistory.characterId = 'char-B';

        releaseA();
        expect(await stale).toEqual([]);

        // Nothing of A's may be written under B's keys, and B's own legacy
        // record must still be there for B's own load to migrate
        expect(storageMock.putAll).not.toHaveBeenCalled();
        expect(storageMock.delete).not.toHaveBeenCalledWith('networthDetail_char-B', 'networthHistory');
    });
});

describe('the compact series is stored one record per month', () => {
    /** Every series record `set()` was asked to write */
    const seriesWrites = () => storageMock.set.mock.calls.filter(([key]) => String(key).startsWith('networthSeries_'));

    /** A snapshot in the given UTC month */
    const monthly = (year, month, total) => ({ t: Date.UTC(year, month - 1, 15), total });

    test('an hourly snapshot writes the current month, not the whole series', async () => {
        // Three months of history, of which only the last can change
        await seriesStore.save('char-1', [monthly(2026, 6, 1), monthly(2026, 7, 2), monthly(2026, 8, 3)]);
        storageMock.set.mockClear();
        networthHistory.history = [monthly(2026, 6, 1), monthly(2026, 7, 2), monthly(2026, 8, 3)];
        networthHistory.networthFeature = { currentData: fakeNetworthData() };

        await networthHistory.takeSnapshot();

        expect(seriesWrites().map(([key]) => key)).toEqual(['networthSeries_char-1_2026-08']);
    });

    test('the chart still gets one flat array, whatever it is stored as', async () => {
        const stored = {
            'networthSeries_char-1_2026-08': [monthly(2026, 8, 3)],
            'networthSeries_char-1_2026-06': [monthly(2026, 6, 1)],
            'networthSeries_char-1_2026-07': [monthly(2026, 7, 2)],
        };
        storageMock.getAllKeys.mockImplementation(async () => Object.keys(stored));
        storageMock.get.mockImplementation(async (key, store, fallback) => stored[key] ?? fallback);

        expect((await seriesStore.load('char-1')).map((p) => p.total)).toEqual([1, 2, 3]);
    });

    test('the pre-split single key is turned into records and removed', async () => {
        const legacy = [monthly(2026, 6, 1), monthly(2026, 7, 2)];
        storageMock.get.mockImplementation(async (key, store, fallback) =>
            key === 'networth_char-1' ? legacy : fallback
        );
        storageMock.putAll.mockImplementation(async (store, entries) => Object.keys(entries).length);

        const loaded = await seriesStore.load('char-1');

        expect(loaded).toEqual(legacy);
        expect(storageMock.putAll).toHaveBeenCalledWith('networthHistory', {
            'networthSeries_char-1_2026-06': [legacy[0]],
            'networthSeries_char-1_2026-07': [legacy[1]],
        });
        expect(storageMock.delete).toHaveBeenCalledWith('networth_char-1', 'networthHistory');
    });

    test('a split that will not fit leaves the single key alone and readable', async () => {
        const legacy = [monthly(2026, 6, 1), monthly(2026, 7, 2)];
        storageMock.get.mockImplementation(async (key, store, fallback) =>
            key === 'networth_char-1' ? legacy : fallback
        );
        storageMock.putAll.mockImplementation(async () => 0);
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        expect(await seriesStore.load('char-1')).toEqual(legacy);
        expect(storageMock.delete).not.toHaveBeenCalledWith('networth_char-1', 'networthHistory');
        expect(seriesStore.isLegacy()).toBe(true);
    });

    test('thinning past retention deletes the months it emptied', async () => {
        const old = { t: Date.now() - 400 * 24 * 3_600_000, total: 1 };
        await seriesStore.save('char-1', [old, { t: Date.now(), total: 2 }]);
        storageMock.delete.mockClear();

        await seriesStore.save('char-1', [{ t: Date.now(), total: 2 }]);

        const oldMonth = new Date(old.t).toISOString().slice(0, 7);
        expect(storageMock.delete).toHaveBeenCalledWith(`networthSeries_char-1_${oldMonth}`, 'networthHistory');
    });
});

describe('the guild shrine total', () => {
    test('is recorded when the calculator costed the shrines', async () => {
        const data = fakeNetworthData();
        data.fixedAssets.guildShrines = { totalCost: 1234.6, breakdown: [] };
        networthHistory.networthFeature = { currentData: data };

        await networthHistory.takeSnapshot();

        expect(networthHistory.history.at(-1).guildShrines).toBe(1235);
    });

    test('is left off entirely when it did not, so the chart draws a gap not a zero', async () => {
        // Pre-shrine calculator output: `fixedAssets` has no `guildShrines` at all
        networthHistory.networthFeature = { currentData: fakeNetworthData() };

        await networthHistory.takeSnapshot();

        expect(networthHistory.history.at(-1)).not.toHaveProperty('guildShrines');
    });
});

describe('standing down when storage is full', () => {
    test('no snapshot is built or written once the quota has been hit', async () => {
        storageMock.isQuotaExceeded.mockImplementation(() => true);
        networthHistory.networthFeature = { currentData: fakeNetworthData() };

        await networthHistory.takeSnapshot();

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(networthHistory.history).toEqual([]);
        expect(networthHistory.detailHistory).toEqual([]);
    });
});

describe('a character switch mid-initialize', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a stale resume does not bleed the departing character into the arriving character', async () => {
        // Character A's chunked-history read is held open — this is the await
        // `initialize()` is sitting behind when the switch happens.
        dataManagerMock.currentCharacterId = 'char-A';
        let resolveA;
        const pendingA = new Promise((resolve) => {
            resolveA = resolve;
        });
        vi.spyOn(seriesStore, 'load').mockImplementation((charId) =>
            charId === 'char-A' ? pendingA : Promise.resolve([])
        );
        const saveSpy = vi.spyOn(seriesStore, 'save').mockImplementation(() => {});

        const feature = { currentData: fakeNetworthData() };
        const staleInit = networthHistory.initialize(feature);

        // The switch away from A: `character_switching`'s synchronous disable(),
        // exactly as feature-registry.js runs it before the arriving character's
        // own initialize() starts.
        networthHistory.disable();

        // Character B logs in and finishes its own initialize() first — this is
        // the realistic ordering, since B's read is not stuck behind anything.
        dataManagerMock.currentCharacterId = 'char-B';
        await networthHistory.initialize(feature);
        expect(networthHistory.characterId).toBe('char-B');
        saveSpy.mockClear();

        // A's read finally lands, carrying A's data — a total no snapshot of
        // B's ever produced.
        resolveA([{ t: 1, total: 999999 }]);
        await staleInit;

        // The stale continuation must not have touched state that is now B's:
        // neither the in-memory series nor anything written under B's key may
        // carry A's total.
        expect(networthHistory.characterId).toBe('char-B');
        expect(networthHistory.history.some((row) => row.total === 999999)).toBe(false);
        for (const [charId, rows] of saveSpy.mock.calls) {
            if (charId !== 'char-B') continue;
            expect(rows.some((row) => row.total === 999999)).toBe(false);
        }
    });
});

/**
 * `networthHistory`'s soft budget (`STORE_KEY_BUDGETS` in `core/storage.js`) is
 * sized per character and names the twenty-five item-level detail snapshots
 * alongside the series chunks. The health panel's per-character count is built
 * from prefixes registered in `utils/chunked-history.js`, and the detail
 * snapshots are written key by key rather than through a `ChunkedHistory` — so
 * without an explicit registration they drop out of the count and a leak in
 * them (their deletes are fire-and-forget) could never trip the budget.
 */
describe('the detail snapshots are visible to the per-character budget count', () => {
    test('a character is credited with its detail keys as well as its series chunks', async () => {
        const { maxRecordsPerCharacter } = await import('../../utils/chunked-history.js');

        const keys = [
            'networthSeries_char-1_2026-07',
            'networthSeries_char-1_2026-08',
            'networthDetail_char-1_1000',
            'networthDetail_char-1_2000',
            'networthDetail_char-1_3000',
            // Another character, whose keys must not be added to char-1's
            'networthSeries_char-2_2026-08',
            'networthDetail_char-2_1000',
            // The pre-split single key, which is not a record
            'networthDetail_char-1',
        ];

        expect(maxRecordsPerCharacter('networthHistory', keys)).toBe(5);
    });
});
