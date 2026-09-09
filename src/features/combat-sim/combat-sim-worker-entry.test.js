/**
 * What the worker entry hands the engine.
 *
 * The module installs a global `onmessage` and answers with `postMessage`, so
 * with both stubbed it is an ordinary function. What is worth pinning here is
 * the labyrinth wiring: `fullAbilities` defaults ON inside Labyrinth (`!== false`),
 * and the entry coercing it with `=== true` turned an absent field into the
 * stripped tier-0 monster — the opposite of the documented default, and a
 * monster missing its stun/shred kit reads as an easier clear than it is.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({ labyrinthArgs: [], posted: [], gameDataSet: [] }));

vi.mock('./engine/labyrinth.js', () => ({
    default: class {
        constructor(...args) {
            harness.labyrinthArgs.push(args);
            this.buffs = [];
            this.zoneFight = args[5]?.zoneFight === true;
            this.fullAbilities = args[4] !== false;
        }
    },
}));

vi.mock('./engine/zone.js', () => ({
    default: class {
        constructor(hrid) {
            this.hrid = hrid;
            this.buffs = [];
            this.isDungeon = false;
        }
    },
}));

vi.mock('./engine/player.js', () => ({
    default: { createFromDTO: (dto) => ({ ...dto }) },
}));

vi.mock('./engine/combat-simulator.js', () => ({
    default: class {
        simulate() {
            return { encounters: 0 };
        }
    },
    setPlayerDetailsCapture: () => {},
    getCapturedPlayerDetails: () => null,
}));

vi.mock('./engine/game-data.js', () => ({ setGameData: (data) => harness.gameDataSet.push(data) }));
vi.mock('./engine/rng.js', () => ({ seedSimRng: () => {} }));
vi.mock('./engine/extra-buffs.js', () => ({ buildPlayerExtraBuffs: () => [] }));
vi.mock('./engine/combat-unit.js', () => ({ setBuffCapture: () => {}, getCapturedMonsterBuffs: () => ({}) }));

/** The message shape the runner posts, with the labyrinth block under test. */
function startMessage(labyrinth) {
    return {
        data: {
            type: 'start_simulation',
            taskId: 1,
            gameData: {},
            playerDTOs: [{ hrid: 'player1', food: [null], drinks: [null] }],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            simulationTimeLimit: 1,
            extraBuffs: [],
            labyrinth,
        },
    };
}

beforeEach(async () => {
    harness.labyrinthArgs = [];
    harness.posted = [];
    harness.gameDataSet = [];
    vi.stubGlobal('postMessage', (message) => harness.posted.push(message));
    vi.stubGlobal('onmessage', null);
    vi.resetModules();
    await import('./combat-sim-worker-entry.js');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The fullAbilities argument the entry passed to Labyrinth. */
function fullAbilitiesArg() {
    return harness.labyrinthArgs[0][4];
}

describe('the labyrinth monster the worker builds', () => {
    test('a caller who says nothing gets the full ability kit', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100 }));

        expect(harness.posted[0].type).toBe('result');
        // Passed through raw, so Labyrinth's own `!== false` default applies
        expect(fullAbilitiesArg()).not.toBe(false);
        expect(fullAbilitiesArg() !== false).toBe(true);
    });

    test('an explicit true is still true', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100, fullAbilities: true }));

        expect(fullAbilitiesArg()).toBe(true);
    });

    test('and only an explicit false opts into the stripped tier-0 monster', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100, fullAbilities: false }));

        expect(fullAbilitiesArg()).toBe(false);
    });
});

/**
 * What a worker that is used twice does about the game data.
 *
 * The runner keeps a finished worker warm and sends the next chunk without the
 * game data when that worker was already given the same maps — the payload is
 * the largest thing in the message and structuredClone copies all of it across
 * on every post. That only works if the entry leaves the engine singleton alone
 * when the field is absent; calling `setGameData(undefined)` would blank it and
 * the second run would fail on the first map it read.
 */
describe('game data across two messages to the same worker', () => {
    /** A minimal run, with the game data included or left out. */
    const message = (gameData) => ({
        data: {
            type: 'start_simulation',
            taskId: 1,
            ...(gameData ? { gameData } : {}),
            playerDTOs: [],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            simulationTimeLimit: 1,
            extraBuffs: [],
        },
    });

    test('the first message installs it', () => {
        const maps = { itemDetailMap: {} };

        globalThis.onmessage(message(maps));

        expect(harness.gameDataSet).toEqual([maps]);
    });

    test('and a message without it leaves the engine holding what it had', () => {
        const maps = { itemDetailMap: {} };

        globalThis.onmessage(message(maps));
        globalThis.onmessage(message(null));

        // Not `[maps, undefined]` — that second call is what would blank it
        expect(harness.gameDataSet).toEqual([maps]);
        expect(harness.posted.filter((m) => m.type === 'result')).toHaveLength(2);
    });
});
