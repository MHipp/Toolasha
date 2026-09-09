import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    characterId: 'char1',
    saved: {},
    unavailable: false,
    clientData: { combatMonsterDetailMap: {}, skillDetailMap: {} },
    wsHandlers: {},
    // Set to a promise to hold every storage read open, so a test can land a
    // teardown inside the read the way a character switch does
    gate: null,
}));

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
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, defaultValue) => game.saved[key] ?? defaultValue,
        tryGet: async (key) => {
            if (game.gate) await game.gate;
            if (game.unavailable) return null;
            return game.saved[key] != null
                ? { found: true, value: structuredClone(game.saved[key]) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            if (game.unavailable) return false;
            game.saved[key] = structuredClone(value);
            return true;
        },
        delete: async (key) => {
            delete game.saved[key];
            return true;
        },
        getAllKeys: async () => Object.keys(game.saved),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => game.clientData,
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));

const { default: labyrinthTracker, mergeBestLevels } = await import('./labyrinth-tracker.js');

function combatRoom(overrides = {}) {
    return {
        roomType: '/labyrinth_room_types/combat',
        isCleared: false,
        entryCount: 1,
        monsterHrid: '/monsters/chimerical_beast',
        recommendedLevel: 40,
        ...overrides,
    };
}

describe('labyrinth tracker', () => {
    beforeEach(() => {
        game.setting = true;
        game.characterId = 'char1';
        game.saved = {};
        game.unavailable = false;
        game.clientData = { combatMonsterDetailMap: {}, skillDetailMap: {} };
        game.wsHandlers = {};
        game.gate = null;
        labyrinthTracker.disable();
        labyrinthTracker.monsterBestLevels = {};
    });

    test('disabled by setting, initialize does not subscribe', async () => {
        game.setting = false;
        await labyrinthTracker.initialize();

        expect(game.wsHandlers.labyrinth_updated).toBeUndefined();
    });

    test('the first update is only a snapshot — nothing to diff against yet', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom()]] } });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBeNull();
    });

    test('a room going from entered-uncleared to cleared records a best level', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom()]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(40);
    });

    test('a shrouded room that jumps straight to cleared without ever being entered is not recorded', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ entryCount: 0 })]] },
        });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ entryCount: 0, isCleared: true })]] },
        });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBeNull();
    });

    test('a first-try win whose entry and clear land in the same update is still recorded', async () => {
        // A room revealed but not yet entered (entryCount 0), then in the very next
        // update it is both entered AND cleared in one shot — the entry and the
        // clear landed in the same websocket payload rather than across two. The
        // outcome log's own guard treats the CURRENT room's entryCount as proof of
        // entry for exactly this case; the best-level tracker must too.
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ entryCount: 0 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ entryCount: 1, isCleared: true })]] },
        });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(40);
    });

    test('a lower recommendedLevel clear does not overwrite a recorded best', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 60 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 60, isCleared: true })]] },
        });
        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(60);

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 30 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 30, isCleared: true })]] },
        });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(60);
    });

    test('a higher recommendedLevel clear does overwrite the recorded best', async () => {
        await labyrinthTracker.initialize();
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 30 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 30, isCleared: true })]] },
        });

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 55 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 55, isCleared: true })]] },
        });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(55);
    });

    test('a missing recommendedLevel is looked up from game data', async () => {
        game.clientData.combatMonsterDetailMap['/monsters/chimerical_beast'] = {
            name: 'Chimerical Beast',
            recommendedLevel: 45,
        };
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: undefined })]] },
        });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: undefined, isCleared: true })]] },
        });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(45);
    });

    test('a room with no resolvable hrid or level is skipped without throwing', async () => {
        await labyrinthTracker.initialize();

        expect(() => {
            game.wsHandlers.labyrinth_updated({
                labyrinth: { roomData: [[combatRoom({ monsterHrid: undefined, recommendedLevel: undefined })]] },
            });
            game.wsHandlers.labyrinth_updated({
                labyrinth: {
                    roomData: [[combatRoom({ monsterHrid: undefined, recommendedLevel: undefined, isCleared: true })]],
                },
            });
        }).not.toThrow();
    });

    test('a skilling room is tracked the same way as combat', async () => {
        await labyrinthTracker.initialize();
        const skillRoom = (overrides) => ({
            roomType: '/labyrinth_room_types/skilling',
            isCleared: false,
            entryCount: 1,
            skillHrid: '/skills/milking',
            recommendedLevel: 20,
            ...overrides,
        });

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[skillRoom()]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[skillRoom({ isCleared: true })]] } });

        expect(labyrinthTracker.getBestLevel('/skills/milking')).toBe(20);
    });

    test('a room that was already cleared before this session is not double-recorded', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBeNull();
    });

    test('update listeners fire on a new best and can be unsubscribed', async () => {
        await labyrinthTracker.initialize();
        const cb = vi.fn();
        labyrinthTracker.onUpdate(cb);

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom()]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });
        expect(cb).toHaveBeenCalledTimes(1);

        labyrinthTracker.offUpdate(cb);
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 90 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 90, isCleared: true })]] },
        });
        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('a listener that throws does not stop the others from being notified', async () => {
        await labyrinthTracker.initialize();
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        const good = vi.fn();
        labyrinthTracker.onUpdate(bad);
        labyrinthTracker.onUpdate(good);

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom()]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });

        expect(good).toHaveBeenCalled();
    });

    test('best levels persist across a load, scoped per character', async () => {
        game.saved['monsterBestLevels_char1'] = {
            '/monsters/chimerical_beast': { name: 'Chimerical Beast', bestLevel: 70 },
        };

        await labyrinthTracker.initialize();

        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(70);
    });

    test('a recorded clear is persisted to storage under the character-scoped key', async () => {
        await labyrinthTracker.initialize();

        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom()]] } });
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ isCleared: true })]] } });
        // The write probes storage first, so it lands a tick later
        await labyrinthTracker.record.flushed();

        expect(game.saved['monsterBestLevels_char1']['/monsters/chimerical_beast'].bestLevel).toBe(40);
    });

    test('an update with no roomData is ignored', async () => {
        await labyrinthTracker.initialize();

        expect(() => game.wsHandlers.labyrinth_updated({ labyrinth: {} })).not.toThrow();
        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBeNull();
    });
});

describe('the best levels survive a failed read and a second tab', () => {
    const KEY = 'monsterBestLevels_char1';
    const best = (level) => ({ name: 'Beast', bestLevel: level });

    beforeEach(() => {
        game.saved = {};
        game.unavailable = false;
        labyrinthTracker.disable();
    });

    test('the merge keeps the higher level per monster', () => {
        expect(mergeBestLevels({ a: best(10), b: best(5) }, { a: best(7), c: best(1) })).toEqual({
            a: best(10),
            b: best(5),
            c: best(1),
        });
        expect(mergeBestLevels(null, { a: best(2) })).toEqual({ a: best(2) });
    });

    test('a load that cannot read storage keeps the levels in memory', async () => {
        labyrinthTracker.monsterBestLevels = { '/monsters/a': best(40) };
        game.unavailable = true;

        await labyrinthTracker.loadData();

        expect(labyrinthTracker.getBestLevel('/monsters/a')).toBe(40);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        game.saved[KEY] = { '/monsters/a': best(50) };
        labyrinthTracker.monsterBestLevels = { '/monsters/b': best(10) };
        game.unavailable = true;

        expect(await labyrinthTracker.saveData()).toBe(false);

        expect(game.saved[KEY]).toEqual({ '/monsters/a': best(50) });
    });

    test('a save folds in what another tab stored, the higher level winning', async () => {
        game.saved[KEY] = { '/monsters/a': best(50), '/monsters/c': best(5) };
        labyrinthTracker.monsterBestLevels = { '/monsters/a': best(30), '/monsters/b': best(10) };

        await labyrinthTracker.saveData();

        expect(game.saved[KEY]).toEqual({ '/monsters/a': best(50), '/monsters/b': best(10), '/monsters/c': best(5) });
        expect(labyrinthTracker.getBestLevel('/monsters/a')).toBe(50);
    });

    test('once storage reads again the next save lands everything', async () => {
        game.unavailable = true;
        labyrinthTracker.monsterBestLevels = { '/monsters/a': best(30) };
        await labyrinthTracker.saveData();
        expect(game.saved[KEY]).toBeUndefined();

        game.unavailable = false;
        labyrinthTracker.monsterBestLevels['/monsters/b'] = best(10);
        await labyrinthTracker.saveData();

        expect(game.saved[KEY]).toEqual({ '/monsters/a': best(30), '/monsters/b': best(10) });
    });
});

describe('a character switch landing inside the initial read', () => {
    beforeEach(() => {
        game.setting = true;
        game.characterId = 'char1';
        game.saved = {};
        game.unavailable = false;
        game.wsHandlers = {};
        game.gate = null;
        labyrinthTracker.disable();
        labyrinthTracker.monsterBestLevels = {};
    });

    /**
     * Start an initialize() whose storage read is held open, tear the feature
     * down inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        game.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = labyrinthTracker.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        labyrinthTracker.disable();
        // …and the arriving character is current before the read resolves
        game.characterId = 'char2';
        release();
        game.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves no initialized flag', async () => {
        await switchDuringInitialize();

        expect(game.wsHandlers.labyrinth_updated).toBeUndefined();
        expect(labyrinthTracker.isInitialized).toBe(false);
    });

    test('the arriving character gets a live tracker rather than one dead until reload', async () => {
        // Each character has their own recorded best, so whose the tracker is
        // holding says whether the re-initialise actually ran
        game.saved.monsterBestLevels_char1 = { '/monsters/chimerical_beast': { name: 'Beast', bestLevel: 40 } };
        game.saved.monsterBestLevels_char2 = { '/monsters/chimerical_beast': { name: 'Beast', bestLevel: 90 } };

        await switchDuringInitialize();

        // This is the `character_switched` re-initialise
        await labyrinthTracker.initialize();

        expect(labyrinthTracker.isInitialized).toBe(true);
        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(90);
        expect(typeof game.wsHandlers.labyrinth_updated).toBe('function');
        game.wsHandlers.labyrinth_updated({ labyrinth: { roomData: [[combatRoom({ recommendedLevel: 120 })]] } });
        game.wsHandlers.labyrinth_updated({
            labyrinth: { roomData: [[combatRoom({ recommendedLevel: 120, isCleared: true })]] },
        });
        expect(labyrinthTracker.getBestLevel('/monsters/chimerical_beast')).toBe(120);
    });
});
