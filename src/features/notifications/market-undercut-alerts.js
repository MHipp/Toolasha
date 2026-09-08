/**
 * Market Undercut Alerts
 *
 * Says so when a sell listing of yours is no longer the best ask — someone has
 * posted cheaper, and your listing sits behind theirs until you reprice — and
 * symmetrically when a buy order of yours is no longer the best bid.
 *
 * ## Where the comparison comes from
 *
 * Your side is the game's own `myMarketListings`, kept current by the data
 * manager on every `market_listings_updated`; only listings the server calls
 * active are compared, because a filled or cancelled listing has no price to
 * defend. The market's side is the freshest of two figures: the marketplace API
 * cache — the API snapshot patched by any order book you have opened since — and,
 * when the price history panel is on, the newest sighting of the item in the
 * pooled Mooket dataset. That second source is what makes the alert work
 * passively: the game's `marketplace.json` refreshes only about once an hour, so
 * for an item you have not opened its snapshot is usually older than the fifteen
 * minutes a figure is allowed to be and still count — the undercut is real but
 * unprovable, and the alert stays silent. A Mooket sighting is typically minutes
 * old, so it clears that bar.
 *
 * Every message carries the true age of whichever figure it used, a figure older
 * than the fifteen-minute window proves nothing and fires nothing, and an item
 * neither source can price is unknown rather than undercut.
 *
 * ## Repeats
 *
 * One armed bit per listing (the `listingBeaten` predicate) makes each undercut
 * one event: the bit disarms on the first announcement and re-arms only when
 * the situation resolves — you reprice, or the undercutter's stock sells out
 * and your price is best again — or when you edit the listing, which resets its
 * state entirely. The event key carries the listing id, so the service's
 * cooldown throttles each listing separately and a noisy market cannot spend
 * one listing's silence on another's news.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import marketHistoryAPI from '../market/mooket/market-history-api.js';
import { freshestSighting } from '../market/mooket/market-history-data.js';
import notificationService from './notification-service.js';
import { listingBeaten } from './notification-predicates.js';
import { formatKMB3Digits, formatRelativeTime } from '../../utils/formatters.js';
import { runPool } from '../../utils/async-pool.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_marketListingUndercut';

/** Reading the pooled dataset is what authorises the fresher Mooket lookups */
const POOLED_HISTORY_SETTING = 'market_pooledHistory';

/** The status HRID the server puts on a listing that is still on the board */
const ACTIVE_STATUS = '/market_listing_status/active';

/** Kept low so refreshing a long listing list does not burst the third-party server */
const MOOKET_CONCURRENCY = 4;

class MarketUndercutAlerts {
    constructor() {
        /** listingId → {armed, price}; price so an edit is seen as a fresh start */
        this.listingStates = new Map();
        /** `itemHrid:level` → {ask, bid, timestamp}; the newest Mooket sighting held */
        this.mooketObservations = new Map();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        /** Holds the active-refresh interval so cleanup can clear it */
        this.timers = createTimerRegistry();
        /** True while a forced refresh is in flight, so an overlapping tick is skipped */
        this.refreshInFlight = false;
        /** True while a Mooket refresh is in flight, so an overlapping tick is skipped */
        this.mooketRefreshInFlight = false;
        /** Whether the listeners and the refresh timer are already up */
        this.isInitialized = false;
    }

    /**
     * Start watching listings and prices.
     * @returns {Promise<void>}
     */
    async initialize() {
        // The feature registry retries features that failed to start. A second
        // run here would add a second handler pair, a second 15-minute refresh
        // timer, and a second stream of third-party Mooket requests — the last
        // of which is somebody else's rate limit being spent twice over.
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.isInitialized = true;

        const handler = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[MarketUndercutAlerts] Checking listings failed:', error);
            }
        };

        // Both halves of the comparison can move: the listings on a market
        // message, the prices on an API refresh or an opened order book
        dataManager.on('character_initialized', handler);
        dataManager.on('market_listings_updated', handler);
        this.unregisterHandlers.push(() => {
            dataManager.off('character_initialized', handler);
            dataManager.off('market_listings_updated', handler);
        });

        marketAPI.on(handler);
        this.unregisterHandlers.push(() => marketAPI.off(handler));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);

        this.startActiveRefresh();
        // Seed the Mooket figures now rather than waiting a whole cache window,
        // so an item already undercut at login can be caught on the first look
        this.refreshMooketObservations();
    }

    /**
     * Keep the market snapshot from going stale on a timer while alerts are on.
     *
     * Without this, nothing calls `marketAPI.fetch()` after startup, so the bulk
     * snapshot goes stale and the only fresh per-item price is the order-book
     * patch that lands when the player opens an item's view. An undercut that
     * happened hours ago against an item never opened would then read as "still
     * best" against the stale snapshot.
     *
     * The cadence is the market cache's own 15-minute window, and the tick calls
     * the *cache-respecting* `marketAPI.fetch()` — not the forcing `fetch(true)`.
     * That is the crucial politeness: `marketplace.json` is rate-limited by the
     * game (a burst of requests, often several userscripts at once, trips a
     * temporary CloudFront 403), so this must never pull faster than the cache
     * would on its own. A tick whose cache is still valid returns the cached copy
     * with no network hit and simply re-notifies listeners; only a tick that
     * finds the cache expired makes a real request — at most one per 15 minutes.
     * There is deliberately no shorter, configurable interval.
     */
    startActiveRefresh() {
        const intervalId = setInterval(() => {
            this.refreshSnapshot();
            this.refreshMooketObservations();
        }, marketAPI.CACHE_DURATION);
        this.timers.registerInterval(intervalId);
    }

    /**
     * Pull each active listing's newest Mooket sighting into the local cache.
     *
     * Only when the price history panel is on — that switch is what authorises
     * talking to the third-party pool at all. The lookups are the same cache in
     * front of the same server the history chart uses (a five-minute TTL), so a
     * fifteen-minute tick mostly reuses what is already held; the point is a price
     * fresh enough to clear the fifteen-minute evidence bar the game's hourly
     * snapshot cannot. Skips its own overlapping ticks, and re-runs the check once
     * with whatever it learned.
     *
     * @returns {Promise<void>}
     */
    async refreshMooketObservations() {
        if (!config.getSetting(POOLED_HISTORY_SETTING)) return;
        if (this.mooketRefreshInFlight) return;

        const items = this.distinctActiveItems();
        if (!items.length) return;

        this.mooketRefreshInFlight = true;
        let learned = false;
        try {
            await runPool(items, MOOKET_CONCURRENCY, async (item) => {
                try {
                    const rows = await marketHistoryAPI.fetchHistory(item.itemHrid, item.enhancementLevel, 1);
                    const sighting = freshestSighting(rows);
                    if (!sighting || (sighting.ask === null && sighting.bid === null)) return;
                    this.mooketObservations.set(`${item.itemHrid}:${item.enhancementLevel}`, {
                        ask: sighting.ask,
                        bid: sighting.bid,
                        timestamp: sighting.time,
                    });
                    learned = true;
                } catch (error) {
                    console.error('[MarketUndercutAlerts] Mooket lookup failed:', item.itemHrid, error);
                }
            });
        } finally {
            this.mooketRefreshInFlight = false;
        }

        if (learned) this.check();
    }

    /**
     * The distinct items behind your active listings.
     * @returns {Array<{itemHrid: string, enhancementLevel: number}>}
     */
    distinctActiveItems() {
        const byKey = new Map();
        for (const listing of dataManager.getMarketListings()) {
            if (listing?.status !== ACTIVE_STATUS || !listing.itemHrid) continue;
            const enhancementLevel = listing.enhancementLevel || 0;
            const key = `${listing.itemHrid}:${enhancementLevel}`;
            if (!byKey.has(key)) byKey.set(key, { itemHrid: listing.itemHrid, enhancementLevel });
        }
        return [...byKey.values()];
    }

    /**
     * Refresh the snapshot through the cache, skipping the tick if one is in flight.
     *
     * Uses the cache-respecting `fetch()`: it only touches the network when the
     * 15-minute cache has expired, so it can never contribute to rate-limiting
     * beyond what the cache already permits.
     */
    async refreshSnapshot() {
        if (this.refreshInFlight) {
            // A previous fetch has not settled; do not stack a second one
            return;
        }

        this.refreshInFlight = true;
        try {
            await marketAPI.fetch();
        } catch (error) {
            console.error('[MarketUndercutAlerts] Market snapshot refresh failed:', error);
        } finally {
            this.refreshInFlight = false;
        }
    }

    /**
     * The freshest dated figure for the one side of an item that matters, across
     * both sources.
     *
     * A sell listing is defended against the best ask, a buy order against the
     * best bid, so only that side is considered — and a source that does not quote
     * it (an empty book, a Mooket sighting with no bids) contributes nothing even
     * when it is the newest. Of the sources that do quote the side, the newest
     * wins, carrying its own true timestamp so the message's age stays honest.
     *
     * The game figure mirrors `getPrice`'s own choice between the API snapshot and
     * a fresher order-book patch, to recover the right timestamp for it. The
     * Mooket figure is the last sighting {@link refreshMooketObservations} pulled.
     *
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @param {boolean} isSell - Sell listing (best ask) rather than buy order (best bid)
     * @returns {{price: number, timestamp: number}|null} The figure and when it was true
     */
    sideObservation(itemHrid, enhancementLevel, isSell) {
        const candidates = [];

        const price = marketAPI.getPrice(itemHrid, enhancementLevel);
        if (price) {
            const patch = marketAPI.pricePatchs?.[`${itemHrid}:${enhancementLevel}`];
            const usedPatch =
                !!patch && typeof patch.timestamp === 'number' && patch.timestamp > marketAPI.lastFetchTimestamp;
            const timestamp = usedPatch ? patch.timestamp : marketAPI.lastFetchTimestamp;
            const sidePrice = isSell ? price.ask : price.bid;
            if (Number.isFinite(timestamp) && Number.isFinite(sidePrice)) {
                candidates.push({ price: sidePrice, timestamp });
            }
        }

        const mooket = this.mooketObservations.get(`${itemHrid}:${enhancementLevel}`);
        if (mooket) {
            const sidePrice = isSell ? mooket.ask : mooket.bid;
            if (Number.isFinite(mooket.timestamp) && Number.isFinite(sidePrice)) {
                candidates.push({ price: sidePrice, timestamp: mooket.timestamp });
            }
        }

        if (!candidates.length) return null;
        return candidates.reduce((freshest, candidate) =>
            candidate.timestamp > freshest.timestamp ? candidate : freshest
        );
    }

    /**
     * Compare every active listing against the market, and say what changed.
     */
    check() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const listings = dataManager.getMarketListings().filter((listing) => listing?.status === ACTIVE_STATUS);
        const seen = new Set();

        for (const listing of listings) {
            if (listing.id === undefined || listing.id === null) continue;
            seen.add(listing.id);
            this.evaluateListing(listing);
        }

        // A listing that left the board — filled, cancelled, expired — takes
        // its state with it; the id will never be seen again
        for (const id of this.listingStates.keys()) {
            if (!seen.has(id)) this.listingStates.delete(id);
        }
    }

    /**
     * Run one listing through the predicate and announce a firing.
     * @param {Object} listing - An active listing from `myMarketListings`
     */
    evaluateListing(listing) {
        let state = this.listingStates.get(listing.id);
        if (!state || state.price !== listing.price) {
            // New to us, or repriced — either way the player has acted since
            // anything was last said, so a fresh undercut is fresh news. The
            // generation counter is folded into the notification's event key
            // below: the service's own cooldown is keyed on that string, and
            // without a change to it a reprice made seconds after an undercut
            // alert — chasing a falling market down — would raise `armed`
            // back to true only for the service's ten-minute cooldown on the
            // unchanged listing id to eat the very notification `armed` was
            // just reset to allow.
            const generation = (state?.generation || 0) + 1;
            state = { armed: true, price: listing.price, generation };
            this.listingStates.set(listing.id, state);
        }

        const observation = this.sideObservation(
            listing.itemHrid,
            listing.enhancementLevel || 0,
            listing.isSell === true
        );
        const bestPrice = observation ? observation.price : null;
        const priceAgeMs = observation ? Date.now() - observation.timestamp : null;

        const { fire, armed } = listingBeaten({
            armed: state.armed,
            isSell: listing.isSell === true,
            listingPrice: listing.price,
            bestPrice,
            priceAgeMs,
            maxPriceAgeMs: marketAPI.CACHE_DURATION,
        });
        if (!fire) {
            state.armed = armed;
            return;
        }

        const result = notificationService.notify(
            `market-undercut-${listing.id}:${state.generation}`,
            this.buildMessage(listing, bestPrice, priceAgeMs),
            {
                title: listing.isSell ? 'Listing undercut' : 'Buy order outbid',
                // Delivery metadata, not a change of mind about what is worth
                // saying: it is what lets a digest read "3 undercuts (Cheese, Milk,
                // Flax)" rather than just counting to three
                subject: this.itemLabel(listing),
            }
        );

        // Disarmed only once the notice actually reached the player. Disarming
        // on every crossing regardless of delivery — no toast host mounted yet,
        // most likely, right after a fresh load — left an undercut that fired
        // into no channel un-retried until the listing resolved and was beaten
        // again, which for a price that never recovers is never.
        if (result?.fired) state.armed = armed;
    }

    /**
     * The item a listing is for, named the way the player sees it.
     * @param {Object} listing - A market listing
     * @returns {string} Item name, carrying the enhancement level when there is one
     */
    itemLabel(listing) {
        const baseName = dataManager.getItemDetails(listing.itemHrid)?.name || listing.itemHrid;
        const level = listing.enhancementLevel || 0;
        return level > 0 ? `${baseName} +${level}` : baseName;
    }

    /**
     * The message, carrying both prices and the age of the market figure.
     *
     * The age is the honesty clause: the figure can be up to fifteen minutes
     * old, and "ask now 274K" without saying *when* would claim a precision the
     * cache does not have.
     *
     * @param {Object} listing - The beaten listing
     * @param {number} bestPrice - The price that beat it
     * @param {number} priceAgeMs - How old that figure is
     * @returns {string} What to tell the player
     */
    buildMessage(listing, bestPrice, priceAgeMs) {
        const itemName = this.itemLabel(listing);
        const age = priceAgeMs < 60000 ? 'as of just now' : `as of ~${formatRelativeTime(priceAgeMs)} ago`;
        const best = formatKMB3Digits(bestPrice);
        const yours = formatKMB3Digits(listing.price);

        if (listing.isSell) {
            return `${itemName} sell listing undercut: ask now ${best} (${age}), your listing ${yours}.`;
        }
        return `${itemName} buy order outbid: bid now ${best} (${age}), your order ${yours}.`;
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
        this.listingStates.clear();
        this.mooketObservations.clear();
        this.timers.clearAll();
        this.refreshInFlight = false;
        this.mooketRefreshInFlight = false;
        this.isInitialized = false;
    }
}

const marketUndercutAlerts = new MarketUndercutAlerts();

export default marketUndercutAlerts;
