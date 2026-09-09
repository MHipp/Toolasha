/**
 * Sell Queue
 * Shift+RightClick inventory items to queue them for selling.
 * Creates marketplace tabs for each queued item; tabs auto-close when item count hits 0.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import webSocketHook from '../../core/websocket.js';
import {
    createMaterialTab,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
    visibleTabsContainer,
} from '../../utils/marketplace-tabs.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { release, reserve } from '../../utils/inventory-reservations.js';

const timerRegistry = createTimerRegistry();

/**
 * The owner the queue holds its stock under.
 *
 * The queue is the one consumer that RELEASES stock rather than planning to
 * spend it: an item queued for sale is on its way out of the bag, and a
 * crafting plan that counts it as a material is planning against something that
 * will not be there. So the whole held count of every queued item is claimed —
 * not a part of it — for as long as the queue stands.
 */
const RESERVATION_OWNER = 'sellQueue';

/**
 * The only enhancement level the queue can sell.
 *
 * A queue entry is `{itemHrid, itemName}` and nothing else, and every
 * navigation it makes is `navigateToMarketplace(hrid, 0)` — so shift-right-
 * clicking an item queues its plain copies, never the +5 sitting beside them.
 * Everything the queue counts is counted at this level: the claim, the tab
 * badge's "In bag", the sold-out check that retires a tab, and the guard that
 * refuses to queue an item there is nothing to sell of. Counting all levels
 * anywhere else strands the queue — a player holding 1 plain and 5 enhanced
 * sells the plain one and the count stays at 5, so the tab never retires and
 * the queue never advances.
 */
const QUEUED_ENHANCEMENT_LEVEL = 0;

/** @type {Array<{itemHrid: string, itemName: string}>} */
const queue = [];

/** @type {HTMLElement[]} */
const currentTabs = [];

let cleanupObserver = null;
let inventoryUpdateHandler = null;
let currentItemHrid = null;
let tooltipObserverUnregister = null;
let contextMenuHandler = null;
let isActive = false;

/**
 * Bumped by every teardown, so work that awaited across one can tell.
 *
 * `addToQueue` awaits the marketplace opening (up to five seconds) and then the
 * reservation write, and the queue it is building is module state anybody can
 * tear down meanwhile — the setting toggled off, or the cleanup observer firing
 * because the player left the marketplace. Resuming blind re-armed the websocket
 * listener and the cleanup observer that teardown had just removed, on a feature
 * that is no longer running, and yanked the panel to an item nobody is queueing
 * any more. Capture the era before the await, verify it after.
 */
let generation = 0;

/** The item an auto-advance is waiting to navigate to, once the way is clear */
let pendingNavigationHrid = null;
/** The poller watching for the obstruction to clear */
let pendingNavigationPoll = null;
/** How often the deferred navigation re-checks */
const NAV_DEFER_POLL_MS = 400;
/** How long it waits before giving up rather than yanking the panel later */
const NAV_DEFER_GIVE_UP_MS = 20000;

/**
 * Whether now is a bad moment to change what the marketplace panel is showing.
 *
 * The auto-advance is driven by websocket messages, so it fires whenever the
 * server says an item ran out — which can be in the middle of the player typing
 * a price into a modal for something else entirely. Navigating then throws away
 * what they were doing. The two things worth not interrupting are a modal being
 * open and a text or number field having focus.
 *
 * @param {Document} [doc] - Injectable for tests
 * @returns {boolean} True while navigation should wait
 */
export function navigationBlocked(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc) return false;
    if (doc.querySelector('[class*="Modal_modalContainer"]')) return true;

    const active = doc.activeElement;
    if (!active) return false;
    if (active.isContentEditable) return true;
    const tag = active.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    const type = (active.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' || type === 'number' || type === 'search';
}

/** Forget any deferred navigation and stop watching for its moment. */
function clearPendingNavigation() {
    if (pendingNavigationPoll) {
        clearInterval(pendingNavigationPoll);
        pendingNavigationPoll = null;
    }
    pendingNavigationHrid = null;
}

/**
 * Auto-advance to an item, waiting out anything the player is in the middle of.
 *
 * Never synthesizes a click: this is the same programmatic navigation the queue
 * already did, only deferred. If the way has not cleared within
 * NAV_DEFER_GIVE_UP_MS the advance is dropped rather than sprung on the player
 * long after the fill that caused it.
 *
 * @param {string} itemHrid - Where to go
 */
function navigateWhenClear(itemHrid) {
    if (!navigationBlocked()) {
        clearPendingNavigation();
        navigateToMarketplace(itemHrid, 0);
        return;
    }

    pendingNavigationHrid = itemHrid;
    if (pendingNavigationPoll) return;

    const startedAt = Date.now();
    pendingNavigationPoll = setInterval(() => {
        const hrid = pendingNavigationHrid;
        // Gone from the queue, or waited too long to still be what the player expects
        if (!hrid || !queue.some((entry) => entry.itemHrid === hrid) || Date.now() - startedAt > NAV_DEFER_GIVE_UP_MS) {
            clearPendingNavigation();
            return;
        }
        if (navigationBlocked()) return;
        clearPendingNavigation();
        navigateToMarketplace(hrid, 0);
    }, NAV_DEFER_POLL_MS);
    timerRegistry.registerInterval(pendingNavigationPoll);
}

/**
 * Get inventory count for an item hrid, across every enhancement level or at one.
 * @param {string} itemHrid - The item
 * @param {number|null} [enhancementLevel] - Count only this level; null sums them all
 * @returns {number} Units in the bag
 */
function getInventoryCount(itemHrid, enhancementLevel = null) {
    const inventory = dataManager.getInventory();
    if (!inventory) return 0;
    return inventory
        .filter(
            (i) =>
                i.itemHrid === itemHrid &&
                i.itemLocationHrid === '/item_locations/inventory' &&
                (enhancementLevel === null || (i.enhancementLevel || 0) === enhancementLevel)
        )
        .reduce((sum, i) => sum + (i.count || 0), 0);
}

/**
 * Hold everything on the queue back from every plan that would craft with it.
 *
 * Re-stated whenever the queue changes, which includes a partial sale: an item
 * half sold is half still in the bag, and the claim shrinks with it. An empty
 * queue claims nothing, which `reserve` treats as a release.
 *
 * @returns {Promise<boolean>} Whether a write landed
 */
function claimQueue() {
    return reserve(
        RESERVATION_OWNER,
        queue.map((entry) => ({
            itemHrid: entry.itemHrid,
            enhancementLevel: QUEUED_ENHANCEMENT_LEVEL,
            count: getInventoryCount(entry.itemHrid, QUEUED_ENHANCEMENT_LEVEL),
        })),
        { label: 'Queued for selling' }
    );
}

/**
 * Navigate to the marketplace by clicking its navbar button.
 * @returns {Promise<boolean>}
 */
async function openMarketplacePage() {
    const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
    const marketplaceButton = Array.from(navButtons).find((nav) =>
        nav.querySelector('svg[aria-label="navigationBar.marketplace"]')
    );
    if (!marketplaceButton) return false;
    marketplaceButton.click();
    return await waitForMarketplace();
}

/**
 * Wait for the marketplace tabs container to appear.
 * @returns {Promise<boolean>}
 */
async function waitForMarketplace() {
    for (let i = 0; i < 50; i++) {
        const tabsContainer = visibleTabsContainer();
        if (tabsContainer) {
            const hasMarket = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (hasMarket) return true;
        }
        await new Promise((resolve) => {
            timerRegistry.registerTimeout(setTimeout(resolve, 100));
        });
    }
    return false;
}

/**
 * Inject tabs for all queued items into the marketplace tab strip.
 */
function injectTabs() {
    const tabsContainer = visibleTabsContainer();
    if (!tabsContainer) return;

    removeMaterialTabs();
    currentTabs.length = 0;

    const referenceTab = Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'));
    if (!referenceTab) return;

    tabsContainer.style.flexWrap = 'wrap';

    for (const entry of queue) {
        const count = getInventoryCount(entry.itemHrid, QUEUED_ENHANCEMENT_LEVEL);
        const material = {
            itemHrid: entry.itemHrid,
            itemName: entry.itemName,
            missing: 0,
            required: count,
            isTradeable: true,
        };

        const tab = createMaterialTab(material, referenceTab, (_e, mat) => {
            navigateToMarketplace(mat.itemHrid, 0);
        });

        const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
        if (badgeSpan) {
            badgeSpan.innerHTML = buildBadgeHtml(entry.itemName, count);
        }

        tabsContainer.appendChild(tab);
        currentTabs.push(tab);
    }
}

/**
 * Build badge HTML for a queued item tab.
 * @param {string} itemName
 * @param {number} count
 * @returns {string}
 */
function buildBadgeHtml(itemName, count) {
    const titleCase = itemName
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    const color = count > 0 ? '#4ade80' : '#6b7280';
    const sub = count > 0 ? `In bag: ${count.toLocaleString()}` : 'Sold out';
    return `<div style="text-align:center;"><div>${titleCase}</div><div style="font-size:0.75em;color:${color};">${sub}</div></div>`;
}

/**
 * Update tab badges and remove tabs for items that have sold out.
 * Auto-navigates to the next queued item when the current one sells out.
 */
function updateTabsOnInventoryChange() {
    if (currentTabs.length === 0) return;

    const toRemove = [];

    currentTabs.forEach((tab) => {
        const itemHrid = tab.getAttribute('data-item-hrid');
        const entry = queue.find((e) => e.itemHrid === itemHrid);
        if (!entry) return;

        const count = getInventoryCount(entry.itemHrid, QUEUED_ENHANCEMENT_LEVEL);
        const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
        if (badgeSpan) {
            badgeSpan.innerHTML = buildBadgeHtml(entry.itemName, count);
        }

        if (count === 0) {
            toRemove.push(itemHrid);
        }
    });

    for (const hrid of toRemove) {
        const idx = queue.findIndex((e) => e.itemHrid === hrid);
        if (idx !== -1) queue.splice(idx, 1);

        const tabIdx = currentTabs.findIndex((t) => t.getAttribute('data-item-hrid') === hrid);
        if (tabIdx !== -1) {
            currentTabs[tabIdx].remove();
            currentTabs.splice(tabIdx, 1);
        }
    }

    // What is left in the bag for the queue has moved, so what it is holding
    // back from everything else moves with it
    claimQueue();

    // After removing sold-out tabs, navigate to the first remaining queued item —
    // but not out from under a modal or a half-typed field
    if (toRemove.length > 0 && queue.length > 0) {
        navigateWhenClear(queue[0].itemHrid);
    }
}

/**
 * Set up WebSocket listener to update tabs when inventory changes.
 */
function setupInventoryListener() {
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
    }
    inventoryUpdateHandler = (data) => {
        if (
            data.type?.includes('item') ||
            data.type?.includes('inventory') ||
            data.type?.includes('market') ||
            data.inventory ||
            data.characterItems
        ) {
            updateTabsOnInventoryChange();
        }
    };
    webSocketHook.on('*', inventoryUpdateHandler);
}

/**
 * Handle cleanup when user leaves the marketplace.
 */
function handleMarketplaceCleanup() {
    // Anything mid-await belongs to the session being torn down, not the next one
    generation += 1;
    clearPendingNavigation();
    removeMaterialTabs();
    currentTabs.length = 0;
    queue.length = 0;
    // Nothing is queued any more, so nothing is on its way out of the bag
    release(RESERVATION_OWNER);
    // The watchdog goes with the session it was watching. Left running, the next
    // queued item took the first-item path again and registered a second one over
    // the top of it — the first was then unreachable, polling `currentTabs`
    // (a module-level array, refilled by that very queue) forever, and surviving
    // the feature being disabled. Safe to call from the poll's own callback.
    if (cleanupObserver) {
        cleanupObserver();
        cleanupObserver = null;
    }
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
        inventoryUpdateHandler = null;
    }
}

/**
 * Add an item to the queue and inject/update tabs.
 * @param {string} itemHrid
 * @param {string} itemName
 */
async function addToQueue(itemHrid, itemName) {
    if (queue.some((e) => e.itemHrid === itemHrid)) return;

    const count = getInventoryCount(itemHrid, QUEUED_ENHANCEMENT_LEVEL);
    if (count === 0) return;

    const isFirstItem = queue.length === 0;
    const era = generation;
    queue.push({ itemHrid, itemName });

    if (isFirstItem) {
        const tabsContainer = visibleTabsContainer();
        const alreadyInMarket =
            tabsContainer &&
            Array.from(tabsContainer.children).some((btn) => btn.textContent.includes('Market Listings'));

        if (!alreadyInMarket) {
            const success = await openMarketplacePage();
            if (era !== generation) return;
            if (!success) {
                queue.length = 0;
                return;
            }
            await new Promise((resolve) => {
                timerRegistry.registerTimeout(setTimeout(resolve, 200));
            });
            if (era !== generation) return;
        }

        cleanupObserver = setupMarketplaceCleanupObserver(handleMarketplaceCleanup, currentTabs);
        setupInventoryListener();
    }

    injectTabs();
    await claimQueue();
    if (era !== generation) {
        // The claim was in flight while the teardown released, so it can have
        // landed on top of that release — hold nothing back for a queue that is
        // gone rather than leaving stock spoken for until the seven-day sweep
        release(RESERVATION_OWNER);
        return;
    }
    navigateToMarketplace(itemHrid, 0);
}

/**
 * Track the hovered item HRID via tooltip observer (same strategy as alt-click-navigation).
 * @param {HTMLElement} tooltipElement
 * @param {import('../../core/tooltip-observer.js').TooltipInfo} [info] - The popper's classification
 *   (probed here when a caller has none)
 */
function handleTooltipAppear(tooltipElement, info = tooltipObserver.classify(tooltipElement)) {
    currentItemHrid = null;
    try {
        // An item link or sprite reference, as read once by the observer
        if (info.itemHrid) {
            currentItemHrid = info.itemHrid;
            return;
        }
        const nameEl = info.nameEl?.querySelector('span');
        if (nameEl) {
            const itemName = nameEl.textContent.trim();
            currentItemHrid = `/items/${itemName.toLowerCase().replace(/\s+/g, '_')}`;
        }
    } catch (error) {
        console.error('[SellQueue] Error parsing tooltip:', error);
    }
}

function initialize() {
    if (isActive) return;
    if (!config.getSetting('sellQueue')) return;

    tooltipObserver.subscribe('SellQueue-Tooltip', (el, eventType, info) => {
        if (eventType !== 'opened' || !info?.isTooltipPopper) return;
        handleTooltipAppear(el, info);
    });
    tooltipObserverUnregister = () => tooltipObserver.unsubscribe('SellQueue-Tooltip');

    contextMenuHandler = (event) => {
        if (!event.shiftKey) return;

        const inventoryEl = event.target.closest('[class*="Inventory_items"], [class*="Inventory_inventory"]');
        if (!inventoryEl) return;
        if (!currentItemHrid) return;

        event.preventDefault();
        event.stopPropagation();

        const gameData = dataManager.getInitClientData();
        const itemDetails = gameData?.itemDetailMap?.[currentItemHrid];
        if (!itemDetails) return;
        if (!itemDetails.isTradable) return;

        addToQueue(currentItemHrid, itemDetails.name);
    };

    document.addEventListener('contextmenu', contextMenuHandler, true);
    isActive = true;
}

function cleanup() {
    try {
        if (contextMenuHandler) {
            document.removeEventListener('contextmenu', contextMenuHandler, true);
            contextMenuHandler = null;
        }
        if (tooltipObserverUnregister) {
            tooltipObserverUnregister();
            tooltipObserverUnregister = null;
        }
        if (cleanupObserver) {
            cleanupObserver();
            cleanupObserver = null;
        }
        handleMarketplaceCleanup();
        clearPendingNavigation();
        timerRegistry.clearAll();
        currentItemHrid = null;
        isActive = false;
    } catch (error) {
        console.error('[Sell Queue] Disable failed part-way:', error);
    } finally {
        isActive = false;
    }
}

config.onSettingChange('sellQueue', (value) => {
    if (value) initialize();
    else cleanup();
});

export default {
    name: 'Sell Queue',
    initialize,
    cleanup,
};
