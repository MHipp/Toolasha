/**
 * Reroll Spend Badge
 *
 * The reroll tracker already prices every task's own rerolls onto its card
 * (`task-reroll-tracker.js`'s "Reroll spent: …" line), and the Statistics
 * popup totals it for the whole board — but only once you open it. This sums
 * the same figures across the tasks currently in progress and shows the total
 * next to the task slot count, so the board's sunk reroll cost is visible at a
 * glance.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import taskRerollTracker, { calculateGoldSpent, calculateCowbellSpent } from './task-reroll-tracker.js';
import { formatKMB } from '../../utils/formatters.js';
import { GAME, TOOLASHA } from '../../utils/selectors.js';

const TASK_CATEGORY = '/quest_category/random_task';
const STATUS_IN_PROGRESS = '/quest_status/in_progress';

/**
 * The random tasks currently on the board.
 *
 * The quest objects themselves rather than their ids: each carries the
 * server's own `coinRerollCount`/`cowbellRerollCount`, which is the fallback
 * `sumBoardRerollSpend` needs for a task the tracker has not loaded yet.
 *
 * @returns {Array<Object>} Active random-task quests
 */
function activeTasks() {
    const quests = Array.isArray(dataManager.characterQuests) ? dataManager.characterQuests : [];
    return quests.filter((quest) => quest?.category === TASK_CATEGORY && quest?.status === STATUS_IN_PROGRESS);
}

/**
 * Sum the reroll spend across the tasks currently in progress.
 *
 * Driven from the board rather than from the map: the map keeps a
 * just-retired task for a short grace window (see `task-reroll-tracker.js`),
 * and a badge that briefly counted a task that has already left the board
 * would disagree with the per-card lines it is meant to be summing.
 *
 * Walking the quests also buys the fallback. The tracker loads its map from
 * storage behind an await, and the badge draws from a catch-up pass that
 * fires the moment it initializes - a board read before that load lands has
 * no tracked entries at all, and summing the map alone renders it as "spent
 * nothing" until the next task-list mutation. `quest.coinRerollCount` off the
 * server payload is the same figure, so fall back to it, exactly as the
 * sibling reader in task-statistics.js `calculateRerollSpend` does.
 *
 * `??` and not `||`: a tracked zero and an untracked task are different
 * things. A task the tracker knows about with no rerolls on it must stay
 * zero, not silently re-read the payload - the tracker's count is the
 * authority once it has one, and it can legitimately be 0.
 *
 * @param {Map<number, {coinRerollCount?: number, cowbellRerollCount?: number}>} taskRerollData
 * @param {Array<{id: number, coinRerollCount?: number, cowbellRerollCount?: number}>} activeQuests -
 *     Random-task quests currently in progress
 * @returns {{gold: number, cowbells: number}}
 */
export function sumBoardRerollSpend(taskRerollData, activeQuests) {
    let gold = 0;
    let cowbells = 0;
    if (!Array.isArray(activeQuests)) return { gold, cowbells };

    for (const quest of activeQuests) {
        if (!quest) continue;
        const tracked = taskRerollData?.get(quest.id);
        const coinCount = tracked?.coinRerollCount ?? quest.coinRerollCount ?? 0;
        const cowbellCount = tracked?.cowbellRerollCount ?? quest.cowbellRerollCount ?? 0;
        gold += calculateGoldSpent(coinCount);
        cowbells += calculateCowbellSpent(cowbellCount);
    }
    return { gold, cowbells };
}

/**
 * The badge text for a spend total, or '' once there is nothing to show.
 * @param {{gold: number, cowbells: number}} spend
 * @returns {string} Plain text, no leading/trailing whitespace
 */
export function formatRerollSpendBadge({ gold, cowbells } = {}) {
    const parts = [];
    if (cowbells > 0) parts.push(`${cowbells}\u{1f514}`);
    if (gold > 0) parts.push(`${formatKMB(gold)}\u{1f4b0}`);
    return parts.length ? `Rerolls: ${parts.join(' + ')}` : '';
}

class TaskRerollBadge {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.mutationObserver = null;
        this.badge = null;
    }

    setupSettingListener() {
        config.onSettingChange('taskRerollSpendBadge', (enabled) => {
            if (enabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    initialize() {
        if (!config.getSetting('taskRerollSpendBadge')) return;
        if (this.isInitialized) return;
        this.isInitialized = true;

        const unregister = domObserver.onClass('TaskRerollBadge', 'TasksPanel_taskSlotCount', (headerElement) =>
            this._onHeaderAppeared(headerElement)
        );
        this.unregisterHandlers.push(unregister);

        // The observer only reports elements that *appear*; it does not scan
        // what is already on the page (dom-observer.js `_add`). Ticking the
        // setting on with the Tasks panel open is therefore an initialize()
        // that draws nothing, and the badge stays missing until the panel is
        // navigated away from and back. Same immediate pass task-statistics.js
        // makes for the same reason. @run-at document-start the pass waits for
        // the shared observer's actual-ready signal (immediate if attached).
        this.unregisterHandlers.push(
            domObserver.onReady('TaskRerollBadgeCatchUp', () => {
                const header = document.querySelector(GAME.TASK_PANEL);
                if (header) this._onHeaderAppeared(header);
            })
        );
    }

    _onHeaderAppeared(headerElement) {
        this._ensureBadge(headerElement);
        this._render();

        const taskList = document.querySelector(GAME.TASK_LIST);
        if (!taskList) return;

        if (this.mutationObserver) this.mutationObserver.disconnect();
        this.mutationObserver = new MutationObserver(() => this._render());
        this.mutationObserver.observe(taskList, { childList: true, subtree: true, characterData: true });
    }

    _ensureBadge(headerElement) {
        const existing = headerElement.querySelector(TOOLASHA.TASK_REROLL_SPEND_BADGE);
        if (existing) {
            this.badge = existing;
            return;
        }

        this.badge = document.createElement('span');
        this.badge.className = 'toolasha-reroll-spend-badge';
        this.badge.style.cssText = `
            margin-left: 12px;
            font-size: 0.8rem;
            color: ${config.COLOR_LOSS};
        `;
        headerElement.appendChild(this.badge);
    }

    _render() {
        if (!this.badge || !this.badge.isConnected) return;

        const spend = sumBoardRerollSpend(taskRerollTracker.taskRerollData, activeTasks());
        const text = formatRerollSpendBadge(spend);
        // Write-level diff: the observer fires for every task-list mutation —
        // progress counts ticking up during combat included — and rewriting an
        // identical string still replaces the text node each time
        if (this.badge.textContent !== text) this.badge.textContent = text;
        const display = text ? '' : 'none';
        if (this.badge.style.display !== display) this.badge.style.display = display;
    }

    disable() {
        try {
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
                this.mutationObserver = null;
            }

            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];

            if (this.badge) {
                this.badge.remove();
                this.badge = null;
            }

            this.isInitialized = false;
        } catch (error) {
            console.error('[Task Reroll Badge] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const taskRerollBadge = new TaskRerollBadge();

taskRerollBadge.setupSettingListener();

export default taskRerollBadge;
