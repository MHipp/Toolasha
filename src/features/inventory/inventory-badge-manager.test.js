/** @vitest-environment happy-dom */
/**
 * Inventory Badge Manager — the name→HRID reverse lookup (including the
 * ★ ↔ (R) refined-item aliasing) and the crafting-cost fallback used when an
 * item has no market data. Badge rendering/provider orchestration is DOM
 * glue and not exercised here, except `itemHasBadges`, which is a one-line
 * DOM query worth pinning against real elements.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initData: null,
    prices: {},
    inventory: [],
    priceBatch: new Map(),
    yieldSpy: null,
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback, isFeatureEnabled: () => false },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPricesBatch: () => mocks.priceBatch, getPrice: () => null },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => mocks.initData, getInventory: () => mocks.inventory },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../networth/networth-cache.js', () => ({ default: { get: () => null, set: () => {} } }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: { isInitialized: false } }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => mocks.prices[hrid] ?? null }));
vi.mock('../../utils/number-parser.js', () => ({
    parseItemCount: (text) => parseInt(text, 10) || 0,
    MAGNITUDE_SUFFIXES: { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 },
}));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/background-work.js', () => ({
    yieldToEventLoop: (mocks.yieldSpy = vi.fn(() => Promise.resolve())),
}));

const { default: inventoryBadgeManager } = await import('./inventory-badge-manager.js');

beforeEach(() => {
    mocks.initData = { itemDetailMap: {} };
    mocks.prices = {};
    mocks.inventory = [];
    mocks.priceBatch = new Map();
    mocks.yieldSpy.mockClear();
    inventoryBadgeManager.nameToHridMap = null;
});

describe('buildNameToHridMap / findItemHrid', () => {
    test('finds an item by its exact display name', () => {
        const gameData = { itemDetailMap: { '/items/cheese': { name: 'Cheese' } } };
        expect(inventoryBadgeManager.findItemHrid('Cheese', gameData)).toBe('/items/cheese');
    });

    test('a (R) refined name also resolves via the ★ alias, and vice versa', () => {
        const gameData = {
            itemDetailMap: {
                '/items/cheese_refined': { name: 'Cheese (R)' },
            },
        };
        expect(inventoryBadgeManager.findItemHrid('Cheese ★', gameData)).toBe('/items/cheese_refined');
        expect(inventoryBadgeManager.findItemHrid('Cheese (R)', gameData)).toBe('/items/cheese_refined');
    });

    test('a ★ name in game data aliases back to (R)', () => {
        const gameData = { itemDetailMap: { '/items/gem_refined': { name: 'Gem ★' } } };
        expect(inventoryBadgeManager.findItemHrid('Gem (R)', gameData)).toBe('/items/gem_refined');
    });

    test('an unknown name returns null rather than throwing', () => {
        expect(inventoryBadgeManager.findItemHrid('Nonexistent Item', { itemDetailMap: {} })).toBeNull();
    });

    test('the map is built once and reused on subsequent lookups', () => {
        const gameData = { itemDetailMap: { '/items/a': { name: 'A' } } };
        inventoryBadgeManager.findItemHrid('A', gameData);
        expect(inventoryBadgeManager.nameToHridMap.size).toBeGreaterThan(0);

        // Even with different (now-irrelevant) game data, the cached map still answers
        inventoryBadgeManager.findItemHrid('A', { itemDetailMap: {} });
        expect(inventoryBadgeManager.findItemHrid('A', { itemDetailMap: {} })).toBe('/items/a');
    });

    test('missing itemDetailMap does not throw and leaves the map empty', () => {
        inventoryBadgeManager.buildNameToHridMap(null);
        expect(inventoryBadgeManager.nameToHridMap.size).toBe(0);
    });
});

describe('calculateCraftingCost', () => {
    test('sums input costs at ask price, applies the 0.9x artisan reduction, adds upgrade cost, divides by output count', () => {
        mocks.initData = {
            actionDetailMap: {
                '/actions/craft/thing': {
                    upgradeItemHrid: '/items/rune',
                    inputItems: [{ itemHrid: '/items/wood', count: 4 }],
                    outputItems: [{ itemHrid: '/items/thing', count: 2 }],
                },
            },
        };
        mocks.prices = { '/items/wood': 10, '/items/rune': 100 };

        const cost = inventoryBadgeManager.calculateCraftingCost('/items/thing');
        // (4*10*0.9 + 100) / 2 = 68
        expect(cost).toBe(68);
    });

    test('an item with no producing action returns 0', () => {
        mocks.initData = { actionDetailMap: {} };
        expect(inventoryBadgeManager.calculateCraftingCost('/items/nothing')).toBe(0);
    });

    test('missing game data returns 0 rather than throwing', () => {
        mocks.initData = null;
        expect(inventoryBadgeManager.calculateCraftingCost('/items/anything')).toBe(0);
    });
});

describe('renderAllBadges cooldown/concurrency', () => {
    afterEach(() => {
        inventoryBadgeManager.currentInventoryElem = null;
        inventoryBadgeManager.isRendering = false;
        inventoryBadgeManager.lastRenderTime = 0;
    });

    test('a call that bails because a render is already in flight does not consume the cooldown', async () => {
        inventoryBadgeManager.currentInventoryElem = document.createElement('div');
        inventoryBadgeManager.lastRenderTime = 0;
        inventoryBadgeManager.isRendering = true;

        await inventoryBadgeManager.renderAllBadges();

        // Bailing on a concurrent render must not itself count as a render — a
        // burst of triggers while one is in flight would otherwise keep pushing
        // `lastRenderTime` forward, and the first REAL render after the
        // in-flight one finishes would then find itself still inside a
        // cooldown that was never actually spent rendering anything.
        expect(inventoryBadgeManager.lastRenderTime).toBe(0);
    });
});

describe('itemHasBadges', () => {
    test('detects a bid price badge', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="mwi-badge-price-bid"></div>';
        expect(inventoryBadgeManager.itemHasBadges(el)).toBe(true);
    });

    test('detects an ask price badge', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="mwi-badge-price-ask"></div>';
        expect(inventoryBadgeManager.itemHasBadges(el)).toBe(true);
    });

    test('detects a stack price badge', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="mwi-stack-price"></div>';
        expect(inventoryBadgeManager.itemHasBadges(el)).toBe(true);
    });

    test('an element with none of the badge classes reports false', () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="something-else"></div>';
        expect(inventoryBadgeManager.itemHasBadges(el)).toBe(false);
    });
});

describe('calculateItemPrices time-slicing', () => {
    /**
     * A single inventory item element shaped the way the pricing loop reads it:
     * an SVG carrying the item's display name and a stack-count node.
     * @param {string} name - Display name matched back to an HRID
     * @param {number} count - Stack size
     * @returns {HTMLElement} The item container
     */
    function itemEl(name, count) {
        const el = document.createElement('div');
        el.className = 'Item_itemContainer';
        const svg = document.createElement('svg');
        svg.setAttribute('aria-label', name);
        el.appendChild(svg);
        const countEl = document.createElement('div');
        countEl.className = 'Item_count';
        countEl.textContent = String(count);
        el.appendChild(countEl);
        return el;
    }

    beforeEach(() => {
        mocks.initData = { itemDetailMap: { '/items/cheese': { name: 'Cheese' } } };
        mocks.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 5, enhancementLevel: 0 },
        ];
        mocks.priceBatch = new Map([['/items/cheese:0', { ask: 100, bid: 90 }]]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('prices every item and hands the thread back once per slice that runs long', async () => {
        // Force every iteration over the budget so the loop yields deterministically
        vi.spyOn(performance, 'now').mockImplementation(
            (() => {
                let t = 0;
                return () => (t += 100);
            })()
        );

        const items = [itemEl('Cheese', 5), itemEl('Cheese', 5), itemEl('Cheese', 5)];
        await inventoryBadgeManager.calculateItemPrices(items, mocks.inventory, new Map());

        // Every item still gets its full dataset — the work is spread, not skipped
        for (const el of items) {
            expect(el.dataset.askPrice).toBe('100');
            expect(el.dataset.bidPrice).toBe('90');
            expect(el.dataset.askValue).toBe('500');
            expect(el.dataset.bidValue).toBe('450');
        }

        // One yield per item, since each slice was forced over budget
        expect(mocks.yieldSpy).toHaveBeenCalledTimes(items.length);
    });

    test('does not yield when the whole loop fits inside one budget', async () => {
        // A clock that never advances: no slice ever exceeds the budget
        vi.spyOn(performance, 'now').mockReturnValue(0);

        const items = [itemEl('Cheese', 5), itemEl('Cheese', 5)];
        await inventoryBadgeManager.calculateItemPrices(items, mocks.inventory, new Map());

        expect(items[0].dataset.askValue).toBe('500');
        expect(mocks.yieldSpy).not.toHaveBeenCalled();
    });
});
