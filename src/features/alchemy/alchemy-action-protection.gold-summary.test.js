/**
 * The "Gold for N" summary caps N by how many bulk actions the held items can
 * sustain. `maxFromItems` used `Math.ceil(itemCount / bulkMultiplier)`, which
 * overstates that cap whenever the stack isn't an exact multiple of the bulk
 * size: a bulk action consumes `bulkMultiplier` items per attempt, so a
 * leftover remainder cannot fund one more action.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { on: () => {}, off: () => {}, onClass: () => () => {} },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (_k, _s, fallback) => fallback,
        setJSON: async () => true,
    },
}));
vi.mock('../actions/action-panel-sort.js', () => ({ default: {} }));
vi.mock('../../utils/bundle-bridge.js', () => ({ actionPanelSort: () => null }));
vi.mock('../../utils/alchemy-fees.js', () => ({ getAlchemyCoinCost: () => 10 }));
vi.mock('../../utils/formatters.js', () => ({ formatLargeNumber: (n) => String(n) }));
vi.mock('../../utils/panel-z-index.js', () => ({
    PANEL_Z_CAP: 1000,
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

const dm = vi.hoisted(() => ({
    inventory: [],
    itemDetails: {},
    actions: [],
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char-1',
        getItemDetails: (hrid) => dm.itemDetails[hrid] ?? null,
        getInventory: () => dm.inventory,
        getCurrentActions: () => dm.actions,
        getInitClientData: () => ({}),
        on: () => {},
        off: () => {},
    },
}));

const { alchemyActionProtection } = await import('./alchemy-action-protection.js');

/**
 * Build the DOM `_doUpdateGoldSummary` reads from: a selected alchemy tab and
 * the item currently loaded into the action's requirement slot.
 * @param {string} itemName - The item's HRID tail, e.g. 'thing' for '/items/thing'
 * @returns {HTMLElement} The alchemy panel component
 */
function buildAlchemyComponent(itemName) {
    document.body.innerHTML = `
        <div class="AlchemyPanel_tabsComponentContainer">
            <div role="tab" aria-selected="true">Decompose</div>
        </div>
        <div id="alchemyComponent">
            <div class="SkillActionDetail_itemRequirements">
                <div class="Item_itemContainer">
                    <svg><use href="#${itemName}"></use></svg>
                </div>
            </div>
        </div>
    `;
    return document.getElementById('alchemyComponent');
}

describe('the gold summary caps by whole actions the item stock can sustain', () => {
    beforeEach(() => {
        // The tracker caches inventory totals until the next items_updated
        // event, which never fires in this test — drop the cache so each
        // test's own inventory is what gets read.
        alchemyActionProtection._inventoryTotals = null;
    });

    test('a stack that is not an exact multiple of the bulk size floors, not ceils', () => {
        dm.itemDetails = { '/items/thing': { alchemyDetail: { bulkMultiplier: 3 } } };
        dm.inventory = [{ itemLocationHrid: '/item_locations/inventory', itemHrid: '/items/thing', count: 7 }];
        dm.actions = [];

        const alchemyComponent = buildAlchemyComponent('thing');
        alchemyActionProtection._doUpdateGoldSummary(alchemyComponent);

        const summary = alchemyComponent.querySelector('.mwi-alchemy-gold-summary');
        expect(summary).not.toBeNull();
        // 7 items at bulk 3 sustains 2 full actions, not 3 — ceil would have
        // read "Gold for all: 30 / 0", floor reads 20
        expect(summary.textContent).toBe('Gold for all: 20 / 0');
    });

    test('an exact multiple is unaffected by the rounding direction', () => {
        dm.itemDetails = { '/items/thing': { alchemyDetail: { bulkMultiplier: 3 } } };
        dm.inventory = [{ itemLocationHrid: '/item_locations/inventory', itemHrid: '/items/thing', count: 9 }];
        dm.actions = [];

        const alchemyComponent = buildAlchemyComponent('thing');
        alchemyActionProtection._doUpdateGoldSummary(alchemyComponent);

        const summary = alchemyComponent.querySelector('.mwi-alchemy-gold-summary');
        expect(summary.textContent).toBe('Gold for all: 30 / 0');
    });
});

describe('the gold summary reads the action actually running, not the array-first one', () => {
    beforeEach(() => {
        alchemyActionProtection._inventoryTotals = null;
    });

    test('a repeat requeued to the front of the array carries a higher ordinal, and must be skipped', () => {
        // Bulk 1 and a huge item stack, so neither queued count is capped by
        // `maxFromItems` — whichever action's `hasMaxCount` remainder wins is
        // what the summary reads out.
        dm.itemDetails = { '/items/thing': { alchemyDetail: { bulkMultiplier: 1 } } };
        dm.inventory = [{ itemLocationHrid: '/item_locations/inventory', itemHrid: '/items/thing', count: 1000 }];
        dm.actions = [
            // Array-first, but requeued to the front on its last repeat — a
            // HIGHER ordinal than the one actually running.
            {
                actionHrid: '/actions/alchemy/decompose',
                primaryItemHash: 'char-1::/item_locations/inventory::/items/thing::0',
                isDone: false,
                ordinal: 5,
                hasMaxCount: true,
                maxCount: 100,
                currentCount: 0,
            },
            // Array-second, lower ordinal: this is the one actually running.
            {
                actionHrid: '/actions/alchemy/decompose',
                primaryItemHash: 'char-1::/item_locations/inventory::/items/thing::0',
                isDone: false,
                ordinal: 2,
                hasMaxCount: true,
                maxCount: 10,
                currentCount: 5,
            },
        ];

        const alchemyComponent = buildAlchemyComponent('thing');
        alchemyActionProtection._doUpdateGoldSummary(alchemyComponent);

        const summary = alchemyComponent.querySelector('.mwi-alchemy-gold-summary');
        // The running action has 10 - 5 = 5 left, at a mocked cost of 10 each:
        // "Gold for 5: 50 / 0". Reading the array-first action instead (100
        // left) would print "Gold for 100: 1000 / 0".
        expect(summary.textContent).toBe('Gold for 5: 50 / 0');
    });
});
