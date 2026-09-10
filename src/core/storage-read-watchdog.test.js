/**
 * The read watchdog.
 *
 * Every read in `storage.js` settles from an event on its own request or its
 * transaction. That covers every way IndexedDB *reports* a failure and none of
 * the ways it reports nothing at all: a connection that stops delivering events
 * leaves the promise pending for the life of the page, nothing throws, nothing
 * is logged, and a startup that sits behind the settings read never happens.
 * That is the 3.47.0 report — startup stopped between `settings:storageReady`
 * and `features:start` with an empty error log.
 *
 * What these tests do and do not cover. They drive the real `Storage` class
 * against hand-rolled fake IDB objects, in the same style as `storage.test.js`,
 * so they prove the *module's* behaviour: that a read which never gets an event
 * still settles, says so with the key and the store in the message, reopens the
 * connection, and prefers a retry on the new connection over answering with a
 * default. They prove nothing about IndexedDB itself — no fake reproduces a
 * browser wedging a live connection, and no test here shows what wedged the
 * connection in the live tab.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

/**
 * A connection whose transactions never fire an event of any kind.
 *
 * Not an abort, not an error — silence, which is the one outcome the module had
 * no answer for. `close()` is recorded so the recovery can be asserted.
 * @returns {{db: object, closed: {count: number}, transactions: {count: number}}} The fake and its counters
 */
function createWedgedDb() {
    const closed = { count: 0 };
    const transactions = { count: 0 };
    const db = {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            transactions.count += 1;
            const store = {
                get: () => ({ onsuccess: null, onerror: null }),
                getAllKeys: () => ({ onsuccess: null, onerror: null }),
                openCursor: () => ({ onsuccess: null, onerror: null }),
            };
            return { objectStore: () => store, onabort: null, onerror: null, oncomplete: null };
        },
        close() {
            closed.count += 1;
        },
    };
    return { db, closed, transactions };
}

/**
 * A connection that answers reads from a plain map.
 * @param {Record<string, *>} data - Seed data for the `settings` store
 * @returns {object} A fake IDBDatabase
 */
function createHealthyDb(data = {}) {
    const store = new Map(Object.entries(data));
    return {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            const pending = [];
            const objectStore = {
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    pending.push(() => {
                        request.result = store.get(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
                getAllKeys() {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    pending.push(() => {
                        request.result = Array.from(store.keys());
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

describe('Storage reads on a connection that has stopped answering', () => {
    beforeEach(() => {
        storage.db = null;
        storage._dbNulledReason = null;
        storage._lastReconnectFailureAt = 0;
        storage._reconnecting = false;
        storage._readTimeouts = 0;
        storage._lastReadTimeout = null;
        // The shipped value is ten seconds; the behaviour under test is the
        // same at any length, and a test may not take ten seconds to see it.
        storage.readTimeoutMs = 30;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        storage.db = null;
        storage.readTimeoutMs = 10_000;
        storage._dbNulledReason = null;
        globalThis.indexedDB = originalIndexedDB;
    });

    // Before the watchdog this test did not fail — it hung. `get()` returned a
    // promise that no event would ever settle, and the runner sat on the await
    // until its own timeout killed the file.
    test('get() settles instead of hanging forever, and says which key and store', async () => {
        const { db } = createWedgedDb();
        storage.db = db;
        installFakeIndexedDB([createWedgedDb().db]);

        const value = await storage.get('script_settingsMap_32326', 'settings', 'fallback');

        expect(value).toBe('fallback');
        const messages = console.error.mock.calls.map((call) => String(call[0]));
        expect(messages.some((message) => message.includes('script_settingsMap_32326'))).toBe(true);
        expect(messages.some((message) => message.includes('store settings'))).toBe(true);
        // `[Storage]`-prefixed console.error is what the in-page error log
        // captures, so the next occurrence reports itself instead of looking
        // like a page that is still loading.
        expect(messages.every((message) => message.startsWith('[Storage]'))).toBe(true);
        expect(storage.diagnostics().readTimeouts).toBeGreaterThan(0);
        expect(storage.diagnostics().lastReadTimeout).toMatchObject({
            op: 'get',
            target: 'script_settingsMap_32326',
            storeName: 'settings',
        });
    });

    test('tryGet() reports the read as untrustworthy rather than as absent', async () => {
        const { db } = createWedgedDb();
        storage.db = db;
        installFakeIndexedDB([createWedgedDb().db]);

        // null, not {found: false} — a settings load that took "absent" for an
        // answer here would write schema defaults over the character's map.
        await expect(storage.tryGet('script_settingsMap_32326', 'settings')).resolves.toBeNull();
    });

    test('tryGetAllKeys() answers null rather than an empty listing', async () => {
        const { db } = createWedgedDb();
        storage.db = db;
        installFakeIndexedDB([createWedgedDb().db]);

        await expect(storage.tryGetAllKeys('settings')).resolves.toBeNull();
    });

    test('the wedged connection is closed and reopened, and the retry answers from disk', async () => {
        const { db, closed } = createWedgedDb();
        storage.db = db;
        const { opens } = installFakeIndexedDB([createHealthyDb({ script_settingsMap_32326: '{"a":1}' })]);

        const value = await storage.get('script_settingsMap_32326', 'settings', 'fallback');

        // The point of the retry: the settings are on disk and readable, and
        // answering with the default instead would have startup save defaults
        // over them.
        expect(value).toBe('{"a":1}');
        expect(closed.count).toBe(1);
        expect(opens.count).toBeGreaterThan(0);
        expect(storage.db).not.toBe(db);
    });

    test('a healthy read is not disturbed by the watchdog', async () => {
        storage.db = createHealthyDb({ k: 'v' });

        await expect(storage.get('k', 'settings', 'fallback')).resolves.toBe('v');
        expect(storage.diagnostics().readTimeouts).toBe(0);
        expect(console.error).not.toHaveBeenCalled();
    });
});

describe('Storage opening a connection while another open is in flight', () => {
    beforeEach(() => {
        storage.db = null;
        storage._dbNulledReason = null;
        storage._reconnecting = false;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        storage.db = null;
        globalThis.indexedDB = originalIndexedDB;
    });

    // Two `open`s in flight at once is what the `onblocked` retry does by
    // construction, and what a second `initialize()` would do. Both used to
    // assign `this.db` directly, so the loser stayed open forever — holding the
    // database against the next version upgrade, which matters because this
    // database is shared with the upstream script and the upstream script
    // upgrades it.
    test('the superseded connection is closed rather than left open', async () => {
        const first = createHealthyDb();
        let firstClosed = 0;
        first.close = () => {
            firstClosed += 1;
        };
        const second = createHealthyDb({ k: 'v' });
        installFakeIndexedDB([first, second]);

        await Promise.all([storage.initialize(), storage.initialize()]);

        expect(storage.db).toBe(second);
        expect(firstClosed).toBe(1);
        // And the connection that survived is the one reads go to.
        await expect(storage.get('k', 'settings', 'fallback')).resolves.toBe('v');
    });
});
