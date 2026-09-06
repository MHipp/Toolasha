/**
 * Decompose History Tracker
 * Records decompose sessions via WebSocket and persists to IndexedDB.
 *
 * Session lifecycle:
 * - Start: actions_updated with actionHrid === '/actions/alchemy/decompose'
 * - Result: action_completed with same actionHrid
 * - End: actions_updated with no decompose action, or different input item/enhancement level
 *
 * Result detection:
 * - `endCharacterItems` rows carry a stack's NEW absolute total, one row per
 *   changed stack — not one row per success. A message can cover a batch of
 *   efficiency procs, so the count delta on each decompose-output stack — not
 *   the number of rows — is what says how many successes it holds.
 * - Every decompose success yields every entry in the input's decomposeItems
 *   together, so each output row's delta is an independent estimate of the
 *   same success count; the largest of them is used rather than the sum,
 *   which would multiply-count one batch once per output item.
 * - Failure: no items from decomposeItems appear in endCharacterItems
 * - Incidental drops (essences, artisan's crates) are excluded
 *   because they are not listed in the input item's decomposeItems
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { createAlchemySessionStore, NO_CHARACTER } from './alchemy-session-store.js';
import { predictedSuccessStamp } from './alchemy-success-stamp.js';
import { createItemCountLedger } from './alchemy-item-deltas.js';

const DECOMPOSE_ACTION_HRID = '/actions/alchemy/decompose';
const CATALYST_OF_DECOMPOSITION_HRID = '/items/catalyst_of_decomposition';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';
const COIN_ITEM_HRID = '/items/coin';
const STORAGE_KEY = 'decomposeSessions';

/**
 * The sessions, one record per day rather than one array rewritten per action.
 * See `alchemy-session-store.js` for what that is worth.
 */
const sessionStore = createAlchemySessionStore(STORAGE_KEY, 'DecomposeHistoryTracker');

class DecomposeHistoryTracker {
    constructor() {
        this.isInitialized = false;
        this.characterId = null;
        this.activeSession = null; // Current in-progress session object
        // `endCharacterItems` rows carry a stack's NEW total, one row per
        // changed stack — not one row per success. A count delta is the only
        // thing in the message that scales with a batch.
        this.itemCounts = createItemCountLedger();
        this.handlers = {
            actionsUpdated: (data) => this.handleActionsUpdated(data),
            actionCompleted: (data) => this.handleActionCompleted(data),
            initCharacterData: () => this.handleReconnect(),
            characterSwitched: (data) => this.handleCharacterSwitched(data),
        };
    }

    /**
     * Whose sessions these are.
     * @returns {string} The character id, or the pre-login scope
     */
    getCharacterScope() {
        return this.characterId || NO_CHARACTER;
    }

    /**
     * Initialize the tracker
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('alchemy_decomposeHistory')) {
            return;
        }

        this.isInitialized = true;
        this.characterId = dataManager.getCurrentCharacterId();

        webSocketHook.on('actions_updated', this.handlers.actionsUpdated);
        webSocketHook.on('action_completed', this.handlers.actionCompleted);
        webSocketHook.on('init_character_data', this.handlers.initCharacterData);
        dataManager.on('character_switched', this.handlers.characterSwitched);
    }

    /**
     * Disable the tracker.
     *
     * Async, and the session is awaited before anything else is torn down: an
     * unawaited `endSession()` resumed after `characterId` had been nulled and
     * `sessionStore.forget()` had run, so the record was saved under the
     * 'default' scope — over whatever was already there — while the forget
     * raced the load it was meant to cancel. `handleCharacterSwitched` has
     * always awaited it; this is the same order.
     *
     * @returns {Promise<void>}
     */
    async disable() {
        webSocketHook.off('actions_updated', this.handlers.actionsUpdated);
        webSocketHook.off('action_completed', this.handlers.actionCompleted);
        webSocketHook.off('init_character_data', this.handlers.initCharacterData);
        dataManager.off('character_switched', this.handlers.characterSwitched);

        if (this.activeSession) {
            await this.endSession();
        }

        sessionStore.forget();
        this.isInitialized = false;
        this.characterId = null;
    }

    /**
     * Handle actions_updated — detect session start or end
     * @param {Object} data - WebSocket message data
     */
    async handleActionsUpdated(data) {
        const actions = data.endCharacterActions || [];
        const decomposeAction = actions.find((a) => a.actionHrid === DECOMPOSE_ACTION_HRID);

        if (decomposeAction) {
            const inputItemHrid = this.extractItemHrid(decomposeAction.primaryItemHash);
            const enhancementLevel = this.extractEnhancementLevel(decomposeAction.primaryItemHash);

            if (!inputItemHrid) {
                return;
            }

            if (!this.activeSession) {
                // No active session — start one
                await this.startSession(inputItemHrid, enhancementLevel, Date.now());
            } else if (
                this.activeSession.inputItemHrid !== inputItemHrid ||
                this.activeSession.enhancementLevel !== enhancementLevel
            ) {
                // Different item or enhancement level — end current session and start new one
                await this.endSession();
                await this.startSession(inputItemHrid, enhancementLevel, Date.now());
            } else {
                // Same item and level, same session — the player restarted the
                // action, so nothing about the record changes except that it
                // was still running at this moment
                this.activeSession.lastActivityTime = Date.now();
            }
        } else if (this.activeSession) {
            // No decompose action in the update — end any active session
            await this.endSession();
        }
    }

    /**
     * Handle action_completed — record one attempt result
     * @param {Object} data - WebSocket message data
     */
    async handleActionCompleted(data) {
        const action = data.endCharacterAction;
        if (!action || action.actionHrid !== DECOMPOSE_ACTION_HRID) {
            return;
        }

        const inputItemHrid = this.extractItemHrid(action.primaryItemHash);
        const enhancementLevel = this.extractEnhancementLevel(action.primaryItemHash);

        if (!inputItemHrid) {
            return;
        }

        // Ensure we have an active session for this item and level
        if (
            !this.activeSession ||
            this.activeSession.inputItemHrid !== inputItemHrid ||
            this.activeSession.enhancementLevel !== enhancementLevel
        ) {
            await this.startSession(inputItemHrid, enhancementLevel, Date.now());
        }
        this.activeSession.lastActivityTime = Date.now();

        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        const bulkMultiplier = itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;

        // Build a Set of valid output HRIDs from the input item's decompose items.
        // This filters out incidental drops (essences, artisan's crates).
        const decomposeItems = itemDetails?.alchemyDetail?.decomposeItems || [];
        const validOutputHrids = new Set(decomposeItems.map((entry) => entry.itemHrid));

        // Build a map of expected count per output for value calculation
        const expectedCountMap = {};
        for (const entry of decomposeItems) {
            expectedCountMap[entry.itemHrid] = entry.count || 1;
        }

        // Every row is noted so the ledger has a baseline for next time; only
        // the drop-table rows say anything about what this action produced.
        const noted = this.itemCounts.noteEach(data.endCharacterItems || []);
        const outputRows = noted.filter(
            ({ row }) => row.itemHrid !== COIN_ITEM_HRID && validOutputHrids.has(row.itemHrid)
        );

        // Derive actual attempt count from currentCount delta (handles batched efficiency procs)
        const currentCount = action.currentCount || 0;
        let attemptCount;
        if (this.lastCurrentCount !== null && currentCount > this.lastCurrentCount) {
            attemptCount = currentCount - this.lastCurrentCount;
        } else {
            attemptCount = Math.max(outputRows.length, 1);
        }
        this.lastCurrentCount = currentCount;

        // Every decompose success yields every entry in decomposeItems
        // together, so each output row's own delta is an independent estimate
        // of the same success count — the largest is used rather than the
        // sum, which would multiply-count one batch once per output item. A
        // row with no baseline yet (the first message of a session) reads as
        // "at least one".
        let successCount = 0;
        for (const { row, delta } of outputRows) {
            const expectedCount = expectedCountMap[row.itemHrid] || 1;
            const perActionYield = bulkMultiplier * expectedCount;
            let actions;
            if (delta === null) {
                actions = 1;
            } else if (perActionYield > 0) {
                actions = Math.round(delta / perActionYield);
            } else {
                actions = 0;
            }
            successCount = Math.max(successCount, actions);
        }
        successCount = Math.min(Math.max(successCount, 0), attemptCount);

        this.activeSession.totalAttempts += attemptCount;

        if (successCount > 0) {
            this.activeSession.totalSuccesses += successCount;

            for (const entry of decomposeItems) {
                const outputItemHrid = entry.itemHrid;
                const expectedCount = entry.count || 1;

                if (!this.activeSession.results[outputItemHrid]) {
                    this.activeSession.results[outputItemHrid] = {
                        count: 0,
                        totalValue: 0,
                        priceEach: 0,
                    };
                }

                // Each success hands over bulkMultiplier × expectedCount items
                const received = successCount * bulkMultiplier * expectedCount;
                this.activeSession.results[outputItemHrid].count += received;

                // Record market price at time of result
                const price = getItemPrice(outputItemHrid, { context: 'profit', side: 'sell' }) || 0;
                this.activeSession.results[outputItemHrid].priceEach = price;
                this.activeSession.results[outputItemHrid].totalValue += price * received;
            }
        }

        // Track catalyst usage — catalysts are only consumed on success
        if (successCount > 0) {
            const secondaryHrid = this.extractItemHrid(action.secondaryItemHash);
            if (secondaryHrid === CATALYST_OF_DECOMPOSITION_HRID) {
                this.activeSession.catalystOfDecompositionUsed += successCount;
            } else if (secondaryHrid === PRIME_CATALYST_HRID) {
                this.activeSession.primeCatalystUsed += successCount;
            }
        }

        await this.saveActiveSession();
    }

    /**
     * Handle reconnect — finalize any open session
     */
    async handleReconnect() {
        if (this.activeSession) {
            await this.endSession();
        }
    }

    /**
     * Handle character switch — update character ID and clear active session
     * @param {Object} data - { newId, newName }
     */
    async handleCharacterSwitched(data) {
        if (this.activeSession) {
            await this.endSession();
        }
        sessionStore.forget();
        this.characterId = data.newId || null;
    }

    /**
     * Start a new session
     * @param {string} inputItemHrid - Input item HRID
     * @param {number} enhancementLevel - Enhancement level of input item
     * @param {number} timestamp - Start timestamp in ms
     */
    async startSession(inputItemHrid, enhancementLevel, timestamp) {
        // Recorded, not recomputed at read time: the coin fee that was actually
        // billed scales with the bulk size the item had while the session ran,
        // and a later game change to that number would otherwise silently
        // restate every past session's profit.
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        // Taken now, for the same reason the bulk multiplier is: the model that
        // predicted this run is the one it has to be judged against, and the
        // tea, catalyst and level penalty behind it will all have moved by the
        // time the record is read. Unstamped sessions are excluded, never
        // retro-stamped.
        const stamp = predictedSuccessStamp('decompose', inputItemHrid, timestamp);
        this.activeSession = {
            id: `decompose_${timestamp}`,
            startTime: timestamp,
            // The last moment this run was seen acting. A multi-day AFK grind
            // is one session, and the gold attribution spreads its net over
            // [startTime, lastActivityTime] rather than dropping the lot on the
            // day it began. Sessions recorded before this field existed have
            // none, and are read as their start instant — exactly as before.
            lastActivityTime: timestamp,
            inputItemHrid,
            enhancementLevel,
            totalAttempts: 0,
            totalSuccesses: 0,
            catalystOfDecompositionUsed: 0,
            primeCatalystUsed: 0,
            bulkMultiplier: itemDetails?.alchemyDetail?.bulkMultiplier ?? 1,
            predictedRate: stamp?.predictedRate ?? null,
            predictedAt: stamp?.predictedAt ?? null,
            predictedCatalystHrid: stamp?.predictedCatalystHrid ?? null,
            results: {},
        };
        this.lastCurrentCount = null;
        this.itemCounts.reset();
    }

    /**
     * End the active session
     */
    async endSession() {
        if (!this.activeSession) {
            return;
        }

        await this.saveActiveSession();
        this.activeSession = null;
    }

    /**
     * Save the active session to storage (upsert by id).
     * Skips persist if no attempts recorded yet (avoids empty sessions from queue changes).
     */
    async saveActiveSession() {
        if (!this.activeSession || this.activeSession.totalAttempts === 0) {
            return;
        }

        try {
            const sessions = await this.loadSessions();
            const index = sessions.findIndex((s) => s.id === this.activeSession.id);

            if (index !== -1) {
                sessions[index] = this.activeSession;
            } else {
                sessions.push(this.activeSession);
            }

            // Only the record for the day this session started is written;
            // every earlier day is settled and never touched again
            await sessionStore.save(this.getCharacterScope(), sessions);
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to save session:', error);
        }
    }

    /**
     * Load all sessions from storage
     * @returns {Promise<Array>} Array of session objects
     */
    async loadSessions() {
        try {
            return await sessionStore.load(this.getCharacterScope());
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to load sessions:', error);
            return [];
        }
    }

    /**
     * Clear all history from storage.
     * The in-progress session is only dropped once the stored ones are gone: a
     * refused clear deleted nothing, so discarding it would lose the attempts
     * recorded since it started while leaving on disk exactly the history the
     * user asked to delete.
     * @returns {Promise<boolean>} Whether the sessions are gone; false when the
     *   store could not be listed and they are therefore still on disk
     */
    async clearHistory() {
        try {
            const cleared = await sessionStore.clear(this.getCharacterScope());
            if (cleared) this.activeSession = null;
            return cleared;
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to clear history:', error);
            return false;
        }
    }

    /**
     * Persist a caller-supplied sessions array (used by viewer for single-row delete)
     * @param {Array} sessions - Updated sessions array to persist
     */
    async deleteSessions(sessions) {
        try {
            await sessionStore.save(this.getCharacterScope(), sessions);
        } catch (error) {
            console.error('[DecomposeHistoryTracker] Failed to save sessions after delete:', error);
        }
    }

    /**
     * Extract item HRID from a primaryItemHash string
     * Format: "characterId::/item_locations/inventory::/items/item_name::N"
     * @param {string} hash - Primary item hash
     * @returns {string|null} Item HRID or null
     */
    extractItemHrid(hash) {
        if (!hash) {
            return null;
        }

        const parts = hash.split('::');
        if (parts.length < 3) {
            return null;
        }

        const hrid = parts[2];
        return hrid.startsWith('/items/') ? hrid : null;
    }

    /**
     * Extract enhancement level from a primaryItemHash string
     * The level is the last segment after :: if it is a non-negative integer
     * @param {string} hash - Primary item hash
     * @returns {number} Enhancement level (0 if not present or not a number)
     */
    extractEnhancementLevel(hash) {
        if (!hash) {
            return 0;
        }

        const parts = hash.split('::');
        const last = parts[parts.length - 1];

        if (last && !last.startsWith('/')) {
            const parsed = parseInt(last, 10);
            if (!isNaN(parsed) && parsed >= 0) {
                return parsed;
            }
        }

        return 0;
    }

    /**
     * Get the item name from HRID via dataManager
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item display name
     */
    getItemName(itemHrid) {
        const details = dataManager.getItemDetails(itemHrid);
        return details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }
}

const decomposeHistoryTracker = new DecomposeHistoryTracker();

export { decomposeHistoryTracker };

export default {
    name: 'Decompose History Tracker',
    initialize: () => decomposeHistoryTracker.initialize(),
    // Awaited, so a rejection from the now-async disable is caught here rather
    // than escaping as an unhandled promise
    cleanup: async () => {
        try {
            await decomposeHistoryTracker.disable();
        } catch (error) {
            console.error('[Decompose History Tracker] Disable failed part-way:', error);
        } finally {
            decomposeHistoryTracker.isInitialized = false;
        }
    },
};
