/**
 * Combat loot, recorded as it happens.
 *
 * ## Why the other two recordings are not enough
 *
 * The gold attribution's combat row had two sources, and both have a hole the
 * size of normal play:
 *
 * - the **loot log** is only sent while the game's own Loot & XP Log panel is
 *   open, so a character who never opens it records nothing, and one who opened
 *   it for the first hour of a ten-hour run has a one-hour entry for the whole
 *   run;
 * - the **archived runs** keep the twenty most recent, so a month of short runs
 *   reaches back a week, and a run is only archived when the next one starts.
 *
 * Every `new_battle` the game sends while the tab is open carries the player's
 * `totalLootMap` — the running total for the combat action in progress, from its
 * `combatStartTime`. That is the whole of what is needed: read it every time it
 * arrives, and the combat row is recorded whenever the game is open, whatever
 * panel happens to be showing, for as long as this record is kept.
 *
 * ## Checkpoints, not increments
 *
 * What is stored is the running total itself, twice per run per local day: the
 * first reading of the day and the last. Not the difference between readings —
 * a difference is already a decision about which day it belongs to, and that
 * decision needs things this module does not have (what the loot log and the
 * archive saw of the same run, and when the character was offline, which the
 * Welcome Back summary already counts). Stored as readings, the attribution can
 * lay every recording of one run on one timeline and take, at each instant, the
 * most any of them saw — so no drop is counted twice however many recordings
 * saw it. See `combatRunDayValues` in `gold-sources.js`.
 *
 * With the tab open across midnight the last reading of one day and the first of
 * the next are seconds apart, so the split between days is exact. A stretch the
 * tab was closed for is a gap between two readings, and the loot that arrived in
 * it is spread across it by time — the same estimate every other session here
 * uses, now confined to the part nobody watched.
 *
 * ## Offline windows
 *
 * The Welcome Back summary (`offlineItems` on `init_character_data`) is the
 * server's own signed item delta for the offline period, and the offline row
 * already counts it — drops and the food eaten alike. A combat run that carried
 * on through the offline period comes back with those same drops in its running
 * total, so the window is recorded here too, and the attribution leaves every
 * combat recording's share of it to the offline row rather than counting it on
 * both.
 *
 * ## Storage
 *
 * One record per local day in the `networthHistory` store, day-chunked rather
 * than month-chunked like the other recorders here: this one is written on
 * every battle, and a month of combat checkpoints is too much to re-serialise
 * that often.
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';
import { localDayId, dayStart } from './gold-sources.js';

const STORE_NAME = 'networthHistory';
const RECORD_PREFIX = 'combatLootRec';

/**
 * Beyond this, a day's row is dropped. The panel's longest window is 30 days;
 * the rest is headroom, and it is one key per day so it is also the key cost.
 */
export const RETENTION_DAYS = 100;

/**
 * How often an unchanged reading is written anyway.
 *
 * A battle that dropped nothing moves only the reading's time, which is worth
 * keeping (it is how far the recording reaches) but not worth a write every few
 * seconds. Memory always has it; storage gets it at most this late.
 */
const IDLE_SAVE_MS = 60 * 1000;

/**
 * How long without a battle before the next reading starts a new stretch.
 *
 * Battles arrive every few seconds to a couple of minutes while the tab is
 * open. A longer silence is the tab closed, the connection lost or the
 * character offline, and the readings either side of it are what say how much
 * of the run's loot fell inside it — which is what lets the offline part be
 * handed to the offline row whole rather than by a time share.
 */
const GAP_MS = 10 * 60 * 1000;

/**
 * Which chunk a day row belongs to.
 * @param {Object} row - A day row
 * @returns {string} Chunk id
 */
const rowChunkId = (row) => timeChunkId(dayStart(row?.d), 'day');

/**
 * A day's combat readings.
 *
 * @typedef {Object} CombatLootDay
 * @property {string} d - Local day id, `YYYY-MM-DD`
 * @property {Object<string, {stretches: Array<{first: {t: number, loot: Object<string, number>},
 *   last: {t: number, loot: Object<string, number>}}>}>} [runs] - Keyed by the run's
 *   `combatStartTime` as the server sent it: for each unbroken stretch the tab
 *   watched it that day, the first and last reading of its running total, as
 *   drop key → count
 * @property {Array<Array<number>>} [offline] - `[from, to]` epoch-ms offline
 *   windows that ended this day, whose gains the Welcome Back summary counted
 */

/**
 * The loot log's drop key for an item: the hrid, with `::level` when enhanced.
 * @param {string} itemHrid
 * @param {number} [enhancementLevel]
 * @returns {string}
 */
export function dropKey(itemHrid, enhancementLevel) {
    const level = Number(enhancementLevel) || 0;
    return level > 0 ? `${itemHrid}::${level}` : itemHrid;
}

/**
 * This character's running loot total, from one `new_battle`.
 *
 * Found by character id, never by position or by falling back to the first
 * player: a party's message carries everybody, and somebody else's loot is not
 * this account's income. No match means nothing is read.
 *
 * The map is keyed by the game's slot key with the item inside, so two slots of
 * one item are added rather than one overwriting the other.
 *
 * @param {Object} data - The `new_battle` payload
 * @param {*} characterId - Whose loot
 * @returns {Object<string, number>|null} Drop key → count, or null when the
 *   character is not in the message
 */
export function ownLootCounts(data, characterId) {
    if (characterId === null || characterId === undefined) return null;
    const players = Array.isArray(data?.players) ? data.players : [];
    const me = players.find((player) => player?.character?.id === characterId);
    if (!me) return null;

    const counts = {};
    for (const entry of Object.values(me.totalLootMap || {})) {
        if (!entry?.itemHrid) continue;
        const count = Number(entry.count) || 0;
        if (count <= 0) continue;
        const key = dropKey(entry.itemHrid, entry.enhancementLevel);
        counts[key] = (counts[key] || 0) + count;
    }
    return counts;
}

/**
 * Fold one reading of a run into its day's row, in place.
 *
 * A reading within `GAP_MS` of the last one extends the current stretch and
 * replaces its latest reading; one after a longer silence opens a new stretch.
 * So a row keeps the total at both ends of every stretch the tab watched, and
 * nothing in between — every reading inside a stretch is implied by its ends.
 * A reading older than the stretch's latest is out of order and ignored.
 *
 * @param {CombatLootDay} row - The day's row, mutated
 * @param {string} run - The run's `combatStartTime`
 * @param {number} t - When the reading was taken, epoch ms
 * @param {Object<string, number>} counts - The running total
 * @returns {CombatLootDay} The same row
 */
export function foldObservation(row, run, t, counts) {
    if (!row || !run || !Number.isFinite(t) || !counts) return row;
    if (!row.runs) row.runs = {};
    if (!row.runs[run]) row.runs[run] = { stretches: [] };
    const stretches = row.runs[run].stretches;

    const reading = { t, loot: { ...counts } };
    const current = stretches[stretches.length - 1];
    if (!current || t - current.last.t > GAP_MS) stretches.push({ first: reading, last: reading });
    else if (t >= current.last.t) current.last = reading;
    return row;
}

/**
 * The offline window a Welcome Back summary covers.
 *
 * Only a summary that actually carried items claims its window: an offline
 * period in which nothing was gained put nothing in the offline row, and
 * claiming it would take from combat what nothing else counted.
 *
 * @param {Object} payload - The `init_character_data` payload
 * @returns {Array<number>|null} `[from, to]` epoch ms, or null
 */
export function offlineWindowOf(payload) {
    if (!(payload?.offlineItems?.length > 0)) return null;
    const from = Date.parse(payload.character?.lastOfflineTime);
    const to = Date.parse(payload.currentTimestamp);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return null;
    return [from, to];
}

/**
 * Add an offline window to a day's row, once.
 * @param {CombatLootDay} row - The day's row, mutated
 * @param {Array<number>} window - `[from, to]`
 * @returns {CombatLootDay} The same row
 */
export function foldOffline(row, window) {
    if (!row || !Array.isArray(window)) return row;
    if (!row.offline) row.offline = [];
    if (!row.offline.some(([from, to]) => from === window[0] && to === window[1])) {
        row.offline.push([window[0], window[1]]);
    }
    return row;
}

/**
 * Two running totals, item for item.
 * @param {Object<string, number>} a
 * @param {Object<string, number>} b
 * @returns {boolean}
 */
function sameCounts(a, b) {
    const keys = Object.keys(a || {});
    if (keys.length !== Object.keys(b || {}).length) return false;
    return keys.every((key) => a[key] === b?.[key]);
}

class CombatLootRecorder {
    constructor() {
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            // Never written by any build — this recorder was chunked from its
            // first line — but the store reads and deletes it on every load, so
            // it has to be a key of this recorder's own
            legacyKey: (charId) => `combatLoot_${charId}`,
            groupOf: rowChunkId,
            compare: (a, b) => String(a?.d || '').localeCompare(String(b?.d || '')),
            label: 'CombatLoot',
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
        /** When the rows were last queued for writing */
        this._lastSave = 0;
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
            newBattle: (data, context) => this._onNewBattle(data, context),
            characterInitialized: (data) => this._onCharacterInitialized(data),
            characterSwitching: () => this._forget(),
        };

        webSocketHook.on('new_battle', this._handlers.newBattle);
        dataManager.on?.('character_initialized', this._handlers.characterInitialized);
        dataManager.on?.('character_switching', this._handlers.characterSwitching);

        this.isActive = true;
        await this.load();

        // This starts after the page has drawn, long after the one
        // `character_initialized` that carried this login's offline summary has
        // fired. The data manager keeps that payload, so it is read from there.
        await this._onCharacterInitialized(dataManager.characterData);
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (!this._handlers) return;
        webSocketHook.off('new_battle', this._handlers.newBattle);
        dataManager.off?.('character_initialized', this._handlers.characterInitialized);
        dataManager.off?.('character_switching', this._handlers.characterSwitching);
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
        this._store.forget();
    }

    /**
     * Every recorded day, oldest first.
     *
     * A save hands the chunked store the whole list as the truth, so every write
     * goes through this first and concurrent callers share the one read.
     *
     * @returns {Promise<Array<CombatLootDay>>} The rows
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
     * @returns {CombatLootDay} The live row
     */
    _rowFor(day) {
        let row = this._rows.find((entry) => entry.d === day);
        if (!row) {
            row = { d: day, runs: {} };
            this._rows.push(row);
        }
        this._touchedChunks.add(rowChunkId(row));
        return row;
    }

    /**
     * Drop rows past retention and queue the write.
     *
     * Not awaited: the write is debounced, and `flushAll()` on unload lands the
     * last one.
     */
    _save() {
        if (!this._charId) return;

        const floor = localDayId(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const kept = this._rows.filter((row) => row.d >= floor);
        if (kept.length !== this._rows.length) this._rows = kept;

        const changedChunks = this._touchedChunks;
        this._touchedChunks = new Set();
        this._lastSave = Date.now();
        this._store.save(this._charId, this._rows, { changedChunks });
    }

    /**
     * Record one reading of the run in progress.
     *
     * Ownership is checked twice, the way the chest recorder checks it: the
     * socket it arrived on (a battle the departing character's socket delivers
     * after a switch is not the arriving character's), and the character id in
     * the payload itself (a party message carries everybody).
     *
     * @param {Object} data - The `new_battle` payload
     * @param {{socket?: Object}|null} [context] - Delivery context from the WebSocket hook
     * @returns {Promise<void>}
     */
    async _onNewBattle(data, context) {
        try {
            if (dataManager.isFromActiveSocket?.(context) === false) return;
            if (!config.getSetting('networth_goldSources')) return;
            if (storage.isQuotaExceeded?.()) return;

            const run = data?.combatStartTime;
            if (!run || !Number.isFinite(Date.parse(run))) return;

            const charId = this._currentCharId();
            if (!charId) return;
            const counts = ownLootCounts(data, dataManager.getCurrentCharacterId?.());
            if (!counts) return;

            const generation = this._generation;
            await this.load();
            // The character switched while the rows were being read; this
            // reading belongs to whoever left
            if (this._generation !== generation || this._charId !== charId) return;

            const now = Date.now();
            const row = this._rowFor(localDayId(now));
            const before = row.runs?.[run]?.stretches?.at(-1)?.last?.loot;
            foldObservation(row, run, now, counts);

            if (!before || !sameCounts(before, counts) || now - this._lastSave >= IDLE_SAVE_MS) this._save();
        } catch (error) {
            console.error('[CombatLoot] Recording a battle failed:', error);
        }
    }

    /**
     * Record the offline window a Welcome Back summary covered.
     * @param {Object} payload - The `init_character_data` payload
     * @returns {Promise<void>}
     */
    async _onCharacterInitialized(payload) {
        try {
            const window = offlineWindowOf(payload);
            if (!window) return;
            if (!config.getSetting('networth_goldSources')) return;
            if (storage.isQuotaExceeded?.()) return;

            const charId = this._currentCharId();
            if (!charId) return;
            // The payload names whose summary it is; a cached one from before a
            // switch is not the arriving character's window
            const owner = payload?.character?.id;
            if (owner !== undefined && owner !== null && String(owner) !== String(charId)) return;

            const generation = this._generation;
            await this.load();
            if (this._generation !== generation || this._charId !== charId) return;

            foldOffline(this._rowFor(localDayId(window[1])), window);
            this._save();
        } catch (error) {
            console.error('[CombatLoot] Recording an offline window failed:', error);
        }
    }
}

const combatLootRecorder = new CombatLootRecorder();
export default combatLootRecorder;
