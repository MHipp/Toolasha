/**
 * Overlay Panel
 *
 * One floating panel that other features hang a tile on.
 *
 * The point is that the panel knows nothing about what it shows. A feature that
 * wants a line on screen calls `registerRow` and hands over a function that draws
 * into a container; the shell owns everything else — where the panel sits, which
 * rows are on, where each one is placed, and when to redraw. Adding the twentieth
 * row is then the same amount of work as the second, which is the only way a
 * panel of this shape stays maintainable.
 *
 * ## Why a grid and not a list
 *
 * A stack forces one ordering decision — what goes above what — when the
 * question you actually want to answer is what sits *beside* what: revenue next
 * to profit, luck next to expectation, so a glance reads a comparison instead of
 * a column. So the canvas is a CSS grid, and a tile carries a place in the
 * reading order, a number of columns, and its own text scale. That is the whole
 * of what is stored.
 *
 * It used to store rectangles. Six rounds of bug reports were all one shape: a
 * coordinate is a *derived* quantity — it depends on the panel's width, on
 * whether a scrollbar is showing, on what each row happened to draw this second,
 * and on which neighbours exist — and storing a derived quantity as the source
 * of truth means reconciling it forever against conditions nobody knew when it
 * was written. Every round added a correction pass, and every pass was a new
 * seam. Now the browser derives the pixels every frame, at the width that
 * actually exists, and the arithmetic that survives is in
 * `utils/overlay-flow.js`.
 *
 * ## Adding a row
 *
 * ```js
 * import { registerRow } from '../../utils/overlay-rows.js';
 *
 * registerRow({
 *     key: 'treasure',            // stable — it is the storage key for everything about the tile
 *     name: 'Treasure',           // how it reads in the row picker
 *     render: (container) => {    // called on every refresh; draw the current state
 *         container.textContent = `${chestsOpened} chests`;
 *     },
 *     defaultSize: { width: 160, height: 30 },  // optional — the row knows how much it draws
 *     onOpen: () => panel.toggle(),             // optional — double-clicking the tile runs this
 * });
 * ```
 *
 * A row is a summary. `onOpen` is where the detail behind it lives, so the
 * overlay stays a glance and the full panel is one gesture away. It should
 * **toggle** rather than open: the same gesture that summoned a panel is the one
 * you reach for to dismiss it, and a double-click that only ever opens leaves
 * you hunting for the close button.
 *
 * ## Narrow screens
 *
 * Nothing special happens. The same account logs in on a desktop and on a phone,
 * and the same saved layout is correct on both: the column count is measured
 * from the panel, and a tile's span is clamped to the columns there are, so two
 * columns become one and the reading order is unchanged. There is no fallback
 * arrangement, no second code path, and no state in which dragging has to be
 * switched off because the tiles are not where the layout says.
 *
 * Register at module scope, not inside `initialize`. The list lives in
 * `utils/overlay-rows.js` rather than here — see that file for why the bundle
 * layout forces it — so registration order and feature start-up order do not
 * have to agree, and a row whose feature is off simply renders nothing.
 *
 * ## Redrawing
 *
 * Every visible row is redrawn on a timer rather than each feature pushing
 * updates. Rows show rates, elapsed times and counters that change on their own,
 * so a push model would need most rows to own a timer anyway — and a row that
 * forgot would silently show a stale number. `render` should be cheap and should
 * read state rather than compute it; anything expensive belongs behind a cache in
 * the feature that owns it.
 *
 * The shape is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import performanceMonitor from '../../utils/performance-monitor.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, clearGeometry, allGeometry } from '../../utils/panel-geometry.js';
import { characterKey, readScopedFrom, writeScoped } from '../../utils/character-key.js';
import {
    registeredRows,
    resolveRows,
    moveRow,
    emptyPolicyFor,
    compactLabel,
    waitingLine,
    emptyContract,
    EMPTY_POLICY,
} from '../../utils/overlay-rows.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import { fromOPanelConfig, toOPanelConfig } from '../../utils/opanel-config.js';
import { askChoice } from '../../utils/choice-dialog.js';
import { holdEscapeWhile } from '../../utils/panel-escape.js';
import {
    loadLayouts,
    saveLayout,
    deleteLayout,
    layoutNames,
    normalizeName,
    MAX_NAME_LENGTH as MAX_LAYOUT_NAME,
    ACTIVITY,
    PRESET_LAYOUTS,
    offeredLayouts,
    presetFile,
    isPreset,
    freshSwitchState,
    decideAutoSwitch,
    pauseForManualChoice,
} from './overlay-layouts.js';
import { hasCoarsePointer } from '../../utils/mobile.js';
import {
    columnsForLayout,
    MAX_SPAN,
    spanFor,
    seedSpan,
    migrate,
    moveTo,
    dropIndex,
    clampZoom,
    GAP,
    DEFAULT_ZOOM,
} from '../../utils/overlay-flow.js';

/**
 * The layout, per character.
 *
 * Which tiles are up and where is a statement about what that character is
 * doing — the iron cow's overlay has no market rows on it — so this key is
 * scoped and the named-layout library in `overlay-layouts.js` is not: a layout
 * you saved by name is a template, and templates are worth sharing across
 * characters.
 */
const STORAGE_KEY = 'overlayPanelV2';

/**
 * Where the layout lived before it stopped being pixels.
 *
 * Read once, when there is no v2 record to read, and never written. A separate
 * key rather than a version field in the same one, deliberately: it makes a
 * rollback a build swap with no data step, because the old build's record is
 * still sitting there exactly as it left it. The price is one dead key to sweep
 * up in a later release, which is a much better price than a migration that has
 * to be run backwards.
 */
const LEGACY_STORAGE_KEY = 'overlayPanel';

/**
 * Which named layout is in force, kept per character.
 *
 * Separate from the layout record rather than a field in it, because it is not
 * part of a layout: `toOPanelConfig` turns that record into the file the Save
 * and Export buttons write, and a name folded into it would ride along into
 * every saved copy — then come back on import as a layout claiming to be a
 * different one, and count as drift against itself the moment it changed.
 *
 * It is the *name* that is stored, and nothing else. Whether the tiles on
 * screen still match the layout of that name is not a fact worth persisting: it
 * is re-derived by `_markAppliedLayoutDrift` against the saved copy as it
 * stands now, so a layout somebody edited on another character — or in another
 * tab — reads as "(edited)" here rather than as clean because it was clean when
 * this character last pressed something.
 */
const APPLIED_LAYOUT_KEY = 'overlayAppliedLayout';
/** Where the floating panel sits, shared by every character (see panel-geometry) */
const GEOMETRY_KEY = 'overlayPanel';
const PANEL_ID = 'toolasha-overlay-panel';
const REFRESH_MS = 1000;
const DEFAULT_PANEL = { width: 480, height: 320 };
const ZOOM_STEP = 10;

/** Kept clear of the window's edges, so the panel never reaches them */
const VIEWPORT_MARGIN = 8;
/** Below this it has stopped being a panel, whatever the window says */
const MIN_PANEL = { width: 200, height: 120 };

/** Between the settings popover and the panel it is anchored to */
const PICKER_GAP = 6;
/** Between the settings popover and the edge of the window */
const PICKER_EDGE = 4;
/**
 * The least the popover may be squeezed to.
 *
 * Below this it is a scrollbar rather than a control. It is allowed to overrun
 * the bottom of the window to keep it — what must never be given up is the top
 * edge, which is what keeps the panel's header clickable.
 */
const MIN_PICKER_HEIGHT = 120;
/**
 * What the header is assumed to be worth before it has been laid out.
 *
 * Only reached when the panel measures nothing, which a real one does not — but
 * a zero here would place the popover exactly over the ✕ it must stay clear of.
 */
const MIN_HEADER_HEIGHT = 28;

/** What the game calls a labyrinth action, for telling one run of combat from another */
const LABYRINTH_ACTION_TYPE = '/action_types/labyrinth';

/** The CSS custom property the grid reads its column count from */
const COLUMN_VARIABLE = '--overlay-columns';

/** The scroller's own padding, which the canvas sits inside — `6px` on each side */
const SCROLLER_PADDING = 12;

/** What a tile is worth in height when its row declares nothing */
const DEFAULT_TILE_HEIGHT = 30;

/**
 * A tile's content box, as it stands before any row has drawn into it.
 *
 * Named because it has to be *restored*, not merely set once. A row draws by
 * styling this box — `row` makes it a column, `alignedRows` makes it a grid of
 * however many columns that row has — and `blank` clears the children without
 * touching any of it. So a tile that has drawn once and then gone quiet still
 * carries the last shape it was given, and whatever the panel puts in it next
 * is laid out by somebody else's rules.
 */
const CONTENT_STYLE = { width: '100%', height: 'auto', minHeight: '0', overflow: 'hidden' };

/** Marks the container the docked panel was put into, so the sheet can find it */
const DOCK_HOST_CLASS = 'toolasha-overlay-dock-host';
const DOCK_STYLE_ID = 'toolasha-overlay-dock';
const DOCK_HEIGHT = { min: 90, max: 900, default: 220 };
/** Never take so much of the column that the tab body has nowhere to draw */
const DOCK_MIN_BODY = 140;
/** Clear of the bottom of the window, so the panel's edge is not the screen's */
const DOCK_BOTTOM_GAP = 8;

/** Fired on `document` whenever the panel opens or closes */
export const VISIBILITY_EVENT = 'toolasha:overlay-visibility';

/**
 * What docking does to the character column.
 *
 * The column is a header strip and a tab body; adding a third child below them
 * would simply make the column taller and push the bottom of the inventory off
 * the screen. Turning it into a flex column instead makes the tab body the one
 * part that gives — it takes whatever height the docked panel leaves and scrolls
 * the rest, which is what "make the inventory smaller to accommodate" means.
 *
 * `min-height: 0` is what actually allows that: a flex item refuses to shrink
 * below its content without it, so the body would keep its full height and push
 * the panel out of view regardless of the flex factors.
 *
 * There is no height here. `max-height: 100%` was the obvious thing to write and
 * it does nothing: the column's own height is not definite, so a percentage of it
 * resolves to no constraint at all, and the column simply grew until the panel
 * hung off the bottom of the window. The height is measured against the window
 * instead — see `_fitDock`.
 */
/**
 * The draw brake's window, ceiling and cooldown.
 *
 * Twenty in a second is far above anything the panel does when it is working —
 * the tick is one a second, and a drag is bounded by how fast a hand moves — and
 * far below the hundreds a `ResizeObserver` feedback loop reaches before the
 * frame budget is gone.
 */
const DRAW_WINDOW_MS = 1000;
const MAX_DRAWS_PER_WINDOW = 20;
const DRAW_COOLDOWN_MS = 5000;

const DOCK_CSS = `
    .${DOCK_HOST_CLASS} {
        display: flex !important;
        flex-direction: column !important;
        min-height: 0;
        overflow: hidden;
    }
    .${DOCK_HOST_CLASS} > [class*="TabsComponent_tabsContainer"] {
        flex: 0 0 auto;
    }
    .${DOCK_HOST_CLASS} > [class*="TabsComponent_tabPanelsContainer"] {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
    }
    #${PANEL_ID}[data-docked="true"] {
        flex: 0 0 auto;
    }
`;

const COLORS = {
    // Nearly opaque: at 0.9 the game's inventory grid read straight through the
    // tiles, and a figure you have to pick out of a background is not a glance
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(20, 24, 40, 0.85)',
    border: 'rgba(120, 160, 255, 0.3)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#9ec4ff',
    tileEdit: 'rgba(158, 196, 255, 0.28)',
    separator: 'rgba(158, 196, 255, 0.16)',
};

/**
 * A layout nobody has touched yet.
 *
 * A function rather than a constant because switching characters has to get a
 * clean one: merging the new character's saved layout onto whatever the last
 * character left in memory would carry their tiles across, and merging onto
 * *nothing* saved would carry all of it.
 * @returns {Object} Default settings
 */
function defaultSettings() {
    return {
        /** Version 2: an order and a set of spans, rather than pixels — see `migrate` */
        version: 2,
        /** The grid the spans are written for; a span only means anything against one */
        columns: 2,
        visible: {},
        /** Reading order, and the layout itself */
        order: [],
        /** How many columns each tile takes; absent is one */
        span: {},
        zoom: {},
        locked: true,
        separators: true,
        textScale: 100,
        open: false,
        /** In the character column rather than floating over the game */
        docked: false,
        // Null until the edge is dragged, and null means "as tall as the
        // tiles need". A fixed starting height is a guess about a layout it
        // has never seen, and a guess that is too small cuts the bottom row
        // of tiles in half the moment it docks
        dockHeightPx: null,
        /** What a tile does before it has anything to show — see `emptyPolicyFor` */
        emptyTiles: EMPTY_POLICY.AUTO,
        /**
         * Whether this character's row defaults are the curated set.
         *
         * True here and preserved as false for anyone with a saved layout, so a
         * player who arranged their overlay under the old every-row-on defaults
         * keeps exactly the rows they had. See `resolveRows`.
         */
        curatedDefaults: true,
        /**
         * Whether the layout follows what the character is doing.
         *
         * Off. A panel that rearranges itself without being asked is alarming
         * the first time it happens, and this one is only worth having once you
         * have layouts worth switching between — which is a decision, and
         * decisions belong to the player.
         */
        autoSwitchLayout: false,
        /**
         * Which activity each named layout is for: `{ [layoutName]: activity }`.
         *
         * Beside `emptyTiles` in the panel's own per-character settings rather
         * than in the global layout library, and that is the deliberate part: a
         * layout is a template shared across characters, but *what a character
         * uses it for* is not. The iron cow and the main can both have "Market"
         * and only one of them should switch to it.
         */
        layoutActivity: {},
    };
}

/**
 * What the character is doing, as far as a layout is concerned.
 *
 * Read from the action queue rather than from any feature, so it does not
 * depend on the combat or labyrinth features being switched on — a layout that
 * only follows your activity while some unrelated tracker is enabled is a
 * layout that appears broken.
 *
 * The order is the order of specificity. A labyrinth run *is* combat by action
 * type, so it has to be asked about first or it would never be seen. The
 * marketplace comes first of all: whatever your character is grinding, if you
 * have the market open then trading is what you are doing and the tiles you
 * want are the market ones.
 *
 * Returns null rather than guessing when the game has not loaded or nothing is
 * running, and null never switches anything.
 *
 * @returns {string|null} One of {@link ACTIVITY}, or null
 */
function currentActivity() {
    try {
        if (typeof document !== 'undefined' && document.querySelector('[class*="MarketplacePanel_marketItems"]')) {
            return ACTIVITY.MARKET;
        }

        // Everything below is read off the action queue, which is the only thing
        // that answers "what is this character doing" in the present tense.
        //
        // The labyrinth used to be read from `characterLabyrinth.roomData`
        // instead, on the reasoning that a run is the thing with a floor and a
        // path and only a run has them. Only a run *makes* them; the character
        // keeps them afterwards. So a character who cleared a labyrinth on
        // Tuesday still read as being in one on Thursday while quietly
        // tailoring — and with auto-switching on, got the Labyrinth layout for
        // it, permanently, since the reading never changed back.
        const running = (dataManager.getCurrentActions?.() || []).find((action) => action && !action.isDone);
        if (!running?.actionHrid) return null;

        const hrid = String(running.actionHrid);
        // The same test the labyrinth features use, by action type where the
        // game offers one and by the hrid where it does not. Written out here
        // rather than imported, because those modules live in the combat bundle
        // and an import would put a copy of them in this one.
        const type = dataManager.getActionDetails?.(hrid)?.type;
        if (type === LABYRINTH_ACTION_TYPE || (!type && hrid.includes('/labyrinth'))) return ACTIVITY.LABYRINTH;

        return hrid.startsWith('/actions/combat/') ? ACTIVITY.COMBAT : ACTIVITY.SKILLING;
    } catch (error) {
        console.error('[OverlayPanel] Reading the current activity failed:', error);
        return null;
    }
}

class OverlayPanel {
    constructor() {
        this.isInitialized = false;
        this.settings = defaultSettings();
        this.panel = null;
        /** The container the docked panel was put into, so it can be put back */
        this.dockHost = null;
        /** Re-measures the panel when the window changes shape */
        this.onWindowResize = null;
        /** Watches the panel's own box, which changes without a window resize */
        this.panelObserver = null;
        /** How many columns the grid currently has, so a resize can tell a change from a nudge */
        this.columns = 0;
        /** The scroller width the tiles were last drawn for */
        this.lastWidth = 0;
        /** The draw brake — see `_takeDrawBudget` */
        this.drawWindowAt = 0;
        this.drawsInWindow = 0;
        this.drawPausedUntil = 0;
        /** What asked for the most recent redraw, so a runaway can name its trigger */
        this.drawReason = '';
        /** Whether the redraw about to happen is one nobody asked for */
        this.drawAutomatic = false;
        /** True while a draw is in progress, so its own side effects cannot start another */
        this.redrawing = false;
        /** Whether a resize redraw is already booked for the next frame */
        this.resizePending = false;
        /** Whether a dock re-fit is already booked for the next frame */
        this.dockPending = false;
        this.canvasEl = null;
        this.pickerEl = null;
        /** The header band, which the popover is never allowed to cover */
        this.headerEl = null;
        /** Dismisses the popover on a press anywhere that is not it or the panel */
        this.onPickerDismiss = null;
        /** Dismisses the popover on Escape */
        this.onPickerKey = null;
        /** Keeps the shared Escape-to-close off the panels while the popover is up */
        this.releaseEscapeHold = null;
        this.timerRegistry = createTimerRegistry();
        this.detachDrag = null;
        this.detachResize = null;
        this.refreshId = null;
        this.tiles = new Map();
        this.lockBtn = null;
        /** True while a tile is being dragged or resized, so refreshes hold off */
        this.interacting = false;
        /** The layout before the last bulk change, so it can be put back */
        this.undoState = null;
        /** Saved layout names as last read; null until storage has been asked */
        this.savedLayouts = null;
        /**
         * The name of the layout last applied, for the popover to say so.
         *
         * Persisted per character (see `APPLIED_LAYOUT_KEY`) and restored by
         * `initialize`, so a reload does not put the player back to Save as…
         * and retyping the name the Update button exists to save them typing.
         */
        this.appliedLayout = null;
        /** What auto-switching has seen and done — see `decideAutoSwitch` */
        this.switchState = freshSwitchState();
        /**
         * Rows switched on by hand this session, and not yet seen to draw.
         *
         * Deliberately in memory and not in the settings. It records a *gesture*,
         * not a preference: the answer it buys — an empty tile that says what it
         * is waiting for instead of vanishing — is owed to the click, and a
         * click does not need to survive a reload. Persisting it would turn a
         * one-off acknowledgment into a second, invisible copy of the
         * `emptyTiles` setting, which is the thing a player is meant to use when
         * they want this permanently. See `_emptyPolicy`.
         */
        this.justEnabled = new Set();
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('overlayPanel')) return;
        this.isInitialized = true;

        // Rebuilt from defaults rather than merged onto what is in memory: this
        // runs again after a character switch, and the character switched away
        // from must not leave its tiles behind
        // Everything this panel reads at start-up in one readonly transaction:
        // the layout, the pre-migration layout it may have to fall back to, and
        // the name of the applied layout. Three scoped reads of up to two keys
        // apiece used to go out one after another, and at start-up each waits
        // behind every other feature's transactions as well as its own.
        const state = await storage.getMany(
            [STORAGE_KEY, LEGACY_STORAGE_KEY, APPLIED_LAYOUT_KEY].flatMap((base) => [characterKey(base), base]),
            'settings'
        );
        const saved = await this._readSettings(state);
        this.settings =
            saved && typeof saved === 'object'
                ? // Never spread in from the defaults: a saved layout that predates
                  // the curated set has no opinion on the flag, and taking the
                  // default's `true` would quietly switch off every row that
                  // player had on and never explicitly ticked
                  { ...defaultSettings(), ...saved, curatedDefaults: saved.curatedDefaults === true }
                : defaultSettings();

        // The order names every row the registry knows about, once, here.
        //
        // It used to be written by `_renderPicker` as a side effect of drawing
        // itself, which was harmless while the order was advisory and is not
        // now that the order *is* the layout: opening the gear would have
        // rewritten the arrangement into registration order. `resolveRows` does
        // the same job correctly — saved order first, then anything it has never
        // heard of — and a row whose feature registers after this still gets
        // appended at draw time, in registration order, deterministically.
        this.settings.order = resolveRows(registeredRows(), this.settings).map((row) => row.key);

        // Before the panel is drawn, so the first render of the popover already
        // has the Update button and the "Showing:" line on it
        await this._restoreAppliedLayout(state);

        // Reopens itself where you left it — an overlay you have to summon after
        // every refresh is an overlay you stop using
        if (this.settings.open) this.show();

        registerCommand({
            name: 'Overlay',
            hint: 'The tile overlay',
            run: () => this.toggle(),
        });
    }

    disable() {
        try {
            unregisterCommand('Overlay');
            this._removePanel();
            this.isInitialized = false;
        } catch (error) {
            console.error('[Overlay Panel] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /** Whether the panel is not merely built but actually in the document */
    get isOpen() {
        return Boolean(this.panel && document.body.contains(this.panel));
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.isOpen) {
            bringPanelToFront(this.panel);
            return;
        }
        // Held but no longer in the document: a docked panel whose column the
        // game took away, which on a phone is every screen that is not the
        // inventory. Torn down rather than abandoned — its refresh timer and its
        // listeners are still running, and each reopen would leave another set
        if (this.panel) this._removePanel();
        this._createPanel();
        this.settings.open = true;
        this._save();
        this._announce();
    }

    /** Close the panel and remember that it was closed */
    hide() {
        this._removePanel();
        this.settings.open = false;
        this._save();
        this._announce();
    }

    /**
     * Say that the panel opened or closed.
     *
     * An event rather than a callback list, because the only listener is the tab
     * button that switches this — and a switch that does not change when the
     * panel is closed by its own ✕ is a switch you stop trusting.
     */
    _announce() {
        document.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: { open: Boolean(this.panel) } }));
    }

    /** Open if closed, close if open */
    toggle() {
        // What is on screen, not what is in hand: a docked panel whose column
        // was rebuilt away still exists, and a switch that closes something
        // invisible is a switch that does nothing when pressed
        if (this.isOpen) this.hide();
        else this.show();
    }

    /** Redraw now, rather than waiting for the next tick */
    refresh() {
        this._renderBody();
    }

    /**
     * Whether tiles can currently be moved and resized.
     *
     * There is no longer a second answer to hold this off. A layout is an order
     * and a set of spans, so it is correct at every width and there is no state
     * in which the tiles on screen are not the ones the layout describes.
     */
    get isEditable() {
        return !this.settings.locked;
    }

    /**
     * This character's settings, reading the old record when there is no new one.
     *
     * The migration is the only thing that happens here, and it happens by
     * **merging over the record that was loaded** rather than by rebuilding one
     * from the fields the new schema knows about. That is not a stylistic
     * preference: four row options — the luck and expected-value sub-switches —
     * live in this record and are read from another bundle entirely, through the
     * bundle bridge. A rewrite that constructed a fresh object from `order`,
     * `span` and the settings it could name would switch all four off without
     * ever mentioning them.
     *
     * @param {Map<string, *>} values - Both forms of both keys, read in one transaction
     * @returns {Promise<Object|null>} The settings, or null for a fresh character
     */
    async _readSettings(values) {
        const current = await readScopedFrom(STORAGE_KEY, values, 'settings', null, { migrate: 'adopt' });
        if (current && typeof current === 'object') return current;

        const legacy = await readScopedFrom(LEGACY_STORAGE_KEY, values, 'settings', null, { migrate: 'adopt' });
        if (!legacy || typeof legacy !== 'object') return null;

        // Everything that was never geometry comes across untouched; the pixels
        // become an order and a set of spans, and the pixels themselves are
        // dropped so they cannot be written back out on the next export
        const carried = { ...legacy };
        delete carried.positions;
        delete carried.sizes;
        delete carried.snapToGrid;
        return { ...carried, ...migrate(legacy) };
    }

    _save() {
        writeScoped(STORAGE_KEY, this.settings, 'settings').catch((error) => {
            console.error('[OverlayPanel] Saving the layout failed:', error);
        });
    }

    /**
     * Bring back the name of the layout in force, after a reload.
     *
     * Restored as a name and nothing more: no attempt is made here to decide
     * whether the tiles still match it. That question belongs to
     * `_markAppliedLayoutDrift`, which asks it of the saved copy as it stands
     * *now* — restoring the name as though it were known-clean would let a
     * layout that changed elsewhere come back reading "Showing: Combat" when
     * the screen is nothing of the sort.
     *
     * A name whose layout has since been deleted is left as it is rather than
     * dropped: it is still what was applied, the drift check simply has nothing
     * to compare it against, and the Update button saves it back under that
     * name — which is what somebody who deleted it by accident wants.
     *
     * @param {Map<string, *>} values - Both forms of the key, read in one transaction
     * @returns {Promise<void>}
     */
    async _restoreAppliedLayout(values) {
        try {
            // Discard rather than adopt: which layout one character is showing
            // is not a fact about another character's screen
            const name = await readScopedFrom(APPLIED_LAYOUT_KEY, values, 'settings', null, { migrate: 'discard' });
            this.appliedLayout = typeof name === 'string' && name ? name : null;
        } catch (error) {
            console.error('[OverlayPanel] Reading the applied layout failed:', error);
        }
    }

    /**
     * Record which layout is in force, so the next reload can still say so.
     * @param {string|null} name - The layout's name, or null for none
     */
    _setAppliedLayout(name) {
        this.appliedLayout = name || null;
        writeScoped(APPLIED_LAYOUT_KEY, this.appliedLayout, 'settings').catch((error) => {
            console.error('[OverlayPanel] Saving the applied layout failed:', error);
        });
    }

    _createPanel() {
        // Asked for docked but the column has not rendered yet — a reload lands
        // here — so it opens floating rather than not at all, and the next open
        // finds the column
        const host = this.settings.docked ? this._findDockHost() : null;

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            color: COLORS.text,
            fontSize: `${this._baseFontPx()}px`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.panel.appendChild(this._createHeader(Boolean(host)));

        // The scroll container, so the canvas below can be as large as the tiles
        // need without the panel growing to match
        this.scrollEl = document.createElement('div');
        Object.assign(this.scrollEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '6px',
            minHeight: '0',
            // The gutter is held whether or not a scrollbar is in it, so the
            // width the tiles were laid out against does not change under them
            // the moment they grow tall enough to scroll. Ignored by browsers
            // that have not got it, which is what `SCROLLBAR_RESERVE` is for.
            scrollbarGutter: 'stable',
        });

        this.canvasEl = document.createElement('div');
        Object.assign(this.canvasEl.style, {
            display: 'grid',
            // `minmax(0, 1fr)` rather than `1fr`, and it is load-bearing: a bare
            // `1fr` is `minmax(auto, 1fr)`, and `auto` lets a long unbreakable
            // string force its track wider than its share — which is every tile
            // holding an item name
            gridTemplateColumns: `repeat(var(${COLUMN_VARIABLE}, 2), minmax(0, 1fr))`,
            gap: `${GAP}px`,
            // A tile spanning past the explicit tracks would otherwise make the
            // grid grow implicit ones sized to their *content*, which is a
            // canvas that will not come back down when the panel narrows and a
            // horizontal scrollbar on everything around it. Implicit tracks
            // behave exactly like explicit ones instead.
            gridAutoColumns: 'minmax(0, 1fr)',
            minWidth: '0',
            // Every tile in a grid row is drawn to the height of the tallest in
            // it, which used to be computed and written into both of them
            alignItems: 'stretch',
            alignContent: 'start',
        });
        this._applyColumns();
        this.scrollEl.appendChild(this.canvasEl);
        this.panel.appendChild(this.scrollEl);

        this.pickerEl = this._createPicker();
        document.body.appendChild(this.pickerEl);
        this._watchForDismissal();

        if (host) this._placeDocked(host);
        else this._placeFloating();

        this._renderBody();
        // Again after drawing: how tall the tiles came out is the thing a docked
        // panel sizes itself to, and it is not known until they are laid out
        this._fitDock();
        this._watchViewport();
        this._startRefreshing();
    }

    /**
     * Follow the room there is, rather than the room there was.
     *
     * Two things change it and neither is the other. The window changes shape —
     * a phone turned on its side, a browser window dragged narrower — and that
     * is what the resize event says. But the *panel* also changes width without
     * the window doing anything: docked, it is as wide as the character column,
     * and the column is resized by the game's own settings and by whatever else
     * is in it. A layout laid out for the width it used to have is a layout with
     * tiles hanging off the edge, so both are watched.
     */
    _watchViewport() {
        this.onWindowResize = () => this._onViewportChange();
        window.addEventListener('resize', this.onWindowResize);

        // Guarded rather than assumed: this runs in a userscript, and the test
        // DOM has no reason to implement an API that measures nothing
        if (typeof ResizeObserver !== 'function' || !this.panel) return;

        this.panelObserver = new ResizeObserver(() => this._onPanelResized());
        this.panelObserver.observe(this.panel);
        this._watchDock();
    }

    /**
     * The panel changed size: redraw for the width it now has.
     *
     * Three things stand between this and the loop it caused. It **ignores
     * anything that happens while it is drawing**, because a redraw that
     * changes a size the observer is watching would otherwise call this again
     * from inside itself. It compares against the width it last *drew for*
     * rather than the width it last *saw*, with a pixel of deadband, so a
     * measurement flickering between two values settles instead of alternating
     * forever — which is exactly what a comparison against the last observation
     * cannot do. And it coalesces to one redraw a frame, so a burst of
     * observations during a drag-resize is one draw rather than thirty.
     *
     * The version this replaces had none of the three: it compared each
     * observation to the previous one and redrew whenever they differed, which
     * turns any two-value oscillation into an unbounded storm of full rebuilds.
     */
    _onPanelResized() {
        if (this.redrawing || this.resizePending) return;

        this.resizePending = true;
        const run = () => {
            this.resizePending = false;
            if (!this.panel || !this.scrollEl) return;

            const width = this.scrollEl.offsetWidth || 0;
            // A pixel of deadband: sub-pixel layout and zoom both produce widths
            // that differ by a fraction and mean the same thing
            if (Math.abs(width - this.lastWidth) < 1) return;
            this.lastWidth = width;

            this._applyColumns();
            this._renderBody('the panel being resized');
            this._placePicker();
        };

        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
    }

    /**
     * Re-fit the docked panel when a box it is fitted to changes size.
     *
     * `_fitDock` follows two things: how much room the column has, and how tall
     * the tiles came out. Both are boxes, so both can be observed — which is
     * cheaper and more responsive than the once-a-second re-measure this
     * replaces, and does not force a layout in the middle of a draw.
     */
    _watchDock() {
        if (typeof ResizeObserver !== 'function') return;
        this.dockObserver?.disconnect();
        this.dockObserver = new ResizeObserver(() => this._onDockResized());
        // The host only. This used to watch the canvas as well, which is the
        // same feedback shape the panel observer had and worse: `_fitDock` sets
        // the panel's height, the panel's height sets the scroller's, the
        // scroller's sets how much of the canvas is laid out — and the canvas
        // reports a new size, which re-fits the dock. The canvas is *inside* the
        // thing being sized; it cannot also be the thing that sizes it.
        if (this.dockHost) this.dockObserver.observe(this.dockHost);
    }

    /**
     * The column changed size: fit the panel into what it now has.
     *
     * Coalesced and re-entry-guarded for the reason `_onPanelResized` is, and
     * additionally silent when the height it would write is the height already
     * there — `_fitDock` writes `panel.style.height`, and the panel is inside
     * the host this is observing.
     */
    _onDockResized() {
        if (this.redrawing || this.dockPending) return;

        this.dockPending = true;
        const run = () => {
            this.dockPending = false;
            this._fitDock();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
    }

    /** The window changed shape: fit to it, then redraw for what is left */
    _onViewportChange() {
        if (!this.panel) return;
        this._clampToViewport();
        this._fitDock();
        this._applyColumns();
        this._renderBody();
        this._placePicker();
    }

    /**
     * Hold the floating panel inside the window.
     *
     * A saved geometry is a statement about the window it was saved in, and the
     * account that saved it on a desktop logs in again on a phone — where a
     * remembered 900×600 panel at x=700 is a panel with its header, its ✕ and
     * its resize grip all off the screen. There is then no gesture that brings
     * it back.
     *
     * Display-time, and deliberately: nothing here is written to storage. The
     * desktop's geometry is still the desktop's when it is next opened there.
     *
     * Only plain pixel sizes are touched, which is what the regular expression
     * is for rather than `parseFloat`. Before the saved geometry lands the panel
     * is sized in `min(…px, 92vw)`, which is already viewport-safe; and
     * `parseFloat` reads `92%` as 92, so a relative width would be "corrected"
     * to ninety-two pixels.
     */
    _clampToViewport() {
        if (!this.panel || this.panel.dataset.docked === 'true') return;

        const px = (value) => {
            const written = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? '').trim());
            return written ? Number(written[1]) : null;
        };
        const room = {
            width: Math.max(MIN_PANEL.width, window.innerWidth - VIEWPORT_MARGIN * 2),
            height: Math.max(MIN_PANEL.height, window.innerHeight - VIEWPORT_MARGIN * 2),
        };

        const width = px(this.panel.style.width);
        if (width !== null && width > room.width) this.panel.style.width = `${room.width}px`;
        const height = px(this.panel.style.height);
        if (height !== null && height > room.height) this.panel.style.height = `${room.height}px`;

        // What it is now, which is what the position has to be measured against
        const box = {
            width: px(this.panel.style.width) ?? this.panel.offsetWidth ?? 0,
            height: px(this.panel.style.height) ?? this.panel.offsetHeight ?? 0,
        };
        const left = px(this.panel.style.left);
        if (left !== null) {
            const most = Math.max(VIEWPORT_MARGIN, window.innerWidth - box.width - VIEWPORT_MARGIN);
            this.panel.style.left = `${Math.round(Math.min(Math.max(left, VIEWPORT_MARGIN), most))}px`;
        }
        const top = px(this.panel.style.top);
        if (top !== null) {
            const most = Math.max(VIEWPORT_MARGIN, window.innerHeight - box.height - VIEWPORT_MARGIN);
            this.panel.style.top = `${Math.round(Math.min(Math.max(top, VIEWPORT_MARGIN), most))}px`;
        }
    }

    /** Over the game, where it can be dragged anywhere and remembers where */
    _placeFloating() {
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '20px',
            // Z_HUD, not Z_FLOATING_PANEL: this one is always up, so it has to
            // sit *below* the game's own interactive UI rather than over the
            // tabs and buttons it happens to overlap
            zIndex: String(config.Z_HUD),
            // Clamped so the first open on a phone is not wider than the screen.
            // Height goes through `panelHeightCap`, which measures the *visible*
            // viewport rather than the layout one — see its comment for why a
            // `vh` literal here hides the footer under the on-screen keyboard.
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height),
            // Explicit, so no amount of content can widen it and set the
            // observer watching it going
            boxSizing: 'border-box',
            minWidth: '0',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.55)',
        });

        document.body.appendChild(this.panel);
        // `managedZ: false`: this panel's z-index is `_refreshStacking`'s to set
        // and nobody else's. It is registered only for the viewport clamp — the
        // shared bring-to-front would raise an always-on readout over the game's
        // own UI, and the cap-overflow renumber would do it on its own after
        // enough raises in a long session
        registerFloatingPanel(this.panel, { managedZ: false });
        // Unlocked across a reload means the panel comes back mid-arrangement,
        // and it should come back raised rather than underneath the game
        this._refreshStacking();

        this.detachResize = makeResizable(this.panel, {
            minWidth: 220,
            minHeight: 120,
            onResize: (size) => {
                saveGeometry(GEOMETRY_KEY, size);
                this._renderBody();
                this._placePicker();
            },
        });
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 220, height: 120 }).then(() => {
            // The geometry that lands here was measured in whatever window it
            // was saved in, which on a phone is a window that no longer exists
            this._clampToViewport();
            this._renderBody();
        });
    }

    /**
     * Below the character tabs, in the column's own flow.
     *
     * In flow rather than pinned over the column, so the game's own layout does
     * the work: the panel is a sibling of the tab body, and the sheet gives the
     * tab body the leftover height. Nothing has to measure anything, and the
     * arrangement survives the column being resized, the window changing, and
     * the combat panel's own height setting.
     *
     * @param {HTMLElement} host - The container holding the tabs and their body
     */
    _placeDocked(host) {
        if (!document.getElementById(DOCK_STYLE_ID)) {
            const style = document.createElement('style');
            style.id = DOCK_STYLE_ID;
            style.textContent = DOCK_CSS;
            document.head.appendChild(style);
        }

        Object.assign(this.panel.style, {
            position: 'relative',
            zIndex: 'auto',
            // Pinned to the column rather than left to work itself out. The dock
            // host is a flex column, and `width: auto` on a flex item is a width
            // its *contents* get a say in — which is the one thing the panel's
            // width must never be, because a redraw changes the contents and the
            // observer watching the panel would see the width move under it.
            width: '100%',
            maxWidth: '100%',
            minWidth: '0',
            boxSizing: 'border-box',
            height: `${this._dockHeight()}px`,
            minHeight: '0',
            marginTop: '4px',
            boxShadow: 'none',
        });
        this.panel.dataset.docked = 'true';

        host.classList.add(DOCK_HOST_CLASS);
        host.appendChild(this.panel);
        this.dockHost = host;
        this._fitDock();

        // The window listener that re-measures this is attached for both kinds
        // of panel in `_watchViewport`, once the panel is placed
        this.detachResize = this._makeDockResizable();
    }

    /**
     * Give the column a height it can actually divide up.
     *
     * The first attempt at this was a stylesheet saying `max-height: 100%`, which
     * silently does nothing — a percentage resolves against the parent's height,
     * the parent's height is not definite, so there is no constraint and the
     * column grows to fit its contents. That put the docked panel below the
     * bottom of the window with its tiles cut in half.
     *
     * So the height is measured against the one box that is always definite: the
     * window. From the column's own top to the bottom of the screen is exactly
     * what there is to share, and once the column has that as a real height, the
     * flex rules divide it — the panel takes what it asks for and the tab body
     * takes the rest and scrolls.
     *
     * The panel's request is trimmed to leave the tab body something to draw in.
     * A column is not always tall — a short window, a wrapped tab strip — and a
     * remembered 400px panel in a 300px column would otherwise leave an inventory
     * of nothing, which is worse than a shorter overlay.
     */
    _fitDock() {
        if (!this.dockHost || !this.panel) return;

        const top = this.dockHost.getBoundingClientRect().top;
        const available = Math.max(DOCK_HEIGHT.min + DOCK_MIN_BODY, window.innerHeight - top - DOCK_BOTTOM_GAP);
        const height = `${Math.round(available)}px`;
        if (this.dockHost.style.height !== height) this.dockHost.style.height = height;

        const asked = this.settings.dockHeightPx === null ? this._contentHeight() : this._dockHeight();
        const wanted = `${Math.round(Math.min(Math.max(DOCK_HEIGHT.min, asked), available - DOCK_MIN_BODY))}px`;
        if (this.panel.style.height !== wanted) this.panel.style.height = wanted;
    }

    /**
     * How tall the panel would have to be to show every tile.
     *
     * A fixed starting height is a guess about a layout it has never seen: the
     * tiles keep the arrangement they were given, and any arrangement taller than
     * the guess is cut off at the bottom the moment it docks. Following the tiles
     * cannot be wrong in that way. The edge is still there to drag once you have
     * an opinion, and dragging it is what fixes the height.
     *
     * @returns {number} Pixels, or the default before anything has been drawn
     */
    _contentHeight() {
        // Measured, because nothing writes the canvas a height any more — the
        // grid works one out. Read straight, `style.height` has been an empty
        // string since the grid rework, so this returned the default every time
        // and a docked panel never fitted its tiles at all.
        const content = this.canvasEl?.scrollHeight || 0;
        if (!Number.isFinite(content) || content <= 0) return DOCK_HEIGHT.default;

        // Header, grab bar and borders: everything of the panel that is not the
        // scroller. Constant while the scroller flexes, so this cannot run away
        const chrome = this.panel.offsetHeight - (this.scrollEl?.clientHeight || 0);
        return content + Math.max(0, chrome) + 4;
    }

    /** How tall the panel may be dragged, given what the column has to give */
    _dockCeiling() {
        const host = this.dockHost?.getBoundingClientRect().height || 0;
        return Math.max(DOCK_HEIGHT.min, Math.min(DOCK_HEIGHT.max, host - DOCK_MIN_BODY));
    }

    /**
     * The container the docked panel goes into.
     *
     * Found through the character column's tab strip — the one with an Inventory
     * tab — because every tab strip in the game shares the same classes and only
     * this one has that. The strip's container and the body it switches are
     * siblings; their parent is what the panel joins.
     *
     * @returns {HTMLElement|null}
     */
    _findDockHost() {
        for (const list of document.querySelectorAll('[role="tablist"]')) {
            const inventory = [...list.querySelectorAll('[role="tab"]')].some(
                (tab) => tab.textContent.trim() === 'Inventory'
            );
            if (!inventory) continue;

            const container = list.closest('[class*="TabsComponent_tabsContainer"]');
            if (container?.parentElement) return container.parentElement;
        }
        return null;
    }

    /** The dragged-to dock height, kept inside what a column can actually give */
    _dockHeight() {
        const saved = Number(this.settings.dockHeightPx);
        if (!Number.isFinite(saved)) return DOCK_HEIGHT.default;
        return Math.min(DOCK_HEIGHT.max, Math.max(DOCK_HEIGHT.min, Math.round(saved)));
    }

    /**
     * A grab bar along the docked panel's top edge.
     *
     * Height only, and dragged from the top: the width is the column's to decide,
     * and the boundary being dragged is the one between this panel and the
     * inventory above it — so the bar belongs on that boundary rather than in a
     * corner. Dragging up gives the panel more and the inventory less.
     *
     * @returns {Function} Detach
     */
    _makeDockResizable() {
        const bar = document.createElement('div');
        bar.title = 'Drag to give the overlay more or less of the column';
        Object.assign(bar.style, {
            height: '5px',
            flex: '0 0 auto',
            cursor: 'ns-resize',
            background: COLORS.separator,
        });

        let startY = 0;
        let startHeight = 0;
        let resizing = false;

        const onMove = (event) => {
            if (!resizing) return;
            const wanted = startHeight - (event.clientY - startY);
            // Against what the column has, not an arbitrary maximum: dragged
            // past this the tab body would have nothing left to draw in
            this.panel.style.height = `${Math.min(this._dockCeiling(), Math.max(DOCK_HEIGHT.min, wanted))}px`;
        };
        const onUp = () => {
            if (!resizing) return;
            resizing = false;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            this.settings.dockHeightPx = Math.round(this.panel.getBoundingClientRect().height);
            this._save();
            this._renderBody();
            this._placePicker();
        };
        const onDown = (event) => {
            if (event.button !== 0) return;
            resizing = true;
            startY = event.clientY;
            startHeight = this.panel.getBoundingClientRect().height;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
            event.preventDefault();
        };

        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        bar.style.touchAction = 'none';
        bar.addEventListener('pointerdown', onDown);
        this.panel.insertBefore(bar, this.panel.firstChild);

        return () => {
            bar.removeEventListener('pointerdown', onDown);
            onUp();
            bar.remove();
        };
    }

    /**
     * Move the panel between floating over the game and sitting in the column.
     *
     * Rebuilt rather than restyled: the two differ in how they are positioned,
     * sized, stacked and resized, and every tile's placement is redrawn from the
     * saved layout anyway — so there is nothing to preserve by editing in place
     * and a good deal to get wrong.
     */
    toggleDock() {
        // The rebuild takes the popover with it, and docking is a thing you do
        // *from* the popover — so it is put back rather than silently dropped
        const wasPicking = this.isPickerOpen;
        this.settings.docked = !this.settings.docked;
        this._save();
        if (!this.panel) return;
        this._removePanel();
        this._createPanel();
        if (wasPicking) this.openPicker();
    }

    /**
     * @param {boolean} docked - Whether this header belongs to a docked panel
     * @returns {HTMLElement}
     */
    _createHeader(docked = false) {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: docked ? 'default' : 'move',
            padding: '5px 8px 5px 10px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            gap: '10px',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Overlay';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.gap = '2px';

        // Locked by default, and prominent, because an unlocked overlay is one
        // where every click on a tile risks nudging the layout
        this.lockBtn = this._iconButton('', '', () => {
            this.settings.locked = !this.settings.locked;
            this._save();
            this._refreshLockButton();
            this._refreshStacking();
            this._renderBody();
            // The popover says which of dragging and unlocking is the next
            // gesture, and it is now saying the wrong one
            this._refreshPicker();
        });
        this._refreshLockButton();

        const gearBtn = this._iconButton('⚙', 'Choose rows and arrange the layout', () => {
            if (this.isPickerOpen) this.closePicker();
            else this.openPicker();
        });
        const dockBtn = this._iconButton(
            docked ? '⇱' : '⇲',
            docked
                ? 'Float over the game, where it can be dragged anywhere'
                : 'Dock below the character tabs, giving the overlay its own space instead of covering the game',
            () => this.toggleDock()
        );
        const closeBtn = this._iconButton('✕', 'Close', () => this.hide());

        buttons.append(this.lockBtn, dockBtn, gearBtn, closeBtn);
        header.appendChild(title);
        header.appendChild(buttons);

        // A docked panel has nowhere to be dragged to — it is a row of the
        // column, and the only thing left to choose is how tall it is
        if (!docked) {
            this.detachDrag = makeDraggable(this.panel, header, (position) => {
                saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
                // It is anchored to the panel, so it has to come along
                this._placePicker();
            });
        }
        this.headerEl = header;
        return header;
    }

    _refreshLockButton() {
        if (!this.lockBtn) return;
        const locked = this.settings.locked;
        this.lockBtn.textContent = locked ? '🔒' : '🔓';
        this.lockBtn.title = locked ? 'Layout locked — click to move and resize tiles' : 'Click to lock the layout';
        this.lockBtn.style.background = locked ? 'none' : COLORS.tileEdit;
    }

    /**
     * @param {string} text - Glyph
     * @param {string} title - Tooltip
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _iconButton(text, title, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        Object.assign(button.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            lineHeight: '1',
            padding: '3px 5px',
            borderRadius: '3px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /**
     * The settings popover.
     *
     * Its own floating element rather than a section of the panel. Inside, it
     * took its height out of the tiles — opening the gear squashed the layout
     * you were opening the gear to arrange, which is the wrong way round.
     *
     * @returns {HTMLElement}
     */
    _createPicker() {
        const picker = document.createElement('div');
        Object.assign(picker.style, {
            display: 'none',
            position: 'fixed',
            // Deliberately summoned, unlike the panel it belongs to, so it is
            // allowed above the game UI for as long as it is open
            zIndex: String(config.Z_POPUP),
            padding: '8px 10px 9px',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            background: COLORS.background,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            // How tall it may be is decided by where it lands — see `_placePicker`
            maxHeight: `${MIN_PICKER_HEIGHT}px`,
            overflow: 'auto',
        });
        return picker;
    }

    /** Whether the settings popover is up */
    get isPickerOpen() {
        return Boolean(this.pickerEl) && this.pickerEl.style.display !== 'none';
    }

    /**
     * Put the popover up, drawn and placed.
     *
     * A method rather than three lines in the gear's handler, because docking
     * rebuilds the panel and has to put the popover back — and a second copy of
     * "show it, draw it, place it, then read the layout names" is a second place
     * for one of those four to be forgotten.
     */
    openPicker() {
        if (!this.pickerEl) return;
        this.pickerEl.style.display = '';
        this._renderPicker();
        this._placePicker();
        this._refreshStacking();
        // Storage is not synchronous and the popover is; the layout bar draws
        // from the last reading and corrects itself when this lands
        this._refreshLayoutNames().catch((error) => {
            console.error('[OverlayPanel] Reading the saved layouts failed:', error);
        });
    }

    /**
     * Take the popover down.
     *
     * Every way out goes through here — the gear, Escape, a press outside it —
     * so the panel drops back to its resting z-index however it was dismissed.
     */
    closePicker() {
        if (!this.pickerEl) return;
        this.pickerEl.style.display = 'none';
        this._refreshStacking();
    }

    /**
     * The two gestures that end a popover anywhere else.
     *
     * Belt and braces beside the placement rules, and worth having on their own:
     * the popover is a floating thing at popup z-index, and the only way out of
     * it used to be the one button it was drawn on top of. Escape and a press
     * outside are what everybody already tries.
     *
     * The press listener captures, so a game element that swallows `pointerdown`
     * cannot trap the popover. The key listener does not — the layout-name input
     * inside the popover stops its own keys, and Escape there means "cancel the
     * name I am typing", not "shut the whole thing".
     *
     * A press on the panel is not outside: the popover exists to arrange those
     * tiles, and dragging one must not dismiss the controls you are dragging by.
     */
    _watchForDismissal() {
        this.onPickerDismiss = (event) => {
            if (!this.isPickerOpen) return;
            if (this.pickerEl.contains(event.target) || this.panel?.contains(event.target)) return;
            this.closePicker();
        };
        document.addEventListener('pointerdown', this.onPickerDismiss, true);

        this.onPickerKey = (event) => {
            if (event.key !== 'Escape' || !this.isPickerOpen) return;
            // Spent: dismissing the popover is the whole keypress, and the
            // shared Escape-to-close declines an Escape already acted on
            event.preventDefault();
            this.closePicker();
        };
        document.addEventListener('keydown', this.onPickerKey);

        // Belt and braces beside the preventDefault above, for the order the
        // marker cannot cover: listeners run in registration order, and a
        // panel opened before this popover existed hears the keypress first
        this.releaseEscapeHold = holdEscapeWhile(() => this.isPickerOpen);
    }

    /**
     * Redraw the popover, if it is up, wherever it now belongs.
     *
     * The popover is live: the layout it lists is changed by the lock, by the
     * window narrowing, and by auto-switching ticking over underneath it. Every
     * one of those has to call this, or the popover goes on describing a layout
     * that is no longer on screen.
     */
    _refreshPicker() {
        if (!this.isPickerOpen) return;
        this._renderPicker();
        this._placePicker();
    }

    /**
     * How tall the header band is.
     *
     * Measured rather than assumed, because it holds whatever glyphs the buttons
     * came out as — but a panel that has not been laid out measures nothing, and
     * a zero here would let the popover sit exactly over the ✕.
     *
     * @returns {number} Pixels
     */
    _headerHeight() {
        const measured = this.headerEl?.getBoundingClientRect?.().height || 0;
        return measured > 0 ? measured : MIN_HEADER_HEIGHT;
    }

    /**
     * Where the panel sits against the game's own interface.
     *
     * At rest it belongs underneath: it is always up, and a permanent readout
     * that covers the tabs and the ability bar is worse than one the game
     * occasionally covers. But while the settings are open or the layout is
     * unlocked it is not a readout, it is a thing being operated — and the
     * ability cooldowns counting down through the tile you are dragging make it
     * unusable. So it rises for exactly as long as it is being worked on.
     */
    _refreshStacking() {
        if (!this.panel) return;
        // A docked panel is not over anything to begin with — it has its own
        // space in the column, which is the point of docking it
        if (this.panel.dataset.docked === 'true') return;
        const inUse = this.isPickerOpen || !this.settings.locked;
        this.panel.style.zIndex = String(inUse ? config.Z_FLOATING_PANEL : config.Z_HUD);
    }

    /**
     * Put the popover above the panel, or below it when there is no room.
     *
     * Measured after it is drawn, because its height depends on how many rows
     * are registered — and the whole point of it being above is that it does not
     * cover the layout you are arranging.
     *
     * ## Why the header is sacred
     *
     * This used to place the popover at whichever of two positions was less
     * wrong, and then clamp it into the window. On a tall panel — a phone, or a
     * desktop panel dragged low — neither position fitted, and the clamp slid
     * the popover *up over its own anchor* until it was sitting on the header.
     * The header is the ⚙ that closes the popover and the ✕ that closes the
     * overlay, the popover is at popup z-index above both, and there was no
     * Escape and no outside-click. That is the whole of "it blocks the ability
     * to hide it again": the only two controls that end it were underneath it.
     *
     * So the popover is fitted to the room rather than shoved into it. It takes
     * whichever side it fits on; failing that, the roomier side with its height
     * capped so it scrolls; and failing even that — a panel taller than the
     * window — it stands over the panel's own tiles, starting *below* the
     * header. There is no arrangement in which it covers the header.
     */
    _placePicker() {
        if (!this.isPickerOpen || !this.panel) return;

        const anchor = this.panel.getBoundingClientRect();
        // Wide enough to hold the row list, but never wider than the screen it
        // is drawn on — a popover hanging off a phone loses its right-hand column
        // of controls, and there is nothing to scroll it back into view
        const room = Math.max(MIN_PANEL.width, window.innerWidth - VIEWPORT_MARGIN * 2);
        const width = Math.min(room, Math.max(320, anchor.width));
        this.pickerEl.style.width = `${width}px`;

        // Uncapped first, so what comes back is the height it wants rather than
        // the height it was last allowed
        this.pickerEl.style.maxHeight = '';
        const wanted = this.pickerEl.getBoundingClientRect().height;

        const above = anchor.top - PICKER_GAP - PICKER_EDGE;
        const below = window.innerHeight - anchor.bottom - PICKER_GAP - PICKER_EDGE;
        // The last resort, and the one rule that has no exception: never higher
        // than the bottom of the header
        const acrossFrom = anchor.top + this._headerHeight() + PICKER_GAP;
        const across = window.innerHeight - acrossFrom - PICKER_EDGE;

        let top;
        let cap;
        if (wanted <= above) {
            top = anchor.top - wanted - PICKER_GAP;
            cap = above;
        } else if (wanted <= below) {
            top = anchor.bottom + PICKER_GAP;
            cap = below;
        } else if (above >= MIN_PICKER_HEIGHT && above >= below && above >= across) {
            // Only while the room above is worth having: squeezed below the
            // minimum it would be floored back up to it, and a floored popover
            // starting at the top of a window is one that reaches the header
            top = PICKER_EDGE;
            cap = above;
        } else if (below >= across) {
            top = anchor.bottom + PICKER_GAP;
            cap = below;
        } else {
            top = acrossFrom;
            cap = across;
        }

        this.pickerEl.style.maxHeight = `${Math.round(Math.max(MIN_PICKER_HEIGHT, cap))}px`;
        this.pickerEl.style.top = `${Math.round(Math.max(PICKER_EDGE, top))}px`;
        this.pickerEl.style.left = `${Math.round(Math.max(PICKER_EDGE, Math.min(anchor.left, window.innerWidth - width - PICKER_EDGE)))}px`;
    }

    _renderPicker() {
        // Reachable from a bulk change that a closed panel can still make
        if (!this.pickerEl) return;
        this.pickerEl.replaceChildren();

        const resolved = resolveRows(registeredRows(), this.settings);
        if (!resolved.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.textContent = 'No features have registered a row yet.';
            this.pickerEl.appendChild(empty);
            return;
        }

        // Chips that wrap, rather than one row per line. Fifteen rows as a
        // vertical list is a panel of scrollbar; as chips it is four lines.
        const chips = document.createElement('div');
        Object.assign(chips.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '8px' });
        for (const row of resolved) chips.appendChild(this._rowChip(row));
        this.pickerEl.appendChild(chips);

        // Beside the rows it acts on, not down among the layout buttons: this
        // one is about which tiles are on, which is exactly what the chips above
        // are for. It only shows tiles and hides them, so it sits apart from
        // Reset layout, which is about the arrangement.
        const tileActions = document.createElement('div');
        Object.assign(tileActions.style, { display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' });
        tileActions.appendChild(
            this._textButton(
                'Reset to default tiles',
                'Switch the rows back to the curated starting set, in its order. How wide they are is left alone.',
                () => this._resetTiles()
            )
        );
        this.pickerEl.appendChild(tileActions);

        this.pickerEl.appendChild(this._layoutControls());
        this.pickerEl.appendChild(this._namedLayoutBar());
    }

    /**
     * Read the saved layout names and redraw the popover around them.
     *
     * Kept off the render path — the popover is built synchronously and storage
     * is not — so the bar draws from whatever was last read and corrects itself
     * a moment later. The alternative is an async render, which means the gear
     * opens onto an empty popover.
     *
     * @returns {Promise<void>}
     */
    async _refreshLayoutNames() {
        this.savedLayouts = layoutNames(await loadLayouts());
        if (this.isPickerOpen) {
            this._renderPicker();
            this._placePicker();
        }
    }

    /**
     * Save, switch and delete, for layouts that have a name.
     *
     * Beside the row list rather than in a settings dialog, for the same reason
     * the display options are: somebody arranging an overlay is already looking
     * here, and a layout switcher two dialogs away is one nobody switches with.
     *
     * @returns {HTMLElement}
     */
    _namedLayoutBar() {
        const bar = document.createElement('div');
        Object.assign(bar.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexWrap: 'wrap',
            marginTop: '8px',
            paddingTop: '7px',
            borderTop: `1px solid ${COLORS.separator}`,
        });

        const label = document.createElement('span');
        label.textContent = 'Layouts';
        label.style.color = COLORS.textDim;
        bar.appendChild(label);

        const names = this.savedLayouts || [];
        // Presets included, so a fresh install has something in the dropdown —
        // and there is always something, which is why this control is never
        // disabled any more
        const offered = offeredLayouts(Object.fromEntries(names.map((name) => [name, true])));

        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        // Named so it stays findable now that the popover holds more than one
        select.dataset.overlayLayoutSelect = 'true';
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 4px',
            maxWidth: '150px',
        });
        // A placeholder rather than pre-selecting the first: this dropdown is a
        // switch, and one that arrives already reading "Dungeon" implies a
        // layout is in force that may not be
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Switch to…';
        select.appendChild(placeholder);
        for (const entry of offered) {
            const option = document.createElement('option');
            option.value = entry.name;
            option.textContent = entry.label;
            if (entry.preset) option.dataset.preset = 'true';
            select.appendChild(option);
        }
        select.addEventListener('change', async () => {
            const name = select.value;
            select.value = '';
            if (name) await this.applyNamedLayout(name);
        });
        bar.appendChild(select);

        const saveBtn = this._textButton('Save as…', 'Keep this arrangement under a name', () =>
            this._promptSaveLayout(bar)
        );
        bar.appendChild(saveBtn);

        // One press to resave the layout in force. Updating used to mean Save
        // as… and retyping the exact name — enough friction that layouts
        // quietly drifted from their saved copies instead. On a preset name
        // this saves the shadowing copy, which is the same thing "Save as…
        // Combat" always meant.
        if (this.appliedLayout) {
            const updateBtn = this._textButton(
                `Update "${this.appliedLayout}"`,
                'Resave that layout as what is on screen now',
                async () => {
                    const saved = await this.saveNamedLayout(this.appliedLayout);
                    updateBtn.textContent = saved ? 'Saved ✓' : 'Could not save';
                    setTimeout(() => {
                        if (this.isPickerOpen) {
                            this._renderPicker();
                            this._placePicker();
                        }
                    }, 900);
                }
            );
            bar.appendChild(updateBtn);
        }

        const deleteBtn = this._textButton('Delete', 'Forget a saved layout', () => this._promptDeleteLayout(select));
        deleteBtn.style.color = '#ff9d9d';
        // Only your own can be forgotten; the presets are not yours to lose
        deleteBtn.disabled = !names.length;
        if (!names.length) deleteBtn.style.opacity = '0.5';
        bar.appendChild(deleteBtn);

        // Which layout is actually in force.
        //
        // The dropdown deliberately reads "Switch to…" rather than the current
        // name, because a switch that arrives already reading "Dungeon" implies
        // a layout is in force that may not be. That leaves nothing at all
        // saying what *is* in force — and with auto-switching on, the panel can
        // change layout without anybody pressing anything. Two live-debugging
        // rounds were spent working out which layout a screenshot was of.
        if (this.appliedLayout) {
            const active = document.createElement('div');
            active.dataset.overlayActiveLayout = 'true';
            active.textContent = `Showing: ${this.appliedLayout}`;
            Object.assign(active.style, { color: COLORS.textDim, flexBasis: '100%', marginTop: '2px' });
            bar.appendChild(active);

            // Whether the screen still matches the saved copy, answered a beat
            // late (the stored file lives in IndexedDB). "(edited)" is what
            // makes the Update button legible: without it, "Showing: X" says a
            // layout is in force that the screen may have long since left.
            this._markAppliedLayoutDrift(active);
        }

        bar.appendChild(this._autoSwitchControls(offered));

        return bar;
    }

    /**
     * The auto-switch toggle, and what each layout is for.
     *
     * The two belong together and directly under the layout list, because
     * neither means anything without the other: a mapping with the switch off
     * does nothing, and the switch with no mappings falls back to presets a
     * player may not have looked at. Drawn as a second line of the same bar so
     * that reads as one control rather than as two settings that happen to be
     * adjacent.
     *
     * @param {Array<{name: string, preset: boolean, label: string}>} offered - What the dropdown offers
     * @returns {HTMLElement}
     */
    _autoSwitchControls(offered) {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            flexBasis: '100%',
            marginTop: '4px',
        });

        const toggle = this._optionBox('Switch layout with activity', 'autoSwitchLayout', {
            title:
                'Bring up the layout that suits what you are doing — fighting, skilling, a labyrinth run, or the ' +
                'marketplace. It waits ten seconds before following a change, never switches while the layout is ' +
                'unlocked, and stands down until the activity changes once you have picked a layout by hand.',
            // Turning it on is what reveals the mapping selectors below it
            after: () => {
                if (!this.isPickerOpen) return;
                this._renderPicker();
                this._placePicker();
            },
        });
        toggle.dataset.overlayAutoSwitch = 'true';
        wrap.appendChild(toggle);

        if (!this.settings.autoSwitchLayout) return wrap;

        const hint = document.createElement('span');
        hint.textContent = 'Use for:';
        hint.style.color = COLORS.textDim;
        wrap.appendChild(hint);

        for (const entry of offered) wrap.appendChild(this._activityPicker(entry));

        return wrap;
    }

    /**
     * One layout's "what is this for" selector.
     *
     * A preset defaults to the activity it was built for and can be pointed
     * somewhere else, which is the only way to say "use my Combat layout for
     * the labyrinth as well" without duplicating it.
     *
     * @param {{name: string, preset: boolean, label: string}} entry - A layout on offer
     * @returns {HTMLElement}
     */
    _activityPicker(entry) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '3px' });

        const name = document.createElement('span');
        name.textContent = entry.label;
        name.style.color = COLORS.textDim;
        wrap.appendChild(name);

        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        select.dataset.overlayActivityFor = entry.name;
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '1px 3px',
        });
        for (const [value, text] of [
            [ACTIVITY.NONE, 'none'],
            [ACTIVITY.COMBAT, 'combat'],
            [ACTIVITY.SKILLING, 'skilling'],
            [ACTIVITY.LABYRINTH, 'lab'],
            [ACTIVITY.MARKET, 'market'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        }

        select.value = this._activityFor(entry.name);
        select.addEventListener('change', () => {
            this.settings.layoutActivity = { ...(this.settings.layoutActivity || {}), [entry.name]: select.value };
            this._save();
            // What is on screen was not chosen for the new mapping, so the next
            // tick is allowed to act on it
            this.switchState = { ...this.switchState, applied: null };
        });
        wrap.appendChild(select);

        return wrap;
    }

    /**
     * What a layout is currently for.
     *
     * A preset with nothing said about it answers with the activity it was
     * built for, so the selectors read as already configured rather than as a
     * row of "none" that the player has to fill in before anything happens.
     *
     * @param {string} name - Layout name
     * @returns {string} One of `ACTIVITY`
     */
    _activityFor(name) {
        const stored = (this.settings.layoutActivity || {})[name];
        if (stored) return stored;
        return isPreset(name) ? PRESET_LAYOUTS[name].activity : ACTIVITY.NONE;
    }

    /**
     * Ask for a name, inline.
     *
     * `window.prompt` is blocked in a userscript context often enough to be
     * unreliable, and the choice dialog answers a question with buttons rather
     * than with text. One input in the bar it was summoned from is less than
     * either and is where the eye already is.
     *
     * @param {HTMLElement} bar - The layout bar to draw the input into
     */
    _promptSaveLayout(bar) {
        if (bar.querySelector('input[type="text"]')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Layout name';
        input.maxLength = MAX_LAYOUT_NAME;
        Object.assign(input.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 6px',
            width: '130px',
        });

        const commit = async () => {
            const name = normalizeName(input.value);
            input.remove();
            if (name) await this.saveNamedLayout(name);
        };

        input.addEventListener('keydown', (event) => {
            // Kept off the game, which listens for keys on the document
            event.stopPropagation();
            if (event.key === 'Enter') commit();
            else if (event.key === 'Escape') input.remove();
        });
        input.addEventListener('blur', () => commit());

        bar.appendChild(input);
        input.focus();
    }

    /**
     * Confirm and forget the layout the dropdown is showing, or the only one.
     *
     * The popover stands down for the question. It sits at popup z-index, above
     * the dialog's own backdrop, so left up it draws over the very buttons it
     * asked you to press — and a press aimed past it dismisses it rather than
     * answering. It comes back once there is an answer, redrawn around whatever
     * is left.
     *
     * @param {HTMLSelectElement} select - The layout dropdown
     */
    async _promptDeleteLayout(select) {
        const names = this.savedLayouts || [];
        if (!names.length) return;

        const wasPicking = this.isPickerOpen;
        if (wasPicking) this.closePicker();

        const answer = await askChoice({
            title: 'Delete a saved layout',
            message: 'Which one should be forgotten? The arrangement on screen is not touched.',
            choices: [
                ...names.map((name) => ({ value: name, label: name, tone: 'danger' })),
                { value: null, label: 'Cancel' },
            ],
        });

        if (answer) {
            select.value = '';
            this.savedLayouts = layoutNames(await deleteLayout(answer));
            // "Showing: Dungeon" over a Dungeon that no longer exists is a line
            // about nothing, and the Update button beside it would quietly
            // recreate what was just deleted
            if (normalizeName(answer) === this.appliedLayout) this._setAppliedLayout(null);
        }
        // Drawn from the names as they now stand, which is what makes a deleted
        // layout stop being on offer
        if (wasPicking) this.openPicker();
    }

    /**
     * The names of every saved layout, for anything outside the panel.
     * @returns {Promise<string[]>} Names
     */
    async listLayouts() {
        this.savedLayouts = layoutNames(await loadLayouts());
        return [...this.savedLayouts];
    }

    /**
     * Keep the current arrangement under a name.
     *
     * Written through `toOPanelConfig`, which is exactly what the export button
     * writes to a file — so a saved layout and an exported one are the same
     * thing, and switching to one goes through the reader the import already
     * uses rather than through a second path of its own.
     *
     * @param {string} name - What to call it
     * @returns {Promise<boolean>} Whether it was saved
     */
    async saveNamedLayout(name) {
        const key = normalizeName(name);
        if (!key) return false;

        try {
            const geometry = (await allGeometry())[GEOMETRY_KEY] || null;
            this.savedLayouts = layoutNames(await saveLayout(key, toOPanelConfig(this.settings, geometry)));
            if (this.isPickerOpen) {
                this._renderPicker();
                this._placePicker();
            }
            return true;
        } catch (error) {
            console.error('[OverlayPanel] Saving the named layout failed:', error);
            return false;
        }
    }

    /**
     * Append "(edited)" to the active-layout line when the screen has drifted
     * from the saved copy.
     *
     * Compared as the files the save button would write: `toOPanelConfig` of
     * the live settings against the stored file (or the preset's), both
     * reduced to their layout half — geometry is not part of what Update would
     * change, so it must not be able to say "edited" on its own.
     *
     * @param {HTMLElement} active - The "Showing: X" line to annotate
     */
    async _markAppliedLayoutDrift(active) {
        try {
            const key = normalizeName(this.appliedLayout);
            if (!key) return;
            const map = await loadLayouts();
            const saved = map[key]?.file || presetFile(key, { rows: registeredRows() });
            if (!saved || !active.isConnected) return;

            const layoutHalf = (file) => JSON.stringify(file?.toolasha?.settings ?? null);
            const drifted = layoutHalf(saved) !== layoutHalf(toOPanelConfig(this.settings, null));
            if (drifted) active.textContent = `Showing: ${this.appliedLayout} (edited)`;
        } catch (error) {
            console.error('[OverlayPanel] Comparing the applied layout failed:', error);
        }
    }

    /**
     * Switch to a saved layout, or to one of the presets.
     *
     * A saved layout wins over a preset of the same name, which is what makes
     * "Save as… Combat" a copy of the preset you can then change: the preset is
     * still there and still named that, and it is simply no longer what the
     * name resolves to.
     *
     * @param {string} name - Which one
     * @param {Object} [options] - `byHand: false` when auto-switching is applying it
     * @returns {Promise<boolean>} Whether it was applied
     */
    async applyNamedLayout(name, { byHand = true } = {}) {
        try {
            const map = await loadLayouts();
            const key = normalizeName(name);
            // Nothing to build it against: a preset is an order and a set of
            // spans, and is correct at whatever width it lands on
            const saved = map[key]?.file || presetFile(key, { rows: registeredRows() });
            if (!saved) return false;

            const read = fromOPanelConfig(saved);
            if (!read) return false;

            // Recorded before the layout is applied rather than after: applying
            // one takes an await, and a tick landing in the middle of it would
            // find auto-switching still unpaused and switch out from under the
            // choice being made
            if (byHand) this.switchState = pauseForManualChoice(this.switchState, currentActivity());
            this._setAppliedLayout(key);

            await this._applyLayout(read, `switch to ${key}`);
            return true;
        } catch (error) {
            console.error('[OverlayPanel] Switching to the saved layout failed:', error);
            return false;
        }
    }

    /**
     * One row's on/off chip, with the ordering controls it needs.
     * @param {Object} row - Resolved row
     * @returns {HTMLElement}
     */
    _rowChip(row) {
        const chip = document.createElement('label');
        chip.dataset.overlayRowChip = row.key;
        Object.assign(chip.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 7px',
            borderRadius: '4px',
            border: `1px solid ${COLORS.border}`,
            background: row.visible ? 'rgba(158, 196, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
            cursor: 'pointer',
        });

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = row.visible;
        checkbox.style.cursor = 'pointer';
        checkbox.addEventListener('change', () => {
            this.settings.visible = { ...this.settings.visible, [row.key]: checkbox.checked };
            // Switching it on is a question, and an empty tile is the answer to
            // it — see `_emptyPolicy`. Switching it off withdraws the question.
            if (checkbox.checked) this.justEnabled.add(row.key);
            else this.justEnabled.delete(row.key);
            this._save();
            this._renderPicker();
            this._renderBody();
        });

        const name = document.createElement('span');
        name.textContent = row.name;
        if (!row.visible) name.style.color = COLORS.textDim;

        // What this row promises about when it will appear, said before it is
        // switched on rather than discovered afterwards by its absence
        const contract = emptyContract(row);
        let badge = null;
        if (contract) {
            chip.title = `${row.name} — ${contract}.`;
            badge = document.createElement('span');
            badge.textContent = '◌';
            badge.dataset.overlayContract = row.key;
            badge.title = contract;
            badge.style.color = COLORS.textDim;
            badge.style.fontSize = '9px';
        }

        // Order still matters: it is what Autogrid packs by, and what a new row
        // is placed after
        const up = this._iconButton('◀', 'Earlier in the layout order', () => this._move(row.key, -1));
        const down = this._iconButton('▶', 'Later in the layout order', () => this._move(row.key, 1));
        for (const button of [up, down]) {
            button.style.fontSize = '8px';
            button.style.padding = '2px 1px';
            button.style.color = COLORS.textDim;
        }

        chip.append(checkbox, name, ...(badge ? [badge] : []), up, down);
        return chip;
    }

    /** Snap, Autogrid and Reset — everything that acts on the layout as a whole */
    /**
     * One checkbox bound to a layout setting.
     *
     * @param {string} label - What it says
     * @param {string} key - The setting it sets
     * @param {Object} [options] - `{on, title, after}` — `on` reads the current
     *   value, `after` runs once the setting has been written, for a box that
     *   changes what the popover itself contains
     * @returns {HTMLElement}
     */
    _optionBox(label, key, { on, title, after } = {}) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' });
        if (title) wrap.title = title;

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = on ? on(this.settings) : Boolean(this.settings[key]);
        box.style.cursor = 'pointer';
        box.addEventListener('change', () => {
            this.settings[key] = box.checked;
            this._save();
            this._renderBody();
            after?.();
        });

        wrap.append(box, document.createTextNode(label));
        return wrap;
    }

    /**
     * What every tile does before it has anything to show.
     *
     * Left alone it is per tile, which is the answer that is right most of the
     * time: a net worth about to be counted is worth a dim line, a dungeon run
     * that may never happen is not. The other three are for the two opinions the
     * per-tile answer cannot hold — "I want a tidy panel, hide all of it" and "I
     * want to see everything I switched on, even idle".
     *
     * @returns {HTMLElement}
     */
    _emptyTilesControl() {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' });
        wrap.title =
            'What a tile does before it has anything to show.\n\n' +
            'Dim name: it keeps its place in the grid and shrinks to a strip carrying its own name, so the ' +
            'line closes up without anything moving sideways. A tile with nothing to show and nowhere to ' +
            'click goes away instead, since its strip would offer nothing to do about it.\n' +
            'Dim name, always: the same, including those.\n' +
            'Hide: the tile goes away entirely, which leaves a gap where it sat in the grid.\n' +
            'Full message: it says at full size what it is waiting for.';

        const label = document.createElement('span');
        label.textContent = 'Empty tiles';
        label.style.color = COLORS.textDim;

        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        select.dataset.overlaySetting = 'emptyTiles';
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 4px',
        });
        for (const [value, text] of [
            // Named for what they do rather than for how they decide. "By tile"
            // described the mechanism to somebody who wanted to know the outcome.
            [EMPTY_POLICY.AUTO, 'Dim name'],
            [EMPTY_POLICY.COMPACT, 'Dim name, always'],
            [EMPTY_POLICY.HIDE, 'Hide'],
            [EMPTY_POLICY.FULL, 'Full message'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = this.settings.emptyTiles || EMPTY_POLICY.AUTO;
        select.addEventListener('change', () => {
            this.settings.emptyTiles = select.value;
            this._save();
            this._renderBody();
        });

        wrap.append(label, select);
        return wrap;
    }

    _layoutControls() {
        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        controls.appendChild(
            this._optionBox('Separators', 'separators', { on: (settings) => settings.separators !== false })
        );

        // How the luck tiles are drawn, kept beside the row list as OPanel
        // keeps them — somebody arranging an overlay is already looking here,
        // and would not think to open a settings dialog for it
        controls.appendChild(
            this._optionBox('Expected: only numbers', 'expectedOnlyNumbers', {
                title: 'Drop the names from Over Expected, leaving the percentages.',
            })
        );
        controls.appendChild(
            this._optionBox('Expected: only you', 'expectedOnlyPlayer', {
                title: 'Show only your own row in Over Expected, without the party or the total.',
            })
        );
        controls.appendChild(
            this._optionBox('Luck: only numbers', 'luckOnlyNumbers', {
                title: 'Drop the names from Drop Luck, leaving the percentages.',
            })
        );
        controls.appendChild(
            this._optionBox('Luck: only you', 'luckOnlyPlayer', {
                title: 'Show only your own row in Drop Luck, without the rest of the party.',
            })
        );

        controls.appendChild(this._emptyTilesControl());

        // The column count, steppable at last: the automatic law only ever
        // raises the authored count to what the width affords, so until this
        // control "fewer columns than fit" had no way to be said. Stepping
        // pins the count exactly; Auto hands it back to the width.
        const columnsBox = document.createElement('div');
        Object.assign(columnsBox.style, { display: 'inline-flex', alignItems: 'center', gap: '4px' });
        const fewerColumns = this._textButton('−', 'One column fewer, held at that count', () => this._stepColumns(-1));
        const moreColumns = this._textButton('+', 'One column more, held at that count', () => this._stepColumns(1));
        const columnsLabel = document.createElement('span');
        const pinnedColumns = this.settings.columnsPinned === true;
        columnsLabel.textContent = `Columns ${this.columns || this._columns()}${pinnedColumns ? '' : ' (auto)'}`;
        columnsLabel.style.color = COLORS.textDim;
        columnsLabel.style.minWidth = '86px';
        columnsBox.append(columnsLabel, fewerColumns, moreColumns);
        if (pinnedColumns) {
            const autoColumns = this._textButton('Auto', 'Let the panel width decide the column count again', () => {
                this.settings.columnsPinned = false;
                this._save();
                this._applyColumns();
                this._renderBody();
                this._renderPicker();
            });
            columnsBox.appendChild(autoColumns);
        }
        controls.appendChild(columnsBox);

        const textSize = document.createElement('div');
        Object.assign(textSize.style, { display: 'inline-flex', alignItems: 'center', gap: '4px' });
        const smaller = this._textButton('−', 'Smaller text in every tile', () => this._stepTextScale(-ZOOM_STEP));
        const larger = this._textButton('+', 'Larger text in every tile', () => this._stepTextScale(ZOOM_STEP));

        const scaleLabel = document.createElement('span');
        scaleLabel.textContent = `Text ${clampZoom(this.settings.textScale ?? 100)}%`;
        scaleLabel.style.color = COLORS.textDim;
        scaleLabel.style.minWidth = '62px';

        textSize.append(scaleLabel, smaller, larger);
        controls.appendChild(textSize);

        const importBtn = this._textButton(
            'Import layout',
            'Read a layout from an OPanel or Toolasha overlay file',
            () => this._importLayout()
        );
        const exportBtn = this._textButton('Export layout', 'Write this layout to a file OPanel can also read', () =>
            this._exportLayout()
        );

        const reset = this._textButton(
            'Reset layout',
            'Put the tiles back to the arrangement the script ships with',
            () => this._resetLayout()
        );
        reset.style.color = '#ff9d9d';
        reset.style.marginLeft = 'auto';

        // Only there when there is something to take back, so it never reads as
        // a button that does nothing
        const undo = this.undoState
            ? this._textButton(`Undo ${this.undoState.what}`, 'Put the layout back to before that', () => this._undo())
            : null;
        if (undo) undo.style.color = COLORS.accent;

        // There is no longer a "too narrow for your arrangement" case to explain,
        // because there is no arrangement that can fail to fit: a layout is an
        // order and a set of spans, and a span clamps to the columns there are.
        const hint = document.createElement('div');
        hint.textContent = this.settings.locked
            ? 'Unlock (🔒) to reorder tiles, set how wide they are, and size their text.'
            : 'Drag a tile to move it through the order, its right edge to set how many columns it takes, ' +
              'and hover it for − and + to size its text.';
        Object.assign(hint.style, { color: COLORS.textDim, flexBasis: '100%', marginTop: '2px' });

        controls.append(importBtn, exportBtn, ...(undo ? [undo] : []), reset, hint);
        return controls;
    }

    /**
     * @param {string} text - Label
     * @param {string} title - Tooltip
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _textButton(text, title, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '3px 8px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /**
     * @param {string} key - Row to move
     * @param {number} delta - -1 earlier, 1 later
     */
    _move(key, delta) {
        const next = moveRow(this.settings.order, key, delta);
        if (next === this.settings.order) return;

        this.settings.order = next;
        this._save();
        this._renderPicker();
    }

    /**
     * Keep the layout as it stands, so the next bulk change can be taken back.
     *
     * Autogrid, Reset and Import each throw away an arrangement that may have
     * taken a while to get right, and none of them can be judged until after it
     * has happened — you press Autogrid to find out what Autogrid does. Reset
     * tiles throws away a row selection instead of a geometry, so the snapshot
     * carries the selection too; the geometry-only callers snapshot it unchanged,
     * which restores as a no-op.
     *
     * @param {string} what - What is about to happen, for the button's label
     */
    _snapshot(what) {
        this.undoState = {
            what,
            // A span only means anything against the grid it was written for,
            // so the count and its pin have to come back with the spans — undone
            // without them, a two-column arrangement restored onto an imported
            // ten-column grid has every proportion in it flattened
            columns: this.settings.columns,
            columnsPinned: this.settings.columnsPinned === true,
            span: { ...this.settings.span },
            zoom: { ...this.settings.zoom },
            textScale: this.settings.textScale,
            visible: { ...this.settings.visible },
            order: [...(this.settings.order || [])],
            curatedDefaults: this.settings.curatedDefaults,
        };
    }

    /** Put the layout back to before the last bulk change */
    _undo() {
        if (!this.undoState) return;

        const { columns, columnsPinned, span, zoom, textScale, visible, order, curatedDefaults } = this.undoState;
        this.settings = {
            ...this.settings,
            columns,
            columnsPinned,
            span,
            zoom,
            textScale,
            visible,
            order,
            curatedDefaults,
        };
        this.undoState = null;
        this._save();
        this._applyColumns();
        if (this.panel) this.panel.style.fontSize = `${this._baseFontPx()}px`;
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /**
     * Put this character's rows back to the curated default set.
     *
     * The sibling of Reset layout, and deliberately separate from it: that one
     * forgets *where* tiles sit, this one forgets *which* tiles are on and in
     * what order. It is the answer to the overlay that has drifted into the
     * everything-on wall — clearing the explicit visibility map and the saved
     * order drops both back to what `resolveRows` reads off {@link CURATED_ROWS},
     * and turning `curatedDefaults` on opts a pre-curated character in, so a
     * layout arranged before the curated set existed can reach it too.
     *
     * Spans and text sizes are left alone: a reset that also flattened a
     * carefully arranged layout would be two undos wearing one button.
     */
    _resetTiles() {
        this._snapshot('tile reset');
        this.settings.visible = {};
        this.settings.order = [];
        this.settings.curatedDefaults = true;
        this.justEnabled.clear();
        this._save();
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /**
     * Put the layout back to a designed arrangement, and the panel with it.
     *
     * It used to only forget — positions, sizes, zooms — and leave the tiles to
     * be placed one at a time by the free-spot search, which on a set of tiles
     * of a dozen different widths is what produced the patchwork this button was
     * pressed to escape. So it forgets and then *arranges*: the same column pack
     * Autogrid uses, which is a grid rather than a pile.
     */
    async _resetLayout() {
        // Asked first. Import already asks, and this throws away exactly as much
        // — an arrangement somebody may have spent a while on — with the
        // difference that Import at least announces itself with a file picker.
        // Undo covers it, but Undo is one deep and is not where anybody looks
        // when they meant to press something else.
        const answer = await askChoice({
            title: 'Reset overlay layout',
            message:
                'Put the tiles back to the arrangement the script ships with. ' +
                'Which tiles are switched on is not changed.',
            choices: [
                { value: 'reset', label: 'Reset layout', tone: 'primary' },
                { value: null, label: 'Cancel' },
            ],
        });
        if (!answer) return;

        this._snapshot('Reset');
        // Reset is a move away from every named layout, not an edit of the one
        // in force: what is on screen afterwards is the shipped arrangement
        this._setAppliedLayout(null);

        // The Default preset's own order and spans, for the rows this character
        // actually has on — "forget the arrangement" now has an arrangement to
        // go back to, rather than a packer to re-run
        const shipped = PRESET_LAYOUTS.Default;
        const known = new Set(registeredRows().map((row) => row.key));
        const first = shipped.order.filter((key) => known.has(key));
        const rest = (this.settings.order || []).filter((key) => !first.includes(key));

        this.settings.order = [...first, ...rest];
        this.settings.span = { ...shipped.span };
        this.settings.zoom = {};
        this.settings.textScale = 100;
        // "The arrangement the script ships with" is unpinned — a pin from
        // before Reset would hold the shipped spans to whatever grid was
        // pinned, which for a 1-column pin flattens every span back to one.
        this.settings.columns = 2;
        this.settings.columnsPinned = false;

        clearGeometry(GEOMETRY_KEY);
        this.panel.style.width = `${DEFAULT_PANEL.width}px`;
        this.panel.style.height = `${DEFAULT_PANEL.height}px`;
        this.panel.style.fontSize = `${this._baseFontPx()}px`;
        // The design size is a desktop's; on a phone it is wider than the screen
        this._clampToViewport();
        this._applyColumns();

        this._save();
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    /**
     * Write this layout to a file.
     *
     * In OPanel's shape rather than in one of our own, because a format only
     * this script can read is a format that strands the layout here. Rows OPanel
     * has no name for are left out — see `utils/opanel-config.js`.
     */
    async _exportLayout() {
        try {
            const geometry = (await allGeometry())[GEOMETRY_KEY] || null;
            const file = toOPanelConfig(this.settings, geometry);
            const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `toolasha-overlay-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (error) {
            console.error('[OverlayPanel] Exporting the layout failed:', error);
            window.alert('Could not write the layout file.');
        }
    }

    /** Read a layout from an OPanel file, or from one of ours */
    _importLayout() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const read = fromOPanelConfig(JSON.parse(await file.text()));
                if (!read) {
                    window.alert('That file is not an OPanel or Toolasha overlay layout.');
                    return;
                }

                const rows = read.settings.order.length;
                const missing = read.unknown.length
                    ? `\n\n${read.unknown.length} row${read.unknown.length === 1 ? '' : 's'} in that file ` +
                      `${read.unknown.length === 1 ? 'has' : 'have'} no equivalent here and will be left out:\n` +
                      read.unknown.join(', ')
                    : '';

                const answer = await askChoice({
                    title: 'Import overlay layout',
                    message: `Replace this layout with ${rows} row${rows === 1 ? '' : 's'} from the file.${missing}`,
                    choices: [
                        { value: 'import', label: 'Replace layout', tone: 'primary' },
                        { value: null, label: 'Cancel' },
                    ],
                });
                if (!answer) return;

                await this._applyLayout(read, 'Import');
            } catch (error) {
                console.error('[OverlayPanel] Importing the layout failed:', error);
                window.alert('Could not read that file.');
            }
        });
        input.click();
    }

    /**
     * Put a layout that has already been read into effect.
     *
     * Split out of `_importLayout` rather than left inside it because a named
     * layout is the same operation with the file coming from storage instead of
     * from disk — and a second copy of this is a second set of bugs about tiles
     * arriving unplaced. Everything here works on `read` as `fromOPanelConfig`
     * returns it, so both callers agree by construction.
     *
     * @param {Object} read - What `fromOPanelConfig` returned
     * @param {string} what - What to call this on the Undo button
     * @returns {Promise<void>}
     */
    async _applyLayout(read, what) {
        this._snapshot(what);

        // A layout arrives either already in this overlay's own terms — an
        // order and a set of spans — or as pixels, from OPanel or from a file
        // this overlay wrote before the flow rework. Pixels go through the same
        // `migrate` a stored v1 record does, so an old file costs no second
        // code path and an OPanel one costs none at all.
        const arriving = read.settings.version >= 2 ? read.settings : { ...read.settings, ...migrate(read.settings) };
        this.settings = { ...this.settings, ...arriving };
        // Nothing carries pixels any more, and a stale pair left behind would be
        // written back out on the next export
        delete this.settings.positions;
        delete this.settings.sizes;
        delete this.settings.snapToGrid;
        // An arriving layout's column count is advisory (the automatic law
        // raises it to the width), not a pin — unless the layout itself was
        // saved with one. A pin from the previous arrangement must not hold a
        // preset to the wrong grid.
        if (arriving.columnsPinned !== true) this.settings.columnsPinned = false;

        this._save();

        // The frame a file remembers is restored as it was written. There is
        // nothing to grow it to any more: a layout fits whatever width it lands
        // on, so an imported one cannot arrive half below the fold.
        const geometry = read.geometry || {};
        if (Object.keys(geometry).length) await saveGeometry(GEOMETRY_KEY, geometry);
        await restoreGeometry(this.panel, GEOMETRY_KEY, { width: 220, height: 120 });

        // The arriving layout brings its own column count and its own text
        // scale, and neither is picked up by drawing alone: the grid reads the
        // count from a custom property and the panel's base font size is set on
        // the frame. Left out, an imported four-column layout is drawn on the
        // two columns the last one had, which flattens every span in it.
        this._applyColumns();
        if (this.panel) this.panel.style.fontSize = `${this._baseFontPx()}px`;

        this._refreshLockButton();
        this._refreshStacking();
        this._renderPicker();
        this._renderBody();
        this._placePicker();
    }

    /**
     * The panel's base text size.
     *
     * Every tile's own zoom is a percentage of this, so the global control
     * scales the whole panel while leaving the differences between tiles intact
     * — a tile you made 130% stays half again as large as its neighbours.
     *
     * @returns {number} Pixels
     */
    _baseFontPx() {
        return (13 * clampZoom(this.settings.textScale ?? 100)) / 100;
    }

    /**
     * Change the base text size for every tile at once.
     * @param {number} delta - Percentage points
     */
    /**
     * Pin the column count one step up or down from what is drawn now.
     *
     * From the *effective* count, not the stored one: unpinned, the stored
     * number and the drawn number routinely differ (the width raised it), and
     * a first press that appeared to do nothing would read as a broken button.
     * @param {number} delta - +1 or -1
     */
    _stepColumns(delta) {
        const current = this.columns || this._columns();
        const next = Math.min(MAX_SPAN, Math.max(1, current + delta));
        if (next === current && this.settings.columnsPinned === true) return;

        this.settings.columns = next;
        this.settings.columnsPinned = true;
        this._save();
        this._applyColumns();
        this._renderBody();
        this._renderPicker();
        this._placePicker();
    }

    _stepTextScale(delta) {
        const next = clampZoom((this.settings.textScale ?? 100) + delta);
        if (next === this.settings.textScale) return;

        this.settings.textScale = next;
        this._save();
        if (this.panel) this.panel.style.fontSize = `${this._baseFontPx()}px`;
        this._renderPicker();
        this._placePicker();
    }

    /**
     * How many columns the canvas currently holds.
     *
     * The only measured quantity in the whole panel, and it is an integer — see
     * `columnsFor`. Measured from the scroller's border box rather than its
     * content box, so a scrollbar arriving cannot change it; with a stable
     * gutter it does not change the content box either, but the border box is
     * the honest thing to ask and costs nothing.
     *
     * @returns {number} Between 1 and `MAX_SPAN`
     */
    _columns() {
        const outer = this.scrollEl?.offsetWidth || this.scrollEl?.clientWidth || DEFAULT_PANEL.width;
        return columnsForLayout(outer - SCROLLER_PADDING, this.settings.columns, {
            pinned: this.settings.columnsPinned === true,
        });
    }

    /**
     * Tell the grid how many columns it has.
     *
     * Written to a custom property rather than to `grid-template-columns`
     * directly, so the rule that reads it is set once when the canvas is built
     * and this is a single small write on resize.
     */
    _applyColumns() {
        if (!this.canvasEl) return;
        const columns = this._columns();
        if (columns === this.columns) return;

        this.columns = columns;
        this.canvasEl.style.setProperty(COLUMN_VARIABLE, String(columns));
    }

    /**
     * The rows to draw, in the order they are to be read.
     *
     * All of the layout there is. `resolveRows` puts the saved order first and
     * anything it has never heard of after it; everything else here is a span
     * clamped to the columns that exist and a height floor the row declared for
     * itself.
     *
     * @returns {Array<Object>} Visible rows, each with `span`, `minHeight` and `zoom`
     */
    _visibleRows() {
        const columns = this.columns || this._columns();
        const spans = this.settings.span || {};
        const zooms = this.settings.zoom || {};

        return resolveRows(registeredRows(), this.settings)
            .filter((row) => row.visible)
            .map((row) => ({
                ...row,
                span: spanFor(spans[row.key] ?? seedSpan(row), columns),
                minHeight: row.defaultSize?.height > 0 ? row.defaultSize.height : DEFAULT_TILE_HEIGHT,
                zoom: clampZoom(zooms[row.key] ?? row.defaultZoom ?? DEFAULT_ZOOM),
            }));
    }

    /**
     * Draw every switched-on row, then decide what the empty ones do about it.
     *
     * Two passes, because emptiness is only knowable by asking the row to draw —
     * there is no cheap "have you anything to say" a feature could answer — and
     * what a tile does when empty changes how much room it takes. So: lay
     * everything out at its full size and draw it, see what came back blank, and
     * lay it out again without the tiles that stood down.
     *
     * The second pass only happens when something is actually empty, and both
     * are arithmetic over a dozen rows. The alternative — deciding from last
     * second's emptiness — costs a frame of lag on every tile that starts or
     * stops reporting, which is exactly the moment you are looking at it.
     */
    _renderBody(reason = '') {
        if (reason) {
            this.drawReason = reason;
            this.drawAutomatic = true;
        }
        // Anything a draw disturbs — a tile's height, the canvas's extent, the
        // panel's own box — must not be able to ask for another draw from
        // inside this one. Every observer on the panel checks this flag.
        this.redrawing = true;
        try {
            this._drawBody();
        } finally {
            this.redrawing = false;
        }
    }

    /**
     * Whether there is budget left to draw, and stop everything if there is not.
     *
     * A brake, and it is here rather than at any particular suspected loop
     * because of what the failure was: a userscript froze the game tab hard
     * enough that the debugger could not attach to ask it why. Whatever the
     * cause, and however carefully the next one is reasoned about, the overlay
     * must not be able to do that. A degraded overlay beats a dead browser, and
     * it beats it by so much that the trade is not worth thinking about.
     *
     * Only draws nobody asked for are counted. A drag reorders on every pointer
     * move and is meant to; the tick is once a second and cannot run away by
     * itself. What this catches is a feedback loop — a draw that changes a size,
     * which a `ResizeObserver` sees, which draws again — where the frames come
     * back to back and each one is a full rebuild of two dozen tiles.
     *
     * @returns {boolean} False when the panel has drawn too often to be trusted
     */
    _takeDrawBudget() {
        const now = Date.now();
        if (now < this.drawPausedUntil) return false;

        // Only draws nobody asked for are counted, and anything anybody *did*
        // ask for clears the tally. A loop is a chain of automatic redraws with
        // no request anywhere in it; a burst of explicit ones — a preset
        // applied, a row toggled, a test driving the panel — is not a loop
        // however fast it goes.
        if (!this.drawAutomatic) {
            this.drawWindowAt = now;
            this.drawsInWindow = 0;
            return true;
        }

        if (now - this.drawWindowAt > DRAW_WINDOW_MS) {
            this.drawWindowAt = now;
            this.drawsInWindow = 0;
        }

        this.drawsInWindow += 1;
        if (this.drawsInWindow <= MAX_DRAWS_PER_WINDOW) return true;

        this.drawPausedUntil = now + DRAW_COOLDOWN_MS;
        this.drawsInWindow = 0;
        console.error(
            `[OverlayPanel] Redrew more than ${MAX_DRAWS_PER_WINDOW} times in ${DRAW_WINDOW_MS}ms, which is a ` +
                `feedback loop rather than anything a player did. Pausing the overlay for ${DRAW_COOLDOWN_MS}ms ` +
                'rather than letting it lock the tab. Last redraw was asked for by:',
            this.drawReason || 'unknown'
        );
        return false;
    }

    /** The drawing itself — see {@link _renderBody}, which is how it is reached */
    _drawBody() {
        if (!this.canvasEl) return;
        // A refresh rewrites every tile's position and size from the saved
        // layout, which mid-drag means the tile snapping back under the pointer
        // one second in. Nothing needs redrawing while a gesture is in progress
        // anyway.
        if (this.interacting) return;
        if (!this._takeDrawBudget()) return;
        this.drawAutomatic = false;

        const full = this._visibleRows();
        if (!full.length) {
            this.tiles.clear();
            this.canvasEl.replaceChildren();
            this.canvasEl.appendChild(
                this._canvasNote(
                    registeredRows().length ? 'Every row is switched off — see ⚙.' : 'Nothing to show yet.'
                )
            );
            return;
        }

        const wanted = new Set(full.map((row) => row.key));
        for (const [key, tile] of this.tiles) {
            if (!wanted.has(key)) {
                tile.remove();
                this.tiles.delete(key);
            }
        }
        // The note from an earlier render with nothing in it
        for (const child of [...this.canvasEl.children]) {
            if (!child.dataset.overlayRow) child.remove();
        }

        // One pass. Draw every tile, then say what the empty ones do about it —
        // and that is the end of it, because the grid works out the rest. There
        // used to be a second layout pass here for the tiles that stood down and
        // a third that measured what each one had drawn; both were the browser's
        // job being done in JavaScript once a second.
        let drawn = 0;
        for (const row of full) {
            const tile = this._tileFor(row);
            this._styleTile(tile, row);

            const blank = this._drawRow(tile, row);
            // It has been seen working, which is all a switched-on tile was
            // ever owed — see `_emptyPolicy`
            if (!blank) this.justEnabled.delete(row.key);

            const policy = blank ? this._emptyPolicy(row) : null;
            if (policy === EMPTY_POLICY.COMPACT) this._drawCompact(tile, row);
            else if (policy === EMPTY_POLICY.FULL) this._drawPlaceholder(tile, row);

            // A hidden tile leaves the flow and everything after it closes up.
            // Kept rather than destroyed: it is one refresh away from having
            // something to say, and rebuilding it every second would churn the
            // DOM and its listeners for a tile nobody can see.
            const gone = policy === EMPTY_POLICY.HIDE ? 'none' : '';
            if (tile.style.display !== gone) tile.style.display = gone;
            if (!gone) drawn += 1;
        }

        // Reading order *is* the layout, so the DOM has to be in it — which also
        // makes the panel tabbable and coherent to a screen reader, for free
        this._orderTiles(full);

        if (!drawn) {
            this.canvasEl.appendChild(this._canvasNote('Nothing to report yet — tiles appear as data arrives.'));
        }
    }

    /**
     * Put the tiles in the document in the order they are meant to be read.
     *
     * Only where they are not already, because moving a node the grid is drawing
     * costs a reflow and this runs every tick for a list that changes when
     * somebody drags something.
     *
     * @param {Array<Object>} rows - The visible rows, in order
     */
    _orderTiles(rows) {
        let previous = null;
        for (const row of rows) {
            const tile = this.tiles.get(row.key);
            if (!tile) continue;

            const wanted = previous ? previous.nextSibling : this.canvasEl.firstChild;
            if (tile !== wanted) this.canvasEl.insertBefore(tile, wanted);
            previous = tile;
        }
    }

    /**
     * A dim line in the canvas itself, for when there are no tiles to draw.
     * @param {string} text - What it says
     * @returns {HTMLElement}
     */
    _canvasNote(text) {
        const note = document.createElement('div');
        note.style.color = COLORS.textDim;
        note.textContent = text;
        return note;
    }

    /**
     * Put a tile where the layout says, at the size and text scale it says.
     * @param {HTMLElement} tile - The tile
     * @param {Object} row - Its laid-out row
     */
    _styleTile(tile, row) {
        if (!tile) return;
        // Written property by property, and only where the value differs. Every
        // assignment to `style` invalidates the element whether or not it changed
        // anything, and this runs for every tile on every tick — a dozen tiles ×
        // eleven properties a second, for a layout that changes when somebody
        // drags a tile. Reading `style.x` back is a cheap inline-style read; it
        // does not touch layout.
        const want = {
            display: '',
            // The whole of a tile's geometry. Width comes from the columns it
            // spans, height from what it drew — with a floor its own row
            // declared, which keeps a tile whose content changes every second
            // from resizing the grid under the reader.
            gridColumn: `span ${row.span}`,
            minHeight: `${row.minHeight}px`,
            fontSize: `${row.zoom}%`,
            cursor: this.isEditable ? 'move' : row.onOpen ? 'pointer' : 'default',
            // While unlocked a finger drag must not become a scroll; locked
            // again, the panel's own scrolling comes back
            touchAction: this.isEditable ? 'none' : '',
        };
        for (const [property, value] of Object.entries(want)) {
            if (tile.style[property] !== value) tile.style[property] = value;
        }

        // The borders are their own case: `border` is a shorthand that resets the
        // bottom edge, so the two have to be written in order and remembered
        // rather than read back — the shorthand getter returns '' as soon as the
        // sides differ, which would make every tick look like a change.
        //
        // Editing shows the tile's own dashed outline; otherwise a rule under each
        // one, which is what gives a column of tiles the ruled look rather than a
        // floating jumble.
        const border = this.isEditable ? `1px dashed ${COLORS.tileEdit}` : '1px solid transparent';
        const separator =
            this.isEditable || this.settings.separators === false ? null : `1px solid ${COLORS.separator}`;
        if (tile._styleBorder !== border) {
            tile.style.border = border;
            tile._styleBorder = border;
            // Whatever the bottom edge was, the shorthand has just replaced it
            tile._styleSeparator = null;
        }
        if (separator !== tile._styleSeparator) {
            // No separator wanted means the shorthand's own bottom edge, which is
            // what is there whenever the shorthand was the last thing written
            if (separator === null) tile.style.border = border;
            else tile.style.borderBottom = separator;
            tile._styleSeparator = separator;
        }

        const grip = this.isEditable ? '' : 'none';
        if (tile._grip.style.display !== grip) tile._grip.style.display = grip;
        if (!this.isEditable && tile._zoom.style.display !== 'none') tile._zoom.style.display = 'none';
    }

    /**
     * Ask a row to draw itself, and say whether it drew anything.
     *
     * @param {HTMLElement} tile - The tile
     * @param {Object} row - The resolved row
     * @returns {boolean} True when the tile came back blank
     */
    _drawRow(tile, row) {
        try {
            // A row that can summarise its own inputs gets to say "still the
            // same", and the tile keeps what it already shows. This is a whole
            // render — DOM rebuild included — skipped per tile per second, and
            // the answer is nearly always "same" for a tile nothing has touched.
            let version;
            if (typeof row.version === 'function') {
                version = row.version();
                if (version !== undefined && tile._version === version && typeof tile._wasEmpty === 'boolean') {
                    // Nothing was rebuilt, so whatever was measured of it stands
                    tile._redrawn = false;
                    return tile._wasEmpty;
                }
            }

            // Left dim by a previous failure, the tile stays dim for every
            // successful render after it
            if (tile._content.style.color) tile._content.style.color = '';
            // Timed per row, because the tick's total says the overlay was
            // busy and only this says which tile — most rows have no
            // `version()` and pay their full compute every second even when
            // the draw-signature skip saves the DOM write
            const drawStart = performance.now();
            row.render(tile._content);
            performanceMonitor.record(`overlayRow:${row.key}`, performance.now() - drawStart);
            tile._version = version;
            // The content is new, so the height measured off the old content is
            // no longer an answer about this tile — see `_drawnHeight`
            tile._redrawn = true;
        } catch (error) {
            console.error(`[OverlayPanel] Row "${row.key}" failed to render:`, error);
            tile._content.textContent = `${row.name}: unavailable`;
            tile._content.style.color = COLORS.textDim;
            // Nothing about a failed render is worth reusing next tick
            tile._version = undefined;
            tile._wasEmpty = undefined;
            tile._redrawn = true;
            // A row that fell over is not a row with nothing to report, and
            // hiding it would hide the failure with it
            return false;
        }
        // An icon is content even with no text beside it — a tile showing only
        // a coin has drawn what it meant to
        tile._wasEmpty = !tile._content.textContent.trim() && !tile._content.querySelector('svg, img');
        return tile._wasEmpty;
    }

    /**
     * What this tile does while it has nothing to show.
     *
     * Never anything but the full placeholder while the layout is unlocked: the
     * point of unlocking is to arrange the tiles, and a tile that has hidden
     * itself is one you cannot place, while a tile shrunk to a strip is one you
     * cannot judge the size of. Arranging is the one moment you want to see
     * everything you have switched on, at the size it will be.
     *
     * The same goes, for the same reason, for a tile that was just switched on
     * by hand. `hide-until-data` is the right passive default and a wrong answer
     * to a gesture: the player ticks Guild Trials, nothing appears, and the only
     * available reading is that the script is broken — which is how this
     * arrived, as a bug report, during a live trial. So a manually enabled row
     * draws its placeholder, and goes on drawing it until it has something real
     * to say. The acknowledgment is discharged by the first successful draw
     * rather than by a timer: what it owes the player is one look at a working
     * tile, and once they have had it the decluttering rule is welcome back.
     * Nothing is persisted — a reload is a new session and a new set of
     * questions. Somebody who wants placeholders permanently has the `emptyTiles`
     * setting, which is the durable version of this and beats it either way.
     *
     * The cost of that is real and worth naming: a row switched on yesterday
     * that still has no data is hidden again today, with only the ⚙ badge to say
     * why. The alternative — remembering forever that a row has never drawn —
     * would put a placeholder under every measurement tile in the curated set on
     * a fresh character's first open, which is the wall of promises this whole
     * policy exists to remove.
     *
     * @param {Object} row - The resolved row
     * @returns {string} One of {@link EMPTY_POLICY}
     */
    _emptyPolicy(row) {
        if (this.isEditable) return EMPTY_POLICY.FULL;
        // The setting is an explicit instruction and outranks the gesture
        if (this.settings.emptyTiles && this.settings.emptyTiles !== EMPTY_POLICY.AUTO) {
            return emptyPolicyFor(row, this.settings.emptyTiles);
        }
        if (this.justEnabled.has(row.key)) return EMPTY_POLICY.FULL;
        return emptyPolicyFor(row, this.settings.emptyTiles);
    }

    /**
     * Stand a tile down to a dim line carrying its own name.
     *
     * Its name rather than its placeholder, because the placeholders are not
     * unique — two tiles saying "Nothing watched" beside each other tell you
     * less than one, since now you cannot tell which feature is idle either.
     *
     * @param {HTMLElement} tile - The tile
     * @param {Object} row - The resolved row
     */
    _drawCompact(tile, row) {
        if (!tile) return;

        // From the box's own shape rather than from whatever the row left on it
        // — see `_resetContent`. A strip laid out by the grid a row had set up
        // for three columns of figures is a strip in one of those columns.
        const content = this._resetContent(tile);
        Object.assign(content.style, { display: 'flex', alignItems: 'center' });

        const note = document.createElement('div');
        note.textContent = compactLabel(row);
        Object.assign(note.style, {
            color: COLORS.textDim,
            fontSize: '85%',
            // Held to the tile it belongs to, and cut with an ellipsis rather
            // than allowed to reach for the room a neighbour is using
            minWidth: '0',
            maxWidth: '100%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        });
        content.appendChild(note);
        tile._redrawn = true;
    }

    /**
     * A tile's content box, back to the shape it was made with.
     *
     * Every row styles this box to draw itself and none of them puts it back —
     * `blank` clears the children and leaves the styling, which is right for the
     * row (it is about to draw again) and wrong for anyone else. The panel draws
     * into the same box for a tile that has stood down, and inherited a column,
     * or a grid of three, or a centred line, depending on what the row had been
     * showing when it last had something to show.
     *
     * @param {HTMLElement} tile - The tile
     * @returns {HTMLElement} Its content box, empty and plain
     */
    _resetContent(tile) {
        const content = tile._content;
        content.replaceChildren();
        content.style.cssText = '';
        Object.assign(content.style, CONTENT_STYLE);
        return content;
    }

    /**
     * Say, at full size, what the row would rather say when it has nothing.
     *
     * A blank tile looks broken rather than idle: you cannot tell a feature that
     * has nothing to report from one that has fallen over. The row says what it
     * would rather say; naming itself is the fallback, which at least identifies
     * which tile is which while the layout is being arranged.
     *
     * A tile drawn *because it was just switched on* gets its name above that
     * line as well. The player has one row in mind and a dozen tiles on screen,
     * and a placeholder that only says "Open the guild Trials tab once" leaves
     * them hunting for which tile answered them.
     *
     * @param {HTMLElement} tile - The tile
     * @param {Object} row - The resolved row
     */
    _drawPlaceholder(tile, row) {
        if (!tile) return;

        const content = this._resetContent(tile);
        Object.assign(content.style, { display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' });

        const shared = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' };
        const lines = [];

        const acknowledging = this.justEnabled.has(row.key) && !this.isEditable;
        if (acknowledging) {
            const label = document.createElement('div');
            label.textContent = row.name;
            Object.assign(label.style, { color: COLORS.textDim, ...shared });
            lines.push(label);
        }

        const note = document.createElement('div');
        note.textContent = acknowledging
            ? `${waitingLine(row)} — ${row.empty || `no ${row.name.toLowerCase()} yet`}`
            : row.empty || `No ${row.name.toLowerCase()} data`;
        Object.assign(note.style, {
            color: COLORS.textDim,
            ...(acknowledging ? { fontSize: '85%' } : {}),
            ...shared,
        });
        lines.push(note);

        content.append(...lines);
        tile._redrawn = true;
    }

    /**
     * The tile for a row, made once and kept.
     *
     * Tiles survive refreshes rather than being rebuilt, because a row that draws
     * something interactive should not be replaced out from under the pointer
     * once a second — and because the drag listeners would otherwise stack up at
     * the same rate.
     *
     * @param {Object} row - Laid-out row
     * @returns {HTMLElement} The tile
     */
    _tileFor(row) {
        const existing = this.tiles.get(row.key);
        if (existing) return existing;

        const tile = document.createElement('div');
        tile.dataset.overlayRow = row.key;
        Object.assign(tile.style, {
            position: 'relative',
            boxSizing: 'border-box',
            overflow: 'hidden',
            borderRadius: '3px',
            padding: '1px 4px',
        });

        const content = document.createElement('div');
        Object.assign(content.style, CONTENT_STYLE);
        tile.appendChild(content);
        tile._content = content;

        // The right edge rather than the corner, because there is nothing left
        // to drag downwards: height is content now, and the only thing a tile
        // can be made is wider — in whole columns
        const grip = document.createElement('div');
        grip.title = 'Drag to set how many columns this tile takes';
        Object.assign(grip.style, {
            position: 'absolute',
            right: '0',
            top: '0',
            width: '8px',
            height: '100%',
            cursor: 'ew-resize',
            // Above the − and + buttons, which sit bottom left and on a narrow
            // tile reach this edge
            zIndex: '3',
            background: 'linear-gradient(90deg, transparent, rgba(158, 196, 255, 0.55))',
            borderTopRightRadius: '3px',
            borderBottomRightRadius: '3px',
            display: 'none',
        });
        tile.appendChild(grip);
        tile._grip = grip;

        this._attachTileDrag(tile, row.key);
        this._attachTileSpan(tile, grip, row.key);

        const zoomControl = this._tileZoomControl(tile, row.key);
        tile.appendChild(zoomControl);
        tile._zoom = zoomControl;

        if (row.onOpen) {
            tile.title = `Double-click to open or close ${row.name}`;
            const open = () => {
                try {
                    row.onOpen();
                } catch (error) {
                    console.error(`[OverlayPanel] Opening "${row.key}" failed:`, error);
                }
            };
            tile.addEventListener('dblclick', open);
            // A single tap on touch: double-tap fights the browser's own
            // tap-to-zoom heuristics, and the accidental-open worry that makes
            // desktop use double-click does not transfer — a tap that follows a
            // scroll gesture never fires click at all. Not while the layout is
            // unlocked, where a tap is the start of arranging, not a request.
            tile.addEventListener('click', () => {
                if (!hasCoarsePointer() || this.isEditable) return;
                open();
            });
        }

        this.canvasEl.appendChild(tile);
        this.tiles.set(row.key, tile);
        return tile;
    }

    /**
     * Drag a tile to move it through the order.
     *
     * The pointer machinery is what it always was; the arithmetic between
     * pointer-down and pointer-up is the whole change. Instead of snapping a
     * pixel offset and writing coordinates, the move handler asks `dropIndex`
     * which slot the pointer is over and splices the order when that is a
     * different one. The others slide because the grid reflows.
     *
     * A drop is a position in a list, so there is no invalid one — no tile can
     * land off the canvas, on top of a neighbour, or in a gap that stops
     * existing when the panel is resized.
     *
     * @param {HTMLElement} tile - The tile
     * @param {string} key - Row key
     */
    _attachTileDrag(tile, key) {
        let dragging = false;

        const boxes = () =>
            [...this.canvasEl.querySelectorAll('[data-overlay-row]')]
                .filter((element) => element.style.display !== 'none')
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        key: element.dataset.overlayRow,
                        left: rect.left,
                        top: rect.top,
                        right: rect.right,
                        bottom: rect.bottom,
                    };
                });

        const onPointerMove = (event) => {
            if (!dragging) return;

            const laid = boxes();
            const slot = dropIndex(laid, { x: event.clientX, y: event.clientY });
            // `dropIndex` counts slots in the list as drawn, which still holds
            // the dragged tile; `moveTo` wants the slot in the list without it
            const from = laid.findIndex((box) => box.key === key);
            const next = moveTo(this.settings.order, key, from >= 0 && slot > from ? slot - 1 : slot);
            if (next === this.settings.order) return;

            this.settings.order = next;
            // Redrawn rather than reordered by hand: the draw is what knows
            // which tiles are on screen, and reordering is a DOM move either way
            this.interacting = false;
            this._drawBody();
            this.interacting = true;
            tile.style.opacity = '0.65';
            tile.style.zIndex = '2';
        };

        const onPointerUp = () => {
            if (!dragging) return;
            dragging = false;
            this.interacting = false;
            tile.style.opacity = '';
            tile.style.zIndex = '';
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            this._save();
            this._renderBody();
        };

        tile.addEventListener('pointerdown', (event) => {
            // Not while locked, and never from the span handle or the text-size
            // buttons, which are their own gestures
            if (!this.isEditable || event.button !== 0) return;
            if (tile._grip?.contains(event.target) || tile._zoom?.contains(event.target)) return;

            dragging = true;
            this.interacting = true;
            // Lifted rather than moved: the tile stays in the flow, so the grid
            // goes on drawing it where it currently belongs while the rest slide
            tile.style.opacity = '0.65';
            tile.style.zIndex = '2';
            event.preventDefault();

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        });
    }

    /**
     * Drag a tile's right edge to set how many columns it takes.
     *
     * Height is not resizable, because height is content. Width is a whole
     * number of columns, so this steps rather than slides: the span follows the
     * pointer to the nearest column boundary and is clamped to the columns there
     * are, which is what keeps the result meaningful at every other width.
     *
     * @param {HTMLElement} tile - The tile
     * @param {HTMLElement} grip - Its right-edge handle
     * @param {string} key - Row key
     */
    _attachTileSpan(tile, grip, key) {
        let startX = 0;
        let startSpan = 1;
        let sizing = false;

        const columnWidth = () => {
            const columns = this.columns || 1;
            const width = this.canvasEl?.clientWidth || DEFAULT_PANEL.width;
            return Math.max(1, (width - GAP * (columns - 1)) / columns);
        };

        const onPointerMove = (event) => {
            if (!sizing) return;

            const steps = Math.round((event.clientX - startX) / columnWidth());
            const wanted = spanFor(startSpan + steps, this.columns || 1);
            if (wanted === this.settings.span?.[key]) return;

            this.settings.span = { ...(this.settings.span || {}), [key]: wanted };
            tile.style.gridColumn = `span ${wanted}`;
        };

        const onPointerUp = () => {
            if (!sizing) return;
            sizing = false;
            this.interacting = false;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            this._save();
            this._renderBody();
        };

        grip.addEventListener('pointerdown', (event) => {
            if (!this.isEditable || event.button !== 0) return;

            sizing = true;
            this.interacting = true;
            startX = event.clientX;
            startSpan = spanFor(this.settings.span?.[key] ?? 1, this.columns || 1);
            event.preventDefault();
            event.stopPropagation();

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        });
    }

    /**
     * The − and + a tile shows while the layout is unlocked.
     *
     * Buttons rather than Ctrl+scroll, which is what this was: Ctrl+wheel is the
     * browser's own page-zoom gesture, and a page that zooms when you meant to
     * resize one tile is worse than no shortcut at all. Buttons are also
     * findable, where a modifier gesture has to be told to you.
     *
     * Only while unlocked, and only on hover — the rest of the time a tile is
     * something you read, and two buttons sitting on top of the figure are two
     * buttons in the way.
     *
     * @param {HTMLElement} tile - The tile
     * @param {string} key - Row key
     * @returns {HTMLElement} The control, hidden until hovered
     */
    _tileZoomControl(tile, key) {
        const holder = document.createElement('div');
        Object.assign(holder.style, {
            position: 'absolute',
            // Bottom left: top right is where a tile's value sits. The resize
            // grip is bottom right and is drawn above these, so on a tile too
            // narrow to hold both it is the corner that wins.
            left: '1px',
            bottom: '1px',
            display: 'none',
            gap: '1px',
            background: 'rgba(8, 10, 20, 0.9)',
            borderRadius: '3px',
            zIndex: '1',
            // Never under the grip where there is room to avoid it
            maxWidth: 'calc(100% - 14px)',
        });

        const step = (delta) => {
            const current = this.settings.zoom?.[key] ?? 100;
            const next = clampZoom(current + delta);
            if (next === current) return;

            this.settings.zoom = { ...this.settings.zoom, [key]: next };
            this._save();
            this._renderBody();
        };

        for (const [label, delta] of [
            ['−', -ZOOM_STEP],
            ['+', ZOOM_STEP],
        ]) {
            const button = document.createElement('button');
            button.textContent = label;
            button.title = `${label === '+' ? 'Larger' : 'Smaller'} text in this tile`;
            Object.assign(button.style, {
                background: 'rgba(255, 255, 255, 0.1)',
                border: `1px solid ${COLORS.border}`,
                borderRadius: '3px',
                color: COLORS.text,
                cursor: 'pointer',
                fontSize: '11px',
                lineHeight: '1',
                padding: '2px 5px',
            });
            button.addEventListener('mousedown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                step(delta);
            });
            holder.appendChild(button);
        }

        // Shown on hover, but only when there is something to hover for
        tile.addEventListener('mouseenter', () => {
            if (this.isEditable) holder.style.display = 'flex';
        });
        tile.addEventListener('mouseleave', () => (holder.style.display = 'none'));

        return holder;
    }

    /**
     * Put the docked panel back after React has rebuilt the column.
     *
     * Switching tabs re-renders the column, which drops both the panel and the
     * class the sheet keys off. Cheap enough to check on every tick, and the
     * alternative — a MutationObserver on a container that churns on every
     * combat tick — costs more than the check it would be avoiding.
     */
    _ensureDocked() {
        if (!this.panel || this.panel.dataset.docked !== 'true') return;

        if (this.panel.isConnected && this.dockHost?.isConnected) {
            this.dockHost.classList.add(DOCK_HOST_CLASS);
            return;
        }
        const host = this._findDockHost();
        if (!host) return;

        host.classList.add(DOCK_HOST_CLASS);
        host.appendChild(this.panel);
        this.dockHost = host;
        this._fitDock();
        // A new column is a new box to follow
        this._watchDock();
    }

    _startRefreshing() {
        if (this.refreshId) return;
        this.refreshId = setInterval(() => {
            // A background tab draws nothing anyone sees, and a docked panel
            // whose column is gone has nothing to draw into until it is back
            if (document.hidden) return;
            this._ensureDocked();
            if (!this.panel?.isConnected) return;
            this._renderBody();
            // `_fitDock` is not on the tick any more: it measured the column with
            // `getBoundingClientRect` straight after the draw had written the
            // canvas's size, which forces the browser to lay the page out again
            // once a second for an answer that changes when a box changes size.
            // `_watchDock` observes the two boxes it depends on instead.
            this._followActivity();
        }, REFRESH_MS);
        this.timerRegistry.registerInterval(this.refreshId);
    }

    /**
     * Bring up the layout that suits what is going on, if that is wanted.
     *
     * On the panel's own tick rather than on a listener, because there is no
     * event for "the marketplace is open" and the action queue changes without
     * one worth subscribing to. A second's granularity is far finer than the
     * ten seconds a change has to hold for anyway, and the whole of the
     * decision — including doing nothing, which is nearly always the answer —
     * is arithmetic in `decideAutoSwitch`.
     *
     * @returns {Promise<void>}
     */
    async _followActivity() {
        // The names as last read. Storage is asynchronous and this is not; a
        // tick before the first read simply falls through to the presets, which
        // is the right answer for a player who has saved nothing.
        const saved = this.savedLayouts || [];

        const { state, apply } = decideAutoSwitch({
            state: this.switchState,
            activity: currentActivity(),
            now: Date.now(),
            enabled: Boolean(this.settings.autoSwitchLayout),
            locked: this.settings.locked !== false,
            mappings: this._activityMappings(saved),
            saved,
        });
        this.switchState = state;
        if (!apply) return;

        await this.applyNamedLayout(apply, { byHand: false });
    }

    /**
     * Every layout's activity, presets included.
     *
     * Built rather than read straight out of the settings so a preset nobody
     * has touched still answers for its own activity — `_activityFor` holds
     * that rule, and this is the same rule applied to the whole list.
     *
     * @param {string[]} saved - Saved layout names
     * @returns {Object} `{ [layoutName]: activity }`
     */
    _activityMappings(saved) {
        const mappings = {};
        for (const name of [...saved, ...Object.keys(PRESET_LAYOUTS)]) {
            // A saved layout shadowing a preset is listed once, with whatever
            // the player said about it — the same precedence the dropdown uses
            if (mappings[name]) continue;
            mappings[name] = this._activityFor(name);
        }
        return mappings;
    }

    _removePanel() {
        if (this.refreshId) {
            clearInterval(this.refreshId);
            this.refreshId = null;
        }
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.tiles.clear();

        if (this.onPickerDismiss) {
            document.removeEventListener('pointerdown', this.onPickerDismiss, true);
            this.onPickerDismiss = null;
        }
        if (this.onPickerKey) {
            document.removeEventListener('keydown', this.onPickerKey);
            this.onPickerKey = null;
        }
        this.releaseEscapeHold?.();
        this.releaseEscapeHold = null;
        this.pickerEl?.remove();
        this.pickerEl = null;
        this.headerEl = null;

        if (this.onWindowResize) {
            window.removeEventListener('resize', this.onWindowResize);
            this.onWindowResize = null;
        }
        this.panelObserver?.disconnect();
        this.panelObserver = null;
        this.dockObserver?.disconnect();
        this.dockObserver = null;
        this.lastCanvasWidth = null;
        // Both are memos about a canvas that is about to stop existing, and the
        // column count is the dangerous one: `_applyColumns` writes
        // `--overlay-columns` only when the count *changes*, so a remembered 4
        // means the freshly built canvas is never told it has four columns and
        // falls back to the two in its `repeat()`. Reopening a wide panel then
        // drew it at half its columns until something happened to change the
        // count. See `_applyColumns`.
        this.columns = 0;
        this.lastWidth = 0;
        // Decided from the width at every draw; a stale true would leave the
        // next panel unable to be unlocked
        this.flowing = false;
        this.wasFlowing = false;

        // Left behind, the column keeps a flex layout and a measured height with
        // nothing to fill them
        if (this.dockHost) {
            this.dockHost.classList.remove(DOCK_HOST_CLASS);
            this.dockHost.style.height = '';
        }
        this.dockHost = null;

        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
            this.canvasEl = null;
            this.scrollEl = null;
        }
    }
}

const overlayPanel = new OverlayPanel();
export default overlayPanel;
