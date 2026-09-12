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
 * listing of it alongside. One more keeps other consumption out: a fall inside
 * the completed action's own message, of an item that action takes as an input,
 * is the recipe's (the production recorder's), not a drink.
 *
 * ## Combat food and drink
 *
 * The same fall, under a combat action: food and drinks go one at a time and
 * arrive as a plain `items_updated` with no completed action at all. Every
 * guard above is reused unchanged — a fall of exactly one, unenhanced, of an
 * item in an ACTIVE COMBAT food or drink slot while a combat action is running
 * (now or within `CONFIRM_MS`), with no listing of it alongside and no recipe
 * of the completed action taking it as an input. Which tally a fall books to is
 * decided once, by the slot it sits in and the action that is running, so no
 * fall can be counted as both a skilling drink and a combat consumable.
 *
 * Unlike the two tallies above, this one keeps the TIME of what it saw, as the
 * gathering record does: each unbroken watched stretch and what it used up. The
 * archived runs record the same consumption (`combat-session-history.js`, the
 * twenty most recent), and the attribution lays the two beside each other and
 * takes, per run, the most either saw rather than their sum — see
 * `combatConsumablesByDay` in `gold-sources.js`. A stretch is broken by silence
 * and by the run changing, so one stretch never straddles two runs.
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
 * @property {{stretches: Array<{from: number, to: number, r: string|null,
 *   used: Object<string, number>}>}} [combatConsumables] - Food and drinks burned in combat:
 *   what each unbroken watched stretch used up, as item hrid → count, with the run it
 *   watched (`r`, the server's `combatStartTime`) so a stretch never straddles two runs
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
 * One run's recorded gathering, merged across every stretch recorded for it —
 * normally one stretch, but a run that crossed local midnight or an unwatched
 * gap (`GAP_MS`) splits into more than one row's or more than one stretch.
 *
 * Shared by both read paths below: `prediction-calibration.js`'s live fallback
 * (async, wants the whole run once it has ended) and the action panel's "so far
 * this run" row (sync, wants whatever is in memory right now).
 *
 * @param {Array<ItemFlowDay>} rows - Loaded rows
 * @param {string} run - The character action's id, this recorder's own key
 * @returns {{gained: Object<string, number>, from: number, to: number}|null} Merged totals,
 *   or null when this run was never recorded at all (recorder off, storage over quota, or
 *   recording had not started yet when the run did)
 */
export function gatheringRunTotals(rows, run) {
    // Not `!run`: a numeric action id of 0 is falsy but a perfectly real run —
    // only a genuinely absent key (null/undefined/empty string) means "no run".
    if (run === null || run === undefined || run === '') return null;
    let from = null;
    let to = null;
    const gained = {};
    let found = false;

    for (const row of rows || []) {
        const held = row?.gathering?.[run];
        for (const stretch of held?.stretches || []) {
            if (!Number.isFinite(stretch?.from)) continue;
            found = true;
            if (from === null || stretch.from < from) from = stretch.from;
            const stretchTo = Number.isFinite(stretch.to) && stretch.to > stretch.from ? stretch.to : stretch.from;
            if (to === null || stretchTo > to) to = stretchTo;
            for (const [key, count] of Object.entries(stretch.gained || {})) {
                if (count > 0) gained[key] = (gained[key] || 0) + count;
            }
        }
    }

    return found ? { gained, from, to } : null;
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
 * Fold one combat food or drink into its day's row, in place.
 *
 * A use within `GAP_MS` of the stretch's last, under the same run, extends it;
 * a later one, or one under a different run, opens a new stretch — so a stretch
 * is always one run's, and the time between two stretches is known to be time
 * this recorder did not watch.
 *
 * @param {ItemFlowDay} row - The day's row, mutated
 * @param {number} t - When it was used, epoch ms
 * @param {string} itemHrid - What was used
 * @param {string|null} [run] - The run it was used in, the server's `combatStartTime`
 * @returns {ItemFlowDay} The same row
 */
export function foldCombatConsumable(row, t, itemHrid, run = null) {
    if (!row || !itemHrid || !Number.isFinite(t)) return row;
    if (!row.combatConsumables) row.combatConsumables = { stretches: [] };
    const stretches = row.combatConsumables.stretches;

    let current = stretches[stretches.length - 1];
    if (!current || t - current.to > GAP_MS || t < current.to || current.r !== (run || null)) {
        current = { from: t, to: t, r: run || null, used: {} };
        stretches.push(current);
    }
    current.to = t;
    current.used[itemHrid] = (current.used[itemHrid] || 0) + 1;
    return row;
}

/**
 * Whether an item sits in one of a set of consumable slots, and that slot is on.
 * @param {Array<Object>|null} slots - A food or drink slot list
 * @param {string} itemHrid
 * @returns {boolean}
 */
function slotted(slots, itemHrid) {
    return (slots || []).some((slot) => slot?.itemHrid === itemHrid && slot.isActive !== false);
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

/** Combat food and drink are the consumables row's, not the skilling drinks row's */
const COMBAT_TYPE = '/action_types/combat';

/** The two categories a consumable slot can hold */
const DRINK_CATEGORY = '/item_categories/drink';
const FOOD_CATEGORY = '/item_categories/food';

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
        /**
         * The combat food slots, which the data manager does not keep: taken
         * from the login payload and refreshed whenever the slots change, so a
         * food swapped mid-session is not read against the login loadout
         */
        this._combatFoodSlots = [];
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
            characterInitialized: (data) => {
                this._seed(data?.characterItems);
                this._seedFoodSlots(data);
            },
            characterSwitching: () => this._forget(),
            marketListings: (data) => this._onMarketListings(data),
            consumablesUpdated: (data) => this._seedFoodSlots(data),
        };

        dataManager.on('items_updated', this._handlers.itemsUpdated);
        dataManager.on('character_initialized', this._handlers.characterInitialized);
        dataManager.on('character_switching', this._handlers.characterSwitching);
        dataManager.on('market_listings_updated', this._handlers.marketListings);
        dataManager.on('consumables_updated', this._handlers.consumablesUpdated);

        this.isActive = true;
        // The data manager has already applied every message up to now, so its
        // inventory is exactly the state the next message changes
        this._seed();
        this._seedFoodSlots(dataManager.characterData);
        await this.load();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (!this._handlers) return;
        dataManager.off('items_updated', this._handlers.itemsUpdated);
        dataManager.off('character_initialized', this._handlers.characterInitialized);
        dataManager.off('character_switching', this._handlers.characterSwitching);
        dataManager.off('market_listings_updated', this._handlers.marketListings);
        dataManager.off('consumables_updated', this._handlers.consumablesUpdated);
        this._handlers = null;
        this._inventory = null;
        this._combatFoodSlots = [];
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

    /**
     * Take the combat food slots from a payload that carries them.
     *
     * The login payload and every slot change carry the whole map; a payload
     * without one changes nothing, because "absent from this message" is not
     * "no food equipped" (the same reading `data-manager.js` gives the drink
     * map it does keep).
     * @param {Object} [payload] - `init_character_data` or `consumables_updated`
     */
    _seedFoodSlots(payload) {
        const slots = payload?.actionTypeFoodSlotsMap?.[COMBAT_TYPE];
        if (Array.isArray(slots)) this._combatFoodSlots = slots;
    }

    /** Forget the departing character's rows, so they are never written under the arriving one's key. */
    _forget() {
        this._generation += 1;
        this._rows = [];
        this._touchedChunks.clear();
        this._charId = null;
        this._loading = null;
        this._inventory = null;
        this._combatFoodSlots = [];
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
     * One run's recorded gathering, loading the rows first if they are not yet
     * in memory. For a caller that can await — `prediction-calibration.js`'s
     * live fallback, once a run it is watching has ended.
     * @param {string} run - The character action's id
     * @returns {Promise<{gained: Object<string, number>, from: number, to: number}|null>}
     */
    async getRunGathering(run) {
        await this.load();
        return gatheringRunTotals(this._rows, run);
    }

    /**
     * The same, read from whatever is already in memory, for a caller that must
     * draw inline with no chance to await — the action panel's "so far this
     * run" row, built synchronously alongside the time and profit lines.
     *
     * Answers null before the first load for this character has landed, same as
     * "never recorded" — the row is forward-only either way, so a caller cannot
     * tell the two apart, and should not need to.
     * @param {string} run - The character action's id
     * @returns {{gained: Object<string, number>, from: number, to: number}|null}
     */
    getCachedRunGathering(run) {
        if (!this.isActive || run === null || run === undefined || run === '') return null;
        if (this._charId !== this._currentCharId()) return null;
        return gatheringRunTotals(this._rows, run);
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
     * One pending per fall, whatever it turns out to be: `resolve` names the
     * tally, so a fall can never be booked to two of them.
     *
     * @param {string} itemHrid - The item that fell
     * @param {Function} resolve - `() => string|null`, which tally the running
     *   action makes this fall, or null for none; asked now and again when the
     *   wait is over, because the action that consumed it can become the
     *   running one a message later
     */
    _hold(itemHrid, resolve) {
        const t = Date.now();
        // A listing of this item just now is what lowered the count
        if (t - (this._listedAt.get(itemHrid) ?? -Infinity) < CONFIRM_MS) return;

        const run = this._runningCombatRun();
        const pending = { itemHrid, t, kindAtFall: resolve(), generation: this._generation };
        pending.timer = setTimeout(() => {
            this._pending.delete(pending);
            const kind = pending.kindAtFall || resolve();
            if (!kind) return;
            const mutate =
                kind === 'combatConsumables'
                    ? (row) => foldCombatConsumable(row, pending.t, itemHrid, run)
                    : (row) => foldConsumed(row, kind, itemHrid, 1);
            this._record(mutate, pending.t, pending.generation).catch((error) =>
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
        return slotted(dataManager.getActionDrinkSlots?.(type), itemHrid);
    }

    /**
     * Which tally a fall of a food or drink books to, from what is running now:
     * `combatConsumables` while a combat action runs and the item is in one of
     * its slots, `drinks` while a skill runs and it is in that skill's, and null
     * when neither — an item nothing is drinking fell for some other reason.
     * @param {string} itemHrid
     * @returns {string|null}
     */
    _consumedKind(itemHrid) {
        if (this._runningType() === COMBAT_TYPE) {
            const inSlot =
                slotted(dataManager.getActionDrinkSlots?.(COMBAT_TYPE), itemHrid) ||
                slotted(this._combatFoodSlots, itemHrid);
            return inSlot ? 'combatConsumables' : null;
        }
        return this._drinkingNow(itemHrid) ? 'drinks' : null;
    }

    /**
     * Which run is being fought, as the server stamps it — the key the archived
     * runs are kept under, so a live stretch is one run's and one run's only.
     * @returns {string|null}
     */
    _runningCombatRun() {
        return dataManager.battleData?.combatStartTime || null;
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
                    this._hold(itemHrid, () => (this._runningDungeonKey() === itemHrid ? 'keys' : null));
                    continue;
                }
                const category = dataManager.getItemDetails?.(itemHrid)?.categoryHrid;
                if (category !== DRINK_CATEGORY && category !== FOOD_CATEGORY) continue;
                if (consumedByAction(action, completed, itemHrid)) continue;
                this._hold(itemHrid, () => this._consumedKind(itemHrid));
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
