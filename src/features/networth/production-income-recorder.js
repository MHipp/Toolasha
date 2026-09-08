/**
 * Production and offline income, recorded per day.
 *
 * ## Why this has to exist
 *
 * Every other source the gold attribution reads is already written down
 * somewhere: combat and gathering drops in the loot log, alchemy in its session
 * stores, enhancing in its sessions, trades in the ledger. Production is not.
 * The loot log does record what a cooking action produced, but never what it
 * consumed — and a production action that turns two hundred thousand of inputs
 * into two hundred and ten thousand of outputs added ten thousand to the
 * account, not two hundred and ten. Reading only the log would report the
 * gross as income and overstate a day of crafting several times over.
 *
 * So this records both halves as the actions complete, and stores the day's
 * running totals.
 *
 * ## What it can and cannot see
 *
 * The recipe and the number of actions completed are known exactly; the outputs
 * are what the recipe says they are. Rare extra drops from a production action
 * are *not* counted here — they land in the loot log, and counting them in both
 * places would be worse than counting them in neither. This is why the
 * attribution panel labels production as an estimate and everything else as
 * measured.
 *
 * Offline progress is recorded from the Welcome Back payload as it arrives.
 * Nothing that happened before this recorder existed can be recovered, which is
 * what the panel's coverage line is for.
 *
 * ## Storage
 *
 * One record per calendar month in the `networthHistory` store, holding one
 * small row per day. A day's row is rewritten as the day goes on; every earlier
 * month is settled and never touched again (see `utils/chunked-history.js`).
 * Deliberately not a new object store: adding one costs a database version bump,
 * and a per-month record beside the net worth series it is read with fits the
 * store's key budget without one.
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { calculateOfflineEconomics } from '../../utils/offline-economics-calculator.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';
import { getItemPrice } from '../../utils/market-data.js';
import { PRODUCTION_TYPES } from '../../utils/profit-constants.js';
import { localDayId, dayStart } from './gold-sources.js';

const STORE_NAME = 'networthHistory';
const RECORD_PREFIX = 'prodIncomeRec';

/** Beyond this, a day's row is dropped — the panel's longest window is 30 days */
const RETENTION_DAYS = 400;

/**
 * Which chunk a day row belongs to. Named so a row mutation can record the month it
 * touched without reaching into the store.
 * @param {Object} row - A day row
 * @returns {string} Chunk id
 */
const rowChunkId = (row) => timeChunkId(dayStart(row?.d), 'month');

/**
 * A day's production and offline income.
 *
 * `outputValue` and `inputValue` are kept apart rather than netted, so the panel
 * can show what a day of production grossed as well as what it actually added.
 *
 * @typedef {Object} ProductionDay
 * @property {string} d - Local day id, `YYYY-MM-DD`
 * @property {number} outputValue - What the recipes produced, at market
 * @property {number} inputValue - What they consumed, at market
 * @property {number} actions - Actions completed and valued
 * @property {number} offlineProfit - Net Welcome Back income recorded that day
 * @property {number} [unpricedActions] - Actions left out because an input or
 *   output had no market price; the day's production figure is short by these
 */

class ProductionIncomeRecorder {
    constructor() {
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            legacyKey: (charId) => `prodIncome_${charId}`,
            groupOf: rowChunkId,
            compare: (a, b) => String(a?.d || '').localeCompare(String(b?.d || '')),
            label: 'ProductionIncome',
        });

        /** The rows as they stand, which is the truth between debounced writes */
        this._rows = [];
        /** Months whose rows moved since the last save, so the rest are not re-serialised */
        this._touchedChunks = new Set();
        /** Whose rows those are */
        this._charId = null;
        /** The read in flight, so concurrent recordings wait on one of them */
        this._loading = null;
        /** characterActionId → the `currentCount` last seen, to derive a delta */
        this._counts = new Map();
        /**
         * Bumped whenever the character changes. Anything read under an old
         * generation belongs to the character who left, and adopting it would
         * file their days under the arriving character's key.
         */
        this._generation = 0;
        this._handlers = null;
        this.isActive = false;
    }

    /** @returns {string|null} Whose record, or null before login */
    _currentCharId() {
        return dataManager.getCurrentCharacterId?.() || null;
    }

    /**
     * Start recording.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isActive) return;

        this._handlers = {
            actionCompleted: (data) => this._onActionCompleted(data),
            characterInitialized: (data) => this._onCharacterInitialized(data),
            characterSwitching: () => this._forget(),
        };

        dataManager.on('action_completed', this._handlers.actionCompleted);
        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('character_switching', this._handlers.characterSwitching);

        this.isActive = true;
        await this.load();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (!this._handlers) return;
        dataManager.off('action_completed', this._handlers.actionCompleted);
        dataManager.off('character_initialized', this._handlers.characterInitialized);
        dataManager.off('character_switching', this._handlers.characterSwitching);
        this._handlers = null;
        this.isActive = false;
    }

    /** Forget the departing character's rows, so they are never written under the arriving one's key. */
    _forget() {
        this._generation += 1;
        this._rows = [];
        this._touchedChunks.clear();
        this._charId = null;
        this._loading = null;
        this._counts.clear();
        this._store.forget();
    }

    /**
     * Every recorded day, oldest first.
     *
     * A save hands the chunked store the whole list as the truth, and anything
     * the list does not mention has its record deleted — so a recording that
     * ran before the read landed would erase every month it had not seen. Every
     * write below therefore goes through this first, and concurrent callers
     * share the one read rather than racing two.
     *
     * @returns {Promise<Array<ProductionDay>>} The rows
     */
    async load() {
        const charId = this._currentCharId();
        if (!charId) return [];
        if (this._charId === charId && !this._loading) return [...this._rows];

        const generation = this._generation;

        if (!this._loading) {
            this._charId = charId;
            this._loading = (async () => {
                const rows = await this._store.load(charId);
                // The character switched while the read was in flight: these
                // are the departing character's days, and `_forget()` has
                // already cleared the fields this would otherwise refill
                if (this._generation !== generation) return;
                this._rows = rows;
            })();
        }

        try {
            await this._loading;
        } finally {
            if (this._generation === generation) this._loading = null;
        }
        return this._generation === generation ? [...this._rows] : [];
    }

    /**
     * The row for a day, created if the day is new.
     * @param {string} day - Local day id
     * @returns {ProductionDay} The live row
     */
    _rowFor(day) {
        let row = this._rows.find((entry) => entry.d === day);
        if (!row) {
            row = { d: day, outputValue: 0, inputValue: 0, actions: 0, offlineProfit: 0 };
            this._rows.push(row);
        }
        // Every mutation of a row goes through here, so this is the complete list of
        // months the next save has to re-serialise
        this._touchedChunks.add(rowChunkId(row));
        return row;
    }

    /**
     * Drop rows past retention and queue the write.
     *
     * Not awaited: the write is debounced, so its promise resolves when the
     * timer fires rather than when the data lands, and the entrypoint's
     * `flushAll()` on unload is what makes the last one stick.
     */
    _save() {
        if (!this._charId) return;

        const floor = localDayId(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const kept = this._rows.filter((row) => row.d >= floor);
        if (kept.length !== this._rows.length) this._rows = kept;

        // Retention can take days out of an older month without touching a row; the
        // store's per-chunk entry count is what notices that behind the hint.
        const changedChunks = this._touchedChunks;
        this._touchedChunks = new Set();
        this._store.save(this._charId, this._rows, { changedChunks });
    }

    /**
     * Record the outputs and inputs of a completed production action.
     * @param {Object} data - The `action_completed` payload
     * @returns {Promise<void>}
     */
    async _onActionCompleted(data) {
        try {
            if (!config.getSetting('networth_goldSources')) return;
            if (storage.isQuotaExceeded?.()) return;

            const action = data?.endCharacterAction;
            const actionHrid = action?.actionHrid;
            if (!actionHrid) return;

            const details = dataManager.getActionDetails(actionHrid);
            if (!details || !PRODUCTION_TYPES.includes(details.type)) return;

            const completed = this._completedSince(action);
            if (completed <= 0) return;

            // A missing price on either half is not a zero. An unpriced *input*
            // used to be skipped while its outputs were still counted, which
            // reports a recipe's whole gross as income — the exact overstatement
            // this recorder exists to avoid. So an action either has both halves
            // priced or it is not valued at all, and the day counts how many it
            // had to leave out so the panel can say the figure is short
            let outputValue = 0;
            let unpriced = false;
            for (const output of details.outputItems || []) {
                const unit = getItemPrice(output.itemHrid, { enhancementLevel: 0, context: 'networth' });
                if (Number.isFinite(unit)) outputValue += unit * (output.count || 0) * completed;
                else if ((output.count || 0) > 0) unpriced = true;
            }

            let inputValue = 0;
            for (const inputItem of details.inputItems || []) {
                const unit = getItemPrice(inputItem.itemHrid, { enhancementLevel: 0, context: 'networth' });
                if (Number.isFinite(unit)) inputValue += unit * (inputItem.count || 0) * completed;
                else if ((inputItem.count || 0) > 0) unpriced = true;
            }

            if (!unpriced && outputValue === 0 && inputValue === 0) return;
            if (!this._currentCharId()) return;

            const generation = this._generation;
            await this.load();
            // The character switched while the rows were being read; these
            // actions belong to whoever left
            if (this._generation !== generation) return;

            const row = this._rowFor(localDayId(Date.now()));
            if (unpriced) {
                row.unpricedActions = (row.unpricedActions || 0) + completed;
            } else {
                row.outputValue += outputValue;
                row.inputValue += inputValue;
                row.actions += completed;
            }
            this._save();
        } catch (error) {
            console.error('[ProductionIncome] Recording a completed action failed:', error);
        }
    }

    /**
     * How many actions completed since the last message for this action.
     *
     * `currentCount` is a running counter the server sends, and efficiency procs
     * make it jump by more than one — so the delta is the honest count and a
     * bare `+1` per message would undercount a fast crafting run badly. A
     * counter that went backwards is a new action wearing an old id; that
     * message counts as one and re-baselines.
     *
     * @param {Object} action - `endCharacterAction`
     * @returns {number} Actions completed
     */
    _completedSince(action) {
        const id = action?.id;
        const current = Number(action?.currentCount) || 0;
        if (id === undefined || id === null) return 1;

        const previous = this._counts.get(id);
        // Delete before setting so the entry moves to the end of the insertion
        // order: without it the eviction below drops the *first-seen* id, which
        // on a long-running action is the one still ticking, and re-baselining
        // it costs the next delta
        this._counts.delete(id);
        this._counts.set(id, current);

        // The map would otherwise grow with every action the character ever
        // queues over a long session
        if (this._counts.size > 200) {
            const oldest = this._counts.keys().next().value;
            this._counts.delete(oldest);
        }

        if (previous === undefined || current <= previous) return 1;
        return current - previous;
    }

    /**
     * Record a Welcome Back session's net income.
     * @param {Object} data - The `character_initialized` payload
     */
    _onCharacterInitialized(data) {
        try {
            this._forget();
            if (!config.getSetting('networth_goldSources')) return;

            const offlineItems = data?.offlineItems || [];
            if (offlineItems.length === 0) return;

            const economics = calculateOfflineEconomics({
                offlineItems,
                currentTimestamp: data.currentTimestamp,
                lastOfflineTime: data.character?.lastOfflineTime,
            });
            if (!Number.isFinite(economics?.profit) || economics.profit === 0) return;

            const when = Date.parse(data.currentTimestamp);
            const day = localDayId(Number.isFinite(when) ? when : Date.now());

            // The rows have to be read before one of them is added to, or the
            // save would take this single row for the whole history.
            // Gated on the generation the read started in, like every other
            // write path here: a character switch landing inside that read
            // leaves `_charId` naming the arriving character, and the
            // departing character's offline session was then filed — and
            // saved — under their key.
            const generation = this._generation;
            const record = async () => {
                await this.load();
                if (this._generation !== generation) return;
                this._rowFor(day).offlineProfit += economics.profit;
                this._save();
            };
            record().catch((error) => console.error('[ProductionIncome] Recording offline income failed:', error));
        } catch (error) {
            console.error('[ProductionIncome] Reading the offline summary failed:', error);
        }
    }
}

const productionIncomeRecorder = new ProductionIncomeRecorder();
export default productionIncomeRecorder;
