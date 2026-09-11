/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is
 * parked on `loadPrefs()`.
 *
 * `isInitialized` is set *before* that read, so the switch's own
 * re-initialise never early-returned — the interrupted call simply resumed
 * after `disable()`'s `cleanupRegistry.cleanupAll()` had emptied the
 * registry's internal arrays, and pushed its own listener/observer/interval
 * registrations back into them with no handle left to remove them by. Most
 * of that redoes idempotent work, but a leaked
 * `market_item_order_books_updated` listener could double-call
 * `marketHistoryAPI.report(data)` for one order-book snapshot — double
 * reporting it to the shared pooled history until the *next* switch's
 * teardown clears the registry wholesale.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside loadPrefs()'s read */
    gate: null,
    characterId: 'char1',
}));

/** Live domObserver registrations, by name, so leaks are countable. */
const registrations = vi.hoisted(() => ({ live: [] }));
/** Live dataManager listeners, by event. */
const events = vi.hoisted(() => ({ handlers: {} }));
/** Every `marketHistoryAPI.report()` call, so a double-report is countable. */
const reports = vi.hoisted(() => ({ calls: 0 }));
/** Command-palette entries currently on offer, by name. */
const commands = vi.hoisted(() => ({ live: [] }));

vi.mock('../../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, COLOR_ACCENT: '#8ecfff' },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: () => null,
        on: (event, handler) => {
            (events.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            events.handlers[event] = (events.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            registrations.live.push(name);
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
        onReady: (name, callback) => {
            registrations.live.push(name);
            void callback;
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../../api/marketplace.js', () => ({
    default: { on: () => {}, off: () => {}, marketData: {}, getPrice: () => null },
}));
vi.mock('./market-price-store.js', () => ({
    default: {
        initialize: async () => {},
        cleanup: () => {},
        ingestSnapshot: () => {},
        onChange: () => () => {},
        priceFor: () => null,
    },
}));
vi.mock('./market-history-api.js', () => ({
    default: {
        connect: () => {},
        disconnect: () => {},
        report: () => {
            reports.calls += 1;
        },
    },
}));
vi.mock('./market-watchlist.js', () => ({
    addWatched: () => [],
    removeWatched: () => [],
    moveWatched: () => [],
    nextDisplayMode: () => 'iconPrice',
    watchedChange: () => {},
    describeMove: () => '',
    normaliseWatchlist: (list) => list || [],
    describeUpdateAge: () => '',
    isStalePrice: () => false,
    setWatchedTarget: () => [],
    normaliseTarget: () => null,
    describeTarget: () => '',
    targetMet: () => false,
    noteTargetReached: (list) => list,
    sightingsFromRows: () => [],
    targetAftermath: () => null,
    describeAftermath: () => '',
}));
vi.mock('../../../utils/persisted-record.js', () => ({
    createCuratedRecord: () => ({
        reset: () => {},
        load: async () => false,
        get: () => [],
        set: () => {},
        save: async () => {},
    }),
    mergeById: () => (a) => a,
}));
vi.mock('../../../utils/panel-minimize.js', () => ({
    attachMinimize: () => ({ destroy: () => {} }),
}));
vi.mock('../../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('../../../utils/command-registry.js', () => ({
    registerCommand: ({ name }) => {
        if (!commands.live.includes(name)) commands.live.push(name);
    },
    unregisterCommand: (name) => {
        const at = commands.live.indexOf(name);
        if (at !== -1) commands.live.splice(at, 1);
    },
}));
vi.mock('../../../core/storage.js', () => ({
    default: {
        getJSON: async () => {
            // The one read `loadPrefs()` parks on
            if (world.gate) await world.gate;
            return null;
        },
        get: async () => null,
        setJSON: async () => true,
        set: async () => true,
        tryGet: async () => ({ found: false, value: null }),
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
        parseJSON: (raw, _key, fallback = null) => (raw === null ? fallback : raw),
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));

const { default: marketHistoryPanel } = await import('./index.js');

describe('a character switch landing inside loadPrefs()', () => {
    beforeEach(() => {
        marketHistoryPanel.disable();
        world.gate = null;
        world.characterId = 'char1';
        registrations.live = [];
        events.handlers = {};
        reports.calls = 0;
        commands.live = [];
        marketHistoryPanel.watchlistOwner = null;
        marketHistoryPanel.watchlist = [];
        document.body.innerHTML = '';
    });

    afterEach(() => {
        marketHistoryPanel.disable();
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = marketHistoryPanel.initialize();
        // `character_switching` — the feature layer comes down mid-read
        marketHistoryPanel.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(registrations.live).toEqual([]);
        expect(events.handlers['market_item_order_books_updated'] ?? []).toEqual([]);
        expect(marketHistoryPanel.isInitialized).toBe(false);
    });

    // `registerCommand` sat above the ownership check, so the interrupted tail
    // put the entry back into a palette `disable()` had just cleared it from.
    // The palette's promise is that a switched-off feature is not offered, and
    // picking the orphaned entry ran `toggle()` against a removed panel —
    // flipping `prefs.open` and writing it back to storage for a feature that
    // was not running.
    test('the interrupted initialize leaves no command in the palette', async () => {
        await switchDuringInitialize();

        expect(commands.live).toEqual([]);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await marketHistoryPanel.initialize();

        expect(events.handlers['market_item_order_books_updated']).toHaveLength(1);

        // A single order book update fires the listener as many times as it
        // was registered; only one live registration means only one report
        for (const handler of events.handlers['market_item_order_books_updated']) handler({});
        expect(reports.calls).toBe(1);

        // …and that one set is the one the teardown can remove
        marketHistoryPanel.disable();
        expect(registrations.live).toEqual([]);
        expect(events.handlers['market_item_order_books_updated'] ?? []).toEqual([]);
    });
});
