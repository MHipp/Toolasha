/**
 * @vitest-environment happy-dom
 *
 * The luck tile, drawn.
 *
 * It was two tiles — Drop Luck and Over Expected % — and is one, which is what
 * makes these tests worth keeping rather than deleting: the merge is exactly the
 * change that could put one measurement in both columns. The percentile and
 * takings-against-expectation are different measurements of one session, and a
 * tile that quietly renders one where the other belongs looks entirely correct.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ rows: {}, party: null, options: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback, COLOR_TEXT_PRIMARY: '#fff' },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1 }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('./party-luck.js', () => ({ partyLuck: () => game.party }));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
    rowOption: (key) => Boolean(game.options[key]),
}));

const combatDropLuck = (await import('./combat-drop-luck.js')).default;

/**
 * Draw one tile and hand back its text.
 * @param {string} key - The row key
 * @returns {string}
 */
function draw(key) {
    const container = document.createElement('div');
    game.rows[key].render(container);
    return container.textContent;
}

beforeEach(() => {
    game.options = {};
    // Not in a dungeon unless a test says so; the reading is a live method and
    // the dungeon tests replace it
    combatDropLuck.chests = null;
    delete combatDropLuck.dungeonChestLuck;
    combatDropLuck.lastResult = {
        percentile: 0.347,
        income: 44_870_000,
        expected: 47_880_000,
        battles: 900,
        players: [],
    };
    game.party = {
        battles: 900,
        players: [{ name: 'Millennium44', isCurrentPlayer: true, percent: -6.3 }],
        total: { percent: -6.3 },
    };
});

describe('the merged luck tile', () => {
    test('it carries both figures on one line: the percentile and the takings', () => {
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        // The percentile, and beside it how far off expectation the run landed
        expect(text).toContain('34.7%');
        expect(text).toContain('-6.3%');
    });

    test('there is no Over Expected tile left to register', () => {
        // The whole point of the merge: one key, so a saved layout keeps its
        // tile and nobody ends up with the same run measured twice
        expect(game.rows.overExpected).toBeUndefined();
        expect(game.rows.luck).toBeDefined();
    });

    test('solo it stays one line, without a total that is the line again', () => {
        expect(draw('luck')).not.toContain('TOTAL');
    });

    test('with nothing measured it draws nothing rather than a zero', () => {
        combatDropLuck.lastResult = null;
        expect(draw('luck')).toBe('');
    });

    test('solo, a player with no figure of their own falls back to the session', () => {
        // Solo the two are the same measurement — the model was built from this
        // player's bonuses — so the run's own takings answer for them
        game.party.players[0].percent = null;
        const text = draw('luck');

        expect(text).toContain('34.7%');
        expect(text).toContain('-6.3%');
    });

    test('an unflagged party falls back to the session figure rather than slot 0', () => {
        // No isCurrentPlayer flag anywhere - an old snapshot recorded on a party
        // run. Before the fix this read party.players[0] and would have shown
        // Slot0's own name and percent as if they were this character's.
        game.party = {
            battles: 900,
            players: [
                { name: 'Slot0', percent: 999 },
                { name: 'Slot1', percent: -50 },
            ],
            total: { percent: -5 },
        };
        const text = draw('luck');

        expect(text).not.toContain('Slot0');
        expect(text).not.toContain('999.0%');
        expect(text).toContain('Luck');
        expect(text).toContain('-6.3%');
    });

    test('a run owed nothing still shows where it sat', () => {
        // The percentile stands on its own: only the half that needs an
        // expectation to divide by goes missing
        combatDropLuck.lastResult.expected = 0;
        game.party.players[0].percent = null;
        const text = draw('luck');

        expect(text).toContain('34.7%');
        expect(text).toContain('—');
    });
});

describe('a party', () => {
    beforeEach(() => {
        // Two players, the same battles, different drop gear — so different
        // distributions and genuinely different percentiles
        combatDropLuck.lastResult.players = [
            { name: 'Millennium44', isCurrentPlayer: true, percentile: 0.12 },
            { name: 'Second', isCurrentPlayer: false, percentile: 0.88 },
        ];
        game.party = {
            battles: 900,
            players: [
                { name: 'Millennium44', isCurrentPlayer: true, percent: -20 },
                { name: 'Second', isCurrentPlayer: false, percent: 40 },
            ],
            total: { percent: -5 },
        };
    });

    test('a row each, with each player against their own gear on both halves', () => {
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).toContain('12.0%');
        expect(text).toContain('-20.0%');
        expect(text).toContain('Second');
        expect(text).toContain('88.0%');
        expect(text).toContain('+40.0%');
    });

    test('the total is the party against the party, not an average of the rows', () => {
        // An average weights somebody who looted one item the same as somebody
        // who looted a hundred, so the total comes from the party's own figures
        const text = draw('luck');

        expect(text).toContain('TOTAL');
        expect(text).toContain('-5.0%');
        expect(text).not.toContain('10.0%');
    });

    test('the session percentile belongs to the total, not to everybody', () => {
        // One number under two names says nothing that the single row did not:
        // how unusual the run was is a property of the run
        const text = draw('luck');

        expect(text.match(/34\.7%/g)).toHaveLength(1);
    });

    test('only you narrows it to your row, and drops the total with it', () => {
        game.options.luckOnlyPlayer = true;
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).not.toContain('Second');
        expect(text).not.toContain('TOTAL');
    });

    test('a player who cannot be placed reads as unmeasured', () => {
        combatDropLuck.lastResult.players[1].percentile = null;
        expect(draw('luck')).toContain('—');
    });
});

describe('a dungeon', () => {
    /** The chest reading a dungeon shows in place of a percentile it cannot compute */
    function chests() {
        combatDropLuck.dungeonChestLuck = () => ({
            partySize: 2,
            counted: 'tracker',
            restored: 0,
            entryKey: null,
            players: [
                {
                    name: 'Millennium44',
                    isCurrentPlayer: true,
                    byPayout: { 1: 8, 2: 2 },
                    mean: 1.2,
                    levelGap: null,
                    observed: 1.2,
                    chests: 12,
                    luck: {
                        chests: 12,
                        completions: 10,
                        expected: 10,
                        extras: 2,
                        expectedExtras: 2,
                        chance: 0.2,
                        percentile: 0.7,
                    },
                },
            ],
        });
    }

    test('both halves are the chests: where they sat, and how far off what was owed', () => {
        chests();
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).toContain('70.0%');
        // Twelve chests against ten owed
        expect(text).toContain('+20.0%');
    });

    test('the options narrow it the same way they narrow a zone', () => {
        chests();
        game.options.luckOnlyNumbers = true;

        expect(draw('luck')).not.toContain('Millennium44');
    });
});

describe('the only-numbers options', () => {
    test('the names go and both figures stay', () => {
        // On a tile shrunk to sit beside five others, the name is the part you
        // already know
        game.options.luckOnlyNumbers = true;
        const text = draw('luck');

        expect(text).not.toContain('Millennium44');
        expect(text).toContain('34.7%');
        expect(text).toContain('-6.3%');
    });

    test("the merged tile obeys the Expected half's switches too", () => {
        // They were set against a tile that no longer exists; honouring them
        // here is what keeps that setting from silently doing nothing
        game.options.expectedOnlyNumbers = true;
        expect(draw('luck')).not.toContain('Millennium44');
    });

    test('only you, set on the Expected half, narrows the merged tile', () => {
        combatDropLuck.lastResult.players = [
            { name: 'Millennium44', isCurrentPlayer: true, percentile: 0.12 },
            { name: 'Second', isCurrentPlayer: false, percentile: 0.88 },
        ];
        game.party.players.push({ name: 'Second', isCurrentPlayer: false, percent: 40 });
        game.options.expectedOnlyPlayer = true;
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).not.toContain('Second');
        expect(text).not.toContain('TOTAL');
    });

    test('both together leave the figures alone', () => {
        game.options.luckOnlyPlayer = true;
        game.options.luckOnlyNumbers = true;
        const text = draw('luck');

        expect(text).toBe('34.7%-6.3%');
    });

    test('with the options off nothing changes', () => {
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).toContain('34.7%');
    });
});
