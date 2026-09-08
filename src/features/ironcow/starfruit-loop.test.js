/**
 * The Star Fruit loop, costed through the real calculators.
 *
 * Nothing in this file re-implements the arithmetic it is checking. The
 * gathering calculator and the alchemy calculator are the real ones; what is
 * mocked is the game underneath them — the drop table, the action times, the
 * skill levels, the prices. So a change that breaks the composition breaks this
 * file, which is the point: the loop is only ever as right as the calculators it
 * borrows, and a fork of their maths would pass these tests while shipping a
 * second opinion.
 *
 * The load-bearing assertion is the one about market prices. An iron cow cannot
 * sell, so every market sell value in the repository is the wrong number for
 * this loop. The way to prove none of them leaked in is to move all of them by a
 * factor of a billion and watch the gold per hour not move at all.
 *
 * ## The fixture, hand-computed
 *
 * Foraging: 10s per action, no efficiency, one fruit a drop → **360 fruit/hr**,
 * so **10s of foraging** per fruit.
 * Decompose: 20s per action → 180 actions/hr; base 60%, alchemy at the fruit's
 * own level so no penalty, and no catalyst an iron cow could buy → **0.6**.
 * Five essence a success → **3 essence per fruit**, for **20s of decomposing**.
 * Fee: `(10 + 65) × 5 × 1` = **375 coins**.
 * Coinify: 20s → 180 actions/hr; base 70%, no penalty, no catalyst → **0.7**.
 * Bulk 10, so 3 essence is **0.3 actions** = **6s**; each pays `300 × 10 × 5` =
 * 15,000 on a success → `0.3 × 15000 × 0.7` = **3,150 coins in**.
 * Net per fruit: `3150 − 375` = **2,775**.
 * Time per fruit: `10 + 20 + 6` = 36s = **0.01 h**.
 * Gold per hour: `2775 / 0.01` = **277,500**.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const STARFRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const FORAGE_ACTION = '/actions/foraging/star_fruit';
const COWBELL = '/items/cowbell';
const COWBELL_BAG = '/items/bag_of_10_cowbells';

const game = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
    inventory: [],
    actions: [],
    gameMode: 'ironcow',
    characterData: {},
}));

const market = vi.hoisted(() => ({
    /** itemHrid → price. Anything unlisted is 0, never null, so nothing declines */
    prices: {},
    pricingMode: 'hybrid',
}));

const buffs = vi.hoisted(() => ({
    alchemyTeaBonus: 0,
    gatheringContext: null,
    bonusRevenue: null,
    actionStats: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback ?? 'hybrid' },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] ?? null,
        getSkills: () => game.skills,
        getEquipment: () => new Map(),
        getInventory: () => game.inventory,
        getCurrentActions: () => game.actions,
        getCurrentCharacterGameMode: () => game.gameMode,
        getHouseRoomLevel: () => 0,
        getActionDrinkSlots: () => [],
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
        get characterData() {
            return game.characterData;
        },
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => market.prices[hrid] ?? 0,
    getPricingMode: () => market.pricingMode,
}));

// --- what the alchemy calculator stands on -------------------------------
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => 0 }));
vi.mock('../../utils/buff-parser.js', () => ({ getAlchemySuccessBonus: () => buffs.alchemyTeaBonus }));
vi.mock('../../utils/equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => 0,
    debugEquipmentSpeedBonuses: () => [],
    parseEssenceFindBonus: () => 0,
    parseRareFindBonus: () => 0,
}));
vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: () => buffs.actionStats }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseRareFind: () => 0 }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => () => {} } }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, calculateSingleContainer: () => null, isInitialized: false },
}));

// --- what the gathering calculator stands on -----------------------------
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => buffs.gatheringContext }));
vi.mock('../../utils/bonus-revenue-calculator.js', () => ({ calculateBonusRevenue: () => buffs.bonusRevenue }));

const {
    calculateStarfruitLoop,
    bellsFrom,
    cowbellPricing,
    loopBasis,
    loopWarnings,
    offlineWindow,
    balanceBatch,
    bellsForHours,
    hoursForBells,
    LOW_GOLD_BUFFER,
    LOOP_QUEUE_SLOTS,
    ASSUMED_OFFLINE_HOURS,
} = await import('./starfruit-loop.js');

/**
 * The game data every test shares.
 * @param {Object} [overrides] - Merged into the item detail map
 * @returns {Object} An `initClientData`
 */
function gameData(overrides = {}) {
    return {
        itemDetailMap: {
            [STARFRUIT]: {
                name: 'Star Fruit',
                itemLevel: 65,
                sellPrice: 40,
                alchemyDetail: {
                    bulkMultiplier: 1,
                    isCoinifiable: false,
                    decomposeItems: [{ itemHrid: ESSENCE, count: 5 }],
                },
            },
            [ESSENCE]: {
                name: 'Foraging Essence',
                itemLevel: 40,
                sellPrice: 300,
                alchemyDetail: { bulkMultiplier: 10, isCoinifiable: true },
            },
            '/items/alchemy_essence': { name: 'Alchemy Essence' },
            '/items/medium_artisans_crate': { name: "Medium Artisan's Crate" },
            '/items/coin': { name: 'Coin' },
            ...overrides,
        },
        actionDetailMap: {
            [FORAGE_ACTION]: {
                type: '/action_types/foraging',
                baseTimeCost: 10e9,
                dropTable: [{ itemHrid: STARFRUIT, dropRate: 1, minCount: 1, maxCount: 1 }],
            },
            // The asteroid belt also drops the fruit, but far less often — the
            // resolver must pick the dedicated action, as the plan insists.
            '/actions/foraging/asteroid_belt': {
                type: '/action_types/foraging',
                baseTimeCost: 10e9,
                dropTable: [{ itemHrid: STARFRUIT, dropRate: 0.05, minCount: 1, maxCount: 1 }],
            },
            '/actions/alchemy/decompose': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
            '/actions/alchemy/coinify': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
        },
    };
}

/** An efficiency context with everything off: 10s actions, no bonuses */
function foragingContext() {
    return {
        equipment: new Map(),
        drinkSlots: [],
        drinkConcentration: 0,
        actionTime: 10,
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
        gatheringDetails: { gatheringTea: 0, communityGathering: 0, achievementGathering: 0, personalGathering: 0 },
        efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0 },
        efficiencyMultiplier: 1,
    };
}

beforeEach(() => {
    game.initClientData = gameData();
    // At the fruit's own level, so alchemy takes no under-level penalty
    game.skills = [{ skillHrid: '/skills/alchemy', level: 65 }];
    game.inventory = [{ itemHrid: '/items/coin', count: 10_000_000 }];
    game.actions = [{}, {}, {}];
    game.gameMode = 'ironcow';
    game.characterData = {};

    market.prices = { [COWBELL]: 1_000_000, [COWBELL_BAG]: 9_500_000 };
    market.pricingMode = 'ask';

    buffs.alchemyTeaBonus = 0;
    buffs.gatheringContext = foragingContext();
    buffs.bonusRevenue = { totalBonusRevenue: 0, hasMissingPrices: false };
    buffs.actionStats = {
        actionTime: 20,
        totalEfficiency: 0,
        efficiencyBreakdown: { totalEfficiency: 0 },
    };
});

describe('the loop, costed', () => {
    test('gets its rates and its gold from the real calculators', async () => {
        const loop = await calculateStarfruitLoop();

        expect(loop.missing).toEqual([]);
        expect(loop.fruitPerHour).toBeCloseTo(360, 6);
        expect(loop.decomposeActionsPerHour).toBeCloseTo(180, 6);
        expect(loop.coinifyActionsPerHour).toBeCloseTo(180, 6);
        expect(loop.decomposeRate).toBeCloseTo(0.6, 10);
        expect(loop.coinifyRate).toBeCloseTo(0.7, 10);
        expect(loop.essencePerFruit).toBeCloseTo(3, 10);
        expect(loop.coinifyBulk).toBe(10);
        expect(loop.coinsPerSuccess).toBe(15_000);
    });

    test('a fruit is worth its coinify output less the decompose fee', async () => {
        const loop = await calculateStarfruitLoop();

        expect(loop.goldInPerFruit).toBeCloseTo(3150, 6);
        // (10 + itemLevel) × 5 × bulk, from utils/alchemy-fees.js
        expect(loop.goldOutPerFruit).toBe(375);
        expect(loop.netPerFruit).toBeCloseTo(2775, 6);
    });

    test('an hour of the loop is an hour split three ways, and pays accordingly', async () => {
        const loop = await calculateStarfruitLoop();

        expect(loop.hoursPerFruit).toBeCloseTo(0.01, 10);
        expect(loop.goldPerHour).toBeCloseTo(277_500, 4);
        expect(loop.goldPerDay).toBeCloseTo(277_500 * 24, 3);

        // Decomposing is the slow part, and it is what the queue is mostly doing
        expect(loop.timeShare.decompose).toBeCloseTo(20 / 36, 6);
        expect(loop.timeShare.forage).toBeCloseTo(10 / 36, 6);
        expect(loop.timeShare.coinify).toBeCloseTo(6 / 36, 6);
        const total = loop.timeShare.forage + loop.timeShare.decompose + loop.timeShare.coinify;
        expect(total).toBeCloseTo(1, 10);
    });

    test('the fee it charges per hour is what the gold buffer is for', async () => {
        const loop = await calculateStarfruitLoop();
        // 375 a fruit, a fruit every 0.01h
        expect(loop.alchemyFeePerHour).toBeCloseTo(37_500, 4);
    });

    test('a slower alchemist earns less, because the penalty is real', async () => {
        game.skills = [{ skillHrid: '/skills/alchemy', level: 40 }];
        const loop = await calculateStarfruitLoop();

        // perLevel = 0.9/65, 25 levels short → 0.6 × (1 - 0.9×25/65)
        expect(loop.decomposeRate).toBeCloseTo(0.6 * (1 - (0.9 / 65) * 25), 8);
        // The essence is level 40, so coinify is at its own level and unpenalised
        expect(loop.coinifyRate).toBeCloseTo(0.7, 10);
        expect(loop.goldPerHour).toBeLessThan(277_500);
    });

    test('the fruit comes from its own action, not the asteroid belt', async () => {
        const loop = await calculateStarfruitLoop();
        expect(loop.items.forageActionHrid).toBe(FORAGE_ACTION);
    });
});

describe('the no-market-sell constraint', () => {
    test('the basis says so out loud', () => {
        expect(loopBasis()).toMatchObject({ gold: 'coinify', sells: false });
    });

    test('gold per hour does not move when every market price does', async () => {
        market.prices = { ...market.prices, [STARFRUIT]: 1, [ESSENCE]: 1, '/items/alchemy_essence': 1 };
        const cheap = await calculateStarfruitLoop();

        market.prices = {
            ...market.prices,
            [STARFRUIT]: 1_000_000_000,
            [ESSENCE]: 1_000_000_000,
            '/items/alchemy_essence': 1_000_000_000,
        };
        const dear = await calculateStarfruitLoop();

        expect(dear.goldPerHour).toBe(cheap.goldPerHour);
        expect(dear.netPerFruit).toBe(cheap.netPerFruit);
        expect(dear.goldInPerFruit).toBe(cheap.goldInPerFruit);
    });

    test('the coins come from the vendor formula, not from any market quote', async () => {
        const loop = await calculateStarfruitLoop();
        const essence = game.initClientData.itemDetailMap[ESSENCE];
        expect(loop.coinsPerSuccess).toBe(essence.sellPrice * essence.alchemyDetail.bulkMultiplier * 5);

        // And it follows the vendor price, which is the only thing it may follow
        essence.sellPrice = 600;
        const richer = await calculateStarfruitLoop();
        expect(richer.coinsPerSuccess).toBe(30_000);
        expect(richer.goldInPerFruit).toBeCloseTo(6300, 6);
    });

    test('a catalyst the calculator would happily buy is not one the loop assumes', async () => {
        // Free catalysts: the calculator's own combo search picks the prime
        // catalyst and quotes 0.6 × 1.25. An iron cow cannot buy one at any
        // price, so the loop must still be costed at the bare 0.6.
        market.prices = {
            ...market.prices,
            '/items/prime_catalyst': 0,
            '/items/catalyst_of_decomposition': 0,
            '/items/catalyst_of_coinification': 0,
        };
        const loop = await calculateStarfruitLoop();

        expect(loop.decomposeRate).toBeCloseTo(0.6, 10);
        expect(loop.coinifyRate).toBeCloseTo(0.7, 10);
        expect(loop.goldPerHour).toBeCloseTo(277_500, 4);
    });

    test('self-brewed tea does count, because it costs an iron cow nothing', async () => {
        buffs.alchemyTeaBonus = 0.05;
        const loop = await calculateStarfruitLoop();

        expect(loop.decomposeRate).toBeCloseTo(0.6 * 1.05, 10);
        expect(loop.coinifyRate).toBeCloseTo(0.7 * 1.05, 10);
        expect(loop.goldPerHour).toBeGreaterThan(277_500);
    });
});

describe('bells', () => {
    test('divides the gold rate by the price of a bell', () => {
        expect(bellsFrom(277_500, 1_000_000)).toMatchObject({ perHour: 0.2775 });
        expect(bellsFrom(10_000_000, 1_000_000)).toMatchObject({ perHour: 10, perDay: 240, perWeek: 1680 });
    });

    test('has nothing to say without a price', () => {
        expect(bellsFrom(277_500, null)).toBeNull();
        expect(bellsFrom(277_500, 0)).toBeNull();
        expect(bellsFrom(Number.NaN, 1_000_000)).toBeNull();
    });

    test('buys them whichever way is cheaper', () => {
        market.prices = { [COWBELL]: 1_000_000, [COWBELL_BAG]: 9_500_000 };
        expect(cowbellPricing()).toMatchObject({ price: 950_000, source: 'bag' });

        market.prices = { [COWBELL]: 900_000, [COWBELL_BAG]: 9_500_000 };
        expect(cowbellPricing()).toMatchObject({ price: 900_000, source: 'loose' });
    });

    test('reports the pricing mode it quoted under', () => {
        market.pricingMode = 'bid';
        expect(cowbellPricing().pricingMode).toBe('bid');
    });

    test('a week of the loop is priced at the cheaper bell, and the mode is carried through', async () => {
        const loop = await calculateStarfruitLoop();

        expect(loop.bellPrice).toBe(950_000);
        expect(loop.bells.perHour).toBeCloseTo(277_500 / 950_000, 10);
        expect(loop.bells.perDay).toBeCloseTo((277_500 * 24) / 950_000, 10);
        expect(loop.bells.perWeek).toBeCloseTo((277_500 * 168) / 950_000, 10);
        expect(loop.bellPricing.pricingMode).toBe('ask');
        expect(loop.pricingMode).toBe('hybrid');
    });

    test('a dearer bell buys fewer of them for the same gold', async () => {
        market.prices = { [COWBELL]: 2_000_000, [COWBELL_BAG]: 20_000_000 };
        const loop = await calculateStarfruitLoop();
        expect(loop.bellPrice).toBe(2_000_000);
        expect(loop.bells.perWeek).toBeCloseTo((277_500 * 168) / 2_000_000, 10);
    });

    test('says nothing rather than something wrong when no bell is priced', async () => {
        market.prices = {};
        const loop = await calculateStarfruitLoop();
        expect(loop.bellPrice).toBeNull();
        expect(loop.bells).toBeNull();
    });
});

describe('when the loop cannot be costed', () => {
    test('no game data at all is nothing, not a wrong number', async () => {
        game.initClientData = null;
        expect(await calculateStarfruitLoop()).toBeNull();
    });

    test('a rate of zero is named rather than divided by', async () => {
        buffs.gatheringContext = { ...foragingContext(), efficiencyMultiplier: 0 };
        const loop = await calculateStarfruitLoop();
        expect(loop.missing.length).toBeGreaterThan(0);
        expect(loop.goldPerHour).toBeUndefined();
    });

    test('an item the alchemy calculator declines is reported, not guessed at', async () => {
        game.initClientData.itemDetailMap[ESSENCE].alchemyDetail.isCoinifiable = false;
        const loop = await calculateStarfruitLoop();
        expect(loop.missing).toContain('coinifying Foraging Essence');
        expect(loop.basis.sells).toBe(false);
    });
});

describe('loop health checks', () => {
    /**
     * @param {Object} [state] - Overrides on a healthy character
     * @returns {Array<Object>} Warnings
     */
    async function warnings(state = {}) {
        const loop = await calculateStarfruitLoop();
        return loopWarnings({ coins: 10_000_000, queueLength: 3, ...state }, loop);
    }

    /**
     * @param {Array<Object>} list - Warnings
     * @param {string} id - Which one
     * @returns {Object|undefined} The warning
     */
    const find = (list, id) => list.find((entry) => entry.id === id);

    test('a healthy loop is only told about the offline window', async () => {
        const list = await warnings();
        expect(list.filter((entry) => entry.severity === 'warn')).toEqual([]);
        expect(find(list, 'offline').text).toContain(String(ASSUMED_OFFLINE_HOURS));
    });

    test('a thin gold buffer is a warning, with how long it lasts', async () => {
        const list = await warnings({ coins: LOW_GOLD_BUFFER - 1 });
        const gold = find(list, 'gold');
        expect(gold.severity).toBe('warn');
        // 2,999,999 gold against 37,500/hr of decompose fees
        expect(gold.text).toContain('80h');
    });

    test('too few queue slots is a warning that says how many', async () => {
        const list = await warnings({ queueLength: 2 });
        const queue = find(list, 'queue');
        expect(queue.severity).toBe('warn');
        expect(queue.text).toContain(`2 of the ${LOOP_QUEUE_SLOTS}`);
    });

    test('the offline window says when it is the plan’s figure and not yours', async () => {
        expect(offlineWindow()).toEqual({ hours: ASSUMED_OFFLINE_HOURS, assumed: true });
        expect((await warnings()).find((entry) => entry.id === 'offline').text).toContain('assumed offline window');

        game.characterData = { offlineHours: 24 };
        expect(offlineWindow()).toEqual({ hours: 24, assumed: false });
        expect((await warnings()).find((entry) => entry.id === 'offline').text).toContain('your offline window');
    });

    test('an unpriced cowbell is a warning of its own', async () => {
        market.prices = {};
        const list = await warnings();
        expect(find(list, 'bellprice').severity).toBe('warn');
    });
});

describe('sizing a batch of the three actions', () => {
    test('each step is sized to what the step before it actually produced', async () => {
        const loop = await calculateStarfruitLoop();
        const batch = balanceBatch(loop, 16);

        // 16h at 0.01h a fruit is 1,600 fruit, one fruit per forage action.
        expect(batch.forageActions).toBe(1600);
        expect(batch.fruit).toBeCloseTo(1600, 6);
        // Star Fruit decomposes one at a time, so one action per fruit...
        expect(batch.decomposeActions).toBe(1600);
        // ...yielding 3 essence a fruit, and coinify consumes 10 at a time.
        expect(batch.essence).toBeCloseTo(4800, 6);
        expect(batch.coinifyActions).toBe(480);
    });

    test('no step asks for more input than the step before it produced', async () => {
        const loop = await calculateStarfruitLoop();
        for (const hours of [1, 8, 16, 24, 168, 0.3, 7.77]) {
            const batch = balanceBatch(loop, hours);
            expect(batch.decomposeActions * loop.decomposeBulk).toBeLessThanOrEqual(batch.fruit + 1e-9);
            expect(batch.coinifyActions * loop.coinifyBulk).toBeLessThanOrEqual(batch.essence + 1e-9);
        }
    });

    test('the three counts add back up to the hours asked for', async () => {
        const loop = await calculateStarfruitLoop();
        const batch = balanceBatch(loop, 16);
        expect(batch.hours).toBeCloseTo(16, 3);
    });

    test('a loop that could not be costed sizes nothing rather than guessing', async () => {
        expect(balanceBatch(null, 16)).toBeNull();
        expect(balanceBatch({ missing: ['coinifying Foraging Essence'] }, 16)).toBeNull();
    });

    test('an unusable duration sizes nothing', async () => {
        const loop = await calculateStarfruitLoop();
        expect(balanceBatch(loop, 0)).toBeNull();
        expect(balanceBatch(loop, -3)).toBeNull();
        expect(balanceBatch(loop, Number.NaN)).toBeNull();
    });
});

describe('duration and a cowbell target, each derived from the other', () => {
    test('the two directions agree', async () => {
        const loop = await calculateStarfruitLoop();
        for (const hours of [1, 8, 16, 24, 168]) {
            const target = bellsForHours(loop, hours);
            expect(hoursForBells(loop, target)).toBeCloseTo(hours, 8);
        }
    });

    test('the bells a duration earns are the loop’s own gold at the loop’s own bell price', async () => {
        const loop = await calculateStarfruitLoop();
        expect(bellsForHours(loop, 16)).toBeCloseTo((277_500 * 16) / loop.bellPrice, 8);
    });

    test('with no bell price there is no target, in either direction', async () => {
        market.prices = {};
        const loop = await calculateStarfruitLoop();

        expect(loop.bellPrice).toBeNull();
        expect(bellsForHours(loop, 16)).toBeNull();
        expect(hoursForBells(loop, 40)).toBeNull();
    });
});

describe('a bulk decompose is shared out over the fruit it swallows', () => {
    /** Seconds of decomposing charged to one fruit, read back off the loop */
    const decomposeSeconds = (loop) => loop.timeShare.decompose * loop.hoursPerFruit * 3600;

    /**
     * Star Fruit as the live client reports it: two fruit per decompose action,
     * ten essence per fruit, 60% base. The game's own panel reads "Uses 2 items
     * per action" and "Outputs 20 Foraging Essence" — 10 × bulk.
     * @param {number} bulkMultiplier - Fruit per decompose action
     * @returns {Object} An `initClientData` with the fruit overridden
     */
    const realStarfruit = (bulkMultiplier) =>
        gameData({
            [STARFRUIT]: {
                name: 'Star Fruit',
                itemLevel: 65,
                sellPrice: 40,
                alchemyDetail: {
                    bulkMultiplier,
                    isCoinifiable: false,
                    decomposeItems: [{ itemHrid: ESSENCE, count: 10 }],
                },
            },
        });

    test('a bulk-2 fruit is charged half a decompose action, not a whole one', async () => {
        game.initClientData = realStarfruit(2);
        const loop = await calculateStarfruitLoop();

        expect(loop.decomposeBulk).toBe(2);
        // 180 actions/hr over 2 fruit an action = 10s a fruit, not 20s
        expect(decomposeSeconds(loop)).toBeCloseTo(10, 6);
        // 10s forage + 10s decompose + (6 essence / bulk 10) / 180 actions/hr = 12s coinify
        expect(loop.hoursPerFruit * 3600).toBeCloseTo(32, 6);
        // The decompose fee is (10 + 65) × 5 × bulk = 750 for the ACTION, which
        // covers two fruit — so a fruit carries 375, not the whole 750. Charging
        // the action fee to one fruit used to cancel against the decompose time
        // being inflated by the same factor; with the time leg corrected above,
        // this leg has to be corrected too or the fee is simply doubled.
        expect(loop.goldOutPerFruit).toBe(375);
        // 0.6 coinify actions × 15,000 × 0.7 = 6,300 in, less the 375 a fruit owes
        expect(loop.goldPerHour).toBeCloseTo((6300 - 375) / (32 / 3600), 3);
    });

    test('the essence leg is untouched: a bulk-2 fruit still becomes six essence', async () => {
        game.initClientData = realStarfruit(2);
        const loop = await calculateStarfruitLoop();

        // decomposeItems.count is stated per fruit, so 10 × 0.6 — no bulk in it
        expect(loop.essencePerFruit).toBeCloseTo(6, 10);
        expect(loop.coinifyBulk).toBe(10);
    });

    test('a bulk-1 fruit is charged a whole decompose action, exactly as before', async () => {
        game.initClientData = realStarfruit(1);
        const loop = await calculateStarfruitLoop();

        expect(loop.decomposeBulk).toBe(1);
        expect(decomposeSeconds(loop)).toBeCloseTo(20, 6);
        // 10s forage + 20s decompose + 12s coinify
        expect(loop.hoursPerFruit * 3600).toBeCloseTo(42, 6);
    });

    test('a missing or zero multiplier falls back to one rather than to Infinity', async () => {
        for (const bulkMultiplier of [0, undefined]) {
            game.initClientData = realStarfruit(bulkMultiplier);
            const loop = await calculateStarfruitLoop();

            expect(loop.decomposeBulk).toBe(1);
            expect(decomposeSeconds(loop)).toBeCloseTo(20, 6);
            expect(Number.isFinite(loop.hoursPerFruit)).toBe(true);
            expect(Number.isFinite(loop.goldPerHour)).toBe(true);
        }
    });
});
