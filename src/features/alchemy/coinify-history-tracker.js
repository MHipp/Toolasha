/**
 * Coinify History Tracker
 * Records coinify sessions via WebSocket and persists to IndexedDB.
 *
 * Session lifecycle:
 * - Start: actions_updated with actionHrid === '/actions/alchemy/coinify'
 * - Result: action_completed with same actionHrid
 * - End: actions_updated with no coinify action, or different input item/enhancement level
 *
 * Result detection:
 * - Success: coins gained, read as a delta on the coin stack's total — one
 *   message can carry a batch of attempts, and coins are a single stack, so the
 *   presence of a coin row says only "at least one", never how many
 * - Failure: no coins gained
 *
 * Coins earned per success: itemDetails.sellPrice * 5 * bulkMultiplier
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { createAlchemySessionStore, NO_CHARACTER } from './alchemy-session-store.js';
import { predictedSuccessStamp } from './alchemy-success-stamp.js';
import { createItemCountLedger } from './alchemy-item-deltas.js';

const COINIFY_ACTION_HRID = '/actions/alchemy/coinify';
const COIN_ITEM_HRID = '/items/coin';
const CATALYST_OF_COINIFICATION_HRID = '/items/catalyst_of_coinification';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';
const STORAGE_KEY = 'coinifySessions';

/**
 * The sessions, one record per day rather than one array rewritten per action.
 * See `alchemy-session-store.js` for what that is worth.
 */
const sessionStore = createAlchemySessionStore(STORAGE_KEY, 'CoinifyHistoryTracker');

class CoinifyHistoryTracker {
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

        if (!config.getSetting('alchemy_coinifyHistory')) {
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
        const coinifyAction = actions.find((a) => a.actionHrid === COINIFY_ACTION_HRID);

        if (coinifyAction) {
            const inputItemHrid = this.extractItemHrid(coinifyAction.primaryItemHash);
            const enhancementLevel = this.extractEnhancementLevel(coinifyAction.primaryItemHash);

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
            // No coinify action in the update — end any active session
            await this.endSession();
        }
    }

    /**
     * Handle action_completed — record one attempt result
     * @param {Object} data - WebSocket message data
     */
    async handleActionCompleted(data) {
        const action = data.endCharacterAction;
        if (!action || action.actionHrid !== COINIFY_ACTION_HRID) {
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

        // Derive actual attempt count from currentCount delta (handles batched efficiency procs)
        const currentCount = action.currentCount || 0;
        const coinRows = (data.endCharacterItems || []).filter((item) => item.itemHrid === COIN_ITEM_HRID);
        const coinsGained = this.itemCounts.note(coinRows);

        let attemptCount;
        if (this.lastCurrentCount !== null && currentCount > this.lastCurrentCount) {
            attemptCount = currentCount - this.lastCurrentCount;
        } else {
            // First tick or counter reset — one attempt is the least it can have been
            attemptCount = 1;
        }
        this.lastCurrentCount = currentCount;

        // Successes come from the coins actually gained, not from the number of
        // changed stacks: coins are ONE stack, so counting rows could only ever
        // answer 0 or 1 while `attemptCount` above exists precisely because the
        // game batches several attempts into one message. A batch of five
        // successes was recorded as one, and the session's success rate with it.
        //
        // Coinify has no coin fee (see utils/alchemy-fees.js), so the gain is
        // exactly successes x coinsPerSuccess. Without a baseline for the coin
        // stack — the first message of a session — there is no delta to read and
        // the stack count is all there is; it is a floor, and marked as one by
        // being capped at the attempts it cannot exceed.
        const coinsPerSuccess = this.activeSession.coinsPerSuccess;
        let successCount;
        if (coinsGained !== null && coinsPerSuccess > 0) {
            successCount = Math.round(coinsGained / coinsPerSuccess);
        } else {
            successCount = coinRows.length;
        }
        successCount = Math.min(Math.max(successCount, 0), attemptCount);

        this.activeSession.totalAttempts += attemptCount;

        if (successCount > 0) {
            this.activeSession.totalSuccesses += successCount;
            this.activeSession.totalCoinsEarned += this.activeSession.coinsPerSuccess * successCount;
        }

        // Track catalyst usage — catalysts are only consumed on success
        const secondaryHrid = this.extractItemHrid(action.secondaryItemHash);
        if (secondaryHrid === CATALYST_OF_COINIFICATION_HRID) {
            this.activeSession.catalystOfCoinificationUsed += successCount;
        } else if (secondaryHrid === PRIME_CATALYST_HRID) {
            this.activeSession.primeCatalystUsed += successCount;
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
        const itemDetails = dataManager.getItemDetails(inputItemHrid);

        if (!itemDetails?.alchemyDetail?.bulkMultiplier) {
            console.error(`[CoinifyHistoryTracker] Item has no alchemyDetail.bulkMultiplier: ${inputItemHrid}`);
        }
        if (!itemDetails?.sellPrice) {
            // With no sellPrice, coinsPerSuccess comes out 0 and the coin-delta
            // path below can no longer tell successes from failures, silently
            // degrading to counting the coin row itself — which is 0 or 1
            // regardless of how many attempts a batched message covers.
            console.error(`[CoinifyHistoryTracker] Item has no sellPrice: ${inputItemHrid}`);
        }
        const bulkMultiplier = itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;
        const coinsPerSuccess = (itemDetails?.sellPrice || 0) * 5 * bulkMultiplier;
        // The model's prediction for this run, taken at the start: the tea, the
        // catalyst in the slot and the under-level penalty are what this run is
        // played with, and all three drift. A session with no stamp is excluded
        // from calibration rather than judged against a model it never saw.
        const stamp = predictedSuccessStamp('coinify', inputItemHrid, timestamp);

        this.activeSession = {
            id: `coinify_${timestamp}`,
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
            totalCoinsEarned: 0,
            catalystOfCoinificationUsed: 0,
            primeCatalystUsed: 0,
            coinsPerSuccess,
            bulkMultiplier,
            predictedRate: stamp?.predictedRate ?? null,
            predictedAt: stamp?.predictedAt ?? null,
            predictedCatalystHrid: stamp?.predictedCatalystHrid ?? null,
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
            console.error('[CoinifyHistoryTracker] Failed to save session:', error);
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
            console.error('[CoinifyHistoryTracker] Failed to load sessions:', error);
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
            console.error('[CoinifyHistoryTracker] Failed to clear history:', error);
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
            console.error('[CoinifyHistoryTracker] Failed to save sessions after delete:', error);
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
}

const coinifyHistoryTracker = new CoinifyHistoryTracker();

export { coinifyHistoryTracker };

export default {
    name: 'Coinify History Tracker',
    initialize: () => coinifyHistoryTracker.initialize(),
    // Awaited, so a rejection from the now-async disable is caught here rather
    // than escaping as an unhandled promise
    cleanup: async () => {
        try {
            await coinifyHistoryTracker.disable();
        } catch (error) {
            console.error('[Coinify History Tracker] Disable failed part-way:', error);
        } finally {
            coinifyHistoryTracker.isInitialized = false;
        }
    },
};
