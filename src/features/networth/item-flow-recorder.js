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
 * ## Dungeon keys
 *
 * A dungeon run takes one entry key from each member's inventory as it starts.
 * The count alone cannot tell that from listing a key on the market, which
 * lowers it the same way (`utils/key-ledger.js`), so a fall is only counted as
 * spent when all of these hold:
 *
 * - it is a fall of exactly one — one run, one key;
 * - a dungeon that takes that key is running, either when the fall arrives or
 *   within `CONFIRM_MS` of it (the key goes as the run starts, and the message
 *   that makes the dungeon the running action can come second);
 * - no listing of that key is seen within `CONFIRM_MS` either side of it.
 *
 * Each guard can only make a real run go uncounted, never make a listing count.
 *
 * ## Skilling drinks
 *
 * A drink is used up from the inventory, one at a time, and the count falls by
 * one when it is. The same guards apply, with the drink's slot in place of the
 * dungeon: a fall of exactly one, of a drink sitting in an active drink slot of
 * the running non-combat action's type (now or within `CONFIRM_MS`), with no
 * listing of it alongside. Two more keep other consumption out:
 *
 * - nothing is held while a combat action runs; combat drinks are the combat
 *   consumables row's, from the archived runs;
 * - a fall inside the completed action's own message, of an item that action
 *   takes as an input, is the recipe's (the production recorder's), not a drink.
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
import { runningAction, runningCombatAction } from '../../utils/combat-actions.js';
import { dungeonEntryKey } from '../../utils/dungeon-key-forecast.js';
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

/**
 * How long a fall in a consumed item's count waits before it is booked: long
 * enough for the running action to change and for a listing of the same item
 * to arrive, either of which decides what the fall was.
 */
export const CONFIRM_MS = 5000;

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
 * @property {Object<string, number>} [keys] - Dungeon entry keys spent, item hrid → count
 * @property {Object<string, number>} [drinks] - Drinks used up while skilling, item hrid → count
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

/**
 * Add a count of something consumed to a day's row, in place.
 * @param {ItemFlowDay} row - The day's row, mutated
 * @param {string} kind - Which tally, e.g. `keys`
 * @param {string} itemHrid - What was consumed
 * @param {number} count - How many
 * @returns {ItemFlowDay} The same row
 */
export function foldConsumed(row, kind, itemHrid, count) {
    if (!row || !kind || !itemHrid || !(count > 0)) return row;
    if (!row[kind]) row[kind] = {};
    row[kind][itemHrid] = (row[kind][itemHrid] || 0) + count;
    return row;
}

/**
 * Whether an item could be a dungeon's entry key, so that a fall of it is worth
 * holding while the dungeon that takes it has not yet become the running action.
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isEntryKeyCandidate(itemHrid) {
    return /^\/items\/[a-z_]+_entry_key$/.test(String(itemHrid || ''));
}

/** Combat drinks are the consumables row's */
const COMBAT_TYPE = '/action_types/combat';

/**
 * Whether the action a message completed takes this item as an input, so that a
 * fall of it in that message is the recipe's rather than a drink.
 * @param {Object|null} action - `endCharacterAction`
 * @param {Object|null} details - Its action details
 * @param {string} itemHrid
 * @returns {boolean}
 */
export function consumedByAction(action, details, itemHrid) {
    if (!action || !itemHrid) return false;
    if ((details?.inputItems || []).some((input) => input?.itemHrid === itemHrid)) return true;
    if (details?.upgradeItemHrid === itemHrid) return true;
    // Alchemy and enhancing name what they work on in the action itself
    const hashes = [action.primaryItemHash, action.secondaryItemHash];
    return hashes.some((hash) => typeof hash === 'string' && hash.includes(`${itemHrid}::`));
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
        /** Falls in a consumed item's count, waiting out `CONFIRM_MS` */
        this._pending = new Set();
        /** Item hrid → when a listing of it was last seen */
        this._listedAt = new Map();
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
            marketListings: (data) => this._onMarketListings(data),
        };

        dataManager.on('items_updated', this._handlers.itemsUpdated);
        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('character_switching', this._handlers.characterSwitching);
        dataManager.on('market_listings_updated', this._handlers.marketListings);

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
        dataManager.off('market_listings_updated', this._handlers.marketListings);
        this._handlers = null;
        this._inventory = null;
        this._dropPending();
        this.isActive = false;
    }

    /** Abandon every fall still waiting to be booked. */
    _dropPending() {
        for (const pending of this._pending) clearTimeout(pending.timer);
        this._pending.clear();
        this._listedAt.clear();
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
        this._dropPending();
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
     * Mutate a day's row once the rows are loaded, under the character the
     * change was seen for.
     * @param {Function} mutate - `(row) => void`
     * @param {number} [t] - When the change happened, which picks the day
     * @param {number} [generation] - The character generation it was seen under
     * @returns {Promise<void>}
     */
    async _record(mutate, t = Date.now(), generation = this._generation) {
        const charId = this._currentCharId();
        if (!charId || this._generation !== generation) return;
        await this.load();
        // The character switched while the rows were being read; this change
        // belongs to whoever left
        if (this._generation !== generation || this._charId !== charId) return;
        mutate(this._rowFor(localDayId(t)));
        this._save();
    }

    /**
     * Hold a fall of one in a consumed item's count until it is known what it was.
     *
     * @param {string} kind - Which tally it books to
     * @param {string} itemHrid - The item that fell
     * @param {Function} qualifies - `() => boolean`, whether the running action
     *   consumes this item; asked now and again when the wait is over
     */
    _hold(kind, itemHrid, qualifies) {
        const t = Date.now();
        // A listing of this item just now is what lowered the count
        if (t - (this._listedAt.get(itemHrid) ?? -Infinity) < CONFIRM_MS) return;

        const pending = { kind, itemHrid, t, qualifiedAtFall: qualifies(), generation: this._generation };
        pending.timer = setTimeout(() => {
            this._pending.delete(pending);
            if (!pending.qualifiedAtFall && !qualifies()) return;
            this._record((row) => foldConsumed(row, kind, itemHrid, 1), pending.t, pending.generation).catch((error) =>
                console.error('[ItemFlow] Recording a consumed item failed:', error)
            );
        }, CONFIRM_MS);
        this._pending.add(pending);
    }

    /**
     * A listing of an item explains any fall of it around now, so a held one is
     * dropped and the next few seconds' falls are not held at all.
     * @param {Object} data - The `market_listings_updated` payload
     */
    _onMarketListings(data) {
        const now = Date.now();
        for (const listing of Array.isArray(data?.endMarketListings) ? data.endMarketListings : []) {
            const itemHrid = listing?.itemHrid;
            if (!itemHrid) continue;
            this._listedAt.set(itemHrid, now);
            for (const pending of this._pending) {
                if (pending.itemHrid !== itemHrid || now - pending.t >= CONFIRM_MS) continue;
                clearTimeout(pending.timer);
                this._pending.delete(pending);
            }
        }
    }

    /**
     * The action type of whatever the character is running, or null when idle.
     * @returns {string|null}
     */
    _runningType() {
        const running = runningAction(dataManager.getCurrentActions?.());
        return running?.actionHrid ? dataManager.getActionDetails?.(running.actionHrid)?.type || null : null;
    }

    /**
     * Whether a drink sits in an active drink slot of the running non-combat action's type.
     * @param {string} itemHrid
     * @returns {boolean}
     */
    _drinkingNow(itemHrid) {
        const type = this._runningType();
        if (!type || type === COMBAT_TYPE) return false;
        const slots = dataManager.getActionDrinkSlots?.(type) || [];
        return slots.some((slot) => slot?.itemHrid === itemHrid && slot.isActive !== false);
    }

    /**
     * The entry key the running dungeon takes, or null when no dungeon is running.
     * @returns {string|null}
     */
    _runningDungeonKey() {
        const running = runningCombatAction(dataManager.getCurrentActions?.());
        if (!running?.actionHrid) return null;
        return dungeonEntryKey(running.actionHrid, dataManager.getActionDetails?.(running.actionHrid));
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
            const owner = action?.characterID;
            const charId = this._currentCharId();
            if (owner !== undefined && owner !== null && String(owner) !== String(charId)) return;

            const completed = action?.actionHrid ? dataManager.getActionDetails?.(action.actionHrid) : null;
            for (const { itemHrid, enhancementLevel, delta } of moved) {
                if (delta !== -1 || enhancementLevel > 0) continue;
                if (this._runningDungeonKey() === itemHrid || isEntryKeyCandidate(itemHrid)) {
                    this._hold('keys', itemHrid, () => this._runningDungeonKey() === itemHrid);
                    continue;
                }
                if (dataManager.getItemDetails?.(itemHrid)?.categoryHrid !== '/item_categories/drink') continue;
                if (this._runningType() === COMBAT_TYPE) continue;
                if (consumedByAction(action, completed, itemHrid)) continue;
                this._hold('drinks', itemHrid, () => this._drinkingNow(itemHrid));
            }

            if (!action?.actionHrid) return;
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
