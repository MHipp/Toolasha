/**
 * The pivot's arithmetic.
 *
 * Everything worth getting wrong here is division: a rate over a window that
 * turns out to be zero, a total that double-counts Total Level, two tiers of a
 * dungeon folded into one row. None of it needs a page, so none of these tests
 * build one.
 */

import { describe, test, expect } from 'vitest';
import {
    getEntryDurationMs,
    mergeCurrentAndHistoricalEntries,
    buildActionGroupKey,
    aggregatePivotRows,
    computeRowRates,
    EXCLUDED_XP_SKILL_HRID,
} from './loot-log-analytics.js';

const HOUR = 3_600_000;

/**
 * A loot log entry, as the game sends them.
 * @param {Object} fields - What this entry differs by
 * @returns {Object}
 */
function entry(fields = {}) {
    return {
        characterActionId: 1,
        actionHrid: '/actions/milking/cow',
        startTime: '2026-09-01T00:00:00Z',
        endTime: '2026-09-01T01:00:00Z',
        totalActiveMillis: HOUR,
        actionCount: 100,
        drops: {},
        xpGains: {},
        ...fields,
    };
}

describe('getEntryDurationMs', () => {
    test('prefers the active time the game reports over the wall clock', () => {
        // Queued overnight, actually running for ten minutes — the wall clock
        // would report the run as twelve hours of near-zero income
        const ms = getEntryDurationMs(
            entry({ startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-01T12:00:00Z', totalActiveMillis: 600_000 })
        );
        expect(ms).toBe(600_000);
    });

    test('falls back to the wall clock for entries recorded before the field existed', () => {
        const ms = getEntryDurationMs(
            entry({ totalActiveMillis: undefined, startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-01T02:00:00Z' })
        );
        expect(ms).toBe(2 * HOUR);
    });

    test('reports nothing rather than a negative or a NaN when the times are unusable', () => {
        expect(getEntryDurationMs(entry({ totalActiveMillis: 0, startTime: null, endTime: null }))).toBe(0);
        expect(
            getEntryDurationMs(
                entry({ totalActiveMillis: 0, startTime: '2026-09-01T02:00:00Z', endTime: '2026-09-01T00:00:00Z' })
            )
        ).toBe(0);
        expect(getEntryDurationMs(undefined)).toBe(0);
    });
});

describe('mergeCurrentAndHistoricalEntries', () => {
    test('the live copy of a still-running action wins over the stored one', () => {
        const stored = entry({ characterActionId: 7, actionCount: 10 });
        const live = entry({ characterActionId: 7, actionCount: 40 });

        const merged = mergeCurrentAndHistoricalEntries([live], [stored]);
        expect(merged).toHaveLength(1);
        expect(merged[0].actionCount).toBe(40);
    });

    test('entries only one side has are kept, and entries with no id are dropped', () => {
        const merged = mergeCurrentAndHistoricalEntries(
            [entry({ characterActionId: 1 }), entry({ characterActionId: null })],
            [entry({ characterActionId: 2 })]
        );
        expect(merged.map((e) => e.characterActionId).sort()).toEqual([1, 2]);
    });

    test('either side may be missing entirely', () => {
        expect(mergeCurrentAndHistoricalEntries(undefined, undefined)).toEqual([]);
        expect(mergeCurrentAndHistoricalEntries([entry()], undefined)).toHaveLength(1);
    });
});

describe('buildActionGroupKey', () => {
    test('a tier is part of the identity, and no tier is its own key', () => {
        expect(buildActionGroupKey({ actionHrid: '/a/b', difficultyTier: 2 })).toBe('/a/b::2');
        expect(buildActionGroupKey({ actionHrid: '/a/b' })).toBe('/a/b::');
    });
});

describe('aggregatePivotRows', () => {
    test('sums time, actions, drops and XP per action', () => {
        const rows = aggregatePivotRows([
            entry({
                characterActionId: 1,
                actionCount: 100,
                drops: { '/items/milk': 90, '/items/coin': 5 },
                xpGains: { '/skills/milking': 1000 },
            }),
            entry({
                characterActionId: 2,
                actionCount: 50,
                drops: { '/items/milk': 40 },
                xpGains: { '/skills/milking': 500 },
            }),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            actionHrid: '/actions/milking/cow',
            entryCount: 2,
            actionCount: 150,
            totalTimeMs: 2 * HOUR,
            drops: { '/items/milk': 130, '/items/coin': 5 },
            xpGains: { '/skills/milking': 1500 },
        });
    });

    test('the same action at two difficulty tiers stays two rows', () => {
        const rows = aggregatePivotRows([
            entry({ characterActionId: 1, actionHrid: '/actions/combat/dungeon', difficultyTier: 1 }),
            entry({ characterActionId: 2, actionHrid: '/actions/combat/dungeon', difficultyTier: 3 }),
            entry({ characterActionId: 3, actionHrid: '/actions/combat/dungeon', difficultyTier: 3 }),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => [row.difficultyTier, row.entryCount])).toEqual([
            [1, 1],
            [3, 2],
        ]);
    });

    test('Total Level is left out, because it is the sum of the rest', () => {
        const rows = aggregatePivotRows([
            entry({ xpGains: { '/skills/milking': 900, [EXCLUDED_XP_SKILL_HRID]: 900 } }),
        ]);
        expect(rows[0].xpGains).toEqual({ '/skills/milking': 900 });
    });

    test('enhancing is excluded, as it is everywhere else in the loot log', () => {
        const rows = aggregatePivotRows([
            entry({ characterActionId: 1, actionHrid: '/actions/enhancing/enhance' }),
            entry({ characterActionId: 2 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].actionHrid).toBe('/actions/milking/cow');
    });

    test('entries with no action, and no entries at all, produce no rows', () => {
        expect(aggregatePivotRows([])).toEqual([]);
        expect(aggregatePivotRows(undefined)).toEqual([]);
        expect(aggregatePivotRows([{}, { actionHrid: null }])).toEqual([]);
    });

    test('the date range spans every entry in the row, ignoring unparseable stamps', () => {
        const rows = aggregatePivotRows([
            entry({ characterActionId: 1, startTime: '2026-09-01T00:00:00Z', endTime: '2026-09-01T01:00:00Z' }),
            entry({ characterActionId: 2, startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-01T01:00:00Z' }),
            entry({ characterActionId: 3, startTime: 'not a date', endTime: 'not a date' }),
        ]);

        expect(new Date(rows[0].earliestStartMs).toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect(new Date(rows[0].latestEndMs).toISOString()).toBe('2026-09-01T01:00:00.000Z');
    });
});

describe('computeRowRates', () => {
    test('per-skill XP/hr over the row’s whole aggregated time', () => {
        const [row] = aggregatePivotRows([
            entry({ totalActiveMillis: 2 * HOUR, xpGains: { '/skills/milking': 3000 } }),
        ]);
        const rates = computeRowRates(row, 8000, 4000);

        expect(rates.hours).toBe(2);
        expect(rates.xpEntries).toEqual([{ skillHrid: '/skills/milking', amount: 3000, perHour: 1500 }]);
        expect(rates.goldPerHourAsk).toBe(4000);
        expect(rates.goldPerHourBid).toBe(2000);
    });

    test('an action training several skills gets a summed total as well', () => {
        const [row] = aggregatePivotRows([
            entry({
                actionHrid: '/actions/combat/zone',
                totalActiveMillis: 2 * HOUR,
                xpGains: { '/skills/attack': 1000, '/skills/defense': 3000 },
            }),
        ]);
        const rates = computeRowRates(row, 0, 0);

        expect(rates.totalXp).toBe(4000);
        expect(rates.totalXpPerHour).toBe(2000);
    });

    test('the skill lines follow the game’s own display order', () => {
        const [row] = aggregatePivotRows([
            entry({ xpGains: { '/skills/defense': 1, '/skills/attack': 1, '/skills/stamina': 1 } }),
        ]);
        const order = { '/skills/stamina': 1, '/skills/attack': 2, '/skills/defense': 3 };
        const rates = computeRowRates(row, 0, 0, (hrid) => order[hrid]);

        expect(rates.xpEntries.map((xp) => xp.skillHrid)).toEqual([
            '/skills/stamina',
            '/skills/attack',
            '/skills/defense',
        ]);
    });

    test('a row with no elapsed time reports zeroes rather than Infinity', () => {
        const [row] = aggregatePivotRows([
            entry({
                totalActiveMillis: 0,
                startTime: null,
                endTime: null,
                drops: { '/items/milk': 5 },
                xpGains: { '/skills/milking': 900 },
            }),
        ]);
        const rates = computeRowRates(row, 5000, 4000);

        expect(row.totalTimeMs).toBe(0);
        expect(rates.goldPerHourAsk).toBe(0);
        expect(rates.goldPerHourBid).toBe(0);
        expect(rates.totalXpPerHour).toBe(0);
        expect(rates.xpEntries[0].perHour).toBe(0);
        // The totals themselves survive — only the rates are unanswerable
        expect(rates.totalXp).toBe(900);
    });

    test('an empty history aggregates and rates to nothing', () => {
        const rows = aggregatePivotRows(mergeCurrentAndHistoricalEntries([], []));
        expect(rows).toEqual([]);

        const rates = computeRowRates(undefined, 0, 0);
        expect(rates).toMatchObject({ hours: 0, goldPerHourAsk: 0, xpEntries: [], totalXp: 0, totalXpPerHour: 0 });
    });
});
