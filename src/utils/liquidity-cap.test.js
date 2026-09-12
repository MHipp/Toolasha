/**
 * The display-side market-volume cap.
 *
 * What is under test is the seam every non-planner profit surface shares: a
 * rate bounded when the market cannot absorb what the method produces, left
 * exactly alone when it can — or when nothing could be measured, which is a
 * different fact and must not bound anything — and, when it is bounded, a
 * marker payload in the planner's own wording that no surface may drop.
 *
 * The volume measurement itself is `market-liquidity.js`'s and is tested
 * there; here the pooled-history server is mocked underneath it so the real
 * throttle arithmetic runs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ map: {} }));

vi.mock('../core/config.js', () => ({
    default: {
        getSetting: (key, defaultValue = false) =>
            Object.hasOwn(settings.map, key) ? settings.map[key] : defaultValue,
    },
}));

const history = vi.hoisted(() => ({
    rows: {},
    calls: [],
    // A request that must not settle until the test releases it, so a
    // concurrency test can observe several in flight at once.
    hang: false,
    pending: [],
    // An item whose fetch throws, to check that one failure does not stop
    // the rest of a prefetch batch from warming.
    failFor: null,
}));

vi.mock('../features/market/mooket/market-history-api.js', () => ({
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
        currentSource: () => ({ key: 'mooket2', hasVolume: true }),
    },
}));

const { resetLiquidityCache, LIQUIDITY_SHARE } = await import('../features/planner/market-liquidity.js');
const {
    LIQUIDITY_CAP_SETTING,
    liquidityCapEnabled,
    sellsFromProfitData,
    prefetchLiquidity,
    capProfitRate,
    capProfitData,
    liquidityMarkerHtml,
} = await import('./liquidity-cap.js');

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
    history.hang = false;
    history.pending = [];
    history.failFor = null;
    settings.map = {};
});

describe('the setting', () => {
    test('is on unless the user turned it off', () => {
        expect(liquidityCapEnabled()).toBe(true);

        settings.map[LIQUIDITY_CAP_SETTING] = false;
        expect(liquidityCapEnabled()).toBe(false);
    });

    test('off means the fantasy rate comes back untouched, however thin the market', async () => {
        settings.map[LIQUIDITY_CAP_SETTING] = false;
        history.rows['/items/essence'] = tradedAt(1 / 7);

        const bounded = await capProfitRate({
            goldPerHour: 134_300_000_000,
            sells: [{ itemHrid: '/items/essence', unitsPerHour: 500 }],
        });

        expect(bounded.goldPerHour).toBe(134_300_000_000);
        expect(bounded.capped).toBe(false);
        expect(bounded.limit).toBeNull();
    });
});

describe('capProfitRate', () => {
    test('an output that sells once a week crushes the rate, in proportion', async () => {
        history.rows['/items/essence'] = tradedAt(1 / 7);

        const bounded = await capProfitRate({
            goldPerHour: 134_300_000_000,
            sells: [{ itemHrid: '/items/essence', name: 'Tailoring Essence', unitsPerHour: 500 }],
        });

        // 0.25 of 1/7 a day, over 24 hours, against 500/hr wanted
        const allowedPerHour = (LIQUIDITY_SHARE * (1 / 7)) / 24;
        expect(bounded.capped).toBe(true);
        expect(bounded.goldPerHour).toBeCloseTo(134_300_000_000 * (allowedPerHour / 500), 3);
        expect(bounded.goldPerHour).toBeLessThan(1_000_000);
    });

    test('the marker carries the planner wording, the item and the volumes', async () => {
        history.rows['/items/essence'] = tradedAt(1 / 7);

        const { limit } = await capProfitRate({
            goldPerHour: 1_000_000,
            sells: [{ itemHrid: '/items/essence', name: 'Tailoring Essence', unitsPerHour: 500 }],
        });

        expect(limit.kind).toBe('volume');
        expect(limit.note).toBe('limited by market volume (~1/week)');
        expect(limit.detail).toBe('Tailoring Essence trades ~1/week, and you are not the only seller.');
        expect(limit.itemHrid).toBe('/items/essence');
        expect(limit.velocity).toBe('~1/week');
        expect(limit.throttle).toBeGreaterThan(0);
        expect(limit.throttle).toBeLessThan(1);
    });

    test('a liquid market leaves the rate exactly as quoted', async () => {
        history.rows['/items/milk'] = tradedAt(1_000_000);

        const bounded = await capProfitRate({
            goldPerHour: 12_400_000,
            sells: [{ itemHrid: '/items/milk', unitsPerHour: 400 }],
        });

        expect(bounded).toEqual({ goldPerHour: 12_400_000, capped: false, limit: null });
    });

    test('no history at all is not a measured zero and bounds nothing — the planner rule', async () => {
        const bounded = await capProfitRate({
            goldPerHour: 12_400_000,
            sells: [{ itemHrid: '/items/never_measured', unitsPerHour: 400 }],
        });

        expect(bounded.capped).toBe(false);
        expect(bounded.goldPerHour).toBe(12_400_000);
    });

    test('history that watched and saw nothing trade bounds all the way down', async () => {
        history.rows['/items/dust'] = tradedAt(0);

        const bounded = await capProfitRate({
            goldPerHour: 12_400_000,
            sells: [{ itemHrid: '/items/dust', unitsPerHour: 400 }],
        });

        expect(bounded.capped).toBe(true);
        expect(bounded.goldPerHour).toBe(0);
    });

    test('a rate that earns nothing or names nothing it sells is left alone', async () => {
        history.rows['/items/dust'] = tradedAt(0);

        expect(
            (await capProfitRate({ goldPerHour: -50_000, sells: [{ itemHrid: '/items/dust', unitsPerHour: 1 }] }))
                .capped
        ).toBe(false);
        expect((await capProfitRate({ goldPerHour: 1_000_000, sells: [] })).capped).toBe(false);
        expect((await capProfitRate({ goldPerHour: 1_000_000 })).capped).toBe(false);
        expect((await capProfitRate()).capped).toBe(false);
    });
});

describe('prefetchLiquidity', () => {
    test('warms the cache so a later capProfitRate call costs no new fetch', async () => {
        history.rows['/items/essence'] = tradedAt(24);

        await prefetchLiquidity([{ itemHrid: '/items/essence' }]);
        expect(history.calls).toHaveLength(1);

        await capProfitRate({ goldPerHour: 1_000_000, sells: [{ itemHrid: '/items/essence', unitsPerHour: 500 }] });
        expect(history.calls).toHaveLength(1);
    });

    test('duplicate items in the batch collapse to one fetch', async () => {
        history.rows['/items/essence'] = tradedAt(24);

        await prefetchLiquidity([
            { itemHrid: '/items/essence' },
            { itemHrid: '/items/essence' },
            { itemHrid: '/items/essence', enhancementLevel: 0 },
        ]);

        expect(history.calls).toHaveLength(1);
    });

    test('fetches several items concurrently, bounded rather than all at once', async () => {
        // Sized past the concurrency bound so the fan-out has to prove it is
        // bounded, not just that it overlaps at all.
        const items = ['/items/a', '/items/b', '/items/c', '/items/d', '/items/e', '/items/f'];
        for (const item of items) history.rows[item] = tradedAt(10);
        history.hang = true;

        const prefetchPromise = prefetchLiquidity(items.map((itemHrid) => ({ itemHrid })));

        // Let the synchronous fan-out finish starting its first wave before we look.
        await Promise.resolve();
        await Promise.resolve();

        expect(history.pending.length).toBeGreaterThan(1);
        expect(history.pending.length).toBeLessThan(items.length);
        expect(history.calls.length).toBe(history.pending.length);

        history.pending.forEach((entry) => entry.resolve());
        history.pending = [];
        history.hang = false;
        await prefetchPromise;
    });

    test('one item failing does not stop the rest of the batch from warming', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        history.failFor = '/items/broken';
        history.rows['/items/essence'] = tradedAt(24);

        await prefetchLiquidity([{ itemHrid: '/items/broken' }, { itemHrid: '/items/essence' }]);

        // The broken item settles as unknown volume rather than aborting the batch
        const broken = await capProfitRate({
            goldPerHour: 1_000_000,
            sells: [{ itemHrid: '/items/broken', unitsPerHour: 1 }],
        });
        expect(broken.capped).toBe(false);
        expect(history.calls.filter((call) => call.itemHrid === '/items/essence')).toHaveLength(1);

        vi.restoreAllMocks();
    });
});

describe('sellsFromProfitData — the three calculator shapes', () => {
    test('gathering: the drop table plus bonus drops, aggregated per item', () => {
        const sells = sellsFromProfitData({
            baseOutputs: [
                { itemHrid: '/items/milk', name: 'Milk', itemsPerHour: 300 },
                { itemHrid: '/items/milk', name: 'Milk', itemsPerHour: 50 },
            ],
            bonusRevenue: {
                bonusDrops: [{ itemHrid: '/items/essence', itemName: 'Essence', dropsPerHour: 2 }],
            },
        });

        expect(sells).toEqual([
            { itemHrid: '/items/milk', name: 'Milk', unitsPerHour: 350 },
            { itemHrid: '/items/essence', name: 'Essence', unitsPerHour: 2 },
        ]);
    });

    test('alchemy: dropRevenues minus the self-returned copies, which are not sold', () => {
        const sells = sellsFromProfitData({
            dropRevenues: [
                { itemHrid: '/items/charm', itemName: 'Charm', dropsPerHour: 10, isSelfReturn: true },
                { itemHrid: '/items/essence', itemName: 'Essence', dropsPerHour: 500 },
            ],
        });

        expect(sells).toEqual([{ itemHrid: '/items/essence', name: 'Essence', unitsPerHour: 500 }]);
    });

    test('production: the one output, gourmet copies included', () => {
        const sells = sellsFromProfitData({
            itemHrid: '/items/donut',
            itemsPerHour: 90,
            gourmetBonusItems: 10,
        });

        expect(sells).toEqual([{ itemHrid: '/items/donut', name: null, unitsPerHour: 100 }]);
    });

    test('nothing, zero rates and missing hrids yield nothing rather than guesses', () => {
        expect(sellsFromProfitData(null)).toEqual([]);
        expect(sellsFromProfitData({})).toEqual([]);
        expect(sellsFromProfitData({ baseOutputs: [{ name: 'nameless', itemsPerHour: 10 }] })).toEqual([]);
        expect(sellsFromProfitData({ itemHrid: '/items/donut', itemsPerHour: 0 })).toEqual([]);
    });
});

describe('capProfitData', () => {
    const gathering = () => ({
        profitPerHour: 1_000_000,
        profitPerDay: 24_000_000,
        profitPerAction: 250,
        baseOutputs: [{ itemHrid: '/items/essence', name: 'Essence', itemsPerHour: 500 }],
    });

    test('bounds the pace claims, keeps the raw figure, marks the copy', async () => {
        history.rows['/items/essence'] = tradedAt(24);

        const original = gathering();
        const bounded = await capProfitData(original);

        // 0.25 × 24/day = 6/day = 0.25/hr allowed, against 500/hr wanted
        const throttle = 0.25 / 500;
        expect(bounded.profitPerHour).toBeCloseTo(1_000_000 * throttle, 6);
        expect(bounded.profitPerDay).toBeCloseTo(24_000_000 * throttle, 6);
        expect(bounded.uncappedProfitPerHour).toBe(1_000_000);
        expect(bounded.liquidityLimit.note).toBe('limited by market volume (~24/day)');

        // The per-action margin is real; only the pace was fiction
        expect(bounded.profitPerAction).toBe(250);
    });

    test('the original calculator result is never touched', async () => {
        history.rows['/items/essence'] = tradedAt(24);

        const original = gathering();
        const bounded = await capProfitData(original);

        expect(bounded).not.toBe(original);
        expect(original.profitPerHour).toBe(1_000_000);
        expect(original.liquidityLimit).toBeUndefined();
    });

    test('an unbounded rate comes back as the same object, unmarked', async () => {
        history.rows['/items/essence'] = tradedAt(1_000_000);

        const original = gathering();
        expect(await capProfitData(original)).toBe(original);
        expect(await capProfitData(null)).toBeNull();
    });
});

describe('liquidityMarkerHtml', () => {
    const limit = {
        note: 'limited by market volume (~1/week)',
        detail: 'Tailoring Essence trades ~1/week, and you are not the only seller.',
    };

    test('prints the planner wording, with the naming detail in the tooltip', () => {
        const html = liquidityMarkerHtml(limit);

        expect(html).toContain('limited by market volume (~1/week)');
        expect(html).toContain('title="limited by market volume (~1/week) — Tailoring Essence trades ~1/week');
    });

    test('the compact form still carries the full story in its tooltip', () => {
        const html = liquidityMarkerHtml(limit, { compact: true });

        expect(html).toContain('>vol-capped<');
        expect(html).toContain('Tailoring Essence');
    });

    test('no cap, no marker', () => {
        expect(liquidityMarkerHtml(null)).toBe('');
        expect(liquidityMarkerHtml(undefined)).toBe('');
    });

    test('a hostile item name cannot break out of the attribute', () => {
        const html = liquidityMarkerHtml({ note: 'limited by market volume (~1/week)', detail: '"><img src=x>' });

        expect(html).not.toContain('"><img');
        expect(html).toContain('&quot;&gt;&lt;img');
    });
});
