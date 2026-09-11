/**
 * Inventory movements the attribution cannot get from any other record,
 * recorded as they happen.
 *
 * ## Why a mirror of the inventory
 *
 * `items_updated` and `action_completed` carry ABSOLUTE counts for the rows that
 * changed, never deltas, and by the time a listener hears either message the
 * data manager has already written the new count over the old one. So this keeps
 * its own last-seen count per inventory row and diffs each message against it.
 * The mirror is seeded from the whole inventory whenever the character is
 * initialised (login, reconnect, switch), so a Welcome Back summary's gains are
 * never read as a delta: the offline row counts those.
 *
 * ## Gathering
 *
 * The loot log is only sent while its panel is open. Every `action_completed`
 * of a gathering action carries the items it gained, so while the tab is open
 * the gathered drops are recorded whatever panel is showing. Only the positive
 * deltas of that message are credited, and only when the completed action is a
 * gathering one: a marketplace claim, a chest opened or a craft arrives in a
 * different message or under a different action and is never gathering.
 *
 * What is stored is the gain of each unbroken stretch the tab watched, per
 * action and per local day. The attribution lays these beside the loot log's
 * running total for the same action and takes, per span, the most either saw
 * (see `gatheringByDay` in `gold-sources.js`).
 *
 * ## Storage
 *
 * One record per local day in the `networthHistory` store, day-chunked for the
 * same reason as `combat-loot-recorder.js`: it is written on every completion.
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';
import { localDayId, dayStart, GATHERING_ACTION_TYPES } from './gold-sources.js';

const STORE_NAME = 'networthHistory';
const RECORD_PREFIX = 'itemFlowRec';

/** Beyond this, a day's row is dropped; one key per day, so this is also the key cost */
export const RETENTION_DAYS = 100;

/**
 * How long without a completion before the next one starts a new stretch.
 * Gathering actions complete every few seconds to a minute; a longer silence is
 * the tab closed or the character offline, which nothing here watched.
 */
const GAP_MS = 10 * 60 * 1000;

const INVENTORY = '/item_locations/inventory';

/**
 * Which chunk a day row belongs to.
 * @param {Object} row - A day row
 * @returns {string} Chunk id
 */
const rowChunkId = (row) => timeChunkId(dayStart(row?.d), 'day');

/**
 * A day's recorded movements.
 *
 * @typedef {Object} ItemFlowDay
 * @property {string} d - Local day id, `YYYY-MM-DD`
 * @property {Object<string, {a: string, stretches: Array<{from: number, to: number,
 *   gained: Object<string, number>}>}>} [gathering] - Keyed by the character action's id:
 *   the action hrid, and what each unbroken watched stretch gained, as drop key → count
 */

/**
 * The drop key for an item row: the hrid, with `::level` when enhanced — the
 * loot log's own keying, so both are priced alike.
 * @param {string} itemHrid
 * @param {number} [enhancementLevel]
 * @returns {string}
 */
export function itemKey(itemHrid, enhancementLevel) {
    const level = Number(enhancementLevel) || 0;
    return level > 0 ? `${itemHrid}::${level}` : itemHrid;
}

/**
 * The inventory as drop key → count, from a full item list.
 * @param {Array<Object>|null} items - `characterItems`
 * @returns {Map<string, number>|null} The mirror, or null when there is no inventory to seed from
 */
export function seedInventory(items) {
    if (!Array.isArray(items)) return null;
    const mirror = new Map();
    for (const item of items) {
        if (!item?.itemHrid || item.itemLocationHrid !== INVENTORY) continue;
        const count = Number(item.count);
        if (!Number.isFinite(count)) continue;
        const key = itemKey(item.itemHrid, item.enhancementLevel);
        mirror.set(key, (mirror.get(key) || 0) + count);
    }
    return mirror;
}

/**
 * Apply one message's changed rows to the mirror, and say what moved.
 *
 * Only inventory rows are read. A row the mirror has never seen started at zero,
 * which is only true because the mirror was seeded from the whole inventory; an
 * unseeded mirror (null) reports nothing.
 *
 * @param {Map<string, number>|null} mirror - From `seedInventory`, mutated
 * @param {Array<Object>} endCharacterItems - The changed rows, absolute counts
 * @returns {Array<{key: string, itemHrid: string, enhancementLevel: number, delta: number}>}
 */
export function applyInventoryChanges(mirror, endCharacterItems) {
    const moved = [];
    if (!mirror || !Array.isArray(endCharacterItems)) return moved;
    for (const item of endCharacterItems) {
        if (!item?.itemHrid || item.itemLocationHrid !== INVENTORY) continue;
        const count = Number(item.count);
        if (!Number.isFinite(count) || count < 0) continue;
        const enhancementLevel = Number(item.enhancementLevel) || 0;
        const key = itemKey(item.itemHrid, enhancementLevel);
        const delta = count - (mirror.get(key) || 0);
        mirror.set(key, count);
        if (delta !== 0) moved.push({ key, itemHrid: item.itemHrid, enhancementLevel, delta });
    }
    return moved;
}

/**
 * Fold one gathering completion's gains into its day's row, in place.
 *
 * A completion within `GAP_MS` of the stretch's last extends it; a later one
 * opens a new stretch, so the time between the two is known to be unwatched.
 *
 * @param {ItemFlowDay} row - The day's row, mutated
 * @param {string} run - The character action's id
 * @param {string} actionHrid - The gathering action
 * @param {number} t - When the completion arrived, epoch ms
 * @param {Object<string, number>} gained - Drop key → count gained
 * @returns {ItemFlowDay} The same row
 */
export function foldGathering(row, run, actionHrid, t, gained) {
    if (!row || !run || !Number.isFinite(t) || !gained) return row;
    if (!row.gathering) row.gathering = {};
    if (!row.gathering[run]) row.gathering[run] = { a: actionHrid, stretches: [] };
    const stretches = row.gathering[run].stretches;

    let current = stretches[stretches.length - 1];
    if (!current || t - current.to > GAP_MS || t < current.to) {
        current = { from: t, to: t, gained: {} };
        stretches.push(current);
    }
    current.to = t;
    for (const [key, count] of Object.entries(gained)) {
        if (count > 0) current.gained[key] = (current.gained[key] || 0) + count;
    }
    return row;
}

class ItemFlowRecorder {
    constructor() {
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            // Never written by any build — day-chunked from its first line — but
            // the store reads and deletes it on every load, so it has to be a
            // key of this recorder's own
            legacyKey: (charId) => `itemFlow_${charId}`,
            groupOf: rowChunkId,
            compare: (a, b) => String(a?.d || '').localeCompare(String(b?.d || '')),
            label: 'ItemFlow',
        });

        /** The rows as they stand, which is the truth between debounced writes */
        this._rows = [];
        /** Days whose rows moved since the last save */
        this._touchedChunks = new Set();
        /** Whose rows those are */
        this._charId = null;
        /** The read in flight, so concurrent recordings wait on one of them */
        this._loading = null;
        /** Bumped on every character change; rows read under an old one are not ours */
        this._generation = 0;
        /** Inventory drop key → last count seen; null until seeded */
        this._inventory = null;
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
            itemsUpdated: (data) => this._onItemsUpdated(data),
            characterInitialized: (data) => this._seed(data?.characterItems),
            characterSwitching: () => this._forget(),
        };

        dataManager.on('items_updated', this._handlers.itemsUpdated);
        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('character_switching', this._handlers.characterSwitching);

        this.isActive = true;
        // The data manager has already applied every message up to now, so its
        // inventory is exactly the state the next message changes
        this._seed();
        await this.load();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (!this._handlers) return;
        dataManager.off('items_updated', this._handlers.itemsUpdated);
        dataManager.off('character_initialized', this._handlers.characterInitialized);
        dataManager.off('character_switching', this._handlers.characterSwitching);
        this._handlers = null;
        this._inventory = null;
        this.isActive = false;
    }

    /**
     * Take the whole inventory as the baseline.
     * @param {Array<Object>} [items] - A full item list; the data manager's when omitted
     */
    _seed(items) {
        this._inventory = seedInventory(Array.isArray(items) ? items : dataManager.characterItems);
    }

    /** Forget the departing character's rows, so they are never written under the arriving one's key. */
    _forget() {
        this._generation += 1;
        this._rows = [];
        this._touchedChunks.clear();
        this._charId = null;
        this._loading = null;
        this._inventory = null;
        this._store.forget();
    }

    /**
     * Every recorded day, oldest first.
     * @returns {Promise<Array<ItemFlowDay>>} The rows
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
     * @returns {ItemFlowDay} The live row
     */
    _rowFor(day) {
        let row = this._rows.find((entry) => entry.d === day);
        if (!row) {
            row = { d: day };
            this._rows.push(row);
        }
        this._touchedChunks.add(rowChunkId(row));
        return row;
    }

    /** Drop rows past retention and queue the (debounced) write. */
    _save() {
        if (!this._charId) return;

        const floor = localDayId(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const kept = this._rows.filter((row) => row.d >= floor);
        if (kept.length !== this._rows.length) this._rows = kept;

        const changedChunks = this._touchedChunks;
        this._touchedChunks = new Set();
        this._store.save(this._charId, this._rows, { changedChunks });
    }

    /**
     * Mutate today's row once the rows are loaded, under the character the
     * change was seen for.
     * @param {Function} mutate - `(row) => void`
     * @returns {Promise<void>}
     */
    async _record(mutate) {
        const charId = this._currentCharId();
        if (!charId) return;
        const generation = this._generation;
        await this.load();
        // The character switched while the rows were being read; this change
        // belongs to whoever left
        if (this._generation !== generation || this._charId !== charId) return;
        mutate(this._rowFor(localDayId(Date.now())));
        this._save();
    }

    /**
     * Diff one item message against the mirror and record what it means.
     *
     * The diff runs synchronously, before any await, so the next message is
     * always diffed against this one's counts.
     *
     * @param {Object} data - An `items_updated` payload, or an `action_completed` one
     *   (the data manager re-emits those as `items_updated` when they carry items)
     */
    _onItemsUpdated(data) {
        try {
            const moved = applyInventoryChanges(this._inventory, data?.endCharacterItems);
            if (moved.length === 0) return;
            if (!config.getSetting('networth_goldSources')) return;
            if (storage.isQuotaExceeded?.()) return;

            const action = data?.endCharacterAction;
            if (!action?.actionHrid) return;
            const owner = action.characterID;
            const charId = this._currentCharId();
            if (owner !== undefined && owner !== null && String(owner) !== String(charId)) return;

            const type = dataManager.getActionDetails?.(action.actionHrid)?.type;
            if (!GATHERING_ACTION_TYPES.includes(type)) return;

            const gained = {};
            for (const { key, delta } of moved) if (delta > 0) gained[key] = (gained[key] || 0) + delta;
            if (Object.keys(gained).length === 0) return;

            const run = String(action.id ?? action.actionHrid);
            const t = Date.now();
            this._record((row) => foldGathering(row, run, action.actionHrid, t, gained)).catch((error) =>
                console.error('[ItemFlow] Recording a gathering completion failed:', error)
            );
        } catch (error) {
            console.error('[ItemFlow] Reading an item update failed:', error);
        }
    }
}

const itemFlowRecorder = new ItemFlowRecorder();
export default itemFlowRecorder;
