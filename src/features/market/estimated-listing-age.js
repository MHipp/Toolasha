/**
 * Estimated Listing Age Module
 *
 * Estimates creation times for all market listings using listing ID interpolation
 * - Collects known listing IDs with timestamps (from your own listings)
 * - Uses linear interpolation/regression to estimate ages for unknown listings
 * - Displays estimated ages on the main Market Listings (order book) tab
 */

import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import marketAPI from '../../api/marketplace.js';
import { formatRelativeTime, formatDateTime } from '../../utils/formatters.js';
import { readScoped } from '../../utils/character-key.js';
import { GAME } from '../../utils/selectors.js';
import { parseGameNumber } from '../../utils/number-parser.js';

/** Store both halves of the old shared key live in */
const LISTINGS_STORE = 'marketListings';

/**
 * The log of *your* listings — full records, one set per character.
 *
 * Scoped, because it is what the Market History table shows and what the order
 * book highlights green: another character's listing ids matched against the
 * book would claim its rows as yours.
 */
const LISTINGS_BASE = 'marketListingTimestamps';

/**
 * Bare `{id, timestamp}` points used only to date *other* people's listings.
 *
 * Global, because a listing id means the same thing to every character — this
 * is calibration data, not anybody's history, and splitting it per character
 * would halve the accuracy of both.
 */
const ANCHORS_KEY = 'marketListingAnchors';

/**
 * Cap on the shared anchor pool.
 *
 * The estimator interpolates/regresses over id→time, so what it benefits from
 * is coverage across the id range, not raw point count — a few thousand points
 * spread over the range estimate just as well as ten times that many packed
 * densely in one region. Bounded so the pool can grow indefinitely at runtime
 * without the stored array or the per-lookup scan becoming a problem.
 */
const ANCHOR_POOL_MAX = 3000;

/**
 * How far back the personal listing log reaches, measured from the newest
 * listing in it.
 *
 * The log used to keep every listing for life: every batch re-sorted it and
 * rebuilt the estimation points over it, and a busy trader's grew without
 * bound. Measured from the newest listing rather than from the clock so a
 * character that has not listed in a while keeps the history it has until it
 * lists again. Your own still-active listings are never dropped, whatever
 * their age.
 */
const LISTING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** At most this many personal listings are kept — the newest; active ones are never dropped */
const LISTING_RETENTION_MAX = 5000;

/**
 * How many recorded listings buy one retention pass.
 *
 * Retention is a full scan of the log — up to LISTING_RETENTION_MAX entries,
 * with a sort when the cap bites — and it used to run on every batch, including
 * the one-listing batches a status update produces. Nothing it drops is
 * time-critical (the oldest entries are already outside the estimation window),
 * so it runs once every so many recorded listings and again on the debounced
 * save, which is the last moment before the log is written out.
 */
const RETENTION_SWEEP_EVERY = 200;

/** An order book older than this is dropped from the cache, in memory and as stored */
const ORDER_BOOK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How many items' order books the cache holds; the least recently seen go first */
const ORDER_BOOK_CACHE_MAX_ITEMS = 200;

/**
 * How many rows a side keeps when the cache is written out.
 *
 * What is read back from a stored book is its top: the top competing order
 * of each side for the My Listings price/age columns, the top ask for the
 * marketplace dropdown. The full twenty rows the game sends per side are
 * only ever read for the book currently open, which arrives fresh over the
 * socket before its table is even drawn — so the whole book is kept in
 * memory and only its head is persisted.
 */
const ORDER_BOOK_PERSISTED_ROWS = 10;

/** How long listing events are gathered before the log is saved once */
const LISTING_SAVE_DEBOUNCE_MS = 250;

/**
 * How long order-book messages are gathered before the age column is redrawn.
 *
 * Opening an item sends one message per enhancement level — about twenty in
 * a row — and each used to clear and rebuild every age column on the page.
 * The book is stashed the moment it arrives; only the DOM pass waits.
 */
const ORDER_BOOK_REPAINT_MS = 50;

/**
 * Anchor points from the RWI script author's data, for a fresh install that has
 * no listings of its own to interpolate between.
 */
const SEED_ANCHORS = [
    { id: 106442952, timestamp: 1763409373481 },
    { id: 106791533, timestamp: 1763541486867 },
    { id: 107530218, timestamp: 1763842767083 },
    { id: 107640371, timestamp: 1763890560819 },
    { id: 107678558, timestamp: 1763904036320 },
];

/**
 * Two listing logs folded into one, by id, the second winning on a clash.
 *
 * The second argument is the fresher view — the in-memory log, which has
 * seen every status update this tab has — so its copy of a listing stands;
 * listings only the first side knows about (another tab's, an import's,
 * one written before a failed read) are kept rather than overwritten. The
 * same fold serves a sync pull, where the first argument is this device's
 * stored log and the second is the one coming down.
 * @param {Array<Object>} base - Listings, typically as stored
 * @param {Array<Object>} fresh - Listings, typically in memory
 * @returns {Array<Object>} Merged, sorted by id
 */
function mergeListingLogs(base, fresh) {
    const byId = new Map();
    for (const listing of base || []) {
        if (listing && typeof listing.id === 'number') byId.set(listing.id, listing);
    }
    for (const listing of fresh || []) {
        if (listing && typeof listing.id === 'number') byId.set(listing.id, listing);
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Trim a sorted anchor array down to ANCHOR_POOL_MAX, thinning the densest
 * neighborhoods first.
 *
 * Repeatedly removes whichever interior point has the smallest combined gap
 * to its neighbors (points[i+1].id - points[i-1].id) — that point is the
 * most redundant one for interpolation, since its neighbors already bracket
 * it tightly. The two endpoints are never evicted: they define the id range
 * the pool can interpolate across at all, and losing either would shrink
 * coverage rather than just density.
 *
 * Module-level and pure, because the sync merge below needs it without an
 * instance — a registered merge is called with two values and nothing else.
 * @param {Array<{id: number, timestamp: number}>} sorted - Anchors sorted by id
 * @returns {Array<{id: number, timestamp: number}>} At most ANCHOR_POOL_MAX anchors, still sorted by id
 */
function evictAnchorsToCapacity(sorted) {
    if (sorted.length <= ANCHOR_POOL_MAX) {
        return sorted;
    }

    const points = [...sorted];
    while (points.length > ANCHOR_POOL_MAX && points.length > 2) {
        let victimIndex = 1;
        let smallestGap = Infinity;
        for (let i = 1; i < points.length - 1; i++) {
            const gap = points[i + 1].id - points[i - 1].id;
            if (gap < smallestGap) {
                smallestGap = gap;
                victimIndex = i;
            }
        }
        points.splice(victimIndex, 1);
    }

    return points;
}

/**
 * Fold two devices' anchor pools together.
 *
 * The pool is the one thing in this module that is neither personal nor
 * derivable: shared id→timestamp calibration points, collected from whatever
 * order books each device happened to look at, and only ever added to. Two
 * devices therefore hold genuinely different pools, and a pull that wrote the
 * key whole threw away every anchor the receiving device had gathered — the
 * age column then re-derived its estimates from a strictly worse pool, which
 * is the same loss the listing log next door is registered to avoid.
 *
 * Deduped by id with the FIRST side standing, matching `addAnchors`: an id
 * already anchored keeps its reading, so folding in a remote pool can only add
 * points to interpolate between, never move an estimate that already had one.
 * Capped afterwards, so a union of two full pools is still a legal pool.
 * @param {Array<{id: number, timestamp: number}>} base - This device's pool
 * @param {Array<{id: number, timestamp: number}>} fresh - The pool coming down
 * @returns {Array<{id: number, timestamp: number}>} The union, sorted by id and capped
 */
function mergeAnchorPools(base, fresh) {
    const byId = new Map();
    for (const anchor of [...(Array.isArray(base) ? base : []), ...(Array.isArray(fresh) ? fresh : [])]) {
        if (!anchor || typeof anchor.id !== 'number' || typeof anchor.timestamp !== 'number') continue;
        if (isNaN(anchor.id) || isNaN(anchor.timestamp)) continue;
        if (byId.has(anchor.id)) continue;
        byId.set(anchor.id, { id: anchor.id, timestamp: anchor.timestamp });
    }
    return evictAnchorsToCapacity([...byId.values()].sort((a, b) => a.id - b.id));
}

/**
 * When a listing was created, for retention: its recorded `timestamp`, else
 * its `createdTimestamp`, else 0 (undatable rows sort as the oldest).
 * @param {Object} listing
 * @returns {number} Epoch ms
 */
function listingTime(listing) {
    if (Number.isFinite(listing.timestamp)) return listing.timestamp;
    const parsed = Date.parse(listing.createdTimestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whether a known listing is the one an expired My Listings row describes.
 *
 * Enhancement level is compared alongside side/price/quantity because two
 * listings of the same item at different levels (a +0 and a +10 of the same
 * equipment, say) can otherwise collide on all three — without it, marking one
 * expired risks stamping the wrong one, permanently mislabeling a still-active
 * listing and losing track of the one that actually expired. Pure, so the
 * matching rule can be tested without a DOM.
 * @param {Object} listing - A known listing
 * @param {Object} candidate - Fields read off the expired row
 * @param {string|null} candidate.itemHrid
 * @param {number} candidate.enhancementLevel
 * @param {boolean} candidate.isSell
 * @param {number} candidate.price
 * @param {number} candidate.orderQuantity
 * @param {number} candidate.filledQuantity
 * @returns {boolean}
 */
function matchesExpiredRow(listing, candidate) {
    return (
        (!candidate.itemHrid || listing.itemHrid === candidate.itemHrid) &&
        (listing.status === 'active' || listing.status === 'unknown') &&
        (listing.enhancementLevel || 0) === (candidate.enhancementLevel || 0) &&
        listing.isSell === candidate.isSell &&
        listing.price === candidate.price &&
        listing.orderQuantity === candidate.orderQuantity &&
        listing.filledQuantity === candidate.filledQuantity
    );
}

/**
 * Whether a known listing is the one behind a beyond-top-20 order-book row.
 *
 * Enhancement level is compared alongside item/price/remaining-quantity/side
 * for the same reason as `matchesExpiredRow`: two of your own listings for the
 * same item at different levels can share a price and a remaining quantity,
 * and without the level check the wrong one's timestamp gets stamped onto the
 * row (or the right one gets reported "~Unknown" because its match was stolen).
 * Pure, so the matching rule can be tested without a DOM.
 * @param {Object} listing - A known listing
 * @param {Object} candidate - Fields read for the row being matched
 * @param {string} candidate.itemHrid
 * @param {number} candidate.enhancementLevel
 * @param {number} candidate.price
 * @param {number} candidate.quantity - Remaining (unfilled) quantity
 * @param {boolean} candidate.isSell
 * @returns {boolean}
 */
function matchesBeyondTopRow(listing, candidate) {
    return (
        listing.itemHrid === candidate.itemHrid &&
        (listing.enhancementLevel || 0) === (candidate.enhancementLevel || 0) &&
        Math.abs(listing.price - candidate.price) < 0.01 &&
        listing.orderQuantity - listing.filledQuantity === candidate.quantity &&
        listing.isSell === candidate.isSell
    );
}

/**
 * The personal log with its retention applied: listings older than
 * LISTING_RETENTION_MS before the newest one go, then, if more than
 * LISTING_RETENTION_MAX remain, the oldest beyond that cap go too. A listing
 * whose status is 'active' is kept regardless — it is still on the market,
 * still highlighted in the book, still matched by id. What is kept is kept
 * as-is, so estimation over the remaining points is unchanged.
 * @param {Array<Object>} listings - Sorted by id
 * @returns {Array<Object>} The same array when nothing is dropped, else a new one sorted by id
 */
function applyListingRetention(listings) {
    if (!Array.isArray(listings) || listings.length === 0) return listings;

    let newest = -Infinity;
    for (const listing of listings) {
        const time = listingTime(listing);
        if (time > newest) newest = time;
    }
    const cutoff = newest - LISTING_RETENTION_MS;
    const kept = listings.filter((listing) => listing.status === 'active' || listingTime(listing) >= cutoff);

    if (kept.length > LISTING_RETENTION_MAX) {
        const active = kept.filter((listing) => listing.status === 'active');
        const rest = kept
            .filter((listing) => listing.status !== 'active')
            .sort((a, b) => listingTime(b) - listingTime(a))
            .slice(0, Math.max(0, LISTING_RETENTION_MAX - active.length));
        return [...active, ...rest].sort((a, b) => a.id - b.id);
    }

    return kept.length === listings.length ? listings : kept;
}

class EstimatedListingAge {
    constructor() {
        this.knownListings = []; // Array of {id, timestamp, createdTimestamp, enhancementLevel, ...} sorted by id
        this.anchors = []; // Shared {id, timestamp} calibration points, sorted by id
        this.anchorsLoaded = false;
        this.estimationPoints = []; // knownListings ∪ anchors, sorted by id
        this.orderBooksCache = {}; // Cache of order book data from WebSocket
        this.currentItemHrid = null; // Track current item from WebSocket
        this.unregisterWebSocket = null;
        this.unregisterObserver = null;
        this.storageKey = LISTINGS_BASE;
        this.anchorsKey = ANCHORS_KEY;
        this.orderBooksCacheKey = 'marketOrderBooksCache';
        this.isInitialized = false;
        this._saveTimer = null;
        this._pendingSave = null;
        this._resolvePendingSave = null;
        this._repaintTimer = null;
        this._pageHideHandler = null;
        /** Listings recorded since the last retention pass, for the gate */
        this._recordedSinceRetention = 0;
        /**
         * Bumped when {@link disable} drops the in-memory log. Work that
         * suspended holding that log — a delete or a clear waiting out its
         * re-sync — finds the number moved and stands down rather than writing
         * an emptied log over the arriving character's.
         */
        this._generation = 0;
    }

    /**
     * A ticket saying whose listing log the work about to suspend is holding.
     *
     * Both halves are needed. The character id is what the storage key has to
     * be built from — `characterKey()` answers with whoever is current at the
     * moment it is called, and the switch moves that the instant it settles,
     * before `disable()` has had a turn — and the generation is what says
     * whether `this.knownListings` is still the log this work was about.
     * @returns {{generation: number, charId: string}} Pass to the two checks below
     */
    _owner() {
        return { generation: this._generation, charId: dataManager.getCurrentCharacterId() || 'default' };
    }

    /**
     * @param {{generation: number}} owner - From {@link _owner}
     * @returns {boolean} Whether `this.knownListings` is still the log it was taken over
     */
    _ownsMemory(owner) {
        return this._generation === owner.generation;
    }

    /**
     * @param {{generation: number, charId: string}} owner - From {@link _owner}
     * @returns {boolean} Whether the character it was taken under is also still the one in hand
     */
    _stillOurs(owner) {
        return this._ownsMemory(owner) && (dataManager.getCurrentCharacterId() || 'default') === owner.charId;
    }

    /**
     * One character's listing-log key, built from an id the caller captured
     * rather than from whoever happens to be current at the write.
     * @param {{charId: string}} owner - From {@link _owner}
     * @returns {string} The scoped key
     */
    _listingsKey(owner) {
        return `${LISTINGS_BASE}_${owner.charId}`;
    }

    /**
     * Format timestamp based on user settings
     * @param {number} timestamp - Timestamp in milliseconds
     * @returns {string} Formatted time string
     */
    formatTimestamp(timestamp) {
        const ageFormat = config.getSettingValue('market_listingAgeFormat', 'datetime');

        if (ageFormat === 'elapsed') {
            // Show elapsed time (e.g., "3h 45m")
            const ageMs = Date.now() - timestamp;
            return formatRelativeTime(ageMs);
        } else {
            // Show date/time (e.g., "01-13 14:30:45" or "01-13 2:30:45 PM")
            return formatDateTime(new Date(timestamp));
        }
    }

    /**
     * Initialize the estimated listing age feature
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // Load historical data from storage
        await this.loadHistoricalData();

        // Load cached order books from storage
        await this.loadOrderBooksCache();

        // Load initial listings from dataManager
        this.loadInitialListings();

        // Setup WebSocket listeners to collect your listing IDs
        this.setupWebSocketListeners();

        // A listing save waits out a short debounce; a tab closing inside that
        // window still gets its write
        if (typeof window !== 'undefined' && !this._pageHideHandler) {
            this._pageHideHandler = () => this.flushPendingSave();
            window.addEventListener('pagehide', this._pageHideHandler);
        }

        // Display-only features: DOM observers for age columns
        if (config.getSetting('market_showEstimatedListingAge')) {
            // Setup DOM observer for order book table
            this.setupObserver();

            // Setup DOM observer for My Listings table (expired detection)
            this.setupMyListingsObserver();
        }
    }

    /**
     * Load initial listings from dataManager (already received via init_character_data)
     */
    loadInitialListings() {
        const listings = dataManager.getMarketListings();
        this.recordListings(listings.filter((listing) => listing.id && listing.createdTimestamp));
    }

    /**
     * Load the shared anchor pool, harvesting it out of the legacy shared key.
     *
     * Runs before anything can read the per-character key, because adopting that
     * key deletes the legacy copy — and the legacy copy is where every anchor
     * written before the split still lives. Both characters need those points,
     * so they are lifted out first and only then is the rest adopted.
     * @returns {Promise<void>}
     */
    async loadAnchors() {
        try {
            const stored = (await storage.getJSON(this.anchorsKey, LISTINGS_STORE, [])) || [];
            const legacy = await storage.getJSON(LISTINGS_BASE, LISTINGS_STORE, null);

            const byId = new Map();
            const add = (entry) => {
                if (!entry || typeof entry.id !== 'number' || typeof entry.timestamp !== 'number') return;
                if (!byId.has(entry.id)) byId.set(entry.id, { id: entry.id, timestamp: entry.timestamp });
            };

            stored.forEach(add);
            // The half of the legacy array that was never anybody's listing
            if (Array.isArray(legacy)) legacy.filter((entry) => entry && !entry.itemHrid).forEach(add);
            SEED_ANCHORS.forEach(add);

            this.anchors = [...byId.values()].sort((a, b) => a.id - b.id);
            if (this.anchors.length !== stored.length) {
                await storage.setJSON(this.anchorsKey, this.anchors, LISTINGS_STORE, true);
            }
        } catch (error) {
            console.error('[EstimatedListingAge] Failed to load listing anchors:', error);
            this.anchors = [...SEED_ANCHORS];
        } finally {
            this.anchorsLoaded = true;
        }
    }

    /**
     * Load this character's listing log from IndexedDB
     */
    async loadHistoricalData() {
        // Captured before the first read: every key below is built from it, and
        // a load that settles under a different character folds one character's
        // listings into the other's memory — which the next save then writes
        // under the other's key
        const owner = this._owner();
        try {
            if (!this.anchorsLoaded) {
                await this.loadAnchors();
            }
            if (!this._ownsMemory(owner)) return;

            // A read that could not be made is not an empty log. `readScoped`
            // folds the two together, so the scoped key is checked first with a
            // read that tells them apart; only a trustworthy "absent" goes on to
            // the legacy-adoption path. On failure the in-memory log stands —
            // taking a failed read for an empty one, and then writing it back,
            // is how a whole history used to vanish.
            const probe = await storage.tryGet(this._listingsKey(owner), LISTINGS_STORE);
            if (probe === null) {
                console.warn('[EstimatedListingAge] Listing log could not be read; keeping the in-memory copy');
                this.rebuildEstimationPoints();
                return;
            }
            if (!this._ownsMemory(owner)) return;
            // `readScoped` builds its own key from whoever is current, and its
            // adoption deletes the legacy copy — so it is only reached while
            // this load still speaks for the character it began under
            let stored = probe.value;
            if (!probe.found) {
                if (!this._stillOurs(owner)) return;
                stored = (await readScoped(LISTINGS_BASE, LISTINGS_STORE, [], { migrate: 'adopt' })) || [];
                if (!this._ownsMemory(owner)) return;
            }

            // Load all historical data (no time-based filtering). Entries without
            // an itemHrid are anchors, which now live in their own global key.
            const personal = (Array.isArray(stored) ? stored : []).filter((entry) => entry && entry.itemHrid);
            // Stored is the truth, but anything recorded in memory that storage
            // has not seen yet (another tab's write landed in between, or a save
            // is still in flight) is kept rather than dropped on the floor
            const merged = this._mergeListings(personal, this.knownListings);
            this.knownListings = applyListingRetention(merged);

            // An array adopted from before the split still carries its anchor
            // half; drop it now rather than re-filtering it on every read. A log
            // that retention just trimmed is written back for the same reason
            if (personal.length !== stored.length || this.knownListings.length !== merged.length) {
                await this.saveHistoricalData({ owner });
            }
        } catch (error) {
            console.error('[EstimatedListingAge] Failed to load historical data:', error);
            // Keep whatever is in memory; an empty array here would be written
            // back over the stored log by the next listing event
        }

        this.rebuildEstimationPoints();
    }

    /**
     * Two listing logs folded into one, by id, the second winning on a clash.
     *
     * The second argument is the fresher view — the in-memory log, which has
     * seen every status update this tab has — so its copy of a listing stands;
     * listings only the first side knows about (another tab's, an import's,
     * one written before a failed read) are kept rather than overwritten.
     * @param {Array<Object>} base - Listings, typically as stored
     * @param {Array<Object>} fresh - Listings, typically in memory
     * @returns {Array<Object>} Merged, sorted by id
     */
    _mergeListings(base, fresh) {
        return mergeListingLogs(base, fresh);
    }

    /**
     * Rebuild the set of points ages are estimated from: this character's own
     * listings, which are exact, over the shared anchors, which are not.
     */
    rebuildEstimationPoints() {
        const byId = new Map();
        for (const anchor of this.anchors) byId.set(anchor.id, anchor);
        for (const listing of this.knownListings) byId.set(listing.id, listing);
        this.estimationPoints = [...byId.values()].sort((a, b) => a.id - b.id);
    }

    /**
     * Grow the shared anchor pool with new {id, timestamp} candidates.
     *
     * Growth-only merge: an id already in the pool keeps its existing timestamp,
     * so re-observing the same id (a status update re-recording a listing, the
     * same order book row on a later refresh) is a no-op rather than a
     * potentially-noisier overwrite. Never removes an id except via capacity
     * eviction, so adding anchors never regresses an estimate that already had
     * a point to work with — it only ever has more to work with.
     * @param {Array<{id: number, timestamp: number}>} entries - Candidate anchor points
     * @returns {Promise<void>}
     */
    async addAnchors(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        const byId = new Map();
        for (const anchor of this.anchors) byId.set(anchor.id, anchor);

        let grew = false;
        for (const entry of entries) {
            if (!entry || typeof entry.id !== 'number' || typeof entry.timestamp !== 'number') continue;
            if (isNaN(entry.id) || isNaN(entry.timestamp)) continue;
            if (byId.has(entry.id)) continue;
            byId.set(entry.id, { id: entry.id, timestamp: entry.timestamp });
            grew = true;
        }

        if (!grew) {
            return;
        }

        this.anchors = this._evictToCapacity([...byId.values()].sort((a, b) => a.id - b.id));
        this.rebuildEstimationPoints();
        await this._persistAnchors();
    }

    /**
     * Trim a sorted anchor array down to ANCHOR_POOL_MAX — see
     * {@link evictAnchorsToCapacity}, which the sync merge shares.
     * @param {Array<{id: number, timestamp: number}>} sorted - Anchors sorted by id
     * @returns {Array<{id: number, timestamp: number}>} At most ANCHOR_POOL_MAX anchors, still sorted by id
     */
    _evictToCapacity(sorted) {
        return evictAnchorsToCapacity(sorted);
    }

    /**
     * Persist the anchor pool.
     *
     * Debounced (no `immediate` flag) like the rest of storage — growth events
     * (a new listing, an order book response) can arrive in bursts and do not
     * each need a separate IndexedDB write.
     * @returns {Promise<void>}
     */
    async _persistAnchors() {
        try {
            await storage.setJSON(this.anchorsKey, this.anchors, LISTINGS_STORE);
        } catch (error) {
            console.error('[EstimatedListingAge] Failed to save listing anchors:', error);
        }
    }

    /**
     * This character's stored listing log, migrated and split.
     *
     * The one reader-side entry point, so nothing else has to know the key, the
     * store, or that a legacy shared array ever existed.
     * @returns {Promise<Array>} Copies of the stored listings, sorted by id
     */
    async personalListings() {
        await this.loadHistoricalData();
        return this.knownListings.map((listing) => ({ ...listing }));
    }

    /**
     * The top of one side of an item's cached order book.
     *
     * The reader-side counterpart to {@link _cacheOrderBook}, so nothing else
     * has to know that the cache stores `{data, lastUpdated}` around a payload
     * whose `orderBooks` may be a sparse array or an object keyed by level.
     *
     * The cache holds the *latest* book per item, up to a week old — not a
     * history — so a price this answers with is current, whatever the age of
     * whatever it is being compared against. Callers reconstructing a past
     * offset from it are producing an approximation and should say so.
     * @param {string} itemHrid - Item to look up
     * @param {number} [enhancementLevel=0] - Which level's book
     * @param {boolean} [isSell=true] - True for the top ask, false for the top bid
     * @returns {number|null} Best price on that side, or null when the cache has no book
     */
    cachedTopOfBook(itemHrid, enhancementLevel = 0, isSell = true) {
        const entry = this.orderBooksCache?.[itemHrid];
        if (!entry) return null;
        const orderBooks = (entry.data || entry)?.orderBooks;
        if (!orderBooks) return null;

        const book = Array.isArray(orderBooks) ? orderBooks[enhancementLevel] : orderBooks[String(enhancementLevel)];
        const rows = isSell ? book?.asks : book?.bids;
        const price = rows?.[0]?.price;
        return typeof price === 'number' && price > 0 ? price : null;
    }

    /**
     * Load cached order books from IndexedDB
     */
    async loadOrderBooksCache() {
        try {
            const stored = await storage.getJSON(this.orderBooksCacheKey, 'marketListings', {});
            // Older blobs hold whole books; they load the same, and are trimmed
            // on the next write
            this.orderBooksCache = this._pruneOrderBooksCache(stored || {});
        } catch (error) {
            console.error('[EstimatedListingAge] Failed to load order books cache:', error);
            this.orderBooksCache = {};
        }
    }

    /**
     * Save the listing log to IndexedDB.
     *
     * Read-merge-write, serialized: what is stored is re-read and folded under
     * the in-memory log before the write, so a second tab's listings, an import
     * the viewer wrote straight to storage, or records this tab never loaded are
     * carried forward rather than overwritten. When the pre-write read cannot be
     * made the write is skipped outright — the log in memory is kept and the
     * next save retries — because a blind overwrite from a possibly-empty copy
     * is exactly the accident this exists to prevent.
     *
     * @param {Object} [options]
     * @param {boolean} [options.overwrite=false] - Write the in-memory log as-is.
     *   For deletions and clears, whose whole point is that the stored copy
     *   loses entries; callers re-sync from storage immediately before.
     * @param {{generation: number, charId: string}} [options.owner] - From
     *   {@link _owner}, taken when the operation this save belongs to began.
     *   The key is built from it, so the write is always correctly filed; and
     *   the save stands down when the in-memory log has since been dropped for
     *   another character's, which is what stopped a delete or a clear from
     *   emptying the wrong character's log.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveHistoricalData({ overwrite = false, owner = this._owner() } = {}) {
        const run = async () => {
            // The log in memory is no longer the one this save was about: a
            // switch has landed and `disable()` has emptied it. Writing it now
            // would put an empty (or the wrong character's) log under a key,
            // and for an `overwrite` save that is a full replacement.
            if (!this._ownsMemory(owner)) return false;
            const writeKey = this._listingsKey(owner);
            try {
                if (!overwrite) {
                    const probe = await storage.tryGet(writeKey, LISTINGS_STORE);
                    if (probe === null) {
                        console.warn('[EstimatedListingAge] Listing log not saved: storage could not be read first');
                        return false;
                    }
                    const stored = probe.found && Array.isArray(probe.value) ? probe.value : [];
                    const personal = stored.filter((entry) => entry && entry.itemHrid);
                    // Retention again over the fold, or rows the log had already
                    // let go of would come back from storage on every save
                    const merged = applyListingRetention(this._mergeListings(personal, this.knownListings));
                    if (!this._ownsMemory(owner)) return false;
                    if (merged.length !== this.knownListings.length) {
                        this.knownListings = merged;
                        this.rebuildEstimationPoints();
                    }
                }
                return await storage.set(writeKey, this.knownListings, LISTINGS_STORE, true);
            } catch (error) {
                console.error('[EstimatedListingAge] Failed to save historical data:', error);
                return false;
            }
        };
        // One save at a time, in order: two interleaved read-merge-writes could
        // each miss the other's entries
        this._saveChain = (this._saveChain || Promise.resolve()).then(run, run);
        return this._saveChain;
    }

    /**
     * Delete a listing and persist. This module is the single writer for the shared
     * storage key — writing the key from a divergent copy resurrects deleted entries.
     * Re-syncs from storage first so a stale in-memory copy can't clobber other rows.
     * @param {number} listingId - Listing ID to delete
     */
    async deleteListing(listingId) {
        // The re-sync is several storage hops, and the write that follows is a
        // full overwrite: a switch landing in between left the delete holding
        // the arriving character's log (or the empty one `disable()` leaves) and
        // writing it under their key, wiping their whole listing history
        const owner = this._owner();
        await this.loadHistoricalData();
        if (!this._ownsMemory(owner)) return;
        this.knownListings = this.knownListings.filter((l) => l.id !== listingId);
        this.rebuildEstimationPoints();
        await this.saveHistoricalData({ overwrite: true, owner });
    }

    /**
     * Fold imported listings into this character's log and persist.
     *
     * Through the owner rather than a direct write, so the import lands in the
     * in-memory log as well as in storage — an import written around it used
     * to be overwritten by the next listing event's save.
     * @param {Array<Object>} listings - Full listing records, as the log stores them
     */
    async importListings(listings) {
        this.knownListings = applyListingRetention(this._mergeListings(this.knownListings, listings));
        this.rebuildEstimationPoints();
        await this.saveHistoricalData();
    }

    /**
     * Empty this character's listing log, in memory and in storage.
     *
     * The one write that is meant to lose entries, so it bypasses the
     * merge-on-write that every other save goes through.
     */
    async clearPersonalListings() {
        this.knownListings = [];
        this.rebuildEstimationPoints();
        await this.saveHistoricalData({ overwrite: true });
    }

    /**
     * Mark listings as active based on the current active listing IDs and persist
     * (single writer for the shared storage key). Re-syncs from storage first.
     * @param {Set<number>} activeListingIds - IDs of currently active listings
     */
    async markActiveListings(activeListingIds) {
        const owner = this._owner();
        await this.loadHistoricalData();
        // The ids are one character's "my listings"; marking them against
        // another character's log makes their listings look active
        if (!this._ownsMemory(owner)) return;
        let changed = false;
        for (const listing of this.knownListings) {
            if (activeListingIds.has(listing.id) && (!listing.status || listing.status === 'unknown')) {
                listing.status = 'active';
                changed = true;
            }
        }
        if (changed) {
            await this.saveHistoricalData({ owner });
        }
    }

    /**
     * Save order books cache to IndexedDB
     */
    async saveOrderBooksCache() {
        try {
            await storage.setJSON(this.orderBooksCacheKey, this._orderBooksForStorage(), 'marketListings');
        } catch (error) {
            console.error('[EstimatedListingAge] Failed to save order books cache:', error);
        }
    }

    /**
     * The cache with what has aged out or overflowed dropped.
     *
     * Age first, then count: the books seen least recently go, so what stays
     * is what the My Listings table is most likely to look up.
     * @param {Object} cache - itemHrid → { data, lastUpdated }
     * @param {number} [now=Date.now()] - The moment to age against
     * @returns {Object} A new object, bounded
     */
    _pruneOrderBooksCache(cache, now = Date.now()) {
        const cutoff = now - ORDER_BOOK_CACHE_MAX_AGE_MS;
        const kept = Object.entries(cache || {}).filter(
            ([, entry]) => entry && typeof entry === 'object' && entry.lastUpdated && entry.lastUpdated >= cutoff
        );
        if (kept.length > ORDER_BOOK_CACHE_MAX_ITEMS) {
            kept.sort((a, b) => b[1].lastUpdated - a[1].lastUpdated);
            kept.length = ORDER_BOOK_CACHE_MAX_ITEMS;
        }
        return Object.fromEntries(kept);
    }

    /**
     * Stash one item's order book and keep the cache within bounds.
     * @param {string} itemHrid - Item the book is for
     * @param {Object} orderBooksData - The marketItemOrderBooks payload
     */
    _cacheOrderBook(itemHrid, orderBooksData) {
        this.orderBooksCache[itemHrid] = {
            data: orderBooksData,
            lastUpdated: Date.now(),
        };
        // Only a cache that has outgrown its bound is walked; the age cut
        // rides along with the count cut
        if (Object.keys(this.orderBooksCache).length > ORDER_BOOK_CACHE_MAX_ITEMS) {
            this.orderBooksCache = this._pruneOrderBooksCache(this.orderBooksCache);
        }
    }

    /**
     * The cache as it is written out: every item the in-memory cache holds,
     * each side of each level cut to its top rows. Same shape as the cache,
     * so an older blob and a newer one load the same way.
     * @returns {Object} itemHrid → { data, lastUpdated }
     */
    _orderBooksForStorage() {
        const trimSide = (rows) => (Array.isArray(rows) ? rows.slice(0, ORDER_BOOK_PERSISTED_ROWS) : rows);
        const trimBook = (book) => {
            if (!book || typeof book !== 'object') return book;
            const trimmed = { ...book };
            if ('asks' in book) trimmed.asks = trimSide(book.asks);
            if ('bids' in book) trimmed.bids = trimSide(book.bids);
            return trimmed;
        };
        const trimLevels = (orderBooks) => {
            if (Array.isArray(orderBooks)) return orderBooks.map(trimBook);
            if (orderBooks && typeof orderBooks === 'object') {
                return Object.fromEntries(Object.entries(orderBooks).map(([level, book]) => [level, trimBook(book)]));
            }
            return orderBooks;
        };

        const out = {};
        for (const [itemHrid, entry] of Object.entries(this._pruneOrderBooksCache(this.orderBooksCache))) {
            // Support both old format (direct data) and new format ({data, lastUpdated})
            const data = entry.data || entry;
            out[itemHrid] = {
                lastUpdated: entry.lastUpdated,
                data: data && typeof data === 'object' ? { ...data, orderBooks: trimLevels(data.orderBooks) } : data,
            };
        }
        return out;
    }

    /**
     * A listing carrying our own status stamp, as a copy.
     *
     * The payload objects the data manager hands out are the same objects it
     * stores in `characterData.myMarketListings` and re-emits on every later
     * market message. Stamping one is therefore permanent: a listing marked
     * 'unknown' here, later promoted to 'active' by the My Listings table, was
     * re-stamped 'unknown' by the next unrelated market message, because the
     * stamp outranks the tracked status in `recordListings`. That took the
     * listing out of the retention exemption, out of expiry matching, and out
     * of the Market History display. So the stamp goes on a shallow copy and
     * the payload is left exactly as it arrived.
     *
     * @param {Object} listing - Wire listing (not modified)
     * @param {string} status - unknown / active / filled / canceled / expired
     * @param {Object} [overrides] - Further fields, for the copy only
     * @returns {Object} A copy carrying the stamp
     */
    _stamped(listing, status, overrides = {}) {
        return { ...listing, ...overrides, _toolashaStatus: status };
    }

    /**
     * What the game's status HRID says happened to a listing, as a stamped copy.
     * @param {Object} listing - Wire listing from `endMarketListings` (not modified)
     * @returns {Object} A copy carrying `_toolashaStatus`
     */
    _classify(listing) {
        if (listing.status === '/market_listing_status/active') {
            // New listing being created - mark as unknown (history viewer will set to active)
            return this._stamped(listing, 'unknown');
        }
        if (listing.status === '/market_listing_status/cancelled') {
            if (listing.filledQuantity > 0) {
                // Partially filled before cancel (e.g. Missing Materials split) - recorded as
                // filled for the amount received. The narrowed order quantity goes on the copy
                // only; the payload keeps the quantity the player actually ordered
                return this._stamped(listing, 'filled', { orderQuantity: listing.filledQuantity });
            }
            // User canceled the listing with nothing filled
            return this._stamped(listing, 'canceled');
        }
        if (listing.status === '/market_listing_status/filled') {
            return this._stamped(listing, 'filled');
        }
        if (listing.status === '/market_listing_status/expired') {
            return this._stamped(listing, 'expired');
        }
        // Unknown status - fallback to old logic
        return this._stamped(listing, listing.filledQuantity >= listing.orderQuantity ? 'filled' : 'canceled');
    }

    /**
     * Setup WebSocket listeners to collect your listing IDs and order book data
     */
    setupWebSocketListeners() {
        // Handle initial character data
        const initHandler = (data) => {
            if (data.myMarketListings) {
                this.recordListings(data.myMarketListings);
                // Reconcile: any previously-active listing absent from this snapshot is no longer active
                this._reconcileActiveListings(data.myMarketListings);
            }
        };

        // Handle listing updates
        const updateHandler = (data) => {
            // Handle newly created listings (user just placed an order)
            if (data.newMarketListings) {
                // New listings start as 'unknown' (the history viewer marks them
                // 'active'). Stamped onto copies, never the payload — see `_stamped`
                this.recordListings(data.newMarketListings.map((listing) => this._stamped(listing, 'unknown')));
            }

            // Update all active listings (if provided)
            if (data.myMarketListings) {
                // Active listings - record them but don't set status (let history viewer handle it)
                this.recordListings(data.myMarketListings);
                // Reconcile: any previously-active listing absent from this snapshot is no longer active
                this._reconcileActiveListings(data.myMarketListings);
            }

            // Handle endMarketListings (confusing name - contains both new AND ending listings)
            if (data.endMarketListings) {
                this.recordListings(data.endMarketListings.map((listing) => this._classify(listing)));
            }
        };

        // Handle order book updates (contains listing IDs for ALL listings)
        const orderBookHandler = (data) => {
            if (data.marketItemOrderBooks) {
                const itemHrid = data.marketItemOrderBooks.itemHrid;
                const orderBooks = data.marketItemOrderBooks.orderBooks;

                // IMPORTANT: Populate createdTimestamp on all listings (for queue length estimator)
                // RWI does this in their saveOrderBooks function
                //
                // Growth: a listing that already carries a createdTimestamp we did not just
                // write ourselves is a real, observed id↔time pair for someone else's
                // listing — free calibration data this handler already sees on every order
                // book response, with no new listener required.
                const observedAnchors = [];
                const captureRealTimestamp = (listing) => {
                    if (!listing.createdTimestamp || !listing.listingId) {
                        return;
                    }
                    const ts =
                        typeof listing.createdTimestamp === 'number'
                            ? listing.createdTimestamp
                            : new Date(listing.createdTimestamp).getTime();
                    if (!isNaN(ts)) {
                        observedAnchors.push({ id: listing.listingId, timestamp: ts });
                    }
                };

                if (orderBooks) {
                    // Handle both array and object format
                    const orderBooksArray = Array.isArray(orderBooks) ? orderBooks : Object.values(orderBooks);

                    for (const orderBook of orderBooksArray) {
                        if (!orderBook) continue;

                        // Process asks
                        if (orderBook.asks) {
                            for (const listing of orderBook.asks) {
                                if (!listing.createdTimestamp && listing.listingId) {
                                    const estimatedTimestamp = this.estimateTimestamp(listing.listingId);
                                    listing.createdTimestamp = new Date(estimatedTimestamp).toISOString();
                                } else {
                                    captureRealTimestamp(listing);
                                }
                            }
                        }

                        // Process bids
                        if (orderBook.bids) {
                            for (const listing of orderBook.bids) {
                                if (!listing.createdTimestamp && listing.listingId) {
                                    const estimatedTimestamp = this.estimateTimestamp(listing.listingId);
                                    listing.createdTimestamp = new Date(estimatedTimestamp).toISOString();
                                } else {
                                    captureRealTimestamp(listing);
                                }
                            }
                        }
                    }
                }

                if (observedAnchors.length > 0) {
                    this.addAnchors(observedAnchors);
                }

                // Store with timestamp for staleness tracking
                this._cacheOrderBook(itemHrid, data.marketItemOrderBooks);

                this.currentItemHrid = itemHrid; // Track current item

                // Update market API with fresh prices from order book — every
                // level in one call, so the price listeners hear once per book
                if (orderBooks) {
                    const patches = [];
                    const collect = (orderBook, enhancementLevel) => {
                        if (!orderBook) return; // Skip empty slots in sparse array
                        const topAsk = orderBook.asks?.[0]?.price ?? null;
                        const bids = orderBook.bids;
                        const topBid = bids?.length > 0 ? bids[0].price : null;

                        // Only update if we have at least one price
                        if (topAsk !== null || topBid !== null) {
                            patches.push({ itemHrid, enhancementLevel, ask: topAsk, bid: topBid });
                        }
                    };
                    if (Array.isArray(orderBooks)) {
                        // Enhancement level is the ARRAY INDEX
                        orderBooks.forEach(collect);
                    } else {
                        // Fallback: Handle object format { "0": {...}, "5": {...} }
                        for (const [level, orderBook] of Object.entries(orderBooks)) {
                            collect(orderBook, parseInt(level, 10));
                        }
                    }
                    if (patches.length > 0) {
                        marketAPI.updatePrices(patches);
                    }
                }

                // The save and the repaint wait for the burst to end
                this._scheduleOrderBookRepaint();
            }
        };

        dataManager.on('character_initialized', initHandler);
        dataManager.on('market_listings_updated', updateHandler);
        dataManager.on('market_item_order_books_updated', orderBookHandler);

        // Store for cleanup
        this.unregisterWebSocket = () => {
            dataManager.off('character_initialized', initHandler);
            dataManager.off('market_listings_updated', updateHandler);
            dataManager.off('market_item_order_books_updated', orderBookHandler);
        };
    }

    /**
     * Reconcile knownListings against a full snapshot of currently active listings.
     * Any entry with status 'active' or 'unknown' that is absent from the snapshot
     * is downgraded to 'unknown' — it's no longer active but we don't know why.
     * @param {Array} activeListings - Current active listings from the game snapshot
     */
    _reconcileActiveListings(activeListings) {
        const activeIds = new Set(activeListings.map((l) => l.id));
        let changed = false;
        for (const known of this.knownListings) {
            if (known.status === 'active' && !activeIds.has(known.id)) {
                known.status = 'unknown';
                changed = true;
            }
        }
        if (changed) {
            this._scheduleSave();
        }
    }

    /**
     * Record a listing with its full data
     * @param {Object} listing - Full listing object from WebSocket
     */
    recordListing(listing) {
        this.recordListings([listing]);
    }

    /**
     * Record a batch of listings — a whole snapshot or status update — in one
     * pass: one sort, one rebuild of the estimation points, one (debounced)
     * save, one growth of the anchor pool, however many listings came in.
     * @param {Array<Object>} listings - Full listing objects from WebSocket
     */
    recordListings(listings) {
        if (!Array.isArray(listings) || listings.length === 0) {
            return;
        }

        // One index over the log rather than a scan per listing
        const indexById = new Map();
        this.knownListings.forEach((entry, index) => indexById.set(entry.id, index));

        const newAnchors = [];
        let changed = false;
        let recorded = 0;

        for (const listing of listings) {
            if (!listing || !listing.createdTimestamp) {
                continue;
            }

            const timestamp = new Date(listing.createdTimestamp).getTime();

            // Check if we already have this listing
            const existingIndex = indexById.has(listing.id) ? indexById.get(listing.id) : -1;

            // Determine status (NEVER use listing.status from game data - it's an HRID like "/market_listing_status/active")
            // Priority: new status update from WebSocket > existing status > default unknown
            let status;
            if (listing._toolashaStatus) {
                // Use explicitly set status from updateHandler (canceled/filled detection)
                // This takes priority over existing status (allows status updates)
                status = listing._toolashaStatus;
            } else if (existingIndex !== -1 && this.knownListings[existingIndex].status) {
                // Preserve existing tracked status if no new update
                status = this.knownListings[existingIndex].status;
            } else {
                // Default to unknown for new listings
                status = 'unknown';
            }

            // Add new entry with full data
            const entry = {
                id: listing.id,
                timestamp: timestamp,
                createdTimestamp: listing.createdTimestamp, // ISO string for display
                itemHrid: listing.itemHrid,
                enhancementLevel: listing.enhancementLevel || 0, // For accurate row matching
                price: listing.price,
                orderQuantity: listing.orderQuantity,
                filledQuantity: listing.filledQuantity,
                isSell: listing.isSell,
                status: status,
            };

            if (existingIndex !== -1) {
                // Update existing entry (in case it had incomplete data)
                this.knownListings[existingIndex] = entry;
            } else {
                // Add new entry
                indexById.set(entry.id, this.knownListings.length);
                this.knownListings.push(entry);
            }
            changed = true;
            recorded++;

            // Growth: this id↔time pair is exact, so mirror it into the shared
            // anchor pool too — dedup means re-recording the same id on a later
            // status update is a no-op there.
            newAnchors.push({ id: entry.id, timestamp: entry.timestamp });
        }

        if (!changed) {
            return;
        }

        // Re-sort by ID; retention goes over the log once enough has come in
        // since its last pass, and in any case before the log is saved
        this.knownListings.sort((a, b) => a.id - b.id);
        this._recordedSinceRetention += recorded;
        if (this._recordedSinceRetention >= RETENTION_SWEEP_EVERY) this._applyRetention();
        this.rebuildEstimationPoints();

        // Save to storage (debounced)
        this._scheduleSave();

        this.addAnchors(newAnchors);
    }

    /**
     * Save the listing log once the current run of listing events has ended.
     *
     * Listing events arrive in runs — a bulk sell is one message per listing,
     * a snapshot carries them all — and each save is a read-merge-write of the
     * whole log. A trailing timer folds a run into one save.
     * @returns {Promise<boolean>} Whether that save landed
     */
    _scheduleSave() {
        if (!this._pendingSave) {
            this._pendingSave = new Promise((resolve) => {
                this._resolvePendingSave = resolve;
                this._saveTimer = setTimeout(() => this._runPendingSave(), LISTING_SAVE_DEBOUNCE_MS);
            });
        }
        return this._pendingSave;
    }

    /**
     * Run the save a scheduled debounce is waiting on, now rather than later.
     * @returns {Promise<boolean>} Whether a save landed (true when none was pending)
     */
    flushPendingSave() {
        if (!this._pendingSave) {
            return this._saveChain || Promise.resolve(true);
        }
        clearTimeout(this._saveTimer);
        const pending = this._pendingSave;
        this._runPendingSave();
        return pending;
    }

    /**
     * Apply retention to the log and say whether anything was dropped.
     *
     * Resets the since-last-pass counter either way: a pass that dropped
     * nothing is still a pass.
     * @returns {boolean} Whether the log changed
     * @private
     */
    _applyRetention() {
        this._recordedSinceRetention = 0;
        const kept = applyListingRetention(this.knownListings);
        if (kept === this.knownListings) return false;
        this.knownListings = kept;
        return true;
    }

    /** @private */
    _runPendingSave() {
        const resolve = this._resolvePendingSave;
        this._saveTimer = null;
        this._pendingSave = null;
        this._resolvePendingSave = null;
        // The last moment before the log is written: prune whatever the
        // batch-count gate has not got to yet, so nothing stale is persisted
        if (this._recordedSinceRetention > 0 && this._applyRetention()) this.rebuildEstimationPoints();
        resolve(this.saveHistoricalData());
    }

    /**
     * Redraw the age columns once the current run of order-book messages has
     * ended, and write the cache out once for the lot.
     */
    _scheduleOrderBookRepaint() {
        if (this._repaintTimer) {
            return;
        }
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null;
            this._repaintOrderBooks();
        }, ORDER_BOOK_REPAINT_MS);
    }

    /**
     * The deferred half of an order-book message: persist the cache and, when
     * the age column is on, clear and redraw it with the fresh books.
     */
    _repaintOrderBooks() {
        // Save to storage (debounced)
        this.saveOrderBooksCache();

        // Re-render display elements only if the listing age display is enabled
        if (!config.getSetting('market_showEstimatedListingAge')) {
            return;
        }

        // Clear processed flags to re-render with new data
        document.querySelectorAll('.mwi-estimated-age-set').forEach((container) => {
            container.classList.remove('mwi-estimated-age-set');
        });

        // Also clear listing price display flags so Top Order Age updates
        document.querySelectorAll('.mwi-listing-prices-set').forEach((table) => {
            table.classList.remove('mwi-listing-prices-set');
        });

        // Manually re-process any existing containers (handles race condition where
        // container appeared before WebSocket data arrived)
        document.querySelectorAll('[class*="MarketplacePanel_orderBooksContainer"]').forEach((container) => {
            this.processOrderBook(container);
        });
    }

    /**
     * Setup DOM observer to watch for order book table
     */
    setupObserver() {
        // Observe the main order book container
        this.unregisterObserver = domObserver.onClass(
            'EstimatedListingAge',
            'MarketplacePanel_orderBooksContainer',
            (container) => {
                this.processOrderBook(container);
            }
        );
    }

    /**
     * Setup DOM observer for My Listings table to detect expired listings
     */
    setupMyListingsObserver() {
        // Watch for the My Listings table container
        this.unregisterMyListingsObserver = domObserver.onClass(
            'EstimatedListingAge_MyListings',
            // Base class only — onClass matches on a substring, and the game's
            // hash suffix rehashes on every UI rebuild.
            'MarketplacePanel_myListingsTableContainer',
            (container) => {
                this.checkForExpiredListings(container);
            }
        );
    }

    /**
     * Check for expired listings in the My Listings table
     * @param {HTMLElement} container - My Listings table container
     */
    async checkForExpiredListings(container) {
        const tbody = container.querySelector('table tbody');
        if (!tbody) {
            return;
        }

        const rows = tbody.querySelectorAll('tr');

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex];

            try {
                const allCells = row.querySelectorAll('td');

                // Get status cell (first td)
                const statusCell = allCells[0];
                if (!statusCell) continue;

                const statusText = statusCell.textContent.trim();

                if (statusText !== 'Expired') continue;

                // Extract Type (Buy/Sell)
                const typeCell = allCells[1];
                const typeText = typeCell?.textContent.trim();
                const isSell = typeText === 'Sell';

                // Extract Progress (e.g., "0 / 1")
                // The cell has multiple nested divs. The progress text is in the LAST div overall.
                const progressCell = allCells[2];
                const allDivsInCell = progressCell?.querySelectorAll('div');
                const progressDiv = allDivsInCell ? allDivsInCell[allDivsInCell.length - 1] : null;
                const progressText = progressDiv?.textContent.trim();

                const progressMatch = progressText?.match(/(\d+)\s*\/\s*(\d+)/);

                if (!progressMatch) continue;

                const filledQuantity = parseInt(progressMatch[1], 10);
                const orderQuantity = parseInt(progressMatch[2], 10);

                // Extract Price
                const priceCell = allCells[3];
                const priceText = priceCell?.textContent.trim();
                const price = this.parsePrice(priceText);

                if (price === null) continue;

                // Extract item HRID from the row's item icon (disambiguates listings that
                // collide on side/price/quantity across different items)
                let itemHrid = null;
                for (const use of row.querySelectorAll('use')) {
                    const href = use.href && use.href.baseVal ? use.href.baseVal : '';
                    if (href.includes('#')) {
                        const idPart = href.split('#')[1];
                        if (idPart && !idPart.toLowerCase().includes('coin')) {
                            itemHrid = `/items/${idPart}`;
                            break;
                        }
                    }
                }

                // Extract enhancement level (disambiguates two listings of the same item
                // at different levels that happen to share side/price/quantity — a +0 and
                // a +10 of the same equipment can easily collide on all three)
                let enhancementLevel = 0;
                const enhNode = row.querySelector('[class*="enhancementLevel"]');
                if (enhNode && enhNode.textContent) {
                    const enhMatch = enhNode.textContent.match(/\+\s*(\d+)/);
                    if (enhMatch) enhancementLevel = Number(enhMatch[1]);
                }

                // Find matching listing in our stored data (only active/unknown listings
                // are candidates — already-resolved listings must not be re-marked)
                const matchingListing = this.knownListings.find((listing) =>
                    matchesExpiredRow(listing, {
                        itemHrid,
                        enhancementLevel,
                        isSell,
                        price,
                        orderQuantity,
                        filledQuantity,
                    })
                );

                if (matchingListing && matchingListing.status !== 'expired') {
                    matchingListing.status = 'expired';
                    await this.saveHistoricalData();
                }
            } catch (error) {
                console.error(`[EstimatedListingAge] Error processing expired listing row:`, error);
            }
        }
    }

    /**
     * Parse price string (handles K/M/B suffixes)
     * @param {string} priceText - Price text (e.g., "12M", "1.5K", "100")
     * @returns {number|null} Parsed price or null if invalid
     */
    parsePrice(priceText) {
        if (!priceText) return null;

        // Strip a trailing "*" marker: post-rework, My Listings flags any listing
        // whose original limit price differs from its resting boundary price with
        // a "*". The $-anchored regex below would otherwise reject the whole cell.
        const normalized = priceText.trim().toUpperCase().replace(/\*+$/, '').trim();
        const match = normalized.match(/^([\d,.]+)([KMBT])?$/);

        if (!match) return null;

        // Remove commas from number
        const value = parseGameNumber(match[1]);
        const suffix = match[2];

        if (isNaN(value)) return null;

        switch (suffix) {
            case 'K':
                return Math.round(value * 1000);
            case 'M':
                return Math.round(value * 1000000);
            case 'B':
                return Math.round(value * 1000000000);
            case 'T':
                return Math.round(value * 1000000000000);
            default:
                return Math.round(value);
        }
    }

    /**
     * Process the order book container and inject age estimates
     * @param {HTMLElement} container - Order book container
     */
    processOrderBook(container) {
        if (container.classList.contains('mwi-estimated-age-set')) {
            return;
        }

        // Find the buy and sell tables
        const tables = container.querySelectorAll('table');

        if (tables.length < 2) {
            return; // Need both buy and sell tables
        }

        // Mark as processed
        container.classList.add('mwi-estimated-age-set');

        // Process both tables
        tables.forEach((table) => {
            this.addAgeColumn(table);
        });
    }

    /**
     * Add estimated age column to order book table
     * @param {HTMLElement} table - Order book table
     */
    addAgeColumn(table) {
        const thead = table.querySelector('thead tr');
        const tbody = table.querySelector('tbody');

        if (!thead || !tbody) {
            return;
        }

        // Remove existing age column elements if they exist (RWI pattern)
        thead.querySelectorAll('.mwi-estimated-age-header').forEach((el) => el.remove());
        tbody.querySelectorAll('.mwi-estimated-age-cell').forEach((el) => el.remove());

        // Get current item and order book data
        const currentItemHrid = this.getCurrentItemHrid();

        if (!currentItemHrid || !this.orderBooksCache[currentItemHrid]) {
            return;
        }

        const cacheEntry = this.orderBooksCache[currentItemHrid];
        // Support both old format (direct data) and new format ({data, lastUpdated})
        const orderBookData = cacheEntry.data || cacheEntry;

        // Get current enhancement level being viewed
        const enhancementLevel = this.getCurrentEnhancementLevel();

        // Determine if this is buy or sell table (asks = sell, bids = buy)
        const isSellTable =
            table.closest('[class*="orderBookTableContainer"]') ===
            table.closest('[class*="orderBooksContainer"]')?.children[0];

        // Access orderBooks by enhancement level (orderBooks is an object, not array)
        // For non-equipment items, only level 0 exists
        // For equipment, there can be orderBooks[0], orderBooks[1], etc.
        const orderBookAtLevel = orderBookData.orderBooks?.[enhancementLevel];

        if (!orderBookAtLevel) {
            // No order book data for this enhancement level
            return;
        }

        const listings = isSellTable ? orderBookAtLevel.asks || [] : orderBookAtLevel.bids || [];

        // Add header
        const header = document.createElement('th');
        header.classList.add('mwi-estimated-age-header');
        header.textContent = '~Age';
        header.title = 'Estimated listing age (based on listing ID)';
        thead.appendChild(header);

        // Track which of user's listings have been matched to prevent duplicates
        const usedListingIds = new Set();

        // Add age cells to each row
        const rows = tbody.querySelectorAll('tr');
        let index = 0;

        rows.forEach((row) => {
            const cell = document.createElement('td');
            cell.classList.add('mwi-estimated-age-cell');

            // The "Outside current tradable range" grouping row is a real <tr>
            // with no order-book listing behind it. Skip it without consuming an
            // index, or it steals the next listing's age and every row after it
            // shifts out of alignment
            if (row.matches('[class*="MarketplacePanel_outsideRangeSeparator"]')) {
                row.appendChild(cell);
                return;
            }

            if (index < listings.length) {
                // Top 20 listings from order book (use positional indexing like RWI)
                const listing = listings[index];
                const listingId = listing.listingId;

                // Check if this is YOUR listing (and not already matched)
                const yourListing = this.knownListings.find(
                    (known) => known.id === listingId && !usedListingIds.has(known.id)
                );

                if (yourListing) {
                    // Mark this listing as used
                    usedListingIds.add(yourListing.id);

                    // Exact timestamp for your listing
                    const formatted = this.formatTimestamp(yourListing.timestamp);
                    cell.textContent = formatted; // No tilde for exact timestamps
                    cell.style.color = '#00FF00'; // Green for YOUR listing
                    cell.style.fontSize = '0.9em';
                } else {
                    // Estimated timestamp for other listings
                    const estimatedTimestamp = this.estimateTimestamp(listingId);
                    const formatted = this.formatTimestamp(estimatedTimestamp);
                    cell.textContent = `~${formatted}`;
                    cell.style.color = '#999999'; // Gray to indicate estimate
                    cell.style.fontSize = '0.9em';
                }
            } else if (index === listings.length) {
                // Ellipsis row
                cell.textContent = '· · ·';
                cell.style.color = '#666666';
                cell.style.fontSize = '0.9em';
            } else {
                // Beyond top 20 - YOUR listings only
                const hasCancel = row.textContent.includes('Cancel');
                if (hasCancel) {
                    // Extract price and quantity for matching
                    const priceText = row.querySelector('[class*="price"]')?.textContent || '';
                    const quantityText = row.children[0]?.textContent || '';
                    const price = this.parsePrice(priceText);
                    // A null price coerces to 0 in the priceMatch below and can
                    // suppress a correct match, so skip the row (this is inside a
                    // rows.forEach, so return, not continue). Ported from 2.85.0.
                    if (price === null) return;
                    const quantity = this.parseQuantity(quantityText);

                    // Get currently active listings to validate matches
                    const activeListings = dataManager.getMarketListings();
                    const activeListingIds = new Set(activeListings.map((l) => l.id));

                    // Match from knownListings (filtering out already-used and top-20 listings)
                    // Find ALL potential matches, then pick the newest one (highest ID)
                    const allOrderBookIds = new Set(listings.map((l) => l.listingId));
                    const potentialMatches = this.knownListings.filter((listing) => {
                        if (usedListingIds.has(listing.id)) return false;
                        if (allOrderBookIds.has(listing.id)) return false; // Skip top 20
                        if (!activeListingIds.has(listing.id)) return false; // Only match active listings

                        return matchesBeyondTopRow(listing, {
                            itemHrid: currentItemHrid,
                            enhancementLevel,
                            price,
                            quantity,
                            isSell: isSellTable,
                        });
                    });

                    // Pick the first match (oldest ID) to preserve DOM order
                    const matchedListing = potentialMatches.length > 0 ? potentialMatches[0] : null;

                    if (matchedListing) {
                        usedListingIds.add(matchedListing.id);
                        const formatted = this.formatTimestamp(matchedListing.timestamp);
                        cell.textContent = formatted;
                        cell.style.color = '#00FF00'; // Green for YOUR listing
                        cell.style.fontSize = '0.9em';
                    } else {
                        cell.textContent = '~Unknown';
                        cell.style.color = '#666666';
                        cell.style.fontSize = '0.9em';
                    }
                } else {
                    cell.textContent = '· · ·';
                    cell.style.color = '#666666';
                    cell.style.fontSize = '0.9em';
                }
            }

            row.appendChild(cell);
            index++;
        });
    }

    /**
     * Get current item HRID being viewed in order book
     * @returns {string|null} Item HRID or null
     */
    getCurrentItemHrid() {
        // PRIMARY: Check for current item element (same as RWI approach)
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (currentItemElement) {
            const useElement = currentItemElement.querySelector('use');
            if (useElement && useElement.href && useElement.href.baseVal) {
                const itemHrid = '/items/' + useElement.href.baseVal.split('#')[1];
                return itemHrid;
            }
        }

        // SECONDARY: Use WebSocket tracked item
        if (this.currentItemHrid) {
            return this.currentItemHrid;
        }

        // TERTIARY: Try to find from YOUR listings in the order book
        const orderBookContainer = document.querySelector('[class*="MarketplacePanel_orderBooksContainer"]');
        if (!orderBookContainer) {
            return null;
        }

        const tables = orderBookContainer.querySelectorAll('table');
        for (const table of tables) {
            const rows = table.querySelectorAll('tbody tr');
            for (const row of rows) {
                const hasCancel = row.textContent.includes('Cancel');
                if (hasCancel) {
                    const priceText = row.querySelector('[class*="price"]')?.textContent || '';
                    const quantityText = row.children[0]?.textContent || '';

                    const price = this.parsePrice(priceText);
                    // parsePrice returns null on empty/invalid text; a null price
                    // coerces to 0 in the match below and can suppress a correct
                    // match, so skip the row (ported from upstream 2.85.0).
                    if (price === null) continue;
                    const quantity = this.parseQuantity(quantityText);

                    // Find matching listings from YOUR listings. Unlike matchesExpiredRow/
                    // matchesBeyondTopRow this cannot also compare itemHrid or enhancementLevel
                    // — the item is exactly what this branch is trying to learn, and no
                    // enhancement badge is available without the current-item element that
                    // sent us to TERTIARY in the first place. So two of your own listings for
                    // different items that happen to share a price and a remaining quantity
                    // are genuinely ambiguous here: return every match rather than only the
                    // first, and only use it when they all agree on the item.
                    const matches = this.knownListings.filter((listing) => {
                        const priceMatch = Math.abs(listing.price - price) < 0.01;
                        const qtyMatch = listing.orderQuantity - listing.filledQuantity === quantity;
                        return priceMatch && qtyMatch;
                    });

                    if (matches.length > 0 && matches.every((listing) => listing.itemHrid === matches[0].itemHrid)) {
                        return matches[0].itemHrid;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Get current enhancement level being viewed in order book
     * @returns {number} Enhancement level (0 for non-equipment)
     */
    getCurrentEnhancementLevel() {
        // Check for enhancement level indicator in the current item display
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (currentItemElement) {
            const enhancementElement = currentItemElement.querySelector('[class*="Item_enhancementLevel"]');
            if (enhancementElement) {
                const match = enhancementElement.textContent.match(/\+(\d+)/);
                if (match) {
                    return parseInt(match[1], 10);
                }
            }
        }

        // Default to enhancement level 0 (non-equipment or base equipment)
        return 0;
    }

    /**
     * Parse quantity from text (handles K/M suffixes)
     * @param {string} text - Quantity text
     * @returns {number} Quantity value
     */
    parseQuantity(text) {
        let multiplier = 1;
        if (text.toUpperCase().includes('K')) {
            multiplier = 1000;
            text = text.replace(/K/gi, '');
        } else if (text.toUpperCase().includes('M')) {
            multiplier = 1000000;
            text = text.replace(/M/gi, '');
        }
        const numStr = text.replace(/[^0-9.]/g, '');
        return numStr ? Number(numStr) * multiplier : 0;
    }

    /**
     * Get color based on data staleness
     * @param {number} lastUpdated - Timestamp when data was last updated
     * @returns {string} Color code for display
     */
    getStalenessColor(lastUpdated) {
        if (!lastUpdated) {
            return '#999999'; // Gray for unknown age
        }

        const age = Date.now() - lastUpdated;
        const minutes = age / (60 * 1000);
        const hours = age / (60 * 60 * 1000);

        if (minutes < 15) return '#00AA00'; // < 15 min: dark green (fresh)
        if (hours < 1) return '#00FF00'; // < 1 hour: light green (recent)
        if (hours < 4) return '#FFAA00'; // < 4 hours: yellow (moderate)
        if (hours < 12) return '#FF6600'; // < 12 hours: orange (stale)
        return '#FF0000'; // 12+ hours: red (very stale)
    }

    /**
     * Get tooltip text for staleness
     * @param {number} lastUpdated - Timestamp when data was last updated
     * @returns {string} Tooltip text
     */
    getStalenessTooltip(lastUpdated) {
        if (!lastUpdated) {
            return 'Order book data - Visit market page to refresh';
        }

        const age = Date.now() - lastUpdated;
        const relativeTime = formatRelativeTime(age);
        return `Order book data from ${relativeTime} ago - Visit market page to refresh`;
    }

    /**
     * Estimate timestamp for a listing ID
     * @param {number} listingId - Listing ID to estimate
     * @returns {number} Estimated timestamp in milliseconds
     */
    estimateTimestamp(listingId) {
        const points = this.estimationPoints;

        if (points.length === 0) {
            // No data, assume recent (1 hour ago)
            return Date.now() - 60 * 60 * 1000;
        }

        if (points.length === 1) {
            // Only one data point, use it
            return points[0].timestamp;
        }

        const minId = points[0].id;
        const maxId = points[points.length - 1].id;

        let estimate;
        // Check if ID is within known range
        if (listingId >= minId && listingId <= maxId) {
            estimate = this.linearInterpolation(listingId);
        } else {
            estimate = this.linearRegression(listingId);
        }

        // CRITICAL: Clamp to reasonable bounds
        const now = Date.now();

        // Never allow future timestamps (listings cannot be created in the future)
        if (estimate > now) {
            estimate = now;
        }

        return estimate;
    }

    /**
     * Linear interpolation for IDs within known range
     * @param {number} listingId - Listing ID
     * @returns {number} Estimated timestamp
     */
    linearInterpolation(listingId) {
        const points = this.estimationPoints;

        // Check for exact match
        const exact = points.find((entry) => entry.id === listingId);
        if (exact) {
            return exact.timestamp;
        }

        // Find surrounding points
        let leftIndex = 0;
        let rightIndex = points.length - 1;

        for (let i = 0; i < points.length - 1; i++) {
            if (listingId >= points[i].id && listingId <= points[i + 1].id) {
                leftIndex = i;
                rightIndex = i + 1;
                break;
            }
        }

        const left = points[leftIndex];
        const right = points[rightIndex];

        // Linear interpolation formula
        const idRange = right.id - left.id;
        const idOffset = listingId - left.id;
        const ratio = idOffset / idRange;

        return left.timestamp + ratio * (right.timestamp - left.timestamp);
    }

    /**
     * Linear regression for IDs outside known range
     * @param {number} listingId - Listing ID
     * @returns {number} Estimated timestamp
     */
    linearRegression(listingId) {
        const points = this.estimationPoints;

        // Calculate linear regression slope
        let sumX = 0,
            sumY = 0;
        for (const entry of points) {
            sumX += entry.id;
            sumY += entry.timestamp;
        }

        const n = points.length;
        const meanX = sumX / n;
        const meanY = sumY / n;

        let numerator = 0;
        let denominator = 0;
        for (const entry of points) {
            numerator += (entry.id - meanX) * (entry.timestamp - meanY);
            denominator += (entry.id - meanX) * (entry.id - meanX);
        }

        const slope = numerator / denominator;

        // Get boundary points
        const minId = points[0].id;
        const maxId = points[points.length - 1].id;
        const minTimestamp = points[0].timestamp;
        const maxTimestamp = points[points.length - 1].timestamp;

        // Extrapolate from closest boundary (RWI approach)
        // This prevents drift from large intercept values
        if (listingId > maxId) {
            return slope * (listingId - maxId) + maxTimestamp;
        } else {
            return slope * (listingId - minId) + minTimestamp;
        }
    }

    /**
     * Clear all injected displays
     */
    clearDisplays() {
        // Disable runs in contexts with no DOM at all (tests, a teardown after
        // the page has gone); without this the throw took the rest of disable
        // down with it
        if (typeof document === 'undefined') return;
        document.querySelectorAll('.mwi-estimated-age-set').forEach((container) => {
            container.classList.remove('mwi-estimated-age-set');
        });
        document.querySelectorAll('.mwi-estimated-age-header').forEach((el) => el.remove());
        document.querySelectorAll('.mwi-estimated-age-cell').forEach((el) => el.remove());
    }

    /**
     * Disable the estimated listing age feature
     */
    async disable() {
        try {
            if (this.unregisterWebSocket) {
                this.unregisterWebSocket();
                this.unregisterWebSocket = null;
            }

            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            if (this.unregisterMyListingsObserver) {
                this.unregisterMyListingsObserver();
                this.unregisterMyListingsObserver = null;
            }

            if (this._repaintTimer) {
                clearTimeout(this._repaintTimer);
                this._repaintTimer = null;
            }
            if (this._pageHideHandler && typeof window !== 'undefined') {
                window.removeEventListener('pagehide', this._pageHideHandler);
                this._pageHideHandler = null;
            }
            // A save still waiting on its debounce goes out now — and is
            // waited for, which is the whole point of flushing it here.
            //
            // `saveHistoricalData` is a read-merge-write: it reads
            // `this.knownListings` again after its probe resumes, so without
            // this await the `finally` below emptied the log first and the
            // flush wrote `[]` over it. The key it lands under is the one the
            // save captured when it was asked for, not whoever is current when
            // it runs — and the registry can only hold the switch back for a
            // teardown that hands it a promise.
            await this.flushPendingSave();

            this.clearDisplays();

            this.isInitialized = false;
        } catch (error) {
            console.error('[Estimated Listing Age] Disable failed part-way:', error);
        } finally {
            // Per-character memory, dropped once the flush above has written it
            // out — and in the `finally` because it must go even if some earlier
            // step threw. The listing log and the order-book cache are stored
            // under the *current* character's key; kept in memory across a
            // switch, they were merged into the next character's stored log
            // (memory winning) and saved back under the new character's key.
            // That is a permanent cross-character pollution no later correct
            // load can undo. The anchor pool is deliberately kept: it is shared
            // calibration data, keyed globally rather than per character.
            //
            // Bumped here rather than at the top of `disable()` so the flush
            // above still counts as this character's: from this point on, work
            // that suspended holding the old log stands down instead of writing
            // the emptiness under whoever's key is current.
            this._generation += 1;
            this.knownListings = [];
            this.estimationPoints = [];
            this.orderBooksCache = {};
            this.currentItemHrid = null;
            this._recordedSinceRetention = 0;
            this.rebuildEstimationPoints();
            this.isInitialized = false;
        }
    }
}

const estimatedListingAge = new EstimatedListingAge();

/*
 * Registered so a cross-device sync PULL combines this log instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: LISTINGS_STORE,
    base: LISTINGS_BASE,
    merge: mergeListingLogs,
    label: 'Market listing log',
});

/*
 * The anchor pool is the module's other growth-only record, and it lives in a
 * global key rather than a scoped one — so nothing above claimed it and a pull
 * wrote it whole, discarding every calibration point the receiving device had
 * collected. An exact-key registration, since ANCHORS_KEY is not scoped.
 */
registerSyncMerge({
    store: LISTINGS_STORE,
    key: ANCHORS_KEY,
    merge: mergeAnchorPools,
    label: 'Market listing anchors',
});

export default estimatedListingAge;
export {
    ANCHOR_POOL_MAX,
    LISTING_RETENTION_MS,
    LISTING_RETENTION_MAX,
    RETENTION_SWEEP_EVERY,
    applyListingRetention,
    ORDER_BOOK_CACHE_MAX_ITEMS,
    ORDER_BOOK_PERSISTED_ROWS,
    LISTING_SAVE_DEBOUNCE_MS,
    ORDER_BOOK_REPAINT_MS,
    mergeListingLogs,
    matchesExpiredRow,
    matchesBeyondTopRow,
};
