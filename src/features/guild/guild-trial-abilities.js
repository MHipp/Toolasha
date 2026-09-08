/**
 * Who has shown their kit this trial, and which auras the party actually has.
 *
 * A guild trial runs for an hour with up to fifty participants, and the only
 * source of a member's equipped abilities is their Battle Info popup —
 * captured one click at a time through `guild-loadout-capture.js`. This module
 * keeps the *session*: which participants have produced an authoritative kit
 * this hour, which are still owed a click, and what that means for the party's
 * aura coverage.
 *
 * ## The session and when it resets
 *
 * There is no server trial-session id, so a session is the guild plus an
 * observed start, the same way `guild-trial-recorder.js` models one. The rule
 * is deliberately blunt: a session resets only when
 *
 * - a capture or a live tick arrives more than {@link SESSION_MAX_AGE_MS}
 *   after the session was *last active* (its last tick or capture) — the
 *   trial has been silent for longer than any trial is, so this is the next
 *   one. Measured from the last activity and not from the start, because a
 *   trial is a skilling hour and a combat hour back to back: a session that
 *   began at the skilling whistle is two hours old and still this trial's,
 *   and a clock run from its start wiped the combat roster five minutes in;
 * - {@link GuildTrialAbilities#noteTrialStart} is called for a session older
 *   than {@link TRIAL_START_GRACE_MS} that has also been quiet that long —
 *   the explicit signal, debounced so the two auto-start signals arriving
 *   together cannot wipe a capture in progress, and ignored while the ticks
 *   say the trial it would wipe is still running (skilling hour into combat
 *   hour is one trial, not two);
 * - {@link GuildTrialAbilities#recapture} is called — the button;
 * - the guild changes ({@link GuildTrialAbilities#setGuildName}) — another
 *   guild's captures say nothing about this one's trial.
 *
 * Nothing else resets it. Slot order, tier and wave all change *during* a
 * trial, and a captured player stays captured through every one of them.
 *
 * ## What counts as captured
 *
 * Only a snapshot whose payload itself carried a `combatAbilities` array
 * (`abilitiesAuthoritative === true`, empty array included — an authoritative
 * empty kit is a genuinely empty kit). A stat-only sighting proves the player
 * exists and says nothing about their abilities, so it leaves them outstanding:
 * "abilities unavailable" is a different claim from "no abilities equipped",
 * and coverage must not treat the first as the second.
 *
 * Socket-free on purpose: the roster and the tier are fed in by the caller,
 * captures are fed in as snapshots, and everything downstream of them is pure
 * and testable without a connection.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import guildTrialPlan, { comparePlan } from './guild-trial-plan.js';
import { inferClass, newCastLog, noteCast, WEAPON_PASSIVE_STATS } from '../../utils/class-inference.js';
import { isAuraAbility } from '../../utils/party-lint.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** Object store the session lives in — shared with the rest of the guild history */
export const SESSION_STORE = 'guildHistory';

/** Key prefix; the guild name is appended, as the trial record's key is */
export const SESSION_KEY_PREFIX = 'guildTrialAbilities';

/** A session silent for longer than this belongs to the previous trial */
export const SESSION_MAX_AGE_MS = 65 * 60 * 1000;

/**
 * When a session was last touched by the trial: its last tick or capture, or
 * its start. Older stored sessions predate the field and fall back to the start.
 * @param {Object|null} session
 * @returns {number} Epoch ms, or -Infinity for no session
 */
export function sessionLastActivity(session) {
    if (!session) return -Infinity;
    const last = Number(session.lastActivityAt);
    return Number.isFinite(last) ? Math.max(last, Number(session.startedAt) || 0) : Number(session.startedAt) || 0;
}

/** An explicit trial-start signal younger than this is the same trial starting */
export const TRIAL_START_GRACE_MS = 5 * 60 * 1000;

/**
 * Storage key for a guild's capture session.
 *
 * Falls back to the character rather than to one shared bucket, for the reason
 * `guildTrialsStorageKey` spells out and `trialSessionStorageKey` mirrors: this
 * module initialises before the guild's name is knowable, so every session
 * collected in that window went to `guildTrialAbilities_default` — one bucket
 * two characters in the same tab both read back, handing the alt the mains's
 * captures for a trial it was never in.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback key
 * @returns {string} Storage key
 */
export function sessionStorageKey(guildName, characterId = null) {
    if (guildName) return `${SESSION_KEY_PREFIX}_${guildName}`;
    return characterId === null || characterId === undefined
        ? `${SESSION_KEY_PREFIX}_default`
        : `${SESSION_KEY_PREFIX}_char_${characterId}`;
}

/**
 * The fields of a captured stat sheet that say anything about a role.
 *
 * Kept rather than the whole `combatStats` object because the session is
 * persisted and a sheet is forty numbers, most of which are nobody's business
 * here. `threat` is the tank signal, the style and damage type are the weapon's
 * own answer for a player whose casts have never been streamed — and the
 * weapon passives (pierce, curse, bloom and the rest of
 * `WEAPON_PASSIVE_STATS`) are the weapon *itself* speaking: the sheet's fix
 * for the crossbow wielder whose slotted melee abilities used to tag them
 * Melee. Passives ride flat on the object, in the same keys `inferClass`
 * reads them off a raw `combatStats`.
 *
 * @param {Object|null} stats - `combatDetails.combatStats` from a snapshot
 * @returns {{threat: number, combatStyleHrid: string|null, damageType: string|null}|null}
 */
export function classSheet(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const threat = Number(stats.threat);
    const style = stats.combatStyleHrid || stats.combatStyleHrids?.[0] || null;
    const damageType = stats.damageType || null;

    const passives = {};
    for (const key of WEAPON_PASSIVE_STATS) {
        const value = Number(stats[key]);
        if (Number.isFinite(value) && value > 0) passives[key] = value;
    }

    if (!Number.isFinite(threat) && !style && !damageType && !Object.keys(passives).length) return null;
    return {
        threat: Number.isFinite(threat) ? threat : 0,
        combatStyleHrid: style,
        damageType,
        ...passives,
    };
}

/**
 * The key a player is filed under.
 *
 * `characterId` when the snapshot carries one — the only key a rename or a
 * party-slot reorder cannot move — and the normalized name only when it does
 * not (a modal scrape has no id).
 *
 * @param {{characterId?: string|number|null, name?: string|null}} entry - A snapshot or roster member
 * @returns {string} Stable key
 */
export function playerKey(entry) {
    const id = entry?.characterId;
    if (id !== null && id !== undefined) return `id:${id}`;
    return `name:${String(entry?.name || '')
        .trim()
        .toLowerCase()}`;
}

/**
 * A roster as fed in — names or `{characterId, name}` objects — normalized.
 * @param {Array<string|{characterId?: string|number|null, name?: string}>} list - The participants
 * @returns {Array<{characterId: string|number|null, name: string}>} Deduplicated roster
 */
export function normalizeRoster(list) {
    const roster = [];
    const seen = new Set();
    for (const entry of list || []) {
        const member = typeof entry === 'string' ? { characterId: null, name: entry } : entry;
        const name = String(member?.name || '').trim();
        const characterId = member?.characterId ?? null;
        if (!name && characterId === null) continue;
        const key = playerKey({ characterId, name });
        if (seen.has(key)) continue;
        seen.add(key);
        roster.push({ characterId, name });
    }
    return roster;
}

/**
 * The stored capture for a roster member, if any.
 *
 * Id first, then the name key, then a name match against id-keyed entries —
 * because the roster and the capture do not always both know the id.
 *
 * @param {Object} players - The session's players, keyed by {@link playerKey}
 * @param {{characterId?: string|number|null, name?: string}} member - A roster member
 * @returns {Object|null} The capture entry
 */
export function captureFor(players, member) {
    if (!players || !member) return null;
    if (member.characterId !== null && member.characterId !== undefined) {
        const byId = players[`id:${member.characterId}`];
        if (byId) return byId;
    }
    const wanted = String(member.name || '')
        .trim()
        .toLowerCase();
    if (!wanted) return null;
    const byName = players[`name:${wanted}`];
    if (byName) return byName;
    return Object.values(players).find((entry) => String(entry?.name || '').toLowerCase() === wanted) || null;
}

/**
 * Every aura hrid the game data declares, detected off the ability shape.
 *
 * `isAuraAbility` reads the effect structure the engine itself keys off, so
 * nothing here is a hardcoded list — a new aura in the game data appears in
 * the expected set without a code change.
 *
 * @param {Object} abilityDetailMap - Game data
 * @returns {string[]} Aura hrids
 */
export function expectedAuraHrids(abilityDetailMap = {}) {
    return Object.keys(abilityDetailMap).filter((hrid) => isAuraAbility(abilityDetailMap[hrid]));
}

/**
 * The auras the captured players actually carry, per aura hrid.
 *
 * Only authoritative captures contribute. The highest-level copy names the
 * provider — "highest equipped", never "effective", because nothing here knows
 * which copy would cast. Lower-level copies of the *same* hrid are redundant
 * providers: listed, counted in `duplicateCount`, never double-counted as
 * coverage. Different aura hrids are different auras and never duplicates of
 * each other. A player equipping the same hrid twice counts once, as
 * `duplicateAuraWarnings` counts it.
 *
 * @param {Array<Object>} entries - Captured players (`abilities`, `abilitiesAuthoritative`)
 * @param {Object} abilityDetailMap - Game data
 * @returns {Object} hrid → `{hrid, name, highestLevel, provider, providers, duplicateCount}`
 */
export function aggregateAuras(entries, abilityDetailMap = {}) {
    const auras = {};
    for (const entry of entries || []) {
        if (entry?.abilitiesAuthoritative !== true) continue;
        const seen = new Set();
        for (const ability of entry.abilities || []) {
            const hrid = ability?.hrid;
            if (!hrid || seen.has(hrid)) continue;
            seen.add(hrid);
            const detail = abilityDetailMap[hrid];
            if (!isAuraAbility(detail)) continue;

            const level = Number(ability?.level);
            const slot = (auras[hrid] ||= {
                hrid,
                name: detail?.name || hrid.split('/').pop().replace(/_/g, ' '),
                highestLevel: null,
                provider: null,
                providers: [],
                duplicateCount: 0,
            });
            slot.providers.push({
                name: entry.name || null,
                characterId: entry.characterId ?? null,
                level: Number.isFinite(level) ? level : null,
            });
        }
    }

    for (const slot of Object.values(auras)) {
        slot.providers.sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
        slot.highestLevel = slot.providers[0]?.level ?? null;
        slot.provider = slot.providers[0]?.name ?? null;
        slot.duplicateCount = Math.max(0, slot.providers.length - 1);
    }
    return auras;
}

/**
 * Coverage state per expected aura.
 *
 * `missing` is the strong claim and it is only made when it can be proven:
 * every current participant authoritatively captured and none of them equips
 * the aura. Anything less is `unknown` — a partial capture must never
 * masquerade as proof of absence.
 *
 * @param {Object} auras - From {@link aggregateAuras}, current participants only
 * @param {Object} abilityDetailMap - Game data
 * @param {boolean} allCurrentCaptured - Every current participant has an authoritative capture
 * @returns {Object} hrid → `'covered' | 'unknown' | 'missing'`
 */
export function auraCoverage(auras, abilityDetailMap = {}, allCurrentCaptured = false) {
    const coverage = {};
    for (const hrid of expectedAuraHrids(abilityDetailMap)) {
        if (auras?.[hrid]?.providers?.length) coverage[hrid] = 'covered';
        else coverage[hrid] = allCurrentCaptured ? 'missing' : 'unknown';
    }
    return coverage;
}

/**
 * A stored session as it may be trusted back in.
 *
 * Entries that slipped in from a personal fight's `new_battle` (the local
 * player's own zone kit) are not trial captures — demoted to "needs Battle
 * Info" so the row re-captures from the same source as everyone else.
 *
 * @param {Object} stored - As persisted
 * @returns {Object} A copy, safe to hold
 */
export function sanitizeStoredSession(stored) {
    const session = { ...stored, capturedTiers: [...(stored?.capturedTiers || [])], players: { ...stored?.players } };
    for (const [key, entry] of Object.entries(session.players)) {
        if (entry?.source === 'new_battle') {
            session.players[key] = {
                ...entry,
                abilities: null,
                abilitiesAuthoritative: false,
                capturedAt: null,
                capturedTier: null,
            };
        }
    }
    return session;
}

/**
 * The stored session and the one held in memory, as one session.
 *
 * Called when a storage read lands after the session has already started
 * collecting — a reload mid-trial, or the guild's name arriving and moving the
 * session onto its own key. Both copies are the same trial's whenever they
 * start within the trial hour of each other, and then neither may lose a
 * capture: the live entry wins per player, except that it may not demote an
 * authoritative stored kit to a stat-only sighting, and it may not replace a
 * *newer* authoritative kit with an older one. That last case is a re-capture
 * race rather than a demotion — both sides are equally authoritative — and
 * without a recency check whichever side happened to be passed as `live` won
 * regardless of which was actually read more recently, so a device pulling a
 * stale sync could silently revert a player's corrected kit back to the one
 * it replaced. `capturedAt` is compared for that case only; everything else
 * keeps the plain "live wins" rule. Sessions further apart than the trial
 * hour are different trials and the later one stands alone.
 *
 * @param {Object|null} stored - From storage
 * @param {Object|null} live - Held in memory
 * @returns {Object|null} The session to hold
 */
export function mergeSessions(stored, live) {
    if (!live) return stored;
    if (!stored) return live;
    if (Math.abs(live.startedAt - stored.startedAt) > SESSION_MAX_AGE_MS) {
        return live.startedAt >= stored.startedAt ? live : stored;
    }

    const players = { ...stored.players };
    for (const [key, entry] of Object.entries(live.players || {})) {
        const held = players[key];
        const demotes = held?.abilitiesAuthoritative === true && entry?.abilitiesAuthoritative !== true;
        const bothAuthoritative = held?.abilitiesAuthoritative === true && entry?.abilitiesAuthoritative === true;
        if (bothAuthoritative) {
            const heldAt = Number(held.capturedAt);
            const entryAt = Number(entry.capturedAt);
            if (Number.isFinite(heldAt) && Number.isFinite(entryAt) && heldAt > entryAt) {
                players[key] = held;
                continue;
            }
        }
        players[key] = demotes ? held : entry;
    }
    return {
        ...stored,
        ...live,
        startedAt: Math.min(stored.startedAt, live.startedAt),
        lastActivityAt: Math.max(sessionLastActivity(stored), sessionLastActivity(live)),
        captureTier: stored.captureTier ?? live.captureTier ?? null,
        capturedTiers: [...new Set([...(stored.capturedTiers || []), ...(live.capturedTiers || [])])],
        completedAt: stored.completedAt ?? live.completedAt ?? null,
        players,
    };
}

/**
 * Two devices' stored sessions as one.
 *
 * Two people in the same guild click different participants, and each of their
 * devices holds half the trial's captures — so a whole-key sync write is the
 * data-loss case this registry exists for, and the fold {@link mergeSessions}
 * already performs for two tabs on one machine is exactly the fold two devices
 * need. It carries the rule that matters: the second argument wins per player
 * *except* that it may never demote an authoritative kit to a stat-only
 * sighting. A stat-only sighting proves the player exists and says nothing
 * about their abilities, and letting the fresher device's sighting erase the
 * other's socket-read kit is the bug this module's session fold was written
 * against.
 *
 * Sessions whose starts are further apart than {@link SESSION_MAX_AGE_MS} are
 * two different trials, and the later one stands alone rather than being
 * contaminated by the other's roster — {@link mergeSessions}'s own rule.
 *
 * The persisted `roster` rides beside the session rather than inside it (see
 * `_persist`), and `mergeSessions` therefore does not know about it. Within one
 * trial it is unioned here, because a participant list is the join key for
 * every capture and the device that watched the second half of the hour saw
 * joiners the first never did.
 *
 * @param {Object|null} local - This device's stored session
 * @param {Object|null} incoming - The downloaded session
 * @returns {Object|null} The session to store
 */
export function mergeStoredSessions(local, incoming) {
    if (!local || !Number.isFinite(local.startedAt)) return incoming ?? local ?? null;
    if (!incoming || !Number.isFinite(incoming.startedAt)) return local;

    const merged = mergeSessions(local, incoming);
    if (Math.abs(incoming.startedAt - local.startedAt) > SESSION_MAX_AGE_MS) return merged;
    return { ...merged, roster: normalizeRoster([...(local.roster || []), ...(incoming.roster || [])]) };
}

/*
 * Registered so a cross-device sync PULL combines the session instead of
 * overwriting it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: SESSION_STORE,
    // `guildTrialAbilities_<guild>`, `_default`, and the `_char_<id>` fallback.
    // Neither `guildTrials_` (the trial record) nor `guildTrialAbilityPlan_`
    // (the plan) starts with this prefix, so the three stay disjoint.
    prefix: `${SESSION_KEY_PREFIX}_`,
    merge: mergeStoredSessions,
    label: 'Guild trial ability session',
});

class GuildTrialAbilities {
    constructor() {
        this.initialized = false;
        this.guildName = null;
        /** The viewing character, for the fallback key before the guild's name lands */
        this.characterId = null;
        /** `{startedAt, guildName, captureTier, capturedTiers, completedAt, players}` or null */
        this.session = null;
        /** Current trial participants, fed in by the caller */
        this.roster = [];
        /** Tier as last fed in; stamped onto captures, never subscribed for */
        this.currentTier = null;
        /**
         * Observed casts per player this trial, keyed by lowercased name — the
         * only key the tick stream can offer, since `guild_battle_updated`
         * identifies its units by slot index and nothing else. Live-only and
         * never persisted: it is an inference off a stream, and a stale one
         * read back after a reload would be a claim about a trial that has
         * ended. See `src/utils/class-inference.js`.
         */
        this.casts = {};
    }

    /**
     * Load the persisted session, keeping it as long as it is this guild's.
     *
     * A session older than the trial hour is kept too, deliberately: the panel
     * is asked for *after* a trial at least as often as during one, and the
     * completed roster with its kits and aura coverage is exactly what the
     * asker wants to see — headed as the last trial's, which the panel does
     * off the session's age. It cannot pose as the next trial's: the first
     * capture past {@link SESSION_MAX_AGE_MS} starts a fresh session
     * ({@link recordCapture}), as do {@link noteTrialStart} and the button.
     *
     * The name the orchestrator has at startup is routinely not the real one —
     * it arrives on socket traffic later — so it is adopted only while nothing
     * better is known, and {@link setGuildName} re-reads under the real key
     * when it lands. A read that finishes *after* a capture or a name change
     * merges rather than replaces, because the alternative is what was
     * reported: two Battle Info popups on screen, none of them in the session.
     *
     * @param {string|null} [guildName] - The key the session is stored under
     * @returns {Promise<void>}
     */
    async initialize(guildName = null) {
        if (guildName) this.guildName = guildName;
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        this.initialized = true;
        // The session's read is issued first and in this same tick: a capture
        // landing while it is in flight is merged into it, while one landing
        // before it is issued would be written over by the answer
        const restored = this._restore();
        await guildTrialPlan.initialize(this.guildName);
        await restored;
    }

    cleanup() {
        this.initialized = false;
        guildTrialPlan.cleanup();
    }

    /**
     * Read the session stored under the current key and adopt it.
     *
     * Nothing collected while the read was in flight may be lost to it: a
     * capture that landed in the meantime is this trial's and outranks the
     * disk copy, and a guild name that changed in the meantime makes the
     * answer the *previous* key's, which is discarded outright.
     *
     * @returns {Promise<void>}
     */
    async _restore() {
        const key = sessionStorageKey(this.guildName, this.characterId);
        try {
            const stored = await storage.get(key, SESSION_STORE, null);
            // The key moved while the read was in flight — this answer is the
            // old key's and says nothing about the new one
            if (key !== sessionStorageKey(this.guildName, this.characterId)) return;

            const usable = Number.isFinite(stored?.startedAt);
            const sameGuild = !stored?.guildName || !this.guildName || stored.guildName === this.guildName;
            if (usable && sameGuild) {
                this.session = mergeSessions(sanitizeStoredSession(stored), this.session);
                // The roster is fed in live and dies with the page; the copy
                // persisted beside the session is what lets a reload keep
                // showing the completed 8/8 view instead of "no roster yet"
                if (!this.roster.length && Array.isArray(stored.roster)) {
                    this.roster = normalizeRoster(stored.roster);
                }
            }
        } catch (error) {
            console.error('[GuildTrialAbilities] Reading the stored session failed:', error);
        }
        // Whatever is held now belongs under the current key. A session
        // collected before the guild's name arrived was written to `default`,
        // and only this write puts it where the next page load looks
        if (this.session) {
            this.session.guildName = this.session.guildName || this.guildName;
            this._recheckComplete(this.session.completedAt ?? Date.now());
            this._persist();
        }
    }

    /**
     * The guild changed, or became known.
     *
     * A session recorded under a *different* guild is dropped outright —
     * wrong-guild captures must not pose as this trial's. A name arriving over
     * nothing is the common case and the one that was losing sessions across a
     * reload: the module initialises before the name is knowable, so the read
     * went to `guildTrialAbilities_default` while every later write went to the
     * guild's own key. The new key is therefore re-read here, and what is
     * already in hand is merged into it rather than replaced or stranded.
     *
     * @param {string|null} name - The guild's name, or null to forget
     * @returns {Promise<void>|undefined} Resolves once the re-read has settled
     */
    setGuildName(name) {
        const next = name || null;
        // A session started before the guild's name arrived carries
        // `guildName: null` and used to survive a guild change into the new
        // guild's key; the guild the module was *keyed* by settles that too
        const from = this.session?.guildName || this.guildName;
        if (this.session && from && next && from !== next) {
            this.session = null;
        }
        const changed = next !== this.guildName;
        this.guildName = next;
        // Re-read here as the recorder does: the name usually arrives long
        // after `initialize`, and the fallback key is only right while this is
        // the character the tab is actually showing
        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        // Only a real name is stamped: forgetting the name must not also
        // forget which guild the session in hand was collected in, which is
        // what the check above reads on the next name to arrive
        if (this.session && next) this.session.guildName = next;
        if (!changed || !next || !this.initialized) return undefined;
        const restored = this._restore();
        // The plan is the guild's too, and is keyed the same way — read after
        // the session's read is issued, for the reason `initialize` gives
        guildTrialPlan.setGuildName?.(next);
        return restored;
    }

    /**
     * The current trial participants, fed in by the orchestrator.
     *
     * Joining adds one outstanding capture; leaving keeps the capture and
     * merely marks its player not-current. The roster never resets a session.
     *
     * @param {Array<string|{characterId?: string|number|null, name?: string}>} list - Participants
     */
    setRoster(list) {
        this.roster = normalizeRoster(list);
        if (this.session) {
            this._recheckComplete(Date.now());
            this._persist();
        }
    }

    /**
     * The tier the trial is currently on, fed in by the orchestrator.
     * @param {number|string|null} tier - e.g. `4`
     */
    setTier(tier) {
        this.currentTier = tier ?? null;
    }

    /**
     * An explicit "a trial just started" signal, when the caller has one.
     *
     * Debounced by {@link TRIAL_START_GRACE_MS}: the signal routinely fires
     * more than once for the same trial, and a repeat must not wipe the
     * captures the first firing started collecting.
     *
     * @param {number} [at] - Clock
     */
    noteTrialStart(at = Date.now()) {
        if (this.session && at - this.session.startedAt <= TRIAL_START_GRACE_MS) return;
        // A "start" while the session is being ticked is the same trial moving
        // from its skilling hour into its combat hour, not a new one
        if (this.session && at - sessionLastActivity(this.session) <= TRIAL_START_GRACE_MS) return;
        this._start(at);
        this._persist();
    }

    /**
     * A live-trial tick arrived (`new_guild_battle` / `new_guild_skilling`).
     *
     * Blanks a session left over from a PREVIOUS trial the moment the next
     * trial's first tick arrives — no Trials-page visit and no first capture
     * needed — while a session younger than the session window is this trial's
     * own and is never touched, however many per-tier re-fires arrive.
     *
     * @param {number} [at] - Clock
     */
    noteTrialActivity(at = Date.now()) {
        if (!this.session) return;
        if (at - sessionLastActivity(this.session) <= SESSION_MAX_AGE_MS) {
            // This trial's own tick: the session is live for as long as the
            // ticks keep coming, however long ago it began
            this._touch(at);
            return;
        }
        this._start(at);
        this._persist();
    }

    /**
     * Mark the session as touched by the trial just now. Persisted lazily —
     * the next persist carries it — since a tick arrives twice a second.
     * @param {number} at - Clock
     */
    _touch(at) {
        if (!this.session) return;
        if (!(Number(this.session.lastActivityAt) >= at)) this.session.lastActivityAt = at;
    }

    /**
     * Throw the session away and start collecting again. The button.
     * @param {number} [at] - Clock
     * @returns {Object} The fresh session
     */
    recapture(at = Date.now()) {
        this._start(at);
        this._persist();
        return this.session;
    }

    /**
     * Fold a loadout snapshot (the `extractLoadout` shape) into the session.
     *
     * Keyed by `characterId` when the snapshot has one, so a party-slot
     * reorder cannot transplant one player's abilities onto another; the
     * normalized name is the fallback key. Only an authoritative snapshot
     * makes a player captured; a stat-only sighting is kept for its name but
     * never erases an authoritative kit and never counts as one.
     *
     * `at` stamps *when the kit was read* and `now` is *when it reached this
     * module*, and only `now` may end a session. They are the same thing for a
     * sheet that has just landed and very different for one folded in from the
     * store, whose kit may have been read half an hour ago: measuring the
     * session's age against that older stamp restarted the session in the
     * middle of a trial and threw away everything captured before it.
     *
     * @param {Object} snapshot - `{characterId, name, abilities, abilitiesAuthoritative, source, at}`
     * @param {Object} [options] - Context
     * @param {number|string|null} [options.tier] - Tier at capture; defaults to the fed tier
     * @param {number} [options.at] - When the kit was read; stamped onto the entry
     * @param {number} [options.now] - When it arrived here; defaults to `at`
     * @returns {Object|null} The player's entry, or null for an unusable snapshot
     */
    recordCapture(snapshot, { tier = this.currentTier, at, now } = {}) {
        if (!snapshot || (!snapshot.name && (snapshot.characterId === null || snapshot.characterId === undefined))) {
            return null;
        }

        const when = Number.isFinite(at) ? at : Number.isFinite(snapshot.at) ? snapshot.at : Date.now();
        const arrivedAt = Number.isFinite(now) ? now : when;
        if (this.session && arrivedAt - sessionLastActivity(this.session) > SESSION_MAX_AGE_MS) this._start(arrivedAt);
        if (!this.session) this._start(arrivedAt);
        this._touch(arrivedAt);

        const key = playerKey(snapshot);
        let existing = this.session.players[key] || null;

        // An id-carrying snapshot adopts an earlier id-less sighting of the
        // same name, so the player does not appear twice under two keys
        if (snapshot.characterId !== null && snapshot.characterId !== undefined) {
            const nameKey = playerKey({ characterId: null, name: snapshot.name });
            if (nameKey !== key && this.session.players[nameKey]) {
                existing = existing || this.session.players[nameKey];
                delete this.session.players[nameKey];
            }
        }

        const authoritative = snapshot.abilitiesAuthoritative === true;
        const entry = {
            characterId: snapshot.characterId ?? existing?.characterId ?? null,
            name: snapshot.name || existing?.name || null,
            capturedAt: authoritative ? when : (existing?.capturedAt ?? null),
            capturedTier: authoritative ? (tier ?? null) : (existing?.capturedTier ?? null),
            source: snapshot.source ?? existing?.source ?? null,
            // The three role-bearing numbers off the stat sheet, kept so a
            // class tag survives a page that never sees this player cast
            classStats: classSheet(snapshot.stats) ?? existing?.classStats ?? null,
            abilitiesAuthoritative: authoritative || existing?.abilitiesAuthoritative === true,
            abilities: authoritative
                ? (snapshot.abilities || []).map((ability) => ({
                      hrid: ability?.hrid ?? null,
                      level: Number.isFinite(Number(ability?.level)) ? Number(ability.level) : null,
                  }))
                : (existing?.abilities ?? null),
        };
        this.session.players[key] = entry;

        if (authoritative && tier !== null && tier !== undefined) {
            if (this.session.captureTier === null) this.session.captureTier = tier;
            if (!this.session.capturedTiers.includes(tier)) this.session.capturedTiers.push(tier);
        }

        this._recheckComplete(arrivedAt);
        this._persist();
        return entry;
    }

    /**
     * One ability seen being cast by a named player, from a live trial tick.
     *
     * Fed by `guild-trial-damage.js` off the spectated stream, which is the only
     * place a roster member who has never been clicked says anything about their
     * build. Cheap on purpose — it runs per player per tick, twice a second —
     * and it writes nothing to storage: a repeat of an hrid already logged only
     * bumps a counter.
     *
     * A session is *not* started by a cast. A tick arriving with no session in
     * hand is a trial this module has not been told about yet, and inventing one
     * here would give it a start time an hour wrong.
     *
     * @param {string} name - The player's name, as the unit resolver gave it
     * @param {string} abilityHrid - What the tick said they were preparing
     * @returns {boolean} Whether this was a new distinct ability for them
     */
    noteAbilityCast(name, abilityHrid) {
        const key = String(name || '')
            .trim()
            .toLowerCase();
        if (!key) return false;

        const log = (this.casts[key] = this.casts[key] || newCastLog());
        return noteCast(log, abilityHrid);
    }

    /**
     * The role a participant appears to be playing, from everything known.
     *
     * The captured kit and sheet where one exists, the watched casts otherwise,
     * and both together where both exist — `inferClass` weighs them. Null when
     * nothing supports a verdict, which is most of a roster early in a trial.
     *
     * @param {{name?: string, capture?: Object|null}} row - A `participants()` row
     * @param {Object} abilityDetailMap - Game data
     * @param {number|null} [partyThreat] - Baseline threat for the rest of the party, from
     *   {@link partyThreatBaseline}. Recomputed from the current roster when omitted — pass it in
     *   when classifying many rows in a loop so it is only ever computed once.
     * @returns {Object|null} The verdict, from `inferClass`
     */
    classOf(row, abilityDetailMap = this._abilityMap(), partyThreat = this._partyThreatBaseline()) {
        const name = String(row?.name || row?.capture?.name || '')
            .trim()
            .toLowerCase();
        // Trial evidence only — never the weapon on the character's sheet: a
        // trial runs on its own loadout while the same character may be in an
        // ordinary fight with another weapon at the same time
        return inferClass(
            {
                casts: name ? this.casts[name] || null : null,
                kit: row?.capture?.abilities || null,
                stats: row?.capture?.classStats || null,
                partyThreat,
            },
            abilityDetailMap,
            this._itemMap()
        );
    }

    /**
     * A representative "everyone has this" threat reading for the current roster.
     *
     * The median of every captured player's sheet threat — the middle of the pack rather than
     * the mean, so one true tank pulling the average up cannot raise the bar against themselves,
     * and a couple of stray zero readings cannot pull it down to nothing. Null under two captured
     * readings: a baseline of one player is not a baseline, and `inferClass` falls back to its own
     * "nonzero" reading in that case.
     *
     * @returns {number|null}
     */
    _partyThreatBaseline() {
        const players = this.session?.players || {};
        const threats = Object.values(players)
            .map((entry) => Number(entry?.classStats?.threat))
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        if (threats.length < 2) return null;
        const mid = Math.floor(threats.length / 2);
        return threats.length % 2 === 0 ? (threats[mid - 1] + threats[mid]) / 2 : threats[mid];
    }

    /**
     * Every participant's inferred role, keyed by lowercased name.
     *
     * The cheap half of {@link GuildTrialAbilities#state} — no aura aggregation
     * and no plan comparison — for the surfaces that redraw on a timer and only
     * want the tags. The scoreboard is one: it is built off the damage
     * breakdown's names rather than off the roster, so a name is all it can
     * look a role up by.
     *
     * @param {Object} [abilityDetailMap] - Game data
     * @returns {Object<string, Object>} Lowercased name → verdict
     */
    classes(abilityDetailMap = this._abilityMap()) {
        const map = {};
        const partyThreat = this._partyThreatBaseline();
        for (const row of this.participants()) {
            const name = String(row.name || '')
                .trim()
                .toLowerCase();
            if (!name) continue;
            const verdict = this.classOf(row, abilityDetailMap, partyThreat);
            if (verdict) map[name] = verdict;
        }
        return map;
    }

    /**
     * The roster joined against the captures, one row per current participant.
     * @returns {Array<{characterId: string|number|null, name: string, capture: Object|null, captured: boolean}>}
     */
    participants() {
        const players = this.session?.players || {};
        return this.roster.map((member) => {
            const capture = captureFor(players, member);
            return {
                characterId: member.characterId ?? capture?.characterId ?? null,
                name: member.name || capture?.name || '',
                capture,
                captured: capture?.abilitiesAuthoritative === true,
            };
        });
    }

    /**
     * How the cast-stream guess holds up against what Battle Info says.
     *
     * The guess is the verdict from the casts alone; the truth is the verdict
     * from the captured kit and sheet alone; they are compared by bucket. Only
     * a player with both is a test — no casts yet is "untested", not wrong.
     *
     * @param {{name?: string, captured?: boolean, capture?: Object|null}} row - A `participants()` row
     * @param {Object} [abilityDetailMap] - Game data
     * @param {number|null} [partyThreat] - Baseline threat for the rest of the party, from
     *   {@link partyThreatBaseline}. Recomputed from the current roster when omitted.
     * @returns {{guess: Object|null, actual: Object|null, agree: boolean|null}|null}
     *   Null when the player is not captured
     */
    classCheck(row, abilityDetailMap = this._abilityMap(), partyThreat = this._partyThreatBaseline()) {
        if (!row?.captured || !row.capture) return null;
        const name = String(row.name || row.capture?.name || '')
            .trim()
            .toLowerCase();
        const casts = name ? this.casts[name] || null : null;
        const guess = casts ? inferClass({ casts, partyThreat }, abilityDetailMap) : null;
        const actual = inferClass(
            { kit: row.capture.abilities || null, stats: row.capture.classStats || null, partyThreat },
            abilityDetailMap,
            this._itemMap()
        );
        const agree = guess && actual ? guess.key === actual.key : null;
        return { guess, actual, agree };
    }

    /**
     * Everything the panel needs, computed fresh.
     *
     * @param {Object} [abilityDetailMap] - Game data; defaults to the live map
     * @returns {Object} `{startedAt, guildName, captureTier, capturedTiers, rosterCount, capturedCount,
     *   outstanding, participants, notCurrent, complete, completedAt, auras, coverage, plan, planCompare,
     *   classes}` — each participant row carries a `classTag`, and `classes` is the same
     *   verdicts keyed by lowercased name
     */
    state(abilityDetailMap = this._abilityMap()) {
        const session = this.session;
        const partyThreat = this._partyThreatBaseline();
        // Each row carries its inferred role. Computed here rather than in
        // `participants()` because that runs on every capture and every roster
        // feed to re-check completion, and a class tag is display state
        const rows = this.participants().map((row) => ({
            ...row,
            classTag: this.classOf(row, abilityDetailMap, partyThreat),
            classCheck: this.classCheck(row, abilityDetailMap, partyThreat),
        }));
        // The detector's scorecard: every captured player whose casts gave a
        // guess is a test of it against their Battle Info
        const classChecks = { agree: 0, disagree: 0, untested: 0 };
        for (const row of rows) {
            const check = row.classCheck;
            if (!check) continue;
            if (check.agree === true) classChecks.agree += 1;
            else if (check.agree === false) classChecks.disagree += 1;
            else classChecks.untested += 1;
        }
        const outstanding = rows.filter((row) => !row.captured);
        const capturedCount = rows.length - outstanding.length;
        const complete = rows.length > 0 && outstanding.length === 0;

        // Coverage speaks only about the current participants: a departed
        // player's aura left with them, and a stranger's does not fight here
        const currentCaptures = rows.filter((row) => row.captured).map((row) => row.capture);
        const auras = aggregateAuras(currentCaptures, abilityDetailMap);
        const coverage = auraCoverage(auras, abilityDetailMap, complete);

        const currentKeys = new Set(rows.filter((row) => row.capture).map((row) => playerKey(row.capture)));
        // The plan is the lead's own writing, compared here so every reader of
        // `state()` — panel and export alike — sees the same verdicts
        const plan = guildTrialPlan.parsed(abilityDetailMap);
        const planCompare = comparePlan(plan, rows, abilityDetailMap);

        const notCurrent = Object.entries(session?.players || {})
            .filter(([key]) => !currentKeys.has(key))
            .map(([, player]) => player);

        return {
            classChecks,
            startedAt: session?.startedAt ?? null,
            lastActivityAt: session ? sessionLastActivity(session) : null,
            guildName: session?.guildName ?? this.guildName,
            captureTier: session?.captureTier ?? null,
            capturedTiers: [...(session?.capturedTiers || [])],
            rosterCount: rows.length,
            capturedCount,
            outstanding,
            participants: rows,
            notCurrent,
            complete,
            completedAt: complete ? (session?.completedAt ?? null) : null,
            auras,
            coverage,
            plan,
            planCompare,
            // The same verdicts keyed by lowercased name, for the surfaces that
            // have a name and no participant row — the scoreboard, which is
            // built off the damage breakdown rather than off the roster
            classes: Object.fromEntries(
                rows
                    .filter((row) => row.classTag && row.name)
                    .map((row) => [row.name.trim().toLowerCase(), row.classTag])
            ),
        };
    }

    /**
     * The session as the trial export embeds it.
     *
     * Coverage-aware on purpose: `missingAuras` only exists when every current
     * participant is authoritatively captured, so a partial capture exports
     * `unknownAuras` and can never masquerade as proof of absence.
     *
     * @param {Object} [abilityDetailMap] - Game data; defaults to the live map
     * @returns {Object} The export schema
     */
    exportSnapshot(abilityDetailMap = this._abilityMap()) {
        const view = this.state(abilityDetailMap);
        const players = {};
        for (const entry of Object.values(this.session?.players || {})) {
            const key =
                entry.characterId !== null && entry.characterId !== undefined
                    ? String(entry.characterId)
                    : String(entry.name || '')
                          .trim()
                          .toLowerCase();
            players[key] = { ...entry, abilities: entry.abilities ? [...entry.abilities] : null };
            const verdict = view.planCompare?.byName?.[String(entry.name || '').toLowerCase()];
            if (verdict) players[key].planVerdict = { ...verdict };
        }

        const byState = (wanted) => Object.keys(view.coverage).filter((hrid) => view.coverage[hrid] === wanted);
        const snapshot = {
            startedAt: view.startedAt,
            guildName: view.guildName,
            captureTier: view.captureTier,
            capturedTiers: view.capturedTiers,
            complete: view.complete,
            completedAt: view.completedAt,
            players,
            auras: view.auras,
            unknownAuras: byState('unknown'),
        };
        // Only when there is one — an export from a guild that never wrote a
        // plan should not carry an empty one that reads as "nobody complied"
        if (view.plan?.lines?.length) {
            snapshot.plan = {
                text: view.plan.text,
                parsedAt: view.plan.parsedAt,
                lines: view.plan.lines.map((line) => ({ ...line, abilities: [...line.abilities] })),
                notInTrial: [...(view.planCompare?.notInTrial || [])],
                noPlan: [...(view.planCompare?.noPlan || [])],
                summary: { ...view.planCompare?.summary },
            };
        }
        if (view.complete) snapshot.missingAuras = byState('missing');
        return snapshot;
    }

    /** @returns {Object} The live ability data */
    _abilityMap() {
        return dataManager.getInitClientData?.()?.abilityDetailMap || {};
    }

    /** @returns {Object} The live item data, for the weapon-passive rule */
    _itemMap() {
        return dataManager.getInitClientData?.()?.itemDetailMap || {};
    }

    /**
     * Begin a fresh session, discarding whatever was held.
     * @param {number} at - Clock
     */
    _start(at) {
        // A new trial is new evidence: the previous hour's casts say nothing
        // about who turned up for this one
        this.casts = {};
        this.session = {
            startedAt: at,
            lastActivityAt: at,
            guildName: this.guildName,
            captureTier: null,
            capturedTiers: [],
            completedAt: null,
            players: {},
        };
    }

    /**
     * Stamp or clear `completedAt` against the current roster: complete the
     * moment the last participant lands, un-complete when a joiner adds an
     * outstanding capture.
     *
     * @param {number} at - Clock
     */
    _recheckComplete(at) {
        if (!this.session) return;
        const rows = this.participants();
        const complete = rows.length > 0 && rows.every((row) => row.captured);
        if (complete && !this.session.completedAt) this.session.completedAt = at;
        if (!complete) this.session.completedAt = null;
    }

    /** Write the session down; never awaited on the capture path */
    _persist() {
        if (!this.session) return;
        storage
            // The current roster rides along so a reload can restore the
            // joined view — it is display state, not part of the session's
            // reset rules, which is why it is stamped here rather than kept
            // on the session object itself
            .set(
                sessionStorageKey(this.guildName, this.characterId),
                { ...this.session, roster: [...this.roster] },
                SESSION_STORE
            )
            .catch((error) => console.error('[GuildTrialAbilities] Saving the session failed:', error));
    }
}

const guildTrialAbilities = new GuildTrialAbilities();

export default guildTrialAbilities;
export { guildTrialAbilities, GuildTrialAbilities };
