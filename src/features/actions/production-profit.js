/**
 * Production Profit Calculator
 *
 * Calculates comprehensive profit/hour for production actions (Brewing, Cooking, Crafting, Tailoring, Cheesesmithing)
 * Reuses existing profit calculator from tooltip system.
 */

import dataManager from '../../core/data-manager.js';
import profitCalculator from '../market/profit-calculator.js';

/**
 * Action types for production skills (5 skills)
 */
const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

/**
 * Calculate comprehensive profit for a production action
 * @param {string} actionHrid - Action HRID (e.g., "/actions/brewing/efficiency_tea")
 * @returns {Object|null} Profit data or null if not applicable
 */
export async function calculateProductionProfit(actionHrid) {
    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData.actionDetailMap[actionHrid];

    if (!actionDetail) {
        return null;
    }

    // Only process production actions with outputs
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) {
        return null;
    }

    if (!actionDetail.outputItems || actionDetail.outputItems.length === 0) {
        return null; // No output - nothing to calculate
    }

    // Note: Market API is pre-loaded by caller (max-produceable.js)
    // No need to check or fetch here

    // Get output item HRID
    const outputItemHrid = actionDetail.outputItems[0].itemHrid;

    // Reuse existing profit calculator (does all the heavy lifting).
    // The action is named as well as the item: two recipes can yield the same output, and
    // without the name the calculator answers about whichever it finds first — so a caller
    // filing this margin against `actionHrid` could be filing the other recipe's number.
    const profitData = await profitCalculator.calculateProfit(outputItemHrid, { actionHrid });

    if (!profitData) {
        return null;
    }

    return profitData;
}
