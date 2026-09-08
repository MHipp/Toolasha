/**
 * Savings Goal Alerts
 *
 * Says so when something on your savings list becomes affordable.
 *
 * The savings panel has always known this — `savingsProgress` returns
 * `affordable` alongside the bar fraction, and every row on the list is costed
 * against your spendable coins on every redraw. But the panel is the only place
 * that reads it, and the panel is a panel: it tells you the moment you open it,
 * which is never the moment it happened. Saving for a late-game piece is a
 * week-long affair, and the whole point of a goal is to stop checking.
 *
 * ## Where the reading comes from
 *
 * The same three lists the panel draws — `watchedTargets` for gear,
 * `watchedAbilityGoals` for ability levels, `watchedHouseGoals` for house rooms
 * — so a goal is affordable here exactly when the panel would draw it as
 * affordable, including every subtlety the panel already settled: the trade-in
 * value of the piece you are replacing, coins tied up in market orders counted
 * or not per your setting, and a craft costed from its inputs rather than its
 * ask.
 *
 * A goal the character has already *reached* without buying it — an ability read
 * up to level over a week of drops, a room built out of materials in hand — is
 * skipped rather than announced. The panel costs those at zero, which makes them
 * permanently "affordable", and announcing that would be announcing something
 * that already happened and was already visible.
 *
 * ## The price's age
 *
 * A cost is a pile of market figures, and market figures go stale: the game's
 * `marketplace.json` refreshes about hourly and this script's cache holds it for
 * fifteen minutes, so "you can afford this now" can rest on a quote from this
 * morning. Every message carries the age of the figure behind it, and a figure
 * older than the cache window says so outright, exactly as the undercut alert
 * does. The alert still fires on a stale quote — unlike the undercut alert,
 * which stays silent, because there the stale figure is the *whole* claim while
 * here the coins in your purse are real and only the price is in doubt — but it
 * never lets the player mistake an old quote for a current one.
 *
 * ## Repeats
 *
 * One armed bit per goal, on the discipline `market-undercut-alerts.js`
 * documents. The bit disarms on the first announcement and re-arms when the
 * situation reverses — you spend the coins, or a price moves the goal back out
 * of reach — or when the target itself changes, which resets the goal's state
 * entirely: raising an ability goal from Lv46 to Lv51 is a new intention, not
 * the old one restated. As there, a target change also bumps a generation
 * counter that rides in the event key, so the service's cooldown on the old
 * target cannot eat the new target's news.
 *
 * A goal that cannot be costed at all leaves its bit exactly as it was. An
 * unpriced target is unknown rather than unaffordable, and treating it as the
 * latter would re-arm a goal every time the market failed to quote it and
 * announce it again on the next quote that landed.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { watchedTargets, watchedAbilityGoals, watchedHouseGoals } from '../inventory/equipment-savings-row.js';
import notificationService from './notification-service.js';
import { goalAffordable } from './notification-predicates.js';
import { formatKMB3Digits, formatRelativeTime } from '../../utils/formatters.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_savingsGoalReached';

/** Prefix for the notification service's event keys, and so for its category */
const EVENT_KEY_PREFIX = 'savings-goal';

/**
 * Every goal on the savings list, in the one shape this cares about.
 *
 * The three panel lists differ in what identifies a goal and in what "the
 * target" means — an enhancement level for a piece of gear, a level number for
 * an ability or a room — so both are flattened here rather than special-cased
 * at every use below.
 *
 * @returns {Array<{key: string, signature: string, name: string, cost: number|null,
 *   affordable: boolean, itemHrid: string, enhancementLevel: number}>}
 */
export function savingsGoalReadings() {
    const readings = [];

    for (const target of watchedTargets()) {
        readings.push({
            key: `item:${target.itemHrid}`,
            signature: `+${target.enhancementLevel || 0}`,
            name: target.name,
            cost: target.cost,
            affordable: target.affordable === true,
            itemHrid: target.itemHrid,
            enhancementLevel: target.enhancementLevel || 0,
        });
    }

    for (const goal of watchedAbilityGoals()) {
        // Already read up to level: the panel costs it at zero, which is not the
        // same thing as having saved for it
        if (goal.done) continue;
        readings.push({
            key: `ability:${goal.abilityHrid}`,
            signature: `Lv${goal.targetLevel}`,
            name: goal.name,
            cost: goal.cost,
            affordable: goal.affordable === true,
            // The book is the tradeable thing, so it is what has a price age
            itemHrid: goal.itemHrid,
            enhancementLevel: 0,
        });
    }

    for (const goal of watchedHouseGoals()) {
        if (goal.done) continue;
        readings.push({
            key: `house:${goal.houseRoomHrid}`,
            signature: `Lv${goal.targetLevel}`,
            name: goal.name,
            cost: goal.cost,
            affordable: goal.affordable === true,
            // A room is built from materials, so no single item dates its cost;
            // the snapshot's own timestamp stands in
            itemHrid: '',
            enhancementLevel: 0,
        });
    }

    return readings;
}

class SavingsGoalAlerts {
    constructor() {
        /** goal key → {armed, signature, generation}; the signature so a new target is a fresh start */
        this.goalStates = new Map();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        /** Whether the listeners are already up */
        this.isInitialized = false;
    }

    /**
     * Start watching the savings list.
     * @returns {Promise<void>}
     */
    async initialize() {
        // The feature registry retries features that failed to start, and a
        // second run here would add a second handler set — every coin change
        // then costs the whole savings list twice
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.isInitialized = true;

        const handler = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[SavingsGoalAlerts] Checking savings goals failed:', error);
            }
        };

        // Both halves of the comparison can move: the coins on an inventory
        // message, the costs on a price refresh. The level events matter too —
        // a goal reached by levelling up rather than by buying drops off the
        // list, and its state should go with it.
        const events = [
            'character_initialized',
            'items_updated',
            'market_listings_updated',
            'skills_updated',
            'house_rooms_updated',
        ];
        for (const event of events) {
            dataManager.on(event, handler);
        }
        this.unregisterHandlers.push(() => {
            for (const event of events) {
                dataManager.off(event, handler);
            }
        });

        marketAPI.on(handler);
        this.unregisterHandlers.push(() => marketAPI.off(handler));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Run every goal through the predicate, and announce what crossed.
     */
    check() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const readings = savingsGoalReadings();
        const seen = new Set();

        for (const reading of readings) {
            seen.add(reading.key);
            this.evaluateGoal(reading);
        }

        // A goal taken off the list takes its state with it, so putting it back
        // later starts armed rather than inheriting a disarmed bit from before
        for (const key of this.goalStates.keys()) {
            if (!seen.has(key)) this.goalStates.delete(key);
        }
    }

    /**
     * One goal: the armed bit, the predicate, and the message.
     * @param {Object} reading - From {@link savingsGoalReadings}
     */
    evaluateGoal(reading) {
        let state = this.goalStates.get(reading.key);
        if (!state || state.signature !== reading.signature) {
            // New to us, or retargeted — either way this is a different
            // intention from whatever was last announced for this key, and the
            // generation counter below keeps the service's cooldown on the old
            // target from swallowing the new one's first message
            const generation = (state?.generation || 0) + 1;
            state = { armed: true, signature: reading.signature, generation };
            this.goalStates.set(reading.key, state);
        }

        const { fire, armed } = goalAffordable({
            armed: state.armed,
            affordable: reading.affordable,
            costKnown: reading.cost !== null && reading.cost !== undefined,
        });
        if (!fire) {
            state.armed = armed;
            return;
        }

        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${reading.key}:${state.signature}:${state.generation}`,
            this.buildMessage(reading),
            {
                title: 'Savings goal reached',
                // Delivery metadata, not a change of mind about what is worth
                // saying: it is what lets a digest name the goals it counted
                subject: reading.name,
            }
        );

        // Disarmed only once the notice actually reached the player, exactly as
        // the undercut alert disarms its own bit: a goal that became affordable
        // while nothing was there to say so — no toast host mounted yet, most
        // likely — must stay retryable rather than going quiet until the coins
        // are spent and saved up again, which for a goal never touched again is
        // never.
        if (result?.fired) state.armed = armed;
    }

    /**
     * How old the figures behind a goal's cost are.
     *
     * There is no per-item API timestamp — `marketplace.json` is one snapshot —
     * so this is the snapshot's own age, or the age of a fresher write-through
     * patch when the item has one. For a house room, which is costed from a pile
     * of materials rather than one listing, it is the snapshot's age outright.
     *
     * @param {Object} reading - From {@link savingsGoalReadings}
     * @returns {number|null} Milliseconds, or null when nothing dates the price
     */
    priceAgeMs(reading) {
        const timestamp = marketAPI.getPriceTimestamp(reading.itemHrid, reading.enhancementLevel);
        if (!Number.isFinite(timestamp)) return null;
        return Math.max(0, Date.now() - timestamp);
    }

    /**
     * The message, carrying the cost and the age of the figures behind it.
     *
     * The age is the honesty clause, as it is in the undercut alert: a cost is
     * made of market quotes, and "you can afford this now" built on a quote from
     * this morning is a claim about this morning. Beyond the cache window it is
     * said outright rather than left to be read off a number.
     *
     * @param {Object} reading - The goal that just became affordable
     * @returns {string} What to tell the player
     */
    buildMessage(reading) {
        const cost = formatKMB3Digits(reading.cost);
        const ageMs = this.priceAgeMs(reading);

        let age;
        if (ageMs === null) {
            age = 'price age unknown';
        } else if (ageMs < 60000) {
            age = 'priced just now';
        } else if (ageMs > marketAPI.CACHE_DURATION) {
            age = `priced ~${formatRelativeTime(ageMs)} ago, so it may have moved`;
        } else {
            age = `priced ~${formatRelativeTime(ageMs)} ago`;
        }

        return `${reading.name} is now affordable: ${cost} (${age}).`;
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
        // The armed bits go with the listeners. Keeping them would mean a
        // re-enable — or a character switch, which comes through here — silently
        // inheriting another session's (or another character's) idea of what had
        // already been announced.
        this.goalStates.clear();
        this.isInitialized = false;
    }
}

const savingsGoalAlerts = new SavingsGoalAlerts();

export default savingsGoalAlerts;
