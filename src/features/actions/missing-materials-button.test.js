/** @vitest-environment happy-dom
 *
 * A bill of materials that is not an action's — a house level's, or the pieces
 * a cross-slot gear swap buys — opened as the same marketplace tabs the
 * action-panel button builds.
 *
 * What is worth asserting is the mapping: totals against what the inventory
 * holds (unenhanced copies only, unless the line names a level), nothing
 * reserved for the queue, a line the game does not know still named from its
 * hrid.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    items: {},
    unclaimed: {},
    // What `calculateMaterialRequirements` hands back to the click handlers —
    // a test sets this before driving `openMissingMaterials`.
    actionMaterials: [],
    autofill: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        setPendingCalculation: vi.fn(),
        clearQuantity: vi.fn(),
    },
    wsOn: vi.fn(),
    wsOff: vi.fn(),
    // Off unless a test asks for the Tester shop hand-off
    testerShop: false,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: (hrid) => state.items[hrid] || null,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({
    default: { on: (...args) => state.wsOn(...args), off: (...args) => state.wsOff(...args) },
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: () => null,
    attachInputListeners: () => {},
    performInitialUpdate: () => {},
    onActionPanelsRefresh: () => () => {},
    onDetailPanel: () => () => {},
    resolveDetailPanel: () => ({
        panel: null,
        nameElement: null,
        actionName: '',
        actionHrid: null,
        actionDetails: null,
    }),
}));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: () => state.actionMaterials,
    calculateEnhancementMaterialRequirements: () => [],
    unclaimedBoughtCount: (itemHrid) => state.unclaimed?.[itemHrid] || 0,
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => state.autofill,
    findQuantityInput: () => null,
}));
// marketplace-tabs.js itself is NOT mocked — its tab creation, dismiss button,
// and clear-all control are exercised for real, the same way lab-sim-ui.test.js
// drives it, so this file is testing the actual DOM the player sees rather than
// a stand-in for it.
vi.mock('./enhancement-display.js', () => ({
    getProtectionItemFromUI: () => null,
    getProtectFromLevelFromUI: () => 0,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => ({ disconnect: () => {} }) }));
vi.mock('../../utils/game-lookups.js', () => ({ getActionHridFromName: () => null }));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => state.testerShop,
    // Every line of the test bill is sold, so the whole bill takes the shop path
    testerShopCoinCost: () => (state.testerShop ? 100 : 0),
}));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: () => {} }));

/**
 * The reservation ledger, doubled at the seam. Its arithmetic belongs to
 * `utils/inventory-reservations.test.js`; what matters here is that the bill
 * nets off other owners and never itself, that the open tabs claim what they
 * are asking for and give it back on the way out, and that a bill built with
 * no owner at all is the bill this file has always asserted.
 */
const ledger = vi.hoisted(() => ({ claims: {}, reserved: [], released: [] }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    reservedElsewhere: (itemHrid, level, { excludeOwner } = {}) => {
        let total = 0;
        for (const [owner, byKey] of Object.entries(ledger.claims)) {
            if (owner === excludeOwner) continue;
            total += byKey[`${itemHrid}|${level}`] || 0;
        }
        return total;
    },
    effectiveInventory: (itemHrid, level, { excludeOwner, held } = {}) => {
        let total = 0;
        for (const [owner, byKey] of Object.entries(ledger.claims)) {
            if (owner === excludeOwner) continue;
            total += byKey[`${itemHrid}|${level}`] || 0;
        }
        return Math.max(0, held - total);
    },
    shortfallNote: (short) => `${short} short — reserved by "Goal: Cheese sword"`,
    reserve: async (ownerId, lines) => {
        ledger.reserved.push({ ownerId, lines });
        return true;
    },
    release: (ownerId) => {
        ledger.released.push(ownerId);
        return Promise.resolve(true);
    },
}));

const { materialsFromList, openMaterialsList, openMissingMaterials } = await import('./missing-materials-button.js');

describe('a bill of materials against the inventory', () => {
    test('each line is what is needed less the unenhanced copies held', () => {
        state.items = {
            '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true },
            '/items/linen_hat': { name: 'Linen Hat', isTradable: true },
        };
        state.inventory = [
            { itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 },
            { itemHrid: '/items/linen_hat', enhancementLevel: 0, count: 4 },
            // An enhanced hat is not a material
            { itemHrid: '/items/linen_hat', enhancementLevel: 3, count: 20 },
        ];

        const materials = materialsFromList([
            { itemHrid: '/items/cedar_lumber', count: 300 },
            { itemHrid: '/items/linen_hat', count: 16 },
        ]);

        expect(materials).toEqual([
            {
                itemHrid: '/items/cedar_lumber',
                itemName: 'Cedar Lumber',
                required: 300,
                have: 120,
                queued: 0,
                available: 120,
                missing: 180,
                isTradeable: true,
                isUpgradeItem: false,
            },
            {
                itemHrid: '/items/linen_hat',
                itemName: 'Linen Hat',
                required: 16,
                have: 4,
                queued: 0,
                available: 4,
                missing: 12,
                isTradeable: true,
                isUpgradeItem: false,
            },
        ]);
    });

    test('items bought but not yet claimed off a buy order count as held', () => {
        state.inventory = [{ itemHrid: '/items/eyessence', count: 1000, enhancementLevel: 0 }];
        state.unclaimed = { '/items/eyessence': 112852 };
        state.items = { '/items/eyessence': { name: 'Eyessence', isTradable: true } };

        const [line] = materialsFromList([{ itemHrid: '/items/eyessence', count: 151275 }]);

        expect(line.have).toBe(113852);
        expect(line.missing).toBe(151275 - 113852);
        state.unclaimed = {};
    });

    test('enough on hand is a line with nothing missing; an unknown item is named from its hrid', () => {
        state.items = { '/items/birch_lumber': { name: 'Birch Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/birch_lumber', count: 500 }];

        const [lumber, mystery] = materialsFromList([
            { itemHrid: '/items/birch_lumber', count: 300 },
            { itemHrid: '/items/odd_thing', count: 2 },
        ]);
        expect(lumber.missing).toBe(0);
        expect(mystery.itemName).toBe('odd thing');
        expect(mystery.isTradeable).toBe(false);
    });

    test('a line that names an enhancement level is counted at that level alone', () => {
        state.items = { '/items/manticore_shield': { name: 'Manticore Shield', isTradable: true } };
        state.inventory = [
            { itemHrid: '/items/manticore_shield', enhancementLevel: 0, count: 3 },
            { itemHrid: '/items/manticore_shield', enhancementLevel: 7, count: 1 },
        ];
        // A buy order for the unenhanced item is not progress towards a +7
        state.unclaimed = { '/items/manticore_shield': 5 };

        const [line] = materialsFromList([{ itemHrid: '/items/manticore_shield', count: 1, enhancementLevel: 7 }]);

        expect(line.enhancementLevel).toBe(7);
        expect(line.have).toBe(1);
        expect(line.missing).toBe(0);
        state.unclaimed = {};
    });

    test('a line without one is the object it has always been', () => {
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 10 }];

        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 30 }]);

        expect('enhancementLevel' in line).toBe(false);
        expect(line.have).toBe(10);
    });

    test('empty or zero lines are dropped, and an empty bill opens nothing', async () => {
        expect(materialsFromList([{ itemHrid: '/items/x', count: 0 }, { count: 3 }, null])).toEqual([]);
        expect(await openMaterialsList([])).toBe(false);
    });
});

/** A navbar marketplace button plus a visible tab strip carrying the two
 * native tabs ("My Listings" is the clone template, "Market Listings" is
 * where a clear-all should land the player). happy-dom does no real layout,
 * so `offsetParent`/`getBoundingClientRect` are stubbed the same way
 * marketplace-tabs.test.js stubs them for `visibleTabsContainer`. */
function buildMarketplaceDom() {
    document.body.innerHTML = '';

    const nav = document.createElement('div');
    nav.className = 'NavigationBar_nav__3uuUl';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-label', 'navigationBar.marketplace');
    nav.appendChild(svg);
    document.body.appendChild(nav);

    const container = document.createElement('div');
    container.className = 'MuiTabs-flexContainer';
    container.setAttribute('role', 'tablist');
    const myListings = document.createElement('button');
    myListings.setAttribute('role', 'tab');
    myListings.textContent = 'My Listings';
    const marketListings = document.createElement('button');
    marketListings.setAttribute('role', 'tab');
    marketListings.textContent = 'Market Listings';
    container.append(myListings, marketListings);
    document.body.appendChild(container);
    Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });
    Object.defineProperty(container, 'getBoundingClientRect', {
        value: () => ({ width: 100 }),
        configurable: true,
    });

    return { container, myListings, marketListings };
}

/**
 * The "Clear" control on the marketplace tab strip — one click retires every
 * pinned material tab, the Return tab, and the quantity armed for the buy
 * dialog, then lands the player back on the plain Market Listings view.
 *
 * marketplace-tabs.js is deliberately not mocked here (see the note above the
 * mocks): this exercises the real tab elements the player sees, the same way
 * lab-sim-ui.test.js does for the sim's own "clear all" control.
 */
describe('the marketplace clear-all control', () => {
    beforeEach(() => {
        state.autofill.setPendingCalculation.mockClear();
        state.autofill.clearQuantity.mockClear();
        state.wsOn.mockClear();
        state.wsOff.mockClear();
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
            { itemHrid: '/items/nail', itemName: 'Nail', missing: 8, required: 8, isTradeable: true },
        ];
    });

    test('is absent before any missing-mats tabs are opened', () => {
        const { container } = buildMarketplaceDom();
        expect(container.querySelector('[data-mwi-clear-all-tab="true"]')).toBeNull();
    });

    test('appears once tabs are opened, and one click removes every custom tab, the armed quantity, and the inventory listener — landing on Market Listings', async () => {
        const { container, marketListings } = buildMarketplaceDom();
        const onMarketListingsClick = vi.fn();
        marketListings.addEventListener('click', onMarketListingsClick);

        await openMissingMaterials('/actions/crafting/plank', 5);

        const materialTabs = container.querySelectorAll('[data-item-hrid]');
        expect(materialTabs.length).toBe(2);
        const clearAll = container.querySelector('[data-mwi-clear-all-tab="true"]');
        expect(clearAll).not.toBeNull();
        // Return tab: a custom tab with no item, distinct from the material tabs and the control
        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        expect(returnTab).toBeTruthy();
        expect(state.wsOn).toHaveBeenCalledWith('*', expect.any(Function));

        clearAll.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(container.querySelectorAll('[data-mwi-custom-tab="true"]').length).toBe(0);
        // Cleared at least once — the click's own teardown, and again (harmlessly)
        // by the delegated "a different native tab was picked" listener once the
        // Market Listings tab click below lands.
        expect(state.autofill.clearQuantity).toHaveBeenCalled();
        expect(state.wsOff).toHaveBeenCalledWith('*', expect.any(Function));
        expect(onMarketListingsClick).toHaveBeenCalledTimes(1);
    });

    test('a bill line’s enhancement level is the listing its tab opens', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = {
            '/items/sundering_crossbow': { name: 'Sundering Crossbow', isTradable: true },
            '/items/manticore_shield': { name: 'Manticore Shield', isTradable: true },
        };
        state.inventory = [];

        await openMaterialsList([
            { itemHrid: '/items/sundering_crossbow', count: 1, enhancementLevel: 7 },
            { itemHrid: '/items/manticore_shield', count: 1, enhancementLevel: 7 },
        ]);

        const tabs = container.querySelectorAll('[data-item-hrid]');
        expect(tabs.length).toBe(2);
        tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/manticore_shield', 7);
    });

    test('a line with no level still opens the unenhanced listing', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [];

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 300 }]);
        container
            .querySelector('[data-item-hrid]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/cedar_lumber', 0);
    });

    test('an upgrade item wanted at a level is counted, named and opened at that level', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = {
            '/items/shard': { name: 'Shard', isTradable: true },
            '/items/furious_spear': { name: 'Furious Spear', isTradable: true },
        };
        // A +10 in the bag is not stock against a +12, and the +0 order book is
        // not where a +12 is bought
        state.inventory = [{ itemHrid: '/items/furious_spear', enhancementLevel: 10, count: 1 }];
        state.actionMaterials = [
            { itemHrid: '/items/shard', itemName: 'Shard', missing: 267, required: 267, isTradeable: true },
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 0,
                required: 1,
                have: 1,
                queued: 0,
                available: 1,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1, { upgradeItemLevel: 12 });

        const spearTab = container.querySelector('[data-item-hrid="/items/furious_spear"]');
        // The +10 stopped counting, so the line is short again
        expect(spearTab.getAttribute('data-missing-quantity')).toBe('1');
        spearTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/furious_spear', 12);
    });

    test('a copy already at the level is stock, and the consumables are untouched by it', async () => {
        const { container } = buildMarketplaceDom();
        state.items = {
            '/items/shard': { name: 'Shard', isTradable: true },
            '/items/furious_spear': { name: 'Furious Spear', isTradable: true },
        };
        state.inventory = [{ itemHrid: '/items/furious_spear', enhancementLevel: 12, count: 1 }];
        state.actionMaterials = [
            { itemHrid: '/items/shard', itemName: 'Shard', missing: 267, required: 267, isTradeable: true },
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 1,
                required: 1,
                have: 0,
                queued: 0,
                available: 0,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1, { upgradeItemLevel: 12 });

        expect(
            container.querySelector('[data-item-hrid="/items/furious_spear"]').getAttribute('data-missing-quantity')
        ).toBe('0');
        // The shards are +0 consumables whatever level the output is wanted at
        expect(container.querySelector('[data-item-hrid="/items/shard"]').getAttribute('data-missing-quantity')).toBe(
            '267'
        );
    });

    test('a caller that names no level gets the bill it always got', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = { '/items/furious_spear': { name: 'Furious Spear', isTradable: true } };
        state.inventory = [];
        state.actionMaterials = [
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 3,
                required: 4,
                have: 1,
                queued: 0,
                available: 1,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1);

        const tab = container.querySelector('[data-item-hrid="/items/furious_spear"]');
        expect(tab.getAttribute('data-missing-quantity')).toBe('3');
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/furious_spear', 0);
    });

    test('a single tab can still be dismissed on its own, leaving the rest (including the clear-all control) in place', async () => {
        const { container } = buildMarketplaceDom();

        await openMissingMaterials('/actions/crafting/plank', 5);

        const [firstTab] = container.querySelectorAll('[data-item-hrid]');
        firstTab
            .querySelector('[data-mwi-tab-dismiss="true"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(container.contains(firstTab)).toBe(false);
        expect(container.querySelectorAll('[data-item-hrid]').length).toBe(1);
        expect(container.querySelector('[data-mwi-clear-all-tab="true"]')).not.toBeNull();
    });
});

/**
 * The Tester shop hand-off pins the same lines into the shop's own strip. Its
 * armings are the same kind the marketplace tabs set — persistent, recomputed
 * on every buy box — so they need the same scope, or they go on filling every
 * later buy box for any item.
 */
describe('the Tester shop strip', () => {
    /** A shop navbar button and a visible strip holding the Tester tab */
    function buildShopDom() {
        document.body.innerHTML = '';

        const nav = document.createElement('div');
        nav.className = 'NavigationBar_nav__3uuUl';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-label', 'navigationBar.shop');
        nav.appendChild(svg);
        document.body.appendChild(nav);

        const container = document.createElement('div');
        container.className = 'MuiTabs-flexContainer';
        container.setAttribute('role', 'tablist');
        const tester = document.createElement('button');
        tester.setAttribute('role', 'tab');
        tester.textContent = 'Tester';
        container.appendChild(tester);
        document.body.appendChild(container);
        Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });

        return { container, tester };
    }

    beforeEach(() => {
        state.autofill.setPendingCalculation.mockClear();
        state.testerShop = true;
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
        ];
    });

    test('clicking a pinned line arms the quantity for that line’s item, not for any buy box', async () => {
        const { container } = buildShopDom();

        await openMissingMaterials('/actions/crafting/plank', 5);

        const tab = container.querySelector('[data-item-hrid="/items/plank"]');
        expect(tab).not.toBeNull();
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(state.autofill.setPendingCalculation).toHaveBeenCalledWith(expect.any(Function), {
            itemHrid: '/items/plank',
        });
    });
});

describe('the open bill and the reservation ledger', () => {
    beforeEach(() => {
        ledger.claims = {};
        ledger.reserved = [];
        ledger.released = [];
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 }];
        state.unclaimed = {};
        state.actionMaterials = [];
    });

    test('a bill with no owner is the bill it has always been, claims or no claims', () => {
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }]);

        expect(line.have).toBe(120);
        expect(line.available).toBe(120);
        expect(line.missing).toBe(0);
        expect(line.reserved).toBeUndefined();
        expect(line.reservedNote).toBeUndefined();
    });

    test('another owner\u2019s claim is not this bill\u2019s to spend, and the tab says whose it is', () => {
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.available).toBe(20);
        expect(line.missing).toBe(80);
        expect(line.reservedNote).toBe('80 short — reserved by "Goal: Cheese sword"');
    });

    test('a bill is never charged its own claim', () => {
        ledger.claims = { missingMats: { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.available).toBe(120);
        expect(line.missing).toBe(0);
    });

    test('an ordinary shortfall carries no note', () => {
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 5 }];
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 3 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.missing).toBe(98);
        expect(line.reservedNote).toBeUndefined();
    });

    test('the tabs on screen claim their required totals, and leaving gives them back', async () => {
        const { container } = buildMarketplaceDom();
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
        ];

        await openMissingMaterials('/actions/crafting/plank', 5);
        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'missingMats',
            lines: [{ itemHrid: '/items/plank', count: 40, enhancementLevel: 0 }],
        });

        container
            .querySelector('[data-mwi-clear-all-tab="true"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(ledger.released).toContain('missingMats');
    });

    test('a bill opened under a caller’s own owner is never re-claimed as the tabs’ own, not even on a live update', async () => {
        buildMarketplaceDom();

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }], {
            ownerId: 'craftingPlan:/items/chair',
        });
        expect(ledger.reserved).toEqual([]);

        // The live-update path recomputes the bill on every inventory message;
        // a second claim there would be this trip competing with itself
        const [, handler] = state.wsOn.mock.calls.at(-1);
        handler({ type: 'items_updated' });

        expect(ledger.reserved.map((entry) => entry.ownerId)).not.toContain('missingMats');
    });
});

/**
 * The live-update path redraws the badge of every pinned tab on each inventory
 * message. It used to redraw it with a second, private copy of
 * `updateTabBadge` that had drifted from the exported one the tabs are built
 * with: the copy dropped the "reserved by …" line, so the note explaining why
 * visible stock is not this bill's to spend vanished on the first message to
 * arrive; and it cleared `tab.title`, wiping the Tester-shop tab's own hint.
 */
describe('a live inventory update redraws a tab without losing what it says', () => {
    /** The marketplace strip, with a badge span on the tab material tabs clone. */
    function marketplaceDomWithBadge() {
        const dom = buildMarketplaceDom();
        dom.myListings.innerHTML = '<span class="TabsComponent_badge__x">My Listings</span>';
        return dom;
    }

    /** Redraw every pinned tab, the way an inventory websocket message does. */
    function fireInventoryUpdate() {
        const [, handler] = state.wsOn.mock.calls.at(-1);
        handler({ type: 'items_updated' });
    }

    beforeEach(() => {
        ledger.claims = {};
        ledger.reserved = [];
        ledger.released = [];
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 }];
        state.unclaimed = {};
        state.actionMaterials = [];
    });

    test('a tab short only because another plan claimed the stock keeps saying so', async () => {
        const { container } = marketplaceDomWithBadge();
        // 120 held against 100 needed, all but 20 of it claimed elsewhere: the line is short
        // for a reason the player can otherwise see no trace of
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }]);
        const tab = container.querySelector('[data-item-hrid="/items/cedar_lumber"]');
        expect(tab.innerHTML).toContain('reserved by');

        fireInventoryUpdate();

        expect(tab.innerHTML).toContain('reserved by');
    });

    test('a tab redrawn keeps the tooltip it was given', async () => {
        const { container } = marketplaceDomWithBadge();

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 300 }]);
        const tab = container.querySelector('[data-item-hrid="/items/cedar_lumber"]');
        // The Tester-shop strip sets exactly this on a line the shop does not stock
        tab.title = 'Not sold in the Tester shop — opens the marketplace';

        fireInventoryUpdate();

        expect(tab.title).toBe('Not sold in the Tester shop — opens the marketplace');
    });
});
