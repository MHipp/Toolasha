/**
 * The preserved chat history must never leave the device.
 *
 * It is every chat tab's markup — whispers and private messages included — and
 * the maintainer accepted storing that on disk, not publishing it. The sync
 * uploads to a GitHub gist, so a whisper reaching a payload is a real privacy
 * failure rather than a tidiness problem, which is why this is asserted against
 * the *real* payload builder and the *real* importer: only `core/storage.js` is
 * stubbed, so the exclusion being wired into both paths is what makes these
 * pass, not a mock echoing the expected answer back.
 *
 * Both directions matter. Out, because that is the leak. In, because a payload
 * written by an older build — or by a device whose script predates the
 * exclusion — can still carry the key, and importing it would plant another
 * player's whispers on this machine.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ stores: {}, written: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => Object.keys(state.stores),
        getAll: async (name) => ({ ...(state.stores[name] || {}) }),
        getJSON: async (key, name, fallback = null) => {
            const store = state.stores[name] || {};
            return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
        },
        setJSON: async (key, value, name) => {
            state.written[name] = { ...(state.written[name] || {}), [key]: value };
            return true;
        },
        tryGet: async (key, name) => {
            const store = state.stores[name] || {};
            return Object.prototype.hasOwnProperty.call(store, key)
                ? { found: true, value: store[key] }
                : { found: false, value: null };
        },
        putAll: async (name, entries) => {
            state.written[name] = { ...(state.written[name] || {}), ...entries };
            return Object.keys(entries).length;
        },
        beginRestore: async () => {},
        endRestore: async () => {},
        finishRestore: () => {},
    },
}));

import { CHAT_HISTORY_KEY_BASE, CHAT_HISTORY_STORE } from './chat-history-persistence.js';
import { applyPayload, buildPayloadJSON } from '../sync/sync-payload.js';
import { readFileSync } from 'node:fs';
import settingsStorage from '../../core/settings-storage.js';
import { DEVICE_LOCAL_KEY_PREFIXES } from '../../utils/full-backup.js';

const HISTORY_KEY = `${CHAT_HISTORY_KEY_BASE}_char1`;
const WHISPER = 'meet me at the tower';

describe('chat history never reaches a sync payload', () => {
    beforeEach(() => {
        state.written = {};
        state.stores = {
            settings: {
                script_settingsMap: JSON.stringify({ chatHistoryExtender: true }),
                [HISTORY_KEY]: {
                    v: 1,
                    savedAt: 1,
                    tabs: { 'tab:Whispers': [`<div class="ChatMessage_chatMessage__z">${WHISPER}</div>`] },
                },
            },
            dungeonRuns: { runs_char1: [] },
        };
    });

    test('the key lives in the store the exclusion covers', () => {
        // The exclusion is a key-prefix rule applied to the settings store, so
        // a record that moved to a store of its own would silently escape it —
        // `buildPayloadJSON('everything')` walks every store `listStores()`
        // reports and only the settings store is redacted.
        expect(CHAT_HISTORY_STORE).toBe('settings');
        expect(HISTORY_KEY.startsWith('toolasha_local_')).toBe(true);
    });

    test.each(['settings', 'everything'])('an upload at scope %s carries none of it', async (scope) => {
        const json = await buildPayloadJSON(scope);

        expect(json).not.toContain(HISTORY_KEY);
        expect(json).not.toContain('toolasha_local_');
        expect(json).not.toContain(WHISPER);
        expect(json).not.toContain('tab:Whispers');

        // …and the payload is otherwise a real one, so the assertions above are
        // not passing because nothing was built.
        const parsed = JSON.parse(json);
        expect(parsed.stores.settings.script_settingsMap).toContain('chatHistoryExtender');
        if (scope === 'everything') expect(parsed.stores.dungeonRuns).toBeDefined();
    });

    test('an import carrying it — an older build’s payload — does not plant it', async () => {
        const hostile = JSON.stringify({
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            syncScope: 'everything',
            stores: {
                settings: {
                    script_settingsMap: JSON.stringify({ chatHistoryExtender: true }),
                    [HISTORY_KEY]: { v: 1, savedAt: 2, tabs: { 'tab:Whispers': ['<div>someone else</div>'] } },
                },
            },
        });

        await applyPayload(hostile);

        expect(Object.keys(state.written.settings || {})).not.toContain(HISTORY_KEY);
        expect(JSON.stringify(state.written)).not.toContain('someone else');
        // The rest of the payload still landed
        expect(state.written.settings.script_settingsMap).toContain('chatHistoryExtender');
    });

    test('a manual backup file leaves it out as well', async () => {
        const { exportEverythingJSON } = await import('../../utils/full-backup.js');
        const json = await exportEverythingJSON();
        expect(json).not.toContain(WHISPER);
        expect(json).not.toContain(HISTORY_KEY);
        expect(json).toContain('dungeonRuns');
    });
});

/**
 * The exclusion is a key-prefix rule, and the prefix means "never leaves this
 * device" — not "never leaves this device while it happens to live in the
 * settings store".
 *
 * The record is in `settings` today only because a new object store would mean
 * a `dbVersion` bump this database cannot take on its own. That constraint can
 * lift, and `buildPayloadJSON('everything')` walks every store `listStores()`
 * reports; a store-scoped rule would then upload the same whispers without a
 * line of the exclusion changing. So the rule is applied to every store.
 */
describe('the device-local prefix is honoured in every store, not just settings', () => {
    const OTHER_STORE = 'dungeonRuns';
    const OTHER_KEY = `${CHAT_HISTORY_KEY_BASE}_char1`;

    beforeEach(() => {
        state.written = {};
        state.stores = {
            settings: { script_settingsMap: JSON.stringify({ chatHistoryExtender: true }) },
            [OTHER_STORE]: { runs_char1: [], [OTHER_KEY]: { tabs: { 'tab:Whispers': [WHISPER] } } },
        };
    });

    test('an upload leaves it behind wherever it is written', async () => {
        const json = await buildPayloadJSON('everything');
        expect(json).not.toContain(WHISPER);
        expect(json).not.toContain('toolasha_local_');
        expect(JSON.parse(json).stores[OTHER_STORE].runs_char1).toBeDefined();
    });

    test('a backup file leaves it behind wherever it is written', async () => {
        const { exportEverythingJSON } = await import('../../utils/full-backup.js');
        const json = await exportEverythingJSON();
        expect(json).not.toContain(WHISPER);
        expect(json).not.toContain('toolasha_local_');
    });

    test('an import does not plant it into another store either', async () => {
        await applyPayload(
            JSON.stringify({
                formatVersion: 1,
                exportedAt: new Date().toISOString(),
                stores: { [OTHER_STORE]: { runs_char1: [], [OTHER_KEY]: { tabs: { x: ['someone else'] } } } },
            })
        );

        expect(Object.keys(state.written[OTHER_STORE] || {})).not.toContain(OTHER_KEY);
        expect(JSON.stringify(state.written)).not.toContain('someone else');
    });
});

/**
 * The settings file's import side.
 *
 * The sync payload and the full backup both strip the prefix on the way in as
 * well as on the way out, for the same reason: a file written by an older build
 * — or by another player, which is what a shared settings file is — still
 * carries the key, and writing it here plants their whispers on this machine
 * exactly as if they had been typed into it. `importSettings` was the one
 * inbound path with no such guard.
 */
describe('a settings file cannot plant someone else’s chat history', () => {
    beforeEach(() => {
        state.written = {};
        state.stores = { settings: {} };
    });

    test('importSettings drops the device-local keys and imports the rest', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                script_settingsMap: JSON.stringify({ chatHistoryExtender: true }),
                [HISTORY_KEY]: { v: 1, savedAt: 3, tabs: { 'tab:Whispers': [WHISPER] } },
            })
        );

        expect(Object.keys(state.written.settings || {})).not.toContain(HISTORY_KEY);
        expect(JSON.stringify(state.written)).not.toContain(WHISPER);
        expect(state.written.settings.script_settingsMap).toContain('chatHistoryExtender');
        expect(result.imported).toBe(1);
    });

    test('the repeated prefix list matches the shared one, in both directions', () => {
        // `settings-storage.js` is a Core module and Core loads before Utils, so
        // it repeats the literal rather than importing it. This is what keeps
        // the repeat honest.
        const source = readFileSync(new URL('../../core/settings-storage.js', import.meta.url), 'utf8');
        const listed = source.slice(
            source.indexOf('const DEVICE_LOCAL_KEY_PREFIXES = ['),
            source.indexOf(']', source.indexOf('const DEVICE_LOCAL_KEY_PREFIXES = ['))
        );

        for (const prefix of DEVICE_LOCAL_KEY_PREFIXES) {
            expect(listed, `settings-storage must also know "${prefix}"`).toContain(prefix);
        }
        // Both paths in that module consult it — the export and the import.
        expect(source).toContain("const EXCLUDE_PREFIXES = ['marketplace_cache', ...DEVICE_LOCAL_KEY_PREFIXES]");
        expect(
            source.slice(source.indexOf('async importSettings(')),
            'importSettings must drop the device-local keys too'
        ).toContain('DEVICE_LOCAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))');
    });
});
