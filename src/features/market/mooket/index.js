/**
 * Market History Panel
 *
 * A floating price-history chart and a row of pinned items, over the
 * marketplace.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * The game shows you what an item costs now and nothing about what it cost
 * before, which makes every price impossible to judge: 840,000 is cheap or dear
 * only against what it has been. This draws the ask, the bid, the average
 * transacted price and the volume over a range you pick, from the pooled dataset
 * the mooket project maintains.
 *
 * Reading that dataset means telling a third-party server which items you look
 * up, so the whole feature is off until turned on.
 *
 * What was left behind from the original, deliberately: the second WebSocket
 * hook (Toolasha already has one, and two scripts patching `MessageEvent.data`
 * is how a page ends up silently dropping messages), the bundled item-name
 * dictionaries (Toolasha has the game's own), the `localStorage` cache with its
 * defensive pruning (this uses IndexedDB), and the crosshair plugin (Chart.js's
 * index-mode tooltip covers it without another dependency).
 */

import config from '../../../core/config.js';
import storage from '../../../core/storage.js';
import dataManager from '../../../core/data-manager.js';
import domObserver from '../../../core/dom-observer.js';
import marketAPI from '../../../api/marketplace.js';
import { createCleanupRegistry } from '../../../utils/cleanup-registry.js';
import { formatKMB, formatWithSeparator } from '../../../utils/formatters.js';
import { navigateToMarketplace } from '../../../utils/marketplace-tabs.js';
import { hasCoarsePointer } from '../../../utils/mobile.js';
import marketPriceStore from './market-price-store.js';
import marketHistoryAPI from './market-history-api.js';
import { buildHistorySeries, historyLabels, HISTORY_RANGES } from './market-history-data.js';
import { priceKey } from './market-prices.js';
import {
    addWatched,
    removeWatched,
    moveWatched,
    nextDisplayMode,
    watchedChange,
    describeMove,
    normaliseWatchlist,
    describeUpdateAge,
    isStalePrice,
    setWatchedTarget,
    normaliseTarget,
    describeTarget,
    targetMet,
    noteTargetReached,
    sightingsFromRows,
    targetAftermath,
    describeAftermath,
} from './market-watchlist.js';
import { createCuratedRecord, mergeById } from '../../../utils/persisted-record.js';
import { attachMinimize } from '../../../utils/panel-minimize.js';
import { registerCommand, unregisterCommand } from '../../../utils/command-registry.js';

const PANEL_ID = 'mwi-market-history-panel';
const TAB_ID = 'mwi-market-history-tab';
/** Where the panel is and how it draws — one panel, so one global answer */
const PREFS_KEY = 'mooketPanelPrefs';
/**
 * What this character is watching.
 *
 * Split out of the prefs object, because it is the one field in it that is not
 * about the panel: an iron cow watching its own handful of items had the market
 * character's list of forty pushed onto it every time either of them saved.
 */
const WATCHLIST_BASE = 'mooketWatchlist';
const POLL_MS = 1000;
/** The game's marketplace panel, matched the same way the class watcher matches it */
const MARKETPLACE_SELECTOR = '[class*="MarketplacePanel_marketplacePanel"]';

/**
 * What the tab watcher has to see for the History tab to be put back.
 *
 * `ensureTabButton` only ever cares about the marketplace's own MUI tab strip,
 * so the watcher needs to fire when that strip — or the panel that owns it —
 * is (re)inserted, and never otherwise. `MuiTabs-flexContainer` is the class
 * MUI puts on the `role="tablist"` div itself, which is what `findMarketTabBar`
 * already keys off; `MuiTabs-root` is its wrapper, included so a rebuild that
 * replaces the wrapper without a separately-inserted flexContainer still lands.
 * `MarketplacePanel_marketplacePanel` covers the panel opening as a whole.
 *
 * Registered without a filter this ran for every element inserted anywhere on
 * the page — including all of combat — and each run did a document-wide
 * `querySelectorAll` plus a layout read.
 */
export const TAB_WATCH_CLASSES = ['MuiTabs-flexContainer', 'MuiTabs-root', 'MarketplacePanel_marketplacePanel'];

/**
 * The watched items, per character, through a curated persisted record
 * (`utils/persisted-record.js`): once read back, the list in hand is the list
 * and a removal sticks; before that a save folds the stored list under it by
 * item so nothing is lost. A read that cannot be made keeps the list in hand
 * rather than blanking it, and no write goes out over an unreadable store.
 */
const watchlistRecord = createCuratedRecord({
    base: WATCHLIST_BASE,
    store: 'settings',
    empty: () => [],
    merge: mergeById((entry) => entry?.key),
    label: 'MarketHistory',
});

/**
 * Lift a pre-split watchlist out of the shared prefs object into its own key.
 *
 * Seeding the bare key and letting `readScoped` take it from there hands the
 * adoption rules — the main character claims it, an iron cow starts clean —
 * to one implementation instead of a second copy of them here.
 * @param {Object|null} savedPrefs - The prefs object as read from storage
 * @returns {Promise<void>}
 */
export async function splitLegacyWatchlist(savedPrefs) {
    if (!savedPrefs || savedPrefs.watchlist === undefined) return;

    try {
        const alreadySplit = await storage.get(WATCHLIST_BASE, 'settings', null);
        if (alreadySplit === null) {
            await storage.setJSON(WATCHLIST_BASE, normaliseWatchlist(savedPrefs.watchlist), 'settings', true);
        }
        const remaining = { ...savedPrefs };
        delete remaining.watchlist;
        await storage.setJSON(PREFS_KEY, remaining, 'settings', true);
    } catch (error) {
        console.error('[MarketHistory] Splitting the panel watchlist out failed:', error);
    }
}

/** Series colours, in the order the datasets are built */
const SERIES = [
    { key: 'ask', label: 'Ask', color: '#f56c6c', dash: [] },
    { key: 'bid', label: 'Bid', color: '#67c23a', dash: [5, 5] },
    { key: 'avg', label: 'Avg', color: '#e6a23c', dash: [2, 3] },
];

/**
 * Whether one of the game's own modals is covering the page.
 *
 * The pin overlay sits at z-index 820 while the game's `Modal_modalContainer`
 * is a full-screen fixed layer at **200**, so a house or action panel opened
 * over the marketplace gets a pushpin floating in the middle of it. (The
 * `Z_FLOATING_PANEL` comment claiming game modals are ~1300 is wrong; measured
 * against the live client.)
 *
 * The container is in the document only while such a modal is open — with the
 * marketplace open and nothing on top of it there are none at all, verified
 * live — so its presence is the whole test. The marketplace's own shell is
 * `MainPanel_marketplaceModalContainer`, which this does not match.
 *
 * @param {Document} [doc] - The document to ask; injectable for tests
 * @returns {boolean}
 */
export function gameModalIsOpen(doc = document) {
    return Boolean(doc?.querySelector('[class*="Modal_modalContainer"]'));
}

class MarketHistoryPanel {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.panel = null;
        this.chart = null;
        this.canvas = null;
        /** The strip under the chart that says what happened after a target fired */
        this.aftermathEl = null;
        this.chipRow = null;
        this.overlay = null;
        this.pinButton = null;
        // Starts hidden. A panel that appears over the marketplace the moment
        // you open it is in the way of the thing you opened.
        this.prefs = {
            x: 20,
            y: 120,
            w: 520,
            h: 300,
            days: 7,
            open: false,
            locked: false,
            mode: 'iconPrice',
            /** What the chart last drew, restored on the next open */
            lastItem: null,
        };
        this.tabButton = null;
        this.tabWatcher = null;
        this.tabBar = null; // The marketplace tab bar last found, reused while it stays in the DOM
        this.marketplace = null; // The visible marketplace panel last found, likewise
        /**
         * Every marketplace panel currently in the DOM, kept by the class watcher.
         *
         * The poll used to answer "is the marketplace open" with a whole-document
         * `[class*=]` query every second — paid in full while the marketplace was
         * closed, which is nearly all the time. The game tells us when one appears;
         * an empty set means the poll has nothing to do.
         */
        this.marketplacePanels = new Set();
        this.watchlist = [];
        /** Whose list `watchlist` holds, so a switch never shows another's */
        this.watchlistOwner = null;
        this.current = null; // { itemHrid, enhancementLevel }
        this.shown = null; // what the chart is currently drawing
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_pooledHistory')) return;
        this.isInitialized = true;

        await this.loadPrefs();

        registerCommand({
            name: 'Market History Viewer',
            hint: 'Pooled price history, per item',
            run: () => this.toggle(),
        });

        await marketPriceStore.initialize();
        marketHistoryAPI.connect();

        // The snapshot has no sizes but covers every item, so it fills in
        // everything never opened
        const priceListener = () => marketPriceStore.ingestSnapshot(marketAPI.marketData, Date.now());
        marketAPI.on(priceListener);
        this.cleanupRegistry.registerCleanup(() => marketAPI.off(priceListener));
        priceListener();

        // Contributing is what keeps the pooled dataset alive, and is separately
        // opted into because it sends more than it asks for
        const bookListener = (data) => marketHistoryAPI.report(data);
        dataManager.on('market_item_order_books_updated', bookListener);
        this.cleanupRegistry.registerCleanup(() => dataManager.off('market_item_order_books_updated', bookListener));

        this.cleanupRegistry.registerCleanup(marketPriceStore.onChange(() => this.renderChips()));

        this.buildPanel();
        this.buildOverlay();

        // The tab bar is rebuilt whenever the marketplace re-renders, so the
        // button has to be put back rather than added once. Through the shared
        // observer, debounced and class-filtered: a private observer over the whole body ran the
        // tab-bar search (layout reads included) on every mutation on the page, and an unfiltered
        // shared handler still ran it for every element inserted anywhere, combat included.
        this.tabWatcher = domObserver.onClass('MarketHistoryTab', TAB_WATCH_CLASSES, () => this.ensureTabButton(), {
            debounce: true,
            debounceDelay: 200,
        });
        // The marketplace panel announces itself instead of being hunted for once
        // a second. Seeded with a scan because the panel may already be open when
        // the feature initializes; @run-at document-start the seed scan (and the
        // tab-button catch-up below) waits for the shared observer's actual-ready
        // signal (immediate if it is already attached).
        this.cleanupRegistry.registerCleanup(
            domObserver.onReady('MarketHistoryCatchUp', () => {
                for (const el of document.querySelectorAll(MARKETPLACE_SELECTOR)) this.marketplacePanels.add(el);
                this.ensureTabButton();
            })
        );
        const marketplaceWatcher = domObserver.onClass(
            'MarketHistoryMarketplacePanel',
            ['MarketplacePanel_marketplacePanel'],
            (el) => this.marketplacePanels.add(el)
        );

        this.cleanupRegistry.registerCleanup(() => {
            this.tabWatcher?.();
            this.tabWatcher = null;
            marketplaceWatcher?.();
            this.tabBar = null;
            this.marketplace = null;
            this.marketplacePanels.clear();
        });

        const poll = setInterval(() => this.followMarketplace(), POLL_MS);
        this.cleanupRegistry.registerInterval(poll);
    }

    disable() {
        // Whatever fails in here, the feature must end up disabled: a throw
        // part-way once left `isInitialized` true with the panel already
        // removed, so the next initialize() returned early and every History
        // click after that read `.style` off a null panel until a refresh
        try {
            unregisterCommand('Market History Viewer');
            this.chart?.destroy();
            this.chart = null;
            this.shown = null;
            this.minimizeCtl?.destroy();
            this.minimizeCtl = null;
            this.panel?.remove();
            this.panel = null;
            this.overlay?.remove();
            this.overlay = null;
            this.tabButton?.remove();
            this.tabButton = null;
            marketHistoryAPI.disconnect();
            marketPriceStore.cleanup();
            this.cleanupRegistry.cleanupAll();
        } catch (error) {
            console.error('[MarketHistory] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Read the panel's own settings and this character's watched items.
     *
     * Separate from `initialize` because it is the whole of what a character
     * switch has to redo, and because it is the only part of start-up that can
     * be tested without a canvas.
     * @returns {Promise<void>}
     */
    async loadPrefs() {
        try {
            const saved = await storage.getJSON(PREFS_KEY, 'settings', null);
            if (saved) {
                this.prefs = { ...this.prefs, ...saved };
                delete this.prefs.watchlist;
            }
            // Open on what was last shown instead of a blank chart; a click on
            // any item replaces it as before
            if (!this.current && this.prefs.lastItem?.itemHrid) {
                this.current = { ...this.prefs.lastItem };
            }
            await splitLegacyWatchlist(saved);
            // Another character's list must not survive a switch, whether or
            // not this one's can be read; this one's, when it cannot be read,
            // is left as it is rather than blanked
            const who = dataManager.getCurrentCharacterId?.() || null;
            watchlistRecord.reset();
            if (who !== this.watchlistOwner) {
                this.watchlist = [];
                this.watchlistOwner = who;
            }
            const readable = await watchlistRecord.load();
            if (readable) this.watchlist = normaliseWatchlist(watchlistRecord.get());
        } catch (error) {
            console.error('[MarketHistory] Loading panel preferences failed:', error);
        }
    }

    async savePrefs() {
        try {
            const prefs = { ...this.prefs };
            delete prefs.watchlist;
            await storage.setJSON(PREFS_KEY, prefs, 'settings');
            watchlistRecord.set(this.watchlist);
            await watchlistRecord.save();
        } catch (error) {
            console.error('[MarketHistory] Saving panel preferences failed:', error);
        }
    }

    /**
     * The item name the game itself uses, so nothing here carries its own
     * dictionary of them.
     * @param {string} itemHrid - Item
     * @returns {string}
     */
    itemName(itemHrid) {
        return dataManager.getItemDetails(itemHrid)?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }

    // ---------------------------------------------------------------- panel

    buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position: fixed; left: ${this.prefs.x}px; top: ${this.prefs.y}px;
            width: ${this.prefs.w}px; z-index: 9000; display: none;
            flex-direction: column; background: #282844; border: 1px solid #90a6eb;
            border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.5);
            font-size: 12px; color: #e7e7e7; user-select: none; resize: both; overflow: hidden;
            min-width: 260px; min-height: 60px;
        `;

        // The toolbar is the one region a finger can drag from: the chip row
        // has to keep touch scrolling, and the canvas keeps its own gestures
        const toolbar = this.buildToolbar();
        toolbar.style.touchAction = 'none';
        panel.appendChild(toolbar);

        this.chipRow = document.createElement('div');
        this.chipRow.style.cssText =
            'display:flex; flex-wrap:wrap; gap:2px; padding:2px 4px; max-height:96px; overflow:auto;';
        panel.appendChild(this.chipRow);

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'flex:1; min-height:0; display:block; padding:2px;';
        panel.appendChild(this.canvas);

        // What happened after this item's target fired, when it has fired. Its
        // own strip under the chart rather than a chip tooltip: the reading is
        // computed from the same history rows the chart was just drawn from, so
        // this is the one place in the script where it costs nothing.
        this.aftermathEl = document.createElement('div');
        this.aftermathEl.style.cssText =
            'padding:1px 6px 3px; font-size:11px; color:#9aa4c0; display:none; cursor:help;';
        panel.appendChild(this.aftermathEl);

        this.makeDraggable(panel);
        document.body.appendChild(panel);
        this.panel = panel;

        this.minimizeCtl = attachMinimize({
            panel,
            header: toolbar,
            body: [this.chipRow, this.canvas, this.aftermathEl],
            panelKey: PANEL_ID,
            beforeEl: this.closeButton,
            accent: '#e7e7e7',
        });

        this.applyOpenState();
        this.renderChips();
    }

    /**
     * A tab beside Market Listings that shows and hides the panel.
     *
     * Cloned from one of the game's own tabs so it looks like part of the bar
     * rather than something bolted on, the same way Bulk Sell does it. The
     * marketplace rebuilds the bar on every re-render, so this runs again and
     * puts the tab back rather than assuming it survived.
     */
    ensureTabButton() {
        const tabBar = this.findMarketTabBar();
        if (!tabBar) {
            this.tabButton = null;
            return;
        }
        if (this.tabButton && tabBar.contains(this.tabButton)) {
            // Kept at the end. Every other script inserts its tab relative to an
            // anchor, so one added after this one lands in front of it; moving
            // back only when it is not already last leaves nothing to fight over.
            if (tabBar.lastElementChild !== this.tabButton) tabBar.appendChild(this.tabButton);
            return;
        }

        const reference = [...tabBar.children].find((tab) => tab.textContent.includes('Market Listings'));
        if (!reference) return;

        const tab = reference.cloneNode(true);
        tab.id = TAB_ID;
        tab.title =
            'Show or hide the price history panel. This opens a panel over the page rather than switching to a view.';
        const badge = tab.querySelector('[class*="TabsComponent_badge"]');
        // The ⧉ marks it as opening a panel rather than switching the view.
        // Without it a toggle that borrows the game's tab styling reads as a
        // fifth place to navigate to, and clicking it twice looks broken.
        if (badge) badge.innerHTML = '<div style="text-align:center;"><div>\u29c9 History</div></div>';
        else tab.textContent = '\u29c9 History';

        tab.classList.remove('Mui-selected');
        tab.setAttribute('aria-selected', 'false');
        tab.setAttribute('tabindex', '-1');
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggle();
        });

        tabBar.appendChild(tab);
        this.tabButton = tab;
        this.syncTabButton();
    }

    /** @returns {HTMLElement|null} The marketplace's own tab bar */
    findMarketTabBar() {
        // The one found last time, while it is still in the DOM — saves the
        // layout read below on every call that finds nothing changed
        if (this.tabBar?.isConnected) return this.tabBar;
        this.tabBar = null;

        // The visible one, when there is more than one marketplace in the DOM
        // (see followMarketplace) — a tab put into a hidden bar is a tab nobody
        // can click
        let hidden = null;
        for (const tabBar of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            if (![...tabBar.children].some((tab) => tab.textContent.includes('Market Listings'))) continue;
            if (tabBar.getClientRects().length) {
                this.tabBar = tabBar;
                return tabBar;
            }
            hidden = hidden || tabBar;
        }
        return hidden;
    }

    /**
     * Show whether the panel is up.
     *
     * A dimmed tab when closed and a lit one when open, rather than only an
     * underline: the tab borrows the game's own styling, and a state shown by
     * two pixels at the bottom edge is not a state most people will notice.
     */
    syncTabButton() {
        if (!this.tabButton) return;
        this.tabButton.style.boxShadow = this.prefs.open ? 'inset 0 -2px 0 0 #90a6eb' : '';
        this.tabButton.style.opacity = this.prefs.open ? '1' : '0.6';
    }

    buildToolbar() {
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex; align-items:center; gap:4px; padding:3px 4px; background:rgba(0,0,0,0.25);';

        const button = (text, title, onClick) => {
            const element = document.createElement('button');
            element.textContent = text;
            element.title = title;
            element.style.cssText =
                'background:rgba(255,255,255,0.08); border:1px solid #4a5a8a; color:#e7e7e7; ' +
                'border-radius:3px; cursor:pointer; font-size:12px; line-height:1; padding:3px 6px;';
            element.addEventListener('click', onClick);
            bar.appendChild(element);
            return element;
        };

        this.closeButton = button('\u2715', 'Close the panel. Reopen it from the History tab.', () => {
            this.prefs.open = false;
            this.applyOpenState();
            this.savePrefs();
        });

        button('👁', 'How much to show for each pinned item', () => {
            this.prefs.mode = nextDisplayMode(this.prefs.mode);
            this.renderChips();
            this.savePrefs();
        });

        this.lockButton = button(this.prefs.locked ? '🔒' : '🔓', 'Lock the panel where it is', () => {
            this.prefs.locked = !this.prefs.locked;
            this.lockButton.textContent = this.prefs.locked ? '🔒' : '🔓';
            this.savePrefs();
        });

        const range = document.createElement('select');
        range.classList.add('toolasha-select');
        range.title = 'How far back to chart';
        range.style.cssText =
            'background:#1a1a2e; color:#e7e7e7; border:1px solid #4a5a8a; border-radius:3px; ' +
            'font-size:12px; padding:2px 4px; cursor:pointer;';
        for (const days of HISTORY_RANGES) {
            const option = document.createElement('option');
            option.value = String(days);
            option.textContent = `${days}d`;
            option.selected = days === this.prefs.days;
            range.appendChild(option);
        }
        range.addEventListener('change', () => {
            this.prefs.days = Number(range.value);
            this.savePrefs();
            // Force a redraw of the same item at the new range
            this.shown = null;
            if (this.current) this.showItem(this.current.itemHrid, this.current.enhancementLevel);
        });
        bar.appendChild(range);

        this.title = document.createElement('span');
        this.title.style.cssText = 'flex:1; text-align:right; padding-right:4px; font-weight:600; opacity:0.9;';
        bar.appendChild(this.title);

        return bar;
    }

    /**
     * Show the price history panel, or hide it.
     *
     * The cloned ⧉ History tab did exactly this inline and was the only way
     * in — which meant the panel could only be reached from the marketplace
     * page, and only once the game had drawn its tab bar.
     */
    toggle() {
        this.prefs.open = !this.prefs.open;
        this.applyOpenState();
        this.savePrefs();
    }

    applyOpenState() {
        // A click that arrives while the feature is down (between a disable
        // and its re-initialise) has no panel to show; doing nothing beats
        // throwing out of the tab's click handler
        if (!this.panel) return;
        const open = this.prefs.open;
        this.panel.style.display = open ? 'flex' : 'none';
        this.panel.style.height = `${this.prefs.h}px`;
        this.syncTabButton();
        if (open && this.current) this.showItem(this.current.itemHrid, this.current.enhancementLevel);
    }

    /**
     * Drag by the panel's own background, clamped on screen.
     *
     * A panel dragged off the edge cannot be dragged back, and the only way out
     * would be clearing its stored position by hand.
     *
     * @param {HTMLElement} panel - The panel
     */
    makeDraggable(panel) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen
        panel.addEventListener('pointerdown', (e) => {
            if (this.prefs.locked) return;
            if (e.button !== 0 || e.target.closest('button, select, canvas, input')) return;
            // The browser's own resize handle lives in the bottom-right corner
            const rect = panel.getBoundingClientRect();
            if (e.clientX > rect.right - 16 && e.clientY > rect.bottom - 16) return;
            e.preventDefault();

            const grabX = e.clientX - rect.left;
            const grabY = e.clientY - rect.top;

            const onMove = (move) => {
                const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
                panel.style.left = `${Math.min(Math.max(0, move.clientX - grabX), maxLeft)}px`;
                panel.style.top = `${Math.min(Math.max(0, move.clientY - grabY), maxTop)}px`;
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                const final = panel.getBoundingClientRect();
                this.prefs.x = final.left;
                this.prefs.y = final.top;
                this.prefs.w = panel.offsetWidth;
                this.prefs.h = this.prefs.open ? panel.offsetHeight : this.prefs.h;
                this.savePrefs();
            };

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    // ----------------------------------------------------------------- chips

    renderChips() {
        if (!this.chipRow) return;
        this.chipRow.innerHTML = '';
        if (this.prefs.mode === 'hidden') return;

        for (const entry of this.watchlist) {
            const [itemHrid, level] = entry.key.split(':');
            const price = marketPriceStore.get(itemHrid, Number(level));
            const change = watchedChange(entry, price);

            const stale = isStalePrice(price?.at);
            // The market's own last step, as distinct from the move since the
            // item was pinned that `change` carries. Null whenever that step
            // cannot be dated, or spans too long to still describe one market.
            const move = describeMove(price?.rise, price?.riseSpanMs);
            const target = normaliseTarget(entry.target);
            // Against the panel's own cache, which is what the chip is drawing.
            // The alert answers the same question against a dated pooled
            // sighting instead: the chip is allowed to be approximate about
            // *when*, a notification is not.
            const met = target ? targetMet(target, price) : null;

            const chip = document.createElement('div');
            chip.style.cssText =
                'display:inline-flex; align-items:center; gap:3px; padding:1px 3px; cursor:pointer; ' +
                `border:1px ${stale ? 'dashed #6a6a7a' : 'solid #4a5a8a'}; border-radius:3px; ` +
                `background:rgba(0,0,0,0.2); white-space:nowrap; opacity:${stale ? '0.6' : '1'};`;
            chip.title =
                `${this.itemName(itemHrid)}${Number(level) > 0 ? ` +${level}` : ''}\n` +
                `Ask ${change.ask === null ? '—' : formatWithSeparator(change.ask)} · ` +
                `Bid ${change.bid === null ? '—' : formatWithSeparator(change.bid)}\n` +
                `${describeUpdateAge(price?.at)}${stale ? ' — stale, treat with caution' : ''}\n` +
                (move ? `Moved ${move.text} on the last reading\n` : '') +
                (target ? `Target: ${describeTarget(target)}${met ? ' — reached' : ''}\n` : '') +
                'Click to chart it, right-click to unpin, ◎ to set a price target';

            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('width', '15');
            icon.setAttribute('height', '15');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${this.spriteUrl()}#${itemHrid.split('/').pop()}`);
            icon.appendChild(use);
            chip.appendChild(icon);

            const mode = this.prefs.mode;
            if (mode === 'namePrice' || mode === 'full') {
                const name = document.createElement('span');
                name.textContent = this.itemName(itemHrid) + (Number(level) > 0 ? ` +${level}` : '');
                chip.appendChild(name);
            }
            if (mode !== 'icon' && mode !== 'iconChange') {
                const value = document.createElement('span');
                value.textContent = change.ask === null ? '—' : formatKMB(change.ask);
                value.style.color = this.changeColour(change.askChange);
                chip.appendChild(value);
            }
            if (mode === 'iconChange' || mode === 'iconBoth' || mode === 'full') {
                const delta = document.createElement('span');
                delta.textContent =
                    change.askChange === null
                        ? ''
                        : `${change.askChange >= 0 ? '+' : ''}${change.askChange.toFixed(1)}%`;
                delta.style.color = this.changeColour(change.askChange);
                chip.appendChild(delta);

                // Beside the since-pinned delta, never instead of it: the two
                // answer different questions, and the arrow plus the span is
                // what tells them apart at a glance. Dimmed a little so the
                // baseline the reader chose stays the louder of the two.
                if (move) {
                    const step = document.createElement('span');
                    step.textContent = move.text;
                    step.style.color = this.changeColour(move.percent);
                    step.style.opacity = '0.75';
                    chip.appendChild(step);
                }
            }

            // The target rides on the chip rather than only in the tooltip: a
            // price you asked to be told about is a thing you have decided, and
            // a decision that is invisible until you hover is one you forget
            // you made. Green once reached, so the row answers "did any of them
            // land" without a hover each.
            if (target) {
                const flag = document.createElement('span');
                flag.textContent = mode === 'icon' || mode === 'iconChange' ? '◎' : `◎${formatKMB(target.price)}`;
                flag.style.color = met ? '#67c23a' : '#8fa0c8';
                flag.style.opacity = met ? '1' : '0.8';
                chip.appendChild(flag);
            }

            chip.addEventListener('click', () => {
                navigateToMarketplace(itemHrid, Number(level));
                this.showItem(itemHrid, Number(level));
            });
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.watchlist = removeWatched(this.watchlist, entry.key);
                this.renderChips();
                this.savePrefs();
            });

            // Touch gets sized-up controls: 8px arrows are unhittable with a
            // finger, and right-click-to-remove does not exist there — an
            // explicit × stands in, since a long-press that silently deletes a
            // watch would be worse than one extra glyph of clutter
            const coarse = hasCoarsePointer();

            const arrows = document.createElement('span');
            arrows.style.cssText = coarse
                ? 'display:flex; flex-direction:column; line-height:0.9; font-size:13px; color:#8fa0c8; gap:2px;'
                : 'display:flex; flex-direction:column; line-height:0.7; font-size:8px; color:#8fa0c8;';
            for (const [glyph, direction] of [
                ['▲', -1],
                ['▼', 1],
            ]) {
                const step = document.createElement('span');
                step.textContent = glyph;
                step.style.cursor = 'pointer';
                if (coarse) step.style.padding = '2px 4px';
                step.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.watchlist = moveWatched(this.watchlist, entry.key, direction);
                    this.renderChips();
                    this.savePrefs();
                });
                arrows.appendChild(step);
            }
            chip.appendChild(arrows);

            // Set/change/clear the target. Offered on every display mode,
            // including the icon-only ones: hiding the way to set a target
            // behind a display setting would make the alert unreachable for
            // anyone whose row is arranged tightly, which is most of them.
            const edit = document.createElement('span');
            edit.textContent = '◎';
            edit.title = target
                ? `Target ${describeTarget(target)} — click to change or clear it`
                : 'Set a price target for this item';
            edit.style.cssText = coarse
                ? 'cursor:pointer; padding:2px 6px; font-size:14px; line-height:1; color:#8fa0c8;'
                : 'cursor:pointer; padding:0 2px; font-size:10px; line-height:1; color:#8fa0c8;';
            edit.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editTarget(chip, entry, price);
            });
            chip.appendChild(edit);

            if (coarse) {
                const remove = document.createElement('span');
                remove.textContent = '×';
                remove.title = 'Remove from watchlist';
                remove.style.cssText = 'cursor:pointer; padding:2px 6px; font-size:14px; line-height:1; color:#c88f8f;';
                remove.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.watchlist = removeWatched(this.watchlist, entry.key);
                    this.renderChips();
                    this.savePrefs();
                });
                chip.appendChild(remove);
            }

            this.chipRow.appendChild(chip);
        }
    }

    /**
     * The inline editor for one pin's price target.
     *
     * An input in the chip rather than `window.prompt`, which a userscript
     * context blocks often enough to be unreliable — the same call the layout
     * bar makes for the same reason. It opens seeded with the current price of
     * the side being targeted, so naming a target you are happy with is a click
     * and Enter; typing over the seed is the case where you want something else.
     *
     * The side toggle reseeds from that side, because "under 4.2M ask" and
     * "over 4.2M bid" are different intentions and carrying an ask's number
     * across to the bid would quietly arm the wrong one. An empty value clears
     * the target; Escape leaves it exactly as it was.
     *
     * @param {HTMLElement} chip - The chip the editor belongs to
     * @param {Object} entry - The watchlist entry being targeted
     * @param {Object|null} priceNow - The panel's current reading for it
     */
    editTarget(chip, entry, priceNow) {
        if (chip.querySelector('input')) return;

        const existing = normaliseTarget(entry.target);
        let side = existing?.side || 'ask';
        const seedFor = (which) => {
            if (existing && existing.side === which) return existing.price;
            const value = which === 'bid' ? priceNow?.bid : priceNow?.ask;
            return value > 0 ? Math.round(value) : '';
        };

        const editor = document.createElement('span');
        editor.style.cssText = 'display:inline-flex; align-items:center; gap:2px;';

        const sideButton = document.createElement('span');
        sideButton.style.cssText = 'cursor:pointer; font-size:10px; color:#8fa0c8; padding:0 2px;';

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.style.cssText =
            'width:72px; font-size:10px; padding:0 3px; background:rgba(0,0,0,0.35); color:#e7e7e7; ' +
            'border:1px solid #4a5a8a; border-radius:2px;';

        const paint = () => {
            sideButton.textContent = side === 'bid' ? 'over bid' : 'under ask';
            sideButton.title = 'Swap the side this target watches';
            input.value = String(seedFor(side));
        };
        paint();

        let settled = false;
        const close = () => {
            settled = true;
            editor.remove();
            this.renderChips();
        };
        const commit = () => {
            if (settled) return;
            const raw = input.value.trim();
            // An unreadable value is not a target and not an instruction to
            // clear one either; only an empty box means "stop watching this".
            const price = raw === '' ? null : Number(raw.replace(/[,\s]/g, ''));
            const next = raw === '' || Number.isFinite(price) ? { side, price } : entry.target;
            // The reading at the moment the target was named is what an
            // aftermath is measured against later, so it is recorded with it
            const [hrid, level] = String(entry.key).split(':');
            this.watchlist = setWatchedTarget(this.watchlist, entry.key, next, {
                at: Date.now(),
                price: marketPriceStore.get(hrid, Number(level) || 0),
            });
            close();
            this.savePrefs();
        };

        // Pressing a span while the box has focus takes focus off it, and the
        // blur below commits — which closes the editor before this button's own
        // click handler ever runs, so the swap was unreachable and the press
        // wrote a target on the side the player was trying to change. Refusing
        // mousedown's default keeps the focus where it is; the click then
        // arrives with the editor still open.
        sideButton.addEventListener('mousedown', (e) => e.preventDefault());
        sideButton.addEventListener('click', (e) => {
            e.stopPropagation();
            side = side === 'ask' ? 'bid' : 'ask';
            paint();
            input.focus();
        });
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            // Kept off the game, which listens for keys on the document
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') close();
        });
        input.addEventListener('blur', () => commit());

        editor.appendChild(sideButton);
        editor.appendChild(input);
        chip.appendChild(editor);
        input.focus();
        input.select();
    }

    /**
     * Pin an item and give it a target, for a caller that already costed it.
     *
     * The upgrade advisor's Watch button is the one that matters: the row it
     * sits on has just quoted a price, and "watch this" almost always means
     * "tell me when it costs that". Seeding the target from the row's own
     * figure is what makes the two surfaces agree instead of leaving the reader
     * to retype a number they were already looking at.
     *
     * A target the player set themselves is never overwritten — a seed is a
     * default, not an instruction — and an unpriced row seeds nothing rather
     * than a target of zero.
     *
     * @param {string} itemHrid - Item to pin
     * @param {number} enhancementLevel - Its enhancement level
     * @param {number|null} cost - What the caller costed it at
     * @returns {boolean} Whether anything was pinned or targeted
     */
    seedPriceTarget(itemHrid, enhancementLevel = 0, cost = null) {
        if (!this.isInitialized || !itemHrid) return false;

        // A row that could not be priced has nothing to seed, and pinning it
        // anyway would put an item on the panel that nobody asked to look at —
        // the inventory watchlist is where an untargeted watch belongs
        const target = normaliseTarget({ side: 'ask', price: cost });
        if (!target) return false;

        const key = priceKey(itemHrid, enhancementLevel);
        const price = marketPriceStore.get(itemHrid, enhancementLevel);

        const before = this.watchlist;
        this.watchlist = addWatched(this.watchlist, key, price, target);

        const existing = this.watchlist.find((watched) => watched.key === key);
        if (target && existing && !existing.target) {
            this.watchlist = setWatchedTarget(this.watchlist, key, target);
        }
        // Already pinned, already targeted: nothing to say and nothing to save
        if (this.watchlist === before) return false;

        this.renderChips();
        this.savePrefs();
        return true;
    }

    /** @param {number|null} change - Percentage move */
    changeColour(change) {
        if (change === null || change === 0) return '#e7e7e7';
        return change > 0 ? '#f56c6c' : '#67c23a';
    }

    /** The game's item sprite sheet, whichever build hash it is on today */
    spriteUrl() {
        if (this.sprite) return this.sprite;
        const use = document.querySelector('svg use[href*="items_sprite"]');
        this.sprite = use?.getAttribute('href')?.split('#')[0] || '';
        return this.sprite;
    }

    // ---------------------------------------------------------------- chart

    async showItem(itemHrid, enhancementLevel) {
        this.current = { itemHrid, enhancementLevel };
        // Remembered so the panel reopens on what it was last showing rather
        // than blank; a lazy write, since showItem fires on every item click
        if (this.prefs.lastItem?.itemHrid !== itemHrid || this.prefs.lastItem?.enhancementLevel !== enhancementLevel) {
            this.prefs.lastItem = { itemHrid, enhancementLevel };
            this.savePrefs();
        }
        const key = `${priceKey(itemHrid, enhancementLevel)}:${this.prefs.days}`;
        if (!this.prefs.open || this.shown === key) return;
        this.shown = key;

        const level = Number(enhancementLevel) || 0;
        this.title.textContent = `${this.itemName(itemHrid)}${level > 0 ? ` +${level}` : ''}`;

        const rows = await marketHistoryAPI.fetchHistory(itemHrid, level, this.prefs.days);
        // The item may have changed while the request was in flight
        if (this.shown !== key) return;
        this.drawChart(buildHistorySeries(rows, this.prefs.days));
        this.drawAftermath(priceKey(itemHrid, level), rows);
    }

    /**
     * "When it fired, was that the bottom?" — for the item now charted.
     *
     * Computed here, on the open, from the rows the chart was just built from,
     * rather than on a timer. There is no live question to answer: the aftermath
     * of a reach that happened yesterday does not change between one second and
     * the next, and a timer would spend third-party requests re-deriving a figure
     * nobody is looking at.
     *
     * Silent unless this pin has actually fired. A pin with a target that has
     * never been reached has no aftermath — not an aftermath of zero — and a pin
     * with no target at all has nothing to have an aftermath of.
     *
     * @param {string} key - The charted item's pin key
     * @param {Array<Object>|null} rows - The history rows just fetched
     */
    drawAftermath(key, rows) {
        if (!this.aftermathEl) return;
        try {
            const entry = (this.watchlist || []).find((watched) => watched?.key === key);
            const aftermath = targetAftermath(entry, sightingsFromRows(rows));
            const text = describeAftermath(aftermath);

            this.aftermathEl.textContent = text;
            this.aftermathEl.style.display = text ? 'block' : 'none';
            this.aftermathEl.title = text
                ? 'The pooled price 24 and 72 hours after each time this pin’s target was reached, measured ' +
                  'against the price at the moment it fired and pooled as a median.\n' +
                  'A reach with no sighting near the window says “no follow-up reading” rather than having a ' +
                  'price guessed for it from the readings either side.'
                : '';
        } catch (error) {
            console.error('[MarketHistory] Building the price-target aftermath failed:', error);
            this.aftermathEl.style.display = 'none';
        }
    }

    /** @param {Array<Object>} series - Result of buildHistorySeries */
    drawChart(series) {
        if (!this.canvas || typeof Chart === 'undefined') return;

        // The source decides two things about how its data is drawn: what the
        // third line is called (a real transacted average, or a computed midpoint
        // of the quotes), and whether there is any volume to draw at all.
        const source = marketHistoryAPI.currentSource();

        const labels = historyLabels(series, this.prefs.days);
        const datasets = SERIES.map((spec) => ({
            label: spec.key === 'avg' ? source.avgLabel : spec.label,
            data: series.map((point) => point[spec.key] || null),
            borderColor: spec.color,
            borderDash: spec.dash,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHitRadius: 6,
            spanGaps: true,
            tension: 0,
        }));
        if (source.hasVolume) {
            datasets.push({
                label: 'Volume',
                data: series.map((point) => point.volume),
                borderColor: '#409eff',
                backgroundColor: 'rgba(64, 158, 255, 0.18)',
                borderWidth: 1,
                fill: true,
                yAxisID: 'volume',
                pointRadius: 0,
                pointHitRadius: 6,
                tension: 0,
            });
        }

        if (this.chart) {
            this.chart.data.labels = labels;
            this.chart.data.datasets = datasets;
            this.chart.$series = series;
            // A source switch can turn the volume axis on or off between draws
            this.chart.options.scales.volume.display = source.hasVolume;
            this.chart.update('none');
            return;
        }

        const axis = { color: '#9aa4c0', font: { size: 10 } };
        this.chart = new Chart(this.canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { ...axis, maxTicksLimit: 8 } },
                    y: {
                        position: 'left',
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: { ...axis, callback: (value) => formatKMB(value) },
                    },
                    volume: {
                        position: 'right',
                        display: source.hasVolume,
                        grid: { drawOnChartArea: false },
                        ticks: { ...axis, color: '#409eff', callback: (value) => formatKMB(value) },
                    },
                },
                plugins: {
                    legend: { labels: { color: '#c8cee0', boxWidth: 10, font: { size: 10 } } },
                    tooltip: {
                        callbacks: {
                            label: (item) => `${item.dataset.label}: ${formatWithSeparator(Math.round(item.parsed.y))}`,
                            // The split is an estimate from where the traded
                            // price sat in the spread, and says so. A source with
                            // no volume has nothing to split, so it says nothing.
                            footer: (items) => {
                                if (!marketHistoryAPI.currentSource().hasVolume) return '';
                                const point = this.chart?.$series?.[items[0].dataIndex];
                                if (!point) return '';
                                return (
                                    `Est. bought at the ask: ${formatWithSeparator(point.atAsk)}\n` +
                                    `Est. sold into the bid: ${formatWithSeparator(point.atBid)}`
                                );
                            },
                        },
                    },
                },
            },
        });
        this.chart.$series = series;
    }

    // -------------------------------------------------------------- overlay

    buildOverlay() {
        // Parked on the body rather than inside the game's own tree: React owns
        // that tree and discards anything it did not put there
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; z-index:820;';

        this.pinButton = document.createElement('button');
        this.pinButton.textContent = '📌';
        this.pinButton.title = 'Pin this item to the price panel';
        this.pinButton.style.cssText =
            'position:absolute; display:none; pointer-events:auto; background:none; border:none; ' +
            'font-size:16px; line-height:1; padding:0; cursor:pointer;';
        this.pinButton.addEventListener('click', () => {
            if (!this.current) return;
            const key = priceKey(this.current.itemHrid, this.current.enhancementLevel);
            const price = marketPriceStore.get(this.current.itemHrid, this.current.enhancementLevel);
            this.watchlist = addWatched(this.watchlist, key, price);
            this.renderChips();
            this.savePrefs();
        });
        overlay.appendChild(this.pinButton);

        document.body.appendChild(overlay);
        this.overlay = overlay;
    }

    /**
     * Follow whichever item the marketplace is showing.
     *
     * Polled rather than observed: the panel only has to keep up with a person
     * clicking, and a MutationObserver over the marketplace fires on every price
     * tick for the sake of the handful that change the item.
     */
    followMarketplace() {
        if (document.hidden || !this.panel) return;

        const marketplace = this._visibleMarketplace();
        this.marketplace = marketplace;

        // Off the marketplace there is no item to chart and nowhere to put the
        // pin, so the panel goes with it — but coming back does not reopen a
        // panel that was closed on purpose
        const wantPanel = marketplace && this.prefs.open ? 'flex' : 'none';
        if (!marketplace) {
            this._setDisplay(this.panel, wantPanel);
            this._setDisplay(this.pinButton, 'none');
            return;
        }

        // The pin is anchored to the marketplace's item icon, and a game modal
        // covers that icon while drawing *under* the pin
        if (gameModalIsOpen()) {
            this._setDisplay(this.panel, wantPanel);
            this._setDisplay(this.pinButton, 'none');
            return;
        }

        const currentItem = marketplace.querySelector('[class*="MarketplacePanel_currentItem"]');
        const use = currentItem?.querySelector('svg use');
        const iconName = use?.href?.baseVal?.split('#')[1];
        if (!currentItem || !iconName) {
            this._setDisplay(this.panel, wantPanel);
            this._setDisplay(this.pinButton, 'none');
            return;
        }

        const badge = currentItem.querySelector('[class*="Item_enhancementLevel"]');
        const level = Number(badge?.textContent?.replace('+', '')) || 0;
        const itemHrid = `/items/${iconName}`;

        // Every measurement first, then every write. Reading a rect after writing
        // a style forces the browser to lay the page out again mid-tick, once a
        // second, for a position that has almost never moved.
        const iconRect = currentItem.querySelector('svg')?.getBoundingClientRect();
        // A tab with no item open (My Listings, History) keeps the last
        // currentItem node in the DOM but hidden — its rect is 0×0, and
        // anchoring to it parked the pin in the page's top-left corner
        if (!iconRect || !(iconRect.width > 0 && iconRect.height > 0)) {
            this._setDisplay(this.panel, wantPanel);
            this._setDisplay(this.pinButton, 'none');
            return;
        }
        const left = `${iconRect.right + window.scrollX + 6}px`;
        const top = `${iconRect.top + window.scrollY - 2}px`;

        this._setDisplay(this.panel, wantPanel);
        if (this.pinButton.style.left !== left) this.pinButton.style.left = left;
        if (this.pinButton.style.top !== top) this.pinButton.style.top = top;
        this._setDisplay(this.pinButton, 'block');

        if (this.current?.itemHrid !== itemHrid || this.current?.enhancementLevel !== level) {
            this.showItem(itemHrid, level);
        }
    }

    /**
     * Write `display` only when it would change it.
     * @param {HTMLElement} el - The element
     * @param {string} value - The wanted display
     */
    _setDisplay(el, value) {
        if (el && el.style.display !== value) el.style.display = value;
    }

    /**
     * The marketplace panel that is actually on screen, if any.
     *
     * The game can leave a second, hidden marketplace panel in the DOM after some
     * navigations; taking the first match then saw "not visible" and this poll hid
     * the panel half a second after every click on the History tab — the tab
     * "stopped working" until a refresh cleared the stray panel. So every panel the
     * class watcher has seen is considered, and the one with a box wins.
     *
     * The one found last time is checked first, so a tick that finds nothing
     * changed is a single layout read; a closed marketplace is no reads at all.
     *
     * @returns {HTMLElement|null} The visible panel
     */
    _visibleMarketplace() {
        if (this.marketplace?.isConnected && this.marketplace.getClientRects().length) return this.marketplace;

        let found = null;
        for (const el of this.marketplacePanels) {
            if (!el.isConnected) {
                this.marketplacePanels.delete(el);
                continue;
            }
            if (!found && el.getClientRects().length) found = el;
        }
        return found;
    }
}

const marketHistoryPanel = new MarketHistoryPanel();

/**
 * Every pinned item, in the one shape the price-target alert cares about.
 *
 * Exported as a function over the singleton rather than as the list itself, so
 * the alert reads what is pinned *now* — the list is replaced wholesale on
 * every edit and on every character switch, and a captured reference would go
 * on watching a list nobody is looking at.
 *
 * The pins live behind this panel's own switch, so a panel that never
 * initialized has nothing pinned and the alert has nothing to say. That is the
 * intended shape rather than a gap: the alert's evidence comes from the same
 * pooled dataset the panel exists to read.
 *
 * @returns {Array<{key: string, itemHrid: string, enhancementLevel: number, name: string,
 *   target: {side: 'ask'|'bid', price: number}|null}>}
 */
export function watchedPriceTargets() {
    return (marketHistoryPanel.watchlist || []).map((entry) => {
        const [itemHrid, level] = String(entry.key).split(':');
        const enhancementLevel = Number(level) || 0;
        const baseName = marketHistoryPanel.itemName(itemHrid);
        return {
            key: entry.key,
            itemHrid,
            enhancementLevel,
            name: enhancementLevel > 0 ? `${baseName} +${enhancementLevel}` : baseName,
            target: normaliseTarget(entry.target),
        };
    });
}

/**
 * Record that a pin's target was reached, and persist it.
 *
 * Called by the price-target alert, which is the one place in the script that
 * knows a target fired against a *dated* pooled sighting. The panel's own chips
 * also light up when a target is met, against the panel's cached price — and
 * that reading is deliberately not recorded, because the aftermath is measured
 * forward from the moment of the reach and a moment that is only approximately
 * known produces a reading that is only approximately about anything.
 *
 * Exported as a function over the singleton for the same reason
 * `watchedPriceTargets` is: the list is replaced wholesale on every edit and on
 * every character switch, so a captured reference would write into a list
 * nobody is looking at.
 *
 * @param {string} key - itemHrid:enhancementLevel
 * @param {Object} sighting - `{at, price}` — when the target was seen reached, and the reading
 * @returns {boolean} Whether anything was recorded
 */
export function noteWatchedTargetReached(key, sighting) {
    try {
        const before = marketHistoryPanel.watchlist || [];
        const after = noteTargetReached(before, key, sighting);
        if (after === before) return false;

        marketHistoryPanel.watchlist = after;
        marketHistoryPanel.savePrefs();
        marketHistoryPanel.renderChips();
        return true;
    } catch (error) {
        console.error('[MarketHistory] Recording a reached price target failed:', error);
        return false;
    }
}

export default marketHistoryPanel;
