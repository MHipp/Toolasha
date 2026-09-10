/**
 * Combat Statistics Data Collector
 * Listens for new_battle WebSocket messages and stores combat data
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { sessionKey, archiveSession } from './combat-session-history.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/**
 * How long a finished run stays on the overlay.
 *
 * Long enough to read what you just earned after combat stops, short enough that
 * a rate dividing by a clock nobody stopped does not sit there looking like a
 * measurement. Only ever consulted when the character is *not* in combat — a run
 * still under way is never withheld, however old its snapshot.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Keys under the 'combatStats' store, scoped per character.
 *
 * All four describe one character's live run — what it drank, what its party
 * drank, what it looted — so a shared key had the iron cow reading the market
 * cow's consumption rates. Keys are resolved at each read and write, never
 * cached, because the user switches characters without reloading.
 *
 * The pre-scoping global values are *discarded* rather than adopted: this is
 * live session state measured against one character's gear and one party's
 * roster, and starting empty is better than starting wrong.
 */
const CONSUMABLE_TRACKER_KEY = 'consumableTracker';
const PARTY_TRACKERS_KEY = 'partyConsumableTrackers';
const PARTY_SNAPSHOTS_KEY = 'partyConsumableSnapshots';
const LATEST_RUN_KEY = 'latestCombatRun';

/**
 * Whether this character's copy of a record can be read right now.
 *
 * The trackers here are live counters of the run in hand — memory is the
 * truth and is written out whole, which is right for a counter. What must not
 * happen is the write landing when the read side is down: a tab that could
 * not read its stored counts would then write its own, smaller ones over
 * them. So every write probes first and stands down when the probe cannot
 * be made. (The loads already keep memory on a failed read: `readScoped`
 * answers null there and null is never adopted.)
 *
 * The probe is a real IndexedDB read, and `onNewBattle` used to make it
 * several times per wave — once per tracker write — which on a party dungeon
 * was more reads than the data being protected was worth. A probe that
 * succeeded is trusted for a few seconds (`READ_PROBE_TTL_MS`): a connection
 * that drops inside that window costs at most one write landing on a database
 * the next probe will find unreadable, and a failed probe is never cached, so
 * the next save asks again.
 * @param {string} base - The unscoped key
 * @returns {Promise<boolean>}
 */
/**
 * One character's scoped key, from an id the caller captured.
 *
 * Deliberately not `writeScoped()`: that resolves `characterKey()` when the
 * write runs, and every write here sits on the far side of at least one await.
 * @param {string} base - The unscoped key
 * @param {string} charId - Whose key
 * @returns {string} `base_<charId>`
 */
function scopedFor(base, charId) {
    return `${base}_${charId}`;
}

async function storeReadable(base) {
    const now = Date.now();
    if (readProbe.ok && now - readProbe.at < READ_PROBE_TTL_MS) return true;

    const probed = await storage.tryGet(characterKey(base), COMBAT_STORE);
    if (probed === null) {
        readProbe.ok = false;
        console.warn(`[Combat Stats] ${base} not saved: storage could not be read first`);
        return false;
    }
    readProbe.ok = true;
    readProbe.at = now;
    return true;
}

/** How long one successful readability probe stands in for the next ones */
const READ_PROBE_TTL_MS = 5000;
/** The last successful probe: when it was made, and whether it is still trusted */
const readProbe = { ok: false, at: 0 };

/**
 * Test-only: forget the cached readability probe, so the next save probes again.
 * @returns {void}
 */
export function _resetReadProbe() {
    readProbe.ok = false;
    readProbe.at = 0;
}
const COMBAT_STORE = 'combatStats';
const DISCARD_LEGACY = { migrate: 'discard' };

class CombatStatsDataCollector {
    constructor() {
        this.isInitialized = false;
        this.newBattleHandler = null;
        this.consumableEventHandler = null;
        this.latestCombatData = null;
        this.currentBattleId = null;
        /** Which run the snapshot belongs to; a change means the last one ended */
        this.sessionKey = null;

        // Consumable tracking state for current player (persisted to storage like MCS)
        this.consumableTracker = {
            actualConsumed: {}, // { itemHrid: count }
            defaultConsumed: {}, // { itemHrid: baselineCount }
            inventoryAmount: {}, // { itemHrid: currentCount }
            startTime: null, // When tracking started
            lastUpdate: null, // Last consumption event timestamp
            lastEventByItem: {}, // { itemHrid: timestamp } - for deduplication
        };

        // Party member consumable tracking (MCS-style)
        this.partyConsumableTrackers = {}; // { playerName: tracker }
        this.partyConsumableSnapshots = {}; // { playerName: { itemHrid: previousCount } }
        this.partyLastKnownConsumables = {}; // { playerName: { itemHrid: { itemHrid, lastSeenCount } } }

        // Character switch listeners, registered once (see initialize)
        this.switchingHandler = null;
        this.switchedHandler = null;
    }

    /**
     * Initialize the data collector
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // `isInitialized` is set *before* the two reads below, so a
        // `character_switching` teardown landing inside either never made the
        // switch's re-initialise early-return. The resumed tail instead ran on
        // top of a `cleanup()` that had already unhooked both socket handlers
        // and nulled the fields holding them, and re-stored its own into those
        // same fields — leaving the previous `new_battle` and
        // `battle_consumable_ability_updated` handlers live with no handle left
        // to remove them by. One leaked pair per switch, each one counting the
        // same tick again: doubled damage and doubled consumable counts in the
        // Combat Statistics panel.
        const ticket = captureOwner(this);

        // Load persisted tracking state from storage (MCS-style)
        await this.loadConsumableTracking();
        if (!stillOurs(ticket)) return;

        // And the last run itself. Without this the overlay showed "No loot
        // tracked yet" after every refresh until the next battle started — in a
        // dungeon that is a whole wave of nothing — while the Combat Statistics
        // popup showed the run perfectly, because the popup was the only caller
        // of loadLatestData. The snapshot was written all along and never read
        // back at start-up.
        //
        // Safe to restore unconditionally: the rows date it from
        // `combatStartTime`, and the next `new_battle` overwrites it outright.
        await this.loadLatestData();
        // Guards the whole resumed tail — both handlers below, and the switch
        // pair after them.
        if (!stillOurs(ticket)) return;

        // Store handler references for cleanup
        this.newBattleHandler = (data) => this.onNewBattle(data);
        this.consumableEventHandler = (data) => this.onConsumableUsed(data);

        // Listen for new_battle messages (fires during combat, continuously updated)
        webSocketHook.on('new_battle', this.newBattleHandler);

        // Listen for battle_consumable_ability_updated (fires on each consumable use)
        webSocketHook.on('battle_consumable_ability_updated', this.consumableEventHandler);

        // Everything above is one character's live run. This pair is registered
        // once and never removed — but not, as this comment used to claim,
        // because the collector is "not always disabled on a switch". It always
        // is: `entrypoint.js` normalises a module's `cleanup()` into the
        // registry entry's `.disable`, `feature-registry.js`'s
        // `disableAllFeatures()` calls every registered feature's `.disable()`
        // unconditionally on `character_switching`, and Combat Statistics is
        // registered exactly that way (`module: Combat.combatStats`, whose
        // `cleanup()` calls this one's).
        //
        // The real reason is what `cleanup()` deliberately does *not* do: it
        // leaves the consumable trackers in memory, because they are persisted.
        // Forgetting them is `onCharacterSwitching`'s job, and it has to happen
        // while the collector is down — the teardown and the switch are the
        // same event — or the departing character's in-memory run is written
        // straight back out under the arriving character's key. So the pair
        // outlives the feature lifecycle on purpose, and this guard is what
        // keeps each re-initialise from stacking a second pair on top of it.
        if (!this.switchingHandler) {
            this.switchingHandler = () => this.onCharacterSwitching();
            this.switchedHandler = () => this.onCharacterSwitched();
            dataManager.on('character_switching', this.switchingHandler);
            dataManager.on('character_switched', this.switchedHandler);
        }
    }

    /**
     * Forget the departing character's run.
     *
     * The keys are per character and derived at each access, so nothing here
     * needs re-keying — what needs doing is forgetting, since the in-memory
     * copy is the one thing a scoped key cannot protect. Nothing is read or
     * written: dataManager still reports the departing character at this point,
     * so a read here would fetch the run we are trying to forget.
     */
    onCharacterSwitching() {
        this._resetTrackersInMemory();
        this.latestCombatData = null;
        this.currentBattleId = null;
        this.sessionKey = null;
    }

    /** Bring in the arriving character's own run, now that they are current. */
    async onCharacterSwitched() {
        try {
            await this.loadConsumableTracking();
            await this.loadLatestData();
        } catch (error) {
            console.error('[Combat Stats] Reloading after a character switch failed:', error);
        }
    }

    /**
     * Get game-theoretical maximum consumption rate per day for an item
     * Based on cooldown floors: drinks 300s / 1.2 max concentration, food 60s flat
     * @param {string} itemHrid - Item HRID
     * @returns {number} Max consumptions per day
     */
    getMaxRatePerDay(itemHrid) {
        const name = itemHrid.toLowerCase();
        if (name.includes('coffee') || name.includes('drink')) {
            return 345.6; // 300s / (1 + 0.20 max drink concentration) = 250s cooldown
        }
        return 1440; // 60s food cooldown
    }

    /**
     * @param {string} itemHrid - Item HRID
     * @returns {number} Default consumed count (2 for drinks, 10 for food)
     */
    getDefaultConsumed(itemHrid) {
        const name = itemHrid.toLowerCase();
        if (name.includes('coffee') || name.includes('drink')) return 2;
        if (
            name.includes('donut') ||
            name.includes('cupcake') ||
            name.includes('cake') ||
            name.includes('gummy') ||
            name.includes('yogurt')
        )
            return 10;
        return 0;
    }

    /**
     * Calculate elapsed seconds since tracking started (MCS-style)
     * @param {Object} tracker - Tracker object (current player or party member)
     * @returns {number} Elapsed seconds
     */
    calcElapsedSeconds(tracker = null) {
        const targetTracker = tracker || this.consumableTracker;
        if (!targetTracker.startTime) {
            return 0;
        }
        return Math.max(0, (Date.now() - targetTracker.startTime) / 1000);
    }

    /**
     * Create a new party member tracker (MCS-style)
     * @returns {Object} New tracker object
     */
    createPartyTracker() {
        return {
            actualConsumed: {},
            defaultConsumed: {},
            inventoryAmount: {},
            startTime: Date.now(),
            lastUpdate: null,
        };
    }

    /**
     * Load consumable tracking state from storage
     */
    async loadConsumableTracking() {
        try {
            // Load current player tracker
            const saved = await readScoped(CONSUMABLE_TRACKER_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (saved) {
                // Restore tracking state
                this.consumableTracker.actualConsumed = saved.actualConsumed || {};
                this.consumableTracker.defaultConsumed = saved.defaultConsumed || {};
                this.consumableTracker.inventoryAmount = saved.inventoryAmount || {};
                this.consumableTracker.lastUpdate = saved.lastUpdate || null;

                // Restore elapsed time by adjusting startTime
                if (saved.elapsedMs !== undefined && saved.saveTimestamp) {
                    this.consumableTracker.startTime = Date.now() - saved.elapsedMs;
                } else if (saved.startTime) {
                    // Legacy: direct startTime (will include offline time)
                    this.consumableTracker.startTime = saved.startTime;
                }
            }

            // Load party member trackers (MCS-style)
            const savedPartyTrackers = await readScoped(PARTY_TRACKERS_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (savedPartyTrackers) {
                const now = Date.now();
                this.partyConsumableTrackers = {};
                Object.keys(savedPartyTrackers).forEach((playerName) => {
                    const playerTracker = savedPartyTrackers[playerName];
                    if (
                        playerTracker.actualConsumed &&
                        playerTracker.defaultConsumed &&
                        playerTracker.inventoryAmount
                    ) {
                        const elapsedMs = playerTracker.elapsedMs || 0;
                        this.partyConsumableTrackers[playerName] = {
                            actualConsumed: playerTracker.actualConsumed || {},
                            defaultConsumed: playerTracker.defaultConsumed || {},
                            inventoryAmount: playerTracker.inventoryAmount || {},
                            startTime: now - elapsedMs,
                            lastUpdate: playerTracker.lastUpdate || null,
                        };
                    }
                });
            }

            // Load party snapshots
            const savedSnapshots = await readScoped(PARTY_SNAPSHOTS_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
            if (savedSnapshots) {
                this.partyConsumableSnapshots = savedSnapshots;
            }
        } catch (error) {
            console.error('[Combat Stats] Error loading consumable tracking:', error);
        }
    }

    /**
     * Cap elapsed time and counts to a maximum window, preserving the rate ratio.
     * Prevents long-running sessions from dominating the rate after a reload.
     * @param {Object} counts - actualConsumed or defaultConsumed map (not mutated)
     * @param {number} elapsedMs - Raw elapsed time in ms
     * @param {number} maxMs - Maximum window in ms
     * @returns {{counts: Object, elapsedMs: number}}
     */
    capToWindow(counts, elapsedMs, maxMs) {
        if (elapsedMs <= maxMs) {
            return { counts, elapsedMs };
        }
        const ratio = maxMs / elapsedMs;
        const capped = {};
        Object.keys(counts).forEach((k) => {
            capped[k] = Math.round(counts[k] * ratio);
        });
        return { counts: capped, elapsedMs: maxMs };
    }

    /**
     * Save consumable tracking state to storage
     */
    async saveConsumableTracking(owner = dataManager.getCurrentCharacterId()) {
        try {
            // Every key below is built from `owner`, captured before the first
            // await, rather than resolved again by `writeScoped` when each
            // write runs. There are four suspension points in this method and a
            // non-immediate `storage.set` resolves only when its three-second
            // debounce fires, so the three writes are seconds apart — wide
            // enough for a switch to split one save across two characters. And
            // `onCharacterSwitching` blanks these trackers synchronously, so
            // what the resumed half writes is an EMPTY record over the arriving
            // character's stored counts, resetting their consumption rates.
            if (!owner) return false;
            if (!(await storeReadable(CONSUMABLE_TRACKER_KEY))) return false;
            if (dataManager.getCurrentCharacterId() !== owner) return false;
            const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

            // Save current player tracker
            const rawElapsedMs = this.consumableTracker.startTime ? Date.now() - this.consumableTracker.startTime : 0;
            const { counts: cappedActual, elapsedMs: cappedElapsed } = this.capToWindow(
                this.consumableTracker.actualConsumed,
                rawElapsedMs,
                MAX_WINDOW_MS
            );
            const { counts: cappedDefault } = this.capToWindow(
                this.consumableTracker.defaultConsumed,
                rawElapsedMs,
                MAX_WINDOW_MS
            );
            const toSave = {
                actualConsumed: cappedActual,
                defaultConsumed: cappedDefault,
                inventoryAmount: this.consumableTracker.inventoryAmount,
                lastUpdate: this.consumableTracker.lastUpdate,
                elapsedMs: cappedElapsed,
                saveTimestamp: Date.now(),
            };
            await storage.set(scopedFor(CONSUMABLE_TRACKER_KEY, owner), toSave, COMBAT_STORE);
            if (dataManager.getCurrentCharacterId() !== owner) return false;

            // Save party member trackers (MCS-style)
            const partyTrackersToSave = {};
            Object.keys(this.partyConsumableTrackers).forEach((playerName) => {
                const tracker = this.partyConsumableTrackers[playerName];
                if (tracker && tracker.actualConsumed && tracker.defaultConsumed && tracker.inventoryAmount) {
                    const rawPartyElapsedMs = tracker.startTime ? Date.now() - tracker.startTime : 0;
                    const { counts: pCappedActual, elapsedMs: pCappedElapsed } = this.capToWindow(
                        tracker.actualConsumed,
                        rawPartyElapsedMs,
                        MAX_WINDOW_MS
                    );
                    const { counts: pCappedDefault } = this.capToWindow(
                        tracker.defaultConsumed,
                        rawPartyElapsedMs,
                        MAX_WINDOW_MS
                    );
                    partyTrackersToSave[playerName] = {
                        actualConsumed: pCappedActual,
                        defaultConsumed: pCappedDefault,
                        inventoryAmount: tracker.inventoryAmount || {},
                        elapsedMs: pCappedElapsed,
                        lastUpdate: tracker.lastUpdate || null,
                        saveTimestamp: Date.now(),
                    };
                }
            });
            await storage.set(scopedFor(PARTY_TRACKERS_KEY, owner), partyTrackersToSave, COMBAT_STORE);
            if (dataManager.getCurrentCharacterId() !== owner) return false;

            // Save party snapshots
            await storage.set(scopedFor(PARTY_SNAPSHOTS_KEY, owner), this.partyConsumableSnapshots, COMBAT_STORE);
            return true;
        } catch (error) {
            console.error('[Combat Stats] Error saving consumable tracking:', error);
            return false;
        }
    }

    /**
     * Reset consumable tracking (for new combat session)
     */
    async resetConsumableTracking() {
        this._resetTrackersInMemory();
        // Fire-and-forget: don't await debounced writes so callers aren't blocked
        writeScoped(CONSUMABLE_TRACKER_KEY, null, COMBAT_STORE);
        writeScoped(PARTY_TRACKERS_KEY, null, COMBAT_STORE);
        writeScoped(PARTY_SNAPSHOTS_KEY, null, COMBAT_STORE);
    }

    /**
     * Blank the in-memory trackers without touching storage.
     *
     * Split out of `resetConsumableTracking` for the character switch, which
     * must not write: the departing character's counts have their own key and
     * belong there, and clearing them under the arriving character's key would
     * be writing one character's zeroes over another character's record.
     * @private
     */
    _resetTrackersInMemory() {
        this.consumableTracker = {
            actualConsumed: {},
            defaultConsumed: {},
            inventoryAmount: {},
            startTime: Date.now(),
            lastUpdate: null,
            lastEventByItem: {},
        };
        this.partyConsumableTrackers = {};
        this.partyConsumableSnapshots = {};
        this.partyLastKnownConsumables = {};
    }

    /**
     * Handle battle_consumable_ability_updated event (fires on each consumption)
     * NOTE: This event only fires for the CURRENT PLAYER (solo tracking)
     * @param {Object} data - Consumable update data
     */
    async onConsumableUsed(data) {
        try {
            // Skip ability consumptions
            const itemHrid = data.consumable?.itemHrid;
            if (!itemHrid || itemHrid.includes('/ability/')) {
                return;
            }

            if (!data || !data.consumable) {
                return;
            }

            const now = Date.now();

            // Deduplicate: skip if we already processed this item within 100ms
            // (game sometimes sends duplicate events)
            const lastEventTime = this.consumableTracker.lastEventByItem[itemHrid] || 0;
            if (now - lastEventTime < 100) {
                return; // Skip duplicate event
            }
            this.consumableTracker.lastEventByItem[itemHrid] = now;

            // Initialize tracking if first event
            if (!this.consumableTracker.startTime) {
                this.consumableTracker.startTime = now;
            }

            // Initialize item if first time seen (MCS-style)
            if (this.consumableTracker.actualConsumed[itemHrid] === undefined) {
                this.consumableTracker.actualConsumed[itemHrid] = 0;
                this.consumableTracker.defaultConsumed[itemHrid] = this.getDefaultConsumed(itemHrid);
            }

            // Increment consumption count
            this.consumableTracker.actualConsumed[itemHrid]++;
            this.consumableTracker.lastUpdate = now;

            // Update inventory amount from event data
            if (data.consumable.count !== undefined) {
                this.consumableTracker.inventoryAmount[itemHrid] = data.consumable.count;
            }

            // Persist after each consumption (MCS-style)
            await this.saveConsumableTracking();
        } catch (error) {
            console.error('[Combat Stats] Error processing consumable event:', error);
        }
    }

    /**
     * Handle new_battle message (fires during combat)
     * @param {Object} data - new_battle message data
     */
    async onNewBattle(data) {
        try {
            // Only process if we have players data
            if (!data.players || data.players.length === 0) {
                return;
            }

            const battleId = data.battleId || 0;

            // Calculate duration from combat start time. Clamped at zero: the
            // start time is the server's clock and "now" is ours, so a short
            // run on a client a second or two behind measured negative — which
            // the session picker then rendered as no duration at all.
            const combatStartTime = new Date(data.combatStartTime).getTime() / 1000;
            const currentTime = Date.now() / 1000;
            const durationSeconds = Number.isFinite(combatStartTime) ? Math.max(0, currentTime - combatStartTime) : 0;

            // Calculate elapsed tracking time (MCS-style)
            const elapsedSeconds = this.calcElapsedSeconds();

            // Detect new combat session and reset consumable tracking
            // Primary: battleId decreased (went back to 1 or lower)
            // Fallback: combat duration is shorter than tracking duration (missed a reset while offline)
            const shouldResetTracking =
                (this.currentBattleId !== null && battleId < this.currentBattleId) ||
                (elapsedSeconds > 0 && durationSeconds < elapsedSeconds);

            if (shouldResetTracking) {
                this.resetConsumableTracking();
            }

            // Update current battle ID
            this.currentBattleId = battleId;

            // Get current character ID to identify which player is the current user
            const currentCharacterId = dataManager.getCurrentCharacterId();

            // Track party member consumables via inventory snapshots (MCS-style)
            const currentPartyMembers = new Set();
            data.players.forEach((player) => {
                if (!player || !player.character) return;
                const playerName = player.character.name;
                currentPartyMembers.add(playerName);

                // Skip current player (tracked via consumable events)
                if (player.character.id === currentCharacterId) {
                    return;
                }

                // Initialize snapshot storage if needed
                if (!this.partyConsumableSnapshots[playerName]) {
                    this.partyConsumableSnapshots[playerName] = {};
                }

                if (!this.partyLastKnownConsumables) {
                    this.partyLastKnownConsumables = {};
                }
                if (!this.partyLastKnownConsumables[playerName]) {
                    this.partyLastKnownConsumables[playerName] = {};
                }

                // Initialize tracker if needed
                if (!this.partyConsumableTrackers[playerName]) {
                    this.partyConsumableTrackers[playerName] = this.createPartyTracker();
                    // Initialize all consumables
                    if (player.combatConsumables) {
                        player.combatConsumables.forEach((consumable) => {
                            if (consumable && consumable.itemHrid) {
                                this.partyConsumableTrackers[playerName].actualConsumed[consumable.itemHrid] = 0;
                                this.partyConsumableTrackers[playerName].defaultConsumed[consumable.itemHrid] =
                                    this.getDefaultConsumed(consumable.itemHrid);
                            }
                        });
                    }
                }

                const tracker = this.partyConsumableTrackers[playerName];

                // Remove items no longer in consumables
                if (player.combatConsumables && player.combatConsumables.length > 0 && tracker) {
                    const currentConsumableHrids = new Set(
                        player.combatConsumables.filter((c) => c && c.itemHrid).map((c) => c.itemHrid)
                    );

                    Object.keys(tracker.actualConsumed).forEach((itemHrid) => {
                        if (!currentConsumableHrids.has(itemHrid)) {
                            delete tracker.actualConsumed[itemHrid];
                            delete tracker.defaultConsumed[itemHrid];
                            delete tracker.inventoryAmount[itemHrid];
                        }
                    });
                }

                // Track current consumables
                const currentlySeenHrids = new Set();
                if (player.combatConsumables && player.combatConsumables.length > 0) {
                    player.combatConsumables.forEach((consumable) => {
                        if (!consumable || !consumable.itemHrid) return;

                        const itemHrid = consumable.itemHrid;
                        const currentCount = consumable.count;
                        const previousCount = this.partyConsumableSnapshots[playerName][itemHrid];

                        currentlySeenHrids.add(itemHrid);

                        this.partyLastKnownConsumables[playerName][itemHrid] = {
                            itemHrid: itemHrid,
                            lastSeenCount: currentCount,
                        };

                        // Compare with previous snapshot to detect consumption (MCS-style)
                        if (previousCount !== undefined) {
                            const diff = previousCount - currentCount;

                            // Accept 1-5 consumed between events; rejects stale cross-session diffs
                            if (diff > 0 && diff <= 5) {
                                tracker.actualConsumed[itemHrid] = (tracker.actualConsumed[itemHrid] || 0) + diff;
                                tracker.lastUpdate = Date.now();
                            }
                        }

                        // Update snapshot
                        this.partyConsumableSnapshots[playerName][itemHrid] = currentCount;
                        tracker.inventoryAmount[itemHrid] = currentCount;
                    });
                }

                // Handle items that disappeared (ran out or removed)
                Object.keys(this.partyLastKnownConsumables[playerName] || {}).forEach((itemHrid) => {
                    if (!currentlySeenHrids.has(itemHrid)) {
                        const previousCount = this.partyConsumableSnapshots[playerName][itemHrid];
                        if (previousCount !== undefined && previousCount > 0) {
                            tracker.inventoryAmount[itemHrid] = 0;
                            this.partyConsumableSnapshots[playerName][itemHrid] = 0;
                        }
                    }
                });
            });

            // Clean up trackers for players who left the party
            Object.keys(this.partyConsumableTrackers).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyConsumableTrackers[playerName];
                }
            });
            Object.keys(this.partyConsumableSnapshots).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyConsumableSnapshots[playerName];
                }
            });
            Object.keys(this.partyLastKnownConsumables).forEach((playerName) => {
                if (!currentPartyMembers.has(playerName)) {
                    delete this.partyLastKnownConsumables[playerName];
                }
            });

            // The party trackers are persisted once, at the end of this handler,
            // together with the player's own — one write per wave, not two

            // Extract combat data
            const combatData = {
                timestamp: Date.now(),
                battleId: battleId,
                combatStartTime: data.combatStartTime,
                // Which zone this run was, so a restored snapshot can be told
                // apart from the run the character is in now. Time alone cannot
                // do it: a character left fighting overnight has an old snapshot
                // of a run that is still going.
                actionHrid: this.currentCombatAction(),
                durationSeconds: durationSeconds,
                players: data.players.map((player) => {
                    // Check if this player is the current user by matching character ID
                    const isCurrentPlayer = player.character.id === currentCharacterId;

                    // Process consumables
                    const consumablesWithConsumed = [];
                    const seenItems = new Set();

                    if (player.combatConsumables) {
                        for (const consumable of player.combatConsumables) {
                            if (seenItems.has(consumable.itemHrid)) {
                                continue;
                            }
                            seenItems.add(consumable.itemHrid);

                            // Get tracking data
                            let actualConsumed;
                            let defaultConsumed;
                            let trackingElapsed;
                            let inventoryAmount;

                            if (isCurrentPlayer) {
                                // Current player: use event-based tracking
                                this.consumableTracker.inventoryAmount[consumable.itemHrid] = consumable.count;
                                actualConsumed = this.consumableTracker.actualConsumed[consumable.itemHrid] || 0;
                                defaultConsumed =
                                    this.consumableTracker.defaultConsumed[consumable.itemHrid] ||
                                    this.getDefaultConsumed(consumable.itemHrid);
                                trackingElapsed = elapsedSeconds;
                                inventoryAmount =
                                    this.consumableTracker.inventoryAmount[consumable.itemHrid] || consumable.count;
                            } else {
                                // Party member: use snapshot-based tracking (MCS-style)
                                const playerName = player.character.name;
                                const partyTracker = this.partyConsumableTrackers[playerName];

                                if (partyTracker) {
                                    actualConsumed = partyTracker.actualConsumed[consumable.itemHrid] || 0;
                                    defaultConsumed =
                                        partyTracker.defaultConsumed[consumable.itemHrid] ||
                                        this.getDefaultConsumed(consumable.itemHrid);
                                    trackingElapsed = this.calcElapsedSeconds(partyTracker);
                                    inventoryAmount =
                                        partyTracker.inventoryAmount[consumable.itemHrid] || consumable.count;
                                } else {
                                    // Fallback if tracker not initialized yet
                                    actualConsumed = 0;
                                    defaultConsumed = this.getDefaultConsumed(consumable.itemHrid);
                                    trackingElapsed = 0;
                                    inventoryAmount = consumable.count;
                                }
                            }

                            // MCS formula (exact match to MCS code lines 26027-26030)
                            const DEFAULT_TIME = 10 * 60; // 600 seconds
                            const actualRate = trackingElapsed > 0 ? actualConsumed / trackingElapsed : 0;
                            const combinedRate = (defaultConsumed + actualConsumed) / (DEFAULT_TIME + trackingElapsed);
                            const rawRate = actualRate * 0.9 + combinedRate * 0.1;

                            // Cap at game-theoretical maximum (cooldown-based):
                            // Drinks: 300s base / 1.2 max concentration (+20 guzzling pouch) = 345.6/day
                            // Food: 60s base cooldown = 1440/day (drink concentration doesn't affect food)
                            const maxRatePerDay = this.getMaxRatePerDay(consumable.itemHrid);
                            const consumptionRate = Math.min(rawRate, maxRatePerDay / 86400);

                            // Per-day rate (MCS uses Math.ceil)
                            const consumedPerDay = Math.ceil(consumptionRate * 86400);

                            // Estimate for this combat session
                            const estimatedConsumed = consumptionRate * durationSeconds;

                            // Time until inventory runs out (MCS-style)
                            const timeToZeroSeconds =
                                consumptionRate > 0 ? inventoryAmount / consumptionRate : Infinity;

                            const consumableData = {
                                itemHrid: consumable.itemHrid,
                                currentCount: consumable.count,
                                actualConsumed: actualConsumed,
                                defaultConsumed: defaultConsumed,
                                consumed: estimatedConsumed,
                                consumedPerDay: consumedPerDay,
                                consumptionRate: consumptionRate,
                                elapsedSeconds: trackingElapsed,
                                inventoryAmount: inventoryAmount,
                                timeToZeroSeconds: timeToZeroSeconds,
                            };
                            consumablesWithConsumed.push(consumableData);
                        }
                    }

                    return {
                        name: player.character.name,
                        characterId: player.character.id,
                        isCurrentPlayer: isCurrentPlayer,
                        loot: player.totalLootMap || {},
                        experience: player.totalSkillExperienceMap || {},
                        deathCount: player.deathCount || 0,
                        consumables: consumablesWithConsumed,
                        combatStats: {
                            combatDropQuantity: player.combatDetails?.combatStats?.combatDropQuantity || 0,
                            combatDropRate: player.combatDetails?.combatStats?.combatDropRate || 0,
                            combatRareFind: player.combatDetails?.combatStats?.combatRareFind || 0,
                            drinkConcentration: player.combatDetails?.combatStats?.drinkConcentration || 0,
                        },
                    };
                }),
            };

            // A different run means the one before it has ended, which is the
            // first moment that is knowable — nothing on the wire announces it.
            // Archived before the snapshot is replaced, so what goes into the
            // history is that session's final state.
            const key = sessionKey(combatData);
            if (this.sessionKey && key && key !== this.sessionKey && this.latestCombatData) {
                archiveSession(this.latestCombatData);
            }
            if (key) this.sessionKey = key;

            // Store in memory
            this.latestCombatData = combatData;

            // Store in IndexedDB — unless storage cannot be read, in which
            // case the stored run stays and memory carries this one
            // `currentCharacterId` was captured at the top of this handler and
            // `combatData` is built entirely from it. `storeReadable` awaits a
            // real read whenever its five-second probe is cold, so a switch can
            // land between it and the write — and `writeScoped` would resolve
            // the key against whoever is current by then, filing this run's
            // loot, xp and party roster under the arriving character.
            if (currentCharacterId && (await storeReadable(LATEST_RUN_KEY))) {
                if (dataManager.getCurrentCharacterId() !== currentCharacterId) return;
                await storage.set(scopedFor(LATEST_RUN_KEY, currentCharacterId), combatData, COMBAT_STORE);
            }

            // Save the tracking state (player and party alike) once per wave
            await this.saveConsumableTracking(currentCharacterId);
        } catch (error) {
            console.error('[Combat Stats] Error collecting combat data:', error);
        }
    }

    /**
     * The combat zone the character is fighting in right now, if any.
     *
     * @returns {string|null} Action hrid, or null when not in combat or when the
     *   character's actions have not loaded yet — which are different things and
     *   the caller has to treat them differently
     */
    currentCombatAction() {
        try {
            const actions = dataManager.getCurrentActions?.();
            if (!Array.isArray(actions)) return null;

            const combat = actions.find(
                (action) => action.actionHrid?.startsWith('/actions/combat/') && !action.isDone
            );
            return combat?.actionHrid || null;
        } catch {
            return null;
        }
    }

    /**
     * Whether a run restored from storage still describes what is happening.
     *
     * A restored snapshot is a photograph of the run as it stood when the tab was
     * last open, and there are two quite different reasons it might be old:
     *
     * - **The run is still going.** The character kept fighting while the tab was
     *   shut, so the snapshot understates a run that is very much alive. Showing
     *   it is right: it is the correct run, a little behind, and the next battle
     *   corrects it. Blanking here would reintroduce exactly the gap this was
     *   meant to close.
     * - **The run is over.** Combat stopped hours ago and the figures describe
     *   something finished. Presenting them as live is the thing worth avoiding —
     *   the per-day rates keep dividing by a clock that never stopped, so they
     *   decay towards zero and read as a run going badly rather than as a run
     *   that is not happening.
     *
     * Elapsed time cannot tell those apart, which is why the current action
     * decides it and the clock is only the fallback for when there is nothing to
     * ask. A different zone in progress means the snapshot is somebody else's
     * run entirely.
     *
     * @returns {boolean}
     */
    isRestoredRunCurrent() {
        const data = this.latestCombatData;
        if (!data) return false;

        const current = this.currentCombatAction();

        // Fighting somewhere else: whatever this is, it is not that
        if (current && data.actionHrid && current !== data.actionHrid) return false;
        // The same run, still under way — age is irrelevant
        if (current && (!data.actionHrid || current === data.actionHrid)) return true;

        // Not in combat, or not yet able to tell. A short grace period so the run
        // you have just finished is still on screen while you look at it, and
        // then it belongs to the popup rather than to the overlay.
        return Date.now() - (data.timestamp || 0) < STALE_AFTER_MS;
    }

    /**
     * Get the latest combat data
     *
     * Live data is returned as-is. A snapshot restored from storage is withheld
     * once it stops describing what is happening — see `isRestoredRunCurrent`.
     *
     * @returns {Object|null} Latest combat data
     */
    getLatestData() {
        if (!this.latestCombatData) return null;
        if (!this.latestCombatData.restored) return this.latestCombatData;

        return this.isRestoredRunCurrent() ? this.latestCombatData : null;
    }

    /**
     * Load latest combat data from storage
     * @returns {Promise<Object|null>} Latest combat data
     */
    async loadLatestData() {
        const data = await readScoped(LATEST_RUN_KEY, COMBAT_STORE, null, DISCARD_LEGACY);
        if (data) {
            // Marked so `getLatestData` knows this came out of storage rather
            // than off the wire, and can stop offering it once it stops being
            // true. Live data is never withheld.
            this.latestCombatData = { ...data, restored: true };

            // Without this, a run that finished while the tab was closed (or
            // between one page load and the next) is never archived: the first
            // `new_battle` after reload is for whatever the character is doing
            // now, `this.sessionKey` was still null from the constructor, and
            // `onNewBattle`'s "a different key means the old one just ended"
            // check only fires when `this.sessionKey` is already set. The
            // restored run was silently dropped instead of archived, and its
            // loot never reached the gold attribution's combat row.
            this.sessionKey = sessionKey(this.latestCombatData);
        }
        return this.latestCombatData;
    }

    /**
     * Cleanup
     */
    cleanup() {
        // First of all, so an `initialize()` parked on either storage read
        // cannot resume into the handler fields this teardown is about to null.
        noteTeardown(this);
        if (this.newBattleHandler) {
            webSocketHook.off('new_battle', this.newBattleHandler);
            this.newBattleHandler = null;
        }

        if (this.consumableEventHandler) {
            webSocketHook.off('battle_consumable_ability_updated', this.consumableEventHandler);
            this.consumableEventHandler = null;
        }

        this.isInitialized = false;
        this.latestCombatData = null;
        this.currentBattleId = null;
        // Note: Don't reset consumableTracker here - it's persisted
    }
}

const combatStatsDataCollector = new CombatStatsDataCollector();

export default combatStatsDataCollector;
