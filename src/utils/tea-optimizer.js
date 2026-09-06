/**
 * Tea Optimizer Utility
 * Calculates optimal tea combinations for XP or Gold optimization
 */

import dataManager from '../core/data-manager.js';
import { calculateEfficiencyBreakdown, calculateEfficiencyMultiplier } from './efficiency.js';
import { calculateExperienceMultiplier } from './experience-parser.js';
import { getDrinkConcentration } from './tea-parser.js';
import {
    parseEquipmentSpeedBonuses,
    parseEquipmentEfficiencyBonuses,
    parseGatheringQuantityBonus,
} from './equipment-parser.js';
import { calculateActionsPerHour, calculateEffectiveActionsPerHour, calculateDrinksPerHour } from './profit-helpers.js';
import { getItemPrice, getItemPriceInfo } from './market-data.js';
import { calculateBonusRevenue } from './bonus-revenue-calculator.js';
import { MARKET_TAX } from './profit-constants.js';
import alchemyProfitCalculator from '../features/market/alchemy-profit-calculator.js';

// Skill name to action type mapping
const SKILL_TO_ACTION_TYPE = {
    milking: '/action_types/milking',
    foraging: '/action_types/foraging',
    woodcutting: '/action_types/woodcutting',
    cheesesmithing: '/action_types/cheesesmithing',
    crafting: '/action_types/crafting',
    tailoring: '/action_types/tailoring',
    cooking: '/action_types/cooking',
    brewing: '/action_types/brewing',
    alchemy: '/action_types/alchemy',
};

const GATHERING_SKILLS = ['milking', 'foraging', 'woodcutting'];
const PRODUCTION_SKILLS = ['cheesesmithing', 'crafting', 'tailoring', 'cooking', 'brewing', 'alchemy'];

/**
 * Get all relevant teas for a skill and optimization goal
 * Returns teas grouped by exclusivity (skill teas are mutually exclusive)
 * @param {string} skillName - Skill name (e.g., 'milking')
 * @param {string} goal - 'xp' or 'gold'
 * @returns {Object} { skillTeas: [], generalTeas: [] }
 */
export function getRelevantTeas(skillName, goal) {
    const skill = skillName.toLowerCase();
    const isGathering = GATHERING_SKILLS.includes(skill);

    // Skill-specific teas (mutually exclusive - can only equip ONE)
    const skillTeas = [`/items/${skill}_tea`, `/items/super_${skill}_tea`, `/items/ultra_${skill}_tea`];

    // General teas (can equip any combination)
    const generalTeas = new Set();

    // Universal efficiency tea
    generalTeas.add('/items/efficiency_tea');

    // Artisan tea is production-only (confirmed by the maintainer 2026-08-29):
    // the game does not let it buff gathering actions, so offering it there
    // recommended a tea whose bonuses would never apply
    if (skill !== 'alchemy' && !isGathering) {
        generalTeas.add('/items/artisan_tea');
    }

    // Catalytic tea - alchemy success rate boost
    if (skill === 'alchemy') {
        generalTeas.add('/items/catalytic_tea');
    }

    // Wisdom tea - always shown so users can evaluate the XP/gold trade-off in any mode
    generalTeas.add('/items/wisdom_tea');

    if (goal === 'xp') {
        if (skill === 'cooking' || skill === 'brewing') {
            // Gourmet tea shown on XP tab too — users may want to run it alongside XP teas
            generalTeas.add('/items/gourmet_tea');
        }
    } else if (goal === 'gold') {
        if (isGathering) {
            // Gathering-specific gold teas
            generalTeas.add('/items/gathering_tea');
            generalTeas.add('/items/processing_tea');
        } else if (skill === 'cooking' || skill === 'brewing') {
            // Gourmet tea only applies to cooking and brewing
            generalTeas.add('/items/gourmet_tea');
        }
    }

    // Filter to only teas that exist in game data
    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) {
        return { skillTeas: [], generalTeas: [] };
    }

    return {
        skillTeas: skillTeas.filter((hrid) => gameData.itemDetailMap[hrid]),
        generalTeas: Array.from(generalTeas).filter((hrid) => gameData.itemDetailMap[hrid]),
    };
}

/**
 * Generate all valid tea combinations respecting exclusivity rules
 * - Can only use ONE skill-specific tea (mutually exclusive)
 * - Can use any combination of general teas
 * - Max 3 teas total
 * @param {Object} teaGroups - { skillTeas: [], generalTeas: [] }
 * @returns {Array<Array<string>>} Array of valid tea combinations
 */
function generateCombinations(teaGroups, constraints = null) {
    const { skillTeas, generalTeas } = teaGroups;
    const combinations = [];

    // Helper to add combination if valid
    const addCombo = (combo) => {
        if (combo.length > 0 && combo.length <= 3) {
            if (constraints) {
                if ([...constraints.pinned].some((t) => !combo.includes(t))) return;
                if (combo.some((t) => constraints.banned.has(t))) return;
            }
            combinations.push(combo);
        }
    };

    // Option 1: No skill tea, only general teas (1-3 general teas)
    for (let i = 0; i < generalTeas.length; i++) {
        addCombo([generalTeas[i]]);
        for (let j = i + 1; j < generalTeas.length; j++) {
            addCombo([generalTeas[i], generalTeas[j]]);
            for (let k = j + 1; k < generalTeas.length; k++) {
                addCombo([generalTeas[i], generalTeas[j], generalTeas[k]]);
            }
        }
    }

    // Option 2: One skill tea + general teas (1 skill + 0-2 general)
    for (const skillTea of skillTeas) {
        // Just skill tea alone
        addCombo([skillTea]);

        // Skill tea + 1 general tea
        for (let i = 0; i < generalTeas.length; i++) {
            addCombo([skillTea, generalTeas[i]]);

            // Skill tea + 2 general teas
            for (let j = i + 1; j < generalTeas.length; j++) {
                addCombo([skillTea, generalTeas[i], generalTeas[j]]);
            }
        }
    }

    return combinations;
}

/**
 * Parse tea buffs from a tea combination
 * @param {Array<string>} teaHrids - Array of tea item HRIDs
 * @param {Object} itemDetailMap - Item details from game data
 * @param {number} drinkConcentration - Drink concentration as decimal
 * @returns {Object} Aggregated buff values
 */
function parseTeaBuffs(teaHrids, itemDetailMap, drinkConcentration) {
    const buffs = {
        efficiency: 0,
        wisdom: 0,
        gathering: 0,
        processing: 0,
        artisan: 0,
        gourmet: 0,
        actionLevel: 0,
        alchemySuccess: 0,
        skillLevels: {}, // skill name → level bonus
    };

    for (const teaHrid of teaHrids) {
        const itemDetails = itemDetailMap[teaHrid];
        if (!itemDetails?.consumableDetail?.buffs) continue;

        for (const buff of itemDetails.consumableDetail.buffs) {
            const baseValue = buff.flatBoost || 0;
            const scaledValue = baseValue * (1 + drinkConcentration);

            switch (buff.typeHrid) {
                case '/buff_types/efficiency':
                    buffs.efficiency += scaledValue * 100; // Convert to percentage
                    break;
                case '/buff_types/wisdom':
                    buffs.wisdom += scaledValue * 100;
                    break;
                case '/buff_types/gathering':
                    buffs.gathering += scaledValue;
                    break;
                case '/buff_types/processing':
                    buffs.processing += scaledValue;
                    break;
                case '/buff_types/artisan':
                    buffs.artisan += scaledValue;
                    break;
                case '/buff_types/gourmet':
                    buffs.gourmet += scaledValue;
                    break;
                case '/buff_types/action_level':
                    buffs.actionLevel += scaledValue;
                    break;
                case '/buff_types/alchemy_success':
                    // alchemy_success uses ratioBoost, not flatBoost
                    buffs.alchemySuccess += (buff.ratioBoost || 0) * (1 + drinkConcentration);
                    break;
                default:
                    // Check for skill level buffs (e.g., /buff_types/milking_level)
                    if (buff.typeHrid.endsWith('_level')) {
                        const skillMatch = buff.typeHrid.match(/\/buff_types\/(\w+)_level/);
                        if (skillMatch) {
                            const skill = skillMatch[1];
                            buffs.skillLevels[skill] = (buffs.skillLevels[skill] || 0) + scaledValue;
                        }
                    }
            }
        }
    }

    return buffs;
}

/**
 * Calculate XP/hour for an action with a specific tea combination
 * @param {Object} actionDetails - Action details from game data
 * @param {Object} buffs - Parsed tea buffs
 * @param {number} playerLevel - Player's skill level
 * @param {Object} otherEfficiency - Other efficiency sources (house, equipment, etc.)
 * @param {Object} context - Additional context (equipment, itemDetailMap)
 * @returns {number} XP per hour
 */
function calculateXpPerHour(actionDetails, buffs, playerLevel, otherEfficiency, context) {
    if (!actionDetails.experienceGain?.value) {
        return 0;
    }

    const { equipment, itemDetailMap } = context;
    const requiredLevel = actionDetails.levelRequirement?.level || 1;
    const skillName = actionDetails.type.split('/').pop();

    // Calculate tea skill level bonus for this skill
    const teaSkillLevelBonus = buffs.skillLevels[skillName] || 0;

    // Get equipment speed bonus
    const equipmentSpeedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Get equipment efficiency bonus
    const equipmentEfficiencyBonus = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Calculate efficiency breakdown
    const efficiencyData = calculateEfficiencyBreakdown({
        requiredLevel,
        skillLevel: playerLevel,
        teaSkillLevelBonus,
        actionLevelBonus: buffs.actionLevel,
        houseEfficiency: otherEfficiency.house || 0,
        equipmentEfficiency: equipmentEfficiencyBonus,
        teaEfficiency: buffs.efficiency,
        communityEfficiency: otherEfficiency.community || 0,
        achievementEfficiency: otherEfficiency.achievement || 0,
    });

    const totalEfficiency = efficiencyData.totalEfficiency;
    const efficiencyMultiplier = calculateEfficiencyMultiplier(totalEfficiency);

    // Calculate actions per hour with equipment speed bonus
    const baseTime = (actionDetails.baseTimeCost || 3e9) / 1e9;
    const actionTime = baseTime / (1 + equipmentSpeedBonus);
    const baseActionsPerHour = calculateActionsPerHour(actionTime);
    const actionsPerHour = calculateEffectiveActionsPerHour(baseActionsPerHour, efficiencyMultiplier);

    // Get the FULL XP multiplier from all sources
    const skillHrid = actionDetails.experienceGain.skillHrid;
    const currentXpData = calculateExperienceMultiplier(skillHrid, actionDetails.type);

    // Replace current tea wisdom with our calculated tea wisdom
    const currentTeaWisdom = currentXpData.breakdown?.consumableWisdom || 0;
    const baseWisdomWithoutTea = currentXpData.totalWisdom - currentTeaWisdom;
    const totalWisdomWithOurTea = baseWisdomWithoutTea + buffs.wisdom;
    const charmExperience = currentXpData.charmExperience || 0;
    const xpMultiplier = 1 + totalWisdomWithOurTea / 100 + charmExperience / 100;

    // XP per hour
    const baseXp = actionDetails.experienceGain.value;
    return actionsPerHour * baseXp * xpMultiplier;
}

/**
 * Calculate Gold/hour for a gathering action with a specific tea combination
 * @param {Object} actionDetails - Action details from game data
 * @param {Object} buffs - Parsed tea buffs
 * @param {number} playerLevel - Player's skill level
 * @param {Object} otherEfficiency - Other efficiency sources
 * @param {Object} gameData - Full game data
 * @param {Object} context - Additional context (equipment, itemDetailMap)
 * @returns {number} Gold per hour (profit after market tax)
 */
function calculateGatheringGoldPerHour(actionDetails, buffs, playerLevel, otherEfficiency, gameData, context) {
    const { equipment, itemDetailMap } = context;
    const requiredLevel = actionDetails.levelRequirement?.level || 1;
    const skillName = actionDetails.type.split('/').pop();

    // Calculate tea skill level bonus for this skill
    const teaSkillLevelBonus = buffs.skillLevels[skillName] || 0;

    // Get equipment speed bonus
    const equipmentSpeedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Get equipment efficiency bonus
    const equipmentEfficiencyBonus = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Calculate efficiency
    const efficiencyData = calculateEfficiencyBreakdown({
        requiredLevel,
        skillLevel: playerLevel,
        teaSkillLevelBonus,
        actionLevelBonus: buffs.actionLevel,
        houseEfficiency: otherEfficiency.house || 0,
        equipmentEfficiency: equipmentEfficiencyBonus,
        teaEfficiency: buffs.efficiency,
        communityEfficiency: otherEfficiency.community || 0,
        achievementEfficiency: otherEfficiency.achievement || 0,
    });

    const totalEfficiency = efficiencyData.totalEfficiency;
    const efficiencyMultiplier = calculateEfficiencyMultiplier(totalEfficiency);

    // Calculate actions per hour (with speed bonus, WITHOUT efficiency - efficiency applied to outputs)
    const baseTime = (actionDetails.baseTimeCost || 3e9) / 1e9;
    const actionTime = baseTime / (1 + equipmentSpeedBonus);
    const actionsPerHour = calculateActionsPerHour(actionTime);

    // Calculate revenue from drops
    let totalRevenue = 0;
    const dropTable = actionDetails.dropTable || [];
    const gatheringBonus = 1 + buffs.gathering + (otherEfficiency.gathering || 0);

    for (const drop of dropTable) {
        const dropRate = drop.dropRate || 1;
        const minCount = drop.minCount || 1;
        const maxCount = drop.maxCount || minCount;
        const avgCount = (minCount + maxCount) / 2;

        // Apply gathering bonus to quantity
        const avgAmountPerAction = avgCount * gatheringBonus;

        // Get item price (use 'sell' side for output items to match tile calculation)
        const rawPrice = getItemPrice(drop.itemHrid, { context: 'profit', side: 'sell' }) || 0;

        // Check for processing conversion
        if (buffs.processing > 0) {
            const processedData = findProcessingConversion(drop.itemHrid, gameData);
            if (processedData) {
                const processedPrice =
                    getItemPrice(processedData.outputItemHrid, { context: 'profit', side: 'sell' }) || 0;
                const conversionRatio = processedData.conversionRatio;

                // Processing Tea check happens per action:
                // If procs (processingBonus% chance): Convert to processed
                const processedIfProcs = Math.floor(avgAmountPerAction / conversionRatio);

                // Expected processed items per action
                const processedPerAction = buffs.processing * processedIfProcs;

                // Net processing bonus = processed value - cost of raw converted
                const processingNetValue =
                    actionsPerHour *
                    dropRate *
                    efficiencyMultiplier *
                    (processedPerAction * (processedPrice - conversionRatio * rawPrice));

                // Total = base raw revenue + processing net gain
                const baseRawItemsPerHour = actionsPerHour * dropRate * avgAmountPerAction * efficiencyMultiplier;
                totalRevenue += baseRawItemsPerHour * rawPrice + processingNetValue;
                continue;
            }
        }

        // No processing - simple calculation
        const itemsPerHour = actionsPerHour * dropRate * avgAmountPerAction * efficiencyMultiplier;
        totalRevenue += itemsPerHour * rawPrice;
    }

    // Add bonus revenue from essence and rare find drops
    const bonusRevenue = calculateBonusRevenue(actionDetails, actionsPerHour, equipment, itemDetailMap);
    const efficiencyBoostedBonusRevenue = bonusRevenue.totalBonusRevenue * efficiencyMultiplier;
    totalRevenue += efficiencyBoostedBonusRevenue;

    const profitPerHour = totalRevenue * (1 - MARKET_TAX);

    return profitPerHour;
}

/**
 * Calculate Gold/hour for a production action with a specific tea combination
 * @param {Object} actionDetails - Action details from game data
 * @param {Object} buffs - Parsed tea buffs
 * @param {number} playerLevel - Player's skill level
 * @param {Object} otherEfficiency - Other efficiency sources
 * @param {Object} gameData - Full game data
 * @param {Object} context - Additional context (equipment, itemDetailMap)
 * @returns {number} Gold per hour (profit after market tax)
 */
function calculateProductionGoldPerHour(actionDetails, buffs, playerLevel, otherEfficiency, gameData, context) {
    const { equipment, itemDetailMap } = context;
    const requiredLevel = actionDetails.levelRequirement?.level || 1;
    const skillName = actionDetails.type.split('/').pop();

    // Calculate tea skill level bonus for this skill
    const teaSkillLevelBonus = buffs.skillLevels[skillName] || 0;

    // Get equipment speed bonus
    const equipmentSpeedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Get equipment efficiency bonus
    const equipmentEfficiencyBonus = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    // Calculate efficiency
    const efficiencyData = calculateEfficiencyBreakdown({
        requiredLevel,
        skillLevel: playerLevel,
        teaSkillLevelBonus,
        actionLevelBonus: buffs.actionLevel,
        houseEfficiency: otherEfficiency.house || 0,
        equipmentEfficiency: equipmentEfficiencyBonus,
        teaEfficiency: buffs.efficiency,
        communityEfficiency: otherEfficiency.community || 0,
        achievementEfficiency: otherEfficiency.achievement || 0,
    });

    const totalEfficiency = efficiencyData.totalEfficiency;
    const efficiencyMultiplier = calculateEfficiencyMultiplier(totalEfficiency);

    // Calculate actions per hour (with speed bonus, WITHOUT efficiency - efficiency applied to outputs)
    const baseTime = (actionDetails.baseTimeCost || 3e9) / 1e9;
    const actionTime = baseTime / (1 + equipmentSpeedBonus);
    const actionsPerHour = calculateActionsPerHour(actionTime);

    // Calculate input costs (with artisan reduction for regular inputs)
    // Use 'buy' side for inputs to match tile calculation
    let inputCost = 0;
    const artisanReduction = 1 - buffs.artisan;

    // Add upgrade item cost (NOT affected by Artisan Tea)
    if (actionDetails.upgradeItemHrid) {
        let upgradePrice = getItemPrice(actionDetails.upgradeItemHrid, { context: 'profit', side: 'buy' }) || 0;
        // Special case: Coins have no market price but have face value of 1
        if (actionDetails.upgradeItemHrid === '/items/coin' && upgradePrice === 0) {
            upgradePrice = 1;
        }
        inputCost += upgradePrice; // Always 1 upgrade item, no artisan reduction
    }

    // Add regular input item costs (affected by Artisan Tea)
    for (const input of actionDetails.inputItems || []) {
        let price = getItemPrice(input.itemHrid, { context: 'profit', side: 'buy' }) || 0;
        // Special case: Coins have no market price but have face value of 1
        if (input.itemHrid === '/items/coin' && price === 0) {
            price = 1;
        }
        const effectiveCount = input.count * artisanReduction;
        inputCost += price * effectiveCount;
    }

    // Calculate output revenue (with gourmet bonus - only for cooking/brewing)
    // Use 'sell' side for outputs to match tile calculation
    let outputRevenue = 0;
    const isCookingOrBrewing =
        actionDetails.type === '/action_types/cooking' || actionDetails.type === '/action_types/brewing';
    const gourmetBonus = isCookingOrBrewing ? 1 + buffs.gourmet : 1;
    for (const output of actionDetails.outputItems || []) {
        const price = getItemPrice(output.itemHrid, { context: 'profit', side: 'sell' }) || 0;
        const effectiveCount = output.count * gourmetBonus;
        outputRevenue += price * effectiveCount;
    }

    // Profit per action (before market tax)
    const profitPerAction = outputRevenue - inputCost;

    // Profit per hour (with efficiency applied once)
    const grossProfitPerHour = actionsPerHour * profitPerAction * efficiencyMultiplier;

    // Add bonus revenue from essence and rare find drops (same as tile calculation)
    const bonusRevenue = calculateBonusRevenue(actionDetails, actionsPerHour, equipment, itemDetailMap);
    const efficiencyBoostedBonusRevenue = (bonusRevenue?.totalBonusRevenue || 0) * efficiencyMultiplier;

    // Apply market tax to the revenue portion only (including bonus revenue)
    const revenuePerHour = actionsPerHour * outputRevenue * efficiencyMultiplier;
    const marketTax = (revenuePerHour + efficiencyBoostedBonusRevenue) * MARKET_TAX;
    const netProfitPerHour = grossProfitPerHour + efficiencyBoostedBonusRevenue - marketTax;

    return netProfitPerHour;
}

/**
 * Calculate Gold/hour for an alchemy action with a specific tea combination
 * @param {Object} alchemyContext - { actionType: 'coinify'|'decompose'|'transmute', itemHrid, enhancementLevel }
 * @param {Object} buffs - Parsed tea buffs (includes alchemySuccess)
 * @returns {number} Gold per hour (profit after all costs)
 */
function calculateAlchemyGoldPerHour(alchemyContext, buffs) {
    const { actionType, itemHrid, enhancementLevel = 0 } = alchemyContext;
    const teaBonusOverride = buffs.alchemySuccess || 0;

    let profitData = null;
    if (actionType === 'coinify') {
        profitData = alchemyProfitCalculator.calculateCoinifyProfit(
            itemHrid,
            enhancementLevel,
            false,
            teaBonusOverride
        );
    } else if (actionType === 'decompose') {
        profitData = alchemyProfitCalculator.calculateDecomposeProfit(
            itemHrid,
            enhancementLevel,
            false,
            teaBonusOverride
        );
    } else if (actionType === 'transmute') {
        profitData = alchemyProfitCalculator.calculateTransmuteProfit(itemHrid, false, teaBonusOverride);
    }

    if (!profitData) return 0;
    return profitData.profitPerHour || 0;
}

/**
 * Calculate XP/hour for an alchemy action with a specific tea combination.
 * Alchemy XP is derived from item level, not from actionDetails.experienceGain.
 * @param {Object} alchemyContext - { actionType, itemHrid, enhancementLevel }
 * @param {Object} buffs - Parsed tea buffs
 * @param {number} playerLevel - Player's alchemy level
 * @param {Object} otherEfficiency - Non-tea efficiency sources
 * @param {Object} calcContext - { equipment, itemDetailMap }
 * @returns {number} XP per hour
 */
function calculateAlchemyXpPerHour(alchemyContext, buffs, playerLevel, otherEfficiency, calcContext) {
    const { actionType, itemHrid } = alchemyContext;
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return 0;

    const actionHrid = `/actions/alchemy/${actionType}`;
    const actionDetails = gameData.actionDetailMap[actionHrid];
    if (!actionDetails) return 0;

    const itemDetails = gameData.itemDetailMap?.[itemHrid];
    if (!itemDetails?.itemLevel) return 0;

    // Base XP from alchemy formula (depends on action type + item level)
    const itemLevel = itemDetails.itemLevel;
    let baseXP;
    switch (actionType) {
        case 'coinify':
            baseXP = itemLevel + 10;
            break;
        case 'decompose':
            baseXP = itemLevel * 1.4 + 14;
            break;
        case 'transmute':
            baseXP = itemLevel * 1.6 + 16;
            break;
        default:
            return 0;
    }

    // Success rate with this tea's alchemy bonus (affects XP: failures give 10%)
    const teaBonusOverride = buffs.alchemySuccess || 0;
    let baseSuccessRate;
    if (actionType === 'coinify') baseSuccessRate = 0.7;
    else if (actionType === 'decompose') baseSuccessRate = 0.6;
    else baseSuccessRate = itemDetails.alchemyDetail?.transmuteSuccessRate || 0;

    // Level penalty (transmute only)
    const levelPenalty =
        actionType === 'transmute' && playerLevel < itemLevel ? (0.9 / itemLevel) * (playerLevel - itemLevel) : 0;

    const successRate = Math.max(0, Math.min(1.0, baseSuccessRate * (1 + levelPenalty) * (1 + teaBonusOverride)));

    // XP per action: success gives full XP, failure gives 10%
    // Wisdom multiplier — replace current tea wisdom with our hypothetical tea wisdom
    const xpData = calculateExperienceMultiplier('/skills/alchemy', '/action_types/alchemy');
    const currentTeaWisdom = xpData.breakdown?.consumableWisdom || 0;
    const baseWisdomWithoutTea = xpData.totalWisdom - currentTeaWisdom;
    const totalWisdomWithOurTea = baseWisdomWithoutTea + buffs.wisdom;
    const charmExperience = xpData.charmExperience || 0;
    const wisdomMultiplier = 1 + totalWisdomWithOurTea / 100 + charmExperience / 100;

    const fullXP = baseXP * wisdomMultiplier;
    const xpPerAction = successRate * fullXP + (1 - successRate) * fullXP * 0.1;

    // Actions per hour (uses item level for efficiency, not action level requirement)
    const requiredLevel = itemLevel;
    const { equipment, itemDetailMap } = calcContext;
    const teaSkillLevelBonus = buffs.skillLevels['alchemy'] || 0;
    const equipmentSpeedBonus = parseEquipmentSpeedBonuses(equipment, actionDetails.type, itemDetailMap) || 0;
    const equipmentEfficiencyBonus = parseEquipmentEfficiencyBonuses(equipment, actionDetails.type, itemDetailMap) || 0;

    const efficiencyData = calculateEfficiencyBreakdown({
        requiredLevel,
        skillLevel: playerLevel,
        teaSkillLevelBonus,
        actionLevelBonus: buffs.actionLevel,
        houseEfficiency: otherEfficiency.house || 0,
        equipmentEfficiency: equipmentEfficiencyBonus,
        teaEfficiency: buffs.efficiency,
        communityEfficiency: otherEfficiency.community || 0,
        achievementEfficiency: otherEfficiency.achievement || 0,
    });

    const efficiencyMultiplier = calculateEfficiencyMultiplier(efficiencyData.totalEfficiency);
    const baseTime = (actionDetails.baseTimeCost || 20e9) / 1e9;
    const actionTime = baseTime / (1 + equipmentSpeedBonus);
    const baseActionsPerHour = calculateActionsPerHour(actionTime);
    const actionsPerHour = calculateEffectiveActionsPerHour(baseActionsPerHour, efficiencyMultiplier);

    return actionsPerHour * xpPerAction;
}

/**
 * Find processing conversion for an item
 * @param {string} itemHrid - Item HRID
 * @param {Object} gameData - Game data
 * @returns {Object|null} Conversion data or null
 */
function findProcessingConversion(itemHrid, gameData) {
    const validProcessingTypes = ['/action_types/cheesesmithing', '/action_types/crafting', '/action_types/tailoring'];

    for (const [_actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (!validProcessingTypes.includes(action.type)) continue;

        const inputItem = action.inputItems?.[0];
        const outputItem = action.outputItems?.[0];

        if (inputItem?.itemHrid === itemHrid && outputItem) {
            return {
                outputItemHrid: outputItem.itemHrid,
                conversionRatio: inputItem.count,
            };
        }
    }

    return null;
}

/**
 * Whether any material an action's gold/hour score depends on has no price data.
 *
 * calculateGatheringGoldPerHour / calculateProductionGoldPerHour treat an unpriced item as
 * worth 0 (`getItemPrice(...) || 0`), deliberately matching the live action tile's own
 * numeric convention. But the tile calculators (gathering-profit.js, profit-calculator.js)
 * also track a `hasMissingPrices`/`missingPrice` flag alongside that 0, precisely so the UI
 * can warn that the number rests on a guess rather than a quote — an unpriced input reading as
 * "free" can make an action look like the best gold/hour option when its true cost is simply
 * unknown. This mirrors that flag for the optimizer's own recommendations, which had no such
 * signal at all.
 *
 * Checked independently of any specific tea combination (a combo-agnostic pass over the
 * action's own item list), so it costs nothing extra inside the combination search loop that
 * calls the gold functions once per combo.
 *
 * "No price data" has to mean `getItemPriceInfo(...).estimated`, not a null price. Since
 * value-filling landed, an item with an empty order book is still priced — from the game's
 * official value map — so a null price now means only "not an item anybody can price at all",
 * and a check written against it fires essentially never. market-data.js says as much in
 * `getItemPriceInfo`'s own comment: every older signal of this kind (`missing`,
 * `hasMissingPrices`, `hasPriceData`) stopped firing that day, and `estimated` is how a caller
 * gets it back. A flag meant to say "this number rests on a guess rather than a quote" is
 * exactly that flag.
 *
 * @param {Object} actionDetails - Action details from game data
 * @param {boolean} isGathering - Whether this is a gathering-skill action (vs. production)
 * @param {Object} gameData - Full game data (for resolving processing conversions)
 * @returns {boolean}
 */
/**
 * Whether ranking a gathering/production skill's equipment by gold has to lean on an item
 * with no price data.
 *
 * The skilling optimizer's per-slot equipment progression (skilling-optimizer-engine.js)
 * scores gathering skills by gold via `scoreEquipmentSetup`, which — like the tile calculators
 * it wraps — treats an unpriced material as worth 0 rather than excluding the action. That is
 * the same blind spot {@link actionHasUnpricedMaterials} exists to flag for the tea optimizer's
 * own Gold/hr figure, but the equipment ranking had no equivalent signal: a slot's "best" item
 * could win purely because the market has no listing for something it consumes or drops, and
 * the progression table gave no indication the number was a guess.
 *
 * Checked independent of any specific equipment, same as `actionHasUnpricedMaterials` itself —
 * whether an action's gold score depends on an unpriced item does not change with what is worn.
 *
 * @param {string} skillName - Skill name
 * @param {number} playerLevel - Player's skill level (or a hypothetical one, for planning ahead)
 * @param {Set<string>|null} [selectedActionHrids] - Actions to check, or null for all available
 * @returns {boolean} Whether any available action's gold score rests on an unpriced material
 */
export function skillGoldHasUnpricedMaterials(skillName, playerLevel, selectedActionHrids = null) {
    const normalizedSkill = skillName.toLowerCase();
    const isGathering = GATHERING_SKILLS.includes(normalizedSkill);
    const isProduction = PRODUCTION_SKILLS.includes(normalizedSkill);
    if (!isGathering && !isProduction) return false;

    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return false;

    const { available: actions } = getActionsForSkill(normalizedSkill, playerLevel, selectedActionHrids);
    return actions.some((action) => actionHasUnpricedMaterials(action, isGathering, gameData));
}

export function actionHasUnpricedMaterials(actionDetails, isGathering, gameData) {
    const isPriced = (itemHrid, side) => {
        if (itemHrid === '/items/coin') return true;
        const info = getItemPriceInfo(itemHrid, { context: 'profit', side });
        return info.price !== null && !info.estimated;
    };

    if (isGathering) {
        for (const drop of actionDetails.dropTable || []) {
            if (!isPriced(drop.itemHrid, 'sell')) return true;
            const processedData = findProcessingConversion(drop.itemHrid, gameData);
            if (processedData && !isPriced(processedData.outputItemHrid, 'sell')) return true;
        }
        return false;
    }

    if (actionDetails.upgradeItemHrid && !isPriced(actionDetails.upgradeItemHrid, 'buy')) return true;
    for (const input of actionDetails.inputItems || []) {
        if (!isPriced(input.itemHrid, 'buy')) return true;
    }
    for (const output of actionDetails.outputItems || []) {
        if (!isPriced(output.itemHrid, 'sell')) return true;
    }
    return false;
}

/**
 * Get all actions for a skill that the player can do
 * @param {string} skillName - Skill name
 * @param {number} playerLevel - Player's skill level
 * @returns {Array<Object>} Array of action details
 */
/**
 * Get all actions for a skill, separating available from excluded
 * @param {string} skillName - Skill name
 * @param {number} playerLevel - Player's skill level
 * @returns {Object} { available: [], excluded: [] } with exclusion reasons
 */
function getActionsForSkill(skillName, playerLevel, selectedActionHrids = null) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return { available: [], excluded: [] };

    const actionType = SKILL_TO_ACTION_TYPE[skillName.toLowerCase()];
    if (!actionType) return { available: [], excluded: [] };

    const available = [];
    const excluded = [];

    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.type !== actionType) continue;
        if (selectedActionHrids && !selectedActionHrids.has(hrid)) continue;

        const requiredLevel = action.levelRequirement?.level || 1;
        if (playerLevel >= requiredLevel) {
            available.push(action);
        } else {
            excluded.push({ action, reason: 'level', requiredLevel });
        }
    }

    return { available, excluded };
}

/**
 * Get all actions for a skill for display purposes, including level-locked ones.
 * Sorted by the game's own sortIndex (the convention the combat zone dropdown already uses)
 * rather than level+name: actions sharing a level requirement are not alphabetical in the
 * game's own list, so level+name reordered them against what the player sees in-game.
 * @param {string} skillName
 * @param {number} playerLevel
 * @returns {Array<{ hrid, name, requiredLevel, available, sortIndex }>} Sorted by sortIndex
 */
export function getSkillActionsForDisplay(skillName, playerLevel) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return [];

    const actionType = SKILL_TO_ACTION_TYPE[skillName.toLowerCase()];
    if (!actionType) return [];

    const result = [];
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.type !== actionType) continue;
        const requiredLevel = action.levelRequirement?.level || 1;
        result.push({
            hrid,
            name: action.name,
            requiredLevel,
            available: playerLevel >= requiredLevel,
            sortIndex: action.sortIndex ?? 0,
        });
    }
    return result.sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
}

/**
 * Calculate tea consumption cost per hour for a tea combination
 * Uses the same pricing logic as the tile calculation
 *
 * A tea with no real book price (`getItemPriceInfo` reports `null` or an
 * `estimated` value-map figure, the same "not a quote anybody would trade
 * at" bar `actionHasUnpricedMaterials` holds action items to) still gets
 * charged at `getItemPrice(...) || 0`, i.e. free — matching the tile
 * calculators' own numeric convention for an unpriced item. `hasMissingPrices`
 * says so, rather than letting a combo that leans on a free-looking tea win
 * the gold ranking with no indication the number rests on a guess.
 *
 * @param {Array<string>} teaHrids - Array of tea item HRIDs
 * @param {number} drinkConcentration - Drink concentration as decimal
 * @returns {{ total: number, breakdown: Array<{hrid: string, name: string, unitsPerHour: number, unitPrice: number, costPerHour: number}>, hasMissingPrices: boolean }}
 */
function calculateTeaCostPerHour(teaHrids, drinkConcentration) {
    const gameData = dataManager.getInitClientData();
    const drinksPerHour = calculateDrinksPerHour(drinkConcentration);
    const breakdown = [];
    let total = 0;
    let hasMissingPrices = false;

    for (const teaHrid of teaHrids) {
        // Use getItemPrice with 'profit' context and 'buy' side to match tile calculation
        const priceInfo = getItemPriceInfo(teaHrid, { context: 'profit', side: 'buy' });
        if (priceInfo.price === null || priceInfo.estimated) hasMissingPrices = true;
        const unitPrice = priceInfo.price || 0;
        const costPerHour = unitPrice * drinksPerHour;
        const name = gameData?.itemDetailMap?.[teaHrid]?.name || teaHrid;
        breakdown.push({ hrid: teaHrid, name, unitsPerHour: drinksPerHour, unitPrice, costPerHour });
        total += costPerHour;
    }

    return { total, breakdown, hasMissingPrices };
}

/**
 * Get other efficiency sources (non-tea)
 * @param {string} actionType - Action type HRID
 * @returns {Object} Other efficiency values
 */
function getOtherEfficiencySources(actionType) {
    const _equipment = dataManager.getEquipment();
    const houseRoomsMap = dataManager.getHouseRooms();
    const houseRooms = houseRoomsMap ? Array.from(houseRoomsMap.values()) : [];
    const gameData = dataManager.getInitClientData();

    const result = {
        house: 0,
        equipment: 0,
        community: 0,
        achievement: 0,
        wisdom: 0,
        gathering: 0,
    };

    if (!gameData) return result;

    // House efficiency
    if (houseRooms) {
        for (const room of houseRooms) {
            const roomDetail = gameData.houseRoomDetailMap?.[room.houseRoomHrid];
            if (roomDetail?.usableInActionTypeMap?.[actionType]) {
                result.house += (room.level || 0) * 1.5;
            }
        }
    }

    // Community efficiency buff - use production_efficiency for production skills
    // Match the tile's calculation from profit-calculator.js
    const isProductionType = PRODUCTION_SKILLS.some((skill) => actionType.includes(skill));
    const communityBuffType = isProductionType
        ? '/community_buff_types/production_efficiency'
        : '/community_buff_types/efficiency';
    const communityEffLevel = dataManager.getCommunityBuffLevel(communityBuffType);
    if (communityEffLevel) {
        // Get buff definition from game data for accurate calculation
        const buffDef = gameData.communityBuffTypeDetailMap?.[communityBuffType];
        if (buffDef?.usableInActionTypeMap?.[actionType] && buffDef?.buff) {
            // Formula: flatBoost + (level - 1) × flatBoostLevelBonus
            const baseBonus = (buffDef.buff.flatBoost || 0) * 100;
            const levelBonus = (communityEffLevel - 1) * (buffDef.buff.flatBoostLevelBonus || 0) * 100;
            result.community = baseBonus + levelBonus;
        } else {
            // Fallback to old formula if buff doesn't apply to this action
            result.community = 0;
        }
    }

    // Community gathering buff
    const communityGatheringLevel = dataManager.getCommunityBuffLevel('/community_buff_types/gathering_quantity');
    if (communityGatheringLevel) {
        result.gathering = 0.2 + (communityGatheringLevel - 1) * 0.005;
    }

    // Achievement gathering buff (stacks with community gathering)
    const achievementGathering = dataManager.getAchievementBuffFlatBoost(actionType, '/buff_types/gathering');
    result.gathering += achievementGathering;

    // Community wisdom buff
    const communityWisdomLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
    if (communityWisdomLevel) {
        result.wisdom = 20 + (communityWisdomLevel - 1) * 0.5;
    }

    // Achievement buffs
    result.achievement = dataManager.getAchievementBuffFlatBoost(actionType, '/buff_types/efficiency') * 100;

    // Equipment efficiency (simplified - would need full parser for accuracy)
    // For now, we'll skip this as it requires more complex parsing

    return result;
}

/**
 * Find optimal tea combination for a skill and goal
 * @param {string} skillName - Skill name (e.g., 'Milking')
 * @param {string} goal - 'xp' or 'gold'
 * @param {string|null} locationName - Optional location name to filter actions (e.g., "Silly Cow Valley")
 * @param {string|null} actionNameFilter - Optional action name to restrict optimization to a single action
 * @returns {Object} Optimization result
 */
export function findOptimalTeas(
    skillName,
    goal,
    locationName = null,
    actionNameFilter = null,
    constraints = null,
    alchemyContext = null,
    equipmentOverride = null,
    selectedActionHrids = null
) {
    const normalizedSkill = skillName.toLowerCase();
    const isGathering = GATHERING_SKILLS.includes(normalizedSkill);
    const isProduction = PRODUCTION_SKILLS.includes(normalizedSkill);

    if (!isGathering && !isProduction) {
        return { error: `Unknown skill: ${skillName}` };
    }

    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) {
        return { error: 'Game data not loaded' };
    }

    // Get player's skill level
    const skills = dataManager.getSkills();
    const skillHrid = `/skills/${normalizedSkill}`;
    let playerLevel = 1;
    for (const skill of skills || []) {
        if (skill.skillHrid === skillHrid) {
            playerLevel = skill.level;
            break;
        }
    }

    // Get drink concentration
    const equipment = equipmentOverride ?? dataManager.getEquipment();
    const drinkConcentration = getDrinkConcentration(equipment, gameData.itemDetailMap);

    // Get relevant teas and generate combinations
    const relevantTeas = getRelevantTeas(normalizedSkill, goal);
    const combinations = generateCombinations(relevantTeas, constraints);

    // Get actions for this skill (available and excluded)
    const actionData = getActionsForSkill(normalizedSkill, playerLevel, selectedActionHrids);
    let actions = actionData.available;
    let excludedActions = actionData.excluded;

    // Filter to specific location if provided (using game data category)
    if (locationName && gameData.actionCategoryDetailMap) {
        // Find the category HRID that matches this location name AND skill
        // Multiple skills can have categories with the same name (e.g., "Material" exists for both Tailoring and Cheesesmithing)
        // So we need to match the skill-specific category path
        let targetCategoryHrid = null;
        const skillPrefix = `/action_categories/${normalizedSkill}/`;

        for (const [categoryHrid, categoryDetail] of Object.entries(gameData.actionCategoryDetailMap)) {
            // Match both the category name AND ensure it's for the correct skill
            if (categoryDetail.name === locationName && categoryHrid.startsWith(skillPrefix)) {
                targetCategoryHrid = categoryHrid;
                break;
            }
        }

        // Filter actions to only those in this category
        if (targetCategoryHrid) {
            // Filter available actions
            actions = actions.filter((action) => action.category === targetCategoryHrid);

            // Also filter excluded actions to same category (so we only show relevant excluded items)
            excludedActions = excludedActions.filter((item) => item.action.category === targetCategoryHrid);
        }
    }

    // Optionally narrow to a single action by name
    if (actionNameFilter) {
        actions = actions.filter((a) => a.name === actionNameFilter);
        excludedActions = excludedActions.filter((item) => item.action.name === actionNameFilter);
    }

    // Check if there are no available actions (even if there are excluded ones)
    if (actions.length === 0) {
        const locationSuffix = locationName ? ` at ${locationName}` : '';
        if (excludedActions.length > 0) {
            const lowestLevel = Math.min(...excludedActions.map((item) => item.requiredLevel));
            return {
                error: `No actions available for ${skillName}${locationSuffix} at level ${playerLevel}. All actions require level ${lowestLevel}+.`,
            };
        } else {
            return { error: `No actions available for ${skillName}${locationSuffix} at level ${playerLevel}` };
        }
    }

    // Get other efficiency sources
    const actionType = SKILL_TO_ACTION_TYPE[normalizedSkill];
    const otherEfficiency = getOtherEfficiencySources(actionType);

    // Score each combination
    const results = [];

    // Create context for calculations
    const calcContext = {
        equipment,
        itemDetailMap: gameData.itemDetailMap,
    };

    // Whether each action's gold score depends on an unpriced item — combo-independent, so
    // computed once rather than inside the combination loop below. Only meaningful for the
    // gold goal; xp scoring never touches prices.
    const unpricedByAction =
        goal === 'gold' && !alchemyContext
            ? new Map(actions.map((action) => [action.name, actionHasUnpricedMaterials(action, isGathering, gameData)]))
            : null;

    for (const combo of combinations) {
        const buffs = parseTeaBuffs(combo, gameData.itemDetailMap, drinkConcentration);

        // Calculate tea cost per hour for this combo
        const teaCostPerHour = calculateTeaCostPerHour(combo, drinkConcentration);

        let totalScore = 0;
        let profitableCount = 0;
        let hasMissingPrices = false;
        const actionScores = [];

        // Alchemy mode: score the specific item, not all actions
        if (alchemyContext) {
            const actionName = `${alchemyContext.actionType}: ${alchemyContext.itemName || alchemyContext.itemHrid}`;
            let score;
            if (goal === 'xp') {
                score = calculateAlchemyXpPerHour(alchemyContext, buffs, playerLevel, otherEfficiency, calcContext);
                totalScore += score;
            } else {
                score = calculateAlchemyGoldPerHour(alchemyContext, buffs) - teaCostPerHour.total;
                if (score > 0) {
                    totalScore += score;
                    profitableCount++;
                }
            }
            actionScores.push({ action: actionName, score });
        } else {
            for (const action of actions) {
                let score;
                if (goal === 'xp') {
                    score = calculateXpPerHour(action, buffs, playerLevel, otherEfficiency, calcContext);
                    totalScore += score;
                } else if (isGathering) {
                    score = calculateGatheringGoldPerHour(
                        action,
                        buffs,
                        playerLevel,
                        otherEfficiency,
                        gameData,
                        calcContext
                    );
                    // Deduct tea costs from gold score
                    score -= teaCostPerHour.total;
                    // Only include profitable actions in gold calculations
                    if (score > 0) {
                        totalScore += score;
                        profitableCount++;
                        if (unpricedByAction?.get(action.name)) hasMissingPrices = true;
                    }
                } else {
                    score = calculateProductionGoldPerHour(
                        action,
                        buffs,
                        playerLevel,
                        otherEfficiency,
                        gameData,
                        calcContext
                    );
                    // Deduct tea costs from gold score
                    score -= teaCostPerHour.total;
                    // Only include profitable actions in gold calculations
                    if (score > 0) {
                        totalScore += score;
                        profitableCount++;
                        if (unpricedByAction?.get(action.name)) hasMissingPrices = true;
                    }
                }

                actionScores.push({
                    action: action.name,
                    score,
                    ...(unpricedByAction ? { hasMissingPrices: unpricedByAction.get(action.name) } : {}),
                });
            }
        }

        // The combo's own tea cost is subtracted from every counted action's score, so a tea
        // with no real book price (see calculateTeaCostPerHour) is exactly as much of a "this
        // number rests on a guess" case as an unpriced action material — but only when the combo
        // actually counted for something; a wholly unprofitable combo does not become the pick.
        if (goal === 'gold' && profitableCount > 0 && teaCostPerHour.hasMissingPrices) hasMissingPrices = true;

        // For gold, average across profitable actions only; for XP, average across all
        const avgDivisor = goal === 'gold' ? profitableCount || 1 : alchemyContext ? 1 : actions.length;

        results.push({
            teas: combo,
            totalScore,
            avgScore: totalScore / avgDivisor,
            actionScores,
            buffs,
            teaCostPerHour,
            profitableCount, // Track how many actions are profitable
            hasMissingPrices, // Whether any counted action's score relies on an unpriced item
        });
    }

    // Sort by average score (descending) — every caller headlines avgScore
    // ("Gold/hr", "XP/hr": tea-recommendation.js, skilling-optimizer-ui.js),
    // never totalScore, so that is what "optimal" has to mean. For XP this is
    // the same order totalScore gives (avgDivisor is actions.length for every
    // combo, a constant, so the two are proportional). For gold it is not:
    // avgDivisor is profitableCount, which varies combo to combo — sorting by
    // the sum instead of the average could pick a combo that makes more
    // actions marginally profitable over one with a smaller, more profitable
    // set, and then headline that worse combo's own (lower) avgScore as the
    // best available, while a combo with a genuinely higher average sat
    // un-picked in the same results list.
    results.sort((a, b) => b.avgScore - a.avgScore);

    // Get tea names for display
    const getTeaName = (hrid) => gameData.itemDetailMap[hrid]?.name || hrid;

    // Format excluded actions for display
    const excludedForDisplay = excludedActions
        .map((item) => ({
            action: item.action.name,
            reason: item.reason,
            requiredLevel: item.requiredLevel,
        }))
        .sort((a, b) => a.requiredLevel - b.requiredLevel);

    // Handle case where no actions are available (all excluded by level)
    if (results.length === 0 || !results[0]) {
        return {
            optimal: null,
            isConsistent: false,
            skill: skillName,
            goal,
            playerLevel,
            drinkConcentration,
            otherEfficiency,
            actionsEvaluated: 0,
            profitableActionsCount: 0,
            combinationsEvaluated: combinations.length,
            allResults: [],
            excludedActions: excludedForDisplay,
            teaCostPerHour: { total: 0, breakdown: [] },
        };
    }

    // Check if top result is consistent across all actions
    const topResult = results[0];
    const isConsistent = topResult.actionScores.every((as, _i, _arr) => {
        return as.score > 0;
    });

    return {
        optimal: {
            teas: topResult.teas.map((hrid) => ({
                hrid,
                name: getTeaName(hrid),
            })),
            totalScore: topResult.totalScore,
            avgScore: topResult.avgScore,
            actionScores: topResult.actionScores,
            buffs: topResult.buffs, // Include for UI debugging
            profitableCount: topResult.profitableCount, // How many actions are profitable
            // True when a counted action's gold score relies on at least one item with no
            // price data (treated as free/worthless per calculateGatheringGoldPerHour /
            // calculateProductionGoldPerHour's "match the tile calculation" convention) — a
            // caller should present this recommendation's gold number as uncertain rather than
            // definitive when true.
            hasMissingPrices: topResult.hasMissingPrices || false,
        },
        isConsistent,
        skill: skillName,
        goal,
        playerLevel,
        drinkConcentration,
        otherEfficiency,
        actionsEvaluated: alchemyContext ? 1 : actions.length,
        profitableActionsCount: topResult.profitableCount, // For display in stats
        combinationsEvaluated: combinations.length,
        allResults: results.slice(0, 5).map((r) => ({
            teas: r.teas.map(getTeaName),
            avgScore: r.avgScore,
            teaCostPerHour: r.teaCostPerHour,
        })),
        excludedActions: excludedForDisplay, // Actions excluded due to level
        // Include top result's tea cost for debug
        teaCostPerHour: topResult.teaCostPerHour,
    };
}

/**
 * Find the highest-level item at or below the player's alchemy level for use as a scoring reference.
 * Falls back to the lowest available alchemy item if none are at/below the player's level.
 * @param {number} playerLevel
 * @param {Object} itemDetailMap
 * @returns {string|null}
 */
function getRepresentativeAlchemyItemHrid(playerLevel, itemDetailMap) {
    let bestHrid = null;
    let bestLevel = 0;
    let fallbackHrid = null;
    let fallbackLevel = Infinity;
    for (const [hrid, detail] of Object.entries(itemDetailMap)) {
        if (!detail.alchemyDetail || !detail.itemLevel) continue;
        if (detail.itemLevel <= playerLevel) {
            if (detail.itemLevel > bestLevel) {
                bestLevel = detail.itemLevel;
                bestHrid = hrid;
            }
        } else if (detail.itemLevel < fallbackLevel) {
            fallbackLevel = detail.itemLevel;
            fallbackHrid = hrid;
        }
    }
    return bestHrid ?? fallbackHrid;
}

/**
 * Score a hypothetical equipment setup for a skill and goal with zero tea buffs.
 * Used by the skilling optimizer to rank equipment candidates per slot independently of teas.
 * @param {string} skillName
 * @param {string} goal - 'xp' or 'gold'
 * @param {Map} equipment - Map<itemLocationHrid, { itemHrid, enhancementLevel }>
 * @param {number} playerLevel
 * @returns {number} Average XP/hr or Gold/hr across available actions
 */
export function scoreEquipmentSetup(skillName, goal, equipment, playerLevel, selectedActionHrids = null) {
    const normalizedSkill = skillName.toLowerCase();
    const isGathering = GATHERING_SKILLS.includes(normalizedSkill);
    const isProduction = PRODUCTION_SKILLS.includes(normalizedSkill);

    if (!isGathering && !isProduction) return 0;

    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return 0;

    const actionType = SKILL_TO_ACTION_TYPE[normalizedSkill];
    if (!actionType) return 0;

    const otherEfficiency = getOtherEfficiencySources(actionType);

    // Add equipment gathering quantity bonus — not captured by the standard speed/efficiency parsers
    if (isGathering) {
        const equipGathering = parseGatheringQuantityBonus(equipment, gameData.itemDetailMap);
        if (equipGathering > 0) otherEfficiency.gathering = (otherEfficiency.gathering || 0) + equipGathering;
    }

    const { available: actions } = getActionsForSkill(normalizedSkill, playerLevel, selectedActionHrids);
    if (!actions.length) return 0;

    const emptyBuffs = {
        efficiency: 0,
        wisdom: 0,
        gathering: 0,
        processing: 0,
        artisan: 0,
        gourmet: 0,
        actionLevel: 0,
        alchemySuccess: 0,
        skillLevels: {},
    };

    const calcContext = { equipment, itemDetailMap: gameData.itemDetailMap };

    // Alchemy XP is derived from item level, not from action data — standard calculateXpPerHour
    // always returns 0 for alchemy. Use a dedicated path with a representative item instead —
    // and, for the gold goal, the alchemy profit calculator rather than the XP one: this branch
    // used to return calculateAlchemyXpPerHour regardless of `goal`, so every gold-goal caller
    // (the skilling optimizer's per-slot equipment ranking) was scoring alchemy equipment on
    // XP/hour under a "Gold/hr" label.
    if (normalizedSkill === 'alchemy') {
        const repItemHrid = getRepresentativeAlchemyItemHrid(playerLevel, gameData.itemDetailMap);
        if (!repItemHrid) return 0;
        const alchemyContext = { actionType: 'decompose', itemHrid: repItemHrid };
        return goal === 'gold'
            ? calculateAlchemyGoldPerHour(alchemyContext, emptyBuffs)
            : calculateAlchemyXpPerHour(alchemyContext, emptyBuffs, playerLevel, otherEfficiency, calcContext);
    }

    let totalScore = 0;
    let count = 0;

    for (const action of actions) {
        let score;
        if (goal === 'xp') {
            score = calculateXpPerHour(action, emptyBuffs, playerLevel, otherEfficiency, calcContext);
            totalScore += score;
            count++;
        } else if (isGathering) {
            score = calculateGatheringGoldPerHour(
                action,
                emptyBuffs,
                playerLevel,
                otherEfficiency,
                gameData,
                calcContext
            );
            if (score > 0) {
                totalScore += score;
                count++;
            }
        } else {
            score = calculateProductionGoldPerHour(
                action,
                emptyBuffs,
                playerLevel,
                otherEfficiency,
                gameData,
                calcContext
            );
            if (score > 0) {
                totalScore += score;
                count++;
            }
        }
    }

    return count > 0 ? totalScore / count : 0;
}

/**
 * Get buff description for a tea
 * @param {string} teaHrid - Tea item HRID
 * @returns {string} Human-readable buff description
 */
export function getTeaBuffDescription(teaHrid, drinkConcentration = 0) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return '';

    const itemDetails = gameData.itemDetailMap[teaHrid];
    if (!itemDetails?.consumableDetail?.buffs) return '';

    const dcMultiplier = 1 + drinkConcentration;
    const descriptions = [];

    for (const buff of itemDetails.consumableDetail.buffs) {
        const baseValue = buff.flatBoost || 0;
        const scaledValue = baseValue * dcMultiplier;
        const dcBonus = baseValue * drinkConcentration;

        switch (buff.typeHrid) {
            case '/buff_types/efficiency':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% eff', true));
                break;
            case '/buff_types/wisdom':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% XP', true));
                break;
            case '/buff_types/gathering':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% gathering', true));
                break;
            case '/buff_types/processing':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% processing', true));
                break;
            case '/buff_types/artisan':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% mat savings', true));
                break;
            case '/buff_types/gourmet':
                descriptions.push(formatBuffWithDC(scaledValue * 100, dcBonus * 100, '% extra output', true));
                break;
            case '/buff_types/action_level':
                descriptions.push(formatBuffWithDC(scaledValue, dcBonus, ' action lvl', false));
                break;
            default:
                if (buff.typeHrid.endsWith('_level')) {
                    const skill = buff.typeHrid.match(/\/buff_types\/(\w+)_level/)?.[1];
                    if (skill) {
                        descriptions.push(formatBuffWithDC(scaledValue, dcBonus, ` ${skill}`, false));
                    }
                }
        }
    }

    return descriptions.join(', ');
}

/**
 * Format a buff value with optional drink concentration bonus
 * @param {number} scaledValue - Total value including DC
 * @param {number} dcBonus - Just the DC bonus portion
 * @param {string} suffix - Unit suffix (e.g., '% eff', ' tailoring')
 * @param {boolean} isPercent - Whether to format as percentage
 * @returns {string} Formatted string like "+8.8 tailoring (+.8)"
 */
function formatBuffWithDC(scaledValue, dcBonus, suffix, isPercent) {
    // Format the main value
    const mainFormatted = isPercent
        ? `+${Number.isInteger(scaledValue) ? scaledValue : scaledValue.toFixed(1)}${suffix}`
        : `+${Number.isInteger(scaledValue) ? scaledValue : scaledValue.toFixed(1)}${suffix}`;

    // If no DC bonus, just return the main value
    if (dcBonus === 0) {
        return mainFormatted;
    }

    // Format the DC bonus (with % suffix if percentage)
    const dcFormatted = isPercent
        ? `(+${dcBonus < 1 ? dcBonus.toFixed(1) : dcBonus.toFixed(0)}%)`
        : `(+${dcBonus < 1 ? dcBonus.toFixed(1) : dcBonus.toFixed(0)})`;

    return `${mainFormatted} ${dcFormatted}`;
}

/**
 * Calculate XP/hr and Gold/hr for a specific equipment and tea setup.
 * Unlike scoreEquipmentSetup (which uses empty teas for equipment comparison),
 * this evaluates a real configured setup and returns both metrics.
 * @param {string} skillName
 * @param {Map} equipment - Map<itemLocationHrid, { itemHrid, enhancementLevel }>
 * @param {string[]} teaHrids - Tea item HRIDs (null/empty entries are filtered)
 * @param {number} playerLevel
 * @param {Set<string>|null} selectedActionHrids
 * @returns {{ xpPerHour: number, goldPerHour: number, teaCostPerHour: number }}
 */
export function calculateSkillPerformance(skillName, equipment, teaHrids, playerLevel, selectedActionHrids = null) {
    const normalizedSkill = skillName.toLowerCase();
    const isGathering = GATHERING_SKILLS.includes(normalizedSkill);
    const isProduction = PRODUCTION_SKILLS.includes(normalizedSkill);

    const empty = { xpPerHour: 0, goldPerHour: 0, teaCostPerHour: 0, hasMissingPrices: false };
    if (!isGathering && !isProduction) return empty;
    if (selectedActionHrids !== null && selectedActionHrids.size === 0) return empty;

    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return empty;

    const actionType = SKILL_TO_ACTION_TYPE[normalizedSkill];
    if (!actionType) return empty;

    const { available: actions } = getActionsForSkill(normalizedSkill, playerLevel, selectedActionHrids);
    if (!actions.length) return empty;

    const filteredTeas = (teaHrids || []).filter(Boolean);
    const drinkConcentration = getDrinkConcentration(equipment, gameData.itemDetailMap);
    const buffs = parseTeaBuffs(filteredTeas, gameData.itemDetailMap, drinkConcentration);

    const otherEfficiency = getOtherEfficiencySources(actionType);
    if (isGathering) {
        const equipGathering = parseGatheringQuantityBonus(equipment, gameData.itemDetailMap);
        if (equipGathering > 0) otherEfficiency.gathering = (otherEfficiency.gathering || 0) + equipGathering;
    }

    const teaCost = calculateTeaCostPerHour(filteredTeas, drinkConcentration);
    const calcContext = { equipment, itemDetailMap: gameData.itemDetailMap };

    // Alchemy XP and gold are both derived from a representative item rather
    // than from action data — see scoreEquipmentSetup's identical special
    // case. Left to fall through to the generic loop below, calculateXpPerHour
    // always returns 0 for alchemy (it has no experienceGain, by design — see
    // calculateAlchemyXpPerHour's own doc comment) and calculateProductionGoldPerHour
    // ignores buffs.alchemySuccess entirely, so this skill's XP/hr always read
    // as zero and its Gold/hr never reflected a catalytic tea's whole effect.
    if (normalizedSkill === 'alchemy') {
        const repItemHrid = getRepresentativeAlchemyItemHrid(playerLevel, gameData.itemDetailMap);
        if (!repItemHrid) return empty;
        const alchemyContext = { actionType: 'decompose', itemHrid: repItemHrid };
        const xpPerHour = calculateAlchemyXpPerHour(alchemyContext, buffs, playerLevel, otherEfficiency, calcContext);
        const goldPerHour = calculateAlchemyGoldPerHour(alchemyContext, buffs) - teaCost.total;
        return {
            xpPerHour: xpPerHour > 0 ? xpPerHour : 0,
            goldPerHour: goldPerHour > 0 ? goldPerHour : 0,
            teaCostPerHour: teaCost.total,
            hasMissingPrices: false,
        };
    }

    let totalXp = 0,
        xpCount = 0;
    let totalGold = 0,
        goldCount = 0;
    let hasMissingPrices = false;

    for (const action of actions) {
        const xp = calculateXpPerHour(action, buffs, playerLevel, otherEfficiency, calcContext);
        if (xp > 0) {
            totalXp += xp;
            xpCount++;
        }

        const gold = isGathering
            ? calculateGatheringGoldPerHour(action, buffs, playerLevel, otherEfficiency, gameData, calcContext) -
              teaCost.total
            : calculateProductionGoldPerHour(action, buffs, playerLevel, otherEfficiency, gameData, calcContext) -
              teaCost.total;
        if (gold > 0) {
            totalGold += gold;
            goldCount++;
            if (actionHasUnpricedMaterials(action, isGathering, gameData) || teaCost.hasMissingPrices) {
                hasMissingPrices = true;
            }
        }
    }

    return {
        xpPerHour: xpCount > 0 ? totalXp / xpCount : 0,
        goldPerHour: goldCount > 0 ? totalGold / goldCount : 0,
        teaCostPerHour: teaCost.total,
        // See actionHasUnpricedMaterials: true when goldPerHour counts an action whose score
        // depends on an item with no price data, treated as free rather than excluded.
        hasMissingPrices,
    };
}

export default {
    findOptimalTeas,
    getRelevantTeas,
    getTeaBuffDescription,
    scoreEquipmentSetup,
    getSkillActionsForDisplay,
    calculateSkillPerformance,
};
