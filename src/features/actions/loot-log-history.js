/**
 * Loot Log History Storage
 * Persists loot log entries to IndexedDB for extended history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';

const STORE_NAME = 'lootLogHistory';

/**
 * How many sessions the log keeps.
 *
 * Five hundred is a fortnight of hard play, which is enough to scroll back
 * through and not enough to aggregate: the analytics pivot divides a whole
 * history into per-action rows, and a rate over three sessions of an action is
 * noise wearing a decimal point.
 *
 * Two thousand rather than upstream's five thousand, because the ceiling here is
 * key count rather than bytes. Entries are grouped into one record per hour of
 * play, so the worst case — a long gathering run per hour, one entry per chunk —
 * is one key per entry: 2,000 keys against the store's 500-key soft budget,
 * which is raised in lockstep in `core/storage.js`. Five thousand would put the
 * worst case at ten times that budget in a store shared across characters. Size
 * is the lesser constraint: a combat entry with three dozen drop kinds and eight
 * skills serialises to about 2 KB and a gathering entry to about 0.4 KB, so
 * 2,000 entries is ~1.4 MB for a mixed history and ~3.9 MB if every one of them
 * is combat.
 */
export const MAX_ENTRIES = 2000;

/**
 * One record per hour of play.
 *
 * `loot_log_updated` arrives every few seconds while a fast action runs, and
 * each one used to rewrite the whole window. Hourly buckets hold the dozen or so
 * entries recorded since the hour began, so the write is that dozen — and every
 * entry from a previous hour, which has not changed and cannot change, is never
 * touched again.
 *
 * An hour rather than a day because a day of hard play is most of the window,
 * which would leave the amplification roughly where it started.
 */
const RECORD_PREFIX = 'lootLogRec';

/**
 * Which chunk a loot entry belongs to. Named so a merge can name the hours it moved
 * without reaching into the store.
 * @param {Object} entry - A loot log entry
 * @returns {string} Chunk id
 */
const entryChunkId = (entry) => timeChunkId(Date.parse(entry?.startTime), 'hour');

class LootLogHistory {
    constructor() {
        /**
         * Where the entries live, and the memory of what was last written.
         *
         * Debouncing the write means storage is behind memory for up to three
         * seconds, and `loot_log_updated` arrives far more often than that — so
         * a read that went through to storage would merge onto a stale array and
         * undo the merge before it. Memory is the truth between flushes; storage
         * is where it goes to survive a reload.
         */
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            legacyKey: (charId) => `lootLog_${charId}`,
            groupOf: entryChunkId,
            // Newest first, which is the order the loot panel reads them in
            compare: (a, b) => Date.parse(b?.startTime) - Date.parse(a?.startTime) || 0,
            // An entry's identity is its action, not its contents: a session
            // still running has its `endTime` and `actionCount` rewritten on
            // every loot message, so a deep-equality dedupe would keep two
            // copies of the same action whenever two copies of the history are
            // folded together (a sync pull, or a legacy key being absorbed).
            identityOf: (entry) => entry?.characterActionId,
            label: 'LootLogHistory',
        });

        /**
         * One merge at a time, in order.
         *
         * `mergeAndSave` is a read-merge-write, and it is called straight off
         * the `loot_log_updated` message with no await: two messages a few
         * hundred milliseconds apart both read the same `existing` array, both
         * merge their own delta onto it, and the second save overwrites the
         * first — so the first message's entries are gone. Chaining costs
         * nothing (the second merge starts against the first one's result) and
         * is what `trade-ledger-store.js` and `persisted-record.js` already do
         * for the same reason.
         */
        this._chain = Promise.resolve();
    }

    /** @returns {string|null} Whose loot log, or null before login */
    _charId() {
        return dataManager.getCurrentCharacterId() || null;
    }

    /**
     * @param {string} [charId] - Whose history — defaults to whoever is current now.
     *   A caller spanning an await (like `_merge`) should capture one up front and
     *   pass it through, rather than let `_load` and a later `_save` each read the
     *   current character independently and risk disagreeing after a switch.
     * @returns {Promise<Array>} Every stored entry, newest first
     */
    async _load(charId = this._charId()) {
        if (!charId) return [];
        return this._store.load(charId);
    }

    /**
     * Queue the entries for writing.
     *
     * Deliberately not awaited and not `immediate`: the debounce coalesces a
     * burst of loot messages into one write per quiet moment, and the
     * `beforeunload` `flushAll()` in the entrypoint is what makes the last one
     * land. Awaiting here would block the caller on the debounce timer itself.
     * @param {Array} entries - The history as it now stands, newest first
     * @param {Set<string>} [changedChunks] - Chunks whose entries moved, so the rest
     *   are carried over from the last snapshot instead of being re-serialised
     * @param {string} [charId] - Whose history — see `_load`'s note on why a caller
     *   spanning an await should pass this explicitly rather than rely on the default
     */
    _save(entries, changedChunks, charId = this._charId()) {
        if (!charId) return;
        this._store.save(charId, entries, { changedChunks });
    }

    /**
     * Merge entries from a loot_log_updated message into stored history.
     * Deduplicates by characterActionId (incoming entries replace stored copies, so ongoing
     * sessions stay fresh), keeps newest first, caps at MAX_ENTRIES.
     * @param {Array} lootLog - Array from the WebSocket message
     * @returns {Promise<void>} Resolves when this merge has been queued for writing
     */
    async mergeAndSave(lootLog) {
        const run = () => this._mergeAndSave(lootLog);
        this._chain = this._chain.then(run, run);
        return this._chain;
    }

    /**
     * The merge itself, run one at a time by `mergeAndSave`.
     * @param {Array} lootLog - Array from the WebSocket message
     * @returns {Promise<void>}
     * @private
     */
    async _mergeAndSave(lootLog) {
        try {
            await this._merge(lootLog);
        } catch (error) {
            // Never rejected: the chain is what the next message extends, and a
            // rejected link would surface as an unhandled rejection in a caller
            // that deliberately does not await
            console.error('[LootLogHistory] Merging the loot log failed:', error);
        }
    }

    /**
     * @param {Array} lootLog - Array from the WebSocket message
     * @returns {Promise<void>}
     * @private
     */
    async _merge(lootLog) {
        if (!lootLog || lootLog.length === 0) return;
        // Nothing that follows can be stored, and building it costs a full
        // merge over the whole window per loot message
        if (storage.isQuotaExceeded()) return;

        // Captured once and threaded through the load and the save below,
        // rather than each independently reading "the current character" —
        // `_load` is an IndexedDB round trip, and a character switch landing
        // inside that window must not have the save that follows write this
        // merge under the *new* character's keys. See trade-ledger-store.js
        // for the same pattern.
        const charId = this._charId();
        if (!charId) return;

        const existing = await this._load(charId);
        // A newer switch happened while the read was in flight: this merge
        // belongs to a character that is no longer current, and saving it
        // now would write stale data under the character that switched away —
        // `character_switching` already dropped this instance's cache for it.
        if (this._charId() !== charId) return;

        const byId = new Map(existing.map((e) => [e.characterActionId, e]));

        // A loot message is a handful of actions against a window of thousands spread
        // over hundreds of hourly chunks; naming the hours that moved is what keeps
        // the save from re-serialising all of them
        const touchedChunks = new Set();
        let changed = false;
        for (const entry of lootLog) {
            const stored = byId.get(entry.characterActionId);
            if (!stored || stored.endTime !== entry.endTime || stored.actionCount !== entry.actionCount) {
                // A replaced entry whose startTime moved leaves one chunk and joins another
                if (stored) touchedChunks.add(entryChunkId(stored));
                touchedChunks.add(entryChunkId(entry));
                byId.set(entry.characterActionId, entry);
                changed = true;
            }
        }
        if (!changed) return;

        // Parsed once per entry rather than once per comparison: the sort runs on
        // every loot message, and `new Date(...)` inside the comparator is two
        // string parses per comparison — about 2·n·log₂n of them, so roughly
        // 44,000 across a full window where this is 2,000
        const startMs = new Map();
        for (const entry of byId.values()) startMs.set(entry, Date.parse(entry?.startTime) || 0);

        const merged = [...byId.values()];
        merged.sort((a, b) => startMs.get(b) - startMs.get(a));

        // Entries past the cap fall out of the array here; the chunks they were
        // the last of are deleted by the save that notices they have gone
        this._save(merged.slice(0, MAX_ENTRIES), touchedChunks, charId);
    }

    /**
     * Remove one stored entry by characterActionId — queued on the same chain
     * as `mergeAndSave`.
     *
     * This used to be a direct `_load`/`_save` from the caller, outside the
     * chain: a delete landing while a `loot_log_updated` merge was mid-flight
     * raced it exactly the way two merges used to race each other (see
     * `mergeAndSave`'s note). The merge's `existing` is read before the
     * delete, so its `merged` array still had the deleted entry — and
     * whichever `_save` ran last, usually the merge's since it goes on to
     * touch other chunks, put the entry straight back.
     * @param {number} characterActionId - Which entry to remove
     * @returns {Promise<void>} Resolves when this delete has been queued for writing
     */
    async deleteEntry(characterActionId) {
        const run = () => this._deleteEntry(characterActionId);
        this._chain = this._chain.then(run, run);
        return this._chain;
    }

    /**
     * @param {number} characterActionId - Which entry to remove
     * @returns {Promise<void>}
     * @private
     */
    async _deleteEntry(characterActionId) {
        try {
            const charId = this._charId();
            if (!charId) return;

            const existing = await this._load(charId);
            // See `_merge`'s note on the same check: a switch landing inside the
            // read must not have this delete's save land under the character
            // that switched away.
            if (this._charId() !== charId) return;

            const filtered = existing.filter((e) => e.characterActionId !== characterActionId);
            if (filtered.length === existing.length) return;

            this._save(filtered, undefined, charId);
        } catch (error) {
            // Never rejected, for the same reason `_mergeAndSave` never is: the
            // chain is what the next queued write extends.
            console.error('[LootLogHistory] Deleting an entry failed:', error);
        }
    }

    /**
     * Get entries that are in storage but not in the current game-provided set.
     * @param {Set<number>} currentIds - characterActionIds from the current loot_log_updated
     * @returns {Promise<Array>}
     */
    async getHistoricalEntries(currentIds) {
        const all = await this._load();
        return all.filter((e) => !currentIds.has(e.characterActionId));
    }

    async clearHistory() {
        const charId = this._charId();
        if (!charId) return;
        await this._store.clear(charId);
    }
}

const lootLogHistory = new LootLogHistory();
export default lootLogHistory;

// A character switch must not serve the departing character's entries to the
// arriving one, nor write them back under the arriving one's keys
dataManager.on?.('character_switching', () => lootLogHistory._store.forget());
