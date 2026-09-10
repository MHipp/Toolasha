/**
 * Personal Trade History Module
 * Tracks your buy/sell prices for marketplace items
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import config from '../../core/config.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/**
 * Two history maps folded into one, per item key and per side, the second
 * winning on a clash.
 *
 * Per side rather than per item: a stored `{sell}` and an in-memory `{buy}` for
 * the same item are two halves of one record, not two versions of it.
 * @param {Object<string, {buy?: number, sell?: number}>} base - Typically as stored
 * @param {Object<string, {buy?: number, sell?: number}>} fresh - Typically in memory
 * @returns {Object<string, {buy?: number, sell?: number}>} Merged map
 */
export function mergeHistory(base, fresh) {
    const safe = (map) => (map && typeof map === 'object' && !Array.isArray(map) ? map : {});
    const merged = {};
    for (const [key, entry] of Object.entries(safe(base))) {
        if (entry && typeof entry === 'object') merged[key] = { ...entry };
    }
    for (const [key, entry] of Object.entries(safe(fresh))) {
        if (entry && typeof entry === 'object') merged[key] = { ...(merged[key] || {}), ...entry };
    }
    return merged;
}

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: 'settings', base: 'tradeHistory', merge: mergeHistory, label: 'Personal trade prices' });

/**
 * How long a burst of fills is allowed to gather before one save is made.
 *
 * A save is a read-merge-write over the whole map. Selling a stack into a dozen
 * listings used to be a dozen of those, back to back, each one re-reading and
 * re-writing every price ever recorded. They coalesce into one instead.
 */
const SAVE_COALESCE_MS = 1500;

/**
 * The most item/enhancement pairs the map will keep.
 *
 * It only ever grew, and a record written on every fill forever is one that
 * eventually costs more to read and merge than the oldest prices in it are worth.
 * Object key order is insertion order, so the entries dropped are the ones
 * recorded longest ago.
 */
const MAX_ENTRIES = 4000;

/**
 * The map, trimmed to `MAX_ENTRIES` oldest-first.
 * @param {Object} history - The history map
 * @returns {Object} The same map, or a trimmed copy
 */
export function pruneHistory(history) {
    const keys = Object.keys(history || {});
    if (keys.length <= MAX_ENTRIES) return history;

    const kept = {};
    for (const key of keys.slice(keys.length - MAX_ENTRIES)) kept[key] = history[key];
    return kept;
}

/**
 * TradeHistory class manages personal buy/sell price tracking
 */
class TradeHistory {
    constructor() {
        this.history = {}; // itemHrid:enhancementLevel -> { buy, sell }
        this.isInitialized = false;
        this.isLoaded = false;
        this.characterId = null;
        this.marketUpdateHandler = null; // Store handler reference for cleanup
        this._saveChain = null;
        this._saveTimer = null;
    }

    /**
     * Get character-specific storage key
     * @returns {string} Storage key with character ID suffix
     */
    getStorageKey() {
        if (this.characterId) {
            return `tradeHistory_${this.characterId}`;
        }
        return 'tradeHistory'; // Fallback for no character ID
    }

    /**
     * Setup setting listener for feature toggle
     */
    setupSettingListener() {
        config.onSettingChange('market_tradeHistory', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        // A character switch clears the settings cache and fans `character_switched`
        // out to this module's import-time listener *before* feature-registry
        // reloads settings, so the initialize() below reads no stored value and
        // getSetting() answers from SCHEMA_DEFAULTS — `true` for trade history.
        // A character who turned it off would silently start recording prices
        // again, and initialize()'s isInitialized short-circuit means the later
        // re-init corrects nothing; loadSettings() fires no per-key change
        // callback on a switch either (the previous map is empty). This
        // channel, which fires whenever settings finish loading, is the one
        // signal that reaches here, so the real value gets the last word.
        // Only downward: bringing the feature *up* is the registry's re-init.
        config.onSettingsLoaded(() => {
            if (!config.getSetting('market_tradeHistory')) {
                this.disable();
            }
        });
    }

    /**
     * Initialize trade history tracking
     */
    async initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_tradeHistory')) {
            return;
        }

        // Get current character ID
        this.characterId = dataManager.getCurrentCharacterId();

        // Taken before the read, checked after it. `loadHistory()` guards its
        // own merge; this guards the registration.
        //
        // This module holds its own `character_switched` listener, so the
        // "dead until reload" shape does not apply — `handleCharacterSwitch()`
        // re-disables and re-initialises, which clears a leaked flag. What it
        // does NOT clear is a leaked listener: when the interrupted read lands
        // while `handleCharacterSwitch()` is itself parked on the
        // re-initialise, both calls register and `marketUpdateHandler` keeps
        // only the second handle, so the first `market_listings_updated`
        // listener can never be removed and every fill is recorded twice for
        // as long as the tab lives.
        const ticket = captureOwner(this);
        // Load existing history from storage
        await this.loadHistory();
        if (!stillOurs(ticket)) return;

        this.marketUpdateHandler = (data) => {
            this.handleMarketUpdate(data);
        };

        // Hook into data manager for market listing updates
        dataManager.on('market_listings_updated', this.marketUpdateHandler);

        this.isInitialized = true;
    }

    /**
     * Load trade history from storage.
     *
     * A read that could not be made is not an empty history: the key is probed
     * with a read that says whether it worked, and on failure the in-memory
     * map stands rather than being blanked and written back by the next fill.
     * What is stored is folded under what is in memory, so a price recorded
     * while a save was in flight is kept.
     */
    async loadHistory() {
        // Whose history this read is for, fixed before it. This module holds
        // its own `character_switched` listener, so it is not serialised by the
        // registry's switch chain: a second switch landing inside the read
        // leaves `handleCharacterSwitch()` having already blanked `history` and
        // pointed `characterId` at somebody else, and merging now folds the
        // departing character's reference prices into the arriving character's
        // map — which the next fill then writes into their `tradeHistory_<id>`,
        // where they stay.
        //
        // Capture and re-check the *live* current character, not `this.characterId`:
        // that field only moves in `initialize()`, which `handleCharacterSwitch()`
        // reaches after `await this._saveChain`, so during that gap it still names
        // the departing character. A read resuming there would compare equal to the
        // stale id and pass the guard; `getCurrentCharacterId()` moves the instant
        // the switch settles, so it catches the switch the lagging field misses.
        const owner = dataManager.getCurrentCharacterId();
        try {
            const probe = await storage.tryGet(this.getStorageKey(), 'settings');
            if (dataManager.getCurrentCharacterId() !== owner) return;

            if (probe === null) {
                console.warn('[TradeHistory] History could not be read; keeping the in-memory copy');
            } else {
                this.history = mergeHistory(probe.found ? probe.value : {}, this.history);
            }
        } catch (error) {
            console.error('[TradeHistory] Failed to load history:', error);
            // Keep whatever is in memory
        }
        // Left alone on the refused branch: the arriving character's own load
        // owns this flag, and setting it here would let a fill write before
        // their history had been read back
        this.isLoaded = true;
    }

    /**
     * Save trade history to storage.
     *
     * Read-merge-write, serialized: the stored map is re-read and folded under
     * the in-memory one before the write, so prices another tab recorded are
     * carried forward rather than overwritten. When the pre-write read cannot
     * be made the write is skipped — memory is kept and the next save retries —
     * because a blind overwrite from a possibly-empty copy is exactly the
     * accident this exists to prevent.
     *
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveHistory() {
        const run = async () => {
            try {
                const storageKey = this.getStorageKey();
                const probe = await storage.tryGet(storageKey, 'settings');
                if (probe === null) {
                    console.warn('[TradeHistory] History not saved: storage could not be read first');
                    return false;
                }
                this.history = mergeHistory(probe.found ? probe.value : {}, this.history);
                this.history = pruneHistory(this.history);
                // Not `immediate`: a price recorded a heartbeat before the tab
                // closes is not worth flushing the store on every fill for
                return await storage.setJSON(storageKey, this.history, 'settings');
            } catch (error) {
                console.error('[TradeHistory] Failed to save history:', error);
                return false;
            }
        };
        // One save at a time, in order: two interleaved read-merge-writes could
        // each miss the other's entries
        this._saveChain = (this._saveChain || Promise.resolve()).then(run, run);
        return this._saveChain;
    }

    /**
     * Forget a save that has not run yet.
     *
     * Nothing in the feature needs this — the only caller is the test suite,
     * resetting a pending timer between cases so one test's gathered save
     * cannot land during the next. It is kept for that: the alternative is a
     * test reaching into `_saveTimer` and calling `clearTimeout` itself, which
     * is the same thing with the knowledge of how saves are scheduled moved
     * somewhere it does not belong.
     */
    _cancelScheduledSave() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
    }

    /**
     * Ask for a save, gathering anything else that arrives first.
     *
     * The pre-write read is the expensive half, and a burst of fills only needs
     * one of them: whatever the burst records is in `this.history` by the time
     * the timer runs.
     */
    scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saveHistory();
        }, SAVE_COALESCE_MS);
    }

    /**
     * Make any gathered save happen now.
     * @returns {Promise<boolean|undefined>} The write in flight, if there is one
     */
    async flushSave() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
            this.saveHistory();
        }
        return this._saveChain;
    }

    /**
     * Handle market_listings_updated WebSocket message
     * @param {Object} data - Market update data
     */
    handleMarketUpdate(data) {
        if (!data.endMarketListings) return;

        let hasChanges = false;

        // Process each completed order
        data.endMarketListings.forEach((order) => {
            // Only track orders that actually filled
            if (order.filledQuantity === 0) return;

            const key = `${order.itemHrid}:${order.enhancementLevel || 0}`;

            // Get existing history for this item or create new
            const itemHistory = this.history[key] || {};

            // Update buy or sell price
            if (order.isSell) {
                itemHistory.sell = order.price;
            } else {
                itemHistory.buy = order.price;
            }

            this.history[key] = itemHistory;
            hasChanges = true;
        });

        // Save to storage if any changes
        if (hasChanges) {
            this.scheduleSave();
        }
    }

    /**
     * Get trade history for a specific item
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level (default 0)
     * @returns {Object|null} { buy, sell } or null if no history
     */
    getHistory(itemHrid, enhancementLevel = 0) {
        const key = `${itemHrid}:${enhancementLevel}`;
        return this.history[key] || null;
    }

    /**
     * Check if history data is loaded
     * @returns {boolean}
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Disable the feature
     */
    disable() {
        noteTeardown(this);
        try {
            if (this.marketUpdateHandler) {
                dataManager.off('market_listings_updated', this.marketUpdateHandler);
                this.marketUpdateHandler = null;
            }
            // Anything gathered but not yet written goes now, or it goes nowhere
            this.flushSave();

            // Don't clear history data, just stop tracking
            this.isInitialized = false;
        } catch (error) {
            console.error('[Trade History] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Handle character switch - clear old data and reinitialize
     */
    async handleCharacterSwitch() {
        // Disable first to clean up old handlers
        this.disable();
        // …and let the save it flushed land against the old character's key
        // before the map it is writing is emptied out from under it
        await this._saveChain;

        // Clear old character's data from memory
        this.history = {};
        this.isLoaded = false;

        // Reinitialize with new character
        await this.initialize();
    }
}

const tradeHistory = new TradeHistory();
tradeHistory.setupSettingListener();

// Setup character switch handler. Always reset in-memory state, even while
// the feature is off: initialize() itself no-ops until the setting is on,
// but if we only reset while it's on, toggling the feature off, switching
// characters, then back on leaves the previous character's `history` map in
// memory. loadHistory() then merges the new character's stored data
// underneath that stale copy instead of replacing it, corrupting the new
// character's price history.
dataManager.on('character_switched', () => {
    tradeHistory.handleCharacterSwitch();
});

export default tradeHistory;
