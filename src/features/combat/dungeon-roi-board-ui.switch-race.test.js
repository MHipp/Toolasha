/** @vitest-environment happy-dom
 *
 * The ROI board across a character switch, and across two renders asked for at
 * once.
 *
 * Both are the same shape of mistake: the board reads live state — who is
 * playing, which filters are set — *after* a load that suspends for as long as
 * an IndexedDB scan and two character-scoped storage reads take. A switch
 * landing in that window used to narrow the departing character's run history
 * to the arriving one and draw it against the departing one's sessions and sim
 * snapshot; two renders landing in it used to run concurrently, so the slower
 * load drew last whichever filter it belonged to.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const DEN = '/actions/combat/chimerical_den';

const state = vi.hoisted(() => ({
    characterId: 'alice',
    characterName: 'Alice',
    runs: [],
    sessions: [],
    snapshot: null,
    /** Set to a function to hold `getAllRuns` open until the test releases it */
    gate: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => fallback,
        getSetting: () => false,
    },
}));

vi.mock('../../core/data-manager.js', () => {
    const actionDetailMap = {
        [DEN]: {
            type: '/action_types/combat',
            name: 'Chimerical Den',
            maxDifficulty: 0,
            sortIndex: 1,
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    maxWaves: 50,
                    keyItemHrid: '/items/chimerical_entry_key',
                    rewardDropTable: [
                        { itemHrid: '/items/chimerical_chest', dropRate: 1, minCount: 1, maxCount: 1 },
                        { itemHrid: '/items/chimerical_token', dropRate: 1, minCount: 40, maxCount: 40 },
                    ],
                },
            },
        },
    };
    const items = {
        '/items/chimerical_chest': { name: 'Chimerical Chest', isOpenable: true },
        '/items/chimerical_entry_key': { name: 'Chimerical Entry Key' },
        '/items/chimerical_chest_key': { name: 'Chimerical Chest Key' },
    };
    return {
        default: {
            getInitClientData: () => ({ actionDetailMap }),
            getActionDetails: (hrid) => actionDetailMap[hrid] || null,
            getItemDetails: (hrid) => items[hrid] || null,
            // Read live, so a test can switch character mid-load. `stillOurs`
            // reads this one too — that is what makes the guard fire.
            getCurrentCharacterId: () => state.characterId,
            getCurrentCharacterName: () => state.characterName,
        },
    };
});

vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: () => ({ ask: 200, bid: 180 }) },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        getCachedValue: (hrid) => (hrid.endsWith('_chest') ? 20_000 : null),
        calculateSingleContainer: () => null,
        resolveSellSideValue: () => null,
    },
}));

vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    calculateExpectedDrops: () =>
        new Map([
            ['/items/chimerical_chest', 1],
            ['/items/chimerical_token', 40],
        ]),
    taxedDropValue: (hrid, value) => value * 0.95,
}));

vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => null },
}));

vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => state.sessions,
}));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: async () => {
            if (state.gate) await new Promise((resolve) => (state.gate.release = resolve));
            return state.runs;
        },
        getDungeonInfo: () => null,
    },
    // The real narrowing, not a passthrough: a run belongs to whoever is named
    // on its team, which is exactly what a switch changes the answer to
    filterRunsForCharacter: (runs, filterCharacter, character) =>
        filterCharacter !== 'mine' ? runs : runs.filter((run) => (run.team || []).includes(character?.name)),
    currentCharacter: () => ({ id: state.characterId, name: state.characterName }),
}));

vi.mock('../../utils/all-zones-snapshot.js', () => ({
    loadAllZonesSnapshot: async () => state.snapshot,
}));

vi.mock('../../utils/key-cost.js', () => ({
    describeKeyCosts: (hrids) =>
        new Map(hrids.map((hrid) => [hrid, { itemHrid: hrid, unitCost: hrid.endsWith('_entry_key') ? 3_000 : 1_000 }])),
}));

vi.mock('../../utils/token-valuation.js', () => ({
    calculateDungeonTokenValue: () => 100,
}));

const { default: DungeonRoiBoardUI } = await import('./dungeon-roi-board-ui.js');

function dungeonRun(team, durationMs) {
    return { dungeonName: 'Chimerical Den', tier: 0, duration: durationMs, team, teamKey: team.join(',') };
}

/** Let every queued microtask settle — the loads here resolve in a few hops. */
async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Wait until the held-open `getAllRuns` has actually reached its gate. */
async function reachedGate() {
    for (let i = 0; i < 50 && !state.gate.release; i++) await Promise.resolve();
    if (!state.gate.release) throw new Error('getAllRuns never reached its gate');
}

function panel() {
    const container = document.createElement('div');
    container.innerHTML = '<div id="mwi-dt-roi-container"></div>';
    document.body.appendChild(container);
    return container;
}

/** What the "Runs" column says on the one dungeon row. */
function runsCell(container) {
    const row = container.querySelector('.mwi-dt-roi-row');
    return row ? row.children[1].textContent : null;
}

beforeEach(() => {
    state.characterId = 'alice';
    state.characterName = 'Alice';
    state.runs = [];
    state.sessions = [];
    state.snapshot = null;
    state.gate = null;
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('character switch mid-load', () => {
    test('a switch inside the history load draws nothing rather than the arriving character over the leaving one', async () => {
        // Alice has three runs; Bob has none. Whoever the board ends up drawing
        // for, it must not draw Alice's board under Bob's narrowing.
        state.runs = [dungeonRun(['Alice'], 600_000), dungeonRun(['Alice'], 620_000), dungeonRun(['Alice'], 640_000)];
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();

        // First draw, for Alice, with nothing in the way
        await board.render(container);
        expect(runsCell(container)).toBe('3');

        // Now hold the run-store read open, start a refresh, and switch
        state.gate = {};
        board.rows = [];
        const pending = board.render(container);
        await reachedGate();
        state.characterId = 'bob';
        state.characterName = 'Bob';
        state.gate.release();
        await pending;

        // Pre-fix this drew a "0 runs" row: Alice's list narrowed to Bob, priced
        // against Alice's sessions and Alice's sim snapshot.
        expect(runsCell(container)).toBe('3');
        expect(board.rows).toEqual([]);
    });

    test('no switch means the board is built and drawn as usual', async () => {
        state.runs = [dungeonRun(['Alice'], 600_000), dungeonRun(['Alice'], 620_000)];
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();

        state.gate = {};
        const pending = board.render(container);
        await reachedGate();
        state.gate.release();
        await pending;

        expect(runsCell(container)).toBe('2');
    });
});

describe('two renders at once', () => {
    test('renders run one at a time, in the order they were asked for', async () => {
        const board = new DungeonRoiBoardUI({ filterCharacter: 'mine' });
        const container = panel();

        // The gathering is not what is under test here — only the queueing is,
        // so the drawn half is replaced by something that says when it ran.
        const events = [];
        const releases = [];
        board._renderInto = async () => {
            const index = releases.length;
            events.push(`start ${index}`);
            await new Promise((resolve) => releases.push(resolve));
            events.push(`end ${index}`);
        };

        // Three renders asked for while the first is still going: a panel open
        // followed by two quick filter clicks.
        const first = board.render(container);
        const second = board.render(container);
        const third = board.render(container);
        await flush();
        expect(events).toEqual(['start 0']);

        // Pre-fix both parked renders resumed together here and each claimed
        // `_rendering`, so this read ['start 0', 'end 0', 'start 1', 'start 2']
        // — two loads in flight at once, the slower one drawing last.
        releases[0]();
        await flush();
        expect(events).toEqual(['start 0', 'end 0', 'start 1']);

        releases[1]();
        await flush();
        expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2']);

        releases[2]();
        await Promise.all([first, second, third]);
        expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
        expect(board._rendering).toBeNull();
    });
});
