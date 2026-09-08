/**
 * The ordering counter, and the fleet it has to keep working.
 *
 * These are compatibility tests before they are feature tests. A gist is a file
 * two builds share for as long as the player leaves one device un-updated, so
 * every scenario here is a combination that must survive: a gist with no
 * counter, a build that has never heard of one, and the two mixed indefinitely.
 *
 * Devices are modelled explicitly rather than by re-importing the manager,
 * because what distinguishes two devices is exactly the three things swapped in
 * `as()`: their own bookkeeping, their own data, and their own clock.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    values: { sync_enabled: true, sync_token: 'ghp_secret', sync_scope: 'settings', sync_auto: false },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => settings.values[key] ?? fallback,
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char-A' },
}));

/** The device currently at the keyboard: its bookkeeping, its data, its gist. */
const world = vi.hoisted(() => ({
    bookkeeping: {},
    content: '{"seed":1}',
    gist: null,
    /** Every store the fake database has, for the real `importEverything` */
    stores: { settings: new Map() },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        flushAll: async () => {},
        beginRestore: async () => {},
        endRestore: async () => {},
        finishRestore: () => {},
        listStores: async () => Object.keys(world.stores),
        get: async (key, _store, fallback = null) => world.bookkeeping[key] ?? fallback,
        set: async (key, value) => {
            world.bookkeeping[key] = value;
        },
        putAll: async (store, entries) => {
            if (store === 'settings') {
                for (const [key, value] of Object.entries(entries)) world.bookkeeping[key] = value;
            }
            const target = world.stores[store];
            if (target) for (const [key, value] of Object.entries(entries)) target.set(key, value);
            return Object.keys(entries).length;
        },
    },
}));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

const dialog = vi.hoisted(() => ({ answer: null, calls: 0, last: null }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async (question) => {
        dialog.calls += 1;
        dialog.last = question;
        return dialog.answer;
    },
}));

const applies = vi.hoisted(() => ({ complete: true, texts: [] }));
vi.mock('./sync-payload.js', () => ({
    buildPayloadJSON: async () => world.content,
    applyPayload: async (json) => {
        applies.texts.push(json);
        // A pull that lands makes this device's data the payload's data, which
        // is what stops the very next rebuild reading as "changed here"
        if (applies.complete !== false) world.content = json;
        return {
            restored: {},
            failed: applies.complete === false ? [{ store: 'settings' }] : [],
            complete: applies.complete !== false,
            merged: [],
            mergeFailed: [],
            mergeHeld: [],
            exportedAt: null,
            applied: json,
        };
    },
    contentHash: (text) => `h:${String(text).replace(/"exportedAt":"[^"]*",/, '')}`,
    hashPayload: (text) => `raw:${text}`,
}));

// Sync in the clear, so the gist's payload here is the payload text itself and
// a test can say what an older build would read out of it
vi.mock('./sync-compress.js', () => ({
    compressionAvailable: () => false,
    gzipText: async () => {
        throw new Error('unreachable');
    },
    gunzipToText: async () => {
        throw new Error('unreachable');
    },
}));

class FakeGistError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

vi.mock('./gist-client.js', () => ({
    GistError: FakeGistError,
    chunkPayload: (text) => [text],
    findSyncGist: async () => (world.gist ? 'gist-1' : null),
    readSyncGist: async () => {
        if (!world.gist) throw new FakeGistError('not-found', 'no gist');
        return { manifest: world.gist.manifest, payload: world.gist.payload, updatedAt: 'now' };
    },
    writeSyncGist: async (_token, id, manifest, chunks) => {
        world.gist = { manifest, payload: chunks.join('') };
        return { id: id ?? 'gist-1', updatedAt: 'now' };
    },
}));

const { default: syncManager, isNewer } = await import('./sync-manager.js');
const { importEverything } = await import('../../utils/full-backup.js');

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

/**
 * One device: what it remembers, what data it holds, and how wrong its clock is.
 * @param {string} name - Used as its data, so a pull is visible as a content change
 * @param {number} [skewMs] - Clock offset from real time
 * @returns {{name: string, bookkeeping: Object, content: string, skewMs: number}} Device
 */
function makeDevice(name, skewMs = 0) {
    return { name, bookkeeping: {}, content: `{"from":"${name}"}`, skewMs };
}

/** Wall-clock milliseconds the fleet shares, advanced by `tick()`. */
let elapsedMs = 0;

/** Move real time forward, so two pushes never share a stamp. */
function tick(ms = 60 * 1000) {
    elapsedMs += ms;
}

/**
 * Run one sync as `device`: its storage, its data, its clock.
 * @param {Object} device - From `makeDevice`
 * @param {Function} run - What to do while it is the active device
 * @returns {Promise<*>} Whatever `run` returned
 */
async function as(device, run) {
    world.bookkeeping = device.bookkeeping;
    world.content = device.content;
    vi.setSystemTime(new Date(BASE_MS + elapsedMs + device.skewMs));
    try {
        return await run();
    } finally {
        device.content = world.content;
        syncManager.busy = false;
    }
}

/** The counter the gist currently carries, or undefined when it carries none. */
function gistSeq() {
    return world.gist?.manifest?.syncSeq;
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.values = { sync_enabled: true, sync_token: 'ghp_secret', sync_scope: 'settings', sync_auto: false };
    world.bookkeeping = {};
    world.content = '{"seed":1}';
    world.gist = null;
    world.stores = { settings: new Map() };
    applies.complete = true;
    applies.texts.length = 0;
    toasts.length = 0;
    dialog.answer = null;
    dialog.calls = 0;
    elapsedMs = 0;
    syncManager.busy = false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the counter itself', () => {
    test('a device that has never synced pushes counter 1', async () => {
        const device = makeDevice('first');
        await as(device, () => syncManager.push());

        expect(gistSeq()).toBe(1);
        expect(device.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(1);
    });

    test('the counter persists under the device-local prefix, beside the stamp', async () => {
        const device = makeDevice('local');
        await as(device, () => syncManager.push());

        // Same store and same `toolasha_sync_` prefix as `lastSyncedAt`, which
        // is what keeps it out of every payload and scopes it per device
        const keys = Object.keys(device.bookkeeping).filter((key) => key.includes('Seq'));
        expect(keys).toEqual(['toolasha_sync_lastSyncedSeq']);
        expect(keys[0].startsWith('toolasha_sync_')).toBe(true);
    });

    test('each push advances the counter by one', async () => {
        const device = makeDevice('solo');
        await as(device, () => syncManager.push());
        expect(gistSeq()).toBe(1);

        device.content = '{"from":"solo","more":1}';
        tick();
        await as(device, () => syncManager.push());
        expect(gistSeq()).toBe(2);
    });

    test('pulling the payload this device just pushed is still not newer', async () => {
        const device = makeDevice('solo');
        await as(device, () => syncManager.push());
        tick();
        const result = await as(device, () => syncManager.pull());

        expect(result).toMatchObject({ skipped: true, reason: 'not-newer' });
    });
});

describe('1. old gist, new build', () => {
    test('a gist with no counter applies on the timestamp path', async () => {
        // Written exactly as the current build writes it: no `syncSeq`
        world.gist = {
            manifest: {
                toolashaSync: 1,
                scope: 'settings',
                exportedAt: new Date(BASE_MS).toISOString(),
                chunks: 1,
                bytes: '{"from":"old"}'.length,
                hash: 'h:{"from":"old"}',
            },
            payload: '{"from":"old"}',
        };

        const device = makeDevice('new');
        tick();
        const result = await as(device, () => syncManager.pull());

        expect(result.ok).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(applies.texts).toEqual(['{"from":"old"}']);
    });

    test('accepting an uncounted gist leaves the counter unstarted, and the next push is 1', async () => {
        world.gist = {
            manifest: {
                toolashaSync: 1,
                scope: 'settings',
                exportedAt: new Date(BASE_MS).toISOString(),
                chunks: 1,
            },
            payload: '{"from":"old"}',
        };

        const device = makeDevice('new');
        tick();
        await as(device, () => syncManager.pull());

        // Nothing to derive a counter from, so none is invented
        expect(device.bookkeeping.toolasha_sync_lastSyncedSeq ?? null).toBe(null);

        device.content = '{"from":"new"}';
        tick();
        await as(device, () => syncManager.push());
        expect(gistSeq()).toBe(1);
    });

    test('a counter of 1 never reads as older than the uncounted gist it followed', async () => {
        // The comparison the previous test's push produces on any other device:
        // one side has a counter, the other does not, so neither side's counter
        // decides it and the stamps do — which is what they did before
        const before = new Date(BASE_MS).toISOString();
        const after = new Date(BASE_MS + HOUR_MS).toISOString();

        expect(isNewer(after, before, 1, null)).toBe(true);
        expect(isNewer(after, before, null, 1)).toBe(true);
        expect(isNewer(before, after, 1, null)).toBe(false);
    });
});

describe('2. new gist, old build', () => {
    test('the counter is not in the payload, so an old build never reads it', async () => {
        const device = makeDevice('new');
        await as(device, () => syncManager.push());

        expect(gistSeq()).toBe(1);
        // The payload text is byte for byte what the build produced. The
        // counter rides in the manifest, which `importEverything` never sees
        expect(world.gist.payload).toBe('{"from":"new"}');
        expect(world.gist.payload).not.toContain('syncSeq');
        expect(world.gist.manifest.bytes).toBe(world.gist.payload.length);
    });

    test('importEverything ignores an unknown top-level field rather than rejecting it', async () => {
        // The old build's restore path, given a payload from this one. It
        // gates on `formatVersion` and iterates `stores`; anything else is
        // simply not looked at — `syncScope` has ridden along that way already
        const result = await importEverything({
            formatVersion: 1,
            exportedAt: new Date(BASE_MS).toISOString(),
            syncScope: 'settings',
            syncSeq: 7,
            stores: { settings: { keep: 1 } },
        });

        expect(result.complete).toBe(true);
        expect(result.restored.settings).toBe(1);
        expect(world.stores.settings.get('keep')).toBe(1);
    });
});

describe('3. mixed fleet, indefinitely', () => {
    test('an uncounted push from an old device is still accepted by counter and stamp', async () => {
        const oldDevice = makeDevice('old');
        const newDevice = makeDevice('new');

        // The new device gets ahead: two pushes, so its counter is 2
        await as(newDevice, () => syncManager.push());
        tick();
        newDevice.content = '{"from":"new","2":1}';
        await as(newDevice, () => syncManager.push());
        expect(gistSeq()).toBe(2);
        expect(newDevice.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(2);

        // Now the old device pushes, as it always has: no counter at all
        tick();
        world.gist = {
            manifest: {
                toolashaSync: 1,
                scope: 'settings',
                exportedAt: new Date(BASE_MS + elapsedMs).toISOString(),
                chunks: 1,
            },
            payload: '{"from":"old","later":1}',
        };

        const pulled = await as(newDevice, () => syncManager.pull());
        expect(pulled.skipped).toBeUndefined();
        expect(applies.texts.at(-1)).toBe('{"from":"old","later":1}');

        // Its own clock survives the uncounted payload, so the next push is 3
        expect(newDevice.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(2);
        tick();
        newDevice.content = '{"from":"new","3":1}';
        await as(newDevice, () => syncManager.push());
        expect(gistSeq()).toBe(3);

        // ...and the old device reads that push exactly as it reads any other
        expect(isNewer(world.gist.manifest.exportedAt, new Date(BASE_MS).toISOString())).toBe(true);
        void oldDevice;
    });

    test('ten rounds of alternating old and new pushes never stall either side', async () => {
        const newDevice = makeDevice('new');

        for (let round = 0; round < 10; round += 1) {
            // The old device's turn: an uncounted manifest lands in the gist
            tick();
            world.gist = {
                manifest: {
                    toolashaSync: 1,
                    scope: 'settings',
                    exportedAt: new Date(BASE_MS + elapsedMs).toISOString(),
                    chunks: 1,
                },
                payload: `{"from":"old","round":${round}}`,
            };
            const pulled = await as(newDevice, () => syncManager.pull());
            expect(pulled.reason).not.toBe('not-newer');

            // The new device's turn
            tick();
            newDevice.content = `{"from":"new","round":${round}}`;
            const pushed = await as(newDevice, () => syncManager.push());
            expect(pushed.ok).toBe(true);
            expect(gistSeq()).toBe(round + 1);
        }
    });
});

describe('4. the clock-skew stall', () => {
    test('a correct device is accepted after a fast device pushed the future', async () => {
        const fast = makeDevice('fast', HOUR_MS);
        const correct = makeDevice('correct');

        // The fast device pushes a stamp an hour ahead of everyone
        await as(fast, () => syncManager.push());
        const futureStamp = world.gist.manifest.exportedAt;
        expect(Date.parse(futureStamp)).toBe(BASE_MS + HOUR_MS);

        // The correct device pulls it and applies it, recording that stamp
        tick();
        const pulled = await as(correct, () => syncManager.pull());
        expect(pulled.skipped).toBeUndefined();
        expect(correct.bookkeeping.toolasha_sync_lastSyncedAt).toBe(futureStamp);

        // ...then pushes its own, correctly stamped and so still "in the past"
        tick();
        correct.content = '{"from":"correct","edited":1}';
        await as(correct, () => syncManager.push());
        expect(Date.parse(world.gist.manifest.exportedAt)).toBeLessThan(Date.parse(futureStamp));

        // The fast device must take it. By stamp alone it never would: the
        // payload is older than the one it pushed, and stays older for an hour
        tick();
        const back = await as(fast, () => syncManager.pull());
        expect(back.reason).not.toBe('not-newer');
        expect(applies.texts.at(-1)).toBe('{"from":"correct","edited":1}');
    });

    test('the fast device keeps taking the correct one for the whole skew window', async () => {
        const fast = makeDevice('fast', HOUR_MS);
        const correct = makeDevice('correct');

        await as(fast, () => syncManager.push());
        tick();
        await as(correct, () => syncManager.pull());

        for (let round = 0; round < 5; round += 1) {
            tick();
            correct.content = `{"from":"correct","round":${round}}`;
            await as(correct, () => syncManager.push());
            tick();
            const back = await as(fast, () => syncManager.pull());
            expect(back.reason).not.toBe('not-newer');
            expect(applies.texts.at(-1)).toBe(`{"from":"correct","round":${round}}`);
        }
    });
});

describe('5. ties', () => {
    /**
     * Two devices at the same counter, each having pushed from it without
     * seeing the other. The gist holds `second`'s push; `first` still holds its
     * own.
     * @returns {Promise<{first: Object, second: Object}>} Both devices
     */
    async function tie() {
        const first = makeDevice('first');
        const second = makeDevice('second');

        // A common base both devices have exchanged, so both counters read 1
        await as(first, () => syncManager.push());
        tick();
        await as(second, () => syncManager.pull());
        expect(first.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(1);
        expect(second.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(1);

        // Both edit and both push without seeing the other: both stamp 2
        tick();
        first.content = '{"from":"first","edit":1}';
        await as(first, () => syncManager.push());
        expect(gistSeq()).toBe(2);

        tick();
        second.content = '{"from":"second","edit":1}';
        await as(second, () => syncManager.push());
        expect(gistSeq()).toBe(2);

        return { first, second };
    }

    test('a tie is applied, never skipped', async () => {
        const { first } = await tie();

        // The counters are equal, so they decide nothing and the stamps do.
        // Reading the tie as "not newer" would drop the second device's push
        // on the floor, and the two would never converge again — applying it
        // is what runs the additive-record union in `applyPayload`
        tick();
        const result = await as(first, () => syncManager.pull());

        expect(result.reason).not.toBe('not-newer');
        expect(applies.texts.at(-1)).toBe('{"from":"second","edit":1}');
    });

    test('a tie settles rather than looping', async () => {
        const { first, second } = await tie();

        tick();
        await as(first, () => syncManager.pull());

        // Both devices now agree, and neither pulls the tie again
        expect(first.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(2);
        tick();
        expect((await as(first, () => syncManager.pull())).reason).toBe('not-newer');
        tick();
        expect((await as(second, () => syncManager.pull())).reason).toBe('not-newer');
        expect(dialog.calls).toBe(0);
    });

    test('a tie where the puller has also moved since asks, and merges both', async () => {
        const { first, second } = await tie();

        // An edit made after the push, so this device really has changed since
        // its last exchange — the both-sides-moved half of a tie
        first.content = '{"from":"first","edit":1,"later":1}';
        tick();
        dialog.answer = 'merge';
        const result = await as(first, () => syncManager.pull());

        expect(result.reason).not.toBe('not-newer');
        expect(dialog.calls).toBe(1);
        expect(dialog.last.title).toBe('Sync conflict');
        expect(applies.texts.at(-1)).toBe('{"from":"second","edit":1}');

        // The union goes straight back up, on a counter above both sides. That
        // is what stops the loser pulling the pre-merge copy back down and
        // re-opening the same conflict for ever
        expect(gistSeq()).toBe(3);
        expect(first.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(3);

        // ...and the second device takes it without another question
        tick();
        dialog.calls = 0;
        const back = await as(second, () => syncManager.pull());
        expect(back.reason).not.toBe('not-newer');
        expect(dialog.calls).toBe(0);
        expect(second.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(3);
    });

    test('an equal counter with an equal stamp is still not newer', () => {
        const stamp = new Date(BASE_MS).toISOString();
        expect(isNewer(stamp, stamp, 4, 4)).toBe(false);
    });

    test('a strictly lower counter is not newer, whatever the stamp says', () => {
        const past = new Date(BASE_MS).toISOString();
        const future = new Date(BASE_MS + HOUR_MS).toISOString();
        expect(isNewer(future, past, 2, 3)).toBe(false);
    });
});

describe('6. an incomplete apply moves nothing', () => {
    test('a pull that could not write leaves both the stamp and the counter alone', async () => {
        const source = makeDevice('source');
        const target = makeDevice('target');

        await as(source, () => syncManager.push());
        expect(gistSeq()).toBe(1);

        applies.complete = false;
        tick();
        const result = await as(target, () => syncManager.pull());

        expect(result).toMatchObject({ ok: false, reason: 'incomplete-apply' });
        expect(target.bookkeeping.toolasha_sync_lastSyncedSeq ?? null).toBe(null);
        expect(target.bookkeeping.toolasha_sync_lastSyncedAt ?? null).toBe(null);
    });

    test('the retry after a failed apply still sees the payload as newer', async () => {
        const source = makeDevice('source');
        const target = makeDevice('target');

        await as(source, () => syncManager.push());
        applies.complete = false;
        tick();
        await as(target, () => syncManager.pull());

        applies.complete = true;
        tick();
        const retry = await as(target, () => syncManager.pull());

        expect(retry.reason).not.toBe('not-newer');
        expect(applies.texts.at(-1)).toBe('{"from":"source"}');
        expect(target.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(1);
    });
});

describe('forgetting a gist forgets its counter', () => {
    test('the counter is cleared with the rest of the bookkeeping', async () => {
        const device = makeDevice('solo');
        await as(device, () => syncManager.push());
        expect(device.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(1);

        await as(device, () => syncManager.forgetGist());
        expect(device.bookkeeping.toolasha_sync_lastSyncedSeq).toBe(null);
    });
});
