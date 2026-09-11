/**
 * Tests for the Cost Summary card's direct-cost arithmetic.
 *
 * Only `computeDirectCosts` is exercised here — the DOM assembly around it
 * (`buildBlock`/`renderBlock`) is plumbing with nothing to get wrong once the
 * totals it is handed are right.
 */

import { describe, test, expect, vi } from 'vitest';

const prices = vi.hoisted(() => ({ byHrid: {} }));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in prices.byHrid ? prices.byHrid[hrid] : null),
    formatPrice: (value) => String(value),
}));

const { computeDirectCosts } = await import('./cost-summary.js');

function material(overrides = {}) {
    return {
        itemHrid: '/items/wood',
        itemName: 'Wood',
        required: 10,
        have: 0,
        queued: 0,
        available: 0,
        missing: 10,
        isTradeable: true,
        isUpgradeItem: false,
        ...overrides,
    };
}

describe('computeDirectCosts', () => {
    test('prices an ordinary tradeable material at its buy-side quote', () => {
        prices.byHrid = { '/items/wood': 50 };

        const result = computeDirectCosts([material({ required: 10, missing: 4 })]);

        expect(result.directCost).toBe(500);
        expect(result.missingCost).toBe(200);
        expect(result.directComplete).toBe(true);
        expect(result.missingComplete).toBe(true);
    });

    test('a tradeable material with no market quote flags both totals as partial', () => {
        prices.byHrid = {};

        const result = computeDirectCosts([material({ itemHrid: '/items/mystery', required: 5, missing: 5 })]);

        expect(result.directCost).toBe(0);
        expect(result.directComplete).toBe(false);
        expect(result.missingComplete).toBe(false);
    });

    test('a non-tradeable, non-coin material is skipped without pricing it', () => {
        prices.byHrid = {};

        const result = computeDirectCosts([
            material({ itemHrid: '/items/quest_token', isTradeable: false, required: 3, missing: 3 }),
        ]);

        expect(result.directCost).toBe(0);
    });

    test('coin is priced at exactly 1 regardless of its own isTradeable flag', () => {
        // Some tier-0 recipes pay their upgrade slot in coin outright — the same case
        // profit-calculator.js special-cases when totaling material costs. Coin has no
        // market listing (you cannot list currency), so before this fix it fell into
        // either the "not tradeable" skip or the "no price" branch and its cost was
        // dropped from the total, undercounting the recipe's real direct cost.
        prices.byHrid = { '/items/wood': 50 };

        const withoutCoin = computeDirectCosts([material({ required: 10, missing: 10 })]);
        const withCoin = computeDirectCosts([
            material({ required: 10, missing: 10 }),
            material({
                itemHrid: '/items/coin',
                itemName: 'Coin',
                isTradeable: false,
                isUpgradeItem: true,
                required: 300,
                missing: 300,
            }),
        ]);

        expect(withCoin.directCost).toBe(withoutCoin.directCost + 300);
        expect(withCoin.missingCost).toBe(withoutCoin.missingCost + 300);
        // Coin's price is never in question, so it must not trip the partial flag either.
        expect(withCoin.directComplete).toBe(true);
        expect(withCoin.missingComplete).toBe(true);
    });

    test('an empty material list costs nothing and is never flagged partial', () => {
        expect(computeDirectCosts([])).toEqual({
            directCost: 0,
            missingCost: 0,
            directComplete: true,
            missingComplete: true,
        });
    });
});
