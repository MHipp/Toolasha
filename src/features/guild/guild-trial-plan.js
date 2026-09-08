/**
 * The ability plan: what the guild *meant* to bring to the trial.
 *
 * `guild-trial-abilities.js` answers "what is equipped", one Battle Info popup
 * at a time. It cannot answer the question the trial lead actually asks —
 * "is everyone on the kit we agreed?" — because nothing in the game says what
 * was agreed. So the lead writes it down here, one player per line, and this
 * module compares the writing against the captures.
 *
 * ## The syntax
 *
 * ```text
 * # Tank
 * Alice: Fierce Aura 200, Vampirism@150, sweep
 * Bob - Aqua Aura, /abilities/fierce_aura
 * ```
 *
 * A player, a separator (`:`, `-`, `–`, `—`), then the abilities. Blank lines
 * and `#` comments are ignored. `Name 200` or `Name@200` after an ability is a
 * minimum level.
 *
 * ## Forgiving on purpose, silent never
 *
 * Names are typed by a human under time pressure, so an ability is matched
 * case-insensitively, ignoring spaces and punctuation, by its game name, its
 * hrid, its hrid tail (`fierce_aura`), or a prefix that only one ability
 * carries (`fierce` → Fierce Aura). What it is *not* is quietly dropped: a
 * token nothing matches is reported as unrecognised, and one that matches
 * several is reported as ambiguous with the candidates named. A plan that
 * silently loses a line is worse than no plan, because it reads as compliance.
 *
 * Pure but for the persistence at the bottom: the parse and the compare take
 * their game data and their roster as arguments, so both are testable without
 * a connection.
 */

import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** Object store the plan lives in — the session's store, so both travel together */
export const PLAN_STORE = 'guildHistory';

/** Key prefix; the guild name is appended, as the session's key is */
export const PLAN_KEY_PREFIX = 'guildTrialAbilityPlan';

/**
 * Storage key for a guild's plan.
 * @param {string|null} guildName - Guild name, or null before it is known
 * @returns {string} Storage key
 */
export function planStorageKey(guildName) {
    return `${PLAN_KEY_PREFIX}_${guildName || 'default'}`;
}

/**
 * Which of two devices' plans a sync pull should keep: the one saved later.
 *
 * **Not a per-player merge, deliberately.** The captures beside it are a
 * collection — two devices each clicked half the roster and the union is
 * everybody — but a plan is not a collection. It is one block of prose the
 * trial lead typed, and the lines in it are read together: "Alice: Fierce Aura"
 * only means anything against the rest of the party's assignments. Splicing one
 * device's Alice line into another device's plan would produce a plan nobody
 * wrote, and would silently resurrect a line the lead had just deleted. So the
 * whole plan wins or loses as one thing, which is the honest answer for
 * hand-authored text.
 *
 * `savedAt` is stamped on every save ({@link GuildTrialPlan#setText}), so a
 * newer plan on this device is no longer clobbered by an older one on the
 * gist — which is what a whole-key write did. A copy with no stamp predates
 * that field; it loses to a stamped copy (which is known to be a real save) and
 * otherwise falls back to last-write-wins, the incoming copy, which is exactly
 * the behaviour it had before this merge existed.
 *
 * @param {Object|null} local - This device's plan record
 * @param {Object|null} incoming - The downloaded plan record
 * @returns {Object|null} The plan to keep
 */
export function mergePlanRecords(local, incoming) {
    if (!incoming || typeof incoming !== 'object') return local ?? incoming ?? null;
    if (!local || typeof local !== 'object') return incoming;

    const mine = Number(local.savedAt);
    const theirs = Number(incoming.savedAt);
    if (Number.isFinite(mine) && !Number.isFinite(theirs)) return local;
    if (Number.isFinite(mine) && Number.isFinite(theirs)) return mine > theirs ? local : incoming;
    return incoming;
}

/*
 * Registered so a cross-device sync PULL keeps the newer plan rather than
 * whichever copy the payload carried. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: PLAN_STORE,
    // `guildTrialAbilityPlan_<guild>` and the `_default` bucket
    prefix: `${PLAN_KEY_PREFIX}_`,
    merge: mergePlanRecords,
    label: 'Guild trial ability plan',
});

/**
 * A token reduced to what a human could not get wrong: letters and digits.
 * @param {string} text - As typed
 * @returns {string} Lowercased, stripped of everything else
 */
export function normalizeToken(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * The game's abilities indexed by every spelling a plan may use them under.
 * @param {Object} abilityDetailMap - Game data
 * @returns {Array<{hrid: string, name: string, keys: string[]}>} One entry per ability
 */
export function buildAbilityIndex(abilityDetailMap = {}) {
    return Object.keys(abilityDetailMap).map((hrid) => {
        const name = abilityDetailMap[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
        const tail = hrid.split('/').pop();
        return { hrid, name, keys: [...new Set([normalizeToken(name), normalizeToken(tail), normalizeToken(hrid)])] };
    });
}

/**
 * Which ability a typed token names.
 *
 * Exact (by name, hrid or hrid tail) first, then a prefix only one ability
 * carries. Anything else is reported rather than dropped.
 *
 * @param {string} token - As typed, without any level suffix
 * @param {Array<Object>} index - From {@link buildAbilityIndex}
 * @returns {{hrid: string, name: string}|{error: 'unknown'|'ambiguous', matches: string[]}} The match or why not
 */
export function resolveAbility(token, index = []) {
    const wanted = normalizeToken(token);
    if (!wanted) return { error: 'unknown', matches: [] };

    const exact = index.filter((entry) => entry.keys.includes(wanted));
    if (exact.length === 1) return { hrid: exact[0].hrid, name: exact[0].name };
    if (exact.length > 1) return { error: 'ambiguous', matches: exact.map((entry) => entry.name).sort() };

    const prefixed = index.filter((entry) => entry.keys.some((key) => key.startsWith(wanted)));
    if (prefixed.length === 1) return { hrid: prefixed[0].hrid, name: prefixed[0].name };
    if (prefixed.length > 1) return { error: 'ambiguous', matches: prefixed.map((entry) => entry.name).sort() };
    return { error: 'unknown', matches: [] };
}

/**
 * An ability token split from its optional minimum level.
 *
 * The whole token is tried as an ability first, so an ability whose name ends
 * in a digit is not mutilated into a level requirement.
 *
 * @param {string} token - e.g. `Fierce Aura 200` or `Vampirism@150`
 * @param {Array<Object>} index - From {@link buildAbilityIndex}
 * @returns {{text: string, minLevel: number|null}} The ability part and the level
 */
export function splitMinLevel(token, index = []) {
    const text = String(token || '').trim();
    if (!resolveAbility(text, index).error) return { text, minLevel: null };
    const match = text.match(/^(.*?)\s*@?\s*(\d+)$/);
    if (!match || !match[1].trim()) return { text, minLevel: null };
    return { text: match[1].trim(), minLevel: Number(match[2]) };
}

/**
 * Parse a plan, one player per line.
 *
 * @param {string} text - The plan as written
 * @param {Object} [abilityDetailMap] - Game data
 * @param {number} [parsedAt] - Clock
 * @returns {{text: string, parsedAt: number, lines: Array<Object>, unknownTokens: string[],
 *   ambiguousTokens: Array<{token: string, matches: string[]}>}} The parsed plan
 */
export function parsePlan(text, abilityDetailMap = {}, parsedAt = Date.now()) {
    const index = buildAbilityIndex(abilityDetailMap);
    const lines = [];
    const unknownTokens = [];
    const ambiguousTokens = [];

    for (const raw of String(text || '').split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Colon needs no surrounding space ("Alice:"), but a bare hyphen or dash
        // does — otherwise a name that itself contains one ("Az-0r") is cut at
        // the first hyphen instead of at the intended separator.
        const split = trimmed.match(/^([^:]+):(.*)$/) || trimmed.match(/^(.+?)\s[-–—]\s(.*)$/);
        const player = (split ? split[1] : trimmed).trim();
        if (!player) continue;

        const line = { player, raw: trimmed, abilities: [], unknown: [], ambiguous: [] };
        for (const piece of String(split ? split[2] : '').split(',')) {
            const token = piece.trim();
            if (!token) continue;
            const { text: abilityText, minLevel } = splitMinLevel(token, index);
            const resolved = resolveAbility(abilityText, index);
            if (resolved.error === 'ambiguous') {
                line.ambiguous.push({ token, matches: resolved.matches });
                // Deduped the same way the token was matched: two players who
                // both wrote "s" and "S" named the same ambiguous prefix, and a
                // status line counting it twice would overstate how much of the
                // plan is broken
                if (!ambiguousTokens.some((entry) => normalizeToken(entry.token) === normalizeToken(token))) {
                    ambiguousTokens.push({ token, matches: resolved.matches });
                }
                continue;
            }
            if (resolved.error) {
                line.unknown.push(token);
                if (!unknownTokens.some((seen) => normalizeToken(seen) === normalizeToken(token))) {
                    unknownTokens.push(token);
                }
                continue;
            }
            line.abilities.push({ hrid: resolved.hrid, name: resolved.name, minLevel });
        }
        lines.push(line);
    }

    return { text: String(text || ''), parsedAt, lines, unknownTokens, ambiguousTokens };
}

/**
 * Which roster name a plan line names, if any.
 *
 * Case-insensitive first. A roster name scraped off a unit box may be
 * text-truncated ("SarinTe…"), so a truncated roster name matches a plan name
 * it uniquely prefixes — and a plan written from a truncated screen matches
 * the same way round.
 *
 * @param {string} planName - As written in the plan
 * @param {Array<{name: string}>} rows - Roster rows
 * @returns {Object|null} The row
 */
export function matchPlanName(planName, rows = []) {
    const wanted = String(planName || '')
        .trim()
        .toLowerCase();
    if (!wanted) return null;

    const exact = rows.find((row) => String(row?.name || '').toLowerCase() === wanted);
    if (exact) return exact;

    const stem = wanted.match(/^(.{2,}?)(?:…|\.{3})$/);
    if (stem) {
        const matches = rows.filter((row) =>
            String(row?.name || '')
                .toLowerCase()
                .startsWith(stem[1])
        );
        return matches.length === 1 ? matches[0] : null;
    }

    const truncated = rows.filter((row) => {
        const shown = String(row?.name || '')
            .toLowerCase()
            .match(/^(.{2,}?)(?:…|\.{3})$/);
        return shown ? wanted.startsWith(shown[1]) : false;
    });
    return truncated.length === 1 ? truncated[0] : null;
}

/**
 * One player's kit as the plan sees it.
 *
 * `missing` is what was planned and is not equipped, `underLevel` what is
 * equipped below the level the plan asked for, and `extra` what is equipped
 * and was not planned — informational only, since a plan lists what must be
 * brought, not everything that may be.
 *
 * @param {Object} line - A parsed plan line
 * @param {Array<{hrid: string, level: number|null}>} abilities - The captured kit
 * @param {Object} [abilityDetailMap] - Game data, for naming the extras
 * @returns {{status: string, missing: string[], underLevel: Array<Object>, extra: string[]}} The verdict
 */
export function verdictFor(line, abilities, abilityDetailMap = {}) {
    const equipped = new Map();
    for (const ability of abilities || []) {
        const level = Number(ability?.level);
        const held = equipped.get(ability?.hrid);
        const next = Number.isFinite(level) ? level : null;
        if (held === undefined || (next !== null && (held === null || next > held))) equipped.set(ability?.hrid, next);
    }

    const missing = [];
    const underLevel = [];
    for (const planned of line?.abilities || []) {
        if (!equipped.has(planned.hrid)) {
            missing.push(planned.minLevel ? `${planned.name} ${planned.minLevel}` : planned.name);
            continue;
        }
        const level = equipped.get(planned.hrid);
        if (planned.minLevel !== null && planned.minLevel !== undefined && !(level >= planned.minLevel)) {
            underLevel.push({ name: planned.name, level, required: planned.minLevel });
        }
    }

    const plannedHrids = new Set((line?.abilities || []).map((ability) => ability.hrid));
    const extra = [...equipped.keys()]
        .filter((hrid) => !plannedHrids.has(hrid))
        .map((hrid) => abilityDetailMap?.[hrid]?.name || String(hrid).split('/').pop().replace(/_/g, ' '));

    let status = 'ok';
    if (missing.length) status = 'missing';
    else if (underLevel.length) status = 'underLevel';
    return { status, missing, underLevel, extra };
}

/**
 * The plan compared against what was captured.
 *
 * @param {Object} plan - From {@link parsePlan}
 * @param {Array<Object>} participants - From `guildTrialAbilities.state().participants`
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {Object} `{verdicts, byName, notInTrial, noPlan, summary}`
 */
export function comparePlan(plan, participants = [], abilityDetailMap = {}) {
    const rows = participants || [];
    const verdicts = [];
    const indexByKey = new Map();
    const byName = {};
    const notInTrial = [];
    const planned = new Set();

    for (const line of plan?.lines || []) {
        const row = matchPlanName(line.player, rows);
        if (!row) {
            notInTrial.push(line.player);
            continue;
        }
        const key = String(row.name || '').toLowerCase();

        const verdict = row.captured
            ? { name: row.name, planName: line.player, ...verdictFor(line, row.capture?.abilities, abilityDetailMap) }
            : { name: row.name, planName: line.player, status: 'uncaptured', missing: [], underLevel: [], extra: [] };
        verdict.unknown = [...(line.unknown || [])];

        // A second line for the same player is a correction, not noise — the
        // lead rewrote it rather than deleting the old one — so it replaces
        // the earlier verdict instead of being silently skipped.
        if (indexByKey.has(key)) {
            verdicts[indexByKey.get(key)] = verdict;
        } else {
            indexByKey.set(key, verdicts.length);
            verdicts.push(verdict);
            planned.add(key);
        }
        byName[key] = verdict;
    }

    const noPlan = rows.map((row) => row.name).filter((name) => !planned.has(String(name || '').toLowerCase()));
    const onPlan = verdicts.filter((verdict) => verdict.status === 'ok').length;
    const compared = verdicts.filter((verdict) => verdict.status !== 'uncaptured').length;

    return {
        verdicts,
        byName,
        notInTrial,
        noPlan,
        summary: {
            planLines: plan?.lines?.length || 0,
            plannedPlayers: verdicts.length,
            comparedPlayers: compared,
            onPlan,
            noPlanCount: noPlan.length,
            notInTrialCount: notInTrial.length,
            unknownTokens: [...(plan?.unknownTokens || [])],
            ambiguousTokens: [...(plan?.ambiguousTokens || [])],
        },
    };
}

/**
 * The one-line status the panel's Plan section wears.
 * @param {Object} compare - From {@link comparePlan}
 * @returns {string} e.g. `5/7 on plan · 2 with no plan · 1 unrecognised ability: Flurry`
 */
export function planStatusLine(compare) {
    const summary = compare?.summary;
    if (!summary || !summary.planLines) return 'No plan saved.';

    const parts = [`${summary.onPlan}/${summary.plannedPlayers} on plan`];
    if (summary.noPlanCount) parts.push(`${summary.noPlanCount} with no plan`);
    if (summary.notInTrialCount) parts.push(`${summary.notInTrialCount} not in trial`);
    if (summary.unknownTokens.length) {
        const count = summary.unknownTokens.length;
        parts.push(`${count} unrecognised abilit${count === 1 ? 'y' : 'ies'}: ${summary.unknownTokens.join(', ')}`);
    }
    if (summary.ambiguousTokens.length) {
        const names = summary.ambiguousTokens.map((entry) => entry.token).join(', ');
        parts.push(`${summary.ambiguousTokens.length} ambiguous: ${names}`);
    }
    return parts.join(' · ');
}

/**
 * The plan's players keyed the way `comparePlan` keys them.
 *
 * Lowercased, and a second line for the same player replaces the first —
 * a rewritten line is a correction, not a second assignment, and the diff has
 * to read it the same way the comparison does or the two disagree about what
 * the plan says.
 *
 * @param {Object|null} plan - From {@link parsePlan}
 * @returns {Map<string, Object>} Key to line
 */
function planLinesByPlayer(plan) {
    const byPlayer = new Map();
    for (const line of plan?.lines || []) {
        const key = String(line?.player || '')
            .trim()
            .toLowerCase();
        if (key) byPlayer.set(key, line);
    }
    return byPlayer;
}

/**
 * One line's assignment as `key -> {label, minLevel}`.
 *
 * Keyed by hrid, so the order abilities were typed in carries no meaning.
 * Tokens the parse could not resolve are kept under their normalized spelling
 * rather than dropped: a plan written before the game data loaded is still a
 * plan the lead changed, and reporting nothing would be a lie about it.
 *
 * @param {Object|null} line - A parsed plan line
 * @returns {Map<string, {label: string, minLevel: number|null}>} The assignment
 */
function assignmentOf(line) {
    const abilities = new Map();
    for (const ability of line?.abilities || []) {
        abilities.set(ability.hrid, { label: ability.name, minLevel: ability.minLevel ?? null });
    }
    for (const token of line?.unknown || []) {
        const key = `?${normalizeToken(token)}`;
        if (!abilities.has(key)) abilities.set(key, { label: token, minLevel: null });
    }
    return abilities;
}

/**
 * What changed between two saves of a plan.
 *
 * By hrid and minimum level, case-insensitive on player names, order-insensitive
 * on abilities — the same semantics {@link comparePlan} reads the plan under, so
 * "changed" here always means a change the comparison would also see. Retyping
 * the same kit in a different order, or capitalising a name differently, is not
 * a change and is not reported as one.
 *
 * The first save of all has no previous plan; that is `hasPrevious: false` and
 * an empty diff, not a plan in which everyone was added.
 *
 * @param {Object|null} previous - The previously saved parsed plan
 * @param {Object|null} next - The newly parsed plan
 * @returns {{hasPrevious: boolean, added: string[], removed: string[],
 *   changed: Array<{player: string, added: string[], removed: string[],
 *   levels: Array<{name: string, from: number|null, to: number|null}>}>}} The diff
 */
export function planDiff(previous, next) {
    const empty = { hasPrevious: false, added: [], removed: [], changed: [] };
    if (!previous || !Array.isArray(previous.lines)) return empty;

    const before = planLinesByPlayer(previous);
    const after = planLinesByPlayer(next);

    const added = [];
    const removed = [];
    const changed = [];

    for (const [key, line] of after) {
        if (!before.has(key)) {
            added.push(line.player);
            continue;
        }
        const was = assignmentOf(before.get(key));
        const now = assignmentOf(line);

        const gained = [];
        const lost = [];
        const levels = [];
        for (const [hrid, entry] of now) {
            const held = was.get(hrid);
            if (!held) gained.push(entry.label);
            else if ((held.minLevel ?? null) !== (entry.minLevel ?? null)) {
                levels.push({ name: entry.label, from: held.minLevel ?? null, to: entry.minLevel ?? null });
            }
        }
        for (const [hrid, entry] of was) {
            if (!now.has(hrid)) lost.push(entry.label);
        }

        if (gained.length || lost.length || levels.length) {
            changed.push({ player: line.player, added: gained, removed: lost, levels });
        }
    }

    for (const [key, line] of before) {
        if (!after.has(key)) removed.push(line.player);
    }

    return { hasPrevious: true, added, removed, changed };
}

/**
 * One player's change, spelled out.
 * @param {Object} entry - A `changed` entry from {@link planDiff}
 * @returns {string} e.g. `Ana: +Fierce Aura −Insanity Vampirism 150→200`
 */
export function describePlanChange(entry) {
    const parts = [
        ...(entry?.added || []).map((name) => `+${name}`),
        ...(entry?.removed || []).map((name) => `−${name}`),
        ...(entry?.levels || []).map((level) => `${level.name} ${level.from ?? 'any'}→${level.to ?? 'any'}`),
    ];
    return `${entry?.player}: ${parts.join(' ')}`;
}

/**
 * The one-line summary of a save's diff, or null when there is nothing to say.
 *
 * Null rather than "no changes" because the line is only drawn when the plan
 * moved; a permanent "0 changed" would be noise on every draw.
 *
 * @param {Object|null} diff - From {@link planDiff}
 * @param {number} [namedPlayers] - How many changed players are named inline
 * @returns {string|null} e.g. `3 changed (Ana: +Fierce Aura −Insanity; …), 2 added, 1 removed`
 */
export function planDiffSummary(diff, namedPlayers = 2) {
    if (!diff?.hasPrevious) return null;
    const { added = [], removed = [], changed = [] } = diff;
    if (!added.length && !removed.length && !changed.length) return null;

    const parts = [];
    if (changed.length) {
        const named = changed.slice(0, Math.max(1, namedPlayers)).map(describePlanChange);
        if (changed.length > named.length) named.push('…');
        parts.push(`${changed.length} changed (${named.join('; ')})`);
    }
    if (added.length) parts.push(`${added.length} added`);
    if (removed.length) parts.push(`${removed.length} removed`);
    return parts.join(', ');
}

class GuildTrialPlan {
    constructor() {
        this.guildName = null;
        this.record = null;
        /** `{text, map, parsed}` — a parse is only redone when one of them moves */
        this.cache = null;
    }

    /**
     * Adopt a guild and read its plan back.
     * @param {string|null} [guildName] - The key the plan is stored under
     * @returns {Promise<void>}
     */
    async initialize(guildName = null) {
        this.guildName = guildName || null;
        this._makeRecord();
        await this.record.load();
    }

    cleanup() {
        this.cache = null;
    }

    /**
     * The guild changed, or became known — re-read under the new key.
     *
     * A plan is the *guild's*, so nothing carries over: the record is rebuilt
     * on the new key and loaded, and until it lands the plan reads empty
     * rather than as the previous guild's.
     *
     * @param {string|null} name - The guild's name, or null to forget
     * @returns {Promise<void>|undefined} Resolves once the re-read has settled
     */
    setGuildName(name) {
        const next = name || null;
        if (next === this.guildName && this.record) return undefined;
        this.guildName = next;
        this.cache = null;
        this._makeRecord();
        return this.record.load();
    }

    /** @returns {string} The plan as written */
    text() {
        return this.record?.get()?.text || '';
    }

    /** @returns {number|null} When it was last saved */
    savedAt() {
        return this.record?.get()?.savedAt ?? null;
    }

    /**
     * Save a plan. User-authored text, so memory is the truth once loaded —
     * clearing the box clears the plan.
     * @param {string} text - The plan as written
     * @returns {Promise<boolean>} Whether the write landed
     */
    async setText(text, abilityDetailMap = this.cache?.map || {}) {
        if (!this.record) this._makeRecord();
        // Parsed against the plan as it stood a moment ago, before the cache is
        // dropped: once the text is written the previous plan is gone, and
        // "what did this save change" has no answer left to give
        const previous = this.record.get()?.text ? this.parsed(abilityDetailMap) : null;
        const next = parsePlan(String(text ?? ''), abilityDetailMap);
        const diff = planDiff(previous, next);

        this.cache = null;
        this.record.set({ text: String(text ?? ''), savedAt: Date.now(), diff });
        return this.record.save();
    }

    /** @returns {Object|null} What the last save changed, from {@link planDiff} */
    lastDiff() {
        const diff = this.record?.get()?.diff;
        return diff?.hasPrevious ? diff : null;
    }

    /**
     * The parsed plan, reparsed only when the text or the game data moves.
     * @param {Object} [abilityDetailMap] - Game data
     * @returns {Object} From {@link parsePlan}
     */
    parsed(abilityDetailMap = {}) {
        const text = this.text();
        if (this.cache && this.cache.text === text && this.cache.map === abilityDetailMap) return this.cache.parsed;
        const parsed = parsePlan(text, abilityDetailMap);
        this.cache = { text, map: abilityDetailMap, parsed };
        return parsed;
    }

    /**
     * The plan compared against a captured roster.
     * @param {Array<Object>} participants - From `guildTrialAbilities.state().participants`
     * @param {Object} [abilityDetailMap] - Game data
     * @returns {Object} From {@link comparePlan}
     */
    compare(participants, abilityDetailMap = {}) {
        return comparePlan(this.parsed(abilityDetailMap), participants, abilityDetailMap);
    }

    /** Build the record on the current key */
    _makeRecord() {
        this.record = createCuratedRecord({
            base: planStorageKey(this.guildName),
            store: PLAN_STORE,
            scoped: false,
            empty: () => ({}),
            merge: mergeMaps(),
            label: 'GuildTrialPlan',
        });
    }
}

const guildTrialPlan = new GuildTrialPlan();

export default guildTrialPlan;
export { guildTrialPlan, GuildTrialPlan };
