/**
 * Labyrinth Stopped Alerts
 *
 * Says so when the character stops doing the labyrinth — the queued rooms ran
 * out, or the run ended on a lost fight — and moves on to whatever was queued
 * behind it, or to nothing. That is the one moment a lab run has that nothing
 * in the game announces, and the moment you are least likely to be looking,
 * because a run you are watching is a run you are steering.
 *
 * ## What "stopped" means here
 *
 * The character's current action was a labyrinth action and now is not. That
 * is read off the action queue, not off the run's `isActive` flag: a run whose
 * queued path has been walked stays *active* while the character wanders off
 * to the next thing in the queue, and that is exactly the case worth a tap on
 * the shoulder — the run is still there, waiting for more rooms to be queued.
 * Walking out of the labyrinth on purpose also ends the action, but you are at
 * the screen for that, and the service keeps an alert for a tab you are
 * looking at quiet anyway.
 *
 * ## Why the text does not say *why*
 *
 * Because the server does not: there is no outcome, result or reason field on
 * a labyrinth message. The floor reached is the score of a lab run, so that is
 * what gets reported, with what the character is doing instead.
 *
 * ## Once per stop
 *
 * Keyed on the transition, not the state: a character who is not in the
 * labyrinth is the resting case and is never news. Each stop announces once;
 * queuing the labyrinth again re-arms it.
 *
 * The counter behind that key never restarts, and the key names the character
 * as well. The service's de-duplication window is ten minutes and its map is
 * shared across bundles and outlives a character switch, so a counter that went
 * back to zero on teardown handed the arriving character a key the departing
 * one had just used — and the first stop after every switch was silently
 * swallowed as a duplicate.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { labyrinthRunState } from './notification-predicates.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_labyrinthRunFinished';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'labyrinth-stopped';

/** The action type a labyrinth action carries */
const LABYRINTH_ACTION_TYPE = '/action_types/labyrinth';

/**
 * What the character is doing, as the queue has it.
 * @param {Object} [dm] - Injectable for tests
 * @returns {{isLab: boolean, name: string|null}} Whether it is the labyrinth, and a name for it
 */
export function currentActivity(dm = dataManager) {
    const current = dm.getCurrentActions?.()?.[0];
    if (!current?.actionHrid) return { isLab: false, name: null };
    const details = dm.getActionDetails?.(current.actionHrid);
    const type = details?.type || (String(current.actionHrid).includes('/labyrinth') ? LABYRINTH_ACTION_TYPE : '');
    return {
        isLab: type === LABYRINTH_ACTION_TYPE,
        name: details?.name || String(current.actionHrid).split('/').pop().replace(/_/g, ' '),
    };
}

class LabyrinthRunAlerts {
    constructor() {
        /** Whether the character was last seen doing the labyrinth */
        this.doingLab = false;
        /** The deepest floor the current run has reported, for the message */
        this.floor = 0;
        /**
         * Stops already told, keyed by a counter, so a repeat update cannot
         * repeat one. Never reset: see the module comment — a restarted counter
         * collides with keys still inside the service's cooldown.
         */
        this.stopSeq = 0;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching for the labyrinth stopping.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.seed();
        this.registerWebSocketListeners();

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Adopt what the character is already doing, silently.
     *
     * Features initialize after the character is up, so a labyrinth already
     * going when the page loaded would otherwise never be seen as going — and
     * a run never seen going can never be seen to stop.
     */
    seed() {
        try {
            this.doingLab = currentActivity().isLab;
            this.noteFloor(dataManager.characterData?.characterLabyrinth);
        } catch (error) {
            console.error('[LabyrinthRunAlerts] Reading the character’s queue failed:', error);
        }
    }

    /** Listen for the queue moving, and for the run reporting its floor */
    registerWebSocketListeners() {
        const onActions = () => {
            try {
                this.observeActions();
            } catch (error) {
                console.error('[LabyrinthRunAlerts] Handling an actions update failed:', error);
            }
        };
        const onLabyrinth = (data) => {
            try {
                this.noteFloor(data?.labyrinth);
            } catch (error) {
                console.error('[LabyrinthRunAlerts] Handling a labyrinth update failed:', error);
            }
        };

        webSocketHook.on('actions_updated', onActions);
        webSocketHook.on('labyrinth_updated', onLabyrinth);
        this.unregisterHandlers.push(() => webSocketHook.off('actions_updated', onActions));
        this.unregisterHandlers.push(() => webSocketHook.off('labyrinth_updated', onLabyrinth));
    }

    /**
     * Keep the deepest floor the run has reported, for the message.
     * @param {Object|null} labyrinth - A payload's `labyrinth`, or the character's
     */
    noteFloor(labyrinth) {
        if (labyrinthRunState(labyrinth) !== 'active') return;
        const floor = Math.max(0, Math.floor(Number(labyrinth?.currentFloor) || 0));
        this.floor = Math.max(this.floor, floor);
    }

    /**
     * Fold one look at the queue into what is known, and announce a stop.
     */
    observeActions() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const { isLab, name } = currentActivity();
        if (isLab) {
            // Back in the labyrinth: a new stop is news again, from a fresh floor
            if (!this.doingLab) this.floor = 0;
            this.doingLab = true;
            return;
        }

        if (!this.doingLab) return;

        const where = this.floor > 0 ? ` It reached floor ${this.floor}.` : '';
        const now = name ? ` The character is now on ${name}.` : ' The queue is empty.';
        const who = dataManager.getCurrentCharacterId?.() || 'unknown';
        const key = `${EVENT_KEY_PREFIX}:${who}:${this.stopSeq + 1}`;
        const result = notificationService.notify(
            key,
            `Your labyrinth run has stopped — queue more rooms if you want to keep going.${where}${now}`,
            { title: 'Labyrinth stopped' }
        );

        // The stop is marked told, and the counter advanced, only once the
        // notice actually reached the player. Clearing `doingLab` regardless —
        // no toast host mounted yet, most likely, right after a fresh load —
        // left a stop that fired into no channel silent for good: the
        // character is not back in the labyrinth to re-arm it, so the next
        // `actions_updated` would see `doingLab` already false and say nothing.
        if (result?.fired) {
            this.doingLab = false;
            this.stopSeq += 1;
            this.floor = 0;
        }
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
        this.doingLab = false;
        this.floor = 0;
    }
}

const labyrinthRunAlerts = new LabyrinthRunAlerts();

export default labyrinthRunAlerts;
