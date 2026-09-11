/** @vitest-environment happy-dom */
/**
 * Tests for the drink timer's update plumbing.
 *
 * The arithmetic lives in drink-calculator and has its own tests; what this
 * pins is how the panel reacts to inventory churn: a burst of updates is one
 * redraw, the redraw goes to the containers the DOM observer handed over (not
 * a fresh document scan), and a container that has left the page is forgotten.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const game = vi.hoisted(() => ({
    listeners: new Map(),
    currentActions: [],
    actions: {},
}));

const observer = vi.hoisted(() => ({
    /** class substring → callback, as registered by initialize() */
    handlers: new Map(),
    readyHandlers: [],
    domReady: true,
}));

const calc = vi.hoisted(() => ({
    calls: 0,
    drinks: [{ itemHrid: '/items/wisdom_tea', name: 'Wisdom Tea', totalSeconds: 10 * 3600 }],
    /** actionTypeHrid -> drinks, for tests that need the answer to depend on which type was asked about */
    drinksByType: null,
}));

const config = vi.hoisted(() => ({
    getSetting: () => false,
}));

const notify = vi.hoisted(() => ({
    calls: 0,
    lastKey: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => config.getSetting(key),
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, fn) => game.listeners.set(event, fn),
        off: (event) => game.listeners.delete(event),
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actions[hrid] ?? null,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            observer.handlers.set(className, callback);
            return () => observer.handlers.delete(className);
        },
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: (name, callback) => {
            const handler = { name, callback };
            observer.readyHandlers.push(handler);
            if (observer.domReady) callback();
            return () => {
                observer.readyHandlers = observer.readyHandlers.filter((h) => h !== handler);
            };
        },
    },
}));

vi.mock('../notifications/notification-service.js', () => ({
    default: {
        notify: (key) => {
            notify.calls++;
            notify.lastKey = key;
        },
    },
}));

vi.mock('../../utils/drink-calculator.js', () => ({
    calculateDrinkRemainingSeconds: (actionTypeHrid) => {
        calc.calls++;
        return calc.drinksByType ? (calc.drinksByType[actionTypeHrid] ?? []) : calc.drinks;
    },
    calculateQueueTimeSeconds: () => 0,
}));

const { default: drinkTimer } = await import('./drink-timer.js');

const WOODCUTTING = '/action_types/woodcutting';

/**
 * A consumables container holding a slots element the fiber walk can resolve
 * to an action type: #root's fiber is made to *be* the slots element's fiber.
 * @param {string} actionTypeHrid
 * @returns {HTMLElement}
 */
function mountContainer(actionTypeHrid = WOODCUTTING) {
    const container = document.createElement('div');
    container.className = 'GatheringProductionSkillPanel_consumablesContainer__abc';
    const slots = document.createElement('div');
    slots.className = 'ActionTypeConsumableSlots_actionTypeConsumableSlots__xyz';
    container.appendChild(slots);
    document.body.appendChild(container);
    document.getElementById('root')._reactRootContainer = {
        current: { stateNode: slots, return: { memoizedProps: { actionTypeHrid } } },
    };
    return container;
}

beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
    game.listeners.clear();
    game.currentActions = [];
    game.actions = {};
    observer.handlers.clear();
    observer.readyHandlers = [];
    observer.domReady = true;
    calc.calls = 0;
    calc.drinks = [{ itemHrid: '/items/wisdom_tea', name: 'Wisdom Tea', totalSeconds: 10 * 3600 }];
    calc.drinksByType = null;
    config.getSetting = () => false;
    notify.calls = 0;
    notify.lastKey = null;
});

afterEach(() => {
    drinkTimer.cleanup();
    vi.useRealTimers();
});

describe('drink timer updates', () => {
    test('draws a container the observer hands over', () => {
        drinkTimer.initialize();
        const container = mountContainer();

        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);

        expect(container.querySelector('.mwi-drink-timer')?.textContent).toContain('Wisdom Tea: 10h');
        expect(calc.calls).toBe(1);
    });

    test('a burst of inventory updates is one redraw, after the debounce', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        calc.calls = 0;

        const onItems = game.listeners.get('items_updated');
        onItems();
        onItems();
        game.listeners.get('consumables_updated')();
        expect(calc.calls).toBe(0); // nothing yet — the burst is still arriving

        vi.advanceTimersByTime(299);
        expect(calc.calls).toBe(0);
        vi.advanceTimersByTime(1);
        expect(calc.calls).toBe(1);
        expect(container.querySelectorAll('.mwi-drink-timer')).toHaveLength(1);
    });

    test('a container that has left the document is dropped, not redrawn', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        calc.calls = 0;

        container.remove();
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);

        expect(calc.calls).toBe(0);
        // And it stays forgotten: a later update does not revisit it either
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(calc.calls).toBe(0);
    });

    test('containers already on screen at start-up are picked up once', () => {
        const container = mountContainer();

        drinkTimer.initialize();

        expect(container.querySelector('.mwi-drink-timer')).not.toBeNull();
        expect(calc.calls).toBe(1);
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(calc.calls).toBe(2);
    });

    test('a container mounted before the shared observer is ready is picked up at readiness', () => {
        observer.domReady = false;
        const container = mountContainer();

        drinkTimer.initialize();
        expect(container.querySelector('.mwi-drink-timer')).toBeNull();

        observer.readyHandlers.forEach((h) => h.callback());
        expect(container.querySelector('.mwi-drink-timer')).not.toBeNull();
    });

    test('a character switch re-arms the low-supply alert for the new character', () => {
        // notifications_consumableLow needs to read true for this scenario, unlike
        // every other test in this file
        config.getSetting = (key) => key === 'notifications_consumableLow';

        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);

        // Main character's woodcutting tea is critically low — fires once and disarms
        calc.drinks = [{ itemHrid: '/items/wisdom_tea', name: 'Wisdom Tea', totalSeconds: 60 }];
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(notify.calls).toBe(1);

        // Same reading again (still low) — already disarmed, no repeat
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(notify.calls).toBe(1);

        // Switch to an ironcow whose woodcutting tea is *also* already critically
        // low on its very first reading. Without a re-arm this stays silent because
        // "woodcutting" was disarmed by the previous character.
        game.listeners.get('character_initialized')({ _isCharacterSwitch: true });
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);
        expect(notify.calls).toBe(2);
    });

    test('the currently-running action is picked by ordinal, not array position', () => {
        // notifications_consumableLow needs to read true for this scenario, like the character-switch test
        config.getSetting = (key) => key === 'notifications_consumableLow';

        // Woodcutting was requeued to the *front* of the array (array position 0)
        // but carries a HIGHER ordinal than cooking, which is the one actually
        // running (lowest ordinal = execution order). Reading the queue by array
        // position would evaluate woodcutting's drinks instead of the skill
        // actually being performed.
        game.currentActions = [
            { actionHrid: '/actions/woodcutting/oak_log', ordinal: 5, isDone: false },
            { actionHrid: '/actions/cooking/cook_shrimp', ordinal: 2, isDone: false },
        ];
        game.actions = {
            '/actions/woodcutting/oak_log': { type: '/action_types/woodcutting' },
            '/actions/cooking/cook_shrimp': { type: '/action_types/cooking' },
        };
        calc.drinksByType = {
            '/action_types/woodcutting': [{ name: 'Wisdom Tea', totalSeconds: 60 }],
            '/action_types/cooking': [{ name: 'Gathering Tea', totalSeconds: 60 }],
        };

        drinkTimer.initialize();
        game.listeners.get('items_updated')();
        vi.advanceTimersByTime(300);

        // The notification must be keyed and worded for cooking (the running
        // action, lowest ordinal), never for woodcutting (queued, array[0]).
        expect(notify.lastKey).toBe('consumable-low:/action_types/cooking');
    });

    test('cleanup cancels a pending redraw and removes the rows', () => {
        drinkTimer.initialize();
        const container = mountContainer();
        observer.handlers.get('GatheringProductionSkillPanel_consumablesContainer')(container);
        game.listeners.get('items_updated')();
        calc.calls = 0;

        drinkTimer.cleanup();
        vi.advanceTimersByTime(1000);

        expect(calc.calls).toBe(0);
        expect(container.querySelector('.mwi-drink-timer')).toBeNull();
        expect(game.listeners.size).toBe(0);
    });
});
