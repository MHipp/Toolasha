/**
 * Task Reroll Cost Tracker
 * Tracks and displays reroll costs for tasks using WebSocket messages
 */

import { formatKMB } from '../../utils/formatters.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import {
    armConfirmSettleWatch,
    onConfirmFlowSettled,
    shouldSkipConfirmingCard,
    noteCardTaskDrawn,
} from './task-card-state.js';
import { GAME, TOOLASHA } from '../../utils/selectors.js';
import { createCuratedRecord, createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { addStyles } from '../../utils/dom.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/**
 * Retired tasks live alongside the live map in the same store.
 *
 * Both keys are scoped per character and resolved at each read and write, since
 * the user switches characters without reloading. The pre-scoping global values
 * are adopted by the main character: the live map is keyed by task id and the
 * history is a flat list, so neither carries anything that could tell one
 * character's rows from another's — a merged record cannot be partitioned after
 * the fact, and giving the whole of it to the main character is the closest to
 * true that is still available.
 *
 * Both are kept through persisted records (`utils/persisted-record.js`), so a
 * read that cannot be made does not come back as an empty map or list and get
 * written over the stored one. The history folds stored entries under new
 * ones by task — a task retires once — so a second tab's entries survive; the
 * live map is curated: tasks are dropped from it on purpose when they retire,
 * so once it has been read back memory is the map and a drop sticks.
 */
const DATA_KEY = 'taskRerollData';
const HISTORY_KEY = 'taskRerollHistory';
const HISTORY_CAP = 500;
const STORE_NAME = 'rerollSpending';

/** How long a task the server has just named is held back from retirement. */
const RECENT_TASK_GRACE_MS = 5 * 60 * 1000;

/**
 * Cumulative gold spent from a coin reroll count.
 * Formula: 10K, 20K, 40K, 80K, 160K, 320K (doubles, caps at 320K)
 *
 * A module-level function rather than only a method, so anything that needs
 * to price a reroll count — the badge that sums it across the board, a test —
 * can do so without an instance.
 *
 * @param {number} rerollCount - Number of gold rerolls
 * @returns {number} Total gold spent
 */
export function calculateGoldSpent(rerollCount) {
    if (rerollCount === 0) return 0;

    let total = 0;
    let cost = 10000; // Start at 10K

    for (let i = 0; i < rerollCount; i++) {
        total += cost;
        // Double the cost, but cap at 320K
        cost = Math.min(cost * 2, 320000);
    }

    return total;
}

/**
 * Cumulative cowbells spent from a cowbell reroll count.
 * Formula: 1, 2, 4, 8, 16, 32 (doubles, caps at 32)
 *
 * @param {number} rerollCount - Number of cowbell rerolls
 * @returns {number} Total cowbells spent
 */
export function calculateCowbellSpent(rerollCount) {
    if (rerollCount === 0) return 0;

    let total = 0;
    let cost = 1; // Start at 1

    for (let i = 0; i < rerollCount; i++) {
        total += cost;
        // Double the cost, but cap at 32
        cost = Math.min(cost * 2, 32);
    }

    return total;
}

/**
 * Fold a stored history under the in-memory one: the union by task, oldest
 * first, capped at {@link HISTORY_CAP}.
 * @param {Array} stored - Entries as read back
 * @param {Array} memory - Entries as held
 * @returns {Array} The merged, capped history
 */
function mergeHistory(stored, memory) {
    const merged = mergeById(
        (entry) => entry?.taskId,
        (a, b) => (a.retiredAt || 0) - (b.retiredAt || 0)
    )(stored, memory);
    return merged.length > HISTORY_CAP ? merged.slice(merged.length - HISTORY_CAP) : merged;
}

/*
 * Registered so a cross-device sync PULL combines the retired-task history
 * instead of overwriting it. The history only ever gains rows — a task retires
 * once — so the whole-key write `importEverything` would otherwise do throws
 * away every reroll the receiving device paid for and the sending one never
 * saw, which is the entire point of a spend tracker. The live map above is
 * curated (tasks are dropped from it deliberately when they retire) and stays
 * a whole-key write.
 *
 * Registration runs at import time, which is long before the earliest pull (the
 * staggered startup pull, 20s+ after load), so the registry is complete by the
 * time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE_NAME,
    base: HISTORY_KEY,
    merge: mergeHistory,
    label: 'Task reroll history',
});

class TaskRerollTracker {
    constructor() {
        this.taskRerollData = new Map(); // key: taskId, value: { coinRerollCount, cowbellRerollCount }
        this.unregisterHandlers = [];
        this.isInitialized = false;
        this.storeName = STORE_NAME;
        this.dataRecord = createCuratedRecord({
            base: DATA_KEY,
            store: STORE_NAME,
            empty: () => ({}),
            immediate: true,
            label: 'TaskRerollTracker',
        });
        this.historyRecord = createPersistedRecord({
            base: HISTORY_KEY,
            store: STORE_NAME,
            empty: () => [],
            merge: mergeHistory,
            immediate: true,
            label: 'TaskRerollTracker',
        });
        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Initialize the tracker
     */
    async initialize() {
        if (this.isInitialized) return;

        // Taken before the read, checked after it. A `character_switching`
        // teardown landing inside `loadFromStorage()` used to leave the WS
        // listeners, the DOM observers, the injected `<style>` and
        // `isInitialized = true` behind it, and the switch's own re-initialise
        // then early-returned on that flag — reroll spend went unrecorded for
        // the arriving character until the page was reloaded.
        const ticket = captureOwner(this);
        // Load saved data from IndexedDB
        await this.loadFromStorage();
        if (!stillOurs(ticket)) return;

        // Register WebSocket listener
        this.registerWebSocketListeners();

        // Register DOM observer for display updates
        this.registerDOMObservers();

        // Normalize task action area height so combat (1 compact row) and
        // non-combat (3 stat rows) cards stay the same overall height
        addStyles(`${GAME.TASK_ACTION} { min-height: 72px; }`, 'mwi-task-action-min-height');

        this.isInitialized = true;
    }

    /** @returns {Object} The live map as a plain object, for storage */
    _dataToSave() {
        const dataToSave = {};
        for (const [taskId, data] of this.taskRerollData.entries()) {
            dataToSave[taskId] = data;
        }
        return dataToSave;
    }

    /**
     * Load task reroll data from IndexedDB.
     *
     * Starts the record over — whatever it held was a previous load's — and
     * reads this character's map. When the read cannot be made the map in
     * hand stays as it is.
     */
    async loadFromStorage() {
        try {
            this.dataRecord.reset();
            this.dataRecord.set(this._dataToSave());
            const readable = await this.dataRecord.load();
            if (!readable) return;

            // Convert saved object back to Map
            for (const [taskId, data] of Object.entries(this.dataRecord.get())) {
                this.taskRerollData.set(parseInt(taskId), data);
            }
        } catch (error) {
            console.error('[Task Reroll Tracker] Failed to load from storage:', error);
        }
    }

    /**
     * Save task reroll data to IndexedDB. Skipped when storage cannot be read
     * first; the map in hand is kept and the next save retries.
     */
    async saveToStorage() {
        try {
            this.dataRecord.set(this._dataToSave());
            await this.dataRecord.save();
        } catch (error) {
            console.error('[Task Reroll Tracker] Failed to save to storage:', error);
        }
    }

    /**
     * Clean up observers and handlers
     */
    cleanup() {
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.timerRegistry.clearAll();
        // The map is one character's tasks. Cleared so the re-initialize that
        // follows a character switch loads the arriving character's rows rather
        // than writing the departing character's out under their key.
        this.taskRerollData.clear();
        this.dataRecord.reset();
        this.historyRecord.reset();
        document.getElementById('mwi-task-action-min-height')?.remove();
        this.isInitialized = false;
    }

    disable() {
        noteTeardown(this);
        try {
            this.cleanup();
        } catch (error) {
            console.error('[Task Reroll Tracker] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Load the reroll history — the tasks that have already left the board.
     * @returns {Promise<Array<Object>>} History entries, oldest first
     */
    async loadHistory() {
        try {
            // Folds the stored history under any entries held since a read
            // that could not be made; an unreadable read keeps those
            await this.historyRecord.load();
            const held = this.historyRecord.get();
            return Array.isArray(held) ? held : [];
        } catch (error) {
            console.error('[Task Reroll Tracker] Failed to load reroll history:', error);
            return [];
        }
    }

    /**
     * Append retired tasks to the reroll history.
     *
     * A task that completes or is discarded is the only moment its reroll spend
     * can ever be set against what it paid out, and the live map is about to
     * drop it. The history is capped so it cannot grow without bound.
     *
     * @param {Array<Object>} entries - Retired task records
     * @private
     */
    async appendToHistory(entries) {
        if (!entries.length) return;

        try {
            // The save re-reads and folds the stored history under these, capped,
            // so nothing another tab retired is lost; it is skipped — the entries
            // kept in hand for the next one — when storage cannot be read first
            await this.historyRecord.update((history) => {
                history.push(...entries);
                return mergeHistory([], history);
            });
        } catch (error) {
            console.error('[Task Reroll Tracker] Failed to append reroll history:', error);
        }
    }

    /**
     * Clean up old task data that's no longer active
     * Keeps only tasks that are currently in characterQuests; everything it
     * drops is written to the history first so the spend stays analysable.
     */
    cleanupOldTasks() {
        // `dataManager.characterQuests` is the live list — the claimed-quest
        // filter rebinds it to a NEW array, and `characterData.characterQuests`
        // keeps pointing at the array as it stood when the character loaded.
        // Reading the frozen snapshot made every task drawn after the first
        // claim look retired: bogus history rows, live tasks dropped from the
        // map, and the spend summed into the statistics tiles.
        const activeQuests = dataManager.characterQuests;
        if (!Array.isArray(activeQuests)) {
            return;
        }

        const activeTaskIds = new Set(activeQuests.map((quest) => quest.id));

        const retired = [];
        const retiredAt = Date.now();

        // Remove tasks that are no longer active
        for (const [taskId, taskData] of this.taskRerollData.entries()) {
            if (activeTaskIds.has(taskId)) continue;
            // A task the server named moments ago is live whatever this list
            // says: cleanup can run from the same message that introduced it,
            // before the data manager has folded it in.
            if (taskData.seenAt && retiredAt - taskData.seenAt < RECENT_TASK_GRACE_MS) continue;

            retired.push({
                taskId,
                retiredAt,
                coinRerollCount: taskData.coinRerollCount || 0,
                cowbellRerollCount: taskData.cowbellRerollCount || 0,
                goldSpent: this.calculateGoldSpent(taskData.coinRerollCount || 0),
                cowbellsSpent: this.calculateCowbellSpent(taskData.cowbellRerollCount || 0),
                monsterHrid: taskData.monsterHrid || '',
                actionHrid: taskData.actionHrid || '',
                goalCount: taskData.goalCount || 0,
            });
            this.taskRerollData.delete(taskId);
        }

        if (retired.length > 0) {
            this.appendToHistory(retired);
            this.saveToStorage();
        }
    }

    /**
     * Register WebSocket message listeners
     */
    registerWebSocketListeners() {
        const questsHandler = (data) => {
            if (!data.endCharacterQuests) {
                return;
            }

            let hasChanges = false;

            // Update our task reroll data from server data
            const seenAt = Date.now();
            for (const quest of data.endCharacterQuests) {
                const existingData = this.taskRerollData.get(quest.id);
                const newCoinCount = quest.coinRerollCount || 0;
                const newCowbellCount = quest.cowbellRerollCount || 0;

                // Only update if counts increased or task is new
                if (
                    !existingData ||
                    newCoinCount > existingData.coinRerollCount ||
                    newCowbellCount > existingData.cowbellRerollCount
                ) {
                    this.taskRerollData.set(quest.id, {
                        coinRerollCount: Math.max(existingData?.coinRerollCount || 0, newCoinCount),
                        cowbellRerollCount: Math.max(existingData?.cowbellRerollCount || 0, newCowbellCount),
                        monsterHrid: quest.monsterHrid || '',
                        actionHrid: quest.actionHrid || '',
                        goalCount: quest.goalCount || 0,
                        seenAt,
                    });
                    hasChanges = true;
                } else {
                    // Not a change worth a write, but it is proof the task is live
                    existingData.seenAt = seenAt;
                }
            }

            // Save to storage if data changed
            if (hasChanges) {
                this.saveToStorage();
            }

            // Clean up old tasks periodically (every 10th update)
            if (Math.random() < 0.1) {
                this.cleanupOldTasks();
            }

            // Wait for game to update DOM before updating displays
            const updateTimeout = setTimeout(() => {
                this.updateAllTaskDisplays();
            }, 250);
            this.timerRegistry.registerTimeout(updateTimeout);
        };

        webSocketHook.on('quests_updated', questsHandler);

        this.unregisterHandlers.push(() => {
            webSocketHook.off('quests_updated', questsHandler);
        });

        // Load existing quest data from DataManager (which receives init_character_data early)
        const initHandler = (data) => {
            if (!data.characterQuests) {
                return;
            }

            let hasChanges = false;

            // Load all quest data into the map
            const seenAt = Date.now();
            for (const quest of data.characterQuests) {
                const existingData = this.taskRerollData.get(quest.id);
                const newCoinCount = quest.coinRerollCount || 0;
                const newCowbellCount = quest.cowbellRerollCount || 0;

                // Only update if counts increased or task is new
                if (
                    !existingData ||
                    newCoinCount > existingData.coinRerollCount ||
                    newCowbellCount > existingData.cowbellRerollCount
                ) {
                    this.taskRerollData.set(quest.id, {
                        coinRerollCount: Math.max(existingData?.coinRerollCount || 0, newCoinCount),
                        cowbellRerollCount: Math.max(existingData?.cowbellRerollCount || 0, newCowbellCount),
                        monsterHrid: quest.monsterHrid || '',
                        actionHrid: quest.actionHrid || '',
                        goalCount: quest.goalCount || 0,
                        seenAt,
                    });
                    hasChanges = true;
                } else {
                    existingData.seenAt = seenAt;
                }
            }

            // Save to storage if data changed
            if (hasChanges) {
                this.saveToStorage();
            }

            // Clean up old tasks after loading character data
            this.cleanupOldTasks();

            // Wait for DOM to be ready before updating displays
            const initTimeout = setTimeout(() => {
                this.updateAllTaskDisplays();
            }, 500);
            this.timerRegistry.registerTimeout(initTimeout);
        };

        dataManager.on('character_initialized', initHandler);

        // Check if character data already loaded (in case we missed the event)
        if (dataManager.characterData && dataManager.characterData.characterQuests) {
            initHandler(dataManager.characterData);
        }

        this.unregisterHandlers.push(() => {
            dataManager.off('character_initialized', initHandler);
        });
    }

    /**
     * Register DOM observers for display updates
     */
    registerDOMObservers() {
        // Watch for task list appearing
        const unregisterTaskList = domObserver.onClass('TaskRerollTracker-TaskList', 'TasksPanel_taskList', () => {
            this.updateAllTaskDisplays();
        });
        this.unregisterHandlers.push(unregisterTaskList);

        // Watch for individual tasks appearing
        const unregisterTask = domObserver.onClass('TaskRerollTracker-Task', 'RandomTask_randomTask', () => {
            // Small delay to let task data settle
            const taskTimeout = setTimeout(() => this.updateAllTaskDisplays(), 100);
            this.timerRegistry.registerTimeout(taskTimeout);
        });
        this.unregisterHandlers.push(unregisterTask);

        // Closing a reroll chooser adds an action row, not a card, so no
        // observer above ever fires for it — this is the only thing that runs
        // the pass the mid-flow skip turned down
        this.unregisterHandlers.push(onConfirmFlowSettled(() => this.updateAllTaskDisplays()));
    }

    /**
     * Calculate cumulative gold spent from coin reroll count
     * @param {number} rerollCount - Number of gold rerolls
     * @returns {number} Total gold spent
     */
    calculateGoldSpent(rerollCount) {
        return calculateGoldSpent(rerollCount);
    }

    /**
     * Calculate cumulative cowbells spent from cowbell reroll count
     * @param {number} rerollCount - Number of cowbell rerolls
     * @returns {number} Total cowbells spent
     */
    calculateCowbellSpent(rerollCount) {
        return calculateCowbellSpent(rerollCount);
    }

    /**
     * Get task ID from DOM element by matching task description
     * @param {Element} taskElement - Task DOM element
     * @param {Set<number>} [claimedIds] - Task IDs already matched to other DOM elements this pass
     * @returns {number|null} Task ID or null if not found
     */
    getTaskIdFromElement(taskElement, claimedIds) {
        // Get task description and goal count from DOM
        const nameEl = taskElement.querySelector(GAME.TASK_NAME);
        const description = nameEl ? nameEl.textContent.trim() : '';

        if (!description) {
            return null;
        }

        // Get quantity from progress text
        const progressDivs = taskElement.querySelectorAll('div');
        let goalCount = 0;
        for (const div of progressDivs) {
            const text = div.textContent.trim();
            if (text.startsWith('Progress:')) {
                const match = text.match(/Progress:\s*\d+\s*\/\s*(\d+)/);
                if (match) {
                    goalCount = parseInt(match[1]);
                    break;
                }
            }
        }

        // Match against stored task data
        for (const [taskId, taskData] of this.taskRerollData.entries()) {
            // Check if goal count matches
            if (taskData.goalCount !== goalCount) continue;

            // Extract monster/action name from description
            // Description format: "Kill X" or "Do action X times"
            const descLower = description.toLowerCase();

            // Skip if already matched to another DOM element this pass
            if (claimedIds?.has(taskId)) continue;

            // For monster tasks, check monsterHrid
            if (taskData.monsterHrid) {
                const gameData = dataManager.getInitClientData();
                const monsterDetail = gameData?.combatMonsterDetailMap?.[taskData.monsterHrid];
                const monsterName =
                    monsterDetail?.name || taskData.monsterHrid.replace('/monsters/', '').replace(/_/g, ' ');
                if (descLower.includes(monsterName.toLowerCase())) {
                    claimedIds?.add(taskId);
                    return taskId;
                }
            }

            // For action tasks, check actionHrid
            if (taskData.actionHrid) {
                const actionParts = taskData.actionHrid.split('/');
                const actionName = actionParts[actionParts.length - 1].replace(/_/g, ' ');
                if (descLower.includes(actionName.toLowerCase())) {
                    claimedIds?.add(taskId);
                    return taskId;
                }
            }
        }

        return null;
    }

    /**
     * Update display for a specific task
     * @param {Element} taskElement - Task DOM element
     * @param {Set<number>} [claimedIds] - Task IDs already matched to other DOM elements this pass
     */
    updateTaskDisplay(taskElement, claimedIds) {
        // A card showing the reroll chooser or the discard confirmation is
        // waiting on the player's second click; inserting the spend line into
        // it now rebuilds the card under that click. The one exception is a card
        // whose task has changed since the line was drawn — paying for a reroll
        // leaves the chooser open over a brand new task — because the spend line
        // would otherwise report the previous task's rerolls until Back is
        // pressed.
        if (shouldSkipConfirmingCard(taskElement, 'rerollSpend')) {
            armConfirmSettleWatch();
            return;
        }
        noteCardTaskDrawn(taskElement, 'rerollSpend');

        // Always ensure placeholder element exists to reserve layout space,
        // regardless of whether this task has been rerolled yet
        let displayElement = taskElement.querySelector(TOOLASHA.REROLL_COST_DISPLAY);
        if (!displayElement) {
            displayElement = document.createElement('div');
            displayElement.className = 'mwi-reroll-cost-display';
            displayElement.style.cssText = `
                color: ${config.COLOR_TEXT_SECONDARY};
                font-size: 0.75rem;
                margin-top: 4px;
                padding: 2px 4px;
                border-radius: 3px;
                background: rgba(0, 0, 0, 0.3);
                visibility: hidden;
            `;
            displayElement.textContent = 'Reroll spent: –';

            const taskContent = taskElement.querySelector(GAME.TASK_CONTENT);
            if (taskContent) {
                taskContent.insertBefore(displayElement, taskContent.firstChild);
            } else {
                taskElement.insertBefore(displayElement, taskElement.firstChild);
            }
        }

        const taskId = this.getTaskIdFromElement(taskElement, claimedIds);
        if (!taskId) {
            return;
        }

        const taskData = this.taskRerollData.get(taskId);
        if (!taskData) {
            displayElement.style.visibility = 'hidden';
            return;
        }

        // Calculate totals
        const goldSpent = this.calculateGoldSpent(taskData.coinRerollCount);
        const cowbellSpent = this.calculateCowbellSpent(taskData.cowbellRerollCount);

        // Format display text
        const parts = [];
        if (cowbellSpent > 0) {
            parts.push(`${cowbellSpent}🔔`);
        }
        if (goldSpent > 0) {
            parts.push(`${formatKMB(goldSpent)}💰`);
        }

        if (parts.length > 0) {
            displayElement.textContent = `Reroll spent: ${parts.join(' + ')}`;
            displayElement.style.visibility = 'visible';
        } else {
            displayElement.style.visibility = 'hidden';
        }
    }

    /**
     * Update all task displays
     */
    updateAllTaskDisplays() {
        const allTasks = document.querySelectorAll(GAME.TASK_CARD);
        if (allTasks.length === 0) {
            return;
        }

        const claimedIds = new Set();
        allTasks.forEach((task) => {
            this.updateTaskDisplay(task, claimedIds);
        });
    }
}

const taskRerollTracker = new TaskRerollTracker();

export default taskRerollTracker;
