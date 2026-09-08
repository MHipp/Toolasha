/**
 * @vitest-environment happy-dom
 *
 * The guided walk through an Iron Bell batch.
 *
 * The load-bearing test in this file is the last one: **the walk never presses a
 * game button.** That is the project's hard rule — one user click is exactly one
 * game action — and it is asserted directly, by watching every click there is:
 * `Element.prototype.click`, and every event dispatched anywhere in the document
 * for the whole length of a walk. The walk may navigate and it may type into the
 * game's own count box; a click it may not do.
 *
 * The rest pins the thing a second walker would have got wrong: alchemy is one
 * action for every item in the game, so the two alchemy steps must wait for the
 * player to select the item before a count means anything.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    wsHandlers: new Map(),
    dmHandlers: new Map(),
    navigatedActions: [],
    currentActions: [],
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
        getCurrentActions: () => mocks.currentActions,
    },
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    getInventoryCount: () => 0,
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: (actionHrid) => {
        mocks.navigatedActions.push(actionHrid);
        return true;
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
}));

// The real react-input, deliberately: what it dispatches on the game's own count
// box is part of what the no-click test is watching.
vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: (panel) => panel.querySelector('input'),
    resolveDetailPanel: (panel) => ({ actionHrid: panel.dataset.actionHrid || null }),
}));

const { default: craftingPlanWalk } = await import('../crafting-plan/crafting-plan-walk.js');
const { buildQueueSteps, startQueueWalk, DECOMPOSE_ACTION, COINIFY_ACTION } = await import('./ironcow-queue-walk.js');

const STARFRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const FORAGE_ACTION = '/actions/foraging/star_fruit';

/** A costed loop, only the parts the walk reads */
function loop(overrides = {}) {
    return {
        missing: [],
        items: {
            starfruitHrid: STARFRUIT,
            starfruitName: 'Star Fruit',
            essenceHrid: ESSENCE,
            essenceName: 'Foraging Essence',
            forageActionHrid: FORAGE_ACTION,
        },
        ...overrides,
    };
}

/** A balanced batch, as `balanceBatch` returns one */
function batch(overrides = {}) {
    return { forageActions: 1600, decomposeActions: 1600, coinifyActions: 480, ...overrides };
}

/**
 * Put an action detail panel on the page, with a count box and, optionally, an
 * item in the alchemy requirement slot.
 * @param {string} actionHrid - What the panel is showing
 * @param {string|null} [selectedItemHrid] - What is in the slot
 */
function mountPanel(actionHrid, selectedItemHrid = null) {
    const slot = selectedItemHrid
        ? `<div class="SkillActionDetail_itemRequirements__x">
               <div class="Item_itemContainer__y"><svg><use href="#${selectedItemHrid.split('/').pop()}"></use></svg></div>
           </div>`
        : '';
    document.body.innerHTML =
        `<div class="SkillActionDetail_skillActionDetail__abc" data-action-hrid="${actionHrid}">` +
        `<input value="1" />${slot}</div>`;
    return document.querySelector('input');
}

/** The action queue answering the player's own press on one action */
function pressed(actionHrid, primaryItemHash = '') {
    mocks.wsHandlers.get('actions_updated')?.({
        endCharacterActions: [{ id: `new-${actionHrid}`, actionHrid, primaryItemHash }],
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.settings = {};
    mocks.navigatedActions = [];
    mocks.currentActions = [];
    document.body.innerHTML = '';
});

afterEach(() => {
    craftingPlanWalk.disable();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('the three steps', () => {
    test('are forage, decompose then coinify — the order the loop consumes them in', () => {
        const steps = buildQueueSteps(loop(), batch());

        expect(steps.map((step) => step.actionHrid)).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION, COINIFY_ACTION]);
        expect(steps.map((step) => step.actions)).toEqual([1600, 1600, 480]);
    });

    test('the alchemy steps name the item that has to be in the slot; foraging does not', () => {
        const [forage, decompose, coinify] = buildQueueSteps(loop(), batch());

        expect(forage.requiresItemHrid).toBeUndefined();
        expect(decompose.requiresItemHrid).toBe(STARFRUIT);
        expect(coinify.requiresItemHrid).toBe(ESSENCE);
        expect(decompose.label).toContain('alchemy slot');
    });

    test('a leg sized at nothing is not a step to stand in front of', () => {
        const steps = buildQueueSteps(loop(), batch({ coinifyActions: 0 }));
        expect(steps.map((step) => step.key)).toEqual(['ironbell:forage', 'ironbell:decompose']);
    });

    test('nothing to walk without a costed loop or a batch', () => {
        expect(buildQueueSteps(null, batch())).toEqual([]);
        expect(buildQueueSteps(loop({ missing: ['coinifying'] }), batch())).toEqual([]);
        expect(buildQueueSteps(loop(), null)).toEqual([]);
        expect(startQueueWalk(null, null)).toBe(false);
    });
});

describe('walking it', () => {
    test('opens each action in turn, and only advances on the press', () => {
        mountPanel(FORAGE_ACTION);
        expect(startQueueWalk(loop(), batch())).toBe(true);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION]);

        pressed(FORAGE_ACTION);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION]);

        // The queue answering a decompose of something else is not this step
        pressed(DECOMPOSE_ACTION, '/items/holy_milk');
        expect(mocks.navigatedActions).toHaveLength(2);

        pressed(DECOMPOSE_ACTION, `${DECOMPOSE_ACTION}::${STARFRUIT}`);
        expect(mocks.navigatedActions).toEqual([FORAGE_ACTION, DECOMPOSE_ACTION, COINIFY_ACTION]);
    });

    test('types the forage count into the game’s own count box', () => {
        const input = mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        vi.advanceTimersByTime(200);

        expect(input.value).toBe('1600');
    });

    test('types nothing into an alchemy panel until the right item is in the slot', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        pressed(FORAGE_ACTION);

        // The player is on decompose, but with the wrong item selected
        const input = mountPanel(DECOMPOSE_ACTION, '/items/holy_milk');
        vi.advanceTimersByTime(2000);
        expect(input.value).toBe('1');

        // They put the fruit in the slot
        const withFruit = mountPanel(DECOMPOSE_ACTION, STARFRUIT);
        vi.advanceTimersByTime(1000);
        expect(withFruit.value).toBe('1600');
    });

    test('ends on a character switch, like every other walk', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());
        expect(craftingPlanWalk.currentStep()).not.toBeNull();

        mocks.dmHandlers.get('character_switching')?.();
        expect(craftingPlanWalk.currentStep()).toBeNull();
    });

    test('Skip leaves a step undone and Stop ends the walk', () => {
        mountPanel(FORAGE_ACTION);
        startQueueWalk(loop(), batch());

        craftingPlanWalk.skip();
        expect(craftingPlanWalk.currentStep().actionHrid).toBe(DECOMPOSE_ACTION);

        craftingPlanWalk.stop('');
        expect(craftingPlanWalk.currentStep()).toBeNull();
    });
});

describe('the hard rule', () => {
    test('never presses a game button: no click is issued anywhere, at any step', () => {
        const clicked = [];
        const dispatched = [];
        // Found by walking up from a real element rather than off a global: the
        // one that actually owns the method is the one a patch has to sit on.
        const owner = (method) => {
            let proto = Object.getPrototypeOf(document.createElement('input'));
            while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) proto = Object.getPrototypeOf(proto);
            return proto;
        };
        const clickProto = owner('click');
        const dispatchProto = owner('dispatchEvent');
        const realClick = clickProto.click;
        const realDispatch = dispatchProto.dispatchEvent;
        clickProto.click = function patchedClick() {
            clicked.push(this);
        };
        dispatchProto.dispatchEvent = function patchedDispatch(event) {
            dispatched.push(event.type);
            return realDispatch.call(this, event);
        };

        try {
            mountPanel(FORAGE_ACTION);
            startQueueWalk(loop(), batch());
            vi.advanceTimersByTime(2000);

            pressed(FORAGE_ACTION);
            mountPanel(DECOMPOSE_ACTION, STARFRUIT);
            vi.advanceTimersByTime(2000);

            pressed(DECOMPOSE_ACTION, `${DECOMPOSE_ACTION}::${STARFRUIT}`);
            mountPanel(COINIFY_ACTION, ESSENCE);
            vi.advanceTimersByTime(2000);

            pressed(COINIFY_ACTION, `${COINIFY_ACTION}::${ESSENCE}`);
            vi.advanceTimersByTime(2000);
        } finally {
            clickProto.click = realClick;
            dispatchProto.dispatchEvent = realDispatch;
        }

        expect(clicked).toEqual([]);
        expect(dispatched).not.toContain('click');
        expect(dispatched).not.toContain('mousedown');
        expect(dispatched).not.toContain('pointerdown');
        // What it *does* dispatch is the input event that tells React a number
        // was typed into the game's own count box.
        expect(dispatched).toContain('input');
    });
});
