/**
 * @vitest-environment happy-dom
 *
 * The Watchlist panel, built rather than reasoned about.
 *
 * The set algebra and the drop-table walking are tested where they live. What
 * only building the panel catches is the joins: that ticking a checkbox reaches
 * the list, that a row draws for an item the character does not hold, and that
 * every section draws at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    data: {},
    inventory: [],
    prices: {},
    characterId: 'market123',
    gameMode: 'standard',
    dmHandlers: {},
}));

/** A small in-memory store, so a scoped key and a legacy one are distinguishable */
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
        reset: () => {
            stores.clear();
            storageMock.unavailable = false;
        },
        ready: Promise.resolve(true),
        unavailable: false,
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
const settings = vi.hoisted(() => ({}));
const listeners = vi.hoisted(() => ({}));
const observed = vi.hoisted(() => []);
const badges = vi.hoisted(() => ({ provider: null }));

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        getInventory: () => game.inventory,
        getItemDetails: (hrid) => game.data.itemDetailMap?.[hrid],
        // The list is one character's, so the module keys on the character and
        // asks to be told when it changes
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => game.gameMode,
        // Two things in this module listen for the same events now — the list's
        // own reload, and the counter the overlay tile's `version()` reads — so
        // the mock has to fan out rather than keep only the last registration.
        // The first handler's return value is the one handed back, because that
        // is the reload, and the tests await it.
        on: (event, handler) => {
            const existing = game.dmHandlers[event];
            game.dmHandlers[event] = existing
                ? (...args) => {
                      handler(...args);
                      return existing(...args);
                  }
                : handler;
        },
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
// Keyed `hrid` at +0 and `hrid:level` above it, as the real one is: a row that
// carries an enhancement level has to be able to be priced at it
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[level > 0 ? `${hrid}:${level}` : hrid] || null,
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./inventory-badge-manager.js', () => ({
    default: {
        registerProvider: (_name, provide) => {
            badges.provider = provide;
        },
        unregisterProvider: () => {
            badges.provider = null;
        },
        invalidateCache: () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings[key],
        setSetting: (key, value) => {
            settings[key] = value;
            for (const cb of listeners[key] || []) cb(value);
        },
        onSettingChange: (key, cb) => {
            listeners[key] = listeners[key] || [];
            listeners[key].push(cb);
            return () => {
                listeners[key] = (listeners[key] || []).filter((registered) => registered !== cb);
            };
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            observed.push({ name, className, callback });
            return () => {
                observed.splice(
                    observed.findIndex((entry) => entry.name === name),
                    1
                );
            };
        },
    },
}));

const {
    watchlistPanel,
    watchlistRows,
    watchItem,
    isWatched,
    watchlistEntries,
    clearWatchlist,
    unwatchItem,
    flushWatchlistWrites,
    WATCHLIST_CSV_COLUMNS,
    default: watchlist,
} = await import('./watchlist.js');
const { toCsv } = await import('../../utils/csv-export.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
// The real registry, so the overlay tile registered by the module above can be
// asked for its `version()`
const { registeredRows } = await import('../../utils/overlay-rows.js');

const itemDetailMap = {
    '/items/coin': { name: 'Coin' },
    '/items/cheese': { name: 'Cheese', sellPrice: 10 },
    '/items/rare_hat': { name: 'Rare Hat', sellPrice: 5000 },
    '/items/trainee_charm': { name: 'Trainee Charm', sellPrice: 250000 },
    '/items/purples_gift': { name: "Purple's Gift", sellPrice: 100 },
};

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    game.characterId = 'market123';
    game.gameMode = 'standard';
    // The master toggle, on by default in the schema; initialize() is a no-op
    // without it, which is its own test below
    settings.watchlist = true;
    game.data = {
        itemDetailMap,
        actionDetailMap: {
            '/actions/combat/rat_hole': {
                name: 'Rat Hole',
                combatZoneInfo: {
                    fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/rat' }] } },
                },
            },
        },
        combatMonsterDetailMap: {
            '/monsters/rat': {
                dropTable: [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/coin' }],
                rareDropTable: [{ itemHrid: '/items/rare_hat' }],
            },
        },
        openableLootDropMap: { '/items/purples_gift': [{ itemHrid: '/items/rare_hat' }] },
    };
    game.inventory = [{ itemHrid: '/items/cheese', count: 40 }];
    game.prices = {
        '/items/cheese': { ask: 100, bid: 90 },
        '/items/rare_hat': { ask: 20000, bid: 400 },
        '/items/trainee_charm': { ask: 0, bid: 0 },
    };
});

afterEach(() => {
    watchlistPanel.hide();
    clearWatchlist();
    watchlistPanel.collapsed = { zones: true, chests: true };
    watchlist.cleanup();
    observed.length = 0;
    for (const key of Object.keys(settings)) delete settings[key];
    for (const key of Object.keys(listeners)) delete listeners[key];
});

/** Build the game's item menu for one item */
function itemMenu(name) {
    const menu = document.createElement('div');
    menu.className = 'Item_actionMenu__abc';
    const label = document.createElement('div');
    label.className = 'Item_name__xyz';
    label.textContent = name;
    const sell = document.createElement('button');
    sell.className = 'Button_button__ABC';
    sell.textContent = 'Sell';
    menu.append(label, sell);
    document.body.appendChild(menu);
    return menu;
}

/** Fire the observer as the game opening a menu would */
function openMenu(name) {
    const menu = itemMenu(name);
    for (const entry of observed) entry.callback(menu);
    return menu;
}

const trackButton = (menu) => menu.querySelector('.toolasha-watchlist-track');

const text = () => watchlistPanel.panel.textContent;
const FAILED = 'could not be drawn';
const checkboxes = () => [...watchlistPanel.panel.querySelectorAll('input[type="checkbox"]')];

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        expect(text()).toContain('Zones');
        expect(text()).toContain('Chests');
        expect(text()).toContain('Cheese');
        expect(text()).not.toContain(FAILED);
    });

    test('an empty list says how to fill it rather than showing nothing', () => {
        watchlistPanel.show();
        expect(text()).toContain('tick a zone');
        expect(text()).not.toContain(FAILED);
    });

    test('it draws before the game has sent anything', () => {
        game.data = {};
        watchlistPanel.show();
        expect(text()).not.toContain(FAILED);
    });

    test('opening it twice does not build a second one', () => {
        watchlistPanel.show();
        watchlistPanel.show();
        expect(document.querySelectorAll('#toolasha-watchlist-panel')).toHaveLength(1);
    });

    test('unchanged inputs leave the DOM nodes alone', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        watchlistPanel._render();
        const before = watchlistPanel.bodyEl.firstElementChild;
        expect(before).not.toBeNull();

        // Same rows, same prices: the scratch build serialises identically and
        // the live body is kept rather than swapped — node identity proves it
        watchlistPanel._render();
        expect(watchlistPanel.bodyEl.firstElementChild).toBe(before);
    });
});

describe('ticking a zone', () => {
    test('adds everything it drops, coins excluded', () => {
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));

        const tracked = watchlistEntries().map((entry) => entry.hrid);
        expect(tracked).toContain('/items/cheese');
        expect(tracked).toContain('/items/rare_hat');
        expect(tracked).not.toContain('/items/coin');
    });

    test('un-ticking it takes them off again', () => {
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const tick = () => {
            const box = checkboxes()[0];
            box.checked = !box.checked;
            box.dispatchEvent(new Event('change'));
        };
        tick();
        expect(watchlistEntries().length).toBeGreaterThan(0);

        tick();
        expect(watchlistEntries()).toEqual([]);
    });

    test('an item added by hand survives un-ticking the zone that also has it', () => {
        // It was never the zone's to take
        watchItem('/items/cheese');
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        box.checked = false;
        box.dispatchEvent(new Event('change'));

        expect(watchlistEntries().map((entry) => entry.hrid)).toEqual(['/items/cheese']);
    });
});

describe('the rows', () => {
    test('an item you hold none of is still a row, since that is the point', () => {
        watchItem('/items/rare_hat');
        watchlistPanel.show();

        expect(text()).toContain('Rare Hat');
        const row = watchlistRows().find((entry) => entry.hrid === '/items/rare_hat');
        expect(row.quantity).toBe(0);
    });

    test('the held count sums every stack rather than reporting one', () => {
        // The same item at two enhancement levels is two inventory entries
        game.inventory = [
            { itemHrid: '/items/cheese', count: 40 },
            { itemHrid: '/items/cheese', count: 2 },
        ];
        watchItem('/items/cheese');
        expect(watchlistRows()[0].quantity).toBe(42);
    });

    test('an equipped copy with no count field still counts as held', () => {
        // Equipped items don't reliably carry a count field the way stacked
        // inventory items do (see loadout-snapshot.js highestOwnedEnhancements
        // and equipment-savings-row.js highestOwnedLevel/ladderStart for the
        // same family of bug). A tracked item sitting only in an equipment
        // slot must still read as one held, not zero.
        game.inventory = [
            { itemHrid: '/items/rare_hat', itemLocationHrid: '/item_locations/head', enhancementLevel: 3 },
        ];
        watchItem('/items/rare_hat');
        expect(watchlistRows()[0].quantity).toBe(1);
    });

    test('a stack removed from a location (count 0) does not count as held', () => {
        game.inventory = [{ itemHrid: '/items/cheese', count: 0 }];
        watchItem('/items/cheese');
        expect(watchlistRows()[0].quantity).toBe(0);
    });

    test('a bid below the vendor price is flagged, and the vendor price is used', () => {
        // Rare Hat bids 400 against a 5,000 vendor price
        watchItem('/items/rare_hat');
        game.inventory = [{ itemHrid: '/items/rare_hat', count: 2 }];

        const row = watchlistRows()[0];
        expect(row.flag).toBe('below-vendor');
        expect(row.totalBid).toBe(10000);

        watchlistPanel.show();
        expect(text()).toContain('⚠');
    });

    test('an item with no market at all reports what the vendor pays', () => {
        watchItem('/items/trainee_charm');
        game.inventory = [{ itemHrid: '/items/trainee_charm', count: 1 }];

        const row = watchlistRows()[0];
        expect(row.flag).toBe('no-market');
        expect(row.totalBid).toBe(250000);
    });

    test('a row watched at a level is priced, counted and named at that level', () => {
        // The upgrade advisor's Watch button hands over "Cheese Sword +5". Put
        // on the list as a plain Cheese Sword it would quote the +0 ask, which
        // is a fraction of the price of the thing the row was about
        game.prices['/items/cheese:5'] = { ask: 9000, bid: 8000 };
        game.inventory = [
            { itemHrid: '/items/cheese', count: 40 },
            { itemHrid: '/items/cheese', count: 1, enhancementLevel: 5 },
        ];

        watchItem('/items/cheese', null, 5);
        const [row] = watchlistRows();

        expect(row.name).toBe('Cheese +5');
        expect(row.ask).toBe(9000);
        // The +0s in the bag are not copies of what this row is saving for
        expect(row.quantity).toBe(1);
    });

    test('the +0 and the +5 of one item are two rows, and each can go on its own', () => {
        game.prices['/items/cheese:5'] = { ask: 9000, bid: 8000 };
        watchItem('/items/cheese');
        watchItem('/items/cheese', null, 5);

        expect(watchlistRows()).toHaveLength(2);

        unwatchItem('/items/cheese', 5);
        const left = watchlistRows();
        expect(left).toHaveLength(1);
        expect(left[0].ask).toBe(100);
    });

    test('removing a row takes it off the list', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        watchlistPanel.panel.querySelector('[data-remove-item="/items/cheese"]').click();

        expect(isWatched('/items/cheese')).toBe(false);
    });
});

describe('clearing', () => {
    test('empties the list and unticks the sets together', () => {
        // Leaving the boxes ticked would have every checkbox claiming to have
        // put rows on a list with no rows on it
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(watchlistEntries().length).toBeGreaterThan(0);

        watchlistPanel.panel.querySelector('[data-clear-all]').click();

        expect(watchlistEntries()).toEqual([]);
        expect(checkboxes()[0].checked).toBe(false);
    });
});

describe('the header', () => {
    test('counts what is held against what is tracked', () => {
        watchItem('/items/cheese');
        watchItem('/items/rare_hat');
        watchlistPanel.show();

        // Cheese is held, the hat is not
        expect(watchlistPanel.headerCount.textContent).toBe('1 / 2');
    });
});

describe('the CSV export', () => {
    const exportButton = () =>
        [...watchlistPanel.panel.querySelectorAll('button')].find((el) => el.textContent === 'Export CSV');

    test('is disabled until something is tracked, then enabled', () => {
        watchlistPanel.show();
        expect(exportButton().disabled).toBe(true);

        watchItem('/items/cheese');
        watchlistPanel._render();

        expect(exportButton().disabled).toBe(false);
    });

    test('carries the expected header and a row per tracked item', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        const csv = toCsv(watchlistRows(), WATCHLIST_CSV_COLUMNS);

        expect(csv).toContain(
            'Item,Enhancement,Held,Listed,Unclaimed,Total Qty,Ask (unit),Bid (unit),Total Ask,Total Bid,Flag'
        );
        expect(csv).toContain('Cheese');
    });

    test('clicking it does nothing harmful when the list is empty', () => {
        watchlistPanel.show();
        expect(() => exportButton().click()).not.toThrow();
    });
});

describe('a save landing between the teardown and the reload', () => {
    test('does not replace the arriving character’s list with this one’s', async () => {
        storageMock.storeFor('settings').set('watchlist_iron456', {
            items: { '/items/rare_hat': { hrid: '/items/rare_hat' } },
        });

        watchItem('/items/cheese');
        await flushWatchlistWrites();

        // The awaited `character_switching`: the feature is torn down before
        // `characterKey()` moves. `reload()` — the only other place the record
        // is reset — does not run until the deferred `character_initialized`.
        watchlist.cleanup();
        game.characterId = 'iron456';

        // Anything that persists in that gap (a Track click on a menu the
        // teardown has not reached, a panel toggle) writes to the arriving
        // character's key
        watchItem('/items/milk');
        await flushWatchlistWrites();

        const theirs = storageMock.storeFor('settings').get('watchlist_iron456');
        expect(Object.keys(theirs.items)).toContain('/items/rare_hat');
    });
});

describe('cleanup unregisters the setting-change listeners it registered', () => {
    test('a character-switch cycle does not accumulate listeners', () => {
        // Every character switch runs cleanup() then initialize() again
        // (feature-registry.js). If the unregister functions onSettingChange
        // hands back are discarded, each cycle leaves one more copy of the
        // same callback on config's per-key list.
        watchlist.cleanup();
        for (let i = 0; i < 3; i++) {
            watchlist.initialize();
            watchlist.cleanup();
        }
        watchlist.initialize();

        expect(listeners.watchlist_menuButton || []).toHaveLength(1);
        expect(listeners.watchlist_inventoryDots || []).toHaveLength(1);
    });
});

describe('the Track button in the item menu', () => {
    test('the master toggle off means initialize touches nothing', () => {
        // The checkbox used to be decorative \u2014 isFeatureEnabled fell through
        // to true for keys outside the legacy features map
        settings.watchlist = false;
        settings.watchlist_menuButton = true;
        watchlist.initialize();

        expect(observed).toHaveLength(0);
        expect(badges.provider).toBeNull();
        expect(trackButton(openMenu('Cheese'))).toBeNull();
    });

    test('is off by default, so the game\u2019s menu is left alone', () => {
        // It sits next to Sell, and a misclick there is a sale
        watchlist.initialize();
        expect(observed).toHaveLength(0);
        expect(trackButton(openMenu('Cheese'))).toBeNull();
    });

    test('turning the setting on attaches it without a reload', () => {
        watchlist.initialize();
        settings.watchlist_menuButton = true;
        for (const cb of listeners.watchlist_menuButton || []) cb(true);

        expect(trackButton(openMenu('Cheese'))).not.toBeNull();
    });

    test('it tracks and untracks, and says which it will do', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();

        const menu = openMenu('Cheese');
        const button = trackButton(menu);
        expect(button.textContent).toBe('Track');

        button.click();
        expect(isWatched('/items/cheese')).toBe(true);
        expect(button.textContent).toBe('Untrack');

        button.click();
        expect(isWatched('/items/cheese')).toBe(false);
        expect(button.textContent).toBe('Track');
    });

    test('an item already tracked opens saying Untrack', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();
        watchItem('/items/cheese');

        expect(trackButton(openMenu('Cheese')).textContent).toBe('Untrack');
    });

    test('it borrows the game\u2019s own button styling', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();

        expect(trackButton(openMenu('Cheese')).className).toContain('Button_button__ABC');
    });

    test('a menu it cannot identify gets no button rather than a broken one', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();

        expect(trackButton(openMenu('Not A Real Item'))).toBeNull();
    });

    test('turning the setting off takes the buttons away again', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();
        const menu = openMenu('Cheese');
        expect(trackButton(menu)).not.toBeNull();

        settings.watchlist_menuButton = false;
        for (const cb of listeners.watchlist_menuButton || []) cb(false);

        expect(trackButton(menu)).toBeNull();
        expect(observed).toHaveLength(0);
    });

    const headerSwitch = (setting) => watchlistPanel.panel.querySelector(`button[data-setting="${setting}"]`);

    test('the panel\u2019s switch is the same setting, not a copy of it', () => {
        // Two switches that disagree is worse than one switch in the wrong place
        watchlist.initialize();
        watchlistPanel.show();

        const button = headerSwitch('watchlist_menuButton');
        expect(button.textContent).toBe('Menu button off');

        button.click();

        expect(settings.watchlist_menuButton).toBe(true);
        expect(button.textContent).toBe('Menu button on');
        expect(trackButton(openMenu('Cheese'))).not.toBeNull();
    });

    test('the panel\u2019s switch shows what the settings page did', () => {
        settings.watchlist_menuButton = true;
        watchlist.initialize();
        watchlistPanel.show();

        expect(headerSwitch('watchlist_menuButton').textContent).toBe('Menu button on');
    });

    test('and it is in the top bar, where a switch about the whole panel belongs', () => {
        // It used to be a tick box under the table, which is a row nobody
        // scrolls to on a list of seventy items
        watchlist.initialize();
        watchlistPanel.show();

        expect(watchlistPanel.headerEl.contains(headerSwitch('watchlist_menuButton'))).toBe(true);
        expect(watchlistPanel.headerEl.contains(headerSwitch('watchlist_inventoryDots'))).toBe(true);
    });
});

describe('the dot on tracked items', () => {
    const tile = (name) => {
        const element = document.createElement('div');
        element.innerHTML = `<svg aria-label="${name}"></svg>`;
        document.body.appendChild(element);
        return element;
    };
    const dots = (element) => element.querySelectorAll('.toolasha-watchlist-dot');
    /** The badge manager hands the panel one tile at a time */
    const provider = (element) => badges.provider?.(element);

    beforeEach(() => {
        settings.watchlist_inventoryDots = true;
        watchItem('/items/cheese', 'Cheese');
    });

    test('is drawn on a tracked item', () => {
        watchlist.initialize();
        const element = tile('Cheese');
        provider(element);

        expect(dots(element)).toHaveLength(1);
    });

    test('and not on an untracked one', () => {
        watchlist.initialize();
        const element = tile('Bread');
        provider(element);

        expect(dots(element)).toHaveLength(0);
    });

    test('the setting turns it off', () => {
        settings.watchlist_inventoryDots = false;
        watchlist.initialize();
        const element = tile('Cheese');
        provider(element);

        expect(dots(element)).toHaveLength(0);
    });

    test('the panel’s dots switch turns them off', () => {
        watchlist.initialize();
        watchlistPanel.show();
        const element = tile('Cheese');
        provider(element);
        expect(dots(element)).toHaveLength(1);

        const button = watchlistPanel.panel.querySelector('button[data-setting="watchlist_inventoryDots"]');
        expect(button.textContent).toBe('Dots on');
        button.click();

        expect(settings.watchlist_inventoryDots).toBe(false);
        expect(button.textContent).toBe('Dots off');
        expect(dots(element)).toHaveLength(0);
    });

    test('a flip from the settings page moves the panel’s pill with it', () => {
        // The pill and the settings checkbox are two views of one setting, and
        // the panel only repainted on its five-second tick — long enough to
        // read as a pill that disagrees with the switch that just moved it
        watchlist.initialize();
        watchlistPanel.show();
        const button = watchlistPanel.panel.querySelector('button[data-setting="watchlist_inventoryDots"]');
        expect(button.textContent).toBe('Dots on');

        settings.watchlist_inventoryDots = false;
        for (const cb of listeners.watchlist_inventoryDots || []) cb(false);

        expect(button.textContent).toBe('Dots off');
    });

    test('and turning it off clears the ones already drawn', () => {
        // The provider is what walks the grid, so simply not drawing any more
        // would leave every existing dot sitting there until the game happened
        // to rebuild the tile
        watchlist.initialize();
        const element = tile('Cheese');
        provider(element);
        expect(dots(element)).toHaveLength(1);

        settings.watchlist_inventoryDots = false;
        for (const cb of listeners.watchlist_inventoryDots || []) cb(false);

        expect(dots(element)).toHaveLength(0);
    });
});

describe('one list per character', () => {
    /** Re-read the list as whoever is logged in now, the way a switch does */
    const switchCharacter = async (id, mode = 'standard') => {
        game.characterId = id;
        game.gameMode = mode;
        await game.dmHandlers.character_switched();
    };

    test('a list saved before the split is claimed by the market character', async () => {
        storageMock.storeFor('settings').set('watchlist', { entries: [{ hrid: '/items/cheese', name: 'Cheese' }] });

        await switchCharacter('market123');

        expect(isWatched('/items/cheese')).toBe(true);
        expect(storageMock.storeFor('settings').get('watchlist_market123').entries).toHaveLength(1);
        // Moved rather than copied, so it cannot be claimed twice
        expect(storageMock.storeFor('settings').has('watchlist')).toBe(false);
    });

    test('an iron cow starts empty and leaves the old list for its owner', async () => {
        storageMock.storeFor('settings').set('watchlist', { entries: [{ hrid: '/items/cheese', name: 'Cheese' }] });

        await switchCharacter('iron456', 'ironcow');

        expect(watchlistEntries()).toEqual([]);
        expect(storageMock.storeFor('settings').get('watchlist').entries).toHaveLength(1);
        expect(storageMock.storeFor('settings').has('watchlist_iron456')).toBe(false);
    });

    test('switching characters swaps the list rather than merging it', async () => {
        storageMock.storeFor('settings').set('watchlist_market123', {
            entries: [{ hrid: '/items/cheese', name: 'Cheese' }],
        });
        storageMock.storeFor('settings').set('watchlist_iron456', {
            entries: [{ hrid: '/items/rare_hat', name: 'Rare Hat' }],
        });

        await switchCharacter('market123');
        expect(watchlistEntries().map((entry) => entry.hrid)).toEqual(['/items/cheese']);

        await switchCharacter('iron456', 'ironcow');
        expect(watchlistEntries().map((entry) => entry.hrid)).toEqual(['/items/rare_hat']);
    });

    test('a character with nothing saved gets an empty list, not the last one', async () => {
        storageMock.storeFor('settings').set('watchlist_market123', {
            entries: [{ hrid: '/items/cheese', name: 'Cheese' }],
        });

        await switchCharacter('market123');
        await switchCharacter('iron456', 'ironcow');

        expect(watchlistEntries()).toEqual([]);
    });

    test('adding an item writes to the current character key only', async () => {
        await switchCharacter('iron456', 'ironcow');
        watchItem('/items/cheese', 'Cheese');
        await flushWatchlistWrites();

        expect(storageMock.storeFor('settings').get('watchlist_iron456').entries).toHaveLength(1);
        expect(storageMock.storeFor('settings').has('watchlist_market123')).toBe(false);
    });
});

describe('cleanup on a character switch', () => {
    test('empties state synchronously, before reload() has had a chance to run', () => {
        // The overlay panel re-initializes and starts redrawing on its 1s
        // timer as soon as character_switching fires — well before this
        // feature's own reload() (bound to character_initialized /
        // character_switched) finishes its async read of the new
        // character's list. Without a synchronous reset here, the watchlist
        // tile would show the outgoing character's entries and totals under
        // the incoming character's name for that gap.
        watchItem('/items/cheese', 'Cheese');
        expect(watchlistEntries().length).toBeGreaterThan(0);

        watchlist.cleanup();

        expect(watchlistEntries()).toEqual([]);
        expect(watchlistRows()).toEqual([]);
    });
});

describe('the stored list survives a read that cannot be made', () => {
    const KEY = 'watchlist_market123';
    const settingsStore = () => storageMock.storeFor('settings');
    const storedHrids = () => (settingsStore().get(KEY)?.entries || []).map((entry) => entry.hrid);
    const switchCharacter = async (id = 'market123') => {
        game.characterId = id;
        await game.dmHandlers.character_switched();
    };

    test('a load while storage is unreadable keeps the list in hand instead of blanking it', async () => {
        settingsStore().set(KEY, { entries: [{ hrid: '/items/cheese', name: 'Cheese' }] });
        await switchCharacter();
        watchItem('/items/rare_hat', 'Rare Hat');
        await flushWatchlistWrites();

        storageMock.unavailable = true;
        await switchCharacter();

        expect(watchlistEntries().map((entry) => entry.hrid)).toEqual(['/items/cheese', '/items/rare_hat']);
        expect(storedHrids()).toEqual(['/items/cheese', '/items/rare_hat']);
    });

    test('but another character’s list never stands in for this one’s, readable or not', async () => {
        settingsStore().set(KEY, { entries: [{ hrid: '/items/cheese', name: 'Cheese' }] });
        await switchCharacter();

        storageMock.unavailable = true;
        await switchCharacter('iron456');
        expect(watchlistEntries()).toEqual([]);

        storageMock.unavailable = false;
        watchItem('/items/rare_hat', 'Rare Hat');
        await flushWatchlistWrites();
        expect((settingsStore().get('watchlist_iron456')?.entries || []).map((e) => e.hrid)).toEqual([
            '/items/rare_hat',
        ]);
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        settingsStore().set(KEY, { entries: [{ hrid: '/items/cheese', name: 'Cheese' }] });
        await switchCharacter();

        storageMock.unavailable = true;
        watchItem('/items/rare_hat', 'Rare Hat');
        await flushWatchlistWrites();
        expect(storedHrids()).toEqual(['/items/cheese']);

        storageMock.unavailable = false;
        watchItem('/items/trainee_charm', 'Trainee Charm');
        await flushWatchlistWrites();
        expect(storedHrids()).toEqual(['/items/cheese', '/items/rare_hat', '/items/trainee_charm']);
    });

    test('before the list is read back a save loses nothing stored; after, a removal sticks', async () => {
        settingsStore().set(KEY, {
            entries: [
                { hrid: '/items/cheese', name: 'Cheese' },
                { hrid: '/items/rare_hat', name: 'Rare Hat' },
            ],
        });
        // The list was never read (an unreadable load), and the user adds an item
        storageMock.unavailable = true;
        await switchCharacter();
        storageMock.unavailable = false;
        watchItem('/items/trainee_charm', 'Trainee Charm');
        await flushWatchlistWrites();
        expect(storedHrids()).toEqual(['/items/cheese', '/items/rare_hat', '/items/trainee_charm']);

        // Read back, then a removal: it is not resurrected from storage
        await switchCharacter();
        unwatchItem('/items/cheese');
        await flushWatchlistWrites();
        expect(storedHrids()).toEqual(['/items/rare_hat', '/items/trainee_charm']);
        expect(isWatched('/items/cheese')).toBe(false);
    });
});

/**
 * The Watchlist tile's `version()`.
 *
 * The overlay redraws every visible tile once a second and skips a row whose
 * version has not moved. This row's four figures cost a price lookup, a held
 * count and a listing walk per watched item, and the list is often long — so the
 * memo matters, and so does its being exact: an item picked up or a price that
 * moved has to reach the tile.
 */
describe('the Watchlist tile summarises its own inputs', () => {
    const version = () =>
        registeredRows()
            .find((row) => row.key === 'watchlist')
            .version();

    test('nothing watched is one settled version', async () => {
        await clearWatchlist();
        expect(version()).toBe('blank');
        expect(version()).toBe(version());
    });

    test('it holds still while the list and the game do', async () => {
        await clearWatchlist();
        await watchItem('/items/cheese');
        expect(version()).toBe(version());
    });

    test('watching and unwatching move it', async () => {
        await clearWatchlist();
        const empty = version();

        await watchItem('/items/cheese');
        const watched = version();
        expect(watched).not.toBe(empty);

        await watchItem('/items/rare_hat');
        expect(version()).not.toBe(watched);

        await unwatchItem('/items/rare_hat');
        expect(version()).toBe(watched);
    });

    test('so does the game saying the inventory changed, with the list untouched', async () => {
        await clearWatchlist();
        await watchItem('/items/cheese');
        const before = version();

        // How many you hold is one of the four figures, and it moves without
        // anybody editing the list
        game.dmHandlers.items_updated({});
        expect(version()).not.toBe(before);
    });

    test('and the market listings changing, which are counted as held', async () => {
        await clearWatchlist();
        await watchItem('/items/cheese');
        const before = version();

        game.dmHandlers.market_listings_updated({});
        expect(version()).not.toBe(before);
    });
});
