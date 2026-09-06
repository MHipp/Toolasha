/**
 * The loot log's history, which used to rewrite every stored entry on every
 * `loot_log_updated` — a full-array write every few seconds while a fast action
 * runs, for a list that changes by one entry.
 *
 * What is worth testing is therefore not the merge arithmetic but the write
 * shape: one record per hour of play so that a merge writes the current hour and
 * nothing else, debounced rather than immediate, one merge landing on top of the
 * last even while the write is still pending, and nothing built at all once the
 * database has said it is full.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({ id: 'char-1' }));

const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
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
        // Delegates to the listing above, so a test that changes how keys are
        // listed changes both. `chunked-history.js` reads through this one
        // because an unlistable store must not read as an empty history.
        tryGetAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
});

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => character.id } }));

const { default: lootLogHistory, MAX_ENTRIES } = await import('./loot-log-history.js');

/**
 * A loot log entry as the game sends it.
 * @param {number} id - characterActionId
 * @param {string} startTime - ISO start time
 * @returns {Object} Entry
 */
const entry = (id, startTime) => ({ characterActionId: id, startTime, endTime: startTime, actionCount: 1 });

/** Every key written that is a loot record rather than the legacy array */
const recordWrites = () => storageMock.set.mock.calls.filter(([key]) => String(key).startsWith('lootLogRec_'));

beforeEach(() => {
    character.id = 'char-1';
    storageMock.store.clear();
    // mockReset, not mockClear: `a split that cannot be written` swaps in a
    // putAll that lands nothing, and mockClear only forgets the calls — the
    // implementation stayed, so every later split in the file "stalled", kept
    // the legacy key and re-ran on the next read.
    for (const fn of Object.values(storageMock)) fn.mockReset?.();
    lootLogHistory._store.forget();
});

describe('writes', () => {
    test('a merge writes one record, under the hour the entry belongs to', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]);

        const writes = recordWrites();
        expect(writes).toHaveLength(1);
        const [key, value, storeName, immediate] = writes[0];
        expect(key).toBe('lootLogRec_char-1_2026-08-01T13');
        expect(value).toHaveLength(1);
        expect(storeName).toBe('lootLogHistory');
        // The whole point of the debounce: no `immediate` flag, so bursts coalesce
        expect(immediate).toBe(false);
    });

    test('appending writes only the tail record, not the hours already settled', async () => {
        await lootLogHistory.mergeAndSave([
            entry(1, '2026-08-01T10:00:00Z'),
            entry(2, '2026-08-01T11:00:00Z'),
            entry(3, '2026-08-01T12:00:00Z'),
        ]);
        storageMock.set.mockClear();

        await lootLogHistory.mergeAndSave([entry(4, '2026-08-01T13:00:00Z')]);

        // Three earlier hours are in storage and unchanged; only the new one is written
        expect(recordWrites().map(([key]) => key)).toEqual(['lootLogRec_char-1_2026-08-01T13']);
    });

    test('an entry that changes rewrites only its own hour', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T10:00:00Z'), entry(2, '2026-08-01T11:00:00Z')]);
        storageMock.set.mockClear();

        // The same action, further along — the shape of an ongoing session
        await lootLogHistory.mergeAndSave([{ ...entry(1, '2026-08-01T10:00:00Z'), actionCount: 9 }]);

        expect(recordWrites().map(([key]) => key)).toEqual(['lootLogRec_char-1_2026-08-01T10']);
    });

    test('a merge that changes nothing writes nothing', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        storageMock.set.mockClear();

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('an empty loot log is not a write', async () => {
        await lootLogHistory.mergeAndSave([]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });
});

describe('merging while a write is still pending', () => {
    test('successive merges accumulate rather than each landing on stale storage', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        await lootLogHistory.mergeAndSave([entry(2, '2026-08-02T00:00:00Z')]);
        await lootLogHistory.mergeAndSave([entry(3, '2026-08-03T00:00:00Z')]);

        const historical = await lootLogHistory.getHistoricalEntries(new Set());
        expect(historical.map((e) => e.characterActionId)).toEqual([3, 2, 1]);
    });

    test('storage is scanned once, not once per loot message', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        storageMock.getAllKeys.mockClear();

        await lootLogHistory.mergeAndSave([entry(2, '2026-08-02T00:00:00Z')]);

        expect(storageMock.getAllKeys).not.toHaveBeenCalled();
    });

    test('the historical read sees entries that have not been flushed yet', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z'), entry(2, '2026-08-02T00:00:00Z')]);

        const historical = await lootLogHistory.getHistoricalEntries(new Set([2]));

        expect(historical.map((e) => e.characterActionId)).toEqual([1]);
    });

    test('clearing drops every record and the in-memory copy with them', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z'), entry(2, '2026-08-02T05:00:00Z')]);

        await lootLogHistory.clearHistory();

        expect(storageMock.delete).toHaveBeenCalledWith('lootLogRec_char-1_2026-08-01T00', 'lootLogHistory');
        expect(storageMock.delete).toHaveBeenCalledWith('lootLogRec_char-1_2026-08-02T05', 'lootLogHistory');
        expect(storageMock.delete).toHaveBeenCalledWith('lootLog_char-1', 'lootLogHistory');
        expect(await lootLogHistory.getHistoricalEntries(new Set())).toEqual([]);
    });

    // A clear that could not list the store deletes nothing; the caller has to
    // be able to tell, or it announces a delete that did not happen.
    test('a clear that could not be made is reported as not made', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        storageMock.delete.mockClear();
        storageMock.tryGetAllKeys.mockResolvedValueOnce(null);

        expect(await lootLogHistory.clearHistory()).toBe(false);
        expect(storageMock.delete).not.toHaveBeenCalled();
        expect(await lootLogHistory.getHistoricalEntries(new Set())).toHaveLength(1);
    });
});

describe('the one-time split of the legacy array', () => {
    test('the single key becomes one record per hour and is removed', async () => {
        storageMock.store.set('lootLog_char-1', [entry(2, '2026-08-01T11:30:00Z'), entry(1, '2026-08-01T10:00:00Z')]);

        const loaded = await lootLogHistory.getHistoricalEntries(new Set());

        expect(loaded.map((e) => e.characterActionId)).toEqual([2, 1]);
        expect(storageMock.putAll).toHaveBeenCalledWith('lootLogHistory', {
            'lootLogRec_char-1_2026-08-01T11': [expect.objectContaining({ characterActionId: 2 })],
            'lootLogRec_char-1_2026-08-01T10': [expect.objectContaining({ characterActionId: 1 })],
        });
        expect(storageMock.store.has('lootLog_char-1')).toBe(false);
    });

    test('reading after the split returns exactly what reading before it did', async () => {
        const legacy = [
            entry(3, '2026-08-02T09:00:00Z'),
            entry(2, '2026-08-01T11:30:00Z'),
            entry(1, '2026-08-01T10:00:00Z'),
        ];
        storageMock.store.set('lootLog_char-1', legacy);

        const before = await lootLogHistory.getHistoricalEntries(new Set());
        lootLogHistory._store.forget();
        const after = await lootLogHistory.getHistoricalEntries(new Set());

        expect(after).toEqual(before);
        expect(after).toEqual(legacy);
    });

    test('splitting a second time is a no-op rather than a duplication', async () => {
        storageMock.store.set('lootLog_char-1', [entry(1, '2026-08-01T10:00:00Z')]);
        await lootLogHistory.getHistoricalEntries(new Set());

        lootLogHistory._store.forget();
        storageMock.putAll.mockClear();
        const again = await lootLogHistory.getHistoricalEntries(new Set());

        expect(storageMock.putAll).not.toHaveBeenCalled();
        expect(again.map((e) => e.characterActionId)).toEqual([1]);
    });

    test('a split that cannot be written leaves the legacy key readable', async () => {
        const legacy = [entry(2, '2026-08-01T11:00:00Z'), entry(1, '2026-08-01T10:00:00Z')];
        storageMock.store.set('lootLog_char-1', legacy);
        // What a full disk looks like: the bulk write lands nothing
        storageMock.putAll.mockImplementation(async () => 0);
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        const loaded = await lootLogHistory.getHistoricalEntries(new Set());

        expect(loaded).toEqual(legacy);
        expect(storageMock.store.get('lootLog_char-1')).toEqual(legacy);
        expect(lootLogHistory._store.isLegacy()).toBe(true);
    });

    test('a recorder left on the legacy key keeps writing to it rather than losing the entry', async () => {
        storageMock.store.set('lootLog_char-1', [entry(1, '2026-08-01T10:00:00Z')]);
        storageMock.putAll.mockImplementation(async () => 0);

        await lootLogHistory.mergeAndSave([entry(2, '2026-08-01T11:00:00Z')]);

        expect(recordWrites()).toHaveLength(0);
        expect(storageMock.store.get('lootLog_char-1').map((e) => e.characterActionId)).toEqual([2, 1]);
    });
});

describe('pruning past the cap', () => {
    test('an hour that loses its last entry loses its record', async () => {
        // One entry per hour, one more than the log keeps
        const hours = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => {
            const at = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
            return entry(i + 1, at);
        });

        await lootLogHistory.mergeAndSave(hours);

        // The oldest hour is the one pushed out of the window
        expect(storageMock.delete).not.toHaveBeenCalled();
        expect(storageMock.store.has('lootLogRec_char-1_2026-01-01T00')).toBe(false);
        expect(storageMock.store.has('lootLogRec_char-1_2026-01-01T01')).toBe(true);

        // And once it has been stored, a later merge deletes its key
        await lootLogHistory.mergeAndSave([entry(9999, '2027-01-01T00:00:00Z')]);
        expect(storageMock.delete).toHaveBeenCalledWith('lootLogRec_char-1_2026-01-01T01', 'lootLogHistory');
    });

    test('a history of exactly the cap loses nothing', async () => {
        const hours = Array.from({ length: MAX_ENTRIES }, (_, i) => {
            const at = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
            return entry(i + 1, at);
        });

        await lootLogHistory.mergeAndSave(hours);

        expect(storageMock.store.has('lootLogRec_char-1_2026-01-01T00')).toBe(true);
        expect(await lootLogHistory._load()).toHaveLength(MAX_ENTRIES);
    });
});

describe('the merge sort', () => {
    // The comparator used to build two Dates per comparison; it now parses each entry's
    // start time once, up front. Equivalent everywhere the old one was well defined, and
    // a total order where the old one was not: `new Date('nonsense') - x` is NaN, and a
    // comparator returning NaN is not a valid ordering.
    test('keeps the newest first, and every entry, when start times are equal', async () => {
        const same = '2026-08-01T10:00:00Z';
        await lootLogHistory.mergeAndSave([entry(1, same), entry(2, same), entry(3, same)]);

        const stored = storageMock.store.get('lootLogRec_char-1_2026-08-01T10');
        expect(stored.map((e) => e.characterActionId).sort()).toEqual([1, 2, 3]);
    });

    test('a malformed start time is sorted last rather than scrambling the window', async () => {
        await lootLogHistory.mergeAndSave([
            entry(1, '2026-08-01T10:00:00Z'),
            entry(2, 'not a date'),
            entry(3, '2026-08-01T12:00:00Z'),
        ]);

        // The two real entries keep their own hours and their newest-first order; the
        // unparseable one sorts to epoch rather than turning the comparison into NaN
        expect(storageMock.store.get('lootLogRec_char-1_2026-08-01T12').map((e) => e.characterActionId)).toEqual([3]);
        expect(storageMock.store.get('lootLogRec_char-1_2026-08-01T10').map((e) => e.characterActionId)).toEqual([1]);
        const all = await lootLogHistory._load();
        expect(all.map((e) => e.characterActionId)).toContain(2);
        expect(all).toHaveLength(3);
    });
});

describe('standing down when storage is full', () => {
    test('nothing is merged or written once the quota has been hit', async () => {
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(storageMock.get).not.toHaveBeenCalled();
    });
});

describe('two loot messages in quick succession', () => {
    test('neither delta is lost to the other', async () => {
        // Both used to read the same `existing` array before either had saved,
        // merge their own entry onto it, and the second save win — so the first
        // message's entry was gone
        const first = lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]);
        const second = lootLogHistory.mergeAndSave([entry(2, '2026-08-01T13:40:00Z')]);
        await Promise.all([first, second]);

        const stored = storageMock.store.get('lootLogRec_char-1_2026-08-01T13');
        expect(stored.map((e) => e.characterActionId).sort()).toEqual([1, 2]);
    });

    test('the merges run in the order they arrived', async () => {
        const order = [];
        const originalLoad = lootLogHistory._load.bind(lootLogHistory);
        vi.spyOn(lootLogHistory, '_load').mockImplementation(async () => {
            order.push('load');
            return originalLoad();
        });

        await Promise.all([
            lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]),
            lootLogHistory.mergeAndSave([entry(2, '2026-08-01T13:40:00Z')]),
        ]);

        // Two reads, one after the other, not two interleaved
        expect(order).toEqual(['load', 'load']);
        lootLogHistory._load.mockRestore();
    });

    test('a merge that throws does not wedge the chain', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(lootLogHistory, '_load').mockRejectedValueOnce(new Error('read failed'));

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]);
        lootLogHistory._load.mockRestore();
        await lootLogHistory.mergeAndSave([entry(2, '2026-08-01T13:40:00Z')]);

        expect(errorSpy).toHaveBeenCalled();
        expect(storageMock.store.get('lootLogRec_char-1_2026-08-01T13')).toHaveLength(1);
        errorSpy.mockRestore();
    });
});

describe('a character switch landing mid-merge', () => {
    test('a merge started for the departing character never writes under the arriving one', async () => {
        // _load is an IndexedDB round trip — flip the current character while
        // it is "in flight", the way a real switch could land between the read
        // and the save that follows it.
        const originalLoad = lootLogHistory._load.bind(lootLogHistory);
        vi.spyOn(lootLogHistory, '_load').mockImplementation(async (charId) => {
            const result = await originalLoad(charId);
            character.id = 'char-2';
            return result;
        });

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]);
        lootLogHistory._load.mockRestore();

        // Nothing landed under char-2's keys — the merge belonged to char-1
        expect(storageMock.set).not.toHaveBeenCalledWith(
            expect.stringContaining('lootLogRec_char-2_'),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
        // And char-1, who the merge was actually for, does not have it either —
        // the whole point is that the save is abandoned, not silently redirected
        expect(storageMock.store.has('lootLogRec_char-1_2026-08-01T13')).toBe(false);
    });

    test('a merge that completes without a switch is unaffected', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T13:20:00Z')]);

        expect(storageMock.store.get('lootLogRec_char-1_2026-08-01T13')).toHaveLength(1);
    });
});

describe('a delete racing a merge', () => {
    test('a delete queued while a merge is mid-flight is not undone by the merge finishing after it', async () => {
        // Two entries already on record.
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T10:00:00Z'), entry(2, '2026-08-01T11:00:00Z')]);

        // A merge begins for a third, unrelated entry: it reads `existing`
        // (entries 1 and 2) first...
        const originalLoad = lootLogHistory._load.bind(lootLogHistory);
        let deletion;
        vi.spyOn(lootLogHistory, '_load').mockImplementationOnce(async (charId) => {
            const existing = await originalLoad(charId);

            // ...and before the merge saves, the user deletes entry 1. If this
            // went straight to `_load`/`_save` (as it used to) it would race the
            // merge exactly like this; going through `deleteEntry` instead
            // queues it on the same chain, so it actually runs after the merge
            // finishes rather than interleaved with it.
            deletion = lootLogHistory.deleteEntry(1);

            return existing;
        });

        await lootLogHistory.mergeAndSave([entry(3, '2026-08-01T12:00:00Z')]);
        await deletion;
        lootLogHistory._load.mockRestore();

        const stored = await lootLogHistory.getHistoricalEntries(new Set());
        expect(stored.map((e) => e.characterActionId).sort()).toEqual([2, 3]);
    });

    test('deleteEntry does nothing before a character is known', async () => {
        character.id = null;

        await lootLogHistory.deleteEntry(1);

        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('deleteEntry does nothing when the id is not stored', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T10:00:00Z')]);
        storageMock.set.mockClear();

        await lootLogHistory.deleteEntry(999);

        expect(storageMock.set).not.toHaveBeenCalled();
    });
});
