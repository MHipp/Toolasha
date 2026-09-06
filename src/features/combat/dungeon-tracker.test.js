/**
 * @vitest-environment happy-dom
 *
 * The dungeon tracker's run lifecycle.
 *
 * A run is assembled from two independent streams: the websocket
 * (`new_battle` → `action_completed`), which knows about waves, and party chat
 * ("Key counts:"), which carries the server's own timestamps and is therefore
 * the authoritative duration. Almost every interesting behaviour here is about
 * what happens when those two disagree — a refresh mid-dungeon, a completion
 * seen by one stream and not the other, a character switch between them.
 *
 * The game is mocked, not the tracker: websocket handlers are captured so
 * messages can be fed in the order the server would send them, and storage is
 * an in-memory map so the persistence guards (battleId, staleness, recent
 * completion, per-character scoping) can be exercised for real through
 * character-key.js rather than stubbed away.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'market123',
    characterName: 'Marketcow',
    gameMode: 'standard',
    actions: [],
    actionDetails: {},
    dungeonInfo: {},
    wsHandlers: {},
    dmHandlers: {},
    savedRuns: [],
    historyRuns: [],
}));

const mockStorage = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset: () => stores.clear(),
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            storeFor(storeName).set(key, value);
            return true;
        }),
        delete: vi.fn(async (key, storeName = 'settings') => {
            storeFor(storeName).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (storeName = 'settings') => Array.from(storeFor(storeName).keys())),
    };
});

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterName: () => game.characterName,
        getCurrentCharacterGameMode: () => game.gameMode,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));

vi.mock('../../core/storage.js', () => ({ default: mockStorage }));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getDungeonInfo: (hrid) => game.dungeonInfo[hrid] ?? null,
        getTeamKey: (names) => [...names].sort().join(','),
        getRunsForCharacter: async () => game.historyRuns,
        saveTeamRun: vi.fn(async (teamKey, run) => {
            game.savedRuns.push({ teamKey, run });
            return true;
        }),
    },
}));

const tracker = (await import('./dungeon-tracker.js')).default;
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const DEN = '/actions/combat/chimerical_den';
const LAIR = '/actions/combat/sinister_circus';
const FLY = '/actions/combat/fly';
const IN_PROGRESS = 'dungeonTracker_inProgressRun';

/** Storage settles in microtasks; the tracker fires several saves without awaiting them. */
async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function stored(charId = game.characterId) {
    return mockStorage.storeFor('settings').get(`${IN_PROGRESS}_${charId}`);
}

function keyCountsData(isoTime, keyCountString) {
    return {
        message: {
            chan: '/chat_channel_types/party',
            isSystemMessage: true,
            m: 'systemChatMessage.partyKeyCount',
            t: isoTime,
            systemMetadata: JSON.stringify({ keyCountString }),
        },
    };
}

/** Put the tracker into the middle of a run without replaying every message. */
function beTracking({
    dungeonHrid = DEN,
    tier = 0,
    startTime = Date.parse('2026-08-04T10:00:00.000Z'),
    currentWave = 3,
    maxWaves = 10,
    wavesCompleted = 2,
    battleId = 42,
    waveTimes = [],
    keyCountsMap = {},
    anchoredAt = null,
    restored = false,
    joinedMidRun = false,
    joinedAtWave = null,
} = {}) {
    tracker.isTracking = true;
    // A run picked back up from storage never saw its own start message; one started
    // here has it still to come, and the two read an unanchored key count differently.
    tracker.restoredMidRun = restored;
    tracker.currentBattleId = battleId;
    tracker.waveStartTime = new Date(startTime);
    // The previous wave's end is the anchor a mid-run completion is timed
    // from; seed it to the same instant so a test can measure a wave off it.
    tracker.lastWaveEndTime = startTime;
    tracker.waveTimes = waveTimes;
    tracker.joinedMidRun = joinedMidRun;
    tracker.currentRun = {
        dungeonHrid,
        tier,
        startTime,
        currentWave,
        maxWaves,
        wavesCompleted,
        keyCountsMap,
        joinedMidRun,
        joinedAtWave: joinedMidRun ? (joinedAtWave ?? currentWave) : null,
    };
    if (anchoredAt !== null) {
        // What the post-start chat scan leaves behind: the run's own start
        // message, seen and recorded, so the next one is the completion.
        const anchor = Date.parse(anchoredAt);
        tracker.firstKeyCountTimestamp = anchor;
        tracker.lastKeyCountTimestamp = anchor;
        tracker.keyCountMessages = [{ timestamp: anchor, keyCountsMap, text: 'Key counts (start)' }];
    }
}

function resetTracker() {
    tracker.isTracking = false;
    tracker.isInitialized = false;
    tracker.currentRun = null;
    tracker.waveStartTime = null;
    tracker.lastWaveEndTime = null;
    tracker.waveTimes = [];
    tracker.updateCallbacks = [];
    tracker.pendingDungeonInfo = null;
    tracker.currentBattleId = null;
    tracker.firstKeyCountTimestamp = null;
    tracker.lastKeyCountTimestamp = null;
    tracker.keyCountMessages = [];
    tracker.pendingNextRunFirstKeyCount = null;
    tracker.battleStartedTimestamp = null;
    tracker.restoredMidRun = false;
    tracker.joinedMidRun = false;
    tracker.characterId = null;
    tracker.recentChatMessages = [];
    tracker._lastCompletionTime = 0;
    tracker.hibernationDetected = false;
    tracker.timerRegistry.clearAll();
    if (tracker.visibilityHandler) {
        document.removeEventListener('visibilitychange', tracker.visibilityHandler);
        tracker.visibilityHandler = null;
    }
}

beforeEach(() => {
    mockStorage.reset();
    _resetAdoptionCache();
    game.characterId = 'market123';
    game.characterName = 'Marketcow';
    game.gameMode = 'standard';
    game.actions = [];
    game.actionDetails = {
        [DEN]: { name: 'Chimerical Den', combatZoneInfo: { isDungeon: true } },
        [LAIR]: { name: 'Sinister Circus', combatZoneInfo: { isDungeon: true } },
        [FLY]: { name: 'Fly', combatZoneInfo: { isDungeon: false } },
        '/actions/cheesesmithing/cheese_gauntlets': { name: 'Cheese Gauntlets' },
    };
    game.dungeonInfo = {
        [DEN]: { name: 'Chimerical Den', maxWaves: 10 },
        [LAIR]: { name: 'Sinister Circus', maxWaves: 12 },
    };
    game.wsHandlers = {};
    game.dmHandlers = {};
    game.savedRuns = [];
    game.historyRuns = [];
    resetTracker();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('recognising a dungeon', () => {
    test('a combat action flagged isDungeon is one', () => {
        expect(tracker.isDungeonAction(DEN)).toBe(true);
    });

    test('an ordinary combat zone is not', () => {
        expect(tracker.isDungeonAction(FLY)).toBe(false);
    });

    test('a skilling action is not, without ever asking for its details', () => {
        expect(tracker.isDungeonAction('/actions/cheesesmithing/cheese_gauntlets')).toBe(false);
    });

    test('nothing at all is not', () => {
        expect(tracker.isDungeonAction(null)).toBe(false);
        expect(tracker.isDungeonAction(undefined)).toBe(false);
        expect(tracker.isDungeonAction('')).toBe(false);
    });

    test('an unknown combat action is not', () => {
        expect(tracker.isDungeonAction('/actions/combat/nothing_here')).toBe(false);
    });
});

describe('starting a run', () => {
    test('wave 1 starts a run from the running dungeon action', async () => {
        // The run starts now, not at combatStartTime — that field is the combat
        // action's start, hours stale in continuous queued combat.
        const runStart = Date.parse('2026-08-04T10:03:20.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(runStart);
        // dataManager folds endCharacterActions into its queue before emitting,
        // so the tracker sees the post-update queue.
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, ordinal: 0, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 2 });

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentBattleId).toBe(42);
        expect(tracker.currentRun).toMatchObject({
            dungeonHrid: DEN,
            tier: 2,
            startTime: runStart,
            currentWave: 1,
            maxWaves: 10,
            wavesCompleted: 0,
            hibernationDetected: false,
        });
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('with no pending info it falls back to the active action list', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 7, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.tier).toBe(1);
        expect(tracker.currentRun.maxWaves).toBe(10);
    });

    test('the running action’s tier wins over a stale pending tier from a queued copy', async () => {
        // The queue that showed a T2 fight as T0: the running dungeon (ordinal
        // 0, T2) sits alongside a queued T0 copy, and pendingDungeonInfo had
        // grabbed the T0 one.
        tracker.pendingDungeonInfo = { dungeonHrid: DEN, tier: 0 };
        game.actions = [
            { actionHrid: DEN, difficultyTier: 2, ordinal: 0, isDone: false },
            { actionHrid: DEN, difficultyTier: 0, ordinal: 8589934587, isDone: false },
        ];

        await tracker.onNewBattle({ wave: 1, battleId: 5, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.tier).toBe(2);
    });

    test('a mid-run wave re-syncs a tier that started wrong', async () => {
        // Already tracking at the wrong tier (T0); the running action says T2,
        // and a tier cannot change mid-run, so the run self-corrects.
        beTracking({ tier: 0, currentWave: 3, wavesCompleted: 2 });
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, ordinal: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 4, battleId: 9, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.tier).toBe(2);
    });

    test('a non-dungeon pending action never starts tracking', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tracker.pendingDungeonInfo = { dungeonHrid: FLY, tier: 0 };

        await tracker.onNewBattle({ wave: 1, battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(tracker.pendingDungeonInfo).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    test('no dungeon anywhere means no run', async () => {
        game.actions = [{ actionHrid: FLY, isDone: false }];
        await tracker.onNewBattle({ wave: 1, battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();
        expect(tracker.isTracking).toBe(false);
    });

    test('a message without a wave field is not a dungeon battle', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        await tracker.onNewBattle({ battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        expect(tracker.isTracking).toBe(false);
    });

    test('a later wave while already tracking only moves the wave along', async () => {
        // combatStartTime is the run's start, constant across waves, so the new
        // wave is clocked from now (its own start), not from that field.
        const clockNow = Date.parse('2026-08-04T10:07:30.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(clockNow);
        beTracking({ currentWave: 3, battleId: 42 });

        await tracker.onNewBattle({ wave: 4, battleId: 99, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.currentRun.currentWave).toBe(4);
        // The battleId is refreshed so a re-login mid-dungeon still persists
        expect(tracker.currentBattleId).toBe(99);
        expect(tracker.waveStartTime.getTime()).toBe(clockNow);
        vi.useRealTimers();
    });

    test('a resent wave 1 while still on wave 1 only refreshes the battle, not the run', async () => {
        // `new_battle` has no reconnect dedupe (see websocket.js), so a drop and
        // reconnect that catches the run still on its own first wave resends
        // this same wave 1 rather than a real dungeon start. Restarting the run
        // here used to wipe wavesCompleted, waveTimes and the party-message
        // timestamps the run had already collected, and moved its recorded
        // start time to whenever the reconnect happened.
        beTracking({
            currentWave: 1,
            wavesCompleted: 0,
            battleId: 42,
            waveTimes: [1000],
            anchoredAt: '2026-08-04T10:00:05.000Z',
        });
        const keptStartTime = tracker.currentRun.startTime;

        await tracker.onNewBattle({ wave: 1, battleId: 99, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.startTime).toBe(keptStartTime);
        expect(tracker.currentRun.currentWave).toBe(1);
        expect(tracker.waveTimes).toEqual([1000]);
        expect(tracker.firstKeyCountTimestamp).toBe(Date.parse('2026-08-04T10:00:05.000Z'));
        // The battleId still refreshes, same as any other reconnect mid-run
        expect(tracker.currentBattleId).toBe(99);
    });

    test('but a genuinely new dungeon queued while wave 1 is still open starts fresh', async () => {
        // The one case a resent wave 1 must NOT be swallowed: actions_updated
        // queued a real new dungeon action before this new_battle arrived
        const freshStart = Date.parse('2026-08-04T11:02:45.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(freshStart);
        beTracking({ currentWave: 1, wavesCompleted: 0, battleId: 42 });
        game.actions = [{ actionHrid: LAIR, difficultyTier: 1, ordinal: 0, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 1, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 100, combatStartTime: '2026-08-04T11:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(LAIR);
        // Clocked from now, not the stale combatStartTime
        expect(tracker.currentRun.startTime).toBe(freshStart);
    });
});

describe('a dungeon that is only queued', () => {
    // Observed live: a character fighting Golem Cave (a normal zone) with Sinister
    // Circus sitting at queue position 2, not started, made the tracker panel appear
    // and start counting — "Sinister Circus (T0), Elapsed 00:37, Wave 0/60" — with
    // the timer running against Golem Cave's battles. The queue is insertion order,
    // so "the first unfinished dungeon in the array" is not "the dungeon running".

    test('queueing a dungeon behind a running normal zone does not arm the tracker', () => {
        game.actions = [
            { actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 2, ordinal: 2, isDone: false },
        ];

        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 2, isDone: false }] });

        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a battle from the running normal zone does not start the queued dungeon', async () => {
        game.actions = [
            { actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 2, ordinal: 2, isDone: false },
        ];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 2, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 77, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
    });

    test('even a pending record left over from before cannot start a run off a normal zone', async () => {
        // Belt and braces: whatever armed it, the running action has the last word.
        tracker.pendingDungeonInfo = { dungeonHrid: LAIR, tier: 2 };
        game.actions = [{ actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 78, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a dungeon queued behind a different running dungeon does not start the wrong one', async () => {
        game.actions = [
            { actionHrid: DEN, difficultyTier: 3, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 0, ordinal: 2, isDone: false },
        ];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 0, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 79, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.tier).toBe(3);
        expect(tracker.currentRun.maxWaves).toBe(10);
    });

    test('a requeued repeat at array position 0 does not displace the running action', async () => {
        // A repeating action that has run many times is requeued to the *front* of
        // the array with a *higher* ordinal, so actions[0] is the queued copy.
        game.actions = [
            { actionHrid: LAIR, difficultyTier: 0, ordinal: 8589934587, isDone: false },
            { actionHrid: DEN, difficultyTier: 2, ordinal: 4, isDone: false },
        ];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });

        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 2 });

        await tracker.onNewBattle({ wave: 1, battleId: 80, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.tier).toBe(2);
    });

    test('the running dungeon still starts normally from behind other queued actions', async () => {
        game.actions = [
            { actionHrid: DEN, difficultyTier: 5, ordinal: 2, isDone: false },
            { actionHrid: FLY, difficultyTier: 0, ordinal: 9, isDone: false },
        ];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 5, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 81, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.tier).toBe(5);
    });

    test('a queued dungeon leaving the queue does not end the run in progress', () => {
        beTracking({ dungeonHrid: DEN, currentWave: 4, wavesCompleted: 3 });
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, ordinal: 1, isDone: false }];

        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 0, isDone: true }] });

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.wavesCompleted).toBe(3);
    });

    test('page load does not adopt a dungeon that is only queued', async () => {
        game.actions = [
            { actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 2, ordinal: 2, isDone: false },
        ];

        await tracker.checkForActiveDungeon();
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a saved record is not restored onto a dungeon that is only queued', async () => {
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_${game.characterId}`, {
            dungeonHrid: LAIR,
            tier: 2,
            battleId: 55,
            startTime: Date.now() - 60_000,
            currentWave: 4,
            maxWaves: 12,
            wavesCompleted: 3,
            waveTimes: [],
        });
        game.actions = [
            { actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 2, ordinal: 2, isDone: false },
        ];

        const restored = await tracker.restoreInProgressRun(55);
        await flush();

        expect(restored).toBe(false);
        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
    });
});

describe('the in-progress record', () => {
    test('a run in flight is written under this character', async () => {
        beTracking({ waveTimes: [3000, 5000], keyCountsMap: { Alice: 12 } });
        tracker.firstKeyCountTimestamp = 1000;
        tracker.lastKeyCountTimestamp = 1000;

        expect(await tracker.saveInProgressRun()).toBe(true);
        expect(stored()).toMatchObject({
            battleId: 42,
            dungeonHrid: DEN,
            currentWave: 3,
            maxWaves: 10,
            wavesCompleted: 2,
            waveTimes: [3000, 5000],
            keyCountsMap: { Alice: 12 },
            firstKeyCountTimestamp: 1000,
        });
    });

    test('the saved wave times are a copy, not the live array', async () => {
        beTracking({ waveTimes: [3000] });
        await tracker.saveInProgressRun();
        tracker.waveTimes.push(9999);
        expect(stored().waveTimes).toEqual([3000]);
    });

    test('nothing is written when there is no run, or no battle to tie it to', async () => {
        expect(await tracker.saveInProgressRun()).toBe(false);

        beTracking({ battleId: null });
        tracker.currentBattleId = null;
        expect(await tracker.saveInProgressRun()).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a matching battle restores the run', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 1,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000, 5000],
            waveStartTime: 7000,
            keyCountsMap: { Alice: 12, Bob: 8 },
            lastUpdateTime: Date.now(),
            firstKeyCountTimestamp: 500,
            lastKeyCountTimestamp: 500,
            hibernationDetected: true,
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun).toMatchObject({ dungeonHrid: DEN, currentWave: 5, wavesCompleted: 4 });
        expect(tracker.waveTimes).toEqual([3000, 5000]);
        expect(tracker.waveStartTime.getTime()).toBe(7000);
        expect(tracker.firstKeyCountTimestamp).toBe(500);
        expect(tracker.hibernationDetected).toBe(true);
    });

    test('a record for a different battle is thrown away', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(43)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a record older than ten minutes is thrown away', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - (10 * 60 * 1000 + 1),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a record just inside ten minutes still restores', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - (10 * 60 * 1000 - 1000),
            waveTimes: [],
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
    });

    test('a completion seconds ago blocks a restore, however well the record matches', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });
        tracker._lastCompletionTime = Date.now() - 1000;

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('the completion block lifts after five seconds', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
            waveTimes: [],
        });
        tracker._lastCompletionTime = Date.now() - 5001;

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
    });

    test('a record for a dungeon that is no longer running is thrown away', async () => {
        game.actions = [{ actionHrid: LAIR, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a finished dungeon action does not count as still running', async () => {
        game.actions = [{ actionHrid: DEN, isDone: true }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
    });

    test('the other character does not inherit a half-finished den', async () => {
        beTracking();
        await tracker.saveInProgressRun();
        expect(stored('market123')).toBeDefined();

        game.characterId = 'iron456';
        resetTracker();
        game.actions = [{ actionHrid: DEN, isDone: false }];

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        // and the market cow's record is left where it was
        expect(stored('market123')).toBeDefined();
    });

    test('a mid-dungeon new_battle restores rather than inventing a fresh run', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        await tracker.onNewBattle({ wave: 6, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.wavesCompleted).toBe(4);
        expect(tracker.currentRun.startTime).toBe(1000);
    });

    test('a mid-dungeon new_battle with nothing to restore starts a run anyway', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 6, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.currentWave).toBe(6);
        expect(tracker.currentRun.wavesCompleted).toBe(0);
    });
});

describe('reading key counts out of party chat', () => {
    test('names and counts, commas and all', () => {
        expect(tracker.parseKeyCountsFromMessage('Key counts: [Alice - 12], [Bob - 1,234]')).toEqual({
            Alice: 12,
            Bob: 1234,
        });
    });

    test('surrounding whitespace in a name is dropped', () => {
        expect(tracker.parseKeyCountsFromMessage('[ Alice  -  3 ]')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('[ Alice - 3]')).toEqual({ Alice: 3 });
    });

    test('a dash in the name is part of the name, not the separator', () => {
        expect(tracker.parseKeyCountsFromMessage('Key counts: [Moo-Deng - 12], [Alice - 3]')).toEqual({
            'Moo-Deng': 12,
            Alice: 3,
        });
        expect(tracker.parseKeyCountsFromMessage('[a-b-c - 7]')).toEqual({ 'a-b-c': 7 });
    });

    test('a dashed display timestamp is still not a player', () => {
        expect(tracker.parseKeyCountsFromMessage('[16-07 10:00:00] Key counts: [Moo-Deng - 12]')).toEqual({
            'Moo-Deng': 12,
        });
    });

    test('a display timestamp is not mistaken for a player', () => {
        expect(tracker.parseKeyCountsFromMessage('[08/04 10:00:00 AM] Key counts: [Alice - 12]')).toEqual({
            Alice: 12,
        });
    });

    test('nothing parseable yields nothing', () => {
        expect(tracker.parseKeyCountsFromMessage('')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('Key counts:')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('[Alice - many]')).toEqual({});
    });

    test('zero is a count like any other', () => {
        expect(tracker.parseKeyCountsFromMessage('[Alice - 0]')).toEqual({ Alice: 0 });
    });
});

describe('routing chat messages', () => {
    test('another channel is ignored entirely', () => {
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/general',
                isSystemMessage: true,
                m: 'systemChatMessage.partyKeyCount',
            },
        });
        expect(tracker.recentChatMessages).toHaveLength(0);
    });

    test('a party message with no message object is ignored', () => {
        expect(() => tracker.onChatMessage({})).not.toThrow();
        expect(tracker.recentChatMessages).toHaveLength(0);
    });

    test('a player message is remembered but changes nothing', () => {
        beTracking();
        tracker.onChatMessage({
            message: { chan: '/chat_channel_types/party', isSystemMessage: false, message: 'gg' },
        });
        expect(tracker.recentChatMessages).toHaveLength(1);
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });

    test('the message buffer keeps the last hundred', () => {
        for (let i = 0; i < 105; i++) {
            tracker.onChatMessage({
                message: { chan: '/chat_channel_types/party', isSystemMessage: false, message: `m${i}` },
            });
        }
        expect(tracker.recentChatMessages).toHaveLength(100);
        expect(tracker.recentChatMessages[0].message).toBe('m5');
    });

    test('key counts arriving while not tracking are somebody else’s dungeon', () => {
        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:00.000Z', 'Key counts: [Alice - 12]'));
        expect(tracker.firstKeyCountTimestamp).toBeNull();
        expect(tracker.keyCountMessages).toHaveLength(0);
    });

    test('unparseable metadata is reported and dropped', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        beTracking();
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: '{not json',
            },
        });
        expect(error).toHaveBeenCalled();
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });

    test('the first key count anchors the run at the server’s clock', async () => {
        // The live path: the run-start message is captured by the post-start
        // scan, which is what leaves firstKeyCountTimestamp set.
        beTracking();
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12], [Bob - 8]' }),
            },
        ];
        tracker.scanExistingChatMessages();
        await flush();

        const t0 = Date.parse('2026-08-04T10:00:00.000Z');
        expect(tracker.firstKeyCountTimestamp).toBe(t0);
        expect(tracker.lastKeyCountTimestamp).toBe(t0);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12, Bob: 8 });
        expect(tracker.keyCountMessages).toHaveLength(1);
        expect(tracker.getPartyMessageDuration()).toBe(0);
    });

    test('a key count on a fresh un-progressed run is the start anchor, not a completion', async () => {
        // The live race the tracker has to survive: a run started here, no wave
        // finished yet, and the run's own "Key counts" message arriving before
        // the 100 ms chat scan gets to it. Reading that as the completion would
        // end the run it was supposed to begin and bank a two-second run.
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ startTime: start, wavesCompleted: 0, currentWave: 0 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:02.000Z', 'Key counts: [Alice - 12]'));
        await flush();

        const anchor = Date.parse('2026-08-04T10:00:02.000Z');
        expect(completions).toHaveLength(0);
        expect(tracker.isTracking).toBe(true);
        expect(tracker.firstKeyCountTimestamp).toBe(anchor);
        expect(tracker.lastKeyCountTimestamp).toBe(anchor);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12 });
        expect(game.savedRuns).toHaveLength(0);
    });

    test('the real completion still ends that run, measured from the anchor', async () => {
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ startTime: start, wavesCompleted: 0, currentWave: 0, maxWaves: 10 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:02.000Z', 'Key counts: [Alice - 12]'));
        await flush();
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:34.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].validated).toBe(true);
        expect(completions[0].partyMessageDuration).toBe(272_000); // 10:00:02 → 10:04:34
    });

    test('a party failure ends the run', async () => {
        beTracking();
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyFailed',
                t: '2026-08-04T10:04:00.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(game.savedRuns).toHaveLength(0);
    });

    test('a battle started for another dungeon ends the run', async () => {
        beTracking({ dungeonHrid: DEN });
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T10:04:00.000Z',
                systemMetadata: JSON.stringify({ name: 'Sinister Circus' }),
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
    });

    test('a battle started for the same dungeon leaves the run alone', async () => {
        beTracking({ dungeonHrid: DEN });
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T10:04:00.000Z',
                systemMetadata: JSON.stringify({ name: 'Chimerical Den' }),
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.battleStartedTimestamp).toBe(Date.parse('2026-08-04T10:04:00.000Z'));
    });
});

describe('a canceled battle start', () => {
    test('the ended message disarms a run no wave of which ever completed', async () => {
        // The phantom 15:47 "run": a failed ready-check posts Key counts and
        // then Battle ended a second later. The canceled start must not stay
        // armed as a run's beginning, or the next key count — minutes of
        // party-forming later — reads as its completion.
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, ordinal: 0, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 0, isDone: false }] });
        await tracker.onNewBattle({ wave: 1, battleId: 9, combatStartTime: '2026-08-04T10:26:30.000Z' });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:26:30.000Z', '[Aster - 95] [Briar - 42]'));
        await flush();
        expect(tracker.isTracking).toBe(true);

        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleEnded',
                t: '2026-08-04T10:26:31.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.firstKeyCountTimestamp).toBeNull();

        // The next key count, however much later, completes nothing
        tracker.onChatMessage(keyCountsData('2026-08-04T10:42:17.000Z', '[Aster - 95] [cove - 42]'));
        await flush();
        expect(mockStorage.storeFor('settings').get(`dungeonTracker_teamRuns_${game.characterId}`)).toBeUndefined();
    });

    test('a fight with waves already banked is left to the action feed', async () => {
        await beTracking({ wavesCompleted: 3 });

        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleEnded',
                t: '2026-08-04T10:26:31.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(true);
    });
});

describe('per-wave timing', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('each wave is timed from its own start, not the constant run-start combatStartTime', async () => {
        // The real game sends the SAME combatStartTime on every wave's
        // new_battle — it is the combat action's (run's) start, not the wave's.
        // Timing a wave from it makes every entry the cumulative elapsed since
        // the run began, which is what wrecked the pace chip and the ETA.
        const RUN_START = '2026-08-04T10:00:00.000Z';
        const t0 = Date.parse(RUN_START);
        vi.useFakeTimers();
        vi.setSystemTime(t0);

        beTracking({ startTime: t0, currentWave: 1, wavesCompleted: 0, maxWaves: 10, waveTimes: [] });

        // Three waves, each ~10s apart on the wall clock, all carrying the same
        // (run-start) combatStartTime.
        for (let wave = 1; wave <= 3; wave++) {
            vi.setSystemTime(t0 + wave * 10_000);
            tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave, isDone: false } });
            tracker.startWave({ wave: wave + 1, battleId: 42, combatStartTime: RUN_START });
        }

        // Per-wave gaps (~10s each), not the cumulative 10s/20s/30s the old code
        // produced from the frozen run-start anchor.
        expect(tracker.waveTimes).toEqual([10_000, 10_000, 10_000]);

        const run = tracker.getCurrentRun();
        expect(run.avgWaveTime).toBe(10_000);
    });

    test('wave 1 is timed from the run start, not a combatStartTime hours stale', async () => {
        // In continuous queued combat, combatStartTime is when the session's
        // fighting began — here 2.6 hours before this run. The old code
        // anchored wave 1 to it, recording one 9,500,000 ms wave that swamped
        // the average and drove the pace chip to −6000%.
        const runStart = Date.parse('2026-08-04T12:40:00.000Z');
        const staleCombatStart = '2026-08-04T10:00:00.000Z';
        vi.useFakeTimers();
        vi.setSystemTime(runStart);
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, ordinal: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 7, combatStartTime: staleCombatStart });
        await flush();
        expect(tracker.currentRun.startTime).toBe(runStart);

        vi.setSystemTime(runStart + 10_000);
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 1, isDone: false } });

        expect(tracker.waveTimes).toEqual([10_000]);
        expect(tracker.getCurrentRun().avgWaveTime).toBe(10_000);
    });

    test('a wave’s time is completion-to-completion, so it matches duration over wave count', async () => {
        // Fight 6s, then a 4s respawn gap before the next completion: the
        // stored history (duration ÷ waves) counts the gap, so the live wave
        // must too, or the pace reads spuriously "faster".
        const t0 = Date.parse('2026-08-04T10:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(t0);
        beTracking({ startTime: t0, currentWave: 1, wavesCompleted: 0, maxWaves: 10, waveTimes: [] });

        vi.setSystemTime(t0 + 6_000); // wave 1 fight ends
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 1, isDone: false } });
        vi.setSystemTime(t0 + 10_000); // 4s gap, wave 2 starts
        tracker.startWave({ wave: 2, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        vi.setSystemTime(t0 + 16_000); // wave 2 fight ends (6s fight)
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 2, isDone: false } });

        // wave 1: 6s from run start; wave 2: 10s = 4s gap + 6s fight
        expect(tracker.waveTimes).toEqual([6_000, 10_000]);
    });

    test('getCurrentRun exposes the wave times so the split-time pace can sum them', () => {
        beTracking({ waveTimes: [3000, 5000, 4000], currentWave: 4, wavesCompleted: 3 });
        expect(tracker.getCurrentRun().waveTimes).toEqual([3000, 5000, 4000]);
    });
});

describe('finishing a run', () => {
    test('a second key count completes it, and the server’s clock is the duration', async () => {
        beTracking({
            waveTimes: [3000, 5000, 4000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(completions).toHaveLength(1);

        const run = completions[0];
        expect(run.validated).toBe(true);
        expect(run.partyMessageDuration).toBe(272_000); // 4m32s between the two messages
        expect(run.totalTime).toBe(272_000);
        expect(run.avgWaveTime).toBe(4000); // (3000 + 5000 + 4000) / 3
        expect(run.fastestWave).toBe(3000);
        expect(run.slowestWave).toBe(5000);
        expect(run.wavesCompleted).toBe(10);
        expect(run.keyCountsMap).toEqual({ Alice: 11, Bob: 7 });
        expect(run.keyCountMessages).toHaveLength(2);
    });

    test('the completed run reaches history under the sorted team key, wave times included', async () => {
        beTracking({
            keyCountsMap: { Bob: 8, Alice: 12 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
            waveTimes: [3000, 5000, 4000],
        });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Bob - 7], [Alice - 11]'));
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].teamKey).toBe('Alice,Bob');
        // The per-wave times travel with the run: they are what the split-time
        // pace profile is built from, and history used to drop them on save
        expect(game.savedRuns[0].run).toEqual({
            timestamp: '2026-08-04T10:00:00.000Z',
            duration: 272_000,
            dungeonName: 'Chimerical Den',
            dungeonHrid: '/actions/combat/chimerical_den',
            tier: 0,
            keyCountsMap: { Alice: 11, Bob: 7 },
            waveTimes: [3000, 5000, 4000],
            avgWaveTime: 4000,
            // The party's "Key counts" messages timed this one, so it is stored as
            // server-validated — the distinction a solo run's wall-clock time lacks
            validated: true,
            // Watched from its own start, so it may set the recovery bound
            startRecovered: false,
            source: 'chat',
        });
    });

    test('the in-progress record is cleared when the run ends', async () => {
        beTracking({ keyCountsMap: { Alice: 12 }, anchoredAt: '2026-08-04T10:00:00.000Z' });
        await tracker.saveInProgressRun();
        expect(stored()).toBeDefined();

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(stored()).toBeUndefined();
        expect(tracker._lastCompletionTime).toBeGreaterThan(0);
    });

    test('a run with only a start message is not server-validated and is not saved', async () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 300_000);
        beTracking({ startTime: start, maxWaves: 10, wavesCompleted: 10, waveTimes: [] });
        tracker.firstKeyCountTimestamp = start;
        tracker.lastKeyCountTimestamp = start;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        await tracker.completeDungeon();

        expect(completions[0].validated).toBe(false);
        expect(completions[0].partyMessageDuration).toBeNull();
        expect(completions[0].totalTime).toBe(300_000); // falls back to the tracked wall clock
        expect(completions[0].avgWaveTime).toBe(0);
        expect(game.savedRuns).toHaveLength(0);
    });

    test('the completion timestamp becomes the next run’s start anchor', async () => {
        beTracking({ keyCountsMap: { Alice: 12 }, anchoredAt: '2026-08-04T10:00:00.000Z' });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        const completion = Date.parse('2026-08-04T10:04:32.000Z');
        expect(tracker.pendingNextRunFirstKeyCount).toBe(completion);

        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        await tracker.onNewBattle({ wave: 1, battleId: 43, combatStartTime: '2026-08-04T10:04:33.000Z' });
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBe(completion);
        expect(tracker.lastKeyCountTimestamp).toBe(completion);
        expect(tracker.pendingNextRunFirstKeyCount).toBeNull();
    });

    test('a run part way through its waves treats an unanchored key count as the completion', async () => {
        // Not restored, but four waves deep: the start message must have been
        // missed, because the run has plainly been going for a while.
        beTracking({ startTime: Date.parse('2026-08-04T10:00:00.000Z'), maxWaves: 10, wavesCompleted: 4 });
        tracker.firstKeyCountTimestamp = null;
        tracker.lastKeyCountTimestamp = null;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('a websocket completion does not hand its start anchor to the next run', async () => {
        // The run ended on action_completed, so lastKeyCountTimestamp is still
        // this run's START. Carrying it forward would make the next run measure
        // both runs as one.
        const firstStart = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({
            currentWave: 10,
            wavesCompleted: 9,
            maxWaves: 10,
            keyCountsMap: { Alice: 12 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 0, isDone: true } });
        await flush();

        expect(completions).toHaveLength(1);
        expect(tracker.pendingNextRunFirstKeyCount).toBeNull();

        // The next run anchors on its own key count, and is measured on its own
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        await tracker.onNewBattle({ wave: 1, battleId: 43, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBeNull();

        tracker.onChatMessage(keyCountsData('2026-08-04T10:05:01.000Z', 'Key counts: [Alice - 11]'));
        await flush();
        tracker.onChatMessage(keyCountsData('2026-08-04T10:09:33.000Z', 'Key counts: [Alice - 10]'));
        await flush();

        expect(completions).toHaveLength(2);
        expect(completions[1].partyMessageDuration).toBe(272_000); // this run alone
        expect(completions[1].partyMessageDuration).toBeLessThan(Date.now() - firstStart);
    });

    test('a restored run treats its first key count as the completion', async () => {
        // Restored mid-run: the start message was never seen, so the run's own
        // startTime stands in for it and this message ends the run.
        beTracking({
            startTime: Date.parse('2026-08-04T10:00:00.000Z'),
            maxWaves: 10,
            wavesCompleted: 10,
            restored: true,
        });
        tracker.firstKeyCountTimestamp = null;
        tracker.lastKeyCountTimestamp = null;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].validated).toBe(true);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('completing twice does nothing the second time', async () => {
        beTracking();
        tracker.firstKeyCountTimestamp = 1000;
        tracker.lastKeyCountTimestamp = 2000;
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        await tracker.completeDungeon();
        await tracker.completeDungeon();

        expect(completions).toHaveLength(1);
    });

    test('a callback that throws does not stop the others', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        beTracking();
        const seen = [];
        tracker.onUpdate(() => {
            throw new Error('boom');
        });
        tracker.onUpdate((run, completed) => seen.push(completed ?? 'update'));

        await tracker.completeDungeon();

        expect(seen.length).toBeGreaterThan(0);
        expect(error).toHaveBeenCalled();
    });

    test('a removed callback stops hearing about updates', () => {
        const calls = [];
        const cb = () => calls.push(1);
        tracker.onUpdate(cb);
        tracker.notifyUpdate();
        tracker.offUpdate(cb);
        tracker.notifyUpdate();
        expect(calls).toHaveLength(1);
    });
});

describe('waves completing over the websocket', () => {
    test('a wave completion records its time and advances the count', async () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 4000);
        beTracking({ startTime: start, currentWave: 3, wavesCompleted: 2 });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 3, isDone: false } });
        await flush();

        expect(tracker.waveTimes).toEqual([4000]);
        expect(tracker.currentRun.wavesCompleted).toBe(3);
        expect(tracker.isTracking).toBe(true);
    });

    test('the last wave reports itself as wave 0, and the run still counts fifty', async () => {
        beTracking({ currentWave: 10, wavesCompleted: 9, maxWaves: 10 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 0, isDone: true } });
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].wavesCompleted).toBe(10);
    });

    test('finishing early is a reset, not a completion', async () => {
        beTracking({ currentWave: 4, wavesCompleted: 3, maxWaves: 10 });
        await tracker.saveInProgressRun();
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 4, isDone: true } });
        await flush();

        expect(completions).toHaveLength(0);
        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(stored()).toBeUndefined();
    });

    test('a restored run with no wave start time records no wave time', async () => {
        beTracking({ currentWave: 5, wavesCompleted: 4 });
        // No anchor for the wave in progress: neither its start nor the
        // previous wave's end is known after a restore
        tracker.waveStartTime = null;
        tracker.lastWaveEndTime = null;

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 5, isDone: false } });
        await flush();

        expect(tracker.waveTimes).toEqual([]);
        expect(tracker.currentRun.wavesCompleted).toBe(5);
    });

    test('an ordinary combat zone completion is not a wave', () => {
        beTracking();
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: FLY, wave: 3, isDone: true } });
        expect(tracker.isTracking).toBe(true);
        expect(tracker.waveTimes).toEqual([]);
    });

    test('a dungeon action with no wave field is not a wave either', () => {
        beTracking();
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, isDone: true } });
        expect(tracker.isTracking).toBe(true);
        expect(tracker.waveTimes).toEqual([]);
    });

    test('nothing happens when not tracking', () => {
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 3, isDone: true } });
        expect(tracker.isTracking).toBe(false);
    });
});

describe('the action queue changing under the run', () => {
    test('a dungeon marked done before the waves ran out ends the run', async () => {
        beTracking({ wavesCompleted: 4, maxWaves: 10 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, isDone: true }] });
        await flush();
        expect(tracker.isTracking).toBe(false);
    });

    test('a dungeon marked done with every wave finished is left for action_completed', async () => {
        beTracking({ wavesCompleted: 10, maxWaves: 10 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, isDone: true }] });
        await flush();
        expect(tracker.isTracking).toBe(true);
    });

    test('a non-dungeon action in the queue is ignored', () => {
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: FLY, isDone: false }] });
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a message with no actions is harmless', () => {
        expect(() => tracker.onActionsUpdated({})).not.toThrow();
    });
});

describe('what the panel is shown', () => {
    test('nothing while there is no run', () => {
        expect(tracker.getCurrentRun()).toBeNull();
    });

    test('elapsed time is measured from the server’s start, not the local one', () => {
        vi.useFakeTimers();
        const serverStart = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(serverStart + 120_000);
        beTracking({ startTime: serverStart + 30_000, waveTimes: [4000, 6000], wavesCompleted: 2, maxWaves: 10 });
        tracker.waveStartTime = new Date(serverStart + 100_000);
        tracker.firstKeyCountTimestamp = serverStart;

        const run = tracker.getCurrentRun();

        expect(run.totalElapsed).toBe(120_000);
        expect(run.currentWaveElapsed).toBe(20_000);
        expect(run.avgWaveTime).toBe(5000);
        expect(run.fastestWave).toBe(4000);
        expect(run.slowestWave).toBe(6000);
        expect(run.estimatedTimeRemaining).toBe(40_000); // 8 waves left at 5s each
        expect(run.dungeonName).toBe('Chimerical Den');
    });

    test('without a server timestamp the tracked start is used', () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 60_000);
        beTracking({ startTime: start, waveTimes: [] });

        const run = tracker.getCurrentRun();
        expect(run.totalElapsed).toBe(60_000);
        expect(run.estimatedTimeRemaining).toBe(0);
        expect(run.avgWaveTime).toBe(0);
    });
});

describe('waking the computer back up', () => {
    test('a run that spanned a hidden tab is flagged as possibly wrong', async () => {
        tracker.setupHibernationDetection();
        beTracking();

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        await flush();

        expect(tracker.hibernationDetected).toBe(true);
        expect(tracker.getCurrentRun().hibernationDetected).toBe(true);
        expect(stored().hibernationDetected).toBe(true);
    });

    test('a hidden tab outside a run flags nothing', () => {
        tracker.setupHibernationDetection();

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(tracker.hibernationDetected).toBe(false);
    });

    test('a new run starts unflagged', async () => {
        tracker.hibernationDetected = true;
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 5, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.hibernationDetected).toBe(false);
        expect(tracker.currentRun.hibernationDetected).toBe(false);
    });
});

describe('picking the run back up on page load', () => {
    test('a saved record for the running dungeon is restored without a battle message', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.wavesCompleted).toBe(4);
    });

    test('a stale record is dropped and the dungeon merely noted as pending', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - 11 * 60 * 1000,
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('no dungeon running means nothing to pick up', async () => {
        game.actions = [{ actionHrid: FLY, isDone: false }];
        await tracker.checkForActiveDungeon();
        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a completion seconds ago blocks the page-load pickup too', async () => {
        // The same guard restoreInProgressRun applies: the record belongs to the
        // run that just ended, and its clear may still be in flight.
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            wavesCompleted: 4,
            lastUpdateTime: Date.now(),
        });
        tracker._lastCompletionTime = Date.now() - 1000;

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('a record with no battle to tie it to is not picked up', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            dungeonHrid: DEN,
            wavesCompleted: 4,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('a picked-up run keeps the hibernation flag it was saved with', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
            hibernationDetected: true,
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.hibernationDetected).toBe(true);
        expect(tracker.currentRun.hibernationDetected).toBe(true);
        expect(tracker.getCurrentRun().hibernationDetected).toBe(true);
    });

    test('a picked-up run reads its next key count as the completion', async () => {
        // Restored, so its own start message was never seen — even at wave 0.
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: Date.parse('2026-08-04T10:00:00.000Z'),
            currentWave: 1,
            maxWaves: 10,
            wavesCompleted: 0,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();
        expect(tracker.restoredMidRun).toBe(true);

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('a record for a different dungeon only leaves pending info', async () => {
        game.actions = [{ actionHrid: LAIR, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: LAIR, tier: 0 });
    });
});

describe('scanning chat already on screen', () => {
    test('the newest key counts in memory become the run’s counts', async () => {
        beTracking();
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T09:59:00.000Z',
            },
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12], [Bob - 8]' }),
            },
        ];

        tracker.scanExistingChatMessages();
        await flush();

        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12, Bob: 8 });
        expect(tracker.firstKeyCountTimestamp).toBe(Date.parse('2026-08-04T10:00:00.000Z'));
        expect(tracker.lastKeyCountTimestamp).toBe(tracker.firstKeyCountTimestamp);
        expect(tracker.battleStartedTimestamp).toBe(Date.parse('2026-08-04T09:59:00.000Z'));
        expect(tracker.keyCountMessages).toHaveLength(1);
    });

    test('an anchor already carried forward is not overwritten by the scan', async () => {
        beTracking();
        tracker.firstKeyCountTimestamp = 1234;
        tracker.lastKeyCountTimestamp = 1234;
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12]' }),
            },
        ];

        tracker.scanExistingChatMessages();
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBe(1234);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12 });
    });

    test('scanning while not tracking does nothing', () => {
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12]' }),
            },
        ];
        tracker.scanExistingChatMessages();
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });
});

describe('rebuilding history from the chat log', () => {
    function chatLog(entries) {
        document.body.innerHTML = '';
        for (const entry of entries) {
            const node = document.createElement('div');
            node.className = 'ChatMessage_chatMessage__abc';
            if (entry.username) {
                const name = document.createElement('span');
                name.className = 'ChatMessage_username__x';
                name.textContent = entry.username;
                node.appendChild(name);
            }
            const body = document.createElement('span');
            body.textContent = entry.text;
            node.appendChild(body);
            document.body.appendChild(node);
        }
    }

    const year = new Date().getFullYear();
    const at = (h, m, s) => new Date(year, 7, 4, h, m, s, 0);

    test('a key-to-key pair becomes a run, dated and named', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12], [Bob - 8]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11], [Bob - 7]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice,Bob']);
        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].run).toEqual({
            timestamp: at(10, 0, 5).toISOString(),
            duration: 272_000,
            dungeonName: 'Chimerical Den',
        });
    });

    test('a backfilled run of the dungeon being run now inherits its tier', async () => {
        // Chat carries no tier, so the only signal is the dungeon running when
        // Backfill is pressed — here Chimerical Den T2.
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, isDone: false }];
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);

        await tracker.backfillFromChatHistory();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].run.tier).toBe(2);
        expect(game.savedRuns[0].run.dungeonHrid).toBe(DEN);
    });

    test('a backfilled run of a different dungeon than the one running now stays untiered', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, isDone: false }];
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Sinister Circus' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);

        await tracker.backfillFromChatHistory();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].run.tier).toBeUndefined();
        expect(game.savedRuns[0].run.dungeonName).toBe('Sinister Circus');
    });

    test('with no dungeon running, a backfilled run is untiered as before', async () => {
        game.actions = [];
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);

        await tracker.backfillFromChatHistory();

        expect(game.savedRuns[0].run.tier).toBeUndefined();
    });

    test('a failed run is not a run', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:02:00 AM] Party failed on wave 7' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(0);
        expect(game.savedRuns).toHaveLength(0);
    });

    test('a canceled run is not a run either', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:02:00 AM] Battle ended: Chimerical Den' },
        ]);

        expect((await tracker.backfillFromChatHistory()).runsAdded).toBe(0);
    });

    test('player chatter is skipped, however much it looks like a key count', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { username: 'Alice', text: 'Alice: Key counts: [Alice - 99]' },
            { text: 'Someone: Key counts: [Bob - 99]' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice']);
    });

    test("player chatter under the game's current markup is skipped too", async () => {
        // The game renamed ChatMessage_username to ChatMessage_name with a
        // CharacterName element inside, and player messages open with a
        // [timestamp] — which also defeats the text fallback. Only the class
        // check can catch these; live DOM verified 2026-08-17.
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);
        const chatter = document.createElement('div');
        chatter.className = 'ChatMessage_chatMessage__abc';
        const name = document.createElement('span');
        name.className = 'ChatMessage_name__1UZ8t';
        const inner = document.createElement('span');
        inner.className = 'CharacterName_name__1amXp';
        inner.textContent = 'Mallory';
        name.appendChild(inner);
        chatter.appendChild(name);
        const body = document.createElement('span');
        body.textContent = '[08/04 10:02:00 AM] Mallory: Key counts: [Mallory - 99]';
        chatter.appendChild(body);
        document.body.insertBefore(chatter, document.body.children[2]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice']);
    });

    test('three key counts in a row are two runs', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:00 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:05:00 AM] Key counts: [Alice - 11]' },
            { text: '[08/04 10:10:00 AM] Key counts: [Alice - 10]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(2);
        expect(game.savedRuns.map((r) => r.run.duration)).toEqual([300_000, 300_000]);
    });

    test('an empty chat is not an error', async () => {
        chatLog([]);
        expect(await tracker.backfillFromChatHistory()).toEqual({ runsAdded: 0, teams: [] });
    });

    test('messages without a parseable timestamp are skipped', async () => {
        chatLog([{ text: 'Key counts: [Alice - 12]' }, { text: 'Key counts: [Alice - 11]' }]);
        expect((await tracker.backfillFromChatHistory()).runsAdded).toBe(0);
    });
});

describe('switching characters', () => {
    test('cleanup unhooks everything and forgets the run', async () => {
        await tracker.initialize();
        expect(Object.keys(game.wsHandlers).sort()).toEqual([
            'action_completed',
            'actions_updated',
            'chat_message_received',
            'new_battle',
        ]);

        beTracking();
        await tracker.saveInProgressRun();

        await tracker.cleanup();

        expect(Object.keys(game.wsHandlers)).toHaveLength(0);
        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(tracker.recentChatMessages).toEqual([]);
        expect(tracker.isInitialized).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('cleanup drops the just-completed veto that would refuse the next character', async () => {
        // `canRestoreRecord` refuses any record for five seconds after a run
        // completes, because that run's own record may still be being cleared.
        // Switch characters inside those five seconds and the veto is applied
        // to the arriving character's record instead — which is live, not
        // stale, so their in-progress run is silently dropped.
        tracker._lastCompletionTime = Date.now();

        await tracker.cleanup();

        expect(tracker._lastCompletionTime).toBe(0);
        expect(tracker.canRestoreRecord({ battleId: 42, lastUpdateTime: Date.now() }, 42)).toBe(true);
    });

    test('a record read that lands after the switch is not restored', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        // The read was issued for market123; the player is on the alt by the
        // time it lands. Restoring now would leave the alt tracking the main's
        // run — and the run that eventually completes is written into the alt's
        // history with the main's start time and wave times.
        mockStorage.get.mockImplementationOnce(async (key, storeName = 'settings', fallback = null) => {
            game.characterId = 'alt456';
            const store = mockStorage.storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : fallback;
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
    });

    test('a mid-run restore that lands after the switch is refused', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        mockStorage.get.mockImplementationOnce(async (key, storeName = 'settings', fallback = null) => {
            game.characterId = 'alt456';
            const store = mockStorage.storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : fallback;
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        // Refused, not cleared: the record still belongs to the character who
        // is mid-run in it
        expect(mockStorage.storeFor('settings').has(`${IN_PROGRESS}_market123`)).toBe(true);
    });

    test('initialising twice hooks the websocket once', async () => {
        await tracker.initialize();
        const first = game.wsHandlers.new_battle;
        await tracker.initialize();
        expect(game.wsHandlers.new_battle).toBe(first);
        await tracker.cleanup();
    });
});

describe('a character switch inside onNewBattle', () => {
    test('a wave 1 landing across a switch does not start the departing character’s run on the arriving one', async () => {
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });

        // The switch lands in `clearInProgressRun`'s round trip, between the
        // message arriving and `startDungeon` reading it
        const pending = tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        game.characterId = 'iron456';
        await pending;
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(mockStorage.storeFor('settings').get('dungeonTracker_inProgress_iron456')).toBeUndefined();
    });

    test('a mid-dungeon wave landing across a switch starts nothing either', async () => {
        // The restore stands itself down on a switch and reports false, which
        // reads as "nothing saved" — the fallback start must not run on it
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });

        const pending = tracker.onNewBattle({ wave: 4, battleId: 77, combatStartTime: '2026-08-04T10:05:00.000Z' });
        game.characterId = 'iron456';
        await pending;
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
    });
});

describe('the running dungeon changing under a live run', () => {
    // Observed live: the panel read "Chimerical Den (T0), Wave 61/50" while the
    // character was fighting Pirate Cove wave 61 of 65 — a wave number that no
    // 50-wave dungeon can reach. The run's identity came from the dungeon that
    // had been left behind and the wave number from the one now running, because
    // nothing between `startDungeon` and `completeDungeon` ever asks whether the
    // dungeon under the run is still the one the game is running.

    /** The queue as it looked live: the running dungeon last in the array, lowest ordinal. */
    function queueSwitchedTo(runningHrid, queuedHrid) {
        game.actions = [
            { actionHrid: queuedHrid, difficultyTier: 0, ordinal: 8589934584, isDone: false },
            { actionHrid: runningHrid, difficultyTier: 0, ordinal: 8589934583, isDone: false },
        ];
    }

    test('a wave from a different running dungeon moves the run onto it', async () => {
        beTracking({ dungeonHrid: DEN, tier: 0, currentWave: 5, maxWaves: 10, wavesCompleted: 4 });
        queueSwitchedTo(LAIR, DEN);

        // Wave 11 is impossible in the 10-wave Den and ordinary in the 12-wave Circus.
        await tracker.onNewBattle({ wave: 11, battleId: 99, combatStartTime: '2026-08-04T11:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.dungeonHrid).toBe(LAIR);
        expect(tracker.currentRun.maxWaves).toBe(12);
        expect(tracker.currentRun.currentWave).toBe(11);
        expect(tracker.currentRun.wavesCompleted).toBe(0);
        expect(tracker.currentBattleId).toBe(99);
        // The panel can no longer read a wave past the end of its own dungeon.
        expect(tracker.currentRun.currentWave).toBeLessThanOrEqual(tracker.currentRun.maxWaves);
    });

    test('the abandoned run is discarded, not banked as a short run', async () => {
        beTracking({ dungeonHrid: DEN, tier: 0, currentWave: 5, maxWaves: 10, wavesCompleted: 4, waveTimes: [1000] });
        queueSwitchedTo(LAIR, DEN);

        await tracker.onNewBattle({ wave: 11, battleId: 99, combatStartTime: '2026-08-04T11:00:00.000Z' });
        await flush();

        expect(game.savedRuns).toHaveLength(0);
        // None of the departed run's timings leak into the new one.
        expect(tracker.waveTimes).toEqual([]);
        expect(stored().dungeonHrid).toBe(LAIR);
    });

    test('the same dungeon carrying on is left alone', async () => {
        beTracking({ dungeonHrid: DEN, tier: 0, currentWave: 5, maxWaves: 10, wavesCompleted: 4, waveTimes: [1000] });
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, ordinal: 3, isDone: false }];

        await tracker.onNewBattle({ wave: 6, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.wavesCompleted).toBe(4);
        expect(tracker.waveTimes).toEqual([1000]);
    });

    test('a different dungeon leaving the queue still does not kill the live run', () => {
        // The guard this pairs with: a queued dungeon being dropped or finished
        // says nothing about the run in progress.
        beTracking({ dungeonHrid: DEN, wavesCompleted: 4, maxWaves: 10 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, isDone: true }] });
        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
    });
});

describe('wave 1 as a dungeon start', () => {
    // The game numbers waves from 1; the fresh-start branch used to test
    // `wave === 0`, so it never ran and tracking only ever began by accident.

    test('wave 1 with a dungeon armed starts a run', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, ordinal: 0, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun).toMatchObject({ dungeonHrid: DEN, tier: 2, currentWave: 1, wavesCompleted: 0 });
    });

    test('wave 1 of the next run starts it over rather than appending to the last', async () => {
        // The previous run's end was never seen; actions_updated has armed the
        // dungeon that is now running, which is what marks this a real start.
        beTracking({ dungeonHrid: DEN, currentWave: 10, maxWaves: 10, wavesCompleted: 9, waveTimes: [1000, 2000] });
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, ordinal: 3, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 0, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 500, combatStartTime: '2026-08-04T11:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.wavesCompleted).toBe(0);
        expect(tracker.currentRun.currentWave).toBe(1);
        expect(tracker.currentBattleId).toBe(500);
        expect(tracker.waveTimes).toEqual([]);
    });

    test('a resent wave 1 does not restart the run', async () => {
        // `new_battle` is in SKIP_DEDUP_TYPES, so a reconnect on the first wave
        // resends it verbatim; treating that as a start would wipe the run.
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ dungeonHrid: DEN, startTime: start, currentWave: 1, maxWaves: 10, wavesCompleted: 3 });
        tracker.waveTimes = [1234, 5678];
        tracker.pendingDungeonInfo = null;
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, ordinal: 3, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.startTime).toBe(start);
        expect(tracker.currentRun.wavesCompleted).toBe(3);
        expect(tracker.waveTimes).toEqual([1234, 5678]);
    });

    test('a resent wave 1 is still a resend when the queue re-announced the running dungeon', async () => {
        // `endCharacterActions` carries existing actions alongside new ones, so any
        // queue edit mid-run re-arms `pendingDungeonInfo` for the dungeon already
        // being tracked. That is not a new run pending, and reading it as one wipes
        // wavesCompleted, waveTimes and the party timestamps on a reconnect. The
        // battle is the same battle, and its id says so.
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ dungeonHrid: DEN, startTime: start, currentWave: 1, maxWaves: 10, wavesCompleted: 3 });
        tracker.waveTimes = [1234, 5678];
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, ordinal: 3, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 0, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.startTime).toBe(start);
        expect(tracker.currentRun.wavesCompleted).toBe(3);
        expect(tracker.waveTimes).toEqual([1234, 5678]);
    });

    test('wave 1 of a queued-but-not-running dungeon still starts nothing', async () => {
        game.actions = [
            { actionHrid: FLY, difficultyTier: 0, ordinal: 1, isDone: false },
            { actionHrid: LAIR, difficultyTier: 2, ordinal: 2, isDone: false },
        ];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 2, isDone: false }] });

        await tracker.onNewBattle({ wave: 1, battleId: 77, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
    });
});

describe('a run joined part-way through', () => {
    test('a first wave above 1 flags the run partial and records where it was picked up', async () => {
        // The live case: a refresh at wave 48 of a 65-wave Pirate Cove. The next
        // new_battle is the tracker's first sight of the run.
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];

        await tracker.onNewBattle({ wave: 8, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.joinedMidRun).toBe(true);
        expect(tracker.currentRun.joinedMidRun).toBe(true);
        expect(tracker.currentRun.joinedAtWave).toBe(8);
    });

    test('its elapsed figure is time since we noticed, and is labelled as such', () => {
        const t0 = Date.parse('2026-08-04T10:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(t0 + 90_000);
        // startTime is when tracking began, 90s ago — not when the run began
        beTracking({ startTime: t0, currentWave: 48, wavesCompleted: 0, joinedMidRun: true, joinedAtWave: 48 });

        const run = tracker.getCurrentRun();
        expect(run.joinedMidRun).toBe(true);
        expect(run.joinedAtWave).toBe(48);
        // The number is honest about what it measures, and the flag stops the
        // panel presenting it as the run's duration
        expect(run.elapsedIsSinceNoticed).toBe(true);
        expect(run.totalElapsed).toBe(90_000);
    });

    test('a chat anchor does not become the partial run’s start time', () => {
        // A scan of the party log can turn up a "Key counts" from a run we did not
        // watch. For a whole run that anchor is the truth; for this one it is a
        // guess at a start we never saw, so it is not used.
        const t0 = Date.parse('2026-08-04T10:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(t0 + 60_000);
        beTracking({ startTime: t0, currentWave: 20, joinedMidRun: true, joinedAtWave: 20 });
        tracker.firstKeyCountTimestamp = t0 - 900_000; // fifteen minutes before we looked

        expect(tracker.getCurrentRun().totalElapsed).toBe(60_000);
    });

    test('reaching the final wave in a party does not bank it', async () => {
        // Without the flag this is the worst case: the key-count fallback anchors
        // on the moment we noticed, so the run looks server-validated at a
        // fraction of its real length and lands in history and the averages.
        beTracking({
            maxWaves: 10,
            wavesCompleted: 9,
            currentWave: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            joinedMidRun: true,
            joinedAtWave: 7,
        });
        const completions = [];
        tracker.onUpdate((_run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(game.savedRuns).toEqual([]);
        expect(completions).toHaveLength(1);
        expect(completions[0].joinedMidRun).toBe(true);
        // No duration is reported at all, rather than an invented one
        expect(completions[0].totalTime).toBeNull();
        expect(completions[0].trackedDuration).toBeNull();
        expect(completions[0].partyMessageDuration).toBeNull();
        expect(completions[0].validated).toBe(false);
    });

    test('reaching the final wave solo does not bank it either', async () => {
        beTracking({ maxWaves: 10, wavesCompleted: 9, currentWave: 10, joinedMidRun: true, joinedAtWave: 7 });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 10, isDone: true } });
        await flush();

        expect(game.savedRuns).toEqual([]);
    });

    test('a run that starts at wave 1 is not partial and keeps its start time', async () => {
        const runStart = Date.parse('2026-08-04T10:03:20.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(runStart);
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.joinedMidRun).toBe(false);
        expect(tracker.currentRun.joinedMidRun).toBe(false);
        expect(tracker.currentRun.joinedAtWave).toBeNull();

        vi.setSystemTime(runStart + 30_000);
        const run = tracker.getCurrentRun();
        expect(run.elapsedIsSinceNoticed).toBe(false);
        expect(run.totalElapsed).toBe(30_000);
    });

    test('the flag rides along in the in-progress record, so a refresh cannot launder it', async () => {
        beTracking({ battleId: 42, joinedMidRun: true, joinedAtWave: 7, currentWave: 7 });
        await tracker.saveInProgressRun();
        expect(stored().joinedMidRun).toBe(true);
        expect(stored().joinedAtWave).toBe(7);

        resetTracker();
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        const restored = await tracker.restoreInProgressRun(42);

        expect(restored).toBe(true);
        expect(tracker.joinedMidRun).toBe(true);
        expect(tracker.currentRun.joinedMidRun).toBe(true);
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(true);
    });

    test('a record from a whole run restores as a whole run', async () => {
        // restoredMidRun means "read back from storage", which is not the same as
        // partial: the record carries the run's real start time.
        beTracking({ battleId: 42, currentWave: 4 });
        await tracker.saveInProgressRun();
        expect(stored().joinedMidRun).toBe(false);

        resetTracker();
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        await tracker.restoreInProgressRun(42);

        expect(tracker.restoredMidRun).toBe(true);
        expect(tracker.joinedMidRun).toBe(false);
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(false);
    });

    test('the page-load pickup of a whole run is not partial either', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 1,
            startTime: Date.now() - 120_000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.joinedMidRun).toBe(false);
    });
});

describe('the provisional card on page load', () => {
    test('a running dungeon with no restorable record is named, without a run behind it', async () => {
        // The refresh that showed nothing for a whole wave: a saved record for a
        // different dungeon, correctly declined, left the panel blank for ~35s.
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 9,
            dungeonHrid: LAIR,
            lastUpdateTime: Date.now(),
        });
        const seen = [];
        tracker.onUpdate((run) => seen.push(run));

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(tracker.getPendingDungeon()).toEqual({
            dungeonHrid: DEN,
            dungeonName: 'Chimerical Den',
            tier: 1,
            maxWaves: 10,
            pending: true,
        });
        // The panel is told to look: the update carries no run, and the card is
        // read off getPendingDungeon
        expect(seen).toEqual([null]);
        // Display only: no run was started and the other dungeon's record was
        // left exactly as it was, not overwritten with a run that never began
        expect(stored()).toEqual({ battleId: 9, dungeonHrid: LAIR, lastUpdateTime: expect.any(Number) });
    });

    test('a stale record leaves the same provisional card', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 2, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - 11 * 60 * 1000,
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.getPendingDungeon()).toMatchObject({ dungeonName: 'Chimerical Den', tier: 2, pending: true });
    });

    test('the card goes away when the dungeon it names stops running', async () => {
        // Nothing else clears the provisional arm: it is set on page load with no
        // run behind it, and only `startDungeon` and `resetTracking` — both of
        // which need a run — ever cleared it. Cancel the dungeon and go fishing
        // and the panel went on announcing a dungeon that had left the queue.
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        await tracker.checkForActiveDungeon();
        expect(tracker.getPendingDungeon()).not.toBeNull();

        game.actions = [{ actionHrid: FLY, difficultyTier: null, ordinal: 1, isDone: false }];
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 1, isDone: true }] });

        expect(tracker.getPendingDungeon()).toBeNull();
    });

    test('the card survives the queue merely being edited under it', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, ordinal: 1, isDone: false }];
        await tracker.checkForActiveDungeon();

        tracker.onActionsUpdated({
            endCharacterActions: [{ actionHrid: '/actions/cheesesmithing/cheese_gauntlets', isDone: false }],
        });

        expect(tracker.getPendingDungeon()).toMatchObject({ dungeonHrid: DEN, pending: true });
    });

    test('nothing pending once the real run starts', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        await tracker.checkForActiveDungeon();
        expect(tracker.getPendingDungeon()).not.toBeNull();

        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.getPendingDungeon()).toBeNull();
    });

    test('no dungeon running, no card', async () => {
        game.actions = [{ actionHrid: FLY, isDone: false }];
        await tracker.checkForActiveDungeon();
        expect(tracker.getPendingDungeon()).toBeNull();
    });
});

describe('banking a solo run', () => {
    /** Take a whole run from wave 1 to its last wave, solo — no party messages. */
    async function soloRun({
        maxWaves = 10,
        startAt = Date.parse('2026-08-04T10:00:00.000Z'),
        lengthMs = 300_000,
        players = [{ character: { name: 'Marketcow' } }],
    } = {}) {
        vi.useFakeTimers();
        vi.setSystemTime(startAt);
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        await tracker.onNewBattle({
            wave: 1,
            battleId: 42,
            combatStartTime: '2026-08-04T09:00:00.000Z',
            players,
        });
        await flush();
        tracker.currentRun.maxWaves = maxWaves;
        tracker.currentRun.currentWave = maxWaves;
        tracker.currentRun.wavesCompleted = maxWaves - 1;
        vi.setSystemTime(startAt + lengthMs);
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: maxWaves, isDone: true } });
        await flush();
    }

    test('a whole run watched end to end is saved, on the wall clock, marked unvalidated', async () => {
        // Solo runs used to be discarded outright — there are no party "Key counts"
        // messages to validate them, so a solo player built no history at all.
        await soloRun();

        expect(game.savedRuns).toHaveLength(1);
        const { teamKey, run } = game.savedRuns[0];
        // A party of one: the same shape a real party key would take, so it groups,
        // filters and prices (team size 1) alongside party runs
        expect(teamKey).toBe('Marketcow');
        expect(run.duration).toBe(300_000);
        expect(run.timestamp).toBe('2026-08-04T10:00:00.000Z');
        expect(run.validated).toBe(false);
        expect(run.source).toBe('tracker');
        expect(run.dungeonName).toBe('Chimerical Den');
        expect(run.tier).toBe(1);
    });

    test('a party run whose key counts never arrived is not banked as solo', async () => {
        // The failure this closes: chat is the only thing that used to say a run
        // was in a party, so a party run whose "Key counts" messages never reached
        // this client — page loaded after them, party channel muted, scan raced
        // them — banked as solo. That filed a party's pace under a one-name team
        // key nothing will ever match, and put party clears into the solo average.
        await soloRun({ players: [{ character: { name: 'Marketcow' } }, { character: { name: 'Alice' } }] });

        expect(game.savedRuns).toEqual([]);
    });

    test('a run whose fight never said who was in it is not banked', async () => {
        // No roster and no key counts is not evidence of solitude, only of
        // silence, and a run banked as solo on silence cannot be un-mislabelled
        await soloRun({ players: [] });

        expect(game.savedRuns).toEqual([]);
    });

    test('a run parked before rosters were recorded learns one from the battle that resumes it', async () => {
        // An in-progress record written by the version before `partyNames` has
        // none, and the message that restores it is holding the roster the record
        // lacks. Thrown away, a run resumed onto its last wave never sees another
        // `new_battle` — and a solo run that cannot say who was in it is refused,
        // so the upgrade silently eats the run in progress across it.
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-08-04T10:00:00.000Z'));
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 1,
            startTime: Date.parse('2026-08-04T09:55:00.000Z'),
            currentWave: 10,
            maxWaves: 10,
            wavesCompleted: 9,
            waveTimes: [],
            keyCountsMap: null,
            lastUpdateTime: Date.now(),
            // No `partyNames`: this record predates them
        });

        await tracker.onNewBattle({
            wave: 10,
            battleId: 42,
            combatStartTime: '2026-08-04T09:55:00.000Z',
            players: [{ character: { name: 'Marketcow' } }],
        });
        await flush();

        expect(tracker.currentRun.partyNames).toEqual(['Marketcow']);

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 10, isDone: true } });
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].teamKey).toBe('Marketcow');
    });

    test('a hibernated run is not saved: the wall clock is all it has', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-08-04T10:00:00.000Z'));
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T09:00:00.000Z' });
        await flush();
        tracker.hibernationDetected = true;
        tracker.currentRun.hibernationDetected = true;
        tracker.currentRun.wavesCompleted = 9;
        tracker.currentRun.currentWave = 10;
        vi.setSystemTime(Date.parse('2026-08-04T14:00:00.000Z')); // four hours of sleep in the middle
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 10, isDone: true } });
        await flush();

        expect(game.savedRuns).toEqual([]);
    });

    test('with no character name to record it under, nothing is saved', async () => {
        game.characterName = null;
        await soloRun();
        expect(game.savedRuns).toEqual([]);
    });

    test('a party run still wins on the server’s own timestamps', async () => {
        beTracking({
            waveTimes: [3000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].teamKey).toBe('Alice,Bob');
        expect(game.savedRuns[0].run.duration).toBe(272_000);
        expect(game.savedRuns[0].run.validated).toBe(true);
    });
});

describe('recovering a partial party run’s start from chat', () => {
    // A 65-wave dungeon so the live case — a refresh at wave 48 — can be played
    // out at the wave numbers it actually happens at.
    const MAX_WAVES = 65;
    const RUN_MS = 1_800_000; // half an hour, six times over in history
    const WAVE_MS = RUN_MS / MAX_WAVES; // ~27.7s
    const NOW = Date.parse('2026-08-04T12:00:00.000Z');
    /** Stored cumulative at wave 47 — where a run on wave 48 has got to */
    const AT_WAVE_47 = WAVE_MS * 47;

    function history(count = 6) {
        return Array.from({ length: count }, (_, i) => ({
            dungeonName: 'Chimerical Den',
            tier: 1,
            duration: RUN_MS,
            waveTimes: Array.from({ length: MAX_WAVES }, () => WAVE_MS),
            avgWaveTime: WAVE_MS,
            timestamp: new Date(NOW - (i + 1) * 86_400_000).toISOString(),
        }));
    }

    /** The refresh: tracking picks the run up at wave 48, then scans the chat. */
    async function joinAtWave48({ anchorAgoMs = null, runs = history() } = {}) {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.dungeonInfo[DEN] = { name: 'Chimerical Den', maxWaves: MAX_WAVES };
        game.historyRuns = runs;
        beTracking({
            tier: 1,
            startTime: NOW - 40_000, // we noticed forty seconds ago
            currentWave: 48,
            maxWaves: MAX_WAVES,
            wavesCompleted: 0,
            joinedMidRun: true,
            joinedAtWave: 48,
        });
        tracker.recentChatMessages =
            anchorAgoMs === null
                ? []
                : [
                      {
                          m: 'systemChatMessage.partyKeyCount',
                          t: new Date(NOW - anchorAgoMs).toISOString(),
                          systemMetadata: JSON.stringify({
                              keyCountString: 'Key counts: [Alice - 12], [Marketcow - 8]',
                          }),
                      },
                  ];
        tracker.scanExistingChatMessages();
        await flush();
    }

    test('a plausible recent key count gives the run its real start back', async () => {
        // Twenty-two minutes in at wave 48, against a history that reaches wave 47
        // in about twenty-one and a half.
        await joinAtWave48({ anchorAgoMs: 1_320_000 });

        expect(tracker.currentRun.startRecovered).toBe(true);
        expect(tracker.currentRun.recoveredStartTime).toBe(NOW - 1_320_000);

        const run = tracker.getCurrentRun();
        // A real elapsed, from the server's own timestamp — not the forty seconds
        // we happen to have been watching
        expect(run.totalElapsed).toBe(1_320_000);
        expect(run.elapsedIsSinceNoticed).toBe(false);
        expect(run.startRecovered).toBe(true);
    });

    test('and banks on completion with the server-derived duration', async () => {
        await joinAtWave48({ anchorAgoMs: 1_320_000 });
        tracker.currentRun.wavesCompleted = MAX_WAVES - 1;
        tracker.currentRun.currentWave = MAX_WAVES;

        // The party's completion "Key counts", five minutes later
        vi.setSystemTime(NOW + 300_000);
        tracker.onChatMessage(
            keyCountsData(new Date(NOW + 300_000).toISOString(), 'Key counts: [Alice - 11], [Marketcow - 7]')
        );
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        const { teamKey, run } = game.savedRuns[0];
        expect(teamKey).toBe('Alice,Marketcow');
        expect(run.duration).toBe(1_320_000 + 300_000);
        expect(run.timestamp).toBe(new Date(NOW - 1_320_000).toISOString());
        expect(run.validated).toBe(true);
        expect(run.source).toBe('chat');
        // The tail's wave times are the hard late waves; banking them would bias
        // the wave average and misplace a wave-48 split as wave 1
        expect(run.waveTimes).toEqual([]);
        expect(run.avgWaveTime).toBe(0);
    });

    test('with no chat evidence at all the run stays partial and is not banked', async () => {
        await joinAtWave48({ anchorAgoMs: null });

        expect(tracker.currentRun.startRecovered).toBeUndefined();
        expect(tracker.firstKeyCountTimestamp).toBeNull();
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(true);
        expect(tracker.getCurrentRun().totalElapsed).toBe(40_000);

        tracker.currentRun.wavesCompleted = MAX_WAVES - 1;
        tracker.currentRun.currentWave = MAX_WAVES;
        tracker.currentRun.keyCountsMap = { Alice: 12, Marketcow: 8 };
        vi.setSystemTime(NOW + 300_000);
        tracker.onChatMessage(
            keyCountsData(new Date(NOW + 300_000).toISOString(), 'Key counts: [Alice - 11], [Marketcow - 7]')
        );
        await flush();

        expect(game.savedRuns).toEqual([]);
    });

    test('an implausibly old anchor is refused: no dungeon takes three hours', async () => {
        // A chat log left open over lunch — the newest key count belongs to a run
        // that finished long ago.
        await joinAtWave48({ anchorAgoMs: 3 * 60 * 60 * 1000 });

        expect(tracker.currentRun.startRecovered).toBeUndefined();
        const run = tracker.getCurrentRun();
        expect(run.elapsedIsSinceNoticed).toBe(true);
        expect(run.totalElapsed).toBe(40_000);
    });

    test('with no history the fallback bound still refuses an hour-old anchor', async () => {
        await joinAtWave48({ anchorAgoMs: 60 * 60 * 1000, runs: [] });

        expect(tracker.currentRun.startRecovered).toBeUndefined();
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(true);
    });

    test('an anchor inconsistent with the waves done is refused', async () => {
        // Forty-four minutes: inside the plausible bound (1.5× a thirty-minute
        // run), but more than twice the ~21.5 minutes history reaches wave 47 in.
        // This is what an anchor one run too early looks like.
        expect(2_650_000).toBeLessThan(RUN_MS * 1.5);
        expect(2_650_000).toBeGreaterThan(AT_WAVE_47 * 2);
        await joinAtWave48({ anchorAgoMs: 2_650_000 });

        expect(tracker.currentRun.startRecovered).toBeUndefined();
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(true);
    });

    test('an anchor far too recent for the waves done is refused too', async () => {
        // Two minutes at wave 48 — an anchor from something that is not this run
        await joinAtWave48({ anchorAgoMs: 120_000 });

        expect(tracker.currentRun.startRecovered).toBeUndefined();
        expect(tracker.getCurrentRun().elapsedIsSinceNoticed).toBe(true);
    });

    test('the recovery rides along in the in-progress record and survives a refresh', async () => {
        await joinAtWave48({ anchorAgoMs: 1_320_000 });
        await tracker.saveInProgressRun();

        expect(stored().startRecovered).toBe(true);
        expect(stored().recoveredStartTime).toBe(NOW - 1_320_000);
        expect(stored().joinedMidRun).toBe(true);

        resetTracker();
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        const restored = await tracker.restoreInProgressRun(42);

        expect(restored).toBe(true);
        expect(tracker.joinedMidRun).toBe(true);
        expect(tracker.currentRun.startRecovered).toBe(true);
        const run = tracker.getCurrentRun();
        expect(run.startRecovered).toBe(true);
        expect(run.elapsedIsSinceNoticed).toBe(false);
        expect(run.totalElapsed).toBe(1_320_000);
    });

    test('a solo run joined part-way is still refused — there is nothing to recover from', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.dungeonInfo[DEN] = { name: 'Chimerical Den', maxWaves: MAX_WAVES };
        game.historyRuns = history();
        beTracking({
            tier: 1,
            startTime: NOW - 40_000,
            currentWave: MAX_WAVES,
            maxWaves: MAX_WAVES,
            wavesCompleted: MAX_WAVES - 1,
            joinedMidRun: true,
            joinedAtWave: 48,
        });
        // Solo: no party chat at all, so nothing for the scan to anchor on
        tracker.recentChatMessages = [];
        tracker.scanExistingChatMessages();
        await flush();

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: MAX_WAVES, isDone: true } });
        await flush();

        expect(game.savedRuns).toEqual([]);
        expect(tracker.currentRun).toBeNull();
    });

    test('a run that was never partial is untouched by any of this', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.historyRuns = history();
        beTracking({
            waveTimes: [3000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });

        expect(tracker.getCurrentRun().startRecovered).toBe(false);

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].run.duration).toBe(272_000);
        expect(game.savedRuns[0].run.validated).toBe(true);
        expect(game.savedRuns[0].run.waveTimes).toEqual([3000]);
    });
});

describe('a character switch inside completeDungeon', () => {
    // `completeDungeon` reads the hibernation flag and the solo character's name
    // before its awaits, but the *recorder stamp* is read inside
    // `dungeonTrackerStorage.saveTeamRun`, which is called after
    // `clearInProgressRun`'s storage round trip. A switch landing in that gap
    // stamps this run with the arriving character: it vanishes from the history
    // of whoever ran it and appears, permanently, under one who was never in it.

    /** Flip the character part-way through the completion's storage clear. */
    function switchInsideTheClear(newId, newName) {
        mockStorage.delete.mockImplementationOnce(async (key, storeName = 'settings') => {
            mockStorage.storeFor(storeName).delete(key);
            game.characterId = newId;
            game.characterName = newName;
            return true;
        });
    }

    test('a party run completing across a switch is not banked under the arriving character', async () => {
        beTracking({
            waveTimes: [3000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        switchInsideTheClear('iron456', 'Ironcow');

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(game.savedRuns).toEqual([]);
    });

    test('a solo run completing across a switch is not banked under the arriving character', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-08-04T10:00:00.000Z'));
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        await tracker.onNewBattle({ wave: 1, battleId: 42, combatStartTime: '2026-08-04T09:00:00.000Z' });
        await flush();
        tracker.currentRun.currentWave = 10;
        tracker.currentRun.wavesCompleted = 9;
        vi.setSystemTime(Date.parse('2026-08-04T10:05:00.000Z'));
        switchInsideTheClear('iron456', 'Ironcow');

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 10, isDone: true } });
        await flush();

        expect(game.savedRuns).toEqual([]);
    });

    test('with nobody switching the run is banked as before', async () => {
        beTracking({
            waveTimes: [3000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(game.savedRuns).toHaveLength(1);
    });
});
