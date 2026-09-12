/**
 * The pinned list once combat zones are in it.
 *
 * A pinned action's numbers are computed live; a combat zone's come from a
 * simulation that finished at some point, in gear that may since have changed.
 * These tests are about the row shape that lets the two sit in one sorted table
 * without the older one quietly passing for the fresher one.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// The snapshot readers live on the combat sim panel, which brings a floating
// panel and two inventory panels with it — none of which this file is about
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: {
        loadAllZonesSnapshot: async () => null,
        currentGearFingerprint: async () => null,
    },
}));

// The manifest fetch is a real network call in production; loadActions' progressive-
// render tests only care that it doesn't block the first paint, not what it fetches.
vi.mock('../../utils/asset-manifest.js', () => ({
    default: { getSpriteUrl: async () => null },
}));

// Mutated per test — see `src/features/ui/combat-level-panel.test.js`'s pattern:
// mock the game, not the panel, so each test decides what's pinned and what's cached.
const mockDataManager = vi.hoisted(() => ({
    actionDetails: {},
    itemDetails: {},
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (actionHrid) => mockDataManager.actionDetails[actionHrid] ?? null,
        getItemDetails: (itemHrid) => mockDataManager.itemDetails[itemHrid] ?? null,
    },
}));

const mockActionPanelSort = vi.hoisted(() => ({
    pinned: [],
    cachedStats: {},
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        getPinnedActions: () => mockActionPanelSort.pinned,
        getCachedStats: (key) => mockActionPanelSort.cachedStats[key] ?? null,
        onPinChange: () => {},
        offPinChange: () => {},
    },
}));

const { default: page, combatZoneRows, formatAge } = await import('./pinned-actions-page.js');

const SNAPSHOT = {
    version: 1,
    savedAt: 1700000000000,
    hours: 10,
    fingerprint: 'gear-a',
    zones: [
        {
            zoneHrid: '/actions/combat/fly',
            zoneName: 'Fly',
            difficultyTier: 0,
            profitPerHour: 5000,
            xpPerHour: 12000,
        },
        {
            zoneHrid: '/actions/combat/jungle',
            zoneName: 'Jungle',
            difficultyTier: 2,
            profitPerHour: null,
            xpPerHour: 30000,
        },
    ],
};

describe('combatZoneRows', () => {
    test('a zone reads like a pinned action, with its tier in the name and key', () => {
        const [fly, jungle] = combatZoneRows(SNAPSHOT, 'gear-a');

        expect(fly).toMatchObject({
            actionHrid: '/actions/combat/fly|T0',
            baseActionHrid: '/actions/combat/fly',
            name: 'Fly T0',
            skill: 'Combat',
            profitPerHour: 5000,
            expPerHour: 12000,
            source: 'combat-sim',
            simulatedAt: 1700000000000,
        });
        expect(jungle.actionHrid).toBe('/actions/combat/jungle|T2');
        expect(jungle.name).toBe('Jungle T2');
    });

    test('an unpriced zone carries null rather than a zero it did not measure', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a')[1].profitPerHour).toBeNull();
    });

    test('gear matching the run is not flagged', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-a').every((row) => row.gearChanged === false)).toBe(true);
    });

    test('gear that has moved since flags every row from that run', () => {
        expect(combatZoneRows(SNAPSHOT, 'gear-b').every((row) => row.gearChanged === true)).toBe(true);
    });

    test('an unknown fingerprint on either side is not evidence of a change', () => {
        expect(combatZoneRows(SNAPSHOT, null)[0].gearChanged).toBe(false);
        expect(combatZoneRows({ ...SNAPSHOT, fingerprint: null }, 'gear-b')[0].gearChanged).toBe(false);
    });

    test('nothing stored is no rows rather than a throw', () => {
        expect(combatZoneRows(null, 'gear-a')).toEqual([]);
        expect(combatZoneRows({}, 'gear-a')).toEqual([]);
    });
});

describe('the merged table', () => {
    test('sorts simulated zones against live actions on the same column', () => {
        const milking = {
            actionHrid: '/actions/milking/cow',
            name: 'Milk Cow',
            skill: 'Milking',
            type: '/action_types/milking',
            level: 1,
            profitPerHour: 6000,
            expPerHour: 100,
        };

        page.allActions = [milking, ...combatZoneRows(SNAPSHOT, 'gear-a')];
        page.selectedSkills = [];
        page.sortColumn = 'profitPerHour';
        page.sortDirection = 'desc';

        const sorted = page.getFilteredSorted();

        expect(sorted.map((row) => row.name)).toEqual(['Milk Cow', 'Fly T0', 'Jungle T2']);
        // The unpriced zone sorts last either way rather than reading as free
        page.sortDirection = 'asc';
        expect(page.getFilteredSorted().at(-1).name).toBe('Jungle T2');

        page.allActions = [];
    });

    test('the skill filter can single out the simulated rows', () => {
        page.allActions = [
            { actionHrid: '/actions/milking/cow', name: 'Milk Cow', skill: 'Milking', profitPerHour: 1, expPerHour: 1 },
            ...combatZoneRows(SNAPSHOT, 'gear-a'),
        ];
        page.selectedSkills = ['Combat'];
        page.sortColumn = 'name';
        page.sortDirection = 'asc';

        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Fly T0', 'Jungle T2']);

        page.selectedSkills = [];
        page.allActions = [];
    });

    test('a row still being measured sorts last rather than as a zero', () => {
        // A pending row carries `profitPerHour: null`, same as a resolved-but-unpriced
        // one — it must not land between the loss and the profit the way an actual
        // zero would.
        page.allActions = [
            { actionHrid: 'a', name: 'Loss', skill: 'Milking', profitPerHour: -500, expPerHour: 10 },
            {
                actionHrid: 'b',
                name: 'Measuring',
                skill: 'Milking',
                profitPerHour: null,
                expPerHour: null,
                pending: true,
            },
            { actionHrid: 'c', name: 'Profit', skill: 'Milking', profitPerHour: 500, expPerHour: 10 },
        ];
        page.selectedSkills = [];
        page.sortColumn = 'profitPerHour';

        page.sortDirection = 'desc';
        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Profit', 'Loss', 'Measuring']);

        page.sortDirection = 'asc';
        expect(page.getFilteredSorted().map((row) => row.name)).toEqual(['Loss', 'Profit', 'Measuring']);

        page.allActions = [];
    });
});

describe('loadActions', () => {
    const ACTION_HRID = '/actions/tailoring/artificer_cape_refined';
    const ITEM_HRID = '/items/artificer_cape';

    beforeEach(() => {
        mockDataManager.actionDetails = {
            [ACTION_HRID]: {
                name: 'Artificer Cape',
                type: '/action_types/tailoring',
                levelRequirement: { level: 45 },
                outputItems: [{ itemHrid: ITEM_HRID }],
            },
        };
        mockDataManager.itemDetails = {};
        mockActionPanelSort.pinned = [ACTION_HRID];
        mockActionPanelSort.cachedStats = {};
        page.allActions = [];
        page.itemsSpriteUrl = null;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        page.allActions = [];
        page.itemsSpriteUrl = null;
    });

    test('a cold row paints as pending before computeStats resolves, then fills in without a second call', async () => {
        let resolveStats;
        const computeStatsSpy = vi
            .spyOn(page, 'computeStats')
            .mockImplementation(() => new Promise((resolve) => (resolveStats = resolve)));

        const loadPromise = page.loadActions();

        // The synchronous prefix of loadActions (building rows from what's already
        // known) has already run by the time loadActions returns its promise —
        // nothing here has been awaited yet.
        expect(page.allActions).toHaveLength(1);
        expect(page.allActions[0]).toMatchObject({
            actionHrid: ACTION_HRID,
            name: 'Artificer Cape',
            pending: true,
            profitPerHour: null,
            expPerHour: null,
        });
        expect(computeStatsSpy).toHaveBeenCalledTimes(1);

        resolveStats({ profitPerHour: 42_000, expPerHour: 1_200, liquidityLimit: null });
        await loadPromise;

        expect(page.allActions[0]).toMatchObject({
            pending: false,
            profitPerHour: 42_000,
            expPerHour: 1_200,
        });
    });

    test('a warm row (already cached) never calls computeStats and never shows as pending', async () => {
        mockActionPanelSort.cachedStats[ACTION_HRID] = { profitPerHour: 9_000, expPerHour: 300, liquidityLimit: null };
        const computeStatsSpy = vi.spyOn(page, 'computeStats');

        await page.loadActions();

        expect(computeStatsSpy).not.toHaveBeenCalled();
        expect(page.allActions[0]).toMatchObject({
            pending: false,
            profitPerHour: 9_000,
            expPerHour: 300,
        });
    });

    test('a row whose stats call rejects settles as unpriced rather than staying pending forever', async () => {
        // computeStats already catches everything itself and resolves null on
        // failure — this pins the second net around it: even a rejection reaching
        // loadActions some other way must not leave the row stuck "measuring…" or
        // take the rest of the page's rows down with it via Promise.all.
        vi.spyOn(page, 'computeStats').mockRejectedValue(new Error('network'));
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(page.loadActions()).resolves.toBeUndefined();

        expect(page.allActions[0]).toMatchObject({ pending: false, profitPerHour: null, expPerHour: null });
    });
});

describe('formatAge', () => {
    const NOW = 1700000000000;

    test('says how stale a run is in terms worth acting on', () => {
        expect(formatAge(NOW - 5 * 60_000, NOW)).toBe('5m ago');
        expect(formatAge(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
        expect(formatAge(NOW - 5 * 24 * 3600_000, NOW)).toBe('5d ago');
    });

    test('no timestamp says nothing rather than 1970', () => {
        expect(formatAge(null, NOW)).toBe('');
    });
});
