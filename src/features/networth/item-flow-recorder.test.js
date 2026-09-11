/**
 * The item flow recorder diffs absolute item counts against its own mirror of
 * the inventory, so what is pinned here is the diff — which messages move the
 * mirror, which movements are credited to gathering, and that a Welcome Back
 * login is a new baseline rather than a gain.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    itemKey,
    seedInventory,
    applyInventoryChanges,
    foldGathering,
    foldConsumed,
    CONFIRM_MS,
    default as recorder,
} from './item-flow-recorder.js';

const hoisted = vi.hoisted(() => ({
    saved: [],
    listeners: new Map(),
    game: {
        charId: 'me',
        items: [],
        actionTypes: {},
        details: {},
        actions: [],
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/storage.js', () => ({
    default: { isQuotaExceeded: () => false },
}));

vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: () => '2026-08-20',
    createChunkedHistory: () => ({
        load: async () => [],
        save: (_charId, rows) => hoisted.saved.push(JSON.parse(JSON.stringify(rows))),
        forget: () => {},
    }),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => hoisted.listeners.set(event, handler),
        off: (event) => hoisted.listeners.delete(event),
        getCurrentCharacterId: () => hoisted.game.charId,
        getActionDetails: (hrid) =>
            hoisted.game.details[hrid] ??
            (hoisted.game.actionTypes[hrid] ? { type: hoisted.game.actionTypes[hrid] } : null),
        getCurrentActions: () => hoisted.game.actions,
        get characterItems() {
            return hoisted.game.items;
        },
    },
}));

const INV = '/item_locations/inventory';
/** One inventory row, absolute count, as the server sends it */
const row = (itemHrid, count, enhancementLevel = 0, itemLocationHrid = INV) => ({
    itemHrid,
    count,
    enhancementLevel,
    itemLocationHrid,
});

/** Let the recorder's awaited load settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the inventory mirror', () => {
    test('seeds from inventory rows only, keyed like the loot log', () => {
        const mirror = seedInventory([
            row('/items/sugar', 10),
            row('/items/sword', 1, 5),
            row('/items/sword', 1, 0, '/item_locations/main_hand'),
        ]);
        expect([...mirror]).toEqual([
            ['/items/sugar', 10],
            ['/items/sword::5', 1],
        ]);
        expect(itemKey('/items/sword', 5)).toBe('/items/sword::5');
    });

    test('an absolute count is diffed against the last one seen, and becomes the next baseline', () => {
        const mirror = seedInventory([row('/items/sugar', 672425)]);
        expect(applyInventoryChanges(mirror, [row('/items/sugar', 672438)])).toEqual([
            { key: '/items/sugar', itemHrid: '/items/sugar', enhancementLevel: 0, delta: 13 },
        ]);
        expect(applyInventoryChanges(mirror, [row('/items/sugar', 672440)])[0].delta).toBe(2);
    });

    test('a row the seeded inventory did not hold started at zero', () => {
        const mirror = seedInventory([]);
        expect(applyInventoryChanges(mirror, [row('/items/egg', 3)])[0].delta).toBe(3);
    });

    test('an unseeded mirror reports nothing, rather than a whole stack as gained', () => {
        expect(applyInventoryChanges(null, [row('/items/sugar', 672425)])).toEqual([]);
    });

    test('equipment rows are not the inventory and move nothing', () => {
        const mirror = seedInventory([]);
        expect(applyInventoryChanges(mirror, [row('/items/sword', 1, 0, '/item_locations/main_hand')])).toEqual([]);
    });
});

describe('foldGathering', () => {
    const MINUTE = 60_000;

    test('completions close together add into one stretch', () => {
        const day = { d: '2026-08-20' };
        foldGathering(day, '7', '/actions/foraging/farmland', 1000, { '/items/sugar': 13 });
        foldGathering(day, '7', '/actions/foraging/farmland', 9000, { '/items/sugar': 2 });
        expect(day.gathering['7']).toEqual({
            a: '/actions/foraging/farmland',
            stretches: [{ from: 1000, to: 9000, gained: { '/items/sugar': 15 } }],
        });
    });

    test('a silence opens a new stretch, so the unwatched time between is known', () => {
        const day = { d: '2026-08-20' };
        foldGathering(day, '7', '/actions/foraging/farmland', 0, { '/items/sugar': 1 });
        foldGathering(day, '7', '/actions/foraging/farmland', 60 * MINUTE, { '/items/sugar': 1 });
        expect(day.gathering['7'].stretches.map(({ from, to }) => [from, to])).toEqual([
            [0, 0],
            [60 * MINUTE, 60 * MINUTE],
        ]);
    });
});

describe('recording from the game’s messages', () => {
    beforeEach(async () => {
        hoisted.saved = [];
        hoisted.listeners.clear();
        hoisted.game.charId = 'me';
        hoisted.game.items = [row('/items/sugar', 100), row('/items/coin', 5000)];
        hoisted.game.actionTypes = {
            '/actions/foraging/farmland': '/action_types/foraging',
            '/actions/cooking/cake': '/action_types/cooking',
        };
        recorder.cleanup();
        recorder._rows = [];
        recorder._charId = null;
        recorder._loading = null;
        await recorder.initialize();
    });

    afterEach(() => recorder.cleanup());

    const items = (data) => hoisted.listeners.get('items_updated')(data);
    const gathered = () => recorder._rows.flatMap((day) => Object.values(day.gathering || {}));

    test('a gathering completion credits what it gained', async () => {
        items({
            endCharacterAction: { id: 7, characterID: 'me', actionHrid: '/actions/foraging/farmland' },
            endCharacterItems: [row('/items/sugar', 113), row('/items/egg', 2)],
        });
        await settle();
        expect(gathered()[0].stretches[0].gained).toEqual({ '/items/sugar': 13, '/items/egg': 2 });
    });

    test('a marketplace claim or a chest is not gathering, even mid-foraging', async () => {
        // A plain items_updated names no action at all
        items({ endCharacterItems: [row('/items/sugar', 200), row('/items/coin', 9000)] });
        await settle();
        expect(gathered()).toEqual([]);
    });

    test('a production completion is the production recorder’s, not gathering', async () => {
        items({
            endCharacterAction: { id: 8, characterID: 'me', actionHrid: '/actions/cooking/cake' },
            endCharacterItems: [row('/items/cake', 1), row('/items/sugar', 90)],
        });
        await settle();
        expect(gathered()).toEqual([]);
    });

    test('what the claim added is the baseline for the next completion, not a gain of it', async () => {
        items({ endCharacterItems: [row('/items/sugar', 200)] });
        items({
            endCharacterAction: { id: 7, characterID: 'me', actionHrid: '/actions/foraging/farmland' },
            endCharacterItems: [row('/items/sugar', 204)],
        });
        await settle();
        expect(gathered()[0].stretches[0].gained).toEqual({ '/items/sugar': 4 });
    });

    test('a Welcome Back login is a new baseline, so offline gains stay with the offline row', async () => {
        hoisted.listeners.get('character_initialized')({ characterItems: [row('/items/sugar', 7800)] });
        items({
            endCharacterAction: { id: 7, characterID: 'me', actionHrid: '/actions/foraging/farmland' },
            endCharacterItems: [row('/items/sugar', 7810)],
        });
        await settle();
        expect(gathered()[0].stretches[0].gained).toEqual({ '/items/sugar': 10 });
    });

    test('another character’s completion is not recorded', async () => {
        items({
            endCharacterAction: { id: 7, characterID: 'someone', actionHrid: '/actions/foraging/farmland' },
            endCharacterItems: [row('/items/sugar', 113)],
        });
        await settle();
        expect(gathered()).toEqual([]);
    });

    test('after a switch nothing is credited until the arriving character is seeded', async () => {
        hoisted.listeners.get('character_switching')();
        items({
            endCharacterAction: { id: 7, characterID: 'me', actionHrid: '/actions/foraging/farmland' },
            endCharacterItems: [row('/items/sugar', 113)],
        });
        await settle();
        expect(gathered()).toEqual([]);
    });
});

describe('dungeon keys', () => {
    const DUNGEON = '/actions/combat/pirate_cove';
    const KEY = '/items/pirate_entry_key';
    const OTHER_KEY = '/items/chimerical_entry_key';

    beforeEach(async () => {
        vi.useFakeTimers();
        hoisted.saved = [];
        hoisted.listeners.clear();
        hoisted.game.charId = 'me';
        hoisted.game.items = [row(KEY, 10), row(OTHER_KEY, 10)];
        hoisted.game.details = { [DUNGEON]: { type: '/action_types/combat', combatZoneInfo: { isDungeon: true } } };
        hoisted.game.actions = [];
        recorder.cleanup();
        recorder._rows = [];
        recorder._charId = null;
        recorder._loading = null;
        await recorder.initialize();
    });

    afterEach(() => {
        recorder.cleanup();
        vi.useRealTimers();
    });

    const items = (data) => hoisted.listeners.get('items_updated')(data);
    const listed = (itemHrid) =>
        hoisted.listeners.get('market_listings_updated')({ endMarketListings: [{ itemHrid }] });
    const keyCount = (itemHrid, count) => items({ endCharacterItems: [row(itemHrid, count)] });
    const running = (actionHrid) => {
        hoisted.game.actions = [{ id: 1, actionHrid, isDone: false, ordinal: 1 }];
    };
    const spent = (itemHrid = KEY) => recorder._rows.reduce((sum, day) => sum + (day.keys?.[itemHrid] || 0), 0);
    const wait = async () => {
        await vi.advanceTimersByTimeAsync(CONFIRM_MS);
        await vi.advanceTimersByTimeAsync(0);
    };

    test('a key taken while its dungeon runs is spent', async () => {
        running(DUNGEON);
        keyCount(KEY, 9);
        await wait();
        expect(spent()).toBe(1);
    });

    test('the key a run takes as it starts counts, though the dungeon became the running action after', async () => {
        keyCount(KEY, 9);
        running(DUNGEON);
        await wait();
        expect(spent()).toBe(1);
    });

    test('a key listed on the market is not spent, whichever message arrives first', async () => {
        running(DUNGEON);
        keyCount(KEY, 9);
        listed(KEY);
        await wait();
        listed(KEY);
        keyCount(KEY, 8);
        await wait();
        expect(spent()).toBe(0);
    });

    test('a key that falls with no dungeon running is not spent', async () => {
        keyCount(KEY, 9);
        await wait();
        expect(spent()).toBe(0);
    });

    test('two keys gone at once is not one run', async () => {
        running(DUNGEON);
        keyCount(KEY, 8);
        await wait();
        expect(spent()).toBe(0);
    });

    test('another dungeon’s key is not the running dungeon’s spend', async () => {
        running(DUNGEON);
        keyCount(OTHER_KEY, 9);
        await wait();
        expect(spent(OTHER_KEY)).toBe(0);
    });

    test('a switch before the wait is over books nothing under the arriving character', async () => {
        running(DUNGEON);
        keyCount(KEY, 9);
        hoisted.listeners.get('character_switching')();
        await wait();
        expect(spent()).toBe(0);
        expect(hoisted.saved).toEqual([]);
    });

    test('foldConsumed adds to the day’s tally', () => {
        const day = foldConsumed(foldConsumed({ d: '2026-08-20' }, 'keys', KEY, 1), 'keys', KEY, 1);
        expect(day.keys).toEqual({ [KEY]: 2 });
    });
});
