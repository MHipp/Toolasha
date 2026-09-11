/**
 * Enhancement Configuration Manager
 *
 * Combines auto-detected enhancing parameters with manual overrides from settings.
 * Provides single source of truth for enhancement simulator inputs.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import {
    detectEnhancingGear,
    detectEnhancingTeas,
    getEnhancingTeaLevelBonus,
    getEnhancingTeaSpeedBonus,
} from './enhancement-gear-detector.js';
import { getEnhancementMultiplier } from './enhancement-multipliers.js';
import { resolveActionContext } from './action-context.js';
import { BLESSED_TEA_BASE_CHANCE } from './enhancement-calculator.js';

/**
 * Read Blessed Tea's double-jump chance out of the game's consumable data.
 * The number is a balance lever the game can move, so read it the same way the wisdom tea
 * bonus is read rather than freezing last patch's value into the source.
 * @param {Object} itemDetailMap - Item details map from init client data
 * @returns {number} Double-jump chance as a decimal (e.g. 0.01 for 1%)
 */
export function getBlessedTeaBonus(itemDetailMap) {
    const buffs = itemDetailMap?.['/items/blessed_tea']?.consumableDetail?.buffs;
    if (Array.isArray(buffs)) {
        const blessed = buffs.find((buff) => typeof buff?.typeHrid === 'string' && buff.typeHrid.includes('blessed'));
        if (blessed?.flatBoost > 0) {
            return blessed.flatBoost;
        }
    }
    return BLESSED_TEA_BASE_CHANCE;
}

/**
 * Get enhancing parameters (auto-detected or manual)
 *
 * Every surface that quotes what *this* character's enhancing will cost goes through here, so
 * the default has to be the character's own stats. The manual fields ship preloaded with a
 * professional enhancer's kit — level 140, a +15 celestial enhancer, ultra tea — and any field
 * still holding those shipped numbers is a field nobody chose, so it is answered from detection
 * instead. Only a field the player actually edited overrides what they really have.
 *
 * Surfaces that quote a price sweep should ask {@link
 * module:features/enhancement/enhancement-params-source.enhancementParamsFor} instead, which
 * layers the Pro-rates toggle and the own-bench rule over this. This is the layer underneath:
 * detection when auto-detect is on, the manual panel when it is off.
 *
 * @returns {Object} Enhancement parameters for simulator, tagged with `paramsSource`
 *   ('auto' | 'manual') and `manualOverrides` (labels of edited fields)
 */
export function getEnhancingParams() {
    const autoDetect = config.getSettingValue('enhanceSim_autoDetect', false);

    if (autoDetect) {
        return getAutoDetectedParams();
    } else {
        return getManualParams();
    }
}

/**
 * The kit this script ships with: enhancing 140, a max Observatory, ultra and blessed tea, a
 * +15 Celestial enhancer, +12 gloves, a +10 refined chance cape and +10 everything else. It is
 * what the manual fields are preloaded with, so the "pro rates" a surface quotes and the
 * defaults the settings panel shows are one definition rather than two that can drift — the
 * shipped values passed to `readSetting` below MUST equal the `default`s in settings-schema.js
 * (enhancement-config.test.js pins the pairing field by field).
 *
 * Character-wide facts that are not part of anybody's kit — the server's community buff level,
 * the item map's blessed tea chance — still come from live data, exactly as they do for the
 * player's own numbers.
 *
 * @returns {Object} Enhancement parameters for a top-end enhancer, tagged `paramsSource: 'pro'`
 */
export function getProRatesParams() {
    return getManualParams({ useShippedDefaults: true });
}

// Detection walks the loadout and the item map, and getEnhancingParams runs once per item
// during a networth or inventory sweep. The character cannot re-gear between two items of the
// same sweep, so the answer is held briefly instead of being rebuilt hundreds of times.
const DETECTION_CACHE_MS = 1000;
let _detectionCache = null;
let _detectionCacheAt = 0;
let _detectionCacheFor = null;

/**
 * Detected gear settings, memoised for a moment.
 *
 * Keyed on the character as well as the clock. A character *switch* is exactly
 * the re-gearing the time key assumes cannot happen, and for up to a second
 * after one this handed the departing character's detected kit — their
 * enhancing level, their enhancer, their teas — to whoever asked, which is the
 * whole of a networth or inventory sweep run straight after a switch.
 *
 * @returns {Object} Map of settingId → detected value
 */
function getDetectedSettingsCached() {
    const now = Date.now();
    const character = dataManager.getCurrentCharacterId?.() ?? null;
    if (_detectionCache && _detectionCacheFor === character && now - _detectionCacheAt < DETECTION_CACHE_MS) {
        return _detectionCache;
    }

    _detectionCache = getDetectedGearSettings();
    _detectionCacheAt = now;
    _detectionCacheFor = character;
    return _detectionCache;
}

/**
 * Drop the memoised detection, so the next read re-inspects the character.
 * Exists for tests and for any caller that knows the loadout just changed.
 */
export function resetDetectedSettingsCache() {
    _detectionCache = null;
    _detectionCacheAt = 0;
    _detectionCacheFor = null;
}

/**
 * Compare two setting values, including the compound `{ enabled, tier, level }` gear objects.
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean} True when the two describe the same setting
 */
function settingsEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        if (a[key] !== b[key]) return false;
    }
    return true;
}

/**
 * Describe where a set of enhancing parameters came from, for display next to a prediction.
 *
 * Named fields when there are any: those are the ones worth reading back. A manual run with
 * nothing named is still a manual run, though — every field happening to match what was detected
 * does not make it a detected bench — so it says so rather than passing for the character's own.
 *
 * @param {Object} params - Result of getEnhancingParams()
 * @returns {string|null} Short label when manual params are in force, otherwise null
 */
export function describeParamsSource(params) {
    const overrides = params?.manualOverrides;
    if (Array.isArray(overrides) && overrides.length > 0) {
        const shown = overrides.slice(0, 3).join(', ');
        return overrides.length > 3
            ? `manual params: ${shown} +${overrides.length - 3} more`
            : `manual params: ${shown}`;
    }

    if (params?.paramsSource === 'manual') {
        return 'manual params: as set in the enhancement simulator';
    }

    return null;
}

/**
 * Get auto-detected enhancing parameters from character data
 * @returns {Object} Auto-detected parameters
 */
export function getAutoDetectedParams() {
    // The gear the character would be wearing to enhance, not whatever is on
    // them at this instant. Somebody in combat kit reading their enhancing
    // costs off a battleaxe gets a run nobody would ever make; the loadout is
    // what they actually enhance in. Skill-specific default first, then the
    // all-skills default, then anything saved, then what is worn.
    const { equipment, drinks: drinkSlots } = resolveActionContext('/action_types/enhancing');
    const skills = dataManager.getSkills();
    const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

    // Detect gear from equipped items only
    const gear = detectEnhancingGear(equipment, itemDetailMap);

    // Detect drink concentration from equipment (Guzzling Pouch)
    // IMPORTANT: Only scan equipped items, not entire inventory
    let drinkConcentration = 0;
    const itemsToScan = equipment ? Array.from(equipment.values()).filter((item) => item && item.itemHrid) : [];

    for (const item of itemsToScan) {
        const itemDetails = itemDetailMap[item.itemHrid];
        if (!itemDetails?.equipmentDetail?.noncombatStats?.drinkConcentration) continue;

        const concentration = itemDetails.equipmentDetail.noncombatStats.drinkConcentration;
        const enhancementLevel = item.enhancementLevel || 0;
        const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
        const scaledConcentration = concentration * 100 * multiplier;

        // Only keep the highest concentration (shouldn't have multiple, but just in case)
        if (scaledConcentration > drinkConcentration) {
            drinkConcentration = scaledConcentration;
        }
    }

    // Detect teas
    const teas = detectEnhancingTeas(drinkSlots, itemDetailMap);

    // Get tea level bonus (base, then scale with concentration)
    const baseTeaLevel = getEnhancingTeaLevelBonus(teas);
    const teaLevelBonus = baseTeaLevel > 0 ? baseTeaLevel * (1 + drinkConcentration / 100) : 0;

    // Get tea speed bonus (base, then scale with concentration)
    const baseTeaSpeed = getEnhancingTeaSpeedBonus(teas);
    const teaSpeedBonus = baseTeaSpeed > 0 ? baseTeaSpeed * (1 + drinkConcentration / 100) : 0;

    // Get tea wisdom bonus (base, then scale with concentration)
    // Wisdom Tea/Coffee provide 12% wisdom, scales with drink concentration
    let baseTeaWisdom = 0;
    if (drinkSlots && drinkSlots.length > 0) {
        for (const drink of drinkSlots) {
            if (!drink || !drink.itemHrid) continue;
            const drinkDetails = itemDetailMap[drink.itemHrid];
            if (!drinkDetails?.consumableDetail?.buffs) continue;

            const wisdomBuff = drinkDetails.consumableDetail.buffs.find(
                (buff) => buff.typeHrid === '/buff_types/wisdom'
            );

            if (wisdomBuff && wisdomBuff.flatBoost) {
                baseTeaWisdom += wisdomBuff.flatBoost * 100; // Convert to percentage
            }
        }
    }
    const teaWisdomBonus = baseTeaWisdom > 0 ? baseTeaWisdom * (1 + drinkConcentration / 100) : 0;

    // Get Enhancing skill level
    const enhancingSkill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
    if (!enhancingSkill) {
        console.error('[EnhancementConfig] Skill not found: /skills/enhancing');
    }
    const enhancingLevel = enhancingSkill?.level || 1;

    // Get Observatory house room level (enhancing uses observatory, NOT laboratory!)
    const houseLevel = dataManager.getHouseRoomLevel('/house_rooms/observatory');

    // Calculate global house buffs from ALL house rooms
    // Rare Find: 0.2% base + 0.2% per level (per room, only if level >= 1)
    // Wisdom: 0.05% base + 0.05% per level (per room, only if level >= 1)
    const houseRooms = dataManager.getHouseRooms();
    let houseRareFindBonus = 0;
    let houseWisdomBonus = 0;

    for (const [_hrid, room] of houseRooms) {
        const level = room.level || 0;
        if (level >= 1) {
            // Each room: 0.2% per level (NOT 0.2% base + 0.2% per level)
            houseRareFindBonus += 0.2 * level;
            // Each room: 0.05% per level (NOT 0.05% base + 0.05% per level)
            houseWisdomBonus += 0.05 * level;
        }
    }

    // Get Enhancing Speed community buff level
    const communityBuffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
    // Formula: 20% base + 0.5% per level
    const communitySpeedBonus = communityBuffLevel > 0 ? 20 + (communityBuffLevel - 1) * 0.5 : 0;

    // Get Experience (Wisdom) community buff level
    const communityWisdomLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
    // Formula: 20% base + 0.5% per level (same as other community buffs)
    const communityWisdomBonus = communityWisdomLevel > 0 ? 20 + (communityWisdomLevel - 1) * 0.5 : 0;

    const achievementWisdomBonus =
        dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/wisdom') * 100;
    const achievementRareFindBonus =
        dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/rare_find') * 100;

    // Calculate total success rate bonus
    // Equipment + house + achievement
    const houseSuccessBonus = houseLevel * 0.05; // 0.05% per level for success
    const equipmentSuccessBonus = gear.toolBonus;
    const achievementSuccessBonus =
        dataManager.getAchievementBuffRatioBoost('/action_types/enhancing', '/buff_types/enhancing_success') * 100;
    const totalSuccessBonus = equipmentSuccessBonus + houseSuccessBonus + achievementSuccessBonus;

    // Calculate total speed bonus
    // Speed bonus (from equipment) + house bonus (1% per level) + community buff + tea speed
    const houseSpeedBonus = houseLevel * 1.0; // 1% per level for action speed
    const totalSpeedBonus = gear.speedBonus + houseSpeedBonus + communitySpeedBonus + teaSpeedBonus;

    // Calculate total experience bonus
    // Equipment + house wisdom + tea wisdom + community wisdom + achievement wisdom
    const totalExperienceBonus =
        gear.experienceBonus + houseWisdomBonus + teaWisdomBonus + communityWisdomBonus + achievementWisdomBonus;

    // Calculate guzzling bonus multiplier (1.0 at level 0, scales with drink concentration)
    const guzzlingBonus = 1 + drinkConcentration / 100;

    return {
        // Core values for calculations
        enhancingLevel: enhancingLevel + teaLevelBonus, // Base level + tea bonus
        houseLevel: houseLevel,
        toolBonus: totalSuccessBonus, // Tool + house combined
        speedBonus: totalSpeedBonus, // Speed + house + community + tea combined
        rareFindBonus: gear.rareFindBonus + houseRareFindBonus + achievementRareFindBonus, // Rare find (equipment + house rooms + achievements)
        experienceBonus: totalExperienceBonus, // Experience (equipment + house + tea + community wisdom)
        guzzlingBonus: guzzlingBonus, // Drink concentration multiplier for blessed tea
        blessedTeaBonus: getBlessedTeaBonus(itemDetailMap), // Double-jump chance from item data
        teas: teas,

        // Display info (for UI) - show best item per slot
        toolSlot: gear.toolSlot,
        bodySlot: gear.bodySlot,
        legsSlot: gear.legsSlot,
        handsSlot: gear.handsSlot,
        detectedTeaBonus: teaLevelBonus,
        communityBuffLevel: communityBuffLevel, // For display (speed)
        communitySpeedBonus: communitySpeedBonus, // For display
        communityWisdomLevel: communityWisdomLevel, // For display
        communityWisdomBonus: communityWisdomBonus, // For display
        achievementWisdomBonus: achievementWisdomBonus, // For display
        teaSpeedBonus: teaSpeedBonus, // For display
        teaWisdomBonus: teaWisdomBonus, // For display
        drinkConcentration: drinkConcentration, // For display
        houseRareFindBonus: houseRareFindBonus, // For display
        achievementRareFindBonus: achievementRareFindBonus, // For display
        houseWisdomBonus: houseWisdomBonus, // For display
        equipmentRareFind: gear.rareFindBonus, // For display
        equipmentExperience: gear.experienceBonus, // For display
        equipmentSuccessBonus: equipmentSuccessBonus, // For display
        houseSuccessBonus: houseSuccessBonus, // For display
        achievementSuccessBonus: achievementSuccessBonus, // For display
        equipmentSpeedBonus: gear.speedBonus, // For display
        houseSpeedBonus: houseSpeedBonus, // For display
        slotBreakdown: gear.slotBreakdown || [], // Per-item breakdown for display
        paramsSource: 'auto', // Everything above came from this character
        manualOverrides: [], // Nothing was overridden
    };
}

/**
 * Detect current character's enhancing gear and return values mapped to setting keys.
 * Used by settings UI to populate gear inputs when auto-detect is toggled on.
 * @returns {Object} Map of settingId → detected value
 */
export function getDetectedGearSettings() {
    const { equipment, drinks: drinkSlots } = resolveActionContext('/action_types/enhancing');
    const skills = dataManager.getSkills();

    const result = {};

    // Enhancing level
    const enhancingSkill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
    result.enhanceSim_enhancingLevel = enhancingSkill?.level || 1;

    // Observatory
    result.enhanceSim_houseLevel = dataManager.getHouseRoomLevel('/house_rooms/observatory');

    // Community buff
    const communityLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
    result.enhanceSim_communityBuff = { enabled: true, level: communityLevel };

    // Achievement
    const achievementBonus = dataManager.getAchievementBuffRatioBoost(
        '/action_types/enhancing',
        '/buff_types/enhancing_success'
    );
    result.enhanceSim_achievement = achievementBonus > 0;

    // Tea detection
    const teaMap = {
        '/items/ultra_enhancing_tea': 'ultra',
        '/items/super_enhancing_tea': 'super',
        '/items/enhancing_tea': 'basic',
    };
    let detectedTea = 'none';
    let hasBlessed = false;
    if (drinkSlots) {
        for (const drink of drinkSlots) {
            if (!drink?.itemHrid) continue;
            if (teaMap[drink.itemHrid]) detectedTea = teaMap[drink.itemHrid];
            if (drink.itemHrid === '/items/blessed_tea') hasBlessed = true;
        }
    }
    result.enhanceSim_tea = detectedTea;
    result.enhanceSim_blessedTea = hasBlessed;

    // Gear detection — match equipped items to known gear HRIDs
    const ENHANCER_HRIDS = {
        '/items/cheese_enhancer': 'cheese',
        '/items/verdant_enhancer': 'verdant',
        '/items/azure_enhancer': 'azure',
        '/items/burble_enhancer': 'burble',
        '/items/crimson_enhancer': 'crimson',
        '/items/rainbow_enhancer': 'rainbow',
        '/items/holy_enhancer': 'holy',
        '/items/celestial_enhancer': 'celestial',
    };
    const CAPE_HRIDS = {
        '/items/chance_cape': 'normal',
        '/items/chance_cape_refined': 'refined',
    };
    const CHARM_HRIDS = {
        '/items/trainee_enhancing_charm': 'trainee',
        '/items/basic_enhancing_charm': 'basic',
        '/items/advanced_enhancing_charm': 'advanced',
        '/items/expert_enhancing_charm': 'expert',
        '/items/master_enhancing_charm': 'master',
        '/items/grandmaster_enhancing_charm': 'grandmaster',
    };
    const FIXED_HRIDS = {
        '/items/enchanted_gloves': 'gloves',
        '/items/enhancers_top': 'top',
        '/items/enhancers_bottoms': 'bottoms',
        '/items/guzzling_pouch': 'guzzling',
    };
    const NECK_HRIDS = {
        '/items/philosophers_necklace': 'philo',
        '/items/necklace_of_speed': 'speed',
    };
    const RING_HRIDS = {
        '/items/philosophers_ring': 'philo',
        '/items/ring_of_rare_find': 'rarefind',
    };
    const EARRING_HRIDS = {
        '/items/philosophers_earrings': 'philo',
        '/items/earrings_of_rare_find': 'rarefind',
    };

    // Default all gear to disabled (not detected)
    result.enhanceSim_gear_enhancer = { enabled: false, tier: 'celestial', level: 0 };
    result.enhanceSim_gear_gloves = { enabled: false, level: 0 };
    result.enhanceSim_gear_top = { enabled: false, level: 0 };
    result.enhanceSim_gear_bottoms = { enabled: false, level: 0 };
    result.enhanceSim_gear_neck = { enabled: false, tier: 'philo', level: 0 };
    result.enhanceSim_gear_ring = { enabled: false, tier: 'philo', level: 0 };
    result.enhanceSim_gear_earring = { enabled: false, tier: 'philo', level: 0 };
    result.enhanceSim_gear_cape = { enabled: false, tier: 'normal', level: 0 };
    result.enhanceSim_gear_guzzling = { enabled: false, level: 0 };
    result.enhanceSim_gear_charm = { enabled: false, tier: 'grandmaster', level: 0 };

    if (equipment) {
        for (const item of equipment.values()) {
            if (!item?.itemHrid) continue;
            const hrid = item.itemHrid;
            const enhLevel = item.enhancementLevel || 0;

            if (ENHANCER_HRIDS[hrid]) {
                result.enhanceSim_gear_enhancer = { enabled: true, tier: ENHANCER_HRIDS[hrid], level: enhLevel };
            } else if (CAPE_HRIDS[hrid]) {
                result.enhanceSim_gear_cape = { enabled: true, tier: CAPE_HRIDS[hrid], level: enhLevel };
            } else if (CHARM_HRIDS[hrid]) {
                result.enhanceSim_gear_charm = { enabled: true, tier: CHARM_HRIDS[hrid], level: enhLevel };
            } else if (NECK_HRIDS[hrid]) {
                result.enhanceSim_gear_neck = { enabled: true, tier: NECK_HRIDS[hrid], level: enhLevel };
            } else if (RING_HRIDS[hrid]) {
                result.enhanceSim_gear_ring = { enabled: true, tier: RING_HRIDS[hrid], level: enhLevel };
            } else if (EARRING_HRIDS[hrid]) {
                result.enhanceSim_gear_earring = { enabled: true, tier: EARRING_HRIDS[hrid], level: enhLevel };
            } else if (FIXED_HRIDS[hrid]) {
                const slot = FIXED_HRIDS[hrid];
                result[`enhanceSim_gear_${slot}`] = { enabled: true, level: enhLevel };
            }
        }
    }

    return result;
}

/**
 * Get manual enhancing parameters from gear-based config settings
 * @param {Object} [options] - Options
 * @param {boolean} [options.useShippedDefaults=false] - Answer every field with the value it
 *   ships with, ignoring both what the player saved and what the character has. This is the
 *   "pro rates" run: a fixed, top-end kit nobody's gear can change.
 * @returns {Object} Manual parameters
 */
function getManualParams({ useShippedDefaults = false } = {}) {
    const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

    // What this character actually has. Used to fill in every manual field the player never
    // touched, so an untouched panel quotes their own run rather than a stranger's.
    let detectedSettings = {};
    try {
        // With no character loaded there is nothing to detect, and "detected" would read as
        // "owns nothing" — worse than the shipped defaults. Fall back to those instead.
        // A pro-rates run answers from the shipped kit throughout, so it never asks.
        if (!useShippedDefaults && dataManager.getSkills()?.length) {
            detectedSettings = getDetectedSettingsCached();
        }
    } catch (error) {
        console.error('[EnhancementConfig] Gear detection failed, using saved settings:', error);
    }

    const manualOverrides = [];

    /**
     * Read a manual setting.
     * @param {string} key - Setting id
     * @param {*} shippedDefault - The value this field ships with
     * @param {string} [label] - Human name, listed when the field overrides detection
     * @returns {*} The value to simulate with
     */
    const readSetting = (key, shippedDefault, label) => {
        // Pro rates are the shipped kit itself, so nothing the player saved or wears applies
        if (useShippedDefaults) {
            return shippedDefault;
        }

        const stored = config.getSettingValue(key, shippedDefault);
        const detectedValue = detectedSettings[key];

        if (detectedValue === undefined) {
            return stored;
        }
        // Untouched shipped default: nobody chose this, so answer from the character
        if (settingsEqual(stored, shippedDefault)) {
            return detectedValue;
        }
        if (label && !settingsEqual(stored, detectedValue)) {
            manualOverrides.push(label);
        }
        return stored;
    };

    const getValue = readSetting;

    // --- ENHANCING ---
    const houseLevel = getValue('enhanceSim_houseLevel', 8, 'Observatory level');
    const baseEnhancingLevel = getValue('enhanceSim_enhancingLevel', 140, 'Enhancing level');

    // --- TEA ---
    const teaSelection = getValue('enhanceSim_tea', 'ultra', 'Tea');
    const teas = {
        enhancing: teaSelection === 'basic',
        superEnhancing: teaSelection === 'super',
        ultraEnhancing: teaSelection === 'ultra',
        blessed: getValue('enhanceSim_blessedTea', true, 'Blessed tea'),
    };
    const teaLevelBonus =
        teaSelection === 'ultra' ? 8 : teaSelection === 'super' ? 6 : teaSelection === 'basic' ? 3 : 0;
    const teaSpeedBonus =
        teaSelection === 'ultra' ? 6 : teaSelection === 'super' ? 4 : teaSelection === 'basic' ? 2 : 0;

    // --- GEAR ---
    const ENHANCER_TIERS = {
        cheese: '/items/cheese_enhancer',
        verdant: '/items/verdant_enhancer',
        azure: '/items/azure_enhancer',
        burble: '/items/burble_enhancer',
        crimson: '/items/crimson_enhancer',
        rainbow: '/items/rainbow_enhancer',
        holy: '/items/holy_enhancer',
        celestial: '/items/celestial_enhancer',
    };
    const CAPE_TIERS = {
        normal: '/items/chance_cape',
        refined: '/items/chance_cape_refined',
    };
    const CHARM_TIERS = {
        trainee: '/items/trainee_enhancing_charm',
        basic: '/items/basic_enhancing_charm',
        advanced: '/items/advanced_enhancing_charm',
        expert: '/items/expert_enhancing_charm',
        master: '/items/master_enhancing_charm',
        grandmaster: '/items/grandmaster_enhancing_charm',
    };
    const FIXED_GEAR = {
        gloves: '/items/enchanted_gloves',
        top: '/items/enhancers_top',
        bottoms: '/items/enhancers_bottoms',
        guzzling: '/items/guzzling_pouch',
    };
    const NECK_TIERS = {
        philo: '/items/philosophers_necklace',
        speed: '/items/necklace_of_speed',
    };
    const RING_TIERS = {
        philo: '/items/philosophers_ring',
        rarefind: '/items/ring_of_rare_find',
    };
    const EARRING_TIERS = {
        philo: '/items/philosophers_earrings',
        rarefind: '/items/earrings_of_rare_find',
    };

    // Helper to read compound gear setting
    const getGear = (key, defaults, label) => {
        const val = readSetting(key, defaults, label);
        // Handle both object (new format) and missing/null
        if (val && typeof val === 'object') return val;
        return defaults;
    };

    // Calculate bonuses from each gear slot
    let equipmentSuccessBonus = 0;
    let equipmentSpeedBonus = 0;
    let equipmentRareFind = 0;
    let equipmentExperience = 0;
    let drinkConcentration = 0;
    const slotBreakdown = [];

    // Enhancer
    const enhancer = getGear('enhanceSim_gear_enhancer', { enabled: true, tier: 'celestial', level: 15 }, 'Enhancer');
    if (enhancer.enabled) {
        const hrid = ENHANCER_TIERS[enhancer.tier] || ENHANCER_TIERS.celestial;
        const bonus = getGearSlotBonus(hrid, enhancer.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Enhancer',
            enhancementLevel: enhancer.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Gloves
    const gloves = getGear('enhanceSim_gear_gloves', { enabled: true, level: 12 }, 'Gloves');
    if (gloves.enabled) {
        const bonus = getGearSlotBonus(FIXED_GEAR.gloves, gloves.level, itemDetailMap);
        equipmentSpeedBonus += bonus.speed;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[FIXED_GEAR.gloves];
        slotBreakdown.push({
            name: details?.name || 'Gloves',
            enhancementLevel: gloves.level,
            success: 0,
            speed: bonus.speed,
            rareFind: 0,
            experience: bonus.experience,
        });
    }

    // Top
    const top = getGear('enhanceSim_gear_top', { enabled: true, level: 10 }, 'Top');
    if (top.enabled) {
        const bonus = getGearSlotBonus(FIXED_GEAR.top, top.level, itemDetailMap);
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[FIXED_GEAR.top];
        slotBreakdown.push({
            name: details?.name || 'Top',
            enhancementLevel: top.level,
            success: 0,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Bottoms
    const bottoms = getGear('enhanceSim_gear_bottoms', { enabled: true, level: 10 }, 'Bottoms');
    if (bottoms.enabled) {
        const bonus = getGearSlotBonus(FIXED_GEAR.bottoms, bottoms.level, itemDetailMap);
        equipmentSpeedBonus += bonus.speed;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[FIXED_GEAR.bottoms];
        slotBreakdown.push({
            name: details?.name || 'Bottoms',
            enhancementLevel: bottoms.level,
            success: 0,
            speed: bonus.speed,
            rareFind: 0,
            experience: bonus.experience,
        });
    }

    // Neck
    const neck = getGear('enhanceSim_gear_neck', { enabled: true, tier: 'philo', level: 10 }, 'Necklace');
    if (neck.enabled) {
        const hrid = NECK_TIERS[neck.tier] || NECK_TIERS.philo;
        const bonus = getGearSlotBonus(hrid, neck.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Necklace',
            enhancementLevel: neck.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Ring
    const ring = getGear('enhanceSim_gear_ring', { enabled: true, tier: 'philo', level: 10 }, 'Ring');
    if (ring.enabled) {
        const hrid = RING_TIERS[ring.tier] || RING_TIERS.philo;
        const bonus = getGearSlotBonus(hrid, ring.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Ring',
            enhancementLevel: ring.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Earring
    const earring = getGear('enhanceSim_gear_earring', { enabled: true, tier: 'philo', level: 10 }, 'Earrings');
    if (earring.enabled) {
        const hrid = EARRING_TIERS[earring.tier] || EARRING_TIERS.philo;
        const bonus = getGearSlotBonus(hrid, earring.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Earrings',
            enhancementLevel: earring.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Cape
    const cape = getGear('enhanceSim_gear_cape', { enabled: true, tier: 'refined', level: 10 }, 'Cape');
    if (cape.enabled) {
        const hrid = CAPE_TIERS[cape.tier] || CAPE_TIERS.normal;
        const bonus = getGearSlotBonus(hrid, cape.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Cape',
            enhancementLevel: cape.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // Guzzling Pouch (provides drink concentration)
    const guzzling = getGear('enhanceSim_gear_guzzling', { enabled: true, level: 10 }, 'Guzzling Pouch');
    if (guzzling.enabled) {
        const bonus = getGearSlotBonus(FIXED_GEAR.guzzling, guzzling.level, itemDetailMap);
        drinkConcentration = bonus.drinkConc;
    }

    // Charm (provides experience/wisdom bonus)
    const charm = getGear('enhanceSim_gear_charm', { enabled: true, tier: 'grandmaster', level: 0 }, 'Charm');
    if (charm.enabled) {
        const hrid = CHARM_TIERS[charm.tier] || CHARM_TIERS.grandmaster;
        const bonus = getGearSlotBonus(hrid, charm.level, itemDetailMap);
        equipmentSuccessBonus += bonus.success;
        equipmentSpeedBonus += bonus.speed;
        equipmentRareFind += bonus.rareFind;
        equipmentExperience += bonus.experience;
        const details = itemDetailMap[hrid];
        slotBreakdown.push({
            name: details?.name || 'Charm',
            enhancementLevel: charm.level,
            success: bonus.success,
            speed: bonus.speed,
            rareFind: bonus.rareFind,
            experience: bonus.experience,
        });
    }

    // --- COMMUNITY BUFF ---
    const communityBuff = getGear('enhanceSim_communityBuff', { enabled: true, level: 1 }, 'Community buff');
    let communityBuffLevel;
    if (communityBuff.enabled) {
        // Checked = auto-detect from game
        communityBuffLevel = dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed');
    } else {
        communityBuffLevel = communityBuff.level;
    }
    const communitySpeedBonus = communityBuffLevel > 0 ? 20 + (communityBuffLevel - 1) * 0.5 : 0;

    // --- ACHIEVEMENT ---
    // The toggle only says whether to count the achievement buff; how big it is comes from the
    // character's own data, the same source auto-detect reads, so the two modes cannot drift.
    const achievementEnabled = getValue('enhanceSim_achievement', true, 'Achievement');
    const achievementSuccessBonus = achievementEnabled
        ? dataManager.getAchievementBuffRatioBoost('/action_types/enhancing', '/buff_types/enhancing_success') * 100
        : 0;

    // --- HOUSE BONUSES ---
    const houseSpeedBonus = houseLevel * 1.0;
    const houseSuccessBonus = houseLevel * 0.05;

    // House wisdom: 0.05% per level per room (same as auto-detect)
    const houseRooms = dataManager.getHouseRooms();
    let houseWisdomBonus = 0;
    for (const [_hrid, room] of houseRooms) {
        const level = room.level || 0;
        if (level >= 1) {
            houseWisdomBonus += 0.05 * level;
        }
    }

    // --- SCALE TEA BONUSES WITH DRINK CONCENTRATION ---
    const scaledTeaLevelBonus = teaLevelBonus > 0 ? teaLevelBonus * (1 + drinkConcentration / 100) : 0;
    const scaledTeaSpeedBonus = teaSpeedBonus > 0 ? teaSpeedBonus * (1 + drinkConcentration / 100) : 0;

    // Tea wisdom bonus (Wisdom Tea/Coffee provide 12% wisdom, scales with drink concentration)
    let baseTeaWisdom = 0;
    const drinkSlots = dataManager.getActionDrinkSlots('/action_types/enhancing');
    if (drinkSlots && drinkSlots.length > 0) {
        for (const drink of drinkSlots) {
            if (!drink || !drink.itemHrid) continue;
            const drinkDetails = itemDetailMap[drink.itemHrid];
            if (!drinkDetails?.consumableDetail?.buffs) continue;
            const wisdomBuff = drinkDetails.consumableDetail.buffs.find(
                (buff) => buff.typeHrid === '/buff_types/wisdom'
            );
            if (wisdomBuff && wisdomBuff.flatBoost) {
                baseTeaWisdom += wisdomBuff.flatBoost * 100;
            }
        }
    }
    const teaWisdomBonus = baseTeaWisdom > 0 ? baseTeaWisdom * (1 + drinkConcentration / 100) : 0;

    // Community wisdom buff
    const communityWisdomLevel = dataManager.getCommunityBuffLevel('/community_buff_types/experience');
    const communityWisdomBonus = communityWisdomLevel > 0 ? 20 + (communityWisdomLevel - 1) * 0.5 : 0;

    // Achievement wisdom buff
    const achievementWisdomBonus =
        dataManager.getAchievementBuffFlatBoost('/action_types/enhancing', '/buff_types/wisdom') * 100;

    // --- TOTALS ---
    const totalToolBonus = equipmentSuccessBonus + houseSuccessBonus + achievementSuccessBonus;
    const totalSpeedBonus = equipmentSpeedBonus + houseSpeedBonus + communitySpeedBonus + scaledTeaSpeedBonus;
    const totalExperienceBonus =
        equipmentExperience + houseWisdomBonus + teaWisdomBonus + communityWisdomBonus + achievementWisdomBonus;
    const guzzlingBonus = 1 + drinkConcentration / 100;

    return {
        enhancingLevel: baseEnhancingLevel + scaledTeaLevelBonus,
        houseLevel: houseLevel,
        toolBonus: totalToolBonus,
        speedBonus: totalSpeedBonus,
        rareFindBonus: equipmentRareFind,
        experienceBonus: totalExperienceBonus,
        guzzlingBonus: guzzlingBonus,
        blessedTeaBonus: getBlessedTeaBonus(itemDetailMap), // Double-jump chance from item data
        teas: teas,

        // Display info for manual mode
        toolSlot: null,
        bodySlot: null,
        legsSlot: null,
        handsSlot: null,
        detectedTeaBonus: scaledTeaLevelBonus,
        communityBuffLevel: communityBuffLevel,
        communitySpeedBonus: communitySpeedBonus,
        teaSpeedBonus: scaledTeaSpeedBonus,
        equipmentSpeedBonus: equipmentSpeedBonus,
        houseSpeedBonus: houseSpeedBonus,
        equipmentSuccessBonus: equipmentSuccessBonus,
        houseSuccessBonus: houseSuccessBonus,
        achievementSuccessBonus: achievementSuccessBonus,
        slotBreakdown: slotBreakdown,
        // This is the manual panel's answer, and it says so even when no field was edited.
        // Individual untouched fields are still filled in from detection — that is what keeps a
        // never-opened panel from quoting a stranger — but the bench as a whole is the one the
        // player told it about, not the one it found. Two surfaces used to print "Yours" for
        // two different benches because this said 'auto' whenever the override list was empty.
        paramsSource: useShippedDefaults ? 'pro' : 'manual',
        manualOverrides,
    };
}

/**
 * Calculate enhancing bonuses from a single gear slot
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level (0-20)
 * @param {Object} itemDetailMap - Item details map
 * @returns {Object} { success, speed, rareFind, experience, drinkConc }
 */
function getGearSlotBonus(itemHrid, enhancementLevel, itemDetailMap) {
    const itemDetails = itemDetailMap[itemHrid];
    if (!itemDetails) return { success: 0, speed: 0, rareFind: 0, experience: 0, drinkConc: 0 };

    const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
    const stats = itemDetails.equipmentDetail?.noncombatStats || {};

    return {
        success: (stats.enhancingSuccess || 0) * 100 * multiplier,
        speed: ((stats.enhancingSpeed || 0) + (stats.skillingSpeed || 0)) * 100 * multiplier,
        rareFind: ((stats.enhancingRareFind || 0) + (stats.skillingRareFind || 0)) * 100 * multiplier,
        experience: ((stats.enhancingExperience || 0) + (stats.skillingExperience || 0)) * 100 * multiplier,
        drinkConc: (stats.drinkConcentration || 0) * 100 * multiplier,
    };
}
