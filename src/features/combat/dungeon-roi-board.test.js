/**
 * The dungeon ROI board's arithmetic: rows from runs, sessions, a sim snapshot
 * and injected prices, with every figure labelled measured or sim.
 */

import { describe, test, expect } from 'vitest';
import {
    buildDungeonRoiRows,
    sortRoiRows,
    median,
    confidenceTag,
    priceKeys,
    priceRewards,
    measuredSessionRates,
    simReading,
    groupRunsByDungeonTier,
    runPartySize,
} from './dungeon-roi-board.js';

const DEN = '/actions/combat/chimerical_den';
const COVE = '/actions/combat/pirate_cove';

const dungeons = [
    { hrid: DEN, name: 'Chimerical Den', maxWaves: 50, maxDifficulty: 2 },
    { hrid: COVE, name: 'Pirate Cove', maxWaves: 65, maxDifficulty: 2 },
];

/** A reward table reader standing in for the sim adapter's expected drops. */
function rewardsPerRun(dungeonHrid, tier, partySize, dropQuantity) {
    const prefix = dungeonHrid === DEN ? 'chimerical' : 'pirate';
    const chests = (5 / partySize) * (1 + dropQuantity);
    return new Map([
        [`/items/${prefix}_chest`, chests],
        [`/items/${prefix}_refinement_chest`, 0.02 + 0.01 * tier],
        [`/items/${prefix}_token`, 40],
    ]);
}

const pricing = {
    rewardsPerRun,
    isToken: (hrid) => hrid.endsWith('_token'),
    tokenValue: () => 100,
    valueOf: (hrid) => (hrid.includes('refinement') ? 50_000 : hrid.endsWith('_chest') ? 20_000 : null),
    keyCost: (hrid) => (hrid.endsWith('_entry_key') ? 3_000 : 1_000),
    entryKeyFor: (hrid) => (hrid === DEN ? '/items/chimerical_entry_key' : '/items/pirate_entry_key'),
    consumablePrice: () => 200,
};

function run(dungeonName, tier, durationMs, team = ['Me']) {
    return { dungeonName, tier, duration: durationMs, team, teamKey: team.join(',') };
}

describe('median and confidence', () => {
    test('median ignores non-numbers and averages an even middle', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([null, 'x', 7])).toBe(7);
        expect(median([])).toBeNull();
    });

    test('confidence steps with run count and falls back to sim or none', () => {
        expect(confidenceTag(25, false).label).toBe('high');
        expect(confidenceTag(5, false).label).toBe('medium');
        expect(confidenceTag(1, true).label).toBe('low');
        expect(confidenceTag(0, true).label).toBe('sim');
        expect(confidenceTag(0, false).label).toBe('none');
    });
});

describe('grouping runs', () => {
    test('by dungeon name then tier, with tierless runs under null', () => {
        const grouped = groupRunsByDungeonTier([
            run('Chimerical Den', 1, 1000),
            run('Chimerical Den', null, 1000),
            run('Chimerical Den', '2', 1000),
            { dungeonName: 'Unknown', duration: 1000 },
        ]);
        expect([...grouped.get('Chimerical Den').keys()]).toEqual([1, null, 2]);
        expect(grouped.has('Unknown')).toBe(false);
    });

    test('party size comes from the team, then the key, then solo', () => {
        expect(runPartySize({ team: ['a', 'b', 'c'] })).toBe(3);
        expect(runPartySize({ teamKey: 'a,b' })).toBe(2);
        expect(runPartySize({})).toBe(1);
    });
});

describe('pricing a completion', () => {
    test('tokens, chests and refinement chests are told apart and summed', () => {
        const rewards = priceRewards(rewardsPerRun(DEN, 0, 1, 0), pricing);
        expect(rewards.tokensPerRun).toBe(40);
        expect(rewards.tokenValuePerRun).toBe(4_000);
        expect(rewards.chestsPerRun).toBe(5);
        expect(rewards.refinementChestsPerRun).toBeCloseTo(0.02);
        expect(rewards.chestEvPerRun).toBeCloseTo(5 * 20_000 + 0.02 * 50_000);
        expect(rewards.tokenHrid).toBe('/items/chimerical_token');
    });

    test('keys: one entry key, one chest key per chest of either kind', () => {
        const rewards = priceRewards(rewardsPerRun(DEN, 0, 1, 0), pricing);
        const keys = priceKeys(DEN, rewards, pricing);
        expect(keys.entries).toEqual([
            { itemHrid: '/items/chimerical_entry_key', count: 1, unitCost: 3_000 },
            { itemHrid: '/items/chimerical_chest_key', count: 5.02, unitCost: 1_000 },
        ]);
        expect(keys.total).toBeCloseTo(3_000 + 5.02 * 1_000);
        expect(keys.complete).toBe(true);
    });

    test('an unpriceable key leaves the total null rather than free', () => {
        const rewards = priceRewards(rewardsPerRun(DEN, 0, 1, 0), pricing);
        const keys = priceKeys(DEN, rewards, { ...pricing, keyCost: () => null });
        expect(keys.total).toBeNull();
        expect(keys.complete).toBe(false);
    });

    test('an unidentifiable entry key marks the cost incomplete, not free', () => {
        // A dungeon entryKeyFor cannot resolve (missing from both game data and
        // the fallback table) must not read as "needs no key" - regression for
        // entries.every() on an empty array being vacuously true.
        const rewards = priceRewards(rewardsPerRun(DEN, 0, 1, 0), pricing);
        const keys = priceKeys(DEN, rewards, { ...pricing, entryKeyFor: () => null });
        expect(keys.entries).toEqual([{ itemHrid: '/items/chimerical_chest_key', count: 5.02, unitCost: 1_000 }]);
        expect(keys.complete).toBe(false);
    });
});

describe('measured sessions and the sim snapshot', () => {
    test("session rates are the character's own, over the dungeon's sessions only", () => {
        const sessions = [
            {
                actionHrid: DEN,
                durationSeconds: 1800,
                players: [
                    { isCurrentPlayer: false, consumables: [{ itemHrid: '/items/x', consumed: 999 }], experience: {} },
                    {
                        isCurrentPlayer: true,
                        consumables: [{ itemHrid: '/items/coffee', consumed: 10 }],
                        experience: { attack: 6000, stamina: 3000 },
                    },
                ],
            },
            { actionHrid: COVE, durationSeconds: 3600, players: [{ isCurrentPlayer: true, consumables: [] }] },
        ];
        const rates = measuredSessionRates(sessions, DEN, () => 200);
        expect(rates.sessions).toBe(1);
        expect(rates.hours).toBeCloseTo(0.5);
        expect(rates.consumableCostPerHour).toBeCloseTo(4_000);
        expect(rates.xpPerHour).toBeCloseTo(18_000);
        expect(measuredSessionRates(sessions, '/actions/combat/nowhere', () => 200)).toBeNull();
    });

    test('an unflagged party session is skipped rather than read as slot 0', () => {
        // A snapshot from before the isCurrentPlayer flag existed, on a party
        // run. Before the fix this fell back to players[0] and mixed someone
        // else's consumables and XP into the character's own rate.
        const sessions = [
            {
                actionHrid: DEN,
                durationSeconds: 1800,
                players: [
                    { consumables: [{ itemHrid: '/items/x', consumed: 999 }], experience: { attack: 999_999 } },
                    { consumables: [{ itemHrid: '/items/coffee', consumed: 10 }], experience: { attack: 6000 } },
                ],
            },
        ];
        expect(measuredSessionRates(sessions, DEN, () => 200)).toBeNull();
    });

    test('an unflagged solo session still counts', () => {
        const sessions = [
            {
                actionHrid: DEN,
                durationSeconds: 1800,
                players: [{ consumables: [{ itemHrid: '/items/coffee', consumed: 10 }], experience: { attack: 6000 } }],
            },
        ];
        const rates = measuredSessionRates(sessions, DEN, () => 200);
        expect(rates.sessions).toBe(1);
        expect(rates.xpPerHour).toBeCloseTo(12_000);
    });

    test('the snapshot gives a clear time only when its dungeon figures are there', () => {
        const snapshot = {
            zones: [
                { zoneHrid: DEN, difficultyTier: 1, xpPerHour: 50_000 },
                {
                    zoneHrid: COVE,
                    difficultyTier: 0,
                    xpPerHour: 70_000,
                    dungeon: {
                        completions: 12,
                        simHours: 6,
                        partySize: 1,
                        consumableCostPerHour: 9_000,
                        deathsPerHour: 0,
                    },
                },
            ],
        };
        expect(simReading(snapshot, DEN, 1)).toEqual({
            clearSeconds: null,
            partySize: null,
            consumableCostPerHour: null,
            xpPerHour: 50_000,
            deathsPerHour: null,
        });
        expect(simReading(snapshot, COVE, 0).clearSeconds).toBe(1800);
        expect(simReading(snapshot, COVE, 0).consumableCostPerHour).toBe(9_000);
        expect(simReading(snapshot, DEN, 2)).toBeNull();
    });
});

describe('buildDungeonRoiRows', () => {
    const runs = [
        run('Chimerical Den', 1, 600_000),
        run('Chimerical Den', 1, 660_000),
        run('Chimerical Den', 1, 5_000_000), // the dinner run; the median shrugs it off
        run('Chimerical Den', null, 900_000, ['Me', 'Pal']),
    ];
    const snapshot = {
        zones: [
            {
                zoneHrid: COVE,
                difficultyTier: 0,
                xpPerHour: 70_000,
                dungeon: { completions: 10, simHours: 5, partySize: 1, consumableCostPerHour: 3_600, deathsPerHour: 0 },
            },
        ],
    };

    test('one row per dungeon and tier, plus a T? row for tierless runs, sorted by gold/hr', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        expect(rows.map((row) => row.key).sort()).toEqual(
            [`${DEN}::T0`, `${DEN}::T1`, `${DEN}::T2`, `${DEN}::T?`, `${COVE}::T0`, `${COVE}::T1`, `${COVE}::T2`].sort()
        );

        // Rows with an hourly figure come first, best first; rows without one last
        const hourly = rows.filter((row) => Number.isFinite(row.netPerHour)).map((row) => row.netPerHour);
        expect(hourly).toEqual([...hourly].sort((a, b) => b - a));
        expect(rows.slice(hourly.length).every((row) => row.netPerHour === null)).toBe(true);
    });

    test('a measured row takes the median clear time and counts its runs', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        const den1 = rows.find((row) => row.key === `${DEN}::T1`);

        expect(den1.runs).toBe(3);
        expect(den1.clearSource).toBe('measured');
        expect(den1.clearSeconds).toBe(660);
        expect(den1.wavesPerMinute).toBeCloseTo(50 / 11);
        expect(den1.confidence.label).toBe('low');
        expect(den1.partySize).toBe(1);
        expect(den1.partySizeSource).toBe('runs');

        // Solo at no quantity bonus: 5 chests, 40 tokens, refinement at T1 = 0.03
        const revenue = 5 * 20_000 + 0.03 * 50_000 + 40 * 100;
        const keys = 3_000 + 5.03 * 1_000;
        expect(den1.revenuePerRun).toBeCloseTo(revenue);
        expect(den1.keyCostPerRun).toBeCloseTo(keys);
        // No sessions and no sim for this tier: the food bill is unknown, so
        // there is no honest net to report — an unknown cost is not a zero cost
        expect(den1.consumableCostPerRun).toBeNull();
        expect(den1.costComplete).toBe(false);
        expect(den1.costGap).toBe('consumables');
        expect(den1.netPerRun).toBeNull();
        expect(den1.netPerHour).toBeNull();
        expect(den1.xpPerHour).toBeNull();
    });

    test('with no runs the sim supplies clear time, food and XP, and every one is marked sim', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        const cove0 = rows.find((row) => row.key === `${COVE}::T0`);

        expect(cove0.runs).toBe(0);
        expect(cove0.clearSource).toBe('sim');
        expect(cove0.clearSeconds).toBe(1800);
        expect(cove0.consumableSource).toBe('sim');
        expect(cove0.consumableCostPerRun).toBeCloseTo(1_800);
        expect(cove0.xpSource).toBe('sim');
        expect(cove0.xpPerHour).toBe(70_000);
        expect(cove0.confidence.label).toBe('sim');
        expect(cove0.partySizeSource).toBe('sim');
        expect(cove0.netPerHour).toBeCloseTo(cove0.netPerRun * 2);
    });

    test('a tier with neither runs nor sim reports no net at all, not a costless one', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        const cove2 = rows.find((row) => row.key === `${COVE}::T2`);
        expect(cove2.clearSource).toBeNull();
        expect(cove2.revenuePerRun).toBeGreaterThan(0);
        expect(cove2.costComplete).toBe(false);
        expect(cove2.netPerRun).toBeNull();
        expect(cove2.netPerHour).toBeNull();
        expect(cove2.confidence.label).toBe('none');
    });

    test('an unpriced key leaves the net blank rather than counting the key as free', () => {
        const rows = buildDungeonRoiRows({
            dungeons,
            runs,
            snapshot,
            pricing: { ...pricing, keyCost: (hrid) => (hrid.endsWith('_entry_key') ? null : 1_000) },
        });
        const cove0 = rows.find((row) => row.key === `${COVE}::T0`);

        // The sim gives this row a clear time and a food bill, so keys are the
        // only thing missing
        expect(cove0.consumableCostPerRun).toBeGreaterThan(0);
        expect(cove0.costGap).toBe('keys');
        expect(cove0.netPerRun).toBeNull();
        expect(cove0.netPerHour).toBeNull();
    });

    test('a fully priced row still reports its net', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        const cove0 = rows.find((row) => row.key === `${COVE}::T0`);

        expect(cove0.costComplete).toBe(true);
        expect(cove0.costGap).toBeNull();
        expect(cove0.netPerRun).toBeCloseTo(cove0.revenuePerRun - cove0.keyCostPerRun - cove0.consumableCostPerRun);
        expect(cove0.netPerHour).toBeCloseTo(cove0.netPerRun * cove0.runsPerHour);
    });

    test('the T? row is measured from tierless runs and priced as T0, at their party size', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing });
        const unknown = rows.find((row) => row.key === `${DEN}::T?`);
        expect(unknown.tier).toBeNull();
        expect(unknown.tierAssumed).toBe(true);
        expect(unknown.runs).toBe(1);
        expect(unknown.clearSeconds).toBe(900);
        expect(unknown.partySize).toBe(2);
        // Two players split the five chests
        expect(unknown.chestsPerRun).toBeCloseTo(2.5);
        expect(unknown.refinementChestsPerRun).toBeCloseTo(0.02);
    });

    test('measured sessions beat the sim for food and XP, per dungeon', () => {
        const sessions = [
            {
                actionHrid: COVE,
                durationSeconds: 3600,
                players: [
                    {
                        isCurrentPlayer: true,
                        consumables: [{ itemHrid: '/items/coffee', consumed: 5 }],
                        experience: { attack: 90_000 },
                    },
                ],
            },
        ];
        const rows = buildDungeonRoiRows({ dungeons, runs, sessions, snapshot, pricing });
        const cove0 = rows.find((row) => row.key === `${COVE}::T0`);
        expect(cove0.consumableSource).toBe('measured');
        expect(cove0.consumableCostPerHour).toBe(1_000);
        expect(cove0.xpSource).toBe('measured');
        expect(cove0.xpPerHour).toBe(90_000);
        // Clear time is still the sim's — sessions carry no completions
        expect(cove0.clearSource).toBe('sim');
    });

    test('the tier filter keeps only that tier; the party filter narrows runs and reprices the split', () => {
        const tierOnly = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing, filters: { tier: 1 } });
        expect(tierOnly.map((row) => row.tier)).toEqual([1, 1]);

        const party = buildDungeonRoiRows({ dungeons, runs, snapshot, pricing, filters: { partySize: 2 } });
        const den1 = party.find((row) => row.key === `${DEN}::T1`);
        expect(den1.runs).toBe(0); // the three T1 runs were solo
        expect(den1.partySize).toBe(2);
        expect(den1.partySizeSource).toBe('filter');
        expect(den1.chestsPerRun).toBeCloseTo(2.5);
        const unknown = party.find((row) => row.key === `${DEN}::T?`);
        expect(unknown.runs).toBe(1);
    });

    test('the drop quantity bonus raises chests and the chest keys with them', () => {
        const rows = buildDungeonRoiRows({ dungeons, runs: [], snapshot, pricing, dropQuantity: 0.2 });
        const den0 = rows.find((row) => row.key === `${DEN}::T0`);
        expect(den0.chestsPerRun).toBeCloseTo(6);
        expect(den0.keyEntries[1].count).toBeCloseTo(6.02);
    });

    test('a reward table that throws costs the row its rewards, not the board', () => {
        const rows = buildDungeonRoiRows({
            dungeons,
            runs: [],
            snapshot,
            pricing: {
                ...pricing,
                rewardsPerRun: () => {
                    throw new Error('no table');
                },
            },
        });
        expect(rows).toHaveLength(6);
        expect(rows.every((row) => row.revenuePerRun === 0)).toBe(true);
    });
});

describe('sortRoiRows', () => {
    const rows = [
        { dungeonName: 'B', tier: 0, netPerHour: 10 },
        { dungeonName: 'A', tier: 1, netPerHour: null },
        { dungeonName: 'A', tier: 0, netPerHour: 30 },
    ];

    test('numeric columns put missing values last either way', () => {
        expect(sortRoiRows(rows, 'netPerHour', false).map((row) => row.netPerHour)).toEqual([30, 10, null]);
        expect(sortRoiRows(rows, 'netPerHour', true).map((row) => row.netPerHour)).toEqual([10, 30, null]);
    });

    test('the dungeon column sorts by name then tier', () => {
        expect(sortRoiRows(rows, 'dungeon', true).map((row) => `${row.dungeonName}${row.tier}`)).toEqual([
            'A0',
            'A1',
            'B0',
        ]);
    });
});
