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

const harness = vi.hoisted(() => ({
    labyrinthArgs: [],
    posted: [],
    gameDataSet: [],
    captureCalls: [],
    simulateThrows: false,
}));

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
            if (harness.simulateThrows) throw new Error('a monster the engine could not build');
            return { encounters: 0 };
        }
    },
    setPlayerDetailsCapture: (on) => harness.captureCalls.push(['player', on]),
    getCapturedPlayerDetails: () => null,
}));

vi.mock('./engine/game-data.js', () => ({ setGameData: (data) => harness.gameDataSet.push(data) }));
vi.mock('./engine/rng.js', () => ({ seedSimRng: () => {} }));
vi.mock('./engine/extra-buffs.js', () => ({ buildPlayerExtraBuffs: () => [] }));
vi.mock('./engine/combat-unit.js', () => ({
    setBuffCapture: (on) => harness.captureCalls.push(['buffs', on]),
    getCapturedMonsterBuffs: () => ({}),
}));

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
    harness.captureCalls = [];
    harness.simulateThrows = false;
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

/**
 * Capture flags are the only engine globals not reset by a fresh message.
 *
 * `setGameData` is re-sent (or deliberately withheld), `seedSimRng` runs on every
 * message and clears back to Math.random() when unseeded, and `resetSimWarnings`
 * runs at the top of `simulate`. The two capture sinks — monster buffs in
 * `combat-unit.js`, the player build snapshot in `combat-simulator.js` — were the
 * exception: turned on before the run and off after it, so a run that threw left
 * them on. The runner treats a caught worker error as healthy and puts that
 * worker straight back in the idle pool, so the next simulation to borrow it
 * inherited a capture that nobody asked for: a buff sink that grows for the rest
 * of the session and a build snapshot taken on every later run.
 */
describe('capture state left behind by a run that threw', () => {
    /** A probe message with capture turned on, the shape runBlindBuffProbe posts. */
    const probeMessage = (extra) => ({
        data: {
            type: 'start_simulation',
            taskId: 1,
            gameData: { itemDetailMap: {} },
            playerDTOs: [],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            simulationTimeLimit: 1,
            extraBuffs: [],
            ...extra,
        },
    });

    test('a probe that finishes turns its capture back off', () => {
        globalThis.onmessage(probeMessage({ captureBuffs: true, capturePlayerDetails: true }));

        // Read back before the flags come off, exactly as before — the result
        // a probe gets is unchanged by moving the reset into a `finally`
        expect(harness.posted[0].type).toBe('result');
        expect(harness.posted[0].simResult.producedMonsterBuffs).toBeDefined();
        expect('playerCombatDetails' in harness.posted[0].simResult).toBe(true);
        expect(harness.captureCalls).toEqual([
            ['buffs', true],
            ['player', true],
            ['buffs', false],
            ['player', false],
        ]);
    });

    test('and so does one that throws mid-run', () => {
        harness.simulateThrows = true;

        globalThis.onmessage(probeMessage({ captureBuffs: true, capturePlayerDetails: true }));

        // The worker still answers, and is still pooled — so it must not be
        // holding a capture the next borrower never asked for
        expect(harness.posted[0].type).toBe('error');
        expect(harness.captureCalls.filter(([, on]) => on === false)).toEqual([
            ['buffs', false],
            ['player', false],
        ]);
    });

    test('a run that never asked for capture touches neither flag', () => {
        // Turning them off unconditionally would reset a sink a concurrent
        // probe... there is only one run per worker, but the cheaper truth is
        // that an ordinary run should not be writing engine globals at all
        globalThis.onmessage(probeMessage({}));

        expect(harness.captureCalls).toEqual([]);
    });
});
