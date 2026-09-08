/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { craftingPlan_guidedWalk: true },
    inventory: new Map(),
    wsHandlers: new Map(),
    dmHandlers: new Map(),
    navigatedActions: [],
    navigatedMarket: [],
    filled: [],
    panelActionHrid: null,
    navigateSucceeds: true,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key] },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => mocks.wsHandlers.set(type, handler),
        off: (type) => mocks.wsHandlers.delete(type),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => mocks.dmHandlers.set(event, handler),
        off: (event) => mocks.dmHandlers.delete(event),
    },
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    getInventoryCount: (itemHrid) => mocks.inventory.get(itemHrid) || 0,
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: (actionHrid) => {
        mocks.navigatedActions.push(actionHrid);
        return mocks.navigateSucceeds;
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid) => mocks.navigatedMarket.push(itemHrid),
}));

vi.mock('../../utils/react-input.js', () => ({
    setReactInputValue: (input, value) => mocks.filled.push({ input, value }),
}));

vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: (panel) => panel.querySelector('input'),
    resolveDetailPanel: () => ({ actionHrid: mocks.panelActionHrid }),
}));

const { default: craftingPlanWalk, buildWalkSteps, WALK_KEY_ATTRIBUTE } = await import('./crafting-plan-walk.js');

/** A craft node, sized for the whole run. */
function craft(itemHrid, itemName, quantity, actionHrid, actionsNeeded, children = []) {
    return { itemHrid, itemName, quantity, strategy: 'craft', actionHrid, actionsNeeded, children };
}

/** A buy leaf. */
function buy(itemHrid, itemName, quantity) {
    return { itemHrid, itemName, quantity, strategy: 'buy', actionHrid: null, actionsNeeded: 0, children: [] };
}

/** Boots ← leather ← hide, with a thread bought outright. */
function bootsPlan() {
    return craft('/items/boots', 'Boots', 10, '/actions/crafting/boots', 10, [
        craft('/items/leather', 'Rough Leather', 40, '/actions/tailoring/leather', 40, [
            buy('/items/hide', 'Hide', 120),
        ]),
        buy('/items/thread', 'Thread', 20),
    ]);
}

/** Put a detail panel with a count box on the page. */
function mountPanel(actionHrid) {
    mocks.panelActionHrid = actionHrid;
    document.body.innerHTML = '<div class="SkillActionDetail_skillActionDetail__abc"><input value="1" /></div>';
    return document.querySelector('input');
}

function strip() {
    return document.getElementById('mwi-crafting-walk-strip');
}

function stripText() {
    return strip()?.querySelector('[data-role="label"]')?.textContent || '';
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.settings = { craftingPlan_guidedWalk: true };
    mocks.inventory = new Map();
    mocks.wsHandlers = new Map();
    mocks.dmHandlers = new Map();
    mocks.navigatedActions = [];
    mocks.navigatedMarket = [];
    mocks.filled = [];
    mocks.panelActionHrid = null;
    mocks.navigateSucceeds = true;
    document.body.innerHTML = '';
    craftingPlanWalk.isInitialized = false;
    craftingPlanWalk.unregisterHandlers = [];
    craftingPlanWalk.initialize();
});

afterEach(() => {
    craftingPlanWalk.disable();
    vi.useRealTimers();
});

describe('buildWalkSteps', () => {
    test('emits steps leaves first, with the root last', () => {
        const steps = buildWalkSteps(bootsPlan());

        expect(steps.map((step) => step.key)).toEqual([
            'buy:/items/hide',
            'craft:/actions/tailoring/leather',
            'buy:/items/thread',
            'craft:/actions/crafting/boots',
        ]);
        expect(steps[1]).toMatchObject({ kind: 'craft', itemName: 'Rough Leather', count: 40, actions: 40 });
        expect(steps[0]).toMatchObject({ kind: 'buy', itemName: 'Hide', count: 120 });
    });

    test('an item reached down two branches is one step, summed, at its deepest position', () => {
        const plan = craft('/items/tool', 'Tool', 1, '/actions/crafting/tool', 1, [
            craft('/items/part', 'Part', 2, '/actions/crafting/part', 2, [buy('/items/ore', 'Ore', 4)]),
            buy('/items/ore', 'Ore', 3),
        ]);

        const steps = buildWalkSteps(plan);
        expect(steps.map((step) => step.key)).toEqual([
            'buy:/items/ore',
            'craft:/actions/crafting/part',
            'craft:/actions/crafting/tool',
        ]);
        expect(steps[0].count).toBe(7);
    });

    test('coins and empty legs are not steps', () => {
        const plan = craft('/items/thing', 'Thing', 1, '/actions/crafting/thing', 1, [
            buy('/items/coin', 'Coin', 5000),
            buy('/items/dust', 'Dust', 0),
        ]);

        expect(buildWalkSteps(plan).map((step) => step.key)).toEqual(['craft:/actions/crafting/thing']);
    });
});

describe('walking a plan', () => {
    test('a step navigates and pre-fills but presses nothing', () => {
        const input = mountPanel('/items/hide-market');
        craftingPlanWalk.start([
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 4,
                actions: 4,
            },
        ]);

        mocks.panelActionHrid = '/a';
        vi.advanceTimersByTime(200);

        expect(mocks.navigatedActions).toEqual(['/a']);
        expect(mocks.filled).toEqual([{ input, value: 4 }]);
        // Nothing on the page was clicked: the walk owns only its own strip
        expect(stripText()).toBe('Step 1 of 1: craft 4 X');
    });

    test('the seam hook runs once per step, before that step navigates', () => {
        const seen = [];
        craftingPlanWalk.onStepAboutToRun = (step) =>
            seen.push({ step: step.key, navigated: [...mocks.navigatedActions] });

        const steps = buildWalkSteps(bootsPlan());
        craftingPlanWalk.start(steps);
        // Hide is a buy step; satisfy it so the walk moves to the first craft
        mocks.inventory.set('/items/hide', 120);
        mocks.dmHandlers.get('items_updated')();

        expect(seen.map((entry) => entry.step)).toEqual(['buy:/items/hide', 'craft:/actions/tailoring/leather']);
        // The hook for the craft step ran before its navigation
        expect(seen[1].navigated).toEqual([]);
        expect(mocks.navigatedActions).toEqual(['/actions/tailoring/leather']);
        craftingPlanWalk.onStepAboutToRun = null;
    });

    test('actions_updated naming the step advances it; an unrelated one does not', () => {
        craftingPlanWalk.start([
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 1,
                actions: 1,
            },
            {
                key: 'craft:/b',
                kind: 'craft',
                itemHrid: '/items/y',
                itemName: 'Y',
                actionHrid: '/b',
                count: 2,
                actions: 2,
            },
        ]);
        const onActions = mocks.wsHandlers.get('actions_updated');

        onActions({ endCharacterActions: [{ actionHrid: '/actions/somewhere/else' }] });
        expect(stripText()).toContain('Step 1 of 2');

        onActions({ endCharacterActions: [{ actionHrid: '/a' }] });
        expect(stripText()).toBe('Step 2 of 2: craft 2 Y');
        expect(mocks.navigatedActions).toEqual(['/a', '/b']);
    });

    test('a buy step opens the marketplace and advances once the item is held', () => {
        mocks.inventory.set('/items/hide', 5);
        craftingPlanWalk.start([
            {
                key: 'buy:/items/hide',
                kind: 'buy',
                itemHrid: '/items/hide',
                itemName: 'Hide',
                actionHrid: null,
                count: 10,
                actions: 0,
            },
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 1,
                actions: 1,
            },
        ]);

        expect(mocks.navigatedMarket).toEqual(['/items/hide']);
        const onItems = mocks.dmHandlers.get('items_updated');

        // A partial fill is not the step
        mocks.inventory.set('/items/hide', 12);
        onItems();
        expect(stripText()).toContain('Step 1 of 2');

        mocks.inventory.set('/items/hide', 15);
        onItems();
        expect(stripText()).toBe('Step 2 of 2: craft 1 X');
    });

    test('Skip advances without acting on the step', () => {
        craftingPlanWalk.start([
            {
                key: 'buy:/items/hide',
                kind: 'buy',
                itemHrid: '/items/hide',
                itemName: 'Hide',
                actionHrid: null,
                count: 10,
                actions: 0,
            },
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 1,
                actions: 1,
            },
        ]);

        strip().querySelector('[data-role="skip"]').click();

        expect(stripText()).toBe('Step 2 of 2: craft 1 X');
        // Nothing was bought and no count was typed for the skipped step
        expect(mocks.inventory.get('/items/hide')).toBeUndefined();
        expect(mocks.filled).toEqual([]);
    });

    test('Stop ends the walk and clears the strip', () => {
        craftingPlanWalk.start(buildWalkSteps(bootsPlan()));
        expect(strip()).not.toBeNull();

        strip().querySelector('[data-role="stop"]').click();

        expect(strip()).toBeNull();
        expect(craftingPlanWalk.currentStep()).toBeNull();
        // A message that arrives after the walk has stopped moves nothing
        mocks.wsHandlers.get('actions_updated')({
            endCharacterActions: [{ actionHrid: '/actions/tailoring/leather' }],
        });
        expect(strip()).toBeNull();
    });

    test('a character switch mid-walk ends it', () => {
        craftingPlanWalk.start(buildWalkSteps(bootsPlan()));
        expect(craftingPlanWalk.currentStep()).not.toBeNull();

        mocks.dmHandlers.get('character_switching')();

        expect(craftingPlanWalk.currentStep()).toBeNull();
        expect(stripText()).toContain('Character switched');
    });

    test('the current step is marked in the plan tree it was drawn from', () => {
        document.body.innerHTML = `<div ${WALK_KEY_ATTRIBUTE}="craft:/a"></div><div ${WALK_KEY_ATTRIBUTE}="craft:/b"></div>`;
        craftingPlanWalk.start([
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 1,
                actions: 1,
            },
            {
                key: 'craft:/b',
                kind: 'craft',
                itemHrid: '/items/y',
                itemName: 'Y',
                actionHrid: '/b',
                count: 1,
                actions: 1,
            },
        ]);

        expect(document.querySelectorAll('.mwi-crafting-walk-current')).toHaveLength(1);
        expect(document.querySelector('.mwi-crafting-walk-current').getAttribute(WALK_KEY_ATTRIBUTE)).toBe('craft:/a');

        mocks.wsHandlers.get('actions_updated')({ endCharacterActions: [{ actionHrid: '/a' }] });

        expect(document.querySelector('.mwi-crafting-walk-current').getAttribute(WALK_KEY_ATTRIBUTE)).toBe('craft:/b');
    });

    test('a count is never typed into a panel showing somebody else’s action', () => {
        mountPanel('/actions/somewhere/else');
        craftingPlanWalk.start([
            {
                key: 'craft:/a',
                kind: 'craft',
                itemHrid: '/items/x',
                itemName: 'X',
                actionHrid: '/a',
                count: 4,
                actions: 4,
            },
        ]);

        vi.advanceTimersByTime(3000);

        expect(mocks.filled).toEqual([]);
    });
});
