/**
 * Personal Trade History — persistence of the per-item last buy/sell prices.
 *
 * A failed read must not blank the map, a save must not overwrite prices
 * another tab recorded, and a save that cannot read first must not write.
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
        on: (event, handler) => {
            (handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
        },
        // Fires the module-level 'character_switched' subscription registered
        // when trade-history.js first loaded. Returns a promise so a test can
        // await the (fire-and-forget in production) async handler settling.
        _emit: (event, data) => Promise.all((handlers[event] || []).map((handler) => handler(data))),
        getCurrentCharacterId: () => dataManagerMock.characterId,
    };
});

const configMock = vi.hoisted(() => ({
    tradeHistoryEnabled: true,
    /** Subscribers registered through config.onSettingsLoaded() */
    loadedCallbacks: [],
    /** Stand in for loadSettings() finishing: the map is populated and the channel fires. */
    fireSettingsLoaded() {
        for (const cb of configMock.loadedCallbacks) cb();
    },
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => configMock.tradeHistoryEnabled,
        onSettingChange: () => {},
        onSettingsLoaded: (cb) => {
            configMock.loadedCallbacks.push(cb);
            return () => {};
        },
    },
}));

const { default: tradeHistory, mergeHistory, pruneHistory } = await import('./trade-history.js');

const KEY = 'tradeHistory_market123';
const stored = () => storageMock.storeFor('settings').get(KEY);

/**
 * A filled order, as `market_listings_updated` reports it.
 * @param {string} itemHrid - Item
 * @param {boolean} isSell - Side
 * @param {number} price - Price
 * @returns {Object} Order
 */
const order = (itemHrid, isSell, price) => ({ itemHrid, enhancementLevel: 0, isSell, price, filledQuantity: 1 });

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    dataManagerMock.characterId = 'market123';
    configMock.tradeHistoryEnabled = true;
    tradeHistory.characterId = 'market123';
    tradeHistory.history = {};
    tradeHistory.isLoaded = false;
    tradeHistory.isInitialized = false;
    tradeHistory._saveChain = null;
    tradeHistory._cancelScheduledSave();
    for (const fn of [storageMock.getJSON, storageMock.setJSON, storageMock.tryGet]) fn.mockClear();
});

describe('mergeHistory', () => {
    test('folds per item and per side, the fresh side winning', () => {
        expect(
            mergeHistory(
                { '/items/a:0': { buy: 1, sell: 2 }, '/items/b:0': { sell: 5 } },
                { '/items/a:0': { buy: 3 }, '/items/c:0': { buy: 7 } }
            )
        ).toEqual({ '/items/a:0': { buy: 3, sell: 2 }, '/items/b:0': { sell: 5 }, '/items/c:0': { buy: 7 } });
        expect(mergeHistory(null, [])).toEqual({});
    });
});

describe('pruneHistory', () => {
    test('leaves a map that fits alone', () => {
        const small = { a: { buy: 1 }, b: { sell: 2 } };
        expect(pruneHistory(small)).toBe(small);
        expect(pruneHistory(undefined)).toBeUndefined();
    });

    test('drops the longest-ago entries once the map is over the cap', () => {
        const big = {};
        for (let i = 0; i < 4100; i++) big[`/items/i${i}:0`] = { buy: i };

        const pruned = pruneHistory(big);

        expect(Object.keys(pruned)).toHaveLength(4000);
        expect(pruned['/items/i0:0']).toBeUndefined();
        expect(pruned['/items/i99:0']).toBeUndefined();
        expect(pruned['/items/i100:0']).toEqual({ buy: 100 });
        expect(pruned['/items/i4099:0']).toEqual({ buy: 4099 });
    });
});

describe('saves are gathered rather than made per fill', () => {
    test('a burst of fills produces one read-merge-write', async () => {
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/a', true, 1)] });
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/b', true, 2)] });
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', false, 3)] });
        expect(storageMock.setJSON).not.toHaveBeenCalled();

        await tradeHistory.flushSave();

        expect(storageMock.setJSON).toHaveBeenCalledTimes(1);
        expect(storageMock.tryGet).toHaveBeenCalledTimes(1);
        expect(stored()).toEqual({
            '/items/a:0': { sell: 1 },
            '/items/b:0': { sell: 2 },
            '/items/c:0': { buy: 3 },
        });
    });

    test('a fill with no enhancementLevel on the wire is keyed the same as a lookup for level 0', async () => {
        // Most non-equipment orders come back with enhancementLevel omitted rather
        // than explicitly 0; the write key must normalize like every reader does.
        tradeHistory.handleMarketUpdate({
            endMarketListings: [{ itemHrid: '/items/a', isSell: true, price: 5, filledQuantity: 1 }],
        });

        expect(tradeHistory.getHistory('/items/a', 0)).toEqual({ sell: 5 });
        expect(tradeHistory.getHistory('/items/a')).toEqual({ sell: 5 });
    });
});

describe('the history cannot be wiped by a failed read or a stale copy', () => {
    test('a load while storage is unavailable keeps the in-memory map rather than blanking it', async () => {
        tradeHistory.history = { '/items/a:0': { buy: 10 } };
        storageMock.unavailable = true;

        await tradeHistory.loadHistory();

        expect(tradeHistory.history).toEqual({ '/items/a:0': { buy: 10 } });
        expect(tradeHistory.isLoaded).toBe(true);
    });

    test('a load folds what is stored under what is in memory', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1, sell: 2 } });
        tradeHistory.history = { '/items/a:0': { buy: 3 } };

        await tradeHistory.loadHistory();

        expect(tradeHistory.history).toEqual({ '/items/a:0': { buy: 3, sell: 2 } });
        expect(tradeHistory.getHistory('/items/a')).toEqual({ buy: 3, sell: 2 });
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored map', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 } });
        // The failure mode that used to wipe histories: memory emptied by a
        // failed load, then a fill saves that emptiness back
        tradeHistory.history = {};
        storageMock.unavailable = true;

        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', true, 9)] });
        await tradeHistory.flushSave();

        expect(stored()).toEqual({ '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 } });
        expect(storageMock.setJSON).not.toHaveBeenCalled();
        expect(tradeHistory.getHistory('/items/c')).toEqual({ sell: 9 });
    });

    test('a save merges what is stored under what is in memory, so rows from another writer survive', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1, sell: 2 }, '/items/b:0': { sell: 5 } });
        tradeHistory.history = { '/items/a:0': { buy: 3 } };

        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', false, 7)] });
        await tradeHistory.flushSave();

        expect(stored()).toEqual({
            '/items/a:0': { buy: 3, sell: 2 },
            '/items/b:0': { sell: 5 },
            '/items/c:0': { buy: 7 },
        });
        expect(tradeHistory.history).toEqual(stored());
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1 } });
        storageMock.unavailable = true;
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/b', true, 2)] });
        await tradeHistory.flushSave();
        expect(stored()).toEqual({ '/items/a:0': { buy: 1 } });

        storageMock.unavailable = false;
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', false, 3)] });
        await tradeHistory.flushSave();

        expect(stored()).toEqual({ '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 }, '/items/c:0': { buy: 3 } });
    });
});

describe('a load that settles after a second switch', () => {
    test("the departing character's prices are not merged into the arriving one", async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 111 } });
        tradeHistory.history = {};
        tradeHistory.isLoaded = false;

        // The probe was issued for market123, and by the time it answers this
        // module's own (unserialised) switch handling has already re-pointed
        // the singleton at the iron cow
        storageMock.tryGet.mockImplementationOnce(async (key, storeName = 'settings') => {
            dataManagerMock.characterId = 'iron456';
            tradeHistory.characterId = 'iron456';
            const store = storageMock.storeFor(storeName);
            return store.has(key)
                ? { found: true, value: structuredClone(store.get(key)) }
                : { found: false, value: null };
        });

        await tradeHistory.loadHistory();

        // Merging them would put the market character's reference prices on
        // every iron-cow tooltip, and the next fill writes them into
        // tradeHistory_iron456 for good
        expect(tradeHistory.history).toEqual({});
        // And the flag stays down, so a fill cannot write before the iron cow's
        // own history has been read back
        expect(tradeHistory.isLoaded).toBe(false);
    });
});

describe('a load that settles in the gap before characterId catches up', () => {
    test('the guard checks the live character, not the lagging field', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 111 } });
        tradeHistory.history = {};
        tradeHistory.isLoaded = false;

        // The probe was issued for market123. By the time it answers a switch has
        // settled, so getCurrentCharacterId() already names the iron cow — but
        // handleCharacterSwitch() is still parked on `await this._saveChain` and has
        // not reached initialize(), so tradeHistory.characterId still lags at
        // market123. The old guard compared that lagging field and would pass.
        storageMock.tryGet.mockImplementationOnce(async (key, storeName = 'settings') => {
            dataManagerMock.characterId = 'iron456';
            const store = storageMock.storeFor(storeName);
            return store.has(key)
                ? { found: true, value: structuredClone(store.get(key)) }
                : { found: false, value: null };
        });

        await tradeHistory.loadHistory();

        // Merging would put market123's reference prices onto the iron cow, and the
        // next fill would write them into tradeHistory_iron456 for good.
        expect(tradeHistory.history).toEqual({});
        // And the flag stays down, so a fill cannot write before the iron cow's own
        // history has been read back.
        expect(tradeHistory.isLoaded).toBe(false);
    });
});

describe('a character switch resets in-memory state even while the feature is off', () => {
    test('toggling off, switching character, then back on does not merge the old character under the new one', async () => {
        // Character A has a price in memory (as if the feature had been on for them).
        tradeHistory.history = { '/items/a:0': { buy: 1 } };
        tradeHistory.isLoaded = true;

        // The player disables the setting, still on character A.
        configMock.tradeHistoryEnabled = false;
        tradeHistory.disable();
        expect(tradeHistory.history).toEqual({ '/items/a:0': { buy: 1 } });

        // They switch to character B while the feature is off. Before the fix,
        // the module's character_switched listener skipped handleCharacterSwitch()
        // whenever the setting was off, so nothing here was cleared.
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');

        // Re-enabling now must not let character A's price survive into B's history.
        configMock.tradeHistoryEnabled = true;
        await tradeHistory.initialize();

        expect(tradeHistory.history['/items/a:0']).toBeUndefined();
    });
});

/** Let the fire-and-forget character-switch handler run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a character who has trade history off stays off across a switch', () => {
    test('the schema default read inside the settings-reload window is corrected once settings load', async () => {
        // The switch sequence: feature-registry clears the settings cache on
        // `character_switching`, then `character_switched` fans out to this
        // module's import-time listener — all before feature-registry's own
        // step calls config.loadSettings(). Inside that window getSetting()
        // answers from SCHEMA_DEFAULTS, which is `true` here, so initialize()
        // runs for a character who has the feature switched off.
        dataManagerMock.characterId = 'iron456';
        configMock.tradeHistoryEnabled = true; // the schema default standing in for the empty map
        await dataManagerMock._emit('character_switched');
        // The production listener does not return the promise, so the switch
        // settles a few microtasks later.
        await settle();
        expect(tradeHistory.isInitialized).toBe(true);

        // Settings finish loading and this character's real value is `false`.
        // loadSettings() fires no per-key change callback on a switch (the
        // previous map was empty), and initialize()'s isInitialized
        // short-circuit means a later re-init corrects nothing either — the
        // settings-loaded channel is the only signal that arrives.
        configMock.tradeHistoryEnabled = false;
        configMock.fireSettingsLoaded();

        expect(tradeHistory.isInitialized).toBe(false);

        // …and with the handler gone, a market update records no price.
        await dataManagerMock._emit('market_listings_updated', { myMarketListings: [order('/items/a', true, 42)] });
        expect(tradeHistory.history).toEqual({});
    });

    test('a character who has it on is left initialized', async () => {
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');
        await settle();
        configMock.fireSettingsLoaded();
        expect(tradeHistory.isInitialized).toBe(true);
    });
});
