/**
 * Estimated Listing Age — the pure ID→timestamp estimation math and the
 * listing bookkeeping around it (status tracking, reconciliation, price/qty
 * text parsing), plus the TERTIARY `getCurrentItemHrid` DOM fallback. Most of
 * the DOM injection (addAgeColumn, processOrderBook, checkForExpiredListings)
 * is not exercised here.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

/**
 * A real little store rather than a stub returning fallbacks: the listing log
 * is read through `readScoped`, which reads one key, writes another and deletes
 * a third, and a mock that answers every key the same way cannot show that the
 * legacy array was split rather than copied.
 */
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        // Cloned on write, as IndexedDB does: the module hands the same array to
        // two keys in a row and a mock that stored the reference would show them
        // sharing a log they do not actually share
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    handlers: {},
    on: (event, handler) => {
        dataManagerMock.handlers[event] = handler;
    },
    off: () => {},
    getMarketListings: () => [],
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => dataManagerMock.gameMode,
}));

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
const marketMock = vi.hoisted(() => ({ updatePrice: vi.fn(), updatePrices: vi.fn() }));
vi.mock('../../api/marketplace.js', () => ({ default: marketMock }));

const {
    default: estimatedListingAge,
    ANCHOR_POOL_MAX,
    LISTING_RETENTION_MS,
    LISTING_RETENTION_MAX,
    RETENTION_SWEEP_EVERY,
    applyListingRetention,
    ORDER_BOOK_CACHE_MAX_ITEMS,
    ORDER_BOOK_PERSISTED_ROWS,
    LISTING_SAVE_DEBOUNCE_MS,
    ORDER_BOOK_REPAINT_MS,
    matchesExpiredRow,
    matchesBeyondTopRow,
    mergeListingGraves,
    applyListingGraves,
    TOMBSTONE_MAX_AGE_MS,
    MAX_LISTING_TOMBSTONES,
} = await import('./estimated-listing-age.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

/** The key this character's listing log lives under */
const LOG_KEY = 'marketListingTimestamps_market123';
/** The key the old shared array lived under */
const LEGACY_KEY = 'marketListingTimestamps';
const ANCHORS_KEY = 'marketListingAnchors';

/**
 * Point the estimator at exactly these (id, timestamp) pairs and nothing else.
 *
 * Estimation reads a merged view of the log and the shared anchors, so a test
 * about the maths has to say there are no anchors as well as which listings
 * there are.
 * @param {Array} listings - The log
 */
const knownAs = (listings) => {
    estimatedListingAge.knownListings = listings;
    estimatedListingAge.anchors = [];
    estimatedListingAge.rebuildEstimationPoints();
};

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    dataManagerMock.gameMode = 'standard';
    estimatedListingAge.knownListings = [];
    estimatedListingAge.anchors = [];
    estimatedListingAge.estimationPoints = [];
    estimatedListingAge.anchorsLoaded = false;
    estimatedListingAge.listingGraves = { removed: {}, clearedThrough: 0 };
    estimatedListingAge._saveChain = null;
    // A save left waiting by the last test must not land in this one
    clearTimeout(estimatedListingAge._saveTimer);
    estimatedListingAge._saveTimer = null;
    estimatedListingAge._pendingSave = null;
    estimatedListingAge._resolvePendingSave = null;
    clearTimeout(estimatedListingAge._repaintTimer);
    estimatedListingAge._repaintTimer = null;
    estimatedListingAge.orderBooksCache = {};
    marketMock.updatePrice.mockClear();
    marketMock.updatePrices.mockClear();
    storageMock.unavailable = false;
    for (const fn of [
        storageMock.get,
        storageMock.set,
        storageMock.delete,
        storageMock.getJSON,
        storageMock.setJSON,
        storageMock.tryGet,
    ])
        fn.mockClear();
});

describe('parsePrice', () => {
    test('reads plain numbers and K/M/B/T suffixes', () => {
        expect(estimatedListingAge.parsePrice('100')).toBe(100);
        expect(estimatedListingAge.parsePrice('1.5K')).toBe(1500);
        expect(estimatedListingAge.parsePrice('12M')).toBe(12_000_000);
        expect(estimatedListingAge.parsePrice('2B')).toBe(2_000_000_000);
        expect(estimatedListingAge.parsePrice('1.2T')).toBe(1_200_000_000_000);
    });

    test('strips thousands separators before parsing', () => {
        expect(estimatedListingAge.parsePrice('12,345')).toBe(12345);
    });

    test('tolerates the trailing "*" boundary marker on My Listings prices', () => {
        expect(estimatedListingAge.parsePrice('12,345*')).toBe(12345);
        expect(estimatedListingAge.parsePrice('1.5M*')).toBe(1_500_000);
    });

    test('is case-insensitive on the suffix', () => {
        expect(estimatedListingAge.parsePrice('3k')).toBe(3000);
    });

    test('returns null for empty or unparsable text', () => {
        expect(estimatedListingAge.parsePrice('')).toBeNull();
        expect(estimatedListingAge.parsePrice(null)).toBeNull();
        expect(estimatedListingAge.parsePrice('abc')).toBeNull();
    });
});

describe('parseQuantity', () => {
    test('reads plain numbers and K/M suffixes', () => {
        expect(estimatedListingAge.parseQuantity('42')).toBe(42);
        expect(estimatedListingAge.parseQuantity('3K')).toBe(3000);
        expect(estimatedListingAge.parseQuantity('2M')).toBe(2_000_000);
    });

    test('strips non-numeric characters first', () => {
        expect(estimatedListingAge.parseQuantity('x 1.5K units')).toBe(1500);
    });

    test('an empty numeric remainder is zero, not NaN', () => {
        expect(estimatedListingAge.parseQuantity('K')).toBe(0);
    });
});

describe('parsePrice / parseQuantity — locale-grouped figures', () => {
    const asLocale = (value) => {
        localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    describe('en-US', () => {
        beforeEach(() => asLocale('en-US'));

        test('parsePrice reads comma grouping', () => expect(estimatedListingAge.parsePrice('12,345')).toBe(12345));

        test('parseQuantity reads a comma-grouped quantity', () => {
            expect(estimatedListingAge.parseQuantity('1,234')).toBe(1234);
        });
    });

    describe('de-DE (period grouping, comma decimal) — the bug this replaces', () => {
        beforeEach(() => asLocale('de-DE'));

        test('parsePrice reads period grouping instead of stopping at the first group', () => {
            // A hardcoded `[\d,.]+` already tolerates comma/period swapped roles
            // for parsePrice (both characters are in the class), but relied on
            // parseGameNumber to sort out which is which — this pins that path.
            expect(estimatedListingAge.parsePrice('12.345')).toBe(12345);
            expect(estimatedListingAge.parsePrice('1,5K')).toBe(1500);
        });

        test('parseQuantity reads period grouping and a comma decimal', () => {
            // A hardcoded `[^0-9.]` strip kept every period (reading "1.234" as
            // 1234000 once the K/M multiplier was applied) and discarded every
            // comma outright, silently dropping the decimal tail of "1,5K".
            expect(estimatedListingAge.parseQuantity('1.234')).toBe(1234);
            expect(estimatedListingAge.parseQuantity('1,5K')).toBe(1500);
        });
    });
});

describe('estimateTimestamp / linearInterpolation / linearRegression', () => {
    test('with no known listings, estimates roughly one hour ago', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const estimate = estimatedListingAge.estimateTimestamp(12345);
        expect(estimate).toBe(Date.now() - 60 * 60 * 1000);
        vi.useRealTimers();
    });

    test('with a single known listing, every id maps to that one timestamp', () => {
        knownAs([{ id: 500, timestamp: 1_000_000 }]);
        expect(estimatedListingAge.estimateTimestamp(999)).toBe(1_000_000);
    });

    test('interpolates linearly between two bracketing known ids', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
        expect(estimatedListingAge.estimateTimestamp(150)).toBe(1500);
    });

    test('an exact id match returns its own timestamp, not an interpolation', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
        expect(estimatedListingAge.linearInterpolation(100)).toBe(1000);
    });

    test('extrapolates beyond the known range using regression, anchored at the nearest edge', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
            { id: 300, timestamp: 3000 },
        ]);
        // Perfectly linear (slope 10/id), so extrapolation beyond maxId should hit exactly
        expect(estimatedListingAge.estimateTimestamp(400)).toBe(4000);
    });

    test('never returns a timestamp in the future', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        knownAs([
            { id: 100, timestamp: Date.now() - 2000 },
            { id: 200, timestamp: Date.now() - 1000 },
        ]);
        // Far beyond the known range, regression would predict a time past "now"
        expect(estimatedListingAge.estimateTimestamp(100000)).toBe(Date.now());
        vi.useRealTimers();
    });
});

describe('getStalenessColor / getStalenessTooltip', () => {
    test('color escalates with age from fresh to very stale', () => {
        const now = Date.now();
        expect(estimatedListingAge.getStalenessColor(now)).toBe('#00AA00'); // <15min
        expect(estimatedListingAge.getStalenessColor(now - 30 * 60 * 1000)).toBe('#00FF00'); // <1hr
        expect(estimatedListingAge.getStalenessColor(now - 2 * 60 * 60 * 1000)).toBe('#FFAA00'); // <4hr
        expect(estimatedListingAge.getStalenessColor(now - 6 * 60 * 60 * 1000)).toBe('#FF6600'); // <12hr
        expect(estimatedListingAge.getStalenessColor(now - 20 * 60 * 60 * 1000)).toBe('#FF0000'); // 12hr+
    });

    test('an unknown age (falsy lastUpdated) is gray, not fresh', () => {
        expect(estimatedListingAge.getStalenessColor(0)).toBe('#999999');
        expect(estimatedListingAge.getStalenessColor(null)).toBe('#999999');
    });

    test('tooltip explains the unknown case separately from an aged one', () => {
        expect(estimatedListingAge.getStalenessTooltip(null)).toMatch(/Visit market page/);
        expect(estimatedListingAge.getStalenessTooltip(Date.now())).toMatch(/Order book data from/);
    });
});

describe('recordListing status resolution', () => {
    test('a brand new listing defaults to unknown status', () => {
        estimatedListingAge.recordListing({ id: 1, createdTimestamp: '2026-01-01T00:00:00Z', itemHrid: '/items/a' });
        expect(estimatedListingAge.knownListings[0].status).toBe('unknown');
    });

    test('an explicit _toolashaStatus overrides whatever was tracked before', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'active', createdTimestamp: '2026-01-01T00:00:00Z' }];
        estimatedListingAge.recordListing({
            id: 1,
            createdTimestamp: '2026-01-01T00:00:00Z',
            _toolashaStatus: 'filled',
        });
        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });

    test('re-recording without a new status preserves the previously tracked one', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'active', createdTimestamp: '2026-01-01T00:00:00Z' }];
        estimatedListingAge.recordListing({ id: 1, createdTimestamp: '2026-01-01T00:00:00Z' });
        expect(estimatedListingAge.knownListings[0].status).toBe('active');
    });

    test('listings without a createdTimestamp are ignored entirely', () => {
        estimatedListingAge.recordListing({ id: 1 });
        expect(estimatedListingAge.knownListings).toHaveLength(0);
    });

    test('entries stay sorted by id after insertion', () => {
        estimatedListingAge.recordListing({ id: 300, createdTimestamp: '2026-01-03T00:00:00Z' });
        estimatedListingAge.recordListing({ id: 100, createdTimestamp: '2026-01-01T00:00:00Z' });
        estimatedListingAge.recordListing({ id: 200, createdTimestamp: '2026-01-02T00:00:00Z' });
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([100, 200, 300]);
    });
});

describe('deleteListing / markActiveListings / _reconcileActiveListings', () => {
    test('deleteListing re-syncs from storage before removing, so a stale copy cannot resurrect the entry', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [
            { id: 1, itemHrid: '/items/a', status: 'active' },
            { id: 2, itemHrid: '/items/b', status: 'active' },
        ]);
        estimatedListingAge.knownListings = []; // stale in-memory state

        await estimatedListingAge.deleteListing(1);

        const ids = estimatedListingAge.knownListings.map((l) => l.id);
        expect(ids).not.toContain(1);
        expect(ids).toContain(2);
        expect(storageMock.set).toHaveBeenCalled();
    });

    test('markActiveListings promotes unknown listings present in the active set to active', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [
            { id: 1, itemHrid: '/items/a', status: 'unknown' },
            { id: 2, itemHrid: '/items/b', status: 'unknown' },
        ]);
        estimatedListingAge.knownListings = [];

        await estimatedListingAge.markActiveListings(new Set([1]));

        const byId = Object.fromEntries(estimatedListingAge.knownListings.map((l) => [l.id, l.status]));
        expect(byId[1]).toBe('active');
        expect(byId[2]).toBe('unknown');
    });

    test('markActiveListings does not touch a listing that already has a resolved status', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [{ id: 1, itemHrid: '/items/a', status: 'filled' }]);
        estimatedListingAge.knownListings = [];

        await estimatedListingAge.markActiveListings(new Set([1]));

        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });

    test('_reconcileActiveListings downgrades active listings absent from the new snapshot to unknown', () => {
        estimatedListingAge.knownListings = [
            { id: 1, status: 'active' },
            { id: 2, status: 'active' },
        ];

        estimatedListingAge._reconcileActiveListings([{ id: 1 }]);

        expect(estimatedListingAge.knownListings.find((l) => l.id === 1).status).toBe('active');
        expect(estimatedListingAge.knownListings.find((l) => l.id === 2).status).toBe('unknown');
    });

    test('_reconcileActiveListings leaves non-active statuses (filled/canceled) alone', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'filled' }];
        estimatedListingAge._reconcileActiveListings([]);
        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });
});

describe('splitting the old shared key', () => {
    /** A mixed legacy array: two of somebody's listings and one bare anchor */
    const legacyArray = () => [
        { id: 10, timestamp: 1000, itemHrid: '/items/a', status: 'filled' },
        { id: 20, timestamp: 2000 },
        { id: 30, timestamp: 3000, itemHrid: '/items/b', status: 'active' },
    ];

    test('the adopting character takes the listings and leaves the anchors behind', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([10, 30]);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([10, 30]);
        // Nothing without an item survives into the per-character log
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .some((l) => !l.itemHrid)
        ).toBe(false);
        // And the legacy key is gone, so it cannot be adopted twice
        expect(storageMock.storeFor('marketListings').has(LEGACY_KEY)).toBe(false);
    });

    test('the anchor half goes to the global key, seeds included', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        const anchors = storageMock.storeFor('marketListings').get(ANCHORS_KEY);
        expect(anchors.find((a) => a.id === 20)).toEqual({ id: 20, timestamp: 2000 });
        // The hardcoded baseline is in there too, so a fresh install can still estimate
        expect(anchors.find((a) => a.id === 106442952)).toBeTruthy();
        // Anchors are bare points — no item, no status, nobody's history
        expect(anchors.every((a) => Object.keys(a).sort().join() === 'id,timestamp')).toBe(true);
    });

    test('an iron cow gets the anchors but not the market character log', async () => {
        dataManagerMock.characterId = 'iron456';
        dataManagerMock.gameMode = 'ironcow';
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings).toEqual([]);
        // Left in place for the character it belongs to to claim
        expect(storageMock.storeFor('marketListings').get(LEGACY_KEY)).toHaveLength(3);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(ANCHORS_KEY)
                .find((a) => a.id === 20)
        ).toBeTruthy();
        // …and it can still date other people's listings from the shared points
        expect(estimatedListingAge.estimateTimestamp(20)).toBe(2000);
    });

    test('two characters keep separate logs', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());
        await estimatedListingAge.loadHistoricalData();

        dataManagerMock.characterId = 'iron456';
        dataManagerMock.gameMode = 'ironcow';
        // Dated alongside the legacy rows: a listing months newer would let
        // retention drop the filled one (id 10) from the log it is compared to
        estimatedListingAge.recordListing({
            id: 99,
            createdTimestamp: new Date(4000).toISOString(),
            itemHrid: '/items/c',
        });
        await estimatedListingAge.saveHistoricalData();

        expect(
            storageMock
                .storeFor('marketListings')
                .get('marketListingTimestamps_iron456')
                .map((l) => l.id)
        ).toEqual([10, 30, 99]);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([10, 30]);
    });

    test('estimation still sees both halves at once', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        // id 20 is only an anchor, ids 10 and 30 only the log — all three usable
        expect(estimatedListingAge.linearInterpolation(20)).toBe(2000);
        expect(estimatedListingAge.linearInterpolation(10)).toBe(1000);
        expect(estimatedListingAge.linearInterpolation(15)).toBe(1500);
    });

    test('a second load does not re-split or re-write anything', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());
        await estimatedListingAge.loadHistoricalData();

        storageMock.set.mockClear();
        storageMock.setJSON.mockClear();
        await estimatedListingAge.loadHistoricalData();

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(storageMock.setJSON).not.toHaveBeenCalled();
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([10, 30]);
    });

    test('personalListings hands out copies, not the live log', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [{ id: 10, timestamp: 1000, itemHrid: '/items/a' }]);

        const copies = await estimatedListingAge.personalListings();
        copies[0].status = 'meddled';

        expect(estimatedListingAge.knownListings[0].status).toBeUndefined();
    });
});

describe('addAnchors — growing the shared pool', () => {
    test('appends a new {id, timestamp} pair', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2000 }]);

        expect(estimatedListingAge.anchors).toEqual([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
    });

    test('dedupes by id, keeping the existing timestamp rather than the new one', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 100, timestamp: 9999 }]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
    });

    test('persists the grown pool to storage', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2000 }]);

        expect(
            storageMock
                .storeFor('marketListings')
                .get(ANCHORS_KEY)
                .map((a) => a.id)
        ).toEqual([100, 200]);
    });

    test('does not write to storage when every candidate is already known', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 100, timestamp: 1000 }]);

        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });

    test('ignores malformed candidates (missing fields, non-numeric, NaN)', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([
            null,
            { id: 'not-a-number', timestamp: 2000 },
            { id: 200 },
            { id: NaN, timestamp: 3000 },
            { id: 300, timestamp: NaN },
        ]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
    });

    test('immediately improves estimation for ids the growth just covered', async () => {
        estimatedListingAge.anchors = [
            { id: 100, timestamp: 1000 },
            { id: 300, timestamp: 3000 },
        ];
        estimatedListingAge.knownListings = [];
        estimatedListingAge.rebuildEstimationPoints();
        // Before growth, 200 is a crude interpolation between the two endpoints
        expect(estimatedListingAge.estimateTimestamp(200)).toBe(2000);

        // A new, exact midpoint anchor arrives
        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2500 }]);

        // Estimation for 200 itself is now exact, and never regresses relative to before
        expect(estimatedListingAge.estimateTimestamp(200)).toBe(2500);
    });

    test('a no-op call (empty array) does not touch storage or the pool', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });
});

describe('_evictToCapacity — bounding the anchor pool', () => {
    test('leaves a pool at or under the cap untouched', () => {
        const points = Array.from({ length: 10 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        expect(estimatedListingAge._evictToCapacity(points)).toEqual(points);
    });

    test('trims an over-cap pool down to exactly the cap', () => {
        const points = Array.from({ length: ANCHOR_POOL_MAX + 50 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        const trimmed = estimatedListingAge._evictToCapacity(points);
        expect(trimmed).toHaveLength(ANCHOR_POOL_MAX);
    });

    test('never evicts the two endpoints, preserving the id range', () => {
        const points = Array.from({ length: ANCHOR_POOL_MAX + 50 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        const trimmed = estimatedListingAge._evictToCapacity(points);
        expect(trimmed[0]).toEqual(points[0]);
        expect(trimmed[trimmed.length - 1]).toEqual(points[points.length - 1]);
    });

    test('thins the densest cluster before touching sparser, wide-coverage points', () => {
        // A handful of points spread wide, plus a tight cluster of near-duplicates
        // packed together — the cluster is the redundant part for interpolation.
        const wide = [
            { id: 0, timestamp: 0 },
            { id: 1_000_000, timestamp: 1_000_000_000 },
        ];
        const cluster = Array.from({ length: ANCHOR_POOL_MAX }, (_, i) => ({
            id: 500_000 + i,
            timestamp: 500_000_000 + i,
        }));
        const points = [...wide, ...cluster].sort((a, b) => a.id - b.id);

        const trimmed = estimatedListingAge._evictToCapacity(points);

        expect(trimmed).toHaveLength(ANCHOR_POOL_MAX);
        // Both wide endpoints survive...
        expect(trimmed.find((p) => p.id === 0)).toBeTruthy();
        expect(trimmed.find((p) => p.id === 1_000_000)).toBeTruthy();
        // ...at the cost of thinning the cluster, not the wide points around it
        expect(trimmed.filter((p) => p.id >= 500_000 && p.id < 500_000 + ANCHOR_POOL_MAX).length).toBeLessThan(
            cluster.length
        );
    });

    test('stops at 2 points rather than evicting an endpoint', () => {
        const points = [
            { id: 1, timestamp: 1 },
            { id: 2, timestamp: 2 },
        ];
        expect(estimatedListingAge._evictToCapacity(points)).toEqual(points);
    });
});

describe('a sync pull combines the anchor pool rather than replacing it', () => {
    test('the anchor key is claimed by a merge, not written whole', () => {
        expect(mergeForKey('marketListings', 'marketListingAnchors')).not.toBeNull();
    });

    test('the merge is the union of both devices, deduped by id and id-sorted', () => {
        const registration = mergeForKey('marketListings', 'marketListingAnchors');
        const local = [
            { id: 10, timestamp: 100 },
            { id: 30, timestamp: 300 },
        ];
        const incoming = [
            { id: 20, timestamp: 200 },
            // An id both devices anchored: this device's reading stands, as it
            // does in `addAnchors`, so a pull cannot move an estimate that was
            // already grounded
            { id: 30, timestamp: 999 },
        ];

        expect(registration.merge(local, incoming)).toEqual([
            { id: 10, timestamp: 100 },
            { id: 20, timestamp: 200 },
            { id: 30, timestamp: 300 },
        ]);
    });

    test('applying the same pull twice changes nothing', () => {
        const registration = mergeForKey('marketListings', 'marketListingAnchors');
        const local = [{ id: 10, timestamp: 100 }];
        const incoming = [{ id: 20, timestamp: 200 }];

        const once = registration.merge(local, incoming);
        expect(registration.merge(once, incoming)).toEqual(once);
    });

    test('the union is still bounded by the pool cap', () => {
        const registration = mergeForKey('marketListings', 'marketListingAnchors');
        const local = Array.from({ length: ANCHOR_POOL_MAX }, (_, i) => ({ id: i * 2, timestamp: i }));
        const incoming = Array.from({ length: ANCHOR_POOL_MAX }, (_, i) => ({ id: i * 2 + 1, timestamp: i }));

        expect(registration.merge(local, incoming)).toHaveLength(ANCHOR_POOL_MAX);
    });

    test('junk on either side is dropped rather than poisoning the pool', () => {
        const registration = mergeForKey('marketListings', 'marketListingAnchors');
        const merged = registration.merge(
            [{ id: 1, timestamp: 1 }, null, { id: 'x', timestamp: 2 }],
            [
                { id: 2, timestamp: NaN },
                { id: 3, timestamp: 3 },
            ]
        );
        expect(merged).toEqual([
            { id: 1, timestamp: 1 },
            { id: 3, timestamp: 3 },
        ]);
    });

    test('a side that is not an array at all leaves the other one standing', () => {
        const registration = mergeForKey('marketListings', 'marketListingAnchors');
        expect(registration.merge([{ id: 1, timestamp: 1 }], null)).toEqual([{ id: 1, timestamp: 1 }]);
        expect(registration.merge(undefined, [{ id: 2, timestamp: 2 }])).toEqual([{ id: 2, timestamp: 2 }]);
    });
});

describe('recordListing grows the shared anchor pool', () => {
    test('recording an own listing appends a deduped anchor', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
        });

        expect(estimatedListingAge.anchors).toEqual([
            { id: 500, timestamp: new Date('2026-01-01T00:00:00.000Z').getTime() },
        ]);
    });

    test('re-recording the same id (e.g. a status update) does not duplicate the anchor', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
        });
        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
            _toolashaStatus: 'filled',
        });

        expect(estimatedListingAge.anchors).toHaveLength(1);
    });

    test('a listing with no createdTimestamp grows neither the log nor the anchor pool', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({ id: 500, itemHrid: '/items/a' });

        expect(estimatedListingAge.anchors).toEqual([]);
    });
});

describe('clearing the personal log keeps the anonymous anchor mirror', () => {
    test('clearing knownListings does not remove ids already mirrored into anchors', () => {
        estimatedListingAge.anchors = [{ id: 500, timestamp: 1000 }];
        estimatedListingAge.knownListings = [{ id: 500, timestamp: 1000, itemHrid: '/items/a', status: 'filled' }];
        estimatedListingAge.rebuildEstimationPoints();

        // Simulate clearHistory's personal-log wipe: only knownListings is cleared
        estimatedListingAge.knownListings = [];
        estimatedListingAge.rebuildEstimationPoints();

        expect(estimatedListingAge.anchors).toEqual([{ id: 500, timestamp: 1000 }]);
        expect(estimatedListingAge.estimateTimestamp(500)).toBe(1000);
    });
});

describe('the listing log cannot be wiped by a failed read or a stale copy', () => {
    const row = (id, extra = {}) => ({
        id,
        timestamp: id * 1000,
        createdTimestamp: new Date(id * 1000).toISOString(),
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 1,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
        ...extra,
    });
    const storedLog = () => storageMock.storeFor('marketListings').get(LOG_KEY);

    test('a load while storage is unavailable keeps the in-memory log rather than blanking it', async () => {
        knownAs([row(1), row(2)]);
        storageMock.unavailable = true;

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 2]);
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored log', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2), row(3)]);
        // The failure mode that used to wipe histories: memory emptied by a
        // failed load, then a listing event saves that emptiness back
        knownAs([]);
        storageMock.unavailable = true;

        estimatedListingAge.recordListing(row(4));
        await estimatedListingAge.flushPendingSave();

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('a save merges what is stored under what is in memory, so rows from another writer survive', async () => {
        // Rows this tab has never loaded — another tab's, or an import written
        // straight to storage
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2, { status: 'unknown' })]);
        knownAs([row(2, { status: 'filled' })]);

        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge.flushPendingSave();

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
        // Memory's fresher status wins on the clash
        expect(storedLog().find((l) => l.id === 2).status).toBe('filled');
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 2, 3]);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1)]);
        knownAs([]);
        storageMock.unavailable = true;
        estimatedListingAge.recordListing(row(2));
        await estimatedListingAge.flushPendingSave();
        expect(storedLog().map((l) => l.id)).toEqual([1]);

        storageMock.unavailable = false;
        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge.flushPendingSave();

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
    });

    test('importListings lands in memory and storage together', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1)]);
        knownAs([row(1)]);

        await estimatedListingAge.importListings([row(1), row(9)]);
        // A later listing event must not undo the import
        estimatedListingAge.recordListing(row(10));
        await estimatedListingAge.flushPendingSave();

        expect(storedLog().map((l) => l.id)).toEqual([1, 9, 10]);
    });

    test('clearPersonalListings is the one write allowed to lose rows, and stays cleared', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2)]);
        knownAs([row(1), row(2)]);

        await estimatedListingAge.clearPersonalListings();
        expect(storedLog()).toEqual([]);

        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge.flushPendingSave();
        expect(storedLog().map((l) => l.id)).toEqual([3]);
    });

    test('deleteListing still removes the row despite merge-on-write', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2)]);
        knownAs([row(1), row(2)]);

        await estimatedListingAge.deleteListing(1);

        expect(storedLog().map((l) => l.id)).toEqual([2]);
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([2]);
    });
});

describe('recordListings — one pass for a batch', () => {
    const listing = (id, extra = {}) => ({
        id,
        createdTimestamp: new Date(id * 1000).toISOString(),
        itemHrid: '/items/a',
        ...extra,
    });

    test('records every listing, sorted by id, with one debounced save and one anchor growth', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, []);
        const addAnchors = vi.spyOn(estimatedListingAge, 'addAnchors');
        const save = vi.spyOn(estimatedListingAge, 'saveHistoricalData');

        estimatedListingAge.recordListings([listing(300), listing(100), listing(200)]);

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([100, 200, 300]);
        expect(addAnchors).toHaveBeenCalledTimes(1);
        expect(estimatedListingAge.anchors.map((a) => a.id)).toEqual([100, 200, 300]);
        // Nothing written yet: the save waits for the run of events to end
        expect(save).not.toHaveBeenCalled();

        await estimatedListingAge.flushPendingSave();
        expect(save).toHaveBeenCalledTimes(1);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([100, 200, 300]);

        addAnchors.mockRestore();
        save.mockRestore();
    });

    test('the debounce fires on its own once the window closes', async () => {
        vi.useFakeTimers();
        try {
            storageMock.storeFor('marketListings').set(LOG_KEY, []);
            const save = vi.spyOn(estimatedListingAge, 'saveHistoricalData');

            estimatedListingAge.recordListings([listing(1)]);
            estimatedListingAge.recordListings([listing(2)]);
            estimatedListingAge.recordListing(listing(3));
            expect(save).not.toHaveBeenCalled();

            vi.advanceTimersByTime(LISTING_SAVE_DEBOUNCE_MS);
            expect(save).toHaveBeenCalledTimes(1);
            expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 2, 3]);
            save.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    test('a status update in the same batch as the listing it updates lands in order', () => {
        estimatedListingAge.recordListings([
            listing(1),
            listing(1, { _toolashaStatus: 'filled' }),
            listing(2, { _toolashaStatus: 'canceled' }),
        ]);

        expect(estimatedListingAge.knownListings).toHaveLength(2);
        expect(estimatedListingAge.knownListings.find((l) => l.id === 1).status).toBe('filled');
        expect(estimatedListingAge.knownListings.find((l) => l.id === 2).status).toBe('canceled');
    });

    test('a batch with nothing datable changes nothing and schedules no save', () => {
        const save = vi.spyOn(estimatedListingAge, '_scheduleSave');
        estimatedListingAge.recordListings([{ id: 1 }, null]);
        expect(estimatedListingAge.knownListings).toEqual([]);
        expect(save).not.toHaveBeenCalled();
        save.mockRestore();
    });

    test('the listing handlers record a whole message as one batch', () => {
        estimatedListingAge.setupWebSocketListeners();
        const batches = vi.spyOn(estimatedListingAge, 'recordListings');

        dataManagerMock.handlers.market_listings_updated({
            newMarketListings: [listing(5), listing(6)],
            endMarketListings: [listing(7, { status: '/market_listing_status/filled' })],
        });

        expect(batches).toHaveBeenCalledTimes(2);
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([5, 6, 7]);
        expect(estimatedListingAge.knownListings.find((l) => l.id === 7).status).toBe('filled');

        batches.mockRestore();
        estimatedListingAge.unregisterWebSocket();
    });
});

describe('the wire payload is never written on', () => {
    const wire = (id, extra = {}) => ({
        id,
        createdTimestamp: new Date(id * 1000).toISOString(),
        itemHrid: '/items/a',
        orderQuantity: 100,
        filledQuantity: 0,
        ...extra,
    });

    beforeEach(() => {
        estimatedListingAge.knownListings = [];
        estimatedListingAge.rebuildEstimationPoints();
    });

    test('classifying an ended listing leaves the object the data manager holds alone', () => {
        estimatedListingAge.setupWebSocketListeners();
        const payload = wire(7, { status: '/market_listing_status/cancelled', filledQuantity: 40 });

        dataManagerMock.handlers.market_listings_updated({ endMarketListings: [payload] });

        // The log learned what happened...
        expect(estimatedListingAge.knownListings.find((l) => l.id === 7).status).toBe('filled');
        expect(estimatedListingAge.knownListings.find((l) => l.id === 7).orderQuantity).toBe(40);
        // ...without the shared object being touched
        expect(payload._toolashaStatus).toBeUndefined();
        expect(payload.orderQuantity).toBe(100);

        estimatedListingAge.unregisterWebSocket();
    });

    test('a new listing is stamped on a copy too', () => {
        estimatedListingAge.setupWebSocketListeners();
        const payload = wire(8);

        dataManagerMock.handlers.market_listings_updated({ newMarketListings: [payload] });

        expect(estimatedListingAge.knownListings.find((l) => l.id === 8).status).toBe('unknown');
        expect(payload._toolashaStatus).toBeUndefined();

        estimatedListingAge.unregisterWebSocket();
    });

    test('a promotion to active survives a later, unrelated market message', () => {
        // The bug this pins: the data manager stores the payload objects it
        // emitted and re-emits them on every later market message. A stamp left
        // on one outranked the tracked status, so a listing the My Listings
        // table had promoted to 'active' was knocked back to 'unknown' by the
        // next fill of some other order — losing it its retention exemption, its
        // expiry matching, and its place in the Market History display.
        estimatedListingAge.setupWebSocketListeners();
        const mine = wire(9);

        dataManagerMock.handlers.market_listings_updated({ newMarketListings: [mine] });
        estimatedListingAge.knownListings.find((l) => l.id === 9).status = 'active';

        // Some other listing fills; the merged book re-carries ours
        dataManagerMock.handlers.market_listings_updated({
            endMarketListings: [wire(10, { status: '/market_listing_status/filled', filledQuantity: 100 })],
            myMarketListings: [mine],
        });

        expect(estimatedListingAge.knownListings.find((l) => l.id === 9).status).toBe('active');

        estimatedListingAge.unregisterWebSocket();
    });
});

describe('disable drops what is keyed to the character', () => {
    test('the log and the order-book cache do not outlive the character', async () => {
        estimatedListingAge.knownListings = [
            {
                id: 1,
                timestamp: 1000,
                createdTimestamp: '1970-01-01T00:00:01Z',
                itemHrid: '/items/a',
                status: 'active',
            },
        ];
        estimatedListingAge.rebuildEstimationPoints();
        estimatedListingAge._cacheOrderBook('/items/a', { itemHrid: '/items/a', orderBooks: [] });
        const anchorsBefore = estimatedListingAge.anchors.length;

        await estimatedListingAge.disable();

        expect(estimatedListingAge.knownListings).toEqual([]);
        expect(estimatedListingAge.orderBooksCache).toEqual({});
        expect(estimatedListingAge.estimationPoints.every((point) => point.id !== 1)).toBe(true);
        // Anchors are global calibration data, not this character's
        expect(estimatedListingAge.anchors).toHaveLength(anchorsBefore);
    });

    test('character A’s ids are not written into character B’s key', async () => {
        storageMock.reset();
        dataManagerMock.characterId = 'charA';
        estimatedListingAge.knownListings = [];
        estimatedListingAge.recordListings([
            { id: 4242, createdTimestamp: '2026-01-01T00:00:00Z', itemHrid: '/items/a' },
        ]);
        await estimatedListingAge.saveHistoricalData();

        await estimatedListingAge.disable();

        dataManagerMock.characterId = 'charB';
        await estimatedListingAge.loadHistoricalData();
        estimatedListingAge.recordListings([
            { id: 77, createdTimestamp: '2026-01-02T00:00:00Z', itemHrid: '/items/b' },
        ]);
        await estimatedListingAge.saveHistoricalData();

        const bKey = [...storageMock.storeFor('marketListings').keys()].find((key) => key.includes('charB'));
        const stored = storageMock.storeFor('marketListings').get(bKey) || [];
        expect(stored.map((entry) => entry.id)).not.toContain(4242);

        dataManagerMock.characterId = 'market123';
    });
});

describe('order-book messages — stash now, repaint and persist once per burst', () => {
    const row = (listingId) => ({ listingId, price: 100, quantity: 1 });
    const book = (itemHrid, levels = 1, rows = 20) => ({
        marketItemOrderBooks: {
            itemHrid,
            orderBooks: Array.from({ length: levels }, () => ({
                asks: Array.from({ length: rows }, (_, i) => row(1000 + i)),
                bids: Array.from({ length: rows }, (_, i) => row(2000 + i)),
            })),
        },
    });

    test('a burst of books is cached at once but persisted and patched once per book', () => {
        vi.useFakeTimers();
        try {
            estimatedListingAge.setupWebSocketListeners();
            const handler = dataManagerMock.handlers.market_item_order_books_updated;
            const persist = vi.spyOn(estimatedListingAge, 'saveOrderBooksCache');

            for (let i = 0; i < 20; i++) handler(book(`/items/item_${i}`, 21));

            // Every book is in hand the moment it arrives
            expect(Object.keys(estimatedListingAge.orderBooksCache)).toHaveLength(20);
            expect(estimatedListingAge.currentItemHrid).toBe('/items/item_19');
            // One price patch call per book, carrying every level
            expect(marketMock.updatePrices).toHaveBeenCalledTimes(20);
            expect(marketMock.updatePrices.mock.calls[0][0]).toHaveLength(21);
            expect(marketMock.updatePrice).not.toHaveBeenCalled();
            // The write waits for the burst to end, then happens once
            expect(persist).not.toHaveBeenCalled();
            vi.advanceTimersByTime(ORDER_BOOK_REPAINT_MS);
            expect(persist).toHaveBeenCalledTimes(1);

            persist.mockRestore();
            estimatedListingAge.unregisterWebSocket();
        } finally {
            vi.useRealTimers();
        }
    });

    test('what is written out keeps only the head of each side, in the same shape', async () => {
        estimatedListingAge._cacheOrderBook('/items/a', book('/items/a', 2).marketItemOrderBooks);
        await estimatedListingAge.saveOrderBooksCache();

        const stored = storageMock.storeFor('marketListings').get('marketOrderBooksCache');
        const entry = stored['/items/a'];
        expect(entry.lastUpdated).toBe(estimatedListingAge.orderBooksCache['/items/a'].lastUpdated);
        expect(entry.data.itemHrid).toBe('/items/a');
        expect(entry.data.orderBooks).toHaveLength(2);
        expect(entry.data.orderBooks[0].asks).toHaveLength(ORDER_BOOK_PERSISTED_ROWS);
        expect(entry.data.orderBooks[0].asks[0]).toEqual(row(1000));
        expect(entry.data.orderBooks[1].bids).toHaveLength(ORDER_BOOK_PERSISTED_ROWS);
        // The in-memory book is untouched: the open item's table reads all of it
        expect(estimatedListingAge.orderBooksCache['/items/a'].data.orderBooks[0].asks).toHaveLength(20);
    });

    test('the cache is bounded by count, the least recently seen going first', () => {
        vi.useFakeTimers();
        try {
            for (let i = 0; i <= ORDER_BOOK_CACHE_MAX_ITEMS; i++) {
                vi.setSystemTime(1_000_000 + i * 1000);
                estimatedListingAge._cacheOrderBook(`/items/item_${i}`, book(`/items/item_${i}`).marketItemOrderBooks);
            }
            expect(Object.keys(estimatedListingAge.orderBooksCache)).toHaveLength(ORDER_BOOK_CACHE_MAX_ITEMS);
            expect(estimatedListingAge.orderBooksCache['/items/item_0']).toBeUndefined();
            expect(estimatedListingAge.orderBooksCache[`/items/item_${ORDER_BOOK_CACHE_MAX_ITEMS}`]).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    test('an older stored blob with whole books loads as it always did, aged and bounded', async () => {
        const now = Date.now();
        const weekAgo = now - 8 * 24 * 60 * 60 * 1000;
        storageMock.storeFor('marketListings').set('marketOrderBooksCache', {
            '/items/fresh': { lastUpdated: now - 1000, data: book('/items/fresh').marketItemOrderBooks },
            '/items/stale': { lastUpdated: weekAgo, data: book('/items/stale').marketItemOrderBooks },
            '/items/broken': null,
        });

        await estimatedListingAge.loadOrderBooksCache();

        expect(Object.keys(estimatedListingAge.orderBooksCache)).toEqual(['/items/fresh']);
        expect(estimatedListingAge.orderBooksCache['/items/fresh'].data.orderBooks[0].asks).toHaveLength(20);
    });
});

describe('listing log retention — the personal log no longer grows for life', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NEWEST = Date.UTC(2026, 5, 1);
    /** A listing `daysBack` days before the newest one, id descending with age */
    const aged = (daysBack, extra = {}) => {
        const timestamp = NEWEST - daysBack * DAY;
        return {
            id: 1_000_000 - daysBack,
            timestamp,
            createdTimestamp: new Date(timestamp).toISOString(),
            itemHrid: '/items/a',
            status: 'filled',
            ...extra,
        };
    };
    const byId = (listings) => [...listings].sort((a, b) => a.id - b.id);
    const storedLog = () => storageMock.storeFor('marketListings').get(LOG_KEY);

    test('listings older than the window before the newest are dropped; the rest are kept as-is', () => {
        const log = byId([aged(0), aged(89), aged(91), aged(400)]);
        const kept = applyListingRetention(log);
        expect(kept.map((l) => l.id)).toEqual(byId([aged(0), aged(89)]).map((l) => l.id));
        // Same objects, untouched: what estimation reads is unchanged
        expect(kept[1]).toBe(log.find((l) => l.id === aged(0).id));
    });

    test('the window is measured from the newest listing, not the clock', () => {
        // A log last written long ago keeps its 90 days of history
        const log = byId([aged(800), aged(850), aged(880)]);
        expect(applyListingRetention(log)).toBe(log);
    });

    test('a still-active listing is never dropped, however old', () => {
        const log = byId([aged(0), aged(500, { status: 'active' }), aged(600)]);
        expect(applyListingRetention(log).map((l) => l.status)).toEqual(['active', 'filled']);
    });

    test('beyond the cap only the newest are kept, active ones aside', () => {
        const listings = [];
        for (let i = 0; i < LISTING_RETENTION_MAX + 10; i++) {
            const timestamp = NEWEST - i * 1000;
            listings.push({ id: 2_000_000 - i, timestamp, itemHrid: '/items/a', status: 'filled' });
        }
        // The oldest of all is active, so it stays while newer filled ones go
        listings[listings.length - 1].status = 'active';
        const kept = applyListingRetention(byId(listings));

        expect(kept).toHaveLength(LISTING_RETENTION_MAX);
        expect(kept.some((l) => l.status === 'active')).toBe(true);
        const filledKept = kept.filter((l) => l.status === 'filled');
        const newestFilled = listings.filter((l) => l.status === 'filled').slice(0, LISTING_RETENTION_MAX - 1);
        expect(filledKept.map((l) => l.id)).toEqual(byId(newestFilled).map((l) => l.id));
        // Still sorted by id
        expect(kept.map((l) => l.id)).toEqual(byId(kept).map((l) => l.id));
    });

    test('a log with nothing to drop is returned as-is', () => {
        const log = byId([aged(0), aged(10)]);
        expect(applyListingRetention(log)).toBe(log);
        expect(applyListingRetention([])).toEqual([]);
    });

    test('retention is applied on load, and the trimmed log is written back', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, byId([aged(0), aged(50), aged(200)]));

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual(byId([aged(0), aged(50)]).map((l) => l.id));
        expect(storedLog().map((l) => l.id)).toEqual(byId([aged(0), aged(50)]).map((l) => l.id));
        // And the estimation points (personal log over the shared anchors)
        // carry what remains and not what went
        const pointIds = estimatedListingAge.estimationPoints.map((l) => l.id);
        expect(pointIds).toContain(aged(0).id);
        expect(pointIds).toContain(aged(50).id);
        expect(pointIds).not.toContain(aged(200).id);
    });

    test('recording a batch lets the newest listing in it push old history out', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, []);
        knownAs(byId([aged(100), aged(120)]));
        // Both within 90 days of each other: nothing pruned yet
        expect(estimatedListingAge.knownListings).toHaveLength(2);

        estimatedListingAge.recordListings([aged(0)]);

        // A one-listing batch does not buy a full retention pass; the prune
        // happens before the log is written, which is the only moment it matters
        expect(estimatedListingAge.knownListings).toHaveLength(3);

        await estimatedListingAge.flushPendingSave();
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([aged(0).id]);
        // The save lands the trimmed log; what is stored does not resurrect the rest
        expect(storedLog().map((l) => l.id)).toEqual([aged(0).id]);
    });

    test('retention does not re-run on every batch, but a big enough run of them triggers it', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, []);
        knownAs(byId([aged(100), aged(120)]));
        const sweep = vi.spyOn(estimatedListingAge, '_applyRetention');

        for (let i = 0; i < 20; i++) estimatedListingAge.recordListings([aged(0, { id: 900_000 + i })]);
        expect(sweep).not.toHaveBeenCalled();

        // Enough listings in one go to pay for a pass
        const batch = Array.from({ length: RETENTION_SWEEP_EVERY }, (_, i) => aged(0, { id: 800_000 + i }));
        estimatedListingAge.recordListings(batch);
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(estimatedListingAge.knownListings.some((l) => l.id === aged(100).id)).toBe(false);

        // And the counter starts again, so the next small batch is free
        sweep.mockClear();
        estimatedListingAge.recordListings([aged(0, { id: 700_000 })]);
        expect(sweep).not.toHaveBeenCalled();
        sweep.mockRestore();
    });

    test('a save does not bring trimmed rows back from storage', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, byId([aged(0), aged(200)]));
        knownAs(byId([aged(0)]));

        await estimatedListingAge.saveHistoricalData();

        expect(storedLog().map((l) => l.id)).toEqual([aged(0).id]);
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([aged(0).id]);
    });

    test('your own active listing survives load, record and save', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, byId([aged(300, { status: 'active' }), aged(250)]));
        await estimatedListingAge.loadHistoricalData();
        estimatedListingAge.recordListings([aged(0)]);
        await estimatedListingAge.flushPendingSave();

        const ids = (list) => list.map((l) => l.id);
        expect(ids(estimatedListingAge.knownListings)).toEqual(byId([aged(300), aged(0)]).map((l) => l.id));
        expect(ids(storedLog())).toEqual(byId([aged(300), aged(0)]).map((l) => l.id));
    });

    test('the window is 90 days and the cap 5000', () => {
        expect(LISTING_RETENTION_MS).toBe(90 * DAY);
        expect(LISTING_RETENTION_MAX).toBe(5000);
    });
});

describe('matchesExpiredRow — disambiguating an expired My Listings row', () => {
    const base = {
        itemHrid: '/items/sword',
        status: 'active',
        isSell: true,
        price: 100,
        orderQuantity: 1,
        filledQuantity: 0,
        enhancementLevel: 0,
    };
    const row = {
        itemHrid: '/items/sword',
        enhancementLevel: 0,
        isSell: true,
        price: 100,
        orderQuantity: 1,
        filledQuantity: 0,
    };

    test('matches on item, side, price and quantity when levels agree', () => {
        expect(matchesExpiredRow(base, row)).toBe(true);
    });

    test('does not match a listing of the same item at a different enhancement level', () => {
        // A +0 sword and a +10 sword sitting at the same price with nothing filled on either —
        // identical on every field this used to check. Without the level compared, the +10
        // listing (still very much alive) would get wrongly stamped "expired" for a +0 row.
        const plusTen = { ...base, enhancementLevel: 10 };
        expect(matchesExpiredRow(plusTen, row)).toBe(false);
        expect(matchesExpiredRow(base, row)).toBe(true);
    });

    test('an unknown enhancement level (undefined) still matches a level-0 candidate', () => {
        const legacy = { ...base, enhancementLevel: undefined };
        expect(matchesExpiredRow(legacy, row)).toBe(true);
    });

    test('a resolved listing is never re-matched', () => {
        const filled = { ...base, status: 'filled' };
        expect(matchesExpiredRow(filled, row)).toBe(false);
    });
});

describe('matchesBeyondTopRow — disambiguating a your-listing row past the top 20', () => {
    const base = {
        itemHrid: '/items/sword',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: 5,
        filledQuantity: 2,
        isSell: true,
    };
    const row = { itemHrid: '/items/sword', enhancementLevel: 0, price: 100, quantity: 3, isSell: true };

    test('matches on item, level, price, remaining quantity and side', () => {
        expect(matchesBeyondTopRow(base, row)).toBe(true);
    });

    test('does not match a listing of the same item at a different enhancement level', () => {
        // Same item, same price, same 3 remaining — but a +0 and a +10 sell. Before the level
        // check this stole the wrong listing's timestamp (or its "used" slot) for this row.
        const plusTen = { ...base, enhancementLevel: 10 };
        expect(matchesBeyondTopRow(plusTen, row)).toBe(false);
        expect(matchesBeyondTopRow(base, row)).toBe(true);
    });
});

describe('getCurrentItemHrid — TERTIARY fallback via a Cancel row', () => {
    /**
     * Order-book DOM shape the TERTIARY branch reads: a container holding a
     * table whose row carries a remaining-quantity cell, a `[class*="price"]`
     * cell, and a "Cancel" button (the marker for "this row is one of yours").
     */
    function renderCancelRow({ quantity, price }) {
        document.body.innerHTML = `
            <div class="MarketplacePanel_orderBooksContainer">
                <table><tbody><tr>
                    <td>${quantity}</td>
                    <td class="price">${price}</td>
                    <td>Cancel</td>
                </tr></tbody></table>
            </div>`;
    }

    beforeEach(() => {
        // Force past PRIMARY (no currentItem element in the DOM above) and
        // SECONDARY (no WebSocket-tracked item) so only TERTIARY runs.
        estimatedListingAge.currentItemHrid = null;
    });

    test('resolves the item when exactly one of your listings matches price and remaining quantity', () => {
        knownAs([{ id: 1, itemHrid: '/items/sword', price: 100, orderQuantity: 5, filledQuantity: 0 }]);
        renderCancelRow({ quantity: 5, price: 100 });

        expect(estimatedListingAge.getCurrentItemHrid()).toBe('/items/sword');
    });

    test('does not guess an item when two different items collide on price and remaining quantity', () => {
        // Nothing here disambiguates by item — this branch exists precisely to learn the
        // item hrid, so it cannot filter on it the way matchesExpiredRow/matchesBeyondTopRow
        // do. Two of your own listings for different items that happen to share a price and a
        // remaining quantity must not resolve to whichever one .find() happens to hit first —
        // that silently mislabels every order book row for the rest of this render.
        knownAs([
            { id: 1, itemHrid: '/items/sword', price: 100, orderQuantity: 5, filledQuantity: 0 },
            { id: 2, itemHrid: '/items/shield', price: 100, orderQuantity: 5, filledQuantity: 0 },
        ]);
        renderCancelRow({ quantity: 5, price: 100 });

        expect(estimatedListingAge.getCurrentItemHrid()).toBeNull();
    });
});

describe('teardown is awaitable, so the switch waits for the listing log to land', () => {
    test('disable() does not resolve until the debounced save has been written', async () => {
        // `disable()` flushes the save a debounce is still holding, and then
        // its `finally` empties `knownListings` — the per-character memory that
        // must not survive into the next character. But the flush is a
        // read-merge-write that resumes after an await, so unless disable()
        // waits for it the clear wins the race and the log is written empty.
        // On a character switch the same await is what decides *whose* key it
        // is written under: `saveHistoricalData` evaluates `characterKey()`
        // when it runs, and the registry can only hold the switch back if this
        // teardown hands it a promise to wait on.
        const KEY = LOG_KEY;
        storageMock.storeFor('marketListings').delete(KEY);
        estimatedListingAge.knownListings = [
            { id: 7, itemHrid: '/items/a', status: 'listed', firstSeen: 1_000, lastSeen: Date.now() },
        ];
        estimatedListingAge.isInitialized = true;
        // A save waiting on its debounce, exactly as a recorded listing leaves it
        estimatedListingAge._scheduleSave();

        await estimatedListingAge.disable();

        expect(
            storageMock
                .storeFor('marketListings')
                .get(KEY)
                ?.map((l) => l.id)
        ).toEqual([7]);
    });
});

describe('a character switch landing inside a delete', () => {
    test('the arriving character’s listing log is not overwritten by it', async () => {
        // `deleteListing` re-syncs from storage first — several storage hops —
        // and then writes with `overwrite: true`, which is a full replacement.
        // The key used to be resolved at the write, so a switch inside the
        // re-sync filed the departing character's log (or the empty one
        // `disable()` leaves behind) under the ARRIVING character's key, wiping
        // a listing history that nothing can rebuild.
        const A_KEY = 'marketListingTimestamps_charA';
        const B_KEY = 'marketListingTimestamps_charB';
        dataManagerMock.characterId = 'charA';
        estimatedListingAge.anchorsLoaded = true;
        storageMock.storeFor('marketListings').set(A_KEY, [
            { id: 1, timestamp: 1000, itemHrid: '/items/a', status: 'active' },
            { id: 2, timestamp: 2000, itemHrid: '/items/a', status: 'active' },
        ]);
        storageMock
            .storeFor('marketListings')
            .set(B_KEY, [{ id: 9, timestamp: 9000, itemHrid: '/items/b', status: 'active' }]);

        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const read = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementationOnce(async (...args) => {
            await held;
            return read(...args);
        });

        const deleting = estimatedListingAge.deleteListing(2);
        await Promise.resolve();

        await estimatedListingAge.disable();
        dataManagerMock.characterId = 'charB';

        release();
        await deleting;

        expect(storageMock.storeFor('marketListings').get(B_KEY)).toEqual([
            { id: 9, timestamp: 9000, itemHrid: '/items/b', status: 'active' },
        ]);
    });
});

describe('cachedTopOfBook', () => {
    beforeEach(() => {
        estimatedListingAge.orderBooksCache = {};
    });

    /** The wire's payload shape, wrapped the way the cache stores it. */
    const cache = (orderBooks) => ({ data: { orderBooks }, lastUpdated: Date.now() });

    test('reads the top ask and the top bid off a book keyed by level', () => {
        estimatedListingAge.orderBooksCache = {
            '/items/coal': cache({
                0: { asks: [{ price: 120 }, { price: 130 }], bids: [{ price: 100 }, { price: 90 }] },
            }),
        };

        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, true)).toBe(120);
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, false)).toBe(100);
    });

    test('reads a sparse array of books by enhancement level', () => {
        const books = [];
        books[2] = { asks: [{ price: 500 }], bids: [{ price: 400 }] };
        estimatedListingAge.orderBooksCache = { '/items/sword': cache(books) };

        expect(estimatedListingAge.cachedTopOfBook('/items/sword', 2, true)).toBe(500);
        expect(estimatedListingAge.cachedTopOfBook('/items/sword', 2, false)).toBe(400);
        expect(estimatedListingAge.cachedTopOfBook('/items/sword', 1, true)).toBeNull();
    });

    test('defaults to level 0 and the ask side', () => {
        estimatedListingAge.orderBooksCache = {
            '/items/coal': cache({ 0: { asks: [{ price: 120 }], bids: [{ price: 100 }] } }),
        };
        expect(estimatedListingAge.cachedTopOfBook('/items/coal')).toBe(120);
    });

    test('reads the pre-wrapper cache shape too', () => {
        estimatedListingAge.orderBooksCache = {
            '/items/coal': { orderBooks: { 0: { asks: [{ price: 42 }] } } },
        };
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, true)).toBe(42);
    });

    test('is null for an item, level or side the cache has nothing for', () => {
        estimatedListingAge.orderBooksCache = {
            '/items/coal': cache({ 0: { asks: [], bids: [{ price: 100 }] } }),
        };
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, true)).toBeNull();
        expect(estimatedListingAge.cachedTopOfBook('/items/tin', 0, true)).toBeNull();
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 9, false)).toBeNull();
    });

    test('rejects a zero or non-numeric top price rather than passing it on as a divisor', () => {
        estimatedListingAge.orderBooksCache = {
            '/items/coal': cache({ 0: { asks: [{ price: 0 }], bids: [{ price: null }] } }),
        };
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, true)).toBeNull();
        expect(estimatedListingAge.cachedTopOfBook('/items/coal', 0, false)).toBeNull();
    });
});

/**
 * A deleted listing used to come straight back on the next pull: the log's fold
 * is a union by id, only the pulling device merges, so a peer that still held
 * the row pushed it back and the deletion was undone in both directions.
 */
describe('deleted listings stay deleted across a sync pull', () => {
    const GRAVES_KEY = 'marketListingGraves_market123';
    const row = (id, timestamp) => ({ id, timestamp, itemHrid: '/items/coin', status: 'sold' });

    /** What a pull leaves at a key: this device's copy folded under the peer's */
    const pull = (key, incoming) => {
        const registration = mergeForKey('marketListings', key);
        expect(registration).not.toBeNull();
        const local = storageMock.storeFor('marketListings').get(key) ?? null;
        storageMock.storeFor('marketListings').set(key, structuredClone(registration.merge(local, incoming)));
    };

    /** Forget everything this session held, as a fresh load would */
    const reload = async () => {
        estimatedListingAge.knownListings = [];
        estimatedListingAge.listingGraves = { removed: {}, clearedThrough: 0 };
        await estimatedListingAge.loadHistoricalData();
    };

    test('the tombstone key claims its own fold', () => {
        expect(mergeForKey('marketListings', GRAVES_KEY)?.label).toBe('Market listing deletions');
        expect(mergeForKey('marketListings', 'marketListingGraves')?.label).toBe('Market listing deletions');
        // and does not reach across to the log or the anchors
        expect(mergeForKey('marketListings', 'marketListingTimestamps')?.label).toBe('Market listing log');
        expect(mergeForKey('marketListings', 'marketListingAnchors')?.label).toBe('Market listing anchors');
    });

    test('a single deleted row is not resurrected by a peer that still holds it', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1, 1000), row(2, 2000), row(3, 3000)]);
        await estimatedListingAge.loadHistoricalData();

        await estimatedListingAge.deleteListing(2);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([1, 3]);

        // The peer pushes the log it still has, and its empty tombstone record
        pull(LOG_KEY, [row(1, 1000), row(2, 2000), row(3, 3000), row(4, 4000)]);
        pull(GRAVES_KEY, null);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([1, 2, 3, 4]);

        await reload();

        // The deletion holds, and the row the peer recorded after it survives
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 3, 4]);
        // and the prune reached the key, so it is not pushed back out
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([1, 3, 4]);
    });

    test('the peer applies the deletion too, so it holds in both directions', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1, 1000), row(2, 2000), row(3, 3000)]);
        await estimatedListingAge.loadHistoricalData();
        await estimatedListingAge.deleteListing(2);
        const pushedGraves = storageMock.storeFor('marketListings').get(GRAVES_KEY);

        // Now stand in for the peer: its own full log, pulling our record
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1, 1000), row(2, 2000), row(3, 3000)]);
        storageMock.storeFor('marketListings').delete(GRAVES_KEY);
        pull(GRAVES_KEY, pushedGraves);
        await reload();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 3]);
    });

    test('Clear History survives a peer pushing the whole log back', async () => {
        const whole = [row(1, 1000), row(2, 2000), row(3, 3000), row(4, 4000), row(5, 5000)];
        storageMock.storeFor('marketListings').set(LOG_KEY, whole);
        await estimatedListingAge.loadHistoricalData();

        await estimatedListingAge.clearPersonalListings();
        expect(storageMock.storeFor('marketListings').get(LOG_KEY)).toEqual([]);
        expect(storageMock.storeFor('marketListings').get(GRAVES_KEY).clearedThrough).toBe(5);

        pull(LOG_KEY, [...whole, row(9, 9000)]);
        pull(GRAVES_KEY, null);
        await reload();

        // Everything the clear named is gone; what the peer recorded after it stays
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([9]);
    });

    test('the anchor pool is untouched by a clear, so age estimates do not regress', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1, 1000), row(2, 2000), row(3, 3000)]);
        storageMock.storeFor('marketListings').set(ANCHORS_KEY, [
            { id: 1, timestamp: 1000 },
            { id: 3, timestamp: 3000 },
        ]);
        await estimatedListingAge.loadHistoricalData();
        await estimatedListingAge.clearPersonalListings();

        // The pool the estimator calibrates on is deliberately kept whole
        const anchorIds = storageMock
            .storeFor('marketListings')
            .get(ANCHORS_KEY)
            .map((anchor) => anchor.id);
        expect(anchorIds).toContain(1);
        expect(anchorIds).toContain(3);
        // The anchors alone still date a listing between them
        expect(estimatedListingAge.estimateTimestamp(2)).toBe(2000);
    });

    test('a log with no deletions is left exactly as it was', () => {
        const log = [row(1, 1000), row(2, 2000)];
        expect(applyListingGraves(log, { removed: {}, clearedThrough: 0 })).toBe(log);
        expect(applyListingGraves(log, null)).toBe(log);
    });
});

describe('the tombstone record itself', () => {
    test('the later deletion wins per id, and the higher watermark stands', () => {
        const now = 1_000_000;
        const folded = mergeListingGraves(
            { removed: { 1: now - 900, 2: now - 500 }, clearedThrough: 7 },
            { removed: { 1: now - 300 }, clearedThrough: 3 },
            now
        );
        expect(folded).toEqual({ removed: { 1: now - 300, 2: now - 500 }, clearedThrough: 7 });
    });

    test('deletions older than the max age are forgotten', () => {
        const now = 10 * TOMBSTONE_MAX_AGE_MS;
        const folded = mergeListingGraves({ removed: { 1: now - TOMBSTONE_MAX_AGE_MS, 2: now - 1000 } }, null, now);
        expect(Object.keys(folded.removed)).toEqual(['2']);
    });

    test('the map is capped, newest deletions kept', () => {
        const removed = {};
        for (let i = 0; i < MAX_LISTING_TOMBSTONES + 10; i++) removed[i] = 1000 + i;
        const folded = mergeListingGraves({ removed }, null, 1000);
        expect(Object.keys(folded.removed)).toHaveLength(MAX_LISTING_TOMBSTONES);
        expect(folded.removed[MAX_LISTING_TOMBSTONES + 9]).toBe(1000 + MAX_LISTING_TOMBSTONES + 9);
        expect(folded.removed[0]).toBeUndefined();
    });

    test('a mass delete above the clear watermark is refused rather than applied', () => {
        const log = [1, 2, 3, 4, 5].map((id) => ({ id, timestamp: id * 1000, itemHrid: '/items/coin' }));
        const removed = {};
        for (const listing of log) removed[String(listing.id)] = 1;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // No watermark: nothing says the user asked for the whole log to go
        expect(applyListingGraves(log, { removed, clearedThrough: 0 })).toBe(log);
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    test('a two-row log has no majority worth protecting, so the delete applies', () => {
        const log = [1, 2].map((id) => ({ id, timestamp: id * 1000, itemHrid: '/items/coin' }));
        expect(applyListingGraves(log, { removed: { 1: 1, 2: 1 }, clearedThrough: 0 })).toEqual([]);
    });
});
