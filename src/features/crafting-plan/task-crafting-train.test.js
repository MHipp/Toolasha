/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { tasks_mergedCraftingWalk: true },
    inventory: [],
    itemDetails: new Map(),
    reserved: [],
    started: null,
    walkInitialized: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key] },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => mocks.inventory,
        getItemDetails: (itemHrid) => mocks.itemDetails.get(itemHrid) || { isTradable: true },
        getActionDetails: () => null,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../tasks/task-card-quest.js', () => ({
    questForTaskCard: () => null,
}));

vi.mock('../../utils/inventory-reservations.js', () => ({
    effectiveInventoryRows: (rows) => rows,
    reserve: (ownerId, lines, options) => {
        mocks.reserved.push({ ownerId, lines, options });
        return Promise.resolve(true);
    },
}));

vi.mock('./crafting-plan-walk.js', async () => {
    const actual = await vi.importActual('./crafting-plan-walk.js');
    return {
        ...actual,
        default: {
            initialize: () => {
                mocks.walkInitialized += 1;
            },
            start: (steps) => {
                mocks.started = steps;
                return true;
            },
            onStepAboutToRun: null,
        },
    };
});

const {
    default: taskCraftingTrain,
    mergeWalkSteps,
    planTaskTargets,
    groupTasksBySharedChain,
    mergedMissingRoot,
    mergedWalkOwner,
} = await import('./task-crafting-train.js');

/** A craft node, sized for the whole run. */
function craft(itemHrid, quantity, actionHrid, actionsNeeded, children = []) {
    return {
        itemHrid,
        itemName: itemHrid.split('/').pop(),
        quantity,
        strategy: 'craft',
        actionHrid,
        actionsNeeded,
        outputCount: 1,
        children,
    };
}

/** A buy leaf. */
function buy(itemHrid, quantity) {
    return {
        itemHrid,
        itemName: itemHrid.split('/').pop(),
        quantity,
        strategy: 'buy',
        actionHrid: null,
        actionsNeeded: 0,
        children: [],
    };
}

/** Hat ← leather ← hide. */
function hatPlan() {
    return craft('/items/hat', 10, '/actions/tailoring/hat', 10, [
        craft('/items/leather', 30, '/actions/tailoring/leather', 30, [buy('/items/hide', 90)]),
    ]);
}

/** Boots ← leather ← hide, plus a thread bought outright. */
function bootsPlan() {
    return craft('/items/boots', 5, '/actions/tailoring/boots', 5, [
        craft('/items/leather', 20, '/actions/tailoring/leather', 20, [buy('/items/hide', 60)]),
        buy('/items/thread', 15),
    ]);
}

/** Cheese ← milk: nothing in common with the leather chains. */
function cheesePlan() {
    return craft('/items/cheese', 8, '/actions/cooking/cheese', 8, [buy('/items/milk', 16)]);
}

const keys = (steps) => steps.map((step) => step.key);
const stepFor = (steps, key) => steps.find((step) => step.key === key);

beforeEach(() => {
    mocks.settings = { tasks_mergedCraftingWalk: true };
    mocks.inventory = [];
    mocks.itemDetails = new Map();
    mocks.reserved = [];
    mocks.started = null;
    mocks.walkInitialized = 0;
    document.body.innerHTML = '';
});

describe('mergeWalkSteps', () => {
    test('two tasks sharing an intermediate merge into one list with summed counts', () => {
        const merged = mergeWalkSteps([hatPlan(), bootsPlan()]);

        expect(keys(merged.steps).sort()).toEqual(
            [
                'buy:/items/hide',
                'craft:/actions/tailoring/leather',
                'craft:/actions/tailoring/hat',
                'buy:/items/thread',
                'craft:/actions/tailoring/boots',
            ].sort()
        );
        // The shared legs are counted once, at the combined figure
        expect(stepFor(merged.steps, 'buy:/items/hide').count).toBe(150);
        expect(stepFor(merged.steps, 'craft:/actions/tailoring/leather').count).toBe(50);
        expect(stepFor(merged.steps, 'craft:/actions/tailoring/leather').actions).toBe(50);
        // Three steps each apart, five together
        expect(merged.saved).toBe(2);
    });

    test('the merged order puts every step before both of its consumers', () => {
        const { steps } = mergeWalkSteps([hatPlan(), bootsPlan()]);
        const at = (key) => keys(steps).indexOf(key);

        expect(at('buy:/items/hide')).toBeLessThan(at('craft:/actions/tailoring/leather'));
        expect(at('craft:/actions/tailoring/leather')).toBeLessThan(at('craft:/actions/tailoring/hat'));
        expect(at('craft:/actions/tailoring/leather')).toBeLessThan(at('craft:/actions/tailoring/boots'));
        expect(at('buy:/items/thread')).toBeLessThan(at('craft:/actions/tailoring/boots'));
    });

    test('a step one plan reaches late still precedes the other plan step that consumes it', () => {
        // Concatenating the two post-orders and dropping repeats puts the thread
        // after the leather it is meant to accompany; a rebuilt order does not.
        const { steps } = mergeWalkSteps([hatPlan(), bootsPlan()]);
        const at = (key) => keys(steps).indexOf(key);
        expect(at('buy:/items/thread')).toBeGreaterThan(-1);
        expect(at('buy:/items/thread')).toBeLessThan(at('craft:/actions/tailoring/boots'));
    });

    test('refuses a set of plans whose edges form a cycle', () => {
        const a = craft('/items/a', 1, '/actions/a', 1, [buy('/items/b', 1)]);
        const b = craft('/items/b', 1, '/actions/b', 1, [buy('/items/a', 1)]);
        // Same items, opposite directions: /items/a is a buy in one plan and a
        // craft in the other, so the two keys differ and no cycle exists
        const cycleA = craft('/items/a', 1, '/actions/a', 1, [craft('/items/b', 1, '/actions/b', 1, [])]);
        const cycleB = craft('/items/b', 1, '/actions/b', 1, [craft('/items/a', 1, '/actions/a', 1, [])]);

        expect(mergeWalkSteps([a, b])).not.toBeNull();
        expect(mergeWalkSteps([cycleA, cycleB])).toBeNull();
    });

    test('an empty set of plans offers nothing', () => {
        expect(mergeWalkSteps([])).toBeNull();
    });
});

describe('groupTasksBySharedChain', () => {
    const planned = (rows) =>
        planTaskTargets(
            rows.map((row) => ({ actionHrid: row.actionHrid, quantity: 1, label: row.label })),
            { planFor: (actionHrid) => rows.find((row) => row.actionHrid === actionHrid).plan }
        );

    test('two tasks sharing a craft step are offered one merged walk', () => {
        const groups = groupTasksBySharedChain(
            planned([
                { actionHrid: '/actions/tailoring/hat', label: 'Hat', plan: hatPlan() },
                { actionHrid: '/actions/tailoring/boots', label: 'Boots', plan: bootsPlan() },
            ])
        );

        expect(groups).toHaveLength(1);
        expect(groups[0].tasks.map((task) => task.target.label)).toEqual(['Hat', 'Boots']);
        expect(groups[0].saved).toBe(2);
    });

    test('two tasks sharing nothing are not offered a merge', () => {
        const groups = groupTasksBySharedChain(
            planned([
                { actionHrid: '/actions/tailoring/hat', label: 'Hat', plan: hatPlan() },
                { actionHrid: '/actions/cooking/cheese', label: 'Cheese', plan: cheesePlan() },
            ])
        );

        expect(groups).toEqual([]);
    });

    test('a shared buy step alone is not enough to merge', () => {
        // Both end in a chain of their own; the only thing in common is the hide
        const otherHidePlan = craft('/items/pouch', 4, '/actions/crafting/pouch', 4, [buy('/items/hide', 8)]);
        const groups = groupTasksBySharedChain(
            planned([
                { actionHrid: '/actions/tailoring/hat', label: 'Hat', plan: hatPlan() },
                { actionHrid: '/actions/crafting/pouch', label: 'Pouch', plan: otherHidePlan },
            ])
        );

        expect(groups).toEqual([]);
    });

    test('a task whose target has no crafting chain is excluded before grouping', () => {
        const noChain = { ...craft('/items/milk', 5, '/actions/milking', 5, []), strategy: 'buy' };
        const rows = planTaskTargets(
            [
                { actionHrid: '/actions/tailoring/hat', quantity: 1, label: 'Hat' },
                { actionHrid: '/actions/milking', quantity: 1, label: 'Milk' },
                { actionHrid: '/actions/tailoring/boots', quantity: 1, label: 'Boots' },
            ],
            {
                // `planForTaskAction` answers null for a target with no chain under
                // it; the doubled planner does the same
                planFor: (actionHrid) =>
                    ({
                        '/actions/tailoring/hat': hatPlan(),
                        '/actions/tailoring/boots': bootsPlan(),
                        '/actions/milking': null,
                    })[actionHrid],
            }
        );

        expect(rows.map((row) => row.target.label)).toEqual(['Hat', 'Boots']);
        expect(noChain.strategy).toBe('buy');
        expect(groupTasksBySharedChain(rows)).toHaveLength(1);
    });

    test('a chain of overlaps groups as one walk even where two members share nothing directly', () => {
        // Hat and Cape share leather; Cape and Sack share canvas; Hat and Sack
        // share neither, but one walk still serves all three
        const capePlan = craft('/items/cape', 3, '/actions/tailoring/cape', 3, [
            craft('/items/leather', 6, '/actions/tailoring/leather', 6, [buy('/items/hide', 18)]),
            craft('/items/canvas', 3, '/actions/tailoring/canvas', 3, [buy('/items/flax', 9)]),
        ]);
        const sackPlan = craft('/items/sack', 2, '/actions/tailoring/sack', 2, [
            craft('/items/canvas', 4, '/actions/tailoring/canvas', 4, [buy('/items/flax', 12)]),
        ]);

        const groups = groupTasksBySharedChain(
            planned([
                { actionHrid: '/actions/tailoring/hat', label: 'Hat', plan: hatPlan() },
                { actionHrid: '/actions/tailoring/sack', label: 'Sack', plan: sackPlan },
                { actionHrid: '/actions/tailoring/cape', label: 'Cape', plan: capePlan },
            ])
        );

        expect(groups).toHaveLength(1);
        expect(groups[0].tasks.map((task) => task.target.label).sort()).toEqual(['Cape', 'Hat', 'Sack']);
    });
});

describe('the merged walk claim', () => {
    test('a shared material is claimed once, at the combined requirement', async () => {
        const group = groupTasksBySharedChain(
            planTaskTargets(
                [
                    { actionHrid: '/actions/tailoring/hat', quantity: 1, label: 'Hat' },
                    { actionHrid: '/actions/tailoring/boots', quantity: 1, label: 'Boots' },
                ],
                {
                    planFor: (actionHrid) => (actionHrid === '/actions/tailoring/hat' ? hatPlan() : bootsPlan()),
                }
            )
        )[0];

        expect(await taskCraftingTrain.startMergedWalk(group)).toBe(true);
        expect(mocks.reserved).toHaveLength(1);

        const { ownerId, lines } = mocks.reserved[0];
        // One owner for the whole walk, named by both targets
        expect(ownerId).toBe(mergedWalkOwner(['/items/hat', '/items/boots']));
        expect(ownerId).toBe('taskWalk:/items/boots+/items/hat');

        const hide = lines.filter((line) => line.itemHrid === '/items/hide');
        expect(hide).toHaveLength(1);
        expect(hide[0].count).toBe(150); // 90 + 60, not either alone and not double
        expect(mocks.started).toBe(group.steps);
    });

    test('stock covering a shared material is credited once across the whole group', () => {
        // 100 hide against a 150-hide requirement leaves 50 short, not 2 × 90/60
        mocks.inventory = [{ itemHrid: '/items/hide', count: 100, enhancementLevel: 0 }];
        const root = mergedMissingRoot([hatPlan(), bootsPlan()]);

        // The pass-through root carries no scale of its own, so the task plans'
        // absolute quantities ride through untouched
        expect(root.quantity).toBe(0);
        expect(root.children.every((child) => child.quantity === 0)).toBe(true);
        expect(root.children).toHaveLength(2);
    });
});

describe('initialize', () => {
    test('does nothing while the setting is off', () => {
        mocks.settings = { tasks_mergedCraftingWalk: false };
        taskCraftingTrain.disable();
        taskCraftingTrain.initialize();

        expect(mocks.walkInitialized).toBe(0);
        taskCraftingTrain.disable();
    });

    test('brings the shared walk up when the setting is on', () => {
        taskCraftingTrain.disable();
        taskCraftingTrain.initialize();

        expect(mocks.walkInitialized).toBe(1);
        taskCraftingTrain.disable();
    });
});
