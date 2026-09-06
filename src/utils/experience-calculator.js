/**
 * Experience Calculator
 * Shared utility for calculating experience per hour across features
 *
 * Calculates accurate XP/hour including:
 * - Base experience from action
 * - Experience multipliers (Wisdom + Charm Experience)
 * - Action time with speed bonuses
 * - Efficiency repeats (critical for accuracy)
 */

import dataManager from '../core/data-manager.js';
import { calculateActionStats } from './action-calculator.js';
import { calculateExperienceMultiplier } from './experience-parser.js';
import { calculateEfficiencyMultiplier } from './efficiency.js';
import { calculateActionsPerHour, calculateEffectiveActionsPerHour } from './profit-helpers.js';
import { resolveActionContext } from './action-context.js';

/**
 * Calculate experience per hour for an action
 * @param {string} actionHrid - The action HRID (e.g., "/actions/cheesesmithing/cheese")
 * @returns {Object|null} Experience data or null if not applicable
 *   {
 *     expPerHour: number,           // Total XP per hour (with all bonuses)
 *     baseExp: number,              // Base XP per action
 *     modifiedXP: number,           // XP per action after multipliers
 *     actionsPerHour: number,       // Actions per hour (with efficiency)
 *     xpMultiplier: number,         // Total XP multiplier (Wisdom + Charm)
 *     actionTime: number,           // Time per action in seconds
 *     totalEfficiency: number       // Total efficiency percentage
 *   }
 */
export function calculateExpPerHour(actionHrid) {
    const actionDetails = dataManager.getActionDetails(actionHrid);

    // Validate action has experience gain
    if (!actionDetails || !actionDetails.experienceGain || !actionDetails.experienceGain.value) {
        return null;
    }

    // Get character data
    const skills = dataManager.getSkills();
    const { equipment } = resolveActionContext(actionDetails.type);
    const gameData = dataManager.getInitClientData();

    if (!gameData || !skills || !equipment) {
        return null;
    }

    // Calculate action stats (time + efficiency)
    const stats = calculateActionStats(actionDetails, {
        skills,
        equipment,
        itemDetailMap: gameData.itemDetailMap,
        includeCommunityBuff: true,
        includeBreakdown: false,
    });

    if (!stats) {
        return null;
    }

    const { actionTime, totalEfficiency } = stats;

    // Calculate actions per hour (base rate)
    const baseActionsPerHour = calculateActionsPerHour(actionTime);

    // Calculate average queued actions completed per time-consuming action
    // Efficiency gives guaranteed repeats + chance for extra
    const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);

    // Calculate actions per hour WITH efficiency (total completions including instant repeats)
    const actionsPerHourWithEfficiency = calculateEffectiveActionsPerHour(baseActionsPerHour, avgActionsPerBaseAction);

    // Calculate experience multiplier (Wisdom + Charm Experience)
    const skillHrid = actionDetails.experienceGain.skillHrid;
    const xpData = calculateExperienceMultiplier(skillHrid, actionDetails.type);

    // Calculate exp per hour with all bonuses
    const baseExp = actionDetails.experienceGain.value;
    const modifiedXP = baseExp * xpData.totalMultiplier;
    const expPerHour = actionsPerHourWithEfficiency * modifiedXP;

    return {
        expPerHour: Math.floor(expPerHour),
        baseExp,
        modifiedXP,
        actionsPerHour: actionsPerHourWithEfficiency,
        xpMultiplier: xpData.totalMultiplier,
        actionTime,
        totalEfficiency,
    };
}

/**
 * Efficiency multiplier partway through a grind.
 *
 * The game's level efficiency is `max(0, effective_level − effective_requirement)`, so a
 * character standing below the effective requirement (an Action Level tea raises it, and the
 * panel is also readable for actions above the player's level) gains no efficiency at all
 * until the gap closes. Adding a flat +1% per level from the first one over-credits exactly
 * that gap. The deficit may be fractional, since Action Level bonuses are.
 *
 * @param {number} baseEfficiency - Current total efficiency percentage
 * @param {number} levelsGained - Levels gained so far in the walk
 * @param {number} levelEfficiencyDeficit - Levels still owed before level efficiency starts
 * @returns {number} Multiplier (1 + efficiency/100)
 */
function progressiveEfficiencyMultiplier(baseEfficiency, levelsGained, levelEfficiencyDeficit) {
    const gained = Math.max(0, levelsGained - (levelEfficiencyDeficit || 0));
    return 1 + (baseEfficiency + gained) / 100;
}

/**
 * Calculate actions and time needed to reach a target level
 * Accounts for progressive efficiency gains (+1% per level)
 * @param {number} currentLevel - Current skill level
 * @param {number} currentXP - Current experience points
 * @param {number} targetLevel - Target skill level
 * @param {number} baseEfficiency - Starting efficiency percentage
 * @param {number} actionTime - Time per action in seconds
 * @param {number} xpPerAction - Modified XP per action (with multipliers, success rate, etc.)
 * @param {Object} levelExperienceTable - XP requirements per level
 * @param {number} [levelEfficiencyDeficit=0] - How far the effective level sits *below* the
 *   effective requirement right now. Level efficiency is clamped at zero, so the first
 *   `levelEfficiencyDeficit` levels gained buy no efficiency at all.
 * @returns {{ actionsNeeded: number, timeNeeded: number }}
 */
export function calculateMultiLevelProgress(
    currentLevel,
    currentXP,
    targetLevel,
    baseEfficiency,
    actionTime,
    xpPerAction,
    levelExperienceTable,
    levelEfficiencyDeficit = 0
) {
    let totalActions = 0;
    let totalTime = 0;

    for (let level = currentLevel; level < targetLevel; level++) {
        // The table stops at the level cap; walking past it would yield NaN actions
        if (levelExperienceTable[level + 1] === undefined) break;

        let xpNeeded;
        if (level === currentLevel) {
            xpNeeded = levelExperienceTable[level + 1] - currentXP;
        } else {
            xpNeeded = levelExperienceTable[level + 1] - levelExperienceTable[level];
        }

        const efficiencyMultiplier = progressiveEfficiencyMultiplier(
            baseEfficiency,
            level - currentLevel,
            levelEfficiencyDeficit
        );

        const xpPerPerformedAction = xpPerAction * efficiencyMultiplier;
        const baseActionsForLevel = Math.ceil(xpNeeded / xpPerPerformedAction);
        const actionsToQueue = Math.round(baseActionsForLevel * efficiencyMultiplier);
        totalActions += actionsToQueue;
        totalTime += baseActionsForLevel * actionTime;
    }

    return { actionsNeeded: totalActions, timeNeeded: totalTime };
}

/**
 * The level and xp reached after a number of actions — the reverse of
 * calculateMultiLevelProgress, walking the same per-level progressive
 * efficiency forward against a fixed action budget so the two agree (its
 * actionsNeeded fed back in lands exactly on its target level).
 * @param {number} currentLevel - Current skill level
 * @param {number} currentXP - Current experience points
 * @param {number} actionCount - Actions to spend
 * @param {number} baseEfficiency - Starting efficiency percentage
 * @param {number} actionTime - Seconds per action
 * @param {number} xpPerAction - Modified XP per action
 * @param {Object} levelExperienceTable - XP requirements per level
 * @param {number} [levelEfficiencyDeficit=0] - Levels owed before level efficiency starts
 *   (see calculateMultiLevelProgress)
 * @returns {{finalLevel: number, finalXP: number, xpGained: number, timeElapsed: number, percentToNext: number}}
 */
export function calculateLevelFromActions(
    currentLevel,
    currentXP,
    actionCount,
    baseEfficiency,
    actionTime,
    xpPerAction,
    levelExperienceTable,
    levelEfficiencyDeficit = 0
) {
    let remainingActions = actionCount;
    let level = currentLevel;
    let xp = currentXP;
    let timeElapsed = 0;

    while (remainingActions > 0) {
        const xpForNextLevel = levelExperienceTable[level + 1];
        const efficiencyMultiplier = progressiveEfficiencyMultiplier(
            baseEfficiency,
            level - currentLevel,
            levelEfficiencyDeficit
        );

        if (xpForNextLevel === undefined) {
            // At the level cap: the queue still runs, it just stops buying levels
            timeElapsed += Math.ceil(remainingActions / efficiencyMultiplier) * actionTime;
            remainingActions = 0;
            break;
        }

        const xpNeeded = xpForNextLevel - xp;

        const xpPerPerformedAction = xpPerAction * efficiencyMultiplier;
        const baseActionsForLevel = Math.ceil(xpNeeded / xpPerPerformedAction);
        const actionsToClearLevel = Math.round(baseActionsForLevel * efficiencyMultiplier);

        if (actionsToClearLevel <= remainingActions) {
            remainingActions -= actionsToClearLevel;
            timeElapsed += baseActionsForLevel * actionTime;
            level += 1;
            xp = xpForNextLevel;
        } else {
            const fractionUsed = remainingActions / actionsToClearLevel;
            xp += xpNeeded * fractionUsed;
            timeElapsed += baseActionsForLevel * actionTime * fractionUsed;
            remainingActions = 0;
        }
    }

    const xpForLevel = levelExperienceTable[level] || 0;
    const xpForNextLevel = levelExperienceTable[level + 1];
    const percentToNext =
        xpForNextLevel !== undefined ? ((xp - xpForLevel) / (xpForNextLevel - xpForLevel)) * 100 : 100;

    return {
        finalLevel: level,
        finalXP: xp,
        xpGained: xp - currentXP,
        // Efficiency buys extra completions inside one timed cycle, not a shorter cycle, so a
        // queue of one or more actions cannot finish before the first cycle does. The mid-level
        // branch above prorates a whole cycle's time by the fraction of the level consumed,
        // which for a short queue at high efficiency lands under actionTime.
        timeElapsed: actionCount > 0 ? Math.max(actionTime, timeElapsed) : timeElapsed,
        percentToNext,
    };
}

export default {
    calculateExpPerHour,
    calculateMultiLevelProgress,
    calculateLevelFromActions,
};
