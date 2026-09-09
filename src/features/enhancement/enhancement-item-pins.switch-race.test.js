/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is parked
 * on the stored-pins read. Everything registered after that await lands on a
 * layer that is already gone.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        // Set to a promise to hold every read open, so a test can land a
        // teardown inside the read the way a character switch does
        gate: null,
        reset() {
            stores.clear();
            storageMock.gate = null;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.gate) await storageMock.gate;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => 'standard',
}));

const observerMock = vi.hoisted(() => ({ live: 0 }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            observerMock.live += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                observerMock.live -= 1;
            };
        },
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: pins } = await import('./enhancement-item-pins.js');

const styleCount = () => document.querySelectorAll('#mwi-enhance-pins-style').length;

describe('a character switch landing inside the stored-pins read', () => {
    beforeEach(() => {
        storageMock.reset();
        dataManagerMock.characterId = 'char1';
        pins.disable();
        observerMock.live = 0;
        document.querySelectorAll('#mwi-enhance-pins-style').forEach((el) => el.remove());
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = pins.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        pins.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        storageMock.gate = null;
        await pending;
    }

    test('the interrupted initialize leaves no style element and no menu watcher behind', async () => {
        await switchDuringInitialize();

        expect(styleCount()).toBe(0);
        expect(observerMock.live).toBe(0);
        expect(pins.isInitialized).toBe(false);
    });

    test('repeated switches do not stack up styles and watchers', async () => {
        for (let i = 0; i < 5; i++) {
            dataManagerMock.characterId = 'char1';
            await switchDuringInitialize();
        }

        expect(styleCount()).toBe(0);
        expect(observerMock.live).toBe(0);
    });

    test('the arriving character still gets exactly one style element and one watcher', async () => {
        await switchDuringInitialize();

        // This is the `character_switched` re-initialise
        await pins.initialize();

        expect(pins.isInitialized).toBe(true);
        expect(styleCount()).toBe(1);
        expect(observerMock.live).toBe(1);
    });
});
