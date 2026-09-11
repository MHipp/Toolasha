/**
 * Treasure Tracker
 *
 * Keeps a ledger of every chest you open, and shows whether they paid out.
 *
 * Toolasha already prices a chest before you open it, in tooltips and in net
 * worth. That is a claim about the long run. This is the record of whether the
 * long run has turned up: how many you have opened, what came out, and what the
 * drop tables said should have.
 *
 * The tracking runs whenever the feature is on, whether or not the panel is
 * open — a ledger you have to remember to start is a ledger with nothing in it
 * when you finally want to read it. Only the drawing waits for the panel.
 *
 * The arithmetic is in `utils/chest-tally.js`. This module listens, stores, and
 * draws.
 *
 * The idea is TReasure's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The panel
 * is Toolasha's own.
 */

import config from '../../core/config.js';
import settingsStorage from '../../core/settings-storage.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { getItemPrice, getPricingMode } from '../../utils/market-data.js';
import {
    recordOpening,
    resetTally,
    mergeStoredTally,
    chestPerformance,
    chestBreakdown,
    summariseTally,
    tallyTotals,
    sortSummary,
    SORT_MODES,
} from '../../utils/chest-tally.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { isMobileMode } from '../../utils/mobile.js';
import {
    restoreGeometry,
    saveGeometry,
    clearPosition,
    saveOpenState,
    reopenIfLeftOpen,
} from '../../utils/panel-geometry.js';
import { askChoice } from '../../utils/choice-dialog.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import {
    toExport,
    fromToolashaExport,
    fromTreasureExport,
    fromEdibleTools,
    findEdibleToolsData,
    mergeTally,
} from '../../utils/chest-import.js';
import { calculateDungeonTokenValue, labyrinthRewardValue, shopPurchasePrice } from '../../utils/token-valuation.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { createPersistedRecord } from '../../utils/persisted-record.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

/**
 * The ledger and the panel's preferences.
 *
 * Both are scoped per character — the chests one character opened are not the
 * other's, and the value settings are a per-character judgement — and resolved
 * at each read and write, since the user switches characters without reloading.
 * The pre-scoping global values are adopted by the main character once.
 *
 * The ledger is kept through a persisted record (`utils/persisted-record.js`):
 * a read that cannot be made leaves the ledger in hand rather than blanking it,
 * and a save folds the stored ledger under it — count by count, the larger
 * winning, see `mergeStoredTally` — rather than writing over it. Resets and
 * imports are the writes that mean to replace, and say so.
 */
const STORAGE_KEY = 'treasureTally';
const SETTINGS_KEY = 'treasureSettings';
const ADOPT_LEGACY = { migrate: 'adopt' };
const PANEL_ID = 'toolasha-treasure-panel';
const POPUP_ID = 'toolasha-treasure-popup';
/** Where each of the two is remembered; they are moved and sized independently */
const PANEL_GEOMETRY_KEY = 'treasurePanel';
const POPUP_GEOMETRY_KEY = 'treasurePopup';
/** What the ledger opens at before anyone has resized it */
const DEFAULT_PANEL = { width: 720, height: 560 };
/** How small the panel may be dragged — never wider than the phone it is on */
const MIN_PANEL = { width: 320, height: 200 };
/** A control a finger can hit, per the usual 32px floor */
const TOUCH_TARGET = 32;

/** How long the "waiting for chest data" poll keeps asking before giving up */
const DATA_WAIT_LIMIT_MS = 5 * 60 * 1000;
/** Header space kept clear on the right, so nothing flows under the close button */
const CLOSE_GUTTER = { pointer: 28, touch: TOUCH_TARGET + 6 };
/** The game's own dialog, which the popup wants to sit beside */
const LOOT_DIALOG_SELECTOR = '[class*="Modal_modal"]:not([class*="Modal_modalContainer"])';
/** Gap between the two, and how far off a screen edge the popup may not go */
const DIALOG_GAP = 12;
const EDGE_MARGIN = 8;
/**
 * The dialog is rendered by React in response to the same message that brings us
 * the loot, so it is reliably absent at the moment we are told about it. These
 * bound how long to keep looking.
 */
const DIALOG_TRIES = 12;
const DIALOG_RETRY_MS = 60;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.96)',
    headerBg: 'rgba(30, 22, 8, 0.8)',
    border: 'rgba(255, 207, 92, 0.35)',
    text: '#e8e6df',
    textDim: 'rgba(232, 230, 223, 0.55)',
    accent: '#ffcf5c',
    good: '#4ade80',
    bad: '#f87171',
};

/** Beyond this far from expectation, a chest is worth remarking on */
const NOTABLE_RATIO = 0.05;

/**
 * How to value an item the market will not price.
 *
 * Capes, quivers and cloaks are untradable, so there is no market answer and any
 * figure is a judgement. `token` prices one at what its tokens would otherwise
 * have bought, `mirror` at a Mirror of Protection, `zero` says it is worth
 * nothing to you. The choice moves a chest's verdict a long way, which is why it
 * is a setting rather than a constant.
 */
const CAPE_VALUE_CYCLE = { token: 'mirror', mirror: 'zero', zero: 'token' };
const CAPE_VALUE_LABEL = { token: 'Token value', mirror: 'Mirror value', zero: 'No value' };

const MIRROR_HRID = '/items/mirror_of_protection';
const COWBELL_HRID = '/items/cowbell';
const COWBELL_BAG_HRID = '/items/bag_of_10_cowbells';
const COWBELLS_PER_BAG = 10;
/** The bag's own market tax, which you pay to turn cowbells into coins */
const COWBELL_BAG_TAX = 0.18;

const DEFAULT_SETTINGS = {
    capeValue: 'token',
    valueCowbells: true,
    hiddenChests: [],
    popupPinned: false,
    sortMode: 'luck',
    // Which chests are expanded to their item breakdown. Remembered so a panel
    // reopened later — or after the page reloads — comes back open on the chest
    // you were actually looking at, rather than the collapsed list every panel
    // starts with.
    expandedChests: [],
};

/**
 * How a chest's return reads against expectation.
 * @param {number|null} ratio - actual ÷ expected, or null with nothing opened
 * @returns {{text: string, color: string}}
 */
export function formatReturn(ratio) {
    if (ratio === null || ratio === undefined) return { text: '—', color: COLORS.textDim };

    const percent = (ratio - 1) * 100;
    const sign = percent >= 0 ? '+' : '';
    const text = `${sign}${percent.toFixed(1)}%`;

    if (percent > NOTABLE_RATIO * 100) return { text, color: COLORS.good };
    if (percent < -NOTABLE_RATIO * 100) return { text, color: COLORS.bad };
    return { text, color: COLORS.textDim };
}

/**
 * An item hrid as a readable name, falling back to the hrid's own last segment
 * so an item the game data does not know about still reads as something.
 * @param {string} itemHrid - Item
 * @returns {string} Name
 */
export function itemName(itemHrid) {
    const details = dataManager.getItemDetails?.(itemHrid);
    if (details?.name) return details.name;
    return itemHrid.replace('/items/', '').replace(/_/g, ' ');
}

/**
 * A count small enough that rounding it would say the wrong thing.
 *
 * A rare owed 0.002 of itself per chest rounds to zero, which reads as the chest
 * owing you nothing rather than a one-in-five-hundred chance.
 *
 * @param {number} count - Expected count
 * @returns {string} Readable count
 */
export function smallCount(count) {
    if (count >= 10) return formatLargeNumber(Math.round(count));
    if (count >= 1) return count.toFixed(2);
    if (count >= 0.001) return count.toFixed(3);
    return count.toExponential(1);
}

/**
 * Below this, an expected count rounds to nothing on the row.
 *
 * Two decimals is what the row shows, so anything under 0.005 would print as
 * "0.00 expected" — a line claiming the chest owed you nothing, which is both
 * wrong and the least interesting thing on screen.
 */
const NEGLIGIBLE_EXPECTED = 0.005;

/**
 * Drop the rows that say nothing.
 *
 * A chest's drop table runs to thirty-odd entries, most of them equipment at
 * rates so long that a lifetime of opening owes you a hundredth of one. Listed,
 * they read "0, 0.00 expected, -100%" — three figures agreeing that nothing
 * happened, pushing the rows that did happen off the bottom.
 *
 * Anything that actually dropped is kept however unlikely it was, because that
 * is precisely the row worth seeing.
 *
 * @param {Array<Object>} items - From `chestPerformance`
 * @returns {Array<Object>} The ones worth a line
 */
export function worthShowing(items) {
    return (items || []).filter(
        (item) => (item.actualCount || 0) > 0 || (item.expectedCount || 0) >= NEGLIGIBLE_EXPECTED
    );
}

/**
 * Which side of the book loot is being valued at, as a word.
 *
 * Toolasha prices through the profit pricing mode rather than pinning to bid,
 * so this is a setting rather than a constant — and a figure whose basis is not
 * stated cannot be compared with anybody else's.
 *
 * @returns {string} `bid`, `ask` or `average`
 */
export function pricingBasis() {
    return getPricingMode('profit', 'sell');
}

/** The chest-summary export, one row per chest kind */
export const TREASURE_SUMMARY_COLUMNS = [
    { key: 'chest', label: 'Chest' },
    { key: 'chestHrid', label: 'Chest Hrid' },
    { key: 'opened', label: 'Opened' },
    { key: 'actualValue', label: 'Actual Value' },
    { key: 'expectedValue', label: 'Expected Value' },
    { key: 'difference', label: 'Difference' },
    { key: 'ratio', label: 'Ratio' },
    { key: 'perChestValue', label: 'Per-Chest Value' },
];

/** The per-item export, one row per item per chest kind */
export const TREASURE_DETAIL_COLUMNS = [
    { key: 'chest', label: 'Chest' },
    { key: 'chestHrid', label: 'Chest Hrid' },
    { key: 'item', label: 'Item' },
    { key: 'itemHrid', label: 'Item Hrid' },
    { key: 'actualCount', label: 'Actual Count' },
    { key: 'expectedCount', label: 'Expected Count' },
    { key: 'actualValue', label: 'Actual Value' },
    { key: 'expectedValue', label: 'Expected Value' },
    { key: 'unpriced', label: 'Unpriced' },
];

/**
 * The ledger as CSV rows, one per chest kind you have actually opened.
 *
 * Two exports rather than one file of mixed shapes: a summary row and an item
 * line have different columns, and a CSV that alternates between them cannot be
 * sorted, summed or pivoted — which is the only reason to want a CSV. The
 * summary answers "which chest let me down"; the detail file underneath it is
 * the same ledger one item per row, ready to pivot.
 *
 * @param {Array<Object>} rows - From `summariseTally`
 * @param {Function} [nameOf] - `(itemHrid) => string`, injectable for tests
 * @returns {Array<Object>} Rows for `TREASURE_SUMMARY_COLUMNS`
 */
export function buildTreasureSummaryRows(rows, nameOf = itemName) {
    return (rows || [])
        .filter((row) => row.opened > 0)
        .map((row) => ({
            chest: nameOf(row.chestHrid),
            chestHrid: row.chestHrid,
            opened: row.opened,
            actualValue: row.actualValue,
            expectedValue: row.expectedValue,
            difference: row.difference,
            // Null with nothing priced, which the CSV writes as an empty cell
            // rather than a claim of zero
            ratio: row.ratio,
            perChestValue: row.perChestValue,
        }));
}

/**
 * The same ledger one item per row: what each opened chest paid, against what
 * its drop table owed. Filtered the way the panel filters — anything that
 * dropped is kept, and an expectation too small to print is left out.
 *
 * @param {Array<Object>} rows - From `summariseTally`
 * @param {Function} [nameOf] - `(itemHrid) => string`, injectable for tests
 * @returns {Array<Object>} Rows for `TREASURE_DETAIL_COLUMNS`
 */
export function buildTreasureDetailRows(rows, nameOf = itemName) {
    return (rows || [])
        .filter((row) => row.opened > 0)
        .flatMap((row) =>
            worthShowing(row.items).map((item) => ({
                chest: nameOf(row.chestHrid),
                chestHrid: row.chestHrid,
                item: nameOf(item.itemHrid),
                itemHrid: item.itemHrid,
                actualCount: item.actualCount,
                expectedCount: item.expectedCount,
                actualValue: item.actualValue,
                expectedValue: item.expectedValue,
                unpriced: Boolean(item.unpriced),
            }))
        );
}

/** The tallest a freshly-opened popup is allowed to be */
const POPUP_MAX_HEIGHT = 560;

/**
 * Turn a content-sized popup into one with a height of its own.
 *
 * A chest with thirty drop-table rows makes a popup taller than the screen, and
 * the rows that matter are the ones off the bottom — so it has to be capped. It
 * used to be capped with `max-height`, which was the bug: the resize grip writes
 * `height`, and a `max-height` sitting above it means dragging the corner
 * downwards changes a number that nothing renders. The popup could be made
 * wider and never taller.
 *
 * Measuring once and writing the result as a plain height caps it just the same
 * and leaves `height` as the only thing deciding how tall it is.
 *
 * @param {HTMLElement} popup - Already in the document, so it can be measured
 * @param {number} [viewportHeight] - The window, for tests
 * @returns {number} The height it was given
 */
export function capHeightToWindow(popup, viewportHeight = window.innerHeight) {
    const natural = popup.offsetHeight || popup.getBoundingClientRect().height;
    const height = Math.min(natural, POPUP_MAX_HEIGHT, Math.round(viewportHeight * 0.7));
    popup.style.height = `${height}px`;
    return height;
}

class TreasureTracker {
    constructor() {
        this.isInitialized = false;
        this.tally = {};
        this.ledger = createPersistedRecord({
            base: STORAGE_KEY,
            store: 'settings',
            empty: () => ({}),
            merge: mergeStoredTally,
            label: 'TreasureTracker',
        });
        this.lootOpenedHandler = null;
        this.panel = null;
        this.contentEl = null;
        this.headerEl = null;
        this.expanded = new Set();
        this.isDragging = false;
        this.popup = null;
        this._dialogRetry = null;
        this.settings = { ...DEFAULT_SETTINGS };
        this.configMode = false;
        /**
         * Bumped by {@link disable}, which is what a character switch runs
         * before the arriving character's `initialize()`. Anything that
         * suspended under the departing character — an `initialize()` parked in
         * its loads, a confirmation dialog waiting on a human — compares this
         * on the way back and stands down rather than adopting the departing
         * character's ledger or writing over the arriving character's.
         */
        this._generation = 0;
    }

    /**
     * A ticket saying which character the work about to suspend belongs to.
     *
     * The id alone is not enough: a reconnect re-initializes the same character,
     * so the generation has to move too. And the generation alone is not enough
     * either — `characterKey()` builds its key from
     * `getCurrentCharacterId()`, which moves the moment the switch settles,
     * before `disable()` has had a turn.
     * @returns {{generation: number, charId: string|null}} Pass to {@link _stillOurs}
     */
    _owner() {
        return { generation: this._generation, charId: dataManager.getCurrentCharacterId?.() ?? null };
    }

    /**
     * @param {{generation: number, charId: string|null}} owner - From {@link _owner}
     * @returns {boolean} Whether the character it was taken under is still the one in hand
     */
    _stillOurs(owner) {
        return (
            owner.generation === this._generation && (dataManager.getCurrentCharacterId?.() ?? null) === owner.charId
        );
    }

    /**
     * Whether an answer to a dialog may still be acted on.
     *
     * The wait is unbounded — a human decides when it ends — so the character
     * can be a different one by the time it does, and every one of these
     * answers ends in a `replace: true` write, which is a full overwrite of
     * whoever's ledger is current. Refusing silently would read as the button
     * being broken, so it says why — and says which of the two it was. A
     * character switch is the usual reason, but `disable()` also bumps the
     * generation when the tracker's own setting is turned off, and telling
     * somebody who did that they switched characters sends them looking for a
     * switch that never happened.
     * @param {{generation: number, charId: string|null}} owner - Taken before the dialog opened
     * @returns {boolean} Whether to go ahead
     */
    _answerStillApplies(owner) {
        if (this._stillOurs(owner)) return true;
        const switched = (dataManager.getCurrentCharacterId?.() ?? null) !== owner.charId;
        window.alert(
            switched
                ? 'You switched characters while that was open, so your chest history was left alone.'
                : 'The treasure tracker was turned off and on again while that was open, so your chest ' +
                      'history was left alone.'
        );
        return false;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('treasureTracker')) return;
        this.isInitialized = true;
        const owner = this._owner();

        // An unreadable store keeps whatever ledger is in hand rather than
        // starting a blank one that the next chest would write over the stored one
        this.ledger.set(this.tally);
        await this.ledger.load();
        // A switch landing in the load ran `disable()`, which cleared the tally
        // and dropped the ledger — and then the arriving character's own
        // `initialize()`. Carrying on here re-seeded `this.tally` from the
        // DEPARTING character's ledger over that cleared state, so their counts
        // were saved under the arriving character's key on the next chest, and
        // registered a second `loot_opened` handler that nothing could remove.
        if (!this._stillOurs(owner)) return;
        this.tally = this.ledger.get();
        const saved = await readScoped(SETTINGS_KEY, 'settings', null, ADOPT_LEGACY);
        if (!this._stillOurs(owner)) return;
        if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };
        // Reapplied every initialize, not just the first: a character switch
        // re-initializes the same instance, and the previous character's
        // expanded chests would otherwise still be sitting in `this.expanded`
        // when the new one's settings load.
        this.expanded = new Set(this.settings.expandedChests || []);

        // A panel reopened at start-up is created before this runs, so it drew
        // the whole chest list against an empty ledger and read "Nothing opened
        // yet" until it was closed and opened again. It is a no-op when the
        // panel is not up, which is the usual case.
        this._render();

        // Symmetric with `disable()`: registration removes whatever is already
        // registered first, so overwriting the field can never strand a handler
        // the unregister can no longer name. Two live handlers would record
        // every chest opening twice.
        if (this.lootOpenedHandler) webSocketHook.off('loot_opened', this.lootOpenedHandler);
        this.lootOpenedHandler = (data, context) => this._onLootOpened(data, context);
        webSocketHook.on('loot_opened', this.lootOpenedHandler);

        registerCommand({
            name: 'Treasure Tracker',
            hint: 'Chests opened and what came out',
            run: () => this.toggle(),
        });
    }

    disable() {
        // Before anything else, so work suspended under the departing character
        // — a parked `initialize()`, an open confirmation dialog — finds the
        // number moved however this call goes on to fare
        this._generation += 1;
        try {
            unregisterCommand('Treasure Tracker');
            if (this.lootOpenedHandler) {
                webSocketHook.off('loot_opened', this.lootOpenedHandler);
                this.lootOpenedHandler = null;
            }
            this._removePanel();
            this._removePopup();
            // The ledger is one character's. Dropped so the re-initialize that
            // follows a character switch reads the arriving character's, rather
            // than saving this one's under their key on the next chest.
            this.tally = {};
            this.ledger.reset();
            this.settings = { ...DEFAULT_SETTINGS };
            this.isInitialized = false;
        } catch (error) {
            console.error('[Treasure Tracker] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Record an opening and redraw if anyone is looking.
     *
     * The ledger is one character's, and it is the arriving character's from the
     * moment the switch re-initializes this feature. A chest the departing character
     * opened whose message lands after that would be folded into the wrong lifetime
     * tally — and pop up over the wrong character's screen — so an opening from a
     * socket that no longer owns the active character is dropped.
     *
     * @param {Object} data - `loot_opened` message
     * @param {{socket?: Object}|null} [context] - Delivery context from the WebSocket hook
     */
    _onLootOpened(data, context) {
        // Optional-call for the same reason as the other dataManager reaches here:
        // Core is a separate bundle in the split build, and "not yet loaded" has to
        // mean permissive rather than throw
        if (dataManager.isFromActiveSocket?.(context) === false) return;

        const chestHrid = data?.openedItem?.itemHrid;
        if (!chestHrid) return;

        this.tally = recordOpening(this.tally, chestHrid, data.openedItem.count || 1, data.gainedItems);
        this._save();
        if (this.panel) this._render();
        if (config.getSetting('treasureTracker_popup')) this._showOpening(chestHrid);
    }

    /**
     * Show what the opening that just happened paid, against what it owed.
     *
     * Beside the game's own "Opened Loot" dialog, because that dialog answers
     * "what did I get" and leaves the only interesting question — "was that
     * good?" — to a feeling. The counts are the same ones on screen; the second
     * line under each is what the drop table said to expect.
     *
     * @param {string} chestHrid - What was opened
     */
    _showOpening(chestHrid) {
        const entry = this.tally[chestHrid];
        if (!entry?.last) return;

        const dropTable = dataManager.getInitClientData()?.openableLootDropMap?.[chestHrid];
        const opening = chestPerformance(entry.last, dropTable, this._priceOf());
        const lifetime = chestPerformance(entry, dropTable, this._priceOf());

        this._removePopup();
        this.popup = this._buildPopup(chestHrid, opening, lifetime);
        document.body.appendChild(this.popup);
        registerFloatingPanel(this.popup);
        capHeightToWindow(this.popup);

        // Size is always remembered; where it goes is not, unless you have
        // pinned it by moving it. Asking for the position back regardless was
        // most of why the popup stopped appearing beside the chest dialog — a
        // stale position was reapplied on every opening, and if the dialog was
        // not found within the retries the popup simply stayed there.
        //
        // Placed after the size is back rather than before, because placement
        // measures the popup and a width applied afterwards would move the edge
        // it was measured against.
        const pinned = this.settings.popupPinned;
        // Kept out of sight until it has somewhere to be. The stored size is an
        // IndexedDB read away and the game's dialog a few frames away; showing
        // the popup at its default corner meanwhile and then jumping it beside
        // the dialog read as the popup opening in the wrong place
        this.popup.style.visibility = 'hidden';
        if (!pinned) this._placeBesideDialog(0);
        // The popup this restore is for. A storage read takes long enough for
        // the player to close one chest and open the next, and the continuation
        // below would then size and reveal the *new* popup using the old one's
        // stored geometry — or, worse, un-hide a popup whose own restore is
        // still in flight. Identity is checked rather than mere existence
        const popup = this.popup;
        restoreGeometry(popup, POPUP_GEOMETRY_KEY, { width: 260, height: 120 }, { position: pinned })
            .then(() => {
                // The height fits the chest being shown, not the chest the popup was
                // once resized on. capHeightToWindow already sized it to its content
                // above; restoring a stored height on top of that clipped every
                // chest with more rows than the one the resize happened on. Width is
                // the half of a resize worth keeping, and it changes how rows wrap —
                // so the height is re-fitted after the width lands.
                if (this.popup !== popup) return;
                this.popup.style.height = '';
                capHeightToWindow(this.popup);
                if (pinned) {
                    this.popup.style.visibility = '';
                    return;
                }
                // The width just landed, so the edge it was placed against may have
                // moved: place once more — quietly, because the first round of
                // retries may still be waiting on the dialog and this pass must
                // neither start a second round nor reveal the popup in the corner
                this._placeBesideDialog(DIALOG_TRIES, { quiet: true });
            })
            .catch((error) => {
                // The popup is hidden until the restore says where it goes; a
                // restore that rejects (a storage read that failed) would otherwise
                // leave it hidden for ever — better in the default corner than not
                // there at all
                console.error('[TreasureTracker] Restoring the popup geometry failed:', error);
                if (this.popup === popup) this.popup.style.visibility = '';
            });
    }

    /**
     * Put the popup beside the game's Opened Loot dialog.
     *
     * The two are read together — the game's counts on the left, whether they
     * were good on the right — so a popup pinned to a screen corner makes you
     * look back and forth across the whole window.
     *
     * Measured after mounting, because the height depends on how many items the
     * chest paid out — and retried, because the dialog is rendered from the same
     * message that brings us the loot and is reliably not there yet on the first
     * look. Falls back to the top-right corner once the retries run out, which
     * is what happens when a chest is opened by a route that raises no dialog.
     *
     * @param {number} tries - How many attempts have been made
     * @param {Object} [options]
     * @param {boolean} [options.quiet=false] - A re-placement after the size
     *   came back: never retries and never reveals the popup itself, since
     *   the original round of retries is still the one deciding when it shows
     */
    _placeBesideDialog(tries, { quiet = false } = {}) {
        if (!this.popup) return;

        const dialog = document.querySelector(LOOT_DIALOG_SELECTOR);
        // Not up yet — the message that told us about the loot is the same one
        // React is still rendering the dialog from
        if (!dialog || !dialog.getBoundingClientRect().width) {
            if (quiet) return;
            if (tries >= DIALOG_TRIES) {
                // No dialog to sit beside: the default corner it is, and shown
                this.popup.style.visibility = '';
                return;
            }
            const retry = setTimeout(() => this._placeBesideDialog(tries + 1), DIALOG_RETRY_MS);
            this._dialogRetry = retry;
            return;
        }

        const anchor = dialog.getBoundingClientRect();
        const self = this.popup.getBoundingClientRect();
        if (!self.width) {
            if (!quiet) this.popup.style.visibility = '';
            return;
        }

        // To the right of the dialog, unless that would run off screen, in which
        // case the left side has the room
        const rightOf = anchor.right + DIALOG_GAP;
        const leftOf = anchor.left - self.width - DIALOG_GAP;
        const fitsRight = rightOf + self.width <= window.innerWidth - EDGE_MARGIN;
        const left = fitsRight ? rightOf : Math.max(leftOf, EDGE_MARGIN);

        // Top-aligned with the dialog, nudged up only if the popup is the taller
        // of the two and would otherwise hang off the bottom
        const maxTop = window.innerHeight - self.height - EDGE_MARGIN;
        const top = Math.max(EDGE_MARGIN, Math.min(anchor.top, maxTop));

        Object.assign(this.popup.style, { left: `${left}px`, top: `${top}px`, right: 'auto', visibility: '' });
    }

    /**
     * Write the ledger back, folding the stored one under it — or, for a
     * reset or an import, replacing it outright.
     * @param {Object} [options]
     * @param {boolean} [options.replace=false] - Write the ledger as-is; for
     *   the writes whose point is that counts go away
     */
    _save({ replace = false } = {}) {
        this.ledger.set(this.tally);
        this.ledger.save({ overwrite: replace }).catch((error) => {
            console.error('[TreasureTracker] Saving the chest tally failed:', error);
        });
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(PANEL_GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._createPanel();
    }

    /** Close it, and stop reopening it */
    hide() {
        saveOpenState(PANEL_GEOMETRY_KEY, false);
        this._removePanel();
    }

    /** Open if closed, close if open */
    toggle() {
        if (this.panel && document.body.contains(this.panel)) this.hide();
        else this.show();
    }

    /**
     * Reopen if the page was left with this panel up.
     *
     * The panel only; the chest popup is deliberately not restored. It is a
     * reaction to opening something, and a popup about a chest opened yesterday
     * reappearing on load would be a stale answer to a question nobody asked.
     */
    restore() {
        reopenIfLeftOpen(PANEL_GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /**
     * Your measured return on one chest kind, for the profit adjustment.
     *
     * Actual value out against the drop table's expectation, both priced at
     * today's prices through the panel's own price source — so the ratio says
     * "my openings run this far off the table", never "prices moved". This is
     * the treasure rate the dungeon profit option applies.
     *
     * @param {string} chestHrid - The chest item
     * @returns {{ratio: number, opened: number}|null} Null before anything has
     *   been opened, without a drop table, or when nothing could be priced
     */
    measuredReturn(chestHrid) {
        try {
            const entry = this.tally?.[chestHrid];
            const dropTable = dataManager.getInitClientData()?.openableLootDropMap?.[chestHrid];
            if (!entry?.opened || !dropTable) return null;

            const lifetime = chestPerformance(entry, dropTable, this._priceOf());
            if (!(lifetime.expectedValue > 0) || !Number.isFinite(lifetime.ratio)) return null;
            return { ratio: lifetime.ratio, opened: lifetime.opened };
        } catch (error) {
            console.error('[TreasureTracker] Measuring a chest return failed:', error);
            return null;
        }
    }

    /**
     * The rows to draw, and their totals.
     * @returns {{rows: Array<Object>, totals: Object}}
     */
    _summary() {
        const dropTables = dataManager.getInitClientData()?.openableLootDropMap || {};
        const rows = summariseTally(this.tally, dropTables, this._priceOf());
        // Totals are taken before sorting, because they are the same figures
        // whichever way the rows are ordered
        const totals = tallyTotals(rows);
        return { rows: sortSummary(rows, this.settings.sortMode, itemName), totals };
    }

    /**
     * The one price source both the ledger and the popup read through, so a
     * chest cannot look lucky merely because two views priced it differently.
     * @returns {Function} `(itemHrid) => number|null`
     */
    _priceOf() {
        return (itemHrid) => {
            // Coins are the base currency and never appear on the market
            if (itemHrid === '/items/coin') return 1;
            if (itemHrid === COWBELL_HRID) return this._cowbellValue();

            const market = getItemPrice(itemHrid, { context: 'profit', side: 'sell' });
            if (market > 0) return market;

            // No market answer: an untradable reward, which is a judgement call
            return this._untradableValue(itemHrid);
        };
    }

    /**
     * What a cowbell is worth, if anything.
     *
     * Cowbells are not tradable; bags of ten are. So the value of one is a bag's
     * price less the tax you pay selling it, split ten ways — the same route
     * `expected-value-calculator.js` takes.
     *
     * @returns {number|null} Coins per cowbell, or null when they are not counted
     */
    _cowbellValue() {
        if (!this.settings.valueCowbells) return null;

        const bag = getItemPrice(COWBELL_BAG_HRID, { context: 'profit', side: 'sell' });
        if (!(bag > 0)) return null;
        return (bag * (1 - COWBELL_BAG_TAX)) / COWBELLS_PER_BAG;
    }

    /**
     * What an untradable reward is worth, under the current setting.
     *
     * Read from the game's own shop data rather than a hardcoded price list, so
     * a shop change does not quietly leave the figure a version behind.
     *
     * @param {string} itemHrid - The item
     * @returns {number|null} A value, or null to leave it out of the comparison
     */
    _untradableValue(itemHrid) {
        const mode = this.settings.capeValue;
        if (mode === 'zero') return null;
        if (mode === 'mirror') return getItemPrice(MIRROR_HRID, { context: 'profit', side: 'sell' }) || null;

        // Token value: what the tokens it costs would otherwise have bought.
        //
        // Every cost on the line, not `costs[0]`: a line whose first cost is coins
        // used to have `/items/coin` handed to the dungeon-token valuer, which
        // produced a plausible-looking number for a currency that is worth exactly
        // 1, and a line paid for in two currencies was charged for one of them.
        // `shopPurchasePrice` already sums a line properly and divides by
        // `outputCount`; the currency valuation is this feature's own, so it goes
        // in as the price lookup.
        const data = dataManager.getInitClientData();
        const shop = data?.shopItemDetailMap || {};
        const shopPrice = shopPurchasePrice(itemHrid, [shop], (hrid) =>
            hrid ? (calculateDungeonTokenValue(hrid) ?? getItemPrice(hrid, { context: 'profit', side: 'sell' })) : null
        );
        if (shopPrice > 0) return shopPrice;

        // The labyrinth keeps its own shop under its own map, and the scrolls a
        // combat chest drops are in it and nowhere else. Without this they price
        // at nothing and vanish from the contents rather than showing a value —
        // which is what "the ported Treasure is missing the scrolls" was.
        return labyrinthRewardValue(itemHrid, data?.labyrinthShopItemDetailMap, (hrid) =>
            getItemPrice(hrid, { context: 'profit', side: 'sell' })
        );
    }

    _saveSettings() {
        writeScoped(SETTINGS_KEY, this.settings, 'settings').catch((error) => {
            console.error('[TreasureTracker] Saving treasure settings failed:', error);
        });
    }

    /**
     * The item sprite sheet the game is on today.
     *
     * Read off any icon already on the page rather than pinned, because the URL
     * carries a build hash the game regenerates.
     * @returns {string} Sprite URL, or '' if none is on screen yet
     */
    _spriteUrl() {
        if (this._sprite) return this._sprite;
        const use = document.querySelector('svg use[href*="items_sprite"]');
        this._sprite = use?.getAttribute('href')?.split('#')[0] || '';
        return this._sprite;
    }

    /**
     * @param {string} itemHrid - Item to draw
     * @param {number} size - Pixels
     * @returns {SVGElement|HTMLElement} An icon, or a spacer if the sheet is unknown
     */
    _icon(itemHrid, size = 18) {
        const sprite = this._spriteUrl();
        if (!sprite) {
            const spacer = document.createElement('span');
            spacer.style.width = `${size}px`;
            return spacer;
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flex = '0 0 auto';
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${sprite}#${itemHrid.split('/').pop()}`);
        svg.appendChild(use);
        return svg;
    }

    /**
     * Build the just-opened popup.
     * @param {string} chestHrid - What was opened
     * @param {Object} opening - Performance of this opening
     * @param {Object} lifetime - Performance of every opening of this chest
     * @returns {HTMLElement} The popup
     */
    _buildPopup(chestHrid, opening, lifetime) {
        const popup = document.createElement('div');
        popup.id = POPUP_ID;
        Object.assign(popup.style, {
            position: 'fixed',
            top: '80px',
            right: '40px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: '288px',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '11px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const touch = isMobileMode();
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            // The same treatment the panel's header has, for the same reason:
            // the title is a chest name and some of them are long, so on a
            // narrow screen a title pushed against a close button in the flow
            // is a close button pushed off the end.
            flexWrap: 'wrap',
            gap: '8px',
            padding: '7px 8px 7px 11px',
            // Room kept clear on the right for the close button, which sits
            // outside the flow below
            paddingRight: `${touch ? CLOSE_GUTTER.touch : CLOSE_GUTTER.pointer}px`,
            position: 'relative',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            cursor: 'move',
            userSelect: 'none',
        });
        const title = document.createElement('span');
        title.textContent = `Treasure — ${itemName(chestHrid)}`;
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        header.appendChild(title);

        // Out of the flow entirely and pinned to the popup's top right corner,
        // so the way out of it is in the same place whatever the title does
        const closeBtn = this._headerButton('✕', () => this._removePopup());
        closeBtn.title = 'Close';
        Object.assign(closeBtn.style, { position: 'absolute', top: '3px', right: '4px' });
        if (touch) {
            Object.assign(closeBtn.style, {
                minWidth: `${TOUCH_TARGET}px`,
                minHeight: `${TOUCH_TARGET}px`,
                fontSize: '16px',
            });
        }
        header.appendChild(closeBtn);
        popup.appendChild(header);

        const body = document.createElement('div');
        // Scrolls rather than grows, so a chest that paid out twenty items does
        // not make a popup taller than the window
        Object.assign(body.style, { padding: '6px 9px 8px', flex: '1', overflow: 'auto', minHeight: '0' });
        popup.appendChild(body);

        const subtitle = document.createElement('div');
        subtitle.textContent = `Last opening (×${opening.opened})`;
        subtitle.style.color = COLORS.accent;
        subtitle.style.marginBottom = '3px';
        body.appendChild(subtitle);

        const verdict = formatReturn(opening.ratio);
        const summary = document.createElement('div');
        Object.assign(summary.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '7px' });
        // The side of the book the figure is on, said out loud, as TReasure
        // does. Toolasha prices loot through the profit pricing mode rather than
        // always at bid, so the same chest can be worth 45.44K here and 43.1K
        // there — and without the word there is no way to tell that apart from
        // one of them being wrong.
        const paid = document.createElement('span');
        paid.textContent = formatLargeNumber(Math.round(opening.actualValue));
        paid.style.color = verdict.color;
        const basis = document.createElement('span');
        basis.textContent = ` ${pricingBasis()}`;
        basis.style.color = COLORS.textDim;
        basis.title =
            'Which side of the market these values are taken from. ' +
            'Set by the profit pricing mode in Toolasha’s settings.';
        paid.appendChild(basis);
        const pct = document.createElement('span');
        pct.textContent = verdict.text;
        pct.style.color = verdict.color;
        summary.appendChild(paid);
        summary.appendChild(pct);
        body.appendChild(summary);

        for (const item of worthShowing(opening.items)) body.appendChild(this._openingRow(item));

        const total = document.createElement('div');
        Object.assign(total.style, {
            display: 'flex',
            justifyContent: 'space-between',
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '7px',
            paddingTop: '6px',
        });
        const lifeVerdict = formatReturn(lifetime.ratio);
        const totalLabel = document.createElement('span');
        totalLabel.textContent = `All ${lifetime.opened} opened`;
        const totalValue = document.createElement('span');
        totalValue.textContent = `${formatLargeNumber(Math.round(lifetime.actualValue))} · ${lifeVerdict.text}`;
        totalValue.style.color = lifeVerdict.color;
        total.appendChild(totalLabel);
        total.appendChild(totalValue);
        body.appendChild(total);

        const full = document.createElement('button');
        full.textContent = 'View full stats';
        Object.assign(full.style, {
            marginTop: '8px',
            width: '100%',
            padding: '5px',
            background: 'rgba(255, 207, 92, 0.12)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '12px',
        });
        full.addEventListener('click', (event) => {
            // The popup stays. It is the thing you were reading when you decided
            // you wanted more, and closing it to answer that is taking away the
            // question along with it.
            event.stopPropagation();
            this.show();
        });
        body.appendChild(full);

        // Moving it says "here, for now" — it no longer flips the
        // follows-the-dialog setting, which lives in the settings gear alone.
        // Moving-to-pin read as the popup silently changing its own setting:
        // one nudge and it stopped following the chest dialog with nothing on
        // screen saying why. The position is still saved, so a popup that *is*
        // pinned keeps opening where it was last put.
        this._detachPopupDrag = makeDraggable(popup, header, (position) => {
            saveGeometry(POPUP_GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this._detachPopupResize = makeResizable(popup, {
            minWidth: 240,
            minHeight: 120,
            onResize: (size) => saveGeometry(POPUP_GEOMETRY_KEY, size),
        });

        this.popupMinimizeCtl = attachMinimize({
            panel: popup,
            header,
            body,
            panelKey: POPUP_GEOMETRY_KEY,
            beforeEl: closeBtn,
            accent: COLORS.text,
        });

        // Dismissed by clicking away from it, the way the game's own loot dialog
        // and MCS's treasure pane both behave. Deferred by a tick so the click
        // that *opened* it does not immediately close it again.
        //
        // Pinning does not disable this, though it used to. The two are separate
        // questions — pinning says where the popup opens, not that it should
        // stay on screen — and conflating them meant that pinning it once, which
        // for a while a single click on its header was enough to do, silently
        // took the dismissal away as well.
        this._onOutsideClick = (event) => {
            if (!this.popup || this.popup.contains(event.target)) return;
            // The full-stats panel is this popup's own offspring; clicking in it
            // is not clicking away
            if (this.panel?.contains(event.target)) return;
            this._removePopup();
        };
        const arm = setTimeout(() => document.addEventListener('mousedown', this._onOutsideClick, true), 0);
        this._popupArm = arm;

        return popup;
    }

    /**
     * One item: what came out on top, what was owed underneath.
     *
     * Two lines rather than one because the comparison is the point — a count on
     * its own says nothing, and putting expected beside actual on a single line
     * makes eight of them unreadable.
     *
     * @param {Object} item - From `chestPerformance`
     * @returns {HTMLElement} The row
     */
    _openingRow(item) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '6px', alignItems: 'flex-start', padding: '1px 0' });
        if (item.unpriced) {
            row.title =
                'Nothing will price this, so it counts towards neither side of the total — but the count against ' +
                'what was owed still holds, and that is what the percentage here is.';
        }
        row.appendChild(this._icon(item.itemHrid));

        const columns = document.createElement('div');
        Object.assign(columns.style, { flex: '1', display: 'flex', flexDirection: 'column', lineHeight: '1.35' });

        // Value where there is a price, counts where there is not. An item
        // nothing will price still has a drop rate, and "four when you were owed
        // two and a quarter" is the same fact whether or not the market has an
        // opinion — it is only the *total* it cannot join.
        const ratio = item.unpriced
            ? item.expectedCount > 0
                ? item.actualCount / item.expectedCount
                : null
            : item.expectedValue > 0
              ? item.actualValue / item.expectedValue
              : null;
        const verdict = formatReturn(ratio);

        const actual = document.createElement('div');
        Object.assign(actual.style, { display: 'flex', justifyContent: 'space-between', gap: '6px' });
        const actualCount = document.createElement('span');
        actualCount.textContent = formatLargeNumber(item.actualCount);
        const actualValue = document.createElement('span');
        // An item nothing can price gets a row and no figure. A dash says "this
        // came out and is not counted"; a zero would say the chest gave you
        // something worthless, which is a different and wrong claim.
        actualValue.textContent = item.unpriced ? '—' : formatLargeNumber(Math.round(item.actualValue));
        actualValue.style.color = item.unpriced ? COLORS.textDim : COLORS.good;
        actualValue.style.marginLeft = 'auto';
        const diff = document.createElement('span');
        diff.textContent = verdict.text;
        diff.style.color = verdict.color;
        diff.style.minWidth = '62px';
        diff.style.textAlign = 'right';
        actual.appendChild(actualCount);
        actual.appendChild(actualValue);
        actual.appendChild(diff);

        const expected = document.createElement('div');
        Object.assign(expected.style, {
            display: 'flex',
            justifyContent: 'space-between',
            gap: '6px',
            color: COLORS.textDim,
        });
        const expectedCount = document.createElement('span');
        // Small expectations are the interesting ones — a rare owed 0.02 of
        // itself rounds to nothing and would read as owing zero
        expectedCount.textContent =
            item.expectedCount < 10 ? item.expectedCount.toFixed(2) : formatLargeNumber(Math.round(item.expectedCount));
        const expectedValue = document.createElement('span');
        expectedValue.textContent = item.unpriced ? 'no price' : formatLargeNumber(Math.round(item.expectedValue));
        if (item.unpriced) expectedValue.style.color = COLORS.textDim;
        expectedValue.style.marginLeft = 'auto';
        const word = document.createElement('span');
        word.textContent = 'expected';
        word.style.minWidth = '62px';
        word.style.textAlign = 'right';
        expected.appendChild(expectedCount);
        expected.appendChild(expectedValue);
        expected.appendChild(word);

        columns.appendChild(actual);
        columns.appendChild(expected);
        row.appendChild(columns);
        return row;
    }

    _removePopup() {
        clearTimeout(this._dialogRetry);
        this._dialogRetry = null;
        clearTimeout(this._popupArm);
        this._popupArm = null;
        if (this._onOutsideClick) {
            document.removeEventListener('mousedown', this._onOutsideClick, true);
            this._onOutsideClick = null;
        }
        this._detachPopupDrag?.();
        this._detachPopupDrag = null;
        this._detachPopupResize?.();
        this._detachPopupResize = null;
        this.popupMinimizeCtl?.destroy();
        this.popupMinimizeCtl = null;
        if (!this.popup) return;
        unregisterFloatingPanel(this.popup);
        this.popup.remove();
        this.popup = null;
    }

    _createPanel() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '80px',
            right: '80px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height),
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.panel.appendChild(this._createHeader());

        this.contentEl = document.createElement('div');
        Object.assign(this.contentEl.style, { padding: '8px 10px', overflow: 'auto', flex: '1' });
        this.panel.appendChild(this.contentEl);

        this._detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(PANEL_GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this._detachResize = makeResizable(this.panel, {
            minWidth: MIN_PANEL.width,
            minHeight: MIN_PANEL.height,
            onResize: (size) => saveGeometry(PANEL_GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        // The minimum is what the clamp is allowed to shrink a restored panel
        // to, so a 420 that no phone can honour is a minimum that hands the
        // panel back wider than the screen
        restoreGeometry(this.panel, PANEL_GEOMETRY_KEY, MIN_PANEL);

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header: this.headerEl,
            body: this.contentEl,
            panelKey: PANEL_GEOMETRY_KEY,
            beforeEl: this.headerEl.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
    }

    _createHeader() {
        const touch = isMobileMode();
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            // The controls wrap onto a second line rather than pushing each
            // other off the side. On a 400px phone the row — title, two value
            // chips, gear, sort picker — was wider than the panel, and the one
            // thing it pushed off the end was the close button.
            flexWrap: 'wrap',
            gap: '6px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            // Room kept clear on the right for the close button, which sits
            // outside the flow below
            paddingRight: `${touch ? CLOSE_GUTTER.touch : CLOSE_GUTTER.pointer}px`,
            position: 'relative',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });
        this.headerEl = header;

        const title = document.createElement('span');
        title.textContent = 'Treasure';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        title.style.marginRight = '4px';

        // Both toggles change what every figure in the panel means, so they sit
        // in the header showing their current state rather than hidden behind
        // the gear
        this.capeBtn = this._toggleButton(
            () => CAPE_VALUE_LABEL[this.settings.capeValue],
            'Untradable rewards — capes, quivers, cloaks — have no market price. ' +
                'Value them at what their tokens would have bought, at a Mirror of Protection, or at nothing.',
            () => {
                this.settings.capeValue = CAPE_VALUE_CYCLE[this.settings.capeValue] || 'token';
                this._saveSettings();
                this._refreshToggles();
                this._render();
            }
        );

        this.cowbellBtn = this._toggleButton(
            () => (this.settings.valueCowbells ? 'Cowbells counted' : 'Cowbells at zero'),
            'Cowbells are not tradable; bags of ten are. Counted, one is worth a bag less tax, split ten ways.',
            () => {
                this.settings.valueCowbells = !this.settings.valueCowbells;
                this._saveSettings();
                this._refreshToggles();
                this._render();
            }
        );

        const gear = this._headerButton('⚙', () => {
            this.configMode = !this.configMode;
            gear.style.background = this.configMode ? 'rgba(255, 207, 92, 0.25)' : 'none';
            this._render();
        });
        gear.title = 'Show or hide chests, and import or export your history';

        const picker = this._sortPicker();
        // Pushed to the right of whichever line it lands on, which is what the
        // old flex-1 spacer did on the one line there used to be
        picker.style.marginLeft = 'auto';

        // Out of the flow entirely and pinned to the panel's top right corner:
        // whatever the other controls do at whatever width, the way out of the
        // panel is in the same place and on screen.
        const closeBtn = this._headerButton('✕', () => this.hide());
        closeBtn.title = 'Close';
        Object.assign(closeBtn.style, {
            position: 'absolute',
            top: '3px',
            right: '4px',
        });
        if (touch) {
            Object.assign(closeBtn.style, {
                minWidth: `${TOUCH_TARGET}px`,
                minHeight: `${TOUCH_TARGET}px`,
                fontSize: '16px',
            });
        }

        header.append(title, this.capeBtn, this.cowbellBtn, gear, picker, closeBtn);
        this._refreshToggles();
        return header;
    }

    /**
     * How the chest list is ordered.
     *
     * In the header rather than above the list because the header is built once,
     * and a `<select>` rebuilt by the panel's redraw would shut its own dropdown
     * under the pointer.
     *
     * @returns {HTMLSelectElement}
     */
    _sortPicker() {
        const picker = document.createElement('select');
        picker.classList.add('toolasha-select');
        picker.title =
            'How to order the chests. Luck answers "which one let me down"; ' +
            'the alphabet answers "where is the one I am looking for".';
        Object.assign(picker.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '2px 4px',
            maxWidth: '130px',
        });

        for (const mode of SORT_MODES) {
            const option = document.createElement('option');
            option.value = mode.key;
            option.textContent = mode.label;
            picker.appendChild(option);
        }
        // Its value is set by `_refreshToggles`, along with the other header
        // controls, because the settings arrive after the header is built
        this.sortPicker = picker;

        // The header is what you drag the panel by, so a pointer that came down
        // on the picker must not also start a drag
        picker.addEventListener('mousedown', (event) => event.stopPropagation());
        picker.addEventListener('change', () => {
            this.settings.sortMode = picker.value;
            this._saveSettings();
            this._render();
        });
        return picker;
    }

    /**
     * A header control that shows what it is currently set to.
     *
     * The label is a function rather than a string because these are cycled
     * rather than pressed, and a button that does not say where it landed leaves
     * you clicking through to find out.
     *
     * @param {Function} label - Returns the current label
     * @param {string} title - Hover explanation
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _toggleButton(label, title, onClick) {
        const button = document.createElement('button');
        button.title = title;
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
        button._label = label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    /** Put the current setting back on the face of each toggle */
    _refreshToggles() {
        for (const button of [this.capeBtn, this.cowbellBtn]) {
            if (!button?._label) continue;
            button.textContent = button._label();
            // Dimmed when the setting means "count this as nothing", so the
            // panel says at a glance that something is being left out
            const counting = !/zero|No value/.test(button.textContent);
            button.style.color = counting ? COLORS.accent : COLORS.textDim;
            button.style.opacity = counting ? '1' : '0.7';
        }

        // The header is built once, and a panel reopened at start-up builds it
        // before the settings have come back from storage — so it sat there
        // claiming "Token value / Cowbells counted / Luck" whatever you had
        // actually chosen, until it was closed and opened again.
        if (this.sortPicker && this.sortPicker !== document.activeElement) {
            const known = SORT_MODES.some((mode) => mode.key === this.settings.sortMode);
            this.sortPicker.value = known ? this.settings.sortMode : 'luck';
        }
    }

    /**
     * The gear panel: which chests to show, and moving history in or out.
     * @returns {HTMLElement}
     */
    _configSection() {
        const section = document.createElement('div');
        Object.assign(section.style, {
            padding: '7px 8px',
            marginBottom: '6px',
            background: 'rgba(255, 207, 92, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
        });

        const hint = document.createElement('div');
        hint.textContent = 'Click 👁 to show or hide a chest. Hidden chests are still tracked.';
        hint.style.color = COLORS.accent;
        hint.style.marginBottom = '6px';
        hint.style.fontSize = '11px';
        section.appendChild(hint);

        const buttons = document.createElement('div');
        Object.assign(buttons.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });

        buttons.appendChild(this._actionButton('Export', () => this._exportHistory()));
        buttons.appendChild(this._actionButton('Import', () => this._importHistory()));
        buttons.appendChild(this._actionButton('Import from Edible Tools', () => this._importEdibleTools()));

        // The CSV pair appears only once something has been opened — a ledger
        // with nothing in it has no rows to write, and a button that saves an
        // empty file reads as the button breaking
        if (this._summary().rows.some((row) => row.opened > 0)) {
            const chestsCsv = this._actionButton('Chests CSV', () => this._exportSummaryCsv());
            chestsCsv.title = 'One row per chest kind: opened, actual and expected value, ratio. Raw numbers.';
            buttons.appendChild(chestsCsv);

            const itemsCsv = this._actionButton('Items CSV', () => this._exportDetailCsv());
            itemsCsv.title = 'One row per item per chest: counts and values against the drop table. Raw numbers.';
            buttons.appendChild(itemsCsv);
        }

        // Always here, saying which way it is set. It used to appear only while
        // the popup was pinned, so pressing it made the button itself disappear
        // — which reads as the button breaking rather than as the setting
        // changing.
        const pin = this._actionButton(
            this.settings.popupPinned ? 'Popup stays where you put it' : 'Popup follows the chest dialog',
            () => {
                this.settings.popupPinned = !this.settings.popupPinned;
                this._saveSettings();
                // Unpinning forgets where it was put, but not how big it was —
                // dropping the size too would be an unasked-for second change
                if (!this.settings.popupPinned) clearPosition(POPUP_GEOMETRY_KEY);
                this._render();
            }
        );
        pin.title =
            'The popup normally opens beside the game’s Opened Loot dialog. ' +
            'Dragging it says "stay here" instead; this puts it back to following.';
        buttons.appendChild(pin);

        const wipe = this._actionButton('Delete all history', async () => {
            const owner = this._owner();
            const confirmed = await askChoice({
                title: 'Delete all chest history',
                message: 'Every chest opening recorded so far. This cannot be undone.',
                choices: [
                    { value: 'delete', label: 'Delete everything', tone: 'danger' },
                    { value: null, label: 'Cancel' },
                ],
            });
            if (!confirmed) return;
            // "Delete everything" answered after a switch deleted the ARRIVING
            // character's whole history, irrecoverably
            if (!this._answerStillApplies(owner)) return;

            this.tally = resetTally(this.tally);
            this._save({ replace: true });
            this._render();
        });
        wipe.style.color = COLORS.bad;
        wipe.style.marginLeft = 'auto';
        buttons.appendChild(wipe);

        section.appendChild(buttons);
        return section;
    }

    /**
     * @param {string} text - Label
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _actionButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
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

    /** The chest summary as a CSV download, built at click time */
    _exportSummaryCsv() {
        try {
            const rows = buildTreasureSummaryRows(this._summary().rows);
            if (!rows.length) return;
            downloadCsv(csvFilename('treasure-chests'), toCsv(rows, TREASURE_SUMMARY_COLUMNS));
        } catch (error) {
            console.error('[TreasureTracker] CSV export failed:', error);
        }
    }

    /** The per-item ledger as a CSV download, built at click time */
    _exportDetailCsv() {
        try {
            const rows = buildTreasureDetailRows(this._summary().rows);
            if (!rows.length) return;
            downloadCsv(csvFilename('treasure-chest-items'), toCsv(rows, TREASURE_DETAIL_COLUMNS));
        } catch (error) {
            console.error('[TreasureTracker] CSV export failed:', error);
        }
    }

    /** Write the ledger to a file */
    _exportHistory() {
        try {
            const file = toExport(this.tally, this.settings, settingsStorage.currentCharacterName || '');
            const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `toolasha-treasure-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('[TreasureTracker] Export failed:', error);
            window.alert('Could not write the export file.');
        }
    }

    /** Read a ledger from a file, ours or TReasure's */
    _importHistory() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';

        // Taken when the picker is opened, not when a file comes back: choosing
        // one is an unbounded wait too, and the import ends in a full overwrite
        const owner = this._owner();
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const json = JSON.parse(await file.text());
                // Ours first, since a TReasure file is anything with chests and
                // ours would otherwise be read by the looser reader
                const read = fromToolashaExport(json) || fromTreasureExport(json);
                if (!read) {
                    window.alert('That file is not a Toolasha or TReasure chest export.');
                    return;
                }

                const chests = Object.keys(read.tally).length;
                const mode = await this._askImportMode(`Import ${chests} chest${chests === 1 ? '' : 's'}.`);
                if (!mode) return;
                if (!this._answerStillApplies(owner)) return;

                this.tally = mergeTally(this.tally, read.tally, mode);
                if (Object.keys(read.settings || {}).length) {
                    this.settings = { ...this.settings, ...read.settings };
                    this._saveSettings();
                    this._refreshToggles();
                }
                this._save({ replace: true });
                this._render();
            } catch (error) {
                console.error('[TreasureTracker] Import failed:', error);
                window.alert('Could not read that file.');
            }
        });
        input.click();
    }

    /**
     * Ask what to do with an imported ledger.
     *
     * Three answers, and three buttons. Squeezing them into OK and Cancel means a
     * sentence explaining which is which, which has to be read twice and can
     * still be read wrong — and reading it wrong overwrites a history that took
     * months to accumulate.
     *
     * @param {string} message - What is about to be imported
     * @returns {Promise<string|null>} `'append'`, `'replace'`, or null to do nothing
     */
    async _askImportMode(message) {
        return askChoice({
            title: 'Import chest history',
            message,
            choices: [
                { value: 'append', label: 'Add', hint: 'Add these counts to what you already have', tone: 'primary' },
                {
                    value: 'replace',
                    label: 'Replace',
                    hint: 'Throw away your history and use the file',
                    tone: 'danger',
                },
                { value: null, label: 'Cancel', hint: 'Leave your history alone' },
            ],
        });
    }

    /** Read Edible Tools' chest history out of its own storage */
    async _importEdibleTools() {
        const owner = this._owner();
        try {
            const raw = window.localStorage.getItem('Edible_Tools');
            if (!raw) {
                window.alert('No Edible Tools data found in this browser.');
                return;
            }

            const found = findEdibleToolsData(
                JSON.parse(raw),
                dataManager.getCurrentCharacterId?.(),
                settingsStorage.currentCharacterName
            );
            if (!found) {
                window.alert('Edible Tools is installed, but has no chest history for this character.');
                return;
            }

            // It keys everything by display name, so the translation needs an
            // index built from the game data as it stands today
            const itemDetails = dataManager.getInitClientData()?.itemDetailMap || {};
            const nameToHrid = {};
            for (const [hrid, detail] of Object.entries(itemDetails)) {
                if (detail?.name) nameToHrid[detail.name] = hrid;
            }

            const { tally, unmatched } = fromEdibleTools(found, nameToHrid);
            const chests = Object.keys(tally).length;
            if (!chests) {
                window.alert('None of the Edible Tools entries matched an item this game knows about.');
                return;
            }

            const warning = unmatched.length
                ? `\n\n${unmatched.length} name${unmatched.length === 1 ? '' : 's'} could not be matched and will be left out:\n` +
                  unmatched.slice(0, 8).join(', ')
                : '';
            const mode = await this._askImportMode(
                `Import ${chests} chest${chests === 1 ? '' : 's'} from Edible Tools.${warning}`
            );
            if (!mode) return;
            if (!this._answerStillApplies(owner)) return;

            this.tally = mergeTally(this.tally, tally, mode);
            this._save({ replace: true });
            this._render();
        } catch (error) {
            console.error('[TreasureTracker] Edible Tools import failed:', error);
            window.alert('Could not read the Edible Tools data.');
        }
    }

    /**
     * @param {string} text - Label
     * @param {Function} onClick - Handler
     * @returns {HTMLButtonElement}
     */
    _headerButton(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        Object.assign(button.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 6px',
            borderRadius: '3px',
        });
        button.addEventListener('mouseover', () => (button.style.background = 'rgba(255, 207, 92, 0.15)'));
        button.addEventListener('mouseout', () => (button.style.background = 'none'));
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    _removePanel() {
        this._stopWaiting();
        this._detachDrag?.();
        this._detachDrag = null;
        this._detachResize?.();
        this._detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.contentEl = null;
        this.headerEl = null;
        this.sortPicker = null;
    }

    _render() {
        if (!this.contentEl) return;
        // The header carries settings too, and they arrive from storage after
        // it is built
        this._refreshToggles();
        this.contentEl.replaceChildren();

        const { rows, totals } = this._summary();
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.style.padding = '8px 2px';
            // Reached only before the game's data has loaded — the list is
            // every chest in the game, not only the ones you have opened
            empty.textContent = 'Waiting for the game to send its chest data…';
            this.contentEl.appendChild(empty);

            // And look again shortly. A panel reopened at start-up is drawn
            // before the game has sent anything, and nothing else redraws it —
            // so the message stayed up for the rest of the session and read as
            // a panel that had stopped working.
            this._waitForChestData();
            return;
        }
        this._stopWaiting();

        if (this.configMode) this.contentEl.appendChild(this._configSection());
        this.contentEl.appendChild(this._totalsRow(totals));

        const hidden = new Set(this.settings.hiddenChests || []);
        for (const row of rows) {
            // Hidden chests stay in the ledger and in the totals; they are only
            // kept off a list that would otherwise be forty rows long
            if (!this.configMode && hidden.has(row.chestHrid)) continue;
            this.contentEl.appendChild(this._chestRow(row, hidden.has(row.chestHrid)));
        }
    }

    /**
     * Draw again once the game has sent its chest data.
     *
     * A timer rather than an event, because the drop tables arrive with the
     * client data rather than with a message of their own, and the one event
     * that would do — `character_initialized` — has usually already fired by the
     * time a restored panel asks. It stops itself the moment there is something
     * to draw, and when the panel closes.
     *
     * It also gives up. If the data has not arrived in five minutes it is not
     * coming this session, and a poll that summarises every chest in the game
     * once a second forever is a poll that outlives its own reason. Reopening
     * the panel starts a fresh attempt. A hidden tab is skipped outright —
     * nobody is reading the message it would replace.
     */
    _waitForChestData() {
        if (this._dataWait) return;
        const startedAt = Date.now();
        this._dataWait = setInterval(() => {
            if (!this.contentEl) return this._stopWaiting();
            if (Date.now() - startedAt > DATA_WAIT_LIMIT_MS) return this._stopWaiting();
            if (document.hidden) return;
            if (this._summary().rows.length) this._render();
        }, 1000);
    }

    _stopWaiting() {
        clearInterval(this._dataWait);
        this._dataWait = null;
    }

    /**
     * @param {Object} totals - From `tallyTotals`
     * @returns {HTMLElement}
     */
    _totalsRow(totals) {
        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 4px 8px',
            borderBottom: `1px solid ${COLORS.border}`,
            marginBottom: '6px',
            fontWeight: 'bold',
        });

        const left = document.createElement('span');
        left.textContent = totals.opened ? `${totals.opened} chests opened` : 'Nothing opened yet';

        const right = document.createElement('span');
        const verdict = formatReturn(totals.ratio);
        right.style.color = verdict.color;
        right.textContent = `${formatLargeNumber(Math.round(totals.actualValue))} of ${formatLargeNumber(
            Math.round(totals.expectedValue)
        )} — ${verdict.text}`;

        wrapper.appendChild(left);
        wrapper.appendChild(right);
        return wrapper;
    }

    /**
     * One chest: a header that reads like the game's own item lines, and the
     * three-column breakdown underneath when expanded.
     *
     * @param {Object} row - From `summariseTally`
     * @param {boolean} isHidden - Whether it is currently hidden from the list
     * @returns {HTMLElement}
     */
    _chestRow(row, isHidden = false) {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '2px';

        const untouched = !row.opened;

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '4px 5px',
            cursor: 'pointer',
            borderRadius: '3px',
            background: 'rgba(255, 255, 255, 0.03)',
        });
        header.addEventListener('mouseover', () => (header.style.background = 'rgba(255, 255, 255, 0.08)'));
        header.addEventListener('mouseout', () => (header.style.background = 'rgba(255, 255, 255, 0.03)'));

        const isExpanded = this.expanded.has(row.chestHrid);
        const caret = this._span(isExpanded ? '−' : '+');
        caret.style.color = COLORS.accent;
        caret.style.width = '9px';

        const name = document.createElement('span');
        name.style.fontWeight = 'bold';
        name.append(itemName(row.chestHrid) + ' ');
        // What one chest is worth on average, beside its name — the figure the
        // rest of the row is measured against
        const ev = this._span(`(${formatLargeNumber(Math.round(row.perChestValue))})`);
        ev.style.color = COLORS.textDim;
        ev.style.fontWeight = 'normal';
        name.appendChild(ev);

        const count = this._span(row.opened ? `×${row.opened}` : '');
        count.style.color = COLORS.textDim;
        count.style.marginLeft = 'auto';

        const verdict = formatReturn(row.ratio);
        const diff = this._span(verdict.text);
        diff.style.color = verdict.color;
        diff.style.minWidth = '58px';
        diff.style.textAlign = 'right';

        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        Object.assign(reset.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '10px',
            padding: '1px 6px',
        });
        reset.title = `Forget every ${itemName(row.chestHrid)} opening`;
        reset.addEventListener('click', (event) => {
            // Without this the click also toggles the row it sits in
            event.stopPropagation();
            if (!window.confirm(`Forget all ${row.opened} ${itemName(row.chestHrid)} openings?`)) return;
            this.tally = resetTally(this.tally, row.chestHrid);
            this._save({ replace: true });
            this._render();
        });

        // A chest you have never opened has no verdict to show and nothing to
        // reset; it is here to be looked up, so it is dimmed rather than
        // decorated with empty controls
        if (untouched) {
            header.style.opacity = '0.65';
            header.append(caret, this._icon(row.chestHrid, 16), name, count);
        } else {
            header.append(caret, this._icon(row.chestHrid, 16), name, count, diff, reset);
        }

        if (this.configMode) {
            header.style.opacity = isHidden ? '0.45' : '1';
            header.appendChild(this._visibilityButton(row.chestHrid, isHidden));
        }

        header.addEventListener('click', () => {
            // In config mode the row is a thing to show or hide, not to expand
            if (this.configMode) return;
            if (this.expanded.has(row.chestHrid)) this.expanded.delete(row.chestHrid);
            else this.expanded.add(row.chestHrid);
            this.settings.expandedChests = [...this.expanded];
            this._saveSettings();
            this._render();
        });

        wrapper.appendChild(header);
        if (isExpanded && !this.configMode) wrapper.appendChild(this._itemBreakdown(row));
        return wrapper;
    }

    /**
     * The eye that shows or hides one chest.
     *
     * Hiding only affects the list. The chest is still tracked and still counted
     * in the totals — a hidden chest that stopped being recorded would make the
     * ledger quietly wrong rather than merely shorter.
     *
     * @param {string} chestHrid - The chest
     * @param {boolean} isHidden - Its current state
     * @returns {HTMLButtonElement}
     */
    _visibilityButton(chestHrid, isHidden) {
        const button = document.createElement('button');
        button.textContent = isHidden ? '🚫' : '👁';
        button.title = isHidden ? 'Show this chest in the list' : 'Hide this chest from the list';
        Object.assign(button.style, {
            background: isHidden ? 'rgba(120, 60, 60, 0.35)' : 'rgba(60, 140, 90, 0.35)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 6px',
            marginLeft: '6px',
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const hidden = new Set(this.settings.hiddenChests || []);
            if (hidden.has(chestHrid)) hidden.delete(chestHrid);
            else hidden.add(chestHrid);

            this.settings = { ...this.settings, hiddenChests: [...hidden] };
            this._saveSettings();
            this._render();
        });
        return button;
    }

    /**
     * The three views of one chest, side by side.
     *
     * Last opening, every opening, and what was owed — read across a row rather
     * than down a column, because the question is always "how does this compare
     * with that" and one column alone cannot answer it. The item order is shared
     * by all three, so a row means the same item in each.
     *
     * @param {Object} row - From `summariseTally`, carrying the chest hrid
     * @returns {HTMLElement}
     */
    _itemBreakdown(row) {
        const dropTable = dataManager.getInitClientData()?.openableLootDropMap?.[row.chestHrid];
        const { last, total, items } = chestBreakdown(this.tally[row.chestHrid], dropTable, this._priceOf());

        const wrap = document.createElement('div');
        Object.assign(wrap.style, {
            padding: '5px 5px 8px',
            background: 'rgba(0, 0, 0, 0.25)',
            borderRadius: '0 0 3px 3px',
            // Every figure is a number in a column; proportional digits make
            // columns of them jitter as the values change
            fontVariantNumeric: 'tabular-nums',
        });

        wrap.appendChild(
            this._headerBand([
                `LAST (×${last.opened || 0})`,
                `TOTAL (×${total.opened})`,
                `EXPECTED (×1 / ×${total.opened})`,
            ])
        );
        wrap.appendChild(this._summaryBand(last, total));

        for (const item of items) wrap.appendChild(this._breakdownRow(item));
        return wrap;
    }

    /**
     * @param {string[]} titles - Three column titles
     * @returns {HTMLElement}
     */
    _headerBand(titles) {
        const band = this._threeColumns();
        Object.assign(band.style, { fontSize: '10px', fontWeight: 'bold', color: '#7fb3ff', padding: '1px 0' });
        for (const title of titles) {
            const cell = document.createElement('div');
            cell.textContent = title;
            cell.style.textAlign = 'center';
            band.appendChild(cell);
        }
        return band;
    }

    /**
     * The verdict under each column title.
     * @param {Object} last - Performance of the last opening
     * @param {Object} total - Performance of every opening
     * @returns {HTMLElement}
     */
    _summaryBand(last, total) {
        const band = this._threeColumns();
        Object.assign(band.style, {
            fontSize: '11px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '4px',
            marginBottom: '3px',
        });

        const cells = [
            { value: last.actualValue, ratio: last.ratio },
            { value: total.actualValue, ratio: total.ratio },
            { value: total.expectedValue, ratio: null },
        ];
        for (const { value, ratio } of cells) {
            const verdict = formatReturn(ratio);
            const cell = document.createElement('div');
            cell.style.textAlign = 'center';
            cell.style.color = ratio === null ? COLORS.textDim : verdict.color;
            cell.textContent =
                ratio === null
                    ? formatLargeNumber(Math.round(value))
                    : `${formatLargeNumber(Math.round(value))} (${verdict.text})`;
            band.appendChild(cell);
        }
        return band;
    }

    /**
     * The outer three-column frame every band shares, so the titles, the summary
     * and every item line stack in the same places.
     * @returns {HTMLElement}
     */
    _threeColumns() {
        const el = document.createElement('div');
        Object.assign(el.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1.35fr',
            gap: '10px',
            alignItems: 'center',
        });
        return el;
    }

    /**
     * One item across all three columns.
     * @param {Object} item - From `chestBreakdown`
     * @returns {HTMLElement}
     */
    _breakdownRow(item) {
        const rowEl = this._threeColumns();
        Object.assign(rowEl.style, { fontSize: '11px', padding: '1px 0' });

        rowEl.appendChild(this._actualCell(item, item.lastCount, item.lastValue, item.lastRatio));
        rowEl.appendChild(this._actualCell(item, item.totalCount, item.totalValue, item.totalRatio));
        rowEl.appendChild(this._expectedCell(item));
        return rowEl;
    }

    /**
     * What dropped, what it was worth, and how that compares.
     *
     * A fixed sub-grid rather than flex, so counts, values and percentages line
     * up down the column instead of drifting with the width of the number above.
     *
     * @param {Object} item - The item, for its icon
     * @param {number} count - What dropped
     * @param {number} value - What it was worth
     * @param {number|null} ratio - Against expectation
     * @returns {HTMLElement}
     */
    _actualCell(item, count, value, ratio) {
        const cell = document.createElement('div');
        Object.assign(cell.style, {
            display: 'grid',
            gridTemplateColumns: '15px 1fr 1fr 54px',
            gap: '4px',
            alignItems: 'center',
        });

        const verdict = formatReturn(ratio);
        const countEl = this._span(formatLargeNumber(count));
        const valueEl = this._span(value > 0 ? formatLargeNumber(Math.round(value)) : '');
        valueEl.style.color = COLORS.good;
        valueEl.style.textAlign = 'right';
        const diffEl = this._span(ratio === null ? '' : verdict.text);
        diffEl.style.color = verdict.color;
        diffEl.style.textAlign = 'right';

        cell.append(this._icon(item.itemHrid, 13), countEl, valueEl, diffEl);
        return cell;
    }

    /**
     * What one chest owed, and what the whole run owed.
     * @param {Object} item - From `chestBreakdown`
     * @returns {HTMLElement}
     */
    _expectedCell(item) {
        const cell = document.createElement('div');
        Object.assign(cell.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 8px 1fr 1fr',
            gap: '4px',
            alignItems: 'center',
            color: COLORS.textDim,
        });

        const perChest = this._span(smallCount(item.expectedPerChest));
        const perChestValue = this._span(formatLargeNumber(Math.round(item.expectedPerChestValue)));
        perChestValue.style.textAlign = 'right';
        const divider = this._span('|');
        divider.style.textAlign = 'center';
        const overall = this._span(smallCount(item.expectedTotal));
        overall.style.textAlign = 'right';
        const overallValue = this._span(formatLargeNumber(Math.round(item.expectedTotalValue)));
        overallValue.style.textAlign = 'right';

        cell.append(perChest, perChestValue, divider, overall, overallValue);
        return cell;
    }

    /**
     * @param {string} text - Content
     * @returns {HTMLElement}
     */
    _span(text) {
        const span = document.createElement('span');
        span.textContent = text;
        span.style.whiteSpace = 'nowrap';
        span.style.overflow = 'hidden';
        span.style.textOverflow = 'ellipsis';
        return span;
    }
}

const treasureTracker = new TreasureTracker();

// Reopen if the page was left with the panel up. At module scope rather than in
// `initialize`, because the feature's initialize is gated on a setting and the
// panel outliving a refresh is not the same question as the tracker running.
treasureTracker.restore();

// Registered at module scope so the overlay has the row whether or not this
// feature has started yet. It draws nothing until a chest has been opened.
/**
 * How many price feeds have landed.
 *
 * `_summary()` prices every item of every chest's drop table against what
 * actually dropped, and the overlay tile asked it to do that once a second for a
 * verdict that only moves when a chest is opened or a price changes.
 */
let priceFeed = 0;

marketAPI.on(() => {
    priceFeed++;
});

/**
 * What the Treasure tile would summarise, without summarising it.
 *
 * How many of each kind of chest have been opened, the price feed, and the two
 * settings that decide what an unpriceable reward is worth. Opened counts are
 * enough to stand for the ledger: nothing adds items to a chest's tally without
 * adding to its opened count, and the reset, merge and import paths all move it
 * too. The drop tables themselves are static game data, and the sort mode
 * reorders rows this tile does not draw.
 *
 * @returns {string}
 */
function treasureVersion() {
    if (!treasureTracker.isInitialized) return 'blank';

    const ledger = Object.entries(treasureTracker.tally || {}).map(([chestHrid, entry]) => {
        // The loot total as well as the opened count: an import in replace mode
        // can land a different haul under the same number of openings, and the
        // verdict is a comparison of the haul against the drop table
        const loot = Object.values(entry?.loot || {}).reduce((sum, count) => sum + count, 0);
        return `${chestHrid}:${entry?.opened || 0}:${loot}`;
    });
    const settings = treasureTracker.settings || {};
    return [
        ledger.join(','),
        priceFeed,
        // Which side of the book the rewards are priced at is a setting of its
        // own, and it moves every figure on the tile without touching the ledger
        getPricingMode('profit', 'sell'),
        settings.capeValue,
        settings.valueCowbells ? 1 : 0,
    ].join('|');
}

registerRow({
    key: 'treasure',
    empty: 'No chests opened',
    name: 'Treasure',
    defaultSize: { width: 200, height: 30 },
    version: treasureVersion,
    render: (container) => {
        if (!treasureTracker.isInitialized) return blank(container);

        const { totals } = treasureTracker._summary();
        if (!totals.opened) return blank(container);

        const verdict = formatReturn(totals.ratio);
        row(container, [
            // The chest itself rather than the overlay's generic chest glyph:
            // this tile is about chests specifically, and the item art says so
            // at a glance where a symbol has to be learned
            { icon: 'large_treasure_chest', size: 16 },
            { text: `${formatLargeNumber(totals.opened)} chests`, color: ROW_COLORS.dim },
            { text: verdict.text, color: verdict.color, bold: true, push: true },
        ]);
        container.title = `${formatLargeNumber(Math.round(totals.difference))} against expectation over every chest opened.`;
    },
    onOpen: () => treasureTracker.toggle(),
});

export default treasureTracker;
