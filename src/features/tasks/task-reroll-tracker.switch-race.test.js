/** @vitest-environment happy-dom
 *
 * A character switch tearing the tracker down while its initialize() is parked
 * on the stored-data read.
 *
 * `isInitialized` is set after that read, so a late assignment writes `true`
 * over the teardown that cleared it: the switch's own re-initialise then
 * early-returns at its own guard and the arriving character's reroll spend goes
 * unrecorded until the page is reloaded.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the reroll-data read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
    on: () => {},
    off: () => {},
    characterData: null,
}));

const wsMock = vi.hoisted(() => ({ handlers: new Map() }));
const observerMock = vi.hoisted(() => ({ live: 0 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => wsMock.handlers.set(event, handler),
        off: (event, handler) => {
            if (wsMock.handlers.get(event) === handler) wsMock.handlers.delete(event);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => {
    const register = () => {
        observerMock.live += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            observerMock.live -= 1;
        };
    };
    return { default: { onClass: register, onReady: register } };
});
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_${dataManagerMock.characterId}`,
    readScoped: async () => null,
    writeScoped: async () => true,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (storageMock.gate) await storageMock.gate;
            return { found: key in storageMock.stored, value: storageMock.stored[key] };
        },
        get: async (key) => storageMock.stored[key] ?? null,
        set: async (key, value) => {
            storageMock.stored[key] = value;
            return true;
        },
    },
}));
vi.mock('../../utils/sync-merge-registry.js', () => ({ registerSyncMerge: () => {} }));

const { default: taskRerollTracker } = await import('./task-reroll-tracker.js');

describe('a character switch landing inside the stored-reroll-data read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        taskRerollTracker.disable();
        wsMock.handlers.clear();
        observerMock.live = 0;
        document.getElementById('mwi-task-action-min-height')?.remove();
    });

    /**
     * Start an initialize() whose read is held open, tear the tracker down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = taskRerollTracker.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        taskRerollTracker.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        storageMock.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves the guard flag clear', async () => {
        await switchDuringInitialize();

        expect(wsMock.handlers.size).toBe(0);
        expect(observerMock.live).toBe(0);
        expect(taskRerollTracker.unregisterHandlers).toEqual([]);
        expect(document.getElementById('mwi-task-action-min-height')).toBeNull();
        expect(taskRerollTracker.isInitialized).toBe(false);
    });

    test("the arriving character's reroll spend is loaded and recorded, not a tracker dead until reload", async () => {
        storageMock.stored.taskRerollData_char2 = {
            77: { coinRerollCount: 4, cowbellRerollCount: 1, goalCount: 10, seenAt: Date.now() },
        };

        await switchDuringInitialize();
        // This is the `character_switched` re-initialise
        await taskRerollTracker.initialize();

        expect(taskRerollTracker.isInitialized).toBe(true);
        // char2's own rows, read back under char2's key
        expect(taskRerollTracker.taskRerollData.get(77)).toMatchObject({ coinRerollCount: 4 });
        expect(observerMock.live).toBeGreaterThan(0);

        // …and the live listener is one this initialize registered, still recording
        const questsHandler = wsMock.handlers.get('quests_updated');
        expect(typeof questsHandler).toBe('function');
        questsHandler({ endCharacterQuests: [{ id: 88, coinRerollCount: 2, cowbellRerollCount: 0, goalCount: 5 }] });
        expect(taskRerollTracker.taskRerollData.get(88)).toMatchObject({ coinRerollCount: 2 });
    });
});
