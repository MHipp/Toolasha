/**
 * Combat session history
 *
 * The runs before this one, so the loot panel can be asked about them.
 *
 * The collector keeps exactly one snapshot — the run in progress — which is
 * everything the overlay needs and nothing the question "what did last night
 * actually earn" needs. FLoot answers that from a session list, and this is the
 * list.
 *
 * ## What counts as a session
 *
 * The same thing the damage tally counts: the roster and the server's
 * `combatStartTime` together. Either half alone is not enough — the same party
 * in a new zone is a new run, and the same zone with somebody gone is a
 * different run measuring different people.
 *
 * ## Archived on the way out, not on the way in
 *
 * A session is written to history when a *different* one starts, because that is
 * the first moment it is known to be over — nothing in the payload says "this
 * run has ended", and a timer would guess. The consequence is that the newest
 * finished run appears the moment the next one begins, and a run still under way
 * is never in the list. It does not need to be: it is the live session.
 *
 * The snapshot stored is the last one seen of that session, which is its final
 * state, since the loot totals only ever grow.
 *
 * That holds for one observer. Two devices can each hold a different stretch of
 * the same run under the same key, and neither snapshot is the whole of it, so
 * two copies of one session are combined field by field rather than one winning
 * whole — see `mergeSessionRecords`.
 */

import dataManager from '../../core/data-manager.js';
import { createPersistedRecord } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/**
 * Where the list lives.
 *
 * Scoped per character, and resolved at every read and write rather than once:
 * a run is one character's run, and the user switches characters without
 * reloading the page. The pre-scoping global list is adopted by the main
 * character the first time it is read.
 */
const STORE_KEY = 'combatSessionHistory';
const STORE_NAME = 'combatStats';

/**
 * How many runs to keep.
 *
 * Each carries a loot map and a consumable list, so this is kilobytes rather
 * than bytes per entry. Twenty is more sessions than anybody scrolls back
 * through and small enough not to be a thing that grows forever.
 */
export const MAX_SESSIONS = 20;

/**
 * The identity a stored session is merged on: the key `withSession` stamps,
 * or the same thing derived for a snapshot written before it was stamped.
 * @param {Object} session - A stored session
 * @returns {string|null}
 */
function sessionIdentity(session) {
    return session?.key || sessionKey(session);
}

/** When a session began, as a number, for ordering newest first */
function startedAt(session) {
    const raw = session?.combatStartTime;
    const ms = typeof raw === 'number' ? raw : new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

/** When a session was last observed — the instant the stored snapshot was taken */
function lastSeenAt(session) {
    const ms = Number(session?.timestamp);
    return Number.isFinite(ms) ? ms : 0;
}

/** The larger of two counters; a side that is not a number defers to the other */
function larger(a, b) {
    if (typeof a !== 'number') return b;
    if (typeof b !== 'number') return a;
    return Math.max(a, b);
}

/** A map of `hrid → count`, each key the larger of the two counts */
function mergeCounterMap(a, b) {
    const merged = { ...(a && typeof a === 'object' ? a : {}) };
    for (const [key, value] of Object.entries(b && typeof b === 'object' ? b : {})) {
        merged[key] = larger(merged[key], value);
    }
    return merged;
}

/**
 * A `totalLootMap`, keyed by the game's own slot key.
 *
 * The slot keys are the server's and identical in both copies of one run, so
 * the union cannot split an item across two rows; each slot's `count` is a
 * running total and takes the larger.
 */
function mergeLoot(a, b) {
    const merged = { ...(a && typeof a === 'object' ? a : {}) };
    for (const [slot, entry] of Object.entries(b && typeof b === 'object' ? b : {})) {
        const held = merged[slot];
        merged[slot] =
            held && entry && typeof entry === 'object'
                ? { ...held, ...entry, count: larger(held.count, entry.count) }
                : entry;
    }
    return merged;
}

/**
 * One consumable line, as two observers of the same run saw it.
 *
 * `actualConsumed` and `elapsedSeconds` are counters and take the larger. The
 * rates (`consumptionRate`, `consumedPerDay`, `timeToZeroSeconds`) and the
 * inventory readings (`currentCount`, `inventoryAmount`, which fall as the
 * stack is drunk) are the later observer's — a max of a rate is meaningless
 * and a max of a stack size is the older reading. `consumed` is a rate times a
 * span, so it is recomputed from the merged duration rather than carried over.
 */
function mergeConsumable(early, late, durationSeconds) {
    const rate = late.consumptionRate;
    return {
        ...early,
        ...late,
        actualConsumed: larger(early.actualConsumed, late.actualConsumed),
        elapsedSeconds: larger(early.elapsedSeconds, late.elapsedSeconds),
        consumed: typeof rate === 'number' ? rate * durationSeconds : late.consumed,
    };
}

/** The consumable lines of one player, keyed by item, the later copy's order first */
function mergeConsumables(early, late, durationSeconds) {
    const byItem = new Map();
    for (const line of Array.isArray(early) ? early : []) {
        if (line?.itemHrid) byItem.set(line.itemHrid, line);
    }

    const merged = [];
    const taken = new Set();
    for (const line of Array.isArray(late) ? late : []) {
        if (!line?.itemHrid) continue;
        taken.add(line.itemHrid);
        const held = byItem.get(line.itemHrid);
        merged.push(held ? mergeConsumable(held, line, durationSeconds) : line);
    }
    for (const [itemHrid, line] of byItem) {
        if (!taken.has(itemHrid)) merged.push(line);
    }
    return merged;
}

/** One player of a run, as the two observers saw them */
function mergePlayer(early, late, durationSeconds) {
    return {
        ...early,
        ...late,
        loot: mergeLoot(early.loot, late.loot),
        experience: mergeCounterMap(early.experience, late.experience),
        deathCount: larger(early.deathCount, late.deathCount),
        consumables: mergeConsumables(early.consumables, late.consumables, durationSeconds),
    };
}

/**
 * Two observations of the *same* run, combined field by field.
 *
 * Two devices can each hold a different stretch of one run — one watched its
 * first hour, the other its last five minutes — and both archive it under the
 * same `roster|combatStartTime` key. Letting either copy win whole throws away
 * whatever only the other saw. Every field is resolved on what it means:
 *
 * | Field | How |
 * | --- | --- |
 * | `combatStartTime` | the earlier of the two — a run begins once |
 * | `timestamp` (last seen) | the later of the two |
 * | `durationSeconds` | start to last-seen, never shorter than either observation |
 * | `players[].loot[slot].count` | counter — the larger |
 * | `players[].experience[skill]` | counter — the larger |
 * | `players[].deathCount` | counter — the larger |
 * | `players[].consumables[].actualConsumed` | counter — the larger |
 * | `players[].consumables[].elapsedSeconds` | counter — the larger |
 * | `players[].consumables[].consumed` | recomputed: merged rate times merged duration |
 * | `players[].consumables[]` rates and stack counts | the later observer's |
 * | `players[].combatStats` | a reading, not a total — the later observer's |
 * | everything else (`battleId`, `actionHrid`, `key`, names) | the later observer's |
 *
 * A player, or a consumable line, that only one side has passes through whole.
 * Symmetric in its arguments for every counter and timestamp; where both were
 * last seen at the same instant the second argument counts as the later.
 *
 * @param {Object} a - One stored session
 * @param {Object} b - Another copy of the same session
 * @returns {Object} The two combined
 */
export function mergeSessionRecords(a, b) {
    if (!a || typeof a !== 'object') return b;
    if (!b || typeof b !== 'object') return a;

    const [early, late] = lastSeenAt(a) <= lastSeenAt(b) ? [a, b] : [b, a];
    const startMs = Math.min(startedAt(a) || Infinity, startedAt(b) || Infinity);
    const earlierStart = startedAt(a) && startedAt(a) <= (startedAt(b) || Infinity) ? a : b;
    const combatStartTime = Number.isFinite(startMs) ? earlierStart.combatStartTime : late.combatStartTime;

    const timestamp = Math.max(lastSeenAt(a), lastSeenAt(b));
    // The span the run covered, floored by what each device measured: a copy
    // with no `timestamp` contributes no end, and must not shorten a duration
    // the other side already recorded
    const spanSeconds = timestamp && Number.isFinite(startMs) ? (timestamp - startMs) / 1000 : 0;
    const durationSeconds = Math.max(spanSeconds, a.durationSeconds || 0, b.durationSeconds || 0);

    const byName = new Map();
    for (const player of early.players || []) {
        if (player?.name) byName.set(player.name, player);
    }
    const players = [];
    const taken = new Set();
    for (const player of late.players || []) {
        if (!player?.name) {
            players.push(player);
            continue;
        }
        taken.add(player.name);
        const held = byName.get(player.name);
        players.push(held ? mergePlayer(held, player, durationSeconds) : player);
    }
    for (const [name, player] of byName) {
        if (!taken.has(name)) players.push(player);
    }

    const merged = { ...early, ...late, durationSeconds, players };
    if (combatStartTime !== undefined) merged.combatStartTime = combatStartTime;
    if (timestamp) merged.timestamp = timestamp;
    return merged;
}

/**
 * The list on disk, kept through the shared load/save discipline: a read that
 * could not be made keeps the list in memory rather than writing one session
 * over all of them, and a save folds in runs another tab archived. Keyed by
 * session key, with two copies of one run combined by `mergeSessionRecords`
 * rather than one replacing the other, newest first, capped at MAX_SESSIONS.
 *
 * @param {Array<Object>} base - The list as stored
 * @param {Array<Object>} fresh - The list to fold on top
 * @returns {Array<Object>} A new list
 */
export function mergeSessions(base, fresh) {
    const byId = new Map();
    for (const list of [base, fresh]) {
        for (const entry of Array.isArray(list) ? list : []) {
            const id = entry == null ? null : sessionIdentity(entry);
            if (id === null || id === undefined) continue;
            const held = byId.get(id);
            byId.set(id, held ? mergeSessionRecords(held, entry) : entry);
        }
    }
    return [...byId.values()].sort((a, b) => startedAt(b) - startedAt(a)).slice(0, MAX_SESSIONS);
}

const sessionRecord = createPersistedRecord({
    base: STORE_KEY,
    store: STORE_NAME,
    empty: () => [],
    merge: mergeSessions,
    label: 'CombatSessionHistory',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: STORE_NAME, base: STORE_KEY, merge: mergeSessions, label: 'Combat sessions' });

/** Whose sessions the record in memory holds — a change means forget them first */
let recordOwner = null;

/**
 * The record, with the departing character's sessions forgotten when the
 * character has changed: the key is resolved per access, and memory must never
 * be written under another character's key.
 * @returns {Object} The persisted record
 */
function record() {
    const owner = dataManager.getCurrentCharacterId?.() || null;
    if (owner !== recordOwner) {
        sessionRecord.reset();
        recordOwner = owner;
    }
    return sessionRecord;
}

/**
 * Which run a snapshot belongs to.
 *
 * @param {Object} data - A collector snapshot, or a `new_battle` payload
 * @returns {string|null} A key, or null when it cannot say
 */
export function sessionKey(data) {
    const players = data?.players || [];
    if (!players.length || !data?.combatStartTime) return null;

    const roster = players.map((player) => player?.name || player?.character?.name || '?').join(',');
    return `${roster}|${data.combatStartTime}`;
}

/**
 * Fold a snapshot into a list, newest first.
 *
 * Pure, so the decisions worth arguing about are testable: a session already in
 * the list is replaced rather than repeated, because the later snapshot is the
 * more complete one — its loot totals include everything the earlier one had.
 *
 * @param {Array<Object>} history - The list as it stands
 * @param {Object} snapshot - A finished session
 * @returns {Array<Object>} A new list
 */
export function withSession(history, snapshot) {
    const key = sessionKey(snapshot);
    if (!key) return history || [];

    const rest = (history || []).filter((entry) => entry.key !== key);
    return [{ ...snapshot, key }, ...rest].slice(0, MAX_SESSIONS);
}

/**
 * Every finished run, newest first.
 * @returns {Promise<Array<Object>>}
 */
export async function loadSessions() {
    try {
        const sessions = record();
        await sessions.load();
        return sessions.get().slice();
    } catch (error) {
        console.error('[CombatSessionHistory] Reading the session list failed:', error);
        return [];
    }
}

/**
 * Add a finished run to the list.
 *
 * @param {Object} snapshot - The last state of the session that ended
 * @returns {Promise<Array<Object>>} The list as it now stands
 */
export async function archiveSession(snapshot) {
    try {
        // Loaded first so a read that could not be made keeps what is in
        // memory rather than writing this one run over the list; the save
        // folds in what another tab archived meanwhile
        const sessions = record();
        await sessions.load();
        await sessions.update((history) => withSession(history, snapshot));
        return sessions.get().slice();
    } catch (error) {
        console.error('[CombatSessionHistory] Archiving a session failed:', error);
        return [];
    }
}

/** Forget every archived run — the one write meant to lose entries. @returns {Promise<void>} */
export async function clearSessions() {
    try {
        await record().clear();
    } catch (error) {
        console.error('[CombatSessionHistory] Clearing the session list failed:', error);
    }
}

/**
 * Several sessions added together, as one.
 *
 * Loot is summed per item and durations are added, which is what makes a
 * combined view answer "what has this zone paid me all week" rather than "what
 * did the best hour of it look like".
 *
 * The players are keyed by name rather than by position: across sessions a
 * position means nothing at all, and the same character appears in several.
 *
 * Each player also carries their own `durationSeconds` — the sum of only the
 * sessions *they* appear in, not the group total. A roster is not the same
 * five names across every combined run: somebody who sat out half of them had
 * loot arrive over half the clock, and dividing their total by the full span
 * (the group's `durationSeconds`, still returned for whatever reads it that
 * way) understates their rate, worse the more sessions pile up around them.
 *
 * @param {Array<Object>} sessions - Snapshots
 * @returns {Object|null} One snapshot shaped like the others, or null for none
 */
export function combineSessions(sessions) {
    const usable = (sessions || []).filter((session) => session?.players?.length);
    if (!usable.length) return null;

    const byName = new Map();
    let durationSeconds = 0;

    for (const session of usable) {
        const sessionDuration = session.durationSeconds || 0;
        durationSeconds += sessionDuration;

        for (const player of session.players) {
            const name = player?.name;
            if (!name) continue;

            if (!byName.has(name)) {
                byName.set(name, { ...player, loot: {}, experience: {}, deathCount: 0, durationSeconds: 0 });
            }
            const combined = byName.get(name);
            combined.deathCount += player.deathCount || 0;
            combined.durationSeconds += sessionDuration;

            // Keyed by item rather than by the game's slot key: two sessions
            // number their slots independently, so merging on the raw key would
            // put the same item in two rows
            for (const entry of Object.values(player.loot || {})) {
                if (!entry?.itemHrid) continue;
                const held = combined.loot[entry.itemHrid] || { itemHrid: entry.itemHrid, count: 0 };
                held.count += entry.count || 0;
                combined.loot[entry.itemHrid] = held;
            }

            // Same shape as loot: summed per skill, not overwritten, so a run
            // that started with the first session's numbers and simply kept
            // them (`experience` is reset to `{}` above precisely so it
            // wouldn't) does not read as "no experience this week"
            for (const [skillHrid, amount] of Object.entries(player.experience || {})) {
                combined.experience[skillHrid] = (combined.experience[skillHrid] || 0) + (amount || 0);
            }
        }
    }

    return {
        combatStartTime: usable[usable.length - 1].combatStartTime,
        durationSeconds,
        combined: true,
        sessionCount: usable.length,
        players: [...byName.values()],
    };
}

/**
 * A session as a line in a picker.
 *
 * @param {Object} session - A snapshot
 * @param {Function} [formatDuration] - Seconds to something readable
 * @returns {string}
 */
export function describeSession(session, formatDuration = (s) => `${Math.round(s / 60)}m`) {
    const started = session?.combatStartTime ? new Date(session.combatStartTime) : null;
    const when = started
        ? started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : 'Unknown time';

    // Clamped for runs archived before durations were clamped at the source —
    // a clock-skewed short run stored a small negative, which read as "(—)"
    return `${when} (${formatDuration(Math.max(0, session?.durationSeconds || 0))})`;
}
