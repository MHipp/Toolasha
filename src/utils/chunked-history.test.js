/**
 * Record-per-chunk history storage.
 *
 * The point of this module is a claim about writes — that appending one entry
 * costs one record rather than the whole history — so most of what is tested
 * here is which keys IndexedDB was asked to touch, not what came back out of it.
 * The rest is the migration, whose only interesting cases are the ones where it
 * fails: a split that cannot be written must leave the legacy key exactly as it
 * found it, because the disk being full is precisely when a half-migrated
 * history would be unrecoverable.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    const mock = {
        store,
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
        getMany: vi.fn(async (keys) => {
            const result = new Map();
            for (const key of keys) result.set(key, store.has(key) ? store.get(key) : null);
            return result;
        }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
    // Delegates, so a test that makes `getAllKeys` hang or throw exercises the
    // listing the store actually calls. `null` is the real storage's "could not
    // be listed", which the tests below drive through this.
    mock.tryGetAllKeys = vi.fn(async (...args) => mock.getAllKeys(...args));
    return mock;
});

vi.mock('../core/storage.js', () => ({ default: storageMock }));

const { mergeForKey } = await import('./sync-merge-registry.js');
const {
    createChunkedHistory,
    timeChunkId,
    idsFromRecordKeys,
    recordKeysFor,
    maxRecordsPerCharacter,
    registerCharacterScopedPrefix,
    mergeTombstones,
    TOMBSTONE_MAX_AGE_MS,
    MAX_TOMBSTONES,
} = await import('./chunked-history.js');

/** A history keyed by the month each point falls in */
const build = () =>
    createChunkedHistory({
        storeName: 'testStore',
        prefix: 'rec',
        legacyKey: (charId) => `legacy_${charId}`,
        groupOf: (point) => timeChunkId(point?.t, 'month'),
        compare: (a, b) => a.t - b.t,
        label: 'Test',
    });

/** A point in the given UTC month */
const at = (year, month, day = 1) => ({ t: Date.UTC(year, month - 1, day), v: `${year}-${month}-${day}` });

/** The keys `set()` was asked to write, in order */
const written = () => storageMock.set.mock.calls.map(([key]) => key);

beforeEach(() => {
    storageMock.store.clear();
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    // Implementations, not just calls: a test that makes a write fail must not
    // leave the next one failing too
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    storageMock.get.mockImplementation(async (key, storeName, fallback) =>
        storageMock.store.has(key) ? storageMock.store.get(key) : fallback
    );
    storageMock.set.mockImplementation(async (key, value) => {
        storageMock.store.set(key, value);
        return true;
    });
    storageMock.delete.mockImplementation(async (key) => {
        storageMock.store.delete(key);
        return true;
    });
    storageMock.getAllKeys.mockImplementation(async () => [...storageMock.store.keys()]);
    storageMock.tryGetAllKeys.mockImplementation(async (...args) => storageMock.getAllKeys(...args));
    storageMock.getMany.mockImplementation(async (keys) => {
        const result = new Map();
        for (const key of keys) result.set(key, storageMock.store.has(key) ? storageMock.store.get(key) : null);
        return result;
    });
    storageMock.putAll.mockImplementation(async (storeName, entries) => {
        for (const [key, value] of Object.entries(entries)) storageMock.store.set(key, value);
        return Object.keys(entries).length;
    });
});

describe('timeChunkId', () => {
    test('is sortable at every granularity, and in UTC', () => {
        const t = Date.UTC(2026, 7, 4, 9, 30);
        expect(timeChunkId(t, 'month')).toBe('2026-08');
        expect(timeChunkId(t, 'day')).toBe('2026-08-04');
        expect(timeChunkId(t, 'hour')).toBe('2026-08-04T09');
    });

    test('a missing timestamp is a bucket rather than a throw', () => {
        expect(timeChunkId(undefined, 'month')).toBe('1970-01');
        expect(timeChunkId(NaN, 'day')).toBe('1970-01-01');
    });
});

describe('idsFromRecordKeys', () => {
    test('names the character between the prefix and the chunk', () => {
        const keys = ['rec_alice_2026-08', 'rec_alice_2026-09', 'rec_bob_2026-08', 'other_alice_2026-08'];
        expect(idsFromRecordKeys(keys, 'rec_')).toEqual(['alice', 'bob']);
    });

    test('a key with no chunk suffix names nobody', () => {
        // `networth_alice` must not be read as a character called `alice` by a
        // scan for `networth_`-prefixed *records* — it is the legacy single key
        expect(idsFromRecordKeys(['rec_alice'], 'rec_')).toEqual([]);
    });

    test('non-strings and non-matches are skipped rather than throwing', () => {
        expect(idsFromRecordKeys([null, 7, 'nope', 'rec_a_1'], 'rec_')).toEqual(['a']);
    });
});

describe('recordKeysFor', () => {
    test('picks out one character and leaves the neighbours alone', () => {
        const keys = ['rec_a_2026-09', 'rec_a_2026-08', 'rec_ab_2026-08', 'rec_b_2026-08'];
        expect(recordKeysFor(keys, 'rec', 'a')).toEqual(['rec_a_2026-08', 'rec_a_2026-09']);
    });
});

describe('appending writes only the tail chunk', () => {
    test('a new entry in a new month writes that month and nothing else', async () => {
        const history = build();
        const points = [at(2026, 6), at(2026, 7)];
        await history.save('c1', points);
        storageMock.set.mockClear();

        await history.save('c1', [...points, at(2026, 8)]);

        expect(written()).toEqual(['rec_c1_2026-08']);
    });

    test('a new entry in the current month rewrites that month alone', async () => {
        const history = build();
        const points = [at(2026, 6), at(2026, 7, 1)];
        await history.save('c1', points);
        storageMock.set.mockClear();

        await history.save('c1', [...points, at(2026, 7, 20)]);

        expect(written()).toEqual(['rec_c1_2026-07']);
        expect(storageMock.store.get('rec_c1_2026-07')).toHaveLength(2);
    });

    test('saving an unchanged history writes nothing at all', async () => {
        const history = build();
        const points = [at(2026, 6), at(2026, 7)];
        await history.save('c1', points);
        storageMock.set.mockClear();

        await history.save('c1', points);

        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('one character cannot write into another character keys', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6)]);
        history.forget();

        await history.save('c2', [at(2026, 6)]);

        expect(storageMock.store.has('rec_c1_2026-06')).toBe(true);
        expect(storageMock.store.has('rec_c2_2026-06')).toBe(true);
    });
});

describe('pruning deletes old chunks', () => {
    test('a chunk whose last entry has gone loses its key', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7), at(2026, 8)]);
        storageMock.delete.mockClear();

        // A rolling window dropping its oldest point
        await history.save('c1', [at(2026, 7), at(2026, 8)]);

        expect(storageMock.delete).toHaveBeenCalledWith('rec_c1_2026-06', 'testStore');
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(false);
        expect(storageMock.store.has('rec_c1_2026-07')).toBe(true);
    });

    test('a chunk that merely shrinks is rewritten, not deleted', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6, 1), at(2026, 6, 20)]);
        storageMock.delete.mockClear();

        await history.save('c1', [at(2026, 6, 20)]);

        expect(storageMock.delete).not.toHaveBeenCalled();
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });
});

describe('the one-time split of the legacy key', () => {
    test('the array becomes records and the legacy key is removed', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 8), at(2026, 6), at(2026, 7)]);
        const history = build();

        const loaded = await history.load('c1');

        expect(loaded.map((p) => p.v)).toEqual(['2026-6-1', '2026-7-1', '2026-8-1']);
        expect([...storageMock.store.keys()].sort()).toEqual(['rec_c1_2026-06', 'rec_c1_2026-07', 'rec_c1_2026-08']);
        expect(history.isLegacy()).toBe(false);
    });

    test('the read API returns the same array before and after the split', async () => {
        const legacy = [at(2026, 6), at(2026, 7), at(2026, 8)];
        storageMock.store.set('legacy_c1', legacy);

        const first = build();
        const before = await first.load('c1');

        const second = build();
        const after = await second.load('c1');

        expect(after).toEqual(before);
        expect(after).toEqual(legacy);
    });

    test('splitting again is a no-op rather than a duplication', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 6)]);
        await build().load('c1');
        storageMock.putAll.mockClear();

        const again = await build().load('c1');

        expect(storageMock.putAll).not.toHaveBeenCalled();
        expect(again).toHaveLength(1);
    });

    test('records already on disk are merged into, not deleted', async () => {
        // This is the pulled-legacy-key case as much as the interrupted-split
        // one: a device whose split stalled syncs its single key over, it lands
        // beside a full set of local records, and deleting them to make room
        // for its five hundred entries is how a year of history disappeared
        storageMock.store.set('rec_c1_1999-01', [{ t: Date.UTC(1999, 0, 1), v: 'kept' }]);
        storageMock.store.set('legacy_c1', [at(2026, 6)]);

        const loaded = await build().load('c1');

        expect(loaded.map((p) => p.v).sort()).toEqual(['2026-6-1', 'kept']);
        expect(storageMock.store.has('rec_c1_1999-01')).toBe(true);
        expect(storageMock.store.has('legacy_c1')).toBe(false);
    });

    test('a legacy entry the records already hold is folded in once, not twice', async () => {
        const shared = at(2026, 6);
        storageMock.store.set('rec_c1_2026-06', [shared]);
        storageMock.store.set('legacy_c1', [shared, at(2026, 7)]);

        const loaded = await build().load('c1');

        expect(loaded.map((p) => p.v)).toEqual(['2026-6-1', '2026-7-1']);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });

    test('a chunk the legacy key never touches is left exactly where it was', async () => {
        storageMock.store.set('rec_c1_2020-01', [{ t: Date.UTC(2020, 0, 1), v: 'old' }]);
        storageMock.store.set('legacy_c1', [at(2026, 6)]);

        await build().load('c1');

        // Untouched chunks are not rewritten; only the ones the legacy entries
        // land in are, which is what keeps a split off a year of records
        const written = storageMock.putAll.mock.calls.at(-1)[1];
        expect(Object.keys(written)).toEqual(['rec_c1_2026-06']);
        expect(storageMock.store.get('rec_c1_2020-01')).toHaveLength(1);
    });

    test('an empty legacy array is removed rather than left as a permanent no-op', async () => {
        storageMock.store.set('legacy_c1', []);

        const loaded = await build().load('c1');

        expect(loaded).toEqual([]);
        expect(storageMock.store.has('legacy_c1')).toBe(false);
    });
});

describe('a split that cannot be written', () => {
    test('leaves the legacy key in place and keeps serving reads from it', async () => {
        const legacy = [at(2026, 6), at(2026, 7)];
        storageMock.store.set('legacy_c1', legacy);
        storageMock.putAll.mockImplementation(async () => 0);
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        const history = build();
        const loaded = await history.load('c1');

        expect(loaded).toEqual(legacy);
        expect(storageMock.store.get('legacy_c1')).toEqual(legacy);
        expect(history.isLegacy()).toBe(true);
    });

    test('a partly written split is refused rather than half-adopted', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 6), at(2026, 7)]);
        // One of the two chunks lands — which is the state that would lose the other
        storageMock.putAll.mockImplementation(async (storeName, entries) => {
            const [key] = Object.keys(entries);
            storageMock.store.set(key, entries[key]);
            return 1;
        });

        const history = build();
        await history.load('c1');

        expect(history.isLegacy()).toBe(true);
        expect(storageMock.store.has('legacy_c1')).toBe(true);
    });

    test('a legacy key that cannot be deleted keeps the history on it', async () => {
        // The one state that loses data: records written, legacy still there, and
        // the next load reading the legacy over the top of everything since
        storageMock.store.set('legacy_c1', [at(2026, 6)]);
        storageMock.delete.mockImplementation(async () => false);

        const history = build();
        await history.load('c1');

        expect(history.isLegacy()).toBe(true);
    });

    test('writes go to the legacy key while the split is refused', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 6)]);
        storageMock.putAll.mockImplementation(async () => 0);

        const history = build();
        const loaded = await history.load('c1');
        await history.save('c1', [...loaded, at(2026, 7)]);

        expect(written()).toEqual(['legacy_c1']);
        expect(storageMock.store.get('legacy_c1')).toHaveLength(2);
    });
});

describe('reading records back', () => {
    test('chunks are assembled in the comparator order, whatever order the keys came in', async () => {
        storageMock.store.set('rec_c1_2026-08', [at(2026, 8)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        storageMock.store.set('rec_c1_2026-07', [at(2026, 7)]);
        storageMock.store.set('rec_c2_2026-07', [at(2026, 7)]);
        storageMock.store.set('somethingElse', { not: 'a chunk' });

        const loaded = await build().load('c1');

        expect(loaded.map((p) => p.v)).toEqual(['2026-6-1', '2026-7-1', '2026-8-1']);
    });

    test('the array handed out is a copy, so a caller sorting it cannot corrupt the diff', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);
        history.forget();

        const loaded = await history.load('c1');
        loaded.reverse();
        storageMock.set.mockClear();

        await history.save('c1', await history.load('c1'));

        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('a save before any read still diffs against what is stored', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);

        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);

        expect(written()).toEqual(['rec_c1_2026-07']);
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(true);
    });
});

describe('clearing', () => {
    test('removes every record and the legacy key with them', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 5)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        storageMock.store.set('rec_c2_2026-06', [at(2026, 6)]);

        const history = build();
        await history.clear('c1');

        expect(storageMock.store.has('legacy_c1')).toBe(false);
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(false);
        expect(storageMock.store.has('rec_c2_2026-06')).toBe(true);
        expect(await history.load('c1')).toEqual([]);
    });

    test('a clear that worked says so', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        expect(await build().clear('c1')).toBe(true);
    });

    /*
     * `clear()` found the record keys through `getAllKeys`, which answers a
     * listing it could not make with an empty array. Nothing was deleted, the
     * in-memory copy was dropped anyway, and the next `load()` read the records
     * still on disk straight back — the history the user had just been told was
     * deleted. Fails before the switch to `tryGetAllKeys`: `clear` returned
     * undefined and the records came back.
     */
    test('a store that could not be listed refuses the clear rather than half-doing it', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 5)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        const history = build();
        await history.load('c1');
        // The load folds the legacy key into the records, deletes included
        storageMock.delete.mockClear();

        // The clear's own listing is the one that cannot be made
        storageMock.tryGetAllKeys.mockResolvedValueOnce(null);
        const cleared = await history.clear('c1');

        expect(cleared).toBe(false);
        // Nothing deleted, so nothing resurrects on the next read
        expect(storageMock.delete).not.toHaveBeenCalled();
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(true);
        expect(await history.load('c1')).toEqual([at(2026, 5), at(2026, 6)]);
    });

    /*
     * `storage.delete` resolves `false` for a delete that did not happen and
     * never rejects, so a listing that succeeded followed by deletes that all
     * failed — an aborted transaction, a restore in progress refusing writes —
     * looked exactly like a clear that worked. Fails before the outcome check:
     * `clear` returned true and the records were still there for the next
     * `load()`.
     */
    test('deletes that resolve false are a refused clear, not a done one', async () => {
        storageMock.store.set('legacy_c1', [at(2026, 5)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        storageMock.delete.mockImplementation(async () => false);

        const history = build();
        const cleared = await history.clear('c1');

        expect(cleared).toBe(false);
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(true);
        expect(await history.load('c1')).toEqual([at(2026, 5), at(2026, 6)]);
    });

    test('a failed delete is reported as a failure, not as a clear', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        storageMock.delete.mockRejectedValueOnce(new Error('nope'));

        expect(await build().clear('c1')).toBe(false);
    });

    test('no character is nothing cleared', async () => {
        expect(await build().clear('')).toBe(false);
    });
});

describe('the changed-chunk hint', () => {
    test('only the hinted chunk is written, even when another one also changed', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);
        storageMock.set.mockClear();

        // Both months differ from what is stored, but the caller vouches for
        // July only — an append knows exactly which chunk it touched.
        await history.save('c1', [at(2026, 6, 2), at(2026, 7, 2)], { changedChunks: '2026-07' });

        expect(written()).toEqual(['rec_c1_2026-07']);
    });

    test('an unhinted save still compares every chunk', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);
        storageMock.set.mockClear();

        await history.save('c1', [at(2026, 6, 2), at(2026, 7, 2)]);

        expect(written().sort()).toEqual(['rec_c1_2026-06', 'rec_c1_2026-07']);
    });

    test('a chunk that has never been written is written whatever the hint says', async () => {
        const history = build();
        await history.save('c1', [at(2026, 7)]);
        storageMock.set.mockClear();

        // The hint names July, but August has no stored serialisation to
        // carry forward, so skipping it would lose the entry entirely
        await history.save('c1', [at(2026, 7), at(2026, 8)], { changedChunks: '2026-07' });

        expect(written()).toContain('rec_c1_2026-08');
    });

    test('a hinted save still prunes a chunk that lost all its entries', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);
        expect(storageMock.store.has('rec_c1_2026-06')).toBe(true);

        await history.save('c1', [at(2026, 7)], { changedChunks: '2026-07' });

        expect(storageMock.store.has('rec_c1_2026-06')).toBe(false);
    });

    test('a hinted save still writes an older chunk that lost only some of its entries', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 6, 2), at(2026, 7)]);
        storageMock.set.mockClear();

        // The trap the entry count is there for: a partial shrink of a chunk the hint
        // does not name. Skipping it writes nothing and carries the stale serialisation
        // forward, so the shrink would never reach disk at all.
        await history.save('c1', [at(2026, 6), at(2026, 7), at(2026, 7, 2)], { changedChunks: '2026-07' });

        // The removed entry has a survivor on either side of it in the stored
        // order, which is what `_recordDeletions` reads as a deletion rather
        // than as a window sliding, so the deletion record is written too
        expect(written().sort()).toEqual(['recTomb_c1', 'rec_c1_2026-06', 'rec_c1_2026-07']);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });

    test('the hint accepts an array or a Set as well as one id', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7), at(2026, 8)]);
        storageMock.set.mockClear();

        await history.save('c1', [at(2026, 6, 2), at(2026, 7, 2), at(2026, 8, 2)], {
            changedChunks: ['2026-06', '2026-08'],
        });

        expect(written().sort()).toEqual(['rec_c1_2026-06', 'rec_c1_2026-08']);
    });
});

describe('two loads at once', () => {
    test('a second load in flight waits for the read rather than being told the history is empty', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);

        // The read is slow, as a real IndexedDB round trip is
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        storageMock.getAllKeys.mockImplementation(async () => {
            await held;
            return [...storageMock.store.keys()];
        });

        const store = build();
        const first = store.load('c1');
        const second = store.load('c1');
        release();

        // Before: the second caller saw `_loaded` already true and got [],
        // which a recorder would then merge onto and write back as the truth
        expect((await second).map((p) => p.v)).toEqual(['2026-6-1']);
        expect((await first).map((p) => p.v)).toEqual(['2026-6-1']);
    });

    test('a character switch mid-read does not commit the departing character’s entries', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);

        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        storageMock.getAllKeys.mockImplementation(async () => {
            await held;
            return [...storageMock.store.keys()];
        });

        const store = build();
        const reading = store.load('c1');
        store.forget();
        release();
        await reading;

        expect(store._loaded).toBe(false);
        expect(store._charId).toBeNull();
    });
});

describe('a save whose own load is superseded by another character', () => {
    test('the arriving character is not handed the departing one’s history', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);
        storageMock.store.set('rec_c2_2026-07', [at(2026, 7)]);

        // Only the first read hangs, so the switch's own load lands first and
        // takes the load token
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        let holds = 1;
        storageMock.getAllKeys.mockImplementation(async () => {
            if (holds-- > 0) await held;
            return [...storageMock.store.keys()];
        });

        const store = build();
        // Nothing is loaded, so this save has to read first — and that read hangs
        const saving = store.save('c1', [at(2026, 6), at(2026, 6, 2)]);
        const arriving = store.load('c2');
        release();
        await arriving;
        await saving;

        // `load()` short-circuits on `_charId`, so a departing save that wrote
        // its list into `_entries` under the arriving character's name served
        // that list back as the arriving character's history — and the next
        // save wrote it under their chunk keys.
        expect((await store.load('c2')).map((p) => p.v)).toEqual(['2026-7-1']);
    });
});

describe('the snapshot only claims what was written', () => {
    test('a refused write is retried by the next save instead of being skipped for ever', async () => {
        const store = build();
        await store.load('c1');

        storageMock.set.mockImplementation(async () => false);
        await store.save('c1', [at(2026, 6)]);

        // Before: the snapshot said the chunk was on disk, so an identical
        // future save compared equal and never wrote it again
        storageMock.set.mockImplementation(async (key, value) => {
            storageMock.store.set(key, value);
            return true;
        });
        storageMock.set.mockClear();
        await store.save('c1', [at(2026, 6)]);

        expect(written()).toEqual(['rec_c1_2026-06']);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });

    test('a confirmed write is still skipped the second time, which is the whole point', async () => {
        const store = build();
        await store.load('c1');
        await store.save('c1', [at(2026, 6)]);
        storageMock.set.mockClear();

        await store.save('c1', [at(2026, 6)]);

        expect(written()).toEqual([]);
    });
});

describe('the sync merge every chunked history registers', () => {
    test('a pulled chunk is combined with this device’s copy rather than replacing it', async () => {
        const { mergeForKey, clearSyncMerges } = await import('./sync-merge-registry.js');

        // Registration happens when the store is constructed, and the module
        // deduplicates by prefix — so a fresh registry needs a fresh prefix
        clearSyncMerges();
        const store = createChunkedHistory({
            storeName: 'testStore',
            prefix: 'mergeRec',
            legacyKey: (charId) => `legacy_${charId}`,
            groupOf: (point) => timeChunkId(point?.t, 'month'),
            compare: (a, b) => a.t - b.t,
            label: 'MergeTest',
        });
        expect(store).toBeTruthy();

        const registration = mergeForKey('testStore', 'mergeRec_c1_2026-06');
        expect(registration).toBeTruthy();

        const local = [at(2026, 6, 1)];
        const incoming = [at(2026, 6, 2)];
        const merged = registration.merge(local, incoming);

        expect(merged.map((p) => p.v)).toEqual(['2026-6-1', '2026-6-2']);
        // Pure: neither side is mutated
        expect(local).toHaveLength(1);
        expect(incoming).toHaveLength(1);
    });

    test('an entry both devices have survives once', async () => {
        const { mergeForKey, clearSyncMerges } = await import('./sync-merge-registry.js');
        clearSyncMerges();
        createChunkedHistory({
            storeName: 'testStore',
            prefix: 'dupeRec',
            legacyKey: (charId) => `legacy_${charId}`,
            groupOf: (point) => timeChunkId(point?.t, 'month'),
            compare: (a, b) => a.t - b.t,
            label: 'DupeTest',
        });

        const { merge } = mergeForKey('testStore', 'dupeRec_c1_2026-06');
        expect(merge([at(2026, 6)], [at(2026, 6), at(2026, 7)]).map((p) => p.v)).toEqual(['2026-6-1', '2026-7-1']);
    });

    test('the legacy single key is claimed too, so a stalled split is not a hole in the cover', async () => {
        const { mergeForKey, clearSyncMerges } = await import('./sync-merge-registry.js');
        clearSyncMerges();
        createChunkedHistory({
            storeName: 'testStore',
            prefix: 'legacyCoverRec',
            legacyKey: (charId) => `legacyCover_${charId}`,
            groupOf: (point) => timeChunkId(point?.t, 'month'),
            compare: (a, b) => a.t - b.t,
            label: 'LegacyCoverTest',
        });

        // A device whose split could not be written keeps writing the whole
        // array to the legacy key — `_legacy` mode. Unclaimed, that key came
        // down whole and took every entry only this device had with it, which
        // is the one moment (a full disk) it can least afford to happen
        const registration = mergeForKey('testStore', 'legacyCover_c1');
        expect(registration).toBeTruthy();
        expect(registration.merge([at(2026, 6)], [at(2026, 7)]).map((p) => p.v)).toEqual(['2026-6-1', '2026-7-1']);

        // ...and the record keys still belong to the record registration, not
        // to this one — the two must not both claim a key
        expect(mergeForKey('testStore', 'legacyCoverRec_c1_2026-06')).toBeTruthy();
    });

    test('a caller-named identity beats deep equality, for entries that are rewritten in place', async () => {
        const { mergeForKey, clearSyncMerges } = await import('./sync-merge-registry.js');
        clearSyncMerges();
        createChunkedHistory({
            storeName: 'testStore',
            prefix: 'idRec',
            legacyKey: (charId) => `legacy_${charId}`,
            groupOf: (point) => timeChunkId(point?.t, 'month'),
            compare: (a, b) => a.t - b.t,
            identityOf: (point) => point?.id,
            label: 'IdTest',
        });

        const { merge } = mergeForKey('testStore', 'idRec_c1_2026-06');
        const local = [{ id: 7, t: 1, count: 12 }];
        const incoming = [{ id: 7, t: 1, count: 9 }];

        // The same action, recorded twice with different running totals: one
        // entry out, and it is this device's — the live one
        expect(merge(local, incoming)).toEqual([{ id: 7, t: 1, count: 12 }]);
    });
});

describe('a listing that could not be made is not an empty history', () => {
    test('an unreadable store does not become an empty history that is written back', async () => {
        // A month of loot, already on disk
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6), at(2026, 6, 2), at(2026, 6, 3)]);

        // The database says it cannot list the store. Before, `getAllKeys`
        // answered that with `[]`, the history read as empty, and the append
        // below wrote its single entry over the month.
        storageMock.tryGetAllKeys.mockImplementation(async () => null);

        const store = build();
        expect(await store.load('c1')).toEqual([]);
        expect(store._loaded).toBe(false);

        expect(await store.save('c1', [at(2026, 6, 4)])).toBe(false);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(3);
    });

    test('the next save reads again once the store answers', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6), at(2026, 6, 2)]);
        storageMock.tryGetAllKeys.mockImplementation(async () => null);

        const store = build();
        expect(await store.save('c1', [at(2026, 6, 4)])).toBe(false);

        storageMock.tryGetAllKeys.mockImplementation(async (...args) => storageMock.getAllKeys(...args));
        const entries = await store.load('c1');
        expect(entries).toHaveLength(2);

        expect(await store.save('c1', [...entries, at(2026, 6, 4)])).toBe(true);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(3);
    });

    test('a chunk the listing named and the read did not deliver is not silently dropped', async () => {
        storageMock.store.set('rec_c1_2026-05', [at(2026, 5)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6)]);

        // `getMany` seeds every key with null and only overwrites what it read,
        // so an aborted transaction comes back as nulls rather than an error
        storageMock.getMany.mockImplementation(async (keys) => {
            const result = new Map();
            for (const key of keys) result.set(key, null);
            return result;
        });

        const store = build();
        expect(await store.load('c1')).toEqual([]);
        expect(store._loaded).toBe(false);
        expect(await store.save('c1', [at(2026, 6, 2)])).toBe(false);
        expect(storageMock.store.get('rec_c1_2026-05')).toHaveLength(1);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });

    // `_read` used to clear `_unreadableFor` before checking whether its own
    // read was still the current one, so a read abandoned by a character switch
    // could answer late and erase the failure flag a *current* read had just
    // set — and the save waiting on that current read then wrote its single
    // entry over the month it had never managed to read.
    test('a read abandoned by a character switch does not clear a current failure', async () => {
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6), at(2026, 6, 2), at(2026, 6, 3)]);

        /** Each listing's resolver, in call order, so the two reads can be landed out of order */
        const gates = [];
        storageMock.tryGetAllKeys.mockImplementation(() => new Promise((resolve) => gates.push(resolve)));

        const store = build();
        const abandoned = store.load('c1');
        await Promise.resolve();
        await Promise.resolve();
        store.forget();

        // The read that replaces it, and the save that waits on that same read
        const reloaded = store.load('c1');
        const saved = store.save('c1', [at(2026, 6, 4)]);
        await Promise.resolve();
        await Promise.resolve();
        expect(gates).toHaveLength(2);

        // The current read cannot list the store; the abandoned one answers
        // afterwards, and its answer is about nobody
        gates[1](null);
        gates[0]([]);

        await abandoned;
        await reloaded;
        expect(await saved).toBe(false);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(3);
    });

    test('a genuinely empty store still loads as empty and saves', async () => {
        const store = build();
        expect(await store.load('c1')).toEqual([]);
        expect(store._loaded).toBe(true);
        expect(await store.save('c1', [at(2026, 6)])).toBe(true);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(1);
    });
});

describe('maxRecordsPerCharacter', () => {
    // `STORE_KEY_BUDGETS` (core/storage.js) budgets some stores per character.
    // A flat count of every key in the store adds every character's chunked
    // records together — this is what a per-character-aware budget check
    // compares against the budget instead.
    test('the busiest character, not the store total', () => {
        createChunkedHistory({
            storeName: 'budgetStore',
            prefix: 'budgetRec',
            legacyKey: (id) => `legacy_${id}`,
            groupOf: () => '2026-01',
            compare: () => 0,
            label: 'BudgetTest',
        });

        const keys = [
            'budgetRec_alice_2026-01',
            'budgetRec_alice_2026-02',
            'budgetRec_bob_2026-01',
            'somethingUnrelated',
        ];

        // Alice has two chunks, bob has one — a flat count of the store (3)
        // would already be treating a second, lighter character as part of
        // one leak, and a budget sized for one character would compare it
        // against the wrong number too.
        expect(maxRecordsPerCharacter('budgetStore', keys)).toBe(2);
    });

    // xpHistory chunks two independent series (skills, abilities) under
    // different prefixes; a character's real footprint is both together.
    test('sums every prefix registered for the store, per character', () => {
        createChunkedHistory({
            storeName: 'multiPrefixStore',
            prefix: 'seriesA',
            legacyKey: (id) => `legacyA_${id}`,
            groupOf: () => '2026-01',
            compare: () => 0,
            label: 'SeriesA',
        });
        createChunkedHistory({
            storeName: 'multiPrefixStore',
            prefix: 'seriesB',
            legacyKey: (id) => `legacyB_${id}`,
            groupOf: () => '2026-01',
            compare: () => 0,
            label: 'SeriesB',
        });

        const keys = ['seriesA_alice_2026-01', 'seriesA_alice_2026-02', 'seriesB_alice_2026-01'];

        expect(maxRecordsPerCharacter('multiPrefixStore', keys)).toBe(3);
    });

    // A per-character budget covers every key family the character keeps in the
    // store, and `networthHistory` budgets twenty-five item-level detail
    // snapshots per character that are written key by key rather than through a
    // `ChunkedHistory`. Unregistered they would drop out of the count entirely,
    // and a leak in them could never trip the budget.
    test('a key family registered without a ChunkedHistory counts toward its character', () => {
        registerCharacterScopedPrefix('detailStore', 'detailRec');

        const keys = ['detailRec_alice_1', 'detailRec_alice_2', 'detailRec_bob_1'];
        expect(maxRecordsPerCharacter('detailStore', keys)).toBe(2);
    });

    test('registering the same pair twice does not double-count it', () => {
        registerCharacterScopedPrefix('twiceStore', 'twiceRec');
        registerCharacterScopedPrefix('twiceStore', 'twiceRec');

        expect(maxRecordsPerCharacter('twiceStore', ['twiceRec_alice_1', 'twiceRec_alice_2'])).toBe(2);
    });

    // The legacy single-array key is `<base>_<charId>` and shares the stem, so
    // a count that read it as a record would credit a character with a key
    // that is not one of theirs — the id is read up to the next underscore, and
    // a two-segment key has none
    test('a two-segment legacy key sharing the stem is not counted as a record', () => {
        registerCharacterScopedPrefix('legacyStemStore', 'stemRec');

        expect(maxRecordsPerCharacter('legacyStemStore', ['stemRec_alice', 'stemRec_alice_1'])).toBe(1);
    });

    test('a store nothing here chunks defers to the flat count', () => {
        expect(maxRecordsPerCharacter('neverChunkedStore', ['a', 'b'])).toBeNull();
    });
});

describe('a split that cannot see what is already stored', () => {
    test('a listing that could not be made leaves the legacy key and the records alone', async () => {
        // A pull from a device whose split stalled dropped a legacy key beside
        // this device's records; a listing that fails here used to read as
        // "no records yet", and the split wrote the legacy chunks over them
        storageMock.store.set('legacy_c1', [at(2026, 6, 9)]);
        storageMock.store.set('rec_c1_2026-06', [at(2026, 6), at(2026, 6, 2)]);
        storageMock.tryGetAllKeys.mockImplementation(async () => null);

        const store = build();
        const entries = await store.load('c1');

        expect(store.isLegacy()).toBe(true);
        expect(entries.map((p) => p.v)).toEqual(['2026-6-9']);
        expect(storageMock.store.get('legacy_c1')).toHaveLength(1);
        expect(storageMock.store.get('rec_c1_2026-06')).toHaveLength(2);
    });
});

/**
 * A history whose entries carry a mutable field, keyed by a stable id — the
 * loot log's shape, whose live session's `endTime` is rewritten for as long as
 * the session runs.
 */
const buildLive = () =>
    createChunkedHistory({
        storeName: 'testStore',
        prefix: 'rec',
        legacyKey: (charId) => `legacy_${charId}`,
        groupOf: (point) => timeChunkId(point?.t, 'month'),
        compare: (a, b) => a.t - b.t,
        identityOf: (point) => String(point?.t),
        label: 'Test',
    });

/** Everything one device's disk holds, as a sync payload would carry it */
const snapshotOfDisk = () => JSON.parse(JSON.stringify([...storageMock.store.entries()]));

/** Replace the disk with a payload, for standing the other device up */
const restoreDisk = (entries) => {
    storageMock.store.clear();
    for (const [key, value] of entries) storageMock.store.set(key, value);
};

/**
 * Apply a peer's payload the way `sync-payload.js` does: a key with a
 * registered merge is folded onto this device's copy, and anything else is
 * written whole. The registry holds the FIRST built store's closures, so the
 * fold is asked of the device doing the pulling instead — same functions, the
 * right device's tombstones.
 * @param {Object} device - The store doing the pulling
 * @param {Array<Array>} payload - The peer's `[key, value]` pairs
 * @returns {void}
 */
const pull = (device, payload) => {
    for (const [key, incoming] of payload) {
        const local = storageMock.store.has(key) ? storageMock.store.get(key) : undefined;
        if (key.startsWith('recTomb_')) storageMock.store.set(key, mergeTombstones(local, incoming));
        else if (Array.isArray(local) && Array.isArray(incoming)) {
            storageMock.store.set(key, device._union(local, incoming));
        } else storageMock.store.set(key, incoming);
    }
};

/**
 * The `v` of every entry a device reads back from disk.
 * @param {Object} device - The store to read
 * @param {string} [charId] - Whose history
 * @returns {Promise<Array<string>>} The labels, in the comparator's order
 */
const readBack = async (device, charId = 'c1') => {
    device.forget();
    return (await device.load(charId)).map((point) => point.v);
};

describe('a deleted entry is not handed back by the next pull', () => {
    test('the deleting device does not take it back from a peer that still holds it', async () => {
        const peer = build();
        await peer.save('c1', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]);
        const theirs = snapshotOfDisk();

        // The user deletes the middle entry here and the peer never learns of
        // it before pushing: the fold used to union its copy straight back in
        const device = build();
        await device.load('c1');
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 3)]);
        pull(device, theirs);

        expect(await readBack(device)).toEqual(['2026-6-1', '2026-6-3']);
    });

    test('the peer stops holding it too, so it cannot come back on the round trip', async () => {
        const device = build();
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]);
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 3)]);
        const ours = snapshotOfDisk();

        // The peer still has all three, and only the pulling device merges
        restoreDisk([['rec_c1_2026-06', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]]]);
        const peer = build();
        await peer.load('c1');
        pull(peer, ours);

        expect(await readBack(peer)).toEqual(['2026-6-1', '2026-6-3']);

        // …and what it would push back no longer carries the deleted entry
        const back = snapshotOfDisk();
        restoreDisk(ours);
        await device.load('c1');
        pull(device, back);
        expect(await readBack(device)).toEqual(['2026-6-1', '2026-6-3']);
    });

    test('an entry the peer added after the deletion is not caught by the tombstone', async () => {
        const device = build();
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]);
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 3)]);

        const theirs = [['rec_c1_2026-06', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3), at(2026, 6, 4)]]];
        pull(device, theirs);

        expect(await readBack(device)).toEqual(['2026-6-1', '2026-6-3', '2026-6-4']);
    });

    test('a cleared history stays cleared when the peer pushes its copy back', async () => {
        const device = build();
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]);
        const theirs = snapshotOfDisk();

        expect(await device.clear('c1')).toBe(true);
        pull(device, theirs);

        expect(await readBack(device)).toEqual([]);
    });

    test('the deletion is registered as its own sync merge, not swept into the record union', async () => {
        const { clearSyncMerges } = await import('./sync-merge-registry.js');

        // Registration is per constructed store and deduplicated by prefix, so
        // a fresh registry needs a fresh prefix — as the merge tests above do
        clearSyncMerges();
        createChunkedHistory({
            storeName: 'testStore',
            prefix: 'tombRec',
            legacyKey: (charId) => `tombLegacy_${charId}`,
            groupOf: (point) => timeChunkId(point?.t, 'month'),
            compare: (a, b) => a.t - b.t,
            label: 'TombTest',
        });

        // The deletion key must be owned by exactly one registration: an
        // overlap resolves to bundle import order, and the record union would
        // read a tombstone map as "not an array" and take the remote copy whole
        expect(mergeForKey('testStore', 'tombRecTomb_c1')?.label).toBe('TombTest deletions');
        expect(mergeForKey('testStore', 'tombRec_c1_2026-06')?.label).toBe('TombTest records');
    });
});

describe('a copy touched since the deletion keeps the entry', () => {
    /*
     * The loot log's live session: `endTime` and `actionCount` are rewritten
     * while it runs, which is why `_union` prefers the base copy at all. A
     * device still writing to a session has seen the deletion and kept it, so
     * the deletion is stale news and the tombstone is dropped rather than
     * applied to a copy it was never about.
     */
    const live = (t, endTime) => ({ t, endTime, v: `s${t}` });

    test('a peer copy rewritten after the tombstone survives the fold', async () => {
        const device = buildLive();
        await device.save('c1', [live(1, 10), live(2, 20), live(3, 30)]);
        await device.save('c1', [live(1, 10), live(3, 30)]);

        // The peer's copy of the deleted session has run on since
        pull(device, [['rec_c1_1970-01', [live(1, 10), live(2, 99), live(3, 30)]]]);

        expect(await readBack(device)).toEqual(['s1', 's2', 's3']);
        // And the tombstone is cleared, so it cannot fire again later
        expect(storageMock.store.has('recTomb_c1')).toBe(false);
    });

    test('an unchanged peer copy is still deleted', async () => {
        const device = buildLive();
        await device.save('c1', [live(1, 10), live(2, 20), live(3, 30)]);
        await device.save('c1', [live(1, 10), live(3, 30)]);
        pull(device, [['rec_c1_1970-01', [live(1, 10), live(2, 20), live(3, 30)]]]);

        expect(await readBack(device)).toEqual(['s1', 's3']);
    });
});

describe('the deletion record is bounded', () => {
    test('a deletion older than the max age stops being remembered', async () => {
        const device = build();
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]);
        await device.save('c1', [at(2026, 6, 1), at(2026, 6, 3)]);

        const stones = storageMock.store.get('recTomb_c1');
        for (const stone of Object.values(stones)) stone.at = Date.now() - TOMBSTONE_MAX_AGE_MS - 1;

        pull(device, [['rec_c1_2026-06', [at(2026, 6, 1), at(2026, 6, 2), at(2026, 6, 3)]]]);

        // Degrades to the old behaviour for that entry — never to losing one
        expect(await readBack(device)).toEqual(['2026-6-1', '2026-6-2', '2026-6-3']);
        expect(storageMock.store.has('recTomb_c1')).toBe(false);
    });

    test('the map is held to MAX_TOMBSTONES, newest kept', () => {
        const many = {};
        for (let index = 0; index <= MAX_TOMBSTONES; index += 1) many[`id-${index}`] = { at: index, fp: 'f' };

        const capped = mergeTombstones({}, many, 0);

        expect(Object.keys(capped)).toHaveLength(MAX_TOMBSTONES);
        expect(capped['id-0']).toBeUndefined();
        expect(capped[`id-${MAX_TOMBSTONES}`]).toBeDefined();
    });

    test('the later deletion wins when both devices tombstoned the same entry', () => {
        const merged = mergeTombstones({ a: { at: 5, fp: 'x' } }, { a: { at: 9, fp: 'y' } }, 9);
        expect(merged.a).toEqual({ at: 9, fp: 'y', bulk: false });
    });
});

describe('a tombstone set that would empty the history', () => {
    test('is refused rather than half-applied', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const points = [1, 2, 3, 4, 5, 6].map((day) => at(2026, 6, day));

        const device = build();
        await device.save('c1', points);
        // Four of the six deleted at once, all interior
        await device.save('c1', [points[0], points[5]]);
        const ours = snapshotOfDisk();

        // The peer holds all six and pulls only the deletions — its own copies
        // are the base of the union, so nothing drops until the read
        restoreDisk([['rec_c1_2026-06', points]]);
        const peer = build();
        await peer.load('c1');
        pull(
            peer,
            ours.filter(([key]) => key === 'recTomb_c1')
        );

        expect(await readBack(peer)).toHaveLength(6);
        expect(warn.mock.calls.some(([line]) => String(line).includes('Refusing a fold'))).toBe(true);
        warn.mockRestore();
    });

    test('does not hold back a whole-history clear, which is what the user asked for', async () => {
        const points = [1, 2, 3, 4, 5, 6].map((day) => at(2026, 6, day));

        const device = build();
        await device.save('c1', points);
        await device.clear('c1');
        const ours = snapshotOfDisk();

        restoreDisk([['rec_c1_2026-06', points]]);
        const peer = build();
        await peer.load('c1');
        pull(peer, ours);

        expect(await readBack(peer)).toEqual([]);
    });
});

describe('a history nobody has deleted from', () => {
    test('writes exactly the keys it always did, and no deletion record', async () => {
        const history = build();
        await history.save('c1', [at(2026, 6), at(2026, 7)]);
        await history.save('c1', [at(2026, 6), at(2026, 7), at(2026, 8)], { changedChunks: '2026-08' });
        // A rolling window sliding off the old end is housekeeping, not a deletion
        await history.save('c1', [at(2026, 7), at(2026, 8)]);

        expect(written().filter((key) => key.includes('Tomb'))).toEqual([]);
        expect([...storageMock.store.keys()].filter((key) => key.includes('Tomb'))).toEqual([]);
        expect(await readBack(history)).toEqual(['2026-7-1', '2026-8-1']);
    });
});
