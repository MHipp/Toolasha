/**
 * The write watchdog.
 *
 * Every write in `storage.js` settles from an event on its own request or its
 * transaction, exactly as every read does, and so has the same hole: a
 * transaction whose events never arrive leaves the promise pending for the life
 * of the page, nothing throws, nothing is logged. A write is the worse half of
 * that. `flushAll()` awaits `_inFlightWrites` before it snapshots the queue and
 * the character-switch drain awaits `flushAll()`, so one write that never
 * settles stalls both — and an outstanding readwrite transaction holds its
 * object store against every connection on the origin, which is how one wedged
 * `settings` write stopped the script in every tab on 3.47.0.
 *
 * What these tests do and do not cover. They drive the real `Storage` class
 * against hand-rolled fake IDB objects, in the same style as
 * `storage-read-watchdog.test.js`, so they prove the *module's* behaviour: that
 * a write which never gets an event still settles, says which key and store it
 * was, reports as failed rather than as written, and leaves its value queued
 * rather than dropping it. They prove nothing about IndexedDB itself — no fake
 * reproduces a browser holding a store across connections, and nothing here
 * shows what wedged the live tab.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

/**
 * A connection whose transactions never fire an event of any kind.
 *
 * Not an abort, not an error — silence, which is the one outcome the write paths
 * had no answer for.
 * @returns {{db: object, transactions: {count: number}}} The fake and its counter
 */
function createWedgedDb() {
    const transactions = { count: 0 };
    const db = {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            transactions.count += 1;
            const store = {
                put: () => ({ onsuccess: null, onerror: null }),
                delete: () => ({ onsuccess: null, onerror: null }),
                get: () => ({ onsuccess: null, onerror: null }),
            };
            return { objectStore: () => store, onabort: null, onerror: null, oncomplete: null };
        },
        close() {},
    };
    return { db, transactions };
}

/**
 * A connection that writes into a plain map and reports back.
 * @returns {{db: object, data: Map<string, *>}} The fake and its backing store
 */
function createHealthyDb() {
    const data = new Map();
    const db = {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            const pending = [];
            const objectStore = {
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    pending.push(() => {
                        data.set(key, value);
                        request.onsuccess?.();
                    });
                    return request;
                },
                delete(key) {
                    const request = { onsuccess: null, onerror: null };
                    pending.push(() => {
                        data.delete(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
            };
            const txn = { objectStore: () => objectStore, onabort: null, onerror: null, oncomplete: null };
            queueMicrotask(() => {
                for (const run of pending) run();
                queueMicrotask(() => txn.oncomplete?.());
            });
            return txn;
        },
        close() {},
    };
    return { db, data };
}

/** Put the module singleton back to a clean state between tests. */
function resetStorage() {
    for (const timer of storage.saveDebounceTimers.values()) clearTimeout(timer);
    storage.saveDebounceTimers.clear();
    storage.pendingWrites.clear();
    storage._writeGeneration.clear();
    storage._flushFailures.clear();
    storage._inFlightWrites.clear();
    storage.db = null;
    storage._closingForTeardown = false;
    storage._dbNulledReason = null;
    storage._reconnecting = false;
    storage._lastReconnectFailureAt = 0;
    storage._writeTimeouts = 0;
    storage._lastWriteTimeout = null;
}

describe('Storage writes on a connection that has stopped answering', () => {
    beforeEach(() => {
        resetStorage();
        // The shipped value is fifteen seconds; the behaviour under test is the
        // same at any length, and a test may not take fifteen seconds to see it.
        storage.writeTimeoutMs = 30;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetStorage();
        storage.writeTimeoutMs = 15_000;
    });

    // Before the watchdog this test did not fail — it hung. The promise had no
    // event coming that would settle it, and the runner sat on the await until
    // its own timeout killed the file.
    test('an immediate set() settles instead of hanging forever, and says which key and store', async () => {
        const { db } = createWedgedDb();
        storage.db = db;

        await expect(storage.set('script_settingsMap_32326', '{"a":1}', 'settings', true)).resolves.toBe(false);

        const messages = console.error.mock.calls.map((call) => String(call[0]));
        expect(messages.some((message) => message.includes('script_settingsMap_32326'))).toBe(true);
        expect(messages.some((message) => message.includes('store settings'))).toBe(true);
        // `[Storage]`-prefixed console.error is what the in-page error log
        // captures, so the next occurrence reports itself instead of looking
        // like a page that is quietly still saving.
        expect(messages.every((message) => message.startsWith('[Storage]'))).toBe(true);
        expect(storage.diagnostics().writeTimeouts).toBe(1);
        expect(storage.diagnostics().lastWriteTimeout).toMatchObject({
            op: 'set',
            target: 'script_settingsMap_32326',
            storeName: 'settings',
        });
    });

    test('delete() settles too — a prune is a readwrite transaction like any other', async () => {
        const { db } = createWedgedDb();
        storage.db = db;

        await expect(storage.delete('chunk-2026-09', 'settings')).resolves.toBe(false);
        expect(storage.diagnostics().lastWriteTimeout).toMatchObject({ op: 'delete', target: 'chunk-2026-09' });
    });

    test('putAll() reports nothing written rather than never coming back', async () => {
        const { db } = createWedgedDb();
        storage.db = db;

        await expect(storage.putAll('settings', { a: 1, b: 2 })).resolves.toBe(0);
        expect(storage.diagnostics().lastWriteTimeout).toMatchObject({ op: 'putAll', storeName: 'settings' });
    });

    // The whole reason `flushAll` is called on the way out: it must come back.
    // Before the watchdog a wedged store left it awaiting `_inFlightWrites`
    // forever, and with it the character-switch drain, the handoff push and
    // `beginRestore`.
    test('flushAll() comes back instead of stalling on a write that never settles', async () => {
        const { db } = createWedgedDb();
        storage.db = db;

        storage.set('k', 'v');
        await expect(storage.flushAll()).resolves.toBeUndefined();
        expect(storage.diagnostics().writeTimeouts).toBeGreaterThan(0);
    });

    // Losing a character's settings write silently would be worse than the hang
    // this replaces, so a timed-out write is reported as failed — the same
    // answer an aborted transaction gives — and the requeue every caller already
    // does on that answer is what keeps the value.
    test('the value is kept, not dropped: it stays queued for the next flush', async () => {
        const { db } = createWedgedDb();
        storage.db = db;

        storage.set('script_settingsMap_32326', '{"a":1}');
        await storage.flushAll();

        expect(storage.pendingWrites.get('settings:script_settingsMap_32326')).toMatchObject({ value: '{"a":1}' });

        // And a connection that answers again writes it, with nothing lost in
        // between.
        const { db: healthy, data } = createHealthyDb();
        storage.db = healthy;
        await storage.flushAll();
        expect(data.get('script_settingsMap_32326')).toBe('{"a":1}');
        expect(storage.pendingWrites.size).toBe(0);
    });

    // A store that did not answer within the timeout is a store something is
    // holding. The per-key retry pass exists to isolate one poison value out of
    // an aborted bulk write — an abort means the store *answered* — and running
    // it against a wedged store would only queue one more transaction per key
    // behind whatever is holding it.
    test('a wedged flush does not retry the keys one at a time', async () => {
        const { db, transactions } = createWedgedDb();
        storage.db = db;

        storage.set('a', 1);
        storage.set('b', 2);
        storage.set('c', 3);
        await storage.flushAll();

        expect(transactions.count).toBe(1);
    });

    test('a healthy write is not disturbed by the watchdog', async () => {
        const { db, data } = createHealthyDb();
        storage.db = db;

        await expect(storage.set('k', 'v', 'settings', true)).resolves.toBe(true);
        expect(data.get('k')).toBe('v');
        expect(storage.diagnostics().writeTimeouts).toBe(0);
        expect(console.error).not.toHaveBeenCalled();
    });
});
