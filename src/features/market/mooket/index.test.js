/**
 * The panel's stored settings, and the seam through the middle of them.
 *
 * `mooketPanelPrefs` used to hold two unrelated things: where the panel sits,
 * which is one answer for the whole account, and what is pinned to it, which is
 * one answer per character. Saving on either character wrote both, so the iron
 * cow's short list was replaced by the market character's long one every time
 * either of them moved the panel. These tests are about the split holding.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({ id: 'market123', mode: 'standard' }));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const read = (key, store, fallback) => {
        const map = storeFor(store);
        return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
    };
    return {
        storeFor,
        unavailable: false,
        reset: () => {
            stores.clear();
            storageMock.unavailable = false;
        },
        ready: Promise.resolve(true),
        get: async (key, store = 'settings', fallback = null) => read(key, store, fallback),
        getJSON: async (key, store = 'settings', fallback = null) => read(key, store, fallback),
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        setJSON: async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => character.mode,
        getItemDetails: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../../core/config.js', () => ({ default: { getSetting: () => false, onSettingChange: () => {} } }));
vi.mock('../../../api/marketplace.js', () => ({ default: { on: () => {}, off: () => {}, marketData: {} } }));
// The real registry's API — the mock used to offer `cleanup()`, which the
// real one does not have, and that is how a `cleanupRegistry.cleanup()` call
// in disable() passed every test and threw in the game
vi.mock('../../../utils/cleanup-registry.js', () => ({
    createCleanupRegistry: () => ({
        registerCleanup: () => {},
        registerInterval: () => {},
        registerTimeout: () => {},
        registerListener: () => {},
        cleanupAll: () => {},
    }),
}));
vi.mock('../../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('./market-price-store.js', () => ({
    default: { initialize: async () => {}, cleanup: () => {}, ingestSnapshot: () => {}, priceFor: () => null },
}));
vi.mock('./market-history-api.js', () => ({
    default: {
        connect: () => {},
        disconnect: () => {},
        fetchHistory: async () => [],
        currentSource: () => ({ key: 'mooket2', hasVolume: true, avgLabel: 'Avg' }),
    },
}));

const { default: panel, gameModalIsOpen, splitLegacyWatchlist } = await import('./index.js');
const { _resetAdoptionCache } = await import('../../../utils/character-key.js');

const settings = () => storageMock.storeFor('settings');
const PREFS_KEY = 'mooketPanelPrefs';
const watched = [
    { key: '/items/cheese:0', ask: 120, bid: 100, at: 500 },
    { key: '/items/milk:0', ask: 20, bid: 10, at: 500 },
];

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    character.id = 'market123';
    character.mode = 'standard';
    panel.prefs = { x: 20, y: 120, w: 520, h: 300, days: 7, open: false, locked: false, mode: 'iconPrice' };
    panel.watchlist = [];
    panel.watchlistOwner = null;
});

describe('the stored watchlist survives a read that cannot be made', () => {
    const KEY = 'mooketWatchlist_market123';
    const storedKeys = () => (settings().get(KEY) || []).map((entry) => entry.key);

    test('a load while storage is unreadable keeps the list in hand instead of blanking it', async () => {
        settings().set(KEY, watched);
        await panel.loadPrefs();
        expect(panel.watchlist).toHaveLength(2);

        storageMock.unavailable = true;
        await panel.loadPrefs();

        expect(panel.watchlist).toHaveLength(2);
        expect(storedKeys()).toHaveLength(2);
    });

    test('but another character’s list never stands in for this one’s', async () => {
        settings().set(KEY, watched);
        await panel.loadPrefs();

        character.id = 'iron456';
        storageMock.unavailable = true;
        await panel.loadPrefs();

        expect(panel.watchlist).toEqual([]);
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        settings().set(KEY, watched);
        storageMock.unavailable = true;
        await panel.loadPrefs();
        panel.watchlist = [{ key: '/items/log:0' }];

        await panel.savePrefs();
        expect(storedKeys()).toEqual(['/items/cheese:0', '/items/milk:0']);

        storageMock.unavailable = false;
        await panel.savePrefs();
        // Never read back, so the stored items are kept alongside the new one
        expect(storedKeys()).toEqual(['/items/cheese:0', '/items/milk:0', '/items/log:0']);
    });

    test('once read back, a removal sticks', async () => {
        settings().set(KEY, watched);
        await panel.loadPrefs();
        panel.watchlist = panel.watchlist.filter((entry) => entry.key !== '/items/cheese:0');

        await panel.savePrefs();
        expect(storedKeys()).toEqual(['/items/milk:0']);
    });
});

describe('splitting the watchlist out of the panel prefs', () => {
    test('the watched items move to the character key and leave the prefs alone', async () => {
        settings().set(PREFS_KEY, { x: 40, days: 30, watchlist: watched });

        await panel.loadPrefs();

        expect(panel.watchlist.map((entry) => entry.key)).toEqual(['/items/cheese:0', '/items/milk:0']);
        expect(
            settings()
                .get('mooketWatchlist_market123')
                .map((entry) => entry.key)
        ).toEqual(['/items/cheese:0', '/items/milk:0']);
        // The panel's own geometry stays where it was, and stays global
        expect(settings().get(PREFS_KEY)).toEqual({ x: 40, days: 30 });
        expect(panel.prefs.x).toBe(40);
        expect(panel.prefs.days).toBe(30);
        expect(panel.prefs.watchlist).toBeUndefined();
    });

    test('an iron cow inherits the panel geometry but not the list', async () => {
        character.id = 'iron456';
        character.mode = 'ironcow';
        settings().set(PREFS_KEY, { x: 40, days: 30, watchlist: watched });

        await panel.loadPrefs();

        expect(panel.prefs.x).toBe(40);
        expect(panel.watchlist).toEqual([]);
        expect(settings().get('mooketWatchlist_iron456')).toBeUndefined();
        // Left for the character it belongs to to claim
        expect(
            settings()
                .get('mooketWatchlist')
                .map((entry) => entry.key)
        ).toEqual(['/items/cheese:0', '/items/milk:0']);
    });

    test('saving writes the two halves to their two keys', async () => {
        panel.prefs.x = 99;
        panel.watchlist = watched;

        await panel.savePrefs();

        expect(settings().get(PREFS_KEY).x).toBe(99);
        expect(settings().get(PREFS_KEY).watchlist).toBeUndefined();
        expect(settings().get('mooketWatchlist_market123')).toHaveLength(2);
    });

    test('one character saving no longer overwrites the other list', async () => {
        settings().set('mooketWatchlist_market123', watched);
        settings().set('mooketWatchlist_iron456', [{ key: '/items/log:0' }]);

        character.id = 'iron456';
        character.mode = 'ironcow';
        await panel.loadPrefs();
        panel.prefs.x = 7;
        await panel.savePrefs();

        expect(
            settings()
                .get('mooketWatchlist_iron456')
                .map((entry) => entry.key)
        ).toEqual(['/items/log:0']);
        expect(settings().get('mooketWatchlist_market123')).toHaveLength(2);
        // The one thing they do share
        expect(settings().get(PREFS_KEY).x).toBe(7);
    });

    test('loading as a second character does not carry the first list over', async () => {
        settings().set('mooketWatchlist_market123', watched);
        await panel.loadPrefs();
        expect(panel.watchlist).toHaveLength(2);

        character.id = 'iron456';
        character.mode = 'ironcow';
        await panel.loadPrefs();

        expect(panel.watchlist).toEqual([]);
    });

    test('splitting twice does not clobber a list already moved', async () => {
        settings().set('mooketWatchlist', [{ key: '/items/already:0' }]);

        await splitLegacyWatchlist({ x: 1, watchlist: watched });

        expect(
            settings()
                .get('mooketWatchlist')
                .map((entry) => entry.key)
        ).toEqual(['/items/already:0']);
        expect(settings().get(PREFS_KEY)).toEqual({ x: 1 });
    });

    test('prefs saved after the split are left exactly as they are', async () => {
        settings().set(PREFS_KEY, { x: 40, days: 30 });

        await panel.loadPrefs();

        expect(settings().get(PREFS_KEY)).toEqual({ x: 40, days: 30 });
        expect(settings().has('mooketWatchlist')).toBe(false);
        expect(panel.watchlist).toEqual([]);
    });
});

describe('disable() always leaves the feature re-initialisable', () => {
    test('a disable that throws part-way still clears isInitialized, and a stray click cannot throw', () => {
        panel.isInitialized = true;
        // Node environment: the panel only needs `remove()` and `style` here
        panel.panel = { remove() {}, style: {} };
        // Force a failure inside disable, the way the misnamed registry call did
        const saved = panel.cleanupRegistry;
        panel.cleanupRegistry = {
            cleanupAll: () => {
                throw new Error('boom');
            },
        };
        try {
            expect(() => panel.disable()).not.toThrow();
        } finally {
            panel.cleanupRegistry = saved;
        }
        expect(panel.isInitialized).toBe(false);
        expect(panel.panel).toBeNull();
        // The History tab's click path with no panel up
        panel.prefs.open = true;
        expect(() => panel.applyOpenState()).not.toThrow();
    });

    test('disable clears `shown` so a re-initialize is not blocked by the stale-key guard', async () => {
        panel.chart = { destroy() {} };
        panel.shown = '/items/cheese:0:7';
        panel.panel = { remove() {}, style: {} };
        panel.title = { textContent: '' };

        panel.disable();

        expect(panel.chart).toBeNull();
        expect(panel.shown).toBeNull();

        // Without the fix this would short-circuit at `this.shown === key` and
        // leave the newly re-created chart blank until the item or day range changed.
        panel.prefs.open = true;
        await panel.showItem('/items/cheese', 0);
        expect(panel.shown).toBe('/items/cheese:0:7');
    });
});

/**
 * The pushpin is anchored to the marketplace's item icon, and the game draws a
 * modal *under* it: the pin's overlay is at z-index 820 while the game's own
 * `Modal_modalContainer` is a full-screen fixed layer at 200. Opening a house
 * panel over the marketplace therefore left a pushpin floating in the middle of
 * the Armory's build list.
 *
 * Measured against the live client: with the marketplace open and nothing on
 * top of it, the document holds no `Modal_modalContainer` at all — so its
 * presence is the whole test, and the marketplace's own shell
 * (`MainPanel_marketplaceModalContainer`) must not be mistaken for one.
 */
describe('a game modal hides the pin', () => {
    const docWith = (...classNames) => ({
        querySelector: (selector) =>
            classNames.some((name) => name.includes(selector.replace('[class*="', '').replace('"]', '')))
                ? { className: classNames[0] }
                : null,
    });

    test('the game’s modal container counts', () => {
        expect(gameModalIsOpen(docWith('Modal_modalContainer__3B80m'))).toBe(true);
    });

    test('the marketplace’s own shell does not', () => {
        expect(gameModalIsOpen(docWith('MainPanel_marketplaceModalContainer__2d3wY'))).toBe(false);
    });

    test('a page with no modal at all does not', () => {
        expect(gameModalIsOpen(docWith('MarketplacePanel_marketplacePanel__x'))).toBe(false);
    });

    test('no document is not an open modal', () => {
        expect(gameModalIsOpen(null)).toBe(false);
    });
});
