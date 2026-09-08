/**
 * Price Target Alerts
 *
 * Says so when a pinned item's price comes to where you asked it to — "tell me
 * under 4.2M ask" on a watchlist chip, and then you can stop looking.
 *
 * The price panel's chips have always shown the number and the move; what they
 * could not do is watch it for you. A pin without a target is still just a
 * number you have to go and read, and the whole reason to name a price is so
 * that nobody has to sit on the marketplace tab waiting for it.
 *
 * ## Where the reading comes from
 *
 * The pooled Mooket dataset, and nothing else. This is the one deliberate
 * difference from `savings-goal-alerts.js`, and it is the same rule
 * `market-undercut-alerts.js` keeps: the claim here is *entirely* about a
 * market figure, so a figure that cannot be dated proves nothing. The game's
 * own `marketplace.json` refreshes about hourly, and the price store folds it in
 * stamped with the moment it was folded rather than the moment it was true — an
 * honest enough basis for a chip that says "updated N ago" about its own cache,
 * and not an honest basis for "the ask is under your target right now". A Mooket
 * sighting carries the time it was actually seen, which is the only timestamp
 * worth gating on.
 *
 * So: a sighting older than {@link marketAPI.CACHE_DURATION} fires nothing, and
 * every message carries the sighting's true age. And because the pool is what
 * supplies those sightings, **the alert is quiet whenever the price history
 * feature is off** — there is then no dated evidence at all, and the pins
 * themselves live in that panel. The setting's help text says so outright
 * rather than leaving a switched-on alert to be silently inert.
 *
 * ## Repeats
 *
 * One armed bit per pin, on the discipline `market-undercut-alerts.js`
 * documents. The bit disarms on the first announcement and re-arms when a fresh
 * sighting shows the price back on the wrong side of the target — or when the
 * target itself changes, which resets the pin's state entirely: moving a target
 * from 4.2M to 3.8M is a new intention, not the old one restated. As there, a
 * target change bumps a generation counter that rides in the event key, so the
 * service's cooldown on the old target cannot eat the new target's news.
 *
 * A pin whose side the market is not quoting leaves its bit exactly as it was.
 * An empty book is unknown, not "still above your price", and re-arming on it
 * would announce the same crossing twice.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import marketHistoryAPI from '../market/mooket/market-history-api.js';
import { freshestSighting } from '../market/mooket/market-history-data.js';
import { watchedPriceTargets, noteWatchedTargetReached } from '../market/mooket/index.js';
import { targetMet, describeTarget } from '../market/mooket/market-watchlist.js';
import notificationService from './notification-service.js';
import { priceTargetReached } from './notification-predicates.js';
import { formatKMB3Digits, formatRelativeTime } from '../../utils/formatters.js';
import { runPool } from '../../utils/async-pool.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_priceTargetReached';

/** Reading the pooled dataset is what authorises the Mooket lookups, and it is the only source here */
const POOLED_HISTORY_SETTING = 'market_pooledHistory';

/** Prefix for the notification service's event keys, and so for its category */
const EVENT_KEY_PREFIX = 'price-target';

/** Kept low so refreshing a long watchlist does not burst the third-party server */
const MOOKET_CONCURRENCY = 4;

class PriceTargetAlerts {
    constructor() {
        /** pin key → {armed, signature, generation}; the signature so a moved target is a fresh start */
        this.targetStates = new Map();
        /** `itemHrid:level` → {ask, bid, timestamp}; the newest Mooket sighting held */
        this.observations = new Map();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        /** Holds the refresh interval so cleanup can clear it */
        this.timers = createTimerRegistry();
        /** True while a refresh is in flight, so an overlapping tick is skipped */
        this.refreshInFlight = false;
        /** Whether the listeners and the refresh timer are already up */
        this.isInitialized = false;
    }

    /**
     * Start watching the pinned targets.
     * @returns {Promise<void>}
     */
    async initialize() {
        // The feature registry retries features that failed to start, and a
        // second run here would be a second refresh timer and a second stream
        // of third-party requests — somebody else's rate limit spent twice
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
                console.error('[PriceTargetAlerts] Checking price targets failed:', error);
            }
        };

        // The pins can change under us — one gets added, retargeted or unpinned
        // — and a character switch changes the whole list, so the check is
        // re-run on the events that move either half
        dataManager.on('character_initialized', handler);
        this.unregisterHandlers.push(() => dataManager.off('character_initialized', handler));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);

        // The sweep is on a fifteen-minute cadence, which is the right cadence
        // for watching and the wrong one for a player who has just set a target
        // and wants to know where the price is now.
        registerCommand({
            name: 'Refresh watchlist prices',
            hint: 'Re-read the pool for every pin with a target',
            kind: 'verb',
            // Not a "nothing to do" case: without the pooled dataset there is no
            // source at all, and the pins themselves live in that panel
            when: () => config.getSetting(POOLED_HISTORY_SETTING) === true,
            run: async () => {
                // The sweep skips its own overlapping ticks and says nothing
                // about having done so, which would leave this reporting a
                // refresh that never happened
                if (this.refreshInFlight) return 'already refreshing';

                const pins = this.targetedPins().length;
                if (!pins) return 'no pins with targets';

                await this.refreshObservations();
                return `${pins} pin${pins === 1 ? '' : 's'} refreshed`;
            },
        });

        this.startRefresh();
        // Seed now rather than waiting a whole cache window, so a target already
        // reached at login is caught on the first look
        this.refreshObservations();
    }

    /**
     * Re-read the pool on the market cache's own cadence.
     *
     * The same fifteen minutes the undercut alert uses, and for the same
     * reason: the Mooket lookups sit behind a five-minute cache of their own, so
     * a tick mostly reuses what is already held, and the interval exists to keep
     * the *evidence* inside the window rather than to poll for news. There is
     * deliberately no shorter, configurable cadence.
     */
    startRefresh() {
        const intervalId = setInterval(() => this.refreshObservations(), marketAPI.CACHE_DURATION);
        this.timers.registerInterval(intervalId);
    }

    /**
     * Pull each targeted pin's newest Mooket sighting, then re-run the check.
     *
     * Only when the price history panel is on — that switch is what authorises
     * talking to the third-party pool at all, and without it there is nothing
     * here to talk to. Skips its own overlapping ticks.
     *
     * @returns {Promise<void>}
     */
    async refreshObservations() {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (!config.getSetting(POOLED_HISTORY_SETTING)) return;
        if (this.refreshInFlight) return;

        const pins = this.targetedPins();
        if (!pins.length) return;

        this.refreshInFlight = true;
        let learned = false;
        try {
            await runPool(pins, MOOKET_CONCURRENCY, async (pin) => {
                try {
                    const rows = await marketHistoryAPI.fetchHistory(pin.itemHrid, pin.enhancementLevel, 1);
                    const sighting = freshestSighting(rows);
                    if (!sighting || (sighting.ask === null && sighting.bid === null)) return;
                    this.observations.set(`${pin.itemHrid}:${pin.enhancementLevel}`, {
                        ask: sighting.ask,
                        bid: sighting.bid,
                        timestamp: sighting.time,
                    });
                    learned = true;
                } catch (error) {
                    console.error('[PriceTargetAlerts] Mooket lookup failed:', pin.itemHrid, error);
                }
            });
        } finally {
            this.refreshInFlight = false;
        }

        if (learned) this.check();
    }

    /**
     * The pins that actually carry a target.
     *
     * A pin without one is a price somebody wanted to see, not a price they
     * asked to be told about, so it is not looked up at all — the third-party
     * request would be spent on a comparison that can never fire.
     *
     * @returns {Array<Object>} From `watchedPriceTargets`
     */
    targetedPins() {
        try {
            return watchedPriceTargets().filter((pin) => pin?.target);
        } catch (error) {
            console.error('[PriceTargetAlerts] Reading the watchlist failed:', error);
            return [];
        }
    }

    /**
     * Compare every targeted pin against its newest sighting, and say what crossed.
     */
    check() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const pins = this.targetedPins();
        const seen = new Set();

        for (const pin of pins) {
            seen.add(pin.key);
            this.evaluatePin(pin);
        }

        // A pin unpinned, or one whose target was cleared, takes its state with
        // it — so setting a target on it again starts armed rather than
        // inheriting a disarmed bit from before
        for (const key of this.targetStates.keys()) {
            if (!seen.has(key)) this.targetStates.delete(key);
        }
    }

    /**
     * One pin: the armed bit, the predicate, and the message.
     * @param {Object} pin - From `watchedPriceTargets`, carrying a target
     */
    evaluatePin(pin) {
        const signature = `${pin.target.side}:${pin.target.price}`;

        let state = this.targetStates.get(pin.key);
        if (!state || state.signature !== signature) {
            // New to us, or retargeted — either way the player has said
            // something since anything was last announced for this pin. The
            // generation counter rides in the event key below so the service's
            // cooldown on the old target cannot swallow the new one's first
            // message, exactly as in the undercut alert
            const generation = (state?.generation || 0) + 1;
            state = { armed: true, signature, generation };
            this.targetStates.set(pin.key, state);
        }

        const observation = this.observations.get(`${pin.itemHrid}:${pin.enhancementLevel}`);
        const priceAgeMs = observation ? Date.now() - observation.timestamp : null;
        const met = observation ? targetMet(pin.target, observation) : null;

        const { fire, armed } = priceTargetReached({
            armed: state.armed,
            met,
            priceAgeMs,
            maxPriceAgeMs: marketAPI.CACHE_DURATION,
        });
        if (!fire) {
            state.armed = armed;
            return;
        }

        // The pin's own record of the target's life. Written here rather than
        // where the chip lights up, because this is the only place that knows
        // the reach happened at a *dated* moment — the aftermath is measured
        // forward from it, and a moment that is only approximately known makes
        // the reading only approximately about anything. Storage only; nothing
        // about the notification depends on it landing.
        noteWatchedTargetReached(pin.key, { at: observation.timestamp, price: observation });

        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${pin.key}:${signature}:${state.generation}`,
            this.buildMessage(pin, observation, priceAgeMs),
            {
                title: 'Price target reached',
                // Delivery metadata, not a change of mind about what is worth
                // saying: it is what lets a digest name the items it counted
                subject: pin.name,
            }
        );

        // Disarmed only once the notice actually reached the player, exactly as
        // the undercut alert disarms its own bit: a target reached while nothing
        // was there to say so — no toast host mounted yet, most likely — must
        // stay retryable rather than going quiet until the price crosses back
        // and forth again, which for a target the market never revisits is never.
        if (result?.fired) state.armed = armed;
    }

    /**
     * The message, carrying the price that crossed and the sighting's true age.
     *
     * The age is the honesty clause, as it is in the undercut alert. A sighting
     * can be a quarter of an hour old and the pool updates on the community's
     * trading rather than on a clock, so "ask now 4.1M" without saying *when*
     * would claim a currency the figure does not have.
     *
     * @param {Object} pin - The pin whose target was reached
     * @param {Object} observation - The sighting that reached it
     * @param {number} priceAgeMs - How old that sighting is
     * @returns {string} What to tell the player
     */
    buildMessage(pin, observation, priceAgeMs) {
        const side = pin.target.side;
        const value = side === 'bid' ? observation.bid : observation.ask;
        const age = priceAgeMs < 60000 ? 'seen just now' : `seen ~${formatRelativeTime(priceAgeMs)} ago`;

        return (
            `${pin.name} hit your target (${describeTarget(pin.target)}): ` +
            `${side} ${formatKMB3Digits(value)} (${age}).`
        );
    }

    /**
     * Cleanup
     */
    disable() {
        unregisterCommand('Refresh watchlist prices');

        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        // The armed bits go with the listeners. Keeping them would mean a
        // re-enable — or a character switch, which comes through here — silently
        // inheriting another character's idea of what had already been announced,
        // and another character's watchlist is not this one's.
        this.targetStates.clear();
        this.observations.clear();
        this.timers.clearAll();
        this.refreshInFlight = false;
        this.isInitialized = false;
    }
}

const priceTargetAlerts = new PriceTargetAlerts();

export default priceTargetAlerts;
