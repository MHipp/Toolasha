/**
 * Combat Consumable Alerts
 *
 * Says so when the soonest combat consumable to run out — a food or a drink in
 * the current fight — falls under a configurable number of hours. A fight
 * stops being a fight when its first slot empties, and the one person who
 * cannot see that coming is the one who is not at the screen.
 *
 * ## Where the reading comes from
 *
 * The same forecast the Consumables panel draws: the combat stats collector's
 * per-player consumable breakdown (what is being eaten and drunk, how fast,
 * how many are left), normalised by `consumable-forecast.js`, and the minimum
 * of it — `firstToRunOut`. Only this character's own slots; a party member's
 * supplies are theirs to watch.
 *
 * ## Polling, and the crossing
 *
 * A countdown crosses a threshold by the passage of time, so this is re-read
 * on every battle tick and on a slow interval as a backstop. The crossing is a
 * pure predicate shared with the drink timer: once under the threshold it
 * fires, and it re-arms only after the supply is back above it — restocking
 * mid-fight is what re-arms it, not the next tick.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { thresholdCrossing } from './notification-predicates.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { forecastAll, firstToRunOut, drinkRatePerDay } from '../../utils/consumable-forecast.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_combatConsumableLow';

/** The threshold, in hours */
export const HOURS_SETTING = 'notifications_combatConsumableLowHours';

/** Default threshold when the setting is blank */
export const DEFAULT_HOURS = 3;

/** Event key for the notification service */
const EVENT_KEY = 'combat-consumable-low';

/** Backstop re-check, between battle ticks */
export const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * How often a battle tick is allowed to run the check. The ticks come three
 * a second and the check re-derives the current player's full stats; a
 * threshold measured in hours does not need to be re-read more than this.
 */
export const TICK_THROTTLE_MS = 10 * 1000;

/**
 * The current character's consumable forecasts, soonest first.
 *
 * Pure given its inputs, so the crossing can be tested without a fight.
 *
 * @param {Object} [sources] - Injectable for tests
 * @param {Function} [sources.latest] - `combatStatsDataCollector.getLatestData`
 * @param {Function} [sources.stats] - `calculatePlayerStats`
 * @param {Function} [sources.itemDetails] - `dataManager.getItemDetails`
 * @returns {{name: string, secondsLeft: number}|null} The first to run out, or null when nothing is being used
 */
export function soonestCombatConsumable({
    latest = () => combatStatsDataCollector.getLatestData(),
    stats = calculatePlayerStats,
    itemDetails = (hrid) => dataManager.getItemDetails?.(hrid),
} = {}) {
    const data = latest();
    const player = (data?.players || []).find((entry) => entry?.isCurrentPlayer);
    if (!player) return null;

    const computed = stats(player, data.durationSeconds || 0);
    const concentration = player?.combatStats?.drinkConcentration || 0;
    // Drinks tick on a timer rather than per fight; their rate is the buff's
    // duration, as the Consumables panel reads it
    const breakdown = (computed?.consumableBreakdown || []).map((entry) => {
        const duration = itemDetails(entry?.itemHrid)?.consumableDetail?.buffs?.[0]?.duration;
        const perDay = drinkRatePerDay(duration, concentration);
        if (perDay === null) return entry;
        return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
    });

    return firstToRunOut(forecastAll(breakdown, null, { keepOrder: true }));
}

class CombatConsumableAlerts {
    constructor() {
        /** Whether the next crossing under the threshold should fire */
        this.armed = true;
        this.timers = createTimerRegistry();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        this.lastTickAt = 0;
    }

    /**
     * Start watching the current fight's consumables.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        const onTick = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[CombatConsumableAlerts] Checking consumables failed:', error);
            }
        };
        this.lastTickAt = 0;
        const onBattleTick = () => {
            const now = Date.now();
            if (now - this.lastTickAt < TICK_THROTTLE_MS) return;
            this.lastTickAt = now;
            onTick();
        };
        webSocketHook.on('battle_updated', onBattleTick);
        this.unregisterHandlers.push(() => webSocketHook.off('battle_updated', onBattleTick));
        this.timers.registerInterval(setInterval(onTick, CHECK_INTERVAL_MS));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * The threshold, in seconds, from the setting.
     * @returns {number}
     */
    thresholdSeconds() {
        const hours = Number(config.getSettingValue?.(HOURS_SETTING, DEFAULT_HOURS));
        return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS) * 3600;
    }

    /**
     * Read the soonest consumable and announce a crossing.
     * @param {Object} [sources] - As {@link soonestCombatConsumable}, for tests
     */
    check(sources) {
        if (!config.getSetting(MASTER_SETTING)) return;

        const soonest = soonestCombatConsumable(sources);
        if (!soonest) return;

        const next = thresholdCrossing({
            armed: this.armed,
            secondsLeft: soonest.secondsLeft,
            thresholdSeconds: this.thresholdSeconds(),
        });
        if (!next.fire) {
            this.armed = next.armed;
            return;
        }

        const result = notificationService.notify(
            EVENT_KEY,
            `${soonest.name} runs out in ${formatMinutes(soonest.secondsLeft)} — your fight stops when it does.`,
            { title: 'Combat consumable running low' }
        );

        // Disarmed only once the notice actually reached the player. Disarming
        // on every crossing regardless of delivery — no toast host mounted yet,
        // most likely, right after a fresh load — left a supply that ran low
        // into no channel un-retried until it was restocked and ran low again.
        if (result?.fired) this.armed = next.armed;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.timers.clearAll?.();
        this.armed = true;
    }
}

/**
 * A short time, the way a person says it.
 * @param {number} seconds
 * @returns {string}
 */
function formatMinutes(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total}s`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const combatConsumableAlerts = new CombatConsumableAlerts();

export default combatConsumableAlerts;
