/**
 * Labyrinth Room Logs
 *
 * What actually happened in each room, and — for fights — whether the sim was
 * right about it.
 *
 * Skilling and enhancing rooms announce every action they take, so their logs
 * are a direct transcript. Combat rooms announce nothing of the sort: the tile
 * badge quotes a clear chance computed before you walked in, the fight happens,
 * and then the tile is either cleared or it is not. Standing those two side by
 * side is the only way to find out whether the number was ever true.
 *
 * Two views, because they answer different questions. The room list is "how did
 * this run go" — grouped by floor, with what each floor cost and returned; the
 * accuracy view is "does the calculator know what it is talking about", which
 * needs every room ever recorded rather than the last few floors.
 *
 * Reached from a tab beside Lab Sim, which is up whether or not a run is in
 * progress: reviewing a run is something you do after it.
 *
 * Ported in part from dakonglong's MIT-licensed Labyrinth Clear Rate Calculator.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { classifyFight, fightTally, failureShape, isFreshLabyrinthFight } from './labyrinth-fight-log.js';
import { summarizePool, poolHygiene, nearMissRemainder } from './labyrinth-replay-check.js';
import { isCurrentFingerprintVersion } from './labyrinth-fingerprint.js';
import labFightRecorder from './labyrinth-fight-recorder.js';
import { newAttributionState, noteActions, attributeTick, foldEvents } from '../../utils/damage-attribution.js';
import labTickCapture from './labyrinth-tick-capture.js';
import { accuracyReport } from './labyrinth-outcome-log.js';
import { splitModelCohorts, calibrationReport, MIN_CALIBRATION_FIGHTS } from './labyrinth-calibration.js';
import { exportMeta, buildAccuracyExport, sanitizeExport, downloadJson } from './labyrinth-accuracy-export.js';
import { formatKMB, timeReadable } from '../../utils/formatters.js';
import { ROOM_TRAVEL_SECONDS } from './labyrinth-formulas.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/** Re-exported from labyrinth-formulas.js, where it now lives */
export { ROOM_TRAVEL_SECONDS };

/**
 * Sum a fight's attribution tally into your swing counts. Crits ride along —
 * damage-per-hit compares real against sim, and a real crit rate below what your
 * crit buffs imply is the sim over-crediting crits (a soft-hit gap that isn't the
 * monster's mitigation); a matching crit rate points the soft-hit gap back at the
 * monster instead. Recorded so a later export can tell the two apart.
 *
 * Damage-over-time ticks come along for the same reason and are counted apart
 * from the swings: a tick rings the monster's damage counter but never the
 * player's attack counter, and it lands for a fraction of the blow that applied
 * it. The ratio of ticks to swings is what the replay puts beside the sim's to
 * decide whether a soft-hit gap is the monster's mitigation or just a mix the
 * sim gets wrong.
 *
 * Their DAMAGE comes along beside their count, and it is what makes
 * damage-per-hit an honest comparison rather than a mixed one. `foldEvents`
 * folds `dotDamage` inside `damage` deliberately, so every total that existed
 * before it stayed right — but the fight's damage total is then the whole of
 * what the monster lost while the hit count is swings alone, and dividing one
 * by the other counts damage-over-time in the numerator and not in the
 * denominator. Recording the subtotal lets the replay take it back out.
 *
 * @param {Object} tally - From `foldEvents`, player index → `{hits, misses, crits, dotTicks, dotDamage, ...}`
 * @returns {{playerHits: number, playerMisses: number, playerCrits: number,
 *   playerDotTicks: number, playerDotDamage: number}}
 */
function tallyHitsMisses(tally) {
    let playerHits = 0;
    let playerMisses = 0;
    let playerCrits = 0;
    let playerDotTicks = 0;
    let playerDotDamage = 0;
    for (const entry of Object.values(tally || {})) {
        playerHits += Number(entry?.hits) || 0;
        playerMisses += Number(entry?.misses) || 0;
        playerCrits += Number(entry?.crits) || 0;
        playerDotTicks += Number(entry?.dotTicks) || 0;
        playerDotDamage += Number(entry?.dotDamage) || 0;
    }
    return { playerHits, playerMisses, playerCrits, playerDotTicks, playerDotDamage };
}

/**
 * Where the room log lives.
 *
 * Scoped per character — a run is one character's run — and resolved at every
 * read and write, since the user switches characters without reloading. The
 * pre-scoping global log is adopted by the main character once.
 */
const STORAGE_KEY = 'labyrinthRoomLogs';

/**
 * What makes two stored rooms the same room: the run and floor it was on, and
 * the moment it began. A session carries no id of its own; two rooms of one run
 * cannot begin in the same millisecond, and the run key keeps a clock that
 * repeats across runs from matching.
 * @param {Object} session - A finished room
 * @returns {string|null}
 */
export function sessionIdentity(session) {
    const startedAt = Number(session?.startedAt);
    if (!Number.isFinite(startedAt)) return null;
    return `${session.runKey || ''}|${startedAt}`;
}

/** Newest first, the order the log is kept in */
const newestFirst = (a, b) => (Number(b?.startedAt) || 0) - (Number(a?.startedAt) || 0);
/** Used when the setting is unreadable; the setting itself is the real bound */
const DEFAULT_SESSIONS = 120;
/** However large the log is set, one room cannot fill it */
const MAX_ACTIONS = 60;
/** A room retried this many times has made its point */
const MAX_ATTEMPTS = 40;
const PANEL_ID = 'mwi-lab-logs-panel';
const TAB_ID = 'mwi-lab-logs-tab';

/**
 * Ticks arrive about three times a second and stop dead when the fight ends.
 * Nothing announces the ending, so this silence is the ending.
 */
const FIGHT_STALE_MS = 4000;

/**
 * How long a finished room stays open to experience still arriving for it.
 *
 * A room ends when the floor says the path moved on, and the experience it
 * earned is a separate message that need not have arrived by then. Sampling the
 * skill totals at the moment of finalizing therefore caught nothing at all: the
 * room was closed before it had been paid. The room stays claimable for a few
 * seconds, and only then goes into the long-term record.
 */
const XP_GRACE_MS = 4000;

const OUTCOME_COLORS = {
    success: '#3ddc84',
    fail: '#ff6464',
    double: '#ffcf5c',
    unknown: '#9ab0d8',
    clear: '#3ddc84',
    death: '#ff6464',
    timeout: '#ffa94d',
};

const VERDICT_COLORS = {
    'sim too high': '#ff8a8a',
    'sim too low': '#8ac6ff',
    consistent: '#8fe3b0',
    // Fights taking longer than simulated is the same kind of news as a clear
    // rate that is too optimistic, so it reads in the same colour
    'sim too fast': '#ff8a8a',
    'sim too slow': '#8ac6ff',
};

/**
 * Split a newest-first list of rooms into the floors they were run on.
 *
 * Grouped on consecutive runs of the same run-and-floor key rather than by
 * collecting every session with that key, so a floor revisited on a later run
 * reads as a second group instead of being silently merged into the first.
 *
 * @param {Array<Object>} sessions - Sessions, newest first
 * @returns {Array<{runKey: string, floor: number, sessions: Array<Object>}>}
 */
export function groupByFloor(sessions) {
    const groups = [];
    for (const session of sessions || []) {
        const runKey = String(session?.runKey || '');
        const last = groups[groups.length - 1];
        if (last && last.runKey === runKey) {
            last.sessions.push(session);
        } else {
            groups.push({ runKey, floor: Math.max(0, Math.floor(Number(session?.floor) || 0)), sessions: [session] });
        }
    }
    return groups;
}

/**
 * What a floor cost and what it returned.
 *
 * Experience per hour is measured over the rooms on the floor, not over the
 * whole floor's wall-clock: the time between rooms is spent reading the map and
 * deciding where to go, and charging that to the rooms would make a floor you
 * thought about look slower than the same floor rushed.
 *
 * The walk to each room is charged, though — `ROOM_TRAVEL_SECONDS` per finished
 * room, exactly what the forecast charges. The measured rate is here to be set
 * against the predicted one, and two rates over different denominators cannot
 * be compared: this one used to read about a second per room too fast, which on
 * a floor of ten-second skilling rooms is a tenth of the figure.
 *
 * `seconds` stays the time spent inside the rooms — it is displayed as such —
 * while `chargedSeconds` is what the rate divides by.
 *
 * @param {Array<Object>} sessions - The floor's rooms
 * @returns {{rooms: number, cleared: number, seconds: number, chargedSeconds: number,
 *   xp: number, xpPerHour: number|null}}
 */
export function floorSummary(sessions) {
    const list = sessions || [];
    let seconds = 0;
    let chargedSeconds = 0;
    let xp = 0;
    let cleared = 0;

    for (const session of list) {
        const ended = session?.endedAt || 0;
        // Only a finished room has a duration; one still running has not
        // taken its time yet — and has not been walked away from either, so
        // it is charged no travel
        if (ended > 0) {
            const inRoom = Math.max(0, (ended - (Number(session.startedAt) || 0)) / 1000);
            seconds += inRoom;
            chargedSeconds += inRoom + ROOM_TRAVEL_SECONDS;
        }
        xp += Math.max(0, Number(session?.xp) || 0);
        if (session?.completed) cleared++;
    }

    return {
        rooms: list.length,
        cleared,
        seconds,
        chargedSeconds,
        xp,
        xpPerHour: chargedSeconds > 0 && xp > 0 ? (xp / chargedSeconds) * 3600 : null,
    };
}

class LabyrinthRoomLogs {
    constructor() {
        this.isInitialized = false;
        this.sessions = [];
        // The stored log, kept through the shared load/save discipline so a
        // read that could not be made — or a second tab of this character —
        // cannot erase rooms already on record. Merged by room identity, newest
        // first, capped at the configured size.
        this.record = createPersistedRecord({
            base: STORAGE_KEY,
            store: 'settings',
            empty: () => ({ sessions: [] }),
            merge: (stored, memory) => mergeRoomLogs(stored, memory, this.logSize()),
            label: 'LabyrinthRoomLogs',
        });
        this.activeSession = null;
        this.labContext = null; // { runKey, roomKey, room }
        this.roomData = null;
        this.progressHandler = null;
        this.labyrinthHandler = null;
        this.battleHandler = null;
        this.newBattleHandler = null;
        this.panel = null;
        this.view = 'rooms';
        /** Pool tab state: which groups are expanded, and the gear scope */
        this.expandedPoolGroups = new Set();
        this.poolAllGear = false;
        this.simSource = null;
        this.fight = null;
        this.fightTimer = null;
        this.renderToken = 0;
        this.resetArmed = false;
        this.tabButton = null;
        this.unregisterTab = null;
        this.unregisterReady = null;
        this.xpHandlers = [];
        this.xpBaseline = null;
        this.pendingReport = null;
        this.reportTimer = null;
        // Which room types are showing their levels. Closed to start with: the
        // record runs to a couple of hundred rooms, and the pooled reading is
        // the one worth reading first — the levels are what you open when it
        // says something.
        this.expandedSubjects = new Set();
        // Whether the accuracy view is showing everything or only what has
        // happened since the baseline was marked
        this.sinceBaseline = false;
    }

    /** How many rooms of history to keep */
    logSize() {
        const raw = Number(config.getSettingValue('labyrinthRoomLogSize', DEFAULT_SESSIONS));
        return Math.min(500, Math.max(20, Math.floor(raw) || DEFAULT_SESSIONS));
    }

    /**
     * Total experience across every skill, right now.
     *
     * Measured rather than derived. The calculator has a formula for what a
     * room is worth, but that formula is one of the things being checked here,
     * so reading it back would only confirm itself. Summing every skill also
     * picks up the experience a fight spreads over several of them.
     *
     * @returns {number|null} null when character data has not arrived
     */
    totalExperience() {
        const skills = dataManager.getSkills();
        if (!Array.isArray(skills)) return null;
        return skills.reduce((sum, skill) => sum + (Number(skill?.experience) || 0), 0);
    }

    /**
     * Credit experience that has just landed to the room that earned it.
     *
     * Differences against a rolling baseline rather than a snapshot taken per
     * room, because the two ends of a room are not the two ends of its payment.
     * Experience arriving while no room is open — outside the labyrinth, or in
     * the gap between rooms — still advances the baseline so it cannot be
     * mistaken for the next room's.
     */
    absorbExperience() {
        const total = this.totalExperience();
        if (!Number.isFinite(total)) return;
        if (!Number.isFinite(this.xpBaseline)) {
            this.xpBaseline = total;
            return;
        }

        const gained = total - this.xpBaseline;
        this.xpBaseline = total;
        if (gained <= 0) return;

        const pending = this.pendingReport;
        const target = this.activeSession || (pending && Date.now() - pending.endedAt < XP_GRACE_MS ? pending : null);
        if (!target) return;

        target.xp = Math.max(0, (Number(target.xp) || 0) + gained);
        this.persist();
        this.renderIfOpen();
    }

    /**
     * Accept the sim's predictions and its fight record.
     *
     * The clear-rate feature owns both — it runs the sims and keeps the tally of
     * how fights went — and it already imports this module to hang a button off
     * the labyrinth panel. Importing it back would close the loop, so it hands
     * over accessors instead and this module works without them.
     *
     * @param {Object} source - { predictedFor, accuracy, reset }
     */
    useSimSource(source) {
        this.simSource = source || null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('labyrinthRoomLogs')) return;
        this.isInitialized = true;

        // Rooms finished before the read lands are folded in rather than lost;
        // an unreadable store keeps what memory has rather than blanking it
        //
        // `isInitialized` is set *before* this read, so a `character_switching`
        // teardown landing inside it never made the switch's re-initialise
        // early-return. The resumed tail instead ran on top of a `disable()`
        // that had already unhooked every socket handler and nulled the fields
        // holding them, and re-stored its own into those same fields — leaving
        // the previous `labyrinth_room_progress`, `labyrinth_updated`,
        // `battle_updated`, `new_battle` and three experience handlers, both
        // DOM-observer subscriptions and the 1 Hz capture timer live with no
        // handle left to remove them by. One whole set leaked per switch, and
        // each leaked set files a *second* `labFightRecorder.noteAttempt()` and
        // a second helping of room experience for the same room — so the
        // calibration pool the clear-rate accuracy math reads is corrupted with
        // duplicate attempts and the XP/hr figures read double.
        const ticket = captureOwner(this);
        this.record.set({ sessions: this.sessions });
        await this.record.load();
        // Guards the whole resumed tail, `adoptMerged()` included: adopting the
        // departing character's stored sessions into memory after the teardown
        // would hand them to whoever has arrived.
        if (!stillOurs(ticket)) return;
        this.adoptMerged();

        // Bring the accumulated calibration fights back into memory, so the pool
        // survives a reload rather than starting empty each session
        labFightRecorder
            .load()
            .catch((error) => console.error('[LabyrinthRoomLogs] Loading fight pool failed:', error));

        this.progressHandler = (data) => this.onRoomProgress(data);
        webSocketHook.on('labyrinth_room_progress', this.progressHandler);

        this.labyrinthHandler = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.labyrinthHandler);

        this.battleHandler = (data) => this.onBattleUpdated(data);
        webSocketHook.on('battle_updated', this.battleHandler);

        // The full start-of-fight snapshot. battle_updated alone joins every
        // fight late — the monster HP lost before the first retained tick was
        // never counted — so the snapshot is both the authoritative attempt
        // boundary and the true baseline the first tick is measured against.
        this.newBattleHandler = (data) => this.onNewBattle(data);
        webSocketHook.on('new_battle', this.newBattleHandler);

        // A page reloaded mid-room gets no labyrinth_updated until the next
        // boundary, so without this the fight in progress goes unwatched
        // entirely instead of being filed as joined late
        this.seedFromCharacterData();

        // The capture button's live tick count, and — once combat has moved on
        // and no battle tick will repaint it — the flip to "Save capture (N)"
        // when a capture stops by itself. A second's cadence is plenty for a
        // counter, and the tick is a no-op while the panel is closed and
        // nothing is armed or held.
        this.captureRefreshTimer = setInterval(() => {
            const status = labTickCapture.captureStatus();
            if (!status.capturing && !status.ticks) return;
            if (this.panel?.isConnected && this.panel.style.display !== 'none') this.paintCapture();
        }, 1000);

        // Experience is credited by its own messages, on their own schedule.
        // Watching for it to land and attributing it to whichever room is open
        // works whichever message brings it and whether it turns up during the
        // room or a moment after it.
        this.xpBaseline = this.totalExperience();
        const absorb = () => this.absorbExperience();
        for (const type of ['action_completed', 'skills_updated', 'labyrinth_updated']) {
            webSocketHook.on(type, absorb);
            this.xpHandlers.push([type, absorb]);
        }

        this.unregisterTab = domObserver.onClass('LabyrinthRoomLogsTab', 'LabyrinthPanel_tabsComponentContainer', () =>
            this.ensureTabButton()
        );
        // @run-at document-start: a tab bar rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up (and its settle
        // retry) waits for the observer's actual-ready signal (immediate if already attached).
        this.unregisterReady = domObserver.onReady('LabyrinthRoomLogsTabCatchUp', () => {
            this.ensureTabButton();
            setTimeout(() => this.ensureTabButton(), 500);
        });
    }

    async disable() {
        // First of all, so an `initialize()` parked on the record read cannot
        // resume into the fields this teardown is about to null.
        noteTeardown(this);
        // Down first, and before anything below can schedule work. The feature
        // is going away, and the one path that arms a timer during a teardown
        // — `finalizeActiveSession`'s experience-grace timeout — checks this
        // flag rather than firing into a disabled module several seconds later.
        // It is cleared at the end of `disable()` as well as here for readers
        // who only look there; setting it twice costs nothing.
        this.isInitialized = false;
        if (this.progressHandler) {
            webSocketHook.off('labyrinth_room_progress', this.progressHandler);
            this.progressHandler = null;
        }
        if (this.labyrinthHandler) {
            webSocketHook.off('labyrinth_updated', this.labyrinthHandler);
            this.labyrinthHandler = null;
        }
        if (this.battleHandler) {
            webSocketHook.off('battle_updated', this.battleHandler);
            this.battleHandler = null;
        }
        if (this.newBattleHandler) {
            webSocketHook.off('new_battle', this.newBattleHandler);
            this.newBattleHandler = null;
        }
        if (this.captureRefreshTimer) {
            clearInterval(this.captureRefreshTimer);
            this.captureRefreshTimer = null;
        }
        for (const [type, handler] of this.xpHandlers) webSocketHook.off(type, handler);
        this.xpHandlers = [];
        // A raw capture registers its own socket listeners; a feature teardown
        // that left them on would leak them past the panel that started it
        labTickCapture.stopCapture();
        this.flushReport();
        if (this.unregisterTab) {
            this.unregisterTab();
            this.unregisterTab = null;
        }
        if (this.unregisterReady) {
            this.unregisterReady();
            this.unregisterReady = null;
        }
        this.resolveFight('feature_disabled');
        this.finalizeActiveSession('feature_disabled');
        // The room finalized a line above is held as `pendingReport` with no
        // timer behind it (see `finalizeActiveSession`). Report it now: there
        // is no experience grace to wait out once the feature is down, and
        // waiting would either drop the room or file it under whichever
        // character has arrived by then.
        this.flushReport();
        document.getElementById(TAB_ID)?.remove();
        this.tabButton = null;
        document.getElementById(PANEL_ID)?.remove();
        this.panel = null;
        this.labContext = null;
        this.roomData = null;
        // Let the room this teardown just finalized actually land before the
        // record is dropped.
        //
        // `resolveFight` and `finalizeActiveSession` above persist through the
        // record's save chain, which runs a microtask later — after the
        // `reset()` below had already emptied memory, so the last room of the
        // session was written as an empty record rather than saved. And the
        // save evaluates `characterKey()` when it *runs*, so on a character
        // switch it has to land before `currentCharacterId` moves; awaiting it
        // here is what lets the registry's teardown, and through it
        // data-manager's awaited `character_switching`, wait for it.
        await this.record.flushed();
        // The log belongs to the character that walked those rooms. Dropped so
        // that a re-initialize — which is how a character switch arrives here —
        // reads the arriving character's log rather than persisting this one's
        // under their key.
        this.sessions = [];
        this.record.reset();
        labFightRecorder.forget();
        this.activeSession = null;
        // Both are readings of the record that has just been dropped, and both
        // are drawn and exported under whoever the panel says it belongs to —
        // the accuracy snapshot is the fallback the two export buttons use when
        // no view has been drawn yet, and the replay verdict sits at the top of
        // the accuracy view until something replaces it.
        this.lastAccuracy = null;
        this.replayResult = null;
        this.isInitialized = false;
    }

    // -------------------------------------------------------------------------
    // Labyrinth context tracking
    // -------------------------------------------------------------------------

    onLabyrinthUpdated(data) {
        const labyrinth = data?.labyrinth;
        if (!labyrinth) {
            this.resolveFight('left_labyrinth');
            this.finalizeActiveSession('left_labyrinth');
            this.labContext = null;
            return;
        }

        // Held so a fight can ask, once it is over, whether the room it was in
        // ended up cleared. The last tick of a won fight usually still shows the
        // monster alive — the killing blow's update never arrives — so the floor
        // is the only reliable witness.
        if (labyrinth.roomData) this.roomData = labyrinth.roomData;

        const floor = Math.floor(Number(labyrinth.currentFloor) || 0);
        const runKey = `${labyrinth.startedAt || ''}|${floor}`;
        const path = this.parsePathData(labyrinth.pathData);
        const head = path?.[0];
        const roomKey = head && Number.isInteger(head.x) && Number.isInteger(head.y) ? `${head.x},${head.y}` : '';
        const room = roomKey ? labyrinth.roomData?.[head.y]?.[head.x] || null : null;

        this.labContext = { runKey, roomKey, room, floor };

        // Finalize the active session when the run or the current room changed
        if (this.activeSession && (this.activeSession.runKey !== runKey || this.activeSession.roomKey !== roomKey)) {
            this.resolveFight('room_switch');
            this.finalizeActiveSession('room_switch');
        }
    }

    /**
     * Which room the character is standing in, read from the init payload.
     *
     * `labyrinth_updated` only arrives when the run changes, so a page loaded in
     * the middle of a fight would otherwise drop every tick until the attempt
     * ended — the fight would not be recorded as joined late; it would not be
     * recorded at all. The init payload carries the same labyrinth object the
     * update message does (either spelling of its key), so it seeds the same way.
     */
    seedFromCharacterData() {
        if (this.labContext) return;
        const characterData = dataManager.characterData;
        const labyrinth = characterData?.characterLabyrinth || characterData?.labyrinth;
        if (!labyrinth || labyrinth.isActive === false || !labyrinth.roomData) return;
        this.onLabyrinthUpdated({ labyrinth });
    }

    parsePathData(pathData) {
        if (Array.isArray(pathData)) return pathData;
        if (typeof pathData === 'string' && pathData) {
            try {
                const parsed = JSON.parse(pathData);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    /**
     * Whether the header is showing a labyrinth fight. Read from the title
     * rather than from run state, following the battle counter: a labyrinth run
     * stays active while you fight regular zones, so the flags mislabel it.
     * @returns {boolean}
     */
    inLabyrinthFight() {
        const row = document.querySelector("div[class*='Header_actionName']");
        return !!row && /labyrinth/i.test(row.textContent || '');
    }

    // -------------------------------------------------------------------------
    // Session tracking
    // -------------------------------------------------------------------------

    onRoomProgress(progress) {
        if (!progress || typeof progress !== 'object') return;

        const snapshot = this.buildSnapshot(progress);
        if (!snapshot) return;

        const session = this.ensureSession(snapshot);
        if (!session) return;

        this.appendAction(session, snapshot);
        this.applySnapshot(session, snapshot);
        this.persist();
        this.renderIfOpen();
    }

    buildSnapshot(progress) {
        const isEnhancing = progress.targetLevel != null;
        const normalize = (v) => {
            const n = Number(v) || 0;
            if (n > 1 && n <= 100) return Math.min(1, n / 100);
            return Math.min(1, Math.max(0, n));
        };
        const targetWorkValue = Math.max(0, Number(progress.targetWorkValue) || 0);
        let currentWorkValue = Math.max(0, Number(progress.currentWorkValue) || 0);
        if (targetWorkValue > 0 && currentWorkValue <= 0) {
            const ratio = Math.min(1, Math.max(0, Number(progress.currentProgress) || 0));
            if (ratio > 0) currentWorkValue = targetWorkValue * ratio;
        }
        return {
            isEnhancing,
            actionCounter: Math.max(0, Math.floor(Number(progress.actionCounter) || 0)),
            successRate: normalize(progress.successRate),
            doubleChance: normalize(progress.doubleProgressChance),
            progressPerAction: Math.max(0, Number(progress.progressPerAction) || 0),
            targetWorkValue,
            currentWorkValue,
            targetLevel: Math.max(0, Math.floor(Number(progress.targetLevel) || 0)),
            currentEnhLevel: Math.max(0, Math.floor(Number(progress.currentEnhLevel) || 0)),
        };
    }

    /**
     * Close out whatever room was being logged, if this is a different one.
     * @param {string} sessionKey - Key of the room now being logged
     * @returns {Object|null} The active session when it is still the right one
     */
    reuseSession(sessionKey) {
        if (this.activeSession && this.activeSession.sessionKey !== sessionKey) {
            this.resolveFight('room_switch');
            this.finalizeActiveSession('room_switch');
        }
        return this.activeSession;
    }

    ensureSession(snapshot) {
        const context = this.labContext || {};
        const mode = snapshot.isEnhancing ? 'enhancing' : 'skilling';
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|${mode}`;

        const existing = this.reuseSession(sessionKey);
        if (existing) return existing;

        const room = context.room || {};
        const skillHrid = String(room.skillHrid || '');
        const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            floor: Math.max(0, Math.floor(Number(context.floor) || 0)),
            mode,
            subjectHrid: skillHrid,
            skillName: this.prettySkillName(skillHrid, mode),
            roomLevel,
            forecast: this.forecastFor(skillHrid, roomLevel, 'skilling'),
            xp: 0,
            actionCount: 0,
            successCount: 0,
            doubleCount: 0,
            startedAt: Date.now(),
            endedAt: 0,
            successRate: snapshot.successRate,
            doubleChance: snapshot.doubleChance,
            progressPerAction: snapshot.progressPerAction,
            targetWorkValue: snapshot.targetWorkValue,
            currentWorkValue: snapshot.currentWorkValue,
            targetLevel: snapshot.targetLevel,
            currentEnhLevel: snapshot.currentEnhLevel,
            actions: [],
            lastSnapshot: snapshot,
            incomplete: snapshot.actionCounter > 0, // joined mid-room
            completed: false,
        };
        return this.activeSession;
    }

    prettySkillName(skillHrid, mode) {
        const tail = skillHrid.split('/').pop() || (mode === 'enhancing' ? 'enhancing' : 'skilling');
        return tail.charAt(0).toUpperCase() + tail.slice(1);
    }

    prettyMonsterName(monsterHrid) {
        const tail = String(monsterHrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ');
        return tail.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Monster';
    }

    appendAction(session, snapshot) {
        const prev = session.lastSnapshot;
        const prevCounter = Math.max(0, Math.floor(Number(prev?.actionCounter) || 0));
        const nextCounter = snapshot.actionCounter;

        if (!prev || nextCounter <= prevCounter) return;

        if (nextCounter - prevCounter > 1) {
            session.incomplete = true;
            for (let c = prevCounter + 1; c < nextCounter; c++) {
                session.actions.push({ outcome: 'unknown', text: '?' });
            }
        }

        const action = this.deriveAction(prev, snapshot);
        // Counted here rather than from the drawn list, which is trimmed once a
        // room runs long — the rate has to survive the trimming
        session.actionCount = (session.actionCount || 0) + 1;
        if (action.outcome === 'success' || action.outcome === 'double') {
            session.successCount = (session.successCount || 0) + 1;
        }
        if (action.outcome === 'double') session.doubleCount = (session.doubleCount || 0) + 1;

        session.actions.push(action);
        if (session.actions.length > MAX_ACTIONS) {
            session.incomplete = true;
            session.actions = session.actions.slice(session.actions.length - MAX_ACTIONS);
        }
    }

    /**
     * Derive an action outcome by comparing consecutive progress snapshots
     */
    deriveAction(prev, next) {
        if (next.isEnhancing) {
            const levelDelta = next.currentEnhLevel - Math.max(0, Math.floor(Number(prev?.currentEnhLevel) || 0));
            let outcome = 'fail';
            if (levelDelta >= 2) outcome = 'double';
            else if (levelDelta >= 1) outcome = 'success';
            return { outcome, text: `+${next.currentEnhLevel}` };
        }

        const workDelta = next.currentWorkValue - Math.max(0, Number(prev?.currentWorkValue) || 0);
        const expectedSingle = Math.max(0, Number(prev?.progressPerAction) || 0);
        let outcome = 'fail';
        if (workDelta > 0.0001) {
            outcome = expectedSingle > 0 && workDelta >= expectedSingle * 1.8 ? 'double' : 'success';
        }
        const progressPct =
            next.targetWorkValue > 0 ? Math.min(100, (next.currentWorkValue / next.targetWorkValue) * 100) : 0;
        return { outcome, text: `${Math.round(progressPct)}%` };
    }

    applySnapshot(session, snapshot) {
        session.successRate = snapshot.successRate;
        session.doubleChance = snapshot.doubleChance;
        session.progressPerAction = snapshot.progressPerAction;
        session.targetWorkValue = snapshot.targetWorkValue;
        session.currentWorkValue = snapshot.currentWorkValue;
        session.targetLevel = snapshot.targetLevel;
        session.currentEnhLevel = snapshot.currentEnhLevel;
        session.lastSnapshot = snapshot;
    }

    // -------------------------------------------------------------------------
    // Combat rooms
    //
    // A fight has no progress messages to transcribe, so it is watched through
    // battle_updated — both sides' health, three times a second — and recorded
    // as one attempt per fight rather than one entry per swing. Individual
    // swings are noise; whether the room fell, and how close it came, is not.
    // -------------------------------------------------------------------------

    /**
     * Open a new fight record for the recorder to accumulate into.
     *
     * `caughtStart` says which baseline the fight starts from: true when a
     * `new_battle` snapshot supplied the real starting health (the fight is
     * measured whole), false when the fight was joined at its first retained
     * tick and whatever fell before it is unobservable.
     *
     * @param {Object} session - The combat session the fight belongs to
     * @param {Object} start - `{battleId, caughtStart, playerMaxHp, playerHp,
     *   monsterMaxHp, monsterHp, attrState, lastAtkCounter}`
     */
    openFight(session, start) {
        const now = Date.now();
        this.fight = {
            session,
            roomKey: session.roomKey,
            monsterHrid: session.monsterHrid,
            battleId: start.battleId,
            caughtStart: start.caughtStart === true,
            monsterMaxHp: start.monsterMaxHp,
            // Absolute health at the fight's start, so the recorder can measure
            // the damage each side dealt — you carry health between rooms, so
            // a fight need not begin at full
            playerMaxHp: start.playerMaxHp,
            playerHpStart: start.playerHp,
            monsterHpStart: start.monsterHp,
            // Gross damage each side dealt, summed from the health that fell
            // tick to tick. The endpoints alone give damage net of healing —
            // and you regenerate through a fight — while the sim reports it
            // gross, so a net-vs-gross comparison read as the sim over-hitting.
            grossTaken: 0,
            grossDealt: 0,
            // Upward monster HP steps (life drain, guardian aura), so the
            // endpoints can be reconciled against the summed drops: what the
            // monster lost overall plus what it healed back is what you dealt
            monsterHealed: 0,
            // Per-hit tally, so the replay can split the damage gap into
            // "landed fewer hits than the sim" (accuracy vs the monster's
            // evasion) versus "each hit softer than the sim" (its mitigation).
            // Read from the same dmgCounter/critCounter the wire already
            // carries, via the shared attribution decoder.
            attrState: start.attrState || newAttributionState(),
            attrTally: {},
            prevPlayerHp: start.playerHp,
            prevMonsterHp: start.monsterHp,
            lastMonsterHp: start.monsterHp,
            // Seeded so a resolution before any tick classifies as unknown
            // rather than reading absent fractions as a dead monster
            monsterHpFraction: start.monsterMaxHp > 0 ? start.monsterHp / start.monsterMaxHp : 1,
            playerHpFraction: start.playerMaxHp > 0 ? start.playerHp / start.playerMaxHp : 1,
            playerHpEnd: start.playerHp,
            monsterHpEnd: start.monsterHp,
            startedAt: now,
            battleStartedAt: now,
            firstUpdateAt: null,
            lastTickAt: null,
        };
        if (Number.isFinite(start.lastAtkCounter)) this.fight.lastAtkCounter = start.lastAtkCounter;

        if (this.fightTimer) clearTimeout(this.fightTimer);
        this.fightTimer = setTimeout(() => this.resolveFight('stale'), FIGHT_STALE_MS);
    }

    /**
     * Seed attribution baselines from a `new_battle` snapshot, so the swings
     * between the snapshot and the first retained tick are credited instead of
     * silently becoming the baseline. `new_battle` spells its fields long
     * (`currentHitpoints`, sometimes under `combatDetails`) where the per-tick
     * `battle_updated` abbreviates (`cHP`); both spellings are read.
     *
     * @param {Object} state - From `newAttributionState`, mutated
     * @param {Object} data - The `new_battle` payload
     */
    seedAttribution(state, data) {
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        noteActions(state, data?.players);
        for (const [index, monster] of Object.entries(data?.monsters || {})) {
            const details = monster?.combatDetails || {};
            const hp = num(details.currentHitpoints ?? monster?.currentHitpoints ?? details.maxHitpoints);
            if (hp === null) continue;
            state.monstersHP[index] = hp;
            state.dmgCounter[index] = num(details.dmgCounter ?? monster?.dmgCounter) ?? 0;
            state.critCounter[index] = num(details.critCounter ?? monster?.critCounter) ?? 0;
        }
        for (const [index, player] of Object.entries(data?.players || {})) {
            const details = player?.combatDetails || {};
            const atk = num(details.atkCounter ?? player?.atkCounter ?? player?.attackAttemptCounter);
            if (atk !== null) state.playersAtk[index] = atk;
            const mp = num(details.currentManapoints ?? player?.currentManapoints ?? player?.cMP);
            if (mp !== null) state.playersMP[index] = mp;
        }
    }

    /**
     * A labyrinth fight's opening statement: the full snapshot the server sends
     * as the fight begins. The authoritative attempt boundary — battleId never
     * changes in a labyrinth, so consecutive retries are told apart here, not
     * guessed at from health jumps — and the true starting baseline, counting
     * the damage the first retained `battle_updated` arrives too late to see.
     *
     * @param {Object} data - new_battle payload
     */
    onNewBattle(data) {
        const context = this.labContext;
        const room = context?.room;
        if (!room?.monsterHrid || !this.inLabyrinthFight()) return;

        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const health = (unit) => {
            const details = unit?.combatDetails || {};
            const maxHp = num(details.maxHitpoints ?? unit?.maxHitpoints);
            const hp = num(details.currentHitpoints ?? unit?.currentHitpoints) ?? maxHp;
            return { hp, maxHp };
        };
        const unitAt = (units, index) => (Array.isArray(units) ? units[index] : units ? units[String(index)] : null);
        const player = unitAt(data?.players, 0);
        const monster = unitAt(data?.monsters, 0);
        const playerHealth = health(player);
        const monsterHealth = health(monster);
        // A snapshot that cannot state both health bars cannot seed a fight;
        // the heuristic tick path below will open it, flagged as joined late
        if (!(playerHealth.maxHp > 0) || !(monsterHealth.maxHp > 0)) return;

        const session = this.ensureCombatSession(context, room);
        if (!session) return;

        // Whatever was being watched has ended — the snapshot says so
        this.resolveFight('new_battle');

        const details = player?.combatDetails || {};
        const attrState = newAttributionState();
        this.seedAttribution(attrState, data);
        this.openFight(session, {
            battleId: data?.battleId,
            caughtStart: true,
            playerMaxHp: playerHealth.maxHp,
            playerHp: playerHealth.hp,
            monsterMaxHp: monsterHealth.maxHp,
            monsterHp: monsterHealth.hp,
            attrState,
            lastAtkCounter: num(details.atkCounter ?? player?.atkCounter ?? player?.attackAttemptCounter),
        });
        this.renderIfOpen();
    }

    /**
     * Track a labyrinth fight for the room log.
     *
     * `battle_updated` is a sparse delta: a tick can carry only the player,
     * only the monster, or both. A missing unit means unchanged — its side of
     * the fight simply does not advance this tick — not a reason to drop the
     * tick, which used to starve the recorder of about a fifth of them.
     *
     * @param {Object} data - battle_updated payload
     */
    onBattleUpdated(data) {
        const player = data?.pMap?.['0'];
        const monster = data?.mMap?.['0'];
        const playerOk = !!player && player.mHP > 0;
        const monsterOk = !!monster && monster.mHP > 0;
        if (!playerOk && !monsterOk) return;

        const context = this.labContext;
        const room = context?.room;
        if (!room?.monsterHrid || !this.inLabyrinthFight()) return;

        const session = this.ensureCombatSession(context, room);
        if (!session) return;

        const atkCounter = playerOk ? Number(player.atkCounter) || 0 : undefined;

        // A new session is always a new fight; otherwise defer to the shared
        // boundary test, which counts a monster-health jump only when it is the
        // leap to full a spawn makes — not the bump a self-healing monster (the
        // Dryad's life drain, a guardian aura) gives itself mid-fight, which used
        // to split one attempt into several at whatever low health it landed on.
        // The heuristic reads monster health, so a tick without the monster
        // cannot run it and continues the open fight instead. It is the
        // fallback boundary — new_battle is authoritative — kept for fights
        // joined mid-stream, where no snapshot was seen.
        let fight = this.fight;
        const sameSession = !!fight && fight.session === session;
        let isNewFight = !sameSession;
        if (sameSession && monsterOk) {
            // A snapshot-seeded fight adopts the tick's spelling of the fields
            // the heuristic compares, so a battleId or max-HP the snapshot did
            // not carry cannot read as a fresh fight on the very first tick
            if (fight.battleId === undefined || fight.battleId === null) fight.battleId = data.battleId;
            if (!(fight.monsterMaxHp > 0)) fight.monsterMaxHp = monster.mHP;
            isNewFight = isFreshLabyrinthFight(fight, {
                battleId: data.battleId,
                monsterMaxHp: monster.mHP,
                monsterHp: monster.cHP,
                atkCounter,
            });
        }

        if (isNewFight) {
            // A fight cannot be opened from half a tick — wait for one that
            // carries both sides, or for a new_battle snapshot
            if (!playerOk || !monsterOk) return;
            this.resolveFight('new_fight'); // whatever was being watched has ended
            this.openFight(session, {
                battleId: data.battleId,
                // Joined at its first retained tick: damage dealt before this
                // tick is unobservable, and the recorder must know that
                caughtStart: false,
                playerMaxHp: player.mHP,
                playerHp: player.cHP,
                monsterMaxHp: monster.mHP,
                monsterHp: monster.cHP,
            });
        }
        fight = this.fight;

        // A swing is the monster's dmgCounter rising; a miss is a swing that left
        // its health untouched. filterNonDamaging:false so every swing counts,
        // not only those during a damaging ability. The decoder tolerates a
        // missing unit map — a sparse tick just contributes fewer events.
        try {
            noteActions(fight.attrState, data.pMap);
            const events = attributeTick({ pMap: data.pMap, mMap: data.mMap }, fight.attrState);
            foldEvents(fight.attrTally, events, { filterNonDamaging: false });
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Attributing a fight tick failed:', error);
        }

        // Accumulate the drops, not the endpoints: a health bar that fell 300 and
        // regenerated 100 took 300, not 200, and that is what the monster dealt.
        // Upward monster steps are its own healing, recorded so the endpoints
        // reconcile: start − end + healed is the gross damage it took.
        if (playerOk) {
            const takenStep = fight.prevPlayerHp - player.cHP;
            if (takenStep > 0) fight.grossTaken += takenStep;
            Object.assign(fight, {
                lastAtkCounter: atkCounter,
                playerHpFraction: player.cHP / player.mHP,
                playerHpEnd: player.cHP,
                prevPlayerHp: player.cHP,
            });
        }
        if (monsterOk) {
            const dealtStep = fight.prevMonsterHp - monster.cHP;
            if (dealtStep > 0) fight.grossDealt += dealtStep;
            else if (dealtStep < 0) fight.monsterHealed -= dealtStep;
            Object.assign(fight, {
                lastMonsterHp: monster.cHP,
                monsterHpFraction: monster.cHP / monster.mHP,
                monsterHpEnd: monster.cHP,
                prevMonsterHp: monster.cHP,
            });
        }

        // The fight's clock: opened at the new_battle snapshot (or first seen
        // tick) and read at the last tick, so the stale wait and any retry gap
        // after the ending never bill to the fight
        const now = Date.now();
        if (fight.firstUpdateAt === null) fight.firstUpdateAt = now;
        fight.lastTickAt = now;

        // The tile may not have been calculated when the room was entered, and
        // a prediction that arrives during the fight is still a prediction made
        // before the outcome was known
        if (session.predicted === null) {
            session.forecast = this.forecastFor(session.monsterHrid, session.roomLevel, 'combat');
            session.predicted = session.forecast?.clearChance ?? null;
        }
        session.entryCount = Math.max(session.entryCount || 0, Math.floor(Number(room.entryCount) || 0));

        if (this.fightTimer) clearTimeout(this.fightTimer);
        this.fightTimer = setTimeout(() => this.resolveFight('stale'), FIGHT_STALE_MS);

        if (isNewFight) this.renderIfOpen();
    }

    /**
     * What the calculator claims about a room, captured on the way in.
     *
     * Taken once at the start rather than read when the room is drawn, because
     * the claim being checked is the one that was on screen when you decided to
     * walk in — not one recomputed later for gear you have since changed.
     *
     * @param {string} subjectHrid - Monster or skill
     * @param {number} roomLevel - Room level
     * @param {string} kind - 'combat' or 'skilling'
     * @returns {Object|null} Trimmed to the fields worth keeping
     */
    forecastFor(subjectHrid, roomLevel, kind) {
        try {
            const forecast = this.simSource?.forecast?.(subjectHrid, roomLevel, kind);
            if (!forecast) return null;
            const keep = (v) => (Number.isFinite(v) ? v : null);
            return {
                clearChance: keep(forecast.clearChance),
                expectedSeconds: Number.isFinite(forecast.expectedSeconds) ? forecast.expectedSeconds : null,
                successChance: keep(forecast.successChance),
                doubleChance: keep(forecast.doubleChance),
                xpPerRoom: keep(forecast.xpPerRoom),
                xpPerHour: keep(forecast.xpPerHour),
            };
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the room forecast failed:', error);
            return null;
        }
    }

    ensureCombatSession(context, room) {
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|combat`;

        const existing = this.reuseSession(sessionKey);
        if (existing) return existing;

        const monsterHrid = String(room.monsterHrid || '');
        const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        const forecast = this.forecastFor(monsterHrid, roomLevel, 'combat');
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            floor: Math.max(0, Math.floor(Number(context.floor) || 0)),
            mode: 'combat',
            monsterHrid,
            subjectHrid: monsterHrid,
            skillName: this.prettyMonsterName(monsterHrid),
            roomLevel,
            forecast,
            predicted: forecast && Number.isFinite(forecast.clearChance) ? forecast.clearChance : null,
            xp: 0,
            entryCount: Math.max(0, Math.floor(Number(room.entryCount) || 0)),
            startedAt: Date.now(),
            endedAt: 0,
            actions: [],
            cleared: false,
            incomplete: false,
            completed: false,
        };
        return this.activeSession;
    }

    /**
     * Whether the floor says a room was cleared.
     *
     * A cleared room is stripped of its monster, so demanding that the square
     * still name the fight you just had is demanding the one thing a won room
     * cannot do — it would answer "cannot say" for exactly the wins it is being
     * asked about. A square naming a *different* monster is a different room on
     * a floor that has moved on, and that one really is unanswerable.
     *
     * @param {string} roomKey - "x,y"
     * @param {string} monsterHrid - The monster that was there
     * @returns {boolean|undefined} undefined when the floor cannot say
     */
    roomCleared(roomKey, monsterHrid) {
        const [x, y] = String(roomKey || '')
            .split(',')
            .map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
        const room = this.roomData?.[y]?.[x];
        if (!room) return undefined;
        if (room.monsterHrid && room.monsterHrid !== monsterHrid) return undefined;
        return !!room.isCleared;
    }

    /**
     * File the fight being watched as an attempt, whatever became of it.
     * @param {string} [reason] - What ended the watch: 'new_battle' (the
     *   authoritative boundary), 'new_fight' (the tick heuristic), 'stale'
     *   (ticks stopped), or the interruption that filed it ('room_switch',
     *   'left_labyrinth', 'feature_disabled')
     */
    resolveFight(reason = 'stale') {
        const fight = this.fight;
        this.fight = null;
        if (this.fightTimer) {
            clearTimeout(this.fightTimer);
            this.fightTimer = null;
        }
        if (!fight) return;

        const resolvedAt = Date.now();
        // In-fight time runs from the battle's start to its last tick — never
        // to now, which would bill up to the stale wait plus any retry or UI
        // delay to the fight. Wall-clock only when no tick was ever seen.
        const seconds =
            Number.isFinite(fight.battleStartedAt) && Number.isFinite(fight.lastTickAt)
                ? Math.max(0, (fight.lastTickAt - fight.battleStartedAt) / 1000)
                : (resolvedAt - fight.startedAt) / 1000;

        const session = fight.session;
        const attempt = classifyFight({
            monsterHpFraction: fight.monsterHpFraction,
            playerHpFraction: fight.playerHpFraction,
            seconds,
            cleared: this.roomCleared(fight.roomKey, fight.monsterHrid),
        });
        // Complete means the whole fight was measured: seeded from its
        // new_battle snapshot AND resolved to a known ending. Anything else is
        // a partial measurement, and aggregates must be able to say so.
        attempt.complete = fight.caughtStart === true && attempt.outcome !== 'unknown';
        attempt.resolveReason = reason;

        session.actions.push(attempt);
        if (session.actions.length > MAX_ATTEMPTS) {
            session.incomplete = true;
            session.actions = session.actions.slice(session.actions.length - MAX_ATTEMPTS);
        }
        if (attempt.outcome === 'clear') session.cleared = true;
        session.endedAt = resolvedAt;

        // Endpoint reconciliation: the monster's total HP loss plus what it
        // healed back is exactly the gross damage dealt, so any residual over
        // the tick-summed figure is damage the ticks failed to carry
        const monsterHealed = Math.max(0, Number(fight.monsterHealed) || 0);
        const endpointDealt =
            Number.isFinite(fight.monsterHpStart) && Number.isFinite(fight.monsterHpEnd)
                ? fight.monsterHpStart - fight.monsterHpEnd + monsterHealed
                : null;
        const unattributedDealt = endpointDealt === null ? null : endpointDealt - (Number(fight.grossDealt) || 0);

        // The calibration replay reads this. It is passive — the labyrinth gives
        // random rooms, so every fight is kept and the ones you meet often
        // accumulate, rather than farming one room. The room log keeps the
        // outcome; the recorder keeps the damage exchange that says whether a loss
        // was a timeout or a death, tagged with the gear it was fought in so a
        // gear change starts a fresh pool.
        labFightRecorder.noteAttempt({
            monsterHrid: fight.monsterHrid,
            monsterName: this.prettyMonsterName(fight.monsterHrid),
            roomLevel: session.roomLevel,
            seconds: attempt.seconds,
            outcome: attempt.outcome,
            cleared: attempt.outcome === 'clear',
            monsterMaxHp: fight.monsterMaxHp,
            monsterHpEnd: fight.monsterHpEnd,
            playerMaxHp: fight.playerMaxHp,
            playerHpStart: fight.playerHpStart,
            playerHpEnd: fight.playerHpEnd,
            // Gross damage summed from the drops — matches the sim's gross
            // totals, unlike the endpoints, which are net of your regen
            monsterDamage: fight.grossDealt,
            playerDamageTaken: fight.grossTaken,
            // The endpoint reconciliation: where the fight really started, how
            // much the monster healed back, and the residual the tick-summed
            // figure missed (negative when the ticks somehow carried more)
            monsterHpStart: fight.monsterHpStart,
            monsterHealed,
            unattributedDealt,
            // The fight's own clock, so a reader can tell measured in-fight
            // time from the wall-clock the resolution happened at
            battleStartedAt: fight.battleStartedAt ?? null,
            firstUpdateAt: fight.firstUpdateAt ?? null,
            lastTickAt: fight.lastTickAt ?? null,
            resolvedAt,
            resolveReason: reason,
            complete: attempt.complete,
            // Your swings on the monster, hits and misses, summed across the
            // fight — the replay reads hit-rate and damage-per-hit from these,
            // and the damage-over-time tick count beside them for the hit mix
            ...tallyHitsMisses(fight.attrTally),
            fingerprint: this.simSource?.fingerprint?.() || null,
            // The clear chance in effect while the fight ran — captured at room
            // entry (or during the fight, if the tile's sim landed late). Null
            // when the room was never simmed; the recorder must not backfill it
            // later from a newer engine's cache.
            predicted: session.predicted ?? null,
        });

        this.persist();
        this.renderIfOpen();
    }

    isSessionComplete(session) {
        if (session.mode === 'combat') {
            return !!session.cleared;
        }
        if (session.mode === 'enhancing') {
            return session.targetLevel > 0 && session.currentEnhLevel >= session.targetLevel;
        }
        if (session.targetWorkValue > 0) {
            return session.currentWorkValue >= session.targetWorkValue - 0.0001;
        }
        return false;
    }

    finalizeActiveSession(reason) {
        const session = this.activeSession;
        if (!session) return;
        this.activeSession = null;

        session.endedAt = Date.now();
        session.completed = this.isSessionComplete(session);
        if (!session.completed && reason !== 'room_complete') {
            session.incomplete = true;
        }
        delete session.lastSnapshot;

        // Held back rather than reported now: the experience this room earned
        // may not have been credited yet, and a record written before the
        // payment arrives is a record of a room that earned nothing
        this.flushReport();
        this.pendingReport = session;
        // Not while the feature is being torn down: `disable()` finalizes the
        // room in progress, and a grace timer armed there outlives everything
        // it belongs to — it fires into a disabled module, and on a character
        // switch it fires after `currentCharacterId` has moved, recording this
        // character's room against the arriving one. `disable()` flushes the
        // pending report itself instead of waiting for a grace it cannot have.
        if (this.isInitialized) {
            this.reportTimer = setTimeout(() => this.flushReport(), XP_GRACE_MS);
        }

        this.sessions.unshift(session);
        this.sessions = this.sessions.slice(0, this.logSize());
        this.persist();
        this.renderIfOpen();
    }

    /** Report whichever room has been waiting for its experience, if any */
    flushReport() {
        if (this.reportTimer) {
            clearTimeout(this.reportTimer);
            this.reportTimer = null;
        }
        const session = this.pendingReport;
        this.pendingReport = null;
        if (session) this.reportRoomResult(session);
    }

    /**
     * Hand a finished room to the long-term record.
     *
     * Rooms you gave up on are reported too. A labyrinth room pays only when it
     * is completed, so an abandoned one is time spent for nothing — and dropping
     * it would raise the measured experience per hour every time you walked away
     * from a room. The record keeps its duration apart from the finished rooms'
     * so it cannot distort what a room takes to complete, which is a different
     * question.
     *
     * @param {Object} session - The finalized session
     */
    reportRoomResult(session) {
        if (!session.subjectHrid || !this.simSource?.record) return;

        const seconds = Math.max(0, (session.endedAt - session.startedAt) / 1000);
        const skilling = session.mode !== 'combat';

        // A combat room's only other signal is how long its fights ran. Clears
        // over attempts needs hundreds of fights to say anything and a room
        // gives you ten; fight length is measured on every attempt, win or
        // lose, and the sim already predicts it — so a model that has the fight
        // wrong shows up in a handful rather than in a season. Only attempts
        // with a known outcome: an 'unknown' was filed by a disable, a room
        // switch or the stale timer mid-fight, and its truncated duration
        // would read as the sim simulating fights too long.
        const fights = skilling ? [] : (session.actions || []).filter((a) => a?.outcome && a.outcome !== 'unknown');
        const fightSeconds = fights.reduce((sum, attempt) => sum + (Number(attempt.seconds) || 0), 0);
        const fightSquares = fights.reduce((sum, attempt) => sum + (Number(attempt.seconds) || 0) ** 2, 0);

        Promise.resolve(
            this.simSource.record({
                subjectHrid: session.subjectHrid,
                roomLevel: session.roomLevel,
                kind: skilling ? 'skilling' : 'combat',
                cleared: !!session.completed,
                seconds,
                xp: session.xp,
                actions: skilling ? session.actionCount : 0,
                successes: skilling ? session.successCount : 0,
                doubles: skilling ? session.doubleCount : 0,
                fights: fights.length,
                fightSeconds,
                fightSquares,
                predictedFightSeconds: session.forecast?.avgFightSeconds,
                predictedSeconds: session.forecast?.expectedSeconds,
                predictedSuccess: session.forecast?.successChance,
                predictedDouble: session.forecast?.doubleChance,
                // The server states the rates it is using with every action, so
                // the calculator's figure can be checked against the truth
                // rather than only against a sample of outcomes
                serverSuccess: skilling ? session.successRate : undefined,
                serverDouble: skilling ? session.doubleChance : undefined,
            })
        ).catch((error) => console.error('[LabyrinthRoomLogs] Recording a finished room failed:', error));
    }

    /**
     * Write the log. Rooms another tab stored meanwhile are folded in, and the
     * write is skipped when storage cannot be read first.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async persist() {
        const sessions = this.sessions.map((session) => {
            const copy = { ...session };
            delete copy.lastSnapshot;
            return copy;
        });
        this.record.set({ sessions });
        try {
            const landed = await this.record.save();
            this.adoptMerged();
            return landed;
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Failed to persist logs:', error);
            return false;
        }
    }

    /**
     * Take rooms the stored record had and this tab did not, keeping this
     * tab's own room objects — a room still waiting for its experience is
     * credited through the object the log holds, so that object must stay.
     */
    adoptMerged() {
        const mine = new Map(this.sessions.map((session) => [sessionIdentity(session), session]));
        this.sessions = this.record
            .get()
            .sessions.map((session) => mine.get(sessionIdentity(session)) || session)
            .slice(0, this.logSize());
    }

    clearLogs() {
        this.sessions = [];
        this.activeSession = null;
        this.fight = null;
        this.record.clear().catch((error) => console.error('[LabyrinthRoomLogs] Failed to clear logs:', error));
        this.renderIfOpen();
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    /**
     * The labyrinth page's own tab bar, which is up whether or not a run is in
     * progress.
     *
     * The button used to live on the calculate bar inside a run, which put the
     * history of your last three floors behind having to be standing in a
     * fourth. Reviewing a run is something you do after it, so the way in has to
     * outlive it.
     *
     * @returns {HTMLElement|null}
     */
    findLabyrinthTabBar() {
        const container = document.querySelector('[class*="LabyrinthPanel_tabsComponentContainer"]');
        return container?.querySelector('[class*="TabsComponent_tabsContainer"] > div > div > div') || null;
    }

    /**
     * A tab beside Lab Sim that shows and hides the panel.
     *
     * Cloned from one of the game's own tabs so it sits in the row properly, and
     * marked with a ⧉ and dimmed while closed: a tab that does not change the
     * page when clicked, then does nothing visible when clicked again, reads as
     * broken. The glyph says it opens a panel, the dimming says whether that
     * panel is currently up. Same treatment as the Bulk Sell tab.
     */
    ensureTabButton() {
        const bar = this.findLabyrinthTabBar();
        if (!bar) {
            this.tabButton?.remove();
            this.tabButton = null;
            return;
        }
        if (this.tabButton && bar.contains(this.tabButton)) {
            this.keepAfterLabSim(bar);
            this.syncTabButton();
            return;
        }
        this.tabButton?.remove();

        const native = Array.from(bar.children).find(
            (el) => el.classList?.contains('MuiTab-root') && !el.classList.contains('toolasha-lab-sim-btn')
        );
        if (!native) return;

        const button = native.cloneNode(true);
        button.id = TAB_ID;
        button.title =
            'Room Logs — what happened in each room, and whether the calculator was right about it.\n\n' +
            'Rooms: the last runs grouped by floor, with time, clears and experience per hour for each.\n' +
            'Sim accuracy: every room ever recorded, set against the chance it was given.\n\n' +
            'Click to show or hide the panel.';
        const badge = button.querySelector('[class*="TabsComponent_badge"]');
        if (badge) {
            badge.innerHTML = '<div style="text-align: center;"><div>⧉ Room Logs</div></div>';
        } else {
            button.textContent = '⧉ Room Logs';
        }
        button.classList.remove('Mui-selected');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.togglePanel();
        });

        bar.appendChild(button);
        this.tabButton = button;
        this.keepAfterLabSim(bar);
        this.syncTabButton();
    }

    /** Lab Sim injects itself too and can land after us; stay on its right */
    keepAfterLabSim(bar) {
        const labSim = bar.querySelector('.toolasha-lab-sim-btn');
        if (labSim && labSim.nextElementSibling !== this.tabButton) labSim.after(this.tabButton);
    }

    syncTabButton() {
        if (!this.tabButton) return;
        const open = !!this.panel?.isConnected && this.panel.style.display !== 'none';
        this.tabButton.style.opacity = open ? '1' : '0.6';
    }

    togglePanel() {
        const panel = this.ensurePanel();
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            this.render();
        } else {
            panel.style.display = 'none';
        }
        this.syncTabButton();
    }

    ensurePanel() {
        if (this.panel && this.panel.isConnected) return this.panel;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText =
            'position:fixed; top:90px; right:14px; width:340px; max-height:60vh; display:none; flex-direction:column; ' +
            'border:1px solid rgba(128,170,255,0.5); border-radius:8px; background:rgba(10,14,22,0.97); color:#f2f7ff; ' +
            `box-shadow:0 10px 24px rgba(0,0,0,0.55); z-index:${config.Z_FLOATING_PANEL}; user-select:none;`;

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:8px 10px; flex-wrap:wrap; ' +
            'padding:8px 10px 6px; border-bottom:1px solid rgba(146,182,255,0.24); cursor:move;';

        const tabs = document.createElement('div');
        tabs.style.cssText = 'display:inline-flex; align-items:center; gap:4px;';
        this.tabButtons = {
            rooms: this.makeTab('Rooms', 'rooms'),
            accuracy: this.makeTab('Accuracy', 'accuracy'),
            pool: this.makeTab('Pool', 'pool'),
        };
        tabs.appendChild(this.tabButtons.rooms);
        tabs.appendChild(this.tabButtons.accuracy);
        tabs.appendChild(this.tabButtons.pool);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:inline-flex; align-items:center; flex-wrap:wrap; gap:4px 6px;';

        this.clearButton = document.createElement('button');
        this.clearButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.clearButton.addEventListener('click', () => this.onClearClicked());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText =
            'width:18px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:13px; line-height:1; cursor:pointer;';
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            this.syncTabButton();
        });

        this.exportButton = document.createElement('button');
        this.exportButton.textContent = 'Export';
        this.exportButton.title = 'Copy the whole fight record as text, so it can be looked at somewhere else';
        this.exportButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.exportButton.addEventListener('click', () => this.exportAccuracy());

        // The export for public bug reports: the full record as JSON — raw
        // unrounded probabilities, attempts, reliability — with character names
        // hashed and character ids stripped, so it can be posted anywhere
        this.sanitizedButton = document.createElement('button');
        this.sanitizedButton.textContent = 'Sanitized';
        this.sanitizedButton.title =
            'Download the whole accuracy record as JSON with character names hashed and character ids ' +
            'stripped — use this one when attaching the record to a public bug report.';
        this.sanitizedButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.sanitizedButton.addEventListener('click', () => this.exportSanitized());

        this.recomputeButton = document.createElement('button');
        this.recomputeButton.textContent = 'Recompute';
        this.recomputeButton.title =
            'Throw away every cached clear-chance sim and simulate the rooms again. Use this after changing ' +
            'gear or a loadout — a plain equip does not always refresh a sim, so a cached result can be stale.';
        this.recomputeButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.recomputeButton.addEventListener('click', () => this.onRecomputeClicked());

        // A slow, timeout-heavy room (a hard combat tile) stops its sim on the
        // simulated-hours budget long before it pins the rate down, so its clear
        // chance reads "(capped)" with a wide band. With this on, Recompute lifts
        // that time cap and runs each room to its precision target — more precise,
        // but slower, so it is an opt-in toggle rather than the default.
        this.uncapped = false;
        this.uncappedButton = document.createElement('button');
        this.uncappedButton.textContent = 'Uncapped';
        this.uncappedButton.title =
            'Run Recompute with the sim’s time cap lifted, so slow rooms reach their precision target instead ' +
            'of stopping at a wide "(capped)" band. More precise but slower.';
        this.uncappedButton.addEventListener('click', () => {
            this.uncapped = !this.uncapped;
            this.paintUncapped();
        });

        // Calibration replay: fights are recorded passively across runs, so this
        // just re-sims whatever has accumulated for your current gear and reports
        // where the sim diverges from what actually happened
        this.replayButton = document.createElement('button');
        this.replayButton.textContent = 'Replay';
        this.replayButton.title =
            'Re-simulate the rooms recorded on your current gear and compare your real damage rate and the ' +
            'monster’s against the sim — the decomposition the clear rate alone cannot give. Fights accumulate ' +
            'passively as you play; a monster needs a handful before it can be judged.';
        this.replayButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.replayButton.addEventListener('click', () => this.onReplayClicked());

        // Raw tick capture: the moment-to-moment feed behind a rate mismatch —
        // stun gaps, ability cadence, damage per hit — as a file to hand over
        this.captureButton = document.createElement('button');
        this.captureButton.addEventListener('click', () => this.onCaptureClicked());

        // Shown only while an unsaved auto-stopped capture is held, so the held
        // fight can be thrown away deliberately instead of silently by the next
        // Capture press
        this.captureDiscardButton = document.createElement('button');
        this.captureDiscardButton.textContent = 'Discard';
        this.captureDiscardButton.title = 'Throw away the held capture without saving it';
        this.captureDiscardButton.addEventListener('click', () => {
            labTickCapture.clearCapture();
            this.paintCapture();
        });

        actions.appendChild(this.replayButton);
        actions.appendChild(this.captureButton);
        actions.appendChild(this.captureDiscardButton);
        actions.appendChild(this.uncappedButton);
        actions.appendChild(this.recomputeButton);
        actions.appendChild(this.exportButton);
        actions.appendChild(this.sanitizedButton);
        actions.appendChild(this.clearButton);
        actions.appendChild(closeBtn);
        header.appendChild(tabs);
        header.appendChild(actions);

        const list = document.createElement('div');
        list.className = 'mwi-lab-logs-list';
        list.style.cssText =
            'overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding:8px; max-height:calc(60vh - 44px);';

        panel.appendChild(header);
        panel.appendChild(list);
        document.body.appendChild(panel);

        this.setupDrag(panel, header);
        this.panel = panel;
        this.paintChrome();
        return panel;
    }

    makeTab(label, view) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', () => {
            if (this.view === view) return;
            this.view = view;
            this.resetArmed = false;
            this.paintChrome();
            this.render(false);
        });
        return button;
    }

    /** Light the active tab and word the Clear button for what it would clear */
    paintChrome() {
        for (const [view, button] of Object.entries(this.tabButtons || {})) {
            const on = this.view === view;
            button.style.cssText =
                'height:18px; border:0; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; ' +
                'padding:0 7px; white-space:nowrap; flex-shrink:0; ' +
                (on
                    ? 'background:rgba(77,151,255,0.95); color:#fff;'
                    : 'background:rgba(255,255,255,0.1); color:#9ec4ff;');
        }
        if (!this.clearButton) return;

        const accuracy = this.view === 'accuracy';
        // Only the accuracy tab has a record worth exporting; the room log is
        // one run and is on screen already
        if (this.exportButton) this.exportButton.style.display = accuracy ? '' : 'none';
        if (this.sanitizedButton) this.sanitizedButton.style.display = accuracy ? '' : 'none';
        // The pool is read-only browsing; it is cleared from Accuracy's own
        // two-click Reset, and a second destructive path would be a footgun
        this.clearButton.style.display = this.view === 'pool' ? 'none' : '';
        this.clearButton.textContent = accuracy ? (this.resetArmed ? 'Sure?' : 'Reset') : 'Clear';
        this.clearButton.title = accuracy
            ? 'Throw away every recorded fight and start the accuracy record over'
            : 'Clear the room log';
        this.clearButton.style.background = this.resetArmed ? 'rgba(255,100,100,0.55)' : 'rgba(255,255,255,0.12)';
        this.paintUncapped();
        this.paintReplay();
        this.paintCapture();
    }

    /** Enable Replay once the pool has fights on the current gear, and count them */
    paintReplay() {
        if (!this.replayButton) return;
        const fingerprint = this.simSource?.fingerprint?.() || null;
        const kept = labFightRecorder.recordingStatus(fingerprint).attempts;
        const canReplay = kept > 0 && !!this.simSource?.replay;
        this.replayButton.textContent = kept ? `Replay (${kept})` : 'Replay';
        this.replayButton.disabled = !canReplay;
        this.replayButton.style.opacity = canReplay ? '1' : '0.45';
        this.replayButton.style.cursor = canReplay ? 'pointer' : 'default';
    }

    /**
     * Paint the capture button for its three states: idle, recording (live tick
     * count), and stopped-holding-an-unsaved-capture (a capture that ended by
     * itself — the monster changed, or the time limit — still needs a way out
     * to a file; before this state existed those ticks were only ever one
     * Capture press away from silent erasure).
     */
    paintCapture() {
        if (!this.captureButton) return;
        const status = labTickCapture.captureStatus();
        const holdingUnsaved = !status.capturing && status.ticks > 0 && !status.savedAt;
        const dupes = status.duplicatesDiscarded > 0 ? ` ${status.duplicatesDiscarded} repeated ticks discarded.` : '';

        if (status.capturing) {
            this.captureButton.textContent = `Stop & save (${status.ticks})`;
            this.captureButton.title =
                'Stop the raw capture and download it. It records the moment-to-moment combat feed — every ' +
                'health, mana and counter tick — so the stun cadence and per-hit damage behind a rate mismatch ' +
                `can be read. Hand the file over.${dupes}`;
        } else if (holdingUnsaved) {
            this.captureButton.textContent = `Save capture (${status.ticks})`;
            this.captureButton.title =
                'The capture stopped by itself (the fight moved to a different monster, or the time limit) and ' +
                `is still holding these ticks. Save writes the file; Discard throws them away.${dupes}`;
        } else {
            this.captureButton.textContent = 'Capture';
            this.captureButton.title =
                'Record the raw combat feed of a fight — the tick-by-tick detail the endpoints do not keep, for ' +
                'diagnosing which mechanic the sim has wrong (stun uptime, ability cadence, per-hit damage). ' +
                'Start it, fight the room, then stop to download the file.';
        }
        this.captureButton.style.cssText =
            'height:18px; border:0; border-radius:4px; font-size:10px; cursor:pointer; padding:0 6px; ' +
            'white-space:nowrap; flex-shrink:0; ' +
            (status.capturing
                ? 'background:rgba(255,110,110,0.85); color:#fff;'
                : holdingUnsaved
                  ? 'background:rgba(255,190,80,0.85); color:#222;'
                  : 'background:rgba(255,255,255,0.12); color:#9ec4ff;');
        if (this.captureDiscardButton) {
            this.captureDiscardButton.style.cssText =
                'height:18px; border:0; border-radius:4px; font-size:10px; cursor:pointer; padding:0 6px; ' +
                'white-space:nowrap; flex-shrink:0; background:rgba(255,255,255,0.12); color:#ffb3b3; ' +
                (holdingUnsaved ? '' : 'display:none;');
        }
    }

    /** Show whether an uncapped Recompute is armed */
    paintUncapped() {
        if (!this.uncappedButton) return;
        this.uncappedButton.style.cssText =
            'height:18px; border:0; border-radius:4px; font-size:10px; cursor:pointer; padding:0 6px; ' +
            'white-space:nowrap; flex-shrink:0; ' +
            (this.uncapped
                ? 'background:rgba(77,151,255,0.95); color:#fff;'
                : 'background:rgba(255,255,255,0.12); color:#9ec4ff;');
    }

    /**
     * Clear every cached clear-chance sim and simulate the rooms again.
     *
     * The heavy lifting lives in the clear-rate feature, reached through the sim
     * source; this only drives the button so a run in progress cannot be started
     * twice and says what it is doing while it runs.
     */
    async onRecomputeClicked() {
        const button = this.recomputeButton;
        if (!button || button.disabled) return;
        if (!this.simSource?.recompute) return;

        const label = button.textContent;
        button.disabled = true;
        button.textContent = this.uncapped ? 'Recomputing (uncapped)…' : 'Recomputing…';
        button.style.opacity = '0.6';
        try {
            await this.simSource.recompute(this.uncapped === true);
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Recomputing sims failed:', error);
        } finally {
            button.disabled = false;
            button.textContent = label;
            button.style.opacity = '';
            this.render();
        }
    }

    /**
     * Re-simulate the recorded rooms and show where the sim diverges.
     *
     * The comparison itself lives in the clear-rate feature, reached through the
     * sim source, because it owns the simulator and the loadout. This drives the
     * button, drops the result on the panel, and switches to the accuracy view
     * where it is drawn above the record.
     */
    async onReplayClicked() {
        const button = this.replayButton;
        if (!button || button.disabled) return;
        if (!this.simSource?.replay) return;

        const label = button.textContent;
        button.disabled = true;
        button.textContent = 'Replaying…';
        button.style.opacity = '0.6';
        try {
            this.replayResult = await this.simSource.replay();
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Replaying recorded fights failed:', error);
            this.replayResult = { error: true };
        } finally {
            button.disabled = false;
            button.textContent = label;
            button.style.opacity = '';
        }

        this.view = 'accuracy';
        this.paintChrome();
        this.render(false);
    }

    /**
     * Start the raw tick capture, or stop it and download the file.
     *
     * Stop and save is one press: the file is the whole point of the capture, so
     * there is nothing to do between stopping and handing it over.
     */
    onCaptureClicked() {
        const status = labTickCapture.captureStatus();
        if (status.capturing) {
            labTickCapture.stopCapture();
            labTickCapture.downloadCapture();
        } else if (status.ticks > 0 && !status.savedAt) {
            // A capture that stopped by itself is still held; this press is the
            // save it never got. Starting fresh from here would erase it —
            // that path is only reachable once these ticks are saved or
            // discarded, so a Capture press can never silently destroy a fight.
            labTickCapture.downloadCapture();
        } else {
            // Best-effort label from whatever knows the current room; the capture
            // backfills the monster from the fight's own feed if this is empty
            const room = this.labContext?.room;
            const monsterHrid = this.fight?.monsterHrid || this.activeSession?.monsterHrid || room?.monsterHrid || null;
            const roomLevel =
                this.fight?.session?.roomLevel ||
                this.activeSession?.roomLevel ||
                Math.floor(Number(room?.recommendedLevel) || 0) ||
                0;
            labTickCapture.startCapture({
                monsterHrid,
                roomLevel,
                fingerprint: this.simSource?.fingerprint?.() || null,
            });
        }
        this.paintCapture();
    }

    /**
     * Clearing the room log is cheap and clearing the fight record is not — it
     * is the only copy of every fight you have had — so the destructive one
     * takes two clicks.
     */
    onClearClicked() {
        if (this.view !== 'accuracy') {
            this.clearLogs();
            return;
        }
        if (!this.resetArmed) {
            this.resetArmed = true;
            this.paintChrome();
            return;
        }
        this.resetArmed = false;
        this.paintChrome();
        Promise.resolve(this.simSource?.reset?.())
            .then(() => this.render())
            .catch((error) => console.error('[LabyrinthRoomLogs] Clearing the fight record failed:', error));
    }

    setupDrag(panel, header) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        header.style.touchAction = 'none';

        const onPointerDown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            const onPointerMove = (moveEvent) => {
                panel.style.left = `${moveEvent.clientX - offsetX}px`;
                panel.style.top = `${moveEvent.clientY - offsetY}px`;
                panel.style.right = 'auto';
            };
            const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerUp);
            };
            // Attach document listeners only for the duration of the drag
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        };
        header.addEventListener('pointerdown', onPointerDown);
    }

    renderIfOpen() {
        if (this.panel && this.panel.isConnected && this.panel.style.display !== 'none') {
            this.render();
        }
    }

    /**
     * Redraw the open view, keeping the scroll position where it was.
     *
     * Both renderers empty the list and rebuild it, which resets the browser's
     * scroll to the top — and they run on every experience/labyrinth update, so
     * a panel left open while a fight ticks was yanked back to the top several
     * times a second and could not be read. The offset is saved before the wipe
     * and restored after (after the await, for the async accuracy view). A tab
     * switch is the one redraw that *should* start at the top, so it opts out.
     *
     * @param {boolean} [preserveScroll=true] - Keep the current scroll offset
     */
    render(preserveScroll = true) {
        const list = this.panel?.querySelector('.mwi-lab-logs-list');
        const top = preserveScroll && list ? list.scrollTop : 0;
        const restore = () => {
            if (!preserveScroll) return;
            const current = this.panel?.querySelector('.mwi-lab-logs-list');
            if (current) current.scrollTop = top;
        };

        if (this.view === 'accuracy') {
            this.renderAccuracy().then(restore).catch(restore);
        } else if (this.view === 'pool') {
            this.renderPool();
            restore();
        } else {
            this.renderPanel();
            restore();
        }
    }

    /**
     * The recorder's pool, browsable: what has accumulated per monster and
     * level, with nothing filtered — incomplete and wounded-start fights are
     * part of what the pool holds. Read-only and synchronous: sims and
     * verdicts are the Replay button's job.
     */
    renderPool() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;
        this.renderToken++;
        list.textContent = '';

        const fingerprint = this.simSource?.fingerprint?.() || null;
        const attempts = labFightRecorder.recordedAttempts(this.poolAllGear ? undefined : fingerprint || undefined);
        const all = labFightRecorder.recordedAttempts();

        // Header: what the pool holds, the gear scope, and the save hook
        const header = document.createElement('div');
        header.style.cssText =
            'padding:4px 2px 3px; border-bottom:1px solid rgba(146,182,255,0.25); font-size:11px; color:#cfe0ff;';
        const scopeLine = document.createElement('div');
        scopeLine.style.cssText = 'display:flex; align-items:baseline; justify-content:space-between; gap:8px;';
        const title = document.createElement('span');
        const groups = summarizePool(attempts);
        title.textContent = `${attempts.length} fight${attempts.length === 1 ? '' : 's'} over ${groups.length} monster/level group${groups.length === 1 ? '' : 's'}`;
        scopeLine.appendChild(title);

        const toggle = document.createElement('span');
        toggle.style.cssText = 'color:#9ec4ff; cursor:pointer; text-decoration:underline; font-size:10px;';
        toggle.textContent = this.poolAllGear
            ? `all gear (${all.length} total) — show this gear only`
            : 'this gear — show all gear';
        toggle.addEventListener('click', () => {
            this.poolAllGear = !this.poolAllGear;
            this.render(false);
        });
        scopeLine.appendChild(toggle);
        header.appendChild(scopeLine);

        // How much of what the title just counted is a whole fight, and what
        // ended the rest. The counts above say nothing about it, and a pool
        // that is a fifth partials is a different pool from one that is not.
        const hygiene = poolHygiene(attempts);
        const hygieneLine = document.createElement('div');
        hygieneLine.style.cssText = 'color:#9fb4d8; font-size:10px; margin-top:2px;';
        hygieneLine.textContent = hygiene.text;
        hygieneLine.title =
            'complete: the fight was opened at its own new_battle snapshot and resolved to a known ' +
            'outcome — measured whole. The rest is what closed each fight. Fights recorded before ' +
            'these fields existed are counted apart rather than folded in.';
        header.appendChild(hygieneLine);

        // The migration's own note. These fights are still here, still browsable
        // and still in every export — they are simply not evidence about the
        // character you are now, because the fingerprint they carry describes
        // gear alone and says nothing about the levels the sim reads.
        const legacyFingerprint = all.filter((a) => !isCurrentFingerprintVersion(a)).length;
        if (legacyFingerprint > 0) {
            const versionLine = document.createElement('div');
            versionLine.style.cssText = 'color:#9fb4d8; font-size:10px; margin-top:2px;';
            versionLine.textContent =
                `${legacyFingerprint} of them predate the current build fingerprint — kept and readable, ` +
                'never pooled into a rate or a reliability reading';
            versionLine.title =
                'The fingerprint used to hash gear alone, so fights from either side of a combat level-up ' +
                'shared one value and were pooled as if they were fought by the same character. It now hashes ' +
                'the seven combat skill levels the sim reads as well. Fights recorded under the old definition ' +
                'are kept — nothing is deleted — but they are counted apart from new ones everywhere a reading ' +
                'is produced.';
            header.appendChild(versionLine);
        }

        const save = document.createElement('button');
        save.textContent = 'Save pool';
        save.title =
            'Download the whole recorded pool as JSON with this summary embedded. The file always carries ' +
            'every attempt, whatever the gear filter above shows.';
        save.style.cssText =
            'margin-top:3px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); ' +
            'color:#fff; font-size:10px; cursor:pointer; padding:0 6px;';
        save.addEventListener('click', () => {
            const wrote = labFightRecorder.downloadRecording({ poolSummary: groups, ...this.exportIdentity() });
            this.flashButton(save, wrote ? 'Saved ✓' : 'Nothing yet', 'Save pool');
        });
        header.appendChild(save);
        list.appendChild(header);

        if (!attempts.length) {
            list.appendChild(
                this.makeNote(
                    this.poolAllGear
                        ? 'No fights recorded yet. They accumulate automatically as you fight combat rooms.'
                        : 'No fights recorded on this gear yet — try "show all gear", or fight some combat rooms.'
                )
            );
            return;
        }

        const MAX_POOL_GROUPS = 40;
        for (const group of groups.slice(0, MAX_POOL_GROUPS)) {
            list.appendChild(this.renderPoolGroup(group));
        }
        if (groups.length > MAX_POOL_GROUPS) {
            list.appendChild(
                this.makeNote(`${groups.length - MAX_POOL_GROUPS} more monster/level groups — most-fought shown`)
            );
        }
    }

    /** One pool group: the summary line, and the recent attempts on click */
    renderPoolGroup(group) {
        const key = `${group.monsterHrid}:${group.bucket}`;
        const card = document.createElement('div');
        card.style.cssText =
            'margin-top:4px; padding:4px 6px; border:1px solid rgba(146,182,255,0.2); border-radius:6px; ' +
            'font-size:11px; color:#e8f0ff; cursor:pointer;';

        const span =
            group.levelLow === group.levelHigh ? `lvl ${group.roomLevel}` : `lvl ${group.levelLow}–${group.levelHigh}`;
        const head = document.createElement('div');
        head.style.cssText = 'display:flex; justify-content:space-between; gap:8px; font-weight:700;';
        head.textContent = `${group.monsterName || group.monsterHrid.split('/').pop()} · ${span}`;
        const score = document.createElement('span');
        score.textContent = `${group.clears}/${group.fights}`;
        score.style.color = group.winRate >= 0.5 ? '#7ddf8f' : '#ff9d9d';
        head.appendChild(score);
        card.appendChild(head);

        const line1 = document.createElement('div');
        line1.style.cssText = 'color:#cfe0ff;';
        line1.textContent =
            `win ${Math.round(group.winRate * 100)}% · ${group.meanSeconds.toFixed(1)}s/fight · ` +
            `dealt ${formatKMB(group.dps)}/s · taken ${formatKMB(group.takenPerSecond)}/s`;
        card.appendChild(line1);

        const line2 = document.createElement('div');
        line2.style.cssText = 'color:rgba(207,224,255,0.65); font-size:10px;';
        const bits = [
            group.critRate !== null ? `crit ${Math.round(group.critRate * 100)}% (${group.critDataFights})` : 'crit —',
            group.residualFights > 0
                ? `residual ${group.residualMean >= 0 ? '+' : ''}${formatKMB(Math.round(group.residualMean))} (${group.residualFights})`
                : null,
            `complete ${Math.round(group.completeFraction * 100)}%`,
            this.poolAllGear && group.gearCount > 1 ? `${group.gearCount} gear` : null,
        ].filter(Boolean);
        line2.textContent = bits.join(' · ');
        card.appendChild(line2);

        // How close the losses came. The win rate above says how often the room
        // goes your way; this says what the other fights were short by, which is
        // the number that decides whether another tier of gear flips the room or
        // whether it was never close. Absent below the gate rather than shown
        // thin — a median of two remainders reads exactly like a median of forty.
        const nearMiss = nearMissRemainder(group.attempts);
        if (nearMiss.text) {
            const line3 = document.createElement('div');
            line3.style.cssText = 'color:rgba(207,224,255,0.65); font-size:10px;';
            line3.textContent = nearMiss.text;
            line3.title =
                'Median monster HP still standing when a fight ended in a death or a timeout, as a share of ' +
                'its maximum. Only fights measured whole count, and any loss missing the HP fields is left ' +
                `out — n is what survived both, ${nearMiss.excluded} of ${nearMiss.losses} losses excluded.`;
            card.appendChild(line3);
        }

        const outcomes = Object.entries(group.outcomes)
            .map(([outcome, count]) => `${count} ${outcome}`)
            .join(', ');
        card.title = [
            outcomes,
            'residual: endpoint-reconciled damage the tick sum missed — a data-quality reading, not a rate',
            'complete: measured whole — opened at its new_battle snapshot and resolved to a known outcome',
            'Click to show the most recent attempts.',
        ].join('\n');

        card.addEventListener('click', () => {
            if (this.expandedPoolGroups.has(key)) this.expandedPoolGroups.delete(key);
            else this.expandedPoolGroups.add(key);
            this.render();
        });

        if (this.expandedPoolGroups.has(key)) {
            const MAX_POOL_ATTEMPT_ROWS = 15;
            for (const attempt of group.attempts.slice(-MAX_POOL_ATTEMPT_ROWS).reverse()) {
                const row = document.createElement('div');
                row.style.cssText =
                    'display:flex; gap:6px; align-items:baseline; font-size:10px; color:#cfe0ff; ' +
                    'padding:1px 0 0 8px;';
                const chip = document.createElement('span');
                chip.textContent = attempt.outcome;
                chip.style.color = OUTCOME_COLORS[attempt.outcome] || '#cfe0ff';
                row.appendChild(chip);
                const detail = document.createElement('span');
                const dealt = Number.isFinite(attempt.monsterDamage) ? attempt.monsterDamage : null;
                detail.textContent =
                    `lvl ${attempt.roomLevel} · ${Number(attempt.seconds).toFixed(0)}s` +
                    (dealt !== null ? ` · ${formatKMB(dealt)} dealt` : '') +
                    (attempt.complete !== true ? ' · partial' : '');
                row.appendChild(detail);
                card.appendChild(row);
            }
        }

        return card;
    }

    renderPanel() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;
        this.renderToken++;
        list.textContent = '';

        const sessions = (this.activeSession ? [this.activeSession, ...this.sessions] : this.sessions).slice(
            0,
            this.logSize()
        );
        if (!sessions.length) {
            list.appendChild(this.makeNote('No logs yet'));
            return;
        }

        // Grouped by floor because a floor is the unit a labyrinth run is
        // actually planned in — throughput over one room says far less than
        // throughput over the thirty of them you have to get through
        for (const group of groupByFloor(sessions)) {
            list.appendChild(this.renderFloorHeader(group));
            for (const session of group.sessions) list.appendChild(this.renderSessionCard(session));
        }
    }

    renderFloorHeader(group) {
        const summary = floorSummary(group.sessions);

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:2px; ' +
            'padding:3px 2px 2px; border-bottom:1px solid rgba(146,182,255,0.25); font-size:11px;';

        const name = document.createElement('span');
        name.style.cssText = 'color:#9ec4ff; font-weight:700;';
        name.textContent = group.floor > 0 ? `Floor ${group.floor}` : 'Earlier rooms';
        header.appendChild(name);

        const stats = document.createElement('span');
        stats.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.85);';
        const parts = [`${summary.rooms} room${summary.rooms === 1 ? '' : 's'}`];
        if (summary.cleared < summary.rooms) parts.push(`${summary.cleared} cleared`);
        if (summary.seconds > 0) parts.push(timeReadable(Math.round(summary.seconds)));
        parts.push(summary.xpPerHour ? `${formatKMB(summary.xpPerHour)} xp/h` : 'xp not measured');
        stats.textContent = parts.join(' · ');
        header.appendChild(stats);

        header.title = [
            group.floor > 0 ? `Floor ${group.floor}` : 'Rooms logged before floors were recorded',
            `${summary.rooms} rooms logged, ${summary.cleared} of them cleared`,
            summary.seconds > 0 ? `${Math.round(summary.seconds)}s spent in them` : '',
            summary.xp > 0 ? `${Math.round(summary.xp).toLocaleString()} experience gained` : '',
            summary.xpPerHour
                ? 'Rate is measured experience over measured time, across every room on this floor, ' +
                  `plus ${ROOM_TRAVEL_SECONDS}s of travel per room — the same denominator the forecast uses, ` +
                  'so the two rates can be compared'
                : 'Experience is measured by the change in your skill totals, so rooms logged before that was recorded show none',
        ]
            .filter(Boolean)
            .join('\n');
        return header;
    }

    makeNote(text) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px; color:#9ab0d8; text-align:center; padding:8px; line-height:1.4;';
        note.textContent = text;
        return note;
    }

    /** How a replay metric value reads, by which metric it is */
    formatReplayValue(key, value) {
        if (!Number.isFinite(value)) return '—';
        if (key === 'clearRate' || key === 'hitRate' || key === 'critRate') return `${Math.round(value * 100)}%`;
        if (key === 'secondsPerFight') return `${value.toFixed(1)}s`;
        // A ratio, not a rate: two decimals, because the whole question is
        // whether 0.26 ticks per swing is really 0.10
        if (key === 'dotPerSwing') return value.toFixed(2);
        if (key === 'dmgPerHit') return formatKMB(value);
        return `${formatKMB(value)}/s`;
    }

    /** How one attack-tally source reads: an ability's name, or the engine's own label */
    prettyDamageSource(source) {
        const key = String(source || '');
        if (key === 'autoAttack') return 'Auto attack';
        if (key === 'damageOverTime') return 'Damage over time';
        if (!key.includes('/')) return key.charAt(0).toUpperCase() + key.slice(1);
        const tail = key.split('/').pop().replace(/_/g, ' ');
        return tail.replace(/\b\w/g, (c) => c.toUpperCase()) || key;
    }

    /**
     * The sim's damage split by what dealt it, under a group's metric rows.
     *
     * The rates above say the sim's damage-per-hit is off; this says what the
     * sim thinks it is made of. The rates themselves count swings alone on both
     * sides, so a damage-over-time tick never enters them — but it is still real
     * damage the swing that applied it set up, and its SHARE of what the sim
     * dealt is what decides whether a soft-hit gap is the monster's mitigation
     * or a mix the sim gets wrong.
     *
     * @param {Object} tally - `group.simTally` from the replay comparison
     * @returns {HTMLElement|null}
     */
    renderSimTally(tally) {
        const sources = Array.isArray(tally?.sources) ? tally.sources.filter((row) => row.landedHits > 0) : [];
        if (!sources.length) return null;

        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin:3px 0 4px; padding-left:6px; border-left:2px solid rgba(146,182,255,0.25);';

        const head = document.createElement('div');
        head.style.cssText = 'color:#9ab0d8; font-size:10px; margin-bottom:1px;';
        head.textContent = 'Sim damage by source — share of landed hits, mean damage';
        wrap.appendChild(head);

        for (const row of sources) {
            const line = document.createElement('div');
            line.style.cssText = 'display:flex; justify-content:space-between; gap:8px; padding:1px 0; font-size:10px;';

            const left = document.createElement('span');
            left.style.cssText = 'color:#9ab0d8;';
            left.textContent = this.prettyDamageSource(row.source);

            const right = document.createElement('span');
            right.style.cssText = 'color:#e6eefc; text-align:right;';
            const share = `${(row.shareOfLandedHits * 100).toFixed(1)}%`;
            const mean = Number.isFinite(row.meanDamage) ? formatKMB(row.meanDamage) : '—';
            right.textContent = `${share} · ${mean} avg · ${formatKMB(row.totalDamage)} total`;

            line.appendChild(left);
            line.appendChild(right);
            wrap.appendChild(line);
        }

        return wrap;
    }

    /**
     * The calibration replay's verdict, drawn above the accuracy record.
     *
     * One block per room replayed: the diagnosis in a sentence, then the four
     * rates with what you did, what the sim predicted, and how far apart they are.
     *
     * @param {Object} result - From the sim source's `replay`
     * @returns {HTMLElement}
     */
    renderReplayResult(result) {
        const box = document.createElement('div');
        box.style.cssText =
            'border:1px solid rgba(146,182,255,0.35); border-radius:6px; background:rgba(18,26,40,0.95); ' +
            'padding:7px 8px; margin-bottom:8px; font-size:11px; line-height:1.35;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:700; color:#cfe0ff; margin-bottom:4px;';
        title.textContent = 'Calibration replay';
        box.appendChild(title);

        if (result?.error) {
            box.appendChild(this.makeNote('The replay could not run — the sim or loadout was unavailable.'));
            return box;
        }
        if (!result?.groups?.length) {
            const pool = result?.pool;
            const note =
                pool && pool.attempts > 0
                    ? `${pool.attempts} fight${pool.attempts === 1 ? '' : 's'} recorded on this gear over ` +
                      `${pool.monsters} monster${pool.monsters === 1 ? '' : 's'}, but none has the handful of ` +
                      `attempts a rate needs yet. Fights accumulate as you play — keep going and check back.`
                    : 'No fights recorded on this gear yet. They accumulate automatically as you fight combat ' +
                      'rooms — no need to do anything, just play and check back.';
            box.appendChild(this.makeNote(note));
            return box;
        }

        const colour = { above: '#ff9a6b', below: '#ff9a6b', consistent: '#8fe6a0', insufficient: '#9ab0d8' };

        for (const group of result.groups) {
            const head = document.createElement('div');
            head.style.cssText = 'font-weight:700; color:#f2f7ff; margin:4px 0 2px;';
            const name = group.monsterName || this.prettyMonsterName(group.monsterHrid);
            // A bucket may pool a few nearby levels; say the span, not a false point
            const lvl =
                Number.isFinite(group.levelLow) && group.levelHigh > group.levelLow
                    ? `lvl ${group.levelLow}–${group.levelHigh}`
                    : `lvl ${group.roomLevel}`;
            head.textContent = `${name} · ${lvl} · ${group.fights} fight${group.fights === 1 ? '' : 's'}, ${
                group.clears
            } cleared`;
            box.appendChild(head);

            const diag = document.createElement('div');
            diag.style.cssText = 'color:#d7e6ff; margin-bottom:3px;';
            diag.textContent = group.diagnosis;
            box.appendChild(diag);

            for (const metric of group.metrics) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; gap:8px; padding:1px 0;';

                const left = document.createElement('span');
                left.style.cssText = 'color:#9ab0d8;';
                left.textContent = metric.label;

                const right = document.createElement('span');
                right.style.cssText = `color:${colour[metric.verdict] || '#e6eefc'}; text-align:right;`;
                const you = this.formatReplayValue(metric.key, metric.observed);
                const sim = this.formatReplayValue(metric.key, metric.predicted);
                let tag = '';
                if (metric.verdict === 'insufficient') {
                    tag = ' (too few)';
                } else if (Number.isFinite(metric.deviationPct)) {
                    const sign = metric.deviationPct >= 0 ? '+' : '−';
                    tag = ` (${sign}${Math.abs(metric.deviationPct).toFixed(0)}%)`;
                }
                right.textContent = `${you} vs sim ${sim}${tag}`;

                row.appendChild(left);
                row.appendChild(right);
                box.appendChild(row);
            }

            const tally = this.renderSimTally(group.simTally);
            if (tally) box.appendChild(tally);
        }

        const save = document.createElement('button');
        save.textContent = 'Save comparison';
        save.style.cssText =
            'margin-top:6px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); ' +
            'color:#9ec4ff; font-size:10px; cursor:pointer; padding:0 6px;';
        save.title =
            'Download the recorded attempts together with this replay comparison — observed vs sim per rate, ' +
            'and the verdict — so the whole accuracy check can be handed over or kept';
        // Embed the comparison beside the raw attempts, so one file is the whole
        // check rather than only the half a bare recording carries. Identity
        // rides along so a hand-over says whose record it is; the sanitized
        // export is the one that strips it.
        save.addEventListener('click', () =>
            labFightRecorder.downloadRecording({ replay: result, ...this.exportIdentity() })
        );
        box.appendChild(save);

        return box;
    }

    renderSessionCard(session) {
        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.25); border-radius:5px; background:rgba(22,31,45,0.92); padding:6px 7px; font-size:11px; line-height:1.3;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:3px; font-weight:700;';

        const name = document.createElement('span');
        name.textContent = session.roomLevel > 0 ? `${session.skillName} Lv.${session.roomLevel}` : session.skillName;
        header.appendChild(name);

        const endedAt = session.endedAt || Date.now();
        const seconds = Math.max(0, Math.round((endedAt - session.startedAt) / 1000));
        const time = document.createElement('span');
        time.style.cssText = 'opacity:0.8; font-weight:600;';
        time.textContent = `${seconds}s`;
        header.appendChild(time);

        if (session === this.activeSession) {
            header.appendChild(this.makeChip('Live', 'rgba(61,220,132,0.2)', '#3ddc84'));
        } else if (session.mode === 'combat' && session.cleared) {
            header.appendChild(this.makeChip('Cleared', 'rgba(61,220,132,0.2)', '#3ddc84'));
        } else if (session.incomplete || !session.completed) {
            header.appendChild(this.makeChip('Incomplete', 'rgba(244,124,71,0.22)', '#ffba92'));
        }
        card.appendChild(header);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.9); margin-bottom:3px;';
        if (session.mode === 'combat') {
            meta.textContent = this.combatMeta(session);
            card.title = this.combatTooltip(session).join('\n');
        } else if (session.mode === 'enhancing') {
            const successPct = (session.successRate * 100).toFixed(0);
            const doublePct = (session.doubleChance * 100).toFixed(0);
            meta.textContent = `Success ${successPct}% / Double ${doublePct}% | Enh +${session.currentEnhLevel}/+${session.targetLevel}`;
        } else {
            const successPct = (session.successRate * 100).toFixed(0);
            const doublePct = (session.doubleChance * 100).toFixed(0);
            const progressPct =
                session.targetWorkValue > 0
                    ? Math.min(100, (session.currentWorkValue / session.targetWorkValue) * 100).toFixed(0)
                    : '0';
            meta.textContent = `Success ${successPct}% / Double ${doublePct}% | Work ${Math.floor(session.progressPerAction)} | Progress ${progressPct}%`;
        }
        card.appendChild(meta);

        if (session.mode !== 'combat') {
            const check = this.skillingCheck(session);
            if (check) {
                const line = document.createElement('div');
                line.style.cssText = 'font-size:10px; color:#9ec4ff; margin-bottom:3px;';
                line.textContent = check;
                card.appendChild(line);
                card.title = this.skillingTooltip(session).join('\n');
            }
        }

        const actionsRow = document.createElement('div');
        actionsRow.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:2px;';
        const actions = Array.isArray(session.actions) ? session.actions : [];
        if (!actions.length) {
            const dash = document.createElement('span');
            dash.style.color = OUTCOME_COLORS.unknown;
            dash.textContent = session.mode === 'combat' ? 'fighting…' : '--';
            actionsRow.appendChild(dash);
        }
        actions.forEach((action, index) => {
            if (index > 0) {
                const sep = document.createElement('span');
                sep.style.opacity = '0.5';
                sep.textContent = '-';
                actionsRow.appendChild(sep);
            }
            const node = document.createElement('span');
            node.style.cssText = `font-weight:700; color:${OUTCOME_COLORS[action.outcome] || OUTCOME_COLORS.unknown};`;
            node.textContent = action.text || '?';
            actionsRow.appendChild(node);
        });
        card.appendChild(actionsRow);

        return card;
    }

    /**
     * The skilling room's own results check: what the calculator predicted, what
     * actually happened, and what the room returned.
     *
     * Three numbers rather than two. The server states the rate it is using with
     * every action, so a skilling room can be checked twice over — the
     * calculator against the stated rate, which needs no sample at all, and the
     * stated rate against the actions, which does.
     *
     * @param {Object} session - A skilling or enhancing session
     * @returns {string} Empty when there is nothing to compare
     */
    skillingCheck(session) {
        const pct = (v) => `${Math.round(v * 100)}%`;
        const parts = [];

        const actions = Math.max(0, Math.floor(Number(session.actionCount) || 0));
        const predicted = session.forecast?.successChance;
        if (actions > 0) {
            const observed = (Number(session.successCount) || 0) / actions;
            parts.push(
                Number.isFinite(predicted)
                    ? `Calc ${pct(predicted)} → hit ${pct(observed)} of ${actions}`
                    : `Hit ${pct(observed)} of ${actions}`
            );
        }

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const expected = session.forecast?.expectedSeconds;
        if (session.completed && Number.isFinite(expected) && expected > 0) {
            parts.push(`${Math.round(seconds)}s vs ${Math.round(expected)}s est`);
        }

        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0 && seconds > 0) parts.push(`${formatKMB((xp / seconds) * 3600)} xp/h`);

        return parts.join(' | ');
    }

    skillingTooltip(session) {
        const pct = (v, places = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');
        const lines = [`${session.skillName} Lv.${session.roomLevel}`];

        const actions = Math.max(0, Math.floor(Number(session.actionCount) || 0));
        const forecast = session.forecast || {};
        if (Number.isFinite(forecast.successChance)) {
            lines.push(`Toolasha's formula predicted a ${pct(forecast.successChance)} success rate`);
        }
        if (Number.isFinite(session.successRate)) {
            lines.push(`The server says the rate is ${pct(session.successRate)}`);
        }
        if (
            Number.isFinite(forecast.successChance) &&
            Number.isFinite(session.successRate) &&
            Math.abs(forecast.successChance - session.successRate) > 0.005
        ) {
            lines.push('Those disagree, which is the formula being wrong rather than a run of bad luck');
        }
        if (actions > 0) {
            lines.push(`${session.successCount} of ${actions} actions succeeded, ${session.doubleCount} doubled`);
        }

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        if (Number.isFinite(forecast.expectedSeconds) && forecast.expectedSeconds > 0) {
            lines.push(`Expected to take ${Math.round(forecast.expectedSeconds)}s; took ${Math.round(seconds)}s`);
        }
        if (Number.isFinite(forecast.clearChance)) {
            lines.push(`Given a ${pct(forecast.clearChance)} chance of clearing inside the room's two minutes`);
        }

        const xp = Math.max(0, Number(session.xp) || 0);
        lines.push(
            xp > 0
                ? `Gained ${Math.round(xp).toLocaleString()} experience, measured from your skill totals`
                : 'No experience change was measured for this room'
        );
        return lines;
    }

    /** The one line under a fight's heading: what was promised against what happened */
    combatMeta(session) {
        const tally = fightTally(session.actions);
        const parts = [session.predicted === null ? 'Sim —' : `Sim ${(session.predicted * 100).toFixed(0)}%`];

        // Only fights watched on the combat view are classified (win/death/
        // timeout); the server's entryCount counts every attempt, including those
        // that ran while you were on another tab. Show the server total so a run
        // spent mostly off-screen does not read as if those attempts never
        // happened — with the watched subset named, since that is all the
        // died/timed-out breakdown can speak for.
        const serverAttempts = Math.floor(Number(session.entryCount) || 0);
        if (tally.total) {
            let result = `Won ${tally.clears}/${tally.total} (${Math.round(tally.rate * 100)}%)`;
            if (serverAttempts > tally.total) result += ` · ${serverAttempts} total`;
            parts.push(result);
        } else if (serverAttempts > 0) {
            parts.push(`${serverAttempts} attempt${serverAttempts === 1 ? '' : 's'}, none watched`);
        } else {
            parts.push('No result yet');
        }
        const shape = failureShape(tally);
        if (shape) parts.push(shape);

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0 && seconds > 0) parts.push(`${formatKMB((xp / seconds) * 3600)} xp/h`);

        return parts.join(' | ');
    }

    combatTooltip(session) {
        const tally = fightTally(session.actions);
        const lines = [`${session.skillName} Lv.${session.roomLevel}`];

        lines.push(
            session.predicted === null
                ? 'No clear chance was simulated for this room — calculate its tile and the next fights get judged'
                : `The sim gave this room a ${(session.predicted * 100).toFixed(1)}% chance of clearing`
        );
        if (tally.total) {
            lines.push(`Logged ${tally.clears} clears in ${tally.total} attempts (${Math.round(tally.rate * 100)}%)`);
        }
        const shape = failureShape(tally);
        if (shape) lines.push(`Losing by: ${shape}`);
        if (tally.unknown) lines.push(`${tally.unknown} attempt(s) ended out of sight and are not counted`);
        if (session.entryCount > tally.total) {
            lines.push(
                `The server has counted ${session.entryCount} entries for this room, including earlier sessions`
            );
        }
        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0) {
            lines.push(
                `Gained ${Math.round(xp).toLocaleString()} experience over ${Math.round(seconds)}s in this room`
            );
            lines.push('Measured from your skill totals, so losing attempts count toward it as well as the win');
        }
        if (Number.isFinite(session.forecast?.xpPerHour) && session.forecast.xpPerHour > 0) {
            lines.push(`The sim expected ${formatKMB(session.forecast.xpPerHour)} experience per hour here`);
        }
        lines.push('Wins show how long they took; losses show the health the monster had left');
        return lines;
    }

    // -------------------------------------------------------------------------
    // Sim accuracy
    //
    // The room list covers one run. This covers every fight ever recorded,
    // because that is the only sample large enough to say anything: a room that
    // says 24% and loses three times running has said nothing, and the same
    // room losing twenty-one times running has said plenty.
    // -------------------------------------------------------------------------

    async renderAccuracy() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;

        const token = ++this.renderToken;
        list.textContent = '';

        if (!this.simSource?.accuracy) {
            list.appendChild(
                this.makeNote('The labyrinth clear rate feature is off, so no fights are being recorded.')
            );
            return;
        }

        let snapshot;
        try {
            snapshot = await this.simSource.accuracy({ since: this.sinceBaseline });
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the fight record failed:', error);
            list.appendChild(this.makeNote('Could not read the fight record.'));
            return;
        }
        // A slow read that lands after the user has moved on describes a view
        // that is no longer showing
        if (token !== this.renderToken || this.view !== 'accuracy') return;

        list.textContent = '';

        // The calibration replay, when one has been run, sits above the record —
        // it answers "why is the rate wrong" that the record only flags
        if (this.replayResult) list.appendChild(this.renderReplayResult(this.replayResult));

        const { rows, summary } = snapshot;
        if (!rows.length) {
            list.appendChild(
                this.makeNote(
                    snapshot.since
                        ? 'Nothing recorded since the mark yet.'
                        : 'No labyrinth fights recorded yet. Fight some combat rooms and they will show up here.'
                )
            );
            // Still offered, or a view showing nothing would have no way back
            if (snapshot.baselineAt) list.appendChild(this.renderBaselineLine(snapshot));
            return;
        }

        this.lastAccuracy = snapshot;
        list.appendChild(this.renderAccuracySummary(summary, snapshot));

        // The per-attempt calibration check, from the recorder's pool — each
        // fight there carries the prediction that was on screen when it was
        // recorded, which the per-room record cannot reconstruct
        const pool = labFightRecorder.recordedAttempts();
        if (pool.length) list.appendChild(this.renderReliability(pool));

        // Each room type's pooled reading followed by its own levels, in the
        // game's order and by level within it. Every pooled row first and every
        // level after them read as two unrelated lists, and the levels were
        // ordered by how often each happened to be fought — which is no order
        // at all if you are looking for a particular room.
        const drawn = new Set();
        for (const group of snapshot.bySubject || []) {
            const levels = rows.filter((row) => row.subjectHrid === group.subjectHrid);
            levels.forEach((row) => drawn.add(row));

            list.appendChild(this.renderSubjectRow(group, levels.length));
            if (!this.expandedSubjects.has(group.subjectHrid)) continue;
            for (const row of levels) list.appendChild(this.renderAccuracyRow(row));
        }
        // Anything the pooling did not cover, rather than silently dropped
        for (const row of rows) if (!drawn.has(row)) list.appendChild(this.renderAccuracyRow(row));
    }

    /**
     * One room type, pooled across every level of it.
     *
     * Drawn above the per-level rows because it answers the question they
     * cannot: a level with nine fights is always "consistent", and nine levels
     * of that can still be a sim ten points high on every one of them.
     *
     * @param {Object} group - From `accuracyBySubject`
     * @param {number} levels - How many per-level rows it is hiding
     * @returns {HTMLElement}
     */
    renderSubjectRow(group, levels = 0) {
        const pct = (v, places = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');
        const open = this.expandedSubjects.has(group.subjectHrid);

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.18); border-left:3px solid rgba(146,182,255,0.5); ' +
            'border-radius:5px; background:rgba(18,26,38,0.92); padding:5px 7px; font-size:11px; ' +
            'line-height:1.35; cursor:pointer;';
        card.title = open ? 'Hide the levels of this room' : `Show the ${levels} level(s) behind this reading`;
        card.addEventListener('click', () => {
            if (open) this.expandedSubjects.delete(group.subjectHrid);
            else this.expandedSubjects.add(group.subjectHrid);
            this.render();
        });

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; gap:6px; font-weight:700;';
        const name = document.createElement('span');
        const caret = document.createElement('span');
        caret.textContent = open ? '−' : '+';
        caret.style.cssText = 'display:inline-block; width:10px; color:#9ec4ff;';
        name.append(caret, `${this.prettyMonsterName(group.subjectHrid)} — all levels`);
        const record = document.createElement('span');
        record.style.cssText = 'opacity:0.85;';
        record.textContent = `${group.clears}/${group.attempts}`;
        header.append(name, record);
        card.appendChild(header);

        const line = document.createElement('div');
        line.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
        const numbers = document.createElement('span');
        numbers.style.color = 'rgba(221,232,255,0.92)';
        if (group.judged > 0) {
            const sign = group.offBy >= 0 ? '+' : '';
            numbers.textContent =
                `Sim ${pct(group.predicted)} → actual ${pct(group.observed)} · ` +
                `${sign}${group.offBy.toFixed(1)} clears against ${group.expected.toFixed(1)} expected`;
        } else {
            numbers.textContent = `Never simmed — you clear ${pct(group.observed)}`;
        }
        line.appendChild(numbers);
        const colour = VERDICT_COLORS[group.verdict];
        if (colour) line.appendChild(this.makeChip(group.verdict, 'rgba(255,255,255,0.08)', colour));
        card.appendChild(line);

        const spread = document.createElement('div');
        spread.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
        spread.textContent =
            (group.lowestLevel === group.highestLevel
                ? `Lv.${group.lowestLevel} only`
                : `${group.levels} levels, Lv.${group.lowestLevel}–${group.highestLevel}`) +
            (open ? '' : ' — click to open');
        card.appendChild(spread);
        return card;
    }

    /**
     * Put the whole record on the clipboard.
     *
     * The record is the only thing that can say whether the model is wrong, and
     * it lives in one browser's IndexedDB where nobody can look at it. Text
     * rather than JSON because the point is that a person reads it.
     */
    async exportAccuracy() {
        const snapshot = this.lastAccuracy || (await this.simSource?.accuracy?.());
        if (!snapshot?.rows?.length) {
            this.flashExport('Nothing recorded yet');
            return;
        }

        const report = accuracyReport(snapshot, { name: (hrid) => this.prettyMonsterName(hrid), meta: exportMeta() });
        try {
            await navigator.clipboard.writeText(report);
            this.flashExport('Copied ✓');
        } catch (error) {
            // A clipboard that refuses is not a reason to lose the report
            console.error('[LabyrinthRoomLogs] Copying the accuracy report failed:', error);
            console.log(report);
            this.flashExport('In console');
        }
    }

    /**
     * Who the record belongs to, for an export. Sanitized mode hashes the name
     * and strips the id; the plain JSON export keeps both, since a private
     * hand-over across characters needs to say whose record it is.
     * @returns {{characterId: string|null, characterName: string|null}}
     */
    exportIdentity() {
        try {
            return {
                characterId: dataManager.getCurrentCharacterId?.() || null,
                characterName:
                    typeof dataManager.getCurrentCharacterName === 'function'
                        ? dataManager.getCurrentCharacterName() || null
                        : null,
            };
        } catch {
            return { characterId: null, characterName: null };
        }
    }

    /**
     * The whole accuracy record as sanitized JSON — the export for public bug
     * reports. Character names are hashed to a stable stand-in and character
     * ids stripped; everything else, including the unrounded probabilities the
     * text report rounds away, goes out as-is.
     */
    async exportSanitized() {
        let snapshot = null;
        try {
            snapshot = this.lastAccuracy || (await this.simSource?.accuracy?.()) || null;
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the fight record for export failed:', error);
        }
        const attempts = labFightRecorder.recordedAttempts();
        if (!snapshot?.rows?.length && !attempts.length) {
            this.flashButton(this.sanitizedButton, 'Nothing yet', 'Sanitized');
            return;
        }

        const file = buildAccuracyExport({
            snapshot,
            attempts,
            replay: this.replayResult || null,
            character: this.exportIdentity(),
        });
        const saved = downloadJson({ ...sanitizeExport(file), sanitized: true }, 'toolasha-labyrinth-accuracy');
        this.flashButton(this.sanitizedButton, saved ? 'Saved ✓' : 'Failed', 'Sanitized');
    }

    /**
     * @param {string} text - What the button should say for a moment
     */
    flashExport(text) {
        this.flashButton(this.exportButton, text, 'Export');
    }

    /**
     * Show a moment's feedback on a header button, then restore its label.
     * @param {HTMLElement} button - Which button
     * @param {string} text - What it should say for a moment
     * @param {string} restore - What it says the rest of the time
     */
    flashButton(button, text, restore) {
        if (!button) return;
        button.textContent = text;
        this._buttonFlashes = this._buttonFlashes || new Map();
        clearTimeout(this._buttonFlashes.get(button));
        this._buttonFlashes.set(
            button,
            setTimeout(() => {
                if (button.isConnected) button.textContent = restore;
            }, 1600)
        );
    }

    renderAccuracySummary(summary, snapshot = {}) {
        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.35); border-radius:5px; background:rgba(30,44,64,0.95); padding:6px 7px; ' +
            'font-size:11px; line-height:1.4;';

        const head = document.createElement('div');
        head.style.cssText = 'font-weight:700; color:#9ec4ff;';
        head.textContent = `${summary.attempts} fights over ${summary.buckets} monster/level rooms`;
        card.appendChild(head);

        // The headline judges only the current-model cohort — fights folded with
        // a prediction in effect at the time, under the full-kit sim. Older
        // fights were judged by a different model, so they are counted in a note
        // rather than pooled. Snapshots without a cohort (hand-built, or from an
        // older build) fall back to the pooled figures.
        const cohort = summary.cohort || null;
        const expected = cohort ? cohort.expected : (summary.expected ?? null);
        const judged = cohort ? cohort.judged : summary.judged;
        const judgedClears = cohort ? cohort.judgedClears : summary.judgedClears;
        const sd = cohort ? cohort.sd : summary.sd;
        const sigma = cohort ? cohort.sigma : summary.sigma;

        const body = document.createElement('div');
        body.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.92);';
        if (expected === null) {
            body.textContent =
                cohort && cohort.legacyExcluded > 0
                    ? 'No fights under the current sim model have a rate to be judged against yet.'
                    : 'None of them have a simulated rate to compare against yet.';
        } else {
            const off = judgedClears - expected;
            const direction = off >= 0 ? 'above' : 'below';
            // With the spread beside it, because a shortfall of ten is a shrug
            // over one sample and a finding over another, and the figure alone
            // cannot say which
            const spread = sd ? ` — ${Math.abs(sigma).toFixed(1)} sd` : '';
            body.textContent =
                `Over the ${judged} it had a rate for, the sim expected ${expected.toFixed(1)} clears ` +
                `and you got ${judgedClears} — ${Math.abs(off).toFixed(1)} ${direction}${spread}.`;
        }
        card.appendChild(body);

        if (sd) {
            const scale = document.createElement('div');
            scale.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
            scale.textContent =
                Math.abs(sigma) < 2
                    ? 'Within what chance allows for — a record this size wanders by about ' +
                      `${sd.toFixed(1)} clears on its own.`
                    : 'Further out than chance comfortably explains — a record this size wanders by about ' +
                      `${sd.toFixed(1)} clears on its own.`;
            card.appendChild(scale);
        }

        if (cohort && cohort.legacyExcluded > 0) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
            note.textContent = `${cohort.legacyExcluded} older fights from a previous sim model excluded`;
            note.title =
                'These were judged by predictions the sim no longer makes — it has since switched to full ' +
                'monster abilities — so they are kept in the per-room rows but left out of the headline.';
            card.appendChild(note);
        }

        card.appendChild(this.renderBaselineLine(snapshot));

        if (summary.contested > 0) {
            const flag = document.createElement('div');
            const chance = summary.contestedByChance;
            // A 95% interval is wrong one room in twenty by construction, so a
            // raw count of contradictions is not a finding until it is set
            // against the number this record would throw up anyway
            const alarming = chance === null || summary.contested > chance * 2;
            flag.style.cssText = `font-size:10px; font-weight:700; color:${alarming ? '#ff8a8a' : 'rgba(221,232,255,0.7)'};`;
            flag.textContent =
                `${summary.contested} room${summary.contested === 1 ? '' : 's'} the record contradicts` +
                (chance === null ? '' : ` — about ${chance.toFixed(1)} would be flagged by chance alone`);
            card.appendChild(flag);
        }
        return card;
    }

    /**
     * The reliability report: recorded attempts grouped by the clear chance
     * that was stored with each, so a band's expected clears can be read
     * against what it delivered. Computed over the current cohort only — an
     * attempt is in it when its prediction came from the full-kit sim model AND
     * its fingerprint came from the current definition. Everything else is
     * counted in a note, never pooled.
     *
     * A thin current cohort says "too few to call" and stops there. The
     * tempting alternative — widening until the figure looks solid — is exactly
     * the pooling the cohort split exists to prevent, and after a fingerprint
     * migration it is at its most tempting, because the pool can be full of
     * history and the cohort nearly empty.
     *
     * @param {Array<Object>} attempts - The recorder's pool, all fingerprints
     * @returns {HTMLElement}
     */
    renderReliability(attempts) {
        const { current, legacy, legacyModel, legacyFingerprint } = splitModelCohorts(attempts);
        const report = calibrationReport(current);

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.35); border-radius:5px; background:rgba(30,44,64,0.95); ' +
            'padding:6px 7px; font-size:11px; line-height:1.4;';
        card.title =
            'Each recorded fight keeps the clear chance the sim was claiming when it happened. Grouped by that ' +
            'chance, a well-calibrated sim clears about what each band promises. The Brier score is the mean ' +
            'squared gap between prediction and outcome — lower is better, and a coin-toss guess scores 0.25.';

        const head = document.createElement('div');
        head.style.cssText = 'font-weight:700; color:#9ec4ff;';
        head.textContent = 'Reliability — stored predictions vs outcomes';
        card.appendChild(head);

        const body = document.createElement('div');
        body.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.92);';
        if (report.count === 0) {
            body.textContent = legacy.length
                ? 'No fight on the current build carries a stored prediction yet — the fights below were recorded ' +
                  'under an older sim model or an older build fingerprint and are not pooled with new ones. ' +
                  'They accumulate again as simmed rooms are fought.'
                : 'No recorded fight carries a stored prediction yet — they accumulate as simmed rooms are fought.';
            card.appendChild(body);
        } else if (!report.enough) {
            // Honest degradation: the arithmetic ran, but a Brier score over a
            // handful of attempts is a number and not a reading, and the way to
            // make it one is more fights — never a wider cohort
            body.textContent =
                `${report.count} fight${report.count === 1 ? '' : 's'} with a stored prediction — too few to call. ` +
                `A reliability reading needs ${MIN_CALIBRATION_FIGHTS}; below that the spread swallows any gap ` +
                'worth seeing.';
            card.appendChild(body);
        } else {
            const spread = report.sd ? ` — ${Math.abs(report.sigma).toFixed(1)} sd` : '';
            body.textContent =
                `${report.count} fights with a stored prediction: expected ${report.expected.toFixed(1)} clears, ` +
                `got ${report.observed}${spread}. Brier ${report.brier.toFixed(3)}.`;
            card.appendChild(body);

            for (const band of report.bands) {
                if (!band.count) continue;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; gap:8px; font-size:10px;';
                const label = document.createElement('span');
                label.style.cssText = 'color:#9ab0d8;';
                label.textContent = band.label;
                const figures = document.createElement('span');
                figures.style.cssText = 'color:rgba(221,232,255,0.85); text-align:right;';
                figures.textContent =
                    `${band.count} fight${band.count === 1 ? '' : 's'} · ` +
                    `expected ${band.expected.toFixed(1)} · got ${band.observed}`;
                row.append(label, figures);
                card.appendChild(row);
            }
        }

        const notes = [];
        if (report.unpredicted > 0) notes.push(`${report.unpredicted} without a stored prediction`);
        // Named apart because the two exclusions are different problems with
        // different cures: a previous sim model is gone for good, where a
        // previous fingerprint just means those fights were fought on a build
        // the current one no longer describes
        if (legacyModel.length > 0) {
            notes.push(`${legacyModel.length} older fights from a previous sim model excluded`);
        }
        if (legacyFingerprint.length > 0) {
            notes.push(
                `${legacyFingerprint.length} older fights from a previous build fingerprint excluded ` +
                    '(kept, but recorded before combat levels were part of it)'
            );
        }
        if (notes.length) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
            note.textContent = notes.join(' · ');
            card.appendChild(note);
        }
        return card;
    }

    /**
     * Marking a point to measure from, and switching between the two views.
     *
     * In the summary card rather than the header because it is a thing you do
     * once and then read, and the header already carries Export, Reset and the
     * tabs. Reset is left where it is — it answers a different question, which
     * is "throw this away", and sometimes that is the one being asked.
     *
     * @param {Object} snapshot - `{ baselineAt, since }`
     * @returns {HTMLElement}
     */
    renderBaselineLine(snapshot) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55); margin-top:2px;';

        const act = (text, onClick, title) => {
            const button = document.createElement('span');
            button.textContent = text;
            button.title = title;
            button.style.cssText = 'color:#9ec4ff; cursor:pointer; text-decoration:underline dotted;';
            button.addEventListener('click', onClick);
            return button;
        };

        if (!snapshot.baselineAt) {
            line.append(
                'Everything ever recorded · ',
                act(
                    'mark a point to measure from',
                    () => this.markBaseline(),
                    'Keeps the whole record and lets you read only what has happened since — which is what ' +
                        'Reset was being used for, without losing anything'
                )
            );
            return line;
        }

        const when = new Date(snapshot.baselineAt).toLocaleDateString();
        line.append(
            snapshot.since ? `Since ${when} · ` : `Everything ever recorded · marked ${when} · `,
            act(
                snapshot.since ? 'show everything' : 'show only since then',
                () => {
                    this.sinceBaseline = !this.sinceBaseline;
                    this.render();
                },
                'Switch between the whole record and the period since the mark'
            ),
            ' · ',
            act('re-mark', () => this.markBaseline(), 'Move the mark to now'),
            ' · ',
            act(
                'forget the mark',
                () => {
                    Promise.resolve(this.simSource?.clearBaseline?.())
                        .then(() => {
                            this.sinceBaseline = false;
                            this.render();
                        })
                        .catch((error) => console.error('[LabyrinthRoomLogs] Forgetting the mark failed:', error));
                },
                'The record itself is untouched either way'
            )
        );
        return line;
    }

    /** Mark now as the point to measure from, and show the period since */
    markBaseline() {
        Promise.resolve(this.simSource?.markBaseline?.())
            .then(() => {
                this.sinceBaseline = true;
                this.render();
            })
            .catch((error) => console.error('[LabyrinthRoomLogs] Marking a baseline failed:', error));
    }

    renderAccuracyRow(row) {
        const pct = (v, places = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.25); border-radius:5px; background:rgba(22,31,45,0.92); ' +
            'padding:6px 7px; font-size:11px; line-height:1.35; margin-left:10px;';

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:6px; font-weight:700;';
        const name = document.createElement('span');
        name.textContent = `${this.prettyMonsterName(row.subjectHrid)} Lv.${row.level}`;
        const record = document.createElement('span');
        record.style.cssText = 'opacity:0.85;';
        record.textContent = `${row.clears}/${row.attempts}`;
        header.appendChild(name);
        header.appendChild(record);
        card.appendChild(header);

        const line = document.createElement('div');
        line.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
        const numbers = document.createElement('span');
        numbers.style.color = 'rgba(221,232,255,0.92)';
        numbers.textContent =
            row.predicted === null
                ? `Never simmed — you clear ${pct(row.observed)} (${pct(row.low)}–${pct(row.high)})`
                : `Sim ${pct(row.predicted)} → actual ${pct(row.observed)} (${pct(row.low)}–${pct(row.high)})`;
        line.appendChild(numbers);

        const colour = VERDICT_COLORS[row.verdict];
        if (colour) {
            line.appendChild(this.makeChip(row.verdict, 'rgba(255,255,255,0.08)', colour));
        }
        if (row.likelihood !== null && row.likelihood < 0.05) {
            const odds = document.createElement('span');
            odds.style.cssText = 'color:#ffba92; font-weight:700;';
            odds.textContent = `p=${(row.likelihood * 100).toFixed(row.likelihood < 0.001 ? 3 : 2)}%`;
            line.appendChild(odds);
        }
        card.appendChild(line);

        const rates = row.rates?.success;
        if (rates) {
            const actionLine = document.createElement('div');
            actionLine.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
            const text = document.createElement('span');
            text.style.color = 'rgba(221,232,255,0.8)';
            // Per room rather than per action, where there is one. A skilling
            // room ends the moment you clear it, so pooling every action across
            // rooms weights the rooms that went badly and reads several points
            // low for no reason but the stopping rule.
            const over = rates.rooms ? `over ${rates.rooms} room${rates.rooms === 1 ? '' : 's'}` : `of ${rates.trials}`;
            text.textContent =
                `Success — calc ${pct(rates.predicted)}, server ${pct(rates.server)}, ` +
                `seen ${pct(rates.observed)} ${over}`;
            actionLine.appendChild(text);
            // A formula that disagrees with the rate the server states is wrong
            // outright, which no amount of play will fix or reveal
            if (rates.formulaOff) {
                actionLine.appendChild(this.makeChip('formula off', 'rgba(255,255,255,0.08)', '#ff8a8a'));
            }
            card.appendChild(actionLine);
        }

        // A combat room's per-fight reading, which is the only thing that can
        // say anything about it before hundreds of fights have gone by
        if (row.fightLength) {
            const fl = row.fightLength;
            const fightLine = document.createElement('div');
            fightLine.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
            const text = document.createElement('span');
            text.style.color = 'rgba(221,232,255,0.8)';
            text.textContent =
                `Fight — sim ${Math.round(fl.predicted)}s, ran ${Math.round(fl.actual)}s ` +
                `over ${fl.fights} fight${fl.fights === 1 ? '' : 's'}`;
            fightLine.appendChild(text);
            const colour = VERDICT_COLORS[fl.verdict];
            if (colour) fightLine.appendChild(this.makeChip(fl.verdict, 'rgba(255,255,255,0.08)', colour));
            card.appendChild(fightLine);
        }

        const throughput = [];
        if (row.timing)
            throughput.push(`${Math.round(row.timing.actual)}s vs ${Math.round(row.timing.predicted)}s est per clear`);
        if (row.measured?.xpPerHour) throughput.push(`${formatKMB(row.measured.xpPerHour)} xp/h`);
        if (row.measured?.rooms) throughput.push(`${row.measured.rooms} finished`);
        if (throughput.length) {
            const timingLine = document.createElement('div');
            timingLine.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.65);';
            timingLine.textContent = throughput.join(' · ');
            card.appendChild(timingLine);
        }

        card.title = this.accuracyTooltip(row, pct).join('\n');
        return card;
    }

    /** The extra lines a room with finished runs behind it earns */
    throughputTooltip(row, pct) {
        const lines = [];
        if (row.rates?.success) {
            const { predicted, server, observed, pooled, rooms, low, high, formulaOff } = row.rates.success;
            const band = low === null ? '' : ` (${pct(low, 0)}–${pct(high, 0)})`;
            lines.push(
                `Success rate — Toolasha's formula says ${pct(predicted, 1)}, the server says ${pct(server, 1)}, ` +
                    (rooms
                        ? `and the mean across ${rooms} room(s) was ${pct(observed, 1)}${band}`
                        : `and ${pct(observed, 1)} of ${row.measured.actions} actions succeeded${band}`)
            );
            if (rooms && Number.isFinite(pooled) && Math.abs(pooled - observed) > 0.01) {
                lines.push(
                    `Pooled over all ${row.measured.actions} actions it reads ${pct(pooled, 1)}. A room ends the ` +
                        'moment you clear it, so a lucky room contributes few actions and an unlucky one contributes ' +
                        'the full budget — the pool is mostly made of unlucky rooms, and the gap between the two ' +
                        'figures is the size of that effect rather than anything the model got wrong'
                );
            }

            const dbl = row.rates.double;
            if (dbl && Number.isFinite(dbl.server)) {
                lines.push(
                    `Double rate — the server says ${pct(dbl.server, 1)}, and ${pct(dbl.observed, 1)} of your ` +
                        `${row.measured.successCount} successful actions doubled. Doubles roll on a success, not on ` +
                        'every action, which is why this is counted against successes'
                );
            }
            if (formulaOff) {
                lines.push(
                    'The formula and the server disagree, which is a bug rather than variance — the server states the ' +
                        'rate it is actually using, so no amount of play will bring the two together'
                );
            }
        }
        if (row.fightLength) {
            const fl = row.fightLength;
            const band = fl.low === null ? '' : ` (${Math.round(fl.low)}–${Math.round(fl.high)}s)`;
            lines.push(
                `A fight ran ${Math.round(fl.actual)}s on average over ${fl.fights} attempt(s)${band}, against ` +
                    `${Math.round(fl.predicted)}s simulated — ${fl.ratio.toFixed(2)}x. Every attempt counts here, ` +
                    "won or lost, and the sim's figure is the same kind of average, so this needs far fewer fights " +
                    'than a clear rate does before it can say anything'
            );
        }
        if (row.timing) {
            lines.push(
                `A clear cost ${Math.round(row.timing.actual)}s — every second of the ${row.timing.visits} visit(s) ` +
                    `to this room, ${Math.round(row.timing.seconds)}s in all, over the ${row.timing.clears} clear(s) ` +
                    `they bought. The calculator expects ${Math.round(row.timing.predicted)}s, which is also a ` +
                    `figure per clear and includes the attempts you lose — ${row.timing.ratio.toFixed(2)}x`
            );
            if (row.timing.perFinishedVisit) {
                lines.push(
                    `A visit that ended in a clear took ${Math.round(row.timing.perFinishedVisit)}s of that. The gap ` +
                        'between the two figures is the time this room has cost you in attempts that came to nothing'
                );
            }
        }
        if (row.measured?.xpPerHour) {
            lines.push(
                `${formatKMB(row.measured.xpPerHour)} experience per hour, measured from your skill totals over the ` +
                    'time actually spent in this room'
            );
        }
        return lines;
    }

    accuracyTooltip(row, pct) {
        const lines = [`${this.prettyMonsterName(row.subjectHrid)} at room level ${row.level} (${row.kind})`];
        lines.push(`${row.clears} clears in ${row.attempts} attempts — ${pct(row.observed, 1)}`);
        lines.push(`A record this size puts the true rate between ${pct(row.low, 1)} and ${pct(row.high, 1)}`);

        if (row.predicted === null) {
            lines.push('No forecast on record for this room, so its clear rate has nothing to be judged against.');
            lines.push('Calculate its tile once and the prediction is stamped on the next attempts.');
            return [...lines, ...this.throughputTooltip(row, pct)];
        }

        lines.push(
            `The sim says ${pct(row.predicted, 1)}${row.fromCache ? ' (from the sim run this session)' : ' (recorded when the fights happened)'}`
        );
        if (row.verdict === 'consistent') {
            lines.push('That sits inside the range these fights support, so the record does not contradict it.');
        } else {
            lines.push(`That sits outside the range these fights support: ${row.verdict}.`);
        }
        if (row.likelihood !== null) {
            const oneIn = row.likelihood > 0 ? Math.round(1 / row.likelihood) : Infinity;
            lines.push(
                `If the sim's rate were right, a record at least this lopsided would happen ${pct(row.likelihood, 2)} ` +
                    `of the time — about 1 run in ${Number.isFinite(oneIn) ? oneIn : 'a great many'}.`
            );
        }
        return [...lines, ...this.throughputTooltip(row, pct)];
    }

    makeChip(text, background, color) {
        const chip = document.createElement('span');
        chip.style.cssText = `display:inline-flex; border-radius:999px; padding:0 6px; background:${background}; color:${color}; font-size:10px; font-weight:700;`;
        chip.textContent = text;
        return chip;
    }
}

/**
 * Two room-log records folded into one by session identity, newest first, cut
 * to `size`.
 * @param {Object} base - Record, typically as stored
 * @param {Object} fresh - Record, typically in memory
 * @param {number} size - How many sessions to keep
 * @returns {{sessions: Array<Object>}} Merged record
 */
function mergeRoomLogs(base, fresh, size) {
    return { sessions: mergeById(sessionIdentity, newestFirst)(base?.sessions, fresh?.sessions).slice(0, size) };
}

const labyrinthRoomLogs = new LabyrinthRoomLogs();

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: 'settings',
    base: STORAGE_KEY,
    merge: (local, incoming) => mergeRoomLogs(local, incoming, labyrinthRoomLogs.logSize()),
    label: 'Labyrinth room logs',
});

/** The singleton itself, for tests — the default export is the feature shell */
export { labyrinthRoomLogs };

export default {
    name: 'Labyrinth Room Logs',
    initialize: () => labyrinthRoomLogs.initialize(),
    disable: () => {
        try {
            return labyrinthRoomLogs.disable();
        } catch (error) {
            console.error('[Labyrinth Room Logs] Disable failed part-way:', error);
        } finally {
            labyrinthRoomLogs.isInitialized = false;
        }
    },
    togglePanel: () => labyrinthRoomLogs.togglePanel(),
    useSimSource: (source) => labyrinthRoomLogs.useSimSource(source),
};
