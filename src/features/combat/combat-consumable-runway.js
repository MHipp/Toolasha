/**
 * Combat consumable runway
 *
 * How long each food and drink lasts, under its own icon, while the fight is running.
 *
 * The number is not new. The consumables panel already ranks every slot of every party member
 * against a target duration, and the overlay already names the one that runs out first. What
 * neither can do is answer the question at the moment it is actually asked — mid-fight, looking
 * straight at the Consumables grid, deciding whether to walk away from the tab for the night.
 * Both existing surfaces cost a click and a context switch to reach, and a runway figure is only
 * useful before the runway ends. So this places the same figure where it is already being looked
 * for, and states nothing the other two do not.
 *
 * ## Where the figure comes from
 *
 * `combat-stats-data-collector` measures consumption empirically off `new_battle`, and
 * `consumable-forecast` turns that into a per-slot `secondsLeft` — the same path the panel and
 * the low-consumable alert take, drink re-rating included (see {@link exactDrinkRates}: a drink
 * is re-poured on its buff's clock, not eaten by the fight). Three surfaces reading one
 * derivation is the point; a caption that disagreed with the panel it sits two clicks from would
 * be worse than no caption.
 *
 * ## Cadence, on a hot path
 *
 * The battle grid is redrawn constantly and `battle_updated` ticks three times a second. Nothing
 * here runs on that. The only refresh signal is `new_battle` — the exact event that makes the
 * collector recompute its rates, so redrawing more often could not produce a different number —
 * plus a debounced `domObserver` registration that redraws when React rebuilds the grid and takes
 * the captions with it. No timer of its own, and a draw whose text is unchanged touches no node.
 *
 * The join to a slot is the **item**, read off the icon's own sprite href, never the slot's
 * position: the grid shows what is equipped for this fight, and a caption joined by index puts
 * one item's runway under another's icon the moment a slot is empty.
 *
 * Off by default, per this fork's rule for anything new and user-visible.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { forecastAll, exactDrinkRates } from '../../utils/consumable-forecast.js';
import { ROW_COLORS, shortDuration } from '../../utils/overlay-format.js';

/** The live in-battle Consumables grid, and one item cell in it */
const GRID = '[class*="BattlePanel_combatConsumables"]';
const CELL = '[class*="CombatConsumable_combatConsumable"]';

/** Marks a caption as ours, so a rebuild that kept one cannot leave two */
export const CAPTION_MARK = 'data-toolasha-consumable-runway';

/**
 * Hours of runway below which a caption is drawn as a warning.
 *
 * The same setting the low-consumable notification crosses, so the caption turns red in the same
 * moment the alert would fire rather than on a threshold of its own.
 */
export const HOURS_SETTING = 'notifications_combatConsumableLowHours';
export const DEFAULT_HOURS = 3;

/**
 * Item hrid a cell is showing, from its icon's sprite href fragment
 * (`#star_fruit_gummy` → `/items/star_fruit_gummy`).
 *
 * @param {Element} cell - One consumable cell
 * @returns {string|null} The hrid, or null when the cell has no icon (an empty slot)
 */
export function cellItemHrid(cell) {
    const use = cell?.querySelector?.('use');
    const href = use?.getAttribute?.('href') || use?.getAttribute?.('xlink:href') || '';
    const slug = href.split('#')[1];
    return slug ? `/items/${slug}` : null;
}

/**
 * Runway in seconds for each of the current character's consumables, keyed by item.
 *
 * Pure given its inputs, so the mapping can be tested without a fight.
 *
 * @param {Object} [sources] - Injectable for tests
 * @param {Function} [sources.latest] - `combatStatsDataCollector.getLatestData`
 * @param {Function} [sources.stats] - `calculatePlayerStats`
 * @param {Function} [sources.itemDetails] - `dataManager.getItemDetails`
 * @returns {Map<string, number>} itemHrid → seconds left (`Infinity` when it is not being used)
 */
export function runwayByItem({
    latest = () => combatStatsDataCollector.getLatestData(),
    stats = calculatePlayerStats,
    itemDetails = (hrid) => dataManager.getItemDetails?.(hrid),
} = {}) {
    const data = latest();
    const player = (data?.players || []).find((entry) => entry?.isCurrentPlayer);
    if (!player) return new Map();

    const computed = stats(player, data.durationSeconds || 0);
    const breakdown = exactDrinkRates(
        computed?.consumableBreakdown,
        player?.combatStats?.drinkConcentration || 0,
        itemDetails
    );

    const runways = new Map();
    for (const entry of forecastAll(breakdown, null, { keepOrder: true })) {
        if (entry?.itemHrid) runways.set(entry.itemHrid, entry.secondsLeft);
    }
    return runways;
}

/**
 * What one caption says and what colour it says it in.
 *
 * A slot that is filled but not being used reads `∞` rather than a duration — "you are not
 * drinking this" is a different statement from "this will last a long time", and the panel draws
 * that distinction the same way.
 *
 * @param {number} secondsLeft - From {@link runwayByItem}
 * @param {number} warnSeconds - Below this the caption warns
 * @returns {{text: string, color: string}}
 */
export function captionFor(secondsLeft, warnSeconds) {
    if (!Number.isFinite(secondsLeft)) return { text: '∞', color: ROW_COLORS.dim };
    return {
        text: shortDuration(secondsLeft),
        color: secondsLeft < warnSeconds ? ROW_COLORS.bad : ROW_COLORS.neutral,
    };
}

class CombatConsumableRunway {
    constructor() {
        this.isInitialized = false;
        this.unregister = null;
        this.unregisterReady = null;
        this.newBattleHandler = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('combatConsumableRunway')) return;
        this.isInitialized = true;

        // React rebuilds the grid when the fight view changes, taking the captions with it
        this.unregister = domObserver.onClass(
            'CombatConsumableRunway',
            ['BattlePanel_combatConsumables', 'CombatConsumable_combatConsumable'],
            () => this._draw(),
            { debounce: true, debounceDelay: 150, debounceMaxWait: 1000 }
        );

        // The collector's own cadence: the numbers cannot move between two `new_battle` messages,
        // so nothing is gained by redrawing on the three-a-second battle ticks
        this.newBattleHandler = () => this._draw();
        webSocketHook.on('new_battle', this.newBattleHandler);

        // The collector only reads its persisted snapshot lazily; without this the grid stays
        // blank until the first kill of the session even though the figure is already known
        this._backfill();

        // @run-at document-start: a battle panel rendered before the shared observer attached is
        // invisible to the class watcher, so the catch-up draw waits for its ready signal
        this.unregisterReady = domObserver.onReady('CombatConsumableRunwayCatchUp', () => this._draw());
    }

    /**
     * Draw once off the collector's persisted snapshot, before this session has seen a kill.
     * @returns {Promise<void>}
     */
    async _backfill() {
        try {
            await combatStatsDataCollector.loadLatestData?.();
            if (this.isInitialized) this._draw();
        } catch (error) {
            console.error('[CombatConsumableRunway] Loading the stored consumption data failed:', error);
        }
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        this.unregisterReady?.();
        this.unregisterReady = null;
        if (this.newBattleHandler) {
            webSocketHook.off('new_battle', this.newBattleHandler);
            this.newBattleHandler = null;
        }
        if (typeof document !== 'undefined') {
            for (const caption of document.querySelectorAll(`[${CAPTION_MARK}]`)) caption.remove();
        }
        this.isInitialized = false;
    }

    /** Seconds of runway below which a caption warns, from the shared threshold setting */
    _warnSeconds() {
        const hours = Number(config.getSettingValue?.(HOURS_SETTING, DEFAULT_HOURS));
        return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS) * 3600;
    }

    /** Put a caption under every grid icon whose item the forecast knows about */
    _draw() {
        try {
            if (typeof document === 'undefined') return;
            const grids = document.querySelectorAll(GRID);
            if (!grids.length) return;

            const runways = runwayByItem();
            const warnSeconds = this._warnSeconds();

            for (const grid of grids) {
                for (const cell of grid.querySelectorAll(CELL)) {
                    const itemHrid = cellItemHrid(cell);
                    // An item with no forecast gets nothing rather than somebody else's figure
                    if (!itemHrid || !runways.has(itemHrid)) {
                        this._captionOf(cell)?.remove();
                        continue;
                    }
                    this._caption(cell, captionFor(runways.get(itemHrid), warnSeconds));
                }
            }
        } catch (error) {
            console.error('[CombatConsumableRunway] Drawing the runway captions failed:', error);
        }
    }

    /**
     * @param {Element} cell - One consumable cell
     * @returns {Element|null} The caption drawn for it, if any
     */
    _captionOf(cell) {
        return cell.parentElement?.querySelector(`:scope > [${CAPTION_MARK}="${cellItemHrid(cell) || ''}"]`) || null;
    }

    /**
     * @param {HTMLElement} cell - One consumable cell
     * @param {{text: string, color: string}} content - What it says
     */
    _caption(cell, content) {
        const itemHrid = cellItemHrid(cell);
        let caption = this._captionOf(cell);
        if (!caption) {
            caption = document.createElement('div');
            caption.setAttribute(CAPTION_MARK, itemHrid || '');
            Object.assign(caption.style, {
                fontSize: '10px',
                lineHeight: '1.2',
                textAlign: 'center',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
            });
        }

        // Re-seated on every draw: React puts its own children back in whatever order it likes
        if (caption.previousElementSibling !== cell) cell.insertAdjacentElement('afterend', caption);

        // A draw that changed nothing touches nothing
        if (caption.textContent !== content.text) caption.textContent = content.text;
        if (caption.style.color !== content.color) caption.style.color = content.color;
    }
}

const combatConsumableRunway = new CombatConsumableRunway();

export default {
    name: 'Combat Consumable Runway',
    initialize: () => combatConsumableRunway.initialize(),
    cleanup: () => {
        try {
            return combatConsumableRunway.disable();
        } catch (error) {
            console.error('[Combat Consumable Runway] Disable failed part-way:', error);
        } finally {
            combatConsumableRunway.isInitialized = false;
        }
    },
    /** Draw now rather than on the next kill — for tests, and for a settings change */
    redraw: () => combatConsumableRunway._draw(),
};

export { combatConsumableRunway };
