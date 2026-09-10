/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is
 * parked on `loadLoadouts()`.
 *
 * `initialized` is set *before* that read, so a second owner's initialize()
 * never early-returned it back into the same call — the interrupted call
 * simply resumed after `cleanup()` (once `owners` hit zero) had emptied the
 * `unregister` array, and pushed its own websocket pair and modal observer
 * back into it with no handle left to remove them by. Idempotent (every
 * capture folds into `record` by key), so the leaked pair does no visible
 * harm, but it survives until the *next* switch's teardown clears the array
 * wholesale.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside loadLoadouts() */
    gate: null,
    characterId: 'char1',
}));

/** Live domObserver registrations, by name, so leaks are countable. */
const registrations = vi.hoisted(() => ({ live: [] }));
/** Live websocket listeners, by event. */
const ws = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.characterId },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            registrations.live.push(name);
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            (ws.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            ws.handlers[event] = (ws.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('./guild-loadouts.js', () => ({
    extractLoadout: () => null,
    extractPartyLoadouts: () => [],
    foldLoadout: (record) => record,
    isMonsterUnit: () => false,
    isItemName: () => false,
    loadLoadouts: async () => {
        // The one read initialize() parks on
        if (world.gate) await world.gate;
        return { players: {}, updatedAt: 0 };
    },
    loadoutKey: (name) => String(name || '').toLowerCase(),
    loadoutList: (record) => Object.values(record?.players || {}),
    pruneCharacterOnlyLoadouts: async () => [],
    purgeMonsterLoadouts: (record) => ({ record, purged: [] }),
    saveLoadouts: async () => {},
}));

const { guildLoadoutCapture } = await import('./guild-loadout-capture.js');

describe('a character switch landing inside loadLoadouts()', () => {
    beforeEach(() => {
        // Drain any owners a previous test left behind
        while (guildLoadoutCapture.owners > 0) guildLoadoutCapture.cleanup();
        world.gate = null;
        world.characterId = 'char1';
        registrations.live = [];
        ws.handlers = {};
    });

    afterEach(() => {
        while (guildLoadoutCapture.owners > 0) guildLoadoutCapture.cleanup();
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way a character switch does (one owner's disable, which
     * drops `owners` to zero and actually tears down), then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = guildLoadoutCapture.initialize();
        // `character_switching` — the feature layer comes down mid-read
        guildLoadoutCapture.cleanup();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(registrations.live).toEqual([]);
        expect(ws.handlers['battle_unit_fetched'] ?? []).toEqual([]);
        expect(ws.handlers['new_battle'] ?? []).toEqual([]);
        expect(guildLoadoutCapture.initialized).toBe(false);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await guildLoadoutCapture.initialize();

        expect(registrations.live).toEqual(['GuildLoadoutPopup']);
        expect(ws.handlers['battle_unit_fetched']).toHaveLength(1);
        expect(ws.handlers['new_battle']).toHaveLength(1);

        // …and that one set is the one the teardown can remove
        guildLoadoutCapture.cleanup();
        expect(registrations.live).toEqual([]);
        expect(ws.handlers['battle_unit_fetched'] ?? []).toEqual([]);
        expect(ws.handlers['new_battle'] ?? []).toEqual([]);
    });
});
