/** @vitest-environment happy-dom */
/**
 * Sell Queue — the hovered-item tracking it does through the shared tooltip
 * observer, and the Shift+RightClick that reads it. Tab injection and
 * marketplace navigation are not exercised here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));
const tabsState = vi.hoisted(() => ({
    /** What `visibleTabsContainer` reports; null keeps addToQueue away from the marketplace */
    container: null,
    /** Every `handleMarketplaceCleanup` handed to the cleanup watchdog, and its unregister */
    cleanups: [],
    unregisters: [],
}));
/** The `*` websocket subscriber the queue installs for its first item */
const socketState = vi.hoisted(() => ({ handler: null }));
const dataManagerMock = vi.hoisted(() => ({
    getInitClientData: () => ({
        itemDetailMap: { '/items/cheese': { name: 'Cheese', isTradable: true } },
    }),
    // Nothing in the bag by default: addToQueue returns before touching the marketplace
    inventory: [],
    getInventory: () => dataManagerMock.inventory,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (_event, handler) => {
            socketState.handler = handler;
        },
        off: () => {
            socketState.handler = null;
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
/**
 * The reservation ledger, doubled. The queue is the one consumer that RELEASES
 * stock: an item on its way out of the bag is not a crafting material, and what
 * is asserted here is that the whole held count is held back while it is
 * queued, and given back when the queue goes.
 */
const ledger = vi.hoisted(() => ({ reserved: [], released: [] }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    reserve: async (ownerId, lines) => {
        ledger.reserved.push({ ownerId, lines });
        return true;
    },
    release: async (ownerId) => {
        ledger.released.push(ownerId);
        return true;
    },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    // Shaped like the real tab: the sold-out sweep finds a tab by its
    // `data-item-hrid` and writes the badge into the badge span
    createMaterialTab: vi.fn((material) => {
        const tab = document.createElement('div');
        tab.setAttribute('data-item-hrid', material.itemHrid);
        const badge = document.createElement('span');
        badge.className = 'TabsComponent_badge__1Ei-x';
        tab.appendChild(badge);
        return tab;
    }),
    removeMaterialTabs: vi.fn(),
    setupMarketplaceCleanupObserver: vi.fn((onCleanup) => {
        tabsState.cleanups.push(onCleanup);
        const unregister = vi.fn();
        tabsState.unregisters.push(unregister);
        return unregister;
    }),
    navigateToMarketplace: vi.fn(),
    visibleTabsContainer: () => tabsState.container,
}));

const { default: sellQueue, navigationBlocked } = await import('./sell-queue.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @returns {HTMLElement}
 */
function popper(innerHTML) {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = innerHTML;
    document.body.appendChild(el);
    return el;
}

/**
 * Shift+RightClick an inventory slot; whether it was taken says whether an
 * item was being tracked
 * @returns {boolean} The event's defaultPrevented
 */
function shiftRightClickInventory() {
    const inventory = document.createElement('div');
    inventory.className = 'Inventory_items__1';
    const slot = document.createElement('div');
    inventory.appendChild(slot);
    document.body.appendChild(inventory);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true });
    slot.dispatchEvent(event);
    return event.defaultPrevented;
}

beforeEach(() => {
    document.body.innerHTML = '';
    tabsState.container = null;
    tabsState.cleanups.length = 0;
    tabsState.unregisters.length = 0;
    dataManagerMock.inventory = [];
    socketState.handler = null;
    sellQueue.initialize();
});

afterEach(() => {
    sellQueue.cleanup();
    tooltipObserver.disable();
});

describe('hovered item tracking through the tooltip observer', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('SellQueue-Tooltip')).toBe(true);
    });

    test('an item named by its link is queued on Shift+RightClick', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('an item named by its sprite is queued on Shift+RightClick', () => {
        observerState.handler(popper('<svg><use href="/static/media/items_sprite.abc.svg#cheese"></use></svg>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('an item named only in the tooltip text is slugged to its hrid', () => {
        observerState.handler(popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>'));
        expect(shiftRightClickInventory()).toBe(true);
    });

    test('a tooltip without an item clears the tracked one', () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        observerState.handler(popper('<div>Just text</div>'));
        expect(shiftRightClickInventory()).toBe(false);
    });

    test('cleanup unsubscribes', () => {
        sellQueue.cleanup();
        expect(tooltipObserver.subscribers.has('SellQueue-Tooltip')).toBe(false);
    });
});

describe('the auto-advance waits for the player', () => {
    /**
     * A document stub: the queue's gate only asks two things of it.
     * @param {Object} over - What this document has open / focused
     * @returns {Document} Enough of one
     */
    const doc = ({ modal = false, activeElement = null } = {}) => ({
        querySelector: (selector) => (modal && selector.includes('Modal_modalContainer') ? {} : null),
        activeElement,
    });

    test('an open modal blocks it', () => {
        // The advance is driven by a websocket message, so it can land in the
        // middle of the player pricing something else entirely
        expect(navigationBlocked(doc({ modal: true }))).toBe(true);
    });

    test('a focused text or number field blocks it', () => {
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => 'number' } }))).toBe(
            true
        );
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => null } }))).toBe(true);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'TEXTAREA', getAttribute: () => null } }))).toBe(true);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'DIV', isContentEditable: true } }))).toBe(true);
    });

    test('an ordinary page is not blocked', () => {
        expect(navigationBlocked(doc())).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'BODY', getAttribute: () => null } }))).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'BUTTON', getAttribute: () => null } }))).toBe(false);
        expect(navigationBlocked(doc({ activeElement: { tagName: 'INPUT', getAttribute: () => 'checkbox' } }))).toBe(
            false
        );
    });
});

/**
 * The queue's cleanup watchdog is registered on the first queued item and torn
 * down when the marketplace closes. It used to be registered again on the next
 * first item without the previous one ever being stopped.
 */
describe('the marketplace cleanup watchdog', () => {
    /** A marketplace tab strip the queue accepts as "already in the market" */
    function marketplaceStrip() {
        const container = document.createElement('div');
        const myListings = document.createElement('button');
        myListings.textContent = 'My Listings';
        const marketListings = document.createElement('button');
        marketListings.textContent = 'Market Listings';
        container.append(myListings, marketListings);
        document.body.appendChild(container);
        return container;
    }

    /** Track a hovered Cheese and Shift+RightClick it into the queue */
    function queueCheese() {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
    }

    beforeEach(() => {
        tabsState.container = marketplaceStrip();
        dataManagerMock.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 12 },
        ];
    });

    test('one watch is registered for the first queued item', () => {
        queueCheese();
        expect(tabsState.cleanups.length).toBe(1);
    });

    test('a queue cycle after the marketplace closed does not leave the previous watch running', () => {
        queueCheese();
        // The watchdog notices the player navigated away, and tears the session down
        tabsState.cleanups[0]();

        // Queueing again starts a fresh session — and the old watch must be gone,
        // not left polling the same module-level tab array this one refills
        queueCheese();

        expect(tabsState.cleanups.length).toBe(2);
        expect(tabsState.unregisters[0]).toHaveBeenCalled();
    });

    test('disabling the feature leaves no watch behind', () => {
        queueCheese();
        sellQueue.cleanup();
        expect(tabsState.unregisters.every((unregister) => unregister.mock.calls.length > 0)).toBe(true);
    });
});

describe('what the queue holds back from every other plan', () => {
    /** A marketplace tab strip the queue accepts as "already in the market" */
    function marketplaceStrip() {
        const container = document.createElement('div');
        const myListings = document.createElement('button');
        myListings.textContent = 'My Listings';
        const marketListings = document.createElement('button');
        marketListings.textContent = 'Market Listings';
        container.append(myListings, marketListings);
        document.body.appendChild(container);
        return container;
    }

    beforeEach(() => {
        ledger.reserved = [];
        ledger.released = [];
        tabsState.container = marketplaceStrip();
        dataManagerMock.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 12 },
        ];
    });

    test('queueing an item claims every plain copy of it in the bag', async () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
        await Promise.resolve();
        await Promise.resolve();

        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'sellQueue',
            lines: [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 12 }],
        });
    });

    /*
     * The queue only ever navigates to `(hrid, 0)`, so an enhanced copy is not
     * stock it can sell — claiming it would hold back a crafting material for a
     * sale that will never happen.
     */
    test('enhanced copies of a queued item are not claimed', async () => {
        dataManagerMock.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 12 },
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 5,
                count: 3,
            },
        ];

        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
        await Promise.resolve();
        await Promise.resolve();

        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'sellQueue',
            lines: [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 12 }],
        });
    });

    test('leaving the marketplace empties the queue and gives the stock back', async () => {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
        await Promise.resolve();
        await Promise.resolve();

        tabsState.cleanups.at(-1)();
        expect(ledger.released).toContain('sellQueue');
    });

    /*
     * `addToQueue` awaits the reservation write (and, on a cold start, the
     * marketplace opening) while the queue it is building is module state
     * anybody can tear down. Resuming blind acted on a session that is gone.
     */
    test('a teardown mid-claim abandons the add rather than acting on a dead session', async () => {
        const { navigateToMarketplace } = await import('../../utils/marketplace-tabs.js');
        navigateToMarketplace.mockClear();

        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
        // The player leaves the marketplace while the claim is still in flight
        tabsState.cleanups.at(-1)();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // No yanking the panel back to an item nobody is queueing any more
        expect(navigateToMarketplace).not.toHaveBeenCalled();
        // And the claim that landed after the teardown's release is given back,
        // rather than holding stock for a queue that no longer exists
        expect(ledger.released.filter((owner) => owner === 'sellQueue').length).toBeGreaterThan(1);
    });
});

/*
 * The queue sells plain copies and nothing else, so every count it shows or
 * acts on is the level-0 one. Counting all levels stranded it: a player holding
 * 1 plain and 5 enhanced sold the plain copy, the count stayed at 5, and the
 * tab never retired.
 */
describe('the tab badge and the sold-out check count plain copies only', () => {
    /** A marketplace tab strip the queue accepts as "already in the market" */
    function marketplaceStrip() {
        const container = document.createElement('div');
        const myListings = document.createElement('button');
        myListings.textContent = 'My Listings';
        const marketListings = document.createElement('button');
        marketListings.textContent = 'Market Listings';
        container.append(myListings, marketListings);
        document.body.appendChild(container);
        return container;
    }

    /** Queue the hovered item and let addToQueue's awaits settle. */
    async function queueCheese() {
        observerState.handler(popper('<a href="/items/cheese">Cheese</a>'));
        shiftRightClickInventory();
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        ledger.reserved = [];
        tabsState.container = marketplaceStrip();
    });

    test('the badge shows the plain count, not the plain and enhanced together', async () => {
        dataManagerMock.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 1 },
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 5,
                count: 5,
            },
        ];

        await queueCheese();

        const badge = document.querySelector('[data-item-hrid="/items/cheese"] [class*="TabsComponent_badge"]');
        expect(badge.innerHTML).toContain('In bag: 1');
        expect(badge.innerHTML).not.toContain('In bag: 6');
    });

    test('the tab retires once the plain copies are gone, enhanced ones notwithstanding', async () => {
        dataManagerMock.inventory = [
            { itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 1 },
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 5,
                count: 5,
            },
        ];

        await queueCheese();
        expect(document.querySelector('[data-item-hrid="/items/cheese"]')).not.toBeNull();

        // The plain copy sells; the +5 stays in the bag
        dataManagerMock.inventory = [
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 5,
                count: 5,
            },
        ];
        socketState.handler({ type: 'items_updated' });

        expect(document.querySelector('[data-item-hrid="/items/cheese"]')).toBeNull();
    });

    test('an item with only enhanced copies is not queued at all', async () => {
        dataManagerMock.inventory = [
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 5,
                count: 5,
            },
        ];

        await queueCheese();

        expect(document.querySelector('[data-item-hrid="/items/cheese"]')).toBeNull();
        expect(ledger.reserved).toHaveLength(0);
    });
});
