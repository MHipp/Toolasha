/**
 * Bulk Sell Assistant
 *
 * Sells the whole inventory through the market one item at a time with one
 * game action per click. A Bulk Sell button in the marketplace tab bar (next
 * to Market History) shows/hides the floating control panel.
 * Start builds a queue of tradable inventory items —
 * optionally limited to one Toolasha custom inventory tab (children included);
 * for each item it navigates to its order book, decides between insta-selling
 * (ask supply exceeds bid demand, the front of the ask queue is older than
 * the configured threshold — the queue isn't moving —, the stack is under the
 * minimum listing value, or the ask−bid spread is under the configured
 * percentage) and posting a sell listing, then opens the matching modal with
 * the quantity prefilled.
 * Confirming (or closing) the modal advances to the next item automatically,
 * so after Start every sale is exactly one click — always in the same place.
 *
 * That click can be the game's own confirm button or the Confirm button on the
 * assistant's strip, which presses the game's for you so a long run never moves
 * the cursor. Both are the same sale: the strip's button only causes the press,
 * and the modal closing is still the one thing that advances the walk. So the
 * assistant does press the game's confirm button — but only for a press of
 * yours, only while the open modal is selling exactly the item, enhancement
 * level and quantity this step queued, and only once per step. One click of
 * yours is still one sale; it is no longer the game's button that has to
 * receive it.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import { MARKET_TAX, COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';
import { clampToBand } from '../../utils/market-values.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';
import marketAPI from '../../api/marketplace.js';
import {
    loadConfig as loadTabConfig,
    findTab,
    collectTabItems,
    collectItemsAboveTab,
} from '../inventory/custom-tabs/custom-tabs-data.js';
import marketplaceShortcuts from './marketplace-shortcuts.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createFloatingWidget } from '../../utils/floating-widget.js';
import { formatKMB } from '../../utils/formatters.js';
import { holdKey, collectHeldKeys } from './bulk-sell-holds.js';
import { watchlistEntries } from '../inventory/watchlist.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';

const BUTTON_ID = 'mwi-bulk-sell-btn';
const CHIP_ID = 'mwi-bulk-sell-chip';
const PANEL_POSITION_KEY = 'bulkSellPanelPosition';
/** Whether the strip's full status line is folded out under the row */
const STATUS_EXPANDED_KEY = 'bulkSellStatusExpanded';
/** How wide the status line is held, whatever it currently says */
const STATUS_WIDTH = '340px';
/**
 * Every label the main button carries, so the shared widget can size it to the
 * widest of them once. `⏭ Skip` and `▶ Next` are deliberately different
 * actions and are not going to be shortened into agreeing; the button is made
 * to stop resizing instead.
 */
const MAIN_LABELS = ['▶ Bulk Sell', '⏭ Skip', '▶ Next'];
/** The source that is not a tab: whatever the Watchlist is currently tracking */
const WATCHLIST_SOURCE = 'watchlist';

/**
 * The rules the assistant decides by, editable from its own panel.
 *
 * They live in the settings the decision already reads rather than in a copy,
 * so the panel and the settings page can never disagree. Here because the
 * moment you want to change one of these is the moment you are watching it make
 * the wrong call — not the moment you are reading the settings page.
 */
const TUNABLES = [
    {
        key: 'market_bulkSellMinListingValue',
        fallback: 1500000,
        label: 'Insta-sell stacks under',
        suffix: 'coins',
        title: 'Stacks worth less than this (count × ask) are insta-sold rather than using up a listing slot. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellSupplyRatio',
        fallback: 1,
        label: 'Insta-sell when supply beats demand by',
        suffix: '×',
        title: 'Insta-sell when sell-order supply exceeds buy-order demand times this. 1 = whenever sellers outnumber buyers; 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellQueueDays',
        fallback: 2,
        label: 'Insta-sell when the front ask is older than',
        suffix: 'days',
        title: 'A sell queue whose front listing has waited this long is not moving, so joining it would not sell either. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellMaxSpreadPct',
        fallback: 0,
        label: 'Insta-sell when the spread is under',
        suffix: '%',
        title: 'When the best ask and best bid are within this percentage of each other, a listing earns only a sliver over selling instantly — not worth the slot and the wait. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellMinPatientPremium',
        fallback: 0,
        label: 'Insta-sell when a listing earns under',
        suffix: 'coins',
        title: 'The same idea in coins: what the whole stack would earn by waiting in the queue instead of selling instantly — (ask − bid) × count, after the 5% tax. Under this amount, insta-sell. 0 turns the rule off.',
    },
];
const MS_PER_DAY = 86400000;

/**
 * What the game's confirming button in a sell modal says. Matched only after
 * the class check misses — a wrong button here is a sale of the wrong thing,
 * so the list is the exact labels rather than anything fuzzy.
 */
/**
 * The label on the game's own confirm button inside a sell modal.
 *
 * Read off the game's bundle rather than guessed: its string table defines
 * `sellNow:"Sell Now"`, `postSellOrder:"Post Sell Order"`,
 * `sellListing:"Sell Listing"`, `postSellListing:"Post Sell Listing"` (and the
 * four buy equivalents, which cannot appear here because the modal's header is
 * checked for a sell form first). The two `post…` strings are what the button
 * actually says, and neither was in this list — so the strip's Confirm found no
 * button and refused every time, which is what "the Confirm button isn't
 * working" turned out to be.
 *
 * These are localised. A client running in another language shows a translated
 * label, no entry here matches, and the press refuses with "the modal's own
 * confirm button was not found" — it fails closed and says so, and the game's
 * own button still works. The game exposes no i18next global to translate
 * through, so matching the English strings is the most that can be done from
 * here; `Button_sell` is tried first precisely because a class survives
 * translation.
 */
const CONFIRM_LABELS = [
    'post sell order',
    'post sell listing',
    'sell now',
    'sell listing',
    'sell',
    'post',
    'post listing',
    'list',
    'confirm',
];

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

/**
 * Whether the loadout hold list was looked at at all.
 *
 * With Loadout Snapshot switched off nothing ever fills the snapshot store, so
 * `getAllSnapshots()` reports nothing and the hold list comes back empty — which
 * from the strip is indistinguishable from a character who has no loadouts. The
 * two are different facts and the second one is a comparison that never ran, so
 * the strip is told which it is looking at rather than left to imply the wrong
 * one by saying a count.
 *
 * @returns {boolean} True when the loadout store is one the hold list can read
 */
export function loadoutsChecked() {
    try {
        return config.getSetting('loadoutSnapshot') === true;
    } catch {
        return false;
    }
}

/**
 * Every piece of gear saved into a loadout, as hold keys.
 *
 * A loadout is a claim on an item: you are still using it, just not right now.
 * Selling one is not merely a mistake, it is a mistake you find out about the
 * next time you switch to that loadout and it is not there.
 *
 * Keyed by item and enhancement level, so a +10 in a loadout does not protect
 * the +0 you keep for melting.
 *
 * @returns {Array<string>} Hold keys
 */
export function loadoutHoldKeys() {
    const keys = [];
    if (!loadoutsChecked()) return keys;
    const store = loadoutSnapshot() || bundledLoadoutSnapshot;
    for (const snapshot of store.getAllSnapshots?.() || []) {
        // Both the stored level and the resolved one are protected: a "highest
        // owned" loadout will wear the best copy owned now (the resolved key),
        // but the copy the snapshot was saved with may still be in the bags —
        // and a hold list that guards the wrong one lets the equipped copy sell
        for (const piece of snapshot.equipment || []) {
            if (piece?.itemHrid) keys.push(holdKey(piece.itemHrid, piece.enhancementLevel));
        }
        for (const piece of store.resolveEquipment?.(snapshot) || []) {
            if (piece?.itemHrid) keys.push(holdKey(piece.itemHrid, piece.enhancementLevel));
        }
    }
    return keys;
}

class BulkSellAssistant {
    constructor() {
        this.isInitialized = false;
        this.watcher = null;
        this.chip = null;
        this.state = 'idle'; // idle | preparing | awaiting_confirm | awaiting_next | done
        this.queue = [];
        this.index = 0;
        this.current = null;
        this.decision = null;
        this.statusNote = '';
        this.bookHandler = null;
        this.modalUnregister = null;
        this.bookTimeout = null;
        this.advanceTimeout = null;
        this.modalPoll = null;
        this.selectedTabId = 'all';
        this.panelPosition = null;
        /**
         * Other scripts' claims on inventory: name -> () => iterable of hold
         * keys. Kept deliberately ignorant of why anything is held — stock
         * waiting to be relisted, a crafting reserve, a gift — so nothing about
         * the reason has to live in here.
         */
        this.holdProviders = new Map();
        this.heldCount = 0;
        /** Whether the last queue build could read the loadout store at all */
        this.loadoutsChecked = true;
        /** Enhanced gear the watchlist source declined to sweep up */
        this.enhancedSkipped = 0;
        this._hasTabs = false;
        this._tabPrefLoaded = false;
        this.toggleBtn = null;
        this.panelVisible = false;
        this.rulesOpen = false;
        /**
         * Whether the whole status line is folded out under the row. The strip
         * sits over the game, so one line stays the default; this remembers a
         * choice to see all of it the way the panel's other preferences are
         * remembered.
         */
        this.statusExpanded = false;
        /**
         * The queue step the strip's Confirm was pressed for, so a second press
         * of the same step does nothing. The index is part of it, so advancing
         * re-arms the button without anything having to reset this.
         */
        this._confirmedStep = null;
        /** Why the last Confirm press was refused, shown on the strip */
        this.confirmNote = '';
    }

    /**
     * What was left out of the queue and why.
     *
     * Counted and said rather than silently dropped: an item missing from a sell
     * run with no explanation is indistinguishable from a bug, and one of these
     * reasons — gear that is in a loadout — is the difference between a tidy
     * inventory and a loadout that stops working.
     *
     * @param {Object} [options] - `bare: true` for a sentence of its own
     * @returns {string}
     */
    _skipNote({ bare = false } = {}) {
        const parts = [];
        if (this.heldCount > 0) {
            // "in a loadout" is only one of the reasons when loadouts were among
            // the things looked at
            parts.push(
                this.loadoutsChecked
                    ? `${this.heldCount} held back (in a loadout, or claimed elsewhere)`
                    : `${this.heldCount} held back (claimed elsewhere)`
            );
        }
        // Said even though it is not a count: silence here, and a bare "0 held
        // back", both read as "nothing needed holding" when the truth is that
        // nothing was looked at, and the gear at risk is exactly the gear a
        // loadout is wearing
        if (!this.loadoutsChecked) parts.push('loadouts not checked (Loadout Snapshot is off)');
        if (this.enhancedSkipped > 0) {
            parts.push(`${this.enhancedSkipped} enhanced item${this.enhancedSkipped === 1 ? '' : 's'} skipped`);
        }
        if (!parts.length) return '';
        return bare ? parts.join(' · ') : ` (${parts.join(', ')})`;
    }

    /**
     * What the Watchlist is tracking, as the same key set a tab produces.
     *
     * Plain hrids: the watchlist tracks an item rather than an item at an
     * enhancement level, so every level of a tracked item is in scope — which
     * is what "sell what I am watching" means.
     *
     * @returns {Set<string>} Hrids
     */
    _watchlistItems() {
        try {
            // `hrid`, which is what a watchlist entry calls it. Reading
            // `itemHrid` — what an inventory item calls it — produced a set of
            // undefined, an empty source, and "no tradable items" against a
            // list of seventy.
            return new Set(watchlistEntries().map((entry) => entry.hrid));
        } catch (error) {
            console.error('[BulkSellAssistant] Reading the watchlist failed:', error);
            return new Set();
        }
    }

    /** Character-scoped storage key for the remembered tab selection */
    _tabPrefKey() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `${charId}_bulkSell_lastTab` : null;
    }

    /**
     * Register a claim on inventory, so those items are skipped by the sell
     * queue. The assistant never learns why — a caller supplies keys and takes
     * them away again when the claim ends.
     *
     *     const release = Toolasha.Market.bulkSellAssistant.addHoldProvider(
     *         'my-script',
     *         () => ['/items/cheese', '/items/cheese_sword+3']
     *     );
     *
     * @param {string} name - Identifies the caller, and reports its errors
     * @param {Function} provide - Returns an iterable of hold keys, called
     *   afresh each time a queue is built so it can change between runs
     * @returns {Function} Removes the provider
     */
    addHoldProvider(name, provide) {
        if (typeof provide !== 'function') {
            throw new TypeError('addHoldProvider needs a function returning the keys to hold');
        }
        const id = String(name || 'anonymous');
        this.holdProviders.set(id, provide);
        return () => this.holdProviders.delete(id);
    }

    /**
     * @param {string} name - The name it was registered under
     * @returns {boolean} Whether anything was removed
     */
    removeHoldProvider(name) {
        return this.holdProviders.delete(String(name));
    }

    /** The keys currently claimed, for a caller checking its own work */
    heldKeys() {
        return [...collectHeldKeys(this.holdProviders)];
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_bulkSellAssistant')) return;
        this.isInitialized = true;

        // `isInitialized` is set *before* this read, so a `character_switching`
        // teardown landing inside it never made the switch's re-initialise
        // early-return. The resumed tail instead ran on top of a `cleanup()`
        // that had already dropped the order-book listener, the modal watcher
        // and the body mutation watcher and nulled the fields holding them, and
        // re-stored its own into those same fields — leaving the previous
        // `market_item_order_books_updated` handler and the previous mutation
        // watcher live with no handle left to remove them by. One leaked set
        // per switch: every order book the game pushes is processed N times
        // into the insta-sell / list decision, and a whole-body mutation
        // watcher keeps running the tab-bar scan for a feature that is gone.
        const ticket = captureOwner(this);
        try {
            this.panelPosition = await storage.get(PANEL_POSITION_KEY, 'settings', null);
            this.statusExpanded = Boolean(await storage.get(STATUS_EXPANDED_KEY, 'settings', false));
        } catch (error) {
            console.error('[BulkSellAssistant] Loading panel position failed:', error);
        }
        // Guards the whole resumed tail — the handler, the modal subscription
        // and the mutation watcher below.
        if (!stillOurs(ticket)) return;

        this.bookHandler = (data) => this._onOrderBook(data);
        dataManager.on('market_item_order_books_updated', this.bookHandler);

        this.modalUnregister = domObserver.onClass('BulkSellAssistant', 'Modal_modalContainer', (modal) =>
            this._onModal(modal)
        );

        const ensureUI = () => {
            const tabBar = this._findMarketTabBar();
            if (!tabBar) {
                this._removeButton();
                this._removePanel();
                return;
            }
            this._ensureButton(tabBar);
            if (this.panelVisible) {
                if (this.chip && !document.body.contains(this.chip)) this.chip = null;
                if (!this.chip) this._buildPanel();
            } else {
                this._removePanel();
            }
        };
        this.watcher = createMutationWatcher(document.body, ensureUI, { childList: true, subtree: true });
        ensureUI();
    }

    /**
     * The marketplace top tab bar (Market Listings / My Listings / …), which
     * stays put across every subview — so the button never moves during a run.
     */
    _findMarketTabBar() {
        // The visible bar when the game has left a second, hidden marketplace
        // in the DOM — a button put into a hidden bar is one nobody can click
        let hidden = null;
        for (const tabBar of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            const hasMarketTabs = Array.from(tabBar.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (!hasMarketTabs) continue;
            if (tabBar.getClientRects().length) return tabBar;
            hidden = hidden || tabBar;
        }
        return hidden;
    }

    /**
     * Tab-bar toggle that shows/hides the floating panel. Cloned from a
     * native tab (same approach as the Market History tab) so it looks like
     * part of the game's tab bar.
     */
    _ensureButton(tabBar) {
        if (this.toggleBtn && tabBar.contains(this.toggleBtn)) {
            // The Market History tab is injected by its own feature and can
            // land after us — keep our button on its right
            const historyTab = tabBar.querySelector('[data-mwi-market-history-tab="true"]');
            if (
                historyTab &&
                historyTab.nextElementSibling !== this.toggleBtn &&
                historyTab.compareDocumentPosition(this.toggleBtn) & Node.DOCUMENT_POSITION_PRECEDING
            ) {
                historyTab.after(this.toggleBtn);
            }
            return;
        }
        if (this.toggleBtn) this.toggleBtn.remove();

        const referenceTab = Array.from(tabBar.children).find((btn) => btn.textContent.includes('My Listings'));
        if (!referenceTab) return;

        const button = referenceTab.cloneNode(true);
        button.id = BUTTON_ID;
        button.title =
            'Bulk Sell \u2014 clears the inventory through the market one item at a time.\n\n' +
            'Start builds a queue of everything tradable, then for each item opens its order book, ' +
            'decides between insta-selling and posting a listing, and opens the matching modal with the ' +
            'quantity already filled in. After that every sale is one click, always in the same place: the ' +
            'game\u2019s own confirm button, or the panel\u2019s Confirm, which presses it for you. The ' +
            'panel\u2019s refuses unless the open modal is selling exactly what the current step queued, ' +
            'and works once per item \u2014 one click of yours is still one sale.\n\n' +
            'Works best pointed at a Toolasha inventory tab rather than the whole inventory: put the things ' +
            'you actually want gone in one tab and pick it in the panel, and nothing outside it can be sold ' +
            'by a mis-click. Items you also filed in a tab above the selected one are kept, not sold.\n\n' +
            'Click to show or hide the panel. Hiding it never stops a run.';
        const badge = button.querySelector('[class*="TabsComponent_badge"]');
        // The ⧉ marks it as opening a panel rather than switching the view.
        // Borrowing the game's tab styling made it read as a fifth place to
        // navigate to, and clicking it twice looked broken.
        if (badge) {
            badge.innerHTML = '<div style="text-align: center;"><div>\u29c9 Bulk Sell</div></div>';
        } else {
            button.textContent = '\u29c9 Bulk Sell';
        }
        button.classList.remove('Mui-selected');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._togglePanel();
        });

        const historyTab = tabBar.querySelector('[data-mwi-market-history-tab="true"]');
        const firstCustomTab = Array.from(tabBar.children).find(
            (btn) => btn.getAttribute('data-mwi-custom-tab') === 'true'
        );
        if (historyTab) {
            historyTab.after(button);
        } else if (firstCustomTab) {
            firstCustomTab.before(button);
        } else {
            tabBar.appendChild(button);
        }
        this.toggleBtn = button;
        this._syncButton();
    }

    /** Hiding the panel never stops a run — reopening shows live progress */
    _togglePanel() {
        this.panelVisible = !this.panelVisible;
        if (this.panelVisible) {
            if (!this.chip || !document.body.contains(this.chip)) this._buildPanel();
        } else {
            this._removePanel();
        }
        this._syncButton();
    }

    /**
     * Show whether the panel is up: dimmed when closed, lit when open. An
     * underline alone is two pixels at the bottom edge of a tab that looks like
     * every other tab, which is not a state most people will notice.
     */
    _syncButton() {
        if (!this.toggleBtn) return;
        this.toggleBtn.style.boxShadow = this.panelVisible ? 'inset 0 -2px 0 0 #4a9eff' : '';
        this.toggleBtn.style.opacity = this.panelVisible ? '1' : '0.6';
    }

    _removeButton() {
        if (this.toggleBtn) {
            this.toggleBtn.remove();
            this.toggleBtn = null;
        }
    }

    _removePanel() {
        if (this.chip) {
            this.chip.remove();
            this.chip = null;
        }
    }

    /**
     * Floating control panel, fixed near the top-right so the click targets
     * never move between marketplace subviews or items.
     *
     * The strip itself — drag, position memory, status line, main button, gear
     * and ✕ — is the shared widget shell every guided walk in the script draws;
     * what is built here is only what is particular to selling: the source
     * picker and the Stop button.
     */
    _buildPanel() {
        const widget = createFloatingWidget({
            id: CHIP_ID,
            top: '70px',
            right: '24px',
            zIndex: 9000,
            positionKey: PANEL_POSITION_KEY,
            position: this.panelPosition,
            // The two halves of "the buttons never move": the status line stops
            // setting the strip's width, and the main button stops setting its
            // own. Everything else in the row that comes and goes is kept in
            // the layout below with `visibility` rather than `display`.
            statusWidth: STATUS_WIDTH,
            mainLabels: MAIN_LABELS,
        });
        const chip = widget.element;
        this.panelWidget = widget;

        const tabSel = document.createElement('select');
        tabSel.className = `${CHIP_ID}-tab`;
        tabSel.classList.add('toolasha-select');
        tabSel.title =
            'What to sell. "Watchlist" is whatever the Watchlist is tracking, at every enhancement level. ' +
            'A Toolasha inventory tab sells only the items assigned to it (a parent tab includes its child tabs), ' +
            'and items also assigned to a tab above the selected one are kept rather than sold.';
        tabSel.style.cssText =
            // `display` says whether this character has tabs at all; once it
            // does, the picker keeps its slot in the row and only its
            // `visibility` changes, so hiding it mid-run moves nothing.
            'display:none; visibility:hidden; border:1px solid rgba(74,158,255,0.35); border-radius:5px; ' +
            'background:rgba(20,26,44,0.95); ' +
            'color:#cfd8ea; font-size:12px; padding:2px 4px; max-width:150px; cursor:pointer; font-family:inherit;';
        tabSel.addEventListener('change', () => {
            this.selectedTabId = tabSel.value;
            const prefKey = this._tabPrefKey();
            if (prefKey) storage.set(prefKey, tabSel.value, 'settings');
        });
        tabSel.addEventListener('focus', () => this._populateTabSelect());

        widget.main.addEventListener('click', () => this._onMainClick());

        // Confirms the open sale without the cursor leaving the strip. A plain
        // click listener and nothing else: no key binding, no pointer-down, no
        // repeat — the only thing that can sell is a deliberate press of this.
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = `${CHIP_ID}-confirm`;
        confirmBtn.textContent = '✔ Confirm';
        // Hidden with `visibility`, never `display`: a Confirm that vanishes
        // from the layout takes its width with it and slides the buttons
        // around it sideways, which is the whole complaint.
        confirmBtn.style.cssText =
            'visibility:hidden; border:0; border-radius:5px; background:rgba(76,175,80,0.25); color:#a5d6a7; ' +
            'font-weight:700; font-size:12px; padding:3px 7px; cursor:pointer; font-family:inherit;';
        confirmBtn.addEventListener('click', () => this._onConfirmClick());

        const stopBtn = document.createElement('button');
        stopBtn.className = `${CHIP_ID}-stop`;
        // Spelled out rather than an ✕, now that there is a close button beside
        // it. Two identical glyphs a few pixels apart, one abandoning a run and
        // one only hiding the panel, is a mis-click waiting to happen.
        stopBtn.textContent = 'Stop';
        stopBtn.title = 'Stop bulk selling';
        stopBtn.style.cssText =
            'visibility:hidden; border:0; border-radius:5px; background:rgba(244,67,54,0.25); color:#ff8a80; ' +
            'font-weight:700; font-size:12px; padding:3px 7px; cursor:pointer; font-family:inherit;';
        stopBtn.addEventListener('click', () => this._stop('Stopped'));

        // Closing ends the run. The panel is the only thing showing what is
        // being sold and how far through it is, so leaving a run going behind a
        // closed panel would mean the next confirm click lands on a sale you
        // can no longer see coming. Hiding it from the tab still leaves it
        // running, because that is a different gesture with the panel's
        // progress one click away.
        widget.close.title = 'Close the panel. This also stops a run in progress.';
        widget.close.addEventListener('click', () => {
            if (this.state !== 'idle' && this.state !== 'done') this._stop('Stopped');
            this._togglePanel();
        });

        // The rules it decides by, one click away rather than on the settings
        // page. The moment you want to change one of these is the moment you
        // are watching it make the wrong call.
        widget.gear.title = 'Show the rules this decides by';
        widget.gear.addEventListener('click', () => {
            this.rulesOpen = widget.settingsOpen;
            this._renderRules();
        });

        // The status line is one line by choice — the strip sits over the game
        // — but the line it truncates is the one saying what is about to be
        // sold and for how much. This folds the whole of it out underneath,
        // where it can grow downwards without moving anything in the row.
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = `${CHIP_ID}-more`;
        moreBtn.textContent = '▾';
        moreBtn.style.cssText =
            'border:0; border-radius:5px; background:rgba(255,255,255,0.08); color:#cfd8ea; font-size:11px; ' +
            'line-height:1; padding:3px 5px; cursor:pointer; font-family:inherit;';
        moreBtn.addEventListener('mousedown', (event) => event.stopPropagation());
        moreBtn.addEventListener('click', () => {
            this.statusExpanded = !this.statusExpanded;
            storage.set(STATUS_EXPANDED_KEY, this.statusExpanded, 'settings');
            this._render();
        });

        const detailBox = document.createElement('div');
        detailBox.className = `${CHIP_ID}-detail`;
        // Capped at the status line's own width, so folding it out never makes
        // the strip wider and never moves the buttons sideways
        detailBox.style.cssText =
            `display:none; max-width:${STATUS_WIDTH}; white-space:normal; overflow-wrap:anywhere; ` +
            'font-size:11px; line-height:1.35; color:#cfd8ea; padding-top:2px;';

        widget.extras.append(moreBtn, tabSel);
        widget.row.insertBefore(confirmBtn, widget.main);
        widget.row.insertBefore(stopBtn, widget.gear);
        chip.insertBefore(detailBox, widget.settings);
        widget.settings.classList.add(`${CHIP_ID}-rules`);

        document.body.appendChild(chip);
        this.chip = chip;
        this._render();
        this._renderRules();
        this._populateTabSelect();
    }

    /**
     * The decision rules, as editable fields.
     *
     * Written straight into the settings the decision already reads, so this is
     * the same switch as the settings page rather than a copy of it — there is
     * no third place for the two to disagree in.
     */
    _renderRules() {
        const rules = this.chip?.querySelector(`.${CHIP_ID}-rules`);
        if (!rules) return;

        rules.style.display = this.rulesOpen ? 'flex' : 'none';
        if (!this.rulesOpen) return;

        rules.textContent = '';
        const border = document.createElement('div');
        border.style.cssText = 'border-top:1px solid rgba(74,158,255,0.25); margin-bottom:2px;';
        rules.appendChild(border);

        const note = document.createElement('div');
        note.textContent = 'Any one of these makes it insta-sell instead of listing. 0 turns a rule off.';
        note.style.cssText = 'color:#7d879c; font-size:11px; max-width:340px; white-space:normal;';
        rules.appendChild(note);

        for (const tunable of TUNABLES) {
            const line = document.createElement('label');
            line.style.cssText =
                'display:flex; align-items:center; gap:6px; font-size:11px; color:#cfd8ea; white-space:nowrap;';
            line.title = tunable.title;

            const text = document.createElement('span');
            text.textContent = tunable.label;
            text.style.cssText = 'flex:1;';

            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.value = String(config.getSettingValue(tunable.key, tunable.fallback));
            input.style.cssText =
                'width:90px; border:1px solid rgba(74,158,255,0.35); border-radius:4px; ' +
                'background:rgba(20,26,44,0.95); color:#cfd8ea; font-size:11px; padding:2px 4px; font-family:inherit;';
            // On change rather than on every keystroke: half a typed number is
            // a rule, and one that would be applied the moment it was typed
            input.addEventListener('change', () => {
                const value = Number(input.value);
                if (!Number.isFinite(value) || value < 0) {
                    input.value = String(config.getSettingValue(tunable.key, tunable.fallback));
                    return;
                }
                config.setSetting(tunable.key, value);
            });
            // The chip is dragged by its background; a field you cannot click
            // into is not a field
            input.addEventListener('mousedown', (event) => event.stopPropagation());

            const suffix = document.createElement('span');
            suffix.textContent = tunable.suffix;
            suffix.style.cssText = 'color:#7d879c; width:38px;';

            line.append(text, input, suffix);
            rules.appendChild(line);
        }

        const vendor = document.createElement('label');
        vendor.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:#cfd8ea;';
        vendor.title =
            'When the vendor pays at least what the market would net after tax, open the vendor sale instead. ' +
            'Unenhanced items only.';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = Boolean(config.getSetting('market_bulkSellVendorCheck'));
        box.addEventListener('mousedown', (event) => event.stopPropagation());
        box.addEventListener('change', () => config.setSetting('market_bulkSellVendorCheck', box.checked));
        const vendorText = document.createElement('span');
        vendorText.textContent = 'Vendor when the market is no better';
        vendor.append(box, vendorText);
        rules.appendChild(vendor);
    }

    /**
     * Fill the tab filter with the character's Toolasha inventory tabs.
     * Hidden entirely when no custom tabs exist. Options refresh on focus so
     * tab edits made mid-session show up; the rebuild is skipped when nothing
     * changed to avoid closing an open dropdown.
     */
    async _populateTabSelect() {
        const sel = this.chip?.querySelector(`.${CHIP_ID}-tab`);
        if (!sel) return;
        let tabs = [];
        try {
            if (!this._tabPrefLoaded) {
                this._tabPrefLoaded = true;
                const prefKey = this._tabPrefKey();
                const saved = prefKey ? await storage.get(prefKey, 'settings', null) : null;
                if (saved) this.selectedTabId = saved;
            }
            const tabConfig = await loadTabConfig(dataManager.getCurrentCharacterId());
            tabs = tabConfig.tabs || [];
        } catch (error) {
            console.error('[BulkSellAssistant] Failed to load inventory tab config:', error);
        }

        // The Watchlist is a list of items like a tab is, so it belongs in the
        // same picker rather than as a second control beside it. Offered only
        // when it has something in it — an empty source would build an empty
        // queue and look like a broken button.
        const options = [{ value: 'all', label: 'All items' }];
        if (this._watchlistItems().size) options.push({ value: WATCHLIST_SOURCE, label: 'Watchlist' });
        const walk = (nodes, depth) => {
            for (const node of nodes) {
                options.push({ value: node.id, label: `${'\u00A0\u00A0'.repeat(depth)}${node.name}` });
                if (node.children?.length) walk(node.children, depth + 1);
            }
        };
        walk(tabs, 0);

        this._hasTabs = options.length > 1;
        const signature = JSON.stringify(options);
        if (sel.dataset.signature !== signature) {
            sel.dataset.signature = signature;
            sel.textContent = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                sel.appendChild(o);
            }
        }
        sel.value = options.some((o) => o.value === this.selectedTabId) ? this.selectedTabId : 'all';
        this.selectedTabId = sel.value;
        this._render();
    }

    _render() {
        if (!this.chip) return;
        const status = this.chip.querySelector(`.${CHIP_ID}-status`);
        const tabSel = this.chip.querySelector(`.${CHIP_ID}-tab`);
        const mainBtn = this.chip.querySelector(`.${CHIP_ID}-main`);
        const stopBtn = this.chip.querySelector(`.${CHIP_ID}-stop`);
        const confirmBtn = this.chip.querySelector(`.${CHIP_ID}-confirm`);
        const detailBox = this.chip.querySelector(`.${CHIP_ID}-detail`);
        const moreBtn = this.chip.querySelector(`.${CHIP_ID}-more`);
        const progress = this.queue.length ? `${Math.min(this.index + 1, this.queue.length)}/${this.queue.length}` : '';
        const setMain = (label) => {
            if (this.panelWidget?.setMainLabel) this.panelWidget.setMainLabel(label);
            else mainBtn.textContent = label;
        };
        // One line in the row, the whole of it underneath when it is folded
        // out, and the whole of it on hover either way.
        const say = (line) => {
            status.textContent = line;
            status.title = line;
            if (detailBox) {
                detailBox.textContent = line;
                detailBox.style.display = this.statusExpanded ? '' : 'none';
            }
            if (moreBtn) {
                moreBtn.textContent = this.statusExpanded ? '▴' : '▾';
                moreBtn.title = this.statusExpanded
                    ? 'Fold the full status text away and keep just the one line'
                    : 'Show the whole status line, which the strip cuts off at one line';
                moreBtn.setAttribute('aria-expanded', String(this.statusExpanded));
            }
        };
        // A control that comes and goes keeps its slot in the row, so nothing
        // beside it slides sideways when it does
        const show = (element, visible) => {
            if (element) element.style.visibility = visible ? 'visible' : 'hidden';
        };

        if (this.state === 'idle' || this.state === 'done') {
            say(this.statusNote || 'Sell every tradable inventory item, one confirm per item');
            tabSel.style.display = this._hasTabs ? '' : 'none';
            show(tabSel, this._hasTabs);
            show(confirmBtn, false);
            setMain('▶ Bulk Sell');
            mainBtn.title =
                'Queue every tradable inventory item (or only the selected Toolasha tab), most valuable stack first. Each item opens a prefilled sell modal — oversupplied or slow-queue items insta-sell to the best bid, others list at the ask. Confirming the modal \u2014 in the game or with this panel\u2019s Confirm button \u2014 advances to the next item.';
            show(stopBtn, false);
            return;
        }

        show(tabSel, false);
        show(stopBtn, true);
        // Only offered while a market sell modal of ours is the thing on screen.
        // The vendor path has no modal to check the item and quantity against,
        // so it keeps the game's own "Sell For" button and nothing else.
        if (confirmBtn) {
            const offered = this.state === 'awaiting_confirm' && !this.decision?.vendor;
            show(confirmBtn, offered);
            confirmBtn.disabled = offered ? this._confirmSent() : true;
            confirmBtn.style.opacity = confirmBtn.disabled ? '0.5' : '1';
            confirmBtn.style.cursor = confirmBtn.disabled ? 'default' : 'pointer';
            confirmBtn.title = confirmBtn.disabled
                ? 'Already confirmed — waiting for the game to close the modal'
                : 'Press the sell modal’s own confirm button. Refuses unless the modal is open and ' +
                  'showing exactly the item and quantity this step queued.';
        }
        if (this.state === 'preparing') {
            say(`${progress} · checking ${this.current?.name || ''}${this.statusNote ? ` (${this.statusNote})` : ''}…`);
            setMain('⏭ Skip');
            mainBtn.title = 'Skip this item';
        } else if (this.state === 'awaiting_confirm') {
            const d = this.decision;
            const verb = d?.vendor ? 'Vendor-sell' : d?.insta ? 'Insta-sell' : 'List';
            const confirmHint = this.confirmNote
                ? `can’t confirm: ${this.confirmNote}`
                : this._confirmSent()
                  ? 'confirm sent — waiting for the game'
                  : d?.vendor
                    ? 'click Sell For in the item menu'
                    : 'confirm in the modal, or press Confirm here';
            const shown = d?.insta && d.avgPrice ? d.avgPrice : d?.price || 0;
            const detail = `${progress} · ${verb} ${this.current.count}× ${this.current.name} @ ${d?.insta ? '~' : ''}${formatKMB(shown)} (${d?.reason})`;
            // A refusal leads. It used to be appended after the price and the
            // reason, which is past where the strip truncates — so a Confirm
            // that had refused for a stated reason looked like a dead button.
            say(this.confirmNote ? `${confirmHint} — ${detail}` : `${detail} — ${confirmHint}`);
            setMain('⏭ Skip');
            mainBtn.title = 'Close the modal and skip this item';
        } else if (this.state === 'awaiting_next') {
            say(`${progress} · ${this.current?.name || ''} dealt with — press Next for the next item`);
            setMain('▶ Next');
            mainBtn.title = 'Open the next item. Its own click, so one click never does two game actions.';
        }
    }

    /**
     * What the strip's Confirm was, or would be, pressed for.
     *
     * The index is in the key, so the moment the walk moves on the key changes
     * and the button arms itself again — nothing has to remember to reset it.
     * The item and count are in it too, so a queue rebuilt under the same index
     * is a different step.
     *
     * @returns {string|null} Null when there is no step to confirm
     */
    _stepKey() {
        if (!this.current) return null;
        return `${this.index}:${this.current.itemHrid}:${this.current.enhancementLevel}:${this.current.count}`;
    }

    /** Whether this step's confirm has already been pressed */
    _confirmSent() {
        const key = this._stepKey();
        return key !== null && this._confirmedStep === key;
    }

    /**
     * The item a marketplace modal is about, from its icon.
     * @param {HTMLElement} modal
     * @returns {string|null} Item hrid, or null when the icon can't be read
     */
    _modalItemHrid(modal) {
        // Plain `svg use`, then both attribute spellings: an escaped
        // `[xlink\:href]` in the selector is not portable across parsers
        let href = '';
        for (const use of modal.querySelectorAll('svg use')) {
            href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
            if (href) break;
        }
        const slug = href.match(/#(.+)$/)?.[1];
        return slug ? `/items/${slug}` : null;
    }

    /**
     * The enhancement level the modal is set to.
     *
     * The label is a *sibling* of the field's wrapper in the game's markup, not
     * an ancestor of the input — so `input.closest('div')` sees only the input
     * and the old read matched nothing and returned 0 for every modal. That
     * made the level check vacuous for a +0 step and permanently wrong for an
     * enhanced one: the strip's Confirm refused every enhanced item with "the
     * modal is selling +0, not +3", which is a dead button again.
     *
     * So the ancestor is walked outward a level at a time — the same shape the
     * quantity finder uses — taking the tightest container that names
     * Enhancement Level and not Quantity, which is what keeps it off the
     * quantity field when both share an outer container.
     *
     * @param {HTMLElement} modal
     * @returns {number|null} Null when the modal has no enhancement field at
     *   all, which is what an unenhanceable item's modal looks like
     */
    _modalEnhancementLevel(modal) {
        const inputs = Array.from(modal.querySelectorAll('input'));
        for (let level = 0; level < 4; level++) {
            for (const input of inputs) {
                let parent = input.parentElement;
                for (let step = 0; step < level && parent; step++) parent = parent.parentElement;
                if (!parent) continue;
                const text = parent.textContent || '';
                if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                    return parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10) || 0;
                }
            }
        }
        return null;
    }

    /**
     * The quantity typed into the modal — the same field the run prefilled.
     * @returns {number|null} Null when the field can't be found or read
     */
    _modalQuantity(modal) {
        const input = marketplaceShortcuts.findQuantityInput(modal);
        if (!input) return null;
        // The fields are text since the marketplace update, and the game groups
        // them with separators
        const value = parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10);
        return Number.isFinite(value) ? value : null;
    }

    /**
     * The game's own confirming button inside the sell modal.
     *
     * The variant class first, because that is the game's own marking of "this
     * is the sell action"; the exact labels only as a fallback for a build that
     * renamed it. Anything the script itself injected is excluded — pressing
     * one of our own buttons would be a sale nobody asked for.
     *
     * @param {HTMLElement} modal
     * @returns {HTMLButtonElement|null}
     */
    _findModalConfirmButton(modal) {
        const candidates = Array.from(modal.querySelectorAll('button')).filter((btn) => {
            const cls = String(btn.className || '');
            return !cls.includes('Modal_closeButton') && !cls.includes('mwi-');
        });
        return (
            candidates.find((btn) => String(btn.className || '').includes('Button_sell')) ||
            candidates.find((btn) => CONFIRM_LABELS.includes(btn.textContent.trim().toLowerCase())) ||
            null
        );
    }

    /**
     * The button the strip's Confirm may press, or why it may not.
     *
     * This is the whole safety envelope of confirming from the strip: a
     * mis-timed press, a modal the player opened themselves, or a strip left
     * stale after the queue moved on must all refuse rather than sell. So
     * everything the step queued — the item, its enhancement level, the
     * quantity — has to be what the open modal is actually showing.
     *
     * @returns {{button: HTMLButtonElement}|{why: string}}
     */
    _confirmTarget() {
        if (this.state !== 'awaiting_confirm' || !this.current) return { why: 'there is no sale waiting' };
        if (this.decision?.vendor) return { why: 'this one is a vendor sale' };

        const modal = document.querySelector('[class*="Modal_modalContainer"]');
        if (!modal) return { why: 'the sell modal is not open' };
        const header = modal.querySelector('div[class*="MarketplacePanel_header"]')?.textContent || '';
        if (!header.includes('Sell Now') && !header.includes('Sell Listing')) {
            return { why: 'the open modal is not a sell form' };
        }

        const hrid = this._modalItemHrid(modal);
        if (!hrid) return { why: 'the modal does not say what it is selling' };
        if (hrid !== this.current.itemHrid) {
            const clientData = dataManager.getInitClientData();
            const name = clientData?.itemDetailMap?.[hrid]?.name || hrid.split('/').pop();
            return { why: `the modal is selling ${name}, not ${this.current.name}` };
        }
        const level = this._modalEnhancementLevel(modal);
        const wanted = this.current.enhancementLevel || 0;
        // No field at all is how an unenhanceable item's modal looks, so it
        // means +0 — but only for a step that queued +0. A step that queued an
        // enhanced stack against a modal that will not say its level is a sale
        // whose level nothing has checked, and that is the one this guard is
        // for, so it refuses rather than assuming
        if (level === null) {
            if (wanted !== 0) return { why: 'the modal does not say what enhancement level it is selling' };
        } else if (level !== wanted) {
            return { why: `the modal is selling +${level}, not +${wanted}` };
        }
        const quantity = this._modalQuantity(modal);
        if (quantity === null) return { why: 'the modal quantity cannot be read' };
        if (quantity !== this.current.count) {
            return { why: `the modal says ${quantity}, not the queued ${this.current.count}` };
        }

        const button = this._findModalConfirmButton(modal);
        if (!button) return { why: "the modal's own confirm button was not found" };
        return { button };
    }

    /**
     * Press the game's confirm button for this step.
     *
     * It presses rather than sells: the modal closing is still the only thing
     * that advances the walk, so this route and a press of the game's own
     * button are the same single path. Once per step — the button disables
     * itself and the step key makes a second press a no-op even if it does not.
     */
    _onConfirmClick() {
        if (this._confirmSent()) return;
        const target = this._confirmTarget();
        if (target.why) {
            // Said on the strip rather than swallowed: a button that does
            // nothing and explains nothing is one you press again harder
            this.confirmNote = target.why;
            this._render();
            return;
        }
        this.confirmNote = '';
        this._confirmedStep = this._stepKey();
        this._render();
        target.button.click();
    }

    _onMainClick() {
        if (this.state === 'idle' || this.state === 'done') {
            this._start();
        } else if (this.state === 'awaiting_next') {
            this.index++;
            this.state = 'preparing';
            this._render();
            this._prepareCurrent();
        } else {
            this._skip('skipped');
        }
    }

    async _start() {
        // Resolve the tab filter first: a Toolasha inventory tab stores plain
        // hrids for +0 items and "hrid+level" for enhanced ones
        let tabItems = null;
        let aboveItems = null;
        let watchedHrids = null;
        let tabName = '';
        if (this.selectedTabId === WATCHLIST_SOURCE) {
            watchedHrids = this._watchlistItems();
            tabName = 'Watchlist';
            if (!watchedHrids.size) {
                this.statusNote = 'Nothing on the watchlist';
                this.state = 'idle';
                this._render();
                return;
            }
        } else if (this.selectedTabId && this.selectedTabId !== 'all') {
            try {
                const tabConfig = await loadTabConfig(dataManager.getCurrentCharacterId());
                const found = findTab(tabConfig, this.selectedTabId);
                if (!found) {
                    this.statusNote = 'Selected tab no longer exists';
                    this.state = 'idle';
                    this._render();
                    this._populateTabSelect();
                    return;
                }
                tabItems = collectTabItems(found.tab);
                // Tabs above the selected one act as keep-lists: an item also
                // assigned to any of them is never sold
                aboveItems = collectItemsAboveTab(tabConfig, this.selectedTabId);
                tabName = found.tab.name;
            } catch (error) {
                console.error('[BulkSellAssistant] Failed to load inventory tab config:', error);
                this.statusNote = 'Could not load tab config';
                this.state = 'idle';
                this._render();
                return;
            }
        }

        // The snapshot store fills from storage asynchronously, and until it has,
        // `getAllSnapshots()` reports an empty {} — which is indistinguishable
        // from "this character has no loadouts". Start pressed in that window
        // built a queue with every piece of loadout gear in it, held back
        // nothing, and said "0 held back" while it did. `whenReady` is what the
        // store offers for exactly this, and it is bounded (it declares itself
        // ready at a deadline), so a store that never loads costs a pause, not
        // a stuck button.
        try {
            await (loadoutSnapshot() || bundledLoadoutSnapshot).whenReady?.();
        } catch (error) {
            console.error('[BulkSellAssistant] Waiting for loadout snapshots failed:', error);
        }

        const clientData = dataManager.getInitClientData();
        // Gear saved into a loadout is gear you are still using — just not right
        // now. Through the hold mechanism rather than a filter of its own, so it
        // is counted and reported like every other claim on the inventory.
        const providers = new Map(this.holdProviders);
        providers.set('loadouts', () => loadoutHoldKeys());
        // Recorded per build rather than read at render time, so the strip
        // reports the run it is describing and not the setting as it stands now
        this.loadoutsChecked = loadoutsChecked();
        const heldKeys = collectHeldKeys(providers, (name, error) =>
            console.error(`[BulkSellAssistant] Hold provider "${name}" failed; its items are not held:`, error)
        );
        let held = 0;
        let enhanced = 0;
        const items = (dataManager.characterItems || []).filter((item) => {
            if (item.itemLocationHrid !== '/item_locations/inventory') return false;
            if ((item.count || 0) <= 0) return false;
            if (item.itemHrid === '/items/coin') return false;
            if (!clientData?.itemDetailMap?.[item.itemHrid]?.isTradable) return false;
            const key = holdKey(item.itemHrid, item.enhancementLevel);
            // Held items are counted, not silently dropped: an item vanishing
            // from the sell queue with no explanation is indistinguishable from
            // a bug
            if (heldKeys.has(key)) {
                held++;
                return false;
            }
            if (tabItems) {
                if (!tabItems.has(key)) return false;
                if (aboveItems.has(key)) return false;
            }
            // Matched on the hrid rather than the key: the watchlist tracks an
            // item, not an item at a level, so every level of a tracked item is
            // in scope. A tab is the other way round and keeps its own keys.
            if (watchedHrids) {
                if (!watchedHrids.has(item.itemHrid)) return false;
                // …which is exactly why enhanced gear is left out of it. The
                // list tracks "Gobo Defender"; matching every level of that
                // swept a +10 into the queue at six million coins. A tab names
                // the level it means, so it is trusted to mean it.
                if ((item.enhancementLevel || 0) > 0) {
                    enhanced++;
                    return false;
                }
            }
            return true;
        });
        this.heldCount = held;
        this.enhancedSkipped = enhanced;
        // Most expensive stack first: cached market unit price (ask, else bid) × count
        this.queue = items
            .map((item) => {
                const enhancementLevel = item.enhancementLevel || 0;
                const price = marketAPI.getPrice(item.itemHrid, enhancementLevel);
                return {
                    itemHrid: item.itemHrid,
                    enhancementLevel,
                    count: item.count,
                    name: clientData.itemDetailMap[item.itemHrid]?.name || item.itemHrid.split('/').pop(),
                    stackValue: (price?.ask ?? price?.bid ?? 0) * item.count,
                };
            })
            .sort(
                (a, b) =>
                    b.stackValue - a.stackValue ||
                    a.name.localeCompare(b.name) ||
                    a.enhancementLevel - b.enhancementLevel
            );

        if (!this.queue.length) {
            const why = this._skipNote();
            this.statusNote = tabName
                ? `No tradable items in "${tabName}"${why}`
                : `No tradable items in inventory${why}`;
            this.state = 'idle';
            this._render();
            return;
        }
        this.index = 0;
        // Say so rather than letting the count quietly differ from what is in
        // the inventory
        this.statusNote = this._skipNote({ bare: true });
        this._prepareCurrent();
    }

    _prepareCurrent() {
        this._clearTransient();
        if (this.index >= this.queue.length) {
            this.state = 'done';
            this.statusNote = `Done — ${this.queue.length} items processed`;
            this._render();
            return;
        }
        this.current = this.queue[this.index];
        this.decision = null;
        this.state = 'preparing';
        this._render();

        // Vendor check runs BEFORE any marketplace navigation: the item action
        // menu must be the only thing touching the UI, or the navigation's
        // trailing clicks/re-renders dismiss it right after it opens
        if (this._tryVendorSell()) return;

        navigateToMarketplace(this.current.itemHrid, this.current.enhancementLevel);
        // No order book within the timeout → item isn't marketable right now
        this.bookTimeout = setTimeout(() => this._skip('no market data'), 3000);
    }

    /**
     * Vendor beats the market when its flat price matches or exceeds the
     * cached market price net of the market tax (e.g. ask 100 → 95 net = 95
     * vendor; a bag of cowbells is taxed 18% rather than 5%, so 100 → 82).
     * Cached prices are plenty accurate for this comparison and let the
     * decision happen without navigating the marketplace.
     * @returns {boolean} True when the vendor flow was opened
     */
    _tryVendorSell() {
        if (!config.getSetting('market_bulkSellVendorCheck')) return false;
        if (this.current.enhancementLevel !== 0) return false;
        const vendorPrice = dataManager.getInitClientData()?.itemDetailMap?.[this.current.itemHrid]?.sellPrice || 0;
        if (vendorPrice <= 0) return false;
        const cached = marketAPI.getPrice(this.current.itemHrid, 0);
        const ask = cached?.ask ?? null;
        const bid = cached?.bid ?? null;
        if (ask === null && bid === null) return false;

        // Vendor must beat the market path the decision rules would actually
        // take: below the minimum listing value the insta path is forced, so
        // vendor competes with the bid; otherwise with the ask a listing
        // would target
        const rawMin = Number(config.getSettingValue('market_bulkSellMinListingValue', 1500000));
        const minListingValue = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 1500000;
        const stackValue = this.current.count * (ask ?? bid);
        const wouldInsta = minListingValue > 0 && stackValue < minListingValue;
        const referencePrice = (wouldInsta ? (bid ?? ask) : (ask ?? bid)) || 0;
        if (referencePrice <= 0) return false;
        // Cowbell bags are taxed at 18%, everything else at 5% — a flat 5% here
        // overstated the market side by 13% of the price and sent bags to the
        // market that the vendor actually beat
        const tax = this.current.itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;
        const marketNet = Math.floor(referencePrice * (1 - tax));
        if (vendorPrice < marketNet) return false;
        return this._openVendorSell(vendorPrice, marketNet);
    }

    _onOrderBook(data) {
        if (this.state !== 'preparing' || !this.current) return;
        if (data.marketItemOrderBooks?.itemHrid !== this.current.itemHrid) return;
        clearTimeout(this.bookTimeout);
        this.bookTimeout = null;

        const orderBooks = data.marketItemOrderBooks.orderBooks;
        const book = Array.isArray(orderBooks)
            ? orderBooks[this.current.enhancementLevel]
            : orderBooks?.[String(this.current.enhancementLevel)];
        this._decideAndOpen(book || null);
    }

    /**
     * Decide insta-sell vs listing per the order book, then open the matching
     * game modal (the quantity is prefilled when it appears).
     * Four configurable insta-sell rules (any one triggers, 0 disables it):
     * ask supply exceeds bid demand × the supply ratio, the front ask listing
     * has waited longer than the queue-age limit (queue isn't moving), the
     * stack is worth less than the minimum listing value (not worth a slot),
     * or the ask−bid spread is at most the configured percentage of the ask
     * (a listing's whole edge over insta-selling is the spread, and a sliver
     * of an edge is not worth the slot and the wait).
     */
    _decideAndOpen(book) {
        const asks = book?.asks || [];
        const bids = book?.bids || [];
        if (!asks.length && !bids.length) {
            this._skip('no orders');
            return;
        }

        const remaining = (rows) =>
            rows.reduce(
                (sum, row) => sum + Math.max(0, (row.orderQuantity ?? row.quantity ?? 0) - (row.filledQuantity ?? 0)),
                0
            );
        const askQty = remaining(asks);
        const bidQty = remaining(bids);

        const readNumberSetting = (key, fallback) => {
            const raw = Number(config.getSettingValue(key, fallback));
            return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
        };
        const queueDaysLimit = readNumberSetting('market_bulkSellQueueDays', 2);
        const supplyRatio = readNumberSetting('market_bulkSellSupplyRatio', 1);
        const minListingValue = readNumberSetting('market_bulkSellMinListingValue', 1500000);
        const maxSpreadPct = readNumberSetting('market_bulkSellMaxSpreadPct', 0);
        const minPatientPremium = readNumberSetting('market_bulkSellMinPatientPremium', 0);

        let frontAskDays = 0;
        const created = asks[0]?.createdTimestamp;
        if (created) {
            frontAskDays = Math.max(0, (Date.now() - new Date(created).getTime()) / MS_PER_DAY);
        }

        // The patient side is priced at what a listing could actually reach: a
        // listing outside the game's tradable range is rejected by the server,
        // so an unclamped ask overstates what waiting earns and can wrongly
        // choose listing. The bid stays raw on purpose — insta fills against
        // the real resting bid, wherever it happens to sit.
        const askRaw = asks[0]?.price ?? null;
        const askPrice = clampToBand(askRaw, this.current.itemHrid, this.current.enhancementLevel) ?? 0;
        const bidPrice = bids[0]?.price ?? 0;

        // Value the stack at the (banded) ask — what a listing would target
        const stackValue = this.current.count * (askPrice || bidPrice || 0);
        // The listing's whole edge over insta-selling is the ask−bid spread.
        // With the game's finer price increments that edge is often a sliver,
        // and a sliver is not worth a listing slot plus the queue wait. Stated
        // both ways: as a share of the ask, and as the after-tax coins the
        // whole stack would earn by waiting.
        const spreadPct = askPrice > 0 && bidPrice > 0 ? ((askPrice - bidPrice) / askPrice) * 100 : null;
        const patientTax = this.current.itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;
        const patientPremium =
            askPrice > 0 && bidPrice > 0
                ? Math.max(0, (askPrice - bidPrice) * this.current.count * (1 - patientTax))
                : null;
        const supplyTriggered = supplyRatio > 0 && askQty > bidQty * supplyRatio;
        const ageTriggered = queueDaysLimit > 0 && frontAskDays > queueDaysLimit;
        const valueTriggered = minListingValue > 0 && stackValue < minListingValue;
        const spreadTriggered = maxSpreadPct > 0 && spreadPct !== null && spreadPct <= maxSpreadPct;
        const premiumTriggered = minPatientPremium > 0 && patientPremium !== null && patientPremium < minPatientPremium;
        const insta =
            (supplyTriggered || ageTriggered || valueTriggered || spreadTriggered || premiumTriggered) &&
            bids.length > 0;

        // The top bid's price only holds for the top bid's quantity. An insta
        // sell of the whole stack fills every bid at or above the price the
        // form names, so the price is walked down the book until the depth
        // covers the count — otherwise the modal claims a price the trade
        // cannot get and sells only part of the stack. The fill itself is
        // best-first: each unit sells at the best remaining bid, and only the
        // remainder the better levels could not absorb takes the walked price
        // — so what the run actually earns is the cumulative sum, and that
        // (as a per-unit average) is what the chip reports.
        let instaPrice = bids[0]?.price ?? 0;
        let instaAvg = instaPrice;
        let depthShort = false;
        if (insta) {
            let covered = 0;
            let proceeds = 0;
            for (const row of bids) {
                const available = Math.max(0, (row.orderQuantity ?? row.quantity ?? 0) - (row.filledQuantity ?? 0));
                const taken = Math.min(available, this.current.count - covered);
                covered += taken;
                proceeds += taken * row.price;
                instaPrice = row.price;
                if (covered >= this.current.count) break;
            }
            depthShort = covered < this.current.count;
            instaAvg = covered > 0 ? proceeds / covered : instaPrice;
        }
        const price = insta ? instaPrice : askPrice || bidPrice || 0;

        const ratioLabel = supplyRatio === 1 ? '' : ` ×${supplyRatio}`;
        const reason = insta
            ? supplyTriggered
                ? `supply ${formatKMB(askQty)} > demand ${formatKMB(bidQty)}${ratioLabel}`
                : ageTriggered
                  ? `ask queue ~${frontAskDays.toFixed(1)}d`
                  : valueTriggered
                    ? `stack ${formatKMB(stackValue)} < ${formatKMB(minListingValue)} min`
                    : spreadTriggered
                      ? `spread ${spreadPct.toFixed(1)}% ≤ ${maxSpreadPct}%`
                      : `listing earns ~${formatKMB(Math.round(patientPremium))} < ${formatKMB(minPatientPremium)} premium`
            : 'queue ok';
        const depthNote =
            insta && instaPrice < (bids[0]?.price ?? 0)
                ? `; fills best-first to ${formatKMB(instaPrice)} so the depth covers the stack` +
                  `${depthShort ? ' (book still short)' : ''}`
                : '';
        this.decision = { insta, price, avgPrice: insta ? instaAvg : null, reason: reason + depthNote };

        const open = insta
            ? marketplaceShortcuts.clickInstantActionButton('Sell')
            : marketplaceShortcuts.clickListingButton('+ New Sell Listing', 'Button_sell');
        open.then(() => {
            if (this.state !== 'preparing') return;
            this.state = 'awaiting_confirm';
            this._render();
            this._watchClose();
        }).catch(() => this._skip('sell button not found'));
    }

    /**
     * Vendor path: open the item's inventory action menu, click "All" so the
     * whole stack is entered, and wait for the user's click on the game's
     * "Sell For … Coins" button (the one server action). Falls back to the
     * normal market flow when the inventory tile or menu can't be found.
     * @param {number} vendorPrice - Per-item vendor price
     * @param {number} marketNet - Per-item market price net of the 5% tax
     * @returns {boolean} Whether the vendor flow was opened
     */
    _openVendorSell(vendorPrice, marketNet) {
        const iconName = this.current.itemHrid.split('/').pop();
        const tiles = document.querySelectorAll('[class*="Inventory_items"] [class*="Item_itemContainer"]');
        let tile = null;
        for (const container of tiles) {
            const href = container.querySelector('svg use')?.getAttribute('href') || '';
            if (!href.endsWith(`#${iconName}`)) continue;
            // Vendor path only runs for +0 items — skip enhanced variants
            if (container.querySelector('[class*="Item_enhancementLevel"]')) continue;
            tile = container;
            break;
        }
        // Tile not visible (inventory panel closed / filtered) — let the
        // caller fall back to the normal market flow
        if (!tile) return false;

        (tile.querySelector('[class*="Item_item"]') || tile).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        // Wait for the menu, retrying once — clicking the tile again reopens
        // it if something dismissed the first attempt
        const awaitMenu = (attempt) => {
            if (this.state !== 'preparing') return;
            const menu = document.querySelector('[class*="Item_actionMenu"]');
            if (!menu) {
                if (attempt < 2) {
                    (tile.querySelector('[class*="Item_item"]') || tile).dispatchEvent(
                        new MouseEvent('click', { bubbles: true, cancelable: true })
                    );
                    setTimeout(() => awaitMenu(attempt + 1), 400);
                } else {
                    this._skip('item menu did not open');
                }
                return;
            }
            const allBtn = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent.trim() === 'All');
            allBtn?.click();
            this.decision = {
                insta: false,
                vendor: true,
                price: vendorPrice,
                reason: `vendor ${formatKMB(vendorPrice)} ≥ market net ${formatKMB(marketNet)}`,
            };
            this.state = 'awaiting_confirm';
            this._render();
            this._watchClose('[class*="Item_actionMenu"]');
        };
        setTimeout(() => awaitMenu(1), 350);
        return true;
    }

    /** Prefill the quantity when the sell modal opens during a run */
    _onModal(modal) {
        if (this.state !== 'preparing' && this.state !== 'awaiting_confirm') return;
        if (!this.current) return;
        const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
        const text = header?.textContent || '';
        if (!text.includes('Sell Now') && !text.includes('Sell Listing')) return;

        const count = this.current.count;
        const wantedHrid = this.current.itemHrid;
        setTimeout(() => {
            // Checked here rather than above because the icon is not reliably in
            // the modal the instant the observer sees it. A modal about some
            // other item is one the player opened themselves during the run's
            // wait, and writing this step's quantity and price into it would be
            // the assistant editing a sale nobody asked it to touch. An icon it
            // cannot read is left alone the way it always was.
            const shown = this._modalItemHrid(modal);
            if (shown && shown !== wantedHrid) return;
            // A field the finder cannot positively identify is left alone
            // rather than written to. The alternative was the finder's old
            // positional guess, which in a woken sell modal is the PRICE field —
            // typing a stack count into it is a worse outcome than an unfilled
            // quantity the player types themselves, and the Confirm guard says
            // so at the point it matters
            const input = marketplaceShortcuts.findQuantityInput(modal);
            if (!input) return;
            nativeInputValueSetter.call(input, String(count));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, 120);

        // An insta sell's price must be the depth-walked one, not the game's
        // best-bid default: Sell Now fills every bid at or above the price the
        // form names, and the default only clears the top level's quantity.
        // The rebuilt price control sleeps as a display div until clicked, so
        // wake it first and write on the next beat.
        if (text.includes('Sell Now') && this.decision?.insta && this.decision.price > 0) {
            const price = this.decision.price;
            setTimeout(() => {
                const shown = this._modalItemHrid(modal);
                if (shown && shown !== wantedHrid) return;
                const priceRow = modal.querySelector('div[class*="MarketplacePanel_priceInputs"]');
                if (!priceRow) return;
                if (!priceRow.querySelector('input')) {
                    priceRow.querySelector('div[class*="MarketplacePanel_priceDisplay"]')?.click();
                }
                setTimeout(() => {
                    const priceInput = priceRow.querySelector('input');
                    if (!priceInput) return;
                    nativeInputValueSetter.call(priceInput, String(price));
                    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
                }, 150);
            }, 200);
        }
    }

    /**
     * Advance to the next item when the given element closes — confirmed or
     * dismissed, either way this item is dealt with.
     * @param {string} [selector] - Element whose disappearance means done
     */
    _watchClose(selector = '[class*="Modal_modalContainer"]') {
        // A second call would otherwise strand the first poller: it keeps its own
        // `seen` and keeps firing, and the two together can advance the run's
        // state twice for one closed modal
        if (this.modalPoll) {
            clearInterval(this.modalPoll);
            this.modalPoll = null;
        }
        let seen = false;
        this.modalPoll = setInterval(() => {
            if (this.state !== 'awaiting_confirm') {
                clearInterval(this.modalPoll);
                this.modalPoll = null;
                return;
            }
            const open = !!document.querySelector(selector);
            if (open) {
                seen = true;
            } else if (seen) {
                clearInterval(this.modalPoll);
                this.modalPoll = null;
                // Not straight to the next item: the click that closed this
                // modal has already done its one game action (the sale), and
                // opening the next item's book is another. The run waits for
                // its own Next press, so every server action has a click of
                // its own.
                this.state = 'awaiting_next';
                this._render();
            }
        }, 200);
    }

    _skip(note) {
        this._clearTransient();
        // Close any modal the run opened so it can't linger over the next item
        document.querySelector('[class*="Modal_modalContainer"] [class*="Modal_closeButton"]')?.click();
        // Dismiss an open item action menu (vendor path) the same way the
        // game does — via Escape
        if (document.querySelector('[class*="Item_actionMenu"]')) {
            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    code: 'Escape',
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true,
                })
            );
        }
        this.statusNote = note || '';
        this.index++;
        this.state = 'preparing';
        this._render();
        this.advanceTimeout = setTimeout(() => this._prepareCurrent(), 600);
    }

    _stop(note) {
        this._clearTransient();
        this.state = 'idle';
        this.queue = [];
        this.index = 0;
        this.current = null;
        this.decision = null;
        this.statusNote = note || '';
        this._render();
    }

    _clearTransient() {
        if (this.bookTimeout) {
            clearTimeout(this.bookTimeout);
            this.bookTimeout = null;
        }
        if (this.advanceTimeout) {
            clearTimeout(this.advanceTimeout);
            this.advanceTimeout = null;
        }
        if (this.modalPoll) {
            clearInterval(this.modalPoll);
            this.modalPoll = null;
        }
        this.statusNote = '';
        this.confirmNote = '';
        this._confirmedStep = null;
    }

    cleanup() {
        // First of all, so an `initialize()` parked on the panel-position read
        // cannot resume into the fields this teardown is about to null.
        // `disable()` funnels through here, so both teardown paths are covered.
        noteTeardown(this);
        this._stop('');
        if (this.watcher) {
            this.watcher();
            this.watcher = null;
        }
        if (this.bookHandler) {
            dataManager.off('market_item_order_books_updated', this.bookHandler);
            this.bookHandler = null;
        }
        if (this.modalUnregister) {
            this.modalUnregister();
            this.modalUnregister = null;
        }
        this._removeButton();
        this._removePanel();
        this.panelVisible = false;

        // The remembered tab is this character's, and cleanup() is what a
        // character switch runs — the registry tears the feature down on
        // `character_switching` and initializes it again for the arriving
        // character. Left standing, `_tabPrefLoaded` made `_populateTabSelect`
        // skip its read, so `selectedTabId` went on holding a tab id out of the
        // *departing* character's inventory tab config (which is itself
        // per-character) and the sell queue was filtered by a tab the arriving
        // character does not have.
        this._tabPrefLoaded = false;
        this.selectedTabId = 'all';

        this.isInitialized = false;
    }

    disable() {
        try {
            this.cleanup();
        } catch (error) {
            console.error('[Bulk Sell Assistant] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const bulkSellAssistant = new BulkSellAssistant();
export default bulkSellAssistant;
