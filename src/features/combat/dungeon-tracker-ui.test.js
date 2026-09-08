/**
 * @vitest-environment happy-dom
 *
 * What the dungeon tracker panel puts on screen when it does not have a whole
 * run behind it.
 *
 * Two states earn their own tests. A page loaded part-way through a dungeon has
 * a dungeon but no run — nothing is tracked until the next wave, some
 * thirty-five seconds away — and the panel names it provisionally rather than
 * sitting blank. A run picked up part-way through has figures, but its clock
 * started when we noticed it, not when the run began; the panel must never
 * present that number as the run's duration.
 *
 * The sub-modules (chart, history, interactions, ROI board) are stubs: this is
 * about the header the run state drives, not about what the collapsible
 * sections draw.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    currentRun: null,
    pending: null,
    settings: { dungeonTrackerUI: true, dungeonPace: true, dungeonTrackerAverageWindow: 0 },
    runs: [],
    baselines: {},
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: {
        getCurrentRun: () => world.currentRun,
        getPendingDungeon: () => world.pending,
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
        getAllRuns: vi.fn(async () => world.runs),
        getAverageBaselines: vi.fn(async () => world.baselines),
        getStats: vi.fn(async () => ({ totalRuns: 0, avgTime: 0, fastestTime: 0, slowestTime: 0, avgWaveTime: 0 })),
        getDungeonInfo: () => null,
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => ({ id: 'market123', name: 'Marketcow' }),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { name: 'Marketcow' } },
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

const ui = (await import('./dungeon-tracker-ui.js')).default;

/** A live run as `getCurrentRun` hands it over. */
function run(overrides = {}) {
    return {
        dungeonName: 'Pirate Cove',
        tier: 1,
        currentWave: 48,
        maxWaves: 65,
        wavesCompleted: 0,
        totalElapsed: 90_000,
        currentWaveElapsed: 5_000,
        avgWaveTime: 0,
        fastestWave: 0,
        slowestWave: 0,
        waveTimes: [],
        estimatedTimeRemaining: 0,
        keyCountsMap: {},
        hibernationDetected: false,
        joinedMidRun: false,
        joinedAtWave: null,
        elapsedIsSinceNoticed: false,
        ...overrides,
    };
}

const text = (id) => ui.container.querySelector(id)?.textContent.trim();
const titleOf = (id) => ui.container.querySelector(id)?.title;

beforeEach(async () => {
    document.body.innerHTML = '';
    world.currentRun = null;
    world.pending = null;
    world.runs = [];
    world.baselines = {};
    world.settings.dungeonTrackerAverageWindow = 0;
    ui.isInitialized = false;
    ui.container = null;
    if (ui.updateInterval) clearInterval(ui.updateInterval);
    await ui.initialize();
});

describe('the provisional card', () => {
    test('a dungeon running with no run behind it is named, with every figure blank', async () => {
        world.pending = { dungeonHrid: '/actions/combat/pirate_cove', dungeonName: 'Pirate Cove', tier: 1 };

        ui.dungeonUpdateHandler(null, null);

        expect(ui.container.style.display).toBe('block');
        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(text('#mwi-dt-wave-counter')).toBe('waiting for next wave');
        // No run, so no elapsed and no progress — blanks, not guesses
        expect(text('#mwi-dt-current-time')).toBe('--:--');
        expect(ui.container.querySelector('#mwi-dt-progress-bar').style.width).toBe('0%');
        expect(text('#mwi-dt-progress-text')).toBe('');
    });

    test('a tierless dungeon is named without a tier', () => {
        world.pending = { dungeonHrid: '/actions/combat/pirate_cove', dungeonName: 'Pirate Cove', tier: null };
        ui.dungeonUpdateHandler(null, null);
        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove');
    });

    test('no run and no pending dungeon hides the panel, as before', () => {
        ui.dungeonUpdateHandler(null, null);
        expect(ui.container.style.display).toBe('none');
    });
});

describe('a run joined part-way through', () => {
    test('the panel says where it was picked up and refuses to call the clock a duration', async () => {
        await ui.update(run({ joinedMidRun: true, joinedAtWave: 48, elapsedIsSinceNoticed: true }), false);

        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1) · joined W48');
        // The figure is still shown — it is true, it is just not the run's length
        expect(text('#mwi-dt-time-label')).toBe('Watched:');
        expect(titleOf('#mwi-dt-time-label')).toContain('not the run');
        expect(titleOf('#mwi-dt-time-label')).toContain('wave 48');
        expect(text('#mwi-dt-current-time')).toBe('01:30');
        expect(text('#mwi-dt-wave-counter')).toBe('Wave 48/65');
    });

    test('a whole run is labelled as elapsed, exactly as before', async () => {
        await ui.update(run({ currentWave: 3, wavesCompleted: 2 }), false);

        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(text('#mwi-dt-time-label')).toBe('Elapsed:');
        expect(titleOf('#mwi-dt-time-label')).toBe('Time since dungeon started');
    });

    test('a recovered start is presented as an ordinary run, with the source in the tooltip', async () => {
        // The party's chat gave the real start back, so the figure is the run's
        // own elapsed time and the "joined W48" caveat has nothing left to warn about
        await ui.update(
            run({ joinedMidRun: true, joinedAtWave: 48, elapsedIsSinceNoticed: false, startRecovered: true }),
            false
        );

        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(text('#mwi-dt-time-label')).toBe('Elapsed:');
        expect(titleOf('#mwi-dt-time-label')).toContain('recovered from the party chat log');
        expect(titleOf('#mwi-dt-time-label')).toContain('wave 48');
    });

    test('the pace chip stays down: two waves timed at wave 48 are not a run’s first two', async () => {
        await ui.update(
            run({ joinedMidRun: true, joinedAtWave: 48, elapsedIsSinceNoticed: true, waveTimes: [3000, 4000] }),
            false
        );

        expect(ui.container.querySelector('#mwi-dt-pace').style.display).toBe('none');
    });
});

describe('the average window reaches the panel too', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const STATS_KEY = 'Marketcow,Pal::Pirate Cove';

    /** A stored run of the live run's dungeon, chat-style: duration, no waves */
    const storedRun = (durationMs, dayIndex) => ({
        dungeonName: 'Pirate Cove',
        tier: 1,
        teamKey: 'Marketcow,Pal',
        duration: durationMs,
        timestamp: new Date(dayIndex * DAY).toISOString(),
    });

    // Five slow runs, then three fast ones: a lifetime average of 400_000ms
    // and a last-three average of 250_000ms, which disagree about a run of 300s
    const history = [
        storedRun(500_000, 1),
        storedRun(500_000, 2),
        storedRun(500_000, 3),
        storedRun(500_000, 4),
        storedRun(500_000, 5),
        storedRun(250_000, 6),
        storedRun(250_000, 7),
        storedRun(250_000, 8),
    ];

    /** A live run far enough in to have a pace, at a given wave average */
    const paced = (avgWaveMs) =>
        run({ wavesCompleted: 10, avgWaveTime: avgWaveMs, waveTimes: new Array(10).fill(avgWaveMs) });

    test('Avg Run is the lifetime figure with the setting at its default', async () => {
        world.runs = history;
        await ui.update(paced(6_000), true);

        // (5 × 500_000 + 3 × 250_000) / 8 = 406_250ms
        expect(text('#mwi-dt-header-avg')).toBe('06:46');
        expect(text('#mwi-dt-avg-time')).toBe('06:46');
    });

    test('a window pulls Avg Run onto the last N runs, as the chat line reports them', async () => {
        world.runs = history;
        world.settings.dungeonTrackerAverageWindow = 3;
        await ui.update(paced(6_000), true);

        // The same three runs the chat line's trailing average covers: 250_000ms
        expect(text('#mwi-dt-header-avg')).toBe('04:10');
        expect(text('#mwi-dt-avg-time')).toBe('04:10');
        // The run count still describes the whole history
        expect(text('#mwi-dt-header-runs')).toBe('8');
    });

    test('a reset marker excludes the runs before it from Avg Run', async () => {
        world.runs = history;
        world.baselines = { [STATS_KEY]: 5 * DAY };
        await ui.update(paced(6_000), true);

        expect(text('#mwi-dt-header-avg')).toBe('04:10');
    });

    test('the pace chip judges the run against the window, not the lifetime average', async () => {
        world.runs = history;
        // 6_000ms a wave over 65 waves is 390_000ms — faster than the lifetime
        // average and slower than the last three runs
        await ui.update(paced(6_000), true);
        expect(ui.container.querySelector('#mwi-dt-pace').textContent).toContain('+');

        world.settings.dungeonTrackerAverageWindow = 3;
        await ui.update(paced(6_000), true);
        expect(ui.container.querySelector('#mwi-dt-pace').textContent).toContain('−');
    });

    test('a marker that leaves nothing behind draws no chip and blanks Avg Run', async () => {
        world.runs = history;
        world.baselines = { [STATS_KEY]: 9 * DAY };
        await ui.update(paced(6_000), true);

        expect(ui.container.querySelector('#mwi-dt-pace').style.display).toBe('none');
        expect(text('#mwi-dt-header-avg')).toBe('--:--');
    });
});
