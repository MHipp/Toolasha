/**
 * Dungeon Tracker Core
 * Tracks dungeon progress in real-time using WebSocket messages
 */

import webSocketHook from '../../core/websocket.js';
import dungeonTrackerStorage from './dungeon-tracker-storage.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import {
    DUNGEON_BATTLE_STARTED,
    DUNGEON_BATTLE_ENDED,
    DUNGEON_KEY_COUNTS,
    DUNGEON_PARTY_FAILED_RE,
} from '../../utils/game-text.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import { assessRecoveredStart } from './dungeon-pace.js';
import { parseGameNumber, gameDigitsSource } from '../../utils/number-parser.js';
import { chatStampToDate } from '../../utils/locale-date-order.js';

/**
 * The date a DOM chat stamp means, from a match of the tracker's stamp regexes.
 *
 * All three read `[<first><sep><second> HH:MM:SS <AM/PM>]` into the same seven
 * groups, so they share one reading of it: the slash separator leaves the field
 * order to the game's locale (overruled by any field over 12), the dash and dot
 * separators are day-first in every locale that renders them, and the year is
 * whichever puts the stamp in the recent past.
 *
 * Only the DOM scans need this. The in-memory chat messages carry a real ISO
 * `t`, which has never been ambiguous.
 *
 * @param {RegExpMatchArray} match - Groups: first, separator, second, hour, minute, second, period
 * @returns {Date|null} The stamp's date, or null when no reading of it is one
 */
function stampFromMatch(match) {
    return chatStampToDate({
        first: parseInt(match[1], 10),
        second: parseInt(match[3], 10),
        ambiguousOrder: match[2] === '/',
        hour: parseInt(match[4], 10),
        minute: parseInt(match[5], 10),
        sec: parseInt(match[6], 10),
        period: match[7],
    });
}

/**
 * The party the server says is in this fight, from a `new_battle` message.
 *
 * The only statement of a run's composition that does not depend on chat: the
 * "Key counts" messages can be missed (a page loaded mid-queue scrolls in after
 * them, and a chat channel can be muted), and a run with none of them used to be
 * indistinguishable from a solo run.
 *
 * @param {Object} data - `new_battle` message data
 * @returns {Array<string>|null} Character names, or null when the message did not say
 */
export function battlePartyNames(data) {
    const players = Array.isArray(data?.players) ? data.players : null;
    if (!players || players.length === 0) return null;

    const names = players.map((player) => player?.character?.name).filter((name) => typeof name === 'string' && name);
    return names.length === players.length ? names.sort() : null;
}

/**
 * The run currently under way, parked so a refresh mid-dungeon does not lose it.
 *
 * Scoped per character and resolved at each read and write — the user switches
 * characters without reloading, and restoring the market cow's half-finished
 * Chimerical Den onto the iron cow would invent a run that never happened. The
 * pre-scoping global value is discarded for the same reason.
 */
const IN_PROGRESS_KEY = 'dungeonTracker_inProgressRun';
const DISCARD_LEGACY = { migrate: 'discard' };

/**
 * Who the in-progress record belongs to.
 * @returns {string|null} Character id, or null before login
 */
function currentOwner() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

class DungeonTracker {
    constructor() {
        this.isTracking = false;
        this.isInitialized = false; // Guard flag
        this.currentRun = null;
        this.waveStartTime = null;
        this.lastWaveEndTime = null;
        this.waveTimes = [];
        this.updateCallbacks = [];
        this.pendingDungeonInfo = null; // Store dungeon info before tracking starts
        this.currentBattleId = null; // Current battle ID for persistence verification

        // Party message tracking for server-validated duration
        this.firstKeyCountTimestamp = null; // Timestamp from first "Key counts" message
        this.lastKeyCountTimestamp = null; // Timestamp from last "Key counts" message
        this.keyCountMessages = []; // Store all key count messages for this run
        this.pendingNextRunFirstKeyCount = null; // Carry last timestamp forward as next run's start
        this.battleStartedTimestamp = null; // Timestamp from "Battle started" message

        // Character ID for data isolation
        this.characterId = null;

        // WebSocket message history (last 100 party messages for reliable timestamp capture)
        this.recentChatMessages = [];

        // Guard against restoring stale state after a completion
        // Set synchronously in completeDungeon() before async clearInProgressRun()
        this._lastCompletionTime = 0;

        // True only when the run was picked back up from storage rather than started here.
        // A restored run never saw its own "Key counts" start message, so the next one it
        // sees is the completion; a run started here has that message still to come.
        this.restoredMidRun = false;

        // True when tracking picked the run up part-way through its waves — a
        // refresh at wave 48 of 65, say. Such a run has no true start time: its
        // `startTime` is when we noticed it, not when it began. Nothing derived
        // from that clock may be presented as the run's duration, and the run is
        // never banked to history. Distinct from `restoredMidRun`, which is a run
        // read back from its own saved record and *does* carry a real start.
        this.joinedMidRun = false;

        // Hibernation detection (for UI time label switching)
        this.hibernationDetected = false;
        this.timerRegistry = createTimerRegistry();
        this.visibilityHandler = null;

        // Store handler references for cleanup
        this.handlers = {
            newBattle: null,
            actionCompleted: null,
            actionsUpdated: null,
            chatMessage: null,
        };
    }

    /**
     * Get character ID from URL
     * @returns {string|null} Character ID or null
     */
    getCharacterIdFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('characterId');
    }

    /**
     * Get namespaced storage key for this character
     * @param {string} key - Base key
     * @returns {string} Namespaced key
     */
    getCharacterKey(key) {
        if (!this.characterId) {
            return key;
        }
        return `${key}_${this.characterId}`;
    }

    /**
     * Check if an action is a dungeon action
     * @param {string} actionHrid - Action HRID to check
     * @returns {boolean} True if action is a dungeon
     */
    isDungeonAction(actionHrid) {
        if (!actionHrid || !actionHrid.startsWith('/actions/combat/')) {
            return false;
        }

        const actionDetails = dataManager.getActionDetails(actionHrid);
        return actionDetails?.combatZoneInfo?.isDungeon === true;
    }

    /**
     * Save in-progress run to IndexedDB
     * @returns {Promise<boolean>} Success status
     */
    async saveInProgressRun() {
        if (!this.isTracking || !this.currentRun || !this.currentBattleId) {
            return false;
        }

        const stateToSave = {
            battleId: this.currentBattleId,
            dungeonHrid: this.currentRun.dungeonHrid,
            tier: this.currentRun.tier,
            startTime: this.currentRun.startTime,
            currentWave: this.currentRun.currentWave,
            maxWaves: this.currentRun.maxWaves,
            wavesCompleted: this.currentRun.wavesCompleted,
            waveTimes: [...this.waveTimes],
            waveStartTime: this.waveStartTime?.getTime() || null,
            lastWaveEndTime: this.lastWaveEndTime,
            keyCountsMap: this.currentRun.keyCountsMap || {},
            lastUpdateTime: Date.now(),
            // Save timestamp tracking fields for completion detection
            firstKeyCountTimestamp: this.firstKeyCountTimestamp,
            lastKeyCountTimestamp: this.lastKeyCountTimestamp,
            battleStartedTimestamp: this.battleStartedTimestamp,
            keyCountMessages: this.keyCountMessages,
            hibernationDetected: this.hibernationDetected,
            // Carried so a refresh does not launder a partial run into a whole one
            joinedMidRun: this.currentRun.joinedMidRun === true,
            joinedAtWave: this.currentRun.joinedAtWave ?? null,
            // A partial run whose real start was recovered from party chat, and
            // the anchor it was recovered to. Saved so a second refresh restores
            // the recovery rather than re-deriving it against a chat log that has
            // since scrolled — the same message may no longer be there.
            startRecovered: this.currentRun.startRecovered === true,
            recoveredStartTime: this.currentRun.recoveredStartTime ?? null,
            // Who the server said was fighting; see `battlePartyNames`
            partyNames: this.currentRun.partyNames ?? null,
        };

        return writeScoped(IN_PROGRESS_KEY, stateToSave, 'settings', true);
    }

    /**
     * Guards shared by both restore paths: the mid-dungeon new_battle restore and the
     * page-load pickup. A saved record survives only when no completion just happened,
     * it names a battle (and the one being joined, when there is one to match), and it
     * is recent enough to still describe the run in front of us.
     * @param {Object|null} saved - Saved in-progress record
     * @param {number|null} [expectedBattleId] - Battle ID to match, or null to accept the record's own
     * @returns {boolean} True when the record may be restored
     */
    canRestoreRecord(saved, expectedBattleId = null) {
        if (!saved) {
            return false;
        }

        // Reject restore if a completion just happened (IndexedDB clear may still be in-flight)
        if (Date.now() - this._lastCompletionTime < 5000) {
            return false;
        }

        // A record with no battle to tie it to cannot be verified against anything
        if (saved.battleId === undefined || saved.battleId === null) {
            return false;
        }

        // Verify battleId matches (same run)
        if (expectedBattleId !== null && saved.battleId !== expectedBattleId) {
            return false;
        }

        // Check staleness (older than 10 minutes = likely invalid)
        if (Date.now() - saved.lastUpdateTime > 10 * 60 * 1000) {
            return false;
        }

        return true;
    }

    /**
     * Restore in-progress run from IndexedDB
     * @param {number} currentBattleId - Current battle ID from new_battle message
     * @returns {Promise<boolean>} True if restored successfully
     */
    async restoreInProgressRun(currentBattleId) {
        // Whose record this is, fixed before the read. `readScoped` builds the
        // key now but the restore happens a storage round trip later, and the
        // feature's own `character_switching` → `cleanup()` cannot cancel a read
        // already running: it zeroes `isTracking` and `currentRun`, and this
        // continuation would set them straight back. The arriving character then
        // finds `checkForActiveDungeon()` returning early on `isTracking`, so
        // they never get their own restore, and the run that eventually
        // completes is written into *their* history with the departing
        // character's start time, wave times and key counts — a clear time they
        // never ran, permanently in the chart and the ROI board.
        const owner = currentOwner();
        const saved = await readScoped(IN_PROGRESS_KEY, 'settings', null, DISCARD_LEGACY);
        if (currentOwner() !== owner) return false;

        if (!saved) {
            return false; // No saved state
        }

        if (!this.canRestoreRecord(saved, currentBattleId)) {
            await this.clearInProgressRun();
            return false;
        }

        // Verify the saved dungeon is the action actually *running*. The queue is
        // insertion order, so "the first unfinished dungeon in the array" can be
        // one merely queued behind the fight in progress — restoring on that
        // resurrects a finished run, or attributes this fight to a dungeon the
        // character has not entered.
        const running = runningCombatAction(dataManager.getCurrentActions());

        if (!running || !this.isDungeonAction(running.actionHrid) || running.actionHrid !== saved.dungeonHrid) {
            await this.clearInProgressRun();
            return false;
        }

        // Restore state
        this.isTracking = true;
        this.restoredMidRun = true;
        // The page-load arm has served its purpose, and `startDungeon` disarms the
        // same way. Left set, a wave-1 resend that carries no battleId reads as a
        // fresh start (see the `sameBattle || !this.pendingDungeonInfo` guard in
        // onNewBattle) and restarts the run this call just picked back up.
        this.pendingDungeonInfo = null;
        this.currentBattleId = saved.battleId;
        this.waveTimes = saved.waveTimes || [];
        this.waveStartTime = saved.waveStartTime ? new Date(saved.waveStartTime) : null;
        this.lastWaveEndTime = saved.lastWaveEndTime ?? null;

        // Restore timestamp tracking fields
        this.firstKeyCountTimestamp = saved.firstKeyCountTimestamp || null;
        this.lastKeyCountTimestamp = saved.lastKeyCountTimestamp || null;
        this.battleStartedTimestamp = saved.battleStartedTimestamp || null;
        this.keyCountMessages = saved.keyCountMessages || [];

        // Restore hibernation detection flag
        this.hibernationDetected = saved.hibernationDetected || false;

        // See the page-load restore: a restored record keeps whatever it was, and
        // a record of a run that started at wave 1 is not partial.
        this.joinedMidRun = saved.joinedMidRun === true;

        this.currentRun = {
            dungeonHrid: saved.dungeonHrid,
            tier: saved.tier,
            startTime: saved.startTime,
            currentWave: saved.currentWave,
            maxWaves: saved.maxWaves,
            wavesCompleted: saved.wavesCompleted,
            keyCountsMap: saved.keyCountsMap || {},
            hibernationDetected: saved.hibernationDetected || false,
            joinedMidRun: saved.joinedMidRun === true,
            joinedAtWave: saved.joinedAtWave ?? null,
            startRecovered: saved.startRecovered === true,
            recoveredStartTime: saved.recoveredStartTime ?? null,
            partyNames: Array.isArray(saved.partyNames) ? [...saved.partyNames] : null,
        };

        this.notifyUpdate();
        return true;
    }

    /**
     * Clear saved in-progress run from IndexedDB
     * @returns {Promise<boolean>} Success status
     */
    async clearInProgressRun() {
        return storage.delete(characterKey(IN_PROGRESS_KEY), 'settings');
    }

    /**
     * Initialize dungeon tracker
     */
    async initialize() {
        // Guard FIRST
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // Get character ID from URL for data isolation
        this.characterId = this.getCharacterIdFromURL();

        // Create and store handler references for cleanup
        this.handlers.newBattle = (data) => this.onNewBattle(data);
        this.handlers.actionCompleted = (data) => this.onActionCompleted(data);
        this.handlers.actionsUpdated = (data) => this.onActionsUpdated(data);
        this.handlers.chatMessage = (data) => this.onChatMessage(data);

        // Listen for new_battle messages (wave start)
        webSocketHook.on('new_battle', this.handlers.newBattle);

        // Listen for action_completed messages (wave complete)
        webSocketHook.on('action_completed', this.handlers.actionCompleted);

        // Listen for actions_updated to detect flee/cancel
        webSocketHook.on('actions_updated', this.handlers.actionsUpdated);

        // Listen for party chat messages (for server-validated duration and battle started)
        webSocketHook.on('chat_message_received', this.handlers.chatMessage);

        // Setup hibernation detection using Visibility API
        this.setupHibernationDetection();

        // Check for active dungeon on page load and try to restore state
        const checkTimeout = setTimeout(() => this.checkForActiveDungeon(), 1000);
        this.timerRegistry.registerTimeout(checkTimeout);

        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
        }
        this.characterSwitchingHandler = () => this.cleanup();
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Setup hibernation detection using Visibility API
     * Detects when computer sleeps/wakes to flag elapsed time as potentially inaccurate
     */
    setupHibernationDetection() {
        let wasHidden = false;

        this.visibilityHandler = () => {
            if (document.hidden) {
                // Tab hidden or computer going to sleep
                wasHidden = true;
            } else if (wasHidden && this.isTracking) {
                // Tab visible again after being hidden during active run
                // Mark hibernation detected (elapsed time may be wrong)
                this.hibernationDetected = true;
                if (this.currentRun) {
                    this.currentRun.hibernationDetected = true;
                }
                this.notifyUpdate();
                this.saveInProgressRun(); // Persist flag to IndexedDB
                wasHidden = false;
            }
        };

        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    /**
     * Note the dungeon the character is running on page load, without restoring anything.
     *
     * Page load has no battle identity to check a saved record against: `battleId`
     * only ever arrives on a live `new_battle`. Matching on `dungeonHrid` alone was
     * not enough, because a repeating dungeon action keeps its hrid across run
     * boundaries — a reconnect or a hibernation blip shorter than the record's
     * ten-minute staleness bound, but longer than a ~35s wave, lands on a *new*
     * battle under the same hrid with the old run's record still reading fresh. The
     * old run's waves, wave times and key-count anchor were then grafted onto it,
     * and the pair of a pre-gap anchor with a post-gap completion banked as a
     * "validated" run of arbitrary length.
     *
     * So restoration is deferred, always, to the one path that can verify identity:
     * the next `new_battle` routes `!isTracking` through
     * `restoreInProgressRun(battleId)`, which checks the battle, the running action
     * and freshness before promoting the record, and clears it when it does not
     * match. The record is left untouched here for that check to read; nothing is
     * banked, timed or written in the meantime, and every handler that could touch
     * a run (`onKeyCountsMessage`, `onActionCompleted`, `onBattleEnded`,
     * `completeDungeon`, `scanExistingChatMessages` and through it
     * `recoverPartyStart`) already stands down while `isTracking` is false.
     *
     * The cost is the deferral window — at most one wave — during which the panel
     * shows `getPendingDungeon()`'s provisional card rather than the run.
     */
    checkForActiveDungeon() {
        // Check if already tracking (shouldn't be, but just in case)
        if (this.isTracking) {
            return;
        }

        // The dungeon the character is *running*, not the first one sitting in the
        // queue: a dungeon queued behind a normal zone (or behind another dungeon)
        // is not in progress, and arming on it starts a run that never began and
        // times it against somebody else's battles.
        const dungeonAction = runningCombatAction(dataManager.getCurrentActions());

        if (!dungeonAction || !this.isDungeonAction(dungeonAction.actionHrid)) {
            return;
        }

        this.pendingDungeonInfo = {
            dungeonHrid: dungeonAction.actionHrid,
            tier: dungeonAction.difficultyTier,
        };
        // A display-only announcement: no run, no start time, nothing written.
        // Waves run ~35s, so without this the panel is blank until the next one.
        this.notifyUpdate();
    }

    /**
     * Scan existing chat messages for "Battle started" and "Key counts" (in case we joined mid-dungeon)
     */
    scanExistingChatMessages() {
        if (!this.isTracking) {
            return;
        }

        try {
            let latestKeyCountsMap = null;
            let latestTimestamp = null;

            // FIRST: Try to find messages in memory (most reliable)
            if (this.recentChatMessages.length > 0) {
                for (const message of this.recentChatMessages) {
                    // Look for "Battle started" messages
                    if (message.m === 'systemChatMessage.partyBattleStarted') {
                        const timestamp = new Date(message.t).getTime();
                        this.battleStartedTimestamp = timestamp;
                    }

                    // Look for "Key counts" messages
                    if (message.m === 'systemChatMessage.partyKeyCount') {
                        const timestamp = new Date(message.t).getTime();

                        // Parse key counts from systemMetadata
                        try {
                            const metadata = JSON.parse(message.systemMetadata || '{}');
                            const keyCountString = metadata.keyCountString || '';
                            const keyCountsMap = this.parseKeyCountsFromMessage(keyCountString);

                            if (Object.keys(keyCountsMap).length > 0) {
                                latestKeyCountsMap = keyCountsMap;
                                latestTimestamp = timestamp;
                            }
                        } catch (error) {
                            console.warn('[Dungeon Tracker] Failed to parse Key counts from message history:', error);
                        }
                    }
                }
            }

            // FALLBACK: If no messages in memory, scan DOM (for messages that arrived before script loaded)
            if (!latestKeyCountsMap) {
                const messages = document.querySelectorAll('[class*="ChatMessage_chatMessage"]');

                // Scan all messages to find Battle started and most recent key counts
                for (const msg of messages) {
                    const text = msg.textContent || '';

                    // FILTER: Skip player messages
                    // Player messages carry the sender's name element; system messages
                    // carry only a timestamp. The game renamed ChatMessage_username to
                    // ChatMessage_name (with a CharacterName_* element inside) — match
                    // all spellings so the filter survives either direction.
                    const hasUsername =
                        msg.querySelector(
                            '[class*="ChatMessage_username"], [class*="ChatMessage_name"], [class*="CharacterName_"]'
                        ) !== null;
                    if (hasUsername) {
                        continue; // Skip player messages
                    }

                    // FALLBACK: Check if text starts with non-timestamp text followed by colon
                    if (/^[^[]+:/.test(text)) {
                        continue; // Skip player messages
                    }

                    // Look for "Battle started:" messages
                    if (text.includes(DUNGEON_BATTLE_STARTED)) {
                        // Try to extract timestamp
                        // Try to extract timestamp from message display format: [MM/DD HH:MM:SS AM/PM] or [DD-M HH:MM:SS]
                        const timestampMatch = text.match(
                            /\[(\d{1,2})([-/])(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\]/
                        );

                        const timestamp = timestampMatch && stampFromMatch(timestampMatch);
                        if (timestamp) {
                            this.battleStartedTimestamp = timestamp.getTime();
                        }
                    }

                    // Look for "Key counts:" messages
                    if (text.includes(DUNGEON_KEY_COUNTS)) {
                        // Parse the message
                        const keyCountsMap = this.parseKeyCountsFromMessage(text);

                        if (Object.keys(keyCountsMap).length > 0) {
                            // Try to extract timestamp from message display format:
                            // [MM/DD HH:MM:SS AM/PM], [DD-M HH:MM:SS], or [D.M. HH:MM:SS]
                            const timestampMatch = text.match(
                                /\[(\d{1,2})([-/.])(\d{1,2})\.?\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\]/
                            );

                            const timestamp = timestampMatch && stampFromMatch(timestampMatch);
                            if (timestamp) {
                                // Keep this as the latest (will be overwritten if we find a newer one)
                                latestKeyCountsMap = keyCountsMap;
                                latestTimestamp = timestamp.getTime();
                            } else {
                                console.warn(
                                    '[Dungeon Tracker] Found Key counts but could not parse timestamp from:',
                                    text.substring(0, 50)
                                );
                                latestKeyCountsMap = keyCountsMap;
                            }
                        }
                    }
                }
            }

            // Update current run with the most recent key counts found
            if (latestKeyCountsMap && this.currentRun) {
                this.currentRun.keyCountsMap = latestKeyCountsMap;

                // The counts and the stamp fail independently: a DOM line whose
                // `[MM/DD ...]` prefix does not match leaves the map set and the stamp
                // null, and an in-memory message with an unreadable `t` leaves it NaN.
                // Neither may be written to the anchor. `null` is the sentinel a later
                // scan and `missedItsOwnStart` both test with `=== null`, and NaN
                // survives that test while failing every comparison after it, so a
                // NaN anchor silently stops the run banking at all.
                //
                // With no usable stamp the run carries no anchor: the next key count
                // is read as the completion against `currentRun.startTime` by
                // `onKeyCountsMessage`'s `missedItsOwnStart` fallback. No stamp is
                // synthesised here — `battleStartedTimestamp` marks the queue's first
                // battle, which in a queue of twenty runs is nineteen runs early, and
                // `Date.now()` is not when a message already on screen was drawn.
                const anchor = Number.isFinite(latestTimestamp) ? latestTimestamp : null;

                if (this.firstKeyCountTimestamp === null && anchor !== null) {
                    this.firstKeyCountTimestamp = anchor;
                    this.lastKeyCountTimestamp = anchor;

                    // Store this message for history
                    this.keyCountMessages.push({
                        timestamp: anchor,
                        keyCountsMap: latestKeyCountsMap,
                        text:
                            `${DUNGEON_KEY_COUNTS} ` +
                            Object.entries(latestKeyCountsMap)
                                .map(([name, count]) => `[${name} - ${count}]`)
                                .join(', '),
                    });
                }

                // A run picked up part-way through has no start of its own, but
                // in a party the anchor just found is the server's own timestamp
                // for one — see recoverPartyStart for when it may be believed.
                if (this.joinedMidRun && this.firstKeyCountTimestamp && !this.currentRun.startRecovered) {
                    this.recoverPartyStart();
                }

                this.notifyUpdate();
                this.saveInProgressRun(); // Persist to IndexedDB
            } else if (!this.currentRun) {
                console.warn('[Dungeon Tracker] Current run is null, cannot update');
            }
        } catch (error) {
            console.error('[Dungeon Tracker] Error scanning existing messages:', error);
        }
    }

    /**
     * Recover a partial party run's true start from the chat anchor.
     *
     * The anchor is a "Key counts" timestamp, not "Battle started": key counts
     * are what every banked party duration is already measured between, and in
     * a repeating dungeon the same key-count message ends one run and begins the
     * next (see `pendingNextRunFirstKeyCount`), so it marks a *run* boundary.
     * "Battle started" marks the party's combat action beginning, which in a
     * queue of twenty runs fires once, twenty runs ago.
     *
     * The newest key count in chat is normally this run's start — but not always,
     * so two history-derived checks stand in front of it (`assessRecoveredStart`).
     * When either refuses, nothing here changes: the run stays partial, shows
     * "Watched:", and is not banked, exactly as before this method existed.
     *
     * @returns {Promise<boolean>} True when the start was recovered
     */
    async recoverPartyStart() {
        const run = this.currentRun;
        if (!run || !this.joinedMidRun || run.startRecovered) {
            return false;
        }

        const anchor = this.firstKeyCountTimestamp;
        if (!anchor) {
            return false;
        }

        // Identity captured before the storage read and verified after it: a
        // character switch mid-await would otherwise stamp this character's run
        // with a verdict reached against somebody else's history, and write the
        // recovery onto whatever run has replaced it.
        const owner = currentOwner();
        const dungeonHrid = run.dungeonHrid;
        const dungeonName = dungeonTrackerStorage.getDungeonInfo(dungeonHrid)?.name ?? null;

        let runs = [];
        try {
            runs = (await dungeonTrackerStorage.getRunsForCharacter?.('mine')) || [];
        } catch (error) {
            console.warn('[Dungeon Tracker] Could not read history to check a recovered start:', error);
            return false;
        }

        if (currentOwner() !== owner) return false;
        if (this.currentRun !== run || !this.isTracking) return false;
        if (this.firstKeyCountTimestamp !== anchor) return false;

        const verdict = assessRecoveredStart({
            impliedElapsedMs: Date.now() - anchor,
            currentWave: run.currentWave,
            maxWaves: run.maxWaves,
            runs,
            dungeonName,
            tier: run.tier,
        });

        if (!verdict.credible) {
            console.info('[Dungeon Tracker] Chat anchor rejected as this run’s start:', verdict.reason);
            return false;
        }

        run.startRecovered = true;
        run.recoveredStartTime = anchor;
        this.notifyUpdate();
        this.saveInProgressRun();
        return true;
    }

    /**
     * Handle actions_updated message (detect flee/cancel and dungeon start)
     * @param {Object} data - actions_updated message data
     */
    onActionsUpdated(data) {
        // The action the game is actually running, by execution order. dataManager
        // folds `endCharacterActions` into its queue before emitting, so this is
        // already the post-update queue. Merely *queueing* a dungeon must not arm
        // the tracker: a dungeon added at position 2 while the character fights a
        // normal zone used to start a run there and then, timing it against the
        // zone's battles and showing the queued copy's tier.
        const runningNow = runningCombatAction(dataManager.getCurrentActions?.());

        // Disarm a pending dungeon the character is no longer running. Nothing
        // else does: `startDungeon` and `resetTracking` both clear it, but both
        // need a run, and the page-load provisional card is armed with no run
        // behind it. Cancel that dungeon and the panel went on naming it —
        // "waiting for next wave" — for the rest of the session.
        if (this.pendingDungeonInfo && runningNow?.actionHrid !== this.pendingDungeonInfo.dungeonHrid) {
            this.pendingDungeonInfo = null;
            this.notifyUpdate();
        }

        // Check if any dungeon action was added or removed
        if (data.endCharacterActions) {
            for (const action of data.endCharacterActions) {
                // Check if this is a dungeon action using explicit verification
                if (this.isDungeonAction(action.actionHrid)) {
                    if (action.isDone === false) {
                        // Only the running dungeon arms tracking, and it arms with its
                        // own tier — a second queued copy of the same dungeon at another
                        // tier must not overwrite it.
                        if (!runningNow || runningNow.actionHrid !== action.actionHrid) {
                            continue;
                        }

                        // Dungeon action is running - store info for when new_battle fires
                        this.pendingDungeonInfo = {
                            dungeonHrid: runningNow.actionHrid,
                            tier: runningNow.difficultyTier,
                        };

                        // If already tracking (somehow), update immediately
                        if (this.isTracking && this.currentRun && !this.currentRun.dungeonHrid) {
                            this.currentRun.dungeonHrid = runningNow.actionHrid;
                            this.currentRun.tier = runningNow.difficultyTier;

                            const dungeonInfo = dungeonTrackerStorage.getDungeonInfo(action.actionHrid);
                            if (dungeonInfo) {
                                this.currentRun.maxWaves = dungeonInfo.maxWaves;
                                this.notifyUpdate();
                            }
                        }
                    } else if (action.isDone === true && this.isTracking && this.currentRun) {
                        // Dungeon action marked as done (completion or flee).
                        // A *different* dungeon finishing or being dropped from the
                        // queue says nothing about the run in progress; ending on it
                        // would throw away a live run's waves and timings.
                        if (this.currentRun.dungeonHrid && this.currentRun.dungeonHrid !== action.actionHrid) {
                            continue;
                        }

                        // If we don't have dungeon info yet, grab it from this action
                        if (!this.currentRun.dungeonHrid) {
                            this.currentRun.dungeonHrid = action.actionHrid;
                            this.currentRun.tier = action.difficultyTier;

                            const dungeonInfo = dungeonTrackerStorage.getDungeonInfo(action.actionHrid);
                            if (dungeonInfo) {
                                this.currentRun.maxWaves = dungeonInfo.maxWaves;
                                // Update UI with the name before resetting
                                this.notifyUpdate();
                            }
                        }

                        // Check if this was a successful completion or early exit
                        const allWavesCompleted =
                            this.currentRun.maxWaves && this.currentRun.wavesCompleted >= this.currentRun.maxWaves;

                        if (!allWavesCompleted) {
                            // Early exit (fled, died, or failed)
                            this.resetTracking();
                        }
                        // If it was a successful completion, action_completed will handle it
                        return;
                    }
                }
            }
        }
    }

    /**
     * Handle chat_message_received (parse Key counts messages, Battle started, and Party failed)
     * @param {Object} data - chat_message_received message data
     */
    onChatMessage(data) {
        // Extract message object
        const message = data.message;
        if (!message) {
            return;
        }

        // Only process party chat messages
        if (message.chan !== '/chat_channel_types/party') {
            return;
        }

        // Store ALL party messages in memory (for reliable timestamp capture)
        this.recentChatMessages.push(message);
        if (this.recentChatMessages.length > 100) {
            this.recentChatMessages.shift(); // Keep last 100 only
        }

        // Only process system messages
        if (!message.isSystemMessage) {
            return;
        }

        // Extract timestamp from message (convert to milliseconds)
        const timestamp = new Date(message.t).getTime();

        // Handle "Battle started" messages
        if (message.m === 'systemChatMessage.partyBattleStarted') {
            this.onBattleStarted(timestamp, message);
            return;
        }

        // Handle "Party failed" messages
        if (message.m === 'systemChatMessage.partyFailed') {
            this.onPartyFailed(timestamp, message);
            return;
        }

        // Handle "Key counts" messages
        if (message.m === 'systemChatMessage.partyKeyCount') {
            this.onKeyCountsMessage(timestamp, message);
            return;
        }

        // Handle "Battle ended" messages — the game's word for a start that was
        // canceled or a fight that was fled, never for a completed run. Matched
        // by suffix rather than the exact key, which no capture has pinned down
        if (typeof message.m === 'string' && /battleended/i.test(message.m)) {
            this.onBattleEnded(timestamp);
        }
    }

    /**
     * Handle a "Battle ended" message.
     *
     * The phantom this closes: a ready-check that fails posts "Key counts" and
     * then "Battle ended" a second later. Nothing consumed the ended message,
     * so the canceled start stayed armed as a run's beginning, and the *next*
     * key count — however much party-forming idle later — read as its
     * completion. One recorded 15:47 "run" was two canceled starts with a
     * member swap in between; its party had not assembled at its supposed start.
     *
     * Only a run with no wave completed is reset here: that is what a canceled
     * start looks like. A fight fled mid-run is the action feed's business, and
     * a successful completion has already been recorded by the time this could
     * fire — `isTracking` is false and this returns without touching it.
     *
     * @param {number} _timestamp - Message timestamp in milliseconds
     */
    onBattleEnded(_timestamp) {
        if (!this.isTracking || !this.currentRun) {
            return;
        }
        if (this.currentRun.wavesCompleted > 0) {
            return;
        }
        this.resetTracking();
    }

    /**
     * Handle "Battle started" message
     * @param {number} timestamp - Message timestamp in milliseconds
     * @param {Object} message - Message object
     */
    onBattleStarted(timestamp, message) {
        // Store battle started timestamp
        this.battleStartedTimestamp = timestamp;

        // If tracking and dungeonHrid is set, check if this is a different dungeon
        if (this.isTracking && this.currentRun && this.currentRun.dungeonHrid) {
            // Parse dungeon name from message to detect dungeon switching
            try {
                const metadata = JSON.parse(message.systemMetadata || '{}');
                const battleName = metadata.name || '';

                // Extract dungeon HRID from battle name (this is a heuristic)
                const currentDungeonName =
                    dungeonTrackerStorage.getDungeonInfo(this.currentRun.dungeonHrid)?.name || '';

                if (battleName && currentDungeonName && !battleName.includes(currentDungeonName)) {
                    this.resetTracking();
                }
            } catch (error) {
                console.error('[Dungeon Tracker] Error parsing battle started metadata:', error);
            }
        }
    }

    /**
     * Handle "Party failed" message
     * @param {number} _timestamp - Message timestamp in milliseconds
     * @param {Object} _message - Message object
     */
    onPartyFailed(_timestamp, _message) {
        if (!this.isTracking || !this.currentRun) {
            return;
        }

        // Mark run as failed and reset tracking
        this.resetTracking();
    }

    /**
     * Handle "Key counts" message
     * @param {number} timestamp - Message timestamp in milliseconds
     * @param {Object} message - Message object
     */
    onKeyCountsMessage(timestamp, message) {
        // Parse systemMetadata JSON to get keyCountString
        let keyCountString = '';
        try {
            const metadata = JSON.parse(message.systemMetadata);
            keyCountString = metadata.keyCountString || '';
        } catch (error) {
            console.error('[Dungeon Tracker] Failed to parse systemMetadata:', error);
            return;
        }

        // Parse key counts from the string
        const keyCountsMap = this.parseKeyCountsFromMessage(keyCountString);

        // If not tracking, ignore (probably from someone else's dungeon)
        if (!this.isTracking) {
            return;
        }

        // If we already have a lastKeyCountTimestamp, this is the COMPLETION message
        // (The first message sets both first and last to the same value)
        if (this.lastKeyCountTimestamp !== null && timestamp > this.lastKeyCountTimestamp) {
            // Update last timestamp for duration calculation
            this.lastKeyCountTimestamp = timestamp;

            // Update key counts
            if (this.currentRun) {
                this.currentRun.keyCountsMap = keyCountsMap;
            }

            // Store completion message
            this.keyCountMessages.push({
                timestamp,
                keyCountsMap,
                text: keyCountString,
            });

            // Complete the dungeon
            this.completeDungeon({ fromKeyCountMessage: true });
            return;
        }

        // First "Key counts" message = dungeon start
        if (this.firstKeyCountTimestamp === null) {
            // FALLBACK: a run that never saw its own start message reads this one as the
            // COMPLETION, using currentRun.startTime as the best estimate of the start.
            //
            // That is only true of a run picked back up from storage, or one already part
            // way through its waves. A run started here has startTime set and no anchor
            // yet too, and its start message often arrives before the 100 ms chat scan —
            // reading that as the completion would end the run it was meant to begin.
            const missedItsOwnStart = this.restoredMidRun || this.currentRun?.wavesCompleted > 0;

            if (this.currentRun && this.currentRun.startTime && missedItsOwnStart) {
                // Use the currentRun.startTime as the first timestamp (best estimate)
                this.firstKeyCountTimestamp = this.currentRun.startTime;
                this.lastKeyCountTimestamp = timestamp; // Current message is completion

                // Update key counts
                if (this.currentRun) {
                    this.currentRun.keyCountsMap = keyCountsMap;
                }

                // Store completion message
                this.keyCountMessages.push({
                    timestamp,
                    keyCountsMap,
                    text: keyCountString,
                });

                // Complete the dungeon
                this.completeDungeon({ fromKeyCountMessage: true });
                return;
            }

            // Normal case: This is actually the first message
            this.firstKeyCountTimestamp = timestamp;
            this.lastKeyCountTimestamp = timestamp; // Set both to same value initially
        }

        // Update current run with latest key counts
        if (this.currentRun) {
            this.currentRun.keyCountsMap = keyCountsMap;
            this.notifyUpdate(); // Trigger UI update with new key counts
            this.saveInProgressRun(); // Persist to IndexedDB
        }

        // Store message data for history
        this.keyCountMessages.push({
            timestamp,
            keyCountsMap,
            text: keyCountString,
        });
    }

    /**
     * Parse key counts from message text
     * @param {string} messageText - Message text containing key counts
     * @returns {Object} Map of player names to key counts
     */
    parseKeyCountsFromMessage(messageText) {
        const keyCountsMap = {};

        // Regex to match [PlayerName - KeyCount] pattern (with optional grouping
        // separators, whatever the game's current locale uses).
        // The name may itself contain a dash ("[Moo-Deng - 12]"): the count is anchored to
        // the closing bracket and the name is lazy, so the LAST " - <digits>]" separates
        // them. Brackets still bound the name, which keeps a display timestamp
        // ("[08/04 10:00:00 AM]") from being read as a player.
        //
        // Digits only, no decimal — a key count is always a whole number — and
        // built fresh from gameDigitsSource rather than a hardcoded `[\d,]+`,
        // which only recognises comma grouping: in a period-grouping locale it
        // stops at the first group boundary, so the whole bracket fails to
        // match at all (no closing "]" right after the truncated digit run) and
        // the player's name is lost along with the count.
        const regex = new RegExp(`\\[([^[\\]]+?)\\s*-\\s*(${gameDigitsSource({ decimal: false })})\\]`, 'g');
        let match;

        while ((match = regex.exec(messageText)) !== null) {
            const playerName = match[1].trim();
            const keyCount = Math.trunc(parseGameNumber(match[2]));
            keyCountsMap[playerName] = keyCount;
        }

        return keyCountsMap;
    }

    /**
     * Calculate server-validated duration from party messages
     * @returns {number|null} Duration in milliseconds, or null if no messages
     */
    getPartyMessageDuration() {
        if (!this.firstKeyCountTimestamp || !this.lastKeyCountTimestamp) {
            return null;
        }

        // Duration = last message - first message
        return this.lastKeyCountTimestamp - this.firstKeyCountTimestamp;
    }

    /**
     * Handle new_battle message (wave start)
     * @param {Object} data - new_battle message data
     */
    async onNewBattle(data) {
        // Only track if we have wave data
        if (data.wave === undefined) {
            return;
        }

        // Capture battleId for persistence
        const battleId = data.battleId;

        // This message describes the fight of whoever is logged in right now.
        // Both branches below cross an await before calling `startDungeon`, and
        // `startDungeon` sets `isTracking`, `currentRun` and `waveStartTime`
        // from this data — so a switch inside either await used to start the
        // departing character's dungeon on the arriving one. That run is then
        // saved under the arriving character's key, blocks their own
        // `checkForActiveDungeon()` (it returns early on `isTracking`), and on
        // completion lands in their history as a run they never made.
        const owner = currentOwner();

        // The dungeon the game is actually running. Nothing between startDungeon
        // and completeDungeon used to ask whether it was still the one under the
        // run, so a switch left the run's identity on the dungeon that had been
        // left behind while its wave number came from the one now running: the
        // panel read "Chimerical Den (T0), Wave 61/50" during Pirate Cove wave 61
        // of 65. The old escape hatch was accidental — a dungeon leaving the
        // queue reset tracking, and the next battle restarted it correctly — and
        // it went away with the (correct) guard that stops a *different* dungeon
        // going done from destroying a live run.
        const running = runningCombatAction(dataManager.getCurrentActions?.());
        if (
            this.isTracking &&
            this.currentRun?.dungeonHrid &&
            running &&
            this.isDungeonAction(running.actionHrid) &&
            running.actionHrid !== this.currentRun.dungeonHrid
        ) {
            // The abandoned run was interrupted, not completed. resetTracking is
            // the same discard the flee/death early-exit path uses: it drops the
            // run without writing it to history (a half-length run would poison
            // the averages and the ROI board) and clears the saved record.
            await this.resetTracking();
            if (currentOwner() !== owner) return;
            this.startDungeon(data);
            return;
        }

        // Wave 1 = first wave = dungeon start. The game's waves are 1-based —
        // verified against every recorded wave across all four dungeons, whose
        // minimum is 1 and whose maximum is each dungeon's own maxWaves — so the
        // `wave === 0` this used to test never arrived and the whole branch was
        // dead code. (`action_completed` is the one place a 0 does show up: the
        // final wave's completion carries wave: 0, handled in onActionCompleted.)
        if (data.wave === 1) {
            // `new_battle` has no dedupe or replay guard (see websocket.js's
            // SKIP_DEDUP_TYPES), so a reconnect that catches the run still on
            // its own first wave resends this same wave 1 rather than a real
            // dungeon start. Already tracking, with no new dungeon queued by
            // actions_updated, means this is that resend — treat it like any
            // other wave update instead of wiping wavesCompleted, waveTimes
            // and the party-message timestamps and starting the run over.
            //
            // The battle id settles it outright where the message carries one:
            // the same battle resent is the same battle, and a genuinely new
            // run is a new one. `pendingDungeonInfo` alone is not enough,
            // because `endCharacterActions` carries existing actions alongside
            // new ones — any queue edit during wave 1 re-arms it for the
            // dungeon already being tracked, and the resend then reads as a
            // start.
            const sameBattle = data.battleId !== undefined && data.battleId === this.currentBattleId;
            if (this.isTracking && (sameBattle || !this.pendingDungeonInfo)) {
                this.currentBattleId = data.battleId;
                this.startWave(data);
                return;
            }

            if (!this.isTracking) {
                // A reload or reconnect can land on wave 1 with the run's own
                // record still saved; restoring keeps its key-count anchor and
                // wave times. restoreInProgressRun matches on battleId and on the
                // running action, and clears the record itself when it does not
                // match — so a genuinely new run falls through to a fresh start.
                const restored = await this.restoreInProgressRun(battleId);
                if (currentOwner() !== owner) return;
                if (restored) {
                    this.learnPartyNames(data);
                    return;
                }
            } else {
                // Clear any stale saved state first (in case previous run didn't clear properly)
                await this.clearInProgressRun();
                if (currentOwner() !== owner) return;
            }

            // Start fresh dungeon
            this.startDungeon(data);
        } else if (!this.isTracking) {
            // Mid-dungeon start - try to restore first
            const restored = await this.restoreInProgressRun(battleId);
            // `restoreInProgressRun` stands itself down on a switch and reports
            // `false`, which reads here as "nothing to restore" — so without
            // this check the guard in the callee would *cause* the departing
            // character's battle to be started on the arriving one
            if (currentOwner() !== owner) return;
            if (!restored) {
                // No restore - initialize tracking anyway
                this.startDungeon(data);
            } else {
                this.learnPartyNames(data);
            }
        } else {
            // Subsequent wave (already tracking)
            // Self-heal a tier a stale pendingDungeonInfo set wrong at the start:
            // the tier cannot change mid-run, so if the running action is this
            // same dungeon at a different tier, the run's tier is the bug. Fixes
            // the live panel and the tier this run is eventually saved under.
            if (
                running &&
                this.currentRun &&
                running.actionHrid === this.currentRun.dungeonHrid &&
                running.difficultyTier !== this.currentRun.tier
            ) {
                this.currentRun.tier = running.difficultyTier;
            }

            // Update battleId in case user logged out and back in (new battle instance)
            this.currentBattleId = data.battleId;
            this.startWave(data);
        }
    }

    /**
     * Start tracking a new dungeon run
     * @param {Object} data - new_battle message data
     */
    startDungeon(data) {
        // Get dungeon info - prioritize pending info from actions_updated
        let dungeonHrid = null;
        let tier = null;
        let maxWaves = null;

        // The action actually running is the authoritative source of the tier.
        // pendingDungeonInfo (from an actions_updated loop) and a first-in-array
        // find() both captured the wrong tier when the queue held more than one
        // copy of the same dungeon — a T2 run with a T0 copy queued behind it
        // showed the panel as T0 while the game fought T2. runningCombatAction
        // picks the lowest-ordinal unfinished combat action, which is the one
        // being run.
        //
        // It is equally authoritative about *whether* a dungeon is running at all.
        // When the running action is a normal zone, this battle is that zone's, and
        // any dungeon in the queue is merely waiting its turn — falling through to
        // pendingDungeonInfo here started a Sinister Circus run off a Golem Cave
        // battle and ran its timer against Golem Cave's fights.
        const running = runningCombatAction(dataManager.getCurrentActions());
        if (running) {
            if (!this.isDungeonAction(running.actionHrid)) {
                this.pendingDungeonInfo = null;
                return; // Not in a dungeon - this battle belongs to a normal zone
            }
            dungeonHrid = running.actionHrid;
            tier = running.difficultyTier;
            this.pendingDungeonInfo = null;
        } else if (this.pendingDungeonInfo) {
            // Verify this is actually a dungeon action before starting tracking
            if (!this.isDungeonAction(this.pendingDungeonInfo.dungeonHrid)) {
                console.warn(
                    '[Dungeon Tracker] Attempted to track non-dungeon action:',
                    this.pendingDungeonInfo.dungeonHrid
                );
                this.pendingDungeonInfo = null;
                return; // Don't start tracking
            }

            // Use info from actions_updated message
            dungeonHrid = this.pendingDungeonInfo.dungeonHrid;
            tier = this.pendingDungeonInfo.tier;

            // Clear pending info
            this.pendingDungeonInfo = null;
        }

        if (dungeonHrid) {
            const dungeonInfo = dungeonTrackerStorage.getDungeonInfo(dungeonHrid);
            if (dungeonInfo) {
                maxWaves = dungeonInfo.maxWaves;
            }
        }

        // Don't start tracking if we don't have dungeon info (not a dungeon)
        if (!dungeonHrid) {
            return;
        }

        this.isTracking = true;
        this.currentBattleId = data.battleId; // Store battleId for persistence
        // The run starts now. data.combatStartTime is NOT this run's start: it
        // is the combat *action's* start, which in continuous queued combat is
        // when the session's fighting began — hours stale by the time a later
        // run starts. Anchoring the run (and its first wave) to it made wave 1
        // read as hours, swamped the wave average (a −6000% pace), and left a
        // solo run's total (no key-count anchor) as garbage.
        this.waveStartTime = new Date();
        this.lastWaveEndTime = null;
        this.waveTimes = [];

        // Reset party message tracking
        // If a completion just happened, carry its timestamp forward as this run's start.
        // scanExistingChatMessages will see firstKeyCountTimestamp already set and skip the scan.
        if (this.pendingNextRunFirstKeyCount !== null) {
            this.firstKeyCountTimestamp = this.pendingNextRunFirstKeyCount;
            this.lastKeyCountTimestamp = this.pendingNextRunFirstKeyCount;
            this.pendingNextRunFirstKeyCount = null;
        } else {
            this.firstKeyCountTimestamp = null;
            this.lastKeyCountTimestamp = null;
        }
        this.keyCountMessages = [];

        // Reset hibernation detection for new run
        this.hibernationDetected = false;

        // Waves are 1-based, so anything above 1 means the run was already under
        // way when tracking began — a refresh mid-dungeon is the usual cause.
        // `startTime` above is when we noticed, and at wave 48 of 65 that reads as
        // a 90-second Pirate Cove. The flag keeps that number out of anywhere it
        // would be taken for the run's duration, and keeps the run out of history.
        const joinedMidRun = typeof data.wave === 'number' && data.wave > 1;
        this.joinedMidRun = joinedMidRun;

        this.currentRun = {
            dungeonHrid: dungeonHrid,
            tier: tier,
            startTime: this.waveStartTime.getTime(),
            currentWave: data.wave, // Use actual wave number (1-indexed)
            maxWaves: maxWaves,
            wavesCompleted: 0, // No waves completed yet (will update as waves complete)
            hibernationDetected: false, // Track if computer sleep detected during this run
            joinedMidRun, // No true start time; see above
            joinedAtWave: joinedMidRun ? data.wave : null,
            // The run's composition, straight from the fight. Null until a
            // `new_battle` says; every wave carries one, so a run tracked from
            // wave 1 has it from the start.
            partyNames: battlePartyNames(data),
        };

        this.notifyUpdate();

        // Save initial state to IndexedDB
        this.saveInProgressRun();

        // Scan existing chat messages NOW that we're tracking (key counts message already in chat)
        const scanTimeout = setTimeout(() => this.scanExistingChatMessages(), 100);
        this.timerRegistry.registerTimeout(scanTimeout);
    }

    /**
     * Take the run's composition from a `new_battle` that carries one.
     *
     * A run restored from storage, or one started before a roster arrived, learns
     * it from the next fight. A restore is the case that needs this most: the
     * record may predate `partyNames` entirely, and the message that triggered the
     * restore is holding the roster the record lacks — a run restored onto its
     * last wave would otherwise never see another one, and a solo run that cannot
     * say who was in it is not banked at all.
     *
     * @param {Object} data - `new_battle` message data
     */
    learnPartyNames(data) {
        if (!this.currentRun) return;
        const partyNames = battlePartyNames(data);
        if (partyNames) this.currentRun.partyNames = partyNames;
    }

    /**
     * Start tracking a new wave
     * @param {Object} data - new_battle message data
     */
    startWave(data) {
        if (!this.isTracking) {
            return;
        }

        // Per-wave timing is measured from the client clock, not
        // data.combatStartTime: that field is the combat action's start — the
        // run's start — and is the SAME value on every wave's new_battle, not
        // each wave's own start. Using it made every waveTimes entry the
        // cumulative elapsed since the run began (808s, 819s, 828s, …) instead
        // of a ~10s wave, inflating avgWaveTime ~60× and turning the pace chip
        // and the ETA into nonsense. new_battle arrives at the wave's start, so
        // Date.now() here is that wave's start. (The run anchor still uses
        // combatStartTime in startDungeon, which is correct for run totals.)
        this.waveStartTime = new Date();
        this.currentRun.currentWave = data.wave;
        this.learnPartyNames(data);

        this.notifyUpdate();

        // Save state after each wave start
        this.saveInProgressRun();
    }

    /**
     * Handle action_completed message (wave complete)
     * @param {Object} data - action_completed message data
     */
    onActionCompleted(data) {
        const action = data.endCharacterAction;

        if (!this.isTracking) {
            return;
        }

        // Verify this is a dungeon action
        if (!this.isDungeonAction(action.actionHrid)) {
            return;
        }

        // Ignore non-dungeon combat (zones don't have maxCount or wave field)
        if (action.wave === undefined) {
            return;
        }

        // Set dungeon info if not already set (fallback for mid-dungeon starts)
        if (!this.currentRun.dungeonHrid) {
            this.currentRun.dungeonHrid = action.actionHrid;
            this.currentRun.tier = action.difficultyTier;

            const dungeonInfo = dungeonTrackerStorage.getDungeonInfo(action.actionHrid);
            if (dungeonInfo) {
                this.currentRun.maxWaves = dungeonInfo.maxWaves;
            }

            // Notify update now that we have dungeon name
            this.notifyUpdate();
        }

        // A wave's time is completion-to-completion (the previous wave's end,
        // or the run's start for wave 1), so it is the full cycle — fight plus
        // the respawn gap before it. That is the same measure as a stored
        // run's duration over its wave count, which is what the pace chip and
        // backfilled history compare against; timing only the fight
        // (new_battle→completion) read ~60% "faster" than that for no reason.
        // It also makes the ETA (average × remaining waves) a real finish time.
        // The run's start anchors only a fresh run's first wave. A run restored
        // mid-way with no previous-wave end has missed that wave's start, so its
        // first completion records nothing (as before) rather than a wave that
        // spans the whole gap back to the run's start.
        const waveEndTime = Date.now();
        const noWaveDoneYet = !(this.currentRun.wavesCompleted > 0);
        const waveStart = this.lastWaveEndTime ?? (noWaveDoneYet ? this.currentRun.startTime : null);
        if (Number.isFinite(waveStart)) {
            this.waveTimes.push(waveEndTime - waveStart);
        }
        this.lastWaveEndTime = waveEndTime;

        // Update waves completed
        // BUGFIX: Wave 50 completion sends wave: 0, so use currentWave instead
        const actualWaveNumber = action.wave === 0 ? this.currentRun.currentWave : action.wave;
        this.currentRun.wavesCompleted = actualWaveNumber;

        // Save state after wave completion
        this.saveInProgressRun();

        // Check if dungeon is complete
        if (action.isDone) {
            // Check if this was a successful completion (all waves done) or early exit
            const allWavesCompleted =
                this.currentRun.maxWaves && this.currentRun.wavesCompleted >= this.currentRun.maxWaves;

            if (allWavesCompleted) {
                // Successful completion
                this.completeDungeon();
            } else {
                // Early exit (fled, died, or failed)
                this.resetTracking();
            }
        } else {
            this.notifyUpdate();
        }
    }

    /**
     * Complete the current dungeon run
     * @param {Object} [options] - Completion options
     * @param {boolean} [options.fromKeyCountMessage] - True when a completion "Key counts" message
     *   ended the run, which is the only case where lastKeyCountTimestamp marks the run's END
     */
    async completeDungeon({ fromKeyCountMessage = false } = {}) {
        if (!this.currentRun || !this.isTracking) {
            return;
        }

        // Reset tracking immediately to prevent race condition with next dungeon
        this.isTracking = false;

        // Copy all state to local variables IMMEDIATELY so next dungeon can start clean
        const completedRunData = this.currentRun;
        const completedWaveTimes = [...this.waveTimes];
        const completedKeyCountMessages = [...this.keyCountMessages];
        const firstTimestamp = this.firstKeyCountTimestamp;
        const lastTimestamp = this.lastKeyCountTimestamp;
        // Both read before the awaits below: a character switch in the middle would
        // otherwise stamp this run with the arriving character's name, and read a
        // hibernation flag that has already been reset for somebody else's run.
        const hibernated = this.hibernationDetected === true || completedRunData.hibernationDetected === true;
        const soloName = dataManager.getCurrentCharacterName?.() ?? null;
        // Who ran this. `saveTeamRun` stamps `recordedBy` from whoever is current
        // when it runs, and it runs after `clearInProgressRun`'s storage round
        // trip below — so a switch landing in that gap files this run under the
        // arriving character. `runMatchesCharacter` trusts the stamp absolutely,
        // so the run then never appears for whoever actually ran it, and skews
        // every per-character average, the pace profile and the ROI board of one
        // who was never in it.
        const owner = currentOwner();

        // Carry the completion timestamp forward as the next run's start anchor.
        // This avoids the scanExistingChatMessages race condition where the scan
        // fires before the live message arrives and grabs an older timestamp instead.
        //
        // Only a completion "Key counts" message leaves lastKeyCountTimestamp on the run's
        // END. When the websocket ended the run instead, lastKeyCountTimestamp is still
        // this run's START anchor, and handing that to the next run would measure the two
        // of them as one long run.
        const endedOnItsOwnKeyCount = fromKeyCountMessage && lastTimestamp !== null && lastTimestamp > firstTimestamp;
        this.pendingNextRunFirstKeyCount = endedOnItsOwnKeyCount ? lastTimestamp : null;

        // Clear ALL state immediately - next dungeon can now start without contamination
        this.currentRun = null;
        this.waveStartTime = null;
        this.lastWaveEndTime = null;
        this.waveTimes = [];
        this.firstKeyCountTimestamp = null;
        this.lastKeyCountTimestamp = null;
        this.keyCountMessages = [];
        this.currentBattleId = null;
        this.restoredMidRun = false;
        this.joinedMidRun = false;

        // Guard: mark completion time synchronously so restoreInProgressRun() rejects stale reads
        this._lastCompletionTime = Date.now();

        // Clear saved in-progress state (async - may not complete before next restore attempt)
        await this.clearInProgressRun();
        // The state above is already this run's own copy, but everything below
        // writes: to history under the current character, and to a panel that
        // now belongs to somebody else. Neither is this run's to touch any more.
        if (currentOwner() !== owner) {
            return;
        }

        const endTime = Date.now();

        // A run joined part-way through has no start to measure from. Its
        // `startTime` is when tracking noticed it, and in a party the key-count
        // fallback in onChatMessage anchors `firstKeyCountTimestamp` on that same
        // fiction — so *both* candidate durations are the length of the tail we
        // happened to watch, not the run. Reporting either would put a 90-second
        // Pirate Cove in front of the user and, in a party, into history.
        //
        // Unless the party's chat gave the start back (`recoverPartyStart`): the
        // server-timestamped key count that opened the run is a better start than
        // a whole run watched on the wall clock, so such a run is timed, banked
        // and validated like any other party run. Its *tracked* duration stays
        // null — we still only wall-clocked the tail.
        const joinedMidRun = completedRunData.joinedMidRun === true;
        const startRecovered = completedRunData.startRecovered === true;
        const unrecoveredPartial = joinedMidRun && !startRecovered;
        const trackedTotalTime = joinedMidRun ? null : endTime - completedRunData.startTime;

        // Get server-validated duration from party messages
        // Require a strictly later completion timestamp: first === last means only the
        // run-start key count was seen (no completion message), not a real 0ms run
        const partyMessageDuration =
            !unrecoveredPartial && firstTimestamp && lastTimestamp && lastTimestamp > firstTimestamp
                ? lastTimestamp - firstTimestamp
                : null;
        const validated = partyMessageDuration !== null;

        // Use party message duration if available (authoritative), otherwise use tracked duration
        const totalTime = validated ? partyMessageDuration : trackedTotalTime;

        // Calculate statistics (wave times can be empty when completion came from a chat message)
        const hasWaveTimes = completedWaveTimes.length > 0;
        const avgWaveTime = hasWaveTimes
            ? completedWaveTimes.reduce((sum, time) => sum + time, 0) / completedWaveTimes.length
            : 0;
        const fastestWave = hasWaveTimes ? Math.min(...completedWaveTimes) : 0;
        const slowestWave = hasWaveTimes ? Math.max(...completedWaveTimes) : 0;

        // Build complete run object
        const completedRun = {
            dungeonHrid: completedRunData.dungeonHrid,
            tier: completedRunData.tier,
            startTime: completedRunData.startTime,
            endTime,
            totalTime, // Authoritative duration (party message or tracked)
            trackedDuration: trackedTotalTime, // Wall-clock tracked duration
            partyMessageDuration, // Server-validated duration (null if solo)
            validated, // true if party messages available
            avgWaveTime,
            fastestWave,
            slowestWave,
            wavesCompleted: completedRunData.wavesCompleted,
            waveTimes: completedWaveTimes,
            keyCountMessages: completedKeyCountMessages, // Store key data for history
            keyCountsMap: completedRunData.keyCountsMap, // Include for backward compatibility
            joinedMidRun, // Run was already under way when tracking began; durations are null
            startRecovered, // ...unless its start came back from the party chat log
        };

        // Auto-save completed run to history if we have complete data
        // Only saves runs completed during live tracking (Option A)
        // What may be banked, and on what evidence.
        //
        // A party run is timed by the server's own "Key counts" timestamps and is
        // saved as validated, exactly as it always has been.
        //
        // A solo run has no such messages, and used to be discarded outright — a
        // solo player built no history at all. It is saved on the wall clock
        // instead, marked `validated: false`, but only when this client watched
        // the whole of it: from wave 1 (never the `joinedMidRun` case, whose
        // start we never saw) through to completion, on a clock we can stand
        // behind (never a hibernated run, whose elapsed time may be wildly wrong
        // and which has no server timestamps to check it against).
        //
        // The exclusion of a partial run is the point rather than a side effect of
        // `validated` already being false for one: a run whose start was never
        // seen must not reach history, the run averages, the pace profile or the
        // ROI board by either route.
        const canBankParty = validated && Boolean(completedRunData.keyCountsMap);
        // Solo means no party "Key counts" message was seen for this run at all.
        // A party run that saw only its start message stays unsaved as before: it
        // has server evidence, just not enough of it, and the wall clock is not a
        // substitute for the half of it that is missing.
        // `!joinedMidRun` as well as the anchor test: recovery is a party-chat
        // mechanism and a solo run has no server timestamps to recover from, so a
        // partial solo run stays refused however the rest of this lines up.
        //
        // "No key count was seen" is not the same as "there was nobody to send
        // one". A party run whose key counts never reached this client — the page
        // loaded after them, the party channel was muted, the scan raced the
        // messages — used to bank as solo: a party pace filed under a one-name
        // team key that will never match the real party, dragging the solo
        // averages down with clears no solo player can match. The fight's own
        // roster settles the composition without chat, so it is required: a run
        // that cannot say who was in it is not banked at all.
        const observedParty = completedRunData.partyNames;
        const soloComposition = Array.isArray(observedParty) && observedParty.length === 1;
        const canBankSolo =
            !joinedMidRun &&
            !validated &&
            firstTimestamp === null &&
            !hibernated &&
            Boolean(soloName) &&
            soloComposition;

        if (!unrecoveredPartial && completedRunData.dungeonHrid && (canBankParty || canBankSolo)) {
            try {
                // A party's roster comes from the key counts. A solo run has none,
                // so the team is the one character who ran it — a one-name team key,
                // which is what a party of one would have produced anyway, so it
                // groups, filters and prices (team size 1) alongside the rest.
                const team = canBankParty ? Object.keys(completedRunData.keyCountsMap).sort() : [soloName];
                const teamKey = dungeonTrackerStorage.getTeamKey(team);

                // Get dungeon name from HRID
                const dungeonInfo = dungeonTrackerStorage.getDungeonInfo(completedRunData.dungeonHrid);
                const dungeonName = dungeonInfo ? dungeonInfo.name : 'Unknown';

                // Build run object in unified format
                const runToSave = {
                    // Party: the server's own start timestamp. Solo: when tracking
                    // saw wave 1 begin, which for a whole-run sighting is the start.
                    timestamp: new Date(canBankParty ? firstTimestamp : completedRunData.startTime).toISOString(),
                    duration: canBankParty ? partyMessageDuration : trackedTotalTime,
                    dungeonName: dungeonName,
                    dungeonHrid: completedRunData.dungeonHrid,
                    tier: completedRunData.tier,
                    keyCountsMap: completedRunData.keyCountsMap, // Include key counts
                    // Per-wave times feed the split-time pace profile; without
                    // them history is only a whole-run average, which reads the
                    // easy early waves as a huge lead
                    // A recovered run watched only its tail, so its wave times are
                    // the hard late waves and nothing else. Banking them would bias
                    // the wave average high and describe a wave-48 split as wave 1.
                    // The duration is the whole run and is kept; the waves are not.
                    waveTimes: startRecovered ? [] : completedWaveTimes,
                    avgWaveTime: startRecovered ? 0 : avgWaveTime,
                    validated: canBankParty,
                    // A recovered run's duration was measured from an anchor the
                    // recovery bound let through, so history has to know not to
                    // let it widen that bound next time (see `plausibleMaxRunMs`)
                    startRecovered,
                    // Unchanged for a party run; a solo run says which clock timed it
                    source: canBankParty ? 'chat' : 'tracker',
                };

                // Save to database (with duplicate detection)
                await dungeonTrackerStorage.saveTeamRun(teamKey, runToSave);
            } catch (error) {
                console.error('[Dungeon Tracker] Failed to auto-save run:', error);
            }
        }

        // Notify completion
        this.notifyCompletion(completedRun);

        this.notifyUpdate();
    }

    /**
     * Format time in milliseconds to MM:SS
     * @param {number} ms - Time in milliseconds
     * @returns {string} Formatted time
     */
    formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Reset tracking state (on completion, flee, or death)
     */
    async resetTracking() {
        this.isTracking = false;
        this.currentRun = null;
        this.waveStartTime = null;
        this.lastWaveEndTime = null;
        this.waveTimes = [];
        this.pendingDungeonInfo = null;
        this.currentBattleId = null;

        // Clear party message tracking
        this.firstKeyCountTimestamp = null;
        this.lastKeyCountTimestamp = null;
        this.keyCountMessages = [];
        this.battleStartedTimestamp = null;
        this.pendingNextRunFirstKeyCount = null;
        this.restoredMidRun = false;
        this.joinedMidRun = false;

        // Clear saved state (await to ensure it completes)
        await this.clearInProgressRun();

        this.notifyUpdate();
    }

    /**
     * Get current run state
     * @returns {Object|null} Current run state or null
     */
    getCurrentRun() {
        if (!this.isTracking || !this.currentRun) {
            return null;
        }

        // Calculate current elapsed time
        // Use firstKeyCountTimestamp (server-validated start) if available, otherwise use tracked start time
        const now = Date.now();
        // A run joined part-way has no start to measure from. Its own startTime is
        // when tracking noticed it, and the chat anchor — when a scan of the party
        // log finds one at all — may belong to an earlier run. Neither is this run's
        // start, so the panel is handed the one figure that is true (time since we
        // picked the run up) and told plainly that that is what it is.
        //
        // Unless the party's chat handed us the run's real start and it survived
        // both checks in `assessRecoveredStart` — then the anchor is better
        // evidence than our own clock ever was, and the run is a whole one.
        const joinedMidRun = this.currentRun.joinedMidRun === true;
        const startRecovered = this.currentRun.startRecovered === true;
        const runStartTime =
            joinedMidRun && !startRecovered
                ? this.currentRun.startTime
                : this.currentRun.recoveredStartTime || this.firstKeyCountTimestamp || this.currentRun.startTime;
        const totalElapsed = now - runStartTime;
        const currentWaveElapsed = this.waveStartTime ? now - this.waveStartTime.getTime() : 0;

        // Calculate average wave time so far
        const avgWaveTime =
            this.waveTimes.length > 0 ? this.waveTimes.reduce((sum, time) => sum + time, 0) / this.waveTimes.length : 0;

        // Calculate ETA
        const remainingWaves = this.currentRun.maxWaves - this.currentRun.wavesCompleted;
        const estimatedTimeRemaining = avgWaveTime > 0 ? avgWaveTime * remainingWaves : 0;

        // Calculate fastest/slowest wave times
        const fastestWave = this.waveTimes.length > 0 ? Math.min(...this.waveTimes) : 0;
        const slowestWave = this.waveTimes.length > 0 ? Math.max(...this.waveTimes) : 0;

        return {
            dungeonHrid: this.currentRun.dungeonHrid,
            dungeonName: this.currentRun.dungeonHrid
                ? dungeonTrackerStorage.getDungeonInfo(this.currentRun.dungeonHrid)?.name
                : 'Unknown',
            tier: this.currentRun.tier,
            currentWave: this.currentRun.currentWave, // Already 1-indexed from new_battle message
            maxWaves: this.currentRun.maxWaves,
            wavesCompleted: this.currentRun.wavesCompleted,
            totalElapsed,
            currentWaveElapsed,
            avgWaveTime,
            fastestWave,
            slowestWave,
            waveTimes: [...this.waveTimes],
            estimatedTimeRemaining,
            keyCountsMap: this.currentRun.keyCountsMap || {}, // Party member key counts
            hibernationDetected: this.hibernationDetected || this.currentRun.hibernationDetected || false,
            // The run was already under way when tracking began
            joinedMidRun,
            joinedAtWave: this.currentRun.joinedAtWave ?? null,
            // Its start came back from the party's own chat timestamps
            startRecovered,
            // `totalElapsed` is time since tracking noticed the run, NOT its duration.
            // Never label it as the run's elapsed time. A recovered run is measured
            // from a real start, so this is false and the panel says "Elapsed:".
            elapsedIsSinceNoticed: joinedMidRun && !startRecovered,
        };
    }

    /**
     * The dungeon the character is running while there is no run to show for it.
     *
     * Page load with a dungeon in progress and no restorable record leaves the
     * tracker armed but not tracking, and waves run around thirty-five seconds —
     * so the panel used to sit blank for the best part of a minute. This is what
     * it says instead: the dungeon's name and tier, and nothing that pretends to
     * be a run. No run is started, no time is invented, nothing is written; the
     * real run replaces it as soon as the next `new_battle` arrives.
     *
     * @returns {{dungeonHrid: string, dungeonName: string, tier: number|null,
     *   maxWaves: number|null, pending: true}|null} The provisional card, or null
     */
    getPendingDungeon() {
        if (this.isTracking || !this.pendingDungeonInfo?.dungeonHrid) {
            return null;
        }

        const info = dungeonTrackerStorage.getDungeonInfo(this.pendingDungeonInfo.dungeonHrid);
        return {
            dungeonHrid: this.pendingDungeonInfo.dungeonHrid,
            dungeonName: info?.name ?? 'Unknown',
            tier: this.pendingDungeonInfo.tier ?? null,
            maxWaves: info?.maxWaves ?? null,
            pending: true,
        };
    }

    /**
     * Register a callback for run updates
     * @param {Function} callback - Callback function
     */
    onUpdate(callback) {
        this.updateCallbacks.push(callback);
    }

    /**
     * Unregister a callback for run updates
     * @param {Function} callback - Callback function to remove
     */
    offUpdate(callback) {
        const index = this.updateCallbacks.indexOf(callback);
        if (index > -1) {
            this.updateCallbacks.splice(index, 1);
        }
    }

    /**
     * Notify all registered callbacks of an update
     */
    notifyUpdate() {
        for (const callback of this.updateCallbacks) {
            try {
                callback(this.getCurrentRun());
            } catch (error) {
                console.error('[Dungeon Tracker] Update callback error:', error);
            }
        }
    }

    /**
     * Notify all registered callbacks of completion
     * @param {Object} completedRun - Completed run data
     */
    notifyCompletion(completedRun) {
        for (const callback of this.updateCallbacks) {
            try {
                callback(null, completedRun);
            } catch (error) {
                console.error('[Dungeon Tracker] Completion callback error:', error);
            }
        }
    }

    /**
     * Check if currently tracking a dungeon
     * @returns {boolean} True if tracking
     */
    isTrackingDungeon() {
        return this.isTracking;
    }

    /**
     * Cleanup for character switching
     */
    async cleanup() {
        try {
            if (this.handlers.newBattle) {
                webSocketHook.off('new_battle', this.handlers.newBattle);
                this.handlers.newBattle = null;
            }
            if (this.handlers.actionCompleted) {
                webSocketHook.off('action_completed', this.handlers.actionCompleted);
                this.handlers.actionCompleted = null;
            }
            if (this.handlers.actionsUpdated) {
                webSocketHook.off('actions_updated', this.handlers.actionsUpdated);
                this.handlers.actionsUpdated = null;
            }
            if (this.handlers.chatMessage) {
                webSocketHook.off('chat_message_received', this.handlers.chatMessage);
                this.handlers.chatMessage = null;
            }

            // Reset all tracking state
            this.isTracking = false;
            this.currentRun = null;
            this.waveStartTime = null;
            this.lastWaveEndTime = null;
            this.waveTimes = [];
            this.pendingDungeonInfo = null;
            this.currentBattleId = null;

            // Clear party message tracking
            this.firstKeyCountTimestamp = null;
            this.lastKeyCountTimestamp = null;
            this.keyCountMessages = [];
            this.battleStartedTimestamp = null;
            this.pendingNextRunFirstKeyCount = null;
            this.restoredMidRun = false;
            this.joinedMidRun = false;
            this.recentChatMessages = [];

            // Reset hibernation detection
            this.hibernationDetected = false;

            // The five-second veto `canRestoreRecord` applies after a run
            // completes, guarding against a record whose IndexedDB clear is
            // still in flight. That clear is this character's, and so is the
            // veto: carried across a switch it refuses the ARRIVING character's
            // genuine in-progress record, which is not stale at all.
            this._lastCompletionTime = 0;

            if (this.visibilityHandler) {
                document.removeEventListener('visibilitychange', this.visibilityHandler);
                this.visibilityHandler = null;
            }

            // Clear character ID
            this.characterId = null;

            // Clear all callbacks
            this.updateCallbacks = [];

            this.timerRegistry.clearAll();

            // Clear saved in-progress run
            await this.clearInProgressRun();

            // Reset initialization flag
            this.isInitialized = false;
        } catch (error) {
            console.error('[Dungeon Tracker] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Backfill team runs from party chat history
     * Scans all "Key counts:" messages and calculates run durations
     * @returns {Promise<{runsAdded: number, teams: Array<string>}>} Backfill results
     */
    async backfillFromChatHistory() {
        try {
            const messages = document.querySelectorAll('[class*="ChatMessage_chatMessage"]');
            const events = [];

            // Extract all relevant events: key counts, party failed, battle ended, battle started
            for (const msg of messages) {
                const text = msg.textContent || '';

                // FILTER: Skip player messages
                // Player messages carry the sender's name element; system messages
                // carry only a timestamp. The game renamed ChatMessage_username to
                // ChatMessage_name (with a CharacterName_* element inside) — match
                // all spellings so the filter survives either direction.
                const hasUsername =
                    msg.querySelector(
                        '[class*="ChatMessage_username"], [class*="ChatMessage_name"], [class*="CharacterName_"]'
                    ) !== null;
                if (hasUsername) {
                    continue; // Skip player messages
                }

                // FALLBACK: Check if text starts with non-timestamp text followed by colon
                if (/^[^[]+:/.test(text)) {
                    continue; // Skip player messages
                }

                // Parse timestamp from message display format: [MM/DD HH:MM:SS AM/PM] or [DD-M HH:MM:SS]
                const timestampMatch = text.match(
                    /\[(\d{1,2})([-/])(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?\]/
                );
                if (!timestampMatch) continue;

                const timestamp = stampFromMatch(timestampMatch);
                if (!timestamp) continue;

                // Extract "Battle started:" messages
                if (text.includes(DUNGEON_BATTLE_STARTED)) {
                    const dungeonName = text.split(DUNGEON_BATTLE_STARTED)[1]?.split(']')[0]?.trim();
                    if (dungeonName) {
                        events.push({
                            type: 'battle_start',
                            timestamp,
                            dungeonName,
                        });
                    }
                }
                // Extract "Key counts:" messages
                else if (text.includes(DUNGEON_KEY_COUNTS)) {
                    // Parse team composition from key counts
                    const keyCountsMap = this.parseKeyCountsFromMessage(text);
                    const playerNames = Object.keys(keyCountsMap).sort();

                    if (playerNames.length > 0) {
                        events.push({
                            type: 'key',
                            timestamp,
                            team: playerNames,
                            keyCountsMap,
                        });
                    }
                }
                // Extract "Party failed" messages
                else if (text.match(DUNGEON_PARTY_FAILED_RE)) {
                    events.push({
                        type: 'fail',
                        timestamp,
                    });
                }
                // Extract "Battle ended:" messages (fled/canceled)
                else if (text.includes(DUNGEON_BATTLE_ENDED)) {
                    const dungeonName = text.split(DUNGEON_BATTLE_ENDED)[1]?.split(']')[0]?.trim();
                    events.push({
                        type: 'cancel',
                        timestamp,
                        dungeonName,
                    });
                }
            }

            // Sort events by timestamp
            events.sort((a, b) => a.timestamp - b.timestamp);

            // Chat carries no tier, so a backfilled run is untiered and files
            // under T0 in every tier-grouped view. The one tier signal available
            // is the dungeon being run right now: stamp backfilled runs of that
            // same dungeon with its tier (and hrid) so they land in the right
            // bucket. Runs of other dungeons stay untiered. This assumes the
            // backfilled runs of the current dungeon are the tier now being run
            // — right for single-tier farming, and the best chat can offer.
            const runningAction = runningCombatAction(dataManager.getCurrentActions?.());
            const runningZoneInfo = runningAction
                ? dataManager.getActionDetails?.(runningAction.actionHrid)?.combatZoneInfo
                : null;
            const currentDungeon =
                runningZoneInfo?.isDungeon === true
                    ? {
                          hrid: runningAction.actionHrid,
                          tier: runningAction.difficultyTier ?? null,
                          name: dungeonTrackerStorage.getDungeonInfo(runningAction.actionHrid)?.name || null,
                      }
                    : null;

            // Build runs from events - only count key→key pairs (skip key→fail and key→cancel)
            let runsAdded = 0;
            const teamsSet = new Set();

            for (let i = 0; i < events.length; i++) {
                const event = events[i];
                if (event.type !== 'key') continue; // Only process key count events

                const next = events[i + 1];
                if (!next) break; // No next event

                // Only create run if next event is also a key count (successful completion)
                if (next.type === 'key') {
                    // Calculate duration (handle midnight rollover)
                    let duration = next.timestamp - event.timestamp;
                    if (duration < 0) {
                        duration += 24 * 60 * 60 * 1000; // Add 24 hours
                    }

                    // Find nearest battle_ended or battle_start before this run
                    // Prioritize battle_ended (appears right before key count completion)
                    const battleEnded = events
                        .slice(0, i)
                        .reverse()
                        .find((e) => e.type === 'cancel' && e.dungeonName);

                    const battleStart = events
                        .slice(0, i)
                        .reverse()
                        .find((e) => e.type === 'battle_start');

                    // Use battle_ended if available, otherwise fall back to battle_start
                    const dungeonName = battleEnded?.dungeonName || battleStart?.dungeonName || 'Unknown';

                    // Get team key
                    const teamKey = dungeonTrackerStorage.getTeamKey(event.team);
                    teamsSet.add(teamKey);

                    // Save team run with dungeon name
                    const run = {
                        timestamp: event.timestamp.toISOString(),
                        duration: duration,
                        dungeonName: dungeonName,
                    };

                    // Tag with the current dungeon's tier when the names match,
                    // so this run stops defaulting to T0 in tier-grouped views.
                    if (currentDungeon && currentDungeon.name && dungeonName === currentDungeon.name) {
                        if (currentDungeon.tier !== null) run.tier = currentDungeon.tier;
                        if (currentDungeon.hrid) run.dungeonHrid = currentDungeon.hrid;
                    }

                    const saved = await dungeonTrackerStorage.saveTeamRun(teamKey, run);
                    if (saved) {
                        runsAdded++;
                    }
                }
                // If next event is 'fail' or 'cancel', skip this key count (not a completed run)
            }

            return {
                runsAdded,
                teams: Array.from(teamsSet),
            };
        } catch (error) {
            console.error('[Dungeon Tracker] Backfill error:', error);
            return {
                runsAdded: 0,
                teams: [],
            };
        }
    }
}

const dungeonTracker = new DungeonTracker();

export default dungeonTracker;
