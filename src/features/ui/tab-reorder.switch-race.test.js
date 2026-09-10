/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is
 * parked on the saved-order read.
 *
 * `isInitialized` is set *before* that read, so the switch's own
 * re-initialise never early-returned — the interrupted call simply resumed
 * after `disable()` had emptied `unregisterHandlers`, and pushed its own
 * `domObserver.onClass`/`onReady` registrations into the emptied array with
 * no handle left to remove them by. Harmless in practice — both redo
 * idempotent work gated on `tab.dataset.mwiTabReorder` — but the leaked
 * registration survives until the *next* switch's teardown clears the array
 * wholesale, doing a duplicate reorder pass in the meantime.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the saved-order read */
    gate: null,
    characterId: 'char1',
}));

/** Live domObserver registrations, by name, so leaks are countable. */
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

const { default: tabReorder } = await import('./tab-reorder.js');

describe('a character switch landing inside the saved-order read', () => {
    beforeEach(() => {
        tabReorder.disable();
        world.gate = null;
        world.characterId = 'char1';
        registrations.live = [];
        document.body.innerHTML = `
            <div role="tablist">
                <button role="tab">Inventory</button>
            </div>
        `;
    });

    afterEach(() => {
        tabReorder.disable();
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
        const pending = tabReorder.initialize();
        // `character_switching` — the feature layer comes down mid-read
        tabReorder.disable();
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
        await tabReorder.initialize();

        expect(registrations.live).toEqual(['TabReorder', 'TabReorderCatchUp']);

        // …and that one set is the one the teardown can remove
        tabReorder.disable();
        expect(registrations.live).toEqual([]);
    });
});
