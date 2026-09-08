/** @vitest-environment happy-dom
 *
 * The Top Order Price column preferred the last-opened order book, which excludes
 * your own orders but goes stale the moment you leave the item. A fresh snapshot
 * undercut then stayed hidden until you re-opened the item. `_getTopOrderPrice`
 * now surfaces the snapshot when it is fresher than the book AND shows a price
 * that beats you — a price better than your own is a rival's, never your own
 * order — so an undercut appears without opening the item, and never at the cost
 * of showing your own listing or downgrading a fresher book.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { marketMock, ageMock } = vi.hoisted(() => ({
    marketMock: {
        getPrice: vi.fn(),
        getPriceTimestamp: vi.fn(),
        getPricesBatch: vi.fn(() => new Map()),
        on: vi.fn(),
        off: vi.fn(),
    },
    ageMock: {
        orderBooksCache: {},
        estimateTimestamp: vi.fn(() => 0),
        getStalenessTooltip: vi.fn(),
        getStalenessColor: vi.fn(),
    },
}));

vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
const settings = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key] ?? false,
        getSettingValue: () => 1,
        COLOR_TEXT_SECONDARY: '#999',
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: marketMock }));
vi.mock('./estimated-listing-age.js', () => ({ default: ageMock }));
vi.mock('./listing-markers.js', () => ({ default: { all: () => [] }, markerStateFor: () => ({}) }));

import listingPriceDisplay, { parseQuantityCell } from './listing-price-display.js';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const ITEM = '/items/bag';

/** An order book whose only bid/ask is your own listing (id 1), so it has no competitor */
function bookWithOwnOnly(isSell, ownPrice, lastUpdated) {
    const side = isSell ? 'asks' : 'bids';
    return { lastUpdated, data: { orderBooks: { 0: { [side]: [{ listingId: 1, price: ownPrice }] } } } };
}

beforeEach(() => {
    ageMock.orderBooksCache = {};
    marketMock.getPrice.mockReset();
    marketMock.getPriceTimestamp.mockReset();
});

describe('_getTopOrderPrice — fresh undercut over a stale book', () => {
    test('a fresher snapshot bid above your buy is surfaced', () => {
        ageMock.orderBooksCache[ITEM] = bookWithOwnOnly(false, 16_000_000, 1000);
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(17_000_000);
    });

    test('a fresher snapshot ask below your sell is surfaced', () => {
        ageMock.orderBooksCache[ITEM] = bookWithOwnOnly(true, 920_000, 1000);
        marketMock.getPrice.mockReturnValue({ ask: 900_000, bid: null });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, true, new Map(), new Set([1]), 920_000);
        expect(price).toBe(900_000);
    });

    test('a snapshot that does not beat you never overrides — and never shows your own price', () => {
        // Book has a real competitor below you (15M); snapshot bid equals your own
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 1000,
            data: {
                orderBooks: {
                    0: {
                        bids: [
                            { listingId: 1, price: 16_000_000 }, // your own
                            { listingId: 2, price: 15_000_000 }, // competitor
                        ],
                    },
                },
            },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 16_000_000 }); // == your own, not a beat
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(15_000_000); // the book's own-excluding competitor, not your 16M
    });

    test('a book fresher than the snapshot is trusted even if the snapshot beats you', () => {
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 3000, // fresher than the snapshot
            data: { orderBooks: { 0: { bids: [{ listingId: 2, price: 15_000_000 }] } } },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000); // older than the book

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(15_000_000);
    });

    test('with no opened book, a snapshot undercut is surfaced directly', () => {
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set(), 16_000_000);
        expect(price).toBe(17_000_000);
    });

    test('without the listing price it cannot judge a beat, so the book is kept', () => {
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 1000,
            data: { orderBooks: { 0: { bids: [{ listingId: 2, price: 15_000_000 }] } } },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), null);
        expect(price).toBe(15_000_000);
    });
});

describe('a processed table is left alone on the next order-book message', () => {
    /**
     * The My Listings table, cut down to what `updateTable` reads: a header row
     * to insert columns into and one body row per listing.
     * @returns {HTMLElement} The table
     */
    const table = () => {
        const node = document.createElement('table');
        node.innerHTML =
            '<thead><tr><th>Item</th><th>Type</th><th>Price</th><th>Quantity</th><th>Cancel</th></tr></thead>' +
            '<tbody><tr data-listing-id="1"><td>a</td><td>b</td><td>c</td><td>d</td><td>e</td></tr></tbody>';
        return node;
    };

    beforeEach(() => {
        for (const key of Object.keys(settings)) delete settings[key];
        // The setting that gates the "is every book in hand?" check
        settings['market_showTopOrderAge'] = true;
        listingPriceDisplay.allListings = {
            1: { id: 1, itemHrid: ITEM, enhancementLevel: 0, price: 100, orderQuantity: 1, filledQuantity: 0 },
        };
        listingPriceDisplay.originalRowOrder = [];
        listingPriceDisplay.sortHeaders = new Map();
        ageMock.orderBooksCache = {};
        marketMock.getPrice.mockReturnValue(null);
        marketMock.getPriceTimestamp.mockReturnValue(null);
    });

    test('with the book in the cache the table is marked done and short-circuits', () => {
        // The cache entry is `{data, lastUpdated}`. Reading `.orderBooks` off the
        // entry rather than off `.data` was always undefined, so this never
        // became true — every one of the ~21 order-book messages an item open
        // produces rebuilt the whole table and discarded the chosen sort.
        ageMock.orderBooksCache[ITEM] = { lastUpdated: 1000, data: { orderBooks: { 0: { asks: [], bids: [] } } } };

        const node = table();
        listingPriceDisplay.updateTable(node);
        expect(node.classList.contains('mwi-listing-prices-set')).toBe(true);

        const headers = node.querySelectorAll('.mwi-listing-price-header').length;
        listingPriceDisplay.updateTable(node);
        expect(node.querySelectorAll('.mwi-listing-price-header')).toHaveLength(headers);
    });

    test('with no book yet it stays unmarked, so the next message can finish the job', () => {
        const node = table();
        listingPriceDisplay.updateTable(node);
        expect(node.classList.contains('mwi-listing-prices-set')).toBe(false);
    });
});

describe('parseQuantityCell', () => {
    test('plain and abbreviated quantities', () => {
        expect(parseQuantityCell('62075 / 405K')).toEqual({
            filledQuantity: 62075,
            orderQuantity: 405000,
            filledSuffixMultiplier: 1,
            orderSuffixMultiplier: 1000,
        });
        expect(parseQuantityCell('0 / 1')).toMatchObject({ filledQuantity: 0, orderQuantity: 1 });
    });

    test('a cell not shaped like a ratio is null', () => {
        expect(parseQuantityCell('nothing here')).toBeNull();
    });

    describe('locale-grouped quantities', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US comma grouping', () => {
            asLocale('en-US');
            expect(parseQuantityCell('1,234 / 5,678')).toMatchObject({
                filledQuantity: 1234,
                orderQuantity: 5678,
            });
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[0-9,.]+` already tolerates comma/period swapped
            // roles by coincidence (both characters are in the class either
            // way); a space-grouping locale is the case it cannot handle at
            // all — the whole cell fails to match. This pins the de-DE case too.
            asLocale('de-DE');
            expect(parseQuantityCell('1.234 / 5.678')).toMatchObject({
                filledQuantity: 1234,
                orderQuantity: 5678,
            });
        });

        test('fr-FR space grouping — the case a comma/period union cannot reach', () => {
            asLocale('fr-FR');
            expect(parseQuantityCell('1 234 / 5 678')).toMatchObject({
                filledQuantity: 1234,
                orderQuantity: 5678,
            });
        });
    });
});
