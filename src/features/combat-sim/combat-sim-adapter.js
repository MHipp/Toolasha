/**
 * Combat Simulator Adapter
 * Bridges Toolasha's live data to the combat sim engine.
 *
 * Extracts game data maps, builds player DTOs, and provides
 * combat zone metadata for the simulation UI.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadoutSnapshot, expectedValueCalculator } from '../../utils/bundle-bridge.js';
import config from '../../core/config.js';
import marketAPI from '../../api/marketplace.js';
import bundledExpectedValueCalculator from '../market/expected-value-calculator.js';
import { DUNGEON_CHEST_ENTRY_KEYS, DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { partyLevelGaps } from '../../utils/dungeon-level-gap.js';
import { combatLevel } from '../../utils/combat-level.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import { COMBAT_SCROLL_BUFF_TYPES } from '../../utils/combat-scroll-buffs.js';
import { manualAchievementCombatBuffs, deriveAchievementCombatBuffs } from '../../utils/achievement-combat-buffs.js';
import { MARKET_TAX, COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';

/**
 * The combat scrolls the player currently has active.
 *
 * Scroll buffs arrive on `dataManager.personalActionTypeBuffsMap`, keyed by
 * action type, same shape as the guild/achievement action-type buff maps. We keep
 * only the combat scroll types, so the editor starts checked exactly where the
 * player really stands.
 * @returns {string[]} Active combat scroll buff-type hrids
 */
function readActiveCombatScrolls() {
    const active = dataManager.personalActionTypeBuffsMap?.['/action_types/combat'];
    if (!Array.isArray(active)) return [];
    const present = new Set(active.map((entry) => entry?.typeHrid));
    return COMBAT_SCROLL_BUFF_TYPES.filter((typeHrid) => present.has(typeHrid));
}

/**
 * Extract all required game data maps from initClientData for the sim engine.
 * @returns {Object|null} Plain object with all 13 game data maps, or null if data unavailable
 */
export function buildGameDataPayload() {
    const clientData = dataManager.getInitClientData();
    if (!clientData) {
        console.error('[CombatSimAdapter] No initClientData available');
        return null;
    }

    return {
        itemDetailMap: clientData.itemDetailMap,
        actionDetailMap: clientData.actionDetailMap,
        abilityDetailMap: clientData.abilityDetailMap,
        combatMonsterDetailMap: clientData.combatMonsterDetailMap,
        combatStyleDetailMap: clientData.combatStyleDetailMap,
        damageTypeDetailMap: clientData.damageTypeDetailMap,
        houseRoomDetailMap: clientData.houseRoomDetailMap,
        combatTriggerDependencyDetailMap: clientData.combatTriggerDependencyDetailMap,
        combatTriggerConditionDetailMap: clientData.combatTriggerConditionDetailMap,
        combatTriggerComparatorDetailMap: clientData.combatTriggerComparatorDetailMap,
        enhancementLevelTotalBonusMultiplierTable: clientData.enhancementLevelTotalBonusMultiplierTable,
        abilitySlotsLevelRequirementList: clientData.abilitySlotsLevelRequirementList,
        openableLootDropMap: clientData.openableLootDropMap,
        labyrinthCrateDetailMap: clientData.labyrinthCrateDetailMap,
        levelExperienceTable: clientData.levelExperienceTable,
    };
}

/**
 * Guild shrine buffs — the levels a character buys with guild credits and tokens.
 *
 * The server sends the *resolved* buffs it grants (`guildActionTypeBuffsMap`),
 * not the levels behind them, so asking "what would one more level do" means
 * rebuilding the buff object by hand. `guildBuffDetailMap` carries everything
 * needed: the buff's level-1 value and its per-level bonus, in exactly the shape
 * `Buff` reads (`value = base + (level − 1) × levelBonus`).
 *
 * This lives here rather than in the game-data payload because the synthesis
 * happens on the main thread — a worker is handed the finished buff array and
 * never needs the level table.
 * @returns {Object} guildBuffDetailMap, or an empty object before data loads
 */
export function getGuildBuffDetailMap() {
    return dataManager.getInitClientData()?.guildBuffDetailMap || {};
}

/**
 * Highest level a shrine buff can be bought to, read from its own cost table.
 * @param {Object} detail - Entry from guildBuffDetailMap
 * @returns {number} Max level (0 when the entry carries no costs)
 */
export function guildBuffMaxLevel(detail) {
    const levels = Object.keys(detail?.levelCosts || {})
        .map(Number)
        .filter((level) => Number.isFinite(level));
    return levels.length > 0 ? Math.max(...levels) : 0;
}

/**
 * The buff objects a shrine buff grants at a given level.
 *
 * Boosts are resolved here rather than left as base + bonus, because the combat
 * engine adds `flatBoost`/`ratioBoost` straight into its permanent buffs without
 * consulting a level. The level-bonus fields are zeroed for the same reason: a
 * reader that *does* apply them (Buff, at level 1) must not double-count.
 *
 * @param {Object} detail - Entry from guildBuffDetailMap
 * @param {number} level - Purchased level (0 or less grants nothing)
 * @returns {Array<Object>} Buff objects in the shape the server sends
 */
export function synthesizeGuildBuffs(detail, level) {
    if (!detail || !(level > 0)) return [];
    return (detail.buffs || []).map((buff) => ({
        uniqueHrid:
            buff.uniqueHrid ||
            `/buff_uniques/${String(detail.hrid || '')
                .split('/')
                .pop()}`,
        typeHrid: buff.typeHrid,
        ratioBoost: (buff.ratioBoost || 0) + (level - 1) * (buff.ratioBoostLevelBonus || 0),
        ratioBoostLevelBonus: 0,
        flatBoost: (buff.flatBoost || 0) + (level - 1) * (buff.flatBoostLevelBonus || 0),
        flatBoostLevelBonus: 0,
        startTime: '0001-01-01T00:00:00Z',
        duration: 0,
    }));
}

/**
 * The same buff list with one shrine buff moved to a different level.
 *
 * Entries are matched by buff type rather than by unique hrid: the five combat
 * shrines grant disjoint buff types, and the level a shrine sits at is the only
 * thing that changes about its contribution. A shrine currently at 0 contributes
 * nothing to match, so this also covers buying the first level.
 *
 * @param {Array<Object>} buffs - Current buff array (not mutated)
 * @param {Object} detail - Entry from guildBuffDetailMap
 * @param {number} level - Level to put that shrine buff at
 * @returns {Array<Object>} New buff array
 */
export function applyGuildBuffLevel(buffs, detail, level) {
    const replaced = new Set((detail?.buffs || []).map((buff) => buff.typeHrid));
    const kept = (Array.isArray(buffs) ? buffs : []).filter((buff) => !replaced.has(buff?.typeHrid));
    return [...kept, ...synthesizeGuildBuffs(detail, level)];
}

/**
 * The character's purchased level in every guild shrine buff.
 * @returns {Object} buffHrid → level (0 for anything unpurchased)
 */
export function readGuildShrineLevels() {
    const levels = {};
    for (const buffHrid of Object.keys(getGuildBuffDetailMap())) {
        levels[buffHrid] = dataManager.getCharacterGuildBuffLevel?.(buffHrid) || 0;
    }
    return levels;
}

/**
 * The same levels, with how old the reading is.
 *
 * Shrine levels ride on guild traffic that may never arrive in a session, so
 * data-manager falls back to the last reading it persisted. That is worth
 * having and worth labelling: `hydrated` says the numbers came from storage
 * rather than this session, and `capturedAt` is when they were true.
 *
 * @returns {{levels: Object, capturedAt: (number|null), hydrated: boolean}} Levels and their provenance
 */
export function readGuildShrineSnapshot() {
    return {
        levels: readGuildShrineLevels(),
        capturedAt: dataManager.getGuildShrineCapturedAt?.() ?? null,
        hydrated: dataManager.isGuildShrineHydrated?.() ?? false,
    };
}

/**
 * Turn a shared profile's `guildBuffLevelMap` (buffHrid → level) into the two DTO
 * fields the sim needs: the level map the editor renders, and the synthesized
 * combat buff array the engine applies.
 *
 * The server pre-computes `guildCombatBuffs` for your own character, but a shared
 * profile carries only the levels, so the combat halves are synthesized here the
 * same way the upgrade advisor does when it explores a level. Skilling shrines
 * are kept in the level map (so the editor shows them) but not synthesized — a
 * combat sim has no use for them.
 *
 * @param {Object} levelMap - buffHrid → level (a bare number, as the profile sends)
 * @returns {{guildShrineLevels: Object, guildCombatBuffs: Array<Object>}}
 */
export function buildGuildBuffsFromLevels(levelMap) {
    const guildShrineLevels = {};
    let guildCombatBuffs = [];
    if (!levelMap || typeof levelMap !== 'object') {
        return { guildShrineLevels, guildCombatBuffs };
    }

    const detailMap = getGuildBuffDetailMap();
    for (const [buffHrid, rawLevel] of Object.entries(levelMap)) {
        const level = Math.max(0, Math.floor(Number(rawLevel) || 0));
        guildShrineLevels[buffHrid] = level;
        const detail = detailMap[buffHrid];
        if (detail?.isCombat && level > 0) {
            guildCombatBuffs = [...guildCombatBuffs, ...synthesizeGuildBuffs(detail, level)];
        }
    }
    return { guildShrineLevels, guildCombatBuffs };
}

/**
 * Build a player DTO from the current character data.
 * Outputs the format expected by Player.createFromDTO():
 *   { staminaLevel, ..., equipment: { '/equipment_types/head': {hrid, enhancementLevel}, ... },
 *     food: [{hrid, triggers}], drinks: [{hrid, triggers}],
 *     abilities: [{hrid, level, triggers}], houseRooms: {'/house_rooms/x': level},
 *     hrid: 'player1', debuffOnLevelGap: 0 }
 * @returns {Object|null} Player DTO in sim engine format, or null if data unavailable
 */
export function buildPlayerDTO() {
    const characterData = dataManager.characterData;
    const clientData = dataManager.getInitClientData();

    if (!characterData) {
        console.error('[CombatSimAdapter] No character data available');
        return null;
    }

    // Without the item sheet, `itemDetailMap` falls back to {} below and every
    // equipped piece is dropped for want of a definition — the DTO builds
    // cleanly and describes a naked character. That is worse than no DTO: the
    // callers all handle null, and none of them can spot a silently unequipped
    // player. Same answer the missing-character-data guard gives.
    if (!clientData) {
        console.error('[CombatSimAdapter] No initClientData available');
        return null;
    }

    const dto = {
        staminaLevel: 1,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
        woodcuttingLevel: 1,
        foragingLevel: 1,
        milkingLevel: 1,
        cookingLevel: 1,
        brewingLevel: 1,
        cheesesmithingLevel: 1,
        craftingLevel: 1,
        tailoringLevel: 1,
        alchemyLevel: 1,
        enhancingLevel: 1,
        hrid: 'player1',
        debuffOnLevelGap: 0,
        equipment: {},
        food: [],
        drinks: [],
        abilities: [],
        houseRooms: {},
        tokenUpgrades: { speed: 0, efficiency: 0, success: 0, doubleProgress: 0, experience: 0 },
        communityBuffLevels: { productionEfficiency: 0, enhancingSpeed: 0, gatheringQuantity: 0, experience: 0 },
        guildCombatBuffs: [],
        achievementCombatBuffs: [],
        achievementBuffsOff: [],
        guildShrineLevels: {},
        scrollBuffs: [],
    };

    // Extract all skill levels (combat + skilling)
    for (const skill of characterData.characterSkills || []) {
        const skillName = skill.skillHrid.split('/').pop();
        const key = skillName + 'Level';
        if (dto[key] !== undefined) {
            dto[key] = skill.level;
        }
    }

    // Extract labyrinth token upgrades
    const info = characterData.characterInfo;
    if (info) {
        dto.tokenUpgrades = {
            speed: Math.max(0, Math.floor(Number(info.labyrinthSkillActionSpeedLevel) || 0)),
            efficiency: Math.max(0, Math.floor(Number(info.labyrinthSkillingEfficiencyLevel) || 0)),
            success: Math.max(0, Math.floor(Number(info.labyrinthSkillingSuccessLevel) || 0)),
            doubleProgress: Math.max(0, Math.floor(Number(info.labyrinthSkillingDoubleProgressLevel) || 0)),
            experience: Math.max(0, Math.floor(Number(info.labyrinthExperienceLevel) || 0)),
        };
    }

    // Extract community buff levels
    dto.communityBuffLevels = {
        productionEfficiency: dataManager.getCommunityBuffLevel('/community_buff_types/production_efficiency') || 0,
        enhancingSpeed: dataManager.getCommunityBuffLevel('/community_buff_types/enhancing_speed') || 0,
        gatheringQuantity: dataManager.getCommunityBuffLevel('/community_buff_types/gathering_quantity') || 0,
        experience: dataManager.getCommunityBuffLevel('/community_buff_types/experience') || 0,
    };

    // Extract guild combat buffs (pre-computed server-side per action type)
    dto.guildCombatBuffs = characterData.guildActionTypeBuffsMap?.['/action_types/combat'] || [];

    // The levels behind those buffs, which the buff array itself does not carry.
    // Editing one re-synthesizes its entries in guildCombatBuffs; the rest of the
    // array stays exactly as the server sent it.
    dto.guildShrineLevels = readGuildShrineLevels();

    // Achievement buffs arrive the same shape and from the same kind of source —
    // completed achievement tiers, pre-computed per action type. They were being
    // read for every skilling calculation and dropped on the floor for combat.
    const achievementCombatBuffs = dataManager.getAchievementBuffs('/action_types/combat');
    dto.achievementCombatBuffs = Array.isArray(achievementCombatBuffs) ? achievementCombatBuffs : [];

    // Labyrinth scrolls the player is carrying — only the two that touch combat
    // (wisdom, rare find). The editor's Scrolls section starts from this.
    dto.scrollBuffs = readActiveCombatScrolls();

    // Extract equipped items → keyed by equipment type
    // Prefer the always-current characterEquipment Map (updated on every items_updated WS message)
    // over characterItems array which can lose enhancementLevel when items are swapped mid-session.
    const itemDetailMap = clientData?.itemDetailMap || {};
    const equipmentMap = dataManager.characterEquipment;

    if (equipmentMap && equipmentMap.size > 0) {
        for (const [, item] of equipmentMap) {
            const itemDetail = itemDetailMap[item.itemHrid];
            if (!itemDetail?.equipmentDetail?.type) continue;
            dto.equipment[itemDetail.equipmentDetail.type] = {
                hrid: item.itemHrid,
                enhancementLevel: item.enhancementLevel || 0,
            };
        }
    } else if (Array.isArray(characterData.characterItems)) {
        // Fallback: array format (Map not yet populated)
        for (const item of characterData.characterItems) {
            if (!item.itemLocationHrid || item.itemLocationHrid.includes('/item_locations/inventory')) continue;
            const itemDetail = itemDetailMap[item.itemHrid];
            if (!itemDetail?.equipmentDetail?.type) continue;
            dto.equipment[itemDetail.equipmentDetail.type] = {
                hrid: item.itemHrid,
                enhancementLevel: item.enhancementLevel || 0,
            };
        }
    } else if (characterData.characterEquipment) {
        for (const key in characterData.characterEquipment) {
            const item = characterData.characterEquipment[key];
            const itemDetail = itemDetailMap[item.itemHrid];
            if (!itemDetail?.equipmentDetail?.type) continue;
            dto.equipment[itemDetail.equipmentDetail.type] = {
                hrid: item.itemHrid,
                enhancementLevel: item.enhancementLevel || 0,
            };
        }
    }

    // Build trigger map (ability + consumable triggers combined)
    const triggerMap = {
        ...(characterData.abilityCombatTriggersMap || {}),
        ...(characterData.consumableCombatTriggersMap || {}),
    };

    /**
     * Convert raw trigger data to DTOs for Trigger.createFromDTO.
     * @param {string} hrid - Ability or consumable HRID
     * @returns {Array<Object>} Trigger DTOs
     */
    const buildTriggerDTOs = (hrid) => {
        const rawTriggers = triggerMap[hrid];
        if (!Array.isArray(rawTriggers)) return null;

        return rawTriggers.map((t) => ({
            dependencyHrid: t.dependencyHrid,
            conditionHrid: t.conditionHrid,
            comparatorHrid: t.comparatorHrid,
            value: t.value || 0,
        }));
    };

    // Extract food slots → array of { hrid, triggers }
    const foodSlots = characterData.actionTypeFoodSlotsMap?.['/action_types/combat'] || [];
    for (let i = 0; i < 3; i++) {
        const item = foodSlots[i];
        if (item?.itemHrid) {
            dto.food.push({ hrid: item.itemHrid, triggers: buildTriggerDTOs(item.itemHrid) });
        } else {
            dto.food.push(null);
        }
    }

    // Extract drink slots → array of { hrid, triggers }
    const drinkSlots = characterData.actionTypeDrinkSlotsMap?.['/action_types/combat'] || [];
    for (let i = 0; i < 3; i++) {
        const item = drinkSlots[i];
        if (item?.itemHrid) {
            dto.drinks.push({ hrid: item.itemHrid, triggers: buildTriggerDTOs(item.itemHrid) });
        } else {
            dto.drinks.push(null);
        }
    }

    // Extract equipped abilities → array of { hrid, level, triggers }
    //
    // Through the data-manager getter, not off characterData directly: that is
    // the view every ability message is applied to, and reading the raw field
    // is what left the sim simulating a login-time kit after the labyrinth had
    // swapped loadouts underneath it.
    const equippedAbilities = dataManager.getEquippedAbilities?.() || characterData.combatUnit?.combatAbilities || [];
    // Slot 0 = special ability, slots 1-4 = normal abilities
    for (let i = 0; i < 5; i++) {
        dto.abilities.push(null);
    }

    let normalAbilityIndex = 1;
    for (const ability of equippedAbilities) {
        if (!ability?.abilityHrid) continue;

        const isSpecial = clientData?.abilityDetailMap?.[ability.abilityHrid]?.isSpecialAbility || false;
        const abilityDTO = {
            hrid: ability.abilityHrid,
            level: ability.level || 1,
            triggers: buildTriggerDTOs(ability.abilityHrid),
        };

        if (isSpecial) {
            dto.abilities[0] = abilityDTO;
        } else if (normalAbilityIndex < 5) {
            dto.abilities[normalAbilityIndex++] = abilityDTO;
        }
    }

    // Extract house room levels
    for (const house of Object.values(characterData.characterHouseRoomMap || {})) {
        dto.houseRooms[house.houseRoomHrid] = house.level;
    }

    return dto;
}

/**
 * Build a player DTO from profile_shared data for the combat sim UI.
 * @param {Object} profileData - Profile data from profile_shared (with .profile and .characterID)
 * @returns {Object|null} Player DTO in sim engine format, or null if unavailable
 */
export function buildPlayerDTOFromProfile(profileData) {
    if (!profileData?.profile) return null;
    const clientData = dataManager.getInitClientData();
    if (!clientData) return null;
    return buildPartyMemberDTO(profileData, clientData, null);
}

/**
 * Parse a Shykai-format export string into player DTOs.
 * Accepts the multi-slot format: {"1": "{...}", "2": "{...}", ...}
 * Each slot is a stringified player object with player/food/drinks/abilities/triggerMap/houseRooms.
 * @param {string} jsonString - The pasted export string
 * @returns {{ players: Array<Object>, names: Array<string> }|null} Parsed DTOs, or null on error
 */
export function parseShykaiImport(jsonString) {
    const clientData = dataManager.getInitClientData();
    if (!clientData) return null;
    const itemDetailMap = clientData.itemDetailMap || {};

    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    } catch {
        return null;
    }

    // Detect format:
    // - Multi-slot: {"1": "{...}", "2": "{...}", ...}
    // - Single-player: {"player": {...}, "food": {...}, ...}
    let slotEntries;

    if (typeof parsed === 'object' && parsed !== null && ['1', '2', '3', '4', '5'].some((k) => parsed[k])) {
        // Multi-slot format
        slotEntries = [];
        for (let i = 1; i <= 5; i++) {
            const slotStr = parsed[String(i)];
            if (!slotStr) continue;
            try {
                const slotData = typeof slotStr === 'string' ? JSON.parse(slotStr) : slotStr;
                slotEntries.push({ slot: i, data: slotData });
            } catch {
                // Skip unparseable slots
            }
        }
    } else if (typeof parsed === 'object' && parsed.player) {
        // Single-player format
        slotEntries = [{ slot: 1, data: parsed }];
    } else {
        return null;
    }

    const players = [];
    const names = [];

    for (const { slot, data: slotData } of slotEntries) {
        const p = slotData.player;
        if (!p) continue;

        // Skip blank/empty players (all levels at 1 and no equipment)
        const hasEquipment = Array.isArray(p.equipment) ? p.equipment.some((e) => e.itemHrid) : false;
        const hasLevels = (p.staminaLevel || 1) > 1 || (p.attackLevel || 1) > 1;
        if (!hasEquipment && !hasLevels) continue;

        const dto = {
            staminaLevel: p.staminaLevel || 1,
            intelligenceLevel: p.intelligenceLevel || 1,
            attackLevel: p.attackLevel || 1,
            meleeLevel: p.meleeLevel || 1,
            defenseLevel: p.defenseLevel || 1,
            rangedLevel: p.rangedLevel || 1,
            magicLevel: p.magicLevel || 1,
            hrid: `player${slot}`,
            debuffOnLevelGap: 0,
            equipment: {},
            food: [],
            drinks: [],
            abilities: [],
            houseRooms: {},
        };

        // Equipment: array format [{itemLocationHrid, itemHrid, enhancementLevel}]
        if (Array.isArray(p.equipment)) {
            for (const eq of p.equipment) {
                if (!eq.itemHrid) continue;
                // The engine keys equipment by equipmentDetail.type
                // (/equipment_types/head), but the export — like the game's raw
                // data — files each piece under itemLocationHrid
                // (/item_locations/head). Prefer the item sheet's authoritative
                // type; fall back to translating the location prefix so an item
                // missing from the sheet still lands on the slot the engine reads
                // rather than an /item_locations/* key it never looks at.
                const eqType =
                    itemDetailMap[eq.itemHrid]?.equipmentDetail?.type ||
                    eq.itemLocationHrid?.replace('/item_locations/', '/equipment_types/');
                if (eqType) {
                    dto.equipment[eqType] = {
                        hrid: eq.itemHrid,
                        enhancementLevel: eq.enhancementLevel || 0,
                    };
                }
            }
        }

        // Trigger map helper
        const triggerMap = slotData.triggerMap || {};
        const buildTriggers = (hrid) => {
            const raw = triggerMap[hrid];
            if (!Array.isArray(raw)) return null;
            return raw.map((t) => ({
                dependencyHrid: t.dependencyHrid,
                conditionHrid: t.conditionHrid,
                comparatorHrid: t.comparatorHrid,
                value: t.value || 0,
            }));
        };

        // Food
        const foodSlots = slotData.food?.['/action_types/combat'] || [];
        for (const slot of foodSlots) {
            if (slot.itemHrid) {
                dto.food.push({ hrid: slot.itemHrid, triggers: buildTriggers(slot.itemHrid) });
            } else {
                dto.food.push(null);
            }
        }

        // Drinks
        const drinkSlots = slotData.drinks?.['/action_types/combat'] || [];
        for (const slot of drinkSlots) {
            if (slot.itemHrid) {
                dto.drinks.push({ hrid: slot.itemHrid, triggers: buildTriggers(slot.itemHrid) });
            } else {
                dto.drinks.push(null);
            }
        }

        // Abilities
        const abilitySlots = slotData.abilities || [];
        for (const slot of abilitySlots) {
            if (slot.abilityHrid) {
                dto.abilities.push({
                    hrid: slot.abilityHrid,
                    level: slot.level || 1,
                    triggers: buildTriggers(slot.abilityHrid),
                });
            } else {
                dto.abilities.push(null);
            }
        }

        // House rooms
        if (slotData.houseRooms) {
            dto.houseRooms = { ...slotData.houseRooms };
        }

        // Guild shrines. Szerra's fork of the export carries them as
        // `guildCombatBuffLevels: { force, tempo, ... }` — keyed by the tail of the
        // shrine hrid, where everything on this side is keyed by guild-buff hrid,
        // so each one is resolved through the detail map on the way in. Shykai's
        // own exports have no such field, and an import that carries nothing is
        // left with no level map at all rather than an empty one: the upgrade
        // advisor reads a missing map as "we know nothing about this player's
        // guild" and an empty one as "guildless", and inventing the second from
        // the first would offer them every shrine from level 0.
        if (slotData.guildCombatBuffLevels) {
            const detailMap = getGuildBuffDetailMap();
            const levelMap = {};
            for (const [buffHrid, detail] of Object.entries(detailMap)) {
                if (!detail?.isCombat || !detail.shrineHrid) continue;
                const level = slotData.guildCombatBuffLevels[detail.shrineHrid.split('/').pop()];
                if (Number.isFinite(level) && level > 0) levelMap[buffHrid] = level;
            }
            const { guildShrineLevels, guildCombatBuffs } = buildGuildBuffsFromLevels(levelMap);
            dto.guildShrineLevels = guildShrineLevels;
            dto.guildCombatBuffs = guildCombatBuffs;
        }

        players.push(dto);
        names.push(slotData.name || p.name || `Player ${slot}`);
    }

    if (!players.length) return null;

    return { players, names };
}

/**
 * Build a player DTO from a cached party member profile.
 * @param {Object} profile - Profile data with .profile sub-object
 * @param {Object} clientData - initClientData
 * @param {Object} battleData - Battle data (optional, for consumable detection)
 * @returns {Object} Player DTO in engine format
 */
function buildPartyMemberDTO(profile, clientData, battleData) {
    const itemDetailMap = clientData?.itemDetailMap || {};

    // A shared profile carries which achievements are completed
    // (characterAchievements: achievementHrid + isCompleted) but not the
    // resolved per-action-type combat buff a completed tier grants — that
    // field is server-side only. It can still be derived: cross-referencing
    // characterAchievements against the game's own achievementDetailMap (hrid
    // → tierHrid) gives, per tier, whether every achievement in it is done —
    // exactly the condition the game's Achievement Buffs popup highlights a
    // buff on. When both pieces are available, pre-check the buffs that tier
    // actually earned instead of leaving everything unchecked.
    // achievementBuffsManual/achievementBuffsDerived flag the Configure
    // section to render the matching caption; either way the checkboxes stay
    // manually toggleable, since a derivation from a possibly-stale shared
    // profile is a starting point, not a guarantee.
    const characterAchievements = profile.profile?.characterAchievements;
    const achievementDetailMap = clientData?.achievementDetailMap;
    let achievementCombatBuffs;
    let achievementBuffsOff;
    let achievementBuffsManual = false;
    let achievementBuffsDerived = false;

    if (Array.isArray(characterAchievements) && achievementDetailMap && Object.keys(achievementDetailMap).length) {
        const { buffs, activeTypeHrids } = deriveAchievementCombatBuffs(characterAchievements, achievementDetailMap);
        const activeSet = new Set(activeTypeHrids);
        achievementCombatBuffs = buffs;
        achievementBuffsOff = buffs.filter((buff) => !activeSet.has(buff.typeHrid)).map((buff) => buff.typeHrid);
        achievementBuffsDerived = true;
    } else {
        const manualAchievementBuffs = manualAchievementCombatBuffs();
        achievementCombatBuffs = manualAchievementBuffs;
        achievementBuffsOff = manualAchievementBuffs.map((buff) => buff.typeHrid);
        achievementBuffsManual = true;
    }

    const dto = {
        staminaLevel: 1,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
        hrid: 'player',
        debuffOnLevelGap: 0,
        equipment: {},
        food: [],
        drinks: [],
        abilities: [],
        houseRooms: {},
        guildShrineLevels: {},
        guildCombatBuffs: [],
        achievementCombatBuffs,
        achievementBuffsOff,
        achievementBuffsManual,
        achievementBuffsDerived,
    };

    // Extract skill levels
    for (const skill of profile.profile?.characterSkills || []) {
        const skillName = skill.skillHrid?.split('/').pop();
        const key = skillName + 'Level';
        if (dto[key] !== undefined) {
            dto[key] = skill.level || 1;
        }
    }

    // Extract equipment from wearableItemMap → keyed by equipmentDetail.type
    if (profile.profile?.wearableItemMap) {
        for (const key in profile.profile.wearableItemMap) {
            const item = profile.profile.wearableItemMap[key];
            const itemDetail = itemDetailMap[item.itemHrid];
            if (!itemDetail?.equipmentDetail?.type) continue;
            dto.equipment[itemDetail.equipmentDetail.type] = {
                hrid: item.itemHrid,
                enhancementLevel: item.enhancementLevel || 0,
            };
        }
    }

    // Try to get consumables from battle data first
    let battlePlayer = null;
    if (battleData?.players) {
        battlePlayer = battleData.players.find((p) => p.character?.id === profile.characterID);
    }
    // Build trigger map — prefer battle data triggers over profile triggers (battle data is fresher)
    const triggerMap = {
        ...(battlePlayer?.abilityCombatTriggersMap || profile.profile?.abilityCombatTriggersMap || {}),
        ...(battlePlayer?.consumableCombatTriggersMap || profile.profile?.consumableCombatTriggersMap || {}),
    };

    const buildTriggerDTOs = (hrid) => {
        const rawTriggers = triggerMap[hrid];
        if (!Array.isArray(rawTriggers)) return null;
        return rawTriggers.map((t) => ({
            dependencyHrid: t.dependencyHrid,
            conditionHrid: t.conditionHrid,
            comparatorHrid: t.comparatorHrid,
            value: t.value || 0,
        }));
    };

    // Consumables: prefer battle data, fall back to trigger map keys
    if (battlePlayer?.combatConsumables) {
        let foodIndex = 0;
        let drinkIndex = 0;
        for (const consumable of battlePlayer.combatConsumables) {
            const hrid = consumable.itemHrid;
            const isDrink =
                hrid.includes('/drinks/') ||
                hrid.includes('coffee') ||
                itemDetailMap[hrid]?.categoryHrid?.includes('drink');
            if (isDrink && drinkIndex < 3) {
                dto.drinks.push({ hrid, triggers: buildTriggerDTOs(hrid) });
                drinkIndex++;
            } else if (!isDrink && foodIndex < 3) {
                dto.food.push({ hrid, triggers: buildTriggerDTOs(hrid) });
                foodIndex++;
            }
        }
    } else {
        // Fall back to trigger map keys for consumable HRIDs
        const consumableHrids = Object.keys(profile.profile?.consumableCombatTriggersMap || {});
        let foodIndex = 0;
        let drinkIndex = 0;
        for (const hrid of consumableHrids) {
            const isDrink =
                hrid.includes('/drinks/') ||
                hrid.includes('coffee') ||
                itemDetailMap[hrid]?.categoryHrid?.includes('drink');
            if (isDrink && drinkIndex < 3) {
                dto.drinks.push({ hrid, triggers: buildTriggerDTOs(hrid) });
                drinkIndex++;
            } else if (!isDrink && foodIndex < 3) {
                dto.food.push({ hrid, triggers: buildTriggerDTOs(hrid) });
                foodIndex++;
            }
        }
    }

    // Pad remaining slots with null
    while (dto.food.length < 3) dto.food.push(null);
    while (dto.drinks.length < 3) dto.drinks.push(null);

    // Extract abilities
    for (let i = 0; i < 5; i++) dto.abilities.push(null);
    let normalAbilityIndex = 1;
    const equippedAbilities = profile.profile?.equippedAbilities || [];
    for (const ability of equippedAbilities) {
        if (!ability?.abilityHrid) continue;
        const isSpecial = clientData?.abilityDetailMap?.[ability.abilityHrid]?.isSpecialAbility || false;
        const abilityDTO = {
            hrid: ability.abilityHrid,
            level: ability.level || 1,
            triggers: buildTriggerDTOs(ability.abilityHrid),
        };
        if (isSpecial) {
            dto.abilities[0] = abilityDTO;
        } else if (normalAbilityIndex < 5) {
            dto.abilities[normalAbilityIndex++] = abilityDTO;
        }
    }

    // House rooms
    if (profile.profile?.characterHouseRoomMap) {
        for (const house of Object.values(profile.profile.characterHouseRoomMap)) {
            dto.houseRooms[house.houseRoomHrid] = house.level;
        }
    }

    // Guild shrine levels — the game now shares each player's shrine levels on
    // their profile (guildBuffLevelMap). The server does not pre-compute their
    // combat buffs the way it does for your own character, so synthesize them so
    // an imported character fights with its shrines, not without.
    if (profile.profile?.guildBuffLevelMap) {
        const { guildShrineLevels, guildCombatBuffs } = buildGuildBuffsFromLevels(profile.profile.guildBuffLevelMap);
        dto.guildShrineLevels = guildShrineLevels;
        dto.guildCombatBuffs = guildCombatBuffs;
    }

    return dto;
}

/**
 * Calculate combat level for level gap debuff.
 *
 * A simulated party has no native `combatDetails.combatLevel`, so it is derived
 * from the same formula the game uses (utils/combat-level.js) — and left
 * unfloored, because the server-side Level Malus reads the raw whole-skill
 * Combat Level rather than the integer the game displays.
 * @param {Object} dto - Player DTO
 * @returns {number} Raw (unfloored) combat level
 */
function calcCombatLevel(dto) {
    return combatLevel({
        stamina: dto.staminaLevel,
        intelligence: dto.intelligenceLevel,
        attack: dto.attackLevel,
        defense: dto.defenseLevel,
        melee: dto.meleeLevel,
        ranged: dto.rangedLevel,
        magic: dto.magicLevel,
    }).exact;
}

/**
 * Build player DTOs for all party members (or solo if not in a party).
 * Auto-detects party from characterData and loads cached profiles.
 * @returns {Promise<{players: Array, playerNames: Array<string>, missingMembers: Array<string>}>}
 */
export async function buildAllPlayerDTOs() {
    const characterData = dataManager.characterData;
    const clientData = dataManager.getInitClientData();

    if (!characterData) {
        return { players: [], playerInfo: [], selfHrid: 'player1', missingMembers: [] };
    }

    const hasParty = characterData.partyInfo?.partySlotMap;

    if (!hasParty) {
        // Solo mode
        const selfDTO = buildPlayerDTO();
        if (!selfDTO) return { players: [], playerInfo: [], selfHrid: 'player1', missingMembers: [] };
        return {
            players: [selfDTO],
            playerInfo: [{ hrid: selfDTO.hrid, name: characterData.character?.name || 'Player 1' }],
            selfHrid: selfDTO.hrid,
            missingMembers: [],
        };
    }

    // Party mode — load profile list from IndexedDB
    let profileList = [];
    try {
        profileList = (await storage.getJSON('profile_list', 'combatExport', null)) || [];
    } catch (error) {
        console.error('[CombatSimAdapter] Failed to load profile list:', error);
    }

    // Get battle data for consumable detection
    const battleData = dataManager.battleData || null;

    const players = [];
    const playerNames = [];
    const missingMembers = [];
    let selfHrid = null;
    let slotIndex = 1;

    for (const member of Object.values(characterData.partyInfo.partySlotMap)) {
        if (!member.characterID) continue;

        if (member.characterID === characterData.character.id) {
            // Self
            const selfDTO = buildPlayerDTO();
            if (selfDTO) {
                selfDTO.hrid = 'player' + slotIndex;
                selfHrid = selfDTO.hrid;
                players.push(selfDTO);
                playerNames.push(characterData.character.name || 'Player ' + slotIndex);
            }
        } else {
            // Party member — look up in profile list (IndexedDB, cross-session)
            const profile = profileList.find((p) => p.characterID === member.characterID);

            if (profile) {
                const memberDTO = buildPartyMemberDTO(profile, clientData, battleData);
                memberDTO.hrid = 'player' + slotIndex;
                players.push(memberDTO);
                playerNames.push(profile.characterName || 'Player ' + slotIndex);
            } else {
                missingMembers.push(member.characterName || 'Unknown');
            }
        }
        slotIndex++;
    }

    // Calculate level gap debuff. The formula is shared with the live drop model
    // in utils/dungeon-level-gap.js — kept in one place because the two used to
    // disagree about the same party, the sim predicting a fraction of the loot
    // and the panel afterwards calling that same player unlucky for it.
    if (players.length > 1) {
        const gaps = partyLevelGaps(players.map((p) => calcCombatLevel(p)));
        players.forEach((player, index) => (player.debuffOnLevelGap = gaps[index] ?? 0));
    }

    // Build playerInfo: hrid → name mapping in player order, for tab rendering
    const playerInfo = players.map((p, i) => ({ hrid: p.hrid, name: playerNames[i] }));

    return { players, playerInfo, selfHrid: selfHrid || players[0]?.hrid || 'player1', missingMembers };
}

/**
 * Get a sorted list of combat zones for the zone dropdown.
 * @returns {Array<{hrid: string, name: string, isDungeon: boolean, maxSpawnCount: number, maxDifficulty: number, sortIndex: number}>} Sorted zone list
 */
export function getCombatZones() {
    const clientData = dataManager.getInitClientData();
    if (!clientData?.actionDetailMap) {
        return [];
    }

    const zones = [];

    for (const [hrid, action] of Object.entries(clientData.actionDetailMap)) {
        if (action.type !== '/action_types/combat') continue;

        zones.push({
            hrid,
            name: action.name,
            isDungeon: action.combatZoneInfo?.isDungeon || false,
            maxSpawnCount: action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.maxSpawnCount || 1,
            maxDifficulty: action.maxDifficulty || 0,
            sortIndex: action.sortIndex ?? 0,
        });
    }

    // Sort by sortIndex for consistent ordering
    zones.sort((a, b) => a.sortIndex - b.sortIndex);

    return zones;
}

/**
 * Get all labyrinth monsters sorted by name.
 * @returns {Array<{hrid: string, name: string}>}
 */
export function getLabyrinthMonsters() {
    const clientData = dataManager.getInitClientData();
    if (!clientData?.combatMonsterDetailMap) return [];

    return Object.values(clientData.combatMonsterDetailMap)
        .filter((m) => m.isLabyrinthMonster === true)
        .map((m) => ({ hrid: m.hrid, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get the player's current combat zone and difficulty tier from characterActions.
 * @returns {{zoneHrid: string, difficultyTier: number, isDungeon: boolean}|null} Current zone info or null
 */
export function getCurrentCombatZone() {
    const characterData = dataManager.characterData;
    const clientData = dataManager.getInitClientData();

    if (!characterData?.characterActions) {
        return null;
    }

    // The running action is the lowest-ordinal unfinished combat action, not
    // the first one in array order — a requeued repeat sits first with a higher
    // ordinal. Reading array[0] here mis-stamped dungeon recordings with a
    // queued normal zone's hrid. includeFinished keeps a zone nameable the
    // instant combat ends, matching the old "return the first combat action"
    // behaviour a segment fold relies on.
    const action = runningCombatAction(characterData.characterActions, { includeFinished: true });
    if (!action) {
        return null;
    }

    const isDungeon = clientData?.actionDetailMap?.[action.actionHrid]?.combatZoneInfo?.isDungeon || false;
    return {
        zoneHrid: action.actionHrid,
        difficultyTier: action.difficultyTier || 0,
        isDungeon,
    };
}

/**
 * Extract community buff levels from characterData for the simulation.
 * @returns {{comExp: number, comDrop: number}} Community buff levels (0 if not active)
 */
export function getCommunityBuffs() {
    const mooPassBuffs = dataManager.getMooPassBuffs();
    return {
        mooPass: mooPassBuffs && mooPassBuffs.length > 0,
        comExp: dataManager.getCommunityBuffLevel('/community_buff_types/experience') || 0,
        comDrop: dataManager.getCommunityBuffLevel('/community_buff_types/combat_drop_quantity') || 0,
    };
}

/**
 * Apply a named loadout snapshot to a player DTO (mutates dto in place).
 * Extracted from CombatSimUI._applyLoadoutToDTO so both the sim UI and task display can use it.
 * @param {Object} dto - Player DTO to mutate
 * @param {string} snapshotName - Loadout snapshot name
 * @param {Object} gameData - Game data payload from buildGameDataPayload()
 * @returns {boolean} True if snapshot was found and applied, false otherwise
 */
export function applyLoadoutSnapshotToDTO(dto, snapshotName, gameData) {
    // Multi-bundle build: the sim bundle loads before combat, and the loadout
    // store is a stateful singleton fed by the websocket in the combat bundle.
    // Reach that shared copy through the bridge at call time; the bundled import
    // is only the dev-standalone fallback. Using the sim bundle's own (unfed)
    // copy here left every loadout unresolved — a naked DTO, and every combat
    // room simmed at 0%.
    const store = loadoutSnapshot() || bundledLoadoutSnapshot;
    const snapshots = store.getAllSnapshots();
    const snapshot = snapshots.find((s) => s.name === snapshotName);
    if (!snapshot) return false;

    const itemDetailMap = gameData.itemDetailMap || {};
    const abilityDetailMap = gameData.abilityDetailMap || {};
    const characterData = dataManager.characterData;

    // Convert equipment: snapshot uses itemHrid, DTO keys by equipmentDetail.type.
    // The levels come from resolveEquipment rather than the stored ones — a
    // loadout in "highest owned" mode wears whatever the best copy is now, and
    // the stored level is only a reading from when it was last saved.
    const newEquipment = {};
    for (const equip of store.resolveEquipment(snapshot)) {
        const itemDetail = itemDetailMap[equip.itemHrid];
        const equipType = itemDetail?.equipmentDetail?.type;
        if (equipType) {
            newEquipment[equipType] = {
                hrid: equip.itemHrid,
                enhancementLevel: equip.enhancementLevel,
            };
        }
    }
    dto.equipment = newEquipment;

    // Ability levels come from current character (not the snapshot)
    // Use characterAbilities (all learned) not combatUnit.combatAbilities (equipped only)
    const currentAbilityLevels = {};
    for (const ability of characterData?.characterAbilities || []) {
        if (ability?.abilityHrid) {
            currentAbilityLevels[ability.abilityHrid] = ability.level || 1;
        }
    }

    const triggerMap = {
        ...(snapshot.abilityCombatTriggersMap || {}),
        ...(snapshot.consumableCombatTriggersMap || {}),
    };

    const buildTriggers = (hrid) => {
        const rawTriggers = triggerMap[hrid];
        if (!Array.isArray(rawTriggers)) return null;
        return rawTriggers.map((t) => ({
            dependencyHrid: t.dependencyHrid,
            conditionHrid: t.conditionHrid,
            comparatorHrid: t.comparatorHrid,
            value: t.value || 0,
        }));
    };

    // Build abilities array (5 slots: 0=special, 1-4=normal)
    dto.abilities = [null, null, null, null, null];
    let normalAbilityIndex = 1;
    for (const ab of snapshot.abilities || []) {
        if (!ab.abilityHrid) continue;
        const isSpecial = abilityDetailMap[ab.abilityHrid]?.isSpecialAbility || false;
        const abilityDTO = {
            hrid: ab.abilityHrid,
            level: currentAbilityLevels[ab.abilityHrid] || 1,
            triggers: buildTriggers(ab.abilityHrid),
        };
        if (isSpecial) {
            dto.abilities[0] = abilityDTO;
        } else if (normalAbilityIndex < 5) {
            dto.abilities[normalAbilityIndex++] = abilityDTO;
        }
    }

    // Convert food (3 slots)
    dto.food = [];
    for (let i = 0; i < 3; i++) {
        const foodItem = snapshot.food?.[i];
        if (foodItem?.itemHrid) {
            dto.food.push({ hrid: foodItem.itemHrid, triggers: buildTriggers(foodItem.itemHrid) });
        } else {
            dto.food.push(null);
        }
    }

    // Convert drinks (3 slots)
    dto.drinks = [];
    for (let i = 0; i < 3; i++) {
        const drinkItem = snapshot.drinks?.[i];
        if (drinkItem?.itemHrid) {
            dto.drinks.push({ hrid: drinkItem.itemHrid, triggers: buildTriggers(drinkItem.itemHrid) });
        } else {
            dto.drinks.push(null);
        }
    }

    return true;
}

/**
 * Calculate expected drops from simulation results for a specific player.
 * Uses deterministic expected-value math (no RNG rolls).
 * @param {Object} simResult - SimResult from the engine
 * @param {Object} gameData - Game data maps
 * @param {string} [playerHrid='player1'] - Which player's drop multipliers to use
 * @returns {Map<string, number>} itemHrid → expected total drop count
 */
export function calculateExpectedDrops(simResult, gameData, playerHrid = 'player1') {
    const combatMonsterDetailMap = gameData.combatMonsterDetailMap;
    const dropRateMultiplier = simResult.dropRateMultiplier[playerHrid] || 1;
    const rareFindMultiplier = simResult.rareFindMultiplier?.[playerHrid] || 1;
    const combatDropQuantity = simResult.combatDropQuantity?.[playerHrid] || 0;
    const debuffOnLevelGap = simResult.debuffOnLevelGap?.[playerHrid] || 0;
    const numberOfPlayers = simResult.numberOfPlayers || 1;
    const difficultyTier = simResult.difficultyTier || 0;

    const totalDropMap = new Map();

    if (simResult.isDungeon) {
        // Dungeons: only completion rewards, no per-monster drops
        if (simResult.dungeonsCompleted > 0) {
            const zoneHrid = simResult.zoneName;
            const actionDetailMap = gameData.actionDetailMap || {};
            const actionDetail = actionDetailMap[zoneHrid];
            const rewardDropTable = actionDetail?.combatZoneInfo?.dungeonInfo?.rewardDropTable;

            if (rewardDropTable) {
                const baseChestCount = 5;
                const chestsPerCompletion = (baseChestCount / numberOfPlayers) * (1 + combatDropQuantity);

                for (const drop of rewardDropTable) {
                    const baseRate = drop.dropRate + (drop.dropRatePerDifficultyTier ?? 0) * difficultyTier;
                    const adjustedRate = Math.min(1.0, Math.max(0, baseRate));
                    if (adjustedRate <= 0) continue;

                    const avgCount = (drop.minCount + drop.maxCount) / 2;
                    let expected;
                    if (adjustedRate >= 1.0) {
                        expected = simResult.dungeonsCompleted * chestsPerCompletion * avgCount;
                    } else {
                        expected = simResult.dungeonsCompleted * adjustedRate * avgCount;
                    }

                    totalDropMap.set(drop.itemHrid, (totalDropMap.get(drop.itemHrid) || 0) + expected);
                }
            }
        }
    } else {
        // Regular zones: per-monster drops from kill counts
        const monsters = Object.keys(simResult.deaths).filter((hrid) => !hrid.startsWith('player'));

        for (const monsterHrid of monsters) {
            const monsterData = combatMonsterDetailMap[monsterHrid];
            if (!monsterData) continue;

            const killCount = simResult.deaths[monsterHrid];

            // Regular drops
            if (monsterData.dropTable) {
                for (const drop of monsterData.dropTable) {
                    if (drop.minDifficultyTier > difficultyTier) continue;

                    const tierMultiplier = 1.0 + 0.1 * difficultyTier;
                    const baseRate = drop.dropRate + (drop.dropRatePerDifficultyTier ?? 0) * difficultyTier;
                    const adjustedRate = Math.min(1.0, tierMultiplier * baseRate * dropRateMultiplier);
                    if (adjustedRate <= 0) continue;

                    const avgCount = (drop.minCount + drop.maxCount) / 2;
                    const expected =
                        (killCount * adjustedRate * avgCount * (1 + debuffOnLevelGap) * (1 + combatDropQuantity)) /
                        numberOfPlayers;

                    totalDropMap.set(drop.itemHrid, (totalDropMap.get(drop.itemHrid) || 0) + expected);
                }
            }

            // Rare drops
            if (monsterData.rareDropTable) {
                for (const drop of monsterData.rareDropTable) {
                    if (drop.minDifficultyTier > difficultyTier) continue;

                    const adjustedRate = drop.dropRate * rareFindMultiplier;
                    const avgCount = (drop.minCount + (drop.maxCount ?? drop.minCount)) / 2;
                    const expected =
                        (killCount * adjustedRate * avgCount * (1 + debuffOnLevelGap) * (1 + combatDropQuantity)) /
                        numberOfPlayers;

                    totalDropMap.set(drop.itemHrid, (totalDropMap.get(drop.itemHrid) || 0) + expected);
                }
            }
        }
    }

    return totalDropMap;
}

/**
 * Calculate dungeon key costs from a drop map.
 * Entry keys (1:1 with regular chests) + chest keys (1:1 with all chests).
 * @param {Map<string, number>} dropMap - itemHrid → expected count from calculateExpectedDrops
 * @param {Function} getBuyPrice - Function to get buy price for an item (from UI)
 * @returns {Array<{itemHrid: string, name: string, count: number, unitCost: number, totalCost: number}>}
 */
export function calculateDungeonKeyCosts(dropMap, getBuyPrice) {
    const costs = [];
    if (!dropMap) return costs;

    const keyCounts = {};

    // Entry keys: 1 per regular chest
    for (const [chestHrid, count] of dropMap.entries()) {
        const entryKeyHrid = DUNGEON_CHEST_ENTRY_KEYS[chestHrid];
        if (entryKeyHrid && count > 0) {
            keyCounts[entryKeyHrid] = (keyCounts[entryKeyHrid] || 0) + count;
        }
    }

    // Chest keys: 1 per chest (regular + refinement)
    for (const [chestHrid, count] of dropMap.entries()) {
        const chestKeyHrid = DUNGEON_CHEST_CHEST_KEYS[chestHrid];
        if (chestKeyHrid && count > 0) {
            keyCounts[chestKeyHrid] = (keyCounts[chestKeyHrid] || 0) + count;
        }
    }

    for (const [keyHrid, count] of Object.entries(keyCounts)) {
        const unitCost = getBuyPrice(keyHrid);
        const keyDetails = dataManager.getItemDetails(keyHrid);
        costs.push({
            itemHrid: keyHrid,
            name: keyDetails?.name || keyHrid.split('/').pop(),
            count,
            unitCost,
            totalCost: count * unitCost,
        });
    }

    return costs.sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * Get the sell price for an item based on the global pricing mode.
 * @param {Object|null} priceData - { bid, ask } from marketAPI.getPrice()
 * @returns {number}
 */
function getSellPrice(priceData) {
    if (!priceData) return 0;
    const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    if (mode === 'conservative' || mode === 'patientBuy') {
        return priceData.bid > 0 ? priceData.bid : 0;
    }
    return priceData.ask > 0 ? priceData.ask : 0;
}

/**
 * Get the buy price for an item based on the global pricing mode.
 * @param {Object|null} priceData - { bid, ask } from marketAPI.getPrice()
 * @returns {number}
 */
function getBuyPrice(priceData) {
    if (!priceData) return 0;
    const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    if (mode === 'optimistic' || mode === 'patientBuy') {
        return priceData.bid > 0 ? priceData.bid : 0;
    }
    return priceData.ask > 0 ? priceData.ask : 0;
}

/**
 * A drop's market sell value net of the sale tax.
 *
 * The sim reports what drops are worth, and selling on the market is taxed — so
 * a drop is worth its sell price *after* tax, not gross (which is what the sim
 * used to report, so the 8/13 rise to 5% never moved it). Coin is not sold and
 * is left whole; cowbell bags carry their own higher rate. A non-positive gross
 * passes straight through, so a caller's expected-value fallback still runs on
 * zero — and that fallback value must not be re-taxed here, since it is already
 * net.
 *
 * @param {string} itemHrid - The dropped item
 * @param {number} grossValue - The gross market sell price
 * @returns {number} The value after sale tax
 */
export function taxedDropValue(itemHrid, grossValue) {
    if (!(grossValue > 0) || itemHrid === '/items/coin') return grossValue;
    const taxRate = itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;
    return calculatePriceAfterTax(grossValue, taxRate);
}

/**
 * Calculate revenue and costs from a sim result.
 * Respects the user's profitCalc_pricingMode setting. `costPerHour` covers consumables and, in a
 * dungeon, the entry and chest keys the runs consume.
 * @param {Object} simResult - SimResult from runSimulation()
 * @param {Object} gameData - Game data payload from buildGameDataPayload()
 * @param {string} playerHrid - Player HRID to read drop multipliers and consumables for
 * @param {number} hours - Number of hours simulated
 * @returns {{ revenuePerHour: number, costPerHour: number, keyCostPerHour: number, netPerHour: number,
 *             dropEntries: Array, consumableEntries: Array }}
 */
export function calculateSimRevenue(simResult, gameData, playerHrid, hours) {
    let revenuePerHour = 0;
    const dropEntries = [];

    const dropMap = calculateExpectedDrops(simResult, gameData, playerHrid);
    for (const [itemHrid, total] of dropMap.entries()) {
        if (total <= 0) continue;
        let unitValue =
            itemHrid === '/items/coin' ? 1 : taxedDropValue(itemHrid, getSellPrice(marketAPI.getPrice(itemHrid)));
        if (unitValue === 0) {
            // The EV fallback already nets the sale tax (see expected-value-calculator),
            // so it is taken as-is.
            const evc = expectedValueCalculator() || bundledExpectedValueCalculator;
            const ev = evc.getCachedValue(itemHrid) || evc.calculateSingleContainer(itemHrid);
            if (ev !== null && ev > 0) unitValue = ev;
        }
        const perHour = (total / hours) * unitValue;
        revenuePerHour += perHour;
        if (unitValue > 0) {
            const itemName = dataManager.getItemDetails(itemHrid)?.name || itemHrid.split('/').pop();
            // itemHrid rides along so display surfaces can bound the quoted
            // pace by the item's observed trade volume
            dropEntries.push({ itemHrid, name: itemName, countPerHour: total / hours, unitValue, totalValue: perHour });
        }
    }
    dropEntries.sort((a, b) => b.totalValue - a.totalValue);

    let costPerHour = 0;
    const consumableEntries = [];
    const consumablesUsed = simResult.consumablesUsed?.[playerHrid] || {};
    for (const [itemHrid, count] of Object.entries(consumablesUsed)) {
        const unitCost = getBuyPrice(marketAPI.getPrice(itemHrid));
        const perHour = (count / hours) * unitCost;
        costPerHour += perHour;
        if (unitCost > 0) {
            const itemName = dataManager.getItemDetails(itemHrid)?.name || itemHrid.split('/').pop();
            consumableEntries.push({ name: itemName, countPerHour: count / hours, unitCost, totalCost: perHour });
        }
    }

    // Dungeon keys are a cost of running the dungeon, and every caller of this
    // function was reading a net figure that left them out: the all-zones table
    // ranked dungeons against zones on revenue that had not paid for entry, the
    // upgrade advisor priced a faster clear without the keys the extra runs eat,
    // and the task profit display did the same. The Results detail view is the
    // only place that ever added them, and it computes its own figure from the
    // same helper rather than reading this one, so nothing double-counts.
    let keyCostPerHour = 0;
    if (simResult.isDungeon) {
        for (const key of calculateDungeonKeyCosts(dropMap, (keyHrid) => getBuyPrice(marketAPI.getPrice(keyHrid)))) {
            keyCostPerHour += key.totalCost / hours;
        }
        costPerHour += keyCostPerHour;
    }

    return {
        revenuePerHour,
        costPerHour,
        keyCostPerHour,
        netPerHour: revenuePerHour - costPerHour,
        dropEntries,
        consumableEntries,
    };
}

/**
 * Find all zone×tier combinations that drop the specified item.
 * Checks regular zone monster drop tables and dungeon reward drop tables.
 * @param {string} itemHrid - e.g. '/items/soul_hunter_crossbow'
 * @param {Object} gameData - Game data payload from buildGameDataPayload()
 * @returns {Array<{zoneHrid: string, difficultyTier: number, name: string}>} Sorted by sortIndex then tier
 */
export function getZonesThatDropItem(itemHrid, gameData) {
    const { actionDetailMap, combatMonsterDetailMap } = gameData;
    if (!actionDetailMap || !combatMonsterDetailMap) return [];

    const results = [];

    for (const [hrid, action] of Object.entries(actionDetailMap)) {
        if (action.type !== '/action_types/combat') continue;

        const maxDifficulty = action.maxDifficulty || 0;
        const isDungeon = action.combatZoneInfo?.isDungeon || false;

        if (isDungeon) {
            // Dungeon: item comes from the reward drop table (same table for all tiers)
            const rewardDropTable = action.combatZoneInfo?.dungeonInfo?.rewardDropTable;
            if (rewardDropTable?.some((drop) => drop.itemHrid === itemHrid)) {
                for (let tier = 0; tier <= maxDifficulty; tier++) {
                    results.push({ zoneHrid: hrid, difficultyTier: tier, name: action.name });
                }
            }
        } else {
            // Regular zone: check each monster's drop table and rare drop table
            const spawns = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];
            const bossSpawns = action.combatZoneInfo?.fightInfo?.bossSpawns || [];
            const validTiers = new Set();

            for (const spawn of [...spawns, ...bossSpawns]) {
                const monster = combatMonsterDetailMap[spawn.combatMonsterHrid];
                if (!monster) continue;

                for (const drop of monster.dropTable || []) {
                    if (drop.itemHrid !== itemHrid) continue;
                    const minTier = drop.minDifficultyTier || 0;
                    for (let tier = minTier; tier <= maxDifficulty; tier++) {
                        validTiers.add(tier);
                    }
                }

                for (const drop of monster.rareDropTable || []) {
                    if (drop.itemHrid !== itemHrid) continue;
                    const minTier = drop.minDifficultyTier || 0;
                    for (let tier = minTier; tier <= maxDifficulty; tier++) {
                        validTiers.add(tier);
                    }
                }
            }

            for (const tier of validTiers) {
                results.push({ zoneHrid: hrid, difficultyTier: tier, name: action.name });
            }
        }
    }

    results.sort((a, b) => {
        const aSortIndex = actionDetailMap[a.zoneHrid]?.sortIndex ?? 0;
        const bSortIndex = actionDetailMap[b.zoneHrid]?.sortIndex ?? 0;
        if (aSortIndex !== bSortIndex) return aSortIndex - bSortIndex;
        return a.difficultyTier - b.difficultyTier;
    });

    return results;
}
