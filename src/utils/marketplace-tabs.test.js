/** @vitest-environment happy-dom */
/**
 * Tests for Marketplace Custom Tabs Utility
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const inventory = vi.hoisted(() => ({ items: [] }));
const dataManagerListeners = vi.hoisted(() => new Map());

// watchTabForAcquisition reads inventory through dataManager, same as
// missing-materials-button.js does — mocked here so tests control exactly
// what's "owned" without a real character session. `on` is captured so tests
// can replay dataManager lifecycle events (character_switching) by hand.
vi.mock('../core/data-manager.js', () => ({
    default: {
        getInventory: () => inventory.items,
        getItemDetails: (itemHrid) => ({ name: itemHrid.split('/').pop() }),
        on: (event, listener) => {
            if (!dataManagerListeners.has(event)) dataManagerListeners.set(event, []);
            dataManagerListeners.get(event).push(listener);
        },
    },
}));

import webSocketHook from '../core/websocket.js';
import {
    createMaterialTab,
    materialTabName,
    visibleTabsContainer,
    removeMaterialTabs,
    removeShrineMarketTabs,
    updateTabBadge,
    navigateToMarketplace,
    navigateToMarketListingsTab,
    createClearAllTabsControl,
    ensureClearAllTabsControl,
    watchTabForAcquisition,
    attachRegularTabClearListener,
} from './marketplace-tabs.js';

/** Fire the exact wildcard path watchTabForAcquisition listens on — the same
 * mechanism missing-materials-button.js's setupInventoryListener triggers off. */
function sendInventoryUpdate() {
    webSocketHook.processMessage(JSON.stringify({ type: 'items_updated' }));
}

/** Replay data-manager's character_switching emit — the synchronous teardown
 * window before the new character's inventory becomes visible. */
function emitCharacterSwitching() {
    for (const listener of dataManagerListeners.get('character_switching') || []) {
        listener({ oldId: 'char-a', newId: 'char-b' });
    }
}

function buildReferenceTab() {
    const tab = document.createElement('div');
    tab.className = 'Mui-selected';
    tab.setAttribute('aria-selected', 'true');
    tab.setAttribute('tabindex', '0');
    const badge = document.createElement('span');
    badge.className = 'TabsComponent_badge__x';
    tab.appendChild(badge);
    return tab;
}

describe('createMaterialTab', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('marks the tab red and shows missing quantity when material is missing', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/plank', itemName: 'plank', missing: 50, required: 100, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.getAttribute('data-missing-quantity')).toBe('50');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Missing: 50');
    });

    test('marks the tab green when sufficient', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/plank', itemName: 'plank', missing: 0, required: 100, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Sufficient');
    });

    test('marks the tab gray and disables interaction when not tradeable', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/quest_item', itemName: 'quest item', missing: 5, isTradeable: false },
            ref,
            () => {}
        );
        expect(tab.style.opacity).toBe('0.5');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Not Tradeable');
    });

    test('clears the selected state inherited from the reference tab', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.classList.contains('Mui-selected')).toBe(false);
        expect(tab.getAttribute('aria-selected')).toBe('false');
    });

    test('invokes the click callback with the material when tradeable', () => {
        const ref = buildReferenceTab();
        const onClick = vi.fn();
        const material = { itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: true };
        const tab = createMaterialTab(material, ref, onClick);

        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onClick.mock.calls[0][1]).toBe(material);
    });

    test('does not invoke the click callback when not tradeable', () => {
        const ref = buildReferenceTab();
        const onClick = vi.fn();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 0, isTradeable: false },
            ref,
            onClick
        );
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(onClick).not.toHaveBeenCalled();
    });

    test('title-cases the item name in the badge', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'refined iron bar', missing: 0, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Refined Iron Bar');
    });

    test('adds a dismiss control to the tab', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 1, isTradeable: true },
            ref,
            () => {}
        );
        expect(tab.querySelector('[data-mwi-tab-dismiss="true"]')).not.toBeNull();
    });

    test('dismiss control removes the tab from the DOM and does not trigger the click callback', () => {
        const ref = buildReferenceTab();
        const onClick = vi.fn();
        const material = { itemHrid: '/items/x', itemName: 'x', missing: 1, isTradeable: true };
        const tab = createMaterialTab(material, ref, onClick);
        document.body.appendChild(tab);

        tab.querySelector('[data-mwi-tab-dismiss="true"]').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(document.body.contains(tab)).toBe(false);
        expect(onClick).not.toHaveBeenCalled();
    });

    test('dismiss control calls onDismiss with the material before removing the tab', () => {
        const ref = buildReferenceTab();
        const onDismiss = vi.fn();
        const material = { itemHrid: '/items/x', itemName: 'x', missing: 1, isTradeable: true };
        const tab = createMaterialTab(material, ref, () => {}, { onDismiss });
        document.body.appendChild(tab);

        tab.querySelector('[data-mwi-tab-dismiss="true"]').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(onDismiss).toHaveBeenCalledWith(material);
        expect(document.body.contains(tab)).toBe(false);
    });

    test('dismiss control works even when the tab is not tradeable', () => {
        const ref = buildReferenceTab();
        const material = { itemHrid: '/items/x', itemName: 'x', missing: 1, isTradeable: false };
        const tab = createMaterialTab(material, ref, () => {});
        document.body.appendChild(tab);

        tab.querySelector('[data-mwi-tab-dismiss="true"]').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(document.body.contains(tab)).toBe(false);
    });
});

describe('a tab for a line that names an enhancement level', () => {
    test('says the level, so the tab is not read as the base item', () => {
        expect(materialTabName({ itemName: 'furious spear', enhancementLevel: 12 })).toBe('Furious Spear +12');
    });

    test('a line with no level is named exactly as it always was', () => {
        expect(materialTabName({ itemName: 'cedar lumber' })).toBe('Cedar Lumber');
        expect(materialTabName({ itemName: 'cedar lumber', enhancementLevel: 0 })).toBe('Cedar Lumber');
    });

    test('the tab and a live update of it agree on the name', () => {
        const ref = buildReferenceTab();
        const material = {
            itemHrid: '/items/furious_spear',
            itemName: 'furious spear',
            enhancementLevel: 12,
            missing: 1,
            required: 1,
            isTradeable: true,
        };
        const tab = createMaterialTab(material, ref, () => {});
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Furious Spear +12');

        updateTabBadge(tab, { ...material, missing: 0 });
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Furious Spear +12');
    });
});

describe('createClearAllTabsControl / ensureClearAllTabsControl', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('is tagged as a custom tab so removeMaterialTabs sweeps it up too', () => {
        const ref = buildReferenceTab();
        const control = createClearAllTabsControl(ref, () => {});
        expect(control.getAttribute('data-mwi-custom-tab')).toBe('true');
        expect(control.getAttribute('data-mwi-clear-all-tab')).toBe('true');
    });

    test('clicking it removes every custom material tab, including itself', () => {
        const ref = buildReferenceTab();
        const onClearAll = vi.fn();
        const container = document.createElement('div');
        document.body.appendChild(container);

        const tab1 = createMaterialTab(
            { itemHrid: '/items/a', itemName: 'a', missing: 1, isTradeable: true },
            ref,
            () => {}
        );
        const tab2 = createMaterialTab(
            { itemHrid: '/items/b', itemName: 'b', missing: 1, isTradeable: true },
            ref,
            () => {}
        );
        const control = createClearAllTabsControl(ref, onClearAll);
        container.append(tab1, tab2, control);

        control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(container.children.length).toBe(0);
        expect(onClearAll).toHaveBeenCalledTimes(1);
    });

    test('ensureClearAllTabsControl appends exactly one control, even when called repeatedly', () => {
        const ref = buildReferenceTab();
        const container = document.createElement('div');
        document.body.appendChild(container);

        ensureClearAllTabsControl(container, ref, () => {});
        ensureClearAllTabsControl(container, ref, () => {});
        ensureClearAllTabsControl(container, ref, () => {});

        expect(container.querySelectorAll('[data-mwi-clear-all-tab="true"]').length).toBe(1);
    });

    test('ensureClearAllTabsControl does nothing without a container', () => {
        const ref = buildReferenceTab();
        expect(() => ensureClearAllTabsControl(null, ref, () => {})).not.toThrow();
    });
});

describe('visibleTabsContainer', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function makeBar({ visible = true, text = 'My Listings' } = {}) {
        const bar = document.createElement('div');
        bar.className = 'MuiTabs-flexContainer';
        bar.setAttribute('role', 'tablist');
        const tab = document.createElement('div');
        tab.textContent = text;
        bar.appendChild(tab);
        if (!visible) {
            bar.style.display = 'none';
            // happy-dom doesn't compute layout; offsetParent stays null for detached/hidden
        }
        document.body.appendChild(bar);
        Object.defineProperty(bar, 'offsetParent', { get: () => (visible ? document.body : null) });
        Object.defineProperty(bar, 'getBoundingClientRect', {
            value: () => ({ width: visible ? 100 : 0 }),
        });
        return bar;
    }

    test('returns null when no tab bar matches', () => {
        expect(visibleTabsContainer()).toBeNull();
    });

    test('skips a hidden bar and returns the visible one containing the marker text', () => {
        makeBar({ visible: false });
        const visible = makeBar({ visible: true });
        expect(visibleTabsContainer()).toBe(visible);
    });

    test('ignores tab bars that do not contain the marker text', () => {
        makeBar({ visible: true, text: 'Something Else' });
        expect(visibleTabsContainer('My Listings')).toBeNull();
    });
});

describe('removeMaterialTabs / removeShrineMarketTabs', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('removes only tabs flagged as custom material tabs', () => {
        const custom = document.createElement('div');
        custom.setAttribute('data-mwi-custom-tab', 'true');
        const other = document.createElement('div');
        document.body.append(custom, other);

        removeMaterialTabs();

        expect(document.body.contains(custom)).toBe(false);
        expect(document.body.contains(other)).toBe(true);
    });

    test('removes only shrine tabs', () => {
        const shrine = document.createElement('div');
        shrine.setAttribute('data-mwi-shrine-tab', 'true');
        document.body.appendChild(shrine);

        removeShrineMarketTabs();

        expect(document.body.contains(shrine)).toBe(false);
    });
});

describe('attachRegularTabClearListener', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    /** A native MUI tab (My Listings / Market Listings), the real thing this
     * should fire on. */
    function nativeTab(text) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = text;
        return tab;
    }

    /** One of our own pinned material tabs — cloned from a native tab, so it
     * also carries role="tab", but is tagged and must never trigger the clear. */
    function customTab(text) {
        const tab = nativeTab(text);
        tab.setAttribute('data-mwi-custom-tab', 'true');
        return tab;
    }

    /** "+ New Buy Listing" / "+ New Sell Listing" — a Button_buy/Button_sell
     * component in the same flex row, not a MUI Tab, so no role="tab". */
    function actionButton(text) {
        const button = document.createElement('button');
        button.className = 'Button_button Button_buy';
        button.textContent = text;
        return button;
    }

    test('fires when a different native tab is clicked', () => {
        const container = document.createElement('div');
        const myListings = nativeTab('My Listings');
        container.appendChild(myListings);
        document.body.appendChild(container);

        const onOtherTabClick = vi.fn();
        attachRegularTabClearListener(container, onOtherTabClick);
        myListings.click();

        expect(onOtherTabClick).toHaveBeenCalledTimes(1);
    });

    test('does not fire when our own pinned material tab is clicked', () => {
        const container = document.createElement('div');
        const pinned = customTab('Labyrinth Refinement Shard — Missing: 286');
        container.appendChild(pinned);
        document.body.appendChild(container);

        const onOtherTabClick = vi.fn();
        attachRegularTabClearListener(container, onOtherTabClick);
        pinned.click();

        expect(onOtherTabClick).not.toHaveBeenCalled();
    });

    test('does not fire for "+ New Buy Listing" sharing the tab row — the reported bug', () => {
        // Regression: clicking "+ New Buy Listing" right after picking a missing-
        // material tab used to clear the quantity armed for the buy dialog it was
        // about to open, so the dialog always landed on the default quantity of 1
        // instead of the missing count (286 in the reported case).
        const container = document.createElement('div');
        container.append(nativeTab('My Listings'), actionButton('+ New Buy Listing'));
        document.body.appendChild(container);

        const onOtherTabClick = vi.fn();
        attachRegularTabClearListener(container, onOtherTabClick);
        container.querySelector('.Button_buy').click();

        expect(onOtherTabClick).not.toHaveBeenCalled();
    });

    test('is idempotent — a second call on the same container does not attach a second listener', () => {
        const container = document.createElement('div');
        const myListings = nativeTab('My Listings');
        container.appendChild(myListings);
        document.body.appendChild(container);

        const onOtherTabClick = vi.fn();
        attachRegularTabClearListener(container, onOtherTabClick);
        attachRegularTabClearListener(container, onOtherTabClick);
        myListings.click();

        expect(onOtherTabClick).toHaveBeenCalledTimes(1);
    });

    test('does nothing when passed no container', () => {
        expect(() => attachRegularTabClearListener(null, vi.fn())).not.toThrow();
    });
});

describe('navigateToMarketListingsTab', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    /** A visible marketplace tab bar carrying both native tabs plus, optionally,
     * one of our own — so a custom tab whose name happens to contain the phrase
     * can never be clicked instead of the real thing. */
    function buildMarketplaceBar({ withCustomTab = false } = {}) {
        const bar = document.createElement('div');
        bar.className = 'MuiTabs-flexContainer';
        bar.setAttribute('role', 'tablist');

        const myListings = document.createElement('button');
        myListings.setAttribute('role', 'tab');
        myListings.textContent = 'My Listings';

        const marketListings = document.createElement('button');
        marketListings.setAttribute('role', 'tab');
        marketListings.textContent = 'Market Listings';

        bar.append(myListings, marketListings);

        if (withCustomTab) {
            const fake = document.createElement('button');
            fake.setAttribute('role', 'tab');
            fake.setAttribute('data-mwi-custom-tab', 'true');
            fake.textContent = 'Market Listings (pinned)';
            bar.appendChild(fake);
        }

        document.body.appendChild(bar);
        Object.defineProperty(bar, 'offsetParent', { get: () => document.body });
        Object.defineProperty(bar, 'getBoundingClientRect', { value: () => ({ width: 100 }) });
        return { bar, marketListings };
    }

    test('clicks the native Market Listings tab, skipping our own pinned tabs', () => {
        const { marketListings } = buildMarketplaceBar({ withCustomTab: true });
        const onClick = vi.fn();
        marketListings.addEventListener('click', onClick);

        expect(navigateToMarketListingsTab()).toBe(true);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('returns false when no marketplace tab bar is visible', () => {
        expect(navigateToMarketListingsTab()).toBe(false);
    });

    test('returns false when the bar has no Market Listings tab', () => {
        const bar = document.createElement('div');
        bar.className = 'MuiTabs-flexContainer';
        bar.setAttribute('role', 'tablist');
        const myListings = document.createElement('button');
        myListings.setAttribute('role', 'tab');
        myListings.textContent = 'My Listings';
        bar.appendChild(myListings);
        document.body.appendChild(bar);
        Object.defineProperty(bar, 'offsetParent', { get: () => document.body });
        Object.defineProperty(bar, 'getBoundingClientRect', { value: () => ({ width: 100 }) });

        expect(navigateToMarketListingsTab()).toBe(false);
    });
});

describe('updateTabBadge', () => {
    test('updates badge content and quantity attribute in place', () => {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/x', itemName: 'x', missing: 10, required: 20, isTradeable: true },
            ref,
            () => {}
        );

        updateTabBadge(tab, { itemName: 'x', missing: 0, required: 20, isTradeable: true });

        expect(tab.getAttribute('data-missing-quantity')).toBe('0');
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Sufficient');
        expect(tab.style.opacity).toBe('1');
    });

    test('does nothing when the tab has no badge element', () => {
        const tab = document.createElement('div');
        expect(() => updateTabBadge(tab, { itemName: 'x', missing: 0, isTradeable: true })).not.toThrow();
    });
});

describe('navigateToMarketplace', () => {
    test('silently does nothing when the game object is unavailable', () => {
        expect(() => navigateToMarketplace('/items/plank')).not.toThrow();
    });

    test('calls handleGoToMarketplace with the item and enhancement level', () => {
        const handle = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace: handle }, child: null, sibling: null },
        };
        document.body.appendChild(root);

        navigateToMarketplace('/items/plank', 5);
        expect(handle).toHaveBeenCalledWith('/items/plank', 5);
        document.body.innerHTML = '';
    });
});

describe('watchTabForAcquisition', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        inventory.items = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Sweep any tab/watcher a test left behind so its webSocketHook
        // subscription doesn't leak into the next test in this file.
        removeMaterialTabs();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    function buildTab(missing = 1) {
        const ref = buildReferenceTab();
        const tab = createMaterialTab(
            { itemHrid: '/items/plank', itemName: 'plank', missing, required: 5, isTradeable: true },
            ref,
            () => {}
        );
        document.body.appendChild(tab);
        return tab;
    }

    test('does nothing and returns a no-op unwatch without an itemHrid', () => {
        const tab = buildTab();
        const unwatch = watchTabForAcquisition(tab, { requiredCount: 1 });
        expect(() => unwatch()).not.toThrow();
    });

    test('a partial acquisition updates the missing-count badge, without retiring the tab', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 3 }];
        const tab = buildTab();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 5, itemName: 'plank' });

        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Missing: 2');
        expect(document.body.contains(tab)).toBe(true);

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 4 }];
        sendInventoryUpdate();

        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Missing: 1');
        expect(document.body.contains(tab)).toBe(true);
    });

    test('reaching the required count shows a brief ✓ then retires the tab and fires onRetire', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, {
            itemHrid: '/items/plank',
            requiredCount: 1,
            itemName: 'plank',
            onRetire,
        });

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();

        // Still in the DOM, showing the acquired badge, before the delay elapses
        expect(document.body.contains(tab)).toBe(true);
        expect(tab.querySelector('[class*="TabsComponent_badge"]').innerHTML).toContain('Acquired');
        expect(onRetire).not.toHaveBeenCalled();

        vi.runAllTimers();

        expect(document.body.contains(tab)).toBe(false);
        expect(onRetire).toHaveBeenCalledWith(tab);
    });

    test('a second inventory event right after acquisition does not fire onRetire twice', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 1, itemName: 'plank', onRetire });

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        // The first event retires the watch (unsubscribing synchronously before it
        // returns), so this second one has nothing left to fire it a second time.
        sendInventoryUpdate();
        sendInventoryUpdate();

        vi.runAllTimers();

        expect(onRetire).toHaveBeenCalledTimes(1);
    });

    test('matches enhancement level exactly, ignoring stock at a different level', () => {
        inventory.items = [{ itemHrid: '/items/sword', enhancementLevel: 3, count: 5 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, {
            itemHrid: '/items/sword',
            enhancementLevel: 5,
            requiredCount: 1,
            itemName: 'sword',
            onRetire,
        });
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).not.toHaveBeenCalled();
        expect(document.body.contains(tab)).toBe(true);

        inventory.items.push({ itemHrid: '/items/sword', enhancementLevel: 5, count: 1 });
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).toHaveBeenCalledWith(tab);
    });

    test('manual dismissal unsubscribes — no retire fires after the tab is dismissed by hand', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 1, itemName: 'plank', onRetire });

        tab.querySelector('[data-mwi-tab-dismiss="true"]').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        expect(document.body.contains(tab)).toBe(false);

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).not.toHaveBeenCalled();
    });

    test('removeMaterialTabs (the marketplace-close cleanup path) unsubscribes every watched tab', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 1, itemName: 'plank', onRetire });

        removeMaterialTabs();
        expect(document.body.contains(tab)).toBe(false);

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).not.toHaveBeenCalled();
    });

    test('the unwatch function returned by watchTabForAcquisition stops the watch on its own', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        const unwatch = watchTabForAcquisition(tab, {
            itemHrid: '/items/plank',
            requiredCount: 1,
            itemName: 'plank',
            onRetire,
        });
        unwatch();

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).not.toHaveBeenCalled();
    });

    test('re-registering the same tab replaces the previous watch rather than stacking a second one', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const firstRetire = vi.fn();
        const secondRetire = vi.fn();

        watchTabForAcquisition(tab, {
            itemHrid: '/items/plank',
            requiredCount: 1,
            itemName: 'plank',
            onRetire: firstRetire,
        });
        watchTabForAcquisition(tab, {
            itemHrid: '/items/sword',
            requiredCount: 1,
            itemName: 'sword',
            onRetire: secondRetire,
        });

        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();
        vi.runAllTimers();

        // Only watching /items/sword now, so plank showing up retires nothing
        expect(firstRetire).not.toHaveBeenCalled();
        expect(secondRetire).not.toHaveBeenCalled();
    });

    test('retires immediately when the item is already in inventory at registration time', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 5 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 1, itemName: 'plank', onRetire });
        vi.runAllTimers();

        expect(document.body.contains(tab)).toBe(false);
        expect(onRetire).toHaveBeenCalledWith(tab);
    });

    test("a character switch retires the watch before the new character's inventory can be read", () => {
        // Character A pins a tab for an item A does not have…
        inventory.items = [];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 3, itemName: 'plank', onRetire });
        expect(document.body.contains(tab)).toBe(true);

        // …then switches character. character_switching fires before dataManager
        // exposes the new inventory, and must tear the watch (and its tab) down.
        emitCharacterSwitching();
        expect(document.body.contains(tab)).toBe(false);

        // Character B's inventory arrives — B already holds enough of the item.
        // Without the switch teardown, the stale watcher would read B's stock and
        // fire "Acquired" for A's tab.
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 5 }];
        sendInventoryUpdate();
        vi.runAllTimers();

        expect(onRetire).not.toHaveBeenCalled();
    });

    test('a character switch during the ✓ window cancels the pending removal without firing onRetire', () => {
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 0 }];
        const tab = buildTab();
        const onRetire = vi.fn();

        watchTabForAcquisition(tab, { itemHrid: '/items/plank', requiredCount: 1, itemName: 'plank', onRetire });

        // Acquisition detected — tab shows ✓ and its removal is pending
        inventory.items = [{ itemHrid: '/items/plank', enhancementLevel: 0, count: 1 }];
        sendInventoryUpdate();
        expect(document.body.contains(tab)).toBe(true);

        // The switch lands inside the ✓ window: the tab goes now, and the pending
        // onRetire must not fire into the new character's session
        emitCharacterSwitching();
        expect(document.body.contains(tab)).toBe(false);

        vi.runAllTimers();
        expect(onRetire).not.toHaveBeenCalled();
    });
});
