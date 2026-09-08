/**
 * Enhancement Event Handlers
 * Automatically detects and tracks enhancement events from WebSocket messages
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import enhancementTracker from './enhancement-tracker.js';
import enhancementUI from './enhancement-ui.js';
import config from '../../core/config.js';
import marketAPI from '../../api/marketplace.js';
import { calculateSuccessXP, calculateFailureXP, calculateAdjustedAttemptCount } from './enhancement-xp.js';
import { getEnhancementMaterialPrice } from './tooltip-enhancement.js';
import { parseItemHash } from '../../utils/item-hash.js';
import { runningAction } from '../../utils/combat-actions.js';

/**
 * Setup enhancement event handlers
 */
export function setupEnhancementHandlers() {
    // Listen for action_completed (when enhancement completes)
    webSocketHook.on('action_completed', handleActionCompleted);

    // Listen for actions_updated to detect new enhancing queues (handles page-load mid-session
    // and sets pending start so the next action_completed creates a session regardless of currentCount)
    webSocketHook.on('actions_updated', handleActionsUpdated);

    // TLA-043 Layer A: handlers are registered above FIRST so a completion can never land in a
    // gap between subscribing and inspecting current state. Only now do we check DataManager's
    // already-cached current action for an Enhance queue that was already running before these
    // handlers existed (setting enabled mid-run, page reload, or character switch).
    bootstrapFromCurrentEnhancingAction();
}

/**
 * TLA-043 Layer A of the mid-run bootstrap: if Enhancing is already the running action per
 * DataManager's cached current-character actions and there is no session yet, arm the same
 * pendingSessionStart flag a live actions_updated would have set, so the next action_completed
 * creates a session regardless of currentCount. Does not backfill history from the cached action.
 * Uses runningAction() (execution order, lowest ordinal) rather than array position — a requeued
 * repeat sits first in the queue with a higher ordinal, so positional reads pick the wrong entry.
 */
function bootstrapFromCurrentEnhancingAction() {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;
    if (enhancementTracker.getCurrentSession()) return;

    const activeEnhancingAction = runningAction(
        dataManager.getCurrentActions(),
        (action) => action.actionHrid === '/actions/enhancing/enhance'
    );
    if (!activeEnhancingAction) return;

    // A completed session for this item near this level is meant to be picked back up by
    // extending it (see findExtendableSession below in handleEnhancementResult), not shadowed by
    // a brand-new one — the same failure mode enhancement-tracker.js's disable() already guards
    // against for a character switch that lands with pendingSessionStart still set. Leave that
    // case alone here too; the next action_completed still finds and extends it on its own.
    const { itemHrid, level } = parseItemHash(activeEnhancingAction.primaryItemHash);
    if (itemHrid && enhancementTracker.findExtendableSession(itemHrid, level)) return;

    enhancementTracker.setPendingStart();
}

/**
 * Handle actions_updated message (detects new enhancing queue)
 * Sets pendingSessionStart so the next action_completed creates a session regardless of currentCount.
 * @param {Object} data - WebSocket message data
 */
async function handleActionsUpdated(data) {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;

    const actions = data.endCharacterActions;
    if (!Array.isArray(actions)) return;

    const enhancingRows = actions.filter((a) => a.actionHrid === '/actions/enhancing/enhance');
    if (!enhancingRows.length) return;

    // One message can carry an ended run alongside the next queued one, so a
    // live row wins; only when EVERY enhancing row in the message has ended is
    // this a stop. isDone: true is the queue entry ENDING — cancelled,
    // finished, or starved of materials. Nothing else ever says so: without
    // this, running dry left the session "In Progress" (and on the briefing)
    // indefinitely, since only a differently-configured restart finalized it.
    const enhancingAction = enhancingRows.find((a) => a.isDone === false) || enhancingRows[0];
    if (enhancingAction.isDone === true) {
        if (enhancementTracker.getCurrentSession()) {
            await enhancementTracker.finalizeCurrentSession();
        }
        return;
    }

    enhancementTracker.setPendingStart();

    // If the target level or protection level changed, finalize the current session so the
    // next action_completed starts a fresh one instead of continuing the old one.
    const currentSession = enhancementTracker.getCurrentSession();
    if (currentSession) {
        const targetChanged = enhancingAction.enhancingMaxLevel !== currentSession.targetLevel;
        const protectionChanged =
            (enhancingAction.enhancingProtectionMinLevel || 0) !== (currentSession.protectFrom || 0);
        if (targetChanged || protectionChanged) {
            await enhancementTracker.finalizeCurrentSession();
        }
    }
}

/**
 * Handle action_completed message (detects enhancement results)
 * @param {Object} data - WebSocket message data
 */
async function handleActionCompleted(data) {
    if (!config.getSetting('enhancementTracker')) return;
    if (!enhancementTracker.isInitialized) return;

    const action = data.endCharacterAction;
    if (!action) return;

    // Check if this is an enhancement action
    // Ultimate Enhancement Tracker checks: actionHrid === "/actions/enhancing/enhance"
    if (action.actionHrid !== '/actions/enhancing/enhance') {
        return;
    }

    // Handle the enhancement
    await handleEnhancementResult(action, data);
}

/**
 * Extract protection item HRID from action data
 * @param {Object} action - Enhancement action data
 * @returns {string|null} Protection item HRID or null
 */
function getProtectionItemHrid(action) {
    // Check if protection is enabled
    if (!action.enhancingProtectionMinLevel || action.enhancingProtectionMinLevel < 2) {
        return null;
    }

    // Extract protection item from secondaryItemHash (Ultimate Tracker method)
    if (action.secondaryItemHash) {
        const parts = action.secondaryItemHash.split('::');
        if (parts.length >= 3 && parts[2].startsWith('/items/')) {
            return parts[2];
        }
    }

    // Fallback: check if there's a direct enhancingProtectionItemHrid field
    if (action.enhancingProtectionItemHrid) {
        return action.enhancingProtectionItemHrid;
    }

    return null;
}

/**
 * Get enhancement materials and costs for an item
 * Based on Ultimate Enhancement Tracker's getEnhancementMaterials function
 * @param {string} itemHrid - Item HRID
 * @returns {Array|null} Array of [hrid, count] pairs or null
 */
function getEnhancementMaterials(itemHrid) {
    try {
        const gameData = dataManager.getInitClientData();
        const itemData = gameData?.itemDetailMap?.[itemHrid];

        if (!itemData) {
            return null;
        }

        // Get the costs array
        const costs = itemData.enhancementCosts;

        if (!costs) {
            return null;
        }

        let materials = [];

        // Case 1: Array of objects (current format)
        if (Array.isArray(costs) && costs.length > 0 && typeof costs[0] === 'object') {
            materials = costs.map((cost) => [cost.itemHrid, cost.count]);
        }
        // Case 2: Already in correct format [["/items/foo", 30], ["/items/bar", 20]]
        else if (Array.isArray(costs) && costs.length > 0 && Array.isArray(costs[0])) {
            materials = costs;
        }
        // Case 3: Object format {"/items/foo": 30, "/items/bar": 20}
        else if (typeof costs === 'object' && !Array.isArray(costs)) {
            materials = Object.entries(costs);
        }

        // Filter out any invalid entries
        materials = materials.filter(
            (m) => Array.isArray(m) && m.length === 2 && typeof m[0] === 'string' && typeof m[1] === 'number'
        );

        return materials.length > 0 ? materials : null;
    } catch {
        return null;
    }
}

/**
 * Track material costs for current attempt
 * Based on Ultimate Enhancement Tracker's trackMaterialCosts function
 * @param {string} itemHrid - Item HRID
 * @returns {Promise<{materialCost: number, coinCost: number}>}
 */
async function trackMaterialCosts(itemHrid) {
    const materials = getEnhancementMaterials(itemHrid) || [];
    let materialCost = 0;
    let coinCost = 0;

    for (const [resourceHrid, count] of materials) {
        // Check if this is coins
        if (resourceHrid.includes('/items/coin')) {
            // Track coins for THIS ATTEMPT ONLY
            coinCost = count; // Coins are 1:1 value
            await enhancementTracker.trackCoinCost(count);
        } else {
            // Track material costs
            await enhancementTracker.trackMaterialCost(resourceHrid, count);
            // Add to material cost total, using the same pricing rules the tracker just used
            materialCost += getEnhancementMaterialPrice(resourceHrid, 'ask') * count;
        }
    }

    return { materialCost, coinCost };
}

/**
 * Handle enhancement result (success or failure)
 * @param {Object} action - Enhancement action data
 * @param {Object} _data - Full WebSocket message data
 */
async function handleEnhancementResult(action, _data) {
    try {
        const { itemHrid, level: newLevel } = parseItemHash(action.primaryItemHash);
        const rawCount = action.currentCount || 0;

        if (!itemHrid) {
            return;
        }

        // Check for item changes on EVERY attempt (not just rawCount === 1)
        let currentSession = enhancementTracker.getCurrentSession();
        let justCreatedNewSession = false;

        // If session exists but is for a different item, finalize and start new session
        if (currentSession && currentSession.itemHrid !== itemHrid) {
            await enhancementTracker.finalizeCurrentSession();
            currentSession = null;

            // Create new session for the new item
            const protectFrom = action.enhancingProtectionMinLevel || 0;
            const targetLevel = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);

            // Infer starting level from current level
            let startLevel = newLevel;
            if (newLevel > 0 && newLevel < Math.max(2, protectFrom)) {
                startLevel = newLevel - 1;
            }

            const sessionId = await enhancementTracker.startSession(itemHrid, startLevel, targetLevel, protectFrom);
            currentSession = enhancementTracker.getCurrentSession();
            justCreatedNewSession = true; // Flag that we just created this session

            // Switch UI to new session and update display
            enhancementUI.switchToSession(sessionId);
            enhancementUI.scheduleUpdate();
        }

        // On first attempt (rawCount === 1) OR after a clear/new-queue (pendingSessionStart),
        // start a session if none is active yet.
        const startedViaPending = enhancementTracker.pendingSessionStart && rawCount !== 1;
        const shouldStartNew =
            (rawCount === 1 || enhancementTracker.pendingSessionStart) && !justCreatedNewSession && !currentSession;

        if (shouldStartNew) {
            enhancementTracker.pendingSessionStart = false;
            // CRITICAL: On first event, primaryItemHash shows RESULT level, not starting level
            // We need to infer the starting level from the result
            const protectFrom = action.enhancingProtectionMinLevel || 0;
            let startLevel = newLevel;

            // If result > 0 and below protection threshold, must have started one level lower
            if (newLevel > 0 && newLevel < Math.max(2, protectFrom)) {
                startLevel = newLevel - 1; // Successful enhancement (e.g., 0→1)
            }
            // Otherwise, started at same level (e.g., 0→0 failure, or protected failure)

            // Always start new session when tracker is enabled
            const targetLevel = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);
            const sessionId = await enhancementTracker.startSession(itemHrid, startLevel, targetLevel, protectFrom);
            currentSession = enhancementTracker.getCurrentSession();

            // Switch UI to new session and update display
            enhancementUI.switchToSession(sessionId);
            enhancementUI.scheduleUpdate();

            if (!currentSession) {
                return;
            }

            // Session was created mid-run (not at a natural queue start) — we don't have a
            // reliable baseline level, so skip recording success/failure for this first attempt.
            // Costs are still tracked. On a normal rawCount === 1 start, we record as usual.
            if (startedViaPending) {
                justCreatedNewSession = true;
            }
        }

        // If no active session, check if we can extend a completed session
        if (!currentSession) {
            // Try to extend a completed session for the same item
            const extendableSessionId = enhancementTracker.findExtendableSession(itemHrid, newLevel);
            if (extendableSessionId) {
                const newTarget = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);
                await enhancementTracker.extendSessionTarget(extendableSessionId, newTarget);
                currentSession = enhancementTracker.getCurrentSession();

                // Switch UI to extended session and update display
                enhancementUI.switchToSession(extendableSessionId);
                enhancementUI.scheduleUpdate();
            } else {
                // Mid-run pickup: the script came up after the queue started (a
                // page load during a run), so no count-1 attempt was seen and no
                // actions_updated flagged a pending start. Start a session here —
                // the first attempt has no baseline, so it is costed, not recorded
                enhancementTracker.pendingSessionStart = false;
                const protectFrom = action.enhancingProtectionMinLevel || 0;
                // Same inference the other two "first observed attempt" branches
                // above make: primaryItemHash carries the RESULT level, and below
                // the protection threshold a non-zero result can only have come
                // from one level down. Without this, a session picked up mid-run
                // at a low level recorded a startLevel one higher than the item
                // actually started at — wrong on the session tile and wrong in
                // the predictions computed from it.
                let startLevel = newLevel;
                if (newLevel > 0 && newLevel < Math.max(2, protectFrom)) {
                    startLevel = newLevel - 1;
                }
                const targetLevel = action.enhancingMaxLevel || Math.min(newLevel + 5, 20);
                const sessionId = await enhancementTracker.startSession(itemHrid, startLevel, targetLevel, protectFrom);
                currentSession = enhancementTracker.getCurrentSession();
                enhancementUI.switchToSession(sessionId);
                enhancementUI.scheduleUpdate();
                if (!currentSession) {
                    return;
                }
                justCreatedNewSession = true;
            }
        }

        // Calculate adjusted attempt count (resume-proof)
        const adjustedCount = calculateAdjustedAttemptCount(currentSession);

        // Claim the level baseline and hand it on in one synchronous step.
        //
        // websocket.js calls handlers fire-and-forget — it never awaits the
        // promise an async handler returns — so a second action_completed runs
        // while the first is still suspended on the cost writes below. Reading
        // lastAttempt after those awaits, and writing it after them too, let a
        // slower handler stamp its own older level over a newer one: the next
        // attempt then scored 6 → 7 as a 5 → 7 Blessed double jump that never
        // happened, and mis-attributed the success to level 5's tally.
        const previousLevel = currentSession.lastAttempt?.level ?? currentSession.startLevel;
        currentSession.lastAttempt = {
            attemptNumber: adjustedCount,
            level: newLevel,
            timestamp: Date.now(),
        };

        // Track costs for EVERY attempt (including first)
        const { materialCost: _materialCost, coinCost: _coinCost } = await trackMaterialCosts(itemHrid);

        // Check protection item usage BEFORE recording attempt
        // Track protection cost if protection item exists in action data
        // Protection items are consumed when:
        // 1. Level would have decreased (Mirror of Protection prevents decrease, level stays same)
        // A session started from the attempt in hand has no baseline: the first
        // attempt cannot tell a protected failure from a success, so it is not
        // charged a protection either
        const protectionItemHrid = getProtectionItemHrid(action);
        if (protectionItemHrid && !justCreatedNewSession) {
            // Only track if we're at a level where protection might be used
            const protectFrom = currentSession.protectFrom || 0;
            const shouldTrack = previousLevel >= Math.max(2, protectFrom);

            // Protection is consumed only on failure (level stays same or would have decreased)
            // Successful enhancements do NOT consume a protection item
            if (shouldTrack && newLevel <= previousLevel) {
                // Use market price (like Ultimate Tracker) instead of vendor price
                const marketPrice = marketAPI.getPrice(protectionItemHrid, 0);
                let protectionCost = marketPrice?.ask || marketPrice?.bid || 0;

                // Fall back to vendor price if market price unavailable
                if (protectionCost === 0) {
                    const gameData = dataManager.getInitClientData();
                    const protectionItem = gameData?.itemDetailMap?.[protectionItemHrid];
                    if (!protectionItem) {
                        console.warn(
                            `[EnhancementHandlers] Protection item not found in game data: ${protectionItemHrid}`
                        );
                    }
                    protectionCost = protectionItem?.vendorSellPrice || 0;
                }

                await enhancementTracker.trackProtectionCost(protectionItemHrid, protectionCost);
            }
        }

        // Determine result type
        const wasSuccess = newLevel > previousLevel;

        // Failure detection:
        // 1. Level decreased (1→0, 5→4, etc.)
        // 2. Stayed at 0 (0→0 fail)
        // 3. Stayed at non-zero level WITH protection item (protected failure)
        const levelDecreased = newLevel < previousLevel;
        const failedAtZero = previousLevel === 0 && newLevel === 0;
        const protectedFailure = previousLevel > 0 && newLevel === previousLevel && protectionItemHrid !== null;
        const wasFailure = levelDecreased || failedAtZero || protectedFailure;

        const wasBlessed = wasSuccess && newLevel - previousLevel >= 2; // Blessed tea detection

        // Record the result and track XP
        // Skip on the first attempt of a newly created session — we don't have a reliable
        // baseline level yet, but lastAttempt is still set so the next attempt works correctly.
        if (!justCreatedNewSession) {
            if (wasSuccess) {
                const xpGain = calculateSuccessXP(previousLevel, itemHrid);
                currentSession.totalXP += xpGain;

                await enhancementTracker.recordSuccess(previousLevel, newLevel, wasBlessed);
                enhancementUI.scheduleUpdate(); // Update UI after success

                // Check if we've reached target
                if (newLevel >= currentSession.targetLevel) {
                    // Target reached - session will auto-complete on next UI update
                }
            } else if (wasFailure) {
                const xpGain = calculateFailureXP(previousLevel, itemHrid);
                currentSession.totalXP += xpGain;

                await enhancementTracker.recordFailure(previousLevel, newLevel);
                enhancementUI.scheduleUpdate(); // Update UI after failure
            }
        }
        // Note: If newLevel === previousLevel (and not 0->0), we track costs but don't record attempt
        // This happens with protection items that prevent level decrease
    } catch (error) {
        console.error('[EnhancementHandlers] Enhancement result handler failed:', error);
    }
}

/**
 * Cleanup event handlers
 */
export function cleanupEnhancementHandlers() {
    webSocketHook.off('action_completed', handleActionCompleted);
    webSocketHook.off('actions_updated', handleActionsUpdated);
}
