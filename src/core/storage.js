/**
 * Centralized IndexedDB Storage
 * Replaces GM storage with IndexedDB for better performance and Chromium compatibility
 * Provides debounced writes to reduce I/O operations
 */

/**
 * Soft per-store key-count budgets.
 *
 * Not a limit the database enforces — nothing here refuses a write. It is the
 * number above which a store has stopped being a rolling window and started
 * being a leak, which is a thing worth saying in a diagnostic report before the
 * quota says it for us. Only stores that grow with play are listed; anything
 * absent is unbudgeted and simply reported without a verdict.
 *
 * Three of these budgets were raised when their recorders stopped keeping their
 * history in one key and started keeping it in one record per time bucket (see
 * `utils/chunked-history.js`). The key count went up and the bytes written per
 * event went down by two or three orders of magnitude, which is the trade the
 * budget is here to permit rather than to flag — a store of many small records
 * is not the leak this number looks for.
 */
const STORE_KEY_BUDGETS = {
    settings: 500,
    // Per character: ~25 item-level detail snapshots plus one series record per
    // calendar month, capped by a year of full retention beneath the thinning
    networthHistory: 600,
    // Per character: one record per hour of play, and the log keeps 2,000
    // entries (`MAX_ENTRIES` in loot-log-history.js). Typical play puts several
    // entries in an hour, so the real count is a few hundred; the budget matches
    // the cap because the worst case — one long run per hour — is one record per
    // entry, and a store must not be flagged for doing exactly what it is sized
    // to do
    lootLogHistory: 2000,
    guildHistory: 80,
    leaderboardHistory: 80,
    // Per character: the XP tracker's one rolling week, plus two unbounded
    // daily-checkpoint series (skills and abilities) at one record per calendar
    // month each — twenty-four keys a year per character, kept forever
    xpHistory: 800,
    // Three trackers (transmute, decompose, coinify), one record per day each
    // has sessions on, per character
    alchemyHistory: 1500,
    dungeonRuns: 600,
    unifiedRuns: 600,
    teamRuns: 600,
    combatStats: 200,
    queueSnapshots: 80,
    marketListings: 2000,
};

/**
 * How many consecutive failed flushes a single pending key gets before it is dropped.
 * A transient failure (a reconnect gap, a quota the user then frees) recovers well
 * inside this; a value the store will never accept stops coming back forever.
 */
const MAX_FLUSH_ATTEMPTS = 3;

class Storage {
    constructor() {
        this.db = null;
        this.available = false;
        this.dbName = 'ToolashaDB';
        // Kept in lockstep with the upstream script this fork shares its
        // database with. Upstream is at v20 (actionProgress v18,
        // characterActivityStatus v19, openableAnalytics v20); if it runs
        // once at a higher version than ours, our open() dies with a
        // VersionError and every read silently returns its default — so we
        // match its version and create its stores even before we use them.
        this.dbVersion = 20;
        this.saveDebounceTimers = new Map(); // Per-key debounce timers
        this.pendingWrites = new Map(); // Per-key pending write data: {value, storeName, resolvers, generation}
        this._writeGeneration = new Map(); // Per-key monotonic generation counter, for write ownership
        // Per-key consecutive flush failures. A value IndexedDB refuses to store at all
        // (un-cloneable, or bigger than the space that will ever be free) is requeued by
        // flushAll with no timer, so without a cap it comes back every flush forever.
        this._flushFailures = new Map();
        /**
         * Debounced writes whose timer has already fired and whose transaction
         * is still in flight.
         *
         * A firing timer takes its entry out of `pendingWrites` *before* it
         * awaits IndexedDB, so from that moment until the write settles the
         * value is in neither place. `flushAll()` snapshots `pendingWrites`, so
         * without this it returned while such a write was still travelling —
         * and every caller that treats `flushAll()` as "nothing of mine is
         * still in flight" (the character-switch drain in `data-manager.js`,
         * the handoff and on-switch sync pushes, `beginRestore`) was told a
         * lie. `flushAll` awaits these first, which also brings a failure's
         * requeue back into the queue in time to be part of the same flush.
         */
        this._inFlightWrites = new Set();
        this.SAVE_DEBOUNCE_DELAY = 3000; // 3 seconds

        /**
         * Restore quiescing — see `beginRestore()`/`finishRestore()`.
         *
         * A restore (a manual "Restore Backup", or a sync pull) replaces whole
         * keys under a running page. Everything above this module is still
         * holding pre-restore values: a debounce timer that has not fired, a
         * write requeued after a failure, an in-memory array a recorder will
         * merge onto and write back. Any of those landing after the restore
         * silently undoes it, which is what these two counters exist to stop.
         */
        this._restoreGeneration = 0;
        /**
         * True from `beginRestore()` until `endRestore()`. A debounce timer
         * that fires inside this window would land its pre-restore value on a
         * store the restore has already rewritten but not yet latched — the
         * latch (`finishRestore`) only goes up after every store is written —
         * so firing timers hold their entry queued instead of writing, and
         * `endRestore()` flushes whatever survived the latch.
         */
        this._restoreInProgress = false;
        /** Store names whose writes are refused until the page reloads */
        this._restorePendingStores = new Set();
        /** Keys already warned about under the latch, so the console is not flooded */
        this._restoreWarned = new Set();
        this._reconnecting = false; // Guard against concurrent reconnection attempts
        this._dbNulledReason = null; // Track why db was last set to null
        this._lastReconnectFailureAt = 0; // When a reconnect last gave up, so waits do not pile up

        /**
         * Whether a write has failed for want of space.
         *
         * The failure mode this exists to end is silent: a recorder appends to
         * an array, hands it to `set()`, the transaction aborts on quota, and
         * the feature goes on believing it is recording. Recorders read this
         * and stand down instead — see `isQuotaExceeded()`.
         */
        this.quotaExceeded = false;
        this._quotaExceededAt = null;
        this._quotaFailures = 0;
        this._lastQuotaTarget = null; // {key, storeName} of the write that failed
        this._quotaListeners = new Set();
        this._lastEstimate = null; // Cached navigator.storage.estimate() result

        /**
         * Resolves once `initialize` has run, either way.
         *
         * Anything reading at module scope needs this. Features are initialized
         * long after the libraries load, so a module-scope read lands before the
         * database is open, gets the default back, and has no way to know the
         * difference between "not stored" and "not asked yet" — which is how
         * every remembered panel quietly forgot itself.
         */
        this.ready = new Promise((resolve) => {
            this._markReady = resolve;
        });
    }

    /**
     * Initialize the storage system
     * @returns {Promise<boolean>} Success status
     */
    async initialize() {
        try {
            await this.openDatabase();
            this.available = true;
            this._markReady(true);
            return true;
        } catch (error) {
            console.error('[Storage] Initialization failed:', error);
            this.available = false;
            this._markReady(false);
            return false;
        }
    }

    /**
     * Open IndexedDB database
     * @returns {Promise<void>}
     */
    openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                // A VersionError means another script sharing this database
                // (the upstream Toolasha) has already upgraded it past our
                // version. Our stores are a subset of its, so the data is all
                // still there — reopen at whatever version the database is at
                // rather than going dark with every read returning defaults.
                if (request.error?.name === 'VersionError') {
                    console.warn(
                        '[Storage] ToolashaDB is at a newer version than this script expects — ' +
                            'another Toolasha install has upgraded it. Reopening at the current version.'
                    );
                    const reopen = indexedDB.open(this.dbName);
                    reopen.onerror = () => {
                        console.error('[Storage] Failed to reopen IndexedDB at its current version', reopen.error);
                        reject(reopen.error);
                    };
                    reopen.onsuccess = () => {
                        this.db = reopen.result;
                        this._dbNulledReason = null;
                        this._setupDbEventHandlers();
                        resolve();
                    };
                    return;
                }
                console.error('[Storage] Failed to open IndexedDB', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                this._dbNulledReason = null;
                this._setupDbEventHandlers();
                resolve();
            };

            request.onblocked = () => {
                console.warn('[Storage] IndexedDB open blocked by existing connection — retrying after close');
                this._dbNulledReason = 'onblocked';
                // Attempt to close any stale connection and retry once
                if (this.db) {
                    this.db.close();
                    this.db = null;
                }
                const retry = indexedDB.open(this.dbName, this.dbVersion);
                retry.onerror = () => {
                    console.error('[Storage] Retry failed to open IndexedDB', retry.error);
                    reject(retry.error);
                };
                retry.onsuccess = () => {
                    this.db = retry.result;
                    this._dbNulledReason = null;
                    this._setupDbEventHandlers();
                    resolve();
                };
                retry.onupgradeneeded = request.onupgradeneeded;
                retry.onblocked = () => {
                    console.error('[Storage] IndexedDB still blocked after retry — DB unavailable');
                    reject(new Error('IndexedDB blocked'));
                };
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create settings store if it doesn't exist
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings');
                }

                // Create rerollSpending store if it doesn't exist (for task reroll tracker)
                if (!db.objectStoreNames.contains('rerollSpending')) {
                    db.createObjectStore('rerollSpending');
                }

                // Create dungeonRuns store if it doesn't exist (for dungeon tracker)
                if (!db.objectStoreNames.contains('dungeonRuns')) {
                    db.createObjectStore('dungeonRuns');
                }

                // Create teamRuns store if it doesn't exist (for team-based backfill)
                if (!db.objectStoreNames.contains('teamRuns')) {
                    db.createObjectStore('teamRuns');
                }

                // Create combatExport store if it doesn't exist (for combat sim/milkonomy exports)
                if (!db.objectStoreNames.contains('combatExport')) {
                    db.createObjectStore('combatExport');
                }

                // Create unifiedRuns store if it doesn't exist (for dungeon tracker unified storage)
                if (!db.objectStoreNames.contains('unifiedRuns')) {
                    db.createObjectStore('unifiedRuns');
                }

                // Create marketListings store if it doesn't exist (for estimated listing ages)
                if (!db.objectStoreNames.contains('marketListings')) {
                    db.createObjectStore('marketListings');
                }

                // Create combatStats store if it doesn't exist (for combat statistics feature)
                if (!db.objectStoreNames.contains('combatStats')) {
                    db.createObjectStore('combatStats');
                }

                // Create xpHistory store if it doesn't exist (for XP/hr tracker)
                if (!db.objectStoreNames.contains('xpHistory')) {
                    db.createObjectStore('xpHistory');
                }

                // Create alchemyHistory store if it doesn't exist (for transmute history tracker)
                if (!db.objectStoreNames.contains('alchemyHistory')) {
                    db.createObjectStore('alchemyHistory');
                }

                // Create labyrinth store if it doesn't exist (for labyrinth tracker)
                if (!db.objectStoreNames.contains('labyrinth')) {
                    db.createObjectStore('labyrinth');
                }

                // Create guildHistory store if it doesn't exist (for guild XP tracker)
                if (!db.objectStoreNames.contains('guildHistory')) {
                    db.createObjectStore('guildHistory');
                }

                // Create networthHistory store if it doesn't exist (for networth chart)
                if (!db.objectStoreNames.contains('networthHistory')) {
                    db.createObjectStore('networthHistory');
                }

                // Create collections store if it doesn't exist (for collection filters feature)
                if (!db.objectStoreNames.contains('collections')) {
                    db.createObjectStore('collections');
                }

                // Create queueSnapshots store if it doesn't exist (for cross-character queue monitor)
                if (!db.objectStoreNames.contains('queueSnapshots')) {
                    db.createObjectStore('queueSnapshots');
                }

                // Create lootLogHistory store if it doesn't exist (for extended loot log)
                if (!db.objectStoreNames.contains('lootLogHistory')) {
                    db.createObjectStore('lootLogHistory');
                }

                // Create leaderboardHistory store if it doesn't exist (for leaderboard XP tracker)
                if (!db.objectStoreNames.contains('leaderboardHistory')) {
                    db.createObjectStore('leaderboardHistory');
                }

                // The upstream script's v18-v20 stores, created here too even
                // though this fork does not use them (yet): the database is
                // shared, and matching its version without matching its
                // stores would leave upstream failing on every transaction
                // it opens against a store that should exist at v20.
                for (const shared of ['actionProgress', 'characterActivityStatus', 'openableAnalytics']) {
                    if (!db.objectStoreNames.contains(shared)) {
                        db.createObjectStore(shared);
                    }
                }
            };
        });
    }

    /**
     * Get a value from storage
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {Promise<*>} The stored value or default
     */
    async get(key, storeName = 'settings', defaultValue = null) {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, returning default for key: ${key}`);
            return defaultValue;
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    resolve(request.result != null ? request.result : defaultValue);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to get key ${key}:`, request.error);
                    resolve(defaultValue);
                };

                // A transaction that aborts (version change, quota, the tab
                // being frozen) can take the request's own events with it;
                // without this the promise never settles and every awaiting
                // caller hangs for the life of the page
                transaction.onabort = () => {
                    console.warn(`[Storage] Get transaction aborted for key ${key}:`, transaction.error);
                    resolve(defaultValue);
                };
            } catch (error) {
                console.error(`[Storage] Get transaction failed for key ${key}:`, error);
                resolve(defaultValue);
            }
        });
    }

    /**
     * Read several keys from one store in a single readonly transaction.
     *
     * A feature that needs a handful of its own records at startup used to
     * await them one after another, paying a round trip apiece; here every
     * get is issued on the same transaction and the result arrives together.
     * Semantics per key match `get` with a null default: a key that is absent,
     * stored as null, or could not be read maps to null.
     * @param {Array<string>} keys - Storage keys
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<Map<string, *>>} key → value, null where there was nothing to read
     */
    async getMany(keys, storeName = 'settings') {
        const result = new Map();
        for (const key of keys) result.set(key, null);
        if (keys.length === 0) return result;

        if (!this.db && !(await this._awaitConnection())) {
            console.warn(
                `[Storage] Database not available, returning defaults for ${keys.length} keys in ${storeName}`
            );
            return result;
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                let remaining = keys.length;
                const settleOne = () => {
                    remaining -= 1;
                    if (remaining === 0) resolve(result);
                };
                // An aborted transaction may leave some requests without an
                // event of their own; whatever was read by then is the answer
                transaction.onabort = () => resolve(result);
                transaction.onerror = () => resolve(result);

                for (const key of keys) {
                    const request = store.get(key);
                    request.onsuccess = () => {
                        if (request.result != null) result.set(key, request.result);
                        settleOne();
                    };
                    request.onerror = () => {
                        console.error(`[Storage] Failed to get key ${key}:`, request.error);
                        settleOne();
                    };
                }
            } catch (error) {
                console.error(`[Storage] getMany transaction failed for ${storeName}:`, error);
                resolve(result);
            }
        });
    }

    /**
     * Read a key and say whether the read itself worked.
     *
     * `get` folds "the key is absent" and "the database could not be read"
     * into one default value, which is the right shape for a setting and the
     * wrong shape for a history: a writer that takes a failed read for an empty
     * record and writes it back has just erased the record. This returns
     * `null` when the read could not be trusted — database unavailable, a
     * transaction that failed — so a read-merge-write caller can decline to
     * write rather than write blind.
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<{found: boolean, value: *}|null>} The read, or null when it could not be made
     */
    async tryGet(key, storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot read key: ${key}`);
            return null;
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);

                request.onsuccess = () => {
                    const value = request.result;
                    resolve(value != null ? { found: true, value } : { found: false, value: null });
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to read key ${key}:`, request.error);
                    resolve(null);
                };

                // An abort is exactly the "could not be trusted" case this
                // method exists to report, and it must not hang instead
                transaction.onabort = () => {
                    console.warn(`[Storage] Read transaction aborted for key ${key}:`, transaction.error);
                    resolve(null);
                };
            } catch (error) {
                console.error(`[Storage] Read transaction failed for key ${key}:`, error);
                resolve(null);
            }
        });
    }

    /**
     * Set a value in storage (debounced by default)
     * @param {string} key - Storage key
     * @param {*} value - Value to store
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {boolean} immediate - If true, save immediately without debouncing
     * @returns {Promise<boolean>} Success status
     */
    async set(key, value, storeName = 'settings', immediate = false) {
        if (this._refuseDuringRestore(key, storeName, 'save')) return false;

        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot save key: ${key}`);
            return false;
        }

        if (immediate) {
            return this._writeNow(key, value, storeName);
        } else {
            return this._debouncedSave(key, value, storeName);
        }
    }

    /**
     * An immediate write, superseding whatever the debounce queue holds for the key.
     *
     * Without the supersede, `set(key, v, store, true)` went straight to IndexedDB
     * and left an older value still armed on a 3 s timer for the same key — which
     * then landed on top of it. "Immediate" is not only about when the write
     * happens; it is a claim to be the current value of the key, and a queued
     * write to that key predates it by definition.
     * @param {string} key - Storage key
     * @param {*} value - Value to store
     * @param {string} storeName - Object store name
     * @returns {Promise<boolean>} Success status
     * @private
     */
    async _writeNow(key, value, storeName) {
        const superseded = this._supersedePending(`${storeName}:${key}`);
        const success = await this._saveToIndexedDB(key, value, storeName);
        // The coalesced callers were awaiting a write to this key; this is it.
        for (const resolve of superseded?.resolvers || []) resolve(success);
        return success;
    }

    /**
     * Drop the debounced write outstanding for a key, and hand back what was dropped.
     *
     * Used by the two paths that state a key's value outright — an immediate `set`
     * and a `delete`. Both are the newest word on the key, so a queued older value
     * must not survive them.
     *
     * The generation bump covers the narrower case a cancelled timer cannot: a timer
     * that has already fired and is awaiting its own transaction has taken its entry
     * out of the queue, so there is nothing here to cancel. It cannot be stopped, but
     * its transaction was opened before ours and so commits before ours; the bump is
     * what stops its *failure* path from requeueing the stale value behind us.
     * @param {string} timerKey - `${storeName}:${key}`
     * @returns {{value: *, storeName: string, resolvers: Array<Function>, generation: number}|null}
     *   The cancelled entry, or null when nothing was queued
     * @private
     */
    _supersedePending(timerKey) {
        const timer = this.saveDebounceTimers.get(timerKey);
        if (timer) clearTimeout(timer);
        this.saveDebounceTimers.delete(timerKey);

        const pending = this.pendingWrites.get(timerKey);
        const generation = this._writeGeneration.get(timerKey);
        if (generation !== undefined) this._writeGeneration.set(timerKey, generation + 1);
        if (!pending) return null;

        this.pendingWrites.delete(timerKey);
        this._flushFailures.delete(timerKey);
        return pending;
    }

    /**
     * Internal: Save to IndexedDB (immediate)
     * @private
     */
    async _saveToIndexedDB(key, value, storeName) {
        // The debounced flush reaches here without `set`'s guard; a write that
        // lands in a reconnect gap waits it out the same way (a refused
        // debounced write is requeued by the caller, so this only shortens the
        // retry) — and `this.db` is then read inside the promise, not before
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot save key: ${key}`);
            return false;
        }
        return new Promise((resolve, _reject) => {
            let settled = false;
            /**
             * Resolve once, whichever of request/transaction reports first.
             * A quota failure fires both `request.onerror` and the transaction's
             * abort, and a promise that resolves twice hides the second one.
             * @param {boolean} success - Whether the write landed
             * @param {*} error - The error to classify, if it did not
             */
            const settle = (success, error) => {
                if (settled) return;
                settled = true;
                if (!success && this._isQuotaError(error)) {
                    this._handleQuotaExceeded(key, storeName, error);
                }
                resolve(success);
            };

            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.put(value, key);

                request.onsuccess = () => {
                    settle(true, null);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to save key ${key}:`, request.error);
                    settle(false, request.error);
                };

                // A quota failure aborts the whole transaction; without this the
                // only signal is a request error the browser may not deliver
                transaction.onabort = () => {
                    console.error(`[Storage] Save transaction aborted for key ${key}:`, transaction.error);
                    settle(false, transaction.error);
                };
            } catch (error) {
                console.error(`[Storage] Save transaction failed for key ${key}:`, error);
                settle(false, error);
            }
        });
    }

    /**
     * Whether an error is the browser saying "no room".
     *
     * Chromium throws `QuotaExceededError`, Firefox has historically used
     * `NS_ERROR_DOM_QUOTA_REACHED`, and legacy DOMException code 22 covers the
     * rest — all three mean the same thing to everything upstream of here.
     * @param {*} error - Error from a failed request or transaction
     * @returns {boolean} True when the failure was a space failure
     * @private
     */
    _isQuotaError(error) {
        if (!error) return false;
        const name = error.name || '';
        if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (error.code === 22) return true;
        return /quota|storage is full|not enough space/i.test(error.message || '');
    }

    /**
     * Record that storage is full and tell anyone who asked to be told.
     * @param {string} key - The key whose write failed
     * @param {string} storeName - The store it was going to
     * @param {*} error - The originating error
     * @private
     */
    _handleQuotaExceeded(key, storeName, error) {
        this._quotaFailures += 1;
        this._lastQuotaTarget = { key, storeName };
        const firstTime = !this.quotaExceeded;
        this.quotaExceeded = true;
        this._quotaExceededAt = Date.now();

        console.error(`[Storage] Quota exceeded writing ${storeName}:${key} — recording will stand down:`, error);

        // Refresh the numbers so whatever shows this can say how full "full" is
        this.estimate();

        if (!firstTime) return;
        for (const listener of this._quotaListeners) {
            try {
                listener({ key, storeName, at: this._quotaExceededAt, estimate: this._lastEstimate });
            } catch (listenerError) {
                console.error('[Storage] Quota listener failed:', listenerError);
            }
        }
    }

    /**
     * Whether writes are currently failing for want of space.
     *
     * Recorders of bulky history — loot log, networth snapshots, enhancement
     * sessions — check this before building a payload and skip the work when it
     * is true, so a full disk costs one failed write rather than one per event.
     * @returns {boolean} True while storage is known to be full
     */
    isQuotaExceeded() {
        return this.quotaExceeded;
    }

    /**
     * Be told, once, the first time a write fails for space.
     * @param {Function} listener - Called with {key, storeName, at, estimate}
     * @returns {Function} Unsubscribe
     */
    onQuotaExceeded(listener) {
        if (typeof listener !== 'function') return () => {};
        this._quotaListeners.add(listener);
        return () => this._quotaListeners.delete(listener);
    }

    /**
     * Forget that storage was full, so recorders resume.
     *
     * Called automatically after a successful delete, since deleting is the one
     * thing that makes the original failure untrue.
     */
    clearQuotaState() {
        this.quotaExceeded = false;
        this._lastQuotaTarget = null;
    }

    /**
     * How much of the origin's storage is used, per the browser.
     *
     * `navigator.storage.estimate()` is an estimate in the literal sense —
     * padded, and quota is what the browser is willing to give rather than what
     * is free on disk. Good enough to tell "comfortable" from "about to fail",
     * which is the only distinction anything here draws.
     * @returns {Promise<{usage: number|null, quota: number|null, percent: number|null, at: number}|null>}
     *   The estimate, or null where the API is unavailable
     */
    async estimate() {
        try {
            if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
            const { usage, quota } = await navigator.storage.estimate();
            this._lastEstimate = {
                usage: usage ?? null,
                quota: quota ?? null,
                percent: usage != null && quota ? (usage / quota) * 100 : null,
                at: Date.now(),
            };
            return this._lastEstimate;
        } catch (error) {
            console.error('[Storage] Storage estimate failed:', error);
            return null;
        }
    }

    /**
     * The last estimate taken, without taking another.
     * @returns {Object|null} Cached estimate, or null if none has been taken
     */
    lastEstimate() {
        return this._lastEstimate;
    }

    /**
     * Key counts per store, against their soft budgets.
     *
     * Counting keys is one `getAllKeys()` per store and never touches a value,
     * which is why this is affordable at all — a byte-accurate size would mean
     * reading and serializing the entire database.
     * @param {Array<string>} [storeNames] - Restrict to these stores; defaults to all
     * @returns {Promise<Array<{storeName: string, keys: number, budget: number|null, over: boolean}>>}
     *   One row per store, over-budget rows first
     */
    async budgetReport(storeNames) {
        const names = storeNames ?? (await this.listStores());
        const rows = [];

        for (const storeName of names) {
            const keys = await this.getAllKeys(storeName);
            const budget = STORE_KEY_BUDGETS[storeName] ?? null;
            rows.push({
                storeName,
                keys: keys.length,
                budget,
                over: budget !== null && keys.length > budget,
            });
        }

        rows.sort((a, b) => Number(b.over) - Number(a.over) || b.keys - a.keys);
        return rows;
    }

    /**
     * Internal: Debounced save
     *
     * The entry is removed from pendingWrites only after a confirmed success, and
     * only if no newer write has claimed the slot in the meantime. A failed write —
     * a dropped connection, an aborted transaction, a full disk — requeues the value
     * without a timer, so the next flushAll() or the next write to the same key
     * retries it instead of the value being lost.
     * @private
     */
    _debouncedSave(key, value, storeName) {
        const timerKey = `${storeName}:${key}`;

        // The restore generation this write was scheduled under. A restore that
        // lands before the timer fires makes this value pre-restore state, and
        // writing it would put the old copy back over the restored one.
        const restoreGeneration = this._restoreGeneration;

        const existing = this.pendingWrites.get(timerKey);
        const resolvers = existing?.resolvers || [];

        const generation = (this._writeGeneration.get(timerKey) || 0) + 1;
        this._writeGeneration.set(timerKey, generation);
        this.pendingWrites.set(timerKey, { value, storeName, resolvers, generation });

        if (this.saveDebounceTimers.has(timerKey)) {
            clearTimeout(this.saveDebounceTimers.get(timerKey));
        }

        return new Promise((resolve) => {
            resolvers.push(resolve);

            const timer = setTimeout(async () => {
                this.saveDebounceTimers.delete(timerKey);

                const pending = this.pendingWrites.get(timerKey);
                if (!pending || pending.generation !== generation) {
                    // A newer write owns this slot — its timer persists the value and
                    // resolves every caller coalesced into it, including ours.
                    return;
                }

                if (this._restoreInProgress) {
                    // A restore is writing stores right now, and the latch that
                    // would sort this write's store into "restored, refuse" or
                    // "untouched, fine" is not up yet. Writing would race the
                    // restore's own transaction; dropping would lose a write to
                    // a store the restore never touches. So the entry stays
                    // queued with no timer: `finishRestore` drops it if its
                    // store was restored, `endRestore` flushes it if not.
                    return;
                }

                if (this._restoreGeneration !== restoreGeneration) {
                    // A restore replaced this key while the timer was running.
                    // Standing down is the whole point: the value in hand is the
                    // pre-restore one, and the callers were told to reload.
                    console.warn(
                        `[Storage] Dropping a debounced write to ${storeName}/${key} — it predates a restore. ` +
                            'Reload the page; changes made before reloading are not kept.'
                    );
                    this.pendingWrites.delete(timerKey);
                    this._writeGeneration.delete(timerKey);
                    this._flushFailures.delete(timerKey);
                    for (const r of pending.resolvers) r(false);
                    return;
                }

                // Take ownership: remove from the queue before attempting the save so a
                // concurrent newer write can claim the slot cleanly.
                this.pendingWrites.delete(timerKey);

                // Tracked from here until it settles: between the delete above
                // and the await below this write exists nowhere a `flushAll()`
                // can see it (see `_inFlightWrites`).
                const inFlight = this._saveToIndexedDB(key, pending.value, pending.storeName);
                this._inFlightWrites.add(inFlight);
                let success;
                try {
                    success = await inFlight;
                } finally {
                    this._inFlightWrites.delete(inFlight);
                }

                if (!success) {
                    // A restore landed while this transaction was in flight, so
                    // the value in hand is pre-restore state. `finishRestore`
                    // purged the queue, but this entry was not in it to purge —
                    // it had already been taken out for the write. Requeueing
                    // now would put it back *behind* the latch, where
                    // `endRestore`'s own flush writes it straight over the
                    // restore, which is the one thing the latch exists to stop.
                    // Same reasoning as the pre-write check above; this is the
                    // other side of the same await.
                    if (this._restoreGeneration !== restoreGeneration || this._restorePendingStores.has(storeName)) {
                        console.warn(
                            `[Storage] Dropping a failed write to ${storeName}/${key} — it predates a restore. ` +
                                'Reload the page; changes made before reloading are not kept.'
                        );
                        this._writeGeneration.delete(timerKey);
                        this._flushFailures.delete(timerKey);
                        for (const r of pending.resolvers) r(false);
                        return;
                    }

                    // `_writeGeneration` still naming this write is what says nothing
                    // newer has spoken for the key. An immediate set or a delete that
                    // landed while this transaction was in flight bumps it, and
                    // requeueing behind one of those would put the stale value back.
                    const stillCurrent = this._writeGeneration.get(timerKey) === pending.generation;
                    if (stillCurrent && !this.pendingWrites.has(timerKey)) {
                        // Requeue without a timer so the value survives for the next
                        // flushAll() or the next debounced write to this key. This is also
                        // what makes a quota failure recoverable: once space is freed, the
                        // retry writes the value that would otherwise have been dropped.
                        //
                        // The requeued entry carries no resolvers: two dozen callers await
                        // storage.set(), and holding their promises open until some later
                        // flush would hang them for the rest of the session. They are told
                        // the write failed now; the value is retried regardless.
                        this.pendingWrites.set(timerKey, {
                            value: pending.value,
                            storeName: pending.storeName,
                            resolvers: [],
                            generation: pending.generation,
                        });
                    }

                    for (const r of pending.resolvers) {
                        r(false);
                    }
                    return;
                }

                // The generation counter only exists to tell a stale timer from
                // the live one; once the write has landed and nobody newer has
                // claimed the slot, the entry is dead weight. Left in place it
                // grows one entry per distinct key written for the life of the
                // page — history chunks and per-character records make that
                // unbounded. Dropping it restarts the counter at 1 for that
                // key, which is safe precisely because no timer is outstanding.
                if (this._writeGeneration.get(timerKey) === generation && !this.saveDebounceTimers.has(timerKey)) {
                    this._writeGeneration.delete(timerKey);
                }

                // The failure counter counts *consecutive* failures. Left standing
                // after a success, one transient early-session failure means the
                // next single failure hours later hits the cap and drops the value.
                this._flushFailures.delete(timerKey);

                for (const r of pending.resolvers) {
                    r(true);
                }
            }, this.SAVE_DEBOUNCE_DELAY);

            this.saveDebounceTimers.set(timerKey, timer);
        });
    }

    /**
     * Get a JSON object from storage
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {Promise<*>} The parsed object or default
     */
    async getJSON(key, storeName = 'settings', defaultValue = null) {
        const raw = await this.get(key, storeName, null);
        return this.parseJSON(raw, key, defaultValue);
    }

    /**
     * Parse a raw value already in hand — no storage round trip — the way
     * `getJSON` parses one it just read.
     *
     * Split out so a caller that already has the raw value (e.g. from
     * `tryGet`, which reads it anyway to tell "absent" from "could not be
     * read") does not have to pay a second IndexedDB transaction for the
     * same key just to get it JSON-parsed.
     * @param {*} raw - The value as read from a store (or `null`)
     * @param {string} key - Storage key, for error logging only
     * @param {*} defaultValue - Default value if `raw` is `null`
     * @returns {*} The parsed object or default
     */
    parseJSON(raw, key, defaultValue = null) {
        if (raw === null) {
            return defaultValue;
        }

        // If it's already an object, return it
        if (typeof raw === 'object') {
            return raw;
        }

        // Otherwise, try to parse as JSON string
        try {
            return JSON.parse(raw);
        } catch (error) {
            console.error(`[Storage] Error parsing JSON from storage (key: ${key}):`, error);
            return defaultValue;
        }
    }

    /**
     * Set a JSON object in storage
     * @param {string} key - Storage key
     * @param {*} value - Object to store
     * @param {string} storeName - Object store name (default: 'settings')
     * @param {boolean} immediate - If true, save immediately
     * @returns {Promise<boolean>} Success status
     */
    async setJSON(key, value, storeName = 'settings', immediate = false) {
        // IndexedDB can store objects directly, no need to stringify
        return this.set(key, value, storeName, immediate);
    }

    /**
     * Delete a key from storage
     * @param {string} key - Storage key to delete
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<boolean>} Success status
     */
    async delete(key, storeName = 'settings') {
        // A restored store must not lose keys to a pre-restore prune either —
        // a rolling window that dropped its oldest chunk from *memory* would
        // otherwise delete the chunk the restore just put back
        if (this._refuseDuringRestore(key, storeName, 'delete')) return false;

        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot delete key: ${key}`);
            return false;
        }

        // A queued debounced write to this key predates the delete, and used to
        // land three seconds after it — so a prune, or a "clear this character's
        // record", quietly undid itself. Its callers are told the write did not
        // happen, which is true: the key is being removed instead.
        const superseded = this._supersedePending(`${storeName}:${key}`);
        for (const resolve of superseded?.resolvers || []) resolve(false);

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.delete(key);

                request.onsuccess = () => {
                    // Deleting is the one operation that makes "storage is full"
                    // untrue, so it is where standing-down recorders are let up
                    this.clearQuotaState();
                    resolve(true);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to delete key ${key}:`, request.error);
                    resolve(false);
                };

                transaction.onabort = () => {
                    console.warn(`[Storage] Delete transaction aborted for key ${key}:`, transaction.error);
                    resolve(false);
                };
            } catch (error) {
                console.error(`[Storage] Delete transaction failed for key ${key}:`, error);
                resolve(false);
            }
        });
    }

    /**
     * Check if a key exists in storage
     * @param {string} key - Storage key to check
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<boolean>} True if key exists
     */
    async has(key, storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            return false;
        }

        const value = await this.get(key, storeName, '__STORAGE_CHECK__');
        return value !== '__STORAGE_CHECK__';
    }

    /**
     * Get all keys from a store
     * @param {string} storeName - Object store name (default: 'settings')
     * @returns {Promise<Array<string>>} Array of keys
     */
    async getAllKeys(storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot get keys from store: ${storeName}`);
            return [];
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAllKeys();

                request.onsuccess = () => {
                    resolve(request.result || []);
                };

                request.onerror = () => {
                    console.error(`[Storage] Failed to get all keys from ${storeName}:`, request.error);
                    resolve([]);
                };

                transaction.onabort = () => {
                    console.warn(`[Storage] GetAllKeys transaction aborted for ${storeName}:`, transaction.error);
                    resolve([]);
                };
            } catch (error) {
                console.error(`[Storage] GetAllKeys transaction failed for store ${storeName}:`, error);
                resolve([]);
            }
        });
    }

    /**
     * Get all key-value pairs from an object store
     * @param {string} storeName - Object store name
     * @returns {Promise<Object>} Map of key → value
     */
    async getAll(storeName = 'settings') {
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot get all from store: ${storeName}`);
            return {};
        }

        return new Promise((resolve, _reject) => {
            try {
                const transaction = this.db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const result = {};
                const cursorRequest = store.openCursor();

                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        result[cursor.key] = cursor.value;
                        cursor.continue();
                    } else {
                        resolve(result);
                    }
                };

                cursorRequest.onerror = () => {
                    console.error(`[Storage] Failed to get all from ${storeName}:`, cursorRequest.error);
                    resolve({});
                };

                // A cursor walk aborted part way has read whatever it read;
                // hand that back rather than leaving the caller waiting
                transaction.onabort = () => {
                    console.warn(`[Storage] GetAll transaction aborted for ${storeName}:`, transaction.error);
                    resolve(result);
                };
            } catch (error) {
                console.error(`[Storage] GetAll transaction failed for store ${storeName}:`, error);
                resolve({});
            }
        });
    }

    /**
     * List every object store name currently defined in the database.
     * @returns {Promise<Array<string>>} Array of store names
     */
    async listStores() {
        if (!this.db) {
            console.warn('[Storage] Database not available, cannot list stores');
            return [];
        }

        return Array.from(this.db.objectStoreNames);
    }

    /**
     * Write multiple key/value pairs to a store in a single immediate transaction.
     *
     * Bypasses debouncing entirely. Debounced `set()` schedules one timer per key,
     * so writing hundreds of keys serially through it would mean hundreds of pending
     * timers (or hundreds of sequential `immediate` writes). This does it in one
     * readwrite transaction instead — use it for bulk operations like restore/import.
     *
     * Latched by `finishRestore` like `set` and `delete`, and for the same
     * reason: the recorders that keep a store's contents in memory —
     * `chunked-history`, `trade-ledger-store`, `networth-history` — all flush
     * through here, so a blanket exemption let exactly the writer the latch
     * names put its pre-restore array back on top of the restore. The restore
     * itself and the sync bookkeeping that records it are the two writers that
     * genuinely are not pre-restore state, and they say so with
     * `bypassRestoreLatch`.
     * @param {string} storeName - Object store name
     * @param {Record<string, *>} entries - Map of key → value to write
     * @param {{bypassRestoreLatch?: boolean}} [options] - `bypassRestoreLatch` for the
     *   restore itself and its bookkeeping, which are what the latch is protecting
     * @returns {Promise<number>} Number of entries successfully written
     */
    async putAll(storeName, entries, options = {}) {
        if (!options.bypassRestoreLatch && this._restorePendingStores.has(storeName)) {
            // One line per store, not per key: a recorder flushing a year of
            // chunks would otherwise fill the console with the same sentence
            if (this._refuseDuringRestore('(bulk write)', storeName, 'save')) return 0;
        }
        const written = await this._putAllWritten(storeName, entries);
        return written.length;
    }

    /**
     * Internal: the body of `putAll`, reporting *which* keys landed.
     *
     * `flushAll` needs per-key outcomes so it can resolve each caller's promise
     * and requeue only what failed, which a count cannot tell it.
     * @param {string} storeName - Object store name
     * @param {Record<string, *>} entries - Map of key → value to write
     * @returns {Promise<Array<string>>} The keys that were written
     * @private
     */
    async _putAllWritten(storeName, entries) {
        // Every other write path waits out a reconnect gap; this one used not to,
        // so a ~500ms dropped connection turned a whole store's restore into a
        // silent no-op that still reported "restored".
        if (!this.db && !(await this._awaitConnection())) {
            console.warn(`[Storage] Database not available, cannot bulk write to store: ${storeName}`);
            return [];
        }

        const keys = Object.keys(entries || {});
        if (keys.length === 0) {
            return [];
        }

        return new Promise((resolve) => {
            try {
                const transaction = this.db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const written = [];

                for (const key of keys) {
                    const request = store.put(entries[key], key);
                    request.onsuccess = () => {
                        written.push(key);
                    };
                    request.onerror = () => {
                        console.error(`[Storage] Failed to bulk-write key ${key} to ${storeName}:`, request.error);
                        if (this._isQuotaError(request.error)) {
                            this._handleQuotaExceeded(key, storeName, request.error);
                        }
                    };
                }

                transaction.oncomplete = () => {
                    resolve(written);
                };
                // A quota abort fires `abort` and never `complete` or `error`;
                // without this the promise never settles and every awaiting
                // caller hangs for the life of the page
                transaction.onabort = () => {
                    console.warn(`[Storage] Bulk write transaction aborted for store ${storeName}:`, transaction.error);
                    if (this._isQuotaError(transaction.error)) {
                        this._handleQuotaExceeded(keys[0], storeName, transaction.error);
                    }
                    // Per-request `onsuccess` fires before commit, so `written` lists keys
                    // an abort has since rolled back. Reporting them as written would let
                    // flushAll drop them from pendingWrites and tell callers they landed.
                    resolve([]);
                };
                transaction.onerror = () => {
                    console.error(`[Storage] Bulk write transaction failed for store ${storeName}:`, transaction.error);
                    if (this._isQuotaError(transaction.error)) {
                        this._handleQuotaExceeded(keys[0], storeName, transaction.error);
                    }
                    resolve([]);
                };
            } catch (error) {
                console.error(`[Storage] Bulk write transaction failed for store ${storeName}:`, error);
                resolve([]);
            }
        });
    }

    /**
     * Force immediate save of all pending debounced writes.
     *
     * Called from `beforeunload`/`pagehide`, where the page may be torn down at
     * any moment: one transaction per pending key, awaited in turn, is the shape
     * most likely to be cut off half way. Instead every pending key is grouped by
     * store into a single `putAll` transaction, and the stores are issued
     * together rather than awaited one after another, so the whole flush is a
     * handful of transactions started in the same tick.
     */
    async flushAll() {
        // Clear all timers first
        for (const timer of this.saveDebounceTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.saveDebounceTimers.clear();

        // Then wait out the writes a timer already started. Their entries are
        // out of `pendingWrites` for the duration, so the snapshot below cannot
        // see them and this method would otherwise report "everything is
        // written" while they were still travelling — the guarantee the
        // character-switch drain, the handoff push and `beginRestore` all rest
        // on. Settled rather than resolved: a failure requeues its value, and
        // the requeue must be in the map before the snapshot is taken so this
        // same flush retries it. That ordering holds because the timer's own
        // `await` on the same promise was registered first and its continuation
        // runs to the requeue without another await, so it is ahead of this one
        // in the microtask queue.
        if (this._inFlightWrites.size > 0) {
            await Promise.allSettled(Array.from(this._inFlightWrites));
        }

        // Snapshot the pending writes rather than clearing the map upfront: an entry is
        // only removed once its write is confirmed, so a failure here leaves the value
        // queued for the next flush instead of discarding it.
        const writes = Array.from(this.pendingWrites.entries());
        if (writes.length === 0) return;

        /** @type {Map<string, Array<{timerKey: string, key: string, pending: object}>>} */
        const byStore = new Map();
        for (const [timerKey, pending] of writes) {
            // Skip if a newer write has already replaced this entry.
            if (this.pendingWrites.get(timerKey) !== pending) continue;

            const key = timerKey.substring(timerKey.indexOf(':') + 1);
            const bucket = byStore.get(pending.storeName);
            if (bucket) bucket.push({ timerKey, key, pending });
            else byStore.set(pending.storeName, [{ timerKey, key, pending }]);
        }

        const flushes = [];
        for (const [storeName, items] of byStore) {
            const entries = {};
            for (const item of items) entries[item.key] = item.pending.value;

            // Deliberately not awaited inside the loop: every store's
            // transaction is opened in this tick, and they run concurrently.
            flushes.push(
                (async () => {
                    let writtenKeys;
                    try {
                        writtenKeys = new Set(await this._putAllWritten(storeName, entries));
                    } catch (error) {
                        console.error(`[Storage] Flush of store ${storeName} failed:`, error);
                        writtenKeys = new Set();
                    }

                    // One key the store refuses — an un-cloneable value, or the key whose
                    // size tipped the quota — aborts the whole transaction and takes every
                    // healthy key in the same store down with it. Retry whatever the bulk
                    // write did not cover one key at a time, so the poison is isolated and
                    // its neighbours drain. (The bulk transaction still reports nothing
                    // written on abort; this is a second pass, not a reinterpretation.)
                    //
                    // Each retry is its own one-key transaction through the same
                    // `_putAllWritten`, not `_saveToIndexedDB`: that path settles on
                    // whichever of request-success and abort arrives first, and a request
                    // succeeds before the commit that then rolls it back — so it would
                    // call an aborted key written.
                    // A key another write has claimed since the snapshot is not
                    // retried. The bulk transaction is opened in the same tick
                    // the values are snapshotted, so nothing can overtake it —
                    // but this second pass opens a *new* transaction after that
                    // one has finished, and an immediate `set` or a `delete` in
                    // between is the newest word on the key. Both go through
                    // `_supersedePending`, which takes the entry out of
                    // `pendingWrites` precisely so an older value cannot land on
                    // top of them; the debounced failure path already consults
                    // that, and this one used not to, so the retry put the stale
                    // value back over a fresh write or resurrected a deleted
                    // key. Identity rather than presence, so a newer *debounced*
                    // write — which replaces the entry rather than removing it,
                    // and lands the key itself when its timer fires — is skipped
                    // by the same test.
                    const stragglers = items.filter(
                        (item) => !writtenKeys.has(item.key) && this.pendingWrites.get(item.timerKey) === item.pending
                    );
                    if (stragglers.length > 0) {
                        const retried = await Promise.all(
                            stragglers.map((item) => this._putAllWritten(storeName, { [item.key]: item.pending.value }))
                        );
                        stragglers.forEach((item, i) => {
                            if (retried[i].length > 0) writtenKeys.add(item.key);
                        });
                    }

                    for (const { timerKey, key, pending } of items) {
                        const success = writtenKeys.has(key);
                        if (success && this.pendingWrites.get(timerKey) === pending) {
                            // Only remove if no newer write claimed the slot mid-flush.
                            this.pendingWrites.delete(timerKey);
                            // Same reasoning as the debounced path: with no timer
                            // outstanding the generation entry is dead weight, and
                            // visibilitychange flushes repeatedly over a session.
                            if (!this.saveDebounceTimers.has(timerKey)) {
                                this._writeGeneration.delete(timerKey);
                            }
                            this._flushFailures.delete(timerKey);
                        } else if (!success) {
                            const failures = (this._flushFailures.get(timerKey) || 0) + 1;
                            if (failures >= MAX_FLUSH_ATTEMPTS) {
                                console.warn(
                                    `[Storage] Giving up on key ${key} in store ${storeName} after ${failures} failed flushes; the value is being dropped`
                                );
                                if (this.pendingWrites.get(timerKey) === pending) {
                                    this.pendingWrites.delete(timerKey);
                                    if (!this.saveDebounceTimers.has(timerKey)) {
                                        this._writeGeneration.delete(timerKey);
                                    }
                                }
                                this._flushFailures.delete(timerKey);
                            } else {
                                this._flushFailures.set(timerKey, failures);
                            }
                        }
                        for (const r of pending.resolvers || []) {
                            r(success);
                        }
                        // Same reasoning as the debounced failure path: the entry stays
                        // queued for a later retry, but holding these callers' promises
                        // open until that retry would hang them for the rest of the
                        // session. They have just been told the write failed.
                        if (!success) pending.resolvers = [];
                    }
                })()
            );
        }

        await Promise.all(flushes);
    }

    /**
     * Quiesce live writers before a restore replaces whole keys.
     *
     * Everything already queued is pre-restore state by definition, so it is
     * landed *now*, before the restore overwrites it — a pending write flushed
     * after the restore would be the old value going back on top of the new one.
     * Flushing rather than dropping is deliberate: until the restore has
     * actually written, the queued values are still the truth.
     *
     * @returns {Promise<void>}
     */
    async beginRestore() {
        // Raised before the flush so a timer that fires while the flush's
        // transactions are in flight also holds — the flush below is already
        // writing its value if it was queued in time, and a later write to the
        // same key belongs after the restore's own transaction, not during it.
        this._restoreInProgress = true;
        await this.flushAll();
    }

    /**
     * The restore is done writing (or gave up): stop holding debounce timers.
     *
     * Idempotent, and safe to call twice on nested begin/end pairs — a sync
     * pull calls `beginRestore` itself before reading merge bases, and then
     * `importEverything` calls it again on the way in. Every entry a firing
     * timer left queued during the window is flushed now: whatever belonged to
     * a restored store was already dropped by `finishRestore`, so what remains
     * is writes to untouched stores, which must land rather than sit with no
     * timer until the unload flush.
     *
     * Callers pair it with `beginRestore` in a `finally` — a restore that
     * throws must not leave every debounced write in the script held forever.
     * @returns {Promise<void>}
     */
    async endRestore() {
        if (!this._restoreInProgress) return;
        this._restoreInProgress = false;
        await this.flushAll();
    }

    /**
     * Latch the stores a restore just replaced, so nothing pre-restore lands on
     * top of them before the reload the UI asks for.
     *
     * Three routes clobber a restored key, and all three are cut here:
     *
     * - a debounce timer scheduled before the restore, which stands down when
     *   it sees the generation has moved (see `_debouncedSave`);
     * - a write requeued after a failure, which has no timer at all and would
     *   be written by the next `flushAll()` — hours later, on unload;
     * - a recorder holding the store's contents in memory, which will merge its
     *   pre-restore array onto whatever it reads and write the result back.
     *
     * Only the first two are storage's to fix outright. The third is a module's
     * own memory, which this cannot reach into, so the honest answer is to
     * refuse its writes and say so: every `set`/`setJSON`/`delete` to a latched
     * store logs and does nothing until the page reloads. The pull toast and the
     * restore alert both say the same thing, because a silent drop would be a
     * worse bug than the one this replaces.
     *
     * @param {Iterable<string>} storeNames - Stores the restore wrote
     * @returns {void}
     */
    finishRestore(storeNames) {
        const affected = new Set(storeNames || []);
        if (affected.size === 0) return;

        this._restoreGeneration += 1;
        for (const name of affected) this._restorePendingStores.add(name);

        // Anything still queued for an affected store predates the restore.
        // Dropping it is the point; its callers are resolved false so nothing
        // is left awaiting a write that will never happen.
        for (const [timerKey, pending] of Array.from(this.pendingWrites.entries())) {
            if (!affected.has(pending.storeName)) continue;
            const timer = this.saveDebounceTimers.get(timerKey);
            if (timer) clearTimeout(timer);
            this.saveDebounceTimers.delete(timerKey);
            this.pendingWrites.delete(timerKey);
            this._writeGeneration.delete(timerKey);
            this._flushFailures.delete(timerKey);
            for (const r of pending.resolvers || []) r(false);
        }

        console.warn(
            `[Storage] Restored ${affected.size} store(s): ${Array.from(affected).join(', ')}. ` +
                'Writes to them are refused until the page reloads, so nothing from before the restore ' +
                'lands on top of it. Reload now — changes made before reloading will not be kept.'
        );
    }

    /**
     * @param {string} [storeName] - Ask about one store, or omit for any
     * @returns {boolean} True while a restore is waiting for a reload
     */
    isRestorePending(storeName) {
        if (storeName === undefined) return this._restorePendingStores.size > 0;
        return this._restorePendingStores.has(storeName);
    }

    /** @returns {Array<string>} Stores a restore has latched */
    restorePendingStores() {
        return Array.from(this._restorePendingStores);
    }

    /**
     * Whether a write must be refused because a restore replaced its store.
     * @param {string} key - Storage key
     * @param {string} storeName - Object store name
     * @param {string} what - 'save' or 'delete', for the log line
     * @returns {boolean} True when the caller should do nothing
     * @private
     */
    _refuseDuringRestore(key, storeName, what) {
        if (!this._restorePendingStores.has(storeName)) return false;
        const seen = `${storeName}:${key}`;
        if (!this._restoreWarned.has(seen)) {
            this._restoreWarned.add(seen);
            console.warn(
                `[Storage] Refusing to ${what} ${storeName}/${key}: a restore replaced this store and the page ` +
                    'has not reloaded yet. Reload now — changes made before reloading will not be kept.'
            );
        }
        return true;
    }

    /**
     * Cleanup pending debounced writes without flushing
     */
    cleanupPendingWrites() {
        for (const timer of this.saveDebounceTimers.values()) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.saveDebounceTimers.clear();

        // Resolve all pending Promises with false before clearing
        for (const pending of this.pendingWrites.values()) {
            for (const r of pending.resolvers || []) {
                r(false);
            }
        }
        this.pendingWrites.clear();
        this._writeGeneration.clear();
        this._flushFailures.clear();
    }

    /**
     * Set up event handlers on the active DB connection.
     * @private
     */
    _setupDbEventHandlers() {
        if (!this.db) return;

        this.db.onversionchange = () => {
            console.warn('[Storage] DB connection lost: onversionchange fired (another tab/instance upgraded the DB)');
            this._dbNulledReason = 'onversionchange';
            this.db.close();
            this.db = null;
            this._reconnect();
        };

        this.db.onclose = () => {
            console.warn('[Storage] DB connection lost: onclose fired (connection dropped unexpectedly)');
            this._dbNulledReason = 'onclose';
            this.db = null;
            this._reconnect();
        };
    }

    /**
     * Attempt to reconnect to IndexedDB after the connection is lost.
     * @private
     */
    async _reconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;

        // Wait a brief moment for any version upgrade to complete
        await new Promise((r) => setTimeout(r, 500));

        try {
            await this.openDatabase();
            this.available = true;
            console.log('[Storage] Successfully reconnected to IndexedDB');
        } catch (error) {
            console.error('[Storage] Reconnection failed:', error);
            this.available = false;
            this._lastReconnectFailureAt = Date.now();
        } finally {
            this._reconnecting = false;
        }
    }

    /**
     * Wait, briefly, for a lost connection to come back before an operation
     * proceeds without it.
     *
     * Chromium drops IndexedDB connections — another tab upgrading the schema,
     * memory pressure, an extension churning the database — and `_reconnect`
     * reopens it within a second or so. During that gap every read used to
     * answer with its default and every write was refused, which is how a
     * module that loads a record, finds it "empty", and writes it back erased
     * real history. A read that waits out the gap is just a slow read.
     *
     * Only a *lost* connection is waited on. Before the first open (nothing to
     * wait for) and after a reconnect has recently failed (waiting again would
     * stall every operation for the whole outage) this returns at once.
     * @param {number} [timeoutMs=5000] - Longest to wait
     * @returns {Promise<boolean>} Whether a connection is available now
     */
    async _awaitConnection(timeoutMs = 5000) {
        if (this.db) return true;
        const lost = Boolean(this._dbNulledReason) || this._reconnecting;
        if (!lost) return false;
        if (this._lastReconnectFailureAt && Date.now() - this._lastReconnectFailureAt < 30_000) return false;

        const deadline = Date.now() + timeoutMs;
        while (!this.db && Date.now() < deadline) {
            if (!this._reconnecting) {
                // Nobody is bringing it back; start, but do not await — the loop
                // below watches for the result and the timeout bounds the wait
                this._reconnect();
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (this._lastReconnectFailureAt && this._lastReconnectFailureAt > deadline - timeoutMs) break;
        }
        return Boolean(this.db);
    }

    /**
     * Return diagnostic info about current storage state.
     * @returns {Object}
     */
    diagnostics() {
        return {
            dbExists: this.db !== null,
            available: this.available,
            dbName: this.dbName,
            dbVersion: this.dbVersion,
            reconnecting: this._reconnecting,
            lastNullReason: this._dbNulledReason,
            pendingWrites: this.pendingWrites.size,
            activeTimers: this.saveDebounceTimers.size,
            restorePendingStores: this.restorePendingStores(),
            quotaExceeded: this.quotaExceeded,
            quotaExceededAt: this._quotaExceededAt,
            quotaFailures: this._quotaFailures,
            lastQuotaTarget: this._lastQuotaTarget,
            estimate: this._lastEstimate,
        };
    }
}

const storage = new Storage();

export { STORE_KEY_BUDGETS };
export default storage;
