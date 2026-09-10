/**
 * Enhancement calibration
 *
 * Writes down, for every enhancement session that reached its target, where the
 * run landed in the distribution the calculator predicted for it.
 *
 * The enhancement tracker already keeps both halves: the prediction taken at
 * session start (mean, variance and physical minimum of the attempt count, all
 * off one Markov chain) and the attempts the run actually took. Nobody compares
 * them, so a chain that is quietly wrong about a tier of gear reads exactly
 * like one that is right. Unlike the profit calibrations, one session is never
 * "predicted 41, took 63, therefore off by 54%" — the distribution is heavy
 * tailed and a single draw only means anything as a percentile. That percentile
 * is what gets stored, and a *pattern* in the percentiles is what would convict
 * the chain: a calibrated model scatters them evenly, a flattering one piles
 * them up at the unlucky end.
 *
 * ## What counts as an observation
 *
 * A session that reached the target it was predicted for, whose prediction
 * carries its distribution. A session stopped by hand is censored — its attempt
 * count says where the player gave up, not where the run would have ended — and
 * a session recorded before the variance was stored has no distribution to be
 * a percentile of. Neither is an observation; recording them anyway would be
 * filling the ledger with numbers that mean nothing.
 *
 * The observed count is the current leg's — after an extension the prediction
 * was recomputed from the extension point, so the attempts diffed against it
 * must start there too.
 */

import config from '../../core/config.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { clearRecord, clearedRecord, entriesOf, mergeClearable } from '../../utils/cleared-record.js';
import dataManager from '../../core/data-manager.js';
import { SessionState, getCurrentLegCounters } from '../enhancement/enhancement-session.js';
import { attemptTailProbability } from '../enhancement/attempt-percentile.js';

/** Shares the calibration pairs' store; the key below is this recorder's own */
const STORE_NAME = 'lootLogHistory';

/** Plenty to see whether the percentiles scatter or pile up */
const MAX_RECORDS = 200;

/** Oldest first, the order the observations are kept in */
const oldestFirst = (a, b) => (Number(a?.t) || 0) - (Number(b?.t) || 0);

/**
 * Fold the stored observations under the ones in memory: the union by id,
 * memory's copy winning, oldest first, the newest MAX_RECORDS kept.
 * @param {Array<Object>} stored - The stored observations
 * @param {Array<Object>} memory - The in-memory observations
 * @returns {Array<Object>}
 */
function unionEnhancementRecords(stored, memory) {
    return mergeById((record) => record?.id, oldestFirst)(stored, memory).slice(-MAX_RECORDS);
}

/**
 * The union above, with Clear's epoch applied.
 *
 * Clear empties the observations, and a union cannot say so — a peer's
 * still-full copy wins the next pull and the observations it just threw away
 * come straight back, on the device that cleared them. `t` is a session's own
 * `endTime` (falling back to when it was recorded), never absent, which is
 * what lets an observation another device wrote after the clear survive it.
 * See utils/cleared-record.js.
 */
export const mergeEnhancementRecords = mergeClearable(unionEnhancementRecords, (record) => record?.t, {
    label: 'enhancement calibration',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE_NAME,
    base: 'calibrationEnhancing',
    merge: mergeEnhancementRecords,
    label: 'Enhancement calibration',
});

class EnhancementCalibration {
    constructor() {
        this.records = null;
        /** Serialises writes against each other and against the first load */
        this.queue = Promise.resolve();
        // The observations on disk, kept through the shared load/save
        // discipline: a read that could not be made keeps memory rather than
        // blanking it, and a save folds in what another tab wrote. Scoped
        // under `calibrationEnhancing_<id>`.
        this.store = createPersistedRecord({
            base: 'calibrationEnhancing',
            store: STORE_NAME,
            empty: () => clearedRecord(),
            merge: mergeEnhancementRecords,
            migrate: 'discard',
            label: 'EnhancementCalibration',
        });
        /** Whose observations the record in memory holds; a change means forget them first */
        this.owner = null;
    }

    /**
     * The record, with the departing character's observations forgotten when
     * the character has changed since, so they are never written under
     * another character's key.
     * @returns {Object} The persisted record
     */
    _store() {
        const owner = dataManager.getCurrentCharacterId() || null;
        if (this.owner !== null && owner !== this.owner) {
            this.store.reset();
            this.records = null;
        }
        this.owner = owner;
        return this.store;
    }

    /**
     * Where this character's observations live.
     * @returns {string|null} Storage key, or null before the character is known
     */
    _key() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `calibrationEnhancing_${charId}` : null;
    }

    /**
     * Read the stored observations into memory, once.
     * @returns {Promise<Array<Object>>} The records
     */
    async _load() {
        const key = this._key();
        if (!key) {
            this.records = this.records || [];
            return this.records;
        }
        const store = this._store();
        if (this.records && store.isLoaded()) return this.records;
        try {
            store.set(clearedRecord(this.records || []));
            await store.load();
            this.records = entriesOf(store.get());
        } catch (error) {
            console.error('[EnhancementCalibration] Could not read history:', error);
            this.records = this.records || [];
        }
        return this.records;
    }

    /**
     * Persist the observations, folding in what another tab wrote meanwhile.
     * Skipped when storage cannot be read first. `clear()` writes through
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
            this.records = entriesOf(store.get());
            return landed;
        } catch (error) {
            console.error('[EnhancementCalibration] Could not save history:', error);
            return false;
        }
    }

    /**
     * Record a session that just reached its target.
     *
     * Safe to call for any session in any state — everything that is not an
     * observation is declined here rather than at every call site.
     *
     * @param {Object} session - An enhancement session (see enhancement-session.js)
     * @returns {Promise<boolean>} Whether an observation was written
     */
    async recordCompletion(session) {
        if (!config.getSetting('insights_calibration', true)) return false;
        // Only a run that actually reached its target is a draw from the
        // predicted distribution; a hand-stopped one is censored at the moment
        // the player walked away
        if (!session || session.state !== SessionState.COMPLETED) return false;
        if (session.currentLevel < session.targetLevel) return false;

        const prediction = session.predictions;
        const observed = getCurrentLegCounters(session).attempts;
        if (!(observed > 0)) return false;

        const tail = attemptTailProbability(prediction, observed);
        // Null means the prediction carries no distribution — an old session,
        // or one predicted without character stats
        if (tail === null) return false;

        const record = {
            // One observation per session and target: an extended session is a
            // new prediction and may become a second observation
            id: `${session.id}:${session.targetLevel}`,
            t: session.endTime || Date.now(),
            itemHrid: session.itemHrid,
            itemName: session.itemName,
            targetLevel: session.targetLevel,
            protectFrom: session.protectFrom || 0,
            expectedAttempts: Math.round(prediction.expectedAttemptsExact ?? prediction.expectedAttempts),
            observedAttempts: observed,
            /** P(attempts ≥ observed) under the predicted distribution */
            tailProbability: tail,
        };

        let written = false;
        this.queue = this.queue
            .then(async () => {
                // Notice a character switch before touching the list
                this._store();
                await this._load();
                if (this.records.some((held) => held.id === record.id)) return;
                this.records.push(record);
                if (this.records.length > MAX_RECORDS) {
                    this.records.splice(0, this.records.length - MAX_RECORDS);
                }
                await this._save();
                written = true;
            })
            .catch((error) => {
                console.error('[EnhancementCalibration] Recording failed:', error);
            });
        await this.queue;
        return written;
    }

    // ─── Read API ────────────────────────────────────────────────────────────

    /**
     * The observations already in memory, for a panel drawing synchronously.
     * @returns {Array<Object>|null} Records, or null before the first load lands
     */
    getCachedRecords() {
        return this.records;
    }

    /**
     * The observations, loading them if this is the first ask.
     * @returns {Promise<Array<Object>>} Records, oldest first
     */
    async getRecords() {
        return await this._load();
    }

    /** Forget every observation. */
    async clear() {
        this.records = [];
        // Notice a character switch before writing, same as `_save()`
        this._store();
        // Stamped, so the clear also survives the next sync pull instead of
        // being restored by a peer whose copy still holds what was forgotten
        // (utils/cleared-record.js)
        await clearRecord(this.store);
        this.records = entriesOf(this.store.get());
    }

    /**
     * Forget the current character's observations without touching storage.
     *
     * This recorder is passive — nothing calls initialize()/disable() around
     * a character switch the way the other two calibrations do, since it has
     * no subscription to bring up. But getCachedRecords() (unlike getRecords())
     * returns `this.records` straight from memory without going through the
     * owner check in _store(), so without this the panel keeps showing the
     * departing character's observations under the arriving one's name until
     * an enhancement session happens to complete and call _store() itself.
     * Called from insights/index.js's cleanup() alongside the other two.
     */
    disable() {
        this.store.reset();
        this.records = null;
        this.owner = null;
    }
}

const enhancementCalibration = new EnhancementCalibration();

export { enhancementCalibration, EnhancementCalibration };
export default enhancementCalibration;
