/** @vitest-environment happy-dom */

/**
 * The reroll ledger is one character's spend.
 *
 * Under a bare key the market cow's gold rerolls and the iron cow's cowbell
 * rerolls landed in the same map, keyed only by task id — and task ids do not
 * say whose task they were. These cover the scoping, and the one-time adoption
 * of the pre-scoping record: a merged map cannot be partitioned after the fact,
 * so the whole of it goes to the main character rather than being split by a
 * guess or thrown away.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const mock = {
        stores,
        storeFor,
        unavailable: false,
        reset: () => {
            stores.clear();
            mock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (mock.unavailable) return null;
            const held = storeFor(store).get(key);
            return held === undefined || held === null
                ? { found: false, value: null }
                : { found: true, value: structuredClone(held) };
        }),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null ? fallback : held;
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (mock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, value);
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
    return mock;
});

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => game.gameMode,
        getInitClientData: () => ({}),
        characterData: null,
        characterQuests: [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_TEXT_SECONDARY: '#888' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const { default: tracker } = await import('./task-reroll-tracker.js');
const { default: dataManager } = await import('../../core/data-manager.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const spend = () => storageMock.storeFor('rerollSpending');

beforeEach(() => {
    storageMock.reset();
    game.characterId = 'market123';
    game.gameMode = 'standard';
    _resetAdoptionCache();
    tracker.taskRerollData.clear();
    tracker.dataRecord.reset();
    tracker.historyRecord.reset();
    dataManager.characterData = null;
    dataManager.characterQuests = [];
});

/**
 * Retirement reads the live quest list.
 *
 * `characterData.characterQuests` is the array as it stood when the character
 * loaded; the claimed-quest filter rebinds `characterQuests` to a new one, so
 * the snapshot stops moving after the first claim. Reading it retired every
 * task drawn afterwards.
 */
describe('retiring tasks against the live quest list', () => {
    test('a task the snapshot never saw is not retired', () => {
        const stale = [{ id: 1 }];
        // The character loaded with task 1; a claim rebound the live list and
        // task 7 was drawn since. The snapshot still holds only task 1.
        dataManager.characterData = { characterQuests: stale };
        dataManager.characterQuests = [{ id: 7 }];
        tracker.taskRerollData.set(7, { coinRerollCount: 3, cowbellRerollCount: 0 });

        tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });

    test('a task gone from the live list is still retired', () => {
        dataManager.characterQuests = [{ id: 7 }];
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0 });

        tracker.cleanupOldTasks();

        expect([...tracker.taskRerollData.keys()]).toEqual([7]);
    });

    test('a task the server named moments ago survives a list that has not caught up', () => {
        dataManager.characterQuests = [];
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0, seenAt: Date.now() });

        tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });

    test('the grace runs out, and a long-unseen task retires', () => {
        dataManager.characterQuests = [];
        tracker.taskRerollData.set(7, {
            coinRerollCount: 1,
            cowbellRerollCount: 0,
            seenAt: Date.now() - 60 * 60 * 1000,
        });

        tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(false);
    });

    test('no quest list at all retires nothing', () => {
        dataManager.characterQuests = null;
        tracker.taskRerollData.set(7, { coinRerollCount: 1, cowbellRerollCount: 0 });

        tracker.cleanupOldTasks();

        expect(tracker.taskRerollData.has(7)).toBe(true);
    });
});

describe('scoping', () => {
    test('a load reads this character’s map, not another’s', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        spend().set('taskRerollData_iron456', { 9: { coinRerollCount: 7, cowbellRerollCount: 0 } });

        await tracker.loadFromStorage();

        expect([...tracker.taskRerollData.keys()]).toEqual([1]);
    });

    test('a save writes under the key of whoever is current, resolved at write time', async () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        game.characterId = 'iron456';
        tracker.taskRerollData.clear();
        tracker.taskRerollData.set(9, { coinRerollCount: 1, cowbellRerollCount: 0 });
        await tracker.saveToStorage();

        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);
        expect(Object.keys(spend().get('taskRerollData_iron456'))).toEqual(['9']);
    });

    test('the history is scoped the same way', async () => {
        await tracker.appendToHistory([{ taskId: 1, goldSpent: 10000 }]);

        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });
});

describe('adopting the pre-scoping record', () => {
    test('the main character inherits the merged map exactly once', async () => {
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.get(1)).toEqual({ coinRerollCount: 3, cowbellRerollCount: 1 });
        expect(spend().get('taskRerollData_market123')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData')).toBe(false);
    });

    test('the history is adopted alongside it', async () => {
        spend().set('taskRerollHistory', [{ taskId: 1, goldSpent: 10000 }]);

        expect(await tracker.loadHistory()).toEqual([{ taskId: 1, goldSpent: 10000 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        expect(spend().has('taskRerollHistory')).toBe(false);
    });

    test('an iron cow starts clean and leaves the legacy record for the main', async () => {
        game.characterId = 'iron456';
        game.gameMode = 'ironcow';
        spend().set('taskRerollData', { 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });

        await tracker.loadFromStorage();

        expect(tracker.taskRerollData.size).toBe(0);
        expect(spend().get('taskRerollData')).toEqual({ 1: { coinRerollCount: 3, cowbellRerollCount: 1 } });
        expect(spend().has('taskRerollData_iron456')).toBe(false);
    });
});

describe('cleanup', () => {
    test('drops the map, so the next character does not save this one’s rows', () => {
        tracker.taskRerollData.set(1, { coinRerollCount: 2, cowbellRerollCount: 0 });

        tracker.cleanup();

        expect(tracker.taskRerollData.size).toBe(0);
    });
});

describe('the stored records survive a read that cannot be made', () => {
    test('a load while storage is unreadable keeps the map in hand, not an empty one', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        tracker.taskRerollData.set(5, { coinRerollCount: 1, cowbellRerollCount: 0 });
        storageMock.unavailable = true;

        await tracker.loadFromStorage();

        expect([...tracker.taskRerollData.keys()]).toEqual([5]);
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);
    });

    test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
        spend().set('taskRerollData_market123', { 1: { coinRerollCount: 2, cowbellRerollCount: 0 } });
        storageMock.unavailable = true;
        tracker.taskRerollData.set(5, { coinRerollCount: 1, cowbellRerollCount: 0 });

        await tracker.saveToStorage();
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1']);

        storageMock.unavailable = false;
        await tracker.saveToStorage();
        // Never read back, so the stored row is kept alongside the new one
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['1', '5']);
    });

    test('once read back, a task dropped from the map stays dropped', async () => {
        spend().set('taskRerollData_market123', {
            1: { coinRerollCount: 2, cowbellRerollCount: 0 },
            2: { coinRerollCount: 1, cowbellRerollCount: 0 },
        });
        await tracker.loadFromStorage();
        tracker.taskRerollData.delete(1);

        await tracker.saveToStorage();
        expect(Object.keys(spend().get('taskRerollData_market123'))).toEqual(['2']);
    });

    test('an append to the history folds in what another tab retired, by task', async () => {
        await tracker.appendToHistory([{ taskId: 1, retiredAt: 10, goldSpent: 100 }]);
        spend().set('taskRerollHistory_market123', [
            { taskId: 1, retiredAt: 10, goldSpent: 100 },
            { taskId: 2, retiredAt: 20, goldSpent: 200 },
        ]);

        await tracker.appendToHistory([{ taskId: 3, retiredAt: 30, goldSpent: 300 }]);

        expect(
            spend()
                .get('taskRerollHistory_market123')
                .map((entry) => entry.taskId)
        ).toEqual([1, 2, 3]);
        expect(await tracker.loadHistory()).toHaveLength(3);
    });

    test('an append while storage is unreadable is kept in hand and lands with the next one', async () => {
        spend().set('taskRerollHistory_market123', [{ taskId: 1, retiredAt: 10, goldSpent: 100 }]);
        storageMock.unavailable = true;

        await tracker.appendToHistory([{ taskId: 2, retiredAt: 20, goldSpent: 200 }]);
        expect(spend().get('taskRerollHistory_market123')).toHaveLength(1);
        // And a read that cannot be made does not hand back an empty history
        expect((await tracker.loadHistory()).map((entry) => entry.taskId)).toEqual([2]);

        storageMock.unavailable = false;
        await tracker.appendToHistory([{ taskId: 3, retiredAt: 30, goldSpent: 300 }]);
        expect(
            spend()
                .get('taskRerollHistory_market123')
                .map((entry) => entry.taskId)
        ).toEqual([1, 2, 3]);
    });

    test('the history stays capped after a fold', async () => {
        const many = Array.from({ length: 500 }, (_, i) => ({ taskId: i + 1, retiredAt: i + 1 }));
        spend().set('taskRerollHistory_market123', many);

        await tracker.appendToHistory([{ taskId: 9001, retiredAt: 9001 }]);

        const saved = spend().get('taskRerollHistory_market123');
        expect(saved).toHaveLength(500);
        expect(saved.at(-1).taskId).toBe(9001);
        expect(saved[0].taskId).toBe(2);
    });
});

describe('a cross-device sync pull combines the retired-task history', () => {
    test('the registered merge is the union by task, not the downloaded copy', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

        // Both key shapes the record can be stored under: the scoped one every
        // account writes today, and the bare pre-scoping key still sitting on
        // accounts that never triggered the adoption
        for (const key of ['taskRerollHistory', 'taskRerollHistory_market123']) {
            const registration = mergeForKey('rerollSpending', key);
            expect(registration, `rerollSpending/${key} has no sync merge`).toBeTruthy();

            // This device retired task 1; the phone retired task 2. A whole-key
            // write would leave the pull with only the phone's row, and the
            // gold spent on task 1 would simply stop having been spent
            const local = [{ taskId: 1, retiredAt: 10, goldSpent: 10000 }];
            const incoming = [{ taskId: 2, retiredAt: 20, goldSpent: 20000 }];

            expect(registration.merge(local, incoming).map((entry) => entry.taskId)).toEqual([1, 2]);
        }
    });

    test('the live reroll map is deliberately not merged', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        // Curated: a task is dropped from it on purpose when it retires, so a
        // union would resurrect rows the tracker has finished with
        expect(mergeForKey('rerollSpending', 'taskRerollData_market123')).toBeNull();
    });
});
