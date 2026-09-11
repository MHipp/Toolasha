/**
 * Recording a trial while it happens, without being asked twice.
 *
 * Everything the trials feature knows is already captured as it goes — samples
 * off the panel, loadouts off the socket, damage off the battle feed. What was
 * missing is a *session*: a start, an end, and the series in between, kept
 * somewhere that survives a reload, so that after the hour is over there is
 * something to look at rather than only whatever the last render happened to
 * hold.
 *
 * ## Starting without a button
 *
 * A trial does not announce itself on the socket, so the start is inferred from
 * the two things that only happen during one, either of which is enough:
 *
 * - **A trial fight.** `guild-trial-damage.js` arms when a battle can be shown
 *   to be this week's trial encounter, and that gate is deliberately narrow.
 * - **A reading off the In Progress tab.** A tile sample with a bar on it means
 *   a trial is running and the player is looking at it.
 *
 * Polled rather than pushed for the first of those, so the damage module keeps
 * knowing nothing about this one and the dependency stays one-way.
 *
 * ## Ending without a button either
 *
 * A trial runs for an hour of active time, so a session that has seen nothing
 * for {@link IDLE_STOP_MS} or has run past {@link TRIAL_ACTIVE_MS} is over. Both
 * are recorded as the reason it ended, because "it stopped by itself" and "you
 * stopped it" are different claims about the data.
 *
 * ## What a snapshot is
 *
 * The per-player breakdown as it stood, thinned to the fields a later reading
 * wants — a full breakdown every fifteen seconds for an hour would be a
 * megabyte of repeated names. The snapshots are what make a *rate over time*
 * recoverable after the fact; the final breakdown alone cannot say whether the
 * healer was carrying the first half or the second.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import guildTrialDamage, { compareTrialStats } from './guild-trial-damage.js';
import guildTrialSkilling from './guild-trial-skilling.js';
import guildTrialStatsModal from './guild-trial-stats-modal.js';
import guildTrialTrace from './guild-trial-trace.js';
import guildTrialAbilities from './guild-trial-abilities.js';
import { loadLoadouts } from './guild-loadouts.js';
import { supportCoverage } from './guild-trial-support.js';
import guildMemberSkills from './guild-member-skills.js';
import { TRIAL_ACTIVE_MS, trialWeekStart } from './guild-trials-math.js';
import { loadTrialRecord } from './guild-trials-store.js';
import { recordFinishedTrial, signupParticipation } from './guild-trial-ledger.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import { scriptVersion } from '../../utils/script-version.js';

/** Object store sessions live in — shared with the rest of the guild history */
const STORE_NAME = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
const KEY_PREFIX = 'guildTrialSession';

/** How often the recorder looks at the trial and takes a snapshot */
export const SNAPSHOT_MS = 15_000;

/** Nothing seen for this long and the trial is over */
export const IDLE_STOP_MS = 10 * 60_000;

/** An hour of snapshots at one every fifteen seconds is 240; this is the ceiling */
export const MAX_SNAPSHOTS = 400;

/**
 * Longest a session somebody pressed Record for is left running.
 *
 * Not a rule about trials — a cycle is two of them and takes a couple of hours —
 * but a backstop against a session left open for a week by somebody who forgot.
 * The user's hand is what stops a manual session; this is only there so that
 * "forever" is not a state the recorder can be in.
 */
export const MANUAL_MAX_MS = 6 * 60 * 60 * 1000;

/** A silence longer than this, while recording, is noted as a gap in the data */
export const GAP_AFTER_MS = 3 * SNAPSHOT_MS;

/**
 * Storage key for a guild's most recent session.
 *
 * Falls back to the character rather than to one shared bucket, for the reason
 * `guildTrialsStorageKey` spells out: two characters in one tab must not read
 * each other's trials back.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @returns {string} Storage key
 */
export function trialSessionStorageKey(guildName, characterId = null) {
    if (guildName) return `${KEY_PREFIX}_${guildName}`;
    return characterId === null || characterId === undefined
        ? `${KEY_PREFIX}_default`
        : `${KEY_PREFIX}_char_${characterId}`;
}

/**
 * A breakdown thinned to what a session wants to keep every fifteen seconds.
 *
 * Pure, and exported because it is the only part of a session with a decision in
 * it: what is worth a quarter of a minute of storage and what is not.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {number} at - When it was taken
 * @returns {Object} A snapshot
 */
export function thinBreakdown(breakdown, at) {
    const support = breakdown?.support?.players || [];
    const supportOf = (index) => support.find((row) => row.index === index) || null;

    return {
        t: at,
        seconds: breakdown?.seconds ?? 0,
        fights: breakdown?.fights ?? 0,
        totalDamage: breakdown?.totalDamage ?? 0,
        partyDps: breakdown?.partyDps ?? null,
        players: (breakdown?.players || []).map((player) => {
            const row = supportOf(player.index);
            // Every figure below is cumulative for the session, as the live
            // breakdown keeps it — a snapshot is a reading of the totals, so a
            // reader diffs consecutive snapshots and never sums them.
            // `castsByAbility` is deliberately not kept: a map per player per
            // fifteen seconds is the storage this thinning exists to avoid.
            return {
                index: player.index,
                name: player.name,
                damage: player.damage,
                deaths: player.deaths,
                healingDone: row?.healingDone ?? 0,
                damageTaken: row?.damageTaken ?? 0,
                manaSpent: row?.manaSpent ?? 0,
                manaRestored: row?.manaRestored ?? 0,
                manaOuts: row?.manaOuts ?? 0,
                emptyManaMs: row?.emptyManaMs ?? 0,
                outOfMana: row?.outOfMana ?? false,
                lowManaOuts: row?.lowManaOuts ?? 0,
                lowManaMs: row?.lowManaMs ?? 0,
                starvedOuts: row?.starvedOuts ?? 0,
                starvedMs: row?.starvedMs ?? 0,
                lowestHealthFraction: row?.lowestHealthFraction ?? null,
                casts: row?.casts ?? 0,
                healCasts: row?.healCasts ?? 0,
                buffCasts: row?.buffCasts ?? 0,
            };
        }),
    };
}

class GuildTrialRecorder {
    constructor() {
        this.initialized = false;
        this.timers = createTimerRegistry();
        this.watcherId = null;
        this.session = null;
        this.guildName = null;
        this.characterId = null;
        /** Last moment anything said a trial was happening */
        this.lastActivityAt = 0;
        /** Where the guild panel says the cycle is; null until one has been read */
        this.phase = null;
    }

    /**
     * Start watching for a trial to begin.
     * @param {string|null} guildName - The key sessions are stored under
     */
    initialize(guildName = null) {
        this.guildName = guildName;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (this.initialized) return;
        this.initialized = true;

        this.watcherId = setInterval(() => this._tick(), SNAPSHOT_MS);
        this.timers.registerInterval(this.watcherId, 'guildTrialRecorder.tick');
    }

    cleanup() {
        this.timers.clearAll();
        this.watcherId = null;
        this.initialized = false;
    }

    /**
     * @param {string|null} guildName - The key sessions are stored under
     *
     * A name arriving over a *different* name is a guild change, and the open
     * session was recorded inside the guild being left. `_persist` resolves
     * `trialSessionStorageKey(this.guildName, …)` afresh on every write, so
     * keeping the session would file the departed guild's snapshots under
     * `guildTrialSession_<new guild>`. Adopting a name over `null` is the
     * ordinary lazy adoption and keeps the session, which was recorded in this
     * guild before its name arrived.
     */
    setGuildName(guildName) {
        const next = guildName || null;
        if (this.guildName && next && this.guildName !== next) this.forget();
        this.guildName = next;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
    }

    /**
     * Forget this character's session entirely.
     *
     * Called when the tab changes character: a session belongs to the character
     * that recorded it, and carrying one across would file the next guild's
     * trial under the last one's snapshots.
     *
     * A session still recording is closed out first, exactly as {@link restart}
     * already does before starting a fresh one. Dropping it here instead —
     * `this.session = null` with no `stop()` — left the persisted copy with
     * `endedAt: null` forever, reading as a trial still running long after the
     * character that recorded it was gone, and skipped `_accrue()` outright: a
     * trial cut short by a character switch never reached the attendance
     * ledger at all.
     */
    forget() {
        if (this.recording) this.stop('character switched');
        this.session = null;
        this.lastActivityAt = 0;
        this.phase = null;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
    }

    /** @returns {boolean} Whether a session is open */
    get recording() {
        return Boolean(this.session && !this.session.endedAt);
    }

    /**
     * Begin a session.
     *
     * Idempotent: the two auto-start signals routinely arrive together, and the
     * button is a third.
     *
     * @param {string} reason - What started it, for the export
     * @param {number} [at] - Clock
     * @returns {Object|null} The session
     */
    start(reason, at = Date.now()) {
        if (this.recording) return this.session;

        this.session = {
            startedAt: at,
            endedAt: null,
            startedBy: reason,
            endedBy: null,
            weekStart: trialWeekStart(at),
            characterId: dataManager.getCurrentCharacterId?.() ?? null,
            snapshots: [],
        };
        this.lastActivityAt = at;
        this._snapshot(at);
        return this.session;
    }

    /**
     * End the session and write it down.
     * @param {string} reason - What ended it
     * @param {number} [at] - Clock
     * @returns {Object|null} The finished session
     */
    stop(reason, at = Date.now()) {
        if (!this.session) return null;
        if (!this.session.endedAt) {
            this._snapshot(at);
            this.session.endedAt = at;
            this.session.endedBy = reason;
            this._persist();
            this._accrue();
        }
        return this.session;
    }

    /**
     * Fold the finished session into the long-lived attendance ledger.
     *
     * The archive in `guild-trials-store.js` keeps four cycles; the ledger keeps
     * half a year of one small row per member, and this is the only moment it is
     * ever written. Idempotent on the session's own start time, so a manual stop
     * racing the watcher's cannot count the hour twice.
     *
     * Not awaited by `stop`, and `async` so that its own `catch` covers a
     * rejection as well as a throw: every failure here is the ledger's own, and
     * a table with a hole in it must never be the reason a recording fails to be
     * saved — nor an unhandled rejection on the page.
     *
     * @returns {Promise<void>}
     * @private
     */
    async _accrue() {
        try {
            // The ledger is its own setting, and a player who switched it off
            // was switching off the record, not merely the panel that reads it.
            // Writing half a year of per-member rows for somebody who asked for
            // none is the one thing the setting exists to prevent
            if (!config.getSetting('guildTrialLedger')) return;

            const breakdown = guildTrialDamage.breakdown?.() || {};
            await recordFinishedTrial({
                session: this.session,
                guildName: this.guildName,
                characterId: this.characterId,
                encounter: breakdown.encounter ?? null,
                tier: breakdown.tier ?? null,
                roster: Object.values(breakdown.roster || {})
                    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
                    .filter((name) => typeof name === 'string' && name),
                participants: breakdown.participants ?? null,
                participation: this._participation(breakdown),
            });
        } catch (error) {
            console.error('[GuildTrialRecorder] Folding the session into the ledger failed:', error);
        }
    }

    /**
     * Who took part in the cycle's trials, including the ones nobody watched.
     *
     * A cycle runs several trials at once and this client can spectate one of
     * them, so the fight that just ended says nothing whatsoever about the
     * members of the others. Two sources do, and neither needs a tab open:
     *
     * - **The sign-up sheet**, off every guild character's
     *   `signedUpSkillingTrialHrid` / `signedUpCombatTrialHrid`, which the XP
     *   tracker keeps current for the whole guild. Signing up *is* taking part:
     *   the game auto-places a signed-up character into their trial's fight.
     * - **The server's own end-of-trial stats**, per encounter, as
     *   `guild-trial-damage.js` stored them — every combat trial the message
     *   carried, the fights nobody here watched included, so the other boss
     *   fight's roster lands here off the wire alone.
     *
     * Missing sources are simply absent rather than empty: an empty roster
     * would claim the trial had nobody in it, which is the accusation this
     * whole path exists to stop making.
     *
     * @param {Object} breakdown - `guildTrialDamage.breakdown()`
     * @returns {Object|null} Trial key → roster, or null when nothing states one
     * @private
     */
    _participation(breakdown) {
        try {
            const at = Date.now();
            const participation = signupParticipation(guildXPTracker.getMemberList?.() || [], {
                currentWeek: guildXPTracker.getCurrentWeekStartAt?.() || null,
                at,
            });

            // The stored stats deliberately outlive the weekly reset in memory
            // (the cycle archive is their last reader) — but a stale week's
            // roster folded into this cycle would settle attendance off last
            // week's fight, so only entries stamped inside this session's own
            // trial week count here.
            const week = Number.isFinite(this.session?.weekStart) ? this.session.weekStart : trialWeekStart(at);
            for (const [encounter, entry] of Object.entries(breakdown?.storedStats || {})) {
                const names = Object.keys(entry?.reported || {});
                if (!encounter || !names.length) continue;
                if (!Number.isFinite(entry?.at) || trialWeekStart(entry.at) !== week) continue;
                // The server's figures beat a sign-up sheet for the trial they
                // cover: they are what the trial actually credited. They are
                // joined by display name, though, and an id nothing could name
                // any more — a member renamed or gone from the guild by the
                // time the stats landed — is silently missing from them. A
                // signed-up member took part either way (the game auto-places
                // them), so the sheet's names are kept alongside rather than
                // replaced: dropping them would settle a credited member as
                // absent.
                const signed = participation[encounter]?.names || [];
                const combined = [...names];
                for (const name of signed) {
                    if (!combined.some((held) => held.toLowerCase() === name.toLowerCase())) combined.push(name);
                }
                participation[encounter] = { names: combined, source: 'stats', at };
            }

            return Object.keys(participation).length ? participation : null;
        } catch (error) {
            console.error('[GuildTrialRecorder] Reading the cycle’s participation failed:', error);
            return null;
        }
    }

    /**
     * Throw the session away and begin a fresh one.
     *
     * The panel's "end and start a new record" is this, and it is one gesture
     * rather than two so that the pair cannot be left half-done.
     *
     * @param {number} [at] - Clock
     * @returns {Object|null} The new session
     */
    restart(at = Date.now()) {
        this.stop('restarted', at);
        this.session = null;
        guildTrialDamage.reset();
        return this.start('button', at);
    }

    /**
     * Something happened that only happens during a trial.
     * @param {string} kind - What was seen, for the export
     * @param {number} [at] - Clock
     */
    noteActivity(kind, at = Date.now()) {
        this.lastActivityAt = at;

        // Something is happening, so whatever the panel last said about the
        // cycle is out of date. Cleared rather than set to `live`: this module
        // does not read the page and will not claim to. Leaving a stale
        // `completed` here is what would make a session start and be stopped by
        // the watcher on the same tick, forever — which is exactly the gap
        // between a skilling hour ending and the combat hour beginning.
        this.phase = null;

        if (this.recording) return;
        if (!config.getSetting('guildTrialAutoRecord', true)) return;
        this.start(kind, at);
    }

    /**
     * Where the guild panel says the cycle is.
     *
     * The recorder cannot read the page itself and will not guess. A phase it
     * has never been told is `null`, and `null` is *not* permission to record —
     * which is the bug this exists for: a session was found running on a guild
     * whose weekly trials were not on at all, because "no status seen" was
     * being treated the same as "a trial is live".
     *
     * A cycle is two trials — a skilling hour and then a combat one — and the
     * lull between them reads as `completed` and then `scheduled`. That closes
     * the skilling session, which is right, and it must not stop the *next* one
     * from arming: `noteActivity` clears the phase the moment the combat hour
     * produces a reading or a fight, so the recorder rolls over into it without
     * anybody pressing anything. A session somebody started by hand is not
     * closed at all and simply spans both.
     *
     * @param {string|null} phase - `scheduled`, `live`, `completed` or null
     * @param {number} [at] - Clock
     */
    noteLifecycle(phase, at = Date.now()) {
        this.phase = phase || null;
        if (!this.recording) return;

        // A session somebody pressed Record for is theirs to stop
        if (this.session?.startedBy === 'button') return;
        if (this.phase && this.phase !== 'live') this.stop(`the trial is ${this.phase}`, at);
    }

    /** The watcher: arm on a trial fight, snapshot while recording, stop when it is over */
    _tick() {
        try {
            const now = Date.now();
            const breakdown = guildTrialDamage.breakdown?.();
            // A fight the damage gate has armed is a trial by the gate's own
            // narrow test, which is evidence enough on its own
            if (breakdown?.active) this.noteActivity('trial-fight', now);

            if (!this.recording) return;

            this._snapshot(now);

            const automatic = this.session.startedBy !== 'button';

            // Silence is not evidence of anything. Readings only arrive while the
            // guild panel is open, so a player who closes it to go and forage
            // starves the recorder — and the ten-minute rule then stopped the
            // session they had started by hand, mid-trial, which is what was
            // reported. A gap in the data is a gap in the data; it is written
            // down rather than acted on.
            const quietFor = now - this.lastActivityAt;
            if (quietFor > GAP_AFTER_MS) this._noteGap(now, quietFor);

            // A session somebody pressed Record for stops when they say so. The
            // rules below are for the ones that armed themselves.
            const ranLong = now - this.session.startedAt > (automatic ? TRIAL_ACTIVE_MS : MANUAL_MAX_MS);
            // …and even then, not while the panel says a trial is running: an
            // open trial with a shut panel is still an open trial
            const wentQuiet = automatic && this.phase !== 'live' && quietFor > IDLE_STOP_MS;
            const notRunning = automatic && !breakdown?.active && this.phase && this.phase !== 'live';

            if (ranLong || wentQuiet || notRunning) {
                this.stop(
                    ranLong
                        ? automatic
                            ? 'the hour a trial runs for elapsed'
                            : 'left recording for six hours'
                        : notRunning
                          ? `the trial is ${this.phase}`
                          : 'nothing seen',
                    now
                );
            } else this._persist();
        } catch (error) {
            console.error('[GuildTrialRecorder] Watching the trial failed:', error);
        }
    }

    /**
     * Write down that the data stopped arriving for a while.
     *
     * Expected rather than exceptional: nothing reaches this recorder while the
     * guild panel is shut, so a session that spans somebody going off to do
     * something else *will* have holes in it. A reader of the export should be
     * able to see where they are rather than reading a flat stretch as a trial
     * where nothing happened.
     *
     * @param {number} at - Clock
     * @param {number} quietFor - How long the silence has lasted
     */
    _noteGap(at, quietFor) {
        if (!this.session) return;
        const gaps = (this.session.gaps ||= []);
        const last = gaps[gaps.length - 1];

        // One gap, extended, rather than one per tick of the same silence
        if (last && at - last.to <= SNAPSHOT_MS * 2) {
            last.to = at;
            last.ms = last.to - last.from;
            return;
        }
        gaps.push({ from: at - quietFor, to: at, ms: quietFor });
        if (gaps.length > 50) gaps.shift();
    }

    /**
     * Take one snapshot, if there is anything in it worth keeping.
     * @param {number} at - Clock
     */
    _snapshot(at) {
        if (!this.session) return;

        const breakdown = guildTrialDamage.breakdown?.();
        if (!breakdown?.players?.length) return;

        const snapshot = thinBreakdown(breakdown, at);
        const previous = this.session.snapshots[this.session.snapshots.length - 1];
        // A trial nobody is fighting produces the same snapshot forever, and a
        // series of identical readings is not a series
        if (previous && previous.totalDamage === snapshot.totalDamage && previous.seconds === snapshot.seconds) return;

        this.session.snapshots.push(snapshot);
        if (this.session.snapshots.length > MAX_SNAPSHOTS) this.session.snapshots.shift();
    }

    /** Write the session down; not awaited by callers on the render path */
    async _persist() {
        try {
            if (!this.session) return;
            await storage.set(trialSessionStorageKey(this.guildName, this.characterId), this.session, STORE_NAME);
        } catch (error) {
            console.error('[GuildTrialRecorder] Saving the session failed:', error);
        }
    }

    /**
     * The session in hand, or the last one written down.
     * @returns {Promise<Object|null>} A session
     */
    async loadSession() {
        if (this.session) return this.session;
        try {
            return await storage.get(trialSessionStorageKey(this.guildName, this.characterId), STORE_NAME, null);
        } catch (error) {
            console.error('[GuildTrialRecorder] Reading the session failed:', error);
            return null;
        }
    }
}

const guildTrialRecorder = new GuildTrialRecorder();

/**
 * Everything the trials feature knows right now, as one object.
 *
 * The single builder behind both the console helper and the panel's download
 * button — the two used to be one function in the chat commands file, which is
 * where a button could not reach it.
 *
 * Additive only: every field the previous export had is still here under the
 * same name, so a bundle saved by an older build and one saved by this one can
 * be read by the same reader.
 *
 * @param {Object} [options] - Injectables, for tests
 * @param {string|null} [options.guildName] - The key the record is stored under
 * @returns {Promise<Object>} The bundle
 */
export async function buildTrialExport({ guildName = null } = {}) {
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    const record = await loadTrialRecord(guildName, Date.now(), characterId);
    const loadouts = characterId ? await loadLoadouts(characterId) : null;
    const trialDamage = guildTrialDamage.breakdown?.() ?? null;
    const session = await guildTrialRecorder.loadSession();
    const host = typeof location !== 'undefined' ? location.hostname || null : null;

    return {
        // Which reader this bundle is for, which script produced it, and
        // against which server — live and test do not share balance
        format: 'toolasha-guild-trial',
        version: 1,
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        exportedAt: new Date().toISOString(),
        guildName,
        characterId,
        record,
        loadouts,
        trialDamage,
        // New, and additive: the session the recorder kept, a statement of what
        // the battle feed can and cannot say about a player, and the members'
        // skill levels the profile cycler has collected — which is the only
        // source a skilling trial's forecast has
        session,
        coverage: supportCoverage(),
        memberSkills: guildMemberSkills.all?.() ?? {},
        // What the socket said about the skilling half — the pool, the tier, the
        // participants and the per-tier personal figures, none of which needed a
        // tab to be open
        trialSkilling: guildTrialSkilling.snapshot?.() ?? null,
        // The game's own post-trial Stats modal, per combat trial, where it has
        // been opened — the authoritative per-member damage/healing/damage-taken
        trialStatsModal: guildTrialStatsModal.snapshot?.() ?? {},
        // The game's own end-of-trial stats off the wire (`guild_trial_stats_updated`)
        // paired with the live measurement, per player: what we measured vs what
        // the server credited, and how far apart. Survives a refresh for the week.
        statsComparison: compareTrialStats({
            reported: trialDamage?.reported,
            measured: trialDamage?.reportedMeasured,
        }),
        // Pairs this bundle with the opt-in raw diagnostic trace recorded
        // alongside it — the trace file carries the same id. Null when none.
        traceId: guildTrialTrace.activeTraceId?.() ?? null,
        // Coverage-aware: a partial session lists unknownAuras, never missingAuras
        trialAbilities: guildTrialAbilities.exportSnapshot?.() ?? null,
    };
}

/**
 * Whether a bundle has nothing in it worth keeping.
 *
 * `buildTrialExport` never refuses: it always returns a well-formed bundle, and
 * a week with nothing in it comes back as a fresh empty record and a null
 * session rather than as an error. That is right for the file — a reader can
 * tell "we recorded nothing" from a bundle and cannot tell it from a missing
 * one — but it means a caller wanting to *say* whether there was anything has
 * to look. Three sources, because a week can have any one of them without the
 * others: a recorder session, the ladder's per-tile samples, and the finished
 * trials in its history.
 *
 * @param {Object} bundle - From {@link buildTrialExport}
 * @returns {boolean} Whether nothing at all was recorded this week
 */
export function trialExportIsEmpty(bundle) {
    if (bundle?.session) return false;
    const record = bundle?.record;
    if (!record) return true;
    if (Object.keys(record.tiles || {}).length) return false;
    return !(record.history || []).length;
}

/**
 * Download a bundle as a file.
 *
 * Returns the name it was saved under rather than a bare `true`, because a
 * caller that wants to tell the player where the file went cannot recompute it:
 * the timestamp is taken here, and a second `new Date()` outside would differ.
 *
 * @param {Object} bundle - From {@link buildTrialExport}
 * @returns {string|null} The filename the download was started under, or null when it failed
 */
export function downloadTrialExport(bundle) {
    try {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const filename = `toolasha-trial-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        return filename;
    } catch (error) {
        console.error('[GuildTrialRecorder] Trial export download failed (data still returned):', error);
        return null;
    }
}

export default guildTrialRecorder;
export { guildTrialRecorder };
