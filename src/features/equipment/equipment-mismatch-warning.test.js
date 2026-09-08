/**
 * @vitest-environment happy-dom
 *
 * Wiring, not arithmetic: which state paints the pill, which state must not,
 * and that the action being judged is the one the game is running rather than
 * the one at the front of the queue.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    actions: [],
    equipment: new Map(),
    inventory: [],
    items: {},
    labyrinth: null,
    characterId: 'char-1',
    switching: false,
    dmHandlers: {},
    observerCallback: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            game.observerCallback = callback;
            return () => {
                game.observerCallback = null;
            };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return { characterLabyrinth: game.labyrinth };
        },
        getCurrentActions: () => game.actions,
        getEquipment: () => new Map(game.equipment),
        getInventory: () => game.inventory,
        getItemDetails: (hrid) => game.items[hrid] || null,
        getCurrentCharacterId: () => game.characterId,
        getIsCharacterSwitching: () => game.switching,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));

const warning = (await import('./equipment-mismatch-warning.js')).default;

const PILL = '#toolasha-equipment-mismatch';

/** The four pieces, with the bonuses the live game data carries for them. */
const ITEM_DATA = {
    '/items/red_culinary_hat': {
        name: 'Red Culinary Hat',
        equipmentDetail: { noncombatStats: { cookingEfficiency: 0.1, brewingEfficiency: 0.1 } },
    },
    '/items/eye_watch': {
        name: 'Eye Watch',
        equipmentDetail: {
            noncombatStats: { cheesesmithingEfficiency: 0.1, craftingEfficiency: 0.1, tailoringEfficiency: 0.1 },
        },
    },
    '/items/collectors_boots': {
        name: "Collector's Boots",
        equipmentDetail: {
            noncombatStats: { milkingEfficiency: 0.1, foragingEfficiency: 0.1, woodcuttingEfficiency: 0.1 },
        },
    },
    '/items/enchanted_gloves': {
        name: 'Enchanted Gloves',
        equipmentDetail: { noncombatStats: { alchemyEfficiency: 0.1, enhancingSpeed: 0.1 } },
    },
};

/** The header shape the pill anchors against. */
function buildHeader() {
    document.body.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'Header_actionInfo_abc';
    const buffs = document.createElement('div');
    buffs.className = 'Header_communityBuffs_def';
    info.appendChild(buffs);
    document.body.appendChild(info);
}

function equip(slotHrid, itemHrid) {
    game.equipment.set(slotHrid, { itemHrid, itemLocationHrid: slotHrid, count: 1 });
}

function stock(itemHrid, count = 1) {
    game.inventory.push({ itemHrid, itemLocationHrid: '/item_locations/inventory', count });
}

function pillText() {
    return document.querySelector(PILL)?.querySelector('.toolasha-equipment-mismatch-text')?.textContent || null;
}

beforeEach(() => {
    game.setting = true;
    game.actions = [];
    game.equipment = new Map();
    game.inventory = [];
    game.items = { ...ITEM_DATA };
    game.labyrinth = null;
    game.characterId = 'char-1';
    game.switching = false;
    game.dmHandlers = {};
    game.observerCallback = null;
    buildHeader();
    warning.initialize();
});

afterEach(() => {
    warning.disable();
    vi.useRealTimers();
});

describe('the expensive direction: the piece is in the bag', () => {
    test('a production action with the piece unequipped names the piece', () => {
        game.actions = [{ actionHrid: '/actions/cooking/cheese', ordinal: 1 }];
        stock('/items/red_culinary_hat');

        warning.render();

        expect(pillText()).toBe('Red Culinary Hat not equipped');
        expect(document.querySelector(PILL).dataset.code).toBe('production-hat');
    });

    test('the same action with the piece equipped says nothing', () => {
        game.actions = [{ actionHrid: '/actions/cooking/cheese', ordinal: 1 }];
        equip('/item_locations/head', '/items/red_culinary_hat');

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });

    test('a piece the player does not own at all says nothing', () => {
        game.actions = [{ actionHrid: '/actions/milking/cow', ordinal: 1 }];

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });

    test('the gloves rule fires on enhancing, whose bonus the data records as a speed stat', () => {
        game.actions = [{ actionHrid: '/actions/enhancing', ordinal: 1 }];
        stock('/items/enchanted_gloves');

        warning.render();

        expect(pillText()).toBe('Enchanted Gloves not equipped');
    });

    test('a rule the game data does not confirm is skipped rather than guessed at', () => {
        game.actions = [{ actionHrid: '/actions/cooking/cheese', ordinal: 1 }];
        stock('/items/red_culinary_hat');
        game.items['/items/red_culinary_hat'] = { name: 'Red Culinary Hat', equipmentDetail: { noncombatStats: {} } };

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });
});

describe('skilling gear worn into a fight', () => {
    test('a production piece equipped during combat warns', () => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');

        warning.render();

        expect(document.querySelector(PILL).dataset.code).toBe('skilling-gear-in-combat');
        expect(pillText()).toContain("Collector's Boots");
    });

    test('combat with no production gear on says nothing', () => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/sighted_bamboo_boots');

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });
});

describe('suppression', () => {
    test('a labyrinth run says nothing — the run picks the loadout, not the player', () => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');
        game.labyrinth = { isActive: true };

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });

    test('a run the server says has ended is not a run', () => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');
        game.labyrinth = { isActive: false };

        warning.render();

        expect(document.querySelector(PILL)).not.toBeNull();
    });

    test('a character mid-switch is not judged', () => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');
        game.switching = true;

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });

    test('a switch inside the debounce window does not paint the departing character', () => {
        vi.useFakeTimers();
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');

        warning.schedule();
        game.characterId = 'char-2';
        vi.advanceTimersByTime(1000);

        expect(document.querySelector(PILL)).toBeNull();
    });

    test('no switch inside the window paints as usual', () => {
        vi.useFakeTimers();
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1 }];
        equip('/item_locations/feet', '/items/collectors_boots');

        warning.schedule();
        vi.advanceTimersByTime(1000);

        expect(document.querySelector(PILL)).not.toBeNull();
    });
});

describe('which action is judged', () => {
    test('the running action is the lowest ordinal, not the front of the array', () => {
        // A requeued cooking repeat sits first with the higher ordinal; the
        // combat action behind it is the one actually running.
        game.actions = [
            { actionHrid: '/actions/cooking/cheese', ordinal: 7 },
            { actionHrid: '/actions/combat/fly', ordinal: 2 },
        ];
        stock('/items/red_culinary_hat');
        equip('/item_locations/feet', '/items/collectors_boots');

        warning.render();

        // Reading actions[0] would have produced the cooking-hat warning
        expect(document.querySelector(PILL).dataset.code).toBe('skilling-gear-in-combat');
    });

    test('a finished action is not the running one', () => {
        game.actions = [
            { actionHrid: '/actions/combat/fly', ordinal: 1, isDone: true },
            { actionHrid: '/actions/cooking/cheese', ordinal: 2 },
        ];
        stock('/items/red_culinary_hat');

        warning.render();

        expect(document.querySelector(PILL).dataset.code).toBe('production-hat');
    });

    test('an empty queue says nothing', () => {
        stock('/items/red_culinary_hat');

        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });
});

describe('teardown', () => {
    test('disable removes the pill and unhooks the header', () => {
        game.actions = [{ actionHrid: '/actions/cooking/cheese', ordinal: 1 }];
        stock('/items/red_culinary_hat');
        warning.render();
        expect(document.querySelector(PILL)).not.toBeNull();

        warning.disable();

        expect(document.querySelector(PILL)).toBeNull();
        expect(document.querySelector('.toolasha-equipment-mismatch-host')).toBeNull();
        expect(Object.keys(game.dmHandlers)).toHaveLength(0);
    });

    test('a state that no longer warrants the pill takes it down again', () => {
        game.actions = [{ actionHrid: '/actions/cooking/cheese', ordinal: 1 }];
        stock('/items/red_culinary_hat');
        warning.render();
        expect(document.querySelector(PILL)).not.toBeNull();

        equip('/item_locations/head', '/items/red_culinary_hat');
        warning.render();

        expect(document.querySelector(PILL)).toBeNull();
    });
});
