/**
 * Consumables panel
 *
 * Everything the character is eating and drinking — and, in a dungeon, the
 * entry keys the runs are spending — how long it lasts, and what it would take
 * to keep it going.
 *
 * The overlay row answers "what runs out first, and when". That is the figure
 * worth watching, but it is not the figure worth acting on — when the answer is
 * "six hours", the next question is immediately "so what do I buy, and how
 * much", and the row cannot hold that. This can.
 *
 * ## The target duration is the point
 *
 * Every line is measured against a duration you pick: overnight, a day, a
 * weekend. A list of stock levels tells you what you have; the same list against
 * "last me a day" tells you what to do about it, and the two readings differ for
 * every consumable because they are consumed at different rates.
 *
 * Shortfalls are rounded up and counted from what is already held, so the figure
 * is what to buy rather than what to own. The arithmetic is in
 * `utils/consumable-forecast.js`; this module lists, sorts and draws.
 *
 * Party members are shown when there are any, because a party run stops when the
 * **first** member runs dry, and that member is frequently not you.
 *
 * ## Why it lives in the UI bundle
 *
 * It reads combat data but is otherwise a panel, and the combat bundle is close
 * to its size ceiling while this one is not. The collector it reads is a
 * stateful singleton fed by the websocket, so it is declared shared in
 * `rollup.config.js` rather than imported into a second copy that would sit
 * there receiving nothing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { registerEscapeClose } from '../../utils/panel-escape.js';
import {
    createFloatingWidget,
    widgetDivider,
    widgetNote,
    widgetNumberRow,
    widgetCheckboxRow,
} from '../../utils/floating-widget.js';
import { shortDuration, itemIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { getItemPrices } from '../../utils/market-data.js';
import { currentTarget, cycleTarget, loadTarget } from '../../utils/consumable-target.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import {
    forecast,
    forecastAll,
    firstToRunOut,
    costPerDaySides,
    refillFor,
    refillAll,
    drinkRatePerDay,
    buyStrategy,
} from '../../utils/consumable-forecast.js';
import { dungeonEntryKey, heldInInventory, keyConsumableEntry } from '../../utils/dungeon-key-forecast.js';
import {
    buildReadiness,
    keyReadiness,
    memberLimit,
    memberReadiness,
    mergePartyRoster,
    formatKeyShortfall,
    formatKeyShortfalls,
    nextRunStep,
    parseRunsPlanned,
    typicalRunSeconds,
    MAX_RUNS_PLANNED,
} from '../../utils/dungeon-readiness.js';
import {
    KEY_PRICING_MODES,
    KEY_PRICING_SETTING,
    describeKeyCost,
    invalidateKeyCostCache,
    resolveKeyPricing,
} from '../../utils/key-cost.js';
import { partyLintWarnings } from '../../utils/party-lint.js';
import { combatLevel } from '../../utils/combat-level.js';
import { registerCommand } from '../../utils/command-registry.js';
import { resolveSupplyHrids, readSupplyCounts, bestOwnedTier, SUPPLY_KINDS } from '../combat/labyrinth-supplies.js';
import {
    rushFloorTable,
    preserveChance,
    observedUse,
    burnSummary,
    torchesPerFloor,
    sparkText,
} from '../combat/labyrinth-run-ledger.js';
import { rushFloorVerdict } from '../combat/labyrinth-rush-floor-verdict.js';
import storage from '../../core/storage.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { estimateFillSeconds } from '../../utils/order-book.js';
import { openShoppingList } from './consumables-shopping-list.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { dungeonTracker, queueLengthEstimator } from '../../utils/bundle-bridge.js';
import { getDrinkConcentration } from '../../utils/tea-parser.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

const PANEL_ID = 'toolasha-consumables-panel';

/**
 * A member's burn forecast reduced to the one number the readiness card reads.
 *
 * The card takes the soonest-empty slot per member (`memberReadiness`), so that
 * is what the memo has to notice moving. Rounded to a minute: consumption rates
 * are measured, so the raw figure jitters in its last decimals every refresh
 * and an exact stamp would defeat the memo entirely.
 *
 * @param {Array<Object>|null} forecasts - As `consumable-forecast` normalised them
 * @returns {string} `'-'` when nothing was measured
 */
function burnStamp(forecasts) {
    if (!Array.isArray(forecasts) || !forecasts.length) return '-';

    let soonest = null;
    for (const entry of forecasts) {
        if (!Number.isFinite(entry?.secondsLeft)) continue;
        if (!soonest || entry.secondsLeft < soonest.secondsLeft) soonest = entry;
    }
    if (!soonest) return '-';
    // The limiter's name is on the card too, so a swap of which slot empties
    // first has to invalidate even when the countdown lands on the same minute
    return `${soonest.name || soonest.itemHrid || ''}@${Math.round(soonest.secondsLeft / 60)}`;
}

/**
 * The Buy-all walk's floating control — outside the panel, which hides itself to
 * go shopping, so the walk's next step and its rules stay reachable while the
 * marketplace is up.
 */
const BUY_CHIP_ID = 'toolasha-lab-buy-next';
const BUY_WIDGET_POSITION_KEY = 'consumablesBuyWidgetPosition';

/**
 * How the idle plan's pins treat a value left behind by the pre-scoping build.
 *
 * Discarded rather than adopted: a loadout name and a simmed zone key only mean
 * anything inside the character they were chosen on, so handing them to anyone
 * is the leak rather than a rescue of the main's data.
 */
const DISCARD_LEGACY = { migrate: 'discard' };

/**
 * The rules the Buy-all walk decides by, editable from its own widget.
 *
 * The same settings the row-by-row recommendation reads, rather than a copy:
 * the moment you want to change one of these is the moment you are watching the
 * walk open the wrong form.
 */
const BUY_TUNABLES = [
    {
        key: 'market_consumableBuyMaxSpreadPct',
        fallback: 2,
        label: 'Buy instantly when the spread is under',
        suffix: '%',
        title: 'When the best ask and the best bid are within this percentage of each other, a buy order saves a sliver and costs a wait. 0 turns the rule off.',
    },
    {
        key: 'market_consumableBuyMinSaving',
        fallback: 0,
        label: 'Buy instantly when an order saves under',
        suffix: 'coins',
        title: 'The same idea in coins: what waiting at the bid would save over paying the ask, across the whole restock. 0 turns the rule off.',
    },
    {
        key: 'market_consumableBuyMinOrderValue',
        fallback: 0,
        label: 'Buy instantly when the order is worth under',
        suffix: 'coins',
        title: 'Restocks worth less than this (bid × count) are bought outright rather than using up a buy-order slot. 0 turns the rule off.',
    },
];
const GEOMETRY_KEY = 'consumablesPanel';
const DEFAULT_PANEL = { width: 520, height: 420 };
const REFRESH_MS = 5000;

/**
 * How many runs the readiness card is sized for, and what the header button
 * cycles through.
 *
 * The old default of five was smaller than any stock anybody actually holds: a
 * food pile good for thousands of runs and a key pile in the thousands both
 * came back "covers 5", which is the card answering a question nobody asked.
 * The plan is only informative when it reaches far enough to touch something.
 *
 * A hundred is a day of continuous dungeoning at the run lengths this card
 * already measures — `typicalRunSeconds` puts a party dungeon run in the
 * ten-minute range, so 144 runs is a full day and a hundred is the round
 * figure just inside it. That also lines the card up with the rest of the
 * panel, whose consumable target defaults to one day: both halves now plan
 * against the same horizon instead of quietly disagreeing by a factor of
 * thirty.
 *
 * Every step the old list offered is still in this one, so a target somebody
 * has already picked keeps working and keeps cycling from where it is.
 *
 * The ladder stays roughly geometric rather than filling in the linear middle
 * (75, 200, 300, 400) now that any count can be typed: a preset list is for
 * reaching the right *order of magnitude* in one or two clicks, and an exact
 * figure — four keys, 2,753 runs of food — is a thing to type, not a thing to
 * click twelve times towards. Ten steps that span 1 to 1000 do that; ten steps
 * that span 5 to 500 spend four of themselves inside one decade and still
 * cannot reach either end.
 */
const DUNGEON_RUN_STEPS = [1, 3, 5, 10, 25, 50, 100, 250, 500, 1000];
const DEFAULT_DUNGEON_RUNS = 100;

/** How long a key's buy-versus-craft costing is reused before it is re-priced */
const KEY_COST_TTL_MS = 60_000;

/**
 * What each stored key pricing mode is called on the card's chip.
 *
 * Short enough for a chip, and deliberately the same vocabulary the Settings
 * page uses, so somebody who cycles the chip and then goes looking for the
 * setting recognises what they changed.
 */
const KEY_PRICING_LABELS = {
    ask: 'ask',
    bid: 'bid',
    synced: 'synced',
    craft: 'craft cost',
};

const COLORS = {
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(20, 30, 24, 0.9)',
    border: 'rgba(120, 200, 150, 0.32)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fd6a3',
};

/**
 * Who is logged in, for the reads whose answers must not outlive them.
 * @returns {string|null} The character id, or null before login
 */
function currentCharacterId() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

class ConsumablesPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        /** This panel's place in the shared Escape-to-close stack, while open */
        this._escapeReg = null;
        /** The Buy-all walk's floating control, and what it is offering */
        this.buyWidget = null;
        this._buyWidgetPosition = null;
        this._buyWidgetHidden = false;
        /** One entry per section with a walkable shortfall, rebuilt every render */
        this._buyQueues = [];
        this._buySource = null;
        /**
         * Bumped on every `reloadIdlePins()` call. The pins are read with two
         * awaited `readScoped` calls, and `character_switched` fires a fresh
         * call on every switch with no way to cancel whichever call is already
         * in flight — two switches close enough together interleave their
         * awaits, and storage does not promise to resolve them in call order.
         * Without this, an older call's answer can land after a newer one and
         * overwrite the pins with the departed character's values, which the
         * idle plan then silently plans against under the *arriving*
         * character's name. Mirrors `consumable-target.js`'s `loadTarget`.
         */
        this._idlePinsGeneration = 0;
        /**
         * Whose `_labFightAttempts` pool is in hand.
         *
         * The pool is read lazily on the first rush-floor draw and nothing
         * re-reads it, so it has to say who it belongs to or it outlives them.
         */
        this._labFightAttemptsOwner = null;
        /** Same purpose as `_idlePinsGeneration`, for `_refreshStoredReadings()` */
        this._storedReadingsGeneration = 0;
        /** The entry key's buy-versus-craft costing, and when it was priced */
        this._keyCostCache = null;
        // The same mechanism the missing-materials features use: park a quantity,
        // and the buy modal fills itself in when it appears
        this.autofill = createAutofillManager('Consumables');
        this.autofill.initialize?.();
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        // Opening the panel is asking for its controls back, the Buy-all widget
        // included — a ✕ hides it for this visit, not for good
        this._buyWidgetHidden = false;
        this._refreshStoredReadings();
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            // Escape's idea of "in front" has to follow the eye's
            this._escapeReg?.raise();
            return;
        }
        // Held but no longer in the document — torn down rather than abandoned,
        // or its refresh timer and its listeners would still be running and each
        // reopen would leave another set behind
        if (this.panel) this._remove();
        this._create();
        // A new panel opens at the base z-index, which is *underneath* every
        // panel raised since the page loaded — so the panel you just asked for
        // appears behind the ones you did not
        bringPanelToFront(this.panel);
    }

    /**
     * Re-read what other modules write while the panel is closed — the sim's
     * measured consumable rates and the lab run ledger — so a finished sim
     * rates the idle plan's food on the panel's next open rather than on the
     * next page load.
     *
     * The dungeon run history and the captured profiles are here for the same
     * reason and a sharper one: opening a party member's profile in game is the
     * one action that turns their readiness line from unknown into known, and a
     * card that needed a page reload to notice would teach the player it does
     * not work.
     */
    async _refreshStoredReadings() {
        const started = (this._storedReadingsGeneration += 1);
        try {
            const [rates, byZone, ledger, runs, profiles] = await Promise.all([
                readScoped('simConsumableRates', 'combatExport', null).catch(() => null),
                readScoped('simConsumableRatesByZone', 'combatExport', {}).catch(() => ({})),
                readScoped('labyrinthRunLedger', 'labyrinth', []).catch(() => []),
                storage.getJSON('allRuns', 'unifiedRuns', []).catch(() => []),
                storage.getJSON('profile_list', 'combatExport', []).catch(() => []),
            ]);
            // A newer call — this panel shown again for a different character
            // before this one's reads landed — already applied its own answer;
            // this one belongs to a character the panel has since left
            if (started !== this._storedReadingsGeneration) return;
            const changed =
                JSON.stringify(rates) !== JSON.stringify(this._simRates) ||
                JSON.stringify(byZone) !== JSON.stringify(this._simRatesByZone) ||
                JSON.stringify(ledger) !== JSON.stringify(this._ledgerRuns) ||
                JSON.stringify(runs) !== JSON.stringify(this._dungeonHistory) ||
                JSON.stringify(profiles) !== JSON.stringify(this._profiles);
            this._simRates = rates;
            this._simRatesByZone = byZone || {};
            this._ledgerRuns = ledger || [];
            this._dungeonHistory = runs || [];
            this._profiles = profiles || [];
            // A refreshed profile list or run history changes what the card
            // says without changing its signature's shape, so the memo goes
            if (changed) this._readinessMemo = null;
            if (changed && this.panel) this._render();
        } catch {
            // Stale readings render exactly what the last open rendered
        }
    }

    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
        // A running walk keeps its control; nothing else does
        this._syncBuyWidget();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Reopen if the page was left with this panel up */
    restore() {
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /** Read back the duration everything is measured against */
    async loadSettings() {
        await loadTarget(() => this._render());
        this._labRuns = Number(await storage.get('consumablesLabRuns', 'settings', 5)) || 5;
        this._buyWidgetPosition = await storage.get(BUY_WIDGET_POSITION_KEY, 'settings', null);
        // The idle plan's pins: which loadout to plan for, which simmed zone rates its food
        await this.reloadIdlePins();
        // The sims' measured consumable use, for rating food while idle
        this._simRates = await readScoped('simConsumableRates', 'combatExport', null).catch(() => null);
        this._simRatesByZone =
            (await readScoped('simConsumableRatesByZone', 'combatExport', {}).catch(() => ({}))) || {};
        this._ledgerRuns = (await readScoped('labyrinthRunLedger', 'labyrinth', []).catch(() => [])) || [];
        // The dungeon readiness card: how many runs to plan for, the recorded
        // run history that turns "hours of food" into "runs of food", and the
        // captured profiles that are the only pre-run window onto anybody else
        // Through the same validator the typed box uses: a stored value is not
        // more trustworthy than a typed one — it *was* a typed one, and a
        // hand-edited setting could be anything
        this._dungeonRuns =
            parseRunsPlanned(await storage.get('consumablesDungeonRuns', 'settings', DEFAULT_DUNGEON_RUNS)) ??
            DEFAULT_DUNGEON_RUNS;
        this._dungeonHistory = (await storage.getJSON('allRuns', 'unifiedRuns', []).catch(() => [])) || [];
        this._profiles = (await storage.getJSON('profile_list', 'combatExport', []).catch(() => [])) || [];
        // Everything the readiness memo is a function of has just been re-read.
        // The key costing goes with it: a craft cost is this character's own —
        // artisan tea, efficiency and gear all move it — so an alt must not
        // inherit the figure priced for whoever was logged in before.
        this._readinessMemo = null;
        this._keyCostCache = null;
    }

    /**
     * Re-read the idle plan's two pins for whoever is logged in now.
     *
     * Both name something that exists only inside one character: the loadout
     * pin is a name out of *that* character's combat loadouts, and the zone pin
     * indexes *that* character's `simConsumableRatesByZone` — which is already
     * character-scoped. Under the old bare keys the pins followed the account,
     * so an alt planned against a loadout it does not have (silently falling
     * back to its first) and against a zone it has never simmed (drawn
     * "(unsimmed)"). `migrate: 'discard'` for the same reason the combat target
     * uses it: inheriting the other character's pin IS the leak.
     *
     * Reloaded on every switch, because a pin read once at start-up is the same
     * leak arriving a little later.
     */
    async reloadIdlePins() {
        const started = (this._idlePinsGeneration += 1);
        try {
            const loadoutName = await readScoped('consumablesIdleLoadout', 'settings', null, DISCARD_LEGACY);
            if (started !== this._idlePinsGeneration) return; // A newer switch already started its own read
            const zoneKey = (await readScoped('consumablesIdleZone', 'settings', null, DISCARD_LEGACY)) || 'last';
            if (started !== this._idlePinsGeneration) return; // Superseded between the two awaits

            this._idleLoadoutName = loadoutName;
            this._idleZoneKey = zoneKey;
            this._readinessMemo = null;
        } catch (error) {
            console.error('[Consumables] Reading the idle plan pins failed:', error);
        }
    }

    /**
     * Pin the loadout the idle plan is drawn from, for this character only.
     * @param {string} value - A loadout name out of this character's snapshots
     */
    pinIdleLoadout(value) {
        this._idleLoadoutName = value;
        writeScoped('consumablesIdleLoadout', value, 'settings').catch((error) => {
            console.error('[Consumables] Saving the idle loadout pin failed:', error);
        });
    }

    /**
     * Pin the simmed zone whose measured rates price the idle plan's food.
     * @param {string} value - A zone key out of this character's sim results
     */
    pinIdleZone(value) {
        this._idleZoneKey = value;
        writeScoped('consumablesIdleZone', value, 'settings').catch((error) => {
            console.error('[Consumables] Saving the idle zone pin failed:', error);
        });
    }

    /** The duration everything is measured against */
    get target() {
        return currentTarget();
    }

    /**
     * Every player's consumables, the current character first.
     *
     * A party run stops when the first member runs dry, and that member is
     * frequently not you — so party members are listed rather than summarised
     * away.
     *
     * @returns {Array<{name: string, isCurrent: boolean, forecasts: Array<Object>}>}
     */
    _players() {
        const data = combatStatsDataCollector.getLatestData();
        if (!data?.players?.length) return [];

        const duration = data.durationSeconds || 0;
        return data.players
            .map((player) => {
                const stats = calculatePlayerStats(player, duration);
                const forecasts = forecastAll(
                    this._liveCounts(this._exactRates(stats?.consumableBreakdown, player), player),
                    (hrid) => getItemPrices(hrid),
                    {
                        keepOrder: true,
                    }
                );

                // The dungeon's entry key, for the character whose inventory is
                // visible — a run stops on an empty key pile exactly as it does
                // on an empty coffee slot, so it belongs in the same list
                if (player.isCurrentPlayer) {
                    const key = this._keyForecast(stats, data);
                    if (key) forecasts.push(key);
                }

                return {
                    name: player.name || 'Unknown',
                    isCurrent: !!player.isCurrentPlayer,
                    forecasts,
                };
            })
            .filter((entry) => entry.forecasts.length)
            .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    }

    /**
     * The current dungeon's entry key as a forecast, or null outside a dungeon.
     *
     * Null is the whole answer for a zone: the panel must render exactly as it
     * always has when no keys are being spent. The rate is the session's own
     * measurement — one entry key per regular chest, over the run's duration,
     * the same arithmetic the combat stats price keys with — and a session that
     * has not dropped a chest yet honestly has no rate, which the row shows as
     * "—" while still counting what is held.
     *
     * @param {Object} stats - From `calculatePlayerStats`, for its `keyBreakdown`
     * @param {Object} data - The collector's snapshot, for the action and duration
     * @returns {Object|null} A forecast like any other, or null when not a dungeon
     */
    _keyForecast(stats, data) {
        try {
            const actionHrid = data?.actionHrid;
            if (!actionHrid) return null;

            const keyHrid = dungeonEntryKey(actionHrid, dataManager.getActionDetails?.(actionHrid));
            if (!keyHrid) return null;

            const prices = getItemPrices(keyHrid);
            const entry = keyConsumableEntry({
                itemHrid: keyHrid,
                itemName: dataManager.getItemDetails?.(keyHrid)?.name,
                held: heldInInventory(dataManager.getInventory?.(), keyHrid),
                keyBreakdown: stats?.keyBreakdown,
                durationSeconds: data.durationSeconds || 0,
                fallbackPrice: prices?.ask,
            });
            return forecast(entry, prices);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the entry-key row failed:', error);
            return null;
        }
    }

    /** How many runs the readiness card is sized for */
    get dungeonRuns() {
        return this._dungeonRuns || DEFAULT_DUNGEON_RUNS;
    }

    /**
     * Adopt a run target and remember it, the way the labyrinth block does.
     *
     * The one place the plan is written, so the cycle and the typed box cannot
     * drift on what counts as valid or on what gets stored. A value the
     * validator rejects is not written and not applied: the stored plan is left
     * exactly as it was, which is what makes a mistyped entry harmless.
     *
     * @param {string|number} value - A typed or cycled run count
     * @returns {boolean} Whether it was accepted
     */
    _setDungeonRuns(value) {
        const runs = parseRunsPlanned(value);
        if (runs === null) return false;
        this._dungeonRuns = runs;
        this._readinessMemo = null;
        storage.set('consumablesDungeonRuns', runs, 'settings').catch(() => {});
        this._render();
        return true;
    }

    /**
     * Cycle the run target up to the next preset.
     *
     * A typed target is almost never one of the steps, so the cycle steps up
     * *past* where the plan is rather than looking its index up — see
     * `nextRunStep`. That keeps the button useful after a number was typed
     * instead of silently discarding it back to the bottom of the ladder.
     */
    _cycleDungeonRuns() {
        this._setDungeonRuns(nextRunStep(this.dungeonRuns, DUNGEON_RUN_STEPS));
    }

    /**
     * The inline editor for the run target.
     *
     * An input in the heading rather than `window.prompt`, which a userscript
     * context blocks often enough to be unreliable — the same call the layout
     * bar and the market watchlist chips both make. Seeded with the current
     * plan, so a glance-and-Enter changes nothing and typing over the seed is
     * the case somebody opened it for. Enter commits, Escape leaves the plan
     * untouched, and blur commits the way the other two editors do.
     *
     * The chip beside it still cycles, so nothing got slower for anybody who
     * was happy clicking through the presets.
     *
     * @param {HTMLElement} heading - The card heading to draw the input into
     */
    _editDungeonRuns(heading) {
        if (heading.querySelector('input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.value = String(this.dungeonRuns);
        input.title = `How many runs to check against — 1 to ${formatWithSeparator(MAX_RUNS_PLANNED)}`;
        Object.assign(input.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '1px 4px',
            width: '64px',
        });

        let settled = false;
        const commit = () => {
            if (settled) return;
            settled = true;
            // A rejected entry is not an instruction to change anything, so the
            // box simply closes and the card redraws the plan it already had
            if (!this._setDungeonRuns(input.value)) {
                input.remove();
                this._render();
            }
        };

        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => {
            // Kept off the game, which listens for keys on the document
            event.stopPropagation();
            if (event.key === 'Enter') commit();
            else if (event.key === 'Escape') {
                settled = true;
                input.remove();
                this._render();
            }
        });
        input.addEventListener('blur', () => commit());

        heading.appendChild(input);
        input.focus();
        input.select();
    }

    /**
     * What one entry key costs to buy and to craft, cached for a minute.
     *
     * `describeKeyCost` walks the recipe through the crafting planner against
     * this character's own efficiency and artisan bonus, which is far too much
     * work for a panel that redraws every five seconds — and the answer moves
     * only when the market does. A minute is short enough that a key bought
     * mid-session reprices, long enough that the redraw clock never pays for it.
     *
     * @param {string|null} keyHrid - The dungeon's entry key
     * @returns {Object|null} From `describeKeyCost`, or null when it cannot run
     */
    _keyCost(keyHrid) {
        if (!keyHrid) return null;
        // Part of the cache identity, not just of the answer: a key priced at
        // ask is not the same costing as the same key priced at craft cost, and
        // a mode changed on the Settings page must not read stale for a minute.
        // The resolved pricing, not the stored word: 'synced' and 'craft' both
        // take their market side from `profitCalc_pricingMode`, so that setting
        // moving underneath them changes the costing without changing the name
        // of the mode.
        const resolved = resolveKeyPricing();
        const pricing = `${resolved.setting}|${resolved.priceSide}|${resolved.basis}`;
        const cached = this._keyCostCache;
        if (cached?.keyHrid === keyHrid && cached.pricing === pricing && Date.now() - cached.at < KEY_COST_TTL_MS) {
            return cached.cost;
        }

        let cost = null;
        try {
            cost = describeKeyCost(keyHrid);
        } catch (error) {
            console.error('[ConsumablesPanel] Pricing the entry key failed:', error);
        }
        this._keyCostCache = { keyHrid, pricing, at: Date.now(), cost };
        return cost;
    }

    /**
     * The key pricing mode as stored, resolved so an unknown value has a name.
     * @returns {string} One of `KEY_PRICING_MODES`
     */
    _keyPricingMode() {
        return resolveKeyPricing().setting;
    }

    /**
     * Move the key pricing setting on to the next mode.
     *
     * This writes the same `profitCalc_keyPricingMode` the Settings page writes
     * — there is no per-panel copy of it, because a card that valued keys
     * differently from net worth and the ROI board would be the disagreement
     * this whole setting exists to prevent. The chip says so on its face and in
     * its tooltip; see `_keyPricingChip`.
     *
     * The costing is cached on both sides of the bundle boundary, so both
     * caches are dropped here rather than waiting out their minute: the shared
     * craft-basis memo in `key-cost.js`, and this panel's own. The readiness
     * memo goes with them because its signature is a function of the costing.
     */
    _cycleKeyPricingMode() {
        const modes = KEY_PRICING_MODES;
        // `indexOf` of an unrecognised stored value is -1, which lands on the
        // first mode — the same place `resolveKeyPricing` puts it
        const next = modes[(modes.indexOf(this._keyPricingMode()) + 1) % modes.length];
        config.setSetting(KEY_PRICING_SETTING, next);

        invalidateKeyCostCache();
        this._keyCostCache = null;
        this._readinessMemo = null;
        this._render();
    }

    /**
     * The chip that cycles the key pricing mode.
     *
     * Built to look and behave like the run-count chip beside it — same box,
     * same click-to-cycle — because a third control style in one heading is a
     * thing to learn rather than a thing to use.
     *
     * What it must not be is a chip that looks local and is global. The gear
     * marks it as a settings control, the label names the mode in the Settings
     * page's own words, and the tooltip states outright which setting is being
     * written and what else moves when it does.
     *
     * @returns {HTMLElement}
     */
    _keyPricingChip() {
        const mode = this._keyPricingMode();
        const chip = document.createElement('button');
        Object.assign(chip.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
        });
        chip.textContent = `⚙ keys: ${KEY_PRICING_LABELS[mode] || mode}`;
        chip.title =
            `Key pricing: ${KEY_PRICING_LABELS[mode] || mode}. Click to cycle.\n\n` +
            'This is the global "Key pricing mode" setting, not a setting for this card — changing it here ' +
            'also changes your net worth, item tooltips, combat income and the dungeon ROI board.';
        chip.addEventListener('click', (event) => {
            event.stopPropagation();
            this._cycleKeyPricingMode();
        });
        return chip;
    }

    /**
     * The party's entry keys, as the game itself stated them.
     *
     * Every run the game posts a key-count message to party chat naming each
     * member and the keys they have left, and the dungeon tracker parses it.
     * Read through the bridge because the tracker is a websocket-fed singleton
     * in the combat bundle: this bundle's own copy would have heard nothing.
     *
     * Guarded on the dungeon, because a tracked run of a *different* dungeon
     * would hand this card counts of the wrong key.
     *
     * @param {string} actionHrid - The dungeon the card is about
     * @returns {Object} Name to key count; empty when no message has arrived
     */
    _partyKeyCounts(actionHrid) {
        try {
            const run = dungeonTracker()?.getCurrentRun?.();
            if (!run || run.dungeonHrid !== actionHrid) return {};
            return run.keyCountsMap || {};
        } catch (error) {
            console.error('[ConsumablesPanel] Reading the party key counts failed:', error);
            return {};
        }
    }

    /**
     * The names the running battle knows, for a party chat has not named yet.
     *
     * Guarded on the dungeon for the same reason the key counts are: the
     * collector keeps the last battle it saw, and last night's party is not
     * this one. A snapshot with no action recorded is not trusted to be this
     * dungeon's either.
     *
     * @param {string} actionHrid - The dungeon the card is about
     * @returns {Array<string>}
     */
    _battleNames(actionHrid) {
        try {
            const data = combatStatsDataCollector.getLatestData?.();
            if (data?.actionHrid !== actionHrid) return [];
            return (data.players || []).map((player) => player?.name).filter(Boolean);
        } catch {
            return [];
        }
    }

    /**
     * Which dungeon this character is about to run, and who with.
     *
     * The live action queue is preferred over `partyInfo` because `partyInfo`
     * is an `init_character_data` snapshot that nothing updates — it says what
     * the party was set to when the page loaded, not what the leader picked
     * since. The queue is kept current but only speaks for you, so the party
     * block is the fallback and is marked as such.
     *
     * The roster is not the slot map alone: `partySlotMap` is `{}` for the
     * whole of a battle, so mid-run the card had a party it could not name. The
     * key-count message names everyone and states their keys together, so it
     * leads; the battle payload names them without keys and follows, for the
     * window before the first key-count message of the run arrives.
     *
     * @returns {Object|null} Null when this is not a dungeon
     */
    _dungeonContext() {
        const characterData = dataManager.characterData;
        if (!characterData) return null;

        const slots = characterData.partyInfo?.partySlotMap || null;
        const slotMembers = slots ? Object.values(slots).filter(Boolean) : [];

        const live = (dataManager.getCurrentActions?.() || []).find(
            (action) => action.actionHrid?.startsWith('/actions/combat/') && !action.isDone
        );

        let actionHrid = live?.actionHrid || null;
        let tier = Number(live?.difficultyTier) || 0;
        let stale = false;

        if (!actionHrid && characterData.partyInfo?.party?.actionHrid) {
            actionHrid = characterData.partyInfo.party.actionHrid;
            tier = Number(characterData.partyInfo.party.difficultyTier) || 0;
            stale = true;
        }
        if (!actionHrid) return null;

        const detail = dataManager.getActionDetails?.(actionHrid);
        if (detail?.combatZoneInfo?.isDungeon !== true) return null;

        const keyCounts = this._partyKeyCounts(actionHrid);
        const roster = mergePartyRoster(slotMembers, [...Object.keys(keyCounts), ...this._battleNames(actionHrid)]);

        return {
            actionHrid,
            tier,
            stale,
            roster,
            keyCounts,
            name: detail.name || actionHrid.split('/').pop(),
            characterId: characterData.character?.id ?? null,
            selfName: characterData.character?.name || 'You',
            // The name the game gave, never the 'You' placeholder: it is an
            // identity test in `isSelfMember`, and matching a member called
            // 'You' would hand them your equipment and your key pile.
            selfRealName: characterData.character?.name || null,
        };
    }

    /**
     * Whether a roster entry is the logged-in character.
     *
     * Not an id comparison alone, for two reasons the roster makes routine.
     * `partySlotMap` empties for the whole of a battle, so mid-run every entry
     * comes from `mergePartyRoster`'s name-only fallback with a null
     * `characterID` — including your own — and an id test says none of them is
     * you. And where the character block carries no id, `null === null` says
     * *all* of them are you, which puts your gear and your key count on every
     * line in the party.
     *
     * So ids decide it only when there is an id on both sides; otherwise the
     * name does, against the name the game stated rather than the placeholder.
     *
     * @param {Object} member - A roster entry from `mergePartyRoster`
     * @param {Object} context - From `_dungeonContext`
     * @returns {boolean}
     */
    _isSelfMember(member, context) {
        if (member?.characterID != null && context?.characterId != null) {
            return member.characterID === context.characterId;
        }
        return Boolean(context?.selfRealName) && member?.characterName === context.selfRealName;
    }

    /**
     * A character's combat level from a skills array, or null.
     *
     * @param {Array<Object>|null} skills - `[{skillHrid, level}]`
     * @returns {number|null}
     */
    _combatLevelOf(skills) {
        if (!Array.isArray(skills) || !skills.length) return null;
        const levels = {};
        for (const skill of skills) {
            const name = skill?.skillHrid?.split('/').pop();
            if (name) levels[name] = skill.level || 1;
        }
        const level = combatLevel(levels)?.level;
        return Number.isFinite(level) && level > 0 ? level : null;
    }

    /**
     * The gear and aura lint, from the only pre-run sources that exist.
     *
     * Your own kit is live. Everyone else's is a profile you opened in game at
     * some point, which the live DPS panel deliberately refuses to use because
     * mid-battle it has something fresher. Before the run there is nothing
     * fresher, so a stale profile is the choice between a dated answer and no
     * answer — taken here, and labelled.
     *
     * @param {Object} context - From `_dungeonContext`
     * @returns {{warnings: Array<string>, checked: Array<string>, uncheckable: Array<string>}}
     */
    _readinessLint(context) {
        const clientData = dataManager.getInitClientData?.() || {};
        const itemDetailMap = clientData.itemDetailMap || {};
        const playerDTOs = [];
        const playerInfo = [];
        const checked = [];
        const uncheckable = [];

        context.roster.forEach((member, index) => {
            const hrid = `player${index + 1}`;
            const isSelf = this._isSelfMember(member, context);
            const name = isSelf ? context.selfName : member.characterName || `Player ${index + 1}`;
            const equipment = {};
            const abilities = [];

            const wear = (itemHrid, enhancementLevel) => {
                const type = itemDetailMap[itemHrid]?.equipmentDetail?.type;
                if (type) equipment[type] = { hrid: itemHrid, enhancementLevel: enhancementLevel || 0 };
            };

            if (isSelf) {
                for (const item of dataManager.getEquipment?.()?.values?.() || []) {
                    wear(item?.itemHrid, item?.enhancementLevel);
                }
                for (const ability of dataManager.getEquippedAbilities?.() || []) {
                    if (ability?.abilityHrid) abilities.push({ hrid: ability.abilityHrid, level: ability.level || 1 });
                }
            } else {
                // A null id matches a stored profile that also lacks one, which
                // would dress a stranger in somebody else's gear
                const profile =
                    member.characterID != null
                        ? (this._profiles || []).find((entry) => entry?.characterID === member.characterID)
                        : null;
                if (!profile) {
                    uncheckable.push(name);
                    return;
                }
                for (const item of Object.values(profile.profile?.wearableItemMap || {})) {
                    wear(item?.itemHrid, item?.enhancementLevel);
                }
                for (const ability of profile.profile?.equippedAbilities || []) {
                    if (ability?.abilityHrid) abilities.push({ hrid: ability.abilityHrid, level: ability.level || 1 });
                }
            }

            checked.push(name);
            playerDTOs.push({ hrid, equipment, abilities });
            playerInfo.push({ hrid, name });
        });

        return { warnings: partyLintWarnings(playerDTOs, playerInfo, clientData), checked, uncheckable };
    }

    /**
     * The readiness model: everything the card draws, decided in one place.
     *
     * @param {Array<Object>} players - From `_players`, for the measured supplies
     * @returns {Object|null} Null when this is not a dungeon
     */
    _readinessModel(players) {
        const context = this._dungeonContext();
        if (!context) {
            this._readinessMemo = null;
            return null;
        }

        // The panel redraws every five seconds and the expensive half of this
        // card — walking every member's equipment through the item map and
        // re-running the party lint — usually produces the same answer, so the
        // model is kept until something it actually reads changes. "Something
        // it reads" is not a set of lengths: the key pile moves when you buy
        // keys, the burn forecasts are rebuilt from the collector on every
        // refresh, and a same-size roster swap is a different party. The
        // signature therefore names identities and the two live numbers, not
        // counts.
        const keyHrid = dungeonEntryKey(context.actionHrid, dataManager.getActionDetails?.(context.actionHrid));
        const keysHeld = keyHrid ? heldInInventory(dataManager.getInventory?.(), keyHrid) : 0;
        // Priced before the signature is built rather than after it is matched:
        // a key that reprices changes what the card says, so the costing has to
        // be part of what the memo is a function of. `_keyCost` is a cache hit
        // on almost every redraw, so this is a map lookup, not a recipe walk.
        const keyCost = this._keyCost(keyHrid);

        const signature = [
            context.actionHrid,
            context.tier,
            context.stale ? 1 : 0,
            context.characterId,
            context.roster.map((member) => member?.characterID ?? member?.characterName ?? '?').join(','),
            this.dungeonRuns,
            (this._profiles || []).map((entry) => entry?.characterID ?? '?').join(','),
            // What the member rows are a function of: who was measured, and how
            // long their soonest-empty slot has left, rounded to a minute so a
            // rate that wobbles in the last decimal does not rebuild the card
            (players || [])
                .map((player) => `${player?.name}=${burnStamp(player?.forecasts)}`)
                .sort()
                .join(','),
            keysHeld,
            `${keyCost?.pricingMode ?? '?'}:${keyCost?.basis ?? '?'}:` +
                `${keyCost?.buyPrice ?? '?'}:${keyCost?.craftCost ?? '?'}`,
            Object.entries(context.keyCounts)
                .map(([who, count]) => `${who}=${count}`)
                .sort()
                .join(','),
        ].join('|');
        if (this._readinessMemo?.signature === signature) return this._readinessMemo.model;

        const runLength = typicalRunSeconds(this._dungeonHistory, { dungeonName: context.name, tier: context.tier });
        const measured = new Map((players || []).map((player) => [player.name, player]));

        // The key row never uses the measured pile: `_keyForecast`'s rate is
        // derived from chests dropped this session, and before the run there is
        // no session. One key per clear is arithmetic, and is enough.
        const keyName = (keyHrid && dataManager.getItemDetails?.(keyHrid)?.name) || '';
        const keys = keyReadiness({
            itemHrid: keyHrid,
            itemName: keyName,
            held: keysHeld,
            runsPlanned: this.dungeonRuns,
        });

        const roster = context.roster.length
            ? context.roster
            : [{ characterID: context.characterId, characterName: context.selfName }];

        const members = roster.map((member) => {
            const isSelf = this._isSelfMember(member, context);
            const name = isSelf ? context.selfName : member.characterName || 'Unknown player';
            const seen = measured.get(name);

            let level = null;
            if (isSelf) level = this._combatLevelOf(dataManager.getSkills?.());
            else {
                const profile =
                    member.characterID != null
                        ? (this._profiles || []).find((entry) => entry?.characterID === member.characterID)
                        : null;
                level = this._combatLevelOf(profile?.profile?.characterSkills);
            }

            // Your own pile is in the inventory and exact; everyone else's is
            // whatever the party's key-count message last stated for them
            const stated = Number(context.keyCounts?.[name]);
            const heldKeys = isSelf ? keysHeld : Number.isFinite(stated) ? stated : null;

            return memberReadiness({
                name,
                isSelf,
                combatLevel: level,
                forecasts: seen?.forecasts || null,
                runSeconds: runLength?.seconds ?? null,
                measuredFrom: seen ? 'last measured battle' : null,
                keysHeld: keyHrid ? heldKeys : null,
                keyName: keyName || 'entry keys',
                keysFrom: isSelf ? 'your inventory' : 'the party key-count message',
            });
        });

        const lint = this._readinessLint(context);
        const scopeParts = [];
        if (lint.checked.length) scopeParts.push(`Gear and auras checked for ${lint.checked.join(', ')}`);
        if (lint.uncheckable.length) {
            scopeParts.push(`not for ${lint.uncheckable.join(', ')} — open their profile in game once and it can be`);
        }

        const model = buildReadiness({
            dungeon: { actionHrid: context.actionHrid, name: context.name, tier: context.tier },
            runsPlanned: this.dungeonRuns,
            keys,
            keyCost,
            members,
            lint: lint.warnings,
            lintScope: scopeParts.length ? `${scopeParts.join('; ')}.` : '',
            runLength,
        });

        if (context.stale) {
            model.footnotes.unshift(
                'The dungeon and tier come from the party block the game sent at login — nothing updates it, ' +
                    'so it may not be what the leader has selected now.'
            );
        }

        this._readinessMemo = { signature, model };
        return model;
    }

    /**
     * The readiness card.
     *
     * Deliberately three-state throughout: every member line says known,
     * unknown-with-a-reason, or nothing. A card that rendered an unreadable
     * member as blank would be indistinguishable from one that read them and
     * found them stocked, which is the one way this feature could do harm.
     *
     * @param {Array<Object>} players - From `_players`
     * @returns {HTMLElement|null}
     */
    _readinessSection(players) {
        const model = this._readinessModel(players);
        if (!model) return null;

        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });

        const name = document.createElement('span');
        name.textContent = `${model.dungeon.name}${model.dungeon.tier ? ` · T${model.dungeon.tier}` : ''} readiness`;
        name.style.fontWeight = 'bold';
        name.style.color = COLORS.accent;

        const runsBtn = document.createElement('button');
        Object.assign(runsBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
        });
        runsBtn.textContent = `${formatWithSeparator(model.runsPlanned)} run${model.runsPlanned === 1 ? '' : 's'}`;
        runsBtn.title = 'How many runs to check against. Click to cycle the presets.';
        runsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._cycleDungeonRuns();
        });

        // Typing is offered next to the cycle rather than instead of it: the
        // presets reach an order of magnitude in a click, and no list of ten
        // covers a plan that runs from four keys to a few thousand runs of food
        const editBtn = document.createElement('span');
        editBtn.textContent = '✎';
        editBtn.title = `Type an exact number of runs (1 to ${formatWithSeparator(MAX_RUNS_PLANNED)})`;
        editBtn.style.cssText = `cursor:pointer; font-size:11px; line-height:1; color:${COLORS.accent};`;
        editBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._editDungeonRuns(heading);
        });

        // Only in this heading: the setting is global, but the reason to reach
        // for it is in front of you here, and nowhere else in this panel is
        // a key being priced.
        heading.append(name, runsBtn, editBtn, this._keyPricingChip());
        section.appendChild(heading);

        if (model.keys) {
            const short = model.keys.shortfall;
            const plan = model.keyPlan;
            // The shortfall used to say "to buy" unconditionally, which quietly
            // recommended the more expensive route whenever the recipe was
            // cheaper than the thin key market. With no costing at all it still
            // says "to buy": that is the route the reader can always take, and
            // naming a craft nothing has priced would be the worse guess.
            const route = plan?.cheaper === 'craft' ? 'to craft' : 'to buy';
            // What is missing, in the figure the rest of the script uses for a
            // shortfall: the count to go and buy, not the count to end up
            // holding. Only for you — a party member's shortfall is stated on
            // their own line, but it is not a number anyone else can act on,
            // and a "to buy" against someone else's inventory would read as a
            // job for the player that is not theirs to do.
            section.appendChild(
                this._readinessLine(
                    model.keys.itemName,
                    short > 0
                        ? `${formatWithSeparator(model.keys.held)} held · covers ${formatWithSeparator(model.keys.runsCovered)} · ${formatWithSeparator(short)} ${route}`
                        : `${formatWithSeparator(model.keys.held)} held · covers ${formatWithSeparator(model.keys.runsPlanned)}`,
                    short > 0 ? ROW_COLORS.bad : ROW_COLORS.good,
                    short > 0
                        ? `One entry key per clear, counted from your inventory. ${formatWithSeparator(short)} more ` +
                              `to buy or craft for ${formatWithSeparator(model.keys.runsPlanned)} runs. This one is exact.`
                        : 'One entry key per clear, counted from your inventory. This one is exact.'
                )
            );
            const routeNote = this._keyRouteNote(plan);
            if (routeNote) section.appendChild(routeNote);
            const shortfalls = this._keyShortfallBlock(model);
            if (shortfalls) section.appendChild(shortfalls);
        }

        for (const member of model.members) {
            const label = member.isSelf ? `${member.name} (you)` : member.name;
            const limit = memberLimit(member);

            if (!limit.source) {
                section.appendChild(
                    this._readinessLine(
                        label,
                        `unknown — ${member.unknown}`,
                        COLORS.textDim,
                        member.isSelf
                            ? 'Your own rate is measured from combat; nothing has been measured yet.'
                            : 'Food and drinks travel in the battle payload, which only arrives once the run has started.'
                    )
                );
                continue;
            }

            const short = limit.runs !== null && limit.runs < model.runsPlanned;

            // Keys without food is half a reading, and must not go green: the
            // number is exact, but it is a ceiling on their runs, not their
            // stopping point. Their food could take the party down first.
            if (member.unknown) {
                section.appendChild(
                    this._readinessLine(
                        label,
                        `${formatWithSeparator(member.keysHeld)} keys · food unknown`,
                        short ? ROW_COLORS.bad : COLORS.textDim,
                        `Keys stated by ${member.keysFrom} — one per clear, so they cover ` +
                            `${formatWithSeparator(member.keyRunsCovered)} ` +
                            'runs. Their food and drinks are only in the battle payload and are still unread.'
                    )
                );
                continue;
            }

            const runs =
                limit.runs === null
                    ? shortDuration(limit.secondsLeft)
                    : `${formatWithSeparator(limit.runs)} run${limit.runs === 1 ? '' : 's'}`;
            section.appendChild(
                this._readinessLine(
                    label,
                    `${runs}${limit.label ? ` · ${limit.label}` : ''}`,
                    short ? ROW_COLORS.bad : ROW_COLORS.good,
                    limit.source === 'keys'
                        ? `Their keys run out before their food does — stated by ${member.keysFrom}.`
                        : `Measured from the ${member.measuredFrom}, converted with your recorded run length.`
                )
            );
        }

        if (model.stopsFirst) {
            const first = model.stopsFirst;
            const when =
                first.runsCovered === null
                    ? shortDuration(first.secondsLeft)
                    : `${formatWithSeparator(first.runsCovered)} run${first.runsCovered === 1 ? '' : 's'}`;
            // The sample size is on the face of it, not only in the tooltip:
            // "you stop first" out of one readable member is a much weaker
            // claim than out of five, and it must look it. A member counted
            // only by their keys is called out separately rather than folded
            // into "read", because their food is still the open question.
            const scope = [];
            if (first.known < first.total) scope.push(`${first.known} of ${first.total} read`);
            if (first.partial) scope.push(`keys only for ${first.partial}`);
            section.appendChild(
                this._readinessLine(
                    'Stops first',
                    `${first.name} in ${when}${scope.length ? ` (${scope.join(', ')})` : ''}`,
                    COLORS.text,
                    `Out of ${first.known} of ${first.total} member${first.total === 1 ? '' : 's'} whose food could ` +
                        `be read${first.partial ? `, and ${first.partial} whose keys were counted but whose food was not` : ''}.`
                )
            );
        }

        for (const warning of model.levelGap.warnings) {
            section.appendChild(
                this._readinessNote(
                    `⚠ ${warning.name} is level-gapped — ${Math.round(-warning.debuff * 100)}% off their monster drops`,
                    '#e8c66c'
                )
            );
        }
        for (const warning of model.lint) section.appendChild(this._readinessNote(`⚠ ${warning}`, '#e8c66c'));
        for (const note of model.footnotes) section.appendChild(this._readinessNote(note, COLORS.textDim));

        return section;
    }

    /**
     * Who in the party is short of keys, worded for party chat.
     *
     * The figure above says the party is short; this says which member and by
     * how much. Members at the count are not listed — the reader is looking for
     * the exception — and a member nobody has heard a key count for is listed as
     * unknown rather than as zero, because asking somebody for keys they already
     * hold is the one way this block could cost the party time.
     *
     * The copy button exists because the lines are for somebody else to read.
     * Retyping five names off a panel into chat is where a readiness check stops
     * being used.
     *
     * @param {Object} model - From `_readinessModel`
     * @returns {HTMLElement|null} Null when there is nothing to say
     */
    _keyShortfallBlock(model) {
        const rows = model?.keyShortfalls || [];
        if (!rows.length) return null;

        const block = document.createElement('div');
        block.style.marginTop = '3px';

        const head = document.createElement('div');
        Object.assign(head.style, { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '0.9em' });

        const heading = document.createElement('span');
        heading.textContent = 'Short of keys';
        heading.style.color = COLORS.textDim;
        heading.style.flex = '1';

        const copyBtn = document.createElement('span');
        copyBtn.textContent = '⧉';
        copyBtn.title = 'Copy these lines for party chat';
        copyBtn.style.cssText = `cursor:pointer; line-height:1; color:${COLORS.accent};`;
        copyBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._copyKeyShortfalls(rows, copyBtn);
        });

        head.append(heading, copyBtn);
        block.appendChild(head);

        for (const row of rows) {
            block.appendChild(
                this._readinessNote(formatKeyShortfall(row), row.short === null ? COLORS.textDim : ROW_COLORS.bad)
            );
        }

        return block;
    }

    /**
     * Put the shortfall lines on the clipboard, saying whether they landed.
     *
     * @param {Array<Object>} rows - From `keyShortfalls`
     * @param {HTMLElement} button - The control clicked, for the acknowledgement
     * @returns {Promise<void>}
     */
    async _copyKeyShortfalls(rows, button) {
        const text = formatKeyShortfalls(rows);
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            this._flashCopy(button, '✓');
        } catch (error) {
            // A clipboard that refuses is not a reason to lose the lines
            console.error('[Consumables] Copying the key shortfall failed:', error);
            console.log(text);
            this._flashCopy(button, '⚠');
        }
    }

    /**
     * @param {HTMLElement} button - What was clicked
     * @param {string} mark - What it should say for a moment
     * @returns {void}
     */
    _flashCopy(button, mark) {
        const original = button.textContent;
        button.textContent = mark;
        setTimeout(() => {
            if (button.isConnected) button.textContent = original;
        }, 1200);
    }

    /**
     * Why the shortfall says buy or craft, with both totals.
     *
     * Both totals every time rather than only the winner's, because "96 to
     * craft" on its own is an instruction, and the reader is owed the number it
     * beat. The basis is on the face of the line for the same reason the own-use
     * tooltip puts it there: the two figures are only comparable because they
     * came off the same side of the book, and a reader who cannot see which side
     * has to assume.
     *
     * A route nobody could price is stated as unpriced, never as zero. A key
     * with no market and no priceable recipe gets the line that says so — the
     * one thing this must not do is imply a free craft and send somebody to a
     * bench that cannot be stocked.
     *
     * @param {Object|null} plan - From `keyShortfallCost`
     * @returns {HTMLElement|null} Null when there is no shortfall to explain
     */
    _keyRouteNote(plan) {
        if (!plan) return null;

        const gold = (value) => `${formatLargeNumber(Math.round(value))}c`;
        const basis = plan.priceBasis === 'bid' ? 'bid' : 'ask';

        if (plan.cheaper === null) {
            return this._readinessNote(
                `Neither route can be priced for the missing ${formatWithSeparator(plan.shortfall)}: no ${basis} on ` +
                    'the market, and the recipe has a material with no price. Nothing here is free — it is unknown.',
                COLORS.textDim
            );
        }

        const buy = plan.buyTotal === null ? `buy unpriced (no ${basis})` : `buy ${gold(plan.buyTotal)}`;
        const craft =
            plan.craftTotal === null ? 'craft unpriced (a material has no price)' : `craft ${gold(plan.craftTotal)}`;
        const time = plan.craftSeconds ? `, about ${shortDuration(plan.craftSeconds)} at the bench` : '';
        const saved = plan.saves > 0 ? `, saving ${gold(plan.saves)}` : '';

        // On the craft basis the route was not chosen by the comparison, and
        // saying "cheaper to craft" over a craft that costs more than the
        // market would be the line arguing against the figure beside it.
        const verdict =
            plan.costBasis === 'craft' && plan.cheaper === 'craft'
                ? 'costed as crafted, your key pricing mode'
                : `cheaper to ${plan.cheaper}`;

        return this._readinessNote(
            `${formatWithSeparator(plan.shortfall)} short: ${craft} vs ${buy}, both at ${basis} — ` +
                `${verdict}${saved}${time}.`,
            plan.saves > 0 ? COLORS.accent : COLORS.textDim
        );
    }

    /**
     * One label/value line of the readiness card.
     * @param {string} label - Left side
     * @param {string} value - Right side
     * @param {string} color - The value's colour
     * @param {string} [title] - What the figure is measured from
     * @returns {HTMLElement}
     */
    _readinessLine(label, value, color, title = '') {
        const line = document.createElement('div');
        line.style.cssText = 'display:flex; justify-content:space-between; gap:8px; margin-bottom:2px;';
        if (title) line.title = title;

        const left = document.createElement('span');
        left.textContent = label;
        left.style.color = COLORS.text;

        const right = document.createElement('span');
        right.textContent = value;
        right.style.color = color;

        line.append(left, right);
        return line;
    }

    /**
     * One footnote or warning under the readiness card.
     * @param {string} text - What it says
     * @param {string} color - Its colour
     * @returns {HTMLElement}
     */
    _readinessNote(text, color) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:0.9em; margin-top:3px;';
        note.style.color = color;
        note.textContent = text;
        return note;
    }

    /**
     * Replace measured drink rates with the arithmetic ones.
     *
     * A drink is re-drunk the moment its buff expires, so its rate follows from
     * the buff's duration and the player's drink concentration and needs no
     * observing. Food is eaten on a health or mana trigger, which depends on
     * what is hitting you, so it is left measured — there is nothing to compute.
     *
     * The measured figure was also capped at a hardcoded 345.6 a day, the rate
     * at the maximum 20% concentration, so anyone below that was told their
     * drinks would run out sooner than they will.
     *
     * @param {Array<Object>} breakdown - From `calculatePlayerStats`
     * @param {Object} player - The collector's player entry, for its concentration
     * @returns {Array<Object>} The same entries, drinks re-rated
     */
    _exactRates(breakdown, player) {
        const concentration = player?.combatStats?.drinkConcentration || 0;

        return (breakdown || []).map((entry) => {
            const detail = dataManager.getItemDetails?.(entry?.itemHrid);
            const duration = detail?.consumableDetail?.buffs?.[0]?.duration;
            const perDay = drinkRatePerDay(duration, concentration);
            if (perDay === null) return entry;

            return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
        });
    }

    /**
     * Refresh the character's own held counts from the live inventory.
     *
     * The collector's counts come from battle snapshots, which the game sends
     * when a fight starts and when something is consumed - a purchase updates
     * neither, so a restock mid-run read as unchanged until the next fight
     * began. The inventory message lands the moment the purchase does, and it
     * is visible only for this character - which is why party members keep the
     * snapshot figure: theirs is the only count their battles state.
     *
     * @param {Array<Object>} breakdown - Entries as `_exactRates` left them
     * @param {Object} player - The collector's player entry
     * @returns {Array<Object>} The same entries, own counts read live
     */
    _liveCounts(breakdown, player) {
        if (!player?.isCurrentPlayer) return breakdown;
        const inventory = dataManager.getInventory?.();
        if (!Array.isArray(inventory) || !inventory.length) return breakdown;

        return (breakdown || []).map((entry) => {
            if (!entry?.itemHrid) return entry;
            return { ...entry, inventoryAmount: heldInInventory(inventory, entry.itemHrid) };
        });
    }

    /**
     * How long a buy order for this item would sit, from the real book.
     *
     * The queue length estimator caches every order book the game has sent, so
     * the depth and the listing timestamps are already in hand for anything you
     * have opened. Reached through the global rather than imported, because it
     * lives in the market bundle and this panel does not — and because an item
     * whose book has never been seen must degrade to "no measurement" rather
     * than to an error.
     *
     * @param {string} itemHrid - The item
     * @param {number} count - How many the order would be for
     * @returns {number|null} Seconds, or null when no book has been seen
     */
    _fillSeconds(itemHrid, count) {
        try {
            const cached = queueLengthEstimator()?.orderBooksCache?.[itemHrid];
            // A buy order joins the bid side, so that is the queue it waits in
            const bids = (cached?.data || cached)?.orderBooks?.[0]?.bids;
            return estimateFillSeconds(bids, count);
        } catch (error) {
            console.error('[ConsumablesPanel] Reading the order book failed:', error);
            return null;
        }
    }

    /**
     * Send the whole restock to the marketplace as tabs.
     * @param {Array<Object>} shortfall - What to buy
     */
    _openShoppingList(shortfall) {
        try {
            // Out of the way first: it is a floating panel and the marketplace it
            // is sending you to opens underneath it. Not recorded as closing it
            // — you went shopping, you did not put the panel away.
            this.hide({ remember: false });
            openShoppingList(shortfall);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the shopping list failed:', error);
        }
    }

    /**
     * Send the shortfall to the marketplace, quantity already filled in — and,
     * when the setting says so, straight into the form the recommendation
     * points at, the way the Bulk Sell Assistant opens sell forms in reverse.
     *
     * Opening the form rather than buying: this is a decision about spending
     * coins, and a panel that spends them for you is a panel you have to
     * watch. Nothing is bought until the game's own confirm button is pressed;
     * the recommendation only decides which form is standing open when you
     * decide.
     *
     * @param {Object} entry - The forecast being topped up
     * @param {number} count - How many are missing
     * @param {Object|null} [strategy] - From `buyStrategy`, for which form to open
     */
    _buy(entry, count, strategy = null) {
        if (!count) return;
        try {
            this.hide({ remember: false });
            this.autofill.setQuantity(count, { itemHrid: entry.itemHrid });
            navigateToMarketplace(entry.itemHrid);
            this._openRecommendedForm(strategy);
        } catch (error) {
            console.error('[ConsumablesPanel] Opening the marketplace failed:', error);
        }
    }

    /**
     * Click the button the recommendation points at, once the item page is up.
     *
     * Late-bound through the market bundle's shortcuts (this panel lives in the
     * UI bundle), and best-effort throughout: if the setting is off, the
     * shortcuts are not loaded, or the button never appears, the result is
     * exactly the old behaviour — the item open in the marketplace with the
     * quantity parked, waiting for a hand.
     *
     * @param {Object|null} strategy - From `buyStrategy`
     */
    _openRecommendedForm(strategy) {
        if (!strategy || !config.getSetting('market_consumableBuyOpenRecommended')) return;
        const shortcuts = window.Toolasha?.Market?.marketplaceShortcuts;
        if (!shortcuts) return;

        // The navigation itself takes a beat; the shortcuts' own click helpers
        // then poll for the button, so this only has to not fire too early
        setTimeout(() => {
            const open =
                strategy.mode === 'instant'
                    ? shortcuts.clickInstantActionButton?.('Buy')
                    : shortcuts.clickListingButton?.('+ New Buy Listing', 'Button_buy');
            open?.catch?.(() => {
                // No matching button (an empty book's Buy Now has nothing to
                // take) — the marketplace is open and the quantity is parked,
                // which is the old behaviour and still useful
            });
        }, 400);
    }

    /**
     * The three buy-decision settings, read the same way everywhere.
     * @param {string} key - Setting key
     * @param {number} fallback - Used when unset or nonsense
     * @returns {number}
     */
    _buyNumber(key, fallback) {
        const raw = Number(config.getSettingValue(key, fallback));
        return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
    }

    /**
     * Walk the lab shortfall one item at a time — the Bulk Sell Assistant's
     * Next-flow in reverse. Each step opens one item's recommended buy form
     * (nothing is bought until the game's own confirm is pressed), and a
     * floating chip offers the next item whenever you are ready: one click,
     * one form.
     * @param {Array<{itemHrid: string, count: number}>} queue - Items still short
     */
    /**
     * Offer a section's shortfall to the floating Buy-all widget.
     *
     * The heading used to carry its own "Buy all ▶" button, which meant the
     * control vanished the moment the walk hid the panel to go shopping — and
     * with it any way of seeing or changing what the walk was deciding by. The
     * sections now only say what they are short of; the widget is the one place
     * the walk is driven from, and its dropdown is how you choose between them.
     *
     * Registered only when two or more rows are short: a single row's own link
     * already does the job.
     *
     * @param {string} label - Which section this is, for the widget's dropdown
     * @param {Array<{itemHrid: string, count: number, secondsLeft?: number}>} queue - Items short, in row order
     */
    _registerBuyQueue(label, queue) {
        if (!queue || queue.length < 2) return;
        this._buyQueues = this._buyQueues || [];
        this._buyQueues.push({ label, queue: queue.slice() });
    }

    _startBuyAll(queue) {
        this._buyQueue = queue.slice();
        this._advanceBuyQueue();
    }

    /** Open the queue's next buy form and re-offer the widget for the one after */
    _advanceBuyQueue() {
        const next = this._buyQueue?.shift();
        if (!next) {
            this._syncBuyWidget();
            return;
        }
        // Priced at open time, not at queue time — the earlier buys in the
        // walk may themselves have moved the book
        const prices = getItemPrices(next.itemHrid);
        const ask = Number(prices?.ask) > 0 ? Number(prices.ask) : null;
        const bid = Number(prices?.bid) > 0 ? Number(prices.bid) : null;
        const strategy = buyStrategy({
            count: next.count,
            ask,
            bid,
            // The lab has no running-out clock; combat rows pass their own
            secondsLeft: Number.isFinite(next.secondsLeft) ? next.secondsLeft : Infinity,
            fillSeconds: this._fillSeconds(next.itemHrid, next.count),
            maxSpreadPct: this._buyNumber('market_consumableBuyMaxSpreadPct', 2),
            minSavingCoins: this._buyNumber('market_consumableBuyMinSaving', 0),
            minOrderValue: this._buyNumber('market_consumableBuyMinOrderValue', 0),
        });
        this._buy({ itemHrid: next.itemHrid }, next.count, strategy);
        this._syncBuyWidget();
    }

    /**
     * Show the Buy-all widget while there is something to buy or a walk to
     * finish, and take it away otherwise.
     *
     * A walk outlives the panel by design — `_buy` hides the panel to leave the
     * marketplace unobstructed — so the widget survives a hidden panel whenever
     * a queue is still running.
     * @private
     */
    _syncBuyWidget() {
        const walking = Boolean(this._buyQueue?.length);
        const offered = Boolean(this.panel && this._buyQueues?.length);
        if (this._buyWidgetHidden || (!walking && !offered)) {
            this._removeBuyWidget();
            return;
        }
        this._renderBuyWidget();
    }

    /**
     * The Buy-all walk's floating control: which shortfall to walk, what the
     * next press opens, and the rules the recommendation is made by.
     * @private
     */
    _renderBuyWidget() {
        if (!this.buyWidget || !document.body.contains(this.buyWidget.element)) {
            const widget = createFloatingWidget({
                id: BUY_CHIP_ID,
                top: '160px',
                right: '24px',
                accent: COLORS.accent,
                background: COLORS.background,
                border: COLORS.border,
                text: COLORS.text,
                dim: COLORS.textDim,
                zIndex: config.Z_FLOATING_PANEL,
                positionKey: BUY_WIDGET_POSITION_KEY,
                position: this._buyWidgetPosition,
            });
            widget.main.addEventListener('click', () => this._onBuyWidgetClick());
            widget.close.title = 'Stop here — the rest of the shortfall stays on the panel.';
            widget.close.addEventListener('click', () => {
                this._buyQueue = [];
                this._buyWidgetHidden = true;
                this._removeBuyWidget();
            });
            widget.gear.addEventListener('click', () => this._renderBuyWidgetSettings());

            const picker = document.createElement('select');
            picker.className = `${BUY_CHIP_ID}-source`;
            picker.classList.add('toolasha-select');
            picker.style.cssText =
                `border:1px solid ${COLORS.border}; border-radius:5px; background:rgba(20,26,44,0.95); ` +
                `color:${COLORS.text}; font-size:12px; padding:2px 4px; max-width:150px; cursor:pointer; ` +
                'font-family:inherit;';
            picker.addEventListener('change', () => {
                this._buySource = picker.value;
            });
            widget.extras.appendChild(picker);

            document.body.appendChild(widget.element);
            this.buyWidget = widget;
            this._renderBuyWidgetSettings();
        }

        const widget = this.buyWidget;
        const picker = widget.extras.querySelector(`.${BUY_CHIP_ID}-source`);
        const walking = Boolean(this._buyQueue?.length);
        const sources = this._buyQueues || [];

        // Mid-walk the queue is fixed, so offering a different one would be
        // offering to abandon this one without saying so
        picker.style.display = !walking && sources.length > 1 ? '' : 'none';
        if (!walking) {
            const signature = sources.map((source) => `${source.label}:${source.queue.length}`).join('|');
            if (picker.dataset.signature !== signature) {
                picker.dataset.signature = signature;
                picker.textContent = '';
                for (const source of sources) {
                    const option = document.createElement('option');
                    option.value = source.label;
                    option.textContent = `${source.label} (${source.queue.length})`;
                    picker.appendChild(option);
                }
            }
            if (!sources.some((source) => source.label === this._buySource)) {
                this._buySource = sources[0]?.label || null;
            }
            picker.value = this._buySource || '';
        }

        if (walking) {
            const next = this._buyQueue[0];
            const itemName = dataManager.getItemDetails?.(next.itemHrid)?.name || next.itemHrid.split('/').pop();
            widget.main.textContent = `▶ Next: ${itemName} (${this._buyQueue.length} left)`;
            widget.main.title = 'Open this item’s recommended buy form. One press, one form.';
            return;
        }

        const chosen = sources.find((source) => source.label === this._buySource) || sources[0];
        widget.main.textContent = '▶ Buy all';
        widget.main.title = chosen
            ? `${chosen.queue.length} items short in ${chosen.label}. Opens each item's recommended buy form ` +
              'in turn, one press per form. Nothing is bought until the game’s own confirm button is pressed.'
            : 'Nothing is short right now.';
        widget.main.disabled = !chosen;
    }

    /** @private */
    _onBuyWidgetClick() {
        if (this._buyQueue?.length) {
            this._advanceBuyQueue();
            return;
        }
        const sources = this._buyQueues || [];
        const chosen = sources.find((source) => source.label === this._buySource) || sources[0];
        if (chosen) this._startBuyAll(chosen.queue);
    }

    /**
     * The buy-decision rules, written straight into the settings the
     * recommendation already reads.
     * @private
     */
    _renderBuyWidgetSettings() {
        const widget = this.buyWidget;
        if (!widget || !widget.settingsOpen) return;

        widget.settings.replaceChildren();
        widget.settings.append(
            widgetDivider(),
            widgetNote('Any one of these makes the walk open Buy Now instead of a buy order. 0 turns a rule off.')
        );
        for (const tunable of BUY_TUNABLES) {
            widget.settings.appendChild(widgetNumberRow(tunable));
        }
        widget.settings.appendChild(
            widgetCheckboxRow({
                key: 'market_consumableBuyOpenRecommended',
                label: 'Open the recommended order form',
                title: 'Off: a buy only opens the item in the marketplace with the quantity parked, and you pick the form.',
            })
        );
    }

    /** @private */
    _removeBuyWidget() {
        this.buyWidget?.remove();
        this.buyWidget = null;
        document.getElementById(BUY_CHIP_ID)?.remove();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '110px',
            left: '70px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 80vh)`,
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

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 10px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 200,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 200 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        // Stock and rates both move as you play, and prices move under them
        this.refreshId = setInterval(() => this._tick(), REFRESH_MS);

        this._escapeReg = registerEscapeClose(() => this.hide());
    }

    /**
     * The five-second redraw, which leaves alone a panel nobody can see and a
     * control somebody is in the middle of.
     *
     * A redraw here rebuilds the whole body, and this panel is full of `<select>`
     * elements — the zone picker, the per-section source pickers. Rebuilding one
     * closes its dropdown, so a list read for more than five seconds shut itself
     * under the pointer, which reads as the panel refusing to be used rather than
     * as a redraw. A hidden tab and a folded panel are the other half: both draw
     * a body that is not on screen, and both end by drawing again — `show` and
     * expanding each re-render, and the interval picks the panel back up on its
     * next tick once the tab is visible.
     *
     * @private
     */
    _tick() {
        if (document.hidden) return;
        if (this.minimizeCtl?.collapsed) return;

        const active = document.activeElement;
        if (this.panel?.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;

        this._render();
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Consumables';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The duration everything is measured against, on its own face rather
        // than behind a menu — every figure below it changes when it changes
        this.targetBtn = document.createElement('button');
        Object.assign(this.targetBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 8px',
        });
        this.targetBtn.title = 'How long the stock should last. Every shortfall below is measured against this.';
        this.targetBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            cycleTarget();
            this._render();
        });

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

        header.append(title, this.targetBtn, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;
        this.targetBtn.textContent = `Last ${this.target.label}`;

        // Drawn into a detached scratch box and swapped in only when the markup
        // actually changed — the same idiom as combat-panels.js `_render`. The
        // five-second tick otherwise tears down and re-lays-out a body of
        // identical pixels whenever stock, rates and prices have all held
        // still, which out of combat is most ticks. The source pickers set
        // their selection via `.value`, which is not in the markup on either
        // side of the compare — keeping the live DOM keeps the selection on
        // screen, and a real swap rebuilds it from the same stored state.
        const scratch = document.createElement('div');

        // Rebuilt from what this render finds short, so a section that has been
        // topped up stops being offered — on every pass, swap or no swap,
        // because the buy widget reads these queues rather than the DOM
        this._buyQueues = [];
        const players = this._players();

        // Before the players, because the readiness card is the pre-run
        // question and the player sections are the mid-run one — and it has to
        // draw when there are no players at all, which is exactly the lobby
        try {
            const readiness = this._readinessSection(players);
            if (readiness) scratch.appendChild(readiness);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the dungeon readiness card failed:', error);
        }

        if (!players.length) {
            // Nothing measured because nothing is being fought — but what the
            // next fight will drink is already decided by the default loadout,
            // and what it will eat by the last sim. Plan from those instead of
            // shrugging, when the setting allows and either source exists.
            const idle = config.getSetting('consumables_idleLoadoutPlan') ? this._idleSection() : null;
            if (idle) {
                scratch.appendChild(idle);
            } else {
                const empty = document.createElement('div');
                empty.style.color = COLORS.textDim;
                empty.textContent = 'No consumable data yet. Fight something with food or drinks equipped.';
                scratch.appendChild(empty);
            }
        }

        for (const player of players) scratch.appendChild(this._playerSection(player));

        try {
            const lab = this._labSection();
            if (lab) scratch.appendChild(lab);
        } catch (error) {
            console.error('[ConsumablesPanel] Building the labyrinth section failed:', error);
        }

        if (scratch.innerHTML !== this.bodyEl.innerHTML) {
            this.bodyEl.replaceChildren(...scratch.childNodes);
        }

        this._syncBuyWidget();
    }

    /**
     * The idle plan: the default combat loadout's consumables, rated without a
     * fight. Drinks are arithmetic — buff duration against drink concentration
     * needs no observing — and food takes the last sim's measured per-hour use
     * for whatever zone was simmed (said in the heading), since food has no
     * rate outside a fight or a sim. Food with no sim on record still lists,
     * held and priced, with its rate honestly blank.
     *
     * @returns {HTMLElement|null} Null when no default loadout names anything
     */
    _idleSection() {
        const bridge = window.Toolasha?.Combat?.loadoutSnapshot;
        const snapshots = bridge?.getAllSnapshots?.() || [];
        const combat = snapshots.filter(
            (snap) => snap.actionTypeHrid === '/action_types/combat' || snap.actionTypeHrid === ''
        );
        combat.sort(
            (a, b) =>
                (b.actionTypeHrid === '/action_types/combat') - (a.actionTypeHrid === '/action_types/combat') ||
                Number(b.isDefault) - Number(a.isDefault) ||
                (a.ordinal || 0) - (b.ordinal || 0)
        );
        if (!combat.length) return null;
        // The pinned loadout when it still exists, the default otherwise
        const loadout = combat.find((snap) => snap.name === this._idleLoadoutName) || combat[0];

        const sim = this._idleRates();
        const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
        const inventory = dataManager.getInventory?.();
        const concentration = this._idleConcentration();
        const simPerDay = (hrid) => (sim?.perHour?.[hrid] > 0 ? sim.perHour[hrid] * 24 : null);

        const entries = [];
        for (const slot of loadout.drinks || []) {
            if (!slot?.itemHrid) continue;
            const duration = itemMap?.[slot.itemHrid]?.consumableDetail?.buffs?.[0]?.duration;
            const perDay = drinkRatePerDay(duration, concentration) ?? simPerDay(slot.itemHrid);
            entries.push({ itemHrid: slot.itemHrid, perDay });
        }
        for (const slot of loadout.food || []) {
            if (!slot?.itemHrid) continue;
            entries.push({ itemHrid: slot.itemHrid, perDay: simPerDay(slot.itemHrid) });
        }
        if (!entries.length) return null;

        const section = document.createElement('div');
        section.style.marginBottom = '12px';
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });
        const name = document.createElement('span');
        name.textContent = 'Idle plan';
        name.style.fontWeight = 'bold';
        name.style.color = COLORS.accent;

        // Which loadout to plan for, and which simmed zone rates its food —
        // both pinned, so the plan compares against the fight you intend
        // rather than whatever happened to be simmed or equipped last
        const loadoutPick = this._idleSelect(
            combat.map((snap) => ({ value: snap.name, label: snap.isDefault ? `${snap.name} ★` : snap.name })),
            loadout.name,
            'Which combat loadout the idle plan is drawn from.',
            (value) => this.pinIdleLoadout(value)
        );
        const zonePick = this._idleSelect(
            this._zoneOptions(),
            this._idleZoneKey || 'last',
            'Which simmed zone rates the food. Drinks are arithmetic and need no sim.',
            (value) => this.pinIdleZone(value)
        );

        const source = document.createElement('span');
        source.style.marginLeft = 'auto';
        source.style.color = COLORS.textDim;
        source.textContent = sim
            ? `food rated from sim (${this._zoneLabel(sim)})`
            : this._idleZoneKey && this._idleZoneKey !== 'last'
              ? 'pinned zone unsimmed — run a sim there to rate food'
              : 'food unrated — run a sim to rate it';

        const forecasts = entries.map(({ itemHrid, perDay }) =>
            forecast(
                {
                    itemHrid,
                    itemName: dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop(),
                    inventoryAmount: heldInInventory(inventory, itemHrid),
                    consumptionRate: perDay > 0 ? perDay / 86400 : 0,
                    consumedPerDay: perDay > 0 ? Math.ceil(perDay) : 0,
                },
                getItemPrices(itemHrid)
            )
        );
        const shortfall = forecasts
            .map((entry) => ({
                ...refillFor(entry, this.target.seconds),
                itemHrid: entry.itemHrid,
                secondsLeft: entry.secondsLeft,
            }))
            .filter((item) => item.count > 0);
        this._registerBuyQueue('Idle plan', shortfall);

        heading.append(name, loadoutPick, zonePick, source);
        section.appendChild(heading);
        section.appendChild(this._columnHeadings());

        for (const entry of forecasts) {
            section.appendChild(this._entryRow(entry, false));
        }
        return section;
    }

    /**
     * The rates the idle plan's food is judged by: the pinned zone's sim when
     * one is pinned and has been simmed, the latest sim otherwise. A pinned
     * zone that has never been simmed rates nothing — silently borrowing
     * another zone's appetite would defeat the pin.
     * @returns {Object|null} A `{zoneHrid, difficultyTier, savedAt, perHour}` record
     */
    _idleRates() {
        const key = this._idleZoneKey;
        if (key && key !== 'last') return this._simRatesByZone?.[key] || null;
        return this._simRates || null;
    }

    /**
     * The zones there are sim rates for, newest first, behind "Last sim".
     * @returns {Array<{value: string, label: string}>}
     */
    _zoneOptions() {
        const byZone = this._simRatesByZone || {};
        const options = [{ value: 'last', label: 'Last sim' }];
        const keys = Object.keys(byZone).sort((a, b) => (byZone[b]?.savedAt || 0) - (byZone[a]?.savedAt || 0));
        for (const key of keys) {
            options.push({ value: key, label: this._zoneLabel(byZone[key]) });
        }
        // A pinned zone whose record was cleared still lists, so the pin is
        // visible rather than silently reverting the dropdown to Last sim
        if (this._idleZoneKey && this._idleZoneKey !== 'last' && !byZone[this._idleZoneKey]) {
            options.push({
                value: this._idleZoneKey,
                label: `${this._idleZoneKey.split('|')[0].split('/').pop()} (unsimmed)`,
            });
        }
        return options;
    }

    /**
     * "Zone name · T2" for a rates record.
     * @param {Object} rates - A `{zoneHrid, difficultyTier}` record
     * @returns {string}
     */
    _zoneLabel(rates) {
        const zoneName =
            dataManager.getInitClientData?.()?.actionDetailMap?.[rates?.zoneHrid]?.name ||
            rates?.zoneHrid?.split('/')?.pop() ||
            'unknown zone';
        const tier = Number(rates?.difficultyTier) || 0;
        return tier > 0 ? `${zoneName} · T${tier}` : zoneName;
    }

    /**
     * A heading-sized dropdown, styled like the runs button.
     * @param {Array<{value: string, label: string}>} options - What to offer
     * @param {string} selected - The current value
     * @param {string} title - Hover text
     * @param {Function} onChange - Given the new value; the panel re-renders after
     * @returns {HTMLSelectElement}
     */
    _idleSelect(options, selected, title, onChange) {
        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 4px',
            maxWidth: '140px',
        });
        select.title = title;
        for (const { value, label } of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            // The game's dark theme does not reach native dropdown lists
            option.style.background = '#101420';
            option.style.color = COLORS.text;
            select.appendChild(option);
        }
        select.value = selected;
        select.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', () => {
            onChange(select.value);
            this._render();
        });
        return select;
    }

    /** Drink concentration off worn gear, for the idle plan's arithmetic rates */
    _idleConcentration() {
        try {
            return (
                getDrinkConcentration(dataManager.getEquipment?.(), dataManager.getInitClientData?.()?.itemDetailMap) ||
                0
            );
        } catch {
            return 0;
        }
    }

    /** How many runs the labyrinth section is measured against */
    get labRuns() {
        return this._labRuns || 5;
    }

    /** Cycle the run target and remember it, the way the duration target works */
    _cycleLabRuns() {
        const steps = [1, 3, 5, 10, 25];
        this._labRuns = steps[(steps.indexOf(this.labRuns) + 1) % steps.length];
        storage.set('consumablesLabRuns', this._labRuns, 'settings').catch(() => {});
        this._render();
    }

    /**
     * What one labyrinth run consumes, planned as full consumption.
     *
     * Per the game's own model: a run takes in up to its capacity of torches,
     * shrouds and beacons (base 100/4/5, raised by the capacity upgrades — the
     * capacities are settings, since the upgrade levels are not in any payload
     * this reads), plus exactly one crate per selected crate slot. Planned as
     * fully spent, which is the ceiling a restock should be sized for.
     *
     * @returns {Array<{itemHrid: string, perRun: number}>} Empty when the game
     *   data needed to name the items is not up yet
     */
    _labNeedsPerRun() {
        const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
        if (!itemMap) return [];
        const hrids = resolveSupplyHrids(itemMap);
        const inventory = dataManager.getInventory?.();
        const counts = readSupplyCounts(inventory, hrids);
        const lab = dataManager.characterData?.characterLabyrinth || dataManager.characterData?.labyrinth;

        // The server states the final capacities outright on characterInfo
        // (labyrinthTorchCap and friends, upgrades already applied) — nothing
        // to configure. The base caps stand in only for the moment before the
        // payload arrives.
        const info = dataManager.characterData?.characterInfo;
        const cap = (field, fallback) => (Number(info?.[field]) > 0 ? Number(info[field]) : fallback);
        const capacity = {
            torch: cap('labyrinthTorchCap', 100),
            shroud: cap('labyrinthShroudCap', 4),
            beacon: cap('labyrinthBeaconCap', 5),
        };
        const needs = [];
        const ledger = (this._ledgerRuns || []).slice(0, 5);
        for (const kind of SUPPLY_KINDS) {
            if (!(capacity[kind] > 0)) continue;
            // The tier the last run actually carried names the item; what is
            // held, then the basic tier, stand in before any run has said
            const hrid = lab?.[`${kind}ItemHrid`] || bestOwnedTier(counts, kind, hrids) || hrids[kind][0];
            // What recent runs actually spent beats the capacity, which is
            // only what a run *can* spend: a rushed run, a preserving torch
            // tier, a run that stops short — all of it is in the record and
            // none of it is in the cap. The cap stands until a run has said
            const basis = config.getSettingValue('consumables_labPerRunBasis', 'measured') || 'measured';
            const used = basis === 'capacity' ? [] : observedUse(ledger, kind);
            const perRun = used.length ? Math.ceil(used.reduce((sum, n) => sum + n, 0) / used.length) : capacity[kind];
            needs.push({
                itemHrid: hrid,
                perRun,
                kind,
                basis,
                observedRuns: used.length,
                capacity: capacity[kind],
            });
        }
        // One crate per selected slot per run — the slots the run itself names
        for (const slot of ['teaCrateItemHrid', 'coffeeCrateItemHrid', 'foodCrateItemHrid']) {
            if (lab?.[slot]) needs.push({ itemHrid: lab[slot], perRun: 1 });
        }
        return needs;
    }

    /**
     * The Labyrinth block: what X runs consume, against what the bag holds.
     *
     * Same columns as the combat rows, re-read for runs: Per day becomes per
     * run, Lasts becomes how many whole runs the held pile covers, and the Buy
     * link makes the same order-or-instant judgement every other Buy link does.
     *
     * @returns {HTMLElement|null} Null when nothing names the lab's items yet
     */
    _labSection() {
        const needs = this._labNeedsPerRun();
        if (!needs.length) return null;

        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });
        const name = document.createElement('span');
        name.textContent = 'Labyrinth';
        name.style.fontWeight = 'bold';
        name.style.color = COLORS.accent;

        const runsBtn = document.createElement('button');
        Object.assign(runsBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.accent,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
        });
        runsBtn.textContent = `${this.labRuns} run${this.labRuns === 1 ? '' : 's'}`;
        runsBtn.title =
            'How many runs to stock for, at full consumption: the whole torch/shroud/beacon capacity and one ' +
            'crate per slot, every run. Capacities are read from the game itself, upgrades included.';
        runsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._cycleLabRuns();
        });

        // Which figure a run is planned at — the measured average, or the cap.
        // A pill rather than a settings trip, because the difference is the
        // whole question the block answers
        const basis = config.getSettingValue('consumables_labPerRunBasis', 'measured') || 'measured';
        const basisBtn = document.createElement('button');
        Object.assign(basisBtn.style, {
            background: 'rgba(255, 255, 255, 0.07)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.textDim,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
        });
        basisBtn.textContent = basis === 'capacity' ? 'full capacity' : 'measured';
        basisBtn.title =
            basis === 'capacity'
                ? 'Planned at the whole torch/shroud/beacon capacity every run. Click for the measured average instead.'
                : 'Planned at the average your recorded runs actually spent (runs watched from the door only). ' +
                  'Click to plan at full capacity every run instead.';
        basisBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            config.setSetting('consumables_labPerRunBasis', basis === 'capacity' ? 'measured' : 'capacity');
            this._render();
        });
        const inventory = dataManager.getInventory?.() || [];
        const runs = this.labRuns;

        // The walkable shortfall: every item short for the run target, in row order
        const queue = needs
            .map(({ itemHrid, perRun }) => ({
                itemHrid,
                count: Math.max(0, Math.ceil(perRun * runs) - heldInInventory(inventory, itemHrid)),
            }))
            .filter((q) => q.count > 0);
        this._registerBuyQueue('Labyrinth', queue);
        heading.append(name, runsBtn, basisBtn);
        section.appendChild(heading);

        for (const need of needs) {
            section.appendChild(this._labRow(need.itemHrid, need.perRun, runs, inventory, need));
        }

        // The whole lab restock in one gesture, exactly like the consumables
        // footer above it - the per-row buys were the only option here, and a
        // restock of four supplies meant four trips back to this panel
        if (queue.length) {
            let labCost = 0;
            let labUnpriced = 0;
            const labItems = queue.map(({ itemHrid, count }) => {
                const ask = Number(getItemPrices(itemHrid)?.ask);
                if (ask > 0) labCost += ask * count;
                else labUnpriced += 1;
                return {
                    itemHrid,
                    count,
                    name: dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop(),
                };
            });
            const labTotal = queue.reduce((sum, q) => sum + q.count, 0);

            const buyLine = document.createElement('div');
            Object.assign(buyLine.style, { textAlign: 'right', padding: '3px 0 1px', fontWeight: 'bold' });
            const buyAll = document.createElement('span');
            buyAll.textContent = `Buy all ${formatLargeNumber(labTotal)} · ${formatLargeNumber(Math.round(labCost))}`;
            Object.assign(buyAll.style, {
                color: ROW_COLORS.gold,
                cursor: 'pointer',
                textDecoration: 'underline dotted',
                whiteSpace: 'nowrap',
            });
            buyAll.title =
                'Open the marketplace with a tab per item, each showing what is missing.' +
                (labUnpriced
                    ? `
${labUnpriced} item(s) could not be priced and are not in this total.`
                    : '');
            buyAll.addEventListener('click', (event) => {
                event.stopPropagation();
                this._openShoppingList(labItems);
            });
            buyLine.appendChild(buyAll);
            section.appendChild(buyLine);
        }

        // What recent runs actually left unspent, and what each rush-for-exit
        // floor would cost against the torch capacity — the two readings that
        // together answer "could the rush floor come down?"
        const ledger = (this._ledgerRuns || []).slice(0, 5);
        if (ledger.length) {
            const line = document.createElement('div');
            line.style.cssText =
                'margin-top:3px; font-size:0.9em; display:flex; align-items:center; flex-wrap:wrap; gap:4px 6px;';
            line.style.color = COLORS.textDim;
            const lead = document.createElement('span');
            lead.textContent = `Left over after the last ${ledger.length} run${ledger.length === 1 ? '' : 's'} (newest first):`;
            line.appendChild(lead);

            // The game's own icon for each supply — the tier the newest run
            // carried, else whatever the row above names
            const hridFor = (kind) =>
                ledger.find((run) => run.itemHrids?.[kind])?.itemHrids?.[kind] ||
                needs.find((need) => need.kind === kind)?.itemHrid ||
                null;
            for (const kind of SUPPLY_KINDS) {
                const values = ledger.map((run) => run.left?.[kind]).filter((n) => Number.isFinite(n));
                if (!values.length) continue;
                const chip = document.createElement('span');
                chip.style.cssText = 'display:inline-flex; align-items:center; gap:3px;';
                const hrid = hridFor(kind);
                if (hrid) chip.appendChild(itemIcon(hrid, 16));
                const nums = document.createElement('span');
                nums.textContent = values.join(', ');
                chip.appendChild(nums);
                chip.title = `${kind.charAt(0).toUpperCase() + kind.slice(1)}es left at the end of each run, newest first`;
                if (kind === 'beacon') chip.title = 'Beacons left at the end of each run, newest first';
                line.appendChild(chip);
            }

            const info = dataManager.characterData?.characterInfo;
            const deepest = Math.max(
                Number(info?.labyrinthHighestFloor) || 0,
                ...ledger.map((run) => Number(run.floor) || 0)
            );
            const torchCap = Number(info?.labyrinthTorchCap) || 0;
            if (deepest > 0 && torchCap > 0) {
                const torchHrid = hridFor('torch');
                const keep = torchHrid ? preserveChance(torchHrid) : 0;
                const table = rushFloorTable(deepest, torchCap, keep)
                    .map(
                        (row) => `rush ≤${row.rushFloor}: ~${row.torches} torches${row.fits ? '' : ' — over capacity'}`
                    )
                    .join('\n');
                const preserveNote =
                    keep > 0 ? ` Your torch preserves ${Math.round(keep * 100)}% of uses, which is taken off.` : '';
                const used = observedUse(ledger, 'torch');
                const observedNote = used.length
                    ? `\n\nObserved — torches actually spent in the last ${used.length} run${used.length === 1 ? '' : 's'}, newest first: ${used.join(', ')}. That is the real figure (your actual rush floor, rooms entered and preserves); the table is the full-clear estimate.`
                    : '';
                line.title =
                    `Torches a run to floor ${deepest} costs, one per room entered (grid math from the game ` +
                    `guide: 4×4 on floor 1, +1 per floor to 8×8; rushed floors cross the shortest path, the ` +
                    `rest are fully cleared — a room skipped on a cleared floor is not modelled).${preserveNote} ` +
                    `Against your ${torchCap} capacity:\n${table}${observedNote}`;
                line.style.textDecoration = 'underline dotted';
            }
            section.appendChild(line);
        }

        const verdict = this._rushFloorVerdictLine();
        if (verdict) section.appendChild(verdict);

        const trend = this._labTrendLines(needs);
        for (const el of trend) section.appendChild(el);
        return section;
    }

    /**
     * The rush-floor question, decided rather than left as two readings.
     *
     * The block above draws what the runs left over and what each candidate rush
     * floor would cost; the pool card elsewhere draws how close the losses are.
     * Neither answers "should the rush floor come down" on its own, and a reader
     * holding both still has to combine them. This is the combination —
     * `labyrinth-rush-floor-verdict.js` holds every rule, including the three
     * refusals, so this method only supplies the data and paints the result.
     *
     * The current gear fingerprint is deliberately not supplied. Computing it
     * needs the loadout hasher that lives on the labyrinth clear-rate singleton
     * in another bundle, and `gearChangedSince` abstains on a missing current
     * fingerprint by design — "nothing to compare against" is not "unchanged".
     * The refusal that matters here still fires: a fight pool spanning more than
     * one gear fingerprint is a boundary whether or not today's gear is known.
     *
     * @returns {HTMLElement|null} The line, or null when there is nothing to read
     * @private
     */
    _rushFloorVerdictLine() {
        try {
            const runs = this._ledgerRuns || [];
            const attempts = this._labFightAttempts;
            // The read has not landed yet (or has never been started), or the
            // pool in hand belongs to a character the panel has since left:
            // kick a read off and say nothing this draw rather than refusing on
            // absence. `_refreshStoredReadings()` re-reads everything else the
            // lab section draws on a switch but not this pool, so without the
            // owner check the verdict went on judging the arriving character's
            // ledger against the departing character's fights.
            if (!Array.isArray(attempts) || this._labFightAttemptsOwner !== currentCharacterId()) {
                this._loadLabFightAttempts();
                return null;
            }
            if (!attempts.length && !runs.length) return null;

            const torchCap = Number(dataManager.characterData?.characterInfo?.labyrinthTorchCap) || 0;
            const result = rushFloorVerdict({ attempts, runs, torchCap });

            const line = document.createElement('div');
            line.style.cssText = 'margin-top:3px; font-size:0.9em;';
            line.style.color =
                result.verdict === 'supported'
                    ? ROW_COLORS.good
                    : result.verdict === 'refused'
                      ? COLORS.textDim
                      : ROW_COLORS.gold;
            line.textContent = `Rush floor: ${result.text}`;
            line.title =
                'Three readings folded into one: the median share of the monster left standing when a fight is ' +
                'lost, the torches a trusted run actually spends against your capacity, and whether every ' +
                'recorded fight was fought in one set of gear.\n' +
                'It says whether the two measurements point the same way. Moving the rush floor is still yours.';
            return line;
        } catch (error) {
            console.error('[ConsumablesPanel] Building the rush-floor verdict failed:', error);
            return null;
        }
    }

    /**
     * Read the recorded fight pool once, the way the ledger is read.
     *
     * The recorder is a websocket-fed singleton in the combat bundle; its
     * storage record is a plain array and reading it is one get, which is what
     * the ledger above already does for the same reason.
     * @returns {Promise<void>}
     * @private
     */
    async _loadLabFightAttempts() {
        if (this._labFightAttemptsLoading) return;
        this._labFightAttemptsLoading = true;
        // Whose pool this read is for, decided before the await: `readScoped`
        // builds its key now, and adopting the answer under whoever is current
        // when it lands would file one character's fights under another
        const owner = currentCharacterId();
        try {
            const stored = await readScoped('labyrinthFightRecorder', 'labyrinth', []);
            if (currentCharacterId() !== owner) return;
            this._labFightAttempts = Array.isArray(stored) ? stored : [];
            this._labFightAttemptsOwner = owner;
        } catch (error) {
            console.error('[ConsumablesPanel] Reading the labyrinth fight pool failed:', error);
            if (currentCharacterId() !== owner) return;
            this._labFightAttempts = [];
            this._labFightAttemptsOwner = owner;
        } finally {
            this._labFightAttemptsLoading = false;
        }
    }

    /**
     * What the whole ledger says, rather than what the last five runs said.
     *
     * The block above plans from the newest five, which is the right window for
     * "how much do I need next run". These two lines answer the other question
     * — is the burn drifting — and for that the five newest are far too short a
     * lever: the ledger keeps thirty, and thirty is what a trend wants.
     *
     * Both lines read only runs watched from the door, for the reason
     * `observedUse` sets out: a run joined mid-way reports a floor rather than
     * a measurement, and averaging those in is how a 350-torch run comes out as
     * 106. That is also why the count of trusted runs is stated rather than the
     * count of runs — an average over three of thirty must not read as thirty.
     *
     * The torch line is normalised per deepest floor. Raw torch spend is not
     * comparable run to run: a run that stopped on floor 3 and one that reached
     * floor 7 spent very different amounts for the same play, and only the
     * per-floor figure takes the run's length back out.
     *
     * @param {Array<Object>} needs - The rows above, for their item hrids
     * @returns {HTMLElement[]} Nothing at all when no trusted run has landed yet
     */
    _labTrendLines(needs) {
        const runs = this._ledgerRuns || [];
        if (!runs.length) return [];

        const out = [];
        const dim = (el) => {
            el.style.cssText = 'margin-top:3px; font-size:0.9em; display:flex; align-items:center; gap:4px 6px;';
            el.style.color = COLORS.textDim;
            el.style.flexWrap = 'wrap';
            return el;
        };
        const hridFor = (kind) =>
            runs.find((run) => run.itemHrids?.[kind])?.itemHrids?.[kind] ||
            needs.find((need) => need.kind === kind)?.itemHrid ||
            null;

        // Per-supply burn across every trusted run the ledger holds
        const burnLine = dim(document.createElement('div'));
        const lead = document.createElement('span');
        lead.textContent = 'Burn per run:';
        burnLine.appendChild(lead);
        let anyBurn = false;
        for (const kind of SUPPLY_KINDS) {
            const summary = burnSummary(runs, kind);
            if (!summary) continue;
            anyBurn = true;
            const chip = document.createElement('span');
            chip.style.cssText = 'display:inline-flex; align-items:center; gap:3px;';
            const hrid = hridFor(kind);
            if (hrid) chip.appendChild(itemIcon(hrid, 16));
            const text = document.createElement('span');
            const spread = summary.min === summary.max ? '' : ` (${summary.min}–${summary.max})`;
            text.textContent = `${summary.average.toFixed(summary.average < 10 ? 1 : 0)}${spread}`;
            chip.appendChild(text);
            chip.title =
                `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${summary.total} spent across ` +
                `${summary.runs} run${summary.runs === 1 ? '' : 's'} watched from the door, ` +
                `averaging ${summary.average.toFixed(2)} per run (lowest ${summary.min}, highest ${summary.max}). ` +
                'Runs joined part-way through are left out — their start is only where they were first seen, ' +
                'so what they report is a floor rather than a measurement.';
            burnLine.appendChild(chip);
        }
        if (anyBurn) out.push(burnLine);

        // Torches per floor, so a short run and a deep one can be compared
        const perFloor = torchesPerFloor(runs);
        if (perFloor.length) {
            // The ledger is newest first; a trend reads left to right in time
            const oldestFirst = [...perFloor].reverse();
            const values = oldestFirst.map((entry) => entry.perFloor);
            const average = values.reduce((sum, n) => sum + n, 0) / values.length;
            const trendLine = dim(document.createElement('div'));
            const label = document.createElement('span');
            label.textContent = 'Torches per floor:';
            trendLine.appendChild(label);

            const figure = document.createElement('span');
            figure.textContent = average.toFixed(1);
            trendLine.appendChild(figure);

            // Two points are two points, not a shape; a single bar is noise
            const spark = sparkText(values);
            if (values.length >= 3) {
                const bars = document.createElement('span');
                bars.textContent = spark;
                bars.style.cssText = 'letter-spacing:1px; font-family:monospace;';
                trendLine.appendChild(bars);
            } else {
                const thin = document.createElement('span');
                thin.textContent = `— ${values.length} run${values.length === 1 ? '' : 's'} so far`;
                trendLine.appendChild(thin);
            }

            trendLine.title =
                `Torches spent divided by the deepest floor reached, for each of the ${values.length} ` +
                `run${values.length === 1 ? '' : 's'} watched from the door, oldest on the left. ` +
                'Dividing by the floor is what makes a short run and a deep one comparable. ' +
                `Average ${average.toFixed(2)} per floor; the runs read ` +
                `${oldestFirst.map((entry) => `${entry.torches}/F${entry.floor}`).join(', ')}.`;
            trendLine.style.textDecoration = 'underline dotted';
            out.push(trendLine);
        }

        return out;
    }

    /**
     * One labyrinth item: held, per-run, the buy decision for X runs, and how
     * many whole runs the held pile already covers.
     *
     * @param {string} itemHrid - The item
     * @param {number} perRun - Full consumption per run
     * @param {number} runs - The run target
     * @param {Array<Object>} inventory - dataManager.getInventory() shape
     * @returns {HTMLElement}
     */
    _labRow(itemHrid, perRun, runs, inventory, need = null) {
        const row = this._grid();
        row.style.padding = '2px 0';

        const held = heldInInventory(inventory, itemHrid);
        const needCount = Math.max(0, Math.ceil(perRun * runs) - held);
        const prices = getItemPrices(itemHrid);
        const ask = Number(prices?.ask) > 0 ? Number(prices.ask) : null;
        const bid = Number(prices?.bid) > 0 ? Number(prices.bid) : null;

        const heldCell = this._cell(formatLargeNumber(held));

        const icon = itemIcon(itemHrid, 18);
        linkToMarketplace(icon, itemHrid, navigateToMarketplace);
        const name = document.createElement('span');
        name.textContent = dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop();
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(name, itemHrid, navigateToMarketplace);

        const perRunCell = this._cell(`${formatLargeNumber(perRun)}/run`);
        perRunCell.style.color = COLORS.textDim;
        if (need?.basis === 'capacity' && need?.capacity) {
            perRunCell.title = 'Full capacity every run, as the basis pill asks.';
        } else if (need?.observedRuns > 0) {
            perRunCell.title =
                `Average actually spent over your last ${need.observedRuns} recorded run${need.observedRuns === 1 ? '' : 's'} ` +
                `(capacity ${formatLargeNumber(need.capacity)}). Only runs watched from the door count.`;
            perRunCell.style.textDecoration = 'underline dotted';
        } else if (need?.capacity) {
            perRunCell.title =
                'Full capacity — what a run can spend; once a run has been watched from the door this becomes ' +
                'what runs actually spend.';
        }

        const cost = this._cell(ask === null ? '—' : formatLargeNumber(Math.round(ask * perRun)));
        cost.style.color = COLORS.textDim;
        cost.title =
            ask === null ? 'No price known.' : `~${Math.round(ask * perRun).toLocaleString()} coins per run at ask.`;

        const buy = this._cell(needCount ? formatLargeNumber(needCount) : '✓');
        buy.style.color = needCount ? ROW_COLORS.gold : ROW_COLORS.good;
        if (needCount) {
            const strategy = buyStrategy({
                count: needCount,
                ask,
                bid,
                // A lab restock has no running-out clock — the run starts when
                // you start it — so urgency never forces an instant buy here
                secondsLeft: Infinity,
                fillSeconds: this._fillSeconds(itemHrid, needCount),
                maxSpreadPct: this._buyNumber('market_consumableBuyMaxSpreadPct', 2),
                minSavingCoins: this._buyNumber('market_consumableBuyMinSaving', 0),
                minOrderValue: this._buyNumber('market_consumableBuyMinOrderValue', 0),
            });
            buy.textContent = `${formatLargeNumber(needCount)} ${strategy.mode === 'order' ? '⏳' : '⚡'}`;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            buy.title =
                `Buy ${needCount.toLocaleString()} for ${runs} run${runs === 1 ? '' : 's'}` +
                (ask === null ? '' : ` — about ${Math.round(ask * needCount).toLocaleString()} coins`) +
                `.\n${strategy.mode === 'order' ? 'Place an order' : 'Buy now'}: ${strategy.reason}`;
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._buy({ itemHrid }, needCount, strategy);
            });
        }

        const runsHeld = perRun > 0 ? Math.floor(held / perRun) : 0;
        const lasts = this._cell(`${formatLargeNumber(runsHeld)} run${runsHeld === 1 ? '' : 's'}`);
        lasts.style.color = runsHeld >= runs ? ROW_COLORS.good : ROW_COLORS.bad;

        row.append(heldCell, icon, name, perRunCell, cost, buy, lasts);
        return row;
    }

    /**
     * One player's consumables, with their own summary.
     * @param {Object} player - From `_players`
     * @returns {HTMLElement}
     */
    _playerSection(player) {
        const section = document.createElement('div');
        section.style.marginBottom = '12px';

        const soonest = firstToRunOut(player.forecasts);
        const sides = costPerDaySides(player.forecasts);
        const need = refillAll(player.forecasts, this.target.seconds);

        // What each row is short of — the list the marketplace tabs, the Buy
        // all walk and the footer are all built from, worked out once so none
        // of them can differ from the rows
        const shortfall = player.forecasts
            .map((entry) => ({
                ...refillFor(entry, this.target.seconds),
                itemHrid: entry.itemHrid,
                name: entry.name,
                secondsLeft: entry.secondsLeft,
            }))
            .filter((item) => item.count > 0);

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.border}`,
            paddingBottom: '3px',
            marginBottom: '5px',
        });

        const name = document.createElement('span');
        name.textContent = player.isCurrent ? `${player.name} (you)` : player.name;
        name.style.fontWeight = 'bold';
        name.style.color = player.isCurrent ? COLORS.accent : COLORS.text;

        const stops = document.createElement('span');
        stops.style.marginLeft = 'auto';
        if (soonest) {
            stops.textContent = `stops in ${shortDuration(soonest.secondsLeft)} · ${soonest.name}`;
            stops.style.color = soonest.secondsLeft < this.target.seconds ? ROW_COLORS.bad : ROW_COLORS.good;
        } else {
            // Nothing being consumed at all, which is not the same as lasting
            // forever — it usually means an empty slot
            stops.textContent = 'nothing being consumed';
            stops.style.color = COLORS.textDim;
        }

        // Only your own shortfall is walkable — a party member's supplies are
        // theirs to buy, so their sections stay read-only
        if (player.isCurrent) this._registerBuyQueue(player.name || 'You', shortfall);
        heading.append(name, stops);
        section.appendChild(heading);

        section.appendChild(this._columnHeadings());
        for (const entry of player.forecasts) {
            section.appendChild(this._entryRow(entry, entry === soonest));
        }

        section.appendChild(this._footer(sides, need, shortfall));
        return section;
    }

    /** @returns {HTMLElement} */
    _columnHeadings() {
        const row = this._grid();
        row.style.color = COLORS.textDim;
        row.style.marginBottom = '3px';

        for (const [text, align] of [
            ['Held', 'right'],
            ['', 'left'],
            ['Item', 'left'],
            ['Per day', 'right'],
            ['Cost/day', 'right'],
            [`Buy for ${this.target.label}`, 'right'],
            ['Lasts', 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            row.appendChild(cell);
        }
        return row;
    }

    /**
     * One consumable, laid out the way MCS's CRack lays it out: the count you
     * hold, the icon, the name, then the rates and the countdown.
     *
     * The one that runs out first is coloured throughout rather than only in its
     * time column — it is the row the whole panel exists to point at, and a
     * single red figure at the far right is easy to miss.
     *
     * @param {Object} entry - A forecast
     * @param {boolean} isLimiting - Whether this is the one that stops the run
     * @returns {HTMLElement}
     */
    _entryRow(entry, isLimiting) {
        const row = this._grid();
        row.style.padding = '2px 0';

        const held = this._cell(formatLargeNumber(entry.held));
        held.style.color = isLimiting ? ROW_COLORS.bad : COLORS.text;

        const icon = itemIcon(entry.itemHrid, 18);
        linkToMarketplace(icon, entry.itemHrid, navigateToMarketplace);

        const name = document.createElement('span');
        name.textContent = entry.name;
        Object.assign(name.style, {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: isLimiting ? ROW_COLORS.bad : COLORS.text,
        });
        linkToMarketplace(name, entry.itemHrid, navigateToMarketplace);

        const perDay = this._cell(entry.perDay >= 1 ? `${entry.perDay.toFixed(1)}/day` : '—');
        perDay.style.color = COLORS.textDim;

        // Both sides stacked, because buying costs ask and what you hold is worth
        // bid — averaging them hides a gap that is real money at this scale
        const cost = document.createElement('span');
        Object.assign(cost.style, { textAlign: 'right', lineHeight: '1.15', fontSize: '90%' });
        const sides = entry.costPerDaySides;
        if (sides.ask === null && sides.bid === null) {
            cost.textContent = '—';
            cost.style.color = COLORS.textDim;
        } else {
            cost.appendChild(this._side('Ask', sides.ask));
            cost.appendChild(this._side('Bid', sides.bid));
        }

        const need = refillFor(entry, this.target.seconds);
        const buy = this._cell(need.count ? formatLargeNumber(need.count) : '✓');
        buy.style.color = need.count ? ROW_COLORS.gold : ROW_COLORS.good;

        if (need.count) {
            const strategy = buyStrategy({
                count: need.count,
                ask: entry.price,
                bid: entry.costPerDaySides.bid && entry.perDay ? entry.costPerDaySides.bid / entry.perDay : null,
                secondsLeft: entry.secondsLeft,
                fillSeconds: this._fillSeconds(entry.itemHrid, need.count),
                // The bulk sell assistant's rules, mirrored for buying and read
                // from their own settings so this panel and the settings page
                // can never disagree
                maxSpreadPct: this._buyNumber('market_consumableBuyMaxSpreadPct', 2),
                minSavingCoins: this._buyNumber('market_consumableBuyMinSaving', 0),
                minOrderValue: this._buyNumber('market_consumableBuyMinOrderValue', 0),
            });

            // The recommendation is on the face of it, because it is the whole
            // reason to press one of these rather than open the marketplace
            buy.textContent = `${formatLargeNumber(need.count)} ${strategy.mode === 'order' ? '⏳' : '⚡'}`;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            const opens = config.getSetting('market_consumableBuyOpenRecommended')
                ? `\nOpens the ${strategy.mode === 'order' ? 'buy-listing' : 'Buy Now'} form with the quantity filled in.`
                : '';
            buy.title =
                `Buy ${need.count.toLocaleString()}` +
                (need.cost === null ? '' : ` for about ${Math.round(need.cost).toLocaleString()} coins`) +
                `.\n${strategy.mode === 'order' ? 'Place an order' : 'Buy now'}: ${strategy.reason}` +
                opens +
                (strategy.measured ? '' : '\nOpen it in the marketplace once to measure its queue.');
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._buy(entry, need.count, strategy);
            });
        }

        const lasts = this._cell(Number.isFinite(entry.secondsLeft) ? shortDuration(entry.secondsLeft) : '∞');
        if (!Number.isFinite(entry.secondsLeft)) lasts.style.color = COLORS.textDim;
        // Measured against the target rather than a fixed hour: with "3 days"
        // chosen, something lasting two of them is exactly what you opened this
        // to find, and green was the panel disagreeing with its own Buy column
        else
            lasts.style.color =
                isLimiting || entry.secondsLeft < this.target.seconds ? ROW_COLORS.bad : ROW_COLORS.good;

        row.append(held, icon, name, perDay, cost, buy, lasts);
        return row;
    }

    /**
     * One side of the book, on its own line.
     * @param {string} label - `Ask` or `Bid`
     * @param {number|null} value - Coins per day
     * @returns {HTMLElement}
     */
    _side(label, value) {
        const line = document.createElement('div');
        line.textContent = `${label}: ${value === null ? '—' : formatLargeNumber(Math.round(value))}`;
        line.style.color = COLORS.textDim;
        line.style.whiteSpace = 'nowrap';
        return line;
    }

    /**
     * @param {{ask: number, bid: number}} sides - Cost per day
     * @param {{items: number, cost: number, unpriced: number}} need - Total shortfall
     * @param {Array<Object>} shortfall - What to buy, per item
     * @returns {HTMLElement}
     */
    _footer(sides, need, shortfall) {
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderTop: `1px solid ${COLORS.border}`,
            marginTop: '5px',
            paddingTop: '4px',
            fontWeight: 'bold',
        });

        const label = document.createElement('span');
        label.textContent = 'Total Cost/Day:';
        label.style.color = COLORS.accent;

        const value = document.createElement('span');
        value.textContent = `Ask: ${formatLargeNumber(Math.round(sides.ask))} / Bid: ${formatLargeNumber(Math.round(sides.bid))}`;
        value.style.whiteSpace = 'nowrap';

        const buy = document.createElement('span');
        buy.style.marginLeft = 'auto';
        buy.style.whiteSpace = 'nowrap';

        if (need.items) {
            // The whole restock in one gesture. Buying it a row at a time means
            // a trip back to this panel between each one, and this panel is
            // behind the marketplace you would be standing in.
            buy.textContent = `Buy all ${formatLargeNumber(need.items)} · ${formatLargeNumber(Math.round(need.cost))}`;
            buy.style.color = ROW_COLORS.gold;
            buy.style.cursor = 'pointer';
            buy.style.textDecoration = 'underline dotted';
            buy.title =
                'Open the marketplace with a tab per item, each showing what is missing.' +
                (need.unpriced ? `\n${need.unpriced} item(s) could not be priced and are not in this total.` : '');
            buy.addEventListener('click', (event) => {
                event.stopPropagation();
                this._openShoppingList(shortfall);
            });
        } else {
            buy.textContent = 'Stocked ✓';
            buy.style.color = ROW_COLORS.good;
        }

        footer.append(label, value, buy);
        return footer;
    }

    /** The one grid every line shares, so the columns line up */
    _grid() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '64px 20px minmax(0, 1fr) 76px 84px 74px 64px',
            gap: '6px',
            alignItems: 'baseline',
        });
        return row;
    }

    /**
     * @param {string} text - Cell contents
     * @returns {HTMLElement}
     */
    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    /**
     * Repaint because a setting the body reads was changed somewhere else.
     *
     * Through the tick rather than straight into `_render`, so it keeps the
     * tick's manners: a folded panel and a control somebody is in the middle of
     * are left alone.
     * @returns {void}
     */
    refreshFromSettings() {
        if (!this.panel) return;
        this._tick();
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
        this._escapeReg?.release();
        this._escapeReg = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const consumablesPanel = new ConsumablesPanel();

// Both at module scope, and both wait on storage internally: the target has to
// be back before the panel draws a week's shortfall as a day's, and the panel
// has to reopen if the page was left with it up.
consumablesPanel.loadSettings();
consumablesPanel.restore();

// Every setting the body reads while it draws. The body is only ever rebuilt by
// the five-second tick, so a flip made on the settings page used to leave the
// panel quoting the old answer until the tick came round — the comment beside
// the buy thresholds claimed "this panel and the settings page can never
// disagree", which was true only between ticks. Subscribed at module scope with
// the rest of this panel's wiring, since it has no feature-registry lifecycle.
for (const key of [
    'consumables_idleLoadoutPlan',
    'consumables_labPerRunBasis',
    'market_consumableBuyOpenRecommended',
    'market_consumableBuyMaxSpreadPct',
    'market_consumableBuyMinSaving',
    'market_consumableBuyMinOrderValue',
]) {
    config.onSettingChange(key, () => consumablesPanel.refreshFromSettings());
}

// At module scope with the rest, because the panel has no feature-registry
// lifecycle to hang it off: it starts itself here and there is no setting
// that switches it off, so "imported" and "available" are the same thing.
registerCommand({
    name: 'Consumables',
    hint: 'What your teas and food cost, and how long the pile lasts',
    run: () => consumablesPanel.toggle(),
});

// And restored again on every character switch. The open flags are per
// character, so running the pass once at module scope meant only the character
// logged in first ever had its panel come back — while the previous character's
// panel simply carried on, showing their stock against their plan. The teardown
// passes `remember: false` on purpose: a switch is not the user closing the
// panel, and recording it as one would write the departing character's
// arrangement into the arriving character's flags.
dataManager.on('character_switched', () => {
    consumablesPanel.hide({ remember: false });
    consumablesPanel.reloadIdlePins();
    consumablesPanel.restore();
});

// The module-scope `loadSettings()` above runs before anyone is logged in, so
// the pins it read were keyed on 'default' — this is the first read that can
// name a character
dataManager.on('character_initialized', () => consumablesPanel.reloadIdlePins());

/** Console handle, since a panel that only opens from the overlay is hard to reach */
if (typeof window !== 'undefined') {
    window.Toolasha = window.Toolasha || {};
    window.Toolasha.Debug = window.Toolasha.Debug || {};
    window.Toolasha.Debug.consumables = () => {
        const data = combatStatsDataCollector.getLatestData();
        console.log('[Consumables] players:', data?.players?.length ?? 0);
        for (const player of data?.players || []) {
            const stats = calculatePlayerStats(player, data.durationSeconds || 0);
            console.log(` ${player.name}:`, forecastAll(stats?.consumableBreakdown));
        }
        return dataManager.getCurrentCharacterId?.();
    };
}
