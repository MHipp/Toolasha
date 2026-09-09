/**
 * How a simulation decides to spend the machine.
 *
 * There are two ways to spend four workers on eight candidates: split each
 * candidate four ways and do them one at a time, or give each candidate one
 * worker and run four at once. The same hours get simulated either way, so it
 * reads like a wash — and it is not. Splitting pays the worker startup and the
 * game-data clone once per chunk instead of once per candidate, and it cannot
 * start the next candidate until its own slowest chunk lands. Measured on four
 * workers: 3.3× slower at a hundred hours a candidate, still 1.14× slower at
 * five seconds of work apiece, and never once faster.
 *
 * Splitting is right for a *lone* run, where there is no queue to keep full —
 * one 600-hour simulation is about twice as quick across four workers. So the
 * rule is: fan out a single run, queue a batch.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ maxThreads: 0, mobile: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatSim_maxThreads' ? settings.maxThreads : false),
    },
}));

vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => settings.mobile,
}));

const {
    plannedWorkerCount,
    runSimulation,
    runLabyrinthSimulation,
    cancelSimulation,
    cancelActiveSimulations,
    terminateIdleWorkers,
} = await import('./combat-sim-runner.js');

/** The bare shape mergeSimResults walks unconditionally */
const EMPTY_SIM_RESULT = { encounters: 0, deaths: {}, experienceGained: {}, consumablesUsed: {} };

/**
 * Stand in for the browser's Worker plumbing and collect what gets posted to it.
 * Every fake worker answers its message with an empty result, which is enough
 * for a run of any chunk count to resolve.
 */
function captureWorkerMessages() {
    const messages = [];
    vi.stubGlobal(
        'Blob',
        class {
            constructor() {}
        }
    );
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:sim', revokeObjectURL: () => {} });
    vi.stubGlobal(
        'Worker',
        class {
            postMessage(message) {
                messages.push(message);
                setTimeout(() =>
                    this.onmessage?.({
                        data: { type: 'result', taskId: message.taskId, simResult: { ...EMPTY_SIM_RESULT } },
                    })
                );
            }
            terminate() {}
        }
    );
    return messages;
}

beforeEach(() => {
    settings.maxThreads = 0;
    settings.mobile = false;
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    // Workers now outlive the run that built them, so one test's warm pool is
    // the next one's confusing worker count unless it is emptied here.
    cancelSimulation();
});

describe('how wide one simulation spreads itself', () => {
    test('a short run stays in one worker', () => {
        // Splitting an hour four ways spends more on starting workers than the
        // simulation itself costs
        expect(plannedWorkerCount(1)).toBe(1);
        expect(plannedWorkerCount(24)).toBe(1);
    });

    test('a long one spreads out', () => {
        expect(plannedWorkerCount(40)).toBe(2);
        expect(plannedWorkerCount(100)).toBe(4);
    });

    test('but never past the worker budget', () => {
        // Four by default, whatever the machine has — the tab running the game
        // needs cores too
        expect(plannedWorkerCount(10_000)).toBe(4);
    });

    test('which the thread setting can narrow', () => {
        settings.maxThreads = 2;

        expect(plannedWorkerCount(10_000)).toBe(2);
    });

    test('and cores cap the setting rather than the other way round', () => {
        settings.maxThreads = 32;
        vi.stubGlobal('navigator', { hardwareConcurrency: 3 });

        expect(plannedWorkerCount(10_000)).toBe(3);
    });

    test('mobile mode narrows the budget to two', () => {
        // A phone reporting 8 cores does not have 8 cores of thermal headroom,
        // and each worker holds its own clone of the game data
        settings.mobile = true;

        expect(plannedWorkerCount(10_000)).toBe(2);
    });
});

describe('whether the run counts as a task fight', () => {
    // taskDamage is a conditional stat — it pays only while the monster is your
    // combat task — so the engine needs telling, and the only way it can be told
    // is through the worker message. A caller that says nothing must get the
    // off-task answer, because most callers are generic zone sims and rankings.
    test('a caller who says nothing gets off task', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1 });

        expect(messages).toHaveLength(1);
        expect(messages[0].isTaskFight).toBe(false);
    });

    test('and a task-card sim carries the flag through to the worker', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1, isTaskFight: true });

        expect(messages[0].isTaskFight).toBe(true);
    });

    test('every chunk of a split run agrees about it', async () => {
        // A 100-hour run is four workers; three of them believing they are off
        // task would make the merged result a blend of two different fights
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 100, isTaskFight: true });

        expect(messages).toHaveLength(4);
        expect(messages.every((m) => m.isTaskFight === true)).toBe(true);
    });

    test('and labyrinth runs default off, since no labyrinth monster is a task', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({ zoneHrid: '/actions/combat/fly', monsterHrid: '/monsters/x', hours: 1 });

        expect(messages[0].isTaskFight).toBe(false);
    });
});

describe('whether the labyrinth monster gets its full ability kit', () => {
    // A tier-0 subset monster drops its stun/shred/self-buff kit and the sim
    // over-predicts clears — the calibration replay verified the full kit reads
    // closer to reality. Callers that say nothing must get the full kit: for
    // months the upgrade advisor and live replay silently simmed the stripped
    // monster while the tile badges simmed the real one.
    test('a caller who says nothing gets the full kit', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({ zoneHrid: '/actions/combat/fly', monsterHrid: '/monsters/x', hours: 1 });

        expect(messages).toHaveLength(1);
        expect(messages[0].labyrinth.fullAbilities).toBe(true);
    });

    test('an explicit true is still true', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/x',
            hours: 1,
            fullAbilities: true,
        });

        expect(messages[0].labyrinth.fullAbilities).toBe(true);
    });

    test('only an explicit false — a deliberate tier-0 diagnostic — opts out', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/x',
            hours: 1,
            fullAbilities: false,
        });

        expect(messages[0].labyrinth.fullAbilities).toBe(false);
    });
});

/**
 * How the requested hours are divided.
 *
 * Callers turn the merged result into rates by dividing by the hours they
 * asked for, so the chunks have to add up to exactly that. Rounding each chunk
 * up to a whole hour gave a half-hour request a full simulated hour and left
 * every rate derived from it overstated by a factor of two.
 */
describe('splitting the requested hours', () => {
    /** Hours each worker was actually told to simulate. */
    const chunkHours = (messages) => messages.map((m) => m.simulationTimeLimit / (3600 * 1e9));

    test('half an hour is half an hour', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 0.5 });

        expect(messages).toHaveLength(1);
        expect(chunkHours(messages)[0]).toBeCloseTo(0.5, 9);
    });

    test('and an hour and a half is an hour and a half', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1.5 });

        expect(chunkHours(messages).reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 9);
    });

    test('however many workers it is split across', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1.5 }, null, {
            workers: 2,
        });

        expect(messages).toHaveLength(2);
        expect(chunkHours(messages).reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 9);
    });

    test('a whole-hour run still divides evenly', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 100 });

        expect(messages).toHaveLength(4);
        expect(chunkHours(messages)).toEqual([25, 25, 25, 25]);
    });

    test('and no worker is started with nothing to do', async () => {
        // Four workers asked for, half an hour to share: three empty chunks
        // would each pay the worker startup and the game-data clone for nothing
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 0.5 }, null, {
            workers: 4,
        });

        expect(messages).toHaveLength(1);
        expect(chunkHours(messages)[0]).toBeCloseTo(0.5, 9);
    });
});

/**
 * Whether a simulation builds a Worker or borrows one.
 *
 * A worker costs the whole engine bundle parsed and instantiated, plus a
 * structured clone of the game data on the thread that draws the game. The
 * labyrinth live readout replays the fight in progress every four seconds and
 * was paying both, every time. These describe the pool that stops it: the
 * worker is kept, and the game data is left out of the message when the worker
 * it is going to already holds those maps.
 */

/** Two payloads sharing these maps are the same data to a warm worker. */
const ITEM_MAP = { '/items/cheese': {} };
const ACTION_MAP = { '/actions/combat/fly': {} };

/** A game-data payload in the shape `buildGameDataPayload` returns. */
const gameDataPayload = () => ({ itemDetailMap: ITEM_MAP, actionDetailMap: ACTION_MAP });

/**
 * Stand in for the browser's Worker plumbing, counting what gets built.
 * With `deferred`, a worker holds its answer until the test calls `respond`,
 * which is what lets a test look at work that is still in flight.
 */
function stubWorkerPool({ deferred = false, postFails = false } = {}) {
    const built = [];
    const messages = [];
    vi.stubGlobal(
        'Blob',
        class {
            constructor() {}
        }
    );
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:sim', revokeObjectURL: () => {} });
    vi.stubGlobal(
        'Worker',
        class {
            constructor() {
                this.terminated = false;
                this.terminateCount = 0;
                built.push(this);
            }
            postMessage(message) {
                if (postFails) throw new DOMExceptionStub('could not be cloned');
                messages.push(message);
                this.respond = (simResult) =>
                    this.onmessage?.({
                        data: {
                            type: 'result',
                            taskId: message.taskId,
                            simResult: simResult || { ...EMPTY_SIM_RESULT },
                        },
                    });
                if (!deferred) setTimeout(() => this.respond());
            }
            terminate() {
                this.terminated = true;
                this.terminateCount++;
            }
        }
    );
    return { built, messages };
}

/** Stands in for the DOMException `postMessage` throws on an uncloneable payload. */
class DOMExceptionStub extends Error {}

/** One live replay, the shape `labyrinth-clear-rate` sends every four seconds. */
const replay = (gameData) =>
    runLabyrinthSimulation({
        gameData,
        playerDTOs: [],
        zoneHrid: '/actions/combat/fly',
        monsterHrid: '/monsters/gobo_stabby',
        roomLevel: 30,
        crates: [],
        hours: 1,
        communityBuffs: {},
    });

describe('keeping a simulation worker warm', () => {
    test("a second replay borrows the first replay's worker", async () => {
        const { built } = stubWorkerPool();

        await replay(gameDataPayload());
        await replay(gameDataPayload());
        await replay(gameDataPayload());

        expect(built).toHaveLength(1);
    });

    test('and is sent no game data, because that worker already holds it', async () => {
        const { messages } = stubWorkerPool();

        await replay(gameDataPayload());
        await replay(gameDataPayload());

        // The maps are what makes the message expensive to clone; everything
        // that describes *this* fight is still there
        expect(messages[0].gameData).toEqual(gameDataPayload());
        expect(messages[1].gameData).toBeUndefined();
        expect(messages[1].labyrinth.roomLevel).toBe(30);
    });

    test('game data that has actually changed gets a worker of its own', async () => {
        // A reload replaces init_client_data wholesale, so every map in the
        // payload is a different object - which is the invalidation signal
        const { built, messages } = stubWorkerPool();

        await replay(gameDataPayload());
        await replay({ itemDetailMap: { '/items/cheese': {} }, actionDetailMap: { '/actions/combat/fly': {} } });

        expect(built).toHaveLength(2);
        expect(messages[1].gameData).toBeDefined();
    });

    test('a run split across four workers still gets four, each with the data', async () => {
        const { built, messages } = stubWorkerPool();

        const merged = await runSimulation({
            gameData: gameDataPayload(),
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            hours: 100,
        });

        expect(built).toHaveLength(4);
        // Chunks are acquired before any of them finishes, so none can borrow
        // another's worker - and none may go without the game data
        expect(messages.map((m) => Boolean(m.gameData))).toEqual([true, true, true, true]);
        expect(messages.map((m) => m.simulationTimeLimit / (3600 * 1e9))).toEqual([25, 25, 25, 25]);
        expect(merged.encounters).toBe(0);
    });

    test('and the next run borrows one of the four back', async () => {
        const { built } = stubWorkerPool();

        await runSimulation({
            gameData: gameDataPayload(),
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            hours: 100,
        });
        await replay(gameDataPayload());

        expect(built).toHaveLength(4);
    });

    test('the numbers a replay produces do not change', async () => {
        // The worker is reused; what it answers is passed through untouched,
        // warm or cold
        const { built } = stubWorkerPool({ deferred: true });
        const answer = { ...EMPTY_SIM_RESULT, encounters: 7, labyAttemptCount: 9 };

        const cold = replay(gameDataPayload());
        built[0].respond(answer);
        expect(await cold).toEqual(answer);

        const warm = replay(gameDataPayload());
        built[0].respond(answer);
        expect(await warm).toEqual(answer);
        expect(built).toHaveLength(1);
    });
});

describe('stopping and tearing down a warm pool', () => {
    test('cancelling still rejects the work in flight', async () => {
        const { built } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        cancelSimulation();

        await expect(inFlight).rejects.toThrow('Cancelled');
        expect(built[0].terminated).toBe(true);
    });

    test('and takes the idle workers with it', async () => {
        // Otherwise a Stop, a character switch or a feature teardown leaves a
        // thread holding a copy of the game data for the rest of the session
        const { built } = stubWorkerPool();

        await replay(gameDataPayload());
        expect(built[0].terminated).toBe(false);

        cancelSimulation();

        expect(built[0].terminated).toBe(true);
        await replay(gameDataPayload());
        expect(built).toHaveLength(2);
    });

    test('the idle sweep the reaper calls empties the pool', async () => {
        const { built } = stubWorkerPool();

        await replay(gameDataPayload());
        terminateIdleWorkers();

        expect(built[0].terminated).toBe(true);
    });
});

describe('stopping the work without throwing away the warm workers', () => {
    /** One ordinary Simulate press: short enough to be a single chunk. */
    const simulate = () =>
        runSimulation({
            gameData: gameDataPayload(),
            playerDTOs: [],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            hours: 1,
            communityBuffs: {},
        });

    test('pressing Simulate again borrows the warm worker instead of starting cold', async () => {
        // The case a user hits most. `preempt` used to drain the idle pool, so
        // every repeated press paid the worker startup and the game-data clone
        const { built, messages } = stubWorkerPool();

        await simulate();
        await simulate();

        expect(built).toHaveLength(1);
        expect(messages[1].gameData).toBeUndefined();
    });

    test('cancelling only the active runs leaves the warm workers alone', async () => {
        const { built } = stubWorkerPool();

        await replay(gameDataPayload());
        cancelActiveSimulations();

        expect(built[0].terminated).toBe(false);
        await replay(gameDataPayload());
        expect(built).toHaveLength(1);
    });

    test('and still rejects the chunk that was running', async () => {
        const { built } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        cancelActiveSimulations();

        await expect(inFlight).rejects.toThrow('Cancelled');
        expect(built[0].terminated).toBe(true);
    });

    test('a feature teardown or character switch still takes everything', async () => {
        // `cancelSimulation` is the name every caller that has not thought about
        // the distinction reaches for, so it has to stay the safe one
        const { built } = stubWorkerPool({ deferred: true });

        const warm = replay(gameDataPayload());
        built[0].respond();
        await warm;
        const inFlight = replay(gameDataPayload());

        cancelSimulation();

        await expect(inFlight).rejects.toThrow('Cancelled');
        expect(built.every((w) => w.terminated)).toBe(true);
        // Nothing warm survived to hold the departing character's game data:
        // the next replay has to build its own
        const next = replay(gameDataPayload());
        expect(built).toHaveLength(2);
        built[1].respond();
        await next;
    });

    test('a run spread wider than the idle cap still completes', async () => {
        // Six chunks against a pool that keeps four: the two that cannot be kept
        // warm are terminated on release, and the run still merges cleanly
        settings.maxThreads = 6;
        const { built } = stubWorkerPool();

        const merged = await runSimulation({
            gameData: gameDataPayload(),
            playerDTOs: [],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            hours: 600,
            communityBuffs: {},
        });

        expect(built).toHaveLength(6);
        expect(merged.encounters).toBe(0);
        expect(built.filter((w) => w.terminated)).toHaveLength(2);
    });
});

/**
 * A worker that stops answering, and the pool it would otherwise freeze.
 *
 * The chunk promise settles only from a message or an `error` event. A worker
 * the browser kills for memory fires neither, so the promise used to hang for
 * the life of the page — and worse than one lost result, its wrapper stayed in
 * `activeWorkers`, which is exactly what the idle reaper is busy-guarded on. One
 * dead worker and every warm worker plus its clone of the game data was held for
 * the rest of the session.
 */
describe('a simulation worker that goes quiet', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('is given up on rather than awaited for ever', async () => {
        const { built } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        vi.advanceTimersByTime(120_000);

        await expect(inFlight).rejects.toThrow('No word from the simulation worker');
        expect(built[0].terminated).toBe(true);
    });

    test('and leaves nothing behind in the active list', async () => {
        // The list the reaper reads. A wrapper stranded here is a pool that
        // never reaps again — invisible except that the worker gets terminated
        // a second time when something does walk the list.
        const { built } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        vi.advanceTimersByTime(120_000);
        await expect(inFlight).rejects.toThrow('No word');

        cancelActiveSimulations();

        expect(built[0].terminateCount).toBe(1);
    });

    test('but a run still talking is never cut short', async () => {
        // The window is silence, not elapsed time: a progress tick re-arms it,
        // so a legitimately long simulation runs as long as it needs to
        const { built, messages } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        const { taskId } = messages[0];
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(119_000);
            built[0].onmessage({ data: { type: 'progress', taskId, progress: i * 20 } });
        }
        vi.advanceTimersByTime(119_000);
        built[0].respond();

        await expect(inFlight).resolves.toEqual(EMPTY_SIM_RESULT);
        expect(built[0].terminated).toBe(false);
    });

    test('and a cancel takes the deadline with the worker', async () => {
        // Otherwise the timer fires two minutes later against a wrapper that
        // was dropped, terminating a worker nothing owns any more
        const { built } = stubWorkerPool({ deferred: true });

        const inFlight = replay(gameDataPayload());
        cancelActiveSimulations();
        await expect(inFlight).rejects.toThrow('Cancelled');

        vi.advanceTimersByTime(120_000);

        expect(built[0].terminateCount).toBe(1);
    });
});

describe('a payload the browser refuses to clone', () => {
    test('rejects the caller instead of stranding the wrapper', async () => {
        // `postMessage` throws synchronously on an uncloneable value. It used to
        // throw straight out of the Promise executor, leaving the wrapper in
        // `activeWorkers` for good and the reaper permanently busy.
        const { built } = stubWorkerPool({ postFails: true });

        await expect(replay(gameDataPayload())).rejects.toThrow('could not be cloned');
        expect(built[0].terminated).toBe(true);

        cancelActiveSimulations();
        expect(built[0].terminateCount).toBe(1);
    });
});
