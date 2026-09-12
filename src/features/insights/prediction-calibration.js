/**
 * Prediction calibration
 *
 * Keeps the profit calculators honest by writing down what they promised and
 * what the run actually paid.
 *
 * Every profit figure in this script is a forecast: drop rates times prices
 * times an efficiency model, none of which anybody checks against a finished
 * run. A stale price, a buff the model does not know about or a drop table the
 * game changed all read the same way — a confident number that is quietly wrong
 * for weeks. The loot log already records what each run produced, so the
 * comparison costs nothing but the bookkeeping.
 *
 * ## What counts as a pair
 *
 * A prediction is snapshotted for the **running** action, the moment it is first
 * seen, because that is when the gear, teas and prices behind the forecast are
 * the ones the run is actually being played with. The pair is written when that
 * run is superseded by a newer one — the game's own signal that it finished.
 *
 * Runs that were already over when the page loaded are deliberately skipped. A
 * prediction computed now against a run played under yesterday's gear is not a
 * calibration measurement, it is noise dressed as one.
 *
 * ## Nothing here is written by hand
 *
 * The predicted side calls the same `calculateGatheringProfit` /
 * `calculateProductionProfit` the action panels display, and the actual side
 * uses the loot log's own profit arithmetic. Reimplementing either would mean
 * this feature could disagree with the panels and still call itself calibrated.
 */

import config from '../../core/config.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { clearRecord, clearedRecord, entriesOf, mergeClearable } from '../../utils/cleared-record.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { calculateProductionProfit } from '../actions/production-profit.js';
import { LootLogStats } from '../actions/loot-log-stats.js';
import itemFlowRecorder from '../networth/item-flow-recorder.js';
import { GATHERING_TYPES, PRODUCTION_TYPES } from '../../utils/profit-constants.js';
import { runInBackground } from '../../utils/background-work.js';
import { scriptVersion } from '../../utils/script-version.js';

/** Shares the loot log's store; the key is this feature's own */
const STORE_NAME = 'lootLogHistory';

/** Enough history to see a trend, small enough to keep in memory and redraw */
const MAX_RECORDS = 1000;

/** Oldest first, the order the ledger is kept in */
const oldestFirst = (a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0);

/**
 * Fold the stored ledger under the one in memory: the union by record id,
 * memory's copy winning, oldest first, the newest MAX_RECORDS kept.
 * @param {Array<Object>} stored - The stored ledger
 * @param {Array<Object>} memory - The in-memory ledger
 * @returns {Array<Object>}
 */
function unionCalibrationRecords(stored, memory) {
    return mergeById((record) => record?.id, oldestFirst)(stored, memory).slice(-MAX_RECORDS);
}

/**
 * The union above, with Clear's epoch applied.
 *
 * Clear empties the ledger, and a union cannot say so — a peer's still-full
 * copy wins the next pull and the pairs it just threw away come straight
 * back, on the device that cleared them. `t` is when a pair was written (the
 * run's own `endTime`, falling back to the moment it was recorded, so it is
 * never absent), which is what lets a pair recorded on another device after
 * the clear survive it. See utils/cleared-record.js.
 */
export const mergeCalibrationRecords = mergeClearable(unionCalibrationRecords, (record) => record?.t, {
    label: 'prediction calibration',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE_NAME,
    base: 'calibration',
    merge: mergeCalibrationRecords,
    label: 'Prediction calibration',
});

/** Under a minute a run's actual rate is mostly rounding on the clock */
export const MIN_DURATION_SEC = 60;

/**
 * How long the live-recorder fallback waits after a gathering run ends before
 * writing its own pair, so a `loot_log_updated` message for the same run — the
 * panel happened to be open for at least the end of it — can claim the run
 * first. `pending`/`recorded` then refuse this path's write outright once that
 * happens, which is the whole rule: a finished run is one measurement, and
 * whichever side names it first is the one that counts.
 *
 * This stands in for `addSpanExcess` (`gold-sources.js`), which reconciles two
 * recordings of a continuous stretch by crediting only the excess one saw
 * beyond the other. That does not fit here: a calibration pair is a single
 * finished run, not a day's total, so there is no partial span to divide
 * between the loot log and the recorder — only "which one gets to name this
 * run's actual", decided by whichever writes first once the grace period
 * passes with nobody having claimed it. See `_finishLiveRun` and `_recordFromLive`.
 */
export const LIVE_FALLBACK_GRACE_MS = 5000;

/**
 * The skill an action belongs to, as the loot log names it.
 * @param {string} actionHrid - e.g. `/actions/milking/cow`
 * @returns {string} e.g. `milking`
 */
export function actionTypeOf(actionHrid) {
    const parts = (actionHrid || '').split('/');
    return parts.length >= 3 ? parts[2] : 'unknown';
}

class PredictionCalibration {
    constructor() {
        this.initialized = false;
        this.records = null;
        this.unregisterHandlers = [];
        /** characterActionId → the forecast taken while it was running */
        this.pending = new Map();
        /** Ids already written, so a repeated loot log message does not double up */
        this.recorded = new Set();
        /**
         * The gathering run `_onActionCompleted` is currently watching, so the
         * live-recorder fallback notices when it ends even though the loot log
         * panel is closed: `{id, actionHrid, count, owner}` or null when nothing
         * gathering is running.
         */
        this._liveRun = null;
        /** Grace-period timers from `_finishLiveRun`, so `disable()` can cancel them */
        this._liveTimers = new Set();
        /** Serialises the async handler against itself */
        this.queue = Promise.resolve();
        this.lootLogMath = null;
        // The ledger on disk, kept through the shared load/save discipline: a
        // read that could not be made keeps the pairs in memory rather than
        // blanking them, and a save folds in what another tab wrote rather
        // than overwriting it. Character-scoped under `calibration_<id>`.
        this.store = createPersistedRecord({
            base: 'calibration',
            store: STORE_NAME,
            empty: () => clearedRecord(),
            merge: mergeCalibrationRecords,
            migrate: 'discard',
            label: 'PredictionCalibration',
        });
        /** Whose pairs the record in memory holds; a change means forget them first */
        this.owner = null;
    }

    /**
     * The record, with the departing character's pairs forgotten when the
     * character has changed since: the key is resolved per access, and what is
     * in memory must never be written under another character's key.
     * @returns {Object} The persisted record
     */
    _store() {
        const owner = dataManager.getCurrentCharacterId() || null;
        if (this.owner !== null && owner !== this.owner) {
            this.store.reset();
            this.records = null;
            this.recorded.clear();
        }
        this.owner = owner;
        return this.store;
    }

    /** Take the (merged) record back into the fields the rest reads */
    _sync() {
        this.records = entriesOf(this.store.get());
        for (const record of this.records) this.recorded.add(record.id);
    }

    /**
     * Start recording.
     * @returns {Promise<boolean>} Whether the feature is on — the caller puts up
     *   the tile only when it is
     */
    async initialize() {
        if (this.initialized) return true;
        if (!config.getSetting('insights_calibration', true)) return false;

        const handler = (data) => this._onLootLog(data);
        webSocketHook.on('loot_log_updated', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('loot_log_updated', handler));

        // The loot log only arrives while its panel is open; this is how a run
        // still gets measured through hours it never was. See `_onActionCompleted`.
        const actionHandler = (data) => this._onActionCompleted(data);
        dataManager.on('action_completed', actionHandler);
        this.unregisterHandlers.push(() => dataManager.off('action_completed', actionHandler));

        // Nobody is looking at the panel yet, and this is a storage read
        this.ready = runInBackground('predictionCalibration', () => this._load());

        this.initialized = true;
        return true;
    }

    /**
     * Where this character's pairs live.
     * @returns {string|null} Storage key, or null before the character is known
     */
    _key() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `calibration_${charId}` : null;
    }

    /**
     * Read the stored pairs into memory, once.
     * @returns {Promise<Array<Object>>} The records
     */
    async _load() {
        const key = this._key();
        if (!key) {
            this.records = this.records || [];
            return this.records;
        }
        try {
            const store = this._store();
            // Pairs written before the read landed are folded under what is
            // stored; a read that could not be made keeps them as they are
            store.set(clearedRecord(this.records || []));
            await store.load();
            this._sync();
        } catch (error) {
            console.error('[PredictionCalibration] Could not read history:', error);
            this.records = this.records || [];
        }
        return this.records;
    }

    /**
     * Handle a loot_log_updated message.
     *
     * Queued rather than run straight away: the messages arrive faster than the
     * profit calculators return, and two overlapping passes would each decide
     * the same run still needed recording.
     *
     * @param {Object} data - The message
     */
    _onLootLog(data) {
        if (!Array.isArray(data?.lootLog) || data.lootLog.length === 0) return;
        const entries = [...data.lootLog];
        this.queue = this.queue.then(() => this._process(entries)).catch(() => {});
    }

    /**
     * Snapshot the running action's forecast, and write pairs for the runs it
     * has replaced.
     * @param {Array<Object>} entries - Loot log entries
     */
    async _process(entries) {
        if (this.ready) await this.ready;
        this._store();
        if (!this.records) await this._load();
        // Captured after the load has settled ownership, so a switch racing the
        // load itself is already accounted for by `_store()`'s reset above.
        const owner = this.owner;

        const sorted = entries
            .filter((entry) => entry?.characterActionId && entry.actionHrid)
            .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        if (!sorted.length) return;

        const [running, ...finished] = sorted;

        // The forecast belongs to the run that is happening now — taken later it
        // would be measured against whatever the character is wearing later
        if (!this.pending.has(running.characterActionId) && !this.recorded.has(running.characterActionId)) {
            const predicted = await this._predict(running.actionHrid);
            // `_predict` can take a while (it runs the same calculators the
            // action panels use), long enough for a character switch to land
            // mid-await. `disable()` already cleared `pending` for the
            // departing character by then; filing this forecast afterwards
            // would revive it under whoever is current now — a stale pair
            // filed for a run that was never played under that character's
            // gear, prices or teas, and if that character's own ledger loads
            // before the matching "finished" entry is processed, a run that
            // was actually the departing character's would be written into
            // the arriving character's history as if it were theirs.
            if (predicted !== null && dataManager.getCurrentCharacterId() === owner) {
                this.pending.set(running.characterActionId, { predicted, at: Date.now() });
            }
        }

        // Same race, same guard: a switch during the predict above must not
        // let this pass write finished runs into whoever is current now.
        if (dataManager.getCurrentCharacterId() !== owner) return;

        let changed = false;
        for (const entry of finished) {
            if (await this._record(entry)) changed = true;
        }

        if (changed && dataManager.getCurrentCharacterId() === owner) await this._save();
    }

    /**
     * Write one finished run, if it has a forecast waiting for it.
     * @param {Object} entry - Loot log entry
     * @returns {Promise<boolean>} Whether anything was added
     */
    async _record(entry) {
        const id = entry.characterActionId;
        if (this.recorded.has(id)) return false;

        const forecast = this.pending.get(id);
        // No forecast means the run was over before the script saw it start
        if (!forecast) return false;
        this.pending.delete(id);

        const durationSec = (new Date(entry.endTime) - new Date(entry.startTime)) / 1000;
        if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) return false;

        const actual = this._actual(entry, durationSec);
        if (actual === null) return false;

        this.records.push({
            id,
            actionHrid: entry.actionHrid,
            actionType: actionTypeOf(entry.actionHrid),
            t: new Date(entry.endTime).getTime() || Date.now(),
            durationSec,
            actionCount: entry.actionCount || 0,
            predicted: forecast.predicted,
            actual: actual.perHour,
            actualBid: actual.perHourBid,
            // The cohort marker: which script's calculators made the forecast.
            // Without it an engine fix mid-ledger reads as prediction drift.
            v: scriptVersion(),
        });
        this.recorded.add(id);

        if (this.records.length > MAX_RECORDS) {
            const dropped = this.records.splice(0, this.records.length - MAX_RECORDS);
            for (const record of dropped) this.recorded.delete(record.id);
        }
        return true;
    }

    /**
     * What the calculators say this action is worth per hour, right now.
     * @param {string} actionHrid - Action HRID
     * @returns {Promise<number|null>} Profit per hour, or null when not forecastable
     */
    async _predict(actionHrid) {
        try {
            const type = dataManager.getActionDetails(actionHrid)?.type;
            let data = null;
            if (GATHERING_TYPES.includes(type)) {
                data = await calculateGatheringProfit(actionHrid);
            } else if (PRODUCTION_TYPES.includes(type)) {
                data = await calculateProductionProfit(actionHrid);
            }
            // Alchemy has no per-action forecast to check. Combat and enhancing
            // do, but not here: their forecasts live elsewhere (the all-zones
            // sim, the enhancement chain) and their own recorders —
            // combat-calibration.js and enhancement-calibration.js — pair them.
            if (!data || data.hasMissingPrices) return null;
            return Number.isFinite(data.profitPerHour) ? data.profitPerHour : null;
        } catch (error) {
            console.error('[PredictionCalibration] Prediction failed:', error);
            return null;
        }
    }

    /**
     * What the run actually paid per hour, by the loot log's own arithmetic.
     * @param {Object} entry - Loot log entry
     * @param {number} durationSec - How long the run took
     * @returns {{perHour: number, perHourBid: number}|null}
     */
    _actual(entry, durationSec) {
        try {
            if (!this.lootLogMath) this.lootLogMath = new LootLogStats();
            const profit = this.lootLogMath.calculateProfit(entry);
            if (!profit || !Number.isFinite(profit.askProfit)) return null;
            const hours = durationSec / 3600;
            if (hours <= 0) return null;
            return { perHour: profit.askProfit / hours, perHourBid: profit.bidProfit / hours };
        } catch (error) {
            console.error('[PredictionCalibration] Actual profit failed:', error);
            return null;
        }
    }

    /**
     * Watch gathering completions directly, independent of the loot log: the
     * game only sends `loot_log_updated` while that panel is open, so it is the
     * only trigger the pairing logic above has, and a run played with the panel
     * never opened is never measured at all.
     *
     * Shares `this.pending` (the forecast snapshot) and `this.recorded` (the
     * dedupe set) with the loot-log path rather than keeping its own: a run is
     * measured once, whichever side notices it first.
     *
     * @param {Object} data - An `action_completed` payload
     */
    _onActionCompleted(data) {
        try {
            const action = data?.endCharacterAction;
            if (!action?.actionHrid) return;
            const owner = action.characterID;
            const charId = dataManager.getCurrentCharacterId();
            if (owner !== undefined && owner !== null && String(owner) !== String(charId)) return;

            const type = dataManager.getActionDetails(action.actionHrid)?.type;
            if (!GATHERING_TYPES.includes(type)) {
                this._finishLiveRun();
                return;
            }

            // Not stringified: `pending`/`recorded` are shared with the loot-log
            // path, which keys them by `entry.characterActionId` as-is (a Map/Set,
            // so `1` and `"1"` would be two different keys and defeat the dedupe).
            // `itemFlowRecorder` reads its own object-keyed rows fine either way.
            const id = action.id ?? action.actionHrid;
            if (!this._liveRun || this._liveRun.id !== id) {
                this._finishLiveRun();
                this._liveRun = { id, actionHrid: action.actionHrid, count: 0, owner: charId };
                this._snapshotLive(id, action.actionHrid, charId);
            }
            this._liveRun.count += 1;
        } catch (error) {
            console.error('[PredictionCalibration] Watching a gathering completion failed:', error);
        }
    }

    /**
     * Snapshot a forecast for a run the loot log has not already claimed —
     * shares `pending` with `_process()`, so whichever side notices the run
     * first is the one whose snapshot stands.
     * @param {string} id - The run's id
     * @param {string} actionHrid - What it is running
     * @param {string|null} owner - Whose run this is, so a switch mid-predict
     *   cannot file it under the arriving character
     */
    async _snapshotLive(id, actionHrid, owner) {
        if (this.pending.has(id) || this.recorded.has(id)) return;
        const predicted = await this._predict(actionHrid);
        if (predicted === null) return;
        if (this.pending.has(id) || this.recorded.has(id)) return;
        if (dataManager.getCurrentCharacterId() !== owner) return;
        this.pending.set(id, { predicted, at: Date.now() });
    }

    /**
     * The gathering run being watched has ended (a different run started, or a
     * non-gathering action did) — wait `LIVE_FALLBACK_GRACE_MS` before writing
     * its own pair, so a loot log message for the same run can claim it first.
     * See `LIVE_FALLBACK_GRACE_MS` for why this replaces `addSpanExcess` here.
     */
    _finishLiveRun() {
        if (!this._liveRun) return;
        const { id, actionHrid, count, owner } = this._liveRun;
        this._liveRun = null;

        const timer = setTimeout(() => {
            this._liveTimers.delete(timer);
            this._recordFromLive(id, actionHrid, count, owner).catch((error) =>
                console.error('[PredictionCalibration] Recording from the live recorder failed:', error)
            );
        }, LIVE_FALLBACK_GRACE_MS);
        this._liveTimers.add(timer);
    }

    /**
     * Write a pair from the item flow recorder's own gathering data, for a run
     * the loot log never reported — either the panel was never open during it,
     * or it was and already wrote the pair, in which case `this.recorded`
     * refuses this write outright.
     * @param {string} id - The run's id
     * @param {string} actionHrid - What it was running
     * @param {number} actionCount - Completions counted while watching it
     * @param {string|null} owner - Whose run this is
     * @returns {Promise<boolean>} Whether a pair was written
     */
    async _recordFromLive(id, actionHrid, actionCount, owner) {
        if (this.recorded.has(id)) return false;
        const forecast = this.pending.get(id);
        if (!forecast) return false;

        const totals = await itemFlowRecorder.getRunGathering(id);
        if (!totals?.gained || Object.keys(totals.gained).length === 0) return false;

        const durationSec = (totals.to - totals.from) / 1000;
        if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) return false;

        if (!this.lootLogMath) this.lootLogMath = new LootLogStats();
        const profit = this.lootLogMath.calculateProfit({ actionHrid, actionCount, drops: totals.gained });
        if (!profit || !Number.isFinite(profit.askProfit)) return false;
        const hours = durationSec / 3600;
        if (hours <= 0) return false;

        // A standalone write, like addRecord() rather than _record(): it must
        // notice a character switch and persist itself, there being no batch
        // pass around it to do either.
        if (this.ready) await this.ready;
        this._store();
        if (this.owner !== owner) return false;
        if (!this.records) await this._load();
        if (this.owner !== owner || this.recorded.has(id)) return false;

        this.pending.delete(id);
        this.records.push({
            id,
            actionHrid,
            actionType: actionTypeOf(actionHrid),
            t: Date.now(),
            durationSec,
            actionCount,
            predicted: forecast.predicted,
            actual: profit.askProfit / hours,
            actualBid: profit.bidProfit / hours,
            v: scriptVersion(),
        });
        this.recorded.add(id);

        if (this.records.length > MAX_RECORDS) {
            const dropped = this.records.splice(0, this.records.length - MAX_RECORDS);
            for (const old of dropped) this.recorded.delete(old.id);
        }
        await this._save();
        return true;
    }

    /**
     * Persist the pairs, folding in what another tab wrote meanwhile. Skipped
     * when storage cannot be read first. `clear()` writes through
     * `clearRecord` instead — the one intentional wipe.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async _save() {
        const key = this._key();
        if (!key) return false;
        try {
            const store = this._store();
            store.set(clearedRecord(this.records || []));
            const landed = await store.save();
            this._sync();
            return landed;
        } catch (error) {
            console.error('[PredictionCalibration] Could not save history:', error);
            return false;
        }
    }

    /**
     * Add a pair another recorder measured — combat, whose forecast is the
     * all-zones sim rather than a profit calculator, arrives this way.
     *
     * Same ledger, same trimming, same dedupe: a pair is a pair whatever
     * produced it, and a second store would mean a panel reading two histories
     * that can disagree about what has been measured.
     *
     * @param {Object} record - `{id, actionType, predicted, actual, t, ...}`,
     *   shaped like the records `_record` writes; extra fields ride along
     * @returns {Promise<boolean>} Whether it was new
     */
    async addRecord(record) {
        if (!record?.id) return false;
        if (this.ready) await this.ready;
        // Notice a character switch before touching the ledger, so the pair
        // joins the arriving character's rather than the departing one's
        this._store();
        if (!this.records) await this._load();
        if (this.recorded.has(record.id)) return false;

        // Every pair carries its cohort marker, whoever measured it — a
        // caller that stamped its own version keeps it
        const stamped = record.v === undefined ? { ...record, v: scriptVersion() } : record;
        this.records.push(stamped);
        this.recorded.add(record.id);
        if (this.records.length > MAX_RECORDS) {
            const dropped = this.records.splice(0, this.records.length - MAX_RECORDS);
            for (const old of dropped) this.recorded.delete(old.id);
        }
        await this._save();
        return true;
    }

    // ─── Read API ────────────────────────────────────────────────────────────

    /**
     * The pairs already in memory, for a panel that must draw synchronously.
     * @returns {Array<Object>|null} Records, or null before the first load lands
     */
    getCachedRecords() {
        return this.records;
    }

    /**
     * The pairs, loading them if this is the first ask.
     * @returns {Promise<Array<Object>>} Records, newest last
     */
    async getRecords() {
        if (!this.records) await this._load();
        return this.records;
    }

    /** Forget every recorded pair. */
    async clear() {
        this.records = [];
        this.recorded.clear();
        this.pending.clear();
        // Notice a character switch before writing, same as `_save()`
        this._store();
        // Stamped, so the clear also survives the next sync pull instead of
        // being restored by a peer whose copy still holds what was forgotten
        // (utils/cleared-record.js)
        await clearRecord(this.store);
        this._sync();
    }

    /** Cleanup when disabled. */
    disable() {
        for (const unregister of this.unregisterHandlers) unregister();
        this.unregisterHandlers = [];
        this.pending.clear();
        for (const timer of this._liveTimers) clearTimeout(timer);
        this._liveTimers.clear();
        this._liveRun = null;
        // The pairs are one character's; forgotten here so the next
        // initialize — which is how a character switch arrives — reads the
        // arriving character's rather than folding these into theirs
        this.store.reset();
        this.records = null;
        this.recorded.clear();
        this.owner = null;
        this.ready = null;
        this.initialized = false;
    }
}

const predictionCalibration = new PredictionCalibration();

// The feature module lives in `index.js`, which also brings up the panel — this
// file is only the recorder, so the panel can import it without a cycle.
export { predictionCalibration, PredictionCalibration };
export default predictionCalibration;
