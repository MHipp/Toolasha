/**
 * Stale Capital — the pure ranking/totals arithmetic behind the
 * "what of mine isn't moving?" view.
 */

import { describe, test, expect } from 'vitest';
import { isOpenListing, comparePriceToBook, buildRow, buildStaleCapital, ACTIVE_STATUS } from './stale-capital.js';

const CANCELLED = '/market_listing_status/cancelled';
const FILLED = '/market_listing_status/filled';
const EXPIRED = '/market_listing_status/expired';

function listing(overrides = {}) {
    return {
        id: 1,
        itemHrid: '/items/cheese',
        enhancementLevel: 0,
        isSell: true,
        price: 100,
        orderQuantity: 10,
        filledQuantity: 0,
        status: ACTIVE_STATUS,
        createdTimestamp: new Date(1000).toISOString(),
        ...overrides,
    };
}

describe('isOpenListing', () => {
    test('an active listing with quantity left is open', () => {
        expect(isOpenListing(listing())).toBe(true);
    });

    test('cancelled, filled, and expired listings are never open, whatever their quantity', () => {
        expect(isOpenListing(listing({ status: CANCELLED }))).toBe(false);
        expect(isOpenListing(listing({ status: FILLED }))).toBe(false);
        expect(isOpenListing(listing({ status: EXPIRED }))).toBe(false);
    });

    test('an active listing filled all the way is not open', () => {
        expect(isOpenListing(listing({ orderQuantity: 5, filledQuantity: 5 }))).toBe(false);
    });

    test('null/undefined is not open', () => {
        expect(isOpenListing(null)).toBe(false);
        expect(isOpenListing(undefined)).toBe(false);
    });
});

describe('comparePriceToBook', () => {
    test('unknown best price compares to null, not a guess', () => {
        expect(comparePriceToBook(100, null)).toBeNull();
        expect(comparePriceToBook(100, undefined)).toBeNull();
        expect(comparePriceToBook(100, NaN)).toBeNull();
    });

    test('equal prices compare "at"', () => {
        expect(comparePriceToBook(100, 100)).toBe('at');
    });

    test('a higher price than the book compares "above", a lower one "below"', () => {
        expect(comparePriceToBook(150, 100)).toBe('above');
        expect(comparePriceToBook(50, 100)).toBe('below');
    });
});

describe('buildRow', () => {
    test('coins tied up is remaining quantity times the listing price', () => {
        const row = buildRow(listing({ orderQuantity: 10, filledQuantity: 4, price: 250 }), 5000, 300);
        expect(row.quantity).toBe(6);
        expect(row.coinsTiedUp).toBe(1500);
    });

    test('coins tied up is knowable even when the current book price is not', () => {
        const row = buildRow(listing({ orderQuantity: 10, filledQuantity: 0, price: 250 }), 5000, null);
        expect(row.coinsTiedUp).toBe(2500);
        expect(row.priceComparison).toBeNull();
        expect(row.bestPrice).toBeNull();
    });

    test('age comes from createdTimestamp, clamped at zero', () => {
        const created = new Date(1000).toISOString();
        expect(buildRow(listing({ createdTimestamp: created }), 5000, 100).ageMs).toBe(4000);
        // A clock somehow behind the listing's own timestamp never reports negative age
        expect(buildRow(listing({ createdTimestamp: created }), 500, 100).ageMs).toBe(0);
    });

    test('an undatable listing reports null age rather than zero', () => {
        const row = buildRow(listing({ createdTimestamp: undefined }), 5000, 100);
        expect(row.ageMs).toBeNull();
    });
});

describe('buildStaleCapital', () => {
    test('splits sells and buys, and each side totals its own coins tied up', () => {
        const listings = [
            listing({ id: 1, isSell: true, price: 100, orderQuantity: 10, filledQuantity: 0 }), // 1000
            listing({ id: 2, isSell: true, price: 50, orderQuantity: 4, filledQuantity: 2 }), // 100
            listing({ id: 3, isSell: false, price: 20, orderQuantity: 100, filledQuantity: 0 }), // 2000
        ];
        const getBestPrice = () => null;
        const result = buildStaleCapital(listings, getBestPrice, 5000);

        expect(result.sellRows.map((r) => r.id)).toEqual([1, 2]);
        expect(result.buyRows.map((r) => r.id)).toEqual([3]);
        expect(result.sellTotal).toBe(1100);
        expect(result.buyTotal).toBe(2000);
    });

    test('ranks by coins tied up, not by age — an old small listing sorts behind a young large one', () => {
        const listings = [
            listing({
                id: 'old-small',
                price: 2,
                orderQuantity: 1000,
                filledQuantity: 0,
                createdTimestamp: new Date(0).toISOString(),
            }), // 2000 coins, 9 days old
            listing({
                id: 'young-big',
                price: 400000000,
                orderQuantity: 1,
                filledQuantity: 0,
                createdTimestamp: new Date(9 * 24 * 60 * 60 * 1000 - 1000).toISOString(),
            }), // 400M coins, 3 days old
        ];
        const now = 9 * 24 * 60 * 60 * 1000;
        const result = buildStaleCapital(listings, () => null, now);
        expect(result.sellRows.map((r) => r.id)).toEqual(['young-big', 'old-small']);
    });

    test('ties on coins tied up break oldest-first', () => {
        const listings = [
            listing({
                id: 'newer',
                price: 100,
                orderQuantity: 10,
                filledQuantity: 0,
                createdTimestamp: new Date(2000).toISOString(),
            }),
            listing({
                id: 'older',
                price: 100,
                orderQuantity: 10,
                filledQuantity: 0,
                createdTimestamp: new Date(1000).toISOString(),
            }),
        ];
        const result = buildStaleCapital(listings, () => null, 5000);
        expect(result.sellRows.map((r) => r.id)).toEqual(['older', 'newer']);
    });

    test('closed listings never appear and never contribute to a total', () => {
        const listings = [
            listing({ id: 1, status: CANCELLED }),
            listing({ id: 2, status: FILLED }),
            listing({ id: 3, status: EXPIRED }),
        ];
        const result = buildStaleCapital(listings, () => 100, 5000);
        expect(result.sellRows).toEqual([]);
        expect(result.buyRows).toEqual([]);
        expect(result.sellTotal).toBe(0);
        expect(result.buyTotal).toBe(0);
    });

    test('an empty or missing listing set totals to zero, not an error', () => {
        expect(buildStaleCapital([], () => 100)).toEqual({ sellRows: [], buyRows: [], sellTotal: 0, buyTotal: 0 });
        expect(buildStaleCapital(null, () => 100)).toEqual({ sellRows: [], buyRows: [], sellTotal: 0, buyTotal: 0 });
    });

    test('getBestPrice is asked per row, keyed by item, enhancement level, and side', () => {
        const listings = [listing({ id: 1, itemHrid: '/items/cheese', enhancementLevel: 3, isSell: true })];
        const calls = [];
        const getBestPrice = (itemHrid, enhancementLevel, isSell) => {
            calls.push({ itemHrid, enhancementLevel, isSell });
            return 100;
        };
        buildStaleCapital(listings, getBestPrice, 5000);
        expect(calls).toEqual([{ itemHrid: '/items/cheese', enhancementLevel: 3, isSell: true }]);
    });

    test('a character switch shows only the listings it is handed — nothing carries over', () => {
        const characterA = [listing({ id: 'a1', itemHrid: '/items/cheese' })];
        const characterB = [listing({ id: 'b1', itemHrid: '/items/milk' })];

        const resultA = buildStaleCapital(characterA, () => null, 5000);
        expect(resultA.sellRows.map((r) => r.id)).toEqual(['a1']);

        // Nothing here is cached across the calls; a later call with a different
        // character's listings describes only that character
        const resultB = buildStaleCapital(characterB, () => null, 5000);
        expect(resultB.sellRows.map((r) => r.id)).toEqual(['b1']);
    });
});
