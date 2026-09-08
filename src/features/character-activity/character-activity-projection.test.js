/**
 * `computeLiveProjection` walks the queue sequentially — in materials as well as in time.
 *
 * The walk built the inventory lookup once and handed the same unchanged object to every
 * queued action, so each action was costed against the full starting bag. A queue of three
 * Coinify actions over one stack of cheese projected three full runs, and the alt-readiness
 * line told the player the character was busy for hours after the materials had run out.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

const ACTION_TIME = 10;
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: ACTION_TIME, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, fallback) => fallback },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: { subscribe: () => {}, unsubscribe: () => {}, register: () => () => {} },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

const { computeLiveProjection } = await import('./character-activity-projection.js');

const CHEESE = '/items/cheese';
const COINIFY = '/actions/alchemy/coinify';
const NOW = 1_700_000_000_000;

function stack(itemHrid, count) {
    return { itemHrid, count, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' };
}

/** An "infinite" (uncounted) Coinify action, whose length is exactly its material limit. */
function coinifyAction(id) {
    return {
        id,
        ordinal: id,
        actionHrid: COINIFY,
        primaryItemHash: `char1::/item_locations/inventory::${CHEESE}::0`,
        hasMaxCount: false,
        maxCount: 0,
        currentCount: 0,
        isDone: false,
    };
}

beforeEach(() => {
    game.itemDetails = {
        [CHEESE]: { itemHrid: CHEESE, name: 'Cheese', itemLevel: 10, alchemyDetail: { bulkMultiplier: 1 } },
    };
    game.actionDetails = {
        [COINIFY]: { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy', coinCost: 0 },
    };
    game.inventory = [stack(CHEESE, 5)];
    game.currentActions = [coinifyAction(1), coinifyAction(2)];
});

describe('computeLiveProjection material ledger', () => {
    test('the queue ends where the materials do, not where an unspent bag implies', () => {
        const projection = computeLiveProjection(NOW);

        // 5 cheese buys 5 actions at 10s; the second action inherits nothing
        expect(projection.segments.map((s) => s.endAt)).toEqual([NOW + 50_000, NOW + 50_000]);
        expect(projection.terminalAt).toBe(NOW + 50_000);
        expect(projection.terminalCause).toBe('materials');
        expect(projection.certainty).toBe('trustworthy');
    });

    test('a bag covering both actions still projects both in full', () => {
        // The first action is counted, so it takes only the 5 it asked for and leaves the
        // rest; the uncounted second action then runs on what remains
        game.inventory = [stack(CHEESE, 10)];
        game.currentActions[0] = { ...coinifyAction(1), hasMaxCount: true, maxCount: 5 };

        const projection = computeLiveProjection(NOW);

        expect(projection.segments.map((s) => s.endAt)).toEqual([NOW + 50_000, NOW + 100_000]);
        expect(projection.terminalAt).toBe(NOW + 100_000);
    });
});

/**
 * The projection takes deterministic credit only.
 *
 * Its job is telling the player when an alt goes idle, and it is deliberately stricter than
 * the tooltip: a false early warning beats telling the player an alt is safe when it might
 * not be. A crafted intermediate is as good as stock in hand, so it counts; an expected
 * alchemy yield is a projection, so it does not.
 */
describe('computeLiveProjection output credit', () => {
    const LOG = '/items/log';
    const PLANK = '/items/plank';
    const ESSENCE = '/items/foraging_essence';
    const COIN = '/items/coin';
    const CRAFT_PLANK = '/actions/crafting/plank';
    const CRAFT_BOW = '/actions/crafting/bow';
    const DECOMPOSE = '/actions/alchemy/decompose';

    /** An uncounted queued action, whose length is exactly its material limit. */
    function uncounted(id, actionHrid, primaryItemHrid = null) {
        return {
            id,
            ordinal: id,
            actionHrid,
            primaryItemHash: primaryItemHrid ? `char1::/item_locations/inventory::${primaryItemHrid}::0` : null,
            hasMaxCount: false,
            maxCount: 0,
            currentCount: 0,
            isDone: false,
        };
    }

    test('a crafted intermediate is credited to the row that consumes it', () => {
        game.itemDetails[LOG] = { itemHrid: LOG, name: 'Log', itemLevel: 1 };
        game.itemDetails[PLANK] = { itemHrid: PLANK, name: 'Plank', itemLevel: 1 };
        game.actionDetails[CRAFT_PLANK] = {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
        };
        game.actionDetails[CRAFT_BOW] = {
            hrid: CRAFT_BOW,
            name: 'Bow',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: PLANK, count: 3 }],
            outputItems: [{ itemHrid: '/items/bow', count: 1 }],
        };
        game.inventory = [stack(LOG, 60)];
        game.currentActions = [uncounted(1, CRAFT_PLANK), uncounted(2, CRAFT_BOW)];

        const projection = computeLiveProjection(NOW);

        // 60 logs → 30 planks (300s) → 10 bows (100s)
        expect(projection.segments.map((s) => s.endAt)).toEqual([NOW + 300_000, NOW + 400_000]);
    });

    test('an expected alchemy yield credits nothing, leaving the terminal estimate conservative', () => {
        game.itemDetails[CHEESE].alchemyDetail.decomposeItems = [{ itemHrid: ESSENCE, count: 1 }];
        game.itemDetails[ESSENCE] = {
            itemHrid: ESSENCE,
            name: 'Foraging Essence',
            itemLevel: 1,
            sellPrice: 100,
            alchemyDetail: { bulkMultiplier: 1, isCoinifiable: true },
        };
        game.actionDetails[DECOMPOSE] = {
            hrid: DECOMPOSE,
            name: 'Decompose',
            type: '/action_types/alchemy',
            coinCost: 0,
        };
        // Decompose bills (10 + itemLevel 10) × 5 = 100 coins per action, so the purse must
        // not be what stops it
        game.inventory = [stack(CHEESE, 5), stack(COIN, 100_000)];
        game.currentActions = [uncounted(1, DECOMPOSE, CHEESE), coinifyAction(2)];

        const projection = computeLiveProjection(NOW);

        // The 5 decomposes yield essence, but coinify runs on cheese and there is none left;
        // either way nothing stochastic may extend the projection past the decompose
        expect(projection.segments.map((s) => s.endAt)).toEqual([NOW + 50_000, NOW + 50_000]);
        expect(projection.terminalAt).toBe(NOW + 50_000);
    });
});
