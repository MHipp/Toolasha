/**
 * Tests for the Gathering Profit Calculator
 *
 * The game is mocked, not the calculator: each test decides what the action
 * drops, what the market pays for it, and what buffs the character is running.
 * The efficiency context and the essence/rare-find bonus revenue are mocked at
 * their module boundary — both have their own tests (utils/efficiency.test.js,
 * utils/bonus-revenue-calculator.test.js) — so what is pinned here is the part
 * gathering-profit.js actually owns: drop table → items/hour → revenue → tax →
 * profit, plus the Processing and Gourmet adjustments layered on top.
 *
 * Every expected value below is hand-computed in a comment so the fixture is
 * auditable without running the code.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({
    initClientData: null,
}));

const market = vi.hoisted(() => ({
    /** itemHrid → price, or null for "no market data" */
    prices: {},
}));

const buffs = vi.hoisted(() => ({
    context: null,
    bonusRevenue: null,
}));

const settings = vi.hoisted(() => ({
    values: { profitCalc_pricingMode: 'hybrid' },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in market.prices ? market.prices[hrid] : null),
}));

vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: () => buffs.context,
}));

vi.mock('../../utils/bonus-revenue-calculator.js', () => ({
    calculateBonusRevenue: () => buffs.bonusRevenue,
}));

const { calculateGatheringProfit } = await import('./gathering-profit.js');

const MILK = '/items/milk';
const CHEESE = '/items/cheese';
const COW = '/actions/milking/cow';

/**
 * The action detail map every test shares.
 *
 * It must be shared: gathering-profit.js builds its Milk→Cheese processing
 * conversion cache lazily, once per module load, so the first test to reach
 * that code freezes the conversion table for the whole file. Keeping one map
 * keeps the cache honest.
 */
function actionDetailMap(overrides = {}) {
    return {
        [COW]: {
            type: '/action_types/milking',
            baseTimeCost: 10e9,
            dropTable: [{ itemHrid: MILK, dropRate: 1, minCount: 1, maxCount: 1 }],
            ...overrides,
        },
        // Gives the processing cache its Milk → Cheese entry (1 milk per cheese)
        '/actions/cheesesmithing/cheese': {
            type: '/action_types/cheesesmithing',
            inputItems: [{ itemHrid: MILK, count: 1 }],
            outputItems: [{ itemHrid: CHEESE, count: 1 }],
        },
        // Production action: not a gathering type, so the calculator declines it
        '/actions/brewing/efficiency_tea': {
            type: '/action_types/brewing',
            outputItems: [{ itemHrid: '/items/efficiency_tea', count: 1 }],
        },
    };
}

/**
 * An efficiency context with everything off. Tests turn on one knob at a time.
 * @param {Object} overrides
 */
function efficiencyContext(overrides = {}) {
    return {
        equipment: new Map(),
        drinkSlots: [],
        drinkConcentration: 0,
        actionTime: 10, // seconds → 360 actions/hour
        speedBonus: 0,
        gourmetBonus: 0,
        processingBonus: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        houseEfficiency: 0,
        teaEfficiency: 0,
        achievementEfficiency: 0,
        personalEfficiency: 0,
        totalGathering: 0,
        gatheringDetails: {
            gatheringTea: 0,
            communityGathering: 0,
            achievementGathering: 0,
            personalGathering: 0,
        },
        efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0 },
        efficiencyMultiplier: 1,
        ...overrides,
    };
}

function noBonusRevenue() {
    return {
        totalBonusRevenue: 0,
        essenceFindBonus: 0,
        rareFindBonus: 0,
        rareFindBreakdown: {},
        bonusDrops: [],
        hasMissingPrices: false,
    };
}

beforeEach(() => {
    game.initClientData = {
        actionDetailMap: actionDetailMap(),
        itemDetailMap: {
            [MILK]: { name: 'Milk' },
            [CHEESE]: { name: 'Cheese' },
            '/items/efficiency_tea': { name: 'Efficiency Tea' },
            '/items/gathering_tea': { name: 'Gathering Tea' },
        },
    };
    market.prices = { [MILK]: 100, [CHEESE]: 250 };
    buffs.context = efficiencyContext();
    buffs.bonusRevenue = noBonusRevenue();
    settings.values = { profitCalc_pricingMode: 'hybrid' };
});

describe('calculateGatheringProfit — applicability', () => {
    test('returns null for an unknown action', async () => {
        expect(await calculateGatheringProfit('/actions/milking/nonexistent')).toBeNull();
    });

    test('returns null for a production action', async () => {
        expect(await calculateGatheringProfit('/actions/brewing/efficiency_tea')).toBeNull();
    });

    test('returns null for a gathering action with no drop table', async () => {
        game.initClientData.actionDetailMap[COW].dropTable = undefined;
        expect(await calculateGatheringProfit(COW)).toBeNull();
    });
});

describe('calculateGatheringProfit — baseline drop table math', () => {
    test('pins revenue, tax and profit for a single guaranteed drop', async () => {
        // 3600 / 10s              = 360 actions/hour
        // avg count (1+1)/2       = 1 milk per action
        // items/hour  360 × 1 × 1 = 360
        // revenue     360 × 100         = 36,000
        // tax                           = 36,000 × MARKET_TAX
        // profit      36,000 − tax
        const result = await calculateGatheringProfit(COW);

        expect(result.actionsPerHour).toBe(360);
        expect(result.revenuePerHour).toBe(36000);
        expect(result.profitPerHour).toBeCloseTo(36000 * (1 - MARKET_TAX), 6);
        expect(result.profitPerDay).toBeCloseTo(36000 * (1 - MARKET_TAX) * 24, 6);
        expect(result.profitPerAction).toBeCloseTo((36000 * (1 - MARKET_TAX)) / 360, 6);
        expect(result.drinkCostPerHour).toBe(0);
        expect(result.hasMissingPrices).toBe(false);
    });

    test('pins the per-drop base output row', async () => {
        const result = await calculateGatheringProfit(COW);
        const milk = result.baseOutputs[0];

        expect(milk).toMatchObject({
            itemHrid: MILK,
            name: 'Milk',
            dropRate: 1,
            priceEach: 100,
            missingPrice: false,
        });
        expect(milk.itemsPerHour).toBe(360);
        expect(milk.itemsPerAction).toBe(1);
        expect(milk.revenuePerHour).toBe(36000);
        expect(milk.revenuePerAction).toBe(100);
    });

    test('efficiency multiplies items per hour but not actions per hour', async () => {
        // 150% efficiency → ×2.5 completions
        buffs.context = efficiencyContext({
            efficiencyMultiplier: 2.5,
            efficiencyBreakdown: { totalEfficiency: 150, levelEfficiency: 120 },
        });

        // items/hour 360 × 1 × 2.5 = 900 → revenue 90,000 → tax 90,000 × MARKET_TAX → profit
        const result = await calculateGatheringProfit(COW);

        expect(result.actionsPerHour).toBe(360); // base rate is reported un-multiplied
        expect(result.totalEfficiency).toBe(150);
        expect(result.efficiencyMultiplier).toBe(2.5);
        expect(result.baseOutputs[0].itemsPerHour).toBe(900);
        expect(result.profitPerHour).toBeCloseTo(90000 * (1 - MARKET_TAX), 6);
        // profit/action divides by the EFFECTIVE rate 360 × 2.5 = 900
        expect(result.profitPerAction).toBeCloseTo((90000 * (1 - MARKET_TAX)) / 900, 6);
    });

    test('gathering quantity scales the average drop count', async () => {
        // 20% community + 5% tea = 25% more items per action
        buffs.context = efficiencyContext({
            totalGathering: 0.25,
            gatheringDetails: {
                gatheringTea: 0.05,
                communityGathering: 0.2,
                achievementGathering: 0,
                personalGathering: 0,
            },
        });

        // avg count 1 × 1.25 = 1.25 → 360 × 1.25 = 450/hour → 45,000 revenue
        // tax 45,000 × MARKET_TAX → profit
        const result = await calculateGatheringProfit(COW);

        expect(result.baseOutputs[0].itemsPerHour).toBeCloseTo(450, 6);
        expect(result.profitPerHour).toBeCloseTo(45000 * (1 - MARKET_TAX), 6);
        expect(result.gatheringQuantity).toBe(0.25);
        expect(result.details.communityBuffQuantity).toBe(0.2);
        expect(result.details.gatheringTeaBonus).toBe(0.05);
    });

    test('averages minCount/maxCount and honours a rare drop rate', async () => {
        game.initClientData.actionDetailMap[COW].dropTable = [
            { itemHrid: MILK, dropRate: 1, minCount: 1, maxCount: 1 },
            { itemHrid: CHEESE, dropRate: 0.002, minCount: 1, maxCount: 3 },
        ];

        // rare line: avg (1+3)/2 = 2 → 360 × 0.002 × 2 = 1.44/hour @ 250 = 360/hour
        // total revenue 36,000 + 360 = 36,360 → tax 36,360 × MARKET_TAX → profit
        const result = await calculateGatheringProfit(COW);
        const rare = result.baseOutputs[1];

        expect(rare.itemsPerHour).toBeCloseTo(1.44, 10);
        expect(rare.revenuePerHour).toBeCloseTo(360, 10);
        expect(result.revenuePerHour).toBeCloseTo(36360, 6);
        expect(result.profitPerHour).toBeCloseTo(36360 * (1 - MARKET_TAX), 6);
    });
});

describe('calculateGatheringProfit — drink costs', () => {
    test('charges 12 drinks/hour per slot at buy-side prices', async () => {
        market.prices['/items/efficiency_tea'] = 500;
        market.prices['/items/gathering_tea'] = 300;
        buffs.context = efficiencyContext({
            drinkSlots: [{ itemHrid: '/items/efficiency_tea' }, { itemHrid: '/items/gathering_tea' }],
        });

        // 12/hour each: 500 × 12 = 6,000 and 300 × 12 = 3,600 → 9,600/hour
        // revenue 36,000 − tax (36,000 × MARKET_TAX) − drinks 9,600
        const result = await calculateGatheringProfit(COW);

        expect(result.drinkCostPerHour).toBeCloseTo(9600, 6);
        expect(result.drinkCosts).toHaveLength(2);
        expect(result.drinkCosts[0]).toMatchObject({
            name: 'Efficiency Tea',
            priceEach: 500,
            drinksPerHour: 12,
            costPerHour: 6000,
            missingPrice: false,
        });
        expect(result.profitPerHour).toBeCloseTo(36000 * (1 - MARKET_TAX) - 9600, 6);
    });

    test('drink concentration raises consumption', async () => {
        market.prices['/items/efficiency_tea'] = 500;
        buffs.context = efficiencyContext({
            drinkSlots: [{ itemHrid: '/items/efficiency_tea' }],
            drinkConcentration: 0.15,
        });

        // 12 × 1.15 = 13.8 drinks/hour × 500 = 6,900/hour
        const result = await calculateGatheringProfit(COW);

        expect(result.drinkCosts[0].drinksPerHour).toBeCloseTo(13.8, 10);
        expect(result.drinkCostPerHour).toBeCloseTo(6900, 6);
        expect(result.profitPerHour).toBeCloseTo(36000 - 36000 * MARKET_TAX - 6900, 6);
    });

    test('an unpriced tea costs nothing but flags missing prices', async () => {
        buffs.context = efficiencyContext({
            drinkSlots: [{ itemHrid: '/items/gathering_tea' }],
        });

        const result = await calculateGatheringProfit(COW);

        expect(result.drinkCosts[0].missingPrice).toBe(true);
        expect(result.drinkCostPerHour).toBe(0);
        expect(result.hasMissingPrices).toBe(true);
    });
});

describe('calculateGatheringProfit — Processing Tea', () => {
    test('adds only the net value gained by converting milk to cheese', async () => {
        // 15% proc chance, 1 milk → 1 cheese
        buffs.context = efficiencyContext({ processingBonus: 0.15 });

        // per action: processedIfProcs = floor(1 / 1) = 1, leftover 0
        //   processed/action = 0.15 × 1 = 0.15
        // conversions/hour   = 360 × 1 × 0.15 × 1 (eff) = 54
        // value gain each    = cheese 250 − 1 × milk 100 = 150
        // processing revenue = 54 × 150 = 8,100
        // base revenue still counts all the raw milk: 360 × 100 = 36,000
        // revenue 44,100 → tax 44,100 × MARKET_TAX → profit
        const result = await calculateGatheringProfit(COW);

        expect(result.processingBonus).toBe(0.15);
        expect(result.processingRevenueBonus).toBeCloseTo(8100, 6);
        expect(result.processingRevenueBonusPerAction).toBeCloseTo(22.5, 10); // 0.15 × 150
        expect(result.revenuePerHour).toBeCloseTo(44100, 6);
        expect(result.profitPerHour).toBeCloseTo(44100 * (1 - MARKET_TAX), 6);

        const conversion = result.processingConversions[0];
        expect(conversion).toMatchObject({
            rawItem: 'Milk',
            processedItem: 'Cheese',
            valueGain: 150,
            rawPriceEach: 100,
            processedPriceEach: 250,
            missingPrice: false,
        });
        expect(conversion.conversionsPerHour).toBeCloseTo(54, 10);
        expect(conversion.rawConsumedPerHour).toBeCloseTo(54, 10); // ratio 1:1
    });

    test('processing revenue goes negative when the processed item is worth less', async () => {
        market.prices[CHEESE] = 60; // cheese below the milk that makes it
        buffs.context = efficiencyContext({ processingBonus: 0.5 });

        // conversions/hour 360 × 0.5 = 180, value gain 60 − 100 = −40 → −7,200
        const result = await calculateGatheringProfit(COW);

        expect(result.processingConversions[0].valueGain).toBe(-40);
        expect(result.processingRevenueBonus).toBeCloseTo(-7200, 6);
        expect(result.revenuePerHour).toBeCloseTo(28800, 6); // 36,000 − 7,200
    });

    test('a drop with no conversion recipe is left alone', async () => {
        game.initClientData.actionDetailMap[COW].dropTable = [
            { itemHrid: CHEESE, dropRate: 1, minCount: 1, maxCount: 1 },
        ];
        buffs.context = efficiencyContext({ processingBonus: 0.5 });

        const result = await calculateGatheringProfit(COW);

        expect(result.processingConversions).toEqual([]);
        expect(result.processingRevenueBonus).toBe(0);
        expect(result.revenuePerHour).toBe(360 * 250); // 90,000
    });
});

describe('calculateGatheringProfit — bonus revenue and edge cases', () => {
    test('essence/rare-find revenue is scaled by efficiency', async () => {
        buffs.bonusRevenue = { ...noBonusRevenue(), totalBonusRevenue: 1000 };
        buffs.context = efficiencyContext({
            efficiencyMultiplier: 2,
            efficiencyBreakdown: { totalEfficiency: 100, levelEfficiency: 100 },
        });

        // base 360 × 2 × 100 = 72,000 + bonus 1,000 × 2 = 2,000 → 74,000
        // tax 74,000 × MARKET_TAX → profit
        const result = await calculateGatheringProfit(COW);

        expect(result.revenuePerHour).toBeCloseTo(74000, 6);
        expect(result.profitPerHour).toBeCloseTo(74000 * (1 - MARKET_TAX), 6);
    });

    test('the returned bonusRevenue stays at base actions/hour (display scales it itself)', async () => {
        // profitPerHour folds in efficiency (1,000 → 2,000, per the case above), but the
        // bonusRevenue object handed back is deliberately left at the calculator's raw,
        // pre-efficiency rate: profit-display.js's getBonusDropPerHourTotals(drop,
        // efficiencyMultiplier) is what applies efficiencyMultiplier for display, and it
        // would double it if this object were already scaled.
        buffs.bonusRevenue = {
            ...noBonusRevenue(),
            totalBonusRevenue: 1000,
            bonusDrops: [
                {
                    itemHrid: '/items/prism_shard',
                    itemName: 'Prism Shard',
                    dropRate: 0.01,
                    dropsPerHour: 10,
                    priceEach: 100,
                    revenuePerHour: 1000,
                    type: 'rare_find',
                    missingPrice: false,
                },
            ],
        };
        buffs.context = efficiencyContext({
            efficiencyMultiplier: 2,
            efficiencyBreakdown: { totalEfficiency: 100, levelEfficiency: 100 },
        });

        const result = await calculateGatheringProfit(COW);

        expect(result.bonusRevenue.totalBonusRevenue).toBeCloseTo(1000, 6);
        expect(result.bonusRevenue.bonusDrops[0].revenuePerHour).toBeCloseTo(1000, 6);
        expect(result.bonusRevenue.bonusDrops[0].dropsPerHour).toBeCloseTo(10, 6);
    });

    test('missing bonus-drop prices propagate to hasMissingPrices', async () => {
        buffs.bonusRevenue = { ...noBonusRevenue(), hasMissingPrices: true };

        const result = await calculateGatheringProfit(COW);

        expect(result.hasMissingPrices).toBe(true);
    });

    test('an unpriced drop earns zero and is flagged, not dropped', async () => {
        market.prices = {}; // no market data at all

        const result = await calculateGatheringProfit(COW);

        expect(result.baseOutputs[0].priceEach).toBe(0);
        expect(result.baseOutputs[0].missingPrice).toBe(true);
        expect(result.revenuePerHour).toBe(0);
        expect(result.profitPerHour).toBe(0);
        expect(result.hasMissingPrices).toBe(true);
    });

    test('a genuinely worthless drop is priced at zero without a missing-price flag', async () => {
        market.prices = { [MILK]: 0 };

        const result = await calculateGatheringProfit(COW);

        expect(result.baseOutputs[0].missingPrice).toBe(false);
        expect(result.revenuePerHour).toBe(0);
        expect(result.hasMissingPrices).toBe(false);
    });

    test('action time is floored at the game minimum of 3 seconds', async () => {
        buffs.context = efficiencyContext({ actionTime: 1 });

        // 3600 / 3 = 1200 actions/hour, not 3600
        const result = await calculateGatheringProfit(COW);

        expect(result.actionsPerHour).toBe(1200);
    });

    test('a zero action time yields zero rates rather than Infinity', async () => {
        buffs.context = efficiencyContext({ actionTime: 0 });

        const result = await calculateGatheringProfit(COW);

        expect(result.actionsPerHour).toBe(0);
        expect(result.profitPerHour).toBe(0);
        expect(result.profitPerAction).toBe(0);
    });

    test('carries the pricing mode through for the display layer', async () => {
        settings.values.profitCalc_pricingMode = 'bid';

        const result = await calculateGatheringProfit(COW);

        expect(result.pricingMode).toBe('bid');
    });
});
