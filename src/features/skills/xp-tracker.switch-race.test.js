/** @vitest-environment happy-dom
 *
 * A character switch tearing the tracker down while its initialize() is parked
 * on the character-init history read.
 *
 * `initialized` is set after that read, so a late assignment writes `true` over
 * the teardown that cleared it: the switch's own re-initialise then
 * early-returns at its own guard and no XP rate, time-till-level or month gain
 * is shown for the arriving character until the page is reloaded.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the history read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    characterData: null,
    handlers: new Map(),
    getCurrentCharacterId: () => dataManagerMock.characterId,
    on: (event, handler) => dataManagerMock.handlers.set(event, handler),
    off: (event, handler) => {
        if (dataManagerMock.handlers.get(event) === handler) dataManagerMock.handlers.delete(event);
    },
    getCharacterSkills: () => [],
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

const { xpTracker: tracker } = await import('./xp-tracker.js');

describe('a character switch landing inside the character-init history read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        dataManagerMock.characterData = null;
        dataManagerMock.handlers.clear();
        tracker.disable();
        tracker.characterId = null;
        wsMock.handlers.clear();
        observerMock.live = 0;
    });

    /**
     * Start an initialize() whose read is held open, tear the tracker down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        dataManagerMock.characterData = {
            character: { id: 'char1' },
            characterSkills: [{ skillHrid: '/skills/foraging', experience: 500 }],
        };
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = tracker.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        tracker.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        storageMock.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves the guard flag clear', async () => {
        await switchDuringInitialize();

        expect(observerMock.live).toBe(0);
        expect(tracker.unregisterObservers).toEqual([]);
        expect(dataManagerMock.handlers.size).toBe(0);
        expect(wsMock.handlers.size).toBe(0);
        expect(tracker.initialized).toBe(false);
    });

    test("the arriving character's XP history is readable afterwards, not a tracker dead until reload", async () => {
        const now = Date.now();
        storageMock.stored.xpHistory_char2 = {
            2: [
                { t: now - 2 * 60 * 60 * 1000, xp: 10000 },
                { t: now - 60 * 60 * 1000, xp: 20000 },
            ],
        };

        await switchDuringInitialize();
        dataManagerMock.characterData = {
            character: { id: 'char2' },
            characterSkills: [],
        };
        // This is the `character_switched` re-initialise
        await tracker.initialize();

        expect(tracker.initialized).toBe(true);
        expect(tracker.characterId).toBe('char2');
        // char2's own series, read back under char2's key — what the rate and
        // time-till-level readouts are computed from
        expect(tracker.xpHistory[2]?.at(-1)?.xp).toBe(20000);
        // …and the tooltip watcher registered after the read is live again
        expect(observerMock.live).toBeGreaterThan(0);
    });
});
