/**
 * Append-only history, stored as records rather than as one array.
 *
 * ## The write amplification this exists to end
 *
 * A recorder that keeps its history in a single key does the same three things
 * on every event: read the whole array, push one entry, write the whole array
 * back. The cost of recording one loot drop is therefore the size of every loot
 * drop already recorded, and it grows for as long as the player keeps playing —
 * which is the shape of every quota failure this script has had. The loot log
 * rewrote five hundred entries per `loot_log_updated`; the alchemy trackers
 * rewrote every session ever, immediately, on every completed action.
 *
 * Splitting the array over several keys makes the write proportional to what
 * changed instead of to what is kept. A new entry lands in one record; the other
 * records are untouched, so IndexedDB never sees them.
 *
 * ## Chunks, not one key per entry
 *
 * A key per entry would make every write minimal, and would also put a thousand
 * keys per character into a store whose soft budget is measured in hundreds (see
 * `STORE_KEY_BUDGETS` in `core/storage.js`). Grouping entries by the hour, day or
 * month they belong to keeps both numbers small: the record written is the
 * current bucket, which holds the handful of entries recorded since the bucket
 * opened, and the key count grows with calendar time rather than with events.
 *
 * ## What the callers keep
 *
 * Nothing above this changes shape. A recorder still holds its history as one
 * array, still hands the whole array to `save()`, and still gets the whole array
 * back from `load()`. The diff against the last known state is what turns a
 * whole-array save into a one-record write, so the call sites did not have to
 * learn about chunking to stop paying for it.
 *
 * ## Migration, and what happens when the disk is full
 *
 * The legacy single-array key is split on the first read and then deleted. If
 * the split cannot be written — which on a full disk is exactly when it matters —
 * the legacy key is left alone and the recorder keeps using it. A migration that
 * bricked the history the moment storage filled up would be worse than the write
 * amplification it was meant to fix.
 */

import storage from '../core/storage.js';
import { registerSyncMerge } from './sync-merge-registry.js';

/**
 * Prefixes whose sync merge is already registered.
 *
 * Registration happens per constructed store, and a store is a module-scope
 * singleton — but tests build several, and a duplicate registration would put
 * a second identical entry in the registry's list for no gain.
 */
const registeredPrefixes = new Set();

/**
 * How long a deletion is remembered.
 *
 * A tombstone only has to outlive the slowest round trip between two devices —
 * the other machine being switched on, pulling, and pushing back. A month
 * covers a laptop left shut over a holiday; past that the deletion is dropped
 * and the key stops growing, which is the same trade `custom-tabs-data.js`
 * makes for the same reason. An expired tombstone degrades to the behaviour
 * this file had before it existed (a peer still holding the entry revives it),
 * never to losing an entry nobody deleted.
 */
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Most deletions one record remembers, newest kept.
 *
 * Thirty days of unbounded deleting is bounded by nothing at all, and this key
 * is rewritten whenever it changes — an unbounded one would reintroduce the
 * write amplification this whole module exists to end. The newest deletion is
 * the one a peer has least likely seen, so the oldest are evicted first.
 */
export const MAX_TOMBSTONES = 500;

/**
 * Below this many dropped entries a fold is never refused: a two-entry history
 * has no majority worth protecting, and the refusal is about accidents of
 * scale rather than about single deletions.
 */
const MASS_DELETE_FLOOR = 2;

/** Two digits, for a date part */
const pad = (value) => String(value).padStart(2, '0');

/**
 * A cheap content hash of an entry, for "has this copy been touched since?".
 *
 * FNV-1a over the entry's JSON. It is not the entry's identity — that is the
 * caller's `identityOf` — but a stamp of the entry's *contents* at the moment
 * it was deleted, which is the only last-touched signal a generic store has:
 * these entries carry no `updatedAt`, and the one entry shape that mutates in
 * place (the loot log's live session, whose `endTime` and `actionCount` are
 * rewritten while it runs) changes its JSON every time it is touched.
 * @param {Object} entry - A history entry
 * @returns {string} An 8-ish character hash, or '' for an entry that will not serialise
 */
function fingerprintOf(entry) {
    let json;
    try {
        json = JSON.stringify(entry);
    } catch {
        return '';
    }
    if (typeof json !== 'string') return '';
    let hash = 0x811c9dc5;
    for (let index = 0; index < json.length; index += 1) {
        hash ^= json.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

/**
 * A stored tombstone map, absent or corrupt one included.
 *
 * The shape is `id → {at, fp, bulk}`: when the deletion happened, what the
 * entry looked like when it did, and whether it came from a whole-record
 * `clear()` rather than from a single-entry deletion.
 * @param {*} value - What was under the tombstone key
 * @returns {Object<string, {at: number, fp: string, bulk: boolean}>} The map
 */
function stonesOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [id, stone] of Object.entries(value)) {
        if (!stone || typeof stone !== 'object') continue;
        const at = Number(stone.at);
        out[id] = {
            at: Number.isFinite(at) ? at : 0,
            fp: typeof stone.fp === 'string' ? stone.fp : '',
            bulk: stone.bulk === true,
        };
    }
    return out;
}

/**
 * Forget deletions older than `TOMBSTONE_MAX_AGE_MS`, then hold the rest to
 * `MAX_TOMBSTONES`, newest first.
 * @param {Object<string, Object>} stones - The map, mutated in place
 * @param {number} [now] - Clock, for tests
 * @returns {boolean} Whether anything was dropped
 */
function ageTombstones(stones, now = Date.now()) {
    let changed = false;
    for (const [id, stone] of Object.entries(stones)) {
        if (now - stone.at < TOMBSTONE_MAX_AGE_MS) continue;
        delete stones[id];
        changed = true;
    }
    const ids = Object.keys(stones);
    if (ids.length <= MAX_TOMBSTONES) return changed;
    ids.sort((one, two) => stones[two].at - stones[one].at);
    for (const id of ids.slice(MAX_TOMBSTONES)) delete stones[id];
    return true;
}

/**
 * Fold two devices' tombstone maps, the later deletion winning per id.
 *
 * Registered as the sync merge for the tombstone key, so a deletion that only
 * one device knows about survives the pull that would otherwise write the
 * other device's map over it — which is the whole point: without this, a
 * device that had never deleted anything would erase the record of the
 * deletion and then push the entry back.
 * @param {*} local - This device's map
 * @param {*} incoming - The map coming down
 * @param {number} [now] - Clock, for tests
 * @returns {Object<string, Object>} The union, aged and capped
 */
export function mergeTombstones(local, incoming, now = Date.now()) {
    const out = stonesOf(local);
    for (const [id, stone] of Object.entries(stonesOf(incoming))) {
        const held = out[id];
        if (!held || stone.at > held.at) out[id] = stone;
        else if (stone.at === held.at && stone.bulk) out[id] = stone;
    }
    ageTombstones(out, now);
    return out;
}

/**
 * Which bucket a timestamp falls in.
 *
 * UTC rather than local time, so a chunk id does not change meaning when the
 * player travels or the clocks go back — a record written in one zone has to be
 * found again from another.
 *
 * @param {number} t - Milliseconds since the epoch
 * @param {'month'|'day'|'hour'} granularity - How wide a bucket is
 * @returns {string} A sortable id: `YYYY-MM`, `YYYY-MM-DD` or `YYYY-MM-DDTHH`
 */
export function timeChunkId(t, granularity = 'month') {
    const date = new Date(Number.isFinite(t) ? t : 0);
    const month = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    if (granularity === 'month') return month;
    const day = `${month}-${pad(date.getUTCDate())}`;
    if (granularity === 'day') return day;
    return `${day}T${pad(date.getUTCHours())}`;
}

/**
 * The character ids a set of record keys names.
 *
 * Record keys are `<prefix>_<characterId>_<chunkId>`, so the id is the segment
 * between the prefix and the next underscore. Character ids are alphanumeric
 * (see `NETWORTH_SERIES_RE` in `utils/character-key.js`), which is what makes
 * that split unambiguous.
 *
 * @param {Array<string>} keys - Keys from one store
 * @param {string} prefix - The record prefix including its trailing underscore
 * @returns {Array<string>} Character ids, in key order, deduplicated
 */
export function idsFromRecordKeys(keys, prefix) {
    const ids = [];
    const seen = new Set();
    for (const key of keys || []) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const end = rest.indexOf('_');
        if (end <= 0) continue;
        const id = rest.slice(0, end);
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * Every record key in a store belonging to one character.
 *
 * @param {Array<string>} keys - Keys from one store
 * @param {string} prefix - The record prefix, without its trailing underscore
 * @param {string} charId - Whose records to pick out
 * @returns {Array<string>} Matching keys, in chunk-id order
 */
export function recordKeysFor(keys, prefix, charId) {
    const scoped = `${prefix}_${charId}_`;
    return (keys || []).filter((key) => typeof key === 'string' && key.startsWith(scoped)).sort();
}

/**
 * Record prefixes registered per store, for a per-character budget check.
 *
 * A chunked history writes many keys for one character — one per time bucket —
 * so a flat count of a store's keys adds every character's buckets together.
 * `STORE_KEY_BUDGETS` in `core/storage.js` is sized per character for exactly
 * the stores this file backs (its comments say so), so a flat total trips the
 * budget for any account with more than a handful of characters even when no
 * single one of them is anywhere near it. Recorded here as each
 * `ChunkedHistory` is built — module-scope singletons, constructed once, well
 * before any budget report runs — so `core/storage.js` can ask what the
 * busiest single character is doing instead, without importing this file:
 * that import already runs the other way, since this file needs `storage`.
 * @type {Map<string, Set<string>>} storeName -> prefixes
 */
const chunkedStorePrefixes = new Map();

/**
 * Note that a store now has a chunked recorder under this prefix.
 *
 * Idempotent: the pairs live in a `Set`, so a recorder built more than once in
 * a session — `createAlchemySessionStore` is called afresh on every gold-source
 * collection — registers the same pair again and changes nothing.
 * @param {string} storeName - Object store the records live in
 * @param {string} prefix - Record key prefix, without its trailing underscore
 */
function registerChunkedStore(storeName, prefix) {
    if (!storeName || !prefix) return;
    if (!chunkedStorePrefixes.has(storeName)) chunkedStorePrefixes.set(storeName, new Set());
    chunkedStorePrefixes.get(storeName).add(prefix);
}

/**
 * Count a `<prefix>_<charId>_<suffix>` key family that this file does not own.
 *
 * A per-character budget covers everything one character keeps in the store,
 * and not every such key family goes through `ChunkedHistory`. `networthHistory`
 * budgets twenty-five item-level detail snapshots per character beside the
 * series chunks (see `STORE_KEY_BUDGETS`), and those are written key by key by
 * `networth-history.js`; left unregistered they vanish from the per-character
 * count, so the budget can no longer see them grow — and they are deleted
 * fire-and-forget, which is exactly how a key family leaks.
 *
 * The key must carry a chunk-like third segment: the id is read as the run up
 * to the next underscore, so a two-segment `<base>_<charId>` key is ignored,
 * which is what keeps a legacy key out of the count.
 * @param {string} storeName - Object store the keys live in
 * @param {string} prefix - Key prefix, without its trailing underscore
 * @returns {void}
 */
export function registerCharacterScopedPrefix(storeName, prefix) {
    registerChunkedStore(storeName, prefix);
}

/**
 * The most chunk-history records any single character has in a store.
 *
 * Sums every registered prefix's contribution per character first — a store
 * such as `xpHistory` chunks two independent series (skills, abilities) under
 * different prefixes, and a character's real footprint is both together — then
 * reports the busiest character rather than the account total, which is the
 * number `STORE_KEY_BUDGETS`'s per-character comments are actually about.
 *
 * @param {string} storeName - The store to check
 * @param {Array<string>} keys - Every key currently in the store
 * @returns {number|null} The busiest character's key count, or null when
 *   nothing chunked in this file writes to that store — a flat count is then
 *   the right answer, and the caller should fall back to it
 */
export function maxRecordsPerCharacter(storeName, keys) {
    const prefixes = chunkedStorePrefixes.get(storeName);
    if (!prefixes || prefixes.size === 0) return null;

    const perCharacter = new Map();
    for (const prefix of prefixes) {
        for (const id of idsFromRecordKeys(keys, `${prefix}_`)) {
            const count = recordKeysFor(keys, prefix, id).length;
            perCharacter.set(id, (perCharacter.get(id) || 0) + count);
        }
    }

    let max = 0;
    for (const count of perCharacter.values()) max = Math.max(max, count);
    return max;
}

/**
 * A history kept as one record per time bucket.
 *
 * @param {Object} options - Wiring
 * @param {string} options.storeName - Object store the records live in
 * @param {string} options.prefix - Record key prefix, e.g. `lootLogRec`
 * @param {Function} options.legacyKey - `(charId) => string`, the pre-split single key
 * @param {Function} options.groupOf - `(entry) => string`, which chunk an entry belongs to
 * @param {Function} options.compare - Sort comparator for the assembled array
 * @param {boolean} [options.immediate] - Skip write debouncing, for recorders that did
 * @param {Function} [options.identityOf] - `(entry) => string`, what makes two entries the
 *   same entry when two copies of the history are folded together. Defaults to the entry's
 *   JSON, which is a deep-equality test and is right for any history whose entries are plain
 *   data; a recorder whose entries carry a mutable field (an in-progress session's `endTime`)
 *   should name its stable id instead.
 * @param {string} [options.label] - Module name for log lines
 * @returns {ChunkedHistory} The store
 */
export function createChunkedHistory(options) {
    return new ChunkedHistory(options);
}

class ChunkedHistory {
    constructor({
        storeName,
        prefix,
        legacyKey,
        groupOf,
        compare,
        immediate = false,
        identityOf,
        label = 'ChunkedHistory',
    }) {
        this.storeName = storeName;
        this.prefix = prefix;
        this.legacyKey = legacyKey;
        this.groupOf = groupOf;
        this.compare = compare;
        this.immediate = immediate;
        this.identityOf = identityOf || defaultIdentity;
        this.label = label;

        /** Whose records are in memory */
        this._charId = null;
        /** Whether a read has happened for that character */
        this._loaded = false;
        /** The assembled array, which is the truth between flushes */
        this._entries = [];
        /** chunkId → {json, count} last written for it, so a save can write only what moved */
        this._snapshot = new Map();
        /**
         * The loaded character's deletions, `id → {at, fp, bulk}`.
         *
         * Read with the records and consulted wherever an entry could come
         * back: `_union`, for a copy folding in from a peer, and the read
         * itself, for one a pull has already written to disk.
         */
        this._tombs = {};
        /**
         * Whether the split failed and the legacy key is still the record.
         *
         * Set when a migration could not be written — a full disk, a database
         * that will not answer. Reads and writes then go to the legacy key as
         * they always did, and the next session tries the split again.
         */
        this._legacy = false;

        /**
         * The character whose last read could not be made at all.
         *
         * Distinct from "not loaded": a load superseded by a character switch
         * read fine and is simply not ours to commit, and `save()` still writes
         * for it. A read that *failed* means the disk holds entries this store
         * has never seen, and writing the caller's list over them is the one
         * thing that must not happen.
         */
        this._unreadableFor = null;

        /** The read in flight, so two concurrent `load()`s share one */
        this._loading = null;
        /** Which read is current, so one abandoned by `forget()` does not commit */
        this._loadToken = 0;

        registerChunkedStore(storeName, prefix);
        this._registerSyncMerge();
    }

    /**
     * Teach a sync pull how to combine two devices' copies of one chunk.
     *
     * Without this, a chunk key arriving in a pull is written whole — the
     * remote's entries for that hour/day/month replacing this device's,
     * because `importEverything` writes keys and knows nothing about what is
     * inside them. Every chunked history is append-only, so the union is the
     * only reading of "apply the remote copy" that does not throw away entries
     * one side has never seen.
     *
     * The matcher is the record prefix, which covers every character and every
     * chunk of this history in one registration. The merge is pure: it reads
     * nothing and writes nothing, which is what the registry requires.
     *
     * **The legacy key needs the same cover.** The record prefix deliberately
     * cannot match it — `lootLogRec_` against `lootLog_<id>`, `prodIncomeRec_`
     * against `prodIncome_<id>` — which is what keeps a character id from being
     * read as a chunk id, and is also why nothing claimed the legacy key at all.
     * A store whose split could not be written stays in `_legacy` mode and keeps
     * the whole array there (see `save()`), so on that device a pull replaced
     * the entire history with the remote's copy. The split fails on a full disk,
     * which is exactly when losing entries is least affordable. Same union, one
     * more registration.
     * @private
     */
    _registerSyncMerge() {
        if (!this.storeName || !this.prefix) return;
        const scope = `${this.storeName}:${this.prefix}`;
        if (registeredPrefixes.has(scope)) return;
        registeredPrefixes.add(scope);

        /**
         * The union, when both sides are arrays. Either side being something
         * else is a key that is not this history's after all, and the safe
         * reading of that is the whole-key write it would have had.
         * @param {*} local - This device's value
         * @param {*} incoming - The value coming down
         * @returns {*} Merged
         */
        const merge = (local, incoming) => {
            if (!Array.isArray(local)) return incoming;
            if (!Array.isArray(incoming)) return local;
            return this._union(local, incoming);
        };

        registerSyncMerge({
            store: this.storeName,
            prefix: `${this.prefix}_`,
            label: `${this.label} records`,
            merge,
        });

        // The deletions, under their own claim. Deliberately NOT
        // `${prefix}_tomb_`: that key would also match the record matcher
        // above, and `mergeForKey()`'s contract is that exactly one
        // registration owns a key — an overlap resolves to bundle import
        // order, which here would hand a tombstone map to the array union and
        // take the remote copy whole. `${prefix}Tomb_` cannot be read as a
        // record key by any of `recordKeysFor`, `idsFromRecordKeys` or the
        // record matcher, for the same reason the legacy stem cannot be.
        registerSyncMerge({
            store: this.storeName,
            prefix: `${this.prefix}Tomb_`,
            label: `${this.label} deletions`,
            merge: (local, incoming) => mergeTombstones(local, incoming),
        });

        const legacyBase = this._legacyBase();
        if (legacyBase) {
            registerSyncMerge({
                store: this.storeName,
                base: legacyBase,
                label: `${this.label} legacy key`,
                merge,
            });
        }
    }

    /**
     * The unscoped stem of the legacy key, for the registration above.
     *
     * Every caller's `legacyKey` is `${base}_${charId}` — or, where a store
     * predates character scoping, the bare `base` for the id `'default'`. That
     * is precisely the shape `scopedKeyMatcher` covers, so the stem is all the
     * registry needs. It is derived rather than declared so a call site cannot
     * quietly opt out of sync cover by forgetting to pass it.
     * @returns {string|null} The stem, or null when `legacyKey` is not that shape
     * @private
     */
    _legacyBase() {
        if (typeof this.legacyKey !== 'function') return null;
        try {
            const probe = this.legacyKey('');
            if (typeof probe !== 'string' || !probe.endsWith('_')) return null;
            return probe.slice(0, -1) || null;
        } catch (error) {
            console.error(`[${this.label}] Could not derive the legacy key stem for sync:`, error);
            return null;
        }
    }

    /**
     * The union of two copies of one bucket, in the comparator's order.
     *
     * Base first: an entry both sides have keeps this device's copy, which for
     * a session still being recorded is the one with the live figures in it.
     *
     * **Tombstones apply to the incoming side only.** An entry this device does
     * not hold and has a tombstone for is one the user deleted here, and the
     * union is what used to hand it straight back. This device's own entries
     * are never dropped here: a merge has no idea which character's chunk it
     * has been handed — `mergeForKey()` passes values, not keys — so the
     * tombstones in hand may belong to a different character than the chunk
     * does. Requiring the fingerprint to match as well as the id makes that
     * mistake need identical contents too, and the read path, which IS
     * character-scoped, is where a copy already on disk is filtered.
     * @param {Array<Object>} base - This device's entries
     * @param {Array<Object>} extra - The entries being folded in
     * @param {Object} [stones] - The tombstones to judge against; the loaded
     *   character's, except during a read, which has not committed its own yet
     * @returns {Array<Object>} The union
     * @private
     */
    _union(base, extra, stones = this._tombs) {
        const seen = new Set();
        const out = [];
        const held = new Set();
        for (const entry of base) {
            const id = this._identity(entry);
            if (id !== undefined && id !== null) held.add(id);
        }
        for (const entry of [...base, ...extra]) {
            if (entry == null) continue;
            const id = this._identity(entry);
            // An entry with no usable identity cannot be deduplicated; keeping
            // it is the safe half of the choice
            if (id === undefined || id === null) {
                out.push(entry);
                continue;
            }
            if (seen.has(id)) continue;
            seen.add(id);
            if (!held.has(id) && this._tombstoned(id, entry, stones)) continue;
            out.push(entry);
        }
        return this._sorted(out);
    }

    /**
     * @param {Object} entry - A history entry
     * @returns {*} What `identityOf` makes of it, or undefined when it throws
     * @private
     */
    _identity(entry) {
        if (entry == null) return undefined;
        try {
            return this.identityOf(entry);
        } catch {
            return undefined;
        }
    }

    /**
     * Whether a tombstone applies to this copy of an entry.
     *
     * A tombstone whose fingerprint does not match the copy in hand does NOT
     * apply. That copy has been written since the deletion was recorded — the
     * loot log's live session gains `endTime` and `actionCount` for as long as
     * it runs — so it has already seen the deletion and kept the entry, and the
     * deletion is stale news. Same judgement `custom-tabs-data.js` makes
     * against a tab's `updatedAt`, against the only stamp these entries have.
     * @param {string} id - The entry's identity
     * @param {Object} entry - The copy being judged
     * @param {Object} stones - The tombstone map to look in
     * @returns {boolean} True when the entry should be dropped
     * @private
     */
    _tombstoned(id, entry, stones) {
        const stone = stones[id];
        if (!stone) return false;
        // Aged out here as well as on the way in: a fold can run for hours
        // against a map that was read when the page loaded
        if (Date.now() - stone.at >= TOMBSTONE_MAX_AGE_MS) return false;
        return stone.fp !== '' && stone.fp === fingerprintOf(entry);
    }

    /**
     * @param {string} charId - Whose record
     * @param {string} chunkId - Which bucket
     * @returns {string} The key that bucket lives under
     */
    keyFor(charId, chunkId) {
        return `${this.prefix}_${charId}_${chunkId}`;
    }

    /**
     * @param {string} charId - Whose deletions
     * @returns {string} The key this character's tombstones live under
     */
    tombKey(charId) {
        return `${this.prefix}Tomb_${charId}`;
    }

    /**
     * This character's deletions, aged and capped on the way in.
     *
     * Reads nothing when the key is not in the listing the caller already has,
     * so a history nobody has ever deleted from costs exactly the round trips
     * it always did.
     * @param {Array<string>} keys - The store's key listing
     * @param {string} charId - Whose deletions
     * @returns {Promise<{stones: Object, changed: boolean}>} The map, and whether ageing moved it
     * @private
     */
    async _readTombs(keys, charId) {
        const key = this.tombKey(charId);
        if (!keys.includes(key)) return { stones: {}, changed: false };
        try {
            const stones = stonesOf(await storage.get(key, this.storeName, null));
            const changed = ageTombstones(stones);
            return { stones, changed };
        } catch (error) {
            console.error(`[${this.label}] Reading the deletion record failed:`, error);
            return { stones: {}, changed: false };
        }
    }

    /**
     * Persist a tombstone map, or delete the key when nothing is left in it.
     *
     * Fire and forget: nothing downstream waits on it, and a write that does
     * not land leaves the map exactly as it was on disk — which is the same
     * degradation an expired tombstone has.
     * @param {string} charId - Whose deletions
     * @param {Object} stones - The map to write
     * @returns {Promise<*>} The write, for callers that must await it
     * @private
     */
    _writeTombs(charId, stones) {
        const key = this.tombKey(charId);
        const write =
            Object.keys(stones).length === 0
                ? storage.delete(key, this.storeName)
                : storage.set(key, stones, this.storeName, this.immediate);
        return Promise.resolve(write).catch((error) => {
            console.error(`[${this.label}] Writing the deletion record failed:`, error);
        });
    }

    /**
     * Drop the entries a tombstone claims, or refuse the lot.
     *
     * Runs on every read, not only on a sync fold: a pull writes chunk keys
     * straight to disk, and the merge that saw them may never have been given
     * this character's tombstones (see `_union`). The read is where the
     * deletion is applied for certain, because it is the one place that knows
     * whose record it is holding.
     *
     * **The mass-delete refusal.** Tombstones are the only thing in this file
     * that can delete, they arrive from a peer that may be wrong about them,
     * and "most of my history vanished on a page load" is never the outcome the
     * user wanted. So a fold that would drop more than half the entries — and
     * more than `MASS_DELETE_FLOOR` of them, since a two-entry history has no
     * majority worth protecting — keeps every entry and holds the tombstones
     * back UN-APPLIED, so a genuinely widespread deletion still applies later.
     * A whole-record `clear()` is exempt: its tombstones are marked `bulk`, and
     * emptying the record is exactly what the user asked for. The threshold is
     * counted over the non-`bulk` drops alone, so a clear arriving beside an
     * ordinary deletion still empties the record.
     *
     * @param {Array<Object>} entries - The assembled history
     * @param {Object} stones - The tombstone map, mutated: a revived id is cleared
     * @returns {{entries: Array<Object>, changed: boolean, dropped: Array<Object>}} What survives
     * @private
     */
    _applyTombstones(entries, stones) {
        // Identity is `JSON.stringify` by default, so the loop below is not
        // free; a history nobody has deleted from must not pay for it
        if (Object.keys(stones).length === 0) return { entries, changed: false, dropped: [] };
        let changed = false;
        const kept = [];
        const dropped = [];
        for (const entry of entries) {
            const id = this._identity(entry);
            const stone = id === undefined || id === null ? undefined : stones[id];
            if (!stone) {
                kept.push(entry);
                continue;
            }
            if (!this._tombstoned(id, entry, stones)) {
                // Touched since the deletion, so this copy has outlived it
                delete stones[id];
                changed = true;
                kept.push(entry);
                continue;
            }
            dropped.push(entry);
        }

        const casual = dropped.filter((entry) => stones[this._identity(entry)]?.bulk !== true).length;
        if (casual > MASS_DELETE_FLOOR && casual * 2 > entries.length) {
            console.warn(
                `[${this.label}] Refusing a fold that would delete ${casual} of ${entries.length} entries at once; ` +
                    'keeping every entry and holding the tombstones back un-applied.'
            );
            return { entries, changed, dropped: [] };
        }
        if (dropped.length === 0) return { entries, changed, dropped };
        return { entries: kept, changed, dropped };
    }

    /** @returns {boolean} True while the legacy single-array key is still in use */
    isLegacy() {
        return this._legacy;
    }

    /**
     * The whole history, oldest or newest first per the comparator.
     *
     * Returns a copy: the array held here is what the next save diffs against,
     * and a caller that sorted or spliced the live one would make that diff a
     * lie. The entry objects themselves are shared, which is what lets a
     * recorder mutate the session it is in the middle of.
     *
     * @param {string} charId - Whose history
     * @returns {Promise<Array<Object>>} The assembled entries
     */
    async load(charId) {
        if (!charId) return [];
        if (this._loaded && this._charId === charId) return [...this._entries];

        // `_loaded` used to be set before the read, so a second caller arriving
        // while the first was still awaiting storage was told the history was
        // loaded and handed the empty array — and a recorder that merges onto
        // what it was handed then wrote that emptiness back. Both callers wait
        // on the same read instead.
        if (this._loading && this._loadingCharId === charId) return [...(await this._loading)];

        const token = (this._loadToken += 1);
        this._loadingCharId = charId;
        this._loading = this._read(charId, token);
        try {
            return [...(await this._loading)];
        } finally {
            if (this._loadToken === token) {
                this._loading = null;
                this._loadingCharId = null;
            }
        }
    }

    /**
     * One read of a character's history, committed to memory only if it is
     * still the read anyone is waiting for.
     * @param {string} charId - Whose history
     * @param {number} token - This read's identity, against `forget()` mid-read
     * @returns {Promise<Array<Object>>} The assembled entries
     * @private
     */
    async _read(charId, token) {
        const state = {
            entries: [],
            snapshot: new Map(),
            tombs: {},
            tombsChanged: false,
            legacy: false,
            readable: true,
        };

        try {
            const legacy = await storage.get(this.legacyKey(charId), this.storeName, null);

            if (Array.isArray(legacy) && legacy.length > 0) {
                const split = await this._migrate(charId, legacy, state);
                state.legacy = !split.ok;
                state.entries = this._sorted(split.entries);
            } else {
                if (Array.isArray(legacy)) {
                    // An empty legacy array is nothing to split and nothing to keep
                    await storage.delete(this.legacyKey(charId), this.storeName);
                }
                const records = await this._readRecords(charId, state);
                if (records === null) state.readable = false;
                else state.entries = records;
            }
        } catch (error) {
            console.error(`[${this.label}] Reading the history failed:`, error);
            state.readable = false;
            state.entries = [];
        }

        // A read that could not be made is not an empty history. Committing it
        // would mark the store loaded with nothing in it, and the next `save()`
        // would write the caller's list — one appended entry, for an appending
        // recorder — over the bucket on disk. Remember the failure instead:
        // `_loaded` stays false so the next `load()` reads again, and `save()`
        // declines to write over what it could not read.
        if (!state.readable) {
            console.warn(`[${this.label}] The history for ${charId} could not be read; not treating it as empty`);
            this._unreadableFor = charId;
            return state.entries;
        }
        // A character switch during the read means these entries belong to
        // nobody now; handing them back is fine, writing them into the store's
        // memory under the arriving character is not.
        //
        // Clearing `_unreadableFor` belongs on this side of the check for the
        // same reason. A read abandoned here is about a character who has
        // already left, so its success says nothing about the read the store is
        // actually waiting on — and answering after a *current* read has failed,
        // it used to erase that read's flag, which is the one thing keeping
        // `save()` from writing the caller's list over history it never read.
        if (this._loadToken !== token) return state.entries;
        this._unreadableFor = null;

        // A pull writes chunk keys whole, and the merge that saw them cannot
        // know whose record it was handed (`_union`), so the read is where a
        // resurrected entry is actually caught. Chunks that lost an entry drop
        // out of the snapshot, which is what makes the next save rewrite them.
        const applied = this._applyTombstones(state.entries, state.tombs);
        state.entries = applied.entries;
        for (const entry of applied.dropped) {
            try {
                state.snapshot.delete(String(this.groupOf(entry)));
            } catch {
                // A chunk id that cannot be derived is one the next save
                // rewrites anyway, having never matched a snapshot entry
            }
        }
        if (applied.changed || state.tombsChanged) this._writeTombs(charId, state.tombs);

        this._charId = charId;
        this._entries = state.entries;
        this._snapshot = state.snapshot;
        this._tombs = state.tombs;
        this._legacy = state.legacy;
        this._loaded = true;
        return [...this._entries];
    }

    /**
     * Persist a whole history, writing only the chunks that moved.
     *
     * Deliberately not awaited by most callers: the debounced write's promise
     * resolves when its timer fires, so awaiting it would stall the caller for
     * the debounce delay. `storage.flushAll()` on unload is what lands the last
     * one.
     *
     * @param {string} charId - Whose history
     * @param {Array<Object>} entries - The history as it now stands
     * @param {Object} [options] - Save options
     * @param {string|Array<string>|Set<string>} [options.changedChunks] - Chunk ids that may have
     *   changed since the last save. An append knows exactly one — `groupOf(entry)` — and passing
     *   it skips serialising every other chunk just to discover they are identical. Omit it and
     *   every chunk is compared, which is always correct and always the full cost.
     * @returns {Promise<boolean>} False when there was nowhere to write it
     */
    async save(charId, entries, options = {}) {
        if (!charId) return false;

        // A save before any read has nothing to diff against, and taking the
        // list as the whole truth would delete every chunk it does not mention
        if (!this._loaded || this._charId !== charId) await this.load(charId);

        // The read above could not be made — a disconnected database, an
        // aborted transaction. What is on disk is unknown, and the list in hand
        // is whatever the caller has accumulated since, which for an appending
        // recorder is a single entry; writing it would replace the current
        // bucket with that entry. Decline, and let a later save retry the read.
        if (this._unreadableFor === charId && !(this._loaded && this._charId === charId)) {
            console.warn(`[${this.label}] Not saving ${charId}: the stored history could not be read`);
            return false;
        }

        // The load above can be superseded: a character switch starting its own
        // load takes the `_loadToken`, so this one returns its entries without
        // committing them, and `_charId`/`_entries`/`_snapshot`/`_legacy` end up
        // describing the ARRIVING character instead. Writing through them then
        // did two things. `_entries` was overwritten with this character's list
        // while `_charId` named the other one, and `load()` short-circuits on
        // `_charId` — so the arriving character was handed the departing one's
        // history, and its next save wrote that history under the arriving
        // character's chunk keys. And the chunk-diff cache, which decides what
        // NOT to write, was consulted against another character's
        // serialisations, so a chunk could be skipped for ever on the strength
        // of a match that was never about it.
        //
        // Every key below is built from `charId`, so the write itself is always
        // safe to make; it is only the shared memory that has to be left alone.
        const owns = this._loaded && this._charId === charId;
        const snapshot = owns ? this._snapshot : new Map();

        const list = Array.isArray(entries) ? entries : [];
        const before = owns ? this._entries : [];
        if (owns) {
            this._entries = this._sorted(list);
            this._recordDeletions(charId, before, this._entries);
        }

        if (owns && this._legacy) {
            storage.set(this.legacyKey(charId), list, this.storeName, this.immediate);
            return true;
        }

        const grouped = this._group(list);
        const next = new Map();
        const pending = [];

        // A history of a year of hourly records is hundreds of chunks, and
        // appending one entry used to re-serialise all of them on every append
        // purely to find the one that moved. A caller that knows which chunk it
        // touched says so, and the rest are carried over from the snapshot
        // untouched.
        const changedChunks = normalizeChunkHint(options.changedChunks);

        for (const [chunkId, bucket] of grouped) {
            const previous = snapshot.get(chunkId);

            // Only skip a chunk the caller vouched for AND that we have a previous
            // serialisation of — a chunk we have never written has to be written
            // whatever the hint says. The entry count is the safety net: a prune that
            // took *some* entries out of an older chunk leaves it out of the hint of an
            // appending caller, and skipping it would carry the stale serialisation
            // forward so the shrink never reached disk. Counting is free next to
            // serialising, and a chunk only ever shrinks by losing entries.
            if (
                changedChunks &&
                !changedChunks.has(chunkId) &&
                previous !== undefined &&
                previous.count === bucket.length
            ) {
                next.set(chunkId, previous);
                continue;
            }

            const serialized = JSON.stringify(bucket);
            next.set(chunkId, { json: serialized, count: bucket.length });
            if (previous?.json === serialized) continue;

            // The snapshot is what makes an identical future save skip this
            // chunk, so recording the write before knowing it landed is a claim
            // that a dropped write turns into a permanent one: the chunk is
            // never written again, because it always looks already written.
            // A refused write evicts its own entry so the next save retries it.
            // The write itself stays debounced — the promise a debounced write
            // returns resolves with the outcome when its timer fires, which is
            // exactly the answer needed and is not worth waiting for here.
            const write = Promise.resolve(
                storage.set(this.keyFor(charId, chunkId), bucket, this.storeName, this.immediate)
            ).then((ok) => {
                if (ok === false) this._evictSnapshot(chunkId, serialized);
                return ok;
            });
            write.catch((error) => {
                console.error(`[${this.label}] Writing chunk ${chunkId} failed:`, error);
                this._evictSnapshot(chunkId, serialized);
            });
            if (this.immediate) pending.push(write);
        }

        // A rolling window drops its oldest entries; here that is a chunk that
        // no longer has any, and pruning is deleting its key
        for (const chunkId of snapshot.keys()) {
            if (next.has(chunkId)) continue;
            pending.push(storage.delete(this.keyFor(charId, chunkId), this.storeName));
        }

        if (owns) this._snapshot = next;

        if (pending.length > 0) await Promise.all(pending);
        return true;
    }

    /**
     * Remember the entries this save took out, so a pull cannot put them back.
     *
     * **Only an INTERIOR removal counts.** `save()` is handed a whole list and
     * cannot be told why an id has gone from it, and most of the ids that go
     * are not deletions at all: every recorder on this store keeps a rolling
     * window (the loot log's 2000 newest, the networth series' year, the task
     * tracker's window), and a window drops from an END. Tombstoning those
     * would turn routine housekeeping into an instruction to a peer to delete
     * entries it is still entitled to keep — a far worse bug than the one this
     * fixes. A removal with a survivor on both sides of it in the stored order
     * is not a window sliding; it is an entry taken out of the middle, which is
     * what the delete buttons in the loot log, the alchemy session lists and
     * the networth chart all do.
     *
     * The cost of the rule is that deleting the single oldest or single newest
     * entry records nothing and behaves as it did before. Clearing the whole
     * record is not affected: `clear()` writes its own tombstones.
     * @param {string} charId - Whose history
     * @param {Array<Object>} previous - The list as this store last knew it, sorted
     * @param {Array<Object>} next - The list being saved, sorted
     * @returns {void}
     * @private
     */
    _recordDeletions(charId, previous, next) {
        if (previous.length === 0) return;
        const surviving = new Set();
        for (const entry of next) {
            const id = this._identity(entry);
            if (id !== undefined && id !== null) surviving.add(id);
        }
        if (surviving.size === 0) return;

        let first = -1;
        let last = -1;
        for (let index = 0; index < previous.length; index += 1) {
            if (!surviving.has(this._identity(previous[index]))) continue;
            if (first === -1) first = index;
            last = index;
        }

        const at = Date.now();
        let added = false;
        for (let index = first + 1; index < last; index += 1) {
            const entry = previous[index];
            const id = this._identity(entry);
            if (id === undefined || id === null || surviving.has(id)) continue;
            this._tombs[id] = { at, fp: fingerprintOf(entry), bulk: false };
            added = true;
        }
        if (!added) return;

        ageTombstones(this._tombs);
        this._writeTombs(charId, this._tombs);
    }

    /**
     * Drop a chunk's snapshot entry, so the next save writes it again.
     *
     * Guarded on the serialisation: a later save that changed the chunk has
     * already replaced the entry, and that newer claim is about a different
     * write whose own outcome will arrive separately.
     * @param {string} chunkId - Which bucket
     * @param {string} serialized - The serialisation whose write failed
     * @returns {void}
     * @private
     */
    _evictSnapshot(chunkId, serialized) {
        if (this._snapshot.get(chunkId)?.json === serialized) this._snapshot.delete(chunkId);
    }

    /**
     * Forget one character's history entirely, records and legacy key alike.
     *
     * Refuses rather than half-deleting. The record keys are found through the
     * store's key listing, and `getAllKeys` answers a listing it could not make
     * with an empty array — so a store the browser could not list deleted
     * nothing, dropped the in-memory copy anyway, and handed the next `load()`
     * the records still sitting on disk: the history the user had just asked to
     * delete, back again, after being told it was gone. A listing that could
     * not be made now leaves disk and memory alone and says so.
     *
     * Callers must not report success on a `false`. A "cleared!" over data that
     * is still there is the worst of the outcomes here.
     * @param {string} charId - Whose history
     * @returns {Promise<boolean>} Whether the history is gone
     */
    async clear(charId) {
        if (!charId) return false;

        // Read before deleting, so the tombstones below can name what went.
        // A read that fails leaves `entries` empty and the clear still
        // happens — it simply cannot be told to a peer, which is where this
        // module stood before tombstones existed.
        let entries = [];
        try {
            entries = await this.load(charId);
        } catch {
            entries = [];
        }
        const stones = { ...this._tombs };

        try {
            const keys = await storage.tryGetAllKeys(this.storeName);
            if (keys === null) {
                console.warn(`[${this.label}] History not cleared: the store's keys could not be listed`);
                return false;
            }
            // Issued together rather than awaited one at a time: a year of
            // hourly records is hundreds of keys, and each serial await is a
            // full transaction round trip.
            const deletions = recordKeysFor(keys, this.prefix, charId).map((key) =>
                storage.delete(key, this.storeName)
            );
            deletions.push(storage.delete(this.legacyKey(charId), this.storeName));
            // `storage.delete` resolves `false` for a delete that did not
            // happen — an aborted transaction, a lost connection, a restore in
            // progress refusing every write — and never rejects, so a listing
            // that succeeded followed by deletes that all failed would
            // otherwise report the same `true` as a clear that worked, and the
            // records would be back on the next `load()`.
            const outcomes = await Promise.all(deletions);
            if (outcomes.some((deleted) => deleted === false)) {
                console.warn(`[${this.label}] History not fully cleared: some records could not be deleted`);
                // Whatever did land makes the memory copy stale, the same way
                // a throw part-way through does.
                this.forget();
                return false;
            }
        } catch (error) {
            // Deletes may have landed before the throw, so the memory copy is
            // no longer trustworthy and is dropped — but the clear is still a
            // failure, and is reported as one.
            console.error(`[${this.label}] Clearing the history failed:`, error);
            this.forget();
            return false;
        }

        this.forget();

        // Written only once the deletes have landed: a tombstone for an entry
        // that is still on disk would be applied to this device's own copy on
        // the next read, and the clear reported `false`.
        // Every id at one stamp, so `MAX_TOMBSTONES` keeps the first
        // `MAX_TOMBSTONES` in the comparator's order (the sort is stable). A
        // history longer than the cap therefore tells a peer about only part
        // of the clear; the rest degrades to the behaviour this file had
        // before tombstones, which is the deliberate cost of a bounded key.
        const at = Date.now();
        for (const entry of entries) {
            const id = this._identity(entry);
            if (id === undefined || id === null) continue;
            // `bulk`, so the mass-delete refusal lets it through on the other
            // device: emptying the record is precisely what the user asked for
            stones[id] = { at, fp: fingerprintOf(entry), bulk: true };
        }
        ageTombstones(stones);
        if (Object.keys(stones).length > 0) await this._writeTombs(charId, stones);

        return true;
    }

    /**
     * Drop the in-memory copy, so the next read comes from storage.
     *
     * What a character switch needs: the departing character's entries must not
     * be served to the arriving one, and — far worse — must not be written back
     * under the arriving one's key.
     */
    forget() {
        this._charId = null;
        this._loaded = false;
        this._unreadableFor = null;
        this._entries = [];
        this._snapshot = new Map();
        this._tombs = {};
        this._legacy = false;
        // A read still in flight was for the departing character. Moving the
        // token past it is what stops it committing its entries into the
        // memory the arriving character is about to use.
        this._loadToken += 1;
        this._loading = null;
        this._loadingCharId = null;
    }

    /**
     * Fold a legacy single-array key into the records and remove it.
     *
     * Merge, never replace. The old shape of this wrote the legacy array's
     * chunks and then deleted every *other* record key belonging to the
     * character, on the reasoning that anything else was debris from an
     * interrupted earlier attempt. That reasoning stopped holding the moment a
     * legacy key could arrive from somewhere other than this device's own past:
     * a sync pull from a device whose split had stalled writes one, it lands
     * beside a full set of this device's records, and the next `load()` saw a
     * non-empty legacy key and deleted a year of local history to make room for
     * the five hundred entries the other device had.
     *
     * So the records are read first and the legacy entries are folded into
     * them, and no key that still carries entries is deleted — only the legacy
     * key itself. This is the shape `trade-ledger-store.js#_absorbLegacy`
     * already used for exactly the same situation.
     *
     * @param {string} charId - Whose history
     * @param {Array<Object>} legacy - The single-array value as stored
     * @param {{snapshot: Map<string, Object>}} state - The read being assembled
     * @returns {Promise<{ok: boolean, entries: Array<Object>}>} Whether the records
     *   are now the record, and the entries either way
     * @private
     */
    async _migrate(charId, legacy, state) {
        const grouped = this._group(legacy);
        if (grouped.size === 0) return { ok: false, entries: legacy };

        // What is already on disk. A stalled split elsewhere, a pull, or an
        // interrupted earlier attempt all look the same from here, and all of
        // them are entries somebody recorded.
        const existing = new Map();
        try {
            // `tryGetAllKeys`, so a listing that could not be made is not read
            // as "there are no records yet". That reading is what would let the
            // split below write the legacy key's chunks straight over the
            // records it failed to see.
            const keys = await storage.tryGetAllKeys(this.storeName);
            if (keys === null) {
                console.warn(`[${this.label}] Could not list existing chunks before the split; keeping the legacy key`);
                return { ok: false, entries: legacy };
            }
            const tombs = await this._readTombs(keys, charId);
            state.tombs = tombs.stones;
            state.tombsChanged = tombs.changed;
            const recordKeys = recordKeysFor(keys, this.prefix, charId);
            if (recordKeys.length > 0) {
                const buckets = await storage.getMany(recordKeys, this.storeName);
                const prefixLength = `${this.prefix}_${charId}_`.length;
                for (const key of recordKeys) {
                    const bucket = buckets.get(key);
                    // A key the listing named whose value did not come back is
                    // a failed read, not an absent chunk — see `_readRecords`
                    if (bucket === null) {
                        console.warn(`[${this.label}] Could not read ${key} before the split; keeping the legacy key`);
                        return { ok: false, entries: legacy };
                    }
                    if (Array.isArray(bucket)) existing.set(key.slice(prefixLength), bucket);
                }
            }
        } catch (error) {
            // Reading failed, so what is on disk is unknown — and merging into
            // the unknown would mean writing chunks that silently drop it
            console.error(`[${this.label}] Reading existing chunks before the split failed:`, error);
            return { ok: false, entries: legacy };
        }

        /** chunkId → the union of what is stored and what the legacy key held */
        const merged = new Map(existing);
        for (const [chunkId, bucket] of grouped) {
            const base = merged.get(chunkId);
            merged.set(chunkId, base ? this._union(base, bucket, state.tombs) : bucket);
        }

        // Only the chunks the legacy entries actually touch are rewritten;
        // the rest are already on disk exactly as they are in `merged`
        const records = {};
        for (const chunkId of grouped.keys()) records[this.keyFor(charId, chunkId)] = merged.get(chunkId);

        const wanted = Object.keys(records).length;
        const written = await storage.putAll(this.storeName, records);
        if (written !== wanted || storage.isQuotaExceeded()) {
            console.warn(
                `[${this.label}] Splitting the stored history stalled (${written}/${wanted} chunks) — ` +
                    'keeping the single key and reading from it'
            );
            return { ok: false, entries: legacy };
        }

        const removed = await storage.delete(this.legacyKey(charId), this.storeName);
        if (!removed) {
            // The legacy key outliving the split is the one state that loses
            // data: the next load would read it and overwrite everything
            // recorded since. Stay on it until it can actually be removed.
            //
            // The fold above is still on disk, and is harmless: the next load
            // reads this key again and folds it into records that now already
            // contain it, which the identity dedupe makes a no-op.
            console.warn(`[${this.label}] The legacy key could not be removed — continuing to use it`);
            return { ok: false, entries: this._flatten(merged) };
        }

        state.snapshot = new Map();
        for (const [chunkId, bucket] of merged) {
            state.snapshot.set(chunkId, { json: JSON.stringify(bucket), count: bucket.length });
        }
        return { ok: true, entries: this._flatten(merged) };
    }

    /**
     * @param {Map<string, Array<Object>>} chunks - chunkId → its entries
     * @returns {Array<Object>} Every entry, in chunk-id order
     * @private
     */
    _flatten(chunks) {
        const entries = [];
        for (const chunkId of [...chunks.keys()].sort()) entries.push(...chunks.get(chunkId));
        return entries;
    }

    /**
     * Read every record of one character back into one array.
     *
     * Named keys rather than `getAll()`: these stores hold other things too — a
     * year of item-level networth snapshots, another feature's keys — and a
     * whole-store read would pull all of it into memory to assemble a series of
     * timestamps and totals. But the named keys go out in one `getMany`
     * transaction rather than one transaction apiece; a character with a year of
     * hourly records was paying several hundred round trips to open a panel.
     *
     * @param {string} charId - Whose records
     * @param {{snapshot: Map<string, Object>, tombs: Object, tombsChanged: boolean}} state -
     *   The read being assembled: the per-chunk serialisations and this character's deletions
     * @returns {Promise<Array<Object>>} The assembled entries
     * @private
     */
    async _readRecords(charId, state) {
        const snapshot = state.snapshot;
        // `tryGetAllKeys`, not `getAllKeys`: the latter answers a listing it
        // could not make with an empty array, which here reads as "this
        // character has no history at all" — and the caller then appends one
        // entry and saves, writing that single entry over the bucket it never
        // saw. Null is the store saying it could not answer, and an unanswered
        // read is not an empty history.
        const keys = await storage.tryGetAllKeys(this.storeName);
        if (keys === null) return null;

        const tombs = await this._readTombs(keys, charId);
        state.tombs = tombs.stones;
        state.tombsChanged = tombs.changed;

        const recordKeys = recordKeysFor(keys, this.prefix, charId);
        if (recordKeys.length === 0) return [];

        const buckets = await storage.getMany(recordKeys, this.storeName);
        const entries = [];
        const prefixLength = `${this.prefix}_${charId}_`.length;

        // recordKeys order, not Map order, so the snapshot and the assembled
        // list are built in the same deterministic order as before
        for (const key of recordKeys) {
            const bucket = buckets.get(key);
            // `getMany` seeds every key with null and only overwrites the ones
            // it actually read, so a null here is a key the listing named and
            // the read did not deliver — the same untrustworthy answer as
            // above, one chunk deep. A non-array that is not null is a
            // genuinely corrupt bucket, and is skipped as it always was.
            if (bucket === null) return null;
            if (!Array.isArray(bucket)) continue;
            snapshot.set(key.slice(prefixLength), { json: JSON.stringify(bucket), count: bucket.length });
            entries.push(...bucket);
        }

        return this._sorted(entries);
    }

    /**
     * @param {Array<Object>} entries - Entries in any order
     * @returns {Map<string, Array<Object>>} chunkId → its entries, in input order
     * @private
     */
    _group(entries) {
        const grouped = new Map();
        for (const entry of entries || []) {
            if (entry == null) continue;
            const chunkId = this.groupOf(entry);
            if (chunkId === null || chunkId === undefined || chunkId === '') continue;
            const id = String(chunkId);
            const bucket = grouped.get(id);
            if (bucket) bucket.push(entry);
            else grouped.set(id, [entry]);
        }
        return grouped;
    }

    /**
     * @param {Array<Object>} entries - Entries in any order
     * @returns {Array<Object>} A new array in the comparator's order
     * @private
     */
    _sorted(entries) {
        return this.compare ? [...entries].sort(this.compare) : [...entries];
    }
}

/**
 * What makes two entries the same entry, when the caller has not said.
 *
 * The entry's own JSON — a deep-equality test, which is right for a history of
 * plain records and is the only identity a generic store can derive.
 * @param {Object} entry - A history entry
 * @returns {string|undefined} An identity, or undefined when there is none
 */
function defaultIdentity(entry) {
    try {
        return JSON.stringify(entry);
    } catch {
        return undefined;
    }
}

/**
 * Normalise a changed-chunk hint into a Set of string ids, or null for "no hint".
 * @param {string|number|Array|Set|null|undefined} hint - What the caller passed
 * @returns {Set<string>|null} The chunk ids to re-serialise, or null for all of them
 */
function normalizeChunkHint(hint) {
    if (hint === null || hint === undefined) return null;
    if (hint instanceof Set) return new Set([...hint].map(String));
    if (Array.isArray(hint)) return new Set(hint.map(String));
    return new Set([String(hint)]);
}

export default {
    createChunkedHistory,
    timeChunkId,
    idsFromRecordKeys,
    recordKeysFor,
    maxRecordsPerCharacter,
    registerCharacterScopedPrefix,
};
