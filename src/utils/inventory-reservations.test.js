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
    getCurrentCharacterId: vi.fn(() => mockDataManager.currentCharacterId),
    getInventory: vi.fn(() => mockDataManager.inventory),
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
    shortfallNote,
    mergeReservations,
    flushReservationWrites,
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

    test('reserve and release write nothing at all', async () => {
        mockStorage.set.mockClear();
        expect(await reserve('goal:a', [{ itemHrid: LOGS, count: 300 }])).toBe(false);
        expect(await release('goal:a')).toBe(false);
        expect(await releaseMissing('goal:', [])).toBe(0);
        expect(mockStorage.set).not.toHaveBeenCalled();
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
