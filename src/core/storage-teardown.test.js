/**
 * Giving the IndexedDB connection back when the page goes away.
 *
 * The live failure, on 3.47.0: a tab was refreshed twice in quick succession,
 * and from then on every read of the `settings` store hung — in that tab and in
 * every other tab on the origin — while reads of every other store on the same
 * connection answered in milliseconds. Reloading the broken tab changed nothing;
 * reloading the *other* tabs fixed it instantly. That is a readwrite transaction
 * on `settings` left outstanding by a torn-down page: IndexedDB serialises
 * transactions per object store across every connection on the origin, so one
 * orphan holds that store everywhere until the connection holding it is gone.
 * The unload flush opened those transactions and nothing ever called
 * `db.close()`.
 *
 * What these tests do and do not prove. They drive the real `Storage` class
 * against hand-rolled fake IDB objects, in the style of `storage.test.js`, so
 * they prove the *mechanism this change adds*: that a flush and a close both
 * happen on teardown, in that order, that the close does not cut the flush's
 * transactions short, that nothing reopens a connection on a page that is
 * leaving, and that a page which comes back gets a working database. They prove
 * nothing about IndexedDB itself — no fake reproduces a browser holding a store
 * across connections, and nothing in vitest reproduces a double refresh. The
 * live evidence above is what establishes the cause; this establishes the
 * mechanism.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

/**
 * A connection that records what was done to it, in order.
 *
 * Transactions complete on a microtask rather than instantly, which is the
 * whole point: it leaves a window in which the connection is closed while a
 * transaction it opened is still outstanding, and that is the window the fix is
 * about.
 * @param {Record<string, *>} [data] - Backing store, shared across transactions
 * @returns {{db: object, log: Array<string>, data: Map<string, *>}} The fake and its log
 */
function createRecordingDb(data = {}) {
    const store = new Map(Object.entries(data));
    const log = [];
    let closed = false;
    const db = {
        objectStoreNames: ['settings'],
        version: 20,
        onclose: null,
        onversionchange: null,
        transaction(names, mode) {
            if (closed) throw new Error('InvalidStateError: the database connection is closing');
            log.push(`transaction:${mode}`);
            const pending = [];
            const objectStore = {
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    pending.push(() => {
                        store.set(key, value);
                        request.onsuccess?.();
                    });
                    return request;
                },
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    pending.push(() => {
                        request.result = store.get(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
            };
            const txn = { objectStore: () => objectStore, onabort: null, onerror: null, oncomplete: null };
            queueMicrotask(() => {
                // A close() that aborted its outstanding transactions would make
                // the flush pointless; IndexedDB's does not, and neither does
                // this. The transaction runs to completion either way.
                for (const run of pending) run();
                queueMicrotask(() => txn.oncomplete?.());
            });
            return txn;
        },
        close() {
            closed = true;
            log.push('close');
        },
    };
    return { db, log, data: store };
}

/**
 * Stand in for `indexedDB`, handing out the given connections in order.
 * @param {Array<object|null>} connections - One per `open()`; null opens fail
 * @returns {{opens: {count: number}}} How many times an open was requested
 */
function installFakeIndexedDB(connections) {
    const opens = { count: 0 };
    globalThis.indexedDB = {
        open() {
            const index = opens.count;
            opens.count += 1;
            const request = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: null };
            queueMicrotask(() => {
                const connection = connections[Math.min(index, connections.length - 1)];
                if (connection) {
                    request.result = connection;
                    request.onsuccess?.();
                } else {
                    request.error = new Error('open failed');
                    request.onerror?.();
                }
            });
            return request;
        },
    };
    return { opens };
}

const originalIndexedDB = globalThis.indexedDB;

/** Put the module singleton back to a clean, connectionless state. */
function resetStorage() {
    for (const timer of storage.saveDebounceTimers.values()) clearTimeout(timer);
    storage.saveDebounceTimers.clear();
    storage.pendingWrites.clear();
    storage._writeGeneration.clear();
    storage._flushFailures.clear();
    storage._inFlightWrites.clear();
    storage.db = null;
    storage.available = false;
    storage._closingForTeardown = false;
    storage._dbNulledReason = null;
    storage._reconnecting = false;
    storage._lastReconnectFailureAt = 0;
    storage._writeTimeouts = 0;
    storage._lastWriteTimeout = null;
}

describe('Storage on page teardown', () => {
    beforeEach(() => {
        resetStorage();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetStorage();
        globalThis.indexedDB = originalIndexedDB;
    });

    // The acceptance case. Against 3.47.0 this fails on the `close` assertion:
    // the flush ran, the transaction was opened, and the connection was left
    // holding it — which is exactly what the torn-down tab did to the `settings`
    // store for every other tab on the origin.
    test('a flush in progress when the page goes away does not leave the connection open', async () => {
        const { db, log, data } = createRecordingDb();
        storage.db = db;
        storage.available = true;

        // Queued, not yet written — the state a page is in for up to three
        // seconds after any settings change.
        storage.set('script_settingsMap_32326', '{"a":1}');
        expect(storage.pendingWrites.size).toBe(1);

        await storage.closeForTeardown('pagehide');

        // Both happened, and in the order that matters: the flush's transaction
        // is opened first and the connection is closed with it outstanding.
        // `close()` does not abort it — it marks the connection close-pending so
        // the browser finalises and releases it the moment the transaction
        // finishes, which is the release the dying page never asked for.
        expect(log).toEqual(['transaction:readwrite', 'close']);
        expect(data.get('script_settingsMap_32326')).toBe('{"a":1}');
        expect(storage.db).toBeNull();
        expect(storage.diagnostics().closingForTeardown).toBe(true);
    });

    // The flush is not weakened by the close: landing the pending writes is the
    // whole point of listening for these events.
    test('the queued value is still written, and its caller is told it landed', async () => {
        const { db, data } = createRecordingDb();
        storage.db = db;
        storage.available = true;

        const write = storage.set('k', 'v');
        await storage.closeForTeardown('pagehide');

        await expect(write).resolves.toBe(true);
        expect(data.get('k')).toBe('v');
        expect(storage.pendingWrites.size).toBe(0);
    });

    // `db.onclose` calls `_reconnect()`. A page on its way out that opened a
    // fresh connection in response to its own close would be handed a new
    // connection to leave a transaction on — the exact thing being prevented.
    test('the connection handlers are cleared before it is closed, so nothing reconnects', async () => {
        const { db } = createRecordingDb();
        storage.db = db;
        storage._setupDbEventHandlers();
        expect(typeof db.onclose).toBe('function');
        const { opens } = installFakeIndexedDB([createRecordingDb().db]);

        await storage.closeForTeardown('pagehide');

        expect(db.onclose).toBeNull();
        expect(db.onversionchange).toBeNull();
        expect(opens.count).toBe(0);
    });

    // A `beforeunload`/`pagehide` listener registered after the entrypoint's
    // still runs and still writes — the character-activity projection is one.
    // Such a write must not reach for a connection on a page that is leaving,
    // and must not be thrown away either.
    test('a write after the close queues instead of opening a new connection', async () => {
        const { db } = createRecordingDb();
        storage.db = db;
        storage.available = true;
        await storage.closeForTeardown('pagehide');
        const { opens } = installFakeIndexedDB([createRecordingDb().db]);

        storage.set('late', 'value', 'settings', true);
        await Promise.resolve();

        expect(opens.count).toBe(0);
        expect(storage.db).toBeNull();
        expect(storage.pendingWrites.get('settings:late')).toMatchObject({ value: 'value' });
    });

    test('closing twice closes once', async () => {
        const { db, log } = createRecordingDb();
        storage.db = db;
        await storage.closeForTeardown('pagehide');
        await storage.closeForTeardown('pagehide');

        expect(log.filter((entry) => entry === 'close')).toHaveLength(1);
    });
});

describe('Storage on a bfcache restore', () => {
    beforeEach(() => {
        resetStorage();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetStorage();
        globalThis.indexedDB = originalIndexedDB;
    });

    // `pagehide` fires for two different endings, and only one of them is the
    // end. A page frozen into the bfcache can be restored and resumed, with
    // every module above storage still holding its state and still reading and
    // writing as if nothing happened — so it needs a working database back.
    test('a restored page gets a working connection again', async () => {
        const { db: first } = createRecordingDb();
        storage.db = first;
        storage.available = true;
        await storage.closeForTeardown('pagehide');
        expect(storage.db).toBeNull();

        const { db: second, data } = createRecordingDb();
        const { opens } = installFakeIndexedDB([second]);

        await expect(storage.reopenAfterRestore()).resolves.toBe(true);

        expect(opens.count).toBe(1);
        expect(storage.db).toBe(second);
        expect(storage.available).toBe(true);
        expect(storage.diagnostics().closingForTeardown).toBe(false);

        // And the page can write again, which is the only thing a restored page
        // actually cares about.
        await expect(storage.set('after-restore', 'v', 'settings', true)).resolves.toBe(true);
        expect(data.get('after-restore')).toBe('v');
    });

    // A value the teardown flush could not land is still queued, so the restored
    // page writes it rather than having lost it.
    test('a write refused during teardown is still queued after the restore', async () => {
        const { db: first } = createRecordingDb();
        storage.db = first;
        storage.available = true;
        await storage.closeForTeardown('pagehide');

        // Refused while the page is closing — reported as failed, kept queued.
        storage.set('queued-through-freeze', 'v');
        expect(storage.pendingWrites.size).toBe(1);

        const { db: second, data } = createRecordingDb();
        installFakeIndexedDB([second]);
        await storage.reopenAfterRestore();
        await storage.flushAll();

        expect(data.get('queued-through-freeze')).toBe('v');
    });

    // On a page that never said goodbye this is not a reopen, it is a no-op —
    // which is what lets the entrypoint call it on every `pageshow` without
    // reading `event.persisted`.
    test('reopening a page that never closed is a no-op', async () => {
        const { db } = createRecordingDb();
        storage.db = db;
        const { opens } = installFakeIndexedDB([createRecordingDb().db]);

        await expect(storage.reopenAfterRestore()).resolves.toBe(true);

        expect(opens.count).toBe(0);
        expect(storage.db).toBe(db);
    });
});
