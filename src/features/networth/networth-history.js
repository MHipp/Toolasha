/**
 * Networth History Tracker
 * Records hourly snapshots of networth breakdown to IndexedDB.
 * Used by the networth history chart for trend visualization.
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import connectionState from '../../core/connection-state.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createChunkedHistory, registerCharacterScopedPrefix, timeChunkId } from '../../utils/chunked-history.js';

const STORE_NAME = 'networthHistory';
const SNAPSHOT_INTERVAL = 60 * 60 * 1000; // 1 hour
const MAX_DETAIL_SNAPSHOTS = 25; // ~24h of hourly snapshots + 1 buffer

/**
 * The stem of the item-level detail snapshot keys, `networthDetail_<id>_<t>`.
 *
 * Registered as character-scoped because `networthHistory`'s budget is sized
 * per character and counts these twenty-five beside the series chunks (see
 * `STORE_KEY_BUDGETS` in `core/storage.js`). They are not a `ChunkedHistory`,
 * so nothing else tells the budget check they belong to a character — and the
 * rolling window drops them with fire-and-forget deletes, so a delete that
 * never lands is precisely the growth the budget exists to notice.
 */
const DETAIL_PREFIX = 'networthDetail';
registerCharacterScopedPrefix(STORE_NAME, DETAIL_PREFIX);

/** Beyond this age, the history is thinned rather than kept point for point */
const RETENTION_FULL_MS = 365 * 24 * 60 * 60 * 1000;

/** One point per day is all a year-old trend can usefully say */
const TAIL_BUCKET_MS = 24 * 60 * 60 * 1000;

/** A hard ceiling under the thinning, so nothing can grow without bound */
const MAX_HISTORY_POINTS = 12000;

/** Gap threshold for chart line breaks (2 hours) */
export const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * The compact series, one record per calendar month.
 *
 * The whole series — up to `MAX_HISTORY_POINTS` of them — used to be rewritten
 * every hour to append one point, and a year of history is most of a megabyte.
 * A month's record holds the points recorded since the month began, so the
 * hourly write is that month and nothing else; every earlier month is settled
 * and never touched again.
 *
 * A month rather than something finer because the points are small and there are
 * a lot of them: the key count has to stay inside `STORE_KEY_BUDGETS`, which
 * this store already spends on twenty-five item-level detail snapshots.
 *
 * The prefix deliberately does not begin `networth_`, which the account view
 * scans for character ids (`account-data.js`) and `character-key.js` matches
 * against `^networth_[0-9a-zA-Z]+$` when deciding who adopts legacy data. A
 * chunked key under that prefix would read as a character called
 * `<id>_2026-08`.
 */
const SERIES_PREFIX = 'networthSeries';

/**
 * Which chunk a series point belongs to. Named so an appending caller can hand the
 * store the same id without reaching into it.
 * @param {Object} point - A history point
 * @returns {string} Chunk id
 */
const pointChunkId = (point) => timeChunkId(point?.t, 'month');

const seriesStore = createChunkedHistory({
    storeName: STORE_NAME,
    prefix: SERIES_PREFIX,
    legacyKey: (charId) => `networth_${charId}`,
    groupOf: pointChunkId,
    compare: (a, b) => (a?.t || 0) - (b?.t || 0),
    label: 'NetworthHistory',
});

export { SERIES_PREFIX, seriesStore };

/**
 * Keep the recent year whole and the rest as a daily outline.
 *
 * The alternative retentions are both wrong: dropping everything past a cutoff
 * loses the only record of what the account looked like a year ago, and keeping
 * every hourly point forever means an ever-growing array rewritten on every
 * snapshot. A day is the finest resolution anyone reads a year-old trend at.
 *
 * @param {Array<Object>} history - Snapshots, oldest first
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Array<Object>} Retained snapshots, oldest first
 */
export function pruneHistory(history, now = Date.now()) {
    if (!Array.isArray(history) || history.length === 0) return [];

    const cutoff = now - RETENTION_FULL_MS;
    const tail = [];
    const recent = [];
    let lastBucket = null;

    for (const point of history) {
        if (!point || typeof point.t !== 'number') continue;
        if (point.t >= cutoff) {
            recent.push(point);
            continue;
        }
        const bucket = Math.floor(point.t / TAIL_BUCKET_MS);
        if (bucket !== lastBucket) {
            tail.push(point);
            lastBucket = bucket;
        }
    }

    const pruned = tail.concat(recent);
    return pruned.length > MAX_HISTORY_POINTS ? pruned.slice(pruned.length - MAX_HISTORY_POINTS) : pruned;
}

class NetworthHistory {
    constructor() {
        this.history = [];
        this.detailHistory = [];
        this.characterId = null;
        this.timerRegistry = createTimerRegistry();
        this.networthFeature = null;
        /**
         * Bumped whenever the character changes. `initialize()` crosses several
         * awaits — a chunked-history load, the detail snapshots' IndexedDB round
         * trips, the first hourly snapshot — and a character switch that lands
         * mid-flight must not let that stale continuation resume: without this,
         * it would overwrite `this.history` with the departing character's rows
         * and then save them under whichever character is current by the time it
         * wakes up, which can be someone else entirely.
         */
        this._generation = 0;
    }

    /**
     * @param {number} t - Snapshot timestamp
     * @returns {string} The key that one detail snapshot lives under
     */
    _detailKey(t) {
        return `${DETAIL_PREFIX}_${this.characterId}_${t}`;
    }

    /** @returns {string} The pre-split key that held the whole detail array */
    _legacyDetailKey() {
        return `${DETAIL_PREFIX}_${this.characterId}`;
    }

    /**
     * Initialize the history tracker
     * @param {Object} networthFeature - Reference to NetworthFeature instance (for currentData)
     */
    async initialize(networthFeature) {
        this.networthFeature = networthFeature;
        this.characterId = dataManager.getCurrentCharacterId();

        if (!this.characterId) {
            console.warn('[NetworthHistory] No character ID available');
            return;
        }

        const generation = this._generation;

        // Load existing history from storage, thinning anything past retention.
        // Done on load rather than only on write so a history that grew under an
        // older build is brought back inside budget without waiting an hour.
        // Thinning drops points out of the oldest months entirely, and the save
        // that follows deletes those months' records.
        const loaded = await seriesStore.load(this.characterId);
        // A switch landed while the read was in flight: these rows are the
        // departing character's, and `disable()` has already reset the fields
        // this would otherwise refill under whoever is current now
        if (this._generation !== generation) return;
        this.history = pruneHistory(loaded);
        if (this.history.length !== loaded.length) {
            seriesStore.save(this.characterId, this.history);
        }

        // Load existing detail history from storage. The character is passed in
        // rather than read off `this`: the load writes as well as reads (it
        // migrates the legacy key and trims an overgrown window), and those
        // writes happen after awaits that a character switch can land inside.
        const detailHistory = await this._loadDetailHistory(generation, this.characterId);
        if (this._generation !== generation) return;
        this.detailHistory = detailHistory;

        // Take an immediate first snapshot
        await this.takeSnapshot();
        if (this._generation !== generation) return;

        // Start hourly interval
        const intervalId = setInterval(() => this.takeSnapshot(), SNAPSHOT_INTERVAL);
        this.timerRegistry.registerInterval(intervalId);
    }

    /**
     * The detail snapshots, one key each, migrating anything left in the old
     * single-array key.
     *
     * The array was rewritten whole on every hourly snapshot — twenty-five
     * item-level maps of an entire inventory, to append one of them. Per-snapshot
     * keys make the hourly write the one snapshot that is new.
     *
     * Every key is built from the `characterId` handed in, not from `this`, and
     * every write is gated on the generation this load started in. Both awaits
     * below are wide enough for a character switch to land inside, and reading
     * `this.characterId` after one meant the departing character's snapshots
     * were written under the *arriving* character's keys — and the arriving
     * character's own legacy record deleted before it was ever migrated.
     *
     * @param {number} generation - The `_generation` this load belongs to
     * @param {string} characterId - Who these snapshots belong to
     * @returns {Promise<Array<{t: number, items: Object}>>} Snapshots, oldest first
     * @private
     */
    async _loadDetailHistory(generation, characterId) {
        const legacyKey = `networthDetail_${characterId}`;
        const detailKey = (t) => `${legacyKey}_${t}`;
        const legacy = await storage.get(legacyKey, STORE_NAME, null);
        if (this._generation !== generation) return [];

        if (Array.isArray(legacy) && legacy.length > 0) {
            const kept = legacy.slice(-MAX_DETAIL_SNAPSHOTS);
            const entries = {};
            for (const snapshot of kept) {
                if (typeof snapshot?.t === 'number') entries[detailKey(snapshot.t)] = snapshot;
            }
            await storage.putAll(STORE_NAME, entries);
            await storage.delete(legacyKey, STORE_NAME);
            return kept;
        }

        // Already split: gather this character's snapshot keys back into order
        const prefix = `${legacyKey}_`;
        const keys = (await storage.getAllKeys(STORE_NAME)).filter(
            (key) => typeof key === 'string' && key.startsWith(prefix)
        );

        // One transaction for the lot rather than a round trip per snapshot:
        // this is up to MAX_DETAIL_SNAPSHOTS item-level records and it runs on
        // the path that opens the networth panel.
        const records = await storage.getMany(keys, STORE_NAME);
        if (this._generation !== generation) return [];
        const snapshots = [];
        for (const key of keys) {
            const snapshot = records.get(key);
            if (snapshot && typeof snapshot.t === 'number') snapshots.push(snapshot);
        }
        snapshots.sort((a, b) => a.t - b.t);

        // A window that grew past its cap (an interrupted trim, an older build)
        // is brought back to size here rather than left to accumulate
        const overflow = snapshots.length - MAX_DETAIL_SNAPSHOTS;
        if (overflow > 0) {
            const dropped = snapshots.splice(0, overflow);
            await Promise.all(dropped.map((entry) => storage.delete(detailKey(entry.t), STORE_NAME)));
        }

        return snapshots;
    }

    /**
     * Take a snapshot of the current networth data
     */
    async takeSnapshot() {
        if (!connectionState.isConnected()) return;
        if (!this.networthFeature?.currentData) return;
        if (!this.characterId) return;
        // Nothing below can be stored, and an item-level snapshot of a whole
        // inventory is not cheap to build for a write that will be refused
        if (storage.isQuotaExceeded()) return;

        const data = this.networthFeature.currentData;

        const snapshot = {
            t: Date.now(),
            total: Math.round(data.totalNetworth + (data.excluded?.total ?? 0)),
            nonExcluded: Math.round(data.totalNetworth),
            gold: Math.round(data.coins),
            inventory: Math.round(data.currentAssets.inventory.value),
            equipment: Math.round(data.currentAssets.equipped.value),
            listings: Math.round(data.currentAssets.listings.value),
            house: Math.round(data.fixedAssets.houses.totalCost),
            abilities: Math.round(data.fixedAssets.abilities.totalCost + data.fixedAssets.abilityBooks.totalCost),
        };

        // Written only when the calculator actually costed the shrines. A zero
        // would be a claim — "this account has no shrines" — and the snapshots
        // taken before the calculator knew about shrines cannot make it. The
        // chart draws a missing field as a gap, which is the honest reading.
        const shrineCost = data.fixedAssets.guildShrines?.totalCost;
        if (Number.isFinite(shrineCost)) {
            snapshot.guildShrines = Math.round(shrineCost);
        }

        this.pushSnapshot(snapshot);
        this.history = pruneHistory(this.history);

        // Take item-level detail snapshot for 24h breakdown, which persists
        // itself — only the new snapshot is written, not the whole window
        this.takeDetailSnapshot(data);

        // Persist — queued, not awaited. The debounced set's promise resolves
        // only when its 3-second timer fires, so awaiting two in series was six
        // seconds of waiting for timers that exist to postpone the write. This
        // runs hourly and at startup; nothing downstream needs the write landed.
        // Only the current month's record is written; the rest have not moved.
        // Compaction and thinning can still take points out of an older month —
        // the store's per-chunk entry count catches that despite the hint.
        seriesStore.save(this.characterId, this.history, { changedChunks: pointChunkId(snapshot) });
    }

    /**
     * Append a snapshot and compact consecutive identical totals.
     * If 3+ consecutive entries share the same total, keep only the first and last.
     * @param {Object} snapshot - Snapshot object with t, total, and breakdown fields
     */
    pushSnapshot(snapshot) {
        this.history.push(snapshot);

        if (this.history.length < 3) return;

        // Count consecutive same-total entries from the end
        const currentTotal = snapshot.total;
        let runStart = this.history.length - 1;
        while (runStart > 0 && this.history[runStart - 1].total === currentTotal) {
            runStart--;
        }

        const runLength = this.history.length - runStart;
        // If run is 3+, remove all middle entries (keep first and last of run)
        if (runLength >= 3) {
            this.history.splice(runStart + 1, runLength - 2);
        }
    }

    /**
     * Take an item-level detail snapshot for 24h breakdown diffs.
     * Stores inventory + equipped items keyed by "itemHrid:enhancementLevel".
     * Rolling window of MAX_DETAIL_SNAPSHOTS entries.
     * @param {Object} data - Current networthData from calculateNetworth()
     */
    takeDetailSnapshot(data) {
        const items = {};

        // Gold
        items['/items/coin:0'] = { count: Math.round(data.coins), value: Math.round(data.coins) };

        // Inventory items
        for (const item of data.currentAssets.inventory.breakdown) {
            if (!item.itemHrid) continue;
            const key = `${item.itemHrid}:${item.enhancementLevel || 0}`;
            items[key] = { count: item.count || 0, value: Math.round(item.value || 0) };
        }

        // Equipped items
        for (const item of data.currentAssets.equipped.breakdown) {
            if (!item.itemHrid) continue;
            const key = `${item.itemHrid}:${item.enhancementLevel || 0}`;
            items[key] = { count: 1, value: Math.round(item.value || 0) };
        }

        // Houses (fixed assets)
        for (const room of data.fixedAssets.houses.breakdown) {
            items[`house:${room.hrid}`] = { count: room.level, value: Math.round(room.cost) };
        }

        // Abilities (fixed assets)
        for (const ability of data.fixedAssets.abilities.breakdown) {
            items[`ability:${ability.hrid}`] = { count: 1, value: Math.round(ability.cost) };
        }

        // Ability books (fixed assets)
        for (const book of data.fixedAssets.abilityBooks.breakdown) {
            if (!book.itemHrid) continue;
            items[`abilitybook:${book.itemHrid}`] = { count: book.count || 1, value: Math.round(book.value || 0) };
        }

        // Market listings
        for (const listing of data.currentAssets.listings.breakdown) {
            if (!listing.itemHrid) continue;
            const dir = listing.isSell ? 'sell' : 'buy';
            const key = `listing:${dir}:${listing.itemHrid}:${listing.enhancementLevel || 0}`;
            if (items[key]) {
                items[key].value += Math.round(listing.value);
                items[key].count += 1;
            } else {
                items[key] = { count: 1, value: Math.round(listing.value) };
            }
        }

        const snapshot = { t: Date.now(), items };
        this.detailHistory.push(snapshot);

        // Trim to rolling window, taking the dropped snapshots' keys with it
        if (this.detailHistory.length > MAX_DETAIL_SNAPSHOTS) {
            const dropped = this.detailHistory.splice(0, this.detailHistory.length - MAX_DETAIL_SNAPSHOTS);
            for (const old of dropped) {
                storage.delete(this._detailKey(old.t), STORE_NAME);
            }
        }

        storage.set(this._detailKey(snapshot.t), snapshot, STORE_NAME);
    }

    /**
     * Get the detail snapshot closest to the target timestamp.
     * Used to find the ~24h ago snapshot for diffing.
     * @param {number} targetTs - Target timestamp to find closest snapshot to
     * @returns {Object|null} Detail snapshot { t, items } or null if none available
     */
    getDetailSnapshot(targetTs) {
        if (this.detailHistory.length === 0) return null;

        let closest = this.detailHistory[0];
        let closestDiff = Math.abs(closest.t - targetTs);

        for (let i = 1; i < this.detailHistory.length; i++) {
            const diff = Math.abs(this.detailHistory[i].t - targetTs);
            if (diff < closestDiff) {
                closest = this.detailHistory[i];
                closestDiff = diff;
            }
        }

        return closest;
    }

    /**
     * Get the full history array
     * @returns {Array} Array of snapshot objects
     */
    getHistory() {
        return this.history;
    }

    /**
     * The whole rolling window of item-level detail snapshots, oldest first.
     *
     * Read-only — a copy, not the live array — because the only caller outside
     * this class wants to difference the two ends of the window and has no
     * business holding the array this class trims in place. About a day of
     * hourly snapshots, or fewer when the tab has not been open that long.
     *
     * @returns {Array<{t: number, items: Object}>} Snapshots, oldest first
     */
    detailWindow() {
        return [...this.detailHistory].sort((a, b) => a.t - b.t);
    }

    /**
     * The recent slice of the history, for a trend rather than the whole record.
     *
     * A read rather than exposing `history` itself: a caller outside this
     * module wants the last `hours` of points, not this class's storage shape,
     * and reaching into `.history` directly would tie it to both. `history` is
     * only ever the current character's — it is loaded fresh in `initialize`
     * keyed by `characterId` and cleared in `disable` — so a character switch
     * cannot leave a discontinuity in the middle of what this returns.
     *
     * @param {number} hours - How far back to look
     * @returns {Array<Object>} Snapshots within the window, oldest first
     */
    recentSeries(hours) {
        if (!(hours > 0)) return [];
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        return this.history.filter((point) => point.t >= cutoff);
    }

    /**
     * Delete a snapshot by timestamp and persist the change to storage.
     * @param {number} timestamp - The `t` value of the snapshot to remove
     */
    async deleteSnapshot(timestamp) {
        const idx = this.history.findIndex((s) => s.t === timestamp);
        if (idx === -1) return;
        this.history.splice(idx, 1);
        await seriesStore.save(this.characterId, this.history);
    }

    /**
     * Cleanup when disabled
     */
    disable() {
        this.timerRegistry.clearAll();
        // Anything still resuming from an old `initialize()` — a load, a detail
        // read, a first snapshot — belongs to the character being left and must
        // not touch what follows
        this._generation += 1;
        // The records in memory belong to the character being left; serving them
        // to the next one would be wrong, and writing them back under its keys
        // would be worse
        seriesStore.forget();
        this.history = [];
        this.detailHistory = [];
        this.characterId = null;
        this.networthFeature = null;
    }
}

const networthHistory = new NetworthHistory();

export default networthHistory;
