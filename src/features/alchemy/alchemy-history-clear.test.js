/**
 * What "clear my alchemy history" does when the store refuses the delete.
 *
 * `ChunkedHistory.clear()` answers `false` for a clear that did not happen —
 * a store that could not be listed, or deletes that were refused — and the
 * viewers report that instead of emptying the table. The trackers dropped the
 * in-progress session before asking, so a refused clear lost the attempts
 * recorded since that session started while leaving on disk the history the
 * user had asked to delete: nothing deleted, and something lost.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ cleared: 0, answer: true }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getCurrentCharacterId: () => 'char-1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 0,
    getItemPrices: () => null,
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async () => {},
        clear: async () => {
            store.cleared += 1;
            return store.answer;
        },
        setCharacter: () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const trackers = [
    ['coinify', coinifyHistoryTracker],
    ['transmute', transmuteHistoryTracker],
    ['decompose', decomposeHistoryTracker],
];

beforeEach(() => {
    store.cleared = 0;
    store.answer = true;
    for (const [, tracker] of trackers) {
        tracker.characterId = 'char-1';
        tracker.activeSession = null;
    }
});

describe.each(trackers)('%s history clearing', (_name, tracker) => {
    test('a clear that worked drops the in-progress session with the rest', async () => {
        tracker.activeSession = { id: 'session-1', totalAttempts: 7 };

        expect(await tracker.clearHistory()).toBe(true);
        expect(store.cleared).toBe(1);
        expect(tracker.activeSession).toBeNull();
    });

    /*
     * Fails before the fix: `activeSession` was nulled before the store was
     * asked, so a refused clear deleted nothing and lost the running session
     * anyway — the half-state the refusal exists to prevent.
     */
    test('a refused clear keeps the in-progress session, since nothing was deleted', async () => {
        store.answer = false;
        const session = { id: 'session-1', totalAttempts: 7 };
        tracker.activeSession = session;

        expect(await tracker.clearHistory()).toBe(false);
        expect(tracker.activeSession).toBe(session);
    });
});
