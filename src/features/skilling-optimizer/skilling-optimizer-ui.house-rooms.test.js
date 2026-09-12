/** @vitest-environment happy-dom */
/**
 * Coverage for the House Rooms board in the optimizer results.
 *
 * The ranking itself is `utils/house-roi.js`'s and is tested there; what is here is what the
 * board actually says. Three things have to survive: a room that only moves XP must not grow a
 * gold figure, a room that cannot be modelled must appear as an exclusion with its reason
 * rather than as a zero-value row, and the payback caveat must be on screen wherever a payback
 * figure is — a payback time with the "while you keep doing that skill" part left off is a
 * promise the number cannot keep.
 *
 * Like the cost-payback tests, this drives the plain instance method against happy-dom rather
 * than standing up the whole panel.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const board = vi.hoisted(() => ({ result: { rows: [], excluded: [], skills: [], offBoardRooms: 0 } }));

vi.mock('../../utils/house-roi.js', async (importOriginal) => ({
    ...(await importOriginal()),
    rankHouseRoomUpgrades: () => {
        if (board.result instanceof Error) throw board.result;
        return board.result;
    },
}));

const { skillingSimulatorUI } = await import('./skilling-optimizer-ui.js');

const ui = skillingSimulatorUI;

/**
 * A board row as rankHouseRoomUpgrades returns one.
 * @param {Object} over - Fields worth setting per test
 * @returns {Object} Row
 */
const row = (over = {}) => ({
    roomHrid: '/house_rooms/kitchen',
    roomName: 'Kitchen',
    skill: 'cooking',
    goal: 'xp',
    goldModelled: true,
    buffTypes: ['/buff_types/efficiency'],
    currentLevel: 3,
    nextLevel: 4,
    cost: 1_000_000,
    xpBaseline: 1_000_000,
    goldBaseline: 500_000,
    xpDelta: 20_000,
    goldDelta: 10_000,
    hasMissingPrices: false,
    xpPerMillion: 20_000,
    paybackHours: 100,
    ...over,
});

/**
 * Render the section and hand back its text.
 * @returns {string}
 */
function render() {
    const container = document.createElement('div');
    ui._renderHouseRooms(container, { skill: 'Cooking' }, null, null);
    return container.textContent;
}

beforeEach(() => {
    board.result = { rows: [], excluded: [], skills: [], offBoardRooms: 0 };
    ui.houseSortMode = 'value';
});

describe('the House Rooms board', () => {
    test('names the room, the level it buys, the skill it buys it for, and the payback', () => {
        board.result = { rows: [row()], excluded: [], skills: ['cooking'], offBoardRooms: 15 };

        const text = render();
        expect(text).toContain('House Rooms');
        expect(text).toContain('Kitchen Lv3 → Lv4');
        expect(text).toContain('for cooking');
        expect(text).toContain('+20.0K XP/hr');
        expect(text).toContain('+10.0K gold/hr');
        expect(text).toContain('Cost: 1.0M');
        expect(text).toContain('Payback:');
        expect(text).toContain('Payback assumes you keep running that skill');
    });

    test('a room that only moves XP shows no gold gain and no payback', () => {
        board.result = {
            rows: [row({ goldDelta: 0, paybackHours: null, buffTypes: ['/buff_types/wisdom'] })],
            excluded: [],
            skills: ['cooking'],
            offBoardRooms: 15,
        };

        const text = render();
        expect(text).toContain('+20.0K XP/hr');
        expect(text).not.toContain('gold/hr');
        expect(text).not.toContain('Payback:');
        expect(text).not.toContain('NaN');
        expect(text).not.toContain('Infinity');
    });

    test('a skill whose gold the scorer cannot model says so instead of showing a zero', () => {
        board.result = {
            rows: [row({ skill: 'alchemy', goldModelled: false, goldDelta: null, paybackHours: null })],
            excluded: [],
            skills: ['alchemy'],
            offBoardRooms: 15,
        };

        const text = render();
        expect(text).toContain('gold effect not modelled');
        expect(text).not.toContain('+0 gold/hr');
        expect(text).not.toContain('Payback:');
    });

    test('an unmodellable room is listed as an exclusion with its reason, not as a row', () => {
        board.result = {
            rows: [],
            excluded: [
                {
                    roomHrid: '/house_rooms/kitchen',
                    roomName: 'Kitchen',
                    skill: 'cooking',
                    reason: 'Its cooking bonus is rare find — nothing the gold or XP figures can measure',
                },
            ],
            skills: ['cooking'],
            offBoardRooms: 15,
        };

        const text = render();
        expect(text).toContain('Kitchen - not ranked: Its cooking bonus is rare find');
        expect(text).not.toContain('Lv3 → Lv4');
        expect(text).not.toContain('Sort:');
    });

    test('nothing skilling queued says so rather than drawing an empty ranking', () => {
        const text = render();
        expect(text).toContain('Nothing skilling in your action queue');
        expect(text).not.toContain('Sort:');
    });

    test('a board that cannot be built costs itself, not the results above it', () => {
        board.result = new Error('no house');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => render()).not.toThrow();
        expect(render()).toContain('could not be ranked');
        errors.mockRestore();
    });

    test('the sort control offers the three modes the equipment board offers, and no more', () => {
        board.result = { rows: [row()], excluded: [], skills: ['cooking'], offBoardRooms: 15 };

        const container = document.createElement('div');
        ui._renderHouseRooms(container, { skill: 'Cooking' }, null, null);
        const options = [...container.querySelectorAll('option')].map((o) => o.value);
        expect(options).toEqual(['value', 'payback', 'cost']);
    });
});
