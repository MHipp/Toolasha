/**
 * House room return on investment, for skilling
 *
 * Which room's next level buys the most, for the skills you are actually
 * running. The pieces have all been here for a while and never met: the cost
 * calculator prices a level, the buff data says what a level grants, and the
 * tea optimizer scores a kit's gold/hr and XP/hr. What was missing was the one
 * seam that lets the scorer be asked about a room level you do not own yet —
 * `calculateSkillPerformance`'s `houseRoomLevels` option — and somewhere to put
 * the answers side by side.
 *
 * The combat half of this question already has a board: the upgrade advisor
 * ranks rooms by gold per 0.01% win rate. This is its skilling counterpart.
 *
 * ## What "the skills you run" means here
 *
 * The unfinished actions in your queue, and nothing else. It is a deliberately
 * narrow reading: the payback figure on every row is "how long until this level
 * pays for itself at this skill's gold/hr", which is only true while you keep
 * doing that skill, and the queue is the only honest evidence of that. A room
 * whose skill is not in the queue is left off the board rather than ranked at a
 * zero it did not earn — the Dojo is not a bad cooking upgrade, it is not a
 * cooking upgrade.
 *
 * ## What a level is worth
 *
 * Read from the room's own buffs rather than assumed. A skilling room's
 * `actionBuffs` grant efficiency to their skill; every room's `globalBuffs`
 * grant a little wisdom and rare find for owning it at all. Efficiency, action
 * speed and wisdom all land in the two numbers this ranks on. Rare find does
 * not, and neither does anything else the game may add — a room whose only
 * buff for your skill is one of those is excluded with that reason showing,
 * because ranking it would mean ranking it at a fictitious zero.
 */

import dataManager from '../core/data-manager.js';
import { MODELLED_ROOM_BUFF_TYPES, roomActionBuffTypes } from './house-efficiency.js';
import { calculateHouseBuildCost } from './house-cost-calculator.js';
import { calculateSkillPerformance, SKILL_TO_ACTION_TYPE } from './tea-optimizer.js';
import { resolveActionContext } from './action-context.js';

/** The game's ceiling on a house room. */
export const MAX_ROOM_LEVEL = 8;

/**
 * Skills whose board is read on gold rather than XP.
 *
 * The same split the skilling optimizer's own goal uses, so "Best Value" means
 * the same thing on both boards: gathering is done for what it sells, the
 * production skills for the levels.
 */
const GOLD_GOAL_SKILLS = new Set(['milking', 'foraging', 'woodcutting']);

/**
 * Skills whose gold/hr the tea optimizer derives from the alchemy profit
 * calculator rather than from action data.
 *
 * That calculator knows nothing about a hypothetical house, so an alchemy row's
 * gold figure would come back identical either side of the upgrade and read as
 * "this level earns you nothing". Those rows carry no gold gain and no payback
 * at all, and say so, rather than a zero that looks like a measurement.
 */
const GOLD_UNMODELLED_SKILLS = new Set(['alchemy']);

/** Action type hrid → skill name, the inverse of the optimizer's own map. */
const SKILL_FOR_ACTION_TYPE = Object.fromEntries(
    Object.entries(SKILL_TO_ACTION_TYPE).map(([skill, actionType]) => [actionType, skill])
);

/** Human wording for the buff types a row cannot be ranked on. */
const BUFF_TYPE_NAMES = {
    '/buff_types/rare_find': 'rare find',
    '/buff_types/gathering': 'gathering quantity',
    '/buff_types/essence_find': 'essence find',
    '/buff_types/experience': 'experience',
};

/**
 * Readable name for a buff type, falling back to its own slug.
 * @param {string} typeHrid - e.g. `/buff_types/rare_find`
 * @returns {string}
 */
export function buffTypeName(typeHrid) {
    if (BUFF_TYPE_NAMES[typeHrid]) return BUFF_TYPE_NAMES[typeHrid];
    return String(typeHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ');
}

/**
 * The skilling skills the character has queued, with the actions they queued.
 *
 * Unfinished actions only, and only the skills the optimizer can score. A
 * repeating action requeued to the front of the array is still the same skill,
 * so nothing here depends on queue order.
 *
 * @returns {Map<string, Set<string>>} skill name → that skill's queued action hrids
 */
export function queuedSkillActions() {
    const gameData = dataManager.getInitClientData();
    const actions = dataManager.getCurrentActions() || [];
    const bySkill = new Map();

    for (const action of actions) {
        if (!action || action.isDone) continue;
        const actionType = gameData?.actionDetailMap?.[action.actionHrid]?.type;
        const skill = SKILL_FOR_ACTION_TYPE[actionType];
        if (!skill) continue;
        if (!bySkill.has(skill)) bySkill.set(skill, new Set());
        bySkill.get(skill).add(action.actionHrid);
    }

    return bySkill;
}

/**
 * The character's house as a plain level map.
 * @returns {Map<string, number>} room hrid → level
 */
export function currentRoomLevels() {
    const levels = new Map();
    for (const [hrid, room] of dataManager.getHouseRooms() || []) {
        levels.set(room?.houseRoomHrid || hrid, room?.level || 0);
    }
    return levels;
}

/**
 * What the next level of one room costs on its own.
 *
 * The cost calculator answers cumulatively — what a room costs from nothing to
 * a level — so one level's price is the difference between two of its answers.
 * The Houses panel does the same arithmetic for the same reason; this does not
 * import it because that module is a floating panel and this is a utility.
 *
 * @param {string} houseRoomHrid - Room
 * @param {number} currentLevel - Level it is at now
 * @returns {number|null} Cost of the next level, or null when there is no
 *   priceable next level (already at the cap, or the game lists no cost)
 */
export function nextLevelPrice(houseRoomHrid, currentLevel) {
    if (currentLevel >= MAX_ROOM_LEVEL) return null;
    const cost =
        calculateHouseBuildCost(houseRoomHrid, currentLevel + 1) - calculateHouseBuildCost(houseRoomHrid, currentLevel);
    return cost > 0 ? cost : null;
}

/**
 * The kit the character actually runs a skill with, as the scorer wants it.
 * @param {string} skill - Skill name, lowercase
 * @returns {{equipment: Map, teaHrids: string[], playerLevel: number}}
 */
function skillContext(skill) {
    const actionType = SKILL_TO_ACTION_TYPE[skill];
    const { equipment, drinks } = resolveActionContext(actionType);
    const teaHrids = (drinks || []).map((drink) => drink?.itemHrid).filter(Boolean);

    let playerLevel = 1;
    for (const entry of dataManager.getSkills() || []) {
        if (entry?.skillHrid === `/skills/${skill}`) {
            playerLevel = entry.level || 1;
            break;
        }
    }

    return { equipment: equipment || new Map(), teaHrids, playerLevel };
}

/**
 * Rank every house room's next level by what it adds to the skills in the queue.
 *
 * Baseline and upgraded figures both come from `calculateSkillPerformance` with
 * an explicit `houseRoomLevels` — the baseline gets the character's real levels
 * rather than omitting the option, so the two sides are computed by the same
 * buff arithmetic and their difference is the level that was bought and nothing
 * else.
 *
 * @returns {{rows: Array<Object>, excluded: Array<{roomHrid: string, roomName: string,
 *   skill: string, reason: string}>, skills: string[], offBoardRooms: number}}
 *   `rows` is one entry per (room, skill) pair — a room serving two queued skills
 *   is two rows, because its payback depends on which of them you keep doing.
 */
export function rankHouseRoomUpgrades() {
    const gameData = dataManager.getInitClientData();
    const detailMap = gameData?.houseRoomDetailMap;
    const queued = queuedSkillActions();
    const empty = { rows: [], excluded: [], skills: [], offBoardRooms: 0 };
    if (!detailMap || queued.size === 0) return { ...empty, skills: [...queued.keys()] };

    const levels = currentRoomLevels();

    // One baseline per skill, not per room: the scorer walks every selected
    // action and is far too expensive to re-run seventeen times for an answer
    // that cannot change.
    const baselines = new Map();
    for (const [skill, actionHrids] of queued) {
        const context = skillContext(skill);
        baselines.set(skill, {
            ...context,
            actionHrids,
            performance: calculateSkillPerformance(
                skill,
                context.equipment,
                context.teaHrids,
                context.playerLevel,
                actionHrids,
                {
                    houseRoomLevels: levels,
                }
            ),
        });
    }

    const rows = [];
    const excluded = [];
    let offBoardRooms = 0;

    for (const [roomHrid, detail] of Object.entries(detailMap)) {
        const roomName = detail?.name || roomHrid.split('/').pop().replace(/_/g, ' ');
        const currentLevel = levels.get(roomHrid) || 0;

        let servesAnything = false;
        for (const [skill] of queued) {
            const buffTypes = roomActionBuffTypes(detail, SKILL_TO_ACTION_TYPE[skill]);
            if (buffTypes.size === 0) continue;
            servesAnything = true;

            const modelled = [...buffTypes].filter((type) => MODELLED_ROOM_BUFF_TYPES.has(type));
            if (modelled.length === 0) {
                const names = [...buffTypes].map(buffTypeName).join(', ');
                excluded.push({
                    roomHrid,
                    roomName,
                    skill,
                    reason: `Its ${skill} bonus is ${names} — nothing the gold or XP figures can measure`,
                });
                continue;
            }

            if (currentLevel >= MAX_ROOM_LEVEL) {
                excluded.push({ roomHrid, roomName, skill, reason: `Already level ${MAX_ROOM_LEVEL}` });
                continue;
            }

            const base = baselines.get(skill);
            const upgraded = new Map(levels);
            upgraded.set(roomHrid, currentLevel + 1);
            const after = calculateSkillPerformance(
                skill,
                base.equipment,
                base.teaHrids,
                base.playerLevel,
                base.actionHrids,
                {
                    houseRoomLevels: upgraded,
                }
            );

            rows.push(
                buildRow({
                    roomHrid,
                    roomName,
                    skill,
                    currentLevel,
                    before: base.performance,
                    after,
                    buffTypes: modelled,
                })
            );
        }

        // Serves nothing you are running. Counted so the board can say how many
        // rooms it left out, never listed as a zero-value upgrade.
        if (!servesAnything) offBoardRooms++;
    }

    return { rows, excluded, skills: [...queued.keys()], offBoardRooms };
}

/**
 * One board row, with the value-for-money figures the raw gains lack.
 *
 * A gain of zero or less leaves its ratio null rather than scoring it: a level
 * that buys nothing has no payback time, and dividing by it would invent one.
 * An unpriceable level leaves both null for the same reason the equipment board
 * does — costing it at zero would make it free and therefore unbeatable.
 *
 * @param {Object} input - Room, skill, level and the two performance readings
 * @returns {Object} Row
 */
function buildRow({ roomHrid, roomName, skill, currentLevel, before, after, buffTypes }) {
    const goldModelled = !GOLD_UNMODELLED_SKILLS.has(skill);
    const cost = nextLevelPrice(roomHrid, currentLevel);

    const xpDelta = Math.max(0, (after.xpPerHour || 0) - (before.xpPerHour || 0));
    const goldDelta = goldModelled ? Math.max(0, (after.goldPerHour || 0) - (before.goldPerHour || 0)) : null;

    return {
        roomHrid,
        roomName,
        skill,
        goal: GOLD_GOAL_SKILLS.has(skill) ? 'gold' : 'xp',
        goldModelled,
        buffTypes,
        currentLevel,
        nextLevel: currentLevel + 1,
        cost,
        xpBaseline: before.xpPerHour || 0,
        goldBaseline: before.goldPerHour || 0,
        xpDelta,
        goldDelta,
        hasMissingPrices: Boolean(after.hasMissingPrices || before.hasMissingPrices),
        xpPerMillion: cost === null || xpDelta <= 0 ? null : (xpDelta / cost) * 1_000_000,
        paybackHours: cost === null || !goldDelta || goldDelta <= 0 ? null : cost / goldDelta,
    };
}

/**
 * Ascending sort key for one row — lower sorts first, and a row with no figure
 * for the requested mode sorts last.
 *
 * The same three modes the equipment board offers, meaning the same three
 * things: Best Value follows the skill's own goal, Payback is the fastest
 * return, Cost is the smallest cheque.
 *
 * @param {Object} row - A row from {@link rankHouseRoomUpgrades}
 * @param {string} sortMode - 'value' | 'payback' | 'cost'
 * @returns {number}
 */
export function houseRoiSortValue(row, sortMode) {
    switch (sortMode) {
        case 'payback':
            return row.paybackHours ?? Infinity;
        case 'cost':
            return row.cost ?? Infinity;
        case 'value':
        default:
            return row.goal === 'gold' ? (row.paybackHours ?? Infinity) : -(row.xpPerMillion ?? -Infinity);
    }
}

/**
 * Order two rows under the chosen sort mode.
 *
 * The NaN guard is the equipment board's: two unrankable rows both score
 * Infinity and subtract to NaN, and a comparator returning NaN is not a total
 * order. Room name is the tiebreak, so an unrankable set keeps a stable layout.
 *
 * @param {Object} a - One row
 * @param {Object} b - The other
 * @param {string} sortMode - 'value' | 'payback' | 'cost'
 * @returns {number} Negative when `a` sorts first
 */
export function compareHouseRoiRows(a, b, sortMode) {
    const diff = houseRoiSortValue(a, sortMode) - houseRoiSortValue(b, sortMode);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.roomName.localeCompare(b.roomName) || a.skill.localeCompare(b.skill);
}

export default {
    MAX_ROOM_LEVEL,
    buffTypeName,
    compareHouseRoiRows,
    currentRoomLevels,
    houseRoiSortValue,
    nextLevelPrice,
    queuedSkillActions,
    rankHouseRoomUpgrades,
};
