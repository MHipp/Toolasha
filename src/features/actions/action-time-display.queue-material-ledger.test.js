/**
 * The queue's running material ledger.
 *
 * A queue is executed in order, so an action can only draw on what the actions before it
 * left behind. Both queue walks built the inventory lookup once and handed that same
 * unchanged object to every row, so every row was costed against the full starting bag:
 * three Coinify rows over one stack of cheese each claimed the whole stack, and the
 * cumulative "Complete at" clock inherited the inflated counts.
 *
 * A starved row is shown honestly — `[0s · mat: 0]` — rather than hidden or softened.
 *
 * `calculateSingleQueueActionTime` itself stays pure with respect to the lookup it is
 * handed: it also serves single-action displays, where the whole bag is the right basis.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));

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

// The duration engine is not what this file is about; a flat 10s per action with no
// efficiency keeps every expected time a round number.
const ACTION_TIME = 10;
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: ACTION_TIME, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

const CHEESE = '/items/cheese';
const COIN = '/items/coin';
const COINIFY = '/actions/alchemy/coinify';
const DECOMPOSE = '/actions/alchemy/decompose';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

/**
 * One queued alchemy action. Without `maxCount` it is "infinite" — the shape whose displayed
 * count is the material limit, which is exactly what the ledger has to move.
 */
function alchemyAction(id, actionHrid, { maxCount } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: hashFor(CHEESE),
        hasMaxCount: maxCount !== undefined,
        maxCount: maxCount ?? 0,
        currentCount: 0,
    };
}

/** The "+N Queued Actions" popper with one row per queued action. */
function queueTooltipPopper(rowNames) {
    const rows = rowNames
        .map(
            (name, i) => `
                <div class="QueuedActions_action__item">
                    <div class="QueuedActions_actionText__y">
                        <div class="QueuedActions_text__z">#${i + 1}${name}</div>
                    </div>
                </div>`
        )
        .join('');
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `
        <div class="QueuedActions_queuedActionsTooltip__x">
            <div class="QueuedActions_actions__container">${rows}</div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

/** The `[...]` bracket each row renders, without the wall-clock completion time. */
function rowLimits(el) {
    return [...el.querySelectorAll('.mwi-queue-action-time')].map(
        (row) => row.textContent.match(/^\[[^\]]*\]/)?.[0] ?? row.textContent
    );
}

/** The "Complete at HH:MM" clock each row renders. */
function rowClocks(el) {
    return [...el.querySelectorAll('.mwi-queue-action-time')].map(
        (row) => row.textContent.match(/Complete at (.*)$/)?.[1] ?? null
    );
}

/** Seconds-of-day for a rendered "Complete at" clock, which carries seconds. */
function clockSeconds(clock) {
    const [, h, m, s] = clock.match(/(\d+):(\d+):(\d+)/);
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.itemDetails = {
        [CHEESE]: {
            itemHrid: CHEESE,
            name: 'Cheese',
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, transmuteSuccessRate: 0.5 },
        },
    };
    game.actionDetails = {
        [COINIFY]: { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy', coinCost: 0 },
        [DECOMPOSE]: { hrid: DECOMPOSE, name: 'Decompose', type: '/action_types/alchemy', coinCost: 0 },
    };
    game.inventory = [];
    game.currentActions = [];
    actionTimeDisplay.initializeQueueTooltipObserver();
});

afterEach(() => {
    tooltipObserver.disable();
});

describe('queue tooltip costs each row against what the rows before it leave', () => {
    test('a second row drawing on a spent stack reports zero, not the full stack', () => {
        game.inventory = [stack(CHEESE, 5)];
        game.currentActions = [alchemyAction(1, COINIFY), alchemyAction(2, COINIFY)];

        const el = queueTooltipPopper(['Coinify: Cheese', 'Coinify: Cheese']);
        observerState.handler(el);

        // 5 cheese buys 5 actions at 10s each; the second row inherits an empty bag
        expect(rowLimits(el)).toEqual(['[50s · mat: 5]', '[0s · mat: 0]']);
    });

    test('a counted row spends only what it performs, and the clock follows the reduced counts', () => {
        game.inventory = [stack(CHEESE, 8)];
        game.currentActions = [alchemyAction(1, COINIFY, { maxCount: 3 }), alchemyAction(2, COINIFY)];

        const el = queueTooltipPopper(['Coinify: Cheese', 'Coinify: Cheese']);
        observerState.handler(el);

        // Row 1 performs its 3 requested actions (30s) and spends 3 cheese, leaving 5
        expect(rowLimits(el)).toEqual(['[30s]', '[50s · mat: 5]']);

        // Cumulative: row 2 ends 50s after row 1, not the 80s an unspent bag would imply
        const clocks = rowClocks(el).map(clockSeconds);
        expect(clocks[1] - clocks[0]).toBe(50);
    });

    test('alchemy coin fees are spent too, so the second row is limited by the coins left', () => {
        // (10 + itemLevel 10) × 5 = 100 coins per decompose; 550 coins buys 5
        game.inventory = [stack(CHEESE, 10_000), stack(COIN, 550)];
        game.currentActions = [alchemyAction(1, DECOMPOSE), alchemyAction(2, DECOMPOSE)];

        const el = queueTooltipPopper(['Decompose: Cheese', 'Decompose: Cheese']);
        observerState.handler(el);

        // Row 1 pays 500 of the 550 coins; 50 left buys nothing
        expect(rowLimits(el)).toEqual(['[50s · gold: 5]', '[0s · gold: 0]']);
    });
});

describe('the per-action helper still prices against the whole bag', () => {
    test('calculateSingleQueueActionTime does not spend from the lookup it is handed', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(CHEESE, 5)]);
        const action = alchemyAction(1, COINIFY);
        const details = game.actionDetails[COINIFY];

        const first = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup);
        const second = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup);

        expect(first.materialLimit).toBe(5);
        expect(second.materialLimit).toBe(5);
        expect(lookup.byHrid[CHEESE]).toBe(5);
    });
});
