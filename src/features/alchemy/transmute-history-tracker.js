/**
 * Transmute History Tracker
 * Records transmute sessions via WebSocket and persists to IndexedDB.
 *
 * Session lifecycle:
 * - Start: actions_updated with actionHrid === '/actions/alchemy/transmute'
 * - Result: action_completed with same actionHrid
 * - End: actions_updated with no transmute action, or different input item
 *
 * Result detection:
 * - Success: a drop-table item's stack total went UP. One message can cover a
 *   batch of attempts and carries one row per changed stack, so the count delta
 *   — not the number of rows — is what says how many actions produced output
 * - Failure: no drop-table item gained
 * - Incidental drops (essences on non-essence transmutes, artisan's crates) are excluded
 *   because they are not listed in the input item's transmuteDropTable
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { createAlchemySessionStore, NO_CHARACTER } from './alchemy-session-store.js';
import { predictedSuccessStamp } from './alchemy-success-stamp.js';
import { createItemCountLedger } from './alchemy-item-deltas.js';

const TRANSMUTE_ACTION_HRID = '/actions/alchemy/transmute';
const COIN_ITEM_HRID = '/items/coin';
const STORAGE_KEY = 'transmuteSessions';

/**
 * The sessions, one record per day rather than one array rewritten per action.
 * See `alchemy-session-store.js` for what that is worth.
 */
const sessionStore = createAlchemySessionStore(STORAGE_KEY, 'TransmuteHistoryTracker');

class TransmuteHistoryTracker {
    constructor() {
        this.isInitialized = false;
        this.characterId = null;
        this.activeSession = null; // Current in-progress session object
        // `endCharacterItems` rows carry a stack's NEW total, one row per
        // changed stack — not one row per action. A count delta is the only
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

        if (!config.getSetting('alchemy_transmuteHistory')) {
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
        const transmuteAction = actions.find((a) => a.actionHrid === TRANSMUTE_ACTION_HRID);

        if (transmuteAction) {
            const inputItemHrid = this.extractItemHrid(transmuteAction.primaryItemHash);
            if (!inputItemHrid) {
                return;
            }

            if (!this.activeSession) {
                // No active session — start one
                await this.startSession(inputItemHrid, Date.now());
            } else if (this.activeSession.inputItemHrid !== inputItemHrid) {
                // Different item — end current session and start new one
                await this.endSession();
                await this.startSession(inputItemHrid, Date.now());
            } else {
                // Same item, same session — the player restarted the action, so
                // nothing about the record changes except that it was still
                // running at this moment
                this.activeSession.lastActivityTime = Date.now();
            }
        } else if (this.activeSession) {
            // No transmute action in the update — end any active session
            await this.endSession();
        }
    }

    /**
     * Handle action_completed — record one attempt result
     * @param {Object} data - WebSocket message data
     */
    async handleActionCompleted(data) {
        const action = data.endCharacterAction;
        if (!action || action.actionHrid !== TRANSMUTE_ACTION_HRID) {
            return;
        }

        const inputItemHrid = this.extractItemHrid(action.primaryItemHash);
        if (!inputItemHrid) {
            return;
        }

        // Ensure we have an active session for this item
        if (!this.activeSession || this.activeSession.inputItemHrid !== inputItemHrid) {
            await this.startSession(inputItemHrid, Date.now());
        }
        this.activeSession.lastActivityTime = Date.now();

        // bulkMultiplier defines how many items are consumed and returned per action
        const itemDetailsForBulk = dataManager.getItemDetails(inputItemHrid);
        if (!itemDetailsForBulk?.alchemyDetail?.bulkMultiplier) {
            console.error(`[TransmuteHistoryTracker] Item has no alchemyDetail.bulkMultiplier: ${inputItemHrid}`);
        }
        const bulkMultiplier = itemDetailsForBulk?.alchemyDetail?.bulkMultiplier ?? 1;

        // Build a Set of valid output HRIDs from the input item's transmute drop table.
        // This filters out incidental drops (essences, artisan's crates) that arrive even on failure,
        // while correctly preserving essence outputs when transmuting essence → essence.
        const dropTable = itemDetailsForBulk?.alchemyDetail?.transmuteDropTable || [];
        const validOutputHrids = new Set(dropTable.map((entry) => entry.itemHrid));

        // Every row is recorded so the next message has a baseline; only the
        // drop-table rows say anything about what this action produced, since
        // incidental drops (essences, artisan's crates) arrive even on failure.
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

        this.activeSession.totalAttempts += attemptCount;

        // How many actions produced each output.
        //
        // Counting rows was only ever right while one message meant one action:
        // `endCharacterItems` carries one row per changed STACK, holding that
        // stack's new absolute total, so a batch of five successes on the same
        // output still arrives as a single row. The count delta is what scales
        // with the batch, and `bulkMultiplier` items arrive per successful
        // action, so the delta divided by it is the number of actions.
        //
        // The input's own row is both consumed and — on a self-return — handed
        // back, so its delta is `(returned - attempts) * bulk`; adding the
        // attempts back recovers the returns. A row with no baseline yet (the
        // first message of a session) can only be read the old way, as one
        // action, and is capped below so it cannot exceed the attempts made.
        const producedActions = new Map();
        for (const { row, delta } of outputRows) {
            const isSelfReturn = row.itemHrid === inputItemHrid;
            let actions;
            if (delta === null) {
                // No baseline: the row says "at least one", and nothing more.
                // A self-return row with no baseline is indistinguishable from
                // the plain consumption of the input, so it is not counted.
                actions = isSelfReturn ? 0 : 1;
            } else if (isSelfReturn) {
                actions = Math.round(delta / bulkMultiplier) + attemptCount;
            } else {
                actions = Math.round(delta / bulkMultiplier);
            }
            actions = Math.min(Math.max(actions, 0), attemptCount);
            if (actions > 0) producedActions.set(row.itemHrid, (producedActions.get(row.itemHrid) || 0) + actions);
        }

        // One action produces one output, so the successes cannot outnumber the
        // attempts however the deltas came out
        let successCount = 0;
        for (const actions of producedActions.values()) successCount += actions;
        successCount = Math.min(successCount, attemptCount);

        if (successCount > 0) {
            this.activeSession.totalSuccesses += successCount;

            for (const [outputItemHrid, actions] of producedActions) {
                const isOutputSelfReturn = outputItemHrid === inputItemHrid;

                if (!this.activeSession.results[outputItemHrid]) {
                    this.activeSession.results[outputItemHrid] = {
                        count: 0,
                        totalValue: 0,
                        priceEach: 0,
                        isSelfReturn: isOutputSelfReturn,
                    };
                }

                // Each producing action hands over bulkMultiplier items
                const received = actions * bulkMultiplier;
                this.activeSession.results[outputItemHrid].count += received;

                // Record market price at time of result
                if (!isOutputSelfReturn) {
                    const price = getItemPrice(outputItemHrid, { context: 'profit', side: 'sell' }) || 0;
                    this.activeSession.results[outputItemHrid].priceEach = price;
                    this.activeSession.results[outputItemHrid].totalValue += price * received;
                }
            }
        }
        // Failure — totalAttempts already incremented, nothing more to record

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
     * @param {number} timestamp - Start timestamp in ms
     */
    async startSession(inputItemHrid, timestamp) {
        // Recorded, not recomputed at read time: the coin fee that was actually
        // billed scales with the bulk size the item had while the session ran,
        // and a later game change to that number would otherwise silently
        // restate every past session's profit.
        const itemDetails = dataManager.getItemDetails(inputItemHrid);
        // What the model says this run will succeed at, taken NOW — the tea,
        // the catalyst in the slot and the level penalty are the ones this run
        // is played with, and every one of them will have moved by the time
        // anybody reads the record back. A session with no stamp is excluded
        // from calibration rather than judged against a later model.
        const stamp = predictedSuccessStamp('transmute', inputItemHrid, timestamp);
        this.activeSession = {
            id: `transmute_${timestamp}`,
            startTime: timestamp,
            // The last moment this run was seen acting. A multi-day AFK grind
            // is one session, and the gold attribution spreads its net over
            // [startTime, lastActivityTime] rather than dropping the lot on the
            // day it began. Sessions recorded before this field existed have
            // none, and are read as their start instant — exactly as before.
            lastActivityTime: timestamp,
            inputItemHrid,
            totalAttempts: 0,
            totalSuccesses: 0,
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
            console.error('[TransmuteHistoryTracker] Failed to save session:', error);
        }
    }

    /**
     * Load all sessions from storage
     * @returns {Array} Array of session objects
     */
    async loadSessions() {
        try {
            return await sessionStore.load(this.getCharacterScope());
        } catch (error) {
            console.error('[TransmuteHistoryTracker] Failed to load sessions:', error);
            return [];
        }
    }

    /**
     * Clear all history from storage.
     * @returns {Promise<boolean>} Whether the sessions are gone; false when the
     *   store could not be listed and they are therefore still on disk
     */
    async clearHistory() {
        try {
            this.activeSession = null;
            return await sessionStore.clear(this.getCharacterScope());
        } catch (error) {
            console.error('[TransmuteHistoryTracker] Failed to clear history:', error);
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
            console.error('[TransmuteHistoryTracker] Failed to save sessions after delete:', error);
        }
    }

    /**
     * Extract item HRID from a primaryItemHash string
     * Format: "characterId::/item_locations/inventory::/items/item_name::0"
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
     * Get the item name from HRID via dataManager
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item display name
     */
    getItemName(itemHrid) {
        const details = dataManager.getItemDetails(itemHrid);
        return details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }
}

const transmuteHistoryTracker = new TransmuteHistoryTracker();

export { transmuteHistoryTracker };

export default {
    name: 'Transmute History Tracker',
    initialize: () => transmuteHistoryTracker.initialize(),
    // Awaited, so a rejection from the now-async disable is caught here rather
    // than escaping as an unhandled promise
    cleanup: async () => {
        try {
            await transmuteHistoryTracker.disable();
        } catch (error) {
            console.error('[Transmute History Tracker] Disable failed part-way:', error);
        } finally {
            transmuteHistoryTracker.isInitialized = false;
        }
    },
};
