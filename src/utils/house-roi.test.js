/**
 * Tests for the skilling house-room ROI board.
 *
 * The scorer, the cost calculator and the loadout resolver are all mocked: what
 * is under test is which rooms reach the board, what their rows say, and how
 * they rank — not the tea optimizer's arithmetic, which has its own tests.
 * The buff reading is left real, because "which rooms serve this skill" is
 * exactly the question this module must not get wrong.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const character = vi.hoisted(() => ({
    houseRooms: new Map(),
    roomDetailMap: {},
    actionDetailMap: {},
    actions: [],
    skills: [],
}));

const scorer = vi.hoisted(() => ({
    calls: [],
    /** @type {(skill: string, levels: Map<string, number>) => {xpPerHour: number, goldPerHour: number}} */
    score: () => ({ xpPerHour: 0, goldPerHour: 0 }),
}));

const costs = vi.hoisted(() => ({
    /** @type {(roomHrid: string, level: number) => number} cumulative build cost */
    cumulative: (_hrid, level) => level * 1_000_000,
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getHouseRooms: () => character.houseRooms,
        getCurrentActions: () => character.actions,
        getSkills: () => character.skills,
        getEquipment: () => new Map(),
        getInitClientData: () => ({
            houseRoomDetailMap: character.roomDetailMap,
            actionDetailMap: character.actionDetailMap,
        }),
    },
}));

vi.mock('./house-cost-calculator.js', () => ({
    calculateHouseBuildCost: (hrid, level) => costs.cumulative(hrid, level),
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [{ itemHrid: '/items/wisdom_tea' }] }),
}));

vi.mock('./tea-optimizer.js', () => ({
    SKILL_TO_ACTION_TYPE: {
        milking: '/action_types/milking',
        cooking: '/action_types/cooking',
        brewing: '/action_types/brewing',
        alchemy: '/action_types/alchemy',
    },
    calculateSkillPerformance: (skill, _equipment, _teas, _level, actionHrids, { houseRoomLevels } = {}) => {
        scorer.calls.push({ skill, actionHrids, houseRoomLevels });
        return { teaCostPerHour: 0, hasMissingPrices: false, ...scorer.score(skill, houseRoomLevels) };
    },
}));

const { rankHouseRoomUpgrades, compareHouseRoiRows, nextLevelPrice, queuedSkillActions } =
    await import('./house-roi.js');

const EFFICIENCY = '/buff_types/efficiency';
const WISDOM = '/buff_types/wisdom';
const RARE_FIND = '/buff_types/rare_find';

/**
 * A room detail shaped the way the game ships one.
 * @param {string} name - Display name
 * @param {string} actionType - Action type its own buff covers
 * @param {string} [buffType] - The buff type that action buff grants
 * @returns {Object} A houseRoomDetailMap entry
 */
function room(name, actionType, buffType = EFFICIENCY) {
    return {
        name,
        usableInActionTypeMap: { [actionType]: true },
        actionBuffs: [
            {
                typeHrid: buffType,
                usableInActionTypeMap: { [actionType]: true },
                flatBoost: 0.015,
                flatBoostLevelBonus: 0.015,
            },
        ],
        // Every room in the game grants these for being owned at all.
        globalBuffs: [
            { typeHrid: WISDOM, flatBoost: 0.0005, flatBoostLevelBonus: 0.0005 },
            { typeHrid: RARE_FIND, flatBoost: 0.002, flatBoostLevelBonus: 0.002 },
        ],
    };
}

/**
 * Put an action of a skill in the queue.
 * @param {string} hrid - Action hrid
 * @param {string} actionType - Its action type
 * @param {Object} [extra] - Queue entry overrides, e.g. `{isDone: true}`
 * @returns {void}
 */
function queue(hrid, actionType, extra = {}) {
    character.actionDetailMap[hrid] = { type: actionType };
    character.actions.push({ actionHrid: hrid, isDone: false, ordinal: character.actions.length, ...extra });
}

beforeEach(() => {
    character.roomDetailMap = {
        '/house_rooms/kitchen': room('Kitchen', '/action_types/cooking'),
        '/house_rooms/dairy_barn': room('Dairy Barn', '/action_types/milking'),
        '/house_rooms/dojo': room('Dojo', '/action_types/combat'),
    };
    character.houseRooms = new Map([
        ['/house_rooms/kitchen', { houseRoomHrid: '/house_rooms/kitchen', level: 3 }],
        ['/house_rooms/dairy_barn', { houseRoomHrid: '/house_rooms/dairy_barn', level: 5 }],
        ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 2 }],
    ]);
    character.actionDetailMap = {};
    character.actions = [];
    character.skills = [{ skillHrid: '/skills/cooking', level: 70 }];
    scorer.calls = [];
    scorer.score = () => ({ xpPerHour: 0, goldPerHour: 0 });
    costs.cumulative = (_hrid, level) => level * 1_000_000;
});

describe('queuedSkillActions', () => {
    test('reads the skills out of the queue, ignoring finished actions and combat', () => {
        queue('/actions/cooking/donut', '/action_types/cooking');
        queue('/actions/cooking/cake', '/action_types/cooking');
        queue('/actions/milking/cow', '/action_types/milking', { isDone: true });
        queue('/actions/combat/fly', '/action_types/combat');

        const queued = queuedSkillActions();
        expect([...queued.keys()]).toEqual(['cooking']);
        expect([...queued.get('cooking')]).toEqual(['/actions/cooking/donut', '/actions/cooking/cake']);
    });
});

describe('nextLevelPrice', () => {
    test('one level is the difference of two cumulative costs', () => {
        costs.cumulative = (_hrid, level) => [0, 10, 30, 70, 150][level] ?? 0;
        expect(nextLevelPrice('/house_rooms/kitchen', 2)).toBe(40);
    });

    test('no price at the cap, and none when the game lists no cost', () => {
        expect(nextLevelPrice('/house_rooms/kitchen', 8)).toBeNull();
        costs.cumulative = () => 0;
        expect(nextLevelPrice('/house_rooms/kitchen', 3)).toBeNull();
    });
});

describe('rankHouseRoomUpgrades', () => {
    test('an empty queue is an empty board, not a board of zeroes', () => {
        const result = rankHouseRoomUpgrades();
        expect(result.rows).toEqual([]);
        expect(result.skills).toEqual([]);
        expect(scorer.calls).toEqual([]);
    });

    test('a room serving a skill the character is not running never reaches the board', () => {
        queue('/actions/cooking/donut', '/action_types/cooking');
        scorer.score = (_skill, levels) => ({
            xpPerHour: 1000 * (1 + 0.015 * (levels.get('/house_rooms/kitchen') || 0)),
            goldPerHour: 0,
        });

        const { rows, excluded, offBoardRooms } = rankHouseRoomUpgrades();
        expect(rows.map((r) => r.roomHrid)).toEqual(['/house_rooms/kitchen']);
        // The Dairy Barn and the Dojo are not bad cooking upgrades; they are not
        // cooking upgrades. Neither is listed as an excluded row either.
        expect(excluded).toEqual([]);
        expect(offBoardRooms).toBe(2);
    });

    test('the baseline is scored with the real levels, the upgrade with one more', () => {
        queue('/actions/cooking/donut', '/action_types/cooking');

        rankHouseRoomUpgrades();
        expect(scorer.calls).toHaveLength(2);
        expect(scorer.calls[0].houseRoomLevels.get('/house_rooms/kitchen')).toBe(3);
        expect(scorer.calls[1].houseRoomLevels.get('/house_rooms/kitchen')).toBe(4);
        // Nothing else about the house moved
        expect(scorer.calls[1].houseRoomLevels.get('/house_rooms/dairy_barn')).toBe(5);
        expect([...scorer.calls[0].actionHrids]).toEqual(['/actions/cooking/donut']);
    });

    test('payback is the level price over the gold it buys per hour', () => {
        queue('/actions/milking/cow', '/action_types/milking');
        character.skills = [{ skillHrid: '/skills/milking', level: 60 }];
        costs.cumulative = (_hrid, level) => level * 1_000_000;
        scorer.score = (_skill, levels) => ({
            xpPerHour: 0,
            goldPerHour: levels.get('/house_rooms/dairy_barn') === 6 ? 1_250_000 : 1_000_000,
        });

        const { rows } = rankHouseRoomUpgrades();
        expect(rows).toHaveLength(1);
        expect(rows[0].cost).toBe(1_000_000);
        expect(rows[0].goldDelta).toBe(250_000);
        expect(rows[0].paybackHours).toBe(4);
        expect(rows[0].goal).toBe('gold');
    });

    test('a room that only moves XP is ranked on XP and claims no gold gain', () => {
        character.roomDetailMap['/house_rooms/kitchen'] = room('Kitchen', '/action_types/cooking', WISDOM);
        queue('/actions/cooking/donut', '/action_types/cooking');
        scorer.score = (_skill, levels) => ({
            xpPerHour: levels.get('/house_rooms/kitchen') === 4 ? 1_100_000 : 1_000_000,
            goldPerHour: 500_000,
        });

        const { rows } = rankHouseRoomUpgrades();
        expect(rows).toHaveLength(1);
        expect(rows[0].xpDelta).toBe(100_000);
        expect(rows[0].goldDelta).toBe(0);
        expect(rows[0].paybackHours).toBeNull();
        expect(rows[0].xpPerMillion).toBe(100_000);
        expect(rows[0].buffTypes).toEqual([WISDOM]);
    });

    test('a room whose only bonus for the skill is one the figures cannot see is excluded, with the reason', () => {
        character.roomDetailMap['/house_rooms/kitchen'] = room('Kitchen', '/action_types/cooking', RARE_FIND);
        queue('/actions/cooking/donut', '/action_types/cooking');

        const { rows, excluded } = rankHouseRoomUpgrades();
        expect(rows).toEqual([]);
        expect(excluded).toHaveLength(1);
        expect(excluded[0].roomName).toBe('Kitchen');
        expect(excluded[0].reason).toContain('rare find');
        // Never scored — a row that cannot be measured is not measured
        expect(scorer.calls.every((call) => call.houseRoomLevels.get('/house_rooms/kitchen') === 3)).toBe(true);
    });

    test('a maxed room is excluded with that as the reason rather than ranked at zero', () => {
        character.houseRooms.set('/house_rooms/kitchen', { houseRoomHrid: '/house_rooms/kitchen', level: 8 });
        queue('/actions/cooking/donut', '/action_types/cooking');

        const { rows, excluded } = rankHouseRoomUpgrades();
        expect(rows).toEqual([]);
        expect(excluded[0].reason).toBe('Already level 8');
    });

    test('alchemy rows carry no gold gain at all, because the gold figure cannot see the house', () => {
        character.roomDetailMap['/house_rooms/laboratory'] = room('Laboratory', '/action_types/alchemy');
        character.houseRooms.set('/house_rooms/laboratory', {
            houseRoomHrid: '/house_rooms/laboratory',
            level: 1,
        });
        queue('/actions/alchemy/decompose', '/action_types/alchemy');
        scorer.score = () => ({ xpPerHour: 100, goldPerHour: 7_000_000 });

        const { rows } = rankHouseRoomUpgrades();
        expect(rows).toHaveLength(1);
        expect(rows[0].goldModelled).toBe(false);
        expect(rows[0].goldDelta).toBeNull();
        expect(rows[0].paybackHours).toBeNull();
    });

    test('a room serving two queued skills is one row per skill, each with its own payback', () => {
        character.roomDetailMap['/house_rooms/kitchen'].actionBuffs.push({
            typeHrid: EFFICIENCY,
            usableInActionTypeMap: { '/action_types/brewing': true },
            flatBoost: 0.015,
            flatBoostLevelBonus: 0.015,
        });
        queue('/actions/cooking/donut', '/action_types/cooking');
        queue('/actions/brewing/tea', '/action_types/brewing');
        scorer.score = (skill, levels) => ({
            xpPerHour: 0,
            goldPerHour:
                levels.get('/house_rooms/kitchen') === 4 ? (skill === 'cooking' ? 1_500_000 : 1_100_000) : 1_000_000,
        });

        const { rows } = rankHouseRoomUpgrades();
        expect(rows.map((r) => r.skill).sort()).toEqual(['brewing', 'cooking']);
        expect(rows.find((r) => r.skill === 'cooking').paybackHours).toBe(2);
        expect(rows.find((r) => r.skill === 'brewing').paybackHours).toBe(10);
    });
});

describe('compareHouseRoiRows', () => {
    /**
     * @param {Object} fields - Row fields worth setting
     * @returns {Object} A row good enough to sort
     */
    const row = (fields) => ({ roomName: 'R', skill: 's', goal: 'gold', ...fields });

    test('payback sorts fastest first and puts a row with no payback last', () => {
        const fast = row({ paybackHours: 2 });
        const slow = row({ paybackHours: 40 });
        const none = row({ paybackHours: null });
        expect([slow, none, fast].sort((a, b) => compareHouseRoiRows(a, b, 'payback'))).toEqual([fast, slow, none]);
    });

    test('cost sorts cheapest first and puts an unpriceable level last', () => {
        const cheap = row({ cost: 10 });
        const dear = row({ cost: 900 });
        const unpriced = row({ cost: null });
        expect([unpriced, dear, cheap].sort((a, b) => compareHouseRoiRows(a, b, 'cost'))).toEqual([
            cheap,
            dear,
            unpriced,
        ]);
    });

    test('value follows the skill goal: payback for gathering, XP per million otherwise', () => {
        const gathering = [row({ paybackHours: 9 }), row({ paybackHours: 3 })];
        expect(gathering.sort((a, b) => compareHouseRoiRows(a, b, 'value'))[0].paybackHours).toBe(3);

        const production = [
            row({ goal: 'xp', xpPerMillion: 100 }),
            row({ goal: 'xp', xpPerMillion: 900 }),
            row({ goal: 'xp', xpPerMillion: null }),
        ];
        expect(production.sort((a, b) => compareHouseRoiRows(a, b, 'value')).map((r) => r.xpPerMillion)).toEqual([
            900,
            100,
            null,
        ]);
    });

    test('two unrankable rows fall back to the room name rather than to NaN', () => {
        const a = row({ roomName: 'Brewery', paybackHours: null });
        const b = row({ roomName: 'Armory', paybackHours: null });
        expect(compareHouseRoiRows(a, b, 'payback')).toBeGreaterThan(0);
    });
});
