import { describe, test, expect } from 'vitest';
import { bestPrice, queueAt, estimateFillSeconds, walkForQuantity, walkForBudget } from './order-book.js';

/**
 * A side of the book, newest listing last.
 * @param {number} count - How many listings
 * @param {number} price - Their price
 * @param {number} spanMs - How long they took to accumulate, ending now
 * @param {number} [quantity] - Each listing's size
 * @returns {Array<Object>}
 */
function listings(count, price, spanMs, quantity = 10) {
    const end = Date.now();
    return Array.from({ length: count }, (_, index) => ({
        price,
        quantity,
        createdTimestamp: new Date(end - spanMs + (index * spanMs) / Math.max(1, count - 1)).toISOString(),
    }));
}

describe('bestPrice', () => {
    test('is the head of the side, since the game sends them best-first', () => {
        expect(bestPrice([{ price: 100 }, { price: 90 }])).toBe(100);
    });

    test('an empty side has no price rather than zero', () => {
        expect(bestPrice([])).toBeNull();
        expect(bestPrice(null)).toBeNull();
    });
});

describe('queueAt', () => {
    test('adds up what sits at one price', () => {
        const side = [
            { price: 100, quantity: 5 },
            { price: 100, quantity: 7 },
            { price: 90, quantity: 99 },
        ];
        expect(queueAt(side, 100).quantity).toBe(12);
    });

    test('a partly-visible level is a fact, not an estimate', () => {
        expect(queueAt(listings(5, 100, 60_000), 100).estimated).toBe(false);
    });

    test('a full window at one price is deeper than it looks', () => {
        // Twenty listings all at the best price means the level runs past the
        // window, so the total is extrapolated from how fast they arrived
        const stale = listings(20, 100, 60_000).map((listing) => ({
            ...listing,
            createdTimestamp: new Date(new Date(listing.createdTimestamp).getTime() - 60_000).toISOString(),
        }));
        const result = queueAt(stale, 100);
        expect(result.estimated).toBe(true);
        expect(result.quantity).toBeGreaterThan(200);
    });

    test('a level whose newest listing just arrived is exactly its visible depth', () => {
        // Extrapolating to 1x is a real answer rather than an inapplicable one
        const result = queueAt(listings(20, 100, 60_000), 100);
        expect(result.estimated).toBe(true);
        expect(result.quantity).toBeCloseTo(200, 0);
    });

    test('survives a side with no timestamps to extrapolate from', () => {
        const side = Array.from({ length: 20 }, () => ({ price: 100, quantity: 1 }));
        expect(queueAt(side, 100).quantity).toBe(20);
    });
});

describe('estimateFillSeconds', () => {
    test('a fast-filling level fills an order fast', () => {
        // 20 listings of 10 arrived over a minute: 200 in 60s
        const fast = estimateFillSeconds(listings(20, 100, 60_000), 10);
        const slow = estimateFillSeconds(listings(20, 100, 7 * 86400_000), 10);
        expect(fast).toBeLessThan(slow);
    });

    test('a bigger order waits longer', () => {
        const side = listings(10, 100, 60_000);
        expect(estimateFillSeconds(side, 1000)).toBeGreaterThan(estimateFillSeconds(side, 10));
    });

    test('says nothing rather than guessing when there is nothing to measure', () => {
        // "Unknown" and "slow" are different answers and must not be confused
        expect(estimateFillSeconds([], 10)).toBeNull();
        expect(estimateFillSeconds([{ price: 100, quantity: 5 }], 10)).toBeNull();
    });

    test('a level with no quantity has no rate', () => {
        const empty = listings(5, 100, 60_000, 0);
        expect(estimateFillSeconds(empty, 10)).toBeNull();
    });
});

describe('walkForQuantity', () => {
    const bids = [
        { price: 100, quantity: 5 },
        { price: 90, quantity: 10 },
        { price: 80, quantity: 2 },
    ];

    test('takes from each level in turn rather than quoting the top price', () => {
        expect(walkForQuantity(bids, 10)).toEqual({ filled: 10, gold: 5 * 100 + 5 * 90, covered: true });
    });

    test('a quantity inside the first level is that level alone', () => {
        expect(walkForQuantity(bids, 3)).toEqual({ filled: 3, gold: 300, covered: true });
    });

    test('a book that runs out reports the shortfall instead of extrapolating', () => {
        const result = walkForQuantity(bids, 100);
        expect(result.filled).toBe(17);
        expect(result.covered).toBe(false);
        expect(result.gold).toBe(5 * 100 + 10 * 90 + 2 * 80);
    });

    test('an empty or absent side covers nothing', () => {
        expect(walkForQuantity([], 5)).toEqual({ filled: 0, gold: 0, covered: false });
        expect(walkForQuantity(null, 5)).toEqual({ filled: 0, gold: 0, covered: false });
    });

    test('rows with no price or no size are skipped', () => {
        const rows = [{ price: 0, quantity: 5 }, { quantity: 5 }, { price: 50, quantity: 4 }];
        expect(walkForQuantity(rows, 4)).toEqual({ filled: 4, gold: 200, covered: true });
    });

    test('asking for nothing is covered by nothing', () => {
        expect(walkForQuantity(bids, 0)).toEqual({ filled: 0, gold: 0, covered: false });
    });
});

describe('walkForBudget', () => {
    const asks = [
        { price: 100, quantity: 5 },
        { price: 110, quantity: 10 },
    ];

    test('spends down the ladder rather than dividing by the top ask', () => {
        // 1000 at the top ask alone would read as 10 units; the book gives 5 + 4
        expect(walkForBudget(asks, 1000)).toEqual({ units: 9, gold: 5 * 100 + 4 * 110, exhausted: false });
    });

    test('a budget short of the next unit stops without buying a fraction', () => {
        expect(walkForBudget(asks, 150)).toEqual({ units: 1, gold: 100, exhausted: false });
    });

    test('running off the end of the book with budget left says so', () => {
        const result = walkForBudget(asks, 1_000_000);
        expect(result.units).toBe(15);
        expect(result.exhausted).toBe(true);
    });

    test('no book and no budget buy nothing', () => {
        expect(walkForBudget([], 500)).toEqual({ units: 0, gold: 0, exhausted: true });
        expect(walkForBudget(asks, 0)).toEqual({ units: 0, gold: 0, exhausted: false });
    });
});
