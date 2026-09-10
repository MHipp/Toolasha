/**
 * Data Manager Module
 * Central hub for accessing game data
 *
 * Uses official API: localStorageUtil.getInitClientData()
 * Listens to WebSocket messages for player data updates
 */

import webSocketHook from './websocket.js';
import performanceMonitor from '../utils/performance-monitor.js';
import connectionState from './connection-state.js';
import storage from './storage.js';
import {
    mergeOwnedAbilities,
    reconcileEquippedAbilities,
    applyAbilityProgress,
    equippedAbilitiesFromBattle,
    abilityKitsDiffer,
} from './character-abilities.js';
import {
    extractGuildShrineData,
    loadGuildShrineLevels,
    saveGuildShrineLevels,
    buffMapBelongsTo,
    mapSize,
} from './guild-shrine-store.js';
import { mergeMarketListings } from '../utils/market-listings.js';
import { SCROLL_BUFF_VALUES } from '../utils/scroll-buff-values.js';

/**
 * Whether two plain hrid -> value maps hold the same entries.
 *
 * Only ever used on the guild buff and building-level maps, which are flat
 * objects of numbers, so a shallow comparison is the whole comparison.
 * @param {Object|null|undefined} a - Left map
 * @param {Object|null|undefined} b - Right map
 * @returns {boolean} True when both hold the same keys and values
 */
function shallowEqualMaps(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
        if (!Object.hasOwn(b, key) || a[key] !== b[key]) return false;
    }
    return true;
}

/** Retries of the static-data load before giving up (60 x 500 ms = 30 s). */
const MAX_STATIC_DATA_ATTEMPTS = 60;

/** Switches closer together than this skip the expensive feature teardown. */
const RAPID_SWITCH_WINDOW_MS = 1000;

/**
 * Ticks of the 500 ms fallback poll before an *evidenced* missed payload is
 * acted on (10 x 500 ms = 5 s).
 *
 * Not a guess at how slow a login can be: this path only runs once the hook has
 * reported that it attached to an already-open socket, which means the opening
 * payload was delivered before we were listening and no amount of further
 * waiting will produce it. The five seconds are only there so a socket that
 * opened during our own startup gets a fair chance to deliver a late
 * `init_character_data` through the getter before we call it lost.
 */
const EARLY_RECOVERY_ATTEMPTS = 10;

/**
 * Marks that this tab has already spent its one automatic recovery reload.
 *
 * `sessionStorage` and not the storage module on purpose: this has to be
 * readable synchronously, before a reload is decided on, and it has to survive
 * that reload while being scoped to the one tab. IndexedDB is async and shared
 * across tabs, so it can answer neither question. A tab that reloads and lands
 * in the same state again therefore stops and asks, instead of looping.
 */
const RELOAD_GUARD_KEY = 'toolasha.missedCharacterData.autoReloaded';

/** Events that count as the player having started using this page. */
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

class DataManager {
    constructor() {
        this.webSocketHook = webSocketHook;

        // Static game data (items, actions, monsters, abilities, etc.)
        this.initClientData = null;

        // Player data (updated via WebSocket)
        this.characterData = null;
        this.characterSkills = null;
        this.characterItems = null;
        // id -> position in characterItems, so a changed item is found without
        // scanning the whole inventory. Null means "not built yet".
        this._itemIndexById = null;
        this._itemIndexLength = 0;
        this.characterActions = [];
        this.characterQuests = []; // Active quests including tasks
        this.characterEquipment = new Map();
        this.characterHouseRooms = new Map(); // House room HRID -> {houseRoomHrid, level}
        this.actionTypeDrinkSlotsMap = new Map(); // Action type HRID -> array of drink items
        // Bumped whenever equipment or drink slots change; memo keys elsewhere
        // (enhancement-pricing's production-cost cache) compare against it so a
        // figure computed under old gear/drink buffs is not served after a change.
        this.buffStateVersion = 0;
        this.characterGuildBuffMap = {}; // Guild buff HRID -> {guildBuffHrid, level}
        this.guildBuildingLevelMap = {}; // Building/shrine HRID -> level
        this.guildShrineCapturedAt = null; // When the shrine levels above were read off the wire
        this.guildShrineHydrated = false; // True while those levels come from storage rather than a live message
        this.guildShrineHydration = null; // In-flight hydration, for callers that want to wait
        this.guildShrineGuildId = null; // Guild the persisted shrine levels belong to
        this.monsterSortIndexMap = new Map(); // Monster HRID -> combat zone sortIndex
        this.bossMonsterHrids = new Set(); // Monster HRIDs that appear in bossSpawns
        this.battleData = null; // Current battle data (for Combat Sim export on Steam)

        // When the front action's currently in-progress base action unit started:
        // { actionId, currentCount, unitStartTime }. Callers that model "time remaining"
        // count that in-flight unit as a whole one, so without this an ETA re-anchors to a
        // full fresh action on every reload/remount. Persisted per character in the
        // `actionProgress` store and validated against the live (actionId, currentCount)
        // pair before it is ever trusted — see _syncActionUnitBoundary.
        this.actionUnitBoundary = null;

        // Character tracking for switch detection
        this.currentCharacterId = null;
        this.currentCharacterName = null;
        this.currentCharacterGameMode = null;
        this.isCharacterSwitching = false;
        this.lastCharacterSwitchTime = 0; // Prevent rapid-fire switch loops
        this._switchChain = null; // Serialises overlapping init_character_data handling

        // Which WebSocket owns the character whose state these fields hold.
        //
        // A character switch does not swap one connection for another cleanly: the
        // departing character's socket is still open, and still delivering, while the
        // arriving character's socket is already sending its opening state. Nothing in
        // an items_updated or a skills_updated says which character it is for, so a
        // late message from the old socket used to be applied to the new character's
        // inventory and skills as though it were theirs.
        //
        // Bound to whichever socket delivered the most recent init_character_data — see
        // the handler in setupMessageHandlers, which binds it synchronously, before the
        // work is queued. Null means "no socket has ever been seen", which is
        // permissive: see _isFromActiveSocket.
        this.activeSocket = null;

        // Event listeners
        this.eventListeners = new Map();

        // Achievement buff cache (action type → buff type → flat boost)
        this.achievementBuffCache = {
            source: null,
            byActionType: new Map(),
        };

        // Personal buffs from seals (personal_buffs_updated WebSocket message)
        this.personalActionTypeBuffsMap = {};

        // Per-action-type scroll simulation (Set of buffTypeHrids to simulate)
        this.scrollSimulationByActionType = {};

        // Handle to the "we missed this login's character data" toast, so the
        // offer can be taken back if a late init_character_data does arrive.
        // Null means no offer is standing; it is only ever set once per page.
        this.missedCharacterDataPrompt = null;

        // True once the missed-payload diagnostic has been said. The early
        // recovery path and the 30-second backstop can both reach it, and the
        // second one to arrive must not repeat the console block.
        this._missedCharacterDataReported = false;

        // True once the player has done anything to this page. The automatic
        // recovery reload is only ever taken on a page nobody has touched yet,
        // because that is the only page where a reload provably discards
        // nothing the player did.
        this._pageInteracted = false;
        this._interactionWatchInstalled = false;

        // Retry interval for loading static game data
        this.loadRetryInterval = null;
        this.fallbackInterval = null;

        // Setup WebSocket message handlers
        this.setupMessageHandlers();
    }

    /**
     * Initialize the Data Manager
     * Call this after game loads (or immediately - will retry if needed)
     */
    initialize() {
        this.cleanupIntervals();

        // Try to load static game data using official API
        const success = this.tryLoadStaticData();

        // If failed, set up retry polling.
        //
        // Capped like the fallback poll below: the game either exposes its
        // static data within a few seconds or it never will (a broken build, a
        // page that is not the game), and an uncapped 500 ms interval polls a
        // dead object for the rest of the session.
        if (!success && !this.loadRetryInterval) {
            let staticDataAttempts = 0;
            this.loadRetryInterval = setInterval(() => {
                staticDataAttempts++;

                if (this.tryLoadStaticData()) {
                    this.cleanupIntervals();
                    return;
                }

                if (staticDataAttempts >= MAX_STATIC_DATA_ATTEMPTS) {
                    console.error(
                        '[DataManager] Static game data not available after 30 seconds; giving up on retry polling.'
                    );
                    if (this.loadRetryInterval) {
                        clearInterval(this.loadRetryInterval);
                        this.loadRetryInterval = null;
                    }
                }
            }, 500); // Retry every 500ms
        }

        // FALLBACK: Continuous polling for missed init_character_data (should not be needed with @run-at document-start)
        // Extended timeout for slower connections/computers (Steam, etc.)
        let fallbackAttempts = 0;
        const maxAttempts = 60; // Poll for up to 30 seconds (60 × 500ms)

        const stopFallbackInterval = () => {
            if (this.fallbackInterval) {
                clearInterval(this.fallbackInterval);
                this.fallbackInterval = null;
            }
        };

        this._watchForUserInteraction();

        this.fallbackInterval = setInterval(() => {
            fallbackAttempts++;

            // Stop if character data received via WebSocket
            if (this.characterData) {
                stopFallbackInterval();
                return;
            }

            // The hook can prove the payload was missed rather than merely late.
            // When it has, there is nothing to wait for: recover now instead of
            // leaving the script visibly dead for another twenty-five seconds.
            if (fallbackAttempts >= EARLY_RECOVERY_ATTEMPTS && this._canRecoverEarly()) {
                stopFallbackInterval();
                this._recoverMissedCharacterData();
                return;
            }

            // Give up after max attempts
            if (fallbackAttempts >= maxAttempts) {
                this._reportMissingCharacterData();
                stopFallbackInterval();
            }
        }, 500); // Check every 500ms
    }

    /**
     * Whether the missed one-shot payload has been *demonstrated*, rather than
     * merely suspected from a timeout.
     *
     * All three have to hold together:
     * - no character data, obviously;
     * - frames are arriving, so the hook is installed and delivering — this is
     *   what separates a missed message from a hook that never installed;
     * - the hook attached to a socket that was already past its handshake, so
     *   the opening payload for this connection went to the game before we were
     *   listening. Without this last one the state is indistinguishable from a
     *   slow login, and the thirty-second backstop stays in charge.
     *
     * The flag on its own is not enough. A page where another userscript has
     * replaced `window.WebSocket` with a non-native wrapper always attaches
     * through the `MessageEvent.data` path and so always sets it — but on such
     * a page `init_character_data` still arrives through that same getter, and
     * the first condition rules the recovery out.
     *
     * @returns {boolean}
     * @private
     */
    _canRecoverEarly() {
        if (this.characterData) return false;
        if (this.webSocketHook?.attachedAfterSocketOpen !== true) return false;
        return (Number(this.webSocketHook?.messagesSeen) || 0) > 0;
    }

    /**
     * Recover from a demonstrably missed `init_character_data`.
     *
     * There is no way to fetch the payload back. It is server state pushed once
     * per connection: the game persists none of it (`localStorageUtil` exposes
     * `getInitClientData` and `getMarketItemValues`, both static), and asking
     * the server for it would mean sending a message the client itself does not
     * send at this point, which this script does not do. Reopening the socket is
     * the only thing that makes the server send it again, and the cheapest,
     * safest way to reopen the socket is the one the player already knows: a
     * reload.
     *
     * So the recovery *is* the reload — but taken automatically, once, and only
     * on a page where it provably costs nothing. See
     * {@link _reloadRecoveryBlockedReason} for what "provably" means here. When
     * it does not hold, the reload is offered instead and the console says which
     * condition stopped it.
     * @private
     */
    _recoverMissedCharacterData() {
        const messagesSeen = Number(this.webSocketHook?.messagesSeen) || 0;

        if (!this._missedCharacterDataReported) {
            this._missedCharacterDataReported = true;
            console.error(
                `[DataManager] Character data never arrived, and the hook attached to a game socket that was already open — ${messagesSeen} later messages have come through it fine. init_character_data is sent once, just after the socket opens, so this connection's copy went to the game before Toolasha was listening, and nothing replays it.`
            );
        }

        const blockedReason = this._reloadRecoveryBlockedReason();
        if (blockedReason) {
            console.error(
                `[DataManager] Recovery attempted; the automatic reload was not taken because ${blockedReason}. Offering it instead.`
            );
            this._offerReloadForMissedCharacterData();
            return;
        }

        if (!this._markReloadRecoveryAttempted()) {
            this._offerReloadForMissedCharacterData();
            return;
        }

        console.error('[DataManager] Recovering: reloading the page once to make the server resend the payload.');
        this._performReload();
    }

    /**
     * Why the automatic reload must not be taken, or null when it may be.
     *
     * A reload is only free on a page the session has not started on. Each of
     * these is a way that stops being true:
     * - already used: this tab reloaded once for this same failure and came back
     *   into it. Reloading again is a loop, and a loop is worse than a dead
     *   script — so the second time it asks instead.
     * - the player has touched the page: a click, a keypress, a scroll. Anything
     *   they have typed or opened since the load would be thrown away, and the
     *   five-second window exists precisely so this is almost never the case.
     * - there is nothing to reload (no window, no location), which is every
     *   non-browser host this module is loaded in.
     *
     * @returns {string|null} A reason phrase for the log, or null to proceed
     * @private
     */
    _reloadRecoveryBlockedReason() {
        if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') {
            return 'this page has no window to reload';
        }
        if (this._reloadRecoveryAlreadyAttempted()) {
            return 'this tab has already reloaded once for the same failure and came back into it';
        }
        if (this._pageInteracted) {
            return 'the player has already started using this page and a reload would discard it';
        }
        return null;
    }

    /**
     * Whether this tab has already spent its one automatic reload.
     *
     * A `sessionStorage` read that throws (a browser with site data blocked,
     * a hardened profile) is read as "yes, already used": failing towards not
     * reloading can only cost a toast, while failing the other way is the
     * reload loop this guard exists to prevent.
     * @returns {boolean}
     * @private
     */
    _reloadRecoveryAlreadyAttempted() {
        try {
            return window.sessionStorage?.getItem(RELOAD_GUARD_KEY) === '1';
        } catch {
            return true;
        }
    }

    /**
     * Record the automatic reload before performing it, so the page that comes
     * back cannot take a second one.
     *
     * @returns {boolean} True when the mark is in place and the reload may go
     *   ahead. False means storage refused the write, and an unrecorded reload
     *   is an unguarded one — exactly the loop this must never cause — so the
     *   caller falls back to offering it.
     * @private
     */
    _markReloadRecoveryAttempted() {
        try {
            window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
            return true;
        } catch (error) {
            console.error('[DataManager] Could not record the recovery reload; not reloading:', error);
            return false;
        }
    }

    /**
     * Note that the player has begun using this page.
     *
     * Capture-phase and `once` per event type, so the listeners remove
     * themselves after the first interaction and cost nothing for the rest of
     * the session. Installed from `initialize()` rather than the constructor:
     * the constructor runs at module evaluation, which on a userscript at
     * `document-start` can be before there is a document to listen on.
     * @private
     */
    _watchForUserInteraction() {
        if (this._interactionWatchInstalled) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

        this._interactionWatchInstalled = true;
        const mark = () => {
            this._pageInteracted = true;
        };
        for (const type of INTERACTION_EVENTS) {
            window.addEventListener(type, mark, { capture: true, once: true, passive: true });
        }
    }

    /**
     * Perform the recovery reload.
     *
     * Its own method so both callers — the automatic path and the toast's
     * button — go through one place, and so a test can watch for it without
     * navigating the test environment.
     * @private
     */
    _performReload() {
        window.location.reload();
    }

    /**
     * Say why the character payload never arrived, telling the two causes apart.
     *
     * `init_character_data` is sent once, right after the socket opens, and
     * nothing ever replays it. If our `MessageEvent.data` getter was installed a
     * moment late — a slow start, several userscripts sharing the page — that one
     * message is gone for the whole session, while the very same hook goes on
     * delivering every later message perfectly. The script then looks completely
     * dead (no character id, empty inventory) with a working hook underneath.
     *
     * So the state is decided by whether *any* frame has reached the hook:
     * - nothing at all: the hook really may have failed, and the original
     *   wording is the right one;
     * - frames arriving, no character payload: the hook is fine and the one-shot
     *   message was missed. Saying "WebSocket hook may have failed" here sends
     *   the reader hunting a hook that is demonstrably working — that sentence
     *   is why this failure needed a live probe to diagnose.
     * @private
     */
    _reportMissingCharacterData() {
        // Number() rather than a truthiness check so a hook stub without the
        // counter (older build, a test double) is read as "unknown", i.e. zero,
        // and keeps the conservative original message.
        const messagesSeen = Number(this.webSocketHook?.messagesSeen) || 0;

        if (this._missedCharacterDataReported) {
            // The early recovery path already said all of this and acted on it.
            return;
        }
        this._missedCharacterDataReported = true;

        if (messagesSeen === 0) {
            console.error(
                '[DataManager] Character data not received after 30 seconds. WebSocket hook may have failed.'
            );
            return;
        }

        console.error(
            `[DataManager] Character data not received after 30 seconds, but ${messagesSeen} other WebSocket messages have arrived — the hook is working. init_character_data is sent once, just after the socket opens, and this page started listening too late to catch it; nothing replays it. Reload the page to recover.`
        );

        // Why the automatic reload did not fire here: this path is the backstop
        // for the case the hook could *not* prove. It attached to the game's
        // socket during the handshake, so the opening payload should have
        // reached us and something else has gone wrong — a cause a reload may
        // not fix. Reloading a page on a guess is not recovery, so it is offered
        // rather than taken. See `_canRecoverEarly` for the evidenced case.
        console.error(
            '[DataManager] Automatic recovery was not attempted: the hook was in place before this socket opened, so the payload should not have been missed and the cause is something else. Offering a reload.'
        );

        this._offerReloadForMissedCharacterData();
    }

    /**
     * Offer the reload that recovers a missed character payload, for every case
     * where taking it automatically would not be safe.
     *
     * Reloading is the only recovery there is (see the commit body for the
     * routes that were ruled out). {@link _recoverMissedCharacterData} takes it
     * without asking on a page that has proven the payload was missed and that
     * nobody has touched yet; everything else — an unproven cause, a tab that
     * has already tried it, a page the player has started using — arrives here,
     * because an unconditional `location.reload()` could land mid-dungeon. One
     * persistent toast, shown at most once per page, dismissed the moment a real
     * `init_character_data` turns up late.
     * @private
     */
    _offerReloadForMissedCharacterData() {
        if (this.missedCharacterDataPrompt) return;

        try {
            if (typeof window === 'undefined') return;

            // Late-bound through the published global on purpose: this module is
            // in the Core bundle, which loads before Utils, so importing the
            // toast here would either fail or duplicate it into both bundles.
            const showToast = window.Toolasha?.Utils?.toast?.showToast;
            if (typeof showToast !== 'function') return;

            this.missedCharacterDataPrompt =
                showToast(
                    "Toolasha missed this login's character data, so its panels are empty. The game itself is unaffected — reload the page when convenient to bring Toolasha back.",
                    {
                        kind: 'warn',
                        duration: 0,
                        action: {
                            label: 'Reload the page',
                            onClick: () => this._performReload(),
                        },
                    }
                ) || null;
        } catch (error) {
            // A page with no DOM, or a Utils bundle that never loaded, must not
            // turn a diagnostic into a thrown error inside an interval callback.
            console.error('[DataManager] Could not offer the recovery reload:', error);
        }
    }

    /**
     * Take the reload offer away once genuine character data lands.
     *
     * The real `init_character_data` always wins: if it turns up after the
     * 30-second mark the prompt is stale, and leaving it up would tell the
     * player to reload a session that has just recovered on its own.
     * @private
     */
    _dismissMissedCharacterDataPrompt() {
        const prompt = this.missedCharacterDataPrompt;
        if (!prompt) return;

        this.missedCharacterDataPrompt = null;
        try {
            prompt.dismiss?.();
        } catch {
            // Already gone (dismissed by hand, or its container removed)
        }
    }

    /**
     * Cleanup polling intervals
     */
    cleanupIntervals() {
        if (this.loadRetryInterval) {
            clearInterval(this.loadRetryInterval);
            this.loadRetryInterval = null;
        }

        if (this.fallbackInterval) {
            clearInterval(this.fallbackInterval);
            this.fallbackInterval = null;
        }
    }

    /**
     * Attempt to load static game data
     * @returns {boolean} True if successful, false if needs retry
     * @private
     */
    tryLoadStaticData() {
        try {
            if (typeof localStorageUtil !== 'undefined' && typeof localStorageUtil.getInitClientData === 'function') {
                const data = localStorageUtil.getInitClientData();
                if (data && Object.keys(data).length > 0) {
                    this.initClientData = data;

                    // Build monster sort index map for task sorting
                    this.buildMonsterSortIndexMap();

                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error('[Data Manager] Failed to load init_client_data:', error);
            return false;
        }
    }

    /**
     * The game's official market-value map, decompressed by the game's own util.
     *
     * Published since the 8/13/2026 update: an estimated value for every item and
     * enhancement level — the figure behind the inventory's "Total Market Value"
     * and the tradable range. Raw reader only; caching and band derivation live in
     * utils/market-values.js. Absent on the live server until the patch lands, so
     * a missing util is a normal no-data, not an error.
     * @returns {{marketValuesVersion: number, marketItemValues: Object}|null}
     */
    getMarketItemValues() {
        try {
            if (typeof localStorageUtil !== 'undefined' && typeof localStorageUtil.getMarketItemValues === 'function') {
                return localStorageUtil.getMarketItemValues();
            }
            return null;
        } catch (error) {
            console.error('[Data Manager] Failed to read market item values:', error);
            return null;
        }
    }

    /**
     * Handle one init_character_data message.
     *
     * Runs serialised behind {@link _switchChain}: the teardown below suspends,
     * and a second init running through it concurrently would apply the newer
     * character's data to the older character's arrays.
     * @param {object} data - The init_character_data payload
     * @param {number} arrivedAt - When the message arrived, for rapid-switch detection
     * @private
     */
    async _handleInitCharacterData(data, arrivedAt) {
        // Detect character switch
        const newCharacterId = data.character?.id;
        const newCharacterName = data.character?.name;

        // Validate character data before processing
        if (!newCharacterId || !newCharacterName) {
            console.error('[DataManager] Invalid character data received:', {
                hasCharacter: !!data.character,
                hasId: !!newCharacterId,
                hasName: !!newCharacterName,
            });
            return; // Don't process invalid character data
        }

        // Track whether this is a character switch or first load
        let isCharacterSwitch = false;

        // Check if this is a character switch (not first load)
        if (this.currentCharacterId && this.currentCharacterId !== newCharacterId) {
            isCharacterSwitch = true;

            // Rapid-switch detection.
            //
            // The guard this replaces has been wrong twice. First it
            // `return`ed, throwing away the whole message: the new
            // character's data was never stored, so every reader went on
            // serving the previous character's skills, items and actions
            // until another init arrived. Then it kept the data update but
            // skipped `character_switching`/`character_switched` when two
            // switches landed under a second apart — and those events are
            // not incidental to a switch, they *are* the switch. They are
            // what reloads the per-character settings and what gives every
            // feature its one chance to persist and clear the departing
            // character's state, and skipping them left the second character
            // running on the first character's settings until some later,
            // slower switch happened to fix it. Four characters in one
            // browser is exactly the case that never gets that slow switch.
            //
            // Both halves of the lifecycle now always fire, in the same order
            // and at the same points as a slow switch. The expensive part —
            // tearing down and re-initialising a hundred features — is
            // coalesced in feature-registry instead, which is the module that
            // owns the feature layer and already serializes the whole
            // lifecycle: a burst tears down once and re-initialises once, for
            // whichever character is still current when it settles. See
            // setupCharacterSwitchHandler().
            const now = arrivedAt;
            const isRapidSwitch = Boolean(
                this.lastCharacterSwitchTime && now - this.lastCharacterSwitchTime < RAPID_SWITCH_WINDOW_MS
            );

            // Raised before the first await, not after: everything from here to
            // the re-init belongs to the departing character, and a message
            // landing in one of those suspension points must see that a switch
            // is in flight rather than write into the old character's state.
            this.isCharacterSwitching = true;

            if (isRapidSwitch) {
                console.warn(
                    '[Toolasha] Rapid character switch (<1s since last); feature teardown will be coalesced with the rest of the burst'
                );
            }
            this.lastCharacterSwitchTime = now;

            // Flush pending storage writes before anything tears down.
            //
            // This used to be a `setTimeout(…, 0)` whose promise nobody
            // waited for, so the flush raced the switch: the writes it was
            // draining belong to the *old* character, and a feature that
            // rewrote its state during cleanup could land on top of them.
            // Awaiting it costs one macrotask and makes the ordering real.
            //
            // Run for a rapid switch too. The writes being drained belong to
            // the character that is departing *this* switch, and a burst
            // departs a different character each time; skipping the flush
            // mid-burst leaves those writes to be picked up after
            // currentCharacterId has moved on.
            try {
                if (storage && typeof storage.flushAll === 'function') {
                    await storage.flushAll();
                }
            } catch (error) {
                console.error('[Toolasha] Failed to flush storage before character switch:', error);
            }

            // Emit character_switching event (cleanup phase).
            //
            // Before currentCharacterId moves, always: a listener that reads
            // "the current character" here is persisting the departing one's
            // state, and this is its only chance to.
            //
            // Awaited: a listener that persists the departing character's
            // state must land before the teardown below starts clearing that
            // state out from under it.
            await this.emit('character_switching', {
                oldId: this.currentCharacterId,
                newId: newCharacterId,
                oldName: this.currentCharacterName,
                newName: newCharacterName,
            });

            // Update character tracking
            this.currentCharacterId = newCharacterId;
            this.currentCharacterName = newCharacterName;
            this.currentCharacterGameMode = data.character?.gameMode || null;

            // Clear old character data
            this.characterData = null;
            this.characterMonsters = null;
            this.characterSkills = null;
            this.characterItems = null;
            this._itemIndexById = null;
            this.characterActions = [];
            this.characterQuests = [];
            this.characterEquipment.clear();
            this.characterHouseRooms.clear();
            this.actionTypeDrinkSlotsMap.clear();
            this.buffStateVersion++;
            this.personalActionTypeBuffsMap = {};
            this.characterGuildBuffMap = {};
            this.guildBuildingLevelMap = {};
            this.guildShrineCapturedAt = null;
            this.guildShrineHydrated = false;
            this.guildShrineHydration = null;
            this.guildShrineGuildId = null;
            this.battleData = null;
            this.actionUnitBoundary = null;

            // Reset switching flag (cleanup complete, ready for re-init)
            this.isCharacterSwitching = false;

            // Emit character_switched event (ready for re-init).
            // Paired with character_switching — one of each, per switch,
            // always, so feature-registry never sees a re-init without a
            // teardown or a teardown without a re-init to answer it.
            this.emit('character_switched', {
                newId: newCharacterId,
                newName: newCharacterName,
            });
        } else if (!this.currentCharacterId) {
            // First load - set character tracking
            this.currentCharacterId = newCharacterId;
            this.currentCharacterName = newCharacterName;
            this.currentCharacterGameMode = data.character?.gameMode || null;
        }

        // Process new character data normally
        this.characterData = data;
        this.characterSkills = data.characterSkills;
        this.characterItems = data.characterItems;
        this._itemIndexById = null; // Rebuilt lazily against the new inventory
        this.characterActions = [...data.characterActions];
        this.characterQuests = data.characterQuests || [];

        // Re-establish the current-unit timing boundary for whatever action is now
        // front-most. A reload or a switch back to this character keeps a still-valid
        // boundary instead of discarding it; anything else falls back to a fresh one.
        await this._restoreActionUnitBoundary(newCharacterId);

        // Build equipment map
        this.updateEquipmentMap(data.characterItems);

        // Build house room map
        this.updateHouseRoomMap(data.characterHouseRoomMap);

        // Build drink slots map (tea buffs)
        this.updateDrinkSlotsMap(data.actionTypeDrinkSlotsMap);

        // Load personal buffs (seal buffs from Labyrinth, may be present on login)
        if (data.personalActionTypeBuffsMap) {
            this.personalActionTypeBuffsMap = data.personalActionTypeBuffsMap;
        }

        // Load guild buff levels and shrine/building levels
        this.characterGuildBuffMap = data.characterGuildBuffMap || {};
        this.guildBuildingLevelMap = data.guildBuildingLevelMap || {};
        if (mapSize(this.characterGuildBuffMap) > 0 || mapSize(this.guildBuildingLevelMap) > 0) {
            this.guildShrineCapturedAt = Date.now();
            this.guildShrineHydrated = false;
        }

        // Login usually carries no shrine levels at all — they ride on guild
        // traffic that may never arrive this session. Fill the gap from the
        // last reading so the upgrade advisor has something to answer with;
        // a live message later overwrites it. Not awaited, so a slow
        // IndexedDB cannot hold up feature initialization.
        this.guildShrineHydration = this.hydrateGuildShrineLevels();

        // Clear switching flag
        this.isCharacterSwitching = false;

        // Emit character_initialized event (trigger feature initialization)
        // Include flag to indicate if this is a character switch vs first load
        // IMPORTANT: Mutate data object instead of spreading to avoid copying MB of data
        data._isCharacterSwitch = isCharacterSwitch;
        this.emit('character_initialized', data);
        connectionState.handleCharacterInitialized(data);
    }

    /**
     * Setup WebSocket message handlers
     * Listens for game data updates
     */
    setupMessageHandlers() {
        // Handle init_character_data (player data on login/refresh)
        //
        // The body suspends (storage flush, awaited listeners), so two inits
        // arriving close together would otherwise interleave mid-teardown.
        // They are queued behind one another instead; the arrival timestamp is
        // captured here so the rapid-switch guard still measures when the
        // messages showed up, not when the queue got round to them.
        this.webSocketHook.on('init_character_data', (data, context) => {
            const arrivedAt = Date.now();

            // Genuine data always beats the recovery offer, however late it is:
            // taken back here, synchronously, rather than after the queued
            // handler runs, so the player is never told to reload a session
            // that has already recovered.
            this._dismissMissedCharacterDataPrompt();

            // Bind ownership HERE, synchronously, and not inside
            // _handleInitCharacterData. That handler runs deferred behind
            // _switchChain — it may not start until a previous init's storage flush
            // and awaited character_switching listeners have finished. Everything the
            // old socket delivers during that drain would still be accepted if the
            // binding waited for the handler to run, which is precisely the window
            // this is meant to close.
            this._bindActiveSocket(data, context);

            this._switchChain = (this._switchChain || Promise.resolve())
                .then(() => this._handleInitCharacterData(data, arrivedAt))
                .catch((error) => {
                    console.error('[DataManager] init_character_data handling failed:', error);
                    // The flag is raised before the teardown; a throw part way
                    // through it would otherwise block feature init for good.
                    this.isCharacterSwitching = false;
                });
            return this._switchChain;
        });

        // Handle actions_updated (action queue changes)
        this.webSocketHook.on('actions_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            // Update action list.
            //
            // This used to rebuild the whole array once per incoming action —
            // a full queue reorder is 30-odd actions against a 30-entry list,
            // so ~900 comparisons and 30 fresh arrays for what is one pass.
            // Collect the incoming ids first, filter once, then append.
            const incoming = new Map();
            for (const action of data.endCharacterActions) {
                // Re-inserting keeps the *last* entry for a repeated id, and at
                // the position the repeat arrived — what the per-action filter
                // did when endCharacterActions carried the same id twice.
                incoming.delete(action.id);
                incoming.set(action.id, action);
            }

            // endCharacterActions can contain existing actions alongside new
            // ones, so drop every incoming id before appending to avoid dupes.
            this.characterActions = this.characterActions.filter((a) => !incoming.has(a.id));
            for (const action of incoming.values()) {
                if (action.isDone === false) {
                    this.characterActions.push(action);
                }
            }

            // A different action taking the front slot starts that action's first unit now
            this._syncActionUnitBoundary();

            this.emit('actions_updated', data);
        });

        // Handle action_completed (action progress)
        this.webSocketHook.on('action_completed', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            const action = data.endCharacterAction;
            if (action.isDone === false) {
                for (let i = 0; i < this.characterActions.length; i++) {
                    if (this.characterActions[i].id === action.id) {
                        // Replace the entire cached action with fresh data from the server
                        // This keeps primaryItemHash, enhancingMaxLevel, etc. up to date
                        this.characterActions[i] = action;
                        break;
                    }
                }
            }

            // An `isDone: false` continuation is the server telling us one unit finished and
            // the next began — the one instant we can date a unit boundary from directly
            this._syncActionUnitBoundary();

            // CRITICAL: Update inventory from action_completed (this is how inventory updates during gathering!)
            if (data.endCharacterItems && Array.isArray(data.endCharacterItems) && this.characterItems) {
                for (const endItem of data.endCharacterItems) {
                    // Only update inventory items
                    if (endItem.itemLocationHrid !== '/item_locations/inventory') {
                        continue;
                    }

                    // Find and update the item in inventory
                    const index = this._itemIndexOf(endItem.id);
                    if (index !== -1) {
                        // Update existing item
                        this.characterItems[index].count = endItem.count;
                    } else {
                        // Add new item to inventory
                        this._pushItem(endItem);
                    }
                }

                // Notify items_updated listeners (e.g. networth) of the inventory change
                this.emit('items_updated', data);
            }

            // CRITICAL: Update skill experience from action_completed (this is how XP updates in real-time!)
            if (data.endCharacterSkills && Array.isArray(data.endCharacterSkills) && this.characterSkills) {
                for (const updatedSkill of data.endCharacterSkills) {
                    const skill = this.characterSkills.find((s) => s.skillHrid === updatedSkill.skillHrid);
                    if (skill) {
                        // Update experience (and level if it changed)
                        skill.experience = updatedSkill.experience;
                        if (updatedSkill.level !== undefined) {
                            skill.level = updatedSkill.level;
                        }
                    }
                }
            }

            // Ability experience ticks during a fight. Progress only — the kit
            // itself is never reshuffled from here (see character-abilities.js)
            if (Array.isArray(data.endCharacterAbilities) && this.characterData) {
                this.characterData.characterAbilities = mergeOwnedAbilities(
                    this.characterData.characterAbilities,
                    data.endCharacterAbilities
                );
                if (this.characterData.combatUnit) {
                    this.characterData.combatUnit.combatAbilities = applyAbilityProgress(
                        this.characterData.combatUnit.combatAbilities,
                        data.endCharacterAbilities
                    );
                }
            }

            this.emit('action_completed', data);
        });

        // Handle abilities_updated (equip, unequip, level up)
        //
        // Nothing applied these before, so `combatUnit.combatAbilities` was
        // frozen at whatever login reported and every ability change since was
        // invisible to the combat sim. That is most visible around the
        // labyrinth, which equips a loadout per room and restores on exit:
        // equipment tracked those swaps because items_updated was handled, and
        // abilities did not because this message was not.
        this.webSocketHook.on('abilities_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (this.applyAbilityUpdates(data.endCharacterAbilities)) {
                this.emit('abilities_updated', data);
            }
        });

        // The Bestiary, as the Achievements tab fetches it (`get_monsters`):
        // one row per monster with its defeated count. Nothing asks for it
        // here — it arrives when the tab is opened or refreshed
        this.webSocketHook.on('monsters_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;
            if (!Array.isArray(data?.monsters)) return;
            this.characterMonsters = data.monsters;
            this.characterMonstersAt = Date.now();
            this.emit('monsters_updated', data);
        });

        // Handle items_updated (inventory/equipment changes)
        this.webSocketHook.on('items_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.endCharacterItems) {
                if (!this.characterItems) {
                    this.emit('items_updated', data);
                    return;
                }
                // Update inventory items in-place (endCharacterItems contains only changed items, not full inventory)
                for (const item of data.endCharacterItems) {
                    const index = this._itemIndexOf(item.id);
                    if (index !== -1) {
                        if (item.count === 0) {
                            // count 0 means removed from this location (e.g. equipped from inventory)
                            this.characterItems.splice(index, 1);
                            // Every position after the hole moved; cheaper to
                            // rebuild than to patch, and removals are rare next
                            // to the count updates above.
                            this._itemIndexById = null;
                        } else {
                            // Update existing item (count and location may have changed, e.g. unequip)
                            this.characterItems[index] = { ...this.characterItems[index], ...item };
                        }
                    } else if (item.count > 0) {
                        // New item in inventory or equipment slot
                        this._pushItem(item);
                    }
                }

                this.updateEquipmentMap(data.endCharacterItems);
            }

            this.emit('items_updated', data);
        });

        // Handle market_listings_updated (this character's own market orders — character-
        // scoped, unlike the global order books below)
        this.webSocketHook.on('market_listings_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (!this.characterData || !Array.isArray(data?.endMarketListings)) {
                return;
            }

            const currentListings = Array.isArray(this.characterData.myMarketListings)
                ? this.characterData.myMarketListings
                : [];
            const updatedListings = mergeMarketListings(currentListings, data.endMarketListings);

            this.characterData = {
                ...this.characterData,
                myMarketListings: updatedListings,
            };

            this.emit('market_listings_updated', {
                ...data,
                myMarketListings: updatedListings,
            });
        });

        // Handle market_item_order_books_updated (order book updates). Genuinely global
        // market data — the same book whichever character is looking at it — so it is
        // deliberately left unguarded by the socket-ownership check.
        this.webSocketHook.on('market_item_order_books_updated', (data) => {
            this.emit('market_item_order_books_updated', data);
        });

        // Handle market_item_values_updated (the official value map refreshing
        // mid-session). Global market data like the order books above, so it is
        // deliberately left unguarded by the socket-ownership check. Without it
        // the value map is only ever re-read out of localStorage on a 30-second
        // throttle, so every consumer of the official values — networth's
        // officialValue source, the tradable-band clamp — trails a refresh.
        this.webSocketHook.on('market_item_values_updated', (data) => {
            this.emit('market_item_values_updated', data);
        });

        // Handle action_type_consumable_slots_updated (when user changes tea assignments)
        // updateDrinkSlotsMap clears the whole map before refilling, which is
        // only safe because this message always carries EVERY action type, not
        // just the changed one — measured on the test server 2026-08-29 by
        // swapping one crafting tea: all 13 action types in every payload, and
        // the message also streams during consumption with the full map each
        // time. A partial payload here would silently strip the other skills'
        // drink costs from the profit calculators until reload.
        this.webSocketHook.on('action_type_consumable_slots_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            // Update drink slots map with new consumables
            if (data.actionTypeDrinkSlotsMap) {
                this.updateDrinkSlotsMap(data.actionTypeDrinkSlotsMap);
            }

            this.emit('consumables_updated', data);
        });

        // The live-buff family below. Every derived `*ActionTypeBuffsMap` on `characterData` was
        // written once, at init_character_data, and never again — so a house upgrade, an
        // achievement, a MooPass change, a re-equip, a tea swap or a guild buff purchase left
        // every reader (enhancement XP, action timing, the labyrinth clear rate, the tea
        // optimizer) computing against login-time buffs for the rest of the session. The server
        // replaces each map wholesale, so mirroring it is an assignment, not a merge; `undefined`
        // means "absent from this message" and is left alone, while an explicit empty map is a
        // real "those buffs are gone" and must be stored.

        // Handle consumable_buffs_updated (when buffs expire/refresh)
        this.webSocketHook.on('consumable_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.consumableActionTypeBuffsMap !== undefined && this.characterData) {
                this.characterData.consumableActionTypeBuffsMap = data.consumableActionTypeBuffsMap;
            }

            this.emit('consumable_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle community_buffs_updated (anyone donating changes levels and
        // expiry). Without this, every community buff level reads as it was at
        // login — the tea optimizer, efficiency and profit calculators all go
        // quietly stale as the server buff moves.
        // Server-wide buffs, the same for every character on the world — left unguarded
        // by the socket-ownership check for the same reason as the order books.
        this.webSocketHook.on('community_buffs_updated', (data) => {
            if (this.characterData) {
                if (Array.isArray(data.communityBuffs)) {
                    this.characterData.communityBuffs = data.communityBuffs;
                }
                if (data.communityActionTypeBuffsMap !== undefined) {
                    this.characterData.communityActionTypeBuffsMap = data.communityActionTypeBuffsMap;
                }
            }
            this.emit('community_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle personal_buffs_updated (seal buffs from Labyrinth)
        this.webSocketHook.on('personal_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.personalActionTypeBuffsMap !== undefined) {
                this.personalActionTypeBuffsMap = data.personalActionTypeBuffsMap;
                if (this.characterData) {
                    this.characterData.personalActionTypeBuffsMap = data.personalActionTypeBuffsMap;
                }
            }
            if (data.characterBuffs !== undefined && this.characterData) {
                this.characterData.characterBuffs = data.characterBuffs || [];
            }

            this.emit('personal_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle house_rooms_updated (when user upgrades house rooms)
        this.webSocketHook.on('house_rooms_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            // Update house room map with new levels. `updateHouseRoomMap` merges the
            // payload into the init snapshot on purpose — the message names the rooms
            // that changed, not the whole house — so nothing may assign the payload over
            // `characterData.characterHouseRoomMap` afterwards: that drops every room the
            // message did not mention, and the simulators' player DTO reads that map.
            if (data.characterHouseRoomMap !== undefined) {
                this.updateHouseRoomMap(data.characterHouseRoomMap);
            }
            if (data.houseActionTypeBuffsMap !== undefined && this.characterData) {
                this.characterData.houseActionTypeBuffsMap = data.houseActionTypeBuffsMap;
            }

            this.emit('house_rooms_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle achievement_buffs_updated (an achievement completing changes its action buffs)
        this.webSocketHook.on('achievement_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.achievementActionTypeBuffsMap !== undefined && this.characterData) {
                this.characterData.achievementActionTypeBuffsMap = data.achievementActionTypeBuffsMap;
            }

            this.emit('achievement_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle moo_pass_buffs_updated (a subscription starting, lapsing or changing tier)
        this.webSocketHook.on('moo_pass_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (this.characterData) {
                if (data.mooPassBuffs !== undefined) this.characterData.mooPassBuffs = data.mooPassBuffs;
                if (data.mooPassActionTypeBuffsMap !== undefined) {
                    this.characterData.mooPassActionTypeBuffsMap = data.mooPassActionTypeBuffsMap;
                }
            }

            this.emit('moo_pass_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle equipment_buffs_updated (every re-equip, enhancement and loadout swap)
        this.webSocketHook.on('equipment_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (this.characterData) {
                if (data.equipmentActionTypeBuffsMap !== undefined) {
                    this.characterData.equipmentActionTypeBuffsMap = data.equipmentActionTypeBuffsMap;
                }
                if (data.equipmentTaskActionBuffs !== undefined) {
                    this.characterData.equipmentTaskActionBuffs = data.equipmentTaskActionBuffs;
                }
            }

            this.emit('equipment_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle guild_buffs_updated (purchased shrine levels + the action buffs they grant).
        // The shrine *building's* unlocked cap rides on other guild traffic and is captured by
        // the shape-matched wildcard handler above, not here.
        this.webSocketHook.on('guild_buffs_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.guildActionTypeBuffsMap !== undefined && this.characterData) {
                this.characterData.guildActionTypeBuffsMap = data.guildActionTypeBuffsMap;
            }

            this.emit('guild_buffs_updated', data);
            this.emit('buffs_updated', data);
        });

        // Handle skills_updated (when user gains skill levels)
        this.webSocketHook.on('skills_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            // Update character skills with new levels
            if (data.characterSkills) {
                this.characterSkills = data.characterSkills;
            }

            this.emit('skills_updated', data);
        });

        // Handle new_battle (combat start - for Combat Sim export on Steam)
        this.webSocketHook.on('new_battle', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            // Store battle data (includes party consumables)
            this.battleData = data;

            // The only message that carries the equipped kit whole rather than
            // as a delta, so it is the backstop: whatever the labyrinth did to
            // the loadout, the first battle after it settles the question.
            const fromBattle = equippedAbilitiesFromBattle(data, {
                characterId: this.currentCharacterId,
                characterName: this.currentCharacterName,
            });
            if (fromBattle && fromBattle.length > 0) {
                const previous = this.characterData?.combatUnit?.combatAbilities;
                if (this.setEquippedAbilities(fromBattle) && abilityKitsDiffer(previous, fromBattle)) {
                    this.emit('abilities_updated', {
                        endCharacterAbilities: fromBattle,
                        source: 'new_battle',
                    });
                }
            }
        });

        // Guild shrine levels arrive on whichever message the server attaches
        // them to, and usually only once the guild panel has been opened. They
        // are matched by shape rather than by message type so a rename upstream
        // cannot quietly stop the capture — the check is two property reads.
        // Guarded like the rest: the levels it captures are cleared on a character
        // switch and re-read for the arriving character, so they are character-scoped
        // state even though the guild they describe may be shared. Registered after
        // the init handler above, and wildcards are dispatched after typed handlers,
        // so the arriving character's own init has already bound its socket by the
        // time this sees it.
        this.webSocketHook.on('*', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;
            this.captureGuildShrineData(data);
        });

        // Handle character_info_updated (task slot changes, cooldown timestamps, etc.)
        this.webSocketHook.on('character_info_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (this.characterData && data.characterInfo) {
                this.characterData.characterInfo = data.characterInfo;
            }
            this.emit('character_info_updated', data);
        });

        // Handle setting_updated (labyrinth skip thresholds, crate selection, etc.)
        this.webSocketHook.on('setting_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (this.characterData && data.characterSetting) {
                this.characterData.characterSetting = data.characterSetting;
            }
            this.emit('setting_updated', data);
        });

        // Handle quests_updated (keep characterQuests in sync mid-session)
        this.webSocketHook.on('quests_updated', (data, context) => {
            if (!this._isFromActiveSocket(context)) return;

            if (data.endCharacterQuests && Array.isArray(data.endCharacterQuests)) {
                for (const updatedQuest of data.endCharacterQuests) {
                    const index = this.characterQuests.findIndex((q) => q.id === updatedQuest.id);
                    if (index !== -1) {
                        this.characterQuests[index] = updatedQuest;
                    } else {
                        this.characterQuests.push(updatedQuest);
                    }
                }
                // Remove claimed quests
                this.characterQuests = this.characterQuests.filter((q) => q.status !== '/quest_status/claimed');
            }
        });
    }

    /**
     * Record which socket owns the character this init_character_data announces.
     *
     * Called synchronously from the init handler, before the handling itself is
     * queued — see the call site for why the timing is the whole point.
     *
     * @param {Object} data - The init_character_data payload
     * @param {{socket?: Object}|null} context - Delivery context from the WebSocket hook
     * @private
     */
    _bindActiveSocket(data, context) {
        if (context?.socket) {
            this.activeSocket = context.socket;
            return;
        }

        // No socket context. If the character is changing, the socket currently bound
        // belongs to the character who is leaving, and keeping it would mean accepting
        // exactly the messages this is here to reject — so fail closed to "unknown",
        // which is permissive but at least not actively wrong. If the character is not
        // changing (first login, a reconnect for the same character, or a test that
        // drives the handler directly) there is nothing to unbind.
        const incomingId = data?.character?.id;
        if (incomingId && this.currentCharacterId && this.currentCharacterId !== incomingId) {
            this.activeSocket = null;
        }
    }

    /**
     * Whether a character-scoped update may be applied to the current character.
     *
     * True unless the update is provably from a stale connection: some socket has been
     * bound by an accepted init_character_data, and this message came from a different
     * one. Permissive whenever no socket is bound — before the first init, and for
     * every caller that invokes a handler without a delivery context — so this never
     * becomes a requirement that each payload identify its own character.
     *
     * @param {{socket?: Object}|null} [context] - Delivery context from the WebSocket hook
     * @returns {boolean} True when the update belongs to the active character
     */
    _isFromActiveSocket(context) {
        return !this.activeSocket || context?.socket === this.activeSocket;
    }

    /**
     * The same check, for the features that subscribe to `webSocketHook` directly.
     *
     * A feature that records something per character off a raw message — the chest
     * ledgers are the ones that do — has the same problem DataManager does and no way
     * to see the binding otherwise. A method rather than a module-level export on
     * purpose: in the split production build `src/core/data-manager.js` resolves to
     * this singleton at `Toolasha.Core.dataManager`, so a bare exported function is
     * not reachable from another bundle but a method on the singleton is.
     *
     * @param {{socket?: Object}|null} [context] - Delivery context from the WebSocket hook
     * @returns {boolean} True when the message belongs to the active character
     */
    isFromActiveSocket(context) {
        return this._isFromActiveSocket(context);
    }

    /**
     * Update equipment map from character items
     * @param {Array} items - Character items array
     */
    updateEquipmentMap(items) {
        let equipmentChanged = false;
        for (const item of items) {
            if (item.itemLocationHrid !== '/item_locations/inventory') {
                if (item.count === 0) {
                    this.characterEquipment.delete(item.itemLocationHrid);
                } else {
                    this.characterEquipment.set(item.itemLocationHrid, item);
                }
                equipmentChanged = true;
            }
        }
        // Delta messages only carry items that changed, so any non-inventory
        // item here means a slot changed and equipment-dependent memos are stale
        if (equipmentChanged) {
            this.buffStateVersion++;
        }
    }

    /**
     * Update house room map from character house room data
     * @param {Object} houseRoomMap - Character house room map
     */
    updateHouseRoomMap(houseRoomMap) {
        if (!houseRoomMap) {
            return;
        }

        this.characterHouseRooms.clear();
        for (const [_hrid, room] of Object.entries(houseRoomMap)) {
            this.characterHouseRooms.set(room.houseRoomHrid, room);
        }
        // The init snapshot too, so anything still reading the character's
        // own map (the simulators' player DTO) sees the room it just built
        if (this.characterData) {
            this.characterData.characterHouseRoomMap = { ...(this.characterData.characterHouseRoomMap || {}) };
            for (const [hrid, room] of Object.entries(houseRoomMap)) {
                this.characterData.characterHouseRoomMap[hrid] = room;
            }
        }
    }

    /**
     * Update drink slots map from character data
     * @param {Object} drinkSlotsMap - Action type drink slots map
     */
    updateDrinkSlotsMap(drinkSlotsMap) {
        if (!drinkSlotsMap) {
            return;
        }

        this.actionTypeDrinkSlotsMap.clear();
        for (const [actionTypeHrid, drinks] of Object.entries(drinkSlotsMap)) {
            this.actionTypeDrinkSlotsMap.set(actionTypeHrid, drinks || []);
        }
        this.buffStateVersion++;
    }

    /**
     * Apply an `endCharacterAbilities` delta to both ability views.
     *
     * The learned list (`characterAbilities`, which carries experience) and the
     * equipped kit (`combatUnit.combatAbilities`) are updated from the same
     * message, because a level-up and an equip arrive in the same shape and a
     * reader of one must not see a state the other has moved past.
     *
     * @param {Array<Object>} updates - `endCharacterAbilities` from the message
     * @returns {boolean} True when something was applied
     */
    applyAbilityUpdates(updates) {
        if (!this.characterData || !Array.isArray(updates) || updates.length === 0) return false;

        this.characterData.characterAbilities = mergeOwnedAbilities(this.characterData.characterAbilities, updates);

        if (!this.characterData.combatUnit) {
            this.characterData.combatUnit = {};
        }
        this.characterData.combatUnit.combatAbilities = reconcileEquippedAbilities(
            this.characterData.combatUnit.combatAbilities,
            updates
        );

        return true;
    }

    /**
     * Replace the equipped kit outright with a list the server sent whole.
     * @param {Array<Object>} abilities - Equipped abilities, in slot order
     * @returns {boolean} True when the kit was replaced
     */
    setEquippedAbilities(abilities) {
        if (!this.characterData || !Array.isArray(abilities)) return false;

        if (!this.characterData.combatUnit) {
            this.characterData.combatUnit = {};
        }
        this.characterData.combatUnit.combatAbilities = abilities.map((entry) => ({ ...entry }));
        this.characterData.characterAbilities = mergeOwnedAbilities(this.characterData.characterAbilities, abilities);

        return true;
    }

    /**
     * The abilities currently equipped, in slot order.
     *
     * This is the authoritative read for anything that asks "what is this
     * character fighting with" — it reflects every ability message applied since
     * login, not just the state login reported.
     *
     * @returns {Array<Object>} Copies of the equipped ability entries
     */
    getEquippedAbilities() {
        const equipped = this.characterData?.combatUnit?.combatAbilities;
        return Array.isArray(equipped) ? equipped.map((entry) => ({ ...entry })) : [];
    }

    /**
     * Position of an inventory item by id, or -1.
     *
     * Backed by an id -> index map so a burst of item updates does not walk the
     * inventory once per changed item. The map is rebuilt whenever it cannot be
     * trusted — `characterItems` is public and other code may replace or
     * reorder it — which makes this a cache rather than a second source of truth.
     * @param {string} id - Character item id
     * @returns {number} Index into characterItems, or -1 when absent
     * @private
     */
    _itemIndexOf(id) {
        const items = this.characterItems;
        if (!Array.isArray(items)) return -1;

        if (!this._itemIndexById || this._itemIndexLength !== items.length) {
            this._rebuildItemIndex();
        }

        const index = this._itemIndexById.get(id);
        if (index === undefined) return -1;
        if (items[index] && items[index].id === id) return index;

        // The array was reordered under us; rebuild once and answer from it
        this._rebuildItemIndex();
        const rebuilt = this._itemIndexById.get(id);
        return rebuilt === undefined ? -1 : rebuilt;
    }

    /**
     * Rebuild the id -> index map from characterItems.
     * @private
     */
    _rebuildItemIndex() {
        const map = new Map();
        const items = this.characterItems;
        if (Array.isArray(items)) {
            for (let i = 0; i < items.length; i++) {
                map.set(items[i].id, i);
            }
        }
        this._itemIndexById = map;
        // Length, not map size: duplicate ids would make the two disagree
        // forever and rebuild the map on every single lookup.
        this._itemIndexLength = Array.isArray(items) ? items.length : 0;
    }

    /**
     * Append an item to the inventory, keeping the index map in step.
     * @param {Object} item - Character item record
     * @private
     */
    _pushItem(item) {
        this.characterItems.push(item);
        if (this._itemIndexById) {
            this._itemIndexById.set(item.id, this.characterItems.length - 1);
            this._itemIndexLength = this.characterItems.length;
        }
    }

    /**
     * Every ability the character has learned, with level and experience.
     * @returns {Array<Object>} Copies of the learned ability entries
     */
    getLearnedAbilities() {
        const owned = this.characterData?.characterAbilities;
        return Array.isArray(owned) ? owned.map((entry) => ({ ...entry })) : [];
    }

    /**
     * Take guild shrine levels off any message that happens to carry them.
     * @param {Object} data - Parsed WebSocket message
     * @returns {boolean} True when live state changed
     */
    captureGuildShrineData(data) {
        const captured = extractGuildShrineData(data);
        if (!captured) return false;

        // A late message from the previous character's socket, arriving after
        // a switch, names its owner in every buff row — refuse the whole
        // capture rather than persist one character's levels under another's
        // key (which is exactly what used to happen)
        if (!buffMapBelongsTo(captured.characterGuildBuffMap, this.currentCharacterId)) {
            return false;
        }

        // "Present on the message" is not "different from what we hold".
        // Several message types carry these maps unchanged on every tick, and
        // treating each as a change meant a storage write and a
        // guild_shrine_levels_updated event — with every listener's redraw
        // behind it — for state that had not moved.
        let changed = false;
        if (captured.characterGuildBuffMap !== undefined) {
            if (!shallowEqualMaps(this.characterGuildBuffMap, captured.characterGuildBuffMap)) {
                this.characterGuildBuffMap = captured.characterGuildBuffMap;
                changed = true;
            }
        }
        if (captured.guildBuildingLevelMap !== undefined) {
            if (!shallowEqualMaps(this.guildBuildingLevelMap, captured.guildBuildingLevelMap)) {
                this.guildBuildingLevelMap = captured.guildBuildingLevelMap;
                changed = true;
            }
        }
        if (!changed) return false;

        this.guildShrineCapturedAt = Date.now();
        this.guildShrineHydrated = false;
        this.guildShrineGuildId = captured.guildId ?? this.guildShrineGuildId ?? null;
        this.persistGuildShrineLevels();
        this.emit('guild_shrine_levels_updated', {
            capturedAt: this.guildShrineCapturedAt,
            fromStorage: false,
        });

        return true;
    }

    /**
     * Write the current shrine levels down so the next session starts with them.
     * @returns {Promise<boolean>} True when a record was written
     */
    async persistGuildShrineLevels() {
        return saveGuildShrineLevels(this.currentCharacterId, {
            characterGuildBuffMap: this.characterGuildBuffMap,
            guildBuildingLevelMap: this.guildBuildingLevelMap,
            guildId: this.guildShrineGuildId ?? null,
            capturedAt: this.guildShrineCapturedAt || Date.now(),
        });
    }

    /**
     * Fill empty shrine levels from the last persisted reading.
     *
     * Only the maps that are still empty are filled, and only if a live message
     * has not landed while the read was in flight — a stale reading is worth
     * having when there is nothing, and worth nothing when there is something.
     *
     * @returns {Promise<boolean>} True when anything was hydrated
     */
    async hydrateGuildShrineLevels() {
        try {
            if (mapSize(this.characterGuildBuffMap) > 0 && mapSize(this.guildBuildingLevelMap) > 0) {
                return false;
            }

            // Fixed for a character-switch race: this call is deliberately not
            // awaited by its caller (see the comment at the call site), so a
            // second switch can complete — clearing and re-populating this same
            // instance's maps for a different, possibly differently-guilded
            // character — while this IndexedDB read is still in flight below.
            const targetCharacterId = this.currentCharacterId;
            const record = await loadGuildShrineLevels(targetCharacterId);
            if (!record) return false;

            // The read landed after a newer switch moved on. `record` is the
            // departed character's own reading, correctly keyed and internally
            // consistent for *them* — applying it now would stamp it onto
            // whoever is current now. `buffMapBelongsTo` below only catches this
            // for `characterGuildBuffMap`, and only when its rows are non-empty
            // and carry an explicit owner; `guildBuildingLevelMap` carries no
            // per-row owner at all (it is the *guild's* levels, not the
            // character's), so an empty buff map plus a populated building map —
            // an ordinary reading for a player who has bought no guild buffs —
            // would sail through unblocked and hand one guild's shrine levels to
            // a character in a different guild entirely.
            if (this.currentCharacterId !== targetCharacterId) return false;

            // A record contaminated before the capture was owner-checked —
            // another character's buff rows under this character's key — is
            // ignored, and the next clean capture overwrites it
            if (!buffMapBelongsTo(record.characterGuildBuffMap, this.currentCharacterId)) {
                console.warn('[DataManager] Persisted shrine levels belong to another character; ignoring the record');
                return false;
            }

            let filled = false;
            if (mapSize(this.characterGuildBuffMap) === 0 && mapSize(record.characterGuildBuffMap) > 0) {
                this.characterGuildBuffMap = record.characterGuildBuffMap;
                filled = true;
            }
            if (mapSize(this.guildBuildingLevelMap) === 0 && mapSize(record.guildBuildingLevelMap) > 0) {
                this.guildBuildingLevelMap = record.guildBuildingLevelMap;
                filled = true;
            }
            if (!filled) return false;

            this.guildShrineCapturedAt = record.capturedAt || null;
            this.guildShrineHydrated = true;
            this.guildShrineGuildId = record.guildId ?? null;
            this.emit('guild_shrine_levels_updated', {
                capturedAt: this.guildShrineCapturedAt,
                fromStorage: true,
            });
            return true;
        } catch (error) {
            console.error('[DataManager] Failed to hydrate guild shrine levels:', error);
            return false;
        }
    }

    /**
     * When the guild shrine levels currently in memory were read off the wire.
     * @returns {number|null} Epoch milliseconds, or null when none have ever been seen
     */
    getGuildShrineCapturedAt() {
        return this.guildShrineCapturedAt;
    }

    /**
     * Whether the shrine levels in memory came from storage rather than this session.
     * @returns {boolean} True when hydrated from a persisted reading
     */
    isGuildShrineHydrated() {
        return this.guildShrineHydrated;
    }

    /**
     * Wait for the startup hydration of guild shrine levels, if one is running.
     * @returns {Promise<void>} Resolves once hydration has settled
     */
    async whenGuildShrineLevelsReady() {
        if (this.guildShrineHydration) {
            await this.guildShrineHydration;
        }
    }

    /**
     * Get static game data
     * @returns {Object} Init client data (items, actions, monsters, etc.)
     */
    getInitClientData() {
        return this.initClientData;
    }

    /**
     * Get combined game data (static + character)
     * Used for features that need both static data and player data
     * @returns {Object} Combined data object
     */
    getCombinedData() {
        if (!this.initClientData) {
            return null;
        }

        return {
            ...this.initClientData,
            // Character-specific data
            characterItems: this.characterItems || [],
            myMarketListings: this.characterData?.myMarketListings || [],
            characterHouseRoomMap: Object.fromEntries(this.characterHouseRooms),
            characterAbilities: this.characterData?.characterAbilities || [],
            combatAbilities: this.getEquippedAbilities(),
            abilityCombatTriggersMap: this.characterData?.abilityCombatTriggersMap || {},
        };
    }

    /**
     * Get item details by HRID
     * @param {string} itemHrid - Item HRID (e.g., "/items/cheese")
     * @returns {Object|null} Item details
     */
    getItemDetails(itemHrid) {
        return this.initClientData?.itemDetailMap?.[itemHrid] || null;
    }

    /**
     * Get action details by HRID
     * @param {string} actionHrid - Action HRID (e.g., "/actions/milking/cow")
     * @returns {Object|null} Action details
     */
    getActionDetails(actionHrid) {
        return this.initClientData?.actionDetailMap?.[actionHrid] || null;
    }

    /**
     * Get player's current actions
     * @returns {Array} Current action queue
     */
    getCurrentActions() {
        return [...this.characterActions];
    }

    /**
     * Time already spent inside the currently in-progress base action unit, so a caller
     * modelling "time remaining" does not charge that partial unit as a whole one.
     *
     * Fails closed: returns 0 whenever there is no boundary for this exact
     * (actionId, currentCount) pair — cold start, a unit that completed while the page was
     * closed, a different action — which is precisely the pre-fix "assume it just started"
     * behaviour, rather than inventing a partial estimate from a boundary we cannot vouch for.
     * @param {number} actionId - id of the action currently in progress
     * @param {number} currentCount - that action's currentCount at the moment being asked about
     * @param {number} unitDurationSeconds - full duration of one base action, used to clamp
     * @returns {number} Elapsed seconds, in [0, unitDurationSeconds]
     */
    getElapsedSecondsInCurrentUnit(actionId, currentCount, unitDurationSeconds) {
        if (!Number.isFinite(unitDurationSeconds) || unitDurationSeconds <= 0) return 0;

        const boundary = this.actionUnitBoundary;
        if (!boundary || boundary.actionId !== actionId || boundary.currentCount !== currentCount) {
            return 0;
        }
        if (!Number.isFinite(boundary.unitStartTime)) return 0;

        const elapsedSeconds = (Date.now() - boundary.unitStartTime) / 1000;
        return Math.min(Math.max(0, elapsedSeconds), unitDurationSeconds);
    }

    /**
     * The front action (lowest ordinal), or null when the queue is empty.
     * @returns {Object|null}
     */
    _getFrontAction() {
        let front = null;
        for (const action of this.characterActions) {
            if (!front || action.ordinal < front.ordinal) front = action;
        }
        return front;
    }

    /**
     * Reconcile the tracked boundary against the live front action.
     *
     * A no-op while the front action's (id, currentCount) is unchanged — that is the same
     * in-progress unit, and resetting its start time is exactly the bug being fixed. Otherwise
     * the boundary is re-anchored to now, which is right when the pair changed because we just
     * watched it change (an `action_completed` continuation, or a new action taking the front
     * slot) and is the safe fail-closed default when we are seeing the pair for the first time.
     */
    _syncActionUnitBoundary() {
        const front = this._getFrontAction();

        if (!front) {
            this.actionUnitBoundary = null;
            return;
        }

        const existing = this.actionUnitBoundary;
        if (existing && existing.actionId === front.id && existing.currentCount === front.currentCount) {
            return;
        }

        this.actionUnitBoundary = {
            actionId: front.id,
            currentCount: front.currentCount,
            unitStartTime: Date.now(),
        };

        this._persistActionUnitBoundary();
    }

    /**
     * Write the current boundary through to the `actionProgress` store, keyed by character.
     * One small record, written only when the boundary actually moves (once per completed
     * base action), and debounced by the storage module on top of that.
     */
    async _persistActionUnitBoundary() {
        if (!this.currentCharacterId || !this.actionUnitBoundary) return;
        try {
            await storage.set(String(this.currentCharacterId), this.actionUnitBoundary, 'actionProgress');
        } catch (error) {
            console.error('[DataManager] Failed to persist action unit boundary:', error);
        }
    }

    /**
     * Restore the persisted boundary on login, reload or a switch back to this character.
     *
     * The stored record is only trusted while its (actionId, currentCount) still matches the
     * live front action. Any mismatch means at least one unit completed unobserved, so the
     * stored start time no longer describes anything real and _syncActionUnitBoundary lays
     * down a fresh fail-closed boundary instead.
     * @param {string|number} characterId - Character the persisted record belongs to
     */
    async _restoreActionUnitBoundary(characterId) {
        this.actionUnitBoundary = null;

        const front = this._getFrontAction();
        if (!front || !characterId) {
            this._syncActionUnitBoundary();
            return;
        }

        try {
            const persisted = await storage.get(String(characterId), 'actionProgress', null);
            if (
                persisted &&
                persisted.actionId === front.id &&
                persisted.currentCount === front.currentCount &&
                Number.isFinite(persisted.unitStartTime)
            ) {
                this.actionUnitBoundary = persisted;
            }
        } catch (error) {
            console.error('[DataManager] Failed to restore action unit boundary:', error);
        }

        this._syncActionUnitBoundary();
    }

    /**
     * Get player's equipped items
     * @returns {Map} Equipment map (slot HRID -> item)
     */
    getEquipment() {
        return new Map(this.characterEquipment);
    }

    /**
     * Fingerprint of the equipment/drink-slot state, for memos computed from it.
     *
     * Bumped whenever the equipment map or the drink slots change (equip,
     * unequip, drink change, character switch). A cache entry that stores the
     * version it was computed under, and misses when the versions differ, is
     * exactly as fresh as the buffs — without the cache owner wiring its own
     * listeners into every message that can move gear.
     * @returns {number} Monotonic counter; only equality is meaningful
     */
    getBuffStateVersion() {
        return this.buffStateVersion;
    }

    /**
     * Get MooPass buffs
     * @returns {Array} MooPass buffs array (empty if no MooPass)
     */
    getMooPassBuffs() {
        return this.characterData?.mooPassBuffs || [];
    }

    /**
     * Get the current character's server-resolved offline-progress hour cap. Never reconstructed
     * from purchased upgrades — this is the exact value the server sends.
     * @returns {number|null} Offline hour cap, or null if not yet known
     */
    getOfflineHourCap() {
        return this.characterData?.characterInfo?.offlineHourCap ?? null;
    }

    /**
     * Get the current character's MooPass expiry timestamp, if any.
     * @returns {number|null} Epoch ms, or null if no MooPass / not yet known
     */
    getMooPassExpireTime() {
        const raw = this.characterData?.characterInfo?.mooPassExpireTime;
        if (raw == null) return null;
        // The server sends this as an ISO string on characterInfo; other callers of
        // characterInfo read levels rather than dates, so the normalisation lives here.
        const ms = typeof raw === 'number' ? raw : Date.parse(raw);
        return Number.isFinite(ms) ? ms : null;
    }

    /**
     * Get player's house rooms
     * @returns {Map} House room map (room HRID -> {houseRoomHrid, level})
     */
    getHouseRooms() {
        return new Map(this.characterHouseRooms);
    }

    /**
     * Get house room level
     * @param {string} houseRoomHrid - House room HRID (e.g., "/house_rooms/brewery")
     * @returns {number} Room level (0 if not found)
     */
    getHouseRoomLevel(houseRoomHrid) {
        const room = this.characterHouseRooms.get(houseRoomHrid);
        return room?.level || 0;
    }

    /**
     * Get character's purchased level for a guild buff
     * @param {string} guildBuffHrid - Guild buff HRID (e.g., "/guild_buffs/force_combat")
     * @returns {number} Current purchased level (0 if not purchased)
     */
    getCharacterGuildBuffLevel(guildBuffHrid) {
        return this.characterGuildBuffMap[guildBuffHrid]?.level || 0;
    }

    /**
     * Get guild shrine or building level
     * @param {string} hrid - Building/shrine HRID (e.g., "/guild_shrines/force")
     * @returns {number} Current guild building level (0 if not in a guild or not built)
     */
    getGuildBuildingLevel(hrid) {
        return this.guildBuildingLevelMap[hrid] || 0;
    }

    /**
     * Get active drink items for an action type
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
     * @returns {Array} Array of drink items (empty if none)
     */
    getActionDrinkSlots(actionTypeHrid) {
        return this.actionTypeDrinkSlotsMap.get(actionTypeHrid) || [];
    }

    /**
     * Get current character ID
     * @returns {string|null} Character ID or null
     */
    getCurrentCharacterId() {
        return this.currentCharacterId;
    }

    /**
     * Get current character name
     * @returns {string|null} Character name or null
     */
    getCurrentCharacterName() {
        return this.currentCharacterName;
    }

    /**
     * Get current character game mode
     * @returns {string|null} Game mode ('ironcow', 'standard', etc.) or null
     */
    getCurrentCharacterGameMode() {
        return this.currentCharacterGameMode;
    }

    /**
     * Check if character is currently switching
     * @returns {boolean} True if switching
     */
    getIsCharacterSwitching() {
        return this.isCharacterSwitching;
    }

    /**
     * Get community buff level
     * @param {string} buffTypeHrid - Buff type HRID (e.g., "/community_buff_types/production_efficiency")
     * @returns {number} Buff level (0 if not active)
     */
    getCommunityBuffLevel(buffTypeHrid) {
        if (!this.characterData?.communityBuffs) {
            return 0;
        }

        const buff = this.characterData.communityBuffs.find((b) => b.hrid === buffTypeHrid);
        return buff?.level || 0;
    }

    /**
     * Get achievement buffs for an action type
     * Achievement buffs are provided by the game based on completed achievement tiers
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
     * @returns {Object} Buff object with stat bonuses (e.g., {gatheringQuantity: 0.02}) or empty object
     */
    getAchievementBuffs(actionTypeHrid) {
        if (!this.characterData?.achievementActionTypeBuffsMap) {
            return {};
        }

        return this.characterData.achievementActionTypeBuffsMap[actionTypeHrid] || {};
    }

    /**
     * Get achievement buff flat boost for an action type and buff type
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
     * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/wisdom")
     * @returns {number} Flat boost value (decimal) or 0 if not found
     */
    getAchievementBuffFlatBoost(actionTypeHrid, buffTypeHrid) {
        const achievementMap = this.characterData?.achievementActionTypeBuffsMap;
        if (!achievementMap) {
            return 0;
        }

        if (this.achievementBuffCache.source !== achievementMap) {
            this.achievementBuffCache = {
                source: achievementMap,
                byActionType: new Map(),
            };
        }

        const actionCache = this.achievementBuffCache.byActionType.get(actionTypeHrid) || new Map();
        if (actionCache.has(buffTypeHrid)) {
            return actionCache.get(buffTypeHrid);
        }

        const achievementBuffs = achievementMap[actionTypeHrid];
        if (!Array.isArray(achievementBuffs)) {
            actionCache.set(buffTypeHrid, 0);
            this.achievementBuffCache.byActionType.set(actionTypeHrid, actionCache);
            return 0;
        }

        const buff = achievementBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
        const flatBoost = buff?.flatBoost || 0;
        actionCache.set(buffTypeHrid, flatBoost);
        this.achievementBuffCache.byActionType.set(actionTypeHrid, actionCache);
        return flatBoost;
    }

    /**
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/enhancing")
     * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/enhancing_success")
     * @returns {number} Ratio boost value (decimal) or 0 if not found
     */
    getAchievementBuffRatioBoost(actionTypeHrid, buffTypeHrid) {
        const achievementMap = this.characterData?.achievementActionTypeBuffsMap;
        if (!achievementMap) return 0;

        const achievementBuffs = achievementMap[actionTypeHrid];
        if (!Array.isArray(achievementBuffs)) return 0;

        const buff = achievementBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
        return buff?.ratioBoost || 0;
    }

    /**
     * Get personal buff flat boost for an action type and buff type (seal buffs from Labyrinth).
     * When scroll simulation is armed for this action type, returns max(active, simulated).
     * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/foraging")
     * @param {string} buffTypeHrid - Buff type HRID (e.g., "/buff_types/efficiency")
     * @returns {number} Flat boost value (decimal) or 0 if not found
     */
    getPersonalBuffFlatBoost(actionTypeHrid, buffTypeHrid) {
        const activeValue = this._getActivePersonalBuff(actionTypeHrid, buffTypeHrid);
        const simSet = this.scrollSimulationByActionType[actionTypeHrid];
        if (simSet?.has(buffTypeHrid)) {
            return Math.max(activeValue, SCROLL_BUFF_VALUES[buffTypeHrid] ?? 0);
        }
        return activeValue;
    }

    /**
     * @param {string} actionTypeHrid
     * @param {string} buffTypeHrid
     * @returns {number}
     */
    _getActivePersonalBuff(actionTypeHrid, buffTypeHrid) {
        const personalBuffs = this.personalActionTypeBuffsMap[actionTypeHrid];
        if (!Array.isArray(personalBuffs)) return 0;
        const buff = personalBuffs.find((entry) => entry?.typeHrid === buffTypeHrid);
        return buff?.flatBoost || 0;
    }

    /**
     * Arm scroll simulation for a specific action type before running calculations.
     * @param {string} actionTypeHrid
     * @param {Set<string>} buffTypeSet - Set of buffTypeHrids to simulate
     */
    setScrollSimulation(actionTypeHrid, buffTypeSet) {
        if (buffTypeSet?.size > 0) {
            this.scrollSimulationByActionType[actionTypeHrid] = buffTypeSet;
        } else {
            delete this.scrollSimulationByActionType[actionTypeHrid];
        }
    }

    /**
     * Disarm scroll simulation for a specific action type after calculations are done.
     * @param {string} actionTypeHrid
     */
    clearScrollSimulation(actionTypeHrid) {
        delete this.scrollSimulationByActionType[actionTypeHrid];
    }

    /**
     * Returns true when a scroll buff is being simulated (simulated value > active value).
     * Used by display code to decide whether to show the scroll sprite on a buff row.
     * @param {string} actionTypeHrid
     * @param {string} buffTypeHrid
     * @returns {boolean}
     */
    isBuffBeingSimulated(actionTypeHrid, buffTypeHrid) {
        const simSet = this.scrollSimulationByActionType[actionTypeHrid];
        if (!simSet?.has(buffTypeHrid)) return false;
        return (SCROLL_BUFF_VALUES[buffTypeHrid] ?? 0) > this._getActivePersonalBuff(actionTypeHrid, buffTypeHrid);
    }

    /**
     * Get player's skills
     * @returns {Array|null} Character skills
     */
    getSkills() {
        return this.characterSkills ? [...this.characterSkills] : null;
    }

    /**
     * Get player's inventory
     * @returns {Array|null} Character items
     */
    /**
     * The Bestiary as last fetched: one row per monster with its defeated count.
     * @returns {Array<{monsterHrid: string, count: number, tierData?: string}>|null} Null until the
     *   Achievements → Bestiary tab has loaded it this session
     */
    getCharacterMonsters() {
        return this.characterMonsters || null;
    }

    getInventory() {
        return this.characterItems ? [...this.characterItems] : null;
    }

    /**
     * Get player's market listings
     * @returns {Array} Market listings array
     */
    getMarketListings() {
        return this.characterData?.myMarketListings ? [...this.characterData.myMarketListings] : [];
    }

    /**
     * Get the current blocked character map { [characterId]: name }
     * @returns {Object} Blocked character map, or empty object if not available
     */
    getBlockedCharacterMap() {
        return this.characterData?.blockedCharacterMap || {};
    }

    /**
     * Get active task action HRIDs
     * @returns {Array<string>} Array of action HRIDs that are currently active tasks
     */
    getActiveTaskActionHrids() {
        if (!this.characterQuests || this.characterQuests.length === 0) {
            return [];
        }

        return this.characterQuests
            .filter(
                (quest) =>
                    quest.category === '/quest_category/random_task' &&
                    quest.status === '/quest_status/in_progress' &&
                    quest.actionHrid
            )
            .map((quest) => quest.actionHrid);
    }

    /**
     * Check if an action is currently an active task
     * @param {string} actionHrid - Action HRID to check
     * @returns {boolean} True if action is an active task
     */
    isTaskAction(actionHrid) {
        const activeTasks = this.getActiveTaskActionHrids();
        return activeTasks.includes(actionHrid);
    }

    /**
     * Get task speed bonus from equipped task badges
     * @returns {number} Task speed percentage (e.g., 15 for 15%)
     */
    getTaskSpeedBonus() {
        if (!this.characterEquipment || !this.initClientData) {
            return 0;
        }

        let totalTaskSpeed = 0;

        // Task badges are in trinket slot
        const trinketLocation = '/item_locations/trinket';
        const equippedItem = this.characterEquipment.get(trinketLocation);

        if (!equippedItem || !equippedItem.itemHrid) {
            return 0;
        }

        const itemDetail = this.initClientData.itemDetailMap[equippedItem.itemHrid];
        if (!itemDetail || !itemDetail.equipmentDetail) {
            return 0;
        }

        const taskSpeed = itemDetail.equipmentDetail.noncombatStats?.taskSpeed || 0;
        if (taskSpeed === 0) {
            return 0;
        }

        // Calculate enhancement bonus
        // Note: noncombatEnhancementBonuses already includes slot multiplier (5× for trinket)
        const enhancementLevel = equippedItem.enhancementLevel || 0;
        const enhancementBonus = itemDetail.equipmentDetail.noncombatEnhancementBonuses?.taskSpeed || 0;
        const totalEnhancementBonus = enhancementBonus * enhancementLevel;

        // Total taskSpeed = base + enhancement
        totalTaskSpeed = (taskSpeed + totalEnhancementBonus) * 100; // Convert to percentage

        return totalTaskSpeed;
    }

    /**
     * Build monster-to-sortIndex mapping from combat zone data
     * Used for sorting combat tasks by zone progression order
     * @private
     */
    buildMonsterSortIndexMap() {
        if (!this.initClientData || !this.initClientData.actionDetailMap) {
            return;
        }

        this.monsterSortIndexMap.clear();
        this.bossMonsterHrids.clear();

        // Extract combat zones (non-dungeon only)
        for (const [_zoneHrid, action] of Object.entries(this.initClientData.actionDetailMap)) {
            // Skip non-combat actions and dungeons
            if (action.type !== '/action_types/combat' || action.combatZoneInfo?.isDungeon) {
                continue;
            }

            const sortIndex = action.sortIndex;

            // Get regular spawn monsters
            const regularMonsters = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];

            // Get boss monsters (every 10 battles)
            const bossMonsters = action.combatZoneInfo?.fightInfo?.bossSpawns || [];

            // Track boss monster HRIDs
            for (const boss of bossMonsters) {
                if (boss.combatMonsterHrid) {
                    this.bossMonsterHrids.add(boss.combatMonsterHrid);
                }
            }

            // Combine all monsters from this zone
            const allMonsters = [...regularMonsters, ...bossMonsters];

            // Map each monster to this zone's sortIndex
            for (const spawn of allMonsters) {
                const monsterHrid = spawn.combatMonsterHrid;
                if (!monsterHrid) continue;

                // If monster appears in multiple zones, use earliest zone (lowest sortIndex)
                if (
                    !this.monsterSortIndexMap.has(monsterHrid) ||
                    sortIndex < this.monsterSortIndexMap.get(monsterHrid)
                ) {
                    this.monsterSortIndexMap.set(monsterHrid, sortIndex);
                }
            }
        }
    }

    /**
     * Find the combat zone actionHrid that contains a given monster
     * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/bear")
     * @returns {string|null} Zone actionHrid or null
     */
    getCombatZoneForMonster(monsterHrid) {
        if (!this.initClientData?.actionDetailMap) return null;

        for (const [zoneHrid, action] of Object.entries(this.initClientData.actionDetailMap)) {
            if (action.type !== '/action_types/combat') continue;

            const spawns = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];
            const bosses = action.combatZoneInfo?.fightInfo?.bossSpawns || [];

            for (const spawn of [...spawns, ...bosses]) {
                if (spawn.combatMonsterHrid === monsterHrid) {
                    return zoneHrid;
                }
            }
        }
        return null;
    }

    /**
     * Get zone sortIndex for a monster (for task sorting)
     * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/rat")
     * @returns {number} Zone sortIndex (999 if not found)
     */
    getMonsterSortIndex(monsterHrid) {
        return this.monsterSortIndexMap.get(monsterHrid) ?? 999;
    }

    /**
     * Check if a monster is a boss (appears in bossSpawns of any combat zone)
     * @param {string} monsterHrid - Monster HRID (e.g., "/monsters/crystal_colossus")
     * @returns {boolean} True if the monster is a boss
     */
    isBossMonster(monsterHrid) {
        return this.bossMonsterHrids.has(monsterHrid);
    }

    /**
     * Get monster HRID from display name (for task sorting)
     * @param {string} monsterName - Monster display name (e.g., "Jerry")
     * @returns {string|null} Monster HRID or null if not found
     */
    getMonsterHridFromName(monsterName) {
        if (!this.initClientData || !this.initClientData.combatMonsterDetailMap) {
            return null;
        }

        // Search for monster by display name
        for (const [hrid, monster] of Object.entries(this.initClientData.combatMonsterDetailMap)) {
            if (monster.name === monsterName) {
                return hrid;
            }
        }

        return null;
    }

    /**
     * Register event listener
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     */
    on(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event).push(callback);
    }

    /**
     * Unregister event listener
     * @param {string} event - Event name
     * @param {Function} callback - Handler function to remove
     */
    off(event, callback) {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            const index = listeners.indexOf(callback);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        }
    }

    /**
     * Emit event to all listeners
     * Only character_switching is critical (must run immediately for proper cleanup)
     * All other events including character_switched and character_initialized are deferred
     * @param {string} event - Event name
     * @param {*} data - Event data
     * @returns {Promise<void>|undefined} For critical events, a promise that settles once every
     *   async listener has, so a caller that must not proceed until they have can await it.
     *   Deferred events return undefined — there is nothing to wait for.
     */
    emit(event, data) {
        // Snapshot at emit time. Lifecycle listeners commonly unregister themselves
        // during character_switching; iterating the live array would shift entries and
        // deterministically skip the next cleanup handler. Deferred events must also not
        // be delivered to listeners that subscribed after the event was emitted.
        const listeners = [...(this.eventListeners.get(event) || [])];

        // Only character_switching must run immediately (cleanup phase)
        // character_switched can be deferred - it just schedules re-init anyway
        const isCritical = event === 'character_switching';

        if (isCritical) {
            // Run immediately on main thread.
            //
            // An async listener's promise is collected and handed back so the
            // emitter can wait for it: the queue snapshot of the departing
            // character is written here, and the re-init that reads it back
            // begins as soon as this returns.
            const settled = [];
            for (const listener of listeners) {
                try {
                    const result = listener(data);
                    if (result && typeof result.then === 'function') {
                        settled.push(
                            Promise.resolve(result).catch((error) => {
                                console.error(`[Data Manager] Error in ${event} listener:`, error);
                            })
                        );
                    }
                } catch (error) {
                    console.error(`[Data Manager] Error in ${event} listener:`, error);
                }
            }
            return settled.length > 0 ? Promise.all(settled) : undefined;
        } else {
            // Defer all other events to prevent main thread blocking
            setTimeout(() => {
                // The snapshot fixes *which* listeners this event goes to, but a
                // tick is long enough for a feature to be disabled in between —
                // a character switch tears down a hundred of them — and calling
                // a listener whose feature has already cleaned up is how a
                // handler ends up reading a nulled panel. Deliver only to
                // listeners that were in the snapshot and are still registered.
                const live = this.eventListeners.get(event);
                if (!live || live.length === 0) return;
                const stillRegistered = new Set(live);
                // Timed as one batch: the whole loop is one macrotask, and one
                // macrotask is what a stall is made of — so this is the number
                // the stall ledger's attribution wants (see startStallWatch)
                const startedAt = performanceMonitor.enabled ? performance.now() : 0;
                for (const listener of listeners) {
                    if (!stillRegistered.has(listener)) continue;
                    try {
                        listener(data);
                    } catch (error) {
                        console.error(`[Data Manager] Error in ${event} listener:`, error);
                    }
                }
                if (startedAt) performanceMonitor.record(`event:${event}`, performance.now() - startedAt);
            }, 0);
        }
    }
}

const dataManager = new DataManager();

export default dataManager;
