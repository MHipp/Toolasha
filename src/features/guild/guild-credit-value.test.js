/**
 * @vitest-environment happy-dom
 *
 * The guild-credit math: gold cost per credit, ranked ask-first by default,
 * with a missing price never masquerading as a zero and a null figure always
 * sorting to the bottom regardless of which column is active.
 *
 * Driven the way combat-level-panel.js is driven: build the modal shape the
 * game renders, let the feature's DOM observer callback fire, read the table
 * back out.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatKMB } from '../../utils/formatters.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({
    settings: {},
    clientData: null,
    prices: {},
    observers: {},
    buildingLevels: {},
    buffLevels: {},
    inventory: [],
    captures: [],
    rates: {},
    storage: {},
    writes: 0,
    listeners: {},
    // Which character the scoped-storage mocks key against. Only the
    // character-switch reset test moves this off 'char1' — every other test
    // in this file relies on the '_char1' suffix it has always had.
    currentCharId: 'char1',
    // itemHrid -> { asks, bids }, the cached order book the advisor walks
    books: {},
}));

// The persisted order-book cache the advisor values a batch against. Reached
// through the bundle bridge in production (the tracker is a market-bundle
// singleton), so the bridge is what a test stands in for; `game.books` empty
// is the ordinary case of an item nobody has browsed.
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    estimatedListingAge: () =>
        Object.keys(game.books).length === 0
            ? null
            : {
                  cachedBookSide: (itemHrid, level, isSell) => {
                      const book = game.books[itemHrid];
                      const listings = isSell ? book?.asks : book?.bids;
                      return listings?.length ? { listings, lastUpdated: Date.now() } : null;
                  },
              },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getInventory: () => game.inventory,
        getGuildBuildingLevel: (hrid) => game.buildingLevels[hrid] ?? 0,
        getCharacterGuildBuffLevel: (hrid) => game.buffLevels[hrid] ?? 0,
        getCurrentCharacterId: () => 'char1',
        // The event side, for the shrine block's `items_updated` hook: a real
        // listener list, so a test can both fire it and check it was released.
        on: (event, handler) => {
            (game.listeners[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            game.listeners[event] = (game.listeners[event] || []).filter((fn) => fn !== handler);
        },
    },
}));
// An in-memory stand-in for IndexedDB: the shrine planner's saved plan is the
// only thing this file reads or writes through it, and a round-trip needs a
// store that survives the record being reset between "modal openings".
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key, store = 'settings') => {
            const k = `${store}:${key}`;
            return { found: k in game.storage, value: game.storage[k] };
        },
        get: async (key, store = 'settings', fallback = null) => {
            const k = `${store}:${key}`;
            return k in game.storage ? game.storage[k] : fallback;
        },
        set: async (key, value, store = 'settings') => {
            game.writes += 1;
            game.storage[`${store}:${key}`] = JSON.parse(JSON.stringify(value));
            return true;
        },
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_${game.currentCharId}`,
    readScoped: async (base, store = 'settings', fallback = null) => {
        const k = `${store}:${base}_${game.currentCharId}`;
        return k in game.storage ? game.storage[k] : fallback;
    },
    writeScoped: async (base, value, store = 'settings') => {
        game.writes += 1;
        game.storage[`${store}:${base}_${game.currentCharId}`] = JSON.parse(JSON.stringify(value));
        return true;
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, className, callback) => {
            game.observers[className] = callback;
            return () => delete game.observers[className];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode }) => game.prices[itemHrid]?.[mode] ?? 0,
    // The planner's token→gold aside prices credits through this
    getItemPriceInfo: (itemHrid, { mode }) => ({
        price: game.prices[itemHrid]?.[mode] ?? 0,
        estimated: false,
    }),
}));
// `tabsContainer` is a mutable hook rather than a fixed `null`: the poll tests
// need to make the marketplace tablist "appear" partway through the handler's
// polling loop, the way a slow marketplace mount does in the real game.
const marketplaceTabs = vi.hoisted(() => ({
    tabsContainer: null,
    createdTabs: [],
    removeShrineCalls: 0,
    navigateToMarketListingsCalls: 0,
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
    createMaterialTab: (mat, referenceTab, onClick) => {
        marketplaceTabs.createdTabs.push(mat);
        const btn = document.createElement('button');
        btn.addEventListener('click', (e) => onClick(e, mat));
        return btn;
    },
    // Mirrors the real control closely enough to exercise the shrine "clear
    // all" wiring: tagged the same way, clicking it fires `onClearAll`.
    createClearAllTabsControl: (referenceTab, onClearAll) => {
        const control = document.createElement('button');
        control.setAttribute('data-mwi-clear-all-tab', 'true');
        control.addEventListener('click', () => onClearAll());
        return control;
    },
    removeMaterialTabs: () => {},
    removeShrineMarketTabs: () => {
        marketplaceTabs.removeShrineCalls += 1;
    },
    navigateToMarketListingsTab: () => {
        marketplaceTabs.navigateToMarketListingsCalls += 1;
    },
    updateTabBadge: () => {},
    visibleTabsContainer: () => marketplaceTabs.tabsContainer,
}));
const autofill = vi.hoisted(() => ({ cleanup: vi.fn(), clearQuantity: vi.fn() }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        setPendingCalculation: () => {},
        clearQuantity: autofill.clearQuantity,
        cleanup: autofill.cleanup,
    }),
}));
// The marketplace hand-off. What matters here is which items the planner sends
// and under what heading, not what the marketplace does when it gets them —
// the shared list has its own tests for that.
const shopping = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../utils/shopping-list.js', () => ({
    openShoppingList: (items, options) => shopping.calls.push({ items, options }),
    clearShoppingList: () => {},
}));
// The Guild Shop's token→credit rates, mocked the way the other guild tests mock
// a sibling module: `game.rates` is what the shop has been seen saying, one entry
// per credit colour, and a colour missing from it is one the player has never
// opened the exchange for.
vi.mock('./guild-token-exchange-capture.js', () => ({
    captureTokenExchangeFromModal: (...args) => game.captures.push(args),
    hydrateCapturedTokenExchanges: async () => ({ ...game.rates }),
    capturedTokenExchanges: () => Object.values(game.rates),
    capturedTokenExchange: (creditItemHrid) => game.rates[creditItemHrid] ?? null,
}));

const creditValueModule = await import('./guild-credit-value.js');
const guildCreditValue = creditValueModule.default;
const {
    shrinePlanRecord,
    greedyAffordable,
    creditShortfallMaterials,
    creditConversionPlan,
    shortCreditName,
    tokensForCredits,
    buyTokenCost,
    planNextBuys,
    DEFAULT_TOKEN_RATES,
    defaultTokenRate,
    tokenRateFor,
    tokensPerCredit,
    chooseCreditPath,
    goldPerTokenFor,
    mergedTokenExchanges,
    tokenConversionPlan,
    applySpendMode,
    SPEND_MODES,
    splitOwedCredits,
    tokenCoveredCredits,
    creditsForTokens,
    capTokenPlanToBudget,
    goldSavedPerToken,
    rankTokenCoverValue,
} = creditValueModule;
const { TRIAL_MAX_TIER, levelFromTier, tierFromLevel } = await import('./guild-trials-math.js');

/**
 * The listeners `guild-credit-value.js` registers at import time, snapshotted
 * before any test has run.
 *
 * The module subscribes to `character_switching` at top level, once, for the
 * whole file. A block that tore its own registrations down with a wholesale
 * `game.listeners = {}` therefore dropped that one too — permanently, since
 * nothing re-imports the module — and every later test that fires the switch
 * handler found an empty registry. Which tests those are depends on the order
 * the blocks run in, so the wipe has to keep what import time put there.
 */
const importTimeListeners = Object.fromEntries(
    Object.entries(game.listeners).map(([event, handlers]) => [event, [...handlers]])
);

/** Drop every listener registered by a test, keeping the import-time ones. */
function resetListeners() {
    game.listeners = Object.fromEntries(
        Object.entries(importTimeListeners).map(([event, handlers]) => [event, [...handlers]])
    );
}

function buildExchangeModal(creditName) {
    document.body.innerHTML = '';
    const modal = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'GuildPanel_header_x';
    header.textContent = creditName;
    modal.appendChild(header);
    const button = document.createElement('button');
    modal.appendChild(button);
    document.body.appendChild(modal);
    return modal;
}

function rowTexts(modal) {
    return Array.from(modal.querySelectorAll(`.mwi-guild-credit-value tbody tr`)).map((tr) => tr.textContent);
}

describe('guild credit value — exchange ranking table', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: false };
        game.observers = {};
        game.prices = {
            '/items/bronze_bar': { ask: 100, bid: 90 },
            '/items/iron_bar': { ask: 300, bid: 280 },
            '/items/steel_bar': { ask: 50, bid: 0 },
        };
        game.clientData = {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
                '/items/iron_bar': {
                    name: 'Iron Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 5, creditCount: 1 }],
                },
                '/items/steel_bar': {
                    name: 'Steel Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 1 }],
                },
            },
        };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    test('ranks by gold-per-credit ascending on the ask side by default', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        // sellGPC: steel 50*1=50, bronze 100*10=1000, iron 300*5=1500
        const texts = rowTexts(modal);
        expect(texts[0]).toContain('Steel Bar');
        expect(texts[1]).toContain('Bronze Bar');
        expect(texts[2]).toContain('Iron Bar');
    });

    test('each row names how many of the item are held, and holds its tongue at zero', () => {
        game.inventory = [
            { itemHrid: '/items/bronze_bar', count: 170000, itemLocationHrid: '/item_locations/inventory' },
        ];
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const texts = rowTexts(modal);
        expect(texts.find((t) => t.includes('Bronze Bar'))).toContain('170.0K');
        // An unheld item's name cell is just the name — no zero, no note
        const ironNameCell = [...modal.querySelectorAll('.mwi-guild-credit-value tbody td:first-child')].find((td) =>
            td.textContent.includes('Iron Bar')
        );
        expect(ironNameCell.querySelector('span')).toBeNull();
    });

    test('the cheapest row is the only one highlighted', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const rows = modal.querySelectorAll('.mwi-guild-credit-value tbody tr');
        expect(rows[0].style.color).toBe('#4ade80');
        expect(rows[1].style.color).not.toBe('#4ade80');
    });

    test('clicking the Bid header re-sorts by buy-side gold-per-credit', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const bidTh = Array.from(modal.querySelectorAll('th')).find((th) => th.textContent === 'Bid/credit');
        bidTh.click();

        // buyGPC: steel has no bid (null, sorts last), bronze 90*10=900, iron 280*5=1400
        const texts = rowTexts(modal);
        expect(texts[0]).toContain('Bronze Bar');
        expect(texts[1]).toContain('Iron Bar');
        expect(texts[2]).toContain('Steel Bar');
    });

    test('an item priced on only one side still appears, with a dash on the unpriced side', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const steelRow = Array.from(modal.querySelectorAll('.mwi-guild-credit-value tbody tr')).find((tr) =>
            tr.textContent.includes('Steel Bar')
        );
        // Bid ea. and Bid/credit columns should render as a dash, not a false zero
        expect(steelRow.textContent).toContain('–');
    });

    test('disabled by setting, no table is rendered', () => {
        game.settings.guildCreditValue = false;
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });

    test('a credit type with no matching header title renders nothing', () => {
        const modal = buildExchangeModal('Some Other Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });

    test('re-rendering (e.g. modal reopened) replaces rather than duplicates the table', () => {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);
        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(modal.querySelectorAll('.mwi-guild-credit-value')).toHaveLength(1);
    });
});

describe('guild credit value — exchange advisor sell/rebuy math', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: true, guildShrineUpgradePlanner: false };
        game.observers = {};
        game.inventory = [];
        game.books = {};
        game.prices = {
            '/items/bronze_bar': { ask: 100, bid: 90 },
            '/items/iron_bar': { ask: 300, bid: 280 },
            '/items/steel_bar': { ask: 50, bid: 0 },
        };
        game.clientData = {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
                '/items/iron_bar': {
                    name: 'Iron Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 5, creditCount: 1 }],
                },
                '/items/steel_bar': {
                    name: 'Steel Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 1 }],
                },
            },
        };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    /**
     * The exchange modal with an item selected on the give side and a typed
     * quantity, the way the advisor reads them: an `ItemSelector_itemContainer`
     * carrying the icon sprite, and a number input beside it.
     */
    function buildAdvisorModal(creditName, { spriteId, quantity }) {
        const modal = buildExchangeModal(creditName);
        const selector = document.createElement('div');
        selector.className = 'ItemSelector_itemContainer_x';
        selector.innerHTML = `<svg aria-label="ignored"><use href="#${spriteId}"></use></svg>`;
        modal.appendChild(selector);
        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(quantity);
        modal.appendChild(input);
        return modal;
    }

    // Steel Bar is the cheapest per credit (50 gold/credit) against Iron Bar's
    // 1500, so selecting Iron Bar always triggers the sell-→-rebuy comparison
    // rather than the "optimal choice" message.

    test('the "You give" field is a raw item count, not a count of whole exchanges', () => {
        // Iron Bar converts 5 → 1 credit. Typing 12 only fills two whole
        // exchanges (10 of the 12), so the direct exchange nets 2 credits —
        // not 12, which is what reading the raw field value as an exchange
        // count would produce.
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 12 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const advisor = modal.querySelector('.mwi-exchange-advisor');
        expect(advisor.textContent).toContain('2 credits');
        expect(advisor.textContent).not.toContain('12 credits');
    });

    test('sell proceeds price what was actually typed, not that amount scaled by the conversion ratio again', () => {
        // Selling all 12 Iron Bar at bid (280) prices 12 × 280 gold before tax —
        // not 12 × 5 × 280, which is what multiplying by itemCount a second
        // time (on top of it already being folded into the raw count) produced.
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 12 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const advisor = modal.querySelector('.mwi-exchange-advisor');
        const gross = 12 * 280;
        const net = gross - Math.floor(gross * MARKET_TAX);
        expect(advisor.textContent).toContain(formatKMB(net));
    });

    test('with no cached book the figures are still the top of book, and say so', () => {
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 12 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const advisor = modal.querySelector('.mwi-exchange-advisor');
        expect(advisor.textContent).toContain('top of book');
    });

    test('a batch bigger than the top bid is priced down the book, not at the best price', () => {
        // 12 Iron Bar against a book that bids 280 for 2 and 200 for the rest.
        // The old top-of-book quote was 12 x 280; the book actually pays
        // 2 x 280 + 10 x 200.
        game.books = {
            '/items/iron_bar': {
                bids: [
                    { price: 280, quantity: 2 },
                    { price: 200, quantity: 50 },
                ],
                asks: [{ price: 300, quantity: 50 }],
            },
            '/items/steel_bar': { asks: [{ price: 50, quantity: 1000 }], bids: [] },
        };
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 12 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const advisor = modal.querySelector('.mwi-exchange-advisor');
        const gross = 2 * 280 + 10 * 200;
        const net = gross - Math.floor(gross * MARKET_TAX);
        expect(advisor.textContent).toContain(formatKMB(net));
        expect(advisor.textContent).toContain('order book depth');
        expect(advisor.textContent).not.toContain(formatKMB(12 * 280 - Math.floor(12 * 280 * MARKET_TAX)));
    });

    test('a book too thin to cover the batch is reported, and the verdict withheld', () => {
        game.books = {
            '/items/iron_bar': { bids: [{ price: 280, quantity: 3 }], asks: [] },
            '/items/steel_bar': { asks: [{ price: 50, quantity: 1000 }], bids: [] },
        };
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 12 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const advisor = modal.querySelector('.mwi-exchange-advisor');
        expect(advisor.textContent).toContain('bids for only 3 of 12 Iron Bar');
        expect(advisor.textContent).toContain('not comparable');
        expect(advisor.textContent).not.toContain('better');
    });

    test('the rebuy count walks the asks rather than dividing by the best ask', () => {
        // Net proceeds buy Steel Bar one-for-one per credit. Only 4 sit at 50;
        // the rest cost 500, so the naive divide-by-best-ask count is far too high.
        game.books = {
            '/items/iron_bar': { bids: [{ price: 280, quantity: 100 }], asks: [] },
            '/items/steel_bar': {
                asks: [
                    { price: 50, quantity: 4 },
                    { price: 500, quantity: 1000 },
                ],
                bids: [],
            },
        };
        const modal = buildAdvisorModal('Trade Credit', { spriteId: 'iron_bar', quantity: 10 });
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const gross = 10 * 280;
        const net = gross - Math.floor(gross * MARKET_TAX);
        const walked = 4 + Math.floor((net - 4 * 50) / 500);
        const advisor = modal.querySelector('.mwi-exchange-advisor');
        expect(advisor.textContent).toContain(`${walked.toLocaleString()} credits`);
        expect(advisor.textContent).not.toContain(`${Math.floor(net / 50).toLocaleString()} credits`);
    });
});

describe('guild credit value — trial tier badge', () => {
    beforeEach(() => {
        game.settings = {};
        game.observers = {};
        game.clientData = { itemDetailMap: {} };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    function buildTileSummary(text) {
        document.body.innerHTML = '';
        const el = document.createElement('div');
        el.textContent = text;
        document.body.appendChild(el);
        return el;
    }

    test('a level below 100 gets no tier badge', () => {
        const el = buildTileSummary('Lv.99');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });

    test('level 100 is tier 1, and every 10 levels advances a tier', () => {
        expect(buildAndReadTier('Lv.100')).toBe('T1');
        expect(buildAndReadTier('Lv.109')).toBe('T1');
        expect(buildAndReadTier('Lv.110')).toBe('T2');
        expect(buildAndReadTier('Lv.150')).toBe('T6');

        function buildAndReadTier(text) {
            const el = buildTileSummary(text);
            game.observers['GuildPanel_tileSummary'](el);
            return el.querySelector('.mwi-trial-tier').textContent;
        }
    });

    test('the top of the ladder is tier 21, and past the level cap the badge says so', () => {
        // Tiers start at 100 and step 10 to a maximum level of 300, which is 21
        // tiers — the same ladder `guild-trials-math.js` encodes, and not the 20
        // this badge used to cap at.
        //
        // T21 is the last tier there is, so the cap is the top of the ladder
        // rather than a floor under an open-ended one — no `+`.
        expect(buildAndReadTier('Lv.300')).toBe('T21');
        expect(buildAndReadTier('Lv.500')).toBe('T21');

        function buildAndReadTier(text) {
            const el = buildTileSummary(text);
            game.observers['GuildPanel_tileSummary'](el);
            return el.querySelector('.mwi-trial-tier').textContent;
        }
    });

    test('the badge and the math agree on every tier of the ladder, both ways', () => {
        for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
            const level = levelFromTier(tier);
            expect(tierFromLevel(level)).toBe(tier);

            const el = buildTileSummary(`Lv.${level}`);
            game.observers['GuildPanel_tileSummary'](el);
            expect(el.querySelector('.mwi-trial-tier').textContent).toBe(`T${tier}`);
        }

        // One past the top is still the top, not a 22nd tier
        expect(levelFromTier(TRIAL_MAX_TIER + 1)).toBeNull();
        expect(tierFromLevel(310)).toBe(TRIAL_MAX_TIER);
    });

    test('a tile is only ever tagged once', () => {
        const el = buildTileSummary('Lv.150');
        game.observers['GuildPanel_tileSummary'](el);
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelectorAll('.mwi-trial-tier')).toHaveLength(1);
    });

    test('a redraw that wipes the badge gets it back, and never twice', () => {
        // React reuses the level line and replaces its children. The old guard
        // was a `data-` flag on that element, which survived the wipe — so the
        // badge vanished on the first card update and never returned, which is
        // exactly what the maintainer's "Lv.260" with no tier on it was.
        const el = buildTileSummary('Lv.260');
        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe('T17');

        el.textContent = 'Lv.260';
        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelectorAll('.mwi-trial-tier')).toHaveLength(1);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe('T17');
    });

    test('a banked count above the ladder is held at the top tier', () => {
        // Past the level cap the level is no longer the better number, and the
        // trials feature publishes the banked count on the card for this — but
        // there are only 21 tiers, so a count above that is a miscount and must
        // not reach a card as a tier the game cannot fight
        const owner = document.createElement('div');
        owner.dataset.mwiTrialBanked = '24';
        const el = document.createElement('div');
        el.textContent = 'Lv.300';
        owner.appendChild(el);
        document.body.appendChild(owner);

        game.observers['GuildPanel_tileSummary'](el);
        expect(el.querySelector('.mwi-trial-tier').textContent).toBe(`T${TRIAL_MAX_TIER}`);
    });

    test('text with no level marker is left alone', () => {
        const el = buildTileSummary('No level here');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });

    test("a building tile's level (max 20, well under the trial floor of 100) never gets a tier badge", () => {
        // Buildings tab format: "Lv. 10 / 20" — below TRIAL_START_LEVEL, so
        // tierFromLevel() returns null and no badge is injected. This is the
        // level range GUILD_BUILDING_MAX_LEVEL covers; it must never be treated
        // as a trial level.
        const el = buildTileSummary('Lv.20');
        game.observers['GuildPanel_tileSummary'](el);

        expect(el.querySelector('.mwi-trial-tier')).toBeNull();
    });
});

describe('guild credit value — shrine upgrade planner building cap', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: true };
        game.observers = {};
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 } };
        game.buildingLevels = {};
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    function buildBuffClientData(levelCostsMaxLevel) {
        return {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
            guildBuffDetailMap: {
                '/guild_buffs/force_combat': {
                    shrineHrid: '/guild_shrines/force',
                    isCombat: true,
                    levelCosts: Object.fromEntries(
                        Array.from({ length: levelCostsMaxLevel }, (_, i) => [String(i + 1), {}])
                    ),
                },
            },
        };
    }

    test('the target-level input caps at 20 even when levelCosts data claims more', () => {
        game.clientData = buildBuffClientData(25);

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });

    test("the target-level input caps at 20 even when the shrine's own level claims more", () => {
        game.clientData = buildBuffClientData(20);
        game.buildingLevels = { '/guild_shrines/force': 25 };

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });

    test('level 20 itself is a valid target — the cap excludes nothing in range', () => {
        game.clientData = buildBuffClientData(20);
        game.buildingLevels = { '/guild_shrines/force': 20 };

        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);

        const input = modal.querySelector('.mwi-shrine-planner input[type="number"]');
        expect(Number(input.max)).toBe(20);
    });
});

describe('reading the token exchange off the dialog', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: false };
        game.observers = {};
        game.captures = [];
        game.prices = {};
        game.clientData = {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                '/items/guild_token': { name: 'Guild Token' },
            },
        };
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    test('an open exchange dialog is handed to the capture, credit and selection named', () => {
        const modal = buildExchangeModal('Trade Credit');
        const selector = document.createElement('div');
        selector.className = 'ItemSelector_itemContainer_x';
        selector.innerHTML = '<svg aria-label="Guild Token"></svg>';
        modal.appendChild(selector);

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(game.captures[0][1]).toEqual({
            creditItemHrid: '/items/guild_credit_1',
            creditName: 'Trade Credit',
            selectedItemHrid: null,
            selectedItemName: 'Guild Token',
            tokenHrid: '/items/guild_token',
            tokenName: 'Guild Token',
        });
    });

    test('a selection carrying its icon sprite hands the capture the hrid, whatever the label says', () => {
        const modal = buildExchangeModal('Trade Credit');
        const selector = document.createElement('div');
        selector.className = 'ItemSelector_itemContainer_x';
        // A French client: translated label, same sprite
        selector.innerHTML =
            '<svg aria-label="Jeton de guilde"><use href="/static/media/items_sprite.abc.svg#guild_token"></use></svg>';
        modal.appendChild(selector);

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(game.captures[0][1]).toMatchObject({
            selectedItemHrid: '/items/guild_token',
            selectedItemName: 'Jeton de guilde',
        });
    });

    test('a dialog whose header names no credit is not offered to the capture', () => {
        const modal = buildExchangeModal('Some Other Modal');

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toEqual([]);
    });

    test('the capture runs even with the credit table switched off', () => {
        game.settings.guildCreditValue = false;
        const modal = buildExchangeModal('Trade Credit');

        game.observers['GuildPanel_exchangeModalContent'](modal);

        expect(game.captures).toHaveLength(1);
        expect(modal.querySelector('.mwi-guild-credit-value')).toBeNull();
    });
});

describe('shrine upgrade planner — saved plan and next-buy suggestions', () => {
    const FORCE = '/guild_buffs/force_combat';
    const TEMPO = '/guild_buffs/tempo_skilling';
    const RARITY = '/guild_buffs/rarity_combat';

    /** levelCosts for levels 1..max, with `at` overriding named levels */
    function costs(max, at = {}) {
        const out = {};
        for (let lvl = 1; lvl <= max; lvl++) out[String(lvl)] = at[lvl] || { guildTokenCost: 1000, creditCosts: [] };
        return out;
    }

    function planClientData() {
        return {
            itemDetailMap: {
                '/items/guild_credit_1': { name: 'Trade Credit', guildCreditConversions: [] },
                // Nothing on the market converts into this one — the planner's
                // "no conversion" case
                '/items/guild_credit_2': { name: 'Craft Credit', guildCreditConversions: [] },
                '/items/guild_token': { name: 'Guild Token', guildCreditConversions: [] },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
                // The cheaper route to the same credit: 150 gold per credit
                // against the bronze bar's 1000
                '/items/iron_bar': {
                    name: 'Iron Bar',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 5, creditCount: 1 }],
                },
            },
            guildBuffDetailMap: {
                [FORCE]: {
                    shrineHrid: '/guild_shrines/force',
                    isCombat: true,
                    levelCosts: costs(10, {
                        3: { guildTokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] },
                        4: { guildTokenCost: 400, creditCosts: [{ itemHrid: '/items/guild_credit_2', count: 7 }] },
                        5: { guildTokenCost: 500, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] },
                    }),
                },
                [TEMPO]: {
                    shrineHrid: '/guild_shrines/tempo',
                    isCombat: false,
                    levelCosts: costs(10, { 1: { guildTokenCost: 100, creditCosts: [] } }),
                },
                [RARITY]: {
                    shrineHrid: '/guild_shrines/rarity',
                    isCombat: true,
                    levelCosts: costs(10),
                },
            },
        };
    }

    /** Open the exchange modal and return it, planner drawn */
    function openModal() {
        const modal = buildExchangeModal('Trade Credit');
        game.observers['GuildPanel_exchangeModalContent'](modal);
        return modal;
    }

    function inputFor(modal, buffHrid) {
        return modal.querySelector(`.mwi-shrine-planner input[data-buff-hrid="${buffHrid}"]`);
    }

    function nextBuyRows(modal) {
        return Array.from(modal.querySelectorAll('.mwi-shrine-next-buy'));
    }

    /** Close the modal and forget the in-memory plan, as a page reload would */
    async function reopenFromStorage() {
        document.body.innerHTML = '';
        shrinePlanRecord.reset();
        await shrinePlanRecord.load();
        return openModal();
    }

    beforeEach(() => {
        vi.useFakeTimers();
        game.settings = { guildCreditValue: true, guildCreditExchangeAdvisor: false, guildShrineUpgradePlanner: true };
        game.observers = {};
        game.prices = { '/items/bronze_bar': { ask: 100, bid: 90 }, '/items/iron_bar': { ask: 30, bid: 25 } };
        shopping.calls = [];
        // Force and Tempo shrines have room; Rarity's cap equals its current
        // buff level, so that buff has no next level to suggest.
        game.buildingLevels = {
            '/guild_shrines/force': 10,
            '/guild_shrines/tempo': 10,
            '/guild_shrines/rarity': 5,
        };
        game.buffLevels = { [FORCE]: 2, [TEMPO]: 0, [RARITY]: 5 };
        game.inventory = [];
        // No colour's exchange has been opened yet — the honest default
        game.rates = {};
        game.storage = {};
        game.clientData = planClientData();
        shrinePlanRecord.reset();
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
        // After the teardown, which flushes any save the previous test left pending
        game.writes = 0;
    });

    afterEach(async () => {
        // A test that types into an input and stops leaves 400 ms of debounce
        // on the clock. `cleanup()` flushes it, but the write it starts is a
        // promise: unawaited, it settles inside the NEXT test — where it counts
        // as that test's write and puts this test's plan under its key. Awaited
        // here, while this test's storage is still the one it belongs in.
        guildCreditValue.cleanup();
        await shrinePlanRecord.flushed();
        vi.useRealTimers();
        shrinePlanRecord.reset();
        game.storage = {};
        game.buffLevels = {};
        game.inventory = [];
        game.rates = {};
    });

    test('a typed target survives closing and reopening the modal', async () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);
        input.value = '7';
        input.dispatchEvent(new Event('input'));

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();

        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [FORCE]: 7 });

        const reopened = await reopenFromStorage();
        expect(inputFor(reopened, FORCE).value).toBe('7');
        // Untouched buffs still sit at their current level
        expect(inputFor(reopened, TEMPO).value).toBe('0');
    });

    test('a target at or below the current level is pruned, not restored', async () => {
        game.storage['settings:guildShrinePlan_char1'] = {
            targets: { [FORCE]: 2, [TEMPO]: 4 },
            collapsed: true,
        };

        const modal = await reopenFromStorage();
        // FORCE is already level 2 — a no-op target, so the input keeps its default
        expect(inputFor(modal, FORCE).value).toBe('2');
        expect(inputFor(modal, TEMPO).value).toBe('4');

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [TEMPO]: 4 });
    });

    test('a saved target above the current cap is clamped to it', async () => {
        game.storage['settings:guildShrinePlan_char1'] = { targets: { [TEMPO]: 99 }, collapsed: true };

        const modal = await reopenFromStorage();
        const input = inputFor(modal, TEMPO);
        expect(input.value).toBe(input.max);

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].targets[TEMPO]).toBe(Number(input.max));
    });

    test('the expanded/collapsed state of the planner body persists', async () => {
        const modal = openModal();
        const body = modal.querySelector('.mwi-shrine-planner > div:nth-child(2)');
        expect(body.style.display).toBe('none');

        modal.querySelector('.mwi-shrine-planner > div').click();
        expect(body.style.display).toBe('block');

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1'].collapsed).toBe(false);

        const reopened = await reopenFromStorage();
        expect(reopened.querySelector('.mwi-shrine-planner > div:nth-child(2)').style.display).toBe('block');
    });

    test('writes are debounced — a burst of keystrokes lands as one save', async () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);

        for (const keystroke of ['1', '12', '5']) {
            input.value = keystroke;
            input.dispatchEvent(new Event('input'));
            vi.advanceTimersByTime(100);
        }
        await shrinePlanRecord.flushed();
        expect(game.writes).toBe(0);

        vi.advanceTimersByTime(400);
        await shrinePlanRecord.flushed();
        expect(game.writes).toBe(1);
        expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [FORCE]: 5 });
    });

    test('a plan edited moments before a character switch is written under the departing character', async () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);
        input.value = '7';
        input.dispatchEvent(new Event('input'));

        // Most of the 400 ms debounce is still to run: nothing is stored yet,
        // and the timer is all that is holding the edit.
        vi.advanceTimersByTime(100);
        await shrinePlanRecord.flushed();
        expect(game.storage['settings:guildShrinePlan_char1']).toBeUndefined();

        try {
            // The switch. Data-manager awaits every `character_switching`
            // listener before it moves `currentCharacterId`, which is exactly
            // the window a pending write has to land under the character who
            // made the edit. The module-level listener used to `reset()` the
            // record here and be done — the edit went out with the timer.
            await Promise.all(game.listeners['character_switching'].map((fn) => fn()));

            game.currentCharId = 'char2';
            expect(game.storage['settings:guildShrinePlan_char1'].targets).toEqual({ [FORCE]: 7 });
            expect(game.storage['settings:guildShrinePlan_char2']).toBeUndefined();
            // And the reset still happened: the arriving character must not
            // inherit this plan through the curated record's pre-load merge.
            expect(shrinePlanRecord.get()).toEqual({});
        } finally {
            game.currentCharId = 'char1';
        }
    });

    test('next buys list every unlocked buff, cheapest guild-token cost first', () => {
        const modal = openModal();
        const rows = nextBuyRows(modal).map((r) => r.textContent.replace(/\s+/g, ' ').trim());

        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('Tempo · Skilling');
        expect(rows[0]).toContain('100 tok');
        expect(rows[1]).toContain('Force · Combat');
        expect(rows[1]).toContain('300 tok');
    });

    test('a buff already at its shrine cap has no next level to suggest', () => {
        const modal = openModal();
        const text = nextBuyRows(modal)
            .map((r) => r.textContent)
            .join(' ');
        expect(text).not.toContain('Rarity');
    });

    test('a suggested buy shows its credit cost, shortened, with the full name in a tooltip', () => {
        const modal = openModal();
        const forceRow = nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        const credits = forceRow.querySelector('.mwi-shrine-next-buy-credits');

        expect(credits.textContent.replace(/\s+/g, ' ')).toBe('+ 50 Trade');
        expect(credits.title).toBe('50 Trade Credit');
    });

    test('affordability marking follows the held guild-token balance', () => {
        game.inventory = [
            { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 150 },
        ];
        const modal = openModal();
        const rows = nextBuyRows(modal);

        expect(modal.querySelector('.mwi-shrine-next-buys').textContent).toContain('Guild Token: 150');
        expect(rows[0].dataset.affordable).toBe('yes'); // 100 tokens
        expect(rows[1].dataset.affordable).toBe('no'); // 300 tokens
    });

    test('tokens held outside the inventory do not count toward the balance', () => {
        game.inventory = [{ itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/bank', count: 500 }];
        const modal = openModal();

        expect(modal.querySelector('.mwi-shrine-next-buys').textContent).toContain('Guild Token: 0');
        expect(nextBuyRows(modal)[0].dataset.affordable).toBe('no');
    });

    test('the spend-everything walk totals what the balance actually covers', () => {
        game.inventory = [
            { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
        ];
        const modal = openModal();

        // The Force level's 50 Trade Credit is bought on the market — that colour
        // has no token rate at all — so the walk says both halves of the bill
        expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
            'Spending everything now: 2 of 2 next levels for 400 tokens plus ≈7.5K gold of mats'
        );
    });

    test('the walk says so when nothing on the list is affordable', () => {
        const modal = openModal();
        expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toContain(
            'Nothing on this list is affordable'
        );
    });

    test('greedyAffordable stops at the first buy the balance cannot cover', () => {
        const options = [{ tokenCost: 100 }, { tokenCost: 300 }, { tokenCost: 500 }];
        expect(greedyAffordable(options, 0)).toEqual({ count: 0, spent: 0 });
        expect(greedyAffordable(options, 399)).toEqual({ count: 1, spent: 100 });
        expect(greedyAffordable(options, 400)).toEqual({ count: 2, spent: 400 });
        expect(greedyAffordable(options, 10_000)).toEqual({ count: 3, spent: 900 });
    });

    test('the existing total-cost calculator still answers the goal question', () => {
        const modal = openModal();
        const input = inputFor(modal, FORCE);
        input.value = '3';
        input.dispatchEvent(new Event('input'));

        const totals = modal.querySelector('.mwi-shrine-planner').textContent;
        // The heading follows the arithmetic: the figures below it are net of
        // what is held, so it no longer claims to be a gross "total cost"
        expect(totals).toContain('Still needed for these targets');
        expect(totals).toContain('300');
    });

    /** Set a target level and let the planner recalculate */
    function setTarget(modal, buffHrid, level) {
        const input = inputFor(modal, buffHrid);
        input.value = String(level);
        input.dispatchEvent(new Event('input'));
    }

    function matsButton(modal) {
        return modal.querySelector('.mwi-shrine-plan-mats-btn');
    }

    describe('missing mats hand-off', () => {
        test('the totals net against credits already held, and say how many those are', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 20 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            const totals = modal.querySelector('.mwi-shrine-planner').textContent.replace(/\s+/g, ' ');
            // 50 owed, 20 held
            expect(totals).toContain('Trade Credit');
            expect(totals).toContain('30');
            expect(totals).toContain('(own 20)');
        });

        test('the shopping list buys the cheapest conversion into each credit', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            // Iron at 150 gold/credit beats bronze at 1000: 50 credits at
            // 1 credit per 5 bars is 250 bars
            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 250 }]);
            expect(shopping.calls[0].options).toEqual({ heading: 'Shrine plan' });
        });

        test('a part-filled conversion still costs a whole one', () => {
            // The `_renderShrine` precedent's arithmetic, with no round number to
            // hide behind: 10 credits bought 4 at a time is three trades of 3 bars
            const conversions = {
                '/items/guild_credit_1': [{ hrid: '/items/iron_bar', name: 'Iron Bar', itemCount: 3, creditCount: 4 }],
            };
            expect(creditShortfallMaterials({ '/items/guild_credit_1': 10 }, conversions, [])).toEqual([
                { itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 9 },
            ]);
        });

        test('raw material already in the inventory comes off the shopping list', () => {
            game.inventory = [
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 50 }]);
        });

        test('bars held outside the inventory are not counted as held', () => {
            game.inventory = [{ itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/bank', count: 500 }];
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();

            expect(shopping.calls[0].items[0].count).toBe(250);
        });

        test('a credit nothing converts into is left off the list rather than throwing', () => {
            const modal = openModal();
            // Level 4 costs Craft Credit, which has no conversion at all
            expect(() => setTarget(modal, FORCE, 4)).not.toThrow();

            // Still owed, and still shown in the totals — it just has nothing to buy
            expect(modal.querySelector('.mwi-shrine-planner').textContent).toContain('Craft Credit');
            matsButton(modal).click();
            expect(shopping.calls[0].items.map((i) => i.itemHrid)).toEqual(['/items/iron_bar']);
        });

        test('there is no button when the plan owes no credits at all', () => {
            const modal = openModal();
            // Tempo's next levels cost tokens only
            setTarget(modal, TEMPO, 3);

            expect(matsButton(modal)).toBeNull();
        });

        test('there is no button when every needed credit is already held', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(matsButton(modal)).toBeNull();
            // The tokens are still owed, so the box is not empty — but nothing
            // in it is a credit, and nothing a credit converts from is on the
            // market for the button to offer
            expect(modal.querySelector('.mwi-shrine-planner').textContent).not.toContain('Trade Credit50');
        });

        test('a plan with nothing left to pay says so instead of showing an empty box', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(matsButton(modal)).toBeNull();
            expect(modal.querySelector('.mwi-shrine-planner').textContent).toContain(
                'Everything these targets cost is already held'
            );
        });

        test('changing the target level rebuilds the list', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();
            expect(shopping.calls[0].items[0].count).toBe(250);

            // Level 5 costs another 50 credits on top
            setTarget(modal, FORCE, 5);
            matsButton(modal).click();
            expect(shopping.calls).toHaveLength(2);
            expect(shopping.calls[1].items[0].count).toBe(500);

            // And back below the current level, where there is nothing to plan
            setTarget(modal, FORCE, 2);
            expect(matsButton(modal)).toBeNull();
        });
    });

    describe('the suggestions section folds', () => {
        const suggestHeading = (modal) => modal.querySelector('.mwi-shrine-suggest-heading');
        const suggestBody = (modal) => modal.querySelector('.mwi-shrine-suggest-body');

        test('clicking the heading folds the whole block and remembers it', async () => {
            const modal = openModal();
            expect(suggestBody(modal).style.display).toBe('block');

            suggestHeading(modal).click();
            expect(suggestBody(modal).style.display).toBe('none');
            expect(suggestHeading(modal).textContent).toContain('▶');
            expect(shrinePlanRecord.get().suggestionsCollapsed).toBe(true);

            // A fresh render honours the remembered fold
            const reopened = openModal();
            expect(suggestBody(reopened).style.display).toBe('none');
        });

        test('unfolding is remembered the same way', () => {
            shrinePlanRecord.get().suggestionsCollapsed = true;
            const modal = openModal();
            expect(suggestBody(modal).style.display).toBe('none');

            suggestHeading(modal).click();
            expect(suggestBody(modal).style.display).toBe('block');
            expect(shrinePlanRecord.get().suggestionsCollapsed).toBe(false);
        });
    });

    describe('suggestion row layout', () => {
        function forceRow(modal) {
            return nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        }

        test('the label is a single unwrapping line carrying shrine, buff and levels', () => {
            const modal = openModal();
            const label = forceRow(modal).querySelector('.mwi-shrine-next-buy-label');

            expect(label.textContent).toBe('Force · Combat · 2→3');
            expect(label.textContent).not.toContain('\n');
            expect(label.style.whiteSpace).toBe('nowrap');
            // Clipped rather than stacked: a name too long for the row loses its
            // tail, it does not become a column
            expect(label.style.textOverflow).toBe('ellipsis');
            expect(label.style.overflow).toBe('hidden');
        });

        test('the credit list wraps onto continuation lines instead of running off the row', () => {
            const modal = openModal();
            const credits = forceRow(modal).querySelector('.mwi-shrine-next-buy-credits');

            expect(credits.style.whiteSpace).toBe('normal');
            expect(credits.style.whiteSpace).not.toBe('nowrap');
            expect(credits.style.overflowWrap).toBe('anywhere');
            // A whole line of its own inside the wrapping row
            expect(credits.style.flexBasis).toBe('100%');
            expect(credits.style.minWidth).toBe('0');
        });

        test('the row itself wraps and is bounded by the modal width', () => {
            const modal = openModal();
            const row = forceRow(modal);

            expect(row.style.flexWrap).toBe('wrap');
            expect(row.style.maxWidth).toBe('100%');
            expect(row.style.boxSizing).toBe('border-box');
        });

        test('the token figure stays on one line', () => {
            const modal = openModal();
            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').style.whiteSpace).toBe('nowrap');
        });

        test('the planner body scrolls vertically only', () => {
            const modal = openModal();
            const body = modal.querySelector('.mwi-shrine-planner > div:nth-child(2)');

            expect(body.style.overflowY).toBe('auto');
            expect(body.style.overflowX).toBe('hidden');
            expect(modal.querySelector('.mwi-shrine-planner').style.maxWidth).toBe('100%');
        });

        test('shortCreditName keeps the colour and drops the boilerplate', () => {
            expect(shortCreditName('Blue Guild Credit')).toBe('Blue');
            expect(shortCreditName('Trade Credit')).toBe('Trade');
            expect(shortCreditName('Guild Credit')).toBe('Guild Credit');
            expect(shortCreditName('')).toBe('');
        });
    });

    describe('suggested buys → marketplace → conversion', () => {
        function flowButton(modal) {
            return modal.querySelector('.mwi-shrine-next-buy-mats-btn');
        }

        function convertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-convert-step')).map((el) => el.textContent);
        }

        test('the hand-off is scoped to the affordable buys, not the whole list', () => {
            // 150 tokens covers Tempo (100, no credits) and nothing else, so the
            // Force level's 50 Trade Credit is not a bill to go shopping for yet
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 150 },
            ];
            const modal = openModal();

            expect(nextBuyRows(modal)[1].dataset.affordable).toBe('no');
            expect(flowButton(modal)).toBeNull();
            expect(convertSteps(modal)).toEqual([]);
        });

        test('the affordable buys’ credit shortfall becomes a marketplace list', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
            ];
            const modal = openModal();
            flowButton(modal).click();

            // 50 Trade Credit through the cheaper iron bar: 5 bars per credit
            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 250 }]);
            expect(shopping.calls[0].options).toEqual({ heading: 'Next buys' });
        });

        test('the convert plan names the same option and quantity the shortfall used', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
            ];
            const modal = openModal();

            expect(convertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
            const line = modal.querySelector('.mwi-shrine-convert-step');
            expect(line.dataset.creditHrid).toBe('/items/guild_credit_1');
            expect(line.title).toContain('50 Trade Credit');
        });

        test('the conversion is the whole trade even where the bars are already held', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            const modal = openModal();
            flowButton(modal).click();

            // 50 bars left to buy, but all 250 still go over the counter
            expect(shopping.calls[0].items[0].count).toBe(50);
            expect(convertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
        });

        test('nothing is drawn when the affordable buys are short of no credits', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 450 },
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            const modal = openModal();

            expect(flowButton(modal)).toBeNull();
            expect(convertSteps(modal)).toEqual([]);
        });

        test('creditConversionPlan rounds a part-filled trade up to a whole one', () => {
            const conversions = {
                '/items/guild_credit_1': [{ hrid: '/items/iron_bar', name: 'Iron Bar', itemCount: 3, creditCount: 4 }],
            };
            expect(
                creditConversionPlan({ '/items/guild_credit_1': 10 }, conversions, {
                    '/items/guild_credit_1': { name: 'Trade Credit' },
                })
            ).toEqual([
                {
                    creditItemHrid: '/items/guild_credit_1',
                    creditName: 'Trade Credit',
                    itemHrid: '/items/iron_bar',
                    itemName: 'Iron Bar',
                    itemCount: 9,
                    creditCount: 12,
                    owed: 10,
                },
            ]);
        });

        test('a credit nothing converts into contributes no step', () => {
            expect(creditConversionPlan({ '/items/guild_credit_2': 7 }, {}, {})).toEqual([]);
        });
    });

    describe('token → credit conversion awareness', () => {
        /** The Guild Shop seen exchanging `tokens` for `credits` of Trade Credit */
        function seeRate(tokens, credits, extra = {}) {
            game.rates['/items/guild_credit_1'] = {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: credits / tokens,
                tokensPerExchange: tokens,
                creditsPerExchange: credits,
                via: 'arrow',
                capturedAt: Date.UTC(2026, 0, 1),
                ...extra,
            };
        }

        function forceRow(modal) {
            return nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
        }

        test('tokensForCredits rounds up to whole exchanges', () => {
            const batched = { creditsPerToken: 10 / 3, tokensPerExchange: 3, creditsPerExchange: 10 };
            expect(tokensForCredits(10, batched)).toBe(3);
            expect(tokensForCredits(11, batched)).toBe(6);
            expect(tokensForCredits(25, batched)).toBe(9);
            expect(tokensForCredits(0, batched)).toBe(0);

            // A reading that only kept the ratio is the same rule at a batch of one
            expect(tokensForCredits(10, { creditsPerToken: 4 })).toBe(3);
            // Never guessed
            expect(tokensForCredits(10, null)).toBeNull();
        });

        test('buyTokenCost adds the conversion top-up and nets what is held', () => {
            const buy = { tokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 50 }] };
            const rate = { creditsPerToken: 10, tokensPerExchange: 1, creditsPerExchange: 10 };
            const rateFor = () => rate;

            expect(buyTokenCost(buy, {}, rateFor).effective).toBe(305);
            expect(buyTokenCost(buy, { '/items/guild_credit_1': 20 }, rateFor).effective).toBe(303);
            expect(buyTokenCost(buy, { '/items/guild_credit_1': 50 }, rateFor)).toMatchObject({
                effective: 300,
                conversionTokens: 0,
                conversions: [],
                unknown: [],
            });
        });

        test('an unseen colour is excluded from the sum and reported instead', () => {
            const buy = { tokenCost: 300, creditCosts: [{ itemHrid: '/items/guild_credit_2', count: 7 }] };
            const cost = buyTokenCost(buy, {}, () => null);

            expect(cost.effective).toBe(300);
            expect(cost.conversionTokens).toBe(0);
            expect(cost.unknown).toEqual([{ itemHrid: '/items/guild_credit_2', gap: 7 }]);
        });

        test('the row says how the missing credits would be covered', () => {
            seeRate(1, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 405 },
            ];
            const modal = openModal();
            const row = forceRow(modal);

            expect(row.querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('305 tok');
            expect(row.querySelector('.mwi-shrine-next-buy-convert').textContent).toBe('convert 5 tok → 50 Trade');
            expect(row.dataset.affordable).toBe('yes');
        });

        test('a known rate makes the true cost the one affordability is judged on', () => {
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 404 },
            ];
            // Without a rate, 404 covers 100 + 300
            expect(nextBuyRows(openModal())[1].dataset.affordable).toBe('yes');

            // With one, the Force level really costs 305 and 404 no longer covers both
            seeRate(1, 10);
            expect(nextBuyRows(openModal())[1].dataset.affordable).toBe('no');
        });

        test('tokensPerExchange granularity is respected on the row', () => {
            // 3 tokens buy 10 credits, so 50 credits is five whole exchanges
            seeRate(3, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();

            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('315 tok');
        });

        test('ordering follows the effective cost, not the sticker price', () => {
            game.clientData.guildBuffDetailMap[TEMPO].levelCosts['1'] = { guildTokenCost: 302, creditCosts: [] };

            // Sticker price alone puts Force (300) ahead of Tempo (302)
            expect(nextBuyRows(openModal())[0].textContent).toContain('Force');

            // The 50 Trade Credit it is short of costs 5 more tokens, so it is not
            // the cheaper of the two after all
            seeRate(1, 10);
            expect(nextBuyRows(openModal())[0].textContent).toContain('Tempo');
        });

        test('the spend-everything walk counts the conversion tokens it spent', () => {
            seeRate(3, 10);
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();

            expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
                'Spending everything now: 2 of 2 next levels for 415 tokens, 15 of them converted into credits'
            );
        });

        test('planNextBuys will not let two buys spend the same credits twice', () => {
            const rate = { creditsPerToken: 10, tokensPerExchange: 1, creditsPerExchange: 10 };
            const buys = [
                { label: 'A', tokenCost: 10, creditCosts: [{ itemHrid: '/c', count: 50 }] },
                { label: 'B', tokenCost: 10, creditCosts: [{ itemHrid: '/c', count: 50 }] },
            ];
            const plan = planNextBuys(buys, {
                tokenBalance: 1000,
                creditBalances: { '/c': 50 },
                rateFor: () => rate,
            });

            // The first takes the 50 held; the second buys its own with tokens
            expect(plan.count).toBe(2);
            expect(plan.spent).toBe(25);
            expect(plan.conversionSpent).toBe(5);
            // The default path is the token one, so the shortfall is owed to the
            // guild shop rather than to the marketplace
            expect(plan.owedTokenCredits).toEqual({ '/c': 50 });
            expect(plan.owedCredits).toEqual({});
        });

        test('a colour with neither a rate nor a market price is named on the row rather than priced', () => {
            // Level 4 costs Craft Credit: no colour in the standard table names
            // it, no exchange has been seen for it, and nothing on the market
            // converts into it
            game.buffLevels[FORCE] = 3;
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            const note = forceRow(modal).querySelector('.mwi-shrine-next-buy-convert');

            expect(note.textContent).toBe(
                'Craft: rate not seen yet — select Guild Token in this exchange once to record it'
            );
            expect(note.title).toContain('Guild Token');
            // And nothing was added to the cost on the strength of not knowing
            expect(forceRow(modal).querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        test('a converted figure is never presented as exact', () => {
            seeRate(1, 10, { via: 'tiles', capturedAt: 0 });
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 5000 },
            ];
            const modal = openModal();
            const note = forceRow(modal).querySelector('.mwi-shrine-next-buy-convert');

            expect(note.title).toContain('Approximate');
            expect(note.title).toContain('item tiles');
            expect(note.title).toContain('capture time unknown');
        });

        describe('the still-needed box', () => {
            function convertNote(modal, creditHrid) {
                return modal.querySelector(`.mwi-shrine-credit-convert[data-credit-hrid="${creditHrid}"]`);
            }

            test('a credit row says what converting it would cost in spare tokens', () => {
                seeRate(1, 10);
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1000 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                const note = convertNote(modal, '/items/guild_credit_1');
                expect(note.textContent).toBe('or convert ≈5 tokens');
                expect(note.title).toContain('Approximate');
            });

            test('no annotation when the spare tokens do not cover it', () => {
                seeRate(1, 1);
                // 300 of the 320 tokens are already owed to the level itself, and
                // 50 credits at one per token is more than the 20 left over
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 320 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                expect(convertNote(modal, '/items/guild_credit_1')).toBeNull();
            });

            test('an unseen colour says so instead of a converted figure', () => {
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1000 },
                ];
                const modal = openModal();
                setTarget(modal, FORCE, 3);

                const note = convertNote(modal, '/items/guild_credit_1');
                expect(note.textContent).toBe('Trade: token rate not seen yet');
                expect(note.title).toContain('Guild Token');
            });
        });
    });

    describe('the standard token→credit rates', () => {
        /** Colour → [tokens handed over, credits received], as the exchange dialog states it */
        const STATED = {
            green: [1, 10],
            brown: [1, 10],
            white: [1, 10],
            blue: [1, 10],
            purple: [1, 1],
            red: [1, 1],
            silver: [10, 1],
            gold: [60, 1],
        };

        test('all eight colours resolve, at the rate the game charges', () => {
            expect(Object.keys(DEFAULT_TOKEN_RATES).sort()).toEqual(Object.keys(STATED).sort());

            for (const [colour, [tokens, credits]] of Object.entries(STATED)) {
                const rate = tokenRateFor(`/items/${colour}_guild_credit`);
                expect(rate).toMatchObject({
                    tokensPerExchange: tokens,
                    creditsPerExchange: credits,
                    source: 'default',
                });
                expect(tokensPerCredit(rate)).toBeCloseTo(tokens / credits, 10);
                // One whole exchange is the smallest purchase there is
                expect(tokensForCredits(1, rate)).toBe(tokens);
            }
        });

        test('the asymmetry is the point: a blue credit is a tenth of a token, a gold one sixty', () => {
            expect(tokensPerCredit(defaultTokenRate('/items/blue_guild_credit'))).toBeCloseTo(0.1, 10);
            expect(tokensPerCredit(defaultTokenRate('/items/gold_guild_credit'))).toBe(60);
        });

        test('a colour the table does not name has no rate at all', () => {
            expect(defaultTokenRate('/items/guild_credit_1')).toBeNull();
            expect(defaultTokenRate('/items/octarine_guild_credit')).toBeNull();
            expect(defaultTokenRate('')).toBeNull();
            expect(tokenRateFor('/items/guild_credit_1')).toBeNull();
        });

        test('a captured reading overrides the standard rate, for its own colour only', () => {
            game.rates['/items/gold_guild_credit'] = {
                creditItemHrid: '/items/gold_guild_credit',
                creditsPerToken: 1,
                tokensPerExchange: 1,
                creditsPerExchange: 1,
                via: 'arrow',
                capturedAt: Date.UTC(2026, 0, 1),
            };

            // The shop was seen rebalancing gold credits; an observation beats a constant
            expect(tokenRateFor('/items/gold_guild_credit')).toMatchObject({
                source: 'captured',
                tokensPerExchange: 1,
                creditsPerExchange: 1,
            });
            // And says nothing about any other colour
            expect(tokenRateFor('/items/green_guild_credit')).toMatchObject({
                source: 'default',
                creditsPerExchange: 10,
            });
        });

        test('the merged exchange list is captures first, defaults for every gap', () => {
            game.rates['/items/green_guild_credit'] = {
                creditItemHrid: '/items/green_guild_credit',
                creditsPerToken: 4,
                tokensPerExchange: 1,
                creditsPerExchange: 4,
                via: 'arrow',
            };
            const itemDetailMap = {
                '/items/green_guild_credit': { name: 'Green Guild Credit' },
                '/items/gold_guild_credit': { name: 'Gold Guild Credit' },
                '/items/guild_credit_1': { name: 'Trade Credit' },
                '/items/iron_bar': { name: 'Iron Bar' },
            };

            const merged = mergedTokenExchanges(itemDetailMap);
            const byHrid = Object.fromEntries(merged.map((e) => [e.creditItemHrid, e]));

            expect(byHrid['/items/green_guild_credit']).toMatchObject({ source: 'captured', creditsPerToken: 4 });
            expect(byHrid['/items/gold_guild_credit']).toMatchObject({ source: 'default', tokensPerExchange: 60 });
            // A credit no colour names and no capture covers is simply absent
            expect(byHrid['/items/guild_credit_1']).toBeUndefined();
            expect(merged).toHaveLength(2);
        });
    });

    describe('choosing the cheaper way to a credit', () => {
        const gold = () => defaultTokenRate('/items/gold_guild_credit');

        test('the path follows the gold comparison', () => {
            // A gold credit is 60 tokens. At 100 gold a token that is 6,000 gold
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 1_000, goldPerToken: 100 })).toMatchObject({
                path: 'market',
                tokenGold: 6_000,
                marketGold: 1_000,
            });
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 100_000, goldPerToken: 100 })).toMatchObject({
                path: 'tokens',
            });
        });

        test('a tie goes to the token, which is what makes the best colour the one tokens buy', () => {
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 6_000, goldPerToken: 100 }).path).toBe(
                'tokens'
            );
            // And the tie survives the arithmetic that produces it: 0.1 × 1500 is
            // not exactly 150 in a double
            const blue = defaultTokenRate('/items/blue_guild_credit');
            expect(chooseCreditPath({ rate: blue, marketGoldPerCredit: 150, goldPerToken: 1_500 }).path).toBe('tokens');
        });

        test('missing market data falls back to the token path rather than an invented figure', () => {
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: null, goldPerToken: 100 })).toMatchObject({
                path: 'tokens',
                marketGold: null,
            });
            expect(chooseCreditPath({ rate: gold(), marketGoldPerCredit: 1_000, goldPerToken: null })).toMatchObject({
                path: 'tokens',
                tokenGold: null,
            });
        });

        test('no rate leaves the market, and no market either leaves nothing', () => {
            expect(chooseCreditPath({ rate: null, marketGoldPerCredit: 1_000, goldPerToken: 100 }).path).toBe('market');
            expect(chooseCreditPath({ rate: null, marketGoldPerCredit: null }).path).toBe('unknown');
            expect(chooseCreditPath().path).toBe('unknown');
        });

        test('the gold-per-token bridge is the best colour on offer, not the first', () => {
            // Silk yields a blue credit one for one at 200 gold; a rune yields a
            // gold credit one for one at 6,000
            Object.assign(game.clientData.itemDetailMap, {
                '/items/blue_guild_credit': { name: 'Blue Guild Credit', guildCreditConversions: [] },
                '/items/gold_guild_credit': { name: 'Gold Guild Credit', guildCreditConversions: [] },
                '/items/silk': {
                    name: 'Silk',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/blue_guild_credit', itemCount: 1, creditCount: 1 },
                    ],
                },
                '/items/rune': {
                    name: 'Rune',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/gold_guild_credit', itemCount: 1, creditCount: 1 },
                    ],
                },
            });
            game.prices['/items/silk'] = { ask: 200, bid: 150 };
            game.prices['/items/rune'] = { ask: 6_000, bid: 5_000 };

            // Blue: 10 credits per token × 200 = 2,000. Gold: a sixtieth of a
            // credit per token × 6,000 = 100. The blue route wins the maximum
            expect(goldPerTokenFor(game.clientData.itemDetailMap)).toBe(2_000);

            // And that is what prices both paths: gold credits cost 60 × 2,000 of
            // token value against 6,000 on the market, so they are bought
            const marketFor = (hrid, price) =>
                chooseCreditPath({
                    rate: tokenRateFor(hrid),
                    marketGoldPerCredit: price,
                    goldPerToken: goldPerTokenFor(game.clientData.itemDetailMap),
                });
            expect(marketFor('/items/gold_guild_credit', 6_000).path).toBe('market');
            expect(marketFor('/items/blue_guild_credit', 200).path).toBe('tokens');
        });
    });

    describe('the recommended plan drives the whole section', () => {
        const BLUE = '/items/blue_guild_credit';
        const GOLD = '/items/gold_guild_credit';

        function tokenConvertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-token-convert-step')).map((el) => el.textContent);
        }
        function matConvertSteps(modal) {
            return Array.from(modal.querySelectorAll('.mwi-shrine-convert-step')).map((el) => el.textContent);
        }
        function rowFor(modal, label) {
            return nextBuyRows(modal).find((r) => r.textContent.includes(label));
        }

        beforeEach(() => {
            Object.assign(game.clientData.itemDetailMap, {
                [BLUE]: { name: 'Blue Guild Credit', guildCreditConversions: [] },
                [GOLD]: { name: 'Gold Guild Credit', guildCreditConversions: [] },
                '/items/silk': {
                    name: 'Silk',
                    guildCreditConversions: [{ creditItemHrid: BLUE, itemCount: 1, creditCount: 1 }],
                },
                '/items/rune': {
                    name: 'Rune',
                    guildCreditConversions: [{ creditItemHrid: GOLD, itemCount: 1, creditCount: 1 }],
                },
            });
            game.prices['/items/silk'] = { ask: 200, bid: 150 };
            game.prices['/items/rune'] = { ask: 6_000, bid: 5_000 };
            // Force's next level wants gold credits (60 tokens each — the market
            // is far cheaper); Tempo's wants blue ones (a tenth of a token each)
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: GOLD, count: 5 }],
            };
            game.clientData.guildBuffDetailMap[TEMPO].levelCosts['1'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: BLUE, count: 20 }],
            };
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1_000 },
            ];
        });

        test('each row shows only the plan it recommends', () => {
            const modal = openModal();

            expect(rowFor(modal, 'Tempo').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'convert 2 tok → 20 Blue'
            );
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'buy ≈30.0K gold of mats → 5 Gold'
            );
        });

        test('the tooltip says why the path won', () => {
            const modal = openModal();
            const title = rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').title;

            expect(title).toContain('Gold — tokens: 120.0K gold-equiv/credit');
            expect(title).toContain('market: 6.0K/credit');
        });

        test('the effective cost, and so the ranking, counts only the tokens the plan spends', () => {
            const modal = openModal();
            const rows = nextBuyRows(modal);

            // Force pays 100 tokens and buys its credits with gold; Tempo pays
            // 100 plus the 2 tokens its blue credits cost
            expect(rows[0].textContent).toContain('Force');
            expect(rows[0].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('100 tok');
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('102 tok');
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').title).toContain(
                'plus 2 to convert into the credits it is short'
            );
            // No hedging on a standard rate — it is the rate the game charges
            expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').title).not.toContain('about');
        });

        test('the greedy walk spends the recommended plan, tokens and gold named apart', () => {
            const modal = openModal();

            expect(modal.querySelector('.mwi-shrine-spend-all').textContent).toBe(
                'Spending everything now: 2 of 2 next levels for 202 tokens, 2 of them converted into credits plus ≈30.0K gold of mats'
            );
        });

        test('affordability is judged on the recommended plan, not on converting everything', () => {
            // 201 tokens covers Force (100) and not Tempo (102). Converting the
            // five gold credits instead would have cost 300 tokens on its own
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 201 },
            ];
            const modal = openModal();

            expect(nextBuyRows(modal)[0].dataset.affordable).toBe('yes');
            expect(nextBuyRows(modal)[1].dataset.affordable).toBe('no');
        });

        test('the mats button covers only the colours the plan sends to the market', () => {
            const modal = openModal();
            modal.querySelector('.mwi-shrine-next-buy-mats-btn').click();

            expect(shopping.calls).toHaveLength(1);
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/rune', name: 'Rune', count: 5 }]);
        });

        test('the plan lines split the same way the button does', () => {
            const modal = openModal();

            expect(matConvertSteps(modal)).toEqual(['convert 5× Rune → 5 Gold']);
            expect(tokenConvertSteps(modal)).toEqual(['convert 2 tok → 20 Blue']);
        });

        test('a token conversion line explains itself with the standard rate', () => {
            const modal = openModal();
            const line = modal.querySelector('.mwi-shrine-token-convert-step');

            expect(line.dataset.creditHrid).toBe(BLUE);
            expect(line.title).toContain('Standard exchange rate');
            expect(line.title).toContain('1 token → 10');
            expect(line.title).not.toContain('Approximate');
        });

        test('cheap materials move the token path onto the other colour', () => {
            // Silk collapses to 5 gold a credit. Blue credits are then worth 50
            // gold a token against gold credits' 100, so a token is best spent on
            // gold ones after all — and the blue ones are bought instead.
            game.prices['/items/silk'] = { ask: 5, bid: 4 };
            const modal = openModal();

            expect(tokenConvertSteps(modal)).toEqual(['convert 300 tok → 5 Gold']);
            expect(matConvertSteps(modal)).toEqual(['convert 20× Silk → 20 Blue']);
            expect(rowFor(modal, 'Tempo').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('100 tok');
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        test('tokenConversionPlan rounds a part-filled exchange up to a whole one', () => {
            // 25 blue credits at ten a token is three exchanges: 3 tokens, 30 credits
            expect(tokenConversionPlan({ [BLUE]: 25 }, game.clientData.itemDetailMap)).toEqual([
                {
                    creditItemHrid: BLUE,
                    creditName: 'Blue Guild Credit',
                    tokens: 3,
                    credits: 30,
                    owed: 25,
                    rate: defaultTokenRate(BLUE),
                },
            ]);
            // A colour with no rate contributes no step rather than a guess
            expect(tokenConversionPlan({ '/items/guild_credit_1': 10 }, game.clientData.itemDetailMap)).toEqual([]);
        });

        test('a colour the market cannot supply goes back to the tokens', () => {
            // No rune on the market: the gold credits have nothing to be bought
            // with, so the plan converts them however dear that is
            delete game.prices['/items/rune'];
            const modal = openModal();

            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-convert').textContent).toBe(
                'convert 300 tok → 5 Gold'
            );
            expect(rowFor(modal, 'Force').querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
        });

        describe('the still-needed box', () => {
            function convertNote(modal, creditHrid) {
                return modal.querySelector(`.mwi-shrine-credit-convert[data-credit-hrid="${creditHrid}"]`);
            }

            test('only a token-path colour is offered the exchange', () => {
                const modal = openModal();
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                expect(convertNote(modal, BLUE).textContent).toBe('or convert 2 tokens');
                // Gold credits are bought, so the row above is the whole story
                expect(convertNote(modal, GOLD)).toBeNull();
            });

            test('a standard rate drops the ≈ and says it is the standard rate', () => {
                const modal = openModal();
                setTarget(modal, TEMPO, 1);
                const note = convertNote(modal, BLUE);

                expect(note.textContent).not.toContain('≈');
                expect(note.title).toContain('Standard exchange rate');
                expect(note.title).not.toContain('Approximate');
            });

            test('a captured rate keeps the ≈ and its provenance', () => {
                game.rates[BLUE] = {
                    creditItemHrid: BLUE,
                    creditsPerToken: 10,
                    tokensPerExchange: 1,
                    creditsPerExchange: 10,
                    via: 'tiles',
                    capturedAt: 0,
                };
                const modal = openModal();
                setTarget(modal, TEMPO, 1);
                const note = convertNote(modal, BLUE);

                expect(note.textContent).toBe('or convert ≈2 tokens');
                expect(note.title).toContain('Approximate');
                expect(note.title).toContain('item tiles');
                expect(note.title).toContain('capture time unknown');
            });
        });
    });

    describe('choosing how missing credits are paid for', () => {
        const BLUE = '/items/blue_guild_credit';
        const GOLD = '/items/gold_guild_credit';

        const modeButtons = (modal) => Array.from(modal.querySelectorAll('.mwi-shrine-spend-mode-btn'));
        const modeButton = (modal, mode) => modal.querySelector(`.mwi-shrine-spend-mode-btn[data-mode="${mode}"]`);
        const activeMode = (modal) => modeButtons(modal).find((b) => b.dataset.active === 'yes')?.dataset.mode;
        const rowFor = (modal, label) => nextBuyRows(modal).find((r) => r.textContent.includes(label));
        const convertNote = (modal, label) => rowFor(modal, label).querySelector('.mwi-shrine-next-buy-convert');
        const tokenConvertSteps = (modal) =>
            Array.from(modal.querySelectorAll('.mwi-shrine-token-convert-step')).map((el) => el.textContent);
        const matConvertSteps = (modal) =>
            Array.from(modal.querySelectorAll('.mwi-shrine-convert-step')).map((el) => el.textContent);
        const flowButton = (modal) => modal.querySelector('.mwi-shrine-next-buy-mats-btn');
        const walkText = (modal) => modal.querySelector('.mwi-shrine-spend-all').textContent;
        const boxNote = (modal, creditHrid) =>
            modal.querySelector(`.mwi-shrine-credit-convert[data-credit-hrid="${creditHrid}"]`);

        /** Two colours whose cheapest paths point opposite ways */
        function twoColourFixture() {
            Object.assign(game.clientData.itemDetailMap, {
                [BLUE]: { name: 'Blue Guild Credit', guildCreditConversions: [] },
                [GOLD]: { name: 'Gold Guild Credit', guildCreditConversions: [] },
                '/items/silk': {
                    name: 'Silk',
                    guildCreditConversions: [{ creditItemHrid: BLUE, itemCount: 1, creditCount: 1 }],
                },
                '/items/rune': {
                    name: 'Rune',
                    guildCreditConversions: [{ creditItemHrid: GOLD, itemCount: 1, creditCount: 1 }],
                },
            });
            game.prices['/items/silk'] = { ask: 200, bid: 150 };
            game.prices['/items/rune'] = { ask: 6_000, bid: 5_000 };
            // Force wants gold credits (60 tokens each — the market is far
            // cheaper); Tempo wants blue ones (a tenth of a token each)
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: GOLD, count: 5 }],
            };
            game.clientData.guildBuffDetailMap[TEMPO].levelCosts['1'] = {
                guildTokenCost: 100,
                creditCosts: [{ itemHrid: BLUE, count: 20 }],
            };
            game.inventory = [
                { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 1_000 },
            ];
        }

        /** Open the planner already in `mode`, as a saved plan would */
        function openInMode(mode) {
            shrinePlanRecord.get().spendMode = mode;
            return openModal();
        }

        describe('applySpendMode', () => {
            const withRate = { path: 'market', tokensPerCredit: 60, tokenGold: 120_000, marketGold: 6_000 };
            const noRate = { path: 'market', tokensPerCredit: null, tokenGold: null, marketGold: 6_000 };
            const noMarket = { path: 'tokens', tokensPerCredit: 0.1, tokenGold: 200, marketGold: null };

            test('auto hands the recommendation straight back', () => {
                expect(applySpendMode(withRate, 'auto')).toMatchObject({ path: 'market', forced: false });
                // An unknown mode is not a fourth behaviour — it is auto
                expect(applySpendMode(withRate, 'nonsense').path).toBe('market');
                expect(applySpendMode(withRate).path).toBe('market');
            });

            test('a forced path is marked forced, with what it displaced', () => {
                expect(applySpendMode(withRate, 'tokens')).toMatchObject({
                    path: 'tokens',
                    autoPath: 'market',
                    forced: true,
                    fallback: false,
                });
            });

            test('a mode that cannot be honoured falls back rather than dropping the colour', () => {
                expect(applySpendMode(noRate, 'tokens')).toMatchObject({ path: 'market', fallback: true });
                expect(applySpendMode(noMarket, 'gold')).toMatchObject({ path: 'tokens', fallback: true });
                // Falling back to where auto already was is not an override
                expect(applySpendMode(noRate, 'tokens').forced).toBe(false);
            });

            test('a colour with neither path stays unknown in every mode', () => {
                const nothing = { path: 'unknown', tokensPerCredit: null, tokenGold: null, marketGold: null };
                for (const mode of SPEND_MODES) expect(applySpendMode(nothing, mode).path).toBe('unknown');
                expect(applySpendMode(null, 'gold').path).toBe('unknown');
            });
        });

        describe('the control', () => {
            test('three pills render, auto active, inside the folding body', () => {
                const modal = openModal();

                expect(modeButtons(modal).map((b) => b.textContent)).toEqual(['Auto', 'Tokens', 'Gold']);
                expect(activeMode(modal)).toBe('auto');
                expect(modal.querySelector('.mwi-shrine-suggest-body .mwi-shrine-spend-mode')).not.toBeNull();
            });

            test('a legacy plan with no saved mode is auto', async () => {
                game.storage['settings:guildShrinePlan_char1'] = { targets: { [TEMPO]: 4 }, collapsed: false };
                const modal = await reopenFromStorage();

                expect(activeMode(modal)).toBe('auto');
                expect(shrinePlanRecord.get().spendMode).toBeUndefined();
            });

            test('a click persists the choice and survives a reopen', async () => {
                const modal = openModal();
                modeButton(modal, 'tokens').click();

                expect(activeMode(modal)).toBe('tokens');
                vi.advanceTimersByTime(400);
                await shrinePlanRecord.flushed();
                expect(game.storage['settings:guildShrinePlan_char1'].spendMode).toBe('tokens');

                const reopened = await reopenFromStorage();
                expect(activeMode(reopened)).toBe('tokens');
            });

            test('re-clicking the active pill is a no-op, not a redundant save', async () => {
                const modal = openModal();
                modeButton(modal, 'auto').click();

                vi.advanceTimersByTime(400);
                await shrinePlanRecord.flushed();
                expect(game.writes).toBe(0);
            });

            test('the fold state and the typed targets are untouched by a mode change', async () => {
                const modal = openModal();
                const input = inputFor(modal, TEMPO);
                input.value = '4';
                input.dispatchEvent(new Event('input'));
                modal.querySelector('.mwi-shrine-suggest-heading').click();

                modeButton(modal, 'gold').click();

                expect(shrinePlanRecord.get().suggestionsCollapsed).toBe(true);
                expect(shrinePlanRecord.get().targets).toEqual({ [TEMPO]: 4 });
                expect(inputFor(modal, TEMPO).value).toBe('4');

                vi.advanceTimersByTime(400);
                await shrinePlanRecord.flushed();
                const saved = game.storage['settings:guildShrinePlan_char1'];
                expect(saved).toMatchObject({ spendMode: 'gold', suggestionsCollapsed: true, targets: { [TEMPO]: 4 } });
            });

            test('the heading tooltip names the ranking and what the mode does to it', () => {
                const modal = openInMode('gold');
                const title = modal.querySelector('.mwi-shrine-suggest-heading').title;

                expect(title).toContain('Cheapest first by effective token cost');
                expect(title).toContain('gold half named beside it');
                expect(title).toContain('Gold: every colour with a priced conversion is bought');
            });
        });

        describe('tokens mode', () => {
            beforeEach(twoColourFixture);

            test('a market-cheaper colour is converted anyway, and the tooltip says what that costs', () => {
                const modal = openInMode('tokens');

                expect(convertNote(modal, 'Force').textContent).toBe('convert 300 tok → 5 Gold');
                const title = convertNote(modal, 'Force').title;
                expect(title).toContain('Gold — tokens: 120.0K gold-equiv/credit vs market: 6.0K/credit.');
                expect(title).toContain('Auto would buy it on the market');
                expect(title).toContain('more gold-equivalent per credit');
            });

            test('the ranking and the walk are recomputed on the forced path', () => {
                const modal = openInMode('tokens');
                const rows = nextBuyRows(modal);

                // Tempo 100 + 2, Force 100 + 300 — the order auto gives is reversed
                expect(rows[0].textContent).toContain('Tempo');
                expect(rows[0].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('102 tok');
                expect(rows[1].querySelector('.mwi-shrine-next-buy-tok').textContent).toBe('400 tok');
                expect(walkText(modal)).toBe(
                    'Spending everything now: 2 of 2 next levels for 502 tokens, 302 of them converted into credits'
                );
            });

            test('nothing is left for the marketplace, and both colours become exchanges', () => {
                const modal = openInMode('tokens');

                expect(flowButton(modal)).toBeNull();
                expect(matConvertSteps(modal)).toEqual([]);
                expect(tokenConvertSteps(modal)).toEqual(['convert 2 tok → 20 Blue', 'convert 300 tok → 5 Gold']);
            });

            test('the still-needed box and its button follow the same mode', () => {
                const modal = openInMode('tokens');
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                expect(boxNote(modal, BLUE).textContent).toBe('or convert 2 tokens');
                expect(boxNote(modal, GOLD).textContent).toBe('or convert 300 tokens');
                // Nothing is bought, so there is nothing to go shopping for
                expect(matsButton(modal)).toBeNull();
            });

            test('an exchange beyond the tokens the plan leaves spare is shown, not hidden', () => {
                game.inventory = [
                    { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: 250 },
                ];
                const modal = openInMode('tokens');
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                // 250 held against a 200-token plan leaves 50 spare, and the gold
                // credits want 300 — said with the shortfall rather than dropped
                expect(boxNote(modal, GOLD).textContent).toBe(
                    'or convert 300 tokens (more than this plan leaves spare)'
                );
            });

            test('a colour with no rate at all is still bought, and the row says why', () => {
                // Back to the plain fixture: Trade Credit has no token rate
                game.clientData = planClientData();
                const modal = openInMode('tokens');

                expect(convertNote(modal, 'Force').textContent).toBe('buy ≈7.5K gold of mats → 50 Trade');
                expect(convertNote(modal, 'Force').title).toContain(
                    'no token→credit rate is known for it, so Tokens mode buys this one on the market instead'
                );
            });
        });

        describe('gold mode', () => {
            beforeEach(twoColourFixture);

            test('a token-cheaper colour is bought on the market instead', () => {
                const modal = openInMode('gold');

                expect(convertNote(modal, 'Tempo').textContent).toBe('buy ≈4.0K gold of mats → 20 Blue');
                expect(convertNote(modal, 'Force').textContent).toBe('buy ≈30.0K gold of mats → 5 Gold');
            });

            test('the token bill falls to the levels themselves and the gold bill grows', () => {
                const modal = openInMode('gold');
                const rows = nextBuyRows(modal);

                expect(rows.map((r) => r.querySelector('.mwi-shrine-next-buy-tok').textContent)).toEqual([
                    '100 tok',
                    '100 tok',
                ]);
                expect(walkText(modal)).toBe(
                    'Spending everything now: 2 of 2 next levels for 200 tokens plus ≈34.0K gold of mats'
                );
            });

            test('every colour lands on the shopping list and the market conversion lines', () => {
                const modal = openInMode('gold');
                flowButton(modal).click();

                expect(shopping.calls[0].items.map((i) => i.itemHrid).sort()).toEqual(['/items/rune', '/items/silk']);
                expect(matConvertSteps(modal)).toEqual(['convert 20× Silk → 20 Blue', 'convert 5× Rune → 5 Gold']);
                expect(tokenConvertSteps(modal)).toEqual([]);
            });

            test('the still-needed box stops offering exchanges and its button covers both colours', () => {
                const modal = openInMode('gold');
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                expect(boxNote(modal, BLUE)).toBeNull();
                expect(boxNote(modal, GOLD)).toBeNull();
                matsButton(modal).click();
                expect(shopping.calls[0].items.map((i) => i.itemHrid).sort()).toEqual(['/items/rune', '/items/silk']);
            });

            test('a colour nothing priced converts into goes back to the tokens, and the row says why', () => {
                delete game.prices['/items/silk'];
                const modal = openInMode('gold');

                expect(convertNote(modal, 'Tempo').textContent).toBe('convert 2 tok → 20 Blue');
                expect(convertNote(modal, 'Tempo').title).toContain(
                    'nothing on the market converts into it at a known price, so Gold mode exchanges tokens'
                );
            });
        });

        describe('switching modes redraws the whole section', () => {
            beforeEach(twoColourFixture);

            test('one click moves the rows, the walk, the box and the button together', () => {
                const modal = openModal();
                setTarget(modal, FORCE, 3);
                setTarget(modal, TEMPO, 1);

                // Auto: gold credits bought, blue ones exchanged
                expect(tokenConvertSteps(modal)).toEqual(['convert 2 tok → 20 Blue']);
                expect(matConvertSteps(modal)).toEqual(['convert 5× Rune → 5 Gold']);
                expect(boxNote(modal, BLUE).textContent).toBe('or convert 2 tokens');
                matsButton(modal).click();
                expect(shopping.calls[0].items.map((i) => i.itemHrid)).toEqual(['/items/rune']);

                modeButton(modal, 'tokens').click();

                expect(tokenConvertSteps(modal)).toEqual(['convert 2 tok → 20 Blue', 'convert 300 tok → 5 Gold']);
                expect(matConvertSteps(modal)).toEqual([]);
                expect(boxNote(modal, GOLD).textContent).toBe('or convert 300 tokens');
                expect(matsButton(modal)).toBeNull();
                expect(walkText(modal)).toContain('502 tokens');

                modeButton(modal, 'gold').click();

                expect(tokenConvertSteps(modal)).toEqual([]);
                expect(boxNote(modal, BLUE)).toBeNull();
                expect(walkText(modal)).toContain('≈34.0K gold of mats');
                matsButton(modal).click();
                expect(shopping.calls[1].items.map((i) => i.itemHrid).sort()).toEqual(['/items/rune', '/items/silk']);
            });
        });
    });

    /** Fire dataManager's items_updated the way a claimed purchase does, and let the debounced refresh run */
    function purchaseLands() {
        for (const handler of [...(game.listeners['items_updated'] || [])]) handler({});
        vi.advanceTimersByTime(50);
    }

    describe('the plan keeps up with the inventory', () => {
        test('materials bought after the plan was drawn come off the shopping list', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            matsButton(modal).click();
            expect(shopping.calls[0].items[0].count).toBe(250);

            // 200 of the 250 iron bars land in the bag — the next trip is for
            // the 50 that are left, not the 250 the first render billed
            game.inventory = [
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            purchaseLands();

            matsButton(modal).click();
            expect(shopping.calls[1].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 50 }]);
        });

        test('credits landing in the bag pull the owed rows down', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(modal.querySelector('.mwi-shrine-planner').textContent).toContain('50');

            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 20 },
            ];
            purchaseLands();

            const totals = modal.querySelector('.mwi-shrine-planner').textContent.replace(/\s+/g, ' ');
            expect(totals).toContain('30');
            expect(totals).toContain('(own 20)');
        });

        test('a fully bought shortfall takes its own button away', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(matsButton(modal)).not.toBeNull();

            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            purchaseLands();

            expect(matsButton(modal)).toBeNull();
        });

        test('the hook is released with the feature, and lets go on its own once the planner is gone', () => {
            openModal();
            expect(game.listeners['items_updated']).toHaveLength(1);

            // The modal closed without the feature being torn down: the next
            // delta finds the planner disconnected and releases the hook
            document.body.innerHTML = '';
            purchaseLands();
            expect(game.listeners['items_updated']).toHaveLength(0);

            openModal();
            guildCreditValue.cleanup();
            expect(game.listeners['items_updated']).toHaveLength(0);
        });

        test('reopening the modal does not stack a second hook', () => {
            // Each render arms one and releases the last, so a modal opened and
            // closed all evening refreshes once per delta rather than N times
            openModal();
            openModal();
            const latest = openModal();
            expect(game.listeners['items_updated']).toHaveLength(1);

            // And the one still armed is the newest planner's, not a stale closure
            setTarget(latest, FORCE, 3);
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            purchaseLands();
            expect(matsButton(latest)).toBeNull();
        });
    });

    describe('the plan lists the conversions after the shopping trip', () => {
        const planConvertSteps = (modal) =>
            Array.from(modal.querySelectorAll('.mwi-shrine-plan-convert-step')).map((el) => el.textContent);

        test('the step names the same item as the shopping list, and the whole trade', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(planConvertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
        });

        test('bars already held shrink the shopping list but not the hand-over', () => {
            // The counter takes the whole trade whether or not the bars were
            // bought today — netting belongs to the buy, not the exchange
            game.inventory = [
                { itemHrid: '/items/iron_bar', itemLocationHrid: '/item_locations/inventory', count: 200 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            matsButton(modal).click();
            expect(shopping.calls[0].items[0].count).toBe(50);
            expect(planConvertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);
        });

        test('the steps tick down as exchanged credits land, and away at zero', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(planConvertSteps(modal)).toEqual(['convert 250× Iron Bar → 50 Trade']);

            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 30 },
            ];
            purchaseLands();
            expect(planConvertSteps(modal)).toEqual(['convert 100× Iron Bar → 20 Trade']);

            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 50 },
            ];
            purchaseLands();
            expect(planConvertSteps(modal)).toEqual([]);
            expect(modal.querySelector('.mwi-shrine-plan-mats').textContent).not.toContain('then convert');
        });
    });

    describe('covering a colour with tokens before buying', () => {
        const coverBoxFor = (modal, creditHrid) =>
            modal.querySelector(`.mwi-shrine-token-cover[data-credit-hrid="${creditHrid}"] input`);
        const coverLabelFor = (modal, creditHrid) =>
            modal.querySelector(`.mwi-shrine-token-cover[data-credit-hrid="${creditHrid}"]`);
        const planTokenSteps = (modal) =>
            Array.from(modal.querySelectorAll('.mwi-shrine-plan-token-step')).map((el) => el.textContent);

        beforeEach(() => {
            // A seen rate for Trade Credit: 1 token → 1 credit. The base mode is
            // Gold, which keeps the colour on the market side until the cover
            // overrides it — the override over the mode is the whole point.
            game.rates['/items/guild_credit_1'] = {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: 1,
                tokensPerExchange: 1,
                creditsPerExchange: 1,
                capturedAt: 1_700_000_000_000,
                via: 'arrow',
            };
            shrinePlanRecord.get().spendMode = 'gold';
        });

        test('ticking the box takes the colour off the shopping list and lists the exchange instead', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(matsButton(modal)).not.toBeNull();
            expect(planTokenSteps(modal)).toEqual([]);

            coverBoxFor(modal, '/items/guild_credit_1').click();

            expect(matsButton(modal)).toBeNull();
            expect(planTokenSteps(modal)).toEqual(['convert 50 tok → 50 Trade']);
            // The suggestions route the same colour the same way
            const forceRow = nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
            expect(forceRow.querySelector('.mwi-shrine-next-buy-convert').textContent).toContain('convert 50 tok');

            // Unticking puts the shopping trip back
            coverBoxFor(modal, '/items/guild_credit_1').click();
            expect(matsButton(modal)).not.toBeNull();
            expect(planTokenSteps(modal)).toEqual([]);
        });

        test('the label quotes the token cost of what is still owed, and it falls as credits land', () => {
            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 20 },
            ];
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(coverLabelFor(modal, '/items/guild_credit_1').textContent).toContain('30 tok');

            game.inventory = [
                { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: 45 },
            ];
            purchaseLands();
            expect(coverLabelFor(modal, '/items/guild_credit_1').textContent).toContain('5 tok');
        });

        test('the choice is saved with the character and comes back', async () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            coverBoxFor(modal, '/items/guild_credit_1').click();

            vi.advanceTimersByTime(400);
            await shrinePlanRecord.flushed();
            expect(game.storage['settings:guildShrinePlan_char1'].tokenCredits).toEqual({
                '/items/guild_credit_1': true,
            });

            const reopened = await reopenFromStorage();
            expect(coverBoxFor(reopened, '/items/guild_credit_1').checked).toBe(true);
            expect(matsButton(reopened)).toBeNull();
            expect(planTokenSteps(reopened)).toEqual(['convert 50 tok → 50 Trade']);
        });

        test('a colour with no known rate cannot be covered', () => {
            const modal = openModal();
            // Level 4 costs Craft Credit — no colour word, never captured
            setTarget(modal, FORCE, 4);

            const box = coverBoxFor(modal, '/items/guild_credit_2');
            expect(box.disabled).toBe(true);
        });

        test('splitOwedCredits routes each colour by its decided path', () => {
            const pathFor = (hrid) => ({ path: hrid === '/items/a' ? 'tokens' : 'market' });
            expect(splitOwedCredits({ '/items/a': 5, '/items/b': 3 }, pathFor)).toEqual({
                tokenOwed: { '/items/a': 5 },
                marketOwed: { '/items/b': 3 },
            });
        });

        test('only an explicit true covers a colour', () => {
            expect(tokenCoveredCredits({ tokenCredits: { a: true, b: false, c: 1 } })).toEqual(new Set(['a']));
            expect(tokenCoveredCredits({})).toEqual(new Set());
            expect(tokenCoveredCredits(null)).toEqual(new Set());
        });

        test('the ranking indicator marks the best colour to spend tokens on, and says so', () => {
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            const worth = modal.querySelector('.mwi-shrine-token-worth[data-credit-hrid="/items/guild_credit_1"]');
            // 1 token → 1 Trade Credit, and a credit's mats cost 150 gold
            expect(worth.textContent).toBe('★ 150/tok');
            expect(worth.title).toContain('1 tok here saves 150 gold');
            expect(worth.title).toContain('Best use of your tokens');
        });

        test('a colour whose mats have no price is called unpriced, not ranked last', () => {
            game.rates['/items/guild_credit_2'] = {
                creditItemHrid: '/items/guild_credit_2',
                creditsPerToken: 1,
                tokensPerExchange: 1,
                creditsPerExchange: 1,
                capturedAt: 1_700_000_000_000,
                via: 'arrow',
            };
            const modal = openModal();
            // Level 4 costs Craft Credit, which nothing on the market converts into
            setTarget(modal, FORCE, 4);

            const worth = modal.querySelector('.mwi-shrine-token-worth[data-credit-hrid="/items/guild_credit_2"]');
            expect(worth.textContent).toBe('unpriced');
            expect(worth.title).toContain('Unpriced rather than guessed');
            expect(worth.textContent).not.toContain('/tok');
        });

        test('a plan that lands after the modal opened routes the suggestions too, not just the totals', async () => {
            // The record's read had not finished when the planner was drawn, so
            // both halves were drawn from an empty plan. When it lands, both
            // have to be redrawn from it — the plan carries the spend mode and
            // the per-colour covers alike, and redrawing the totals alone left
            // the suggestions settling a colour the way the box above them no
            // longer does. Gold with no cover ticked is the discriminating
            // case: the recommendation on its own would exchange tokens here,
            // so only the saved plan sends this colour shopping.
            game.storage['settings:guildShrinePlan_char1'] = { spendMode: 'gold' };
            document.body.innerHTML = '';
            shrinePlanRecord.reset();
            const modal = openModal();
            await vi.advanceTimersByTimeAsync(0);

            const forceRow = nextBuyRows(modal).find((r) => r.textContent.includes('Force'));
            expect(forceRow.querySelector('.mwi-shrine-next-buy-convert').textContent).toContain('gold of mats');
            expect(modal.querySelector('.mwi-shrine-token-convert-step')).toBeNull();
        });
    });

    describe('the conversions never spend tokens the plan does not have', () => {
        const planTokenSteps = (modal) =>
            Array.from(modal.querySelectorAll('.mwi-shrine-plan-token-step')).map((el) => el.textContent);
        const coverBoxFor = (modal, creditHrid) =>
            modal.querySelector(`.mwi-shrine-token-cover[data-credit-hrid="${creditHrid}"] input`);

        /** Blue's rate: one token buys ten credits */
        beforeEach(() => {
            game.rates['/items/guild_credit_1'] = {
                creditItemHrid: '/items/guild_credit_1',
                creditsPerToken: 10,
                tokensPerExchange: 1,
                creditsPerExchange: 10,
                capturedAt: 1_700_000_000_000,
                via: 'arrow',
            };
        });

        /** Held tokens and credits, in the order the inventory reports them */
        const holding = (tokens, credits) => [
            { itemHrid: '/items/guild_token', itemLocationHrid: '/item_locations/inventory', count: tokens },
            { itemHrid: '/items/guild_credit_1', itemLocationHrid: '/item_locations/inventory', count: credits },
        ];

        test('the reported plan: 78,495 tokens short, so no conversion is recommended at all', () => {
            // The maintainer's screenshot, to scale. The level wants 196,100
            // tokens and 1,852,000 credits; the bag holds 117,605 tokens and
            // 144,800 credits, so the box shows 78,495 tokens and 1,707,200
            // credits still needed. The recommendation used to offer to convert
            // 170,720 tokens for those credits — on top of a token bill it
            // already could not pay, out of a balance that covers neither.
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 196_100,
                creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 1_852_000 }],
            };
            game.inventory = holding(117_605, 144_800);
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            const totals = modal.querySelector('.mwi-shrine-planner').textContent;
            expect(totals).toContain('78,495');
            expect(totals).toContain('own 117,605');
            expect(totals).toContain('1,707,200');
            // The chip still quotes what covering the colour would cost — it is a
            // price, not a plan — but nothing is scheduled against it
            expect(
                modal.querySelector('.mwi-shrine-token-cover[data-credit-hrid="/items/guild_credit_1"]').textContent
            ).toContain('170,720 tok');
            expect(planTokenSteps(modal)).toEqual([]);
            // …and the credits it can no longer convert for are bought instead:
            // 1,707,200 credits at 5 iron bars each
            matsButton(modal).click();
            expect(shopping.calls[0].items).toEqual([
                { itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 8_536_000 },
            ]);
        });

        test('a budget that covers part of a colour converts that part and shops for the rest', () => {
            // 200 tokens for the level, 250 held: 50 spare, which buys 500 of
            // the 800 credits owed. The other 300 go on the shopping list.
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 200,
                creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 800 }],
            };
            game.inventory = holding(250, 0);
            const modal = openModal();
            setTarget(modal, FORCE, 3);

            expect(planTokenSteps(modal)).toEqual(['convert 50 tok → 500 Trade (token cap)']);
            const line = modal.querySelector('.mwi-shrine-plan-token-step');
            expect(line.title).toContain('as much of the 800 owed as the tokens this plan leaves spare will buy');
            expect(line.title).toContain('The other 300 are on the shopping list');

            matsButton(modal).click();
            expect(shopping.calls[0].items).toEqual([{ itemHrid: '/items/iron_bar', name: 'Iron Bar', count: 1500 }]);
        });

        test('a colour the player ticked keeps its exchange, and the step says how far past spare it is', () => {
            game.clientData.guildBuffDetailMap[FORCE].levelCosts['3'] = {
                guildTokenCost: 200,
                creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 800 }],
            };
            game.inventory = holding(250, 0);
            shrinePlanRecord.get().spendMode = 'gold';
            const modal = openModal();
            setTarget(modal, FORCE, 3);
            expect(planTokenSteps(modal)).toEqual([]);

            coverBoxFor(modal, '/items/guild_credit_1').click();

            // A choice is not advice: the whole 80 stays, capped only in the
            // telling — 50 spare, so 30 of them are not yet in the bag
            expect(planTokenSteps(modal)).toEqual(['convert 80 tok → 800 Trade']);
            expect(modal.querySelector('.mwi-shrine-plan-token-step').title).toContain(
                '30 tokens more than this plan leaves spare'
            );
            expect(matsButton(modal)).toBeNull();
        });
    });

    describe('the token budget and the value ranking, as arithmetic', () => {
        const RATE = { tokensPerExchange: 1, creditsPerExchange: 10, creditsPerToken: 10 };

        test('a budget buys whole exchanges and no fraction of one', () => {
            expect(creditsForTokens(5, RATE)).toBe(50);
            expect(creditsForTokens(0, RATE)).toBe(0);
            expect(creditsForTokens(5, { creditsPerToken: 10 })).toBe(50);
            // Ten tokens per credit: nine buy nothing
            expect(creditsForTokens(9, { tokensPerExchange: 10, creditsPerExchange: 1 })).toBe(0);
            expect(creditsForTokens(5, null)).toBe(0);
        });

        test('the budget is spent on the colours it saves the most gold on first', () => {
            const rates = { '/items/a': RATE, '/items/b': RATE };
            // 1 token → 10 credits either way, but b's credits cost 200 gold of
            // mats against a's 100, so b is where the tokens go
            const decisions = {
                '/items/a': { tokensPerCredit: 0.1, marketGold: 100 },
                '/items/b': { tokensPerCredit: 0.1, marketGold: 200 },
            };
            const out = capTokenPlanToBudget({ '/items/a': 500, '/items/b': 500 }, 50, {
                rateFor: (hrid) => rates[hrid],
                decisionFor: (hrid) => decisions[hrid],
            });

            expect(out.tokenOwed).toEqual({ '/items/b': 500 });
            expect(out.marketOwed).toEqual({ '/items/a': 500 });
            expect(out.capped['/items/a']).toEqual({
                chosen: false,
                tokens: 0,
                credits: 0,
                remainder: 500,
                over: 0,
            });
        });

        test('a budget of nothing schedules nothing', () => {
            const out = capTokenPlanToBudget({ '/items/a': 500 }, 0, { rateFor: () => RATE });
            expect(out.tokenOwed).toEqual({});
            expect(out.marketOwed).toEqual({ '/items/a': 500 });
        });

        test('a colour with no rate is left where it was — there is no token figure to cap', () => {
            const out = capTokenPlanToBudget({ '/items/a': 500 }, 0, { rateFor: () => null });
            expect(out.tokenOwed).toEqual({ '/items/a': 500 });
            expect(out.capped).toEqual({});
        });

        test('gold saved per token is the mats a token displaces', () => {
            expect(goldSavedPerToken({ tokensPerCredit: 0.1, marketGold: 150 })).toBe(1500);
            expect(goldSavedPerToken({ tokensPerCredit: 60, marketGold: 1200 })).toBe(20);
            expect(goldSavedPerToken({ tokensPerCredit: 0.1, marketGold: null })).toBeNull();
            expect(goldSavedPerToken(null)).toBeNull();
        });

        test('the ranking crowns the best, ties included, and sets the unpriced aside', () => {
            const decisions = {
                cheap: { tokensPerCredit: 60, marketGold: 1200 },
                best: { tokensPerCredit: 0.1, marketGold: 150 },
                tied: { tokensPerCredit: 1, marketGold: 1500 },
                blind: { tokensPerCredit: 0.1, marketGold: null },
            };
            const ranked = rankTokenCoverValue(['cheap', 'blind', 'best', 'tied'], (hrid) => decisions[hrid]);

            expect(ranked.map((row) => row.itemHrid)).toEqual(['best', 'tied', 'cheap', 'blind']);
            expect(ranked.filter((row) => row.best).map((row) => row.itemHrid)).toEqual(['best', 'tied']);
            expect(ranked.at(-1)).toEqual({ itemHrid: 'blind', goldPerToken: null, unpriced: true, best: false });
        });
    });
});

describe('guild credit value — shrine plan record on a character switch', () => {
    // The scoped-storage mocks above key everything off `game.currentCharId`;
    // this is the only describe block that ever moves it off 'char1'.
    beforeEach(() => {
        game.settings = { guildCreditValue: true, guildShrineUpgradePlanner: true };
        game.observers = {};
        // Not `game.listeners = {}`: the character_switching handler this
        // block is testing is registered once, at module import — clearing
        // the registry here would drop it for good, not just for this test.
        game.storage = {};
        game.currentCharId = 'char1';
        game.clientData = { itemDetailMap: {} };
        shrinePlanRecord.reset();
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    afterEach(() => {
        game.currentCharId = 'char1';
        shrinePlanRecord.reset();
    });

    test('character_switching clears the in-memory plan so the next load cannot merge it over the arriving character', async () => {
        // Character 1 has a saved shrine target in storage, and it is read
        // into memory the way opening the exchange modal would do it.
        game.storage['settings:guildShrinePlan_char1'] = {
            targets: { forceBuff: 5 },
            spendMode: 'tokens',
            tokenCredits: { '/items/blue_guild_credit': true },
        };
        await shrinePlanRecord.load();
        expect(shrinePlanRecord.get().targets).toEqual({ forceBuff: 5 });

        // feature-registry.js fires this before the id changes and re-inits
        // every feature; nothing else in this file clears the record's memory.
        // Awaited the way data-manager awaits it: the listener flushes a
        // pending plan edit before resetting, so the reset lands a microtask
        // later rather than synchronously.
        expect(game.listeners['character_switching']).toBeTruthy();
        await Promise.all(game.listeners['character_switching'].map((fn) => fn()));
        expect(shrinePlanRecord.get()).toEqual({});

        // Character 2 has never set a target for this buff. Without the reset,
        // the curated record's pre-first-load merge would fold character 1's
        // still-resident `targets` over character 2's own (empty) stored plan
        // — a target neither this character nor this session ever set.
        game.currentCharId = 'char2';
        await shrinePlanRecord.load();

        expect(shrinePlanRecord.get().targets ?? {}).toEqual({});
        // The per-colour token covers ride the same record and must not follow
        // the departing character either
        expect(shrinePlanRecord.get().tokenCredits ?? {}).toEqual({});
    });

    test('a switch does not block the arriving character from seeing its own saved plan', async () => {
        game.storage['settings:guildShrinePlan_char1'] = { targets: { forceBuff: 5 } };
        await shrinePlanRecord.load();

        await Promise.all(game.listeners['character_switching'].map((fn) => fn()));
        game.currentCharId = 'char2';
        game.storage['settings:guildShrinePlan_char2'] = { targets: { scholarBuff: 2 } };
        await shrinePlanRecord.load();

        expect(shrinePlanRecord.get().targets).toEqual({ scholarBuff: 2 });
    });
});

describe('the shrine cost block keeps up with the modal', () => {
    // One credit colour, bought through one bar. Ten credits per bar, so the
    // arithmetic in the assertions stays readable.
    const CREDIT = '/items/blue_guild_credit';
    const BAR = '/items/blue_bar';

    /**
     * The shrine modal as the game draws it: a level line, the Upgrade button,
     * and the requirement row stating this level's cost.
     * @param {number} required - The credit cost the modal is currently stating
     * @returns {Element} The modal content element
     */
    function buildShrineModal(required) {
        document.body.innerHTML = '';
        const modal = document.createElement('div');
        modal.className = 'GuildPanel_guildModalContent__x';
        modal.innerHTML = `
            <div class="GuildPanel_level__x">Lv. 3</div>
            <button>Upgrade</button>
            <div class="GuildPanel_itemRequirements__x">
                <div class="Item_itemContainer__x"><svg><use href="/sprite.svg#blue_guild_credit"></use></svg></div>
                <div class="GuildPanel_inputCount__x">${required}</div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    /** Restate the modal's cost, the way the game does after an upgrade lands */
    const restateCost = (modal, required) => {
        modal.querySelector('[class*="GuildPanel_inputCount"]').textContent = String(required);
    };

    /** Set what the character is holding */
    const hold = (credits, bars = 0) => {
        game.inventory = [
            { itemHrid: CREDIT, itemLocationHrid: '/item_locations/inventory', count: credits },
            { itemHrid: BAR, itemLocationHrid: '/item_locations/inventory', count: bars },
        ];
    };

    const fireItemsUpdated = () => (game.listeners.items_updated || []).forEach((fn) => fn({}));
    /** Let the MutationObserver deliver and the re-render debounce elapse */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 90));
    const missingButton = (modal) =>
        [...modal.querySelectorAll('.mwi-shrine-cost button')].find(
            (b) => b.textContent === 'Missing Mats Marketplace'
        );

    beforeEach(() => {
        game.settings = {};
        game.prices = { [BAR]: { ask: 100, bid: 90 } };
        game.clientData = {
            itemDetailMap: {
                [CREDIT]: { name: 'Blue Guild Credit' },
                [BAR]: {
                    name: 'Blue Bar',
                    guildCreditConversions: [{ creditItemHrid: CREDIT, itemCount: 1, creditCount: 10 }],
                },
            },
        };
        hold(244_000);
        // `initialize()` is a no-op while the feature is still up, so a block
        // that ran before this one and left it initialized also left its shrine
        // re-render triggers armed on ITS modal — and those share one timer and
        // one `items_updated` handler with this block's. Firing `items_updated`
        // then schedules a redraw of a modal that is no longer connected, which
        // disconnects the observer watching the live one.
        guildCreditValue.cleanup();
        guildCreditValue.initialize();
    });

    afterEach(() => {
        guildCreditValue.cleanup();
        resetListeners();
        document.body.innerHTML = '';
    });

    test('enough credits means a cost table with no Missing Mats button', () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);

        expect(modal.querySelector('.mwi-shrine-cost')).toBeTruthy();
        expect(missingButton(modal)).toBeUndefined();
    });

    test('the button appears when the game restates the next level cost', async () => {
        // The reported sequence: the block renders with nothing missing, the
        // upgrade goes through, and the modal starts stating a cost the
        // remaining credits no longer cover.
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        expect(missingButton(modal)).toBeUndefined();

        restateCost(modal, 500_000);
        await settle();

        // 500K owed, 244K held → 256K short → 25,600 bars at ten credits each
        expect(missingButton(modal)).toBeTruthy();
        expect(modal.querySelector('.mwi-shrine-cost').textContent).toContain('256,000');
    });

    test('the button appears when the upgrade drains the holdings', async () => {
        const modal = buildShrineModal(156_000);
        hold(244_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        expect(missingButton(modal)).toBeUndefined();

        // The deduction lands separately from the cost restatement — this is the
        // half the first render could not have known about.
        hold(144_000);
        fireItemsUpdated();
        await settle();

        expect(missingButton(modal)).toBeTruthy();
        // 156K owed against 144K held is a 12K shortfall → 1,200 bars
        expect(modal.querySelector('.mwi-shrine-cost').textContent).toContain('12,000');
    });

    test('a shortfall that is filled again takes the button away', async () => {
        const modal = buildShrineModal(300_000);
        hold(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        expect(missingButton(modal)).toBeTruthy();

        hold(100_000, 100_000);
        fireItemsUpdated();
        await settle();

        expect(missingButton(modal)).toBeUndefined();
    });

    test('its own injection does not send it round again', async () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);

        // A re-render replaces the block, so the identity of the injected node
        // is the render count: the same node back means nothing redrew.
        const injected = modal.querySelector('.mwi-shrine-cost');

        // A redraw of the watched area that states exactly the same cost — what
        // React does on any unrelated re-render, and what this feature's own
        // mutations look like to the observer.
        restateCost(modal, 100_000);
        modal.querySelector('[class*="GuildPanel_itemRequirements"]').appendChild(document.createElement('span'));
        fireItemsUpdated();
        await settle();
        expect(modal.querySelector('.mwi-shrine-cost')).toBe(injected);

        // …and the guard is a fingerprint, not a switch: a cost that really
        // moves still gets through it.
        restateCost(modal, 900_000);
        await settle();
        expect(modal.querySelector('.mwi-shrine-cost')).not.toBe(injected);
    });

    test('cleanup releases the re-render triggers', async () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        expect(game.listeners.items_updated).toHaveLength(1);

        guildCreditValue.cleanup();
        expect(game.listeners.items_updated).toHaveLength(0);

        // And nothing redraws after the feature is gone
        restateCost(modal, 900_000);
        await settle();
        expect(modal.querySelector('.mwi-shrine-cost')).toBeNull();
    });

    test('only one set of triggers at a time, however often the modal is redrawn', () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        game.observers['GuildPanel_guildModalContent'](modal);
        game.observers['GuildPanel_guildModalContent'](modal);

        expect(game.listeners.items_updated).toHaveLength(1);
        expect(modal.querySelectorAll('.mwi-shrine-cost')).toHaveLength(1);
    });

    test('a closed modal releases the triggers rather than redrawing into nothing', async () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);

        modal.remove();
        fireItemsUpdated();
        await settle();

        expect(game.listeners.items_updated).toHaveLength(0);
    });

    // `upgradeBtn` is the game's own button, not something this script
    // replaces, and every `_renderShrine` call added a fresh `{once: true}`
    // click listener onto it with nothing removing an earlier one. A modal
    // that re-renders more than once before the player clicks Upgrade (an
    // `items_updated` tick, a requirement-row restate) built up one listener
    // per render, and a single click fired all of them at once.
    test('a click on Upgrade after several re-renders arms the level watcher only once', async () => {
        const modal = buildShrineModal(100_000);
        game.observers['GuildPanel_guildModalContent'](modal);

        // Two genuine re-renders while the modal stays open
        restateCost(modal, 120_000);
        fireItemsUpdated();
        await settle();
        restateCost(modal, 140_000);
        fireItemsUpdated();
        await settle();

        const OriginalObserver = window.MutationObserver;
        let created = 0;
        window.MutationObserver = class extends OriginalObserver {
            constructor(callback) {
                super(callback);
                created += 1;
            }
        };
        try {
            modal.querySelector('button').click();
            expect(created).toBe(1);
        } finally {
            window.MutationObserver = OriginalObserver;
        }
    });
});

describe('Missing Mats Marketplace click — character switch mid-poll', () => {
    // Same colour/material shape as the block above; only the poll and the
    // switch timing matter here.
    const CREDIT = '/items/blue_guild_credit';
    const BAR = '/items/blue_bar';

    function buildShrineModal(required) {
        document.body.innerHTML = '';
        const modal = document.createElement('div');
        modal.className = 'GuildPanel_guildModalContent__x';
        modal.innerHTML = `
            <div class="GuildPanel_level__x">Lv. 3</div>
            <button>Upgrade</button>
            <div class="GuildPanel_itemRequirements__x">
                <div class="Item_itemContainer__x"><svg><use href="/sprite.svg#blue_guild_credit"></use></svg></div>
                <div class="GuildPanel_inputCount__x">${required}</div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    const missingButton = (modal) =>
        [...modal.querySelectorAll('.mwi-shrine-cost button')].find(
            (b) => b.textContent === 'Missing Mats Marketplace'
        );

    beforeEach(() => {
        game.settings = {};
        game.prices = { [BAR]: { ask: 100, bid: 90 } };
        game.clientData = {
            itemDetailMap: {
                [CREDIT]: { name: 'Blue Guild Credit' },
                [BAR]: {
                    name: 'Blue Bar',
                    guildCreditConversions: [{ creditItemHrid: CREDIT, itemCount: 1, creditCount: 10 }],
                },
            },
        };
        game.inventory = [{ itemHrid: CREDIT, itemLocationHrid: '/item_locations/inventory', count: 0 }];
        marketplaceTabs.tabsContainer = null;
        marketplaceTabs.createdTabs = [];
        marketplaceTabs.removeShrineCalls = 0;
        marketplaceTabs.navigateToMarketListingsCalls = 0;
        guildCreditValue.initialize();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        guildCreditValue.cleanup();
        resetListeners();
        document.body.innerHTML = '';
    });

    /** A live marketplace tablist with the "My Listings" tab the poll looks for */
    function marketplaceTabsContainer() {
        const container = document.createElement('div');
        const myListings = document.createElement('button');
        myListings.textContent = 'My Listings';
        container.appendChild(myListings);
        return container;
    }

    test('a character switch mid-poll stops the departed character from getting tabs', async () => {
        const modal = buildShrineModal(156_000); // 15,600 bars short of 0 held
        game.observers['GuildPanel_guildModalContent'](modal);
        const button = missingButton(modal);
        expect(button).toBeTruthy();

        const clickDone = (async () => {
            button.click();
            // The click handler's own `addEventListener('click', async () => …)`
            // runs detached from this call; give the microtask queue a turn so
            // it actually starts (captures `switchGeneration`) before the switch.
            await Promise.resolve();
        })();
        await clickDone;

        // Let a couple of poll ticks pass with no tablist yet — the ordinary
        // "still loading" case — then the character switch lands: feature
        // teardown runs (as feature-registry's disable() does) while the poll
        // is still waiting.
        await vi.advanceTimersByTimeAsync(300);
        expect(marketplaceTabs.createdTabs).toHaveLength(0);
        guildCreditValue.cleanup();

        // Only now does the marketplace tablist for the *new* character
        // finally mount — the stale poll is still running and about to find it.
        marketplaceTabs.tabsContainer = marketplaceTabsContainer();
        await vi.advanceTimersByTimeAsync(2000);

        // The poll found a tabsContainer, but the generation guard must have
        // stopped it from building tabs out of the departed character's mats.
        expect(marketplaceTabs.createdTabs).toHaveLength(0);
    });

    test('without a character switch, the same poll does build the tabs', async () => {
        const modal = buildShrineModal(156_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        const button = missingButton(modal);

        button.click();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(300);
        expect(marketplaceTabs.createdTabs).toHaveLength(0);

        marketplaceTabs.tabsContainer = marketplaceTabsContainer();
        await vi.advanceTimersByTimeAsync(2000);

        expect(marketplaceTabs.createdTabs.length).toBeGreaterThan(0);
    });

    test('the shrine tabs get a clear-all control that sweeps the shrine tabs (opted out of removeMaterialTabs) and lands back on Market Listings', async () => {
        const modal = buildShrineModal(156_000);
        game.observers['GuildPanel_guildModalContent'](modal);
        const button = missingButton(modal);

        button.click();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(300);

        marketplaceTabs.tabsContainer = marketplaceTabsContainer();
        await vi.advanceTimersByTimeAsync(2000);

        const container = marketplaceTabs.tabsContainer;
        const clearAll = container.querySelector('[data-mwi-clear-all-tab="true"]');
        expect(clearAll).toBeTruthy();

        // Tab creation itself already swept once (clearing whatever a previous
        // open left); the click below is the count that matters here.
        const removeShrineCallsBeforeClick = marketplaceTabs.removeShrineCalls;
        clearAll.click();

        // The shrine sweep is explicit — a shrine tab opts out of the shared
        // `data-mwi-custom-tab` cleanup precisely so it survives tab-to-tab
        // navigation, so the clear-all control must call `removeShrineMarketTabs`
        // itself rather than rely on `removeMaterialTabs`.
        expect(marketplaceTabs.removeShrineCalls).toBe(removeShrineCallsBeforeClick + 1);
        expect(marketplaceTabs.navigateToMarketListingsCalls).toBe(1);
        expect(autofill.clearQuantity).toHaveBeenCalled();
    });
});

describe('the missing-mats autofill manager', () => {
    beforeEach(() => {
        game.settings = { guildCreditValue: true };
        game.observers = {};
        game.clientData = { itemDetailMap: {} };
        guildCreditValue.cleanup();
        autofill.cleanup.mockClear();
    });

    // The autofill manager's own `initialize()` registers a `domObserver.onClass`
    // watcher on every buy modal for the lifetime of the page unless something
    // calls its `cleanup()` — every other feature that owns one
    // (missing-materials-button.js, house-cost-display.js, ability-book-calculator.js)
    // calls `this.autofillManager.cleanup()` from its own `cleanup()`. This one did
    // not, so disabling "Guild Credit Value" — or a character switch, which runs
    // the same cleanup/re-initialize cycle — left the watcher (and whatever
    // quantity intent it last held) running forever.
    test('is torn down when the feature is disabled', () => {
        guildCreditValue.initialize();
        guildCreditValue.cleanup();

        expect(autofill.cleanup).toHaveBeenCalledTimes(1);
    });
});
