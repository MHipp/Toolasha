/**
 * Marketplace API Module
 * Fetches and caches market price data from the MWI marketplace API
 */

import connectionState from '../core/connection-state.js';
import storage from '../core/storage.js';
import networkAlert from '../features/market/network-alert.js';

/**
 * The band module, late-bound off the Utils bundle. Core loads before Utils,
 * so a module import here would inline a second copy of the band cache into
 * the Core bundle — exactly the duplication the bundle-sharing check forbids.
 * Before Utils lands (a few ms at startup) prices pass through unbanded,
 * which is what they always were.
 * @returns {Object|null} `Toolasha.Utils.marketValues`, or null before Utils loads
 */
function marketValues() {
    return (typeof window !== 'undefined' && window.Toolasha?.Utils?.marketValues) || null;
}

/**
 * MarketAPI class handles fetching and caching market price data
 */
class MarketAPI {
    constructor() {
        // API endpoint
        this.API_URL = 'https://www.milkywayidle.com/game_data/marketplace.json';

        // Cache settings
        this.CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds
        this.CACHE_KEY_DATA = 'Toolasha_marketAPI_json';
        this.CACHE_KEY_TIMESTAMP = 'Toolasha_marketAPI_timestamp';
        this.CACHE_KEY_PATCHES = 'Toolasha_marketAPI_patches';
        this.CACHE_KEY_MIGRATION = 'Toolasha_marketAPI_migration_version';
        this.CURRENT_MIGRATION_VERSION = 1; // Increment this when patches need to be cleared

        // Current market data
        this.marketData = null;
        this.lastFetchTimestamp = null;
        this.errorLog = [];

        // Price patches from order book data (fresher than API)
        // Structure: { "itemHrid:enhLevel": { a: ask, b: bid, timestamp: ms } }
        this.pricePatchs = {};

        // Event listeners for price updates
        this.listeners = [];
        /** How long a burst of price patches is gathered before the listeners hear once */
        this.NOTIFY_COALESCE_MS = 100;
        this._notifyTimer = null;

        /** The fetch currently running, shared by every concurrent caller */
        this._inFlightFetch = null;
        /** Whether that fetch was a forced one (a forced result satisfies anyone) */
        this._inFlightForce = false;
    }

    /**
     * Fetch market data from API or cache.
     *
     * Concurrent callers share one request: several features fetch at startup
     * behind nothing but an `isLoaded()` check, and marketplace.json is
     * rate-limited — a burst of parallel fetches is exactly what trips its
     * CloudFront 403 (see the catch below). A force request arriving behind a
     * plain in-flight one waits it out and then refreshes — sequential, so
     * still never a burst.
     *
     * @param {boolean} forceFetch - Force a fresh fetch even if cache is valid
     * @returns {Promise<Object|null>} Market data object or null if failed
     */
    async fetch(forceFetch = false) {
        // Several forced callers can pile up behind one plain in-flight fetch
        // (e.g. a manual refresh button and a patch-driven invalidation firing
        // at once). Each waits the plain fetch out, but only the first should
        // then start a new request — everyone who resumes afterward has to
        // re-check whether another forced caller already claimed the slot, or
        // they would all fire their own refresh in parallel, which is exactly
        // the burst this dedup exists to prevent.
        for (;;) {
            if (!this._inFlightFetch) break;
            if (!forceFetch || this._inFlightForce) return this._inFlightFetch;
            const waited = this._inFlightFetch;
            await waited.catch(() => {});
            if (this._inFlightFetch && this._inFlightFetch !== waited) continue;
            break;
        }

        const run = this._fetchInner(forceFetch);
        this._inFlightFetch = run;
        this._inFlightForce = forceFetch;
        try {
            return await run;
        } finally {
            if (this._inFlightFetch === run) {
                this._inFlightFetch = null;
                this._inFlightForce = false;
            }
        }
    }

    /**
     * The actual fetch, always reached through `fetch()`'s in-flight dedup.
     * @param {boolean} forceFetch - Force a fresh fetch even if cache is valid
     * @returns {Promise<Object|null>} Market data object or null if failed
     * @private
     */
    async _fetchInner(forceFetch = false) {
        // Check cache first (unless force fetch)
        if (!forceFetch) {
            const cached = await this.getCachedData();
            if (cached) {
                this.marketData = cached.data;
                // API timestamp is in seconds, convert to milliseconds for comparison with Date.now()
                this.lastFetchTimestamp = cached.timestamp * 1000;
                // Load patches from storage
                await this.loadPatches();
                // Hide alert on successful cache load
                networkAlert.hide();
                // Notify listeners (initial load)
                this.notifyListeners();
                return this.marketData;
            }
        }

        if (!connectionState.isConnected()) {
            const cachedFallback = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);
            if (cachedFallback?.marketData) {
                this.marketData = cachedFallback.marketData;
                // API timestamp is in seconds, convert to milliseconds
                this.lastFetchTimestamp = cachedFallback.timestamp * 1000;
                // Load patches from storage
                await this.loadPatches();
                console.warn('[MarketAPI] Skipping fetch; disconnected. Using cached data.');
                return this.marketData;
            }

            console.warn('[MarketAPI] Skipping fetch; disconnected and no cache available');
            return null;
        }

        // Try to fetch fresh data
        let rateLimited = false;
        try {
            const response = await this.fetchFromAPI();

            if (response) {
                // Cache the fresh data
                this.cacheData(response);
                this.marketData = response.marketData;
                // API timestamp is in seconds, convert to milliseconds
                this.lastFetchTimestamp = response.timestamp * 1000;
                // Load patches from storage (they may still be fresher than new API data)
                await this.loadPatches();
                // Hide alert on successful fetch
                networkAlert.hide();
                // Notify listeners of price update
                this.notifyListeners();
                return this.marketData;
            }
        } catch (error) {
            // marketplace.json is rate-limited by the game: a burst of requests —
            // often several userscripts hitting it at once — trips a temporary
            // CloudFront 403 (429 is the explicit rate-limit status). Call that out
            // plainly instead of as a generic fetch failure, so a player seeing the
            // block knows what it is and that Toolasha is not the cause on its own.
            rateLimited = error?.status === 403 || error?.status === 429;
            if (rateLimited) {
                console.warn(
                    `[MarketAPI] marketplace.json returned ${error.status} — the game rate-limits this file and a burst ` +
                        'of fetches (often several userscripts at once) trips a temporary block. Falling back to cached ' +
                        'prices; it retries on the normal 15-minute cache cadence.'
                );
            }
            this.logError(rateLimited ? `Rate limited (${error.status})` : 'Fetch failed', error);
        }

        // Fallback: Try to use expired cache
        const expiredCache = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);
        if (expiredCache) {
            console.warn('[MarketAPI] Using expired cache as fallback');
            this.marketData = expiredCache.marketData;
            // API timestamp is in seconds, convert to milliseconds
            this.lastFetchTimestamp = expiredCache.timestamp * 1000;
            // Load patches from storage
            await this.loadPatches();
            // Show alert when using expired cache
            networkAlert.show(
                rateLimited ? '⚠️ Market API rate-limited — using cached prices' : '⚠️ Using outdated market data'
            );
            return this.marketData;
        }

        // Total failure - show alert
        console.error('[MarketAPI] ❌ No market data available');
        networkAlert.show(rateLimited ? '⚠️ Market API rate-limited — no market data' : '⚠️ Market data unavailable');
        return null;
    }

    /**
     * Fetch from API endpoint
     * @returns {Promise<Object|null>} API response or null
     */
    async fetchFromAPI() {
        try {
            const response = await fetch(this.API_URL);

            if (!response.ok) {
                // Carry the status so fetch() can tell a rate-limit (403/429) from
                // any other failure and message the player accordingly.
                const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
                error.status = response.status;
                throw error;
            }

            const data = await response.json();

            // Validate response structure
            if (!data.marketData || typeof data.marketData !== 'object') {
                throw new Error('Invalid API response structure');
            }

            return data;
        } catch (error) {
            console.error('[MarketAPI] API fetch error:', error);
            throw error;
        }
    }

    /**
     * Get cached data if valid
     * @returns {Promise<Object|null>} { data, timestamp } or null if invalid/expired
     */
    async getCachedData() {
        const cachedTimestamp = await storage.get(this.CACHE_KEY_TIMESTAMP, 'settings', null);
        const cachedData = await storage.getJSON(this.CACHE_KEY_DATA, 'settings', null);

        if (!cachedTimestamp || !cachedData) {
            return null;
        }

        // Check if cache is still valid. A negative age is a stamp from the
        // future — the clock stepped back (an NTP correction, a manual change)
        // since the write — and counts as expired rather than as freshness: read
        // as valid, it pins the snapshot until the clock catches up, which can
        // be hours of prices quoted as current. The same reading `updatePrices`
        // makes of a sighting from the future.
        const now = Date.now();
        const age = now - cachedTimestamp;

        if (!(age >= 0 && age <= this.CACHE_DURATION)) {
            return null;
        }

        return {
            data: cachedData.marketData,
            timestamp: cachedData.timestamp,
        };
    }

    /**
     * Cache market data
     * @param {Object} data - API response to cache
     */
    cacheData(data) {
        storage.setJSON(this.CACHE_KEY_DATA, data, 'settings');
        storage.set(this.CACHE_KEY_TIMESTAMP, Date.now(), 'settings');
    }

    /**
     * Get price for an item
     * @param {string} itemHrid - Item HRID (e.g., "/items/cheese")
     * @param {number} enhancementLevel - Enhancement level (default: 0)
     * @returns {Object|null} { ask: number, bid: number } or null if not found
     */
    getPrice(itemHrid, enhancementLevel = 0) {
        // Every price this returns is a cached snapshot, so a figure parked
        // outside the game's tradable range is one no order could actually
        // reach — clamp it to the band here, once, and every caller (present
        // and future) inherits banded prices. A missing side stays null: the
        // band never invents a price where the book has none.
        const bands = marketValues();
        bands?.refreshMarketValues();
        const normalizeMarketPriceValue = (value) => {
            if (typeof value !== 'number') {
                return null;
            }

            if (value < 0) {
                return null;
            }

            return bands ? bands.clampToBand(value, itemHrid, enhancementLevel) : value;
        };

        // Check for fresh patch first
        const patchKey = `${itemHrid}:${enhancementLevel}`;
        const patch = this.pricePatchs[patchKey];

        if (patch && patch.timestamp > this.lastFetchTimestamp) {
            // Patch is fresher than API data - use it
            return {
                ask: normalizeMarketPriceValue(patch.a),
                bid: normalizeMarketPriceValue(patch.b),
            };
        }

        // Fall back to API data
        if (!this.marketData) {
            console.warn('[MarketAPI] ⚠️ No market data available');
            return null;
        }

        const priceData = this.marketData[itemHrid];

        if (!priceData || typeof priceData !== 'object') {
            // Item not in market data at all
            return null;
        }

        // Market data is organized by enhancement level
        // { 0: { a: 1000, b: 900 }, 2: { a: 5000, b: 4500 }, ... }
        const price = priceData[enhancementLevel];

        if (!price) {
            // No price data for this enhancement level
            return null;
        }

        return {
            ask: normalizeMarketPriceValue(price.a), // Sell price
            bid: normalizeMarketPriceValue(price.b), // Buy price
        };
    }

    /**
     * When the price this returns for an item was last known to be current, in ms
     * since the epoch.
     *
     * A write-through patch (e.g. a Mooket refresh) carries its own time and wins
     * when it is newer than the snapshot; otherwise the figure is as old as the
     * whole `marketplace.json` feed. There is no per-item API timestamp — the feed
     * is one snapshot — so this is the best "how fresh is this number" available.
     *
     * @param {string} itemHrid - Item
     * @param {number} [enhancementLevel] - Enhancement level
     * @returns {number|null} Milliseconds since epoch, or null when nothing is known
     */
    getPriceTimestamp(itemHrid, enhancementLevel = 0) {
        const patch = this.pricePatchs[`${itemHrid}:${enhancementLevel}`];
        // The same freshness test getPrice() applies, with a null snapshot
        // reading as 0: when the snapshot never loaded (a failed first fetch)
        // getPrice() serves the patch, so the patch's time is this price's
        // time — answering null there reported a price in active use as one
        // of unknown age.
        if (patch && patch.timestamp > (this.lastFetchTimestamp || 0)) {
            return patch.timestamp;
        }
        return this.lastFetchTimestamp || null;
    }

    /**
     * Get prices for multiple items
     * @param {string[]} itemHrids - Array of item HRIDs
     * @returns {Map<string, Object>} Map of HRID -> { ask, bid }
     */
    getPrices(itemHrids) {
        const prices = new Map();

        for (const hrid of itemHrids) {
            const price = this.getPrice(hrid);
            if (price) {
                prices.set(hrid, price);
            }
        }

        return prices;
    }

    /**
     * Get prices for multiple items with enhancement levels (batch optimized)
     * @param {Array<{itemHrid: string, enhancementLevel: number}>} items - Array of items with enhancement levels
     * @returns {Map<string, Object>} Map of "hrid:level" -> { ask, bid }
     */
    getPricesBatch(items) {
        const priceMap = new Map();

        for (const { itemHrid, enhancementLevel = 0 } of items) {
            const key = `${itemHrid}:${enhancementLevel}`;
            if (!priceMap.has(key)) {
                const price = this.getPrice(itemHrid, enhancementLevel);
                if (price) {
                    priceMap.set(key, price);
                }
            }
        }

        return priceMap;
    }

    /**
     * Check if market data is loaded
     * @returns {boolean} True if data is available
     */
    isLoaded() {
        return this.marketData !== null;
    }

    /**
     * Get age of current data in milliseconds
     * @returns {number|null} Age in ms or null if no data
     */
    getDataAge() {
        if (!this.lastFetchTimestamp) {
            return null;
        }

        return Date.now() - this.lastFetchTimestamp;
    }

    /**
     * Log an error
     * @param {string} message - Error message
     * @param {Error} error - Error object
     */
    logError(message, error) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            message,
            error: error?.message || String(error),
        };

        this.errorLog.push(errorEntry);
        console.error(`[MarketAPI] ${message}:`, error);
    }

    /**
     * Get error log
     * @returns {Array} Array of error entries
     */
    getErrors() {
        return [...this.errorLog];
    }

    /**
     * Clear error log
     */
    clearErrors() {
        this.errorLog = [];
    }

    /**
     * Update price from order book data (fresher than API)
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @param {number|null} ask - Top ask price (null if no asks)
     * @param {number|null} bid - Top bid price (null if no bids)
     * @param {number} [observedAt] - When the figure was true, if not now
     */
    updatePrice(itemHrid, enhancementLevel, ask, bid, observedAt) {
        this.updatePrices([{ itemHrid, enhancementLevel, ask, bid, observedAt }]);
    }

    /**
     * Update several prices from order book data in one go.
     *
     * One order book response carries every enhancement level of an item — up
     * to twenty-one of them — and patching each separately used to notify the
     * listeners that many times, each re-ingesting the whole price table. The
     * patches are written together and the listeners told once.
     * A patch's `timestamp` is when the price was *true*, not when it was
     * written. Order books are read live, so `Date.now()` is right for them and
     * stays the default; a third-party sighting that is fifty minutes old is
     * not, and stamping it "now" let stale data beat a genuinely fresh figure
     * and print as "as of just now". Such callers pass `observedAt`.
     * @param {Array<{itemHrid: string, enhancementLevel: number, ask: number|null,
     *   bid: number|null, observedAt?: number}>} entries
     */
    updatePrices(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        const now = Date.now();
        let changed = false;
        for (const entry of entries) {
            if (!entry || !entry.itemHrid) continue;
            const key = `${entry.itemHrid}:${entry.enhancementLevel}`;
            // A sighting from the future is a clock disagreement, not fresher data
            const observed = Number.isFinite(entry.observedAt) ? Math.min(entry.observedAt, now) : now;
            this.pricePatchs[key] = {
                a: entry.ask,
                b: entry.bid,
                timestamp: observed,
            };
            changed = true;
        }

        if (!changed) {
            return;
        }

        // Save patches to storage (debounced via storage module)
        this.savePatches();

        // Notify listeners of price update, coalesced across a burst
        this.scheduleNotify();
    }

    /**
     * Notify the listeners once for a burst of price patches.
     *
     * Patches arrive in runs — an order book per enhancement level, a
     * per-listing refresh — and the listeners are not cheap (one re-ingests
     * the whole price table, another drops its production-cost caches). A
     * trailing timer folds a run into one notification; a lone patch still
     * notifies, just that much later.
     */
    scheduleNotify() {
        if (this._notifyTimer) {
            return;
        }
        this._notifyTimer = setTimeout(() => {
            this._notifyTimer = null;
            this.notifyListeners();
        }, this.NOTIFY_COALESCE_MS);
    }

    /**
     * Load price patches from storage
     */
    async loadPatches() {
        try {
            // Check migration version - clear patches if old version
            const migrationVersion = await storage.get(this.CACHE_KEY_MIGRATION, 'settings', 0);

            if (migrationVersion < this.CURRENT_MIGRATION_VERSION) {
                console.log(
                    `[MarketAPI] Migrating price patches from v${migrationVersion} to v${this.CURRENT_MIGRATION_VERSION}`
                );
                // Clear old patches (they may have corrupted data)
                this.pricePatchs = {};
                await storage.set(this.CACHE_KEY_PATCHES, {}, 'settings');
                await storage.set(this.CACHE_KEY_MIGRATION, this.CURRENT_MIGRATION_VERSION, 'settings');
                console.log('[MarketAPI] Price patches cleared due to migration');
                return;
            }

            // Load patches normally
            const patches = await storage.getJSON(this.CACHE_KEY_PATCHES, 'settings', {});
            this.pricePatchs = patches || {};

            // Purge stale patches (older than API data)
            this.purgeStalePatches();
        } catch (error) {
            console.error('[MarketAPI] Failed to load price patches:', error);
            this.pricePatchs = {};
        }
    }

    /**
     * Remove patches older than the current API data
     * Called after loadPatches() to clean up stale patches
     */
    purgeStalePatches() {
        if (!this.lastFetchTimestamp) {
            return; // No API data loaded yet
        }

        let purgedCount = 0;
        const keysToDelete = [];

        for (const [key, patch] of Object.entries(this.pricePatchs)) {
            // Check for corrupted/invalid patches or stale timestamps
            if (!patch || !patch.timestamp || patch.timestamp < this.lastFetchTimestamp) {
                keysToDelete.push(key);
                purgedCount++;
            }
        }

        // Remove stale patches
        for (const key of keysToDelete) {
            delete this.pricePatchs[key];
        }

        if (purgedCount > 0) {
            console.log(`[MarketAPI] Purged ${purgedCount} stale price patches`);
            // Save cleaned patches
            this.savePatches();
        }
    }

    /**
     * Save price patches to storage (debounced by the storage module; pending
     * writes are flushed on unload via storage.flushAll())
     */
    savePatches() {
        storage.setJSON(this.CACHE_KEY_PATCHES, this.pricePatchs, 'settings');
    }

    /**
     * Clear cache and fetch fresh market data
     * @returns {Promise<Object|null>} Fresh market data or null if failed
     */
    async clearCacheAndRefetch() {
        // Clear storage cache
        await storage.delete(this.CACHE_KEY_DATA, 'settings');
        await storage.delete(this.CACHE_KEY_TIMESTAMP, 'settings');

        // Clear in-memory state
        this.marketData = null;
        this.lastFetchTimestamp = null;

        // Force fresh fetch
        return await this.fetch(true);
    }

    /**
     * Register a listener for price updates
     * @param {Function} callback - Called when prices update
     */
    on(callback) {
        this.listeners.push(callback);
    }

    /**
     * Unregister a listener
     * @param {Function} callback - The callback to remove
     */
    off(callback) {
        this.listeners = this.listeners.filter((cb) => cb !== callback);
    }

    /**
     * Notify all listeners that prices have been updated
     */
    notifyListeners() {
        // A direct notification (a fetch landing) covers any patch still waiting
        // on the coalescing timer
        if (this._notifyTimer) {
            clearTimeout(this._notifyTimer);
            this._notifyTimer = null;
        }
        for (const callback of this.listeners) {
            try {
                callback();
            } catch (error) {
                console.error('[MarketAPI] Listener error:', error);
            }
        }
    }
}

const marketAPI = new MarketAPI();

export default marketAPI;
