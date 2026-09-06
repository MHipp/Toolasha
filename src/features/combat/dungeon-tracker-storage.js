/**
 * Dungeon Tracker Storage
 * Manages IndexedDB storage for dungeon run history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';

/**
 * Runs are stored once for the whole account, not once per character.
 *
 * A team run is the same run whichever of your characters was in the party, and
 * the duplicate check that collapses those two sightings into one entry only
 * works if they land in the same list. Partitioning the store per character
 * would turn one run into two.
 *
 * What the store lacked was any record of *who* recorded each run, so a panel
 * could not answer "how am I doing" without also counting the other character's
 * runs. New runs are stamped with the recording character; the panel filters on
 * that stamp. Runs written before the stamp existed fall back to looking for
 * the character's name in the team, which is right for every run they were
 * actually in and merely conservative for solo runs recorded under a name the
 * roster does not carry.
 */

/**
 * How long a deferred save waits for company before it reads, merges and writes.
 *
 * Short enough that a lone run is on disk almost at once, long enough that a
 * chat backfill — which appends dozens of runs in one synchronous sweep —
 * collapses into a single read-merge-write instead of one per run.
 */
export const PERSIST_COALESCE_MS = 250;

// Hardcoded max waves for each dungeon (fallback if maxCount is 0)
const DUNGEON_MAX_WAVES = {
    '/actions/combat/chimerical_den': 50,
    '/actions/combat/sinister_circus': 60,
    '/actions/combat/enchanted_fortress': 65,
    '/actions/combat/pirate_cove': 65,
};

/**
 * Whether a stored run belongs to the given character.
 *
 * Pure so the fallback is testable: the stamp decides when it is there, and
 * only a run without one is matched by name against the team.
 *
 * @param {Object} run - A stored run
 * @param {string|null} characterId - The character asking
 * @param {string|null} characterName - Their in-game name, for legacy runs
 * @returns {boolean}
 */
export function runMatchesCharacter(run, characterId, characterName) {
    if (!run) return false;

    if (run.recordedBy) {
        return characterId != null && String(run.recordedBy) === String(characterId);
    }

    // Legacy run: no stamp, so the roster is the only evidence there is
    if (!characterName) return false;
    if (Array.isArray(run.team) && run.team.includes(characterName)) return true;
    if (typeof run.teamKey === 'string' && run.teamKey.split(',').includes(characterName)) return true;
    return false;
}

/**
 * Narrow a run list to one character, or leave it whole.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {string} filterCharacter - 'mine' or 'all'
 * @param {{id: string|null, name: string|null}} character - Who is asking
 * @returns {Array<Object>} The runs to show
 */
export function filterRunsForCharacter(runs, filterCharacter, character) {
    const list = Array.isArray(runs) ? runs : [];
    if (filterCharacter !== 'mine') return list;
    return list.filter((run) => runMatchesCharacter(run, character?.id ?? null, character?.name ?? null));
}

/**
 * What tells two sightings of the same run apart.
 *
 * A run carries no id, so the team that ran it, when it started and how long it
 * took are its identity — the same triple the duplicate check has always used,
 * here matched exactly because both sides are copies of one written record
 * rather than two independent observations.
 * @param {Object} run - A stored run
 * @returns {string} `teamKey|timestamp|duration`
 */
export function runIdentity(run) {
    return `${run?.teamKey ?? ''}|${run?.timestamp ?? ''}|${run?.duration ?? ''}`;
}

/**
 * Fold the stored list into the in-memory one.
 *
 * `allRuns` is one key for the whole account, so two tabs — or two characters
 * in the same party — write the same key. Memory is a snapshot taken when the
 * tab loaded; writing it back whole erases everything the other tab recorded
 * since. Runs are matched on the triple that identifies them (team, timestamp,
 * duration), memory wins on a tie because it may have been amended in place
 * (a tier filled in), and anything this session deleted stays deleted rather
 * than being carried back in from a copy written before the delete.
 *
 * @param {Array<Object>} memory - The in-memory list, newest first
 * @param {Array<Object>} stored - What storage holds right now
 * @param {Set<string>} [deleted] - Identities removed in this session
 * @returns {Array<Object>} The union, newest first
 */
export function mergeRuns(memory, stored, deleted) {
    const merged = Array.isArray(memory) ? [...memory] : [];
    const seen = new Set(merged.map(runIdentity));
    for (const run of Array.isArray(stored) ? stored : []) {
        if (!run) continue;
        const id = runIdentity(run);
        if (seen.has(id) || deleted?.has(id)) continue;
        seen.add(id);
        merged.push(run);
    }
    const at = (run) => {
        const time = new Date(run?.timestamp).getTime();
        return Number.isFinite(time) ? time : 0;
    };
    // Newest first, as the list has always been; runs with no usable timestamp
    // all score 0 and so keep the order they came in
    merged.sort((a, b) => at(b) - at(a));
    return merged;
}

/**
 * The character the panel is currently speaking for.
 * @returns {{id: string|null, name: string|null}}
 */
export function currentCharacter() {
    return {
        id: dataManager.getCurrentCharacterId?.() ?? null,
        name: dataManager.getCurrentCharacterName?.() ?? null,
    };
}

class DungeonTrackerStorage {
    constructor() {
        this.unifiedStoreName = 'unifiedRuns'; // Unified storage for all runs

        /**
         * The stored list, newest first, once it has been read.
         *
         * Every run used to be saved by reading the whole list back from
         * IndexedDB, scanning it for a duplicate and writing it back, and every
         * panel refresh read it again; with a few hundred runs kept that was
         * most of the store's traffic. Memory is the truth between writes now:
         * every read and write goes through here, so the list is read once per
         * session and written only when it changes.
         */
        this._runs = null;
        /** The read in flight, so concurrent callers share one instead of each indexing its own copy */
        this._loading = null;
        /** teamKey → that team's runs (the same objects), for the duplicate check */
        this._byTeam = new Map();
        /**
         * Identities removed in this session, so a merge cannot resurrect them
         * from a copy of the list written before the delete landed.
         */
        this._deleted = new Set();
        /** One read-merge-write at a time; two interleaved would each miss the other */
        this._persistChain = null;
        /** A deferred merge-and-write is armed, to tell a burst from a lone run */
        this._pendingTimer = null;

        this._watchForTheEnd();
    }

    /**
     * Make the coalescing window survive the page going away.
     *
     * For the 250 ms a deferred save is armed, the run exists only in this
     * object: nothing has reached the store, so `storage.flushAll()` — which
     * the switch path and the store's own unload handling call — has nothing
     * of ours to drain. A tab closed, hidden or switched inside that window
     * lost the run outright. These handlers turn the armed save into an
     * immediate one first, which is the only point at which `flushAll` can
     * see it.
     *
     * `pagehide` is the reliable one on mobile Safari, `beforeunload`
     * elsewhere, and `visibilitychange` catches a tab that is backgrounded and
     * then discarded without either firing. All three run the same idempotent
     * flush, so firing two of them costs one no-op.
     * @private
     */
    _watchForTheEnd() {
        const flush = () => {
            this.flushPendingSave();
        };

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pagehide', flush);
            window.addEventListener('beforeunload', flush);
        }
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flush();
            });
        }

        // The switch tears the old character's features down; a run recorded in
        // the last quarter-second belongs to the character leaving, and this is
        // the last moment it can be written under them
        if (typeof dataManager?.on === 'function') dataManager.on('character_switching', flush);
    }

    /**
     * The stored list, read on first use and held afterwards.
     *
     * A read that could not be made is not an empty history: the list stays
     * unloaded, this call answers empty, and a save will not write over
     * whatever is stored until a read has succeeded.
     * @returns {Promise<Array<Object>|null>} The live list, or null when storage could not be read
     * @private
     */
    async _loadRuns() {
        if (this._runs) return this._runs;
        // Only the *result* used to be memoised, not the read itself. Several
        // consumers ask for the history as their panels come up, so on a cold
        // session two or more reads of the same key ran at once and each one
        // `_index`ed its own copy of the stored list on arrival — including the
        // ones that arrived after a caller had already changed memory. The
        // outlier scrub is the loser: it runs at chat-annotation init, drops
        // the outliers from memory and asks for a merging write, and a read
        // still in flight puts them straight back, where `mergeRuns` keeps
        // them — `_deleted` only filters the *stored* side.
        if (this._loading) return this._loading;

        let read;
        read = (async () => {
            try {
                const probe = await storage.tryGet('allRuns', this.unifiedStoreName);
                if (probe === null) {
                    console.warn('[DungeonTrackerStorage] Run history could not be read');
                    return null;
                }
                // A reset landing inside the read means this list is no longer
                // the one anyone asked for; indexing it would revive it
                if (this._loading !== read) return null;
                this._index(Array.isArray(probe.value) ? probe.value : []);
                return this._runs;
            } finally {
                if (this._loading === read) this._loading = null;
            }
        })();
        this._loading = read;
        return read;
    }

    /**
     * Take a list as the in-memory truth and rebuild the per-team index.
     * @param {Array<Object>} runs - Runs, newest first
     * @private
     */
    _index(runs) {
        this._runs = runs;
        this._byTeam = new Map();
        for (const run of runs) this._indexRun(run);
    }

    /**
     * @param {Object} run - A run now in the list
     * @private
     */
    _indexRun(run) {
        if (!run || typeof run.teamKey !== 'string') return;
        const list = this._byTeam.get(run.teamKey);
        if (list) list.push(run);
        else this._byTeam.set(run.teamKey, [run]);
    }

    /**
     * Write the in-memory list out, folding in whatever storage holds now.
     *
     * `allRuns` is a single account-wide key, so a second tab (or a second
     * character in the same party) writes it too. Taking memory for the whole
     * truth threw those runs away on the next save; the list is re-read and
     * merged first (see {@link mergeRuns}), which costs one read per save and
     * is the only thing that makes two tabs safe.
     *
     * A read that could not be made skips the write rather than overwriting
     * with a copy that may be missing runs — the same rule the load follows.
     * The merge is what costs: one `tryGet` plus a full sort of the history per
     * call. A chat backfill appends runs one at a time and asked for a save
     * after each, so N recovered runs paid for N reads and N sorts of a list
     * that was growing as it went. A deferred save is *coalesced* instead —
     * the first one arms a short timer and every save asked for while it is
     * armed does nothing, so the burst produces one read-merge-write with all
     * of the runs already in memory. An immediate save (a delete, a scrub)
     * still runs at once, and takes the armed one with it.
     *
     * @param {boolean} immediate - Skip the coalescing window and the write debounce
     * @returns {Promise<boolean>} Whether the write was issued — a deferred save
     *   answers true as soon as it is armed, since awaiting the timer would
     *   stall an append loop by the coalescing window on every run
     * @private
     */
    async _persist(immediate) {
        if (!immediate) {
            if (this._pendingTimer === null) {
                this._pendingTimer = setTimeout(() => {
                    this._pendingTimer = null;
                    this._persistNow(false);
                }, PERSIST_COALESCE_MS);
            }
            return true;
        }

        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        return this._persistNow(true);
    }

    /**
     * Read the stored list, merge memory into it and write it back, now.
     * @param {boolean} immediate - Passed through to the store's write debounce
     * @returns {Promise<boolean>} Whether the write was issued
     * @private
     */
    _persistNow(immediate) {
        const run = async () => {
            const probe = await storage.tryGet('allRuns', this.unifiedStoreName);
            if (probe === null) {
                console.warn('[DungeonTrackerStorage] Runs not saved: the stored history could not be read first');
                return false;
            }
            const merged = mergeRuns(this._runs || [], Array.isArray(probe.value) ? probe.value : [], this._deleted);
            this._index(merged);
            const write = storage.setJSON('allRuns', merged, this.unifiedStoreName, immediate);
            // A debounced write resolves when its timer fires; awaiting it
            // would stall a backfill loop for the debounce delay on every run
            return immediate ? write : true;
        };
        this._persistChain = (this._persistChain || Promise.resolve()).then(run, run);
        return this._persistChain;
    }

    /**
     * Write the in-memory list out as the whole truth, without merging.
     *
     * Only "forget everything" wants this: a clear that merged would read back
     * the very runs it was asked to drop.
     * @returns {Promise<boolean>} Whether the write landed
     * @private
     */
    async _persistReplace() {
        const run = () => storage.setJSON('allRuns', this._runs, this.unifiedStoreName, true);
        this._persistChain = (this._persistChain || Promise.resolve()).then(run, run);
        return this._persistChain;
    }

    /**
     * Test-only: forget the in-memory list, so the next call reads storage again.
     * @returns {void}
     */
    _resetCache() {
        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        this._runs = null;
        this._loading = null;
        this._byTeam = new Map();
        this._deleted = new Set();
        this._persistChain = null;
    }

    /**
     * Run an armed deferred save now, if there is one.
     *
     * For a caller that has to know the history is on its way out — and for a
     * test that would otherwise have to advance a timer.
     * @returns {Promise<boolean>} Whether a write was issued
     */
    async flushPendingSave() {
        if (this._pendingTimer === null) return this._persistChain ? this._persistChain : false;
        return this._persist(true);
    }

    /**
     * Get dungeon+tier key
     * @param {string} dungeonHrid - Dungeon action HRID
     * @param {number} tier - Difficulty tier (0-2)
     * @returns {string} Storage key
     */
    getDungeonKey(dungeonHrid, tier) {
        return `${dungeonHrid}::T${tier}`;
    }

    /**
     * Get dungeon info from game data
     * @param {string} dungeonHrid - Dungeon action HRID
     * @returns {Object|null} Dungeon info or null
     */
    getDungeonInfo(dungeonHrid) {
        const actionDetails = dataManager.getActionDetails(dungeonHrid);
        if (!actionDetails) {
            return null;
        }

        // Extract name from HRID (e.g., "/actions/combat/chimerical_den" -> "Chimerical Den")
        const namePart = dungeonHrid.split('/').pop();
        const name = namePart
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        // Get max waves from nested combatZoneInfo.dungeonInfo.maxWaves
        let maxWaves = actionDetails.combatZoneInfo?.dungeonInfo?.maxWaves || 0;

        // Fallback to hardcoded values if not found in game data
        if (maxWaves === 0 && DUNGEON_MAX_WAVES[dungeonHrid]) {
            maxWaves = DUNGEON_MAX_WAVES[dungeonHrid];
        }

        return {
            name: actionDetails.name || name,
            maxWaves: maxWaves,
        };
    }

    /**
     * Get statistics for a dungeon by name (for chat-based runs)
     * @param {string} dungeonName - Dungeon display name
     * @returns {Promise<Object>} Statistics
     */
    async getStatsByName(dungeonName) {
        const allRuns = await this.getAllRuns();
        const runs = allRuns.filter((r) => r.dungeonName === dungeonName);

        if (runs.length === 0) {
            return {
                totalRuns: 0,
                avgTime: 0,
                fastestTime: 0,
                slowestTime: 0,
                avgWaveTime: 0,
            };
        }

        // Use 'duration' field (chat-based) or 'totalTime' field (websocket-based)
        const durations = runs.map((r) => r.duration || r.totalTime || 0);
        const totalTime = durations.reduce((sum, d) => sum + d, 0);
        const avgTime = totalTime / runs.length;
        const fastestTime = Math.min(...durations);
        const slowestTime = Math.max(...durations);

        const avgWaveTime = runs.reduce((sum, run) => sum + (run.avgWaveTime || 0), 0) / runs.length;

        return {
            totalRuns: runs.length,
            avgTime,
            fastestTime,
            slowestTime,
            avgWaveTime,
        };
    }

    /**
     * Get team key from sorted player names
     * @param {Array<string>} playerNames - Array of player names
     * @returns {string} Team key (sorted, comma-separated)
     */
    getTeamKey(playerNames) {
        return playerNames.sort().join(',');
    }

    /**
     * Save a team-based run (from backfill)
     * @param {string} teamKey - Team key (sorted player names)
     * @param {Object} run - Run data
     * @param {string} run.timestamp - Run start timestamp (ISO string)
     * @param {number} run.duration - Run duration (ms)
     * @param {string} run.dungeonName - Dungeon name (from Phase 2)
     * @param {string|null} [run.dungeonHrid] - Dungeon action, where the recording route knew it
     * @param {number|null} [run.tier] - Difficulty tier, where the recording route knew it
     * @param {boolean} [run.validated] - False for a run timed by the client's own clock
     *   (a solo run, which has no party "Key counts" messages to time it by). Defaults
     *   to true, which is what every party and backfill run has always been.
     * @param {boolean} [run.startRecovered] - True when the run's start was recovered from the
     *   chat log rather than watched; such a run may not set the recovery plausibility bound
     * @param {string} [run.source] - Where the run came from: 'chat' (default) or 'tracker'
     * @returns {Promise<boolean>} Success status
     */
    async saveTeamRun(teamKey, run) {
        // Who saw this run — read before the load, not after it. The load is a
        // real IndexedDB round trip on the first save of a session, and the
        // caller reaches here after awaits of its own, so a character switch
        // landing in between stamped this character's run with the arriving
        // character's name. `runMatchesCharacter` trusts the stamp absolutely,
        // so the run then disappears from the character who actually ran it and
        // shows up under one who was never in it — permanently, and skewing
        // every per-character average built off that view.
        const recorder = currentCharacter();
        const allRuns = await this._loadRuns();
        if (!allRuns) {
            console.warn('[DungeonTrackerStorage] Run not saved: the stored history could not be read first');
            return false;
        }

        // Parse incoming timestamp
        const newTimestamp = new Date(run.timestamp).getTime();

        // Check for duplicates (same time window, team, and duration). Only
        // this team's runs can match, so only they are looked at.
        const existing = (this._byTeam.get(teamKey) || []).find((r) => {
            const existingTimestamp = new Date(r.timestamp).getTime();
            const timeDiff = Math.abs(existingTimestamp - newTimestamp);
            const durationDiff = Math.abs(r.duration - run.duration);

            // Consider duplicate if:
            // - Within 10 seconds of each other (handles timestamp precision differences)
            // - Same team
            // - Duration within 2 seconds (handles minor timing differences)
            return timeDiff < 10000 && durationDiff < 2000;
        });
        const isDuplicate = Boolean(existing);

        // A chat backfill never sees a tier or a wave; the live tracker does.
        // When the two routes record the same run, the one that knew fills it
        // in — and a later chat sighting must never erase what the tracker kept
        if (existing) {
            let filled = false;
            if (existing.tier == null && Number.isInteger(run.tier)) {
                existing.tier = run.tier;
                filled = true;
            }
            if (!existing.dungeonHrid && run.dungeonHrid) {
                existing.dungeonHrid = run.dungeonHrid;
                filled = true;
            }
            if (!existing.waveTimes && Array.isArray(run.waveTimes) && run.waveTimes.length > 0) {
                existing.waveTimes = [...run.waveTimes];
                existing.avgWaveTime = Number.isFinite(run.avgWaveTime) ? run.avgWaveTime : null;
                filled = true;
            }
            if (filled) await this._persist(false);
        }

        if (!isDuplicate) {
            // Create unified format run
            const team = teamKey.split(',').sort();
            const unifiedRun = {
                recordedBy: recorder.id,
                recordedByName: recorder.name,
                timestamp: run.timestamp,
                dungeonName: run.dungeonName || 'Unknown',
                dungeonHrid: run.dungeonHrid || null,
                tier: Number.isInteger(run.tier) ? run.tier : null,
                team: team,
                teamKey: teamKey,
                duration: run.duration,
                // A solo run is timed by the wall clock, not the server's own
                // timestamps, and says so — see the tracker's solo save path
                validated: run.validated !== false,
                // A run whose start came back from the chat log rather than being
                // watched. Its duration is only as good as the bound that admitted
                // the anchor, so it may not set that bound for the next recovery
                startRecovered: run.startRecovered === true,
                source: run.source || 'chat',
                waveTimes: Array.isArray(run.waveTimes) && run.waveTimes.length > 0 ? [...run.waveTimes] : null,
                avgWaveTime: Number.isFinite(run.avgWaveTime) ? run.avgWaveTime : null,
                keyCountsMap: run.keyCountsMap || null, // Include key counts if available
            };

            // Add to front of list (most recent first)
            allRuns.unshift(unifiedRun);
            this._indexRun(unifiedRun);
            // A run recorded again after being deleted is wanted again
            this._deleted.delete(runIdentity(unifiedRun));

            // Memory is authoritative and every reader goes through it, so the
            // write takes the normal debounce — a backfill of dozens of runs
            // lands as one write
            await this._persist(false);

            return true;
        }

        return false;
    }

    /**
     * Get all runs (unfiltered)
     * @returns {Promise<Array>} All runs
     */
    async getAllRuns() {
        const runs = await this._loadRuns();
        // A copy: the list held here is what the next save appends to, and a
        // caller that sorted or spliced the live one would reorder the store
        return runs ? [...runs] : [];
    }

    /**
     * Remove the run(s) recorded at a timestamp.
     * @param {string} timestamp - The run's ISO timestamp, as stored
     * @returns {Promise<boolean>} Whether the write landed
     */
    async deleteRun(timestamp) {
        const allRuns = await this._loadRuns();
        if (!allRuns) return false;
        const kept = [];
        for (const run of allRuns) {
            if (run.timestamp === timestamp) this._deleted.add(runIdentity(run));
            else kept.push(run);
        }
        this._index(kept);
        return this._persist(true);
    }

    /**
     * Forget every stored run.
     * @returns {Promise<boolean>} Whether the write landed
     */
    async clearAllRuns() {
        // An armed deferred save would read the stored list back and merge the
        // very runs this was asked to forget
        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
        }
        this._index([]);
        this._deleted = new Set();
        return this._persistReplace();
    }

    /**
     * Every run, or only the ones this character recorded.
     *
     * @param {string} [filterCharacter] - 'mine' (default) or 'all'
     * @returns {Promise<Array>} Runs
     */
    async getRunsForCharacter(filterCharacter = 'mine') {
        return filterRunsForCharacter(await this.getAllRuns(), filterCharacter, currentCharacter());
    }

    /**
     * Remove runs whose duration is more than 3× the median for their dungeon+team group.
     * Only scrubs groups with at least 5 runs (not enough data below that to be confident).
     * @returns {Promise<number>} Number of runs removed
     */
    async scrubOutlierRuns() {
        const allRuns = await this.getAllRuns();
        if (allRuns.length === 0) return 0;

        // Group by dungeonName + teamKey
        const groups = new Map();
        for (let i = 0; i < allRuns.length; i++) {
            const run = allRuns[i];
            const key = `${run.dungeonName}||${run.teamKey}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ run, index: i });
        }

        const outlierIndices = new Set();

        for (const [groupKey, entries] of groups) {
            if (entries.length < 5) continue;

            const durations = entries
                .map((e) => e.run.duration || e.run.totalTime || 0)
                .filter((d) => d > 0)
                .sort((a, b) => a - b);

            if (durations.length < 5) continue;

            const mid = Math.floor(durations.length / 2);
            const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

            const threshold = median * 3;

            for (const { run, index } of entries) {
                const duration = run.duration || run.totalTime || 0;
                if (duration > threshold) {
                    outlierIndices.add(index);
                    console.warn(
                        `[DungeonTrackerStorage] Scrubbing outlier run: ${groupKey} ` +
                            `duration=${Math.round(duration)}s median=${Math.round(median)}s threshold=${Math.round(threshold)}s`
                    );
                }
            }
        }

        if (outlierIndices.size === 0) return 0;

        const cleaned = [];
        for (let i = 0; i < allRuns.length; i++) {
            if (outlierIndices.has(i)) this._deleted.add(runIdentity(allRuns[i]));
            else cleaned.push(allRuns[i]);
        }
        this._index(cleaned);
        await this._persist(true);
        console.log(`[DungeonTrackerStorage] Scrubbed ${outlierIndices.size} outlier run(s) from storage`);
        return outlierIndices.size;
    }

    /**
     * Get runs filtered by dungeon and/or team
     * @param {Object} filters - Filter options
     * @param {string} filters.dungeonName - Filter by dungeon name (optional)
     * @param {string} filters.teamKey - Filter by team key (optional)
     * @returns {Promise<Array>} Filtered runs
     */
    async getFilteredRuns(filters = {}) {
        const allRuns = await this.getAllRuns();

        let filtered = allRuns;

        if (filters.dungeonName && filters.dungeonName !== 'all') {
            filtered = filtered.filter((r) => r.dungeonName === filters.dungeonName);
        }

        if (filters.teamKey && filters.teamKey !== 'all') {
            filtered = filtered.filter((r) => r.teamKey === filters.teamKey);
        }

        return filtered;
    }

    /**
     * Get all teams with stored runs
     * @returns {Promise<Array>} Array of {teamKey, runCount, avgTime, bestTime, worstTime}
     */
    async getAllTeamStats() {
        const allRuns = await this.getAllRuns();

        // Group by teamKey
        const teamGroups = {};
        for (const run of allRuns) {
            if (!run.teamKey) continue; // Skip solo runs (no team)

            if (!teamGroups[run.teamKey]) {
                teamGroups[run.teamKey] = [];
            }
            teamGroups[run.teamKey].push(run);
        }

        // Calculate stats for each team
        const results = [];
        for (const [teamKey, runs] of Object.entries(teamGroups)) {
            const durations = runs.map((r) => r.duration);
            const avgTime = durations.reduce((a, b) => a + b, 0) / durations.length;
            const bestTime = Math.min(...durations);
            const worstTime = Math.max(...durations);

            results.push({
                teamKey,
                runCount: runs.length,
                avgTime,
                bestTime,
                worstTime,
            });
        }

        return results;
    }
}

const dungeonTrackerStorage = new DungeonTrackerStorage();

export default dungeonTrackerStorage;
