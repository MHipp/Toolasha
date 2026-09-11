/**
 * Market Price Store — the WebSocket/snapshot feed into the price cache.
 * The pure fold/prune math lives in market-prices.test.js; these tests cover
 * the class wiring: which updates get persisted, which get skipped, and how
 * listeners are notified.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const mock = {
        saved: {},
        unavailable: false,
        /** Held open so a test can park a start-up inside its first read */
        gate: null,
        tryGet: vi.fn(async (key) => {
            if (mock.gate) await mock.gate;
            if (mock.unavailable) return null;
            return key in mock.saved
                ? { found: true, value: structuredClone(mock.saved[key]) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value) => {
            if (mock.unavailable) return false;
            mock.saved[key] = structuredClone(value);
            return true;
        }),
    };
    return mock;
});

const dataManagerMock = vi.hoisted(() => ({
    handlers: {},
    /** Every live subscription, so a leaked one is countable */
    live: [],
    on: vi.fn((event, handler) => {
        dataManagerMock.handlers[event] = handler;
        dataManagerMock.live.push({ event, handler });
    }),
    off: vi.fn((event, handler) => {
        dataManagerMock.live = dataManagerMock.live.filter((entry) => entry.handler !== handler);
    }),
    getCurrentCharacterId: () => 'char1',
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: marketPriceStore } = await import('./market-price-store.js');

beforeEach(async () => {
    vi.useFakeTimers();
    // cleanup() flushes, and flush() is async and un-awaited. A store the
    // previous test left dirty therefore writes to storage some microtasks
    // later — after the mocks below would have been cleared, so the write got
    // counted against the NEXT test ('flush writes only when dirty' saw a
    // phantom set of an empty record). Tear down first and let the write
    // settle, then clear.
    marketPriceStore.cleanup();
    await marketPriceStore.record.flushed();
    storageMock.saved = {};
    storageMock.unavailable = false;
    storageMock.gate = null;
    dataManagerMock.live = [];
    storageMock.tryGet.mockClear();
    storageMock.set.mockClear();
    dataManagerMock.on.mockClear();
    dataManagerMock.off.mockClear();
    marketPriceStore.record.reset();
    marketPriceStore.dirty = false;
    marketPriceStore.loaded = false;
    marketPriceStore.listeners = new Set();
    await marketPriceStore.initialize();
});

describe('onOrderBooks', () => {
    test('a book with both sides records ask/bid and marks the entry dirty', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);

        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/cheese',
                orderBooks: [{ asks: [{ price: 100, quantity: 5 }], bids: [{ price: 90, quantity: 3 }] }],
            },
        });

        const entry = marketPriceStore.get('/items/cheese', 0);
        expect(entry).toMatchObject({ ask: 100, bid: 90, askQty: 5, bidQty: 3 });
        expect(listener).toHaveBeenCalledWith(['/items/cheese:0']);
        expect(marketPriceStore.dirty).toBe(true);
    });

    test('a null slot in a sparse orderBooks array is skipped, not stored as empty', () => {
        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/sword',
                orderBooks: [null, { asks: [{ price: 500, quantity: 1 }], bids: [] }],
            },
        });

        expect(marketPriceStore.get('/items/sword', 0)).toBeNull();
        expect(marketPriceStore.get('/items/sword', 1)).toMatchObject({ ask: 500 });
    });

    test('a payload with no marketItemOrderBooks or itemHrid is a no-op', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);
        dataManagerMock.handlers['market_item_order_books_updated']({});
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('ingestSnapshot', () => {
    test('records ask/bid from the compact snapshot shape with no size data', () => {
        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 50, b: 40 } } }, 1000);
        const entry = marketPriceStore.get('/items/plank', 0);
        expect(entry).toMatchObject({ ask: 50, bid: 40, askQty: 0, bidQty: 0 });
    });

    test('a fresher snapshot replaces an order-book reading and drops its depth (newest-wins)', () => {
        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/plank',
                orderBooks: [{ asks: [{ price: 60, quantity: 200 }], bids: [] }],
            },
        });

        // foldPrice is newest-wins by timestamp and does not special-case the size-less snapshot,
        // so a fresher snapshot overwrites both the price AND the stored size. The thin-market
        // reader depends on this: a wiped askQty reads as "depth unknown" and falls back to buying.
        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 61, b: 41 } } }, Date.now() + 1);
        const entry = marketPriceStore.get('/items/plank', 0);
        expect(entry.ask).toBe(61);
        expect(entry.askQty).toBe(0);
    });

    test('the same snapshot object offered twice is folded in once', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);
        const snapshot = { '/items/plank': { 0: { a: 50, b: 40 } } };

        marketPriceStore.ingestSnapshot(snapshot, 1000);
        marketPriceStore.ingestSnapshot(snapshot, 2000);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(marketPriceStore.get('/items/plank').at).toBe(1000);
    });

    test('a new snapshot object is folded in even when its prices match the last one', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);

        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 50, b: 40 } } }, 1000);
        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 50, b: 40 } } }, 2000);

        expect(listener).toHaveBeenCalledTimes(2);
        expect(marketPriceStore.get('/items/plank').at).toBe(2000);
    });

    test('a null/undefined snapshot is a no-op rather than a throw', () => {
        expect(() => marketPriceStore.ingestSnapshot(null, Date.now())).not.toThrow();
    });
});

describe('get', () => {
    test('coin resolves to face value even with nothing in the entries table', () => {
        expect(marketPriceStore.get('/items/coin')).toMatchObject({ ask: 1, bid: 1 });
    });

    test('cowbell derives from the bag entry and is null until the bag has a price', () => {
        expect(marketPriceStore.get('/items/cowbell')).toBeNull();
        marketPriceStore.ingestSnapshot({ '/items/bag_of_10_cowbells': { 0: { a: 1000, b: 800 } } }, Date.now());
        const cowbell = marketPriceStore.get('/items/cowbell');
        expect(cowbell.ask).toBeCloseTo(100, 6);
        expect(cowbell.bid).toBeCloseTo(80, 6);
    });

    test('an item never seen returns null', () => {
        expect(marketPriceStore.get('/items/never_seen')).toBeNull();
    });
});

describe('flush', () => {
    test('writes to storage only when dirty', async () => {
        await marketPriceStore.flush();
        expect(storageMock.set).not.toHaveBeenCalled();

        marketPriceStore.dirty = true;
        await marketPriceStore.flush();
        expect(storageMock.set).toHaveBeenCalledWith('mooketPrices', marketPriceStore.entries, 'marketListings', false);
        expect(marketPriceStore.dirty).toBe(false);
    });
});

describe('the stored cache survives a read that cannot be made', () => {
    const book = (itemHrid, ask) =>
        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: { itemHrid, orderBooks: [{ asks: [{ price: ask, quantity: 1 }], bids: [] }] },
        });
    const savedAsk = (itemHrid) => storageMock.saved.mooketPrices?.[`${itemHrid}:0`]?.ask;

    test('a load while storage is unreadable keeps the cache in hand instead of blanking it', async () => {
        book('/items/cheese', 100);
        await marketPriceStore.flush();
        expect(savedAsk('/items/cheese')).toBe(100);

        marketPriceStore.cleanup();
        marketPriceStore.loaded = false;
        storageMock.unavailable = true;
        await marketPriceStore.initialize();

        expect(marketPriceStore.get('/items/cheese').ask).toBe(100);
        expect(savedAsk('/items/cheese')).toBe(100);
    });

    test('a flush while storage is unreadable is skipped and stays dirty, then lands', async () => {
        storageMock.saved.mooketPrices = { '/items/milk:0': { ask: 5, bid: 4, at: Date.now() } };
        storageMock.unavailable = true;
        book('/items/cheese', 100);

        await marketPriceStore.flush();
        expect(marketPriceStore.dirty).toBe(true);
        expect(savedAsk('/items/cheese')).toBeUndefined();
        expect(savedAsk('/items/milk')).toBe(5);

        storageMock.unavailable = false;
        await marketPriceStore.flush();
        expect(marketPriceStore.dirty).toBe(false);
        expect(savedAsk('/items/cheese')).toBe(100);
        expect(savedAsk('/items/milk')).toBe(5);
    });

    test('a flush folds in what another tab saw, the newer reading of an item winning', async () => {
        book('/items/cheese', 100);
        await marketPriceStore.flush();

        const later = Date.now() + 60_000;
        storageMock.saved.mooketPrices = {
            '/items/cheese:0': { ask: 120, bid: 0, at: later },
            '/items/milk:0': { ask: 5, bid: 4, at: Date.now() },
        };
        book('/items/log', 7);
        await marketPriceStore.flush();

        expect(savedAsk('/items/cheese')).toBe(120);
        expect(savedAsk('/items/milk')).toBe(5);
        expect(savedAsk('/items/log')).toBe(7);
    });
});

describe('cleanup', () => {
    test('unregisters the websocket handler and stops the save timer', () => {
        dataManagerMock.off.mockClear();
        marketPriceStore.cleanup();
        expect(dataManagerMock.off).toHaveBeenCalledWith('market_item_order_books_updated', expect.any(Function));
        expect(marketPriceStore.bookHandler).toBeNull();
        expect(marketPriceStore.saveTimer).toBeNull();
    });
});

/**
 * The store's only re-entrancy guard is `bookHandler`, and it is read *before*
 * the record's first storage read. A character switch tears the price panel
 * down mid-read and starts the arriving character's `initialize()` at once, so
 * both runs got past the guard on a null handler and both registered when they
 * resumed — the second overwriting `bookHandler` and `saveTimer`, leaving the
 * first run's order-book listener and 60s flush interval live with nothing left
 * to remove them by. One leaked pair per switch, outliving even the feature
 * being switched off.
 */
describe('a teardown landing inside the first read', () => {
    test('the interrupted start-up registers no second listener and no second timer', async () => {
        marketPriceStore.cleanup();
        await marketPriceStore.record.flushed();
        dataManagerMock.live = [];
        const timersBefore = vi.getTimerCount();

        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });

        // The departing character's start-up parks on its read…
        const interrupted = marketPriceStore.initialize();
        // …the switch tears the store down…
        marketPriceStore.cleanup();
        // …and the arriving character starts its own, which parks too
        const arriving = marketPriceStore.initialize();

        release();
        storageMock.gate = null;
        await interrupted;
        await arriving;

        expect(dataManagerMock.live.filter((entry) => entry.event === 'market_item_order_books_updated')).toHaveLength(
            1
        );
        expect(vi.getTimerCount()).toBe(timersBefore + 1);

        // …and that one pair is the one the next teardown can take away
        marketPriceStore.cleanup();
        await marketPriceStore.record.flushed();
        expect(dataManagerMock.live).toEqual([]);
        expect(vi.getTimerCount()).toBe(timersBefore);
    });
});
