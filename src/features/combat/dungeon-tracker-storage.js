/**
 * Dungeon Tracker Storage
 * Manages IndexedDB storage for dungeon run history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { RECOVERY_FALLBACK_MAX_MS } from './dungeon-pace.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** The object store the run history lives in */
export const RUNS_STORE = 'unifiedRuns';

/** The one key holding every run, for the whole account rather than per character */
export const RUNS_KEY = 'allRuns';

/**
 * When the user last asked for the whole history to be forgotten.
 *
 * A separate key because {@link RUNS_KEY} is a bare array that four other
 * modules read directly; wrapping it to carry one number would break every one
 * of them. Its own registration folds it with `Math.max`, so the clear
 * outlives a pull in both directions.
 */
export const RUNS_CLEARED_KEY = 'allRunsClearedAt';

/**
 * The runs removed one at a time, so a pull cannot put them back.
 *
 * {@link RUNS_CLEARED_KEY} answers "forget all of it" and nothing else, and
 * every *single* removal — a run deleted by hand, an outlier
 * {@link DungeonTrackerStorage#scrubOutlierRuns} dropped, the broken copy a
 * date repair replaced — was only ever remembered in memory. The union that
 * folds a downloaded history in has nothing to tell a run the user removed
 * from one they simply have not seen, so a peer that never saw the removal
 * pushed it straight back.
 *
 * Its own key for the same reason the clear watermark has one: {@link RUNS_KEY}
 * is a bare array four other modules read directly. Its fold is a union, since
 * a removal is a fact that only moves forward exactly as a clear is.
 *
 * Stored as `[{id, at}]`: `id` is the {@link runIdentity} triple, and `at` is
 * *the removed run's own moment* — not the moment of the deletion. That is
 * what makes an entry prunable: a clear at epoch C already drops every run
 * stamped at or before C, so a tombstone whose run is that old can never
 * change an outcome again and is dropped with it.
 */
export const RUNS_DELETED_KEY = 'allRunsDeleted';

/**
 * Where each dungeon's chat average is asked to start from.
 *
 * A map of `teamKey::dungeonName` → epoch milliseconds: runs at or before the
 * stamp are left out of the party-chat average, and nothing else. It is
 * deliberately *not* a clear — every run stays in the history, keeps its run
 * number and still shows in the panel — because the thing the marker fixes is
 * a stale average, not unwanted data.
 *
 * Its own key rather than a field on {@link RUNS_KEY} for the same reason the
 * clear watermark has one: that key is a bare array four other modules read
 * directly. Its fold is a per-dungeon `Math.max`, so a marker set on one
 * device is not undone by a pull from one that never saw it.
 */
export const AVERAGE_BASELINE_KEY = 'dungeonAverageBaselines';

/**
 * When this device re-derived the runs a mm/dd-vs-dd/mm misread had mangled.
 *
 * The four chat-stamp parsers used to read `[dd/mm hh:mm:ss]` as mm/dd, so on a
 * day-first client every day of 12 or less was taken for a month and a run's
 * two endpoints could land weeks apart — a 14-minute clear stored as 29 days.
 * The parsers are fixed; {@link DungeonTrackerStorage#repairSwappedDateRuns}
 * repairs what they wrote, once, and this key is what stops it running twice.
 *
 * Its own key, like the clear watermark, because {@link RUNS_KEY} is a bare
 * array four other modules read directly. Its fold is `Math.max`, so a pull
 * from a device that never ran the pass cannot un-mark this one and set the
 * repair going again over records that are already right.
 */
export const RUNS_DATE_REPAIR_KEY = 'allRunsDateOrderRepairedAt';

/**
 * Runs are stored once for the whole account, not once per character.
 *
 * A team run is the same run whichever of your characters was in the party, and
 * the duplicate check that collapses those two sightings into one entry only
 * works if they land in the same list. Partitioning the store per character
 * would turn one run into two.
 *
 * What the store lacked was any record of *who* recorded each run, so a panel
 * could not answer "how am I doing" without also counting the other character's
 * runs. New runs are stamped with the recording character; the panel filters on
 * that stamp. Runs written before the stamp existed fall back to looking for
 * the character's name in the team, which is right for every run they were
 * actually in and merely conservative for solo runs recorded under a name the
 * roster does not carry.
 */

/**
 * How long a deferred save waits for company before it reads, merges and writes.
 *
 * Short enough that a lone run is on disk almost at once, long enough that a
 * chat backfill — which appends dozens of runs in one synchronous sweep —
 * collapses into a single read-merge-write instead of one per run.
 */
export const PERSIST_COALESCE_MS = 250;

// Hardcoded max waves for each dungeon (fallback if maxCount is 0)
const DUNGEON_MAX_WAVES = {
    '/actions/combat/chimerical_den': 50,
    '/actions/combat/sinister_circus': 60,
    '/actions/combat/enchanted_fortress': 65,
    '/actions/combat/pirate_cove': 65,
};

/**
 * Whether a stored run belongs to the given character.
 *
 * Pure so the fallback is testable: the stamp decides when it is there, and
 * only a run without one is matched by name against the team.
 *
 * @param {Object} run - A stored run
 * @param {string|null} characterId - The character asking
 * @param {string|null} characterName - Their in-game name, for legacy runs
 * @returns {boolean}
 */
export function runMatchesCharacter(run, characterId, characterName) {
    if (!run) return false;

    if (run.recordedBy) {
        return characterId != null && String(run.recordedBy) === String(characterId);
    }

    // Legacy run: no stamp, so the roster is the only evidence there is
    if (!characterName) return false;
    if (Array.isArray(run.team) && run.team.includes(characterName)) return true;
    if (typeof run.teamKey === 'string' && run.teamKey.split(',').includes(characterName)) return true;
    return false;
}

/**
 * Narrow a run list to one character, or leave it whole.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {string} filterCharacter - 'mine' or 'all'
 * @param {{id: string|null, name: string|null}} character - Who is asking
 * @returns {Array<Object>} The runs to show
 */
export function filterRunsForCharacter(runs, filterCharacter, character) {
    const list = Array.isArray(runs) ? runs : [];
    if (filterCharacter !== 'mine') return list;
    return list.filter((run) => runMatchesCharacter(run, character?.id ?? null, character?.name ?? null));
}

/**
 * What tells two sightings of the same run apart.
 *
 * A run carries no id, so the team that ran it, when it started and how long it
 * took are its identity — the same triple the duplicate check has always used,
 * here matched exactly because both sides are copies of one written record
 * rather than two independent observations.
 * @param {Object} run - A stored run
 * @returns {string} `teamKey|timestamp|duration`
 */
export function runIdentity(run) {
    return `${run?.teamKey ?? ''}|${run?.timestamp ?? ''}|${run?.duration ?? ''}`;
}

/**
 * Fold the stored list into the in-memory one.
 *
 * `allRuns` is one key for the whole account, so two tabs — or two characters
 * in the same party — write the same key. Memory is a snapshot taken when the
 * tab loaded; writing it back whole erases everything the other tab recorded
 * since. Runs are matched on the triple that identifies them (team, timestamp,
 * duration), memory wins on a tie because it may have been amended in place
 * (a tier filled in), and anything this session deleted stays deleted rather
 * than being carried back in from a copy written before the delete.
 *
 * @param {Array<Object>} memory - The in-memory list, newest first
 * @param {Array<Object>} stored - What storage holds right now
 * @param {Set<string>|Map<string, *>} [deleted] - Identities removed, by
 *   `has()` alone, so a tombstone map and a bare identity set both serve
 * @returns {Array<Object>} The union, newest first
 */
export function mergeRuns(memory, stored, deleted) {
    const merged = Array.isArray(memory) ? [...memory] : [];
    const seen = new Set(merged.map(runIdentity));
    for (const run of Array.isArray(stored) ? stored : []) {
        if (!run) continue;
        const id = runIdentity(run);
        if (seen.has(id) || deleted?.has(id)) continue;
        seen.add(id);
        merged.push(run);
    }
    const at = (run) => {
        const time = new Date(run?.timestamp).getTime();
        return Number.isFinite(time) ? time : 0;
    };
    // Newest first, as the list has always been; runs with no usable timestamp
    // all score 0 and so keep the order they came in
    merged.sort((a, b) => at(b) - at(a));
    return merged;
}

/**
 * A run's own moment, in epoch milliseconds, or null when it has none usable.
 *
 * Only a run that can be placed in time may be judged against a clear epoch;
 * an unstamped one is kept, because "when was this recorded" is exactly the
 * question the epoch asks and a run that cannot answer it must not be guessed
 * away.
 *
 * @param {Object} run - A stored run
 * @returns {number|null} Epoch milliseconds, or null
 */
export function runTime(run) {
    // `new Date(null)` is the epoch, not an error, so an absent stamp has to be
    // rejected before parsing or every unstamped run would date to 1970
    const stamp = run?.timestamp;
    if (stamp == null || stamp === '') return null;
    const time = new Date(stamp).getTime();
    return Number.isFinite(time) ? time : null;
}

/**
 * Drop the runs a "delete all history" at `clearedAt` was asking to forget.
 *
 * Runs are append-only observations stamped when the run finished, so a run
 * recorded after the clear is stamped after it and survives — which is what
 * makes an epoch the right shape here and per-run tombstones the wrong one:
 * the history is unbounded and the clear names all of it at once.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {number} clearedAt - Epoch milliseconds, 0 for "never cleared"
 * @returns {Array<Object>} The survivors — the same array when nothing went
 */
export function applyClearEpoch(runs, clearedAt) {
    const list = Array.isArray(runs) ? runs : [];
    if (!(Number(clearedAt) > 0)) return list;
    const kept = list.filter((run) => {
        const at = runTime(run);
        return at === null || at > clearedAt;
    });
    return kept.length === list.length ? list : kept;
}

/**
 * A tombstone's own moment, or null when the run it names had no usable stamp.
 *
 * @param {*} at - The stored moment
 * @returns {number|null} Epoch milliseconds, or null
 */
function tombstoneTime(at) {
    const time = Number(at);
    return Number.isFinite(time) && time > 0 ? time : null;
}

/**
 * Read any accepted tombstone shape as identity → moment.
 *
 * The stored and downloaded shape is `[{id, at}]`; memory holds a `Map`; a
 * bare identity string is taken as a tombstone with no moment, which is the
 * conservative reading — an entry that cannot be placed in time is never
 * pruned. Anything else is dropped rather than guessed at.
 *
 * @param {*} value - A map, a set, an array of entries, or nothing
 * @returns {Map<string, number|null>} Identity → the run's own moment
 */
export function toTombstoneMap(value) {
    const map = new Map();
    if (!value) return map;
    if (value instanceof Map) {
        for (const [id, at] of value) if (typeof id === 'string' && id) map.set(id, tombstoneTime(at));
        return map;
    }
    const entries = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
    for (const entry of entries) {
        if (typeof entry === 'string') {
            if (entry) map.set(entry, null);
            continue;
        }
        const id = entry?.id;
        if (typeof id !== 'string' || !id) continue;
        map.set(id, tombstoneTime(entry.at));
    }
    return map;
}

/**
 * The tombstone that stands for one run.
 *
 * @param {Object} run - The run being removed
 * @returns {{id: string, at: number|null}} Its identity and its own moment
 */
export function tombstoneFor(run) {
    return { id: runIdentity(run), at: runTime(run) };
}

/**
 * Fold two tombstone sets: the union, exactly as a clear takes the later epoch.
 *
 * A removal only ever moves forward. A device that has not seen one holds no
 * entry for it, and a whole-key write from that device would be the removal
 * coming undone — the same shape {@link mergeClearEpochs} exists to prevent,
 * one run at a time instead of all of them at once.
 *
 * Two sides that both name a run agree about its moment, because the identity
 * carries the timestamp the moment is parsed from; the tie-break is only for a
 * payload that disagrees with itself, and it is symmetric — a placeable moment
 * beats an unplaceable one, and the earlier of two beats the later — so the
 * fold reads the same in both directions. The output is sorted by identity for
 * the same reason.
 *
 * @param {*} local - This device's tombstones
 * @param {*} incoming - The downloaded tombstones
 * @returns {Array<{id: string, at: number|null}>} The union
 */
export function mergeDeletedRuns(local, incoming) {
    const out = new Map();
    for (const side of [local, incoming]) {
        for (const [id, at] of toTombstoneMap(side)) {
            if (!out.has(id)) {
                out.set(id, at);
                continue;
            }
            const held = out.get(id);
            if (held === null) out.set(id, at);
            else if (at !== null && at < held) out.set(id, at);
        }
    }
    return [...out.keys()].sort().map((id) => ({ id, at: out.get(id) }));
}

/**
 * Drop the tombstones a "delete all history" at `clearedAt` has superseded.
 *
 * This is what bounds the set. A clear drops every run stamped at or before
 * its epoch wherever that run comes from, so a tombstone for such a run can
 * never decide anything again — {@link applyClearEpoch} would have dropped it
 * anyway. A tombstone whose run cannot be placed in time is kept for as long
 * as the run it names could come back, which is forever: the epoch is exactly
 * the question an unstamped run cannot answer, and {@link applyClearEpoch}
 * keeps such a run for the same reason.
 *
 * @param {*} deleted - The tombstones
 * @param {number} clearedAt - Epoch milliseconds, 0 for "never cleared"
 * @returns {Array<{id: string, at: number|null}>} The survivors
 */
export function pruneTombstones(deleted, clearedAt) {
    const epoch = Number(clearedAt) || 0;
    const entries = [...toTombstoneMap(deleted)].map(([id, at]) => ({ id, at }));
    if (!(epoch > 0)) return entries;
    return entries.filter((entry) => entry.at === null || entry.at > epoch);
}

/**
 * Drop the runs a tombstone names.
 *
 * The counterpart of {@link applyClearEpoch} for single removals, and applied
 * in the same three places: on the way in from storage, to the stored side of
 * every merging write, and to the fold a pull uses.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {*} deleted - The tombstones
 * @returns {Array<Object>} The survivors — the same array when nothing went
 */
export function applyTombstones(runs, deleted) {
    const list = Array.isArray(runs) ? runs : [];
    const map = toTombstoneMap(deleted);
    if (map.size === 0) return list;
    const kept = list.filter((run) => !map.has(runIdentity(run)));
    return kept.length === list.length ? list : kept;
}

/**
 * Fold a downloaded run history into this device's, for a sync pull.
 *
 * The history is a set of observations — each device sees the runs its own
 * party did — so the only fold that cannot lose data is a union by run
 * identity. Two devices that watched different runs end up with both sets;
 * neither is "newer" than the other in any sense a whole-key write could use.
 *
 * The local copy wins an identity clash because it is the one that may have
 * been amended in place (a tier filled in from a chat annotation), the same
 * reason {@link mergeRuns} prefers memory.
 *
 * A union alone, though, is a union with the runs this device *removed*: a
 * peer that never saw a deletion still holds the run, and pushes it back. So
 * the tombstones are folded in too, and applied to both sides — the incoming
 * one because it may be carrying a run we deleted, the local one because it
 * may be carrying a run the peer deleted and we have not dropped yet.
 *
 * @param {Array<Object>} local - This device's runs
 * @param {Array<Object>} incoming - The downloaded runs
 * @param {*} [deleted] - The tombstones, as this device knows them
 * @returns {Array<Object>} The union, newest first
 */
export function mergeRunHistories(local, incoming, deleted) {
    const tombstones = toTombstoneMap(deleted);
    const merged = mergeRuns(Array.isArray(local) ? local : [], Array.isArray(incoming) ? incoming : [], tombstones);
    return applyTombstones(merged, tombstones);
}

/**
 * Fold two clear epochs: the later clear stands.
 *
 * A clear is a fact that only ever moves forward, and taking the max is what
 * stops a pull from a device that has not seen the clear from un-clearing the
 * device that has.
 *
 * @param {*} local - This device's epoch
 * @param {*} incoming - The downloaded epoch
 * @returns {number} The later of the two, 0 when neither is usable
 */
export function mergeClearEpochs(local, incoming) {
    return Math.max(Number(local) || 0, Number(incoming) || 0);
}

/**
 * How far ahead of this device's clock a marker may still be believed.
 *
 * A marker is always stamped `Date.now()` on the device that sets it, so one
 * arriving from ahead of us is clock skew between devices, and a few minutes
 * of that is ordinary. Beyond it the stamp describes no run that has happened
 * anywhere, and taking it at face value would be unrecoverable: the fold keeps
 * the later marker, so a device set a year fast would blank that dungeon's
 * average for a year and no press of "start the average here" on a correct
 * clock could lower it again.
 */
export const BASELINE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Whether one baseline stamp is a fact about runs rather than clock skew.
 *
 * @param {number} stamp - Epoch milliseconds
 * @param {number} horizon - The furthest future stamp still believed
 * @returns {boolean}
 */
function isUsableBaseline(stamp, horizon) {
    return stamp > 0 && (!Number.isFinite(horizon) || stamp <= horizon);
}

/**
 * Fold two baseline maps: per dungeon, the later marker stands.
 *
 * The same forward-only argument {@link mergeClearEpochs} makes, one entry at
 * a time — a device that has never seen a marker holds no entry (or an older
 * one) for that dungeon, and a whole-key write from it would put the stale
 * average straight back. Keys neither side shares are carried through, so two
 * devices marking different dungeons keep both marks.
 *
 * @param {*} local - This device's map
 * @param {*} incoming - The downloaded map
 * @returns {Record<string, number>} The per-key maximum
 */
export function mergeAverageBaselines(local, incoming, now = Date.now()) {
    const out = {};
    const horizon = Number(now) + BASELINE_FUTURE_TOLERANCE_MS;
    for (const side of [local, incoming]) {
        // An array is not a baseline map — its indices would fold in as
        // dungeon names — so a value of the wrong shape is dropped, not read
        if (!side || typeof side !== 'object' || Array.isArray(side)) continue;
        for (const [key, at] of Object.entries(side)) {
            const stamp = Number(at) || 0;
            if (!isUsableBaseline(stamp, horizon)) continue;
            if (stamp > (out[key] || 0)) out[key] = stamp;
        }
    }
    return out;
}

/**
 * The same instant with its month and day read the other way round.
 *
 * A stamp misread in the wrong field order produced a date whose month is the
 * true day and whose day is the true month; putting them back is the whole
 * repair. Only defined when both fields are 12 or less — a field over 12 could
 * only ever have been a day, so the digits already overruled the locale and
 * that endpoint was parsed correctly in the first place. The year and the
 * time-of-day are untouched: the misread never involved them.
 *
 * @param {Date} date - The date as it was stored
 * @returns {Date|null} The swapped date, or null when no swap is defined
 */
export function swapMonthDay(date) {
    if (!(date instanceof Date)) return null;
    const time = date.getTime();
    if (!Number.isFinite(time)) return null;
    const month = date.getMonth() + 1;
    const day = date.getDate();
    if (month > 12 || day > 12) return null;
    return new Date(
        date.getFullYear(),
        day - 1,
        month,
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds()
    );
}

/**
 * What a run misread in the wrong date field order should have said.
 *
 * The raw chat text is long gone, so the repair is arithmetic on the record
 * itself. Both of a run's endpoints went through the one parser, so both were
 * misread the same way: the end is `timestamp + duration`, and swapping the
 * two endpoints back gives the duration that was actually observed.
 *
 * Three things all have to hold before a record is touched, and a record that
 * fails any of them is returned as unrepairable rather than rewritten:
 *
 * 1. its stored duration is implausible — a plausible run was never misread in
 *    a way that mattered, and re-deriving it would be inventing a change;
 * 2. both endpoints are swappable (see {@link swapMonthDay});
 * 3. the re-derived duration is itself plausible.
 *
 * "Plausible" is the recovery bound the pace module already reasons with —
 * `RECOVERY_FALLBACK_MAX_MS`, 45 minutes — chosen over the history-derived
 * `plausibleMaxRunMs` deliberately: that bound is a median of the very records
 * being repaired, so a history full of month-long runs would vouch for them.
 *
 * @param {Object} run - A stored run
 * @param {number} [maxRunMs] - The longest a run may plausibly have taken
 * @returns {{timestamp: string, duration: number}|null} The repaired fields, or
 *   null when this record must be left exactly as it is
 */
export function rederiveSwappedRun(run, maxRunMs = RECOVERY_FALLBACK_MAX_MS) {
    const duration = Number(run?.duration);
    if (!Number.isFinite(duration)) return null;
    if (isPlausibleDuration(duration, maxRunMs)) return null;

    const start = runTime(run);
    if (start === null) return null;

    const trueStart = swapMonthDay(new Date(start));
    const trueEnd = swapMonthDay(new Date(start + duration));
    if (!trueStart || !trueEnd) return null;

    const trueDuration = trueEnd.getTime() - trueStart.getTime();
    if (!isPlausibleDuration(trueDuration, maxRunMs)) return null;

    return { timestamp: trueStart.toISOString(), duration: trueDuration };
}

/**
 * Whether a duration is one a dungeon run could have taken.
 *
 * @param {number} duration - Milliseconds, as every stored duration is
 * @param {number} maxRunMs - The longest a run may plausibly have taken
 * @returns {boolean}
 */
function isPlausibleDuration(duration, maxRunMs) {
    return Number.isFinite(duration) && duration > 0 && duration <= maxRunMs;
}

/**
 * The character the panel is currently speaking for.
 * @returns {{id: string|null, name: string|null}}
 */
export function currentCharacter() {
    return {
        id: dataManager.getCurrentCharacterId?.() ?? null,
        name: dataManager.getCurrentCharacterName?.() ?? null,
    };
}

class DungeonTrackerStorage {
    constructor() {
        this.unifiedStoreName = RUNS_STORE; // Unified storage for all runs

        /**
         * The stored list, newest first, once it has been read.
         *
         * Every run used to be saved by reading the whole list back from
         * IndexedDB, scanning it for a duplicate and writing it back, and every
         * panel refresh read it again; with a few hundred runs kept that was
         * most of the store's traffic. Memory is the truth between writes now:
         * every read and write goes through here, so the list is read once per
         * session and written only when it changes.
         */
        this._runs = null;
        /** The read in flight, so concurrent callers share one instead of each indexing its own copy */
        this._loading = null;
        /** teamKey → that team's runs (the same objects), for the duplicate check */
        this._byTeam = new Map();
        /**
         * The runs removed, identity → the removed run's own moment, so a
         * merge cannot resurrect them from a copy of the list written before
         * the delete landed. Persisted at {@link RUNS_DELETED_KEY} and synced,
         * because a *peer's* copy written before the delete is the one this
         * device cannot otherwise tell from a run it has simply never seen.
         */
        this._deleted = new Map();
        /**
         * Identities recorded again since a removal, so the fold that unions
         * the stored and downloaded tombstones in does not put the removal
         * back under this session's feet.
         *
         * Session-local on purpose. The revival is written out by dropping the
         * tombstone, which is all a reload needs; what it cannot outlive is a
         * *peer* that still holds the tombstone, and that is the right way
         * round. An identical identity is the same run seen again — a chat
         * backfill re-reading it — rather than a new one, because a genuine
         * re-run is stamped at its own moment and carries its own identity. A
         * deletion the user made must survive a backfill re-observing the run,
         * or no delete would ever stick.
         */
        this._revived = new Set();
        /** Whether the tombstones have changed since they were last written */
        this._deletedDirty = false;
        /** One read-merge-write at a time; two interleaved would each miss the other */
        this._persistChain = null;
        /** A deferred merge-and-write is armed, to tell a burst from a lone run */
        this._pendingTimer = null;
        /**
         * The clear epoch as last read or written, in epoch milliseconds.
         *
         * Held so every merging write can re-apply it: a sync pull unions the
         * downloaded history into the stored key, and the runs a clear already
         * forgot are exactly what a peer that never saw the clear sends back.
         */
        this._clearedAt = 0;
        /**
         * The average-baseline map as last read or written, or null until a
         * read has succeeded. A failed read must not cache an empty map: that
         * would read as "no dungeon has a marker" for the rest of the session.
         */
        this._averageBaselines = null;

        this._watchForTheEnd();
    }

    /**
     * Make the coalescing window survive the page going away.
     *
     * For the 250 ms a deferred save is armed, the run exists only in this
     * object: nothing has reached the store, so `storage.flushAll()` — which
     * the switch path and the store's own unload handling call — has nothing
     * of ours to drain. A tab closed, hidden or switched inside that window
     * lost the run outright. These handlers turn the armed save into an
     * immediate one first, which is the only point at which `flushAll` can
     * see it.
     *
     * `pagehide` is the reliable one on mobile Safari, `beforeunload`
     * elsewhere, and `visibilitychange` catches a tab that is backgrounded and
     * then discarded without either firing. All three run the same idempotent
     * flush, so firing two of them costs one no-op.
     * @private
     */
    _watchForTheEnd() {
        const flush = () => {
            this.flushPendingSave();
        };

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pagehide', flush);
            window.addEventListener('beforeunload', flush);
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flush();
            });
        }

        // The switch tears the old character's features down; a run recorded in
        // the last quarter-second belongs to the character leaving, and this is
        // the last moment it can be written under them
        if (typeof dataManager?.on === 'function') dataManager.on('character_switching', flush);
    }

    /**
     * The stored list, read on first use and held afterwards.
     *
     * A read that could not be made is not an empty history: the list stays
     * unloaded, this call answers empty, and a save will not write over
     * whatever is stored until a read has succeeded.
     * @returns {Promise<Array<Object>|null>} The live list, or null when storage could not be read
     * @private
     */
    async _loadRuns() {
        if (this._runs) return this._runs;
        // Only the *result* used to be memoised, not the read itself. Several
        // consumers ask for the history as their panels come up, so on a cold
        // session two or more reads of the same key ran at once and each one
        // `_index`ed its own copy of the stored list on arrival — including the
        // ones that arrived after a caller had already changed memory. The
        // outlier scrub is the loser: it runs at chat-annotation init, drops
        // the outliers from memory and asks for a merging write, and a read
        // still in flight puts them straight back, where `mergeRuns` keeps
        // them — `_deleted` only filters the *stored* side.
        if (this._loading) return this._loading;

        const read = (async () => {
            try {
                const probe = await storage.tryGet(RUNS_KEY, this.unifiedStoreName);
                if (probe === null) {
                    console.warn('[DungeonTrackerStorage] Run history could not be read');
                    return null;
                }
                const clearedProbe = await storage.tryGet(RUNS_CLEARED_KEY, this.unifiedStoreName);
                const deletedProbe = await storage.tryGet(RUNS_DELETED_KEY, this.unifiedStoreName);
                // A reset landing inside the read means this list is no longer
                // the one anyone asked for; indexing it would revive it
                if (this._loading !== read) return null;
                this._clearedAt = clearedProbe === null ? 0 : Number(clearedProbe.value) || 0;
                if (deletedProbe === null) {
                    // Not "nothing was ever removed": a read that failed. The
                    // set stays as it is, and the merging write folds the
                    // stored one back in rather than writing an empty one over
                    // it, so a failed read here costs suppression and not data.
                    console.warn('[DungeonTrackerStorage] Removed-run tombstones could not be read');
                } else {
                    const held = toTombstoneMap(deletedProbe.value);
                    this._adoptTombstones(mergeDeletedRuns(this._deleted, held));
                    // Either the prune dropped superseded entries or this
                    // session removed a run before the read landed; both want
                    // writing back
                    if (this._deleted.size !== held.size) this._deletedDirty = true;
                }
                const stored = Array.isArray(probe.value) ? probe.value : [];
                const kept = applyTombstones(applyClearEpoch(stored, this._clearedAt), this._deleted);
                this._index(kept);
                // A pull unioned runs the clear had already forgotten — or ones
                // removed one at a time — back into the stored key. Pruning
                // memory alone would leave them there to be re-read, and pushed
                // back out, so the prune is written.
                if (kept.length !== stored.length) await this._persistReplace();
                if (this._deletedDirty) await this._persistDeleted();
                return this._runs;
            } finally {
                if (this._loading === read) this._loading = null;
            }
        })();
        this._loading = read;
        return read;
    }

    /**
     * Take a folded tombstone list as the in-memory truth.
     *
     * Pruned against the clear epoch — a clear supersedes every tombstone it
     * already covers — and with anything recorded again since dropped, so the
     * fold that unions the stored and downloaded sets in cannot reinstate a
     * removal the user has undone by running the dungeon again.
     *
     * @param {Array<{id: string, at: number|null}>} entries - The folded set
     * @returns {Array<{id: string, at: number|null}>} What was adopted
     * @private
     */
    _adoptTombstones(entries) {
        const kept = pruneTombstones(entries, this._clearedAt).filter((entry) => !this._revived.has(entry.id));
        this._deleted = toTombstoneMap(kept);
        return kept;
    }

    /**
     * Record that a run was removed, so no copy of the list can bring it back.
     * @param {Object} run - The run going away
     * @private
     */
    _tombstone(run) {
        const { id, at } = tombstoneFor(run);
        this._revived.delete(id);
        this._deleted.set(id, at);
        this._deletedDirty = true;
    }

    /**
     * Record that a removed run was recorded again, and is wanted again.
     * @param {Object} run - The run as newly recorded
     * @private
     */
    _revive(run) {
        const id = runIdentity(run);
        // The overwhelmingly common case is a run that was never removed, and
        // it must not cost a tombstone write — a backfill appends dozens
        if (!this._deleted.has(id)) return;
        this._deleted.delete(id);
        this._revived.add(id);
        this._deletedDirty = true;
    }

    /**
     * Write the tombstones out, folding in whatever storage holds now.
     *
     * The same read-fold-write every other key here takes, for the same
     * reason: a second tab may have removed a run this copy has never heard
     * of, and a whole-key write would undo it.
     * @returns {Promise<boolean>} Whether the write landed
     * @private
     */
    async _persistDeleted() {
        const probe = await storage.tryGet(RUNS_DELETED_KEY, this.unifiedStoreName);
        if (probe === null) {
            console.warn('[DungeonTrackerStorage] Tombstones not saved: the stored set could not be read first');
            return false;
        }
        const merged = this._adoptTombstones(mergeDeletedRuns(probe.value, this._deleted));
        this._deletedDirty = false;
        return storage.setJSON(RUNS_DELETED_KEY, merged, this.unifiedStoreName, true);
    }

    /**
     * Take a list as the in-memory truth and rebuild the per-team index.
     * @param {Array<Object>} runs - Runs, newest first
     * @private
     */
    _index(runs) {
        this._runs = runs;
        this._byTeam = new Map();
        for (const run of runs) this._indexRun(run);
    }

    /**
     * @param {Object} run - A run now in the list
     * @private
     */
    _indexRun(run) {
        if (!run || typeof run.teamKey !== 'string') return;
        const list = this._byTeam.get(run.teamKey);
        if (list) list.push(run);
        else this._byTeam.set(run.teamKey, [run]);
    }

    /**
     * Write the in-memory list out, folding in whatever storage holds now.
     *
     * `allRuns` is a single account-wide key, so a second tab (or a second
     * character in the same party) writes it too. Taking memory for the whole
     * truth threw those runs away on the next save; the list is re-read and
     * merged first (see {@link mergeRuns}), which costs one read per save and
     * is the only thing that makes two tabs safe.
     *
     * A read that could not be made skips the write rather than overwriting
     * with a copy that may be missing runs — the same rule the load follows.
     * The merge is what costs: one `tryGet` plus a full sort of the history per
     * call. A chat backfill appends runs one at a time and asked for a save
     * after each, so N recovered runs paid for N reads and N sorts of a list
     * that was growing as it went. A deferred save is *coalesced* instead —
     * the first one arms a short timer and every save asked for while it is
     * armed does nothing, so the burst produces one read-merge-write with all
     * of the runs already in memory. An immediate save (a delete, a scrub)
     * still runs at once, and takes the armed one with it.
     *
     * @param {boolean} immediate - Skip the coalescing window and the write debounce
     * @returns {Promise<boolean>} Whether the write was issued — a deferred save
     *   answers true as soon as it is armed, since awaiting the timer would
     *   stall an append loop by the coalescing window on every run
     * @private
     */
    async _persist(immediate) {
        if (!immediate) {
            if (this._pendingTimer === null) {
                this._pendingTimer = setTimeout(() => {
                    this._pendingTimer = null;
                    this._persistNow(false);
                }, PERSIST_COALESCE_MS);
            }
            return true;
        }

        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        return this._persistNow(true);
    }

    /**
     * Read the stored list, merge memory into it and write it back, now.
     * @param {boolean} immediate - Passed through to the store's write debounce
     * @returns {Promise<boolean>} Whether the write was issued
     * @private
     */
    _persistNow(immediate) {
        const run = async () => {
            // Before the runs, so a crash between the two writes leaves the
            // removal recorded and the run still listed — which the next load
            // puts right — rather than the run gone with nothing saying why
            if (this._deletedDirty) await this._persistDeleted();
            const probe = await storage.tryGet(RUNS_KEY, this.unifiedStoreName);
            if (probe === null) {
                console.warn('[DungeonTrackerStorage] Runs not saved: the stored history could not be read first');
                return false;
            }
            const stored = applyClearEpoch(Array.isArray(probe.value) ? probe.value : [], this._clearedAt);
            const merged = mergeRuns(this._runs || [], stored, this._deleted);
            this._index(merged);
            const write = storage.setJSON(RUNS_KEY, merged, this.unifiedStoreName, immediate);
            // A debounced write resolves when its timer fires; awaiting it
            // would stall a backfill loop for the debounce delay on every run
            return immediate ? write : true;
        };
        this._persistChain = (this._persistChain || Promise.resolve()).then(run, run);
        return this._persistChain;
    }

    /**
     * Write the in-memory list out as the whole truth, without merging.
     *
     * Only "forget everything" wants this: a clear that merged would read back
     * the very runs it was asked to drop.
     * @returns {Promise<boolean>} Whether the write landed
     * @private
     */
    async _persistReplace() {
        const run = () => storage.setJSON(RUNS_KEY, this._runs, this.unifiedStoreName, true);
        this._persistChain = (this._persistChain || Promise.resolve()).then(run, run);
        return this._persistChain;
    }

    /**
     * Test-only: forget the in-memory list, so the next call reads storage again.
     * @returns {void}
     */
    _resetCache() {
        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        this._runs = null;
        this._loading = null;
        this._byTeam = new Map();
        this._deleted = new Map();
        this._revived = new Set();
        this._deletedDirty = false;
        this._persistChain = null;
        this._clearedAt = 0;
        this._averageBaselines = null;
    }

    /**
     * Run an armed deferred save now, if there is one.
     *
     * For a caller that has to know the history is on its way out — and for a
     * test that would otherwise have to advance a timer.
     * @returns {Promise<boolean>} Whether a write was issued
     */
    async flushPendingSave() {
        if (this._pendingTimer === null) return this._persistChain ? this._persistChain : false;
        return this._persist(true);
    }

    /**
     * Get dungeon+tier key
     * @param {string} dungeonHrid - Dungeon action HRID
     * @param {number} tier - Difficulty tier (0-2)
     * @returns {string} Storage key
     */
    getDungeonKey(dungeonHrid, tier) {
        return `${dungeonHrid}::T${tier}`;
    }

    /**
     * Get dungeon info from game data
     * @param {string} dungeonHrid - Dungeon action HRID
     * @returns {Object|null} Dungeon info or null
     */
    getDungeonInfo(dungeonHrid) {
        const actionDetails = dataManager.getActionDetails(dungeonHrid);
        if (!actionDetails) {
            return null;
        }

        // Extract name from HRID (e.g., "/actions/combat/chimerical_den" -> "Chimerical Den")
        const namePart = dungeonHrid.split('/').pop();
        const name = namePart
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        // Get max waves from nested combatZoneInfo.dungeonInfo.maxWaves
        let maxWaves = actionDetails.combatZoneInfo?.dungeonInfo?.maxWaves || 0;

        // Fallback to hardcoded values if not found in game data
        if (maxWaves === 0 && DUNGEON_MAX_WAVES[dungeonHrid]) {
            maxWaves = DUNGEON_MAX_WAVES[dungeonHrid];
        }

        return {
            name: actionDetails.name || name,
            maxWaves: maxWaves,
        };
    }

    /**
     * Get statistics for a dungeon by name (for chat-based runs)
     * @param {string} dungeonName - Dungeon display name
     * @returns {Promise<Object>} Statistics
     */
    async getStatsByName(dungeonName) {
        const allRuns = await this.getAllRuns();
        const runs = allRuns.filter((r) => r.dungeonName === dungeonName);

        if (runs.length === 0) {
            return {
                totalRuns: 0,
                avgTime: 0,
                fastestTime: 0,
                slowestTime: 0,
                avgWaveTime: 0,
            };
        }

        // Use 'duration' field (chat-based) or 'totalTime' field (websocket-based)
        const durations = runs.map((r) => r.duration || r.totalTime || 0);
        const totalTime = durations.reduce((sum, d) => sum + d, 0);
        const avgTime = totalTime / runs.length;
        const fastestTime = Math.min(...durations);
        const slowestTime = Math.max(...durations);

        const avgWaveTime = runs.reduce((sum, run) => sum + (run.avgWaveTime || 0), 0) / runs.length;

        return {
            totalRuns: runs.length,
            avgTime,
            fastestTime,
            slowestTime,
            avgWaveTime,
        };
    }

    /**
     * Get team key from sorted player names
     * @param {Array<string>} playerNames - Array of player names
     * @returns {string} Team key (sorted, comma-separated)
     */
    getTeamKey(playerNames) {
        return playerNames.sort().join(',');
    }

    /**
     * The newest run already loaded into memory for one team, read
     * synchronously.
     *
     * For chat annotation's stored-run fallback: that pass runs synchronously,
     * inside a per-message loop, and cannot await an IndexedDB read partway
     * through it. `_runs` is kept newest-first — the initial load sorts it so,
     * and a save unshifts each new run onto the front — so the first match in a
     * linear scan is the newest. Answers null before the initial load has
     * completed, or when this team has nothing stored yet; neither is treated
     * as an error, since the caller has further fallbacks and bounds of its own.
     *
     * Read-only: unlike every other accessor below it does not go through
     * {@link DungeonTrackerStorage#_loadRuns}, on purpose — it must not trigger
     * a load or block on one, only report what a load already put in memory.
     *
     * @param {string} teamKey - The team to look up
     * @returns {{dungeonName: string, timestamp: string}|null} The newest
     *   stored run this team has, or null
     */
    getNewestLoadedRunForTeam(teamKey) {
        if (!teamKey || !Array.isArray(this._runs)) return null;
        for (const run of this._runs) {
            if (run?.teamKey === teamKey && run?.dungeonName) {
                return { dungeonName: run.dungeonName, timestamp: run.timestamp };
            }
        }
        return null;
    }

    /**
     * Save a team-based run (from backfill)
     * @param {string} teamKey - Team key (sorted player names)
     * @param {Object} run - Run data
     * @param {string} run.timestamp - Run start timestamp (ISO string)
     * @param {number} run.duration - Run duration (ms)
     * @param {string} run.dungeonName - Dungeon name (from Phase 2)
     * @param {string|null} [run.dungeonHrid] - Dungeon action, where the recording route knew it
     * @param {number|null} [run.tier] - Difficulty tier, where the recording route knew it
     * @param {boolean} [run.validated] - False for a run timed by the client's own clock
     *   (a solo run, which has no party "Key counts" messages to time it by). Defaults
     *   to true, which is what every party and backfill run has always been.
     * @param {boolean} [run.startRecovered] - True when the run's start was recovered from the
     *   chat log rather than watched; such a run may not set the recovery plausibility bound
     * @param {string} [run.source] - Where the run came from: 'chat' (default) or 'tracker'
     * @returns {Promise<boolean>} Success status
     */
    async saveTeamRun(teamKey, run) {
        // Who saw this run — read before the load, not after it. The load is a
        // real IndexedDB round trip on the first save of a session, and the
        // caller reaches here after awaits of its own, so a character switch
        // landing in between stamped this character's run with the arriving
        // character's name. `runMatchesCharacter` trusts the stamp absolutely,
        // so the run then disappears from the character who actually ran it and
        // shows up under one who was never in it — permanently, and skewing
        // every per-character average built off that view.
        const recorder = currentCharacter();
        const allRuns = await this._loadRuns();
        if (!allRuns) {
            console.warn('[DungeonTrackerStorage] Run not saved: the stored history could not be read first');
            return false;
        }

        // Parse incoming timestamp
        const newTimestamp = new Date(run.timestamp).getTime();

        // The one instant both recording routes can state exactly. The tracker
        // banks the server's millisecond stamp for the key count that opened
        // the run; the chat backfill can only read that same message's rendered
        // stamp, which the game prints truncated to the second. Truncating both
        // is what makes the two records of one run identical rather than merely
        // close - the precision the chat never had is dropped instead of being
        // absorbed by a tolerance.
        const startSecond = Math.floor(newTimestamp / 1000) * 1000;

        // Check for duplicates. Only this team's runs can match, so only they
        // are looked at.
        const existing = (this._byTeam.get(teamKey) || []).find((r) => {
            const existingTimestamp = new Date(r.timestamp).getTime();

            // Exact: one team cannot begin two runs in the same second, so a
            // record already sitting on this second is this run seen by the
            // other route. Checked before the tolerance below and without
            // consulting the duration, because the two routes measure the run
            // from stamps of different precision and need not agree on it.
            if (Math.floor(existingTimestamp / 1000) * 1000 === startSecond) return true;

            const timeDiff = Math.abs(existingTimestamp - newTimestamp);
            const durationDiff = Math.abs(r.duration - run.duration);

            // Consider duplicate if:
            // - Within 10 seconds of each other (handles timestamp precision differences)
            // - Same team
            // - Duration within 2 seconds (handles minor timing differences)
            return timeDiff < 10000 && durationDiff < 2000;
        });
        const isDuplicate = Boolean(existing);

        // A chat backfill never sees a tier or a wave; the live tracker does.
        // When the two routes record the same run, the one that knew fills it
        // in — and a later chat sighting must never erase what the tracker kept
        if (existing) {
            let filled = false;
            if (existing.tier == null && Number.isInteger(run.tier)) {
                existing.tier = run.tier;
                filled = true;
            }
            if (!existing.dungeonHrid && run.dungeonHrid) {
                existing.dungeonHrid = run.dungeonHrid;
                filled = true;
            }
            if (!existing.waveTimes && Array.isArray(run.waveTimes) && run.waveTimes.length > 0) {
                existing.waveTimes = [...run.waveTimes];
                existing.avgWaveTime = Number.isFinite(run.avgWaveTime) ? run.avgWaveTime : null;
                filled = true;
            }
            if (filled) await this._persist(false);
        }

        if (!isDuplicate) {
            // Create unified format run
            const team = teamKey.split(',').sort();
            const unifiedRun = {
                recordedBy: recorder.id,
                recordedByName: recorder.name,
                timestamp: run.timestamp,
                dungeonName: run.dungeonName || 'Unknown',
                dungeonHrid: run.dungeonHrid || null,
                tier: Number.isInteger(run.tier) ? run.tier : null,
                team: team,
                teamKey: teamKey,
                duration: run.duration,
                // A solo run is timed by the wall clock, not the server's own
                // timestamps, and says so — see the tracker's solo save path
                validated: run.validated !== false,
                // A run whose start came back from the chat log rather than being
                // watched. Its duration is only as good as the bound that admitted
                // the anchor, so it may not set that bound for the next recovery
                startRecovered: run.startRecovered === true,
                source: run.source || 'chat',
                waveTimes: Array.isArray(run.waveTimes) && run.waveTimes.length > 0 ? [...run.waveTimes] : null,
                avgWaveTime: Number.isFinite(run.avgWaveTime) ? run.avgWaveTime : null,
                keyCountsMap: run.keyCountsMap || null, // Include key counts if available
            };

            // Add to front of list (most recent first)
            allRuns.unshift(unifiedRun);
            this._indexRun(unifiedRun);
            // A run recorded again after being deleted is wanted again
            this._revive(unifiedRun);

            // Memory is authoritative and every reader goes through it, so the
            // write takes the normal debounce — a backfill of dozens of runs
            // lands as one write
            await this._persist(false);

            return true;
        }

        return false;
    }

    /**
     * Get all runs (unfiltered)
     * @returns {Promise<Array>} All runs
     */
    async getAllRuns() {
        const runs = await this._loadRuns();
        // A copy: the list held here is what the next save appends to, and a
        // caller that sorted or spliced the live one would reorder the store
        return runs ? [...runs] : [];
    }

    /**
     * Remove the run(s) recorded at a timestamp.
     * @param {string} timestamp - The run's ISO timestamp, as stored
     * @returns {Promise<boolean>} Whether the write landed
     */
    async deleteRun(timestamp) {
        const allRuns = await this._loadRuns();
        if (!allRuns) return false;
        const kept = [];
        for (const run of allRuns) {
            if (run.timestamp === timestamp) this._tombstone(run);
            else kept.push(run);
        }
        this._index(kept);
        return this._persist(true);
    }

    /**
     * Forget every stored run.
     * @returns {Promise<boolean>} Whether the write landed
     */
    async clearAllRuns() {
        // An armed deferred save would read the stored list back and merge the
        // very runs this was asked to forget
        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        this._index([]);
        // The epoch is what survives the round trip: a peer that never saw this
        // clear will push its whole history back, and the union that folds it in
        // has nothing else to tell those runs from ones recorded since.
        this._clearedAt = Date.now();
        await storage.setJSON(RUNS_CLEARED_KEY, this._clearedAt, this.unifiedStoreName, true);
        // The clear supersedes every tombstone it covers, which is why the set
        // is pruned here rather than emptied: a tombstone for a run the epoch
        // cannot place is still the only thing keeping that run away.
        this._deletedDirty = true;
        await this._persistDeleted();
        return this._persistReplace();
    }

    /**
     * When "delete all history" was last pressed, as this device knows it.
     *
     * The same epoch {@link applyClearEpoch} drops stored runs by, exposed so
     * the populations kept outside the run store - the chat pass remembers the
     * runs it has already labelled, which have scrolled out of chat and so
     * cannot be rebuilt from the DOM - can be pruned by the very same fact.
     * Reading it is only meaningful after the history has been loaded once.
     *
     * @returns {number} Epoch milliseconds, 0 when nothing was ever cleared
     */
    clearedAt() {
        return Number(this._clearedAt) || 0;
    }

    /**
     * The runs removed, as this device knows them.
     *
     * Exposed for the sync fold: a merge is registered as a pure
     * `(local, incoming)` per key, so the one folding the run history has no
     * other way to reach the tombstones. Reading it before the history has
     * been loaded answers what this session has removed and no more, which is
     * why the load prunes again — the fold suppresses what it can, and the
     * next load is what makes it right whatever order the pull wrote the keys.
     *
     * @returns {Map<string, number|null>} Identity → the removed run's moment
     */
    deletedIdentities() {
        return this._deleted;
    }

    /**
     * Where each dungeon's chat average is asked to start from.
     *
     * @returns {Promise<Record<string, number>>} `teamKey::dungeonName` → epoch
     *   milliseconds. Empty when nothing is marked, and empty when the read
     *   could not be made — but only the former is cached.
     */
    async getAverageBaselines() {
        if (this._averageBaselines) return this._averageBaselines;
        const probe = await storage.tryGet(AVERAGE_BASELINE_KEY, this.unifiedStoreName);
        if (probe === null) {
            console.warn('[DungeonTrackerStorage] Average baselines could not be read');
            return {};
        }
        // Folded with nothing, purely for the shape and skew checks the fold
        // already makes — a stored map is no more trustworthy than a
        // downloaded one, since a pull writes downloaded markers straight in
        this._averageBaselines = mergeAverageBaselines(probe.value, null);
        return this._averageBaselines;
    }

    /**
     * Mark one dungeon's average as starting now.
     *
     * The stored map is re-read and folded first, for the same reason every
     * other write here merges: a second tab (or a device that pulled since)
     * may hold a marker this copy has never seen, and a whole-map write would
     * drop it. The fold is {@link mergeAverageBaselines}, so a marker only
     * ever moves forward.
     *
     * @param {string} statsKey - `teamKey::dungeonName`, as the annotations build it
     * @param {number} [at] - Epoch milliseconds; defaults to now
     * @returns {Promise<boolean>} Whether the write landed
     */
    async setAverageBaseline(statsKey, at = Date.now()) {
        if (!statsKey) return false;
        const stamp = Number(at) || 0;
        if (!(stamp > 0)) return false;

        const probe = await storage.tryGet(AVERAGE_BASELINE_KEY, this.unifiedStoreName);
        if (probe === null) {
            console.warn('[DungeonTrackerStorage] Average baseline not saved: the stored map could not be read first');
            return false;
        }
        const merged = mergeAverageBaselines(this._averageBaselines, probe.value);
        merged[statsKey] = Math.max(merged[statsKey] || 0, stamp);
        this._averageBaselines = merged;
        return storage.setJSON(AVERAGE_BASELINE_KEY, merged, this.unifiedStoreName, true);
    }

    /**
     * The dungeon the panel's "average starts here" button should mark.
     *
     * The newest stored run's own team and dungeon: whatever was last run is
     * what the user is looking at when they press it. Null when no stored run
     * carries both, which is the case the button must refuse rather than guess.
     *
     * @returns {Promise<string|null>} `teamKey::dungeonName`, or null
     */
    async latestStatsKey() {
        // getAllRuns answers newest-first, so the first complete run wins
        for (const run of await this.getAllRuns()) {
            if (run?.teamKey && run?.dungeonName) return `${run.teamKey}::${run.dungeonName}`;
        }
        return null;
    }

    /**
     * Every run, or only the ones this character recorded.
     *
     * The identity is resolved *before* the store is read, not after. The read
     * can take a moment — a cold `allRuns` is an IndexedDB round trip — and a
     * character switch landing inside it used to move `currentCharacter()` out
     * from under the narrowing, so the caller that asked "my runs" as one
     * character was handed the *other* character's runs and could not tell.
     * Capturing first means the answer always belongs to whoever asked; a
     * caller that also has to decide whether the answer is still worth using
     * checks that itself (`dungeon-tracker.js` does, around its own await).
     *
     * @param {string} [filterCharacter] - 'mine' (default) or 'all'
     * @returns {Promise<Array>} Runs
     */
    async getRunsForCharacter(filterCharacter = 'mine') {
        const asker = currentCharacter();
        return filterRunsForCharacter(await this.getAllRuns(), filterCharacter, asker);
    }

    /**
     * Put right the runs a mm/dd-vs-dd/mm misread mangled, once and for all.
     *
     * For as long as the tracker had four copies of a parser that read a
     * `[dd/mm hh:mm:ss]` chat stamp as mm/dd, a day-first client misread every
     * day of 12 or less as a month. Both of a run's endpoints went through it,
     * so a 14-minute clear could be written down as 29 days. The parsers are
     * fixed; these records are not, and the raw chat text was never kept — so
     * the repair is arithmetic on the record itself (see
     * {@link rederiveSwappedRun}).
     *
     * Deliberately conservative, and deliberately not a scrub: nothing is
     * deleted, and a record whose repair cannot be derived confidently is left
     * exactly as it was. An untouched wrong record is better than an invented
     * right one, and {@link DungeonTrackerStorage#scrubOutlierRuns} — which
     * this runs in front of, so a repairable run is mended before it can be
     * judged an outlier — already removes the grossest of what is left.
     *
     * One pass ever, guarded by {@link RUNS_DATE_REPAIR_KEY}: a second pass
     * over already-correct records could only ever make them wrong.
     *
     * @returns {Promise<number>} How many runs were re-derived
     */
    async repairSwappedDateRuns() {
        const marker = await storage.tryGet(RUNS_DATE_REPAIR_KEY, this.unifiedStoreName);
        if (marker === null) {
            // A repair that cannot read its own marker cannot know it has not
            // already run, and running twice is the one thing it must not do
            console.warn('[DungeonTrackerStorage] Date-order repair skipped: its marker could not be read');
            return 0;
        }
        if (Number(marker.value) > 0) return 0;

        const allRuns = await this._loadRuns();
        if (!allRuns) {
            console.warn('[DungeonTrackerStorage] Date-order repair skipped: the stored history could not be read');
            return 0;
        }

        let repaired = 0;
        let leftAlone = 0;
        for (const run of allRuns) {
            const fixed = rederiveSwappedRun(run);
            if (!fixed) {
                if (!isPlausibleDuration(Number(run?.duration), RECOVERY_FALLBACK_MAX_MS)) leftAlone++;
                continue;
            }
            // The identity is the (team, timestamp, duration) triple, so a
            // repair changes it: the pre-repair identity has to be tombstoned
            // or the merging write would read the broken copy straight back in
            // beside the mended one.
            this._tombstone(run);
            run.timestamp = fixed.timestamp;
            run.duration = fixed.duration;
            repaired++;
        }

        // Written whatever happened, and only after the pass: the point of the
        // marker is that this never runs a second time.
        if (repaired > 0) await this._persist(true);
        await storage.setJSON(RUNS_DATE_REPAIR_KEY, Date.now(), this.unifiedStoreName, true);

        console.log(
            `[DungeonTrackerStorage] Date-order repair: re-derived ${repaired} run(s); ` +
                `left ${leftAlone} implausible run(s) as recorded (an endpoint was not swappable, ` +
                `or the swap was no more plausible); ${allRuns.length - repaired - leftAlone} were already plausible`
        );
        return repaired;
    }

    /**
     * Remove runs whose duration is more than 3× the median for their dungeon+team group.
     * Only scrubs groups with at least 5 runs (not enough data below that to be confident).
     * @returns {Promise<number>} Number of runs removed
     */
    async scrubOutlierRuns() {
        const allRuns = await this.getAllRuns();
        if (allRuns.length === 0) return 0;

        // Group by dungeonName + teamKey
        const groups = new Map();
        for (let i = 0; i < allRuns.length; i++) {
            const run = allRuns[i];
            const key = `${run.dungeonName}||${run.teamKey}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ run, index: i });
        }

        const outlierIndices = new Set();

        for (const [groupKey, entries] of groups) {
            if (entries.length < 5) continue;

            const durations = entries
                .map((e) => e.run.duration || e.run.totalTime || 0)
                .filter((d) => d > 0)
                .sort((a, b) => a - b);

            if (durations.length < 5) continue;

            const mid = Math.floor(durations.length / 2);
            const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

            const threshold = median * 3;

            for (const { run, index } of entries) {
                const duration = run.duration || run.totalTime || 0;
                if (duration > threshold) {
                    outlierIndices.add(index);
                    console.warn(
                        `[DungeonTrackerStorage] Scrubbing outlier run: ${groupKey} ` +
                            `duration=${Math.round(duration / 1000)}s median=${Math.round(median / 1000)}s threshold=${Math.round(threshold / 1000)}s`
                    );
                }
            }
        }

        if (outlierIndices.size === 0) return 0;

        const cleaned = [];
        for (let i = 0; i < allRuns.length; i++) {
            if (outlierIndices.has(i)) this._tombstone(allRuns[i]);
            else cleaned.push(allRuns[i]);
        }
        this._index(cleaned);
        await this._persist(true);
        console.log(`[DungeonTrackerStorage] Scrubbed ${outlierIndices.size} outlier run(s) from storage`);
        return outlierIndices.size;
    }

    /**
     * Get runs filtered by dungeon and/or team
     * @param {Object} filters - Filter options
     * @param {string} filters.dungeonName - Filter by dungeon name (optional)
     * @param {string} filters.teamKey - Filter by team key (optional)
     * @returns {Promise<Array>} Filtered runs
     */
    async getFilteredRuns(filters = {}) {
        const allRuns = await this.getAllRuns();

        let filtered = allRuns;

        if (filters.dungeonName && filters.dungeonName !== 'all') {
            filtered = filtered.filter((r) => r.dungeonName === filters.dungeonName);
        }

        if (filters.teamKey && filters.teamKey !== 'all') {
            filtered = filtered.filter((r) => r.teamKey === filters.teamKey);
        }

        return filtered;
    }

    /**
     * Get all teams with stored runs
     * @returns {Promise<Array>} Array of {teamKey, runCount, avgTime, bestTime, worstTime}
     */
    async getAllTeamStats() {
        const allRuns = await this.getAllRuns();

        // Group by teamKey
        const teamGroups = {};
        for (const run of allRuns) {
            if (!run.teamKey) continue; // Skip solo runs (no team)

            if (!teamGroups[run.teamKey]) {
                teamGroups[run.teamKey] = [];
            }
            teamGroups[run.teamKey].push(run);
        }

        // Calculate stats for each team
        const results = [];
        for (const [teamKey, runs] of Object.entries(teamGroups)) {
            const durations = runs.map((r) => r.duration);
            const avgTime = durations.reduce((a, b) => a + b, 0) / durations.length;
            const bestTime = Math.min(...durations);
            const worstTime = Math.max(...durations);

            results.push({
                teamKey,
                runCount: runs.length,
                avgTime,
                bestTime,
                worstTime,
            });
        }

        return results;
    }
}

const dungeonTrackerStorage = new DungeonTrackerStorage();

/*
 * The run history is a growth-only record in a store the `everything` sync
 * scope carries, and until now it claimed no fold at all — so every pull wrote
 * the downloaded list over the local one whole. That is data loss without
 * anyone deleting anything: two devices that each recorded runs kept only
 * whichever copy the pull happened to take, and the dungeon pace figures are
 * computed from what is left. A union by run identity is the only fold that
 * cannot lose a run. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: RUNS_STORE,
    key: RUNS_KEY,
    merge: (local, incoming) => mergeRunHistories(local, incoming, dungeonTrackerStorage.deletedIdentities()),
    label: 'Dungeon run history',
});

/*
 * And the runs removed one at a time beside it, folded as a union — a removal
 * is forward-only exactly as a clear is, and a peer that never saw one holds
 * the run still. Without this key every single removal was undone by the next
 * pull: a run deleted by hand, an outlier the scrub dropped, and worst, the
 * broken copy a date repair replaced — the repair changes a run's identity, so
 * the mangled twin came back *beside* the mended one and poisoned the pace
 * median rather than merely reappearing.
 */
registerSyncMerge({
    store: RUNS_STORE,
    key: RUNS_DELETED_KEY,
    merge: mergeDeletedRuns,
    label: 'Dungeon runs removed',
});

/*
 * The clear epoch beside it, so "Delete all run history" is not undone by the
 * union above the moment a peer that never saw it pushes its copy back.
 */
registerSyncMerge({
    store: RUNS_STORE,
    key: RUNS_CLEARED_KEY,
    merge: mergeClearEpochs,
    label: 'Dungeon run history clear',
});

/*
 * The date-order repair marker, folded the same forward-only way. Without a
 * fold a pull from a device that has not run the one-time repair would clear
 * this device's marker and set the pass going again — over records it has
 * already mended, which is the one input it was never designed for.
 */
registerSyncMerge({
    store: RUNS_STORE,
    key: RUNS_DATE_REPAIR_KEY,
    merge: mergeClearEpochs,
    label: 'Dungeon run date-order repair',
});

/*
 * And the per-dungeon average baselines, folded one entry at a time. Without a
 * fold a pull would write the whole map over, which is a marker set on this
 * device coming undone — the resurrection shape the clear watermark above
 * already had to be given a fold to avoid.
 */
registerSyncMerge({
    store: RUNS_STORE,
    key: AVERAGE_BASELINE_KEY,
    merge: mergeAverageBaselines,
    label: 'Dungeon average baselines',
});

export default dungeonTrackerStorage;
