/**
 * Empty Queue Notification
 *
 * Says so when the logged-in character stops having anything to do.
 *
 * The deciding and the telling used to be one thing here: this file requested
 * notification permission, built a `Notification`, and gave up entirely when
 * permission was refused. All three of those are now the notification service's
 * problem, and what is left is the only part that is about queues — the
 * transition from having actions to having none.
 *
 * Two behaviours changed in the move, both for the better. Permission is no
 * longer requested at initialize: it is asked for when the player ticks a
 * notification setting, which is a gesture that means yes. And a refused
 * permission no longer means silence — a visible tab gets a toast and a hidden
 * one gets a marked tab title.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';

/** One key for the whole feature, so the service's cooldown applies to it */
const EVENT_KEY = 'empty-queue';

class EmptyQueueNotification {
    constructor() {
        this.wasEmpty = false;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Initialize empty queue notification
     */
    async initialize() {
        if (!config.getSetting('notifiEmptyAction')) {
            return;
        }

        this.registerWebSocketListeners();

        this.characterSwitchingHandler = () => {
            this.disable();
        };

        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Register WebSocket message listeners
     */
    registerWebSocketListeners() {
        const actionsHandler = (data) => {
            this.checkActionQueue(data);
        };

        webSocketHook.on('actions_updated', actionsHandler);

        this.unregisterHandlers.push(() => {
            webSocketHook.off('actions_updated', actionsHandler);
        });
    }

    /**
     * Check if action queue is empty and send notification
     * @param {Object} _data - WebSocket data (unused, but kept for handler signature)
     */
    checkActionQueue(_data) {
        if (!config.getSetting('notifiEmptyAction')) {
            return;
        }

        // From dataManager rather than the payload: it is the source of truth for
        // every queued action, and the payload is only the part that changed
        const allActions = dataManager.getCurrentActions();
        const isEmpty = allActions.length === 0;

        // Only notify on transition from not-empty to empty
        if (isEmpty && !this.wasEmpty) {
            const result = notificationService.notify(EVENT_KEY, 'Your action queue is empty!');
            // Only a delivered notice counts as seen. Marking the transition
            // seen regardless — no toast host mounted yet, most likely, right
            // after a fresh load — left an empty queue that fired into no
            // channel un-retried until the queue filled and emptied again,
            // which for a queue nobody is tending is never.
            this.wasEmpty = result?.fired === true;
            return;
        }

        this.wasEmpty = isEmpty;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.wasEmpty = false;
    }
}

const emptyQueueNotification = new EmptyQueueNotification();

export default emptyQueueNotification;
