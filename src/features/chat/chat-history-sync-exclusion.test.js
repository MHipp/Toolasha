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
