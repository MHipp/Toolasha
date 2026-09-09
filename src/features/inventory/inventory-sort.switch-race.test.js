/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is parked
 * on the stored-settings read.
 *
 * `unregisterHandlers` being non-empty is this module's re-entry guard, so a
 * post-teardown registration does not merely leak — it turns the switch's own
 * re-initialise away, and the sort controls and stack-price badges stay gone
 * until the page is reloaded.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const keyMock = vi.hoisted(() => ({
    // Set to a promise to hold the settings read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    handlers: new Map(),
    getCurrentCharacterId: () => dataManagerMock.characterId,
    on: (event, handler) => dataManagerMock.handlers.set(event, handler),
    off: (event, handler) => {
        if (dataManagerMock.handlers.get(event) === handler) dataManagerMock.handlers.delete(event);
    },
}));

const observerMock = vi.hoisted(() => ({ live: 0 }));
const badgeMock = vi.hoisted(() => ({ providers: new Set() }));
const marketMock = vi.hoisted(() => ({ listeners: 0 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async () => {
        // The key is built from the character in hand when the read *starts*,
        // which is the whole point: a read begun as one character resolves
        // holding that character's settings however long it takes
        const who = dataManagerMock.characterId;
        if (keyMock.gate) await keyMock.gate;
        return keyMock.stored[who] ?? null;
    },
    writeScoped: async () => true,
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => {
    const register = () => {
        observerMock.live += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            observerMock.live -= 1;
        };
    };
    return { default: { onClass: register, onReady: register } };
});
vi.mock('../../api/marketplace.js', () => ({
    default: {
        on: () => {
            marketMock.listeners += 1;
        },
        off: () => {
            marketMock.listeners -= 1;
        },
        isLoaded: () => true,
        getItemPrice: () => null,
    },
}));
vi.mock('./inventory-badge-manager.js', () => ({
    default: {
        registerProvider: (name) => badgeMock.providers.add(name),
        unregisterProvider: (name) => badgeMock.providers.delete(name),
        invalidateCache: () => {},
        requestRender: () => {},
    },
}));

const { default: inventorySort } = await import('./inventory-sort.js');

describe('a character switch landing inside the stored-settings read', () => {
    beforeEach(() => {
        keyMock.gate = null;
        keyMock.stored = {};
        dataManagerMock.characterId = 'char1';
        dataManagerMock.handlers.clear();
        inventorySort.disable();
        observerMock.live = 0;
        badgeMock.providers.clear();
        marketMock.listeners = 0;
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        keyMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = inventorySort.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        inventorySort.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        keyMock.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves the re-entry guard clear', async () => {
        await switchDuringInitialize();

        expect(inventorySort.unregisterHandlers).toEqual([]);
        expect(observerMock.live).toBe(0);
        expect(badgeMock.providers.size).toBe(0);
        expect(dataManagerMock.handlers.has('items_updated')).toBe(false);
        expect(marketMock.listeners).toBe(0);
        expect(inventorySort.isInitialized).toBe(false);
    });

    test('the arriving character gets their own sort mode rather than a feature dead until reload', async () => {
        keyMock.stored = { char1: { mode: 'name' }, char2: { mode: 'value' } };

        await switchDuringInitialize();
        // This is the `character_switched` re-initialise
        await inventorySort.initialize();

        expect(inventorySort.isInitialized).toBe(true);
        expect(inventorySort.currentMode).toBe('value');
        expect(observerMock.live).toBe(2);
        expect(badgeMock.providers.has('inventory-stack-price')).toBe(true);
    });
});
