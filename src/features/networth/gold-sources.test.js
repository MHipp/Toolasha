import { describe, test, expect } from 'vitest';
import {
    attributeGoldSources,
    alchemySessionNet,
    enhancementSessionNet,
    marketplaceByDay,
    dailyCloses,
    daysBetween,
    lootEntryValue,
    combatSessionLootValue,
    ownCombatPlayer,
    splitDropKey,
    localDayId,
    dayStart,
    categoryBreakdown,
    categoryDelta,
    marketMovement,
    taskCompletionValue,
    chestOpeningDayValue,
} from './gold-sources.js';

const DAY = 24 * 60 * 60 * 1000;

/** 2026-08-20T12:00:00Z and the two days around it */
const D18 = Date.parse('2026-08-18T12:00:00Z');
const D19 = Date.parse('2026-08-19T12:00:00Z');
const D20 = Date.parse('2026-08-20T12:00:00Z');

/** A pricer over a small item table */
const priceTable = {
    '/items/cheese:0': 100,
    '/items/milk:0': 40,
    '/items/log:0': 10,
    '/items/sword:0': 1000,
    '/items/sword:5': 9000,
    '/items/apple:0': 7,
    '/items/coffee:0': 25,
    '/items/prime_catalyst:0': 500,
};
const price = (itemHrid, enhancementLevel = 0) => priceTable[`${itemHrid}:${enhancementLevel || 0}`] ?? null;

describe('day helpers', () => {
    test('localDayId and daysBetween walk whole local days', () => {
        expect(localDayId(D20)).toBe('2026-08-20');
        expect(daysBetween(D18, D20)).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    });

    test('splitDropKey separates an enhancement level from the hrid', () => {
        expect(splitDropKey('/items/sword::5')).toEqual({ itemHrid: '/items/sword', enhancementLevel: 5 });
        expect(splitDropKey('/items/milk')).toEqual({ itemHrid: '/items/milk', enhancementLevel: 0 });
    });

    test('lootEntryValue prices every drop in an entry', () => {
        const entry = { drops: { '/items/milk': 3, '/items/sword::5': 1 } };
        expect(lootEntryValue(entry, price)).toBe(3 * 40 + 9000);
    });

    test('dailyCloses keeps the last snapshot of each day', () => {
        const closes = dailyCloses([
            { t: D20 - 3600_000, total: 100 },
            { t: D20, total: 250 },
            { t: D19, total: 50 },
        ]);
        expect(closes).toEqual({ '2026-08-19': 50, '2026-08-20': 250 });
    });
});

describe('combat session loot', () => {
    const session = {
        players: [
            { isCurrentPlayer: false, loot: { a: { itemHrid: '/items/cheese', count: 100 } } },
            {
                isCurrentPlayer: true,
                loot: { a: { itemHrid: '/items/milk', count: 2 }, b: { itemHrid: '/items/milk', count: 3 } },
            },
        ],
    };

    test('ownCombatPlayer picks the flagged player, and the only one when nothing is flagged', () => {
        expect(ownCombatPlayer(session).isCurrentPlayer).toBe(true);
        expect(ownCombatPlayer({ players: [{ name: 'solo' }] }).name).toBe('solo');
        expect(ownCombatPlayer(null)).toBeNull();
    });

    test('ownCombatPlayer picks the flagged player regardless of slot', () => {
        const flaggedButSecond = {
            players: [
                { name: 'Slot0', isCurrentPlayer: false },
                { name: 'Slot1', isCurrentPlayer: true },
            ],
        };
        expect(ownCombatPlayer(flaggedButSecond).name).toBe('Slot1');
    });

    test('an unflagged party run is not credited to slot 0', () => {
        // Before the fix this fell back to players[0] and the loot row silently
        // credited this account with slot 0's drops in any unflagged party run.
        const unflaggedParty = {
            players: [
                { name: 'Slot0', loot: { a: { itemHrid: '/items/cheese', count: 100 } } },
                { name: 'Slot1', loot: { a: { itemHrid: '/items/milk', count: 2 } } },
            ],
        };
        expect(ownCombatPlayer(unflaggedParty)).toBeNull();
        expect(combatSessionLootValue(unflaggedParty, price)).toEqual({ value: 0, items: 0 });
    });

    test('two slots of one item are added rather than one overwriting the other', () => {
        expect(combatSessionLootValue(session, price)).toEqual({ value: 5 * 40, items: 2 });
    });

    test('an unpriced drop is worth nothing but still counts as a recorded entry', () => {
        const unpriced = {
            players: [{ isCurrentPlayer: true, loot: { a: { itemHrid: '/items/never_listed', count: 900 } } }],
        };
        expect(combatSessionLootValue(unpriced, price)).toEqual({ value: 0, items: 1 });
    });

    test('coin drops are coins - face value, no market lookup', () => {
        // The pricer knows no price for coin, which used to value every combat
        // coin drop at nothing and leave it in the residual
        const coins = { players: [{ isCurrentPlayer: true, loot: { a: { itemHrid: '/items/coin', count: 900 } } }] };
        expect(combatSessionLootValue(coins, price)).toEqual({ value: 900, items: 1 });
    });

    test('loot log coin drops are face value too, so the row cannot jump with its source', () => {
        const entry = { drops: { '/items/coin::0': 250, '/items/milk::0': 1 } };
        expect(lootEntryValue(entry, price)).toBe(250 + 40);
    });

    test('a run with no loot map at all records no entries', () => {
        expect(combatSessionLootValue({ players: [{ isCurrentPlayer: true }] }, price)).toEqual({ value: 0, items: 0 });
    });
});

describe('alchemySessionNet', () => {
    test('outputs less the inputs every attempt consumed', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/milk',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 4 } },
        };
        // 4 cheese at 100 minus 10 milk at 40
        expect(alchemySessionNet(session, price)).toBe(400 - 400);
    });

    test('a run that produced less than it ate is negative, not zero', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/milk',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 1 } },
        };
        expect(alchemySessionNet(session, price)).toBe(100 - 400);
    });

    test('coinify coins and catalysts both count', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/log',
            totalAttempts: 5,
            totalCoinsEarned: 900,
            primeCatalystUsed: 1,
        };
        expect(alchemySessionNet(session, price)).toBe(900 - 5 * 10 - 500);
    });

    test('an unpriceable output falls back to the value recorded at the time', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/log',
            totalAttempts: 1,
            results: { '/items/unknown_thing': { count: 2, totalValue: 777 } },
        };
        expect(alchemySessionNet(session, price)).toBe(777 - 10);
    });

    test('an unpriceable input is not a free one — the session is not valued at all', () => {
        // `price()` has no entry for the input, so num(null) used to fall
        // through to zero cost and the whole output read as pure profit
        const session = {
            startTime: D20,
            inputItemHrid: '/items/unknown_input',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 4 } },
        };
        expect(alchemySessionNet(session, price)).toBeNull();
    });

    test('no attempts means no input cost even when the input has no price', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/unknown_input',
            totalAttempts: 0,
            totalCoinsEarned: 50,
        };
        expect(alchemySessionNet(session, price)).toBe(50);
    });
});

describe('enhancementSessionNet', () => {
    test('value gained less what the run cost', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 3000 };
        expect(enhancementSessionNet(session, price)).toBe(9000 - 1000 - 3000);
    });

    test('a run that cost more than it added is a loss', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 50000 };
        expect(enhancementSessionNet(session, price)).toBe(9000 - 1000 - 50000);
    });

    test('an item with no price at one of its levels is not valued at all', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 20, totalCost: 10 };
        expect(enhancementSessionNet(session, price)).toBeNull();
    });

    test('an unpriced base level falls back to its cost basis, the one net worth carries it at', () => {
        // A craftable item nobody lists: no market at +0, a real market at +5.
        // Net worth values the unpriced base at its material cost, so the run
        // measured against that basis is exactly the net worth movement.
        const marketOnly = (itemHrid, level) => (level === 5 ? 9000 : null);
        const basis = (itemHrid, level) => (level === 0 ? 2000 : null);
        const session = { itemHrid: '/items/handmade_cape', startLevel: 0, currentLevel: 5, totalCost: 3000 };

        expect(enhancementSessionNet(session, marketOnly)).toBeNull();
        expect(enhancementSessionNet(session, marketOnly, basis)).toBe(9000 - 2000 - 3000);
    });

    test('a high level the basis pricer declines still nulls the session', () => {
        // The basis pricer only answers at level 0 — a material cost is a
        // base-item figure — so an unpriced +20 is not mis-valued at it
        const marketOnly = () => null;
        const basis = (itemHrid, level) => (level === 0 ? 2000 : null);
        const session = { itemHrid: '/items/handmade_cape', startLevel: 0, currentLevel: 20, totalCost: 10 };

        expect(enhancementSessionNet(session, marketOnly, basis)).toBeNull();
    });

    test('a run that went nowhere on an unpriced item is its cost, not unvaluable', () => {
        // Start and end both at the basis: the item's valuation did not move,
        // and the account is down exactly what the run spent
        const basis = (itemHrid, level) => (level === 0 ? 2000 : null);
        const session = { itemHrid: '/items/handmade_cape', startLevel: 0, currentLevel: 0, totalCost: 500 };

        expect(enhancementSessionNet(session, () => null, basis)).toBe(-500);
    });
});

describe('marketplaceByDay', () => {
    test('each side of a trade counts its gap to the valuation on the day it fills, tax apart', () => {
        // Cheese carried at 100: bought at 90, sold at 120
        const fills = [
            { t: D18, itemHrid: '/items/cheese', side: 'buy', quantity: 10, price: 90, coins: 900 },
            { t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 10, price: 120, coins: 1140 },
        ];
        const byDay = marketplaceByDay(fills, 0.05, price);
        expect(byDay['2026-08-18'].value).toBe(100);
        expect(byDay['2026-08-20'].value).toBe(200);
        expect(byDay['2026-08-20'].tax).toBe(60);
    });

    test('buying at an ask above the valuation is a loss the day it fills, not nothing', () => {
        const fills = [{ t: D20, itemHrid: '/items/cheese', side: 'buy', quantity: 1, price: 110, coins: 110 }];
        expect(marketplaceByDay(fills, 0.05, price)['2026-08-20'].value).toBe(-10);
    });

    test('a sell with no recorded buy still counts what it raised against the valuation', () => {
        const fills = [{ t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 5, price: 100, coins: 475 }];
        const byDay = marketplaceByDay(fills, 0.05, price);
        expect(byDay['2026-08-20'].value).toBe(0);
        expect(byDay['2026-08-20'].tax).toBe(25);
    });

    test('an item net worth cannot value is counted and left out, and its tax still counts', () => {
        const fills = [
            { t: D20, itemHrid: '/items/mystery', side: 'sell', quantity: 2, price: 500, coins: 950 },
            { t: D20, itemHrid: '/items/mystery', side: 'buy', quantity: 1, price: 400, coins: 400 },
        ];
        const day = marketplaceByDay(fills, 0.05, price)['2026-08-20'];
        expect(day).toEqual({ value: 0, tax: 50, unpriced: 2 });
    });
});

describe('attributeGoldSources', () => {
    const actionType = (hrid) =>
        ({
            '/actions/combat/cow': '/action_types/combat',
            '/actions/milking/cow': '/action_types/milking',
            '/actions/cooking/pie': '/action_types/cooking',
        })[hrid] || null;

    const base = {
        from: D19,
        to: D20 + 3600_000,
        price,
        marketTax: 0.05,
        actionType,
        series: [
            { t: D18, total: 0 },
            { t: D19, total: 5000 },
            { t: D20, total: 25000 },
        ],
    };

    test('combat and gathering are read from the loot log and kept apart', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/log': 10 },
                },
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/milking/cow',
                    drops: { '/items/milk': 5 },
                },
            ],
        });

        expect(result.totals.sources.combat).toBe(100);
        expect(result.totals.sources.gathering).toBe(200);
    });

    test('production loot entries are ignored, so the recorder is not double counted', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/cooking/pie',
                    drops: { '/items/cheese': 100 },
                },
            ],
            productionDays: [{ d: '2026-08-20', outputValue: 10000, inputValue: 4000 }],
        });

        expect(result.totals.sources.combat).toBe(0);
        expect(result.totals.sources.gathering).toBe(0);
        expect(result.totals.sources.production).toBe(6000);
    });

    test('a gathering entry is spread over the span it ran, less any time offline', () => {
        // A foraging queue begun ten days before the 20th, the loot log opened
        // at noon on the 20th: booked to its start day it sat outside the
        // window. 10.5 days at 1,000 a day, and six hours of the 20th offline
        const start = dayStart('2026-08-20') - 10 * DAY;
        const end = dayStart('2026-08-20') + 12 * 3600_000;
        const offline = [dayStart('2026-08-20'), dayStart('2026-08-20') + 6 * 3600_000];
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(start).toISOString(),
                    endTime: new Date(end).toISOString(),
                    actionHrid: '/actions/milking/cow',
                    drops: { '/items/milk': 262.5 },
                },
            ],
            combatLootDays: [{ d: '2026-08-20', runs: {}, offline: [offline] }],
        });

        const perDay = Object.fromEntries(result.days.map((row) => [row.day, row.sources.gathering]));
        expect(perDay['2026-08-19']).toBeCloseTo(1000, 6);
        // Twelve hours of the 20th ran, six of them offline
        expect(perDay['2026-08-20']).toBeCloseTo(250, 6);
    });

    test('the residual is the measured change minus what was explained, and is never spread', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/cheese': 50 },
                },
            ],
        });

        // The window covers the 19th and the 20th, so the change is measured
        // from the 18th's close: 0 -> 25000, of which 5000 is explained
        expect(result.totals.delta).toBe(25000);
        expect(result.totals.explained).toBe(5000);
        expect(result.totals.residual).toBe(20000);
        // Nothing was moved into the source rows to close the gap
        expect(result.totals.sources.combat).toBe(5000);
    });

    test('a day with no snapshot has no delta and no residual rather than an invented one', () => {
        const result = attributeGoldSources({
            ...base,
            from: D18,
            series: [
                { t: D18, total: 1000 },
                { t: D20, total: 4000 },
            ],
            productionDays: [{ d: '2026-08-19', outputValue: 500, inputValue: 0 }],
        });

        const quiet = result.days.find((row) => row.day === '2026-08-19');
        expect(quiet.delta).toBeNull();
        expect(quiet.residual).toBeNull();
        expect(quiet.sources.production).toBe(500);
        // The window's own delta is still measured end to end
        expect(result.totals.delta).toBe(3000);
    });

    test('costs come through negative', () => {
        const result = attributeGoldSources({
            ...base,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, consumables: [{ itemHrid: '/items/coffee', consumed: 8 }] }],
                },
            ],
            tradeFills: [{ t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 5, price: 100, coins: 475 }],
        });

        expect(result.totals.sources.consumables).toBe(-200);
        expect(result.totals.sources.marketTax).toBe(-25);
    });

    test('a multi-day session spreads its loot across the days it ran, by time', () => {
        // A run starting LOCAL noon of D19 and lasting 48h: a quarter of it
        // on D19, half on D20, a quarter on D21 — only D19+D20 are in the window
        const session = run(dayStart('2026-08-19') + 12 * 3600_000, { '/items/cheese': 100 });
        session.durationSeconds = 48 * 3600;

        const result = attributeGoldSources({
            ...base,
            to: D20 + 12 * 3600_000,
            combatSessions: [session],
        });

        // cheese prices at 100 in the base pricer: 100 × 100 = 10,000 total,
        // 25% on D19 and 50% on D20 land in the window
        const perDay = Object.fromEntries(result.days.map((row) => [row.day, row.sources.combat]));
        expect(perDay['2026-08-19']).toBeCloseTo(2500, 0);
        expect(perDay['2026-08-20']).toBeCloseTo(5000, 0);
    });

    test('a run the loot log saw part of counts once, and never more than it dropped', () => {
        // One 24h run, noon D19 to noon D20, evenly split by time (50/50) —
        // but the loot log, opened until 18:00 on D19, saw MOST of the run's
        // value there (90 of the 100 cheese), not the 50 a time-split would
        // guess. Spreading the run's whole total over both days on top of the
        // log would claim 14,000 from a run that dropped 10,000 (9555ba799).
        //
        // The log's entry and the archived run read the same running total,
        // so they are two points on one curve: 9,000 by 18:00 on D19, 10,000
        // by noon D20. The run is worth what the more complete one saw, and
        // the log's reading puts its share on the day it was seen.
        const start = dayStart('2026-08-19') + 12 * 3600_000;
        const session = run(start, { '/items/cheese': 100 });
        session.durationSeconds = 24 * 3600;

        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(start, { '/items/cheese': 90 }, start + 6 * 3600_000)],
            combatSessions: [session],
        });

        const perDay = Object.fromEntries(result.days.map((row) => [row.day, row.sources.combat]));
        // 9,000 by 18:00, then the last 1,000 over the 18 hours to noon D20
        expect(perDay['2026-08-19']).toBeCloseTo(9000 + (1000 * 6) / 18, 6);
        expect(perDay['2026-08-20']).toBeCloseTo((1000 * 12) / 18, 6);
        expect(result.totals.sources.combat).toBeCloseTo(10000, 6);
        expect(result.combatBasis.uncoveredDays).toBe(0);
    });

    test('a long-running live session still pays into today even though it started before the window', () => {
        const session = run(D18, { '/items/cheese': 100 });
        session.durationSeconds = (D20 + 3600_000 - D18) / 1000;

        const result = attributeGoldSources({
            ...base,
            combatSessions: [session],
        });

        expect(result.totals.sources.combat).toBeGreaterThan(0);
    });

    test('offline income is its own row', () => {
        const result = attributeGoldSources({
            ...base,
            productionDays: [{ d: '2026-08-20', outputValue: 0, inputValue: 0, offlineProfit: 1234 }],
        });
        expect(result.totals.sources.offline).toBe(1234);
        expect(result.totals.sources.production).toBe(0);
    });

    test('unpriceable enhancement runs are counted, not silently valued at zero', () => {
        const result = attributeGoldSources({
            ...base,
            enhancementSessions: [
                { startTime: D20, itemHrid: '/items/sword', startLevel: 0, currentLevel: 20, totalCost: 10 },
                { startTime: D20, itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 1000 },
            ],
        });

        expect(result.unpricedEnhancementSessions).toBe(1);
        expect(result.totals.sources.enhancement).toBe(9000 - 1000 - 1000);
    });

    test('the enhancement row reaches the cost-basis fallback the alchemy row gets', () => {
        const result = attributeGoldSources({
            ...base,
            basisPrice: (itemHrid, level) =>
                itemHrid === '/items/handmade_cape' && level === 0 ? 2000 : price(itemHrid, level),
            enhancementSessions: [
                // No market at +0; the basis prices it where net worth does
                { startTime: D20, itemHrid: '/items/handmade_cape', startLevel: 0, currentLevel: 0, totalCost: 700 },
            ],
        });

        expect(result.unpricedEnhancementSessions).toBe(0);
        expect(result.totals.sources.enhancement).toBe(-700);
    });

    test('unpriceable alchemy inputs are counted, not silently valued at zero', () => {
        const result = attributeGoldSources({
            ...base,
            alchemySessions: [
                // No price for the input: this run's gross output must not
                // read as pure profit
                {
                    startTime: D20,
                    inputItemHrid: '/items/unknown_input',
                    totalAttempts: 10,
                    results: { '/items/cheese': { count: 4 } },
                },
                {
                    startTime: D20,
                    inputItemHrid: '/items/milk',
                    totalAttempts: 10,
                    results: { '/items/cheese': { count: 4 } },
                },
            ],
        });

        expect(result.unpricedAlchemySessions).toBe(1);
        // Only the priceable session (400 cheese out - 400 milk in = 0) counts
        expect(result.totals.sources.alchemy).toBe(0);
    });

    describe('sessions are spread over the days they ran', () => {
        // Six hours of the run on the 19th and eighteen on the 20th, measured
        // from local midnight so the split is the same wherever the test runs
        const d20Start = dayStart(localDayId(D20));
        const spanStart = d20Start - 6 * 3600_000;
        const spanEnd = d20Start + 18 * 3600_000;
        const perDay = (result, key) => Object.fromEntries(result.days.map((row) => [row.day, row.sources[key]]));

        /** An alchemy run netting 800 out - 400 in = 400 */
        const alchemyRun = (extra) => ({
            startTime: spanStart,
            inputItemHrid: '/items/milk',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 8 } },
            ...extra,
        });

        test('an alchemy run that crossed midnight splits by the time it spent each side', () => {
            const result = attributeGoldSources({
                ...base,
                alchemySessions: [alchemyRun({ lastActivityTime: spanEnd })],
            });

            expect(perDay(result, 'alchemy')).toEqual({ '2026-08-19': 100, '2026-08-20': 300 });
            expect(result.totals.sources.alchemy).toBe(400);
        });

        test('an alchemy session with no recorded end still books to its start day, whole', () => {
            const result = attributeGoldSources({ ...base, alchemySessions: [alchemyRun()] });

            expect(perDay(result, 'alchemy')).toEqual({ '2026-08-19': 400, '2026-08-20': 0 });
        });

        test('an enhancement run spreads over its span, by its last attempt', () => {
            const result = attributeGoldSources({
                ...base,
                enhancementSessions: [
                    {
                        startTime: spanStart,
                        lastUpdateTime: spanEnd,
                        itemHrid: '/items/sword',
                        startLevel: 0,
                        currentLevel: 5,
                        totalCost: 1000,
                    },
                ],
            });

            // 9000 - 1000 - 1000 = 7000, quartered onto the 19th
            expect(perDay(result, 'enhancement')).toEqual({ '2026-08-19': 1750, '2026-08-20': 5250 });
        });

        test('a legacy enhancement session without either stamp books to its start day, whole', () => {
            const result = attributeGoldSources({
                ...base,
                enhancementSessions: [
                    { startTime: spanStart, itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 1000 },
                ],
            });

            expect(perDay(result, 'enhancement')).toEqual({ '2026-08-19': 7000, '2026-08-20': 0 });
        });

        test('a run that began before the window still pays the days of it that are inside', () => {
            const result = attributeGoldSources({
                ...base,
                // Two days before the window opens, still going on the 20th
                alchemySessions: [alchemyRun({ startTime: d20Start - 2 * DAY, lastActivityTime: d20Start + 2 * DAY })],
            });

            // Four days of run, so a quarter each; the two in the window are paid
            expect(result.totals.sources.alchemy).toBe(200);
        });

        test('an unpriceable run is counted once when any of its days is in the window', () => {
            const result = attributeGoldSources({
                ...base,
                alchemySessions: [
                    alchemyRun({
                        // Begins before the window and runs into it
                        startTime: d20Start - 2 * DAY,
                        lastActivityTime: spanEnd,
                        inputItemHrid: '/items/unknown_input',
                    }),
                ],
            });

            expect(result.unpricedAlchemySessions).toBe(1);
        });

        test('a run that ended before the window opened is not counted at all', () => {
            const result = attributeGoldSources({
                ...base,
                alchemySessions: [
                    alchemyRun({
                        startTime: d20Start - 5 * DAY,
                        lastActivityTime: d20Start - 4 * DAY,
                        inputItemHrid: '/items/unknown_input',
                    }),
                ],
            });

            expect(result.unpricedAlchemySessions).toBe(0);
            expect(result.totals.sources.alchemy).toBe(0);
        });
    });

    test('coverage reports when each recording starts', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                { startTime: new Date(D18).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
                { startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
            ],
            productionDays: [{ d: '2026-08-19', outputValue: 1, inputValue: 0 }],
        });

        expect(result.coverage.combat).toBe(D18);
        expect(result.coverage.production).toBe(dayStart('2026-08-19'));
        expect(result.coverage.alchemy).toBeNull();
    });

    test('combat and gathering coverage are split the way the attribution splits them', () => {
        // Both live in the loot log, so answering both with the log's earliest
        // entry claimed combat had been recorded since a date on which only
        // foraging had — coverage for a source that had never been seen
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                { startTime: new Date(D18).toISOString(), actionHrid: '/actions/milking/cow', drops: {} },
                { startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
            ],
        });

        expect(result.coverage.gathering).toBe(D18);
        expect(result.coverage.combat).toBe(D20);
    });

    test('gathering coverage is null when only combat has ever been logged', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [{ startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} }],
        });

        expect(result.coverage.gathering).toBeNull();
    });

    test('production actions nothing could be priced for are counted and reported', () => {
        const result = attributeGoldSources({
            ...base,
            productionDays: [
                { d: '2026-08-19', outputValue: 100, inputValue: 40, actions: 2, unpricedActions: 7 },
                // Outside the window, so its uncounted actions are not this window's
                { d: '2026-08-01', outputValue: 0, inputValue: 0, unpricedActions: 3 },
            ],
        });

        expect(result.unpricedProductionActions).toBe(7);
    });

    /** An archived run, its loot map keyed the way the game keys it */
    const run = (t, loot, { partyLoot = null, consumables = [] } = {}) => ({
        combatStartTime: new Date(t).toISOString(),
        players: [
            {
                isCurrentPlayer: true,
                loot: Object.fromEntries(
                    Object.entries(loot).map(([itemHrid, count], index) => [String(index), { itemHrid, count }])
                ),
                consumables,
            },
            ...(partyLoot
                ? [
                      {
                          isCurrentPlayer: false,
                          loot: Object.fromEntries(
                              Object.entries(partyLoot).map(([itemHrid, count], index) => [
                                  `p${index}`,
                                  { itemHrid, count },
                              ])
                          ),
                          consumables: [],
                      },
                  ]
                : []),
        ],
    });

    /** A combat loot log entry, and when its drops were last current */
    const combatEntry = (t, drops, end = null) => ({
        startTime: new Date(t).toISOString(),
        ...(end === null ? {} : { endTime: new Date(end).toISOString() }),
        actionHrid: '/actions/combat/cow',
        drops,
    });

    test('a run the loot log and the archive both hold counts once, never both', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(D20, { '/items/cheese': 10 })],
            // The same day's run is in the history too; adding it would count
            // the same drops twice
            combatSessions: [run(D20, { '/items/cheese': 10 })],
        });

        expect(result.totals.sources.combat).toBe(1000);
        expect(result.combatBasis.lootLogDays).toBe(1);
        expect(result.combatBasis.sessionDays).toBe(0);
    });

    test('a day the loot log missed falls back to the run’s own loot', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [],
            combatSessions: [run(D20, { '/items/cheese': 3, '/items/log': 2 })],
        });

        expect(result.totals.sources.combat).toBe(3 * 100 + 2 * 10);
        expect(result.combatBasis.sessionDays).toBe(1);
        expect(result.combatBasis.lootLogDays).toBe(0);
    });

    test('the fallback counts only this character’s loot, not the party’s', () => {
        const result = attributeGoldSources({
            ...base,
            combatSessions: [run(D20, { '/items/cheese': 1 }, { partyLoot: { '/items/cheese': 50 } })],
        });

        expect(result.totals.sources.combat).toBe(100);
    });

    test('each run counts the most any recording of it saw, whichever that was', () => {
        // The 20th's run is in the loot log at 10 cheese and in the archive at
        // 999: one run, read twice, the log's copy stale. It used to be the
        // loot log's day outright and read 1,000
        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(D20, { '/items/cheese': 10 })],
            combatSessions: [run(D19, { '/items/log': 5 }), run(D20, { '/items/cheese': 999 })],
        });

        expect(result.totals.sources.combat).toBe(99900 + 50);
        // Both raised the 20th's total — the log to its 1,000, the archive the rest
        expect(result.combatBasis.lootLogDays).toBe(1);
        expect(result.combatBasis.sessionDays).toBe(2);
        expect(result.combatBasis.uncoveredDays).toBe(0);
    });

    test('a loot log entry worth nothing does not hide what the run’s own record saw', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(D20, {})],
            combatSessions: [run(D20, { '/items/cheese': 10 })],
        });

        expect(result.totals.sources.combat).toBe(1000);
        expect(result.combatBasis.lootLogDays).toBe(0);
        expect(result.combatBasis.sessionDays).toBe(1);
    });

    test('runs with an empty loot map leave a counted gap rather than a confident zero', () => {
        const result = attributeGoldSources({
            ...base,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, loot: {}, consumables: [] }],
                },
            ],
        });

        expect(result.totals.sources.combat).toBe(0);
        expect(result.combatBasis.emptySessions).toBe(1);
        expect(result.combatBasis.combatRan).toBe(true);
        // Both days of the window are uncovered — the run recorded no loot and
        // the loot log recorded nothing at all
        expect(result.combatBasis.uncoveredDays).toBe(2);
    });

    test('an unflagged party run credits neither loot nor consumables to slot 0', () => {
        // A snapshot from before the isCurrentPlayer flag existed, recorded on a
        // party run. Before the fix, ownCombatPlayer fell back to players[0] and
        // this account's ledger picked up someone else's cheese and coffee.
        const result = attributeGoldSources({
            ...base,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [
                        {
                            name: 'Slot0',
                            loot: { a: { itemHrid: '/items/cheese', count: 100 } },
                            consumables: [{ itemHrid: '/items/coffee', consumed: 8 }],
                        },
                        { name: 'Slot1', loot: {}, consumables: [] },
                    ],
                },
            ],
        });

        // Both the loot row and the consumables row go through ownCombatPlayer
        // and must agree: this run is unattributed on both, not just one
        expect(result.totals.sources.combat).toBe(0);
        expect(result.totals.sources.consumables).toBe(0);
        expect(result.combatBasis.emptySessions).toBe(1);
    });

    test('consumables alone are enough to prove combat ran on an unrecorded day', () => {
        const result = attributeGoldSources({
            ...base,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, consumables: [{ itemHrid: '/items/coffee', consumed: 8 }] }],
                },
            ],
        });

        expect(result.totals.sources.consumables).toBe(-200);
        expect(result.combatBasis.combatRan).toBe(true);
        expect(result.combatBasis.uncoveredDays).toBe(2);
    });

    test('a character that never fought has no gap, because it has no combat', () => {
        const result = attributeGoldSources({ ...base, combatSessions: [], lootEntries: [] });
        expect(result.combatBasis.combatRan).toBe(false);
        expect(result.combatBasis.uncoveredDays).toBe(0);
    });

    test('the retained-run bound is reported so the fallback’s reach is not overstated', () => {
        const sessions = [];
        for (let i = 0; i < 20; i += 1) sessions.push(run(D20 - i * 60_000, { '/items/log': 1 }));
        const result = attributeGoldSources({ ...base, combatSessions: sessions, sessionCap: 20 });

        expect(result.combatBasis.sessionsHeld).toBe(20);
        expect(result.combatBasis.sessionCap).toBe(20);
        // Twenty runs all landed on the 20th, so the 19th is still uncovered
        expect(result.combatBasis.uncoveredDays).toBe(1);
    });

    test('combat coverage falls back to the oldest archived run when the loot log is silent', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [],
            combatSessions: [run(D19, { '/items/log': 1 }), run(D20, { '/items/log': 1 })],
        });

        expect(result.coverage.combat).toBe(D19);
        expect(result.combatBasis.lastLootLog).toBeNull();
    });

    test('the loot log’s last recording is reported for the coverage line', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(D19, { '/items/log': 1 }), combatEntry(D20, { '/items/log': 1 })],
        });

        expect(result.combatBasis.lastLootLog).toBe(D20);
    });

    test('consumables attribution is untouched by the loot fallback', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [combatEntry(D20, { '/items/cheese': 10 })],
            combatSessions: [
                run(D20, { '/items/cheese': 10 }, { consumables: [{ itemHrid: '/items/coffee', consumed: 8 }] }),
            ],
        });

        expect(result.totals.sources.consumables).toBe(-200);
        expect(result.totals.sources.combat).toBe(1000);
    });

    describe('combat drops that used to go missing', () => {
        const HOUR = 3600_000;
        const iso = (t) => new Date(t).toISOString();
        const withDuration = (session, seconds) => ({ ...session, durationSeconds: seconds });
        /** A live recorder reading of a run's running total */
        const reading = (t, loot) => ({ t, loot });
        /** One day's recorder row for one run, as unbroken stretches of readings */
        const liveRow = (d, start, stretches, offline = null) => ({
            d,
            runs: { [iso(start)]: { stretches: stretches.map(([first, last]) => ({ first, last })) } },
            ...(offline ? { offline } : {}),
        });
        const perDay = (result) => Object.fromEntries(result.days.map((row) => [row.day, row.sources.combat]));

        test('a loot log opened for the first hour of a ten-hour run no longer hides the other nine', () => {
            // The log entry is the game's first-hour snapshot of the run; the
            // day used to be the loot log's, and read 1,000 of 10,000
            const start = dayStart('2026-08-20') + 6 * HOUR;
            const result = attributeGoldSources({
                ...base,
                lootEntries: [combatEntry(start, { '/items/cheese': 10 }, start + HOUR)],
                combatSessions: [withDuration(run(start, { '/items/cheese': 100 }), 10 * 3600)],
            });

            expect(result.totals.sources.combat).toBeCloseTo(10000, 6);
        });

        test('a second run the same day counts though the loot log saw only the first', () => {
            // The day used to be the loot log's the moment it held one combat
            // entry, and the unlogged evening run was thrown away
            const morning = dayStart('2026-08-20') + 8 * HOUR;
            const evening = dayStart('2026-08-20') + 14 * HOUR;
            const result = attributeGoldSources({
                ...base,
                lootEntries: [combatEntry(morning, { '/items/cheese': 10 }, morning + 2 * HOUR)],
                combatSessions: [
                    withDuration(run(morning, { '/items/cheese': 10 }), 2 * 3600),
                    withDuration(run(evening, { '/items/log': 500 }), 6 * 3600),
                ],
            });

            expect(result.totals.sources.combat).toBeCloseTo(1000 + 5000, 6);
        });

        test('a loot log entry is spread over the span it ran, not booked to the day it began', () => {
            // An AFK grind begun eleven days before the 20th, the loot log
            // opened at noon on the 20th: the whole run used to land on its
            // start day, outside the window, and combat read 0
            const start = dayStart('2026-08-20') - 11 * DAY;
            const end = dayStart('2026-08-20') + 12 * HOUR;
            // 11.5 days at 10,000 a day
            const result = attributeGoldSources({
                ...base,
                lootEntries: [combatEntry(start, { '/items/cheese': 1150 }, end)],
            });

            expect(perDay(result)['2026-08-19']).toBeCloseTo(10000, 6);
            expect(perDay(result)['2026-08-20']).toBeCloseTo(5000, 6);
        });

        test('the live feed splits a run across midnight exactly where the tab watched it', () => {
            // The archived run alone would split this 40/60 by time; the feed
            // read 30 cheese at midnight and 50 by six in the morning
            const start = dayStart('2026-08-20') - 4 * HOUR;
            const midnight = dayStart('2026-08-20');
            const result = attributeGoldSources({
                ...base,
                combatLootDays: [
                    liveRow('2026-08-19', start, [
                        [reading(start + 60_000, {}), reading(midnight - 1000, { '/items/cheese': 30 })],
                    ]),
                    liveRow('2026-08-20', start, [
                        [
                            reading(midnight + 1000, { '/items/cheese': 30 }),
                            reading(midnight + 6 * HOUR, { '/items/cheese': 50 }),
                        ],
                    ]),
                ],
                combatSessions: [withDuration(run(start, { '/items/cheese': 50 }), 10 * 3600)],
            });

            expect(perDay(result)['2026-08-19']).toBeCloseTo(3000, 6);
            expect(perDay(result)['2026-08-20']).toBeCloseTo(2000, 6);
            expect(result.totals.sources.combat).toBeCloseTo(5000, 6);
            expect(result.combatBasis.liveDays).toBe(2);
        });

        test('the loot log adds only the tail the live feed did not see', () => {
            // The tab watched 08:00-10:00 (20 cheese); the run went on to 14:00
            // and the loot log, opened afterwards, saw all 60. Adding the two
            // would claim 80
            const start = dayStart('2026-08-20') + 8 * HOUR;
            const result = attributeGoldSources({
                ...base,
                combatLootDays: [
                    liveRow('2026-08-20', start, [
                        [reading(start + 60_000, {}), reading(start + 2 * HOUR, { '/items/cheese': 20 })],
                    ]),
                ],
                lootEntries: [combatEntry(start, { '/items/cheese': 60 }, start + 6 * HOUR)],
            });

            expect(result.totals.sources.combat).toBeCloseTo(6000, 6);
            expect(result.combatBasis.liveDays).toBe(1);
            expect(result.combatBasis.lootLogDays).toBe(1);
        });

        test('combat that ran while offline is left to the offline row, which already counts it', () => {
            // Watched 01:00-05:00 (40 cheese), offline 05:00-09:00, watched
            // again 09:00-10:00. The 40 cheese the run gained across the
            // offline window are in the Welcome Back summary's item delta
            const start = dayStart('2026-08-20') + HOUR;
            const logout = start + 4 * HOUR;
            const login = logout + 4 * HOUR;
            const result = attributeGoldSources({
                ...base,
                combatLootDays: [
                    liveRow(
                        '2026-08-20',
                        start,
                        [
                            [reading(start, {}), reading(logout, { '/items/cheese': 40 })],
                            [reading(login, { '/items/cheese': 80 }), reading(login + HOUR, { '/items/cheese': 90 })],
                        ],
                        [[logout, login]]
                    ),
                ],
            });

            expect(result.totals.sources.combat).toBeCloseTo(4000 + 1000, 6);
            expect(result.combatBasis.offlineCombat).toBeCloseTo(4000, 6);
        });

        test('food eaten while offline is left to the offline row too', () => {
            const start = dayStart('2026-08-20') + HOUR;
            const session = withDuration(
                run(start, {}, { consumables: [{ itemHrid: '/items/coffee', consumed: 8 }] }),
                8 * 3600
            );
            const result = attributeGoldSources({
                ...base,
                combatSessions: [session],
                combatLootDays: [{ d: '2026-08-20', runs: {}, offline: [[start + 4 * HOUR, start + 8 * HOUR]] }],
            });

            // Half the run was offline, so half its 200 of coffee is the offline row's
            expect(result.totals.sources.consumables).toBeCloseTo(-100, 6);
        });

        test('an entry lying across a different run is set aside, not added on top of it', () => {
            // A loot log entry whose start matches no run, inside the span of
            // an archived one: one action cannot be two runs, and adding it
            // would count that run's drops again
            const start = dayStart('2026-08-20') + 2 * HOUR;
            const result = attributeGoldSources({
                ...base,
                lootEntries: [combatEntry(start + 3 * HOUR, { '/items/cheese': 40 }, start + 5 * HOUR)],
                combatSessions: [withDuration(run(start, { '/items/cheese': 100 }), 8 * 3600)],
            });

            expect(result.totals.sources.combat).toBeCloseTo(10000, 6);
            expect(result.combatBasis.ambiguousEntries).toBe(1);
        });

        test('a loot log entry nothing else recorded counts whole over its own span', () => {
            const start = dayStart('2026-08-20') + 2 * HOUR;
            const result = attributeGoldSources({
                ...base,
                lootEntries: [combatEntry(start, { '/items/cheese': 40 }, start + 5 * HOUR)],
                combatSessions: [withDuration(run(start + 6 * HOUR, { '/items/log': 100 }), 3600)],
            });

            expect(result.totals.sources.combat).toBeCloseTo(4000 + 1000, 6);
            expect(result.combatBasis.ambiguousEntries).toBe(0);
        });

        test('the live record reaching back past the window start lifts the run-cap warning', () => {
            const sessions = [];
            for (let i = 0; i < 20; i += 1) sessions.push(run(D20 - i * 60_000, { '/items/log': 1 }));
            const liveStart = D18;
            const result = attributeGoldSources({
                ...base,
                combatSessions: sessions,
                sessionCap: 20,
                combatLootDays: [liveRow('2026-08-18', liveStart, [[reading(liveStart, {}), reading(liveStart, {})]])],
            });

            expect(result.combatBasis.capReached).toBe(false);
            expect(result.combatBasis.liveSince).toBe(liveStart);
        });
    });

    test('activity outside the window is left out entirely', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D18 - 5 * DAY).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/cheese': 1000 },
                },
            ],
        });
        expect(result.totals.sources.combat).toBe(0);
    });
});

describe('gathering recorded live beside the loot log', () => {
    const HOUR = 3600_000;
    const MIDNIGHT = dayStart('2026-08-20');
    const MILKING = '/actions/milking/cow';
    const base = {
        from: D19,
        to: D20 + HOUR,
        price,
        actionType: (hrid) => (hrid === MILKING ? '/action_types/milking' : null),
    };
    /** A live stretch of the recorder, on the day it was watched */
    const live = (d, from, to, gained, id = '7') => ({
        d,
        gathering: { [id]: { a: MILKING, stretches: [{ from, to, gained }] } },
    });
    /** A milking loot log entry */
    const entry = (start, end, drops) => ({
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        actionHrid: MILKING,
        drops,
    });
    const perDay = (result) => Object.fromEntries(result.days.map((row) => [row.day, row.sources.gathering]));

    test('a completion recorded live counts on the day it was watched, with no loot log at all', () => {
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { '/items/milk': 10 })],
        });
        expect(perDay(result)['2026-08-20']).toBe(400);
        expect(result.coverage.gathering).toBe(MIDNIGHT + HOUR);
    });

    test('drops both recordings saw count once, never added together', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [entry(MIDNIGHT, MIDNIGHT + 2 * HOUR, { '/items/milk': 10 })],
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR / 2, MIDNIGHT + HOUR, { '/items/milk': 10 })],
        });
        expect(result.totals.sources.gathering).toBeCloseTo(400, 6);
    });

    test('the loot log adds only what the live record missed, over the time nobody watched', () => {
        // An entry from 23:00 on the 19th to 01:00 on the 20th; the tab watched
        // only the hour after midnight. The 800 the log saw beyond it belongs to
        // the unwatched hour, which is the 19th
        const result = attributeGoldSources({
            ...base,
            lootEntries: [entry(MIDNIGHT - HOUR, MIDNIGHT + HOUR, { '/items/milk': 30 })],
            itemFlowDays: [live('2026-08-20', MIDNIGHT, MIDNIGHT + HOUR, { '/items/milk': 10 })],
        });
        expect(perDay(result)['2026-08-19']).toBeCloseTo(800, 6);
        expect(perDay(result)['2026-08-20']).toBeCloseTo(400, 6);
    });

    test('a stale loot log entry adds nothing to what the live record already holds', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [entry(MIDNIGHT, MIDNIGHT + HOUR, { '/items/milk': 5 })],
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR / 4, MIDNIGHT + 3 * HOUR, { '/items/milk': 40 })],
        });
        expect(result.totals.sources.gathering).toBeCloseTo(1600, 6);
    });

    test('another action’s loot log entry is not taken for the live record’s', () => {
        const result = attributeGoldSources({
            ...base,
            actionType: () => '/action_types/milking',
            lootEntries: [
                { ...entry(MIDNIGHT, MIDNIGHT + HOUR, { '/items/milk': 5 }), actionHrid: '/actions/milking/goat' },
            ],
            itemFlowDays: [live('2026-08-20', MIDNIGHT, MIDNIGHT + HOUR, { '/items/milk': 10 })],
        });
        expect(result.totals.sources.gathering).toBeCloseTo(600, 6);
    });

    test('what the loot log saw in offline time is left to the offline row', () => {
        const offline = [MIDNIGHT - HOUR, MIDNIGHT];
        const result = attributeGoldSources({
            ...base,
            lootEntries: [entry(MIDNIGHT - HOUR, MIDNIGHT + HOUR, { '/items/milk': 30 })],
            itemFlowDays: [live('2026-08-20', MIDNIGHT, MIDNIGHT + HOUR, { '/items/milk': 10 })],
            combatLootDays: [{ d: '2026-08-20', runs: {}, offline: [offline] }],
        });
        expect(perDay(result)['2026-08-19']).toBe(0);
        expect(result.totals.sources.gathering).toBeCloseTo(400, 6);
    });
});

describe('dungeon keys', () => {
    const KEY = '/items/pirate_entry_key';
    const base = { from: D19, to: D20 + 3600_000 };

    test('keys spent are a cost at today’s price, on the day they were taken, and not a consumable', () => {
        const result = attributeGoldSources({
            ...base,
            price: (itemHrid) => (itemHrid === KEY ? 2_000_000 : null),
            itemFlowDays: [{ d: '2026-08-20', keys: { [KEY]: 3 } }],
        });
        const day = result.days.find((row) => row.day === '2026-08-20');
        expect(day.sources.dungeonKeys).toBe(-6_000_000);
        expect(result.totals.sources.consumables).toBe(0);
        expect(result.coverage.dungeonKeys).toBe(dayStart('2026-08-20'));
    });

    test('a key the market cannot price costs what net worth carried it at', () => {
        const result = attributeGoldSources({
            ...base,
            price: () => null,
            holdingPrice: (itemHrid) => (itemHrid === KEY ? 1_500_000 : null),
            itemFlowDays: [{ d: '2026-08-20', keys: { [KEY]: 1 } }],
        });
        expect(result.totals.sources.dungeonKeys).toBe(-1_500_000);
    });
});

describe('skilling drinks', () => {
    test('drinks used up skilling are a cost, and the combat consumables row is untouched by them', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price: (itemHrid) => (itemHrid === '/items/foraging_tea' ? 900 : null),
            itemFlowDays: [{ d: '2026-08-20', drinks: { '/items/foraging_tea': 40 } }],
        });
        expect(result.totals.sources.skillingDrinks).toBe(-36_000);
        expect(result.totals.sources.consumables).toBe(0);
        expect(result.totals.sources.dungeonKeys).toBe(0);
    });
});

describe('combat consumables recorded live beside the archived runs', () => {
    const HOUR = 3600_000;
    const MIDNIGHT = dayStart('2026-08-20');
    const COFFEE = '/items/coffee';
    const base = { from: D19, to: D20 + HOUR, price };

    /** A live stretch of the recorder, on the day it was watched */
    const live = (d, from, to, used) => ({
        d,
        combatConsumables: { stretches: [{ from, to, r: String(from), used }] },
    });
    /** An archived run and its own estimate of what it burned */
    const archived = (t, seconds, consumed) => ({
        combatStartTime: new Date(t).toISOString(),
        durationSeconds: seconds,
        players: [{ isCurrentPlayer: true, loot: {}, consumables: [{ itemHrid: COFFEE, consumed }] }],
    });
    const perDay = (result) => Object.fromEntries(result.days.map((row) => [row.day, row.sources.consumables]));

    test('a drink recorded live is a cost on the day it was drunk, with no archived run at all', () => {
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { [COFFEE]: 8 })],
        });
        expect(perDay(result)['2026-08-20']).toBe(-200);
        expect(result.coverage.consumables).toBe(MIDNIGHT + HOUR);
    });

    test('a run both recordings saw counts once, at the larger figure, never added together', () => {
        // The same hour: the live record counted 8 coffees, the run's own
        // estimate says 8 as well. One of them answers for it, not both
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { [COFFEE]: 8 })],
            combatSessions: [archived(MIDNIGHT + HOUR, 3600, 8)],
        });
        expect(result.totals.sources.consumables).toBeCloseTo(-200, 6);
    });

    test('the run adds only what the live record did not see', () => {
        // The tab watched 5 of the run's 8 coffees; the missing 3 are the
        // archive's to add, and nothing more
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { [COFFEE]: 5 })],
            combatSessions: [archived(MIDNIGHT + HOUR, 3600, 8)],
        });
        expect(result.totals.sources.consumables).toBeCloseTo(-200, 6);
    });

    test('a live record larger than the run’s estimate is not trimmed down to it', () => {
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { [COFFEE]: 12 })],
            combatSessions: [archived(MIDNIGHT + HOUR, 3600, 8)],
        });
        expect(result.totals.sources.consumables).toBeCloseTo(-300, 6);
    });

    test('a run the archive has rolled over still counts, from the live record alone', () => {
        // Yesterday's grind is off the end of the twenty-run archive; the live
        // record is all that is left of it, and it is enough
        const result = attributeGoldSources({
            ...base,
            itemFlowDays: [
                live('2026-08-19', dayStart('2026-08-19') + HOUR, dayStart('2026-08-19') + 2 * HOUR, { [COFFEE]: 4 }),
                live('2026-08-20', MIDNIGHT + HOUR, MIDNIGHT + 2 * HOUR, { [COFFEE]: 8 }),
            ],
            combatSessions: [archived(MIDNIGHT + HOUR, 3600, 8)],
        });
        expect(perDay(result)['2026-08-19']).toBe(-100);
        expect(perDay(result)['2026-08-20']).toBeCloseTo(-200, 6);
    });

    test('what was eaten while offline stays with the offline row', () => {
        // An eight-hour run, half of it offline: the live record saw nothing
        // then, and the archive's share of the offline window is left alone
        const start = MIDNIGHT + HOUR;
        const result = attributeGoldSources({
            ...base,
            to: dayStart('2026-08-21'),
            combatSessions: [archived(start, 8 * 3600, 8)],
            combatLootDays: [{ d: '2026-08-20', runs: {}, offline: [[start + 4 * HOUR, start + 8 * HOUR]] }],
        });
        expect(result.totals.sources.consumables).toBeCloseTo(-100, 6);
    });

    test('an offline stretch the live record cannot see is not charged twice', () => {
        // The tab watched the run's first four hours and counted 4 coffees;
        // the next four were offline and are the offline row's. The archive's
        // 8 has nothing left to add: 4 watched plus 4 ceded to offline
        const start = MIDNIGHT + HOUR;
        const result = attributeGoldSources({
            ...base,
            to: dayStart('2026-08-21'),
            itemFlowDays: [live('2026-08-20', start, start + 4 * HOUR, { [COFFEE]: 4 })],
            combatSessions: [archived(start, 8 * 3600, 8)],
            combatLootDays: [{ d: '2026-08-20', runs: {}, offline: [[start + 4 * HOUR, start + 8 * HOUR]] }],
        });
        expect(result.totals.sources.consumables).toBeCloseTo(-100, 6);
    });
});

describe('the marketplace row at today’s valuation', () => {
    const base = { from: D19, to: D20 + 3600_000, price, marketTax: 0.05 };

    test('an input bought and crafted away is never counted twice between the two rows', () => {
        // 10 cheese carried at 100, bought for 900 and crafted into 2,000 of output:
        // the account paid 900 and gained 2,000, so 1,100 in all
        const result = attributeGoldSources({
            ...base,
            tradeFills: [{ t: D20, itemHrid: '/items/cheese', side: 'buy', quantity: 10, price: 90, coins: 900 }],
            productionDays: [{ d: '2026-08-20', outputValue: 2000, inputValue: 1000 }],
        });
        expect(result.totals.sources.marketplace).toBe(100);
        expect(result.totals.sources.production).toBe(1000);
        expect(result.totals.explained).toBe(1100);
    });

    test('a fill on an item the market cannot price is valued at net worth’s own figure, or counted', () => {
        const result = attributeGoldSources({
            ...base,
            holdingPrice: (itemHrid) => (itemHrid === '/items/relic' ? 1000 : null),
            tradeFills: [
                { t: D20, itemHrid: '/items/relic', side: 'buy', quantity: 1, price: 800, coins: 800 },
                { t: D20, itemHrid: '/items/mystery', side: 'buy', quantity: 1, price: 800, coins: 800 },
            ],
        });
        expect(result.totals.sources.marketplace).toBe(200);
        expect(result.unpricedMarketFills).toBe(1);
    });
});

describe('gains the market cannot price are worth what net worth carries them at', () => {
    const window = {
        from: D19,
        to: D20 + 3600_000,
        price,
        actionType: (hrid) => (hrid === '/actions/combat/cow' ? '/action_types/combat' : null),
        // Net worth's own fallback: a chest at its expected value, a task token
        // at the task shop
        holdingPrice: (itemHrid) => ({ '/items/rare_chest': 5000, '/items/task_token': 30000 })[itemHrid] ?? null,
    };

    test('a combat drop with no order book counts at its net worth valuation, not at nothing', () => {
        const result = attributeGoldSources({
            ...window,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, loot: { a: { itemHrid: '/items/rare_chest', count: 2 } } }],
                },
            ],
        });
        expect(result.totals.sources.combat).toBe(10000);
    });

    test('task tokens count at the value net worth gives them', () => {
        const result = attributeGoldSources({
            ...window,
            taskCompletions: [{ completedAt: D20, coins: 100, tokens: 2, items: [] }],
        });
        expect(result.totals.sources.tasks).toBe(100 + 60000);
    });

    test('a chest’s unquoted contents are no longer an unpriced gap', () => {
        const result = attributeGoldSources({
            ...window,
            basisPrice: (itemHrid) => (itemHrid === '/items/purple_chest' ? 1000 : null),
            chestDays: [
                {
                    d: '2026-08-20',
                    openings: { '/items/purple_chest': { count: 1, gained: { '/items/rare_chest': 1 } } },
                },
            ],
        });
        expect(result.totals.sources.chests).toBe(5000 - 1000);
        expect(result.unpricedChestItems).toBe(0);
    });

    test('the market still wins wherever it has a price', () => {
        const result = attributeGoldSources({
            ...window,
            holdingPrice: () => 999_999,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, loot: { a: { itemHrid: '/items/cheese', count: 1 } } }],
                },
            ],
        });
        expect(result.totals.sources.combat).toBe(100);
    });
});

describe('task rerolls', () => {
    const window = { from: D19, to: D20 + 3600_000, price };

    test('what rerolling cost is booked, negative, on the day the task left the board', () => {
        const result = attributeGoldSources({
            ...window,
            holdingPrice: (itemHrid) => (itemHrid === '/items/cowbell' ? 25_000 : null),
            taskRerolls: [
                { taskId: 'a', retiredAt: D20, goldSpent: 70_000, cowbellsSpent: 3 },
                // Retired before the window: not this window's spending
                { taskId: 'b', retiredAt: D18 - DAY, goldSpent: 10_000, cowbellsSpent: 0 },
            ],
        });

        const perDay = Object.fromEntries(result.days.map((row) => [row.day, row.sources.taskRerolls]));
        expect(perDay['2026-08-20']).toBe(-(70_000 + 3 * 25_000));
        expect(result.totals.sources.taskRerolls).toBe(-(70_000 + 3 * 25_000));
        expect(result.coverage.taskRerolls).toBe(D18 - DAY);
    });

    test('cowbells count for nothing when net worth leaves them out', () => {
        // Spending a cowbell net worth does not count moves net worth by nothing
        const result = attributeGoldSources({
            ...window,
            holdingPrice: () => null,
            taskRerolls: [{ taskId: 'a', retiredAt: D20, goldSpent: 10_000, cowbellsSpent: 4 }],
        });
        expect(result.totals.sources.taskRerolls).toBe(-10_000);
    });
});

describe('residual decomposition by asset category', () => {
    const open = { t: D19, total: 1000, gold: 100, inventory: 400, equipment: 300, listings: 0, house: 200 };
    const close = { t: D20, total: 1600, gold: 150, inventory: 800, equipment: 300, listings: 50, house: 300 };

    test('differences the three groups off the same pair of closes', () => {
        expect(categoryBreakdown(open, close)).toEqual({ gold: 50, items: 450, fixed: 100, sum: 600, total: 600 });
    });

    test('a field present on one close and missing on the other makes its group null', () => {
        const partial = { ...close };
        delete partial.house;
        const breakdown = categoryBreakdown(open, partial);
        expect(breakdown.fixed).toBeNull();
        // The measurable groups still report, and the sum refuses to
        expect(breakdown.gold).toBe(50);
        expect(breakdown.items).toBe(450);
        expect(breakdown.sum).toBeNull();
    });

    test('a field missing from both closes is skipped, not counted as a zero', () => {
        // Neither close carries guildShrines — an account with no shrines,
        // which is not the same as one whose shrines did not move
        expect(categoryDelta(open, close, ['house', 'guildShrines'])).toBe(100);
        // Nothing measurable at all is null rather than zero
        expect(categoryDelta(open, close, ['guildShrines'])).toBeNull();
    });

    test('there is no breakdown without two snapshots', () => {
        expect(categoryBreakdown(null, close)).toBeNull();
        expect(categoryBreakdown(open, null)).toBeNull();
    });

    test('the categories and the total may differ, and both are reported', () => {
        // `total` carries assets excluded from net worth; the fields do not
        const breakdown = categoryBreakdown(open, { ...close, total: 2000 });
        expect(breakdown.sum).toBe(600);
        expect(breakdown.total).toBe(1000);
    });

    test('the attribution carries a breakdown per day and for the window', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price,
            series: [
                { t: D18, total: 1000, gold: 100, inventory: 400, equipment: 300, listings: 0, house: 200 },
                { t: D19, total: 1200, gold: 200, inventory: 500, equipment: 300, listings: 0, house: 200 },
                { t: D20, total: 1600, gold: 150, inventory: 800, equipment: 300, listings: 50, house: 300 },
            ],
        });

        expect(result.days[0].categories).toMatchObject({ gold: 100, items: 100, fixed: 0 });
        expect(result.days[1].categories).toMatchObject({ gold: -50, items: 350, fixed: 100 });
        expect(result.totals.categories).toMatchObject({ gold: 50, items: 450, fixed: 100, sum: 600 });
    });

    test('a day with only one close has no breakdown at all', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price,
            series: [{ t: D20, total: 1600, gold: 150, inventory: 800, equipment: 0, listings: 0, house: 0 }],
        });
        expect(result.days[0].categories).toBeNull();
        expect(result.days[0].delta).toBeNull();
    });
});

describe('market movement over the detail snapshots', () => {
    const HOUR = 3600_000;

    test('prices the shares held right through the window', () => {
        const movement = marketMovement([
            { t: D20, items: { '/items/cheese:0': { count: 10, value: 1000 } } },
            { t: D20 + 24 * HOUR, items: { '/items/cheese:0': { count: 10, value: 1500 } } },
        ]);
        // 10 held × (150 − 100)
        expect(movement.value).toBe(500);
        expect(movement.hours).toBe(24);
        expect(movement.heldItems).toBe(1);
    });

    test('only the shares held through both ends count', () => {
        const movement = marketMovement([
            { t: D20, items: { '/items/cheese:0': { count: 10, value: 1000 } } },
            { t: D20 + HOUR, items: { '/items/cheese:0': { count: 30, value: 4500 } } },
        ]);
        // min(10, 30) × (150 − 100); the twenty bought inside the window
        // changed hands at a price this has no record of
        expect(movement.value).toBe(500);
    });

    test('an item that appeared or disappeared contributes nothing', () => {
        const movement = marketMovement([
            { t: D20, items: { '/items/milk:0': { count: 5, value: 200 } } },
            { t: D20 + HOUR, items: { '/items/cheese:0': { count: 5, value: 900 } } },
        ]);
        expect(movement.value).toBe(0);
        expect(movement.heldItems).toBe(0);
    });

    test('coins never revalue and are skipped', () => {
        const movement = marketMovement([
            { t: D20, items: { '/items/coin:0': { count: 100, value: 100 } } },
            { t: D20 + HOUR, items: { '/items/coin:0': { count: 500, value: 500 } } },
        ]);
        expect(movement.value).toBe(0);
        expect(movement.heldItems).toBe(0);
    });

    test('houses and the other non-market holdings are skipped too', () => {
        const movement = marketMovement([
            { t: D20, items: { 'house:/house_rooms/kitchen': { count: 4, value: 400 } } },
            { t: D20 + HOUR, items: { 'house:/house_rooms/kitchen': { count: 4, value: 800 } } },
        ]);
        expect(movement.heldItems).toBe(0);
    });

    test('a zero count cannot make a unit price and is skipped', () => {
        const movement = marketMovement([
            { t: D20, items: { '/items/cheese:0': { count: 0, value: 0 } } },
            { t: D20 + HOUR, items: { '/items/cheese:0': { count: 10, value: 1500 } } },
        ]);
        expect(movement.heldItems).toBe(0);
    });

    test('fewer than two usable snapshots is null, never a zero', () => {
        expect(marketMovement([])).toBeNull();
        expect(marketMovement([{ t: D20, items: {} }])).toBeNull();
        expect(marketMovement(undefined)).toBeNull();
        // Two at the same instant span nothing to measure a drift over
        expect(
            marketMovement([
                { t: D20, items: {} },
                { t: D20, items: {} },
            ])
        ).toBeNull();
    });

    test('the attribution reports it beside the days without folding it in', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price,
            detailSnapshots: [
                { t: D20, items: { '/items/cheese:0': { count: 10, value: 1000 } } },
                { t: D20 + HOUR, items: { '/items/cheese:0': { count: 10, value: 1500 } } },
            ],
        });
        expect(result.marketMovement.value).toBe(500);
        // Not a source, and in no day's explained figure
        expect(result.totals.explained).toBe(0);
    });
});

describe('task rewards', () => {
    const taskPrice = (itemHrid) =>
        ({ '/items/task_token': 300, '/items/cheese': 100 })[itemHrid] ?? priceTable[`${itemHrid}:0`] ?? null;

    test('coins at face value, tokens and items at market', () => {
        const value = taskCompletionValue(
            { coins: 5000, tokens: 2, items: [{ itemHrid: '/items/cheese', count: 3 }] },
            taskPrice
        );
        expect(value).toBe(5000 + 600 + 300);
    });

    test('an unpriceable reward item adds nothing rather than breaking the row', () => {
        expect(taskCompletionValue({ coins: 100, tokens: 0, items: [{ itemHrid: '/items/mystery' }] }, taskPrice)).toBe(
            100
        );
    });

    test('claims are bucketed by the local day they were claimed on', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price: taskPrice,
            series: [
                { t: D18, total: 0 },
                { t: D20, total: 100000 },
            ],
            taskCompletions: [
                { completedAt: D19, coins: 1000, tokens: 1, items: [] },
                { completedAt: D20, coins: 2000, tokens: 0, items: [] },
                // Outside the window entirely
                { completedAt: D18, coins: 999999, tokens: 0, items: [] },
            ],
        });

        expect(result.days[0].sources.tasks).toBe(1300);
        expect(result.days[1].sources.tasks).toBe(2000);
        expect(result.totals.sources.tasks).toBe(3300);
        expect(result.coverage.tasks).toBe(D18);
    });
});

describe('chest openings', () => {
    const chestPrice = (itemHrid) =>
        ({ '/items/purple_chest': 1000, '/items/cheese': 100, '/items/milk': 40 })[itemHrid] ?? null;

    test('the loot, less what the chests themselves were worth', () => {
        const day = chestOpeningDayValue(
            { d: '2026-08-20', openings: { '/items/purple_chest': { count: 3, gained: { '/items/cheese': 40 } } } },
            chestPrice
        );
        expect(day.value).toBe(4000 - 3000);
        expect(day.unpricedItems).toBe(0);
        expect(day.unpricedChests).toBe(0);
    });

    test('an unlucky day is negative, because the chests already carried their expectation', () => {
        const day = chestOpeningDayValue(
            { d: '2026-08-20', openings: { '/items/purple_chest': { count: 3, gained: { '/items/milk': 10 } } } },
            chestPrice
        );
        expect(day.value).toBe(400 - 3000);
    });

    test('coins out of a chest are face value', () => {
        const day = chestOpeningDayValue(
            { d: '2026-08-20', openings: { '/items/purple_chest': { count: 1, gained: { '/items/coin': 5000 } } } },
            chestPrice
        );
        expect(day.value).toBe(5000 - 1000);
    });

    test('a chest with no price of its own is left out whole, not reported as gross income', () => {
        const day = chestOpeningDayValue(
            { d: '2026-08-20', openings: { '/items/mystery_chest': { count: 2, gained: { '/items/cheese': 50 } } } },
            chestPrice
        );
        expect(day.value).toBe(0);
        expect(day.unpricedChests).toBe(2);
    });

    test('an unpriceable drop is counted and left out of the figure', () => {
        const day = chestOpeningDayValue(
            {
                d: '2026-08-20',
                openings: { '/items/purple_chest': { count: 1, gained: { '/items/relic': 1, '/items/cheese': 20 } } },
            },
            chestPrice
        );
        expect(day.value).toBe(2000 - 1000);
        expect(day.unpricedItems).toBe(1);
    });

    test('the attribution buckets the rows by their own day and discloses the gaps', () => {
        const result = attributeGoldSources({
            from: D19,
            to: D20 + 3600_000,
            price: chestPrice,
            series: [
                { t: D18, total: 0 },
                { t: D20, total: 100000 },
            ],
            chestDays: [
                {
                    d: localDayId(D19),
                    openings: { '/items/purple_chest': { count: 1, gained: { '/items/cheese': 20 } } },
                },
                { d: localDayId(D20), openings: { '/items/mystery_chest': { count: 4, gained: {} } } },
                { d: localDayId(D18), openings: { '/items/purple_chest': { count: 99, gained: {} } } },
            ],
        });

        expect(result.days[0].sources.chests).toBe(1000);
        expect(result.days[1].sources.chests).toBe(0);
        expect(result.unpricedChests).toBe(4);
        // The out-of-window day is neither counted nor disclosed
        expect(result.totals.sources.chests).toBe(1000);
        expect(result.coverage.chests).toBe(dayStart(localDayId(D18)));
    });
});

describe('the deeper cost-basis fallback', () => {
    test('an alchemy input with no market price is valued at its material cost', () => {
        const session = {
            startTime: 1000,
            totalAttempts: 10,
            totalCoinsEarned: 5_000_000,
            inputItemHrid: '/items/culinary_cape',
            enhancementLevel: 0,
            results: {},
        };
        const price = () => null;
        const basis = (hrid) => (hrid === '/items/culinary_cape' ? 300_000 : null);

        // Without the basis it is unvaluable and lands in the residual
        expect(alchemySessionNet(session, price)).toBeNull();
        // With it: 5M earned minus 10 capes at their 300K material cost
        expect(alchemySessionNet(session, price, basis)).toBe(2_000_000);
    });

    test('an item transmuted back into itself nets only the real loss', () => {
        // Three transmutes that returned two capes lost ONE cape, not three —
        // the returned capes must be credited at the same material-cost basis
        // the consumed ones were charged at
        const session = {
            startTime: 1000,
            totalAttempts: 3,
            totalCoinsEarned: 0,
            inputItemHrid: '/items/culinary_cape',
            enhancementLevel: 0,
            results: { '/items/culinary_cape': { count: 2, totalValue: 0 } },
        };
        const price = () => null;
        const basis = (hrid) => (hrid === '/items/culinary_cape' ? 74_000_000 : null);

        expect(alchemySessionNet(session, price, basis)).toBe(-74_000_000);
    });

    test('an unpriced output of a different kind gets the basis credit too', () => {
        // Cape-cycling yields OTHER unpriced capes; without the symmetric
        // basis the whole yield read as zero
        const session = {
            startTime: 1000,
            totalAttempts: 1,
            totalCoinsEarned: 0,
            inputItemHrid: '/items/culinary_cape',
            enhancementLevel: 0,
            results: { '/items/artificer_cape': { count: 1, totalValue: 0 } },
        };
        const price = () => null;
        const basis = (hrid) =>
            hrid === '/items/culinary_cape' ? 74_000_000 : hrid === '/items/artificer_cape' ? 70_000_000 : null;

        expect(alchemySessionNet(session, price, basis)).toBe(-4_000_000);
    });

    test('a chest with no market price is netted against its expected value', () => {
        const row = {
            d: '2026-08-28',
            openings: { '/items/purdoras_box_combat': { count: 3, gained: { '/items/coin': 900_000 } } },
        };
        const price = (hrid) => (hrid === '/items/coin' ? 1 : null);
        const basis = (hrid) => (hrid === '/items/purdoras_box_combat' ? 220_000 : price(hrid, 0));

        expect(chestOpeningDayValue(row, price).unpricedChests).toBe(3);
        const day = chestOpeningDayValue(row, price, basis);
        expect(day.unpricedChests).toBe(0);
        expect(day.value).toBe(900_000 - 3 * 220_000);
    });
});
