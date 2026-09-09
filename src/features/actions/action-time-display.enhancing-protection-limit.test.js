/**
 * Protection items are a channel of an enhancing row's bill.
 *
 * A queued row is capped by the materials it can actually pay for, and the queue's ledger
 * spends what each row performs. For enhancing, the only channel either side counted was
 * `enhancementCosts` on the item being enhanced. A protection item — `mirror_of_protection`
 * and friends, or the Philosopher's Mirror on the mirror path — is consumed too, so a row
 * with materials for 500 attempts but protections for 3 was displayed, and charged, for 500.
 *
 * It was left out on purpose while only one side could count it: binding the display on
 * protections while the ledger ignored them would recreate the contradiction the capping
 * work exists to close. Both sides now read one helper, `getEnhancingProtectionDraw`, so
 * they cannot disagree.
 *
 * A protection is spent only on a failed attempt, so its per-attempt cost is an expectation
 * (`expectedProtections / expectedAttempts` from the enhancement prediction), and every
 * figure resting on it carries the `~` estimate marker. The Philosopher's Mirror is the one
 * exception: it is spent on every attempt, so it is exact.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
    },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
    predictions: null,
    settings: {},
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
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (key, fallback) => game.settings[key] ?? fallback,
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_SECONDARY: '#def',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => game.predictions }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const SWORD = '/items/cheese_sword';
const ESSENCE = '/items/enhancing_essence';
const PROTECTION = '/items/mirror_of_protection';
const PHILOSOPHERS_MIRROR = '/items/philosophers_mirror';
const ENHANCE = '/actions/enhancing/enhance';

const PER_ACTION = 10;

/** Inventory rows in the one location the lookup counts */
const stack = (itemHrid, count, enhancementLevel = 0) => ({
    itemHrid,
    count,
    enhancementLevel,
    itemLocationHrid: '/item_locations/inventory',
});

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

/**
 * One enhancing row for the sword.
 * @param {Object} [opts] - maxCount (absent = Repeat ∞), protectionItemHrid, protectFrom
 */
function enhancingRow({ maxCount, protectionItemHrid = null, protectFrom = 5 } = {}) {
    return {
        id: 1,
        ordinal: 1,
        actionHrid: ENHANCE,
        primaryItemHash: hashFor(SWORD, 1),
        hasMaxCount: maxCount !== undefined,
        maxCount: maxCount ?? 0,
        currentCount: 0,
        enhancingMaxLevel: 16,
        enhancingProtectionMinLevel: protectionItemHrid ? protectFrom : 0,
        enhancingProtectionItemHrid: protectionItemHrid,
    };
}

const details = () => game.actionDetails[ENHANCE];

beforeEach(() => {
    game.settings = { actionQueue: true, actionPanel_enhanceMatLimitProtections: true };
    game.actionDetails = { [ENHANCE]: { type: '/action_types/enhancing', hrid: ENHANCE } };
    game.itemDetails = {
        [SWORD]: { hrid: SWORD, enhancementCosts: [{ itemHrid: ESSENCE, count: 1 }] },
        [ESSENCE]: { hrid: ESSENCE },
        [PROTECTION]: { hrid: PROTECTION },
        [PHILOSOPHERS_MIRROR]: { hrid: PHILOSOPHERS_MIRROR },
    };
    // One protection expected per ten attempts, so 3 protections buy 30 attempts.
    game.predictions = {
        expectedAttempts: 1000,
        expectedProtections: 100,
        perActionTime: PER_ACTION,
        successMultiplier: 1,
    };
    game.inventory = [stack(ESSENCE, 500), stack(PROTECTION, 3)];
});

describe('the limit counts the protection draw', () => {
    test('a row with materials for 500 attempts but protections for 30 is capped at 30', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const limit = actionTimeDisplay.calculateMaterialLimit(
            details(),
            lookup,
            0,
            enhancingRow({ protectionItemHrid: PROTECTION })
        );

        expect(limit.maxActions).toBe(30);
        expect(limit.limitType).toBe(`material:${PROTECTION}`);
        // The draw is an expectation, so the figure must never present as exact
        expect(limit.isEstimated).toBe(true);
    });

    test('the capped row displays the estimate marker and the ledger spends what it displays', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ maxCount: 500, protectionItemHrid: PROTECTION });

        const result = actionTimeDisplay.calculateSingleQueueActionTime(action, details(), lookup, {
            limitCountedByMaterials: true,
        });

        expect(result.count).toBe(30);
        expect(result.materialLimitIsEstimated).toBe(true);

        // The same row, charged against the same lookup: display and ledger in one assertion
        const performed = actionTimeDisplay.deductQueueActionMaterials(lookup, details(), action, result);
        expect(performed).toBe(result.count);
        expect(lookup.byHrid[ESSENCE]).toBe(470);
        expect(lookup.byHrid[PROTECTION]).toBeCloseTo(0, 10);
    });

    test('no count reaching a display or the ledger is Infinity, NaN or negative', () => {
        game.inventory = [stack(ESSENCE, 500)];
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ maxCount: 500, protectionItemHrid: PROTECTION });

        const result = actionTimeDisplay.calculateSingleQueueActionTime(action, details(), lookup, {
            limitCountedByMaterials: true,
        });

        expect(Number.isFinite(result.count)).toBe(true);
        expect(result.count).toBe(0);
        expect(actionTimeDisplay.deductQueueActionMaterials(lookup, details(), action, result)).toBe(0);
    });
});

describe('a run with no protection configured is unchanged', () => {
    test('the limit is the material limit, exact and unmarked', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const limit = actionTimeDisplay.calculateMaterialLimit(details(), lookup, 0, enhancingRow({}));

        expect(limit).toEqual({ maxActions: 500, limitType: `material:${ESSENCE}`, isEstimated: false });
    });

    test('the ledger spends only enhancement costs', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ maxCount: 40 });
        const performed = actionTimeDisplay.deductQueueActionMaterials(lookup, details(), action, { count: 40 });

        expect(performed).toBe(40);
        expect(lookup.byHrid[ESSENCE]).toBe(460);
        expect(lookup.byHrid[PROTECTION]).toBe(3);
    });

    test('turning the setting off restores the unprotected figures exactly', () => {
        game.settings.actionPanel_enhanceMatLimitProtections = false;
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const limit = actionTimeDisplay.calculateMaterialLimit(
            details(),
            lookup,
            0,
            enhancingRow({ protectionItemHrid: PROTECTION })
        );

        expect(limit).toEqual({ maxActions: 500, limitType: `material:${ESSENCE}`, isEstimated: false });
    });
});

describe('the mirror path behaves like the plain path', () => {
    test('a Philosopher’s Mirror row is capped by the mirrors held, exactly', () => {
        game.inventory = [stack(ESSENCE, 500), stack(PHILOSOPHERS_MIRROR, 7)];
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ protectionItemHrid: PHILOSOPHERS_MIRROR, protectFrom: 0 });

        const limit = actionTimeDisplay.calculateMaterialLimit(details(), lookup, 0, action);
        expect(limit.maxActions).toBe(7);
        expect(limit.limitType).toBe(`material:${PHILOSOPHERS_MIRROR}`);
        // One mirror per attempt is a flat cost, not an expectation
        expect(limit.isEstimated).toBe(false);
    });

    test('an infinite mirror row displays the mirrors it has and spends them', () => {
        game.inventory = [stack(ESSENCE, 500), stack(PHILOSOPHERS_MIRROR, 7)];
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ protectionItemHrid: PHILOSOPHERS_MIRROR, protectFrom: 0 });

        const result = actionTimeDisplay.calculateSingleQueueActionTime(action, details(), lookup, {
            limitCountedByMaterials: true,
        });
        // 16 - 1 = 15 guaranteed successes wanted, but only 7 mirrors to pay for them
        expect(result.count).toBe(7);

        const performed = actionTimeDisplay.deductQueueActionMaterials(lookup, details(), action, result);
        expect(performed).toBe(7);
        expect(lookup.byHrid[PHILOSOPHERS_MIRROR]).toBe(0);
        expect(lookup.byHrid[ESSENCE]).toBe(493);
    });
});

describe('a protection that cannot be quantified', () => {
    // Decision: a configured protection the calculation cannot quantify neither caps the row
    // at zero nor passes as unlimited protection — the row keeps its material limit and is
    // marked as an estimate, so it never presents as an exact promise.
    test('an unknown protection item leaves the material limit standing, marked', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ protectionItemHrid: '/items/not_a_real_item' });
        const limit = actionTimeDisplay.calculateMaterialLimit(details(), lookup, 0, action);

        expect(limit.maxActions).toBe(500);
        expect(limit.limitType).toBe(`material:${ESSENCE}`);
        expect(limit.isEstimated).toBe(true);
    });

    test('a prediction that cannot be computed does the same', () => {
        game.predictions = null;
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ protectionItemHrid: PROTECTION });
        const limit = actionTimeDisplay.calculateMaterialLimit(details(), lookup, 0, action);

        expect(limit.maxActions).toBe(500);
        expect(limit.isEstimated).toBe(true);
    });
});

describe('the single-action basis is untouched', () => {
    test('an unqueued enhancing action is shown for what it asked, against the whole bag', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup(game.inventory);
        const action = enhancingRow({ maxCount: 500, protectionItemHrid: PROTECTION });

        const result = actionTimeDisplay.calculateSingleQueueActionTime(action, details(), lookup);

        expect(result.count).toBe(500);
        expect(result.materialLimit).toBe(null);
        // and nothing was spent
        expect(lookup.byHrid[PROTECTION]).toBe(3);
        expect(lookup.byHrid[ESSENCE]).toBe(500);
    });
});
