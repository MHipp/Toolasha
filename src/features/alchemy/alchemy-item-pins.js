/**
 * Alchemy Item Pins
 *
 * Pin the items you alchemize to the front of the picker, per action.
 *
 * The picker lists everything you own in whatever order the game keeps it, and
 * the handful of items anyone actually feeds it are scattered through that. The
 * alternative to pinning is typing the same filter every time — which works,
 * and is exactly the sort of thing worth not having to do twice a day.
 *
 * Per action, because the same item means different things in each: what is
 * worth coinifying is rarely what is worth decomposing, and a single shared
 * list would be the union of four unrelated shortlists.
 *
 * Pins reorder, they do not exempt. A pinned item that does not match what you
 * typed in the filter stays hidden — the filter has to keep meaning what it
 * says, or it stops being usable for finding anything else.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { findAlchemizeMenu, activeAlchemyAction, menuTiles, tileItemHrid } from './alchemy-item-selector.js';
import { createCuratedRecord } from '../../utils/persisted-record.js';
import { togglePin, orderTiles, sameOrder, mergePins } from '../../utils/item-picker-pins.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

// Re-exported so existing imports of the pure ordering/merge logic from this
// module (and its tests) keep working now that the logic lives in
// utils/item-picker-pins.js, shared with enhancement-item-pins.js.
export { togglePin, orderTiles, sameOrder, mergePins };

const STORAGE_KEY = 'alchemyItemPins';
const STYLE_ID = 'mwi-alchemy-pins-style';
const PIN_CLASS = 'mwi-alchemy-pin';
const PINNED_CLASS = 'mwi-alchemy-pinned';
/** Marks the element the pin is mounted on, which is not always the tile */
const TILE_CLASS = 'mwi-alchemy-tile';

/**
 * The pins as stored, per character. A curated record: a read that cannot be
 * made leaves the pins in hand rather than blanking them, no write goes out
 * over a store that could not be read first, and once this character's pins
 * have been read back an unpin sticks.
 */
const record = createCuratedRecord({
    base: STORAGE_KEY,
    store: 'settings',
    empty: () => ({}),
    merge: mergePins,
    migrate: 'adopt',
    label: 'AlchemyItemPins',
});

const CSS = `
    .${PIN_CLASS} {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 5;
        width: 15px;
        height: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 0 4px 0 4px;
        background: rgba(10, 14, 22, 0.75);
        color: #9ec4ff;
        font-size: 9px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.1s;
    }
    .${TILE_CLASS}:hover .${PIN_CLASS} { opacity: 1; }
    .${PIN_CLASS}:hover { color: #fff; background: rgba(77, 151, 255, 0.9); }
    .${PINNED_CLASS} .${PIN_CLASS} { opacity: 1; color: #ffcf5c; }
    .${PINNED_CLASS} { outline: 1px solid rgba(255, 207, 92, 0.55); outline-offset: -1px; border-radius: 4px; }
    .${TILE_CLASS} { position: relative; }
    /* No hover on a touchscreen: a pin hidden until hover would never appear, so
       they stay visible. But a full-size pin on every tile buries the item art
       and count underneath it, so keep them to a small corner badge and let the
       unpinned ones sit back at low opacity — a pinned tile's pin is gold and
       full-strength (the rule above wins on specificity), so it still reads. */
    @media (pointer: coarse) {
        .${PIN_CLASS} { opacity: 0.5; width: 18px; height: 18px; font-size: 11px; }
    }
`;

class AlchemyItemPins {
    constructor() {
        this.isInitialized = false;
        this.pins = {};
        /** Whose pins `this.pins` holds, so a switch never shows one character the other's */
        this.pinsOwner = null;
        this.unregister = null;
        this.applying = false;
        this.styleEl = null;
        this.menuObserver = null;
        this.watchedMenu = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('alchemyItemPins')) return;
        this.isInitialized = true;

        // Read here rather than at import, so a character switch — which
        // re-initialises the feature — picks up that character's own pins
        // Taken before the read, checked after it. A `character_switching`
        // teardown landing inside `loadPins()` has already removed the style
        // element and the menu watcher; carrying on here appended a second
        // <style> and registered a second observer that nothing holds an
        // unregister for, once per switch, for as long as the tab is open.
        const ticket = captureOwner(this);
        await this.loadPins();
        // `disable()` cleared `isInitialized`, so the switch's own
        // re-initialise is what puts the feature back up for the new character
        if (!stillOurs(ticket)) return;

        this.styleEl = document.createElement('style');
        this.styleEl.id = STYLE_ID;
        this.styleEl.textContent = CSS;
        document.head.appendChild(this.styleEl);

        this.unregister = domObserver.onClass('AlchemyItemPins', 'ItemSelector_menu', () => this.apply());
        this.apply();
    }

    /**
     * Read this character's pins back.
     *
     * The record is reset first so a switch never shows one character the
     * other's pins, nor folds them into the other's record; when the read
     * cannot be made the pins in hand stand, unless they were another
     * character's.
     * @returns {Promise<boolean>} Whether storage could be read
     */
    async loadPins() {
        const who = dataManager.getCurrentCharacterId() || null;
        const previous = who === this.pinsOwner ? this.pins : {};
        this.pinsOwner = who;
        record.reset();
        const readable = await record.load();
        if (!readable && Object.keys(previous).length > 0) record.set({ ...previous });
        this.pins = record.get() || {};
        return readable;
    }

    /**
     * Write the pins back, without making anybody wait for it.
     * @returns {Promise<boolean>} Whether the write landed
     */
    savePins() {
        record.set({ ...this.pins });
        return record.save().catch((error) => {
            console.error('[AlchemyItemPins] Saving pins failed:', error);
            return false;
        });
    }

    /** @returns {Promise<*>} The pending writes, for tests and shutdown */
    flushPinWrites() {
        return record.flushed();
    }

    disable() {
        noteTeardown(this);
        try {
            this.unregister?.();
            this.unregister = null;
            this.menuObserver?.disconnect();
            this.menuObserver = null;
            this.watchedMenu = null;
            this.styleEl?.remove();
            this.styleEl = null;
            document.querySelectorAll(`.${PIN_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${PINNED_CLASS}`).forEach((el) => el.classList.remove(PINNED_CLASS));
            document.querySelectorAll(`.${TILE_CLASS}`).forEach((el) => el.classList.remove(TILE_CLASS));
            this.isInitialized = false;
        } catch (error) {
            console.error('[Alchemy Item Pins] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Watch the open menu's contents.
     *
     * Typing in the filter box replaces the tiles inside the menu without
     * replacing the menu itself, so a watcher that only sees the menu appear
     * decorates it once and then never again — the pins vanish on the first
     * keystroke and never come back.
     *
     * @param {HTMLElement} menu - The open menu
     */
    watchMenu(menu) {
        if (this.watchedMenu === menu && this.menuObserver) return;

        this.menuObserver?.disconnect();
        this.watchedMenu = menu;
        // Children only. Decoration writes classes and titles, and reacting to
        // those would be reacting to itself.
        this.menuObserver = new MutationObserver(() => this.apply());
        this.menuObserver.observe(menu, { childList: true, subtree: true });
    }

    /** Put the pins for the open action at the front of the open menu */
    apply() {
        if (this.applying) return;

        const menu = findAlchemizeMenu();
        if (!menu) {
            this.menuObserver?.disconnect();
            this.menuObserver = null;
            this.watchedMenu = null;
            return;
        }
        this.watchMenu(menu);

        const action = activeAlchemyAction();
        if (!action) return;

        const { grid, tiles } = menuTiles(menu);
        if (!grid || !tiles.length) return;

        const pinned = this.pins[action] || [];
        const desired = orderTiles(tiles, pinned, tileItemHrid);

        this.applying = true;
        try {
            for (const tile of tiles) this.decorateTile(tile, action, pinned);
            if (sameOrder(tiles, desired)) return;

            // Anchored on the first tile so anything else sharing the grid —
            // the Remove button sits ahead of them — keeps its place
            const marker = document.createComment('mwi-pins');
            grid.insertBefore(marker, tiles[0]);
            const fragment = document.createDocumentFragment();
            for (const tile of desired) fragment.appendChild(tile);
            grid.insertBefore(fragment, marker);
            marker.remove();
        } finally {
            this.applying = false;
        }
    }

    /**
     * Give a tile its pin button and mark it if pinned.
     * @param {HTMLElement} tile - Item tile
     * @param {string} action - Alchemy action the menu is open for
     * @param {string[]} pinned - Pinned hrids for that action
     */
    decorateTile(tile, action, pinned) {
        const itemHrid = tileItemHrid(tile);
        if (!itemHrid) return;

        const isPinned = pinned.includes(itemHrid);
        // The pin hangs off whichever element the grid can actually move, which
        // is a wrapper around the tile rather than the tile itself — so the
        // hover rule is keyed to a class of ours rather than the game's
        tile.classList.add(TILE_CLASS);
        tile.classList.toggle(PINNED_CLASS, isPinned);

        let button = tile.querySelector(`.${PIN_CLASS}`);
        if (!button) {
            button = document.createElement('button');
            button.className = PIN_CLASS;
            button.type = 'button';
            // Capture phase and both handlers: the tile itself selects the item
            // on click, and a pin that also picked the item would be unusable
            button.addEventListener('mousedown', (event) => event.stopPropagation());
            button.addEventListener(
                'click',
                (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggle(tile);
                },
                true
            );
            tile.appendChild(button);
        }
        // Written only when it would actually change. Assigning the same text
        // still replaces the node, which the menu watcher would see as the menu
        // changing, which would decorate again — forever.
        if (button.textContent !== '📌') button.textContent = '📌';
        const title = isPinned ? `Unpin from ${action}` : `Pin to the front of ${action}`;
        if (button.title !== title) button.title = title;
        if (button.dataset.mwiPinAction !== action) button.dataset.mwiPinAction = action;
    }

    /**
     * Pin or unpin the item a tile stands for.
     * @param {HTMLElement} tile - Item tile
     */
    toggle(tile) {
        const itemHrid = tileItemHrid(tile);
        const action = tile.querySelector(`.${PIN_CLASS}`)?.dataset.mwiPinAction || activeAlchemyAction();
        if (!itemHrid || !action) return;

        this.pins = togglePin(this.pins, action, itemHrid);
        this.apply();
        this.savePins();
    }
}

const alchemyItemPins = new AlchemyItemPins();
export default alchemyItemPins;
