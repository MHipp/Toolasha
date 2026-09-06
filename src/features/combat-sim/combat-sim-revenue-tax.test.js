/**
 * calculateSimRevenue nets the marketplace sale tax off drop value.
 *
 * The sim values a drop at what it sells for, and selling on the market is
 * taxed — so a drop is worth its price *after* tax, not gross. This was missed
 * (the sim valued drops gross), so the 8/13 tax rise never moved sim profit.
 * Coin is not sold and stays whole; cowbell bags carry their own higher rate.
 *
 * The suite's global setup mocks the marketplace-patch gate on, so MARKET_TAX
 * reads 5% here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { MARKET_TAX, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';

const mocks = vi.hoisted(() => ({ prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }) },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({
    // Default pricing mode → getSellPrice reads the ask
    default: { getSetting: () => null, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({}),
    expectedValueCalculator: () => null,
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => mocks.prices[hrid] || null },
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, calculateSingleContainer: () => null },
}));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));
// profit-helpers pulls these in at load; stub the ones that touch the live
// market on import. calculatePriceAfterTax itself lives in profit-helpers and
// stays real, so the tax math under test is the real thing.
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => ({}) }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { calculateSimRevenue } = await import('./combat-sim-adapter.js');

/**
 * A dungeon run whose completion always drops one chimerical chest, which costs
 * one entry key and one chest key.
 */
function simClearingDungeon(completions, chestPrice, keyPrice) {
    mocks.prices['/items/chimerical_chest'] = { ask: chestPrice, bid: chestPrice };
    mocks.prices['/items/chimerical_entry_key'] = { ask: keyPrice, bid: keyPrice };
    mocks.prices['/items/chimerical_chest_key'] = { ask: keyPrice, bid: keyPrice };
    const simResult = {
        deaths: {},
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        numberOfPlayers: 1,
        difficultyTier: 0,
        isDungeon: true,
        dungeonsCompleted: completions,
        zoneName: '/actions/combat/chimerical_den',
        consumablesUsed: { player1: {} },
    };
    const gameData = {
        combatMonsterDetailMap: {},
        actionDetailMap: {
            '/actions/combat/chimerical_den': {
                combatZoneInfo: {
                    dungeonInfo: {
                        rewardDropTable: [
                            { itemHrid: '/items/chimerical_chest', dropRate: 0.2, minCount: 1, maxCount: 1 },
                        ],
                    },
                },
            },
        },
    };
    return { simResult, gameData };
}

/**
 * A sim where killing one monster always drops exactly one of `itemHrid`, so the
 * expected drop count is the kill count and the revenue math is easy to pin.
 */
function simDropping(itemHrid, kills, price) {
    mocks.prices[itemHrid] = { ask: price, bid: price };
    const simResult = {
        deaths: { '/monsters/rat': kills, player1: 0 },
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        numberOfPlayers: 1,
        difficultyTier: 0,
        isDungeon: false,
        consumablesUsed: { player1: {} },
    };
    const gameData = {
        combatMonsterDetailMap: {
            '/monsters/rat': {
                dropTable: [{ itemHrid, dropRate: 1, minCount: 1, maxCount: 1, minDifficultyTier: 0 }],
            },
        },
    };
    return { simResult, gameData };
}

// kills === hours, so (total / hours) is 1 and revenuePerHour is the unit value
const KILLS = 10;
const HOURS = 10;

beforeEach(() => {
    mocks.prices = {};
});

describe('calculateSimRevenue drop tax', () => {
    test('an ordinary drop is worth its price net of the market tax', () => {
        const { simResult, gameData } = simDropping('/items/cheese', KILLS, 1000);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(revenuePerHour).toBeCloseTo(1000 * (1 - MARKET_TAX), 9);
        // And it is genuinely lower than the gross the sim used to report
        expect(revenuePerHour).toBeLessThan(1000);
    });

    test('a cowbell bag is taxed at its own higher rate, not the flat market rate', () => {
        const { simResult, gameData } = simDropping('/items/bag_of_10_cowbells', KILLS, 1000);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(revenuePerHour).toBeCloseTo(1000 * (1 - COWBELL_BAG_TAX), 9);
        expect(COWBELL_BAG_TAX).toBeGreaterThan(MARKET_TAX);
    });

    test('coin is not sold, so it is not taxed', () => {
        const { simResult, gameData } = simDropping('/items/coin', KILLS, 1);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        // One coin per kill, valued at 1 apiece, untouched by tax
        expect(revenuePerHour).toBeCloseTo(1, 9);
    });
});

/**
 * A dungeon's keys are a cost of running it.
 *
 * Only the Results detail view ever priced them, and it computes its own figure.
 * Every reader of `netPerHour` — the all-zones table that ranks dungeons against
 * zones, the upgrade advisor, the task profit display — was handed a dungeon's
 * revenue with entry and chest keys unpaid.
 */
describe('calculateSimRevenue dungeon key cost', () => {
    test('entry and chest keys are charged against the run', () => {
        // 10 completions × 0.2 = 2 chests, over 10 hours = 0.2 chests/hr, each
        // owing one entry key and one chest key at 1000 apiece
        const { simResult, gameData } = simClearingDungeon(10, 5000, 1000);
        const { keyCostPerHour, costPerHour, revenuePerHour, netPerHour } = calculateSimRevenue(
            simResult,
            gameData,
            'player1',
            HOURS
        );

        expect(keyCostPerHour).toBeCloseTo(0.2 * 2000, 6);
        expect(costPerHour).toBeCloseTo(keyCostPerHour, 6);
        expect(netPerHour).toBeCloseTo(revenuePerHour - keyCostPerHour, 6);
    });

    test('a non-dungeon run is charged nothing', () => {
        const { simResult, gameData } = simDropping('/items/cheese', KILLS, 1000);
        const { keyCostPerHour, costPerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(keyCostPerHour).toBe(0);
        expect(costPerHour).toBe(0);
    });
});
