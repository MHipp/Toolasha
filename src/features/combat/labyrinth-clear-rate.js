/**
 * Labyrinth Clear Rate Calculator
 * Shows expected clear time and success rate on labyrinth skilling and combat room tiles.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import marketAPI from '../../api/marketplace.js';
import {
    buildPlayerDTO,
    buildGameDataPayload,
    applyLoadoutSnapshotToDTO,
    getCommunityBuffs,
    getGuildBuffDetailMap,
    applyGuildBuffLevel,
} from '../combat-sim/combat-sim-adapter.js';
import { runLabyrinthSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildCommunityBuffsForSkill } from '../combat-sim/skilling-sim-helpers.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';
import Monster from '../combat-sim/engine/monster.js';
import { setGameData } from '../combat-sim/engine/game-data.js';
import loadoutSnapshot from './loadout-snapshot.js';
import { hasCoarsePointer, isMobileMode } from '../../utils/mobile.js';
import { formatRelativeTime, formatKMB } from '../../utils/formatters.js';
import { itemIcon, itemSpriteUrl } from '../../utils/overlay-format.js';
import { combatLevel as computeCombatLevel, COMBAT_SKILLS } from '../../utils/combat-level.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import labyrinthRoomLogs from './labyrinth-room-logs.js';
import { getAnnotationContainer, pruneEmptyAnnotationContainers } from './labyrinth-annotations.js';
import { estimateLiveClearChance, FIGHT_TIMEOUT_SECONDS, MIN_ELAPSED_SECONDS } from './labyrinth-live-combat.js';
import { isFreshLabyrinthFight } from './labyrinth-fight-log.js';

import { compareToPrediction } from './labyrinth-outcome-log.js';
import {
    ROOM_DURATION,
    BASE_SKILLING_TIME,
    BASE_ENHANCING_TIME,
    UPGRADE_STEP,
    UPGRADE_SUCCESS_STEP,
    UPGRADE_MAX_LEVEL,
    SKIP_THRESHOLD_RANGE,
    clampSuccessChance,
    roomXpPerHour,
    labyrinthGridSize,
    labyrinthRoomRewards,
} from './labyrinth-formulas.js';
import {
    BEACON_RADIUS,
    LABYRINTH_ENTRANCE,
    isRoomRevealed,
    computeLabyrinthPath,
    computeApproachPath,
    countDisjointRoutes,
    computeBeaconPlan,
} from './labyrinth-pathing.js';
import { parseLabyrinthActionName, monsterHridByName, liveClearDisplay } from './labyrinth-live-readout.js';
import {
    SUPPLY_KINDS,
    resolveSupplyHrids,
    readSupplyCounts,
    readRunSupplyCounts,
    readSupplyRowCounts,
    isLabyrinthRunActive,
    chooseSupplyCounts,
    bestOwnedTier,
    clampToOwned,
    describeSupplyNeed,
    estimateRestockCost,
    restockCandidates,
    remainingWord,
} from './labyrinth-supplies.js';
import { outcomeMethods } from './labyrinth-outcomes.js';
import {
    simCacheMethods,
    DEFAULT_SIM_PRECISION_PCT,
    UNCAPPED_MAX_SIM_TRIALS,
    gearChangedSince,
    GEAR_CHANGED_MARK,
    GEAR_CHANGED_DETAIL,
} from './labyrinth-sim-cache.js';
import { recommendationMethods, RECOMMEND_CLASS, RECOMMEND_CONTROLS_CLASS } from './labyrinth-recommendation.js';

/**
 * Re-exported from the modules they now live in, so importers that have always
 * reached for them here keep working.
 */
export { SKIP_THRESHOLD_RANGE, labyrinthGridSize, labyrinthRoomRewards };
export { computeLabyrinthPath, computeApproachPath, countDisjointRoutes, computeBeaconPlan };

const BADGE_CLASS = 'mwi-labyrinth-clear';
const LIVE_PROGRESS_CLASS = 'mwi-labyrinth-live-progress';
const LIVE_PROGRESS_STALE_MS = 5000;
const PREVIEW_ID = 'mwi-labyrinth-preview';
/** How often the orphan check runs — slow on purpose, see `_previewWatchdogTick` */
const PREVIEW_WATCHDOG_MS = 500;
const TILE_BADGE_CLASS = 'mwi-labyrinth-tile-badge';
const ATTEMPT_BADGE_CLASS = 'mwi-labyrinth-attempt-badge';
const LIVE_COMBAT_CLASS = 'mwi-labyrinth-live-combat';
// inline-block + never-shrinking min-width so the readout keeps a stable
// footprint: the clear band flipping between "75–100%?" and "100%" (and the
// seconds ticking down) otherwise changes this element's width every second
// and reflows the whole centered header — most visibly on mobile.
// tabular-nums so the ticking digits themselves hold their width.
const LIVE_COMBAT_CSS =
    'color:#fff; font-size:0.875rem; display:inline-block; text-align:left; white-space:nowrap; ' +
    'font-variant-numeric:tabular-nums;';
const LIVE_PROGRESS_CSS = 'color:#fff; font-size:0.875rem;';
/** Combat ticks arrive ~3/s, so this only expires once the fight is over */
const LIVE_COMBAT_STALE_MS = 5000;
/** Ticks are far faster than anyone reads; the readout is drawn at this rate */
const LIVE_COMBAT_REDRAW_MS = 1000;
/** Replays per conditional estimate — each is only the seconds the fight has left */
const LIVE_SIM_TRIALS = 400;
/** How often a fight is replayed; between replays the extrapolation shows */
const LIVE_SIM_REFRESH_MS = 4000;
/** A replay older than this describes a fight that has moved on */
const LIVE_SIM_MAX_AGE_MS = 9000;
const TILE_CONTROLS_CLASS = 'mwi-labyrinth-tile-controls';
/** Only reached for when the game's item sheet has not been drawn from yet */
const SUPPLY_EMOJI = { torch: '🔥', shroud: '👻', beacon: '📡' };
const PATH_OVERLAY_CLASS = 'mwi-labyrinth-path-overlay';
const BEACON_OVERLAY_CLASS = 'mwi-labyrinth-beacon-overlay';

class LabyrinthClearRate {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        // Settle-delay timers armed once the shared observer reports ready.
        // Held so `disable()` can cancel them: unregistering the ready handler
        // stops it firing again, but does nothing about a timer already armed.
        this.catchUpTimers = [];
        this.roomData = null;
        this.wsHandler = null;
        this.combatCache = new Map();
        // Bookkeeping the Map itself doesn't carry: when each entry was computed
        // and under which gear, so it can be written back out to the 'labyrinth'
        // store. Keyed the same as combatCache.
        this._combatCacheMeta = new Map();
        this._combatCacheLoaded = false;
        this.simQueue = [];
        this.simRunning = false;
        this.recommendations = new Map();
        this.recommendRunning = false;
        this._recommendTargetPct = 70;
        this.liveProgressHandler = null;
        this.liveProgressTimeout = null;
        this.snapshotUpdateHandler = null;
        this._settingsFingerprint = null;
        this._snapshotFingerprint = null;
        this._pathData = null;
        this._labyrinth = null;
        this._outcomes = {};
        this._outcomesSeen = {};
        this._outcomesLoaded = false;
        /** Bumped by `forgetOutcomes()`; see there */
        this._outcomeGeneration = 0;
        this._fight = null;
        this._liveCombatTimeout = null;
        this._liveCombatDrawnAt = 0;
        this._liveNodeMaxWidth = 0;
        // Last text each header readout showed, keyed by node class, so a node
        // the game's own rerender discarded is restored with what it said
        this._headerReadoutText = {};
        this._replay = null;
        this._replayRunning = false;
        this.battleHandler = null;
        this.newBattleHandler = null;
        this._previewAnchor = null;
        this._previewWatchdog = null;
        this._previewScrollHandler = null;
    }

    initialize() {
        if (!config.getSetting('labyrinthClearRate')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        this.wsHandler = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.wsHandler);

        // Settings fire for every character-setting change — including editing a
        // skip threshold in the automation panel itself — so recommendations are
        // only dropped when something they depend on actually changed (loadout
        // assignments, crates, or loadout contents). The combat cache never needs
        // clearing here: its key already includes loadoutId/roomLevel/crates/hours.
        this.settingHandler = () => {
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        };
        webSocketHook.on('setting_updated', this.settingHandler);

        this.loadoutsHandler = () => {
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        };
        webSocketHook.on('loadouts_updated', this.loadoutsHandler);

        // Snapshot content is not part of buildCombatCacheKey, so sims must be
        // invalidated when loadout gear actually changes — but snapshots also
        // re-broadcast unchanged (e.g. when the lab equips the next room's
        // loadout), so verify content really differs before wiping anything
        // Redrawn as well as invalidated, the way the two handlers above do:
        // the snapshots arriving (or changing) is exactly the event that makes
        // a placeholder or a stale badge answerable, and without a redraw those
        // badges sat as they were until some unrelated DOM mutation happened by.
        this.snapshotUpdateHandler = () => {
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        };
        loadoutSnapshot.onUpdate(this.snapshotUpdateHandler);

        this.liveProgressHandler = (data) => this.onLiveProgress(data);
        webSocketHook.on('labyrinth_room_progress', this.liveProgressHandler);

        this.battleHandler = (data) => this.onBattleUpdated(data);
        webSocketHook.on('battle_updated', this.battleHandler);

        this.newBattleHandler = (data) => this.onNewBattle(data);
        webSocketHook.on('new_battle', this.newBattleHandler);

        // The room log shows fights beside the rate that was predicted for them,
        // and owns none of that: the sims and the fight record both live here.
        // Handing it accessors rather than importing this module keeps the
        // dependency one-way — this module already imports the log.
        labyrinthRoomLogs.useSimSource({
            forecast: (hrid, level, kind) => this.roomForecast(hrid, level, kind),
            record: (result) => this.recordRoomResult(result),
            accuracy: (options) => this.accuracySnapshot(options),
            reset: () => {
                // The Accuracy tab shows the clear-chance tallies and the recorded
                // fights together, and Reset has always said it throws away "every
                // recorded fight" — so it clears both, not just the tallies.
                this.clearRecordedFights();
                return this.resetOutcomes();
            },
            markBaseline: () => this.markOutcomeBaseline(),
            clearBaseline: () => this.clearOutcomeBaseline(),
            recompute: (uncapped) => this.recomputeCombatSims(uncapped),
            replay: () => this.replayRecordedFights(),
            // The gear a recorded fight was fought in, so the pool keeps fights on
            // different gear apart and the replay compares like with like
            fingerprint: () => this._snapshotContentFingerprint(),
        });

        // The Recompute button is inside the Room Logs panel, behind the
        // Labyrinth tab, on a tab strip the button itself injects — so the one
        // action a player wants after changing gear is four clicks and a piece
        // of knowledge deep. This is the same call the button makes.
        registerCommand({
            name: 'Recompute lab sims',
            hint: 'Re-sim rooms whose results were computed under other gear',
            kind: 'verb',
            run: async () => {
                const queued = await this.recomputeStaleCombatSims(false);
                if (!queued) return 'nothing stale';
                return `${queued} stale room${queued === 1 ? '' : 's'} queued`;
            },
        });

        const unregister = domObserver.onClass('LabyrinthClearRate', 'LabyrinthPanel_skipThreshold', () =>
            this.injectOverlays()
        );
        this.unregisterHandlers.push(unregister);

        const unregisterTiles = domObserver.onClass('LabyrinthTileCalc', 'LabyrinthPanel_roomCell', () => {
            this.seedFromCharacterData();
            this.injectTileControls();
            this.refreshAttemptBadges();
            this.pruneClearedTileBadges();
            this.pruneClearedPathOverlays();
            this.pruneUsedBeaconOverlays();
            this.scheduleAutoTileCalc();
        });
        this.unregisterHandlers.push(unregisterTiles);
        // @run-at document-start: both settle delays start from the shared observer's
        // actual-ready signal (immediate if it is already attached), not module init, so
        // labyrinth DOM rendered during the readiness gap is not missed.
        // Tracked, because unregistering the ready handler cannot cancel a timer
        // it has already armed. A character switch inside the settle window used
        // to let these fire on a torn-down feature: re-injecting controls and
        // badges nothing is left to remove, and — worse — running
        // `_seedCombatCache` during the switch, which reads the departing
        // character's persisted sims and latches the cache as loaded, so the
        // arriving character never loads their own.
        this.unregisterHandlers.push(
            domObserver.onReady('LabyrinthClearRateCatchUp', () => {
                this.catchUpTimers.push(
                    setTimeout(() => {
                        this.seedFromCharacterData();
                        this.injectTileControls();
                        this.scheduleAutoTileCalc();
                    }, 500),
                    setTimeout(() => {
                        // The overlay pass fires immediately for skilling/enhancing badges
                        // (which never touch combatCache); combat rooms get a placeholder
                        // and are redrawn once the cache is in.
                        this.injectOverlays();
                        this._seedCombatCache();
                    }, 500)
                );
            })
        );

        // Skip-threshold cells wrap so the shared annotation line (clear rate,
        // recommendation, best level) sits below the native value/buttons
        // instead of squeezing them into wrapping mid-value
        this.styleEl = document.createElement('style');
        this.styleEl.id = 'mwi-labyrinth-clear-style';
        this.styleEl.textContent = `
            [class*="LabyrinthPanel_automationContent"] { max-width: 36rem !important; }
            [class*="LabyrinthPanel_skipThreshold"] { display: flex; align-items: center; flex-wrap: wrap; }
            .${BADGE_CLASS} { order: 1; }
            .${RECOMMEND_CLASS} { order: 2; }
        `;
        document.head.appendChild(this.styleEl);

        // Prefill the game's skip-threshold edit input with the current value
        this._editClickHandler = (e) => this.onSkipEditClick(e);
        document.addEventListener('click', this._editClickHandler, true);

        // The preview follows the cursor via mousemove, which scrolling does
        // not fire — without this a scroll leaves it pinned over content it
        // no longer points at. Capture phase so it fires even when the
        // labyrinth panel's own inner area is what scrolled, not the window.
        this._previewScrollHandler = () => this.hidePreview();
        window.addEventListener('scroll', this._previewScrollHandler, { capture: true, passive: true });

        // The orphan watchdog (`_previewWatchdogTick`) is started by
        // showPreview() and stopped by hidePreview(), so it only ticks while
        // there is a preview on screen to orphan.

        this.isInitialized = true;
    }

    /**
     * Seed the invalidation baselines and bring in whatever combat sims
     * survived the reload, once the loadout snapshots have arrived.
     *
     * Both steps wait on the snapshot store, and the wait is the point. The
     * gear fingerprint hashes the snapshot contents, so seeding it against a
     * store still loading from IndexedDB records the hash of `{}` — and every
     * persisted entry, hashed under the real gear, is then thrown away as a
     * mismatch. That happened on *every* reload, so the cache never survived
     * one and every combat badge was re-simmed from cold, which is the race the
     * 0% badges came out of.
     *
     * The cache load is gated on the fingerprint the seeding establishes, so it
     * has to run after it, not merely alongside it.
     * @private
     */
    async _seedCombatCache() {
        await loadoutSnapshot.whenReady();
        this._invalidateIfInputsChanged();
        await this._loadCombatCache();
        // Combat badges the load just filled, drawn from the cache this time
        this.injectOverlays();
    }

    /**
     * When the game's Edit button on a skip-threshold row is clicked, fill the
     * number input with the recommended threshold (falling back to the row's
     * current value when no recommendation has been computed), replacing
     * whatever the input holds. Gated behind the labyrinthSkipEditAutofill
     * setting (off by default).
     * @param {MouseEvent} event
     */
    onSkipEditClick(event) {
        if (!config.getSetting('labyrinthSkipEditAutofill')) return;
        const button = event.target?.closest?.('button');
        if (!button || button.textContent.trim() !== 'Edit') return;
        const cell = button.closest('[class*="LabyrinthPanel_skipThreshold"]');
        if (!cell) return;
        const roomHrid = this.extractRoomHrid(cell);
        if (!roomHrid) return;

        const recommended = this.recommendations.get(roomHrid)?.threshold;
        const current = roomHrid.startsWith('/skills/')
            ? this.getSkipThreshold(roomHrid)
            : this.getCombatSkipThreshold(roomHrid);
        // Thresholds are signed: a negative recommendation is as fillable as a positive
        // one. Zero is the only value worth refusing, because it is also what the reader
        // returns for a setting that was never saved.
        const value = Number.isFinite(recommended) && recommended !== 0 ? recommended : current;
        if (!Number.isFinite(value) || value === 0) return;

        // React renders the input a beat after the click; retry briefly
        let attempts = 0;
        const tryFill = () => {
            const input = cell.querySelector('input');
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    setter.call(input, String(value));
                } else {
                    input.value = String(value);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            if (++attempts < 10) setTimeout(tryFill, 50);
        };
        setTimeout(tryFill, 0);
    }

    disable() {
        try {
            if (this.wsHandler) {
                webSocketHook.off('labyrinth_updated', this.wsHandler);
                this.wsHandler = null;
            }

            if (this.settingHandler) {
                webSocketHook.off('setting_updated', this.settingHandler);
                this.settingHandler = null;
            }

            if (this.loadoutsHandler) {
                webSocketHook.off('loadouts_updated', this.loadoutsHandler);
                this.loadoutsHandler = null;
            }

            if (this.liveProgressHandler) {
                webSocketHook.off('labyrinth_room_progress', this.liveProgressHandler);
                this.liveProgressHandler = null;
            }

            if (this.snapshotUpdateHandler) {
                loadoutSnapshot.offUpdate(this.snapshotUpdateHandler);
                this.snapshotUpdateHandler = null;
            }

            if (this.battleHandler) {
                webSocketHook.off('battle_updated', this.battleHandler);
                this.battleHandler = null;
            }

            if (this.newBattleHandler) {
                webSocketHook.off('new_battle', this.newBattleHandler);
                this.newBattleHandler = null;
            }

            this.clearLiveProgress();
            this.clearLiveCombat();
            this._fight = null;
            this.hidePreview();
            document.getElementById(PREVIEW_ID)?.remove();
            if (this._previewWatchdog) {
                clearInterval(this._previewWatchdog);
                this._previewWatchdog = null;
            }
            if (this._previewScrollHandler) {
                window.removeEventListener('scroll', this._previewScrollHandler, { capture: true });
                this._previewScrollHandler = null;
            }
            document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
            document.querySelectorAll(`.${ATTEMPT_BADGE_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${TILE_CONTROLS_CLASS}`).forEach((el) => el.remove());
            if (this.autoTileTimer) {
                clearTimeout(this.autoTileTimer);
                this.autoTileTimer = null;
            }
            if (this.pruneTileTimer) {
                clearTimeout(this.pruneTileTimer);
                this.pruneTileTimer = null;
            }
            for (const timer of this.catchUpTimers) clearTimeout(timer);
            this.catchUpTimers = [];
            this.calculatedTileKeys?.clear();

            unregisterCommand('Recompute lab sims');

            this.unregisterHandlers.forEach((fn) => fn());
            this.unregisterHandlers = [];

            document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${RECOMMEND_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${RECOMMEND_CONTROLS_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${LIVE_PROGRESS_CLASS}`).forEach((el) => el.remove());
            this.clearPathOverlays();
            this.clearBeaconOverlays();
            this.pathCalcRunning = false;
            pruneEmptyAnnotationContainers();

            if (this._editClickHandler) {
                document.removeEventListener('click', this._editClickHandler, true);
                this._editClickHandler = null;
            }
            if (this.styleEl) {
                this.styleEl.remove();
                this.styleEl = null;
            }

            this.roomData = null;
            // The grid's three companions, dropped with it. `currentLabyrinthState()`
            // prefers `_labyrinth` over `dataManager.characterData` because a live
            // message is the freshest thing there is — which stops being true the
            // moment the character it described is gone. And `seedFromCharacterData()`
            // only fills `_pathData` when it is null, so one left standing blocks the
            // arriving character's own path from ever being seeded.
            this._labyrinth = null;
            this._pathData = null;
            this.currentFloor = 0;
            this.combatCache.clear();
            this._combatCacheMeta.clear();
            this._combatCacheLoaded = false;
            // The pending flush has to go with them. `_flushCombatCache`
            // rebuilds the stored list from whatever the meta map holds and
            // writes it through `writeScoped`, which resolves the key when the
            // write runs — so a timer armed a moment before this teardown fired
            // a second later, found the map emptied above and the dirty flag
            // still set, and wrote `entries: []` over the ARRIVING character's
            // persisted sim cache. `_clearPersistedCombatCache` cancels it for
            // exactly this reason; disable() did not.
            if (this._combatCacheFlushTimer) {
                clearTimeout(this._combatCacheFlushTimer);
                this._combatCacheFlushTimer = null;
            }
            this._combatCacheDirty = false;
            // The fight record is one character's; dropping it here is what makes
            // the next load read it back under whichever character is then current
            this.forgetOutcomes();
            // Teardown has to reach the work already in flight, not just the
            // work queued behind it. `cancelRunningSims` terminates the sim
            // running right now (its promise rejects with 'Cancelled') and
            // disarms the pending badge retry; `endSimEpoch` fences whatever is
            // still unwinding, so a loop resuming after this point cannot clear
            // the arriving character's flags, re-arm the flush or retry timers,
            // or draw a badge onto the board that replaced this one.
            this.cancelRunningSims();
            this.endSimEpoch();
            this.simQueue = [];
            this.simRunning = false;
            // Left true, its own re-entrancy guard refuses every later press of
            // the Calculate button — the button silently does nothing until a
            // page reload.
            this.tileCalcRunning = false;
            this.recommendations.clear();
            this.recommendRunning = false;
            this._settingsFingerprint = null;
            this._snapshotFingerprint = null;
            // One character's sim results and the fingerprint that says they
            // are still current. Nothing reuses them across a switch today —
            // the fingerprint folds in the gear snapshot, which differs — but
            // that is incidental, and it is what stands between a stale
            // `_autoCalcFingerprint` and an auto pass drawing the departing
            // character's clear chances onto the arriving character's grid from
            // `restoreTileBadgesFromCache()`. Safety should not rest on two
            // characters happening to be geared differently.
            this._tileResults?.clear();
            this._autoCalcFingerprint = null;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Labyrinth Clear Rate] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    // -------------------------------------------------------------------------
    // Room attempts
    //
    // A room you fail to clear is one you come back to, and the map gives no
    // sign of it: the tile looks identical on your fourth try and your first.
    // The server counts them for us — every room carries an entryCount — so
    // nothing here is inferred, and nothing needs storing between sessions.
    // -------------------------------------------------------------------------

    /**
     * The room the path head is standing in.
     * @returns {Object|null} roomData entry, or null when not in a run
     */
    currentRoom() {
        const rows = this.roomData;
        if (!Array.isArray(rows)) return null;
        let path = this._pathData;
        if (typeof path === 'string' && path) {
            try {
                path = JSON.parse(path);
            } catch {
                return null;
            }
        }
        if (!Array.isArray(path) || !path.length) return null;
        // pathData is the queued route, not the trail behind you: [0] is the
        // room being run and the rest are what you lined up after it
        const head = path[0];
        if (!head || !Number.isInteger(head.x) || !Number.isInteger(head.y)) return null;
        return rows[head.y]?.[head.x] || null;
    }

    /**
     * Where the path head is standing, as a flat grid index.
     *
     * The same reading as `currentRoom`, in the form the planners work in.
     * Falls back to -1 rather than to the entrance: "not in a run" and "at the
     * entrance" are different answers, and only the caller knows which default
     * it wants.
     *
     * @param {number} cols - Grid width
     * @returns {number} Flat index, or -1 when the game has not said
     */
    currentRoomIndex(cols) {
        if (!cols || !Array.isArray(this.roomData)) return -1;
        let path = this._pathData;
        if (typeof path === 'string' && path) {
            try {
                path = JSON.parse(path);
            } catch {
                return -1;
            }
        }
        const head = Array.isArray(path) && path.length ? path[0] : null;
        if (!head || !Number.isInteger(head.x) || !Number.isInteger(head.y)) return -1;
        if (head.x < 0 || head.x >= cols || head.y < 0) return -1;
        const idx = head.y * cols + head.x;
        return idx < this.roomData.flat().length ? idx : -1;
    }

    /** Times the room being run now has been entered, 0 when unknown */
    currentRoomAttempts() {
        return Math.max(0, Math.floor(Number(this.currentRoom()?.entryCount) || 0));
    }

    /**
     * Mark every room entered more than once. A first entry is the normal case
     * and carries no information, so only repeats are drawn.
     */
    refreshAttemptBadges() {
        document.querySelectorAll(`.${ATTEMPT_BADGE_CLASS}`).forEach((el) => el.remove());
        if (!this.roomData) return;
        const flat = this.roomData.flat();
        const cells = this.findRoomGridCells(flat.length);
        if (cells.length !== flat.length) return;

        for (let i = 0; i < flat.length; i++) {
            const entries = Math.floor(Number(flat[i]?.entryCount) || 0);
            const cell = cells[i];
            if (entries < 2 || !cell) continue;

            const cellStyle = window.getComputedStyle(cell);
            if (cellStyle.position === 'static') cell.style.position = 'relative';

            const badge = document.createElement('div');
            badge.className = ATTEMPT_BADGE_CLASS;
            badge.title = `Entered ${entries} times`;
            badge.textContent = String(entries);
            // Middle of the left edge: the tile's own corners are taken — level
            // top, clear chance and ETA bottom — and the bottom-left slot put
            // this straight over the ETA
            badge.style.cssText =
                'position:absolute; left:1px; top:50%; transform:translateY(-50%); z-index:9; padding:0 3px; ' +
                'border-radius:3px; background:rgba(0,0,0,0.7); color:#ffc866; font-size:8px; font-weight:700; ' +
                'line-height:1.4; pointer-events:none;';
            cell.appendChild(badge);
        }
    }

    onLabyrinthUpdated(data) {
        // Whatever badge a preview is anchored to belongs to the grid this
        // message is about to rebuild (or has just left behind, if the run
        // ended) — same reasoning as `injectOverlays`, for the update that
        // carries no roomData and so never reaches it
        this.hidePreview();
        // Kept whole, not just the grid: the run's supply stock rides this
        // message, and the readout has to be able to look for it
        this._labyrinth = data.labyrinth ?? null;
        this._pathData = data.labyrinth?.pathData ?? null;
        this.recordOutcomes(data.labyrinth);
        const previousFloor = this.currentFloor;
        this.currentFloor = Math.max(0, Math.floor(Number(data.labyrinth?.currentFloor) || 0));
        const roomData = data.labyrinth?.roomData;
        if (roomData) {
            this.roomData = roomData;
            this.injectOverlays();
            this.pruneClearedPathOverlays();
            this.pruneUsedBeaconOverlays();
            if (previousFloor !== this.currentFloor) {
                this.clearPathOverlays();
                this.clearBeaconOverlays();
                // A beacon count was chosen for the floor that just ended; the
                // next one starts back on the automatic minimum
                this.resetBeaconCountToAuto();
                document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
                this.calculatedTileKeys?.clear();
            }
            this.injectTileControls();
            this.refreshSupplyReadout();
            this.pruneClearedTileBadges();
            this.refreshAttemptBadges();
            // Re-run after React repaints the cleared tile (the WS message
            // usually arrives before the DOM updates)
            if (this.pruneTileTimer) clearTimeout(this.pruneTileTimer);
            this.pruneTileTimer = setTimeout(() => {
                this.pruneTileTimer = null;
                this.pruneClearedTileBadges();
            }, 400);

            // Auto-calc newly revealed tiles when enabled (off by default)
            this.scheduleAutoTileCalc();
        }
    }

    /**
     * Get labyrinth upgrade levels from characterInfo
     */
    getLabyrinthUpgrades() {
        const info = dataManager.characterData?.characterInfo;
        if (!info) return { speed: 0, efficiency: 0, success: 0, doubleProgress: 0, experience: 0 };

        return {
            speed: Math.max(0, Math.floor(Number(info.labyrinthSkillActionSpeedLevel) || 0)),
            efficiency: Math.max(0, Math.floor(Number(info.labyrinthSkillingEfficiencyLevel) || 0)),
            success: Math.max(0, Math.floor(Number(info.labyrinthSkillingSuccessLevel) || 0)),
            doubleProgress: Math.max(0, Math.floor(Number(info.labyrinthSkillingDoubleProgressLevel) || 0)),
            experience: Math.max(0, Math.floor(Number(info.labyrinthExperienceLevel) || 0)),
        };
    }

    /**
     * Get crate buff arrays for all equipped crates
     */
    getCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const crateHrids = [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ];

        const allBuffs = [];
        for (const hrid of crateHrids) {
            if (!hrid) continue;
            const buffs = gameData.labyrinthCrateDetailMap[hrid];
            if (Array.isArray(buffs)) {
                allBuffs.push(...buffs);
            }
        }
        return allBuffs;
    }

    /**
     * Get crate buffs for combat rooms (coffee + food only, no tea)
     */
    getCombatCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const crateHrids = [
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ];

        const allBuffs = [];
        for (const hrid of crateHrids) {
            if (!hrid) continue;
            const buffs = gameData.labyrinthCrateDetailMap[hrid];
            if (Array.isArray(buffs)) {
                allBuffs.push(...buffs);
            }
        }
        return allBuffs;
    }

    /**
     * The community buff levels the server is currently running, by the key the
     * skilling helpers name them with.
     *
     * Read through `getCommunityBuffLevel` rather than off
     * `communityActionTypeBuffsMap`, and that is the whole point of the method.
     * The map is only ever written from the `init_character_data` payload —
     * nothing refreshes it — while `characterData.communityBuffs`, which is what
     * this reads, is replaced on every `community_buffs_updated` message. A room
     * scored off the map was being scored against the buff levels as they stood
     * when the page was loaded, which drifts away from the truth every time
     * anybody on the server donates, and disagreed with the Lab Sim panel (whose
     * DTO has always read the live levels) for the rest of the session.
     *
     * @returns {{productionEfficiency: number, enhancingSpeed: number, gatheringQuantity: number, experience: number}}
     */
    getLiveCommunityBuffLevels() {
        const level = (hrid) => Math.max(0, Math.floor(Number(dataManager.getCommunityBuffLevel?.(hrid)) || 0));
        return {
            productionEfficiency: level('/community_buff_types/production_efficiency'),
            enhancingSpeed: level('/community_buff_types/enhancing_speed'),
            gatheringQuantity: level('/community_buff_types/gathering_quantity'),
            experience: level('/community_buff_types/experience'),
        };
    }

    /**
     * What the Experience community buff is worth right now, as a ratio.
     *
     * The numbers come from `communityBuffTypeDetailMap` when it has loaded and
     * from the same fallbacks the rest of the script carries when it has not —
     * `flatBoost + (level − 1) × flatBoostLevelBonus`, which is the formula the
     * combat sim's own `buildExtraBuffs` uses for this exact buff.
     *
     * It is read separately from the skilling helper because that one answers a
     * question about a *skill* — it filters on `usableInActionTypeMap` for a
     * skilling action type and drops everything that cannot move a skilling
     * metric. A labyrinth fight is not one of those action types, and the award
     * being raised here is the room's completion experience rather than a
     * skilling metric.
     *
     * @returns {number} Ratio, 0 when the buff is not running
     */
    getCommunityExperienceBonus() {
        const level = Math.max(
            0,
            Math.floor(Number(dataManager.getCommunityBuffLevel?.('/community_buff_types/experience')) || 0)
        );
        if (level <= 0) return 0;

        const buff =
            dataManager.getInitClientData?.()?.communityBuffTypeDetailMap?.['/community_buff_types/experience']?.buff;
        const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
        const flat = num(buff?.flatBoost, 0.2) + (level - 1) * num(buff?.flatBoostLevelBonus, 0.005);
        const ratio = num(buff?.ratioBoost, 0) + (level - 1) * num(buff?.ratioBoostLevelBonus, 0);
        return flat + ratio;
    }

    /**
     * How much more experience a labyrinth room pays than its base award.
     *
     * The labyrinth experience upgrade, any wisdom the run's crates carry, and
     * the Experience community buff.
     *
     * That last one was missing, and only from here: a skilling room's award is
     * `roomLevel × 50 × (1 + experienceBonus)` with the bonus built by
     * `getSkillingMetrics`, which reads the community buffs among its sources —
     * so the same server-wide buff was worth up to a fifth more experience in a
     * Milking room and exactly nothing in a fight. The two rooms pay on the same
     * formula and the buff applies to both.
     *
     * @returns {number} Ratio, 0 when nothing applies
     */
    getCombatExperienceBonus() {
        let bonus = this.getLabyrinthUpgrades().experience * UPGRADE_STEP;
        for (const buff of this.getCombatCrateBuffs()) {
            if (buff?.typeHrid !== '/buff_types/wisdom') continue;
            bonus += (Number(buff.flatBoost) || 0) + (Number(buff.ratioBoost) || 0);
        }
        return bonus + this.getCommunityExperienceBonus();
    }

    /**
     * Get crate buffs for tea crate only (used for room-assignment effective level)
     */
    getTeaCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const teaHrid = labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '';
        if (!teaHrid) return [];

        const buffs = gameData.labyrinthCrateDetailMap[teaHrid];
        return Array.isArray(buffs) ? buffs : [];
    }

    /**
     * Get the labyrinth loadout ID for a skill from characterSetting
     */
    getSkillingLoadoutId(skillHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const skillId = skillHrid.replace('/skills/', '');
        const pascal = skillId.charAt(0).toUpperCase() + skillId.slice(1);
        return Number(charSetting[`labyrinthLoadout${pascal}`]) || 0;
    }

    /**
     * Compute equipment noncombat stat buffs from a loadout snapshot's equipment.
     * Replicates the reference's buildLoadoutNoncombatStatTotals + buildSkillingEquipmentBuffsFromTotals.
     * @param {number} loadoutId - Loadout ID
     * @param {string} skillId - e.g. "milking"
     * @returns {Array} Array of buff-like objects with typeHrid and flatBoost/ratioBoost
     */
    getLoadoutEquipmentBuffs(loadoutId, skillId) {
        const snapshot = loadoutSnapshot.snapshots[loadoutId];
        if (!snapshot?.equipment?.length) return [];

        const gameData = dataManager.getInitClientData();
        if (!gameData?.itemDetailMap) return [];

        const enhTable = gameData.enhancementLevelTotalBonusMultiplierTable || {};
        const toolSlot = `/item_locations/${skillId}_tool`;

        const totals = {};
        // Resolved, not stored: a "highest owned" loadout wears the best copy
        // owned now, and the stored level is only what it was at last save
        for (const equip of loadoutSnapshot.resolveEquipment(snapshot)) {
            if (!equip.itemHrid || !equip.itemLocationHrid) continue;

            // Filter tool slots: only include the tool slot matching this skill
            if (equip.itemLocationHrid.endsWith('_tool') && equip.itemLocationHrid !== toolSlot) {
                continue;
            }

            const itemDetail = gameData.itemDetailMap[equip.itemHrid];
            const equipDetail = itemDetail?.equipmentDetail;
            if (!equipDetail) continue;

            const baseStats = equipDetail.noncombatStats || {};
            const enhStats = equipDetail.noncombatEnhancementBonuses || {};
            const enhLevel = equip.enhancementLevel || 0;
            const enhMultiplier = enhTable[enhLevel] ?? enhLevel;

            for (const [key, value] of Object.entries(baseStats)) {
                if (!Number.isFinite(value)) continue;
                totals[key] = (totals[key] || 0) + value;
            }
            for (const [key, value] of Object.entries(enhStats)) {
                if (!Number.isFinite(value)) continue;
                totals[key] = (totals[key] || 0) + value * enhMultiplier;
            }
        }

        // Convert totals to buff array matching the format expected by applyBuff
        const buffs = [];
        const actionSpeed = (totals[`${skillId}Speed`] || 0) + (totals.skillingSpeed || 0);
        const efficiency = (totals[`${skillId}Efficiency`] || 0) + (totals.skillingEfficiency || 0);
        const success = totals[`${skillId}Success`] || 0;
        const gathering = totals.gatheringQuantity || 0;
        // Wisdom and the skill's own charm stat are additive on experience —
        // the same rule the rest of the script applies outside the labyrinth
        // (see utils/experience-parser.js). Without this the loadout's
        // equipment buffs replaced the live map with a list that had no
        // experience term in it at all, so a Philosopher's necklace worn only
        // in a labyrinth loadout never reached xpPerRoom.
        const experience = (totals.skillingExperience || 0) + (totals[`${skillId}Experience`] || 0);

        if (actionSpeed) buffs.push({ typeHrid: '/buff_types/action_speed', flatBoost: actionSpeed, ratioBoost: 0 });
        if (efficiency) buffs.push({ typeHrid: '/buff_types/efficiency', flatBoost: efficiency, ratioBoost: 0 });
        if (success) buffs.push({ typeHrid: `/buff_types/${skillId}_success`, flatBoost: 0, ratioBoost: success });
        if (gathering) buffs.push({ typeHrid: '/buff_types/gathering', flatBoost: gathering, ratioBoost: 0 });
        if (experience) buffs.push({ typeHrid: '/buff_types/wisdom', flatBoost: experience, ratioBoost: 0 });

        return buffs;
    }

    /**
     * Aggregate all buff sources into skilling metrics for a given skill
     * @param {string} skillId - e.g. "woodcutting"
     * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
     */
    getSkillingMetrics(skillId, actionTypeHrid) {
        const metrics = {
            skillLevelBonus: 0,
            efficiencyBonus: 0,
            actionSpeedBonus: 0,
            successBonus: 0,
            doubleProgressBonus: 0,
            gatheringBonus: 0,
            experienceBonus: 0,
        };
        const charData = dataManager.characterData;
        if (!charData) return metrics;

        const skillLevelType = `/buff_types/${skillId}_level`;
        const skillSuccessType = `/buff_types/${skillId}_success`;

        // Equipment buffs come from the labyrinth loadout, not currently worn gear
        const loadoutId = this.getSkillingLoadoutId(`/skills/${skillId}`);
        const loadoutEquipBuffs = loadoutId ? this.getLoadoutEquipmentBuffs(loadoutId, skillId) : null;

        const buffSources = [
            loadoutEquipBuffs || charData.equipmentActionTypeBuffsMap?.[actionTypeHrid],
            // Built from the levels the server is running now rather than read
            // from `communityActionTypeBuffsMap`, which is written once at login
            // and never again — see `getLiveCommunityBuffLevels`. Built by the
            // same helper the Lab Sim's skilling tab uses, so the tile and the
            // panel cannot disagree about what a community buff is worth.
            buildCommunityBuffsForSkill(this.getLiveCommunityBuffLevels(), actionTypeHrid),
            charData.houseActionTypeBuffsMap?.[actionTypeHrid],
            charData.guildActionTypeBuffsMap?.[actionTypeHrid],
            charData.achievementActionTypeBuffsMap?.[actionTypeHrid],
            charData.mooPassActionTypeBuffsMap?.[actionTypeHrid],
        ];

        for (const buffs of buffSources) {
            if (!Array.isArray(buffs)) continue;
            for (const buff of buffs) {
                if (!buff?.typeHrid) continue;
                const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                if (amount === 0) continue;
                this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
            }
        }

        const crateBuffs = this.getCrateBuffs();
        for (const buff of crateBuffs) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (amount === 0) continue;
            this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
        }

        const upgrades = this.getLabyrinthUpgrades();
        metrics.actionSpeedBonus += upgrades.speed * UPGRADE_STEP;
        metrics.efficiencyBonus += upgrades.efficiency * UPGRADE_STEP;
        metrics.successBonus += upgrades.success * UPGRADE_SUCCESS_STEP;
        metrics.doubleProgressBonus += upgrades.doubleProgress * UPGRADE_STEP;
        metrics.experienceBonus += upgrades.experience * UPGRADE_STEP;

        return metrics;
    }

    /**
     * The guild buffs to score a skilling room with.
     *
     * Normally the server's own array for that action type — it is authoritative
     * and needs no help. A caller exploring shrine levels (the upgrade advisor,
     * or an edited sim loadout) passes the levels it wants instead, and only the
     * shrines whose level actually differs are rebuilt on top of that array. That
     * keeps every untouched shrine at the server's exact numbers, so a delta
     * measures the one level that changed rather than the gap between the game's
     * arithmetic and ours.
     *
     * @param {string} actionTypeHrid - e.g. '/action_types/milking'
     * @param {Object} [shrineLevels] - buffHrid → level being explored
     * @returns {Array} Buff objects
     */
    resolveGuildBuffs(actionTypeHrid, shrineLevels) {
        const live = dataManager.characterData?.guildActionTypeBuffsMap?.[actionTypeHrid] || [];
        if (!shrineLevels) return live;

        const detailMap = getGuildBuffDetailMap();
        let buffs = live;
        for (const [buffHrid, level] of Object.entries(shrineLevels)) {
            const detail = detailMap[buffHrid];
            // Combat shrines never appear in a skilling action type's array
            if (!detail || detail.isCombat) continue;
            const owned = dataManager.getCharacterGuildBuffLevel?.(buffHrid) || 0;
            if (level === owned) continue;
            buffs = applyGuildBuffLevel(buffs, detail, level);
        }
        return buffs;
    }

    /**
     * Apply a single buff to metrics based on its type
     */
    applyBuff(metrics, typeHrid, amount, skillLevelType, skillSuccessType, skillId) {
        if (typeHrid === skillLevelType) {
            metrics.skillLevelBonus += amount;
        } else if (typeHrid === '/buff_types/efficiency') {
            metrics.efficiencyBonus += amount;
        } else if (typeHrid === '/buff_types/action_speed') {
            metrics.actionSpeedBonus += amount;
        } else if (typeHrid === '/buff_types/labyrinth_double_progress') {
            metrics.doubleProgressBonus += amount;
        } else if (typeHrid === '/buff_types/success_rate' || typeHrid === skillSuccessType) {
            metrics.successBonus += amount;
        } else if (typeHrid === '/buff_types/wisdom') {
            metrics.experienceBonus += amount;
        } else if (
            typeHrid === '/buff_types/gathering' &&
            (skillId === 'milking' || skillId === 'foraging' || skillId === 'woodcutting')
        ) {
            // Official formula: DoubleProgress = Crate + Gathering (the three
            // gathering skills only) + Upgrade — gourmet does not apply in the lab
            metrics.gatheringBonus += amount;
        }
    }

    /**
     * Compute clear stats for a non-enhancing skilling room
     */
    computeSkillingClear(skillHrid, roomLevel) {
        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const metrics = this.getSkillingMetrics(skillId, actionTypeHrid);

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === skillHrid);
        const baseLevel = skill?.level || 1;

        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus + (metrics.gatheringBonus || 0)));

        const workPower = effectiveLevel * (1 + metrics.efficiencyBonus);
        const progressPerSuccess = Math.max(0, Math.floor(workPower));
        const targetProgress = roomLevel * 10;

        const actionSeconds = BASE_SKILLING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));

        const clearStats = this.computeNonEnhancingClearStats(
            attempts,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        );
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'skilling';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.workPower = workPower;
        result.progressPerSuccess = progressPerSuccess;
        result.targetProgress = targetProgress;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        result.skillHrid = skillHrid;
        this.attachSkillingWhatIfs(result, metrics, {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            progressPerSuccess,
            targetProgress,
            roomLevel,
        });
        return result;
    }

    /**
     * Attach what-if clear chances (level up, efficiency/speed tiers, labyrinth
     * upgrades) and XP/hour to a skilling result for the hover preview.
     */
    attachSkillingWhatIfs(result, metrics, params) {
        const {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            progressPerSuccess,
            targetProgress,
        } = params;
        const clampChance = (v) => Math.min(1, Math.max(0, v));
        const upgrades = this.getLabyrinthUpgrades();

        // +1 effective skill level (improves both success chance and work power)
        const nextLevel = effectiveLevel + 1;
        const nextLevelDelta = nextLevel - params.roomLevel;
        const nextLevelBonus = nextLevelDelta >= 0 ? nextLevelDelta * 0.005 : nextLevelDelta * 0.01;
        result.nextLevelClearChance = this.computeNonEnhancingClearStats(
            attempts,
            clampSuccessChance(0.8 * (1 + nextLevelBonus + metrics.successBonus)),
            doubleChance,
            Math.max(0, Math.floor(nextLevel * (1 + metrics.efficiencyBonus))),
            targetProgress
        ).clearChance;

        // Efficiency needed to require one fewer progress unit
        result.efficiencyDelta = null;
        result.efficiencyTierClearChance = null;
        const neededUnits = progressPerSuccess > 0 ? Math.ceil(targetProgress / progressPerSuccess - 1e-9) : 0;
        if (neededUnits > 1 && effectiveLevel > 0) {
            const requiredPerSuccess = Math.ceil(targetProgress / (neededUnits - 1) - 1e-9);
            const requiredEfficiency = requiredPerSuccess / effectiveLevel - 1;
            if (Number.isFinite(requiredEfficiency)) {
                result.efficiencyDelta = Math.max(0, requiredEfficiency - metrics.efficiencyBonus);
                result.efficiencyTierClearChance = this.computeNonEnhancingClearStats(
                    attempts,
                    successChance,
                    doubleChance,
                    requiredPerSuccess,
                    targetProgress
                ).clearChance;
            }
        }

        // Action speed needed to fit one more attempt into the room
        result.speedDelta = Math.max(
            0,
            (BASE_SKILLING_TIME * (attempts + 1)) / ROOM_DURATION - 1 - metrics.actionSpeedBonus
        );
        result.speedTierClearChance = this.computeNonEnhancingClearStats(
            attempts + 1,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        ).clearChance;

        // Next labyrinth upgrade tiers (null when already maxed)
        result.nextSuccessUpgradeClearChance =
            upgrades.success < UPGRADE_MAX_LEVEL
                ? this.computeNonEnhancingClearStats(
                      attempts,
                      clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus + UPGRADE_SUCCESS_STEP)),
                      doubleChance,
                      progressPerSuccess,
                      targetProgress
                  ).clearChance
                : null;
        result.nextDoubleUpgradeClearChance =
            upgrades.doubleProgress < UPGRADE_MAX_LEVEL
                ? this.computeNonEnhancingClearStats(
                      attempts,
                      successChance,
                      clampChance(doubleChance + UPGRADE_STEP),
                      progressPerSuccess,
                      targetProgress
                  ).clearChance
                : null;

        result.xpPerHour = roomXpPerHour(result.xpPerRoom, result.expectedSeconds, result.clearChance);
    }

    /**
     * Compute clear stats for an enhancing room
     */
    computeEnhancingClear(roomLevel) {
        const skillId = 'enhancing';
        const actionTypeHrid = '/action_types/enhancing';
        const metrics = this.getSkillingMetrics(skillId, actionTypeHrid);

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
        const baseLevel = skill?.level || 1;

        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus));

        const actionSeconds = BASE_ENHANCING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));
        const targetLevel = 5;

        const clearStats = this.computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel);
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'enhancing';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.targetLevel = targetLevel;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        result.skillHrid = '/skills/enhancing';
        this.attachEnhancingWhatIfs(result, metrics, {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            targetLevel,
            roomLevel,
        });
        return result;
    }

    /**
     * Attach what-if clear chances and XP/hour to an enhancing result.
     */
    attachEnhancingWhatIfs(result, metrics, params) {
        const { attempts, successChance, doubleChance, levelBonus, effectiveLevel, targetLevel } = params;
        const clampChance = (v) => Math.min(1, Math.max(0, v));
        const upgrades = this.getLabyrinthUpgrades();

        const nextLevelDelta = effectiveLevel + 1 - params.roomLevel;
        const nextLevelBonus = nextLevelDelta >= 0 ? nextLevelDelta * 0.005 : nextLevelDelta * 0.01;
        result.nextLevelClearChance = this.computeEnhancingClearStats(
            attempts,
            clampSuccessChance(0.8 * (1 + nextLevelBonus + metrics.successBonus)),
            doubleChance,
            targetLevel
        ).clearChance;

        result.speedDelta = Math.max(
            0,
            (BASE_ENHANCING_TIME * (attempts + 1)) / ROOM_DURATION - 1 - metrics.actionSpeedBonus
        );
        result.speedTierClearChance = this.computeEnhancingClearStats(
            attempts + 1,
            successChance,
            doubleChance,
            targetLevel
        ).clearChance;

        result.nextSuccessUpgradeClearChance =
            upgrades.success < UPGRADE_MAX_LEVEL
                ? this.computeEnhancingClearStats(
                      attempts,
                      clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus + UPGRADE_SUCCESS_STEP)),
                      doubleChance,
                      targetLevel
                  ).clearChance
                : null;
        result.nextDoubleUpgradeClearChance =
            upgrades.doubleProgress < UPGRADE_MAX_LEVEL
                ? this.computeEnhancingClearStats(
                      attempts,
                      successChance,
                      clampChance(doubleChance + UPGRADE_STEP),
                      targetLevel
                  ).clearChance
                : null;

        result.xpPerHour = roomXpPerHour(result.xpPerRoom, result.expectedSeconds, result.clearChance);
    }

    buildResult(clearStats, actionSeconds) {
        const { clearChance, expectedAttemptsOnClear } = clearStats;
        if (clearChance <= 0) {
            return { clearChance: 0, expectedSeconds: Infinity };
        }
        const expectedSecondsOnSuccess = expectedAttemptsOnClear * actionSeconds;
        const expectedSeconds =
            (clearChance * expectedSecondsOnSuccess + (1 - clearChance) * ROOM_DURATION) / clearChance;
        return { clearChance, expectedSeconds };
    }

    /**
     * State machine for non-enhancing rooms.
     * Tracks probability distribution over progress units.
     */
    computeNonEnhancingClearStats(attempts, successChance, doubleChance, progressPerSuccess, targetProgress) {
        if (targetProgress <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (attempts <= 0 || progressPerSuccess <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };
        if (successChance <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };

        const neededUnits = Math.ceil(targetProgress / progressPerSuccess - 1e-9);
        if (neededUnits <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (neededUnits > attempts * 2) return { clearChance: 0, expectedAttemptsOnClear: null };

        const q0 = 1 - successChance;
        const q1 = successChance * (1 - doubleChance);
        const q2 = successChance * doubleChance;

        let stateDist = new Float64Array(neededUnits + 1);
        stateDist[0] = 1;
        let expectedAttemptsNumerator = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const nextDist = new Float64Array(neededUnits + 1);

            for (let units = 0; units <= neededUnits; units++) {
                const prob = stateDist[units];
                if (prob <= 0) continue;

                if (units === neededUnits) {
                    nextDist[neededUnits] += prob;
                    continue;
                }

                nextDist[units] += prob * q0;
                nextDist[Math.min(neededUnits, units + 1)] += prob * q1;
                nextDist[Math.min(neededUnits, units + 2)] += prob * q2;
            }

            const reachedNow = nextDist[neededUnits] - stateDist[neededUnits];
            if (reachedNow > 0) {
                expectedAttemptsNumerator += attempt * reachedNow;
            }

            stateDist = nextDist;
        }

        const clearChance = Math.min(1, Math.max(0, stateDist[neededUnits]));
        const expectedAttemptsOnClear = clearChance > 0 ? expectedAttemptsNumerator / clearChance : null;
        return { clearChance, expectedAttemptsOnClear };
    }

    /**
     * State machine for enhancing rooms.
     * States are enhancement levels 0..targetLevel.
     * Fail: drop to max(0, level-1). Success: +1. Double: +2.
     */
    computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel, startLevel = 0) {
        if (targetLevel <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (attempts <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };
        if (successChance <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };

        const failChance = 1 - successChance;
        const singleChance = successChance * (1 - doubleChance);
        const doubleSuccessChance = successChance * doubleChance;

        let stateDist = new Float64Array(targetLevel + 1);
        stateDist[Math.min(startLevel, targetLevel)] = 1;
        let expectedAttemptsNumerator = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const nextDist = new Float64Array(targetLevel + 1);

            for (let level = 0; level <= targetLevel; level++) {
                const prob = stateDist[level];
                if (prob <= 0) continue;

                if (level === targetLevel) {
                    nextDist[targetLevel] += prob;
                    continue;
                }

                nextDist[Math.max(0, level - 1)] += prob * failChance;
                nextDist[Math.min(targetLevel, level + 1)] += prob * singleChance;
                nextDist[Math.min(targetLevel, level + 2)] += prob * doubleSuccessChance;
            }

            const reachedNow = nextDist[targetLevel] - stateDist[targetLevel];
            if (reachedNow > 0) {
                expectedAttemptsNumerator += attempt * reachedNow;
            }

            stateDist = nextDist;
        }

        const clearChance = Math.min(1, Math.max(0, stateDist[targetLevel]));
        const expectedAttemptsOnClear = clearChance > 0 ? expectedAttemptsNumerator / clearChance : null;
        return { clearChance, expectedAttemptsOnClear };
    }

    /**
     * Get the signed skip threshold for a skill from characterSetting.
     *
     * Native MWI persists thresholds across -999..999 and a negative one is a real
     * setting, not an unset sentinel: it skips rooms that far *below* the character's
     * effective level. The recommendation search here spans the same signed range, so
     * clamping the reader to zero made a saved -22 unreadable. Only the derived room
     * level is clamped (see getTargetRoomLevel), never the threshold.
     *
     * @param {string} skillHrid
     * @returns {number} Signed threshold, 0 when unset
     */
    getSkipThreshold(skillHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const skillId = skillHrid.replace('/skills/', '');
        const key = `labyrinthSkip${skillId.charAt(0).toUpperCase()}${skillId.slice(1)}`;
        return Math.floor(Number(charSetting[key]) || 0);
    }

    /**
     * Get effective level for room assignment (base + tea crate only).
     * The game uses this to determine what room level a skip threshold maps to.
     */
    getEffectiveLevel(skillHrid) {
        const skillId = skillHrid.replace('/skills/', '');

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === skillHrid);
        const baseLevel = skill?.level || 1;

        const teaCrateBuffs = this.getTeaCrateBuffs();
        const skillLevelType = `/buff_types/${skillId}_level`;
        let teaLevelBonus = 0;
        for (const buff of teaCrateBuffs) {
            if (!buff?.typeHrid) continue;
            if (buff.typeHrid === skillLevelType) {
                teaLevelBonus += (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            }
        }

        return baseLevel + teaLevelBonus;
    }

    /**
     * The character's combat skill levels, keyed the way `utils/combat-level.js`
     * wants them. Null when there are no skills to read yet.
     * @private
     * @returns {Object|null} skill name → level
     */
    _combatSkillLevels() {
        const skills = dataManager.getSkills?.();
        if (!Array.isArray(skills) || skills.length === 0) return null;

        const levels = {};
        let found = 0;
        for (const name of COMBAT_SKILLS) {
            const skill = skills.find((entry) => entry.skillHrid === `/skills/${name}`);
            if (!skill) continue;
            levels[name] = Number(skill.level) || 0;
            found++;
        }
        return found > 0 ? levels : null;
    }

    /**
     * The learned level of every ability any labyrinth loadout names.
     *
     * A room with a loadout assigned does not sim the equipped kit:
     * `applyLoadoutSnapshotToDTO` takes the ability *set* from the snapshot and
     * each one's *level* from `characterData.characterAbilities`. The snapshot
     * carries no level, so without this a levelled ability would change every
     * loadout room's sim and change nothing in the fingerprint. Restricted to
     * the abilities loadouts actually name — the full learned book would drop
     * the whole combat cache when an ability nothing equips went up.
     * @private
     * @returns {Object} abilityHrid → learned level
     */
    _loadoutAbilityLevels() {
        const named = new Set();
        for (const snapshot of Object.values(loadoutSnapshot.snapshots || {})) {
            for (const ability of snapshot?.abilities || []) {
                if (ability?.abilityHrid) named.add(ability.abilityHrid);
            }
        }
        if (named.size === 0) return {};

        const levels = {};
        for (const ability of dataManager.characterData?.characterAbilities || []) {
            if (ability?.abilityHrid && named.has(ability.abilityHrid)) {
                levels[ability.abilityHrid] = Number(ability.level) || 1;
            }
        }
        return levels;
    }

    /**
     * The ability kit and house rooms the sim would run, read off the DTO
     * builder rather than re-derived.
     *
     * Going through `buildPlayerDTO` is the point: it is the only thing that
     * decides which ability lands in which slot and what a house room's level
     * reads as, and a second copy of that logic here would drift and silently
     * stop matching the build being simulated. Null when there is nothing to
     * read yet — `buildPlayerDTO` logs and returns null without character or
     * client data, so both are checked first rather than provoking it.
     * @private
     * @returns {{abilities: Object, houseRooms: Object}|null}
     */
    _simBuildInputs() {
        if (!dataManager.characterData || !dataManager.getInitClientData?.()) return null;
        const dto = buildPlayerDTO();
        if (!dto) return null;
        return {
            abilities: { equipped: dto.abilities, learned: this._loadoutAbilityLevels() },
            houseRooms: dto.houseRooms,
        };
    }

    /**
     * Get the player's effective combat level (used as base for skip threshold
     * calculations). The game computes room level as:
     * playerEffectiveCombatLevel + skipThreshold - 1.
     *
     * The server's own figure is preferred when it is there. When it is not —
     * before the first character update lands — the level is computed from the
     * combat skills with the game's formula rather than guessed: a hardcoded
     * 100 silently moved every recommendation by however far the character was
     * from it, and a level-40 character was told to skip sixty levels too high.
     *
     * @returns {number|null} Effective combat level, or null when there is no
     *   character data to derive one from — callers must not invent one
     */
    getPlayerEffectiveCombatLevel() {
        const serverLevel = dataManager.characterData?.combatUnit?.combatDetails?.combatLevel;
        const levels = this._combatSkillLevels();

        let baseCombatLevel = null;
        if (Number.isFinite(serverLevel) && serverLevel > 0) {
            baseCombatLevel = Math.floor(serverLevel);
        } else if (levels) {
            baseCombatLevel = computeCombatLevel(levels).level;
        }
        if (!(baseCombatLevel > 0)) return null;

        return baseCombatLevel + this._getCrateCombatLevelBonus(levels);
    }

    /**
     * Combat level bonus from the equipped labyrinth crates.
     *
     * `/buff_types/combat_level` and `/buff_types/action_level` move the level
     * directly. Per-skill level buffs do not: combat level is a weighted
     * average, so ten levels of Melee and ten of Stamina are worth different
     * amounts, and which is worth more depends on the rest of the build. They
     * used to be averaged, which is the one thing the formula never does.
     * Instead the skills are bumped and the formula re-run — the same
     * measure-don't-tabulate trick `combatValueOf` uses — so an offensive
     * skill that carries the doubled term is credited at 0.6 per level and a
     * skill that carries nothing at 0.1.
     *
     * @private
     * @param {Object|null} levels - Combat skill levels, from _combatSkillLevels()
     * @returns {number} Levels of combat gained, 0 when nothing applies
     */
    _getCrateCombatLevelBonus(levels) {
        const crateBuffs = this.getCombatCrateBuffs();
        if (crateBuffs.length === 0) return 0;

        let directLevelBonus = 0;
        const skillBumps = {};
        let bumped = false;

        for (const buff of crateBuffs) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (!Number.isFinite(amount) || amount === 0) continue;

            if (buff.typeHrid === '/buff_types/combat_level' || buff.typeHrid === '/buff_types/action_level') {
                directLevelBonus += amount;
                continue;
            }
            const match = /^\/buff_types\/(\w+)_level$/.exec(buff.typeHrid);
            const skill = match?.[1];
            if (!skill || !COMBAT_SKILLS.includes(skill)) continue;
            skillBumps[skill] = (skillBumps[skill] || 0) + amount;
            bumped = true;
        }

        // Without the character's levels there is no way to know which skill
        // carries the doubled term, so the per-skill buffs are left out rather
        // than folded in at a made-up weight
        if (!bumped || !levels) return Math.max(0, directLevelBonus);

        const boosted = { ...levels };
        for (const [skill, amount] of Object.entries(skillBumps)) {
            boosted[skill] = (boosted[skill] || 0) + amount;
        }
        const gain = computeCombatLevel(boosted).exact - computeCombatLevel(levels).exact;
        return Math.max(0, directLevelBonus + gain);
    }

    /**
     * Compute target room level from effective level + signed skip threshold.
     * Matches native MWI's boundary: floor(effectiveLevel + skipThreshold - 1).
     * The clamp belongs here, on the derived level, not on the threshold.
     *
     * @param {string} skillHrid
     * @returns {number} Room level, 0 when unset or when the threshold puts it below room 1
     */
    getTargetRoomLevel(skillHrid) {
        const skipThreshold = this.getSkipThreshold(skillHrid);
        // Zero is the unset sentinel, not a threshold of zero: `getSkipThreshold` returns it
        // for a setting that was never saved, and the automation panel reads a room level of
        // 0 as "no skip configured, draw no badge". Without this a skill with no threshold
        // reported effectiveLevel - 1 and every row grew a badge (and queued a sim) for a
        // skip the player never set.
        if (skipThreshold === 0) return 0;
        const effectiveLevel = this.getEffectiveLevel(skillHrid);
        return Math.max(0, Math.floor(effectiveLevel + skipThreshold - 1));
    }

    /**
     * Get the signed skip threshold for a combat room from characterSetting.
     * Native MWI uses the same -999..999 setting domain for combat and skilling rooms.
     *
     * @param {string} monsterHrid
     * @returns {number} Signed threshold, 0 when unset
     */
    getCombatSkipThreshold(monsterHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const monsterName = monsterHrid.replace('/monsters/', '');
        const pascal = monsterName
            .split('_')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join('');
        const key = `labyrinthSkip${pascal}`;
        return Math.floor(Number(charSetting[key]) || 0);
    }

    /**
     * Room level a combat room would be fought at per the automation skip
     * threshold (effective combat level + skip − 1), ignoring any live run.
     */
    getCombatSkipRoomLevel(monsterHrid) {
        const skipThreshold = this.getCombatSkipThreshold(monsterHrid);
        // Zero means unset — see getTargetRoomLevel
        if (skipThreshold === 0) return 0;
        const effectiveCombatLevel = this.getPlayerEffectiveCombatLevel();
        if (!(effectiveCombatLevel > 0)) return 0;
        return Math.max(0, Math.floor(effectiveCombatLevel + skipThreshold - 1));
    }

    /**
     * Get the labyrinth loadout ID for a monster from characterSetting
     */
    getLabyrinthLoadoutId(monsterHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const monsterName = monsterHrid.replace('/monsters/', '');
        const pascal = monsterName
            .split('_')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join('');
        return Number(charSetting[`labyrinthLoadout${pascal}`]) || 0;
    }

    /**
     * Build a player DTO with the labyrinth loadout applied.
     *
     * Null means "not simmable right now", and a configured loadout the
     * snapshot store has not loaded yet is exactly that: the store fills from
     * IndexedDB asynchronously, so early in a session `snapshots` is empty for
     * a character whose loadouts are perfectly well saved. Falling through to
     * the worn gear there sims the wrong build and returns a legitimate-looking
     * number — the 0% badges this guard exists to prevent.
     *
     * Once the store IS loaded, a loadout id it does not hold is a deleted or
     * never-saved loadout, not a race, and the long-standing worn-gear fallback
     * stands: those rooms keep answering rather than being bricked forever.
     * @param {number} loadoutId - 0 when no loadout is assigned
     * @returns {Object|null}
     */
    buildLabyrinthPlayerDTO(loadoutId) {
        const dto = buildPlayerDTO();
        if (!dto) return null;

        // A configured loadout with the store still loading: not yet simmable
        if (Number(loadoutId) > 0 && !loadoutSnapshot.snapshotsReady) return null;

        const snapshot = loadoutSnapshot.snapshots[loadoutId];
        if (snapshot?.name) {
            const gameData = buildGameDataPayload();
            applyLoadoutSnapshotToDTO(dto, snapshot.name, gameData);
        }
        return dto;
    }

    /**
     * Build labyrinth combat upgrade buffs from characterInfo
     */
    getLabyrinthCombatBuffs() {
        const info = dataManager.characterData?.characterInfo;
        if (!info) return [];

        const buffs = [];
        const defs = [
            ['labyrinthCombatDamageLevel', 'combat_damage', '/buff_types/damage', 'ratioBoost'],
            ['labyrinthAttackSpeedLevel', 'attack_speed', '/buff_types/attack_speed', 'ratioBoost'],
            ['labyrinthCastSpeedLevel', 'cast_speed', '/buff_types/cast_speed', 'flatBoost'],
            ['labyrinthCriticalRateLevel', 'critical_rate', '/buff_types/critical_rate', 'flatBoost'],
        ];
        for (const [infoKey, uniqueKey, typeHrid, valueKey] of defs) {
            const level = Math.max(0, Math.floor(Number(info[infoKey]) || 0));
            if (level <= 0) continue;
            const buff = {
                uniqueHrid: `/buff_uniques/labyrinth_upgrade_${uniqueKey}`,
                typeHrid,
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                startTime: '0001-01-01T00:00:00Z',
                duration: 0,
            };
            buff[valueKey] = level * UPGRADE_STEP;
            buffs.push(buff);
        }
        return buffs;
    }

    /**
     * Handle incoming labyrinth_room_progress WS message
     */
    onLiveProgress(data) {
        if (!config.getSetting('labyrinthLiveProgress')) return;
        this.refreshLiveProgress(data);
    }

    // -------------------------------------------------------------------------
    // Live clear chance for combat rooms
    //
    // Skilling rooms get a live number from labyrinth_room_progress, which
    // carries everything the closed-form math needs. Combat rooms carry no such
    // message — the tile badge's win rate comes from simulating the fight
    // beforehand, and once you are in it, it says nothing about how this one is
    // going. battle_updated is the missing input: it pushes both sides' current
    // and maximum hitpoints about three times a second.
    // -------------------------------------------------------------------------

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

    /**
     * Track a labyrinth fight and show the odds of clearing it.
     *
     * battle_updated is a sparse delta — around a fifth of real ticks carry
     * only one side. A missing unit means unchanged, never fight over: each
     * tick is merged into the last-known unit state, and the readout only
     * comes down on a real boundary (fight left, ticks gone stale, a new
     * battle, the setting turned off) — a thin tick must not remove it.
     *
     * @param {Object} data - battle_updated payload
     */
    onBattleUpdated(data) {
        if (!config.getSetting('labyrinthLiveProgress')) {
            // Turned off mid-fight, the readout comes down now — not whenever
            // the stale timer would have got round to it
            this.clearLiveCombat();
            return;
        }
        if (!this.inLabyrinthFight()) {
            this.clearLiveCombat();
            return;
        }

        const fight = this._fight;
        const tickPlayer = data?.pMap?.['0'];
        const tickMonster = data?.mMap?.['0'];
        const player = tickPlayer ? { ...fight?.lastPlayer, ...tickPlayer } : fight?.lastPlayer || null;
        const monster = tickMonster ? { ...fight?.lastMonster, ...tickMonster } : fight?.lastMonster || null;

        // A tick the merge cannot make a whole fight out of cannot open one —
        // and must not close one either. For an open fight it is still a
        // heartbeat: the stale timer refreshes and the node stays put.
        if (!player || !monster || !(monster.mHP > 0) || !(player.mHP > 0)) {
            if (fight) {
                this._armLiveCombatStaleTimer();
                this._ensureLiveCombatNode();
            }
            return;
        }

        // battleId stays put across labyrinth attempts, so a retry needs another
        // signal: an attack counter that reset, a monster maximum that changed,
        // or the monster's health leaping back to full. That last one counts only
        // the spawn's jump from low to full, not the bump a self-healing monster
        // gives itself mid-fight — see isFreshLabyrinthFight. new_battle is the
        // announced boundary (onNewBattle); this heuristic covers fights joined
        // mid-stream and whatever the socket never announced.
        const isNewFight = isFreshLabyrinthFight(fight, {
            battleId: data.battleId ?? fight?.battleId,
            monsterMaxHp: monster.mHP,
            monsterHp: monster.cHP,
            atkCounter: Number(player.atkCounter) || 0,
        });

        if (isNewFight) {
            this._fight = {
                battleId: data.battleId ?? fight?.battleId,
                monsterMaxHp: monster.mHP,
                startedAt: Date.now(),
                // Rates are measured from here, wherever "here" is. Only a fight
                // seen from full health also has a knowable clock: join one in
                // progress and the time already spent is invisible, so the timer
                // drops out rather than being guessed at.
                caughtStart: monster.cHP >= monster.mHP,
                firstMonsterFraction: monster.cHP / monster.mHP,
                firstPlayerFraction: player.cHP / player.mHP,
            };
        }
        this._fight.lastPlayer = player;
        this._fight.lastMonster = monster;
        this._fight.lastMonsterHp = monster.cHP;
        this._fight.lastAtkCounter = Number(player.atkCounter) || 0;

        const started = this._fight;
        const observedSeconds = (Date.now() - started.startedAt) / 1000;
        const monsterHpFraction = monster.cHP / monster.mHP;
        const playerHpFraction = player.cHP / player.mHP;

        const estimate = estimateLiveClearChance({
            monsterHpFraction,
            playerHpFraction,
            observedSeconds,
            monsterLostFraction: started.firstMonsterFraction - monsterHpFraction,
            playerLostFraction: started.firstPlayerFraction - playerHpFraction,
            remainingSeconds: started.caughtStart ? Math.max(0, FIGHT_TIMEOUT_SECONDS - observedSeconds) : null,
        });
        // The replayed figure is the better answer whenever one is in hand;
        // the extrapolation carries the display between replays and covers the
        // first seconds, before any replay has finished
        const replay = this._replay;
        const fresh =
            replay && replay.fightStartedAt === started.startedAt && Date.now() - replay.at < LIVE_SIM_MAX_AGE_MS;
        // An extrapolation the fight has not yet earned is shown as a band
        // rather than as a figure. The arithmetic behind it is untouched — this
        // is only a refusal to quote a number to a precision the evidence does
        // not support, which is what read as the readout swinging wildly.
        const display = liveClearDisplay({
            estimate,
            replay: fresh ? replay : null,
            previousBand: started.band || null,
            previousSmoothed: started.smoothed ?? null,
        });
        started.band = display.band;
        started.smoothed = display.smoothed;
        const text = display.text;
        this.maybeReplayFight(started, {
            monsterHpFraction,
            playerHpFraction,
            // Guarded on the denominator it divides by, not on health: `player`
            // is a sparse battle_updated delta merged over the last one, so a
            // field the server has never sent is undefined. mHP is validated
            // above for exactly that reason; mMP has to be too, or a fight whose
            // mana was never carried hands the replay Infinity or NaN.
            playerMpFraction: player.mMP > 0 && Number.isFinite(player.cMP) ? player.cMP / player.mMP : 1,
            observedSeconds,
            elapsedSeconds: started.caughtStart ? observedSeconds : 0,
        });

        // battle_updated stops arriving the moment the fight ends, and nothing
        // else would take the readout down — so it expires itself. Refreshed
        // before the redraw throttle, because a tick we chose not to draw is
        // still the fight telling us it is alive.
        this._armLiveCombatStaleTimer();

        // Ticks arrive several times a second and the estimate moves on every
        // one of them, which reads as flicker rather than as information. Nobody
        // is deciding anything on the difference between two readings a third of
        // a second apart, so only one per second is drawn. A skipped draw still
        // re-seats the node: the game re-rendering the header takes the span
        // with it, and the next tick is the repair.
        const now = Date.now();
        if (this._liveCombatDrawnAt && now - this._liveCombatDrawnAt < LIVE_COMBAT_REDRAW_MS) {
            this._ensureLiveCombatNode();
            return;
        }
        this._liveCombatDrawnAt = now;

        const clock = estimate?.timerKnown ? ` | ${Math.round(estimate.remainingSeconds)}s left` : '';
        if (!text) {
            // Before MIN_ELAPSED_SECONDS there is no chance worth quoting. A
            // placeholder holds the slot instead of blinking the node in and
            // out at every fight's start.
            this.renderLiveNode(` [Clear …${clock}]`, ['Sizing up this fight — too early to quote a chance']);
            return;
        }
        this.renderLiveNode(
            ` [${text}${clock}]`,
            [
                `You ${player.cHP}/${player.mHP} · ${monster.cHP}/${monster.mHP} monster`,
                Number.isFinite(estimate?.killSeconds)
                    ? `Kill in ~${Math.round(estimate.killSeconds)}s`
                    : 'Not killing it',
                Number.isFinite(estimate?.deathSeconds)
                    ? `Dead in ~${Math.round(estimate.deathSeconds)}s`
                    : 'Taking no damage',
                fresh
                    ? `Replayed this fight ${replay.trials} times from here — ±${(replay.halfWidth * 100).toFixed(1)}%`
                    : `${estimate.reason}${estimate.confident ? '' : ' — early, so shown as a range'}`,
                display.source === 'provisional'
                    ? `Latest reading ${(estimate.clearChance * 100).toFixed(0)}%, averaged to ` +
                      `${(display.smoothed * 100).toFixed(0)}% — health arrives in lumps, so a single reading swings`
                    : '',
                fresh && estimate ? `Extrapolated from health lost: ${(estimate.clearChance * 100).toFixed(0)}%` : '',
                estimate?.timerKnown
                    ? `${Math.round(estimate.remainingSeconds)}s left on the room timer`
                    : 'Joined this fight in progress, so the room timer is unknown and left out',
                fresh
                    ? 'Approximate: the replay restores health, mana and the clock, but cooldowns, buffs and DoTs start fresh — so it reads a fight with spent cooldowns slightly high'
                    : 'Extrapolated from the health lost so far; abilities and procs are not modelled',
            ].filter(Boolean)
        );
    }

    /**
     * Replay this fight from where it stands, many times over, and count how
     * often it ends in a clear.
     *
     * The extrapolated figure races two rates of health loss and knows nothing
     * about abilities, procs, healing or what the monster does at low health.
     * This runs the actual combat engine instead, with both sides rewound to
     * their current health and the room timer already part-spent — so every
     * replay is an independent continuation of the fight on screen, and the win
     * rate over them is the answer to the question being asked.
     *
     * What it still cannot see is anything the socket does not send: buff
     * timers, ability cooldowns, how many bites of food are left. Each replay
     * starts those fresh, which flatters a fight whose cooldowns are actually
     * spent. That error shrinks as a fight goes on and the remaining window
     * gets shorter.
     *
     * @param {Object} state - { monsterHpFraction, playerHpFraction, playerMpFraction, elapsedSeconds }
     * @returns {Promise<Object|null>} { clearChance, trials, halfWidth } or null
     */
    /**
     * Which monster, at what level, the fight in progress is against.
     *
     * The grid is asked first — it is the authority, and carries the room's own
     * recommended level. The action bar is the fallback, and the reason there
     * is one: before a `labyrinth_updated` message has landed this session the
     * grid knows nothing, and without an answer here the live readout has no
     * sim to run and falls back to extrapolating off two health bars. That
     * fallback is legitimate but noisy, and it was being used far more often
     * than it needed to be.
     *
     * @returns {{monsterHrid: string, roomLevel: number, source: string}|null}
     */
    liveRoomContext() {
        const room = this.currentRoom();
        const gridLevel = Math.max(0, Math.floor(Number(room?.recommendedLevel) || 0));
        if (room?.monsterHrid && gridLevel > 0) {
            return { monsterHrid: room.monsterHrid, roomLevel: gridLevel, source: 'grid' };
        }

        const header = document.querySelector("div[class*='Header_actionName']");
        const parsed = parseLabyrinthActionName(header?.textContent);
        if (!parsed || !(parsed.level > 0)) return null;
        const monsterHrid = monsterHridByName(parsed.name, dataManager.getInitClientData()?.combatMonsterDetailMap);
        if (!monsterHrid) return null;
        return { monsterHrid, roomLevel: parsed.level, source: 'header' };
    }

    async simulateFromHere(state) {
        const context = this.liveRoomContext();
        if (!context) return null;
        const { monsterHrid, roomLevel } = context;

        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const dto = this.buildLabyrinthPlayerDTO(loadoutId);
        if (!dto) return null;

        const simResult = await runLabyrinthSimulation({
            gameData: buildGameDataPayload(),
            playerDTOs: [dto],
            zoneHrid: '/actions/combat/fly',
            monsterHrid,
            roomLevel,
            crates: this.getCrateHrids(),
            // Each replay is only the seconds this fight has left, so even a
            // few hundred of them cost a fraction of a tile badge's sim
            hours: 1,
            precision: { minTrials: LIVE_SIM_TRIALS, maxTrials: LIVE_SIM_TRIALS },
            liveState: {
                monsterHpFraction: state.monsterHpFraction,
                playerHpFraction: state.playerHpFraction,
                playerMpFraction: state.playerMpFraction,
                elapsedNs: Math.max(0, state.elapsedSeconds) * 1e9,
            },
            // The character's own, so the replay behind the live readout is
            // running the same character the tile badges and the Lab Sim are.
            // Neither buff the engine models changes a win rate, so this does
            // not move the number on the attempt bar today — it stops the live
            // path being the one place that says the buffs are off.
            communityBuffs: getCommunityBuffs(),
            labyrinthCombatBuffs: this.getLabyrinthCombatBuffs(),
        });

        const trials = simResult.labyAttemptCount || 0;
        if (trials <= 0) return null;
        const wins = simResult.encounters || 0;
        return { clearChance: wins / trials, trials, halfWidth: wilsonInterval(wins, trials).halfWidth };
    }

    /**
     * Kick off a replay when the last one is stale, at most one at a time.
     * @param {Object} fight - The tracked fight record
     * @param {Object} state - Live fight state
     */
    maybeReplayFight(fight, state) {
        if (!config.getSetting('labyrinthLiveCombatSim')) return;
        if (this._replayRunning) return;
        // Gated on how long the fight has been *watched*, not on its own clock.
        // Those are the same number for a fight seen from full health and very
        // different for one joined in progress, where the clock is unknown and
        // passed as 0 — which meant a reload mid-fight never replayed at all,
        // and so never got off the extrapolation.
        if (state.observedSeconds < MIN_ELAPSED_SECONDS) return;
        if (this._replay?.fightStartedAt === fight.startedAt && Date.now() - this._replay.at < LIVE_SIM_REFRESH_MS) {
            return;
        }

        this._replayRunning = true;
        this.simulateFromHere(state)
            .then((result) => {
                // A replay that landed after its fight ended describes a moment
                // that no longer exists, so it is tagged with the fight it came
                // from and discarded when that stops matching
                if (result) this._replay = { ...result, at: Date.now(), fightStartedAt: fight.startedAt };
            })
            .catch((error) => {
                if (error?.message !== 'Cancelled') {
                    console.error('[LabyrinthClearRate] Live fight replay failed:', error);
                }
            })
            .finally(() => {
                this._replayRunning = false;
            });
    }

    /**
     * A new battle is the boundary the socket announces outright, where the
     * tick heuristic only ever infers one. The old readout comes down and the
     * fight record restarts, seeded from the snapshot where it carries enough
     * to seed from — a battle announced at its start has a knowable clock.
     * @param {Object} data - new_battle payload
     */
    onNewBattle(data) {
        if (!config.getSetting('labyrinthLiveProgress')) return;
        this.clearLiveCombat();
        this._fight = null;
        if (!this.inLabyrinthFight()) return;

        const monsters = Array.isArray(data?.monsters) ? data.monsters : Object.values(data?.monsters || {});
        const monsterMaxHp = Number(monsters[0]?.maxHitpoints ?? monsters[0]?.combatDetails?.maxHitpoints);
        if (!(monsterMaxHp > 0)) return; // the first tick opens the fight instead
        const monsterHp = Number(monsters[0]?.currentHitpoints ?? monsters[0]?.combatDetails?.currentHitpoints);
        const players = Array.isArray(data?.players) ? data.players : Object.values(data?.players || {});
        const playerMaxHp = Number(players[0]?.maxHitpoints ?? players[0]?.combatDetails?.maxHitpoints);
        const playerHp = Number(players[0]?.currentHitpoints ?? players[0]?.combatDetails?.currentHitpoints);

        this._fight = {
            battleId: data?.battleId,
            monsterMaxHp,
            startedAt: Date.now(),
            caughtStart: true,
            firstMonsterFraction: monsterHp > 0 ? Math.min(1, monsterHp / monsterMaxHp) : 1,
            firstPlayerFraction: playerMaxHp > 0 && playerHp > 0 ? Math.min(1, playerHp / playerMaxHp) : 1,
            lastMonsterHp: monsterHp > 0 ? monsterHp : monsterMaxHp,
            lastAtkCounter: 0,
        };
    }

    /**
     * (Re)start the countdown that takes the combat readout down once ticks
     * stop arriving — every tick of an open fight is a heartbeat, whether or
     * not it carried anything worth drawing.
     */
    _armLiveCombatStaleTimer() {
        if (this._liveCombatTimeout) clearTimeout(this._liveCombatTimeout);
        this._liveCombatTimeout = setTimeout(() => this.clearLiveCombat(), LIVE_COMBAT_STALE_MS);
    }

    /**
     * Drop the combat readout and forget the fight it described. Only called
     * on real boundaries — fight left, stale timeout, new battle, the setting
     * turned off, teardown. A tick with nothing usable for an open fight takes
     * the soft path in onBattleUpdated instead, which keeps node and width.
     */
    clearLiveCombat() {
        if (this._liveCombatTimeout) {
            clearTimeout(this._liveCombatTimeout);
            this._liveCombatTimeout = null;
        }
        if (this._fight && !this.inLabyrinthFight()) this._fight = null;
        this._liveCombatDrawnAt = 0;
        // The next fight's readout starts sizing itself from scratch.
        this._liveNodeMaxWidth = 0;
        delete this._headerReadoutText[LIVE_COMBAT_CLASS];
        document.querySelectorAll(`.${LIVE_COMBAT_CLASS}`).forEach((el) => el.remove());
    }

    /**
     * The header slot beside the action name that both live readouts write
     * into, looked up and repaired in one place so the combat and skilling
     * paths cannot diverge. The game re-rendering the header silently discards
     * the span; re-creating it here restores the last text it showed, so the
     * repair does not wait for the next full redraw. Ensure-on-update, not a
     * MutationObserver — see _previewWatchdogTick for why this file asks
     * instead of watching.
     * @param {string} className - The readout's own class
     * @param {string} cssText - The readout's own style
     * @returns {HTMLElement|null} The attached node, or null without a header
     */
    _ensureHeaderReadout(className, cssText) {
        const host =
            document.querySelector("div[class*='Header_actionName'] div[class*='Header_displayName']") ||
            document.querySelector("div[class*='Header_actionName']");
        if (!host) return null;

        let node = host.querySelector(`.${className}`);
        if (!node) {
            node = document.createElement('span');
            node.className = className;
            node.style.cssText = cssText;
            const last = this._headerReadoutText[className];
            if (last) {
                node.textContent = last.text;
                node.title = last.title;
            }
            host.appendChild(node);
        }
        return node;
    }

    /** Write a readout and remember it, so _ensureHeaderReadout can restore it */
    _writeHeaderReadout(node, text, title) {
        node.textContent = text;
        node.title = title;
        this._headerReadoutText[node.className] = { text, title };
    }

    /**
     * Re-seat the combat readout without redrawing it, keeping the reserved
     * width the fight has earned so far.
     * @returns {HTMLElement|null} The attached node, or null without a header
     */
    _ensureLiveCombatNode() {
        const node = this._ensureHeaderReadout(LIVE_COMBAT_CLASS, LIVE_COMBAT_CSS);
        if (node && this._liveNodeMaxWidth > 0) node.style.minWidth = `${this._liveNodeMaxWidth}px`;
        return node;
    }

    /**
     * Write the combat readout into the header, beside the action name — the
     * same slot the skilling readout uses. Only one can ever be showing: a room
     * is a fight or it is not.
     * @param {string} text - Readout
     * @param {string[]} tooltipLines - Hover detail
     */
    renderLiveNode(text, tooltipLines) {
        const node = this._ensureLiveCombatNode();
        if (!node) return;
        this._writeHeaderReadout(node, text, tooltipLines.join('\n'));

        // Grow the reserved width to the widest content seen this fight, and
        // never shrink it — measured at min-width:0, then pinned to the max, so
        // a narrower reading leaves the layout where the widest one put it.
        node.style.minWidth = '0px';
        const widest = Math.max(this._liveNodeMaxWidth || 0, node.scrollWidth);
        this._liveNodeMaxWidth = widest;
        node.style.minWidth = `${widest}px`;
    }

    /**
     * Normalize a chance value that may arrive as a ratio (0-1) or percent (0-100)
     * @param {*} value - Raw chance value from the WS message
     * @returns {number} Chance clamped to 0-1
     */
    normalizeChance(value) {
        const n = Number(value) || 0;
        if (n > 1 && n <= 100) {
            return Math.min(1, n / 100);
        }
        return Math.min(1, Math.max(0, n));
    }

    /**
     * Compute live clear estimate from room progress data
     */
    computeLiveEstimate(progress) {
        const isEnhancing = progress.targetLevel != null;
        const successChance = this.normalizeChance(progress.successRate);
        const doubleChance = this.normalizeChance(progress.doubleProgressChance);
        const fallbackMs = (isEnhancing ? BASE_ENHANCING_TIME : BASE_SKILLING_TIME) * 1000;
        const actionTimeMs = Math.max(1, Number(progress.actionTimeMs) || fallbackMs);
        const totalAttempts = Math.max(0, Math.floor((ROOM_DURATION * 1000) / actionTimeMs));
        const actionCounter = Math.max(0, Math.floor(Number(progress.actionCounter) || 0));
        const attemptsLeft = Math.max(0, totalAttempts - actionCounter);

        if (isEnhancing) {
            const targetLevel = Math.max(0, Math.floor(Number(progress.targetLevel) || 0));
            if (targetLevel <= 0) return null;
            const currentLevel = Math.max(0, Math.floor(Number(progress.currentEnhLevel) || 0));
            const clearStats = this.computeEnhancingClearStats(
                attemptsLeft,
                successChance,
                doubleChance,
                targetLevel,
                currentLevel
            );
            return {
                isEnhancing: true,
                clearChance: Math.min(1, Math.max(0, clearStats.clearChance || 0)),
                attemptsLeft,
                actionCounter,
                totalAttempts,
                successChance,
                doubleChance,
                currentLevel,
                targetLevel,
            };
        }

        const progressPerAction = Math.max(0, Number(progress.progressPerAction) || 0);
        const progressPerSuccess = Math.max(0, Math.floor(progressPerAction));
        const targetWorkValue = Math.max(0, Number(progress.targetWorkValue) || 0);
        if (targetWorkValue <= 0) return null;

        let currentWorkValue = Math.max(0, Number(progress.currentWorkValue) || 0);
        if (currentWorkValue <= 0) {
            const ratio = Math.min(1, Math.max(0, Number(progress.currentProgress) || 0));
            if (ratio > 0) currentWorkValue = targetWorkValue * ratio;
        }

        const remainingWork = Math.max(0, targetWorkValue - currentWorkValue);
        const clearStats = this.computeNonEnhancingClearStats(
            attemptsLeft,
            successChance,
            doubleChance,
            progressPerSuccess,
            remainingWork
        );
        return {
            isEnhancing: false,
            clearChance: Math.min(1, Math.max(0, clearStats.clearChance || 0)),
            attemptsLeft,
            actionCounter,
            totalAttempts,
            successChance,
            doubleChance,
            currentWorkValue: Math.round(currentWorkValue),
            targetWorkValue: Math.round(targetWorkValue),
        };
    }

    /**
     * Update or create the live progress overlay
     */
    refreshLiveProgress(progress) {
        if (this.liveProgressTimeout) {
            clearTimeout(this.liveProgressTimeout);
        }
        // Progress messages arrive once per action (~8-10s base) — the stale timeout
        // must outlive the action interval or the display flickers away between actions
        const actionTimeMs = Math.max(1, Number(progress?.actionTimeMs) || BASE_SKILLING_TIME * 1000);
        const staleMs = Math.max(LIVE_PROGRESS_STALE_MS, actionTimeMs * 2 + 2000);
        this.liveProgressTimeout = setTimeout(() => this.clearLiveProgress(), staleMs);

        // Seated before the estimate guard: a game rerender that swallowed the
        // node is repaired — with the last text it showed — even by a progress
        // message the math cannot use.
        const node = this._ensureHeaderReadout(LIVE_PROGRESS_CLASS, LIVE_PROGRESS_CSS);
        if (!node) return;

        const estimate = this.computeLiveEstimate(progress);
        if (!estimate) return;

        const chancePct = (estimate.clearChance * 100).toFixed(1);
        const actionText = estimate.actionCounter > 0 ? ` | #${estimate.actionCounter}` : '';
        // Only past the first, since every room is on its first try until it is not
        const tries = this.currentRoomAttempts();
        const tryText = tries > 1 ? ` | Attempt #${tries}` : '';
        const text = estimate.isEnhancing
            ? ` [Clear ${chancePct}% | +${estimate.currentLevel}/+${estimate.targetLevel} | ${estimate.attemptsLeft} left${actionText}${tryText}]`
            : ` [Clear ${chancePct}% | ${estimate.attemptsLeft} left${actionText}${tryText}]`;

        const tooltipLines = [
            `Success: ${(estimate.successChance * 100).toFixed(1)}% | Double: ${(estimate.doubleChance * 100).toFixed(1)}%`,
            `Actions: ${estimate.actionCounter}/${estimate.totalAttempts}`,
        ];
        if (tries > 1) tooltipLines.push(`Attempt ${tries} at this room`);
        if (estimate.isEnhancing) {
            tooltipLines.push(`Enhance: +${estimate.currentLevel}/+${estimate.targetLevel}`);
        } else {
            tooltipLines.push(`Progress: ${estimate.currentWorkValue}/${estimate.targetWorkValue}`);
        }
        this._writeHeaderReadout(node, text, tooltipLines.join('\n'));
    }

    /**
     * Remove live progress overlay and clear timeout
     */
    clearLiveProgress() {
        if (this.liveProgressTimeout) {
            clearTimeout(this.liveProgressTimeout);
            this.liveProgressTimeout = null;
        }
        delete this._headerReadoutText[LIVE_PROGRESS_CLASS];
        document.querySelectorAll(`.${LIVE_PROGRESS_CLASS}`).forEach((el) => el.remove());
    }

    // -------------------------------------------------------------------------
    // Per-tile clear chances on the active run grid
    // -------------------------------------------------------------------------

    /**
     * Find the grid container holding exactly all room cells of the active run
     */
    findRoomGridParent(totalCells) {
        const allCells = Array.from(document.querySelectorAll('div[class*="LabyrinthPanel_roomCell"]'));
        if (!allCells.length) return null;

        const parentCount = new Map();
        for (const cell of allCells) {
            const parent = cell.parentElement;
            if (!parent) continue;
            parentCount.set(parent, (parentCount.get(parent) || 0) + 1);
        }
        for (const [parent, count] of parentCount.entries()) {
            if (count === totalCells) return parent;
        }
        return null;
    }

    /**
     * Get the room cells of the active run in grid order
     */
    findRoomGridCells(totalCells) {
        const parent = this.findRoomGridParent(totalCells);
        if (!parent) return [];
        return Array.from(parent.children).filter((el) =>
            String(el.className || '').includes('LabyrinthPanel_roomCell')
        );
    }

    /**
     * Seed labyrinth state right after a page refresh, before any
     * labyrinth_updated message arrives. Tries the init character data first,
     * then falls back to reading the client's React state (the init payload
     * does not always carry the room grid, but the client state does).
     */
    seedFromCharacterData() {
        // pathData is seeded even when the grid already is. It only ever
        // arrived on a `labyrinth_updated` message, so a page reloaded in the
        // middle of a fight had no idea which room it was standing in until the
        // next room was entered — and `currentRoom()` returning null is what
        // silently demoted the live readout to the health extrapolation.
        if (this.roomData && this._pathData) return;

        let labyrinth = dataManager.characterData?.characterLabyrinth;
        let roomData = this.parseRoomData(labyrinth?.roomData);
        if (!roomData) {
            labyrinth = this.getLabyrinthFromReactState();
            roomData = this.parseRoomData(labyrinth?.roomData);
        }
        if (!roomData) return;

        if (this._pathData == null && labyrinth?.pathData != null) this._pathData = labyrinth.pathData;
        if (this.roomData) return;

        this.roomData = roomData;
        this.currentFloor = Math.max(0, Math.floor(Number(labyrinth.currentFloor) || 0));
    }

    /**
     * Normalize roomData that may arrive as an array or a JSON string
     */
    parseRoomData(raw) {
        if (Array.isArray(raw) && raw.length) return raw;
        if (typeof raw === 'string' && raw) {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) && parsed.length ? parsed : null;
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Read characterLabyrinth from the game's React component state
     * (same approach as the reference script - the client always holds the
     * current labyrinth grid even when no WS update has arrived yet)
     */
    getLabyrinthFromReactState() {
        try {
            const rootEl = document.getElementById('root');
            const rootFiber =
                rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
            if (!rootFiber) return null;

            const queue = [rootFiber];
            let steps = 0;
            while (queue.length && steps < 20000) {
                const fiber = queue.shift();
                if (!fiber || typeof fiber !== 'object') continue;
                steps++;

                const state = fiber.stateNode?.state;
                if (state && typeof state === 'object' && state.characterLabyrinth) {
                    return state.characterLabyrinth;
                }

                if (fiber.child) queue.push(fiber.child);
                if (fiber.sibling) queue.push(fiber.sibling);
            }
        } catch {
            return null;
        }
        return null;
    }

    /**
     * Re-sync the room grid from the game's live client state.
     *
     * `this.roomData` is only refreshed when a `labyrinth_updated` message
     * arrives with `roomData`; a dropped message — common on a throttled or
     * backgrounded mobile tab — leaves a since-cleared tile still reading
     * uncleared, so the planned route re-enters a room already finished. The
     * React state always holds the current grid (see `getLabyrinthFromReactState`),
     * so read cleared status from there before pathing. No-op when the live grid
     * is unavailable, so it can only make the cached data fresher, never blank it.
     *
     * The reverse race exists too: shrouding a tile is a server round-trip, so a
     * resim fired before the `labyrinth_updated` lands reads the tile still
     * uncleared and routes back through it. Clears are monotonic within a floor,
     * so `carryClearsForward` keeps any cleared flag the old grid held (guarded to
     * the same floor — descending resets the grid).
     */
    refreshRoomDataFromLive() {
        try {
            const labyrinth = this.getLabyrinthFromReactState();
            const live = this.parseRoomData(labyrinth?.roomData);
            if (!live) return;
            const floor = Math.floor(Number(labyrinth?.currentFloor));
            const sameFloor = Number.isFinite(floor) && floor === this.currentFloor;
            if (sameFloor && Array.isArray(this.roomData)) this.carryClearsForward(this.roomData, live);
            this.roomData = live;
            if (this._pathData == null && labyrinth?.pathData != null) this._pathData = labyrinth.pathData;
            if (Number.isFinite(floor) && floor >= 0) this.currentFloor = floor;
        } catch (error) {
            console.error('[LabyrinthClearRate] Live room-data refresh failed:', error);
        }
    }

    /**
     * Union the cleared flags of a previous grid into a fresh one, in place on
     * `next`. A tile the old grid knew was cleared stays cleared even if the
     * fresh read hasn't caught up (the shroud round-trip race). Same-floor only;
     * the caller guards that. Never un-clears — it can only add clears.
     * @param {Array<Array<Object|null>>} prev - The grid before the refresh
     * @param {Array<Array<Object|null>>} next - The fresh grid, mutated in place
     */
    carryClearsForward(prev, next) {
        for (let y = 0; y < next.length; y++) {
            const prevRow = prev[y];
            const nextRow = next[y];
            if (!Array.isArray(prevRow) || !Array.isArray(nextRow)) continue;
            for (let x = 0; x < nextRow.length; x++) {
                if (prevRow[x]?.isCleared === true && nextRow[x] && nextRow[x].isCleared !== true) {
                    nextRow[x].isCleared = true;
                }
            }
        }
    }

    /**
     * Debounced auto tile calculation (no-op unless the setting is enabled)
     */
    scheduleAutoTileCalc() {
        if (!config.getSetting('labyrinthAutoCalcTiles')) return;
        if (this.autoTileTimer) clearTimeout(this.autoTileTimer);
        this.autoTileTimer = setTimeout(() => {
            this.autoTileTimer = null;
            this.runTileCalculation({ auto: true });
        }, 800);
    }

    /**
     * A stable signature of everything a tile's clear badge is computed from:
     * each room's position, target and level, whether it is cleared, the sim
     * precision, and the gear/enhancement fingerprint. Two floors with the same
     * signature produce the same badges, so an auto pass whose signature matches
     * the last settled one has nothing new to compute.
     * @private
     * @returns {string|null}
     */
    _tileCalcFingerprint() {
        if (!this.roomData) return null;
        const flat = this.roomData.flat();
        const parts = [];
        for (let i = 0; i < flat.length; i++) {
            const room = flat[i];
            if (!room) continue;
            const target = room.skillHrid || room.monsterHrid || '';
            const level = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
            parts.push(`${i}:${target}:${level}:${room.isCleared ? 1 : 0}`);
        }
        return `${this.getSimPrecisionPct()}|${this._snapshotContentFingerprint()}|${parts.join(';')}`;
    }

    /**
     * Redraw any tile badges a game re-render wiped, from the last pass's cached
     * results — no sims, no progress bar. Used by an auto pass whose inputs are
     * unchanged, so a static floor stops re-running the whole calculation (and
     * re-filling the bar) every time the game repaints the grid.
     */
    restoreTileBadgesFromCache() {
        if (!this._tileResults || !this._tileResults.size || !this.roomData) return;
        const flatRooms = this.roomData.flat();
        const cols = Array.isArray(this.roomData[0]) ? this.roomData[0].length : labyrinthGridSize(this.currentFloor);
        if (!cols) return;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (cells.length !== flatRooms.length) return;

        for (let i = 0; i < flatRooms.length; i++) {
            const room = flatRooms[i];
            const cell = cells[i];
            if (!room || !cell || room.isCleared) continue;
            // Same chest gate as runTileCalculation: a cached result keyed by
            // grid position can survive under a treasure room (e.g. a stale
            // key left behind by a floor change), which must never be
            // repainted onto a chest as a combat badge.
            if (String(room.roomType || '').endsWith('/treasure')) continue;
            if (cell.querySelector(`.${TILE_BADGE_CLASS}`)) continue;
            const tileKey = `${i % cols},${Math.floor(i / cols)}`;
            const result = this._tileResults.get(tileKey);
            if (!result) continue;
            this.appendTileBadge(cell, result);
            this.calculatedTileKeys?.add(tileKey);
        }
    }

    /**
     * Remove clear-chance badges from rooms that have been cleared
     */
    pruneClearedTileBadges() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        const cols = Array.isArray(this.roomData[0]) ? this.roomData[0].length : 0;
        if (!cols || !flatRooms.length) return;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (cells.length !== flatRooms.length) return;

        for (let i = 0; i < flatRooms.length; i++) {
            if (!flatRooms[i]?.isCleared) continue;
            const pruneBadge = cells[i]?.querySelector(`.${TILE_BADGE_CLASS}`);
            if (pruneBadge) this.removeTileBadge(pruneBadge);
        }
    }

    /**
     * Inject the calculate control bar (top-left entries row when available)
     */
    injectTileControls() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        if (!flatRooms.length) return;

        const gridParent = this.findRoomGridParent(flatRooms.length);
        if (!gridParent || !gridParent.parentElement) return;

        const host = this.findEntriesRowHost(gridParent);
        // Every copy, not just the first. `querySelector` inspected only the
        // one it happened to find: if that one was placed correctly it returned
        // and left any other copy standing, and a stale copy the game's grid
        // re-render had orphaned kept its own buttons — including a calculate
        // button built while auto-calc was off, which is how two of them ended
        // up on screen at once. Keep at most one correctly-placed bar and drop
        // the rest, so any number of re-injections settles on a single strip.
        const placedCorrectly = (el) =>
            el.isConnected && (host ? el.parentElement === host : el.nextElementSibling === gridParent);
        const copies = Array.from(document.querySelectorAll(`.${TILE_CONTROLS_CLASS}`));
        const keep = copies.find(placedCorrectly) || null;
        for (const copy of copies) {
            if (copy !== keep) copy.remove();
        }
        if (keep) {
            // Already there and in the right place — only the auto-calc-driven
            // visibility can have gone stale under it
            this.syncTileCalcButton();
            return;
        }

        const container = document.createElement('div');
        container.className = TILE_CONTROLS_CLASS;
        container.style.cssText =
            'display:flex; flex-wrap:wrap; align-items:center; column-gap:6px; row-gap:3px; ' +
            'width:fit-content; max-width:100%; box-sizing:border-box; padding:4px 7px; margin:0 0 6px 0; ' +
            'border-radius:6px; background:rgba(0,0,0,0.62); color:#f0f4ff; box-shadow:0 2px 8px rgba(0,0,0,0.28); user-select:none;';

        // Keep each control's pieces together as one unit: a label and its input,
        // or a button and its field, live in a nowrap group so the row wraps
        // between controls, not through the middle of one. On a wide panel it is
        // one line; on a narrow one (mobile) it wraps into tidy rows instead of
        // orphaning labels from their inputs.
        const group = (...els) => {
            const g = document.createElement('span');
            g.style.cssText = 'display:inline-flex; align-items:center; gap:4px; flex-wrap:nowrap;';
            els.forEach((el) => g.appendChild(el));
            container.appendChild(g);
            return g;
        };

        const precisionLabel = document.createElement('span');
        precisionLabel.style.cssText = 'font-size:11px; opacity:0.92; white-space:nowrap;';
        precisionLabel.textContent = 'Precision ±';
        precisionLabel.title =
            'How tightly to pin each room down before its sim stops, in percentage points. ' +
            'A settled room reaches it in a few hundred fights; one near a coin toss needs thousands, ' +
            'so the work goes where the answer is still in doubt.';
        const precisionInput = document.createElement('input');
        precisionInput.className = `${TILE_CONTROLS_CLASS}-precision`;
        precisionInput.type = 'number';
        precisionInput.min = '0.1';
        precisionInput.max = '10';
        precisionInput.step = '0.5';
        precisionInput.value = String(this.getSimPrecisionPct());
        precisionInput.title = precisionLabel.title;
        precisionInput.style.cssText =
            'width:52px; height:20px; box-sizing:border-box; border:1px solid rgba(150,190,255,0.45); border-radius:4px; ' +
            'background:rgba(20,28,42,0.9); color:#fff; font-size:11px; font-weight:700; text-align:center; outline:none;';
        precisionInput.addEventListener('change', () => {
            const n = Math.min(10, Math.max(0.1, Number(precisionInput.value) || DEFAULT_SIM_PRECISION_PCT));
            precisionInput.value = String(n);
            config.setSettingValue('labyrinthSimPrecision', n);
            // Nothing to clear: the precision is part of buildCombatCacheKey, so
            // sims run at the old setting live in different slots and are never
            // read back under the new one. Clearing the Map here also emptied
            // the persisted mirror the next time anything was written, which
            // cost a session of sims for a knob that was already accounted for.
        });
        // Beside the precision it modifies: the number says how tight an answer
        // to hold out for, this says whether the fight budget is allowed to end
        // the run before that answer arrives.
        const uncappedButton = document.createElement('button');
        uncappedButton.className = `${TILE_CONTROLS_CLASS}-uncapped`;
        uncappedButton.textContent = 'Uncapped';
        uncappedButton.title =
            'Off: a room stops after the standard fight budget even if its clear chance is still ' +
            'loose, and the tooltip marks the result "(capped)". On: a manual calculation keeps ' +
            'simulating until the precision above is met. A safety backstop of 100× the normal ' +
            `budget (${(UNCAPPED_MAX_SIM_TRIALS / 1000).toLocaleString()}K fights) still ends a ` +
            'run that can never converge. Cancel stops one at any time.';
        uncappedButton.style.cssText =
            'flex:0 0 auto; padding:0 8px; height:20px; border:0; border-radius:5px; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        const syncUncapped = () => {
            const on = this.tileCalcUncapped();
            uncappedButton.style.background = on ? 'rgba(60,180,120,0.85)' : 'rgba(120,134,160,0.85)';
            uncappedButton.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        uncappedButton.addEventListener('click', () => {
            // A checkbox setting lives in `isTrue`, which only `setSetting`
            // writes — see the auto-calc toggle below for the same trap
            config.setSetting('labyrinthTileUncapped', !this.tileCalcUncapped());
            syncUncapped();
        });
        syncUncapped();
        group(precisionLabel, precisionInput, uncappedButton);

        const pathButton = document.createElement('button');
        pathButton.className = `${TILE_CONTROLS_CLASS}-path-button`;
        pathButton.textContent = 'Path';
        pathButton.title =
            'Highlight the best route to the floor exit: fewest shrouds, then most treasure rooms, then fewest torches';
        pathButton.style.cssText =
            'min-width:44px; padding:0 10px; height:20px; border:0; border-radius:5px; background:#8e5bd8; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        pathButton.addEventListener('click', () => this.runPathCalculation());

        const pathLabel = document.createElement('span');
        pathLabel.style.cssText = 'font-size:11px; opacity:0.92; white-space:nowrap;';
        pathLabel.textContent = 'Clear ≥';
        pathLabel.title = 'Tiles below this clear chance (%) count as unclearable and cost a shroud on the path';

        const pathInput = document.createElement('input');
        pathInput.className = `${TILE_CONTROLS_CLASS}-path-threshold`;
        pathInput.type = 'number';
        pathInput.min = '1';
        pathInput.max = '100';
        pathInput.step = '1';
        pathInput.value = String(config.getSettingValue('labyrinthPathClearThreshold', 70));
        pathInput.title = pathLabel.title;
        pathInput.style.cssText = precisionInput.style.cssText;
        pathInput.addEventListener('change', () => {
            const n = Math.min(100, Math.max(1, Math.floor(Number(pathInput.value) || 70)));
            pathInput.value = String(n);
            config.setSettingValue('labyrinthPathClearThreshold', n);
        });

        const unknownSelect = document.createElement('select');
        unknownSelect.className = `${TILE_CONTROLS_CLASS}-path-unknown`;
        unknownSelect.classList.add('toolasha-select');
        unknownSelect.title = 'How the path treats unrevealed rooms';
        unknownSelect.style.cssText =
            'height:20px; box-sizing:border-box; border:1px solid rgba(150,190,255,0.45); border-radius:4px; ' +
            'background:rgba(20,28,42,0.9); color:#fff; font-size:11px; font-weight:700; outline:none; cursor:pointer;';
        for (const [value, label] of [
            ['clearable', '? Clear'],
            ['shroud', '? Shroud'],
            ['avoid', '? Avoid'],
        ]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            unknownSelect.appendChild(opt);
        }
        unknownSelect.value = config.getSettingValue('labyrinthPathUnknownMode', 'shroud');
        unknownSelect.addEventListener('change', () => {
            config.setSettingValue('labyrinthPathUnknownMode', unknownSelect.value);
        });
        group(pathButton, pathLabel, pathInput, unknownSelect);

        const beaconButton = document.createElement('button');
        beaconButton.className = `${TILE_CONTROLS_CLASS}-beacon-button`;
        beaconButton.textContent = 'Beacons';
        beaconButton.title =
            'Plan beacon placements: cover a path to the exit first, a second independent route next, ' +
            'then reveal as many rooms as the count allows. 0 uses the fewest beacons that cover a path.';
        beaconButton.style.cssText =
            'min-width:54px; padding:0 10px; height:20px; border:0; border-radius:5px; background:#1d9e83; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        beaconButton.addEventListener('click', () => this.runBeaconCalculation());

        const beaconInput = document.createElement('input');
        beaconInput.className = `${TILE_CONTROLS_CLASS}-beacon-count`;
        beaconInput.type = 'number';
        beaconInput.min = '0';
        beaconInput.max = '20';
        beaconInput.step = '1';
        beaconInput.value = String(config.getSettingValue('labyrinthBeaconCount', 0));
        beaconInput.title =
            'Beacons to place on this floor — 0 uses the fewest that cover a path to the exit, and every ' +
            'new floor starts back there';
        beaconInput.style.cssText = precisionInput.style.cssText;
        beaconInput.addEventListener('change', () => {
            const n = Math.min(20, Math.max(0, Math.floor(Number(beaconInput.value) || 0)));
            beaconInput.value = String(n);
            config.setSettingValue('labyrinthBeaconCount', n);
        });

        // One click back to the automatic count, rather than spinning the field
        // down to zero a step at a time
        const beaconAutoButton = document.createElement('button');
        beaconAutoButton.className = `${TILE_CONTROLS_CLASS}-beacon-auto`;
        beaconAutoButton.textContent = '⟲';
        beaconAutoButton.title = 'Back to the fewest beacons that cover a path to the exit (min)';
        beaconAutoButton.style.cssText =
            'width:20px; height:20px; padding:0; border:0; border-radius:5px; background:rgba(29,158,131,0.6); ' +
            'color:#fff; font-size:12px; font-weight:700; line-height:1; cursor:pointer;';
        beaconAutoButton.addEventListener('click', () => this.resetBeaconCountToAuto(true));
        group(beaconButton, beaconInput, beaconAutoButton);

        // What is actually in the bag, beside the controls that spend it. The
        // planners read this fresh at plan time; this is only so the numbers a
        // plan is about to be measured against are visible before pressing.
        const supplyEl = document.createElement('span');
        supplyEl.className = `${TILE_CONTROLS_CLASS}-supplies`;
        supplyEl.style.cssText = 'font-size:10px; color:#9ab0d8; white-space:nowrap;';
        container.appendChild(supplyEl);
        this.refreshSupplyReadout();

        const clearButton = document.createElement('button');
        clearButton.className = `${TILE_CONTROLS_CLASS}-clear-button`;
        clearButton.textContent = 'Clear';
        clearButton.title = 'Remove the path highlight and the beacon plan from the map';
        clearButton.style.cssText =
            'min-width:44px; padding:0 10px; height:20px; border:0; border-radius:5px; background:rgba(120,134,160,0.85); ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        clearButton.addEventListener('click', () => this.clearRecommendations());
        container.appendChild(clearButton);

        const status = document.createElement('span');
        status.className = `${TILE_CONTROLS_CLASS}-status`;
        status.style.cssText = 'font-size:10px; color:#9ab0d8;';
        container.appendChild(status);

        const track = document.createElement('div');
        track.style.cssText =
            'flex:1 1 100%; width:100%; height:5px; border-radius:999px; background:rgba(255,255,255,0.2); overflow:hidden;';
        const bar = document.createElement('div');
        bar.className = `${TILE_CONTROLS_CLASS}-bar`;
        bar.style.cssText =
            'width:0%; height:100%; background:linear-gradient(90deg, #57d08a 0%, #8ed447 100%); transition:width 0.08s linear;';
        track.appendChild(bar);
        container.appendChild(track);

        // Collapsible: wrapped across several rows the control bar is tall, and on
        // a phone that eats most of the labyrinth panel. Fold every control behind
        // a toggle — the body keeps `display:contents` so the pieces still flow in
        // the container's flex row when open, and folds to nothing when closed.
        // Default collapsed on mobile, open on desktop; the choice sticks across
        // redraws within the session.
        const body = document.createElement('span');
        body.style.cssText = 'display:contents;';
        Array.from(container.children).forEach((child) => body.appendChild(child));

        const toggle = document.createElement('button');
        toggle.className = `${TILE_CONTROLS_CLASS}-toggle`;
        toggle.style.cssText =
            'flex:0 0 auto; padding:0 8px; height:20px; border:0; border-radius:5px; background:rgba(120,134,160,0.85); ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        if (this._tileControlsCollapsed === undefined) this._tileControlsCollapsed = isMobileMode();

        // The one calculate button. There used to be two — a full-width
        // "Calculate Labyrinth" inside the collapsible body and this one beside
        // the toggle for a folded bar on a phone — and with the body open both
        // were on screen doing the same thing. One button, always reachable
        // (it sits outside the collapsible body), which also gives cancellation
        // somewhere unambiguous to live. Hidden entirely while auto-calc is on:
        // the floor recomputes itself, so a manual press is noise.
        const autoCalcOn = () => !!config.getSetting('labyrinthAutoCalcTiles');
        const calcButton = document.createElement('button');
        calcButton.className = `${TILE_CONTROLS_CLASS}-button`;
        calcButton.style.cssText =
            'flex:0 0 auto; padding:0 8px; height:20px; border:0; border-radius:5px; background:#3a88ff; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        // Mid-run the same button is the Cancel, so the press that started a
        // long uncapped calculation is the press that stops it
        calcButton.addEventListener('click', () => {
            if (this.tileCalcRunning) this.cancelTileCalculation();
            else this.runTileCalculation();
        });

        const applyCollapsed = () => {
            const collapsed = this._tileControlsCollapsed;
            body.style.display = collapsed ? 'none' : 'contents';
            toggle.textContent = collapsed ? '▸ Labyrinth' : '▾ Labyrinth';
            toggle.title = collapsed ? 'Show labyrinth controls' : 'Hide labyrinth controls';
            this.syncTileCalcButton();
        };
        toggle.addEventListener('click', () => {
            this._tileControlsCollapsed = !this._tileControlsCollapsed;
            applyCollapsed();
        });

        // In the expanded controls: flip auto-calc on, and the quick button
        // steps aside. Reflects the current setting so it reads right on open.
        const autoButton = document.createElement('button');
        autoButton.className = `${TILE_CONTROLS_CLASS}-auto-toggle`;
        autoButton.style.cssText =
            'flex:0 0 auto; padding:0 8px; height:20px; border:0; border-radius:5px; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        const syncAuto = () => {
            const on = autoCalcOn();
            autoButton.textContent = on ? 'Auto-calc: on' : 'Enable auto-calc';
            autoButton.style.background = on ? 'rgba(60,180,120,0.85)' : 'rgba(120,134,160,0.85)';
            this.syncTileCalcButton();
        };
        autoButton.addEventListener('click', () => {
            const next = !autoCalcOn();
            // A checkbox setting is stored as `isTrue`, which is what `getSetting`
            // reads — so it must be written with `setSetting`, not `setSettingValue`
            // (that writes `.value`, which the read ignores, so the toggle did
            // nothing). The number inputs above genuinely use `setSettingValue`.
            config.setSetting('labyrinthAutoCalcTiles', next);
            syncAuto();
            if (next) this.runTileCalculation({ auto: true });
        });
        // Sit inline with the other controls, before the full-width progress
        // track — appending it after the bar left it stranded on its own row
        // below the bar, since the track is a `flex:1 1 100%` line of its own.
        body.insertBefore(autoButton, track);
        syncAuto();

        // Toggle and calculate share one nowrap line — a flex item of their own,
        // so a narrow phone bar keeps them together instead of stacking them.
        const header = document.createElement('span');
        header.style.cssText = 'display:inline-flex; align-items:center; gap:4px; flex:0 0 auto;';
        header.appendChild(toggle);
        header.appendChild(calcButton);
        container.appendChild(header);
        container.appendChild(body);
        applyCollapsed();
        this.syncTileCalcButton();

        if (host) {
            container.style.margin = '2px 0 2px 12px';
            host.appendChild(container);
        } else {
            gridParent.parentElement.insertBefore(container, gridParent);
        }
    }

    /**
     * Find the "N / M Entries · Max Path" info row at the top-left of the
     * labyrinth panel so the control bar can live there like the reference UI
     */
    findEntriesRowHost(gridParent) {
        const panelRoot =
            gridParent.closest('[class*="LabyrinthPanel_labyrinthPanel"]') ||
            gridParent.closest('[class*="LabyrinthPanel"]') ||
            gridParent.parentElement;
        if (!panelRoot) return null;

        // Match the element that directly holds the "Max Path" text. The text may
        // share its element with child elements (e.g. the Upgrade button), so
        // check each element's own text nodes rather than only pure leaf nodes.
        let marker = null;
        for (const node of panelRoot.querySelectorAll('div, span')) {
            let ownText = '';
            for (const child of node.childNodes) {
                if (child.nodeType === 3) ownText += child.textContent;
            }
            ownText = ownText.trim();
            if (ownText && ownText.length < 40 && /max path/i.test(ownText)) {
                marker = node;
                break;
            }
        }
        if (!marker) return null;

        let current = marker;
        for (let depth = 0; depth < 3 && current; depth++) {
            if (window.getComputedStyle(current).display.includes('flex')) {
                return current;
            }
            current = current.parentElement;
        }
        return marker.parentElement;
    }

    /**
     * @param {string} message - Status text
     * @param {boolean} [warn=false] - Colour it as a shortfall rather than a
     *   result. A plan you cannot afford is still a plan, so it is shown and
     *   flagged rather than suppressed.
     */
    setTileStatus(message, warn = false) {
        const status = document.querySelector(`.${TILE_CONTROLS_CLASS}-status`);
        if (!status) return;
        status.textContent = message || '';
        status.style.color = warn ? '#ff8a80' : '';
    }

    setTileProgress(ratio) {
        const bar = document.querySelector(`.${TILE_CONTROLS_CLASS}-bar`);
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
    }

    /**
     * Whether manual floor calculations ignore the fight ceiling and run to the
     * precision target (bounded by the backstop in labyrinth-sim-cache).
     * @returns {boolean}
     */
    tileCalcUncapped() {
        return config.getSetting('labyrinthTileUncapped') === true;
    }

    /**
     * The single calculate button's whole state, in one place: whether it is on
     * screen at all (auto-calc hides it), what it says, and whether pressing it
     * starts or stops a run. Called from every path that can change any of
     * those — a re-render, the auto-calc toggle, the collapse toggle, and the
     * start/end of a calculation — so the three can never disagree.
     * @param {number|null} [progress] - Rooms done so far, for the running label
     * @param {number|null} [total] - Rooms in this run
     */
    syncTileCalcButton(progress = null, total = null) {
        const btn = document.querySelector(`.${TILE_CONTROLS_CLASS}-button`);
        if (!btn) return;
        const running = !!this.tileCalcRunning;
        // With auto-calc on there is nothing for a manual press to add, and a
        // cancelled auto pass would just be re-triggered by the next re-render
        btn.style.display = config.getSetting('labyrinthAutoCalcTiles') && !running ? 'none' : '';
        btn.disabled = false;
        btn.style.opacity = '1';
        if (running) {
            const hint = total > 0 ? ` ${Math.min(progress ?? 0, total)}/${total}` : '';
            btn.textContent = `Cancel${hint}`;
            btn.title = 'Stop this calculation. Rooms already simulated keep their results.';
            btn.style.background = '#c25151';
            return;
        }
        btn.textContent = this._tileControlsCollapsed ? 'C' : 'Calc';
        btn.title = 'Calculate this floor now';
        btn.style.background = '#3a88ff';
    }

    /**
     * Stop the floor calculation in progress: the fight in flight and the rooms
     * still queued behind it. Badges already drawn stay, and so does every
     * cached sim — cancelling gives up the rest of the work, not the work done.
     */
    cancelTileCalculation() {
        if (!this.tileCalcRunning) return;
        this.cancelRunningSims();
        this.setTileStatus('Cancelled');
        this.syncTileCalcButton();
    }

    /**
     * Compute and overlay clear chances on every calculable tile of the run grid
     */
    async runTileCalculation(options = {}) {
        const auto = options.auto === true;
        // Lift the sim's fight and time ceilings for this run, so slow rooms
        // reach precision. Explicit for a caller that asks (Recompute); for a
        // manual press it is the strip's own Uncapped toggle. Never for an auto
        // pass — those fire off DOM re-renders and must stay bounded.
        const uncapped = options.uncapped === true || (!auto && this.tileCalcUncapped());
        if (this.tileCalcRunning) return;
        if (!this.roomData) {
            if (!auto) this.setTileStatus('No labyrinth data');
            return;
        }

        // Auto runs fire off the room-cell DOM observer, which our own badge
        // draws — and the game's periodic re-renders of the grid — keep tripping.
        // When nothing that changes a result has changed since the last settled
        // calc, don't re-sim and don't run the bar; just restore any badges a
        // re-render wiped, from cache. That's what stops the progress bar filling
        // and refilling on a fully revealed, static floor.
        const fingerprint = this._tileCalcFingerprint();
        if (auto && fingerprint && fingerprint === this._autoCalcFingerprint) {
            this.restoreTileBadgesFromCache();
            return;
        }

        const rows = this.roomData;
        const flatRooms = rows.flat();
        // The live grid's own width is authoritative; the official
        // MIN(3 + Floor, 8) covers roomData arriving already flattened
        const cols = Array.isArray(rows[0]) ? rows[0].length : labyrinthGridSize(this.currentFloor);
        const cells = this.findRoomGridCells(flatRooms.length);
        if (!cols || cells.length !== flatRooms.length) {
            if (!auto) this.setTileStatus('Grid not found');
            return;
        }

        if (!this.calculatedTileKeys) {
            this.calculatedTileKeys = new Set();
        }
        if (!this._tileResults) {
            this._tileResults = new Map();
        }
        // Manual runs recalculate everything; auto runs only touch new tiles
        if (!auto) {
            this.calculatedTileKeys.clear();
            this._tileResults.clear();
            this.autoTileRetryCount = 0;
            document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
        }

        // Gather targets first so the progress bar has a stable total
        const skillingTargets = [];
        const combatTargets = [];
        for (let i = 0; i < flatRooms.length; i++) {
            const room = flatRooms[i];
            const cell = cells[i];
            if (!room || !cell || room.isCleared) continue;
            // A treasure (chest) room is directly openable — no fight, no
            // gathering. The room object can still carry a leftover
            // `monsterHrid`/`skillHrid` from the game (the same reason
            // combat-battle-counter.js and labyrinth-tracker.js key off
            // `roomType` instead of trusting those fields' mere presence),
            // so without this gate a chest tile got simmed and badged like
            // a monster room.
            if (String(room.roomType || '').endsWith('/treasure')) continue;

            const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
            if (roomLevel <= 0) continue;

            const tileKey = `${i % cols},${Math.floor(i / cols)}`;
            if (auto && this.calculatedTileKeys.has(tileKey) && cell.querySelector(`.${TILE_BADGE_CLASS}`)) {
                continue;
            }

            if (room.skillHrid) {
                skillingTargets.push({ room, cell, roomLevel, tileKey });
            } else if (room.monsterHrid) {
                combatTargets.push({ room, cell, roomLevel, tileKey });
            }
        }

        const total = skillingTargets.length + combatTargets.length;
        if (!total) {
            if (!auto) this.setTileStatus('No calculable tiles');
            return;
        }

        this.tileCalcRunning = true;
        this.beginSimBatch();
        const epoch = this.simEpoch();
        this.syncTileCalcButton(0, total);
        this.setTileStatus('');
        this.setTileProgress(0);
        let completed = 0;
        let cancelled = false;

        try {
            for (const target of skillingTargets) {
                const result =
                    target.room.skillHrid === '/skills/enhancing'
                        ? this.computeEnhancingClear(target.roomLevel)
                        : this.computeSkillingClear(target.room.skillHrid, target.roomLevel);
                if (result) {
                    this.appendTileBadge(target.cell, result);
                    this.calculatedTileKeys.add(target.tileKey);
                    this._tileResults.set(target.tileKey, result);
                }
                completed++;
                this.setTileProgress(completed / total);
            }

            let combatRetryNeeded = 0;
            for (const target of combatTargets) {
                // Between rooms as well as during one: cancelling an uncapped
                // batch has to stop the queue, not just the fight in flight
                if (this.simCancelled() || this.simEpoch() !== epoch) {
                    cancelled = true;
                    break;
                }
                const result = await this.computeCombatClear(target.room.monsterHrid, target.roomLevel, { uncapped });
                if (result?.cancelled || this.simCancelled() || this.simEpoch() !== epoch) {
                    cancelled = true;
                    break;
                }
                completed++;
                this.setTileProgress(completed / total);
                this.syncTileCalcButton(completed, total);

                if (!result || result.failed) {
                    // Sim inputs not ready (e.g. loadout snapshots still loading) —
                    // leave the tile unbadged and unmarked so a retry picks it up
                    combatRetryNeeded++;
                    continue;
                }
                if (!target.cell.isConnected) continue;

                this.appendTileBadge(target.cell, result);
                this._tileResults.set(target.tileKey, result);
                if (result.clearChance > 0 || !auto) {
                    this.calculatedTileKeys.add(target.tileKey);
                } else {
                    // A 0% right after load is suspicious — keep the key unmarked
                    // so the next auto pass re-sims it with loaded snapshots
                    combatRetryNeeded++;
                }
            }

            if (cancelled) {
                // Torn down rather than stopped: the status line and the
                // fingerprint belong to a character already switched away from
                if (this.simEpoch() !== epoch) return;
                // A partial pass is not a settled one: leave the fingerprint
                // unset so the rooms that never ran are picked up next time,
                // and leave every badge already drawn exactly where it is.
                this._autoCalcFingerprint = null;
                this.setTileProgress(completed / total);
                this.setTileStatus('Cancelled');
                return;
            }

            this.setTileProgress(1);

            if (auto && combatRetryNeeded > 0 && (this.autoTileRetryCount || 0) < 3) {
                this.autoTileRetryCount = (this.autoTileRetryCount || 0) + 1;
                // Not settled — leave the fingerprint unset so the retry, and any
                // later auto pass, still run rather than being gated out.
                this._autoCalcFingerprint = null;
                if (this.autoTileTimer) clearTimeout(this.autoTileTimer);
                this.autoTileTimer = setTimeout(() => {
                    this.autoTileTimer = null;
                    this.runTileCalculation({ auto: true });
                }, 2500);
            } else if (combatRetryNeeded === 0) {
                this.autoTileRetryCount = 0;
                // Every calculable tile is badged from a full pass — record the
                // inputs so further auto triggers restore from cache instead of
                // re-simming until a room, gear, or precision actually changes.
                this._autoCalcFingerprint = fingerprint;
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Tile calculation failed:', error);
            this.setTileStatus('Failed');
        } finally {
            // A pass the feature was torn down under owns neither the flag nor
            // the button: `disable()` cleared the first, and the second belongs
            // to whatever floor is on screen now.
            if (this.simEpoch() === epoch) {
                this.tileCalcRunning = false;
                this.syncTileCalcButton();
            }
        }
    }

    /**
     * Compute and highlight the optimal route to the floor exit.
     * Clear chances come from the same per-tile math as the badges; the
     * clearable threshold is its own setting, separate from the skip
     * recommendation target.
     */
    /**
     * The labyrinth state as last seen, whatever told us about it.
     *
     * The live message first, because it is the freshest; then the character
     * data and the client's own React state, which are what a page reloaded
     * mid-run has before any message arrives.
     *
     * @returns {Object|null}
     */
    currentLabyrinthState() {
        return this._labyrinth || dataManager.characterData?.characterLabyrinth || this.getLabyrinthFromReactState();
    }

    /**
     * Torches, shrouds and beacons available right now, read fresh.
     *
     * Which pile that means depends on whether a run is going — see
     * `labyrinth-supplies.js`. Mid-run the bag is stale by construction, so the
     * run's own stock is read from the payload, or failing that off the game's
     * Supplies row; between runs the bag is the right answer and the only one.
     *
     * Never cached: supplies are spent as the run goes, and a plan drawn
     * against the count you had two floors ago is exactly the plan that told
     * the user to spend thirteen shrouds they did not have.
     *
     * @returns {Object} readSupplyCounts shape, plus `label`, `source`, `stale`,
     *   `runActive`, the hrids it was read with, and the raw `inventory`
     *   reading a plan for the *next* run has to be checked against
     */
    getSupplyCounts() {
        try {
            const hrids = resolveSupplyHrids(dataManager.getInitClientData()?.itemDetailMap);
            const labyrinth = this.currentLabyrinthState();
            // The grid being on screen is a run too — the state object can lag a
            // fresh entry, and a lagging flag would send the readout back to the
            // bag for exactly the moments this fix is about. Unless the server
            // has said outright that the run is over, in which case the grid
            // still in hand is the one it just finished and the bag is right
            // again.
            const runActive =
                isLabyrinthRunActive(labyrinth) || (labyrinth?.isActive !== false && Boolean(this.roomData?.length));

            const run = runActive ? readRunSupplyCounts(labyrinth, hrids) : null;
            const dom = runActive && !run?.known ? readSupplyRowCounts(document, hrids) : null;
            // Kept alongside the chosen reading, not just folded into it: a
            // mid-run plan is checked against the run's own stock, but a plan
            // for the *next* run — and the restock hint that names one — has to
            // be checked against the bag regardless of which pile is in view
            const inventory = readSupplyCounts(dataManager.getInventory(), hrids);

            return { ...chooseSupplyCounts({ runActive, run, dom, inventory }), hrids, inventory, runActive };
        } catch (error) {
            console.error('[LabyrinthClearRate] Reading labyrinth supplies failed:', error);
            const inventory = readSupplyCounts(null);
            return { ...inventory, label: 'held', hrids: resolveSupplyHrids(null), inventory, runActive: false };
        }
    }

    /**
     * Which tier a restock hint should quote: whichever tier is actually in
     * use, so the hint names something the user would recognise as theirs
     * rather than whatever happens to be cheapest.
     *
     * Tried against the pile in view first — this run's own stock, mid-run,
     * which is the closest thing to "what tier am I using right now" this
     * script can read — then against the bag, which still says something
     * when the run's stock of a kind has hit zero and can no longer name a
     * tier. Null when neither held anything of the kind, which sends the
     * caller back to cheapest-per-use.
     *
     * @param {Object} supplies - getSupplyCounts() result
     * @param {string} kind - 'torch' | 'shroud' | 'beacon'
     * @returns {string|null} Item hrid
     */
    preferredSupplyTier(supplies, kind) {
        return (
            bestOwnedTier(supplies, kind, supplies.hrids) ||
            bestOwnedTier(supplies.inventory, kind, supplies.hrids) ||
            null
        );
    }

    /**
     * Redraw the toolbar's supply readout.
     *
     * Drawn with the game's own item sprites rather than emoji: 🔥👻📡 were three
     * guesses at what the game means by a torch, a shroud and a beacon, in
     * whatever font the browser picked, sitting a few pixels off the baseline
     * beside the game's own artwork. The sprite for the best tier held is used,
     * so the icon also says which tier the count is mostly made of.
     *
     * The label says which pile is being shown — "this run" and "held" are
     * different numbers during a run and a readout that does not say which one
     * it means is the bug this replaced.
     *
     * Cheap enough to run on every labyrinth update, which is what keeps it
     * honest as supplies are spent mid-run.
     */
    refreshSupplyReadout() {
        const el = document.querySelector(`.${TILE_CONTROLS_CLASS}-supplies`);
        if (!el) return;

        const supplies = this.getSupplyCounts();
        if (!supplies.known) {
            el.replaceChildren();
            el.title = '';
            return;
        }

        el.replaceChildren();
        el.style.display = 'inline-flex';
        el.style.alignItems = 'center';
        el.style.gap = '4px';

        const label = document.createElement('span');
        label.textContent = `${supplies.label}:`;
        el.appendChild(label);

        for (const kind of SUPPLY_KINDS) {
            const count = document.createElement('span');
            count.textContent = String(supplies[kind]);
            el.appendChild(count);
            el.appendChild(this.supplyIcon(kind, supplies));
        }

        el.title = this.supplyReadoutTitle(supplies);
    }

    /**
     * One supply's icon: the game's sprite for the best tier held, or the emoji
     * while the game has not drawn from the item sheet yet and there is nothing
     * to point `<use>` at.
     *
     * @param {string} kind - 'torch' | 'shroud' | 'beacon'
     * @param {Object} supplies - As returned by getSupplyCounts
     * @returns {Element} An icon
     */
    supplyIcon(kind, supplies) {
        const hrid = bestOwnedTier(supplies, kind, supplies.hrids) || supplies.hrids?.[kind]?.[0];
        if (hrid && itemSpriteUrl()) {
            const icon = itemIcon(hrid, 14);
            icon.style.verticalAlign = 'middle';
            return icon;
        }
        const fallback = document.createElement('span');
        fallback.textContent = SUPPLY_EMOJI[kind] || '';
        return fallback;
    }

    /**
     * What the readout says when you hover it — including, when a run is going
     * but neither the payload nor the screen would say what it is carrying, that
     * the figures are the bag's and the run may hold fewer.
     *
     * @param {Object} supplies - As returned by getSupplyCounts
     * @returns {string}
     */
    supplyReadoutTitle(supplies) {
        const figures = `Torches ${supplies.torch}, shrouds ${supplies.shroud}, beacons ${supplies.beacon} — all tiers`;
        if (supplies.source === 'run') {
            return `${figures}, as carried by this run. Plans are checked against these.`;
        }
        if (supplies.stale) {
            return (
                `${figures}, from your inventory — this run's own stock could not be read. A run takes its ` +
                'supplies out of the bag when it starts, so it may be carrying fewer than these.'
            );
        }
        return `${figures}, from your inventory. Plans are checked against these.`;
    }

    /**
     * "and this is what it would cost you" — the price tag alone, no leading
     * separator, so callers can place it in or out of a sentence as needed.
     * @param {number} short - How many are missing
     * @param {string[]} hrids - Candidate item hrids, as `restockCandidates` ordered them
     * @returns {string}
     */
    restockNote(short, hrids) {
        const cost = estimateRestockCost(short, hrids, marketAPI);
        if (!cost) return '';
        const name = String(cost.itemHrid).replace('/items/', '').replace(/_/g, ' ');
        return `${short}× ${name} ≈ ${formatKMB(cost.total)} at ask`;
    }

    /**
     * The out-of-run restock note: a shortfall against the pile in view,
     * priced against whichever tier is actually in use.
     * @param {Object} supplies - getSupplyCounts() result
     * @param {string} kind - 'torch' | 'shroud' | 'beacon'
     * @param {number} short - How many are missing
     * @returns {string} '' or e.g. '4× expert shroud ≈ 196.0K at ask'
     */
    shortfallRestockNote(supplies, kind, short) {
        const hrids = restockCandidates(supplies.hrids?.[kind], this.preferredSupplyTier(supplies, kind));
        return this.restockNote(short, hrids);
    }

    /**
     * What the *next* run would still need to buy, once the bag is counted
     * toward it — the bag is exactly what a new run draws its starting stock
     * from, which is why this checks the shortfall against `supplies.inventory`
     * rather than the pile a mid-run plan uses.
     *
     * @param {Object} supplies - getSupplyCounts() result
     * @param {string} kind - 'torch' | 'shroud' | 'beacon'
     * @param {number} needed - What the current plan calls for
     * @param {string} noun - Singular noun, e.g. 'shroud'
     * @returns {string} '' or e.g. '4× expert shroud ≈ 196.0K at ask'
     */
    nextRunRestockNote(supplies, kind, needed, noun) {
        const invCount = supplies.inventory?.[kind] ?? 0;
        const invKnown = supplies.inventory?.known ?? false;
        const nextRun = describeSupplyNeed(needed, invCount, noun, invKnown);
        if (!nextRun.over) return '';
        return this.shortfallRestockNote(supplies, kind, nextRun.short);
    }

    /**
     * Classify a floor's rooms for the route planner.
     *
     * Position is the reliable structural signal: the grid always starts
     * top-left and exits bottom-right, and unrevealed rooms carry an empty
     * roomType — the exit/treasure types only appear once a room is revealed.
     * Every cell is a room (the labyrinth has no walls), so an unrevealed room
     * is a passable unknown, never an obstacle.
     *
     * Rooms nothing can yet be said about — unrevealed, or revealed but not
     * judged because no clear chance has been worked out for them — all take
     * the same `?` posture, so a room does not become free merely by being
     * looked at before the sims caught up with it.
     *
     * Pure with respect to the board: hand it a grid and it answers about that
     * grid, which is what lets the planner classify twice — once to find the
     * fights worth simulating, once against the board as it stands when the
     * plan is actually drawn.
     *
     * @param {Array<Object|null>} flat - Flat room grid
     * @param {Object} options
     * @param {number} options.threshold - Clear chance below which a room costs a shroud
     * @param {string} options.unknownMode - 'clearable' | 'shroud' | 'avoid'
     * @param {Function} options.chanceOf - (room, roomLevel) => clear chance, or
     *   null when the room has not been judged
     * @returns {{tiles: Array<Object|null>, unjudged: Array<Object>}}
     */
    buildPathTiles(flat, { threshold, unknownMode, chanceOf }) {
        const tiles = new Array(flat.length).fill(null);
        const unjudged = [];

        for (let i = 0; i < flat.length; i++) {
            const room = flat[i];
            const type = String(room?.roomType || '');
            const tile = {
                index: i,
                room,
                cleared: !!room?.isCleared,
                isEntrance: i === 0 || /\/(entrance|start)$/.test(type),
                isTreasure: type.endsWith('/treasure'),
                isExit: i === flat.length - 1 || /\/(descend|exit|finish|flag|victory)$/.test(type),
                isUnknown: !room || (!type && !room.skillHrid && !room.monsterHrid && !room.isCleared),
                unjudged: false,
                clearChance: 1,
                needsShroud: false,
            };
            tiles[i] = tile;
            if (tile.cleared || tile.isEntrance || tile.isTreasure || tile.isExit || tile.isUnknown) continue;

            const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
            const chance = chanceOf(room, roomLevel);
            if (chance === null || chance === undefined) {
                tile.unjudged = true;
                unjudged.push({ index: i, room, roomLevel });
                continue;
            }
            tile.clearChance = chance;
            tile.needsShroud = chance < threshold;
        }

        // Unrevealed-room posture: optimistic (clearable, default), pessimistic
        // (each costs a shroud), or avoid (impassable — route through revealed
        // rooms only; entrance/exit always stay passable)
        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            if (!tile || tile.cleared || tile.isEntrance || tile.isExit) continue;
            if (!tile.isUnknown && !tile.unjudged) continue;
            if (unknownMode === 'shroud') {
                tile.needsShroud = true;
            } else if (unknownMode === 'avoid') {
                tiles[i] = null;
            }
        }

        return { tiles, unjudged };
    }

    async runPathCalculation() {
        if (this.pathCalcRunning) return;
        // Trust the live client grid over the last websocket snapshot, which may
        // have missed a tile's clear (dropped `labyrinth_updated`, common on
        // mobile) and would otherwise route back through a room already cleared.
        this.refreshRoomDataFromLive();
        if (!this.roomData) {
            this.setTileStatus('No labyrinth data');
            return;
        }

        const rows = this.roomData;
        const flat = rows.flat();
        // The live grid's own width is authoritative; the official
        // MIN(3 + Floor, 8) covers roomData arriving already flattened
        const cols = Array.isArray(rows[0]) ? rows[0].length : labyrinthGridSize(this.currentFloor);
        // Looked up again after the sims, against whatever grid is on screen by
        // then; this is only to refuse the press when there is nothing to draw on
        if (!cols || this.findRoomGridCells(flat.length).length !== flat.length) {
            this.setTileStatus('Grid not found');
            return;
        }

        const input = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-threshold`);
        const thresholdPct = Math.min(
            100,
            Math.max(1, Math.floor(Number(input?.value) || config.getSettingValue('labyrinthPathClearThreshold', 70)))
        );
        if (input) input.value = String(thresholdPct);
        config.setSettingValue('labyrinthPathClearThreshold', thresholdPct);
        const threshold = thresholdPct / 100;

        const unknownSelect = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-unknown`);
        const unknownMode = unknownSelect?.value || config.getSettingValue('labyrinthPathUnknownMode', 'shroud');

        this.clearPathOverlays();
        this.pathCalcRunning = true;
        this.setPathButtonRunning(true);

        try {
            // Clear chances, worked out once and keyed by what they are about
            // rather than by where the room sat: a chance belongs to a monster
            // at a level, so it survives the board moving underneath it.
            // Treasure rooms, the exit and the entrance are freely enterable
            // and are never asked about.
            const chances = new Map();
            const chanceOf = (room, roomLevel) => {
                if (room.skillHrid && roomLevel > 0) {
                    const key = `${room.skillHrid}:${roomLevel}`;
                    if (!chances.has(key)) {
                        const result =
                            room.skillHrid === '/skills/enhancing'
                                ? this.computeEnhancingClear(roomLevel)
                                : this.computeSkillingClear(room.skillHrid, roomLevel);
                        chances.set(key, result ? result.clearChance : 1);
                    }
                    return chances.get(key);
                }
                if (room.monsterHrid && roomLevel > 0) {
                    const key = `${room.monsterHrid}:${roomLevel}`;
                    return chances.has(key) ? chances.get(key) : null;
                }
                // Nothing to fight and nothing to skill: freely enterable
                return 1;
            };

            // First pass, against the board as it was when the button went
            // down, only to find the fights worth simulating
            const scouted = this.buildPathTiles(flat, { threshold, unknownMode, chanceOf });
            const combatToSim = [];
            const queued = new Set();
            for (const { room, roomLevel } of scouted.unjudged) {
                const key = `${room.monsterHrid}:${roomLevel}`;
                if (queued.has(key)) continue;
                queued.add(key);
                combatToSim.push({ monsterHrid: room.monsterHrid, roomLevel, key });
            }
            // A sim that could not run is not a room that cannot be cleared.
            // `computeCombatClear` reports `failed` when its inputs are not ready
            // — the loadout snapshots still coming back from IndexedDB, most
            // often, right after a reload — and filing that as a 0% clear chance
            // puts the room below any threshold and routes the plan around it, or
            // declares the exit unreachable, with nothing on screen saying why.
            // Leaving the key unset is what `chanceOf` reads as "not judged", so
            // the room keeps the ? posture the mode selector asks for, exactly as
            // the tile-badge pass already does with the same result.
            let unsimmed = 0;
            for (let i = 0; i < combatToSim.length; i++) {
                const { monsterHrid, roomLevel, key } = combatToSim[i];
                this.setTileStatus(`Pathing: fight sims ${i + 1}/${combatToSim.length}`);
                const result = await this.computeCombatClear(monsterHrid, roomLevel);
                if (!result || result.failed) {
                    unsimmed++;
                    continue;
                }
                chances.set(key, result.clearChance);
            }

            // Second pass, against the board as it stands now. The sims take
            // their time and the run does not stop while they run: a shroud
            // clears its room outright, and rooms cleared since the button was
            // pressed must not come back marked "Shroud" — that is a plan for a
            // floor that no longer exists. Re-reading here is also what makes a
            // second press on an unchanged board give the same answer as the
            // first, and one on a board you have since shrouded give a new one.
            this.refreshRoomDataFromLive();
            const fresh = Array.isArray(this.roomData) ? this.roomData.flat() : [];
            if (fresh.length !== flat.length) {
                this.setTileStatus('The floor changed while the sims ran — press Path again');
                return;
            }
            const cells = this.findRoomGridCells(fresh.length);
            if (cells.length !== fresh.length) {
                this.setTileStatus('Grid not found');
                return;
            }
            const { tiles } = this.buildPathTiles(fresh, { threshold, unknownMode, chanceOf });

            const path = computeLabyrinthPath(tiles, cols);
            if (!path) {
                this.setTileStatus(
                    unknownMode === 'avoid'
                        ? 'No route through revealed rooms — reveal more or change the ? mode'
                        : 'No route to the floor exit'
                );
                return;
            }

            let unknownCount = 0;
            // Shrouds the route needs for rooms we have actually seen and
            // judged unclearable, as against ones assumed for a room whose
            // contents the server has not shown yet. With the ? mode set to
            // "Shroud" the second number is every unrevealed room on the route,
            // which is what turns a two-shroud floor into a thirteen-shroud
            // demand — worth separating before anyone goes shopping.
            let confirmedShrouds = 0;
            for (const idx of path.route) {
                const tile = tiles[idx];
                if (tile?.needsShroud && !tile.isUnknown && !tile.unjudged && !tile.cleared) confirmedShrouds++;
            }
            // The rooms leading up to the plan. A route only names rooms that
            // cost something, so on a floor already opened up it starts out at
            // the frontier with nothing drawn between here and there — the
            // approach is that gap, walked over ground already cleared. Drawn
            // first so a step marker always sits on top of it.
            const standingIn = this.currentRoomIndex(cols);
            const approach = computeApproachPath(
                tiles,
                cols,
                path.route,
                standingIn >= 0 ? standingIn : LABYRINTH_ENTRANCE
            );
            for (const idx of approach) {
                const cell = cells[idx];
                if (cell) this.appendPathOverlay(cell, '#57d08a', '', { approach: true });
            }

            for (const idx of path.route) {
                const tile = tiles[idx];
                const cell = cells[idx];
                if (!tile || tile.isEntrance || !cell) continue;
                // A cleared tile the route runs through is free ground walked
                // over to reach the rooms beyond it — a tile shrouded ahead of
                // the frontier, most often. Mark it walked with the same dashed
                // outline as the approach from where you stand, rather than
                // leaving it blank so the line looks like it skips a step.
                if (tile.cleared) {
                    this.appendPathOverlay(cell, '#57d08a', '', { approach: true });
                    continue;
                }
                let color;
                let label = '';
                if (tile.isExit) {
                    color = '#c792ff';
                    label = '⚑';
                } else if (tile.isTreasure) {
                    color = '#ffd54f';
                } else if (tile.needsShroud) {
                    color = '#ff5252';
                    label = tile.isUnknown || tile.unjudged ? 'Shroud?' : 'Shroud';
                } else if (tile.isUnknown || tile.unjudged) {
                    // Nothing known about it — routed as clearable; reveal to verify
                    color = '#8fb4d8';
                    label = '?';
                } else if (path.chestBranch?.has(idx)) {
                    // A room cleared only to reach a chest — an optional loot
                    // detour, not on the way out. Amber sets it apart from the
                    // green exit-critical rooms.
                    color = '#ff9800';
                } else {
                    color = '#57d08a';
                }
                if (tile.isUnknown && !tile.isExit) unknownCount++;
                this.appendPathOverlay(cell, color, label);
            }

            const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
            const unknownText = unknownCount ? ` · ${plural(unknownCount, 'unrevealed room')}` : '';

            // Every room entered costs a torch, so the route length is the
            // torch bill; shrouds are only the rooms it plans to skip.
            const supplies = this.getSupplyCounts();
            const torches = describeSupplyNeed(path.torches, supplies.torch, 'room', supplies.known);
            const shrouds = describeSupplyNeed(
                path.shrouds,
                supplies.shroud,
                'shroud',
                supplies.known,
                supplies.runActive
            );
            const assumed = path.shrouds - confirmedShrouds;
            const splitNote =
                shrouds.over && assumed > 0
                    ? ` (${confirmedShrouds} confirmed, ${assumed} assumed for unrevealed rooms — the ? mode)`
                    : '';
            // Mid-run, buying does not help the run you are in — the game only
            // hands a run its supplies at the moment it starts — so the number
            // that is short gets no price beside it, only a pointer at the run
            // it *would* help, and a next-run price counting what the bag
            // already has toward it. Out of a run, the bag can still be topped
            // up right now, so the price stands as it always has.
            let shroudNote = '';
            if (shrouds.over) {
                // Mid-run there is nothing to say: buying more cannot change
                // this run, and the next run's bag is the next run's business
                if (!supplies.runActive) {
                    const buyNote = this.shortfallRestockNote(supplies, 'shroud', shrouds.short);
                    shroudNote = buyNote ? ` · ${buyNote}` : '';
                }
            }
            const torchNote = torches.over ? ` · only ${supplies.torch} torches for ${path.torches} entries` : '';

            // Rooms walked through cost nothing and are nothing to do, so they
            // are counted beside the plan's own rooms rather than inside them
            const walkedNote = approach.length ? ` (+${approach.length} walked)` : '';

            // Fights the sims could not judge are routed under the ? posture, not
            // as unclearable — so the plan is honest, but it is a weaker plan than
            // it looks and it says so rather than passing itself off as settled
            const unsimmedNote = unsimmed
                ? ` · ${plural(unsimmed, 'fight')} could not be simmed — press Path again`
                : '';

            this.setTileStatus(
                `Path: ${plural(path.torches, 'room')}${walkedNote} · ${shrouds.text}${shroudNote} · ` +
                    `${plural(path.chests.size, 'chest')}${unknownText}${splitNote}${torchNote}${unsimmedNote}`,
                shrouds.over || torches.over || unsimmed > 0
            );
        } catch (error) {
            console.error('[LabyrinthClearRate] Path calculation failed:', error);
            this.setTileStatus('Path failed');
        } finally {
            this.pathCalcRunning = false;
            this.setPathButtonRunning(false);
        }
    }

    /**
     * Outline a run-grid tile as part of the computed route
     */
    appendPathOverlay(cell, color, label, { approach = false } = {}) {
        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        const overlay = document.createElement('div');
        overlay.className = PATH_OVERLAY_CLASS;
        // An approach room is one to walk through, not one to do anything in,
        // so it reads as the same highlight turned down: dashed, faded, and
        // underneath the steps it leads to
        if (approach) overlay.dataset.approach = '1';
        overlay.style.cssText = approach
            ? `position:absolute; inset:0; border:2px dashed ${color}; border-radius:6px; opacity:0.45; ` +
              'pointer-events:none; z-index:7; box-sizing:border-box;'
            : `position:absolute; inset:0; border:2px solid ${color}; border-radius:6px; ` +
              'pointer-events:none; z-index:8; box-sizing:border-box;';
        if (label) {
            const tag = document.createElement('div');
            tag.style.cssText =
                `position:absolute; top:1px; left:1px; padding:0 3px; border-radius:3px; background:${color}; ` +
                'color:#000; font-size:8px; font-weight:700; line-height:1.4;';
            tag.textContent = label;
            overlay.appendChild(tag);
        }
        cell.appendChild(overlay);
    }

    clearPathOverlays() {
        document.querySelectorAll(`.${PATH_OVERLAY_CLASS}`).forEach((el) => el.remove());
    }

    /**
     * Compute and highlight beacon placements — the fewest beacons, or the
     * count set for this floor, put where they cover a path to the exit first,
     * a second independent route next, and as many new rooms as what is left
     * over allows.
     */
    runBeaconCalculation() {
        if (!this.roomData) {
            this.setTileStatus('No labyrinth data');
            return;
        }

        const rows = this.roomData;
        const flat = rows.flat();
        // The live grid's own width is authoritative; the official
        // MIN(3 + Floor, 8) covers roomData arriving already flattened
        const cols = Array.isArray(rows[0]) ? rows[0].length : labyrinthGridSize(this.currentFloor);
        const cells = this.findRoomGridCells(flat.length);
        if (!cols || cells.length !== flat.length) {
            this.setTileStatus('Grid not found');
            return;
        }

        const countInput = document.querySelector(`.${TILE_CONTROLS_CLASS}-beacon-count`);
        const requested = Math.min(20, Math.max(0, Math.floor(Number(countInput?.value) || 0)));
        // The input keeps what was asked for — clamping the field itself would
        // lose the request the moment a beacon is spent, and it is the setting
        // the user chose, not a reading of the bag
        if (countInput) countInput.value = String(requested);
        config.setSettingValue('labyrinthBeaconCount', requested);

        // 0 means "the fewest that open a corridor", which is a question about
        // the floor rather than a number to be clamped; the answer is checked
        // against what is held once the plan comes back.
        const supplies = this.getSupplyCounts();
        const budget = requested > 0 ? clampToOwned(requested, supplies.beacon, supplies.known) : null;
        const count = budget ? budget.effective : 0;

        const revealed = flat.map((room, i) => i === 0 || isRoomRevealed(room));

        this.clearBeaconOverlays();
        if (budget?.clamped && count === 0) {
            const word = remainingWord(supplies.runActive);
            this.setTileStatus(`No beacons ${word} — ${requested} set / 0 ${word}`, true);
            return;
        }
        const plan = computeBeaconPlan(revealed, cols, count);
        if (!plan) {
            this.setTileStatus('Beacon planning failed');
            return;
        }
        if (!plan.feasible) {
            this.setTileStatus('No beacon chain can reach the exit');
            return;
        }
        if (!plan.beacons.length) {
            const routeNote = plan.routes >= 2 ? ` (${plan.routes} independent routes)` : '';
            this.setTileStatus(
                plan.minNeeded === 0
                    ? `Path to the exit is already revealed — no beacons needed${routeNote}`
                    : 'Nothing left for a beacon to reveal'
            );
            return;
        }

        for (const idx of plan.covered) {
            const cell = cells[idx];
            if (cell) this.appendBeaconOverlay(cell, false, '');
        }
        plan.beacons.forEach((idx, i) => {
            const cell = cells[idx];
            if (cell) this.appendBeaconOverlay(cell, true, `B${i + 1}`);
        });

        // Remember what each beacon was planned to reveal so its indicators
        // can be cleared once those rooms actually get revealed (beacon used)
        const dist = (a, b) =>
            Math.abs((a % cols) - (b % cols)) + Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
        this._beaconPlanCells = {
            fills: [...plan.covered],
            centers: plan.beacons.map((idx) => ({
                idx,
                watch: [...plan.covered].filter((c) => dist(c, idx) <= BEACON_RADIUS),
            })),
        };

        const minNote = count === 0 ? ' (min)' : '';
        // A clamped run drew fewer beacons than were asked for, and says so
        // where the count is stated rather than in a footnote
        const ownedNote = budget?.clamped
            ? ` (${budget.requested} set / ${budget.owned} ${remainingWord(supplies.runActive)})`
            : '';
        const parts = [
            `Beacons: ${plan.beacons.length}${minNote}${ownedNote}`,
            `reveals ${plan.revealedNew} new rooms`,
            plan.routes >= 2 ? `${plan.routes} independent routes` : '1 route',
        ];
        // A plan only leaves the way out dark when the count was too small to
        // cover it, and then the honest thing is to say what it would take
        if (count > 0 && !plan.corridorOpen && Number.isFinite(plan.minNeeded)) {
            parts.push(`a covered path to the exit needs ${plan.minNeeded}`);
        }
        // The minimum-chain mode is not clamped on the way in, so the shortfall
        // only shows up here — an answer of "you need 5" is still the answer
        // when 3 are held, it just is not one you can act on yet
        const needed = describeSupplyNeed(
            plan.beacons.length,
            supplies.beacon,
            'beacon',
            supplies.known,
            supplies.runActive
        );
        if (needed.over) {
            parts.push(`${supplies.beacon} ${remainingWord(supplies.runActive)}`);
            // Same rule as the shroud shortfall in the path summary: mid-run, a
            // price beside the run's own shortfall would be a price for
            // something buying more cannot fix right now
            if (!supplies.runActive) {
                const buyNote = this.shortfallRestockNote(supplies, 'beacon', needed.short);
                if (buyNote) parts.push(buyNote);
            }
        }
        this.setTileStatus(parts.join(' · '), needed.over || !!budget?.clamped);
    }

    /**
     * Put the beacon count back to the automatic "fewest that cover a path to
     * the exit" mode.
     *
     * A count answers a question about the floor in front of you — how many
     * beacons this map is worth — so it is a per-floor override rather than a
     * standing preference. Both the button beside the field and arriving on a
     * new floor clear it.
     *
     * @param {boolean} [announce=false] - Say so in the status line
     * @returns {boolean} Whether a manual count was actually cleared
     */
    resetBeaconCountToAuto(announce = false) {
        const current = Math.max(0, Math.floor(Number(config.getSettingValue('labyrinthBeaconCount', 0)) || 0));
        config.setSettingValue('labyrinthBeaconCount', 0);
        const countInput = document.querySelector(`.${TILE_CONTROLS_CLASS}-beacon-count`);
        if (countInput) countInput.value = '0';
        if (announce) {
            this.setTileStatus(
                current > 0
                    ? 'Beacon count back to the fewest that cover a path (min)'
                    : 'Already on the fewest that cover a path (min)'
            );
        }
        return current > 0;
    }

    /**
     * Highlight a tile as beacon coverage (fill) or a beacon center (outline + label)
     */
    appendBeaconOverlay(cell, isCenter, label) {
        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        const overlay = document.createElement('div');
        overlay.className = BEACON_OVERLAY_CLASS;
        if (isCenter) overlay.dataset.beaconCenter = '1';
        overlay.style.cssText = isCenter
            ? 'position:absolute; inset:0; border:2px solid #26d0aa; border-radius:6px; ' +
              'pointer-events:none; z-index:8; box-sizing:border-box;'
            : 'position:absolute; inset:0; background:rgba(38,166,154,0.22); border:1px solid rgba(38,166,154,0.45); ' +
              'border-radius:6px; pointer-events:none; z-index:7; box-sizing:border-box;';
        if (label) {
            const tag = document.createElement('div');
            tag.style.cssText =
                'position:absolute; top:1px; right:1px; padding:0 3px; border-radius:3px; background:#26d0aa; ' +
                'color:#04263f; font-size:8px; font-weight:700; line-height:1.4;';
            tag.textContent = label;
            overlay.appendChild(tag);
        }
        cell.appendChild(overlay);
    }

    clearBeaconOverlays() {
        document.querySelectorAll(`.${BEACON_OVERLAY_CLASS}`).forEach((el) => el.remove());
        this._beaconPlanCells = null;
    }

    /**
     * Wipe both recommendation overlays at once, so the bare map can be read
     * without re-running a calculation or switching floors to clear them.
     */
    clearRecommendations() {
        this.clearPathOverlays();
        this.clearBeaconOverlays();
        this.setTileProgress(0);
        this.setTileStatus('Path and beacons cleared');
    }

    /**
     * Remove beacon plan indicators once their rooms are revealed: coverage
     * fills clear room by room, and a numbered center marker clears when every
     * room it was planned to reveal is revealed — i.e. that beacon has been
     * used (or made redundant by torches/other beacons).
     */
    pruneUsedBeaconOverlays() {
        const state = this._beaconPlanCells;
        if (!state || !this.roomData) return;
        const flat = this.roomData.flat();
        if (!flat.length) return;
        const cells = this.findRoomGridCells(flat.length);
        if (cells.length !== flat.length) return;

        const isRevealed = (i) => isRoomRevealed(flat[i]);

        state.fills = state.fills.filter((i) => {
            if (!isRevealed(i)) return true;
            cells[i]
                ?.querySelectorAll(`.${BEACON_OVERLAY_CLASS}:not([data-beacon-center])`)
                .forEach((el) => el.remove());
            return false;
        });
        state.centers = state.centers.filter((center) => {
            if (center.watch.length > 0 && !center.watch.every(isRevealed)) return true;
            cells[center.idx]
                ?.querySelectorAll(`.${BEACON_OVERLAY_CLASS}[data-beacon-center]`)
                .forEach((el) => el.remove());
            return false;
        });
        if (!state.fills.length && !state.centers.length) {
            this._beaconPlanCells = null;
        }
    }

    /**
     * Remove path outlines from rooms that have been cleared since the route
     * was computed, so the highlight tracks remaining progress
     */
    pruneClearedPathOverlays() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        if (!flatRooms.length) return;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (cells.length !== flatRooms.length) return;

        for (let i = 0; i < flatRooms.length; i++) {
            if (!flatRooms[i]?.isCleared) continue;
            // Every approach room is a cleared room — that is what makes it
            // free to walk — so clearing progress is no reason to rub one out
            cells[i]?.querySelector(`.${PATH_OVERLAY_CLASS}:not([data-approach])`)?.remove();
        }
    }

    setPathButtonRunning(running) {
        const btn = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-button`);
        if (btn) {
            btn.disabled = running;
            btn.textContent = running ? 'Pathing...' : 'Path';
            btn.style.opacity = running ? '0.75' : '1';
        }
    }

    /**
     * Overlay a clear-chance badge in the corner of a run grid tile
     */
    /**
     * Remove a tile badge and drop its cell's preview binding so cleared or
     * reset tiles stop showing hover tooltips
     * @param {HTMLElement} badge - Badge element inside a tile cell
     */
    removeTileBadge(badge) {
        const cell = badge.parentElement;
        if (cell) cell.__mwiPreviewResult = null;
        badge.remove();
    }

    appendTileBadge(cell, result) {
        cell.querySelector(`.${TILE_BADGE_CLASS}`)?.remove();

        const chance = Math.min(1, Math.max(0, result.clearChance ?? 0));
        const pct = Math.round(chance * 100);

        // On mobile the tiles are small and the browser inflates tiny fonts
        // (text-size-adjust), so "100% 19s" grew wider than the badge and spilled
        // out of its coloured box past the tile edge. Pin the inflation off,
        // shrink the fonts a step on a phone, and let the badge size to its text
        // (max-width capped the box but not the nowrap text inside it) so the
        // colour always wraps the whole reading and it stays within the tile.
        // On mobile the tile is small, so shrink the fonts a couple of steps and
        // pin text inflation off — enough that "100% 19s" fits whole. Nothing is
        // clipped: the earlier ellipsis cut the seconds down to a stray digit, so
        // the badge sizes to its (now small) text instead of hiding part of it.
        const mobile = isMobileMode();
        const badge = document.createElement('div');
        badge.className = TILE_BADGE_CLASS;
        badge.style.cssText =
            'position:absolute; right:1px; bottom:1px; z-index:9; max-width:calc(100% - 2px); padding:1px 3px; ' +
            'border-radius:3px; box-sizing:border-box; display:flex; align-items:baseline; justify-content:flex-end; gap:2px; ' +
            'white-space:nowrap; color:#fff; text-shadow:0 1px 1px rgba(0,0,0,0.55); pointer-events:auto; ' +
            '-webkit-text-size-adjust:100%; text-size-adjust:100%; ' +
            `background:${this.getTileBadgeColor(chance)};`;

        const chanceSpan = document.createElement('span');
        chanceSpan.style.cssText = `font-size:${mobile ? 7 : 9}px; font-weight:700; line-height:1; flex:0 0 auto;`;
        chanceSpan.textContent = `${pct}%`;

        const etaSpan = document.createElement('span');
        etaSpan.style.cssText = `font-size:${mobile ? 6 : 8}px; font-weight:600; line-height:1; opacity:0.95; flex:0 0 auto;`;
        etaSpan.textContent = this.formatEtaSeconds(result.expectedSeconds ?? result.avgFightSeconds, pct);

        badge.appendChild(chanceSpan);
        badge.appendChild(etaSpan);

        // Rich preview for every tile type, triggered from anywhere in the tile
        this.bindPreview(cell, result);

        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        cell.appendChild(badge);
    }

    getTileBadgeColor(clearChance) {
        if (clearChance >= 0.95) return '#1fbf60';
        if (clearChance >= 0.8) return '#77b82a';
        if (clearChance >= 0.6) return '#d2ac19';
        if (clearChance >= 0.4) return '#d27a1f';
        return '#d84b4b';
    }

    formatEtaSeconds(expectedSeconds, pct) {
        if (pct === 0 || !Number.isFinite(expectedSeconds)) return '999+';
        const seconds = Math.max(0, Math.ceil(expectedSeconds));
        return seconds > 999 ? '999+' : `${seconds}s`;
    }

    findRoomByMonsterHrid(monsterHrid) {
        if (!this.roomData) return null;
        for (const row of this.roomData) {
            for (const cell of row) {
                if (cell && cell.monsterHrid === monsterHrid) {
                    return cell;
                }
            }
        }
        return null;
    }

    /**
     * Inject clear rate overlays onto visible labyrinth room cells
     */
    injectOverlays() {
        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        // Whatever badge the preview is anchored to is about to be torn down
        // (or already has been, if this call is the one finding zero cells
        // left) — hide it before it can start showing over whatever replaced
        // the table, rather than leaving that to the watchdog's next tick
        this.hidePreview();
        if (!cells.length) return;

        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
        this.simQueue = [];

        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;

            const isSkill = roomHrid.startsWith('/skills/');
            const isMonster = roomHrid.startsWith('/monsters/');
            if (!isSkill && !isMonster) continue;

            if (isSkill) {
                // The skip-threshold table is a skill-level plan — "what my
                // threshold clears" — not a readout of the run you happen to be
                // in. Always sim the level the threshold implies (effective level
                // + threshold − 1), never the live room's, or the badges swing to
                // whatever the current labyrinth rolled and stop answering the
                // question the table asks.
                const roomLevel = this.getTargetRoomLevel(roomHrid);
                if (!roomLevel || roomLevel <= 0) continue;

                const isEnhancing = roomHrid === '/skills/enhancing';
                const result = isEnhancing
                    ? this.computeEnhancingClear(roomLevel)
                    : this.computeSkillingClear(roomHrid, roomLevel);

                if (!result) continue;
                this.appendBadge(cell, result, roomLevel);
            } else {
                // Skill-level plan, not the live run — see the skilling branch.
                const roomLevel = this.getCombatSkipRoomLevel(roomHrid);
                if (!roomLevel || roomLevel <= 0) continue;

                // Under the Automation tab's own precision, which is what the
                // queue below sims and stores at. Looking up under the map's
                // instead missed every entry whenever the two settings differ,
                // so every redraw re-simmed every combat row from scratch.
                const cached = this.getCachedCombatResult(roomHrid, roomLevel, this.getAutomationSimPrecisionPct());
                if (cached) {
                    this.appendBadge(cell, cached, roomLevel);
                } else {
                    const badge = this.appendPlaceholderBadge(cell);
                    this.queueCombatSim(roomHrid, roomLevel, badge);
                }
            }
        }

        this.processSimQueue();
        this.injectRecommendControls();
        this.injectRecommendationBadges();
    }

    appendBadge(cell, result, roomLevel) {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.style.cssText = 'font-size:0.7rem; white-space:nowrap;';
        this.decorateBadge(badge, result, roomLevel);
        getAnnotationContainer(cell).appendChild(badge);
        return badge;
    }

    /**
     * Apply text (with max reachable floor), color, and hover preview to a badge
     */
    decorateBadge(badge, result, roomLevel) {
        badge.style.color = this.getBadgeColor(result.clearChance);
        const pct = Math.round(result.clearChance * 100);
        const timeText = this.formatTime(result.expectedSeconds);
        const maxFloor = Math.floor((roomLevel || 0) / 20);
        const floorText = maxFloor >= 1 ? `F${maxFloor} · ` : '';
        badge.textContent = pct >= 100 ? `${floorText}${timeText}` : `${floorText}${pct}% ${timeText}`;

        // Every room type gets the full card. Combat rows used to fall back to a
        // three-line title while the skilling rows beside them showed a dozen
        // figures — and a fight is the row where the detail is hardest to get at
        // any other way, since its numbers come out of a simulation rather than
        // off the screen.
        badge.removeAttribute('title');
        this.bindPreview(badge, result);
    }

    appendPlaceholderBadge(cell) {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.style.cssText = 'font-size:0.7rem; white-space:nowrap; color:#999;';
        badge.textContent = '...';
        badge.title = 'Simulating combat...';
        getAnnotationContainer(cell).appendChild(badge);
        return badge;
    }

    updateBadge(badge, result, roomLevel) {
        this.decorateBadge(badge, result, roomLevel);
    }

    /**
     * Extract skill HRID from a skip threshold cell's row
     */
    extractRoomHrid(cell) {
        try {
            const row = cell.closest('tr');
            if (!row) return null;

            const useEl = row.querySelector('[class*="LabyrinthPanel_roomLabel"] use');
            if (!useEl) return null;

            const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
            if (!href) return null;

            const slug = href.split('#')[1];
            if (!slug) return null;

            if (href.includes('skills_sprite')) {
                return `/skills/${slug}`;
            }
            return `/monsters/${slug}`;
        } catch {
            return null;
        }
    }

    /**
     * Bind hover preview events to a badge (result stored on the element so
     * updates replace content without re-binding listeners)
     */
    bindPreview(badge, result) {
        badge.__mwiPreviewResult = result;
        if (badge.__mwiPreviewBound) return;
        badge.__mwiPreviewBound = true;
        badge.style.cursor = 'help';
        const show = (e) => {
            const res = badge.__mwiPreviewResult;
            if (!res) return;
            this.showPreview(res, e.clientX, e.clientY, badge);
        };
        badge.addEventListener('mouseenter', show);
        badge.addEventListener('mousemove', show);
        badge.addEventListener('mouseleave', () => this.hidePreview());
        badge.addEventListener('contextmenu', (e) => {
            const res = badge.__mwiPreviewResult;
            if (!res || !this.canOpenSim(res)) return;
            e.preventDefault();
            this.openSimFromPreview(res);
        });
        // A tap is the touch equivalent of hovering: no mouseenter ever fires,
        // so without this the preview simply does not exist on a phone. The
        // right-click path lives in the preview itself as a tappable action.
        badge.addEventListener('click', (e) => {
            if (!hasCoarsePointer()) return;
            const res = badge.__mwiPreviewResult;
            if (!res) return;
            e.preventDefault();
            e.stopPropagation();
            this.showPreview(res, e.clientX, e.clientY, badge);
            this._armPreviewDismiss(badge);
        });
    }

    /**
     * Whether a preview result carries enough to preconfigure the simulator
     * @param {Object} res - A preview result
     * @returns {boolean}
     */
    canOpenSim(res) {
        const hrid = res.type === 'combat' ? res.monsterHrid : res.skillHrid;
        return Boolean(hrid) && Boolean(document.querySelector('.toolasha-lab-sim-btn'));
    }

    /**
     * Open the lab simulator preconfigured from a preview result: combat tiles
     * select the monster (applying its assigned loadout) at the tile's room
     * level; skilling tiles open the Skilling tab at that level.
     * @param {Object} res - A preview result
     */
    openSimFromPreview(res) {
        const simButton = document.querySelector('.toolasha-lab-sim-btn');
        if (!simButton) return;
        const isCombat = res.type === 'combat';
        const panel = document.getElementById('mwi-lab-sim-panel');
        if (!panel || panel.style.display === 'none') {
            simButton.click();
        }
        document.dispatchEvent(
            new CustomEvent('mwi-labsim-open', {
                detail: isCombat
                    ? { monsterHrid: res.monsterHrid, roomLevel: res.roomLevel }
                    : { skillHrid: res.skillHrid, roomLevel: res.roomLevel },
            })
        );
        this.hidePreview();
    }

    /**
     * Hide the tap-opened preview when the next press lands outside it.
     * Hover previews need none of this — mouseleave does the job.
     * @param {HTMLElement} badge - The badge the preview belongs to
     */
    _armPreviewDismiss(badge) {
        if (this._previewDismiss) return;
        this._previewDismiss = (e) => {
            const el = document.getElementById(PREVIEW_ID);
            if ((el && el.contains(e.target)) || badge.contains(e.target)) return;
            this.hidePreview();
        };
        document.addEventListener('pointerdown', this._previewDismiss, true);
    }

    /**
     * Get or create the shared preview tooltip element
     */
    ensurePreviewEl() {
        let el = document.getElementById(PREVIEW_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = PREVIEW_ID;
            el.style.cssText =
                'position:fixed; min-width:180px; max-width:260px; padding:6px 9px; border-radius:6px; ' +
                'border:1px solid rgba(128,170,255,0.45); background:rgba(12,16,24,0.96); color:#f2f7ff; ' +
                `font-size:11px; line-height:1.4; pointer-events:none; display:none; z-index:${config.Z_NOTIFICATION};`;
            document.body.appendChild(el);
        }
        return el;
    }

    /**
     * Show the rich preview for a skilling/enhancing result near the cursor
     *
     * @param {Object} result - What to render
     * @param {number} x - Cursor X
     * @param {number} y - Cursor Y
     * @param {HTMLElement} [anchor] - The badge or tile the preview is for,
     *   remembered so the watchdog can tell an orphaned preview from a live
     *   one — see `_previewWatchdogTick`
     */
    showPreview(result, x, y, anchor = null) {
        const el = this.ensurePreviewEl();
        if (this._previewFor !== result) {
            this.renderPreviewContent(el, result);
            this._appendTouchAction(el, result);
            this._previewFor = result;
        }
        this._previewAnchor = anchor || null;
        this._startPreviewWatchdog();
        // Interactive only on touch, where it holds the open-in-sim action; a
        // hover tooltip that catches the pointer would fire mouseleave on the
        // badge under it and dismiss itself
        el.style.pointerEvents = hasCoarsePointer() ? 'auto' : 'none';
        el.style.display = 'block';

        const offset = 12;
        const margin = 8;
        const width = el.offsetWidth || 200;
        const height = el.offsetHeight || 150;
        let left = x + offset;
        let top = y + offset;
        if (left + width + margin > window.innerWidth) {
            left = Math.max(margin, x - width - offset);
        }
        if (top + height + margin > window.innerHeight) {
            top = Math.max(margin, y - height - offset);
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    hidePreview() {
        const el = document.getElementById(PREVIEW_ID);
        if (el) el.style.display = 'none';
        this._previewFor = null;
        this._previewAnchor = null;
        this._stopPreviewWatchdog();
        if (this._previewDismiss) {
            document.removeEventListener('pointerdown', this._previewDismiss, true);
            this._previewDismiss = null;
        }
    }

    /**
     * The orphan this whole mechanism exists to catch: a preview shown for a
     * badge that React then yanked out from under it — leaving the tab, a
     * floor changing, the panel switching — none of which fire `mouseleave`
     * on a node that is simply gone. `mouseleave` only ever fires for a
     * pointer that is still moving over a document the node is still part of;
     * a removed node gets no event at all, hover or otherwise.
     *
     * Cheap on purpose: this only ever does work while a preview is visible,
     * and the check itself is a single `isConnected` read — no querying, no
     * MutationObserver watching the whole subtree for a departure it could
     * instead just ask about on a slow, bounded interval.
     */
    _previewWatchdogTick() {
        const el = document.getElementById(PREVIEW_ID);
        if (!el || el.style.display === 'none') return;
        if (this._previewAnchor && !this._previewAnchor.isConnected) this.hidePreview();
    }

    /**
     * Catches what the direct hidePreview() calls cannot: the grid
     * disappearing with no further labyrinth_updated message to react to at
     * all, e.g. navigating from the grid to the Labyrinth info tab mid-run.
     * Runs only while a preview is showing — see `_previewWatchdogTick`.
     */
    _startPreviewWatchdog() {
        if (this._previewWatchdog) return;
        this._previewWatchdog = setInterval(() => this._previewWatchdogTick(), PREVIEW_WATCHDOG_MS);
    }

    _stopPreviewWatchdog() {
        if (!this._previewWatchdog) return;
        clearInterval(this._previewWatchdog);
        this._previewWatchdog = null;
    }

    /**
     * The tappable stand-in for right-click, appended after whichever branch
     * of renderPreviewContent built the rows.
     * @param {HTMLElement} el - The preview element
     * @param {Object} result - The preview result the button acts on
     */
    _appendTouchAction(el, result) {
        if (!hasCoarsePointer() || !this.canOpenSim(result)) return;
        const action = document.createElement('button');
        action.textContent = 'Open in sim →';
        action.style.cssText =
            'display:block; width:100%; margin-top:6px; padding:6px 8px; border-radius:4px; ' +
            'border:1px solid rgba(128,170,255,0.45); background:rgba(77,151,255,0.18); color:#9ec4ff; ' +
            'font-size:11px; font-weight:700; cursor:pointer;';
        action.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openSimFromPreview(result);
        });
        el.appendChild(action);
    }

    /**
     * Build the preview tooltip content for a skilling/enhancing result
     */
    renderPreviewContent(el, result) {
        el.textContent = '';
        const pct = (v) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`;
        const deltaPct = (v) => `+${(Math.max(0, v) * 100).toFixed(2)}%`;

        const titleText =
            result.type === 'combat'
                ? `${result.monsterName}`
                : `${result.type === 'enhancing' ? 'Enhancing' : 'Skilling'} Room Preview`;
        const title = document.createElement('div');
        title.style.cssText = 'margin-bottom:4px; font-weight:700; color:#9ec4ff;';
        title.textContent = titleText;
        el.appendChild(title);

        const addRow = (label, value, title) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; gap:10px; white-space:nowrap;';
            if (title) row.title = title;
            const labelEl = document.createElement('span');
            labelEl.style.opacity = '0.75';
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.style.fontWeight = '700';
            valueEl.textContent = value;
            row.appendChild(labelEl);
            row.appendChild(valueEl);
            el.appendChild(row);
        };

        if (result.type === 'combat') {
            this.renderCombatPreviewRows(addRow, result);
            this._appendCacheAgeNote(el, result);
            return;
        }

        if (result.type === 'enhancing') {
            addRow('Target Enhancement', `+${result.targetLevel}`);
        } else {
            const raw = result.workPower;
            const floored = result.progressPerSuccess;
            addRow(
                'Work Power',
                Math.abs(raw - floored) < 1e-9 ? raw.toFixed(2) : `${raw.toFixed(2)} \u2192 ${floored}`
            );
        }
        addRow('Success Rate', pct(result.successChance));
        addRow('Double Progress', pct(result.doubleChance));
        addRow('Actions in 2m', `${result.attempts}`);
        addRow('Action Duration', `${result.actionSeconds.toFixed(2)}s`);
        // The full expected time to clear, uncapped (the tile badge caps at "999+")
        if (Number.isFinite(result.expectedSeconds) && result.expectedSeconds > 0) {
            addRow('Est. clear time', this.fullClearTime(result.expectedSeconds));
        }
        if (result.xpPerRoom) {
            addRow('EXP / Room', `${result.xpPerRoom.toFixed(1)}`);
        }
        if (result.xpPerHour > 0) {
            addRow('EXP / Hour', `${(result.xpPerHour / 1000).toFixed(1)}K`);
        }
        if (result.type !== 'enhancing') {
            addRow(
                'Efficiency for -1 Progress',
                result.efficiencyDelta === null ? 'Already optimal' : deltaPct(result.efficiencyDelta)
            );
        }
        if (Number.isFinite(result.speedDelta)) {
            addRow('Speed for +1 Action', deltaPct(result.speedDelta));
        }
        if (Number.isFinite(result.nextLevelClearChance)) {
            addRow('Next Level Clear %', pct(result.nextLevelClearChance));
        }
        if (result.type !== 'enhancing') {
            addRow(
                'Efficiency Tier Clear %',
                Number.isFinite(result.efficiencyTierClearChance)
                    ? pct(result.efficiencyTierClearChance)
                    : 'Already optimal'
            );
        }
        if (Number.isFinite(result.speedTierClearChance)) {
            addRow('Speed Tier Clear %', pct(result.speedTierClearChance));
        }
        if (Number.isFinite(result.nextSuccessUpgradeClearChance)) {
            addRow('Next Success Upgrade', pct(result.nextSuccessUpgradeClearChance));
        }
        if (Number.isFinite(result.nextDoubleUpgradeClearChance)) {
            addRow('Next Double Upgrade', pct(result.nextDoubleUpgradeClearChance));
        }

        this.appendExpectedRows(addRow, result);
        // On touch the instruction would be wrong — the tappable button
        // appended after this stands in for right-click there
        if (!hasCoarsePointer() && result.skillHrid && document.querySelector('.toolasha-lab-sim-btn')) {
            addRow('Action', 'Right-click to open simulator');
        }
    }

    /**
     * Render the rich combat tile preview: scaled monster stats, abilities,
     * rewards, loadout, and the sim-derived failure reason.
     * @param {Function} addRow - Row builder from renderPreviewContent
     * @param {Object} result - Combat clear result
     */
    renderCombatPreviewRows(addRow, result) {
        const styleName = (hrid) => {
            const tail =
                String(hrid || '')
                    .split('/')
                    .pop() || '';
            return tail.charAt(0).toUpperCase() + tail.slice(1);
        };

        const monster = this.buildScaledMonster(result.monsterHrid, result.roomLevel);
        const gameData = dataManager.getInitClientData();
        const monsterDetail = gameData?.combatMonsterDetailMap?.[result.monsterHrid];

        // What the badge's percentage is worth. Trials vary room to room now
        // that sims stop on precision, so the sample behind the figure is worth
        // stating rather than leaving to be assumed.
        if (Number.isFinite(result.halfWidth) && result.trials > 0) {
            const band = (result.halfWidth * 100).toFixed(1);
            addRow(
                'Clear Chance',
                `${(result.clearChance * 100).toFixed(1)}% ±${band}${result.hitTarget ? '' : ' (capped)'}`
            );
            addRow('Fights Simulated', `${result.trials.toLocaleString()}`);
        }

        // The full expected time to clear, uncapped — the tile badge caps at
        // "999+", which hides how long a slow room really takes
        if (Number.isFinite(result.expectedSeconds) && result.expectedSeconds > 0) {
            addRow('Est. clear time', this.fullClearTime(result.expectedSeconds));
        }

        // Per entry rather than per clear. A fight earns experience by landing
        // hits, so a room you usually lose still pays — and quoting only what a
        // win is worth would make a room you clear 5% of the time look like it
        // returns nothing at all.
        if (result.xpPerRoom > 0) {
            addRow('EXP / Room', `${result.xpPerRoom.toFixed(1)}`);
        }
        if (result.xpPerHour > 0) {
            addRow('EXP / Hour', `${(result.xpPerHour / 1000).toFixed(1)}K`);
        }

        // How the fight has actually gone, which is the only thing that can
        // catch the sim being confidently wrong
        const observed = this.observedOutcome(result.monsterHrid, result.roomLevel);
        if (observed?.attempts > 0) {
            const check = compareToPrediction(observed.clears, observed.attempts, result.clearChance, wilsonInterval);
            const note = check.verdict === 'consistent' ? '' : ` — ${check.verdict}`;
            addRow(
                'Actually Cleared',
                `${observed.clears}/${observed.attempts} (${(check.observed * 100).toFixed(0)}%)${note}`
            );
        }

        if (monster) {
            const stats = monster.combatDetails.combatStats;
            const styleHrid = stats.combatStyleHrid || stats.combatStyleHrids?.[0] || '';
            const styleKey = String(styleHrid).split('/').pop() || 'stab';
            const damageTypeHrid = stats.damageType || '/damage_types/physical';

            addRow('Combat Style', styleName(styleHrid));
            addRow('Damage Type', styleName(damageTypeHrid));
            addRow('Attack Interval', `${(stats.attackInterval / 1e9).toFixed(2)}s`);
            addRow('Cast Speed', `${Math.round((stats.castSpeed || 0) * 100)}%`);
            addRow(
                `${styleName(styleHrid)} Accuracy`,
                `${Math.round(monster.combatDetails[`${styleKey}AccuracyRating`] || 0)}`
            );
            addRow(
                `${styleName(styleHrid)} Damage`,
                `${Math.round(monster.combatDetails[`${styleKey}MaxDamage`] || 0)}`
            );
            addRow('Max HP', `${Math.round(monster.combatDetails.maxHitpoints || 0)}`);

            // Evasion vs the player's own combat style, mitigation vs their damage type
            const playerStats = dataManager.characterData?.combatUnit?.combatDetails?.combatStats;
            const playerStyleHrid = playerStats?.combatStyleHrids?.[0] || '/combat_styles/stab';
            const playerStyleKey = String(playerStyleHrid).split('/').pop();
            const playerDamageType = playerStats?.damageType || '/damage_types/physical';
            addRow(
                `${styleName(playerStyleHrid)} Evasion`,
                `${Math.round(monster.combatDetails[`${playerStyleKey}EvasionRating`] || 0)}`
            );
            if (playerDamageType === '/damage_types/physical') {
                addRow('Armor', `${Math.round(monster.combatDetails.totalArmor || 0)}`);
            } else {
                const resistKey = `total${styleName(playerDamageType)}Resistance`;
                addRow(
                    `${styleName(playerDamageType)} Resistance`,
                    `${Math.round(monster.combatDetails[resistKey] || 0)}`
                );
            }
        }

        // Ability list at labyrinth-scaled levels (same floor-scaling as the sim engine)
        if (Array.isArray(monsterDetail?.abilities)) {
            const scale = result.roomLevel > 0 ? result.roomLevel / 100 : 1;
            const abilityMap = gameData?.abilityDetailMap || {};
            for (const ability of monsterDetail.abilities) {
                if (!ability?.abilityHrid) continue;
                const level = Math.max(1, Math.floor((ability.level || 1) * scale));
                const name =
                    abilityMap[ability.abilityHrid]?.name || ability.abilityHrid.split('/').pop().replace(/_/g, ' ');
                addRow(`Lv.${level}`, name);
            }
        }

        this.appendExpectedRows(addRow, result);
        if (result.loadoutName) {
            addRow('Loadout', `"${result.loadoutName}"`);
        }
        addRow('Win Rate', `${(Math.min(1, Math.max(0, result.winRate)) * 100).toFixed(1)}%`);
        if (document.querySelector('.toolasha-lab-sim-btn')) {
            addRow('Action', 'Right-click to open simulator');
        }
        if (result.failureReason) {
            addRow('Failure Reason', result.failureReason);
        }
    }

    /**
     * A one-line, subdued note when a combat result survived from a previous
     * session rather than being simmed just now — otherwise the preview reads
     * as fresh whether it's a minute or a week old.
     * @param {HTMLElement} el - Preview element
     * @param {Object} result - Combat clear result
     */
    _appendCacheAgeNote(el, result) {
        // The gear mark is not conditional on the entry having survived a
        // reload. The case the Recompute button's own tooltip admits — "a plain
        // equip does not always refresh a sim" — happens inside one session, to
        // an entry simmed minutes ago, and that entry has no age worth showing
        // and every reason to be marked.
        if (this._markGearChanged(el, result)) return;
        if (!result.fromPersistedCache || !Number.isFinite(result.computedAt)) return;
        const note = document.createElement('div');
        note.style.cssText = 'margin-top:4px; opacity:0.6; font-style:italic; white-space:nowrap;';
        note.textContent = this.cacheAgeLabel(result.computedAt);
        el.appendChild(note);
    }

    /**
     * Mark a result that was simulated under gear other than what is worn now.
     *
     * An age is not the question a player is asking of a cached tile. "Cached
     * 2h ago" is true of a result that is still perfectly good and of one that
     * was invalidated by an equip ten minutes ago, and the tile reads the same
     * either way — so the only honest response to a floor of them was to press
     * Recompute and re-sim everything, including the rooms that had not changed.
     *
     * The comparison is the fingerprint the recommendation invalidation already
     * keeps ({@link FINGERPRINT_SPEC}): loadout snapshots, each worn item and
     * its enhancement level, the seven combat skill levels, the ability kit and
     * the house rooms. It sees nothing else — buffs and consumables are out —
     * and the marker says nothing else, see {@link GEAR_CHANGED_MARK}.
     *
     * When it marks, it marks *instead of* the age rather than beside it: a
     * result whose gear no longer holds is not stale-ish, and how long ago it
     * stopped being true is not the useful half of the sentence.
     *
     * @param {HTMLElement} el - Preview element
     * @param {Object} result - Combat clear result
     * @returns {boolean} Whether a mark was drawn
     */
    _markGearChanged(el, result) {
        // The five-second whenReady deadline can pass with nothing loaded, and
        // a fingerprint over an empty snapshot set matches no stored one — so
        // without this guard a reload marks every tile on the floor at once
        const ready = loadoutSnapshot.snapshotsReady === true;
        let current = null;
        try {
            current = ready ? this._snapshotContentFingerprint() : null;
        } catch (error) {
            console.error('[LabyrinthClearRate] Reading the current gear fingerprint failed:', error);
            return false;
        }
        if (!gearChangedSince(result?.snapshotFingerprint, current, ready)) return false;

        const note = document.createElement('div');
        note.style.cssText = 'margin-top:4px; opacity:0.85; font-style:italic; color:#f0ad4e;';
        note.textContent = GEAR_CHANGED_MARK;
        note.title = GEAR_CHANGED_DETAIL;
        el.appendChild(note);
        return true;
    }

    /**
     * "cached 2h ago" — the age of a persisted sim result.
     * @param {number} computedAt - Date.now() from when the entry was written
     * @returns {string}
     */
    cacheAgeLabel(computedAt) {
        const rel = formatRelativeTime(Date.now() - computedAt);
        return rel === 'Just now' ? 'cached just now' : `cached ${rel} ago`;
    }

    /**
     * Build a labyrinth-scaled engine Monster for tooltip stats. Uses the same
     * scaling as the simulation so displayed numbers match simmed numbers.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @returns {Monster|null}
     */
    buildScaledMonster(monsterHrid, roomLevel) {
        if (!monsterHrid) return null;
        const cacheKey = `${monsterHrid}|${roomLevel}`;
        if (!this._scaledMonsterCache) this._scaledMonsterCache = new Map();
        if (this._scaledMonsterCache.has(cacheKey)) return this._scaledMonsterCache.get(cacheKey);

        let monster = null;
        try {
            const payload = buildGameDataPayload();
            if (payload) {
                setGameData(payload);
                monster = new Monster(monsterHrid, 0, roomLevel);
                monster.updateCombatDetails();
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Failed to build scaled monster for preview:', error);
            monster = null;
        }
        this._scaledMonsterCache.set(cacheKey, monster);
        return monster;
    }

    /**
     * Append the expected token/box reward rows for the current floor.
     *
     * The rates are the game's own drop tables — see `labyrinthRoomRewards`
     * for the three schedules. A challenge room pays nothing at all unless it
     * is cleared, so the drop rate is not what you expect to receive from
     * entering it: the expectation is `rate × clearChance`. The unweighted
     * figure said a room you clear one time in five was worth as much as one
     * you always clear, which is the whole point of the badge next to it.
     * Treasure rooms and the floor exit ask for no clear, so they are shown
     * whole.
     *
     * @param {Function} addRow - Row builder from renderPreviewContent
     * @param {Object|string} [result] - Clear result (a bare type string is
     *   accepted for callers that have nothing else); `clearChance` weights the
     *   figures and `type` picks the reward schedule
     */
    appendExpectedRows(addRow, result) {
        const floor = Math.max(0, Math.floor(Number(this.currentFloor) || 0));
        if (floor < 1) return;

        const type = typeof result === 'string' ? result : result?.type;
        const rewards = labyrinthRoomRewards(floor, type);
        const needsClear = type !== 'treasure' && type !== 'exit';

        const clearChance = typeof result === 'object' && result ? Number(result.clearChance) : NaN;
        const rawWeight = Number.isFinite(clearChance) && clearChance >= 0 ? Math.min(1, clearChance) : 1;
        const weight = needsClear ? rawWeight : 1;

        const note =
            weight < 1
                ? `\nWeighted by this room's ${(weight * 100).toFixed(0)}% clear chance — an uncleared room pays nothing.`
                : '';
        const source =
            type === 'treasure'
                ? 'Treasure room: MIN(Floor, 10) tokens always, plus MIN(Floor × 5%, 50%) for one box of each type.'
                : type === 'exit'
                  ? 'Floor exit: 5 × Floor tokens always; from floor 4 both box types, from floor 6 a Refinement Chest.'
                  : "Challenge room: MIN(Floor × 5%, 50%) for a token, MIN(Floor × 1%, 10%) for a Purdora's Box.";

        addRow('Token Expected', (rewards.tokens * weight).toFixed(2), `${source}${note}`);
        if (rewards.skillingBoxes > 0) {
            addRow('Skilling Box Expected', (rewards.skillingBoxes * weight).toFixed(2), `${source}${note}`);
        }
        if (rewards.combatBoxes > 0) {
            addRow('Combat Box Expected', (rewards.combatBoxes * weight).toFixed(2), `${source}${note}`);
        }
        if (rewards.refinementChests > 0) {
            addRow('Refinement Chest Expected', (rewards.refinementChests * weight).toFixed(2), `${source}${note}`);
        }
    }

    getBadgeColor(clearChance) {
        if (clearChance >= 0.95) return '#00c896';
        if (clearChance >= 0.7) return '#f0ad4e';
        return '#d9534f';
    }

    /**
     * Compute skilling metrics from override buff arrays instead of live data.
     * @param {string} skillId - e.g. "woodcutting"
     * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
     * @param {Object} overrides
     * @param {Array} [overrides.equipmentBuffs] - Equipment buff objects for this action type
     * @param {Array} [overrides.communityBuffs] - Community buff objects
     * @param {Array} [overrides.houseBuffs] - House room buff objects
     * @param {Array} [overrides.crateBuffs] - Crate buff objects
     * @param {Object} [overrides.tokenUpgrades] - {speed, efficiency, success, doubleProgress}
     * @param {Object} [overrides.guildShrineLevels] - buffHrid → level, for shrine levels being explored
     * @returns {Object} {skillLevelBonus, efficiencyBonus, actionSpeedBonus, successBonus, doubleProgressBonus}
     */
    getSkillingMetricsFromOverrides(skillId, actionTypeHrid, overrides) {
        const metrics = {
            skillLevelBonus: 0,
            efficiencyBonus: 0,
            actionSpeedBonus: 0,
            successBonus: 0,
            doubleProgressBonus: 0,
            gatheringBonus: 0,
            experienceBonus: 0,
        };

        const skillLevelType = `/buff_types/${skillId}_level`;
        const skillSuccessType = `/buff_types/${skillId}_success`;

        const guildBuffs = this.resolveGuildBuffs(actionTypeHrid, overrides.guildShrineLevels);

        const buffSources = [
            overrides.equipmentBuffs,
            overrides.communityBuffs,
            overrides.houseBuffs,
            dataManager.characterData?.achievementActionTypeBuffsMap?.[actionTypeHrid],
            // Not editable and so not in the overrides, exactly like the
            // achievement buffs above — and, exactly like them, part of what the
            // live `getSkillingMetrics` scores a room with. Leaving it out made
            // the panel's baseline disagree with the tile's by the Moo Pass's
            // wisdom for every subscriber.
            dataManager.characterData?.mooPassActionTypeBuffsMap?.[actionTypeHrid],
            guildBuffs,
        ];

        for (const buffs of buffSources) {
            if (!Array.isArray(buffs)) continue;
            for (const buff of buffs) {
                if (!buff?.typeHrid) continue;
                const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                if (amount === 0) continue;
                this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
            }
        }

        for (const buff of overrides.crateBuffs || []) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (amount === 0) continue;
            this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
        }

        const upgrades = overrides.tokenUpgrades || {};
        metrics.actionSpeedBonus += (upgrades.speed || 0) * UPGRADE_STEP;
        metrics.efficiencyBonus += (upgrades.efficiency || 0) * UPGRADE_STEP;
        metrics.successBonus += (upgrades.success || 0) * UPGRADE_SUCCESS_STEP;
        metrics.doubleProgressBonus += (upgrades.doubleProgress || 0) * UPGRADE_STEP;
        // `experience` was missing from every caller's tokenUpgrades object, so
        // this line was adding NaN and the XP bonus silently read as zero
        metrics.experienceBonus += (upgrades.experience || 0) * UPGRADE_STEP;

        return metrics;
    }

    /**
     * Compute skilling clear from pre-built metrics and base level.
     * @param {Object} metrics - From getSkillingMetrics() or getSkillingMetricsFromOverrides()
     * @param {number} baseLevel - Character skill level
     * @param {number} roomLevel - Labyrinth room level
     * @returns {Object} Clear result with stats
     */
    computeSkillingClearWithParams(metrics, baseLevel, roomLevel) {
        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus + (metrics.gatheringBonus || 0)));

        const workPower = effectiveLevel * (1 + metrics.efficiencyBonus);
        const progressPerSuccess = Math.max(0, Math.floor(workPower));
        const targetProgress = roomLevel * 10;

        const actionSeconds = BASE_SKILLING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));

        const clearStats = this.computeNonEnhancingClearStats(
            attempts,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        );
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'skilling';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.workPower = workPower;
        result.progressPerSuccess = progressPerSuccess;
        result.targetProgress = targetProgress;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        // The pieces behind the success rate, so a caller can show its working:
        // effectiveLevel = baseLevel + skillLevelBonus, and success is
        // 0.8 × (1 + levelBonus + successBonus).
        result.skillLevelBonus = metrics.skillLevelBonus;
        result.levelDelta = levelDelta;
        result.levelBonus = levelBonus;
        result.successBonus = metrics.successBonus;
        return result;
    }

    /**
     * Compute enhancing clear from pre-built metrics and base level.
     *
     * Reports `xpPerRoom`/`xpPerHour` on the same footing as the skilling and
     * combat twins. A labyrinth room pays on completion rather than per action,
     * so the award is a property of the room — `roomLevel × 50`, raised by
     * whatever experience bonus applies — and enhancing rooms are no exception.
     * They were the one room type reporting nothing, which is why callers
     * averaging XP per room (`upgrade-advisor.js`'s
     * computeAverageSkillingXpPerRoomFromEditor) skip enhancing outright rather
     * than averaging in a spurious zero. That exclusion can now be dropped:
     * enhancing rooms carry a real figure, so including them is correct.
     *
     * @param {Object} metrics - From getSkillingMetrics() or getSkillingMetricsFromOverrides()
     * @param {number} baseLevel - Character enhancing level
     * @param {number} roomLevel - Labyrinth room level
     * @returns {Object} Clear result with stats, including xpPerRoom and xpPerHour
     */
    computeEnhancingClearWithParams(metrics, baseLevel, roomLevel) {
        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus));

        const actionSeconds = BASE_ENHANCING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));
        const targetLevel = 5;

        const clearStats = this.computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel);
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'enhancing';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.targetLevel = targetLevel;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        result.xpPerHour = roomXpPerHour(result.xpPerRoom, result.expectedSeconds, result.clearChance);
        return result;
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '—';
        if (seconds >= 9999) return '∞';
        const s = Math.round(seconds);
        if (s < 60) return `~${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return `~${m}:${rem.toString().padStart(2, '0')}`;
    }

    /**
     * Expected time to clear a room, in full — not capped at "999+" or "∞" the
     * way the tile badge is. The badge has to stay short, but on hover the real
     * figure is what tells you a room "clears" in twenty minutes, not two.
     * @param {number} seconds - Expected seconds per clear (losing attempts included)
     * @returns {string} e.g. "48s", "10m 55s", "1h 5m", or "—" when it never clears
     */
    fullClearTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '—';
        const s = Math.round(seconds);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${s % 60}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }
}

// Method groups that live in their own modules, mixed onto the prototype here.
// Order is immaterial — no name is defined twice — and this runs before the
// singleton below is constructed, so every instance sees the full surface.
Object.assign(LabyrinthClearRate.prototype, outcomeMethods, simCacheMethods, recommendationMethods);

const labyrinthClearRate = new LabyrinthClearRate();
export default labyrinthClearRate;
