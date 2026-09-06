/**
 * Where the alchemy trackers put their sessions.
 *
 * The three trackers used to write every session ever kept, immediately, on
 * every completed action — an unbounded array rewritten every couple of seconds
 * for as long as the account existed. What is worth asserting is that a saved
 * session now costs the one day's record it belongs to, that the sessions
 * recorded before login are still found, and that the split of the old array is
 * the same list read back.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

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

const { createAlchemySessionStore, NO_CHARACTER } = await import('./alchemy-session-store.js');

/** A session as the trackers build them */
const session = (startTime, id) => ({ id: id ?? `transmute_${startTime}`, startTime, totalAttempts: 1, results: {} });

const AUG_4 = Date.UTC(2026, 7, 4, 9);
const AUG_5 = Date.UTC(2026, 7, 5, 9);

let store;

beforeEach(() => {
    storageMock.store.clear();
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    // Implementations, not just calls: a test that makes a write fail must not
    // leave the next one failing too
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    storageMock.putAll.mockImplementation(async (storeName, entries) => {
        for (const [key, value] of Object.entries(entries)) storageMock.store.set(key, value);
        return Object.keys(entries).length;
    });
    store = createAlchemySessionStore('transmuteSessions', 'TransmuteHistoryTracker');
});

describe('key shape', () => {
    test('a session lands in the record for the day it started', async () => {
        await store.save('char-1', [session(AUG_4)]);

        expect([...storageMock.store.keys()]).toEqual(['transmuteSessionsRec_char-1_2026-08-04']);
    });

    test('a run that spilled into the next day is still filed by, and read back from, its start day', async () => {
        // `lastActivityTime` is the far end of the span the gold attribution
        // spreads a session over, so it has to survive the store — and it must
        // not move the record, which is keyed by the day the run began
        const spanning = { ...session(AUG_4), lastActivityTime: AUG_5 };
        await store.save('char-1', [spanning]);

        expect([...storageMock.store.keys()]).toEqual(['transmuteSessionsRec_char-1_2026-08-04']);
        expect(await store.load('char-1')).toEqual([spanning]);
    });

    test('the record prefix cannot be confused with the legacy key of any character', () => {
        // `transmuteSessionsRec_...` vs `transmuteSessions_<id>` — the character
        // after the base is `R`, never `_`, so no scan for the legacy shape
        // matches a record
        expect('transmuteSessionsRec_char-1_2026-08-04'.startsWith('transmuteSessions_')).toBe(false);
    });
});

describe('a completed action writes one day, not every session', () => {
    test('updating the active session leaves the earlier days untouched', async () => {
        const running = session(AUG_5);
        await store.save('char-1', [session(AUG_4), running]);
        storageMock.set.mockClear();

        running.totalAttempts = 2;
        await store.save('char-1', [session(AUG_4), running]);

        expect(storageMock.set.mock.calls.map(([key]) => key)).toEqual(['transmuteSessionsRec_char-1_2026-08-05']);
    });

    test('the write is immediate, because a session can be cut off by a closed tab', async () => {
        await store.save('char-1', [session(AUG_4)]);

        const [, , storeName, immediate] = storageMock.set.mock.calls[0];
        expect(storeName).toBe('alchemyHistory');
        expect(immediate).toBe(true);
    });

    test('deleting one row from the viewer removes the record its day is left empty', async () => {
        await store.save('char-1', [session(AUG_4), session(AUG_5)]);
        storageMock.delete.mockClear();

        await store.save('char-1', [session(AUG_5)]);

        expect(storageMock.delete).toHaveBeenCalledWith('transmuteSessionsRec_char-1_2026-08-04', 'alchemyHistory');
    });
});

describe('the split of the old array', () => {
    test('reads back as the same list, oldest first', async () => {
        const legacy = [session(AUG_4), session(AUG_5)];
        storageMock.store.set('transmuteSessions_char-1', legacy);

        const loaded = await store.load('char-1');

        expect(loaded).toEqual(legacy);
        expect(storageMock.store.has('transmuteSessions_char-1')).toBe(false);
        expect([...storageMock.store.keys()].sort()).toEqual([
            'transmuteSessionsRec_char-1_2026-08-04',
            'transmuteSessionsRec_char-1_2026-08-05',
        ]);
    });

    test('the bare pre-login key is claimed too, rather than orphaned', async () => {
        // What the trackers wrote before a character id was known
        storageMock.store.set('transmuteSessions', [session(AUG_4)]);

        const loaded = await store.load(NO_CHARACTER);

        expect(loaded).toHaveLength(1);
        expect(storageMock.store.has('transmuteSessions')).toBe(false);
        expect(storageMock.store.has('transmuteSessionsRec_default_2026-08-04')).toBe(true);
    });

    test('a split that will not fit leaves the array whole and readable', async () => {
        const legacy = [session(AUG_4), session(AUG_5)];
        storageMock.store.set('transmuteSessions_char-1', legacy);
        storageMock.putAll.mockImplementation(async () => 0);
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        expect(await store.load('char-1')).toEqual(legacy);
        expect(storageMock.store.get('transmuteSessions_char-1')).toEqual(legacy);
        expect(store.isLegacy()).toBe(true);
    });
});

describe('clearing the history', () => {
    test('takes every day record and the legacy key with it', async () => {
        storageMock.store.set('transmuteSessions_char-1', [session(AUG_4)]);
        await store.load('char-1');
        await store.save('char-1', [session(AUG_4), session(AUG_5)]);

        await store.clear('char-1');

        expect([...storageMock.store.keys()]).toEqual([]);
        expect(await store.load('char-1')).toEqual([]);
    });
});
