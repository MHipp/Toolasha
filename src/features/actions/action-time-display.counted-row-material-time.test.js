/**
 * A counted queue row is displayed for what it can actually perform.
 *
 * The queue walk already spends only what a row can pay for: the ledger clamps every row
 * against its own material limit before charging it. The displayed time did not follow.
 * `calculateSingleQueueActionTime` computed a material limit for uncounted ("Repeat ∞")
 * rows only, so a counted row — "produce 500" — showed the time for all 500 while the
 * ledger it fed spent the 40 it could really run. The row contradicted itself, and every
 * "Complete at" clock built on the running total after it was wrong.
 *
 * The rule chosen matches the one already used for limits: show the real remainder, zero
 * included. A row that can perform nothing reads `[0s]` rather than promising minutes of
 * work that will not happen.
 *
 * The single-action basis is untouched. `calculateSingleQueueActionTime` also answers for a
 * lone action, where the whole bag genuinely is the right basis, so the cap is opt-in and
 * only the queue walks ask for it.
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

// A flat 10s per action with no efficiency keeps every expected time a round number.
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

const LOG = '/items/log';
const PLANK = '/items/plank';
const BOW = '/items/bow';
const STAR_FRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const COIN = '/items/coin';

const CRAFT_PLANK = '/actions/crafting/plank';
const CRAFT_BOW = '/actions/crafting/bow';
const DECOMPOSE = '/actions/alchemy/decompose';
const COINIFY = '/actions/alchemy/coinify';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

/** One queued action; `maxCount` makes it a counted row, its absence a Repeat ∞ one. */
function queued(id, actionHrid, { maxCount, primaryItemHrid } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: primaryItemHrid ? hashFor(primaryItemHrid) : null,
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

/** The "Complete at HH:MM:SS" clock each row renders, marker included. */
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
        [LOG]: { itemHrid: LOG, name: 'Log', itemLevel: 1 },
        [PLANK]: { itemHrid: PLANK, name: 'Plank', itemLevel: 1 },
        [BOW]: { itemHrid: BOW, name: 'Bow', itemLevel: 1 },
        [STAR_FRUIT]: {
            itemHrid: STAR_FRUIT,
            name: 'Star Fruit',
            itemLevel: 10,
            sellPrice: 20,
            // Decompose yields essence per success, and the success is a coin flip — so the
            // yield credited to later rows is an expected value, not stock in hand.
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: ESSENCE, count: 1 }] },
        },
        [ESSENCE]: {
            itemHrid: ESSENCE,
            name: 'Foraging Essence',
            itemLevel: 1,
            sellPrice: 100,
            alchemyDetail: { bulkMultiplier: 10, isCoinifiable: true },
        },
    };
    game.actionDetails = {
        [CRAFT_PLANK]: {
            hrid: CRAFT_PLANK,
            name: 'Plank',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: LOG, count: 2 }],
            outputItems: [{ itemHrid: PLANK, count: 1 }],
        },
        [CRAFT_BOW]: {
            hrid: CRAFT_BOW,
            name: 'Bow',
            type: '/action_types/crafting',
            coinCost: 0,
            inputItems: [{ itemHrid: PLANK, count: 3 }],
            outputItems: [{ itemHrid: BOW, count: 1 }],
        },
        [DECOMPOSE]: { hrid: DECOMPOSE, name: 'Decompose', type: '/action_types/alchemy', coinCost: 0 },
        [COINIFY]: { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy', coinCost: 0 },
    };
    game.inventory = [];
    game.currentActions = [];
    actionTimeDisplay.initializeQueueTooltipObserver();
});

afterEach(() => {
    tooltipObserver.disable();
    vi.useRealTimers();
});

describe('a counted queue row shows the time it can actually run', () => {
    test('a request for 500 backed by materials for 40 displays the time for 40', () => {
        // 80 logs at 2 per plank buys 40 of the 500 requested crafts
        game.inventory = [stack(LOG, 80)];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 500 })];

        const el = queueTooltipPopper(['Plank']);
        observerState.handler(el);

        // 40 × 10s, not 500 × 10s
        expect(rowLimits(el)).toEqual(['[0h 06m 40s]']);
    });

    test('a counted row that can perform none of its request reads as no time', () => {
        game.inventory = [];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 500 })];

        const el = queueTooltipPopper(['Plank']);
        observerState.handler(el);

        // The same plain bracket a finished row shows: no work left here. No new vocabulary,
        // and no minutes promised that will never be run.
        expect(rowLimits(el)).toEqual(['[0s]']);
    });

    test('the "Complete at" chain after a starved counted row follows the shortened time', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T10:00:00'));

        // Row 1 asks for 500 planks, can afford 40 (400s), and credits those 40 planks.
        // Row 2 (Repeat ∞) turns 3 planks into a bow: 13 bows, 130s.
        game.inventory = [stack(LOG, 80)];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 500 }), queued(2, CRAFT_BOW)];

        const el = queueTooltipPopper(['Plank', 'Bow']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[0h 06m 40s]', '[0h 02m 10s · mat: 13]']);

        const start = 10 * 3600;
        const clocks = rowClocks(el).map(clockSeconds);
        expect(clocks[0] - start).toBe(400);
        expect(clocks[1] - start).toBe(530);
    });

    test('the row spends exactly what it displays', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(LOG, 80)]);
        const action = queued(1, CRAFT_PLANK, { maxCount: 500 });
        const details = game.actionDetails[CRAFT_PLANK];

        const timing = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup, {
            limitCountedByMaterials: true,
        });
        const performed = actionTimeDisplay.deductQueueActionMaterials(lookup, details, action, timing);

        // Displayed count and displayed time agree with what the ledger charged
        expect(timing.count).toBe(40);
        expect(timing.totalTime).toBe(400);
        expect(performed).toBe(40);
        expect(lookup.byHrid[LOG]).toBe(0);
        expect(lookup.byHrid[PLANK]).toBe(40);
    });

    test('a counted row inside its materials is unchanged', () => {
        game.inventory = [stack(LOG, 80)];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 10 })];

        const el = queueTooltipPopper(['Plank']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[0h 01m 40s]']);
    });
});

describe('the single-action basis is untouched', () => {
    test('an unqueued action still prices its full request against the whole bag', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(LOG, 80)]);
        const action = queued(1, CRAFT_PLANK, { maxCount: 500 });
        const details = game.actionDetails[CRAFT_PLANK];

        const timing = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup);

        expect(timing.count).toBe(500);
        expect(timing.totalTime).toBe(5000);
        expect(timing.materialLimit).toBe(null);
        expect(timing.limitType).toBe(null);
        expect(timing.materialLimitIsEstimated).toBe(false);
        // Still pure with respect to the lookup it is handed
        expect(lookup.byHrid[LOG]).toBe(80);
        expect(lookup.byHrid[PLANK]).toBeUndefined();
    });
});

describe('a counted row capped by projected yield is marked as an estimate', () => {
    test('the clock after a row limited by credited expected yield carries ~', () => {
        // Row 1: 100 decomposes at 0.6 success → 60 essence expected (an estimate).
        // Row 2 asks to coinify 500 times; 10 essence per action caps it at 6.
        game.inventory = [stack(STAR_FRUIT, 100), stack(COIN, 1_000_000)];
        game.currentActions = [
            queued(1, DECOMPOSE, { primaryItemHrid: STAR_FRUIT }),
            queued(2, COINIFY, { maxCount: 500, primaryItemHrid: ESSENCE }),
        ];

        const el = queueTooltipPopper(['Decompose: Star Fruit', 'Coinify: Foraging Essence']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[0h 16m 40s · mat: 100]', '[0h 01m 00s]']);

        // Row 2's figure rests on essence that has not been produced yet, so its clock — and
        // every clock built on the running total after it — is marked as a projection.
        const clocks = rowClocks(el);
        expect(clocks[0].startsWith('~')).toBe(false);
        expect(clocks[1].startsWith('~')).toBe(true);
    });
});

describe('the queue edit menu, which duplicates the timing logic inline, agrees', () => {
    /** The queue edit menu, whose rows carry the same markup as the tooltip's. */
    function queueEditMenu(rowNames) {
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
        el.className = 'QueuedActions_queuedActions__menu';
        el.innerHTML = rows;
        document.body.appendChild(el);
        return el;
    }

    test('a starved counted row shows the same shortened time it does in the tooltip', () => {
        game.inventory = [stack(LOG, 80)];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 500 })];

        const el = queueEditMenu(['Plank']);
        actionTimeDisplay.injectQueueTimes(el);

        expect(rowLimits(el)).toEqual(['[0h 06m 40s]']);
    });

    test('a counted row with nothing to work with shows no time', () => {
        game.inventory = [];
        game.currentActions = [queued(1, CRAFT_PLANK, { maxCount: 500 })];

        const el = queueEditMenu(['Plank']);
        actionTimeDisplay.injectQueueTimes(el);

        expect(rowLimits(el)).toEqual(['[0s]']);
    });
});
