/**
 * Custom Inventory Tabs — UI Module
 * Injects a "Toolasha" tab into the character panel tab bar. When active,
 * uses CSS `display: contents` + `order` to visually reorganize game tiles
 * into accordion sections without moving them out of their React-managed container.
 *
 * Key insight: physically moving React-owned tiles destroys them permanently.
 * Instead we flatten the DOM hierarchy with `display: contents` on wrapper divs,
 * inject accordion headers directly into Inventory_items, and use CSS `order`
 * to visually group tiles under headers. Tiles never leave Inventory_items.
 */

import config from '../../../core/config.js';
import domObserver from '../../../core/dom-observer.js';
import dataManager from '../../../core/data-manager.js';
import inventorySort from '../inventory-sort.js';
import inventoryBadgeManager from '../inventory-badge-manager.js';
// Lazy accessor: in production multi-bundle builds, the Market bundle can't statically import
// from Combat (it loads first). Resolve at runtime through the bundle bridge, with a fallback
// to the static import for dev single-bundle builds.
import loadoutSnapshotLocal from '../../combat/loadout-snapshot.js';
import { loadoutSnapshot } from '../../../utils/bundle-bridge.js';
import { itemHridFromIcon } from '../../../utils/item-icon.js';
function getLoadoutSnapshot() {
    return loadoutSnapshot() || loadoutSnapshotLocal;
}
import { formatKMB } from '../../../utils/formatters.js';
import { PANEL_Z_CAP } from '../../../utils/panel-z-index.js';
import { captureOwner, stillOurs, noteTeardown } from '../../../utils/init-ownership.js';
import {
    loadConfig,
    saveConfig,
    addTab,
    removeTab,
    renameTab,
    setTabColor,
    moveTab,
    addItem,
    moveItem,
    addLineBreak,
    removeItem,
    removeItemAtIndex,
    reorderItem,
    setTabOpen,
    setAllTabsOpen,
    findTab,
    getAssignedItemSet,
    addLoadoutBinding,
    removeItemFromBindings,
    syncLoadoutBinding,
    cleanOrphanedBindings,
    getBaseHrid,
    sanitizeImportedConfig,
    tombstoneItem,
    clearItemTombstone,
    LINEBREAK_HRID,
} from './custom-tabs-data.js';

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const PANEL_CSS = `
/* ---------- Toolasha-active mode on Inventory_items ---------- */
/* When our tab is active, Inventory_items becomes a flex container.
   Category wrappers and grids get display:contents so tiles become
   direct flex children and can be reordered with CSS order. */
.toolasha-ct-active {
    display: flex !important;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0;
    padding-top: 0 !important;
}
/* Flatten game category wrappers so tiles become direct flex children.
   Exclude our own injected elements (they have class starting with toolasha-). */
.toolasha-ct-active > *:not([class*="toolasha-"]) {
    display: contents;
}
.toolasha-ct-active [class*="Inventory_itemGrid"] {
    display: contents;
}

/* Hide game category labels and buttons exposed by display:contents */
.toolasha-ct-active [class*="Inventory_label"],
.toolasha-ct-active [class*="Inventory_categoryButton"] {
    display: none !important;
}

/* When active, hide ALL tiles by default — _applyLayout selectively shows them.
   This prevents flash of unstyled tiles when React re-renders new elements. */
.toolasha-ct-active [class*="Item_itemContainer"] {
    display: none !important;
}
/* Tiles we explicitly want visible get this class */
.toolasha-ct-active [class*="Item_itemContainer"].toolasha-ct-visible {
    display: flex !important;
}

/* ---------- Top bar (injected into Inventory_items, Toolasha tab only) ---------- */
.toolasha-ct-topbar {
    display: flex;
    align-items: center;
    padding: 2px 0 4px;
    flex-basis: 100%;
    flex-shrink: 0;
    box-sizing: border-box;
    gap: 4px;
}
.toolasha-ct-add-btn {
    background: #444;
    color: #aaa;
    border: none;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 12px;
}
.toolasha-ct-add-btn:hover { background: #555; }

/* ---------- Accordion header (injected into Inventory_items) ---------- */
.toolasha-ct-section-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px 2px calc(10px + var(--depth, 0) * 20px);
    cursor: pointer;
    user-select: none;
    flex-basis: 100%;
    flex-shrink: 0;
    box-sizing: border-box;
    border-bottom: 1px solid #2a2a2a;
    color: #d4d4d4;
    font-family: inherit;
    font-size: 12px;
}
.toolasha-ct-section-header:hover { background: rgba(255,255,255,0.04); }
.toolasha-ct-chevron {
    width: 14px;
    text-align: center;
    font-size: 10px;
    color: #888;
    flex-shrink: 0;
}
.toolasha-ct-section-name {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
    color: #e0e0e0;
    pointer-events: none;
}
.toolasha-ct-section-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    z-index: 1;
}
.toolasha-ct-section-count {
    font-size: 11px;
    color: #666;
}
.toolasha-ct-section-value {
    font-size: 11px;
    color: #aaa;
}
.toolasha-ct-section-actions {
    display: none;
    gap: 2px;
    flex-shrink: 0;
}
.toolasha-ct-section-header:hover .toolasha-ct-section-actions { display: flex; }
/* No hover on a touchscreen — actions hidden behind it would not exist there */
@media (pointer: coarse) {
    .toolasha-ct-section-actions { display: flex; }
}
.toolasha-ct-node-btn {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    line-height: 1;
}
.toolasha-ct-node-btn:hover { color: #ddd; }

/* ---------- Unorganized bucket header ---------- */
.toolasha-ct-unorg-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 4px;
    margin-top: 4px;
    border-top: 1px solid #333;
    cursor: pointer;
    color: #888;
    font-size: 12px;
    flex-basis: 100%;
    flex-shrink: 0;
    box-sizing: border-box;
}
.toolasha-ct-unorg-header:hover { color: #aaa; }

.toolasha-ct-empty {
    color: #666;
    font-style: italic;
    padding: 12px 10px;
    text-align: center;
    font-size: 12px;
    flex-basis: 100%;
}

/* Drag indicator */
.toolasha-ct-section-header.toolasha-ct-section--drag-over {
    border-top: 2px solid #4a9eff;
}

/* Line break injected between tiles to force a flex row wrap */
.toolasha-ct-linebreak {
    flex-basis: 100%;
    width: 100%;
    height: 0;
    flex-shrink: 0;
}

/* ---------- Editor modal ---------- */
.toolasha-ct-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: ${PANEL_Z_CAP + 1};
    display: flex;
    align-items: center;
    justify-content: center;
}
.toolasha-ct-modal {
    background: #1a1a2e;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 16px;
    width: min(380px, 92vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #d4d4d4;
}
.toolasha-ct-modal-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}
.toolasha-ct-modal * { box-sizing: border-box; }
.toolasha-ct-modal h3 {
    margin: 0 0 12px;
    font-size: 15px;
    color: #e0e0e0;
}
.toolasha-ct-modal label {
    display: block;
    font-size: 12px;
    color: #aaa;
    margin-bottom: 4px;
}
.toolasha-ct-modal input[type="text"],
.toolasha-ct-modal input[type="search"] {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #111;
    color: #ddd;
    font-size: 13px;
    margin-bottom: 8px;
}
.toolasha-ct-swatches {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 12px;
}
.toolasha-ct-swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
}
.toolasha-ct-swatch--active { border-color: #fff; }
.toolasha-ct-swatch-divider {
    width: 1px;
    height: 18px;
    background: #555;
    margin: 0 2px;
}
.toolasha-ct-color-picker {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    appearance: none;
    -webkit-appearance: none;
    background: none;
    overflow: hidden;
}
.toolasha-ct-color-picker--active { border-color: #fff; }
.toolasha-ct-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
.toolasha-ct-color-picker::-webkit-color-swatch { border: none; border-radius: 50%; }
.toolasha-ct-color-picker::-moz-color-swatch { border: none; border-radius: 50%; }
.toolasha-ct-modal input.toolasha-ct-hex-input {
    width: 72px;
    height: 22px;
    box-sizing: border-box;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #eee;
    font-size: 11px;
    padding: 0 5px;
    font-family: monospace;
    margin: 0;
}
.toolasha-ct-search-results {
    max-height: 160px;
    overflow-y: auto;
    margin-bottom: 8px;
}
.toolasha-ct-search-result {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 3px;
}
.toolasha-ct-search-result:hover { background: rgba(255,255,255,0.08); }
.toolasha-ct-search-result svg {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
}
.toolasha-ct-search-group-header { font-weight: 500; }
.toolasha-ct-search-level-row { padding-left: 32px; }
.toolasha-ct-level-badges {
    color: #888;
    font-size: 11px;
    margin-left: 4px;
    flex-shrink: 0;
}
.toolasha-ct-expand-btn {
    margin-left: auto;
    color: #666;
    font-size: 11px;
    flex-shrink: 0;
    padding: 0 2px;
}
.toolasha-ct-assigned-list {
    margin-top: 8px;
}
.toolasha-ct-assigned-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: 3px;
}
.toolasha-ct-assigned-item:hover { background: rgba(255,255,255,0.05); }
.toolasha-ct-assigned-item.toolasha-ct-drag-over { background: rgba(255,255,255,0.12); outline: 1px dashed #888; }
.toolasha-ct-assigned-item svg {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
}
.toolasha-ct-assigned-item .toolasha-ct-node-btn {
    margin-left: auto;
}
.toolasha-ct-drag-handle {
    cursor: grab;
    color: #555;
    font-size: 14px;
    flex-shrink: 0;
    user-select: none;
    padding: 0 2px;
}
.toolasha-ct-drag-handle:active { cursor: grabbing; }
.toolasha-ct-modal-footer {
    display: flex;
    justify-content: space-between;
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #333;
}
.toolasha-ct-delete-btn {
    background: #5a1a1a;
    color: #faa;
    border: 1px solid #8a2a2a;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
}
.toolasha-ct-delete-btn:hover { background: #7a2a2a; }
.toolasha-ct-close-btn {
    background: #333;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
}
.toolasha-ct-close-btn:hover { background: #444; }
.toolasha-ct-clear-btn {
    background: #3a2a0a;
    color: #f0b040;
    border: 1px solid #6a4a10;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
}
.toolasha-ct-clear-btn:hover { background: #5a3a10; }

/* ---------- Category buttons ---------- */
.toolasha-ct-addall-label {
    margin-left: 6px;
    color: #aaa;
    cursor: pointer;
}
.toolasha-ct-categories {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
}
.toolasha-ct-cat-btn {
    background: #1e2a3a;
    color: #8ab4f0;
    border: 1px solid #2a4060;
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
}
.toolasha-ct-cat-btn:hover { background: #2a4060; }
.toolasha-ct-cat-btn--added {
    background: #1a3a2a;
    color: #6c6;
    border-color: #2a5a3a;
    cursor: pointer;
}
.toolasha-ct-cat-btn--added:hover { background: #2a5a3a; }

/* ---------- Category filter ---------- */
.toolasha-ct-search-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
}
.toolasha-ct-search-row input[type="search"] {
    flex: 1;
    margin-bottom: 0;
}
.toolasha-ct-cat-filter {
    padding: 4px 6px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #111;
    color: #ddd;
    font-size: 12px;
    min-width: 100px;
}

/* ---------- Tile drag & drop ---------- */
.toolasha-ct-tile-dragging { opacity: 0.4; }
.toolasha-ct-section-header.toolasha-ct-tile-drop-target,
.toolasha-ct-unorg-header.toolasha-ct-tile-drop-target {
    background: rgba(74, 158, 255, 0.15) !important;
    box-shadow: inset 0 0 0 1px rgba(74, 158, 255, 0.4);
}
.toolasha-ct-active [class*="Item_itemContainer"].toolasha-ct-drop-before {
    box-shadow: -2px 0 0 0 #4a9eff;
}
.toolasha-ct-active [class*="Item_itemContainer"].toolasha-ct-drop-after {
    box-shadow: 2px 0 0 0 #4a9eff;
}
`;

// Sprite URL cache — needed for editor modal item search results
let _spriteBaseUrl = null;

/**
 * Discover the game's items SVG sprite URL
 * @returns {string|null}
 */
function getSpriteBaseUrl() {
    if (_spriteBaseUrl) return _spriteBaseUrl;
    const allUses = document.querySelectorAll('svg use');
    for (const useEl of allUses) {
        const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
        if (href.includes('items_sprite')) {
            const hashIdx = href.indexOf('#');
            if (hashIdx > 0) {
                _spriteBaseUrl = href.slice(0, hashIdx);
                return _spriteBaseUrl;
            }
        }
    }
    return null;
}

// Color presets for tab accents
const COLOR_PRESETS = ['#e06060', '#e0a030', '#40c060', '#40a0e0', '#a060e0', '#e060c0'];

/**
 * What the item-count badge on a tab header means, as a hover explanation.
 *
 * The count is how many items the tab is *configured* to hold, not how many
 * tiles are currently drawn — a category collapsed in the game's own
 * Inventory tab hides tiles here too, and the ⚠ beside the tab's name is what
 * says that has happened. Left unstated, the two easily get read as the same
 * number.
 *
 * @param {number} count - Configured item count, line breaks excluded
 * @returns {string}
 */
export function tabItemCountTooltip(count) {
    return `${count} item${count === 1 ? '' : 's'} assigned to this tab`;
}

/**
 * What the value badge on a tab header means, as a hover explanation.
 *
 * States which price it is summed at — ask, bid, or whatever the "badges on
 * none" sort mode is set to — and across how many tiles, since that can run
 * short of the configured item count for the same reason the count badge's
 * own tooltip explains: a collapsed game category hides tiles without
 * un-assigning them.
 *
 * @param {string} valueKey - Tile dataset key the total was summed from,
 *   e.g. `askValue`; the tooltip names the price by stripping the suffix
 * @param {number} tileCount - How many tiles the total was summed across
 * @returns {string}
 */
export function tabValueTooltip(valueKey, tileCount) {
    const priceWord = valueKey.replace(/Value$/, '');
    return (
        `Total ${priceWord} value of the ${tileCount} item${tileCount === 1 ? '' : 's'} shown in this tab, ` +
        `from Toolasha's inventory badges.`
    );
}

export default class CustomTabsUI {
    constructor() {
        this._isActive = false;
        this._config = null;
        // Which character `_config` was loaded for. Every write and every render
        // is checked against this rather than against "whoever is current now" —
        // see `_isConfigForCurrentCharacter`.
        this._configCharId = null;
        // Bumped by every `_reloadForCurrentCharacter`; only the newest reload
        // is allowed to set `_configCharId`, and it always does
        this._reloadGeneration = 0;
        this._onCharacterInitialized = null;
        this._tabBtn = null;
        this._invContainer = null;
        this._injectedEls = []; // Elements we injected into Inventory_items (headers, topbar)
        this._unregisterHandlers = [];
        this._onItemsUpdated = null;
        this._styleEl = null;
        this._unorgOpen = true;
        this._editorTabId = null;
        this._deleteConfirmId = null;
        this._dragInProgress = false; // Suppress click-toggles immediately after a drag-drop
        this._inventoryTabEl = null; // Ref to native Inventory tab button (for restore on cleanup)
        this._expandedSearchHrids = null; // Set of base hrids expanded in the item picker
        this._isApplying = false; // Guard against concurrent _applyLayout calls
        this._needsAnotherPass = false; // Deferred layout re-run flag
        this._lastRebuildTileCount = 0; // Tile count at last full rebuild (detects inventory changes)
        this._actionBtnsEl = null; // +Tab/Export/Import appended to sort controls row on Toolasha tab
        this._tileObserver = null; // MutationObserver for instant tile visibility on React swaps
        this._observedContainer = null; // Container currently being observed by _tileObserver
        this._dragBoundTiles = new WeakSet();
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async initialize() {
        const charId = dataManager.getCurrentCharacterId();
        // The ticket has to live here rather than in the feature wrapper, and
        // this is the one site in the class where a guard in the wrapper could
        // not stand in for it. `CustomTabsFeature.disable()` runs
        // `this.ui?.cleanup(); this.ui = null;` — so a teardown landing inside
        // the read below cleans a half-built instance and then drops the only
        // reference to it, while this call is still suspended on `this`. The
        // resumed tail used to inject its stylesheet, both `domObserver.onClass`
        // watchers, the `onReady` catch-up and its retry interval, two
        // `config.onSettingChange` subscriptions, the `items_updated` rAF loop,
        // the sort-mode subscription, the `character_initialized` reload and the
        // loadout-snapshot subscription — all onto an instance no future
        // `cleanup()` can ever reach, because nothing holds it any more. Every
        // other site in this class self-heals on the next switch; this one is
        // the only leak that is permanent for the life of the tab, and it keeps
        // rewriting inventory DOM off a departed character's config.
        const ticket = captureOwner(this);
        this._config = await loadConfig(charId);
        // Gates the whole tail — there is only one await in this body, and the
        // registrations below run in sequence off it.
        if (!stillOurs(ticket)) return;
        this._configCharId = charId;

        // Inject CSS
        this._styleEl = document.createElement('style');
        this._styleEl.textContent = PANEL_CSS;
        document.head.appendChild(this._styleEl);

        const unregister = domObserver.onClass('CustomTabs', 'TabsComponent_tabsContainer', () => {
            this._tryInjectTabButton();
        });
        this._unregisterHandlers.push(unregister);

        // Inject tab button into character panel tab bar. @run-at document-start: a tab bar
        // rendered before the shared observer attaches to document.body is invisible to the
        // class watcher, so the catch-up (and its retry fallback) waits for the observer's
        // actual-ready signal (immediate if it is already attached).
        this._unregisterHandlers.push(
            domObserver.onReady('CustomTabsCatchUp', () => {
                this._tryInjectTabButton();

                if (!this._tabBtn) {
                    let retries = 0;
                    const retryInterval = setInterval(() => {
                        retries++;
                        this._tryInjectTabButton();
                        if (this._tabBtn || retries >= 20) clearInterval(retryInterval);
                    }, 500);
                    this._unregisterHandlers.push(() => clearInterval(retryInterval));
                }
            })
        );

        // Live setting change for default-tab behaviour
        const unregisterDefaultTab = config.onSettingChange('inventoryTabs_defaultTab', () => {
            this._applyDefaultTabSetting();
        });
        this._unregisterHandlers.push(unregisterDefaultTab);

        // Live setting change for tile gap
        const unregisterTileGap = config.onSettingChange('inventoryTabs_tileGap', () => {
            if (this._isActive) this._applyTileGap();
        });
        this._unregisterHandlers.push(unregisterTileGap);

        // Re-apply layout when inventory changes.
        // Uses requestAnimationFrame instead of a long debounce — rAF fires at the next frame
        // boundary (~16ms), by which point React has finished swapping tile elements for
        // enhancement level changes. A 200ms debounce caused the enhanced item to disappear
        // from the custom tab for ~200ms while the new tile had no toolasha-ct-visible class.
        let rafId = null;
        this._onItemsUpdated = (data) => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (this._isActive) this._applyLayout();
            });
            // Check if any changed items have a higher enhancement than bound items
            this._checkBindingEnhancements(data);
        };
        dataManager.on('items_updated', this._onItemsUpdated);

        // Re-apply layout when sort mode changes
        const unregisterSort = inventorySort.onModeChange(() => {
            if (this._isActive) this._applyLayout();
        });
        this._unregisterHandlers.push(unregisterSort);

        // Inject "Add to Tab" button into item action menus
        const unregisterItemAction = domObserver.onClass('CustomTabs_itemAction', 'Item_actionMenu', (menu) => {
            this._injectAddToTabButton(menu);
        });
        this._unregisterHandlers.push(unregisterItemAction);

        // Reload the config when the character changes, without waiting for the
        // feature registry to tear this UI down and build a new one.
        //
        // `character_initialized` rather than `character_switched`: the data
        // manager skips BOTH `character_switching` and `character_switched` when
        // switches arrive inside its rapid-switch window (see
        // `isRapidSwitch` in data-manager.js), and with them the whole
        // disable()/initialize() cycle this feature used to depend on — so the
        // UI kept the departing character's tabs while `getCurrentCharacterId()`
        // already answered with the arriving one, and the next edit wrote one
        // character's tabs under the other's key. `character_initialized` is
        // emitted on every init, rapid or not, and only once the arriving
        // character's data is actually in place, which is also the first moment
        // a re-render has the right inventory to draw against.
        // The returned promise is what an awaiting emitter (and the tests) can
        // wait on; the data manager does not await this event, and does not
        // need to — until it resolves, `_configCharId` is null and every write
        // and render is refused.
        this._onCharacterInitialized = () =>
            this._reloadForCurrentCharacter().catch((error) => {
                console.error('[CustomTabs] Reloading tabs after a character switch failed:', error);
            });
        dataManager.on('character_initialized', this._onCharacterInitialized);

        // Subscribe to loadout snapshot updates for auto-sync of loadout bindings
        this._loadoutBindingHandler = () => this._onLoadoutSnapshotUpdate();
        getLoadoutSnapshot().onUpdate(this._loadoutBindingHandler);
        this._unregisterHandlers.push(() => {
            getLoadoutSnapshot().offUpdate(this._loadoutBindingHandler);
        });
    }

    cleanup() {
        noteTeardown(this);
        if (this._inventoryTabEl) {
            this._inventoryTabEl.style.display = '';
            this._inventoryTabEl = null;
        }

        this._clearLayout();

        if (this._onItemsUpdated) {
            dataManager.off('items_updated', this._onItemsUpdated);
            this._onItemsUpdated = null;
        }
        if (this._onCharacterInitialized) {
            dataManager.off('character_initialized', this._onCharacterInitialized);
            this._onCharacterInitialized = null;
        }
        for (const unreg of this._unregisterHandlers) {
            if (typeof unreg === 'function') unreg();
        }
        this._unregisterHandlers = [];

        this._tabBtn?.remove();
        this._actionBtnsEl?.remove();
        this._actionBtnsEl = null;
        this._styleEl?.remove();
        document.querySelectorAll('.toolasha-ct-add-to-tab').forEach((el) => el.remove());
        // The editor hangs off document.body, so `_clearLayout`'s sweep of the
        // inventory container never sees it. Left standing it is a live dialog
        // wired to a UI that no longer exists — every button edits the discarded
        // `_config` and `_save()` refuses the write, and re-enabling the feature
        // builds a second UI underneath it.
        document.querySelectorAll('.toolasha-ct-modal-overlay').forEach((el) => el.remove());
        this._editorTabId = null;
        this._isActive = false;
        this._configCharId = null;
    }

    /**
     * Whether the config in hand belongs to the character that is current now.
     *
     * The safety net the whole fix hangs off. `_config` is loaded once and kept
     * for the UI's lifetime, and that lifetime is NOT guaranteed to end at a
     * character switch, so "current character" and "the character these tabs
     * came from" are two different questions and every write has to ask the
     * second one.
     * @returns {boolean}
     */
    _isConfigForCurrentCharacter() {
        return this._configCharId === dataManager.getCurrentCharacterId();
    }

    /**
     * Load the current character's config and redraw, if what is held is
     * someone else's. Idempotent: called on every `character_initialized`,
     * including the ones that are not switches.
     * @returns {Promise<void>}
     */
    async _reloadForCurrentCharacter() {
        const charId = dataManager.getCurrentCharacterId();
        if (charId === this._configCharId) return;

        // Every reload takes a generation. Two rules hang off it, and together
        // they are what guarantees the latch always ends up SET:
        //
        //  - the bail-out below stands down only for a reload that is genuinely
        //    newer than this one, so the newest reload always runs to
        //    completion and sets `_configCharId`. It used to bail on
        //    "the current character is not the one I loaded", which is also
        //    true when the newer reload has already finished — both reloads
        //    then returned without setting the latch and the panel drew
        //    nothing until the page was reloaded;
        //  - a failure restores the latch it found rather than leaving null.
        const generation = ++this._reloadGeneration;
        const previousCharId = this._configCharId;

        // Nulled for the duration of the load, not left pointing at the old
        // character: a save landing mid-load would otherwise be waved through
        // against the departed id and then merged under the arriving one when
        // `saveConfig` looks the record up. Nothing matches null, so the window
        // is closed rather than narrowed.
        this._configCharId = null;

        let loaded;
        try {
            loaded = await loadConfig(charId);
        } catch (error) {
            // A rejected load must not leave the panel dead. Retry once — the
            // usual cause is a transient IndexedDB failure — and if that fails
            // too, hand the latch back to whatever it was, so the panel keeps
            // drawing the config it already has instead of nothing at all.
            console.error('[CustomTabs] Loading tabs failed; retrying once:', error);
            try {
                loaded = await loadConfig(charId);
            } catch (retryError) {
                console.error('[CustomTabs] Tab reload failed again; keeping the previous config:', retryError);
                if (generation === this._reloadGeneration && this._configCharId === null) {
                    this._configCharId = previousCharId;
                }
                return;
            }
        }

        // A LATER reload is the authority on what ends up in `_config`; this one
        // stands down for it and for nothing else. When this is still the newest
        // reload it finishes even if the character moved on under it — its own
        // successor is already queued behind the same event and will correct it.
        if (generation !== this._reloadGeneration) return;

        this._config = loaded;
        this._configCharId = charId;
        // `_boundBaseHrids` is derived from `_config`'s loadoutBindings and is
        // rebuilt only when it is null, so a config swap has to drop it. Left
        // standing, the departed character's cache decided which changed items
        // `_checkBindingEnhancements` even considers: the arriving character's
        // bound items are absent from it, so their bindings stopped syncing for
        // the rest of the session (and a departed character with no bindings at
        // all left a zero-size cache that short-circuits the check outright),
        // while the levels it does carry are the departed character's.
        this._boundBaseHrids = null;

        // The headers encode the departed character's tabs and their order
        // values, so they are torn down rather than updated — the same path the
        // Import button takes when it swaps the whole config out.
        this._removeInjectedEls();
        const invContainer = this._findInvContainer();
        if (invContainer) invContainer.scrollTop = 0;
        if (this._isActive) await this._applyLayout();
    }

    // -----------------------------------------------------------------------
    // Tab button injection
    // -----------------------------------------------------------------------

    _findCharacterTabList() {
        const allTabLists = document.querySelectorAll('[role="tablist"]');
        for (const tl of allTabLists) {
            for (const tab of tl.querySelectorAll('[role="tab"]')) {
                if (tab.textContent.trim() === 'Inventory') return tl;
            }
        }
        return null;
    }

    _tryInjectTabButton() {
        try {
            const tabList = this._findCharacterTabList();
            if (!tabList) return;
            if (tabList.querySelector('.toolasha-inv-tab')) return;

            const existingTab = tabList.querySelector('[role="tab"]');
            const btn = document.createElement('button');
            btn.className =
                'toolasha-inv-tab ' + (existingTab ? existingTab.className.replace(/Mui-selected/g, '') : '');
            btn.setAttribute('role', 'tab');
            btn.setAttribute('type', 'button');
            btn.textContent = 'Toolasha';
            btn.style.minWidth = 'auto';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._activatePanel();
            });

            const inventoryTab = [...tabList.querySelectorAll('[role="tab"]')].find(
                (t) => t.textContent.trim() === 'Inventory'
            );
            if (inventoryTab) this._inventoryTabEl = inventoryTab;
            if (inventoryTab?.nextSibling) {
                tabList.insertBefore(btn, inventoryTab.nextSibling);
            } else {
                tabList.appendChild(btn);
            }
            this._tabBtn = btn;

            const scroller = tabList.parentElement;
            if (scroller && scroller.className.includes('MuiTabs-scroller')) {
                scroller.style.overflow = 'auto';
            }

            for (const tab of tabList.querySelectorAll('[role="tab"]:not(.toolasha-inv-tab)')) {
                tab.addEventListener('click', () => this._deactivatePanel(tab));
            }

            this._applyDefaultTabSetting();
        } catch (err) {
            console.error('[CustomTabs] _tryInjectTabButton failed:', err);
        }
    }

    // -----------------------------------------------------------------------
    // Panel activation / deactivation
    // -----------------------------------------------------------------------

    /**
     * Apply (or remove) the "show Toolasha tab by default" behaviour.
     * Called when the tab button is first injected and on live setting changes.
     */
    _applyDefaultTabSetting() {
        if (!this._tabBtn) return;
        const enabled = config.getSetting('inventoryTabs_defaultTab');
        if (this._inventoryTabEl) {
            this._inventoryTabEl.style.display = enabled ? 'none' : '';
        }
        if (enabled && !this._isActive) {
            this._activatePanel();
        } else if (enabled && this._isActive) {
            // Tab bar was reconstructed by React; re-hide content and re-apply layout
            this._hideGameContent();
            this._applyLayout();
        }
    }

    /**
     * Apply tile gap to the active inventory container based on the setting.
     * @param {HTMLElement} [container]
     */
    _applyTileGap(container) {
        const el = container || this._invContainer;
        if (!el) return;
        el.style.gap = `${config.getSettingValue('inventoryTabs_tileGap', 4)}px`;
    }

    _activatePanel() {
        if (this._isActive) return;
        this._isActive = true;

        if (this._tabBtn) this._tabBtn.classList.add('Mui-selected');
        const tabList = this._tabBtn?.parentElement;
        if (tabList) {
            for (const tab of tabList.querySelectorAll('[role="tab"]:not(.toolasha-inv-tab)')) {
                tab.classList.remove('Mui-selected');
                tab.setAttribute('aria-selected', 'false');
            }
        }

        // Hide the game's content panels (Equipment, Abilities, etc.)
        this._hideGameContent();

        this._applyLayout();
    }

    _deactivatePanel(clickedTab = null) {
        if (!this._isActive) return;
        this._isActive = false;
        if (this._tabBtn) this._tabBtn.classList.remove('Mui-selected');
        this._clearLayout();
        this._showGameContent();
        // Restore the selected state on the clicked native tab. React won't re-render because
        // MUI still thinks this tab was selected (we bypassed its state when activating Toolasha).
        if (clickedTab) {
            clickedTab.classList.add('Mui-selected');
            clickedTab.setAttribute('aria-selected', 'true');
        }
    }

    /**
     * Hide the game's TabsComponent_tabPanelsContainer content
     * (the content for Inventory/Equipment/etc.)
     */
    _hideGameContent() {
        const contentContainer = this._findContentContainer();
        if (contentContainer) {
            contentContainer.style.display = 'none';
        }
    }

    /**
     * Restore the game's TabsComponent_tabPanelsContainer content
     */
    _showGameContent() {
        const contentContainer = this._findContentContainer();
        if (contentContainer) {
            contentContainer.style.display = '';
        }
    }

    /**
     * Find the TabsComponent_tabPanelsContainer that holds game content
     * @returns {HTMLElement|null}
     */
    _findContentContainer() {
        const tabList = this._findCharacterTabList();
        if (!tabList) return null;
        const wrapper = tabList.closest('[class*="TabsComponent_tabsContainer"]');
        return wrapper?.nextElementSibling || null;
    }

    // -----------------------------------------------------------------------
    // Layout: CSS order approach — tiles stay in Inventory_items
    // -----------------------------------------------------------------------

    /**
     * Find the game's Inventory_items element
     * @returns {HTMLElement|null}
     */
    _findInvContainer() {
        return document.querySelector('[class*="Inventory_items"]');
    }

    /**
     * Count total items across all tabs (recursively) for rebuild detection.
     * @returns {number}
     */
    _getTotalConfigItemCount() {
        const countTab = (tab) => (tab.items?.length || 0) + (tab.children || []).reduce((s, c) => s + countTab(c), 0);
        return (this._config?.tabs || []).reduce((s, t) => s + countTab(t), 0);
    }

    /**
     * Synchronous layout pass — applies CSS order and visibility to all tiles.
     * Extracted from _applyLayout so it can also be called from a MutationObserver
     * callback (which fires before the browser paints, eliminating flicker when
     * React swaps tile elements during enhancement).
     * @param {HTMLElement} invContainer
     */
    _applyLayoutSync(invContainer) {
        // Compare BEFORE assignment — otherwise isSameNode is always true
        const isSameNode = invContainer === this._invContainer;
        const injectedStillPresent =
            this._injectedEls.length > 0 && this._injectedEls[0].parentElement === invContainer;
        let needsFullRebuild = !isSameNode || !injectedStillPresent;

        this._invContainer = invContainer;

        // Every hrid any tab asks for, this pass. `_claimTilesForHrid` needs it to
        // tell an enhancement level a tab actually named from one that merely
        // exists in the inventory.
        this._assignedHrids = getAssignedItemSet(this._config);

        // Add the active class — this makes Inventory_items a flex container,
        // applies display:contents to category wrappers, hides category labels,
        // and hides ALL tiles by default (via CSS).
        invContainer.classList.add('toolasha-ct-active');
        this._applyTileGap(invContainer);

        // Ensure the Inventory panel is visible
        this._showInventoryPanel();

        if (needsFullRebuild) {
            this._removeInjectedEls();
        }

        // Build tile map from all tiles currently in invContainer
        const tileMap = this._buildTileMap(invContainer);

        // Reset all tiles: remove visible class, clear inline order, and drag state
        const allTiles = invContainer.querySelectorAll('[class*="Item_itemContainer"]');
        for (const tile of allTiles) {
            tile.classList.remove('toolasha-ct-visible', 'toolasha-ct-drop-before', 'toolasha-ct-drop-after');
            tile.style.order = '';
            tile.draggable = false;
            delete tile.dataset.toolashaTabId;
        }

        // Force full rebuild when tile count OR config item count changed — the lightweight path
        // reuses stale header order values that don't have enough order-space
        // for new tiles, causing items to visually cascade into wrong sections.
        const configItemCount = this._getTotalConfigItemCount();
        if (
            !needsFullRebuild &&
            (allTiles.length !== this._lastRebuildTileCount || configItemCount !== this._lastRebuildConfigItemCount)
        ) {
            needsFullRebuild = true;
            this._removeInjectedEls();
        }

        // The +Tab/Export/Import/Expand group is merged into the game's
        // .mwi-inventory-sort-controls row and is not tracked in _injectedEls, so
        // its presence check above cannot see it. When InventorySort removes that
        // row the buttons silently vanish and never come back on the lightweight
        // path; a direct connectivity check heals them (ported from upstream
        // Celasha/Toolasha#632).
        if (!needsFullRebuild && this._actionBtnsEl && !this._actionBtnsEl.isConnected) {
            needsFullRebuild = true;
            this._removeInjectedEls();
        }

        if (needsFullRebuild) {
            // Full rebuild: inject action buttons + headers
            let orderCounter = 0;

            const topbar = this._injectActionButtons();
            if (topbar) {
                topbar.style.order = orderCounter++;
                invContainer.appendChild(topbar);
                this._injectedEls.push(topbar);
            }

            if (this._config.tabs.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'toolasha-ct-empty';
                empty.textContent = 'No custom tabs yet. Click "+ Tab" to create one.';
                empty.style.order = orderCounter++;
                invContainer.appendChild(empty);
                this._injectedEls.push(empty);
            } else {
                this._allClaimedHrids = new Set();
                orderCounter = this._injectAccordionHeaders(invContainer, this._config.tabs, 0, tileMap, orderCounter);
            }

            // getSetting (not getSettingValue) so a character switch, which clears
            // the per-character cache mid-layout-pass, reads the schema default
            // (true) instead of null and does not drop the Unorganized bucket
            // until the cache reloads (ported from upstream Celasha/Toolasha#636).
            if (config.getSetting('inventoryTabs_showUnorganized')) {
                orderCounter = this._injectUnorganized(invContainer, tileMap, orderCounter);
            }

            this._lastRebuildTileCount = allTiles.length;
            this._lastRebuildConfigItemCount = configItemCount;
        } else {
            // Lightweight update: headers already exist, just re-apply tile order/visibility
            this._updateTileVisibility(invContainer, tileMap);
        }

        // Attach tile observer if not already watching this container.
        // The observer fires synchronously (as a microtask) after React swaps a tile
        // element, BEFORE the browser paints — so we can restore toolasha-ct-visible
        // with zero visible frames of invisibility.
        if (this._tileObserver === null || this._observedContainer !== invContainer) {
            this._tileObserver?.disconnect();
            this._observedContainer = invContainer;
            this._tileObserver = new MutationObserver((mutations) => {
                if (!this._isActive) return;
                const hasTileChange = mutations.some((m) =>
                    [...m.addedNodes, ...m.removedNodes].some(
                        (n) =>
                            n.nodeType === Node.ELEMENT_NODE &&
                            (n.className?.includes?.('Item_itemContainer') ||
                                n.querySelector?.('[class*="Item_itemContainer"]'))
                    )
                );
                if (hasTileChange) this._applyLayoutSync(invContainer);
            });
            this._tileObserver.observe(invContainer, { childList: true, subtree: true });
        }
    }

    /**
     * Apply the CSS order layout. Tiles never leave Inventory_items.
     * We add `display: contents` to flatten wrapper divs, inject accordion
     * headers, and set CSS `order` on each tile to group them visually.
     *
     * Tiles are hidden by default via the CSS rule on .toolasha-ct-active,
     * then selectively shown by adding .toolasha-ct-visible.
     */
    async _applyLayout() {
        // A pass deferred across a character switch (the rAF below, the tile
        // MutationObserver, a sort-mode change) would draw the departed
        // character's tabs over the arriving character's tiles, and claim
        // their items into sections that are not theirs. The reload triggered
        // by `character_initialized` redraws once the right config is in hand.
        if (!this._isConfigForCurrentCharacter()) return;

        // Guard against concurrent calls — defer and re-run after current pass
        if (this._isApplying) {
            this._needsAnotherPass = true;
            return;
        }
        this._isApplying = true;
        this._needsAnotherPass = false;

        try {
            const invContainer = this._findInvContainer();
            if (!invContainer) return;

            this._applyLayoutSync(invContainer);

            // Run badge manager AFTER visibility is restored — badges are independent of tile
            // order/visibility, and running them before caused React tile replacements (on
            // enhancement level changes) to appear as a ~16ms flicker in the custom tab.
            if (!inventoryBadgeManager.currentInventoryElem) {
                inventoryBadgeManager.currentInventoryElem = invContainer;
            }
            // Deadline-capped wait — if the badge manager's guard flags ever stick
            // (e.g. an uncaught throw), give up instead of spinning forever.
            const waitDeadline = Date.now() + 5000;
            while (
                (inventoryBadgeManager.isRendering || inventoryBadgeManager.isCalculating) &&
                Date.now() < waitDeadline
            ) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            inventoryBadgeManager.lastRenderTime = 0;
            inventoryBadgeManager.lastCalculationTime = 0;
            await inventoryBadgeManager.renderAllBadges();
        } finally {
            this._isApplying = false;
            if (this._needsAnotherPass) {
                this._needsAnotherPass = false;
                this._applyLayout();
            }
        }
    }

    /**
     * Lightweight tile update — headers are already injected with correct order values.
     * Re-apply toolasha-ct-visible and style.order to tiles based on current config.
     * @param {HTMLElement} invContainer
     * @param {Map} tileMap
     */
    _updateTileVisibility(invContainer, tileMap) {
        // Walk through injected headers to read their order values and match tiles
        const headers = invContainer.querySelectorAll('.toolasha-ct-section-header');
        const headerOrderMap = new Map();
        for (const header of headers) {
            headerOrderMap.set(header.dataset.tabId, parseInt(header.style.order, 10));
        }

        // Show tiles for open tabs, assigning order values after their header
        this._applyTileOrderForTabs(this._config.tabs, tileMap, headerOrderMap);

        // Handle unorganized bucket
        const unorgHeader = invContainer.querySelector('.toolasha-ct-unorg-header');
        if (unorgHeader && this._unorgOpen) {
            const unorgOrder = parseInt(unorgHeader.style.order, 10);
            const unorgTiles = this._collectUnassignedTileEntries(tileMap).flatMap(({ tiles }) => tiles);
            this._assignTileOrders(unorgTiles, unorgOrder + 1, '');
        }
    }

    /**
     * Recursively apply tile visibility/order for tabs using existing header order values
     * @param {Array} tabs
     * @param {Map} tileMap
     * @param {Map} headerOrderMap - tabId → order number from injected headers
     */
    _applyTileOrderForTabs(tabs, tileMap, headerOrderMap) {
        for (const tab of tabs) {
            const headerOrder = headerOrderMap.get(tab.id);
            if (headerOrder === undefined) continue;

            if (tab.open) {
                const hasLineBreaks = tab.items.includes(LINEBREAK_HRID);

                if (hasLineBreaks) {
                    let currentOrder = headerOrder + 1;
                    let lbIndex = 0;
                    for (const hrid of tab.items) {
                        if (hrid === LINEBREAK_HRID) {
                            const lb = this._invContainer?.querySelector(
                                `.toolasha-ct-linebreak[data-tab-id="${tab.id}"][data-lb-index="${lbIndex}"]`
                            );
                            if (lb) lb.style.order = String(currentOrder);
                            currentOrder++;
                            lbIndex++;
                        } else {
                            for (const tile of this._claimTilesForHrid(hrid, tileMap)) {
                                tile.classList.add('toolasha-ct-visible');
                                tile.style.order = String(currentOrder++);
                                tile.dataset.toolashaTabId = tab.id;
                                this._setupTileDrag(tile);
                            }
                        }
                    }
                } else {
                    const sectionTiles = [];
                    for (const hrid of tab.items) {
                        for (const tile of this._claimTilesForHrid(hrid, tileMap)) sectionTiles.push(tile);
                    }
                    this._assignTileOrders(sectionTiles, headerOrder + 1, tab.id);
                }

                if (tab.children.length > 0) {
                    this._applyTileOrderForTabs(tab.children, tileMap, headerOrderMap);
                }
            } else {
                // Collapsed — claim own items if topTabPriority so lower tabs can't show them.
                if (config.getSetting('inventoryTabs_topTabPriority')) {
                    for (const hrid of tab.items) {
                        if (hrid !== LINEBREAK_HRID) this._claimTilesForHrid(hrid, tileMap);
                    }
                }
                // Remove children's items only.
                this._removeTilesFromMapForChildren(tab.children, tileMap);
            }
        }
    }

    /**
     * Ensure the Inventory panel (first tab panel) is visible while hiding others.
     * The content container was hidden on activation; we need to un-hide it but
     * only show the Inventory panel.
     */
    _showInventoryPanel() {
        const contentContainer = this._findContentContainer();
        if (!contentContainer) return;

        // Show the content container itself
        contentContainer.style.display = '';

        // Hide all child panels, then show only the first one (Inventory)
        for (const child of contentContainer.children) {
            child.style.display = 'none';
        }
        if (contentContainer.children[0]) {
            contentContainer.children[0].style.display = 'block';
        }
    }

    /**
     * Remove all CSS classes and injected elements; restore normal game layout.
     */
    _clearLayout() {
        this._tileObserver?.disconnect();
        this._tileObserver = null;
        this._observedContainer = null;

        this._removeInjectedEls();

        if (this._invContainer) {
            this._invContainer.classList.remove('toolasha-ct-active');

            // Remove visible class and inline order from all tiles
            const tiles = this._invContainer.querySelectorAll('[class*="Item_itemContainer"]');
            for (const tile of tiles) {
                tile.classList.remove('toolasha-ct-visible');
                tile.style.order = '';
            }
        }

        // Restore content container panels visibility
        const contentContainer = this._findContentContainer();
        if (contentContainer) {
            for (const child of contentContainer.children) {
                child.style.display = '';
            }
        }
    }

    /**
     * Remove all elements we injected into invContainer
     */
    _removeInjectedEls() {
        this._actionBtnsEl?.remove();
        this._actionBtnsEl = null;
        for (const el of this._injectedEls) {
            el.remove();
        }
        this._injectedEls = [];
    }
    /**
     * Create the top bar with sort proxy buttons and tab action buttons.
     * Shown only on the Toolasha tab; hides the external sort controls row.
     * @returns {HTMLElement}
     */
    /**
     * Create the tab action buttons and place them to the right of the sort controls row.
     * Falls back to a topbar inside the inventory container if sort controls aren't present.
     * @param {HTMLElement} invContainer
     * @returns {HTMLElement|null} topbar element if fallback was used, null if appended to sort controls
     */
    _injectActionButtons() {
        this._actionBtnsEl?.remove();

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'toolasha-ct-action-btns';
        actionsDiv.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

        const addBtn = document.createElement('button');
        addBtn.className = 'toolasha-ct-add-btn';
        addBtn.textContent = '+ Tab';
        addBtn.addEventListener('click', () => this._onAddTab(null));

        const exportBtn = document.createElement('button');
        exportBtn.className = 'toolasha-ct-add-btn';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', () => this._exportLayout());

        const importBtn = document.createElement('div');
        importBtn.className = 'toolasha-ct-add-btn';
        importBtn.style.position = 'relative';
        importBtn.style.overflow = 'hidden';
        importBtn.textContent = 'Import';
        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer;';
        importInput.addEventListener('change', () => {
            const file = importInput.files?.[0];
            if (file) this._handleImportFile(file);
            importInput.value = '';
        });
        importBtn.appendChild(importInput);

        actionsDiv.appendChild(addBtn);
        actionsDiv.appendChild(exportBtn);
        actionsDiv.appendChild(importBtn);

        const expandBtn = document.createElement('button');
        expandBtn.className = 'toolasha-ct-add-btn';
        expandBtn.textContent = 'Expand All';
        expandBtn.addEventListener('click', () => this._onSetAllTabsOpen(true));
        actionsDiv.appendChild(expandBtn);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'toolasha-ct-add-btn';
        collapseBtn.textContent = 'Collapse All';
        collapseBtn.addEventListener('click', () => this._onSetAllTabsOpen(false));
        actionsDiv.appendChild(collapseBtn);

        this._actionBtnsEl = actionsDiv;

        const sortControls = document.querySelector('.mwi-inventory-sort-controls');
        if (sortControls) {
            actionsDiv.style.marginLeft = 'auto';
            sortControls.appendChild(actionsDiv);
            return null; // no topbar needed
        }

        // Fallback: no sort controls — use a topbar inside the container
        const topbar = document.createElement('div');
        topbar.className = 'toolasha-ct-topbar';
        topbar.appendChild(actionsDiv);
        return topbar;
    }

    /**
     * Serialize the current layout to a JSON file and trigger a download.
     *
     * `removed`, `removedItems` and `orderUpdatedAt` are stripped. All are sync
     * bookkeeping
     * about THIS config's history on THIS device, and neither survives the trip
     * usefully: a shared file carrying a tombstone map is a file that deletes
     * tabs on whoever imports it, and an `orderUpdatedAt` from another device's
     * clock outranks the importer's own ordering for no reason. A layout file
     * is the tabs and where they sit — nothing else.
     */
    /**
     * Build the export download name: character, game-mode tag and date keep
     * files from different characters (or days) from overwriting each other.
     * Any half that isn't known yet is simply left off.
     * @returns {string} e.g. "toolasha-tabs-Millennium44-IC-2026-08-27.json"
     */
    _exportFileName() {
        const modeCodes = { standard: 'MC', ironcow: 'IC', legacy_ironcow: 'LC' };
        const modeKey = (dataManager.getCurrentCharacterGameMode() || '').split('/').pop();
        const name = (dataManager.getCurrentCharacterName() || '').replace(/[^\w-]+/g, '');
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        return ['toolasha-tabs', name || null, modeCodes[modeKey] || null, date].filter(Boolean).join('-') + '.json';
    }

    _exportLayout() {
        const {
            removed: _removed,
            removedItems: _removedItems,
            orderUpdatedAt: _orderUpdatedAt,
            ...config
        } = this._config || {};
        const payload = { _toolasha: 'tabs-v1', ...config };
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this._exportFileName();
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Process an imported JSON layout file and apply it.
     * @param {File} file
     */
    async _handleImportFile(file) {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (parsed._toolasha !== 'tabs-v1' || !Array.isArray(parsed.tabs)) {
                alert('[Toolasha] Invalid layout file.');
                console.error('[CustomTabs] Import failed: missing _toolasha marker or tabs array', parsed);
                return;
            }
            const { _toolasha: _, ...raw } = parsed;
            // Never adopt a file verbatim — see sanitizeImportedConfig
            this._config = sanitizeImportedConfig(raw);
            // Apply layout immediately — save to IndexedDB in the background
            this._removeInjectedEls();
            const invContainer = this._findInvContainer();
            if (invContainer) invContainer.scrollTop = 0;
            await this._applyLayout();
            this._save();
        } catch (err) {
            alert('[Toolasha] Failed to read layout file.');
            console.error('[CustomTabs] Import error:', err);
        }
    }

    /**
     * Build a map of itemHrid → array of game tile elements in the inventory DOM.
     * @param {HTMLElement} invContainer
     * @returns {Map<string, HTMLElement[]>}
     */
    _buildTileMap(invContainer) {
        const map = new Map();
        const tiles = invContainer.querySelectorAll('[class*="Item_itemContainer"]');
        for (const tile of tiles) {
            const hrid = this._tileBaseHrid(tile);
            if (!hrid) continue;
            // Always register under base hrid (matches all enhancement levels)
            if (!map.has(hrid)) map.set(hrid, []);
            map.get(hrid).push(tile);
            // Check for enhancement level badge element
            const enhEl = tile.querySelector('[class*="Item_enhancementLevel"]');
            if (enhEl) {
                const level = parseInt(enhEl.textContent.trim().replace('+', ''), 10);
                if (!isNaN(level) && level > 0) {
                    const enhancedHrid = `${hrid}+${level}`;
                    if (!map.has(enhancedHrid)) map.set(enhancedHrid, []);
                    map.get(enhancedHrid).push(tile);
                }
            }
        }
        return map;
    }

    /**
     * Claim tiles for a given hrid from the tileMap.
     * - Base hrid (/items/foo): claims all tiles (all enhancement levels)
     * - Enhanced hrid (/items/foo+3): claims only +3 tiles and removes them from the base key too
     * @param {string} hrid
     * @param {Map} tileMap
     * @returns {HTMLElement[]}
     */
    _claimTilesForHrid(hrid, tileMap) {
        const entries = tileMap.get(hrid);
        if (!entries) return [];
        tileMap.delete(hrid);
        if (/\+\d+$/.test(hrid)) {
            // Enhanced hrid: also remove these tiles from the base key to prevent double-claim
            const baseHrid = hrid.replace(/\+\d+$/, '');
            const baseEntries = tileMap.get(baseHrid);
            if (baseEntries) {
                const claimedSet = new Set(entries);
                const remaining = baseEntries.filter((t) => !claimedSet.has(t));
                if (remaining.length > 0) tileMap.set(baseHrid, remaining);
                else tileMap.delete(baseHrid);
            }
        } else {
            // Base hrid: hold back the tiles a tab that named their exact level is
            // still waiting for — specificity beats the base hrid even from a tab
            // further down.
            //
            // Only a level SOME tab actually asked for reserves anything.
            // `_buildTileMap` registers every enhanced tile under its `+N` key
            // whether or not a tab wants that level, so treating the key's mere
            // presence as a reservation withheld EVERY enhanced copy from the tab
            // that assigned the base hrid — which this method is documented to
            // match all levels of — and dropped it into Unorganized instead.
            const enhancedPrefix = hrid + '+';
            const reservedTiles = new Set();
            for (const [key, keyTiles] of tileMap) {
                if (key.startsWith(enhancedPrefix) && this._assignedHrids?.has(key)) {
                    for (const t of keyTiles) reservedTiles.add(t);
                }
            }
            const claimable = reservedTiles.size > 0 ? entries.filter((t) => !reservedTiles.has(t)) : entries;
            if (claimable.length < entries.length) {
                // Put the reserved tiles back so their enhanced-hrid tab can claim them
                const reserved = entries.filter((t) => reservedTiles.has(t));
                tileMap.set(hrid, reserved);
            }
            // Mirror of what the enhanced branch does to the base key: a claimed
            // tile is still reachable through its own `+N` key, and the Unorganized
            // bucket collects by key — so without this the tile is placed twice,
            // once by its tab and once, later in the order, by Unorganized.
            if (claimable.length > 0) {
                const claimedSet = new Set(claimable);
                for (const key of [...tileMap.keys()]) {
                    if (!key.startsWith(enhancedPrefix)) continue;
                    const remaining = tileMap.get(key).filter((t) => !claimedSet.has(t));
                    if (remaining.length > 0) tileMap.set(key, remaining);
                    else tileMap.delete(key);
                }
            }
            return claimable;
        }
        return entries;
    }

    /**
     * Lazy-build a name→hrid lookup map
     * @param {string} name
     * @returns {string|null}
     */
    _nameToHrid(name) {
        if (!this._nameHridCache) {
            this._nameHridCache = new Map();
            const initData = dataManager.getInitClientData();
            if (initData?.itemDetailMap) {
                for (const [hrid, details] of Object.entries(initData.itemDetailMap)) {
                    if (details.name) {
                        this._nameHridCache.set(details.name, hrid);
                        // Add ★ ↔ (R) variants so both display formats resolve
                        if (details.name.includes('(R)')) {
                            this._nameHridCache.set(details.name.replace(/\s*\(R\)/, ' ★'), hrid);
                        } else if (details.name.includes('★')) {
                            this._nameHridCache.set(details.name.replace(/\s*★/, ' (R)'), hrid);
                        }
                    }
                }
            }
        }
        return this._nameHridCache.get(name) || null;
    }

    /**
     * The base item HRID a tile shows — from the icon's `<use>` sprite reference
     * first (locale independent), falling back to the translatable aria-label
     * through the name map.
     * @param {HTMLElement} tile - Item tile element
     * @returns {string|null} Base HRID like "/items/sword", or null
     */
    _tileBaseHrid(tile) {
        const spriteHrid = itemHridFromIcon(tile, dataManager.getInitClientData()?.itemDetailMap);
        if (spriteHrid) return spriteHrid;
        const baseName = tile.querySelector('svg[aria-label]')?.getAttribute('aria-label');
        return baseName ? this._nameToHrid(baseName) : null;
    }

    /**
     * Extract the full HRID (including enhancement level) from a tile DOM element.
     * @param {HTMLElement} tile - Item tile element
     * @returns {string|null} HRID like "/items/sword" or "/items/sword+3", or null
     */
    _getHridFromTile(tile) {
        const hrid = this._tileBaseHrid(tile);
        if (!hrid) return null;
        const enhEl = tile.querySelector('[class*="Item_enhancementLevel"]');
        if (enhEl) {
            const level = parseInt(enhEl.textContent.trim().replace('+', ''), 10);
            if (!isNaN(level) && level > 0) {
                return `${hrid}+${level}`;
            }
        }
        return hrid;
    }

    // -----------------------------------------------------------------------
    // Accordion headers — injected into Inventory_items with CSS order
    // -----------------------------------------------------------------------

    /**
     * Inject accordion headers into invContainer for the given tabs.
     * Show/hide tiles using CSS class + order.
     * @param {HTMLElement} invContainer
     * @param {Array} tabs
     * @param {number} depth
     * @param {Map} tileMap
     * @param {number} orderCounter
     * @returns {number} updated orderCounter
     */
    _injectAccordionHeaders(invContainer, tabs, depth, tileMap, orderCounter) {
        for (const tab of tabs) {
            orderCounter = this._injectSectionHeader(invContainer, tab, depth, tileMap, orderCounter);
        }
        return orderCounter;
    }

    /**
     * Inject a single section header + show its tiles via CSS order
     * @param {HTMLElement} invContainer
     * @param {Object} tab
     * @param {number} depth
     * @param {Map} tileMap
     * @param {number} orderCounter
     * @returns {number} updated orderCounter
     */
    _injectSectionHeader(invContainer, tab, depth, tileMap, orderCounter) {
        // Create and inject the header element
        const header = document.createElement('div');
        header.className = 'toolasha-ct-section-header';
        header.dataset.tabId = tab.id;
        header.style.setProperty('--depth', depth);
        header.style.order = orderCounter++;
        if (tab.color) header.style.background = `${tab.color}60`;

        // Drag for reordering
        header.draggable = true;
        header.addEventListener('dragstart', (e) => {
            this._dragInProgress = true;
            e.dataTransfer.setData('text/plain', tab.id);
            e.dataTransfer.effectAllowed = 'move';
            header.style.opacity = '0.4';
        });
        header.addEventListener('dragend', () => {
            header.style.opacity = '';
            // Use a microtask delay so any click that fires immediately after dragend
            // (before the event queue clears) is still suppressed by the flag.
            setTimeout(() => {
                this._dragInProgress = false;
            }, 0);
        });
        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Show different visual for tile drop vs tab reorder
            if (this._tileDragData) {
                header.classList.add('toolasha-ct-tile-drop-target');
            } else {
                header.classList.add('toolasha-ct-section--drag-over');
            }
        });
        header.addEventListener('dragleave', () => {
            header.classList.remove('toolasha-ct-section--drag-over', 'toolasha-ct-tile-drop-target');
        });
        header.addEventListener('drop', (e) => {
            e.preventDefault();
            header.classList.remove('toolasha-ct-section--drag-over', 'toolasha-ct-tile-drop-target');
            // Check for tile drop first
            const tileData = e.dataTransfer.getData('application/x-toolasha-tile');
            if (tileData) {
                const { hrid, sourceTabId } = JSON.parse(tileData);
                this._onTileDropOnTab(hrid, sourceTabId, tab.id);
                return;
            }
            // Otherwise handle tab reorder
            const draggedId = e.dataTransfer.getData('text/plain');
            if (draggedId && draggedId !== tab.id) this._onReorderTab(draggedId, tab.id);
        });

        const chevron = document.createElement('span');
        chevron.className = 'toolasha-ct-chevron';
        chevron.textContent = tab.open ? '▼' : '▶';
        header.appendChild(chevron);

        const name = document.createElement('span');
        name.className = 'toolasha-ct-section-name';
        name.textContent = tab.name;
        header.appendChild(name);

        const rightGroup = document.createElement('span');
        rightGroup.className = 'toolasha-ct-section-right';

        const configuredItemCount = tab.items.filter((h) => h !== LINEBREAK_HRID).length;
        if (configuredItemCount > 0) {
            const countBadge = document.createElement('span');
            countBadge.className = 'toolasha-ct-section-count';
            countBadge.textContent = `(${configuredItemCount})`;
            countBadge.title = tabItemCountTooltip(configuredItemCount);
            rightGroup.appendChild(countBadge);
        }

        header.appendChild(rightGroup);

        const actions = document.createElement('span');
        actions.className = 'toolasha-ct-section-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'toolasha-ct-node-btn';
        editBtn.textContent = '✏';
        editBtn.title = 'Edit tab';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openEditor(tab.id);
        });
        actions.appendChild(editBtn);

        const addSubBtn = document.createElement('button');
        addSubBtn.className = 'toolasha-ct-node-btn';
        addSubBtn.textContent = '+';
        addSubBtn.title = 'Add subtab';
        addSubBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onAddTab(tab.id);
        });
        actions.appendChild(addSubBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'toolasha-ct-node-btn';
        delBtn.textContent = '×';
        delBtn.title = 'Delete tab';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onDeleteTab(tab.id);
        });
        actions.appendChild(delBtn);

        header.appendChild(actions);
        header.addEventListener('click', () => {
            if (this._dragInProgress) return;
            this._onToggleTabOpen(tab.id, !tab.open);
        });

        invContainer.appendChild(header);
        this._injectedEls.push(header);

        if (tab.open) {
            const hasLineBreaks = tab.items.includes(LINEBREAK_HRID);
            const sectionTiles = [];

            if (hasLineBreaks) {
                // Inline assignment: preserve user-specified positions and line breaks.
                // Price-sort is intentionally skipped when line breaks are present, since
                // the user has explicitly arranged their items.
                let lbIndex = 0;
                for (const hrid of tab.items) {
                    if (hrid === LINEBREAK_HRID) {
                        const lb = document.createElement('div');
                        lb.className = 'toolasha-ct-linebreak';
                        lb.dataset.tabId = tab.id;
                        lb.dataset.lbIndex = String(lbIndex++);
                        lb.style.order = String(orderCounter++);
                        invContainer.appendChild(lb);
                        this._injectedEls.push(lb);
                    } else {
                        this._allClaimedHrids?.add(hrid);
                        for (const tile of this._claimTilesForHrid(hrid, tileMap)) {
                            tile.classList.add('toolasha-ct-visible');
                            tile.style.order = String(orderCounter++);
                            tile.dataset.toolashaTabId = tab.id;
                            this._setupTileDrag(tile);
                            sectionTiles.push(tile);
                        }
                    }
                }
            } else {
                // Collect all tiles, then sort by price and assign orders
                for (const hrid of tab.items) {
                    this._allClaimedHrids?.add(hrid);
                    for (const tile of this._claimTilesForHrid(hrid, tileMap)) sectionTiles.push(tile);
                }
            }

            // Warn when items are owned but missing from the DOM (collapsed game category).
            // Do NOT warn when the items simply aren't in the inventory.
            const realItems = tab.items.filter((h) => h !== LINEBREAK_HRID);
            if (realItems.length > 0 && sectionTiles.length === 0) {
                const ownedHrids = new Set(
                    (dataManager.getInventory() || [])
                        .filter((i) => i.itemLocationHrid === '/item_locations/inventory')
                        .map((i) => {
                            const base = i.itemHrid;
                            const lvl = i.enhancementLevel || 0;
                            return lvl > 0 ? `${base}+${lvl}` : base;
                        })
                );
                const anyOwned = realItems.some((hrid) => {
                    // Skip items already claimed by a higher tab — not a DOM issue
                    if (this._allClaimedHrids?.has(hrid)) return false;
                    if (ownedHrids.has(hrid)) return true;
                    // Base hrid matches any owned enhanced variant
                    if (!/\+\d+$/.test(hrid)) {
                        for (const owned of ownedHrids) {
                            if (owned.startsWith(hrid + '+')) return true;
                        }
                    }
                    return false;
                });
                if (anyOwned) {
                    const warn = document.createElement('span');
                    warn.textContent = '⚠';
                    warn.title =
                        'Items are hidden — expand the relevant categories in the Inventory tab to show them here.';
                    warn.style.cssText = 'color:#ff3333;margin-left:4px;cursor:default;font-size:13px;flex-shrink:0;';
                    const actionsEl = header.querySelector('.toolasha-ct-section-actions');
                    if (actionsEl) header.insertBefore(warn, actionsEl);
                    else header.appendChild(warn);
                }
            }

            // Sum badge values across all tiles in this section
            const valueKey = (() => {
                const mode = inventorySort.currentMode;
                if (mode === 'ask' || mode === 'bid') {
                    return config.getSetting('invSort_showBadges') ? mode + 'Value' : null;
                }
                if (mode === 'none') {
                    const badgesOnNone = config.getSettingValue('invSort_badgesOnNone', 'None');
                    return badgesOnNone !== 'None' ? badgesOnNone.toLowerCase() + 'Value' : null;
                }
                return null;
            })();
            if (valueKey) {
                const total = sectionTiles.reduce((sum, t) => sum + (parseFloat(t.dataset[valueKey]) || 0), 0);
                if (total > 0) {
                    const valueBadge = document.createElement('span');
                    valueBadge.className = 'toolasha-ct-section-value';
                    valueBadge.textContent = formatKMB(total, 2);
                    valueBadge.title = tabValueTooltip(valueKey, sectionTiles.length);
                    const rightEl = header.querySelector('.toolasha-ct-section-right');
                    if (rightEl) rightEl.appendChild(valueBadge);
                    else header.appendChild(valueBadge);
                }
            }

            // For sections without line breaks, sort tiles by price and assign orders now
            if (!hasLineBreaks) {
                orderCounter = this._assignTileOrders(sectionTiles, orderCounter, tab.id);
            }

            // Recurse into children
            if (tab.children.length > 0) {
                orderCounter = this._injectAccordionHeaders(
                    invContainer,
                    tab.children,
                    depth + 1,
                    tileMap,
                    orderCounter
                );
            }
        } else {
            // Collapsed — leave this tab's own items in tileMap so that any
            // sibling/parent open tab sharing those items can still display them.
            // Unorganized bucket already filters assigned items via getAssignedItemSet,
            // so we don't need to delete them here to keep them out of unorganized.
            // Children are still hidden (parent is closed), so remove them.

            // Show rolled-up value on the collapsed header (own items + all descendants)
            // Must peek BEFORE claiming tiles so values are still in the map.
            const valueKey = (() => {
                const mode = inventorySort.currentMode;
                if (mode === 'ask' || mode === 'bid') {
                    return config.getSetting('invSort_showBadges') ? mode + 'Value' : null;
                }
                if (mode === 'none') {
                    const badgesOnNone = config.getSettingValue('invSort_badgesOnNone', 'None');
                    return badgesOnNone !== 'None' ? badgesOnNone.toLowerCase() + 'Value' : null;
                }
                return null;
            })();
            if (valueKey) {
                const total = this._peekTileValue(tab, tileMap, valueKey);
                if (total > 0) {
                    const valueBadge = document.createElement('span');
                    valueBadge.className = 'toolasha-ct-section-value';
                    valueBadge.textContent = formatKMB(total, 2);
                    const rightEl = header.querySelector('.toolasha-ct-section-right');
                    if (rightEl) rightEl.appendChild(valueBadge);
                    else header.appendChild(valueBadge);
                }
            }

            // Consume own items so lower tabs cannot claim them (topmost-tab-wins priority)
            if (config.getSetting('inventoryTabs_topTabPriority')) {
                for (const hrid of tab.items) {
                    if (hrid !== LINEBREAK_HRID) {
                        this._claimTilesForHrid(hrid, tileMap);
                        this._allClaimedHrids?.add(hrid);
                    }
                }
            }

            this._removeTilesFromMapForChildren(tab.children, tileMap);
        }

        return orderCounter;
    }

    /**
     * Remove tiles from the tileMap for all descendant tabs (used when a parent is collapsed)
     * @param {Array} tabs
     * @param {Map} tileMap
     */
    _removeTilesFromMapForChildren(tabs, tileMap) {
        for (const tab of tabs) {
            for (const hrid of tab.items) this._claimTilesForHrid(hrid, tileMap);
            if (tab.children.length > 0) this._removeTilesFromMapForChildren(tab.children, tileMap);
        }
    }

    /**
     * Recursively sum a badge value across a tab's own items and all descendant tabs,
     * peeking at tileMap without claiming tiles.
     * Enhanced tiles are registered under both their base and +N keys (and an hrid can
     * repeat across parent/child tabs), so each tile is counted once via the seen set —
     * otherwise the collapsed rollup exceeds the expanded per-section totals.
     * @param {object} tab
     * @param {Map} tileMap
     * @param {string} valueKey - dataset key to sum (e.g. 'askValue', 'bidValue')
     * @param {Set<HTMLElement>} [seen] - tiles already counted in this rollup
     * @returns {number}
     */
    _peekTileValue(tab, tileMap, valueKey, seen = new Set()) {
        let total = 0;
        for (const hrid of tab.items) {
            if (hrid === LINEBREAK_HRID) continue;
            const tiles = tileMap.get(hrid);
            if (tiles) {
                for (const tile of tiles) {
                    if (seen.has(tile)) continue;
                    seen.add(tile);
                    total += parseFloat(tile.dataset[valueKey]) || 0;
                }
            }
        }
        for (const child of tab.children) {
            total += this._peekTileValue(child, tileMap, valueKey, seen);
        }
        return total;
    }

    /**
     * Mark tiles as visible and assign sequential CSS order values,
     * sorting by ask/bid value if inventory sort is active.
     * @param {HTMLElement[]} tiles
     * @param {number} startOrder
     * @param {string} [tabId] - Tab ID to stamp on tiles (empty string for unorganized)
     * @returns {number} next available order counter
     */
    _assignTileOrders(tiles, startOrder, tabId) {
        if (tiles.length === 0) return startOrder;

        const mode = inventorySort.currentMode;
        if (mode && mode !== 'none') {
            const valueKey = mode + 'Value';
            tiles.sort((a, b) => (parseFloat(b.dataset[valueKey]) || 0) - (parseFloat(a.dataset[valueKey]) || 0));
        }

        for (const tile of tiles) {
            tile.classList.add('toolasha-ct-visible');
            tile.style.order = startOrder++;
            if (tabId !== undefined) tile.dataset.toolashaTabId = tabId;
            this._setupTileDrag(tile);
        }
        return startOrder;
    }

    /**
     * Make a tile draggable and attach drag/drop event handlers.
     * Uses a WeakSet to prevent duplicate listeners (immune to layout resets).
     * @param {HTMLElement} tile
     */
    _setupTileDrag(tile) {
        tile.draggable = true;
        if (this._dragBoundTiles.has(tile)) return;
        this._dragBoundTiles.add(tile);

        tile.addEventListener('dragstart', (e) => {
            const hrid = this._getHridFromTile(tile);
            if (!hrid) return;
            const sourceTabId = tile.dataset.toolashaTabId || '';
            const payload = JSON.stringify({ hrid, sourceTabId });
            e.dataTransfer.setData('application/x-toolasha-tile', payload);
            e.dataTransfer.effectAllowed = 'move';
            tile.classList.add('toolasha-ct-tile-dragging');
            this._tileDragData = { hrid, sourceTabId };
        });

        tile.addEventListener('dragend', () => {
            tile.classList.remove('toolasha-ct-tile-dragging');
            this._tileDragData = null;
            // Clean up all drop indicators
            if (this._invContainer) {
                for (const el of this._invContainer.querySelectorAll(
                    '.toolasha-ct-drop-before, .toolasha-ct-drop-after, .toolasha-ct-tile-drop-target'
                )) {
                    el.classList.remove(
                        'toolasha-ct-drop-before',
                        'toolasha-ct-drop-after',
                        'toolasha-ct-tile-drop-target'
                    );
                }
            }
        });

        // Within-tab reorder: dragover on tiles
        tile.addEventListener('dragover', (e) => {
            if (!this._tileDragData) return;
            const targetTabId = tile.dataset.toolashaTabId || '';
            // Only allow reorder within the same tab (and not unorganized)
            if (!targetTabId || targetTabId !== this._tileDragData.sourceTabId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Determine left/right insertion based on cursor position
            const rect = tile.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            if (e.clientX < midX) {
                tile.classList.add('toolasha-ct-drop-before');
                tile.classList.remove('toolasha-ct-drop-after');
            } else {
                tile.classList.add('toolasha-ct-drop-after');
                tile.classList.remove('toolasha-ct-drop-before');
            }
        });

        tile.addEventListener('dragleave', () => {
            tile.classList.remove('toolasha-ct-drop-before', 'toolasha-ct-drop-after');
        });

        tile.addEventListener('drop', (e) => {
            e.preventDefault();
            tile.classList.remove('toolasha-ct-drop-before', 'toolasha-ct-drop-after');
            const raw = e.dataTransfer.getData('application/x-toolasha-tile');
            if (!raw) return;
            const { hrid: draggedHrid, sourceTabId } = JSON.parse(raw);
            const targetTabId = tile.dataset.toolashaTabId || '';
            if (!targetTabId || targetTabId !== sourceTabId) return;
            // Compute target index in items array from tile order position
            const targetHrid = this._getHridFromTile(tile);
            if (!targetHrid || targetHrid === draggedHrid) return;
            const rect = tile.getBoundingClientRect();
            const insertAfter = e.clientX >= rect.left + rect.width / 2;
            this._onTileReorder(targetTabId, draggedHrid, targetHrid, insertAfter);
        });
    }

    // -----------------------------------------------------------------------
    // Unorganized bucket
    // -----------------------------------------------------------------------

    /**
     * The tiles that belong in the Unorganized bucket — everything left in the
     * tile map that no tab has claimed — grouped by key, each physical tile
     * counted at most once.
     *
     * A tile is registered in the map under both its base hrid and its enhanced
     * `hrid+level` key (see {@link _buildTileMap}), so an unassigned enhanced item
     * is reachable through two keys. Without the `seenTiles` guard it is collected
     * twice: the "Unorganized (N)" header over-counts it and the tile is placed
     * twice. Base keys are inserted before their enhanced keys, so a deduped tile
     * stays grouped with its base item. Ported from upstream Celasha/Toolasha#627.
     *
     * @param {Map<string, HTMLElement[]>} tileMap - tiles not placed in any tab
     * @returns {Array<{hrid: string, tiles: HTMLElement[]}>} deduped unorganized entries
     */
    _collectUnassignedTileEntries(tileMap) {
        const assignedSet = getAssignedItemSet(this._config);
        const remainingEntries = [];
        const seenTiles = new Set();
        for (const [hrid, tiles] of tileMap) {
            if (/\+\d+$/.test(hrid)) {
                // Enhanced key still present means no tab claimed it; skip only if
                // the exact enhanced hrid is assigned to a tab.
                if (assignedSet.has(hrid)) continue;
                const fresh = tiles.filter((tile) => !seenTiles.has(tile));
                if (fresh.length > 0) {
                    for (const tile of fresh) seenTiles.add(tile);
                    remainingEntries.push({ hrid, tiles: fresh });
                }
            } else {
                // Base key: skip if the base hrid is assigned; otherwise keep only
                // the tiles whose specific enhancement level is not assigned.
                if (assignedSet.has(hrid)) continue;
                const unassignedTiles = tiles.filter((tile) => {
                    if (seenTiles.has(tile)) return false;
                    const enhEl = tile.querySelector('[class*="Item_enhancementLevel"]');
                    const level = enhEl ? parseInt(enhEl.textContent.trim().replace('+', ''), 10) : 0;
                    const tileHrid = level > 0 ? `${hrid}+${level}` : hrid;
                    return !assignedSet.has(tileHrid);
                });
                if (unassignedTiles.length > 0) {
                    for (const tile of unassignedTiles) seenTiles.add(tile);
                    remainingEntries.push({ hrid, tiles: unassignedTiles });
                }
            }
        }
        return remainingEntries;
    }

    /**
     * Inject the unorganized bucket header and show unassigned tiles
     * @param {HTMLElement} invContainer
     * @param {Map} tileMap - remaining tiles not placed in any tab
     * @param {number} orderCounter
     * @returns {number} updated orderCounter
     */
    _injectUnorganized(invContainer, tileMap, orderCounter) {
        const remainingEntries = this._collectUnassignedTileEntries(tileMap);
        if (remainingEntries.length === 0) return orderCounter;

        const totalTiles = remainingEntries.reduce((sum, e) => sum + e.tiles.length, 0);

        const headerEl = document.createElement('div');
        headerEl.className = 'toolasha-ct-unorg-header';
        headerEl.innerHTML = `<span>${this._unorgOpen ? '▼' : '▶'}</span> <span>Unorganized (${totalTiles})</span>`;
        headerEl.style.order = orderCounter++;
        headerEl.addEventListener('click', () => {
            this._unorgOpen = !this._unorgOpen;
            headerEl.querySelector('span').textContent = this._unorgOpen ? '▼' : '▶';
            this._applyLayout();
        });
        // Drop target: remove item from its tab (return to unorganized)
        headerEl.addEventListener('dragover', (e) => {
            if (!this._tileDragData || !this._tileDragData.sourceTabId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            headerEl.classList.add('toolasha-ct-tile-drop-target');
        });
        headerEl.addEventListener('dragleave', () => {
            headerEl.classList.remove('toolasha-ct-tile-drop-target');
        });
        headerEl.addEventListener('drop', (e) => {
            e.preventDefault();
            headerEl.classList.remove('toolasha-ct-tile-drop-target');
            const raw = e.dataTransfer.getData('application/x-toolasha-tile');
            if (!raw) return;
            const { hrid, sourceTabId } = JSON.parse(raw);
            this._onTileDropOnUnorganized(hrid, sourceTabId);
        });
        invContainer.appendChild(headerEl);
        this._injectedEls.push(headerEl);

        if (this._unorgOpen) {
            // Sort remaining entries by category sortIndex then item sortIndex
            const initData = dataManager.getInitClientData();
            const itemDetailMap = initData?.itemDetailMap || {};
            const categoryDetailMap = initData?.itemCategoryDetailMap || {};
            remainingEntries.sort((a, b) => {
                const baseA = a.hrid.replace(/\+\d+$/, '');
                const baseB = b.hrid.replace(/\+\d+$/, '');
                const detA = itemDetailMap[baseA];
                const detB = itemDetailMap[baseB];
                const catSortA = categoryDetailMap[detA?.categoryHrid]?.sortIndex ?? 9999;
                const catSortB = categoryDetailMap[detB?.categoryHrid]?.sortIndex ?? 9999;
                if (catSortA !== catSortB) return catSortA - catSortB;
                const itemSortA = detA?.sortIndex ?? 9999;
                const itemSortB = detB?.sortIndex ?? 9999;
                return itemSortA - itemSortB;
            });
            const unorgTiles = remainingEntries.flatMap(({ tiles }) => tiles);
            orderCounter = this._assignTileOrders(unorgTiles, orderCounter, '');
        }

        return orderCounter;
    }

    // -----------------------------------------------------------------------
    // Tile drag & drop action handlers
    // -----------------------------------------------------------------------

    /**
     * Handle a tile dropped onto a tab header (add or move item to that tab)
     * @param {string} hrid
     * @param {string} sourceTabId - empty string if from unorganized
     * @param {string} targetTabId
     */
    async _onTileDropOnTab(hrid, sourceTabId, targetTabId) {
        if (sourceTabId === targetTabId) return;
        let newConfig;
        if (!sourceTabId) {
            // From unorganized → add to target tab
            newConfig = addItem(this._config, targetTabId, hrid);
        } else {
            // From another tab → move
            newConfig = moveItem(this._config, sourceTabId, targetTabId, hrid);
        }
        this._config = newConfig;
        this._removeInjectedEls();
        this._applyLayout();
        this._save().catch((error) => {
            console.error('[CustomTabs] Failed to persist tile drop on tab:', error);
        });
    }

    /**
     * Handle a tile dropped onto the unorganized header (remove from tab)
     * @param {string} hrid
     * @param {string} sourceTabId
     */
    async _onTileDropOnUnorganized(hrid, sourceTabId) {
        if (!sourceTabId) return;
        const newConfig = removeItem(this._config, sourceTabId, hrid);
        this._config = newConfig;
        this._removeInjectedEls();
        this._applyLayout();
        this._save().catch((error) => {
            console.error('[CustomTabs] Failed to persist tile drop on unorganized:', error);
        });
    }

    /**
     * Handle a tile reordered within its tab via drag & drop
     * @param {string} tabId
     * @param {string} draggedHrid
     * @param {string} targetHrid
     * @param {boolean} insertAfter - true to insert after target, false for before
     */
    async _onTileReorder(tabId, draggedHrid, targetHrid, insertAfter) {
        if (draggedHrid === targetHrid) return;
        const result = findTab(this._config, tabId);
        if (!result) return;
        const items = result.tab.items;
        // Find indices (skip LINEBREAK_HRID for matching, but preserve them in array)
        const fromIndex = items.indexOf(draggedHrid);
        const targetIndex = items.indexOf(targetHrid);
        if (fromIndex === -1 || targetIndex === -1) return;
        // Calculate destination: after removing source, where does target land?
        let toIndex = targetIndex;
        if (insertAfter) toIndex++;
        // If dragging forward, adjust for removal shift
        if (fromIndex < toIndex) toIndex--;
        const newConfig = reorderItem(this._config, tabId, fromIndex, toIndex);
        this._config = newConfig;
        this._removeInjectedEls();
        this._applyLayout();
        this._save().catch((error) => {
            console.error('[CustomTabs] Failed to persist tile reorder:', error);
        });
    }

    // -----------------------------------------------------------------------
    // Tab editor modal
    // -----------------------------------------------------------------------

    _openEditor(tabId) {
        this._editorTabId = tabId;
        this._deleteConfirmId = null;
        this._expandedSearchHrids = new Set();
        const result = findTab(this._config, tabId);
        if (!result) return;
        const tab = result.tab;

        const overlay = document.createElement('div');
        overlay.className = 'toolasha-ct-modal-overlay';
        let mousedownOnOverlay = false;
        overlay.addEventListener('mousedown', (e) => {
            mousedownOnOverlay = e.target === overlay;
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && mousedownOnOverlay) {
                overlay.remove();
                this._removeInjectedEls();
                this._applyLayout();
            }
        });

        const modal = document.createElement('div');
        modal.className = 'toolasha-ct-modal';

        modal.innerHTML = `
            <div class="toolasha-ct-modal-body">
                <h3>Edit Tab</h3>
                <label>Name</label>
                <input type="text" class="toolasha-ct-editor-name" value="${this._escHtml(tab.name)}">

                <label>Color</label>
                <div class="toolasha-ct-swatches"></div>

                <label>Add Category <span class="toolasha-ct-addall-label"><input type="checkbox" class="toolasha-ct-addall-cb"${config.getSetting('inventoryTabs_categoryAddAll') ? ' checked' : ''}> All items</span></label>
                <div class="toolasha-ct-categories"></div>

                <label>From Loadout</label>
                <div class="toolasha-ct-loadouts"></div>

                <label>Items</label>
                <div class="toolasha-ct-search-row">
                    <input type="search" class="toolasha-ct-editor-search" placeholder="Search items to add...">
                    <select class="toolasha-ct-cat-filter toolasha-select">
                        <option value="">All</option>
                    </select>
                </div>
                <div class="toolasha-ct-search-results"></div>
                <div class="toolasha-ct-assigned-list"></div>
                <div style="margin-top:6px;">
                    <button class="toolasha-ct-add-linebreak-btn" style="background:#2a2a3a;color:#888;border:1px solid #444;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;">+ Line Break</button>
                </div>
            </div>

            <div class="toolasha-ct-modal-footer">
                <button class="toolasha-ct-delete-btn">Delete Tab</button>
                <button class="toolasha-ct-clear-btn">Clear All</button>
                <button class="toolasha-ct-close-btn">Close</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const nameInput = modal.querySelector('.toolasha-ct-editor-name');
        nameInput.focus();
        nameInput.addEventListener('change', () => {
            this._config = renameTab(this._config, tabId, nameInput.value.trim() || 'Untitled');
            this._save();
        });

        const swatchContainer = modal.querySelector('.toolasha-ct-swatches');
        const isPreset = (color) => color === null || COLOR_PRESETS.includes(color);

        const applyColor = (color) => {
            this._config = setTabColor(this._config, tabId, color);
            this._save();
            this._applyLayout();
        };

        const updateActiveStates = (activeColor) => {
            swatchContainer.querySelectorAll('.toolasha-ct-swatch').forEach((s) => {
                s.classList.toggle('toolasha-ct-swatch--active', s.dataset.color === (activeColor ?? '__null__'));
            });
            colorPicker.classList.toggle('toolasha-ct-color-picker--active', !!activeColor && !isPreset(activeColor));
        };

        // Preset swatches (null = clear)
        for (const color of [null, ...COLOR_PRESETS]) {
            const sw = document.createElement('span');
            sw.className = 'toolasha-ct-swatch';
            sw.dataset.color = color ?? '__null__';
            sw.style.background = color || '#555';
            if (!color) {
                sw.textContent = '×';
                sw.style.textAlign = 'center';
                sw.style.lineHeight = '18px';
                sw.style.fontSize = '12px';
            }
            sw.addEventListener('click', () => {
                applyColor(color);
                colorPicker.value = color || '#555555';
                hexInput.value = color || '';
                updateActiveStates(color);
            });
            swatchContainer.appendChild(sw);
        }

        // Divider
        const divider = document.createElement('span');
        divider.className = 'toolasha-ct-swatch-divider';
        swatchContainer.appendChild(divider);

        // Native color picker
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.className = 'toolasha-ct-color-picker';
        colorPicker.title = 'Custom color';
        colorPicker.value = tab.color && tab.color.startsWith('#') ? tab.color : '#888888';
        colorPicker.addEventListener('input', () => {
            const hex = colorPicker.value;
            hexInput.value = hex;
            applyColor(hex);
            updateActiveStates(hex);
        });
        swatchContainer.appendChild(colorPicker);

        // Hex text input
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.className = 'toolasha-ct-hex-input';
        hexInput.placeholder = '#rrggbb';
        hexInput.maxLength = 7;
        hexInput.value = tab.color || '';
        hexInput.addEventListener('input', () => {
            const val = hexInput.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                colorPicker.value = val;
                applyColor(val);
                updateActiveStates(val);
            }
        });
        swatchContainer.appendChild(hexInput);

        // Set initial active state
        updateActiveStates(tab.color);

        this._renderCategoryButtons(modal.querySelector('.toolasha-ct-categories'), tabId);

        const addAllCb = modal.querySelector('.toolasha-ct-addall-cb');
        addAllCb.addEventListener('change', () => {
            config.setSetting('inventoryTabs_categoryAddAll', addAllCb.checked);
            this._renderCategoryButtons(modal.querySelector('.toolasha-ct-categories'), tabId);
        });

        this._renderLoadoutButtons(modal.querySelector('.toolasha-ct-loadouts'), tabId);
        this._populateCategoryFilter(modal.querySelector('.toolasha-ct-cat-filter'));

        const searchInput = modal.querySelector('.toolasha-ct-editor-search');
        const catFilter = modal.querySelector('.toolasha-ct-cat-filter');
        const resultsDiv = modal.querySelector('.toolasha-ct-search-results');
        let searchTimeout = null;
        const doSearch = () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this._renderSearchResults(resultsDiv, searchInput.value.trim(), tabId, catFilter.value);
            }, 150);
        };
        searchInput.addEventListener('input', doSearch);
        catFilter.addEventListener('change', doSearch);

        this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);

        modal.querySelector('.toolasha-ct-add-linebreak-btn').addEventListener('click', () => {
            this._config = addLineBreak(this._config, tabId);
            this._save();
            this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);
            if (this._isActive) this._applyLayout();
        });

        const deleteBtn = modal.querySelector('.toolasha-ct-delete-btn');
        deleteBtn.addEventListener('click', () => {
            if (this._deleteConfirmId === tabId) {
                this._config = removeTab(this._config, tabId);
                this._save();
                overlay.remove();
                this._removeInjectedEls();
                this._applyLayout();
            } else {
                this._deleteConfirmId = tabId;
                deleteBtn.textContent = 'Confirm Delete?';
                deleteBtn.style.background = '#a03030';
            }
        });

        let clearConfirm = false;
        const clearBtn = modal.querySelector('.toolasha-ct-clear-btn');
        clearBtn.addEventListener('click', () => {
            if (clearConfirm) {
                const currentTab = findTab(this._config, tabId)?.tab;
                if (currentTab) {
                    for (const hrid of [...currentTab.items]) {
                        this._config = removeItem(this._config, tabId, hrid);
                    }
                    this._save();
                    this._renderCategoryButtons(modal.querySelector('.toolasha-ct-categories'), tabId);
                    this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);
                    if (this._isActive) this._applyLayout();
                }
                clearBtn.textContent = 'Clear All';
                clearBtn.style.background = '';
                clearConfirm = false;
            } else {
                clearConfirm = true;
                clearBtn.textContent = 'Confirm Clear?';
                clearBtn.style.background = '#6a3a00';
            }
        });

        modal.querySelector('.toolasha-ct-close-btn').addEventListener('click', () => {
            overlay.remove();
            this._removeInjectedEls();
            this._applyLayout();
        });
    }

    _renderSearchResults(container, query, tabId, categoryFilter) {
        container.innerHTML = '';
        if ((!query || query.length < 2) && !categoryFilter) return;

        const initData = dataManager.getInitClientData();
        if (!initData?.itemDetailMap) return;

        const lowerQuery = query ? query.toLowerCase() : '';
        const currentTab = findTab(this._config, tabId)?.tab;
        const currentItems = new Set(currentTab?.items || []);
        // Build map: baseHrid → Set<enhancementLevel> from current inventory
        const levelMap = new Map();
        for (const item of dataManager.getInventory() || []) {
            if (item.itemLocationHrid === '/item_locations/inventory') {
                if (!levelMap.has(item.itemHrid)) levelMap.set(item.itemHrid, new Set());
                levelMap.get(item.itemHrid).add(item.enhancementLevel || 0);
            }
        }

        let count = 0;

        for (const [hrid, details] of Object.entries(initData.itemDetailMap)) {
            if (count >= 30) break;
            if (!details.name) continue;
            if (currentItems.has(hrid)) continue;
            if (categoryFilter && details.categoryHrid !== categoryFilter) continue;
            if (lowerQuery && !details.name.toLowerCase().includes(lowerQuery)) continue;

            const iconId = hrid.replace('/items/', '');
            const spriteUrl = getSpriteBaseUrl();
            const iconHref = spriteUrl ? `${spriteUrl}#${iconId}` : `#${iconId}`;

            const ownedLevels = levelMap.get(hrid);
            const maxLevel = details.equipmentDetail ? 20 : 0;
            const isExpandable = maxLevel > 0;
            const isExpanded = this._expandedSearchHrids?.has(hrid);

            if (isExpandable) {
                if (isExpanded) {
                    // Collapse header row
                    const headerRow = document.createElement('div');
                    headerRow.className = 'toolasha-ct-search-result toolasha-ct-search-group-header';
                    headerRow.innerHTML = `<svg viewBox="0 0 32 32"><use href="${iconHref}"></use></svg><span>${this._escHtml(details.name)}</span><span class="toolasha-ct-expand-btn">▲</span>`;
                    headerRow.addEventListener('click', () => {
                        this._expandedSearchHrids.delete(hrid);
                        this._renderSearchResults(container, query, tabId, categoryFilter);
                    });
                    container.appendChild(headerRow);

                    // "Add all levels" shortcut row
                    const addAllRow = document.createElement('div');
                    addAllRow.className = 'toolasha-ct-search-result toolasha-ct-search-level-row';
                    addAllRow.innerHTML = `<span style="color:#7dcea0;font-size:12px;padding-left:4px;">+ Add all levels (+0–+${maxLevel})</span>`;
                    addAllRow.addEventListener('click', () => {
                        for (let level = 0; level <= maxLevel; level++) {
                            const levelHrid = level === 0 ? hrid : `${hrid}+${level}`;
                            if (!currentItems.has(levelHrid)) {
                                this._config = addItem(this._config, tabId, levelHrid);
                            }
                        }
                        this._save();
                        this._renderSearchResults(container, query, tabId, categoryFilter);
                        this._renderAssignedItems(
                            container.parentElement.querySelector('.toolasha-ct-assigned-list'),
                            tabId
                        );
                        if (this._isActive) this._applyLayout();
                    });
                    container.appendChild(addAllRow);

                    // All levels 0–maxLevel; mark owned with a dot
                    for (let level = 0; level <= maxLevel; level++) {
                        const levelHrid = level === 0 ? hrid : `${hrid}+${level}`;
                        if (currentItems.has(levelHrid)) continue;

                        const owned = ownedLevels?.has(level);
                        const levelRow = document.createElement('div');
                        levelRow.className = 'toolasha-ct-search-result toolasha-ct-search-level-row';
                        const displayName = level === 0 ? details.name : `${details.name} +${level}`;
                        const ownedDot = owned
                            ? `<span style="color:#7dcea0;margin-left:4px;" title="In inventory">●</span>`
                            : '';
                        levelRow.innerHTML = `<svg viewBox="0 0 32 32"><use href="${iconHref}"></use></svg><span>${this._escHtml(displayName)}</span>${ownedDot}`;
                        levelRow.addEventListener('click', () => {
                            this._config = addItem(this._config, tabId, levelHrid);
                            this._save();
                            this._renderSearchResults(container, query, tabId, categoryFilter);
                            this._renderAssignedItems(
                                container.parentElement.querySelector('.toolasha-ct-assigned-list'),
                                tabId
                            );
                            if (this._isActive) this._applyLayout();
                        });
                        container.appendChild(levelRow);
                    }
                } else {
                    // Collapsed group row — clicking name adds base item, ▶ expands to show levels
                    const ownedBadges = ownedLevels
                        ? [...ownedLevels]
                              .sort((a, b) => a - b)
                              .map((l) => `+${l}`)
                              .join(' ')
                        : '';

                    const row = document.createElement('div');
                    row.className = 'toolasha-ct-search-result toolasha-ct-search-group-header';
                    row.innerHTML = `<svg viewBox="0 0 32 32"><use href="${iconHref}"></use></svg><span>${this._escHtml(details.name)}</span>${ownedBadges ? `<span class="toolasha-ct-level-badges">${this._escHtml(ownedBadges)}</span>` : ''}<span class="toolasha-ct-expand-btn">▶</span>`;
                    // Clicking the expand button expands the group
                    row.querySelector('.toolasha-ct-expand-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (!this._expandedSearchHrids) this._expandedSearchHrids = new Set();
                        this._expandedSearchHrids.add(hrid);
                        this._renderSearchResults(container, query, tabId, categoryFilter);
                    });
                    // Clicking the item name/icon adds the base (unenhanced) item
                    row.addEventListener('click', () => {
                        this._config = addItem(this._config, tabId, hrid);
                        this._save();
                        this._renderSearchResults(container, query, tabId, categoryFilter);
                        this._renderAssignedItems(
                            container.parentElement.querySelector('.toolasha-ct-assigned-list'),
                            tabId
                        );
                        if (this._isActive) this._applyLayout();
                    });
                    container.appendChild(row);
                }
            } else {
                // Flat row — no enhanced variants in inventory
                const row = document.createElement('div');
                row.className = 'toolasha-ct-search-result';
                row.innerHTML = `<svg viewBox="0 0 32 32"><use href="${iconHref}"></use></svg><span>${this._escHtml(details.name)}</span>`;
                row.addEventListener('click', () => {
                    this._config = addItem(this._config, tabId, hrid);
                    this._save();
                    row.remove();
                    this._renderAssignedItems(
                        container.parentElement.querySelector('.toolasha-ct-assigned-list'),
                        tabId
                    );
                    if (this._isActive) this._applyLayout();
                });
                container.appendChild(row);
            }

            count++;
        }

        if (count === 0) {
            container.innerHTML = '<div style="color:#666;padding:6px;font-size:12px;">No matching items found</div>';
        }
    }

    _renderAssignedItems(container, tabId) {
        const scrollParent = container.closest('.toolasha-ct-modal-body');
        const scrollPos = scrollParent?.scrollTop ?? 0;

        container.innerHTML = '';
        const tab = findTab(this._config, tabId)?.tab;
        if (!tab || tab.items.length === 0) {
            container.innerHTML = '<div style="color:#555;font-size:12px;padding:4px;">No items assigned</div>';
            if (scrollParent) scrollParent.scrollTop = scrollPos;
            return;
        }

        let dragFromIndex = null;

        tab.items.forEach((hrid, index) => {
            const row = document.createElement('div');
            row.className = 'toolasha-ct-assigned-item';
            row.draggable = true;

            const handle = document.createElement('span');
            handle.className = 'toolasha-ct-drag-handle';
            handle.textContent = '⠿';
            row.appendChild(handle);

            if (hrid === LINEBREAK_HRID) {
                const label = document.createElement('span');
                label.textContent = '─── Line Break ───';
                label.style.cssText = 'color:#555;font-style:italic;font-size:11px;flex:1;text-align:center;';
                row.appendChild(label);
            } else {
                const enhanceMatch = hrid.match(/\+(\d+)$/);
                const baseHrid = enhanceMatch ? hrid.slice(0, hrid.length - enhanceMatch[0].length) : hrid;
                const level = enhanceMatch ? parseInt(enhanceMatch[1], 10) : 0;
                const details = dataManager.getItemDetails(baseHrid);
                const baseName = details?.name || baseHrid;
                const name = level > 0 ? `${baseName} +${level}` : baseName;
                const iconId = baseHrid.replace('/items/', '');
                const spriteUrl = getSpriteBaseUrl();
                const iconHref = spriteUrl ? `${spriteUrl}#${iconId}` : `#${iconId}`;

                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.setAttribute('viewBox', '0 0 32 32');
                icon.innerHTML = `<use href="${iconHref}"></use>`;
                row.appendChild(icon);

                const label = document.createElement('span');
                label.textContent = name;
                row.appendChild(label);
            }

            row.addEventListener('dragstart', (e) => {
                dragFromIndex = index;
                e.dataTransfer.effectAllowed = 'move';
                row.style.opacity = '0.4';
            });
            row.addEventListener('dragend', () => {
                row.style.opacity = '';
                container
                    .querySelectorAll('.toolasha-ct-drag-over')
                    .forEach((el) => el.classList.remove('toolasha-ct-drag-over'));
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                container
                    .querySelectorAll('.toolasha-ct-drag-over')
                    .forEach((el) => el.classList.remove('toolasha-ct-drag-over'));
                row.classList.add('toolasha-ct-drag-over');
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('toolasha-ct-drag-over');
            });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('toolasha-ct-drag-over');
                if (dragFromIndex !== null && dragFromIndex !== index) {
                    this._config = reorderItem(this._config, tabId, dragFromIndex, index);
                    this._save();
                    this._renderAssignedItems(container, tabId);
                    if (this._isActive) this._applyLayout();
                }
                dragFromIndex = null;
            });

            const toTopBtn = document.createElement('button');
            toTopBtn.className = 'toolasha-ct-node-btn';
            toTopBtn.textContent = '⇈';
            toTopBtn.title = 'Move to top';
            toTopBtn.style.marginLeft = '0';
            if (index === 0) {
                toTopBtn.style.visibility = 'hidden';
            } else {
                toTopBtn.addEventListener('click', () => {
                    this._config = reorderItem(this._config, tabId, index, 0);
                    this._save();
                    this._renderAssignedItems(container, tabId);
                    if (this._isActive) this._applyLayout();
                });
            }
            row.appendChild(toTopBtn);

            const toBottomBtn = document.createElement('button');
            toBottomBtn.className = 'toolasha-ct-node-btn';
            toBottomBtn.textContent = '⇊';
            toBottomBtn.title = 'Move to bottom';
            toBottomBtn.style.marginLeft = '0';
            if (index >= tab.items.length - 1) {
                toBottomBtn.style.visibility = 'hidden';
            } else {
                toBottomBtn.addEventListener('click', () => {
                    this._config = reorderItem(this._config, tabId, index, tab.items.length - 1);
                    this._save();
                    this._renderAssignedItems(container, tabId);
                    if (this._isActive) this._applyLayout();
                });
            }
            row.appendChild(toBottomBtn);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'toolasha-ct-node-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => {
                this._config = removeItemAtIndex(this._config, tabId, index);
                // Clean item from loadout bindings so it won't be re-added on sync
                if (hrid !== LINEBREAK_HRID) {
                    this._config = removeItemFromBindings(this._config, tabId, hrid);
                }
                this._save();
                this._renderAssignedItems(container, tabId);
                if (this._isActive) this._applyLayout();
            });
            row.appendChild(removeBtn);
            container.appendChild(row);
        });

        if (scrollParent) scrollParent.scrollTop = scrollPos;
    }

    // -----------------------------------------------------------------------
    // Category helpers
    // -----------------------------------------------------------------------

    _getCategories() {
        const initData = dataManager.getInitClientData();
        if (!initData?.itemCategoryDetailMap) return [];
        const categories = [];
        for (const [hrid, detail] of Object.entries(initData.itemCategoryDetailMap)) {
            if (detail?.name) categories.push({ hrid, name: detail.name, sortIndex: detail.sortIndex ?? 9999 });
        }
        return categories.sort((a, b) => a.sortIndex - b.sortIndex);
    }

    _getItemsInCategory(categoryHrid) {
        const initData = dataManager.getInitClientData();
        if (!initData?.itemDetailMap) return [];
        const addAllItems = config.getSettingValue('inventoryTabs_categoryAddAll');
        const ownedHrids = addAllItems ? null : this._getOwnedItemHrids();
        const items = [];
        for (const [hrid, details] of Object.entries(initData.itemDetailMap)) {
            if (details.categoryHrid === categoryHrid) {
                if (!ownedHrids || ownedHrids.has(hrid)) items.push({ hrid, sortIndex: details.sortIndex ?? 9999 });
            }
        }
        items.sort((a, b) => a.sortIndex - b.sortIndex);
        return items.map((item) => item.hrid);
    }

    _getOwnedItemHrids() {
        const inventory = dataManager.getInventory() || [];
        const set = new Set();
        for (const item of inventory) {
            if (item.itemLocationHrid === '/item_locations/inventory') {
                set.add(item.itemHrid);
                if (item.enhancementLevel > 0) {
                    set.add(`${item.itemHrid}+${item.enhancementLevel}`);
                }
            }
        }
        return set;
    }

    _renderCategoryButtons(container, tabId) {
        container.innerHTML = '';
        const categories = this._getCategories();
        const currentTab = findTab(this._config, tabId)?.tab;
        const currentItems = new Set(currentTab?.items || []);

        for (const cat of categories) {
            const catItems = this._getItemsInCategory(cat.hrid);
            if (catItems.length === 0) continue;

            const allAlreadyAdded = catItems.every((hrid) => currentItems.has(hrid));
            const btn = document.createElement('button');
            btn.className = 'toolasha-ct-cat-btn' + (allAlreadyAdded ? ' toolasha-ct-cat-btn--added' : '');
            btn.textContent = cat.name;
            btn.title = allAlreadyAdded
                ? `Click to remove ${catItems.length} items from ${cat.name}`
                : `Add ${catItems.length} items from ${cat.name}`;

            if (allAlreadyAdded) {
                btn.addEventListener('click', () => {
                    for (const hrid of catItems) {
                        if (currentItems.has(hrid)) {
                            this._config = removeItem(this._config, tabId, hrid);
                            currentItems.delete(hrid);
                        }
                    }
                    this._save();
                    this._renderCategoryButtons(container, tabId);
                    const modal = container.closest('.toolasha-ct-modal');
                    if (modal) this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);
                    if (this._isActive) this._applyLayout();
                });
            } else {
                btn.addEventListener('click', () => {
                    for (const hrid of catItems) {
                        if (!currentItems.has(hrid)) {
                            this._config = addItem(this._config, tabId, hrid);
                            currentItems.add(hrid);
                        }
                    }
                    this._save();
                    this._renderCategoryButtons(container, tabId);
                    const modal = container.closest('.toolasha-ct-modal');
                    if (modal) this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);
                    if (this._isActive) this._applyLayout();
                });
            }
            container.appendChild(btn);
        }
    }

    /**
     * Check if any changed items have a higher enhancement level than what's in bindings.
     * Runs on every items_updated tick but only does cheap Set lookups for the changed items.
     * @param {Object} data - The items_updated event data
     */
    _checkBindingEnhancements(data) {
        // Reads `dataManager.characterItems` — the CURRENT character's inventory —
        // and rewrites bindings in `_config`. Across a switch that is one
        // character's equipment levels written into another's tabs, so it waits
        // for the reload rather than running against a mismatched pair.
        if (!this._isConfigForCurrentCharacter()) return;

        const changedItems = data?.endCharacterItems;
        if (!changedItems || changedItems.length === 0) return;

        // Build set of bound base HRIDs and their current enhancement levels
        if (!this._boundBaseHrids) this._rebuildBoundBaseHrids();
        if (this._boundBaseHrids.size === 0) return;

        // Collect unique base HRIDs from the changed items that match bindings
        const relevantBases = new Set();
        for (const item of changedItems) {
            if (!item.itemHrid) continue;
            if (this._boundBaseHrids.has(item.itemHrid)) {
                relevantBases.add(item.itemHrid);
            }
        }
        if (relevantBases.size === 0) return;

        const inventory = dataManager.characterItems || [];
        let anyChanged = false;
        const loadoutSnapshot = getLoadoutSnapshot();
        const snapshots = loadoutSnapshot.snapshots || {};

        for (const baseHrid of relevantBases) {
            // Cache may have been invalidated by a prior iteration's snapshot update
            if (!this._boundBaseHrids) break;
            const loadoutLevels = this._boundBaseHrids.get(baseHrid);
            if (!loadoutLevels) continue;

            // Find highest enhancement level of this item in current inventory (computed once per base)
            // Equipped copies don't reliably carry a count field the way stacked
            // inventory items do — requiring count > 0 dropped them, so enhancing
            // the worn copy synced bindings (and the snapshot's stored level) to a
            // lower duplicate in the bag instead. Skip only an explicit zero (a
            // consumed stack), matching highestOwnedEnhancements in loadout-snapshot.
            let highestOwned = -1;
            for (const item of inventory) {
                if (item.itemHrid === baseHrid && item.count !== 0) {
                    const level = item.enhancementLevel || 0;
                    if (level > highestOwned) highestOwned = level;
                }
            }

            // If player owns none, skip (don't remove — they might just be mid-trade)
            if (highestOwned < 0) continue;

            // Process each loadout binding independently — exact-mode loadouts stay
            // frozen, highest-mode loadouts update to the highest owned level.
            for (const [loadoutName, currentLevel] of loadoutLevels) {
                const snap = Object.values(snapshots).find((s) => s.name === loadoutName);
                if (!snap || snap.useExactEnhancement) continue;
                if (highestOwned === currentLevel) continue;

                const oldHrid = currentLevel > 0 ? `${baseHrid}+${currentLevel}` : baseHrid;
                const newHrid = highestOwned > 0 ? `${baseHrid}+${highestOwned}` : baseHrid;

                this._walkAndSwapBinding(oldHrid, newHrid, loadoutName);
                anyChanged = true;

                // Update cached level for this specific loadout (cache may have been
                // nulled by the snapshot update listener below).
                if (this._boundBaseHrids) {
                    this._boundBaseHrids.get(baseHrid)?.set(loadoutName, highestOwned);
                }
            }

            // Sync snapshot equipment levels — updateEnhancementLevel skips exact-mode
            // snapshots internally, so it only touches highest-mode ones.
            loadoutSnapshot.updateEnhancementLevel(baseHrid, highestOwned);
        }

        if (anyChanged) {
            this._save();
            if (this._isActive) this._applyLayout();
        }
    }

    /**
     * Build a Map of baseHrid → Map<loadoutName, currentLevel> across all bindings.
     * Per-loadout granularity lets us update each binding independently based on
     * its own snapshot's useExactEnhancement flag. Cached and invalidated when
     * bindings change.
     */
    _rebuildBoundBaseHrids() {
        this._boundBaseHrids = new Map(); // baseHrid → Map<loadoutName, currentLevel>
        const walk = (tabs) => {
            for (const tab of tabs) {
                if (tab.loadoutBindings) {
                    for (const [loadoutName, items] of Object.entries(tab.loadoutBindings)) {
                        for (const hrid of items) {
                            const base = getBaseHrid(hrid);
                            const plusIdx = hrid.lastIndexOf('+');
                            const level =
                                plusIdx !== -1 && /^\d+$/.test(hrid.substring(plusIdx + 1))
                                    ? parseInt(hrid.substring(plusIdx + 1), 10)
                                    : 0;
                            if (!this._boundBaseHrids.has(base)) {
                                this._boundBaseHrids.set(base, new Map());
                            }
                            const loadoutLevels = this._boundBaseHrids.get(base);
                            const existing = loadoutLevels.get(loadoutName) ?? -1;
                            if (level > existing) loadoutLevels.set(loadoutName, level);
                        }
                    }
                }
                if (tab.children.length > 0) walk(tab.children);
            }
        };
        walk(this._config.tabs);
    }

    /**
     * Swap an old HRID for a new one in all loadout bindings across all tabs.
     * @param {string} oldHrid
     * @param {string} newHrid
     */
    /**
     * Swap an old HRID for a new one in loadout bindings across all tabs.
     * @param {string} oldHrid
     * @param {string} newHrid
     * @param {string|null} restrictToLoadoutName - When set, only swap inside
     *   bindings for this loadout. tab.items is swapped only if no other
     *   loadout on the same tab still references oldHrid.
     */
    _walkAndSwapBinding(oldHrid, newHrid, restrictToLoadoutName = null) {
        const walk = (tabs) => {
            for (const tab of tabs) {
                if (tab.loadoutBindings) {
                    let swappedInLoadout = false;
                    let oldHridStillReferenced = false;
                    for (const [name, items] of Object.entries(tab.loadoutBindings)) {
                        if (restrictToLoadoutName && name !== restrictToLoadoutName) {
                            if (items.includes(oldHrid)) oldHridStillReferenced = true;
                            continue;
                        }
                        const idx = items.indexOf(oldHrid);
                        if (idx !== -1) {
                            items[idx] = newHrid;
                            swappedInLoadout = true;
                        }
                    }
                    if (swappedInLoadout && !oldHridStillReferenced) {
                        // Also swap in tab.items — mirror syncLoadoutBinding: if the tab
                        // already contains newHrid, remove the old entry instead of
                        // overwriting it, which would create a duplicate.
                        const itemIdx = tab.items.indexOf(oldHrid);
                        if (itemIdx !== -1) {
                            if (tab.items.includes(newHrid)) {
                                tab.items.splice(itemIdx, 1);
                            } else {
                                tab.items[itemIdx] = newHrid;
                                clearItemTombstone(this._config, tab.id, newHrid);
                            }
                            // The old hrid is gone from this tab: without a
                            // tombstone the item union folds it straight back
                            // in from the stored copy on the next save
                            tombstoneItem(this._config, tab.id, oldHrid);
                        }
                    }
                }
                if (tab.children.length > 0) walk(tab.children);
            }
        };
        walk(this._config.tabs);
    }

    /**
     * Handle loadout snapshot updates — sync bound tabs automatically.
     * Called whenever any loadout is created/updated/deleted in-game.
     */
    _onLoadoutSnapshotUpdate() {
        // Loadout snapshots are per character; syncing the arriving character's
        // loadouts into the departing character's bindings is the same
        // contamination `_save` refuses, caught one step earlier.
        if (!this._isConfigForCurrentCharacter()) return;

        const loadoutSnapshot = getLoadoutSnapshot();
        const snapshots = loadoutSnapshot.snapshots;
        const currentSnapshotNames = new Set(Object.values(snapshots).map((s) => s.name));
        const includeConsumables = config.getSetting('inventoryTabs_loadoutIncludeConsumables');

        let anyChanged = false;

        // Walk all tabs looking for loadoutBindings
        const walkAndSync = (tabs) => {
            for (const tab of tabs) {
                if (tab.loadoutBindings && Object.keys(tab.loadoutBindings).length > 0) {
                    // Sync each binding against current snapshot
                    for (const [loadoutName, _boundItems] of Object.entries(tab.loadoutBindings)) {
                        // Find the matching snapshot
                        const snapshot = Object.values(snapshots).find((s) => s.name === loadoutName);
                        if (!snapshot) continue; // Will be cleaned up by orphan logic below

                        // Build new snapshot items list
                        const newItems = [];
                        for (const eq of snapshot.equipment || []) {
                            if (!eq.itemHrid) continue;
                            const hrid =
                                eq.enhancementLevel > 0 ? `${eq.itemHrid}+${eq.enhancementLevel}` : eq.itemHrid;
                            newItems.push(hrid);
                        }
                        if (includeConsumables) {
                            for (const f of snapshot.food || []) {
                                if (f.itemHrid) newItems.push(f.itemHrid);
                            }
                            for (const d of snapshot.drinks || []) {
                                if (d.itemHrid) newItems.push(d.itemHrid);
                            }
                        }

                        const result = syncLoadoutBinding(this._config, tab.id, loadoutName, newItems);
                        if (result.changed) {
                            this._config = result.config;
                            anyChanged = true;
                        }
                    }

                    // Clean orphaned bindings (loadout deleted/renamed)
                    const orphanResult = cleanOrphanedBindings(this._config, tab.id, currentSnapshotNames);
                    if (orphanResult.changed) {
                        this._config = orphanResult.config;
                        anyChanged = true;
                    }
                }

                if (tab.children.length > 0) walkAndSync(tab.children);
            }
        };

        walkAndSync(this._config.tabs);

        if (anyChanged) {
            this._boundBaseHrids = null; // Invalidate cache
            this._save();
            if (this._isActive) this._applyLayout();
        }
    }

    _renderLoadoutButtons(container, tabId) {
        container.innerHTML = '';
        const loadoutSnapshot = getLoadoutSnapshot();
        const snapshots = loadoutSnapshot.snapshots;
        const entries = Object.values(snapshots);

        if (entries.length === 0) {
            const msg = document.createElement('span');
            msg.style.cssText = 'font-size:11px;color:#888;';
            msg.textContent = 'No loadout snapshots — open your loadout panel first.';
            container.appendChild(msg);
            return;
        }

        const includeConsumables = config.getSetting('inventoryTabs_loadoutIncludeConsumables');
        const currentTab = findTab(this._config, tabId)?.tab;
        const currentItems = new Set(currentTab?.items || []);

        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const snapshot of entries) {
            const skillLabel = snapshot.actionTypeHrid
                ? snapshot.actionTypeHrid
                      .split('/')
                      .pop()
                      .replace(/_/g, ' ')
                      .replace(/\b\w/g, (c) => c.toUpperCase())
                : 'All Skills';

            const loadoutItems = [];
            for (const eq of snapshot.equipment || []) {
                if (!eq.itemHrid) continue;
                const hrid = eq.enhancementLevel > 0 ? `${eq.itemHrid}+${eq.enhancementLevel}` : eq.itemHrid;
                loadoutItems.push(hrid);
            }
            if (includeConsumables) {
                for (const f of snapshot.food || []) {
                    if (f.itemHrid) loadoutItems.push(f.itemHrid);
                }
                for (const d of snapshot.drinks || []) {
                    if (d.itemHrid) loadoutItems.push(d.itemHrid);
                }
            }

            const newItems = loadoutItems.filter((h) => !currentItems.has(h));
            const allAdded = newItems.length === 0 && loadoutItems.length > 0;

            const btn = document.createElement('button');
            btn.className = 'toolasha-ct-cat-btn' + (allAdded ? ' toolasha-ct-cat-btn--added' : '');
            btn.textContent = `${snapshot.name} (${skillLabel})`;
            btn.title = allAdded
                ? `All items from "${snapshot.name}" already added`
                : `Add ${newItems.length} item(s) from "${snapshot.name}"`;

            btn.addEventListener('click', () => {
                for (const hrid of newItems) {
                    this._config = addItem(this._config, tabId, hrid);
                    currentItems.add(hrid);
                }
                // Record binding so this tab auto-syncs with loadout changes
                if (loadoutItems.length > 0) {
                    this._config = addLoadoutBinding(this._config, tabId, snapshot.name, loadoutItems);
                    this._boundBaseHrids = null; // Invalidate cache
                }
                this._save();
                this._renderLoadoutButtons(container, tabId);
                const modal = container.closest('.toolasha-ct-modal');
                if (modal) this._renderAssignedItems(modal.querySelector('.toolasha-ct-assigned-list'), tabId);
                if (this._isActive) this._applyLayout();
            });

            container.appendChild(btn);
        }
    }

    _populateCategoryFilter(select) {
        for (const cat of this._getCategories()) {
            const opt = document.createElement('option');
            opt.value = cat.hrid;
            opt.textContent = cat.name;
            select.appendChild(opt);
        }
    }

    // -----------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------

    _onAddTab(parentId) {
        const result = addTab(this._config, parentId, 'New Tab');
        this._config = result.config;
        this._config = setTabOpen(this._config, result.tabId, true);
        this._removeInjectedEls();
        this._applyLayout();
        this._openEditor(result.tabId);
        this._save();
    }

    _onDeleteTab(tabId) {
        this._config = removeTab(this._config, tabId);
        this._save();
        this._removeInjectedEls();
        this._applyLayout();
    }

    _onToggleTabOpen(tabId, open) {
        this._config = setTabOpen(this._config, tabId, open);
        this._save();
        this._removeInjectedEls();
        this._applyLayout();
    }

    _onSetAllTabsOpen(open) {
        this._config = setAllTabsOpen(this._config, open);
        this._removeInjectedEls();
        this._applyLayout();
        this._save().catch((error) => {
            console.error('[CustomTabs] Failed to persist expand/collapse all:', error);
        });
    }

    _onReorderTab(draggedId, targetId) {
        const dragResult = findTab(this._config, draggedId);
        const targetResult = findTab(this._config, targetId);
        if (!dragResult || !targetResult) return;

        const dragParent = dragResult.parent;
        const targetParent = targetResult.parent;
        if (dragParent !== targetParent) return;

        const arr = dragParent ? dragParent.children : this._config.tabs;
        const targetIndex = arr.findIndex((t) => t.id === targetId);
        this._config = moveTab(this._config, draggedId, targetIndex);
        this._save();
        this._removeInjectedEls();
        this._applyLayout();
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    /**
     * Persist the config — under the character it was loaded for, or not at all.
     *
     * `saveConfig` folds what it is given into whatever is already stored under
     * that key, so writing the wrong character's config here does not merely
     * overwrite: it unions the departed character's tabs into the arriving
     * character's list, and a tombstone the departed character wrote can delete
     * a same-id tab (Export/Import legitimately shares ids across characters)
     * the arriving one still has. Refusing is safe — the edit is lost, the tabs
     * are not — and the reload that follows a switch brings the right config in.
     * @returns {Promise<boolean|undefined>}
     */
    async _save() {
        if (!this._isConfigForCurrentCharacter()) {
            console.warn(
                `[CustomTabs] Refusing to save: tabs in hand belong to ${this._configCharId}, current character is ${dataManager.getCurrentCharacterId()}`
            );
            return;
        }
        return saveConfig(this._configCharId, this._config);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Item action menu: "Add to Tab" button
    // -----------------------------------------------------------------------

    /**
     * Inject an "Add to Tab" dropdown into the game's item action menu.
     * @param {HTMLElement} actionMenu
     */
    _injectAddToTabButton(actionMenu) {
        if (actionMenu.querySelector('.toolasha-ct-add-to-tab')) return;
        if (!this._config?.tabs?.length) return;

        // Resolve item HRID and enhancement level from the action menu DOM. The menu
        // shows the item's own tile, so its icon sprite resolves the identity locale
        // independently; the translated Item_name text is only the fallback. Scoped to
        // the item container so an unrelated icon in the menu can't be mistaken for it.
        const itemContainer = actionMenu.querySelector('[class*="Item_itemContainer"]');
        const nameEl = actionMenu.querySelector('[class*="Item_name"]');
        const hrid =
            itemHridFromIcon(itemContainer, dataManager.getInitClientData()?.itemDetailMap) ||
            (nameEl ? this._nameToHrid(nameEl.textContent.trim()) : null);
        if (!hrid) return;

        const enhEl = actionMenu.querySelector('[class*="Item_enhancementLevel"]');
        const enhLevel = enhEl ? parseInt(enhEl.textContent.trim().replace('+', ''), 10) : 0;
        const itemHrid = !isNaN(enhLevel) && enhLevel > 0 ? `${hrid}+${enhLevel}` : hrid;

        // Build wrapper in the same style as marketplace shortcuts
        const wrapper = document.createElement('div');
        wrapper.className = 'toolasha-ct-add-to-tab';
        wrapper.style.cssText = 'position: relative; width: 100%;';

        const toggle = document.createElement('button');
        const existingBtn = actionMenu.querySelector('button');
        if (existingBtn) toggle.className = existingBtn.className;
        toggle.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';

        const label = document.createElement('span');
        label.style.cssText = 'flex: 1; text-align: center;';
        label.textContent = 'Add to Tab';
        const chevron = document.createElement('span');
        chevron.style.cssText = 'font-size: 0.65em; transition: transform 0.15s; display: inline-block;';
        chevron.textContent = '▼';
        toggle.appendChild(label);
        toggle.appendChild(chevron);

        const panel = document.createElement('div');
        panel.style.cssText = `
            display: none;
            position: absolute;
            top: calc(100% + 4px);
            left: 0;
            width: 100%;
            z-index: ${config.Z_POPUP};
            flex-direction: column;
            background: var(--color-surface, #1e1e2e);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 6px;
            overflow: hidden;
            box-shadow: 0 6px 20px rgba(0,0,0,0.6);
            padding: 4px;
            gap: 3px;
            box-sizing: border-box;
        `;

        // Populate panel with all tabs (depth-first)
        const flatTabs = this._flattenTabs(this._config.tabs);
        for (const { tab, depth } of flatTabs) {
            const alreadyAdded = tab.items.includes(itemHrid);
            const btn = document.createElement('button');
            btn.textContent = '\u00a0'.repeat(depth * 2) + tab.name;
            btn.style.cssText = `
                display: block;
                width: 100%;
                padding: 6px 12px;
                border: none;
                border-radius: 4px;
                cursor: ${alreadyAdded ? 'default' : 'pointer'};
                font-size: 0.85rem;
                font-weight: 600;
                color: ${alreadyAdded ? '#888' : '#fff'};
                background: ${tab.color ? tab.color + '55' : 'rgba(255,255,255,0.08)'};
                text-align: left;
                transition: opacity 0.15s;
            `;
            if (tab.color && !alreadyAdded) btn.style.borderLeft = `3px solid ${tab.color}`;
            if (alreadyAdded) {
                btn.title = 'Already in this tab';
            } else {
                btn.addEventListener('mouseenter', () => {
                    btn.style.opacity = '0.8';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.opacity = '1';
                });
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this._config = addItem(this._config, tab.id, itemHrid);
                    this._save();
                    if (this._isActive) {
                        this._removeInjectedEls();
                        this._applyLayout();
                    }
                    closePanel();
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
                });
            }
            panel.appendChild(btn);
        }

        let open = false;
        let outsideBound = false;
        let outsideTimer = null;
        const outsideClick = (e) => {
            if (!wrapper.contains(e.target)) {
                closePanel();
            }
        };
        const closePanel = () => {
            open = false;
            panel.style.display = 'none';
            chevron.style.transform = '';
            if (outsideTimer !== null) {
                clearTimeout(outsideTimer);
                outsideTimer = null;
            }
            if (outsideBound) {
                document.removeEventListener('click', outsideClick);
                outsideBound = false;
            }
        };

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (open) {
                closePanel();
                return;
            }
            open = true;
            panel.style.display = 'flex';
            chevron.style.transform = 'rotate(180deg)';
            if (!outsideBound && outsideTimer === null) {
                outsideTimer = setTimeout(() => {
                    outsideTimer = null;
                    if (!open || outsideBound) return;
                    document.addEventListener('click', outsideClick);
                    outsideBound = true;
                }, 0);
            }
        });

        wrapper.appendChild(toggle);
        wrapper.appendChild(panel);
        actionMenu.appendChild(wrapper);
    }

    /**
     * Flatten the tab tree depth-first into [{tab, depth}] pairs.
     * @param {Array} tabs
     * @param {number} depth
     * @returns {Array<{tab: Object, depth: number}>}
     */
    _flattenTabs(tabs, depth = 0) {
        const result = [];
        for (const tab of tabs) {
            result.push({ tab, depth });
            if (tab.children.length > 0) {
                result.push(...this._flattenTabs(tab.children, depth + 1));
            }
        }
        return result;
    }

    _escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
