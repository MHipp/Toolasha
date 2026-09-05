/**
 * Market Item Hop
 *
 * Steps between marketplace items without the round trip through "View All Items".
 *
 * Opening an item's marketplace page is what makes the game fetch that item's live prices, so
 * the clicking is the point — the return trip to the grid is the waste. This remembers the item
 * grid the user was last looking at (in the order and with the filtering the grid itself was
 * showing) and moves straight from one item's order book to the next, the same way
 * listing-next-navigator.js cycles My Listings.
 *
 * Two ways in, one code path: `[` / `]` on the keyboard, and a "◀ / ▶" pair injected into the
 * game's own marketplace nav row, next to Refresh — where the eye already is, unlike the far-left
 * "View All Items" button. Escape returns to the grid. Nothing ever moves on its own; one
 * keypress or one click is exactly one step.
 *
 * Stepping stops at the ends rather than wrapping — see `_step`.
 *
 * Default off: it binds document-level keys, so nobody who did not ask for it gets them.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { itemHridFromIcon } from '../../utils/item-icon.js';
import { GAME } from '../../utils/selectors.js';

const NAV_CONTAINER_SEL = '[class*="MarketplacePanel_marketNavButtonContainer"]';
const GRID_ITEM_SEL = 'div[class*="Item_itemContainer"]';
const MODAL_SEL = '[class*="Modal_modalContainer"]';
const BTN_CLASS = 'Button_button__1Fe9z Button_small__3fqC7';
const PREV_BTN_ID = 'mwi-item-hop-prev';
const NEXT_BTN_ID = 'mwi-item-hop-next';

/** Key → step direction. `[` / `]` are unused by the game and are the conventional prev/next pair. */
const STEP_KEYS = { '[': -1, ']': 1 };

/**
 * Whether a keystroke is destined for somewhere text is being entered.
 *
 * Swallowing a keystroke the user meant for chat is far worse than the tedium this feature
 * removes, so this errs wide: the event target, the focused element, and any contenteditable
 * ancestor of either all count.
 *
 * @param {KeyboardEvent} event - The keydown being considered
 * @returns {boolean} True when the key belongs to a text field and must be left alone
 */
function isTypingTarget(event) {
    const candidates = [event.target, document.activeElement];
    for (const node of candidates) {
        const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (!el?.closest) continue;
        if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
            return true;
        }
    }
    return false;
}

class MarketItemHop {
    constructor() {
        this.isInitialized = false;
        this.watcher = null;
        this.keyHandler = null;
        this.prevBtn = null;
        this.nextBtn = null;
        // Ordered item hrids from the last time the item grid was on screen. Held across the
        // navigation into an item's page, because the grid leaves the DOM at that point.
        this.items = [];
    }

    /**
     * Start watching the marketplace and listening for the step keys.
     * @returns {void}
     */
    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_itemHop')) return;
        this.isInitialized = true;

        this.keyHandler = (event) => this._handleKey(event);
        document.addEventListener('keydown', this.keyHandler);

        const update = () => this._update();
        this.watcher = createMutationWatcher(document.body, update, { childList: true, subtree: true });
        update();
    }

    /**
     * Ordered item hrids currently drawn in the marketplace grid, or null when the grid is not
     * on screen.
     *
     * Items the user's own filters hid (`market-filter.js` sets `display: none`) are left out:
     * the set worth stepping through is the set they can see, which for a transmute sweep is
     * exactly the filtered handful rather than the whole catalogue.
     *
     * @returns {string[]|null} Item hrids in grid order, or null when there is no grid
     */
    _readGrid() {
        const grid = document.querySelector(GAME.MARKETPLACE_ITEMS);
        if (!grid) return null;

        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        const hrids = [];
        for (const tile of grid.querySelectorAll(GRID_ITEM_SEL)) {
            if (tile.style.display === 'none') continue;
            const itemHrid = itemHridFromIcon(tile, itemDetailMap);
            if (itemHrid && !hrids.includes(itemHrid)) hrids.push(itemHrid);
        }
        return hrids;
    }

    /**
     * Item hrid of the order book currently open, read from its icon's sprite rather than the
     * displayed name, which is translated in the player's chosen game language.
     * @returns {string|null} Item hrid, or null when no item page is open
     */
    _currentItemHrid() {
        const currentItemEl = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (!currentItemEl) return null;
        return itemHridFromIcon(currentItemEl, dataManager.getInitClientData()?.itemDetailMap);
    }

    /**
     * Where the open item sits in the remembered grid.
     * @returns {number} Index into `this.items`, or -1 when the open item is not one of them
     */
    _currentIndex() {
        const itemHrid = this._currentItemHrid();
        if (!itemHrid) return -1;
        return this.items.indexOf(itemHrid);
    }

    /**
     * Move one item along the remembered grid.
     *
     * Stops at the ends instead of wrapping. A sweep is a finite job, and running off the last
     * item back to the first — potentially hundreds of tiles away in an unfiltered grid — reads
     * as a navigation bug rather than a feature. The buttons go disabled at each end so the stop
     * is visible before it is hit.
     *
     * @param {number} direction - -1 for previous, 1 for next
     * @returns {boolean} True when the game was navigated
     */
    _step(direction) {
        const index = this._currentIndex();
        if (index === -1) return false;

        const target = index + direction;
        if (target < 0 || target >= this.items.length) return false;

        navigateToMarketplace(this.items[target], 0);
        return true;
    }

    /**
     * Return to the item grid by pressing the game's own back button.
     *
     * The button is found by text, the way listing-next-navigator.js finds Refresh, with the
     * first non-Refresh native button in the nav row as a fallback for a build that renames it.
     * Failing to find one does nothing at all rather than guessing.
     *
     * @returns {boolean} True when a back button was clicked
     */
    _backToGrid() {
        const container = document.querySelector(NAV_CONTAINER_SEL);
        if (!container) return false;

        const native = Array.from(container.querySelectorAll('button')).filter(
            (btn) => btn.id !== PREV_BTN_ID && btn.id !== NEXT_BTN_ID
        );
        const back =
            native.find((btn) => /view all/i.test(btn.textContent)) ||
            native.find((btn) => btn.textContent.trim() !== 'Refresh');
        if (!back) return false;

        back.click();
        return true;
    }

    /**
     * Document-level keydown. Every path out of here is a no-op unless the marketplace is
     * showing an item's order book, the user is not typing, and no modifier that would mean
     * something else is held.
     * @param {KeyboardEvent} event - The keydown
     * @returns {void}
     */
    _handleKey(event) {
        // IME composition produces keydowns whose key is meaningless; never act on one.
        if (event.isComposing || event.keyCode === 229) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTypingTarget(event)) return;
        if (!document.querySelector(GAME.MARKETPLACE_PANEL)) return;
        if (!document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM)) return;

        if (event.key === 'Escape') {
            // A modal's own Escape handling outranks this; the marketplace is behind it.
            if (document.querySelector(MODAL_SEL)) return;
            if (this._backToGrid()) event.preventDefault();
            return;
        }

        const direction = STEP_KEYS[event.key];
        if (!direction) return;
        // Shift+[ produces '{', so `event.key` has already excluded shifted variants; the guard
        // above covers the rest.
        if (this._step(direction)) event.preventDefault();
    }

    /**
     * Remove the injected buttons.
     * @returns {void}
     */
    _removeButtons() {
        for (const btn of [this.prevBtn, this.nextBtn]) {
            if (btn && btn.parentNode) btn.remove();
        }
        this.prevBtn = null;
        this.nextBtn = null;
    }

    /**
     * Make one of the injected step buttons.
     * @param {string} id - Element id
     * @param {string} label - Button text
     * @param {string} title - Tooltip, which is where the keyboard shortcut is discovered
     * @param {number} direction - -1 for previous, 1 for next
     * @returns {HTMLButtonElement} The button
     */
    _makeButton(id, label, title, direction) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = BTN_CLASS;
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', () => this._step(direction));
        return btn;
    }

    /**
     * Re-read the grid when it is on screen, and keep the injected buttons in step with whatever
     * page the marketplace is showing.
     * @returns {void}
     */
    _update() {
        // A MutationObserver callback can still be queued when cleanup() runs; without this it
        // would re-inject the buttons the teardown just removed.
        if (!this.isInitialized) return;

        const grid = this._readGrid();
        // Only a grid with something in it replaces the remembered set: the container renders
        // empty for a moment while the game swaps views, and letting that through would wipe the
        // set the user is mid-sweep on.
        if (grid && grid.length > 0) this.items = grid;

        const container = document.querySelector(NAV_CONTAINER_SEL);
        const index = container ? this._currentIndex() : -1;

        if (index === -1 || this.items.length < 2) {
            this._removeButtons();
            return;
        }

        if (this.prevBtn && !document.body.contains(this.prevBtn)) this.prevBtn = null;
        if (this.nextBtn && !document.body.contains(this.nextBtn)) this.nextBtn = null;

        if (!this.prevBtn) {
            this.prevBtn = this._makeButton(PREV_BTN_ID, '◀', 'Previous market item (hotkey: [ )', -1);
            container.appendChild(this.prevBtn);
        }
        if (!this.nextBtn) {
            this.nextBtn = this._makeButton(NEXT_BTN_ID, '▶', 'Next market item (hotkey: ] )', 1);
            container.appendChild(this.nextBtn);
        }

        this.prevBtn.disabled = index === 0;
        this.nextBtn.disabled = index === this.items.length - 1;

        const position = ` ${index + 1}/${this.items.length}`;
        if (this.nextBtn.textContent !== `▶${position}`) this.nextBtn.textContent = `▶${position}`;
    }

    /**
     * Tear down the watcher, the key listener and the injected buttons.
     * @returns {void}
     */
    cleanup() {
        try {
            if (this.watcher) {
                this.watcher();
                this.watcher = null;
            }
            if (this.keyHandler) {
                document.removeEventListener('keydown', this.keyHandler);
                this.keyHandler = null;
            }
            this._removeButtons();
            this.items = [];
        } catch (error) {
            console.error('[Market Item Hop] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const marketItemHop = new MarketItemHop();
export default marketItemHop;
