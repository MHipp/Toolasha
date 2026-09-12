/**
 * House Efficiency Utility
 * Calculates buffs granted by house rooms
 *
 * PART OF EFFICIENCY SYSTEM (Phase 2):
 * - Data source: WebSocket (characterHouseRoomMap) + game data (houseRoomDetailMap)
 * - A room's effect is whatever its own `actionBuffs` say it is, per buff type.
 *   Most skilling rooms grant /buff_types/efficiency at 1.5%/level; the Observatory
 *   grants /buff_types/action_speed to enhancing, which is a different number in a
 *   different formula and must not be added to the efficiency total.
 */

import dataManager from '../core/data-manager.js';

/** The buff a skilling room grants when it makes actions *repeat*. */
const EFFICIENCY_BUFF = '/buff_types/efficiency';

/** The buff a room grants when it makes actions *shorter* (Observatory → enhancing). */
const ACTION_SPEED_BUFF = '/buff_types/action_speed';

/**
 * Does this buff apply to this action type?
 *
 * The game tags the scope in two places and does not always fill both: the buff
 * carries its own `usableInActionTypeMap`, and the room carries one covering all
 * of its buffs. The buff's own tag wins when it exists, because a room with two
 * buffs of different scopes can only express that per buff.
 * @param {Object} buff - Entry from roomDetail.actionBuffs
 * @param {Object} roomDetail - Entry from houseRoomDetailMap
 * @param {string} actionTypeHrid - Action type being asked about
 * @returns {boolean}
 */
function buffCoversActionType(buff, roomDetail, actionTypeHrid) {
    if (buff?.usableInActionTypeMap) return Boolean(buff.usableInActionTypeMap[actionTypeHrid]);
    return Boolean(roomDetail?.usableInActionTypeMap?.[actionTypeHrid]);
}

/**
 * Sum one buff type across every owned house room, for one action type.
 *
 * The per-level scaling is the game's own: `flatBoost` is the level-1 value and
 * `flatBoostLevelBonus` is added once per level above it — the same arithmetic
 * the combat engine's `Buff` applies. For the ordinary skilling rooms both are
 * 0.015, which is where the familiar "1.5% per level" comes from; reading the
 * numbers rather than hardcoding them is what keeps a room that scales
 * differently (or grants a different buff entirely) honest.
 *
 * @param {string} actionTypeHrid - Action type HRID
 * @param {string} buffTypeHrid - Buff type HRID to sum
 * @param {Object|null} gameData - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Summed boost as a ratio (0.12 for 12%)
 */
function sumHouseBuff(actionTypeHrid, buffTypeHrid, gameData) {
    if (!actionTypeHrid) return 0;

    const rooms = dataManager.getHouseRooms();
    if (!rooms || rooms.size === 0) return 0;

    const roomDetailMap = (gameData ?? dataManager.getInitClientData())?.houseRoomDetailMap;
    if (!roomDetailMap) return 0;

    let total = 0;
    for (const [roomHrid, room] of rooms) {
        const level = room.level || 0;
        if (level <= 0) continue;

        const detail = roomDetailMap[room.houseRoomHrid || roomHrid];
        const actionBuffs = detail?.actionBuffs;
        if (!Array.isArray(actionBuffs)) continue;

        for (const buff of actionBuffs) {
            if (buff?.typeHrid !== buffTypeHrid) continue;
            if (!buffCoversActionType(buff, detail, actionTypeHrid)) continue;
            total += (buff.flatBoost || 0) + (level - 1) * (buff.flatBoostLevelBonus || 0);
        }
    }

    return total;
}

/** The buff a room grants when it makes actions worth *more experience*. */
const WISDOM_BUFF = '/buff_types/wisdom';

/**
 * The buff types the skilling maths downstream can actually put a number on.
 *
 * Efficiency grants free repeats, action speed shortens the action, wisdom
 * multiplies the experience: all three land in a gold/hr or XP/hr figure. Every
 * other type a room can carry — rare find above all, which every room grants
 * globally — is real in the game and invisible to those two numbers, so a room
 * whose only buff for a skill is one of them can only ever be ranked at a
 * fictitious zero. Callers ranking rooms exclude those and say why.
 */
export const MODELLED_ROOM_BUFF_TYPES = new Set([EFFICIENCY_BUFF, ACTION_SPEED_BUFF, WISDOM_BUFF]);

/** Buff type hrid → the key it accumulates into in {@link houseBuffTotalsForLevels}. */
const BUFF_TOTAL_KEYS = {
    [EFFICIENCY_BUFF]: 'efficiency',
    [ACTION_SPEED_BUFF]: 'actionSpeed',
    [WISDOM_BUFF]: 'wisdom',
};

/**
 * One room level's worth of a buff, by the game's own scaling.
 * @param {Object} buff - A room's `actionBuffs`/`globalBuffs` entry
 * @param {number} level - The room's level
 * @returns {number} Ratio (0.12 for 12%)
 */
function buffValueAtLevel(buff, level) {
    return (buff?.flatBoost || 0) + (level - 1) * (buff?.flatBoostLevelBonus || 0);
}

/**
 * Read one room's level out of whichever shape the caller keeps them in.
 * @param {Map<string, number>|Object<string, number>|null} roomLevels - Levels by room hrid
 * @param {string} houseRoomHrid - The room
 * @returns {number} Level, 0 when absent or nonsense
 */
function levelOf(roomLevels, houseRoomHrid) {
    if (!roomLevels) return 0;
    const raw = roomLevels instanceof Map ? roomLevels.get(houseRoomHrid) : roomLevels[houseRoomHrid];
    const level = Math.floor(Number(raw));
    return Number.isFinite(level) && level > 0 ? level : 0;
}

/**
 * The buff types one room grants *to one action type*, from its own action buffs.
 *
 * This is what "does this room serve this skill" means in the data: the room's
 * global buffs are granted for owning the room at all and say nothing about
 * which skill it is for. Empty means the room does nothing for that action type
 * beyond what every room does.
 *
 * @param {Object} roomDetail - Entry from `houseRoomDetailMap`
 * @param {string} actionTypeHrid - Action type being asked about
 * @returns {Set<string>} Buff type hrids
 */
export function roomActionBuffTypes(roomDetail, actionTypeHrid) {
    const types = new Set();
    for (const buff of roomDetail?.actionBuffs || []) {
        if (!buff?.typeHrid) continue;
        if (!buffCoversActionType(buff, roomDetail, actionTypeHrid)) continue;
        types.add(buff.typeHrid);
    }
    return types;
}

/**
 * What a hypothetical set of house room levels is worth to one action type.
 *
 * The question {@link calculateHouseEfficiency} cannot answer: it reads the
 * levels the character has, and ranking an upgrade needs "what would this be at
 * one level higher". Both answers come from the same per-buff arithmetic, so a
 * baseline computed here and a target computed here differ by exactly the level
 * that was bought and nothing else.
 *
 * Global buffs are summed unscoped, because that is what the game grants them
 * for — owning the room, not doing a particular action. That is where a room's
 * wisdom comes from, and it is why building *any* room is worth a little XP on
 * everything you do.
 *
 * @param {Map<string, number>|Object<string, number>} roomLevels - Level per room hrid
 * @param {string} actionTypeHrid - Action type HRID
 * @param {Object} houseRoomDetailMap - From game data
 * @returns {{efficiency: number, actionSpeed: number, wisdom: number}} Ratios (0.12 for 12%)
 */
export function houseBuffTotalsForLevels(roomLevels, actionTypeHrid, houseRoomDetailMap) {
    const totals = { efficiency: 0, actionSpeed: 0, wisdom: 0 };
    if (!houseRoomDetailMap || !actionTypeHrid) return totals;

    for (const [roomHrid, detail] of Object.entries(houseRoomDetailMap)) {
        const level = levelOf(roomLevels, roomHrid);
        if (level <= 0) continue;

        for (const buff of detail?.actionBuffs || []) {
            const key = BUFF_TOTAL_KEYS[buff?.typeHrid];
            if (!key) continue;
            if (!buffCoversActionType(buff, detail, actionTypeHrid)) continue;
            totals[key] += buffValueAtLevel(buff, level);
        }

        for (const buff of detail?.globalBuffs || []) {
            const key = BUFF_TOTAL_KEYS[buff?.typeHrid];
            if (!key) continue;
            totals[key] += buffValueAtLevel(buff, level);
        }
    }

    return totals;
}

/**
 * Calculate house efficiency bonus for an action type.
 *
 * Only true efficiency buffs count. The room-level `usableInActionTypeMap` alone
 * used to be the whole test, which credited every buff a listed room has as
 * efficiency: the Observatory covers enhancing, so enhancing was handed a
 * fictitious +1.5%/level of efficiency for what is really an action-speed buff,
 * and combat rooms were credited the same way for queued combat actions.
 *
 * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
 * @param {Object} [options]
 * @param {Object} [options.gameData] - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Efficiency bonus percentage (e.g., 12 for 12%)
 *
 * @example
 * calculateHouseEfficiency("/action_types/brewing")
 * // Returns: 12 (if brewery is level 8: 8 × 1.5% = 12%)
 */
export function calculateHouseEfficiency(actionTypeHrid, { gameData = null } = {}) {
    return sumHouseBuff(actionTypeHrid, EFFICIENCY_BUFF, gameData) * 100;
}

/**
 * Calculate the house action-speed bonus for an action type.
 *
 * Separate from efficiency on purpose: speed shortens each action
 * (`time / (1 + bonus)`), efficiency grants free repeats. The Observatory is the
 * room this exists for — it speeds up enhancing.
 *
 * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/enhancing")
 * @param {Object} [options]
 * @param {Object} [options.gameData] - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Speed bonus as a ratio (0.12 for 12%), matching the other speed sources
 */
export function calculateHouseActionSpeed(actionTypeHrid, { gameData = null } = {}) {
    return sumHouseBuff(actionTypeHrid, ACTION_SPEED_BUFF, gameData);
}

/**
 * Get friendly name for house room
 * @param {string} houseRoomHrid - House room HRID
 * @returns {string} Friendly name
 */
export function getHouseRoomName(houseRoomHrid) {
    const names = {
        '/house_rooms/brewery': 'Brewery',
        '/house_rooms/forge': 'Forge',
        '/house_rooms/kitchen': 'Kitchen',
        '/house_rooms/workshop': 'Workshop',
        '/house_rooms/garden': 'Garden',
        '/house_rooms/dairy_barn': 'Dairy Barn',
        '/house_rooms/sewing_parlor': 'Sewing Parlor',
        '/house_rooms/log_shed': 'Log Shed',
        '/house_rooms/laboratory': 'Laboratory',
    };

    return names[houseRoomHrid] || 'Unknown';
}

/**
 * Calculate total Rare Find bonus from all house rooms
 * @returns {number} Total rare find bonus as percentage (e.g., 1.6 for 1.6%)
 *
 * @example
 * calculateHouseRareFind()
 * // Returns: 1.6 (if total house room levels = 8: 8 × 0.2% per level = 1.6%)
 *
 * Formula from game data:
 * - flatBoostLevelBonus: 0.2% per level
 * - Total: totalLevels × 0.2%
 * - Max: 8 rooms × 8 levels = 64 × 0.2% = 12.8%
 */
export function calculateHouseRareFind() {
    // Get all house rooms
    const houseRooms = dataManager.getHouseRooms();

    if (!houseRooms || houseRooms.size === 0) {
        return 0; // No house rooms
    }

    // Sum all house room levels
    let totalLevels = 0;
    for (const [_hrid, room] of houseRooms) {
        totalLevels += room.level || 0;
    }

    // Formula: totalLevels × flatBoostLevelBonus
    // flatBoostLevelBonus: 0.2% per level (no base bonus)
    const flatBoostLevelBonus = 0.2;

    return totalLevels * flatBoostLevelBonus;
}

export default {
    calculateHouseEfficiency,
    calculateHouseActionSpeed,
    houseBuffTotalsForLevels,
    roomActionBuffTypes,
    getHouseRoomName,
    calculateHouseRareFind,
};
