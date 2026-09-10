/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is
 * parked on the batched startup read (the protected list plus the six cap
 * records).
 *
 * `isInitialized` is set *before* that read, so the switch's own
 * re-initialise never early-returned — the interrupted call simply resumed
 * after `disable()` had emptied `unregisterHandlers`, and pushed its own
 * `domObserver.onClass`/`onReady` and `onConfirmFlowSettled` registrations
 * into the emptied array with no handle left to remove them by. Idempotent
 * (every card repaint recomputes its box-shadow from scratch), so the leaked
 * registrations do no visible harm, but they would sit there doing a
 * duplicate pass over every task card until the *next* switch's teardown
 * clears the array wholesale.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the startup read */
    gate: null,
    characterId: 'char1',
}));

/** Live domObserver / confirm-flow registrations, by name, so leaks are countable. */
const registrations = vi.hoisted(() => ({ live: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));
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
        onReady: (name) => {
            registrations.live.push(name);
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./task-card-state.js', () => ({
    isCardInConfirmState: () => false,
    armConfirmSettleWatch: () => {},
    onConfirmFlowSettled: (callback) => {
        registrations.live.push('ConfirmFlowSettled');
        void callback;
        return () => {
            const at = registrations.live.indexOf('ConfirmFlowSettled');
            if (at !== -1) registrations.live.splice(at, 1);
        };
    },
}));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char`,
    readScopedFrom: async (base, _map, _store, fallback) => fallback,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => {
            // The one read initialize() parks on
            if (world.gate) await world.gate;
            return [];
        },
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
        setJSON: async () => {},
    },
}));

const { default: taskRerollProtection } = await import('./task-reroll-protection.js');

describe('a character switch landing inside the startup read', () => {
    beforeEach(() => {
        taskRerollProtection.disable();
        world.gate = null;
        world.characterId = 'char1';
        registrations.live = [];
        document.body.innerHTML = '';
    });

    afterEach(() => {
        taskRerollProtection.disable();
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = taskRerollProtection.initialize();
        // `character_switching` — the feature layer comes down mid-read
        taskRerollProtection.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(registrations.live).toEqual([]);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await taskRerollProtection.initialize();

        expect(registrations.live.sort()).toEqual(
            [
                'ConfirmFlowSettled',
                'TaskRerollProtection',
                'TaskRerollProtection-Panel',
                'TaskRerollProtectionCatchUp',
            ].sort()
        );

        // …and that one set is the one the teardown can remove
        taskRerollProtection.disable();
        expect(registrations.live).toEqual([]);
    });
});
