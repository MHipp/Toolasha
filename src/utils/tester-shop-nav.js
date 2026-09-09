/**
 * Getting to the Tester shop, and narrowing it to one item.
 *
 * The DOM half of `tester-shop.js`: that module prices against the shop, this
 * one walks there. Two surfaces need the same walk — the missing-materials
 * bill and the Item Dictionary's ability-book panel — so it lives here rather
 * than as a copy in each.
 *
 * Nothing here buys anything. The walk ends with the shop filtered to the item
 * and (the caller's job) a quantity armed; the player presses Buy. One click,
 * one game action is the rule, and a helper that clicked a shop card for you
 * would break it.
 */

import { createTimerRegistry } from './timer-registry.js';
import { setReactInputValue } from './react-input.js';

const timerRegistry = createTimerRegistry();

/** Resolve after `ms`, through the registry so a teardown cancels it */
function wait(ms) {
    return new Promise((resolve) => {
        timerRegistry.registerTimeout(setTimeout(resolve, ms));
    });
}

/**
 * The Shop's Tester tab, when its strip is on screen.
 * @returns {HTMLElement|null}
 */
export function findTesterTab() {
    for (const container of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
        if (container.offsetParent === null) continue;
        const tab = Array.from(container.children).find((el) => /^\s*tester\s*$/i.test(el.textContent || ''));
        if (tab) return tab;
    }
    return null;
}

/**
 * Type a name into the shop's item filter, when the box is on screen.
 * @param {string} itemName - The item, as the shop names it
 * @returns {boolean} Whether a filter box was there to type into
 */
export function setShopFilter(itemName) {
    const input = Array.from(document.querySelectorAll('input')).find(
        (el) => el.offsetParent !== null && /filter/i.test(el.placeholder || '')
    );
    if (input) setReactInputValue(input, itemName || '');
    return Boolean(input);
}

/**
 * Open the Shop on its Tester tab.
 *
 * The shop's nav entry, then the tab that says Tester. Each step that cannot
 * be found is logged and reported as a failure, so the caller can fall back
 * to the marketplace rather than leave the player nowhere.
 *
 * @returns {Promise<HTMLElement|null>} The Tester tab once selected, else null
 */
export async function openTesterShopPage() {
    const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
    const shopButton = Array.from(navButtons).find((nav) => nav.querySelector('svg[aria-label="navigationBar.shop"]'));
    if (!shopButton) {
        console.error('[TesterShopNav] Shop navbar button not found');
        return null;
    }
    shopButton.click();

    for (let i = 0; i < 30; i++) {
        await wait(100);
        const testerTab = findTesterTab();
        if (testerTab) {
            testerTab.click();
            await wait(150);
            return testerTab;
        }
    }
    console.error('[TesterShopNav] Tester shop tab not found');
    return null;
}

export default { findTesterTab, setShopFilter, openTesterShopPage };
