/**
 * @vitest-environment happy-dom
 *
 * Dungeon Tracker UI Interactions — filter indicator, destructive-confirm
 * routing, and the removed global reset-position shortcut.
 *
 * Dependencies that reach storage, the game's websocket hook, or build their
 * own DOM (dungeonTracker, chat annotations, config, storage, panel z-index,
 * the choice dialog) are mocked so the test is about this module's wiring,
 * not theirs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const askChoiceMock = vi.fn();

vi.mock('./dungeon-tracker.js', () => ({
    default: {
        backfillFromChatHistory: vi.fn(),
        getCurrentRun: vi.fn(() => null),
        getPendingDungeon: vi.fn(() => null),
    },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({ default: { refreshRunCounts: vi.fn() } }));
vi.mock('../../core/config.js', () => ({ default: { Z_NOTIFICATION: 9999 } }));
vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        clearAllRuns: vi.fn(async () => true),
        getRunsForCharacter: vi.fn(async () => []),
        latestStatsKey: vi.fn(async () => null),
        setAverageBaseline: vi.fn(async () => true),
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({ bringPanelToFront: vi.fn() }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: (...args) => askChoiceMock(...args) }));

const { default: DungeonTrackerUIInteractions } = await import('./dungeon-tracker-ui-interactions.js');
const { default: dungeonTrackerStorage } = await import('./dungeon-tracker-storage.js');
const { default: dungeonTracker } = await import('./dungeon-tracker.js');

/**
 * Build a minimal DOM container plus a fake state object. Only the elements
 * exercised in a given test need to exist — every setup*() method here
 * guards on `if (!element) return;`.
 */
function buildContainer(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

function makeState(overrides = {}) {
    return {
        filterDungeon: 'all',
        filterTeam: 'all',
        filterTier: 'all',
        filterCharacter: 'mine',
        position: null,
        hasActiveFilters() {
            return this.filterDungeon !== 'all' || this.filterTeam !== 'all';
        },
        clearFilters() {
            this.filterDungeon = 'all';
            this.filterTeam = 'all';
        },
        save: vi.fn(),
        updatePosition: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    askChoiceMock.mockReset();
    dungeonTrackerStorage.clearAllRuns.mockClear();
    dungeonTrackerStorage.setAverageBaseline.mockClear();
    dungeonTrackerStorage.getRunsForCharacter.mockReset().mockResolvedValue([]);
    dungeonTrackerStorage.latestStatsKey.mockReset().mockResolvedValue(null);
    dungeonTracker.getCurrentRun.mockReset().mockReturnValue(null);
    dungeonTracker.getPendingDungeon.mockReset().mockReturnValue(null);
});

describe('filter indicator', () => {
    test('hidden on setup when no filters are active', () => {
        const container = buildContainer('<span id="mwi-dt-filter-indicator" style="display: none;"></span>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();

        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('none');
    });

    test('shown on setup when a filter was left active from a previous session', () => {
        const container = buildContainer('<span id="mwi-dt-filter-indicator" style="display: none;"></span>');
        const state = makeState({ filterDungeon: 'Chimeratos Lair' });
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();

        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');
    });

    test('clicking the indicator clears both filters, resets the dropdowns, saves, and refreshes', () => {
        const container = buildContainer(`
            <span id="mwi-dt-filter-indicator" style="display: none;"></span>
            <select id="mwi-dt-filter-dungeon">
                <option value="all">All Dungeons</option>
                <option value="Chimeratos Lair">Chimeratos Lair</option>
            </select>
            <select id="mwi-dt-filter-team">
                <option value="all">All Teams</option>
                <option value="Solo">Solo</option>
            </select>
        `);
        container.querySelector('#mwi-dt-filter-dungeon').value = 'Chimeratos Lair';
        container.querySelector('#mwi-dt-filter-team').value = 'Solo';

        const state = makeState({ filterDungeon: 'Chimeratos Lair', filterTeam: 'Solo' });
        const onUpdateHistory = vi.fn();
        const onUpdateChart = vi.fn();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory, onUpdateChart };

        interactions.setupFilterIndicator();
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');

        container.querySelector('#mwi-dt-filter-indicator').click();

        expect(state.filterDungeon).toBe('all');
        expect(state.filterTeam).toBe('all');
        expect(state.save).toHaveBeenCalled();
        expect(container.querySelector('#mwi-dt-filter-dungeon').value).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-team').value).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('none');
        expect(onUpdateHistory).toHaveBeenCalledTimes(1);
        expect(onUpdateChart).toHaveBeenCalledTimes(1);
    });

    test('changing a filter dropdown updates the indicator immediately', () => {
        const container = buildContainer(`
            <span id="mwi-dt-filter-indicator" style="display: none;"></span>
            <select id="mwi-dt-filter-dungeon">
                <option value="all">All Dungeons</option>
                <option value="Chimeratos Lair">Chimeratos Lair</option>
            </select>
            <select id="mwi-dt-filter-team"><option value="all">All Teams</option></select>
        `);
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();
        interactions.setupGroupingControls();

        const dungeonSelect = container.querySelector('#mwi-dt-filter-dungeon');
        dungeonSelect.value = 'Chimeratos Lair';
        dungeonSelect.dispatchEvent(new Event('change'));

        expect(state.filterDungeon).toBe('Chimeratos Lair');
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');
    });
});

describe('clear-history confirmation', () => {
    test('routes through askChoice, not window.confirm, and does nothing on cancel', async () => {
        const container = buildContainer('<button id="mwi-dt-clear-all"></button>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory: vi.fn(), onUpdateChart: vi.fn() };

        askChoiceMock.mockResolvedValue(null); // user cancelled

        interactions.setupClearAll();
        container.querySelector('#mwi-dt-clear-all').click();
        await vi.waitFor(() => expect(askChoiceMock).toHaveBeenCalledTimes(1));

        const [call] = askChoiceMock.mock.calls[0];
        expect(call.choices.some((c) => c.tone === 'danger')).toBe(true);
        expect(dungeonTrackerStorage.clearAllRuns).not.toHaveBeenCalled();
    });

    test('deletes all history once the danger choice is confirmed', async () => {
        const container = buildContainer('<button id="mwi-dt-clear-all"></button>');
        const state = makeState();
        const onUpdateHistory = vi.fn();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory, onUpdateChart: vi.fn() };

        askChoiceMock.mockResolvedValue('delete');
        vi.stubGlobal('alert', vi.fn());

        interactions.setupClearAll();
        container.querySelector('#mwi-dt-clear-all').click();
        await vi.waitFor(() => expect(dungeonTrackerStorage.clearAllRuns).toHaveBeenCalledTimes(1));

        expect(onUpdateHistory).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('reset-position button', () => {
    test('clicking it clears the saved position and does not start a drag', () => {
        const container = buildContainer('<button id="mwi-dt-reset-position-btn"></button>');
        const state = makeState({ position: { x: 40, y: 60 } });
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupResetPositionButton();
        container.querySelector('#mwi-dt-reset-position-btn').click();

        expect(state.position).toBeNull();
        expect(state.updatePosition).toHaveBeenCalledWith(container);
        expect(state.save).toHaveBeenCalled();
    });
});

describe('global Ctrl+Shift+D shortcut removal', () => {
    test('no longer exists as a method, and setup registers no document keydown listener', () => {
        const container = buildContainer('<div id="mwi-dt-header"></div>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        expect(interactions.setupKeyboardShortcut).toBeUndefined();

        const addSpy = vi.spyOn(document, 'addEventListener');
        interactions.setupDragging();
        const keydownRegistrations = addSpy.mock.calls.filter(([type]) => type === 'keydown');
        expect(keydownRegistrations).toHaveLength(0);

        addSpy.mockRestore();
    });
});

describe('average baseline marker target', () => {
    const DEN = 'A,B::Chimerical Den';
    const CIRCUS = 'C,D::Sinister Circus';

    /** Stored runs, newest first, covering both a filtered and an unfiltered dungeon */
    const runs = [
        { teamKey: 'C,D', dungeonName: 'Sinister Circus', tier: 3 },
        { teamKey: 'A,B', dungeonName: 'Chimerical Den', tier: 2 },
    ];

    /** Wire up the button with a given panel state and click it */
    async function press(state) {
        const container = buildContainer('<button id="mwi-dt-avg-reset"></button>');
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};
        interactions.setupAverageBaseline();
        container.querySelector('#mwi-dt-avg-reset').click();
        return container;
    }

    test('marks the dungeon the panel is filtered to, not the newest stored run', async () => {
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue(runs);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        askChoiceMock.mockResolvedValue('mark');

        await press(makeState({ filterDungeon: 'Chimerical Den', filterTeam: 'A,B' }));
        await vi.waitFor(() => expect(dungeonTrackerStorage.setAverageBaseline).toHaveBeenCalledTimes(1));

        expect(dungeonTrackerStorage.setAverageBaseline.mock.calls[0][0]).toBe(DEN);
    });

    test('the confirm names the dungeon that will actually be marked', async () => {
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue(runs);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        askChoiceMock.mockResolvedValue(null);

        await press(makeState({ filterDungeon: 'Chimerical Den', filterTeam: 'A,B' }));
        await vi.waitFor(() => expect(askChoiceMock).toHaveBeenCalledTimes(1));

        const { message } = askChoiceMock.mock.calls[0][0];
        expect(message).toContain('Chimerical Den');
        expect(message).not.toContain('Sinister Circus');
        expect(message).toContain('Nothing is deleted');
        expect(dungeonTrackerStorage.setAverageBaseline).not.toHaveBeenCalled();
    });

    test('a run in progress outranks both the filters and the newest stored run', async () => {
        dungeonTracker.getCurrentRun.mockReturnValue({
            dungeonName: 'Chimerical Den',
            keyCountsMap: { B: 1, A: 1 },
        });
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue(runs);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        askChoiceMock.mockResolvedValue('mark');

        await press(makeState({ filterDungeon: 'Sinister Circus', filterTeam: 'C,D' }));
        await vi.waitFor(() => expect(dungeonTrackerStorage.setAverageBaseline).toHaveBeenCalledTimes(1));

        expect(dungeonTrackerStorage.setAverageBaseline.mock.calls[0][0]).toBe(DEN);
    });

    test('an ambiguous panel offers the choice and marks nothing when it is dismissed', async () => {
        // A tier filter alone leaves two team-and-dungeon pairs on screen
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue([
            { teamKey: 'C,D', dungeonName: 'Sinister Circus', tier: 2 },
            { teamKey: 'A,B', dungeonName: 'Chimerical Den', tier: 2 },
        ]);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        askChoiceMock.mockResolvedValue(null);

        await press(makeState({ filterTier: '2' }));
        await vi.waitFor(() => expect(askChoiceMock).toHaveBeenCalledTimes(1));

        const [ask] = askChoiceMock.mock.calls[0];
        expect(ask.choices.map((c) => c.value)).toContain(DEN);
        expect(ask.choices.map((c) => c.value)).toContain(CIRCUS);
        expect(ask.message).toContain('Nothing is deleted');
        expect(dungeonTrackerStorage.setAverageBaseline).not.toHaveBeenCalled();
    });

    test('picking one of the ambiguous choices marks exactly that one', async () => {
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue([
            { teamKey: 'C,D', dungeonName: 'Sinister Circus', tier: 2 },
            { teamKey: 'A,B', dungeonName: 'Chimerical Den', tier: 2 },
        ]);
        askChoiceMock.mockResolvedValue(DEN);

        await press(makeState({ filterTier: '2' }));
        await vi.waitFor(() => expect(dungeonTrackerStorage.setAverageBaseline).toHaveBeenCalledTimes(1));

        expect(dungeonTrackerStorage.setAverageBaseline.mock.calls[0][0]).toBe(DEN);
    });

    test('a panel with no state at all falls back to the newest run and says so in the confirm', async () => {
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue(runs);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        askChoiceMock.mockResolvedValue('mark');

        await press(makeState());
        await vi.waitFor(() => expect(dungeonTrackerStorage.setAverageBaseline).toHaveBeenCalledTimes(1));

        expect(dungeonTrackerStorage.setAverageBaseline.mock.calls[0][0]).toBe(CIRCUS);
        const { message } = askChoiceMock.mock.calls[0][0];
        expect(message).toContain('Sinister Circus');
        expect(message).toContain('most recent');
    });

    test('a filter matching no stored run refuses instead of marking something else', async () => {
        dungeonTrackerStorage.getRunsForCharacter.mockResolvedValue(runs);
        dungeonTrackerStorage.latestStatsKey.mockResolvedValue(CIRCUS);
        const alertMock = vi.fn();
        vi.stubGlobal('alert', alertMock);

        await press(makeState({ filterDungeon: 'Aqua Planet' }));
        await vi.waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));

        expect(askChoiceMock).not.toHaveBeenCalled();
        expect(dungeonTrackerStorage.setAverageBaseline).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
