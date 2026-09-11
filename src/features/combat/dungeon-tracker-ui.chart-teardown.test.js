/**
 * @vitest-environment happy-dom
 *
 * A teardown landing inside the chart's stored-run read.
 *
 * `render()` reads the canvas, suspends on `getAllRuns()`, and constructs a
 * Chart.js instance when it resumes. A `character_switching` teardown landing
 * in that window destroys the chart, drops the section and removes the panel —
 * and the resumed tail then built a *second* Chart against the canvas of the
 * removed panel, storing it on a section object nobody holds a reference to any
 * more. A Chart.js instance owns a resize observer and an animation loop and
 * registers itself in Chart's own instance registry, so each one is live
 * forever: one leak per switch that lands in the window, accumulating.
 *
 * The mirror image is the other half of the same test: once the arriving
 * character has a section of its own, the departing section's tail must not
 * destroy or overwrite the chart that section built.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park a render inside the stored-run read */
    runGate: null,
    characterId: 'char1',
    runs: [],
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
        load: vi.fn(async () => {}),
        updatePosition: vi.fn(),
        isKeysExpanded: false,
        isChartExpanded: true,
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

/** The sections that are not under test: constructed and called, drawing nothing. */
const stubModule = vi.hoisted(() => () => ({
    default: class {
        render = vi.fn(async () => {});
        update = vi.fn(async () => {});
        setupAll = vi.fn();
        applyInitialStates = vi.fn();
        onDelete = vi.fn();
    },
}));
vi.mock('./dungeon-tracker-ui-history.js', stubModule);
vi.mock('./dungeon-tracker-ui-interactions.js', stubModule);
vi.mock('./dungeon-roi-board-ui.js', stubModule);

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: vi.fn(async () => {
            // One-shot: the gate parks the next read only, so a later render
            // for the arriving character is not held behind the departing one
            const gate = world.runGate;
            world.runGate = null;
            if (gate) await gate;
            return world.runs;
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
    PANEL_Z_CAP: 100,
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
}));
vi.mock('../../utils/command-registry.js', () => ({ registerCommand: vi.fn(), unregisterCommand: vi.fn() }));

const ui = (await import('./dungeon-tracker-ui.js')).default;

/** Every Chart.js instance ever constructed in a test, in order. */
const built = [];

/** A stored run, enough of one for the chart to plot a point. */
function run(minutes) {
    return {
        recordedBy: 'char1',
        teamKey: 'solo',
        dungeonName: 'Chimerical Den',
        tier: 1,
        duration: minutes * 60_000,
        timestamp: '2026-08-04T10:00:00.000Z',
    };
}

/**
 * Park the next stored-run read, whoever makes it.
 * @returns {Function} Closes the gate
 */
function holdTheRead() {
    let release;
    world.runGate = new Promise((resolve) => {
        release = resolve;
    });
    return release;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    built.length = 0;
    world.runGate = null;
    world.characterId = 'char1';
    world.runs = [run(10), run(12)];
    globalThis.Chart = class {
        constructor(ctx, cfg) {
            this.cfg = cfg;
            this.destroyed = false;
            built.push(this);
        }
        destroy() {
            this.destroyed = true;
        }
    };
    HTMLCanvasElement.prototype.getContext = () => ({});
    ui.cleanup();
    await ui.initialize();
});

afterEach(() => {
    ui.cleanup();
    delete globalThis.Chart;
    document.body.innerHTML = '';
});

describe('the inline chart, when the teardown lands inside its run read', () => {
    test('the interrupted render constructs nothing on the way out', async () => {
        await ui.updateChart();
        expect(built).toHaveLength(1);
        const live = built[0];

        const release = holdTheRead();
        const pending = ui.updateChart();
        // `character_switching` — the panel comes down while the read is out
        ui.cleanup();
        release();
        await pending;

        // No second Chart.js instance against the removed panel's canvas
        expect(built).toHaveLength(1);
        // …and the one the teardown destroyed stayed destroyed
        expect(live.destroyed).toBe(true);
    });

    test('the departing render leaves the arriving panel’s chart alone', async () => {
        const release = holdTheRead();
        const pending = ui.updateChart();

        // The switch: the panel comes down, and the arriving character gets one
        ui.cleanup();
        world.characterId = 'char2';
        await ui.initialize();
        await ui.updateChart();
        expect(built).toHaveLength(1);
        const live = built[0];

        release();
        await pending;

        expect(built).toHaveLength(1);
        expect(live.destroyed).toBe(false);
        expect(ui.chart.chartInstance).toBe(live);
    });
});

describe('the pop-out chart, when the teardown lands inside its run read', () => {
    test('the interrupted render constructs nothing on the way out', async () => {
        const chart = ui.chart;
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);

        const release = holdTheRead();
        const pending = chart.renderModalChart(canvas);
        ui.cleanup();
        release();
        await pending;

        expect(built).toHaveLength(0);
        expect(chart.modalChartInstance).toBe(null);
    });

    test('an open pop-out comes down with the panel', async () => {
        const chart = ui.chart;
        chart.createPopoutModal();
        // createPopoutModal does not await the render it starts
        await Promise.resolve();
        await Promise.resolve();
        expect(built).toHaveLength(1);
        expect(document.getElementById('mwi-dt-chart-modal')).not.toBe(null);

        ui.cleanup();

        // The modal lives on document.body, so the container removal misses it:
        // its chart, its element and its document-level ESC handler all went
        // with the teardown, rather than the chart alone being destroyed under
        // a modal left on screen for the arriving character.
        expect(built[0].destroyed).toBe(true);
        expect(document.getElementById('mwi-dt-chart-modal')).toBe(null);
        expect(chart.modalChartInstance).toBe(null);
    });
});
