/**
 * Task Reroll Protection
 * Prevents accidental rerolling of desirable tasks by highlighting protected tasks
 * and requiring a confirmation click before rerolling.
 *
 * Users configure which action/monster HRIDs to protect. When a task matches,
 * it gets a green border (sides and bottom, leaving the card's top edge
 * untouched) and the reroll buttons require a double-click to proceed.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { isCardInConfirmState, armConfirmSettleWatch, onConfirmFlowSettled } from './task-card-state.js';
import { findRerollOptions } from './task-reroll-options.js';
import { questForTaskCard } from './task-card-quest.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { characterKey, readScopedFrom } from '../../utils/character-key.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY_PREFIX = 'taskProtectedHrids';

/** The cap-block settings, in the order the batched startup read wants them. */
const CAP_BASES = ['taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'];

const DEFAULT_COIN_THRESHOLD = 320000;
const DEFAULT_COWBELL_THRESHOLD = 32;

/**
 * Get character-scoped storage key.
 * @returns {string}
 */
function getStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

class TaskRerollProtection {
    constructor() {
        this.isInitialized = false;
        this.protectedHrids = new Set();
        this.capProtectionEnabled = false;
        this.coinThreshold = DEFAULT_COIN_THRESHOLD;
        this.cowbellThreshold = DEFAULT_COWBELL_THRESHOLD;
        this.unregisterHandlers = [];
        this.confirmTimers = new WeakMap(); // taskCard → timeout ID, for the "same card clicked again" replace
        // A WeakMap cannot be iterated, so it cannot cancel every pending
        // lockdown/confirm timer on disable() by itself — see `disable()`.
        this.timerRegistry = createTimerRegistry();
        this._documentInterceptorAttached = false;
        this._interceptHandler = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('taskRerollProtection')) return;

        this.isInitialized = true;

        // Cap settings are per character. A pre-scoping install's bare keys go
        // through the adopt-once migration — the character the user confirmed
        // claims them and the bare key is deleted — so an alt that never opened
        // the shield config gets the defaults instead of the main's thresholds.
        // The protected list and the six cap records are still read together —
        // one JSON read and one readonly transaction for the rest — instead of
        // seven awaited round trips one after another.
        //
        // A character switch tearing the feature down while this read is in
        // flight used to leave the resumed tail pushing four registrations
        // into the `unregisterHandlers` array `disable()` had already emptied
        // — live class observers and a settle-flow handler with no handle to
        // remove them by. Idempotent (each repaint is gated on dataset flags
        // or a full redraw), so the leaked registrations do no visible harm,
        // but they would sit there doing a duplicate pass over every task
        // card until the *next* switch's teardown clears the array wholesale.
        const ticket = captureOwner(this);
        const [saved, caps] = await Promise.all([
            storage.getJSON(getStorageKey(), 'settings', []),
            storage.getMany(
                CAP_BASES.flatMap((base) => [characterKey(base), base]),
                'settings'
            ),
        ]);
        this.protectedHrids = new Set(saved);
        this.capProtectionEnabled = await readScopedFrom('taskCapProtection', caps, 'settings', false);
        this.coinThreshold = await readScopedFrom('taskCapCoinThreshold', caps, 'settings', DEFAULT_COIN_THRESHOLD);
        this.cowbellThreshold = await readScopedFrom(
            'taskCapCowbellThreshold',
            caps,
            'settings',
            DEFAULT_COWBELL_THRESHOLD
        );
        if (!stillOurs(ticket)) return;

        // Watch for task cards appearing. Draw at once so the protected border
        // is there the instant the card is — the observer only ever fires for a
        // freshly added card node, which carries no border yet, so an immediate
        // pass can only add one, never flicker an existing one off. The 150 ms
        // pass stays as a fallback for the rare case the card's React fiber (and
        // so its quest) is not yet reachable on the first pass.
        const unregister = domObserver.onClass('TaskRerollProtection', 'RandomTask_randomTask', (taskNode) => {
            this._processTaskCard(taskNode);
            this.timerRegistry.registerTimeout(setTimeout(() => this._processTaskCard(taskNode), 150));
        });
        this.unregisterHandlers.push(unregister);

        // Re-process on quest updates (task content may change after reroll)
        const questHandler = () => {
            this.timerRegistry.registerTimeout(setTimeout(() => this._processAllCards(), 300));
        };
        webSocketHook.on('quests_updated', questHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questHandler));

        // Inject shield config button into task panel
        const unregisterPanel = domObserver.onClass(
            'TaskRerollProtection-Panel',
            'TasksPanel_taskSlotCount',
            (panel) => {
                this._injectConfigButton(panel);
            }
        );
        this.unregisterHandlers.push(unregisterPanel);

        // A closing reroll chooser adds an action row, not a card, so no
        // observer above sees it — this is what repaints the cards the pass
        // above declined to touch
        this.unregisterHandlers.push(onConfirmFlowSettled(() => this._processAllCards()));

        // Process existing cards. @run-at document-start: cards rendered before the shared
        // observer attaches to document.body are invisible to the class watchers, so the
        // catch-up waits for its actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(domObserver.onReady('TaskRerollProtectionCatchUp', () => this._processAllCards()));
    }

    /**
     * Process all visible task cards.
     * @private
     */
    _processAllCards() {
        const cards = document.querySelectorAll('[class*="RandomTask_randomTask"]');
        for (const card of cards) {
            this._processTaskCard(card);
        }
    }

    /**
     * Inject a shield config button into the task panel header.
     * @param {HTMLElement} panel - The TasksPanel_taskSlotCount element
     * @private
     */
    _injectConfigButton(panel) {
        const parent = panel.parentElement;
        if (!parent || parent.querySelector('.mwi-task-protection-btn')) return;

        const btn = document.createElement('span');
        btn.className = 'mwi-task-protection-btn';
        btn.textContent = '🛡️';
        btn.title = 'Configure task reroll protection';
        btn.style.cssText = 'cursor:pointer; font-size:16px; margin-left:6px; opacity:0.7; transition:opacity 0.1s;';
        btn.addEventListener('mouseover', () => {
            btn.style.opacity = '1';
        });
        btn.addEventListener('mouseout', () => {
            btn.style.opacity = '0.7';
        });
        btn.addEventListener('click', () => this.openConfigPopup());

        parent.appendChild(btn);
    }

    /**
     * Process a single task card — check protection status and wire interception.
     * @param {HTMLElement} taskCard
     * @private
     */
    _processTaskCard(taskCard) {
        // Wire the interception first: it is once-only, document-level, and has
        // to be in place before the card can be interacted with at all
        if (!taskCard.dataset.mwiRerollProtection) {
            taskCard.dataset.mwiRerollProtection = '1';
            this._wireRerollInterception(taskCard);
        }

        // A card mid-flow (its reroll chooser or discard confirmation open) still
        // gets its border redrawn. The edge is an inset box-shadow — it shifts no
        // layout and cannot disturb the click the player is in the middle of — so
        // drawing it now is what makes the green move the instant a reroll lands,
        // rather than waiting for the menu to be closed. The settle watch is still
        // armed so the one thing that CAN disturb a mid-flow card (the legacy
        // outline reset, which fights task-auto-reroll) runs only once it settles.
        const inConfirm = isCardInConfirmState(taskCard);
        if (inConfirm) armConfirmSettleWatch();

        // Get quest data via fiber traversal
        const quest = this._getQuestFromCard(taskCard);
        const hrid = quest?.actionHrid || quest?.monsterHrid || '';
        const isProtected = hrid && this.protectedHrids.has(hrid);

        // Check if this card is currently at the reroll cap
        const isAtCap = this.capProtectionEnabled && this._cardIsAtCap(taskCard);

        // Update visual state — per-task green takes precedence over cap orange.
        // Inset edge shadows draw the highlight on the sides and bottom only,
        // leaving the card's top edge untouched (and shifting no layout).
        const edgeHighlight = (color, glow) =>
            `inset 2px 0 0 0 ${color}, inset -2px 0 0 0 ${color}, inset 0 -2px 0 0 ${color}, 0 4px 8px ${glow}`;
        if (isProtected && !config.getSetting('taskRerollProtection_hideHighlight')) {
            taskCard.style.setProperty(
                'box-shadow',
                edgeHighlight('rgba(76, 175, 80, 0.7)', 'rgba(76, 175, 80, 0.3)'),
                'important'
            );
        } else if (isAtCap) {
            taskCard.style.setProperty(
                'box-shadow',
                edgeHighlight('rgba(251, 146, 60, 0.7)', 'rgba(251, 146, 60, 0.3)'),
                'important'
            );
        } else {
            taskCard.style.removeProperty('box-shadow');
        }

        // The outline is how this feature used to draw its highlight, cleared
        // here so an upgrade does not leave one behind. It is also how
        // task-auto-reroll draws its "worth rerolling" border, so clearing it
        // unconditionally makes the two features fight over the same card every
        // pass — which the player sees as the card flickering. Kept out of the
        // mid-flow pass so the two never fight over a card the player is
        // mid-click on; it runs on the settle pass instead.
        if (!inConfirm && !taskCard.querySelector('.mwi-autoreroll-badge')) {
            taskCard.style.removeProperty('outline');
            taskCard.style.removeProperty('outline-offset');
        }
    }

    /**
     * Returns true if the task card's reroll cost meets or exceeds the configured threshold.
     * Coin progression: 10K → 20K → 40K → 80K → 160K → 320K (hard cap)
     * Cowbell progression: 1 → 2 → 4 → 8 → 16 → 32 (hard cap)
     * A category whose limit allows zero rerolls (threshold at the minimum) is
     * trivially "at cap" from the start, so it never triggers the glow on its
     * own — only once the other category's limit is actually hit.
     * @param {HTMLElement} taskCard
     * @returns {boolean}
     * @private
     */
    _cardIsAtCap(taskCard) {
        const quest = this._getQuestFromCard(taskCard);
        if (!quest) return false;
        const coinCost = Math.min(10000 * Math.pow(2, quest.coinRerollCount), 320000);
        const cowbellCost = Math.min(Math.pow(2, quest.cowbellRerollCount), 32);
        const coinAtCap = coinCost >= this.coinThreshold;
        const cowbellAtCap = cowbellCost >= this.cowbellThreshold;
        const coinZero = this.coinThreshold <= 10000;
        const cowbellZero = this.cowbellThreshold <= 1;
        if (coinZero && !cowbellZero) return cowbellAtCap;
        if (cowbellZero && !coinZero) return coinAtCap;
        return coinAtCap || cowbellAtCap;
    }

    /**
     * Extract quest data from a task card via React fiber traversal.
     * @param {HTMLElement} taskCard
     * @returns {Object|null} Quest object with actionHrid/monsterHrid
     * @private
     */
    _getQuestFromCard(taskCard) {
        return questForTaskCard(taskCard);
    }

    /**
     * Wire click interception on reroll buttons within a task card.
     *
     * The one place Toolasha cancels a click the game was meant to receive, so
     * it is kept to exactly the two clicks it is for: rerolling a task the
     * player asked to protect, and paying over the configured cost cap.
     * Everything else on the card — Back, the trash can, Confirm Discard, Go
     * and Claim — goes straight through untouched.
     *
     * @param {HTMLElement} taskCard
     * @private
     */
    _wireRerollInterception(_taskCard) {
        // Only wire the document-level interceptor once
        if (this._documentInterceptorAttached) return;
        this._documentInterceptorAttached = true;

        this._interceptHandler = (e) => this._onDocumentClick(e);
        // Capturing phase — runs before React's delegation on root
        document.addEventListener('click', this._interceptHandler, true);
    }

    /**
     * Decide whether one click is a protected reroll, and block it if so.
     * @param {MouseEvent} e
     * @private
     */
    _onDocumentClick(e) {
        if (!config.getSetting('taskRerollProtection')) return;

        const btn = e.target?.closest?.('button');
        if (!btn) return;

        // Find the parent task card
        const card = btn.closest('[class*="RandomTask_randomTask"]');
        if (!card) return;

        // A reroll is the only thing this feature has any business stopping.
        // The initial "Reroll" button (which only opens the chooser), "Back",
        // the trash can, "Confirm Discard", "Go" and "Claim Reward" are all
        // somebody else's click, and the shared reader knows all of them.
        //
        // It used to be read off the label: a paid reroll was a button whose
        // text began with "Pay". The chooser does not always word it that way —
        // the paid options can be an icon and a number — and under that reading
        // the only reroll this feature could still see was the free one. Cap
        // protection has therefore been guarding nothing at all, and a protected
        // task could be rerolled with coins without a word.
        const option = findRerollOptions(card).find((entry) => entry.button === btn);
        if (!option) return;

        const isFreeReroll = option.kind === 'free';

        // Check if this task is protected
        const quest = this._getQuestFromCard(card);
        const hrid = quest?.actionHrid || quest?.monsterHrid || '';
        const isPerTaskProtected = Boolean(hrid && this.protectedHrids.has(hrid));

        // Cap protection (320K gold / 32 cowbells) is about not overspending,
        // and the MooPass free reroll costs nothing — there is no spend for it
        // to protect. Catching it anyway is what left a player pressing the free
        // reroll over and over with the click going nowhere and no cost in
        // sight to explain why. Per-task protection still covers it: that is a
        // choice about the task, and a free reroll destroys the task just the
        // same.
        const isCapProtected = this.capProtectionEnabled && !isFreeReroll && this._isRerollAtCap(option);

        if (!isPerTaskProtected && !isCapProtected) return;

        // Phase 2: confirmation window is open — allow the reroll through
        if (card.dataset.mwiRerollConfirmed === '1') {
            card.dataset.mwiRerollConfirmed = '';
            this._clearWarning(card);
            return;
        }

        // Block during any protection state (lockdown or waiting for confirm).
        // stopPropagation in the capture phase already keeps this from reaching
        // React on the root; stopImmediatePropagation would additionally kill
        // every other document-capture listener in the script, which is not
        // this feature's to take.
        e.preventDefault();
        e.stopPropagation();

        // Phase 1: lockdown active — absorb click silently
        if (card.dataset.mwiRerollLocked === '1') return;

        const warningMsg = isPerTaskProtected ? 'Protected task! Unlocks in 3s...' : 'Reroll at cap! Unlocks in 3s...';

        // Initial click — start 3s lockdown
        card.dataset.mwiRerollLocked = '1';
        this._showWarning(card, warningMsg);

        // Clear any existing timers for this card
        const existingTimer = this.confirmTimers.get(card);
        if (existingTimer) clearTimeout(existingTimer);

        // After 3s lockdown → open confirmation window. Registered on the
        // timer registry as well as the per-card WeakMap: the WeakMap lets a
        // second click on the same card replace its own timer, but it cannot
        // be iterated, so it cannot cancel every card's pending timer on
        // disable() — a character switch mid-lockdown used to leave this
        // timer alive, and it would go on to stamp `mwiRerollConfirmed = '1'`
        // onto a card the feature had already reset (and that a reinitialize
        // may have repainted with a *different* task by the time it fires),
        // arming a reroll-confirmed bypass nobody clicked to confirm.
        const lockdownTimer = setTimeout(() => {
            card.dataset.mwiRerollLocked = '';
            card.dataset.mwiRerollConfirmed = '1';
            this._showWarning(card, 'Click reroll now to confirm.');

            // Auto-clear confirmation after another 3s
            const confirmTimer = setTimeout(() => {
                card.dataset.mwiRerollConfirmed = '';
                this._clearWarning(card);
            }, 3000);
            this.confirmTimers.set(card, confirmTimer);
            this.timerRegistry.registerTimeout(confirmTimer);
        }, 3000);
        this.confirmTimers.set(card, lockdownTimer);
        this.timerRegistry.registerTimeout(lockdownTimer);
    }

    /**
     * Show warning overlay on a task card.
     * @param {HTMLElement} taskCard
     * @param {string} [message='Protected task! Unlocks in 3s...']
     * @private
     */
    _showWarning(taskCard, message = 'Protected task! Unlocks in 3s...') {
        this._clearWarning(taskCard);

        const warning = document.createElement('div');
        warning.className = 'mwi-reroll-warning';
        warning.style.cssText = `
            position: absolute;
            bottom: 4px;
            left: 0;
            right: 0;
            text-align: center;
            font-size: 11px;
            font-weight: 700;
            color: #ff6b6b;
            background: rgba(0, 0, 0, 0.85);
            padding: 3px 8px;
            border-radius: 4px;
            z-index: 10;
            pointer-events: none;
            animation: mwi-blink 0.5s ease-in-out 2;
        `;
        warning.textContent = message;

        // Ensure task card has relative positioning for absolute child
        const currentPos = getComputedStyle(taskCard).position;
        if (currentPos === 'static') {
            taskCard.style.position = 'relative';
        }

        taskCard.appendChild(warning);
    }

    /**
     * Clear warning overlay from a task card.
     * @param {HTMLElement} taskCard
     * @private
     */
    _clearWarning(taskCard) {
        const existing = taskCard.querySelector('.mwi-reroll-warning');
        if (existing) existing.remove();
    }

    /**
     * Add an HRID to the protected list.
     * @param {string} hrid - Action or monster HRID
     */
    async addProtected(hrid) {
        this.protectedHrids.add(hrid);
        await this._save();
        this._processAllCards();
    }

    /**
     * Remove an HRID from the protected list.
     * @param {string} hrid - Action or monster HRID
     */
    async removeProtected(hrid) {
        this.protectedHrids.delete(hrid);
        await this._save();
        this._processAllCards();
    }

    /**
     * Toggle an HRID in the protected list.
     * @param {string} hrid
     * @returns {boolean} New state (true = protected)
     */
    async toggleProtected(hrid) {
        if (this.protectedHrids.has(hrid)) {
            this.protectedHrids.delete(hrid);
        } else {
            this.protectedHrids.add(hrid);
        }
        await this._save();
        this._processAllCards();
        return this.protectedHrids.has(hrid);
    }

    /**
     * Get all protected HRIDs.
     * @returns {Set<string>}
     */
    getProtectedHrids() {
        return this.protectedHrids;
    }

    /**
     * Check if a task card is protected.
     * @param {HTMLElement} taskCard
     * @returns {boolean}
     */
    isTaskProtected(taskCard) {
        const quest = this._getQuestFromCard(taskCard);
        const hrid = quest?.actionHrid || quest?.monsterHrid || '';
        return hrid ? this.protectedHrids.has(hrid) : false;
    }

    /**
     * Save protected list to storage.
     * @private
     */
    async _save() {
        await storage.setJSON(getStorageKey(), Array.from(this.protectedHrids), 'settings', true);
    }

    /**
     * Is this reroll option at or over its category's configured threshold?
     *
     * The currency comes from the option rather than from the size of its
     * number — a 32-cowbell reroll and a 32-coin one are not the same reroll,
     * and guessing from magnitude alone is how the free reroll's "(2)" once got
     * measured against the cowbell cap.
     *
     * @param {{kind: string, cost: number|null}} option - A reroll option
     * @returns {boolean}
     * @private
     */
    _isRerollAtCap(option) {
        if (!option || option.cost === null || option.cost === undefined) return false;
        if (option.kind === 'cowbell') return option.cost >= this.cowbellThreshold;
        return option.cost >= this.coinThreshold;
    }

    /**
     * Persist cap protection toggle and thresholds (per character).
     * @private
     */
    async _saveCapProtection() {
        const charId = dataManager.getCurrentCharacterId() || 'default';
        await storage.set(`taskCapProtection_${charId}`, this.capProtectionEnabled, 'settings');
        await storage.set(`taskCapCoinThreshold_${charId}`, this.coinThreshold, 'settings');
        await storage.set(`taskCapCowbellThreshold_${charId}`, this.cowbellThreshold, 'settings');
    }

    /**
     * Open the configuration popup for managing protected tasks.
     */
    openConfigPopup() {
        // Remove existing popup
        const existing = document.getElementById('mwi-task-protection-popup');
        if (existing) {
            existing.remove();
            return;
        }

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        // Build list of all possible task targets (actions + monsters + zones)
        const items = [];
        const zoneMonsters = {}; // zoneHrid → [monsterHrid, ...]

        // Actions (gathering, production, etc.)
        for (const [hrid, action] of Object.entries(gameData.actionDetailMap || {})) {
            if (action.type === '/action_types/combat') {
                // Build zone → monster mapping
                const monsterHrids = new Set();
                const fightInfo = action.combatZoneInfo?.fightInfo;
                if (fightInfo) {
                    for (const spawn of fightInfo.randomSpawnInfo?.spawns || []) {
                        if (spawn.combatMonsterHrid) monsterHrids.add(spawn.combatMonsterHrid);
                    }
                    for (const spawn of fightInfo.bossSpawns || []) {
                        if (spawn.combatMonsterHrid) monsterHrids.add(spawn.combatMonsterHrid);
                    }
                }
                const dungeonInfo = action.combatZoneInfo?.dungeonInfo;
                if (dungeonInfo) {
                    for (const wave of Object.values(dungeonInfo.fixedSpawnsMap || {})) {
                        for (const spawn of wave) {
                            if (spawn.combatMonsterHrid) monsterHrids.add(spawn.combatMonsterHrid);
                        }
                    }
                    for (const spawnInfo of Object.values(dungeonInfo.randomSpawnInfoMap || {})) {
                        for (const spawn of spawnInfo.spawns || []) {
                            if (spawn.combatMonsterHrid) monsterHrids.add(spawn.combatMonsterHrid);
                        }
                    }
                }
                if (monsterHrids.size > 1) {
                    zoneMonsters[hrid] = [...monsterHrids];
                    items.push({ hrid, name: action.name, type: 'zone', isZone: true });
                }
                continue;
            }
            items.push({ hrid, name: action.name, type: action.type?.split('/').pop() || 'other' });
        }

        // Combat monsters
        for (const [hrid, monster] of Object.entries(gameData.combatMonsterDetailMap || {})) {
            items.push({ hrid, name: monster.name, type: 'combat' });
        }

        items.sort((a, b) => a.name.localeCompare(b.name));

        // Build popup
        const popup = document.createElement('div');
        popup.id = 'mwi-task-protection-popup';
        popup.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: ${PANEL_Z_CAP + 2};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid rgba(74, 158, 255, 0.5);
            border-radius: 10px;
            width: 400px;
            max-height: 500px;
            display: flex;
            flex-direction: column;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            border-bottom: 1px solid rgba(74, 158, 255, 0.3);
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:#4a9eff;">Protected Tasks</span>
            <button id="mwi-task-protection-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">×</button>
        `;

        // Search input
        const searchDiv = document.createElement('div');
        searchDiv.style.cssText = 'padding: 8px 14px; flex-shrink: 0;';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Search actions, monsters, zones...';
        searchInput.style.cssText = `
            width: 100%;
            padding: 6px 10px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 6px;
            color: #e0e0e0;
            font-size: 13px;
            font-family: inherit;
            outline: none;
        `;
        searchDiv.appendChild(searchInput);

        // List container
        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'flex: 1; overflow-y: auto; padding: 4px 14px;';

        const renderList = (query) => {
            const lower = query.toLowerCase();
            const filtered = query
                ? items.filter((i) => i.name.toLowerCase().includes(lower))
                : items.filter((i) => {
                      if (i.isZone) {
                          // Show zone if any of its monsters are protected
                          return zoneMonsters[i.hrid]?.some((m) => this.protectedHrids.has(m));
                      }
                      return this.protectedHrids.has(i.hrid);
                  });

            let html = '';
            if (!query && filtered.length === 0) {
                html =
                    '<div style="color:#666; text-align:center; padding:20px 0;">No protected tasks yet. Search to add.</div>';
            }

            for (const item of filtered.slice(0, 50)) {
                let checkmark, checkColor, nameColor, typeLabel;

                if (item.isZone) {
                    const monsters = zoneMonsters[item.hrid] || [];
                    const protectedCount = monsters.filter((m) => this.protectedHrids.has(m)).length;
                    const allProtected = protectedCount === monsters.length;
                    checkmark = allProtected ? '✓' : protectedCount > 0 ? '~' : '';
                    checkColor = protectedCount > 0 ? '#4a9eff' : '#444';
                    nameColor = protectedCount > 0 ? '#e0e0e0' : '#aaa';
                    typeLabel = 'Zone (' + monsters.length + ')';
                } else {
                    const isProtected = this.protectedHrids.has(item.hrid);
                    checkmark = isProtected ? '✓' : '';
                    checkColor = isProtected ? '#4caf50' : '#444';
                    nameColor = isProtected ? '#e0e0e0' : '#aaa';
                    typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
                }

                const borderColor = item.isZone ? '#2a2a4e' : '#1a1a2e';
                html += `<div data-hrid="${item.hrid}" ${item.isZone ? 'data-zone="1"' : ''} style="
                    display:flex; align-items:center; gap:8px; padding:5px 4px;
                    cursor:pointer; border-bottom:1px solid ${borderColor};
                    transition: background 0.1s;
                " onmouseover="this.style.background='rgba(255,255,255,0.04)'"
                   onmouseout="this.style.background=''">
                    <span style="width:18px; text-align:center; color:${checkColor}; font-weight:700;">${checkmark}</span>
                    <span style="flex:1; color:${nameColor};">${item.name}</span>
                    <span style="color:#666; font-size:11px;">${typeLabel}</span>
                </div>`;
            }

            if (filtered.length > 50) {
                html += `<div style="color:#666; text-align:center; padding:8px;">...${filtered.length - 50} more (refine search)</div>`;
            }

            listContainer.innerHTML = html;

            // Wire click handlers
            listContainer.querySelectorAll('[data-hrid]').forEach((row) => {
                row.addEventListener('click', async () => {
                    if (row.dataset.zone === '1') {
                        // Zone click — toggle all monsters in zone
                        const monsters = zoneMonsters[row.dataset.hrid] || [];
                        const allProtected = monsters.every((m) => this.protectedHrids.has(m));
                        for (const m of monsters) {
                            if (allProtected) {
                                this.protectedHrids.delete(m);
                            } else {
                                this.protectedHrids.add(m);
                            }
                        }
                        await this._save();
                        this._processAllCards();
                    } else {
                        await this.toggleProtected(row.dataset.hrid);
                    }
                    renderList(searchInput.value.trim());
                });
            });
        };

        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => renderList(searchInput.value.trim()), 150);
        });

        popup.appendChild(header);
        popup.appendChild(searchDiv);

        // Cap protection toggle row
        const capRow = document.createElement('div');
        capRow.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 7px 14px;
            border-bottom: 1px solid rgba(74, 158, 255, 0.2);
            border-top: 1px solid rgba(74, 158, 255, 0.2);
            cursor: pointer;
            flex-shrink: 0;
        `;

        const COIN_OPTIONS = [10000, 20000, 40000, 80000, 160000, 320000];
        const COWBELL_OPTIONS = [1, 2, 4, 8, 16, 32];
        const selectCss = `
            background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px; color: #e0e0e0; font-size: 11px; padding: 2px 4px; cursor: pointer;
        `;

        const renderCapRow = () => {
            const on = this.capProtectionEnabled;
            if (on) {
                const coinOpts = COIN_OPTIONS.map(
                    (v) =>
                        `<option value="${v}" ${v === this.coinThreshold ? 'selected' : ''}>${v >= 1000 ? v / 1000 + 'K' : v}💰</option>`
                ).join('');
                const cowbellOpts = COWBELL_OPTIONS.map(
                    (v) => `<option value="${v}" ${v === this.cowbellThreshold ? 'selected' : ''}>${v}🔔</option>`
                ).join('');
                capRow.innerHTML = `
                    <span style="width:18px; text-align:center; color:#f0a830; font-weight:700;">✓</span>
                    <span style="color:#e0e0e0;">Block rerolls at</span>
                    <select class="toolasha-select" id="mwi-cap-coin" style="${selectCss}">${coinOpts}</select>
                    <select class="toolasha-select" id="mwi-cap-cowbell" style="${selectCss}">${cowbellOpts}</select>
                `;
                const coinSel = capRow.querySelector('#mwi-cap-coin');
                const cowbellSel = capRow.querySelector('#mwi-cap-cowbell');
                coinSel.addEventListener('click', (e) => e.stopPropagation());
                cowbellSel.addEventListener('click', (e) => e.stopPropagation());
                coinSel.addEventListener('change', async (e) => {
                    this.coinThreshold = parseInt(e.target.value, 10);
                    this._processAllCards();
                    await this._saveCapProtection();
                });
                cowbellSel.addEventListener('change', async (e) => {
                    this.cowbellThreshold = parseInt(e.target.value, 10);
                    this._processAllCards();
                    await this._saveCapProtection();
                });
            } else {
                capRow.innerHTML = `
                    <span style="width:18px; text-align:center; color:#444; font-weight:700;"></span>
                    <span style="flex:1; color:#aaa;">Block rerolls at cap</span>
                    <span style="color:#888; font-size:11px;">320K💰 / 32🔔</span>
                `;
            }
        };
        renderCapRow();

        capRow.addEventListener('click', async () => {
            this.capProtectionEnabled = !this.capProtectionEnabled;
            renderCapRow();
            this._processAllCards();
            await this._saveCapProtection();
        });
        capRow.addEventListener('mouseover', () => {
            capRow.style.background = 'rgba(255,255,255,0.04)';
        });
        capRow.addEventListener('mouseout', () => {
            capRow.style.background = '';
        });

        popup.appendChild(capRow);
        popup.appendChild(listContainer);
        document.body.appendChild(popup);

        // Initial render — show protected items
        renderList('');
        searchInput.focus();

        // Click outside to close
        const backdrop = document.createElement('div');
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', () => {
            popup.remove();
            backdrop.remove();
        });
        document.body.appendChild(backdrop);

        // Close handler — must remove the backdrop too, or it swallows the next click
        popup.querySelector('#mwi-task-protection-close').addEventListener('click', () => {
            popup.remove();
            backdrop.remove();
        });
    }

    disable() {
        noteTeardown(this);
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];

        // Every pending lockdown/confirm timer, cancelled before it can stamp
        // a dataset flag onto a card this feature (or the character it
        // belonged to) has already left behind
        this.timerRegistry.clearAll();
        this.confirmTimers = new WeakMap();

        // The click interceptor outlives everything else unless it is taken off
        // here: it is bound to the document, not to a card, so a feature that
        // has been switched off (or a character switch that re-initialises)
        // would otherwise leave a listener behind still cancelling rerolls
        if (this._interceptHandler) {
            document.removeEventListener('click', this._interceptHandler, true);
            this._interceptHandler = null;
        }
        this._documentInterceptorAttached = false;

        // Remove all visual changes
        const cards = document.querySelectorAll('[class*="RandomTask_randomTask"]');
        for (const card of cards) {
            delete card.dataset.mwiRerollProtection;
            delete card.dataset.mwiRerollLocked;
            delete card.dataset.mwiRerollConfirmed;
            card.style.removeProperty('outline');
            card.style.removeProperty('outline-offset');
            card.style.removeProperty('box-shadow');
            this._clearWarning(card);
        }

        this.isInitialized = false;
    }
}

const taskRerollProtection = new TaskRerollProtection();

export default {
    name: 'Task Reroll Protection',
    initialize: async () => {
        await taskRerollProtection.initialize();
    },
    cleanup: () => {
        taskRerollProtection.disable();
    },
    disable: () => {
        try {
            taskRerollProtection.disable();
        } catch (error) {
            console.error('[Task Reroll Protection] Disable failed part-way:', error);
        } finally {
            taskRerollProtection.isInitialized = false;
        }
    },
    openConfigPopup: () => {
        taskRerollProtection.openConfigPopup();
    },
    isTaskProtected: (taskCard) => taskRerollProtection.isTaskProtected(taskCard),
    /** The feature itself, for tests that read the settings it loaded */
    protection: taskRerollProtection,
};
