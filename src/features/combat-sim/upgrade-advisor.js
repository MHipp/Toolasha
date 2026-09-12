/**
 * Upgrade Advisor for Combat Sim
 *
 * Generates equipment upgrade candidates, calculates their costs,
 * and runs simulations to rank them by "Gold per 0.01% improvement".
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import {
    buildGameDataPayload,
    calculateSimRevenue,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
    applyGuildBuffLevel,
} from './combat-sim-adapter.js';
import { runSimulation, runLabyrinthSimulation, getMaxWorkers } from './combat-sim-runner.js';
import { buildBuffDrinkPools, estimateFoodSimCount, runFoodOptimization } from './food-optimizer.js';
import { generateLabArmorCandidates, labelItemWithLevel } from './lab-armor-candidates.js';
import { buildGuidePlan } from './build-guide.js';
import { bestGearForSkill } from './skilling-gear-candidates.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import bundledLabyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import { labyrinthClearRate } from '../../utils/bundle-bridge.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';
import { testerShopEnabled, testerGearPrice } from '../../utils/tester-shop.js';
import { getItemPrices } from '../../utils/market-data.js';
import { enhancementParamsFor, describeEnhancementSource } from '../enhancement/enhancement-params-source.js';
// The one enhancement cost model: the shared protect-from sweep and the shared
// pricing rules. This module used to carry an inline copy of both.
import { cheapestProtectPlan } from '../../utils/enhancement-protect-sweep.js';
import { getCheapestProtectionPrice, perAttemptMaterialCost } from '../../utils/enhancement-pricing.js';
import { explainAbilityLevelUpCost } from '../../utils/ability-cost-calculator.js';
import { buildOverridesForSkill } from './skilling-sim-helpers.js';
import { priceGuildCreditCosts } from '../../utils/guild-credit-pricing.js';
import { describeGuildTokenGold, explainGuildTokenValue } from '../guild/guild-token-value.js';
import { COMBAT_SCROLL_LABELS, COMBAT_SCROLL_BUFF_TYPES } from '../../utils/combat-scroll-buffs.js';
import { findMaxLabyrinthLevel, defaultThreshold } from './labyrinth-level-finder.js';
import { measureRoomLevelGains, ROOM_LEVEL_SHORTLIST_SIZE } from './labyrinth-upgrade-levels.js';

/** Enhancement breakpoints by slot type */
const BREAKPOINTS_DEFAULT = [7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_JEWELRY = [5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_BACK = [3, 5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_REFINED = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const JEWELRY_SLOTS = new Set(['/equipment_types/earrings', '/equipment_types/ring', '/equipment_types/neck']);

/** Philosopher's accessories are always offered from this enhancement level */
const PHILO_START_LEVEL = 5;
const PHILO_HRID_PREFIX = '/items/philosophers_';

const CHARM_SLOT = '/equipment_types/charm';
const TRINKET_SLOT = '/equipment_types/trinket';
const MAIN_HAND_SLOT = '/equipment_types/main_hand';
const OFF_HAND_SLOT = '/equipment_types/off_hand';
const TWO_HAND_SLOT = '/equipment_types/two_hand';

/** Highest level a house room can reach */
export const MAX_HOUSE_LEVEL = 8;

/**
 * Highest level any guild shrine buff reaches, for the input that asks for one.
 *
 * The real ceiling is per buff and comes from the game's own cost table —
 * `guildBuffMaxLevel` reads it, and the generator clamps every target down to
 * it. This is only what a number box should refuse to go above, so it is the
 * highest of them rather than any one buff's.
 */
export const MAX_GUILD_SHRINE_LEVEL = 20;

/**
 * Seed for one analysis run, or null to leave every sim on independent randomness.
 * Sharing a seed across the baseline and all candidates cancels the shared random
 * draws out of each delta; the setting exists because it also freezes the luck of
 * one particular sample into the absolute numbers.
 * @returns {number|null} Analysis seed
 */
function analysisSeed() {
    return config.getSettingValue('combatSim_sharedSeed', true) ? randomSeed() : null;
}

/** Combat skills evaluated by the Combat Levels advisor mode */
const COMBAT_LEVEL_SKILLS = [
    { key: 'staminaLevel', label: 'Stamina' },
    { key: 'intelligenceLevel', label: 'Intelligence' },
    { key: 'attackLevel', label: 'Attack' },
    { key: 'meleeLevel', label: 'Melee' },
    { key: 'defenseLevel', label: 'Defense' },
    { key: 'rangedLevel', label: 'Ranged' },
    { key: 'magicLevel', label: 'Magic' },
];

/**
 * Find the charm to wear while leveling a given combat skill: the equivalent
 * of the player's current charm attuned to that skill (matched by name tier,
 * e.g. "Expert Melee Charm" → "Expert Defense Charm"), or the highest-tier
 * charm for the skill when tiers can't be matched. Keeps the current charm's
 * enhancement level. Null when no charm for the skill exists.
 * @param {Object|null} currentCharm - Equipped charm ({hrid, enhancementLevel}) or null
 * @param {string} skillKey - DTO level key, e.g. "defenseLevel"
 * @param {Object} gameData - Game data
 * @param {string} [charmTier='auto'] - 'auto' (match the equipped charm's tier),
 *   'none' (no charm), or an explicit tier name prefix (e.g. 'Expert')
 * @param {number|null} [charmEnhancement=null] - Enhancement level to sim the charm at;
 *   null keeps the equipped charm's level (0 when nothing is equipped)
 * @returns {Object|null} Charm equipment entry or null
 */
export function findMatchingCharmForSkill(
    currentCharm,
    skillKey,
    gameData,
    charmTier = 'auto',
    charmEnhancement = null
) {
    if (charmTier === 'none') return null;

    const skillName = skillKey.replace('Level', '');
    const targetFocus = `/skills/${skillName}`;
    const enhancementLevel =
        Number.isFinite(charmEnhancement) && charmEnhancement >= 0
            ? Math.min(20, Math.floor(charmEnhancement))
            : currentCharm?.enhancementLevel || 0;

    const currentDetail = currentCharm ? gameData.itemDetailMap[currentCharm.hrid] : null;
    // Explicit tier selection overrides matching from the equipped charm
    const tierPrefix = charmTier && charmTier !== 'auto' ? charmTier : currentDetail?.name?.split(' ')[0] || null;

    if (charmTier === 'auto' && currentDetail?.equipmentDetail?.combatStats?.focusTraining === targetFocus) {
        return { ...currentCharm, enhancementLevel };
    }

    let fallback = null;
    for (const [hrid, detail] of Object.entries(gameData.itemDetailMap)) {
        if (detail?.equipmentDetail?.type !== CHARM_SLOT) continue;
        if (detail.equipmentDetail.combatStats?.focusTraining !== targetFocus) continue;
        if (tierPrefix && detail.name?.startsWith(`${tierPrefix} `)) {
            return { hrid, enhancementLevel };
        }
        if (!fallback || (detail.itemLevel || 0) > (gameData.itemDetailMap[fallback.hrid]?.itemLevel || 0)) {
            fallback = { hrid, enhancementLevel };
        }
    }
    return fallback;
}

/**
 * The skill the player's weapon trains on its own: `primaryTraining` on the
 * weapon's combat stats, which the game credits 30% of all combat XP to no
 * matter what charm is worn (the other 70% goes to the charm's focus skill).
 * A bulwark names defense, a spear attack, other melee weapons melee, a bow
 * ranged, a staff magic; unarmed is melee.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {string} Skill name, e.g. 'melee'
 */
export function getPrimaryTrainingSkill(playerDTO, gameData) {
    const weapon =
        playerDTO.equipment?.['/equipment_types/main_hand'] || playerDTO.equipment?.['/equipment_types/two_hand'];
    const stats = weapon ? gameData.itemDetailMap[weapon.hrid]?.equipmentDetail?.combatStats : null;
    const primary = stats?.primaryTraining?.split('/').pop();
    return primary || 'melee';
}

/**
 * Main skills trained by the player's weapon — just its primary training
 * skill, kept as a list for callers that iterate. With a focus charm on, the
 * weapon's 30% is the only XP that lands anywhere but the charm's skill, so
 * the style's wider XP map (attack *and* melee for a spear) is not what a
 * charm-wearing grinder actually trains.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {Array<string>} Skill names, e.g. ['attack']
 */
export function getMainTrainingSkills(playerDTO, gameData) {
    return [getPrimaryTrainingSkill(playerDTO, gameData)];
}

/**
 * Combat skill keys irrelevant to the player's weapon style, excluded from
 * Combat Levels candidates: melee weapons don't sim Ranged/Magic, ranged
 * weapons don't sim Melee/Magic, magic weapons don't sim Melee/Ranged.
 * Attack is never excluded — it trains under every style (directly with a
 * spear, via the XP split otherwise). Unarmed counts as melee (the engine
 * sims it as smash); a weapon whose style can't be determined excludes
 * nothing.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {Set<string>} Excluded DTO level keys, e.g. {'rangedLevel', 'magicLevel'}
 */
export function getStyleExcludedSkills(playerDTO, gameData) {
    const weapon =
        playerDTO.equipment?.['/equipment_types/main_hand'] || playerDTO.equipment?.['/equipment_types/two_hand'];
    const stats = weapon ? gameData.itemDetailMap[weapon.hrid]?.equipmentDetail?.combatStats : null;
    const style = weapon ? getItemDamageStyle(stats) : 'smash';
    if (style === 'ranged') return new Set(['meleeLevel', 'magicLevel']);
    if (style === 'magic') return new Set(['meleeLevel', 'rangedLevel']);
    if (style === 'unknown') return new Set();
    return new Set(['rangedLevel', 'magicLevel']);
}

/**
 * Get the next ability level target (next multiple of 10) above the current level.
 * Used as fallback when no explicit target level is provided.
 * @param {number} currentLevel - Current ability level
 * @returns {number|null} Next target level, or null if at max (200)
 */
function getNextAbilityBreakpoint(currentLevel) {
    const next = Math.ceil((currentLevel + 1) / 10) * 10;
    return next <= 200 ? next : null;
}

/**
 * Get the next enhancement breakpoint above the current level.
 * Uses slot-specific breakpoints: jewelry gets +5, back gets +3/+5,
 * refined items start at +10 minimum — except capes (back slot), the one
 * item type reasonably refined below +10, which keep the back breakpoints.
 * @param {number} currentLevel - Current enhancement level
 * @param {string} slot - Equipment slot HRID
 * @param {string} itemHrid - Item HRID (used to detect refined items)
 * @returns {number|null} Next breakpoint level, or null if already at max
 */
function getNextBreakpoint(currentLevel, slot, itemHrid) {
    let breakpoints;
    if (slot === '/equipment_types/back') {
        breakpoints = BREAKPOINTS_BACK;
    } else if (itemHrid.includes('_refined')) {
        breakpoints = BREAKPOINTS_REFINED;
    } else if (JEWELRY_SLOTS.has(slot)) {
        breakpoints = BREAKPOINTS_JEWELRY;
    } else {
        breakpoints = BREAKPOINTS_DEFAULT;
    }

    for (const bp of breakpoints) {
        if (bp > currentLevel) return bp;
    }
    return null;
}

/**
 * Find the Philosopher's accessory for a jewelry slot.
 * @param {string} slot - Equipment type hrid
 * @param {Object} gameData
 * @returns {{hrid: string, name: string}|null}
 */
function findPhiloAccessory(slot, gameData) {
    for (const [hrid, detail] of Object.entries(gameData.itemDetailMap || {})) {
        if (!hrid.startsWith(PHILO_HRID_PREFIX)) continue;
        if (detail?.equipmentDetail?.type !== slot) continue;
        return { hrid, name: detail.name || hrid.split('/').pop() };
    }
    return null;
}

/**
 * Offer Philosopher's accessories at +5 for every jewelry slot, regardless of
 * how enhanced the current accessory is. The normal tier/enhancement paths only
 * propose swaps at the current enhancement level, which hides the cheap +5
 * entry point behind, say, a +12 rebuy for someone wearing +12 jewelry.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @param {Array} candidates - Candidate list (mutated)
 */
function addPhiloAccessoryCandidates(playerDTO, gameData, candidates) {
    for (const slot of JEWELRY_SLOTS) {
        const equip = playerDTO.equipment?.[slot];
        // Empty slots aren't supported by candidate application (it matches on
        // the current item's hrid), so only suggest swaps for worn accessories
        if (!equip?.hrid) continue;

        const philo = findPhiloAccessory(slot, gameData);
        if (!philo || philo.hrid === equip.hrid) continue;

        const currentLevel = equip.enhancementLevel || 0;
        const alreadyQueued = candidates.some(
            (c) => c.slot === slot && c.upgradeHrid === philo.hrid && c.upgradeLevel === PHILO_START_LEVEL
        );
        if (alreadyQueued) continue;

        // Drop any same-slot swap to this philo item at a higher level: the
        // tier path proposes it at the worn enhancement level (a +12 rebuy for
        // +12 jewelry), which is the expensive version of this same upgrade
        for (let i = candidates.length - 1; i >= 0; i--) {
            const c = candidates[i];
            if (c.slot === slot && c.upgradeHrid === philo.hrid && c.upgradeLevel > PHILO_START_LEVEL) {
                candidates.splice(i, 1);
            }
        }

        const currentName = gameData.itemDetailMap[equip.hrid]?.name || equip.hrid.split('/').pop();
        candidates.push({
            slot,
            currentHrid: equip.hrid,
            currentLevel,
            upgradeHrid: philo.hrid,
            upgradeLevel: PHILO_START_LEVEL,
            description: `${currentName} +${currentLevel} → ${philo.name} +${PHILO_START_LEVEL}`,
            type: 'tier',
        });
    }
}

/**
 * Get the player's primary combat style from their weapon.
 *
 * Both weapon slots, because a two-handed weapon leaves `main_hand` empty — and
 * reading only the main hand made every bow, staff, bulwark and trident come
 * back 'unknown', which `isAbilityCompatible` reads as "offer universal
 * abilities only". Two-handed builds were silently getting no elemental or
 * ranged swap candidates at all.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {string} e.g., 'slash', 'stab', 'smash', 'ranged', 'magic'
 */
function getPlayerCombatStyle(playerDTO, gameData) {
    const weapon = playerDTO.equipment?.[MAIN_HAND_SLOT] || playerDTO.equipment?.[TWO_HAND_SLOT];
    if (!weapon) return 'unknown';
    const weaponDetails = gameData.itemDetailMap[weapon.hrid];
    const stats = weaponDetails?.equipmentDetail?.combatStats;
    if (!stats) return 'unknown';

    if (stats.rangedDamage > 0) return 'ranged';
    if (stats.magicDamage > 0) return 'magic';
    if (stats.stabDamage > 0) return 'stab';
    if (stats.slashDamage > 0) return 'slash';
    if (stats.smashDamage > 0) return 'smash';
    return 'unknown';
}

/**
 * Get the combat style of an ability from its effects.
 * Uses combatStyleHrid for damage abilities, buff typeHrid/skill multipliers for buffs.
 * @param {Object} abilityDetail - From abilityDetailMap
 * @returns {string} 'stab', 'slash', 'smash', 'ranged', 'magic', 'melee', 'physical', or 'universal'
 */
function getAbilityCombatStyle(abilityDetail) {
    // Check for direct combat style on damage/heal effects
    for (const effect of abilityDetail.abilityEffects || []) {
        if (effect.combatStyleHrid) {
            return effect.combatStyleHrid.split('/').pop();
        }
    }

    // For buff abilities, analyze buff types and skill multipliers
    const buffTypes = new Set();
    const skillMultipliers = new Set();

    for (const effect of abilityDetail.abilityEffects || []) {
        if (effect.effectType?.includes('heal')) return 'universal';
        if (!effect.buffs) continue;
        for (const buff of effect.buffs) {
            if (buff.typeHrid) buffTypes.add(buff.typeHrid);
            if (buff.multiplierForSkillHrid) skillMultipliers.add(buff.multiplierForSkillHrid);
        }
    }

    // Skill multiplier is the strongest signal
    if (skillMultipliers.has('/skills/magic')) return 'magic';
    if (skillMultipliers.has('/skills/melee')) return 'melee';
    if (skillMultipliers.has('/skills/ranged')) return 'ranged';

    // Buff type analysis
    const hasElementalAmp =
        buffTypes.has('/buff_types/water_amplify') ||
        buffTypes.has('/buff_types/nature_amplify') ||
        buffTypes.has('/buff_types/fire_amplify');
    if (hasElementalAmp) return 'magic';

    const hasPhysicalAmp = buffTypes.has('/buff_types/physical_amplify');
    if (hasPhysicalAmp) return 'physical';

    // Attack speed without cast speed = physical only
    const hasAttackSpeed = buffTypes.has('/buff_types/attack_speed');
    const hasCastSpeed = buffTypes.has('/buff_types/cast_speed');
    if (hasAttackSpeed && !hasCastSpeed) return 'physical';

    // Universal buffs: attack_speed+cast_speed, damage, accuracy, evasion, armor, thorns, etc.
    return 'universal';
}

/**
 * Check if an ability is compatible with a player's weapon style.
 * @param {string} abilityStyle - From getAbilityCombatStyle()
 * @param {string} weaponStyle - From getPlayerCombatStyle()
 * @returns {boolean}
 */
function isAbilityCompatible(abilityStyle, weaponStyle) {
    // Universal abilities work for everyone
    if (abilityStyle === 'universal') return true;

    // Magic abilities only for magic weapons
    if (abilityStyle === 'magic') return weaponStyle === 'magic';

    // Ranged abilities only for ranged weapons
    if (abilityStyle === 'ranged') return weaponStyle === 'ranged';

    // Physical (non-elemental amplify) works for all melee and ranged
    const meleeStyles = ['stab', 'slash', 'smash'];
    if (abilityStyle === 'physical') {
        return meleeStyles.includes(weaponStyle) || weaponStyle === 'ranged';
    }

    // Melee-specific (e.g., fierce aura with /skills/melee multiplier)
    if (abilityStyle === 'melee') return meleeStyles.includes(weaponStyle);

    // Specific melee sub-styles (stab/slash/smash abilities) work with any melee weapon
    if (meleeStyles.includes(abilityStyle)) return meleeStyles.includes(weaponStyle);

    return abilityStyle === weaponStyle;
}

/**
 * Calculate the gold cost of enhancing an item from startLevel to targetLevel.
 * Uses incremental cost approach: cost(0→target) - cost(0→start), matching
 * the tooltip's enhancement path calculation exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {number} Expected gold cost
 */
/**
 * Whose bench an enhancement sweep is quoting.
 *
 * This used to ask whether the slot was `/equipment_types/back`, on the premise
 * (verbatim, from 12b978be) that "back items are non-tradeable". The premise is
 * the right one — nobody can sell you a finished piece you have to make
 * yourself, so your own bench is the only honest one — but the slot is a poor
 * proxy for it: a chance cape is back-slot and perfectly tradable, and was
 * being costed at the character's bench while the tooltip beside it costed the
 * same cape at whatever the simulator was set to. The rule now asks the item.
 *
 * Named rather than inlined because the answer has to be reportable: a figure
 * costed at a professional's bench and one costed at yours land in the same
 * column, and {@link explainUpgradeCost} carries which it was so the row can
 * say so in the same words the enhancement tooltip's chip uses.
 *
 * @param {string} [itemHrid] - Item being enhanced
 * @returns {Object} Enhancement parameters, tagged with `paramsSource`
 */
export function enhancementSweepParams(itemHrid) {
    return enhancementParamsFor('advisor', itemHrid);
}

function calculateEnhancementCost(itemHrid, startLevel, targetLevel, gameData) {
    // Genuine no-op: nothing to enhance
    if (targetLevel <= startLevel) {
        return 0;
    }

    // On the test server with the Tester shop priced in, nobody rolls the
    // dice: the finished level is a shop copy mirrored up, guaranteed
    if (testerShopEnabled()) {
        const tester = testerGearPrice(itemHrid, targetLevel, { itemDetailMap: gameData?.itemDetailMap });
        if (tester) return tester.price;
    }

    const itemDetails = gameData.itemDetailMap[itemHrid];
    // No enhancement recipe: cost is unknown, not free. Reporting 0 here would
    // rank the upgrade as the best value in the list (gold-per-improvement 0).
    if (!itemDetails?.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    const enhancingParams = enhancementSweepParams(itemHrid);

    // The shared rule: a one-sided book cross-fills, then production cost, then
    // the vendor price, and trainee charms take the one shop-price constant.
    // This used to be an inline transcription here, complete with its own 250000.
    const materials = perAttemptMaterialCost(itemDetails);

    // Get cheapest protection price. Null when nothing that could protect this
    // item has a price — which makes every protecting strategy unpriceable, not
    // free. Quoting protection at zero made the most-protected path the cheapest
    // by construction and put it top of the rankings.
    const { price: protPrice, itemHrid: protHrid } = getCheapestProtectionPrice(itemHrid);

    try {
        // From the level the piece is actually at, not the difference between
        // two runs from +0. The old form — fullCost[target] − fullCost[start] —
        // gives the same number almost everywhere, because an item cannot skip
        // a level and so every path to +7 passes through +4 (see
        // enhancement-cost-parity.test.js). It parts company under Blessed Tea,
        // whose double jump can vault the start level, and there it undercounts
        // the real run. Solving from the start is right in both cases.
        const plan = cheapestProtectPlan({
            chain: {
                // Every input comes from whichever bench `enhancementSweepParams`
                // resolved — the observatory level and the blessed tea's real double-jump
                // chance included, so the quote is one run and not a mix of two
                enhancingLevel: enhancingParams.enhancingLevel,
                toolBonus: enhancingParams.toolBonus,
                speedBonus: enhancingParams.speedBonus || 0,
                itemLevel: itemDetails.itemLevel || 1,
                blessedTea: enhancingParams.teas?.blessed || false,
                guzzlingBonus: enhancingParams.guzzlingBonus || 1.0,
                blessedTeaBonus: enhancingParams.blessedTeaBonus,
            },
            targetLevel,
            startLevel,
            materialCostPerAttempt: materials.cost,
            protectionOptions: protPrice > 0 ? [{ itemHrid: protHrid, price: protPrice }] : [],
            hasMissingPrices: materials.hasMissingPrices,
        });

        // Nothing about the run could be priced — unknown, not free
        return plan ? Math.max(0, Math.round(plan.cost)) : null;
    } catch {
        return null;
    }
}

/**
 * Classify an item's combat role based on its primary offensive/defensive stats.
 * Items with the same role are valid tier comparison targets.
 * @param {Object} combatStats - equipmentDetail.combatStats
 * @returns {string} Role identifier
 */
function getItemRole(combatStats) {
    if (!combatStats) return 'unknown';

    // Check for elemental amplify — sub-classifies magic gear by element
    const fireAmp = combatStats.fireAmplify || 0;
    const natureAmp = combatStats.natureAmplify || 0;
    const waterAmp = combatStats.waterAmplify || 0;

    if (fireAmp > 0 || natureAmp > 0 || waterAmp > 0) {
        if (fireAmp >= natureAmp && fireAmp >= waterAmp) return 'magic_fire';
        if (natureAmp >= fireAmp && natureAmp >= waterAmp) return 'magic_nature';
        return 'magic_water';
    }

    // Check for primary offensive stats (exclude defensiveDamage — it's a tank stat)
    const stab = combatStats.stabDamage || 0;
    const slash = combatStats.slashDamage || 0;
    const smash = combatStats.smashDamage || 0;
    const ranged = combatStats.rangedDamage || 0;
    const magic = combatStats.magicDamage || 0;
    const melee = stab + slash + smash;

    // An all-style piece (every damage stat positive — the Philosopher's
    // Necklace) belongs to no single role; classifying it by the tie-winner
    // barred it from replacing styleless jewelry. See getItemDamageStyle.
    if (stab > 0 && slash > 0 && smash > 0 && ranged > 0 && magic > 0) return 'unknown';

    // If item has offensive damage stats, classify by highest.
    // Melee is subdivided by damage style so stab/slash/smash weapons form separate tier groups —
    // one combined 'melee' group let sortIndex ordering offer a spear user a slash sword as the
    // "next tier".
    if (melee > 0 || ranged > 0 || magic > 0) {
        if (ranged >= melee && ranged >= magic) return 'ranged';
        if (magic >= melee && magic >= ranged) return 'magic';
        if (stab >= slash && stab >= smash) return 'melee_stab';
        if (slash >= stab && slash >= smash) return 'melee_slash';
        return 'melee_smash';
    }

    // Items with only defensiveDamage and no offensive damage are tanks
    if (combatStats.defensiveDamage > 0) return 'defensive';

    // Check accuracy as secondary signal
    const stabAcc = combatStats.stabAccuracy || 0;
    const slashAcc = combatStats.slashAccuracy || 0;
    const smashAcc = combatStats.smashAccuracy || 0;
    const meleeAcc = stabAcc + slashAcc + smashAcc;
    const rangedAcc = combatStats.rangedAccuracy || 0;
    const magicAcc = combatStats.magicAccuracy || 0;

    if (meleeAcc > 0 || rangedAcc > 0 || magicAcc > 0) {
        if (rangedAcc >= meleeAcc && rangedAcc >= magicAcc) return 'ranged';
        if (magicAcc >= meleeAcc && magicAcc >= rangedAcc) return 'magic';
        if (stabAcc >= slashAcc && stabAcc >= smashAcc) return 'melee_stab';
        if (slashAcc >= stabAcc && slashAcc >= smashAcc) return 'melee_slash';
        return 'melee_smash';
    }

    // Defensive/utility gear — armor, evasion, HP
    return 'defensive';
}

/**
 * Get equipment tier progression for a given slot, grouped by role.
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {Object} Map of "slot|role" → sorted item entries (weakest to strongest)
 */
export function getEquipmentTierProgression(gameData) {
    const progression = {};

    for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
        if (!item.equipmentDetail?.type) continue;
        if (!item.equipmentDetail.combatStats) continue;
        if (!hasCombatStats(item)) continue;

        const slot = item.equipmentDetail.type;
        const role = getItemRole(item.equipmentDetail.combatStats);
        const key = `${slot}|${role}`;
        if (!progression[key]) {
            progression[key] = [];
        }

        progression[key].push({
            hrid: itemHrid,
            itemLevel: item.itemLevel || 0,
            sortIndex: item.sortIndex ?? 9999,
            name: item.name,
        });
    }

    // Sort each group by itemLevel (primary), then refined after non-refined, then sortIndex
    for (const key of Object.keys(progression)) {
        progression[key].sort((a, b) => {
            if (a.itemLevel !== b.itemLevel) return a.itemLevel - b.itemLevel;
            const aRefined = a.hrid.endsWith('_refined') ? 1 : 0;
            const bRefined = b.hrid.endsWith('_refined') ? 1 : 0;
            if (aRefined !== bRefined) return aRefined - bRefined;
            return a.sortIndex - b.sortIndex;
        });
    }

    return progression;
}

/** Combat-relevant stats that affect simulation outcomes */
const COMBAT_STATS = new Set([
    'stabAccuracy',
    'slashAccuracy',
    'smashAccuracy',
    'rangedAccuracy',
    'magicAccuracy',
    'stabDamage',
    'slashDamage',
    'smashDamage',
    'rangedDamage',
    'magicDamage',
    'defensiveDamage',
    'taskDamage',
    'physicalAmplify',
    'waterAmplify',
    'natureAmplify',
    'fireAmplify',
    'healingAmplify',
    'stabEvasion',
    'slashEvasion',
    'smashEvasion',
    'rangedEvasion',
    'magicEvasion',
    'armor',
    'waterResistance',
    'natureResistance',
    'fireResistance',
    'maxHitpoints',
    'maxManapoints',
    'lifeSteal',
    'hpRegenPer10',
    'mpRegenPer10',
    'physicalThorns',
    'elementalThorns',
    'criticalRate',
    'criticalDamage',
    'armorPenetration',
    'waterPenetration',
    'naturePenetration',
    'firePenetration',
    'abilityHaste',
    'tenacity',
    'manaLeech',
    'castSpeed',
    'threat',
    'parry',
    'mayhem',
    'pierce',
    'curse',
    'fury',
    'weaken',
    'ripple',
    'bloom',
    'blaze',
    'attackSpeed',
    'autoAttackDamage',
    'abilityDamage',
    'retaliation',
    'maxHitpointsRatio',
    'maxManapointsRatio',
]);

/**
 * Check if an item has any combat-relevant stats (not just utility like foodSlots).
 * @param {Object} itemDetails - Item detail from itemDetailMap
 * @returns {boolean}
 */
function hasCombatStats(itemDetails) {
    if (!itemDetails?.equipmentDetail?.combatStats) return false;
    for (const stat of Object.keys(itemDetails.equipmentDetail.combatStats)) {
        if (COMBAT_STATS.has(stat) && itemDetails.equipmentDetail.combatStats[stat] !== 0) {
            return true;
        }
    }
    return false;
}

/**
 * The "what you wear now → what this buys" line for a swap.
 *
 * Every piece on both sides carries its own enhancement level. The old shape
 * put a single `(+7)` at the end, which said one level for the whole change and
 * silently attributed the worn piece's level to the piece coming in — only ever
 * correct because a tier swap happens to keep the enhancement. Spelling both
 * sides out means the label stays true when they differ, which is exactly what
 * the refined-item clamp makes happen.
 *
 * @param {string} fromName - The piece being replaced
 * @param {number} fromLevel - Its enhancement level
 * @param {string[]} toNames - The pieces coming in, in display order
 * @param {number[]} toLevels - Their enhancement levels, in the same order
 * @returns {string} Description
 */
function swapDescription(fromName, fromLevel, toNames, toLevels) {
    const to = toNames.map((name, index) => labelItemWithLevel(name, toLevels[index] ?? toLevels[0] ?? 0)).join(' + ');
    return `${labelItemWithLevel(fromName, fromLevel)} → ${to}`;
}

/**
 * Rebuild a swap's description from the names it was built with.
 *
 * Kept alongside `swapLabel` on the candidate so a later change to the levels —
 * the refined clamp is the only one — can redraw the line rather than patch the
 * end of the string it produced. The clamp used to do exactly that, with a
 * regex for the trailing `(+4)`, which the per-piece shape no longer has.
 *
 * @param {Object} candidate - A candidate carrying `swapLabel`
 * @returns {string} Description
 */
function redescribeSwap(candidate) {
    const levels = candidate.addedSlots
        ? Object.values(candidate.addedSlots).map((item) => item.enhancementLevel || 0)
        : [candidate.upgradeLevel];
    return swapDescription(candidate.swapLabel.from, candidate.currentLevel, candidate.swapLabel.to, levels);
}

/**
 * Is this the charm slot's item?
 *
 * A charm carries `focusTraining` — the skill hrid that takes 70% of the
 * combat experience (engine/player.js, engine/sim-result.js) — and often
 * nothing else. `focusTraining` is a skill hrid rather than a number, so it is
 * not in COMBAT_STATS and `hasCombatStats` reads a pure-focus charm as inert:
 * the charm slot was skipped in the equipment loop entirely, and no charm level
 * or tier ever reached the candidate list. Charms are ordinary marketplace
 * equipment that enhance and tier up like the rest, so they are let through on
 * being a charm rather than on carrying a stat the table happens to rank.
 *
 * @param {Object} itemDetails - Item detail from itemDetailMap
 * @returns {boolean}
 */
function isCharmItem(itemDetails) {
    return itemDetails?.equipmentDetail?.type === CHARM_SLOT;
}

/**
 * The next charm up from the one worn, staying on the same focus skill.
 *
 * Charm families are distinguished by item level rather than by a crafting
 * chain, so the tier walk the rest of the equipment loop uses finds nothing for
 * them. "Next" is the lowest item level strictly above the current charm's,
 * which is one step rather than the whole family — the same single-step rule
 * every other slot's tier candidate follows.
 *
 * Swapping the focus skill is deliberately not a candidate: that is a decision
 * about which skill to train, not an upgrade, and it would put one row per
 * combat skill into a table that ranks on gold.
 *
 * @param {string} currentHrid - The equipped charm
 * @param {Object} gameData - Game data payload
 * @returns {{hrid: string, name: string}|null} The next charm, if there is one
 */
function nextCharmTier(currentHrid, gameData) {
    const current = gameData?.itemDetailMap?.[currentHrid];
    if (!isCharmItem(current)) return null;

    const focus = current.equipmentDetail.combatStats?.focusTraining;
    const currentItemLevel = current.itemLevel || 0;

    let best = null;
    for (const [hrid, detail] of Object.entries(gameData.itemDetailMap || {})) {
        if (hrid === currentHrid || !isCharmItem(detail)) continue;
        if ((detail.equipmentDetail.combatStats?.focusTraining || '') !== (focus || '')) continue;
        const itemLevel = detail.itemLevel || 0;
        if (itemLevel <= currentItemLevel) continue;
        if (!best || itemLevel < best.itemLevel) {
            best = { hrid, name: detail.name || hrid.split('/').pop(), itemLevel };
        }
    }
    return best ? { hrid: best.hrid, name: best.name } : null;
}

/**
 * Build a map of valid tier upgrades based on crafting/production chains.
 * An item X can upgrade to item Y if Y's crafting action uses X as:
 *   - upgradeItemHrid (direct upgrade chain), OR
 *   - one of its inputItems (combination recipes like Philosopher's)
 *
 * Only considers equipment outputs and equipment inputs.
 * @param {Object} gameData
 * @returns {Map<string, Set<string>>} itemHrid → Set of possible upgrade output hrids
 */
function buildUpgradeMap(gameData) {
    const map = new Map();

    for (const action of Object.values(gameData.actionDetailMap)) {
        if (!action.outputItems?.length) continue;
        const outputHrid = action.outputItems[0].itemHrid;

        // Only consider equipment outputs
        const outputItem = gameData.itemDetailMap[outputHrid];
        if (!outputItem?.equipmentDetail?.type) continue;

        // upgradeItemHrid → output (direct upgrade chain)
        if (action.upgradeItemHrid) {
            const upgradeItem = gameData.itemDetailMap[action.upgradeItemHrid];
            if (upgradeItem?.equipmentDetail?.type) {
                if (!map.has(action.upgradeItemHrid)) map.set(action.upgradeItemHrid, new Set());
                map.get(action.upgradeItemHrid).add(outputHrid);
            }
        }

        // inputItems → output (combination recipes like Philosopher's)
        if (action.inputItems) {
            for (const input of action.inputItems) {
                const inputItem = gameData.itemDetailMap[input.itemHrid];
                if (!inputItem?.equipmentDetail?.type) continue;

                if (!map.has(input.itemHrid)) map.set(input.itemHrid, new Set());
                map.get(input.itemHrid).add(outputHrid);
            }
        }
    }

    return map;
}

/**
 * Get the primary damage style of an item's combat stats.
 * @param {Object} combatStats - Item combat stats
 * @returns {string} 'slash', 'stab', 'smash', 'ranged', 'magic', or 'unknown'
 */
function getItemDamageStyle(combatStats) {
    if (!combatStats) return 'unknown';
    const slash = combatStats.slashDamage || 0;
    const stab = combatStats.stabDamage || 0;
    const smash = combatStats.smashDamage || 0;
    const ranged = combatStats.rangedDamage || 0;
    const magic = combatStats.magicDamage || 0;

    // An accessory that raises every style at once (the Philosopher's
    // Necklace: slash/stab/smash/ranged/magic all equal) has no style of its
    // own. Letting slash win the five-way tie called it a melee piece, and the
    // substitution filter then refused it to every loadout wearing a styleless
    // necklace — the swap vanished from the upgrade table entirely.
    if (slash > 0 && stab > 0 && smash > 0 && ranged > 0 && magic > 0) return 'unknown';
    if (slash >= stab && slash >= smash && slash >= ranged && slash >= magic && slash > 0) return 'slash';
    if (stab >= slash && stab >= smash && stab >= ranged && stab >= magic && stab > 0) return 'stab';
    if (smash >= slash && smash >= stab && smash >= ranged && smash >= magic && smash > 0) return 'smash';
    if (ranged >= slash && ranged >= stab && ranged >= smash && ranged >= magic && ranged > 0) return 'ranged';
    if (magic > 0) return 'magic';
    return 'unknown';
}

/**
 * Which attack styles an item's offensive stats are for.
 *
 * An off-hand carrying melee accuracy is a melee off-hand, whatever else it
 * gives — pairing it with a crossbow offers a bow user a shield whose entire
 * offensive contribution is dead weight.
 *
 * @param {Object} stats - `equipmentDetail.combatStats`
 * @returns {Set<string>} Any of `magic`, `ranged`, `melee`; empty when the piece
 *   is purely defensive and so fits any style
 */
function offensiveStyles(stats = {}) {
    const styles = new Set();
    if ((stats.magicDamage || 0) > 0 || (stats.magicAccuracy || 0) > 0) styles.add('magic');
    if ((stats.rangedDamage || 0) > 0 || (stats.rangedAccuracy || 0) > 0) styles.add('ranged');
    const meleeDamage = (stats.stabDamage || 0) + (stats.slashDamage || 0) + (stats.smashDamage || 0);
    const meleeAccuracy = (stats.stabAccuracy || 0) + (stats.slashAccuracy || 0) + (stats.smashAccuracy || 0);
    if (meleeDamage > 0 || meleeAccuracy > 0) styles.add('melee');
    return styles;
}

/**
 * Find candidate off-hand items for a given combat style and level range.
 * Returns up to two options (deduped):
 *  - Style-matched: highest-itemLevel off-hand whose offensive stats match the
 *    weapon's damage style (e.g. Manticore Shield for ranged).
 *  - Highest-itemLevel: the strongest off-hand by item level among those that
 *    fit the style — either matching it or carrying no offensive stats at all.
 *
 * That second one used to be the strongest off-hand *overall*, which paired a
 * ranged main hand with a melee shield and offered it as an upgrade. An
 * off-hand built for another style is not a better off-hand, whatever its item
 * level says; a purely defensive one is still fair game for anybody.
 *
 * @param {Object} gameData - Game data
 * @param {string} damageStyle - Primary damage style of the weapon
 * @param {number} maxItemLevel - Maximum item level to consider
 * @returns {Array<{hrid: string, itemLevel: number}>}
 */
function findBestOffHand(gameData, damageStyle, maxItemLevel) {
    const family = damageStyle === 'magic' ? 'magic' : damageStyle === 'ranged' ? 'ranged' : 'melee';

    let styleMatched = null; // highest-itemLevel off-hand with style-matched stats
    let highest = null; // highest-itemLevel off-hand overall (with magic-exclusion for non-magic)

    for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
        const eq = item.equipmentDetail;
        if (!eq || eq.type !== '/equipment_types/off_hand') continue;
        if (!hasCombatStats(item)) continue;
        if ((item.itemLevel || 0) > maxItemLevel) continue;

        const level = item.itemLevel || 0;
        const styles = offensiveStyles(eq.combatStats);

        // An off-hand whose offensive stats are for another style is not an
        // upgrade for this weapon at any item level; one with none at all is
        // pure defence and fits anybody
        if ([...styles].some((style) => style !== family)) continue;

        if (!highest || level > highest.itemLevel) {
            highest = { hrid: itemHrid, itemLevel: level };
        }

        // Style-matched: the highest one that actually contributes to this
        // weapon's damage, rather than merely not clashing with it
        if (styles.has(family) && (!styleMatched || level > styleMatched.itemLevel)) {
            styleMatched = { hrid: itemHrid, itemLevel: level };
        }
    }

    const out = [];
    if (styleMatched) out.push({ hrid: styleMatched.hrid, itemLevel: styleMatched.itemLevel });
    if (highest && (!styleMatched || highest.hrid !== styleMatched.hrid)) {
        out.push({ hrid: highest.hrid, itemLevel: highest.itemLevel });
    }
    return out;
}

/**
 * How much taskDamage the item(s) a candidate equips would carry.
 *
 * Read off the item rather than measured by simulation on purpose: the sims
 * that rank candidates are generic zone fights, run with the engine's task
 * bonus switched off, so a task badge measures there as exactly what it is off
 * task — inert. This number exists only so the row can name the conditional
 * gain it is *not* counting.
 *
 * @param {Object} candidate - An upgrade candidate
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {number} Base taskDamage ratio across the equipped items, 0 if none
 */
function candidateTaskDamage(candidate, gameData) {
    const items = [];
    if (candidate?.upgradeHrid) items.push(candidate.upgradeHrid);
    if (candidate?.addedSlots) {
        for (const item of Object.values(candidate.addedSlots)) {
            if (item?.hrid) items.push(item.hrid);
        }
    }

    let total = 0;
    for (const hrid of items) {
        total += gameData?.itemDetailMap?.[hrid]?.equipmentDetail?.combatStats?.taskDamage || 0;
    }
    return total;
}

/**
 * The slot a fill candidate should land in on this particular ability bar.
 *
 * The special slot holds exactly one thing and is the same slot on every
 * loadout, so a special-slot fill is slot 0 or nowhere. Anything else takes the
 * first free slot past it, which differs from bar to bar — hence resolving it
 * against the bar in hand rather than trusting the index the candidate was born
 * with.
 *
 * @param {Array} abilities - A loadout's ability bar
 * @param {string} slot - The candidate's slot, e.g. `ability_3`
 * @returns {number} The slot index, or -1 when this bar has nothing free
 */
function freeAbilitySlot(abilities, slot) {
    if (slot === 'ability_0') return abilities.length > 0 && !abilities[0] ? 0 : -1;
    return abilities.findIndex((ability, index) => index > 0 && !ability);
}

/**
 * Whether the guide would let one ability replace another.
 *
 * Two rules, and they are the whole of what "based on the build guide" means
 * for a swap:
 *
 * - An ability the guide does **not** ask for is fair game to replace. That is
 *   the point — the off-guide ability in slot 4 is what a spear build wants
 *   Puncture in.
 * - An ability the guide **does** ask for is left alone, unless the newcomer is
 *   its OR-alternative. This is what keeps `Critical Aura → Fierce Aura` and
 *   `Shield Bash → Retribution` on the table while stopping the generator
 *   proposing that a spear build drop the Frenzy the guide just asked it to
 *   run in favour of Puncture.
 *
 * Group membership is always read from the archetype's *whole* set, never from
 * the aura-only subset — otherwise aura-only mode would treat every
 * non-signature guide ability as off-guide and offer to replace it.
 *
 * @param {Object} guide - From `buildGuidePlan`
 * @param {string} currentHrid - The equipped ability that would be displaced
 * @param {string} incomingHrid - The ability being offered
 * @returns {boolean}
 */
function guideSwapAllowed(guide, currentHrid, incomingHrid) {
    const currentGroup = guide.memberOf.get(currentHrid);
    if (currentGroup === undefined) return true;
    return guide.memberOf.get(incomingHrid) === currentGroup;
}

/**
 * Guide abilities for the slots a loadout has left empty.
 *
 * An empty slot is the commonest reason a build is missing its aura, and the
 * slot loop above skips empty slots entirely — it is built around replacing one
 * ability with another. This fills them instead: each guide ability the loadout
 * is not already casting goes into the first slot that can hold it, once, at
 * the level of the book you already own (Lv1 when you own none, which is what
 * buying the book would get you).
 *
 * Only on the guide path. Doing it for the fallback path would offer every
 * ability in the game for every empty slot.
 *
 * @param {Object} playerDTO - Player DTO with abilities
 * @param {Object} gameData - Game data payload
 * @param {Object} guide - From `buildGuidePlan`
 * @param {Array} candidates - Candidate list (mutated)
 * @param {boolean} isSelf - False for an imported profile or party member, whose book bag
 *   the live character's `ownedAbility` read cannot answer for
 */
function addGuideEmptySlotCandidates(playerDTO, gameData, guide, candidates, isSelf) {
    const abilities = playerDTO.abilities || [];
    const equipped = new Set(abilities.filter((a) => a).map((a) => a.hrid));
    const specialSlotFree = abilities.length > 0 && !abilities[0];
    const firstFreeNormal = abilities.findIndex((ability, index) => index > 0 && !ability);

    for (const abHrid of guide.offers) {
        const abDetail = gameData.abilityDetailMap?.[abHrid];
        if (!abDetail || equipped.has(abHrid)) continue;
        const slotIdx = abDetail.isSpecialAbility ? (specialSlotFree ? 0 : -1) : firstFreeNormal;
        if (slotIdx < 0) continue;
        // No style guard here: every abHrid is a guide offer, and the guide's set
        // is style-correct by construction (see the swap loop). The heuristic would
        // wrongly drop a universal aura into an empty special slot.

        const level = Math.max(1, ownedAbility(abHrid, isSelf)?.level || 0);
        const swapName = abDetail.name || abHrid.split('/').pop();
        candidates.push({
            slot: `ability_${slotIdx}`,
            // No `replacesHrid`: this one is about filling a slot rather than
            // displacing an ability. `fillsFreeSlot` says so out loud, because
            // the slot number on it belongs to the loadout it was generated
            // from — pooled across a labyrinth it would otherwise be written
            // over whatever another loadout keeps in that slot.
            fillsFreeSlot: true,
            currentHrid: abHrid,
            currentLevel: 0,
            upgradeHrid: abHrid,
            upgradeLevel: level,
            description: `Empty slot → ${swapName} (Lv${level})`,
            type: 'ability_swap',
        });
    }
}

/**
 * Generate upgrade candidates for a player's equipment and/or abilities.
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @param {string} [mode='equipment'] - 'equipment' or 'abilities'
 * @param {number} [abilityTargetLevel=0] - Target level or increment for ability upgrades
 * @param {string} [abilityLevelType='increment'] - 'increment' (add N levels) or 'target' (absolute level)
 * @param {Object} [communityBuffs=null] - Configured community buffs, for the 'community_buff' set
 * @param {number} [guildShrineTargetLevel=0] - Absolute shrine buff level to buy up to; 0 means one level up
 * @param {Object} [options] - `{ auraSwapsOnly, houseWinRateOnly, communityBuffTargetLevel,
 *   guildShrineTargets, isSelf }`. `houseWinRateOnly` narrows the house set to rooms that can move
 *   a fight's outcome, for an analysis ranked on win rate alone; `communityBuffTargetLevel` buys
 *   several buff levels at once; `guildShrineTargets` is a per-shrine target map that takes
 *   precedence over `guildShrineTargetLevel`, skipping any shrine it does not name;
 *   `guildShrineCapToGuild` limits shrine targets to the guild's own shrine building levels. `isSelf`
 *   (default true) gates the guide's empty-slot fill level off the live character's own book
 *   bag — false for an imported profile or party member, who the sim has no book bag for.
 * @returns {Array} Candidates: [{slot, currentHrid, currentLevel, upgradeHrid, upgradeLevel, description, type}]
 */
export function generateCandidates(
    playerDTO,
    gameData,
    mode = 'equipment',
    abilityTargetLevel = 0,
    abilityLevelType = 'increment',
    skipBackSlot = false,
    combatLevelTargets = null,
    abilityTargets = null,
    houseTargetLevel = 0,
    houseTargets = null,
    communityBuffs = null,
    guildShrineTargetLevel = 0,
    options = {}
) {
    const candidates = [];

    if (mode === 'equipment') {
        const tierProgression = getEquipmentTierProgression(gameData);
        const upgradeMap = buildUpgradeMap(gameData);

        for (const [slot, equip] of Object.entries(playerDTO.equipment)) {
            if (!equip) continue;

            const currentHrid = equip.hrid;
            const currentLevel = equip.enhancementLevel || 0;
            const itemDetails = gameData.itemDetailMap[currentHrid];

            // Trinkets are kept in the table even though these rankings run off
            // task, where a pure task trinket measures as inert: a trinket can
            // carry ordinary combat stats too, and those do rank. What the row
            // must not do is bank the taskDamage — the caveat set below says so.
            if (skipBackSlot && slot === '/equipment_types/back') continue;
            // Charms are the exception: what they carry is a focus-training skill
            // rather than a ranked stat, and gating them on stats hid every charm
            // level and tier from the table. See `isCharmItem`.
            if (!hasCombatStats(itemDetails) && !isCharmItem(itemDetails)) continue;

            // Enhancement upgrade: next breakpoint
            const nextBP = getNextBreakpoint(currentLevel, slot, currentHrid);
            if (nextBP) {
                const itemName = gameData.itemDetailMap[currentHrid]?.name || currentHrid.split('/').pop();
                candidates.push({
                    slot,
                    currentHrid,
                    currentLevel,
                    upgradeHrid: currentHrid,
                    upgradeLevel: nextBP,
                    description: `${itemName} +${currentLevel} → +${nextBP}`,
                    type: 'enhancement',
                });
            }

            // Tier upgrade
            const role = getItemRole(itemDetails?.equipmentDetail?.combatStats);

            if (role === 'defensive') {
                // Defensive items: use crafting chain (upgrade path + combination recipes)
                const upgrades = upgradeMap.get(currentHrid);
                if (upgrades) {
                    for (const upgradeHrid of upgrades) {
                        const upgradeItem = gameData.itemDetailMap[upgradeHrid];
                        if (!upgradeItem?.equipmentDetail) continue;
                        if (upgradeItem.equipmentDetail.type !== slot) continue;
                        const upgradeRole = getItemRole(upgradeItem.equipmentDetail?.combatStats);
                        if (upgradeRole !== 'defensive') continue;

                        const upgradeName = upgradeItem.name || upgradeHrid.split('/').pop();
                        const currentName = itemDetails?.name || currentHrid.split('/').pop();
                        candidates.push({
                            slot,
                            currentHrid,
                            currentLevel,
                            upgradeHrid,
                            upgradeLevel: currentLevel,
                            swapLabel: { from: currentName, to: [upgradeName] },
                            description: swapDescription(currentName, currentLevel, [upgradeName], [currentLevel]),
                            type: 'tier',
                        });
                    }
                }
            } else {
                // Offensive items: keep existing role-based tier progression
                const slotKey = `${slot}|${role}`;
                const slotItems = tierProgression[slotKey];
                const offensiveCurrentName = itemDetails?.name || currentHrid.split('/').pop();
                const offensiveCandidateHrids = new Set();
                if (slotItems) {
                    const currentIdx = slotItems.findIndex((item) => item.hrid === currentHrid);
                    if (currentIdx >= 0 && currentIdx < slotItems.length - 1) {
                        const currentItemLevel = itemDetails?.itemLevel || 0;
                        const currentIsRefined = currentHrid.endsWith('_refined');

                        // The group is item-level sorted, so the immediate neighbour can be
                        // a same-level sibling — a paid sidegrade, not an upgrade. Walk
                        // forward to the first genuinely better entry: a higher item level,
                        // or the refined variant of a non-refined item (same level, better
                        // stats). Refined → another refined at the same level is a sidegrade.
                        let nextTier = null;
                        for (let i = currentIdx + 1; i < slotItems.length; i++) {
                            const contender = slotItems[i];
                            const isUpgrade =
                                contender.itemLevel > currentItemLevel ||
                                (!currentIsRefined && contender.hrid.endsWith('_refined'));
                            if (isUpgrade) {
                                nextTier = contender;
                                break;
                            }
                        }

                        if (nextTier) {
                            const nextName = nextTier.name || nextTier.hrid.split('/').pop();
                            candidates.push({
                                slot,
                                currentHrid,
                                currentLevel,
                                upgradeHrid: nextTier.hrid,
                                upgradeLevel: currentLevel,
                                swapLabel: { from: offensiveCurrentName, to: [nextName] },
                                description: swapDescription(
                                    offensiveCurrentName,
                                    currentLevel,
                                    [nextName],
                                    [currentLevel]
                                ),
                                type: 'tier',
                            });
                            offensiveCandidateHrids.add(nextTier.hrid);
                        }

                        // Also suggest the highest non-refined item in the same slot|role
                        // when the player is already wearing high-tier gear (T60+). This
                        // surfaces direct T95 jumps (e.g. Sighted → Marksman) that the
                        // single-step progression would otherwise hide behind T75 stepping
                        // stones.
                        if (currentItemLevel >= 60) {
                            let highestNonRefined = null;
                            for (let i = slotItems.length - 1; i >= 0; i--) {
                                if (!slotItems[i].hrid.endsWith('_refined')) {
                                    highestNonRefined = slotItems[i];
                                    break;
                                }
                            }
                            if (
                                highestNonRefined &&
                                highestNonRefined.hrid !== currentHrid &&
                                highestNonRefined.hrid !== nextTier?.hrid &&
                                highestNonRefined.itemLevel > currentItemLevel
                            ) {
                                const highestName = highestNonRefined.name || highestNonRefined.hrid.split('/').pop();
                                candidates.push({
                                    slot,
                                    currentHrid,
                                    currentLevel,
                                    upgradeHrid: highestNonRefined.hrid,
                                    upgradeLevel: currentLevel,
                                    swapLabel: { from: offensiveCurrentName, to: [highestName] },
                                    description: swapDescription(
                                        offensiveCurrentName,
                                        currentLevel,
                                        [highestName],
                                        [currentLevel]
                                    ),
                                    type: 'tier',
                                });
                                offensiveCandidateHrids.add(highestNonRefined.hrid);
                            }
                        }
                    }
                }

                // Also walk the crafting-chain upgradeMap for offensive items so that
                // direct upgrade-action targets — most importantly the refined version
                // of the current weapon (e.g. Furious Spear → Furious Spear ★) — surface
                // even when the role-grouped progression would step sideways to a
                // different damage style first.
                const offensiveUpgrades = upgradeMap.get(currentHrid);
                if (offensiveUpgrades) {
                    for (const upgradeHrid of offensiveUpgrades) {
                        if (offensiveCandidateHrids.has(upgradeHrid)) continue;
                        if (upgradeHrid === currentHrid) continue;
                        const upgradeItem = gameData.itemDetailMap[upgradeHrid];
                        if (!upgradeItem?.equipmentDetail) continue;
                        if (upgradeItem.equipmentDetail.type !== slot) continue;
                        const upgradeRole = getItemRole(upgradeItem.equipmentDetail?.combatStats);
                        if (upgradeRole !== role) continue;

                        const upgradeName = upgradeItem.name || upgradeHrid.split('/').pop();
                        candidates.push({
                            slot,
                            currentHrid,
                            currentLevel,
                            upgradeHrid,
                            upgradeLevel: currentLevel,
                            swapLabel: { from: offensiveCurrentName, to: [upgradeName] },
                            description: swapDescription(
                                offensiveCurrentName,
                                currentLevel,
                                [upgradeName],
                                [currentLevel]
                            ),
                            type: 'tier',
                        });
                        offensiveCandidateHrids.add(upgradeHrid);
                    }
                }
            }

            // A charm's tier is not a crafting chain in the data — the families
            // are named ("Basic/Expert … Charm") and separated by item level —
            // so the chain walk above finds nothing to offer. The next charm of
            // the same focus is added directly, which is the same "next tier"
            // the Combat Levels charm picker already reasons about.
            if (isCharmItem(itemDetails)) {
                const nextCharm = nextCharmTier(currentHrid, gameData);
                if (nextCharm && !candidates.some((c) => c.slot === slot && c.upgradeHrid === nextCharm.hrid)) {
                    const currentName = itemDetails?.name || currentHrid.split('/').pop();
                    candidates.push({
                        slot,
                        currentHrid,
                        currentLevel,
                        upgradeHrid: nextCharm.hrid,
                        upgradeLevel: currentLevel,
                        swapLabel: { from: currentName, to: [nextCharm.name] },
                        description: swapDescription(currentName, currentLevel, [nextCharm.name], [currentLevel]),
                        type: 'tier',
                    });
                }
            }
        }

        // Cross-slot candidates: two_hand ↔ main_hand + off_hand
        const twoHandEquip = playerDTO.equipment['/equipment_types/two_hand'];
        const mainHandEquip = playerDTO.equipment['/equipment_types/main_hand'];
        const offHandEquip = playerDTO.equipment['/equipment_types/off_hand'];

        if (twoHandEquip) {
            // Case A: Player has two_hand → suggest main_hand + best off_hand
            const twoHandItem = gameData.itemDetailMap[twoHandEquip.hrid];
            const twoHandStats = twoHandItem?.equipmentDetail?.combatStats;
            const damageStyle = getItemDamageStyle(twoHandStats);

            if (damageStyle !== 'unknown') {
                const twoHandLevel = twoHandItem?.itemLevel || 0;
                const enhLevel = twoHandEquip.enhancementLevel || 0;

                // Find main_hand weapons with matching style at or above current level
                for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
                    const eq = item.equipmentDetail;
                    if (!eq || eq.type !== '/equipment_types/main_hand') continue;
                    if (!hasCombatStats(item)) continue;
                    if ((item.itemLevel || 0) < twoHandLevel) continue;

                    const style = getItemDamageStyle(eq.combatStats);
                    if (style !== damageStyle) continue;

                    // Find candidate off-hands at this tier (may return 1 or 2 options:
                    // style-matched and/or highest-itemLevel).
                    const offHandCandidates = findBestOffHand(gameData, damageStyle, item.itemLevel || 999);
                    if (!offHandCandidates.length) continue;

                    const mainName = item.name || itemHrid.split('/').pop();
                    const currentName = twoHandItem?.name || twoHandEquip.hrid.split('/').pop();

                    for (const bestOH of offHandCandidates) {
                        const ohItem = gameData.itemDetailMap[bestOH.hrid];
                        const ohName = ohItem?.name || bestOH.hrid.split('/').pop();

                        candidates.push({
                            slot: '/equipment_types/two_hand',
                            currentHrid: twoHandEquip.hrid,
                            currentLevel: enhLevel,
                            upgradeHrid: itemHrid,
                            upgradeLevel: enhLevel,
                            addedSlots: {
                                '/equipment_types/main_hand': { hrid: itemHrid, enhancementLevel: enhLevel },
                                '/equipment_types/off_hand': { hrid: bestOH.hrid, enhancementLevel: enhLevel },
                            },
                            clearedSlots: ['/equipment_types/two_hand'],
                            removedItems: [{ hrid: twoHandEquip.hrid, enhancementLevel: enhLevel }],
                            swapLabel: { from: currentName, to: [mainName, ohName] },
                            description: swapDescription(
                                currentName,
                                enhLevel,
                                [mainName, ohName],
                                [enhLevel, enhLevel]
                            ),
                            type: 'cross_slot',
                        });
                    }
                }
            }
        } else if (mainHandEquip) {
            // Case B: Player has main_hand (+off_hand) → suggest best two_hand
            const mainHandItem = gameData.itemDetailMap[mainHandEquip.hrid];
            const mainHandStats = mainHandItem?.equipmentDetail?.combatStats;
            const damageStyle = getItemDamageStyle(mainHandStats);

            if (damageStyle !== 'unknown') {
                const mainHandLevel = mainHandItem?.itemLevel || 0;
                const enhLevel = mainHandEquip.enhancementLevel || 0;

                // Find two_hand weapons with matching style above current main_hand level
                for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
                    const eq = item.equipmentDetail;
                    if (!eq || eq.type !== '/equipment_types/two_hand') continue;
                    if (!hasCombatStats(item)) continue;
                    if ((item.itemLevel || 0) <= mainHandLevel) continue;

                    const style = getItemDamageStyle(eq.combatStats);
                    if (style !== damageStyle) continue;
                    if (getItemRole(eq.combatStats) === 'defensive') continue;

                    const twoHandName = item.name || itemHrid.split('/').pop();
                    const currentName = mainHandItem?.name || mainHandEquip.hrid.split('/').pop();

                    const clearedSlots = ['/equipment_types/main_hand'];
                    if (offHandEquip) clearedSlots.push('/equipment_types/off_hand');

                    candidates.push({
                        slot: '/equipment_types/main_hand',
                        currentHrid: mainHandEquip.hrid,
                        currentLevel: enhLevel,
                        upgradeHrid: itemHrid,
                        upgradeLevel: enhLevel,
                        addedSlots: {
                            '/equipment_types/two_hand': { hrid: itemHrid, enhancementLevel: enhLevel },
                        },
                        clearedSlots,
                        removedItems: [
                            { hrid: mainHandEquip.hrid, enhancementLevel: enhLevel },
                            ...(offHandEquip
                                ? [{ hrid: offHandEquip.hrid, enhancementLevel: offHandEquip.enhancementLevel || 0 }]
                                : []),
                        ],
                        swapLabel: { from: currentName, to: [twoHandName] },
                        description: swapDescription(currentName, enhLevel, [twoHandName], [enhLevel]),
                        type: 'cross_slot',
                    });
                }
            }
        }

        addPhiloAccessoryCandidates(playerDTO, gameData, candidates);
    } else if (mode === 'ability_level' || mode === 'ability_swap') {
        const playerStyle = getPlayerCombatStyle(playerDTO, gameData);
        const equippedAbilityHrids = new Set(playerDTO.abilities.filter((a) => a).map((a) => a.hrid));
        // What the community build guide says this loadout should be casting.
        // Null when the archetype cannot be read off the weapon, or when the
        // guide's abilities are not in this game data at all — either way the
        // loop below falls back to offering every style-compatible ability,
        // which is the behaviour this set has always had.
        const guide =
            mode === 'ability_swap'
                ? buildGuidePlan(playerDTO, gameData, { auraOnly: Boolean(options.auraSwapsOnly) })
                : null;
        const abilityTargetsMap =
            abilityTargets && typeof abilityTargets === 'object' && Object.keys(abilityTargets).length > 0
                ? abilityTargets
                : null;

        for (let slotIdx = 0; slotIdx < playerDTO.abilities.length; slotIdx++) {
            const ability = playerDTO.abilities[slotIdx];
            if (!ability) continue;

            const abilityDetail = gameData.abilityDetailMap[ability.hrid];
            if (!abilityDetail) continue;
            const abilityName = abilityDetail.name || ability.hrid.split('/').pop();

            if (mode === 'ability_level') {
                // Level upgrade candidate. Per-ability targets (when set)
                // replace the uniform increment/target — abilities without an
                // entry or at/below their current level are skipped
                let targetLevel;
                if (abilityTargetsMap) {
                    targetLevel = Math.floor(abilityTargetsMap[ability.hrid] || 0);
                } else if (abilityLevelType === 'target') {
                    targetLevel =
                        abilityTargetLevel > ability.level
                            ? abilityTargetLevel
                            : getNextAbilityBreakpoint(ability.level);
                } else {
                    const increment = abilityTargetLevel > 0 ? abilityTargetLevel : 5;
                    targetLevel = ability.level + increment;
                }
                targetLevel = Math.min(targetLevel, 200);
                if (targetLevel > ability.level) {
                    candidates.push({
                        slot: `ability_${slotIdx}`,
                        currentHrid: ability.hrid,
                        currentLevel: ability.level,
                        upgradeHrid: ability.hrid,
                        upgradeLevel: targetLevel,
                        description: `${abilityName} Lv${ability.level} → Lv${targetLevel}`,
                        type: 'ability_level',
                    });
                }
            } else {
                // Swap candidates: other compatible abilities not already equipped.
                // With a guide, "other" is the archetype's own ability set rather
                // than every ability in the game — see `guideSwapAllowed`.
                const offered = guide ? guide.offers : Object.keys(gameData.abilityDetailMap);
                for (const abHrid of offered) {
                    const abDetail = gameData.abilityDetailMap[abHrid];
                    if (!abDetail) continue;
                    if (equippedAbilityHrids.has(abHrid)) continue;
                    if (abDetail.isSpecialAbility && slotIdx !== 0) continue;
                    if (!abDetail.isSpecialAbility && slotIdx === 0) continue;
                    if (abHrid === '/abilities/promote') continue;
                    // The guide's own set is style-correct by construction — each
                    // archetype lists its own style's abilities plus the universal
                    // Critical Aura — so on the guide path trust guideSwapAllowed and
                    // skip the style heuristic. That heuristic reads style from buff
                    // data and mis-vetoes a universal aura whose buffs happen to look
                    // like another style (Critical Aura on a magic build), silently
                    // dropping the aura swap. Only the every-ability fallback, which
                    // offers the whole game, needs the compatibility guard.
                    if (guide) {
                        if (!guideSwapAllowed(guide, ability.hrid, abHrid)) continue;
                    } else if (!isAbilityCompatible(getAbilityCombatStyle(abDetail), playerStyle)) {
                        continue;
                    }

                    const swapName = abDetail.name || abHrid.split('/').pop();
                    candidates.push({
                        slot: `ability_${slotIdx}`,
                        currentHrid: ability.hrid,
                        currentLevel: ability.level,
                        upgradeHrid: abHrid,
                        upgradeLevel: ability.level,
                        // The ability this swap is *about*, said out loud rather
                        // than left to the slot index. Across several loadouts
                        // the same ability sits in different slots, and a swap
                        // is only a swap in the loadouts that cast the thing it
                        // takes out — `candidateAppliesToDTO` reads this, and
                        // `applyCandidateToDTO` puts the newcomer where it was.
                        replacesHrid: ability.hrid,
                        description: `${abilityName} → ${swapName} (Lv${ability.level})`,
                        type: 'ability_swap',
                    });
                }
            }
        }

        if (guide) addGuideEmptySlotCandidates(playerDTO, gameData, guide, candidates, options.isSelf !== false);
    }

    if (mode === 'combat_level') {
        // Simulate boosted combat skill levels to rank which skill is most
        // effective to level next. Uniform boost of +N (abilityTargetLevel
        // carries N) or explicit per-skill target levels when provided.
        const boost = Math.max(1, Math.floor(abilityTargetLevel) || 5);
        const targets =
            combatLevelTargets && typeof combatLevelTargets === 'object' && Object.keys(combatLevelTargets).length > 0
                ? combatLevelTargets
                : null;
        const excludedSkills = getStyleExcludedSkills(playerDTO, gameData);
        for (const skill of COMBAT_LEVEL_SKILLS) {
            if (excludedSkills.has(skill.key)) continue;
            const currentLevel = Math.max(1, Math.floor(playerDTO[skill.key] || 1));
            const upgradeLevel = targets ? Math.min(200, Math.floor(targets[skill.key] || 0)) : currentLevel + boost;
            if (upgradeLevel <= currentLevel) continue;
            candidates.push({
                type: 'combat_level',
                slot: `combat_level|${skill.key}`,
                skillKey: skill.key,
                currentLevel,
                upgradeLevel,
                levelBoost: upgradeLevel - currentLevel,
                description: `${skill.label} ${currentLevel} → ${upgradeLevel}`,
            });
        }
    }

    if (mode === 'house') {
        candidates.push(
            ...generateHouseCandidates(playerDTO, gameData, houseTargetLevel, houseTargets, {
                winRateOnly: Boolean(options?.houseWinRateOnly),
            })
        );
    }

    if (mode === 'guild_shrine') {
        candidates.push(
            ...generateGuildShrineCandidates(playerDTO, {
                combat: true,
                targetLevel: guildShrineTargetLevel,
                perBuffTargets: options?.guildShrineTargets || null,
                capToGuildLevel: Boolean(options?.guildShrineCapToGuild),
            })
        );
    }

    if (mode === 'drink') {
        candidates.push(...generateDrinkCandidates(playerDTO, gameData));
    }

    if (mode === 'community_buff') {
        candidates.push(...generateCommunityBuffCandidates(communityBuffs, options?.communityBuffTargetLevel));
    }

    if (mode === 'scroll') {
        candidates.push(...generateScrollCandidates(playerDTO));
    }

    // taskDamage pays only while the monster in front of you is your combat
    // task, and an advisor ranking is a generic zone fight — so every sim below
    // runs with isTaskFight off and the ranked delta on a task badge is its
    // off-task delta, which for a pure task trinket is nothing. Ranking them
    // with the bonus on is what floated Expert Task Badge to the top of the
    // table on damage it would only deal while on task. The gain that does
    // exist is real but conditional, so it goes on the row as a caveat rather
    // than into the number the table sorts by.
    for (const candidate of candidates) {
        const taskDamage = candidateTaskDamage(candidate, gameData);
        if (candidate.slot !== TRINKET_SLOT && !taskDamage) continue;
        const amount = taskDamage ? `+${(taskDamage * 100).toFixed(1)}% task damage` : 'Task damage';
        candidate.caveat =
            `${amount} is not in the ranked delta: these sims are generic zone fights, where the stat pays ` +
            'nothing. It applies only while the monster is your active combat task — sim from that task card ' +
            '(or tick Task Fight in the combat sim panel) to see the on-task number.';
    }

    // The crafting-chain walk only reaches base path boots; add their refined
    // siblings so both appear, before the level passes normalize everything.
    addRefinedPathBootCandidates(candidates, gameData);
    candidates.forEach(clampRefinedCandidateToMinLevel);
    // After the refined +10 floor, so refined path boots land at +7, not +10.
    candidates.forEach(applyPathBootsSimLevel);
    return candidates;
}

/**
 * Buff types the combat engine actually reads (see engine/combat-unit.js and
 * combat-utilities.js). A house room whose buffs land in this set changes a fight
 * no matter how the game labels the room.
 */
const COMBAT_BUFF_TYPES = new Set([
    '/buff_types/accuracy',
    '/buff_types/armor',
    '/buff_types/attack_speed',
    '/buff_types/cast_speed',
    '/buff_types/combat_drop_quantity',
    '/buff_types/combat_drop_rate',
    '/buff_types/critical_damage',
    '/buff_types/critical_rate',
    '/buff_types/damage',
    '/buff_types/damage_taken',
    '/buff_types/elemental_thorns',
    '/buff_types/evasion',
    '/buff_types/fire_amplify',
    '/buff_types/fire_resistance',
    '/buff_types/fury_accuracy',
    '/buff_types/fury_damage',
    '/buff_types/healing_amplify',
    '/buff_types/hp_regen',
    '/buff_types/life_steal',
    '/buff_types/mp_regen',
    '/buff_types/nature_amplify',
    '/buff_types/nature_resistance',
    '/buff_types/physical_amplify',
    '/buff_types/physical_thorns',
    '/buff_types/rare_find',
    '/buff_types/retaliation',
    '/buff_types/tenacity',
    '/buff_types/threat',
    '/buff_types/water_amplify',
    '/buff_types/water_resistance',
    '/buff_types/wisdom',
]);

const COMBAT_ACTION_TYPE = '/action_types/combat';

/**
 * Does this house room change a combat sim?
 *
 * Three independent signals, because the game exposes the action-type tag in more
 * than one place and a global buff carries no tag at all: the room's own
 * usableInActionTypeMap, a per-buff usableInActionTypeMap, or a buff type the
 * combat engine reads. Any of them is enough. Over-including a room only costs a
 * sim that comes back at 0.00%; under-including hides a real upgrade, which is
 * how the first version produced an empty list.
 * @param {Object} roomDetail - Entry from houseRoomDetailMap
 * @returns {boolean}
 */
export function houseRoomAffectsCombat(roomDetail) {
    const buffs = [...(roomDetail?.actionBuffs || []), ...(roomDetail?.globalBuffs || [])];
    if (buffs.length === 0) return false;

    if (roomDetail?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE]) return true;
    return buffs.some(
        (buff) => buff?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE] || COMBAT_BUFF_TYPES.has(buff?.typeHrid)
    );
}

/**
 * Buff types a fight *reaches the end of* regardless of.
 *
 * `COMBAT_BUFF_TYPES` is the list of things the combat engine reads, which is
 * the right question for the combat sim's Upgrade tab — it reports profit and
 * XP per hour, so a rare-find room and a wisdom room both move a column there.
 * It is the wrong question for the labyrinth, which ranks on one number: the
 * share of attempts that end in a clear. Nothing on this list can change whether
 * a fight is won. Wisdom changes what the win is worth in experience; rare find
 * and the two combat drop buffs change what it pays out; the skilling types are
 * carried by every skilling room and are inert in a fight to begin with.
 *
 * Every house room in the game carries a *global* wisdom and rare-find buff —
 * that is what the game gives you for building any room at all — so admitting a
 * room on either of them admits all seventeen. That is how a Dairy Barn and a
 * Mystical Study ended up in a labyrinth combat table, each with a delta that
 * was the baseline's sampling noise wearing a room's name.
 */
const WIN_RATE_INERT_BUFF_TYPES = new Set([
    '/buff_types/wisdom',
    '/buff_types/rare_find',
    '/buff_types/combat_drop_rate',
    '/buff_types/combat_drop_quantity',
    '/buff_types/efficiency',
    '/buff_types/action_speed',
    '/buff_types/gathering',
    '/buff_types/essence_find',
    '/buff_types/success_rate',
    '/buff_types/labyrinth_double_progress',
]);

/**
 * Can one more level of this house room change how often a labyrinth fight is
 * won?
 *
 * Stricter than `houseRoomAffectsCombat` on purpose, and only in one direction:
 * a buff whose type is on the inert list above is not evidence of anything,
 * however the room or the buff is tagged. Everything else keeps the same three
 * signals — a known combat buff type, or an unknown type the game itself says is
 * usable in combat, which is what keeps a buff type added next patch from being
 * silently dropped.
 *
 * The rooms this excludes are the ten skilling rooms, whose only combat-facing
 * buffs are the global wisdom and rare find every room grants, plus any combat
 * room whose own buff is experience rather than a fighting stat. What it keeps
 * is every room granting damage, armor, accuracy, evasion, attack or cast speed,
 * crit, amplify, resistance, thorns, regen, life steal, tenacity, retaliation,
 * healing amplify or threat.
 *
 * @param {Object} roomDetail - Entry from houseRoomDetailMap
 * @returns {boolean}
 */
export function houseRoomMovesWinRate(roomDetail) {
    const buffs = [...(roomDetail?.actionBuffs || []), ...(roomDetail?.globalBuffs || [])];
    const roomTagged = Boolean(roomDetail?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE]);

    return buffs.some((buff) => {
        const typeHrid = buff?.typeHrid;
        if (!typeHrid) return false;
        if (WIN_RATE_INERT_BUFF_TYPES.has(typeHrid)) return false;
        if (COMBAT_BUFF_TYPES.has(typeHrid)) return true;
        return roomTagged || Boolean(buff?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE]);
    });
}

/**
 * The room test one analysis should use.
 * @param {boolean} winRateOnly - Whether the caller ranks on win rate alone
 * @returns {Function} A predicate over a `houseRoomDetailMap` entry
 */
function houseRoomPredicate(winRateOnly) {
    return winRateOnly ? houseRoomMovesWinRate : houseRoomAffectsCombat;
}

/**
 * Canonical key for what a candidate actually equips, used to deduplicate.
 *
 * Keyed on the full slot assignment rather than one representative slot: a
 * multi-slot candidate differs from the single-slot swap of its first piece, and
 * a single-slot cross_slot candidate is the same change as the equivalent tier
 * candidate. Keying on the first slot alone collapsed the pair candidates into
 * their body-only sibling and let single-slot duplicates through.
 * @param {Object} candidate - Upgrade candidate
 * @returns {string} Key describing the resulting equipment change
 */
export function candidateAssignmentKey(candidate) {
    if (candidate.addedSlots) {
        const added = Object.entries(candidate.addedSlots)
            .map(([slot, item]) => `${slot}=${item.hrid}@${item.enhancementLevel || 0}`)
            .sort()
            .join(',');
        const cleared = [...(candidate.clearedSlots || [])].sort().join(',');
        return `equip:${added}!${cleared}`;
    }
    if (
        candidate.type === 'combat_level' ||
        candidate.type === 'house' ||
        candidate.type === 'guild_shrine' ||
        candidate.type === 'community_buff' ||
        candidate.type === 'scroll' ||
        candidate.type === 'drink' ||
        candidate.slot?.startsWith('ability_')
    ) {
        return `${candidate.type}:${candidate.slot}=${candidate.upgradeHrid || ''}@${candidate.upgradeLevel}`;
    }
    return `equip:${candidate.slot}=${candidate.upgradeHrid}@${candidate.upgradeLevel}!`;
}

/**
 * Count what the house scan saw, so an empty candidate list can explain itself
 * instead of reading as "no upgrades available".
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @param {Object} [options] - `{ winRateOnly }`, the labyrinth's stricter room test
 * @returns {{rooms: number, withBuffs: number, combatRelevant: number, belowCap: number}}
 */
export function describeHouseScan(playerDTO, gameData, options = {}) {
    const roomMap = gameData?.houseRoomDetailMap || {};
    const isRelevant = houseRoomPredicate(options?.winRateOnly);
    let withBuffs = 0;
    let combatRelevant = 0;
    let belowCap = 0;

    for (const [roomHrid, roomDetail] of Object.entries(roomMap)) {
        const buffs = [...(roomDetail?.actionBuffs || []), ...(roomDetail?.globalBuffs || [])];
        if (buffs.length > 0) withBuffs++;
        if (!isRelevant(roomDetail)) continue;
        combatRelevant++;
        const level = Math.max(0, Math.floor(Number(playerDTO?.houseRooms?.[roomHrid]) || 0));
        if (level < MAX_HOUSE_LEVEL) belowCap++;
    }

    return { rooms: Object.keys(roomMap).length, withBuffs, combatRelevant, belowCap };
}

/**
 * Generate house room upgrade candidates for every combat-relevant room.
 * @param {Object} playerDTO - Player DTO (houseRooms carries current levels)
 * @param {Object} gameData - Game data payload (houseRoomDetailMap)
 * @param {number} [targetLevel] - Level to sim every room at; 0/unset means one level up
 * @param {Object|null} [perRoomTargets] - roomHrid → target level; takes precedence
 *   over targetLevel, and a room absent from it is skipped (blank means skip)
 * @param {Object} [options] - `{ winRateOnly }`; see `houseRoomMovesWinRate`
 * @returns {Array<Object>} Candidates of type 'house'
 */
export function generateHouseCandidates(playerDTO, gameData, targetLevel = 0, perRoomTargets = null, options = {}) {
    const roomMap = gameData?.houseRoomDetailMap;
    if (!roomMap) return [];

    const target = Math.min(MAX_HOUSE_LEVEL, Math.max(0, Math.floor(Number(targetLevel) || 0)));
    const explicit = perRoomTargets && typeof perRoomTargets === 'object' ? perRoomTargets : null;
    const isRelevant = houseRoomPredicate(options?.winRateOnly);

    const candidates = [];
    for (const [roomHrid, roomDetail] of Object.entries(roomMap)) {
        if (!isRelevant(roomDetail)) continue;

        const currentLevel = Math.max(0, Math.floor(Number(playerDTO.houseRooms?.[roomHrid]) || 0));
        if (currentLevel >= MAX_HOUSE_LEVEL) continue;

        // Per-room target wins; then the uniform target; otherwise one level up.
        // With per-room targets open, a room left blank is deliberately skipped.
        let upgradeLevel;
        if (explicit) {
            upgradeLevel = Math.min(MAX_HOUSE_LEVEL, Math.floor(Number(explicit[roomHrid]) || 0));
        } else {
            upgradeLevel = target > 0 ? target : currentLevel + 1;
        }
        if (upgradeLevel <= currentLevel) continue;

        const roomName = roomDetail.name || roomHrid.split('/').pop().replace(/_/g, ' ');
        candidates.push({
            type: 'house',
            slot: `house|${roomHrid}`,
            roomHrid,
            roomName,
            currentLevel,
            upgradeLevel,
            levelsBought: upgradeLevel - currentLevel,
            description: `${roomName} Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/**
 * Buff types the skilling clear-rate metrics can actually measure a change in.
 * A shrine granting only rare-find has a real effect on a run and no effect on
 * any number this analysis reports, so offering it would be offering a row that
 * can only ever read 0.00%.
 */
const SKILLING_METRIC_BUFF_TYPES = new Set([
    '/buff_types/efficiency',
    '/buff_types/action_speed',
    '/buff_types/wisdom',
]);

/**
 * Display name for a shrine, from its hrid.
 * @param {string} shrineHrid - e.g. '/guild_shrines/force'
 * @returns {string} e.g. 'Force'
 */
export function shrineName(shrineHrid) {
    const slug =
        String(shrineHrid || '')
            .split('/')
            .pop() || 'guild';
    return slug
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Cumulative price of stepping a shrine buff from one level to another.
 *
 * A shrine level is not bought in one transaction the way a chestpiece is — a
 * jump from 3 to 6 is three separate purchases, and the row is only honest if it
 * carries all three. Credits of the same kind are folded into one line so the
 * cost detail reads as a shopping list rather than a per-level ledger, and
 * tokens are summed alongside them without ever being priced.
 *
 * A level with no entry in the cost table contributes nothing rather than
 * aborting the total: the table is the game's own, and a hole in it means an
 * unbuyable level, which `guildBuffMaxLevel` has already cut the target down to.
 *
 * @param {Object} detail - Entry from guildBuffDetailMap
 * @param {number} fromLevel - Level the character is at now (exclusive)
 * @param {number} toLevel - Level being bought up to (inclusive)
 * @returns {{guildTokenCost: number, creditCosts: Array<{itemHrid: string, count: number}>}}
 */
function sumGuildShrineLevelCosts(detail, fromLevel, toLevel) {
    let guildTokenCost = 0;
    const creditTotals = new Map();

    for (let level = fromLevel + 1; level <= toLevel; level++) {
        const levelCost = detail?.levelCosts?.[String(level)] || {};
        guildTokenCost += Math.max(0, Math.floor(Number(levelCost.guildTokenCost) || 0));
        for (const entry of levelCost.creditCosts || []) {
            const count = Number(entry?.count) || 0;
            if (!entry?.itemHrid || count <= 0) continue;
            creditTotals.set(entry.itemHrid, (creditTotals.get(entry.itemHrid) || 0) + count);
        }
    }

    return {
        guildTokenCost,
        creditCosts: [...creditTotals.entries()].map(([itemHrid, count]) => ({ itemHrid, count })),
    };
}

/**
 * Generate level-up candidates for the guild shrine buffs.
 *
 * ## What the shrine level does and does not gate
 *
 * Two levels are in play and they are not the same number. The character buys
 * levels in a *buff*, and those are the levels these candidates step. The guild
 * builds levels in the *shrine*, and that caps how far members can buy. So a
 * candidate above the shrine's own level is still a real, correctly priced
 * purchase — it simply cannot be made until the guild upgrades the building,
 * which is not a cost this row can put a number on. Those rows are generated
 * anyway and carry `needsShrineLevel` so the detail can say so, rather than being
 * hidden as if the upgrade did not exist.
 *
 * A shrine level of 0 means no guild building data reached the client at all,
 * which is not the same as "the shrine is not built" — `shrineLevelKnown` keeps
 * those apart so nothing claims a cap that was never read.
 *
 * ## Target levels
 *
 * `targetLevel` is an absolute level, matching the House Lv control rather than
 * the ability +Levels one, because a shrine buff is a building level and reads
 * naturally as "get me to 6". Left at 0 every buff steps one level, which is
 * what every caller did before the option existed. A buff already at or past the
 * target is skipped rather than offered as a no-op, and a target above what the
 * cost table holds is clamped to the top of it — so one number can be typed once
 * and applied to five shrines sitting at five different levels.
 *
 * A `perBuffTargets` map takes precedence over the single number, and its three
 * cases are distinct: a positive level is bought up to, a **0 means "do not
 * calculate this shrine"**, and a negative value means "one level up from
 * wherever this buff is". A buff absent from the map is skipped, as the House
 * grid's absent rooms are. The grid sends 0 for a box the user zeroed and -1
 * for one left blank, so an empty box keeps its old "step it once" reading
 * while there is still a way to say "not this one" without closing the grid.
 *
 * ## Capping to what the guild actually built
 *
 * `capToGuildLevel` turns the shrine building level from an annotation into a
 * filter: a shrine the guild has not built at all is dropped, and one built to
 * Lv4 stops offering Lv5. Without it the tab recommended "Spirit Shrine Lv0 →
 * Lv1" to a guild with no Spirit Shrine, which is a purchase that cannot be
 * made. Off, the old dream-planning behaviour and its `needsShrineLevel`
 * annotation are unchanged.
 *
 * The cap is only applied when at least one shrine *anywhere in the buff map*
 * has a readable building level. A client that never received guild building
 * data reports 0 for every shrine, which is "unknown" rather than "unbuilt" —
 * capping on it would silently empty the table. The read is deliberately wider
 * than the combat/skilling scope being generated: a guild that has built only
 * skilling shrines reads 0 across every combat shrine, and taking that for
 * missing data handed the combat table back the "Lv0 → Lv1 in a shrine nobody
 * built" rows this flag exists to remove.
 *
 * Cost is cumulative over every level crossed; the benefit is measured at the
 * target, because that is the loadout the sim runs.
 *
 * @param {Object} playerDTO - Player DTO carrying `guildShrineLevels`
 * @param {Object} [options]
 * @param {boolean} [options.combat=true] - Combat shrines when true, skilling when false
 * @param {number} [options.targetLevel=0] - Absolute level to buy up to; 0/unset means one level up
 * @param {Object|null} [options.perBuffTargets=null] - buffHrid → target level; takes precedence
 *   over targetLevel. Positive buys up to that level, 0 skips the shrine, negative means one
 *   level up, and a buff absent from the map is skipped
 * @param {boolean} [options.capToGuildLevel=false] - Limit targets to the guild's own shrine
 *   building level, dropping shrines the guild has not built
 * @returns {Array<Object>} Candidates of type 'guild_shrine'
 */
export function generateGuildShrineCandidates(
    playerDTO,
    { combat = true, targetLevel = 0, perBuffTargets = null, capToGuildLevel = false } = {}
) {
    const detailMap = getGuildBuffDetailMap();
    const levels = playerDTO?.guildShrineLevels;
    // No level map means this DTO is somebody whose guild we know nothing about
    // (an imported player, a party member read off a profile) — not a guildless
    // character, so guessing zero would invent an upgrade path for them
    if (!levels || Object.keys(detailMap).length === 0) return [];

    const target = Math.max(0, Math.floor(Number(targetLevel) || 0));
    const explicit = perBuffTargets && typeof perBuffTargets === 'object' ? perBuffTargets : null;

    /**
     * The guild's own level in a shrine building, 0 when nothing was read.
     * @param {string} shrineHrid - Shrine building hrid
     * @returns {number} Building level
     */
    const buildingLevel = (shrineHrid) =>
        Math.max(0, Math.floor(Number(dataManager.getGuildBuildingLevel?.(shrineHrid)) || 0));

    const inScope = Object.entries(detailMap).filter(([, detail]) => Boolean(detail.isCombat) === combat);
    // See the cap note above: all-zero building levels across *every* shrine mean
    // the data never arrived, so there is nothing to cap against. Scoped to the
    // combat half it would also read that way for a guild that has only built
    // skilling shrines, which is data, not the absence of it
    const capping = capToGuildLevel && Object.values(detailMap).some((detail) => buildingLevel(detail.shrineHrid) > 0);

    const candidates = [];
    for (const [buffHrid, detail] of inScope) {
        if (!combat && !(detail.buffs || []).some((buff) => SKILLING_METRIC_BUFF_TYPES.has(buff?.typeHrid))) continue;

        const maxLevel = guildBuffMaxLevel(detail);
        const currentLevel = Math.max(0, Math.floor(Number(levels[buffHrid]) || 0));
        const asked = explicit ? Math.floor(Number(explicit[buffHrid]) || 0) : NaN;
        // A negative per-buff target is the grid's blank box: step this one once
        const wanted = explicit ? (asked < 0 ? currentLevel + 1 : asked) : target > 0 ? target : currentLevel + 1;
        const shrineLevel = buildingLevel(detail.shrineHrid);
        if (capping && shrineLevel <= 0) continue;
        const ceiling = capping ? Math.min(maxLevel, shrineLevel) : maxLevel;
        const upgradeLevel = Math.min(ceiling, wanted);
        if (maxLevel <= 0 || upgradeLevel <= currentLevel) continue;

        const { guildTokenCost, creditCosts } = sumGuildShrineLevelCosts(detail, currentLevel, upgradeLevel);
        const label = shrineName(detail.shrineHrid);

        candidates.push({
            type: 'guild_shrine',
            slot: `guild_shrine|${buffHrid}`,
            buffHrid,
            shrineHrid: detail.shrineHrid,
            isCombat: Boolean(detail.isCombat),
            currentLevel,
            upgradeLevel,
            levelsBought: upgradeLevel - currentLevel,
            maxLevel,
            buffTypes: (detail.buffs || []).map((buff) => buff?.typeHrid).filter(Boolean),
            guildTokenCost,
            creditCosts,
            shrineLevel,
            shrineLevelKnown: shrineLevel > 0,
            needsShrineLevel: shrineLevel > 0 && upgradeLevel > shrineLevel ? upgradeLevel : null,
            description: `${label} Shrine Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/** Drink slots a combat loadout has */
const DRINK_SLOTS = 3;

/**
 * Buff drinks worth simulating: a tier up in each family you already run, and
 * the best of each family you run none of.
 *
 * The advisor could weigh a chestpiece against an ability against a house room
 * and had nothing at all to say about the three coffee slots, which for most
 * characters are a larger and far cheaper lever than any of them. The food
 * optimizer does not cover this: it walks tiers *within an occupied slot* on a
 * survival criterion, and a coffee neither restores anything nor occupies a
 * food slot.
 *
 * Two shapes of candidate, and no more:
 *   - **A tier up** in a family already equipped, which competes with nothing.
 *   - **The best drink of a family you are not running**, into a free slot.
 * Every intermediate tier of a family you do not run is deliberately left out —
 * it would trade sims for rows nobody would buy, and the top tier answers the
 * question ("is this buff worth a slot") that the lower ones only blur.
 *
 * Cost is zero rather than a price: a coffee is drunk continuously, and the
 * sim's own consumable accounting already subtracts its hourly spend from
 * Profit/hr. Charging it again as an outlay would count it twice.
 *
 * @param {Object} playerDTO - Player DTO carrying `drinks`
 * @param {Object} gameData - Game data payload
 * @returns {Array<Object>} Candidates of type 'drink'
 */
export function generateDrinkCandidates(playerDTO, gameData) {
    const pools = buildBuffDrinkPools(gameData);
    if (pools.size === 0) return [];

    const drinks = Array.isArray(playerDTO?.drinks) ? playerDTO.drinks : [];
    const familyOf = (hrid) => {
        for (const [family, pool] of pools) {
            if (pool.some((entry) => entry.hrid === hrid)) return family;
        }
        return null;
    };

    const equipped = new Map(); // family → { index, entry }
    let freeSlot = -1;
    for (let index = 0; index < DRINK_SLOTS; index++) {
        const worn = drinks[index];
        if (!worn?.hrid) {
            if (freeSlot === -1) freeSlot = index;
            continue;
        }
        const family = familyOf(worn.hrid);
        if (!family) continue;
        equipped.set(family, { index, entry: pools.get(family).find((e) => e.hrid === worn.hrid) });
    }

    const candidates = [];
    const combatRelevant = (entry) => entry.buffTypes.some((type) => COMBAT_BUFF_TYPES.has(type));

    for (const [family, pool] of pools) {
        const usable = pool.filter(combatRelevant);
        if (usable.length === 0) continue;

        const worn = equipped.get(family);
        if (worn?.entry) {
            const better = usable.filter((entry) => entry.itemLevel > worn.entry.itemLevel);
            if (better.length === 0) continue;
            const next = better[0];
            candidates.push({
                type: 'drink',
                slot: `drink_${worn.index}`,
                drinkIndex: worn.index,
                currentHrid: worn.entry.hrid,
                upgradeHrid: next.hrid,
                upgradeLevel: 0,
                triggers: next.triggers,
                buffFamily: family,
                description: `${worn.entry.name} → ${next.name}`,
            });
            continue;
        }

        // Not running this family at all: only worth a row if there is a slot
        // free to run it in, and only the best of it
        if (freeSlot === -1) continue;
        const best = usable[usable.length - 1];
        candidates.push({
            type: 'drink',
            slot: `drink_${freeSlot}`,
            drinkIndex: freeSlot,
            currentHrid: null,
            upgradeHrid: best.hrid,
            upgradeLevel: 0,
            triggers: best.triggers,
            buffFamily: family,
            description: `Add ${best.name}`,
        });
    }

    return candidates;
}

/**
 * Put a drink candidate into its slot, in place.
 * @param {Object} dto - Player DTO (mutated)
 * @param {Object} candidate - Candidate of type 'drink'
 */
function applyDrinkToDTO(dto, candidate) {
    if (!Array.isArray(dto.drinks)) dto.drinks = [];
    while (dto.drinks.length < DRINK_SLOTS) dto.drinks.push(null);
    dto.drinks[candidate.drinkIndex] = { hrid: candidate.upgradeHrid, triggers: candidate.triggers || null };
}

/** Community buffs the combat sim reads, with what one more level is worth */
const COMMUNITY_BUFF_CANDIDATES = [
    { key: 'comExp', label: 'Community EXP buff' },
    { key: 'comDrop', label: 'Community combat drop buff' },
];

/** The game's own hrid for each, for reading the cowbell rate off the detail map */
const COMMUNITY_BUFF_HRIDS = {
    comExp: '/community_buff_types/experience',
    comDrop: '/community_buff_types/combat_drop_quantity',
};

/**
 * Highest level a community buff is offered at.
 *
 * 20, which is what the game says: a maxed buff reads "Level: 20 (Max)". It was
 * briefly raised to 30 on the theory that a live server sitting at the cap was
 * what emptied the Community set — but the cap was never the problem, the
 * missing at-ceiling case was. A capped buff has no next level, and returning
 * nothing for it left an analysis with only Community ticked showing nothing at
 * all; it now gets the other honest answer, the same buff simulated *off*. With
 * the ceiling back at its real value that at-ceiling row is the normal case on
 * a live server, and it is what makes the set worth ticking.
 *
 * The sim editor's community-buff inputs clamp to the same number, so the two
 * agree on what a level can be — an input that accepts 30 sims a state the game
 * cannot reach.
 */
const MAX_COMMUNITY_BUFF_LEVEL = 20;

/**
 * What a community buff is worth: one more level of it, or — once it is already
 * at the ceiling — the whole thing.
 *
 * Not a purchase, and the advisor says so by pricing it at unknown rather than
 * free — it lands in the unpriced group, where rows that cannot be ranked on
 * gold are visible and clearly separate from the ones that can. It is still
 * worth simulating: the levels are already editable in the sim's own DTO, the
 * question "how much is the drop buff actually doing for me" is asked
 * constantly, and answering it costs one sim per level rather than a guess.
 *
 * A buff at the ceiling has no next level, and returning nothing for it is what
 * left the set able to produce an empty analysis. It gets the other honest
 * answer instead: the same buff simulated *off*, so the row reads as what you
 * would lose rather than as an upgrade you cannot buy. On a live server, where
 * the buffs usually sit at Lv20 (Max), that is the row you get.
 *
 * A target level asks for several levels at once — "what would Lv3 → Lv8 be
 * worth" — which is one simulation instead of five and the question a player
 * with a donation plan is actually asking. It changes nothing about the cost,
 * which is not a per-level price to begin with (see `calculateUpgradeCost`): a
 * community buff's level is what the server's donated minutes add up to, and the
 * only real figure is the cowbells per minute it charges to keep running. A
 * target at or below the current level falls back to one level up rather than
 * generating nothing, and the ceiling row is untouched — there is no multi-level
 * version of "turn the buff off".
 *
 * @param {Object} communityBuffs - `{ mooPass, comExp, comDrop }` as configured
 * @param {number} [targetLevel=0] - Absolute level to buy up to; 0 means one level up
 * @returns {Array<Object>} Candidates of type 'community_buff', one per buff
 */
export function generateCommunityBuffCandidates(communityBuffs, targetLevel = 0) {
    const target = Math.min(MAX_COMMUNITY_BUFF_LEVEL, Math.max(0, Math.floor(Number(targetLevel) || 0)));
    const candidates = [];
    for (const { key, label } of COMMUNITY_BUFF_CANDIDATES) {
        const currentLevel = Math.max(0, Math.floor(Number(communityBuffs?.[key]) || 0));
        const atCeiling = currentLevel >= MAX_COMMUNITY_BUFF_LEVEL;
        const stepped = target > currentLevel ? target : currentLevel + 1;
        const upgradeLevel = atCeiling ? 0 : Math.min(MAX_COMMUNITY_BUFF_LEVEL, stepped);
        candidates.push({
            type: 'community_buff',
            slot: `community_buff|${key}`,
            buffKey: key,
            currentLevel,
            upgradeLevel,
            levelsBought: atCeiling ? 0 : upgradeLevel - currentLevel,
            // A ceiling row measures a loss, so it must never be read as a gain
            measuresLoss: atCeiling,
            description: atCeiling
                ? `${label} Lv${currentLevel} → off (what the buff is worth)`
                : `${label} Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/**
 * The community-buff configuration a candidate should be simulated under.
 * Every other candidate type simulates under exactly what was configured.
 * @param {Object} communityBuffs - As configured
 * @param {Object} candidate - The candidate being evaluated
 * @returns {Object} Community buffs for this run
 */
function applyCommunityBuffCandidate(communityBuffs, candidate) {
    if (candidate?.type !== 'community_buff') return communityBuffs;
    return { ...communityBuffs, [candidate.buffKey]: candidate.upgradeLevel };
}

/**
 * What each combat scroll is worth: turning on one the player is not carrying,
 * or — for one already active — the loss of turning it off, so the set never
 * produces an empty analysis. Every Labyrinth combat scroll is offered, since
 * each moves a combat number (damage, attack/cast speed, crit, drops, XP, rare
 * find).
 *
 * Like a community buff, a scroll is not priced as a purchase here: the ongoing
 * seal cost is a per-run figure the advisor does not model, so it lands in the
 * unpriced group where the measured value is visible without pretending to rank
 * on gold. The value still answers the question the player asks — "which scroll
 * is worth carrying" — at one sim per scroll.
 * @param {Object} playerDTO - The player's DTO, carrying `scrollBuffs`
 * @returns {Array<Object>} Candidates of type 'scroll', one per combat scroll
 */
export function generateScrollCandidates(playerDTO) {
    const active = new Set(Array.isArray(playerDTO?.scrollBuffs) ? playerDTO.scrollBuffs : []);
    const candidates = [];
    for (const buffTypeHrid of COMBAT_SCROLL_BUFF_TYPES) {
        const on = active.has(buffTypeHrid);
        const label = COMBAT_SCROLL_LABELS[buffTypeHrid] || buffTypeHrid;
        candidates.push({
            type: 'scroll',
            slot: `scroll|${buffTypeHrid}`,
            buffTypeHrid,
            // An inactive scroll is measured by turning it on; an active one by
            // turning it off, which reads as what the scroll is already worth.
            enable: !on,
            measuresLoss: on,
            description: on ? `${label} → off (what the scroll is worth)` : `Add ${label}`,
        });
    }
    return candidates;
}

/**
 * Put a scroll candidate's on/off state onto a DTO, in place. The combat engine
 * resolves `scrollBuffs` into buff objects, so writing the list is all it takes.
 * @param {Object} dto - Player DTO (mutated)
 * @param {Object} candidate - Candidate of type 'scroll'
 */
function applyScrollToDTO(dto, candidate) {
    const set = new Set(Array.isArray(dto.scrollBuffs) ? dto.scrollBuffs : []);
    if (candidate.enable) {
        set.add(candidate.buffTypeHrid);
    } else {
        set.delete(candidate.buffTypeHrid);
    }
    dto.scrollBuffs = [...set];
}

/**
 * Put a shrine candidate's level onto a DTO, in place.
 *
 * Both the level map and the resolved combat buff array are written: the map is
 * what the editor and the skilling metrics read, the array is what the combat
 * engine reads, and leaving either behind would sim the old shrine level.
 * @param {Object} dto - Player DTO (mutated)
 * @param {Object} candidate - Candidate of type 'guild_shrine'
 */
function applyGuildShrineToDTO(dto, candidate) {
    if (!dto.guildShrineLevels) dto.guildShrineLevels = {};
    dto.guildShrineLevels[candidate.buffHrid] = candidate.upgradeLevel;

    const detail = getGuildBuffDetailMap()[candidate.buffHrid];
    if (detail?.isCombat) {
        dto.guildCombatBuffs = applyGuildBuffLevel(dto.guildCombatBuffs, detail, candidate.upgradeLevel);
    }
}

/**
 * Itemised cost of a shrine level: credits and tokens, both at their gold value.
 *
 * Both halves are now priced. Credits are the cheapest tradeable items that
 * convert into them; tokens are those credits again, one exchange further back —
 * the guild shop trades tokens for credits, so a token is worth what the credits
 * it buys are worth (`guild-token-value.js`). The row is therefore ranked on the
 * **sum**, which is what the level actually costs, rather than on the credit half
 * with the tokens quietly treated as free.
 *
 * The two halves stay separately reported. `creditGold` is the credit-only total
 * the display has always shown, `tokenGold` is what the tokens were valued at,
 * and `tokenNote` says the valuation is a derived one — a chain of two
 * conversions, not a price anybody quoted. When no exchange rate and no credit
 * price can be found, `tokenGold` is null and the total falls back to the credit
 * half alone, exactly as before.
 *
 * @param {Object} candidate - Candidate of type 'guild_shrine'
 * @returns {Object} Same shape as `explainUpgradeCost`, plus `guild`
 */
function explainGuildShrineCost(candidate) {
    const { lines, total, unpriced } = priceGuildCreditCosts(candidate.creditCosts);

    const tokens = candidate.guildTokenCost || 0;
    const tokenValue = explainGuildTokenValue('ask');
    const tokenGold = describeGuildTokenGold(tokens, 'ask', { valuation: tokenValue });
    // An unpriced credit already made the total unknown; adding a token value to
    // null would turn "we do not know" into a confident understatement
    const net = total === null ? null : total + (tokenGold?.gold || 0);

    return {
        guild: {
            tokens,
            credits: lines,
            creditGold: total,
            tokenGold: tokenGold?.gold ?? null,
            goldPerToken: tokenValue.gold,
            tokenSource: tokenValue.source,
            tokenAssumed: tokenValue.assumed,
            tokenNote: tokenGold ? formatTokenNote(tokens, tokenGold) : null,
            rankedNote:
                tokenGold === null
                    ? 'Ranked on the credit half only — no guild shop exchange rate is known for tokens.'
                    : 'Ranked on credits plus tokens, the tokens priced through the guild shop exchange.',
            shrineLevel: candidate.shrineLevel,
            shrineLevelKnown: candidate.shrineLevelKnown,
            needsShrineLevel: candidate.needsShrineLevel,
            shrineName: shrineName(candidate.shrineHrid),
        },
        buys: [],
        credits: [],
        gross: net,
        credit: 0,
        net,
        unpriced,
        creditApplied: false,
        source: 'guild',
    };
}

/**
 * How a row says what its tokens were valued at.
 * @param {number} tokens - Token count
 * @param {{text: string}} tokenGold - From `describeGuildTokenGold`
 * @returns {string} Caption, e.g. "40 tokens ≈4.0K g via credit exchange"
 */
function formatTokenNote(tokens, tokenGold) {
    return `${tokens.toLocaleString()} token${tokens === 1 ? '' : 's'} ${tokenGold.text}`;
}

/**
 * Market cost of a house room upgrade: every level from the current one up to the
 * target, counting coins at face value and materials at their buy price.
 * @param {Object} candidate - House candidate
 * @param {Object} gameData - Game data payload
 * @returns {number|null} Total cost, or null when a level or material has no price
 */
function calculateHouseUpgradeCost(candidate, gameData) {
    const costsMap = gameData?.houseRoomDetailMap?.[candidate.roomHrid]?.upgradeCostsMap;
    if (!costsMap) return null;

    let total = 0;
    for (let level = candidate.currentLevel + 1; level <= candidate.upgradeLevel; level++) {
        const costs = costsMap[level] ?? costsMap[String(level)];
        if (!Array.isArray(costs) || costs.length === 0) return null;

        for (const entry of costs) {
            const count = Number(entry?.count) || 0;
            if (!entry?.itemHrid || count <= 0) continue;
            if (entry.itemHrid === '/items/coin') {
                total += count;
                continue;
            }
            const { price } = resolveItemPrice(entry.itemHrid, { side: 'buy' });
            if (!price || price <= 0) return null; // Unknown material cost must not rank as free
            total += price * count;
        }
    }
    return total > 0 ? total : null;
}

/**
 * What a house upgrade actually buys, itemised.
 *
 * A house level is not one purchase, it is a shopping list — coins the game
 * takes directly plus a handful of tradeable materials — and a multi-level jump
 * is several of those lists added together. Counts are summed across every level
 * in the jump so the answer is "how many do I need", not "how many per level",
 * and coins are left out because nobody buys coins on the marketplace.
 *
 * Sorted by what each line comes to at its buy price, biggest first, so the
 * caller can offer the one purchase that dominates the bill and name the rest.
 * A material with no known price still appears, with a null `total`, sorted last
 * — its count is real even when its price is not.
 *
 * @param {Object} candidate - Candidate of type 'house'
 * @param {Object} gameData - Game data payload
 * @returns {Array<{itemHrid: string, name: string, count: number, unitPrice: number|null, total: number|null}>}
 */
export function houseUpgradeMaterials(candidate, gameData) {
    const costsMap = gameData?.houseRoomDetailMap?.[candidate?.roomHrid]?.upgradeCostsMap;
    if (!costsMap) return [];

    const counts = new Map();
    for (let level = (candidate.currentLevel || 0) + 1; level <= (candidate.upgradeLevel || 0); level++) {
        const costs = costsMap[level] ?? costsMap[String(level)];
        if (!Array.isArray(costs)) continue;
        for (const entry of costs) {
            const count = Number(entry?.count) || 0;
            if (!entry?.itemHrid || count <= 0 || entry.itemHrid === '/items/coin') continue;
            counts.set(entry.itemHrid, (counts.get(entry.itemHrid) || 0) + count);
        }
    }

    const lines = [...counts.entries()].map(([itemHrid, count]) => {
        const { price } = resolveItemPrice(itemHrid, { side: 'buy' });
        const unitPrice = price > 0 ? price : null;
        return {
            itemHrid,
            name: gameData?.itemDetailMap?.[itemHrid]?.name || itemHrid.split('/').pop().replace(/_/g, ' '),
            count,
            unitPrice,
            total: unitPrice === null ? null : unitPrice * count,
        };
    });

    return lines.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
}

/**
 * Clamp candidates that acquire a refined item to at least +10.
 * Refined equipment is not normally worth holding below +10, so a refined
 * suggestion carrying a lower current enhancement level would be a poor
 * acquisition — instead of dropping it, suggest the refined item at +10
 * (cost and sim both use the clamped level). Capes (back slot) are exempt:
 * they are the one item type reasonably refined below +10. Enhancement
 * candidates on an already-equipped refined item are unaffected.
 * @param {Object} candidate - Candidate from generateCandidates() (mutated in place)
 */
function clampRefinedCandidateToMinLevel(candidate) {
    const MIN_REFINED_LEVEL = 10;
    const BACK_SLOT = '/equipment_types/back';
    let clamped = false;

    if (
        candidate.slot !== BACK_SLOT &&
        candidate.upgradeHrid !== candidate.currentHrid &&
        candidate.upgradeHrid?.endsWith('_refined') &&
        candidate.upgradeLevel < MIN_REFINED_LEVEL
    ) {
        candidate.upgradeLevel = MIN_REFINED_LEVEL;
        clamped = true;
    }

    if (candidate.addedSlots) {
        for (const [slot, added] of Object.entries(candidate.addedSlots)) {
            if (
                slot !== BACK_SLOT &&
                added?.hrid?.endsWith('_refined') &&
                (added.enhancementLevel || 0) < MIN_REFINED_LEVEL
            ) {
                added.enhancementLevel = MIN_REFINED_LEVEL;
                clamped = true;
            }
        }
    }

    if (!clamped) return;

    // Redrawn from the names, not patched at the tail. The old version replaced
    // a trailing "(+4)" with "(+10)" — and with the level now written against
    // each piece, there is no trailing token to replace, so the label would have
    // kept quoting the level the clamp had just moved. Anything without the
    // names to redraw from keeps the tail patch, which is still right for the
    // shape it was written for.
    if (candidate.swapLabel) {
        candidate.description = redescribeSwap(candidate);
        return;
    }

    const levels = candidate.addedSlots
        ? Object.values(candidate.addedSlots).map((item) => item.enhancementLevel || 0)
        : [candidate.upgradeLevel];
    const unique = [...new Set(levels)];
    const levelText = unique.length === 1 ? `+${unique[0]}` : levels.map((l) => `+${l}`).join('/');
    candidate.description = candidate.description.replace(/\(\+\d+\)$/, `(${levelText})`);
}

/** Path boots are obtainable only at +7, so a proposed swap to them is simmed and priced at +7. */
const PATH_BOOTS_BASE_HRIDS = new Set([
    '/items/pathbreaker_boots',
    '/items/pathfinder_boots',
    '/items/pathseeker_boots',
]);
const PATH_BOOTS_SIM_LEVEL = 7;
/**
 * …unless you already run +10 boots. Then you would enhance the path boots to +10
 * too, and simming them at +7 undersells them against the +10 you wear. At or
 * above this worn level the swap is simmed and priced at +10 instead.
 */
const PATH_BOOTS_HIGH_LEVEL = 10;

/** Whether an item hrid is a path boot (base or refined). */
function isPathBoot(hrid) {
    return Boolean(hrid) && PATH_BOOTS_BASE_HRIDS.has(hrid.replace(/_refined$/, ''));
}

/**
 * Pin a proposed swap to path boots at +7 — their only obtainable level — rather
 * than inheriting the worn piece's enhancement level (which the tier candidates
 * do). +7 whether the current piece is below it or between +7 and +10; but once
 * the worn boots are already +10 or higher the pin is +10 instead, because a
 * player at that level would enhance the path boots to +10 too and +7 would
 * undersell them. Runs after the refined +10 clamp, so it overrides that floor
 * down to +7 for a lower-level player and keeps it at +10 for a +10 one. Mirrors
 * clampRefinedCandidateToMinLevel's description redraw.
 * @param {Object} candidate - Candidate from generateCandidates() (mutated in place)
 */
export function applyPathBootsSimLevel(candidate) {
    const targetLevel =
        (Number(candidate.currentLevel) || 0) >= PATH_BOOTS_HIGH_LEVEL ? PATH_BOOTS_HIGH_LEVEL : PATH_BOOTS_SIM_LEVEL;
    let changed = false;

    if (
        candidate.upgradeHrid !== candidate.currentHrid &&
        isPathBoot(candidate.upgradeHrid) &&
        candidate.upgradeLevel !== targetLevel
    ) {
        candidate.upgradeLevel = targetLevel;
        changed = true;
    }

    if (candidate.addedSlots) {
        for (const added of Object.values(candidate.addedSlots)) {
            if (isPathBoot(added?.hrid) && (added.enhancementLevel || 0) !== targetLevel) {
                added.enhancementLevel = targetLevel;
                changed = true;
            }
        }
    }

    if (!changed) return;

    if (candidate.swapLabel) {
        candidate.description = redescribeSwap(candidate);
        return;
    }

    const levels = candidate.addedSlots
        ? Object.values(candidate.addedSlots).map((item) => item.enhancementLevel || 0)
        : [candidate.upgradeLevel];
    const unique = [...new Set(levels)];
    const levelText = unique.length === 1 ? `+${unique[0]}` : levels.map((l) => `+${l}`).join('/');
    candidate.description = candidate.description.replace(/\(\+\d+\)$/, `(${levelText})`);
}

/**
 * Offer the refined variant of any base path-boot swap. The crafting-chain walk
 * is single-hop, so from a non-path boot it reaches the base path boot but never
 * its refined form (refined is crafted from the base, two hops away). For each
 * base path-boot candidate we add a sibling targeting `<hrid>_refined`, so both
 * the base and refined boots appear as options. Level is left at the base
 * candidate's; the +7 pass that follows pins it, and the +10 refined floor
 * before it is overridden there. Mutates `candidates` in place.
 * @param {Array} candidates - Candidates from generateCandidates()
 * @param {Object} gameData - Game data (for the refined item's name/existence)
 */
export function addRefinedPathBootCandidates(candidates, gameData) {
    const additions = [];
    for (const candidate of candidates) {
        const baseHrid = candidate.upgradeHrid;
        if (!baseHrid || baseHrid.endsWith('_refined') || !PATH_BOOTS_BASE_HRIDS.has(baseHrid)) continue;

        const refinedHrid = `${baseHrid}_refined`;
        const refinedItem = gameData?.itemDetailMap?.[refinedHrid];
        if (!refinedItem) continue;

        // Don't double up if a refined swap for the same worn boot already exists.
        const already = candidates
            .concat(additions)
            .some((c) => c.upgradeHrid === refinedHrid && c.currentHrid === candidate.currentHrid);
        if (already) continue;

        const refinedName = refinedItem.name || refinedHrid.split('/').pop();
        const fromName = candidate.swapLabel?.from || candidate.currentHrid.split('/').pop();
        additions.push({
            slot: candidate.slot,
            currentHrid: candidate.currentHrid,
            currentLevel: candidate.currentLevel,
            upgradeHrid: refinedHrid,
            upgradeLevel: candidate.upgradeLevel,
            swapLabel: { from: fromName, to: [refinedName] },
            description: swapDescription(fromName, candidate.currentLevel, [refinedName], [candidate.upgradeLevel]),
            type: 'tier',
        });
    }
    candidates.push(...additions);
}

/**
 * Calculate the total net gold cost for a candidate upgrade.
 * Uses market prices as primary source (buy upgraded - sell current).
 * Falls back to enhancement cost estimate if market data unavailable.
 *
 * The figure is allowed to come out **negative**, and used to be floored at
 * zero. The floor was not a safety net: it turned every swap whose resale
 * covers its purchase into a free upgrade, and a free upgrade divides into an
 * infinitely good value on every ladder in the table. A swap that pays for
 * itself is a real and rather good thing, and saying so by its true size —
 * "this hands you 40M back" — ranks it above everything without pretending its
 * value per improvement is unbounded. `computeGoldPerImprovement` is where that
 * ordering is made explicit.
 *
 * @param {Object} candidate - Candidate from generateCandidates()
 * @param {Object} gameData - Game data
 * @param {boolean} [isSelf=true] - False for a player other than the live character, so an ability
 *   row is not priced off the live character's book bag. Must match what `explainUpgradeCost` was
 *   given for the same candidate: this is the figure the table ranks on and that one is the figure
 *   it prints, and a row whose Cost column disagrees with its own breakdown is worse than either.
 *   True by default because every caller but `runUpgradeAnalysis` is solo — labyrinth and lab
 * @returns {number|null} Net gold cost, negative when the resale exceeds the
 *   purchase, or null when some part of it has no known price
 */
export function calculateUpgradeCost(candidate, gameData, isSelf = true) {
    // Combat skill levels cost XP and time, not gold
    if (candidate.type === 'combat_level') {
        return null;
    }

    // A drink is not bought once, it is drunk forever. Its price per hour is
    // already subtracted from Profit/hr by the sim's own consumable accounting,
    // so charging it again as an outlay would count it twice.
    if (candidate.type === 'drink') {
        return 0;
    }

    // Nobody buys a community buff level; it is what the community happens to
    // have running. Unknown rather than free, so it lands in the unpriced group
    // instead of topping a value ladder it does not belong on.
    if (candidate.type === 'community_buff') {
        return null;
    }

    // A scroll is a per-run seal cost the advisor does not model, so like a
    // community buff it is priced at unknown and shown for its measured value
    // rather than ranked on gold.
    if (candidate.type === 'scroll') {
        return null;
    }

    if (candidate.type === 'house') {
        return calculateHouseUpgradeCost(candidate, gameData);
    }

    // Credits *and* tokens: the credits at the cheapest items that convert into
    // them, the tokens at the credits the guild shop exchange trades them for.
    // A token with no known exchange rate still counts for nothing
    if (candidate.type === 'guild_shrine') {
        return explainGuildShrineCost(candidate).net;
    }

    // Books, at the market price of the book — and null rather than 0 when there
    // is no listing, so an ability nobody is selling is not ranked as free
    if (ABILITY_CANDIDATE_TYPES.has(candidate.type)) {
        return explainAbilityCandidateCost(candidate, gameData, isSelf).net;
    }

    if (candidate.type === 'cross_slot') {
        let buyCost = 0;
        for (const item of Object.values(candidate.addedSlots)) {
            const { price } = resolveUpgradeBuyPrice(item.hrid, item.enhancementLevel, gameData);
            if (price === null) {
                return null; // Unknown acquisition cost — don't rank as free
            }
            buyCost += price;
        }
        return buyCost - resaleCredit(candidate);
    }

    if (candidate.type === 'enhancement') {
        // Primary: market price delta (buy at target level - sell at current level)
        // Only use if BOTH levels have actual market listings
        const upgradedMarket = getItemPrices(candidate.currentHrid, candidate.upgradeLevel);
        const currentMarket = getItemPrices(candidate.currentHrid, candidate.currentLevel);

        if (upgradedMarket?.ask > 0 && currentMarket?.bid > 0) {
            return upgradedMarket.ask - currentMarket.bid;
        }

        // Fallback: enhancement cost estimate with protection
        return calculateEnhancementCost(
            candidate.currentHrid,
            candidate.currentLevel,
            candidate.upgradeLevel,
            gameData
        );
    }

    // Tier upgrade: buy new item at target enhancement - sell current item
    const { price: buyPrice } = resolveUpgradeBuyPrice(candidate.upgradeHrid, candidate.upgradeLevel, gameData);
    if (buyPrice === null) {
        return null; // Unknown acquisition cost — don't rank as free
    }

    return buyPrice - resaleCredit(candidate);
}

/**
 * The gear a candidate is allowed to sell, and what it fetches.
 *
 * `removedItems` is the authority when a candidate carries one — it is how a
 * multi-slot swap says it empties two slots, and how a swap that *keeps* what it
 * replaces says so, by carrying an empty list alongside `keptItems`. Only when
 * there is no list at all does the primary item stand in for it, which is the
 * ordinary one-for-one trade.
 *
 * Shared by the cross-slot and tier branches so the two cannot drift: they used
 * to answer the keep-the-old-piece question differently, and a candidate whose
 * price depends on which branch costed it is a candidate nobody can check.
 *
 * @param {Object} candidate - Upgrade candidate
 * @returns {number} Total resale credit, 0 when nothing is being sold
 */
function resaleCredit(candidate) {
    const removed =
        candidate.removedItems ||
        (candidate.currentHrid ? [{ hrid: candidate.currentHrid, enhancementLevel: candidate.currentLevel }] : []);

    let credit = 0;
    for (const item of removed) {
        if (!item?.hrid) continue;
        credit +=
            resolveItemPrice(item.hrid, { side: 'sell', enhancementLevel: item.enhancementLevel || 0 }).price ?? 0;
    }
    return credit;
}

/**
 * Where a priced figure came from.
 *
 * Three different things end up in the same Cost column, and they are not the
 * same kind of number. A market delta is what the order book says today; a
 * simulated enhance path is an expectation over a random process nobody has
 * run yet; a production cost is what the materials would come to if you made
 * the thing yourself. Ranking them against each other is still the right thing
 * to do — they are all gold — but a reader who cannot tell which is which
 * cannot tell how much to trust a row, so every priced row carries its basis.
 */
export const COST_SOURCES = {
    market: { label: 'mkt', title: 'Market listings on both sides — what the order book says today.' },
    sim: {
        label: 'sim',
        title:
            'No listing at this enhancement level, so the price is the base item plus a simulated ' +
            'enhancement path — an expected cost over a random process, not a quote.',
    },
    craft: {
        label: 'craft',
        title: 'No market listing, so the price is what the materials to make it come to.',
    },
    books: { label: 'books', title: 'Ability books at their market price.' },
    guild: { label: 'guild', title: 'Guild credits at the gold value of the cheapest items that make them.' },
    ongoing: {
        label: 'per-hr',
        title: 'No purchase price — this is an ongoing per-hour spend, already netted out of Profit/hr.',
    },
};

/** Cost bases in descending order of how much a reader should trust them */
const COST_SOURCE_RANK = ['market', 'books', 'guild', 'craft', 'sim', 'ongoing'];

/**
 * The weakest basis among several, since a total is only as solid as its
 * shakiest part.
 * @param {Array<string|null>} sources - Per-item bases
 * @returns {string|null} The least trustworthy one present
 */
function weakestCostSource(sources) {
    let worst = null;
    for (const source of sources) {
        if (!source) continue;
        if (worst === null || COST_SOURCE_RANK.indexOf(source) > COST_SOURCE_RANK.indexOf(worst)) worst = source;
    }
    return worst;
}

/**
 * Resolve the buy price of an item at a given enhancement level.
 * When no price exists at that level (common for refined gear, which rarely
 * has listings above +0), fall back to the base item price plus the expected
 * enhancement cost to reach the level. Returns a null price when nothing is
 * known at all so callers can surface "unknown" instead of a free upgrade.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Target enhancement level
 * @param {Object} gameData - Game data payload
 * @returns {{price: number|null, source: string|null, enhanceSource: Object|undefined}} Buy price in
 *   gold, its basis, and — when an enhancement sweep produced it — whose enhancing stats it ran on
 */
function resolveUpgradeBuyPrice(itemHrid, enhancementLevel, gameData) {
    // Tester shop first, when it is a price source: the shop copy at its
    // level, or that copy mirrored up — see tester-shop.js
    if (testerShopEnabled()) {
        const tester = testerGearPrice(itemHrid, enhancementLevel, { itemDetailMap: gameData?.itemDetailMap });
        if (tester) {
            return { price: tester.price, source: tester.route === 'mirror' ? 'tester shop + mirrors' : 'tester shop' };
        }
    }

    if (enhancementLevel > 0) {
        // Same method as enhancement candidates: use the market only when the
        // target level has an actual listing. resolveItemPrice cannot be used
        // here — its production-cost fallback ignores the enhancement level and
        // would price a +10 item as a +0 craft.
        const market = getItemPrices(itemHrid, enhancementLevel);
        if (market?.ask > 0) {
            return { price: market.ask, source: 'market' };
        }

        // No listing at the target level: base item price + enhancement cost
        const basePrice = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price ?? 0;
        const enhanceCost = calculateEnhancementCost(itemHrid, 0, enhancementLevel, gameData);
        // Unknown enhancement cost must stay unknown — pricing the item as a
        // bare +0 craft would understate an enhanced buy by the whole enhance path
        if (enhanceCost == null) {
            return { price: null, source: null };
        }
        const total = Math.max(0, basePrice) + Math.max(0, enhanceCost);
        // The sweep is half this figure, so whose bench it ran on is part of
        // what the row is quoting — see `enhancementSweepParams`
        return total > 0
            ? {
                  price: total,
                  source: 'sim',
                  enhanceSource: describeEnhancementSource(enhancementSweepParams(itemHrid)),
              }
            : { price: null, source: null };
    }

    const direct = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price;
    if (!(direct > 0)) return { price: null, source: null };
    // A listing beats the production-cost fallback inside resolveItemPrice, so
    // an ask at +0 is the market speaking and anything else is a craft estimate
    const listed = getItemPrices(itemHrid, 0);
    return { price: direct, source: listed?.ask > 0 ? 'market' : 'craft' };
}

/**
 * Resolve the candidate sets to generate. The Upgrade tab passes a list of
 * checked sets; older single-mode callers pass one mode string ('combined' being
 * shorthand for equipment plus ability levels).
 * @param {string[]|undefined} upgradeModes - Checked candidate sets
 * @param {string|undefined} upgradeMode - Legacy single mode
 * @returns {string[]} Modes to generate candidates for
 */
export function resolveCandidateModes(upgradeModes, upgradeMode) {
    if (Array.isArray(upgradeModes) && upgradeModes.length > 0) {
        // 'food' is a separate optimizer, not a ranked candidate set
        return [...new Set(upgradeModes.filter((mode) => mode !== 'food'))];
    }
    if (upgradeMode === 'combined') return ['equipment', 'ability_level'];
    return upgradeMode ? [upgradeMode] : ['equipment'];
}

/** Candidate types paid for in ability books rather than at the equipment market */
const ABILITY_CANDIDATE_TYPES = new Set(['ability_level', 'ability_swap']);

/**
 * The book you already have of an ability, if you have one.
 *
 * `characterAbilities` is every book the character has read, equipped or not,
 * with the level and the experience on it — which is the same list the sim
 * itself runs abilities at, so a swap costed from it is costed from the levels
 * the sim is about to simulate. The equipped list (`combatUnit.combatAbilities`)
 * would not do: the whole point of a swap candidate is an ability that is *not*
 * equipped, and the one you have sat in the book bag is exactly the case.
 *
 * `characterAbilities` is the live user's own book bag — there is no such list
 * for an imported profile or a party member read off a shared card, only their
 * equipped abilities. Pricing a stranger's row from what *you* happen to own
 * would price a Fireball swap as "already at Lv40" because you read Fireball,
 * not because they did — `isSelf` keeps this read to rows about the character
 * whose live data this actually is.
 *
 * @param {string} abilityHrid - The ability being swapped in
 * @param {boolean} isSelf - False for any player other than the live character
 * @returns {{level: number, experience: number}|null} Null when it is unlearned or not self
 */
function ownedAbility(abilityHrid, isSelf) {
    if (!isSelf) return null;
    const owned = (dataManager.characterData?.characterAbilities || []).find(
        (entry) => entry?.abilityHrid === abilityHrid
    );
    if (!owned) return null;

    return { level: Math.floor(Number(owned.level) || 0), experience: Number(owned.experience) || 0 };
}

/**
 * Itemised cost for an ability candidate: the books, and nothing coming back.
 *
 * Two things the equipment breakdown gets wrong about an ability. It prices the
 * upgrade as a market listing for the ability at its level — which does not
 * exist, so a perfectly ordinary "Fireball 48 → 53" reads as "no price found" —
 * and it credits the resale of the level you are leaving, which cannot happen:
 * an ability is not an item and cannot be sold back.
 *
 * A swap is priced from wherever the book you would swap in actually is. Pricing
 * every swap from zero was right for an ability you have never read and badly
 * wrong for one sitting at Lv40 in the book bag — it quoted the whole path
 * again, which put swaps you could make this afternoon below upgrades costing
 * ten times as much. Fresh-book pricing is now what it says it is: the cost of
 * an ability you do not own.
 *
 * @param {Object} candidate - Candidate of type `ability_level` or `ability_swap`
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - False when the candidate belongs to a player other than the live
 *   character. Defaults true rather than being required: an omitted argument reading as "not self"
 *   silently reprices every owned book of the live character's as a fresh path, which is how the
 *   ranking path lost its book bag once already
 * @returns {Object} Same shape as `explainUpgradeCost`, plus `books`
 */
function explainAbilityCandidateCost(candidate, gameData, isSelf = true) {
    const swap = candidate.type === 'ability_swap';
    const hrid = swap ? candidate.upgradeHrid : candidate.currentHrid || candidate.upgradeHrid;
    const owned = ownedAbility(hrid, isSelf);

    // A level-up starts from where the equipped ability is; a swap starts from
    // where the book you own is, and from nothing when you own none
    const fromLevel = swap ? owned?.level || 0 : candidate.currentLevel || 0;
    const levelFloorXp = (gameData?.levelExperienceTable || [])[fromLevel] || 0;
    // The experience on an owned book is a position within the level, not the
    // floor of it — the books already read count towards the next one. That is
    // as true of a level-up as of a swap: an equipped ability part-way into its
    // level priced from the floor re-buys the books already read, which
    // overstated every ability row by up to a level's worth of books. The floor
    // is the fallback — for a book with no experience recorded, and for a live
    // book that disagrees with the candidate about what level it is on
    const ownedXp = owned && owned.level === fromLevel ? Number(owned.experience) || 0 : 0;
    const currentXp = Math.max(ownedXp, levelFloorXp);

    const priced = explainAbilityLevelUpCost(hrid, fromLevel, currentXp, candidate.upgradeLevel || 0);
    // A book already at or past the target buys nothing rather than a negative
    // number of books, which is what the level arithmetic hands back for it.
    // Zero books is free whether or not the market lists the book, so this is
    // decided on the count and not on the price — reading it off the price left
    // an unlisted book you already own showing as unpriceable
    const nothingToBuy = (priced.books ?? 0) <= 0;
    const books = nothingToBuy ? { ...priced, books: 0, total: 0 } : priced;

    return {
        books,
        // The one free row that is genuinely free: an ability sitting in the book
        // bag at the level the row wants, which costs nothing because it is not a
        // purchase at all — it is a slot that is empty. Without saying so the row
        // shows a bare 0 and the `from LvN` chip explains a cost never paid.
        ownedNotSlotted: swap && Boolean(owned) && nothingToBuy,
        // A swap of an ability you do not own prices a book learned and levelled
        // from nothing. That is the single biggest thing about such a row and it
        // used to live only in a tab tooltip, where a row claiming a 900M cost
        // gave no hint that the 900M assumes you own none of it
        freshBook: swap && !owned,
        // What an owned swap was costed from, so the row can say so rather than
        // leaving a suspiciously cheap swap unexplained
        ownedFromLevel: swap && owned ? fromLevel : null,
        buys: [],
        // Never anything here: levels spent on an ability stay spent
        credits: [],
        gross: books.total,
        credit: 0,
        net: books.total,
        unpriced: books.total === null ? [books.bookName] : [],
        creditApplied: false,
        source: 'books',
    };
}

/**
 * Itemised cost for a candidate: what gets bought, at what price, and what the
 * gear it replaces would fetch. Purely for display — the ranking still uses
 * calculateUpgradeCost — so a row showing a blank cost can say which item has no
 * price instead of leaving the reader guessing.
 * @param {Object} candidate - Upgrade candidate
 * @param {Object} gameData - Game data payload
 * @param {boolean} [isSelf=true] - False when pricing a row for a player other than the live
 *   character (an imported profile, a party member) — keeps the ability-book breakdown from
 *   reading the live character's own book bag as if it belonged to them
 * @returns {Object} { buys, credits, gross, credit, net, unpriced, source, enhanceSource }
 */
export function explainUpgradeCost(candidate, gameData, isSelf = true) {
    if (ABILITY_CANDIDATE_TYPES.has(candidate.type)) return explainAbilityCandidateCost(candidate, gameData, isSelf);
    if (candidate.type === 'guild_shrine') return explainGuildShrineCost(candidate);
    if (candidate.type === 'drink') {
        return {
            buys: [],
            credits: [],
            gross: 0,
            credit: 0,
            net: 0,
            unpriced: [],
            creditApplied: false,
            source: 'ongoing',
        };
    }
    if (candidate.type === 'house') {
        // Coins at face value plus materials at their buy price — a build cost,
        // not a listing for the room
        const total = calculateHouseUpgradeCost(candidate, gameData);
        return {
            buys: [],
            credits: [],
            gross: total,
            credit: 0,
            net: total,
            unpriced: [],
            creditApplied: false,
            source: total == null ? null : 'craft',
        };
    }

    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid?.split('/').pop().replace(/_/g, ' ') || '?';

    const buys = [];
    if (candidate.addedSlots) {
        for (const item of Object.values(candidate.addedSlots)) {
            const { price, source, enhanceSource } = resolveUpgradeBuyPrice(
                item.hrid,
                item.enhancementLevel || 0,
                gameData
            );
            buys.push({
                hrid: item.hrid,
                name: nameOf(item.hrid),
                enhancementLevel: item.enhancementLevel || 0,
                price,
                source,
                enhanceSource,
            });
        }
    } else if (candidate.upgradeHrid) {
        const { price, source, enhanceSource } = resolveUpgradeBuyPrice(
            candidate.upgradeHrid,
            candidate.upgradeLevel || 0,
            gameData
        );
        buys.push({
            hrid: candidate.upgradeHrid,
            name: nameOf(candidate.upgradeHrid),
            enhancementLevel: candidate.upgradeLevel || 0,
            price,
            source,
            enhanceSource,
        });
    }

    const removed =
        candidate.removedItems ||
        (candidate.currentHrid ? [{ hrid: candidate.currentHrid, enhancementLevel: candidate.currentLevel || 0 }] : []);
    const credits = removed.map((item) => ({
        hrid: item.hrid,
        name: nameOf(item.hrid),
        enhancementLevel: item.enhancementLevel || 0,
        price: resolveItemPrice(item.hrid, { side: 'sell', enhancementLevel: item.enhancementLevel || 0 }).price || 0,
    }));

    const unpriced = buys.filter((buy) => buy.price === null).map((buy) => buy.name);
    const gross = unpriced.length > 0 ? null : buys.reduce((sum, buy) => sum + buy.price, 0);
    const credit = credits.reduce((sum, entry) => sum + entry.price, 0);

    // An enhancement candidate buys nothing new: it is a market delta between
    // two levels of one item where both are listed, and the enhance path
    // otherwise. Nothing above sees that, so name it here
    let source = weakestCostSource(buys.map((buy) => buy.source));
    // Whose enhancing stats a sweep behind this figure ran on. A total is as
    // shaky as its shakiest part, so the first sweep found stands for the row
    let enhanceSource = buys.find((buy) => buy.enhanceSource)?.enhanceSource || null;
    if (candidate.type === 'enhancement') {
        const upgraded = getItemPrices(candidate.currentHrid, candidate.upgradeLevel);
        const current = getItemPrices(candidate.currentHrid, candidate.currentLevel);
        source = upgraded?.ask > 0 && current?.bid > 0 ? 'market' : 'sim';
        // A market delta between two listed levels runs no sweep at all; the
        // fallback path in `calculateUpgradeCost` is nothing but one
        enhanceSource =
            source === 'sim' ? describeEnhancementSource(enhancementSweepParams(candidate.currentHrid)) : null;
    }

    return {
        buys,
        credits,
        gross,
        credit,
        enhanceSource,
        // Not floored at zero: see calculateUpgradeCost. A swap whose resale
        // beats its purchase hands gold back, and the breakdown says so
        net: gross === null ? null : gross - credit,
        unpriced,
        // Set by the lab analysis when replaced gear is kept rather than sold
        creditApplied: credits.length > 0,
        source: unpriced.length > 0 ? null : source,
    };
}

/**
 * Run the full upgrade analysis: baseline sim + one sim per candidate.
 * @param {Object} params - { playerDTOs, playerIndex, selfHrid, zoneHrid, difficultyTier, hours, communityBuffs,
 *   upgradeModes, upgradeMode, abilityLevelType, abilityTargetLevel, skipBackSlot, combatLevelTargets, charmTier,
 *   charmEnhancement, houseTargetLevel, houseTargets, guildShrineTargetLevel, guildShrineTargets,
 *   guildShrineCapToGuild, optimizeFood, auraSwapsOnly }
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results: [{candidate, cost, metrics, deltas, goldPer}], food,
 *   context: { gameData, playerDTOs, playerIndex, playerHrid, zoneHrid, difficultyTier, hours, communityBuffs,
 *   seed, precision, baselineResult, baseline } } — `context` is what `confirmUpgradeBudgetPlan` needs to
 *   re-run a chosen set of picks under the same conditions this analysis ran under
 */
export async function runUpgradeAnalysis(params, onProgress, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        selfHrid = null,
        zoneHrid,
        difficultyTier,
        hours,
        precision = null,
        communityBuffs,
        upgradeModes,
        upgradeMode,
        abilityLevelType,
        abilityTargetLevel,
        skipBackSlot,
        combatLevelTargets,
        abilityTargets,
        charmTier,
        charmEnhancement = null,
        houseTargetLevel = 0,
        houseTargets = null,
        guildShrineTargetLevel = 0,
        guildShrineTargets = null,
        guildShrineCapToGuild = false,
        communityBuffTargetLevel = 0,
        optimizeFood = false,
        auraSwapsOnly = false,
        extraCandidates = [],
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const playerDTO = playerDTOs[playerIndex];
    const playerHrid = playerDTO.hrid;
    // Whether the row being priced is the live character. An imported profile or
    // a party member read off a shared card carries `selfHrid: null` (or a
    // `hrid` that never matches it) precisely so a book-bag or inventory read
    // below does not mistake the live character's own data for theirs.
    const isSelf = selfHrid != null && playerHrid === selfHrid;

    // One seed for the whole analysis: baseline and every candidate draw the same
    // random numbers, so a delta reflects the upgrade rather than the gap between
    // two independent samples. A fresh seed per analysis keeps re-runs resampling.
    const simSeed = analysisSeed();

    const candidateModes = resolveCandidateModes(upgradeModes, upgradeMode);
    const candidates = candidateModes.flatMap((mode) =>
        generateCandidates(
            playerDTO,
            gameData,
            mode,
            abilityTargetLevel,
            abilityLevelType,
            skipBackSlot,
            combatLevelTargets,
            abilityTargets,
            houseTargetLevel,
            houseTargets,
            communityBuffs,
            guildShrineTargetLevel,
            { auraSwapsOnly, communityBuffTargetLevel, guildShrineTargets, guildShrineCapToGuild, isSelf }
        )
    );
    // Candidates the caller asked for by name, alongside whatever the mode
    // generated. This is how one specific thing — "what would the Critical Aura
    // do for me" — gets ranked against the upgrades you were already weighing,
    // rather than becoming a change applied to all of them.
    const already = new Set(candidates.map(candidateAssignmentKey));
    for (const candidate of extraCandidates) {
        const key = candidateAssignmentKey(candidate);
        if (already.has(key)) continue;
        already.add(key);
        candidates.push(candidate);
    }

    const candidatesWithCost = candidates.map((c) => {
        // The breakdown already knows which side of the market — or which
        // estimate — each figure came from. Reading it here is what lets a row
        // say so, rather than three different kinds of number sharing a column
        let costDetail = null;
        try {
            costDetail = explainUpgradeCost(c, gameData, isSelf);
        } catch (error) {
            console.error('[UpgradeAdvisor] Reading the cost basis failed:', error);
        }
        return {
            ...c,
            cost: calculateUpgradeCost(c, gameData, isSelf),
            costSource: costDetail?.source ?? null,
            costDetail,
        };
    });

    const combatLevelCount = candidatesWithCost.filter((c) => c.type === 'combat_level').length;
    const foodSimCount = optimizeFood ? estimateFoodSimCount(gameData, playerDTO.food) : 0;
    // +1 baseline, + XP-rate sims for combat levels (and one more each for the
    // primary skill's levels along the way), + the food search
    const total = candidatesWithCost.length + combatLevelCount * 2 + foodSimCount + 1;
    let current = 0;

    // Run baseline sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    // One worker, like every candidate below. The shared seed only cancels
    // sampling noise while both runs draw the same stream in the same order,
    // and the chunking decides the streams: a baseline split four ways is four
    // streams, a candidate unsplit is one, and the two are independent samples
    // however carefully the seed is shared. That mismatch put an identical
    // phantom delta on every combat-inert candidate — a skilling house room
    // "improving" DPS by 0.06%.
    // isTaskFight stays off for the baseline and for every candidate below. A
    // ranking is a generic zone fight, and switching the task bonus on would
    // credit task gear with damage it only deals while that monster is your
    // task — see the caveat attached in generateCandidates().
    const baselineResult = await runSimulation(
        {
            gameData,
            playerDTOs,
            zoneHrid,
            difficultyTier,
            hours,
            communityBuffs,
            seed: simSeed,
            isTaskFight: false,
            // The baseline's fight count is what every candidate is paired to,
            // so precision/max-fights on the baseline set the whole run's sample
            // size. Null falls back to the plain time budget (`hours`).
            ...(precision ? { precision } : {}),
        },
        null,
        { workers: 1 }
    );
    current++;

    if (abortSignal?.()) return { baseline: null, results: [] };

    onProgress?.({ current, total, description: 'Baseline complete' });

    // Calculate baseline metrics
    const baselineMetrics = computeMetrics(baselineResult, gameData, playerHrid, hours);

    // Run sim for each candidate: one worker each, several candidates at a time.
    //
    // The other way round — one candidate at a time with its hours split across
    // the workers — sounds equivalent, since either way the same total hours get
    // simulated on the same cores. It is not. Splitting means every candidate
    // pays the worker startup and the game-data clone once per chunk instead of
    // once, and it cannot start the next candidate until its own slowest chunk
    // lands. Measured on four workers: 3.3× slower for a 100-hour candidate,
    // 1.14× slower even at five seconds of work apiece, and never faster.
    //
    // Fanning out is still right for a *single* run, where there is no queue to
    // fill — a lone 600-hour sim is about twice as quick split four ways.
    const lanes = Math.max(1, Math.min(analysisConcurrency(), candidatesWithCost.length));
    const progress = { current };

    const evaluateCandidate = async (candidate) => {
        if (abortSignal?.()) return null;

        // Clone playerDTOs and apply candidate upgrade
        const modifiedDTOs = JSON.parse(JSON.stringify(playerDTOs));

        if (candidate.slot.startsWith('ability_')) {
            // Ability upgrade/swap
            const slotIdx = parseInt(candidate.slot.split('_')[1]);
            const existingAbility = modifiedDTOs[playerIndex].abilities[slotIdx];
            if (existingAbility?.hrid === candidate.upgradeHrid) {
                // Leveling the equipped ability: keep its configured combat
                // triggers — wiping them made every level-up sim against the
                // baseline's tuned triggers and read as a regression
                modifiedDTOs[playerIndex].abilities[slotIdx] = {
                    ...existingAbility,
                    level: candidate.upgradeLevel,
                };
            } else {
                modifiedDTOs[playerIndex].abilities[slotIdx] = {
                    hrid: candidate.upgradeHrid,
                    level: candidate.upgradeLevel,
                    triggers: null,
                };
            }
        } else if (candidate.type === 'combat_level') {
            // Combat skill level boost (simulated charm)
            modifiedDTOs[playerIndex][candidate.skillKey] = candidate.upgradeLevel;
        } else if (candidate.type === 'house') {
            // House room level (a room at level 0 isn't in the map yet)
            if (!modifiedDTOs[playerIndex].houseRooms) modifiedDTOs[playerIndex].houseRooms = {};
            modifiedDTOs[playerIndex].houseRooms[candidate.roomHrid] = candidate.upgradeLevel;
        } else if (candidate.type === 'guild_shrine') {
            // One more level in a guild shrine buff, rebuilt at its new value
            applyGuildShrineToDTO(modifiedDTOs[playerIndex], candidate);
        } else if (candidate.type === 'drink') {
            // A coffee into its slot, with the item's own default triggers —
            // the same thing the game hands you when you equip one
            applyDrinkToDTO(modifiedDTOs[playerIndex], candidate);
        } else if (candidate.type === 'community_buff') {
            // Nothing on the DTO: community buffs are an argument to the sim
        } else if (candidate.type === 'scroll') {
            // Flip a scroll on or off; the engine resolves scrollBuffs to buffs
            applyScrollToDTO(modifiedDTOs[playerIndex], candidate);
        } else if (candidate.type === 'cross_slot') {
            // Weapon-configuration swap (two_hand ↔ main_hand + off_hand):
            // clear the replaced slots and equip every added item
            for (const slot of candidate.clearedSlots) {
                modifiedDTOs[playerIndex].equipment[slot] = null;
            }
            for (const [slot, item] of Object.entries(candidate.addedSlots)) {
                modifiedDTOs[playerIndex].equipment[slot] = item;
            }
        } else {
            // Equipment upgrade
            modifiedDTOs[playerIndex].equipment[candidate.slot] = {
                hrid: candidate.upgradeHrid,
                enhancementLevel: candidate.upgradeLevel,
            };
        }

        const simResult = await runSimulation(
            {
                gameData,
                playerDTOs: modifiedDTOs,
                zoneHrid,
                difficultyTier,
                hours,
                communityBuffs: applyCommunityBuffCandidate(communityBuffs, candidate),
                seed: simSeed,
                isTaskFight: false,
            },
            null,
            // One worker each: the queue is what keeps the cores busy here.
            // Preempting would have each candidate cancel the one before it.
            { preempt: false, workers: 1 }
        );

        if (abortSignal?.()) return null;

        const metrics = computeMetrics(simResult, gameData, playerHrid, hours);
        const deltas = computeDeltas(baselineMetrics, metrics);
        const goldPer = computeGoldPerImprovement(candidate.cost, deltas);

        const economics = computeEconomics(candidate.cost, baselineMetrics, metrics);
        const noise = rateDeltaNoisePct(baselineResult, simResult, playerHrid);
        const significantBy = significantDeltas(deltas, noise);

        const row = {
            candidate,
            cost: candidate.cost,
            costSource: candidate.costSource ?? null,
            costDetail: candidate.costDetail ?? null,
            metrics,
            deltas,
            goldPer,
            economics,
            noise,
            significantBy,
            // The single flag `planWithinBudget` reads. A row is worth planning
            // around if any of the three axes a budget can shop for cleared its
            // error bar; the planner narrows this to the axis actually chosen
            significant: Boolean(significantBy.dps || significantBy.profit || significantBy.xp),
        };
        if (candidate.type === 'combat_level') {
            // Leveling posture: XP rates with the matching charm for this skill
            // equipped (current levels), since that's what you'd wear to grind it
            onProgress?.({ current: progress.current, total, description: `XP rate: ${candidate.description}` });
            const xpDTOs = JSON.parse(JSON.stringify(playerDTOs));
            const currentCharm = xpDTOs[playerIndex].equipment[CHARM_SLOT] || null;
            const matchingCharm = findMatchingCharmForSkill(
                currentCharm,
                candidate.skillKey,
                gameData,
                charmTier,
                charmEnhancement
            );
            xpDTOs[playerIndex].equipment[CHARM_SLOT] = matchingCharm;
            const xpSimResult = await runSimulation(
                { gameData, playerDTOs: xpDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
                null,
                { preempt: false, workers: 1 }
            );
            progress.current++;
            // How much faster the whole zone goes once the levels are in. The
            // candidate's own sim already ran at the boosted levels and the
            // baseline at the current ones, so the ratio of their XP rates is
            // free, and it is what lets the estimate stop pretending the grind
            // ends at the speed it started
            row.levelXpSpeedup = xpRateSpeedup(baselineResult, simResult, playerHrid);
            row.levelTimeHours = estimateCombatLevelTime(
                candidate,
                xpSimResult,
                gameData,
                playerHrid,
                row.levelXpSpeedup
            );
            row.levelingCharmName = matchingCharm
                ? gameData.itemDetailMap[matchingCharm.hrid]?.name || 'matching charm'
                : 'no charm';

            // The weapon's primary skill takes 30% of the XP no matter what the
            // charm focuses, so grinding this skill to its target levels that
            // one too. Work out how far it gets in the same hours, and sim the
            // pair — that is the build the grind actually ends with
            const primary = getPrimaryTrainingSkill(playerDTO, gameData);
            row.primarySkill = primary;
            row.isMainSkill = candidate.skillKey === `${primary}Level`;
            row.alongside = null;
            if (!row.isMainSkill) {
                const along = primaryLevelsAlongside(candidate, primary, xpSimResult, gameData, playerHrid, playerDTO);
                if (along) {
                    row.alongside = along;
                    if (along.upgradeLevel > along.currentLevel && !abortSignal?.()) {
                        onProgress?.({
                            current: progress.current,
                            total,
                            description: `${candidate.description} + ${along.label} ${along.currentLevel} → ${along.upgradeLevel}`,
                        });
                        const bothDTOs = JSON.parse(JSON.stringify(modifiedDTOs));
                        bothDTOs[playerIndex][along.skillKey] = along.upgradeLevel;
                        const bothResult = await runSimulation(
                            {
                                gameData,
                                playerDTOs: bothDTOs,
                                zoneHrid,
                                difficultyTier,
                                hours,
                                communityBuffs,
                                seed: simSeed,
                                isTaskFight: false,
                            },
                            null,
                            { preempt: false, workers: 1 }
                        );
                        const bothMetrics = computeMetrics(bothResult, gameData, playerHrid, hours);
                        row.alongside.metrics = bothMetrics;
                        row.alongside.deltas = computeDeltas(baselineMetrics, bothMetrics);
                    }
                }
            }
            progress.current++;
        }
        progress.current++;
        onProgress?.({ current: progress.current, total, description: candidate.description });
        return row;
    };

    onProgress?.({ current: progress.current, total, description: `Simulating ${candidatesWithCost.length} upgrades` });
    const results = (await mapConcurrent(candidatesWithCost, evaluateCandidate, lanes)).filter(Boolean);
    current = progress.current;

    // Score only what can actually be bought — combat levels have no gold cost,
    // so ranking them alongside gear would seed the ladders with non-purchases
    assignRankScores(results.filter((r) => r.candidate.type !== 'combat_level'));

    // Sort by best value (lowest gold per 0.01% DPS improvement)
    results.sort((a, b) => {
        const aVal = a.goldPer.dps === Infinity ? Number.MAX_VALUE : a.goldPer.dps;
        const bVal = b.goldPer.dps === Infinity ? Number.MAX_VALUE : b.goldPer.dps;
        return aVal - bVal;
    });

    // Food is not a ranked upgrade — it is a cost floor at fixed survival, so it
    // gets its own search and its own result shape
    let food = null;
    if (optimizeFood && !abortSignal?.()) {
        try {
            food = await runFoodOptimization(
                {
                    gameData,
                    playerDTOs,
                    playerIndex,
                    zoneHrid,
                    difficultyTier,
                    hours,
                    communityBuffs,
                    seed: simSeed,
                    baselineResult,
                },
                ({ description }) => {
                    current++;
                    onProgress?.({ current, total, description });
                },
                { abortSignal }
            );
        } catch (error) {
            console.error('[UpgradeAdvisor] Food optimization failed:', error);
        }
    }

    return {
        baseline: baselineMetrics,
        results,
        food,
        // Explains an empty house result rather than leaving it as "no upgrades"
        houseScan: candidateModes.includes('house') ? describeHouseScan(playerDTO, gameData) : null,
        // Enough to re-run this exact analysis on a chosen set of picks at once —
        // same seed, same zone, same everything else — which is what a budget
        // plan's confirming run needs to mean anything. See
        // `confirmUpgradeBudgetPlan`.
        context: {
            gameData,
            playerDTOs,
            playerIndex,
            playerHrid,
            zoneHrid,
            difficultyTier,
            hours,
            communityBuffs,
            seed: simSeed,
            precision,
            baselineResult,
            baseline: baselineMetrics,
        },
    };
}

/**
 * How much faster the character earns XP once a candidate's levels are in.
 *
 * Total XP per hour in the boosted run against the same figure in the baseline.
 * Total rather than the one skill's, because the skill being levelled is the
 * one thing a focus charm redistributes — the honest signal for "the zone dies
 * faster now" is everything the character earned.
 *
 * @param {Object} baselineResult - Baseline SimResult
 * @param {Object} upgradedResult - SimResult at the boosted levels
 * @param {string} playerHrid - Whose experience to read
 * @returns {number} Ratio ≥ 1 in the normal case, 1 when it cannot be read
 */
function xpRateSpeedup(baselineResult, upgradedResult, playerHrid) {
    const rate = (result) => {
        const simHours = (result?.simulatedTime || 0) / (3600 * 1e9);
        if (!(simHours > 0)) return 0;
        const xp = result?.experienceGained?.[playerHrid] || {};
        return Object.values(xp).reduce((sum, value) => sum + (value || 0), 0) / simHours;
    };
    const before = rate(baselineResult);
    const after = rate(upgradedResult);
    if (!(before > 0) || !(after > 0)) return 1;
    return after / before;
}

/**
 * Estimate hours of grinding needed to raise a combat skill from its current
 * level to the candidate's boosted level.
 *
 * Integrated level by level rather than divided once. Dividing the whole XP gap
 * by today's rate answers "how long at the speed I go now", but the levels
 * being bought are exactly what makes the character faster — the last level of
 * the span is earned at the end rate, not the start rate — so a one-shot
 * division overstates every span long enough to matter, and overstates the
 * longest ones worst. The rate is walked linearly from the measured start rate
 * to `speedup ×` that, and each level's own XP gap is charged at the rate in
 * force while it is being earned.
 *
 * Linear in level is an approximation and a mild one: the real curve is a
 * function of accuracy and damage against a fixed monster, and over the five to
 * twenty levels these candidates span, its shape matters far less than not
 * pretending the rate is constant.
 *
 * Infinity when the current setup earns no XP in that skill.
 *
 * @param {Object} candidate - combat_level candidate
 * @param {Object} baselineResult - Sim result in the leveling posture
 * @param {Object} gameData - Game data (levelExperienceTable)
 * @param {string} playerHrid - Player HRID in the sim result
 * @param {number} [speedup=1] - XP-rate multiplier once the levels are in
 * @returns {number} Hours needed, or Infinity
 */
function estimateCombatLevelTime(candidate, baselineResult, gameData, playerHrid, speedup = 1) {
    const levelXpTable = gameData.levelExperienceTable || [];
    const skillName = candidate.skillKey.replace('Level', '');
    const simHours = (baselineResult.simulatedTime || 0) / (3600 * 1e9) || 1;
    const startRate = (baselineResult.experienceGained?.[playerHrid]?.[skillName] || 0) / simHours;
    if (!(startRate > 0)) return Infinity;

    const targetXp = levelXpTable[candidate.upgradeLevel];
    if (!Number.isFinite(targetXp)) return Infinity;

    // Use the character's actual XP when their live skill matches the simmed
    // level; otherwise assume the start of the current level
    let currentXp = levelXpTable[candidate.currentLevel] || 0;
    const liveSkill = dataManager.getSkills?.()?.find((s) => s.skillHrid === `/skills/${skillName}`);
    if (liveSkill && liveSkill.level === candidate.currentLevel && Number.isFinite(liveSkill.experience)) {
        currentXp = liveSkill.experience;
    }
    if (targetXp <= currentXp) return 0;

    const span = candidate.upgradeLevel - candidate.currentLevel;
    const growth = Number.isFinite(speedup) && speedup > 0 ? speedup : 1;
    if (!(span > 0) || growth === 1) return (targetXp - currentXp) / startRate;

    let hours = 0;
    let xpSoFar = currentXp;
    for (let level = candidate.currentLevel; level < candidate.upgradeLevel; level++) {
        const levelEndXp = Number.isFinite(levelXpTable[level + 1]) ? levelXpTable[level + 1] : targetXp;
        const gap = Math.max(0, Math.min(levelEndXp, targetXp) - xpSoFar);
        if (gap <= 0) continue;
        // Rate at the midpoint of the level being earned, so the first level is
        // charged at very nearly the measured rate and the last at very nearly
        // the boosted one, rather than a whole level of either being lost
        const progress = (level - candidate.currentLevel + 0.5) / span;
        hours += gap / (startRate * (1 + (growth - 1) * progress));
        xpSoFar += gap;
    }
    return hours;
}

/**
 * How far the weapon's primary training skill gets while another skill is
 * ground to its target.
 *
 * Both skills earn at rates read off the same leveling-posture sim, and both
 * rates scale together as the zone speeds up — so the primary skill's XP over
 * the grind is the target skill's XP need times the ratio of their rates, no
 * matter how the speedup plays out. Level found by walking the XP table.
 *
 * @param {Object} candidate - combat_level candidate for the skill being ground
 * @param {string} primary - Primary training skill name, e.g. 'melee'
 * @param {Object} xpSimResult - Sim in the leveling posture (matching charm on)
 * @param {Object} gameData - Game data (levelExperienceTable)
 * @param {string} playerHrid - Player HRID in the sim result
 * @param {Object} playerDTO - The player's current DTO (for the primary level)
 * @returns {{skillKey: string, label: string, currentLevel: number, upgradeLevel: number, xpGained: number}|null}
 *   Null when the target skill earns no XP here (the grind never ends)
 */
export function primaryLevelsAlongside(candidate, primary, xpSimResult, gameData, playerHrid, playerDTO) {
    const table = gameData.levelExperienceTable || [];
    const xp = xpSimResult?.experienceGained?.[playerHrid] || {};
    const targetSkill = candidate.skillKey.replace('Level', '');
    const targetRate = xp[targetSkill] || 0;
    const primaryRate = xp[primary] || 0;
    if (!(targetRate > 0)) return null;

    const currentXpOf = (skillName, level) => {
        let current = table[level] || 0;
        const live = dataManager.getSkills?.()?.find((sk) => sk.skillHrid === `/skills/${skillName}`);
        if (live && live.level === level && Number.isFinite(live.experience)) current = live.experience;
        return current;
    };

    const targetXp = table[candidate.upgradeLevel];
    const need = Number.isFinite(targetXp)
        ? Math.max(0, targetXp - currentXpOf(targetSkill, candidate.currentLevel))
        : 0;
    const xpGained = need * (primaryRate / targetRate);

    const skillKey = `${primary}Level`;
    const currentLevel = Math.max(1, Math.floor(playerDTO?.[skillKey] || 1));
    const reached = currentXpOf(primary, currentLevel) + xpGained;
    let upgradeLevel = currentLevel;
    while (upgradeLevel < 200 && Number.isFinite(table[upgradeLevel + 1]) && table[upgradeLevel + 1] <= reached) {
        upgradeLevel++;
    }

    return {
        skillKey,
        label: primary.charAt(0).toUpperCase() + primary.slice(1),
        currentLevel,
        upgradeLevel,
        xpGained,
    };
}

/**
 * Compute key metrics from a sim result.
 */
function computeMetrics(simResult, gameData, playerHrid, hours) {
    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
    const xp = simResult.experienceGained?.[playerHrid] || {};
    const totalXpPerHour = Object.values(xp).reduce((s, v) => s + v, 0) / simHours;
    const deaths = (simResult.deaths?.[playerHrid] || 0) / simHours;
    const encounters = (simResult.encounters || 0) / simHours;

    // Profit/hr
    const revenue = calculateSimRevenue(simResult, gameData, playerHrid, simHours);

    return {
        xpPerHour: totalXpPerHour,
        profitPerHour: revenue.netPerHour,
        deathsPerHour: deaths,
        encountersPerHour: encounters,
        dps: (simResult.totalDamageDealt?.[playerHrid] || 0) / (simHours * 3600),
    };
}

/**
 * Compute percentage deltas between baseline and upgraded metrics.
 */
function computeDeltas(baseline, upgraded) {
    const pctDelta = (base, upg) => {
        if (base === 0) return upg > 0 ? 100 : 0;
        return ((upg - base) / Math.abs(base)) * 100;
    };

    return {
        dps: pctDelta(baseline.dps, upgraded.dps),
        xp: pctDelta(baseline.xpPerHour, upgraded.xpPerHour),
        profit: pctDelta(baseline.profitPerHour, upgraded.profitPerHour),
        deaths: pctDelta(baseline.deathsPerHour, upgraded.deathsPerHour),
        encounters: pctDelta(baseline.encountersPerHour, upgraded.encountersPerHour),
    };
}

/**
 * How much of a combat row's percentage delta could be the sample.
 *
 * The labyrinth side of the advisor has had this since `attemptsNoise`: a win
 * rate measured over finite trials carries an error, and a delta between two of
 * them carries both. The combat side had nothing, so `significant` was never
 * set on a combat row, the budget planner's noise skip never fired, and a 0.3%
 * DPS "gain" measured over ninety encounters was presented exactly like a 12%
 * one measured over nine thousand.
 *
 * Every metric here is a total divided by hours, and the total is a sum over
 * encounters — so the count of encounters is the sample size, and the relative
 * error of the rate goes as 1/√n. Taking the per-encounter coefficient of
 * variation as 1 is a deliberate round number: the true figure varies by metric
 * and by zone, it is not in the SimResult, and being roughly right about the
 * order of magnitude is the whole job. Deaths are counted rather than summed,
 * so they get the Poisson √d instead, which at two deaths a run is enormous —
 * correctly, since two deaths is not a measurement of anything.
 *
 * Baseline and candidate are added in quadrature. Like `attemptsNoise` this
 * overstates: the runs share a seed, so their errors are correlated and partly
 * cancel out of the difference. Overstating costs an honest row its colour;
 * understating recommends a purchase that did nothing.
 *
 * @param {Object} baselineResult - Baseline SimResult
 * @param {Object} upgradedResult - Candidate SimResult
 * @param {string} playerHrid - Whose deaths are being counted
 * @returns {Object} One standard error per metric, as a percentage of the metric
 */
export function rateDeltaNoisePct(baselineResult, upgradedResult, playerHrid) {
    const encounters = (result) => Math.max(1, Number(result?.encounters) || 0);
    const deaths = (result) => Math.max(1, Number(result?.deaths?.[playerHrid]) || 0);

    const quadrature = (a, b) => Math.sqrt(1 / a + 1 / b) * 100;
    const perEncounter = quadrature(encounters(baselineResult), encounters(upgradedResult));
    const perDeath = quadrature(deaths(baselineResult), deaths(upgradedResult));

    return {
        dps: perEncounter,
        xp: perEncounter,
        profit: perEncounter,
        encounters: perEncounter,
        deaths: perDeath,
    };
}

/**
 * Which of a row's deltas cleared their own error bar.
 * @param {Object} deltas - Percentage deltas from `computeDeltas`
 * @param {Object} noise - Percentage standard errors from `rateDeltaNoisePct`
 * @returns {Object} Per-metric booleans
 */
export function significantDeltas(deltas, noise) {
    const verdict = {};
    for (const key of Object.keys(deltas || {})) {
        const error = noise?.[key];
        verdict[key] = Number.isFinite(error) ? Math.abs(deltas[key]) > SIGNIFICANCE_Z * error : true;
    }
    return verdict;
}

/** Improvement step the gold-per figures are quoted against, in percent. */
export const GOLD_PER_STEP_PCT = 0.01;

/**
 * Compute gold per 0.01% improvement for each metric.
 * Lower = better value.
 *
 * The step size only rescales the figures — it divides every row by the same
 * constant, so the ranking is identical whichever step is quoted.
 */
function computeGoldPerImprovement(cost, deltas) {
    // Unknown cost (null) must rank as Infinity, never as free
    const safeCost = cost == null ? Infinity : cost;
    // pctDelta is already in percent (e.g. 2 = 2%), so a 0.01% step means
    // dividing by pctDelta / 0.01
    const steps = (pctDelta) => Math.abs(pctDelta) / GOLD_PER_STEP_PCT;

    // Gold per improvement is cost ÷ improvement, and at or below zero cost the
    // division stops meaning anything: zero divided by any gain is zero, so
    // every free upgrade ties at the top however small its gain, and a negative
    // cost divided by a tiny gain runs off to minus infinity, so the *worst*
    // paying-for-itself swap outranks the best one. Below zero the figure is
    // therefore the net gold itself — what the swap actually hands back — which
    // keeps every one of them above every purchase while ordering them among
    // themselves by size rather than by how nearly their gain vanished.
    const atOrBelowFree = (pctDelta) => (safeCost <= 0 && pctDelta !== 0 ? safeCost : null);

    const goldPer = (pctDelta) => {
        if (pctDelta <= 0) return Infinity;
        return atOrBelowFree(pctDelta) ?? safeCost / steps(pctDelta);
    };

    // For deaths, fewer is better — use negative delta (reduction)
    const goldPerReduction = (pctDelta) => {
        if (pctDelta >= 0) return Infinity; // Deaths didn't decrease
        return atOrBelowFree(pctDelta) ?? safeCost / steps(pctDelta);
    };

    return {
        dps: goldPer(deltas.dps),
        xp: goldPer(deltas.xp),
        profit: goldPer(deltas.profit),
        encounters: goldPer(deltas.encounters),
        deaths: goldPerReduction(deltas.deaths),
    };
}

/** Hours in a year, for annualising an hourly profit gain. */
const HOURS_PER_YEAR = 24 * 365;

/**
 * Extra simulated time a candidate may take to reach the baseline's fight
 * count. Upgrades usually kill faster and need less, but a defensive swap can
 * need more, and a run cut short by the clock is no longer paired.
 */
const PAIRED_TIME_HEADROOM = 3;

/**
 * Make every run in a comparison play exactly as many fights as the baseline
 * did.
 *
 * The advisor ranks by the *difference* two loadouts make, and shares one seed
 * across the baseline and every candidate so their random draws cancel out of
 * that difference. That cancellation needs the runs to line up fight for fight.
 * Stopping each on its own precision would end them at different points on
 * different slices of the sequence and throw the pairing away, leaving a
 * one-point delta to be read off two independently noisy numbers.
 *
 * A time budget breaks it more quietly: a candidate that kills faster fits more
 * fights into the same hours, so the two runs cover different encounters
 * altogether. Taking the count from the baseline keeps the sample the time
 * budget would have bought, while making it identical across candidates.
 *
 * @param {Object} baselineResult - The baseline run's SimResult
 * @returns {Object} A stopping rule pinned to that fight count
 */
function pairedTrialRule(baselineResult) {
    const trials = Math.max(1, Math.floor(Number(baselineResult?.labyAttemptCount) || 0));
    return { minTrials: trials, maxTrials: trials };
}

/**
 * How long the upgrade takes to afford, and how long it takes to pay for itself.
 *
 * Gold per 0.01% answers "which upgrade is the most efficient". These answer a
 * different question — "is it worth buying at all" — and the two often disagree.
 * An upgrade with an excellent gold-per-DPS figure and a nine-month payback is
 * still a bad purchase for anyone whose bankroll is the binding constraint.
 *
 * Both are derived from the averaged profit figures rather than any single run.
 * A profit delta thin enough to be RNG would otherwise send the repay period
 * asymptotic, and a table cell reading "412 years" from noise is worse than
 * useless — it looks like a measurement.
 *
 * @param {number|null} cost - Gold cost; null means unknown, never free
 * @param {Object} baseline - Baseline metrics ({ profitPerHour })
 * @param {Object} upgraded - Upgraded metrics ({ profitPerHour })
 * @returns {Object} { profitGainPerHour, paybackHours, repayHours } — hours are
 *   Infinity when the cost is unknown, or when the relevant profit is not positive
 */
export function computeEconomics(cost, baseline, upgraded) {
    const safeCost = cost == null ? Infinity : cost;
    const profitGainPerHour = (upgraded?.profitPerHour ?? 0) - (baseline?.profitPerHour ?? 0);

    // Free is free: nothing to save up for and nothing to earn back
    if (safeCost <= 0) {
        return {
            profitGainPerHour,
            paybackHours: 0,
            repayHours: 0,
            roiAnnualPct: profitGainPerHour > 0 ? Infinity : 0,
        };
    }

    const basePerHour = baseline?.profitPerHour ?? 0;
    return {
        profitGainPerHour,
        paybackHours: basePerHour > 0 ? safeCost / basePerHour : Infinity,
        repayHours: profitGainPerHour > 0 ? safeCost / profitGainPerHour : Infinity,
        // A year of the added profit against the outlay. Null when the cost is
        // unknown — zero would read as "no return" rather than "no idea"
        roiAnnualPct: Number.isFinite(safeCost) ? (profitGainPerHour * HOURS_PER_YEAR * 100) / safeCost : null,
    };
}

/** Placings that earn points in the rank score, best first. */
export const RANK_PLACES = 5;

/**
 * Metrics the Score can be built from, and which direction is good.
 *
 * Only value metrics appear here — every one weighs a result against what it
 * costs. Raw deltas are deliberately absent: ranking by ΔDPS alone rewards
 * whatever is most expensive, which is the opposite of what the score is for.
 */
export const SCORE_METRICS = [
    { key: 'dps', label: 'Gold/0.01% DPS', lowerIsBetter: true, value: (r) => r.goldPer?.dps },
    { key: 'xp', label: 'Gold/0.01% EXP', lowerIsBetter: true, value: (r) => r.goldPer?.xp },
    { key: 'profit', label: 'Gold/0.01% Profit', lowerIsBetter: true, value: (r) => r.goldPer?.profit },
    { key: 'encounters', label: 'Gold/0.01% EPH', lowerIsBetter: true, value: (r) => r.goldPer?.encounters },
    { key: 'deaths', label: 'Gold/0.01% DPH', lowerIsBetter: true, value: (r) => r.goldPer?.deaths },
    { key: 'repay', label: 'Repay time', lowerIsBetter: true, value: (r) => r.economics?.repayHours },
    { key: 'roi', label: 'ROI (1yr)', lowerIsBetter: false, value: (r) => r.economics?.roiAnnualPct },
];

/**
 * Metrics scored unless the user says otherwise.
 *
 * ROI is off by default because it is `profit gain / cost` and repay time is
 * `cost / profit gain` — the same ratio inverted. Scoring both counts one
 * signal twice, exactly the trap that keeps the Time column out of the list.
 */
export const DEFAULT_SCORE_KEYS = ['dps', 'xp', 'profit', 'encounters', 'deaths', 'repay'];

/**
 * Score every candidate by how often it places well across the value metrics.
 *
 * Sorting by one column answers only that column's question, and a candidate
 * that is second-best at everything never surfaces. Ranking within each metric
 * and summing the placings finds those all-rounders.
 *
 * The scoring is deliberately ordinal, and that is also its limitation: winning
 * a metric by a mile scores exactly what winning it by a hair scores. It is a
 * shortlisting aid, not a verdict, which is why it is not the default sort.
 *
 * The Time column (cost over current profit rate) is excluded on purpose.
 * Baseline profit is one number shared by every row, so dividing each cost by it
 * preserves the cost ordering exactly — Time is the Cost column in hours, and
 * scoring it would count cost twice. Repay is the one that carries new
 * information, dividing by a gain that differs per row.
 *
 * Ties share a placing, so two candidates that measure identically cannot be
 * separated by list order.
 *
 * Mutates and returns the rows, adding `score` and a `rankPoints` breakdown.
 *
 * @param {Array<Object>} results - Rows carrying `goldPer` and `economics`
 * @param {Object} [options]
 * @param {Array<string>} [options.keys=DEFAULT_SCORE_KEYS] - SCORE_METRICS keys to count
 * @param {number} [options.places=RANK_PLACES] - How many placings earn points
 * @returns {Array<Object>} The same rows
 */
export function assignRankScores(results, options = {}) {
    const places = options.places ?? RANK_PLACES;
    const keys = options.keys ?? DEFAULT_SCORE_KEYS;
    const metrics = SCORE_METRICS.filter((m) => keys.includes(m.key));

    for (const row of results) {
        row.rankPoints = {};
        row.score = 0;
    }

    for (const metric of metrics) {
        const ladder = [...new Set(results.map(metric.value).filter((v) => Number.isFinite(v)))]
            .sort((a, b) => (metric.lowerIsBetter ? a - b : b - a))
            .slice(0, places);
        if (!ladder.length) continue;

        for (const row of results) {
            const index = ladder.indexOf(metric.value(row));
            if (index === -1) continue;
            row.rankPoints[metric.key] = { label: metric.label, place: index + 1, points: places - index };
            row.score += places - index;
        }
    }

    return results;
}

// ─── Labyrinth Buff Upgrade Candidates ──────────────────────────────────────

const LABYRINTH_BUFF_DEFS = [
    {
        key: 'labyrinthCombatDamageLevel',
        name: 'Combat Damage',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'combat_damage',
        typeHrid: '/buff_types/damage',
        valueKey: 'ratioBoost',
    },
    {
        key: 'labyrinthAttackSpeedLevel',
        name: 'Attack Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'attack_speed',
        typeHrid: '/buff_types/attack_speed',
        valueKey: 'ratioBoost',
    },
    {
        key: 'labyrinthCastSpeedLevel',
        name: 'Cast Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'cast_speed',
        typeHrid: '/buff_types/cast_speed',
        valueKey: 'flatBoost',
    },
    {
        key: 'labyrinthCriticalRateLevel',
        name: 'Critical Rate',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'critical_rate',
        typeHrid: '/buff_types/critical_rate',
        valueKey: 'flatBoost',
    },
    {
        key: 'labyrinthSkillActionSpeedLevel',
        name: 'Skilling Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'actionSpeedBonus',
    },
    {
        key: 'labyrinthSkillingEfficiencyLevel',
        name: 'Skilling Efficiency',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'efficiencyBonus',
    },
    {
        key: 'labyrinthSkillingSuccessLevel',
        name: 'Success Rate',
        step: 0.005,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'successBonus',
    },
    {
        key: 'labyrinthSkillingDoubleProgressLevel',
        name: 'Double Progress',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'doubleProgressBonus',
    },
    {
        key: 'labyrinthExperienceLevel',
        name: 'Experience',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 80,
        category: 'experience',
    },
];

const LABYRINTH_SKILLS = [
    '/skills/woodcutting',
    '/skills/foraging',
    '/skills/milking',
    '/skills/cooking',
    '/skills/brewing',
    '/skills/cheesesmithing',
    '/skills/crafting',
    '/skills/tailoring',
    '/skills/alchemy',
    '/skills/enhancing',
];

/**
 * Generate labyrinth buff upgrade candidates from characterInfo.
 *
 * `levels` overrides where a current level is read from, for a panel that is
 * simulating token levels other than the ones the character owns: a row reading
 * "Damage Lv3 → Lv4" beside sims run at Damage 8 would be pricing a purchase
 * that has already been assumed. Absent, this reads the live character, which
 * is what every caller did before the Lab Sim could set them.
 *
 * @param {Object} [levels] - buffKey → level to step from; defaults to characterInfo
 * @returns {Array} Buff candidates with type 'labyrinth_buff'
 */
export function generateLabyrinthBuffCandidates(levels = null) {
    const info = levels && typeof levels === 'object' ? levels : dataManager.characterData?.characterInfo;
    if (!info) return [];

    const candidates = [];
    for (const def of LABYRINTH_BUFF_DEFS) {
        const currentLevel = Math.max(0, Math.floor(Number(info[def.key]) || 0));
        if (currentLevel >= def.maxLevel) continue;

        candidates.push({
            type: 'labyrinth_buff',
            category: def.category,
            buffKey: def.key,
            currentLevel,
            step: def.step,
            tokenCost: def.tokenCost * (currentLevel + 1),
            description: `${def.name} Lv${currentLevel}\u2192${currentLevel + 1}`,
            uniqueKey: def.uniqueKey,
            typeHrid: def.typeHrid,
            valueKey: def.valueKey,
            metric: def.metric,
        });
    }
    return candidates;
}

/**
 * Clone labyrinth combat buffs with +1 to a specific buff.
 * @param {Array} baseBuffs - Current labyrinth combat buffs
 * @param {Object} candidate - Buff candidate with uniqueKey/typeHrid/valueKey/step
 * @returns {Array} Modified buffs array
 */
function buildModifiedCombatBuffs(baseBuffs, candidate) {
    const uniqueHrid = `/buff_uniques/labyrinth_upgrade_${candidate.uniqueKey}`;
    const modified = JSON.parse(JSON.stringify(baseBuffs));

    const existing = modified.find((b) => b.uniqueHrid === uniqueHrid);
    if (existing) {
        existing[candidate.valueKey] += candidate.step;
    } else {
        const buff = {
            uniqueHrid,
            typeHrid: candidate.typeHrid,
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        };
        buff[candidate.valueKey] = candidate.step;
        modified.push(buff);
    }
    return modified;
}

/**
 * Cost breakdown for a lab candidate, noting resale that was deliberately not
 * credited because the replaced gear is being kept for other floors.
 * @param {Object} candidate - Upgrade candidate
 * @param {Object} gameData - Game data payload
 * @returns {Object} Breakdown from explainUpgradeCost plus kept-gear detail
 */
function explainLabCandidateCost(candidate, gameData) {
    const detail = explainUpgradeCost(candidate, gameData);
    if (!candidate.keptItems?.length) return detail;

    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
    detail.kept = candidate.keptItems.map((item) => ({
        hrid: item.hrid,
        name: nameOf(item.hrid),
        enhancementLevel: item.enhancementLevel || 0,
        price: resolveItemPrice(item.hrid, { side: 'sell', enhancementLevel: item.enhancementLevel || 0 }).price || 0,
    }));
    detail.keptValue = detail.kept.reduce((sum, entry) => sum + entry.price, 0);
    return detail;
}

/**
 * Run labyrinth upgrade analysis: baseline sim + equipment sims + buff sims.
 * Ranks upgrades by win rate / clear rate delta, grouped by cost type (token vs gold).
 * @param {Object} params
 * @param {Array} params.playerDTOs - Player DTOs (only first used — labyrinth is solo)
 * @param {number} params.playerIndex - Index of the player to analyze
 * @param {string} params.monsterHrid - Labyrinth monster HRID
 * @param {number} params.roomLevel - Room level to test at
 * @param {string[]} params.crates - Crate item HRIDs
 * @param {number} params.hours - Hours to simulate per candidate
 * @param {Object} params.communityBuffs - Community buffs
 * @param {Array} [params.labyrinthCombatBuffs] - Combat buffs from labyrinth upgrades
 * @param {string} params.upgradeMode - 'equipment', 'ability_level', or 'ability_swap'
 * @param {number} [params.abilityTargetLevel] - Target ability level
 * @param {boolean} [params.auraSwapsOnly] - Restrict ability swaps to the build guide's
 *   aura options and the archetype's signature ability
 * @param {number} [params.guildShrineTargetLevel] - One level for every shrine buff
 * @param {Object} [params.guildShrineTargets] - buffHrid → target level; takes precedence.
 *   Positive buys up to that level, 0 skips the shrine, negative means one level up, and a
 *   buff absent from the map is skipped
 * @param {boolean} [params.guildShrineCapToGuild=false] - Rank only shrine levels the guild's own
 *   shrine buildings can sell. A shrine the guild has not built is left out entirely, and one
 *   built to Lv4 stops at Lv4
 * @param {Object} [params.tokenLevels] - buffKey → level the token rows step up from,
 *   matching whatever `labyrinthCombatBuffs` was built out of
 * @param {boolean} [params.rankByRoomLevels=false] - Follow the win-rate pass with a
 *   binary-search level finder over the best-ranked candidates, so the table can be
 *   read in room levels gained and the floor those levels reach
 * @param {number} [params.referenceLevel] - The character's effective combat level,
 *   which sets the level search's window
 * @param {number} [params.roomLevelShortlistSize] - How many candidates get the
 *   expensive search; defaults to ROOM_LEVEL_SHORTLIST_SIZE
 * @param {number} [params.maxTrials] - Fight cap for a single level-search probe,
 *   so the tab's Max fights bounds this pass too
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results: [{candidate, costType, ...}] }
 */
export async function runLabyrinthUpgradeAnalysis(params, onProgress, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        monsterHrid,
        roomLevel,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs = [],
        upgradeMode,
        abilityLevelType,
        abilityTargetLevel,
        skipBackSlot,
        combatLevelTargets,
        abilityTargets,
        auraSwapsOnly = false,
        houseTargetLevel = 0,
        houseTargets = null,
        guildShrineTargetLevel = 0,
        guildShrineTargets = null,
        guildShrineCapToGuild = false,
        tokenLevels = null,
        extraCandidates = [],
        rankByRoomLevels = false,
        referenceLevel = null,
        roomLevelShortlistSize = ROOM_LEVEL_SHORTLIST_SIZE,
        maxTrials = null,
        precision = null,
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const playerDTO = playerDTOs[playerIndex];

    // Shared across baseline and every candidate so win-rate deltas measure the
    // upgrade, not the gap between two independent random samples
    const simSeed = analysisSeed();

    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';

    // Generate candidates ('combined' runs equipment and ability levels together)
    const labCandidateModes = upgradeMode === 'combined' ? ['equipment', 'ability_level'] : [upgradeMode];
    const candidates = labCandidateModes.flatMap((mode) =>
        generateCandidates(
            playerDTO,
            gameData,
            mode,
            abilityTargetLevel,
            abilityLevelType,
            skipBackSlot,
            combatLevelTargets,
            abilityTargets,
            houseTargetLevel,
            houseTargets,
            null,
            guildShrineTargetLevel,
            // This table ranks win rate and Gold/1% and nothing else, so a room
            // whose only combat-facing buffs are the global wisdom and rare find
            // every room grants has nothing it could move here
            { auraSwapsOnly, houseWinRateOnly: true, guildShrineTargets, guildShrineCapToGuild }
        )
    );

    // The labyrinth lives or dies on body/legs, so always evaluate the Anchorbound
    // plate and the top-tier armor matching this loadout's weapon — the tier
    // progression only ever steps one rung from what's worn and would hide them
    if (labCandidateModes.includes('equipment')) {
        const forced = generateLabArmorCandidates(playerDTO, gameData, dataManager.getInventory());
        // The labyrinth needs every element set, so these swaps are usually an
        // added purchase rather than a trade-in — pricing them net of selling the
        // piece they replace would understate what they actually cost
        const keepReplaced = config.getSettingValue('labSim_keepReplacedGear', true);
        const seen = new Set(candidates.map(candidateAssignmentKey));
        for (const candidate of forced) {
            const key = candidateAssignmentKey(candidate);
            if (seen.has(key)) continue;
            seen.add(key);
            if (keepReplaced) {
                candidate.keptItems = candidate.removedItems;
                candidate.removedItems = [];
            }
            candidates.push(candidate);
        }
    }

    // Candidates the caller asked for by name, alongside whatever the mode
    // generated. This is how one specific thing — "what would the Critical Aura
    // do for me" — gets ranked against the upgrades you were already weighing,
    // rather than becoming a change applied to all of them.
    const already = new Set(candidates.map(candidateAssignmentKey));
    for (const candidate of extraCandidates) {
        const key = candidateAssignmentKey(candidate);
        if (already.has(key)) continue;
        already.add(key);
        candidates.push(candidate);
    }

    // A community buff is not on the character and cannot be installed onto one:
    // it is an argument to the simulation. It also cannot change whether a fight
    // is won — the two a combat fight reads move experience and loot — so it is
    // held out of the win-rate ranking entirely rather than being run through it
    // and reported at whatever the sampling noise came to. What it *can* move is
    // measured in its own pass below.
    const communityCandidates = candidates.filter((c) => c.type === 'community_buff' && !c.measuresLoss);
    const candidatesWithCost = candidates
        .filter((c) => c.type !== 'community_buff')
        .map((c) => ({
            ...c,
            cost: calculateUpgradeCost(c, gameData),
        }));

    // Generate buff candidates. Skilling buffs are handled in the skilling tab;
    // the Experience token is ranked in neither tab — it moves XP/room, not
    // clear rate, and this analysis has no XP metric to rank it by.
    const buffCandidates = generateLabyrinthBuffCandidates(tokenLevels);
    const combatBuffCandidates = buffCandidates.filter((c) => c.category === 'combat');

    const total = candidatesWithCost.length + combatBuffCandidates.length + communityCandidates.length + 1;
    let current = 0;

    // Run baseline labyrinth sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    const baselineResult = await runLabyrinthSimulation({
        gameData,
        playerDTOs: [playerDTOs[playerIndex]],
        zoneHrid,
        monsterHrid,
        roomLevel,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs,
        seed: simSeed,
        // Every candidate is paired to the baseline's fight count, so the tab's
        // precision target and max-fights cap have to land here or they govern
        // nothing at all: this ran the plain `hours` budget and the Precision,
        // Max fights and Uncapped controls sat over the single-fight run doing
        // nothing. Null still falls back to `hours`, which is what the
        // all-fights wrapper and the combat simulator both do.
        ...(precision ? { precision } : {}),
    });
    current++;
    // Every candidate below plays exactly the baseline's fight count
    const pairedRule = pairedTrialRule(baselineResult);
    const pairedHours = hours * PAIRED_TIME_HEADROOM;

    if (abortSignal?.()) return { baseline: null, results: [] };

    const baselineAttempts = baselineResult.labyAttemptCount || 1;
    const baselineEncounters = baselineResult.encounters || 0;
    const baselineWinRate = baselineEncounters / baselineAttempts;
    const baselineXpPerAttempt = simExperiencePerAttempt(baselineResult);

    onProgress?.({ current, total, description: `Baseline: ${(baselineWinRate * 100).toFixed(1)}%` });

    const results = [];
    const progress = { current };

    // Every candidate is one worker against the same baseline with the same
    // seed and the same trial count, so they are independent runs that were
    // being done one at a time
    const runCandidate = async (candidate, playerDTO, buffs, describe) => {
        if (abortSignal?.()) return null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [playerDTO],
            zoneHrid,
            monsterHrid,
            roomLevel,
            crates,
            hours: pairedHours,
            precision: pairedRule,
            communityBuffs,
            labyrinthCombatBuffs: buffs,
            seed: simSeed,
        });
        if (abortSignal?.()) return null;
        progress.current++;
        onProgress?.({ current: progress.current, total, description: describe });
        const attempts = simResult.labyAttemptCount || 1;
        return (simResult.encounters || 0) / attempts;
    };

    // ── Equipment / ability sims ──
    onProgress?.({ current: progress.current, total, description: `Simulating ${candidatesWithCost.length} upgrades` });
    const equipmentRates = await mapConcurrent(candidatesWithCost, (candidate) =>
        runCandidate(
            candidate,
            applyCandidateToDTO(playerDTOs[playerIndex], candidate),
            labyrinthCombatBuffs,
            candidate.description
        )
    );

    for (let i = 0; i < candidatesWithCost.length; i++) {
        const candidate = candidatesWithCost[i];
        const winRate = equipmentRates[i];
        if (winRate === null || winRate === undefined) continue;
        const winRateDelta = winRate - baselineWinRate;

        results.push({
            candidate,
            costDetail: explainLabCandidateCost(candidate, gameData),
            costType: 'gold',
            cost: candidate.cost,
            winRate,
            winRateDelta,
            goldPerWinRate:
                winRateDelta > 0 && candidate.cost != null ? candidate.cost / (winRateDelta * 100) : Infinity,
            metricType: 'winRate',
        });
    }

    // ── Combat buff sims ──
    const buffRates = await mapConcurrent(combatBuffCandidates, (buffCandidate) =>
        runCandidate(
            buffCandidate,
            playerDTOs[playerIndex],
            buildModifiedCombatBuffs(labyrinthCombatBuffs, buffCandidate),
            buffCandidate.description
        )
    );

    for (let i = 0; i < combatBuffCandidates.length; i++) {
        const buffCandidate = combatBuffCandidates[i];
        const winRate = buffRates[i];
        if (winRate === null || winRate === undefined) continue;
        const winRateDelta = winRate - baselineWinRate;

        results.push({
            candidate: buffCandidate,
            costType: 'token',
            tokenCost: buffCandidate.tokenCost,
            winRate,
            winRateDelta,
            metricType: 'winRate',
        });
    }

    // ── Community buff sims ──
    //
    // Ranked on experience per attempt, and on nothing else. The Experience buff
    // changes what a win is worth; the Combat Drop buff changes what it pays out
    // and this table does not price drops, so it is dropped rather than given a
    // row whose only column would be blank. The win-rate columns stay at the
    // baseline for the same reason the skilling tab leaves them there for the
    // Experience token: the room is cleared exactly as often as before.
    for (const candidate of communityCandidates) {
        if (abortSignal?.()) break;
        if (!communityBuffMovesCombatXp(candidate)) continue;

        onProgress?.({ current: progress.current, total, description: candidate.description });
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [playerDTOs[playerIndex]],
            zoneHrid,
            monsterHrid,
            roomLevel,
            crates,
            hours: pairedHours,
            precision: pairedRule,
            communityBuffs: applyCommunityBuffCandidate(communityBuffs, candidate),
            labyrinthCombatBuffs,
            seed: simSeed,
        });
        if (abortSignal?.()) break;
        progress.current++;
        onProgress?.({ current: progress.current, total, description: candidate.description });

        const xpPerAttempt = simExperiencePerAttempt(simResult);
        results.push({
            candidate,
            costType: 'community',
            cowbellCost: communityBuffCowbellCost(candidate),
            // Left exactly where the baseline was, so the row cannot be misread
            // as an upgrade to the fight itself
            winRate: baselineWinRate,
            winRateDelta: 0,
            xpPerRoom: xpPerAttempt,
            xpPerRoomDelta: xpPerAttempt - baselineXpPerAttempt,
            metricType: 'xpPerRoom',
        });
    }

    // Sort: token results first, then community, then gold; within each group by
    // best delta descending
    const labCostOrder = { token: 0, community: 1, gold: 2 };
    results.sort((a, b) => {
        if (a.costType !== b.costType) return (labCostOrder[a.costType] ?? 3) - (labCostOrder[b.costType] ?? 3);
        if (a.metricType === 'xpPerRoom' && b.metricType === 'xpPerRoom') {
            return (b.xpPerRoomDelta ?? 0) - (a.xpPerRoomDelta ?? 0);
        }
        const aDelta = a.winRateDelta ?? a.clearRateDelta ?? 0;
        const bDelta = b.winRateDelta ?? b.clearRateDelta ?? 0;
        return bDelta - aDelta;
    });

    // ── Room levels gained ──
    //
    // A second, dearer pass over the best of the above. Everything up to here
    // is measured at one room level; this asks the question the labyrinth is
    // actually scored on — how much deeper the character can go — and it costs
    // a binary search per candidate, so only the shortlist gets one.
    let roomLevels = null;
    if (rankByRoomLevels) {
        const threshold = defaultThreshold();
        const searchFor = (dto, buffs) =>
            findMaxLabyrinthLevel({
                gameData,
                playerDTOs: [dto],
                zoneHrid,
                monsterHrid,
                crates,
                simHours: hours,
                communityBuffs,
                labyrinthCombatBuffs: buffs,
                threshold,
                referenceLevel,
                maxTrials: maxTrials ?? undefined,
                abortSignal,
            });

        const levelTotal = Math.min(roomLevelShortlistSize, results.length) + 1;
        roomLevels = await measureRoomLevelGains(results, {
            shortlistSize: roomLevelShortlistSize,
            abortSignal,
            onProgress: ({ current, description }) =>
                onProgress?.({
                    current: progress.current,
                    total,
                    description: `Room levels ${current}/${levelTotal}: ${description}`,
                }),
            measure: (result) => {
                if (!result) return searchFor(playerDTOs[playerIndex], labyrinthCombatBuffs);
                const candidate = result.candidate;
                return result.costType === 'token'
                    ? searchFor(playerDTOs[playerIndex], buildModifiedCombatBuffs(labyrinthCombatBuffs, candidate))
                    : searchFor(applyCandidateToDTO(playerDTOs[playerIndex], candidate), labyrinthCombatBuffs);
            },
        });
        roomLevels.threshold = threshold;
    }

    return {
        baseline: {
            winRate: baselineWinRate,
            encounters: baselineEncounters,
            attempts: baselineAttempts,
            xpPerRoom: baselineXpPerAttempt,
        },
        results,
        roomLevels,
    };
}

/**
 * Combat experience one labyrinth attempt paid out, across every skill.
 *
 * Summed rather than reported per skill: a community experience buff is a flat
 * multiplier on all of them, so the split says nothing the total does not, and a
 * single number is what a column can hold. Per *attempt* rather than per win —
 * an attempt is what the labyrinth charges you for, and what every other figure
 * in this analysis is denominated in.
 *
 * @param {Object} simResult - From `runLabyrinthSimulation`
 * @returns {number} Experience per attempt, 0 when the run recorded none
 */
function simExperiencePerAttempt(simResult) {
    const gained = simResult?.experienceGained;
    if (!gained) return 0;

    let total = 0;
    for (const perSkill of Object.values(gained)) {
        for (const amount of Object.values(perSkill || {})) {
            if (Number.isFinite(amount)) total += amount;
        }
    }
    return total / (simResult.labyAttemptCount || 1);
}

/** Community buffs whose effect a combat sim reports in experience */
const COMBAT_XP_COMMUNITY_BUFFS = new Set(['comExp']);

/**
 * Can this community buff move a number the labyrinth combat table shows?
 *
 * Only the experience one. The combat drop buff is real and does nothing this
 * table reports — there is no priced-loot column here — so it is left out
 * instead of being given a row of dashes.
 *
 * @param {Object} candidate - Candidate of type 'community_buff'
 * @returns {boolean}
 */
function communityBuffMovesCombatXp(candidate) {
    return COMBAT_XP_COMMUNITY_BUFFS.has(candidate?.buffKey);
}

/**
 * What the game charges per minute to keep a community buff running.
 *
 * The one real price a community buff has — a *level* has no price, since it is
 * what the whole server's donated minutes add up to. Read from the game's own
 * detail map, null when it has not loaded, which the row draws as a dash rather
 * than as free.
 *
 * @param {Object} candidate - Candidate of type 'community_buff'
 * @returns {number|null} Cowbells per minute
 */
function communityBuffCowbellCost(candidate) {
    const hrid = COMMUNITY_BUFF_HRIDS[candidate?.buffKey];
    const cost = dataManager.getInitClientData?.()?.communityBuffTypeDetailMap?.[hrid]?.cowbellCost;
    return Number.isFinite(cost) ? cost : null;
}

/** Win-rate floor for expected-attempts math so 0% fights stay finite (= 1000 tries) */
const ATTEMPT_WIN_RATE_FLOOR = 0.001;

/** How many standard errors a gain has to clear before it is called a gain */
const SIGNIFICANCE_Z = 1.96;

/**
 * The sampling error on "attempts saved across the run".
 *
 * Every win rate here is a proportion measured over a finite number of simulated
 * attempts, so every one carries an error — and the table's headline figure is a
 * sum of ten of them, put through 1/p, which magnifies the error badly at low
 * win rates. Without this, a run of luck on one 30% room reads as a 1.6B item
 * being worth buying.
 *
 * Per fight the standard error of the rate is the binomial √(p(1−p)/n), and
 * 1/p turns that into se/p² (the derivative of 1/p). Baseline and candidate are
 * added in quadrature, which is conservative: they share a seed, so their errors
 * are correlated and partly cancel. Overstating the noise costs a few honest
 * rows their colour; understating it recommends purchases that did nothing.
 *
 * @param {Array<Object>} appliedFights - The candidate's fights, applied ones only
 * @param {Array<Object>} baselineFights - The baseline, index-aligned by monster
 * @returns {number} One standard error of the attempts delta
 */
export function attemptsNoise(appliedFights, baselineFights = []) {
    const byMonster = new Map(
        (baselineFights || []).map((fight) => [`${fight.monsterHrid}@${fight.roomLevel}`, fight])
    );

    let variance = 0;
    for (const fight of appliedFights || []) {
        const base = byMonster.get(`${fight.monsterHrid}@${fight.roomLevel}`);
        for (const side of [fight, base]) {
            if (!side) continue;
            const trials = Math.max(1, Number(side.trials) || 0);
            const rate = Math.max(ATTEMPT_WIN_RATE_FLOOR, Math.min(1, Number(side.winRate) || 0));
            // d(1/p)/dp = −1/p², so the error on the tries figure is se/p²
            const standardError = Math.sqrt((rate * (1 - rate)) / trials);
            variance += (standardError / (rate * rate)) ** 2;
        }
    }
    return Math.sqrt(variance);
}

/**
 * The piece a candidate would displace in one particular loadout.
 *
 * One purchase serves every loadout, and with tier upgrades applying wherever
 * they would help, "what it replaces" is a different answer per room. The row's
 * own description can only name one of them.
 *
 * The slots it *clears* count as much as the slots it fills, and used not to. A
 * two-hander traded for a one-hander and a shield puts nothing in the two-hand
 * slot and takes nothing out of the two it fills — both are empty while the bow
 * is held — so walking `addedSlots` alone found no occupant anywhere and the
 * row said it displaced nothing. The reverse swap hid the same fact the other
 * way round: buying a two-hander sells the sword *and* the shield, and the
 * breakdown named neither. The credit for both is already in the price
 * (`removedItems`), so the row was quietly charging for a sale it never
 * mentioned.
 *
 * @param {Object} candidate - The upgrade
 * @param {Object} dto - The loadout
 * @param {Object} [gameData] - For the item's name
 * @returns {string} Display name, or '' where it displaces nothing
 */
export function replacedIn(candidate, dto, gameData) {
    const slots = candidate.addedSlots
        ? [...new Set([...Object.keys(candidate.addedSlots), ...(candidate.clearedSlots || [])])]
        : [candidate.slot];
    const names = [];
    for (const slot of slots) {
        const worn = dto?.equipment?.[slot];
        if (!worn?.hrid || worn.hrid === candidate.upgradeHrid) continue;
        const detail = gameData?.itemDetailMap?.[worn.hrid];
        const name = detail?.name || worn.hrid.split('/').pop().replace(/_/g, ' ');
        names.push(worn.enhancementLevel ? `${name} +${worn.enhancementLevel}` : name);
    }
    return names.join(' + ');
}

/**
 * Every group an upgrade belongs to.
 *
 * Some pairs are genuinely alternatives: two targets for one ability, or two
 * levels of one combat skill, where the higher already contains the lower.
 * Buying both spends the second one's price for nothing.
 *
 * Equipment slots are *not* in that category, which is the whole point of a
 * labyrinth run — a second chestpiece is wasteful only if it serves the same
 * rooms as the first. Where it serves rooms the first cannot reach, it is a
 * second purchase doing a second job, and the plan treats it that way.
 *
 * An ability swap is the one upgrade that cannot say what it conflicts with in a
 * single string, because it has two ends and each of them is a way to waste
 * money:
 *
 * - Two swaps *into the same equipped ability* ("Smack → Quick Strike" and
 *   "Smack → Poke") are two ways to spend one slot. Keyed on the newcomer alone,
 *   they look unrelated and the plan buys both books to read one.
 * - The same newcomer *offered for two slots* ("Smack → Fireball" and "Poke →
 *   Fireball", or a free-slot fill that also appears as a displacement) is one
 *   book. Keyed on the replaced ability alone, they look unrelated and the plan
 *   buys the stack twice.
 *
 * So an ability carries a key for each end, and anything sharing *either* is a
 * conflict. This also catches levelling an ability the same plan wants to
 * replace: the level candidate's key is the ability, and so is the swap's
 * outgoing key.
 *
 * @param {Object} candidate - The upgrade
 * @returns {Array<string>} Keys; candidates sharing any one of them conflict
 */
export function conflictKeys(candidate) {
    if (candidate.type === 'combat_level') return [`skill:${candidate.skillKey}`];
    if (candidate.type === 'house') return [`house:${candidate.slot}`];
    if (candidate.type === 'guild_shrine') return [`guild:${candidate.buffHrid}`];
    if (candidate.type === 'community_buff') return [`community:${candidate.buffKey}`];
    // A scroll's on and off rows are two answers about one buff; they can never
    // both be taken
    if (candidate.type === 'scroll') return [`scroll:${candidate.buffTypeHrid}`];
    // Two coffees of one buff family cannot both be up, whichever slots they
    // would sit in — the game's own conflict rule, keyed the same way
    if (candidate.type === 'drink') return [`drink:${candidate.buffFamily}`];
    if (candidate.slot?.startsWith('ability_')) {
        const keys = [`ability:${candidate.upgradeHrid}`];
        // `replacesHrid` is absent on a free-slot fill, which displaces nothing
        // and so has only the one end
        if (candidate.replacesHrid && candidate.replacesHrid !== candidate.upgradeHrid) {
            keys.push(`ability:${candidate.replacesHrid}`);
        }
        return keys;
    }

    const slots = candidate.addedSlots
        ? [...Object.keys(candidate.addedSlots), ...(candidate.clearedSlots || [])]
        : [candidate.slot];
    // A two-hander and a main-hand+off-hand pair are competing for the same
    // hands even though they name different slots
    const hands = ['/equipment_types/two_hand', '/equipment_types/main_hand', '/equipment_types/off_hand'];
    if (slots.some((slot) => hands.includes(slot))) return ['slot:weapon'];
    return [`slot:${[...new Set(slots)].sort().join('+')}`];
}

/**
 * The group an upgrade is filed under, for the places that need one name for it
 * — grouping picks per loadout, and tracking what a slot has already gained.
 *
 * Use `conflictKeys` for the question "may these two both be bought": an ability
 * swap has two ends and this reports only the first.
 *
 * @param {Object} candidate - The upgrade
 * @returns {string} Key that candidates in the same group share
 */
export function conflictKey(candidate) {
    return conflictKeys(candidate)[0];
}

/**
 * Whether a group admits exactly one purchase, whatever the rooms say.
 *
 * A skill level, an ability level and a house room are one number the character
 * carries everywhere. There is no second copy to wear in another room, so the
 * higher target simply contains the lower and buying both is buying one twice.
 *
 * @param {Object} candidate - The upgrade
 * @returns {boolean}
 */
function isExclusive(candidate) {
    return (
        candidate.type === 'combat_level' ||
        candidate.type === 'house' ||
        candidate.type === 'guild_shrine' ||
        candidate.type === 'community_buff' ||
        candidate.type === 'scroll' ||
        candidate.type === 'drink' ||
        Boolean(candidate.slot?.startsWith('ability_'))
    );
}

/**
 * The best set of upgrades a budget will buy.
 *
 * ## Why not simply the top few by value
 *
 * A labyrinth run is ten fights in ten loadouts, and a purchase only helps the
 * rooms it reaches. Ranking by total value and allowing one item per slot
 * answers a question about a single fight; the question here is which purchases
 * cover the most rooms most effectively, and the answer can be **two
 * chestpieces** — one for the melee loadouts, one for the casters. What it must
 * never be is two chestpieces for the same rooms, where the second is gold spent
 * on a piece that never gets worn.
 *
 * So each candidate is valued at what it adds *beyond what is already bought*.
 * Within a slot a room wears whichever picked piece is best for it, so a second
 * piece is worth exactly the rooms it improves on the first — nothing more.
 * Across slots the gains are taken as adding up, which is the assumption the
 * combination check exists to test.
 *
 * Greedy rather than an exact optimum, deliberately: the values are simulated
 * estimates with real error bars, an optimum computed from them is false
 * precision, and a list whose order can be read off the table is worth more than
 * one that is a percent better and inexplicable.
 *
 * @param {Array<Object>} results - Ranked analysis results
 * @param {number} budget - Coins available
 * @param {Object} [options] - `{ baselineFights, includeUnmeasured }`
 * @returns {{picks: Array<Object>, totalCost: number, attemptsSaved: number,
 *   skipped: Array<{result: Object, reason: string}>, budget: number}}
 */
/**
 * Attempts saved per million coins — the all-fights table's value figure.
 *
 * A swap can price NEGATIVE: selling the replaced piece brings back more than
 * the new one costs (a Cursed Bow +7 funding a Sundering Crossbow +7 with
 * 17.7M left over, 2026-08-29). `cost > 0` alone read that as "no coin price"
 * and dropped the best-value row in the table from the ranking. A priced swap
 * that costs nothing (or pays) and still helps is the best value there is —
 * Infinity sorts it first; one that costs nothing and does not help has no
 * value figure worth ranking on, same as the unpriceable rows.
 *
 * @param {number|null|undefined} cost - Net coin cost; negative is a credit
 * @param {number} attemptsSaved - Expected attempts saved across the run
 * @returns {number|null} Attempts saved per 1M coins, Infinity, or null
 */
export function valuePerMillion(cost, attemptsSaved) {
    if (!Number.isFinite(cost)) return null;
    if (cost > 0) return (attemptsSaved / cost) * 1e6;
    return attemptsSaved > 0 ? Infinity : null;
}

/**
 * Coins per percentage point of the rate a lab table ranks on — the Gold/1%
 * column, lowest first.
 *
 * Three things have to be kept apart at the cheap end and `cost / delta` keeps
 * none of them apart:
 *
 * - **No price.** Nothing to rank on; sorts last, with the combat levels.
 * - **Free.** The best ratio there is, and `cost ? … : Infinity` sent it to the
 *   bottom instead, beside the rows nobody could price.
 * - **Paid for by its own resale.** Dividing a credit by the gain makes the
 *   figure *more* negative the less the row helps, so the feeblest refund
 *   outranks the best one. Below zero the figure is therefore the credit
 *   itself, which keeps every refund above every purchase while ordering them
 *   among themselves by size. The same rule `computeGoldPerImprovement` applies
 *   to the combat sim's ladders, for the same reason.
 *
 * @param {number|null|undefined} cost - Net coin cost; negative is a credit
 * @param {number} deltaPct - Improvement in percentage points
 * @returns {number} Coins per point, the credit itself at or below free, or
 *   Infinity where there is nothing to rank on
 */
export function goldPerPercent(cost, deltaPct) {
    if (!Number.isFinite(cost)) return Infinity;
    if (!(deltaPct > 0)) return Infinity;
    if (cost > 0) return Math.round(cost / deltaPct);
    return cost;
}

export function planWithinBudget(results, budget, { baselineFights = [], includeUnmeasured = false } = {}) {
    const baseTries = baselineFights.map((fight) => expectedFightAttempts(fight.winRate || 0));

    /** What one candidate saves in each fight, in expected attempts */
    const savingsOf = (result) => {
        if (!baseTries.length || !result.fights?.length) {
            // No per-fight detail to work from — value it at the run total, which
            // is what a plan without a baseline can honestly say
            return [Math.max(0, -result.attemptsDelta)];
        }
        return result.fights.map((fight, index) =>
            fight.applied === false
                ? 0
                : Math.max(0, (baseTries[index] ?? 0) - expectedFightAttempts(fight.winRate || 0))
        );
    };

    const eligible = [];
    const skipped = [];
    for (const result of results || []) {
        // A budget is in coins, so a row without a price cannot be planned
        // around. A *negative* one can: a swap whose resale beats its purchase
        // hands money back into the budget, and used to be discarded here
        // alongside the unpriceable ones
        if (!Number.isFinite(result.cost)) continue;
        if (!(result.attemptsDelta < 0)) continue;
        if (!includeUnmeasured && result.significant === false) {
            skipped.push({ result, reason: 'within the noise of the simulation' });
            continue;
        }
        // `keys` is every group it conflicts with; `key` is the one it is filed
        // under for marginal-value bookkeeping (see `conflictKeys`)
        const keys = conflictKeys(result.candidate);
        eligible.push({ result, savings: savingsOf(result), key: keys[0], keys });
    }

    const picks = [];
    const taken = new Set();
    // The best saving reached so far in each group, per fight. A room wears one
    // piece per slot, so this is what a further piece has to beat to be worth
    // anything there.
    const bestBySlot = new Map();
    let spent = 0;

    const marginalOf = (entry) => {
        const standing = bestBySlot.get(entry.key);
        if (!standing) return entry.savings.reduce((sum, saving) => sum + saving, 0);
        let marginal = 0;
        for (let i = 0; i < entry.savings.length; i++) {
            marginal += Math.max(standing[i] || 0, entry.savings[i]) - (standing[i] || 0);
        }
        return marginal;
    };

    const remaining = [...eligible];
    while (remaining.length) {
        let best = null;
        for (const entry of remaining) {
            // Sharing *any* key is a conflict: one ability swap rules out both
            // the other swaps into the slot it empties and the other offers of
            // the book it buys
            if (isExclusive(entry.result.candidate) && entry.keys.some((key) => taken.has(key))) continue;
            if (spent + entry.result.cost > budget) continue;
            const marginal = marginalOf(entry);
            if (marginal <= 0) continue;
            const cost = entry.result.cost;
            // Gain per coin is meaningless at or below zero cost — everything
            // free ties at infinity and a refund divided by a small gain is
            // *more* negative the worse the row is. So the free-and-refunding
            // rows are taken first, biggest refund first, and only then does
            // the ratio decide among things that actually cost money
            const value = cost > 0 ? marginal / cost : Infinity;
            const contender = { entry, marginal, value, cost, free: cost <= 0 };
            if (!best) {
                best = contender;
            } else if (contender.free !== best.free) {
                if (contender.free) best = contender;
            } else if (contender.free) {
                if (contender.cost < best.cost || (contender.cost === best.cost && marginal > best.marginal)) {
                    best = contender;
                }
            } else if (value > best.value) {
                best = contender;
            }
        }
        if (!best) break;

        const { entry, marginal } = best;
        remaining.splice(remaining.indexOf(entry), 1);
        for (const key of entry.keys) taken.add(key);
        spent += entry.result.cost;
        picks.push({
            ...entry.result,
            marginalAttemptsSaved: marginal,
            rooms: entry.savings.filter((saving) => saving > 0).length,
        });

        const standing = bestBySlot.get(entry.key) || entry.savings.map(() => 0);
        bestBySlot.set(
            entry.key,
            standing.map((saving, index) => Math.max(saving, entry.savings[index]))
        );

        // A piece nobody would now wear is gold spent on nothing: if an earlier
        // pick in this group has been beaten in every room it covered, take it
        // back out and give the budget back
        for (let i = picks.length - 2; i >= 0; i--) {
            const older = picks[i];
            if (conflictKey(older.candidate) !== entry.key) continue;
            const olderSavings = savingsOf(older);
            if (olderSavings.every((saving, index) => saving <= (entry.savings[index] ?? 0) + 1e-9)) {
                spent -= older.cost;
                picks.splice(i, 1);
                skipped.push({ result: older, reason: 'a later pick covers every room it did' });
            }
        }
    }

    for (const entry of remaining) {
        let reason;
        if (isExclusive(entry.result.candidate) && entry.keys.some((key) => taken.has(key))) {
            // Otherwise this reads as "worthless", when it may well be the
            // second-best swap into a slot the plan has already filled
            reason = 'a pick already uses what this needs';
        } else if (spent + entry.result.cost > budget) {
            reason = 'over budget';
        } else {
            reason = 'adds nothing the picks do not already cover';
        }
        skipped.push({ result: entry.result, reason });
    }

    // What the set saves across the run, if gains in different slots add up
    let attemptsSaved = 0;
    for (const savings of bestBySlot.values()) {
        for (const saving of savings) attemptsSaved += saving;
    }

    return { picks, totalCost: spent, attemptsSaved, skipped, budget };
}

/**
 * What a budget plan's picks are worth bought *together*, rather than summed.
 *
 * `planUpgradeBudget` values every row against the same lone baseline, one at a
 * time — the right way to rank them, but not to add them up. Two upgrades can
 * trip the same accuracy threshold, compete for the same food or mana margin,
 * or feed the same stat, and the only way to see that is to wear all of them
 * at once and run the zone again. This is the labyrinth side's
 * `runLabyrinthCombinationCheck`, for the plain all-fights plan: one DTO, one
 * zone, one simulation.
 *
 * Same seed and the same zone/difficulty/hours/community-buffs as the passes
 * the plan was built from — carried in `context`, which is exactly what
 * `runUpgradeAnalysis` hands back alongside its rows — so the combined figure
 * is comparable to the summed one instead of being a fresh sample that differs
 * for its own reasons.
 *
 * `planWithinBudget`'s own bookkeeping keeps a second claim on one slot out of
 * the final picks (see its "gold spent on nothing" back-out), so two picks
 * sharing a `conflictKeys` slot should not reach here — but this runs
 * independently of how the plan was chosen, so a pair that does collide is
 * refused rather than silently having the second overwrite the first on the
 * DTO and print a number that was never actually simulated.
 *
 * @param {Array<Object>} picks - `plan.picks` from `planUpgradeBudget`
 * @param {Object} context - `{ gameData, playerDTOs, playerIndex, playerHrid, zoneHrid, difficultyTier, hours,
 *   communityBuffs, seed, precision, baselineResult, baseline }`, as returned by `runUpgradeAnalysis`
 * @returns {Promise<{ok: true, metrics: Object, deltas: Object, economics: Object, noise: Object,
 *   totalCost: number} | {ok: false, reason: string}>}
 */
export async function confirmUpgradeBudgetPlan(picks, context) {
    if (!picks?.length) return { ok: false, reason: 'The plan is empty — nothing to confirm.' };

    const {
        gameData,
        playerDTOs,
        playerIndex,
        playerHrid,
        zoneHrid,
        difficultyTier,
        hours,
        communityBuffs,
        seed,
        precision = null,
        baselineResult,
        baseline,
    } = context || {};
    if (!gameData || !playerDTOs?.[playerIndex] || !baselineResult || !baseline) {
        return { ok: false, reason: 'The analysis this plan came from is no longer available — run it again.' };
    }

    const candidates = picks.map((pick) => pick.candidate);

    // Any two picks sharing a conflict key would write to the same equipment
    // slot, ability, house room, shrine, community buff or scroll — the plan
    // may have chosen them for different loadouts, but there is only one DTO
    // here for both to share, and only one of them can actually be worn.
    const claimedBy = new Map();
    for (const candidate of candidates) {
        if (candidate.type === 'combat_level') {
            return {
                ok: false,
                reason: 'Combat levels are not a purchase and cannot be confirmed as part of a basket.',
            };
        }
        for (const key of conflictKeys(candidate)) {
            const holder = claimedBy.get(key);
            if (holder && holder !== candidate.description) {
                return {
                    ok: false,
                    reason:
                        `"${candidate.description}" and "${holder}" cannot both be worn at once, so this basket ` +
                        'cannot be simulated as one loadout.',
                };
            }
            claimedBy.set(key, candidate.description);
        }
    }

    let dto;
    let combinedBuffs = communityBuffs;
    try {
        dto = candidates.reduce((acc, candidate) => applyCandidateToDTO(acc, candidate), playerDTOs[playerIndex]);
        for (const candidate of candidates) combinedBuffs = applyCommunityBuffCandidate(combinedBuffs, candidate);
    } catch (error) {
        return { ok: false, reason: `Could not apply the basket together: ${error.message}` };
    }

    const combinedDTOs = playerDTOs.map((player, i) => (i === playerIndex ? dto : player));

    let combinedResult;
    try {
        combinedResult = await runSimulation(
            {
                gameData,
                playerDTOs: combinedDTOs,
                zoneHrid,
                difficultyTier,
                hours,
                communityBuffs: combinedBuffs,
                seed,
                isTaskFight: false,
                ...(precision ? { precision } : {}),
            },
            null,
            // One worker, same as the baseline and every candidate pass this is
            // being compared against — the shared seed only cancels sampling
            // noise while every run draws the same stream the same way (see the
            // note on the baseline call in `runUpgradeAnalysis`).
            { workers: 1 }
        );
    } catch (error) {
        return { ok: false, reason: `Simulating the basket failed: ${error.message}` };
    }

    const totalCost = picks.reduce((sum, pick) => sum + (Number.isFinite(pick.cost) ? pick.cost : 0), 0);
    const metrics = computeMetrics(combinedResult, gameData, playerHrid, hours);
    const deltas = computeDeltas(baseline, metrics);
    const economics = computeEconomics(totalCost, baseline, metrics);
    const noise = rateDeltaNoisePct(baselineResult, combinedResult, playerHrid);

    return { ok: true, metrics, deltas, economics, noise, totalCost };
}

/**
 * Run a job per item, several at a time.
 *
 * A labyrinth fight is its own worker with its own seed and its own trial count,
 * so ten fights are ten independent runs that were being done one after another
 * on a machine with eight cores idle. Bounded rather than all at once: each
 * worker gets its own copy of the game data, and a fleet of them competing for
 * one core apiece is slower than a queue.
 *
 * Results come back in the order the items were given, whatever order they
 * finished in — every figure downstream is indexed by fight.
 *
 * @param {Array} items - What to run
 * @param {Function} run - `(item, index) => Promise`
 * @param {number} [limit] - How many at once
 * @returns {Promise<Array>} Results, in input order
 */
async function mapConcurrent(items, run, limit = analysisConcurrency()) {
    const results = new Array(items.length);
    const width = Math.max(1, Math.min(limit, items.length));
    let next = 0;
    let failure = null;

    const lane = async () => {
        while (failure === null) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await run(items[index], index);
            } catch (error) {
                // Stop handing out work. Without this the other lanes keep
                // starting simulations for a run whose result has already been
                // thrown away — a failed analysis would go on spawning workers
                // for every fight it had left.
                failure = error;
            }
        }
    };

    await Promise.all(Array.from({ length: width }, lane));
    if (failure) throw failure;
    return results;
}

/**
 * How many simulations an analysis may have in flight at once.
 *
 * Capped, not simply "as many as there are cores". Each simulation is a Worker
 * that receives its own structured clone of the whole game data — every item,
 * ability, monster and action in the game — so the fleet costs memory in
 * proportion to its width. And the tab it is competing with is the game itself:
 * an analysis that takes every core makes the thing you are playing stutter,
 * which is a poor trade for a run finishing sooner.
 *
 * The tile badges and the skip-level searches also run labyrinth sims in the
 * background without asking anyone, so this is a budget for one analysis rather
 * than for the page.
 *
 * @returns {number} Simulations at once
 */
function analysisConcurrency() {
    const budget = getMaxWorkers();
    if (config.getSetting('combatSim_uncapThreads')) return Math.max(1, budget);
    return Math.max(1, Math.min(budget, ANALYSIS_MAX_CONCURRENCY));
}

/** Ceiling on simultaneous sims per analysis, whatever the thread setting says */
const ANALYSIS_MAX_CONCURRENCY = 6;

/** Expected labyrinth attempts to clear one fight (retry until win) */
function expectedFightAttempts(winRate) {
    return 1 / Math.max(winRate, ATTEMPT_WIN_RATE_FLOOR);
}

/** Weapon slots, for spotting a forced-armor candidate that also changes weapon */
const WEAPON_SLOTS = new Set([MAIN_HAND_SLOT, OFF_HAND_SLOT, TWO_HAND_SLOT]);

/**
 * What two candidates have to share before the all-fights pool treats them as
 * one purchase.
 *
 * `candidateAssignmentKey` is the general answer and is used for everything
 * else, but it keys an ability on the slot number it sat in and the level it was
 * generated at — and a swap pooled across a labyrinth is neither. "Replace Smack
 * with Quick Strike" is one decision whether Smack is in slot 2 of one loadout at
 * level 30 and slot 4 of another at level 12; keying on the slot would rank the
 * same decision twice, at twice the simulation cost, and split its rooms between
 * the two rows.
 *
 * @param {Object} candidate - Any upgrade candidate
 * @returns {string} Pool key
 */
function allFightsPoolKey(candidate) {
    if (candidate.type === 'ability_swap' && candidate.replacesHrid) {
        return `ability_swap:${candidate.replacesHrid}->${candidate.upgradeHrid}`;
    }
    // Filling a free slot is one decision too — "start casting Fireball" — and
    // the slot it lands in is whichever one each loadout has going spare
    if (candidate.type === 'ability_swap' && candidate.fillsFreeSlot) {
        return `ability_fill:${candidate.upgradeHrid}`;
    }
    return candidateAssignmentKey(candidate);
}

/**
 * Which build guide each distinct loadout in a run was read as playing.
 *
 * Ability Swaps asks a much smaller question when it can name the archetype —
 * the archetype's own ability set instead of every ability in the game — and
 * silently falls back to the wide search when it cannot. Pooling then merges
 * everything into one table, so the finished results carry no trace of which
 * loadouts got which question. That is exactly the thing a reader needs to know
 * before trusting a short swap list, and it costs one guide lookup per loadout
 * to say.
 *
 * One entry per distinct loadout name, in the order the fights name them, so a
 * ten-room run with three loadouts produces three lines rather than ten.
 *
 * @param {Array<Object>} fights - `[{ dto, loadoutName }]`
 * @param {Object} gameData - Game data payload
 * @param {boolean} auraOnly - Whether the run restricted swaps to the aura group only
 * @returns {Array<{loadoutName: string, archetype: string|null, label: string|null}>}
 */
function summariseArchetypes(fights, gameData, auraOnly) {
    const seen = new Map();
    for (const fight of fights || []) {
        const loadoutName = fight?.loadoutName || 'Loadout';
        if (seen.has(loadoutName)) continue;
        let plan = null;
        try {
            plan = buildGuidePlan(fight.dto, gameData, { auraOnly });
        } catch (error) {
            // A guide that cannot be read is the same answer as no archetype,
            // and is never worth failing a whole analysis over
            console.error('[UpgradeAdvisor] Archetype lookup failed for', loadoutName, error);
        }
        seen.set(loadoutName, {
            loadoutName,
            archetype: plan?.archetype ?? null,
            label: plan?.label ?? null,
        });
    }
    return [...seen.values()];
}

/**
 * A swap candidate as the whole-run table should carry it.
 *
 * The generated description ends in the level it was generated at — "Smack →
 * Quick Strike (Lv30)" — which is a promise the multi-fight run does not keep:
 * the newcomer is simmed at whatever level the loadout it lands in holds the
 * replaced ability at, which is the point of the rule and different in every
 * room. So the level comes off the description and goes into a caveat that also
 * says what the cost was priced from.
 *
 * @param {Object} candidate - An `ability_swap` candidate from `generateCandidates`
 * @param {Object} gameData - For ability names
 * @returns {Object} A copy fit for pooling
 */
function pooledSwapCandidate(candidate, gameData) {
    const nameOf = (hrid) =>
        gameData?.abilityDetailMap?.[hrid]?.name ||
        String(hrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ');
    // A fill displaces nothing, so there is no "X → Y" to draw and its own
    // description already says what it is
    if (candidate.fillsFreeSlot) {
        return {
            ...candidate,
            description: `Free slot → ${nameOf(candidate.upgradeHrid)}`,
            caveat:
                'Weighed in every loadout with a slot free for it, at the level of the book you own. The cost is ' +
                'for taking that book to the level shown.',
        };
    }
    return {
        ...candidate,
        description: `${nameOf(candidate.replacesHrid || candidate.currentHrid)} → ${nameOf(candidate.upgradeHrid)}`,
        caveat:
            'Weighed in every loadout that casts the ability it replaces, each at the level that loadout holds it ' +
            'at, with default triggers. The cost is for the highest of those levels.',
    };
}

/**
 * A forced labyrinth armor candidate as a whole-run candidate.
 *
 * Two things are added to it. The keep-gear rule, which is the same one the
 * single-fight analysis applies: these swaps are usually an added purchase
 * rather than a trade-in, because the labyrinth wants every element available,
 * so the replaced pieces are recorded as kept and their resale is not credited
 * against the price. And, when the candidate carries a weapon, the weapon the
 * loadout it came from was holding — which is what stops the set being installed
 * in a loadout that fights with something else entirely.
 *
 * @param {Object} candidate - From `generateLabArmorCandidates`
 * @param {Object} dto - The loadout it was generated for
 * @param {boolean} keepReplaced - The `labSim_keepReplacedGear` setting
 * @returns {Object} A copy fit for pooling
 */
function labArmorForLoadout(candidate, dto, keepReplaced) {
    const pooled = { ...candidate };
    if (keepReplaced) {
        pooled.keptItems = pooled.removedItems;
        pooled.removedItems = [];
    }
    const weaponSlot = Object.keys(pooled.addedSlots || {}).find((slot) => WEAPON_SLOTS.has(slot));
    if (weaponSlot) {
        pooled.labArmorWeapon = { slot: weaponSlot, hrid: dto?.equipment?.[weaponSlot]?.hrid || null };
    }
    return pooled;
}

/**
 * Sims a whole-run analysis will plan before it starts trading trial length for
 * coverage.
 *
 * Ability swaps put this analysis in a different size class: one candidate per
 * style-compatible ability per slot, pooled across a labyrinth's worth of
 * loadouts. The wrong way to handle that is to sim a sample of the fights, which
 * would leave rows whose headline number — attempts to clear *every* fight —
 * silently referred to some other, smaller labyrinth. So every fight a candidate
 * is about is always simulated, and what gives instead is how long each
 * simulation runs. A shorter run is a noisier win rate, and the noise is already
 * measured, carried on the row and used to grey out gains it swallows.
 */
export const ALL_FIGHTS_SIM_BUDGET = 500;

/** However large the run, no fight is simmed on less than this share of the asked-for hours */
export const MIN_TRIAL_FRACTION = 0.25;

/**
 * How long each simulation in a whole-run analysis gets.
 *
 * @param {number} sims - Simulations the run has planned
 * @param {number} hours - Hours per fight the player asked for
 * @returns {{scale: number, hours: number, reduced: boolean}}
 */
export function labAllFightsTrialBudget(sims, hours) {
    const scale = sims > ALL_FIGHTS_SIM_BUDGET ? Math.max(MIN_TRIAL_FRACTION, ALL_FIGHTS_SIM_BUDGET / sims) : 1;
    return { scale, hours: hours * scale, reduced: scale < 1 };
}

/**
 * Sim every labyrinth combat room — each with its assigned loadout at its
 * skip-derived room level — under each combat-level boost, to rank which
 * skill level upgrade improves the whole run the most. The collective metric
 * is the expected number of combat attempts to clear every fight (Σ 1/win
 * rate — the labyrinth lets you retry a failed room), which naturally weights
 * the worst fights. The all-fights-in-one-go product (run clear chance) is
 * also returned but is near zero whenever several fights sit below ~50%.
 *
 * Candidates are the union of style-relevant skills across all fight loadouts
 * (loadouts can differ in style, e.g. a ranged loadout for one monster and a
 * melee loadout for another), so a skill shows if any assigned loadout trains it.
 *
 * Each is then measured only against the fights it is actually about — see
 * `candidateAppliesToDTO`. A combat level is every fight; a piece of gear is the
 * fights whose loadout wears what it replaces, and the rest keep their baseline
 * untouched rather than being simulated wearing something they would never wear.
 *
 * Two candidate sets need more than the generator gives them, and get it here:
 * the forced labyrinth armor sets — the Anchorbound plate, the elemental robes,
 * and the combined weapon-and-robes swaps that read as one row — which the tier
 * progression can never reach and which are priced without crediting the resale
 * of what they replace; and ability swaps, pooled by the ability they replace
 * rather than by the slot it sat in. Both are per loadout, since which set or
 * which swap a room wants depends on what that room's loadout is holding.
 *
 * Labyrinth token buffs are the third set that needs handling of its own, and
 * for a different reason: a token buff is not on the character at all. It is an
 * argument to the simulation — an entry in `labyrinthCombatBuffs` — so
 * `applyCandidateToDTO` has nothing to write and the shared pooling path would
 * have simulated the unchanged loadout for every one of them. That, rather than
 * anything about scope, is what kept them to the Configure fight. They are what
 * the whole-run question suits best: a token level is bought once and paid for
 * in every room, so it is simulated against every fight and aggregated exactly
 * like a combat level, and ranked in its own currency rather than against gold.
 *
 * The size that comes with all that is paid for in trial length rather than in
 * coverage — see `labAllFightsTrialBudget`. A fight a candidate touches is
 * always simulated.
 *
 * @param {Object} params - { fights, crates, hours, communityBuffs, labyrinthCombatBuffs, abilityTargetLevel,
 *   combatLevelTargets, auraSwapsOnly, houseTargetLevel, houseTargets, guildShrineTargetLevel,
 *   guildShrineTargets, guildShrineCapToGuild, tokenLevels }
 *   where fights = [{ monsterHrid, monsterName, roomLevel, dto, loadoutName }]
 * @param {Function} onProgress - Called with { current, total, description }, and
 *   once before anything runs with a `plan` of what the run comes to
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline: { fights, runClearChance, expectedAttempts },
 *   results: [{candidate, fights, costDetail, runClearChance, runClearDelta, expectedAttempts,
 *   attemptsDelta, avgWinDelta}], budget }
 */
export async function runLabyrinthAllFightsAnalysis(params, onProgress, options = {}) {
    const {
        fights,
        crates,
        hours,
        precision = null,
        communityBuffs,
        labyrinthCombatBuffs = [],
        abilityTargetLevel,
        combatLevelTargets,
        abilityTargets,
        modes = ['combat_level'],
        auraSwapsOnly = false,
        houseTargetLevel = 0,
        houseTargets = null,
        guildShrineTargetLevel = 0,
        guildShrineTargets = null,
        guildShrineCapToGuild = false,
        tokenLevels = null,
        extraCandidates = [],
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';

    // The union of candidates across every fight's loadout.
    //
    // Union rather than per-fight, because the question is what to buy — one
    // thing, once, that has to serve every room. A candidate generated from the
    // Cyclops loadout is still worth simming against the Mimic, and the two
    // loadouts usually differ in only a slot or two.
    //
    // Keyed by what the candidate actually changes rather than by skill, since
    // combat levels are one per skill but equipment is many per slot.
    const candidatesByKey = new Map();
    /**
     * Add one candidate to the pool, or reconcile it with the one already there.
     * @param {Object} candidate - From a generator
     */
    const pool = (candidate) => {
        const key = allFightsPoolKey(candidate);
        const existing = candidatesByKey.get(key);
        if (!existing) {
            candidatesByKey.set(key, candidate);
            return;
        }
        // The same swap out of two loadouts that hold the replaced ability at
        // different levels. The books are bought once, to the highest of them —
        // costing it from whichever loadout happened to be generated first
        // would undercount the purchase for every other room.
        if (candidate.type === 'ability_swap' && (candidate.upgradeLevel || 0) > (existing.upgradeLevel || 0)) {
            candidatesByKey.set(key, candidate);
        }
    };

    const keepReplacedGear = config.getSettingValue('labSim_keepReplacedGear', true);
    const inventory = dataManager.getInventory();

    for (const fight of fights) {
        for (const mode of modes) {
            const fightCandidates = generateCandidates(
                fight.dto,
                gameData,
                mode,
                abilityTargetLevel,
                'increment',
                false,
                combatLevelTargets,
                abilityTargets,
                houseTargetLevel,
                houseTargets,
                null,
                guildShrineTargetLevel,
                // Every row in this table is ranked on attempts to clear, so a
                // house room that can only move XP or loot is a row that can
                // only report the sims' own noise
                { auraSwapsOnly, houseWinRateOnly: true, guildShrineTargets, guildShrineCapToGuild }
            );
            for (const candidate of fightCandidates) {
                pool(candidate.type === 'ability_swap' ? pooledSwapCandidate(candidate, gameData) : candidate);
            }
        }
        // The labyrinth lives or dies on body and legs, and the tier progression
        // only ever steps one rung from what is worn — so the Anchorbound plate,
        // the elemental sets and the two-piece combinations of them are forced in
        // here exactly as they are for a single fight. Per loadout, because which
        // set a loadout wants depends on the element it casts.
        if (modes.includes('equipment')) {
            for (const candidate of generateLabArmorCandidates(fight.dto, gameData, inventory)) {
                pool(labArmorForLoadout(candidate, fight.dto, keepReplacedGear));
            }
        }
    }
    for (const candidate of extraCandidates) {
        const key = allFightsPoolKey(candidate);
        if (!candidatesByKey.has(key)) candidatesByKey.set(key, candidate);
    }
    // Which archetype each loadout resolved to, for the panel to say out loud.
    // The guide narrows a loadout's swaps from every ability in the game to the
    // archetype's own set, and a loadout whose weapon does not name one falls
    // back to the wide search — a difference of thousands of simulations and of
    // what the table can be trusted to have looked at. After pooling, nothing in
    // the results says which loadout went which way.
    const archetypes = modes.includes('ability_swap') ? summariseArchetypes(fights, gameData, auraSwapsOnly) : [];
    // Which fights each candidate is actually about. A combat level is every
    // fight; a piece of gear is only the fights whose loadout wears the piece it
    // replaces — installing a melee sword into a magic loadout measures a
    // costume change, not an upgrade, and drags the aggregate with it.
    const candidates = [...candidatesByKey.values()]
        .map((candidate) => ({
            ...candidate,
            cost: candidate.cost ?? calculateUpgradeCost(candidate, gameData),
            appliesTo: fights.map((fight) => candidateAppliesToDTO(candidate, fight.dto, gameData)),
        }))
        .filter((candidate) => candidate.appliesTo.some(Boolean));

    // Labyrinth token buffs. Character-wide and not held in a loadout at all —
    // they are an argument to the simulation rather than a change to the DTO —
    // so they are pooled once rather than per fight, and every fight is one of
    // the fights they are about. Only the combat half: the skilling and
    // experience tokens move numbers this table does not have a column for.
    const tokenCandidates = modes.includes('labyrinth_buff')
        ? generateLabyrinthBuffCandidates(tokenLevels)
              .filter((candidate) => candidate.category === 'combat')
              .map((candidate) => ({ ...candidate, cost: null, appliesTo: fights.map(() => true) }))
        : [];

    // Only the fights a candidate touches are simulated; the rest keep their
    // baseline, which is both the truth and a great deal less work
    const simsPerCandidate = [...candidates, ...tokenCandidates].reduce(
        (sum, c) => sum + c.appliesTo.filter(Boolean).length,
        0
    );
    const total = fights.length + simsPerCandidate;
    // What a big run gives up. Never a fight — every fight a candidate is about
    // is simulated, or its row would be answering a different question from the
    // one its column headings ask — but each simulation may be shorter.
    const budget = labAllFightsTrialBudget(total, hours);
    const simHours = budget.hours;
    // An object rather than a counter variable: the fight passes run
    // concurrently and close over it, and a plain `let` shared by closures
    // inside a loop is exactly the shape lint is right to be suspicious of
    const progress = { current: 0 };

    // Said before any of it runs, and said as a count rather than a promise:
    // this is the one moment where a run that is going to take a long time can
    // still be stopped by somebody who did not mean to ask for it.
    onProgress?.({
        current: 0,
        total,
        description: `${candidates.length + tokenCandidates.length} upgrades × ${fights.length} fights = ${total} sims`,
        plan: {
            candidates: candidates.length + tokenCandidates.length,
            fights: fights.length,
            sims: total,
            hours: simHours,
            requestedHours: hours,
            trialScale: budget.scale,
            reduced: budget.reduced,
        },
    });

    // Per-fight seeds derived from one analysis seed: fight N is simmed with the
    // same random draws in the baseline pass and in every candidate pass, so a
    // win-rate delta is the level boost rather than two independent samples
    const simSeed = analysisSeed();
    const fightSeed = (fightIndex) => deriveSeed(simSeed, fightIndex);

    // A fight's baseline pass sets the fight count every candidate pass for
    // that fight must match, so each comparison stays paired
    const pairedRules = new Map();
    const simFightWinRate = async (fight, dtoOverride, seed, fightIndex, buffsOverride = null) => {
        const rule = pairedRules.get(fightIndex) || null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dtoOverride || fight.dto],
            zoneHrid,
            monsterHrid: fight.monsterHrid,
            roomLevel: fight.roomLevel,
            crates,
            hours: rule ? simHours * PAIRED_TIME_HEADROOM : simHours,
            // Candidates reuse the fight's paired rule; the baseline pass (rule
            // null) takes the tab's precision/max-fights so it sets the count.
            precision: rule || precision,
            communityBuffs,
            // A token buff is not on the loadout, so it arrives here rather than
            // through the DTO — the one candidate set that changes the run
            // without changing the character
            labyrinthCombatBuffs: buffsOverride || labyrinthCombatBuffs,
            seed,
        });
        const attempts = simResult.labyAttemptCount || 1;
        if (!rule) pairedRules.set(fightIndex, pairedTrialRule(simResult));
        return { winRate: (simResult.encounters || 0) / attempts, trials: attempts };
    };

    const fightMeta = (fight) => ({
        monsterHrid: fight.monsterHrid,
        monsterName: fight.monsterName,
        roomLevel: fight.roomLevel,
        loadoutName: fight.loadoutName,
    });

    // Baseline pass: every fight with its current levels. Fights are independent
    // — their own worker, their own seed — so they run several at a time.
    if (abortSignal?.()) return { baseline: null, results: [] };
    onProgress?.({ current: progress.current, total, description: `Baseline: ${fights.length} fights` });
    const baselineFights = await mapConcurrent(fights, async (fight, i) => {
        if (abortSignal?.()) return { ...fightMeta(fight), winRate: 0, trials: 1 };
        const { winRate, trials } = await simFightWinRate(fight, null, fightSeed(i), i);
        progress.current++;
        onProgress?.({ current: progress.current, total, description: `Baseline: ${fight.monsterName}` });
        return { ...fightMeta(fight), winRate, trials };
    });
    if (abortSignal?.()) return { baseline: null, results: [] };
    const baselineRunClear = baselineFights.reduce((product, f) => product * f.winRate, 1);
    const baselineAttempts = baselineFights.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);

    // One pass per candidate, over the fights that candidate is about
    const results = [];
    for (const candidate of [...candidates, ...tokenCandidates]) {
        const isToken = candidate.type === 'labyrinth_buff';
        // Built once per candidate rather than once per fight: the buff array is
        // the same in every room, and rebuilding it per fight would deep-copy
        // the whole thing a labyrinth's worth of times
        const tokenBuffs = isToken ? buildModifiedCombatBuffs(labyrinthCombatBuffs, candidate) : null;
        let aborted = false;
        const fightResults = await mapConcurrent(fights, async (fight, i) => {
            if (abortSignal?.()) {
                aborted = true;
                return { ...fightMeta(fight), winRate: baselineFights[i].winRate, winRateDelta: 0, applied: false };
            }
            // A fight this upgrade does not reach keeps its baseline exactly —
            // no sim, because there is nothing to find out
            if (!candidate.appliesTo[i]) {
                return {
                    ...fightMeta(fight),
                    winRate: baselineFights[i].winRate,
                    winRateDelta: 0,
                    applied: false,
                };
            }
            const boostedDTO = isToken ? null : applyCandidateToDTO(fight.dto, candidate);
            const { winRate, trials } = await simFightWinRate(fight, boostedDTO, fightSeed(i), i, tokenBuffs);
            progress.current++;
            onProgress?.({
                current: progress.current,
                total,
                description: `${candidate.description}: ${fight.monsterName}`,
            });
            return {
                ...fightMeta(fight),
                winRate,
                trials,
                winRateDelta: winRate - baselineFights[i].winRate,
                applied: true,
                // What it goes in place of *here* — with one purchase serving
                // several loadouts, that is not the same piece in every room
                replaced: isToken ? null : replacedIn(candidate, fight.dto, gameData),
            };
        });
        if (aborted) break;

        const applied = fightResults.filter((f) => f.applied);
        const runClearChance = fightResults.reduce((product, f) => product * f.winRate, 1);
        const expectedAttempts = fightResults.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);
        const attemptsDeltaNoise = attemptsNoise(applied, baselineFights);
        // Averaged over the rooms it reaches rather than every room: a weapon
        // that only goes in two of eight loadouts is not a quarter as good at
        // its job, and dividing by eight would say it was
        const avgWinDelta = applied.reduce((sum, f) => sum + f.winRateDelta, 0) / (applied.length || 1);
        const attemptsDelta = expectedAttempts - baselineAttempts;
        const cost = candidate.cost;
        // Attempts saved across a whole run, per billion coins. The figure the
        // question actually asks: a cheap thing that helps a little can beat an
        // expensive thing that helps a lot, and a ranking by raw gain never
        // says so. Candidates with no gold price — a combat level costs
        // experience — get null rather than a zero that would sort them last.
        const attemptsSaved = -attemptsDelta;
        const perGold = valuePerMillion(cost, attemptsSaved);

        results.push({
            candidate,
            fights: fightResults,
            // What the row is paid in, which is what decides the section it is
            // drawn in and the columns that section carries
            costType: isToken ? 'token' : 'gold',
            tokenCost: isToken ? candidate.tokenCost : null,
            // Attempts saved across the run per hundred guild tokens. The token
            // half of `attemptsSavedPerMillion`, in the only currency these rows
            // can be compared in — a token buff has no gold price at all.
            attemptsSavedPerHundredTokens:
                isToken && candidate.tokenCost > 0 ? (attemptsSaved / candidate.tokenCost) * 100 : null,
            // Only where there is something in the breakdown a price alone does
            // not say — the forced armor sets, whose replaced pieces are kept
            // rather than sold, so the row's coin figure is deliberately gross.
            // Pricing every row would put a market lookup per piece behind a
            // table that can run to hundreds of rows.
            costDetail: candidate.keptItems?.length ? explainLabCandidateCost(candidate, gameData) : null,
            appliedFights: applied.length,
            runClearChance,
            runClearDelta: runClearChance - baselineRunClear,
            expectedAttempts,
            attemptsDelta,
            attemptsDeltaNoise,
            // A gain smaller than the sampling error of the sims it came from is
            // not a gain that has been measured, whatever the number says
            significant: Math.abs(attemptsDelta) > SIGNIFICANCE_Z * attemptsDeltaNoise,
            avgWinDelta,
            cost,
            attemptsSavedPerMillion: perGold,
        });
    }

    // Best value first where there is a price, then the priceless ones by raw
    // gain — a combat level and a helmet cannot be ranked against each other in
    // coins, and pretending otherwise would bury one of them
    results.sort((a, b) => {
        const priced = (result) => (result.attemptsSavedPerMillion === null ? 1 : 0);
        return (
            priced(a) - priced(b) ||
            (b.attemptsSavedPerMillion ?? 0) - (a.attemptsSavedPerMillion ?? 0) ||
            a.attemptsDelta - b.attemptsDelta
        );
    });

    return {
        baseline: { fights: baselineFights, runClearChance: baselineRunClear, expectedAttempts: baselineAttempts },
        results,
        // What the run cost and what it gave up to fit — read by the panel for
        // its status line, so a table drawn from shortened sims says so
        budget: {
            candidates: candidates.length,
            fights: fights.length,
            sims: total,
            hours: simHours,
            requestedHours: hours,
            trialScale: budget.scale,
            reduced: budget.reduced,
        },
        // Which build guide each loadout was read as playing — see
        // `summariseArchetypes`. Empty when swaps were not part of the run.
        archetypes,
        // Handed back so a combination check re-runs against the same random
        // draws and the same trial counts, rather than against a fresh sample
        pairing: { seed: simSeed, rules: [...pairedRules.entries()] },
        context: { fights, crates, hours: simHours, communityBuffs, labyrinthCombatBuffs },
    };
}

/**
 * What a set of upgrades is worth bought *together*.
 *
 * Every row in the table was measured on its own against the same baseline, and
 * that is the right way to rank them — but it is the wrong way to add them up.
 * Two upgrades that both rescue the same failing room each get credited with
 * rescuing it, and the sum promises a saving neither the pair nor anything else
 * will deliver. The overlap can only be found by running them together.
 *
 * The same seed and the same trial counts as the analysis it came from, so the
 * combined figure is comparable with the individual ones rather than being a
 * fresh sample that differs for its own reasons.
 *
 * @param {Object} params - `{ picks, baseline, pairing, context }` from an
 *   all-fights analysis, where `picks` are the results to install together
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal }
 * @returns {Promise<Object>} `{ fights, expectedAttempts, attemptsDelta,
 *   summedDelta, overlap }` — overlap is how much of the promised saving the
 *   upgrades take from each other
 */
export async function runLabyrinthCombinationCheck(params, onProgress, options = {}) {
    const { picks, baseline, pairing, context } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');
    if (!picks?.length || !baseline?.fights?.length) throw new Error('Nothing to check');

    const { fights, crates, hours, communityBuffs, labyrinthCombatBuffs = [] } = context || {};
    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';
    const rules = new Map(pairing?.rules || []);
    const total = fights.length;
    let current = 0;

    const fightResults = [];
    for (let i = 0; i < fights.length; i++) {
        if (abortSignal?.()) return null;
        const fight = fights[i];
        onProgress?.({ current, total, description: `Together: ${fight.monsterName}` });

        // Every pick that belongs in this loadout goes on at once — that is the
        // whole question. Two picks for the same slot are not both worn: the
        // room wears whichever of them is better *here*, which is exactly how
        // the plan valued the second one.
        const bySlot = new Map();
        for (const pick of picks) {
            if (!candidateAppliesToDTO(pick.candidate, fight.dto, gameData)) continue;
            const key = conflictKey(pick.candidate);
            const standing = bySlot.get(key);
            const gain = pick.fights?.[i]?.winRateDelta ?? 0;
            if (!standing || gain > standing.gain) bySlot.set(key, { pick, gain });
        }

        let dto = fight.dto;
        const installed = [];
        for (const { pick } of bySlot.values()) {
            // Re-checked against the loadout as it now stands: a swap can fill a
            // hand that was empty when the picks were chosen
            if (!candidateAppliesToDTO(pick.candidate, dto, gameData)) continue;
            dto = applyCandidateToDTO(dto, pick.candidate);
            installed.push(pick.candidate.description);
        }

        const rule = rules.get(i) || null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dto],
            zoneHrid,
            monsterHrid: fight.monsterHrid,
            roomLevel: fight.roomLevel,
            crates,
            hours: rule ? hours * PAIRED_TIME_HEADROOM : hours,
            precision: rule,
            communityBuffs,
            labyrinthCombatBuffs,
            seed: deriveSeed(pairing?.seed ?? null, i),
        });
        const attempts = simResult.labyAttemptCount || 1;
        const winRate = (simResult.encounters || 0) / attempts;

        fightResults.push({
            monsterHrid: fight.monsterHrid,
            monsterName: fight.monsterName,
            roomLevel: fight.roomLevel,
            loadoutName: fight.loadoutName,
            winRate,
            trials: attempts,
            winRateDelta: winRate - (baseline.fights[i]?.winRate ?? 0),
            installed,
        });
        current++;
    }

    const expectedAttempts = fightResults.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);
    const attemptsDelta = expectedAttempts - baseline.expectedAttempts;
    const summedDelta = picks.reduce((sum, pick) => sum + pick.attemptsDelta, 0);

    return {
        fights: fightResults,
        expectedAttempts,
        attemptsDelta,
        summedDelta,
        // Positive means the set delivers less than the parts promised, which is
        // the usual direction: two fixes for one room cannot both be the fix
        overlap: attemptsDelta - summedDelta,
        noise: attemptsNoise(fightResults, baseline.fights),
    };
}

// ─── Editor-Based Skilling Analysis ──────────────────────────────────────────

const SKILLING_DTO_KEYS = {
    '/skills/woodcutting': 'woodcuttingLevel',
    '/skills/foraging': 'foragingLevel',
    '/skills/milking': 'milkingLevel',
    '/skills/cooking': 'cookingLevel',
    '/skills/brewing': 'brewingLevel',
    '/skills/cheesesmithing': 'cheesesmithingLevel',
    '/skills/crafting': 'craftingLevel',
    '/skills/tailoring': 'tailoringLevel',
    '/skills/alchemy': 'alchemyLevel',
    '/skills/enhancing': 'enhancingLevel',
};

/**
 * Overrides for one skill, including the guild shrine levels the editor is set to.
 *
 * `getSkillingMetricsFromOverrides` otherwise reads the character's live guild
 * buffs straight off the data manager, which is right until the editor is asking
 * "what if this shrine were a level higher" — then the live read would quietly
 * hold every candidate at the current level. Passing the levels rather than
 * finished buffs lets it keep the server's own numbers for every shrine that has
 * not been touched.
 *
 * @param {Object} editorState - `{ equipment, houseRooms, tokenUpgrades, communityBuffLevels }`
 * @param {Object} editorDTO - The editor's player, for its shrine levels
 * @param {string} actionTypeHrid - e.g. '/action_types/woodcutting'
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @returns {Object} Overrides for getSkillingMetricsFromOverrides()
 */
function skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData) {
    const overrides = { ...buildOverridesForSkill(editorState, actionTypeHrid, crateHrids, gameData) };
    if (editorDTO?.guildShrineLevels) overrides.guildShrineLevels = editorDTO.guildShrineLevels;
    return overrides;
}

/**
 * Compute per-skill clear results from editor state.
 * @param {number} roomLevel
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [skillEquipmentMap] - Per-skill equipment overrides { '/skills/X': { slot: { hrid, enhancementLevel } } }
 * @returns {Array<Object>} Per-skill results with skill name, clear chance, etc.
 */
export function computeSkillingClearRatesFromEditor(
    roomLevel,
    editorDTO,
    crateHrids,
    gameData,
    skillEquipmentMap = {}
) {
    const results = [];

    for (const skillHrid of LABYRINTH_SKILLS) {
        const skillId = skillHrid.replace('/skills/', '');
        const skillName = skillId.charAt(0).toUpperCase() + skillId.slice(1);
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) {
            results.push({
                clearChance: 0,
                expectedSeconds: Infinity,
                skipped: true,
                roomLevel: 0,
                baseLevel,
                effectiveLevel: baseLevel,
                successChance: 0,
                attempts: 0,
                skillHrid,
                skillId,
                skillName,
            });
            continue;
        }

        const actionTypeHrid = `/action_types/${skillId}`;
        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = (labyrinthClearRate() || bundledLabyrinthClearRate).getSkillingMetricsFromOverrides(
            skillId,
            actionTypeHrid,
            overrides
        );

        let result;
        if (skillHrid === '/skills/enhancing') {
            result = (labyrinthClearRate() || bundledLabyrinthClearRate).computeEnhancingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            );
        } else {
            result = (labyrinthClearRate() || bundledLabyrinthClearRate).computeSkillingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            );
        }
        result.skillHrid = skillHrid;
        result.skillId = skillId;
        result.skillName = skillName;
        result.roomLevel = skillRoomLevel;
        results.push(result);
    }

    return results;
}

/**
 * Compute average skilling clear rate from editor state.
 * @param {number} roomLevel
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [options]
 * @param {Object} [options.metricOverride] - { key, delta } to add to one metric across all skills
 * @param {Object} [options.skillEquipmentMap] - Per-skill equipment overrides
 * @returns {number} Average clear rate (0-1)
 */
/**
 * Resolve the room level for a skill: roomLevel may be a single number or a
 * per-skill map { [skillHrid]: level } built from the automation skip levels.
 * @param {number|Object} roomLevel
 * @param {string} skillHrid
 * @returns {number} Room level (0 = skill is skipped)
 */
function resolveSkillRoomLevel(roomLevel, skillHrid) {
    if (roomLevel && typeof roomLevel === 'object') {
        return Math.max(0, Math.floor(Number(roomLevel[skillHrid]) || 0));
    }
    return Math.max(0, Math.floor(Number(roomLevel) || 0));
}

function computeAverageSkillingClearRateFromEditor(roomLevel, editorDTO, crateHrids, gameData, options = {}) {
    const { metricOverride = null, skillEquipmentMap = {}, targetSkill = null } = options;

    let total = 0;
    let count = 0;

    const skillsToEval = targetSkill ? [targetSkill] : LABYRINTH_SKILLS;

    for (const skillHrid of skillsToEval) {
        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) continue; // Skill room is skipped

        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = (labyrinthClearRate() || bundledLabyrinthClearRate).getSkillingMetricsFromOverrides(
            skillId,
            actionTypeHrid,
            overrides
        );

        if (metricOverride) {
            metrics[metricOverride.key] = (metrics[metricOverride.key] || 0) + metricOverride.delta;
        }

        let clearChance;
        if (skillHrid === '/skills/enhancing') {
            clearChance = (labyrinthClearRate() || bundledLabyrinthClearRate).computeEnhancingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            ).clearChance;
        } else {
            clearChance = (labyrinthClearRate() || bundledLabyrinthClearRate).computeSkillingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            ).clearChance;
        }

        total += clearChance;
        count++;
    }

    return count > 0 ? total / count : 0;
}

/**
 * Average XP a cleared skilling room awards, across the rooms being run.
 *
 * Enhancing rooms used to be skipped here, because
 * `computeEnhancingClearWithParams` reported no `xpPerRoom` and averaging a
 * zero in would have understated every other room. It reports one now, so the
 * skip has become the bug it was guarding against: an enhancing room in the run
 * contributed nothing to the XP metric, and the Experience token and shrine
 * rows — which are ranked on exactly this number — were valued as though a
 * tenth of the run awarded no experience.
 * @param {number|Object} roomLevel - One level, or a per-skill map
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [options] - { skillEquipmentMap, targetSkill }
 * @returns {number} Average XP per room (0 when no room qualifies)
 */
function computeAverageSkillingXpPerRoomFromEditor(roomLevel, editorDTO, crateHrids, gameData, options = {}) {
    const { skillEquipmentMap = {}, targetSkill = null } = options;

    let total = 0;
    let count = 0;

    const skillsToEval = targetSkill ? [targetSkill] : LABYRINTH_SKILLS;

    for (const skillHrid of skillsToEval) {
        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) continue;

        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = (labyrinthClearRate() || bundledLabyrinthClearRate).getSkillingMetricsFromOverrides(
            skillId,
            actionTypeHrid,
            overrides
        );
        // Enhancing clears on its own model, and now reports XP from it
        const result =
            skillHrid === '/skills/enhancing'
                ? (labyrinthClearRate() || bundledLabyrinthClearRate).computeEnhancingClearWithParams(
                      metrics,
                      baseLevel,
                      skillRoomLevel
                  )
                : (labyrinthClearRate() || bundledLabyrinthClearRate).computeSkillingClearWithParams(
                      metrics,
                      baseLevel,
                      skillRoomLevel
                  );

        total += result.xpPerRoom || 0;
        count++;
    }

    return count > 0 ? total / count : 0;
}

/**
 * Generate labyrinth buff candidates from editor token upgrade levels.
 *
 * The Experience token comes along despite not being category 'skilling'. It
 * buys no clear rate at all — every other row here is ranked by that — so it
 * used to fall out of both filters and never appear anywhere, which read as
 * "not worth buying" rather than "measured against the wrong yardstick". Its
 * rows are scored on XP per room instead.
 * @param {Object} tokenUpgrades - { speed, efficiency, success, doubleProgress, experience }
 * @returns {Array} Buff candidates with type 'labyrinth_buff'
 */
export function generateLabyrinthBuffCandidatesFromEditor(tokenUpgrades) {
    const skillingDefs = LABYRINTH_BUFF_DEFS.filter((d) => d.category === 'skilling' || d.category === 'experience');
    const editorKeyMap = {
        labyrinthSkillActionSpeedLevel: 'speed',
        labyrinthSkillingEfficiencyLevel: 'efficiency',
        labyrinthSkillingSuccessLevel: 'success',
        labyrinthSkillingDoubleProgressLevel: 'doubleProgress',
        labyrinthExperienceLevel: 'experience',
    };

    const candidates = [];
    for (const def of skillingDefs) {
        const editorKey = editorKeyMap[def.key];
        const currentLevel = Math.max(0, Math.floor(Number(tokenUpgrades?.[editorKey]) || 0));
        if (currentLevel >= def.maxLevel) continue;

        candidates.push({
            type: 'labyrinth_buff',
            category: def.category,
            buffKey: def.key,
            editorKey,
            currentLevel,
            step: def.step,
            tokenCost: def.tokenCost * (currentLevel + 1),
            description: `${def.name} Lv${currentLevel}\u2192${currentLevel + 1}`,
            metric: def.metric,
        });
    }
    return candidates;
}

/** Noncombat stat keys the skilling clear-rate model reads, by suffix. */
const CLEAR_RATE_STAT_SUFFIX = /(Speed|Efficiency|Success)$/;

/**
 * Whether enhancing this item can move the skilling clear-rate metric at all.
 *
 * The escalation loop in `runSkillingUpgradeAnalysis` raises a candidate's
 * target level one step at a time until the clear rate moves, which assumes the
 * item carries a stat the clear-rate model can see — speed, efficiency, success
 * or gathering quantity (see `skilling-sim-helpers.js`, which builds the metric
 * from exactly those four equipment parses). An item whose noncombat stats are
 * all invisible to that model — a Philosopher's accessory carries only
 * experience — can never move it at any level, and the loop walked such
 * candidates all the way to +20, requoting the row at a cost twenty levels
 * deep for a delta that stayed zero.
 *
 * Base stats and enhancement bonuses both count: a piece whose base is zero can
 * still grow a measurable stat as it is enhanced.
 *
 * @param {Object} itemDetails - `itemDetailMap` entry for the candidate's upgrade item
 * @returns {boolean} Whether raising its enhancement level could change clear rate
 */
export function canMoveSkillingClearRate(itemDetails) {
    const detail = itemDetails?.equipmentDetail;
    for (const stats of [detail?.noncombatStats, detail?.noncombatEnhancementBonuses]) {
        for (const [key, value] of Object.entries(stats || {})) {
            if (!(value > 0)) continue;
            if (CLEAR_RATE_STAT_SUFFIX.test(key) || key === 'gatheringQuantity') return true;
        }
    }
    return false;
}

/**
 * Generate skilling equipment enhancement candidates from editor equipment.
 * Considers per-skill equipment overrides to find all unique items that need
 * upgrading. When targetSkill is set, only the gear actually worn for that
 * skill's room (its loadout override, or the base equipment) is considered.
 * @param {Object} editorDTO - Player DTO from editor
 * @param {Object} gameData - From buildGameDataPayload()
 * Every candidate carries a `costDetail` beside its `cost`, so a Skilling row can
 * be expanded into what it is actually buying the way a combat row can. Without
 * it the Gear Upgrades table had a Cost column and no way to ask what the number
 * was made of — including the rows where the answer is "nothing, the market has
 * no listing" and the rows priced as the new piece alone because the combat gear
 * they replace is kept.
 *
 * @param {Object} [skillEquipmentMap] - Per-skill equipment overrides
 * @param {string|null} [targetSkill] - Skill HRID to restrict candidates to
 * @returns {Array} Enhancement candidates with gold cost and `costDetail`
 */
export function generateSkillingEquipmentCandidates(editorDTO, gameData, skillEquipmentMap = {}, targetSkill = null) {
    const itemDetailMap = gameData.itemDetailMap || {};
    const candidates = [];
    const seen = new Set();

    let equipmentSets;
    if (targetSkill) {
        equipmentSets = [skillEquipmentMap[targetSkill] || editorDTO.equipment || {}];
    } else {
        equipmentSets = [editorDTO.equipment || {}];
        for (const skillEquip of Object.values(skillEquipmentMap)) {
            if (skillEquip) equipmentSets.push(skillEquip);
        }
    }

    for (const equipment of equipmentSets) {
        for (const [slot, equip] of Object.entries(equipment)) {
            if (!equip?.hrid) continue;
            if (slot === '/equipment_types/trinket' || slot === '/equipment_types/charm') continue;
            const dedupKey = `${slot}:${equip.hrid}:${equip.enhancementLevel || 0}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const itemDetails = itemDetailMap[equip.hrid];
            if (!itemDetails?.equipmentDetail?.noncombatStats) continue;

            const hasNoncombat = Object.values(itemDetails.equipmentDetail.noncombatStats).some((v) => v > 0);
            if (!hasNoncombat) continue;

            const currentLevel = equip.enhancementLevel || 0;
            const nextBP = getNextBreakpoint(currentLevel, slot, equip.hrid);
            if (!nextBP) continue;

            const itemName = itemDetails.name || equip.hrid.split('/').pop();
            const candidate = {
                slot,
                currentHrid: equip.hrid,
                currentLevel,
                upgradeHrid: equip.hrid,
                upgradeLevel: nextBP,
                description: `${itemName} +${currentLevel} \u2192 +${nextBP}`,
                type: 'enhancement',
            };
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            candidate.costDetail = explainLabCandidateCost(candidate, gameData);
            candidates.push(candidate);
        }

        // Philosopher's accessories at +5, even when the worn jewelry is
        // enhanced higher — same reasoning as the combat advisor
        const philoCandidates = [];
        addPhiloAccessoryCandidates({ equipment }, gameData, philoCandidates);
        for (const candidate of philoCandidates) {
            // Enhancement level is part of the key, same as the ordinary
            // candidates above: two skill loadouts can wear the same jewelry
            // item at different levels, and application matches on the exact
            // (hrid, enhancementLevel) pair (see applyToEquipment's
            // isTheSameItem) — omitting the level here let the philo candidate
            // for one loadout's level silently swallow the other's.
            const dedupKey = `philo:${candidate.slot}:${candidate.upgradeHrid}:${candidate.currentHrid}:${candidate.currentLevel}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            candidate.costDetail = explainLabCandidateCost(candidate, gameData);
            candidates.push(candidate);
        }
    }

    // Gear you are not wearing — the celestial tool and the skill's outfit,
    // which the loop above can never reach because it only ever enhances what is
    // already on. Each one belongs to one skill and is applied to that skill
    // alone: a Milking outfit does nothing in a Crafting room, and a candidate
    // with no skill on it would be applied to every room and appear to help.
    // Every labyrinth skill, not just the ones with a loadout assigned: a skill
    // with no loadout of its own still runs a room, in the base kit, and is
    // exactly the skill most likely to be missing its tool
    const levels = new Map((dataManager.getSkills?.() || []).map((skill) => [skill.skillHrid, skill.level]));
    for (const skill of targetSkill ? [targetSkill] : LABYRINTH_SKILLS) {
        const forSkill = bestGearForSkill({
            skill,
            equipment: skillEquipmentMap[skill] || editorDTO.equipment || {},
            itemDetailMap,
            levels,
        });
        for (const candidate of forSkill) {
            const dedupKey = `gear:${skill}:${candidate.slot}:${candidate.upgradeHrid}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            // `explainLabCandidateCost` rather than `explainUpgradeCost`: a
            // skilling piece replacing combat armour records the armour as kept,
            // and the kept-gear note is the whole explanation for a cost that
            // looks too high
            candidate.costDetail = explainLabCandidateCost(candidate, gameData);
            candidates.push(candidate);
        }
    }

    return candidates;
}

/**
 * Whether an upgrade is even about this loadout.
 *
 * The all-fights analysis pools candidates from every fight and then measures
 * each against every fight, which is right for a combat level — one number the
 * whole character carries — and wrong for a piece of gear. A sword upgrade
 * generated from the melee loadout, installed into the magic loadout, replaces
 * the staff with a sword: not an upgrade, a costume change, and it comes back as
 * a large negative that drags the aggregate for every room the buyer would never
 * have applied it to.
 *
 * The honest answer for a room the piece does not belong to is that nothing
 * happens there, which is also the cheap one — no simulation is needed to work
 * out that a fight is unchanged.
 *
 * @param {Object} candidate - From `generateCandidates`
 * @param {Object} dto - The loadout a fight is assigned
 * @returns {boolean} Whether applying it to this loadout means anything
 */
export function candidateAppliesToDTO(candidate, dto, gameData = null) {
    if (!candidate || !dto) return false;

    // The character's own, wherever they are worn: skills, rooms, shrine levels
    // and community buffs are not held in a loadout and change every fight at
    // once. A community buff is not on the loadout at all — it is an argument to
    // the simulation — so falling through to the equipment test below asked
    // whether a loadout was wearing `community_buff|comExp` and answered no.
    if (
        candidate.type === 'combat_level' ||
        candidate.type === 'house' ||
        candidate.type === 'guild_shrine' ||
        candidate.type === 'community_buff' ||
        candidate.type === 'scroll' ||
        candidate.type === 'drink'
    ) {
        return true;
    }

    if (candidate.slot?.startsWith('ability_')) {
        const abilities = dto.abilities || [];
        if (candidate.type === 'ability_level') {
            // Only where it is actually cast — levelling an ability this
            // loadout does not slot changes nothing about the fight
            return abilities.some(
                (ability) => ability?.hrid === candidate.upgradeHrid && (ability.level || 0) < candidate.upgradeLevel
            );
        }
        // A swap that names the ability it replaces is only about the loadouts
        // that cast it. This is what keeps a multi-fight swap run finite and
        // honest at the same time: "Smack → Quick Strike" measured against a
        // loadout that has never slotted Smack is measuring a different change
        // from the one the row describes, and the row would carry the average of
        // the two. It is also most of the arithmetic — a swap generated from one
        // room's loadout reaches the handful of rooms sharing that ability
        // rather than every room in the labyrinth.
        if (candidate.replacesHrid) {
            if (abilities.some((ability) => ability?.hrid === candidate.upgradeHrid)) return false;
            return abilities.some((ability) => ability?.hrid === candidate.replacesHrid);
        }
        // A swap that fills a free slot rather than replacing anything. The slot
        // number on it belongs to the loadout it was generated from, so what is
        // asked here is whether *this* loadout has one going spare — a loadout
        // with a full bar would have the newcomer written over an ability it
        // chose on purpose, which is a different change from the one the row
        // names.
        if (candidate.fillsFreeSlot) {
            if (abilities.some((ability) => ability?.hrid === candidate.upgradeHrid)) return false;
            return freeAbilitySlot(abilities, candidate.slot) >= 0;
        }
        // A hand-built swap that names no such ability — a row about filling a
        // slot rather than replacing one thing with another — brings its own, so
        // it applies unless this loadout is already running it at least that high
        const slotIdx = parseInt(candidate.slot.split('_')[1]);
        const existing = abilities[slotIdx];
        return !(existing?.hrid === candidate.upgradeHrid && (existing.level || 0) >= candidate.upgradeLevel);
    }

    const equipment = dto.equipment || {};

    // The forced labyrinth armor sets are one purchase every loadout can wear,
    // so unlike a tier candidate they are not tied to the piece they displaced
    // in the room they were generated for — a Royal Fire set bought for the
    // Mimic is worn in every room whose loadout would rather have it. What it
    // replaces is answered per room by `replacedIn`.
    if (candidate.labArmor) {
        // Except when the set comes with a weapon: that variant exists to fix
        // one loadout's unused element, and installing it in a loadout swinging
        // something else is the costume change all over again. Each loadout with
        // the same problem generates its own, so nothing is lost by being strict.
        const weapon = candidate.labArmorWeapon;
        if (weapon && (equipment[weapon.slot]?.hrid || null) !== weapon.hrid) return false;
        return !Object.entries(candidate.addedSlots || {}).every(
            ([slot, piece]) =>
                equipment[slot]?.hrid === piece.hrid &&
                (equipment[slot]?.enhancementLevel || 0) >= (piece.enhancementLevel || 0)
        );
    }

    if (candidate.type === 'cross_slot') {
        const removed = candidate.removedItems || (candidate.currentHrid ? [{ hrid: candidate.currentHrid }] : []);
        // A swap that empties nothing is filling empty slots, so it only
        // applies where they are in fact empty
        if (!removed.length) return Object.keys(candidate.addedSlots || {}).every((slot) => !equipment[slot]);
        return removed.every((item) => Object.values(equipment).some((worn) => worn?.hrid === item.hrid));
    }

    const worn = equipment[candidate.slot];
    // A bare slot is only bare in the loadouts where it is bare
    if (!candidate.currentHrid) return !worn?.hrid;

    // A Philosopher's accessory is a strict superset of every other piece in
    // its slot — the maintainer's ruling, 2026-08-30: always offer it where the
    // slot is worn, never gate it behind the style/role substitution
    // heuristics (which read the all-style Necklace as melee and refused it to
    // a speed-necklace loadout). Only already wearing it at least that high
    // says no.
    if (candidate.upgradeHrid?.startsWith(PHILO_HRID_PREFIX) && JEWELRY_SLOTS.has(candidate.slot)) {
        if (!worn?.hrid) return false;
        if (worn.hrid === candidate.upgradeHrid) {
            return (worn.enhancementLevel || 0) < (candidate.upgradeLevel || 0);
        }
        return true;
    }

    // Enhancing is about one particular item: it helps the loadouts wearing
    // *that* item and nobody else, and not once it is already at the target
    if (candidate.upgradeHrid === candidate.currentHrid) {
        if (worn?.hrid !== candidate.currentHrid) return false;
        return (worn.enhancementLevel || 0) < (candidate.upgradeLevel || 0);
    }

    return tierAppliesToWorn(candidate, worn, equipment, gameData);
}

/**
 * Whether buying this piece would improve the slot a loadout has filled.
 *
 * A tier upgrade is one purchase that every loadout can share, and matching on
 * the exact item it replaces was too narrow: a candidate generated from the
 * loadout wearing a Fine Sword was credited for that room alone, while the
 * loadout wearing a Cursed Sword — which the same purchase would also improve —
 * was recorded as untouched. One price, a fraction of the benefit.
 *
 * So the question is not "is this the item I named" but "would this item be an
 * upgrade here": same slot, not a style the loadout does not fight in, and not a
 * step down in tier.
 *
 * @param {Object} candidate - A tier candidate
 * @param {Object|null} worn - What the loadout has in that slot
 * @param {Object|null} gameData - For item levels and styles; without it this
 *   falls back to the exact-item rule rather than guessing
 * @returns {boolean}
 */
function tierAppliesToWorn(candidate, worn, equipment, gameData) {
    // An empty hand is not a free slot when the other one holds a two-hander:
    // installing a sword beside a bow builds a kit the game would never let you
    // wear. Trading between the two is a cross-slot swap, which has its own
    // candidates and prices the trade properly.
    const twoHand = equipment?.['/equipment_types/two_hand'];
    const oneHand = equipment?.['/equipment_types/main_hand'];
    if (twoHand?.hrid && (candidate.slot === MAIN_HAND_SLOT || candidate.slot === OFF_HAND_SLOT)) return false;
    if (oneHand?.hrid && candidate.slot === TWO_HAND_SLOT) return false;

    // Nothing there is improved by anything
    if (!worn?.hrid) return true;
    // Already the piece being bought: only the enhancement could differ
    if (worn.hrid === candidate.upgradeHrid) {
        return (worn.enhancementLevel || 0) < (candidate.upgradeLevel || 0);
    }

    const details = gameData?.itemDetailMap;
    const upgrade = details?.[candidate.upgradeHrid];
    const current = details?.[worn.hrid];
    if (!upgrade || !current) return worn.hrid === candidate.currentHrid;

    // A lower-tier piece is not an upgrade for this room even though it is for
    // the room the candidate came from
    if ((upgrade.itemLevel || 0) < (current.itemLevel || 0)) return false;

    const upgradeStats = upgrade.equipmentDetail?.combatStats;
    const currentStats = current.equipmentDetail?.combatStats;
    const upgradeStyle = getItemDamageStyle(upgradeStats);
    const currentStyle = getItemDamageStyle(currentStats);
    // Armour and jewellery have no style of their own, and swapping one in is
    // fair game for any loadout; two *weapons* of different styles are not
    // substitutes, whatever their item levels say
    if (upgradeStyle !== 'unknown' && currentStyle !== 'unknown' && upgradeStyle !== currentStyle) return false;

    // Nor is a damage piece a substitute for a defensive one — the loadout was
    // built around what it is wearing
    const upgradeRole = getItemRole(upgradeStats);
    const currentRole = getItemRole(currentStats);
    if (upgradeRole !== 'unknown' && currentRole !== 'unknown' && upgradeRole !== currentRole) return false;

    return true;
}

/**
 * The same player, with one candidate applied.
 *
 * A deep copy, always: the caller's DTO is the character the panel is showing
 * and a dozen candidates measured against a DTO that kept the last one's change
 * would each be measuring the pile rather than the piece.
 *
 * Shared by the single-fight and all-fights analyses so a candidate means the
 * same thing in both. They diverged once, and a candidate that applies one way
 * in one view and another way in the other is worse than a candidate that does
 * not work at all — only one of those is visible.
 *
 * @param {Object} playerDTO - The player to change
 * @param {Object} candidate - From `generateCandidates`
 * @returns {Object} A new DTO
 */
export function applyCandidateToDTO(playerDTO, candidate) {
    const dto = JSON.parse(JSON.stringify(playerDTO));

    if (candidate.slot?.startsWith('ability_')) {
        // Levelling an ability follows the ability, not the slot number it
        // happened to sit in on the loadout the candidate came from — another
        // loadout can cast the same ability from a different slot, and writing
        // to the index would overwrite whatever that one keeps there
        // A swap follows the ability it replaces for the same reason, and takes
        // that loadout's level for it: the whole rule for a swap is that the
        // newcomer is tried at the level of the one it displaces, and the level
        // the candidate was born with belongs to the loadout it was born from.
        const follows =
            candidate.type === 'ability_level'
                ? candidate.upgradeHrid
                : candidate.type === 'ability_swap'
                  ? candidate.replacesHrid
                  : null;
        const byName = follows ? (dto.abilities || []).findIndex((ability) => ability?.hrid === follows) : -1;
        // A fill goes into whichever slot *this* loadout has spare, for the same
        // reason: the index it was generated with belongs to another bar
        const fillIdx = candidate.fillsFreeSlot ? freeAbilitySlot(dto.abilities || [], candidate.slot) : -1;
        const slotIdx = byName >= 0 ? byName : fillIdx >= 0 ? fillIdx : parseInt(candidate.slot.split('_')[1]);
        const existing = dto.abilities[slotIdx];
        const swapLevel =
            candidate.type === 'ability_swap' && byName >= 0 ? (existing?.level ?? candidate.upgradeLevel) : null;
        dto.abilities[slotIdx] =
            existing?.hrid === candidate.upgradeHrid
                ? // Keep configured triggers when levelling the equipped ability
                  { ...existing, level: candidate.upgradeLevel }
                : { hrid: candidate.upgradeHrid, level: swapLevel ?? candidate.upgradeLevel, triggers: null };
        return dto;
    }

    if (candidate.type === 'combat_level') {
        dto[candidate.skillKey] = candidate.upgradeLevel;
        return dto;
    }

    // A house room, the same way runUpgradeAnalysis applies one inline. Without
    // this branch a house candidate fell through to the equipment write at the
    // bottom and stored the room under an equipment slot named after it: the
    // character was simulated completely unchanged, and every house row came
    // back a confident +0.00%.
    if (candidate.type === 'house') {
        if (!dto.houseRooms) dto.houseRooms = {};
        dto.houseRooms[candidate.roomHrid] = candidate.upgradeLevel;
        return dto;
    }

    if (candidate.type === 'guild_shrine') {
        applyGuildShrineToDTO(dto, candidate);
        return dto;
    }

    if (candidate.type === 'drink') {
        applyDrinkToDTO(dto, candidate);
        return dto;
    }

    // A community buff is not on the character at all — it is an argument to
    // the simulation — so there is nothing here to change
    if (candidate.type === 'community_buff') {
        return dto;
    }

    if (candidate.type === 'scroll') {
        applyScrollToDTO(dto, candidate);
        return dto;
    }

    if (candidate.type === 'cross_slot') {
        for (const slot of candidate.clearedSlots) dto.equipment[slot] = null;
        for (const [slot, item] of Object.entries(candidate.addedSlots)) dto.equipment[slot] = item;
        return dto;
    }

    dto.equipment[candidate.slot] = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };
    return dto;
}

/**
 * Put one candidate's item into the equipment it applies to.
 *
 * A candidate carrying a `skillKey` belongs to that skill and goes into that
 * skill's equipment only — a Milking outfit put into every skill's kit would
 * report a gain in rooms it cannot affect. One without a key is an enhancement
 * of gear already worn, which is the same piece wherever it appears, so it is
 * applied everywhere it is found.
 *
 * @param {Object} candidate - The upgrade
 * @param {Object} payload - `{hrid, enhancementLevel}` to install
 * @param {Object} dto - The editor's own player
 * @param {Object} equipMap - Per-skill equipment overrides
 * @param {string|null} targetSkill - The skill being analysed, when only one is
 */
export function applyToEquipment(candidate, payload, dto, equipMap, targetSkill) {
    const { skillKey, slot, currentHrid, currentLevel = 0 } = candidate;

    if (skillKey) {
        // A skill with no loadout of its own runs in the character's base kit,
        // and writing the piece there would put a Milking outfit into every
        // other skill that shares it. It gets a kit of its own instead, copied
        // from the one it was running, so the change lands on that skill alone.
        if (!equipMap[skillKey]) equipMap[skillKey] = { ...(dto.equipment || {}) };
        equipMap[skillKey][slot] = payload;
        return;
    }

    // The same item, at the same enhancement — enhancing the sword you own
    // upgrades it in every kit it is worn in, but a second copy of it worn a few
    // levels higher elsewhere is a different item and would be dragged *down* to
    // this candidate's target by an hrid-only match
    const isTheSameItem = (worn) => worn?.hrid === currentHrid && (worn.enhancementLevel || 0) === currentLevel;

    if (isTheSameItem(dto.equipment?.[slot])) dto.equipment[slot] = payload;
    for (const [skill, skillEquip] of Object.entries(equipMap)) {
        // In single-skill mode the other skills' kits are not being simulated;
        // rewriting them is invisible work at best and confusing at worst
        if (targetSkill && skill !== targetSkill) continue;
        if (isTheSameItem(skillEquip?.[slot])) skillEquip[slot] = payload;
    }
}

/**
 * Run skilling upgrade analysis from editor state.
 * @param {Object} params
 * @param {Object} params.editorDTO - Player DTO from editor
 * @param {number} params.roomLevel - Room level
 * @param {string[]} params.crateHrids - Selected crate HRIDs
 * @param {Object} [params.skillEquipmentMap] - Per-skill equipment overrides
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results }
 */
export async function runSkillingUpgradeAnalysis(params, onProgress, options = {}) {
    const { editorDTO, roomLevel, crateHrids, skillEquipmentMap = {}, targetSkill = null } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const tokenUpgrades = editorDTO.tokenUpgrades || {};
    const buffCandidates = generateLabyrinthBuffCandidatesFromEditor(tokenUpgrades);
    const equipCandidates = generateSkillingEquipmentCandidates(editorDTO, gameData, skillEquipmentMap, targetSkill);
    const guildCandidates = generateGuildShrineCandidates(editorDTO, { combat: false }).map((candidate) => ({
        ...candidate,
        cost: calculateUpgradeCost(candidate, gameData),
    }));
    const clearRateOpts = { skillEquipmentMap, targetSkill };

    // Yield so Stop clicks and progress paints can land between the heavy sync chunks
    await new Promise((resolve) => setTimeout(resolve, 0));

    const total = buffCandidates.length + equipCandidates.length + guildCandidates.length + 1;
    let current = 0;

    onProgress?.({ current: 0, total, description: 'Computing baseline...' });
    const baselineClearRate = computeAverageSkillingClearRateFromEditor(
        roomLevel,
        editorDTO,
        crateHrids,
        gameData,
        clearRateOpts
    );
    current++;

    if (abortSignal?.()) return { baseline: null, results: [] };

    onProgress?.({ current, total, description: `Baseline: ${(baselineClearRate * 100).toFixed(1)}%` });

    // Only paid for when something is ranked on it — the Experience token and the
    // Scholar shrine are the candidates that are, and both are often absent
    const scholarBuff = '/buff_types/wisdom';
    const hasXpCandidate =
        buffCandidates.some((c) => c.category === 'experience') ||
        guildCandidates.some((c) => c.buffTypes?.includes(scholarBuff));
    const baselineXpPerRoom = hasXpCandidate
        ? computeAverageSkillingXpPerRoomFromEditor(roomLevel, editorDTO, crateHrids, gameData, clearRateOpts)
        : 0;

    const results = [];

    for (const buffCandidate of buffCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${buffCandidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        modifiedDTO.tokenUpgrades[buffCandidate.editorKey] = buffCandidate.currentLevel + 1;

        if (buffCandidate.category === 'experience') {
            const modifiedXpPerRoom = computeAverageSkillingXpPerRoomFromEditor(
                roomLevel,
                modifiedDTO,
                crateHrids,
                gameData,
                clearRateOpts
            );
            const xpPerRoomDelta = modifiedXpPerRoom - baselineXpPerRoom;

            results.push({
                candidate: buffCandidate,
                costType: 'token',
                tokenCost: buffCandidate.tokenCost,
                // The room is cleared exactly as often as before; only what it
                // pays out changes, so the clear-rate columns stay at baseline
                clearRate: baselineClearRate,
                clearRateDelta: 0,
                xpPerRoom: modifiedXpPerRoom,
                xpPerRoomDelta,
                tokensPerXp: xpPerRoomDelta > 0 ? buffCandidate.tokenCost / xpPerRoomDelta : Infinity,
                metricType: 'xpPerRoom',
            });
            current++;
            onProgress?.({ current, total, description: buffCandidate.description });
            continue;
        }

        const modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            clearRateOpts
        );
        const clearRateDelta = modifiedClearRate - baselineClearRate;

        results.push({
            candidate: buffCandidate,
            costType: 'token',
            tokenCost: buffCandidate.tokenCost,
            clearRate: modifiedClearRate,
            clearRateDelta,
            metricType: 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: buffCandidate.description });
    }

    // Guild shrines are paid for in credits *and* tokens, which is neither of the
    // two cost types the tables above use, so they keep their own — and a shrine
    // can move clear rate and XP at once, so both are measured for every one
    for (const candidate of guildCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        applyGuildShrineToDTO(modifiedDTO, candidate);

        const modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            clearRateOpts
        );
        const clearRateDelta = modifiedClearRate - baselineClearRate;

        const movesXp = candidate.buffTypes?.includes(scholarBuff);
        const modifiedXpPerRoom = movesXp
            ? computeAverageSkillingXpPerRoomFromEditor(roomLevel, modifiedDTO, crateHrids, gameData, clearRateOpts)
            : baselineXpPerRoom;
        const xpPerRoomDelta = modifiedXpPerRoom - baselineXpPerRoom;

        results.push({
            candidate,
            costType: 'guild',
            cost: candidate.cost,
            tokenCost: candidate.guildTokenCost,
            costDetail: explainUpgradeCost(candidate, gameData),
            clearRate: modifiedClearRate,
            clearRateDelta,
            goldPerClearRate:
                clearRateDelta > 0 && candidate.cost != null ? candidate.cost / (clearRateDelta * 100) : Infinity,
            xpPerRoom: modifiedXpPerRoom,
            xpPerRoomDelta,
            metricType: movesXp && clearRateDelta <= 1e-12 ? 'xpPerRoom' : 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: candidate.description });
    }

    for (const candidate of equipCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        const modifiedSkillEquipMap = JSON.parse(JSON.stringify(skillEquipmentMap));
        const upgradePayload = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };

        applyToEquipment(candidate, upgradePayload, modifiedDTO, modifiedSkillEquipMap, targetSkill);

        const evaluate = (evalCandidate, dto, equipMap) => {
            const payload = { hrid: evalCandidate.upgradeHrid, enhancementLevel: evalCandidate.upgradeLevel };
            applyToEquipment(evalCandidate, payload, dto, equipMap, targetSkill);
            return computeAverageSkillingClearRateFromEditor(roomLevel, dto, crateHrids, gameData, {
                skillEquipmentMap: equipMap,
                targetSkill,
            });
        };

        let evalCandidate = candidate;
        let modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            {
                skillEquipmentMap: modifiedSkillEquipMap,
                targetSkill,
            }
        );
        let clearRateDelta = modifiedClearRate - baselineClearRate;

        // A breakpoint jump sometimes lands between improvement thresholds —
        // keep raising the target one level at a time until the clear rate
        // actually moves (skip when the baseline is already maxed). Only for
        // items the clear-rate model can see at all: an experience-only piece
        // (a Philosopher's accessory) never moves it at any level, and walking
        // it upward requoted the row at +20 for a delta that stayed zero.
        const MAX_ENHANCEMENT = 20;
        const escalatable = canMoveSkillingClearRate(gameData.itemDetailMap?.[candidate.upgradeHrid]);
        while (
            escalatable &&
            clearRateDelta <= 1e-9 &&
            baselineClearRate < 0.999999 &&
            evalCandidate.upgradeLevel < MAX_ENHANCEMENT
        ) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (abortSignal?.()) break;
            const nextLevel = evalCandidate.upgradeLevel + 1;
            const bumped = {
                ...evalCandidate,
                upgradeLevel: nextLevel,
                description: evalCandidate.description.replace(/\+\d+$/, `+${nextLevel}`),
            };
            bumped.cost = calculateUpgradeCost(bumped, gameData);
            // Re-explained at the level it was bumped to, or the expansion would
            // itemise a purchase the row is no longer quoting
            bumped.costDetail = explainLabCandidateCost(bumped, gameData);
            const freshDTO = JSON.parse(JSON.stringify(editorDTO));
            const freshEquipMap = JSON.parse(JSON.stringify(skillEquipmentMap));
            modifiedClearRate = evaluate(bumped, freshDTO, freshEquipMap);
            clearRateDelta = modifiedClearRate - baselineClearRate;
            evalCandidate = bumped;
        }

        results.push({
            candidate: evalCandidate,
            costType: 'gold',
            cost: evalCandidate.cost,
            costDetail: evalCandidate.costDetail ?? null,
            clearRate: modifiedClearRate,
            clearRateDelta,
            // Unknown cost (null) must rank as Infinity, never as free
            goldPerClearRate:
                clearRateDelta > 0 && evalCandidate.cost != null
                    ? evalCandidate.cost / (clearRateDelta * 100)
                    : Infinity,
            metricType: 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: evalCandidate.description });
    }

    // Tokens first, then shrines, then gold; within each group by best delta
    const costOrder = { token: 0, guild: 1, gold: 2 };
    results.sort((a, b) => {
        if (a.costType !== b.costType) return (costOrder[a.costType] ?? 3) - (costOrder[b.costType] ?? 3);
        return (b.clearRateDelta ?? 0) - (a.clearRateDelta ?? 0);
    });

    return {
        baseline: { clearRate: baselineClearRate, xpPerRoom: baselineXpPerRoom },
        results,
    };
}

export default {
    generateCandidates,
    calculateUpgradeCost,
    runUpgradeAnalysis,
    runLabyrinthUpgradeAnalysis,
    generateLabyrinthBuffCandidates,
    generateLabyrinthBuffCandidatesFromEditor,
    generateGuildShrineCandidates,
    generateDrinkCandidates,
    generateCommunityBuffCandidates,
    getEquipmentTierProgression,
    computeSkillingClearRatesFromEditor,
    generateSkillingEquipmentCandidates,
    runSkillingUpgradeAnalysis,
};
