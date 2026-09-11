/**
 * Combat Score Calculator
 * Calculates player gear score based on:
 * - House Score: Cost of battle houses
 * - Ability Score: Cost to reach current ability levels
 * - Equipment Score: Cost to enhance equipped items
 */

import { explainAbilityCost } from '../../utils/ability-cost-calculator.js';
import { calculateBattleHousesCost } from '../../utils/house-cost-calculator.js';
import dataManager from '../../core/data-manager.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { getItemPrice, getItemPrices } from '../../utils/market-data.js';
import config from '../../core/config.js';
import { calculateEnhancementBatch } from '../../utils/enhancement-worker-manager.js';
import { applyMirrorOptimization } from '../../utils/enhancement-calculator.js';
import { getCheapestProtectionPrice, getRealisticBaseItemPrice } from '../enhancement/tooltip-enhancement.js';
import { getShopCoinCost } from '../../utils/game-lookups.js';
import { buildGoldPerCredit, priceGuildCreditCosts } from '../../utils/guild-credit-pricing.js';
import { isMarketplacePatchLive } from '../../utils/server-gate.js';
import { TRAINEE_SHOP_PRICE } from '../../utils/enhancement-pricing.js';

/**
 * Token-based item data for untradeable back slot items (capes/cloaks/quivers)
 * These items are purchased with dungeon tokens and have no market data
 */
const CAPE_ITEM_TOKEN_DATA = {
    '/items/chimerical_quiver': {
        tokenCost: 35000,
        tokenShopItems: [
            { hrid: '/items/griffin_leather', cost: 600 },
            { hrid: '/items/manticore_sting', cost: 1000 },
            { hrid: '/items/jackalope_antler', cost: 1200 },
            { hrid: '/items/dodocamel_plume', cost: 3000 },
            { hrid: '/items/griffin_talon', cost: 3000 },
        ],
    },
    '/items/sinister_cape': {
        tokenCost: 27000,
        tokenShopItems: [
            { hrid: '/items/acrobats_ribbon', cost: 2000 },
            { hrid: '/items/magicians_cloth', cost: 2000 },
            { hrid: '/items/chaotic_chain', cost: 3000 },
            { hrid: '/items/cursed_ball', cost: 3000 },
        ],
    },
    '/items/enchanted_cloak': {
        tokenCost: 27000,
        tokenShopItems: [
            { hrid: '/items/royal_cloth', cost: 2000 },
            { hrid: '/items/knights_ingot', cost: 2000 },
            { hrid: '/items/bishops_scroll', cost: 2000 },
            { hrid: '/items/regal_jewel', cost: 3000 },
            { hrid: '/items/sundering_jewel', cost: 3000 },
        ],
    },
};

/**
 * Skill classification for equipment categorization
 */
const COMBAT_SKILLS = ['attack', 'melee', 'defense', 'ranged', 'magic', 'prayer'];
const SKILLING_SKILLS = [
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'brewing',
    'cooking',
    'alchemy',
    'enhancing',
];

/**
 * Categorize equipment item by skill requirements
 * @param {string} slot - Item slot HRID (e.g., "/item_locations/neck")
 * @param {Object} equipmentDetail - Equipment detail from item data
 * @returns {Object} {combat: boolean, skiller: boolean}
 */
function categorizeEquipmentItem(slot, equipmentDetail) {
    // Tools always go to skiller only (regardless of requirements)
    if (slot.endsWith('_tool')) {
        return { combat: false, skiller: true };
    }

    const requirements = equipmentDetail?.levelRequirements || [];

    // No requirements → both scores
    if (requirements.length === 0) {
        return { combat: true, skiller: true };
    }

    // Check for combat vs skilling requirements
    const hasCombat = requirements.some((req) => COMBAT_SKILLS.some((skill) => req.skillHrid.includes(skill)));
    const hasSkilling = requirements.some((req) => SKILLING_SKILLS.some((skill) => req.skillHrid.includes(skill)));

    return { combat: hasCombat, skiller: hasSkilling };
}

/**
 * Calculate combat score from profile data
 *
 * Every breakdown row carries `name` and `value` — a label and its score,
 * already rounded to one decimal — plus the raw `cost` in coins and whatever
 * identifies the thing: `itemHrid`/`slot`/`enhancementLevel` for equipment,
 * `hrid`/`itemHrid`/`level` for abilities, `level` for houses, `hrid`/`level`/
 * `tokens` for shrines. The rounded string is what a display prints; the raw
 * cost is what anything ordering or summing the rows should use.
 *
 * @param {Object} profileData - Profile data from game
 * @returns {Promise<Object>} {total, house, ability, equipment, guildShrine, guildShrineKnown, breakdown}
 */
export async function calculateCombatScore(profileData) {
    try {
        // 1. Calculate House Score
        const houseResult = calculateHouseScore(profileData);

        // 2. Calculate Ability Score
        const abilityResult = calculateAbilityScore(profileData);

        // 2b. Guild shrine levels, when the payload carries them
        const guildShrineResult = calculateGuildShrineScore(profileData);

        // The pricing context, read once before anything suspends.
        //
        // `getEnhancingParams()` with auto-detect on walks the *live* character's
        // loadout and enhancing level, and both of the calls below used to read
        // it for themselves. The combat pass awaits an enhancement worker batch
        // that can run for seconds on a long chain, so a character switch landing
        // in it had the skiller pass re-read the params and price the second half
        // of the same score object against the arriving character's kit — one
        // score, two enhancers. (`getEnhancingParams` memoises for a second, which
        // narrows the window and does not close it.) Reading it once here is also
        // simply correct: both halves of one score describe one setup.
        const pricingContext = {
            useHighEnhancementCost: config.getSetting('networth_highEnhancementUseCost'),
            minLevel: config.getSetting('networth_highEnhancementMinLevel') || 13,
            enhancementParams: getEnhancingParams(),
        };

        // 3. Calculate Combat Equipment Score (async - runs first)
        const combatEquipmentResult = await calculateEquipmentScore(profileData, 'combat', pricingContext);

        // 4. Calculate Skiller Equipment Score (async - runs after combat completes)
        const skillerEquipmentResult = await calculateEquipmentScore(profileData, 'skiller', pricingContext);

        // Shrine levels are shared on every profile once the marketplace patch is
        // live, so a shrine's value then belongs in the score the same way
        // house/ability/equipment do — combat shrines in the combat total,
        // skilling shrines in the skiller total. Before the patch is live
        // everywhere, shrines are known only for your own character, so folding
        // them in would make your score incomparable with everybody else's;
        // gated on the server until then, and kept on their own line meanwhile.
        const foldShrine = isMarketplacePatchLive();
        const combatTotalScore =
            houseResult.score +
            abilityResult.score +
            combatEquipmentResult.score +
            (foldShrine ? guildShrineResult.combat.score : 0);
        const skillerTotalScore = skillerEquipmentResult.score + (foldShrine ? guildShrineResult.skilling.score : 0);

        return {
            // Combat score (house + ability + combat equipment)
            total: combatTotalScore,
            house: houseResult.score,
            ability: abilityResult.score,
            equipment: combatEquipmentResult.score,
            // Now folded into `total`/`skillerTotal` above (combat and skilling
            // halves respectively). Kept as its own field too, so a breakdown can
            // still show the shrine line and its unpriced token count.
            guildShrine: guildShrineResult.score,
            guildShrineTokens: guildShrineResult.tokens,
            // Guild credit costs nothing could convert into gold. The shrine
            // figures above are short by whatever those were worth, so a caller
            // showing them has to be able to say "at least this much" — the same
            // service `equipmentUnpriced` does for a piece nothing could price.
            guildShrineUnpricedCredits: guildShrineResult.unpricedCredits,
            // True whenever the profile carried shrine levels — your own always,
            // and now any shared profile the game exposes them on. False leaves
            // the line out rather than printing a zero for what cannot be seen.
            guildShrineKnown: guildShrineResult.known,
            guildShrineCombat: guildShrineResult.combat.score,
            guildShrineCombatTokens: guildShrineResult.combat.tokens,
            guildShrineCombatUnpricedCredits: guildShrineResult.combat.unpricedCredits,
            equipmentHidden: profileData.profile?.hideWearableItems || false,
            hasEquipmentData: combatEquipmentResult.hasEquipmentData,
            // How many equipped pieces nothing could put a price on. The score
            // is short by whatever they are worth, and a caller that wants to
            // say so needs the count rather than having to re-walk the breakdown
            equipmentUnpriced: combatEquipmentResult.unpricedItems,
            breakdown: {
                houses: houseResult.breakdown,
                abilities: abilityResult.breakdown,
                equipment: combatEquipmentResult.breakdown,
                guildShrines: guildShrineResult.breakdown,
                guildShrinesCombat: guildShrineResult.combat.breakdown,
            },
            // Skiller score (skilling equipment only)
            skillerTotal: skillerTotalScore,
            skillerEquipment: skillerEquipmentResult.score,
            skillerEquipmentUnpriced: skillerEquipmentResult.unpricedItems,
            skillerGuildShrine: guildShrineResult.skilling.score,
            skillerGuildShrineTokens: guildShrineResult.skilling.tokens,
            skillerGuildShrineUnpricedCredits: guildShrineResult.skilling.unpricedCredits,
            skillerBreakdown: {
                equipment: skillerEquipmentResult.breakdown,
                guildShrines: guildShrineResult.skilling.breakdown,
            },
        };
    } catch (error) {
        console.error('[CombatScore] Error calculating score:', error);
        return {
            total: 0,
            house: 0,
            ability: 0,
            equipment: 0,
            guildShrine: 0,
            guildShrineTokens: 0,
            guildShrineUnpricedCredits: 0,
            guildShrineKnown: false,
            guildShrineCombat: 0,
            guildShrineCombatTokens: 0,
            guildShrineCombatUnpricedCredits: 0,
            equipmentHidden: false,
            hasEquipmentData: false,
            equipmentUnpriced: 0,
            breakdown: { houses: [], abilities: [], equipment: [], guildShrines: [], guildShrinesCombat: [] },
            skillerTotal: 0,
            skillerEquipment: 0,
            skillerEquipmentUnpriced: 0,
            skillerGuildShrine: 0,
            skillerGuildShrineTokens: 0,
            skillerGuildShrineUnpricedCredits: 0,
            skillerBreakdown: { equipment: [], guildShrines: [] },
        };
    }
}

/**
 * Get market price for an item with crafting cost fallback
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @returns {number} Price per item (always uses ask price, falls back to crafting cost)
 */
function getMarketPriceWithFallback(itemHrid, enhancementLevel = 0) {
    const gameData = dataManager.getInitClientData();

    // Try ask price first
    const askPrice = getItemPrice(itemHrid, { enhancementLevel, mode: 'ask' });

    if (askPrice && askPrice > 0) {
        return askPrice;
    }

    // For base items (enhancement 0), try crafting cost fallback
    if (enhancementLevel === 0 && gameData) {
        // Find the action that produces this item
        for (const action of Object.values(gameData.actionDetailMap || {})) {
            if (action.outputItems) {
                for (const output of action.outputItems) {
                    if (output.itemHrid === itemHrid) {
                        // Found the crafting action, calculate material costs
                        let inputCost = 0;

                        // Add input items
                        if (action.inputItems && action.inputItems.length > 0) {
                            for (const input of action.inputItems) {
                                const inputPrice = getMarketPriceWithFallback(input.itemHrid, 0);
                                inputCost += inputPrice * input.count;
                            }
                        }

                        // Apply Artisan Tea reduction (0.9x) to input materials
                        inputCost *= 0.9;

                        // Add upgrade item cost (not affected by Artisan Tea)
                        let upgradeCost = 0;
                        if (action.upgradeItemHrid) {
                            const upgradePrice = getMarketPriceWithFallback(action.upgradeItemHrid, 0);
                            upgradeCost = upgradePrice;
                        }

                        const totalCost = inputCost + upgradeCost;

                        // Divide by output count to get per-item cost
                        const perItemCost = totalCost / (output.count || 1);

                        if (perItemCost > 0) {
                            return perItemCost;
                        }
                    }
                }
            }
        }

        // Try shop cost as final fallback (for shop-only items)
        const shopCost = getShopCoinCost(itemHrid);
        if (shopCost > 0) {
            return shopCost;
        }
    }

    return 0;
}

/**
 * Calculate house score from battle houses
 * @param {Object} profileData - Profile data
 * @returns {Object} {score, breakdown}
 */
function calculateHouseScore(profileData) {
    const characterHouseRooms = profileData.profile?.characterHouseRoomMap || {};

    const { totalCost, breakdown } = calculateBattleHousesCost(characterHouseRooms);

    // Convert to score (cost / 1 million)
    const score = totalCost / 1_000_000;

    // Format breakdown for display. `name`/`value` are what the profile popup
    // draws; `cost` and `level` ride alongside so a panel can order the lines by
    // what they are actually worth rather than by parsing a rounded string back
    // into a number.
    const formattedBreakdown = breakdown.map((house) => ({
        name: `${house.name} ${house.level}`,
        value: (house.cost / 1_000_000).toFixed(1),
        cost: house.cost,
        level: house.level,
    }));

    return { score, breakdown: formattedBreakdown };
}

/**
 * Calculate ability score from equipped abilities
 * @param {Object} profileData - Profile data
 * @returns {Object} {score, breakdown}
 */
function calculateAbilityScore(profileData) {
    // Use equippedAbilities (not characterAbilities) to match MCS behavior
    const equippedAbilities = profileData.profile?.equippedAbilities || [];

    let totalCost = 0;
    const breakdown = [];

    for (const ability of equippedAbilities) {
        if (!ability.abilityHrid || ability.level === 0) continue;

        // A book nobody is selling has no price, and the old calculator called
        // that zero — which put an unpriceable ability at the *bottom* of a
        // score it should not have been contributing to silently at all
        const priced = explainAbilityCost(ability.abilityHrid, ability.level);
        const cost = priced?.total ?? null;
        const unpriced = cost === null;
        if (!unpriced) totalCost += cost;

        // Format ability name for display
        const abilityName = ability.abilityHrid
            .replace('/abilities/', '')
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        breakdown.push({
            name: `${abilityName} ${ability.level}`,
            value: unpriced ? 'no price' : (cost / 1_000_000).toFixed(1),
            cost: unpriced ? 0 : cost,
            unpriced,
            // How many books it would take, which is the part the market cannot
            // answer away — worth carrying even when the price is missing
            books: priced?.books ?? 0,
            // The book that teaches it, which is both what was priced and the
            // only icon an ability has
            hrid: ability.abilityHrid,
            itemHrid: ability.abilityHrid.replace('/abilities/', '/items/'),
            level: ability.level,
        });
    }

    // Convert to score (cost / 1 million)
    const score = totalCost / 1_000_000;

    // By cost rather than by `value`, which is now a string that is sometimes
    // 'no price' — and an unpriced row belongs at the bottom, not at NaN
    breakdown.sort((a, b) => b.cost - a.cost);

    return { score, breakdown };
}

/**
 * Value of the guild shrine levels a character has bought.
 *
 * A shrine level is paid for in guild credits and guild tokens. The credits have
 * a gold value — the cheapest tradeable items that convert into them, the same
 * rate the guild exchange table quotes — so the levels bought so far can be
 * valued the way houses and abilities are. The tokens cannot: nothing converts
 * into them, so they are returned as a count and left out of the score rather
 * than given an invented price.
 *
 * Only scored when the payload carries the levels. A shared profile does not, and
 * reading the current character's shrines while showing somebody else's card
 * would put your guild's investment on their score. `known` says which of those
 * two happened, so a display can leave the line out entirely rather than print a
 * zero that reads as "this player has bought nothing".
 *
 * The split into combat and skilling follows the game's own `isCombat` flag on
 * each buff rather than a list of shrine names: Force sells both a combat buff
 * and a skilling one, and only the flag tells them apart.
 *
 * @param {Object} profileData - Profile data
 * @returns {{known: boolean, score: number, tokens: number, unpricedCredits: number, breakdown: Array<Object>,
 *   combat: {score: number, tokens: number, unpricedCredits: number, breakdown: Array<Object>},
 *   skilling: {score: number, tokens: number, unpricedCredits: number, breakdown: Array<Object>}}}
 */
function calculateGuildShrineScore(profileData) {
    const emptyBucket = () => ({ score: 0, tokens: 0, unpricedCredits: 0, breakdown: [] });
    const unknown = { known: false, ...emptyBucket(), combat: emptyBucket(), skilling: emptyBucket() };

    // Your own profile carries `characterGuildBuffMap` ({ hrid: { level } }); a
    // shared profile now carries `guildBuffLevelMap` ({ hrid: level }) — the game
    // exposes every player's shrine levels on their profile. Either is a real
    // reading; the level is normalised out of both shapes in the loop below.
    const ownMap = profileData?.profile?.characterGuildBuffMap;
    const sharedMap = profileData?.profile?.guildBuffLevelMap;
    const buffMap = ownMap && Object.keys(ownMap).length > 0 ? ownMap : sharedMap;
    const gameData = dataManager.getInitClientData();
    const detailMap = gameData?.guildBuffDetailMap;
    // An empty map is not a reading: shrine levels ride on guild traffic that
    // may never arrive, and `{}` is what a character looks like before it does
    if (!buffMap || Object.keys(buffMap).length === 0 || !detailMap) return unknown;

    // Built once and shared: every level of every shrine prices the same credits
    const goldPerCredit = buildGoldPerCredit('ask');

    let totalCost = 0;
    let totalTokens = 0;
    const breakdown = [];
    const combat = { cost: 0, tokens: 0, unpricedCredits: 0, breakdown: [] };
    const skilling = { cost: 0, tokens: 0, unpricedCredits: 0, breakdown: [] };
    let totalUnpricedCredits = 0;

    for (const [buffHrid, entry] of Object.entries(buffMap)) {
        const level = Math.max(0, Math.floor(Number(typeof entry === 'number' ? entry : entry?.level) || 0));
        const detail = detailMap[buffHrid];
        if (!detail || level <= 0) continue;

        let cost = 0;
        let tokens = 0;
        let unpricedCredits = 0;
        for (let step = 1; step <= level; step++) {
            const levelCost = detail.levelCosts?.[String(step)];
            if (!levelCost) continue;
            tokens += Math.max(0, Math.floor(Number(levelCost.guildTokenCost) || 0));
            // An unpriced credit contributes nothing rather than blocking the
            // whole score: this is a running total of what was invested, and one
            // credit type without a conversion should not blank the other four.
            // It is counted, though — `priceGuildCreditCosts` reports what it
            // could not price precisely so a caller does not present a short
            // total as a complete one, the way the gear and ability scores flag
            // an unpriced piece rather than dropping it.
            const { lines } = priceGuildCreditCosts(levelCost.creditCosts, { goldPerCredit });
            for (const line of lines) {
                if (line.gold === null) unpricedCredits += 1;
                else cost += line.gold || 0;
            }
        }

        totalCost += cost;
        totalTokens += tokens;
        totalUnpricedCredits += unpricedCredits;

        const name = (detail.shrineHrid || buffHrid)
            .split('/')
            .pop()
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        const row = {
            name: `${name} ${level}`,
            value: (cost / 1_000_000).toFixed(1),
            cost,
            hrid: buffHrid,
            level,
            // Kept per shrine as well as in the totals: a shrine whose gold value
            // is small may still be where most of the tokens went
            tokens,
            // How many credit costs on the way to this level nothing could
            // convert into gold. The row's own figure is short by whatever they
            // were worth, so it is a floor rather than a price.
            unpricedCredits,
            partial: unpricedCredits > 0,
        };
        breakdown.push(row);

        const bucket = detail.isCombat ? combat : skilling;
        bucket.cost += cost;
        bucket.tokens += tokens;
        bucket.unpricedCredits += unpricedCredits;
        bucket.breakdown.push(row);
    }

    const byValue = (a, b) => parseFloat(b.value) - parseFloat(a.value);
    breakdown.sort(byValue);
    combat.breakdown.sort(byValue);
    skilling.breakdown.sort(byValue);

    return {
        known: true,
        score: totalCost / 1_000_000,
        tokens: totalTokens,
        unpricedCredits: totalUnpricedCredits,
        breakdown,
        combat: {
            score: combat.cost / 1_000_000,
            tokens: combat.tokens,
            unpricedCredits: combat.unpricedCredits,
            breakdown: combat.breakdown,
        },
        skilling: {
            score: skilling.cost / 1_000_000,
            tokens: skilling.tokens,
            unpricedCredits: skilling.unpricedCredits,
            breakdown: skilling.breakdown,
        },
    };
}

/**
 * Calculate token-based item value for untradeable back slot items
 * @param {string} itemHrid - Item HRID
 * @returns {number} Item value in coins (0 if not a token-based item)
 */
function calculateTokenBasedItemValue(itemHrid) {
    const capeData = CAPE_ITEM_TOKEN_DATA[itemHrid];
    if (!capeData) {
        return 0; // Not a token-based item
    }

    // Find the best value per token from shop items
    let bestValuePerToken = 0;
    for (const shopItem of capeData.tokenShopItems) {
        // Use ask price for shop items (instant buy cost)
        const shopItemPrice = getItemPrice(shopItem.hrid, { mode: 'ask' }) || 0;
        if (shopItemPrice > 0) {
            const valuePerToken = shopItemPrice / shopItem.cost;
            if (valuePerToken > bestValuePerToken) {
                bestValuePerToken = valuePerToken;
            }
        }
    }

    // Calculate total item value: best value per token × token cost
    return bestValuePerToken * capeData.tokenCost;
}

/**
 * Calculate equipment score from equipped items
 * @param {Object} profileData - Profile data
 * @param {string} scoreType - 'combat' or 'skiller'
 * @param {Object} [context] - The pricing context `calculateCombatScore` took before it
 *   suspended: `{useHighEnhancementCost, minLevel, enhancementParams}`. Handed in rather
 *   than read here so both passes of one score price against one character's kit.
 * @returns {Promise<Object>} {score, breakdown, hasEquipmentData}
 */
async function calculateEquipmentScore(profileData, scoreType = 'combat', context = null) {
    const equippedItems = profileData.profile?.wearableItemMap || {};
    const hideEquipment = profileData.profile?.hideWearableItems || false;

    // Check if equipment data is actually available
    // If wearableItemMap is populated, calculate score even if hideEquipment is true
    // (This happens when viewing party members - game sends equipment data despite privacy setting)
    const hasEquipmentData = Object.keys(equippedItems).length > 0;

    // If equipment is hidden AND no data available, return 0
    if (hideEquipment && !hasEquipmentData) {
        return { score: 0, breakdown: [], hasEquipmentData: false, unpricedItems: 0 };
    }

    const gameData = dataManager.getInitClientData();
    if (!gameData) return { score: 0, breakdown: [], hasEquipmentData: false, unpricedItems: 0 };

    const useHighEnhancementCost = context
        ? context.useHighEnhancementCost
        : config.getSetting('networth_highEnhancementUseCost');
    const minLevel = context ? context.minLevel : config.getSetting('networth_highEnhancementMinLevel') || 13;
    const enhancementParams = context ? context.enhancementParams : getEnhancingParams();

    // Phase 1: Collect items and identify which need worker calculations
    const itemsToProcess = [];
    const workerTasks = [];

    for (const [slot, itemData] of Object.entries(equippedItems)) {
        if (!itemData?.itemHrid) continue;

        const itemHrid = itemData.itemHrid;
        const itemDetails = gameData.itemDetailMap[itemHrid];
        if (!itemDetails) continue;

        // Categorize item by skill requirements
        const category = categorizeEquipmentItem(slot, itemDetails.equipmentDetail);

        // Filter by score type
        if (scoreType === 'combat' && !category.combat) continue;
        if (scoreType === 'skiller' && !category.skiller) continue;

        const enhancementLevel = itemData.enhancementLevel || 0;
        const itemLevel = itemDetails.itemLevel || 1;

        itemsToProcess.push({
            itemHrid,
            // Which slot it came out of, carried through so a breakdown can say
            // where on the character the cost sits — two rings priced the same
            // are otherwise two identical lines
            slot,
            enhancementLevel,
            itemDetails,
            itemLevel,
            needsEnhancementCalc: false,
            subLevelTasks: [],
        });

        // Check if this item needs enhancement calculation via worker
        const tokenValue = calculateTokenBasedItemValue(itemHrid);
        if (tokenValue === 0) {
            // Not a token item, might need enhancement calculation
            if (enhancementLevel >= 1 && useHighEnhancementCost && enhancementLevel >= minLevel) {
                // High enhancement mode - calculate cost for all sub-levels (needed for mirror optimization)
                const subLevelTasks = [];
                for (let subLevel = 1; subLevel <= enhancementLevel; subLevel++) {
                    const strategies = [0];
                    for (let pf = 2; pf <= subLevel; pf++) strategies.push(pf);
                    const levelStartIndex = workerTasks.length;
                    for (const protectFrom of strategies) {
                        workerTasks.push({
                            enhancingLevel: enhancementParams.enhancingLevel,
                            toolBonus: enhancementParams.toolBonus || 0,
                            speedBonus: enhancementParams.speedBonus || 0,
                            itemLevel,
                            targetLevel: subLevel,
                            protectFrom,
                            blessedTea: enhancementParams.teas.blessed,
                            guzzlingBonus: enhancementParams.guzzlingBonus,
                            // The live double-jump chance from item data; omitting it made the
                            // worker fall back to the stock 1% while every main-thread sweep
                            // (tooltip, savings card) runs on the real figure
                            blessedTeaBonus: enhancementParams.blessedTeaBonus,
                        });
                    }
                    subLevelTasks.push({ workerStartIndex: levelStartIndex, strategies });
                }
                itemsToProcess[itemsToProcess.length - 1].needsEnhancementCalc = true;
                itemsToProcess[itemsToProcess.length - 1].subLevelTasks = subLevelTasks;
            } else if (enhancementLevel > 1) {
                // Check market price first
                const marketPrice = getMarketPriceWithFallback(itemHrid, enhancementLevel);
                if (!marketPrice || marketPrice === 0) {
                    // No market data - calculate cost for all sub-levels (needed for mirror optimization)
                    const subLevelTasks = [];
                    for (let subLevel = 1; subLevel <= enhancementLevel; subLevel++) {
                        const strategies = [0];
                        for (let pf = 2; pf <= subLevel; pf++) strategies.push(pf);
                        const levelStartIndex = workerTasks.length;
                        for (const protectFrom of strategies) {
                            workerTasks.push({
                                enhancingLevel: enhancementParams.enhancingLevel,
                                toolBonus: enhancementParams.toolBonus || 0,
                                speedBonus: enhancementParams.speedBonus || 0,
                                itemLevel,
                                targetLevel: subLevel,
                                protectFrom,
                                blessedTea: enhancementParams.teas.blessed,
                                guzzlingBonus: enhancementParams.guzzlingBonus,
                                // Same live double-jump chance as the main-thread sweeps
                                blessedTeaBonus: enhancementParams.blessedTeaBonus,
                            });
                        }
                        subLevelTasks.push({ workerStartIndex: levelStartIndex, strategies });
                    }
                    itemsToProcess[itemsToProcess.length - 1].needsEnhancementCalc = true;
                    itemsToProcess[itemsToProcess.length - 1].subLevelTasks = subLevelTasks;
                }
            }
        }
    }

    // Phase 2: Execute all worker tasks in parallel
    let workerResults = [];
    if (workerTasks.length > 0) {
        try {
            workerResults = await calculateEnhancementBatch(workerTasks);
        } catch (error) {
            console.warn('[ScoreCalculator] Enhancement batch worker failed, using fallback pricing:', error);
        }
    }

    // Phase 3: Calculate costs using worker results
    let totalValue = 0;
    let unpricedItems = 0;
    const breakdown = [];

    for (const item of itemsToProcess) {
        let itemCost = 0;

        // Check token value first
        const tokenValue = calculateTokenBasedItemValue(item.itemHrid);
        if (tokenValue > 0) {
            itemCost = tokenValue;
        } else if (item.needsEnhancementCalc && item.subLevelTasks.length > 0) {
            // Build targetCosts[0..N], matching tooltip's calculateEnhancementPath
            const targetCosts = [getRealisticBaseItemPrice(item.itemHrid)]; // level 0 = base item
            for (let subLevel = 1; subLevel <= item.enhancementLevel; subLevel++) {
                const { workerStartIndex, strategies } = item.subLevelTasks[subLevel - 1];
                let minCost = null;
                for (let s = 0; s < strategies.length; s++) {
                    const wr = workerResults[workerStartIndex + s];
                    if (!wr || !wr.attempts) continue;
                    const cost = calculateEnhancementCostFromWorkerResult(item.itemHrid, strategies[s], wr);
                    if (minCost === null || cost < minCost) minCost = cost;
                }
                targetCosts.push(minCost ?? getRealisticBaseItemPrice(item.itemHrid));
            }
            // Apply Philosopher's Mirror optimization — literally the tooltip's pass now, not a
            // copy of it that had drifted into starting at level 3 and skipping the +2 mirror
            applyMirrorOptimization(targetCosts, getRealisticBaseItemPrice('/items/philosophers_mirror'));
            itemCost = targetCosts[item.enhancementLevel];
        } else {
            // Use market price (already checked or not needed)
            const marketPrice = getMarketPriceWithFallback(item.itemHrid, item.enhancementLevel);
            if (marketPrice > 0) {
                itemCost = marketPrice;
            } else if (item.enhancementLevel > 1) {
                // Fallback to base price
                itemCost = getMarketPriceWithFallback(item.itemHrid, 0);
            } else {
                // Enhancement level 0 or 1
                itemCost = getMarketPriceWithFallback(item.itemHrid, 0);
            }
        }

        // Nothing priced it: no ask, no craftable recipe, no shop line, no token
        // table. The score still moves by nothing — there is no figure to add —
        // but the row must not vanish. An equipped piece silently dropped from
        // the breakdown reads as a character wearing one item fewer, and a total
        // built over it reads as complete when it is short by whatever that
        // piece is worth. The same refusal the ability score already makes.
        const unpriced = !(itemCost > 0);
        if (unpriced) unpricedItems += 1;
        else totalValue += itemCost;

        // Format item name for display
        const itemName = item.itemDetails.name || item.itemHrid.replace('/items/', '');
        const displayName = item.enhancementLevel > 0 ? `${itemName} +${item.enhancementLevel}` : itemName;

        // A priced item worth under 0.05M rounds to "0.0" and is left out: the
        // breakdown is denominated in millions and a column of zeroes says
        // nothing. An *unpriced* one is kept, because "no price" is the claim.
        const formattedValue = unpriced ? 'no price' : (itemCost / 1_000_000).toFixed(1);
        if (unpriced || formattedValue !== '0.0') {
            breakdown.push({
                name: displayName,
                value: formattedValue,
                cost: unpriced ? 0 : itemCost,
                unpriced,
                itemHrid: item.itemHrid,
                slot: item.slot,
                enhancementLevel: item.enhancementLevel,
            });
        }
    }

    // Convert to score (value / 1 million)
    const score = totalValue / 1_000_000;

    // By cost rather than by `value`, which is now a string that is sometimes
    // 'no price' — the same reason the ability breakdown sorts this way, and an
    // unpriced row belongs at the bottom rather than at NaN
    breakdown.sort((a, b) => b.cost - a.cost);

    return { score, breakdown, hasEquipmentData, unpricedItems };
}

/**
 * Calculate total enhancement cost from worker result
 * Matches tooltip-enhancement.js calculateTotalCost() exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} protectFrom - Protection threshold used in this calculation
 * @param {Object} workerResult - Worker calculation result
 * @returns {number} Total cost (base item + materials + protection)
 */
function calculateEnhancementCostFromWorkerResult(itemHrid, protectFrom, workerResult) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return 0;

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails || !itemDetails.enhancementCosts) return 0;

    // Base item cost — matches tooltip's getRealisticBaseItemPrice (with inflation guard)
    const baseItemCost = getRealisticBaseItemPrice(itemHrid);

    // Material cost per attempt — matches tooltip's calculateTotalCost material loop exactly
    let perActionCost = 0;
    for (const material of itemDetails.enhancementCosts) {
        if (!material || !material.itemHrid) continue;

        let price;
        if (material.itemHrid.startsWith('/items/trainee_')) {
            price = TRAINEE_SHOP_PRICE; // untradeable trainee charms: shop-fixed
        } else if (material.itemHrid === '/items/coin') {
            price = 1; // coins at face value
        } else {
            // A missing side of the book arrives as `null`, never as a negative:
            // `getItemPrices` reconciles both sides and returns null only when
            // neither exists. The old `< 0` normalisation therefore never fired,
            // so an ask-less book left `price` at null and `null * count` costed
            // the material at nothing — a +14 piece whose charm has bids but no
            // sellers scored as if that charm were free.
            const marketPrice = getItemPrices(material.itemHrid, 0);
            const sideOf = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
            const ask = sideOf(marketPrice?.ask);
            const bid = sideOf(marketPrice?.bid);
            // Ask first — this is what replacing the material costs — and the
            // other side rather than nothing when the book is one-sided
            price = ask ?? bid ?? gameData.itemDetailMap[material.itemHrid]?.sellPrice ?? 0;
        }
        perActionCost += price * (material.count || 1);
    }

    // Total material cost = per-action cost × total expected attempts
    const materialCost = perActionCost * workerResult.attempts;

    // Protection cost using actual cheapest protection price
    let protectionCost = 0;
    if (protectFrom > 0 && workerResult.protectionCount > 0) {
        const protectionInfo = getCheapestProtectionPrice(itemHrid);
        if (protectionInfo.price > 0) {
            protectionCost = protectionInfo.price * workerResult.protectionCount;
        }
    }

    return baseItemCost + materialCost + protectionCost;
}
