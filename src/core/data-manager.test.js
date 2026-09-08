/**
 * Tests for DataManager event forwarding
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

let webSocketHandlers = new Map();

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();

    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn((event, handler) => {
                if (webSocketHandlers.get(event) === handler) {
                    webSocketHandlers.delete(event);
                }
            }),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
        },
    };
});

const storageMock = vi.hoisted(() => ({
    data: new Map(),
    getJSON: null,
    setJSON: null,
    get: null,
    set: null,
    flushAll: null,
}));

/** Namespaced key so the plain and JSON stores in the mock cannot collide */
const storeKey = (storeName, key) => `${storeName}::${key}`;

vi.mock('./storage.js', () => ({
    default: {
        getJSON: (key, storeName, fallback) => storageMock.getJSON(key, storeName, fallback),
        setJSON: (key, value, storeName) => storageMock.setJSON(key, value, storeName),
        get: (key, storeName, fallback) => storageMock.get(key, storeName, fallback),
        set: (key, value, storeName) => storageMock.set(key, value, storeName),
        flushAll: () => storageMock.flushAll(),
    },
}));

beforeEach(() => {
    storageMock.data = new Map();
    storageMock.getJSON = vi.fn(async (key, _storeName, fallback) =>
        storageMock.data.has(key) ? storageMock.data.get(key) : fallback
    );
    storageMock.setJSON = vi.fn(async (key, value) => {
        storageMock.data.set(key, value);
        return true;
    });
    storageMock.get = vi.fn(async (key, storeName = 'settings', fallback = null) => {
        const k = storeKey(storeName, key);
        return storageMock.data.has(k) ? storageMock.data.get(k) : fallback;
    });
    storageMock.set = vi.fn(async (key, value, storeName = 'settings') => {
        storageMock.data.set(storeKey(storeName, key), value);
        return true;
    });
    storageMock.flushAll = vi.fn(async () => {});
});

// The DataManager under test is a singleton shared by every test in this file, so
// whatever one test leaves on it is what the next one starts from. The one that
// bites is `activeSocket`: the stale-socket tests bind a socket to it, and every
// character-scoped handler afterwards rejects messages that arrive with no socket
// context — which is how the rest of the file drives them — so the handler silently
// does nothing and the assertion reads the untouched state. Fake timers are the
// same story from the other direction.
beforeEach(async () => {
    vi.useRealTimers();
    const { default: dataManager } = await import('./data-manager.js');
    resetCharacter(dataManager);
});

/** A minimal init_character_data payload. */
const initPayload = (overrides = {}) => ({
    character: { id: 'char-1', name: 'Tester' },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    ...overrides,
});

/**
 * Put the singleton back to a first-login state so a test is not reading
 * whatever the previous one left behind.
 * @param {Object} dataManager - The singleton
 */
function resetCharacter(dataManager) {
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.characterGuildBuffMap = {};
    dataManager.guildBuildingLevelMap = {};
    dataManager.guildShrineCapturedAt = null;
    dataManager.guildShrineHydrated = false;
    dataManager.guildShrineHydration = null;
    dataManager.guildShrineGuildId = null;
    dataManager.activeSocket = null;
}

describe('DataManager', () => {
    test('forwards market item order book updates', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const listener = vi.fn();
        const payload = {
            marketItemOrderBooks: {
                itemHrid: '/items/gourmet_tea',
            },
        };

        dataManager.on('market_item_order_books_updated', listener);

        const handler = webSocketHandlers.get('market_item_order_books_updated');
        expect(typeof handler).toBe('function');

        handler(payload);

        // Wait for deferred emit (setTimeout in emit())
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledWith(payload);
    });

    test('forwards market item value updates unguarded by socket ownership', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const listener = vi.fn();
        const payload = { marketValuesVersion: 12, marketItemValues: { '/items/log': { 0: 200 } } };

        dataManager.on('market_item_values_updated', listener);

        const handler = webSocketHandlers.get('market_item_values_updated');
        expect(typeof handler).toBe('function');

        handler(payload);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledWith(payload);
        dataManager.off('market_item_values_updated', listener);
    });

    test('community_buffs_updated refreshes the levels getCommunityBuffLevel reads', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterData = {
            communityBuffs: [{ hrid: '/community_buff_types/experience', level: 3 }],
        };

        const handler = webSocketHandlers.get('community_buffs_updated');
        expect(typeof handler).toBe('function');

        handler({ communityBuffs: [{ hrid: '/community_buff_types/experience', level: 4 }] });

        expect(dataManager.getCommunityBuffLevel('/community_buff_types/experience')).toBe(4);
    });

    test('merges market listings updates and emits updated list', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const listener = vi.fn();
        const payload = {
            endMarketListings: [
                { id: 2, price: 250, isSell: true },
                { id: 3, price: 300, isSell: false },
            ],
        };

        dataManager.characterData = {
            myMarketListings: [
                { id: 1, price: 100, isSell: true },
                { id: 2, price: 200, isSell: true },
            ],
        };

        dataManager.on('market_listings_updated', listener);

        const handler = webSocketHandlers.get('market_listings_updated');
        expect(typeof handler).toBe('function');

        handler(payload);

        // Wait for deferred emit (setTimeout in emit())
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dataManager.getMarketListings()).toEqual([
            { id: 1, price: 100, isSell: true },
            { id: 2, price: 250, isSell: true },
            { id: 3, price: 300, isSell: false },
        ]);
        expect(listener).toHaveBeenCalledWith({
            ...payload,
            myMarketListings: [
                { id: 1, price: 100, isSell: true },
                { id: 2, price: 250, isSell: true },
                { id: 3, price: 300, isSell: false },
            ],
        });
    });
});

/**
 * The desync the labyrinth produces.
 *
 * The lab equips a loadout per room and restores on exit. Equipment tracked
 * those swaps because `items_updated` was handled; abilities did not, because
 * nothing applied `abilities_updated` at all — so the equipped kit stayed frozen
 * at whatever login reported and the combat sim simulated a kit the character
 * had not been wearing for hours.
 *
 * These replay the message sequence rather than testing the reconciler, which
 * has its own tests: what is being checked here is that the handlers are wired
 * and that the view the sim reads is the view the messages update.
 */
describe('equipped abilities through a labyrinth run', () => {
    /**
     * Log in with a kit.
     * @param {Object} dataManager - The singleton
     * @param {Array<Object>} combatAbilities - Equipped abilities at login
     */
    async function login(dataManager, combatAbilities) {
        resetCharacter(dataManager);
        // The handler queues its body behind a promise chain, so two inits cannot
        // interleave mid-teardown; awaiting it is what makes the state visible here
        return webSocketHandlers.get('init_character_data')(
            initPayload({
                characterAbilities: combatAbilities.map((a) => ({ ...a, experience: 0 })),
                combatUnit: { combatAbilities },
            })
        );
    }

    const NORMAL = [
        { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
        { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 10 },
        { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 10 },
    ];

    test('a lab loadout replaces the kit and leaving restores it', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/cleave',
            '/abilities/toughness',
        ]);

        // Entering the labyrinth: the room loadout swaps two of the three slots.
        // The server reports the ability that left with slotNumber 0.
        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [
                { abilityHrid: '/abilities/cleave', slotNumber: 0 },
                { abilityHrid: '/abilities/toughness', slotNumber: 0 },
                { abilityHrid: '/abilities/fireball', slotNumber: 2, level: 8 },
                { abilityHrid: '/abilities/frost_surge', slotNumber: 3, level: 8 },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/fireball',
            '/abilities/frost_surge',
        ]);

        // Leaving the labyrinth: the normal loadout comes back
        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [
                { abilityHrid: '/abilities/fireball', slotNumber: 0 },
                { abilityHrid: '/abilities/frost_surge', slotNumber: 0 },
                { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 10 },
                { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 10 },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/cleave',
            '/abilities/toughness',
        ]);
        // And the lab abilities are gone, not merely reordered behind them
        expect(dataManager.getEquippedAbilities()).toHaveLength(3);
    });

    test('the raw characterData field the sim reads is the one that moved', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [{ abilityHrid: '/abilities/cleave', slotNumber: 0 }],
        });

        expect(dataManager.characterData.combatUnit.combatAbilities.map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/toughness',
        ]);
    });

    test('a battle settles the kit even when no update message was understood', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('new_battle')({
            players: [
                {
                    character: { id: 'char-1', name: 'Tester' },
                    combatDetails: {
                        combatAbilities: [
                            { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
                            { abilityHrid: '/abilities/smack', slotNumber: 2, level: 3 },
                        ],
                    },
                },
                {
                    character: { id: 'char-9', name: 'Somebody Else' },
                    combatDetails: { combatAbilities: [{ abilityHrid: '/abilities/impale', slotNumber: 1 }] },
                },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/smack',
        ]);
    });

    test('experience ticks raise a level without disturbing the kit', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('action_completed')({
            endCharacterAction: { id: 1, isDone: true },
            endCharacterAbilities: [{ abilityHrid: '/abilities/cleave', level: 11, experience: 5000 }],
        });

        expect(dataManager.getEquippedAbilities()).toHaveLength(3);
        expect(dataManager.getEquippedAbilities().find((a) => a.abilityHrid === '/abilities/cleave').level).toBe(11);
        expect(dataManager.getLearnedAbilities().find((a) => a.abilityHrid === '/abilities/cleave').experience).toBe(
            5000
        );
    });
});

/**
 * Guild shrine levels reaching the client at all.
 *
 * They ride on guild traffic that a session may never see, which is why the
 * upgrade advisor keeps having to say it does not know whether a shrine can
 * support a level. Capture is by shape and persistence is per character, so the
 * next login starts with the last reading rather than with nothing.
 */
describe('guild shrine levels', () => {
    test('are captured off whatever message carries them, and persisted', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(0);

        webSocketHandlers.get('*')({
            type: 'guild_updated',
            guild: { id: 'g1' },
            characterGuildBuffMap: {
                '/guild_buffs/force_combat': { guildBuffHrid: '/guild_buffs/force_combat', level: 4 },
            },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
        });

        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(4);
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getGuildShrineCapturedAt()).toBeGreaterThan(0);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);

        await dataManager.persistGuildShrineLevels();
        expect(storageMock.setJSON).toHaveBeenCalled();
    });

    test('a message carrying one map does not erase the other', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());

        webSocketHandlers.get('*')({ guildBuildingLevelMap: { '/guild_shrines/force': 6 } });
        webSocketHandlers.get('*')({ characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 2 } } });

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(2);
    });

    test('a login with no guild data hydrates the last reading, marked as old', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 4 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
            guildId: 'g1',
            capturedAt: 1_700_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());
        await dataManager.whenGuildShrineLevelsReady();

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(4);
        expect(dataManager.isGuildShrineHydrated()).toBe(true);
        expect(dataManager.getGuildShrineCapturedAt()).toBe(1_700_000_000_000);
    });

    test('a live message wins over the hydrated reading', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: {},
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
            capturedAt: 1_700_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());
        await dataManager.whenGuildShrineLevelsReady();
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);

        webSocketHandlers.get('*')({ guildBuildingLevelMap: { '/guild_shrines/force': 8 } });

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(8);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);
    });

    test('login data that does carry the levels is not overwritten by an older reading', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 1 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 1 },
            capturedAt: 1_600_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(
            initPayload({
                characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 9 } },
                guildBuildingLevelMap: { '/guild_shrines/force': 10 },
            })
        );
        await dataManager.whenGuildShrineLevelsReady();

        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(9);
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(10);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);
    });

    test('a hydration read that lands after a later switch does not stamp one character/guild onto another', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);

        // Character A's own persisted reading: no guild buffs personally bought
        // (an ordinary case — most players never buy any), but the guild itself
        // has built its shrine, which is what makes `guildBuildingLevelMap` carry
        // no per-row owner to check.
        storageMock.data.set('guildShrineLevels_char-A', {
            characterGuildBuffMap: {},
            guildBuildingLevelMap: { '/guild_shrines/force': 9 },
            capturedAt: 1_700_000_000_000,
        });

        // Gate the read for A's key so it stays in flight until released below,
        // simulating a slow IndexedDB read that overlaps a second switch.
        let releaseA;
        const gate = new Promise((resolve) => {
            releaseA = resolve;
        });
        const realGetJSON = storageMock.getJSON;
        storageMock.getJSON = vi.fn(async (key, storeName, fallback) => {
            if (key === 'guildShrineLevels_char-A') {
                await gate;
            }
            return realGetJSON(key, storeName, fallback);
        });

        // Character A logs in; its hydration read starts but is gated.
        await webSocketHandlers.get('init_character_data')(initPayload({ character: { id: 'char-A', name: 'Alpha' } }));
        const aHydration = dataManager.guildShrineHydration;

        // Before A's read resolves, the user switches to a different character
        // (in a different guild, or none) with no shrine reading of its own.
        await webSocketHandlers.get('init_character_data')(initPayload({ character: { id: 'char-B', name: 'Beta' } }));

        expect(dataManager.getCurrentCharacterId()).toBe('char-B');
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(0);

        // Now let A's stale read land.
        releaseA();
        await aHydration;

        // A's guild's shrine levels must not have leaked onto B.
        expect(dataManager.getCurrentCharacterId()).toBe('char-B');
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(0);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);

        // The singleton's clock otherwise carries into later tests (see the
        // identical reset in 'overlapping character switches' below) and would
        // make their own A→B switch look rapid too.
        dataManager.lastCharacterSwitchTime = 0;
    });
});

describe('event listener snapshots (upstream 03204a5)', () => {
    test('character switching calls every listener when listeners remove themselves', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const calls = [];

        const first = () => {
            calls.push('first');
            dataManager.off('character_switching', first);
        };
        const second = () => {
            calls.push('second');
            dataManager.off('character_switching', second);
        };
        const third = () => {
            calls.push('third');
            dataManager.off('character_switching', third);
        };

        dataManager.on('character_switching', first);
        dataManager.on('character_switching', second);
        dataManager.on('character_switching', third);

        dataManager.emit('character_switching', {});

        expect(calls).toEqual(['first', 'second', 'third']);
    });

    test('a deferred event goes to listeners registered at emit time and still registered at delivery', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const stays = vi.fn();
        const leaves = vi.fn();
        const late = vi.fn();

        dataManager.on('snapshot_test', stays);
        dataManager.on('snapshot_test', leaves);
        dataManager.emit('snapshot_test', { id: 1 });

        // Unregistered in the gap between emit and the deferred delivery — the
        // shape a character switch produces, where a feature is torn down while
        // an event is already in flight. Calling it would hand a cleaned-up
        // feature an event it can no longer service.
        dataManager.off('snapshot_test', leaves);
        // Registered in the same gap: it did not exist when the event happened.
        dataManager.on('snapshot_test', late);

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(stays).toHaveBeenCalledWith({ id: 1 });
        expect(leaves).not.toHaveBeenCalled();
        expect(late).not.toHaveBeenCalled();

        dataManager.off('snapshot_test', stays);
        dataManager.off('snapshot_test', late);
    });

    test('a listener that unregisters others mid-delivery does not skip the rest', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const calls = [];
        const second = () => calls.push('second');
        const first = () => {
            calls.push('first');
            // Already-snapshotted and still registered when the loop reaches it
            dataManager.off('mid_delivery_test', first);
        };
        const third = () => calls.push('third');

        dataManager.on('mid_delivery_test', first);
        dataManager.on('mid_delivery_test', second);
        dataManager.on('mid_delivery_test', third);
        dataManager.emit('mid_delivery_test', {});

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual(['first', 'second', 'third']);
        dataManager.off('mid_delivery_test', second);
        dataManager.off('mid_delivery_test', third);
    });
});

describe('inventory index', () => {
    test('items_updated updates, removes and appends by id without rescanning', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [
            { id: 'a', count: 1, itemLocationHrid: '/item_locations/inventory' },
            { id: 'b', count: 2, itemLocationHrid: '/item_locations/inventory' },
            { id: 'c', count: 3, itemLocationHrid: '/item_locations/inventory' },
        ];
        dataManager._itemIndexById = null;

        const handler = webSocketHandlers.get('items_updated');
        handler({
            endCharacterItems: [
                { id: 'b', count: 20 },
                { id: 'a', count: 0 },
                { id: 'd', count: 7 },
            ],
        });

        expect(dataManager.characterItems.map((i) => i.id)).toEqual(['b', 'c', 'd']);
        expect(dataManager.characterItems.find((i) => i.id === 'b').count).toBe(20);
        expect(dataManager.characterItems.find((i) => i.id === 'd').count).toBe(7);
    });

    test('the index recovers when characterItems is replaced behind its back', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [{ id: 'x', count: 1 }];
        dataManager._itemIndexById = null;
        expect(dataManager._itemIndexOf('x')).toBe(0);

        // Something outside the update paths reorders the array
        dataManager.characterItems = [
            { id: 'y', count: 5 },
            { id: 'x', count: 1 },
        ];
        expect(dataManager._itemIndexOf('x')).toBe(1);
        expect(dataManager._itemIndexOf('y')).toBe(0);
        expect(dataManager._itemIndexOf('nope')).toBe(-1);
    });

    test('action_completed inventory updates go through the same index', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [{ id: 'a', count: 1, itemLocationHrid: '/item_locations/inventory' }];
        dataManager._itemIndexById = null;
        dataManager.characterActions = [];

        const handler = webSocketHandlers.get('action_completed');
        handler({
            endCharacterAction: { id: 99, isDone: true },
            endCharacterItems: [
                { id: 'a', count: 9, itemLocationHrid: '/item_locations/inventory' },
                { id: 'z', count: 4, itemLocationHrid: '/item_locations/inventory' },
                { id: 'ignored', count: 4, itemLocationHrid: '/item_locations/bank' },
            ],
        });

        expect(dataManager.characterItems.map((i) => [i.id, i.count])).toEqual([
            ['a', 9],
            ['z', 4],
        ]);
    });
});

describe('actions_updated', () => {
    test('replaces existing actions once and drops finished ones', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [
            { id: 1, isDone: false },
            { id: 2, isDone: false },
            { id: 3, isDone: false },
        ];

        const handler = webSocketHandlers.get('actions_updated');
        handler({
            endCharacterActions: [
                { id: 2, isDone: true },
                { id: 4, isDone: false },
                { id: 1, isDone: false, updated: true },
            ],
        });

        expect(dataManager.characterActions).toEqual([
            { id: 3, isDone: false },
            { id: 4, isDone: false },
            { id: 1, isDone: false, updated: true },
        ]);
    });

    test('a repeated id in one message keeps the last copy', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [];

        const handler = webSocketHandlers.get('actions_updated');
        handler({
            endCharacterActions: [
                { id: 7, isDone: false, take: 'first' },
                { id: 8, isDone: false },
                { id: 7, isDone: false, take: 'second' },
            ],
        });

        expect(dataManager.characterActions).toEqual([
            { id: 8, isDone: false },
            { id: 7, isDone: false, take: 'second' },
        ]);
    });
});

describe('action unit boundary (upstream 9210b4ab)', () => {
    /** An action queue entry, front-most by default */
    const queued = (overrides = {}) => ({
        id: 1,
        ordinal: 0,
        isDone: false,
        actionHrid: '/actions/combat/holy_hammer',
        currentCount: 5,
        ...overrides,
    });

    // Every test here drives the clock; leaving fake timers armed would leak into the rest
    // of the file, which does not expect them.
    afterEach(() => {
        vi.useRealTimers();
    });

    test('an action_completed continuation dates the new unit from that instant', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));

        // First sighting only establishes the pair — nothing is claimed as elapsed yet
        webSocketHandlers.get('action_completed')({ endCharacterAction: queued() });
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);

        // The continuation for the next unit is the boundary we can actually date
        vi.setSystemTime(new Date('2026-08-27T12:02:15Z'));
        webSocketHandlers.get('action_completed')({ endCharacterAction: queued({ currentCount: 6 }) });

        vi.setSystemTime(new Date('2026-08-27T12:03:15Z'));
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 6, 135)).toBe(60);
    });

    test('the boundary is not reset while the same unit is still running', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        // Same (id, currentCount) arriving again is the same in-progress unit; re-anchoring it
        // here is exactly the bug — the ETA would walk later on every message
        vi.setSystemTime(new Date('2026-08-27T12:00:40Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(40);
    });

    test('a new action taking the front slot starts its own unit', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        vi.setSystemTime(new Date('2026-08-27T12:05:00Z'));
        dataManager.characterActions = [];
        webSocketHandlers.get('actions_updated')({
            endCharacterActions: [queued({ id: 2, currentCount: 0 })],
        });

        vi.setSystemTime(new Date('2026-08-27T12:05:10Z'));
        expect(dataManager.getElapsedSecondsInCurrentUnit(2, 0, 135)).toBe(10);
        // The old action's boundary is gone, not merely shadowed
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);
    });

    test('fails closed for a different action id or a count that moved on', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.actionUnitBoundary = { actionId: 1, currentCount: 5, unitStartTime: Date.now() - 60_000 };

        expect(dataManager.getElapsedSecondsInCurrentUnit(2, 5, 135)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 6, 135)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBeCloseTo(60, 0);
    });

    test('fails closed with no boundary at all, and clamps to one unit', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        dataManager.actionUnitBoundary = null;
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);

        // A boundary older than the unit it describes still cannot claim more than one unit
        dataManager.actionUnitBoundary = { actionId: 1, currentCount: 5, unitStartTime: Date.now() - 10 * 60_000 };
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(135);

        // An unusable unit duration is never a licence to subtract anything
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, Infinity)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 0)).toBe(0);
    });

    test('a matching boundary survives a reload, a stale one does not', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.characterActions = [];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));

        await webSocketHandlers.get('init_character_data')(initPayload({ characterActions: [queued()] }));
        expect(storageMock.set).toHaveBeenCalledWith('char-1', expect.anything(), 'actionProgress');

        // Reload: same character, same action still on its fifth count
        vi.setSystemTime(new Date('2026-08-27T12:01:00Z'));
        resetCharacter(dataManager);
        dataManager.actionUnitBoundary = null;
        dataManager.characterActions = [];
        await webSocketHandlers.get('init_character_data')(initPayload({ characterActions: [queued()] }));

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(60);

        // A count that moved on while the page was closed is not something we can date
        vi.setSystemTime(new Date('2026-08-27T12:02:00Z'));
        resetCharacter(dataManager);
        dataManager.actionUnitBoundary = null;
        dataManager.characterActions = [];
        await webSocketHandlers.get('init_character_data')(
            initPayload({ characterActions: [queued({ currentCount: 9 })] })
        );

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 9, 135)).toBe(0);
    });
});

describe('guild shrine capture', () => {
    test('an unchanged map is not treated as a change', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);

        const levels = { '/guild_buildings/shrine': 4 };
        const first = dataManager.captureGuildShrineData({ guildBuildingLevelMap: { ...levels } });
        expect(first).toBe(true);

        const listener = vi.fn();
        dataManager.on('guild_shrine_levels_updated', listener);

        // Same values arriving again on a later message
        const second = dataManager.captureGuildShrineData({ guildBuildingLevelMap: { ...levels } });
        expect(second).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listener).not.toHaveBeenCalled();

        // A real change still gets through
        const third = dataManager.captureGuildShrineData({
            guildBuildingLevelMap: { '/guild_buildings/shrine': 5 },
        });
        expect(third).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listener).toHaveBeenCalledTimes(1);
        dataManager.off('guild_shrine_levels_updated', listener);
    });
});

describe('overlapping character switches', () => {
    test('the switching flag is up before the pre-switch flush suspends the handler', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await webSocketHandlers.get('init_character_data')(initPayload());

        let releaseFlush;
        storageMock.flushAll = vi.fn(
            () =>
                new Promise((resolve) => {
                    releaseFlush = resolve;
                })
        );

        const pending = webSocketHandlers.get('init_character_data')(
            initPayload({ character: { id: 'char-2', name: 'Two' } })
        );
        await Promise.resolve();

        // Anything arriving while the flush is in flight must see a switch under way,
        // because the arrays it would write into still belong to the departing character
        expect(dataManager.isCharacterSwitching).toBe(true);
        expect(dataManager.getCurrentCharacterId()).toBe('char-1');

        releaseFlush();
        await pending;

        expect(dataManager.isCharacterSwitching).toBe(false);
        expect(dataManager.getCurrentCharacterId()).toBe('char-2');
    });

    test('a second init waits for the first to finish rather than interleaving with it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { default: dataManager } = await import('./data-manager.js');
        const order = [];
        const onSwitching = (event) => order.push(`${event.oldId}->${event.newId}`);

        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            await webSocketHandlers.get('init_character_data')(initPayload());
            dataManager.lastCharacterSwitchTime = 0; // the singleton carries earlier tests' clock

            dataManager.on('character_switching', onSwitching);
            // Suspends the handler part way through the teardown, which is where a
            // second init used to run straight into the departing character's state
            storageMock.flushAll = vi.fn(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const first = webSocketHandlers.get('init_character_data')(
                initPayload({ character: { id: 'char-2', name: 'Two' } })
            );
            vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
            const second = webSocketHandlers.get('init_character_data')(
                initPayload({ character: { id: 'char-3', name: 'Three' } })
            );
            await Promise.all([first, second]);

            // char-3 departs char-2, not char-1: the first switch had finished before
            // the second started, so neither saw the other's half-torn-down state
            expect(order).toEqual(['char-1->char-2', 'char-2->char-3']);
            expect(dataManager.getCurrentCharacterId()).toBe('char-3');
        } finally {
            dataManager.off('character_switching', onSwitching);
            vi.useRealTimers();
        }
    });
});

describe('rapid character switches', () => {
    /**
     * Record the switch lifecycle a run produces, and put it back afterwards.
     * @param {Object} dataManager - The singleton
     * @param {Function} run - The switches to perform
     * @returns {Promise<{switching: string[], switched: string[]}>} What was emitted
     */
    async function recordLifecycle(dataManager, run) {
        const switching = [];
        const switched = [];
        const onSwitching = (event) => switching.push(`${event.oldId}->${event.newId}`);
        const onSwitched = (event) => switched.push(event.newId);
        dataManager.on('character_switching', onSwitching);
        dataManager.on('character_switched', onSwitched);
        try {
            await run();
            // character_switched is deferred through a setTimeout
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            dataManager.off('character_switching', onSwitching);
            dataManager.off('character_switched', onSwitched);
        }
        return { switching, switched };
    }

    test('a rapid switch still runs the whole lifecycle, so the new character gets its own settings', async () => {
        // The guard used to skip both events under a 1s window, which meant
        // config never reloaded and char-2 ran on char-1's per-character
        // settings until some later, slower switch happened along.
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        const init = webSocketHandlers.get('init_character_data');

        const { switching, switched } = await recordLifecycle(dataManager, async () => {
            await init(initPayload());
            // Make the next switch land inside the rapid window for certain
            dataManager.lastCharacterSwitchTime = Date.now();
            await init(initPayload({ character: { id: 'char-2', name: 'Two' } }));
        });

        expect(switching).toEqual(['char-1->char-2']);
        expect(switched).toEqual(['char-2']);
        expect(dataManager.getCurrentCharacterId()).toBe('char-2');
        // The departing character's pending writes were drained, not left for
        // after currentCharacterId moved on
        expect(storageMock.flushAll).toHaveBeenCalled();
    });

    test('a rapid A→B→A bounce ends pointing at A, with a lifecycle for each leg', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        const init = webSocketHandlers.get('init_character_data');

        const { switching, switched } = await recordLifecycle(dataManager, async () => {
            await init(initPayload());
            dataManager.lastCharacterSwitchTime = Date.now();
            await init(initPayload({ character: { id: 'char-2', name: 'Two' } }));
            await init(initPayload());
        });

        // Each leg reports the character it actually departed, so a listener
        // persisting "the current character" on switching never misfiles B's
        // state under A or the other way round
        expect(switching).toEqual(['char-1->char-2', 'char-2->char-1']);
        expect(switched).toEqual(['char-2', 'char-1']);
        expect(dataManager.getCurrentCharacterId()).toBe('char-1');
        expect(dataManager.getCurrentCharacterName()).toBe('Tester');
    });

    test('the slow-switch path is unchanged: flush, then switching, then the data update', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { default: dataManager } = await import('./data-manager.js');
        const order = [];
        const onSwitching = () => order.push('switching');
        const init = webSocketHandlers.get('init_character_data');

        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            await init(initPayload());
            dataManager.lastCharacterSwitchTime = 0; // the singleton carries earlier tests' clock

            storageMock.flushAll = vi.fn(async () => {
                order.push('flush');
            });
            dataManager.on('character_switching', onSwitching);

            vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
            await init(initPayload({ character: { id: 'char-2', name: 'Two' } }));

            expect(order).toEqual(['flush', 'switching']);
            expect(dataManager.getCurrentCharacterId()).toBe('char-2');
            expect(dataManager.getIsCharacterSwitching()).toBe(false);
        } finally {
            dataManager.off('character_switching', onSwitching);
            vi.useRealTimers();
        }
    });
});

/**
 * The old character's socket, still delivering after the switch.
 *
 * Switching character does not swap one connection for another cleanly: the
 * departing character's socket is open, and still sending, while the arriving
 * character's socket delivers its opening state. Nothing in an `items_updated` or
 * a `skills_updated` says whose it is, so before ownership was tracked those late
 * messages were applied to the arriving character as though they were theirs — a
 * misattribution that is not visible on screen and does not go away until the
 * next full init.
 */
describe('socket ownership across a character switch', () => {
    /** Two connections that are distinguishable and nothing else. */
    const socketA = { url: 'wss://api.milkywayidle.com/ws', id: 'A' };
    const socketB = { url: 'wss://api.milkywayidle.com/ws', id: 'B' };

    /**
     * Log in as one character on one socket.
     * @param {Object} character - `{id, name}`
     * @param {Object} socket - The socket the init arrived on
     * @returns {Promise<void>}
     */
    async function loginOn(character, socket) {
        await webSocketHandlers.get('init_character_data')(initPayload({ character }), { socket });
    }

    test('a late update from the old socket is rejected by every character-scoped handler', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await loginOn({ id: 'char-1', name: 'One' }, socketA);
        dataManager.lastCharacterSwitchTime = 0;
        await loginOn({ id: 'char-2', name: 'Two' }, socketB);

        const stale = { socket: socketA };

        // Inventory: char-1's last gather, arriving after char-2 is live
        dataManager.characterItems = [];
        webSocketHandlers.get('items_updated')(
            {
                endCharacterItems: [
                    {
                        id: 'i-1',
                        itemHrid: '/items/coin',
                        count: 999,
                        itemLocationHrid: '/item_locations/inventory',
                    },
                ],
            },
            stale
        );
        expect(dataManager.characterItems).toEqual([]);

        // Skills: char-1's levels would otherwise overwrite char-2's wholesale
        dataManager.characterSkills = [{ skillHrid: '/skills/milking', level: 10 }];
        webSocketHandlers.get('skills_updated')(
            { characterSkills: [{ skillHrid: '/skills/milking', level: 99 }] },
            stale
        );
        expect(dataManager.characterSkills).toEqual([{ skillHrid: '/skills/milking', level: 10 }]);

        // The action queue, which drives every ETA on screen
        dataManager.characterActions = [];
        webSocketHandlers.get('actions_updated')(
            { endCharacterActions: [{ id: 'a-1', isDone: false, ordinal: 1 }] },
            stale
        );
        expect(dataManager.characterActions).toEqual([]);

        // Quests, character info and settings, none of which name a character
        dataManager.characterQuests = [];
        webSocketHandlers.get('quests_updated')(
            { endCharacterQuests: [{ id: 'q-1', status: '/quest_status/active' }] },
            stale
        );
        expect(dataManager.characterQuests).toEqual([]);

        dataManager.characterData = { characterInfo: { taskSlots: 1 }, characterSetting: { crate: 'none' } };
        webSocketHandlers.get('character_info_updated')({ characterInfo: { taskSlots: 8 } }, stale);
        webSocketHandlers.get('setting_updated')({ characterSetting: { crate: 'all' } }, stale);
        expect(dataManager.characterData.characterInfo).toEqual({ taskSlots: 1 });
        expect(dataManager.characterData.characterSetting).toEqual({ crate: 'none' });

        // And the combat baseline the sim exports
        dataManager.battleData = null;
        webSocketHandlers.get('new_battle')({ combatMonsterHrid: '/monsters/abyssal_imp' }, stale);
        expect(dataManager.battleData).toBeNull();
    });

    test('the new socket owns the character, and its own messages are applied', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await loginOn({ id: 'char-1', name: 'One' }, socketA);
        dataManager.lastCharacterSwitchTime = 0;
        await loginOn({ id: 'char-2', name: 'Two' }, socketB);

        dataManager.characterSkills = [{ skillHrid: '/skills/milking', level: 10 }];
        webSocketHandlers.get('skills_updated')(
            { characterSkills: [{ skillHrid: '/skills/milking', level: 11 }] },
            { socket: socketB }
        );

        expect(dataManager.characterSkills).toEqual([{ skillHrid: '/skills/milking', level: 11 }]);
    });

    test('binding happens before the switch chain drains, not inside it', async () => {
        // The init handler queues its body behind _switchChain, which suspends on a
        // storage flush and on awaited character_switching listeners. Everything the
        // old socket delivers during that drain would still be accepted if ownership
        // were bound inside the handler — which is the window this closes.
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await loginOn({ id: 'char-1', name: 'One' }, socketA);
        dataManager.lastCharacterSwitchTime = 0;

        // Deliberately NOT awaited: the switch is still in flight
        const pending = webSocketHandlers.get('init_character_data')(
            initPayload({ character: { id: 'char-2', name: 'Two' } }),
            { socket: socketB }
        );

        expect(dataManager.activeSocket).toBe(socketB);

        dataManager.characterSkills = [{ skillHrid: '/skills/milking', level: 10 }];
        webSocketHandlers.get('skills_updated')(
            { characterSkills: [{ skillHrid: '/skills/milking', level: 99 }] },
            { socket: socketA }
        );
        expect(dataManager.characterSkills).toEqual([{ skillHrid: '/skills/milking', level: 10 }]);

        await pending;
    });

    test('a switch with no socket context unbinds rather than keeping the old owner', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await loginOn({ id: 'char-1', name: 'One' }, socketA);
        expect(dataManager.activeSocket).toBe(socketA);

        dataManager.lastCharacterSwitchTime = 0;
        await webSocketHandlers.get('init_character_data')(initPayload({ character: { id: 'char-2', name: 'Two' } }));

        // Keeping socketA bound would mean accepting exactly the messages this is
        // here to reject. Unknown ownership is permissive, but it is not wrong.
        expect(dataManager.activeSocket).toBeNull();
    });

    test('with no socket ever bound, handlers called without a context are accepted', async () => {
        // The check is permissive until ownership is actually known: an install that
        // never sees a socket behaves exactly as it did before, which is what keeps
        // every existing test — all of which drive these handlers with the payload
        // alone — passing unchanged
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await webSocketHandlers.get('init_character_data')(initPayload({ character: { id: 'char-1', name: 'One' } }));
        expect(dataManager.activeSocket).toBeNull();

        dataManager.characterSkills = [{ skillHrid: '/skills/milking', level: 10 }];
        webSocketHandlers.get('skills_updated')({ characterSkills: [{ skillHrid: '/skills/milking', level: 11 }] });

        expect(dataManager.characterSkills).toEqual([{ skillHrid: '/skills/milking', level: 11 }]);
    });

    test('global data is exempt: order books and community buffs come from any socket', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.lastCharacterSwitchTime = 0;

        await loginOn({ id: 'char-1', name: 'One' }, socketB);

        const listener = vi.fn();
        dataManager.on('market_item_order_books_updated', listener);
        const payload = { marketItemOrderBooks: { itemHrid: '/items/gourmet_tea' } };
        webSocketHandlers.get('market_item_order_books_updated')(payload, { socket: socketA });
        await new Promise((resolve) => setTimeout(resolve, 0));
        dataManager.off('market_item_order_books_updated', listener);
        expect(listener).toHaveBeenCalledWith(payload);

        dataManager.characterData = { communityBuffs: [{ hrid: '/community_buff_types/experience', level: 3 }] };
        webSocketHandlers.get('community_buffs_updated')(
            { communityBuffs: [{ hrid: '/community_buff_types/experience', level: 4 }] },
            { socket: socketA }
        );
        expect(dataManager.getCommunityBuffLevel('/community_buff_types/experience')).toBe(4);
    });
});

describe('live buff state mirroring', () => {
    let dataManager;
    const socketA = { id: 'socket-a' };

    beforeEach(async () => {
        dataManager = (await import('./data-manager.js')).default;
        resetCharacter(dataManager);
        dataManager.activeSocket = socketA;
        dataManager.characterData = {
            houseActionTypeBuffsMap: {
                '/action_types/enhancing': [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.01 }],
            },
            achievementActionTypeBuffsMap: { '/action_types/enhancing': [] },
            equipmentActionTypeBuffsMap: { '/action_types/enhancing': [] },
            guildActionTypeBuffsMap: { '/action_types/enhancing': [] },
            mooPassActionTypeBuffsMap: {},
            communityActionTypeBuffsMap: {},
            consumableActionTypeBuffsMap: {},
        };
    });

    // Every derived buff map used to be written once at init and never again, so a house
    // upgrade / achievement / re-equip / guild purchase left every consumer of
    // characterData.*ActionTypeBuffsMap reading login-time buffs for the whole session.
    const cases = [
        ['house_rooms_updated', 'houseActionTypeBuffsMap'],
        ['achievement_buffs_updated', 'achievementActionTypeBuffsMap'],
        ['equipment_buffs_updated', 'equipmentActionTypeBuffsMap'],
        ['guild_buffs_updated', 'guildActionTypeBuffsMap'],
        ['moo_pass_buffs_updated', 'mooPassActionTypeBuffsMap'],
        ['consumable_buffs_updated', 'consumableActionTypeBuffsMap'],
    ];

    test.each(cases)('%s replaces %s on characterData', (messageType, mapField) => {
        const fresh = { '/action_types/enhancing': [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.42 }] };
        const handler = webSocketHandlers.get(messageType);
        expect(handler).toBeTypeOf('function');
        handler({ [mapField]: fresh }, { socket: socketA });
        expect(dataManager.characterData[mapField]).toEqual(fresh);
    });

    test('an emptied map is stored rather than ignored as falsy', () => {
        webSocketHandlers.get('equipment_buffs_updated')({ equipmentActionTypeBuffsMap: {} }, { socket: socketA });
        expect(dataManager.characterData.equipmentActionTypeBuffsMap).toEqual({});
    });

    test('community_buffs_updated mirrors its action-type map too', () => {
        const fresh = { '/action_types/enhancing': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] };
        webSocketHandlers.get('community_buffs_updated')({ communityActionTypeBuffsMap: fresh }, { socket: socketA });
        expect(dataManager.characterData.communityActionTypeBuffsMap).toEqual(fresh);
    });

    /**
     * `house_rooms_updated` names the rooms that changed, not the whole house, which is
     * why `updateHouseRoomMap` merges. Assigning the payload over
     * `characterData.characterHouseRoomMap` afterwards dropped every room the message did
     * not mention — and the simulators' player DTO reads that map.
     */
    test('a house upgrade keeps the rooms its message did not mention', () => {
        dataManager.characterData.characterHouseRoomMap = {
            '/house_rooms/dairy_barn': { houseRoomHrid: '/house_rooms/dairy_barn', level: 5 },
            '/house_rooms/garden': { houseRoomHrid: '/house_rooms/garden', level: 3 },
        };

        webSocketHandlers.get('house_rooms_updated')(
            {
                characterHouseRoomMap: {
                    '/house_rooms/garden': { houseRoomHrid: '/house_rooms/garden', level: 4 },
                },
            },
            { socket: socketA }
        );

        expect(dataManager.characterData.characterHouseRoomMap['/house_rooms/garden'].level).toBe(4);
        expect(dataManager.characterData.characterHouseRoomMap['/house_rooms/dairy_barn']).toEqual({
            houseRoomHrid: '/house_rooms/dairy_barn',
            level: 5,
        });
    });

    test('a message from a foreign socket is ignored', () => {
        const before = dataManager.characterData.guildActionTypeBuffsMap;
        webSocketHandlers.get('guild_buffs_updated')(
            { guildActionTypeBuffsMap: { '/action_types/enhancing': [{ flatBoost: 9 }] } },
            { socket: { id: 'other' } }
        );
        expect(dataManager.characterData.guildActionTypeBuffsMap).toBe(before);
    });
});
