/**
 * Crafting Plan Display
 * Renders the buy-vs-craft decision tree in action panels.
 * Shows a summary comparison plus a shopping list of materials to buy.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { openMaterialsList } from '../actions/missing-materials-button.js';
import { computeBestCraftingPlan, collectMissingMaterials } from './crafting-plan-calculator.js';
import craftingPlanWalk, { buildWalkSteps, WALK_KEY_ATTRIBUTE } from './crafting-plan-walk.js';
import { createCollapsibleSection } from '../../utils/ui-components.js';
import { formatKMB, formatWithSeparator, timeReadable } from '../../utils/formatters.js';
import { findActionInput, onDetailPanel } from '../../utils/action-panel-helper.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';

const UI_ID = 'mwi-crafting-plan';

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
        shoppingHeader.textContent = 'Shopping List';
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

            const inventory = dataManager.getInventory() || [];
            const missingMaterials = collectMissingMaterials(fullPlan, inventory).filter(
                (material) => material.isTradeable
            );

            if (missingMaterials.length === 0) return;

            // Route through the shared missing-mats mechanism so the tabs get
            // live inventory tracking: buying a material lowers its badge and
            // turns the tab green/"Sufficient", and re-arms only what is still
            // short — the same path the "Missing Mats Marketplace" button uses.
            // It navigates to the marketplace and subtracts inventory itself, so
            // pass the REQUIRED totals (not the shortfall) and let it recompute.
            await openMaterialsList(
                missingMaterials.map((material) => ({ itemHrid: material.itemHrid, count: material.required }))
            );
        });
        content.appendChild(buyButton);
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
            walkButton.addEventListener('click', () => {
                // The walk steps the real run, not the single unit this section
                // renders, so it plans against the panel's own count first.
                const fullPlan = fullPlanForPanel(walkButton);
                if (!fullPlan) return;
                craftingPlanWalk.start(buildWalkSteps(fullPlan));
            });
            content.appendChild(walkButton);
        }
    }

    const costText = plan.unitCost === Infinity ? '?' : `${formatKMB(Math.round(plan.unitCost))}/ea`;
    const section = createCollapsibleSection('', 'Best Crafting Plan', costText, content, defaultOpen, 0);
    section.id = UI_ID;
    section.className = 'mwi-crafting-plan-section';

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
    }

    disable() {
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];

        // Disconnect panel observers BEFORE removing UI, so removal doesn't retrigger position()
        this.activeObservers.forEach((obs) => obs.disconnect());
        this.activeObservers.clear();
        this.isInitialized = false;

        document.querySelectorAll(`#${UI_ID}`).forEach((el) => el.remove());

        this.panelObservers = new WeakMap();
        this.processedPanels = new WeakSet();
    }
}

const craftingPlanDisplay = new CraftingPlanDisplay();
export default craftingPlanDisplay;
