/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing the custom tabs down while `initialize()` is
 * parked on its config read.
 *
 * `CustomTabsFeature.disable()` is `this.ui?.cleanup(); this.ui = null;` — so a
 * teardown landing inside `loadConfig()` cleans a half-built `CustomTabsUI` and
 * then drops the only reference to it, while the call is still suspended on
 * `this`. The resumed tail went on to inject its stylesheet, both
 * `domObserver.onClass` watchers, the `onReady` catch-up, two
 * `config.onSettingChange` subscriptions, the `items_updated` handler, the
 * sort-mode subscription, the `character_initialized` reload and the
 * loadout-snapshot subscription — onto an instance nothing holds any more.
 *
 * That is what makes this site different from the rest of the class: every
 * other one self-heals, because the next teardown reaches the same singleton.
 * Here no future `cleanup()` can ever reach the orphan, so it keeps rewriting
 * inventory DOM off a departed character's config for the life of the tab.
 * The guard therefore has to live inside `CustomTabsUI.initialize()`; one in
 * the wrapper cannot help, because the wrapper has already let go.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside loadConfig() */
    gate: null,
    charId: 'char1',
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            if (world.gate) await world.gate;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (world.gate) await world.gate;
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

/** Every registration the UI takes, counted so an orphan is visible. */
const live = vi.hoisted(() => ({
    observers: [],
    settingSubs: 0,
    sortSubs: 0,
    loadoutSubs: 0,
    events: {},
}));

const dm = vi.hoisted(() => ({
    charId: null,
    getCurrentCharacterId: () => world.charId,
    getCurrentCharacterName: () => 'Name',
    getCurrentCharacterGameMode: () => 'standard',
    getInitClientData: () => ({}),
    characterItems: [],
    on: (event, fn) => {
        (live.events[event] ||= []).push(fn);
    },
    off: (event, fn) => {
        live.events[event] = (live.events[event] || []).filter((h) => h !== fn);
    },
}));

const loadoutSnapshotMock = vi.hoisted(() => ({
    onUpdate: () => {
        live.loadoutSubs += 1;
    },
    offUpdate: () => {
        live.loadoutSubs -= 1;
    },
    updateEnhancementLevel: () => {},
    snapshots: {},
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {
            live.settingSubs += 1;
            return () => {
                live.settingSubs -= 1;
            };
        },
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            live.observers.push(name);
            return () => {
                const at = live.observers.indexOf(name);
                if (at !== -1) live.observers.splice(at, 1);
            };
        },
        // Mirrors DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            live.observers.push(name);
            callback();
            return () => {
                const at = live.observers.indexOf(name);
                if (at !== -1) live.observers.splice(at, 1);
            };
        },
    },
}));
vi.mock('../inventory-sort.js', () => ({
    default: {
        onModeChange: () => {
            live.sortSubs += 1;
            return () => {
                live.sortSubs -= 1;
            };
        },
    },
}));
vi.mock('../inventory-badge-manager.js', () => ({
    default: { currentInventoryElem: null, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: loadoutSnapshotMock }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: customTabsFeature } = await import('./custom-tabs-feature.js');

/** Everything the UI registers, as one number. */
const registrations = () =>
    live.observers.length +
    live.settingSubs +
    live.sortSubs +
    live.loadoutSubs +
    (live.events['items_updated'] || []).length +
    (live.events['character_initialized'] || []).length;

/** Let the parked initialize() actually reach the gated read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a character switch landing inside the tabs config read', () => {
    beforeEach(() => {
        customTabsFeature.disable();
        for (const store of storageMock.stores.values()) store.clear();
        live.observers = [];
        live.settingSubs = 0;
        live.sortSubs = 0;
        live.loadoutSubs = 0;
        live.events = {};
        world.gate = null;
        world.charId = 'char1';
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    afterEach(() => {
        customTabsFeature.disable();
    });

    /**
     * Start an initialize() whose config read is held open, tear the feature
     * down inside it the way `disableAllFeatures()` does, then let it land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = customTabsFeature.initialize();
        await settle();
        world.gate = null;
        // `character_switching` — the feature layer comes down mid-read…
        customTabsFeature.disable();
        // …and the arriving character is current before it resolves
        world.charId = 'char2';
        release();
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(live.observers).toEqual([]);
        expect(registrations()).toBe(0);
        expect(document.head.querySelectorAll('style')).toHaveLength(0);
    });

    test('a run of interrupted switches leaves the arriving character one removable UI', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which builds a fresh CustomTabsUI
        await customTabsFeature.initialize();

        const afterOneInit = registrations();
        expect(afterOneInit).toBeGreaterThan(0);
        expect(document.head.querySelectorAll('style')).toHaveLength(1);

        // …and every one of them is reachable by the next teardown, which is
        // exactly what an orphaned instance is not
        customTabsFeature.disable();
        expect(registrations()).toBe(0);
        expect(document.head.querySelectorAll('style')).toHaveLength(0);
    });
});
