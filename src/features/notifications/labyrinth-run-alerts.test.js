/**
 * Tests for the labyrinth stopped alert.
 *
 * The alert keys on the character's *action* leaving the labyrinth, not on
 * the run's active flag: a run whose queued rooms have been walked stays
 * active while the character moves on, and that is the moment to say so.
 * The failure worth pinning is a false stop — a queue update that does not
 * move the character off the labyrinth must leave the alert where it was.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterData: null,
    characterId: 'char-1',
    actions: [],
    actionDetails: {},
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getCurrentActions: () => game.actions,
        getCurrentCharacterId: () => game.characterId,
        getActionDetails: (hrid) => game.actionDetails[hrid] || null,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return game.notifyResult;
        },
    },
}));

const { default: labyrinthRunAlerts, MASTER_SETTING, currentActivity } = await import('./labyrinth-run-alerts.js');

const LAB = { actionHrid: '/actions/labyrinth/floor', id: 1 };
const CHEESE = { actionHrid: '/actions/cheesesmithing/cheese', id: 2 };

beforeEach(() => {
    game.settings = { [MASTER_SETTING]: true };
    game.characterData = null;
    game.characterId = 'char-1';
    game.actions = [];
    game.actionDetails = {
        '/actions/labyrinth/floor': { type: '/action_types/labyrinth', name: 'Labyrinth' },
        '/actions/cheesesmithing/cheese': { type: '/action_types/cheesesmithing', name: 'Cheese' },
    };
    game.wsHandlers = {};
    game.dmHandlers = {};
    game.notified = [];
    game.notifyResult = { fired: true, channels: ['toast'] };
});

afterEach(() => {
    labyrinthRunAlerts.disable();
});

describe('what the character is doing', () => {
    test('a labyrinth action is the labyrinth, by its type', () => {
        game.actions = [LAB];
        expect(currentActivity()).toEqual({ isLab: true, name: 'Labyrinth' });
    });

    test('anything else is not, and an empty queue is nothing', () => {
        game.actions = [CHEESE];
        expect(currentActivity().isLab).toBe(false);
        game.actions = [];
        expect(currentActivity()).toEqual({ isLab: false, name: null });
    });
});

describe('the stop', () => {
    test('leaving the labyrinth for the next queued action is announced, with the floor and what is next', async () => {
        game.actions = [LAB, CHEESE];
        await labyrinthRunAlerts.initialize();
        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, currentFloor: 12 } });

        game.actions = [CHEESE];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('stopped');
        expect(game.notified[0].message).toContain('floor 12');
        expect(game.notified[0].message).toContain('Cheese');
        expect(game.notified[0].options.title).toBe('Labyrinth stopped');
    });

    test('leaving it for an empty queue says so', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.actions = [];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('queue is empty');
    });

    test('a queue update that keeps the character in the labyrinth is not a stop', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.actions = [LAB, CHEESE];
        game.wsHandlers.actions_updated({});
        game.wsHandlers.actions_updated({});

        expect(game.notified).toEqual([]);
    });

    test('a character never seen in the labyrinth is never told it stopped', async () => {
        game.actions = [CHEESE];
        await labyrinthRunAlerts.initialize();
        game.actions = [];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toEqual([]);
    });

    test('the run staying active while the character moves on is still a stop — that is the point', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, currentFloor: 3 } });
        game.actions = [CHEESE];
        game.wsHandlers.actions_updated({});
        // The server keeps saying the run is active; nothing re-fires
        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, currentFloor: 3 } });
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(1);
    });

    test('queuing the labyrinth again re-arms, from a fresh floor', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, currentFloor: 9 } });
        game.actions = [];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(1);

        game.actions = [LAB];
        game.wsHandlers.actions_updated({});
        game.actions = [];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).not.toContain('floor 9');
        expect(game.notified[1].key).not.toBe(game.notified[0].key);
    });

    test('a stop that reached no channel is retried on the next update, not lost until the lab is queued again', async () => {
        game.notifyResult = { fired: false, channels: [] };
        game.actions = [LAB, CHEESE];
        await labyrinthRunAlerts.initialize();
        game.wsHandlers.labyrinth_updated({ labyrinth: { isActive: true, currentFloor: 12 } });

        game.actions = [CHEESE];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(1);

        // Still stopped, still nothing delivered — the character has not gone
        // back into the labyrinth, so re-arming on that is not an option here;
        // the very next update on the same stop must retry it instead
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].key).toBe(game.notified[0].key);

        game.notifyResult = { fired: true, channels: ['toast'] };
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(3);

        // Delivered: further updates on the same resting state are silent again
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(3);
    });

    test('off, nothing listens', async () => {
        game.settings = { [MASTER_SETTING]: false };
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        expect(game.wsHandlers.actions_updated).toBeUndefined();
    });

    test('the first stop after a character switch is not swallowed as a duplicate', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.actions = [CHEESE];
        game.wsHandlers.actions_updated();
        const first = game.notified.at(-1).key;

        game.dmHandlers.character_switching();
        game.characterId = 'char-2';
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.actions = [CHEESE];
        game.wsHandlers.actions_updated();

        // The service's cooldown map outlives the switch, so re-using the
        // departing character's key would drop this one on the floor.
        expect(game.notified).toHaveLength(2);
        expect(game.notified.at(-1).key).not.toBe(first);
    });

    test('switching character stands everything down', async () => {
        game.actions = [LAB];
        await labyrinthRunAlerts.initialize();
        game.dmHandlers.character_switching();
        expect(game.wsHandlers.actions_updated).toBeUndefined();
        expect(labyrinthRunAlerts.doingLab).toBe(false);
    });
});

describe('the setting', () => {
    test('exists, defaults off, and says what it keys on', () => {
        const def = getSettingDefinition(MASTER_SETTING);
        expect(def).toBeTruthy();
        expect(def.default).toBe(false);
        expect(def.help).toMatch(/queue|action/i);
    });
});
