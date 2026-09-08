/**
 * Networth Calculator — per-item valuation rules and the house/ability
 * category totals. Most tests drive `calculateItemValue`,
 * `calculateAllHousesCost` and `calculateAllAbilitiesCost` directly against a
 * mocked game and market; the last two blocks drive the full `calculateNetworth`
 * sweep, for the two things only the sweep decides — which prices reach the
 * worker, and which items get priced at all.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    initData: null,
    itemDetails: {},
    itemPrices: {}, // itemHrid -> {ask, bid}
    enhancementPaths: {}, // `${hrid}:${level}` -> totalCost
    taskTokenValue: null,
    dungeonTokenValues: {},
    shopCosts: {},
    unpricedAbilities: new Set(),
    marketValues: null, // { marketValuesVersion, marketItemValues } for getMarketItemValues()
    combinedData: null, // what calculateNetworth sweeps: characterItems, itemDetailMap, ...
    batchPrices: {}, // "hrid:level" -> {ask, bid}, for getPricesBatch
    excluded: new Set(), // "type:value" pairs isExcluded() answers true for
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getCombinedData: () => mocks.combinedData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
        getMarketItemValues: () => mocks.marketValues,
        characterGuildBuffMap: null,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (hrid) => mocks.itemPrices[hrid] ?? null,
        isLoaded: () => true,
        fetch: async () => ({}),
        marketData: {},
        getPricesBatch: (items) => {
            const cache = new Map();
            for (const { itemHrid, enhancementLevel = 0 } of items) {
                const key = `${itemHrid}:${enhancementLevel}`;
                if (cache.has(key)) continue;
                const prices = mocks.batchPrices[key] ?? (enhancementLevel === 0 ? mocks.itemPrices[itemHrid] : null);
                if (prices) cache.set(key, prices);
            }
            return cache;
        },
    },
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    // Null total is "the book has no listing", which the caller must not read as free
    explainAbilityCost: (hrid, level) =>
        mocks.unpricedAbilities.has(hrid) ? { books: 7, total: null } : { books: level, total: level * 1000 },
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateHouseBuildCost: (hrid, level) => level * 500,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (hrid, level) => {
        const key = `${hrid}:${level}`;
        return key in mocks.enhancementPaths ? { optimalStrategy: { totalCost: mocks.enhancementPaths[key] } } : null;
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../tasks/task-profit-calculator.js', () => ({
    calculateTaskTokenValue: () => mocks.taskTokenValue,
}));
vi.mock('../../utils/token-valuation.js', () => ({
    calculateDungeonTokenValue: (hrid) => mocks.dungeonTokenValues[hrid] ?? null,
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { isInitialized: false, calculateExpectedValue: () => null },
}));
vi.mock('./networth-cache.js', () => ({
    default: { get: () => null, set: () => {}, checkAndInvalidate: () => {} },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, opts) => {
        const p = mocks.itemPrices[hrid];
        if (!p) return null;
        return opts?.mode === 'bid' ? p.bid : p.ask;
    },
    getItemPrices: (hrid) => mocks.itemPrices[hrid] ?? null,
}));
vi.mock('../../utils/networth-worker-manager.js', () => ({ calculateItemValueBatch: vi.fn() }));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: (hrid) => mocks.shopCosts[hrid] ?? 0 }));
vi.mock('./networth-exclusions.js', () => ({
    isExcluded: (type, value) => mocks.excluded.has(`${type}:${value}`),
    getExclusions: () =>
        [...mocks.excluded].map((entry) => {
            const split = entry.indexOf(':');
            return { type: entry.slice(0, split), value: entry.slice(split + 1) };
        }),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
// Guild credits are never listed, so their gold value comes from conversions.
// Priced here at a flat rate so the shrine arithmetic is the only thing under test.
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: (mode) => ({ '/items/guild_credit_1': mode === 'bid' ? 500 : 750 }),
    priceGuildCreditCosts: (costs, { goldPerCredit }) => ({
        lines: (costs || []).map(({ itemHrid, count }) => {
            const each = goldPerCredit[itemHrid] ?? null;
            return { itemHrid, count, goldEach: each, gold: each === null ? null : each * count };
        }),
        total: null,
        unpriced: [],
    }),
}));

const { calculateItemValueBatch: workerBatch } = await import('../../utils/networth-worker-manager.js');
const {
    calculateNetworth,
    calculateItemValue,
    calculateCraftingCost,
    calculateAllHousesCost,
    calculateAllAbilitiesCost,
    calculateGuildShrinesCost,
    isUnpricedCurrency,
} = await import('./networth-calculator.js');
const { _resetMarketValues } = await import('../../utils/market-values.js');

beforeEach(() => {
    mocks.settings = {};
    mocks.initData = { houseRoomDetailMap: {} };
    mocks.itemDetails = {};
    mocks.itemPrices = {};
    mocks.enhancementPaths = {};
    mocks.taskTokenValue = null;
    mocks.dungeonTokenValues = {};
    mocks.shopCosts = {};
    mocks.unpricedAbilities = new Set();
    mocks.marketValues = null;
    mocks.combinedData = null;
    mocks.batchPrices = {};
    mocks.excluded = new Set();
    workerBatch.mockReset();
    _resetMarketValues();
});

describe('calculateItemValue', () => {
    test('an unenhanced item prices at the configured mode, scaled by count', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/wood'] = { ask: 100, bid: 90 };

        const value = await calculateItemValue({ itemHrid: '/items/wood', enhancementLevel: 0, count: 5 });
        expect(value).toBe(500);
    });

    test('coins are worth exactly their count, no market lookup needed', async () => {
        const value = await calculateItemValue({ itemHrid: '/items/coin', enhancementLevel: 0, count: 12345 });
        expect(value).toBe(12345);
    });

    test('a low-enhancement item with a market price uses that price directly', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/sword'] = { ask: 1000, bid: 900 };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 1 });
        expect(value).toBe(1000);
    });

    test('a low-enhancement item with no market data falls back to the enhancement path cost', async () => {
        mocks.enhancementPaths['/items/sword:3'] = 4200;

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 2 });
        expect(value).toBe(8400);
    });

    test('high-enhancement items use enhancement cost even when a market price exists, once the setting is on', async () => {
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.itemPrices['/items/sword'] = { ask: 999999999, bid: 1 };
        mocks.enhancementPaths['/items/sword:15'] = 50000;

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 15, count: 1 });
        expect(value).toBe(50000);
    });

    test('high-enhancement items stay on market pricing below the configured minimum level', async () => {
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.itemPrices['/items/sword'] = { ask: 1000, bid: 900 };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 10, count: 1 });
        expect(value).toBe(1000);
    });

    test('a cowbell prices as a tenth of the bag when the setting is enabled', async () => {
        mocks.settings.networth_includeCowbells = true;
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/bag_of_10_cowbells'] = { ask: 2_000_000, bid: 1_800_000 };

        const value = await calculateItemValue({ itemHrid: '/items/cowbell', enhancementLevel: 0, count: 10 });
        expect(value).toBe(200_000 * 10);
    });

    test('cowbells are excluded entirely (priced at 0) when the setting is off', async () => {
        mocks.settings.networth_includeCowbells = false;
        mocks.itemPrices['/items/bag_of_10_cowbells'] = { ask: 2_000_000, bid: 1_800_000 };

        const value = await calculateItemValue({ itemHrid: '/items/cowbell', enhancementLevel: 0, count: 10 });
        expect(value).toBe(0);
    });

    test('task tokens use the shop-derived token value when available', async () => {
        mocks.settings.networth_includeTaskTokens = true;
        mocks.taskTokenValue = { tokenValue: 2500 };

        const value = await calculateItemValue({ itemHrid: '/items/task_token', enhancementLevel: 0, count: 4 });
        expect(value).toBe(10000);
    });

    test('task tokens are unvalued, not guessed at, before the shop can be read', async () => {
        // The task shop is what prices a token; until market data arrives there is no
        // honest figure. A stand-in 30,000 apiece put a five-figure phantom in the total
        // that moved on its own and settled somewhere else once prices loaded.
        mocks.settings.networth_includeTaskTokens = true;
        mocks.taskTokenValue = { tokenValue: null, error: 'Market data not loaded' };

        const value = await calculateItemValue({ itemHrid: '/items/task_token', enhancementLevel: 0, count: 400 });
        expect(value).toBe(0);
    });

    test('an openable container with no market price falls back to its expected value net of key cost', async () => {
        // No market data, not high enhancement, level 0 -> should hit crafting/shop fallback path (0 here)
        mocks.itemDetails['/items/crate'] = { isOpenable: true };
        const value = await calculateItemValue({ itemHrid: '/items/crate', enhancementLevel: 0, count: 1 });
        expect(value).toBe(0); // expectedValueCalculator mocked as uninitialized
    });

    test('an item with no market data and no craftable recipe falls back to shop cost', async () => {
        mocks.shopCosts['/items/shop_item'] = 250;
        const value = await calculateItemValue({ itemHrid: '/items/shop_item', enhancementLevel: 0, count: 3 });
        expect(value).toBe(750);
    });

    test("value source 'officialValue' prices from the game's market value, ignoring the order book", async () => {
        mocks.settings.networth_valueSource = 'officialValue';
        mocks.settings.networth_pricingMode = 'bid';
        mocks.itemPrices['/items/sword'] = { ask: 999, bid: 1 }; // order book ignored
        mocks.marketValues = { marketValuesVersion: 1, marketItemValues: { '/items/sword': { 3: 5000 } } };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 2 });
        expect(value).toBe(10000);
    });

    test("value source 'orderBook' clamps a stale order-book price into the tradable range", async () => {
        mocks.settings.networth_valueSource = 'orderBook';
        mocks.settings.networth_pricingMode = 'ask';
        // Stale ask five times the value; band max is value * 1.1
        mocks.itemPrices['/items/wood'] = { ask: 5000, bid: 900 };
        mocks.marketValues = { marketValuesVersion: 1, marketItemValues: { '/items/wood': { 0: 1000 } } };

        const value = await calculateItemValue({ itemHrid: '/items/wood', enhancementLevel: 0, count: 1 });
        expect(value).toBe(1105); // band max for value 1000 under the increment ladder, not 5000
    });
});

describe('calculateAllHousesCost', () => {
    test('sums build cost across rooms, skipping level-0 rooms', () => {
        mocks.initData.houseRoomDetailMap = {
            '/house_rooms/dojo': { name: 'Dojo' },
            '/house_rooms/kitchen': { name: 'Kitchen' },
        };
        const result = calculateAllHousesCost({
            '/house_rooms/dojo': { level: 4 },
            '/house_rooms/kitchen': { level: 0 },
        });

        expect(result.totalCost).toBe(2000); // 4 * 500
        expect(result.breakdown).toHaveLength(1);
        expect(result.breakdown[0].name).toBe('Dojo');
    });

    test('breakdown is sorted by cost descending', () => {
        mocks.initData.houseRoomDetailMap = {
            '/house_rooms/a': { name: 'A' },
            '/house_rooms/b': { name: 'B' },
        };
        const result = calculateAllHousesCost({
            '/house_rooms/a': { level: 1 },
            '/house_rooms/b': { level: 5 },
        });
        expect(result.breakdown.map((r) => r.name)).toEqual(['B', 'A']);
    });
});

describe('calculateAllAbilitiesCost', () => {
    test('splits total cost into equipped and other, and sums correctly', () => {
        const abilities = [
            { abilityHrid: '/abilities/fireball', level: 3 },
            { abilityHrid: '/abilities/heal', level: 2 },
        ];
        const equipped = { '/abilities/fireball': {} };

        const result = calculateAllAbilitiesCost(abilities, equipped);

        expect(result.totalCost).toBe(3000 + 2000);
        expect(result.equippedCost).toBe(3000);
        expect(result.equippedBreakdown.map((a) => a.hrid)).toEqual(['/abilities/fireball']);
        expect(result.otherBreakdown.map((a) => a.hrid)).toEqual(['/abilities/heal']);
    });

    test('an ability whose book has no listing is marked unpriced, not counted as free', () => {
        mocks.unpricedAbilities.add('/abilities/heal');
        const abilities = [
            { abilityHrid: '/abilities/fireball', level: 3 },
            { abilityHrid: '/abilities/heal', level: 2 },
        ];

        const result = calculateAllAbilitiesCost(abilities, {});

        expect(result.totalCost).toBe(3000);
        const heal = result.breakdown.find((a) => a.hrid === '/abilities/heal');
        expect(heal.unpriced).toBe(true);
        // Still says how many books, which is the part the market cannot answer
        expect(heal.books).toBe(7);
    });

    test('level-0 abilities are skipped entirely', () => {
        const result = calculateAllAbilitiesCost([{ abilityHrid: '/abilities/unlearned', level: 0 }], {});
        expect(result.totalCost).toBe(0);
        expect(result.breakdown).toHaveLength(0);
    });

    test('an empty ability list returns a fully-zeroed structure without throwing', () => {
        const result = calculateAllAbilitiesCost([], {});
        expect(result).toEqual({
            totalCost: 0,
            equippedCost: 0,
            breakdown: [],
            equippedBreakdown: [],
            otherBreakdown: [],
        });
    });
});

describe('calculateGuildShrinesCost', () => {
    const CREDIT = '/items/guild_credit_1';

    beforeEach(() => {
        mocks.initData.guildBuffDetailMap = {
            '/guild_buffs/force_combat': {
                shrineHrid: '/guild_shrines/force',
                isCombat: true,
                levelCosts: {
                    1: { guildTokenCost: 10, creditCosts: [{ itemHrid: CREDIT, count: 10 }] },
                    2: { guildTokenCost: 20, creditCosts: [{ itemHrid: CREDIT, count: 20 }] },
                    3: { guildTokenCost: 30, creditCosts: [{ itemHrid: CREDIT, count: 40 }] },
                },
            },
            '/guild_buffs/scholar_skilling': {
                shrineHrid: '/guild_shrines/scholar',
                isCombat: false,
                levelCosts: { 1: { guildTokenCost: 5, creditCosts: [{ itemHrid: CREDIT, count: 4 }] } },
            },
        };
    });

    /**
     * A shrine map in the shape data-manager holds it.
     * @param {Object} levels - buffHrid → level
     * @returns {Object} characterGuildBuffMap
     */
    function shrines(levels) {
        const map = {};
        for (const [hrid, level] of Object.entries(levels)) map[hrid] = { guildBuffHrid: hrid, level };
        return map;
    }

    test('every level bought so far is charged, not just the current one', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 3 }));

        // levels 1+2+3 = 10+20+40 = 70 credits at 750 gold each
        expect(result.totalCost).toBe(52_500);
        expect(result.tokens).toBe(60);
        expect(result.known).toBe(true);
    });

    test('the pricing mode reaches the credit conversion, like the rest of net worth', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 1 }), 'bid');

        expect(result.totalCost).toBe(5000); // 10 credits at the bid rate of 500
    });

    test('shrines are listed separately, named per buff, sorted by cost', () => {
        const result = calculateGuildShrinesCost(
            shrines({ '/guild_buffs/scholar_skilling': 1, '/guild_buffs/force_combat': 2 })
        );

        expect(result.breakdown.map((r) => r.name)).toEqual(['Force Combat 2', 'Scholar Skilling 1']);
        expect(result.breakdown[0]).toMatchObject({ hrid: '/guild_buffs/force_combat', level: 2, tokens: 30 });
        expect(result.totalCost).toBe(22_500 + 3000);
    });

    test('tokens are counted but never priced into the gold total', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/scholar_skilling': 1 }));

        expect(result.tokens).toBe(5);
        expect(result.totalCost).toBe(3000); // 4 credits at 750, and nothing for the 5 tokens
    });

    test('a shrine at level 0 contributes no row', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 0 }));

        expect(result.totalCost).toBe(0);
        expect(result.breakdown).toEqual([]);
        expect(result.known).toBe(true);
    });

    test('levels that never reached the client read as unknown, not as zero', () => {
        expect(calculateGuildShrinesCost(undefined).known).toBe(false);
        expect(calculateGuildShrinesCost(null).known).toBe(false);
        expect(calculateGuildShrinesCost({}).known).toBe(false);
        expect(calculateGuildShrinesCost({}).breakdown).toEqual([]);
    });

    test('without the game cost table there is nothing to price, so nothing is claimed', () => {
        mocks.initData.guildBuffDetailMap = undefined;

        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 3 }));

        expect(result).toEqual({ totalCost: 0, tokens: 0, breakdown: [], known: false });
    });

    test('a buff the cost table does not know is skipped rather than counted as free', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/mystery_shrine': 5 }));

        expect(result.breakdown).toEqual([]);
        expect(result.totalCost).toBe(0);
    });
});

describe('isUnpricedCurrency', () => {
    test('task tokens are unpriced while the shop cannot be read', () => {
        mocks.settings.networth_includeTaskTokens = true;
        mocks.taskTokenValue = { tokenValue: null, error: 'Market data not loaded' };

        // 0 and "no figure yet" look identical in a total; only one is worth saying
        expect(isUnpricedCurrency('/items/task_token')).toBe(true);
    });

    test('a token the shop can price is not unpriced', () => {
        mocks.settings.networth_includeTaskTokens = true;
        mocks.taskTokenValue = { tokenValue: 2500 };

        expect(isUnpricedCurrency('/items/task_token')).toBe(false);
    });

    test('tokens the user excluded on purpose are not reported as unpriced', () => {
        mocks.settings.networth_includeTaskTokens = false;
        mocks.taskTokenValue = { tokenValue: null, error: 'Market data not loaded' };

        expect(isUnpricedCurrency('/items/task_token')).toBe(false);
    });

    test('an ordinary item is never a currency', () => {
        expect(isUnpricedCurrency('/items/cheese')).toBe(false);
    });
});

/**
 * The worker computes its own craft-cost fallback from a pruned recipe index,
 * and every difference between its arithmetic and calculateCraftingCost's is a
 * silent valuation split between two items in the same inventory. These drive
 * the real worker source (captured off the Blob the manager builds) against the
 * real main-thread function over the same fixture.
 */
describe('craft-cost parity between the main thread and the worker', () => {
    /**
     * The worker source the manager ships, with its production-cost helper
     * exposed. Built once: the manager memoises its pool, and a memoised pool
     * builds no second Blob.
     */
    let workerProductionCostMemo = null;
    async function loadWorkerProductionCost() {
        if (workerProductionCostMemo) return workerProductionCostMemo;
        let captured = null;
        vi.stubGlobal(
            'Blob',
            class {
                constructor(parts) {
                    captured = parts[0];
                }
            }
        );
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
        // The mock at the top of this file stands in for the manager everywhere
        // else; here the real one is wanted, for the source it generates.
        const manager = await vi.importActual('../../utils/networth-worker-manager.js');
        // No real Worker here, so pool creation throws once the Blob exists
        await manager.calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} }).catch(() => {});
        vi.unstubAllGlobals();
        expect(captured).toBeTruthy();
        workerProductionCostMemo = new Function('self', `${captured}\n; return calculateProductionCost;`)({
            postMessage: () => {},
            onmessage: null,
        });
        return workerProductionCostMemo;
    }

    /** The pruned shapes the manager ships, built off the same fixture. */
    function shippedContext() {
        const priceMap = {};
        for (const [hrid, prices] of Object.entries(mocks.itemPrices)) {
            priceMap[`${hrid}:0_ask`] = prices.ask;
            priceMap[`${hrid}:0_bid`] = prices.bid;
            const mode = prices[mocks.settings.networth_pricingMode || 'ask'];
            if (mode > 0) priceMap[`${hrid}:0`] = mode;
        }
        const recipes = {};
        for (const action of Object.values(mocks.initData.actionDetailMap)) {
            for (const output of action.outputItems || []) {
                if (output.itemHrid in recipes) continue;
                recipes[output.itemHrid] = {
                    inputItems: action.inputItems || null,
                    upgradeItemHrid: action.upgradeItemHrid || null,
                    outputCount: output.count || 1,
                };
            }
        }
        return { priceMap, recipes };
    }

    test('a batch recipe costs one item, not the whole batch, on both threads', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.initData = {
            houseRoomDetailMap: {},
            actionDetailMap: {
                '/actions/saw_planks': {
                    outputItems: [{ itemHrid: '/items/plank', count: 10 }],
                    inputItems: [{ itemHrid: '/items/log', count: 3 }],
                },
            },
        };
        mocks.itemPrices['/items/log'] = { ask: 10, bid: 6 };

        // 3 logs x 10, Artisan Tea 0.9, split ten ways = 2.7 apiece
        const fromMain = calculateCraftingCost('/items/plank');
        expect(fromMain).toBeCloseTo(2.7, 9);

        const workerProductionCost = await loadWorkerProductionCost();
        const { priceMap, recipes } = shippedContext();
        expect(workerProductionCost('/items/plank', priceMap, recipes)).toBeCloseTo(fromMain, 9);
    });

    test('a by-product is priced by the action that makes it, on both threads', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.initData = {
            houseRoomDetailMap: {},
            actionDetailMap: {
                '/actions/smelt_bar': {
                    outputItems: [
                        { itemHrid: '/items/iron_bar', count: 1 },
                        { itemHrid: '/items/slag', count: 2 },
                    ],
                    inputItems: [{ itemHrid: '/items/ore', count: 4 }],
                },
            },
        };
        mocks.itemPrices['/items/ore'] = { ask: 5, bid: 3 };

        // Indexing on the primary output alone left slag with no recipe at all
        // in the worker, so a by-product stack priced at zero there and at 9
        // apiece on the main thread.
        const barFromMain = calculateCraftingCost('/items/iron_bar');
        const slagFromMain = calculateCraftingCost('/items/slag');
        expect(barFromMain).toBeCloseTo(18, 9);
        expect(slagFromMain).toBeCloseTo(9, 9);

        const workerProductionCost = await loadWorkerProductionCost();
        const { priceMap, recipes } = shippedContext();
        expect(workerProductionCost('/items/iron_bar', priceMap, recipes)).toBeCloseTo(barFromMain, 9);
        expect(workerProductionCost('/items/slag', priceMap, recipes)).toBeCloseTo(slagFromMain, 9);
    });

    test('both threads price craft inputs at the configured mode', async () => {
        mocks.settings.networth_pricingMode = 'bid';
        mocks.initData = {
            houseRoomDetailMap: {},
            actionDetailMap: {
                '/actions/saw_planks': {
                    outputItems: [{ itemHrid: '/items/plank', count: 2 }],
                    inputItems: [{ itemHrid: '/items/log', count: 3 }],
                },
            },
        };
        mocks.itemPrices['/items/log'] = { ask: 10, bid: 6 };

        // 3 x 6 x 0.9 / 2 = 8.1 — on the ask side it would be 13.5
        const fromMain = calculateCraftingCost('/items/plank');
        expect(fromMain).toBeCloseTo(8.1, 9);

        const workerProductionCost = await loadWorkerProductionCost();
        const { priceMap, recipes } = shippedContext();
        expect(workerProductionCost('/items/plank', priceMap, recipes)).toBeCloseTo(fromMain, 9);
    });
});

/**
 * What the worker is actually handed. The worker cannot afford to reconcile
 * prices itself — that is the main thread's `resolveNetworthPrices`, official
 * value map and all — so the manager has to hand it prices that are already
 * reconciled, or the two threads price the same illiquid item differently.
 * These drive the real `calculateNetworth` and read the price map off the
 * (mocked) worker call.
 */
describe('the price map the worker batch is handed', () => {
    /** Run a full sweep over one inventory item and return the shipped price map. */
    async function shippedPriceMap(item) {
        mocks.combinedData = {
            characterItems: [{ ...item, itemLocationHrid: '/item_locations/inventory' }],
            myMarketListings: [],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: mocks.itemDetails,
        };
        workerBatch.mockResolvedValue([0]);
        await calculateNetworth();
        expect(workerBatch).toHaveBeenCalled();
        return workerBatch.mock.calls[0][1];
    }

    beforeEach(() => {
        // Always a worker item, so the batch is always built
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemDetails['/items/iron_sword'] = { itemLevel: 10, name: 'Iron Sword' };
        mocks.initData = {
            houseRoomDetailMap: {},
            actionDetailMap: {
                '/actions/craft_sword': {
                    outputItems: [{ itemHrid: '/items/iron_sword', count: 1 }],
                    inputItems: [{ itemHrid: '/items/iron_bar', count: 2 }],
                },
            },
        };
    });

    test('a side the order book leaves empty is filled from the official value, as it is on this thread', async () => {
        mocks.settings.networth_valueSource = 'orderBook';
        // Nobody is selling iron bar; the game still publishes a value for it
        mocks.itemPrices['/items/iron_bar'] = { ask: null, bid: 100 };
        mocks.itemPrices['/items/iron_sword'] = { ask: 3000, bid: 2900 };
        mocks.marketValues = {
            marketValuesVersion: 1,
            marketItemValues: { '/items/iron_bar': { 0: 500 } },
        };

        // The main thread already prices the bar at the value, so the craft cost
        // it derives is 2 x 500 x 0.9 = 900
        expect(calculateCraftingCost('/items/iron_sword')).toBeCloseTo(900, 9);

        const priceMap = await shippedPriceMap({ itemHrid: '/items/iron_sword', enhancementLevel: 14, count: 1 });
        // Raw ask stayed raw — the worker's enhancement path mirrors the main
        // thread's, which reads the clamped order book and never reconciles
        expect(priceMap['/items/iron_bar:0_ask']).toBe(null);
        expect(priceMap['/items/iron_bar:0_bid']).toBe(100);
        // ...but the base key, which is what the craft-cost fallback reads, is
        // the reconciled figure and not "no price at all"
        expect(priceMap['/items/iron_bar:0']).toBe(500);
    });

    test("value source 'officialValue' reaches the worker too", async () => {
        mocks.settings.networth_valueSource = 'officialValue';
        mocks.itemPrices['/items/iron_bar'] = { ask: 40, bid: 30 };
        mocks.itemPrices['/items/iron_sword'] = { ask: 3000, bid: 2900 };
        mocks.marketValues = {
            marketValuesVersion: 1,
            marketItemValues: { '/items/iron_bar': { 0: 500 } },
        };

        const priceMap = await shippedPriceMap({ itemHrid: '/items/iron_sword', enhancementLevel: 14, count: 1 });
        // The setting says ignore the book, and the worker now hears that
        expect(priceMap['/items/iron_bar:0']).toBe(500);
    });

    test('a stale order-book price ships banded', async () => {
        mocks.settings.networth_valueSource = 'orderBook';
        // Ask parked five times the value: no order could reach it. marketAPI
        // already bands what it caches, so this is belt and braces — but it is
        // the band the main thread applies, and the worker must see the same one.
        mocks.itemPrices['/items/iron_bar'] = { ask: 5000, bid: 900 };
        mocks.itemPrices['/items/iron_sword'] = { ask: 3000, bid: 2900 };
        mocks.marketValues = {
            marketValuesVersion: 1,
            marketItemValues: { '/items/iron_bar': { 0: 1000 } },
        };

        const priceMap = await shippedPriceMap({ itemHrid: '/items/iron_sword', enhancementLevel: 14, count: 1 });
        expect(priceMap['/items/iron_bar:0']).toBe(1105);
    });
});

/**
 * Which items get a live price at all. The batch fetch feeds both threads, but
 * only the worker reaches for enhancement materials and protection items — so
 * anything the sweep forgets to collect is silently absent from the worker's
 * price map, where it reads as "no market data" and drops to sellPrice or
 * production cost.
 */
describe('what the sweep collects prices for', () => {
    beforeEach(() => {
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.settings.networth_pricingMode = 'ask';
        mocks.initData = { houseRoomDetailMap: {}, actionDetailMap: {} };
        mocks.itemDetails['/items/iron_sword'] = {
            itemLevel: 10,
            name: 'Iron Sword',
            enhancementCosts: [{ itemHrid: '/items/enhance_stone', count: 1 }],
            protectionItemHrids: ['/items/prot_orb'],
        };
        for (const hrid of [
            '/items/iron_sword',
            '/items/enhance_stone',
            '/items/prot_orb',
            '/items/philosophers_mirror',
            '/items/mirror_of_protection',
        ]) {
            mocks.itemPrices[hrid] = { ask: 100, bid: 90 };
        }
    });

    test('an enhanced item brings its materials, its protection items and both mirrors', async () => {
        mocks.combinedData = {
            characterItems: [
                {
                    itemHrid: '/items/iron_sword',
                    enhancementLevel: 14,
                    count: 1,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ],
            myMarketListings: [],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: mocks.itemDetails,
        };
        workerBatch.mockResolvedValue([0]);
        await calculateNetworth();

        const priceMap = workerBatch.mock.calls[0][1];
        // Without these the worker priced the stone off sellPrice and the orb
        // off production cost, while the main thread quoted the market
        expect(priceMap['/items/enhance_stone:0']).toBe(100);
        expect(priceMap['/items/prot_orb:0']).toBe(100);
        expect(priceMap['/items/philosophers_mirror:0']).toBe(100);
        expect(priceMap['/items/mirror_of_protection:0']).toBe(100);
    });

    test('a listing of an enhanced item brings them too', async () => {
        mocks.combinedData = {
            characterItems: [
                {
                    itemHrid: '/items/iron_sword',
                    enhancementLevel: 14,
                    count: 1,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ],
            myMarketListings: [
                {
                    itemHrid: '/items/iron_sword',
                    enhancementLevel: 14,
                    isSell: true,
                    orderQuantity: 1,
                    filledQuantity: 0,
                    unclaimedCoinCount: 0,
                },
            ],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: mocks.itemDetails,
        };
        workerBatch.mockResolvedValue([0]);
        await calculateNetworth();

        const priceMap = workerBatch.mock.calls[0][1];
        expect(priceMap['/items/enhance_stone:0']).toBe(100);
        expect(priceMap['/items/prot_orb:0']).toBe(100);
    });

    test('a character with nothing enhanced does not pay for the mirrors', async () => {
        mocks.combinedData = {
            characterItems: [
                {
                    itemHrid: '/items/iron_sword',
                    enhancementLevel: 0,
                    count: 1,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ],
            myMarketListings: [],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: mocks.itemDetails,
        };
        workerBatch.mockResolvedValue([]);
        const result = await calculateNetworth();

        // Nothing needed a worker, so nothing was batched — and the sweep did
        // not go looking for enhancement inputs it has no use for
        expect(workerBatch).not.toHaveBeenCalled();
        expect(result.totalNetworth).toBe(100);
    });
});

/**
 * What a market listing is holding. Three distinct pots of value — the units
 * still on the market, the coins locked against unfilled buy quantity, and the
 * items or coins already handed back and waiting to be claimed — and the total
 * has to carry all three exactly once.
 */
describe('market listings', () => {
    beforeEach(() => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.initData = { houseRoomDetailMap: {}, itemDetailMap: { '/items/milk': { name: 'Milk' } } };
        mocks.itemPrices['/items/milk'] = { ask: 100, bid: 90 };
    });

    /**
     * Run the sweep over one listing and nothing else.
     * @param {Object} listing - A `myMarketListings` entry
     * @returns {Promise<Object>} The listings section
     */
    const sweepListing = async (listing) => {
        mocks.combinedData = {
            characterItems: [],
            myMarketListings: [listing],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: mocks.initData.itemDetailMap,
        };
        const result = await calculateNetworth();
        return result.currentAssets.listings;
    };

    test('a live buy order counts the coins refunded to it, not just the coins still locked', async () => {
        // Half of a 100-unit order filled below the bid price, so the game
        // handed back both the units and the price improvement
        const listings = await sweepListing({
            itemHrid: '/items/milk',
            enhancementLevel: 0,
            isSell: false,
            status: '/market_listing_status/active',
            orderQuantity: 100,
            filledQuantity: 50,
            price: 1000,
            unclaimedItemCount: 50,
            unclaimedCoinCount: 5000,
        });

        // 50 unfilled x 1000 locked + 50 milk at ask + the 5000 refund
        expect(listings.value).toBe(50 * 1000 + 50 * 100 + 5000);
    });

    test('an ended buy order counts its refund exactly once', async () => {
        const listings = await sweepListing({
            itemHrid: '/items/milk',
            enhancementLevel: 0,
            isSell: false,
            status: '/market_listing_status/cancelled',
            orderQuantity: 100,
            filledQuantity: 50,
            price: 1000,
            unclaimedItemCount: 50,
            unclaimedCoinCount: 50_000,
        });

        // Nothing is locked any more: the units came back and so did the coins
        expect(listings.value).toBe(50 * 100 + 50_000);
    });
});

/**
 * The header says what is on hand; the history says what counts. Coin is an
 * excludable item like every other, and every field the history records beside
 * gold is post-exclusion — so the two figures have to be reported apart.
 */
describe('the coins reported to the history', () => {
    /** A sweep over an inventory holding `count` coins */
    async function sweepCoins(count) {
        mocks.combinedData = {
            characterItems: [
                {
                    itemHrid: '/items/coin',
                    enhancementLevel: 0,
                    count,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ],
            myMarketListings: [],
            characterHouseRoomMap: {},
            characterAbilities: [],
            abilityCombatTriggersMap: {},
            itemDetailMap: { '/items/coin': { name: 'Coin' } },
        };
        return calculateNetworth();
    }

    test('are the balance on hand when nothing excludes them', async () => {
        const result = await sweepCoins(5000);
        expect(result.coins).toBe(5000);
        expect(result.countedCoins).toBe(5000);
    });

    test('drop to zero when the coin itself is excluded, while the header keeps the balance', async () => {
        mocks.excluded.add('item:/items/coin');

        const result = await sweepCoins(5000);

        expect(result.coins).toBe(5000);
        expect(result.countedCoins).toBe(0);
        // …and the inventory the history records beside it no longer carries them
        expect(result.currentAssets.inventory.value).toBe(0);
    });
});
