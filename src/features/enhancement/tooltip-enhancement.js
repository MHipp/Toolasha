/**
 * Enhancement Tooltip Module
 *
 * Provides enhancement analysis for item tooltips.
 * Calculates optimal enhancement path and total costs for reaching current enhancement level.
 *
 * This module is part of Phase 2 of Option D (Hybrid Approach):
 * - Enhancement panel: Shows 20-level enhancement table
 * - Item tooltips: Shows optimal path to reach current enhancement level
 */

import { applyMirrorOptimization, calculateEnhancement } from '../../utils/enhancement-calculator.js';
import config from '../../core/config.js';
const toolashaConfig = config;
import dataManager from '../../core/data-manager.js';
import { calculateSuccessXP, calculateFailureXP } from './enhancement-xp.js';
import {
    buildSourceChipHTML,
    describeEnhancementSource,
    enhancementParamsFor,
    sectionAttributes,
    toggleProRates,
    SECTION_ATTR,
    SOURCE_CHIP_CLASS,
} from './enhancement-params-source.js';
import {
    formatLargeNumber,
    numberFormatter,
    formatKMB,
    formatKMB3Digits,
    isAbbreviationEnabled,
} from '../../utils/formatters.js';
import { getItemPrices } from '../../utils/market-data.js';
import { sweepProtectFrom } from '../../utils/enhancement-protect-sweep.js';
import { parseItemCount } from '../../utils/number-parser.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
// The pricing rules moved to utils so the sim's advisor and the inventory savings card — each
// in a bundle that cannot reach this module — could stop carrying their own drifted copies.
// Re-exported below because this module's own callers import them from here.
import {
    getEnhancementMaterialPrice,
    perAttemptMaterialCost,
    getProductionCost,
    getRealisticBaseItemPrice,
    getCheapestProtectionPrice,
} from '../../utils/enhancement-pricing.js';

export { getEnhancementMaterialPrice, getProductionCost, getRealisticBaseItemPrice, getCheapestProtectionPrice };

// Pass-through only: nothing in this module reads the chain time, but the market profit
// calculator and the goal planner import it from here. Written as a re-export rather than an
// import that is only ever re-exported, so the bundles that carry this module without either of
// those callers (combat, ui) drop it silently instead of warning about an unused import on
// every build.
export { getProductionChainTime } from '../../utils/enhancement-pricing.js';

/** What a mirror plan combines its leaves with */
const MIRROR_HRID = '/items/philosophers_mirror';

/**
 * Calculate optimal enhancement path for an item
 * Matches Enhancelator's algorithm exactly:
 * 1. Test all protection strategies for each level
 * 2. Pick minimum cost for each level (mixed strategies)
 * 3. Apply mirror optimization to mixed array
 *
 * @param {string} itemHrid - Item HRID (e.g., '/items/cheese_sword')
 * @param {number} currentEnhancementLevel - Current enhancement level (1-20)
 * @param {Object} config - Enhancement configuration from enhancement-config.js
 * @returns {Object|null} Enhancement analysis or null if not enhanceable
 */
export function calculateEnhancementPath(itemHrid, currentEnhancementLevel, config) {
    // Validate inputs
    if (!itemHrid || currentEnhancementLevel < 1 || currentEnhancementLevel > 20) {
        return null;
    }

    // Get item details
    const gameData = dataManager.getInitClientData();
    if (!gameData) return null;

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails) return null;

    // Check if item is enhanceable
    if (!itemDetails.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 1;

    // Step 1: Build 2D matrix like Enhancelator (all_results)
    // For each target level (1 to currentEnhancementLevel)
    // Test all protection strategies (0, 2, 3, ..., targetLevel)
    // Result: allResults[targetLevel][protectFrom] = cost data

    // The prices are the same at every level — enhancementCosts is not level-indexed and the base
    // item is bought once — so they are read once and the sweep below only walks the chain.
    const prices = priceEnhancementInputs(itemHrid, itemDetails);

    const allResults = [];

    for (let targetLevel = 1; targetLevel <= currentEnhancementLevel; targetLevel++) {
        allResults.push(sweepStrategiesForLevel(targetLevel, itemLevel, config, prices));
    }

    // Step 2: Build target_costs and target_times arrays (minimum cost/time for each level)
    // Like Enhancelator line 451-453
    const targetCosts = new Array(currentEnhancementLevel + 1);
    const targetTimes = new Array(currentEnhancementLevel + 1);
    const targetAttempts = new Array(currentEnhancementLevel + 1);
    // Kept alongside the attempts because a mirror plan's protection bill is the sum over the
    // levels it actually builds, and there is nowhere else that number survives
    const targetProtections = new Array(currentEnhancementLevel + 1);
    targetCosts[0] = toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost')
        ? Math.min(getProductionCost(itemHrid) || Infinity, getItemPrices(itemHrid, 0)?.ask || Infinity) ||
          getRealisticBaseItemPrice(itemHrid)
        : getRealisticBaseItemPrice(itemHrid); // Level 0: base item
    targetTimes[0] = 0; // Level 0: no time needed
    targetAttempts[0] = 0; // Level 0: no attempts needed
    targetProtections[0] = 0; // Level 0: nothing to protect

    for (let level = 1; level <= currentEnhancementLevel; level++) {
        const resultsForLevel = allResults[level - 1];
        // No strategy succeeded for this level (e.g. missing data) — cannot build a path
        if (resultsForLevel.length === 0) {
            return null;
        }
        // Find the result with minimum cost
        const minResult = resultsForLevel.reduce((best, curr) => (curr.totalCost < best.totalCost ? curr : best));
        targetCosts[level] = minResult.totalCost;
        targetTimes[level] = minResult.totalTime;
        targetAttempts[level] = minResult.expectedAttempts;
        targetProtections[level] = minResult.protectionCount || 0;
    }

    // Snapshot the pre-mirror numbers before the mirror pass rewrites targetCosts in place.
    // These arrays used to be aliases of the same array, so the "traditional" cost of a level
    // silently became its mirror cost the moment the pass touched it.
    const traditionalCosts = [...targetCosts];
    const traditionalTimes = [...targetTimes];
    const traditionalAttempts = [...targetAttempts];
    const traditionalProtections = [...targetProtections];

    // Step 3: Apply Philosopher's Mirror optimization (single pass, in-place)
    // Like Enhancelator lines 456-465. The pass itself lives in the calculator so the networth
    // worker and the profile score run the identical sweep instead of three copies of it.
    const mirrorPrice = getRealisticBaseItemPrice(MIRROR_HRID);
    const usedMirror = applyMirrorOptimization(targetCosts, mirrorPrice);

    // Step 4: Build final result with breakdown
    const _finalCost = targetCosts[currentEnhancementLevel];

    // Find which protection strategy was optimal for final level (before mirrors)
    const finalLevelResults = allResults[currentEnhancementLevel - 1];
    if (finalLevelResults.length === 0) {
        return null;
    }
    const optimalTraditional = finalLevelResults.reduce((best, curr) =>
        curr.totalCost < best.totalCost ? curr : best
    );

    // Which levels the finished plan actually mirrors is a question about the path back from
    // the target, not about the first level where mirroring happened to look cheap. A level
    // that mirrors but is never reached from the target contributes nothing.
    const mirrorPlan = expandMirrorPlan(currentEnhancementLevel, usedMirror);

    let optimalStrategy;

    if (mirrorPlan.mirrorCount > 0) {
        // Mirror was used - build mirror-optimized result
        optimalStrategy = buildMirrorOptimizedResult(
            itemHrid,
            currentEnhancementLevel,
            mirrorPlan,
            traditionalCosts,
            traditionalTimes,
            traditionalAttempts,
            traditionalProtections,
            targetCosts,
            optimalTraditional,
            mirrorPrice
        );
    } else {
        // No mirror used - return traditional result
        optimalStrategy = {
            protectFrom: optimalTraditional.protectFrom,
            label: optimalTraditional.protectFrom === 0 ? 'Never' : `+${optimalTraditional.protectFrom}`,
            expectedAttempts: optimalTraditional.expectedAttempts,
            totalTime: optimalTraditional.totalTime,
            baseCost: optimalTraditional.baseCost,
            baseAskPrice: optimalTraditional.baseAskPrice,
            baseBidPrice: optimalTraditional.baseBidPrice,
            baseAskIsCrafted: optimalTraditional.baseAskIsCrafted,
            baseBidIsCrafted: optimalTraditional.baseBidIsCrafted,
            materialCost: optimalTraditional.materialCost,
            materialBreakdown: optimalTraditional.materialBreakdown,
            protectionCost: optimalTraditional.protectionCost,
            protectionItemHrid: optimalTraditional.protectionItemHrid,
            protectionCount: optimalTraditional.protectionCount,
            protectionAskPrice: optimalTraditional.protectionAskPrice,
            protectionBidPrice: optimalTraditional.protectionBidPrice,
            totalCost: optimalTraditional.totalCost,
            usedMirror: false,
            mirrorStartLevel: null,
            materialBill: buildMaterialBill({
                materials: optimalTraditional.materialBreakdown,
                protectionItemHrid: optimalTraditional.protectionItemHrid,
                protectionCount: optimalTraditional.protectionCount,
                protectionUnitPrice: optimalTraditional.protectionAskPrice,
            }),
        };
    }

    // Calculate XP/hr for the optimal path
    let xpPerHour = null;
    let totalExpectedXP = null;
    try {
        const xpCalc = calculateEnhancement({
            enhancingLevel: config.enhancingLevel,
            houseLevel: config.houseLevel,
            toolBonus: config.toolBonus || 0,
            speedBonus: config.speedBonus || 0,
            itemLevel,
            targetLevel: currentEnhancementLevel,
            protectFrom: optimalStrategy.protectFrom,
            blessedTea: config.teas.blessed,
            guzzlingBonus: config.guzzlingBonus,
            blessedTeaBonus: config.blessedTeaBonus,
        });

        if (xpCalc && xpCalc.visitCounts && xpCalc.totalTime > 0) {
            // Same XP formula the tracker and the XPH calculator use. The old inline copy read
            // itemDetails.level, which enhanceable equipment does not have, so it fell through
            // to a level-requirement lookup and produced a different number for the same item.
            let totalXP = 0;
            for (let i = 0; i < currentEnhancementLevel; i++) {
                const visits = xpCalc.visitCounts[i];
                if (!visits) continue;
                const successRate = xpCalc.successRates[i].actualRate / 100;
                const successXP = calculateSuccessXP(i, itemHrid);
                const failXP = calculateFailureXP(i, itemHrid);
                totalXP += visits * (successRate * successXP + (1 - successRate) * failXP);
            }
            xpPerHour = Math.round((totalXP / xpCalc.totalTime) * 3600);
            totalExpectedXP = Math.round(totalXP);
        }
    } catch {
        // XP data is optional; don't let it break the tooltip
    }

    return {
        itemHrid,
        targetLevel: currentEnhancementLevel,
        itemLevel,
        // Whether anything the quote is built on could not be priced; the tooltip says so
        // rather than presenting a partial bill as a full one
        pricesPartial: prices.pricesPartial,
        optimalStrategy,
        allStrategies: [optimalStrategy], // Only return optimal
        xpPerHour,
        totalExpectedXP,
        // Carried through so the tooltip can say whose stats these numbers describe: the
        // character's own, a hand-entered set, or the pro kit
        enhancementParams: config,
        paramsNote: describeEnhancementSource(config).detail,
    };
}

/**
 * Every protect-from strategy for one target level, priced.
 *
 * This used to be a loop here — protect-from 0, then 2 up to the target, one `calculateEnhancement`
 * apiece — and that loop was one of four copies of the same walk in the codebase. It is now the
 * shared engine's, which the enhancing panel's column, the sim's upgrade advisor and the inventory
 * savings card also run. What is left here is turning a row into the record the mirror pass and the
 * tooltip's breakdown want.
 *
 * One behaviour follows from the move and is a fix rather than a side effect: protection nobody can
 * price used to leave `protectionCost` at 0, which made every protected strategy free by
 * construction and win the minimum at every level. The engine has no protected rows at all when
 * there is no priced protection item, so the answer falls back to the unprotected run — which is
 * dearer, and true.
 *
 * @param {number} targetLevel - Level being priced
 * @param {number} itemLevel - The item's own level, which the chain keys on
 * @param {Object} config - Enhancement configuration
 * @param {Object} prices - Result of {@link priceEnhancementInputs}
 * @returns {Array<Object>} One record per strategy, cheapest not yet chosen
 */
function sweepStrategiesForLevel(targetLevel, itemLevel, config, prices) {
    try {
        const { rows } = sweepProtectFrom({
            chain: {
                enhancingLevel: config.enhancingLevel,
                toolBonus: config.toolBonus || 0,
                speedBonus: config.speedBonus || 0,
                itemLevel,
                blessedTea: config.teas.blessed,
                guzzlingBonus: config.guzzlingBonus,
                blessedTeaBonus: config.blessedTeaBonus,
            },
            targetLevel,
            materialCostPerAttempt: prices.materialCostPerAttempt,
            fixedCost: prices.baseCost,
            protectionOptions: prices.protectionOptions,
        });

        return rows.map((row) => ({
            protectFrom: row.protectFrom,
            expectedAttempts: row.attempts,
            totalTime: row.time,
            ...prices.base,
            materialCost: prices.materialCostPerAttempt * row.attempts,
            materialBreakdown: prices.materials.map((material) => ({
                ...material,
                totalQuantity: material.countPerAction * row.attempts,
                totalCost: material.unitPrice * material.countPerAction * row.attempts,
            })),
            protectionCost: row.protections * row.protectionPrice,
            protectionItemHrid: row.protections > 0 ? row.itemHrid : null,
            protectionCount: row.protections,
            protectionAskPrice: row.protections > 0 ? row.protectionPrice : 0,
            protectionBidPrice: row.protections > 0 ? prices.protectionBidPrice : 0,
            totalCost: row.expectedCost,
        }));
    } catch (error) {
        console.error('[Enhancement Tooltip] Strategy calculation error:', error);
        return [];
    }
}

/**
 * What the run's inputs cost, once.
 *
 * None of it varies with the target level: `enhancementCosts` is a flat per-attempt recipe, the
 * base item is bought once whatever level it ends at, and the protection item is whichever is
 * cheapest for this piece. Reading it once per path rather than once per (level, strategy) is why
 * the sweep above only has to walk the chain.
 *
 * @param {string} itemHrid - The item being enhanced
 * @param {Object} itemDetails - Its game data
 * @returns {Object} Per-attempt material cost and breakdown, the base item's prices, and the
 *   protection options the sweep should price the protected rows with
 */
function priceEnhancementInputs(itemHrid, itemDetails) {
    const gameData = dataManager.getInitClientData();

    // Per-attempt materials, through the one shared pricing rule
    const materials = [];
    let materialCostPerAttempt = 0;
    // A material nobody can price contributes 0 to the bill, and a total that quietly leaves it
    // out is an under-quote, not a price — the same rule `perAttemptMaterialCost` states for the
    // XP/hr table and the enhancing panel. The tooltip colours its Total green against the
    // enhanced item's ask, so an unnoticed under-quote reads as "this is profitable".
    let pricesPartial = false;
    for (const material of itemDetails.enhancementCosts || []) {
        const materialDetail = gameData.itemDetailMap[material.itemHrid];
        const price = getEnhancementMaterialPrice(material.itemHrid, 'ask');
        if (!(price > 0) && material.count > 0) pricesPartial = true;
        materialCostPerAttempt += price * material.count;
        materials.push({
            itemHrid: material.itemHrid,
            name: materialDetail?.name || material.itemHrid,
            countPerAction: material.count,
            unitPrice: price,
            bidPrice: getEnhancementMaterialPrice(material.itemHrid, 'bid'),
        });
    }

    // Protection: the cheapest thing that will absorb a failure. A null price means nothing that
    // could protect this item has one, and then there are no protected rows to price at all —
    // rather than a set of them priced at zero, which is what used to happen
    const protectionInfo = getCheapestProtectionPrice(itemHrid);
    const protectionOptions =
        protectionInfo.price > 0 ? [{ itemHrid: protectionInfo.itemHrid, price: protectionInfo.price }] : [];
    let protectionBidPrice = 0;
    if (protectionInfo.price > 0) {
        const protPrices = getItemPrices(protectionInfo.itemHrid, 0);
        protectionBidPrice = protPrices?.bid > 0 ? protPrices.bid : protectionInfo.price;
    }

    // Base item cost (initial investment) — market price or min(crafting, market) per setting
    const craftingCostAsk = getProductionCost(itemHrid, 'ask');
    const craftingCostBid = getProductionCost(itemHrid, 'bid');
    const baseItemPrices = getItemPrices(itemHrid, 0);
    const marketAsk = baseItemPrices?.ask > 0 ? baseItemPrices.ask : 0;
    const marketBid = baseItemPrices?.bid > 0 ? baseItemPrices.bid : 0;
    const useCraftingCost = toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost');
    // Ask drives the decision: use crafted if ask is missing OR crafted ask is cheaper
    const askIsCrafted = useCraftingCost && craftingCostAsk > 0 && (marketAsk === 0 || craftingCostAsk < marketAsk);
    const baseAskPrice = askIsCrafted ? craftingCostAsk : marketAsk || getRealisticBaseItemPrice(itemHrid);
    const baseBidPrice = askIsCrafted
        ? craftingCostBid || craftingCostAsk
        : marketBid || getProductionCost(itemHrid, 'bid') || getRealisticBaseItemPrice(itemHrid);

    // The base item is paid once whatever happens, so an unpriced one understates every level
    if (!(baseAskPrice > 0)) pricesPartial = true;

    return {
        materials,
        materialCostPerAttempt,
        protectionOptions,
        protectionBidPrice,
        pricesPartial,
        baseCost: baseAskPrice,
        base: {
            baseCost: baseAskPrice,
            baseAskPrice,
            baseBidPrice,
            baseAskIsCrafted: askIsCrafted,
            baseBidIsCrafted: askIsCrafted,
        },
    };
}

/**
 * Walk the mirror DP back from the target level to the items the plan actually builds.
 *
 * The DP decides mirror-or-not level by level, and those decisions are not necessarily a clean
 * run: +6 can mirror while +5 does not. Assuming a contiguous block from the first mirrored
 * level and expanding it with Fibonacci quantities invents items the plan never buys. Walking
 * the decisions backwards from the target instead yields exactly the leaves it does buy.
 *
 * @param {number} targetLevel - Level the plan is building
 * @param {boolean[]} usedMirror - Per-level mirror decisions from the DP
 * @returns {{leaves: Array<{level: number, quantity: number}>, mirrorCount: number,
 *   mirrorStartLevel: number|null}} Leaves are levels bought traditionally, highest first
 * @private
 */
function expandMirrorPlan(targetLevel, usedMirror) {
    // Two demands, because a mirror step is not symmetric: the primary item —
    // the one being upgraded, which for a refined piece is the refined one —
    // carries on at level-1, and what is consumed beside it is a *copy of the
    // base item* at level-2, which need not be refined. The primary lineage
    // is one chain; everything it consumes, and everything those copies
    // consume in turn, is a plain copy
    const needPrimary = new Array(targetLevel + 1).fill(0);
    const needCopy = new Array(targetLevel + 1).fill(0);
    needPrimary[targetLevel] = 1;

    let mirrorCount = 0;
    let mirrorStartLevel = null;

    // High to low: a level is only expanded once every demand for it is known
    for (let level = targetLevel; level >= 2; level--) {
        if (!usedMirror[level]) continue;
        const primary = needPrimary[level];
        const copies = needCopy[level];
        if (!primary && !copies) continue;

        mirrorCount += primary + copies;
        mirrorStartLevel = level; // Lowest mirrored level reached, since we descend
        if (primary) {
            needPrimary[level - 1] += primary;
            needCopy[level - 2] += primary;
            needPrimary[level] = 0;
        }
        if (copies) {
            needCopy[level - 1] += copies;
            needCopy[level - 2] += copies;
            needCopy[level] = 0;
        }
    }

    const leaves = [];
    for (let level = targetLevel; level >= 0; level--) {
        if (needPrimary[level] > 0) leaves.push({ level, quantity: needPrimary[level], primary: true });
        if (needCopy[level] > 0) leaves.push({ level, quantity: needCopy[level], primary: false });
    }

    return { leaves, mirrorCount, mirrorStartLevel };
}

/**
 * The unrefined item behind a refined one, when the data has it.
 * @param {string} itemHrid - e.g. `/items/griffin_bulwark_refined`
 * @returns {string|null} `/items/griffin_bulwark`, or null for anything else
 */
function unrefinedBaseOf(itemHrid) {
    if (!String(itemHrid || '').endsWith('_refined')) return null;
    const base = String(itemHrid).replace(/_refined$/, '');
    return dataManager.getInitClientData()?.itemDetailMap?.[base] ? base : null;
}

/**
 * What a chosen path expects to consume, item by item.
 *
 * The path optimiser has always returned totals — so many coins in materials —
 * which is enough to compare two strategies and not enough to go and buy them.
 * This is the same arithmetic said as a list, so anything holding a plan can put
 * it on the marketplace.
 *
 * **Every count is an expectation, not a bill.** Enhancing is a Markov chain:
 * the attempt counts these quantities are multiplied out from are the *expected*
 * number of attempts along the path, and a real run will take more or fewer.
 * Buying exactly this list is buying the mean, which is the right order of
 * magnitude and the wrong number to be surprised by.
 *
 * @param {Object} parts - The pieces of a strategy
 * @param {Array<Object>} [parts.materials] - `materialBreakdown` rows, already multiplied by attempts
 * @param {number} [parts.materialMultiplier=1] - Scales the rows, for a plan that runs the
 *   same per-attempt bill a different number of times (a mirror plan's leaves)
 * @param {string} [parts.protectionItemHrid] - What the plan protects with
 * @param {number} [parts.protectionCount=0] - Expected protections consumed
 * @param {number} [parts.protectionUnitPrice=0] - Price of one
 * @param {number} [parts.mirrorCount=0] - Philosopher's Mirrors the plan combines
 * @param {number} [parts.mirrorPrice=0] - Price of one
 * @param {string} [parts.baseItemHrid] - Base item, for a plan that consumes more than the one
 *   copy its owner is assumed to be holding
 * @param {number} [parts.baseCount=0] - How many base copies the plan consumes
 * @param {number} [parts.baseUnitPrice=0] - Price of one
 * @returns {Array<{itemHrid: string, name: string, count: number, unitPrice: number,
 *   totalCost: number, kind: string}>} The bill, materials first; `kind` is one of
 *   `material`, `protection`, `mirror`, `base`
 * @private
 */
function buildMaterialBill({
    materials = [],
    materialMultiplier = 1,
    protectionItemHrid = null,
    protectionCount = 0,
    protectionUnitPrice = 0,
    mirrorCount = 0,
    mirrorPrice = 0,
    baseItemHrid = null,
    baseCount = 0,
    baseUnitPrice = 0,
    copyItemHrid = null,
    copyCount = 0,
    copyUnitPrice = 0,
} = {}) {
    const gameData = dataManager.getInitClientData();
    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid;

    const bill = [];

    for (const material of materials || []) {
        const count = (material.totalQuantity || 0) * materialMultiplier;
        if (!(count > 0)) continue;
        bill.push({
            itemHrid: material.itemHrid,
            name: material.name || nameOf(material.itemHrid),
            count,
            unitPrice: material.unitPrice || 0,
            totalCost: (material.unitPrice || 0) * count,
            kind: 'material',
        });
    }

    if (protectionItemHrid && protectionCount > 0) {
        bill.push({
            itemHrid: protectionItemHrid,
            name: nameOf(protectionItemHrid),
            count: protectionCount,
            unitPrice: protectionUnitPrice,
            totalCost: protectionUnitPrice * protectionCount,
            kind: 'protection',
        });
    }

    if (mirrorCount > 0) {
        bill.push({
            itemHrid: MIRROR_HRID,
            name: nameOf(MIRROR_HRID),
            count: mirrorCount,
            unitPrice: mirrorPrice,
            totalCost: mirrorPrice * mirrorCount,
            kind: 'mirror',
        });
    }

    if (baseItemHrid && baseCount > 0) {
        bill.push({
            itemHrid: baseItemHrid,
            name: nameOf(baseItemHrid),
            count: baseCount,
            unitPrice: baseUnitPrice,
            totalCost: baseUnitPrice * baseCount,
            kind: 'base',
        });
    }

    // The plain copies a refined piece is mirrored with
    if (copyItemHrid && copyCount > 0) {
        bill.push({
            itemHrid: copyItemHrid,
            name: nameOf(copyItemHrid),
            count: copyCount,
            unitPrice: copyUnitPrice,
            totalCost: copyUnitPrice * copyCount,
            kind: 'base',
        });
    }

    return bill;
}

/**
 * Build mirror-optimized result from an expanded plan
 * @param {string} itemHrid - Item being enhanced
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} plan - Result of expandMirrorPlan()
 * @param {number[]} traditionalCosts - Pre-mirror cost per level
 * @param {number[]} traditionalTimes - Pre-mirror time per level
 * @param {number[]} traditionalAttempts - Pre-mirror attempts per level
 * @param {number[]} traditionalProtections - Pre-mirror protections consumed per level
 * @param {number[]} targetCosts - Post-mirror cost per level
 * @param {Object} optimalTraditional - Best non-mirror strategy for the target level
 * @param {number} mirrorPrice - Price of one Philosopher's Mirror
 * @private
 */
function buildMirrorOptimizedResult(
    itemHrid,
    targetLevel,
    plan,
    traditionalCosts,
    traditionalTimes,
    traditionalAttempts,
    traditionalProtections,
    targetCosts,
    optimalTraditional,
    mirrorPrice
) {
    const { leaves, mirrorCount, mirrorStartLevel } = plan;

    // A refined piece is mirrored with plain copies: the primary lineage is
    // the refined item, every consumed copy is the unrefined base at its
    // level — the same enhancement bill on a far cheaper +0
    const copyHrid = unrefinedBaseOf(itemHrid);
    const copyBasePrice = copyHrid ? getRealisticBaseItemPrice(copyHrid) : null;
    const costOf = (level, primary) => {
        if (primary || !copyHrid || !(copyBasePrice > 0)) return traditionalCosts[level];
        return Math.max(0, traditionalCosts[level] - traditionalCosts[0]) + copyBasePrice;
    };

    // Every leaf is a level the plan buys outright, so it is priced at its traditional cost
    const consumedItems = leaves.map(({ level, quantity, primary }) => ({
        level,
        quantity,
        itemHrid: primary || !copyHrid ? itemHrid : copyHrid,
        primary: Boolean(primary),
        costEach: costOf(level, primary),
        totalCost: quantity * costOf(level, primary),
    }));

    const consumedItemsCost = consumedItems.reduce((sum, item) => sum + item.totalCost, 0);
    const totalMirrorsCost = mirrorCount * mirrorPrice;

    // Mirror combinations are instant, so only the leaves cost time and attempts
    const totalTime = leaves.reduce((sum, { level, quantity }) => sum + quantity * traditionalTimes[level], 0);
    const totalAttempts = leaves.reduce((sum, { level, quantity }) => sum + quantity * traditionalAttempts[level], 0);
    const totalProtections = leaves.reduce(
        (sum, { level, quantity }) => sum + quantity * (traditionalProtections[level] || 0),
        0
    );

    // Every leaf starts from its own base copy — a mirror plan for +10 buys several items and
    // combines them, which is the fact a totals-only answer hides and a shopping list cannot.
    // For a refined piece the primary leaf is the refined base and the rest are plain copies
    const totalBaseItems = leaves.reduce((sum, { quantity }) => sum + quantity, 0);
    const primaryBaseItems = copyHrid
        ? leaves.filter((leaf) => leaf.primary).reduce((sum, { quantity }) => sum + quantity, 0)
        : totalBaseItems;
    const copyBaseItems = copyHrid ? totalBaseItems - primaryBaseItems : 0;

    // The per-attempt material bill is the same at every level, so the target-level strategy's
    // breakdown (which is already multiplied by *its* attempts) scales to the plan's attempts
    const materialMultiplier =
        optimalTraditional.expectedAttempts > 0 ? totalAttempts / optimalTraditional.expectedAttempts : 0;

    // For mirror phase: ONLY consumed items + mirrors
    // The consumed item costs from targetCosts already include base/materials/protection
    // NO separate base/materials/protection for main item!

    return {
        protectFrom: optimalTraditional.protectFrom,
        label: optimalTraditional.protectFrom === 0 ? 'Never' : `From +${optimalTraditional.protectFrom}`,
        expectedAttempts: totalAttempts,
        totalTime: totalTime,
        baseCost: 0, // Not applicable for mirror phase
        materialCost: 0, // Not applicable for mirror phase
        protectionCost: 0, // Not applicable for mirror phase
        protectionItemHrid: null,
        protectionCount: 0,
        consumedItemsCost,
        philosopherMirrorCost: totalMirrorsCost,
        // The recursive formula, less what plain copies save a refined piece
        totalCost:
            targetCosts[targetLevel] -
            leaves.reduce(
                (sum, { level, quantity, primary }) =>
                    sum + quantity * (traditionalCosts[level] - costOf(level, primary)),
                0
            ),
        mirrorStartLevel: mirrorStartLevel,
        usedMirror: true,
        traditionalCost: optimalTraditional.totalCost,
        consumedItems: consumedItems,
        mirrorCount: mirrorCount,
        consumedItemHrid: itemHrid,
        copyItemHrid: copyHrid,
        materialBill: buildMaterialBill({
            materials: optimalTraditional.materialBreakdown,
            materialMultiplier,
            protectionItemHrid: optimalTraditional.protectionItemHrid || getCheapestProtectionPrice(itemHrid)?.itemHrid,
            protectionCount: totalProtections,
            protectionUnitPrice:
                optimalTraditional.protectionAskPrice || getCheapestProtectionPrice(itemHrid)?.price || 0,
            mirrorCount,
            mirrorPrice,
            baseItemHrid: itemHrid,
            baseCount: primaryBaseItems,
            baseUnitPrice: traditionalCosts[0],
            copyItemHrid: copyHrid,
            copyCount: copyBaseItems,
            copyUnitPrice: copyBasePrice || 0,
        }),
    };
}

/**
 * Calculate the gold cost of a single enhancement attempt's consumed materials (ask-side
 * market price). Materials are consumed on every attempt regardless of success/failure, and
 * this cost is the same at every enhancement level (enhancementCosts is not level-indexed).
 *
 * Pricing goes through getEnhancementMaterialPrice(), so coins are taken at face value,
 * untradeable trainee charms at their fixed price, and a one-sided market quote is filled in
 * from whichever side exists.
 *
 * The tallying now lives in `utils/enhancement-pricing.js` as `perAttemptMaterialCost`, shared
 * with the sim's advisor and the savings card. This wrapper keeps the `costPartial` field name
 * its own callers (the XP/hr table and the risk-of-ruin adapter) already read.
 * @param {Object} itemDetails - Item details containing enhancementCosts.
 * @returns {{cost: number, hasCost: boolean, costPartial: boolean}}
 */
export function calculatePerAttemptMaterialCost(itemDetails) {
    const { cost, hasCost, hasMissingPrices } = perAttemptMaterialCost(itemDetails);
    return { cost, hasCost, costPartial: hasMissingPrices };
}

/**
 * Minimum sell price that covers the total cost plus a target hourly rate for the
 * time the enhancement takes, optionally grossed up for the marketplace seller tax.
 * @param {number} totalCost - Total cost to reach the level, on one side (ask or bid)
 * @param {number} totalTimeSeconds - Total enhancing time, in seconds
 * @param {number} hourlyRate - Target coins/hour for time spent
 * @param {boolean} includeTax - Whether to gross up for the marketplace seller tax
 * @returns {number} Minimum sell price
 */
export function calculateMinimumSellPrice(totalCost, totalTimeSeconds, hourlyRate, includeTax) {
    const breakeven = totalCost + hourlyRate * (totalTimeSeconds / 3600);
    return includeTax ? breakeven / (1 - MARKET_TAX) : breakeven;
}

/**
 * Build HTML for enhancement tooltip section
 * @param {Object} enhancementData - Enhancement analysis from calculateEnhancementPath()
 * @returns {string} HTML string
 */
export function buildEnhancementTooltipHTML(enhancementData) {
    if (!enhancementData || !enhancementData.optimalStrategy) {
        return '';
    }

    const {
        itemHrid,
        targetLevel,
        optimalStrategy,
        xpPerHour,
        totalExpectedXP,
        paramsNote,
        enhancementParams,
        pricesPartial,
    } = enhancementData;

    // Validate required fields
    if (
        typeof optimalStrategy.expectedAttempts !== 'number' ||
        typeof optimalStrategy.totalTime !== 'number' ||
        typeof optimalStrategy.materialCost !== 'number' ||
        typeof optimalStrategy.totalCost !== 'number'
    ) {
        console.error('[Enhancement Tooltip] Missing required fields in optimal strategy:', optimalStrategy);
        return '';
    }

    let html =
        `<div ${sectionAttributes('path', itemHrid, targetLevel)} ` +
        'style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px;">';
    html +=
        '<div style="font-weight: bold; margin-bottom: 4px;">ENHANCEMENT PATH (+0 → +' +
        targetLevel +
        ')' +
        buildSourceChipHTML(enhancementParams) +
        '</div>';
    html += '<div style="font-size: 0.9em; margin-left: 8px;">';

    // Optimal strategy
    if (optimalStrategy.protectFrom === 0) {
        html += '<div>No protection needed for +' + targetLevel + '</div>';
    } else {
        html += '<div>Protect from: ' + optimalStrategy.label + '</div>';
    }

    // Show Philosopher's Mirror usage if applicable
    if (optimalStrategy.usedMirror && optimalStrategy.mirrorStartLevel) {
        html +=
            '<div style="color: ' +
            config.COLOR_MIRROR +
            ';">Uses Philosopher\'s Mirror from +' +
            optimalStrategy.mirrorStartLevel +
            '</div>';
    }

    html += '<div>Expected Attempts: ' + formatLargeNumber(optimalStrategy.expectedAttempts.toFixed(1)) + '</div>';

    // Costs table
    html += '<div style="margin-top: 8px;">';
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em; color: ${config.COLOR_TOOLTIP_INFO};">`;

    // Table header
    html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
    html += '<th style="padding: 2px 4px; text-align: left;">Material</th>';
    html += '<th style="padding: 2px 4px; text-align: center;">Count</th>';
    html += '<th style="padding: 2px 4px; text-align: right;">Ask</th>';
    html += '<th style="padding: 2px 4px; text-align: right;">Bid</th>';
    html += '</tr>';

    // Hoisted so both breakdowns populate them and the minimum-sell section below can read them
    let totalAsk = 0;
    let totalBid = 0;

    // Check if using mirror optimization
    if (optimalStrategy.usedMirror && optimalStrategy.consumedItems && optimalStrategy.consumedItems.length > 0) {
        // Mirror-optimized breakdown
        // Calculate totals for mirror path

        // Consumed items (enhanced items at specific levels)
        const sortedConsumed = [...optimalStrategy.consumedItems]
            .filter((item) => item.quantity > 0)
            .sort((a, b) => b.level - a.level);

        const gameData = dataManager.getInitClientData();
        const consumedHrid = optimalStrategy.consumedItemHrid ?? itemHrid;

        const consumedRows = sortedConsumed.map((item) => {
            // Each leaf names its own item: the refined primary, or the plain
            // copy a refined piece is mirrored with
            const hrid = item.itemHrid || consumedHrid;
            const name = gameData?.itemDetailMap?.[hrid]?.name || hrid;
            const prices = getItemPrices(hrid, item.level);
            const askPrice = prices?.ask > 0 ? prices.ask : item.costEach;
            const bidPrice = prices?.bid > 0 ? prices.bid : item.costEach;
            totalAsk += askPrice * item.quantity;
            totalBid += bidPrice * item.quantity;
            return { name: name + ' +' + item.level, count: item.quantity, askPrice, bidPrice };
        });

        // Philosopher's Mirror row
        if (optimalStrategy.philosopherMirrorCost > 0 && optimalStrategy.mirrorCount > 0) {
            const mirrorPrices = getItemPrices('/items/philosophers_mirror', 0);
            const mirrorAsk = mirrorPrices?.ask > 0 ? mirrorPrices.ask : 0;
            const mirrorBid = mirrorPrices?.bid > 0 ? mirrorPrices.bid : 0;
            totalAsk += mirrorAsk * optimalStrategy.mirrorCount;
            totalBid += mirrorBid * optimalStrategy.mirrorCount;
            consumedRows.push({
                name: "Philosopher's Mirror",
                count: optimalStrategy.mirrorCount,
                askPrice: mirrorAsk,
                bidPrice: mirrorBid,
            });
        }

        // Color total ask/bid by comparison to market price of enhanced item
        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const totalAskColor =
            enhancedPrices?.ask > 0
                ? totalAsk < enhancedPrices.ask
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';
        const totalBidColor =
            enhancedPrices?.bid > 0
                ? totalBid < enhancedPrices.bid
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';

        // Total row
        html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
        html += '<td style="padding: 2px 4px; font-weight: bold;">Total</td>';
        html += '<td style="padding: 2px 4px; text-align: center;"></td>';
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalAskColor ? ' color: ' + totalAskColor + ';' : ''}">${formatKMB(totalAsk)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalBidColor ? ' color: ' + totalBidColor + ';' : ''}">${formatKMB(totalBid)}</td>`;
        html += '</tr>';

        // Item rows
        for (const row of consumedRows) {
            html += '<tr>';
            html += `<td style="padding: 2px 4px;">${row.name}</td>`;
            html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(row.count)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.askPrice)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.bidPrice)}</td>`;
            html += '</tr>';
        }
    } else {
        // Traditional (non-mirror) breakdown
        // Calculate totals
        let totalCount = 1; // Base item counts as 1
        totalAsk = optimalStrategy.baseAskPrice || optimalStrategy.baseCost;
        totalBid = optimalStrategy.baseBidPrice || optimalStrategy.baseCost;

        const rows = [];

        // Base item row
        const baseItemLabel = optimalStrategy.baseAskIsCrafted ? 'Craft Item' : 'Buy Item';
        rows.push({
            name: toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost') ? baseItemLabel : 'Base Item',
            count: 1,
            askPrice: optimalStrategy.baseAskPrice || optimalStrategy.baseCost,
            bidPrice: optimalStrategy.baseBidPrice || optimalStrategy.baseCost,
        });

        // Material rows
        if (optimalStrategy.materialBreakdown && optimalStrategy.materialBreakdown.length > 0) {
            for (const mat of optimalStrategy.materialBreakdown) {
                const count = mat.totalQuantity;
                const askPrice = mat.unitPrice;
                const bidPrice = mat.bidPrice || mat.unitPrice;
                totalCount += count;
                totalAsk += askPrice * count;
                totalBid += bidPrice * count;
                rows.push({ name: mat.name, count, askPrice, bidPrice, isCoin: mat.itemHrid === '/items/coin' });
            }
        }

        // Protection row
        if (optimalStrategy.protectionCost > 0 && optimalStrategy.protectionCount > 0) {
            const count = optimalStrategy.protectionCount;
            const askPrice = optimalStrategy.protectionAskPrice || 0;
            const bidPrice = optimalStrategy.protectionBidPrice || askPrice;
            totalCount += count;
            totalAsk += askPrice * count;
            totalBid += bidPrice * count;

            let protName = 'Protection';
            if (optimalStrategy.protectionItemHrid) {
                const gameData = dataManager.getInitClientData();
                const protDetails = gameData?.itemDetailMap[optimalStrategy.protectionItemHrid];
                if (protDetails?.name) {
                    protName = protDetails.name;
                }
            }
            rows.push({ name: protName, count, askPrice, bidPrice });
        }

        // Color total ask/bid by comparison to market price of enhanced item
        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const totalAskColor =
            enhancedPrices?.ask > 0
                ? totalAsk < enhancedPrices.ask
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';
        const totalBidColor =
            enhancedPrices?.bid > 0
                ? totalBid < enhancedPrices.bid
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';

        // Total row
        html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
        html += '<td style="padding: 2px 4px; font-weight: bold;">Total</td>';
        html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(totalCount)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalAskColor ? ' color: ' + totalAskColor + ';' : ''}">${formatKMB(totalAsk)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalBidColor ? ' color: ' + totalBidColor + ';' : ''}">${formatKMB(totalBid)}</td>`;
        html += '</tr>';

        // Item rows
        for (const row of rows) {
            html += '<tr>';
            html += `<td style="padding: 2px 4px;">${row.name}</td>`;
            if (row.isCoin) {
                html += '<td style="padding: 2px 4px; text-align: center;">—</td>';
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.count)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.count)}</td>`;
            } else {
                html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(row.count)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.askPrice)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.bidPrice)}</td>`;
            }
            html += '</tr>';
        }
    }

    html += '</table>';
    if (pricesPartial) {
        // Same wording the enhancing panel uses for the same condition, so the two surfaces
        // never say different things about the same missing quote
        html += `<div style="margin-top: 4px; color: ${config.COLOR_TOOLTIP_LOSS};">Some inputs have no price; costs are understated.</div>`;
    }
    html += '</div>';

    // Time estimate
    const totalSeconds = optimalStrategy.totalTime;

    if (totalSeconds < 60) {
        // Less than 1 minute: show seconds
        html += '<div>Time: ~' + Math.round(totalSeconds) + ' seconds</div>';
    } else if (totalSeconds < 3600) {
        // Less than 1 hour: show minutes
        const minutes = Math.round(totalSeconds / 60);
        html += '<div>Time: ~' + minutes + ' minutes</div>';
    } else if (totalSeconds < 86400) {
        // Less than 1 day: show hours
        const hours = (totalSeconds / 3600).toFixed(1);
        html += '<div>Time: ~' + hours + ' hours</div>';
    } else {
        // 1 day or more: show days
        const days = (totalSeconds / 86400).toFixed(1);
        html += '<div>Time: ~' + days + ' days</div>';
    }

    if (xpPerHour !== null && xpPerHour > 0) {
        html += '<div style="margin-top: 4px;">XP/hr: ' + formatLargeNumber(xpPerHour) + '</div>';
    }
    if (totalExpectedXP !== null && totalExpectedXP > 0) {
        html += '<div>Total XP: ~' + formatLargeNumber(totalExpectedXP) + '</div>';
    }

    // Target hourly rate / minimum sell price — only when a rate is configured.
    // The rate is a text setting, so it is read with getSettingValue(); getSetting() only
    // ever answers with a boolean and would silently parse to 0 here.
    const hourlyRate = parseItemCount(config.getSettingValue('itemTooltip_enhancingHourlyRate', ''), 0);
    if (hourlyRate > 0) {
        const includeTax = config.getSetting('itemTooltip_enhancingHourlyRateTax');
        const minSellAsk = calculateMinimumSellPrice(totalAsk, optimalStrategy.totalTime, hourlyRate, includeTax);
        const minSellBid = calculateMinimumSellPrice(totalBid, optimalStrategy.totalTime, hourlyRate, includeTax);

        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const priceColor = (price, minimum) =>
            price > 0 ? (price >= minimum ? config.COLOR_TOOLTIP_PROFIT : config.COLOR_TOOLTIP_LOSS) : '';
        const askColor = priceColor(enhancedPrices?.ask, minSellAsk);
        const bidColor = priceColor(enhancedPrices?.bid, minSellBid);

        html += '<div style="margin-top: 4px;">Your rate: ' + formatKMB3Digits(hourlyRate) + '/hr</div>';
        html += '<div>Minimum sell: ';
        html += `<span${askColor ? ` style="color: ${askColor};"` : ''}>${formatKMB3Digits(minSellAsk)}</span>(ask)/`;
        html += `<span${bidColor ? ` style="color: ${bidColor};"` : ''}>${formatKMB3Digits(minSellBid)}</span>(bid)`;
        html += '</div>';
    }

    // A quiet note, not a warning: these numbers are only as true as the stats behind them,
    // and a hand-entered stat is the one place they can quietly stop describing this character
    if (paramsNote) {
        html += `<div style="margin-top: 4px; font-size: 0.8em; opacity: 0.6;">${paramsNote}</div>`;
    }

    html += '</div>'; // Close margin-left div
    html += '</div>'; // Close main container

    return html;
}

/**
 * Redraw every enhancement section currently on screen with whatever source is now active.
 *
 * The sections are plain HTML inside a game tooltip, so the cheapest correct refresh is to
 * rebuild the same section from the same item and level and swap it in. Anything still open
 * therefore switches the moment the toggle flips, rather than showing the old kit's numbers
 * under the new kit's label until the next hover.
 */
export function rerenderOpenEnhancementSections() {
    if (typeof document === 'undefined') return;

    for (const section of document.querySelectorAll(`[${SECTION_ATTR}]`)) {
        try {
            const itemHrid = section.getAttribute('data-toolasha-enh-item');
            if (!itemHrid) continue;

            const kind = section.getAttribute(SECTION_ATTR);
            const params = enhancementParamsFor('tooltip', itemHrid);

            let html;
            if (kind === 'milestones') {
                html = buildEnhancementMilestonesHTML(itemHrid, params);
            } else {
                const level = parseInt(section.getAttribute('data-toolasha-enh-level'), 10);
                const data = level > 0 ? calculateEnhancementPath(itemHrid, level, params) : null;
                html = data ? buildEnhancementTooltipHTML(data) : '';
            }

            // An empty rebuild means the new params produced nothing to say; leaving the old
            // section up would label it with a source that did not produce it, so it goes
            section.outerHTML = html;
        } catch (error) {
            console.error('[Enhancement Tooltip] Failed to redraw section for new stats source:', error);
        }
    }
}

let _sourceToggleHandlers = null;

/**
 * Make the source chip live: clicking it, or pressing P while a section is on screen, switches
 * the prediction between the player's own stats and pro rates and redraws what is open.
 *
 * The key is what makes the toggle usable on a hover tooltip, which vanishes the moment the
 * pointer leaves the item it describes — there is no way to walk the cursor over to the chip.
 * The chip stays clickable for the tooltips that do stay open (item click popups).
 */
export function installEnhancementSourceToggle() {
    if (typeof document === 'undefined' || _sourceToggleHandlers) return;

    const flip = () => {
        toggleProRates();
        rerenderOpenEnhancementSections();
    };

    const onClick = (event) => {
        const chip = event.target?.closest?.(`.${SOURCE_CHIP_CLASS}`);
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        flip();
    };

    const onKeyDown = (event) => {
        if (event.key?.toLowerCase() !== 'p' || event.ctrlKey || event.altKey || event.metaKey) return;

        // Never steal a keystroke from chat, a price box or any other field being typed into
        const target = event.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

        // Only meaningful while a prediction is actually on screen to be re-sourced
        if (!document.querySelector(`[${SECTION_ATTR}]`)) return;

        event.preventDefault();
        flip();
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    _sourceToggleHandlers = { onClick, onKeyDown };
}

/**
 * Remove the source toggle's listeners.
 */
export function uninstallEnhancementSourceToggle() {
    if (typeof document === 'undefined' || !_sourceToggleHandlers) return;

    document.removeEventListener('click', _sourceToggleHandlers.onClick, true);
    document.removeEventListener('keydown', _sourceToggleHandlers.onKeyDown, true);
    _sourceToggleHandlers = null;
}

const MILESTONE_LEVELS = [5, 7, 10, 12];

/**
 * Build compact enhancement milestones HTML for unenhanced item tooltips
 * Shows expected cost and XP for +5, +7, +10, +12
 * @param {string} itemHrid - Item HRID
 * @param {Object} enhancementConfig - Enhancement configuration from getEnhancingParams()
 * @returns {string} HTML string, or empty string if item is not enhanceable
 */
export function buildEnhancementMilestonesHTML(itemHrid, enhancementConfig) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return '';

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails?.enhancementCosts?.length) return '';

    const showPrices = config.getSetting('itemTooltip_prices');
    const useKMB = isAbbreviationEnabled();
    const fmt = (n) => (n != null && n > 0 ? (useKMB ? formatLargeNumber(n, 0) : numberFormatter(Math.round(n))) : '—');
    const fmtCost = (n) =>
        n != null && n > 0 ? (useKMB ? formatLargeNumber(n, 1) : numberFormatter(Math.round(n))) : '—';

    const rows = [];
    for (const level of MILESTONE_LEVELS) {
        const data = calculateEnhancementPath(itemHrid, level, enhancementConfig);
        if (!data) continue;

        const cost = fmtCost(data.optimalStrategy.totalCost);
        const xp = data.totalExpectedXP !== null ? fmt(Math.round(data.totalExpectedXP)) : '—';

        let ask = '—';
        let bid = '—';
        if (showPrices) {
            const prices = getItemPrices(itemHrid, level);
            ask = fmt(prices?.ask);
            bid = fmt(prices?.bid);
        }

        rows.push({ level, cost, xp, ask, bid });
    }

    if (rows.length === 0) return '';

    const tdStyle = (align = 'right', color = '') =>
        `style="padding: 1px 6px; text-align: ${align};${color ? ` color: ${color};` : ''}"`;
    const thStyle = (align = 'right') =>
        `style="padding: 1px 6px; text-align: ${align}; opacity: 0.6; font-weight: normal;"`;

    let html =
        `<div ${sectionAttributes('milestones', itemHrid, 0)} ` +
        'style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px;">';
    html +=
        '<div style="font-weight: bold; margin-bottom: 4px;">Enhancement Milestones' +
        buildSourceChipHTML(enhancementConfig) +
        '</div>';
    html += '<table style="font-size: 0.9em; border-collapse: collapse; width: 100%;">';
    html += '<thead><tr>';
    html += `<th ${thStyle('left')}>Level</th>`;
    html += `<th ${thStyle()}>Cost</th>`;
    if (showPrices) html += `<th ${thStyle()}>Ask / Bid</th>`;
    html += `<th ${thStyle()}>XP</th>`;
    html += '</tr></thead><tbody>';

    for (const row of rows) {
        html += '<tr>';
        html += `<td ${tdStyle('left', config.COLOR_TOOLTIP_INFO)}>+${row.level}</td>`;
        html += `<td ${tdStyle('right', config.COLOR_TOOLTIP_INFO)}>${row.cost}</td>`;
        if (showPrices) {
            html += `<td ${tdStyle('right', config.COLOR_TOOLTIP_INFO)}>${row.ask} / ${row.bid}</td>`;
        }
        html += `<td ${tdStyle('right', config.COLOR_XP_RATE)}>${row.xp}</td>`;
        html += '</tr>';
    }

    html += '</tbody></table>';

    const paramsNote = describeEnhancementSource(enhancementConfig).detail;
    if (paramsNote) {
        html += `<div style="font-size: 0.8em; opacity: 0.6; margin-top: 2px;">${paramsNote}</div>`;
    }

    html += '</div>';

    return html;
}
