/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing Estimated Listing Age down while its
 * `initialize()` is parked on the listing-log read.
 *
 * `isInitialized` is set *before* two storage reads, so a `disableAllFeatures()`
 * landing inside the first one leaves the suspended call to resume into a module
 * the teardown has already emptied. Two separate things went wrong there, and a
 * test for one of them passes while the other is still broken:
 *
 * - **Registration.** The tail runs `setupWebSocketListeners()`,
 *   `setupObserver()` and `setupMyListingsObserver()` unconditionally, each
 *   refilling a *single* `unregisterWebSocket` / `unregisterObserver` /
 *   `unregisterMyListingsObserver` field that `disable()` has just nulled. The
 *   arriving character's own `initialize()` then overwrites those handles, so
 *   the stray registrations can never be removed — one live WebSocket hook and
 *   two live DOM observers per interrupted switch, for the life of the tab.
 *   This is the networth bug of 55ac400f9 exactly.
 *
 * - **Data.** `loadHistoricalData()` was already guarded by the module's own
 *   `_owner()` ticket; `loadOrderBooksCache()` was not. It assigns
 *   `this.orderBooksCache` from storage — the cache `disable()`'s `finally`
 *   empties on purpose, because the arriving character must not inherit it — so
 *   the resumed tail put the departing character's books back, on top of
 *   whatever the arriving character had already cached live. Those books feed
 *   `cachedTopOfBook` / `cachedBookSide`, which is what the trade-ledger marks,
 *   the guild-credit valuation and the marketplace autofill price all read.
 *   A registration count says nothing about this, so it gets its own tests.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /**
     * Held open to park the *first* listing-log read that meets it, and
     * consumed there — the arriving character's own `initialize()` runs while
     * the departing one is still parked, and must not park behind it too.
     */
    gate: null,
    characterId: 'char1',
}));

/** A minimal store, plus a one-shot gate on the read `loadHistoricalData` makes. */
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        storeFor,
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (world.gate) {
                const gate = world.gate;
                world.gate = null;
                await gate;
            }
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
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? structuredClone(map.get(key)) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

/** Live registrations, so leaks are countable. */
const live = vi.hoisted(() => ({
    events: {},
    observers: 0,
}));

const dataManagerMock = vi.hoisted(() => ({
    on: (event, handler) => {
        (live.events[event] ??= []).push(handler);
    },
    off: (event, handler) => {
        live.events[event] = (live.events[event] || []).filter((registered) => registered !== handler);
    },
    getMarketListings: () => [],
    getCurrentCharacterId: () => world.characterId,
    getCurrentCharacterGameMode: () => 'standard',
}));

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => world.characterId,
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            live.observers += 1;
            let removed = false;
            return () => {
                if (removed) return;
                removed = true;
                live.observers -= 1;
            };
        },
    },
}));
// The age column on, so the two display observers are actually installed
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn(), updatePrices: vi.fn() } }));

const estimatedListingAge = (await import('./estimated-listing-age.js')).default;
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const ORDER_BOOKS_KEY = 'marketOrderBooksCache';

/** One item's cached book, in the shape the WebSocket handler stashes. */
const bookFor = (itemHrid, price) => ({
    data: { itemHrid, orderBooks: [{ asks: [{ price, quantity: 1 }], bids: [] }] },
    lastUpdated: Date.now(),
});

/** The three events `setupWebSocketListeners` hooks. */
const WS_EVENTS = ['character_initialized', 'market_listings_updated', 'market_item_order_books_updated'];

/** @returns {number} How many of the module's WebSocket handlers are live */
const liveWsHandlers = () => WS_EVENTS.reduce((total, event) => total + (live.events[event] || []).length, 0);

describe('a character switch landing inside the listing-log read', () => {
    beforeEach(async () => {
        storageMock.reset();
        _resetAdoptionCache?.();
        world.gate = null;
        world.characterId = 'char1';
        live.events = {};
        live.observers = 0;
        await estimatedListingAge.disable();
        live.events = {};
        live.observers = 0;
    });

    afterEach(async () => {
        world.gate = null;
        await estimatedListingAge.disable();
    });

    /**
     * Start an `initialize()` whose listing-log read is held open, tear the
     * feature down inside it the way `disableAllFeatures()` does, then let the
     * read land under the arriving character.
     * @param {Function} [between] - Run after the teardown, before the read lands
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize(between) {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = estimatedListingAge.initialize();
        // `character_switching` — the feature layer comes down mid-read
        await estimatedListingAge.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        _resetAdoptionCache?.();
        if (between) await between();
        release();
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(liveWsHandlers(), 'a WebSocket hook the nulled unregister field can never remove').toBe(0);
        expect(live.observers, 'the order-book and My Listings observers, same story').toBe(0);
    });

    test('the arriving character ends up with exactly one of each registration', async () => {
        await switchDuringInitialize();

        await estimatedListingAge.initialize();

        expect(liveWsHandlers()).toBe(WS_EVENTS.length);
        expect(live.observers).toBe(2);

        // …and a later switch can still take every one of them back down
        await estimatedListingAge.disable();

        expect(liveWsHandlers()).toBe(0);
        expect(live.observers).toBe(0);
    });

    test('the interrupted initialize does not put the departing books back', async () => {
        // What char1 had cached, and what `disable()` empties on purpose
        storageMock.storeFor('marketListings').set(ORDER_BOOKS_KEY, { '/items/milk': bookFor('/items/milk', 100) });

        await switchDuringInitialize();

        expect(
            estimatedListingAge.orderBooksCache,
            "the departing character's order books, reinstated after the teardown that cleared them"
        ).toEqual({});
        expect(estimatedListingAge.cachedTopOfBook('/items/milk')).toBeNull();
    });

    test("the interrupted initialize does not overwrite the arriving character's books", async () => {
        storageMock.storeFor('marketListings').set(ORDER_BOOKS_KEY, { '/items/milk': bookFor('/items/milk', 100) });

        await switchDuringInitialize(async () => {
            // char2 comes up and starts caching its own books from the socket,
            // which the repaint debounce has not persisted yet
            await estimatedListingAge.initialize();
            estimatedListingAge._cacheOrderBook('/items/eggs', {
                itemHrid: '/items/eggs',
                orderBooks: [{ asks: [{ price: 7, quantity: 1 }], bids: [] }],
            });
        });

        expect(
            estimatedListingAge.cachedTopOfBook('/items/eggs'),
            "char1's stale read landed on top of the live cache and took char2's books with it"
        ).toBe(7);
    });
});
