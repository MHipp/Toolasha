/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is
 * parked on the batched startup read (the protected list, the panel
 * position, and the six cap records).
 *
 * `isInitialized` is set *before* that read, so the switch's own
 * re-initialise never early-returned — the interrupted call simply resumed
 * after `cleanup()` had emptied `unregisterHandlers`, and pushed its own
 * panel/board/quest/click registrations into the emptied array with no
 * handle left to remove them by. Three of the four redo idempotent work and
 * self-heal at the next switch's teardown, but the duplicated
 * `document.addEventListener('click', spendHandler, true)` is not: a real
 * click on the highlighted spend button calls `_manualPressed()` once per
 * leaked listener, visibly double-advancing the walk on a single press.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the startup read */
    gate: null,
    characterId: 'char1',
}));

/** Live domObserver / board-watcher registrations, by name, so leaks are countable. */
const registrations = vi.hoisted(() => ({ live: [] }));
/** Live `quests_updated` websocket listeners */
const ws = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_ACCENT: '#8ecfff',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.characterId, getMooPassBuffs: () => [] },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            registrations.live.push(name);
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => {
        registrations.live.push('BoardWatcher');
        return () => {
            const at = registrations.live.indexOf('BoardWatcher');
            if (at !== -1) registrations.live.splice(at, 1);
        };
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            (ws.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            ws.handlers[event] = (ws.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: async () => null,
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char`,
    readScopedFrom: async (_base, _map, _store, fallback) => fallback,
}));
vi.mock('./task-sorter.js', () => ({ default: { sortTasks: () => {} } }));
vi.mock('./task-profit-calculator.js', () => ({ getCowbellValue: () => 8000 }));
vi.mock('./task-card-state.js', () => ({ cardTaskKey: () => '' }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-reroll-protection.js', () => ({ default: { protection: { protectedHrids: new Set() } } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getMany: async (keys) => {
            // The one read initialize() parks on
            if (world.gate) await world.gate;
            return new Map(keys.map((key) => [key, null]));
        },
        parseJSON: (raw, _key, fallback = null) => (raw === null ? fallback : raw),
    },
}));

const { default: taskRerollWalkFeature } = await import('./task-reroll-walk.js');
const walk = taskRerollWalkFeature.walk;

describe('a character switch landing inside the startup read', () => {
    beforeEach(() => {
        walk.cleanup();
        world.gate = null;
        world.characterId = 'char1';
        registrations.live = [];
        ws.handlers = {};
        document.body.innerHTML = '';
    });

    afterEach(() => {
        walk.cleanup();
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = taskRerollWalkFeature.initialize();
        // `character_switching` — the feature layer comes down mid-read
        walk.cleanup();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(registrations.live).toEqual([]);
        expect(ws.handlers['quests_updated'] ?? []).toEqual([]);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await taskRerollWalkFeature.initialize();

        expect(registrations.live.sort()).toEqual(['BoardWatcher', 'TaskRerollWalk-Panel'].sort());
        expect(ws.handlers['quests_updated']).toHaveLength(1);

        // …and that one set is the one the teardown can remove
        walk.cleanup();
        expect(registrations.live).toEqual([]);
        expect(ws.handlers['quests_updated'] ?? []).toEqual([]);
    });

    test('one real click after an interrupted init calls _manualPressed exactly once', async () => {
        // A synthetic DOM dispatch always reports `isTrusted: false`, which the
        // listener bails out on regardless of how many copies are live — so the
        // leak is exercised directly: every `document.addEventListener('click',
        // …, true)` the walk made is captured here, and a single *trusted*
        // click is simulated by invoking each of them once, the way the browser
        // would for one real press.
        const clickHandlers = [];
        const originalAdd = document.addEventListener.bind(document);
        const originalRemove = document.removeEventListener.bind(document);
        const addSpy = vi.spyOn(document, 'addEventListener').mockImplementation((type, handler, options) => {
            if (type === 'click' && options === true) clickHandlers.push(handler);
            return originalAdd(type, handler, options);
        });
        const removeSpy = vi.spyOn(document, 'removeEventListener').mockImplementation((type, handler, options) => {
            if (type === 'click' && options === true) {
                const at = clickHandlers.indexOf(handler);
                if (at !== -1) clickHandlers.splice(at, 1);
            }
            return originalRemove(type, handler, options);
        });

        try {
            for (let i = 0; i < 3; i++) await switchDuringInitialize();
            // The switch's own re-initialise, which the flag never blocked
            await taskRerollWalkFeature.initialize();

            const manualPressed = vi.spyOn(walk, '_manualPressed').mockImplementation(() => {});
            walk.state = 'ready';
            const button = document.createElement('button');
            document.body.appendChild(button);
            walk.step = { manual: true, card: null, signature: '' };
            walk._buttonFor = () => button;

            const trustedClick = { isTrusted: true, target: button };
            for (const handler of [...clickHandlers]) handler(trustedClick);

            expect(manualPressed).toHaveBeenCalledTimes(1);
        } finally {
            addSpy.mockRestore();
            removeSpy.mockRestore();
        }
    });
});
