/**
 * Character Activity Projection Engine
 *
 * Projects the active character's current action + queue forward in time to find the earliest
 * trustworthy point at which useful progress stops: the action ends, the queue ends, materials
 * run out, or — resolved separately at display time — the character's offline-progress cap.
 *
 * Deliberately reuses Action Time Display's existing per-action duration/material-limit maths
 * rather than building a second duration engine. This module's only job is to walk the queue
 * sequentially and decide where the trustworthy chain has to stop.
 *
 * Only `computeLiveProjection` lives here, because only it needs the live game data and the
 * action-time engine. Everything the character-select screen does with the result is in
 * `character-activity-display.js`, which is pure and reachable without dragging the action-time
 * engine along with it.
 */

import dataManager from '../../core/data-manager.js';
import actionTimeDisplay from '../actions/action-time-display.js';

const UNCERTAIN_ACTION_TYPES = new Set(['/action_types/labyrinth', '/action_types/enhancing']);

/**
 * An action this feature will never assert a trustworthy deadline for. Combat and Labyrinth have
 * non-deterministic duration, and Enhancing has a stochastic outcome. Action Time Display shows
 * an expected-value estimate for Enhancing; this feature is intentionally stricter — a false
 * early warning is preferable to telling the player an alt is safe when it might not be.
 * @param {Object} actionObj - Entry from `dataManager.getCurrentActions()`
 * @param {Object} actionDetails - `dataManager.getActionDetails(actionObj.actionHrid)`
 * @returns {boolean}
 */
function isUncertainAction(actionObj, actionDetails) {
    if (actionObj.actionHrid?.includes('/combat/')) return true;
    return UNCERTAIN_ACTION_TYPES.has(actionDetails?.type);
}

/**
 * Build one queue segment for the persisted record.
 *
 * Kept deliberately small — this is written to IndexedDB once per queue change per character,
 * and read back on every character-select render, so it carries only what the two lines of the
 * status block actually show.
 * @param {Object} parts
 * @returns {Object}
 */
function buildSegment({ actionObj, actionDetails, queuedIndex, startAt, endAt, certainty, stopCause }) {
    return {
        actionHrid: actionObj.actionHrid,
        actionName: actionDetails?.name || actionObj.actionHrid,
        actionTypeHrid: actionDetails?.type || null,
        startAt,
        endAt,
        queuedIndex,
        certainty,
        stopCause,
    };
}

/**
 * Project the character's current action + queue forward from `now`, using only the live action
 * queue. Does not consider the offline-progress cap — that is resolved later against a fresh
 * observation of when the character actually went offline, because while this runs the character
 * is still connected and has not gone offline at all.
 * @param {number} [now] - Epoch ms to project from (defaults to `Date.now()`)
 * @returns {{segments: Array, terminalCause: string, terminalAt: number|null, certainty: string}}
 *      terminalCause is one of: 'idle' | 'action' | 'queue' | 'materials' | 'infinite' | 'unknown'
 */
export function computeLiveProjection(now = Date.now()) {
    // Execution order is ascending ordinal; the array is insertion order, so a
    // repeating action requeued to the front would otherwise head the projection
    const actions = (dataManager.getCurrentActions() || [])
        .filter((action) => action && !action.isDone)
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

    if (actions.length === 0) {
        return { segments: [], terminalCause: 'idle', terminalAt: now, certainty: 'trustworthy' };
    }

    const inventoryLookup = actionTimeDisplay.buildInventoryLookup(dataManager.getInventory());

    const segments = [];
    let currentTime = now;
    let terminalCause = null;
    let terminalAt = null;
    let certainty = 'trustworthy';

    for (let i = 0; i < actions.length; i++) {
        const actionObj = actions[i];
        const actionDetails = dataManager.getActionDetails(actionObj.actionHrid);

        if (!actionDetails || isUncertainAction(actionObj, actionDetails)) {
            segments.push(
                buildSegment({
                    actionObj,
                    actionDetails,
                    queuedIndex: i,
                    startAt: currentTime,
                    endAt: null,
                    certainty: 'uncertain',
                    stopCause: 'unknown',
                })
            );
            terminalCause = 'unknown';
            terminalAt = null;
            certainty = 'uncertain';
            break;
        }

        const timing = actionTimeDisplay.calculateSingleQueueActionTime(actionObj, actionDetails, inventoryLookup);

        // The walk is sequential in time, so it has to be sequential in materials too: this
        // action's inputs are gone before the next one is costed. Without the ledger every
        // queued action was priced against the full starting inventory and the projection
        // reported an idle time hours later than the truth.
        //
        // Deterministic outputs only. A crafted intermediate is as good as stock in hand, so
        // the row that consumes it is projected honestly; an expected drop or alchemy yield
        // is a projection, and this feature is deliberately stricter than the tooltip — a
        // false early warning beats telling the player an alt is safe when it might not be.
        actionTimeDisplay.deductQueueActionMaterials(inventoryLookup, actionDetails, actionObj, timing, {
            creditStochastic: false,
        });

        if (timing.isTrulyInfinite || !Number.isFinite(timing.totalTime)) {
            segments.push(
                buildSegment({
                    actionObj,
                    actionDetails,
                    queuedIndex: i,
                    startAt: currentTime,
                    endAt: null,
                    certainty: 'trustworthy',
                    stopCause: 'infinite',
                })
            );
            terminalCause = 'infinite';
            terminalAt = null;
            break;
        }

        const segmentEndAt = currentTime + timing.totalTime * 1000;
        const stopCause = timing.limitType?.startsWith('material') ? 'materials' : 'count';

        segments.push(
            buildSegment({
                actionObj,
                actionDetails,
                queuedIndex: i,
                startAt: currentTime,
                endAt: segmentEndAt,
                certainty: 'trustworthy',
                stopCause,
            })
        );

        currentTime = segmentEndAt;

        if (i === actions.length - 1) {
            terminalAt = segmentEndAt;
            terminalCause = stopCause === 'materials' ? 'materials' : segments.length === 1 ? 'action' : 'queue';
        }
    }

    return { segments, terminalCause, terminalAt, certainty };
}
