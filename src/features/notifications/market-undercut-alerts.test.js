/**
 * Tests for the market undercut alert.
 *
 * The comparison is between two things that are each re-read constantly — your
 * listings and a price cache — so the cases that matter are the ones where a
 * message would be *wrong*: a listing that is tied with the best price, an item
 * the cache knows nothing about, a figure too old to prove anything, and the
 * same undercut announced twice. The message itself is also under test, since
 * its honesty about the figure's age is a stated requirement of the feature.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';
import marketAPI from '../../api/marketplace.js';

const NOW = new Date('2026-01-01T12:00:00Z').getTime();

const game = vi.hoisted(() => ({
    settings: {},
    listings: [],
    itemNames: {},
    prices: {},
    pricePatchs: {},
    lastFetchTimestamp: 0,
    dmHandlers: {},
    priceListeners: [],
    notified: [],
    // `itemHrid:level` → history rows the mocked Mooket client returns
    mooketRows: {},
    // How a forced refresh behaves; default just re-notifies subscribers, as the
    // real fetch() does on success. Tests override this to reshape the snapshot.
    fetchImpl: null,
    // What the mocked notify() reports back; a test overrides this to simulate
    // a notice that reached no channel.
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getMarketListings: () => game.listings.map((listing) => ({ ...listing })),
        getItemDetails: (hrid) => (game.itemNames[hrid] ? { name: game.itemNames[hrid] } : null),
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        CACHE_DURATION: 15 * 60 * 1000,
        get lastFetchTimestamp() {
            return game.lastFetchTimestamp;
        },
        get pricePatchs() {
            return game.pricePatchs;
        },
        getPrice: (itemHrid, enhancementLevel = 0) => game.prices[`${itemHrid}:${enhancementLevel}`] || null,
        on: (callback) => {
            game.priceListeners.push(callback);
        },
        off: (callback) => {
            game.priceListeners = game.priceListeners.filter((cb) => cb !== callback);
        },
        fetch: vi.fn((forceFetch) => game.fetchImpl(forceFetch)),
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return game.notifyResult;
        },
    },
}));
vi.mock('../market/mooket/market-history-api.js', () => ({
    default: {
        fetchHistory: async (itemHrid, enhancementLevel) => game.mooketRows[`${itemHrid}:${enhancementLevel}`] ?? null,
        currentSource: () => ({ key: 'mooket2', hasVolume: true }),
    },
}));

const { default: marketUndercutAlerts, MASTER_SETTING } = await import('./market-undercut-alerts.js');

/** An active sell listing of yours, unless overridden */
function listing(overrides = {}) {
    return {
        id: 1,
        itemHrid: '/items/cheese',
        enhancementLevel: 0,
        price: 280000,
        isSell: true,
        status: '/market_listing_status/active',
        ...overrides,
    };
}

/** Put a dated ask/bid pair in the mocked cache */
function setPrice(itemHrid, enhancementLevel, ask, bid, ageMs = 12 * 60 * 1000) {
    game.prices[`${itemHrid}:${enhancementLevel}`] = { ask, bid };
    game.lastFetchTimestamp = NOW - ageMs;
}

const check = () => game.dmHandlers.market_listings_updated();

describe('market undercut alerts', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.settings = { [MASTER_SETTING]: true };
        game.listings = [];
        game.itemNames = { '/items/cheese': 'Cheese' };
        game.prices = {};
        game.pricePatchs = {};
        game.lastFetchTimestamp = 0;
        game.dmHandlers = {};
        game.priceListeners = [];
        game.notified = [];
        game.mooketRows = {};
        game.notifyResult = { fired: true, channels: ['toast'] };
        // A forced refresh, by default, just re-notifies subscribers — the real
        // fetch() calls notifyListeners() on success. Runs synchronously so a
        // faked-timer tick fully re-runs the undercut check before returning.
        game.fetchImpl = async () => {
            game.priceListeners.forEach((cb) => cb());
        };
        marketAPI.fetch.mockClear();
        marketUndercutAlerts.disable();
        await marketUndercutAlerts.initialize();
    });

    afterEach(() => {
        marketUndercutAlerts.disable();
        vi.useRealTimers();
    });

    test('the master switch off wires nothing at all', async () => {
        marketUndercutAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await marketUndercutAlerts.initialize();

        expect(game.dmHandlers.market_listings_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
        expect(game.priceListeners).toHaveLength(0);
    });

    test('an undercut sell listing is announced with both prices and the figure age', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe(
            'Cheese sell listing undercut: ask now 274K (as of ~12m ago), your listing 280K.'
        );
        expect(game.notified[0].options.title).toBe('Listing undercut');
    });

    test('a figure seconds old says so instead of claiming an age it does not have', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000, 30 * 1000);

        check();

        expect(game.notified[0].message).toContain('(as of just now)');
    });

    test('holding the best ask is not being undercut, tied or outright', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 280000, 270000);
        check();

        setPrice('/items/cheese', 0, 290000, 270000);
        check();

        expect(game.notified).toHaveLength(0);
    });

    test('an item with no cached market data is unknown, not undercut', () => {
        game.listings = [listing({ itemHrid: '/items/obscure_thing' })];

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a cached entry with no asks at all is also unknown', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, null, 270000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a figure older than the cache validity window fires nothing', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('one undercut is one message however often the same state is re-read', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();
        check();
        check();

        expect(game.notified).toHaveLength(1);
    });

    test('the situation resolving re-arms the listing for the next undercut', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        // The undercutter sold out; your price is best again
        setPrice('/items/cheese', 0, 280000, 270000);
        check();

        setPrice('/items/cheese', 0, 273000, 270000);
        check();

        expect(game.notified).toHaveLength(2);
    });

    test('repricing the listing re-arms it, even while still beaten', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        game.listings = [listing({ price: 275000 })];
        check();

        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toContain('your listing 275K');
    });

    test('repricing gives the notification a fresh event key, so the real service cooldown cannot eat it', () => {
        // notify() is mocked here to always fire, so this cannot see the bug by
        // itself — the real NotificationService keys its ten-minute cooldown off
        // this exact string, and would have silently dropped a same-key repeat
        // fired seconds after the first. What this proves is the mechanism that
        // keeps that from happening: a reprice must not reuse the previous key.
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        game.listings = [listing({ price: 275000 })];
        check();

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
    });

    test('re-reading the same repriced listing keeps the same event key', () => {
        // Only a reprice should mint a new key — a redraw of the same price must
        // still collapse onto one key, or the real cooldown would never engage.
        game.listings = [listing({ price: 275000 })];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();
        check();
        check();

        expect(game.notified).toHaveLength(1);
    });

    test('an undercut that reached no channel is retried on the next read, not lost until a reprice', () => {
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();
        expect(game.notified).toHaveLength(1);

        // Still undercut, still nothing delivered — the listing's armed bit
        // must not have been spent on a notice nobody saw
        check();
        expect(game.notified).toHaveLength(2);

        game.notifyResult = { fired: true, channels: ['toast'] };
        check();
        expect(game.notified).toHaveLength(3);

        // Delivered: further re-reads of the same state are the ordinary
        // one-message-per-undercut case again
        check();
        expect(game.notified).toHaveLength(3);
    });

    test('a buy order below the best bid is outbid', () => {
        game.listings = [listing({ isSell: false, price: 280000 })];
        setPrice('/items/cheese', 0, 320000, 300000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe(
            'Cheese buy order outbid: bid now 300K (as of ~12m ago), your order 280K.'
        );
        expect(game.notified[0].options.title).toBe('Buy order outbid');
    });

    test('a buy order holding the best bid is silent', () => {
        game.listings = [listing({ isSell: false, price: 300000 })];
        setPrice('/items/cheese', 0, 320000, 300000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a listing that is no longer active has no price to defend', () => {
        game.listings = [listing({ status: '/market_listing_status/filled', unclaimedCoinCount: 100 })];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('enhancement levels are separate markets, and named in the message', () => {
        game.listings = [listing({ itemHrid: '/items/cheese_sword', enhancementLevel: 5, price: 2000000 })];
        game.itemNames['/items/cheese_sword'] = 'Cheese Sword';
        setPrice('/items/cheese_sword', 5, 1800000, 1500000);
        // The +0 market being cheaper than your +5 listing proves nothing
        setPrice('/items/cheese_sword', 0, 100000, 90000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Cheese Sword +5 sell listing undercut');
        expect(game.notified[0].message).toContain('ask now 1.80M');
    });

    test('an order-book patch fresher than the API snapshot dates the figure', () => {
        game.listings = [listing()];
        // API snapshot too old to count on its own...
        setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);
        // ...but an order book seen five minutes ago carries the same figure
        game.pricePatchs['/items/cheese:0'] = { a: 274000, b: 270000, timestamp: NOW - 5 * 60 * 1000 };

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('(as of ~5m ago)');
    });

    test('the event key carries the listing id, so each listing cools down on its own', () => {
        game.listings = [listing({ id: 7 }), listing({ id: 8, price: 281000 })];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified.map((entry) => entry.key)).toEqual(['market-undercut-7:1', 'market-undercut-8:1']);
    });

    test('a price update alone re-runs the comparison, without a market message', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        game.priceListeners.forEach((cb) => cb());

        expect(game.notified).toHaveLength(1);
    });

    test('the master switch is re-checked per look, not only at initialize', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        game.settings[MASTER_SETTING] = false;

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down and forgets every listing', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        game.dmHandlers.character_switching();

        expect(game.dmHandlers.market_listings_updated).toBeUndefined();
        expect(game.priceListeners).toHaveLength(0);
        expect(marketUndercutAlerts.listingStates.size).toBe(0);
    });

    // The Mooket sighting is the other fresh source: the game snapshot is hourly
    // and usually too old to prove anything, so a minutes-old pooled sighting is
    // what lets the alert fire passively for an item the player never opened.
    describe('Mooket-backed freshness', () => {
        const POOLED = 'market_pooledHistory';

        /** A single history row the mocked pool returns, `ageMs` old */
        function mooketSighting(itemHrid, level, ask, bid, ageMs) {
            game.mooketRows[`${itemHrid}:${level}`] = [{ a: ask, b: bid, time: Math.floor((NOW - ageMs) / 1000) }];
        }

        test('an undercut the snapshot is too stale to prove is caught from a fresh sighting', async () => {
            game.settings[POOLED] = true;
            game.listings = [listing()]; // sell at 280K
            // The only snapshot figure is 20m old — older than the 15m window
            setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);
            check();
            expect(game.notified).toHaveLength(0);

            // The pool saw the same undercut three minutes ago
            mooketSighting('/items/cheese', 0, 274000, 270000, 3 * 60 * 1000);
            await marketUndercutAlerts.refreshMooketObservations();

            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('(as of ~3m ago)');
        });

        test('the pooled-history switch gates the lookups entirely', async () => {
            game.settings[POOLED] = false;
            game.listings = [listing()];
            setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);
            mooketSighting('/items/cheese', 0, 274000, 270000, 1 * 60 * 1000); // fresh, but off-limits

            await marketUndercutAlerts.refreshMooketObservations();
            check();

            expect(game.notified).toHaveLength(0);
            expect(marketUndercutAlerts.mooketObservations.size).toBe(0);
        });

        test('a sighting older than the window is no more evidence than a stale snapshot', async () => {
            game.settings[POOLED] = true;
            game.listings = [listing()];
            // No usable snapshot at all; the only figure is a 20m-old sighting
            mooketSighting('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);

            await marketUndercutAlerts.refreshMooketObservations();

            expect(game.notified).toHaveLength(0);
        });

        test('the fresher source wins and dates the message, even with both present', async () => {
            game.settings[POOLED] = true;
            game.listings = [listing()];
            // A snapshot that would itself fire, at 12m...
            setPrice('/items/cheese', 0, 276000, 270000, 12 * 60 * 1000);
            // ...and a fresher sighting at 2m with a different undercut price
            mooketSighting('/items/cheese', 0, 274000, 270000, 2 * 60 * 1000);

            await marketUndercutAlerts.refreshMooketObservations();

            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('ask now 274K');
            expect(game.notified[0].message).toContain('(as of ~2m ago)');
        });

        test('a sighting missing the defended side falls back to the snapshot', async () => {
            game.settings[POOLED] = true;
            game.listings = [listing({ isSell: false, price: 280000 })]; // buy order, defended by the bid
            // Snapshot bid outbids the order, 5m old
            setPrice('/items/cheese', 0, 320000, 300000, 5 * 60 * 1000);
            // A fresher sighting quotes only an ask — it must not erase the usable bid
            mooketSighting('/items/cheese', 0, 320000, -1, 1 * 60 * 1000);

            await marketUndercutAlerts.refreshMooketObservations();

            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('bid now 300K');
            expect(game.notified[0].message).toContain('(as of ~5m ago)');
        });
    });

    // The snapshot refresh is the whole point of this feature's newer half:
    // without it, nothing calls fetch() after startup, the bulk snapshot goes
    // stale, and an undercut on an item the player never opened reads as "still
    // best". It runs on a fixed timer at the market cache's own 15-minute window
    // (no configurable interval) and, crucially, calls the *cache-respecting*
    // fetch() — never the forcing fetch(true) — so it cannot pull faster than the
    // cache and add to the game's rate-limiting. The shared beforeEach already
    // wires the feature up with the master switch on, so the timer is running.
    describe('snapshot refresh', () => {
        const CACHE = marketAPI.CACHE_DURATION;

        test('an undercut against a stale snapshot is finally caught on the next refresh', async () => {
            // The player holds the best ask in the snapshot the script currently
            // has, and has never opened this item, so no fresher order-book patch
            // exists — the comparison must read the snapshot itself.
            game.listings = [listing()]; // sell at 280K
            setPrice('/items/cheese', 0, 285000, 270000, 5 * 60 * 1000); // 5m-old, ask above theirs
            check();
            expect(game.notified).toHaveLength(0); // reads as still-best

            // The refreshed snapshot shows a competitor now cheaper than the listing
            game.fetchImpl = async () => {
                game.prices['/items/cheese:0'] = { ask: 274000, bid: 270000 };
                game.lastFetchTimestamp = Date.now();
                game.priceListeners.forEach((cb) => cb());
            };

            await vi.advanceTimersByTimeAsync(CACHE);

            expect(marketAPI.fetch).toHaveBeenCalled();
            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('sell listing undercut');
        });

        test('the refresh runs once per cache window and never forces a fetch', async () => {
            await vi.advanceTimersByTimeAsync(CACHE);
            await vi.advanceTimersByTimeAsync(CACHE);

            expect(marketAPI.fetch).toHaveBeenCalledTimes(2);
            // Cache-respecting: called with no force argument, so it only touches
            // the network when the 15-minute cache has actually expired.
            marketAPI.fetch.mock.calls.forEach((args) => expect(args[0]).toBeFalsy());
        });

        test('no timer runs while the feature itself is off', async () => {
            marketUndercutAlerts.disable();
            game.settings[MASTER_SETTING] = false;
            marketAPI.fetch.mockClear();
            await marketUndercutAlerts.initialize();

            await vi.advanceTimersByTimeAsync(4 * CACHE);

            expect(marketAPI.fetch).not.toHaveBeenCalled();
        });

        test('a tick is skipped while the previous refresh is still in flight', async () => {
            let releaseFetch;
            game.fetchImpl = () =>
                new Promise((resolve) => {
                    releaseFetch = resolve;
                });
            // Re-init so the timer's fetch uses the hanging fetchImpl set above.
            marketUndercutAlerts.disable();
            marketAPI.fetch.mockClear();
            await marketUndercutAlerts.initialize();

            await vi.advanceTimersByTimeAsync(CACHE); // tick 1 starts, never settles
            await vi.advanceTimersByTimeAsync(CACHE); // tick 2 must skip the in-flight fetch

            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);

            releaseFetch();
        });

        test('a second initialize does not double the timers or the handlers', async () => {
            // The feature registry retries features that failed to start. Without
            // a guard the second run added a second handler pair, a second
            // 15-minute timer, and a second stream of third-party Mooket requests
            const handlersBefore = Object.keys(game.dmHandlers).length;
            const listenersBefore = game.priceListeners.length;
            marketAPI.fetch.mockClear();

            await marketUndercutAlerts.initialize();

            expect(Object.keys(game.dmHandlers)).toHaveLength(handlersBefore);
            expect(game.priceListeners).toHaveLength(listenersBefore);

            await vi.advanceTimersByTimeAsync(CACHE);
            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);

            // And the one teardown still tears everything down
            marketUndercutAlerts.disable();
            expect(game.priceListeners).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(4 * CACHE);
            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);
        });

        test('disable clears the refresh timer', async () => {
            await vi.advanceTimersByTimeAsync(CACHE);
            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);

            marketUndercutAlerts.disable();
            await vi.advanceTimersByTimeAsync(4 * CACHE);

            expect(marketAPI.fetch).toHaveBeenCalledTimes(1); // no ticks after teardown
        });
    });
});

describe('settings schema backs the undercut alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/15 minutes/i);
    });

    test('there is no separate refresh-interval setting — the cache cadence is fixed', () => {
        expect(getSettingDefinition('notifications_marketListingUndercut_refreshMinutes')).toBeFalsy();
    });
});
