/**
 * Goal Planner panel
 *
 * A list of what you are working towards, and the ordered steps to get there.
 *
 * The panel deliberately does no arithmetic. It collects a goal, hands it to
 * `goal-planner.js` with a context built from the live calculators, and draws
 * what comes back — so anything a number here disagrees with the rest of
 * Toolasha about is a bug in one calculator rather than a second opinion grown
 * inside a panel.
 *
 * ## Refresh is a button, not a timer
 *
 * Ranking every activity the character can do means running the profit
 * calculators a few hundred times. That is not something to do every five
 * seconds behind somebody's back, and it is not something whose answer changes
 * minute to minute. So the plan is computed on demand, the market age it was
 * priced at is printed next to the totals, and the last result is kept so the
 * panel has something to show the moment it opens.
 *
 * *Planning* is not that expensive, though, and the two are now separate.
 * Adding or removing a goal replans every goal immediately against the context
 * already priced — which it has to, because the goals share one bagful of
 * inputs and a removed goal's claims belong to the goals below it. Refresh
 * remains the only thing that goes back to the market.
 *
 * ## Steps that are already done stay on screen
 *
 * A plan re-costed after you bought the base item shows that step struck
 * through rather than one step shorter. Watching steps grey out is the progress
 * bar; a list that silently gets smaller is just a list you no longer trust.
 *
 * ## A step that says "buy 40 materials" can go and buy them
 *
 * Toolasha already knows how to send a shopping list to the marketplace: the
 * missing-materials button does it for an action, `utils/shopping-list.js` does
 * it for a restock, and both are the same three pieces —
 * `createMaterialTab`, `createAutofillManager`, `navigateToMarketplace`. A step
 * that names a purchase gets a button onto whichever of those already fits, so
 * the planner adds an entry point rather than a fourth implementation of
 * marketplace tabs.
 *
 * The list lives in `utils/` rather than beside the consumables panel because
 * this panel is in a different bundle from that one, and a copy each meant two
 * modules with their own tab state fighting over the one marketplace tab bar.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { openMissingMaterials } from '../actions/missing-materials-button.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import { navigateToAction } from '../../utils/item-navigation.js';
import { formatKMB, parseKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import {
    planGoals,
    describeGoal,
    describeLeg,
    GOAL_TYPES,
    reservationLines,
    RESERVATION_OWNER_PREFIX,
} from './goal-planner.js';
import { buildPlannerContext, withHouseCosts, coinsHeld } from './goal-planner-context.js';
import { loadGoals, addGoal, removeGoal, loadSnapshot, saveSnapshot, saveCombatGear } from './goal-planner-store.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import { releaseMissing, reserve, reservationsEnabled } from '../../utils/inventory-reservations.js';

const PANEL_ID = 'toolasha-goal-planner-panel';
const GEOMETRY_KEY = 'goalPlannerPanel';
const DEFAULT_PANEL = { width: 560, height: 620 };

const COLORS = {
    background: 'rgba(10, 12, 20, 0.97)',
    headerBg: 'rgba(18, 26, 40, 0.92)',
    border: 'rgba(120, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    card: 'rgba(255, 255, 255, 0.04)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fb0ff',
    good: '#7fd6a3',
    bad: '#f0776c',
    warn: '#ffb020',
};

/** Which step kind gets which mark, so a plan can be skimmed down its left edge */
const KIND_GLYPH = {
    earn: '⛏',
    acquire: '🛒',
    enhance: '✦',
    train: '📘',
    build: '🏠',
};

/**
 * Hours, said the way a plan says them.
 * @param {number|null} hours - Hours, or null when unknown
 * @returns {string} e.g. "3h 20m 00s", or "—"
 */
function duration(hours) {
    if (hours === null || !Number.isFinite(hours)) return '—';
    if (hours <= 0) return '0s';
    return timeReadable(Math.round(hours * 3600));
}

/**
 * Coins, signed the way a step means them.
 * @param {number} value - Coins; negative spends
 * @returns {string} e.g. "-12.5M"
 */
function signedCoins(value) {
    const rounded = Math.round(Number(value) || 0);
    if (rounded === 0) return '0';
    return `${rounded > 0 ? '+' : '-'}${formatKMB(Math.abs(rounded))}`;
}

/**
 * @param {string} text - Cell contents
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A span
 */
function span(text, style = {}) {
    const element = document.createElement('span');
    element.textContent = text;
    Object.assign(element.style, style);
    return element;
}

/**
 * A small control that looks like the rest of the panel.
 * @param {string} label - Button text
 * @param {Function} onClick - Click handler
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A button
 */
function button(label, onClick, style = {}) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    Object.assign(element.style, {
        background: 'rgba(255, 255, 255, 0.07)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '3px',
        color: COLORS.accent,
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 8px',
        ...style,
    });
    element.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return element;
}

/**
 * @param {Object} [attributes] - `value`, `placeholder`, `type`, `list`, `width`
 * @returns {HTMLInputElement} An input
 */
function input(attributes = {}) {
    const element = document.createElement('input');
    element.type = attributes.type || 'text';
    if (attributes.placeholder) element.placeholder = attributes.placeholder;
    if (attributes.value !== undefined) element.value = attributes.value;
    if (attributes.list) element.setAttribute('list', attributes.list);
    if (attributes.min !== undefined) element.min = String(attributes.min);
    if (attributes.max !== undefined) element.max = String(attributes.max);
    Object.assign(element.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '2px 6px',
        width: attributes.width || '110px',
    });
    return element;
}

/** What an enhancement bill is, said where somebody is about to spend money on it */
const EXPECTED_MATERIALS_NOTE = 'expected materials — enhancing is random';

/**
 * What a step would have you buy, and which existing machinery buys it.
 *
 * Four shapes, and each one already has a home:
 *
 * - a craft — the action's inputs, which is exactly what the missing-materials
 *   button computes and puts on the marketplace, so it is handed the action;
 * - a list of house materials — a shopping list, which is what the consumables
 *   restock built its tabs for;
 * - one item off the market — the degenerate shopping list of one, so it goes
 *   the same way and arrives with the quantity already filled in;
 * - an enhancement run — the same list again, from the path optimiser's own
 *   bill. It is the only one of the four whose counts are an *expectation*
 *   rather than a requirement, so it says so on the button and again on the tab
 *   bar it opens: the chain that produced 41.3 attempts will not produce 41.3.
 *
 * @param {Object} step - A plan step
 * @returns {{label: string, title: string, open: Function}|null} The button to draw, if any
 */
export function shoppingFor(step) {
    if (!step || step.done) return null;
    const details = step.details || {};

    if (step.kind === 'enhance') {
        const wanted = (details.shoppingList || []).filter((item) => item?.itemHrid && item.count > 0);
        if (!wanted.length) return null;
        return {
            label: 'Buy',
            title:
                `Open the marketplace with tabs for the ${wanted.length} thing` +
                `${wanted.length === 1 ? '' : 's'} this run expects to consume. ` +
                'Enhancing is random, so these counts are the average of a distribution, not a bill.',
            open: () => openShoppingList(wanted, { heading: `Enhancing: ${EXPECTED_MATERIALS_NOTE}` }),
        };
    }

    if (step.kind !== 'acquire') return null;

    const materials = (details.materials || [])
        .filter((material) => material?.itemHrid && material.missing > 0)
        .map((material) => ({
            itemHrid: material.itemHrid,
            name: material.name || material.itemHrid.split('/').pop(),
            count: Math.ceil(material.missing),
        }));
    if (materials.length) {
        return {
            label: 'Buy',
            title: `Open the marketplace with tabs for all ${materials.length} missing materials.`,
            open: () => openShoppingList(materials),
        };
    }

    if (details.strategy === 'craft' && details.actionHrid) {
        const actions = Math.max(1, Math.ceil(Number(details.actionsNeeded) || 1));
        return {
            label: 'Buy mats',
            title: 'Open the marketplace on what this craft is short of.',
            open: () => openMissingMaterials(details.actionHrid, actions),
        };
    }

    if (details.itemHrid && details.strategy !== 'craft') {
        const name = details.itemName || details.itemHrid.split('/').pop();
        return {
            label: 'Buy',
            title: 'Open the marketplace on this item, with the quantity filled in.',
            open: () => openShoppingList([{ itemHrid: details.itemHrid, name, count: 1 }]),
        };
    }

    return null;
}

/** The one action enhancing has, and therefore the way to the enhancing screen */
const ENHANCING_ACTION_HRID = '/actions/enhancing/enhance';

/**
 * Where in the game a step would have you go, if anywhere.
 *
 * Every step that names an activity already carries the action hrid it was
 * costed from — the training rate, the earning rate, the craft — so this is a
 * lookup rather than a search, and it goes through
 * {@link navigateToAction}, the same `handleGoToAction` the alt-click
 * navigation and the pinned-actions page use. Nothing new is built for it.
 *
 * A step with nowhere to go simply has nowhere to go: upgrading a house room
 * happens on a screen the game does not navigate to by action hrid, and buying
 * a base item already has a Buy button that opens the marketplace on it.
 *
 * @param {Object} step - A plan step
 * @returns {{actionHrid: string, title: string}|null} The destination, if there is one
 */
export function navigationFor(step) {
    if (!step || step.done) return null;
    const details = step.details || {};

    if (step.kind === 'enhance') {
        return { actionHrid: ENHANCING_ACTION_HRID, title: 'Open the enhancing screen.' };
    }

    // Training and earning both rank actions and keep the winner; an earning
    // step that ran out of its best method mid-plan keeps the legs instead, and
    // the first leg is the one you would start with
    const actionHrid =
        details.rate?.actionHrid ||
        details.legs?.find((leg) => leg?.rate?.actionHrid)?.rate?.actionHrid ||
        (step.kind === 'acquire' && details.strategy === 'craft' ? details.actionHrid : null);

    if (!actionHrid) return null;
    return { actionHrid, title: 'Open this action in the game.' };
}

/**
 * @param {Array<{value: string, label: string}>} options - What can be chosen
 * @returns {HTMLSelectElement} A select
 */
function select(options) {
    const element = document.createElement('select');
    element.classList.add('toolasha-select');
    Object.assign(element.style, {
        background: 'rgba(0, 0, 0, 0.35)',
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '2px 4px',
        maxWidth: '200px',
    });
    for (const option of options) {
        const child = document.createElement('option');
        child.value = option.value;
        child.textContent = option.label;
        element.appendChild(child);
    }
    return element;
}

class GoalPlannerPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
        this.goals = [];
        this.plans = [];
        /**
         * The last priced context, kept so adding or removing a goal can replan
         * without going back to the market. Refresh is what re-prices it.
         */
        this.context = null;
        /** A message the header should keep showing until the next replan clears it */
        this.notice = null;
        /** What the rate providers want said — a missing or stale combat snapshot, say */
        this.rateNotes = [];
        /** Which combat loadout the rates were judged against, and the alternatives */
        this.combatStatus = null;
        this.pricedAt = null;
        this.busy = false;
        this.formType = null;
        this.loaded = null;
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    /**
     * Put the panel away.
     * @param {Object} [options] - `remember: false` to close without recording it
     */
    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Feature-registry entry point: read the goals back and reopen if left open */
    async initialize() {
        await this.load();
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));

        registerCommand({
            name: 'Goal Planner',
            hint: 'Ordered steps to a goal, costed',
            run: () => this.toggle(),
        });
    }

    /**
     * Feature-registry teardown — also the character-switch boundary.
     *
     * `this.context` carries the ranked activities, the acquisition and XP-rate
     * caches, and `this.plans` the last drawn steps — all of them read live
     * game state exactly once, at whichever character built them. `load()`
     * replaces `this.plans` only when the next character has a saved snapshot,
     * so without this reset a character who has never opened the planner would
     * inherit the previous one's plans outright, and `replan()` without a
     * refresh would quote a new goal against the previous character's ranked
     * income and cached prices — a different person's crafting skill, gear and
     * coins, presented as this one's.
     */
    disable() {
        unregisterCommand('Goal Planner');
        this._remove();
        this.context = null;
        this.plans = [];
        this.rateNotes = [];
        this.combatStatus = null;
        this.pricedAt = null;
        this.notice = null;
    }

    /**
     * Read the stored goals and the last plans, once per character.
     * @returns {Promise<void>}
     */
    async load() {
        this.goals = await loadGoals();
        const snapshot = await loadSnapshot();
        if (snapshot) {
            this.plans = snapshot.plans;
            this.pricedAt = snapshot.computedAt;
        }
        this._render();
    }

    /**
     * Re-cost every goal against the market as it stands now.
     *
     * The whole plan is recomputed rather than patched: a step is satisfied or
     * not by the character's present state, and the only way to know which is
     * to ask again. Steps that have become satisfied come back marked done.
     *
     * @returns {Promise<void>}
     */
    async refresh() {
        await this.replan({ reprice: true });
    }

    /**
     * Plan every goal again, optionally without going back to the market.
     *
     * Two costs, and only one of them is large. Ranking every activity the
     * character can do — `buildPlannerContext` — is a few hundred profit
     * calculations and is what the Refresh button is for. Running the goals
     * through the planner is microseconds, and it is *all* that adding or
     * removing a goal needs: the prices have not changed since the last
     * pricing, so re-fetching them to answer "what does this new goal cost"
     * would be spending seconds to learn nothing.
     *
     * So the priced context is kept and reused, with the two things that do
     * move between clicks refreshed cheaply off the game state: coins in hand,
     * and the clock. Every goal is replanned rather than only the new one,
     * because the goals share a bagful of inputs — removing a goal has to give
     * its claims back to the goals below it, and that is the same loop.
     *
     * @param {Object} [options] - Options
     * @param {boolean} [options.reprice=false] - Rebuild the context from the market first
     * @returns {Promise<void>}
     */
    async replan({ reprice = false } = {}) {
        if (this.busy) return;
        this.busy = true;
        this.notice = null;
        this._status(reprice ? 'Pricing…' : 'Planning…');
        // Who this plan is for, fixed before the pricing. `buildPlannerContext()`
        // is the multi-second market fetch the "Pricing…" status exists for, and
        // everything after it — the context, the plans, the snapshot write — was
        // adopted under whoever was logged in when it finished. A switch inside
        // it showed the arriving character the departing character's goals and
        // step costs, stamped as priced just now, and `saveSnapshot`'s
        // `writeScoped` filed them over the arriving character's own snapshot.
        const owner = dataManager.getCurrentCharacterId() || null;
        const gone = () => (dataManager.getCurrentCharacterId() || null) !== owner;
        try {
            if (reprice || !this.context) {
                const context = await buildPlannerContext();
                if (gone()) return;
                this.context = context;
                this.pricedAt = Date.now();
            } else {
                // The memoised providers and the ranked rates ride along
                // unchanged; only what a purchase can be measured against moves
                this.context = { ...this.context, gold: coinsHeld(), now: Date.now() };
            }

            await withHouseCosts(this.context, this.goals);
            if (gone()) return;
            this.plans = planGoals(this.goals, this.context);
            this.rateNotes = this.context.rateNotes || [];
            this.combatStatus = this.context.combatStatus || null;
            await saveSnapshot(this.plans, owner);
            if (!gone()) await this._recordReservations();
        } catch (error) {
            console.error('[GoalPlanner] Planning failed:', error);
            // On `notice` rather than straight to the status line: the redraw in
            // `finally` rewrites that line, so a message put there directly is
            // gone before anybody reads it
            this.notice = reprice ? 'Pricing failed — see the console.' : 'Planning failed — see the console.';
        } finally {
            this.busy = false;
            this._render();
        }
    }

    /**
     * Tell the reservation ledger what these goals now claim of the bag.
     *
     * A goal's claim persists — the goal does — so it is re-stated on every
     * replan and dropped when the goal is. The whole goal list is in hand here,
     * which is what makes a deleted goal's claim observable rather than
     * something that has to time out: any `goal:` owner not on this list is a
     * goal the player removed.
     *
     * @returns {Promise<void>}
     */
    async _recordReservations() {
        if (!reservationsEnabled()) return;
        try {
            const live = this.plans.map((plan) => `${RESERVATION_OWNER_PREFIX}${plan.goalId}`);
            await releaseMissing(RESERVATION_OWNER_PREFIX, live);
            for (const plan of this.plans) {
                await reserve(`${RESERVATION_OWNER_PREFIX}${plan.goalId}`, reservationLines(plan), {
                    label: `Goal: ${plan.title}`,
                });
            }
        } catch (error) {
            console.error('[GoalPlanner] Recording reservations failed:', error);
        }
    }

    /**
     * Add a goal and immediately plan it, against the prices already loaded.
     * @param {Object} raw - A goal from the creation form
     * @returns {Promise<void>}
     */
    async addGoal(raw) {
        this.goals = await addGoal(raw);
        this.formType = null;
        this._render();
        await this.replan();
    }

    /**
     * Drop a goal, and give what it had claimed back to the goals below it.
     *
     * Filtering the dead plan out is not enough now that the plans share a
     * ledger: a goal that was planning around a stack the removed goal had taken
     * is still planning around it until the allocation is run again.
     *
     * @param {string} goalId - The goal's id
     * @returns {Promise<void>}
     */
    async removeGoal(goalId) {
        // Fixed before the store round trip, same as `replan()`: a character
        // switch during that read must not have the write below land under
        // whoever is current when it finishes rather than whoever removed the
        // goal — `saveSnapshot` writes to `characterKey()` resolved at call
        // time, so an unpinned call is a silent handoff of one character's
        // plans to another's snapshot.
        const owner = dataManager.getCurrentCharacterId() || null;
        this.goals = await removeGoal(goalId);
        this.plans = this.plans.filter((plan) => plan.goalId !== goalId);

        if (!this.context) {
            // Nothing has been priced this session, so there is nothing to
            // reallocate against; saying so beats a silent full market fetch
            await saveSnapshot(this.plans, owner);
            this._render();
            this._status('Removed — press Refresh to price the rest.');
            return;
        }

        await this.replan();
    }

    // -------------------------------------------------------------------------
    // Panel construction
    // -------------------------------------------------------------------------

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '90px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `min(${DEFAULT_PANEL.width}px, 94vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 82vh)`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 12px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 400,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 400, height: 240 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        // A panel opened before the goals came back from storage would show an
        // empty list and look like it had lost them
        if (!this.loaded) this.loaded = this.load();
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = span('Goal Planner', { fontWeight: 'bold', color: COLORS.accent });

        this.statusEl = span('', { color: COLORS.textDim, fontSize: '11px' });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const refresh = button('Refresh', () => this.refresh());
        refresh.title = 'Re-price every plan against the market data loaded now.';

        const close = button('✕', () => this.hide(), {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            fontSize: '13px',
            padding: '2px 4px',
        });

        header.append(title, this.statusEl, spacer, refresh, close);
        return header;
    }

    /**
     * @param {string} text - What the header's status line says
     */
    _status(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    _render() {
        if (!this.bodyEl) return;
        this.bodyEl.replaceChildren();

        this._status(
            this.notice ||
                (this.busy
                    ? 'Pricing…'
                    : this.pricedAt
                      ? `priced ${new Date(this.pricedAt).toLocaleTimeString()}`
                      : 'not priced yet')
        );

        this.bodyEl.appendChild(this._addSection());

        // A rate that is missing or old is worth a line: a plan that ranks
        // gathering first because nobody has ever run an all-zones sim looks
        // exactly like a plan that ranks gathering first because it wins.
        for (const note of this.rateNotes || []) {
            this.bodyEl.appendChild(
                span(note, {
                    display: 'block',
                    color: COLORS.textDim,
                    fontSize: '11px',
                    marginTop: '6px',
                })
            );
        }

        try {
            const picker = this._loadoutPicker();
            if (picker) this.bodyEl.appendChild(picker);
        } catch (error) {
            console.error('[GoalPlanner] Drawing the loadout picker failed:', error);
        }

        if (!this.goals.length) {
            this.bodyEl.appendChild(
                span('No goals yet. Add one above and the planner will work out the order and the bill.', {
                    display: 'block',
                    color: COLORS.textDim,
                    marginTop: '10px',
                })
            );
            return;
        }

        const byGoal = new Map(this.plans.map((plan) => [plan.goalId, plan]));
        for (const goal of this.goals) {
            try {
                this.bodyEl.appendChild(this._goalCard(goal, byGoal.get(goal.id) || null));
            } catch (error) {
                console.error('[GoalPlanner] Drawing a goal failed:', error);
                this.bodyEl.appendChild(
                    span(`${describeGoal(goal)} could not be drawn.`, { display: 'block', color: COLORS.bad })
                );
            }
        }

        // One fetch priced every card, so the sentence about that fetch belongs
        // to the panel rather than to each of them
        const note = this.plans.find((plan) => plan?.confidence?.note)?.confidence?.note;
        if (note) {
            this.bodyEl.appendChild(
                span(note, {
                    display: 'block',
                    color: COLORS.textDim,
                    fontSize: '11px',
                    borderTop: `1px solid ${COLORS.hairline}`,
                    paddingTop: '5px',
                    marginTop: '2px',
                })
            );
        }
    }

    /**
     * Which loadout the combat rates are judged against.
     *
     * Only drawn when the answer is a genuine choice. One combat loadout, or
     * none, is not a decision worth a control — the resolution order in
     * `combat-rates.js` settles it and saying so in a note is enough. Two or
     * more and the planner is guessing, so the guess is offered for correction
     * and the correction is remembered.
     *
     * @returns {HTMLElement|null} The picker, or null when there is nothing to pick
     */
    _loadoutPicker() {
        const status = this.combatStatus;
        const choices = status?.loadoutChoices || [];
        if (choices.length < 2) return null;

        const strip = document.createElement('div');
        Object.assign(strip.style, {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            marginTop: '4px',
            fontSize: '11px',
            color: COLORS.textDim,
        });
        strip.appendChild(span('Combat rates judged against:'));

        const picker = select(choices.map((name) => ({ value: name, label: name })));
        picker.value = status.loadoutName || choices[0];
        picker.title =
            'Which loadout counts as your combat gear. The "gear changed" warning means this loadout no ' +
            'longer matches the one the saved run was measured in.';
        picker.addEventListener('change', async () => {
            await saveCombatGear({ preferred: picker.value });
            await this.refresh();
        });
        strip.appendChild(picker);

        return strip;
    }

    /**
     * The add-a-goal strip, and the form for whichever type is being added.
     * @returns {HTMLElement} The section
     */
    _addSection() {
        const section = document.createElement('div');
        section.style.marginBottom = '10px';

        const strip = document.createElement('div');
        Object.assign(strip.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
        strip.appendChild(span('Add goal:', { color: COLORS.textDim }));

        for (const [type, label] of Object.entries(GOAL_TYPES)) {
            const chip = button(label, () => {
                this.formType = this.formType === type ? null : type;
                this._render();
            });
            if (this.formType === type) {
                chip.style.background = 'rgba(127, 176, 255, 0.22)';
            }
            strip.appendChild(chip);
        }
        section.appendChild(strip);

        if (this.formType) {
            try {
                section.appendChild(this._form(this.formType));
            } catch (error) {
                console.error('[GoalPlanner] Drawing the goal form failed:', error);
                section.appendChild(span('The form could not be drawn.', { display: 'block', color: COLORS.bad }));
            }
        }

        return section;
    }

    /**
     * The creation form for one goal type.
     * @param {string} type - A key of GOAL_TYPES
     * @returns {HTMLElement} The form
     */
    _form(type) {
        const form = document.createElement('div');
        Object.assign(form.style, {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: '6px',
            padding: '6px 8px',
            background: COLORS.card,
            borderRadius: '4px',
        });

        const gameData = dataManager.getInitClientData?.() || {};

        if (type === 'gold') {
            const amount = input({ placeholder: '500M', width: '110px' });
            form.append(span('Coins:', { color: COLORS.textDim }), amount);
            form.appendChild(
                button('Add', () => {
                    const value = parseKMB(amount.value) || Number(amount.value);
                    this.addGoal({ type: 'gold', amount: value });
                })
            );
            return form;
        }

        if (type === 'equipment') {
            const items = Object.entries(gameData.itemDetailMap || {})
                .filter(([_hrid, detail]) => detail?.equipmentDetail)
                .map(([hrid, detail]) => ({ hrid, name: detail.name || hrid }))
                .sort((a, b) => a.name.localeCompare(b.name));

            const listId = 'toolasha-planner-items';
            const datalist = document.createElement('datalist');
            datalist.id = listId;
            for (const item of items) {
                const option = document.createElement('option');
                option.value = item.name;
                datalist.appendChild(option);
            }
            form.appendChild(datalist);

            const name = input({ placeholder: 'Sinister Cape', list: listId, width: '160px' });
            const level = input({ type: 'number', value: '10', min: 0, max: 20, width: '54px' });
            form.append(span('Item:', { color: COLORS.textDim }), name, span('+', { color: COLORS.textDim }), level);
            form.appendChild(
                button('Add', () => {
                    const match = items.find((item) => item.name.toLowerCase() === name.value.trim().toLowerCase());
                    if (!match) {
                        this._status('No item by that name.');
                        return;
                    }
                    this.addGoal({
                        type: 'equipment',
                        itemHrid: match.hrid,
                        enhancementLevel: Number(level.value),
                    });
                })
            );
            return form;
        }

        if (type === 'skill') {
            const skills = (dataManager.getSkills?.() || []).map((skill) => ({
                value: skill.skillHrid,
                label: skill.skillHrid
                    .split('/')
                    .pop()
                    .replace(/^./, (c) => c.toUpperCase()),
            }));
            const picker = select(skills.length ? skills : [{ value: '', label: 'No skills loaded' }]);
            const level = input({ type: 'number', value: '100', min: 1, max: 200, width: '58px' });
            form.append(
                span('Skill:', { color: COLORS.textDim }),
                picker,
                span('to', { color: COLORS.textDim }),
                level
            );
            form.appendChild(
                button('Add', () => {
                    if (!picker.value) return;
                    this.addGoal({ type: 'skill', skillHrid: picker.value, targetLevel: Number(level.value) });
                })
            );
            return form;
        }

        const rooms = Object.entries(gameData.houseRoomDetailMap || {})
            .map(([hrid, detail]) => ({ value: hrid, label: detail?.name || hrid.split('/').pop() }))
            .sort((a, b) => a.label.localeCompare(b.label));
        const picker = select(rooms.length ? rooms : [{ value: '', label: 'No rooms loaded' }]);
        const level = input({ type: 'number', value: '8', min: 1, max: 8, width: '54px' });
        form.append(span('Room:', { color: COLORS.textDim }), picker, span('to', { color: COLORS.textDim }), level);
        form.appendChild(
            button('Add', () => {
                if (!picker.value) return;
                this.addGoal({ type: 'house', roomHrid: picker.value, targetLevel: Number(level.value) });
            })
        );
        return form;
    }

    /**
     * One goal, with its plan below it.
     * @param {Object} goal - A normalised goal
     * @param {Object|null} plan - Its plan, when one has been computed
     * @returns {HTMLElement} The card
     */
    _goalCard(goal, plan) {
        const card = document.createElement('div');
        Object.assign(card.style, {
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '5px',
            padding: '7px 9px',
            marginBottom: '9px',
            background: COLORS.card,
        });

        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            borderBottom: `1px solid ${COLORS.hairline}`,
            paddingBottom: '4px',
            marginBottom: '5px',
        });

        const title = span(plan?.title || describeGoal(goal), { fontWeight: 'bold', color: COLORS.accent });
        heading.appendChild(title);

        if (plan) {
            const done = plan.satisfied || plan.totals.stepsDone === plan.totals.stepCount;
            heading.appendChild(
                span(done ? 'done' : `${plan.totals.stepsDone}/${plan.totals.stepCount} steps`, {
                    color: done ? COLORS.good : COLORS.textDim,
                    fontSize: '11px',
                })
            );
        }

        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        heading.appendChild(spacer);
        heading.appendChild(
            button('✕', () => this.removeGoal(goal.id), {
                background: 'none',
                border: 'none',
                color: COLORS.textDim,
                padding: '0 2px',
            })
        );
        card.appendChild(heading);

        if (!plan) {
            card.appendChild(span('Not priced yet — press Refresh.', { display: 'block', color: COLORS.textDim }));
            return card;
        }

        for (const step of plan.steps) card.appendChild(this._stepRow(step));

        card.appendChild(this._totalsRow(plan));

        for (const warning of plan.confidence.warnings) {
            card.appendChild(span(`⚠ ${warning}`, { display: 'block', color: COLORS.warn, fontSize: '11px' }));
        }

        // The pricing note is the same sentence on every card, because every
        // card was priced by the same fetch. Repeated per goal it was four
        // copies of one fact taking up more room than some of the plans; it is
        // drawn once at the foot of the panel instead.
        return card;
    }

    /**
     * One step of a plan, and anything it wants to say underneath.
     *
     * The description wraps rather than being cut off at the column edge. It
     * used to be a nowrap ellipsis with the full text in a `title`, which meant
     * the only way to read a step was to hover a tooltip that then covered the
     * two steps below it — a plan you cannot read without hiding the plan.
     *
     * @param {Object} step - A plan step
     * @returns {HTMLElement} The row, or a wrapper when the step has legs
     */
    _stepRow(step) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr) 76px 92px',
            gap: '6px',
            alignItems: 'baseline',
            padding: '1px 0',
            opacity: step.done ? '0.5' : '1',
        });

        row.appendChild(span(KIND_GLYPH[step.kind] || '•', { color: COLORS.textDim }));

        const label = document.createElement('div');
        Object.assign(label.style, {
            minWidth: '0',
            overflowWrap: 'anywhere',
            textDecoration: step.done ? 'line-through' : 'none',
        });

        const description = span(step.description);
        const destination = navigationFor(step);
        if (destination) {
            // A dotted underline rather than a link colour: the accent is already
            // the goal title's, and a plan whose every other line is blue stops
            // reading as a plan
            Object.assign(description.style, {
                cursor: 'pointer',
                textDecorationLine: 'underline',
                textDecorationStyle: 'dotted',
                textUnderlineOffset: '2px',
                textDecorationColor: COLORS.textDim,
            });
            description.title = destination.title;
            description.addEventListener('click', () => this._goTo(destination));
        }
        label.appendChild(description);

        const shopping = shoppingFor(step);
        if (shopping) {
            const buy = button(
                shopping.label,
                () => {
                    try {
                        shopping.open();
                    } catch (error) {
                        console.error('[GoalPlanner] Opening the marketplace failed:', error);
                        this._status('The marketplace could not be opened — see the console.');
                    }
                },
                { marginLeft: '6px', padding: '0 6px', verticalAlign: 'baseline' }
            );
            buy.title = shopping.title;
            label.appendChild(buy);
        }

        // The planner has worked out how far along each step already is — 202M
        // of the 903M, Cheesesmithing 105 of 108 — and until now threw it away.
        // A hairline is the cheapest way to say it and does not cost a row.
        const bar = this._progressBar(step);
        if (bar) label.appendChild(bar);
        row.appendChild(label);

        row.appendChild(
            span(step.done ? '' : signedCoins(step.goldDelta), {
                textAlign: 'right',
                color: step.goldDelta > 0 ? COLORS.good : step.goldDelta < 0 ? COLORS.bad : COLORS.textDim,
            })
        );
        row.appendChild(
            span(step.done ? 'done' : duration(step.timeHours), { textAlign: 'right', color: COLORS.textDim })
        );

        const legs = Array.isArray(step.details?.legs) ? step.details.legs : [];
        const notes = Array.isArray(step.details?.ledgerNotes) ? step.details.ledgerNotes : [];
        if (step.done || (legs.length < 2 && !notes.length)) return row;

        // More than one method means the first one runs out, and *that* is the
        // thing worth seeing — a single sentence would have to bury it
        const wrapper = document.createElement('div');
        wrapper.appendChild(row);
        if (legs.length >= 2) for (const leg of legs) wrapper.appendChild(this._legRow(leg));

        // Why a method that would have won is not on offer. Without this the
        // goal below simply shows a worse rate, which reads as the planner
        // changing its mind rather than as the goal above having spent the stack.
        for (const note of notes) wrapper.appendChild(this._noteRow(note));
        return wrapper;
    }

    /**
     * Take the game to where a step points.
     *
     * The game's navigation is reached through the React root, which is not
     * always there — a failure has to say so on the panel rather than in the
     * console, because from the outside a click that did nothing is
     * indistinguishable from a click that missed.
     *
     * @param {{actionHrid: string}} destination - From {@link navigationFor}
     */
    _goTo(destination) {
        try {
            if (!navigateToAction(destination.actionHrid)) {
                this._status('The game would not navigate there.');
            }
        } catch (error) {
            console.error('[GoalPlanner] Navigating to an action failed:', error);
            this._status('The game would not navigate there — see the console.');
        }
    }

    /**
     * A line under a step explaining what an earlier goal already took.
     * @param {string} note - From the planner's resource ledger
     * @returns {HTMLElement} The row
     */
    _noteRow(note) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr)',
            gap: '6px',
            alignItems: 'baseline',
            color: COLORS.textDim,
            fontSize: '11px',
        });

        row.appendChild(span(''));
        const text = document.createElement('div');
        Object.assign(text.style, { minWidth: '0', overflowWrap: 'anywhere', paddingLeft: '10px' });
        text.appendChild(span(`↳ ${note}`));
        row.appendChild(text);
        return row;
    }

    /**
     * How far along a step already is, as a hairline under its description.
     *
     * Only where a fraction means something. A step is either done or not, so a
     * bar at 0% or 100% says nothing the row does not already say and is drawn
     * as nothing at all.
     *
     * @param {Object} step - A plan step
     * @returns {HTMLElement|null} The bar, or null when there is no progress to show
     */
    _progressBar(step) {
        const ratio = Number(step?.progress?.ratio);
        if (step.done || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;

        const track = document.createElement('div');
        Object.assign(track.style, {
            height: '2px',
            marginTop: '2px',
            borderRadius: '1px',
            background: 'rgba(255, 255, 255, 0.08)',
        });

        const fill = document.createElement('div');
        Object.assign(fill.style, {
            height: '100%',
            width: `${Math.round(ratio * 100)}%`,
            borderRadius: '1px',
            background: COLORS.accent,
        });
        track.appendChild(fill);

        const { current, target } = step.progress;
        track.title =
            Number.isFinite(current) && Number.isFinite(target)
                ? `${formatKMB(Math.round(current))} of ${formatKMB(Math.round(target))} — ${Math.round(ratio * 100)}%`
                : `${Math.round(ratio * 100)}%`;
        return track;
    }

    /**
     * One method inside an earning step: what it is, what it raises, how long for.
     * @param {Object} leg - From `planEarnings`
     * @returns {HTMLElement} The row
     */
    _legRow(leg) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr) 76px 92px',
            gap: '6px',
            alignItems: 'baseline',
            padding: '0 0 0 0',
            color: COLORS.textDim,
            fontSize: '11px',
        });

        row.appendChild(span(''));
        const text = document.createElement('div');
        Object.assign(text.style, { minWidth: '0', overflowWrap: 'anywhere', paddingLeft: '10px' });
        text.appendChild(span(`↳ ${describeLeg(leg)}`));
        row.appendChild(text);
        row.appendChild(span(signedCoins(leg.gold), { textAlign: 'right' }));
        row.appendChild(span(duration(leg.hours), { textAlign: 'right' }));

        return row;
    }

    /**
     * The bottom line of one plan.
     *
     * The number in the coin column is a *net*, and a bare "-202.0M" under a
     * heading that says "Remaining" reads as a debt rather than as the cost of
     * finishing. So the row says which two figures it is the difference of, and
     * the colour follows the sign of the net rather than pretending a plan that
     * costs money is going wrong.
     *
     * @param {Object} plan - A plan
     * @returns {HTMLElement} The row
     */
    _totalsRow(plan) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr) 76px 92px',
            gap: '6px',
            alignItems: 'baseline',
            borderTop: `1px solid ${COLORS.hairline}`,
            marginTop: '4px',
            paddingTop: '3px',
            fontWeight: 'bold',
        });

        const { goldEarn, goldSpend, netGold, timeKnown, timeHours } = plan.totals;
        const breakdown =
            goldEarn > 0 && goldSpend > 0
                ? ` — earn ${formatKMB(Math.round(goldEarn))}, spend ${formatKMB(Math.round(goldSpend))}`
                : '';

        row.appendChild(span(''));
        const label = span(plan.satisfied ? 'Already there' : `Left to do${breakdown}`, {
            overflowWrap: 'anywhere',
        });
        label.title = plan.satisfied
            ? 'Nothing outstanding on this goal.'
            : 'The steps not yet done: what they earn, what they cost, and the difference. ' +
              'A negative net is what finishing this goal costs you overall, not a debt.';
        row.appendChild(label);

        const net = span(signedCoins(netGold), {
            textAlign: 'right',
            color: netGold >= 0 ? COLORS.good : COLORS.bad,
        });
        net.title = `Net change in coins: ${signedCoins(netGold)}`;
        row.appendChild(net);

        row.appendChild(
            span(timeKnown ? duration(timeHours) : `${duration(timeHours)}+`, {
                textAlign: 'right',
            })
        );

        return row;
    }

    _remove() {
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
    }
}

export const goalPlannerPanel = new GoalPlannerPanel();

export default goalPlannerPanel;
