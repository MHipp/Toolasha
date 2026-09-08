import { describe, test, expect, vi } from 'vitest';
import {
    recordOpening,
    resetTally,
    mergeStoredTally,
    expectedLootPerChest,
    chestPerformance,
    chestBreakdown,
    summariseTally,
    tallyTotals,
    sortSummary,
} from './chest-tally.js';

const CHEST = '/items/small_chest';
const dropTable = [
    { itemHrid: '/items/coin', dropRate: 1, minCount: 100, maxCount: 300 },
    { itemHrid: '/items/rare', dropRate: 0.01, minCount: 1, maxCount: 1 },
];
const priceOf = (hrid) => ({ '/items/coin': 1, '/items/rare': 100000, '/items/junk': 0 })[hrid] ?? null;

describe('recordOpening', () => {
    test('records the first opening', () => {
        const tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        expect(tally[CHEST]).toMatchObject({ opened: 1, loot: { '/items/coin': 200 } });
    });

    test('accumulates across openings', () => {
        let tally = recordOpening({}, CHEST, 5, [{ itemHrid: '/items/coin', count: 1000 }]);
        tally = recordOpening(tally, CHEST, 3, [
            { itemHrid: '/items/coin', count: 600 },
            { itemHrid: '/items/rare', count: 1 },
        ]);
        expect(tally[CHEST]).toMatchObject({ opened: 8, loot: { '/items/coin': 1600, '/items/rare': 1 } });
    });

    test('leaves the tally it was given alone', () => {
        // The caller persists the result; mutating in place makes it ambiguous
        // which copy is the saved one
        const before = { [CHEST]: { opened: 1, loot: { '/items/coin': 200 } } };
        recordOpening(before, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        expect(before[CHEST].opened).toBe(1);
    });

    test('keeps chests apart', () => {
        let tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 100 }]);
        tally = recordOpening(tally, '/items/big_chest', 1, [{ itemHrid: '/items/coin', count: 900 }]);
        expect(Object.keys(tally)).toHaveLength(2);
    });

    test('ignores an opening with nothing to record', () => {
        expect(recordOpening({}, '', 1, [])).toEqual({});
        expect(recordOpening({}, CHEST, 0, [])).toEqual({});
    });

    test('an opening that gave nothing still counts as an opening', () => {
        // Otherwise a chest that can come up empty looks better than it is
        expect(recordOpening({}, CHEST, 2, [])[CHEST]).toMatchObject({ opened: 2, loot: {} });
    });
});

describe('resetTally', () => {
    test('forgets one chest and keeps the rest', () => {
        const tally = { a: { opened: 1, loot: { '/items/coin': 5 } }, b: { opened: 2, loot: {} } };
        const reset = resetTally(tally, 'a', 1000);
        expect(reset.a).toEqual({ opened: 0, loot: {}, since: 1000 });
        expect(reset.b).toEqual({ opened: 2, loot: {} });
    });

    test('forgets everything when given no chest', () => {
        expect(resetTally({ a: { opened: 1, loot: {} } }, undefined, 1000)).toEqual({
            a: { opened: 0, loot: {}, since: 1000 },
        });
        expect(resetTally({})).toEqual({});
    });

    test('leaves nothing behind for a chest that had no history', () => {
        expect(resetTally({ b: { opened: 2, loot: {} } }, 'a')).toEqual({ b: { opened: 2, loot: {} } });
    });

    test('an opening after a reset keeps counting from the reset', () => {
        // The stamp says when this bucket began counting, not when it was last
        // touched — an opening added to it is part of that same counting
        const reset = resetTally({ [CHEST]: { opened: 9, loot: {} } }, CHEST, 1000);
        const after = recordOpening(reset, CHEST, 2, [{ itemHrid: '/items/coin', count: 40 }]);
        expect(after[CHEST]).toMatchObject({ opened: 2, loot: { '/items/coin': 40 }, since: 1000 });
    });
});

describe('expectedLootPerChest', () => {
    test('is the midpoint of the range times the rate', () => {
        expect(expectedLootPerChest(dropTable)).toEqual({ '/items/coin': 200, '/items/rare': 0.01 });
    });

    test('adds up an item that appears twice in one table', () => {
        expect(
            expectedLootPerChest([
                { itemHrid: '/items/coin', dropRate: 1, minCount: 10, maxCount: 10 },
                { itemHrid: '/items/coin', dropRate: 0.5, minCount: 4, maxCount: 4 },
            ])
        ).toEqual({ '/items/coin': 12 });
    });

    test('survives a missing table', () => {
        expect(expectedLootPerChest(null)).toEqual({});
    });
});

describe('chestPerformance', () => {
    test('an exactly average run comes out level', () => {
        // 100 chests owe 20000 coin and one rare
        const entry = { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 1 } };
        const result = chestPerformance(entry, dropTable, priceOf);

        expect(result.expectedValue).toBeCloseTo(120000, 6);
        expect(result.actualValue).toBeCloseTo(120000, 6);
        expect(result.ratio).toBeCloseTo(1, 6);
    });

    test('a rare that never came up shows as a row, not an absence', () => {
        // The missing rare is the whole story on an unlucky chest; dropping it
        // from the list hides exactly the row worth reading
        const entry = { opened: 100, loot: { '/items/coin': 20000 } };
        const result = chestPerformance(entry, dropTable, priceOf);

        const rare = result.items.find((item) => item.itemHrid === '/items/rare');
        expect(rare).toMatchObject({ actualCount: 0 });
        expect(rare.expectedCount).toBeCloseTo(1, 6);
        expect(result.ratio).toBeCloseTo(20000 / 120000, 6);
    });

    test('rows are ordered by how much the chest owes you, commonest first', () => {
        const entry = { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 1 } };
        const [first] = chestPerformance(entry, dropTable, priceOf).items;
        expect(first.itemHrid).toBe('/items/coin');
    });

    test('and by nothing else, so a price change cannot rearrange the list', () => {
        // Ordered by worth, the rows moved whenever a price moved and whenever
        // the cape or cowbell valuation was changed — a list you had learned the
        // shape of rearranging itself for reasons unrelated to the chest
        const entry = { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 1 } };
        const order = (prices) =>
            chestPerformance(entry, dropTable, (hrid) => prices[hrid]).items.map((i) => i.itemHrid);

        expect(order({ '/items/coin': 1, '/items/rare': 100000 })).toEqual(
            order({ '/items/coin': 1, '/items/rare': 1 })
        );
    });

    test('an item with no price sits out of both sides but is still a row', () => {
        // It counts towards neither side of the verdict, because counting it as
        // free would be a lie. It is still listed: an item that dropped and is
        // simply not shown reads as a chest that did not contain it.
        const withJunk = [...dropTable, { itemHrid: '/items/junk', dropRate: 1, minCount: 5, maxCount: 5 }];
        const entry = { opened: 10, loot: { '/items/coin': 2000, '/items/junk': 50 } };
        const result = chestPerformance(entry, withJunk, priceOf);

        const junk = result.items.find((item) => item.itemHrid === '/items/junk');
        expect(junk).toBeDefined();
        expect(junk.unpriced).toBe(true);
        expect(junk.actualCount).toBe(50);
        expect(junk.actualValue).toBe(0);
        expect(result.actualValue).toBe(2000);
    });

    test('an item that dropped but is not in the table is owed nothing and goes last', () => {
        // Drop tables change between updates; the row is kept, but it has no
        // expectation to be ranked by
        const entry = { opened: 10, loot: { '/items/coin': 2000, '/items/removed': 3 } };
        const items = chestPerformance(entry, dropTable, priceOf).items;

        expect(items[items.length - 1].itemHrid).toBe('/items/removed');
    });

    test('nothing opened yet is not a verdict', () => {
        // A ratio of zero would read as catastrophically unlucky
        expect(chestPerformance({ opened: 0, loot: {} }, dropTable, priceOf).ratio).toBeNull();
    });

    test('counts loot from a table that no longer lists it', () => {
        // Drop tables change between game updates; history should not vanish
        const entry = { opened: 1, loot: { '/items/rare': 2 } };
        const result = chestPerformance(entry, [], priceOf);
        expect(result.actualValue).toBe(200000);
        expect(result.expectedValue).toBe(0);
    });
});

describe('summariseTally', () => {
    const dropTables = { [CHEST]: dropTable, '/items/big_chest': dropTable };

    test('puts the worst opened chest first', () => {
        const tally = {
            [CHEST]: { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 2 } },
            '/items/big_chest': { opened: 100, loot: { '/items/coin': 20000 } },
        };
        expect(summariseTally(tally, dropTables, priceOf)[0].chestHrid).toBe('/items/big_chest');
    });

    test('lists chests you have never opened, priced', () => {
        // The panel is also where you look up what a chest is worth before
        // deciding to open it, which a list of your own history cannot answer
        const rows = summariseTally({}, dropTables, priceOf);
        expect(rows).toHaveLength(2);
        expect(rows[0].perChestValue).toBeCloseTo(1200, 6);
        expect(rows[0].opened).toBe(0);
    });

    test('unopened chests wait behind the ones with a verdict', () => {
        const tally = { '/items/big_chest': { opened: 10, loot: { '/items/coin': 2000 } } };
        expect(summariseTally(tally, dropTables, priceOf).map((r) => r.chestHrid)).toEqual(['/items/big_chest', CHEST]);
    });

    test('keeps history for a chest the game has stopped listing', () => {
        const tally = { '/items/removed_chest': { opened: 5, loot: { '/items/coin': 900 } } };
        const rows = summariseTally(tally, dropTables, priceOf);
        expect(rows.some((r) => r.chestHrid === '/items/removed_chest')).toBe(true);
    });

    test('survives an empty tally', () => {
        expect(summariseTally(null, dropTables, priceOf)).toHaveLength(2);
        expect(summariseTally(null, null, priceOf)).toEqual([]);
    });
});

describe('sortSummary', () => {
    const dropTables = { [CHEST]: dropTable, '/items/big_chest': dropTable };
    const NAMES = { [CHEST]: 'Zebra Chest', '/items/big_chest': 'Aardvark Chest' };
    const nameOf = (chestHrid) => NAMES[chestHrid] || chestHrid;

    // The lucky one, the unlucky one, and one never opened
    const tally = {
        [CHEST]: { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 2 } },
        '/items/big_chest': { opened: 5, loot: { '/items/coin': 1000 } },
    };
    const rows = () => summariseTally(tally, dropTables, priceOf);
    const order = (mode) => sortSummary(rows(), mode, nameOf).map((row) => row.chestHrid);

    test('by name every chest is in one alphabet, opened or not', () => {
        // Splitting them would put half the names in one place and half in
        // another, which is the thing this order exists to avoid
        expect(order('name')).toEqual(['/items/big_chest', CHEST]);
    });

    test('by most opened, the one you have actually been opening leads', () => {
        expect(order('opened')[0]).toBe(CHEST);
    });

    test('by coins up or down, which is not the same question as luck', () => {
        // A chest opened five times can be the unluckiest by ratio and still be
        // nowhere near the biggest loss
        expect(order('luck')[0]).toBe('/items/big_chest');
        expect(order('profit')[0]).toBe(CHEST);
    });

    test('an unknown mode falls back to luck rather than to arbitrary', () => {
        expect(order('nonsense')).toEqual(order('luck'));
    });

    test('the caller’s array is left alone', () => {
        // It is usually the one on screen, and reordering it underneath a
        // half-drawn table draws a row twice
        const original = rows();
        const before = original.map((row) => row.chestHrid);
        sortSummary(original, 'name', nameOf);

        expect(original.map((row) => row.chestHrid)).toEqual(before);
    });

    test('survives having nothing to sort', () => {
        expect(sortSummary(null, 'name')).toEqual([]);
    });
});

describe('tallyTotals', () => {
    test('one chest running hot does not hide another running cold', () => {
        const rows = [
            { opened: 10, actualValue: 5000, expectedValue: 10000 },
            { opened: 10, actualValue: 15000, expectedValue: 10000 },
        ];
        expect(tallyTotals(rows)).toMatchObject({ opened: 20, difference: 0, ratio: 1 });
    });

    test('no history is no verdict', () => {
        expect(tallyTotals([]).ratio).toBeNull();
    });
});

describe('the most recent opening', () => {
    test('is kept apart from the running total', () => {
        let tally = recordOpening({}, CHEST, 5, [{ itemHrid: '/items/coin', count: 1000 }]);
        tally = recordOpening(tally, CHEST, 2, [{ itemHrid: '/items/coin', count: 500 }]);

        expect(tally[CHEST].opened).toBe(7);
        expect(tally[CHEST].loot).toEqual({ '/items/coin': 1500 });
        expect(tally[CHEST].last).toEqual({ opened: 2, loot: { '/items/coin': 500 } });
    });

    test('is the same shape as the total, so one judge serves both', () => {
        // chestPerformance takes { opened, loot } — feeding it `last` judges a
        // single opening with no second code path
        const tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        const result = chestPerformance(tally[CHEST].last, dropTable, priceOf);
        expect(result.opened).toBe(1);
        expect(result.actualValue).toBe(200);
        expect(result.expectedValue).toBeCloseTo(1200, 6);
    });

    test('an opening that gave nothing still replaces the previous one', () => {
        let tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/rare', count: 1 }]);
        tally = recordOpening(tally, CHEST, 1, []);
        expect(tally[CHEST].last).toEqual({ opened: 1, loot: {} });
    });
});

describe('chestBreakdown', () => {
    test('lines the three views up on the same items, in the same order', () => {
        // The panel reads across a row; ordering each column separately would
        // make that a lookup instead of a glance
        let tally = recordOpening({}, CHEST, 9, [{ itemHrid: '/items/coin', count: 1800 }]);
        tally = recordOpening(tally, CHEST, 1, [{ itemHrid: '/items/rare', count: 1 }]);

        const { items, total, last } = chestBreakdown(tally[CHEST], dropTable, priceOf);
        expect(items.map((i) => i.itemHrid)).toEqual(['/items/coin', '/items/rare']);
        expect(total.opened).toBe(10);
        expect(last.opened).toBe(1);
    });

    test('the last opening is judged against what that opening owed, not the run', () => {
        // One chest owes 200 coin; ten owe 2000. Judging one against ten would
        // report every single opening as catastrophic
        let tally = recordOpening({}, CHEST, 9, [{ itemHrid: '/items/coin', count: 1800 }]);
        tally = recordOpening(tally, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);

        const coin = chestBreakdown(tally[CHEST], dropTable, priceOf).items.find((i) => i.itemHrid === '/items/coin');
        expect(coin.lastRatio).toBeCloseTo(1, 6);
        expect(coin.totalRatio).toBeCloseTo(1, 6);
    });

    test('reports what one chest is worth on average', () => {
        const tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        // 200 coin at 1, plus a 1% shot at a 100000 rare
        expect(chestBreakdown(tally[CHEST], dropTable, priceOf).perChestValue).toBeCloseTo(1200, 6);
    });

    test('survives a chest opened once and never again', () => {
        const tally = recordOpening({}, CHEST, 1, []);
        const result = chestBreakdown(tally[CHEST], dropTable, priceOf);
        expect(result.items.every((i) => i.lastCount === 0)).toBe(true);
    });
});

describe('mergeStoredTally', () => {
    const CHEST = '/items/chest';

    test('takes the larger of each lifetime count, and memory’s last opening', () => {
        const stored = { [CHEST]: { opened: 5, loot: { '/items/coin': 50, '/items/gem': 1 }, last: { opened: 1 } } };
        const memory = { [CHEST]: { opened: 3, loot: { '/items/coin': 60 }, last: { opened: 2 } } };

        expect(mergeStoredTally(stored, memory)).toEqual({
            [CHEST]: { opened: 5, loot: { '/items/coin': 60, '/items/gem': 1 }, last: { opened: 2 } },
        });
    });

    test('keeps chests only one side has, and tolerates nothing stored', () => {
        const stored = { '/items/a': { opened: 1, loot: {} } };
        const memory = { '/items/b': { opened: 2, loot: {} } };

        expect(Object.keys(mergeStoredTally(stored, memory)).sort()).toEqual(['/items/a', '/items/b']);
        expect(mergeStoredTally(null, memory)).toEqual(memory);
        expect(mergeStoredTally(stored, undefined)).toEqual(stored);
    });

    test('a reset survives the round trip a peer would otherwise undo', () => {
        // A resets and pushes; B pulls, and its still-full copy must not win —
        // only the pulling device merges, so a reset that loses here loses
        // everywhere, and comes back to A on the next pull
        const full = { [CHEST]: { opened: 500, loot: { '/items/coin': 50000 } } };
        const aAfterReset = resetTally(full, CHEST, 1000);

        const bPulled = mergeStoredTally(full, aAfterReset);
        expect(bPulled[CHEST]).toEqual({ opened: 0, loot: {}, since: 1000 });

        const aPulledBack = mergeStoredTally(aAfterReset, bPulled);
        expect(aPulledBack[CHEST]).toEqual({ opened: 0, loot: {}, since: 1000 });
    });

    test('an unstamped copy loses to a stamped reset whichever side holds it', () => {
        const stamped = { [CHEST]: { opened: 0, loot: {}, since: 1000 } };
        const unstamped = { [CHEST]: { opened: 40, loot: { '/items/coin': 4000 } } };

        expect(mergeStoredTally(unstamped, stamped)[CHEST].opened).toBe(0);
        expect(mergeStoredTally(stamped, unstamped)[CHEST].opened).toBe(0);
    });

    test('openings the peer recorded after the reset survive it', () => {
        // The ordering hazard: the other device took the reset and kept opening
        // chests. Its bucket counts from the same reset, so the stamps agree and
        // the counters fold by max as they always did
        const aAfterReset = resetTally({ [CHEST]: { opened: 500, loot: {} } }, CHEST, 1000);
        const bAfterReset = recordOpening(aAfterReset, CHEST, 7, [{ itemHrid: '/items/coin', count: 700 }]);

        expect(mergeStoredTally(aAfterReset, bAfterReset)[CHEST]).toMatchObject({
            opened: 7,
            loot: { '/items/coin': 700 },
            since: 1000,
        });
        expect(mergeStoredTally(bAfterReset, aAfterReset)[CHEST]).toMatchObject({ opened: 7, since: 1000 });
    });

    test('a newer reset beats an older one', () => {
        const older = { [CHEST]: { opened: 12, loot: { '/items/coin': 1200 }, since: 1000 } };
        const newer = { [CHEST]: { opened: 0, loot: {}, since: 2000 } };
        expect(mergeStoredTally(older, newer)[CHEST]).toEqual({ opened: 0, loot: {}, since: 2000 });
    });

    test('refuses a reset from elsewhere that would zero more than twelve chests', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const local = {};
        for (let i = 0; i < 13; i += 1) local[`/items/chest_${i}`] = { opened: 10, loot: { '/items/coin': 100 } };
        const remote = resetTally(local, undefined, 1000);

        const merged = mergeStoredTally(local, remote);
        expect(Object.values(merged).every((entry) => entry.opened === 10)).toBe(true);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('the refusal does not stand in the way of this device’s own reset', () => {
        const local = {};
        for (let i = 0; i < 13; i += 1) local[`/items/chest_${i}`] = { opened: 10, loot: {} };
        const ourReset = resetTally(local, undefined, 1000);

        // Local side holds the stamp: the reset was made or already taken here
        const merged = mergeStoredTally(ourReset, local);
        expect(Object.values(merged).every((entry) => entry.opened === 0)).toBe(true);
    });

    test('twelve at once still applies', () => {
        const local = {};
        for (let i = 0; i < 12; i += 1) local[`/items/chest_${i}`] = { opened: 10, loot: {} };
        const merged = mergeStoredTally(local, resetTally(local, undefined, 1000));
        expect(Object.values(merged).every((entry) => entry.opened === 0)).toBe(true);
    });

    test('memory wins wherever a count is not a number', () => {
        const stored = { [CHEST]: { opened: 'five', loot: { '/items/coin': 50 } } };
        const memory = { [CHEST]: { opened: 3, loot: { '/items/coin': 'lots' } } };

        expect(mergeStoredTally(stored, memory)[CHEST]).toEqual({ opened: 3, loot: { '/items/coin': 'lots' } });
    });
});
