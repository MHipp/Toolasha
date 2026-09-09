/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is parked
 * on the persisted-state read.
 *
 * `isInitialized` is set *before* that read, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `disable()`
 * had emptied `unregisterHandlers` and nulled `characterInitHandler`, and
 * pushed its own `domObserver.onClass` registrations into the emptied array and
 * a second `character_initialized` handler over the nulled field. Both were
 * left live with no handle to remove them by. Cheaper than the action-panel
 * sites only because those observers fire when the Collections panel is opened.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the persisted-state read */
    gate: null,
    characterId: 'char1',
}));

/** Live `domObserver.onClass` registrations, by name, so leaks are countable. */
const observers = vi.hoisted(() => ({ live: [] }));
/** Every live dataManager listener, by event. */
const events = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_k, fallback) => fallback,
        onSettingChange: () => {},
        COLOR_ACCENT: '#ffd700',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => null,
        on: (event, handler) => {
            (events.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            events.handlers[event] = (events.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            observers.live.push(name);
            return () => {
                const at = observers.live.indexOf(name);
                if (at !== -1) observers.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: () => ({ actionTime: 10, efficiencyMultiplier: 1, totalGathering: 0 }),
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async () => null,
        getMany: async (keys) => {
            // The one read initialize() parks on
            if (world.gate) await world.gate;
            return new Map(keys.map((key) => [key, null]));
        },
        parseJSON: (raw, _key, fallback = null) => (raw === null ? fallback : raw),
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        setJSON: async () => true,
        delete: async () => true,
        getJSON: async () => null,
        getAllKeys: async () => [],
    },
}));

const { default: collectionFilters } = await import('./collection-filters.js');

const liveCount = (event) => (events.handlers[event] || []).length;

describe('a character switch landing inside the persisted-state read', () => {
    beforeEach(() => {
        collectionFilters.disable();
        world.gate = null;
        world.characterId = 'char1';
        observers.live = [];
        events.handlers = {};
        collectionFilters._loadedFor = null;
        collectionFilters._renamedFor = null;
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    afterEach(() => {
        collectionFilters.disable();
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
        const pending = collectionFilters.initialize();
        // `character_switching` — the feature layer comes down mid-read
        collectionFilters.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(observers.live).toEqual([]);
        expect(collectionFilters.unregisterHandlers).toEqual([]);
        expect(liveCount('character_initialized')).toBe(0);
        expect(collectionFilters.characterInitHandler ?? null).toBe(null);
        expect(collectionFilters.isInitialized).toBe(false);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await collectionFilters.initialize();

        expect(observers.live).toEqual(['CollectionFilters-panel', 'CollectionFilters-skilling']);
        expect(collectionFilters.unregisterHandlers).toHaveLength(2);
        expect(liveCount('character_initialized')).toBe(1);

        // …and that one set is the one the teardown can remove
        collectionFilters.disable();
        expect(observers.live).toEqual([]);
        expect(liveCount('character_initialized')).toBe(0);
    });
});
