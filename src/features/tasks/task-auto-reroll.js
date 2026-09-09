/**
 * Task Auto-Reroll Reminder
 * Highlights tasks worth rerolling with a red indicator. Inverse of task reroll
 * protection — instead of preventing rerolls, it points at the ones to spend on.
 *
 * Two independent triggers badge a card:
 *  - the per-character blacklist the player curates by hand, and
 *  - the task rating below the visible board's median by more than its next
 *    reroll would cost. That second rule is what makes the badge a decision
 *    rather than a bookmark: a task is only worth replacing when replacing it
 *    with a typical task pays for the reroll.
 *
 * Per-character configuration stored in IndexedDB.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { calculateTaskTokenValue } from './task-profit-calculator.js';
import { readVisibleTaskRatings } from './task-profit-display.js';
import { isCardInConfirmState, armConfirmSettleWatch, onConfirmFlowSettled } from './task-card-state.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';

const STORAGE_KEY_PREFIX = 'taskAutoRerollHrids';
const PROTECTED_KEY_PREFIX = 'taskProtectedHrids';

// Coin reroll progression: 10K → 20K → … → 320K (hard cap)
const REROLL_BASE_COIN_COST = 10000;
const REROLL_MAX_COIN_COST = 320000;

/** Whoever is logged in, or `'default'` before login */
function currentCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * Both lists' keys, built from an id the caller captured rather than from
 * whoever is current when the key happens to be needed.
 * @param {string} charId - Whose lists
 * @returns {{list: string, protected: string}}
 */
function storageKeys(charId) {
    return { list: `${STORAGE_KEY_PREFIX}_${charId}`, protected: `${PROTECTED_KEY_PREFIX}_${charId}` };
}

/**
 * Cost of a card's next reroll, expressed in the units the rating uses.
 *
 * @param {number} coinRerollCount - Coin rerolls already spent on the card
 * @param {string} ratingMode - 'gold' or 'tokens'
 * @param {number|null} tokenValue - Coins one task token is worth
 * @returns {number|null} Cost in rating units, or null when inexpressible
 */
export function nextRerollCostInRatingUnits(coinRerollCount, ratingMode, tokenValue) {
    const coinCost = Math.min(REROLL_BASE_COIN_COST * Math.pow(2, coinRerollCount || 0), REROLL_MAX_COIN_COST);
    if (ratingMode !== 'tokens') {
        return coinCost;
    }
    // A tokens/hr rating cannot be compared against coins, so the coin cost has
    // to be restated in tokens at what a token is currently worth
    if (!Number.isFinite(tokenValue) || tokenValue <= 0) {
        return null;
    }
    return coinCost / tokenValue;
}

/**
 * Is this task worth rerolling on its numbers alone?
 *
 * The reroll's cost is spread over the hours the task would occupy, so it is
 * compared in the rating's own per-hour units: the task has to trail the board
 * by more than the reroll costs before replacing it is worth doing.
 *
 * Those hours are the FULL task's, which is the same span the ratings and the
 * board median are computed over. Amortising over the hours *remaining* looked
 * like the same thing and was not: as a task neared completion its remaining
 * hours went to zero, the per-hour cost went to infinity, and a 90%-done task
 * paying badly could never be flagged however bad it was — the one case the
 * rule exists for. `task-profit-display.js` writes the rating's own span onto
 * the rating line so both sides of this comparison come off one basis.
 *
 * @param {{value: number, hours: number|null}|undefined} entry - The card's rating
 * @param {number|null} boardMedian - Median rating across the visible board
 * @param {number|null} rerollCost - Next reroll's cost in rating units
 * @returns {boolean}
 */
export function ratesBelowBoard(entry, boardMedian, rerollCost) {
    if (boardMedian === null || boardMedian === undefined) return false;
    if (!entry || !entry.hours) return false;
    if (rerollCost === null || rerollCost === undefined) return false;
    return entry.value < boardMedian - rerollCost / entry.hours;
}

class TaskAutoReroll {
    constructor() {
        this.isInitialized = false;
        this.autoRerollHrids = new Set();
        this.protectedHrids = new Set();
        this.unregisterHandlers = [];
        /**
         * Whose lists `autoRerollHrids` and `protectedHrids` hold, or null when
         * nothing has been loaded. `_save()` refuses to write anything else's.
         */
        this._listOwner = null;
        /**
         * Bumped by {@link disable}. A load that began under the departing
         * character finds the number moved and drops its result rather than
         * putting the departing character's blacklist into the arriving
         * character's memory.
         */
        this._generation = 0;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('taskAutoReroll')) return;

        this.isInitialized = true;

        // Captured before the read. Both lists are per-character, and the read
        // that settles last is the one that ends up in memory: an init still in
        // flight when the player switches used to land the departing
        // character's blacklist in the arriving character's `autoRerollHrids`,
        // where the next toggle wrote it — whole — over the arriving
        // character's own stored list.
        const charId = currentCharId();
        const started = this._generation;
        const current = () => this._generation === started && currentCharId() === charId;

        // Both lists in one readonly transaction rather than two awaited round
        // trips: at startup a dozen features are reading their own records at
        // once, and each extra transaction queues behind all of theirs.
        const keys = storageKeys(charId);
        const read = await storage.getMany([keys.list, keys.protected], 'settings');
        if (!current()) return;
        this.autoRerollHrids = new Set(storage.parseJSON(read.get(keys.list), keys.list, []));
        this._listOwner = charId;
        this.protectedHrids = new Set(storage.parseJSON(read.get(keys.protected), keys.protected, []));

        const unregister = domObserver.onClass('TaskAutoReroll', 'RandomTask_randomTask', () => {
            // Always re-read the whole board: the rating rule is relative, so a
            // card arriving moves the median every other card is judged against
            setTimeout(() => this._processAllCards(), 150);
        });
        this.unregisterHandlers.push(unregister);

        const questHandler = () => {
            setTimeout(async () => {
                await this._loadProtectedHrids();
                this._processAllCards();
            }, 300);
        };
        webSocketHook.on('quests_updated', questHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questHandler));

        const unregisterPanel = domObserver.onClass('TaskAutoReroll-Panel', 'TasksPanel_taskSlotCount', (panel) => {
            this._injectConfigButton(panel);
        });
        this.unregisterHandlers.push(unregisterPanel);

        // Closing a reroll chooser adds no card, so nothing above fires for it
        this.unregisterHandlers.push(onConfirmFlowSettled(() => this._processAllCards()));
    }

    /**
     * Reload the protected list the 🛡️ popup writes, so protection can be
     * detected from the data rather than from paint that may be hidden.
     * @private
     */
    async _loadProtectedHrids(charId = currentCharId()) {
        const started = this._generation;
        try {
            const saved = await storage.getJSON(storageKeys(charId).protected, 'settings', []);
            // Same reasoning as initialize(): a read that no longer speaks for
            // the character it was made for is dropped, not adopted
            if (this._generation !== started || currentCharId() !== charId) return;
            this.protectedHrids = new Set(saved);
        } catch (error) {
            console.error('[TaskAutoReroll] Failed to load protected task list:', error);
        }
    }

    _processAllCards() {
        const cards = Array.from(document.querySelectorAll('[class*="RandomTask_randomTask"]'));
        const board = readVisibleTaskRatings(cards);
        for (const card of cards) {
            this._processTaskCard(card, board);
        }
    }

    /**
     * Apply the rating rule to one card.
     * @param {HTMLElement} card - Task card
     * @param {Object|null} quest - Quest object
     * @param {Object} board - Board summary from readVisibleTaskRatings
     * @returns {boolean}
     * @private
     */
    _ratesBelowBoard(card, quest, board) {
        if (board.median === null) return false;
        const tokenValue = board.ratingMode === 'tokens' ? calculateTaskTokenValue().tokenValue : null;
        const cost = nextRerollCostInRatingUnits(quest?.coinRerollCount, board.ratingMode, tokenValue);
        return ratesBelowBoard(board.entries.get(card), board.median, cost);
    }

    /**
     * Is this card protected?
     *
     * Reads the protected list directly. Protection paints an inset box-shadow
     * (and paints nothing at all when its highlight is hidden), so testing for
     * an outline — or for any paint — misses protected cards.
     *
     * @param {HTMLElement} card - Task card
     * @param {string} hrid - Task action/monster hrid
     * @returns {boolean}
     * @private
     */
    _isProtected(card, hrid) {
        if (hrid && this.protectedHrids.has(hrid)) return true;
        // Fallback for the moment before the list has loaded: protection's own
        // green edge highlight, which it draws as a box-shadow
        return card.style.boxShadow?.includes('76, 175, 80') || false;
    }

    _injectConfigButton(panel) {
        const parent = panel.parentElement;
        if (!parent || parent.querySelector('.mwi-task-autoreroll-btn')) return;

        const btn = document.createElement('span');
        btn.className = 'mwi-task-autoreroll-btn';
        btn.textContent = '\u{1F3AF}';
        btn.title = 'Configure task auto-reroll reminders';
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

    _processTaskCard(taskCard, board) {
        // Mid-flow the card is waiting on the player's second click. Adding or
        // pulling the badge — and with it the card's outline — while they are
        // part-way through a reroll is the flicker they see and then blame on
        // the click not registering. The badge is judged again when the chooser
        // closes, so a "Reroll!" left over from the previous task does not
        // outlive it.
        if (isCardInConfirmState(taskCard)) {
            armConfirmSettleWatch();
            return;
        }

        const quest = this._getQuestFromCard(taskCard);
        const hrid = quest?.actionHrid || quest?.monsterHrid || '';

        // Two independent triggers: the blacklist the player curates by hand,
        // and the task simply not being worth its slot next to the others
        const isBlacklisted = Boolean(hrid && this.autoRerollHrids.has(hrid));
        const isBelowBoard =
            board && config.getSetting('taskAutoReroll_belowPar') === true
                ? this._ratesBelowBoard(taskCard, quest, board)
                : false;
        const shouldReroll = isBlacklisted || isBelowBoard;

        const isProtected = this._isProtected(taskCard, hrid);

        if (shouldReroll && !isProtected) {
            taskCard.style.setProperty('outline', '2px solid rgba(239, 68, 68, 0.7)', 'important');
            taskCard.style.setProperty('outline-offset', '-2px');
            this._showBadge(taskCard, isBlacklisted, isBelowBoard, board);
        } else if (taskCard.querySelector('.mwi-autoreroll-badge')) {
            taskCard.style.removeProperty('outline');
            taskCard.style.removeProperty('outline-offset');
            this._clearBadge(taskCard);
        }
    }

    _showBadge(taskCard, isBlacklisted, isBelowBoard, board) {
        const label = isBlacklisted ? 'Reroll!' : 'Below par';
        const existing = taskCard.querySelector('.mwi-autoreroll-badge');
        if (existing) {
            if (existing.textContent !== label) existing.textContent = label;
            return;
        }

        const badge = document.createElement('div');
        badge.className = 'mwi-autoreroll-badge';
        badge.textContent = label;
        badge.title = isBlacklisted
            ? 'On your auto-reroll list'
            : `Rates below the board median (${Math.round(board?.median ?? 0)} ${board?.ratingMode === 'tokens' ? 'tokens' : 'gold'}/hr) by more than the next reroll costs`;
        if (isBelowBoard && !isBlacklisted) {
            badge.dataset.reason = 'rating';
        }
        badge.style.cssText = `
            position: absolute;
            top: 4px;
            right: 4px;
            font-size: 10px;
            font-weight: 700;
            color: #fff;
            background: rgba(239, 68, 68, 0.85);
            padding: 2px 6px;
            border-radius: 3px;
            z-index: 10;
            pointer-events: none;
        `;

        const currentPos = getComputedStyle(taskCard).position;
        if (currentPos === 'static') {
            taskCard.style.position = 'relative';
        }

        taskCard.appendChild(badge);
    }

    _clearBadge(taskCard) {
        const badge = taskCard.querySelector('.mwi-autoreroll-badge');
        if (badge) badge.remove();
    }

    _getQuestFromCard(taskCard) {
        const rootEl = document.getElementById('root');
        const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function walk(fiber, target) {
            if (!fiber) return null;
            if (fiber.stateNode === target) return fiber;
            return walk(fiber.child, target) || walk(fiber.sibling, target);
        }

        function findQuestInFiber(startFiber) {
            let f = startFiber?.return;
            while (f) {
                if (f.memoizedProps?.characterQuest) {
                    return f.memoizedProps.characterQuest;
                }
                f = f.return;
            }
            return null;
        }

        const anchors = [
            taskCard.querySelector('button.Button_success__6d6kU'),
            taskCard.querySelector('button'),
            taskCard.querySelector('[class*="RandomTask_name"]'),
            taskCard,
        ];

        for (const anchor of anchors) {
            if (!anchor) continue;
            const fiber = walk(rootFiber, anchor);
            if (fiber) {
                const quest = findQuestInFiber(fiber);
                if (quest) return quest;
            }
        }

        return null;
    }

    async toggleHrid(hrid) {
        if (this.autoRerollHrids.has(hrid)) {
            this.autoRerollHrids.delete(hrid);
        } else {
            this.autoRerollHrids.add(hrid);
        }
        await this._save();
        this._processAllCards();
        return this.autoRerollHrids.has(hrid);
    }

    async _save() {
        const charId = currentCharId();
        // The write is the damaging end of the race, so it checks too: the list
        // in memory belongs to whoever loaded it, and writing one character's
        // blacklist under another's key replaces theirs entirely. Refusing
        // costs the toggle; writing costs the list.
        if (this._listOwner !== charId) {
            console.warn(
                `[TaskAutoReroll] Not saving the auto-reroll list: it belongs to ${this._listOwner ?? 'no character yet'}, ` +
                    `not to ${charId}`
            );
            return;
        }
        await storage.setJSON(storageKeys(charId).list, Array.from(this.autoRerollHrids), 'settings', true);
    }

    openConfigPopup() {
        const existing = document.getElementById('mwi-task-autoreroll-popup');
        if (existing) {
            existing.remove();
            return;
        }

        const gameData = dataManager.getInitClientData();
        if (!gameData) return;

        const items = [];
        const zoneMonsters = {};

        for (const [hrid, action] of Object.entries(gameData.actionDetailMap || {})) {
            if (action.type === '/action_types/combat') {
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

        for (const [hrid, monster] of Object.entries(gameData.combatMonsterDetailMap || {})) {
            items.push({ hrid, name: monster.name, type: 'combat' });
        }

        items.sort((a, b) => a.name.localeCompare(b.name));

        const popup = document.createElement('div');
        popup.id = 'mwi-task-autoreroll-popup';
        popup.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: ${PANEL_Z_CAP + 2};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid rgba(239, 68, 68, 0.5);
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

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            border-bottom: 1px solid rgba(239, 68, 68, 0.3);
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:#ef4444;">Auto-Reroll List</span>
            <button id="mwi-task-autoreroll-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">\u00d7</button>
        `;

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

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'flex: 1; overflow-y: auto; padding: 4px 14px;';

        const renderList = (query) => {
            const lower = query.toLowerCase();
            const filtered = query
                ? items.filter((i) => i.name.toLowerCase().includes(lower))
                : items.filter((i) => {
                      if (i.isZone) {
                          return zoneMonsters[i.hrid]?.some((m) => this.autoRerollHrids.has(m));
                      }
                      return this.autoRerollHrids.has(i.hrid);
                  });

            let html = '';
            if (!query && filtered.length === 0) {
                html =
                    '<div style="color:#666; text-align:center; padding:20px 0;">No auto-reroll tasks yet. Search to add.</div>';
            }

            for (const item of filtered.slice(0, 50)) {
                let checkmark, checkColor, nameColor, typeLabel;

                if (item.isZone) {
                    const monsters = zoneMonsters[item.hrid] || [];
                    const markedCount = monsters.filter((m) => this.autoRerollHrids.has(m)).length;
                    const allMarked = markedCount === monsters.length;
                    checkmark = allMarked ? '\u2713' : markedCount > 0 ? '~' : '';
                    checkColor = markedCount > 0 ? '#ef4444' : '#444';
                    nameColor = markedCount > 0 ? '#e0e0e0' : '#aaa';
                    typeLabel = 'Zone (' + monsters.length + ')';
                } else {
                    const isMarked = this.autoRerollHrids.has(item.hrid);
                    checkmark = isMarked ? '\u2713' : '';
                    checkColor = isMarked ? '#ef4444' : '#444';
                    nameColor = isMarked ? '#e0e0e0' : '#aaa';
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

            listContainer.querySelectorAll('[data-hrid]').forEach((row) => {
                row.addEventListener('click', async () => {
                    if (row.dataset.zone === '1') {
                        const monsters = zoneMonsters[row.dataset.hrid] || [];
                        const allMarked = monsters.every((m) => this.autoRerollHrids.has(m));
                        for (const m of monsters) {
                            if (allMarked) {
                                this.autoRerollHrids.delete(m);
                            } else {
                                this.autoRerollHrids.add(m);
                            }
                        }
                        await this._save();
                        this._processAllCards();
                    } else {
                        await this.toggleHrid(row.dataset.hrid);
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
        popup.appendChild(listContainer);
        document.body.appendChild(popup);

        renderList('');
        searchInput.focus();

        popup.querySelector('#mwi-task-autoreroll-close').addEventListener('click', () => {
            popup.remove();
            backdrop.remove();
        });

        const backdrop = document.createElement('div');
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', () => {
            popup.remove();
            backdrop.remove();
        });
        document.body.appendChild(backdrop);
    }

    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];

        // The lists are one character's. Left in place they badge the arriving
        // character's board off the departing character's blacklist until the
        // new init's read lands, and a read still in flight is stood down.
        this._generation += 1;
        this.autoRerollHrids = new Set();
        this.protectedHrids = new Set();
        this._listOwner = null;

        const cards = document.querySelectorAll('[class*="RandomTask_randomTask"]');
        for (const card of cards) {
            if (card.querySelector('.mwi-autoreroll-badge')) {
                // box-shadow is left alone — it belongs to reroll protection
                card.style.removeProperty('outline');
                card.style.removeProperty('outline-offset');
                this._clearBadge(card);
            }
        }

        this.isInitialized = false;
    }
}

const taskAutoReroll = new TaskAutoReroll();

export default {
    name: 'Task Auto-Reroll Reminder',
    initialize: async () => {
        await taskAutoReroll.initialize();
    },
    cleanup: () => {
        taskAutoReroll.disable();
    },
    disable: () => {
        try {
            taskAutoReroll.disable();
        } catch (error) {
            console.error('[Task Auto-Reroll Reminder] Disable failed part-way:', error);
        } finally {
            taskAutoReroll.isInitialized = false;
        }
    },
};

export { taskAutoReroll };
