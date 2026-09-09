/**
 * Labyrinth Tracker
 * Detects cleared combat rooms via WebSocket events and records per-monster best recommendedLevel
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { createPersistedRecord } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY_PREFIX = 'monsterBestLevels';
const STORE_NAME = 'labyrinth';

/**
 * Fold the stored best levels under the ones in memory: per monster the
 * higher level wins, because a best-ever only goes up. So a tab that read
 * nothing cannot write a lower level over a stored higher one, and two tabs
 * each keep the other's bests.
 * @param {Object} stored - Stored map, monster → { name, bestLevel }
 * @param {Object} memory - In-memory map
 * @returns {Object}
 */
export function mergeBestLevels(stored, memory) {
    const out = { ...(stored && typeof stored === 'object' ? stored : {}) };
    for (const [hrid, entry] of Object.entries(memory && typeof memory === 'object' ? memory : {})) {
        const held = out[hrid];
        if (!held || !(Number(held.bestLevel) > Number(entry?.bestLevel))) out[hrid] = entry;
    }
    return out;
}

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE_NAME,
    base: STORAGE_KEY_PREFIX,
    merge: mergeBestLevels,
    label: 'Labyrinth best levels',
});

const COMBAT_ROOM_TYPE = '/labyrinth_room_types/combat';
const SKILLING_ROOM_TYPE = '/labyrinth_room_types/skilling';

class LabyrinthTracker {
    constructor() {
        this.prevRoomData = null;
        this.monsterBestLevels = {};
        // Kept through the shared load/save discipline: a read that could not
        // be made keeps the levels in memory rather than blanking them, and a
        // save folds in what is stored (higher level wins) instead of
        // overwriting it. Character-scoped under `monsterBestLevels_<id>`.
        this.record = createPersistedRecord({
            base: STORAGE_KEY_PREFIX,
            store: STORE_NAME,
            empty: () => ({}),
            merge: mergeBestLevels,
            migrate: 'discard',
            immediate: true,
            label: 'LabyrinthTracker',
        });
        this.handlers = {};
        this.isInitialized = false;
        this.updateListeners = [];
    }

    /**
     * Initialize labyrinth tracker
     */
    async initialize() {
        if (!config.getSetting('labyrinthTracker')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        // Taken before the read, checked after it. A `character_switching`
        // teardown landing inside `loadData()` used to leave both a live
        // `labyrinth_updated` handler and `isInitialized = true` behind it, and
        // the switch's own re-initialise then early-returned on that flag — the
        // tracker recorded nothing for the arriving character until the page was
        // reloaded.
        const ticket = captureOwner(this);
        await this.loadData();
        if (!stillOurs(ticket)) return;

        this.handlers.labyrinthUpdated = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.handlers.labyrinthUpdated);

        this.isInitialized = true;
    }

    /**
     * Disable and clean up
     */
    disable() {
        noteTeardown(this);
        try {
            if (this.handlers.labyrinthUpdated) {
                webSocketHook.off('labyrinth_updated', this.handlers.labyrinthUpdated);
                this.handlers.labyrinthUpdated = null;
            }

            this.prevRoomData = null;
            this.updateListeners = [];
            // The bests are one character's; forgotten here so the next initialize
            // — which is how a character switch arrives — reads the arriving
            // character's rather than writing these under their key
            this.monsterBestLevels = {};
            this.record.reset();
            this.isInitialized = false;
        } catch (error) {
            console.error('[Labyrinth Tracker] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Handle labyrinth_updated WebSocket event
     * @param {Object} data - WS message payload
     */
    onLabyrinthUpdated(data) {
        const roomData = data.labyrinth?.roomData;

        if (!roomData) {
            return;
        }

        if (this.prevRoomData) {
            this.diffRooms(this.prevRoomData, roomData);
        }

        // Deep-copy to snapshot current state
        this.prevRoomData = roomData.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
    }

    /**
     * Compare previous and current room grids to find newly cleared rooms
     * @param {Array} prevRooms - Previous room grid snapshot
     * @param {Array} currRooms - Current room grid
     */
    diffRooms(prevRooms, currRooms) {
        for (let row = 0; row < currRooms.length; row++) {
            for (let col = 0; col < currRooms[row].length; col++) {
                const prev = prevRooms[row]?.[col];
                const curr = currRooms[row][col];

                if (!prev || !curr) {
                    continue;
                }

                const wasTrackable =
                    (prev.roomType === COMBAT_ROOM_TYPE || prev.roomType === SKILLING_ROOM_TYPE) && !prev.isCleared;
                const isNowCleared = curr.isCleared === true;
                // Shrouded rooms go straight to cleared without entryCount;
                // naturally cleared rooms always had entryCount set first — except
                // a first-try win, whose entry and clear can land in the very same
                // update (no intermediate "entered, still uncleared" snapshot ever
                // observed). `prev` alone would read that as never entered, so the
                // still-unstripped `curr` entryCount is also accepted, mirroring the
                // guard `labyrinth-outcome-log.js`'s foldFloorOutcomes uses.
                const wasEntered = prev.entryCount > 0 || curr.entryCount > 0;

                if (wasTrackable && isNowCleared && wasEntered) {
                    this.recordClear(prev);
                }
            }
        }
    }

    /**
     * Record a room clear, updating best level if this is a new record
     * @param {Object} room - Pre-clear room data
     */
    recordClear(room) {
        const hrid = room.monsterHrid || room.skillHrid || room.combatZoneHrid || room.enemyHrid || null;

        if (!hrid) {
            console.warn('[LabyrinthTracker] Could not determine HRID from room:', room);
            return;
        }

        let recommendedLevel = room.recommendedLevel;
        if (recommendedLevel == null) {
            const clientData = dataManager.getInitClientData();
            const details = clientData?.combatMonsterDetailMap?.[hrid] || clientData?.skillDetailMap?.[hrid];
            recommendedLevel = details?.recommendedLevel;
        }

        if (recommendedLevel == null) {
            console.warn('[LabyrinthTracker] Could not determine recommendedLevel for', hrid);
            return;
        }

        const level = Number(recommendedLevel);
        const existing = this.monsterBestLevels[hrid];

        if (!existing || level > existing.bestLevel) {
            const clientData = dataManager.getInitClientData();
            const details = clientData?.combatMonsterDetailMap?.[hrid] || clientData?.skillDetailMap?.[hrid];
            const name = details?.name || hrid;

            this.monsterBestLevels[hrid] = { name, bestLevel: level };
            this.saveData();
            this.notifyListeners();
        }
    }

    /**
     * Load stored best levels from IndexedDB
     */
    async loadData() {
        try {
            this.record.set(this.monsterBestLevels);
            await this.record.load();
            this.monsterBestLevels = this.record.get();
        } catch (error) {
            console.error('[LabyrinthTracker] Failed to load data:', error);
        }
    }

    /**
     * Save best levels to IndexedDB. Skipped when storage cannot be read
     * first; otherwise the higher of stored and memory is kept per monster.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveData() {
        try {
            this.record.set(this.monsterBestLevels);
            const landed = await this.record.save();
            this.monsterBestLevels = this.record.get();
            return landed;
        } catch (error) {
            console.error('[LabyrinthTracker] Failed to save data:', error);
            return false;
        }
    }

    /**
     * Get the best level recorded for a monster
     * @param {string} monsterHrid - Monster HRID
     * @returns {number|null} Best level or null
     */
    getBestLevel(monsterHrid) {
        return this.monsterBestLevels[monsterHrid]?.bestLevel ?? null;
    }

    /**
     * Subscribe to update events (called when a new best is recorded)
     * @param {Function} cb - Callback function
     */
    onUpdate(cb) {
        if (!this.updateListeners.includes(cb)) {
            this.updateListeners.push(cb);
        }
    }

    /**
     * Unsubscribe from update events
     * @param {Function} cb - Callback function
     */
    offUpdate(cb) {
        this.updateListeners = this.updateListeners.filter((l) => l !== cb);
    }

    /**
     * Notify all update subscribers
     */
    notifyListeners() {
        for (const cb of this.updateListeners) {
            try {
                cb();
            } catch (error) {
                console.error('[LabyrinthTracker] Error in update listener:', error);
            }
        }
    }
}

const labyrinthTracker = new LabyrinthTracker();
export default labyrinthTracker;
