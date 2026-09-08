/**
 * Chest Key Market Button
 *
 * Adds a "Buy Keys on Marketplace" button to the item action menu of any chest
 * that opens with a key — the popup that says "Open 0 (Keys: 0)" and then
 * leaves you to find the key in the marketplace yourself.
 *
 * The popup's class names vary with game builds, so menus are found the same
 * way the ability dictionary button finds its own: by their "Link to Chat"
 * button, walking up to the container that carries the item's name. Which items
 * qualify is decided by the game data rather than a list: a chest's key shares
 * its slug with `_key` appended (`/items/chimerical_chest` →
 * `/items/chimerical_chest_key`), so an item whose `_key` sibling exists in
 * `itemDetailMap` is a keyed chest and everything else is left alone.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { gameDigitsSource } from '../../utils/number-parser.js';

const BTN_CLASS = 'mwi-chest-key-market-btn';

/**
 * The key that opens an item, when the game data says it has one.
 *
 * @param {string} itemHrid - The item shown in the menu
 * @param {Object} itemDetailMap - The game's item details
 * @returns {string|null} The key's item hrid, or null when this is not a keyed chest
 */
export function chestKeyFor(itemHrid, itemDetailMap) {
    if (!itemHrid || !itemDetailMap) return null;
    // A key's own menu should not offer to buy itself
    if (itemHrid.endsWith('_key')) return null;
    const keyHrid = `${itemHrid}_key`;
    return itemDetailMap[keyHrid] ? keyHrid : null;
}

class ChestKeyMarketButton {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this._itemNameToHrid = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('chestKeyMarketButton')) return;
        this.isInitialized = true;

        const unregister = domObserver.register('ChestKeyMarketButton', (node) => this._scan(node));
        this.unregisterHandlers.push(unregister);

        // @run-at document-start: a menu rendered before the shared observer attaches to
        // document.body is invisible to it, so the catch-up scan waits for the observer's
        // actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(
            domObserver.onReady('ChestKeyMarketButtonCatchUp', () => {
                this._scan(document.body);
            })
        );
    }

    /**
     * Find item action menus inside an added subtree via their Link to Chat button.
     * @param {HTMLElement} root
     * @private
     */
    _scan(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
        const buttons = [];
        if (root.tagName === 'BUTTON') buttons.push(root);
        if (root.childElementCount > 0) buttons.push(...root.querySelectorAll('button'));

        for (const btn of buttons) {
            if (btn.textContent.trim() !== 'Link to Chat') continue;
            // The menu is the nearest ancestor that carries the item's name node
            let menu = btn.parentElement;
            for (let depth = 0; menu && depth < 4; depth++) {
                if (menu.querySelector('[class*="Item_name"]')) break;
                menu = menu.parentElement;
            }
            if (menu) this._injectButton(menu, btn);
        }
    }

    /**
     * Lazy item-name → hrid lookup built from game data.
     * @returns {Map<string, string>}
     * @private
     */
    _getItemNameMap() {
        if (this._itemNameToHrid) return this._itemNameToHrid;
        const map = new Map();
        const itemMap = dataManager.getInitClientData()?.itemDetailMap || {};
        for (const [hrid, details] of Object.entries(itemMap)) {
            if (details?.name) map.set(details.name.toLowerCase(), hrid);
        }
        if (map.size > 0) this._itemNameToHrid = map;
        return map;
    }

    /**
     * Resolve the item an action menu belongs to via its name node.
     * @param {HTMLElement} menu
     * @returns {string|null} Item hrid
     * @private
     */
    _findItemHrid(menu) {
        const nameNode = menu.querySelector('[class*="Item_name"]');
        if (!nameNode) return null;

        // The heading may carry a count — "3 Chimerical Chest" — so the bare
        // name is tried first and the count stripped as the fallback. Grouped
        // by the game's current locale rather than a hardcoded comma: in a
        // period-grouping locale a count above 999 leaves a leftover ".234"
        // glued to the name, and the lookup misses.
        const text = (nameNode.textContent || '').trim();
        const map = this._getItemNameMap();
        const stripLeadingCount = new RegExp(`^(?:${gameDigitsSource({ decimal: false })})\\s+`);
        return map.get(text.toLowerCase()) || map.get(text.replace(stripLeadingCount, '').toLowerCase()) || null;
    }

    /**
     * Inject the marketplace button into a keyed chest's action menu.
     * @param {HTMLElement} menu - Menu container
     * @param {HTMLElement} referenceBtn - The menu's Link to Chat button (style + anchor)
     * @private
     */
    _injectButton(menu, referenceBtn) {
        if (!menu || menu.querySelector(`.${BTN_CLASS}`)) return;

        const itemHrid = this._findItemHrid(menu);
        const keyHrid = chestKeyFor(itemHrid, dataManager.getInitClientData()?.itemDetailMap);
        if (!keyHrid) return;

        const btn = document.createElement('button');
        btn.className = `${referenceBtn?.className || ''} ${BTN_CLASS}`.trim();
        btn.textContent = 'Buy Keys on Marketplace';
        btn.style.cssText = 'cursor: pointer; width: 100%; margin-top: 4px;';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                navigateToMarketplace(keyHrid);
            } catch (error) {
                console.error('[ChestKeyMarketButton] Could not open the marketplace:', error);
            }
        });

        if (referenceBtn?.parentElement) {
            referenceBtn.insertAdjacentElement('afterend', btn);
        } else {
            menu.appendChild(btn);
        }
    }

    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => btn.remove());
        this._itemNameToHrid = null;
        this.isInitialized = false;
    }
}

const chestKeyMarketButton = new ChestKeyMarketButton();

export default {
    name: 'Chest Key Market Button',
    initialize: () => {
        chestKeyMarketButton.initialize();
    },
    cleanup: () => {
        chestKeyMarketButton.disable();
    },
    disable: () => {
        try {
            chestKeyMarketButton.disable();
        } catch (error) {
            console.error('[Chest Key Market Button] Disable failed part-way:', error);
        } finally {
            chestKeyMarketButton.isInitialized = false;
        }
    },
};

export { chestKeyMarketButton };
