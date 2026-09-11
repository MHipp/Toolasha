/**
 * Watchlist
 *
 * A list of items you care about, what you hold, and what it is worth.
 *
 * Inventory Value already says what the whole bag is worth, which is a number
 * you cannot act on — it moves when anything moves. The question behind this one
 * is narrower and answerable: *these thirty things, how many have I got, what
 * are they worth, and which of them should I not be selling on the market.*
 *
 * ## Building the list is the feature
 *
 * Adding thirty items one at a time is thirty clicks and a wiki tab, and nobody
 * does it twice. So a whole zone's drop table goes on with one tick, read from
 * the game's own data — both drop tables of every ordinary spawn and every boss,
 * or the reward table if it is a dungeon. Chests work the same way. Items can
 * still be added one at a time, and those are never removed by un-ticking
 * anything.
 *
 * ## The vendor warning
 *
 * A market bid below what the vendor pays flat is not a price, it is a trap, and
 * a list that reports it as the item's value quietly advises the worse of two
 * sales. Those rows show the vendor price and say so. Toolasha already made this
 * comparison inside the bulk-sell flow; here it stands as a property of the item
 * rather than as a step in selling one.
 *
 * The set algebra is in `utils/watchlist.js` and the drop-table walking in
 * `utils/drop-sources.js`, both with tests. This module reads the game, draws
 * the panel, and does no arithmetic of its own.
 *
 * The panel is NTally's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import marketAPI from '../../api/marketplace.js';
import { createCuratedRecord } from '../../utils/persisted-record.js';
import { getItemPrices } from '../../utils/market-data.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { itemIcon, linkToMarketplace, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { getItemHridFromName } from '../../utils/game-lookups.js';
import {
    addToWatchlist,
    removeFromWatchlist,
    removeSource,
    valueWatchlist,
    watchlistTotals,
    sortRows,
    listedCounts,
    watchlistKey,
    entryKey,
    mergeWatchlists,
    WATCHLIST_KEY,
} from '../../utils/watchlist.js';
import { combatZones, zoneDrops, openableItems, openableDrops } from '../../utils/drop-sources.js';
import { registerRow } from '../../utils/overlay-rows.js';
import inventoryBadgeManager from './inventory-badge-manager.js';
import domObserver from '../../core/dom-observer.js';

const PANEL_ID = 'toolasha-watchlist-panel';
const GEOMETRY_KEY = 'watchlistPanel';
const DEFAULT_PANEL = { width: 560, height: 640 };
const REFRESH_MS = 5000;
const DOT_CLASS = 'toolasha-watchlist-dot';
const MENU_BUTTON_CLASS = 'toolasha-watchlist-track';
const MENU_BUTTON_SETTING = 'watchlist_menuButton';
const DOTS_SETTING = 'watchlist_inventoryDots';

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(20, 30, 24, 0.9)',
    border: 'rgba(120, 210, 150, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#7fd6a3',
};

/**
 * What the list is and which sets built it.
 *
 * At module scope and persisted, because the overlay row and the inventory dot
 * both read it while the panel is closed — which is most of the time.
 */
const state = { entries: [], zones: {}, chests: {}, sortBy: 'value', direction: 'desc' };

/** What a character with no saved list starts from */
const emptyState = () => ({ entries: [], zones: {}, chests: {}, sortBy: 'value', direction: 'desc' });

/**
 * Fold a stored list under the one in memory — only used before the list has
 * been read back (see `createCuratedRecord`): entries by item, the sets by key,
 * memory's sort order.
 * @param {Object} stored - The list as read back
 * @param {Object} memory - The list as held
 * @returns {Object} The merged state
 */
function mergeStates(stored, memory) {
    // The same fold a cross-device sync pull performs (`utils/watchlist.js`
    // registers it), over `emptyState()` so a partial stored shape still comes
    // back with a sort order on it. Two tabs on one machine and two devices are
    // the same problem at different speeds, and one fold is what keeps them
    // from drifting apart.
    return { ...emptyState(), ...mergeWatchlists(stored, memory) };
}

/**
 * The list as stored, per character.
 *
 * A curated record: once this character's list has been read back, what the
 * user has in memory is the list and a removal sticks; before that, a save
 * folds the stored list under memory so nothing is lost. A read that cannot be
 * made leaves the list in hand rather than blanking it, and no write goes out
 * over a store that could not be read first.
 */
const record = createCuratedRecord({
    base: WATCHLIST_KEY,
    store: 'settings',
    empty: emptyState,
    merge: mergeStates,
    label: 'Watchlist',
});

/** Whose list `state` holds, so a switch never shows one character the other's */
let stateOwner = null;

/**
 * Read this character's list back.
 *
 * Waits for the database — it is opened after the libraries are evaluated, so a
 * read at module scope always returns the default and the list looks like it
 * forgot everything — and for a character, because the key it reads is that
 * character's and there is no answer before login.
 *
 * When the read cannot be made the state is left as it was rather than
 * blanked — unless it is another character's list, which must not stand in
 * for this one's (nor be folded into it by the next save), readable or not.
 * @returns {Promise<void>}
 */
async function reload() {
    try {
        await storage.ready;
        const who = dataManager.getCurrentCharacterId() || null;
        record.reset();
        if (who !== stateOwner) {
            Object.assign(state, emptyState());
            stateOwner = who;
        }
        const readable = await record.load();
        if (readable) Object.assign(state, emptyState(), record.get());
        // The dot has by now drawn the previous character's list on every item
        inventoryBadgeManager.invalidateCache?.();
    } catch (error) {
        console.error('[Watchlist] Reading the watchlist failed:', error);
    }
}

reload();
// The key is the character's, so the list has to be read again as a different
// one — features are re-initialised on a switch but this state is module-scope
// and outlives that
dataManager.on('character_initialized', reload);
dataManager.on('character_switched', reload);

/** Write the list back, without making anybody wait for it */
function persist() {
    record.set({ ...state });
    record.save().catch((error) => console.error('[Watchlist] Saving the list failed:', error));
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushWatchlistWrites() {
    return record.flushed();
}

/**
 * Whether an item is on the list.
 *
 * Exported because it is what the inventory dot asks, and because "is this
 * tracked" is a reasonable thing for anything else to want to know.
 *
 * Any level answers by default, which is what the dot wants: an inventory tile
 * is an item, the dot is "you are tracking this thing", and a +0 stack going
 * undotted because the row on the list is the +5 would read as the dot being
 * broken. Ask about one level to get the narrower answer.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Only this enhancement, when given
 * @returns {boolean}
 */
export function isWatched(itemHrid, enhancementLevel = null) {
    if (enhancementLevel === null) return state.entries.some((entry) => entry.hrid === itemHrid);

    const key = watchlistKey(itemHrid, enhancementLevel);
    return state.entries.some((entry) => entryKey(entry) === key);
}

/** @returns {Array<Object>} The raw list */
export function watchlistEntries() {
    return [...state.entries];
}

/**
 * Put one item on the list by hand.
 *
 * By hand means no set owns it, so un-ticking every zone and chest leaves it
 * exactly where it is.
 *
 * An enhancement level may be given, and when it is it is part of which row
 * this is: the upgrade advisor's Watch button hands over "Cheese Sword +5", and
 * a list that stored that as a Cheese Sword would quote the +0 price for a
 * target that costs many times it.
 *
 * @param {string} itemHrid - The item
 * @param {string} [name] - Its display name
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function watchItem(itemHrid, name, enhancementLevel = 0) {
    const level = Number(enhancementLevel) || 0;
    // The level is in the name because the name is the whole of what a row says
    // it is about; two rows reading "Cheese Sword" would be unreadable
    const label = name || (level > 0 ? `${nameOf(itemHrid)} +${level}` : nameOf(itemHrid));
    state.entries = addToWatchlist(state.entries, [{ hrid: itemHrid, name: label, enhancementLevel: level }], null);
    persist();
}

/**
 * Take one item off, whichever set put it there.
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 */
export function unwatchItem(itemHrid, enhancementLevel = 0) {
    state.entries = removeFromWatchlist(state.entries, itemHrid, enhancementLevel);
    persist();
}

/**
 * Empty the list, and untick every set.
 *
 * Both, because they are one thing: leaving the sets ticked would leave every
 * checkbox claiming to have put rows on a list with no rows on it, and the next
 * tick of that box would do nothing visible.
 *
 * One tick can add thirty rows, so undoing a mess has to be one gesture too.
 */
export function clearWatchlist() {
    state.entries = [];
    state.zones = {};
    state.chests = {};
    persist();
    inventoryBadgeManager.invalidateCache?.();
}

/**
 * @param {string} itemHrid - The item
 * @returns {string} Its name, or something readable from the hrid
 */
function nameOf(itemHrid) {
    return dataManager.getItemDetails?.(itemHrid)?.name || String(itemHrid).replace('/items/', '').replace(/_/g, ' ');
}

/**
 * How many of an item the character holds, across every stack.
 *
 * Summed rather than taken from the first match: the same item at different
 * enhancement levels is several inventory entries, and reporting one of them is
 * reporting a number that is right for nothing.
 *
 * Equipped items don't reliably carry a count field the way stacked inventory
 * items do (see loadout-snapshot.js `highestOwnedEnhancements` and
 * equipment-savings-row.js `highestOwnedLevel`/`ladderStart` for the same
 * family of bug) — a weapon sitting only in its equipment slot arrives with no
 * `count` at all. Reading that as `0` reported a tracked item you are wearing
 * as zero held. A missing count is one held; an explicit `0` (removed from
 * this location) is skipped, as it is everywhere else this pattern lives.
 *
 * Summed across levels only for a row that is not about one: a row tracking the
 * +5 counts the +5s, because "how many have I got" about a +5 is not answered
 * by a drawer full of +0s.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which enhancement the row is about, if any
 * @returns {number}
 */
function heldCount(itemHrid, enhancementLevel = 0) {
    const level = Number(enhancementLevel) || 0;
    let total = 0;
    for (const entry of dataManager.getInventory?.() || []) {
        if (entry?.itemHrid !== itemHrid || entry.count === 0) continue;
        if (level > 0 && (Number(entry.enhancementLevel) || 0) !== level) continue;
        total += entry.count ?? 1;
    }
    return total;
}

/**
 * What the vendor pays flat for an item.
 * @param {string} itemHrid - The item
 * @returns {number}
 */
function vendorPriceOf(itemHrid) {
    return dataManager.getItemDetails?.(itemHrid)?.sellPrice || 0;
}

/**
 * The watchlist export, one row per tracked item.
 *
 * Raw numbers rather than the panel's `1.2M` — a spreadsheet needs `1200000`
 * to sort or sum a column, and a CSV of display strings is a screenshot with
 * extra steps.
 */
export const WATCHLIST_CSV_COLUMNS = [
    { key: 'name', label: 'Item' },
    { key: 'enhancementLevel', label: 'Enhancement' },
    { key: 'held', label: 'Held' },
    { key: 'listed', label: 'Listed' },
    { key: 'unclaimed', label: 'Unclaimed' },
    { key: 'quantity', label: 'Total Qty' },
    { key: 'ask', label: 'Ask (unit)' },
    { key: 'bid', label: 'Bid (unit)' },
    { key: 'totalAsk', label: 'Total Ask' },
    { key: 'totalBid', label: 'Total Bid' },
    { key: 'flag', label: 'Flag' },
];

/**
 * Every row, priced and counted.
 * @returns {Array<Object>} From `valueWatchlist`, sorted
 */
export function watchlistRows() {
    // Built once per pass rather than per row: it is a walk of every listing,
    // and there are more rows than listings
    const listed = listedCounts(
        dataManager.getCharacterData?.()?.myMarketListings || dataManager.characterData?.myMarketListings
    );

    const rows = valueWatchlist(state.entries, {
        quantityOf: heldCount,
        pricesFor: (hrid, level) => getItemPrices(hrid, level),
        vendorOf: vendorPriceOf,
        listedOf: (hrid, level) => listed[watchlistKey(hrid, level)],
    });
    return sortRows(rows, state.sortBy, state.direction);
}

/**
 * Tick or untick a set, adding or re-homing its items.
 *
 * @param {string} kind - `zones` or `chests`
 * @param {string} id - Which set
 * @param {boolean} on - Ticked or not
 */
function toggleSet(kind, id, on) {
    const source = `${kind}:${id}`;

    if (on) {
        state[kind][id] = true;
        state.entries = addToWatchlist(state.entries, contentsOf(kind, id), source);
    } else {
        delete state[kind][id];
        // Everything still ticked, so an item two sets share is re-homed rather
        // than lost — the reason this is not a filter
        const stillOn = [];
        for (const other of ['zones', 'chests']) {
            for (const otherId of Object.keys(state[other])) {
                stillOn.push({ id: `${other}:${otherId}`, hrids: contentsOf(other, otherId).map((item) => item.hrid) });
            }
        }
        state.entries = removeSource(state.entries, source, stillOn);
    }
    persist();
    inventoryBadgeManager.invalidateCache?.();
}

/**
 * @param {string} kind - `zones` or `chests`
 * @param {string} id - Which set
 * @returns {Array<{hrid: string, name: string}>}
 */
function contentsOf(kind, id) {
    const data = dataManager.getInitClientData?.();
    if (!data) return [];

    return kind === 'zones' ? zoneDrops(id, data) : openableDrops(id, data);
}

class WatchlistPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        this.collapsed = { zones: true, chests: true };
    }

    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '140px',
            left: '110px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height),
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 240 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header: this.headerEl,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: this.headerEl.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            // Nobody can see a folded panel's body; expanding is picked up by
            // the next tick, as on the other floating panels
            if (this.minimizeCtl?.collapsed) return;
            this._render();
        }, REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Watchlist';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        this.headerCount = document.createElement('span');
        this.headerCount.style.color = COLORS.textDim;

        this.headerTotal = document.createElement('span');
        this.headerTotal.style.color = ROW_COLORS.gold;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        // Both switches are here rather than in the body: they are about the
        // panel's reach into the rest of the game rather than about any one
        // item, and a row of tick boxes under a long table is a row nobody
        // scrolls to. They are the same settings the settings page has, not
        // copies, so the two can never disagree.
        this.dotsBtn = this._toggle(
            DOTS_SETTING,
            () => (config.getSetting(DOTS_SETTING) ? 'Dots on' : 'Dots off'),
            'A dot in the corner of every inventory tile holding a tracked item. Knowing what is on the list ' +
                'while you are looking at your inventory is the point of having one — but it is another mark on a ' +
                'busy grid, so it can go.'
        );
        this.menuBtn = this._toggle(
            MENU_BUTTON_SETTING,
            () => (config.getSetting(MENU_BUTTON_SETTING) ? 'Menu button on' : 'Menu button off'),
            'Adds Track / Untrack beside Sell when you click an inventory item. Off by default, because it ' +
                'changes a menu you open for other reasons and a misclick there is a sale.'
        );
        this.exportBtn = this._exportButton();

        header.append(
            title,
            this.headerCount,
            this.headerTotal,
            spacer,
            this.dotsBtn,
            this.menuBtn,
            this.exportBtn,
            close
        );
        return header;
    }

    /**
     * The CSV export button.
     *
     * A plain action rather than a toggle — same look as the two switches
     * beside it, since it belongs in the same row, but nothing here reflects a
     * setting. Disabled rather than removed when there is nothing to export:
     * removing it on an empty list would move every other header control on
     * the one refresh that emptied it.
     *
     * @returns {HTMLButtonElement}
     */
    _exportButton() {
        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.title =
            'Save every tracked item as a spreadsheet — held, listed, unclaimed and both prices, raw numbers.';
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 7px',
            whiteSpace: 'nowrap',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                const rows = watchlistRows();
                if (!rows.length) return;
                downloadCsv(csvFilename('watchlist'), toCsv(rows, WATCHLIST_CSV_COLUMNS));
            } catch (error) {
                console.error('[Watchlist] CSV export failed:', error);
            }
        });
        return button;
    }

    /**
     * A header switch that says which way it is set.
     *
     * @param {string} setting - Which setting it writes
     * @param {Function} label - Returns the current label
     * @param {string} title - Hover explanation
     * @returns {HTMLButtonElement}
     */
    _toggle(setting, label, title) {
        const button = document.createElement('button');
        button.title = title;
        button.dataset.setting = setting;
        button._label = label;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 7px',
            whiteSpace: 'nowrap',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            config.setSetting(setting, !config.getSetting(setting));
            this._paintToggles();
        });
        return button;
    }

    /**
     * Put the header switches in step with the settings they write.
     *
     * Called on every redraw and on the settings' own change callbacks, so a
     * switch flipped on the settings page moves the pill up here at once rather
     * than at the next five-second tick. Two switches over one setting are only
     * safe while neither can be seen saying the wrong thing.
     */
    _paintToggles() {
        for (const button of [this.dotsBtn, this.menuBtn]) {
            if (!button?._label) continue;
            button.textContent = button._label();
            const on = Boolean(config.getSetting(button.dataset.setting));
            button.style.color = on ? COLORS.accent : COLORS.textDim;
            button.style.opacity = on ? '1' : '0.7';
        }
    }

    _render() {
        if (!this.bodyEl) return;

        const rows = watchlistRows();
        const totals = watchlistTotals(rows);

        this.headerCount.textContent = `${totals.held} / ${totals.items}`;
        this.headerCount.title = 'How many of the tracked items you hold any of.';
        this.headerTotal.textContent = `${formatKMB(totals.ask)} ask · ${formatKMB(totals.bid)} bid`;
        this._paintToggles();

        if (this.exportBtn) {
            const hasRows = rows.length > 0;
            this.exportBtn.disabled = !hasRows;
            this.exportBtn.style.opacity = hasRows ? '1' : '0.4';
            this.exportBtn.style.cursor = hasRows ? 'pointer' : 'default';
        }

        // Drawn into a detached scratch box and swapped in only when the markup
        // actually changed — the combat-panels.js `_render` idiom. Counts and
        // prices hold still between inventory and market refreshes, so most
        // five-second ticks were a full teardown and re-layout for identical
        // pixels. The set checkboxes set their state via `.checked`, which is
        // on neither side of the compare: identical markup keeps the live DOM
        // (and its on-screen state), and a real swap rebuilds them from the
        // same stored state the builder reads.
        const scratch = document.createElement('div');
        for (const build of [
            () => this._sets('zones', 'Zones', combatZones(dataManager.getInitClientData?.()?.actionDetailMap)),
            () => this._sets('chests', 'Chests', openableItems(dataManager.getInitClientData?.())),
            () => this._table(rows),
        ]) {
            // One section that cannot be drawn must not take the others with it
            try {
                scratch.appendChild(build());
            } catch (error) {
                console.error('[Watchlist] A section could not be drawn:', error);
                const failed = this._note(`This section could not be drawn: ${error.message}`);
                failed.style.color = ROW_COLORS.bad;
                scratch.appendChild(failed);
            }
        }
        if (scratch.innerHTML !== this.bodyEl.innerHTML) {
            this.bodyEl.replaceChildren(...scratch.childNodes);
        }
    }

    /**
     * The tick boxes for one kind of set.
     *
     * @param {string} kind - `zones` or `chests`
     * @param {string} title - Heading
     * @param {Array<{id: string, name: string, isDungeon?: boolean}>} available - What can be ticked
     * @returns {HTMLElement}
     */
    _sets(kind, title, available) {
        const card = this._card();
        const on = Object.keys(state[kind]).length;

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            color: COLORS.accent,
            fontWeight: 'bold',
            cursor: 'pointer',
            userSelect: 'none',
        });
        heading.textContent = `${this.collapsed[kind] ? '▶' : '▼'} ${title}${on ? ` — ${on} on` : ''}`;
        heading.addEventListener('click', () => {
            this.collapsed[kind] = !this.collapsed[kind];
            this._render();
        });
        card.appendChild(heading);

        if (this.collapsed[kind]) return card;
        if (!available.length) {
            card.appendChild(this._note('Nothing loaded yet.'));
            return card;
        }

        const grid = document.createElement('div');
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))',
            gap: '2px 8px',
            marginTop: '5px',
        });

        for (const set of available) {
            const label = document.createElement('label');
            Object.assign(label.style, { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = Boolean(state[kind][set.id]);
            box.addEventListener('change', () => {
                toggleSet(kind, set.id, box.checked);
                this._render();
            });

            const name = document.createElement('span');
            name.textContent = set.name;
            name.style.overflow = 'hidden';
            name.style.textOverflow = 'ellipsis';
            name.style.whiteSpace = 'nowrap';
            if (set.isDungeon) {
                name.style.color = ROW_COLORS.accent;
                name.title = 'A dungeon — its drops come from the completion reward table, not from its monsters.';
            }

            label.append(box, name);
            grid.appendChild(label);
        }
        card.appendChild(grid);
        return card;
    }

    /**
     * @param {Array<Object>} rows - From `watchlistRows`
     * @returns {HTMLElement}
     */
    _table(rows) {
        const card = this._card();

        const heading = this._row();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.hairline}`;
        heading.style.paddingBottom = '3px';

        const clear = document.createElement('button');
        clear.textContent = '⌫';
        Object.assign(clear.style, {
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            padding: '0 2px',
        });
        clear.title = 'Empty the list and untick every set';
        clear.dataset.clearAll = 'true';
        clear.addEventListener('click', () => {
            clearWatchlist();
            this._render();
        });

        heading.append(
            document.createElement('span'),
            this._sortHeader('Item', 'name'),
            this._cell('Held'),
            this._cell('Unit'),
            this._sortHeader('Value', 'value', 'right'),
            rows.length ? clear : document.createElement('span')
        );
        card.appendChild(heading);

        if (!rows.length) {
            card.appendChild(this._note('Nothing tracked yet — tick a zone or a chest above.'));
            return card;
        }

        for (const item of rows) card.appendChild(this._itemRow(item));
        return card;
    }

    /**
     * @param {Object} item - One priced row
     * @returns {HTMLElement}
     */
    _itemRow(item) {
        const line = this._row();
        line.style.padding = '2px 0';

        const icon = itemIcon(item.hrid, 20);
        linkToMarketplace(icon, item.hrid, navigateToMarketplace);
        // Nothing held is still a row worth having — it is the part of the
        // collection you have not got — but it should not look like the rest
        if (!item.quantity) icon.style.filter = 'grayscale(100%)';
        icon.style.opacity = item.quantity ? '1' : '0.4';

        const name = document.createElement('span');
        name.textContent = item.name;
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(name, item.hrid, navigateToMarketplace);
        if (!item.quantity) name.style.color = COLORS.textDim;

        const held = this._cell(item.quantity ? formatWithSeparator(item.quantity) : '—');
        held.style.color = item.quantity ? COLORS.text : COLORS.textDim;
        // Where they are matters: on the market is "wait", in the bag is "done",
        // and a single number cannot tell you which
        if (item.listed || item.unclaimed) {
            held.style.color = ROW_COLORS.accent;
            const parts = [`${formatWithSeparator(item.held)} in the bag`];
            if (item.listed) parts.push(`${formatWithSeparator(item.listed)} listed for sale`);
            if (item.unclaimed) parts.push(`${formatWithSeparator(item.unclaimed)} unclaimed on the market`);
            held.title = parts.join(', ');
            held.textContent = `${formatWithSeparator(item.quantity)}*`;
        }

        const unit = this._cell(this._unitText(item));
        unit.style.color = item.flag ? ROW_COLORS.bad : COLORS.textDim;
        if (item.flag) unit.title = FLAG_MEANING[item.flag];

        const value = this._cell(`${formatKMB(item.totalAsk)} · ${formatKMB(item.totalBid)}`);
        value.style.color = ROW_COLORS.gold;
        value.title = `${formatWithSeparator(item.totalAsk)} at ask, ${formatWithSeparator(item.totalBid)} at bid.`;

        const remove = document.createElement('button');
        remove.textContent = '✕';
        // Marked, because the header's close button is also an ✕ and "the first
        // button on the panel" is the wrong one
        remove.dataset.removeItem = entryKey(item);
        Object.assign(remove.style, {
            background: 'none',
            border: 'none',
            color: COLORS.textDim,
            cursor: 'pointer',
            padding: '0 2px',
        });
        remove.title = 'Take this off the list';
        remove.addEventListener('click', () => {
            unwatchItem(item.hrid, item.enhancementLevel || 0);
            inventoryBadgeManager.invalidateCache?.();
            this._render();
        });

        line.append(icon, name, held, unit, value, remove);
        return line;
    }

    /**
     * The unit price, saying when the market is not where to sell.
     * @param {Object} item - One priced row
     * @returns {string}
     */
    _unitText(item) {
        const ask = formatKMB(item.ask);
        if (item.flag === 'no-market') return `${ask} · ${formatKMB(item.bid)} vendor`;
        if (item.flag === 'below-vendor') return `${ask} · ⚠ ${formatKMB(item.bid)} vendor`;
        if (item.flag === 'equals-vendor') return `${ask} · ${formatKMB(item.bid)} vend`;

        return `${ask} · ${formatKMB(item.bid)}`;
    }

    /**
     * @param {string} text - Column label
     * @param {string} by - What it sorts on
     * @param {string} [align] - Text alignment
     * @returns {HTMLElement}
     */
    _sortHeader(text, by, align = 'left') {
        const header = document.createElement('span');
        const active = state.sortBy === by;
        header.textContent = active ? `${text} ${state.direction === 'asc' ? '▲' : '▼'}` : text;
        Object.assign(header.style, { cursor: 'pointer', textAlign: align, userSelect: 'none' });
        if (active) header.style.color = COLORS.accent;

        header.addEventListener('click', () => {
            if (state.sortBy === by) state.direction = state.direction === 'asc' ? 'desc' : 'asc';
            else {
                state.sortBy = by;
                // Names read best from A, values from the top
                state.direction = by === 'name' ? 'asc' : 'desc';
            }
            persist();
            this._render();
        });
        return header;
    }

    _card() {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });
        return card;
    }

    _row() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: '22px minmax(0, 1fr) 62px 128px 132px 18px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

/**
 * An item's hrid from the name on its tile, remembered.
 *
 * The lookup walks the whole item map, and the dot asks it once per tile on
 * every inventory render. Names do not change, so asking twice is waste — and at
 * a few hundred tiles against a few thousand items it is the kind of waste that
 * shows up as the inventory tab stuttering.
 */
const hridByName = new Map();

/**
 * @param {string} name - Display name from the tile's `aria-label`
 * @returns {string|null}
 */
function hridForName(name) {
    if (hridByName.has(name)) return hridByName.get(name);

    const hrid = getItemHridFromName(name);
    // Cached only once the item map has loaded, or the first inventory render
    // of a session poisons the cache with nulls that never expire
    if (hrid) hridByName.set(name, hrid);
    return hrid;
}

/** What each flag means, said once rather than at every call site */
const FLAG_MEANING = {
    'below-vendor': 'The market bid is below what the vendor pays. Sell this to the vendor.',
    'equals-vendor': 'The market bid matches the vendor price, so either sale is the same.',
    'no-market': 'No market price — this is what the vendor pays.',
};

export const watchlistPanel = new WatchlistPanel();

/**
 * The dot on tracked items in the inventory grid.
 *
 * The point of a watchlist is knowing what is on it while you are looking at
 * your inventory, not while you are looking at the list — a list you have to
 * open to consult is a list you consult twice and then forget.
 *
 * @param {HTMLElement} itemElem - One inventory tile
 */
function markTrackedItem(itemElem) {
    const existing = itemElem.querySelector(`.${DOT_CLASS}`);

    // Checked per tile rather than by unregistering the provider, because the
    // provider is what walks the grid — with it gone, the dots already drawn
    // would sit there until the game happened to rebuild the tile
    if (!config.getSetting(DOTS_SETTING)) {
        existing?.remove();
        return;
    }

    const name = itemElem.querySelector('svg')?.getAttribute('aria-label');
    const hrid = name && hridForName(name);
    if (!hrid || !isWatched(hrid)) {
        existing?.remove();
        return;
    }
    if (existing) return;

    // The dot is positioned against the tile, and a tile the game left static
    // would push it to whatever ancestor is positioned — usually the whole
    // inventory panel, so every dot lands in the same corner
    if (getComputedStyle(itemElem).position === 'static') itemElem.style.position = 'relative';

    const dot = document.createElement('div');
    dot.className = DOT_CLASS;
    Object.assign(dot.style, {
        position: 'absolute',
        top: '2px',
        left: '2px',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: COLORS.accent,
        boxShadow: `0 0 3px ${COLORS.accent}`,
        pointerEvents: 'none',
        zIndex: '12',
    });
    itemElem.appendChild(dot);
}

/**
 * The Track button in the game's own item menu.
 *
 * Off by default, and deliberately: this adds a button to a menu you open for
 * other reasons, next to Sell. Somebody who never uses the watchlist should not
 * find their item menu rearranged by a feature they did not ask for, and a
 * misclick there is a sale.
 *
 * The switch lives in one place — the setting — and both the settings page and
 * the panel's own checkbox write to it. `onSettingChange` does the rest, so
 * flipping it from either surface attaches or detaches the observer immediately
 * rather than at the next reload.
 */
let detachMenuObserver = null;

/**
 * Put a Track button on one item menu.
 * @param {HTMLElement} actionMenu - The game's `Item_actionMenu` popup
 */
function injectTrackButton(actionMenu) {
    if (actionMenu.querySelector(`.${MENU_BUTTON_CLASS}`)) return;

    const itemName = actionMenu.querySelector('[class*="Item_name"]')?.textContent?.trim();
    const hrid = itemName && hridForName(itemName);
    if (!hrid) return;

    const button = document.createElement('button');
    // The game's own button classes, taken from a button already in this menu,
    // so it does not look like something bolted on
    const sibling = actionMenu.querySelector('button');
    if (sibling) button.className = sibling.className;
    button.classList.add(MENU_BUTTON_CLASS);

    const label = () => {
        button.textContent = isWatched(hrid) ? 'Untrack' : 'Track';
    };
    label();

    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (isWatched(hrid)) unwatchItem(hrid);
        else watchItem(hrid, itemName);

        label();
        inventoryBadgeManager.invalidateCache?.();
        // The panel may be open behind the menu, and a list that does not
        // change when you press Track looks like a button that does nothing
        if (watchlistPanel.panel) watchlistPanel._render();
    });

    actionMenu.appendChild(button);
}

/** Start watching for item menus, if the setting says to */
function applyMenuButtonSetting() {
    const wanted = config.getSetting(MENU_BUTTON_SETTING);

    if (wanted && !detachMenuObserver) {
        detachMenuObserver = domObserver.onClass('WatchlistTrackButton', 'Item_actionMenu', injectTrackButton);
    } else if (!wanted && detachMenuObserver) {
        detachMenuObserver();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
    }
}

/** The unregister functions `onSettingChange` handed back, undone in `cleanup()`. */
let unregisterSettingListeners = [];

export default {
    name: 'Watchlist',
    initialize: () => {
        // getSetting, not isFeatureEnabled: this key is not in the legacy
        // features map, so the registry's own check always passed and the
        // checkbox did nothing
        if (!config.getSetting('watchlist')) return;

        inventoryBadgeManager.registerProvider('watchlist-dot', markTrackedItem, 150);
        applyMenuButtonSetting();
        unregisterSettingListeners = [
            config.onSettingChange(MENU_BUTTON_SETTING, () => {
                applyMenuButtonSetting();
                watchlistPanel._paintToggles();
            }),
            // Turning the dots off has to clear the ones already drawn; turning
            // them on has to redraw without waiting for the grid to change
            config.onSettingChange(DOTS_SETTING, () => {
                if (!config.getSetting(DOTS_SETTING)) {
                    document.querySelectorAll(`.${DOT_CLASS}`).forEach((dot) => dot.remove());
                }
                inventoryBadgeManager.invalidateCache?.();
                watchlistPanel._paintToggles();
            }),
        ];
    },
    cleanup: () => {
        unregisterSettingListeners.forEach((unregister) => unregister());
        unregisterSettingListeners = [];
        inventoryBadgeManager.unregisterProvider('watchlist-dot');
        document.querySelectorAll(`.${DOT_CLASS}`).forEach((dot) => dot.remove());
        detachMenuObserver?.();
        detachMenuObserver = null;
        document.querySelectorAll(`.${MENU_BUTTON_CLASS}`).forEach((button) => button.remove());
        watchlistPanel.hide();
        // `state` is module-scope and outlives a character switch — the overlay
        // panel re-initializes and starts redrawing on its 1s timer before
        // reload() (fired from character_initialized/character_switched) has
        // finished its async read. Left as-is, the watchlist tile shows the
        // outgoing character's tracked items and totals under the incoming
        // character's name until that read lands. Reset here, synchronously,
        // so the tile reads "Nothing watched" for that gap instead — the same
        // shape as treasure-tracker's disable().
        Object.assign(state, emptyState());
        stateOwner = null;
        // And the record with it. This runs inside the awaited
        // `character_switching`, which is the last moment anything can still be
        // filed under the departing character — after it, `characterKey()`
        // names the arriving one, while `reload()` (the only other place the
        // record is reset) does not run until the deferred
        // `character_initialized`. A `persist()` in that gap found a curated
        // record still trusting the departing character's memory and wrote it
        // to the arriving character's key AS-IS, replacing their whole list.
        // Reset here and the same write merges under what is stored instead,
        // so the worst case is an edit lost rather than a list lost.
        record.reset();
        inventoryBadgeManager.invalidateCache?.();
    },
};

/**
 * How many times something the tile counts has landed.
 *
 * The tile is four figures over the whole watched list, and producing them costs
 * a price lookup, a held count and a listing walk per watched item — once a
 * second, for a list that is often a hundred items long. What can move those
 * figures without the list itself being edited is exactly this: what you are
 * holding, what you have listed, and what the market says things are worth.
 */
let feed = 0;

['character_initialized', 'character_switched', 'items_updated', 'action_completed', 'market_listings_updated'].forEach(
    (event) =>
        dataManager.on(event, () => {
            feed++;
        })
);

marketAPI.on(() => {
    feed++;
});

/**
 * What the Watchlist tile would count, without counting it.
 *
 * The watched hrids and the feed counter. Only the hrid of an entry reaches this
 * tile — the sort and the per-entry columns belong to the panel behind it, and
 * the four figures up here are order-blind — so the list of hrids is the whole
 * of the list's contribution.
 *
 * @returns {string}
 */
function watchlistVersion() {
    const entries = state.entries || [];
    if (!entries.length) return 'blank';
    return `${entries.map(entryKey).join(',')}|${feed}`;
}

registerRow({
    key: 'watchlist',
    empty: 'Nothing watched',
    name: 'Watchlist',
    defaultSize: { width: 230, height: 30 },
    version: watchlistVersion,
    render: (container) => {
        const rows = watchlistRows();
        if (!rows.length) return blank(container);

        const totals = watchlistTotals(rows);
        const flagged = rows.filter((item) => item.flag === 'below-vendor').length;

        row(container, [
            { text: 'Watch', color: ROW_COLORS.dim },
            { text: `${totals.held}/${totals.items}`, color: COLORS.accent, bold: true },
            { text: formatKMB(totals.ask), color: ROW_COLORS.gold, push: true },
            // The one thing on this list that is a call to action rather than a
            // figure, so it earns the space when there is any
            flagged ? { text: `⚠ ${flagged}`, color: ROW_COLORS.bad } : null,
        ]);
        container.title =
            `${totals.held} of ${totals.items} tracked items held, worth ${formatWithSeparator(Math.round(totals.ask))} at ask.` +
            (flagged ? `\n${flagged} would sell for more to the vendor than to the market.` : '');
    },
    onOpen: () => watchlistPanel.toggle(),
});
