/** @vitest-environment happy-dom
 *
 * Whose runs the panel's sections draw when a character switch lands inside
 * their storage read.
 *
 * The run store is one key for the whole account, so "mine" means nothing until
 * somebody says who is asking — and the chart and the run list both used to ask
 * *after* `await getAllRuns()`. A switch settles `getCurrentCharacterId()`
 * before the feature teardown gets its turn, so for that window the sections
 * resolved the arriving character while still drawing into the departing
 * character's live panel: the chart plotted somebody else's run times under the
 * header that still named you.
 *
 * The identity is settled before the read now, so the answer belongs to
 * whoever asked, whatever lands mid-read.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    characterId: 'market123',
    runs: [],
    /** Held open to park a render inside the store read */
    gate: null,
}));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: vi.fn(async () => {
            if (world.gate) await world.gate;
            return world.runs;
        }),
        deleteRun: async () => true,
        getTeamKey: (names) => [...names].sort().join(','),
    },
    // The real rule, not a pass-through: whose runs these are is the question
    filterRunsForCharacter: (runs, filterCharacter, character) =>
        filterCharacter === 'mine' ? (runs || []).filter((run) => run.recordedBy === character?.id) : runs || [],
    currentCharacter: () => ({ id: world.characterId, name: world.characterId }),
    runIdentity: (run) => `${run?.teamKey ?? ''}|${run?.timestamp ?? ''}|${run?.duration ?? ''}`,
}));
vi.mock('../../utils/formatters.js', () => ({ formatDateTime: () => '04/08 10:00' }));
vi.mock('../../utils/panel-z-index.js', () => ({ PANEL_Z_CAP: 100 }));

const { default: DungeonTrackerUIChart } = await import('./dungeon-tracker-ui-chart.js');
const { default: DungeonTrackerUIHistory } = await import('./dungeon-tracker-ui-history.js');

/** Every config handed to Chart.js, so a test can read back what was plotted. */
const charted = [];

/** A stored run, stamped with who recorded it. */
function run(recordedBy, minutes) {
    return {
        recordedBy,
        teamKey: recordedBy,
        dungeonName: 'Chimerical Den',
        tier: 1,
        duration: minutes * 60_000,
        timestamp: '2026-08-04T10:00:00.000Z',
    };
}

/** The panel state these sections read, with the character filter on. */
function freshState() {
    return {
        groupBy: 'dungeon',
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'mine',
        expandedGroups: new Set(),
    };
}

/**
 * Open the store read, let the switch settle inside it, then close it.
 * @param {Promise} started - The render already in flight
 * @param {Function} release - Closes the gate
 * @returns {Promise<void>} Resolves once the render has finished
 */
async function switchInsideRead(started, release) {
    world.characterId = 'iron456';
    release();
    world.gate = null;
    await started;
}

beforeEach(() => {
    charted.length = 0;
    world.characterId = 'market123';
    world.gate = null;
    world.runs = [run('market123', 10), run('iron456', 20)];
    globalThis.Chart = class {
        constructor(_ctx, cfg) {
            charted.push(cfg);
        }
        destroy() {}
    };
    document.body.innerHTML = '';
});

afterEach(() => {
    delete globalThis.Chart;
    document.body.innerHTML = '';
});

/** A container holding the one canvas the inline chart draws into. */
function chartContainer() {
    const container = document.createElement('div');
    container.innerHTML = '<canvas id="mwi-dt-chart-canvas"></canvas>';
    container.querySelector('canvas').getContext = () => ({});
    document.body.appendChild(container);
    return container;
}

describe('the chart, when the switch lands inside its run read', () => {
    test('plots the runs of the character that asked', async () => {
        const chart = new DungeonTrackerUIChart(freshState(), (ms) => `${ms}ms`);
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });

        await switchInsideRead(chart.render(chartContainer()), release);

        // MarketCow's ten-minute run, not IronCow's twenty
        expect(charted).toHaveLength(1);
        expect(charted[0].data.datasets[0].data).toEqual([10]);
    });

    test('the pop-out chart asks the same question the same way', async () => {
        const chart = new DungeonTrackerUIChart(freshState(), (ms) => `${ms}ms`);
        const canvas = document.createElement('canvas');
        canvas.getContext = () => ({});
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });

        await switchInsideRead(chart.renderModalChart(canvas), release);

        expect(charted).toHaveLength(1);
        expect(charted[0].data.datasets[0].data).toEqual([10]);
    });
});

describe('the run list, when the switch lands inside its run read', () => {
    test('lists the runs of the character that asked', async () => {
        const history = new DungeonTrackerUIHistory(freshState(), (ms) => `${Math.round(ms / 60_000)}m`);
        const container = document.createElement('div');
        container.innerHTML = '<div id="mwi-dt-run-list"></div>';
        document.body.appendChild(container);

        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });

        await switchInsideRead(history.update(container), release);

        const text = container.querySelector('#mwi-dt-run-list').textContent;
        // One run listed, and it is the ten-minute one MarketCow recorded
        expect(text).not.toContain('No runs yet');
        expect(text).toContain('10m');
        expect(text).not.toContain('20m');
    });
});
