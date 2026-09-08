/** @vitest-environment happy-dom */

/**
 * Tests for the alchemy panel reader.
 *
 * alchemy-profit.js reads the alchemy panel; it does not calculate. What is
 * pinned here is the arithmetic it still owns — enhancement cost, used by
 * `extractItemData` to price a `+N` requirement the market has no listing for —
 * and the action-hrid lookup the display and the tea recommendation both call.
 *
 * Expected values are hand-computed in comments so the fixture is auditable.
 *
 * Not covered (pure DOM scraping, no arithmetic): extractRequirements,
 * extractDrops, extractItemData, getStateFingerprint.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    currentActions: [],
}));

const market = vi.hoisted(() => ({
    /** itemHrid → { ask, bid } */
    prices: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getCurrentActions: () => game.currentActions,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] || null,
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (hrid) => market.prices[hrid] ?? null,
        on: () => () => {},
    },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        getCachedValue: () => 0,
        calculateSingleContainer: () => 0,
    },
}));

const alchemyProfitModule = await import('./alchemy-profit.js');
const alchemyProfit = alchemyProfitModule.default;
const { parseRequirementCount, parseDropCountAndRate } = alchemyProfitModule;
const { _resetGameNumberSeparators } = await import('../../utils/number-parser.js');

const COIN = '/items/coin';
const CHEESE = '/items/cheese';

beforeEach(() => {
    game.initClientData = {
        itemDetailMap: {
            [CHEESE]: {
                name: 'Cheese',
                itemLevel: 10,
                enhancementCosts: [
                    { itemHrid: COIN, count: 1000 },
                    { itemHrid: '/items/mirror_of_protection', count: 2 },
                ],
            },
        },
    };
    game.currentActions = [];
    market.prices = {
        [CHEESE]: { ask: 1000, bid: 900 },
        '/items/milk': { ask: 120, bid: 100 },
        '/items/mirror_of_protection': { ask: 500, bid: 450 },
    };
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('getCurrentActionHrid', () => {
    test('picks the running alchemy action by execution order, not the first in the array', () => {
        // A repeating alchemy action requeued to the front of the array with
        // the highest ordinal, ahead of the one actually running: the old
        // first-match loop priced the queued one
        game.currentActions = [
            { actionHrid: '/actions/alchemy/transmute', isDone: false, ordinal: 8589934588 },
            { actionHrid: '/actions/milking/cow', isDone: false, ordinal: 1 },
            { actionHrid: '/actions/alchemy/coinify', isDone: false, ordinal: 0 },
        ];
        expect(alchemyProfit.getCurrentActionHrid()).toBe('/actions/alchemy/coinify');
    });

    test('picks the alchemy action out of the queue', () => {
        game.currentActions = [{ actionHrid: '/actions/milking/cow' }, { actionHrid: '/actions/alchemy/coinify' }];

        expect(alchemyProfit.getCurrentActionHrid()).toBe('/actions/alchemy/coinify');
    });

    test('returns null when nothing is queued or nothing is alchemy', () => {
        game.currentActions = [];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();

        game.currentActions = [{ actionHrid: '/actions/milking/cow' }];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();
    });
});

describe('calculateEnhancementCost', () => {
    test('a +0 item costs exactly its market price on the chosen side', () => {
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 0, 'ask')).toBe(1000);
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 0, 'bid')).toBe(900);
    });

    test('adds one full material set per enhancement level, coins at face value', () => {
        // base 1,000 + 3 levels × (1,000 coins + 2 mirrors @ 500 ask = 1,000) = 1,000 + 3 × 2,000
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'ask')).toBe(7000);
        // bid side: mirrors at 450 → per level 1,000 + 900 = 1,900; base 900 + 3 × 1,900
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'bid')).toBe(6600);
    });

    test('treats an unpriced material as free rather than NaN', () => {
        delete market.prices['/items/mirror_of_protection'];

        // base 1,000 + 2 levels × 1,000 coins
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 2, 'ask')).toBe(3000);
    });

    test('returns the base price for an item with no enhancement recipe', () => {
        game.initClientData.itemDetailMap['/items/milk'] = { name: 'Milk', itemLevel: 1 };

        expect(alchemyProfit.calculateEnhancementCost('/items/milk', 5, 'ask')).toBe(120);
    });

    test('returns zero for an unknown item or missing game data', () => {
        expect(alchemyProfit.calculateEnhancementCost('/items/unknown', 3, 'ask')).toBe(0);

        game.initClientData = null;
        expect(alchemyProfit.calculateEnhancementCost(CHEESE, 3, 'ask')).toBe(0);
    });
});

describe('parseRequirementCount / parseDropCountAndRate — locale-grouped DOM text', () => {
    const asLocale = (value) => {
        localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    describe('en-US', () => {
        beforeEach(() => asLocale('en-US'));

        test('parseRequirementCount reads comma grouping', () => {
            expect(parseRequirementCount('/ 1,450')).toBe(1450);
        });

        test('parseDropCountAndRate reads comma and period', () => {
            expect(parseDropCountAndRate('1,200 Item ~7.29%', null)).toEqual({ count: 1200, dropRate: 0.0729 });
        });

        test('parseDropCountAndRate prefers game data over the DOM rate', () => {
            expect(parseDropCountAndRate('12 Item 7.29%', 0.5)).toEqual({ count: 12, dropRate: 0.5 });
        });
    });

    describe('de-DE (period grouping) — the bug this replaces', () => {
        beforeEach(() => asLocale('de-DE'));

        test('parseRequirementCount reads period grouping instead of stopping at the first group', () => {
            // A hardcoded `[\d,]+` reads "/ 1.450" as "/ 1": the period isn't in
            // the class, so the match stops at the first group boundary.
            expect(parseRequirementCount('/ 1.450')).toBe(1450);
        });

        test('parseDropCountAndRate reads a period-grouped count and a comma decimal rate', () => {
            expect(parseDropCountAndRate('1.200 Item ~7,29%', null)).toEqual({ count: 1200, dropRate: 0.0729 });
        });
    });
});
