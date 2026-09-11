/**
 * Profit Calculator — material cost breakdown, community buff math, skill
 * lookup, production-action lookup and the crafting-cost fallback.
 * `calculateProfit` itself pulls in the full efficiency/bonus-revenue web and
 * is not exercised end-to-end here; these are the self-contained pieces it is
 * built from.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    initData: null,
    itemDetails: {},
    resolvedPrices: {},
    itemPrices: {},
    productionCosts: {},
    chainTimes: {},
    skills: null,
    efficiencyContext: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key], getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
        getSkills: () => mocks.skills,
        getActionDetails: (hrid) => mocks.initData?.actionDetailMap?.[hrid] ?? null,
        getCommunityBuffLevel: () => 0,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => mocks.efficiencyContext }));
vi.mock('../../utils/bonus-revenue-calculator.js', () => ({ calculateBonusRevenue: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getProductionCost: (hrid) => mocks.productionCosts[hrid] ?? 0,
    getProductionChainTime: (hrid) => mocks.chainTimes[hrid] ?? 0,
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => null,
    getItemPrices: (hrid) => mocks.itemPrices?.[hrid] ?? null,
}));
vi.mock('../../utils/profit-constants.js', () => ({ MARKET_TAX: 0.02 }));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculateActionsPerHour: (t) => (t > 0 ? 3600 / Math.max(3, t) : 0),
    calculatePriceAfterTax: (price, tax = 0.02) => price * (1 - tax),
    calculateProfitPerAction: (perHour, actionsPerHour) => (actionsPerHour > 0 ? perHour / actionsPerHour : 0),
    calculateProfitPerDay: (perHour) => perHour * 24,
    calculateTeaCostsPerHour: () => ({ costs: [], totalCostPerHour: 0, hasMissingPrices: false }),
    createPriceCache: (fn) => fn,
    resolveItemPrice: (hrid) =>
        hrid in mocks.resolvedPrices
            ? { price: mocks.resolvedPrices[hrid], custom: false, missing: false }
            : { price: null, custom: false, missing: true },
}));

const { default: profitCalculator } = await import('./profit-calculator.js');

beforeEach(() => {
    mocks.settings = {};
    mocks.initData = { actionDetailMap: {}, communityBuffTypeDetailMap: {} };
    mocks.itemDetails = {};
    mocks.resolvedPrices = {};
    mocks.itemPrices = {};
    mocks.productionCosts = {};
    mocks.chainTimes = {};
    mocks.skills = [];
    mocks.efficiencyContext = {};
    profitCalculator._itemDetailMap = null;
    profitCalculator._actionDetailMap = null;
    profitCalculator._communityBuffMap = null;
});

describe('calculateMaterialCosts', () => {
    test('applies the artisan reduction to regular inputs only', () => {
        mocks.itemDetails['/items/wood'] = { name: 'Wood' };
        mocks.resolvedPrices['/items/wood'] = 100;

        const actionDetails = { inputItems: [{ itemHrid: '/items/wood', count: 10 }] };
        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0.1);

        expect(costs[0].baseAmount).toBe(10);
        expect(costs[0].amount).toBeCloseTo(9, 6); // 10 * (1 - 0.1)
        expect(costs[0].totalCost).toBeCloseTo(900, 6);
    });

    test('coin inputs price at exactly 1, bypassing the resolver', () => {
        const actionDetails = { inputItems: [{ itemHrid: '/items/coin', count: 500 }] };
        mocks.itemDetails['/items/coin'] = { name: 'Coin' };

        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0);
        expect(costs[0].askPrice).toBe(1);
        expect(costs[0].totalCost).toBe(500);
    });

    test('upgrade items are not affected by the artisan reduction', () => {
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.resolvedPrices['/items/rune'] = 1000;

        const actionDetails = { upgradeItemHrid: '/items/rune' };
        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0.5);

        expect(costs[0].amount).toBe(1); // untouched by 50% artisan reduction
        expect(costs[0].isUpgradeItem).toBe(true);
        expect(costs[0].totalCost).toBe(1000);
    });

    test('an upgrade item cheaper to craft than to buy is flagged and priced at craft cost', () => {
        mocks.settings.profitCalc_craftUpgradeItems = true;
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.resolvedPrices['/items/rune'] = 1000; // market price
        mocks.productionCosts['/items/rune'] = 400; // cheaper to craft

        const costs = profitCalculator.calculateMaterialCosts({ upgradeItemHrid: '/items/rune' }, 0);

        expect(costs[0].isCrafted).toBe(true);
        expect(costs[0].askPrice).toBe(400);
    });

    test('a missing price is reported on the row rather than silently zeroed', () => {
        mocks.itemDetails['/items/mystery'] = { name: 'Mystery' };
        const costs = profitCalculator.calculateMaterialCosts(
            { inputItems: [{ itemHrid: '/items/mystery', count: 1 }] },
            0
        );
        expect(costs[0].missingPrice).toBe(true);
        expect(costs[0].totalCost).toBe(0);
    });

    test('an item with no known details is skipped entirely, not included at zero', () => {
        const costs = profitCalculator.calculateMaterialCosts(
            { inputItems: [{ itemHrid: '/items/unknown', count: 1 }] },
            0
        );
        expect(costs).toHaveLength(0);
    });
});

describe('calculateCommunityBuffBonus', () => {
    test('zero buff level is zero bonus, no lookup needed', () => {
        expect(profitCalculator.calculateCommunityBuffBonus(0, '/action_types/milking')).toBe(0);
    });

    test('a buff that does not apply to this action type contributes nothing', () => {
        mocks.initData.communityBuffTypeDetailMap = {
            '/community_buff_types/production_efficiency': {
                usableInActionTypeMap: { '/action_types/cooking': true },
                buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
            },
        };
        expect(profitCalculator.calculateCommunityBuffBonus(5, '/action_types/milking')).toBe(0);
    });

    test('applies the flat boost plus a per-level bonus above level 1', () => {
        mocks.initData.communityBuffTypeDetailMap = {
            '/community_buff_types/production_efficiency': {
                usableInActionTypeMap: { '/action_types/cooking': true },
                buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
            },
        };
        // level 1: just the base 14%
        expect(profitCalculator.calculateCommunityBuffBonus(1, '/action_types/cooking')).toBeCloseTo(14, 6);
        // level 11: 14% + 10 * 0.3%
        expect(profitCalculator.calculateCommunityBuffBonus(11, '/action_types/cooking')).toBeCloseTo(17, 6);
    });
});

describe('getSkillLevel', () => {
    test('maps an action type hrid to its skill and reads the level', () => {
        const skills = [{ skillHrid: '/skills/milking', level: 42 }];
        expect(profitCalculator.getSkillLevel(skills, '/action_types/milking')).toBe(42);
    });

    test('an unknown skill defaults to level 1 rather than throwing', () => {
        expect(profitCalculator.getSkillLevel([], '/action_types/milking')).toBe(1);
    });
});

describe('findProductionAction', () => {
    test('finds the action whose outputItems include the target item', () => {
        mocks.initData.actionDetailMap = {
            '/actions/milking/cow': { outputItems: [{ itemHrid: '/items/milk', count: 1 }] },
        };
        const action = profitCalculator.findProductionAction('/items/milk');
        expect(action.actionHrid).toBe('/actions/milking/cow');
        expect(action.count).toBe(1);
    });

    test('returns null for an item nothing produces', () => {
        mocks.initData.actionDetailMap = { '/actions/milking/cow': { outputItems: [] } };
        expect(profitCalculator.findProductionAction('/items/nonexistent')).toBeNull();
    });

    describe('when two recipes yield the same item', () => {
        /**
         * Two ways to make one cheese: a cheap one and an expensive one, in that
         * order in the map so "the first action" is the wrong answer on purpose.
         * @returns {void}
         */
        function twoRecipes() {
            mocks.initData.actionDetailMap = {
                '/actions/cheesesmithing/wasteful_cheese': {
                    inputItems: [{ itemHrid: '/items/milk', count: 10 }],
                    outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
                },
                '/actions/cheesesmithing/thrifty_cheese': {
                    inputItems: [{ itemHrid: '/items/milk', count: 2 }],
                    outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
                },
            };
            mocks.resolvedPrices['/items/milk'] = 100;
            mocks.resolvedPrices['/items/cheese'] = 2000;
        }

        test('a caller that names the recipe gets that one, not the first in the map', () => {
            twoRecipes();
            const action = profitCalculator.findProductionAction('/items/cheese', {
                actionHrid: '/actions/cheesesmithing/wasteful_cheese',
            });
            expect(action.actionHrid).toBe('/actions/cheesesmithing/wasteful_cheese');
        });

        test('a caller that names no recipe gets the best margin, not the first in the map', () => {
            twoRecipes();
            // wasteful: 2000 - 10*100 = 1000. thrifty: 2000 - 2*100 = 1800.
            const action = profitCalculator.findProductionAction('/items/cheese');
            expect(action.actionHrid).toBe('/actions/cheesesmithing/thrifty_cheese');
        });

        test('the ranking follows the prices, so the winner flips when they do', () => {
            twoRecipes();
            // Milk gets dear enough that ten of it is still ten of it — the cheap
            // recipe stays cheap, so this checks the reverse case honestly: make
            // the thrifty recipe's input the expensive one instead
            mocks.initData.actionDetailMap['/actions/cheesesmithing/thrifty_cheese'].inputItems = [
                { itemHrid: '/items/truffle', count: 1 },
            ];
            mocks.resolvedPrices['/items/truffle'] = 1900;

            const action = profitCalculator.findProductionAction('/items/cheese');
            expect(action.actionHrid).toBe('/actions/cheesesmithing/wasteful_cheese');
        });

        test('both candidates are reported, so a caller can tell there was a choice', () => {
            twoRecipes();
            const action = profitCalculator.findProductionAction('/items/cheese');
            expect(action.candidateActionHrids).toEqual([
                '/actions/cheesesmithing/wasteful_cheese',
                '/actions/cheesesmithing/thrifty_cheese',
            ]);
        });

        test('a recipe whose input cannot be priced loses rather than looking free', () => {
            twoRecipes();
            // The thrifty recipe would win on margin, but its input has no listing
            // and billing it at nothing is how a modest craft becomes a fortune
            delete mocks.resolvedPrices['/items/milk'];
            mocks.initData.actionDetailMap['/actions/cheesesmithing/wasteful_cheese'].inputItems = [
                { itemHrid: '/items/curd', count: 10 },
            ];
            mocks.resolvedPrices['/items/curd'] = 100;

            const action = profitCalculator.findProductionAction('/items/cheese');
            expect(action.actionHrid).toBe('/actions/cheesesmithing/wasteful_cheese');
        });

        test('an action hrid that does not produce the item falls back to the ranking', () => {
            twoRecipes();
            const action = profitCalculator.findProductionAction('/items/cheese', {
                actionHrid: '/actions/milking/cow',
            });
            expect(action.actionHrid).toBe('/actions/cheesesmithing/thrifty_cheese');
        });

        test('one recipe needs no ranking and still reports itself as the only candidate', () => {
            mocks.initData.actionDetailMap = {
                '/actions/milking/cow': { outputItems: [{ itemHrid: '/items/milk', count: 1 }] },
            };
            const action = profitCalculator.findProductionAction('/items/milk');
            expect(action.actionHrid).toBe('/actions/milking/cow');
            expect(action.candidateActionHrids).toEqual(['/actions/milking/cow']);
        });
    });
});

describe('calculateCraftingCostFallback', () => {
    test('sums priced inputs plus the upgrade item, divided by output count', () => {
        mocks.initData.actionDetailMap = {
            '/actions/craft/thing': {
                upgradeItemHrid: '/items/rune',
                inputItems: [{ itemHrid: '/items/wood', count: 4 }],
                outputItems: [{ itemHrid: '/items/thing', count: 2 }],
            },
        };
        const getCachedPrice = (hrid) => ({ '/items/rune': 100, '/items/wood': 10 })[hrid] ?? 0;

        const cost = profitCalculator.calculateCraftingCostFallback('/items/thing', getCachedPrice);
        // (100 + 4*10) / 2 = 70
        expect(cost).toBe(70);
    });

    test('an item with no crafting action falls back to zero', () => {
        mocks.initData.actionDetailMap = {};
        expect(profitCalculator.calculateCraftingCostFallback('/items/nothing', () => 0)).toBe(0);
    });
});

describe('calculateProfit — upgrade-item crafting chain time', () => {
    /**
     * Minimal but complete efficiency context: `calculateProfit` destructures it
     * wholesale, so every field it reads has to exist even when it is zero.
     * @returns {object} the mocked context
     */
    function baseEfficiencyContext() {
        return {
            equipment: [],
            drinkSlots: [],
            drinkConcentration: 0,
            itemDetailMap: {},
            actionTime: 20,
            artisanBonus: 0,
            gourmetBonus: 0,
            processingBonus: 0,
            equipmentEfficiency: 0,
            equipmentEfficiencyItems: [],
            houseEfficiency: 0,
            teaEfficiency: 0,
            achievementEfficiency: 0,
            personalEfficiency: 0,
            actionLevelBonus: 0,
            teaSkillLevelBonus: 0,
            baseRequirement: 1,
            speedBonus: 0,
            personalSpeedBonus: 0,
            efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0, effectiveRequirement: 1 },
            efficiencyMultiplier: 1,
        };
    }

    /**
     * An upgrade recipe whose upgrade item takes 30s of chain time to craft.
     * @returns {void}
     */
    function upgradeRecipe() {
        mocks.settings.profitCalc_craftUpgradeItems = true;
        mocks.efficiencyContext = baseEfficiencyContext();
        mocks.skills = [{ skillHrid: '/skills/cheesesmithing', level: 50 }];
        mocks.itemDetails['/items/upgraded'] = { name: 'Upgraded' };
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.initData.actionDetailMap = {
            '/actions/cheesesmithing/upgrade': {
                type: '/action_types/cheesesmithing',
                baseTimeCost: 20e9,
                upgradeItemHrid: '/items/rune',
                inputItems: [],
                outputItems: [{ itemHrid: '/items/upgraded', count: 1 }],
            },
        };
        mocks.chainTimes['/items/rune'] = 30;
        mocks.productionCosts['/items/rune'] = 400;
    }

    test('an unpriced upgrade item still charges the crafting chain time', async () => {
        upgradeRecipe();
        // no entry in resolvedPrices → resolveItemPrice returns price: null (unpriceable)

        const result = await profitCalculator.calculateProfit('/items/upgraded');

        // 20s action + 30s chain, not the bare 20s the null-price branch used to leave
        expect(result.actionTime).toBeCloseTo(50, 6);
    });

    test('an upgrade item cheaper on the market than to craft is bought, so no chain time', async () => {
        upgradeRecipe();
        mocks.resolvedPrices['/items/rune'] = 100; // cheaper than the 400 craft cost

        const result = await profitCalculator.calculateProfit('/items/upgraded');

        expect(result.actionTime).toBeCloseTo(20, 6);
    });
});

describe('calculateProfit — itemPrice reconciliation', () => {
    /**
     * A one-input recipe with no upgrade item, priced entirely through
     * `resolveItemPrice`/`getItemPrices` — the minimum shape `calculateProfit` needs.
     * @returns {void}
     */
    function simpleRecipe() {
        mocks.efficiencyContext = {
            equipment: [],
            drinkSlots: [],
            drinkConcentration: 0,
            itemDetailMap: {},
            actionTime: 10,
            artisanBonus: 0,
            gourmetBonus: 0,
            processingBonus: 0,
            equipmentEfficiency: 0,
            equipmentEfficiencyItems: [],
            houseEfficiency: 0,
            teaEfficiency: 0,
            achievementEfficiency: 0,
            personalEfficiency: 0,
            actionLevelBonus: 0,
            teaSkillLevelBonus: 0,
            baseRequirement: 1,
            speedBonus: 0,
            personalSpeedBonus: 0,
            efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0, effectiveRequirement: 1 },
            efficiencyMultiplier: 1,
        };
        mocks.skills = [{ skillHrid: '/skills/cheesesmithing', level: 50 }];
        mocks.itemDetails['/items/cheese'] = { name: 'Cheese' };
        mocks.itemDetails['/items/milk'] = { name: 'Milk' };
        mocks.initData.actionDetailMap = {
            '/actions/cheesesmithing/cheese': {
                type: '/action_types/cheesesmithing',
                baseTimeCost: 10e9,
                inputItems: [{ itemHrid: '/items/milk', count: 1 }],
                outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
            },
        };
        mocks.resolvedPrices['/items/milk'] = 10;
        mocks.resolvedPrices['/items/cheese'] = 100;
    }

    // profit-calculator.js used to read the tooltipped item's own ask/bid straight off
    // `marketAPI.getPrice`, bypassing the value-map reconciliation `getItemPrices` (and the
    // output price a few lines below) already goes through. An item whose live order book is
    // empty but which the value-filling patch still prices came back {ask: 0, bid: 0} from
    // that raw call, which made every `itemPrice.ask > 0` gate downstream (the tooltip's
    // profit-vs-cost-only switch, the own-use "buy" figure) report "no market data" for an
    // item this very function had just priced and computed a profit for.
    test('itemPrice comes from the reconciled getItemPrices, not the raw order book', async () => {
        simpleRecipe();
        // The raw order book is empty (marketplace.js mock always returns null), but the
        // value-filling patch still prices the item — getItemPrices reports that.
        mocks.itemPrices['/items/cheese'] = {
            ask: 120,
            bid: 110,
            average: 115,
            askEstimated: true,
            bidEstimated: true,
        };

        const result = await profitCalculator.calculateProfit('/items/cheese');

        expect(result.itemPrice).toEqual({ ask: 120, bid: 110, average: 115, askEstimated: true, bidEstimated: true });
    });

    test('falls back to {ask: 0, bid: 0} when even the reconciled lookup has nothing', async () => {
        simpleRecipe();
        // mocks.itemPrices has no entry for '/items/cheese' → getItemPrices returns null

        const result = await profitCalculator.calculateProfit('/items/cheese');

        expect(result.itemPrice).toEqual({ ask: 0, bid: 0 });
    });
});

describe('calculateMaterialCosts — provenance of a craft-substituted upgrade price', () => {
    test('the craft cost is flagged estimated, like the resolver flags its own fallback', () => {
        mocks.settings.profitCalc_craftUpgradeItems = true;
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.resolvedPrices['/items/rune'] = 1000;
        mocks.productionCosts['/items/rune'] = 400;

        const costs = profitCalculator.calculateMaterialCosts({ upgradeItemHrid: '/items/rune' }, 0);

        expect(costs[0].isCrafted).toBe(true);
        expect(costs[0].estimatedPrice).toBe(true);
    });
});
