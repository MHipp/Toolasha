/** @vitest-environment happy-dom
 *
 * Collection state, under a key the rest of the script can read.
 *
 * These keys were always per character — `flags:abc123` — so nothing leaked.
 * What went wrong is quieter: everything else in the script scopes a key as
 * `flags_abc123`, and the account view and the settings importer find a
 * character's data by that underscore suffix. A colon meant this feature's data
 * was invisible to both. The rename is per character and needs no adoption
 * question answered, so the only thing worth testing is that nobody loses their
 * favourites to it.
 *
 * Beyond the rename: the filtering itself. Every checkbox is a predicate over
 * (itemId, count) and every tile is classed by whichever predicates it passes,
 * so the panel is driven the way the game drives it — build the tiles, run the
 * render, read the classes and the injected controls back out.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ collections: {}, settings: {}, unavailable: false, transactions: [] }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'market123',
    clientData: null,
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => 'standard',
    getInitClientData: () => mockDataManager.clientData,
    on: () => {},
    off: () => {},
}));

const mockConfig = vi.hoisted(() => ({
    settings: {},
    COLOR_ACCENT: '#ffd700',
}));

const mockMarket = vi.hoisted(() => ({ prices: {} }));
const mockEfficiency = vi.hoisted(() => ({ context: { actionTime: 10, efficiencyMultiplier: 1, totalGathering: 0 } }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mockConfig.settings[key] ?? true,
        getSettingValue: (_k, d) => d,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPrice: (hrid) => mockMarket.prices[hrid] ?? null,
    },
}));
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => mockEfficiency.context }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
/**
 * Every transaction this feature opens, so a test can count them.
 *
 * Each entry is one IndexedDB transaction's worth of work: `getMany` counts
 * once however many keys it carries, which is the whole point of it.
 */
function record(mode, storeName, keys) {
    store.transactions.push({ mode, store: storeName, keys });
}

vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, name = 'settings', fallback = null) => {
            record('readonly', name, [key]);
            return store[name]?.[key] ?? fallback;
        },
        getMany: async (keys, name = 'settings') => {
            record('readonly', name, [...keys]);
            // Lets a test land a character switch inside a load's reads
            store.onRead?.();
            const read = new Map();
            // Read through the same property access a single `get` uses, so a
            // test can still land a character switch inside the batch
            for (const key of keys) read.set(key, store[name]?.[key] ?? null);
            return read;
        },
        parseJSON: (raw, _key, fallback = null) => {
            if (raw === null) return fallback;
            if (typeof raw === 'object') return raw;
            try {
                return JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        tryGet: async (key, name = 'settings') => {
            record('readonly', name, [key]);
            if (store.unavailable) return null;
            const held = store[name]?.[key];
            return held === undefined || held === null
                ? { found: false, value: null }
                : { found: true, value: structuredClone(held) };
        },
        set: async (key, value, name = 'settings') => {
            record('readwrite', name, [key]);
            if (store.unavailable) return false;
            store[name][key] = structuredClone(value);
            return true;
        },
        delete: async (key, name = 'settings') => {
            record('readwrite', name, [key]);
            delete store[name][key];
            return true;
        },
        getJSON: async (key, name = 'settings', fallback = null) => {
            record('readonly', name, [key]);
            // Lets a test land a character switch inside a load's reads
            store.onRead?.();
            return store[name]?.[key] ?? fallback;
        },
        setJSON: async (key, value, name = 'settings') => {
            record('readwrite', name, [key]);
            store[name][key] = value;
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(store[name] || {}),
    },
}));

const { default: collectionFilters } = await import('./collection-filters.js');

beforeEach(async () => {
    store.collections = {};
    store.settings = {};
    store.unavailable = false;
    store.onRead = null;
    store.transactions = [];
    mockDataManager.characterId = 'market123';
    mockDataManager.clientData = null;
    mockConfig.settings = {};
    mockMarket.prices = {};
    mockEfficiency.context = { actionTime: 10, efficiencyMultiplier: 1, totalGathering: 0 };
    collectionFilters._filtersEnabled = true;
    collectionFilters._favoritesEnabled = true;
    collectionFilters.sortMode = 'default';
    collectionFilters.itemActionCache = null;
    document.body.innerHTML = '';
    document.head.innerHTML = '';

    // The feature is a singleton and remembers its checkbox states between
    // openings, which is right for a panel and wrong for a test.
    collectionFilters._renamedFor = null;
    collectionFilters._loadedFor = null;
    await collectionFilters._load();
    collectionFilters._renamedFor = null;
    // The priming load leaves the rename's persisted marker behind; a test that
    // stages colon keys expects a character the migration has never run for
    store.collections = {};
    store.transactions = [];
    collectionFilters.collections = {};
    collectionFilters.favorites = {};
    collectionFilters.collectionsLastUpdated = null;
    collectionFilters.showUncollected = false;
    collectionFilters.sortMode = 'default';
});

afterEach(() => {
    collectionFilters.catsObserver?.disconnect();
    collectionFilters.catsObserver = null;
    vi.useRealTimers();
});

describe('the colon keys becoming underscore keys', () => {
    test('a character keeps everything it had', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.collections['collections:market123'] = { '/items/milk': 12 };
        store.collections['showUncollected:market123'] = true;
        store.collections['collectionsUpdatedAt:market123'] = 1700;

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ '/items/milk': true });
        expect(collectionFilters.collections).toEqual({ '/items/milk': 12 });
        expect(collectionFilters.showUncollected).toBe(true);
        expect(collectionFilters.collectionsLastUpdated).toBe(1700);
    });

    test('under the suffix the rest of the script recognises', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };

        await collectionFilters._load();

        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });
        expect(store.collections['favorites:market123']).toBeUndefined();
    });

    test('and nobody inherits anybody else’s', async () => {
        // Colon keys were already per character, so this is a rename and not an
        // adoption — the iron cow takes its own and only its own
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.collections['favorites:iron456'] = { '/items/log': true };
        mockDataManager.characterId = 'iron456';

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ '/items/log': true });
        expect(store.collections.favorites_iron456).toEqual({ '/items/log': true });
        expect(store.collections.favorites_market123).toBeUndefined();
        expect(store.collections['favorites:market123']).toEqual({ '/items/milk': true });
    });

    test('an already-renamed key is not overwritten by a stale colon key', async () => {
        store.collections['favorites:market123'] = { stale: true };
        store.collections.favorites_market123 = { fresh: true };

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ fresh: true });
        expect(store.collections['favorites:market123']).toBeUndefined();
    });

    test('a character with nothing stored is not a problem', async () => {
        await expect(collectionFilters._load()).resolves.toBeUndefined();

        expect(collectionFilters.favorites).toEqual({});
    });

    test('a switch mid-rename does not move one character’s favourites onto another', async () => {
        store.collections['favorites:iron456'] = { '/items/log': true };

        // The switch lands while the legacy read is in flight. Every key in the
        // rename used to be rebuilt from `getCurrentCharacterId()` afterwards,
        // so the read and the write named different characters.
        Object.defineProperty(store.collections, 'favorites:market123', {
            configurable: true,
            enumerable: true,
            get() {
                mockDataManager.characterId = 'iron456';
                return { '/items/milk': true };
            },
        });

        await collectionFilters._renameLegacyKeys();

        expect(store.collections['favorites:iron456']).toEqual({ '/items/log': true });
        expect(store.collections.favorites_iron456).toBeUndefined();
    });

    test('saving after the rename writes the underscore key', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        await collectionFilters._load();

        collectionFilters.favorites['/items/log'] = true;
        await collectionFilters._saveFavorites();

        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true, '/items/log': true });
    });
});

// ---------------------------------------------------------------------------
// What a load costs
// ---------------------------------------------------------------------------

/**
 * The migration used to be guarded only in memory, so every load re-ran it:
 * five reads against the `collections` store, and a readwrite `delete` on the
 * load that found anything — while startup's fan-out is at its widest and
 * every readonly transaction on that store queues behind it.
 */
describe('what a load costs the collections store', () => {
    /** @returns {Array<Object>} Transactions opened against the collections store */
    const opened = () => store.transactions.filter((t) => t.store === 'collections');

    /** A character whose migration has already run, as a reload would find it. */
    function settled() {
        store.collections.legacyKeysRenamed_market123 = true;
        // Present, so the curated records' probes answer without falling
        // through to `readScoped`'s own legacy lookup — a different question
        // from the one being counted here
        store.collections.flags_market123 = { 'cf-c1-9': true };
        store.collections.favorites_market123 = { '/items/milk': true };
        store.collections.collections_market123 = { '/items/milk': 12 };
        store.collections.showUncollected_market123 = true;
        store.collections.collectionsUpdatedAt_market123 = 1700;
        collectionFilters._renamedFor = null;
        store.transactions = [];
    }

    test('a settled character reads its plain records in one transaction', async () => {
        settled();

        await collectionFilters._load();

        const reads = opened().filter((t) => t.mode === 'readonly');
        // One `getMany` for the two plain records, plus the three curated
        // records' own probes — not five rename reads on top of them
        expect(reads).toHaveLength(4);
        expect(reads.filter((t) => t.keys.length > 1)).toHaveLength(1);
    });

    test('and opens no readwrite transaction at all', async () => {
        settled();

        await collectionFilters._load();

        expect(opened().filter((t) => t.mode === 'readwrite')).toEqual([]);
    });

    test('with the marker set, no colon key is read', async () => {
        settled();

        await collectionFilters._load();

        const read = opened().flatMap((t) => t.keys);
        expect(read.filter((key) => key.includes(':'))).toEqual([]);
    });

    test('a character that has never migrated still does, and marks it', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.transactions = [];

        await collectionFilters._load();

        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });
        expect(store.collections['favorites:market123']).toBeUndefined();
        expect(store.collections.legacyKeysRenamed_market123).toBe(true);
        // Every read the rename needed came out of the load's own batch
        expect(opened().filter((t) => t.mode === 'readonly' && t.keys.length === 1 && t.keys[0].includes(':'))).toEqual(
            []
        );
    });

    test('and the next load after it does no storage work for the migration', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        await collectionFilters._load();

        // A reload: the in-memory guard is gone, only the persisted one is left
        collectionFilters._renamedFor = null;
        store.transactions = [];
        await collectionFilters._load();

        expect(opened().filter((t) => t.mode === 'readwrite')).toEqual([]);
        expect(
            opened()
                .flatMap((t) => t.keys)
                .filter((key) => key.includes(':'))
        ).toEqual([]);
    });

    test('a switch inside the batched read leaves the marker unset, so the migration is not lost', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.onRead = () => {
            mockDataManager.characterId = 'iron456';
            store.onRead = null;
        };

        await collectionFilters._renameLegacyKeys();

        // Nothing was moved and nothing was marked: the market character's
        // colon key is still there for the load that speaks for it
        expect(store.collections['favorites:market123']).toEqual({ '/items/milk': true });
        expect(store.collections.legacyKeysRenamed_market123).toBeUndefined();
        expect(store.collections.legacyKeysRenamed_iron456).toBeUndefined();
        expect(store.collections.favorites_iron456).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** The predicate behind a checkbox, by the class name the CSS hangs off. */
function flag(className) {
    return collectionFilters.flags.find((f) => f.className === className);
}

describe('what each checkbox matches', () => {
    beforeEach(async () => {
        await collectionFilters._load();
    });

    test('the count ranges are inclusive at both ends and do not overlap', () => {
        const ranges = [
            ['cf-c1-9', 1, 9],
            ['cf-c10-79', 10, 79],
            ['cf-c80-99', 80, 99],
            ['cf-c100-799', 100, 799],
            ['cf-c800-999', 800, 999],
            ['cf-c1000-7999', 1000, 7999],
            ['cf-c8000-9999', 8000, 9999],
            ['cf-c10000-99999', 10_000, 99_999],
        ];

        for (const [className, from, to] of ranges) {
            const fn = flag(className).fn;
            expect(fn('milk', from)).toBe(true);
            expect(fn('milk', to)).toBe(true);
            expect(fn('milk', from - 1)).toBe(false);
            expect(fn('milk', to + 1)).toBe(false);
        }
    });

    test('the top range has no upper end', () => {
        const fn = flag('cf-c100000-Infinity').fn;
        expect(fn('milk', 100_000)).toBe(true);
        expect(fn('milk', 99_999)).toBe(false);
        expect(fn('milk', 5_000_000_000)).toBe(true);
    });

    test('an uncollected item is in no count range at all', () => {
        const ranges = collectionFilters.flags.filter((f) => 'from' in f);
        expect(ranges.map((f) => f.fn('milk', 0))).not.toContain(true);
    });

    test('the ranges are labelled the way they read', () => {
        expect(flag('cf-c1-9').label).toBe('1-9');
        expect(flag('cf-c10000-99999').label).toBe('10k-100k');
        expect(flag('cf-c100000-Infinity').label).toBe('100k+');
    });

    test('each dungeon matches its own drops', () => {
        expect(flag('cf-d1').fn('griffin_talon')).toBe(true);
        expect(flag('cf-d2').fn('griffin_talon')).toBe(false);
        expect(flag('cf-d2').fn('chaotic_flail')).toBe(true);
        expect(flag('cf-d3').fn('bishops_codex')).toBe(true);
        expect(flag('cf-d4').fn('kraken_fang')).toBe(true);
    });

    test('a refined version counts as the same dungeon drop', () => {
        expect(flag('cf-d1').fn('chimerical_quiver_refined')).toBe(true);
        expect(flag('cf-d3').fn('enchanted_cloak_refined')).toBe(true);
    });

    test('an ability drops from more than one dungeon', () => {
        expect(flag('cf-d1').fn('pestilent_shot')).toBe(true);
        expect(flag('cf-d2').fn('pestilent_shot')).toBe(true);
    });

    test('Not dungeon is everything no dungeon claims', () => {
        expect(flag('nod').fn('milk')).toBe(true);
        expect(flag('nod').fn('griffin_talon')).toBe(false);
        expect(flag('nod').fn('kraken_fang')).toBe(false);
        expect(flag('nod').fn('chimerical_quiver_refined')).toBe(false);
    });

    test('skilling outfits are tops and bottoms only', () => {
        expect(flag('skilling-outfit').fn('cheesemakers_top')).toBe(true);
        expect(flag('skilling-outfit').fn('enhancers_bottoms')).toBe(true);
        expect(flag('skilling-outfit').fn('milk')).toBe(false);
    });

    test('the uncollected filters only match what you have none of', () => {
        expect(flag('charm').fn('sighted_charm', 0)).toBe(true);
        expect(flag('charm').fn('sighted_charm', 1)).toBe(false);
        expect(flag('charm').fn('milk', 0)).toBe(false);
        expect(flag('celestial').fn('celestial_brush', 0)).toBe(true);
        expect(flag('celestial').fn('celestial_brush', 3)).toBe(false);
    });

    test('the uncollected filters start switched off, the rest switched on', () => {
        expect(flag('charm').checked).toBe(false);
        expect(flag('celestial').checked).toBe(false);
        expect(flag('cf-c1-9').checked).toBe(true);
        expect(flag('favorite').checked).toBe(true);
    });

    test('favourites is a display rule, not a predicate', () => {
        expect(flag('favorite').fn).toBeNull();
        expect(flag('favorite').generateCSS).toBe(false);
    });

    test('with favourites switched off there is no star checkbox', async () => {
        collectionFilters._favoritesEnabled = false;
        await collectionFilters._load();
        expect(flag('favorite')).toBeUndefined();
        expect(flag('cf-c1-9')).toBeDefined();
    });

    test('with filters switched off only the star checkbox is left', async () => {
        collectionFilters._filtersEnabled = false;
        await collectionFilters._load();
        expect(collectionFilters.flags.map((f) => f.className)).toEqual(['favorite']);
    });
});

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

/**
 * Build the Collections panel shape the game renders, with one tile per entry.
 * @param {Array<{itemId: string, count: string}>} tiles
 * @returns {{panelEl: HTMLElement, catsEl: HTMLElement}}
 */
function buildPanel(tiles) {
    document.body.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'AchievementsPanel_collections__qA6CY';

    const panelEl = document.createElement('div');
    panelEl.className = 'AchievementsPanel_controls__3bGFT';

    const catsEl = document.createElement('div');
    catsEl.className = 'AchievementsPanel_categories__34hno';

    for (const { itemId, count } of tiles) {
        const tile = document.createElement('div');
        tile.className = 'Collection_collectionContainer__3ZlUO';
        tile.innerHTML =
            `<svg><use href="/static/media/items_sprite.svg#${itemId}"></use></svg>` +
            `<div class="Collection_count__3oj-t">${count}</div>`;
        catsEl.appendChild(tile);
    }

    wrapper.appendChild(panelEl);
    wrapper.appendChild(catsEl);
    document.body.appendChild(wrapper);
    return { panelEl, catsEl };
}

const tileFor = (catsEl, itemId) =>
    [...catsEl.querySelectorAll('.Collection_collectionContainer__3ZlUO')].find((el) =>
        el
            .querySelector('use')
            .getAttribute('href')
            .endsWith('#' + itemId)
    );

describe('rendering the panel', () => {
    test('counts are read off the tiles, formatted suffixes and all', async () => {
        const { panelEl } = buildPanel([
            { itemId: 'milk', count: '1.5K' },
            { itemId: 'log', count: '2.3M' },
            { itemId: 'cheese', count: '12' },
            { itemId: 'egg', count: '0' },
        ]);

        collectionFilters._rerenderPanel(panelEl);

        expect(collectionFilters.collections).toEqual({ milk: 1500, log: 2_300_000, cheese: 12, egg: 0 });
    });

    test('the scan is persisted with the moment it happened', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T10:00:00Z'));
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '12' }]);

        collectionFilters._rerenderPanel(panelEl);
        await vi.advanceTimersByTimeAsync(0);

        expect(store.collections.collections_market123).toEqual({ milk: 12 });
        expect(store.collections.collectionsUpdatedAt_market123).toBe(Date.parse('2026-08-04T10:00:00Z'));
        expect(collectionFilters.collectionsLastUpdated).toBe(Date.parse('2026-08-04T10:00:00Z'));
    });

    test('every tile is classed by whichever filters it passes', () => {
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'griffin_talon', count: '150' },
        ]);

        collectionFilters._rerenderPanel(panelEl);

        const milk = tileFor(catsEl, 'milk');
        expect(milk.classList.contains('cf-c1-9')).toBe(true);
        expect(milk.classList.contains('cf-c10-79')).toBe(false);
        expect(milk.classList.contains('nod')).toBe(true);
        expect(milk.classList.contains('cf-d1')).toBe(false);

        const talon = tileFor(catsEl, 'griffin_talon');
        expect(talon.classList.contains('cf-c100-799')).toBe(true);
        expect(talon.classList.contains('cf-d1')).toBe(true);
        expect(talon.classList.contains('nod')).toBe(false);
    });

    test('a tile that no longer matches loses the class on the next pass', () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);
        collectionFilters._rerenderPanel(panelEl);
        expect(tileFor(catsEl, 'milk').classList.contains('cf-c1-9')).toBe(true);

        catsEl.querySelector('.Collection_count__3oj-t').textContent = '500';
        collectionFilters._rerenderPanel(panelEl);

        const milk = tileFor(catsEl, 'milk');
        expect(milk.classList.contains('cf-c1-9')).toBe(false);
        expect(milk.classList.contains('cf-c100-799')).toBe(true);
    });

    test('a checkbox goes in for every filter, checked as it was left', () => {
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);

        const boxes = panelEl.querySelectorAll('.AchievementsPanel_checkboxControl__3e6CJ.toolasha-cf');
        expect(boxes).toHaveLength(collectionFilters.flags.length);
        expect(panelEl.querySelector('.cf-c1-9 [data-testid="CheckBoxIcon"]')).toBeTruthy();
        expect(panelEl.querySelector('.charm [data-testid="CheckBoxOutlineBlankIcon"]')).toBeTruthy();
    });

    test('the categories element carries a show- class for every checked filter', () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);

        expect(catsEl.classList.contains('toolasha-cf')).toBe(true);
        expect(catsEl.classList.contains('show-cf-c1-9')).toBe(true);
        expect(catsEl.classList.contains('show-charm')).toBe(false); // starts unchecked
    });

    test('clicking a checkbox flips it, saves it and redraws', async () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);
        collectionFilters._rerenderPanel(panelEl);

        panelEl.querySelector('.cf-c1-9.toolasha-cf').dispatchEvent(new Event('click', { bubbles: true }));
        await vi.waitFor(() => expect(store.collections.flags_market123).toBeDefined());

        expect(flag('cf-c1-9').checked).toBe(false);
        expect(catsEl.classList.contains('show-cf-c1-9')).toBe(false);
        expect(store.collections.flags_market123['cf-c1-9']).toBe(false);
    });

    test('the charm and celestial boxes hide themselves until uncollected items are shown', () => {
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters.showUncollected = false;
        collectionFilters._rerenderPanel(panelEl);
        expect(panelEl.querySelector('.charm.toolasha-cf').getAttribute('style')).toContain('display: none');

        collectionFilters.showUncollected = true;
        collectionFilters._rerenderPanel(panelEl);
        expect(panelEl.querySelector('.charm.toolasha-cf').getAttribute('style')).not.toContain('display: none');
    });

    test('a tile with no item to identify it is skipped rather than crashing', () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);
        const broken = document.createElement('div');
        broken.className = 'Collection_collectionContainer__3ZlUO';
        catsEl.appendChild(broken);
        const alsoBroken = document.createElement('div');
        alsoBroken.className = 'Collection_collectionContainer__3ZlUO';
        alsoBroken.innerHTML = '<svg><use href="no-hash"></use></svg>';
        catsEl.appendChild(alsoBroken);

        expect(() => collectionFilters._rerenderPanel(panelEl)).not.toThrow();
        expect(collectionFilters.collections).toEqual({ milk: 5 });
    });

    test('a tile with no count element reads as none collected', () => {
        const { panelEl, catsEl } = buildPanel([]);
        const tile = document.createElement('div');
        tile.className = 'Collection_collectionContainer__3ZlUO';
        tile.innerHTML = '<svg><use href="#milk"></use></svg>';
        catsEl.appendChild(tile);

        collectionFilters._rerenderPanel(panelEl);

        expect(collectionFilters.collections).toEqual({ milk: 0 });
    });

    test('an empty collection renders controls and waits for tiles', () => {
        const { panelEl } = buildPanel([]);

        expect(() => collectionFilters._rerenderPanel(panelEl)).not.toThrow();

        expect(panelEl.querySelectorAll('.toolasha-cf').length).toBeGreaterThan(0);
        expect(collectionFilters.collections).toEqual({});
        expect(collectionFilters.catsObserver).not.toBeNull(); // watching for tiles to arrive
    });

    test('a panel with no categories element beside it does nothing', () => {
        const panelEl = document.createElement('div');
        panelEl.className = 'AchievementsPanel_controls__3bGFT';
        document.body.appendChild(panelEl);

        expect(() => collectionFilters._rerenderPanel(panelEl)).not.toThrow();
        expect(panelEl.querySelector('.toolasha-cf')).toBeNull();
    });

    test('redrawing does not leave two of every checkbox behind', () => {
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);
        collectionFilters._rerenderPanel(panelEl);

        expect(panelEl.querySelectorAll('.cf-c1-9.toolasha-cf')).toHaveLength(1);
        expect(panelEl.querySelectorAll('.cf-sort-select')).toHaveLength(1);
    });

    test('with filters off, tiles are starred but not classed', () => {
        collectionFilters._filtersEnabled = false;
        collectionFilters.flags = collectionFilters.flags.filter((f) => f.className === 'favorite');
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);

        const milk = tileFor(catsEl, 'milk');
        expect(milk.classList.contains('cf-c1-9')).toBe(false);
        expect(milk.querySelector('.toolasha-cf.star')).toBeTruthy();
    });
});

describe('starring an item', () => {
    test('a star goes on every tile and remembers what was starred', () => {
        collectionFilters.favorites = { milk: true };
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '5' },
        ]);

        collectionFilters._rerenderPanel(panelEl);

        // The starred tile has been lifted into the favourites section by now,
        // so both stars are counted from the document rather than the grid
        expect(document.querySelectorAll('.toolasha-cf.star')).toHaveLength(2);
        expect(tileFor(document, 'milk').classList.contains('cf-favorite')).toBe(true);
        expect(tileFor(catsEl, 'log').classList.contains('cf-favorite')).toBe(false);
    });

    test('clicking the star adds the item, clicking again takes it away', async () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);
        collectionFilters._rerenderPanel(panelEl);
        const star = tileFor(catsEl, 'milk').querySelector('.toolasha-cf.star');

        star.dispatchEvent(new Event('click', { bubbles: true }));
        expect(collectionFilters.favorites).toEqual({ milk: true });
        // starring lifts the tile into the favourites section, so look for it
        // in the document rather than in the grid it came from
        expect(tileFor(document, 'milk').classList.contains('cf-favorite')).toBe(true);
        await vi.waitFor(() => expect(store.collections.favorites_market123).toEqual({ milk: true }));

        star.dispatchEvent(new Event('click', { bubbles: true }));
        expect(collectionFilters.favorites).toEqual({});
        expect(tileFor(document, 'milk').classList.contains('cf-favorite')).toBe(false);
    });

    test('a redraw does not stack up stars', () => {
        const { panelEl, catsEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);
        collectionFilters._rerenderPanel(panelEl);

        expect(tileFor(catsEl, 'milk').querySelectorAll('.toolasha-cf.star')).toHaveLength(1);
    });

    test('favourites are lifted into their own section at the top', () => {
        collectionFilters.favorites = { log: true };
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '5' },
        ]);

        collectionFilters._rerenderPanel(panelEl);

        const section = document.querySelector('.toolasha-cf-favorites-section');
        expect(section).toBeTruthy();
        expect(section.querySelector('.toolasha-cf-favorites-header').textContent).toBe('Favorites');
        expect(section.querySelectorAll('.Collection_collectionContainer__3ZlUO')).toHaveLength(1);
        expect(section.nextElementSibling).toBe(catsEl); // sits above the grid
    });

    test('un-starring the last favourite puts the tile back where it came from', () => {
        collectionFilters.favorites = { log: true };
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '5' },
            { itemId: 'egg', count: '5' },
        ]);
        collectionFilters._rerenderPanel(panelEl);
        expect(catsEl.children).toHaveLength(2);

        collectionFilters.favorites = {};
        collectionFilters._renderFavoritesSection(catsEl);

        expect(document.querySelector('.toolasha-cf-favorites-section')).toBeNull();
        const order = [...catsEl.children].map((el) => el.querySelector('use').getAttribute('href').split('#')[1]);
        expect(order).toEqual(['milk', 'log', 'egg']);
    });

    test('with the section switched off the tiles stay in the grid', () => {
        mockConfig.settings.collectionFavoritesSection = false;
        collectionFilters.favorites = { log: true };
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '5' },
        ]);

        collectionFilters._rerenderPanel(panelEl);

        expect(document.querySelector('.toolasha-cf-favorites-section')).toBeNull();
        expect(catsEl.children).toHaveLength(2);
    });

    test('no favourites means no section', () => {
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '5' }]);
        collectionFilters._rerenderPanel(panelEl);
        expect(document.querySelector('.toolasha-cf-favorites-section')).toBeNull();
    });
});

describe('sorting the tiles', () => {
    test('the default order is the game’s own', () => {
        const { panelEl, catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '950' },
        ]);
        collectionFilters._rerenderPanel(panelEl);

        expect(tileFor(catsEl, 'milk').style.order).toBe('');
        expect(tileFor(catsEl, 'log').style.order).toBe('');
    });

    test('by items needed, the nearest tier first', () => {
        const { catsEl } = buildPanel([
            { itemId: 'milk', count: '5' }, // 10 - 5 = 5 to go
            { itemId: 'log', count: '950' }, // 1000 - 950 = 50 to go
            { itemId: 'egg', count: '0' }, // 10 - 0 = 10 to go
        ]);
        collectionFilters.collections = { milk: 5, log: 950, egg: 0 };
        collectionFilters.sortMode = 'items-needed';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'milk').style.order).toBe('0');
        expect(tileFor(catsEl, 'egg').style.order).toBe('1');
        expect(tileFor(catsEl, 'log').style.order).toBe('2');
    });

    test('an item already at the top tier sorts last', () => {
        const { catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'coin', count: '2M' },
        ]);
        collectionFilters.collections = { milk: 5, coin: 2_000_000_000_000_000 };
        collectionFilters.sortMode = 'items-needed';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'milk').style.order).toBe('0');
        expect(tileFor(catsEl, 'coin').style.order).toBe('1');
    });

    test('by gold cost, what the missing items would cost to buy', () => {
        mockMarket.prices['/items/milk'] = { ask: 100 }; // 5 short × 100 = 500
        mockMarket.prices['/items/log'] = { ask: 5 }; // 50 short × 5 = 250
        const { catsEl } = buildPanel([
            { itemId: 'milk', count: '5' },
            { itemId: 'log', count: '950' },
            { itemId: 'egg', count: '0' }, // unpriced — sorts last
        ]);
        collectionFilters.collections = { milk: 5, log: 950, egg: 0 };
        collectionFilters.sortMode = 'gold-cost';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'log').style.order).toBe('0');
        expect(tileFor(catsEl, 'milk').style.order).toBe('1');
        expect(tileFor(catsEl, 'egg').style.order).toBe('2');
    });

    test('by time, with the wait written under each tile', () => {
        // One action a 10-second cycle, no efficiency or gathering bonus, so 360/hour
        mockDataManager.clientData = {
            actionDetailMap: {
                '/actions/milking/cow': { dropTable: [{ itemHrid: '/items/milk', count: 1, dropRate: 1 }] },
                '/actions/woodcutting/tree': { dropTable: [{ itemHrid: '/items/log', count: 1, dropRate: 1 }] },
            },
        };
        const { catsEl } = buildPanel([
            { itemId: 'milk', count: '9280' }, // 720 short at 360/h = 2h
            { itemId: 'log', count: '82720' }, // 17280 short at 360/h = 48h
            { itemId: 'egg', count: '5' }, // nothing produces it
        ]);
        collectionFilters.collections = { milk: 9280, log: 82_720, egg: 5 };
        collectionFilters.sortMode = 'time-to-next-tier';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'milk').style.order).toBe('0');
        expect(tileFor(catsEl, 'log').style.order).toBe('1');
        expect(tileFor(catsEl, 'egg').style.order).toBe('2');
        expect(tileFor(catsEl, 'milk').querySelector('.time-to-tier').textContent).toBe('2h 0m');
        expect(tileFor(catsEl, 'log').querySelector('.time-to-tier').textContent).toBe('2d 0h');
        expect(tileFor(catsEl, 'egg').querySelector('.time-to-tier')).toBeNull();
    });

    test('a wait under an hour is written in minutes', () => {
        mockDataManager.clientData = {
            actionDetailMap: {
                '/actions/milking/cow': { dropTable: [{ itemHrid: '/items/milk', count: 1, dropRate: 1 }] },
            },
        };
        const { catsEl } = buildPanel([{ itemId: 'milk', count: '9910' }]); // 90 short at 360/h = 15m
        collectionFilters.collections = { milk: 9910 };
        collectionFilters.sortMode = 'time-to-next-tier';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'milk').querySelector('.time-to-tier').textContent).toBe('15m');
    });

    test('a gathering drop pays its min/max range, not one item an action', () => {
        // The game's dropTable carries minCount/maxCount and no `count` at all.
        // Read as one item an action, a 2-6 drop overstated the wait fourfold.
        mockDataManager.clientData = {
            actionDetailMap: {
                '/actions/milking/cow': {
                    dropTable: [{ itemHrid: '/items/milk', minCount: 2, maxCount: 6, dropRate: 1 }],
                },
            },
        };
        // 720 short, at 360 actions/hour × 4 milk each = 1440/h, so half an hour
        const { catsEl } = buildPanel([{ itemId: 'milk', count: '9280' }]);
        collectionFilters.collections = { milk: 9280 };
        collectionFilters.sortMode = 'time-to-next-tier';

        collectionFilters._applySorting(catsEl);

        expect(tileFor(catsEl, 'milk').querySelector('.time-to-tier').textContent).toBe('30m');
    });

    test('switching back to the default clears the time badges', () => {
        mockDataManager.clientData = {
            actionDetailMap: {
                '/actions/milking/cow': { dropTable: [{ itemHrid: '/items/milk', count: 1, dropRate: 1 }] },
            },
        };
        const { catsEl } = buildPanel([{ itemId: 'milk', count: '9280' }]);
        collectionFilters.collections = { milk: 9280 };
        collectionFilters.sortMode = 'time-to-next-tier';
        collectionFilters._applySorting(catsEl);
        expect(catsEl.querySelector('.time-to-tier')).toBeTruthy();

        collectionFilters.sortMode = 'default';
        collectionFilters._applySorting(catsEl);

        expect(catsEl.querySelector('.time-to-tier')).toBeNull();
        expect(tileFor(catsEl, 'milk').style.order).toBe('');
        expect(tileFor(catsEl, 'milk').style.marginBottom).toBe('');
    });

    test('a produced item counts a whole crafting cycle, not a drop rate', () => {
        mockDataManager.clientData = {
            actionDetailMap: {
                '/actions/cheesesmithing/cheese_gauntlets': {
                    inputItems: [{ itemHrid: '/items/cheese', count: 6 }],
                    outputItems: [{ itemHrid: '/items/cheese_gauntlets', count: 2 }],
                },
            },
        };
        const { catsEl } = buildPanel([{ itemId: 'cheese_gauntlets', count: '9280' }]);
        collectionFilters.collections = { cheese_gauntlets: 9280 };
        collectionFilters.sortMode = 'time-to-next-tier';

        collectionFilters._applySorting(catsEl);

        // 2 per 10-second action = 720/hour, so 720 short is one hour
        expect(tileFor(catsEl, 'cheese_gauntlets').querySelector('.time-to-tier').textContent).toBe('1h 0m');
    });

    test('the chosen sort is remembered with the checkbox states', async () => {
        collectionFilters.sortMode = 'gold-cost';

        await collectionFilters._saveFlags();

        expect(store.collections.flags_market123.__sortMode).toBe('gold-cost');
        expect(store.collections.flags_market123['cf-c1-9']).toBe(true);
    });

    test('and comes back on the next load', async () => {
        store.collections.flags_market123 = { __sortMode: 'items-needed', 'cf-c1-9': false, 'no-such-flag': true };

        await collectionFilters._load();

        expect(collectionFilters.sortMode).toBe('items-needed');
        expect(flag('cf-c1-9').checked).toBe(false);
        expect(flag('cf-c10-79').checked).toBe(true); // untouched flags keep their default
    });

    test('the dropdown offers the four modes with the current one selected', () => {
        collectionFilters.sortMode = 'gold-cost';
        const { panelEl } = buildPanel([{ itemId: 'milk', count: '5' }]);

        collectionFilters._rerenderPanel(panelEl);

        const select = panelEl.querySelector('.cf-sort-select');
        expect([...select.options].map((o) => o.value)).toEqual([
            'default',
            'items-needed',
            'gold-cost',
            'time-to-next-tier',
        ]);
        expect(select.querySelectorAll('option[selected]')).toHaveLength(1);
        expect(select.querySelector('option[selected]').value).toBe('gold-cost');
    });
});

describe('the badge on a skilling tile', () => {
    /** The skilling grid shape, one tile per action. */
    function buildGrid(actionIds) {
        document.body.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'SkillActionGrid_skillActionGrid__1tJFk';
        for (const actionId of actionIds) {
            const tile = document.createElement('div');
            tile.className = 'SkillAction_skillAction__1esCp';
            tile.innerHTML =
                `<svg><use href="/static/media/items_sprite.svg#${actionId}"></use></svg>` +
                `<div class="SkillAction_name__2VPXa">${actionId}</div>`;
            grid.appendChild(tile);
        }
        document.body.appendChild(grid);
        return grid;
    }

    const badgeIn = (grid, actionId) =>
        [...grid.querySelectorAll('.SkillAction_skillAction__1esCp')]
            .find((el) =>
                el
                    .querySelector('use')
                    .getAttribute('href')
                    .endsWith('#' + actionId)
            )
            ?.querySelector('.toolasha-cf.collection-badge');

    test('an action is badged with the count of what it produces', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T10:00:00Z'));
        collectionFilters.collections = { milk: 12_500, log: 5 };
        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-04T08:00:00Z');
        const grid = buildGrid(['cow', 'tree']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow').textContent).toBe('12.5K');
        expect(badgeIn(grid, 'tree').textContent).toBe('5');
    });

    test('every cow and tree knows which item it makes', () => {
        collectionFilters.collections = { rainbow_milk: 3, arcane_log: 7 };
        const grid = buildGrid(['unicow', 'arcane_tree']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'unicow').textContent).toBe('3');
        expect(badgeIn(grid, 'arcane_tree').textContent).toBe('7');
    });

    test('an action producing nothing you have collected gets no badge', () => {
        collectionFilters.collections = { milk: 10 };
        const grid = buildGrid(['cow', 'tree']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow')).toBeTruthy();
        expect(badgeIn(grid, 'tree')).toBeFalsy();
    });

    test('with nothing scanned yet, nothing is badged', () => {
        collectionFilters.collections = {};
        const grid = buildGrid(['cow']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow')).toBeFalsy();
    });

    test('the count decides the tier colour', () => {
        collectionFilters.collections = { milk: 0, log: 500, birch_log: 12_500 };
        const grid = buildGrid(['cow', 'tree', 'birch_tree']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow').className).toContain('Collection_tierGray__279Mp');
        expect(badgeIn(grid, 'tree').className).toContain('Collection_tierBlue__3uYl-');
        expect(badgeIn(grid, 'birch_tree').className).toContain('Collection_tierRed__3dV_1');
    });

    test('a badge is replaced, not doubled, when the grid is redrawn', () => {
        collectionFilters.collections = { milk: 10 };
        const grid = buildGrid(['cow']);

        collectionFilters._addSkillingBadges(grid);
        collectionFilters.collections.milk = 20;
        collectionFilters._addSkillingBadges(grid);

        const tile = grid.querySelector('.SkillAction_skillAction__1esCp');
        expect(tile.querySelectorAll('.collection-badge')).toHaveLength(1);
        expect(badgeIn(grid, 'cow').textContent).toBe('20');
    });

    test('fresh data keeps the tier colour, stale data overrides it', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));

        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-04T09:00:00Z'); // 3h
        expect(collectionFilters._getBadgeStalenessColor()).toBeNull();

        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-04T04:00:00Z'); // 8h
        expect(collectionFilters._getBadgeStalenessColor()).toBe('#FFAA00');

        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-03T12:00:00Z'); // 24h
        expect(collectionFilters._getBadgeStalenessColor()).toBe('#FF6600');

        collectionFilters.collectionsLastUpdated = null;
        expect(collectionFilters._getBadgeStalenessColor()).toBe('#999999');
    });

    test('the stale colour is written onto the count, not the tier class', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        collectionFilters.collections = { milk: 12_500 };
        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-03T12:00:00Z');
        const grid = buildGrid(['cow']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow').className).toContain('Collection_tierRed__3dV_1');
        expect(badgeIn(grid, 'cow').querySelector('.Collection_count__3oj-t').style.color).toBeTruthy();
    });

    test('the tooltip says how much and how long ago', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        collectionFilters.collectionsLastUpdated = Date.parse('2026-08-04T10:00:00Z');

        expect(collectionFilters._getBadgeStalenessTooltip(12_500)).toBe('12.5K collected — updated 2h 0m ago');
    });

    test('and says so plainly when there is nothing to report', () => {
        collectionFilters.collectionsLastUpdated = null;
        expect(collectionFilters._getBadgeStalenessTooltip(12_500)).toBe(
            'Collection data not yet loaded — visit Collections page to refresh'
        );
    });

    test('the count is abbreviated the way the game abbreviates it', () => {
        collectionFilters.collections = { milk: 9999, log: 10_000, birch_log: 1_500_000 };
        const grid = buildGrid(['cow', 'tree', 'birch_tree']);

        collectionFilters._addSkillingBadges(grid);

        expect(badgeIn(grid, 'cow').textContent).toBe('9999');
        expect(badgeIn(grid, 'tree').textContent).toBe('10K');
        expect(badgeIn(grid, 'birch_tree').textContent).toBe('1.50M');
    });
});

describe('the injected stylesheet', () => {
    test('every filter gets a hide rule, and the star styles come with favourites', async () => {
        await collectionFilters._load();

        collectionFilters._buildCSS();

        const css = document.getElementById('toolasha-cf-styles').textContent;
        expect(css).toContain('.AchievementsPanel_categories__34hno.toolasha-cf:not(.show-cf-c1-9)');
        expect(css).toContain('.show-favorite');
        expect(css).not.toContain(':not(.show-favorite)'); // favourites reveal, they do not hide
    });

    test('with favourites off, no star styles are injected', async () => {
        collectionFilters._favoritesEnabled = false;
        await collectionFilters._load();

        collectionFilters._buildCSS();

        expect(document.getElementById('toolasha-cf-styles').textContent).not.toContain('.toolasha-cf.star');
    });

    test('rebuilding replaces the sheet rather than adding another', () => {
        collectionFilters._buildCSS();
        collectionFilters._buildCSS();

        expect(document.querySelectorAll('#toolasha-cf-styles')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// The stored state surviving a read that cannot be made
// ---------------------------------------------------------------------------

describe('the favourites survive a read that cannot be made', () => {
    test('a load while storage is unreadable keeps what is in hand instead of blanking it', async () => {
        store.collections.favorites_market123 = { '/items/milk': true };
        await collectionFilters._load();
        collectionFilters.favorites['/items/log'] = true;

        store.unavailable = true;
        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ '/items/milk': true, '/items/log': true });
        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        store.collections.favorites_market123 = { '/items/milk': true };
        store.unavailable = true;
        await collectionFilters._load();
        collectionFilters.favorites['/items/log'] = true;

        await collectionFilters._saveFavorites();
        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });

        store.unavailable = false;
        await collectionFilters._saveFavorites();
        // Never read back, so the stored star is kept alongside the new one
        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true, '/items/log': true });
    });

    test('once read back, an un-starring sticks', async () => {
        store.collections.favorites_market123 = { '/items/milk': true, '/items/log': true };
        await collectionFilters._load();
        delete collectionFilters.favorites['/items/milk'];

        await collectionFilters._saveFavorites();
        expect(store.collections.favorites_market123).toEqual({ '/items/log': true });
    });

    test('another character’s favourites never stand in for this one’s, readable or not', async () => {
        store.collections.favorites_market123 = { '/items/milk': true };
        await collectionFilters._load();

        mockDataManager.characterId = 'iron456';
        store.unavailable = true;
        await collectionFilters._load();
        expect(collectionFilters.favorites).toEqual({});

        store.unavailable = false;
        collectionFilters.favorites['/items/log'] = true;
        await collectionFilters._saveFavorites();
        expect(store.collections.favorites_iron456).toEqual({ '/items/log': true });
        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });
    });

    test('a load settling after a switch does not apply the departing character’s filters', async () => {
        store.collections.flags_market123 = { 'cf-c1-9': true, __sortMode: 'gold-cost' };
        store.collections.showUncollected_market123 = true;
        collectionFilters.sortMode = 'default';
        collectionFilters.showUncollected = false;

        // Every read was issued under market123; the player is on the iron cow
        // by the time they land
        store.onRead = () => {
            mockDataManager.characterId = 'iron456';
            store.onRead = null;
        };

        await collectionFilters._load();

        // Applying them would show the iron cow the market character's
        // checkboxes and sort mode — and the first toggle files that mix under
        // the iron cow's own keys
        expect(collectionFilters.sortMode).toBe('default');
        expect(collectionFilters.showUncollected).toBe(false);
    });

    test('the flag states and scanned counts are kept the same way', async () => {
        store.collections.flags_market123 = { 'cf-c1-9': true, __sortMode: 'gold-cost' };
        store.collections.collections_market123 = { '/items/milk': 12 };
        await collectionFilters._load();
        expect(collectionFilters.sortMode).toBe('gold-cost');
        expect(collectionFilters.collections).toEqual({ '/items/milk': 12 });

        store.unavailable = true;
        await collectionFilters._load();
        expect(collectionFilters.flags.find((f) => f.className === 'cf-c1-9').checked).toBe(true);
        expect(collectionFilters.collections).toEqual({ '/items/milk': 12 });

        collectionFilters.collections['/items/log'] = 3;
        await collectionFilters._saveCollections();
        expect(store.collections.collections_market123).toEqual({ '/items/milk': 12 });
        store.unavailable = false;
        await collectionFilters._saveCollections();
        expect(store.collections.collections_market123).toEqual({ '/items/milk': 12, '/items/log': 3 });
    });
});
