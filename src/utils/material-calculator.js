/**
 * Material Calculator Utility
 * Shared calculation logic for material requirements with artisan bonus
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { parseArtisanBonus, getDrinkConcentration } from './tea-parser.js';
import { getEnhancingParams } from './enhancement-config.js';
import { calculateEnhancement } from './enhancement-calculator.js';
import { resolveActionContext } from './action-context.js';
import { reservedElsewhere, shortfallNote } from './inventory-reservations.js';

export const ARTISAN_MATERIAL_MODE = {
    EXPECTED: 'expected',
    WORST_CASE: 'worst-case',
    HYBRID: 'hybrid',
};

// Below this many actions the per-craft ceiling has not had room to average out, so hybrid mode
// keeps worst-case rounding; at or above it the expected value is within a unit or two of reality.
const HYBRID_WORST_CASE_MAX_ACTIONS = 100;

function normalizeArtisanMode(mode) {
    if (mode === ARTISAN_MATERIAL_MODE.WORST_CASE || mode === ARTISAN_MATERIAL_MODE.HYBRID) {
        return mode;
    }
    return ARTISAN_MATERIAL_MODE.EXPECTED;
}

/**
 * Get artisan material mode setting.
 * @returns {string}
 */
function getArtisanMaterialMode() {
    const setting = config.getSettingValue('actions_artisanMaterialMode', ARTISAN_MATERIAL_MODE.EXPECTED);
    return normalizeArtisanMode(setting);
}
/**
 * Calculate total materials required, optionally using conservative per-action rounding.
 * @param {number} basePerAction
 * @param {number} artisanBonus
 * @param {number} numActions
 * @param {string} artisanMode
 * @returns {number}
 */
function calculateTotalRequired(basePerAction, artisanBonus, numActions, artisanMode) {
    const materialsPerAction = basePerAction * (1 - artisanBonus);
    // Unbounded queues are never below the threshold, so hybrid resolves to expected value there.
    const useWorstCase =
        artisanMode === ARTISAN_MATERIAL_MODE.WORST_CASE ||
        (artisanMode === ARTISAN_MATERIAL_MODE.HYBRID && numActions < HYBRID_WORST_CASE_MAX_ACTIONS);
    if (useWorstCase) {
        return Math.ceil(materialsPerAction) * numActions;
    }
    return Math.ceil(materialsPerAction * numActions);
}

/**
 * How many actions a held stack affords at a possibly fractional per-action cost.
 *
 * A plain `Math.floor(available / perAction)` trips over IEEE division when the
 * artisan reduction makes the per-action cost fractional: `8880 / 8.88` evaluates
 * to `999.9999999999999`, and the panel says 999 crafts when the bag holds
 * exactly 1000 actions' worth. The nudge is thousands of ULPs — far larger than
 * any accumulated division error — while claiming a spurious extra action would
 * need the stack to be within one trillionth of a whole action, which integer
 * inventories cannot produce.
 *
 * @param {number} available - Units held
 * @param {number} perAction - Units consumed per action (may be fractional)
 * @returns {number} Whole actions affordable; Infinity when the action consumes none
 */
export function affordableActions(available, perAction) {
    if (!(perAction > 0)) return Infinity;
    const ratio = available / perAction;
    return Math.floor(ratio + ratio * 1e-12 + 1e-12);
}

/**
 * Calculate materials reserved by queued actions
 * @param {string} actionHrid - Action HRID to check queue for (optional - if null, calculates for ALL queued actions)
 * @returns {Map<string, number>} Map of itemHrid -> queued quantity
 */
export function calculateQueuedMaterialsForAction(actionHrid = null) {
    const queuedMaterials = new Map();
    const gameData = dataManager.getInitClientData();

    if (!gameData) {
        return queuedMaterials;
    }

    // Get all queued actions
    const queuedActions = dataManager.getCurrentActions();

    if (!queuedActions || queuedActions.length === 0) {
        return queuedMaterials;
    }

    const artisanMode = getArtisanMaterialMode();

    // Process each queued action
    for (const queuedAction of queuedActions) {
        // If actionHrid is specified, only process matching actions
        if (actionHrid && queuedAction.actionHrid !== actionHrid) {
            continue;
        }

        const actionDetails = dataManager.getActionDetails(queuedAction.actionHrid);
        if (!actionDetails) {
            continue;
        }

        // Calculate remaining actions for this queued action
        // Finite actions: maxCount is target, currentCount is progress
        // Infinite actions: Skip for now (would require material limit calculation which is complex)
        let actionCount = 0;
        if (queuedAction.hasMaxCount) {
            actionCount = queuedAction.maxCount - queuedAction.currentCount;
        } else {
            // Infinite action - skip for now (materials for infinite actions are complex)
            // User can use the "Ignore queue" setting if they queue many infinite actions
            continue;
        }

        if (actionCount <= 0) {
            continue;
        }

        // Calculate artisan bonus for this action type
        const artisanBonus = calculateArtisanBonus(actionDetails);

        // Process regular input items
        if (actionDetails.inputItems && actionDetails.inputItems.length > 0) {
            for (const input of actionDetails.inputItems) {
                const basePerAction = input.count || input.amount || 1;

                // Calculate total materials needed for this queued action
                const totalForAction = calculateTotalRequired(basePerAction, artisanBonus, actionCount, artisanMode);

                // Add to queued total
                const currentQueued = queuedMaterials.get(input.itemHrid) || 0;
                queuedMaterials.set(input.itemHrid, currentQueued + totalForAction);
            }
        }

        // Process upgrade item (if exists)
        if (actionDetails.upgradeItemHrid) {
            // Upgrade items always need exactly 1 per action, no artisan reduction
            const totalForAction = actionCount;

            const currentQueued = queuedMaterials.get(actionDetails.upgradeItemHrid) || 0;
            queuedMaterials.set(actionDetails.upgradeItemHrid, currentQueued + totalForAction);
        }
    }

    return queuedMaterials;
}

/**
 * Calculate material requirements for an action
 * @param {string} actionHrid - Action HRID (e.g., "/actions/crafting/celestial_enhancer")
 * @param {number} numActions - Number of actions to perform
 * @param {boolean} accountForQueue - Whether to subtract queued materials from available inventory (default: false)
 * @param {Object} [options] - Options
 * @param {string|null} [options.ownerId] - Who is asking, for the reservation ledger. Omitted
 *   is how every caller that predates the ledger calls this, and it must go on meaning
 *   "the ledger is not part of this figure" — so no claim is deducted without one, and
 *   none is deducted with one either while the ledger is switched off
 * @returns {Array<Object>} Array of material requirement objects (includes upgrade items)
 */
/**
 * Items a buy order has already bought for `itemHrid`, still sitting unclaimed
 * on the listing rather than in the inventory. Counting them keeps every
 * "Missing" figure falling while an order fills instead of only after the
 * claim; a claim moves them to the inventory and drops this by the same
 * amount, so nothing is counted twice.
 *
 * @param {string} itemHrid - Item
 * @returns {number} Unclaimed bought units across the character's buy listings
 */
export function unclaimedBoughtCount(itemHrid) {
    const listings = dataManager.getMarketListings?.() || [];
    return listings
        .filter((l) => l && !l.isSell && l.itemHrid === itemHrid && !(l.enhancementLevel > 0))
        .reduce((sum, l) => sum + (l.unclaimedItemCount || 0), 0);
}

/**
 * The two fields a material line carries only when another plan's claim is what
 * put it short.
 *
 * Carried conditionally, so a line computed without a reservation ledger is the
 * object it has always been — which is what lets every existing consumer, and
 * every existing snapshot of one, go on unchanged.
 *
 * @param {number} missing - The shortfall as computed
 * @param {string} itemHrid - The material
 * @param {number} required - Units the action needs in total
 * @param {number} have - Units held (including bought-but-unclaimed)
 * @param {number} queued - Units the action queue has spoken for
 * @param {number} reserved - Units other owners have claimed
 * @param {string|null} ownerId - Who is asking
 * @returns {{reserved?: number, reservedNote?: string}} Fields to spread onto the line
 */
function reservationFields(missing, itemHrid, required, have, queued, reserved, ownerId) {
    if (!(reserved > 0) || !(missing > 0)) return {};
    // Only when the claim is what made it short: a player who is simply out of
    // logs needs no explanation, and a note that fires either way explains
    // nothing. That is exactly "the bag, less the queue, covers the whole
    // requirement" — the same test the two sibling notes use. `missing +
    // reserved` is not that number and suppressed the commonest case of all: a
    // bag holding precisely what the action needs, every unit of it claimed.
    if (Math.max(0, have - queued) < required) return { reserved };
    const reservedNote = shortfallNote(missing, itemHrid, 0, { excludeOwner: ownerId });
    return reservedNote ? { reserved, reservedNote } : { reserved };
}

export function calculateMaterialRequirements(
    actionHrid,
    numActions,
    accountForQueue = false,
    { ownerId = null } = {}
) {
    const actionDetails = dataManager.getActionDetails(actionHrid);
    const inventory = dataManager.getInventory() || [];
    const gameData = dataManager.getInitClientData();

    if (!actionDetails) {
        return [];
    }

    const artisanMode = getArtisanMaterialMode();

    // Calculate artisan bonus (material reduction from Artisan Tea)
    const artisanBonus = calculateArtisanBonus(actionDetails);

    // Get queued materials if accounting for queue
    // Pass null to get materials for ALL queued actions (not just matching actionHrid)
    const queuedMaterialsMap = accountForQueue ? calculateQueuedMaterialsForAction(null) : new Map();

    const materials = [];

    // Process regular input items first
    if (actionDetails.inputItems && actionDetails.inputItems.length > 0) {
        for (const input of actionDetails.inputItems) {
            const basePerAction = input.count || input.amount || 1;

            // Calculate total materials needed for requested actions
            const totalRequired = calculateTotalRequired(basePerAction, artisanBonus, numActions, artisanMode);

            // Only count unenhanced items — enhanced copies are distinct items the player
            // would not want consumed as crafting materials. Bought-but-unclaimed
            // units on the player's own buy orders count too (see unclaimedBoughtCount).
            const have =
                unclaimedBoughtCount(input.itemHrid) +
                inventory
                    .filter((i) => i.itemHrid === input.itemHrid && !i.enhancementLevel)
                    .reduce((sum, i) => sum + (i.count || 0), 0);

            // Calculate queued and available amounts. Stock another plan has
            // already claimed is not available either — see
            // utils/inventory-reservations.js; zero while the ledger is off.
            const queued = queuedMaterialsMap.get(input.itemHrid) || 0;
            const reserved = ownerId ? reservedElsewhere(input.itemHrid, 0, { excludeOwner: ownerId }) : 0;
            const available = Math.max(0, have - queued - reserved);
            const missingAmount = Math.max(0, totalRequired - available);

            const itemDetails = gameData.itemDetailMap[input.itemHrid];
            if (!itemDetails) {
                continue;
            }

            materials.push({
                itemHrid: input.itemHrid,
                itemName: itemDetails.name,
                required: totalRequired,
                have: have,
                queued: queued,
                available: available,
                missing: missingAmount,
                isTradeable: itemDetails.isTradable === true, // British spelling
                isUpgradeItem: false,
                ...reservationFields(missingAmount, input.itemHrid, totalRequired, have, queued, reserved, ownerId),
            });
        }
    }

    // Process upgrade item at the end (if exists)
    if (actionDetails.upgradeItemHrid) {
        // Upgrade items always need exactly 1 per action, no artisan reduction
        const totalRequired = numActions;

        const have =
            unclaimedBoughtCount(actionDetails.upgradeItemHrid) +
            inventory
                .filter((i) => i.itemHrid === actionDetails.upgradeItemHrid && !i.enhancementLevel)
                .reduce((sum, i) => sum + (i.count || 0), 0);

        // Calculate queued and available amounts
        const queued = queuedMaterialsMap.get(actionDetails.upgradeItemHrid) || 0;
        const reserved = ownerId ? reservedElsewhere(actionDetails.upgradeItemHrid, 0, { excludeOwner: ownerId }) : 0;
        const available = Math.max(0, have - queued - reserved);
        const missingAmount = Math.max(0, totalRequired - available);

        const itemDetails = gameData.itemDetailMap[actionDetails.upgradeItemHrid];
        if (itemDetails) {
            materials.push({
                itemHrid: actionDetails.upgradeItemHrid,
                itemName: itemDetails.name,
                required: totalRequired,
                have: have,
                queued: queued,
                available: available,
                missing: missingAmount,
                isTradeable: itemDetails.isTradable === true, // British spelling
                isUpgradeItem: true, // Flag to identify upgrade items
                ...reservationFields(
                    missingAmount,
                    actionDetails.upgradeItemHrid,
                    totalRequired,
                    have,
                    queued,
                    reserved,
                    ownerId
                ),
            });
        }
    }

    return materials;
}

/**
 * Calculate artisan bonus (material reduction) for an action
 * @param {Object} actionDetails - Action details from game data
 * @returns {number} Artisan bonus (0-1 decimal, e.g., 0.1129 for 11.29% reduction)
 */
export function calculateArtisanBonus(actionDetails) {
    try {
        const gameData = dataManager.getInitClientData();
        if (!gameData) {
            return 0;
        }

        const { equipment, drinks: activeDrinks } = resolveActionContext(actionDetails.type);
        const itemDetailMap = gameData.itemDetailMap || {};
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

        return parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
    } catch (error) {
        console.error('[Material Calculator] Error calculating artisan bonus:', error);
        return 0;
    }
}

/**
 * Returns true if artisan tea is selected in a drink slot but has 0 quantity in inventory.
 * Used to warn the user that material counts reflect no artisan reduction.
 * @param {string} actionHrid
 * @returns {boolean}
 */
export function isArtisanTeaOutOfStock(actionHrid) {
    try {
        const actionDetails = dataManager.getActionDetails(actionHrid);
        if (!actionDetails) return false;

        const gameData = dataManager.getInitClientData();
        if (!gameData) return false;

        const itemDetailMap = gameData.itemDetailMap || {};

        // Raw slotted drinks (ignoring stock)
        const rawDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
        if (!rawDrinks?.length) return false;

        // In-stock drinks come from resolveActionContext (already filtered)
        const { equipment, drinks: inStockDrinks } = resolveActionContext(actionDetails.type);
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);

        return (
            parseArtisanBonus(rawDrinks, itemDetailMap, drinkConcentration) > 0 &&
            parseArtisanBonus(inStockDrinks, itemDetailMap, drinkConcentration) === 0
        );
    } catch (error) {
        console.error('[Material Calculator] Error checking artisan tea stock:', error);
        return false;
    }
}

/**
 * Calculate material requirements for enhancement actions
 * Uses Markov chain statistics to determine expected materials needed
 * @param {string} itemHrid - Item HRID being enhanced
 * @param {number} startLevel - Current enhancement level (0-19)
 * @param {number} targetLevel - Target enhancement level (1-20)
 * @param {string|null} protectionItemHrid - Protection item HRID or null
 * @param {number} protectFromLevel - Level at which protection begins (0 = never)
 * @returns {Array<Object>} Array of material requirement objects (same format as calculateMaterialRequirements)
 */
export function calculateEnhancementMaterialRequirements(
    itemHrid,
    startLevel,
    targetLevel,
    protectionItemHrid,
    protectFromLevel,
    repeatCount
) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) {
        return [];
    }

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails) {
        return [];
    }

    const enhancementCosts = itemDetails.enhancementCosts || [];
    if (enhancementCosts.length === 0) {
        return [];
    }

    // Get enhancing parameters (level, tool bonus, teas, etc.)
    const params = getEnhancingParams();
    const effectiveProtect = protectFromLevel >= 2 && protectFromLevel <= targetLevel ? protectFromLevel : 0;

    // Single Markov chain call for the full level range
    const calc = calculateEnhancement({
        enhancingLevel: params.enhancingLevel,
        houseLevel: params.houseLevel,
        toolBonus: params.toolBonus,
        speedBonus: params.speedBonus,
        itemLevel: itemDetails.itemLevel || 1,
        targetLevel: targetLevel,
        startLevel: startLevel,
        protectFrom: effectiveProtect,
        blessedTea: params.teas.blessed,
        guzzlingBonus: params.guzzlingBonus,
    });

    const inventory = dataManager.getInventory() || [];
    const materials = [];

    // Process enhancement cost materials
    for (const cost of enhancementCosts) {
        // Skip coins — not tradeable, auto-deducted by the game
        if (cost.itemHrid === '/items/coin') {
            continue;
        }

        const matDetails = gameData.itemDetailMap[cost.itemHrid];
        if (!matDetails) {
            continue;
        }

        const totalQuantity = Math.ceil(cost.count * (repeatCount ?? calc.attempts));
        const have =
            unclaimedBoughtCount(cost.itemHrid) +
            inventory
                .filter((i) => i.itemHrid === cost.itemHrid && !i.enhancementLevel)
                .reduce((sum, i) => sum + (i.count || 0), 0);
        const missing = Math.max(0, totalQuantity - have);

        materials.push({
            itemHrid: cost.itemHrid,
            itemName: matDetails.name,
            required: totalQuantity,
            have: have,
            queued: 0,
            available: have,
            missing: missing,
            isTradeable: matDetails.isTradable === true,
            isUpgradeItem: false,
        });
    }

    // Add protection item if applicable
    // Skip Philosopher's Mirror — special mechanic, not consumed as standard protection
    if (calc.protectionCount > 0 && protectionItemHrid && protectionItemHrid !== '/items/philosophers_mirror') {
        const totalProtection = Math.ceil(calc.protectionCount);
        const protDetails = gameData.itemDetailMap[protectionItemHrid];

        if (protDetails) {
            const have =
                unclaimedBoughtCount(protectionItemHrid) +
                inventory
                    .filter((i) => i.itemHrid === protectionItemHrid && !i.enhancementLevel)
                    .reduce((sum, i) => sum + (i.count || 0), 0);
            const missing = Math.max(0, totalProtection - have);

            materials.push({
                itemHrid: protectionItemHrid,
                itemName: protDetails.name,
                required: totalProtection,
                have: have,
                queued: 0,
                available: have,
                missing: missing,
                isTradeable: protDetails.isTradable === true,
                isUpgradeItem: false,
            });
        }
    }

    return materials;
}
