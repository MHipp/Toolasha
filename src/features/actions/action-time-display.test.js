/**
 * Tests for calculateMaterialLimit's alchemy branch.
 *
 * Alchemy charges a coin fee per action that the game's action data does not
 * carry — actionDetails.coinCost is 0 for every alchemy action — so the limit
 * has to derive it from the item. Getting this wrong does not look wrong: the
 * queue just claims more actions than the character can pay for.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    itemDetails: {},
}));

// Track every watcher setupActionNameObserver creates and whether it was
// disconnected, so a leaked duplicate observer is detectable without a real DOM.
const watchers = vi.hoisted(() => ({ disconnects: [] }));

vi.mock('../../utils/dom-observer-helpers.js', async () => {
    const actual = await vi.importActual('../../utils/dom-observer-helpers.js');
    return {
        ...actual,
        createMutationWatcher: () => {
            const disconnect = vi.fn();
            watchers.disconnects.push(disconnect);
            return disconnect;
        },
    };
});

// The current-unit partial-progress boundary the ETA subtracts (upstream 9210b4ab). Tests
// swap this for a stub that answers for one (actionId, currentCount) pair and 0 elsewhere,
// which is exactly the contract dataManager offers.
const progress = vi.hoisted(() => ({ elapsed: () => 0 }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getCurrentActions: () => [],
        getElapsedSecondsInCurrentUnit: (...args) => progress.elapsed(...args),
        on: () => () => {},
    },
}));

const enhancement = vi.hoisted(() => ({ predictions: null }));

vi.mock('../enhancement/enhancement-xp.js', () => ({
    calculateEnhancementPredictions: () => enhancement.predictions,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, fallback) => fallback },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const actionTimeDisplayModule = await import('./action-time-display.js');
const actionTimeDisplay = actionTimeDisplayModule.default;
const { partialProgressNote, parseInventoryCountFromActionName } = actionTimeDisplayModule;
const { _resetGameNumberSeparators } = await import('../../utils/number-parser.js');

const CHEESE = '/items/cheese';
const COIN = '/items/coin';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

beforeEach(() => {
    progress.elapsed = () => 0;
    enhancement.predictions = null;
    game.itemDetails = {
        [CHEESE]: {
            itemHrid: CHEESE,
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, transmuteSuccessRate: 0.5 },
        },
    };
});

describe('setupActionNameObserver does not leak a duplicate observer', () => {
    test('a second setup disconnects the first watcher before replacing it', () => {
        // Both waitForActionPanel() and the persistent Header_actionName watcher
        // call this on a character switch. Without the disconnect guard the
        // second call orphaned the first observer — its handle lost — and the
        // leaked observer, which updateDisplay() can no longer reach to silence,
        // fired on the stats-span append and looped until the tab froze
        // (upstream Celasha/Toolasha#623).
        watchers.disconnects.length = 0;
        actionTimeDisplay.actionNameObserver = null;

        actionTimeDisplay.setupActionNameObserver({});
        actionTimeDisplay.setupActionNameObserver({});

        expect(watchers.disconnects).toHaveLength(2);
        expect(watchers.disconnects[0]).toHaveBeenCalledTimes(1);
        expect(watchers.disconnects[1]).not.toHaveBeenCalled();

        actionTimeDisplay.actionNameObserver = null;
    });
});

describe('calculateMaterialLimit — alchemy coin fee', () => {
    test('gold limits a decompose queue even though actionDetails.coinCost is 0', () => {
        // (10 + itemLevel 10) × 5 = 100 coins per action; 550 coins buys 5
        const inventory = [stack(CHEESE, 100), stack(COIN, 550)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 5, limitType: 'gold', isEstimated: false });
    });

    test('transmute prices the fee off the sell price, not the item level', () => {
        // max(50, 1000 / 5) = 200 coins per action; 1000 coins buys 5
        const inventory = [stack(CHEESE, 100), stack(COIN, 1000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/transmute', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 5, limitType: 'gold', isEstimated: false });
    });

    test('the fee scales with the bulk multiplier', () => {
        game.itemDetails[CHEESE].alchemyDetail.bulkMultiplier = 10;
        // (10 + 10) × 5 × 10 = 1000 per action; 3000 coins buys 3, and 100 cheese at
        // 10 per action would otherwise allow 10
        const inventory = [stack(CHEESE, 100), stack(COIN, 3000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 3, limitType: 'gold', isEstimated: false });
    });

    test('the material still wins when it is scarcer than the gold', () => {
        const inventory = [stack(CHEESE, 4), stack(COIN, 10_000_000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 4, limitType: `material:${CHEESE}`, isEstimated: false });
    });

    test('coinify charges no derived fee, so only the item limits it', () => {
        const inventory = [stack(CHEESE, 7), stack(COIN, 0)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/coinify', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 7, limitType: `material:${CHEESE}`, isEstimated: false });
    });

    test('an enhanced stack only counts at its own enhancement level', () => {
        const inventory = [stack(CHEESE, 6, 3), stack(CHEESE, 99, 0), stack(COIN, 10_000_000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE, 3) }
        );

        expect(limit).toEqual({ maxActions: 6, limitType: `material:${CHEESE}`, isEstimated: false });
    });
});

describe('partial progress in the in-progress unit (upstream 9210b4ab)', () => {
    // The modelled total counts the action already running as a whole unit, so on every
    // reload the ETA used to restart it from zero and walk later. These drive
    // calculateEnhancingQueueTime because it is the shortest path to a time total; every
    // other call site subtracts through the same dataManager helper.
    const MIRROR = '/items/philosophers_mirror';

    const enhancingAction = (overrides = {}) => ({
        id: 42,
        currentCount: 3,
        hasMaxCount: true,
        maxCount: 13,
        primaryItemHash: hashFor(CHEESE, 0),
        enhancingMaxLevel: 4,
        enhancingProtectionMinLevel: 0,
        ...overrides,
    });

    const details = { hrid: '/actions/enhancing/enhance', type: '/action_types/enhancing', coinCost: 0 };

    test('a valid boundary is subtracted from the total, once', () => {
        enhancement.predictions = { expectedAttempts: 10, expectedProtections: 0, perActionTime: 20 };
        progress.elapsed = (actionId, currentCount, unitDuration) =>
            actionId === 42 && currentCount === 3 ? Math.min(8, unitDuration) : 0;

        // 10 remaining attempts x 20s, less the 8s the running attempt has already had
        expect(actionTimeDisplay.calculateEnhancingQueueTime(enhancingAction(), details, {})).toEqual({
            count: 10,
            totalTime: 192,
        });
    });

    test('with no boundary the total is the unchanged full model', () => {
        enhancement.predictions = { expectedAttempts: 10, expectedProtections: 0, perActionTime: 20 };

        expect(actionTimeDisplay.calculateEnhancingQueueTime(enhancingAction(), details, {})).toEqual({
            count: 10,
            totalTime: 200,
        });
    });

    test('a boundary belonging to a different action is not borrowed', () => {
        enhancement.predictions = { expectedAttempts: 10, expectedProtections: 0, perActionTime: 20 };
        progress.elapsed = (actionId) => (actionId === 99 ? 8 : 0);

        expect(actionTimeDisplay.calculateEnhancingQueueTime(enhancingAction(), details, {})).toEqual({
            count: 10,
            totalTime: 200,
        });
    });

    test('the mirror path subtracts too, and never goes negative', () => {
        enhancement.predictions = { expectedAttempts: 1, expectedProtections: 0, perActionTime: 20 };
        // One guaranteed action left (level 3 -> 4), already 20s into it
        progress.elapsed = () => 20;

        const action = enhancingAction({
            maxCount: 4,
            currentCount: 3,
            primaryItemHash: hashFor(CHEESE, 3),
            secondaryItemHash: hashFor(MIRROR, 0),
        });

        expect(actionTimeDisplay.calculateEnhancingQueueTime(action, details, {})).toEqual({
            count: 1,
            totalTime: 0,
        });
    });
});

describe('partialProgressNote — the ETA tooltip naming the boundary it subtracted', () => {
    test('nothing subtracted is nothing shown', () => {
        expect(partialProgressNote(0)).toBe('');
    });

    test('a boundary too small to matter is still not shown', () => {
        expect(partialProgressNote(0.04)).toBe('');
    });

    test('a real boundary names the exact seconds subtracted', () => {
        const html = partialProgressNote(8.2);

        expect(html).toContain('ⓘ');
        expect(html).toContain('8.2s already spent');
    });
});

describe('parseInventoryCountFromActionName — locale-grouped counts', () => {
    /** Point the game's language key at one locale for the duration of a test. */
    const asLocale = (value) => {
        vi.stubGlobal('localStorage', { getItem: (key) => (key === 'i18nextLng' ? value : null) });
        _resetGameNumberSeparators();
    };

    beforeEach(() => asLocale('en-US'));

    afterEach(() => {
        vi.unstubAllGlobals();
        _resetGameNumberSeparators();
    });

    test('en-US comma grouping', () => {
        expect(parseInventoryCountFromActionName('Coinify: Item (4,312)')).toBe(4312);
    });

    test('de-DE period grouping — the bug this replaces', () => {
        // A hardcoded `[\d,]+` reads "(4.312)" as "(4)": the period isn't in
        // the class, so the match stops at the first group boundary.
        asLocale('de-DE');
        expect(parseInventoryCountFromActionName('Coinify: Item (4.312)')).toBe(4312);
    });

    test('no trailing count is null, not zero', () => {
        expect(parseInventoryCountFromActionName('Coinify: Item')).toBeNull();
    });
});

describe('calculateMaterialLimit — non-alchemy actions', () => {
    test('a real coinCost on a production action is still honoured', () => {
        const inventory = [stack(COIN, 250)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/enhancing/enhance', type: '/action_types/enhancing', coinCost: 100 },
            inventory,
            0,
            null
        );

        expect(limit).toEqual({ maxActions: 2, limitType: 'gold', isEstimated: false });
    });

    test('an action with no inputs and no cost is unlimited', () => {
        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/milking/cow', type: '/action_types/milking', coinCost: 0 },
            [],
            0,
            null
        );

        expect(limit).toBeNull();
    });
});
