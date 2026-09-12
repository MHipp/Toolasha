/**
 * Crafting Plan Display
 * Renders the buy-vs-craft decision tree in action panels.
 * Shows a summary comparison plus a shopping list of materials to buy.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { openBillOwner, openMaterialsList } from '../actions/missing-materials-button.js';
import { computeBestCraftingPlan, collectMissingMaterials } from './crafting-plan-calculator.js';
import craftingPlanWalk, { buildWalkSteps, WALK_KEY_ATTRIBUTE } from './crafting-plan-walk.js';
import { createCollapsibleSection } from '../../utils/ui-components.js';
import { formatKMB, formatWithSeparator, timeReadable } from '../../utils/formatters.js';
import { findActionInput, onDetailPanel } from '../../utils/action-panel-helper.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import {
    effectiveInventoryRows,
    heldInInventory,
    releaseMissing,
    reservationNote,
    reserve,
    reservationsEnabled,
} from '../../utils/inventory-reservations.js';

const UI_ID = 'mwi-crafting-plan';

/**
 * Owner-id prefix for a crafting plan's claim on the bag.
 *
 * Keyed by the item the panel is planning, which is the only stable identity a
 * panel-borne plan has. Its own prefix, matched by nothing else in the ledger —
 * the merged task walk deliberately claims under `taskWalk:` — because the
 * sweep below releases everything under it that is not currently on screen.
 */
const RESERVATION_OWNER_PREFIX = 'craftingPlan:';

/** Marks a rendered plan section with the owner id it plans under. */
const PLAN_OWNER_ATTRIBUTE = 'data-mwi-plan-owner';

/**
 * The owner id a panel's plan claims under.
 * @param {string} itemHrid - The item being planned
 * @returns {string} Owner id
 */
function planOwner(itemHrid) {
    return `${RESERVATION_OWNER_PREFIX}${itemHrid}`;
}

/**
 * The plan a guided walk is standing on, if one is running.
 *
 * A walk navigates away from the action panel that started it, so the panel is
 * gone long before the plan is: without this the sweep would release the claim
 * of the very plan being walked, on the first step.
 */
let walkingOwner = null;

/**
 * Every plan owner the player can still be said to hold.
 *
 * A plan section mounted on screen, the plan a walk is running, and the plan
 * behind an open marketplace bill — clicking Buy Missing Materials unmounts the
 * panel by navigating, and the shopping trip that click opened is the plan
 * still being acted on.
 *
 * @returns {Array<string>} Owner ids that must survive a sweep
 */
function livePlanOwners() {
    const live = new Set();
    if (typeof document !== 'undefined') {
        for (const section of document.querySelectorAll(`[${PLAN_OWNER_ATTRIBUTE}]`)) {
            const owner = section.getAttribute(PLAN_OWNER_ATTRIBUTE);
            if (owner) live.add(owner);
        }
    }
    if (walkingOwner && craftingPlanWalk.active) live.add(walkingOwner);
    const bill = openBillOwner?.();
    if (typeof bill === 'string' && bill.startsWith(RESERVATION_OWNER_PREFIX)) live.add(bill);
    return [...live];
}

/**
 * Drop the claim of every plan that is no longer one of {@link livePlanOwners}.
 *
 * A crafting plan's claim lasts exactly as long as the plan does. Nothing used
 * to end one — the panel closing, the player moving to another item and the
 * script restarting all left the claim standing until the ledger's seven-day
 * sweep — so a player who had merely looked at a few plans accumulated owners
 * that held their bag back from every later plan, and the marketplace strip
 * reported materials "reserved" by plans that no longer existed.
 *
 * `releaseMissing` rather than a local delete: a release has to be an
 * observable deletion the sync carries (the ledger keeps tombstones for exactly
 * this), or the next pull from another device resurrects every claim just
 * dropped. It runs whether or not the ledger setting is on, as the ledger's own
 * release paths do — it can only ever remove a claim.
 *
 * @param {Array<string>} [live] - Owners to keep; defaults to what is on screen
 * @returns {Promise<number>} How many claims were dropped
 */
async function sweepPlanClaims(live = livePlanOwners()) {
    try {
        return await releaseMissing(RESERVATION_OWNER_PREFIX, live);
    } catch (error) {
        console.error('[CraftingPlan] Releasing stale plan claims failed:', error);
        return 0;
    }
}

/**
 * The reservation lines one plan claims: every tradeable material it is still
 * short, in the shape {@link reserve} expects.
 *
 * Shared by the Buy button and the guided walk's start — both are commitments
 * to the same plan, and deriving the claim twice would risk the two paths
 * disagreeing about what "this plan's materials" means.
 *
 * @param {Object} fullPlan - Root plan node from `computeBestCraftingPlan`
 * @param {string} itemHrid - The item this panel is planning, for the exclude-owner read
 * @returns {Array<{itemHrid: string, count: number}>} Lines for `reserve()`
 */
function missingMaterialLines(fullPlan, itemHrid) {
    // What this plan may actually claim: the bag less every OTHER owner's
    // claim, never its own — a plan that deducted its own claim would grow a
    // shortfall every time it recomputed
    const inventory = effectiveInventoryRows(dataManager.getInventory() || [], {
        excludeOwner: planOwner(itemHrid),
    });
    const missingMaterials = collectMissingMaterials(fullPlan, inventory).filter((material) => material.isTradeable);
    return missingMaterials.map((material) => ({ itemHrid: material.itemHrid, count: material.required }));
}

/**
 * One line naming who took the stock the plan would otherwise have spent.
 *
 * Deliberately silent when the bag holds none of the item anyway: a player who
 * is simply short of logs needs no explanation, and a line that fires either
 * way explains nothing. Empty string when the ledger is off or nothing is
 * claimed, so the caller can ask unconditionally.
 *
 * It names the claim and no shortfall, because this section has no shortfall to
 * name: the list it is drawn from is the plan for ONE unit of output, while the
 * Buy button re-plans for the whole run the panel is set to. Quoting a "short"
 * figure here put a per-unit number beside the marketplace strip's whole-run
 * one — two different shortfalls on screen for the same materials, which is
 * exactly the "random number" players reported.
 *
 * @param {Array<{itemHrid: string, itemName: string, quantity: number}>} items - The shopping list
 * @param {string} outputHrid - What this panel is planning, for its own owner id
 * @returns {string} The line, or `''`
 */
function reservedShoppingNote(items, outputHrid) {
    if (!reservationsEnabled()) return '';

    const excludeOwner = planOwner(outputHrid);
    for (const item of items) {
        if (!item?.itemHrid) continue;
        // Nothing of it in the bag means nobody's claim is what makes the plan buy it
        if (heldInInventory(item.itemHrid) <= 0) continue;
        const note = reservationNote(item.itemHrid, 0, { excludeOwner });
        if (note) return `${item.itemName}: ${note}`;
    }
    return '';
}

const PRICING_MODES = [
    { value: 'conservative', label: 'Instant Buy' },
    { value: 'hybrid', label: 'Instant Buy / Patient Sell' },
    { value: 'optimistic', label: 'Patient Buy / Patient Sell' },
    { value: 'patientBuy', label: 'Patient Buy' },
];

const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

/**
 * Get the primary output item for an action.
 * @param {Object} actionDetail
 * @returns {{ itemHrid: string, count: number }|null}
 */
function getPrimaryOutput(actionDetail) {
    if (!actionDetail?.outputItems?.length) return null;
    return actionDetail.outputItems[0];
}

/**
 * Get the pricing mode from user settings.
 * @returns {string}
 */
function getPricingMode() {
    return config.getSetting('profitCalc_pricingMode') || 'ask';
}

/**
 * Collect all leaf "buy" items from the plan tree into a flat shopping list.
 * Aggregates quantities for the same item across branches.
 * @param {Object} node - CraftingPlanNode
 * @param {Map} buyItems - Map of itemHrid → { itemName, quantity, unitCost, totalCost }
 */
function collectBuyItems(node, buyItems) {
    if (node.strategy === 'buy') {
        const existing = buyItems.get(node.itemHrid);
        if (existing) {
            existing.quantity += node.quantity;
            existing.totalCost += node.totalCost;
        } else {
            buyItems.set(node.itemHrid, {
                itemHrid: node.itemHrid,
                itemName: node.itemName,
                quantity: node.quantity,
                unitCost: node.unitCost,
                totalCost: node.totalCost,
            });
        }
        return;
    }

    for (const child of node.children) {
        collectBuyItems(child, buyItems);
    }
}

/**
 * Collect all "craft" steps from the plan tree.
 * @param {Object} node - CraftingPlanNode
 * @param {Array} craftSteps - Array to collect craft steps into
 */
function collectCraftSteps(node, craftSteps) {
    // Depth-first: collect children first so deepest crafts appear first
    for (const child of node.children) {
        collectCraftSteps(child, craftSteps);
    }

    if (node.strategy === 'craft' && node.actionHrid) {
        craftSteps.push({
            itemName: node.itemName,
            quantity: Math.ceil(node.quantity),
            actionsNeeded: node.actionsNeeded,
            actionHrid: node.actionHrid,
        });
    }
}

/**
 * Create a styled row with left label and right value.
 * @param {string} leftText
 * @param {string} rightText
 * @param {Object} [options]
 * @returns {HTMLElement}
 */
function createRow(leftText, rightText, options = {}) {
    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 0;
    `;

    const left = document.createElement('span');
    left.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    left.textContent = leftText;
    if (options.leftColor) left.style.color = options.leftColor;

    const right = document.createElement('span');
    right.style.cssText = 'flex-shrink: 0; white-space: nowrap;';
    right.textContent = rightText;
    if (options.rightColor) right.style.color = options.rightColor;

    row.appendChild(left);
    row.appendChild(right);
    // The guided walk marks the row of the step it is standing on, and finds it
    // by this key rather than by position — the tree is rebuilt on every toggle.
    if (options.walkKey) row.setAttribute(WALK_KEY_ATTRIBUTE, options.walkKey);
    return row;
}

/**
 * Build the full crafting plan UI for an action.
 * @param {string} actionHrid
 * @param {Function} [onToggle] - Callback when buy-intermediates toggle changes
 * @param {boolean} [defaultOpen=false] - Whether the section should be open
 * @returns {HTMLElement|null}
 */
export function buildPlanUI(actionHrid, onToggle, defaultOpen = false) {
    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData?.actionDetailMap?.[actionHrid];
    if (!actionDetail) return null;

    // Only production actions
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) return null;

    const output = getPrimaryOutput(actionDetail);
    if (!output) return null;

    const mode = getPricingMode();
    const buyIntermediates = config.getSetting('actionPanel_craftingPlanBuyIntermediates');
    const noProcessing = config.getSetting('actionPanel_craftingPlanNoProcessing');
    const taskMode = config.getSetting('actionPanel_craftingPlanTaskMode');
    const timeCostEnabled = config.getSetting('actionPanel_craftingPlanTimeCost');
    const goldPerHour = config.getSetting('actionPanel_craftingPlanGoldPerHour') || 0;
    const thinMarket = config.getSetting('actionPanel_craftingPlanThinMarket');
    let plan;
    try {
        plan = computeBestCraftingPlan(
            output.itemHrid,
            1,
            mode,
            new Set(),
            new Map(),
            0,
            undefined,
            buyIntermediates,
            taskMode,
            timeCostEnabled ? goldPerHour : 0,
            noProcessing,
            thinMarket
        );
    } catch (e) {
        console.error('[CraftingPlan] computeBestCraftingPlan error:', e);
        return null;
    }

    // Don't show if item has no production recipe (true raw material)
    if (plan.craftCost === null) return null;

    // Build content
    const content = document.createElement('div');

    // === Summary comparison ===
    const unitCostText = plan.unitCost === Infinity ? '?' : formatWithSeparator(Math.round(plan.unitCost));
    const buyText = plan.buyPrice !== null ? formatWithSeparator(Math.round(plan.buyPrice)) : 'N/A';
    const craftText = plan.craftCost !== null ? formatWithSeparator(Math.round(plan.craftCost)) : 'N/A';
    const strategyText = plan.strategy === 'buy' ? 'Buy from market' : 'Craft from materials';

    const summary = document.createElement('div');
    summary.style.cssText = 'margin-bottom: 6px;';
    summary.innerHTML = `
        <div style="display: flex; justify-content: space-between; color: var(--text-color-primary, #fff);">
            <span>Optimal: <strong>${strategyText}</strong></span>
            <span>${unitCostText}/ea</span>
        </div>
        <div style="display: flex; justify-content: space-between; color: var(--text-color-secondary, #888); font-size: 0.9em;">
            <span>Market buy: ${buyText}</span>
            <span>Craft cost: ${craftText}</span>
        </div>
    `;
    content.appendChild(summary);

    // === Pricing mode toggle ===
    const currentMode = PRICING_MODES.find((m) => m.value === mode) || PRICING_MODES[0];
    const pricingRow = document.createElement('div');
    pricingRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85em;
        color: var(--text-color-secondary, #888);
        margin-bottom: 4px;
    `;
    const pricingLabel = document.createElement('span');
    pricingLabel.textContent = 'Pricing:';
    const pricingBtn = document.createElement('button');
    pricingBtn.textContent = currentMode.label;
    pricingBtn.style.cssText = `
        font-size: 0.85em;
        padding: 1px 6px;
        background: var(--bg-color-tertiary, #1a1a1a);
        color: var(--text-color-secondary, #ccc);
        border: 1px solid var(--border-color, #444);
        border-radius: 3px;
        cursor: pointer;
    `;
    pricingBtn.addEventListener('click', () => {
        const idx = PRICING_MODES.findIndex((m) => m.value === mode);
        const next = PRICING_MODES[(idx + 1) % PRICING_MODES.length];
        config.setSetting('profitCalc_pricingMode', next.value);
        if (onToggle) onToggle();
    });
    pricingRow.appendChild(pricingLabel);
    pricingRow.appendChild(pricingBtn);
    content.appendChild(pricingRow);

    // === Buy intermediates toggle ===
    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85em;
        color: var(--text-color-secondary, #888);
        cursor: pointer;
        margin-bottom: 4px;
    `;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = buyIntermediates;
    checkbox.style.cssText = 'margin: 0; cursor: pointer;';
    checkbox.addEventListener('change', () => {
        config.setSetting('actionPanel_craftingPlanBuyIntermediates', checkbox.checked);
        if (onToggle) onToggle();
    });
    toggleRow.appendChild(checkbox);
    toggleRow.appendChild(document.createTextNode('Buy raw materials only'));
    content.appendChild(toggleRow);

    // === No processing toggle ===
    const noProcessingRow = document.createElement('label');
    noProcessingRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85em;
        color: var(--text-color-secondary, #888);
        cursor: pointer;
        margin-bottom: 4px;
    `;
    const noProcessingCheckbox = document.createElement('input');
    noProcessingCheckbox.type = 'checkbox';
    noProcessingCheckbox.checked = noProcessing;
    noProcessingCheckbox.style.cssText = 'margin: 0; cursor: pointer;';
    noProcessingCheckbox.addEventListener('change', () => {
        config.setSetting('actionPanel_craftingPlanNoProcessing', noProcessingCheckbox.checked);
        if (onToggle) onToggle();
    });
    noProcessingRow.appendChild(noProcessingCheckbox);
    noProcessingRow.appendChild(document.createTextNode('No processing (buy intermediates)'));
    content.appendChild(noProcessingRow);

    // === Task mode toggle ===
    const taskToggleRow = document.createElement('label');
    taskToggleRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85em;
        color: var(--text-color-secondary, #888);
        cursor: pointer;
        margin-bottom: 4px;
    `;
    const taskCheckbox = document.createElement('input');
    taskCheckbox.type = 'checkbox';
    taskCheckbox.checked = taskMode;
    taskCheckbox.style.cssText = 'margin: 0; cursor: pointer;';
    taskCheckbox.addEventListener('change', () => {
        config.setSetting('actionPanel_craftingPlanTaskMode', taskCheckbox.checked);
        if (onToggle) onToggle();
    });
    taskToggleRow.appendChild(taskCheckbox);
    taskToggleRow.appendChild(document.createTextNode('Task mode (force last step)'));
    content.appendChild(taskToggleRow);

    // === Time cost toggle ===
    const timeCostRow = document.createElement('label');
    timeCostRow.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85em;
        color: var(--text-color-secondary, #888);
        cursor: pointer;
        margin-bottom: 4px;
    `;
    const timeCostCheckbox = document.createElement('input');
    timeCostCheckbox.type = 'checkbox';
    timeCostCheckbox.checked = timeCostEnabled;
    timeCostCheckbox.style.cssText = 'margin: 0; cursor: pointer;';
    timeCostRow.appendChild(timeCostCheckbox);
    timeCostRow.appendChild(document.createTextNode('Factor in time cost'));

    const goldInput = document.createElement('input');
    goldInput.type = 'number';
    goldInput.value = goldPerHour || '';
    goldInput.placeholder = '500000';
    goldInput.style.cssText = `
        width: 80px; margin-left: auto; padding: 2px 4px;
        background: var(--input-bg, #1a1a2e); border: 1px solid var(--border-color, #333);
        border-radius: 3px; color: var(--text-color-primary, #fff); font-size: 0.85em;
    `;
    goldInput.style.display = timeCostEnabled ? '' : 'none';
    const goldLabel = document.createElement('span');
    goldLabel.textContent = 'gold/hr';
    goldLabel.style.fontSize = '0.85em';
    goldLabel.style.display = timeCostEnabled ? '' : 'none';

    timeCostCheckbox.addEventListener('change', () => {
        config.setSetting('actionPanel_craftingPlanTimeCost', timeCostCheckbox.checked);
        goldInput.style.display = timeCostCheckbox.checked ? '' : 'none';
        goldLabel.style.display = timeCostCheckbox.checked ? '' : 'none';
        if (onToggle) onToggle();
    });
    goldInput.addEventListener('change', () => {
        config.setSetting('actionPanel_craftingPlanGoldPerHour', parseInt(goldInput.value) || 0);
        if (onToggle) onToggle();
    });

    timeCostRow.appendChild(goldInput);
    timeCostRow.appendChild(goldLabel);
    content.appendChild(timeCostRow);

    // Only show breakdown if crafting is the optimal strategy
    if (plan.strategy !== 'craft' || plan.children.length === 0) {
        const costText = plan.unitCost === Infinity ? '?' : `${formatKMB(Math.round(plan.unitCost))}/ea`;
        const section = createCollapsibleSection('', 'Best Crafting Plan', costText, content, defaultOpen, 0);
        section.id = UI_ID;
        section.className = 'mwi-crafting-plan-section';
        // Marked even here, where no shopping list is drawn and so no claim can
        // be made: the mark is what says "a plan for this item is on screen",
        // and a plan the player is looking at must not have an older claim of
        // its own swept out from under it by the next panel to appear.
        section.setAttribute(PLAN_OWNER_ATTRIBUTE, planOwner(output.itemHrid));
        return section;
    }

    /**
     * Re-plan for the whole run the panel is set to, not the single unit the
     * section renders. The rendered plan's counts are already a whole action's
     * worth, rounded up, so scaling them overcounts a multi-output recipe by its
     * outputCount and compounds every per-unit round-up beneath it.
     * @param {HTMLElement} anchor - Any element inside the action panel
     * @returns {Object|null} The plan for the panel's own total, or null
     */
    const fullPlanForPanel = (anchor) => {
        const panel = anchor.closest('[class*="SkillActionDetail_skillActionDetail"]');
        const inputField = findActionInput(panel);
        const numActions = parseInt(inputField?.value) || 1;
        try {
            return computeBestCraftingPlan(
                output.itemHrid,
                numActions * (output.count || 1),
                mode,
                new Set(),
                new Map(),
                0,
                undefined,
                buyIntermediates,
                taskMode,
                timeCostEnabled ? goldPerHour : 0,
                noProcessing,
                thinMarket
            );
        } catch (e) {
            console.error('[CraftingPlan] computeBestCraftingPlan error:', e);
            return null;
        }
    };

    // === Shopping List (what to buy) ===
    const buyItems = new Map();
    collectBuyItems(plan, buyItems);

    if (buyItems.size > 0) {
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top: 1px solid var(--border-color, #333); margin: 6px 0;';
        content.appendChild(divider);

        const shoppingHeader = document.createElement('div');
        shoppingHeader.style.cssText = `
            font-weight: 500;
            color: var(--text-color-primary, #fff);
            margin-bottom: 4px;
        `;
        // Named with the scale it is at. These quantities are the ONE-unit plan
        // this section renders; the Buy button below re-plans for the panel's
        // own action count, so a player reading the list as the whole job
        // bought a fraction of what the run needed.
        const outputName = dataManager.getItemDetails(output.itemHrid)?.name || output.itemHrid.split('/').pop();
        shoppingHeader.textContent = `Shopping List (per 1 ${outputName})`;
        content.appendChild(shoppingHeader);

        // Sort by total cost descending
        const sortedItems = [...buyItems.entries()]
            .map(([itemHrid, item]) => ({ itemHrid, ...item }))
            .sort((a, b) => b.totalCost - a.totalCost);

        for (const item of sortedItems) {
            const qty = Math.ceil(item.quantity);
            const cost = formatKMB(Math.round(item.totalCost));
            const unit = formatWithSeparator(Math.round(item.unitCost));
            content.appendChild(
                createRow(`${item.itemName} x${formatWithSeparator(qty)}`, `${cost} (${unit}/ea)`, {
                    walkKey: `buy:${item.itemHrid}`,
                })
            );
        }

        // Total buy cost
        const totalBuyCost = sortedItems.reduce((sum, item) => sum + item.totalCost, 0);
        const totalRow = createRow('Total material cost', formatWithSeparator(Math.round(totalBuyCost)), {
            leftColor: 'var(--text-color-primary, #fff)',
        });
        totalRow.style.borderTop = '1px solid var(--border-color, #333)';
        totalRow.style.marginTop = '4px';
        totalRow.style.paddingTop = '4px';
        content.appendChild(totalRow);

        // === Buy Missing Materials button ===
        const buyButton = document.createElement('button');
        buyButton.textContent = 'Buy Missing Materials';
        buyButton.style.cssText = `
            width: 100%; margin-top: 6px; padding: 6px;
            background: linear-gradient(135deg, #1e40af, #3b82f6);
            border: 1px solid #60a5fa; border-radius: 4px;
            color: white; cursor: pointer; font-size: 0.85em;
        `;
        buyButton.addEventListener('click', async () => {
            const fullPlan = fullPlanForPanel(buyButton);
            if (!fullPlan) return;

            const lines = missingMaterialLines(fullPlan, output.itemHrid);
            if (lines.length === 0) return;

            // The click is the commitment: from here the plan holds what it
            // needs against every other plan until it is replaced or expires
            await reserve(planOwner(output.itemHrid), lines, {
                label: `Crafting plan: ${dataManager.getItemDetails(output.itemHrid)?.name || output.itemHrid}`,
            });

            // Route through the shared missing-mats mechanism so the tabs get
            // live inventory tracking: buying a material lowers its badge and
            // turns the tab green/"Sufficient", and re-arms only what is still
            // short — the same path the "Missing Mats Marketplace" button uses.
            // It navigates to the marketplace and subtracts inventory itself, so
            // pass the REQUIRED totals (not the shortfall) and let it recompute.
            await openMaterialsList(
                lines,
                // The claim above is this plan's; the tabs must net against
                // everyone else's and not against it, or the plan's own
                // materials would read as taken the moment they were claimed
                { ownerId: planOwner(output.itemHrid) }
            );
        });
        content.appendChild(buyButton);

        // A shopping list that is longer than the bag explains is a mystery
        // unless the panel says who took the stock
        const claimNote = reservedShoppingNote(sortedItems, output.itemHrid);
        if (claimNote) {
            const claimRow = document.createElement('div');
            claimRow.className = 'mwi-crafting-plan-reserved';
            claimRow.style.cssText = `
                margin-top: 6px; font-size: 0.8em; line-height: 1.35;
                color: var(--text-color-secondary, #e8a87c);
            `;
            claimRow.textContent = claimNote;
            content.appendChild(claimRow);
        }
    }

    // === Crafting Steps (what to craft, in order) ===
    const craftSteps = [];
    collectCraftSteps(plan, craftSteps);

    if (craftSteps.length > 0) {
        const divider2 = document.createElement('div');
        divider2.style.cssText = 'border-top: 1px solid var(--border-color, #333); margin: 6px 0;';
        content.appendChild(divider2);

        const stepsHeader = document.createElement('div');
        stepsHeader.style.cssText = `
            font-weight: 500;
            color: var(--text-color-primary, #fff);
            margin-bottom: 4px;
        `;
        stepsHeader.textContent = 'Crafting Steps';
        content.appendChild(stepsHeader);

        const gameData = dataManager.getInitClientData();
        const skills = dataManager.getSkills();
        const equipment = dataManager.getEquipment();
        let totalCraftSeconds = 0;
        let totalXP = 0;

        for (let i = 0; i < craftSteps.length; i++) {
            const step = craftSteps[i];
            const qty = formatWithSeparator(step.quantity);
            let timeStr = '';
            let xpStr = '';
            if (step.actionHrid) {
                const actionDetails = gameData?.actionDetailMap?.[step.actionHrid];
                if (actionDetails) {
                    const stats = calculateActionStats(actionDetails, {
                        skills,
                        equipment,
                        itemDetailMap: gameData.itemDetailMap,
                    });
                    const effMultiplier = calculateEfficiencyMultiplier(stats.totalEfficiency);
                    const totalSeconds = (stats.actionTime * step.actionsNeeded) / effMultiplier;
                    totalCraftSeconds += totalSeconds;
                    timeStr = ` (${timeReadable(totalSeconds)}`;
                }
                const expData = calculateExpPerHour(step.actionHrid);
                if (expData?.expPerHour > 0 && expData.actionsPerHour > 0) {
                    const xpPerAction = expData.expPerHour / expData.actionsPerHour;
                    totalXP += xpPerAction * step.actionsNeeded;
                    xpStr = ` · ${formatKMB(expData.expPerHour)} xp/hr`;
                }
                if (timeStr) {
                    timeStr += `${xpStr})`;
                } else if (xpStr) {
                    timeStr = ` (${xpStr.slice(3)})`;
                }
            }
            content.appendChild(
                createRow(`${i + 1}. ${step.itemName}`, `x${qty}${timeStr}`, {
                    walkKey: `craft:${step.actionHrid}`,
                })
            );
        }

        if (totalCraftSeconds > 0) {
            const totalTimeRow = createRow('Total craft time', timeReadable(totalCraftSeconds), {
                leftColor: 'var(--text-color-primary, #fff)',
            });
            totalTimeRow.style.borderTop = '1px solid var(--border-color, #333)';
            totalTimeRow.style.marginTop = '4px';
            totalTimeRow.style.paddingTop = '4px';
            content.appendChild(totalTimeRow);
        }

        if (totalXP > 0) {
            content.appendChild(
                createRow('Total XP', formatKMB(Math.round(totalXP)), {
                    leftColor: 'var(--text-color-primary, #fff)',
                })
            );
        }

        if (config.getSetting('craftingPlan_guidedWalk')) {
            const walkButton = document.createElement('button');
            walkButton.textContent = 'Start guided walk';
            walkButton.style.cssText = `
                width: 100%; margin-top: 6px; padding: 6px;
                background: var(--bg-color-tertiary, #1a1a2e);
                border: 1px solid var(--border-color, #60a5fa); border-radius: 4px;
                color: var(--text-color-primary, #fff); cursor: pointer; font-size: 0.85em;
            `;
            walkButton.addEventListener('click', async () => {
                // The walk steps the real run, not the single unit this section
                // renders, so it plans against the panel's own count first.
                const fullPlan = fullPlanForPanel(walkButton);
                if (!fullPlan) return;
                const steps = buildWalkSteps(fullPlan);
                if (steps.length === 0) return;

                // Starting the walk is at least as much a commitment to the
                // plan as clicking Buy Missing Materials: claim the same
                // lines under the same owner so another plan sees this one's
                // materials as taken from the moment the walk begins, not
                // only once the player manually buys them. A no-op while the
                // ledger setting is off — `reserve()` itself gates on it.
                const reserveClaim = () =>
                    reserve(planOwner(output.itemHrid), missingMaterialLines(fullPlan, output.itemHrid), {
                        label: `Crafting plan: ${dataManager.getItemDetails(output.itemHrid)?.name || output.itemHrid}`,
                    });
                await reserveClaim();

                // Shrink the claim as the walk consumes it. `missingMaterialLines`
                // is inventory-driven, not step-driven: `collectMissingMaterials`
                // credits a craft node against whatever of its item the bag
                // currently holds, so re-running it against `fullPlan` after a
                // craft step has actually landed in the game (the intermediate
                // now held, the raw materials it took now gone) yields exactly
                // the requirement for what is left, with no separate
                // partial-progress bookkeeping needed. Re-running it after a buy
                // step would be redundant — a bought material is still on this
                // plan's shopping list, `reserve()` just now sees more of it held.
                let previousStep = null;
                craftingPlanWalk.onStepAboutToRun = (step) => {
                    if (previousStep?.kind === 'craft') {
                        reserveClaim().catch((error) =>
                            console.error('[CraftingPlan] Re-reserving after a craft step failed:', error)
                        );
                    }
                    previousStep = step;
                };

                // The walk outlives the panel that started it — it navigates
                // away from it on the first step — so the claim it just made
                // has to survive the sweep that panel's removal triggers
                walkingOwner = planOwner(output.itemHrid);
                craftingPlanWalk.start(steps);
            });
            content.appendChild(walkButton);
        }
    }

    const costText = plan.unitCost === Infinity ? '?' : `${formatKMB(Math.round(plan.unitCost))}/ea`;
    const section = createCollapsibleSection('', 'Best Crafting Plan', costText, content, defaultOpen, 0);
    section.id = UI_ID;
    section.className = 'mwi-crafting-plan-section';
    section.setAttribute(PLAN_OWNER_ATTRIBUTE, planOwner(output.itemHrid));

    return section;
}

class CraftingPlanDisplay {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.processedPanels = new WeakSet();
        this.panelObservers = new WeakMap();
        this.activeObservers = new Set();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('actionPanel_bestCraftingPlan')) return;

        this.isInitialized = true;

        // Nothing is on screen yet, so this drops every plan owner in the
        // ledger. That is the point: a claim lasts as long as the plan panel
        // does, and a claim that survived into a new session (or a character
        // switch, which re-runs this) belongs to a panel that closed long ago.
        // It is also what clears the backlog players are already carrying.
        sweepPlanClaims([]);

        const unregister = onDetailPanel((context) => this._processPanel(context));
        this.unregisterHandlers.push(unregister);
    }

    /**
     * Attach to one action panel, once
     * @param {import('../../utils/action-panel-helper.js').ActionPanelContext} context
     */
    _processPanel({ panel, actionHrid }) {
        if (this.processedPanels.has(panel)) return;
        if (!actionHrid) return;

        this.processedPanels.add(panel);
        this._attachToPanel(panel, actionHrid);
        // A new panel means the last one is on its way out (the game shows one
        // detail panel at a time), so the plan it held goes with it. Swept
        // after the attach, so this panel's own section is already mounted and
        // counts as live.
        sweepPlanClaims();
    }

    /**
     * Release the plan's claim once its panel has left the document.
     *
     * The panel's own subtree cannot report this — it is removed whole, and an
     * observer inside it never fires — so the watch is on the parent it was
     * removed from, childList only.
     * @param {HTMLElement} panel - The action detail panel
     */
    _watchForPanelClose(panel) {
        const parent = panel.parentNode;
        if (!parent) return;
        const obs = new MutationObserver(() => {
            if (panel.isConnected) return;
            obs.disconnect();
            this.activeObservers.delete(obs);
            sweepPlanClaims();
        });
        obs.observe(parent, { childList: true });
        this.activeObservers.add(obs);
    }

    _attachToPanel(panel, actionHrid) {
        const rebuild = () => {
            const existing = panel.querySelector(`#${UI_ID}`);
            const wasOpen = existing?.querySelector('.mwi-section-header span')?.textContent === '▼';
            if (existing) existing.remove();

            const newUI = buildPlanUI(actionHrid, rebuild, wasOpen);
            if (!newUI) return;

            const profitSection = panel.querySelector('[data-mwi-profit-display]');
            if (profitSection) {
                profitSection.parentNode.insertBefore(newUI, profitSection);
            } else {
                panel.appendChild(newUI);
            }
        };

        const ui = buildPlanUI(actionHrid, rebuild);
        if (!ui) return;

        const position = () => {
            if (!this.isInitialized) return;
            const existing = panel.querySelector(`#${UI_ID}`);
            // Insert before Profitability section
            const profitSection = panel.querySelector('[data-mwi-profit-display]');

            if (profitSection) {
                if (existing) {
                    if (existing.nextElementSibling !== profitSection) {
                        profitSection.parentNode.insertBefore(existing, profitSection);
                    }
                } else {
                    profitSection.parentNode.insertBefore(ui, profitSection);
                }
                return;
            }

            // Fallback: append to panel
            if (!existing) panel.appendChild(ui);
        };

        position();

        // Watch for profit section or crafting plan being added/removed
        const observeTarget = ui.parentNode || panel;
        const obs = new MutationObserver((mutations) => {
            const relevant = mutations.some((m) =>
                [...m.addedNodes, ...m.removedNodes].some(
                    (n) => n.id === UI_ID || (n.getAttribute && n.getAttribute('data-mwi-profit-display'))
                )
            );
            if (relevant) position();
        });
        obs.observe(observeTarget, { childList: true, subtree: true });
        this.panelObservers.set(panel, obs);
        this.activeObservers.add(obs);
        this._watchForPanelClose(panel);
    }

    disable() {
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];

        // Disconnect panel observers BEFORE removing UI, so removal doesn't retrigger position()
        this.activeObservers.forEach((obs) => obs.disconnect());
        this.activeObservers.clear();
        this.isInitialized = false;

        document.querySelectorAll(`#${UI_ID}`).forEach((el) => el.remove());

        // Every plan panel is gone by this route as surely as by its own, and
        // the claims behind them go with it — including a walk's, because the
        // walk is torn down alongside this feature. Runs on a character switch
        // too, where it fires before the id moves, so it releases against the
        // character whose bag the claims were on.
        walkingOwner = null;
        sweepPlanClaims([]);

        this.panelObservers = new WeakMap();
        this.processedPanels = new WeakSet();
    }
}

const craftingPlanDisplay = new CraftingPlanDisplay();
export default craftingPlanDisplay;
