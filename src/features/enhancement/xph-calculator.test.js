/**
 * Tests for the XP/hr calculator's profit column.
 *
 * `calculateItemXPH()` already had its own XP/hr, gold/XP and cost/hr arithmetic exercised by hand
 * through the panel; this file pins that arithmetic (the profit column must not change it) and
 * covers what the profit column itself adds: a per-hour figure from the enhanced item's own price
 * at the row's target level, net of the same materials/protection cost the sweep already tallies,
 * bounded by the shared market-liquidity cap, and labelled — never zero, never free — when either
 * side of that cannot be priced.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const ITEM = '/items/test_sword';
const MATERIAL = '/items/test_material';

/** The enhancement engine's answer, mutated per test. One attempt, one hour, always succeeds. */
const engineResult = vi.hoisted(() => ({
    visitCounts: [1],
    successRates: [{ actualRate: 100 }],
    totalTime: 3600,
    attempts: 1,
    protectionCount: 0,
}));

/** Market prices for the finished item, keyed `hrid::level`; empty unless a test sets one. */
const prices = vi.hoisted(() => ({}));

/** perAttemptMaterialCost()'s answer, mutated per test. */
const materialCostResult = vi.hoisted(() => ({ cost: 100, hasCost: true, costPartial: false }));

/** capProfitRate()'s answer, mutated per test. */
const liquidityResult = vi.hoisted(() => ({ goldPerHour: 0, capped: false, limit: null }));

/** Calls the mocked capProfitRate received, so a test can check what was asked for. */
const capCalls = vi.hoisted(() => []);

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
        isFeatureEnabled: () => false,
        Z_FLOATING_PANEL: 1,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: {} }) },
}));

vi.mock('../../utils/enhancement-calculator.js', () => ({
    calculateEnhancement: vi.fn(() => engineResult),
}));

vi.mock('./enhancement-xp.js', () => ({
    calculateSuccessXP: () => 10,
    calculateFailureXP: () => 2,
}));

vi.mock('./enhancement-params-source.js', () => ({
    benchNote: () => null,
    enhancementParamsFor: () => ({}),
}));

vi.mock('./tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: vi.fn(() => ({ itemHrid: null, price: 0 })),
    calculatePerAttemptMaterialCost: vi.fn(() => materialCostResult),
    calculateEnhancementPath: vi.fn(),
    buildEnhancementTooltipHTML: vi.fn(),
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

vi.mock('../../utils/panel-minimize.js', () => ({
    attachMinimize: () => ({ destroy: () => {} }),
}));

vi.mock('../../utils/command-registry.js', () => ({
    registerCommand: () => {},
    unregisterCommand: () => {},
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: vi.fn((hrid, level) => prices[`${hrid}::${level}`] ?? null),
}));

vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitRate: vi.fn((args) => {
        capCalls.push(args);
        return Promise.resolve(liquidityResult);
    }),
    liquidityMarkerHtml: () => '',
}));

vi.mock('../../utils/background-work.js', () => ({
    yieldToEventLoop: () => Promise.resolve(),
}));

let calculateItemXPH;
let capXPHRowProfit;

beforeAll(async () => {
    ({ calculateItemXPH, capXPHRowProfit } = await import('./xph-calculator.js'));
});

const itemDetails = { name: 'Test Sword', itemLevel: 10, enhancementCosts: [{ itemHrid: MATERIAL, count: 1 }] };
const params = {
    enhancingLevel: 100,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    teas: { blessed: false },
    guzzlingBonus: 0,
    blessedTeaBonus: 0,
};

beforeEach(() => {
    for (const key of Object.keys(prices)) delete prices[key];
    engineResult.visitCounts = [1];
    engineResult.successRates = [{ actualRate: 100 }];
    engineResult.totalTime = 3600;
    engineResult.attempts = 1;
    engineResult.protectionCount = 0;
    materialCostResult.cost = 100;
    materialCostResult.hasCost = true;
    materialCostResult.costPartial = false;
    liquidityResult.goldPerHour = 0;
    liquidityResult.capped = false;
    liquidityResult.limit = null;
    capCalls.length = 0;
});

describe('calculateItemXPH', () => {
    test('the existing XP/hr, gold/XP and cost/hr figures are unchanged by the profit column', () => {
        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        // totalXP = 1 attempt * (100% * 10 successXP + 0% * 2 failXP) = 10; 1 attempt in 1 hour.
        expect(result.xph).toBe(10);
        expect(result.goldPerXP).toBeCloseTo(100 / 10);
        expect(result.costPerHour).toBeCloseTo(10 * 10);
        expect(result.costPartial).toBe(false);
    });

    test('profit is computed from the enhanced item’s own price at the target level', () => {
        prices[`${ITEM}::5`] = { ask: 500, bid: 400 };

        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        // 1 item/hr sold at bid (400), net of tax, minus the known cost/hr (100).
        const expectedProfit = 400 * (1 - MARKET_TAX) - 100;
        expect(result.profitPerHour).toBeCloseTo(expectedProfit);
        expect(result.profitUnavailableReason).toBeNull();
    });

    test('falls back to ask when the finished item has no bid', () => {
        prices[`${ITEM}::5`] = { ask: 500, bid: 0 };

        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        const expectedProfit = 500 * (1 - MARKET_TAX) - 100;
        expect(result.profitPerHour).toBeCloseTo(expectedProfit);
    });

    test('an item whose enhanced form cannot be priced is labelled, not zero or free', () => {
        // No entry in `prices` at all for +5 — getItemPrices answers null.
        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        expect(result.profitPerHour).toBeNull();
        expect(result.profitUnavailableReason).toBe('unpriced');
    });

    test('an item with no known run cost is labelled, not treated as a zero-cost item', () => {
        prices[`${ITEM}::5`] = { ask: 500, bid: 400 };
        materialCostResult.hasCost = false;

        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        expect(result.profitPerHour).toBeNull();
        expect(result.profitUnavailableReason).toBe('no-cost');
    });

    test('a partially-priced cost still produces a profit figure, flagged partial', () => {
        prices[`${ITEM}::5`] = { ask: 500, bid: 400 };
        materialCostResult.costPartial = true;

        const result = calculateItemXPH(ITEM, itemDetails, 5, 0, params);

        expect(result.profitPerHour).not.toBeNull();
        expect(result.costPartial).toBe(true);
    });
});

describe('capXPHRowProfit', () => {
    test('a thin market throttles profit/hr and carries the limit marker', async () => {
        const row = { itemHrid: ITEM, itemsPerHour: 2, profitPerHour: 1000, liquidityLimit: null };
        liquidityResult.goldPerHour = 200;
        liquidityResult.capped = true;
        liquidityResult.limit = { kind: 'volume', note: 'limited by market volume (~1/week)', throttle: 0.2 };

        const bounded = await capXPHRowProfit(row);

        expect(bounded.profitPerHour).toBe(200);
        expect(bounded.uncappedProfitPerHour).toBe(1000);
        expect(bounded.liquidityLimit).toBe(liquidityResult.limit);
        // Bounded on what this row actually sells, not on some other item's volume
        expect(capCalls[0]).toEqual({ goldPerHour: 1000, sells: [{ itemHrid: ITEM, unitsPerHour: 2 }] });
    });

    test('a liquid market leaves the row untouched', async () => {
        const row = { itemHrid: ITEM, itemsPerHour: 2, profitPerHour: 1000, liquidityLimit: null };
        liquidityResult.capped = false;

        const bounded = await capXPHRowProfit(row);

        expect(bounded).toBe(row);
    });

    test('a row with no priced profit is never sent through the volume check', async () => {
        const row = { itemHrid: ITEM, itemsPerHour: 2, profitPerHour: null, liquidityLimit: null };

        const bounded = await capXPHRowProfit(row);

        expect(bounded).toBe(row);
        expect(capCalls).toHaveLength(0);
    });
});
