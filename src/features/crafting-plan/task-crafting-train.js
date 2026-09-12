/**
 * Several tasks, one crafting walk.
 *
 * Two tasks that both end in leather goods do not need two walks. They share the
 * tanning, and often the hide underneath it: walked separately the player queues
 * the same intermediate twice, at two half-counts, with the second run's
 * materials bought as if the first had never happened. Walked together the shared
 * legs are crafted once, at the summed count, and only the tasks' own final
 * actions differ. Adapted from MWITools taskTrainPlanner, CC-BY-NC-SA-4.0, see
 * third-party/mwitools/.
 *
 * MWITools buckets tasks by the root of a strictly linear upgrade chain. A
 * Toolasha plan is a tree from `computeBestCraftingPlan` — several inputs per
 * node, buy-vs-craft decided per leg — so there is no single root to bucket on.
 * The equivalent here is to plan each task's target on its own and merge the
 * resulting step lists on the step key, which is exactly the merge
 * {@link buildWalkSteps} already performs inside one plan, lifted across plans.
 *
 * The walk itself is untouched: it takes a step list, and a merged list is still
 * a step list. Nothing here presses a game button either.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { computeBestCraftingPlan, collectMissingMaterials } from './crafting-plan-calculator.js';
import craftingPlanWalk, { buildWalkSteps, walkStepFor } from './crafting-plan-walk.js';
import { questForTaskCard } from '../tasks/task-card-quest.js';
import { effectiveInventoryRows, release, releaseMissing, reserve } from '../../utils/inventory-reservations.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { GAME } from '../../utils/selectors.js';

/** Action types whose tasks have a crafting chain worth walking */
const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

const BUTTON_ID = 'mwi-task-train-button';
const PANEL_ID = 'mwi-task-train-panel';
const PROGRESS_PATTERN = /(\d+)\s*\/\s*(\d+)/;

/**
 * How often to check whether the walk this module is tracking is still the
 * one running.
 *
 * `craftingPlanWalk` never announces that it stopped — completion, Stop, the
 * idle timeout and a character switch all end it the same way, by clearing
 * `active` and dropping whatever hook was installed — so nothing calls this
 * module back when that happens. A short poll is what notices instead; it is
 * a handful of property reads, not a replan, so a five-second grain costs
 * nothing and still drops a finished walk's claim well within the TTL that
 * used to be the only thing that ever did.
 */
export const LIVE_CHECK_INTERVAL_MS = 5000;

/**
 * Owner-id prefix for a merged walk's claim on the bag.
 *
 * Its own prefix rather than the panel plan's `craftingPlan:`: an owner id is
 * replaced wholesale by the next `reserve()` under it, so sharing the prefix
 * would let a merged walk and a panel plan for the same item silently overwrite
 * one another's claim instead of each seeing the other's as taken.
 */
const RESERVATION_OWNER_PREFIX = 'taskWalk:';

/**
 * The single owner id a merged walk claims under.
 *
 * One owner for the whole walk, not one per task. A shared material is exactly
 * the material two tasks would each claim in full, and two owners claiming it
 * would reserve it twice over — double-counting the very stock the merge exists
 * to spend once. The merged requirement is computed once, from one tree, against
 * one inventory, so each shared material is claimed once by construction. It is
 * also one lifetime: the walk is one object, so there is one claim to refresh as
 * steps land and one for the ledger's TTL to expire.
 *
 * @param {Array<string>} itemHrids - The targets the walk covers
 * @returns {string} Owner id
 */
export function mergedWalkOwner(itemHrids) {
    return `${RESERVATION_OWNER_PREFIX}${[...itemHrids].sort().join('+')}`;
}

/**
 * Merge several plans' walks into one step list in a valid dependency order.
 *
 * Concatenating the per-plan lists and dropping repeats does not work: each list
 * is only ordered against itself, so a step one plan reaches late can land after
 * a step the other plan has consuming it. (A: buy hide, craft leather, craft hat.
 * B: buy hide, buy dye, craft leather, craft boots. Concatenated and deduped, the
 * dye arrives after the leather that has already been crafted.)
 *
 * So the order is rebuilt rather than spliced. Every plan contributes edges
 * `child → nearest emitted ancestor` — the ancestor rather than the parent
 * because a node the plan emits no step for (a coin, a zero leg) must not break
 * the chain from its children to whatever does consume them — and the merged
 * list is a topological order of that union. A step therefore precedes every step
 * that consumes it *in any plan*, which is the property the merge needs and the
 * one concatenation loses. Among steps that are ready at the same time the
 * earliest first appearance wins, so the result stays deterministic and as close
 * to the per-plan post-order as the constraints allow.
 *
 * Recipes are acyclic, but two plans' edges are only checked for cycles together:
 * a pair of recipes consuming each other passes each plan's own guard and meets
 * only here. Such a set has no valid order at all, so it is refused rather than
 * ordered wrongly.
 *
 * @param {Array<Object>} plans - Root `CraftingPlanNode`s, one per task
 * @returns {{steps: Array<Object>, saved: number}|null} The merged walk and how many
 *   steps the merge removed, or null when no valid order exists
 */
export function mergeWalkSteps(plans) {
    const merged = new Map(); // key → step
    const firstSeen = new Map(); // key → position in the concatenated post-orders
    const consumers = new Map(); // key → keys that must come after it
    const indegree = new Map(); // key → how many steps must come before it
    let separateStepCount = 0;

    const addEdge = (from, to) => {
        if (!from || !to || from === to) return;
        let after = consumers.get(from);
        if (!after) consumers.set(from, (after = new Set()));
        if (after.has(to)) return;
        after.add(to);
        indegree.set(to, (indegree.get(to) || 0) + 1);
    };

    for (const plan of plans || []) {
        if (!plan) continue;

        for (const step of buildWalkSteps(plan)) {
            separateStepCount += 1;
            const existing = merged.get(step.key);
            if (existing) {
                existing.count += step.count;
                existing.actions += step.actions;
                continue;
            }
            merged.set(step.key, { ...step });
            firstSeen.set(step.key, firstSeen.size);
            if (!indegree.has(step.key)) indegree.set(step.key, 0);
        }

        (function collectEdges(node, consumerKey) {
            if (!node) return;
            const key = walkStepFor(node)?.key || null;
            for (const child of node.children || []) collectEdges(child, key || consumerKey);
            addEdge(key, consumerKey);
        })(plan, null);
    }

    if (merged.size === 0) return null;

    const ready = [...merged.keys()].filter((key) => !indegree.get(key));
    const steps = [];
    while (ready.length > 0) {
        let pick = 0;
        for (let i = 1; i < ready.length; i++) {
            if (firstSeen.get(ready[i]) < firstSeen.get(ready[pick])) pick = i;
        }
        const key = ready.splice(pick, 1)[0];
        steps.push(merged.get(key));
        for (const next of consumers.get(key) || []) {
            const remaining = indegree.get(next) - 1;
            indegree.set(next, remaining);
            if (remaining === 0) ready.push(next);
        }
    }

    if (steps.length !== merged.size) return null; // a cycle across plans
    return { steps, saved: separateStepCount - steps.length };
}

/**
 * The plan for one task's target, or null when the task has no chain to walk.
 *
 * A task is counted in actions, not in units, so the plan is sized at the
 * remaining actions times the recipe's own output count — the same arithmetic
 * the action panel does for its count box. The root is forced to craft: a task
 * is only discharged by performing its action, so a plan that decided to buy the
 * output instead would be answering a question nobody asked.
 *
 * @param {string} actionHrid - The task's action
 * @param {number} actions - Actions still owed
 * @returns {Object|null} Root plan node, or null
 */
function planForTaskAction(actionHrid, actions) {
    if (!actionHrid || !(actions > 0)) return null;

    const detail = dataManager.getActionDetails(actionHrid);
    if (!detail || !PRODUCTION_TYPES.includes(detail.type)) return null;
    const output = detail.outputItems?.[0];
    if (!output?.itemHrid) return null;

    const timeCostEnabled = config.getSetting('actionPanel_craftingPlanTimeCost');
    let plan;
    try {
        plan = computeBestCraftingPlan(
            output.itemHrid,
            actions * (output.count || 1),
            config.getSetting('profitCalc_pricingMode') || 'ask',
            new Set(),
            new Map(),
            0,
            undefined,
            config.getSetting('actionPanel_craftingPlanBuyIntermediates'),
            true,
            timeCostEnabled ? config.getSetting('actionPanel_craftingPlanGoldPerHour') || 0 : 0,
            config.getSetting('actionPanel_craftingPlanNoProcessing'),
            config.getSetting('actionPanel_craftingPlanThinMarket')
        );
    } catch (error) {
        console.error('[TaskTrain] computeBestCraftingPlan error:', error);
        return null;
    }

    // No chain under it is nothing to share: a target whose materials are all
    // bought has one craft step, its own, and merging it with anything saves
    // nothing the two walks would not each have done anyway.
    if (plan.strategy !== 'craft' || !plan.children?.length) return null;
    return plan;
}

/**
 * Plan every task that has a chain, and drop the ones that do not.
 *
 * @param {Array<{actionHrid: string, quantity: number, label?: string}>} targets - Tasks
 * @param {Object} [options]
 * @param {Function} [options.planFor] - `(actionHrid, actions) => plan|null`, injectable for tests
 * @returns {Array<{target: Object, plan: Object, steps: Array<Object>, craftKeys: Set<string>}>}
 */
export function planTaskTargets(targets, { planFor = planForTaskAction } = {}) {
    const planned = [];
    for (const target of targets || []) {
        const plan = planFor(target.actionHrid, target.quantity);
        if (!plan) continue;
        const steps = buildWalkSteps(plan);
        if (steps.length === 0) continue;
        planned.push({
            target,
            plan,
            steps,
            craftKeys: new Set(steps.filter((step) => step.kind === 'craft').map((step) => step.key)),
        });
    }
    return planned;
}

/**
 * Which planned tasks are worth walking together.
 *
 * The threshold is one shared **craft** step, and nothing weaker. A shared craft
 * step is shared work: the intermediate is queued once at the summed count
 * instead of twice at two half-counts, and every leg beneath it is bought once.
 * A shared *buy* step is not — two unrelated tasks routinely both want coins'
 * worth of some common raw material, and merging on that saves one trip to the
 * marketplace while still walking both chains end to end. Merging on it would
 * offer a "train" to tasks that have no chain in common, which is a longer walk
 * pretending to be a shorter one.
 *
 * Tasks are grouped by connected component over that relation rather than
 * greedily absorbed into the deepest task, so the grouping does not depend on
 * which task the board happens to list first. A component's members are merged
 * as one walk even where two of them share nothing directly: each still shares
 * with something in between, and the merged tree serves all of them at once.
 *
 * @param {Array<Object>} planned - From {@link planTaskTargets}
 * @returns {Array<{tasks: Array<Object>, steps: Array<Object>, saved: number}>} Largest first
 */
export function groupTasksBySharedChain(planned) {
    const rows = planned || [];
    const parent = rows.map((_, index) => index);
    const find = (start) => {
        let root = start;
        while (parent[root] !== root) root = parent[root];
        let node = start;
        while (parent[node] !== root) {
            const next = parent[node];
            parent[node] = root;
            node = next;
        }
        return root;
    };

    const owner = new Map(); // craft key → the first task that has it
    for (let i = 0; i < rows.length; i++) {
        for (const key of rows[i].craftKeys) {
            const seen = owner.get(key);
            if (seen === undefined) owner.set(key, i);
            else parent[find(i)] = find(seen);
        }
    }

    const members = new Map();
    for (let i = 0; i < rows.length; i++) {
        const root = find(i);
        if (!members.has(root)) members.set(root, []);
        members.get(root).push(rows[i]);
    }

    const groups = [];
    for (const tasks of members.values()) {
        if (tasks.length < 2) continue;
        const merged = mergeWalkSteps(tasks.map((task) => task.plan));
        if (!merged || merged.saved <= 0) continue;
        groups.push({ tasks, steps: merged.steps, saved: merged.saved });
    }

    groups.sort((a, b) => b.tasks.length - a.tasks.length || b.saved - a.saved);
    return groups;
}

/**
 * What a merged walk must still buy, counted once across every task in it.
 *
 * Asking `collectMissingMaterials` per plan and adding the answers would credit
 * the same bag to each plan in turn, so a material two tasks share would read as
 * covered twice over. One tree instead: a pass-through root whose children are
 * the task plans, each re-rooted at zero quantity. Zero is what marks a node as
 * carrying no scale of its own, which is precisely what these are — the task
 * roots' own quantities are already absolute, and re-crediting them against the
 * bag would let held copies of a task's output shrink a run the task counts in
 * actions and does not care what the player owns.
 *
 * @param {Array<Object>} plans - Root plan nodes, one per task
 * @returns {Object} A plan node `collectMissingMaterials` can walk
 */
export function mergedMissingRoot(plans) {
    return {
        itemHrid: null,
        itemName: '',
        quantity: 0,
        strategy: 'craft',
        actionHrid: null,
        actionsNeeded: 0,
        outputCount: 0,
        children: (plans || []).map((plan) => ({ ...plan, quantity: 0 })),
    };
}

/**
 * The reservation lines one merged walk claims.
 * @param {Array<Object>} plans - Root plan nodes
 * @param {string} ownerId - The walk's own owner, whose claim it never counts against itself
 * @returns {Array<{itemHrid: string, count: number}>} Lines for `reserve()`
 */
export function mergedMissingLines(plans, ownerId) {
    const inventory = effectiveInventoryRows(dataManager.getInventory() || [], { excludeOwner: ownerId });
    return collectMissingMaterials(mergedMissingRoot(plans), inventory)
        .filter((material) => material.isTradeable)
        .map((material) => ({ itemHrid: material.itemHrid, count: material.required }));
}

/** How many of a task's actions are still owed, read off the card. */
function remainingActions(card) {
    for (const div of card.querySelectorAll('div')) {
        const text = div.textContent.trim();
        if (!text.startsWith('Progress:')) continue;
        const match = text.match(PROGRESS_PATTERN);
        if (!match) return 0;
        return Math.max(parseInt(match[2], 10) - parseInt(match[1], 10), 0);
    }
    return 0;
}

/**
 * The board's non-combat tasks, as targets.
 *
 * The action comes from the card's own `characterQuest` rather than from its
 * description: the description has to be matched back to an action by name, and
 * the quest names the hrid outright. A combat card carries a `monsterHrid`
 * instead and so drops out on its own.
 *
 * @returns {Array<{actionHrid: string, quantity: number, label: string}>}
 */
function readTaskTargets() {
    const list = document.querySelector(GAME.TASK_LIST);
    if (!list) return [];

    const targets = [];
    for (const card of list.querySelectorAll(GAME.TASK_CARD)) {
        const actionHrid = questForTaskCard(card)?.actionHrid;
        if (!actionHrid) continue;
        const quantity = remainingActions(card);
        if (quantity <= 0) continue;
        targets.push({
            actionHrid,
            quantity,
            label: card.querySelector(GAME.TASK_NAME_DIV)?.textContent.trim() || actionHrid,
        });
    }
    return targets;
}

class TaskCraftingTrain {
    constructor() {
        this.isInitialized = false;
        this.unregisterObserver = null;
        /**
         * The hook this module last installed on the shared walk, so `disable()`
         * can take it off again without stealing one the action panel's plan
         * installed after it — the walk holds exactly one.
         */
        this.stepHook = null;
        /**
         * The `taskWalk:` owner this module is currently claiming for, or null.
         * What {@link _releaseCurrentWalk} releases and what the liveness check
         * below decides whether to keep.
         */
        this.currentOwnerId = null;
        this.timerRegistry = createTimerRegistry();
    }

    /** Put the button on the task panel header, and make sure the walk is listening. */
    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('tasks_mergedCraftingWalk')) return;
        this.isInitialized = true;

        // The walk is shared with the action panel, and idempotent; the task
        // board may well be the only surface that wants it running.
        craftingPlanWalk.initialize();

        // Nothing of this module's is walking yet — this drops every
        // `taskWalk:` owner in the ledger, which is what clears the backlog a
        // player is already carrying from a walk that ended (finished,
        // abandoned, the browser closed on it) without this module having had
        // a chance to notice and release it itself.
        releaseMissing(RESERVATION_OWNER_PREFIX, []).catch((error) =>
            console.error('[TaskTrain] Releasing stale walk claims failed:', error)
        );

        this.unregisterObserver = domObserver.onClass('TaskCraftingTrain', 'TasksPanel_taskSlotCount', (header) =>
            this._addButton(header)
        );

        this.timerRegistry.registerInterval(
            setInterval(() => this._checkWalkLive(), LIVE_CHECK_INTERVAL_MS),
            'TaskCraftingTrain.checkWalkLive'
        );
    }

    /**
     * Whether the walk this module claimed for is the one currently running.
     *
     * `craftingPlanWalk` is a singleton three surfaces share, and
     * `onStepAboutToRun` holds exactly one hook at a time — installed
     * immediately before `start()` and dropped by `stop()`, whatever ends the
     * walk. So this module's hook is still installed if and only if its walk
     * is still the one in progress: superseded by another walk, or the walk
     * simply ending, clears it, and this stops matching.
     * @returns {boolean}
     * @private
     */
    _walkIsLive() {
        return Boolean(
            this.currentOwnerId &&
            this.stepHook &&
            craftingPlanWalk.active &&
            craftingPlanWalk.onStepAboutToRun === this.stepHook
        );
    }

    /** Drop the tracked claim once its walk is no longer the one running. @private */
    _checkWalkLive() {
        if (this.currentOwnerId && !this._walkIsLive()) this._releaseCurrentWalk();
    }

    /** Release whatever this module is currently claiming for, if anything. @private */
    _releaseCurrentWalk() {
        const owner = this.currentOwnerId;
        this.currentOwnerId = null;
        if (!owner) return;
        release(owner).catch((error) => console.error('[TaskTrain] Releasing the walk claim failed:', error));
    }

    /** @private */
    _addButton(header) {
        if (header.querySelector(`#${BUTTON_ID}`)) return;

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.className = 'Button_button__1Fe9z Button_small__3fqC7';
        button.textContent = 'Merged crafting walk';
        button.style.marginLeft = '8px';
        button.addEventListener('click', () => this._openChooser());
        header.appendChild(button);
    }

    /**
     * Offer the merges the board actually has. Nothing is planned until the
     * button is pressed: a plan is a pass over the order books per task, and the
     * task panel is drawn far more often than this is wanted.
     * @private
     */
    _openChooser() {
        document.getElementById(PANEL_ID)?.remove();

        const planned = planTaskTargets(readTaskTargets());
        const groups = groupTasksBySharedChain(planned);

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position: fixed; left: 50%; top: 15%; transform: translateX(-50%);
            z-index: 150; max-width: min(520px, calc(100vw - 24px));
            padding: 10px 12px; border: 1px solid var(--border-color, #60a5fa); border-radius: 6px;
            background: var(--bg-color-tertiary, #1a1a2e); color: var(--text-color-primary, #fff);
            font-size: 0.85em; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        `;

        if (groups.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No two tasks on the board share a crafting step.';
            panel.appendChild(empty);
        } else {
            for (const group of groups) panel.appendChild(this._groupRow(group));
        }

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.style.cssText = `
            margin-top: 8px; padding: 2px 10px; cursor: pointer; background: transparent;
            color: var(--text-color-secondary, #ccc); border: 1px solid var(--border-color, #444);
            border-radius: 3px;
        `;
        close.addEventListener('click', () => panel.remove());
        panel.appendChild(close);

        document.body.appendChild(panel);
    }

    /** One offered merge: who it covers, what it saves, and the button that starts it. @private */
    _groupRow(group) {
        const separate = group.steps.length + group.saved;
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom: 8px;';

        const names = document.createElement('div');
        names.textContent = group.tasks.map((task) => task.target.label).join(' + ');
        row.appendChild(names);

        const savings = document.createElement('div');
        savings.style.cssText = 'color: var(--text-color-secondary, #ccc); margin: 2px 0 4px;';
        savings.textContent =
            `${formatWithSeparator(group.steps.length)} steps together, ` +
            `${formatWithSeparator(separate)} apart — ${formatWithSeparator(group.saved)} saved`;
        row.appendChild(savings);

        const start = document.createElement('button');
        start.type = 'button';
        start.textContent = 'Start merged walk';
        start.style.cssText = `
            padding: 3px 10px; cursor: pointer; background: var(--bg-color-tertiary, #1a1a2e);
            color: var(--text-color-primary, #fff); border: 1px solid var(--border-color, #60a5fa);
            border-radius: 4px;
        `;
        start.addEventListener('click', async () => {
            document.getElementById(PANEL_ID)?.remove();
            await this.startMergedWalk(group);
        });
        row.appendChild(start);

        return row;
    }

    /**
     * Claim the merged plan's materials and hand the merged steps to the walk.
     *
     * The same commitment the panel's walk makes, under one owner for the whole
     * group. The claim is recomputed after every craft step for the same reason
     * it is there: `collectMissingMaterials` credits a craft node against what the
     * bag holds now, so re-running it once an intermediate has landed yields
     * exactly what is left, with no separate progress bookkeeping.
     *
     * @param {{tasks: Array<Object>, steps: Array<Object>}} group - From {@link groupTasksBySharedChain}
     * @returns {Promise<boolean>} Whether a walk started
     */
    async startMergedWalk(group) {
        if (!group?.steps?.length) return false;

        const plans = group.tasks.map((task) => task.plan);
        const ownerId = mergedWalkOwner(plans.map((plan) => plan.itemHrid));
        const label = `Task walk: ${group.tasks.map((task) => task.target.label).join(', ')}`;
        const claim = () => reserve(ownerId, mergedMissingLines(plans, ownerId), { label });

        // The walk is a singleton, so only one merged campaign ever runs at
        // once: whatever this module was tracking before is finished — its own
        // walk already ended, superseded by the one about to start — and its
        // claim goes now rather than waiting for the next liveness check.
        if (this.currentOwnerId && this.currentOwnerId !== ownerId) this._releaseCurrentWalk();

        // Whoever is walking is fixed before the write, and re-checked after it:
        // the plans, the steps and the inventory they were sized against all
        // belong to this character, and a switch landing inside the claim would
        // otherwise hand the arriving character a walk through the departing
        // one's tasks — the walk itself only ends on switches that happen after
        // it has started.
        const walker = dataManager.getCurrentCharacterId?.() || null;
        await claim();
        if ((dataManager.getCurrentCharacterId?.() || null) !== walker) return false;

        // The claim just landed under this owner; tracked from here so the
        // liveness check and a future switch or teardown know to let it go.
        this.currentOwnerId = ownerId;

        let previousStep = null;
        this.stepHook = (step) => {
            if (previousStep?.kind === 'craft') {
                claim().catch((error) => console.error('[TaskTrain] Re-reserving after a craft step failed:', error));
            }
            previousStep = step;
        };
        craftingPlanWalk.onStepAboutToRun = this.stepHook;

        return craftingPlanWalk.start(group.steps);
    }

    /** Take the button, any open chooser, and the walk hook back off. */
    disable() {
        this.unregisterObserver?.();
        this.unregisterObserver = null;
        this.timerRegistry.clearAll();
        // The walk is shared and outlives this feature, so leaving the hook on
        // it would go on re-reserving under a merged walk that is gone.
        if (this.stepHook && craftingPlanWalk.onStepAboutToRun === this.stepHook) {
            craftingPlanWalk.onStepAboutToRun = null;
        }
        this.stepHook = null;
        // Every walk this module could still be claiming for is done by this
        // route as surely as by ending on its own — including a character
        // switch, where this fires before the id moves (see
        // `feature-registry.js`), releasing against the bag the claim was on.
        releaseMissing(RESERVATION_OWNER_PREFIX, []).catch((error) =>
            console.error('[TaskTrain] Releasing walk claims on disable failed:', error)
        );
        this.currentOwnerId = null;
        if (typeof document !== 'undefined') {
            document.getElementById(BUTTON_ID)?.remove();
            document.getElementById(PANEL_ID)?.remove();
        }
        this.isInitialized = false;
    }
}

const taskCraftingTrain = new TaskCraftingTrain();

export default taskCraftingTrain;
