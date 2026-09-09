/**
 * Guided crafting walk.
 *
 * The crafting plan already says what to make and in what order; what it cannot
 * do from a list is put you in front of each step. This walks the plan: it opens
 * the game on one step's action, types that step's count into the game's own
 * count box, and then stops. Adapted from MWITools semiAutoTrain,
 * CC-BY-NC-SA-4.0, see third-party/mwitools/.
 *
 * **One user click is one game action, always.** The walk never presses a game
 * button. It navigates and it pre-fills; the press that queues the action is
 * always the player's, on the game's own control, and the walk only advances
 * once the server has answered that press with an `actions_updated` naming the
 * action the step asked for. Nothing is chained, nothing fires on a timer.
 *
 * A step the plan says to buy rather than craft opens the marketplace on that
 * item instead, and waits for the item to actually arrive in the inventory
 * before moving on — the purchase, like the queue press, is the player's.
 *
 * A step may also name an item that has to be *selected* before its count means
 * anything — an alchemy action is one action for every item in the game, and the
 * item is chosen in a slot the game gives no handler for. Such a step navigates
 * to the action and then waits, without pre-filling, until the panel itself says
 * the named item is in the slot: a count typed against the wrong item is a count
 * the player did not ask for, and the press that follows it is theirs.
 *
 * The walk lives in memory only: a reload ends it, a character switch ends it,
 * and Stop ends it. Nothing about it is written anywhere.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { getInventoryCount } from '../../utils/house-cost-calculator.js';
import { navigateToAction } from '../../utils/item-navigation.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { findActionInput, resolveDetailPanel } from '../../utils/action-panel-helper.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';

const STRIP_ID = 'mwi-crafting-walk-strip';
const CURRENT_CLASS = 'mwi-crafting-walk-current';

/** Attribute the plan display tags its rows with, so a step can point at its own row */
export const WALK_KEY_ATTRIBUTE = 'data-mwi-walk-key';

/** How long to leave the game to draw the action panel before looking for its count box */
const NAV_SETTLE_MS = 100;
/** How many of those waits to spend before giving up on pre-filling a step */
const NAV_RETRY_LIMIT = 15;

/**
 * How often to look again for a step whose item the player still has to select.
 *
 * Slower than {@link NAV_SETTLE_MS} and not spent against the navigation
 * retries, because this is not waiting on the game to draw — it is waiting on a
 * person to put an item in a slot. The idle timeout below is what ends it.
 */
const ITEM_WAIT_POLL_MS = 500;

/**
 * How long a step may sit untouched before the walk ends itself.
 *
 * The walk waits on a press, not on a craft: the press that queues an hour of
 * cheesesmithing arrives in seconds. A step still waiting a quarter of an hour
 * later is a player who walked away, and a walk that outlives their attention
 * is a strip on screen pointing at a plan they have stopped following.
 */
const IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * The one step a plan node contributes, or null when it contributes none.
 *
 * The rejections are the plan's, not the walk's: coins are not bought on the
 * marketplace, a leg the plan sized at nothing is nothing to do, and a craft leg
 * with no action behind it cannot be opened. Exported because anything that
 * reasons about the same steps — the merge across several plans above all — must
 * agree with the walk about which nodes are steps and what each one is called,
 * and a second copy of this predicate is a second answer waiting to diverge.
 *
 * @param {Object} node - A `CraftingPlanNode`
 * @returns {{key: string, kind: 'craft'|'buy', itemHrid: string, itemName: string,
 *   actionHrid: string|null, count: number, actions: number}|null} The step, or null
 */
export function walkStepFor(node) {
    if (!node) return null;
    if (node.itemHrid === '/items/coin') return null;
    const count = Math.ceil(node.quantity);
    if (!(count > 0)) return null;
    const isCraft = node.strategy === 'craft';
    if (isCraft && !node.actionHrid) return null;

    return {
        key: isCraft ? `craft:${node.actionHrid}` : `buy:${node.itemHrid}`,
        kind: isCraft ? 'craft' : 'buy',
        itemHrid: node.itemHrid,
        itemName: node.itemName,
        actionHrid: isCraft ? node.actionHrid : null,
        count,
        actions: isCraft ? node.actionsNeeded || 0 : 0,
    };
}

/**
 * Flatten a computed plan into the steps a walk performs, leaves first.
 *
 * Post-order: a node's children are emitted before the node itself, so nothing
 * is ever offered before the materials it consumes. An item reached down two
 * branches is emitted once, at its first (deepest) position, with the counts
 * summed — its own subtree is identical either way and was already emitted
 * before that first position, so merging forward cannot put a step ahead of
 * something it needs.
 *
 * Coins are not a step (they are not bought on the marketplace), and neither is
 * a leg the plan sized at nothing.
 *
 * @param {Object} plan - Root `CraftingPlanNode` from `computeBestCraftingPlan`
 * @returns {Array<{key: string, kind: 'craft'|'buy', itemHrid: string, itemName: string,
 *   actionHrid: string|null, count: number, actions: number}>} Steps in dependency order
 */
export function buildWalkSteps(plan) {
    const steps = [];
    const byKey = new Map();

    const emit = (node) => {
        const step = walkStepFor(node);
        if (!step) return;

        const existing = byKey.get(step.key);
        if (existing) {
            existing.count += step.count;
            existing.actions += step.actions;
            return;
        }

        byKey.set(step.key, step);
        steps.push(step);
    };

    (function walk(node) {
        if (!node) return;
        for (const child of node.children || []) walk(child);
        emit(node);
    })(plan);

    return steps;
}

/**
 * The item an action panel currently has selected, for the actions that are
 * chosen by item rather than being an action apiece.
 *
 * Read off the requirement row's sprite, which is the only place the game states
 * it — there is no handler and no field to ask.
 *
 * @param {HTMLElement} panel - An action detail panel
 * @returns {string|null} Item hrid, or null when nothing is selected
 */
function selectedItemHrid(panel) {
    const use = panel.querySelector(
        '[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"] svg use'
    );
    const id = use?.getAttribute('href')?.split('#')[1];
    return id ? `/items/${id}` : null;
}

/** Human wording for one step, e.g. `craft 40 Rough Leather`. */
function stepLabel(step) {
    if (step.label) return step.label;
    const verb = step.kind === 'craft' ? 'craft' : 'buy';
    return `${verb} ${formatWithSeparator(step.count)} ${step.itemName}`;
}

class CraftingPlanWalk {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        /** @type {Array<Object>} */
        this.steps = [];
        this.index = 0;
        this.active = false;
        /** What the inventory must reach before a buy step is satisfied */
        this.buyTarget = 0;
        /**
         * Action ids already queued for the current step's action when the step
         * began. `endCharacterActions` carries existing actions alongside new
         * ones, so a step whose action the player had queued already — or is
         * performing right now — would otherwise advance on the next queue
         * event of any kind, with nothing pressed.
         * @type {Set<*>}
         */
        this.queuedBefore = new Set();
        /** Why the walk ended, shown in the strip until it is dismissed */
        this.message = '';
        /** @type {((step: Object) => void)|null} The seam hook itself */
        this._stepHook = null;
        /**
         * Whether {@link _stepHook} was installed for the walk that is about to
         * start, rather than left behind by the last one. Assigning the hook
         * raises it; {@link start} lowers it, having kept the hook only if it
         * was raised; {@link stop} clears both.
         */
        this._stepHookFresh = false;
    }

    /**
     * The reservation seam.
     *
     * Called once per step, with that step, immediately before the walk
     * navigates anywhere for it — early enough that a caller can reserve the
     * step's materials against the inventory ledger before the player is put in
     * front of the button that spends them. Set it to a function immediately
     * before {@link start}; it is never called twice for the same visit to a
     * step, and a throw from it is logged and does not stop the walk.
     *
     * Owned by ONE walk. The walk is a singleton three surfaces share and the
     * third of them — the ironcow queue walk — installs no hook at all, so a
     * hook that outlived its own walk would fire for somebody else's steps and
     * re-reserve a finished plan's materials against a bag it has no claim on
     * — restamping a claim the ledger's TTL was about to expire, and sizing it
     * against an inventory another walk is spending. So {@link stop} drops it
     * and {@link start} keeps only a hook installed since the last stop.
     * @type {((step: Object) => void)|null}
     */
    get onStepAboutToRun() {
        return this._stepHook;
    }

    set onStepAboutToRun(fn) {
        this._stepHook = typeof fn === 'function' ? fn : null;
        this._stepHookFresh = true;
    }

    /** Subscribe to the two messages the walk advances on, and to the switch that ends it. */
    initialize() {
        if (this.isInitialized) return;
        // Two surfaces drive this one walk: the action panel's plan and the task
        // board's merged walk. Either setting on is a reason to be listening.
        if (!config.getSetting('craftingPlan_guidedWalk') && !config.getSetting('tasks_mergedCraftingWalk')) return;
        this._listen();
    }

    /**
     * Subscribe, whoever asked for the walk.
     *
     * Split from {@link initialize} because the settings gate above governs the
     * crafting plan's own two surfaces, and a walk started by a third — a panel
     * behind a setting of its own — must still advance and must still end on a
     * character switch. A walk that is running and not listening is a strip that
     * never moves.
     * @private
     */
    _listen() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const onActions = (data) => this._onActionsUpdated(data);
        webSocketHook.on('actions_updated', onActions);
        this.unregisterHandlers.push(() => webSocketHook.off('actions_updated', onActions));

        const onItems = () => this._onItemsUpdated();
        dataManager.on('items_updated', onItems);
        this.unregisterHandlers.push(() => dataManager.off?.('items_updated', onItems));

        // The plan, the counts and the inventory the walk is stepping through all
        // belong to the character that started it; none of them survive a switch.
        const onSwitch = () => this.stop('Character switched — the walk ended.');
        dataManager.on('character_switching', onSwitch);
        this.unregisterHandlers.push(() => dataManager.off?.('character_switching', onSwitch));
    }

    /**
     * Begin walking a set of steps.
     * @param {Array<Object>} steps - From {@link buildWalkSteps}
     * @returns {boolean} Whether a walk started
     */
    start(steps) {
        if (!Array.isArray(steps) || steps.length === 0) return false;
        this._listen();
        // Captured across the reset below, and only when this walk's own caller
        // installed it: `stop()` drops the hook, and a caller that installs one
        // does so immediately before starting
        const hook = this._stepHookFresh ? this._stepHook : null;
        this.stop('');
        this._stepHook = hook;
        this._stepHookFresh = false;
        this.steps = steps;
        this.index = 0;
        this.active = true;
        this.message = '';
        this._runStep();
        return true;
    }

    /** Leave this step undone and move to the next. */
    skip() {
        if (!this.active) return;
        this._advance();
    }

    /**
     * End the walk, leaving the game exactly where it is.
     * @param {string} [message] - Why, shown in the strip; empty removes the strip
     */
    stop(message = '') {
        this.active = false;
        this.steps = [];
        this.index = 0;
        this.buyTarget = 0;
        this.queuedBefore = new Set();
        this.message = message;
        // The hook belonged to the walk that just ended; see its own comment
        this._stepHook = null;
        this._stepHookFresh = false;
        this.timerRegistry.clearAll();
        this._clearHighlight();
        if (message) this._render();
        else this._removeStrip();
    }

    /** The step the walk is currently standing on, or null. @returns {Object|null} */
    currentStep() {
        return this.active ? this.steps[this.index] || null : null;
    }

    /**
     * Open the game on the current step and pre-fill it. Presses nothing.
     * @private
     */
    _runStep() {
        const step = this.steps[this.index];
        if (!step) {
            this.stop('Walk complete.');
            return;
        }

        // The seam: everything that must happen before the player is put in
        // front of this step's button happens here, once, ahead of the
        // navigation — a materials reservation above all.
        try {
            this.onStepAboutToRun?.(step);
        } catch (error) {
            console.error('[CraftingPlanWalk] The step hook failed:', error);
        }

        if (step.kind === 'buy') {
            // Measured before navigating: the target is what the player holds now
            // plus what this step buys, so a partial fill does not advance early
            this.buyTarget = getInventoryCount(step.itemHrid) + step.count;
            this.queuedBefore = new Set();
            navigateToMarketplace(step.itemHrid);
        } else {
            // Snapshotted before the player can press anything: only an action
            // id this step did not start with is their press on this step
            this.queuedBefore = this._queuedIdsFor(step.actionHrid, step.requiresItemHrid);
            if (!navigateToAction(step.actionHrid)) {
                this.stop('The game could not be opened on the next step.');
                return;
            }
            this._prefillSoon(step);
        }

        this._armIdleTimeout();
        this._render();
    }

    /**
     * Type the step's action count into the game's own count box, once the panel
     * the game navigated to is confirmed to be the step's own.
     *
     * Re-verified rather than assumed: navigation is asynchronous and the player
     * may have moved on themselves, and a count typed into somebody else's panel
     * is a count the player did not ask for.
     * @param {Object} step
     * @private
     */
    _prefillSoon(step) {
        if (!(step.actions > 0)) return;
        let retries = 0;

        const tryFill = () => {
            if (!this.active || this.steps[this.index] !== step) return;

            const panel = document.querySelector(GAME.SKILL_ACTION_DETAIL);
            if (panel && resolveDetailPanel(panel)?.actionHrid === step.actionHrid) {
                // A step chosen by item is not this step until its item is the
                // one in the slot, however right the action is.
                const itemReady = !step.requiresItemHrid || selectedItemHrid(panel) === step.requiresItemHrid;
                const input = itemReady ? findActionInput(panel) : null;
                if (input) {
                    setReactInputValue(input, step.actions, { focus: false });
                    return;
                }
            }
            if (step.requiresItemHrid) {
                this.timerRegistry.registerTimeout(setTimeout(tryFill, ITEM_WAIT_POLL_MS));
            } else if (++retries < NAV_RETRY_LIMIT) {
                this.timerRegistry.registerTimeout(setTimeout(tryFill, NAV_SETTLE_MS));
            }
        };

        this.timerRegistry.registerTimeout(setTimeout(tryFill, NAV_SETTLE_MS));
    }

    /**
     * The ids of the actions already queued for one action hrid.
     * @param {string} actionHrid
     * @param {string|null} [requiresItemHrid] - For an action that is chosen by item
     * @returns {Set<*>}
     * @private
     */
    _queuedIdsFor(actionHrid, requiresItemHrid = null) {
        const rows = dataManager.getCurrentActions?.() || [];
        return new Set(
            rows
                .filter(
                    (row) =>
                        row?.actionHrid === actionHrid &&
                        (!requiresItemHrid || row.primaryItemHash?.includes(requiresItemHrid))
                )
                .map((row) => row.id)
        );
    }

    /**
     * A craft step is done when the server says an action the step named has
     * been ADDED to the queue. Any other `actions_updated` — a completion
     * elsewhere, somebody else's queue edit — names other actions and moves
     * nothing.
     *
     * Added, not merely present: `endCharacterActions` carries existing actions
     * alongside new ones, so a step whose action was already in the queue when
     * the step began (the player queued some of it themselves, or is running it
     * right now) matched on the first queue event of any kind and skipped
     * itself, unpressed and uncrafted. Only an id the step did not start with
     * is the player's press.
     *
     * @param {Object} data - The `actions_updated` payload
     * @private
     */
    _onActionsUpdated(data) {
        const step = this.currentStep();
        if (!step || step.kind !== 'craft') return;
        const rows = data?.endCharacterActions;
        if (!Array.isArray(rows)) return;
        const isThisStep = (row) =>
            row?.actionHrid === step.actionHrid &&
            !this.queuedBefore.has(row.id) &&
            // One alchemy action covers every item in the game, so the action
            // alone does not say this step was the one pressed.
            (!step.requiresItemHrid || row.primaryItemHash?.includes(step.requiresItemHrid));
        if (!rows.some(isThisStep)) return;
        this._advance();
    }

    /**
     * A buy step is done when the item is actually held. Reading the count back
     * rather than trusting the purchase means a cancelled or partial buy leaves
     * the walk where it was.
     * @private
     */
    _onItemsUpdated() {
        const step = this.currentStep();
        if (!step || step.kind !== 'buy') return;
        if (getInventoryCount(step.itemHrid) < this.buyTarget) return;
        this._advance();
    }

    /** @private */
    _advance() {
        this.timerRegistry.clearAll();
        this.index += 1;
        if (this.index >= this.steps.length) {
            this.stop('Walk complete.');
            return;
        }
        this._runStep();
    }

    /**
     * End a walk nobody is watching any more.
     * @private
     */
    _armIdleTimeout() {
        this.timerRegistry.registerTimeout(
            setTimeout(() => this.stop('The walk ended after a long wait on one step.'), IDLE_TIMEOUT_MS)
        );
    }

    // === Strip ===

    /**
     * The strip is fixed to the page rather than seated in the plan section: the
     * walk's whole job is to navigate away from the panel that plan was drawn
     * on, and a strip living inside it would go with the first step.
     * @private
     */
    _strip() {
        let strip = document.getElementById(STRIP_ID);
        if (strip) return strip;

        strip = document.createElement('div');
        strip.id = STRIP_ID;
        strip.style.cssText = `
            position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
            z-index: 150; display: flex; align-items: center; gap: 10px;
            max-width: calc(100vw - 24px); padding: 6px 12px;
            border: 1px solid var(--border-color, #60a5fa); border-radius: 999px;
            background: var(--bg-color-tertiary, #1a1a2e); color: var(--text-color-primary, #fff);
            font-size: 0.85em; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        `;

        const label = document.createElement('span');
        label.dataset.role = 'label';
        label.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        strip.appendChild(label);

        const skip = this._stripButton('Skip', () => this.skip());
        skip.dataset.role = 'skip';
        strip.appendChild(skip);

        const stop = this._stripButton('Stop', () => this.stop(''));
        stop.dataset.role = 'stop';
        strip.appendChild(stop);

        document.body.appendChild(strip);
        return strip;
    }

    /** @private */
    _stripButton(text, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.style.cssText = `
            flex-shrink: 0; padding: 1px 8px; cursor: pointer;
            background: transparent; color: var(--text-color-secondary, #ccc);
            border: 1px solid var(--border-color, #444); border-radius: 3px; font-size: 0.95em;
        `;
        button.addEventListener('click', onClick);
        return button;
    }

    /** @private */
    _removeStrip() {
        document.getElementById(STRIP_ID)?.remove();
    }

    /** @private */
    _render() {
        if (typeof document === 'undefined') return;

        if (!this.active) {
            if (!this.message) {
                this._removeStrip();
                return;
            }
            const strip = this._strip();
            strip.querySelector('[data-role="label"]').textContent = this.message;
            strip.querySelector('[data-role="skip"]').hidden = true;
            strip.querySelector('[data-role="stop"]').textContent = 'Dismiss';
            return;
        }

        const step = this.steps[this.index];
        const strip = this._strip();
        strip.querySelector('[data-role="label"]').textContent =
            `Step ${this.index + 1} of ${this.steps.length}: ${stepLabel(step)}`;
        strip.querySelector('[data-role="skip"]').hidden = false;
        strip.querySelector('[data-role="stop"]').textContent = 'Stop';
        this._highlight(step.key);
    }

    /**
     * Mark the current step's row in whichever plan tree is on the page. The tree
     * belongs to the panel the plan was drawn on, so once the walk navigates away
     * there is nothing to mark — which is correct, not a miss.
     * @param {string} key
     * @private
     */
    _highlight(key) {
        this._clearHighlight();
        for (const row of document.querySelectorAll(`[${WALK_KEY_ATTRIBUTE}="${key}"]`)) {
            row.classList.add(CURRENT_CLASS);
            row.style.color = '#ffe27a';
        }
    }

    /** @private */
    _clearHighlight() {
        if (typeof document === 'undefined') return;
        for (const row of document.querySelectorAll(`.${CURRENT_CLASS}`)) {
            row.classList.remove(CURRENT_CLASS);
            row.style.color = '';
        }
    }

    /** Stop listening and take the strip off the page. */
    disable() {
        this.stop('');
        for (const unregister of this.unregisterHandlers) {
            try {
                unregister();
            } catch (error) {
                console.error('[CraftingPlanWalk] Cleanup failed:', error);
            }
        }
        this.unregisterHandlers = [];
        this.isInitialized = false;
    }
}

const craftingPlanWalk = new CraftingPlanWalk();

export default craftingPlanWalk;
