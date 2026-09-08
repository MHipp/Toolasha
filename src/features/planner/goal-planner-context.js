/**
 * The join between the game and the planner.
 *
 * `goal-planner.js` decides what to do in what order and knows nothing about
 * where numbers come from. This module is the other half: it asks the
 * calculators Toolasha already has, and hands the answers over as plain data
 * and a handful of synchronous lookups.
 *
 * ## Nothing here does arithmetic that lives somewhere else
 *
 * Every figure is somebody else's:
 *
 * - gold per hour — `gathering-profit.js` / `production-profit.js`, the same
 *   calculators behind the action panel's profit line; `alchemy-rankings.js`,
 *   which is the loop behind the Best Items table; and the last all-zones
 *   simulation, by way of `combat-rates.js`
 * - experience per hour — `experience-calculator.js`, the one the skill tiles use
 * - buy versus craft — `crafting-plan-calculator.js`
 * - an enhancement run — `tooltip-enhancement.js`'s path optimiser, over the
 *   Markov chain in `utils/enhancement-calculator.js`
 * - house upgrades — `utils/house-cost-calculator.js`
 *
 * A planner that re-derived any of them would be a second opinion, and two
 * numbers for the same question is worse than one. The only arithmetic written
 * here is enhancing experience per hour, which exists in the codebase only
 * inside the XPH panel's private helper — so the *composition* is repeated
 * (`calculateEnhancement` → visit counts → `calculateSuccessXP`), never the
 * formulas.
 *
 * ## Rates are precomputed, lookups are not
 *
 * Ranking every action the character can do means running the profit
 * calculators a few hundred times, which is a refresh, not a render. So that
 * work happens once in {@link buildPlannerContext} and the result rides on the
 * context as an array. The per-item lookups — a price, a recipe, an enhancement
 * run — are cheap and lazy, and memoised for the life of one context so a plan
 * with three steps against the same item asks once.
 */

import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { calculateProductionProfit } from '../actions/production-profit.js';
import { alchemyGoldRates } from '../alchemy/alchemy-rankings.js';
import { loadCombatRates } from './combat-rates.js';
import { applyLiquidityLimits } from './market-liquidity.js';
import { computeBestCraftingPlan } from '../crafting-plan/crafting-plan-calculator.js';
import {
    calculateEnhancementPath,
    getProductionChainTime,
    getCheapestProtectionPrice,
    getEnhancementMaterialPrice,
} from '../enhancement/tooltip-enhancement.js';
import { calculateSuccessXP, calculateFailureXP } from '../enhancement/enhancement-xp.js';
import { enhancementParamsFor, describeEnhancementSource } from '../enhancement/enhancement-params-source.js';
import * as houseCostCalculator from '../../utils/house-cost-calculator.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import { GATHERING_TYPES, PRODUCTION_TYPES } from '../../utils/profit-constants.js';
import { getPriceAgeString } from '../../utils/market-data.js';
import { effectiveInventory, shortfallNote } from '../../utils/inventory-reservations.js';
import { RESERVATION_OWNER_PREFIX } from './goal-planner.js';

const COIN_HRID = '/items/coin';
const INVENTORY_LOCATION = '/item_locations/inventory';
const ENHANCING_SKILL = '/skills/enhancing';

/** The enhancement run length the enhancing XP rate is quoted for */
const ENHANCING_XP_TARGET_LEVEL = 5;
/** How many held items the enhancing XP rate ranks, highest item level first */
const ENHANCING_XP_CANDIDATES = 25;

/**
 * Coins in hand.
 *
 * Only the inventory copy: coins also appear against market listings, and money
 * committed to a buy order cannot be spent on the next step of a plan.
 *
 * @returns {number} Coins
 */
export function coinsHeld() {
    const items = dataManager.getInventory();
    if (!Array.isArray(items)) return 0;
    const coin = items.find((item) => item.itemHrid === COIN_HRID && item.itemLocationHrid === INVENTORY_LOCATION);
    return coin?.count || 0;
}

/**
 * How many unenhanced copies of an item are in the bag.
 * @param {string} itemHrid - The item
 * @returns {number} Count
 */
function heldCount(itemHrid) {
    const items = dataManager.getInventory();
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        if (item.itemHrid !== itemHrid) continue;
        if (item.itemLocationHrid !== INVENTORY_LOCATION) continue;
        if (item.enhancementLevel) continue;
        total += item.count || 0;
    }
    return total;
}

/**
 * How many of an item one goal may actually plan against.
 *
 * The bag, less what every OTHER goal, crafting plan or open panel has claimed
 * of it — see `utils/inventory-reservations.js`. Never less what this goal
 * itself claimed, or a goal would subtract its own claim from its own stock and
 * report a shortfall that grows on every replan.
 *
 * With the reservation ledger switched off this is {@link heldCount} exactly,
 * which is what it has always been.
 *
 * @param {string} itemHrid - The item
 * @param {string|null} [goalId] - The goal asking; its own claim is not deducted
 * @returns {number} Count
 */
function availableCount(itemHrid, goalId = null) {
    return effectiveInventory(itemHrid, 0, {
        excludeOwner: goalId ? `${RESERVATION_OWNER_PREFIX}${goalId}` : null,
        held: heldCount(itemHrid),
    });
}

/**
 * The best copy of an item the character has, anywhere.
 *
 * Equipped counts: a plan for "own Sinister Cape +10" is finished when the cape
 * is on your back, not when a second one is in the bag.
 *
 * @param {string} itemHrid - The item
 * @returns {number} Highest enhancement level owned, or -1 when there is none
 */
function bestOwnedLevel(itemHrid) {
    let best = -1;

    const items = dataManager.getInventory();
    if (Array.isArray(items)) {
        for (const item of items) {
            if (item.itemHrid !== itemHrid) continue;
            if (!(item.count > 0)) continue;
            best = Math.max(best, item.enhancementLevel || 0);
        }
    }

    const equipment = dataManager.getEquipment();
    if (equipment) {
        for (const item of equipment.values()) {
            if (item?.itemHrid !== itemHrid) continue;
            best = Math.max(best, item.enhancementLevel || 0);
        }
    }

    return best;
}

/**
 * A skill's level and experience.
 * @param {string} skillHrid - The skill
 * @returns {{level: number, experience: number}} Its state, or level 1 when unknown
 */
function skillState(skillHrid) {
    const skill = (dataManager.getSkills() || []).find((entry) => entry.skillHrid === skillHrid);
    return { level: skill?.level ?? 1, experience: skill?.experience ?? 0 };
}

/**
 * Title-case a skill or room hrid, for anything the game has not named.
 * @param {string} hrid - An hrid
 * @returns {string} A readable name
 */
function humanise(hrid) {
    return String(hrid || '')
        .split('/')
        .pop()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * What a rate says when nothing limits how long it can be run.
 *
 * Frozen and shared: it is the same statement on every gathering, production
 * and combat rate, and a per-rate copy is weight for nothing.
 */
const UNBOUNDED = Object.freeze({ unbounded: true });

/**
 * Whether a profit figure had to guess at what the action costs.
 *
 * Only the cost side. A missing *output* price makes a profit understated,
 * which is a conservative error and still a usable ranking; a missing *input*
 * price makes it overstated without limit, because the calculators bill an
 * unpriceable material at nothing.
 *
 * @param {Object} profit - A result from the gathering or production calculator
 * @returns {boolean} Whether something it consumes could not be priced
 */
function costSideIncomplete(profit) {
    if ((profit?.materialCosts || []).some((material) => material?.missingPrice)) return true;
    if ((profit?.teaCosts || []).some((tea) => tea?.missingPrice)) return true;
    if ((profit?.drinkCosts || []).some((drink) => drink?.missingPrice)) return true;
    return false;
}

/**
 * Every action the character's levels allow, of a set of types.
 * @param {Array<string>} types - Action type hrids
 * @returns {Array<{hrid: string, action: Object}>} Actions the character can start
 */
function availableActions(types) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return [];
    const skills = dataManager.getSkills() || [];
    const levels = new Map(skills.map((skill) => [skill.skillHrid, skill.level]));

    const found = [];
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (!types.includes(action.type)) continue;
        const requirement = action.levelRequirement;
        if (requirement?.skillHrid) {
            const level = levels.get(requirement.skillHrid) ?? 1;
            if (level < (requirement.level || 1)) continue;
        }
        found.push({ hrid, action });
    }
    return found;
}

/**
 * What every activity the character can do pays per hour.
 *
 * Four sources, ranked against each other on one number:
 *
 * - **gathering and production** — the action profit calculators, over every
 *   action the character's levels allow;
 * - **alchemy** — `alchemy-rankings.js`, which runs the real alchemy profit
 *   calculator over every item each of the three actions applies to. The coin
 *   fee alchemy charges is inside those figures, because the calculator
 *   subtracts it before it reports a profit;
 * - **combat** — the last all-zones simulation, which is a measurement rather
 *   than a live calculation and says its own age in its label.
 *
 * Only the first two are returned as a per-action map. Alchemy quotes many
 * rates against the same three action hrids and combat quotes one per zone, so
 * folding either into a map keyed by action would either clobber entries or
 * pair an experience rate with the gold from a different item.
 *
 * ## Two kinds of rate, and only one of them has a ceiling
 *
 * Gathering, production and combat are marked `unbounded`. Gathering consumes
 * nothing; production and combat pay for their inputs at ask *inside the margin
 * they report*, so the margin is repeatable for as long as the market will sell
 * to you. Alchemy is the exception, and says so for itself — it eats the item
 * it is run on, and {@link alchemyGoldRates} caps each rate at what is in the
 * bag.
 *
 * ## A cost that could not be priced is not a cost of zero
 *
 * A production margin whose material list contains an item with no market
 * listing is computed as though that material were free, which turns a modest
 * craft into an eight-figure hourly income. Those rates are dropped rather than
 * quoted: an unpriceable input makes the *profit* unknown, not large.
 *
 * @returns {Promise<{rates: Array<Object>, byAction: Map<string, number>, notes: Array<string>}>}
 *   Rates best first, gold by action for the skilling rates, and anything the panel should say
 */
async function measureGoldRates() {
    const rates = [];
    const byAction = new Map();
    const notes = [];
    let unpriceable = 0;

    for (const { hrid, action } of availableActions(GATHERING_TYPES)) {
        try {
            const profit = await calculateGatheringProfit(hrid);
            if (!(profit?.profitPerHour > 0)) continue;
            if (costSideIncomplete(profit)) {
                unpriceable += 1;
                continue;
            }
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                goldPerHour: profit.profitPerHour,
                kind: 'gathering',
                sustainable: UNBOUNDED,
                // Gathering consumes nothing, so it needs no capital to start;
                // what it sells is its own drop table
                upfrontCost: 0,
                sells: (profit.baseOutputs || [])
                    .filter((output) => output?.itemHrid && output.itemsPerHour > 0)
                    .map((output) => ({
                        itemHrid: output.itemHrid,
                        name: output.name || null,
                        unitsPerHour: output.itemsPerHour,
                    })),
            });
            byAction.set(hrid, profit.profitPerHour);
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${hrid} failed:`, error);
        }
    }

    for (const { hrid, action } of availableActions(PRODUCTION_TYPES)) {
        try {
            const profit = await calculateProductionProfit(hrid);
            if (!(profit?.profitPerHour > 0)) continue;
            if (costSideIncomplete(profit)) {
                unpriceable += 1;
                continue;
            }
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                goldPerHour: profit.profitPerHour,
                kind: 'production',
                sustainable: UNBOUNDED,
                // One action's materials is what it costs to start crafting
                upfrontCost: Math.max(0, Number(profit.totalMaterialCost) || 0),
                sells: profit.itemHrid
                    ? [
                          {
                              itemHrid: profit.itemHrid,
                              name: profit.itemName || null,
                              unitsPerHour: Number(profit.totalItemsPerHour) || 0,
                          },
                      ]
                    : [],
            });
            byAction.set(hrid, profit.profitPerHour);
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${hrid} failed:`, error);
        }
    }

    if (unpriceable > 0) {
        notes.push(
            `${unpriceable} action${unpriceable === 1 ? '' : 's'} could not be ranked: something they consume ` +
                'has no market listing, and a cost that cannot be read is not a cost of zero.'
        );
    }

    try {
        rates.push(...alchemyGoldRates({ priceStamp: marketAPI.lastFetchTimestamp || 0 }));
    } catch (error) {
        console.error('[GoalPlanner] Ranking alchemy failed:', error);
        notes.push('Alchemy could not be ranked — see the console.');
    }

    let combatStatus = null;
    try {
        const combat = await loadCombatRates();
        rates.push(...combat.rates);
        combatStatus = combat.status;
        if (combat.status.note) notes.push(combat.status.note);
    } catch (error) {
        console.error('[GoalPlanner] Reading combat rates failed:', error);
        notes.push('Combat could not be ranked — see the console.');
    }

    // Everything above priced what a method *produces*. This is the last step
    // between production and coins: somebody has to buy it. A rate whose output
    // trades once a week cannot be earned at anything like its quoted pace, and
    // ranking it first is how the planner recommended a method that cannot be run.
    let liquidity;
    try {
        liquidity = await applyLiquidityLimits(rates);
    } catch (error) {
        console.error('[GoalPlanner] Bounding rates by market volume failed:', error);
        liquidity = { rates, measured: false };
    }

    if (!liquidity.measured) {
        notes.push(
            'Market volume is not being checked, so a rate here is what its output is *worth*, not what ' +
                'you could sell. Turn on pooled market history to bound methods by how fast they actually trade.'
        );
    }

    liquidity.rates.sort((a, b) => b.goldPerHour - a.goldPerHour);
    return { rates: liquidity.rates, byAction, notes, combatStatus };
}

/**
 * What each action gives per hour, for one skill.
 *
 * Gold is carried alongside experience because a grind is rarely free: a plan
 * that trains Cheesesmithing to 90 and does not say what it costs is only half
 * an answer.
 *
 * @param {string} skillHrid - The skill
 * @param {Map<string, number>} goldByAction - Gold per hour, by action
 * @returns {Array<Object>} Rates, best first
 */
function measureXpRates(skillHrid, goldByAction) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return [];

    const rates = [];
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.experienceGain?.skillHrid !== skillHrid) continue;
        if (!(action.experienceGain.value > 0)) continue;

        try {
            const experience = calculateExpPerHour(hrid);
            if (!experience?.expPerHour) continue;
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                requiredLevel: action.levelRequirement?.level || 1,
                xpPerHour: experience.expPerHour,
                xpPerAction: experience.modifiedXP,
                actionTime: experience.actionTime,
                totalEfficiency: experience.totalEfficiency,
                goldPerHour: goldByAction.get(hrid) || 0,
            });
        } catch (error) {
            console.error(`[GoalPlanner] Rating ${hrid} failed:`, error);
        }
    }

    rates.sort((a, b) => b.xpPerHour - a.xpPerHour);
    return rates;
}

/**
 * Experience per hour from enhancing, and the item that gives it.
 *
 * The one rate the codebase cannot hand over: the XPH panel works it out inside
 * a private helper, and enhancing has a single action whose experience depends
 * entirely on what is being enhanced. So the pieces are re-assembled here —
 * the Markov run, the per-level success and failure experience, the material
 * bill — from the exported functions that own each of them.
 *
 * Ranked over the enhanceable items already in the bag, because those are the
 * ones that can be started today, and quoted for short `+0 → +5` runs, which is
 * how enhancing is trained.
 *
 * @returns {Array<Object>} Rates, best first
 */
function measureEnhancingRates() {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return [];

    // The character's own bench, always: this rates how fast THEIR skill climbs. The item-rule
    // surface ('planner') is for costing a piece, where the market can matter; it used to be
    // asked here with '/items/coin' as a stand-in, leaving the bench choice riding on whether
    // coin's game data happens to carry `isTradable`.
    const params = enhancementParamsFor('planner:training');
    const held = (dataManager.getInventory() || [])
        .filter((item) => item.itemLocationHrid === INVENTORY_LOCATION && item.count > 0 && !item.enhancementLevel)
        .map((item) => ({ hrid: item.itemHrid, details: gameData.itemDetailMap[item.itemHrid] }))
        .filter((entry) => entry.details?.enhancementCosts?.length)
        .sort((a, b) => (b.details.itemLevel || 0) - (a.details.itemLevel || 0))
        .slice(0, ENHANCING_XP_CANDIDATES);

    const rates = [];
    for (const { hrid, details } of held) {
        try {
            const run = calculateEnhancement({
                enhancingLevel: params.enhancingLevel,
                houseLevel: params.houseLevel,
                toolBonus: params.toolBonus || 0,
                speedBonus: params.speedBonus || 0,
                itemLevel: details.itemLevel || 0,
                targetLevel: ENHANCING_XP_TARGET_LEVEL,
                startLevel: 0,
                protectFrom: 0,
                blessedTea: params.teas?.blessed,
                guzzlingBonus: params.guzzlingBonus,
                blessedTeaBonus: params.blessedTeaBonus,
            });
            if (!run?.visitCounts || !(run.totalTime > 0)) continue;

            let totalXP = 0;
            for (let level = 0; level < ENHANCING_XP_TARGET_LEVEL; level += 1) {
                const visits = run.visitCounts[level];
                if (!visits) continue;
                const successRate = (run.successRates[level]?.actualRate ?? 0) / 100;
                totalXP +=
                    visits *
                    (successRate * calculateSuccessXP(level, hrid) +
                        (1 - successRate) * calculateFailureXP(level, hrid));
            }
            if (!(totalXP > 0)) continue;

            let materialPerAttempt = 0;
            for (const cost of details.enhancementCosts || []) {
                materialPerAttempt += (getEnhancementMaterialPrice(cost.itemHrid, 'ask') || 0) * cost.count;
            }

            const xpPerHour = (totalXP / run.totalTime) * 3600;
            rates.push({
                actionHrid: '/actions/enhancing/enhance',
                label: `${details.name || humanise(hrid)} +0 → +${ENHANCING_XP_TARGET_LEVEL}`,
                requiredLevel: 1,
                xpPerHour,
                xpPerAction: totalXP / run.attempts,
                actionTime: run.perActionTime,
                totalEfficiency: 0,
                // Enhancing has no efficiency repeats, so the level-by-level
                // climb the skilling calculator models does not apply
                flatRate: true,
                goldPerHour: -(materialPerAttempt * 3600) / run.perActionTime,
            });
        } catch (error) {
            console.error(`[GoalPlanner] Rating enhancing on ${hrid} failed:`, error);
        }
    }

    rates.sort((a, b) => b.xpPerHour - a.xpPerHour);
    return rates;
}

/**
 * Buy it or make it, whichever the book says is cheaper right now.
 * @param {string} itemHrid - The item
 * @returns {Object|null} `{strategy, totalCost, buyPrice, craftCost, actionHrid, timeHours, requires}`
 */
function acquisitionFor(itemHrid) {
    const plan = computeBestCraftingPlan(itemHrid, 1, 'ask');
    if (!plan || !Number.isFinite(plan.totalCost)) return null;

    const requires = [];
    if (plan.strategy === 'craft' && plan.actionHrid) {
        const requirement = dataManager.getActionDetails(plan.actionHrid)?.levelRequirement;
        if (requirement?.skillHrid && requirement.level > 1) {
            requires.push({ skillHrid: requirement.skillHrid, level: requirement.level });
        }
    }

    return {
        strategy: plan.strategy,
        totalCost: plan.totalCost,
        unitCost: plan.unitCost,
        buyPrice: plan.buyPrice ?? null,
        craftCost: plan.craftCost ?? null,
        actionHrid: plan.actionHrid || null,
        actionsNeeded: plan.actionsNeeded || 0,
        timeHours: plan.strategy === 'craft' ? (getProductionChainTime(itemHrid) || 0) / 3600 : 0,
        requires,
        children: plan.children || [],
    };
}

/**
 * What it costs to take an item to a level.
 *
 * The path optimiser answers the from-scratch case, including which level to
 * start protecting from and whether mirroring beats grinding. A character who
 * already holds a partly enhanced copy is a different chain — one that can fall
 * back below where it started — so that case is run through the Markov
 * calculator directly at the protection level the optimiser chose, priced off
 * the same per-attempt bill.
 *
 * @param {Object} request - `{itemHrid, targetLevel, startLevel}`
 * @returns {Object|null} The run, or null when the item cannot be enhanced
 */
function enhancementRun({ itemHrid, targetLevel, startLevel = 0 }) {
    const params = enhancementParamsFor('planner', itemHrid);
    const path = calculateEnhancementPath(itemHrid, targetLevel, params);
    const strategy = path?.optimalStrategy;
    if (!strategy) return null;

    const source = describeEnhancementSource(params);
    const common = {
        protectFrom: strategy.protectFrom,
        usedMirror: Boolean(strategy.usedMirror),
        baseCost: strategy.baseCost,
        paramsSource: source.kind,
        paramsNote: source.detail,
        xpPerHour: path.xpPerHour,
    };

    if (!(startLevel > 0) || strategy.usedMirror) {
        return {
            ...common,
            attempts: strategy.expectedAttempts,
            totalTimeSeconds: strategy.totalTime,
            materialCost: strategy.materialCost,
            protectionCost: strategy.protectionCost,
            protectionCount: strategy.protectionCount,
            totalCost: strategy.totalCost,
            materialBill: strategy.materialBill || [],
            fromLevel: 0,
        };
    }

    const itemLevel = dataManager.getItemDetails(itemHrid)?.itemLevel || 0;
    const run = calculateEnhancement({
        enhancingLevel: params.enhancingLevel,
        houseLevel: params.houseLevel,
        toolBonus: params.toolBonus || 0,
        speedBonus: params.speedBonus || 0,
        itemLevel,
        targetLevel,
        startLevel,
        protectFrom: strategy.protectFrom,
        blessedTea: params.teas?.blessed,
        guzzlingBonus: params.guzzlingBonus,
        blessedTeaBonus: params.blessedTeaBonus,
    });

    // The per-attempt bill the optimiser already priced, reused rather than
    // rebuilt so a partial run and a full one cannot disagree about materials
    const perAttempt = strategy.expectedAttempts > 0 ? strategy.materialCost / strategy.expectedAttempts : 0;
    const protectionUnit =
        strategy.protectionCount > 0
            ? strategy.protectionCost / strategy.protectionCount
            : getCheapestProtectionPrice(itemHrid)?.price || 0;

    const materialCost = perAttempt * run.attempts;
    const protectionCost = protectionUnit * run.protectionCount;

    return {
        ...common,
        attempts: run.attempts,
        totalTimeSeconds: run.totalTime,
        materialCost,
        protectionCost,
        protectionCount: run.protectionCount,
        // baseCost is subtracted by the engine, which buys the base separately;
        // a run that starts from a copy already held pays for no base at all
        baseCost: 0,
        totalCost: materialCost + protectionCost,
        materialBill: rescaleMaterialBill(strategy.materialBill, {
            attempts: run.attempts,
            fromAttempts: strategy.expectedAttempts,
            protectionCount: run.protectionCount,
            fromProtectionCount: strategy.protectionCount,
        }),
        fromLevel: startLevel,
    };
}

/**
 * The optimiser's bill, restated for a run that starts part of the way up.
 *
 * Same reasoning as the cost above it: the shorter chain is a different Markov
 * run but the same per-attempt recipe, so the bill is scaled by the ratio of
 * attempts rather than rebuilt — a partial run and a full one cannot then
 * disagree about what an attempt consumes.
 *
 * Base and mirror lines are dropped. A character already holding a partly
 * enhanced copy is not buying it again, and a start above +0 never takes the
 * mirror branch.
 *
 * @param {Array<Object>} bill - `materialBill` from the optimiser's strategy
 * @param {Object} ratios - `{attempts, fromAttempts, protectionCount, fromProtectionCount}`
 * @returns {Array<Object>} The rescaled bill
 */
function rescaleMaterialBill(bill, { attempts, fromAttempts, protectionCount, fromProtectionCount }) {
    if (!Array.isArray(bill)) return [];

    const materialRatio = fromAttempts > 0 ? attempts / fromAttempts : 0;
    const protectionRatio = fromProtectionCount > 0 ? protectionCount / fromProtectionCount : 0;

    const rescaled = [];
    for (const line of bill) {
        if (line.kind === 'base' || line.kind === 'mirror') continue;
        const ratio = line.kind === 'protection' ? protectionRatio : materialRatio;
        const count = (line.count || 0) * ratio;
        if (!(count > 0)) continue;
        rescaled.push({ ...line, count, totalCost: (line.unitPrice || 0) * count });
    }
    return rescaled;
}

/**
 * Assemble everything the planner needs, once.
 *
 * @param {Object} [options] - Options
 * @param {boolean} [options.measureRates=true] - Rank every activity's income. Off for a
 *   redraw that only needs names and levels, since the ranking is the expensive part.
 * @returns {Promise<Object>} A context for `planGoal`
 */
export async function buildPlannerContext({ measureRates = true } = {}) {
    if (!marketAPI.isLoaded?.()) {
        try {
            await marketAPI.fetch();
        } catch (error) {
            console.error('[GoalPlanner] Loading market data failed:', error);
        }
    }

    const gameData = dataManager.getInitClientData();
    const measured = measureRates
        ? await measureGoldRates()
        : { rates: [], byAction: new Map(), notes: [], combatStatus: null };
    const rates = measured.rates;
    const goldByAction = measured.byAction;

    const acquisitions = new Map();
    const runs = new Map();
    const xpCache = new Map();
    const houseCosts = new Map();

    return {
        now: Date.now(),
        gold: coinsHeld(),
        levelExperienceTable: gameData?.levelExperienceTable || null,
        pricingNote: `Priced against market data from ${getPriceAgeString() || 'an unknown time'}. Costs move with the book — re-price before committing.`,

        // What a rate provider wants said out loud: a combat snapshot that is
        // missing or stale is a fact about the ranking, not a silent omission
        rateNotes: measured.notes,

        // Which loadout the combat rates were judged against, and what else
        // could have been picked — the panel offers the choice when there is one
        combatStatus: measured.combatStatus,

        itemName: (itemHrid) => dataManager.getItemDetails(itemHrid)?.name || humanise(itemHrid),
        skillName: (skillHrid) => humanise(skillHrid),
        houseRoomName: (roomHrid) => gameData?.houseRoomDetailMap?.[roomHrid]?.name || humanise(roomHrid),

        skill: skillState,
        owned: availableCount,
        reservationNote: (short, itemHrid, goalId) =>
            shortfallNote(short, itemHrid, 0, {
                excludeOwner: goalId ? `${RESERVATION_OWNER_PREFIX}${goalId}` : null,
            }),
        ownedEnhancementLevel: bestOwnedLevel,
        houseLevel: (roomHrid) => dataManager.getHouseRoomLevel(roomHrid),

        goldRates: () => rates,

        xpRates: (skillHrid) => {
            if (xpCache.has(skillHrid)) return xpCache.get(skillHrid);
            const measured =
                skillHrid === ENHANCING_SKILL ? measureEnhancingRates() : measureXpRates(skillHrid, goldByAction);
            xpCache.set(skillHrid, measured);
            return measured;
        },

        acquire: (itemHrid) => {
            if (!acquisitions.has(itemHrid)) acquisitions.set(itemHrid, acquisitionFor(itemHrid));
            return acquisitions.get(itemHrid);
        },

        enhance: (request) => {
            const key = `${request.itemHrid}|${request.startLevel || 0}|${request.targetLevel}`;
            if (!runs.has(key)) runs.set(key, enhancementRun(request));
            return runs.get(key);
        },

        // Filled in by withHouseCosts before planning, because the house
        // calculator is asynchronous and the planner's lookups are not
        houseCost: (roomHrid, fromLevel, toLevel) => houseCosts.get(`${roomHrid}|${fromLevel}|${toLevel}`) ?? null,

        _houseCosts: houseCosts,
    };
}

/**
 * Price the house upgrades a set of goals needs, and fold them into a context.
 *
 * Separate from {@link buildPlannerContext} because the house calculator is
 * asynchronous per level and the planner's lookups are not; pre-resolving only
 * the rooms actually asked for keeps that from becoming a scan of every room in
 * the house.
 *
 * @param {Object} context - A context from `buildPlannerContext`
 * @param {Array<Object>} goals - The goals about to be planned
 * @returns {Promise<Object>} The same context, house costs filled in
 */
export async function withHouseCosts(context, goals) {
    const wanted = (Array.isArray(goals) ? goals : []).filter((goal) => goal?.type === 'house');
    if (!wanted.length) return context;

    try {
        await houseCostCalculator.initialize();
    } catch (error) {
        console.error('[GoalPlanner] Preparing the house calculator failed:', error);
    }

    for (const goal of wanted) {
        const fromLevel = context.houseLevel(goal.roomHrid);
        const toLevel = Number(goal.targetLevel);
        if (!(toLevel > fromLevel)) continue;

        const key = `${goal.roomHrid}|${fromLevel}|${toLevel}`;
        if (context._houseCosts.get(key)) continue;
        try {
            const cost = await houseCostCalculator.calculateCumulativeCost(goal.roomHrid, fromLevel, toLevel);
            const materials = (cost?.materials || []).map((material) => ({
                ...material,
                name: houseCostCalculator.getItemName(material.itemHrid),
            }));
            context._houseCosts.set(key, { ...cost, materials });
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${goal.roomHrid} failed:`, error);
            context._houseCosts.set(key, null);
        }
    }

    return context;
}

export default {
    buildPlannerContext,
    withHouseCosts,
    coinsHeld,
};
