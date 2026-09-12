/**
 * The reservation ledger: what one plan claims, and what that leaves the others.
 *
 * Two properties carry the whole feature and both are easy to get subtly wrong:
 * an owner must never be deducted from itself (or a plan grows a shortfall
 * every time it recomputes), and the whole thing must be inert while the
 * setting is off (or five features change behaviour on an unrelated release).
 * Everything else here is the storage discipline the record already owns.
 *
 * The storage and data-manager doubles follow `features/planner/goal-planner-store.test.js`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockDataManager = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    inventory: [],
    handlers: new Map(),
    getCurrentCharacterId: vi.fn(() => mockDataManager.currentCharacterId),
    getInventory: vi.fn(() => mockDataManager.inventory),
    on: vi.fn((event, handler) => mockDataManager.handlers.set(event, handler)),
    off: vi.fn((event) => mockDataManager.handlers.delete(event)),
}));

const mockConfig = vi.hoisted(() => ({
    enabled: true,
    getSetting: vi.fn((key) => (key === 'inventoryReservations' ? mockConfig.enabled : false)),
}));

const mockStorage = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            mockStorage.unavailable = false;
        },
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        tryGet: vi.fn(async (key, storeName = 'settings') => {
            if (mockStorage.unavailable) return null;
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null
                ? { found: true, value: structuredClone(store.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            if (mockStorage.unavailable) return false;
            storeFor(storeName).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, storeName = 'settings') => {
            storeFor(storeName).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (storeName = 'settings') => Array.from(storeFor(storeName).keys())),
    };
});

vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/config.js', () => ({ default: mockConfig }));
vi.mock('../core/storage.js', () => ({ default: mockStorage }));

const {
    RESERVATIONS_KEY,
    RESERVATION_TTL_MS,
    reserve,
    release,
    releaseMissing,
    loadReservations,
    allReservations,
    reservationDetail,
    reservedElsewhere,
    effectiveInventory,
    effectiveInventoryRows,
    heldInInventory,
    reservationNote,
    shortfallNote,
    mergeReservations,
    RELEASED_KEY,
    flushReservationWrites,
    ensureReservationsLoaded,
    _resetReservations,
} = await import('./inventory-reservations.js');

const LOGS = '/items/log';
const KEY = `${RESERVATIONS_KEY}_market123`;

/**
 * @param {Array<Object>} rows - Partial inventory rows
 * @returns {void}
 */
function setInventory(rows) {
    mockDataManager.inventory = rows.map((row) => ({
        itemLocationHrid: '/item_locations/inventory',
        enhancementLevel: 0,
        ...row,
    }));
}

beforeEach(() => {
    mockStorage.reset();
    mockConfig.enabled = true;
    mockDataManager.currentCharacterId = 'market123';
    setInventory([{ itemHrid: LOGS, count: 500 }]);
    _resetReservations();
});

describe('reserve, replace and release', () => {
    test('a reservation is one owner’s current claim, and reserving again replaces it', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        expect(reservedElsewhere(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(300);

        await reserve('goal:a', [{ itemHrid: LOGS, count: 120 }], { label: 'Goal: Cheese sword' });
        expect(reservedElsewhere(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(120);
    });

    test('two lines for one item in a single claim are one claim, summed', async () => {
        await reserve('goal:a', [
            { itemHrid: LOGS, count: 100 },
            { itemHrid: LOGS, count: 50 },
        ]);
        expect(reservedElsewhere(LOGS)).toBe(150);
    });

    test('an enhancement level is part of which item is claimed', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300, enhancementLevel: 5 }]);
        expect(reservedElsewhere(LOGS, 0)).toBe(0);
        expect(reservedElsewhere(LOGS, 5)).toBe(300);
    });

    test('release drops the claim', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await release('goal:a');
        expect(reservedElsewhere(LOGS)).toBe(0);
        expect(allReservations()['goal:a']).toBeUndefined();
    });

    test('reserving nothing is a release — a plan that needs nothing holds nothing', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await reserve('goal:a', []);
        expect(allReservations()['goal:a']).toBeUndefined();
    });

    test('non-positive and malformed lines are dropped rather than stored', async () => {
        await reserve('goal:a', [
            { itemHrid: LOGS, count: 0 },
            { itemHrid: LOGS, count: -5 },
            { count: 10 },
            null,
            { itemHrid: LOGS, count: 7 },
        ]);
        expect(allReservations()['goal:a'].lines).toEqual([{ itemHrid: LOGS, enhancementLevel: 0, count: 7 }]);
    });
});

describe('what a plan may plan against', () => {
    test('an owner is never deducted from itself', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:a' })).toBe(500);
    });

    test('another owner’s claim comes off', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(200);
    });

    test('claims beyond what is held floor at zero rather than going negative', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 400 }]);
        await reserve('goal:b', [{ itemHrid: LOGS, count: 400 }]);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:c' })).toBe(0);
    });

    test('a caller that counts held its own way passes it in', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        // 500 in the bag plus 200 bought-but-unclaimed, as the action calculator counts it
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b', held: 700 })).toBe(400);
    });

    test('held counts only unequipped copies at the level asked for', () => {
        setInventory([
            { itemHrid: LOGS, count: 500 },
            { itemHrid: LOGS, count: 9, itemLocationHrid: '/item_locations/equipment' },
            { itemHrid: LOGS, count: 4, enhancementLevel: 3 },
        ]);
        expect(heldInInventory(LOGS)).toBe(500);
        expect(heldInInventory(LOGS, 3)).toBe(4);
    });
});

describe('inventory rows with other claims taken out', () => {
    test('a claim is spent once across the rows that carry the item', async () => {
        setInventory([
            { itemHrid: LOGS, count: 200 },
            { itemHrid: LOGS, count: 300 },
            { itemHrid: '/items/coin', count: 50 },
        ]);
        await reserve('goal:a', [{ itemHrid: LOGS, count: 250 }]);

        const rows = effectiveInventoryRows(mockDataManager.inventory, { excludeOwner: 'goal:b' });
        expect(rows.map((row) => [row.itemHrid, row.count])).toEqual([
            [LOGS, 250],
            ['/items/coin', 50],
        ]);
    });

    test('the caller cannot write through the result into the real inventory', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 100 }]);
        const rows = effectiveInventoryRows(mockDataManager.inventory, { excludeOwner: 'goal:b' });
        rows[0].count = 1;
        expect(mockDataManager.inventory[0].count).toBe(500);
    });
});

describe('the visibility line', () => {
    test('names the claimant when a shortfall is somebody else’s claim', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        expect(shortfallNote(120, LOGS, 0, { excludeOwner: 'goal:b' })).toBe(
            '120 short — 300 reserved by "Goal: Cheese sword"'
        );
    });

    test('names two claimants, and counts the rest', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        await reserve('goal:b', [{ itemHrid: LOGS, count: 100 }], { label: 'Goal: Holy sword' });
        expect(shortfallNote(1, LOGS, 0, { excludeOwner: 'goal:z' })).toBe(
            '1 short — 400 reserved by "Goal: Cheese sword" and "Goal: Holy sword"'
        );

        await reserve('goal:c', [{ itemHrid: LOGS, count: 50 }], { label: 'Goal: Third' });
        await reserve('goal:d', [{ itemHrid: LOGS, count: 25 }], { label: 'Goal: Fourth' });
        expect(shortfallNote(1, LOGS, 0, { excludeOwner: 'goal:z' })).toBe(
            '1 short — 475 reserved by "Goal: Cheese sword" and 3 other plans'
        );
    });

    test('is empty when nothing else has a claim, so a caller can append it blind', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        expect(shortfallNote(120, LOGS, 0, { excludeOwner: 'goal:a' })).toBe('');
    });

    test('names the claim on its own for a caller with no shortfall to quote', async () => {
        // The crafting-plan panel's list is the plan for ONE unit of output while
        // its Buy button re-plans for the whole run: it can say truthfully who
        // holds the stock, and cannot say by how much the run is short.
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        await reserve('goal:b', [{ itemHrid: LOGS, count: 100 }], { label: 'Goal: Holy sword' });
        expect(reservationNote(LOGS, 0, { excludeOwner: 'goal:z' })).toBe(
            '400 reserved by "Goal: Cheese sword" and "Goal: Holy sword"'
        );
    });

    test('the claim line and the shortfall line name the same claimants', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        expect(shortfallNote(120, LOGS, 0, { excludeOwner: 'goal:b' })).toBe(
            `120 short — ${reservationNote(LOGS, 0, { excludeOwner: 'goal:b' })}`
        );
    });

    test('the claim line is empty when nothing else has a claim', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        expect(reservationNote(LOGS, 0, { excludeOwner: 'goal:a' })).toBe('');
    });

    test('detail is ordered largest claim first', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 10 }], { label: 'Small' });
        await reserve('goal:b', [{ itemHrid: LOGS, count: 90 }], { label: 'Large' });
        expect(reservationDetail(LOGS).byOwner.map((entry) => entry.label)).toEqual(['Large', 'Small']);
    });
});

describe('the setting is off by default and off means inert', () => {
    beforeEach(() => {
        mockConfig.enabled = false;
    });

    test('effectiveInventory is the held count, untouched', async () => {
        mockConfig.enabled = true;
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        mockConfig.enabled = false;

        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b', held: 700 })).toBe(700);
        expect(reservedElsewhere(LOGS)).toBe(0);
        expect(shortfallNote(120, LOGS)).toBe('');
    });

    test('rows come back as the very same array', () => {
        const rows = mockDataManager.inventory;
        expect(effectiveInventoryRows(rows, { excludeOwner: 'goal:b' })).toBe(rows);
    });

    test('reserve writes nothing at all', async () => {
        mockStorage.set.mockClear();
        expect(await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }])).toBe(false);
        expect(mockStorage.set).not.toHaveBeenCalled();
        expect(allReservations()).toEqual({});
    });

    test('a release with nothing to drop still writes nothing', async () => {
        mockStorage.set.mockClear();
        expect(await release('goal:a')).toBe(false);
        expect(await releaseMissing('goal:', [])).toBe(0);
        await flushReservationWrites();
        expect(mockStorage.set).not.toHaveBeenCalled();
    });

    test('an owner that releases while off is gone, not waiting to come back on', async () => {
        mockConfig.enabled = true;
        await reserve('missingMats', [{ itemHrid: LOGS, count: 300 }]);
        await flushReservationWrites();

        mockConfig.enabled = false;
        expect(await release('missingMats')).toBe(true);
        await flushReservationWrites();
        // The claim is gone and the removal is written down: a release while
        // off still has to outlive a peer that has not seen it
        expect(Object.keys(mockStorage.storeFor('settings').get(KEY))).toEqual([RELEASED_KEY]);
        expect(mockStorage.storeFor('settings').get(KEY)[RELEASED_KEY]).toHaveProperty('missingMats');

        // Switched back on, with the record read from storage rather than memory
        _resetReservations();
        mockConfig.enabled = true;
        expect(await loadReservations()).toEqual({});
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);
    });

    test('an orphan sweep while off drops the deleted goal’s claim', async () => {
        mockConfig.enabled = true;
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await reserve('goal:b', [{ itemHrid: LOGS, count: 100 }]);
        await flushReservationWrites();

        mockConfig.enabled = false;
        expect(await releaseMissing('goal:', ['goal:b'])).toBe(1);
        await flushReservationWrites();
        expect(Object.keys(mockStorage.storeFor('settings').get(KEY)).sort()).toEqual([RELEASED_KEY, 'goal:b']);
        expect(mockStorage.storeFor('settings').get(KEY)[RELEASED_KEY]).toHaveProperty('goal:a');
    });

    /*
     * The load a release needs must not leak into the read paths: those staying
     * inert is the whole safety property of the off switch, and the release now
     * puts a real ledger in memory for them to be tempted by.
     */
    test('the read paths stay inert even once a release has loaded the ledger', async () => {
        mockConfig.enabled = true;
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await reserve('missingMats', [{ itemHrid: LOGS, count: 150 }]);
        await flushReservationWrites();

        mockConfig.enabled = false;
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);

        await release('missingMats');
        await flushReservationWrites();

        // `goal:a` is still on the record, and still claims nothing anyone can see
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b', held: 700 })).toBe(700);
        expect(reservedElsewhere(LOGS)).toBe(0);
        expect(reservationDetail(LOGS)).toEqual({ total: 0, byOwner: [] });
        expect(shortfallNote(120, LOGS)).toBe('');
        expect(effectiveInventoryRows(mockDataManager.inventory)).toBe(mockDataManager.inventory);
        expect(allReservations()).toEqual({});
    });
});

describe('persistence', () => {
    test('a claim round-trips under the character’s own key', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: Cheese sword' });
        await flushReservationWrites();
        expect(mockStorage.storeFor('settings').has(KEY)).toBe(true);

        _resetReservations();
        const ledger = await loadReservations();
        expect(ledger['goal:a'].lines).toEqual([{ itemHrid: LOGS, enhancementLevel: 0, count: 300 }]);
        expect(ledger['goal:a'].label).toBe('Goal: Cheese sword');
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(200);
    });

    test('another character’s ledger is not this one’s', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await flushReservationWrites();

        mockDataManager.currentCharacterId = 'ironcow456';
        expect(await loadReservations()).toEqual({});
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);
    });

    test('a store that cannot be read leaves the ledger in hand rather than blanking it', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await flushReservationWrites();

        mockStorage.unavailable = true;
        expect(reservedElsewhere(LOGS)).toBe(300);
        await loadReservations();
        expect(reservedElsewhere(LOGS)).toBe(300);
    });
});

describe('owners that no longer exist', () => {
    test('a deleted goal’s claim goes with it', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await reserve('goal:b', [{ itemHrid: LOGS, count: 100 }]);
        await reserve('missingMats', [{ itemHrid: LOGS, count: 50 }]);

        expect(await releaseMissing('goal:', ['goal:b'])).toBe(1);
        expect(Object.keys(allReservations()).sort()).toEqual(['goal:b', 'missingMats']);
    });

    test('a claim nobody has restamped inside the TTL expires on load', async () => {
        const now = Date.UTC(2026, 0, 15);
        vi.setSystemTime(now);
        await reserve('craftingPlan:/items/cheese', [{ itemHrid: LOGS, count: 300 }]);
        await flushReservationWrites();

        _resetReservations();
        vi.setSystemTime(now + RESERVATION_TTL_MS + 1);
        expect(await loadReservations()).toEqual({});
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(500);
        vi.useRealTimers();
    });

    test('a stored claim with no stamp cannot be restamped, so it expires at once', async () => {
        mockStorage.storeFor('settings').set(KEY, {
            'craftingPlan:/items/cheese': { label: 'old', lines: [{ itemHrid: LOGS, count: 300 }] },
        });
        expect(await loadReservations()).toEqual({});
    });
});

describe('two devices’ ledgers as one', () => {
    test('per owner, the claim made later wins', () => {
        const local = { 'goal:a': { label: 'A', updatedAt: 200, lines: [{ itemHrid: LOGS, count: 300 }] } };
        const incoming = { 'goal:a': { label: 'A', updatedAt: 100, lines: [{ itemHrid: LOGS, count: 50 }] } };
        expect(mergeReservations(local, incoming)['goal:a'].lines[0].count).toBe(300);
        expect(mergeReservations(incoming, local)['goal:a'].lines[0].count).toBe(300);
    });

    test('claims are never summed — one plan recomputed on two devices is one claim', () => {
        const local = { 'goal:a': { updatedAt: 1, lines: [{ itemHrid: LOGS, count: 300 }] } };
        const incoming = { 'goal:a': { updatedAt: 2, lines: [{ itemHrid: LOGS, count: 300 }] } };
        expect(mergeReservations(local, incoming)['goal:a'].lines[0].count).toBe(300);
    });

    test('an owner only one device has is kept', () => {
        const merged = mergeReservations(
            { 'goal:a': { updatedAt: 1, lines: [] } },
            { 'goal:b': { updatedAt: 1, lines: [] } }
        );
        expect(Object.keys(merged).sort()).toEqual(['goal:a', 'goal:b']);
    });

    test('a stamped copy beats an unstamped one either way round', () => {
        const stamped = { 'goal:a': { updatedAt: 5, lines: [{ itemHrid: LOGS, count: 1 }] } };
        const unstamped = { 'goal:a': { lines: [{ itemHrid: LOGS, count: 99 }] } };
        expect(mergeReservations(stamped, unstamped)['goal:a'].lines[0].count).toBe(1);
        expect(mergeReservations(unstamped, stamped)['goal:a'].lines[0].count).toBe(1);
    });

    test('a non-object on either side is ignored rather than thrown over', () => {
        expect(mergeReservations(null, undefined)).toEqual({});
        expect(mergeReservations({ 'goal:a': null }, { 'goal:b': 7 })).toEqual({});
    });
});

describe('a character switch moves the whole ledger', () => {
    const IRONCOW = `${RESERVATIONS_KEY}_ironcow456`;

    /**
     * @param {string} owner - Owner id
     * @param {number} count - Units of logs claimed
     * @returns {Object} A stored reservation, stamped now so the TTL keeps it
     */
    function storedClaim(owner, count) {
        return { [owner]: { label: owner, updatedAt: Date.now(), lines: [{ itemHrid: LOGS, count }] } };
    }

    test('the arriving character’s claims are read back on the switch, not on the next write', async () => {
        mockStorage.storeFor('settings').set(IRONCOW, storedClaim('goal:theirs', 300));
        await ensureReservationsLoaded();

        mockDataManager.currentCharacterId = 'ironcow456';
        await mockDataManager.handlers.get('character_switched')();
        await flushReservationWrites();

        // A render path cannot await a load; it must already be there
        expect(reservedElsewhere(LOGS, 0, { excludeOwner: 'goal:mine' })).toBe(300);
        expect(effectiveInventory(LOGS, 0, { excludeOwner: 'goal:mine' })).toBe(200);
    });

    test('a load in flight when the character switches is not taken for the arriving character’s', async () => {
        mockStorage.storeFor('settings').set(KEY, storedClaim('goal:departing', 300));
        mockStorage.storeFor('settings').set(IRONCOW, storedClaim('goal:theirs', 100));

        // Hold the departing character's read open so the switch lands mid-load
        let openTheGate;
        const gate = new Promise((resolve) => {
            openTheGate = resolve;
        });
        const readStore = mockStorage.tryGet.getMockImplementation();
        mockStorage.tryGet.mockImplementationOnce(async (...args) => {
            await gate;
            return readStore(...args);
        });

        const inFlight = ensureReservationsLoaded();
        mockDataManager.currentCharacterId = 'ironcow456';
        const claimed = reserve('goal:new', [{ itemHrid: LOGS, count: 10 }]);
        openTheGate();
        await Promise.all([inFlight, claimed]);
        await flushReservationWrites();

        // The arriving character's own claim is still there: the departing
        // character's dead load must not have passed for an empty ledger
        expect(Object.keys(mockStorage.storeFor('settings').get(IRONCOW)).sort()).toEqual(['goal:new', 'goal:theirs']);
        expect(mockStorage.storeFor('settings').get(KEY)['goal:departing']).toBeTruthy();
    });
});

describe('a ledger that could not be read is not a ledger that is empty', () => {
    test('a claim made while the read fails does not overwrite what is stored', async () => {
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }], { label: 'Goal: A' });
        await flushReservationWrites();
        _resetReservations();

        // The read fails and the write would not — a transient failure rather
        // than a dead store, which is the case a blind overwrite destroys
        mockStorage.tryGet.mockImplementationOnce(async () => null);
        expect(await reserve('goal:b', [{ itemHrid: LOGS, count: 10 }])).toBe(false);
        await flushReservationWrites();

        expect(Object.keys(mockStorage.storeFor('settings').get(KEY))).toEqual(['goal:a']);
    });

    test('a non-finite count is not a claim on every copy in the bag', async () => {
        await reserve('goal:a', [
            { itemHrid: LOGS, count: Infinity },
            { itemHrid: LOGS, count: 25 },
        ]);
        expect(allReservations()['goal:a'].lines).toEqual([{ itemHrid: LOGS, enhancementLevel: 0, count: 25 }]);
    });
});

/*
 * A released claim used to come back. The ledger is synced, `release()` left no
 * trace of the removal, and the fold has no way to tell an owner this device
 * DELETED from one it has simply never seen — so a peer that had not released
 * yet pushed the claim straight back in, and every other plan's shortfall was
 * then computed against stock reserved for a plan that does not exist.
 */
describe('a release outlives a peer that has not seen it', () => {
    /** @returns {number} A stamp far enough from zero for the TTL to be meaningful */
    const T0 = Date.UTC(2026, 5, 1);

    /**
     * @param {string} owner - Owner id
     * @param {number} updatedAt - Claim stamp
     * @param {number} [count] - Units of logs claimed
     * @returns {Object} A one-owner ledger, as a peer would hold it
     */
    function peerLedger(owner, updatedAt, count = 300) {
        return { [owner]: { label: owner, updatedAt, lines: [{ itemHrid: LOGS, count }] } };
    }

    test('a peer still holding a released claim does not bring it back', async () => {
        vi.setSystemTime(T0);
        await reserve('craftingPlan:/items/cheese', [{ itemHrid: LOGS, count: 300 }]);
        // What a peer that synced before the release is still carrying
        const peer = structuredClone(allReservations());

        vi.setSystemTime(T0 + 1000);
        await release('craftingPlan:/items/cheese');
        await flushReservationWrites();

        const folded = mergeReservations(mockStorage.storeFor('settings').get(KEY), peer);
        expect(folded['craftingPlan:/items/cheese']).toBeUndefined();
        vi.useRealTimers();
    });

    test('releaseMissing gets the same protection as release', async () => {
        vi.setSystemTime(T0);
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await reserve('goal:b', [{ itemHrid: LOGS, count: 100 }]);
        const peer = structuredClone(allReservations());

        vi.setSystemTime(T0 + 1000);
        expect(await releaseMissing('goal:', ['goal:b'])).toBe(1);
        await flushReservationWrites();

        const folded = mergeReservations(mockStorage.storeFor('settings').get(KEY), peer);
        expect(folded['goal:a']).toBeUndefined();
        expect(folded['goal:b']).toBeTruthy();
        vi.useRealTimers();
    });

    test('a claim a peer made for the first time still arrives', () => {
        const local = { [RELEASED_KEY]: { 'goal:a': T0 } };
        const folded = mergeReservations(local, peerLedger('goal:b', T0 - 5000));
        expect(folded['goal:b'].lines[0].count).toBe(300);
    });

    test('a claim re-made after the release is a new claim and survives', () => {
        const local = { [RELEASED_KEY]: { 'goal:a': T0 } };
        const folded = mergeReservations(local, peerLedger('goal:a', T0 + 1));
        expect(folded['goal:a'].lines[0].count).toBe(300);
        // …and one stamped at the release itself is the copy being released
        expect(mergeReservations(local, peerLedger('goal:a', T0))['goal:a']).toBeUndefined();
    });

    test('the fold reads the same whichever side the tombstone is on', () => {
        const tombstoned = { [RELEASED_KEY]: { 'goal:a': T0 } };
        const stale = peerLedger('goal:a', T0 - 1000);
        expect(mergeReservations(tombstoned, stale)['goal:a']).toBeUndefined();
        expect(mergeReservations(stale, tombstoned)['goal:a']).toBeUndefined();
        // The tombstone itself survives both ways round, or the next fold revives
        expect(mergeReservations(tombstoned, stale)[RELEASED_KEY]).toEqual({ 'goal:a': T0 });
        expect(mergeReservations(stale, tombstoned)[RELEASED_KEY]).toEqual({ 'goal:a': T0 });
    });

    test('two devices that both released one owner keep the later release', () => {
        const a = { [RELEASED_KEY]: { 'goal:a': T0 } };
        const b = { [RELEASED_KEY]: { 'goal:a': T0 + 5000 } };
        expect(mergeReservations(a, b)[RELEASED_KEY]['goal:a']).toBe(T0 + 5000);
        expect(mergeReservations(b, a)[RELEASED_KEY]['goal:a']).toBe(T0 + 5000);
    });

    test('a tombstone past the TTL is pruned and one inside it survives', async () => {
        vi.setSystemTime(T0);
        await reserve('goal:old', [{ itemHrid: LOGS, count: 300 }]);
        await release('goal:old');
        await flushReservationWrites();
        expect(mockStorage.storeFor('settings').get(KEY)[RELEASED_KEY]).toEqual({ 'goal:old': T0 });

        // Inside the TTL: still suppressing
        _resetReservations();
        vi.setSystemTime(T0 + RESERVATION_TTL_MS - 1000);
        await loadReservations();
        expect(mockStorage.storeFor('settings').get(KEY)[RELEASED_KEY]).toEqual({ 'goal:old': T0 });

        // Past it: no claim it could suppress can still be alive, so it goes
        _resetReservations();
        vi.setSystemTime(T0 + RESERVATION_TTL_MS + 1);
        await loadReservations();
        await flushReservationWrites();
        expect(mockStorage.storeFor('settings').get(KEY)).toEqual({});
        vi.useRealTimers();
    });

    test('reserving the owner again drops its tombstone', async () => {
        vi.setSystemTime(T0);
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await release('goal:a');
        vi.setSystemTime(T0 + 1000);
        await reserve('goal:a', [{ itemHrid: LOGS, count: 120 }]);
        await flushReservationWrites();

        const stored = mockStorage.storeFor('settings').get(KEY);
        expect(stored[RELEASED_KEY]).toBeUndefined();
        expect(reservedElsewhere(LOGS, 0, { excludeOwner: 'goal:b' })).toBe(120);
        vi.useRealTimers();
    });

    test('the tombstones are not an owner anyone can see or claim under', async () => {
        vi.setSystemTime(T0);
        await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }]);
        await release('goal:a');
        await flushReservationWrites();

        expect(allReservations()).toEqual({});
        expect(await loadReservations()).toEqual({});
        expect(reservationDetail(LOGS)).toEqual({ total: 0, byOwner: [] });
        expect(await reserve(RELEASED_KEY, [{ itemHrid: LOGS, count: 10 }])).toBe(false);
        vi.useRealTimers();
    });
});
