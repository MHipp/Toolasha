/**
 * Marketplace Custom Tabs Utility
 * Provides shared functionality for creating and managing custom marketplace tabs
 * Used by missing materials features (actions, houses, etc.)
 */

import dataManager from '../core/data-manager.js';
import webSocketHook from '../core/websocket.js';
import { formatWithSeparator } from './formatters.js';
import { GAME } from './selectors.js';

/**
 * Tabs currently watching their item for acquisition, keyed by the tab element,
 * value is the unsubscribe function returned by `webSocketHook.on('*', …)`.
 * A tab in here is a tab `watchTabForAcquisition` is still tracking; removing it
 * from the map is how every retirement path — auto, manual dismiss, "× All",
 * marketplace close, character switch — agrees the watch is over.
 */
const acquisitionWatchers = new Map();

/**
 * The "show a ✓ for a moment, then remove the tab" timeout for a tab that just
 * got retired, keyed by tab. Tracked separately from `acquisitionWatchers` so a
 * dismiss that lands during the brief ✓ window can cancel the pending removal
 * and `onRetire` call instead of racing them.
 */
const pendingRetireTimeouts = new Map();

/** How long the ✓ badge stays up before the tab is actually removed. */
const ACQUIRED_BADGE_DELAY_MS = 900;

/** Whether the character-switch teardown below has been hooked up yet. */
let characterSwitchHookRegistered = false;

/**
 * Drop every acquisition watch — and its tab — when the character switches.
 *
 * A watcher's `check()` reads whatever `dataManager.getInventory()` currently
 * holds, which after a switch is the *new* character's inventory. Left alive, a
 * tab pinned for character A retires as "✓ Acquired" the moment character B's
 * init data arrives, if B happens to own the item. `character_switching` is
 * emitted (and awaited) before data-manager swaps `characterItems`, so tearing
 * down synchronously here means no watcher can ever see the wrong character's
 * inventory. Registered lazily by `watchTabForAcquisition` rather than at
 * import time, and only when the real dataManager (not a test stub) exposes
 * `on`.
 *
 * Pending ✓-window removals are cancelled too rather than left to fire into
 * the new character's session; the tabs are removed immediately without their
 * `onRetire`/`onDismiss` callbacks — callers' bookkeeping is reconciled by
 * their own cleanup observers, the same as on marketplace close.
 */
function retireAllWatchesForCharacterSwitch() {
    const tabs = new Set([...acquisitionWatchers.keys(), ...pendingRetireTimeouts.keys()]);
    for (const tab of tabs) {
        unwatchTabAcquisition(tab);
        tab.remove();
    }
}

function ensureCharacterSwitchHook() {
    if (characterSwitchHookRegistered) return;
    if (typeof dataManager.on !== 'function') return;
    characterSwitchHookRegistered = true;
    dataManager.on('character_switching', retireAllWatchesForCharacterSwitch);
}

/** How often the cleanup watchdog checks that its tabs are still on screen */
const POLL_MS = 3000;

/**
 * Create a custom material tab for the marketplace
 * @param {Object} material - Material data object
 * @param {string} material.itemHrid - Item HRID
 * @param {string} material.itemName - Display name for the item
 * @param {number} material.missing - Amount missing (0 if sufficient)
 * @param {number} [material.queued=0] - Amount reserved by queue
 * @param {boolean} material.isTradeable - Whether item can be traded
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} onClickCallback - Callback when tab is clicked, receives (e, material)
 * @param {Object} [options] - Optional extras
 * @param {Function} [options.onDismiss] - Called with `material` when the tab's own
 *   dismiss (×) button is used, right before the tab is removed from the DOM. Lets a
 *   caller prune whatever list of its own it is keeping alongside the tab.
 * @returns {HTMLElement} Created tab element
 */
/**
 * The extra badge line naming who claimed the stock, when a material line
 * carries one.
 *
 * Only `calculateMaterialRequirements` attaches `reservedNote`, and only when
 * another owner's claim is what put the line short — so a tab built from a line
 * without one is the tab it has always been.
 *
 * @param {Object} material - A material line
 * @returns {string} An HTML fragment, or `''`
 */
function reservedBadgeLine(material) {
    if (!material?.reservedNote) return '';
    const escaped = String(material.reservedNote).replace(
        /[&<>"']/g,
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    );
    return `<div style="font-size: 0.7em; color: #e8a87c;">${escaped}</div>`;
}

export function createMaterialTab(material, referenceTab, onClickCallback, options = {}) {
    // Clone reference tab structure
    const tab = referenceTab.cloneNode(true);

    // Mark as custom tab for later identification
    tab.setAttribute('data-mwi-custom-tab', 'true');
    tab.setAttribute('data-item-hrid', material.itemHrid);
    tab.setAttribute('data-missing-quantity', material.missing.toString());

    // Color coding:
    // - Red: Missing materials (missing > 0)
    // - Green: Sufficient materials (missing = 0)
    // - Gray: Not tradeable
    let statusColor;
    let statusText;

    if (!material.isTradeable) {
        statusColor = '#888888'; // Gray - not tradeable
        statusText = 'Not Tradeable';
    } else if (material.missing > 0) {
        statusColor = '#ef4444'; // Red - missing materials
        // Show queued amount if any materials are reserved by queue
        const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
        statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
    } else {
        statusColor = '#4ade80'; // Green - sufficient materials
        statusText = `Sufficient (${formatWithSeparator(material.required)})`;
    }

    // Update text content
    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        // Title case: capitalize first letter of each word
        const titleCaseName = material.itemName
            .split(' ')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

        badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>${titleCaseName}</div>
                <div style="font-size: 0.75em; color: ${statusColor};">
                    ${statusText}
                </div>
                ${reservedBadgeLine(material)}
            </div>
        `;
    }

    // Gray out if not tradeable
    if (!material.isTradeable) {
        tab.style.opacity = '0.5';
        tab.style.cursor = 'not-allowed';
    }

    // Remove selected state
    tab.classList.remove('Mui-selected');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('tabindex', '-1');

    // Add click handler
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!material.isTradeable) {
            // Not tradeable - do nothing
            return;
        }

        // Call the provided callback
        if (onClickCallback) {
            onClickCallback(e, material);
        }
    });

    attachDismissButton(tab, material, options.onDismiss);

    return tab;
}

/**
 * Pin a small × in the corner of a tab, visible on hover, that removes just that
 * tab. It never got one, which is why the fix for "I don't want this pinned
 * anymore" was always "wait for the whole strip to be replaced or the
 * marketplace to close" — the only two things that called `removeMaterialTabs`.
 *
 * @param {HTMLElement} tab - Tab element (mutated in place)
 * @param {Object} material - The material this tab represents, handed to `onDismiss`
 * @param {Function} [onDismiss] - Called with `material` right before the tab is removed
 */
function attachDismissButton(tab, material, onDismiss) {
    // Absolute-positioned inside the tab, so the tab needs to anchor it. MUI tabs
    // are not positioned by default; only take over `position` when nothing else
    // already claimed it.
    if (!tab.style.position) {
        tab.style.position = 'relative';
    }

    const dismissBtn = document.createElement('span');
    dismissBtn.setAttribute('data-mwi-tab-dismiss', 'true');
    dismissBtn.title = 'Remove this tab';
    dismissBtn.textContent = '×';
    dismissBtn.style.cssText = `
        position: absolute;
        top: 1px;
        right: 1px;
        width: 14px;
        height: 14px;
        line-height: 13px;
        text-align: center;
        font-size: 12px;
        font-weight: 700;
        border-radius: 50%;
        color: #ddd;
        background: rgba(0, 0, 0, 0.45);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.12s ease;
        z-index: 1;
    `;

    tab.addEventListener('mouseenter', () => {
        dismissBtn.style.opacity = '1';
    });
    tab.addEventListener('mouseleave', () => {
        dismissBtn.style.opacity = '0';
    });

    dismissBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        unwatchTabAcquisition(tab);
        if (onDismiss) onDismiss(material);
        tab.remove();
    });

    tab.appendChild(dismissBtn);
}

/**
 * Build a small "clear all" control shaped like the other tabs, so it sits in the
 * strip rather than floating above it. Clicking it removes every custom material
 * tab currently pinned (the same set `removeMaterialTabs` clears) — including
 * itself, since it is tagged `data-mwi-custom-tab` too.
 *
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} [onClearAll] - Called after the tabs are removed, so a caller
 *   can prune whatever list of its own it was keeping alongside them
 * @returns {HTMLElement} The control element, not yet attached anywhere
 */
export function createClearAllTabsControl(referenceTab, onClearAll) {
    const control = referenceTab.cloneNode(true);

    control.setAttribute('data-mwi-custom-tab', 'true');
    control.setAttribute('data-mwi-clear-all-tab', 'true');
    control.classList.remove('Mui-selected');
    control.setAttribute('aria-selected', 'false');
    control.setAttribute('tabindex', '-1');
    control.title = 'Clear all pinned tabs';
    control.style.opacity = '0.7';
    control.style.flex = '0 0 auto';

    const badgeSpan = control.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        badgeSpan.innerHTML = `
            <div style="text-align: center; font-weight: 700; font-size: 13px;">
                &times; All
            </div>
        `;
    }

    control.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeMaterialTabs();
        if (onClearAll) onClearAll();
    });

    return control;
}

/**
 * Append a `createClearAllTabsControl` to `container`, unless one is already
 * there. Kept idempotent so callers can invoke it every time they add tabs
 * without needing to track whether they already have one.
 *
 * @param {HTMLElement} container - The visible tab bar
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} [onClearAll] - Forwarded to `createClearAllTabsControl`
 */
export function ensureClearAllTabsControl(container, referenceTab, onClearAll) {
    if (!container || container.querySelector('[data-mwi-clear-all-tab="true"]')) return;
    container.appendChild(createClearAllTabsControl(referenceTab, onClearAll));
}

/**
 * The marketplace tab bar you can actually see.
 *
 * There can be more than one. The marketplace opens as a popout over whatever
 * you were doing, and the full marketplace page keeps its own tab bar in the
 * document behind it — so `querySelector` returns whichever comes first, which
 * is frequently the hidden one. Tabs added there are added correctly and are
 * invisible, which is the worst shape a bug can take: nothing appears, and
 * visiting the real marketplace first "fixes" it by making the bar that was
 * already being picked the one on screen.
 *
 * Every candidate is checked and the displayed one wins.
 *
 * @param {string} [contains] - Text a tab must contain, to tell a marketplace bar
 *   from any other tab strip on the page
 * @returns {HTMLElement|null} The visible tab bar
 */
export function visibleTabsContainer(contains = 'My Listings') {
    for (const container of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
        if (contains && !Array.from(container.children).some((tab) => tab.textContent.includes(contains))) continue;

        // `offsetParent` is null under any `display: none` ancestor, which is how
        // the game parks the panel you are not looking at
        if (container.offsetParent === null) continue;
        if (!container.getBoundingClientRect().width) continue;

        return container;
    }
    return null;
}

/**
 * Attach (once) a delegated click listener to a tab strip that fires when the
 * user picks a *different* native tab — meaning "never mind, I'm not buying
 * that", which is when a quantity armed for a pinned material tab should be
 * dropped.
 *
 * Matches on `[role="tab"]` rather than any `button`. Tab strips this is used
 * on (the marketplace's, the Tester shop's) also hold action buttons in the
 * same row — "+ New Buy Listing" / "+ New Sell Listing" are `Button_buy` /
 * `Button_sell` components, not MUI Tabs, so they carry no `role="tab"`.
 * Matching on `button` used to catch those too and clear the just-armed
 * quantity a beat before their dialog opened, so the buy dialog you reached by
 * clicking "+ New Buy Listing" right after a missing-material tab always
 * landed on the default quantity of 1 instead of the missing count.
 *
 * Idempotent via `data-mwi-delegated-listener`, so a caller that rebuilds its
 * tabs on every open (as the missing-materials features do) never stacks a
 * second listener on the same container.
 *
 * @param {HTMLElement} tabsContainer - The tab strip to delegate from
 * @param {Function} onOtherTabClick - Called with no args when a genuine other tab is clicked
 */
export function attachRegularTabClearListener(tabsContainer, onOtherTabClick) {
    if (!tabsContainer || tabsContainer.hasAttribute('data-mwi-delegated-listener')) return;
    tabsContainer.setAttribute('data-mwi-delegated-listener', 'true');
    tabsContainer.addEventListener('click', (e) => {
        const clickedTab = e.target.closest('[role="tab"]');
        if (clickedTab && !clickedTab.hasAttribute('data-mwi-custom-tab')) {
            onOtherTabClick();
        }
    });
}

/**
 * Remove all custom material tabs from the marketplace
 */
export function removeMaterialTabs() {
    const customTabs = document.querySelectorAll('[data-mwi-custom-tab="true"]');
    customTabs.forEach((tab) => {
        unwatchTabAcquisition(tab);
        tab.remove();
    });
}

/**
 * Remove all shrine-specific material tabs from the marketplace
 */
export function removeShrineMarketTabs() {
    document.querySelectorAll('[data-mwi-shrine-tab="true"]').forEach((tab) => tab.remove());
}

/**
 * Update the badge content and quantity attribute on an existing material tab
 * @param {HTMLElement} tab - Tab element created by createMaterialTab
 * @param {Object} material - Updated material data
 * @param {string} material.itemName - Display name
 * @param {number} material.missing - Current missing quantity
 * @param {number} [material.required] - Total required quantity
 * @param {boolean} material.isTradeable - Whether tradeable
 * @param {number} [material.queued] - Queued quantity
 */
export function updateTabBadge(tab, material) {
    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (!badgeSpan) return;

    let statusColor;
    let statusText;

    if (!material.isTradeable) {
        statusColor = '#888888';
        statusText = 'Not Tradeable';
    } else if (material.missing > 0) {
        statusColor = '#ef4444';
        const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
        statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
    } else {
        statusColor = '#4ade80';
        statusText = `Sufficient (${formatWithSeparator(material.required)})`;
    }

    const titleCaseName = material.itemName
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

    badgeSpan.innerHTML = `
        <div style="text-align: center;">
            <div>${titleCaseName}</div>
            <div style="font-size: 0.75em; color: ${statusColor};">
                ${statusText}
            </div>
            ${reservedBadgeLine(material)}
        </div>
    `;

    tab.setAttribute('data-missing-quantity', material.missing.toString());

    if (!material.isTradeable) {
        tab.style.opacity = '0.5';
        tab.style.cursor = 'not-allowed';
    } else {
        tab.style.opacity = '1';
        tab.style.cursor = 'pointer';
    }
}

/**
 * Setup marketplace cleanup observer
 * Watches for marketplace panel removal and calls cleanup callback
 * @param {Function} onCleanup - Callback when marketplace closes, receives no args
 * @param {Array} tabsArray - Array reference to track tabs (will be checked for length)
 * @returns {Function} Unregister function to stop observing
 */
export function setupMarketplaceCleanupObserver(onCleanup, tabsArray) {
    let pollInterval = null;

    function poll() {
        if (!tabsArray || tabsArray.length === 0) return;
        // Nobody can navigate away from a tab they are not looking at, and every
        // check below is a layout read
        if (document.hidden) return;

        // If custom tabs were removed from DOM, clean up
        const hasCustomTabsInDOM = tabsArray.some((tab) => document.body.contains(tab));
        if (!hasCustomTabsInDOM) {
            if (onCleanup) onCleanup();
            return;
        }

        // If the panel the tabs sit in is hidden (navigated away), clean up.
        // Read off the tabs themselves rather than the marketplace panel, so
        // tabs pinned into the Shop's strip (the Tester shop hand-off) are
        // governed the same way: out of view is out of play
        const anyVisible = tabsArray.some((tab) => tab.offsetParent !== null);
        if (!anyVisible) {
            if (onCleanup) onCleanup();
            return;
        }
        const marketplacePanel = document.querySelector(GAME.MARKETPLACE_PANEL);
        const subPanelContainer = marketplacePanel?.closest(GAME.SUBPANEL_CONTAINER);
        const inMarketplace = tabsArray.some((tab) => marketplacePanel?.contains(tab));
        if (inMarketplace && subPanelContainer && getComputedStyle(subPanelContainer).display === 'none') {
            if (onCleanup) onCleanup();
        }
    }

    // Three seconds rather than one: every pass forces layout (`offsetParent` per
    // tab, then `getComputedStyle` on the sub-panel container), and the thing it
    // is waiting for is a person navigating away — noticing that a couple of
    // seconds later costs nothing, since the tabs are already off screen by then.
    pollInterval = setInterval(poll, POLL_MS);

    return () => {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    };
}

/**
 * Get game object via React fiber
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Navigate to marketplace for a specific item
 * @param {string} itemHrid - Item HRID to navigate to
 * @param {number} enhancementLevel - Enhancement level (default 0)
 */
export function navigateToMarketplace(itemHrid, enhancementLevel = 0) {
    const game = getGameObject();
    if (game?.handleGoToMarketplace) {
        game.handleGoToMarketplace(itemHrid, enhancementLevel);
    }
    // Silently fail if game API unavailable - feature still provides value without auto-navigation
}

/**
 * How many of `itemHrid` at `enhancementLevel` currently sit in inventory.
 *
 * `characterItems` rows carry an `enhancementLevel` field for anything that can
 * be enhanced (0/absent otherwise), the same field `material-calculator.js`
 * checks to tell raw stock apart from a copy the player already improved. That
 * makes an exact match possible here too — a pinned "+5" tab is only retired by
 * a +5 in inventory, not by three +0 copies sitting next to it.
 *
 * The one gap: if a future inventory row ever omitted `enhancementLevel`
 * entirely for an item that actually has one, this would read it as level 0 and
 * could retire a tab against the wrong copy. Nothing observed in
 * `data-manager.js` does that today, so this is a documented risk, not a known bug.
 *
 * @param {string} itemHrid - Item HRID to count
 * @param {number} enhancementLevel - Enhancement level to match exactly (0 for unenhanced)
 * @returns {number} Total count in inventory
 */
function currentAcquiredCount(itemHrid, enhancementLevel) {
    const inventory = dataManager.getInventory?.() || [];
    return inventory
        .filter((item) => item.itemHrid === itemHrid && (item.enhancementLevel || 0) === (enhancementLevel || 0))
        .reduce((sum, item) => sum + (item.count || 0), 0);
}

/**
 * Swap a tab's badge to a brief "✓ Acquired" before it is removed, so retiring
 * a tab reads as "got it" rather than as the tab silently vanishing.
 * @param {HTMLElement} tab - Tab element
 * @param {string} itemName - Display name to keep on the badge
 */
function showAcquiredBadge(tab, itemName) {
    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>${itemName}</div>
                <div style="font-size: 0.75em; color: #4ade80;">
                    ✓ Acquired
                </div>
            </div>
        `;
    }
    tab.style.opacity = '1';
    tab.style.cursor = 'default';
}

/**
 * Stop watching a tab for acquisition: cancel any pending retirement and drop
 * the websocket subscription. Safe to call on a tab that was never watched.
 *
 * Called automatically by `removeMaterialTabs` and the per-tab dismiss (×)
 * button, so callers of `watchTabForAcquisition` do not need to remember to
 * unwind it themselves on every removal path — only on paths that bypass both
 * (there are none in this module).
 *
 * @param {HTMLElement} tab - Tab element
 */
function unwatchTabAcquisition(tab) {
    const pendingTimeout = pendingRetireTimeouts.get(tab);
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingRetireTimeouts.delete(tab);
    }

    const unsubscribe = acquisitionWatchers.get(tab);
    if (unsubscribe) {
        unsubscribe();
        acquisitionWatchers.delete(tab);
    }
}

/**
 * Auto-retire a pinned material tab once its item shows up in inventory.
 *
 * Reuses the exact mechanism `missing-materials-button.js` already uses to
 * notice inventory changes — a `webSocketHook.on('*', …)` listener filtered to
 * messages shaped like an inventory update (`type` containing "item",
 * "inventory", or "market", or a top-level `inventory`/`characterItems` field).
 * That filter is intentionally identical to the one in `missing-materials-button.js`
 * rather than a second guess at which message types matter — see that file's
 * `setupInventoryListener` for the original.
 *
 * @param {HTMLElement} tab - Tab element, e.g. one made by `createMaterialTab`
 * @param {Object} options
 * @param {string} options.itemHrid - Item HRID to watch for
 * @param {number} [options.enhancementLevel=0] - Enhancement level to match exactly
 *   (see `currentAcquiredCount` for how/when that match is exact)
 * @param {number} [options.requiredCount=1] - Quantity that counts as "acquired"
 * @param {string} [options.itemName] - Display name for badge updates; falls back to
 *   the game's item name lookup, then to the HRID's last path segment
 * @param {Function} [options.onRetire] - Called with `tab` right after it is removed
 *   from the DOM because the item was acquired. Not called on manual dismiss,
 *   "× All", or marketplace close — those retire the watch without this callback.
 * @returns {Function} Unwatch function. Also invoked automatically by the tab's own
 *   dismiss button, `removeMaterialTabs`, and therefore marketplace-close cleanup
 *   (both of which route through `removeMaterialTabs`).
 */
export function watchTabForAcquisition(tab, options) {
    const noop = () => {};
    if (!tab || !options?.itemHrid) return noop;

    const { itemHrid, enhancementLevel = 0, requiredCount = 1, onRetire } = options;

    // A watch must not outlive its character — see retireAllWatchesForCharacterSwitch.
    ensureCharacterSwitchHook();

    // Re-registering (e.g. the same tab watched twice) replaces the old watch
    // rather than stacking a second subscription on top of it.
    unwatchTabAcquisition(tab);

    const itemName =
        options.itemName || dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop() || itemHrid;

    const retire = () => {
        showAcquiredBadge(tab, itemName);
        // Stop listening immediately — only the DOM removal + onRetire are delayed,
        // so a second inventory event during the ✓ window can't retire it twice.
        const unsubscribe = acquisitionWatchers.get(tab);
        if (unsubscribe) {
            unsubscribe();
            acquisitionWatchers.delete(tab);
        }

        const retireTimeout = setTimeout(() => {
            pendingRetireTimeouts.delete(tab);
            tab.remove();
            if (onRetire) onRetire(tab);
        }, ACQUIRED_BADGE_DELAY_MS);
        pendingRetireTimeouts.set(tab, retireTimeout);
    };

    const check = () => {
        const acquired = currentAcquiredCount(itemHrid, enhancementLevel);
        if (acquired >= requiredCount) {
            retire();
        } else {
            updateTabBadge(tab, {
                itemName,
                missing: requiredCount - acquired,
                required: requiredCount,
                isTradeable: true,
                queued: 0,
            });
        }
    };

    const handler = (data) => {
        if (
            data.type?.includes('item') ||
            data.type?.includes('inventory') ||
            data.type?.includes('market') ||
            data.inventory ||
            data.characterItems
        ) {
            check();
        }
    };

    webSocketHook.on('*', handler);
    acquisitionWatchers.set(tab, () => webSocketHook.off('*', handler));

    // Cover the case where the item was already sitting in inventory before
    // this tab started watching (e.g. a stale plan reopened after buying).
    check();

    return () => unwatchTabAcquisition(tab);
}

/**
 * Navigate back to the native "My Listings" tab from a specific listing's order-book page.
 *
 * Only the tab bar actually on screen is searched (`visibleTabsContainer`), and our own injected
 * tabs are skipped so a pinned material tab whose item name happens to contain the phrase can
 * never be clicked instead.
 *
 * @returns {boolean} True when the tab was found and clicked.
 */
export function navigateToMyListings() {
    const tabContainer = visibleTabsContainer();
    if (!tabContainer) return false;

    const tab = Array.from(tabContainer.children).find((el) => {
        if (el.getAttribute('role') !== 'tab') return false;
        if (el.hasAttribute('data-mwi-custom-tab') || el.hasAttribute('data-mwi-shrine-tab')) return false;
        return el.textContent.includes('My Listings');
    });

    if (!tab) return false;
    tab.click();
    return true;
}

/**
 * Navigate back to the native "Market Listings" tab — the marketplace's default
 * item order-book view. Used after a "clear all" wipes every pinned material
 * tab, so the player is not left looking at a strip that just lost the tab it
 * was on rather than the ordinary marketplace.
 *
 * Same skip rules as `navigateToMyListings`: only the visible tab bar, and only
 * a real native tab — never one of our own.
 *
 * @returns {boolean} True when the tab was found and clicked.
 */
export function navigateToMarketListingsTab() {
    const tabContainer = visibleTabsContainer();
    if (!tabContainer) return false;

    const tab = Array.from(tabContainer.children).find((el) => {
        if (el.getAttribute('role') !== 'tab') return false;
        if (el.hasAttribute('data-mwi-custom-tab') || el.hasAttribute('data-mwi-shrine-tab')) return false;
        return el.textContent.includes('Market Listings');
    });

    if (!tab) return false;
    tab.click();
    return true;
}
