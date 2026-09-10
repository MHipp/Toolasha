/** @vitest-environment happy-dom
 *
 * A teardown landing inside the collapse-state read.
 *
 * `initialize()`'s docstring claimed the `if (this._initialized) return` guard
 * closed the duplicate-`setInterval` / duplicate-`character_initialized` leak
 * it describes. It closes only same-tick re-entrancy: `_initialized` is set
 * *before* `await storage.get('queueMonitor_collapsed', …)`, and `disable()`
 * clears it, so a teardown landing inside that read leaves the suspended call
 * to resume past a guard that is no longer set and register a second interval
 * and a second `character_initialized` listener anyway. Only the most recently
 * stored handle can ever be torn down, so the earlier pair redraws the panel
 * for the rest of the session — exactly the leak the docstring said was
 * handled.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the collapse-state read */
    gate: null,
    characterId: 'char1',
}));

/** Live registrations, so leaks are countable. */
const live = vi.hoisted(() => ({ charInit: [], intervals: 0 }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        on: (event, handler) => {
            if (event === 'character_initialized') live.charInit.push(handler);
        },
        off: (event, handler) => {
            if (event === 'character_initialized') live.charInit = live.charInit.filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => {
            // The one read initialize() parks on
            if (world.gate) await world.gate;
            return false;
        },
        set: async () => {},
    },
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 100 } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('./queue-snapshot.js', () => ({ default: { getOtherCharacterSnapshots: () => [] } }));

const queueMonitorUI = (await import('./queue-monitor-ui.js')).default;

describe('a teardown landing inside the collapse-state read', () => {
    beforeEach(() => {
        queueMonitorUI.disable();
        world.gate = null;
        world.characterId = 'char1';
        live.charInit = [];
        live.intervals = 0;
        // Count every interval the module arms, and every one it clears, so a
        // redraw loop nothing holds a handle to is visible as a leak.
        vi.spyOn(globalThis, 'setInterval').mockImplementation(() => {
            live.intervals += 1;
            return live.intervals;
        });
        vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {
            live.intervals -= 1;
        });
    });

    afterEach(() => {
        queueMonitorUI.disable();
        vi.restoreAllMocks();
    });

    /**
     * Start an initialize() whose collapse-state read is held open, tear the
     * panel down inside it, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function teardownDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = queueMonitorUI.initialize();
        queueMonitorUI.disable();
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await teardownDuringInitialize();

        expect(live.charInit).toHaveLength(0);
        expect(live.intervals).toBe(0);
        expect(document.getElementById('toolasha-queue-monitor')).toBeNull();
        // No flag left set, so the re-initialise below actually runs
        expect(queueMonitorUI._initialized).toBe(false);
    });

    test('a reconnect after the interrupted init leaves exactly one of each', async () => {
        await teardownDuringInitialize();

        await queueMonitorUI.initialize();

        expect(live.charInit).toHaveLength(1);
        expect(live.intervals).toBe(1);
    });

    test('the next teardown can remove everything the reconnect registered', async () => {
        await teardownDuringInitialize();
        await queueMonitorUI.initialize();

        queueMonitorUI.disable();

        expect(live.charInit).toHaveLength(0);
        expect(live.intervals).toBe(0);
    });
});
