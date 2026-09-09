import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const createMocks = (isConnected) => {
    vi.doMock('../core/connection-state.js', () => ({
        default: {
            isConnected: vi.fn(() => isConnected),
        },
    }));

    const getJSON = vi.fn();
    const get = vi.fn(async () => null);
    vi.doMock('../core/storage.js', () => ({
        default: {
            getJSON,
            setJSON: vi.fn(),
            get,
            set: vi.fn(async () => {}),
        },
    }));

    const show = vi.fn();
    vi.doMock('../features/market/network-alert.js', () => ({
        default: {
            hide: vi.fn(),
            show,
        },
    }));

    // The band module is late-bound off window.Toolasha.Utils (Core loads
    // before Utils, so the API cannot import it) — tests install it the same
    // way the page does. Pass-through by default; swap `band.current` in.
    const band = { current: null };
    globalThis.window = globalThis.window || globalThis;
    globalThis.window.Toolasha = {
        Utils: {
            marketValues: {
                refreshMarketValues: vi.fn(),
                clampToBand: (price) => {
                    if (typeof price !== 'number' || !band.current) return price ?? null;
                    return Math.min(Math.max(price, band.current.min), band.current.max);
                },
            },
        },
    };

    return { getJSON, get, show, band };
};

describe('MarketAPI fetch', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns cached data when disconnected', async () => {
        // Arrange
        const cachedPayload = {
            marketData: { items: [] },
            timestamp: 123,
        };
        const { getJSON } = createMocks(false);
        getJSON.mockResolvedValue(cachedPayload);

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert
        expect(result).toEqual(cachedPayload.marketData);
        expect(getJSON).toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('returns null when disconnected without cache', async () => {
        // Arrange
        const { getJSON } = createMocks(false);
        getJSON.mockResolvedValue(null);

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert
        expect(result).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('surfaces a 403 rate-limit plainly and falls back instead of throwing', async () => {
        // Arrange: connected, the API returns a CloudFront rate-limit block, and
        // there is no cache to fall back to.
        const { getJSON, show } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        fetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });

        const { default: marketAPI } = await import('./marketplace.js');

        // Act
        const result = await marketAPI.fetch(true);

        // Assert: it does not throw, it names the rate-limit in the console, and
        // it shows a rate-limit-specific network alert rather than a generic one.
        expect(result).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
        expect(show).toHaveBeenCalledWith(expect.stringMatching(/rate-limited/i));

        warn.mockRestore();
        error.mockRestore();
    });
});

describe('MarketAPI fetch in-flight dedup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** A fetch response the API accepts, resolvable when the test says so */
    function deferredResponse() {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        fetch.mockImplementation(async () => {
            await gate;
            return { ok: true, json: async () => ({ marketData: { items: [] }, timestamp: 123 }) };
        });
        return () => release();
    }

    test('two concurrent callers share one network request', async () => {
        // The startup case: several features fetch behind nothing but an
        // isLoaded() check, and the endpoint rate-limits bursts
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const release = deferredResponse();

        const { default: marketAPI } = await import('./marketplace.js');

        const first = marketAPI.fetch();
        const second = marketAPI.fetch();
        release();
        const [a, b] = await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(a).toEqual({ items: [] });
        expect(b).toEqual({ items: [] });
    });

    test('a later fetch after the first settles is its own request', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const release = deferredResponse();

        const { default: marketAPI } = await import('./marketplace.js');

        const first = marketAPI.fetch();
        release();
        await first;
        // No cache mock change: getCachedData still returns null, so this goes out again
        await marketAPI.fetch(true);

        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('a force request behind a plain one waits it out, then refreshes — never in parallel', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);

        const { default: marketAPI } = await import('./marketplace.js');

        // Track how many requests are ever airborne at once
        let active = 0;
        let peak = 0;
        fetch.mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 0));
            active -= 1;
            return { ok: true, json: async () => ({ marketData: { items: [] }, timestamp: 123 }) };
        });

        const plain = marketAPI.fetch();
        const forced = marketAPI.fetch(true);
        await Promise.all([plain, forced]);

        expect(fetch).toHaveBeenCalledTimes(2); // the force still refreshes...
        expect(peak).toBe(1); // ...but sequentially — never a burst
    });

    test('two forced requests behind a plain one still never run in parallel', async () => {
        // Two UI paths (e.g. a manual refresh button plus a patch-driven
        // invalidation) can each call fetch(true) while a startup fetch() is
        // still in flight. Both wait out the plain fetch, and neither should
        // then fire its own refresh in parallel with the other — that is
        // exactly the burst marketplace.json's rate limit trips on.
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);

        const { default: marketAPI } = await import('./marketplace.js');

        let active = 0;
        let peak = 0;
        fetch.mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 0));
            active -= 1;
            return { ok: true, json: async () => ({ marketData: { items: [] }, timestamp: 123 }) };
        });

        const plain = marketAPI.fetch();
        const forcedA = marketAPI.fetch(true);
        const forcedB = marketAPI.fetch(true);
        await Promise.all([plain, forcedA, forcedB]);

        expect(peak).toBe(1); // never a burst, no matter how many forced callers stack up
    });

    test('a failed shared fetch clears the slot so the next call retries', async () => {
        const { getJSON } = createMocks(true);
        getJSON.mockResolvedValue(null);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'boom' });

        const { default: marketAPI } = await import('./marketplace.js');

        const [a, b] = await Promise.all([marketAPI.fetch(), marketAPI.fetch()]);
        expect(a).toBeNull();
        expect(b).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);

        await marketAPI.fetch();
        expect(fetch).toHaveBeenCalledTimes(2);

        error.mockRestore();
        warn.mockRestore();
    });
});

describe('MarketAPI getPrice bands', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('snapshot prices outside the tradable range are clamped to its edges', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1100, bid: 900 });
    });

    test('patched (write-through) prices are banded the same way', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 5000, b: 100, timestamp: 2000 } };
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1100, bid: 900 });
    });

    test('a missing side stays null — the band never invents a price', async () => {
        const { band } = createMocks(true);
        band.current = { min: 900, max: 1100 };
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 1000, b: -1 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1000, bid: null });
    });

    test('without a band everything passes through untouched', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 5000, bid: 100 });
    });

    test('before the Utils bundle lands, prices pass through as they always did', async () => {
        createMocks(true);
        delete globalThis.window.Toolasha;
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.marketData = { '/items/x': { 0: { a: 5000, b: 100 } } };
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 5000, bid: 100 });
    });
});

describe('MarketAPI getPriceTimestamp', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('reports the snapshot time when no fresher patch exists', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(1000);
    });

    test('a patch newer than the snapshot wins', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 1000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 1, b: 2, timestamp: 2000 } };
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(2000);
    });

    test('a patch older than the snapshot is ignored', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 5000;
        marketAPI.pricePatchs = { '/items/x:0': { a: 1, b: 2, timestamp: 2000 } };
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(5000);
    });

    test('null when nothing has been fetched', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = 0;
        marketAPI.pricePatchs = {};
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBeNull();
    });

    test('with no snapshot at all, a patch getPrice would serve carries its own time', async () => {
        // getPrice() serves the patch whenever it is fresher than the (absent)
        // snapshot; reporting that price's age as unknown while quoting it was
        // the one disagreement between the two.
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        marketAPI.lastFetchTimestamp = null;
        marketAPI.pricePatchs = { '/items/x:0': { a: 1, b: 2, timestamp: 2000 } };
        expect(marketAPI.getPrice('/items/x', 0)).toEqual({ ask: 1, bid: 2 });
        expect(marketAPI.getPriceTimestamp('/items/x', 0)).toBe(2000);
    });
});

describe('MarketAPI patch observation times', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('a patch with no observation time is stamped now, as order books are', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const before = Date.now();

        marketAPI.updatePrices([{ itemHrid: '/items/plank', enhancementLevel: 0, ask: 50, bid: 40 }]);

        const stamped = marketAPI.pricePatchs['/items/plank:0'].timestamp;
        expect(stamped).toBeGreaterThanOrEqual(before);
        expect(stamped).toBeLessThanOrEqual(Date.now());
    });

    test('a sighting carries its own time, so a stale one stays stale', async () => {
        // The whole point: a fifty-minute-old third-party sighting stamped
        // `Date.now()` read as "just now" and beat a genuinely fresh figure
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const fiftyMinutesAgo = Date.now() - 50 * 60 * 1000;
        marketAPI.lastFetchTimestamp = Date.now() - 10 * 60 * 1000;

        marketAPI.updatePrice('/items/plank', 0, 50, 40, fiftyMinutesAgo);

        expect(marketAPI.pricePatchs['/items/plank:0'].timestamp).toBe(fiftyMinutesAgo);
        // Older than the snapshot, so the snapshot's own time is what is reported
        expect(marketAPI.getPriceTimestamp('/items/plank', 0)).toBe(marketAPI.lastFetchTimestamp);
    });

    test('a sighting newer than the snapshot still wins, at its own time', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        marketAPI.lastFetchTimestamp = Date.now() - 40 * 60 * 1000;

        marketAPI.updatePrice('/items/plank', 0, 50, 40, fiveMinutesAgo);

        expect(marketAPI.getPriceTimestamp('/items/plank', 0)).toBe(fiveMinutesAgo);
        expect(marketAPI.getPrice('/items/plank', 0)).toMatchObject({ ask: 50, bid: 40 });
    });

    test('an observation from the future is a clock disagreement, not fresher data', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');

        marketAPI.updatePrice('/items/plank', 0, 50, 40, Date.now() + 60 * 60 * 1000);

        expect(marketAPI.pricePatchs['/items/plank:0'].timestamp).toBeLessThanOrEqual(Date.now());
    });
});

describe('MarketAPI price patch notifications', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a single updatePrice still notifies, once the coalescing window closes', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const listener = vi.fn();
        marketAPI.on(listener);

        marketAPI.updatePrice('/items/plank', 0, 50, 40);

        expect(listener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(marketAPI.NOTIFY_COALESCE_MS);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(marketAPI.getPrice('/items/plank', 0)).toMatchObject({ ask: 50, bid: 40 });
    });

    test('a burst of updatePrice calls notifies once', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const listener = vi.fn();
        marketAPI.on(listener);

        for (let level = 0; level <= 20; level++) {
            marketAPI.updatePrice('/items/sword', level, 100 + level, 90 + level);
        }
        vi.advanceTimersByTime(marketAPI.NOTIFY_COALESCE_MS);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(marketAPI.getPrice('/items/sword', 20)).toMatchObject({ ask: 120, bid: 110 });
    });

    test('updatePrices writes every patch, saves once and notifies once', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const { default: storage } = await import('../core/storage.js');
        const listener = vi.fn();
        marketAPI.on(listener);

        marketAPI.updatePrices([
            { itemHrid: '/items/sword', enhancementLevel: 0, ask: 100, bid: 90 },
            { itemHrid: '/items/sword', enhancementLevel: 1, ask: 110, bid: null },
            null,
        ]);
        vi.advanceTimersByTime(marketAPI.NOTIFY_COALESCE_MS);

        expect(storage.setJSON).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(marketAPI.getPrice('/items/sword', 0)).toMatchObject({ ask: 100, bid: 90 });
        expect(marketAPI.getPrice('/items/sword', 1)).toMatchObject({ ask: 110 });
    });

    test('an empty updatePrices neither saves nor notifies', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const { default: storage } = await import('../core/storage.js');
        const listener = vi.fn();
        marketAPI.on(listener);

        marketAPI.updatePrices([]);
        vi.advanceTimersByTime(marketAPI.NOTIFY_COALESCE_MS);

        expect(storage.setJSON).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
    });

    test('a direct notification absorbs a pending coalesced one', async () => {
        createMocks(true);
        const { default: marketAPI } = await import('./marketplace.js');
        const listener = vi.fn();
        marketAPI.on(listener);

        marketAPI.updatePrice('/items/plank', 0, 50, 40);
        marketAPI.notifyListeners();
        vi.advanceTimersByTime(marketAPI.NOTIFY_COALESCE_MS);

        expect(listener).toHaveBeenCalledTimes(1);
    });
});

/**
 * The snapshot cache is kept valid by an age, and an age is a subtraction
 * against a clock that can step backwards.
 */
describe('MarketAPI snapshot cache age', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('a cache stamped in the future is expired, not eternally fresh', async () => {
        // The clock stepped back an hour after the cache was written (an NTP
        // correction). `now - stamped` is negative, which is not "younger than
        // fifteen minutes" — read that way the snapshot is pinned as current
        // until the clock catches up, and every price quoted off it is an hour
        // old while claiming to be minutes old.
        const { getJSON, get } = createMocks(true);
        get.mockResolvedValue(Date.now() + 60 * 60 * 1000);
        getJSON.mockResolvedValue({ marketData: { '/items/cheese': { 0: { a: 10, b: 9 } } }, timestamp: 1 });
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ marketData: { '/items/cheese': { 0: { a: 20, b: 19 } } }, timestamp: 2 }),
        });

        const { default: marketAPI } = await import('./marketplace.js');
        await marketAPI.fetch();

        // It went to the network rather than serving the future-stamped cache
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(marketAPI.getPrice('/items/cheese')).toEqual({ ask: 20, bid: 19 });
    });
});
