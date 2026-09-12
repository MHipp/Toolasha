/**
 * That a rate is bounded by what the market will actually take.
 *
 * The case this exists for is the one a user reported with a screenshot: a
 * method quoted at 134.3B/hr whose output trades once a week. The price is real,
 * the rate is fiction, and every number between them was already correct — the
 * missing step was that somebody has to buy the thing.
 *
 * The two constants are judgement calls and are tested as such: the share of a
 * market one player can take, and how far ahead a total is allowed to count.
 * Both are asserted through behaviour rather than by reading the constant back,
 * so a change to either shows up here as a changed verdict.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const history = vi.hoisted(() => ({
    rows: {},
    calls: [],
    hasVolume: true,
    // A request that must not settle until the test releases it, so a test can
    // observe several in-flight at once instead of only ever seeing them one at
    // a time (the mock has no real network delay to make that visible otherwise).
    hang: false,
    pending: [],
    // An item whose fetch throws, to check that one failure does not take the
    // rest of a concurrent sweep down with it.
    failFor: null,
}));

vi.mock('../market/mooket/market-history-api.js', () => ({
    default: {
        fetchHistory: async (itemHrid, level, days) => {
            history.calls.push({ itemHrid, level, days });
            if (history.failFor === itemHrid) throw new Error('the pool did not answer in time');
            if (history.hang) {
                return new Promise((resolve) => {
                    history.pending.push({ itemHrid, resolve: () => resolve(history.rows[itemHrid] ?? null) });
                });
            }
            return history.rows[itemHrid] ?? null;
        },
        currentSource: () => ({ key: history.hasVolume ? 'mooket2' : 'mooket1', hasVolume: history.hasVolume }),
    },
}));

const {
    dailyVolume,
    absorbablePerHour,
    describeVelocity,
    sellThrottle,
    applySellLimit,
    applyInputNote,
    applyLiquidityLimits,
    resetLiquidityCache,
    LIQUIDITY_SHARE,
    LIQUIDITY_HORIZON_DAYS,
} = await import('./market-liquidity.js');

/**
 * History rows for an item that trades `perDay` units a day for 30 days.
 * @param {number} perDay - Units traded each day
 * @returns {Array<Object>} Rows in the shape the pooled server sends
 */
function tradedAt(perDay) {
    const day = 86_400;
    const start = Math.floor(Date.now() / 1000) - 30 * day;
    return Array.from({ length: 30 }, (_, index) => ({
        time: start + index * day,
        a: 1000,
        b: 900,
        p: 950,
        v: perDay,
    }));
}

beforeEach(() => {
    resetLiquidityCache();
    history.rows = {};
    history.calls = [];
    history.hasVolume = true;
    history.hang = false;
    history.pending = [];
    history.failFor = null;
});

describe('measuring how fast an item sells', () => {
    test('averages the traded volume over the window', async () => {
        history.rows['/items/log'] = tradedAt(240);
        const volume = await dailyVolume('/items/log');

        expect(volume.known).toBe(true);
        expect(volume.unitsPerDay).toBeCloseTo(240, 6);
    });

    test('a source with no volume is unknown, not a measured zero, and is not even fetched', async () => {
        // mooket I carries no volume; its silence must not read as "sells nothing"
        history.hasVolume = false;
        history.rows['/items/log'] = tradedAt(240);

        const volume = await dailyVolume('/items/log');

        expect(volume.known).toBe(false);
        expect(volume.unitsPerDay).toBe(0);
        expect(history.calls).toHaveLength(0);
    });

    test('asks the server once per item, however often it is asked', async () => {
        history.rows['/items/log'] = tradedAt(240);
        await dailyVolume('/items/log');
        await dailyVolume('/items/log');
        await dailyVolume('/items/log');

        expect(history.calls).toHaveLength(1);
    });

    test('no history at all is not a measured zero, and does not bound anything', async () => {
        // The pooled-history setting is off, or the server did not answer.
        // Crushing every rate because a third-party server is down would be
        // conservative in the way that unplugging the computer is.
        const volume = await dailyVolume('/items/unknown');

        expect(volume.known).toBe(false);
        expect(absorbablePerHour(volume)).toBe(Infinity);
    });

    test('history showing no trades is an answer, and bounds all the way down', async () => {
        history.rows['/items/dust'] = tradedAt(0);
        const volume = await dailyVolume('/items/dust');

        expect(volume.known).toBe(true);
        expect(absorbablePerHour(volume)).toBe(0);
    });

    test('you are assumed to be one seller among several, not the market', async () => {
        history.rows['/items/log'] = tradedAt(240);
        const volume = await dailyVolume('/items/log');

        expect(absorbablePerHour(volume)).toBeCloseTo((LIQUIDITY_SHARE * 240) / 24, 9);
        expect(LIQUIDITY_SHARE).toBeLessThan(1);
    });
});

describe('saying a velocity the way somebody reading a chart would', () => {
    test('counts per day when there is more than one a day', () => {
        expect(describeVelocity({ unitsPerDay: 340, known: true })).toBe('~340/day');
    });

    test('counts per week when there is not', () => {
        expect(describeVelocity({ unitsPerDay: 1 / 7, known: true })).toBe('~1/week');
    });

    test('counts per month when there is barely that', () => {
        expect(describeVelocity({ unitsPerDay: 2 / 30, known: true })).toBe('~2/month');
    });

    test('says so outright when nothing traded', () => {
        expect(describeVelocity({ unitsPerDay: 0, known: true })).toBe('none traded');
    });
});

describe('bounding a rate by its slowest-selling output', () => {
    /** The reported case: one charm a week, quoted in the billions per hour */
    const charm = () => ({
        label: 'Decompose Master Tailoring Charm',
        kind: 'alchemy',
        itemHrid: '/items/master_tailoring_charm',
        goldPerHour: 134_300_000_000,
        sells: [{ itemHrid: '/items/tailoring_essence', name: 'Tailoring Essence', unitsPerHour: 500 }],
        sustainable: {
            gold: 277_000_000,
            goldPerUnit: 40_000_000,
            units: 6.925,
            unitLabel: 'Master Tailoring Charm',
            verb: 'Decompose',
        },
    });

    test('an output that sells once a week crushes the rate to honest levels', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1 / 7);
        const bounded = await applySellLimit(charm());

        // 0.25 of 1/7 a day, spread over 24 hours, against 500 an hour wanted
        const allowedPerHour = (LIQUIDITY_SHARE * (1 / 7)) / 24;
        expect(bounded.goldPerHour).toBeCloseTo(134_300_000_000 * (allowedPerHour / 500), 3);
        expect(bounded.goldPerHour).toBeLessThan(1_000_000);
    });

    test('and says why, in the words of the chart it came from', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1 / 7);
        const bounded = await applySellLimit(charm());

        expect(bounded.limits[0].kind).toBe('volume');
        expect(bounded.limits[0].note).toBe('limited by market volume (~1/week)');
        expect(bounded.limits[0].detail).toContain('Tailoring Essence');
    });

    test('the total it is worth is cut to what a week of selling can realize', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1 / 7);
        const bounded = await applySellLimit(charm());

        // A windfall you can only unwind over years is not money the next step
        // of a plan can spend
        expect(bounded.sustainable.gold).toBeCloseTo(bounded.goldPerHour * LIQUIDITY_HORIZON_DAYS * 24, 6);
        expect(bounded.sustainable.gold).toBeLessThan(277_000_000);
        expect(bounded.sustainable.units).toBeCloseTo(bounded.sustainable.gold / 40_000_000, 9);
    });

    test('a liquid output leaves the rate exactly as it was', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1_000_000);
        const rate = charm();
        const bounded = await applySellLimit(rate);

        expect(bounded).toBe(rate);
        expect(bounded.limits).toBeUndefined();
    });

    test('the slowest output is the one that binds, not the first', async () => {
        history.rows['/items/fast'] = tradedAt(100_000);
        history.rows['/items/slow'] = tradedAt(24);
        const bounded = await applySellLimit({
            label: 'Cook Stew',
            goldPerHour: 1_000_000,
            sells: [
                { itemHrid: '/items/fast', unitsPerHour: 10 },
                { itemHrid: '/items/slow', unitsPerHour: 10 },
            ],
        });

        // 0.25 * 24/day = 6/day = 0.25/hr against 10/hr wanted
        expect(bounded.goldPerHour).toBeCloseTo(1_000_000 * (0.25 / 10), 6);
        expect(bounded.limits[0].itemHrid).toBe('/items/slow');
    });

    test('a ceiling of null is absent, not zero — the throttle must not invent one', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1 / 7);
        const rate = { ...charm(), sustainable: { ...charm().sustainable, gold: null } };

        const bounded = await applySellLimit(rate);

        // The pace is still throttled, but Number(null) is 0 and min(0, …)
        // used to stamp a hard ceiling of nothing onto a cap that had none
        expect(bounded.goldPerHour).toBeLessThan(1_000_000);
        expect(bounded.sustainable.gold).toBeNull();
    });

    test('an uncapped method stays uncapped — a throttle is not a ceiling', async () => {
        history.rows['/items/milk'] = tradedAt(24);
        const bounded = await applySellLimit({
            label: 'Milk a Cow',
            goldPerHour: 1_000_000,
            sustainable: { unbounded: true },
            sells: [{ itemHrid: '/items/milk', unitsPerHour: 1000 }],
        });

        expect(bounded.goldPerHour).toBeLessThan(1_000_000);
        expect(bounded.sustainable).toEqual({ unbounded: true });
    });

    test('coins are not sold, so a method paid in coins is not throttled', async () => {
        const rate = {
            label: 'Coinify',
            goldPerHour: 5_000_000,
            sells: [{ itemHrid: '/items/coin', unitsPerHour: 1 }],
        };
        expect(await applySellLimit(rate)).toBe(rate);
        expect(history.calls).toHaveLength(0);
    });

    test('a rate that names nothing it sells is left alone rather than guessed at', async () => {
        const rate = { label: 'Fly Zone T2', goldPerHour: 2_100_000 };
        expect(await applySellLimit(rate)).toBe(rate);
    });
});

describe('measuring several outputs without serializing the network', () => {
    test('fetches outputs concurrently, bounded rather than all at once', async () => {
        // Sized past the concurrency bound so the fan-out has to prove it is
        // bounded, not just that it overlaps at all.
        const items = ['/items/a', '/items/b', '/items/c', '/items/d', '/items/e', '/items/f'];
        for (const item of items) history.rows[item] = tradedAt(10);
        history.hang = true;

        const throttlePromise = sellThrottle(items.map((itemHrid) => ({ itemHrid, unitsPerHour: 1 })));

        // Let the synchronous fan-out finish starting its first wave before we look.
        await Promise.resolve();
        await Promise.resolve();

        // Overlapping in-flight calls, not a wall-clock measurement: more than one
        // request is outstanding at once, and it stops well short of firing all six.
        expect(history.pending.length).toBeGreaterThan(1);
        expect(history.pending.length).toBeLessThan(items.length);
        expect(history.calls.length).toBe(history.pending.length);

        // Release what is waiting, and let anything the pool still has queued
        // resolve immediately from here rather than tick-counting a refill chain.
        history.pending.forEach((entry) => entry.resolve());
        history.pending = [];
        history.hang = false;
        await throttlePromise;
    });

    test('two concurrent asks for the same item fold onto one fetch', async () => {
        history.rows['/items/log'] = tradedAt(240);

        const [a, b] = await Promise.all([dailyVolume('/items/log'), dailyVolume('/items/log')]);

        expect(history.calls).toHaveLength(1);
        expect(a).toEqual(b);
        expect(a.known).toBe(true);
        expect(a.unitsPerDay).toBeCloseTo(240, 6);
    });

    test('a failing item is settled as unknown volume and does not affect the others', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        history.failFor = '/items/broken';
        history.rows['/items/log'] = tradedAt(1 / 7);

        const { throttle, binding } = await sellThrottle([
            { itemHrid: '/items/broken', unitsPerHour: 10 },
            { itemHrid: '/items/log', unitsPerHour: 500 },
        ]);

        // The healthy, slow-selling output still binds and throttles normally —
        // the broken one reads as "no volume known" (Infinity allowed), so it
        // never competes to bind and never rejects the pool it shares with others.
        expect(binding.itemHrid).toBe('/items/log');
        expect(throttle).toBeCloseTo((LIQUIDITY_SHARE * (1 / 7)) / 24 / 500, 9);

        const broken = await dailyVolume('/items/broken');
        expect(broken.known).toBe(false);

        vi.restoreAllMocks();
    });

    test('the figures come out identical to a serial measurement — this is about when, not what', async () => {
        history.rows['/items/fast'] = tradedAt(100_000);
        history.rows['/items/slow'] = tradedAt(24);

        const { throttle, binding } = await sellThrottle([
            { itemHrid: '/items/fast', unitsPerHour: 10 },
            { itemHrid: '/items/slow', unitsPerHour: 10 },
        ]);

        // Same figures the pre-existing "slowest output binds" case pins.
        expect(throttle).toBeCloseTo(0.25 / 10, 6);
        expect(binding.itemHrid).toBe('/items/slow');
    });
});

describe('flagging an input nobody is selling either', () => {
    const decompose = {
        label: 'Decompose Master Tailoring Charm',
        itemHrid: '/items/master_tailoring_charm',
        goldPerHour: 1_000_000,
        sustainable: { gold: 1, unitLabel: 'Master Tailoring Charm' },
    };

    test('a once-a-week input is a note, not a cap', async () => {
        history.rows['/items/master_tailoring_charm'] = tradedAt(1 / 7);
        const noted = await applyInputNote(decompose);

        // The margin already pays for the input, and own stock is already capped
        // — what the book decides is whether you could ever do this again
        expect(noted.goldPerHour).toBe(1_000_000);
        expect(noted.limits[0].kind).toBe('input');
        expect(noted.limits[0].note).toBe('restocking Master Tailoring Charm means buying into a ~1/week book');
    });

    test('an input that trades freely is not worth a line', async () => {
        history.rows['/items/master_tailoring_charm'] = tradedAt(400);
        expect(await applyInputNote(decompose)).toBe(decompose);
    });

    test('an unmeasured input is not accused of anything', async () => {
        expect(await applyInputNote(decompose)).toBe(decompose);
    });
});

describe('bounding a whole ranking', () => {
    test('the fantasy rate falls below the honest one, which is the whole point', async () => {
        history.rows['/items/tailoring_essence'] = tradedAt(1 / 7);
        history.rows['/items/milk'] = tradedAt(50_000);

        const { rates, measured } = await applyLiquidityLimits([
            {
                label: 'Decompose Master Tailoring Charm',
                goldPerHour: 134_300_000_000,
                sells: [{ itemHrid: '/items/tailoring_essence', unitsPerHour: 500 }],
                sustainable: { gold: 277_000_000, goldPerUnit: 40_000_000, units: 6.9 },
            },
            {
                label: 'Milk a Cow',
                goldPerHour: 12_400_000,
                sustainable: { unbounded: true },
                sells: [{ itemHrid: '/items/milk', unitsPerHour: 400 }],
            },
        ]);

        expect(measured).toBe(true);
        expect(rates.map((rate) => rate.label)).toEqual(['Milk a Cow', 'Decompose Master Tailoring Charm']);
    });

    test('a run where nothing could be measured says so, and changes nothing', async () => {
        const original = [
            { label: 'Milk a Cow', goldPerHour: 12_400_000, sells: [{ itemHrid: '/items/milk', unitsPerHour: 400 }] },
        ];
        const { rates, measured } = await applyLiquidityLimits(original);

        expect(measured).toBe(false);
        expect(rates[0]).toBe(original[0]);
    });

    test('one bad item does not cost the ranking the rest of its rates', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        history.rows['/items/milk'] = tradedAt(50_000);

        const { rates } = await applyLiquidityLimits([
            {
                label: 'Broken',
                goldPerHour: 1,
                get sells() {
                    throw new Error('nope');
                },
            },
            { label: 'Milk a Cow', goldPerHour: 12_400_000, sells: [{ itemHrid: '/items/milk', unitsPerHour: 400 }] },
        ]);

        expect(rates.map((rate) => rate.label)).toEqual(['Milk a Cow', 'Broken']);
        vi.restoreAllMocks();
    });

    test('every rate’s items compete for the same bound, instead of one rate finishing before the next starts', async () => {
        // One output apiece: the old code let only one of these occupy a slot at
        // a time (the next rate did not get a turn until this one's await
        // returned), even with room in the pool for four.
        const rates = ['/items/a', '/items/b', '/items/c', '/items/d', '/items/e', '/items/f'].map(
            (itemHrid, index) => ({
                label: `Rate ${index}`,
                goldPerHour: 1_000,
                sells: [{ itemHrid, unitsPerHour: 1 }],
            })
        );
        for (const rate of rates) history.rows[rate.sells[0].itemHrid] = tradedAt(10);
        history.hang = true;

        const boundedPromise = applyLiquidityLimits(rates);

        await Promise.resolve();
        await Promise.resolve();

        expect(history.pending.length).toBeGreaterThan(1);
        expect(history.pending.length).toBeLessThan(rates.length);
        expect(history.calls.length).toBe(history.pending.length);

        history.pending.forEach((entry) => entry.resolve());
        history.pending = [];
        history.hang = false;
        await boundedPromise;
    });

    test('a rate whose fields throw when read does not stop the others from being prefetched', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        history.rows['/items/milk'] = tradedAt(50_000);

        const { rates } = await applyLiquidityLimits([
            {
                label: 'Broken',
                goldPerHour: 1,
                get sells() {
                    throw new Error('nope');
                },
            },
            { label: 'Milk a Cow', goldPerHour: 12_400_000, sells: [{ itemHrid: '/items/milk', unitsPerHour: 400 }] },
        ]);

        // The milk item still gets measured — one bad rate did not abort the
        // whole prefetch pass before it reached the healthy ones
        expect(history.calls.map((call) => call.itemHrid)).toContain('/items/milk');
        expect(rates.map((rate) => rate.label)).toEqual(['Milk a Cow', 'Broken']);
        vi.restoreAllMocks();
    });
});
