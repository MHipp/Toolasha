/**
 * A teardown landing inside the trade ledger's `initialize()` read.
 *
 * `isInitialized` is set *before* `await this.load()`, so the resumed tail runs
 * on a store that `disable()` has already emptied. Two separate defects came
 * out of that tail, and they need separate proof:
 *
 * - it ran `processListings(getMarketListings(), true)` — snapshot mode, which
 *   deletes every stored baseline not present in the argument and then persists
 *   the loss through `saveStates()`. A torn-down store rewriting the user's
 *   listing baselines is the data-losing half;
 * - it re-registered `initHandler` and `updateHandler` into the single fields
 *   `disable()` had just nulled, so the feature the user switched off went on
 *   recording with no handle left to stop it by, and a character switch left the
 *   departing character's pair orphaned under the arriving character's.
 *
 * The production route into the first is the one `setupSettingListener()`
 * documents: a character switch fans `character_switched` out before the
 * settings cache reloads, so `initialize()` starts on the schema default
 * (`true`) and `onSettingsLoaded` calls `disable()` a moment later — while the
 * load is still in flight. `disable()` does not bump `_generation`, so
 * `load()`'s own character/generation guard sees nothing wrong and runs to
 * completion; only the ownership ticket catches this.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park load() inside its final (baselines) read */
    gate: null,
    characterId: 'char1',
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
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? structuredClone(map.get(key)) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            // The baselines read is the last one load() makes; parking there
            // means the whole load is in flight when the teardown lands.
            if (world.gate && key.startsWith('tradeLedgerState_')) await world.gate;
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
        tryGetAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        putAll: vi.fn(async (store, entries) => {
            for (const [key, value] of Object.entries(entries)) storeFor(store).set(key, structuredClone(value));
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

const dataManagerMock = vi.hoisted(() => {
    const handlers = {};
    return {
        handlers,
        characterData: { ok: true },
        listings: [],
        on: (event, handler) => {
            (handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
        },
        /** Fires the module-level `character_switched` subscription taken at import. */
        _emit: (event, data) => Promise.all((handlers[event] || []).map((handler) => handler(data))),
        getMarketListings: () => dataManagerMock.listings,
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
    };
});

const configMock = vi.hoisted(() => ({
    enabled: true,
    loadedCallbacks: [],
    /** Stand in for loadSettings() finishing after the switch has already re-initialised. */
    fireSettingsLoaded() {
        for (const cb of configMock.loadedCallbacks) cb();
    },
}));

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => configMock.enabled,
        onSettingChange: () => {},
        onSettingsLoaded: (cb) => {
            configMock.loadedCallbacks.push(cb);
            return () => {};
        },
    },
}));

const { default: tradeLedgerStore, recordKey, bucketOf } = await import('./trade-ledger-store.js');

const LEDGER = () => storageMock.storeFor('marketListings');
const stateKey = (charId) => `tradeLedgerState_${charId}`;
const markerKey = (charId) => `tradeLedgerRecordsSplit_${charId}`;
const liveCount = (event) => (dataManagerMock.handlers[event] || []).length;

/**
 * A stored baseline for one open listing.
 * @param {number} filledQuantity - Cumulative fill count already observed
 * @returns {Object} Baseline entry
 */
const baseline = (filledQuantity) => ({
    filledQuantity,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    price: 100,
    isSell: true,
});

/**
 * A wire listing.
 * @param {number} id - Listing id
 * @param {number} filledQuantity - Cumulative fill count
 * @returns {Object} Listing
 */
const listing = (id, filledQuantity) => ({
    id,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    price: 100,
    isSell: true,
    quantity: 50,
    filledQuantity,
    status: '/market_listing_status/active',
});

/**
 * Seed one character's stored ledger: split already done, two open baselines.
 * @param {string} charId - Whose ledger
 * @returns {void}
 */
function seedCharacter(charId) {
    LEDGER().set(markerKey(charId), { at: 1, records: 0 });
    LEDGER().set(stateKey(charId), { 1: baseline(0), 2: baseline(0) });
    LEDGER().set(recordKey(charId, bucketOf({ t: Date.UTC(2026, 0, 1) })), []);
}

/** Let the parked load() actually reach its gated read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a teardown landing inside the ledger load', () => {
    beforeEach(() => {
        tradeLedgerStore.disable();
        for (const store of storageMock.stores.values()) store.clear();
        for (const key of Object.keys(dataManagerMock.handlers)) {
            if (key !== 'character_switched') dataManagerMock.handlers[key] = [];
        }
        world.gate = null;
        world.characterId = 'char1';
        configMock.enabled = true;
        configMock.loadedCallbacks.length = 0;
        dataManagerMock.listings = [];
        dataManagerMock.characterData = { ok: true };
        tradeLedgerStore.records = [];
        tradeLedgerStore.states = {};
        tradeLedgerStore.isLoaded = false;
        tradeLedgerStore.setupSettingListener();
        seedCharacter('char1');
        seedCharacter('char2');
    });

    afterEach(() => {
        tradeLedgerStore.disable();
    });

    /**
     * Start an initialize() whose baselines read is held open, run `teardown`
     * inside it, then let the read land.
     * @param {Function} teardown - What happens mid-read
     * @returns {Promise<void>} Resolves once both the interrupted call and the teardown have finished
     */
    async function tearDownDuringInitialize(teardown) {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = tradeLedgerStore.initialize();
        await settle();
        // Later reads must not park, or the teardown's own re-init deadlocks
        world.gate = null;
        const torn = teardown();
        release();
        await pending;
        await torn;
    }

    test('the interrupted initialize registers no handlers on the way out', async () => {
        // The production shape: the switch's re-init read the schema default,
        // and the real (off) value arrives while the load is still in flight
        await tearDownDuringInitialize(() => {
            configMock.enabled = false;
            configMock.fireSettingsLoaded();
        });

        expect(liveCount('character_initialized')).toBe(0);
        expect(liveCount('market_listings_updated')).toBe(0);
        expect(tradeLedgerStore.initHandler).toBe(null);
        expect(tradeLedgerStore.updateHandler).toBe(null);
        expect(tradeLedgerStore.isInitialized).toBe(false);
    });

    test('no snapshot-mode processListings runs on the resumed tail', async () => {
        // Listing 1 has moved past its baseline and listing 2 has left the
        // wire: a snapshot pass here records a fill and sweeps listing 2's
        // baseline out of the map — a store the user has switched off writing
        // to the user's ledger. This is a separate defect from the handler
        // leak and needs its own guard, ahead of the pass rather than merely
        // ahead of the registrations.
        dataManagerMock.listings = [listing(1, 7)];
        const processListings = vi.spyOn(tradeLedgerStore, 'processListings');

        await tearDownDuringInitialize(() => {
            configMock.enabled = false;
            configMock.fireSettingsLoaded();
        });
        // Let the un-awaited saveRecords/saveStates a snapshot pass fires land
        await settle();

        expect(processListings).not.toHaveBeenCalled();
        // The harm it would have done: a fill invented for a torn-down store,
        // in memory and in the day record…
        expect(tradeLedgerStore.records).toEqual([]);
        expect(LEDGER().get(recordKey('char1', bucketOf({ t: Date.now() }))) ?? []).toEqual([]);
        // …and listing 2's baseline swept out of the map
        expect(Object.keys(tradeLedgerStore.states).sort()).toEqual(['1', '2']);
        processListings.mockRestore();
    });

    test('a character switch leaves the arriving character exactly one removable handler pair', async () => {
        await tearDownDuringInitialize(() => {
            world.characterId = 'char2';
            return dataManagerMock._emit('character_switched');
        });
        // The module-level listener does not return handleCharacterSwitch()'s
        // promise, so the arriving character's re-init is still in flight here
        await settle();

        expect(liveCount('character_initialized')).toBe(1);
        expect(liveCount('market_listings_updated')).toBe(1);

        // …and that pair is the one the next teardown can remove
        tradeLedgerStore.disable();
        expect(liveCount('character_initialized')).toBe(0);
        expect(liveCount('market_listings_updated')).toBe(0);
    });
});
