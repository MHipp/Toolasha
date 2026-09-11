/**
 * Tests for the Production Profit Calculator
 *
 * production-profit.js is a thin adapter: it decides whether an action is a
 * production action, hands the output item to the shared profit calculator, and
 * reshapes the answer for the action panel. Both halves are pinned here — the
 * gate (which actions it accepts, and what it asks the calculator about) and
 * the reshaping arithmetic (rounding, decimal rules, pass-through fields).
 *
 * The market profit calculator is mocked at its module boundary; it has its own
 * math and is not what this file is responsible for.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
}));

const calculator = vi.hoisted(() => ({
    /** Records every itemHrid the adapter asked about */
    requestedItems: [],
    result: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
    },
}));

vi.mock('../market/profit-calculator.js', () => ({
    default: {
        calculateProfit: async (itemHrid) => {
            calculator.requestedItems.push(itemHrid);
            return calculator.result;
        },
    },
}));

const { calculateProductionProfit } = await import('./production-profit.js');

const TEA = '/items/efficiency_tea';
const BREW = '/actions/brewing/efficiency_tea';

/**
 * A realistic profit-calculator result: 300 actions/hour at 120% efficiency,
 * one tea per action selling for 490 after tax.
 */
function profitCalculatorResult(overrides = {}) {
    return {
        profitPerHour: 61234.6,
        profitPerDay: 1469630.4,
        itemsPerHour: 660,
        gourmetBonusItems: 39.6,
        priceAfterTax: 490.2,
        actionsPerHour: 300,
        materialCostPerHour: 200000.4,
        totalTeaCostPerHour: 6900.6,
        totalEfficiency: 120,
        materialCosts: [{ itemHrid: '/items/cotton', totalCost: 250 }],
        teaCosts: [{ itemHrid: '/items/gathering_tea', totalCost: 300 }],
        pricingMode: 'hybrid',
        levelEfficiency: 45,
        houseEfficiency: 12,
        teaEfficiency: 13.5,
        equipmentEfficiency: 49.5,
        artisanBonus: 0.112,
        gourmetBonus: 0.06,
        efficiencyMultiplier: 2.2,
        ...overrides,
    };
}

beforeEach(() => {
    calculator.requestedItems = [];
    calculator.result = profitCalculatorResult();
    game.initClientData = {
        actionDetailMap: {
            [BREW]: {
                type: '/action_types/brewing',
                outputItems: [{ itemHrid: TEA, count: 1 }],
            },
            '/actions/cooking/donut': {
                type: '/action_types/cooking',
                outputItems: [
                    { itemHrid: '/items/donut', count: 1 },
                    { itemHrid: '/items/crumbs', count: 1 },
                ],
            },
            '/actions/milking/cow': {
                type: '/action_types/milking',
                dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
            '/actions/crafting/nothing': {
                type: '/action_types/crafting',
                outputItems: [],
            },
        },
    };
});

describe('calculateProductionProfit', () => {
    test('asks the profit calculator about the action output', async () => {
        const result = await calculateProductionProfit(BREW);

        expect(calculator.requestedItems).toEqual([TEA]);
        expect(result).toBe(calculator.result);
    });

    test('uses the first output when an action makes several things', async () => {
        await calculateProductionProfit('/actions/cooking/donut');

        expect(calculator.requestedItems).toEqual(['/items/donut']);
    });

    test('returns null for an unknown action', async () => {
        expect(await calculateProductionProfit('/actions/brewing/nonexistent')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null for a gathering action', async () => {
        expect(await calculateProductionProfit('/actions/milking/cow')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null for a production action with no outputs', async () => {
        expect(await calculateProductionProfit('/actions/crafting/nothing')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null when the calculator cannot price the item', async () => {
        calculator.result = null;

        expect(await calculateProductionProfit(BREW)).toBeNull();
        expect(calculator.requestedItems).toEqual([TEA]);
    });
});
