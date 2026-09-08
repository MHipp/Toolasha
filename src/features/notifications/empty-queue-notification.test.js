import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    actions: [],
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    fired: true,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
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
        notify: (key, message) => {
            game.notified.push({ key, message });
            return { fired: game.fired };
        },
    },
}));

const emptyQueueNotification = (await import('./empty-queue-notification.js')).default;

describe('empty queue notification', () => {
    beforeEach(async () => {
        game.setting = true;
        game.actions = [];
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.fired = true;
        emptyQueueNotification.disable();
        await emptyQueueNotification.initialize();
    });

    test('disabled by setting, initialize wires nothing', async () => {
        emptyQueueNotification.disable();
        game.setting = false;
        await emptyQueueNotification.initialize();

        expect(game.wsHandlers.actions_updated).toBeUndefined();
    });

    test('notifies exactly on the not-empty-to-empty transition', () => {
        game.actions = [{ actionHrid: '/actions/foraging/x' }];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(0);

        game.actions = [];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toEqual([{ key: 'empty-queue', message: 'Your action queue is empty!' }]);
    });

    test('staying empty across multiple updates only notifies once', () => {
        game.actions = [];
        game.wsHandlers.actions_updated({});
        game.wsHandlers.actions_updated({});
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(1);
    });

    test('starting already empty notifies on the very first update', () => {
        game.actions = [];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(1);
    });

    test('refilling the queue and emptying it again notifies a second time', () => {
        game.actions = [];
        game.wsHandlers.actions_updated({});
        game.actions = [{ actionHrid: '/actions/foraging/x' }];
        game.wsHandlers.actions_updated({});
        game.actions = [];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(2);
    });

    test('a notice that reached no channel is retried on the next update, not lost for the session', () => {
        game.fired = false;
        game.actions = [{ actionHrid: '/actions/foraging/x' }];
        game.wsHandlers.actions_updated({});

        game.actions = [];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(1);

        // Still empty, still nothing delivered — the transition flag must not
        // have been marked seen for a notice nobody saw
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(2);

        game.fired = true;
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(3);

        // Delivered: further updates on the same empty queue are the ordinary
        // one-notification-per-emptying case again
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(3);
    });

    test('the setting is re-checked per event, not only at initialize', () => {
        game.setting = false;
        game.actions = [];
        game.wsHandlers.actions_updated({});

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears down listeners and resets the empty-state flag', () => {
        game.actions = [];
        game.wsHandlers.actions_updated({});
        expect(game.notified).toHaveLength(1);

        game.dmHandlers.character_switching();

        expect(game.wsHandlers.actions_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});
