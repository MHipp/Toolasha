/**
 * @vitest-environment happy-dom
 *
 * Equipment Savings, built rather than reasoned about.
 *
 * The arithmetic is tested in `utils/equipment-savings.test.js`. What only
 * building the panel catches is that it finds the piece a target would replace —
 * which needs the equipment map's **item location** key derived from the
 * target's **equipment type**, two different strings that look interchangeable.
 * Get it wrong and nothing throws: every upgrade silently costs full price.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    inventory: [],
    equipment: new Map(),
    details: {},
    prices: {},
    actions: {},
    shops: {},
    artisan: 0,
    // What `networthHistory.recentSeries` hands back — empty by default, so
    // tests that are not about the fallback see the same "nothing measured"
    // behaviour they did before it existed
    networthSeries: () => [],
    // What the tile's `version()` subscribes to, so a test can fire a price
    // update or a game event the way the real feeds would
    priceListeners: [],
    gameListeners: {},
    // Everything the module has written back, so a test about a setting
    // surviving a reload can look at what would actually be reloaded rather
    // than at the module's own memory of it
    writes: [],
    // What is already in storage for this character, for a test about what a
    // record written by an older build turns into when it is read back. Null —
    // nothing stored — for every other test, which is what they assume.
    stored: null,
    // The character's abilities, which is where an ability goal's progress
    // comes from
    abilities: [],
    abilityDetails: {},
    // Books are priced through marketAPI rather than through the item price
    // helper, as the sim's own ability costing is
    bookPrices: {},
    levelXp: [],
    // The character's house rooms, which is where a room goal's progress comes
    // from, and the game's own build costs, which is where its price does
    houseRooms: new Map(),
    houseDetails: {},
    // Every marketplace the panel's links opened, so a test can prove a row
    // about a +12 opens the +12 order book rather than the base item's
    navigations: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getEquipment: () => game.equipment,
        getItemDetails: (hrid) => game.details[hrid],
        getLearnedAbilities: () => game.abilities,
        getHouseRooms: () => game.houseRooms,
        // The picker builds its list from the whole item map, which is the same
        // fixture the per-item lookups read
        getInitClientData: () => ({
            itemDetailMap: game.details,
            actionDetailMap: game.actions,
            abilityDetailMap: game.abilityDetails,
            houseRoomDetailMap: game.houseDetails,
            levelExperienceTable: game.levelXp,
            ...game.shops,
        }),
        // Gear targets are one character's, so the module keys on the character
        // and listens for the switch
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, handler) => {
            (game.gameListeners[event] ||= []).push(handler);
        },
        off: () => {},
    },
}));
// A real registry, not a stub, so a test can prove cleanup() actually
// unregisters what initialize() registered rather than only that neither call
// throws
const settingChangeCallbacks = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: () => false,
        onSettingChange: (key, callback) => {
            (settingChangeCallbacks[key] ||= []).push(callback);
        },
        offSettingChange: (key, callback) => {
            if (!settingChangeCallbacks[key]) return;
            settingChangeCallbacks[key] = settingChangeCallbacks[key].filter((cb) => cb !== callback);
        },
        getSettingValue: () => 'full',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        db: {},
        ready: Promise.resolve(true),
        getJSON: async () => null,
        setJSON: async () => {},
        get: async (_k, _s, fallback = null) => fallback,
        tryGet: async () =>
            game.stored ? { found: true, value: structuredClone(game.stored) } : { found: false, value: null },
        set: async (key, value) => {
            game.writes.push({ key, value });
            return true;
        },
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    // Called from a deferred callback, so only a test that waits past it sees
    // the panel complain that the mock is missing it
    clampPanelToViewport: () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid, enhancementLevel = 0) => game.navigations.push({ itemHrid, enhancementLevel }),
}));
vi.mock('../../utils/game-lookups.js', () => ({ getItemHridFromName: () => null }));
// Kept rather than discarded, so the tile's own `version()` — which is what
// spares the overlay this module's whole render sixty times a minute — can be
// tested against the same fixtures the arithmetic is
const rowsByKey = vi.hoisted(() => new Map());
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => rowsByKey.set(definition.key, definition),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getDataAge: () => 60_000,
        fetch: async () => {},
        // The book price, which is what an ability level is actually bought with
        getPrice: (hrid) => game.bookPrices[hrid] || null,
        // The tile's `version()` treats a new price feed as a new tile
        on: (handler) => game.priceListeners.push(handler),
    },
}));
vi.mock('../networth/networth-history.js', () => ({
    default: { recentSeries: (hours) => game.networthSeries(hours) },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
    // The shared pricing rules fall back to a production cost when a book has
    // neither side, and that walk prices the recipe's inputs through here
    getItemPrice: (hrid, { mode = 'ask' } = {}) => game.prices[`${hrid}:0`]?.[mode] || 0,
}));
// The real one resolves a loadout and parses teas; what this file cares about
// is that the saving reaches the recipe, whatever produced it
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => game.artisan }));

// The card resolves its bench through the shared resolver now, rather than reaching for
// `getAutoDetectedParams` itself. This suite is about the card's arithmetic and its rendering,
// not about which bench gets picked — that lives in enhancement-params-parity.test.js — so the
// resolver is routed back to the bench this file already injects through window.Toolasha, and
// still answers undefined when nothing is loaded, the way the bundle bridge did.
vi.mock('../enhancement/enhancement-params-source.js', async (importOriginal) => ({
    ...(await importOriginal()),
    enhancementParamsFor: () => window.Toolasha?.Utils?.enhancementConfig?.getAutoDetectedParams?.(),
}));

const {
    equipmentSavingsPanel,
    watchTarget,
    unwatchTarget,
    isTargeted,
    watchedTargets,
    everything,
    coinsHeld,
    setNoSell,
    selectTarget,
    incomePerDay,
    incomeEstimate,
    trendPerDay,
    toggleCrafting,
    cycleTargetNoSell,
    toggleLaddering,
    isLaddering,
    enhancementCost,
    upgradeBaseCost,
    upgradeBaseRoute,
    resetEquipmentSavings,
    setLocked,
    watchAbility,
    unwatchAbility,
    watchedAbilityGoals,
    abilityBookCost,
    abilityChoices,
    watchHouse,
    unwatchHouse,
    watchedHouseGoals,
    houseUpgradeCost,
    houseChoices,
    houseRoomLevels,
    default: equipmentSavings,
} = await import('./equipment-savings-row.js');
const { flushSavingsWrites } = await import('../../utils/equipment-savings.js');

beforeEach(() => {
    game.inventory = [
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', count: 60_000_000 },
        // Coins turn up under more than one location; only the inventory one is
        // money you can spend
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/market_listing', count: 51_000_000_000_000 },
    ];
    game.actions = {
        // An upgrade: shards plus the spear you already hold
        '/actions/refine': {
            outputItems: [{ itemHrid: '/items/refined_spear', count: 1 }],
            inputItems: [{ itemHrid: '/items/shard', count: 30 }],
            upgradeItemHrid: '/items/plain_spear',
        },
    };
    game.details = {
        '/items/refined_spear': { name: 'Refined Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/plain_spear': { name: 'Plain Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/shard': { name: 'Shard' },
        '/items/cheese_sword': { name: 'Cheese Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/holy_sword': { name: 'Holy Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/rough_boots': { name: 'Rough Boots', equipmentDetail: { type: '/equipment_types/feet' } },
        '/items/cheese': { name: 'Cheese' },
    };
    // Keyed by item LOCATION, which is not the same string as the equipment type
    game.equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_sword', enhancementLevel: 0 }]]);
    game.prices = {
        '/items/holy_sword:0': { ask: 100_000_000, bid: 90_000_000 },
        '/items/cheese_sword:0': { ask: 45_000_000, bid: 40_000_000 },
        '/items/rough_boots:0': { ask: 5_000_000, bid: 4_000_000 },
        '/items/refined_spear:0': { ask: 900_000_000, bid: 800_000_000 },
        '/items/plain_spear:0': { ask: 300_000_000, bid: 250_000_000 },
        '/items/shard:0': { ask: 1_000_000, bid: 900_000 },
    };
    game.shops = {};
    game.artisan = 0;
    game.networthSeries = () => [];
    game.writes = [];
    game.stored = null;
    // One learned ability at Lv40 with the experience of exactly that level, and
    // an experience table where every level is a round million
    game.abilities = [{ abilityHrid: '/abilities/fierce_aura', level: 40, experience: 40_000_000 }];
    game.abilityDetails = {
        '/abilities/fierce_aura': { name: 'Fierce Aura' },
        '/abilities/toxic_pollen': { name: 'Toxic Pollen' },
    };
    game.levelXp = Array.from({ length: 101 }, (_, level) => level * 1_000_000);
    game.bookPrices = { '/items/fierce_aura': { ask: 12_000, bid: 8_000 } };
    // A room part-built, one at the cap the game stops at, and one never started
    game.houseRooms = new Map([
        ['/house_rooms/mystical_study', { houseRoomHrid: '/house_rooms/mystical_study', level: 3 }],
        ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 8 }],
    ]);
    game.houseDetails = {
        // Lv4 is 10M of coins and 10 lumber, Lv5 is 20M and 40 lumber, so
        // 3 → 5 is 80M with lumber asking a million
        '/house_rooms/mystical_study': {
            name: 'Mystical Study',
            upgradeCostsMap: {
                4: [
                    { itemHrid: '/items/coin', count: 10_000_000 },
                    { itemHrid: '/items/lumber', count: 10 },
                ],
                5: [
                    { itemHrid: '/items/coin', count: 20_000_000 },
                    { itemHrid: '/items/lumber', count: 40 },
                ],
            },
        },
        '/house_rooms/dojo': { name: 'Dojo', upgradeCostsMap: { 4: [{ itemHrid: '/items/coin', count: 1 }] } },
        '/house_rooms/gym': {
            name: 'Gym',
            upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 1_000_000 }] },
        },
    };
    game.prices['/items/lumber:0'] = { ask: 1_000_000, bid: 900_000 };
    game.navigations = [];
    resetEquipmentSavings();
});

afterEach(() => {
    equipmentSavingsPanel.hide();
    resetEquipmentSavings();
});

const text = () => equipmentSavingsPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('costing a target', () => {
    test('the piece it replaces is found through the slot, not the name', () => {
        // 100M to buy, less 40M for the sword being worn
        watchTarget('/items/holy_sword');
        const [target] = watchedTargets();

        expect(target.worn?.itemHrid).toBe('/items/cheese_sword');
        expect(target.cost).toBe(60_000_000);
    });

    test('an empty slot has nothing to trade in', () => {
        watchTarget('/items/rough_boots');
        expect(watchedTargets()[0].cost).toBe(5_000_000);
    });

    test('no-sell pays the full ask', () => {
        watchTarget('/items/holy_sword');
        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });

    test('an unpriced target is unknown rather than affordable', () => {
        // Zero cost would report it as already bought, which is the most
        // misleading thing this could say
        game.prices = {};
        watchTarget('/items/holy_sword');

        const [target] = watchedTargets();
        expect(target.cost).toBeNull();
        expect(target.affordable).toBe(false);
    });
});

describe('cleanup on a character switch', () => {
    test('empties targets and goals synchronously, before reload() has had a chance to run', async () => {
        // The overlay panel re-initializes and starts redrawing on its 1s
        // timer as soon as character_switching fires — well before this
        // feature's own reload() (bound to character_initialized /
        // character_switched) finishes its async read of the new
        // character's savings record. Without a synchronous reset here, the
        // equipmentWatch tile would show the outgoing character's gear
        // target (or ability/house goal) under the incoming character's
        // name for that gap.
        watchTarget('/items/holy_sword');
        await watchAbility('/abilities/fierce_aura', 46);
        await watchHouse('/house_rooms/mystical_study', 5);
        expect(watchedTargets().length).toBeGreaterThan(0);
        expect(watchedAbilityGoals().length).toBeGreaterThan(0);
        expect(watchedHouseGoals().length).toBeGreaterThan(0);

        equipmentSavings.cleanup();

        expect(watchedTargets()).toEqual([]);
        expect(watchedAbilityGoals()).toEqual([]);
        expect(watchedHouseGoals()).toEqual([]);
        const plan = everything();
        expect(plan.targets).toEqual([]);
        expect(plan.abilities).toEqual([]);
        expect(plan.houses).toEqual([]);
    });

    test('does not re-register the menu button setting listener on every switch', () => {
        // initialize()/cleanup() run in a pair on every character switch (see
        // core/feature-registry.js). `config.onSettingChange` has no dedupe of
        // its own, so a cleanup() that forgot to unregister what initialize()
        // just added would leave one more copy of the same callback in the
        // registry after every switch — each one firing (and re-running
        // applyMenuButtonSetting's DOM work) on every future toggle of the
        // setting, forever.
        const key = 'equipmentSavings_menuButton';
        const before = (settingChangeCallbacks[key] || []).length;

        equipmentSavings.initialize();
        equipmentSavings.cleanup();
        equipmentSavings.initialize();
        equipmentSavings.cleanup();
        equipmentSavings.initialize();
        equipmentSavings.cleanup();

        expect((settingChangeCallbacks[key] || []).length).toBe(before);
    });
});

describe('the whole list', () => {
    test('everything is the sum, against your coins', () => {
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const plan = everything();
        expect(plan.cost).toBe(65_000_000);
        expect(plan.affordable).toBe(false);
        expect(plan.needed).toBe(5_000_000);
    });

    test('coins come off the character rather than out of net worth', () => {
        expect(coinsHeld()).toBe(60_000_000);
    });

    test('only coins in the inventory count, not every coin row the game has', () => {
        // An unfiltered read picked up a listing's row and reported fifty-one
        // trillion, which made everything affordable
        expect(coinsHeld()).not.toBe(51_000_000_000_000);
    });

    test('no income measured means no arrival time rather than never', () => {
        // Genuinely short: with nothing left to save the answer is zero seconds
        // whatever the income, which is not the case being tested
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        expect(everything().needed).toBeGreaterThan(0);
        expect(everything().seconds).toBeNull();
    });
});

describe('the panel renders', () => {
    test('an empty list is the slots inviting one', () => {
        // The invitation is the slot itself, so there is nothing to explain
        equipmentSavingsPanel.show();

        expect(text()).toContain('Click to watch');
        expect(text()).not.toContain(FAILED);
    });

    test('locked with nothing watched says where to go', () => {
        // The slots are hidden there, so the invitation has to be words
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();

        expect(text()).toContain('Nothing being saved for');
        expect(text()).not.toContain(FAILED);
    });

    test('a target draws with its cost and the Everything row', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Holy Sword');
        expect(text()).toContain('Everything');
        expect(text()).not.toContain(FAILED);
    });

    test('an affordable target says so rather than showing a shortfall', () => {
        watchTarget('/items/rough_boots');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Affordable');
    });

    test('the No Sell switch re-costs the list', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-toggle="No Sell"]').click();

        expect(watchedTargets()[0].cost).toBe(100_000_000);
        expect(text()).not.toContain(FAILED);
    });

    test('the eye moves which target the header carries', () => {
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-watch-eye="/items/rough_boots"]').click();
        // The headline is the first thing in the body, so the watched one leads
        expect(equipmentSavingsPanel.panel.textContent.indexOf('Rough Boots')).toBeLessThan(
            equipmentSavingsPanel.panel.textContent.indexOf('Holy Sword')
        );
    });

    test('market orders count towards what you can spend, until they do not', () => {
        watchTarget('/items/holy_sword');
        const withOrders = everything().needed;

        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-toggle="Market Value"]').click();

        // No orders in the fixture, so the figure holds either way — what is
        // being pinned is that the switch does not throw and does re-cost
        expect(everything().needed).toBe(withOrders);
        expect(text()).not.toContain(FAILED);
    });

    test('removing a target takes it off the list', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-remove-target]').click();
        expect(watchedTargets()).toEqual([]);
    });

    test('it draws before the market has answered', () => {
        game.prices = {};
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
    });
});

/** The panel opens unlocked, so a slot interaction only needs it open */
const unlock = () => equipmentSavingsPanel.show();

/** Unlock, open the picker under a slot, and hand back its list */
const openPicker = (slot = 'main_hand') => {
    unlock();
    equipmentSavingsPanel.panel.querySelector(`[data-watch-slot="${slot}"]`).click();
    return equipmentSavingsPanel.panel.querySelector('[data-pick-item]');
};

describe('lock and edit', () => {
    test('the slots are what it opens on', () => {
        // EWatch's own resting state. Hiding them behind a button hides the only
        // way to add anything, which is the panel's whole point.
        equipmentSavingsPanel.show();
        expect(text()).toContain('Main Hand:');
    });

    test('locked lists only what is being saved for', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();

        expect(text()).toContain('Holy Sword');
        expect(text()).not.toContain('Main Hand:');
        expect(text()).toContain('Everything');
    });

    test('the button names what pressing it does', () => {
        equipmentSavingsPanel.show();
        const button = () => equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]');

        expect(button().textContent).toBe('Lock');
        button().click();
        expect(button().textContent).toBe('Edit');
    });

    test('locking closes any picker that was open', () => {
        openPicker('feet');
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeTruthy();

        equipmentSavingsPanel.panel.querySelector('[data-lock-toggle]').click();
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });
});

describe('the slot layout', () => {
    test('every slot gets a section, watched or not', () => {
        // A slot with nothing on it still says what is in it and invites a
        // target, which a list of only your targets cannot do
        unlock();

        expect(text()).toContain('Main Hand:');
        expect(text()).toContain('Charm:');
        expect(text()).toContain('Cheese Sword');
    });

    test('an empty slot reads as empty rather than as missing', () => {
        unlock();
        expect(text()).toContain('Empty');
    });

    test('a watched target sits under the slot it would fill', () => {
        watchTarget('/items/holy_sword');
        unlock();

        expect(equipmentSavingsPanel.panel.querySelector('[data-slot="main_hand"]').textContent).toContain(
            'Holy Sword'
        );
        expect(equipmentSavingsPanel.panel.querySelector('[data-slot="feet"]').textContent).not.toContain('Holy Sword');
    });

    test('a watched target shows its ask and what the swap actually costs', () => {
        watchTarget('/items/holy_sword');
        unlock();

        expect(text()).toContain('Ask Price:');
        expect(text()).toContain('Difference:');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the item picker', () => {
    test('it opens under the slot that asked for it', () => {
        // Not at the top of the panel: the question is "what goes in this slot",
        // and a picker somewhere else makes you carry the slot in your head
        openPicker('feet');

        const feet = equipmentSavingsPanel.panel.querySelector('[data-slot="feet"]');
        expect(feet.querySelector('[data-pick-item]')).toBeTruthy();
        expect(
            equipmentSavingsPanel.panel.querySelector('[data-slot="main_hand"]').querySelector('[data-pick-item]')
        ).toBeNull();
    });

    test('it offers only the pieces that fill that slot', () => {
        openPicker('feet');

        const values = [...equipmentSavingsPanel.panel.querySelectorAll('[data-pick-item] option')].map(
            (option) => option.value
        );
        expect(values).toContain('/items/rough_boots');
        expect(values).not.toContain('/items/holy_sword');
    });

    test('it is a list box rather than a dropdown', () => {
        // A dropdown over three hundred items is a scroll you cannot see the
        // shape of, and it closes every time anything redraws
        expect(openPicker().size).toBe(10);
    });

    test('clicking the same slot again closes it', () => {
        openPicker('feet');
        equipmentSavingsPanel.panel.querySelector('[data-watch-slot="feet"]').click();

        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });

    test('picking a piece offers its enhancement levels and prices the choice', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));

        expect(equipmentSavingsPanel.panel.querySelectorAll('[data-pick-level]')).toHaveLength(21);
        expect(text()).toContain('Lowest Ask:');
        expect(text()).not.toContain(FAILED);
    });

    test('watching it adds it at the enhancement that was chosen', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));

        equipmentSavingsPanel.panel.querySelector('[data-pick-level="5"]').click();
        equipmentSavingsPanel.panel.querySelector('[data-pick-add]').click();

        const [target] = watchedTargets();
        expect(target.itemHrid).toBe('/items/holy_sword');
        expect(target.enhancementLevel).toBe(5);
    });

    test('the picker closes once it has been used', () => {
        const list = openPicker();
        list.value = '/items/holy_sword';
        list.dispatchEvent(new Event('change'));
        equipmentSavingsPanel.panel.querySelector('[data-pick-add]').click();

        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-item]')).toBeNull();
    });

    test('nothing picked means nothing to watch', () => {
        expect(openPicker().value).toBe('');
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-add]').disabled).toBe(true);
    });
});

describe('the pin', () => {
    test('the tile follows the eye rather than always the cheapest', () => {
        // The thing somebody is saving for is often not the cheapest, and a tile
        // that always shows the cheapest cannot be told otherwise
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const container = document.createElement('div');
        selectTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(everything().targets).toHaveLength(2);
        expect(container).toBeTruthy();
        expect(equipmentSavingsPanel.panel.textContent.indexOf('Holy Sword')).toBeLessThan(
            equipmentSavingsPanel.panel.textContent.indexOf('Rough Boots')
        );
    });

    test('pressing the eye again unpins it', () => {
        watchTarget('/items/holy_sword');
        selectTarget('/items/holy_sword');
        selectTarget('/items/holy_sword');

        equipmentSavingsPanel.show();
        expect(text()).not.toContain(FAILED);
    });
});

describe('income per day', () => {
    /** A collector reading of the shape the real one publishes */
    const withCombat = (durationSeconds, dailyProfit) => {
        window.Toolasha = {
            Combat: {
                combatStatsDataCollector: {
                    getLatestData: () => ({ durationSeconds, players: [{ isCurrentPlayer: true, loot: {} }] }),
                },
                combatStatsCalculator: { calculatePlayerStats: () => ({ dailyProfit }) },
            },
        };
    };

    afterEach(() => {
        delete window.Toolasha;
    });

    test('it reads the duration field the collector actually publishes', () => {
        // Reaching for startTime/endTime, which the collector does not have,
        // made every run zero seconds long and every rate unmeasurable
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        expect(incomePerDay()).toBe(65_000_000);
    });

    test('daily profit is two figures, not one', () => {
        // Compared as a number it is NaN, so this returned null however long
        // the run had been
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        setNoSell(true);
        expect(incomePerDay()).toBe(90_000_000);
    });

    test('a run of no length is unmeasurable rather than zero', () => {
        withCombat(0, { ask: 90_000_000, bid: 65_000_000 });
        expect(incomePerDay()).toBeNull();
    });

    test('no combat at all is nothing rather than a crash', () => {
        expect(incomePerDay()).toBeNull();
    });
});

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000; // an arbitrary but fixed epoch, for readable offsets

/** Points every 6h across a 48h window, growing by `perHour` coins each hour */
function growthSeries(perHour, hours = 48, step = 6) {
    const points = [];
    for (let h = 0; h <= hours; h += step) points.push({ t: T0 + h * HOUR, total: 500_000_000 + h * perHour });
    return points;
}

describe('the net worth trend', () => {
    test('steady growth gives the per-day rate it was growing at', () => {
        // 2,000,000/hour is 48,000,000/day
        expect(trendPerDay(growthSeries(2_000_000))).toBeCloseTo(48_000_000, 0);
    });

    test('a span under the minimum is unmeasurable rather than a guess from two dots', () => {
        // Four points, but only 3h apart — a real window, just too short
        const points = [0, 1, 2, 3].map((h) => ({ t: T0 + h * HOUR, total: 500_000_000 + h * 2_000_000 }));
        expect(trendPerDay(points)).toBeNull();
    });

    test('fewer than three points is unmeasurable however wide the span', () => {
        expect(trendPerDay([growthSeries(2_000_000)[0], growthSeries(2_000_000).at(-1)])).toBeNull();
    });

    test('a flat net worth reads as roughly nothing, not null', () => {
        expect(trendPerDay(growthSeries(0))).toBeCloseTo(0, 6);
    });

    test('a sell-off dip inside the window still comes out finite and close to the trend', () => {
        const points = growthSeries(2_000_000);
        // A one-off drop in the middle of otherwise steady growth
        points[4] = { ...points[4], total: points[4].total - 500_000_000 };

        const result = trendPerDay(points);
        expect(Number.isFinite(result)).toBe(true);
        // Sane: still a positive rate, and not wildly off the 48,000,000/day
        // the series grows at everywhere but the one dip
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(150_000_000);
    });

    test('no points at all is unmeasurable', () => {
        expect(trendPerDay([])).toBeNull();
    });
});

describe('income source selection', () => {
    /** A collector reading of the shape the real one publishes */
    const withCombat = (durationSeconds, dailyProfit) => {
        window.Toolasha = {
            Combat: {
                combatStatsDataCollector: {
                    getLatestData: () => ({ durationSeconds, players: [{ isCurrentPlayer: true, loot: {} }] }),
                },
                combatStatsCalculator: { calculatePlayerStats: () => ({ dailyProfit }) },
            },
        };
    };

    afterEach(() => {
        delete window.Toolasha;
    });

    test('combat is read first when it has something to say', () => {
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        // A trend that would give a very different number, to prove combat wins
        game.networthSeries = () => growthSeries(2_000_000);

        expect(incomeEstimate()).toEqual({ perDay: 65_000_000, source: 'combat' });
    });

    test('the net worth trend stands in once combat has nothing to say', () => {
        game.networthSeries = () => growthSeries(2_000_000);

        const result = incomeEstimate();
        expect(result.source).toBe('networth');
        expect(result.perDay).toBeCloseTo(48_000_000, 0);
    });

    test('nothing measured from either source is null, not a confident zero', () => {
        expect(incomeEstimate()).toEqual({ perDay: null, source: null });
    });

    test('the panel names the trend as its source', () => {
        game.networthSeries = () => growthSeries(2_000_000);
        equipmentSavingsPanel.show();

        expect(text()).toContain(`networth trend, 48h`);
        expect(text()).not.toContain(FAILED);
    });

    test('the panel names combat as its source', () => {
        withCombat(3600, { ask: 90_000_000, bid: 65_000_000 });
        equipmentSavingsPanel.show();

        expect(text()).toContain('combat session');
        expect(text()).not.toContain(FAILED);
    });
});

describe('crafting rather than buying', () => {
    test('a craft is priced at its materials, not the finished piece', () => {
        // A spear you already hold becomes a refined one for the price of the
        // shards — 30M against a 900M ask, which is a different decision
        game.inventory.push({
            itemHrid: '/items/plain_spear',
            itemLocationHrid: '/item_locations/inventory',
            count: 1,
        });
        watchTarget('/items/refined_spear');
        expect(watchedTargets()[0].cost).toBe(900_000_000 - 40_000_000);

        toggleCrafting('/items/refined_spear');
        // 30 shards at 1M, less the 40M for the sword being replaced
        expect(watchedTargets()[0].cost).toBe(30_000_000 - 40_000_000 > 0 ? 30_000_000 - 40_000_000 : 0);
    });

    test('a base piece you do not own is counted into the craft', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        // 30M of shards plus the 300M spear, less the 40M trade-in
        expect(watchedTargets()[0].cost).toBe(330_000_000 - 40_000_000);
    });

    test('the tea takes its cut off the materials', () => {
        // The game's own panel says 88.9 shards where the recipe says 100.
        // Pricing the printed 100 is an eleven per cent overcharge on every
        // craft this card quotes.
        game.artisan = 0.111;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        // 30 shards less 11.1%, at 1M each, plus the 300M spear, less the 40M
        // trade-in
        const shards = 30 * (1 - 0.111) * 1_000_000;
        expect(watchedTargets()[0].cost).toBeCloseTo(shards + 300_000_000 - 40_000_000, 0);
    });

    test('the saving is shown, not just applied', () => {
        // A count that quietly disagrees with the game's panel reads as a bug
        game.artisan = 0.111;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('26.7 × Shard');
        expect(text()).toContain('Artisan tea');
        expect(text()).not.toContain(FAILED);
    });

    test('a craft offers to open the marketplace on what it is short of', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Missing Mats Marketplace');
    });

    test('an unpriced ingredient leaves the craft unpriced rather than cheap', () => {
        game.prices['/items/shard:0'] = null;
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');

        expect(watchedTargets()[0].cost).toBeNull();
    });

    test('a piece with no recipe offers no craft switch', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        expect(equipmentSavingsPanel.panel.querySelector('[data-target-craft="/items/holy_sword"]')).toBeNull();
    });

    test('the recipe is itemised, since one ingredient is usually the expensive one', () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        expect(text()).toContain('Shard');
        expect(text()).toContain('Plain Spear');
        expect(text()).not.toContain(FAILED);
    });
});

describe('selling per target', () => {
    test('a target follows the panel until it is told otherwise', () => {
        watchTarget('/items/holy_sword');
        expect(watchedTargets()[0].cost).toBe(60_000_000);

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });

    test('and then keeps its own answer whatever the panel says', () => {
        // The sword being replaced gets sold; the second ring replaces nothing
        watchTarget('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword'); // always sells

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(60_000_000);
    });

    test('cycling three times hands it back to the panel', () => {
        watchTarget('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');
        cycleTargetNoSell('/items/holy_sword');

        setNoSell(true);
        expect(watchedTargets()[0].cost).toBe(100_000_000);
    });
});

describe('the order of the list', () => {
    test('nearest to done leads, and affordable leads that', () => {
        // The sword needs 300M of the 60M held; the spear needs more again.
        // Boots are affordable outright, so they come first.
        game.prices['/items/holy_sword:0'] = { ask: 340_000_000, bid: 300_000_000 };
        watchTarget('/items/holy_sword');
        watchTarget('/items/refined_spear');
        watchTarget('/items/rough_boots');

        expect(watchedTargets().map((target) => target.name)).toEqual(['Rough Boots', 'Holy Sword', 'Refined Spear']);
    });

    test('unpriced targets go last, since they have no progress to sort by', () => {
        game.prices['/items/holy_sword:0'] = null;
        watchTarget('/items/holy_sword');
        watchTarget('/items/rough_boots');

        const names = watchedTargets().map((target) => target.name);
        expect(names[names.length - 1]).toBe('Holy Sword');
    });
});

describe('targets nobody is selling at that level', () => {
    beforeEach(() => {
        // Deliberately tradable, with an ask at +0 and nothing above — which is
        // what a cape actually looks like, and what gating this on
        // `isTradable` got wrong: the item is perfectly tradable and the
        // target still has no price
        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/sinister_cape:0'] = { ask: 50_000_000, bid: 45_000_000 };
        // One already on your back. The inventory covers worn pieces, which is
        // how the run knows what level to start from.
        game.inventory.push({
            itemHrid: '/items/sinister_cape',
            itemLocationHrid: '/item_locations/back',
            count: 1,
            enhancementLevel: 5,
        });
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    // Protecting costs protections and saves attempts, which is
                    // the whole reason there is a strategy to pick
                    calculateEnhancement: ({ protectFrom }) =>
                        protectFrom > 0 ? { attempts: 40, protectionCount: 5 } : { attempts: 200, protectionCount: 0 },
                },
                enhancementConfig: {
                    // The character's own bench, which is what the `savings` surface resolves
                    // to unless pro rates are on. The simulator's manual settings default to a
                    // fully kitted enhancer nobody here owns.
                    getAutoDetectedParams: () => ({
                        enhancingLevel: 100,
                        toolBonus: 10,
                        teas: { blessed: false },
                        guzzlingBonus: 1,
                    }),
                },
            },
        };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 2_000_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_800_000 };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    test('a cape is priced at the run, not at an ask that does not exist', () => {
        // Protected: 40 attempts × 2 shards at 1M, plus 5 protections at 2M —
        // cheaper than the 400M the unprotected run costs, so that is the one
        // to quote
        watchTarget('/items/sinister_cape', 7);
        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('it counts from the level already on your back', () => {
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].enhancing).toBe(true);
        expect(watchedTargets()[0].fromLevel).toBe(5);
    });

    test('the piece being enhanced is not also traded in', () => {
        // It is the same cape. Subtracting what it would fetch would have you
        // sell the thing you are about to enhance.
        watchTarget('/items/sinister_cape', 7);
        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('with none owned, it buys a base and enhances that', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].fromLevel).toBe(0);
        expect(watchedTargets()[0].cost).toBe(50_000_000 + 40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('a base nobody lists is still priced through the shop that sells it', () => {
        // Capes are drops and shop lines; they are never listed. Reading the
        // market alone says a cape cannot be bought at any price.
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.prices['/items/sinister_cape:0'] = null;
        game.shops.shopItemDetailMap = {
            cape: { itemHrid: '/items/sinister_cape', costs: [{ itemHrid: '/items/token', count: 10 }] },
            // What the token is worth: the best coins any line in this shop
            // converts one into
            sword: { itemHrid: '/items/holy_sword', costs: [{ itemHrid: '/items/token', count: 20 }] },
        };
        watchTarget('/items/sinister_cape', 7);

        // 100M for the sword over 20 tokens is 5M a token, so a 10-token cape
        // is 50M
        expect(watchedTargets()[0].cost).toBe(50_000_000 + 40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('with none owned and nowhere selling one there is nothing to model', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.prices['/items/sinister_cape:0'] = null;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBeNull();
    });

    test('with nothing to protect with, it quotes the run that has no protection', () => {
        // Offering a protected run at a protection nobody sells would price a
        // run that cannot be made
        game.prices['/items/mirror_of_protection:0'] = null;
        delete game.details['/items/mirror_of_protection'];
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBe(200 * 2 * 1_000_000);
    });

    test('the card says it is an anvil run rather than a purchase', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(text()).toContain('Not sold at this level');
        expect(text()).toContain('Enhancement Cost');
        expect(text()).toContain('Enhance +5');
        expect(text()).not.toContain(FAILED);
    });

    test('the card names whose bench the run was costed at', () => {
        // Four places sweep an enhancement path with four different parameter
        // sources, and until now only the tooltip admitted which it used. Same
        // word the tooltip's chip prints, so "Yours" means one thing everywhere
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(text()).toContain('Enhancement Cost (Yours)');
    });

    test('a card showing an advisor’s quote does not claim the quote came off this bench', () => {
        // That figure was costed somewhere else; the advisor's own breakdown is
        // where it names its bench
        watchTarget('/items/sinister_cape', 7, { cost: 12_345_678, costSource: 'sim' });
        equipmentSavingsPanel.show();

        expect(text()).toContain('Enhancement Cost');
        expect(text()).not.toContain('Enhancement Cost (');
        // The derived figure beside it is this module's own, and says so
        expect(text()).toContain('Priced here at (Yours):');
    });

    test('it costs the run at your own bench, not the simulator settings', () => {
        // The simulator's manual defaults are a fully kitted enhancer. Costing
        // a cape at somebody else's bench quotes a run you cannot make.
        window.Toolasha.Utils.enhancementConfig.getEnhancingParams = () => {
            throw new Error('the simulator settings are not this character');
        };
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBe(40 * 2 * 1_000_000 + 5 * 2_000_000);
    });

    test('without the calculator it is unpriced rather than wrong', () => {
        delete window.Toolasha;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].cost).toBeNull();
    });
});

describe('the ladder', () => {
    // A run whose cost follows how far it has to climb, so a ladder starting
    // lower reads as dearer — the flat mock above cannot tell the two apart
    const cape = (level, count = 1) => ({
        itemHrid: '/items/sinister_cape',
        itemLocationHrid: '/item_locations/inventory',
        count,
        enhancementLevel: level,
    });

    beforeEach(() => {
        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/sinister_cape:0'] = { ask: 50_000_000, bid: 45_000_000 };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 2_000_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_800_000 };

        // The one on your back, and a spare in the bag
        game.inventory.push({ ...cape(5), itemLocationHrid: '/item_locations/back' }, cape(2));
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    calculateEnhancement: ({ targetLevel, startLevel, protectFrom }) =>
                        protectFrom > 0
                            ? { attempts: 10 * (targetLevel - startLevel), protectionCount: targetLevel - startLevel }
                            : { attempts: 100 * (targetLevel - startLevel), protectionCount: 0 },
                },
                enhancementConfig: {
                    getAutoDetectedParams: () => ({ enhancingLevel: 100, teas: {}, guzzlingBonus: 1 }),
                },
            },
        };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    test('it counts from the second-best copy, not from the one you are wearing', () => {
        watchTarget('/items/sinister_cape', 7);
        const target = watchedTargets()[0];

        // Direct: two levels to climb — 20 attempts × 2 shards at 1M, plus two
        // mirrors at 2M
        expect(target.cost).toBe(44_000_000);
        // Ladder: five levels from the +2 spare, and the +5 stays on your back
        expect(target.ladder).toMatchObject({ spare: true, fromLevel: 2, cost: 110_000_000 });
    });

    test('the card says which copy it would climb', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(text()).toContain('Ladder: enhance your +2 copy instead');
        expect(text()).not.toContain(FAILED);
    });

    test('a stack of two is two copies, so the spare is at the same level', () => {
        game.inventory = game.inventory.filter((item) => item.itemHrid !== '/items/sinister_cape');
        game.equipment.delete('/item_locations/back');
        game.inventory.push(cape(3, 2));
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toMatchObject({ spare: true, fromLevel: 3 });
    });

    test('with only the one copy it prices a fresh base and says so', () => {
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        // 50M for a +0 off the market, then seven levels of run
        expect(watchedTargets()[0].ladder).toMatchObject({
            spare: false,
            fromLevel: 0,
            base: 50_000_000,
            cost: 50_000_000 + 154_000_000,
        });
        expect(text()).toContain('Ladder: enhance a fresh +0 you buy instead');
    });

    test('with no spare and nowhere to get one there is no ladder to offer', () => {
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        game.prices['/items/sinister_cape:0'] = null;
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toBeNull();
        expect(equipmentSavingsPanel.panel).toBeFalsy();
    });

    test('the copy it climbs is the second best, wherever the best one is', () => {
        // A +6 in the bag is now the best copy, so the direct cost counts from
        // there and the ladder falls to the +5 on your back
        game.inventory.push(cape(6));
        watchTarget('/items/sinister_cape', 7);
        const target = watchedTargets()[0];

        expect(target.fromLevel).toBe(6);
        expect(target.ladder).toMatchObject({ spare: true, fromLevel: 5, cost: 44_000_000 });
    });

    test('a copy already at the target leaves no run to price, and so no ladder', () => {
        game.inventory.push(cape(7));
        watchTarget('/items/sinister_cape', 7);

        expect(watchedTargets()[0].ladder).toBeNull();
    });

    test('an equipped copy with no count field still counts as owned', () => {
        // Equipped pieces don't reliably carry a count field the way stacked
        // inventory items do (see loadout-snapshot.js highestOwnedEnhancements
        // and the custom-tabs binding-sync fix for the same family of bug).
        // Replace the +5 worn copy with one that has no `count` at all.
        game.inventory = game.inventory.filter((item) => item.itemLocationHrid !== '/item_locations/back');
        game.inventory.push({
            itemHrid: '/items/sinister_cape',
            itemLocationHrid: '/item_locations/back',
            enhancementLevel: 5,
        });
        watchTarget('/items/sinister_cape', 7);
        const target = watchedTargets()[0];

        // Direct cost should still count from the equipped +5, not treat it as
        // unowned and price from +0
        expect(target.fromLevel).toBe(5);
        expect(target.cost).toBe(44_000_000);
    });
});

describe('which run the card is saving towards', () => {
    // The same two-copy shape the ladder block above uses: one on your back and
    // a spare in the bag, so both paths exist and there is a choice to make
    const cape = (level, count = 1) => ({
        itemHrid: '/items/sinister_cape',
        itemLocationHrid: '/item_locations/inventory',
        count,
        enhancementLevel: level,
    });

    beforeEach(() => {
        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/sinister_cape:0'] = { ask: 50_000_000, bid: 45_000_000 };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 2_000_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_800_000 };

        game.inventory.push({ ...cape(5), itemLocationHrid: '/item_locations/back' }, cape(2));
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    // Cost that follows how far the run has to climb, so the
                    // two paths are different numbers rather than the same one
                    calculateEnhancement: ({ targetLevel, startLevel, protectFrom }) =>
                        protectFrom > 0
                            ? { attempts: 10 * (targetLevel - startLevel), protectionCount: targetLevel - startLevel }
                            : { attempts: 100 * (targetLevel - startLevel), protectionCount: 0 },
                },
                enhancementConfig: {
                    getAutoDetectedParams: () => ({ enhancingLevel: 100, teas: {}, guzzlingBonus: 1 }),
                },
            },
        };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    test('the direct run is what a fresh target is costed along', () => {
        watchTarget('/items/sinister_cape', 7);

        expect(isLaddering('/items/sinister_cape', 7)).toBe(false);
        expect(watchedTargets()[0].mode).toBe('direct');
        expect(watchedTargets()[0].cost).toBe(44_000_000);
    });

    test('the switch moves the cost, the bar and the countdown onto the ladder', () => {
        watchTarget('/items/sinister_cape', 7);
        const before = watchedTargets()[0];

        toggleLaddering('/items/sinister_cape', 7);
        const after = watchedTargets()[0];

        expect(after.mode).toBe('ladder');
        // Five levels from the +2 spare rather than two from the +5 you wear
        expect(after.cost).toBe(110_000_000);
        // The bar and the ETA are read off the cost, so both have to move with it
        expect(after.fraction).toBeLessThan(before.fraction);
        expect(after.needed).toBe(110_000_000 - 60_000_000);
        expect(after.seconds).not.toBe(before.seconds);
    });

    test('and back again, leaving the direct run as the basis', () => {
        watchTarget('/items/sinister_cape', 7);
        toggleLaddering('/items/sinister_cape', 7);
        toggleLaddering('/items/sinister_cape', 7);

        expect(isLaddering('/items/sinister_cape', 7)).toBe(false);
        expect(watchedTargets()[0].cost).toBe(44_000_000);
    });

    test('the choice is written back with the watch entry, not held in the panel', async () => {
        watchTarget('/items/sinister_cape', 7);
        game.writes = [];
        toggleLaddering('/items/sinister_cape', 7);
        await flushSavingsWrites();

        const last = game.writes[game.writes.length - 1];
        expect(last.key).toContain('equipmentSavings');
        expect(last.value.targets['/items/sinister_cape::7'].mode).toBe('ladder');
    });

    test('the choice belongs to one target rather than to the whole list', () => {
        game.details['/items/sinister_hood'] = {
            name: 'Sinister Hood',
            itemLevel: 70,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
            equipmentDetail: { type: '/equipment_types/head' },
        };
        game.prices['/items/sinister_hood:0'] = { ask: 20_000_000, bid: 18_000_000 };
        game.inventory.push(
            { itemHrid: '/items/sinister_hood', itemLocationHrid: '/item_locations/inventory', count: 2 },
            { itemHrid: '/items/sinister_hood', itemLocationHrid: '/item_locations/inventory', count: 1 }
        );

        watchTarget('/items/sinister_cape', 7);
        watchTarget('/items/sinister_hood', 7);
        toggleLaddering('/items/sinister_cape', 7);

        expect(isLaddering('/items/sinister_cape', 7)).toBe(true);
        expect(isLaddering('/items/sinister_hood', 7)).toBe(false);
    });

    test('the two rows swap places rather than the card losing one', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();
        expect(text()).toContain('Enhance +5 → +7');
        expect(text()).toContain('Ladder: enhance your +2 copy instead');

        toggleLaddering('/items/sinister_cape', 7);
        equipmentSavingsPanel.render();

        expect(text()).toContain('Ladder: enhance your +2 copy');
        expect(text()).toContain('Direct: enhance your +5 copy instead');
        expect(text()).not.toContain('Enhance +5 → +7');
        expect(text()).not.toContain(FAILED);
    });

    test('the switch is on the card, naming the path it is on', () => {
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        const button = equipmentSavingsPanel.panel.querySelector('[data-target-ladder="/items/sinister_cape"]');
        expect(button.textContent).toBe('Direct');

        button.click();
        expect(
            equipmentSavingsPanel.panel.querySelector('[data-target-ladder="/items/sinister_cape"]').textContent
        ).toBe('Ladder');
    });

    test('a target with no ladder to climb is offered no switch', () => {
        // Only the one copy, and nothing selling another
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        game.prices['/items/sinister_cape:0'] = null;
        watchTarget('/items/sinister_cape', 7);
        equipmentSavingsPanel.show();

        expect(watchedTargets()[0].ladder).toBeNull();
        expect(equipmentSavingsPanel.panel.querySelector('[data-target-ladder]')).toBeNull();
    });

    test('a ladder that disappears falls back to the direct run rather than to nothing', () => {
        watchTarget('/items/sinister_cape', 7);
        toggleLaddering('/items/sinister_cape', 7);
        // The spare gets sold
        game.inventory = game.inventory.filter((item) => (item.enhancementLevel || 0) !== 2);
        game.prices['/items/sinister_cape:0'] = null;

        expect(watchedTargets()[0].mode).toBe('direct');
        expect(watchedTargets()[0].cost).toBe(44_000_000);
        // And the choice is remembered, so buying another spare puts it back
        expect(isLaddering('/items/sinister_cape', 7)).toBe(true);
    });
});

describe('what a run costs, through the real Markov chain', () => {
    // The mocks above make the strategy search trivial — every protected run
    // costs the same whatever level it protects from — which is exactly the
    // thing that hid this. The real chain is the only thing that can tell a
    // protect-from-+2 run from a protect-from-+5 one, and the difference
    // between them is where the reported price went wrong.
    beforeEach(async () => {
        globalThis.math = await import('mathjs');
        const { calculateEnhancement } = await import('../../utils/enhancement-calculator.js');

        game.details['/items/sinister_cape'] = {
            name: 'Sinister Cape',
            itemLevel: 50,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 1 }],
            equipmentDetail: { type: '/equipment_types/back' },
        };
        game.prices['/items/shard:0'] = { ask: 1_000_000, bid: 900_000 };
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 240_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 240_000, bid: 220_000 };

        window.Toolasha = {
            Utils: {
                enhancementCalculator: { calculateEnhancement },
                enhancementConfig: {
                    getAutoDetectedParams: () => ({
                        enhancingLevel: 84,
                        toolBonus: 4,
                        speedBonus: 0,
                        teas: { blessed: false },
                        guzzlingBonus: 1,
                    }),
                },
            },
        };
        // mathjs's dynamic import alone measures ~0.7 s standalone (see
        // enhancement-config.test.js) and imports fresh per test here since
        // this hook is what does the importing; under the full suite's worker
        // contention that races vitest's 5 s default hook timeout, independent
        // of any per-test timeout on the tests that follow.
    }, 30_000);

    afterEach(() => {
        delete window.Toolasha;
        delete globalThis.math;
    });

    test('starting higher is never dearer than starting lower', () => {
        // The bug this pins: the protection search was bounded below at the
        // start level, so a run beginning at +5 could only protect from +5
        // while a run beginning at +4 was allowed to protect from +4 — and the
        // card reported a +4 → +7 ladder at 173M against a +5 → +7 direct run
        // at 214M, which says the anvil pays you to throw a level away.
        const costs = [0, 1, 2, 3, 4, 5, 6].map((start) => enhancementCost('/items/sinister_cape', 7, start));

        expect(costs.every((cost) => cost > 0)).toBe(true);
        for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeLessThanOrEqual(costs[i - 1]);
        // Seven real chains: ~1 s alone, far past vitest's 5 s default under full-suite load
    }, 30_000);

    test('the two levels the report was about, the right way round', () => {
        const fromFive = enhancementCost('/items/sinister_cape', 7, 5);
        const fromFour = enhancementCost('/items/sinister_cape', 7, 4);

        expect(Math.round(fromFive)).toBe(81_926_437);
        expect(Math.round(fromFour)).toBe(101_311_834);
        expect(fromFive).toBeLessThan(fromFour);
    });

    test('both paths on the card come from that same chain', () => {
        game.inventory.push(
            {
                itemHrid: '/items/sinister_cape',
                itemLocationHrid: '/item_locations/back',
                count: 1,
                enhancementLevel: 5,
            },
            {
                itemHrid: '/items/sinister_cape',
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
                enhancementLevel: 4,
            }
        );
        game.equipment.set('/item_locations/back', { itemHrid: '/items/sinister_cape', enhancementLevel: 5 });
        watchTarget('/items/sinister_cape', 7);

        const direct = watchedTargets()[0];
        expect(Math.round(direct.cost)).toBe(81_926_437);
        expect(Math.round(direct.ladder.cost)).toBe(101_311_834);
        // Which is the ordering the ladder line has always claimed: the safe
        // way round costs more, because it starts a level lower
        expect(direct.ladder.cost).toBeGreaterThan(direct.cost);

        toggleLaddering('/items/sinister_cape', 7);
        const laddered = watchedTargets()[0];
        expect(Math.round(laddered.cost)).toBe(101_311_834);
        expect(Math.round(laddered.direct)).toBe(81_926_437);
    });

    test('the protection search reaches below the level the run starts at', () => {
        // With no protection to buy there is only the ruinous unprotected run,
        // and it is far dearer than the protected one — which is what makes the
        // strategy search worth having at all
        game.prices['/items/mirror_of_protection:0'] = null;
        delete game.details['/items/mirror_of_protection'];

        expect(enhancementCost('/items/sinister_cape', 7, 5)).toBeGreaterThan(400_000_000);
    });
});

describe('ability levels on the savings list', () => {
    test('a goal is costed in books at what the market wants for them', async () => {
        // Lv40 → Lv46 is 6M experience at 500 an advanced book, so twelve
        // thousand books at the mid of 12k/8k
        await watchAbility('/abilities/fierce_aura', 46);

        const [goal] = watchedAbilityGoals();
        expect(goal.cost).toBe(120_000_000);
        expect(goal.name).toBe('Fierce Aura Lv46');
        expect(goal.currentLevel).toBe(40);
        expect(goal.targetLevel).toBe(46);
    });

    test('the books point at the item, which is the thing with a price', async () => {
        await watchAbility('/abilities/fierce_aura', 46);
        expect(watchedAbilityGoals()[0].itemHrid).toBe('/items/fierce_aura');
    });

    test('progress is the same question the gear asks: coins against the cost', async () => {
        await watchAbility('/abilities/fierce_aura', 46);

        const [goal] = watchedAbilityGoals();
        expect(goal.fraction).toBe(0.5);
        expect(goal.needed).toBe(60_000_000);
        expect(goal.affordable).toBe(false);
    });

    test('adding a goal for an ability that has one replaces it', async () => {
        // A later sim run refines the same intention; two rows would show both
        await watchAbility('/abilities/fierce_aura', 46);
        await watchAbility('/abilities/fierce_aura', 50);

        const goals = watchedAbilityGoals();
        expect(goals).toHaveLength(1);
        expect(goals[0].targetLevel).toBe(50);
        expect(goals[0].cost).toBe(200_000_000);
    });

    test('a level already reached is done rather than lingering at full price', async () => {
        await watchAbility('/abilities/fierce_aura', 30);

        const [goal] = watchedAbilityGoals();
        expect(goal.done).toBe(true);
        expect(goal.cost).toBe(0);
        expect(goal.affordable).toBe(true);
    });

    test('a book nobody is selling is unpriced rather than free', async () => {
        game.bookPrices = {};
        await watchAbility('/abilities/fierce_aura', 46);

        const [goal] = watchedAbilityGoals();
        expect(goal.cost).toBeNull();
        expect(goal.affordable).toBe(false);
    });

    test('a cost can be given when the market has none', async () => {
        game.bookPrices = {};
        await watchAbility('/abilities/fierce_aura', 46, 30_000_000);

        expect(watchedAbilityGoals()[0].cost).toBe(30_000_000);
    });

    test('an unlearned ability starts from nothing, and pays for the book that learns it', async () => {
        game.bookPrices['/items/toxic_pollen'] = { ask: 1_000, bid: 1_000 };
        // 30M of experience at 500 a book, plus the one that learns it
        expect(abilityBookCost('/abilities/toxic_pollen', 30)).toBe(60_001_000);
    });

    test('removing one takes it off the list', async () => {
        await watchAbility('/abilities/fierce_aura', 46);
        await unwatchAbility('/abilities/fierce_aura');

        expect(watchedAbilityGoals()).toEqual([]);
    });

    test('a goal with no level is not a goal', async () => {
        await watchAbility('/abilities/fierce_aura', 0);
        expect(watchedAbilityGoals()).toEqual([]);
    });

    test('goals are written into the same record the gear is', async () => {
        watchTarget('/items/holy_sword');
        game.writes = [];
        await watchAbility('/abilities/fierce_aura', 46);
        await flushSavingsWrites();

        const last = game.writes[game.writes.length - 1];
        expect(last.key).toContain('equipmentSavings');
        // Both sides survive one write, because there is only one writer
        expect(last.value.targets['/items/holy_sword']).toBeDefined();
        expect(last.value.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
    });
});

describe('house levels on the savings list', () => {
    test('a goal is costed across every level from where the room is', async () => {
        // Lv3 → Lv5: 10M + 10 lumber, then 20M + 40 lumber, at a million a log
        await watchHouse('/house_rooms/mystical_study', 5);

        const [goal] = watchedHouseGoals();
        expect(goal.cost).toBe(80_000_000);
        expect(goal.name).toBe('Mystical Study Lv5');
        expect(goal.currentLevel).toBe(3);
        expect(goal.targetLevel).toBe(5);
    });

    test('coins in the build list count at face value rather than being priced', () => {
        // A coin has no order book; leaving it out understates the level by
        // exactly the coin part of it
        expect(houseUpgradeCost('/house_rooms/mystical_study', 4)).toBe(20_000_000);
    });

    test('the room the character has is where the count starts', () => {
        expect(houseRoomLevels().get('/house_rooms/mystical_study')).toBe(3);
        expect(houseRoomLevels().get('/house_rooms/gym')).toBeUndefined();
    });

    test('a room never built pays for every level from the first', () => {
        expect(houseUpgradeCost('/house_rooms/gym', 1)).toBe(1_000_000);
    });

    test('progress is the same question the gear asks: coins against the cost', async () => {
        await watchHouse('/house_rooms/mystical_study', 5);

        const [goal] = watchedHouseGoals();
        expect(goal.fraction).toBe(0.75);
        expect(goal.needed).toBe(20_000_000);
        expect(goal.affordable).toBe(false);
    });

    test('adding a goal for a room that has one replaces it', async () => {
        await watchHouse('/house_rooms/mystical_study', 4);
        await watchHouse('/house_rooms/mystical_study', 5);

        const goals = watchedHouseGoals();
        expect(goals).toHaveLength(1);
        expect(goals[0].targetLevel).toBe(5);
        expect(goals[0].cost).toBe(80_000_000);
    });

    test('a level already built is done rather than lingering at full price', async () => {
        await watchHouse('/house_rooms/mystical_study', 3);

        const [goal] = watchedHouseGoals();
        expect(goal.done).toBe(true);
        expect(goal.cost).toBe(0);
        expect(goal.affordable).toBe(true);
    });

    test('a material nobody is selling makes the build unpriced rather than cheap', async () => {
        delete game.prices['/items/lumber:0'];
        await watchHouse('/house_rooms/mystical_study', 5);

        const [goal] = watchedHouseGoals();
        expect(goal.cost).toBeNull();
        expect(goal.affordable).toBe(false);
    });

    test('a cost can be given when the market has none', async () => {
        delete game.prices['/items/lumber:0'];
        await watchHouse('/house_rooms/mystical_study', 5, 30_000_000);

        expect(watchedHouseGoals()[0].cost).toBe(30_000_000);
    });

    test('a room the game has no build costs for is unpriced', () => {
        expect(houseUpgradeCost('/house_rooms/unknown', 4)).toBeNull();
    });

    test('a level past the one the game builds to is capped rather than costed', async () => {
        await watchHouse('/house_rooms/mystical_study', 12);
        expect(watchedHouseGoals()[0].targetLevel).toBe(8);
    });

    test('removing one takes it off the list', async () => {
        await watchHouse('/house_rooms/mystical_study', 5);
        await unwatchHouse('/house_rooms/mystical_study');

        expect(watchedHouseGoals()).toEqual([]);
    });

    test('a goal with no level is not a goal', async () => {
        await watchHouse('/house_rooms/mystical_study', 0);
        expect(watchedHouseGoals()).toEqual([]);
    });

    test('goals are written into the same record the gear and the abilities are', async () => {
        watchTarget('/items/holy_sword');
        await watchAbility('/abilities/fierce_aura', 46);
        game.writes = [];
        await watchHouse('/house_rooms/mystical_study', 5);
        await flushSavingsWrites();

        const last = game.writes[game.writes.length - 1];
        expect(last.key).toContain('equipmentSavings');
        // All three sides survive one write, because there is only one writer
        expect(last.value.targets['/items/holy_sword']).toBeDefined();
        expect(last.value.abilities['/abilities/fierce_aura'].targetLevel).toBe(46);
        expect(last.value.houses['/house_rooms/mystical_study'].targetLevel).toBe(5);
    });
});

describe('the whole list, with levels on it', () => {
    test('a level to save for is part of what the plan costs', async () => {
        watchTarget('/items/rough_boots');
        await watchAbility('/abilities/fierce_aura', 46);

        const plan = everything();
        expect(plan.abilities).toHaveLength(1);
        expect(plan.cost).toBe(125_000_000);
    });

    test('a level already reached is not still being saved for', async () => {
        watchTarget('/items/rough_boots');
        await watchAbility('/abilities/fierce_aura', 30);

        const plan = everything();
        expect(plan.cost).toBe(5_000_000);
        expect(plan.abilities[0].done).toBe(true);
    });

    test('a room to build is part of what the plan costs', async () => {
        watchTarget('/items/rough_boots');
        await watchHouse('/house_rooms/mystical_study', 5);

        const plan = everything();
        expect(plan.houses).toHaveLength(1);
        expect(plan.cost).toBe(85_000_000);
    });

    test('a room already built is not still being saved for', async () => {
        watchTarget('/items/rough_boots');
        await watchHouse('/house_rooms/mystical_study', 3);

        const plan = everything();
        expect(plan.cost).toBe(5_000_000);
        expect(plan.houses[0].done).toBe(true);
    });
});

describe('the panel draws levels', () => {
    test('a goal appears with its label, its cost and where it is', async () => {
        await watchAbility('/abilities/fierce_aura', 46);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Ability Levels');
        expect(text()).toContain('Fierce Aura Lv46');
        expect(text()).toContain('40 → 46');
    });

    test('a goal that has happened says so rather than showing a full bar and nothing else', async () => {
        await watchAbility('/abilities/fierce_aura', 30);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Reached at Lv40');
    });

    test('the panel offers to add one, and the picker lists the abilities', async () => {
        equipmentSavingsPanel.show();
        expect(text()).not.toContain(FAILED);

        const add = equipmentSavingsPanel.panel.querySelector('[data-add-ability]');
        expect(add).not.toBeNull();

        add.click();
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-ability]')).not.toBeNull();
        expect(text()).toContain('Pick an ability.');
    });

    test('picking, levelling and watching puts it on the list', async () => {
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-add-ability]').click();

        const picker = equipmentSavingsPanel.panel.querySelector('[data-pick-ability]');
        picker.value = '/abilities/fierce_aura';
        picker.dispatchEvent(new Event('change'));

        const level = equipmentSavingsPanel.panel.querySelector('[data-ability-level]');
        // The form opens on the next level up rather than on one already had
        expect(level.value).toBe('41');
        level.value = '46';
        level.dispatchEvent(new Event('input'));

        equipmentSavingsPanel.panel.querySelector('[data-save-ability]').click();
        await vi.waitFor(() => expect(watchedAbilityGoals()).toHaveLength(1));

        expect(watchedAbilityGoals()[0].targetLevel).toBe(46);
        expect(watchedAbilityGoals()[0].cost).toBe(120_000_000);
    });

    test('a goal can be taken off from its card', async () => {
        await watchAbility('/abilities/fierce_aura', 46);
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-remove-ability]').click();
        await vi.waitFor(() => expect(watchedAbilityGoals()).toHaveLength(0));
    });

    test('the abilities you have learned lead the picker, the rest follow', () => {
        const choices = abilityChoices();
        expect(choices[0]).toMatchObject({ abilityHrid: '/abilities/fierce_aura', level: 40, learned: true });
        expect(choices.map((choice) => choice.abilityHrid)).toContain('/abilities/toxic_pollen');
        expect(choices.find((choice) => choice.abilityHrid === '/abilities/toxic_pollen').learned).toBe(false);
    });

    test('a panel with only levels on it is not an empty panel', async () => {
        setLocked(true);
        await watchAbility('/abilities/fierce_aura', 46);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Fierce Aura Lv46');
        expect(text()).not.toContain('Nothing being saved for yet');
    });
});

describe('the panel draws house levels', () => {
    test('a goal appears with its label, its cost and where the room is', async () => {
        await watchHouse('/house_rooms/mystical_study', 5);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('House Levels');
        expect(text()).toContain('Mystical Study Lv5');
        expect(text()).toContain('3 → 5');
    });

    test('a room already built says so rather than showing a full bar and nothing else', async () => {
        await watchHouse('/house_rooms/mystical_study', 3);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Reached at Lv3');
    });

    test('the panel offers to add one, and the picker lists the rooms', async () => {
        equipmentSavingsPanel.show();
        expect(text()).not.toContain(FAILED);

        const add = equipmentSavingsPanel.panel.querySelector('[data-add-house]');
        expect(add).not.toBeNull();

        add.click();
        expect(equipmentSavingsPanel.panel.querySelector('[data-pick-house]')).not.toBeNull();
        expect(text()).toContain('Pick a room.');
    });

    test('picking, levelling and watching puts it on the list', async () => {
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-add-house]').click();

        const picker = equipmentSavingsPanel.panel.querySelector('[data-pick-house]');
        picker.value = '/house_rooms/mystical_study';
        picker.dispatchEvent(new Event('change'));

        const level = equipmentSavingsPanel.panel.querySelector('[data-house-level]');
        // The form opens on the next level up rather than on one already built
        expect(level.value).toBe('4');
        level.value = '5';
        level.dispatchEvent(new Event('input'));

        equipmentSavingsPanel.panel.querySelector('[data-save-house]').click();
        await vi.waitFor(() => expect(watchedHouseGoals()).toHaveLength(1));

        expect(watchedHouseGoals()[0].targetLevel).toBe(5);
        expect(watchedHouseGoals()[0].cost).toBe(80_000_000);
    });

    test('a typed level past the cap is held at the cap', async () => {
        equipmentSavingsPanel.show();
        equipmentSavingsPanel.panel.querySelector('[data-add-house]').click();

        const picker = equipmentSavingsPanel.panel.querySelector('[data-pick-house]');
        picker.value = '/house_rooms/mystical_study';
        picker.dispatchEvent(new Event('change'));

        const level = equipmentSavingsPanel.panel.querySelector('[data-house-level]');
        level.value = '12';
        level.dispatchEvent(new Event('input'));
        level.dispatchEvent(new Event('change'));

        expect(equipmentSavingsPanel.panel.querySelector('[data-house-level]').value).toBe('8');
    });

    test('a goal can be taken off from its card', async () => {
        await watchHouse('/house_rooms/mystical_study', 5);
        equipmentSavingsPanel.show();

        equipmentSavingsPanel.panel.querySelector('[data-remove-house]').click();
        await vi.waitFor(() => expect(watchedHouseGoals()).toHaveLength(0));
    });

    test('the rooms you have built lead the picker, and a maxed one is not offered', () => {
        const choices = houseChoices();
        expect(choices[0]).toMatchObject({ houseRoomHrid: '/house_rooms/mystical_study', level: 3, built: true });
        // The Dojo is already at the level the game stops at, so there is
        // nothing left to save for
        expect(choices.map((choice) => choice.houseRoomHrid)).not.toContain('/house_rooms/dojo');
        expect(choices.find((choice) => choice.houseRoomHrid === '/house_rooms/gym').built).toBe(false);
    });

    test('a panel with only rooms on it is not an empty panel', async () => {
        setLocked(true);
        await watchHouse('/house_rooms/mystical_study', 5);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Mystical Study Lv5');
        expect(text()).not.toContain('Nothing being saved for yet');
    });

    test('the room is what the header watches when it is the nearest thing to done', async () => {
        await watchHouse('/house_rooms/mystical_study', 5);
        equipmentSavingsPanel.show();

        expect(text()).not.toContain(FAILED);
        // The headline names it, and Everything counts it
        expect(text()).toContain('1 house level');
    });
});

describe('the marketplace a watched enhancement opens', () => {
    // The maintainer's case: a refinement that RETAINS enhancement, watched at
    // +12. The card costs the base at +12; every link and the Missing Mats
    // button have to shop for the same thing, or the panel quotes one piece and
    // the marketplace shows another a fifth the price.
    const openCalls = [];

    const watchRefinedAt12 = () => {
        game.actions['/actions/refine'].retainAllEnhancement = true;
        // The finished ★+12 is listed, so the card takes the craft path rather
        // than treating the target as something only an anvil can produce
        game.prices['/items/refined_spear:12'] = { ask: 2_000_000_000, bid: 1_800_000_000 };
        watchTarget('/items/refined_spear', 12);
        toggleCrafting('/items/refined_spear', 12);
    };

    beforeEach(() => {
        openCalls.length = 0;
        window.Toolasha = {
            Actions: {
                missingMaterialsButton: {
                    openMissingMaterials: (...args) => {
                        openCalls.push(args);
                    },
                },
            },
        };
    });

    afterEach(() => {
        delete window.Toolasha;
    });

    const clickMissingMats = () => {
        const button = Array.from(equipmentSavingsPanel.panel.querySelectorAll('button')).find(
            (element) => element.textContent === 'Missing Mats Marketplace'
        );
        expect(button).toBeTruthy();
        button.click();
    };

    test('the route is reported, not just its price: a listed base is shopped for at the level', () => {
        // A +12 on the market, and no enhancing bench to run a ladder on
        game.prices['/items/plain_spear:12'] = { ask: 500_000_000, bid: 450_000_000 };
        const recipe = { upgradeItemHrid: '/items/plain_spear', retainAllEnhancement: true };

        expect(upgradeBaseRoute(recipe, 12, () => 300_000_000)).toEqual({ cost: 500_000_000, level: 12 });
    });

    test('the route is 0 when the enhance run wins, because what is bought then is a +0', () => {
        game.details['/items/plain_spear'].itemLevel = 90;
        game.details['/items/plain_spear'].enhancementCosts = [{ itemHrid: '/items/shard', count: 2 }];
        window.Toolasha.Utils = {
            enhancementCalculator: { calculateEnhancement: () => ({ attempts: 2, protectionCount: 0 }) },
            enhancementConfig: { getAutoDetectedParams: () => ({ enhancingLevel: 100, toolBonus: 10 }) },
        };
        // No listing at the level at all, so the run is the only route
        const recipe = { upgradeItemHrid: '/items/plain_spear', retainAllEnhancement: true };

        expect(upgradeBaseRoute(recipe, 12, () => 300_000_000).level).toBe(0);
    });

    test('a base already in the bag at the level is still a bill about that level', () => {
        game.inventory.push({ itemHrid: '/items/plain_spear', count: 1, enhancementLevel: 12 });
        const recipe = { upgradeItemHrid: '/items/plain_spear', retainAllEnhancement: true };

        expect(upgradeBaseRoute(recipe, 12, () => 300_000_000)).toEqual({ cost: 0, level: 12 });
    });

    test('the Missing Mats button asks for the base at the level the card costed', async () => {
        game.prices['/items/plain_spear:12'] = { ask: 500_000_000, bid: 450_000_000 };
        watchRefinedAt12();
        equipmentSavingsPanel.show();

        clickMissingMats();

        await vi.waitFor(() => expect(openCalls).toHaveLength(1));
        expect(openCalls[0]).toEqual(['/actions/refine', 1, { upgradeItemLevel: 12 }]);
    });

    test('a plain craft still opens the +0 bill it always did', async () => {
        watchTarget('/items/refined_spear');
        toggleCrafting('/items/refined_spear');
        equipmentSavingsPanel.show();

        clickMissingMats();

        await vi.waitFor(() => expect(openCalls).toHaveLength(1));
        expect(openCalls[0]).toEqual(['/actions/refine', 1, { upgradeItemLevel: 0 }]);
    });

    test('the icon and the name open the level the row is about, not the base item', () => {
        watchRefinedAt12();
        equipmentSavingsPanel.show();

        for (const element of equipmentSavingsPanel.panel.querySelectorAll('[title="Open in the marketplace"]')) {
            element.click();
        }

        expect(game.navigations.length).toBeGreaterThan(0);
        for (const navigation of game.navigations) {
            expect(navigation).toEqual({ itemHrid: '/items/refined_spear', enhancementLevel: 12 });
        }
    });

    test('an unenhanced row still opens the plain listing', () => {
        watchTarget('/items/holy_sword');
        equipmentSavingsPanel.show();

        for (const element of equipmentSavingsPanel.panel.querySelectorAll('[title="Open in the marketplace"]')) {
            element.click();
        }

        expect(game.navigations.length).toBeGreaterThan(0);
        for (const navigation of game.navigations) {
            expect(navigation.enhancementLevel).toBe(0);
        }
    });
});

describe('the base a refinement recipe consumes is priced at the output level', () => {
    const priceBase = () => 10_000_000; // a fresh +0

    test('a plain upgrade recipe: any owned copy is free, missing costs a +0', () => {
        const recipe = { upgradeItemHrid: '/items/spear', retainAllEnhancement: false };
        game.inventory = [{ itemHrid: '/items/spear', count: 1, enhancementLevel: 0 }];
        expect(upgradeBaseCost(recipe, 12, priceBase)).toBe(0);

        game.inventory = [];
        expect(upgradeBaseCost(recipe, 12, priceBase)).toBe(10_000_000);
    });

    test('retainAllEnhancement: a +0 in the bag is a starting point, not a free base', () => {
        const recipe = { upgradeItemHrid: '/items/spear', retainAllEnhancement: true };
        game.details['/items/spear'] = {
            name: 'Spear',
            itemLevel: 90,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
        };
        game.prices['/items/shard:0'] = { ask: 1000, bid: 900 };
        game.inventory = [{ itemHrid: '/items/spear', count: 1, enhancementLevel: 0 }];
        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    calculateEnhancement: () => ({ attempts: 200, protectionCount: 0 }),
                },
                enhancementConfig: {
                    getAutoDetectedParams: () => ({ enhancingLevel: 100, toolBonus: 10 }),
                },
            },
        };

        const cost = upgradeBaseCost(recipe, 5, priceBase);
        // The bag copy is the start of the enhance run - a run, not zero, and
        // not a fresh +0 on top
        expect(cost).toBeGreaterThan(0);
        expect(cost).toBeLessThan(10_000_000);
        expect(cost).toBe(enhancementCost('/items/spear', 5, 0));
    });

    test('retainAllEnhancement: a copy already at the level is simply consumed', () => {
        const recipe = { upgradeItemHrid: '/items/spear', retainAllEnhancement: true };
        game.inventory = [{ itemHrid: '/items/spear', count: 1, enhancementLevel: 12 }];
        expect(upgradeBaseCost(recipe, 12, priceBase)).toBe(0);
    });

    test('retainAllEnhancement: a listed base at the level competes with the enhance run', () => {
        const recipe = { upgradeItemHrid: '/items/spear', retainAllEnhancement: true };
        game.details['/items/spear'] = {
            name: 'Spear',
            itemLevel: 90,
            enhancementCosts: [{ itemHrid: '/items/shard', count: 2 }],
        };
        game.prices['/items/shard:0'] = { ask: 1000, bid: 900 };
        game.inventory = [];
        game.prices['/items/spear:5'] = { ask: 1, bid: 1 }; // absurdly cheap direct listing
        expect(upgradeBaseCost(recipe, 5, priceBase)).toBe(1);
    });
});

/**
 * The tile's `version()`.
 *
 * The overlay panel redraws every visible tile once a second, and skips a row's
 * whole render when its `version()` comes back unchanged. This tile is the
 * expensive one — a loadout resolved per target, the action map scanned for a
 * recipe, an enhancement run priced — so the memo is worth a lot and a memo that
 * misses an input is worth less than nothing: it would leave a price on screen
 * that the market has moved past.
 *
 * So each test below moves exactly one of the things the render reads.
 */
describe('the Equipment Watch tile summarises its own inputs', () => {
    const tile = () => rowsByKey.get('equipmentWatch');
    const version = () => tile().version();

    const fire = (event) => (game.gameListeners[event] || []).forEach((handler) => handler({}));

    test('nothing watched is one settled version, and a blank tile', () => {
        expect(version()).toBe('blank');
        expect(version()).toBe(version());

        const container = document.createElement('div');
        tile().render(container);
        expect(container.textContent.trim()).toBe('');
    });

    test('adding, pinning and dropping a target each move it', () => {
        const empty = version();

        watchTarget('/items/holy_sword', 0);
        const watched = version();
        expect(watched).not.toBe(empty);

        // The same list read twice is the same version — that is the whole
        // point, and the thing the render is spared
        expect(version()).toBe(watched);

        // The pin decides which of several targets the tile shows
        selectTarget('/items/holy_sword');
        expect(version()).not.toBe(watched);
    });

    test('the trade-in switch moves it, because it changes every figure on the tile', () => {
        watchTarget('/items/holy_sword', 0);
        const before = version();

        setNoSell(true);
        expect(version()).not.toBe(before);
    });

    test('a different enhancement of the same piece is a different purchase', () => {
        watchTarget('/items/holy_sword', 0);
        const plain = version();

        watchTarget('/items/holy_sword', 10);
        expect(version()).not.toBe(plain);
    });

    test('an ability goal is on the list too', async () => {
        const before = version();
        await watchAbility('/abilities/fierce_aura', 46, 1_000_000);
        expect(version()).not.toBe(before);
    });

    test('a new price feed moves it, even though nothing was edited', () => {
        watchTarget('/items/holy_sword', 0);
        const before = version();

        // Every figure on the tile is a price or a difference of prices
        game.priceListeners.forEach((handler) => handler());
        expect(version()).not.toBe(before);
    });

    test('what the game says about coins, gear and levels moves it', () => {
        watchTarget('/items/holy_sword', 0);

        // Each of these can change a cost without anything being edited: coins
        // and inventory decide the shortfall, worn gear the trade-in, levels and
        // buffs the price of an enhancement run
        for (const event of ['items_updated', 'skills_updated', 'house_rooms_updated', 'community_buffs_updated']) {
            const before = version();
            fire(event);
            expect(version(), `${event} should move the version`).not.toBe(before);
        }
    });

    test('a rendered tile still shows what the list says after an edit', () => {
        // The memo is only as good as the render it gates: a version that moved
        // has to be followed by a tile that says the new thing
        game.prices['/items/holy_sword:0'] = { ask: 1_000_000_000, bid: 900_000_000 };
        game.prices['/items/rough_boots:0'] = { ask: 2_000_000_000, bid: 1_900_000_000 };
        watchTarget('/items/holy_sword', 0);

        const container = document.createElement('div');
        tile().render(container);
        expect(container.textContent).toContain('Holy Sword');

        watchTarget('/items/rough_boots', 0);
        selectTarget('/items/rough_boots');
        tile().render(container);
        expect(container.textContent).toContain('Rough Boots');
    });
});

describe('two levels of one piece are two targets', () => {
    test('saving for the +8 does not replace the +5', () => {
        // Keyed by item alone, the second Save for this silently took the place
        // of the first: the sword somebody was most of the way to affording
        // stopped being on the list at all
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };

        watchTarget('/items/holy_sword', 5);
        watchTarget('/items/holy_sword', 8);

        const levels = watchedTargets().map((target) => target.enhancementLevel);
        expect(levels.sort()).toEqual([5, 8]);
    });

    test('each is priced at its own level', () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };

        watchTarget('/items/holy_sword', 5);
        watchTarget('/items/holy_sword', 8);

        const byLevel = Object.fromEntries(watchedTargets().map((target) => [target.enhancementLevel, target.cost]));
        // Each less the 40M the worn cheese sword trades in for
        expect(byLevel[5]).toBe(160_000_000);
        expect(byLevel[8]).toBe(460_000_000);
    });

    test('stopping one leaves the other', () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };

        watchTarget('/items/holy_sword', 5);
        watchTarget('/items/holy_sword', 8);
        unwatchTarget('/items/holy_sword', 5);

        expect(isTargeted('/items/holy_sword', 5)).toBe(false);
        expect(isTargeted('/items/holy_sword', 8)).toBe(true);
        expect(watchedTargets()).toHaveLength(1);
    });

    test('the per-target switches belong to the level they were set on', () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };

        watchTarget('/items/holy_sword', 5);
        watchTarget('/items/holy_sword', 8);
        cycleTargetNoSell('/items/holy_sword', 8); // always sells

        setNoSell(true);
        const byLevel = Object.fromEntries(watchedTargets().map((target) => [target.enhancementLevel, target.noSell]));
        expect(byLevel[5]).toBe(true);
        expect(byLevel[8]).toBe(false);
    });

    test('what is written back carries both, under keys that tell them apart', async () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };

        watchTarget('/items/holy_sword', 5);
        watchTarget('/items/holy_sword', 8);
        await flushSavingsWrites();

        const last = game.writes[game.writes.length - 1];
        expect(Object.keys(last.value.targets).sort()).toEqual(['/items/holy_sword::5', '/items/holy_sword::8']);
    });
});

describe('the price the advisor quoted is the price the card shows', () => {
    test('a quoted cost is what the bar fills against', () => {
        // The savings module and the upgrade advisor price a piece with
        // different models. Two surfaces quoting two numbers for one target
        // leaves the reader to work out which of them is lying.
        watchTarget('/items/holy_sword', 0, { cost: 44_000_000, costSource: 'market' });

        const [target] = watchedTargets();
        expect(target.cost).toBe(44_000_000);
        // What this module would have said on its own is kept beside it
        expect(target.derivedCost).toBe(60_000_000);
        expect(target.quotedFrom).toBe('market');
    });

    test('the card says whose number it is showing', () => {
        watchTarget('/items/holy_sword', 0, { cost: 44_000_000, costSource: 'market' });
        equipmentSavingsPanel.show();

        expect(text()).toContain('Upgrade advisor (market)');
        expect(text()).toContain('44,000,000');
        expect(text()).not.toContain(FAILED);
    });

    test('no quote leaves the module costing it as it always did', () => {
        watchTarget('/items/holy_sword', 0);

        const [target] = watchedTargets();
        expect(target.cost).toBe(60_000_000);
        expect(target.quotedCost).toBeNull();
    });

    test('a caller that could not price it saves an unpriced target, not a free one', () => {
        watchTarget('/items/holy_sword', 0, { cost: null, costSource: 'market' });

        const [target] = watchedTargets();
        // Falls back to what this module can work out, rather than to zero
        expect(target.cost).toBe(60_000_000);
        expect(target.quotedCost).toBeNull();
    });
});

describe('a list written before the key carried the level', () => {
    /**
     * Fire the event the module reloads on, and let the read settle.
     * @returns {Promise<void>}
     */
    async function reloadCharacter() {
        // The listeners are the module's own `reload`, so awaiting what they
        // return is awaiting the read rather than guessing at how many ticks
        // it takes
        await Promise.all((game.gameListeners.character_initialized || []).map((handler) => handler({})));
        await flushSavingsWrites();
    }

    test('a +5 filed under the bare hrid comes back as a +5 target', async () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        // What an older build wrote: the level inside the entry, the key bare
        game.stored = { targets: { '/items/holy_sword': { enhancementLevel: 5, mode: 'ladder' } } };

        await reloadCharacter();

        const [target] = watchedTargets();
        expect(target.itemHrid).toBe('/items/holy_sword');
        expect(target.enhancementLevel).toBe(5);
        // Nothing on the entry is lost on the way through
        expect(isLaddering('/items/holy_sword', 5)).toBe(true);
    });

    test('the migrated target can be joined by another level rather than replaced', async () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.prices['/items/holy_sword:8'] = { ask: 500_000_000, bid: 450_000_000 };
        game.stored = { targets: { '/items/holy_sword': { enhancementLevel: 5 } } };

        await reloadCharacter();
        watchTarget('/items/holy_sword', 8);

        expect(
            watchedTargets()
                .map((target) => target.enhancementLevel)
                .sort()
        ).toEqual([5, 8]);
    });

    test('the pin follows the target it was pinned to', async () => {
        game.prices['/items/holy_sword:5'] = { ask: 200_000_000, bid: 180_000_000 };
        game.stored = {
            targets: { '/items/holy_sword': { enhancementLevel: 5 } },
            selected: '/items/holy_sword',
        };

        await reloadCharacter();
        equipmentSavingsPanel.show();

        expect(text()).toContain('Holy Sword');
        expect(text()).not.toContain(FAILED);
    });
});

describe('what one redraw costs', () => {
    // The equipmentWatch tile redraws whenever the game moves — a loot tick is
    // enough — and a live pformance export had `overlayRow:equipmentWatch` at
    // 77ms, the largest single piece of work in its five-second window. Almost
    // all of it was the protect-from sweep, run from scratch on every redraw:
    // one Markov chain per protect-from level of every climb, twice a target
    // (the run and the ladder's run). The sweep reads nothing but the bench,
    // the material price and the protection price, and a loot tick moves none
    // of the three.
    let sweeps = 0;
    let benches = 0;

    beforeEach(async () => {
        globalThis.math = await import('mathjs');
        const { calculateEnhancement } = await import('../../utils/enhancement-calculator.js');
        sweeps = 0;
        benches = 0;

        for (const hrid of ['/items/first_cape', '/items/second_cape']) {
            game.details[hrid] = {
                name: hrid.split('/').pop(),
                itemLevel: 50,
                enhancementCosts: [{ itemHrid: '/items/shard', count: 1 }],
                equipmentDetail: { type: '/equipment_types/back' },
            };
        }
        game.details['/items/mirror_of_protection'] = { name: 'Mirror of Protection', sellPrice: 240_000 };
        game.prices['/items/mirror_of_protection:0'] = { ask: 240_000, bid: 220_000 };
        game.inventory.push(
            { itemHrid: '/items/first_cape', itemLocationHrid: '/item_locations/back', count: 1, enhancementLevel: 3 },
            {
                itemHrid: '/items/second_cape',
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
                enhancementLevel: 2,
            }
        );

        window.Toolasha = {
            Utils: {
                enhancementCalculator: {
                    calculateEnhancement: (...args) => {
                        sweeps++;
                        return calculateEnhancement(...args);
                    },
                },
                enhancementConfig: {
                    getAutoDetectedParams: () => {
                        benches++;
                        return {
                            enhancingLevel: 84,
                            toolBonus: 4,
                            speedBonus: 0,
                            teas: { blessed: false },
                            guzzlingBonus: 1,
                        };
                    },
                },
            },
        };
    }, 30_000);

    afterEach(() => {
        delete window.Toolasha;
        delete globalThis.math;
    });

    test('a redraw nothing moved sweeps nothing, and reports the same figures', () => {
        watchTarget('/items/first_cape', 7);
        watchTarget('/items/second_cape', 7);

        const first = everything();
        expect(sweeps).toBeGreaterThan(0);
        const swept = sweeps;

        // The output-identical half: the second and third passes are served
        // from the cache, and what they report has to be what the sweep said
        expect(everything()).toEqual(first);
        expect(everything()).toEqual(first);
        expect(sweeps).toBe(swept);
    }, 30_000);

    test('a moved material price sweeps again rather than quoting the old run', () => {
        watchTarget('/items/first_cape', 7);

        const before = watchedTargets()[0].cost;
        const swept = sweeps;

        game.prices['/items/shard:0'] = { ask: 4_000_000, bid: 3_600_000 };
        const after = watchedTargets()[0].cost;

        expect(sweeps).toBeGreaterThan(swept);
        expect(after).toBeGreaterThan(before);
    }, 30_000);

    test('the bench is resolved once a target, not once a figure', () => {
        watchTarget('/items/first_cape', 7);
        watchTarget('/items/second_cape', 7);

        // Warm first: this is about the repetition inside one pass, not about
        // the sweep cache under it
        everything();
        benches = 0;
        everything();

        // Three resolutions a target before this: the direct run, the ladder's
        // run, and the chip naming the bench on the card
        expect(benches).toBeLessThanOrEqual(2);
    }, 30_000);
});
