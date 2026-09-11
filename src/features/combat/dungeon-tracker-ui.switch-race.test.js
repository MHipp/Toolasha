/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing the panel down while its initialize() is parked on
 * the saved-state read.
 *
 * `isInitialized` is set *before* that await, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `cleanup()`
 * had nulled every handler field and built a second `#mwi-dungeon-tracker`
 * container, a second `dungeonTracker.onUpdate` registration and a second 1 Hz
 * interval, storing each into the field the teardown had just cleared. Nothing
 * could unregister the pair that came before. One leak per switch, each an
 * IndexedDB read and a DOM write every second.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the state read */
    gate: null,
    /** Held open to park update() inside the stored-run read */
    runGate: null,
    characterId: 'char1',
    settings: { dungeonTrackerUI: true, dungeonPace: true, dungeonTrackerAverageWindow: 0 },
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: {
        getCurrentRun: () => null,
        getPendingDungeon: () => null,
        onUpdate: vi.fn(),
        offUpdate: vi.fn(),
    },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({ default: { annotateAllMessages: vi.fn() } }));
vi.mock('./dungeon-tracker-ui-state.js', () => ({
    default: {
        load: vi.fn(async () => {
            if (world.gate) await world.gate;
        }),
        updatePosition: vi.fn(),
        isKeysExpanded: false,
        isChartExpanded: false,
        isRoiExpanded: false,
        expandedGroups: new Set(),
        groupBy: 'dungeon',
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'all',
        hasActiveFilters: () => false,
    },
}));

/** The collapsible sections: constructed and called, but drawing nothing here. */
const stubModule = vi.hoisted(() => () => ({
    default: class {
        render = vi.fn(async () => {});
        update = vi.fn(async () => {});
        setupAll = vi.fn();
        applyInitialStates = vi.fn();
        onDelete = vi.fn();
    },
}));
vi.mock('./dungeon-tracker-ui-chart.js', stubModule);
vi.mock('./dungeon-tracker-ui-history.js', stubModule);
vi.mock('./dungeon-tracker-ui-interactions.js', stubModule);
vi.mock('./dungeon-roi-board-ui.js', stubModule);

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: vi.fn(async () => {
            if (world.runGate) await world.runGate;
            return [];
        }),
        getAverageBaselines: vi.fn(async () => ({})),
        getStats: vi.fn(async () => ({ totalRuns: 0, avgTime: 0, fastestTime: 0, slowestTime: 0, avgWaveTime: 0 })),
        getDungeonInfo: () => null,
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => ({ id: world.characterId, name: 'Marketcow' }),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { name: 'Marketcow' } },
        getCurrentCharacterId: () => world.characterId,
        on: vi.fn(),
        off: vi.fn(),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => world.settings[key] },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
}));
vi.mock('../../utils/command-registry.js', () => ({ registerCommand: vi.fn(), unregisterCommand: vi.fn() }));

const dungeonTracker = (await import('./dungeon-tracker.js')).default;
const ui = (await import('./dungeon-tracker-ui.js')).default;

const containers = () => document.querySelectorAll('#mwi-dungeon-tracker');

describe('a character switch landing inside the saved-state read', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        world.gate = null;
        world.runGate = null;
        world.characterId = 'char1';
        ui.cleanup();
        dungeonTracker.onUpdate.mockClear();
        dungeonTracker.offUpdate.mockClear();
    });

    afterEach(() => {
        ui.cleanup();
        document.body.innerHTML = '';
    });

    /**
     * Start an initialize() whose state read is held open, tear the panel down
     * inside it the way `character_switching` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = ui.initialize();
        // `character_switching` — the panel comes down while the read is out
        ui.cleanup();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(containers()).toHaveLength(0);
        expect(dungeonTracker.onUpdate).not.toHaveBeenCalled();
        expect(ui.updateInterval).toBe(null);
        expect(ui.dungeonUpdateHandler).toBe(null);
        expect(ui.characterSwitchingHandler).toBe(null);
        expect(ui.isInitialized).toBe(false);
    });

    test('the arriving character gets exactly one panel, one handler and one timer', async () => {
        await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await ui.initialize();

        expect(containers()).toHaveLength(1);
        expect(dungeonTracker.onUpdate).toHaveBeenCalledTimes(1);
        expect(ui.isInitialized).toBe(true);

        // …and that one registration is the one the teardown can remove
        const registered = dungeonTracker.onUpdate.mock.calls[0][0];
        const timer = ui.updateInterval;
        ui.cleanup();
        expect(dungeonTracker.offUpdate).toHaveBeenCalledWith(registered);
        expect(timer).not.toBe(null);
        expect(containers()).toHaveLength(0);
    });
});

/**
 * The same teardown landing inside `update()`'s stored-run read instead.
 *
 * Everything past that read draws: the narrowing to "my runs", the pace chip,
 * the header figures, the run list and the ROI board. `cleanup()` nulls
 * `this.container`, `this.history` and `this.roiBoard` while the read is out,
 * and the resumed tail went straight on to `this.container.querySelector(...)`
 * — so a switch timed into that window threw a TypeError out of the 1 Hz
 * handler, and everything after it in the draw was skipped.
 */
describe('a character switch landing inside the stored-run read', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        world.gate = null;
        world.runGate = null;
        world.characterId = 'char1';
        ui.cleanup();
        await ui.initialize();
    });

    afterEach(() => {
        ui.cleanup();
        document.body.innerHTML = '';
    });

    test('the interrupted update leaves what is on screen alone instead of throwing', async () => {
        const history = ui.history;
        history.update.mockClear();

        let release;
        world.runGate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = ui.update({ dungeonName: 'Chimerical Den', tier: 1, currentWave: 3, maxWaves: 10 });
        // `character_switching` — the panel comes down while the read is out
        ui.cleanup();
        world.characterId = 'char2';
        release();
        world.runGate = null;

        await expect(pending).resolves.toBeUndefined();
        // Nothing drew on top of the teardown
        expect(history.update).not.toHaveBeenCalled();
        expect(ui.container).toBe(null);
    });
});
