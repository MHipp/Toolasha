/**
 * Labyrinth Fight Outcomes — predicted against actual
 *
 * A simulation can converge on a precise wrong answer, and no number of
 * extra trials will say so — only the game can. The server counts the
 * fights for us: a room beaten on the fifth try is one clear in five, and a
 * room walked away from is nought in however many. Set beside the rate the
 * sim predicted, that is a test the sim can fail.
 *
 * Mixed into LabyrinthClearRate, so every method here reads and writes the
 * singleton's own state (`this._outcomes`, `this._baseline`) and leans on its
 * forecasting methods for the prediction each observation is judged against.
 */

import dataManager from '../../core/data-manager.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';
import {
    readFloorRooms,
    foldFloorOutcomes,
    outcomeKey,
    accuracyRows,
    accuracySummary,
    accuracyBySubject,
    totalsSince,
    foldRoomResult,
} from './labyrinth-outcome-log.js';
import { createPersistedRecord } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { CLEAR_FOLD_LIMIT } from '../../utils/cleared-record.js';

/**
 * Deciding a side needs far fewer fights than measuring a rate
 *
 * Both this and the sim cache below are scoped per character and *discarded*
 * rather than adopted on migration: a win rate and a cached clear chance are
 * measurements of one character's power against a room, and handing the iron
 * cow the market cow's numbers would poison every verdict from there on. Keys
 * are resolved at each read and write — the user switches characters without
 * reloading the page.
 */
const OUTCOME_STORAGE_KEY = 'labyrinthFightOutcomes';
/** Bumped when the stored shape changes; older documents are read as bare totals */
const OUTCOME_STORAGE_VERSION = 2;
/** Legacy global values are dropped, not inherited — see OUTCOME_STORAGE_KEY */
export const DISCARD_LEGACY = { migrate: 'discard' };

/**
 * Fold the stored fight record under the one in memory.
 *
 * The totals are counters that only ever grow, so per room the bucket that
 * has counted more fights is the more complete one and wins whole — never a
 * field-by-field max, which would stitch clears from one count onto attempts
 * from another. A tab that recorded fights before its read landed keeps them
 * only when its bucket is the larger; the alternative, summing, would double
 * every fight both sides already share. The seen-set and the baseline are one
 * tab's working state and memory's copy wins.
 *
 * A stored document of another version is not merged at all: the version bump
 * exists to drop it, and that drop is the one intentional overwrite here.
 *
 * Reset is the exception to "fuller wins", and the reason for `clearedAt`. An
 * emptied record loses that comparison every time - the peer's fuller bucket
 * wins the pull, and the fights the user explicitly disowned come back to both
 * devices, leaving the panel's accuracy verdict a statement about runs the user
 * threw away. So the reset stamps a single epoch on the document, unioned as a
 * max, and any bucket that stopped counting before it is dropped rather than
 * weighed. Each bucket carries `updatedAt` (`stampOutcomeUpdates`), so a bucket
 * the other device counted into *after* the reset outlives it - the ordering
 * hazard the epoch exists to answer, and what a boolean could not.
 *
 * `stored` is this device's copy in both callers - the save fold reads it back,
 * and a sync pull hands it the local base - which is what the refusal tests.
 *
 * @param {Object|null} stored - The stored document
 * @param {Object} memory - The in-memory document
 * @returns {Object}
 */
export function mergeOutcomeDocuments(stored, memory) {
    const mine = memory || emptyOutcomeDocument();
    if (!stored || stored.version !== OUTCOME_STORAGE_VERSION) return mine;

    const totals = { ...(stored.totals || {}) };
    for (const [key, bucket] of Object.entries(mine.totals || {})) {
        const theirs = totals[key];
        totals[key] = theirs && bucketWeight(theirs) > bucketWeight(bucket) ? theirs : bucket;
    }

    const ourClear = Number(stored.clearedAt) || 0;
    const theirClear = Number(mine.clearedAt) || 0;
    let clearedAt = Math.max(ourClear, theirClear);
    let kept = dropClearedBuckets(totals, clearedAt);

    // The mass-delete refusal from custom-tabs-data.js: a fold must never be the
    // thing that empties the record. Held back whole - the epoch is not carried
    // either, so the next fold does not quietly finish what this one refused -
    // and only ever against a reset from elsewhere, since a device that already
    // holds the epoch is one that made or took the reset itself.
    const dropped = Object.keys(totals).length - Object.keys(kept).length;
    if (ourClear < theirClear && dropped > CLEAR_FOLD_LIMIT) {
        console.warn(
            `[LabyrinthClearRate] Refusing a fold that would drop ${dropped} outcome buckets at once on a reset ` +
                'this device did not make; every bucket is kept. Reset here to clear them.'
        );
        clearedAt = ourClear;
        kept = dropClearedBuckets(totals, clearedAt);
    }

    const seen = mine.seen && Object.keys(mine.seen).length ? mine.seen : stored.seen || {};
    // A baseline marked before the reset is a mark into a record that no longer
    // exists, and subtracting it from what has been counted since is nonsense
    const baseline = mine.baseline ?? stored.baseline ?? null;
    const document = {
        version: OUTCOME_STORAGE_VERSION,
        totals: kept,
        seen,
        baseline: !(clearedAt > 0) || (Number(baseline?.at) || 0) > clearedAt ? baseline : null,
    };
    // Not written unless something asked for it, so a record that has never been
    // reset stores exactly the shape it always did
    if (clearedAt > 0) document.clearedAt = clearedAt;
    return document;
}

/**
 * Drop every bucket that stopped counting before the reset.
 *
 * An unstamped bucket is one written before `updatedAt` existed - every fight in
 * it predates any reset that could be pending, so it goes, which is also the
 * bias a Reset behind a confirmation deserves.
 * @param {Object} totals - The merged buckets
 * @param {number} clearedAt - The reset epoch, 0 for a record never reset
 * @returns {Object} The buckets that outlived it
 */
function dropClearedBuckets(totals, clearedAt) {
    if (!(clearedAt > 0)) return totals;
    const kept = {};
    for (const [key, bucket] of Object.entries(totals)) {
        if ((Number(bucket?.updatedAt) || 0) > clearedAt) kept[key] = bucket;
    }
    return kept;
}

/**
 * Stamp the buckets a fold just changed with the moment it changed them.
 *
 * The stamp is what `mergeOutcomeDocuments` compares a reset against, and it
 * has to be per bucket rather than per document: the whole point is that a
 * bucket counted into after the reset survives one counted into before it.
 *
 * @param {Object} before - The totals as they were
 * @param {Object} after - The totals as the fold left them
 * @param {number} [now] - The stamp to write; injectable for tests
 * @returns {Object} `after`, with the changed buckets stamped
 */
export function stampOutcomeUpdates(before, after, now = Date.now()) {
    const stamped = {};
    for (const [key, bucket] of Object.entries(after || {})) {
        stamped[key] = (before || {})[key] === bucket ? bucket : { ...bucket, updatedAt: Number(now) || 0 };
    }
    return stamped;
}

/** How many things a bucket has counted — the measure of which copy is fuller */
function bucketWeight(bucket) {
    return (Number(bucket?.attempts) || 0) + (Number(bucket?.rooms) || 0);
}

/** A fresh document of the current shape */
function emptyOutcomeDocument() {
    return { version: OUTCOME_STORAGE_VERSION, totals: {}, seen: {}, baseline: null };
}

/**
 * The record on disk, kept through the shared load/save discipline: an
 * unreadable probe keeps the totals in memory, and a save folds in what
 * another tab stored rather than overwriting it.
 */
const outcomeRecord = createPersistedRecord({
    base: OUTCOME_STORAGE_KEY,
    store: 'settings',
    empty: emptyOutcomeDocument,
    merge: mergeOutcomeDocuments,
    migrate: 'discard',
    label: 'LabyrinthClearRate',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. The totals only ever grow, so a whole-key write — which is
 * what `importEverything` does to every key it is not told about — throws away
 * every fight the receiving device recorded and the sending one never saw, and
 * a clear rate is only as good as the fights behind it. The fold is the same
 * pure `(base, fresh)` function two tabs on one machine already share.
 *
 * Registration runs at import time, which is long before the earliest pull (the
 * staggered startup pull, 20s+ after load), so the registry is complete by the
 * time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: 'settings',
    base: OUTCOME_STORAGE_KEY,
    merge: mergeOutcomeDocuments,
    label: 'Labyrinth fight outcomes',
});

/** Prototype methods mixed into LabyrinthClearRate */
export const outcomeMethods = {
    /**
     * Bring the record in from storage.
     *
     * Separate from recording because reading it is not the same event as
     * adding to it. Loading only on the way in meant the record existed but
     * nothing that merely *reads* it — the console table, a tile's tooltip —
     * could see it until a labyrinth message happened to arrive, so a session
     * that had not entered the labyrinth yet reported nothing recorded.
     */
    async loadOutcomes() {
        if (this._outcomesLoaded) return;
        try {
            // Anything written before the stripped-room fix counted defeats and
            // nothing else — a cleared room stops naming its monster, so the
            // scan that looked for one never saw a single win. Those totals are
            // not a small sample of the truth, they are every loss and no
            // victory, so they are dropped rather than carried forward and
            // quietly poisoning every verdict from here on (the merge declines
            // any stored document of another version).
            //
            // A read that could not be made leaves memory alone and is retried
            // at the next call, so no record is ever written over on the
            // strength of a failed read.
            outcomeRecord.set(this._outcomeDocument());
            const readable = await outcomeRecord.load();
            this._adoptOutcomeDocument(outcomeRecord.get());
            this._outcomesLoaded = readable;
        } catch (error) {
            console.error('[LabyrinthClearRate] Loading fight outcomes failed:', error);
        }
    },

    /**
     * Write the record and the per-room state it is counted against.
     *
     * Folds in whatever another tab stored meanwhile and is skipped when
     * storage cannot be read first; `overwrite` is for the reset, which means
     * to lose the record.
     * @param {{overwrite?: boolean}} [options]
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveOutcomes({ overwrite = false } = {}) {
        try {
            outcomeRecord.set(this._outcomeDocument());
            const landed = await outcomeRecord.save({ overwrite });
            this._adoptOutcomeDocument(outcomeRecord.get());
            return landed;
        } catch (error) {
            console.error('[LabyrinthClearRate] Saving fight outcomes failed:', error);
            return false;
        }
    },

    /** The record as stored, from the singleton's fields */
    _outcomeDocument() {
        const document = {
            version: OUTCOME_STORAGE_VERSION,
            totals: this._outcomes || {},
            seen: this._outcomesSeen || {},
            baseline: this._baseline || null,
        };
        if (this._outcomesClearedAt > 0) document.clearedAt = this._outcomesClearedAt;
        return document;
    },

    /** Take a (merged) document back into the singleton's fields */
    _adoptOutcomeDocument(doc) {
        this._outcomes = doc?.totals || {};
        this._outcomesSeen = doc?.seen || {};
        this._baseline = doc?.baseline || null;
        this._outcomesClearedAt = Number(doc?.clearedAt) || 0;
    },

    /**
     * Forget the record in memory without touching storage — for a character
     * switch, so the next load reads the arriving character's record.
     */
    forgetOutcomes() {
        outcomeRecord.reset();
        this._outcomes = {};
        this._outcomesSeen = {};
        this._baseline = null;
        this._outcomesClearedAt = 0;
        this._outcomesLoaded = false;
        // The record's own generation covers what it holds; this one covers the
        // singleton's copy of it. A fold that started before the switch resumes
        // holding the departing character's rooms and, without this, adds them
        // to whatever `this._outcomes` is by then — the arriving character's.
        this._outcomeGeneration = (this._outcomeGeneration || 0) + 1;
    },

    /**
     * Which floor of which run the grid in hand belongs to.
     *
     * Attempts are counted as differences against the last sighting of each
     * square, so the sighting has to know which floor it was of. Coordinates
     * repeat on every floor.
     * @param {Object} labyrinth - The labyrinth payload
     * @returns {string}
     */
    outcomeScope(labyrinth) {
        return `${labyrinth?.startedAt || ''}|${Math.floor(Number(labyrinth?.currentFloor) || 0)}`;
    },

    /**
     * Everything the calculator claims about a room before you enter it.
     *
     * A fight's claim comes out of the sim cache and only exists once that tile
     * has been calculated. A skilling or enhancing room's is closed-form maths
     * and can be worked out on demand, which is why those rooms can be judged
     * from the first one you walk into while a fight cannot.
     *
     * @param {string} subjectHrid - Monster or skill
     * @param {number} roomLevel - Room level
     * @param {string} [kind] - 'combat' or 'skilling'; inferred from the hrid otherwise
     * @returns {Object|null} { clearChance, expectedSeconds, successChance, doubleChance, xpPerRoom, xpPerHour }
     */
    roomForecast(subjectHrid, roomLevel, kind) {
        const hrid = String(subjectHrid || '');
        const level = Math.max(0, Math.floor(Number(roomLevel) || 0));
        if (!hrid || level <= 0) return null;

        const skilling = kind === 'skilling' || hrid.startsWith('/skills/');
        if (!skilling) return this.getCachedCombatResult(hrid, level);

        try {
            return hrid === '/skills/enhancing'
                ? this.computeEnhancingClear(level)
                : this.computeSkillingClear(hrid, level);
        } catch (error) {
            console.error('[LabyrinthClearRate] Forecasting a skilling room failed:', error);
            return null;
        }
    },

    /** The clear chance the calculator is currently claiming for a room, or null */
    predictedClearChance(subjectHrid, roomLevel, kind) {
        const forecast = this.roomForecast(subjectHrid, roomLevel, kind);
        return forecast && Number.isFinite(forecast.clearChance) ? forecast.clearChance : null;
    },

    /**
     * Fold one finished room — its duration, experience and action outcomes —
     * into the record the accuracy view reads.
     * @param {Object} result - See foldRoomResult
     */
    async recordRoomResult(result) {
        if (!result?.subjectHrid) return;
        const started = this._outcomeGeneration || 0;
        await this.loadOutcomes();
        // The room was finished by the character this call started under. A
        // switch during the load means the totals now in memory are somebody
        // else's, and folding into them files one character's room under the
        // other's record.
        if ((this._outcomeGeneration || 0) !== started) return;
        this._outcomes = stampOutcomeUpdates(this._outcomes, foldRoomResult(this._outcomes, result));
        await this.saveOutcomes();
    },

    /**
     * Fold the current floor into the running record of how fights went.
     * @param {Object} labyrinth - The labyrinth payload, for its grid and floor
     */
    async recordOutcomes(labyrinth) {
        const roomData = labyrinth?.roomData;
        if (!roomData) return;
        const started = this._outcomeGeneration || 0;
        await this.loadOutcomes();
        // This grid is the departing character's floor if a switch landed in
        // the load — `forgetOutcomes()` emptied the totals for the arriving
        // character and this fold would put the departing one's rooms straight
        // back into them, under the arriving character's key
        if ((this._outcomeGeneration || 0) !== started) return;

        const folded = foldFloorOutcomes(this._outcomes, this._outcomesSeen, readFloorRooms(roomData), {
            scope: this.outcomeScope(labyrinth),
            predictedFor: (hrid, level, kind) => this.predictedClearChance(hrid, level, kind),
        });
        this._outcomes = stampOutcomeUpdates(this._outcomes, folded.totals);
        this._outcomesSeen = folded.seen;

        if (!folded.changed && !folded.seenChanged) return;
        await this.saveOutcomes();
    },

    /** What was actually observed for a monster at a level, if anything */
    observedOutcome(monsterHrid, roomLevel) {
        return this._outcomes[outcomeKey(monsterHrid, roomLevel)] || null;
    },

    /**
     * Print the current floor exactly as the server describes it, so what a
     * room looks like before and after it is cleared can be read rather than
     * inferred.
     *
     * Console: `Toolasha.Debug.labRooms()`
     * @returns {Array<Object>} One row per room cell
     */
    labRooms() {
        const rows = [];
        const grid = this.roomData;
        for (let y = 0; Array.isArray(grid) && y < grid.length; y++) {
            for (let x = 0; Array.isArray(grid[y]) && x < grid[y].length; x++) {
                const room = grid[y][x];
                if (!room) continue;
                rows.push({
                    coord: `${x},${y}`,
                    monster:
                        String(room.monsterHrid || '')
                            .split('/')
                            .pop() || '',
                    skill:
                        String(room.skillHrid || '')
                            .split('/')
                            .pop() || '',
                    type:
                        String(room.roomType || '')
                            .split('/')
                            .pop() || '',
                    level: room.recommendedLevel ?? '',
                    entries: room.entryCount ?? '',
                    cleared: !!room.isCleared,
                    keys: Object.keys(room).join(' '),
                });
            }
        }
        console.log(
            `[Toolasha] Floor ${this.currentFloor ?? '?'}: ${rows.length} rooms. ` +
                'Compare a cleared row against an uncleared one — "keys" shows what the server still sends for each.'
        );
        console.table(rows);
        return rows;
    },

    /**
     * The whole record, judged, for anything that wants to show it.
     * @returns {Promise<{rows: Array<Object>, summary: Object}>}
     */
    async accuracySnapshot({ since = false } = {}) {
        await this.loadOutcomes();
        const orderOf = (hrid) => this.subjectSortIndex(hrid);
        const totals = since && this._baseline ? totalsSince(this._outcomes, this._baseline.totals) : this._outcomes;
        const rows = accuracyRows(totals, {
            predictedFor: (hrid, level, kind) => this.predictedClearChance(hrid, level, kind),
            interval: wilsonInterval,
            orderOf,
        });
        return {
            rows,
            summary: accuracySummary(rows, wilsonInterval),
            bySubject: accuracyBySubject(rows, wilsonInterval, orderOf),
            baselineAt: this._baseline?.at || null,
            since: !!(since && this._baseline),
        };
    },

    /**
     * Where the game itself puts a monster or a skill.
     *
     * Read from the client data rather than listed here, so a monster added by
     * an update lands where the game puts it rather than at the bottom. A
     * subject the data has never heard of returns null and sorts last, which is
     * better than sorting to the top on an undefined.
     *
     * @param {string} subjectHrid - Monster or skill
     * @returns {number|string|null}
     */
    subjectSortIndex(subjectHrid) {
        const data = dataManager.getInitClientData();
        const details = data?.combatMonsterDetailMap?.[subjectHrid] || data?.skillDetailMap?.[subjectHrid];
        if (Number.isFinite(details?.sortIndex)) return details.sortIndex;
        // No index, but a name still orders better than nothing
        return details?.name || null;
    },

    /** Throw the fight record away and start counting again */
    async resetOutcomes() {
        this._outcomes = {};
        this._outcomesSeen = {};
        this._baseline = null;
        this._outcomesLoaded = true;
        // Stamped, so a peer that still holds the old buckets cannot restate
        // them on the next pull - see mergeOutcomeDocuments
        this._outcomesClearedAt = Date.now();
        // The one write meant to lose the record
        await this.saveOutcomes({ overwrite: true });
    },

    /**
     * Mark here, and keep everything before it.
     *
     * The question Reset was being used to answer — "has it been right *since* I
     * changed something?" — does not actually need the history destroyed. A copy
     * of the totals as they stand is enough to subtract later.
     *
     * @returns {Promise<Object>} The baseline that was set
     */
    async markOutcomeBaseline() {
        await this.loadOutcomes();
        this._baseline = { at: Date.now(), totals: structuredClone(this._outcomes) };
        await this.saveOutcomes();
        return this._baseline;
    },

    /** Forget the mark; the record itself is untouched either way */
    async clearOutcomeBaseline() {
        await this.loadOutcomes();
        this._baseline = null;
        await this.saveOutcomes();
    },

    /**
     * Set every predicted rate beside the rate actually observed, and say which
     * ones the record will not support.
     *
     * Console: `await Toolasha.Debug.labAccuracy()`
     * @returns {Promise<Array<Object>>} One row per monster and level seen
     */
    async labAccuracy() {
        const { rows, summary } = await this.accuracySnapshot();
        const pct = (v, places = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '');

        console.log(
            `[Toolasha] ${summary.attempts} labyrinth fights across ${summary.buckets} monster/level buckets.` +
                (summary.expected === null
                    ? ''
                    : ` Over the ${summary.judged} of them the sim had a rate for, it predicted ` +
                      `${summary.expected.toFixed(1)} clears and you got ${summary.judgedClears}.`) +
                `\n"likelihood" is how often the sim's own rate would produce a record this lopsided — a small number ` +
                'means the sim is being contradicted. Rows reading "not simmed" have no prediction on record and none ' +
                'cached; calculate their tile once and the next fights will be judged.'
        );
        console.table(
            rows.map((row) => ({
                room: row.monster,
                kind: row.kind,
                level: row.level,
                predicted: row.predicted === null ? 'not simmed' : pct(row.predicted),
                observed: `${row.clears}/${row.attempts}`,
                observedPct: pct(row.observed),
                range: `${pct(row.low, 0)}-${pct(row.high, 0)}`,
                verdict: row.verdict,
                likelihood: row.likelihood === null ? '' : pct(row.likelihood, 2),
                // Skilling rooms only: the server states the rate it is using,
                // so the formula can be checked against the truth rather than
                // only against a sample of outcomes
                calcSuccess: row.rates?.success ? pct(row.rates.success.predicted) : '',
                serverSuccess: row.rates?.success ? pct(row.rates.success.server) : '',
                hitSuccess: row.rates?.success ? pct(row.rates.success.observed) : '',
                formulaOff: row.rates?.success?.formulaOff ? 'YES' : '',
                seconds: row.timing ? `${Math.round(row.timing.actual)}s vs ${Math.round(row.timing.predicted)}s` : '',
                xpPerHour: row.measured?.xpPerHour ? Math.round(row.measured.xpPerHour).toLocaleString() : '',
            }))
        );
        return rows;
    },
};
