/**
 * A reconnect to the *same* character landing inside the snapshot read.
 *
 * `initialize()` already guarded its resumed tail with
 * `if (getStorageKey() !== storageKey) return;`, which catches a genuine
 * character switch — a switch test passes against the pre-fix source and
 * proves nothing. It does not catch a reconnect, which is `disable()` followed
 * by `initialize()` again under the *same* character: the storage key is
 * unchanged, so the suspended call's tail sails through the comparison and
 * does `this.characterInitializedHandler = …; dataManager.on(…)` on top of the
 * registration the fresh call already made. The field holds one handle, so the
 * fresh call's listener is orphaned — live, and unremovable — one per
 * interrupted reconnect.
 *
 * A character id alone cannot tell the two calls apart; a generation counter
 * can, which is what `utils/init-ownership.js` adds.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the snapshot read */
    gate: null,
    characterId: 'char1',
}));

/** Live `character_initialized` registrations, so leaks are countable. */
const live = vi.hoisted(() => ({ charInit: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        characterData: null,
        on: (event, handler) => {
            if (event === 'character_initialized') live.charInit.push(handler);
        },
        off: (event, handler) => {
            if (event === 'character_initialized') live.charInit = live.charInit.filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => {
            // The one read initialize() parks on
            if (world.gate) await world.gate;
            return null;
        },
        setJSON: async () => {},
    },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/bundle-bridge.js', () => ({ webSocketHook: () => null }));

const loadoutSnapshot = (await import('./loadout-snapshot.js')).default;

describe('a same-character reconnect landing inside the snapshot read', () => {
    beforeEach(() => {
        loadoutSnapshot.disable();
        world.gate = null;
        world.characterId = 'char1';
        live.charInit = [];
    });

    afterEach(() => {
        loadoutSnapshot.disable();
    });

    /**
     * Park an initialize() on its storage read, reconnect underneath it — the
     * same character's `disable()` then `initialize()` — and only then let the
     * parked read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function reconnectDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = loadoutSnapshot.initialize();

        // The reconnect: same character throughout, so every storage key below
        // matches the one the parked read started with.
        loadoutSnapshot.disable();
        world.gate = null;
        await loadoutSnapshot.initialize();

        release();
        await pending;
    }

    test('the reconnect leaves exactly one character_initialized listener', async () => {
        await reconnectDuringInitialize();

        expect(live.charInit).toHaveLength(1);
        // …and it is the one the live initialize() holds the handle to
        expect(live.charInit[0]).toBe(loadoutSnapshot.characterInitializedHandler);
    });

    test('the next teardown can remove every listener the reconnect left', async () => {
        await reconnectDuringInitialize();

        loadoutSnapshot.disable();

        expect(live.charInit).toHaveLength(0);
    });

    test('a genuine character switch is still caught', async () => {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = loadoutSnapshot.initialize();
        loadoutSnapshot.disable();
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;

        expect(live.charInit).toHaveLength(0);
    });
});
