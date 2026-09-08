/**
 * The queue's running material ledger, on the production side.
 *
 * The ledger spent what each queued action consumed but never credited what it produced, so
 * a row fed by an earlier row in the same queue was costed against stock in hand alone. The
 * live case: Star Fruit foraging (∞) → Decompose: Star Fruit (material-limited) → Coinify:
 * Foraging Essence. Every decompose yields essence, none of it was counted, and the coinify
 * row's limit — and the "Complete at" clock built on it — were badly understated.
 *
 * Two tiers, trusted differently. A deterministic output (`outputItems`) is as good as stock
 * in hand and its row stays exact. A stochastic one (drop rates, alchemy success) is an
 * expected value, and any figure resting on it is marked `~` so a projection is never read
 * as stock.
 *
 * A truly infinite producer credits nothing: it never hands the queue back, so nothing after
 * it is reachable. That is `isTrulyInfinite`, not "queued with Repeat ∞" — a Repeat ∞ row
 * capped by its materials both spends and credits.
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

const STAR_FRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const LOG = '/items/log';
const PLANK = '/items/plank';
const BOW = '/items/bow';
const COIN = '/items/coin';

const FORAGE_STAR_FRUIT = '/actions/foraging/star_fruit';
const DECOMPOSE = '/actions/alchemy/decompose';
const COINIFY = '/actions/alchemy/coinify';
const CRAFT_PLANK = '/actions/crafting/plank';
const CRAFT_BOW = '/actions/crafting/bow';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

/**
 * One queued action. Without `maxCount` it is "infinite" — the shape whose displayed count is
 * the material limit, which is exactly the figure the credit has to move.
 */
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

beforeEach(() => {
    document.body.innerHTML = '';
    game.itemDetails = {
        [STAR_FRUIT]: {
            itemHrid: STAR_FRUIT,
            name: 'Star Fruit',
            itemLevel: 10,
            sellPrice: 20,
            // Decompose yields the skill essence — deterministic per success, but the
            // success itself is a coin flip, so the yield is an expected value.
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: ESSENCE, count: 1 }] },
        },
        [ESSENCE]: {
            itemHrid: ESSENCE,
            name: 'Foraging Essence',
            itemLevel: 1,
            sellPrice: 100,
            alchemyDetail: { bulkMultiplier: 10, isCoinifiable: true },
        },
        [LOG]: { itemHrid: LOG, name: 'Log', itemLevel: 1 },
        [PLANK]: { itemHrid: PLANK, name: 'Plank', itemLevel: 1 },
        [BOW]: { itemHrid: BOW, name: 'Bow', itemLevel: 1 },
    };
    game.actionDetails = {
        [FORAGE_STAR_FRUIT]: {
            hrid: FORAGE_STAR_FRUIT,
            name: 'Star Fruit',
            type: '/action_types/foraging',
            coinCost: 0,
            dropTable: [{ itemHrid: STAR_FRUIT, dropRate: 1, minCount: 1, maxCount: 1 }],
        },
        [DECOMPOSE]: { hrid: DECOMPOSE, name: 'Decompose', type: '/action_types/alchemy', coinCost: 0 },
        [COINIFY]: { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy', coinCost: 0 },
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
    };
    game.inventory = [];
    game.currentActions = [];
    actionTimeDisplay.initializeQueueTooltipObserver();
});

afterEach(() => {
    tooltipObserver.disable();
});

describe('a queued row is credited with what the rows before it produce', () => {
    test('the live case: an unbounded producer credits nothing, a capped decompose credits its essence', () => {
        // Decompose bills (10 + itemLevel 10) × 5 = 100 coins per action; 100 actions costs
        // 10,000, well inside the purse, so star fruit stays the binding channel.
        game.inventory = [stack(STAR_FRUIT, 100), stack(ESSENCE, 15), stack(COIN, 1_000_000)];
        game.currentActions = [
            queued(1, FORAGE_STAR_FRUIT),
            queued(2, DECOMPOSE, { primaryItemHrid: STAR_FRUIT }),
            queued(3, COINIFY, { primaryItemHrid: ESSENCE }),
        ];

        const el = queueTooltipPopper(['Star Fruit', 'Decompose: Star Fruit', 'Coinify: Foraging Essence']);
        observerState.handler(el);

        // Row 1 never terminates, so it credits none of its star fruit to row 2.
        // Row 2 performs 100 decomposes at a 0.6 success rate → 60 essence expected, on top
        // of the 15 held: 75 essence, and coinify consumes 10 at a time → 7 actions.
        expect(rowLimits(el)).toEqual(['[∞]', '[0h 16m 40s · mat: 100]', '[0h 01m 10s · mat: ~7]']);
    });

    test('a deterministic craft chain is exact and carries no estimate marker', () => {
        // 60 logs → 30 planks → 10 bows, every step deterministic
        game.inventory = [stack(LOG, 60)];
        game.currentActions = [queued(1, CRAFT_PLANK), queued(2, CRAFT_BOW)];

        const el = queueTooltipPopper(['Plank', 'Bow']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[0h 05m 00s · mat: 30]', '[0h 01m 40s · mat: 10]']);
    });

    test('a row limited purely by held stock is unmarked', () => {
        game.inventory = [stack(ESSENCE, 50)];
        game.currentActions = [queued(1, COINIFY, { primaryItemHrid: ESSENCE })];

        const el = queueTooltipPopper(['Coinify: Foraging Essence']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[50s · mat: 5]']);
    });

    test('a truly infinite producer credits nothing to a later row that consumes its output', () => {
        game.inventory = [stack(STAR_FRUIT, 0)];
        game.currentActions = [queued(1, FORAGE_STAR_FRUIT), queued(2, DECOMPOSE, { primaryItemHrid: STAR_FRUIT })];

        const el = queueTooltipPopper(['Star Fruit', 'Decompose: Star Fruit']);
        observerState.handler(el);

        expect(rowLimits(el)).toEqual(['[∞]', '[0s · mat: 0]']);
    });
});

describe('the per-action helper still prices against the whole bag', () => {
    test('calculateSingleQueueActionTime neither spends nor credits the lookup it is handed', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(LOG, 60)]);
        const action = queued(1, CRAFT_PLANK);
        const details = game.actionDetails[CRAFT_PLANK];

        const first = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup);
        const second = actionTimeDisplay.calculateSingleQueueActionTime(action, details, lookup);

        expect(first.materialLimit).toBe(30);
        expect(second.materialLimit).toBe(30);
        expect(lookup.byHrid[LOG]).toBe(60);
        expect(lookup.byHrid[PLANK]).toBeUndefined();
    });
});
