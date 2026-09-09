/**
 * A character switch tearing the tracker down while its initialize() is parked
 * on the stored-history read.
 *
 * `initialized` is set after that read, so a late assignment writes `true` over
 * the teardown that cleared it: the switch's own re-initialise then
 * early-returns at its own guard and no board reading is recorded again until
 * the page is reloaded.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the history read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

const wsMock = vi.hoisted(() => ({ handlers: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => wsMock.handlers.set(event, handler),
        off: (event, handler) => {
            if (wsMock.handlers.get(event) === handler) wsMock.handlers.delete(event);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (storageMock.gate) await storageMock.gate;
            return { found: key in storageMock.stored, value: storageMock.stored[key] };
        },
        get: async (key) => storageMock.stored[key] ?? null,
        set: async (key, value) => {
            storageMock.stored[key] = value;
            return true;
        },
    },
}));
vi.mock('../../utils/sync-merge-registry.js', () => ({ registerSyncMerge: () => {} }));

const { leaderboardXPTracker } = await import('./leaderboard-xp-tracker.js');

describe('a character switch landing inside the stored-history read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        leaderboardXPTracker.disable();
        wsMock.handlers.clear();
    });

    /**
     * Start an initialize() whose read is held open, tear the tracker down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = leaderboardXPTracker.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        leaderboardXPTracker.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        storageMock.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves the guard flag clear', async () => {
        await switchDuringInitialize();

        expect(wsMock.handlers.has('leaderboard_updated')).toBe(false);
        expect(leaderboardXPTracker.unregisterHandlers).toEqual([]);
        expect(leaderboardXPTracker.initialized).toBe(false);
    });

    test('the recorded history is readable afterwards rather than a tracker dead until reload', async () => {
        const now = Date.now();
        // What the tracker has already recorded for this board, in store
        storageMock.stored.playerXP = {
            foraging_Alice: [
                { t: now - 2 * 60 * 60 * 1000, xp: 1000 },
                { t: now - 60 * 60 * 1000, xp: 2000 },
            ],
        };

        await switchDuringInitialize();
        // This is the `character_switched` re-initialise. Interrupted by the
        // teardown, the load that ran inside it stood down (the record's own
        // reset guard), so this is the only load that reaches memory
        await leaderboardXPTracker.initialize();

        expect(leaderboardXPTracker.initialized).toBe(true);
        expect(leaderboardXPTracker.getLatestValue('Alice', 'foraging')).toBe(2000);
        expect(leaderboardXPTracker.getPlayerStats('Alice', 'foraging').lastXPH).toBeGreaterThan(0);

        // …and the live handler is one this initialize registered, still recording
        const handler = wsMock.handlers.get('leaderboard_updated');
        expect(typeof handler).toBe('function');
        handler({
            leaderboardCategory: 'foraging',
            leaderboard: { columnNames: ['Level', 'Experience'], rows: [{ name: 'Alice', rank: 3, value2: 12345 }] },
        });
        expect(leaderboardXPTracker.getLatestValue('Alice', 'foraging')).toBe(12345);
    });
});
