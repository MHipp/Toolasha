/**
 * @vitest-environment happy-dom
 *
 * The buff board, drawn rather than reasoned about.
 *
 * The load-bearing assertion is the dull one every panel test in this repo
 * carries: the board draws and no section reports a failure. A renamed helper
 * or a property read off something that stopped having it fails that line and
 * nothing else would.
 *
 * The rest is about honesty rather than arithmetic — that a source with nothing
 * to say is left out instead of printed as zero, and that combat, whose drinks
 * are not in the per-action-type maps, says so instead of drawing an empty
 * table.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The character in front of the board, swapped between tests */
const game = vi.hoisted(() => ({
    characterData: {},
    personal: {},
    actions: [],
    details: {},
    items: {},
    drinkSlots: {},
    id: 'me-id',
    name: 'Me',
}));

/** The data manager's event bus, reduced to the two events anything here listens for */
const bus = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        get personalActionTypeBuffsMap() {
            return game.personal;
        },
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.details[hrid] || null,
        getItemDetails: (hrid) => game.items[hrid] || null,
        getActionDrinkSlots: (type) => game.drinkSlots[type] || [],
        getCurrentCharacterId: () => game.id,
        getCurrentCharacterName: () => game.name,
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((entry) => entry !== handler);
        },
        emit: (event, payload) => {
            for (const handler of [...(bus.handlers[event] || [])]) handler(payload);
        },
    },
}));

/** The socket, reduced to the two battle messages the board stores */
const socket = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            (socket.handlers[type] ||= []).push(handler);
        },
        off: (type, handler) => {
            socket.handlers[type] = (socket.handlers[type] || []).filter((entry) => entry !== handler);
        },
    },
}));

// Geometry is held in IndexedDB, which is not what this file is about
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    clampPanelToViewport: () => null,
    markPanelInteracted: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

/** The supply estimate reaches storage and the loadout store; neither is the subject here */
const supply = vi.hoisted(() => ({ drinks: [] }));

vi.mock('../../utils/drink-calculator.js', () => ({
    calculateDrinkRemainingSeconds: () => supply.drinks,
    calculateQueueTimeSeconds: () => 0,
}));

const { default: dataManager } = await import('../../core/data-manager.js');
const {
    buffBoardPanel,
    collectBuffs,
    formatBuffSize,
    buffSourceName,
    buffTypeLabel,
    isCountBuff,
    knownActionTypes,
    runningActionType,
    showActionType,
    shownActionType,
    combatDrinkBuffs,
    _resetBattleState,
} = await import('./buff-board.js');

const COOKING = '/action_types/cooking';
const COMBAT = '/action_types/combat';
const FAILED = 'could not be drawn';

const text = () => buffBoardPanel.panel.textContent;
const card = (key) => buffBoardPanel.panel.querySelector(`[data-buff-source="${key}"]`);

/** A buff in the shape the server states them in */
const buff = (uniqueHrid, typeHrid, boosts = {}) => ({
    uniqueHrid,
    typeHrid,
    ratioBoost: 0,
    ratioBoostLevelBonus: 0,
    flatBoost: 0,
    flatBoostLevelBonus: 0,
    startTime: '0001-01-01T00:00:00Z',
    duration: 0,
    ...boosts,
});

/** Put a fully buffed cook in front of the board */
function cook() {
    game.characterData = {
        consumableActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/wisdom_tea', '/buff_types/wisdom', { flatBoost: 0.144 })],
        },
        equipmentActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/equipment', '/buff_types/action_speed', { flatBoost: 2.34 })],
        },
        houseActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/house_efficiency', '/buff_types/efficiency', { flatBoost: 0.12 })],
        },
        achievementActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/achievement', '/buff_types/efficiency', { flatBoost: 0.02 })],
        },
        mooPassActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/moo_pass', '/buff_types/efficiency', { flatBoost: 0.05 })],
        },
        guildActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/guild_efficiency', '/buff_types/efficiency', { flatBoost: 0.03 })],
        },
        communityActionTypeBuffsMap: {
            [COOKING]: [
                buff('/buff_uniques/experience_community_buff', '/buff_types/wisdom', { flatBoost: 0.295 }),
                buff('/buff_uniques/production_community_buff', '/buff_types/efficiency', { flatBoost: 0.197 }),
            ],
        },
        personalActionTypeBuffsMap: {
            [COOKING]: [buff('/buff_uniques/seal', '/buff_types/efficiency', { flatBoost: 0.08 })],
        },
    };
    game.actions = [{ actionHrid: '/actions/cooking/donut', ordinal: 3, isDone: false }];
    game.details = { '/actions/cooking/donut': { type: COOKING } };
    game.items = { '/items/wisdom_tea': { name: 'Wisdom Tea', consumableDetail: { buffs: [] } } };
}

/** Send a battle message */
function fire(type, payload) {
    for (const handler of socket.handlers[type] || []) handler(payload);
}

beforeEach(() => {
    cook();
    game.personal = {};
    game.drinkSlots = {};
    supply.drinks = [];
    _resetBattleState();
    showActionType(null);
});

afterEach(() => {
    buffBoardPanel.hide();
    showActionType(null);
    _resetBattleState();
    vi.restoreAllMocks();
});

describe('the board renders at all', () => {
    test('every source that has a buff is drawn, with its size, and none of them fails', () => {
        buffBoardPanel.show();

        for (const label of [
            'Teas & coffees',
            'Equipment',
            'House',
            'Achievements',
            'MooPass',
            'Guild',
            'Community',
            'Seals',
        ]) {
            expect(text()).toContain(label);
        }
        // The sizes, as the game states them
        expect(text()).toContain('+14.4%');
        expect(text()).toContain('+234.0%');
        expect(text()).toContain('+29.5%');
        // And what granted them
        expect(text()).toContain('Wisdom Tea');
        expect(text()).not.toContain(FAILED);
    });

    test('it draws with no character data at all', () => {
        game.characterData = {};
        game.actions = [];
        buffBoardPanel.show();
        expect(text()).not.toContain(FAILED);
    });
});

describe('an empty source is left out', () => {
    test('a source with no buffs for this action type gets no card', () => {
        delete game.characterData.guildActionTypeBuffsMap;
        game.characterData.mooPassActionTypeBuffsMap = { [COOKING]: [] };
        buffBoardPanel.show();

        expect(card('guild')).toBeNull();
        expect(card('mooPass')).toBeNull();
        expect(text()).not.toContain('MooPass');
        expect(card('house')).not.toBeNull();
        expect(text()).not.toContain(FAILED);
    });

    test('collectBuffs drops them rather than reporting zero', () => {
        game.characterData.guildActionTypeBuffsMap = { [COOKING]: [] };
        expect(collectBuffs(COOKING).map((source) => source.key)).not.toContain('guild');
    });
});

describe('the action type on show', () => {
    test('it follows the running action by default', () => {
        expect(runningActionType()).toBe(COOKING);
        expect(shownActionType()).toBe(COOKING);
    });

    test('the running action is the lowest-ordinal one, not the first in the array', () => {
        // A repeating action requeued to the front carries a *higher* ordinal
        game.actions = [
            { actionHrid: '/actions/brewing/tea', ordinal: 9, isDone: false },
            { actionHrid: '/actions/cooking/donut', ordinal: 3, isDone: false },
        ];
        game.details['/actions/brewing/tea'] = { type: '/action_types/brewing' };
        expect(runningActionType()).toBe(COOKING);
    });

    test('picking another action type changes the rows', () => {
        game.characterData.houseActionTypeBuffsMap['/action_types/brewing'] = [
            buff('/buff_uniques/house_efficiency', '/buff_types/efficiency', { flatBoost: 0.3 }),
        ];
        buffBoardPanel.show();
        expect(text()).toContain('+12.0%');

        const select = buffBoardPanel.panel.querySelector('[data-buff-action-type]');
        select.value = '/action_types/brewing';
        select.dispatchEvent(new Event('change'));

        expect(shownActionType()).toBe('/action_types/brewing');
        expect(text()).toContain('+30.0%');
        expect(text()).not.toContain('+12.0%');
        // Brewing has no tea, gear, guild or community entry of its own
        expect(card('consumable')).toBeNull();
        expect(text()).not.toContain(FAILED);
    });

    test('the list of action types is derived from the maps, not typed in', () => {
        game.characterData.houseActionTypeBuffsMap['/action_types/tailoring'] = [
            buff('/buff_uniques/house_efficiency', '/buff_types/efficiency', { flatBoost: 0.3 }),
        ];
        expect(knownActionTypes()).toContain('/action_types/tailoring');
        expect(knownActionTypes()).toContain(COOKING);
    });
});

describe('combat', () => {
    beforeEach(() => {
        game.actions = [{ actionHrid: '/actions/combat/fly', ordinal: 1, isDone: false }];
        game.details['/actions/combat/fly'] = { type: COMBAT };
        game.items['/items/channeling_coffee'] = { name: 'Channeling Coffee', consumableDetail: { buffs: [] } };
        game.drinkSlots[COMBAT] = [{ itemHrid: '/items/channeling_coffee', isActive: true, duration: 0 }];
        game.characterData.houseActionTypeBuffsMap[COMBAT] = [
            buff('/buff_uniques/house_combat', '/buff_types/damage', { flatBoost: 0.1 }),
        ];
    });

    test('with no consumable map and no fight seen, it says so and names what is slotted', () => {
        buffBoardPanel.show();

        expect(card('consumable-missing')).not.toBeNull();
        expect(text()).toContain('arrive on your unit while a battle is running');
        expect(text()).toContain('Slotted: Channeling Coffee.');
        // The sources that *are* in the maps still list
        expect(card('house')).not.toBeNull();
        expect(text()).not.toContain(FAILED);
    });

    test('a fight in progress supplies the drink buffs the maps do not carry', () => {
        fire('new_battle', {
            players: {
                0: { character: { id: 'someone-else' }, combatBuffMap: {} },
                1: {
                    character: { id: 'me-id' },
                    combatBuffMap: {
                        '/buff_uniques/channeling_coffee': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 },
                        '/buff_uniques/house_combat': { typeHrid: '/buff_types/damage', flatBoost: 0.1 },
                    },
                },
            },
        });

        expect(combatDrinkBuffs()).toHaveLength(1);

        buffBoardPanel.show();
        expect(card('consumable')).not.toBeNull();
        expect(text()).toContain('Cast Speed');
        expect(text()).toContain('+12.0%');
        expect(text()).toContain('Channeling Coffee');
        expect(text()).not.toContain(FAILED);
    });

    test('a tick refreshes the drinks the fight opened with', () => {
        fire('new_battle', { players: { 0: { character: { id: 'me-id' }, combatBuffMap: {} } } });
        expect(combatDrinkBuffs()).toHaveLength(0);

        fire('battle_updated', {
            pMap: {
                0: {
                    combatBuffMap: {
                        '/buff_uniques/channeling_coffee': { typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 },
                    },
                },
            },
        });
        expect(combatDrinkBuffs()).toHaveLength(1);
    });

    test('a consumable map that does carry combat is used as it stands', () => {
        game.characterData.consumableActionTypeBuffsMap[COMBAT] = [
            buff('/buff_uniques/channeling_coffee', '/buff_types/cast_speed', { flatBoost: 0.12 }),
        ];
        buffBoardPanel.show();

        expect(card('consumable')).not.toBeNull();
        expect(card('consumable-missing')).toBeNull();
        expect(text()).not.toContain(FAILED);
    });
});

describe('the supply estimate', () => {
    test('it is drawn as an estimate and never as a countdown', () => {
        supply.drinks = [{ itemHrid: '/items/wisdom_tea', name: 'Wisdom Tea', totalSeconds: 9000 }];
        buffBoardPanel.show();

        expect(text()).toContain('Drink supply (estimate)');
        expect(text()).toContain('Not a countdown on the buff');
        expect(text()).not.toContain(FAILED);
    });

    test('no stock, no card', () => {
        supply.drinks = [];
        buffBoardPanel.show();
        expect(card('supply')).toBeNull();
    });
});

describe('sizes are printed as the game states them', () => {
    test('a boost is a percentage', () => {
        expect(formatBuffSize(buff('/buff_uniques/x', '/buff_types/wisdom', { flatBoost: 0.144 }))).toBe('+14.4%');
        expect(formatBuffSize(buff('/buff_uniques/x', '/buff_types/damage', { ratioBoost: 0.02 }))).toBe('+2.0%');
    });

    test('a level buff is a count, not a percentage', () => {
        expect(isCountBuff('/buff_types/action_level')).toBe(true);
        expect(isCountBuff('/buff_types/efficiency')).toBe(false);
        expect(formatBuffSize(buff('/buff_uniques/x', '/buff_types/action_level', { flatBoost: 5 }))).toBe('+5');
    });

    test('both boosts are shown when both are set', () => {
        expect(
            formatBuffSize(buff('/buff_uniques/x', '/buff_types/efficiency', { flatBoost: 0.1, ratioBoost: 0.2 }))
        ).toBe('+10.0% flat · +20.0% ratio');
    });

    test('a buff with no size says so rather than claiming zero', () => {
        expect(formatBuffSize(buff('/buff_uniques/x', '/buff_types/efficiency'))).toBe('—');
    });

    test('names come from the game, hrids only as a fallback', () => {
        expect(buffSourceName('/buff_uniques/wisdom_tea')).toBe('Wisdom Tea');
        expect(buffSourceName('/buff_uniques/house_efficiency')).toBe('House Efficiency');
        expect(buffTypeLabel('/buff_types/action_speed')).toBe('Action Speed');
    });
});

describe('a character switch', () => {
    test('closes the board, forgets the fight and unpins the action type', () => {
        showActionType('/action_types/brewing');
        fire('new_battle', { players: { 0: { character: { id: 'me-id' }, combatBuffMap: {} } } });
        buffBoardPanel.show();
        expect(buffBoardPanel.isOpen()).toBe(true);

        dataManager.emit('character_switching');
        dataManager.emit('character_switched');

        expect(buffBoardPanel.isOpen()).toBe(false);
        expect(combatDrinkBuffs()).toEqual([]);
        expect(shownActionType()).toBe(COOKING);
    });
});
