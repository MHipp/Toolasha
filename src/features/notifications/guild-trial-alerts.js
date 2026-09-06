/**
 * Guild trial alerts
 *
 * Two moments in a trial week are worth interrupting somebody for, and both of
 * them are moments the player cannot see coming from inside the game: a trial
 * they signed up for is about to start, and the one they were in has finished
 * and paid out.
 *
 * ## Where the times come from
 *
 * Not from a socket message — there isn't one. The guild panel states the cycle
 * in words at the top of its trial tabs ("Scheduled Wed 04:00 PM 2h 24m",
 * "Completed Thu 09:00 AM"), and `guild-trials-scrape.js` reads it. So this
 * module is *pushed to* by the trials feature rather than watching anything
 * itself, which keeps the dependency running one way — a notifications module
 * that imported the guild feature would be a cycle, and the guild feature
 * already imports this one.
 *
 * The panel only reports its countdown while it is open, but the starting alert
 * does not need it open at the moment of firing: the first scheduled reading
 * fixes the start as an absolute instant (**seen time + time-till-start**) and a
 * timer is armed for the lead moment against that instant, so closing the panel
 * afterwards does not silence the warning. A player who never opens the panel
 * during a cycle still gets nothing — there is no schedule to anchor to until it
 * has been seen once — but one glimpse is enough, where before the panel had to
 * be open across the whole lead window.
 *
 * ## Re-arming
 *
 * Keyed by the phase transition rather than by a timestamp: the same cycle
 * cannot announce its own start twice, and the next cycle is a different
 * transition. The service's own cooldown catches anything this misses.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { timeReadable } from '../../utils/formatters.js';

/** Master switch for the "a trial is about to start" alert */
export const START_SETTING = 'notifications_trialStarting';

/** Master switch for the "the trial finished" alert */
export const RESULTS_SETTING = 'notifications_trialResults';

/** How many minutes before the start to speak up */
export const LEAD_MINUTES_SETTING = 'notifications_trialStartLeadMinutes';

/** Bounds the lead time to the range the settings control offers */
export const MIN_LEAD_MINUTES = 1;
export const MAX_LEAD_MINUTES = 120;
export const DEFAULT_LEAD_MINUTES = 10;

/** Event key prefixes, so the service's cooldown can tell the two apart */
const START_KEY = 'guild-trial-start';
const RESULTS_KEY = 'guild-trial-results';

/**
 * The line the game puts in guild chat when a cycle begins.
 *
 * The best start signal there is, and the only one that works with the guild
 * panel shut: chat arrives over the socket whatever page the player is looking
 * at, where the panel's own status is read only while somebody is looking at it.
 * Matched loosely — the words rather than the exact sentence — so a full stop
 * moving does not silence the alert.
 */
const STARTED_PATTERN = /guild\s+trials?\b.*\bbegun|\bhave\s+begun\b.*\btrials?\b|trials?\s+have\s+started/i;

/**
 * The lead time, clamped to what the setting offers.
 * @param {Function} [read] - Settings reader, injectable for tests
 * @returns {number} Minutes
 */
export function leadMinutes(read) {
    const get = read || ((key, fallback) => config.getSettingValue?.(key, fallback) ?? fallback);
    const value = Number(get(LEAD_MINUTES_SETTING, DEFAULT_LEAD_MINUTES));
    if (!Number.isFinite(value)) return DEFAULT_LEAD_MINUTES;
    return Math.min(MAX_LEAD_MINUTES, Math.max(MIN_LEAD_MINUTES, value));
}

/**
 * What the results alert says.
 *
 * Built from the payout the panel has already worked out rather than from a
 * second calculation, so the number in the notification is the number on the
 * screen. Tokens are included because they are the part a player acts on — the
 * points are the guild's, the tokens are theirs.
 *
 * @param {Object} payout - `{guildPoints, eligibleTokens, participantTokens}`
 * @returns {string} The message
 */
export function resultsMessage(payout) {
    const round = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : null);
    const points = round(payout?.guildPoints);
    const eligible = round(payout?.eligibleTokens);
    const participant = round(payout?.participantTokens);

    const parts = [];
    if (points) parts.push(`${points} Guild Points`);
    if (eligible) parts.push(`${eligible} tokens for every eligible member`);
    if (participant && participant !== eligible) parts.push(`${participant} if you took part`);

    if (!parts.length) return 'The guild trial has finished.';
    return `Guild trial finished — ${parts.join(', ')}.`;
}

class GuildTrialAlerts {
    constructor() {
        /** Whether the chat listener is attached */
        this.initialized = false;
        /** The phase last seen, so a transition can be told from a redraw */
        this.phase = null;
        /** The phase this announced a start for, so it announces it once */
        this.announcedStartFor = null;
        /** Trials named in the cycle now scheduled or running */
        this.trials = [];
        /** The payout at the last live reading, for the results alert */
        this.lastPayout = null;
        /** Start instant currently armed (rounded to the minute), so a re-read does not re-arm */
        this.scheduledFor = null;
        /** The pending start-timer id, so it can be cleared and not double-armed */
        this.startTimerId = null;
        this.timers = createTimerRegistry();
    }

    /**
     * Listen to guild chat for the line that says a cycle has begun.
     *
     * Attached here rather than in the guild feature so the alert works with the
     * guild page closed, which is the whole point of preferring this signal.
     */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        this.onChat = (data) => this.noteChatLine(data?.message?.m || data?.message?.message || '');
        webSocketHook.on('chat_message_received', this.onChat);
    }

    cleanup() {
        if (this.onChat) webSocketHook.off('chat_message_received', this.onChat);
        this.onChat = null;
        this.initialized = false;
        this._clearStartTimer();
    }

    /**
     * A chat line arrived.
     *
     * @param {string} text - What it said
     * @returns {Object|null} The service's result, when this was the line
     */
    noteChatLine(text) {
        if (!STARTED_PATTERN.test(String(text || ''))) return null;

        // The game has said it outright, so this is the start whatever the panel
        // last reported — and the phase is moved on so the panel agreeing a
        // moment later does not announce it twice. A pending "starts soon" timer
        // is now moot, so it is dropped rather than left to fire after the fact
        this.phase = 'live';
        this._clearStartTimer();
        return this._announceStarted('chat');
    }

    /** Forget everything; used on a character switch and by tests */
    reset() {
        this.phase = null;
        this.announcedStartFor = null;
        this.trials = [];
        this.lastPayout = null;
        this._clearStartTimer();
    }

    /**
     * The payout as the panel currently computes it.
     *
     * Kept as it goes past, because by the time the cycle reads "Completed" the
     * cards have been zeroed and the figure is gone — the results alert would
     * have nothing to report if it waited until then to ask.
     *
     * @param {Object} payout - `{guildPoints, eligibleTokens, participantTokens}`
     */
    notePayout(payout) {
        if (!payout) return;
        if (Number.isFinite(payout.guildPoints) && payout.guildPoints > 0) this.lastPayout = { ...payout };
    }

    /**
     * Where the cycle is, from the guild panel.
     *
     * @param {Object} status - `{phase, startsInMs, trials, at}`
     * @returns {Object|null} What was announced, for tests
     */
    noteTrialStatus({ phase = null, startsInMs = null, trials = [], at = Date.now() } = {}) {
        try {
            if (Array.isArray(trials) && trials.length) this.trials = trials;

            const previous = this.phase;
            if (phase) this.phase = phase;

            if (phase === 'scheduled') return this._maybeAnnounceStart(startsInMs, at);
            if (phase === 'live' && previous === 'scheduled') {
                this._clearStartTimer();
                return this._announceStarted();
            }
            if (phase === 'completed' && previous && previous !== 'completed') {
                this._clearStartTimer();
                return this._announceResults();
            }
            return null;
        } catch (error) {
            console.error('[GuildTrialAlerts] Reading the trial status failed:', error);
            return null;
        }
    }

    /**
     * A scheduled reading came in.
     *
     * The countdown is turned into an absolute start instant — seen time plus
     * time-till-start — which is what the lead-moment timer is armed against, so
     * the warning still fires if the panel is shut before the lead time arrives.
     * The immediate check stays too, for the case where the very first reading is
     * already inside the lead window.
     *
     * @param {number|null} startsInMs - From the panel's own countdown
     * @param {number} at - Clock at the reading
     * @returns {Object|null} The service's result, when it announced now
     */
    _maybeAnnounceStart(startsInMs, at) {
        if (!config.getSetting(START_SETTING, false)) return null;
        if (!Number.isFinite(startsInMs) || startsInMs <= 0) return null;

        const startAt = at + startsInMs;
        this._armStartTimer(startAt);
        return this._announceStartSoon(startAt, at);
    }

    /**
     * Arm a one-shot timer for the lead moment of a known start instant.
     *
     * Keyed on the start rounded to the minute: the countdown is re-read every
     * few seconds while the panel is open, and re-arming on each reading would be
     * churn for the same instant. A start already inside the lead window (or past
     * it) needs no timer — `_announceStartSoon` speaks for it synchronously.
     *
     * @param {number} startAt - Absolute start instant, ms
     */
    _armStartTimer(startAt) {
        const key = Math.round(startAt / 60_000);
        if (this.scheduledFor === key && this.startTimerId) return;

        const fireAt = startAt - leadMinutes() * 60_000;
        const delay = fireAt - Date.now();
        if (delay <= 0) return;

        this._clearStartTimer();
        this.scheduledFor = key;
        this.startTimerId = setTimeout(() => {
            this.startTimerId = null;
            this.scheduledFor = null;
            // The chat line or a live reading may have moved the cycle on while
            // the timer waited; a "starts soon" after it has started is noise
            if (this.phase && this.phase !== 'scheduled') return;
            this._announceStartSoon(startAt, Date.now());
        }, delay);
        this.timers.registerTimeout(this.startTimerId);
    }

    /** Drop any pending start timer. */
    _clearStartTimer() {
        if (this.startTimerId) {
            clearTimeout(this.startTimerId);
            this.startTimerId = null;
        }
        this.scheduledFor = null;
    }

    /**
     * "It starts soon", when the moment is inside the lead time.
     * @param {number} startAt - Absolute start instant, ms
     * @param {number} now - Clock to measure the remaining time against
     * @returns {Object|null} The service's result
     */
    _announceStartSoon(startAt, now) {
        if (!config.getSetting(START_SETTING, false)) return null;

        const remainingMs = startAt - now;
        if (!(remainingMs > 0)) return null;
        if (remainingMs > leadMinutes() * 60_000) return null;

        // One announcement per scheduled cycle, whichever path reaches it. Keyed
        // on the start instant so the synchronous check and the timer agree, and
        // rounded to the minute so a re-derivation a few hundred ms later is the
        // same key rather than a second alert
        const key = `${START_KEY}:${Math.round(startAt / 60_000)}`;
        if (this.announcedStartFor === key) return null;

        // Seconds, not milliseconds: `timeReadable` takes seconds, and handing
        // it a millisecond count turned a ten-minute warning into "6 days 22
        // hours" — the one number in the message the player would act on
        const named = this.trials.length ? ` (${this.trials.join(', ')})` : '';
        const remaining = timeReadable(Math.round(remainingMs / 1000));
        const result = notificationService.notify(key, `Guild trial starts in ${remaining}${named}.`, {
            title: 'Guild trial starting',
        });

        // Marked announced only once it actually reached the player. Setting
        // this before `notify()` ran meant a notice that hit no channel — no
        // browser permission, page not visible, no toast surface yet — was
        // marked told and never retried: the flag said "announced", the player
        // never saw it, and the next reading of the same cycle stayed silent
        // because the key already matched.
        if (result?.fired) this.announcedStartFor = key;
        return result;
    }

    /**
     * "It has started", the moment the panel stops saying scheduled.
     * @returns {Object|null} The service's result
     */
    _announceStarted(source = 'panel') {
        if (!config.getSetting(START_SETTING, false)) return null;

        const named = this.trials.length ? ` — ${this.trials.join(', ')}` : '';
        // One key for both sources, so whichever notices first is the one that
        // speaks and the other is a repeat the service drops
        return notificationService.notify(`${START_KEY}:live`, `The guild trial has started${named}.`, {
            title: 'Guild trial started',
            source,
        });
    }

    /**
     * "It finished, and here is what it paid".
     * @returns {Object|null} The service's result
     */
    _announceResults() {
        if (!config.getSetting(RESULTS_SETTING, false)) return null;

        const result = notificationService.notify(
            `${RESULTS_KEY}:${this.lastPayout?.guildPoints ?? 0}`,
            resultsMessage(this.lastPayout),
            {
                title: 'Guild trial finished',
            }
        );
        this.announcedStartFor = null;
        return result;
    }
}

const guildTrialAlerts = new GuildTrialAlerts();

export default guildTrialAlerts;
export { guildTrialAlerts };
