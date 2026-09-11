/**
 * Cost Summary
 * Compact 4-line cost comparison block for production action panels.
 * Shows: direct recipe cost, missing direct mats cost, best crafting plan
 * cost, and finished item market price for the selected produce quantity.
 */

import config from '../../core/config.js';
import {
    findActionInput,
    attachInputListeners,
    performInitialUpdate,
    onActionPanelsRefresh,
    onDetailPanel,
    resolveDetailPanel,
} from '../../utils/action-panel-helper.js';
import { calculateMaterialRequirements } from '../../utils/material-calculator.js';
import { getItemPrice, formatPrice } from '../../utils/market-data.js';
import { computeBestCraftingPlan } from '../../features/crafting-plan/crafting-plan-calculator.js';

const UI_ID = 'mwi-cost-summary';

const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

let domObserverUnregister = null;
let processedPanels = new WeakSet();
let unsubscribeRefresh = null;

export function initialize() {
    domObserverUnregister = onDetailPanel((context) => processActionPanel(context.panel));
    // The missing-mats cost reads the action queue; a finite queue change must
    // redraw a panel already on screen
    unsubscribeRefresh = onActionPanelsRefresh((panel, value) => updatePanel(panel, value));
    processActionPanels();
}

export function cleanup() {
    if (domObserverUnregister) {
        domObserverUnregister();
        domObserverUnregister = null;
    }
    if (unsubscribeRefresh) {
        unsubscribeRefresh();
        unsubscribeRefresh = null;
    }
    document.querySelectorAll(`#${UI_ID}`).forEach((el) => el.remove());
    processedPanels = new WeakSet();
}

function processActionPanels() {
    const panels = document.querySelectorAll('[class*="SkillActionDetail_skillActionDetail"]');
    panels.forEach((panel) => processActionPanel(panel));
}

/**
 * Attach to one action panel, once
 * @param {HTMLElement} panel
 */
function processActionPanel(panel) {
    if (processedPanels.has(panel)) return;
    const inputField = findActionInput(panel);
    if (!inputField) return;
    processedPanels.add(panel);
    attachInputListeners(panel, inputField, (value) => updatePanel(panel, value));
    performInitialUpdate(inputField, (value) => updatePanel(panel, value));
}

function updatePanel(panel, value) {
    const existing = panel.querySelector(`#${UI_ID}`);
    if (existing) existing.remove();

    if (!config.getSetting('actions_costSummary')) return;

    const numActions = parseInt(value) || 0;
    if (numActions <= 0) return;

    const { actionHrid, actionDetails: actionDetail } = resolveDetailPanel(panel);
    if (!actionHrid) return;
    if (!actionDetail) return;
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) return;
    if (!actionDetail.inputItems || actionDetail.inputItems.length === 0) return;

    const output = actionDetail.outputItems?.[0];
    const outputHrid = output?.itemHrid || null;
    const outputCount = (output?.count || 1) * numActions;

    const block = buildBlock(actionHrid, numActions, outputHrid, outputCount);
    insertBlock(panel, block);
}

function insertBlock(panel, block) {
    const budgetCalc = panel.querySelector('#mwi-budget-calculator');
    const missingMatsBtn = panel.querySelector('#mwi-missing-mats-button');
    const itemRequirements = panel.querySelector('[class*="SkillActionDetail_itemRequirements"]');

    if (budgetCalc) {
        budgetCalc.parentNode.insertBefore(block, budgetCalc);
    } else if (missingMatsBtn) {
        missingMatsBtn.parentNode.insertBefore(block, missingMatsBtn.nextSibling);
    } else if (itemRequirements) {
        itemRequirements.parentNode.insertBefore(block, itemRequirements.nextSibling);
    } else {
        panel.appendChild(block);
    }
}

/**
 * Sum a material list into direct-cost and missing-cost totals.
 *
 * Coin is priced at exactly 1 whatever its own `isTradeable` flag says — it
 * has no market listing to look up (you cannot list currency on the
 * marketplace) and would otherwise fall through the "no price" branch and be
 * quietly dropped from the total. Some tier-0 recipes pay their upgrade slot
 * in coin outright, same as {@link module:profit-calculator} special-cases it,
 * and a recipe like that was undercounting its own direct cost by however much
 * coin it required, with no partial-data marker to say so.
 *
 * @param {Array<Object>} materials - From {@link calculateMaterialRequirements}
 * @returns {{directCost: number, missingCost: number, directComplete: boolean, missingComplete: boolean}}
 */
export function computeDirectCosts(materials) {
    let directCost = 0;
    let missingCost = 0;
    let directComplete = true;
    let missingComplete = true;

    for (const mat of materials) {
        if (mat.itemHrid === '/items/coin') {
            directCost += mat.required;
            missingCost += mat.missing;
            continue;
        }
        if (!mat.isTradeable) continue;
        const unitPrice = getItemPrice(mat.itemHrid, { context: 'profit', side: 'buy' });
        if (unitPrice === null) {
            if (mat.required > 0) directComplete = false;
            if (mat.missing > 0) missingComplete = false;
            continue;
        }
        directCost += unitPrice * mat.required;
        missingCost += unitPrice * mat.missing;
    }

    return { directCost, missingCost, directComplete, missingComplete };
}

function buildBlock(actionHrid, numActions, outputHrid, outputCount) {
    const materials = calculateMaterialRequirements(actionHrid, numActions, true);
    const { directCost, missingCost, directComplete, missingComplete } = computeDirectCosts(materials);

    let planCost = null;
    if (outputHrid) {
        try {
            const pricingMode = config.getSetting('profitCalc_pricingMode') || 'hybrid';
            const plan = computeBestCraftingPlan(outputHrid, outputCount, pricingMode);
            if (plan && plan.totalCost !== Infinity && plan.totalCost !== null) {
                planCost = plan.totalCost;
            }
        } catch (error) {
            console.error('[CostSummary] computeBestCraftingPlan error:', error);
        }
    }

    let marketCost = null;
    if (outputHrid) {
        const unitSellPrice = getItemPrice(outputHrid, { context: 'profit', side: 'sell' });
        if (unitSellPrice !== null) {
            marketCost = unitSellPrice * outputCount;
        }
    }

    const pricingMode = config.getSetting('profitCalc_pricingMode') || 'hybrid';
    const pricingLabel = config.getPricingModeLabel(pricingMode);

    return renderBlock({
        directCost,
        directComplete,
        missingCost,
        missingComplete,
        planCost,
        marketCost,
        pricingLabel,
    });
}

function renderBlock({ directCost, directComplete, missingCost, missingComplete, planCost, marketCost, pricingLabel }) {
    const container = document.createElement('div');
    container.id = UI_ID;
    container.style.cssText = `
        margin: 8px 0 16px 0;
        padding: 10px 14px;
        /* Without this the padding and border are added to a full-width block,
           so the card renders thirty pixels wider than the column holding it —
           which is what put a horizontal scrollbar across the action panel */
        box-sizing: border-box;
        max-width: 100%;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.12) 0%, rgba(91, 141, 239, 0.05) 100%);
        border: 1px solid rgba(91, 141, 239, 0.3);
        border-radius: 8px;
        color: #ffffff;
        font-size: 13px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    `;

    const header = document.createElement('div');
    header.textContent = 'Cost Summary';
    header.style.cssText = `
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 6px;
        color: #93c5fd;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    `;
    container.appendChild(header);

    container.appendChild(renderLine('Direct recipe cost', directCost, !directComplete));
    container.appendChild(renderLine('Missing direct mats', missingCost, !missingComplete));
    container.appendChild(renderLine('Best crafting plan', planCost));
    container.appendChild(renderLine('Finished item market', marketCost));

    const footer = document.createElement('div');
    footer.textContent = `Pricing: ${pricingLabel}`;
    footer.style.cssText = `
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid rgba(91, 141, 239, 0.2);
        font-size: 11px;
        color: #94a3b8;
    `;
    container.appendChild(footer);

    return container;
}

function renderLine(label, value, partial = false) {
    const row = document.createElement('div');
    row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        line-height: 1.5;
    `;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    labelEl.style.color = '#cbd5e1';
    const valueEl = document.createElement('span');
    if (value === null || value === undefined || value === 0) {
        valueEl.textContent = '—';
        valueEl.style.color = '#64748b';
    } else {
        valueEl.textContent = formatPrice(value, { decimals: 1 }) + (partial ? '*' : '');
        valueEl.style.color = '#e2e8f0';
        valueEl.style.fontVariantNumeric = 'tabular-nums';
        if (partial) {
            valueEl.title = 'Partial — some materials have no market data';
        }
    }
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
}

export default {
    initialize,
    cleanup,
};
