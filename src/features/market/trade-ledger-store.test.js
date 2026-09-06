/**
 * Trade Ledger Store — persistence of fill records and listing baselines.
 *
 * The diffing itself is covered in `src/utils/trade-ledger.test.js`; this is
 * about the store not losing what it has recorded: a failed read must not
 * blank the ledger, a save must not overwrite another writer's rows, a save
 * that cannot read first must not write at all — and, since the fills moved
 * from one array to one record per day, a fill must write only its own day,
 * and the single key must be split once and folded back in if it reappears.
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
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? structuredClone(map.get(key)) : fallback;
        }),
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        putAll: vi.fn(async (store, entries) => {
            if (storageMock.unavailable) return 0;
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
        characterId: 'market123',
        characterData: null,
        on: (event, handler) => {
            (handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
        },
        // Fires the module-level 'character_switched' subscription registered
        // when trade-ledger-store.js first loaded — not a re-subscription.
        // Returns a promise so a test can await the (fire-and-forget in
        // production) async handler settling.
        _emit: (event, data) => Promise.all((handlers[event] || []).map((handler) => handler(data))),
        getMarketListings: () => [],
        getCurrentCharacterId: () => dataManagerMock.characterId,
        getCurrentCharacterGameMode: () => 'standard',
    };
});

const configMock = vi.hoisted(() => ({
    tradeLedgerEnabled: true,
    /** Subscribers registered through config.onSettingsLoaded() */
    loadedCallbacks: [],
    /** Stand in for loadSettings() finishing: the map is populated and the channel fires. */
    fireSettingsLoaded() {
        for (const cb of configMock.loadedCallbacks) cb();
    },
}));

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => configMock.tradeLedgerEnabled,
        onSettingChange: () => {},
        onSettingsLoaded: (cb) => {
            configMock.loadedCallbacks.push(cb);
            return () => {};
        },
    },
}));

const {
    default: tradeLedgerStore,
    fillKey,
    mergeRecords,
    mergeStates,
    bucketOf,
    recordKey,
    MIGRATION_TIMEOUT_MS,
} = await import('./trade-ledger-store.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
const { LEDGER_RECORD_CAP } = await import('../../utils/trade-ledger.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

const RECORDS_KEY = 'tradeLedgerRecords_market123';
const MARKER_KEY = 'tradeLedgerRecordsSplit_market123';
const STATE_KEY = 'tradeLedgerState_market123';
const LEDGER = () => storageMock.storeFor('marketListings');
/** The day record a fill at `t` lives in */
const REC = (t) => recordKey('market123', bucketOf({ t }));
/** Every day-record key in the store, sorted */
const recordKeys = () => [...LEDGER().keys()].filter((key) => key.startsWith('tradeLedgerRec_')).sort();

/** Midnight UTC of three distinct days, so fills fall in three day records */
const DAY1 = Date.UTC(2026, 0, 1);
const DAY2 = Date.UTC(2026, 0, 2);
const DAY3 = Date.UTC(2026, 0, 3);

/**
 * A fill record of listing `listingId` at time `t`.
 * @param {number} listingId - Listing id
 * @param {number} t - Timestamp
 * @param {Object} extra - Overrides
 * @returns {Object} Fill record
 */
const fill = (listingId, t, extra = {}) => ({
    t,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    side: 'sell',
    quantity: 5,
    price: 100,
    coins: 475,
    listingId,
    ...extra,
});

/**
 * A wire listing.
 * @param {number} id - Listing id
 * @param {number} filledQuantity - Cumulative fill count
 * @param {Object} extra - Overrides
 * @returns {Object} Listing
 */
const listing = (id, filledQuantity, extra = {}) => ({
    id,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    filledQuantity,
    price: 100,
    isSell: true,
    status: '/market_listing_status/active',
    ...extra,
});

/** A baseline for listing 3 at zero filled, so its next update is a fill */
const baseline3 = () => ({
    3: { filledQuantity: 0, itemHrid: '/items/a', enhancementLevel: 0, price: 100, isSell: true },
});

/** Set the in-memory ledger directly. */
const memory = (records, states) => {
    tradeLedgerStore.records = records;
    tradeLedgerStore.states = states;
    tradeLedgerStore.isLoaded = true;
};

/** Seed the store as it looks after the split: day records plus the marker */
const seedSplit = (records) => {
    const byKey = new Map();
    for (const record of records) {
        const key = REC(record.t);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(record);
    }
    for (const [key, bucket] of byKey) LEDGER().set(key, bucket);
    LEDGER().set(MARKER_KEY, { at: 1, records: records.length });
};

const awaitSaves = async () => {
    await tradeLedgerStore._recordsChain;
    await tradeLedgerStore._statesChain;
};

/** A fill of listing 3 by `quantity` at `now`, through the wire path */
const fillNow = (now, filledQuantity = 4) => {
    vi.setSystemTime(now);
    tradeLedgerStore.processListings([listing(3, filledQuantity)], false);
};

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    configMock.tradeLedgerEnabled = true;
    tradeLedgerStore.records = [];
    tradeLedgerStore.states = {};
    tradeLedgerStore.isLoaded = false;
    tradeLedgerStore.isInitialized = false;
    tradeLedgerStore._legacy = false;
    tradeLedgerStore._recordsChain = null;
    tradeLedgerStore._statesChain = null;
    for (const fn of [
        storageMock.get,
        storageMock.set,
        storageMock.getJSON,
        storageMock.setJSON,
        storageMock.tryGet,
        storageMock.putAll,
        storageMock.delete,
    ])
        fn.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(DAY3);
});

describe('fill record identity', () => {
    test('fillKey is listing, time and quantity', () => {
        expect(fillKey(fill(7, 1000, { quantity: 3 }))).toBe('7|1000|3');
    });

    test('mergeRecords keeps rows only one side has, lets the fresh side win a clash, and caps', () => {
        const merged = mergeRecords(
            [fill(1, 1000), fill(2, 2000, { price: 1 })],
            [fill(2, 2000, { price: 2 }), fill(3, 500)]
        );
        expect(merged.map((r) => r.listingId)).toEqual([3, 1, 2]);
        expect(merged.find((r) => r.listingId === 2).price).toBe(2);

        const many = Array.from({ length: LEDGER_RECORD_CAP + 5 }, (_, i) => fill(i, i));
        expect(mergeRecords(many, [fill(999999, LEDGER_RECORD_CAP + 10)])).toHaveLength(LEDGER_RECORD_CAP);
    });

    test('mergeStates folds by listing id with memory winning', () => {
        expect(
            mergeStates({ 1: { filledQuantity: 1 }, 2: { filledQuantity: 5 } }, { 2: { filledQuantity: 9 } })
        ).toEqual({ 1: { filledQuantity: 1 }, 2: { filledQuantity: 9 } });
        expect(mergeStates(null, undefined)).toEqual({});
    });

    test('a fill belongs to its UTC day', () => {
        expect(bucketOf(fill(1, DAY2 + 5 * 60 * 60 * 1000))).toBe('2026-01-02');
        expect(recordKey('market123', '2026-01-02')).toBe('tradeLedgerRec_market123_2026-01-02');
    });

    test('both the single key and the day records are registered as merges for a sync pull', () => {
        expect(mergeForKey('marketListings', RECORDS_KEY)?.merge).toBe(mergeRecords);
        expect(mergeForKey('marketListings', REC(DAY1))?.merge).toBe(mergeRecords);
    });
});

describe('splitting the single key into day records', () => {
    test('the first load splits the single key by day, writes the marker and removes the key', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1), fill(2, DAY2 + 1000), fill(3, DAY2 + 2000)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2, 3]);
        expect(recordKeys()).toEqual([REC(DAY1), REC(DAY2)]);
        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([2, 3]);
        expect(LEDGER().get(MARKER_KEY)).toMatchObject({ records: 3 });
        expect(LEDGER().has(RECORDS_KEY)).toBe(false);
    });

    test('a character with nothing stored gets the marker and no records', async () => {
        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toEqual([]);
        expect(LEDGER().has(MARKER_KEY)).toBe(true);
        expect(recordKeys()).toEqual([]);
    });

    test('a split that cannot be written leaves the single key as the record', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        storageMock.putAll.mockImplementationOnce(async () => 0);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(true);
        expect(LEDGER().has(MARKER_KEY)).toBe(false);

        // Saves keep going to the single key, read-merge-written as before
        memory(tradeLedgerStore.records, baseline3());
        fillNow(DAY3);
        await awaitSaves();
        expect(
            LEDGER()
                .get(RECORDS_KEY)
                .map((r) => r.listingId)
        ).toEqual([1, 3]);
        expect(recordKeys()).toEqual([]);
    });

    test('a split whose write never settles gives up and keeps the single key', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        // A write that neither resolves nor rejects: the quota-abort hang this
        // load used to inherit, which stalls every feature initialized after it
        storageMock.putAll.mockImplementationOnce(() => new Promise(() => {}));

        const loading = tradeLedgerStore.load();
        await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 10);
        await loading;

        expect(tradeLedgerStore._legacy).toBe(true);
        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(true);
        expect(LEDGER().has(MARKER_KEY)).toBe(false);
    });

    test('absorbing a returned single key that never settles does not stall the load', async () => {
        seedSplit([fill(1, DAY1)]);
        LEDGER().set(RECORDS_KEY, [fill(2, DAY2)]);
        storageMock.putAll.mockImplementationOnce(() => new Promise(() => {}));

        const loading = tradeLedgerStore.load();
        await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 10);
        await loading;

        // The load finished and the returned key's fills are in memory either way
        expect(tradeLedgerStore.records.map((r) => r.listingId).sort()).toEqual([1, 2]);
        expect(tradeLedgerStore.isLoaded).toBe(true);
    });

    test('a later load reads the day records and does not look for a legacy value to adopt', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        // The pre-scoping bare key: without the marker this would be offered for adoption
        LEDGER().set('tradeLedgerRecords', [fill(9, DAY1)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2]);
        expect(LEDGER().has('tradeLedgerRecords')).toBe(true);
    });

    test('a single key that comes back after the split is folded into the day records and removed', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        // An older tab, or a sync pull from a device on the old layout, wrote it again
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1), fill(5, DAY2 + 500)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2, 5]);
        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([2, 5]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(false);
    });
});

describe('a fill writes its own day and nothing else', () => {
    test("a fill today writes today's record only", async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();
        storageMock.set.mockClear();

        fillNow(DAY3);
        await awaitSaves();

        const written = storageMock.set.mock.calls
            .map(([key]) => key)
            .filter((key) => key.startsWith('tradeLedgerRec_'));
        expect(written).toEqual([REC(DAY3)]);
        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([3]);
        expect(LEDGER().get(REC(DAY1))).toHaveLength(1);
        // Not immediate: the debounce is what coalesces a burst of fills
        expect(storageMock.set.mock.calls.find(([key]) => key === REC(DAY3))[3]).not.toBe(true);
    });

    test('the cap shrinks the oldest day record and then removes it', async () => {
        const older = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP - 2 }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...older, ...day2]);
        await tradeLedgerStore.load();
        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        tradeLedgerStore.states = baseline3();

        fillNow(DAY3, 4);
        await awaitSaves();
        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        expect(
            LEDGER()
                .get(REC(DAY1))
                .map((r) => r.listingId)
        ).toEqual([2]);

        fillNow(DAY3 + 1000, 6);
        await awaitSaves();
        expect(LEDGER().has(REC(DAY1))).toBe(false);
        expect(LEDGER().get(REC(DAY3))).toHaveLength(2);
    });

    test('day records the cap dropped before this save are deleted, not left behind', async () => {
        // DAY1 falls off the cap entirely on load, so no later save ever names
        // it — only a sweep by key can remove it
        const day1 = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...day1, ...day2]);
        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        expect(tradeLedgerStore.records.some((r) => r.listingId === 1)).toBe(false);
        expect(LEDGER().has(REC(DAY1))).toBe(true);

        tradeLedgerStore.states = baseline3();
        fillNow(DAY3, 4);
        await awaitSaves();

        expect(LEDGER().has(REC(DAY1))).toBe(false);
        expect(LEDGER().has(REC(DAY2))).toBe(true);
    });

    test('no sweep happens while the ledger is below the cap', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();
        storageMock.getAllKeys.mockClear();

        fillNow(DAY3, 4);
        await awaitSaves();

        expect(storageMock.getAllKeys).not.toHaveBeenCalled();
        expect(LEDGER().has(REC(DAY1))).toBe(true);
    });
});

describe('the ledger cannot be wiped by a failed read or a stale copy', () => {
    test('a load while storage is unavailable keeps the in-memory ledger rather than blanking it', async () => {
        memory([fill(1, DAY1)], { 1: { filledQuantity: 5 } });
        storageMock.unavailable = true;

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 } });
        expect(tradeLedgerStore.isLoaded).toBe(true);
    });

    test('a load folds what is stored under what is in memory', async () => {
        seedSplit([fill(1, DAY1)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 }, 2: { filledQuantity: 1 } });
        memory([fill(2, DAY2)], { 2: { filledQuantity: 3 } });

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 }, 2: { filledQuantity: 3 } });
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored ledger', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY3)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 } });
        // The failure mode that used to wipe ledgers: memory emptied by a
        // failed load, then a fill saves that emptiness back
        memory([], baseline3());
        storageMock.unavailable = true;

        fillNow(DAY3 + 1000);
        await awaitSaves();

        expect(tradeLedgerStore.records).toHaveLength(1);
        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([2]);
        expect(LEDGER().get(STATE_KEY)).toEqual({ 1: { filledQuantity: 5 } });
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test("a save merges what is stored under what is in memory, so another writer's rows in that day survive", async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY3, { price: 1 })]);
        LEDGER().set(STATE_KEY, { 9: { filledQuantity: 2 } });
        memory([fill(2, DAY3, { price: 2 })], baseline3());

        fillNow(DAY3 + 1000);
        await awaitSaves();

        const stored = LEDGER().get(REC(DAY3));
        expect(stored.map((r) => r.listingId)).toEqual([2, 3]);
        // Memory's copy wins on the clash
        expect(stored.find((r) => r.listingId === 2).price).toBe(2);
        // A row this tab never loaded is still only on the other day's record; it is not touched
        expect(LEDGER().get(REC(DAY1))).toHaveLength(1);
        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([2, 3]);
        expect(Object.keys(LEDGER().get(STATE_KEY)).sort()).toEqual(['3', '9']);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(4);
    });

    test('rows only storage knew in the day written come into memory', async () => {
        seedSplit([fill(7, DAY3 + 10)]);
        memory([], baseline3());

        fillNow(DAY3 + 1000);
        await awaitSaves();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([7, 3]);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        seedSplit([fill(1, DAY1)]);
        memory([], baseline3());
        storageMock.unavailable = true;
        fillNow(DAY3 + 1000, 4);
        await awaitSaves();
        expect(LEDGER().has(REC(DAY3))).toBe(false);

        storageMock.unavailable = false;
        fillNow(DAY3 + 2000, 6);
        await awaitSaves();

        const stored = LEDGER().get(REC(DAY3));
        expect(stored.map((r) => r.listingId)).toEqual([3, 3]);
        expect(stored.map((r) => r.quantity)).toEqual([4, 2]);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(6);
    });

    test('getRecords hands out copies', () => {
        memory([fill(1, 1000)], {});
        const copy = tradeLedgerStore.getRecords();
        copy[0].price = 0;
        expect(tradeLedgerStore.records[0].price).toBe(100);
    });
});

describe('a character switch resets in-memory state even while the feature is off', () => {
    test('toggling off, switching character, then back on does not merge the old character under the new one', async () => {
        // Character A has a fill in memory (as if the feature had been on for them).
        memory([fill(1, DAY3)], {});

        // The player disables the setting, still on character A.
        configMock.tradeLedgerEnabled = false;
        tradeLedgerStore.disable();
        expect(tradeLedgerStore.records).toHaveLength(1);

        // They switch to character B while the feature is off. Before the fix,
        // the module's character_switched listener skipped handleCharacterSwitch()
        // whenever the setting was off, so nothing here was cleared.
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');

        // Re-enabling now must not let character A's fill survive into B's ledger.
        configMock.tradeLedgerEnabled = true;
        await tradeLedgerStore.initialize();

        expect(tradeLedgerStore.records.some((r) => r.listingId === 1)).toBe(false);
    });
});

describe('a character who has the ledger off stays off across a switch', () => {
    test('the schema default read inside the settings-reload window is corrected once settings load', async () => {
        // The switch sequence: feature-registry clears the settings cache on
        // `character_switching`, then `character_switched` fans out to this
        // module's import-time listener — all before feature-registry's own
        // step calls config.loadSettings(). Inside that window getSetting()
        // answers from SCHEMA_DEFAULTS, which is `true` for the ledger, so
        // initialize() runs for a character who has it switched off.
        dataManagerMock.characterId = 'iron456';
        configMock.tradeLedgerEnabled = true; // the schema default standing in for the empty map
        await dataManagerMock._emit('character_switched');
        expect(tradeLedgerStore.isInitialized).toBe(true);

        // Settings finish loading and this character's real value is `false`.
        // loadSettings() fires no per-key change callback on a switch (the
        // previous map was empty), and initialize()'s isInitialized
        // short-circuit means a later re-init corrects nothing either — the
        // settings-loaded channel is the only signal that arrives.
        configMock.tradeLedgerEnabled = false;
        configMock.fireSettingsLoaded();

        expect(tradeLedgerStore.isInitialized).toBe(false);

        // …and with the handlers gone, a market update records nothing.
        await dataManagerMock._emit('market_listings_updated', { myMarketListings: [listing(3, 4)] });
        expect(tradeLedgerStore.getRecords()).toEqual([]);
    });

    test('a character who has it on is left initialized', async () => {
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');
        configMock.fireSettingsLoaded();
        expect(tradeLedgerStore.isInitialized).toBe(true);
    });
});

describe('a character switch landing inside a load or a save', () => {
    // Every key in load()/saveStates() used to be rebuilt by characterKey() at
    // the moment it was needed, so a switch arriving between two reads gave the
    // marker, the day records, the single key and the baselines different
    // owners. The keys are built from a character captured before the first
    // read now, and the work stands down when that character has moved on.
    const IRON = 'iron456';

    test('the split marks the character it read, not the one who arrived mid-write', async () => {
        // Both characters are still on the pre-split single key.
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        LEDGER().set(`tradeLedgerRecords_${IRON}`, [fill(2, DAY2)]);

        const putAll = storageMock.putAll.getMockImplementation();
        storageMock.putAll.mockImplementationOnce(async (store, entries) => {
            dataManagerMock.characterId = IRON;
            return putAll(store, entries);
        });

        await tradeLedgerStore.load();

        // The iron cow's un-migrated ledger must still be there, and unmarked:
        // a marker over an empty set of day records loses it for good.
        expect(LEDGER().get(`tradeLedgerRecords_${IRON}`)).toEqual([fill(2, DAY2)]);
        expect(LEDGER().has(`tradeLedgerRecordsSplit_${IRON}`)).toBe(false);
        expect(LEDGER().has(MARKER_KEY)).toBe(true);
    });

    test('a load that began under one character does not adopt their fills into the arriving one', async () => {
        seedSplit([fill(1, DAY1)]);

        const getAllKeys = storageMock.getAllKeys.getMockImplementation();
        storageMock.getAllKeys.mockImplementationOnce(async (store) => {
            dataManagerMock.characterId = IRON;
            return getAllKeys(store);
        });

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toEqual([]);
        expect(tradeLedgerStore.isLoaded).toBe(false);
    });

    test('a save that began under one character does not write their baselines under another', async () => {
        memory([], baseline3());

        const tryGet = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementationOnce(async (key, store) => {
            const probe = await tryGet(key, store);
            dataManagerMock.characterId = IRON;
            return probe;
        });

        await tradeLedgerStore.saveStates();

        expect(LEDGER().has(`tradeLedgerState_${IRON}`)).toBe(false);
    });
});

/**
 * The day records share `marketListings` with account-wide market caches, so
 * the store's flat 2,000-key budget is not theirs: a four-character account
 * would trip it while no single character was near its own. Registering the
 * prefix is what lets the health panel count them per character and check them
 * against `CHARACTER_FAMILY_BUDGETS`.
 */
describe('the day records are counted per character', () => {
    test('the record prefix is registered as character-scoped', async () => {
        const { maxRecordsPerCharacter } = await import('../../utils/chunked-history.js');

        const keys = [
            'tradeLedgerRec_char-1_2026-09-01',
            'tradeLedgerRec_char-1_2026-09-02',
            'tradeLedgerRec_char-1_2026-09-03',
            'tradeLedgerRec_char-2_2026-09-01',
            // Not a day record: the pre-split single key and the split marker
            'tradeLedgerRecords_char-1',
            'tradeLedgerRecordsSplit_char-1',
            // Account-wide, and no character's to carry
            'orderBooksCache',
        ];

        expect(maxRecordsPerCharacter('marketListings', keys)).toBe(3);
    });
});
