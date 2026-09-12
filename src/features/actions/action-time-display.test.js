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
    /** The item flow recorder's cached gathering for whatever run id a test asks about */
    runGathering: null,
    /** Ask prices `updateRunSoFar` prices the recorder's drops at, by item hrid */
    prices: {},
    /** Settings a test wants to flip from the blanket `false` every other test relies on */
    settings: {},
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
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (_k, fallback) => fallback,
    },
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
vi.mock('../networth/item-flow-recorder.js', () => ({
    default: { getCachedRunGathering: () => game.runGathering },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (itemHrid) => (game.prices[itemHrid] ? { ask: game.prices[itemHrid] } : null),
}));

const actionTimeDisplayModule = await import('./action-time-display.js');
const actionTimeDisplay = actionTimeDisplayModule.default;
const { partialProgressNote, parseInventoryCountFromActionName } = actionTimeDisplayModule;
const { _resetGameNumberSeparators } = await import('../../utils/number-parser.js');
const { formatDateTime } = await import('../../utils/formatters.js');

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
    game.runGathering = null;
    game.prices = {};
    game.settings = {};
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

describe('updateRunSoFar — "so far this run"', () => {
    const gatheringDetails = { hrid: '/actions/milking/cow', type: '/action_types/milking' };
    const productionDetails = { hrid: '/actions/cooking/cake', type: '/action_types/cooking' };

    beforeEach(() => {
        game.settings.actionBar_showProfit = true;
        actionTimeDisplay.runElement = { innerHTML: '' };
    });

    afterEach(() => {
        actionTimeDisplay.runElement = null;
    });

    test('shows actions completed and their value, priced at today’s ask', () => {
        game.runGathering = { gained: { '/items/milk': 100 }, from: 0, to: 1000 };
        game.prices['/items/milk'] = 10;

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 100 }, gatheringDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toContain('100 actions');
        expect(actionTimeDisplay.runElement.innerHTML).toContain('1,000');
    });

    test('says the run predates recording rather than printing a lying zero', () => {
        // The game says 50 completions already happened; the recorder has
        // nothing for this run at all — it started watching after this run did.
        game.runGathering = null;

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 50 }, gatheringDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toContain('started before recording');
    });

    test('a run that has not completed anything yet is blank, not "predates recording"', () => {
        game.runGathering = null;

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 0 }, gatheringDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toBe('');
    });

    test('an action type the recorder does not cover leaves the row blank', () => {
        game.runGathering = { gained: { '/items/cake': 5 }, from: 0, to: 1000 };
        game.prices['/items/cake'] = 500;

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 100 }, productionDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toBe('');
    });

    test('the row is blank when the profit line is turned off', () => {
        game.settings.actionBar_showProfit = false;
        game.runGathering = { gained: { '/items/milk': 100 }, from: 0, to: 1000 };

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 100 }, gatheringDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toBe('');
    });

    test('clearRunSoFar blanks whatever was there', () => {
        actionTimeDisplay.runElement.innerHTML = 'stale content';

        actionTimeDisplay.clearRunSoFar();

        expect(actionTimeDisplay.runElement.innerHTML).toBe('');
    });
});

describe('updateRunSoFar — whole-run count vs. a partially recorded run', () => {
    const gatheringDetails = { hrid: '/actions/milking/cow', type: '/action_types/milking' };

    beforeEach(() => {
        game.settings.actionBar_showProfit = true;
        actionTimeDisplay.runElement = { innerHTML: '' };
        game.prices['/items/milk'] = 10;
    });

    afterEach(() => {
        actionTimeDisplay.runElement = null;
    });

    test('recording that started at or before the run pairs the whole-run count with the value, as always', () => {
        const runStart = Date.parse('2026-09-03T18:25:36Z');
        game.runGathering = { gained: { '/items/milk': 100 }, from: runStart, to: runStart + 60_000 };

        actionTimeDisplay.updateRunSoFar(
            { id: 1, currentCount: 258632, createdAt: '2026-09-03T18:25:36Z' },
            gatheringDetails
        );

        expect(actionTimeDisplay.runElement.innerHTML).toContain('This run:');
        expect(actionTimeDisplay.runElement.innerHTML).toContain('258,632 actions');
        expect(actionTimeDisplay.runElement.innerHTML).toContain('1,000');
    });

    test('a short gap (reload, feature just turned on) still counts as full coverage', () => {
        const runStart = Date.parse('2026-09-03T18:25:36Z');
        // 90 seconds late — well under the tolerance for an ordinary reload.
        game.runGathering = { gained: { '/items/milk': 100 }, from: runStart + 90_000, to: runStart + 120_000 };

        actionTimeDisplay.updateRunSoFar(
            { id: 1, currentCount: 500, createdAt: '2026-09-03T18:25:36Z' },
            gatheringDetails
        );

        expect(actionTimeDisplay.runElement.innerHTML).toContain('500 actions');
    });

    test('a run recording began materially after shows the recorded window, not the whole-run count', () => {
        // The live bug this covers: a run that began nine days before recording did, paired a
        // 258,632-action whole-run count with a value covering only the last few minutes.
        const runStart = Date.parse('2026-08-25T18:25:36Z');
        const recordedFrom = Date.parse('2026-09-03T21:25:26Z');
        game.runGathering = { gained: { '/items/milk': 100 }, from: recordedFrom, to: recordedFrom + 43_000 };

        actionTimeDisplay.updateRunSoFar(
            { id: 23002282, currentCount: 258632, createdAt: new Date(runStart).toISOString() },
            gatheringDetails
        );

        const html = actionTimeDisplay.runElement.innerHTML;
        // No whole-run action count anywhere near the value — that pairing is the bug.
        expect(html).not.toContain('258,632');
        expect(html).not.toContain('actions');
        expect(html).toContain('1,000');
        // Recorded days before the real clock's today, so the day is named.
        const expectedTime = formatDateTime(new Date(recordedFrom), { includeDate: true, includeSeconds: false });
        expect(html).toContain(`Since ${expectedTime}:`);
    });

    describe('the recorded window names its day only when that day is not today', () => {
        const runStart = Date.parse('2026-09-01T08:00:00');

        afterEach(() => {
            vi.useRealTimers();
        });

        test('a window that began today shows the time alone', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-09-12T13:00:00'));
            const recordedFrom = new Date('2026-09-12T09:30:00').getTime();
            game.runGathering = { gained: { '/items/milk': 100 }, from: recordedFrom, to: recordedFrom + 60_000 };

            actionTimeDisplay.updateRunSoFar(
                { id: 7, currentCount: 900, createdAt: new Date(runStart).toISOString() },
                gatheringDetails
            );

            const bare = formatDateTime(new Date(recordedFrom), { includeDate: false, includeSeconds: false });
            const dated = formatDateTime(new Date(recordedFrom), { includeDate: true, includeSeconds: false });
            const html = actionTimeDisplay.runElement.innerHTML;
            expect(html).toContain(`Since ${bare}:`);
            expect(html).not.toContain(`Since ${dated}:`);
        });

        test('a window that began yesterday names the day, so it cannot read as today', () => {
            // The live case: an endless Farmland run recorded since 16:58 the previous afternoon
            // read "Since 16:58", which looks like earlier the same day.
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-09-12T16:30:00'));
            const recordedFrom = new Date('2026-09-11T16:58:49').getTime();
            game.runGathering = { gained: { '/items/milk': 100 }, from: recordedFrom, to: recordedFrom + 60_000 };

            actionTimeDisplay.updateRunSoFar(
                { id: 23002282, currentCount: 258632, createdAt: new Date(runStart).toISOString() },
                gatheringDetails
            );

            const dated = formatDateTime(new Date(recordedFrom), { includeDate: true, includeSeconds: false });
            const bare = formatDateTime(new Date(recordedFrom), { includeDate: false, includeSeconds: false });
            const html = actionTimeDisplay.runElement.innerHTML;
            expect(html).toContain(`Since ${dated}:`);
            expect(dated).not.toBe(bare);
        });
    });

    test('an unparsable createdAt falls back to the whole-run pairing rather than guessing partial', () => {
        game.runGathering = { gained: { '/items/milk': 100 }, from: 999_999_999_999_999, to: 999_999_999_999_999 };

        actionTimeDisplay.updateRunSoFar({ id: 1, currentCount: 50, createdAt: undefined }, gatheringDetails);

        expect(actionTimeDisplay.runElement.innerHTML).toContain('50 actions');
    });

    test('nothing recorded at all still reads "started before recording", not "Since ..."', () => {
        game.runGathering = null;

        actionTimeDisplay.updateRunSoFar(
            { id: 1, currentCount: 50, createdAt: '2026-09-03T18:25:36Z' },
            gatheringDetails
        );

        expect(actionTimeDisplay.runElement.innerHTML).toContain('started before recording');
    });
});

describe('the "so far this run" row redraws when the recorder catches up', () => {
    const gatheringDetails = { hrid: '/actions/milking/cow', type: '/action_types/milking' };
    const action = { id: 1, currentCount: 100, createdAt: '2026-09-03T18:25:36Z' };

    beforeEach(() => {
        game.settings.actionBar_showProfit = true;
        actionTimeDisplay.runElement = { innerHTML: '' };
        game.prices['/items/milk'] = 10;
    });

    afterEach(() => {
        actionTimeDisplay.runElement = null;
        actionTimeDisplay._lastRunAction = null;
        actionTimeDisplay._lastRunActionDetails = null;
        if (actionTimeDisplay._runSoFarRedrawTimer) {
            clearTimeout(actionTimeDisplay._runSoFarRedrawTimer);
            actionTimeDisplay._runSoFarRedrawTimer = null;
        }
        actionTimeDisplay._runSoFarRedrawPending = false;
    });

    test('a row drawn while the recorder had nothing repaints once it does, with no header change', () => {
        // The row is drawn once, before item-flow-recorder's background init has landed —
        // exactly what happens on a fresh page load, an infinite gathering action whose header
        // never changes to prompt a second look on its own.
        game.runGathering = null;
        actionTimeDisplay.updateRunSoFar(action, gatheringDetails);
        expect(actionTimeDisplay.runElement.innerHTML).toContain('started before recording');

        // The recorder's data lands — nothing about the action or its header changed.
        game.runGathering = { gained: { '/items/milk': 100 }, from: 0, to: 1000 };
        actionTimeDisplay.redrawRunSoFar();

        expect(actionTimeDisplay.runElement.innerHTML).not.toContain('started before recording');
        expect(actionTimeDisplay.runElement.innerHTML).toContain('1,000');
    });

    test('redrawRunSoFar is a no-op once nothing is running (clearRunSoFar dropped the cached pair)', () => {
        actionTimeDisplay.updateRunSoFar(action, gatheringDetails);
        actionTimeDisplay.clearRunSoFar();

        game.runGathering = { gained: { '/items/milk': 100 }, from: 0, to: 1000 };
        actionTimeDisplay.redrawRunSoFar();

        // clearRunSoFar's blank must not be overwritten by a stale run's redraw.
        expect(actionTimeDisplay.runElement.innerHTML).toBe('');
    });

    test('scheduleRunSoFarRedraw redraws immediately, then collapses a burst into one trailing redraw', () => {
        vi.useFakeTimers();
        try {
            game.runGathering = null;
            actionTimeDisplay.updateRunSoFar(action, gatheringDetails);

            // First notification: leading-edge redraw, immediate.
            game.runGathering = { gained: { '/items/milk': 100 }, from: 0, to: 1000 };
            actionTimeDisplay.scheduleRunSoFarRedraw();
            expect(actionTimeDisplay.runElement.innerHTML).toContain('1,000');

            // A burst of further notifications inside the throttle window must not each redraw —
            // only collapse into one trailing redraw once the window closes.
            game.runGathering = { gained: { '/items/milk': 500 }, from: 0, to: 1000 };
            actionTimeDisplay.scheduleRunSoFarRedraw();
            actionTimeDisplay.scheduleRunSoFarRedraw();
            // Still the first value — the trailing redraw has not fired yet.
            expect(actionTimeDisplay.runElement.innerHTML).toContain('1,000');
            expect(actionTimeDisplay.runElement.innerHTML).not.toContain('5,000');

            vi.runAllTimers();
            expect(actionTimeDisplay.runElement.innerHTML).toContain('5,000');
        } finally {
            vi.useRealTimers();
        }
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
