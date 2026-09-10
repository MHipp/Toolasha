/**
 * A character switch tearing the collector down while its initialize() is
 * parked on one of its two storage reads.
 *
 * `isInitialized` is set *before* both reads, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `cleanup()`
 * had unhooked `new_battle` and `battle_consumable_ability_updated` and nulled
 * the fields holding them, and re-stored its own handles into those same
 * fields. The previous pair stayed live with nothing left to remove it by, and
 * every tick after that was counted once per leaked pair: doubled damage and
 * doubled consumable counts in the Combat Statistics panel, tripled after two
 * switches, and so on for as long as the tab lived.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside a storage read */
    gate: null,
    /** Which record's read to park in — the scoped key it is stored under */
    parkKey: 'consumableTracker',
    /** Called the moment that read is entered, so the test can act inside it */
    arrived: null,
    characterId: 'char1',
}));

/** Every live websocket handler, by message type, so leaks are countable. */
const socket = vi.hoisted(() => ({ handlers: {} }));
/** Every live dataManager listener, by event. */
const events = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            (socket.handlers[type] ??= []).push(handler);
        },
        off: (type, handler) => {
            socket.handlers[type] = (socket.handlers[type] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentActions: () => [],
        on: (event, handler) => {
            (events.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            events.handlers[event] = (events.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 'ask' } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 1, bid: 1 }) } }));
vi.mock('./combat-session-history.js', async () => {
    const actual = await vi.importActual('./combat-session-history.js');
    return { ...actual, archiveSession: async () => [] };
});
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => {
            // The scoped probe of the chosen record — `readScoped` asks for
            // `<base>_<characterId>` before falling back to the bare key
            if (world.parkKey && key.startsWith(`${world.parkKey}_`)) {
                world.arrived?.();
                if (world.gate) await world.gate;
            }
            return fallback;
        },
        getJSON: async () => null,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        delete: async () => true,
    },
}));

const collector = (await import('./combat-stats-data-collector.js')).default;

const liveSocket = (type) => (socket.handlers[type] || []).length;
const liveEvent = (event) => (events.handlers[event] || []).length;

describe('a character switch landing inside the collector reads', () => {
    beforeEach(() => {
        collector.cleanup();
        world.gate = null;
        world.parkKey = 'consumableTracker';
        world.arrived = null;
        world.characterId = 'char1';
        socket.handlers = {};
        events.handlers = {};
        // The switch pair is registered once for the tab's lifetime and is
        // deliberately not removed by cleanup(); forget it so each test counts
        // its own registrations
        collector.switchingHandler = null;
        collector.switchedHandler = null;
    });

    afterEach(() => {
        world.gate = null;
        collector.cleanup();
    });

    /**
     * Start an initialize() whose read is held open, tear the collector down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @param {string} parkKey - Which record's read to park in
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize(parkKey = 'consumableTracker') {
        let release;
        let entered;
        world.parkKey = parkKey;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const reached = new Promise((resolve) => {
            entered = resolve;
        });
        world.arrived = entered;
        const pending = collector.initialize();
        // Parking in the *second* read means letting the first one land first,
        // so the teardown really does arrive after the earlier guard has passed
        await reached;
        // `character_switching` — the feature layer comes down mid-read
        collector.cleanup();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize('consumableTracker');

        expect(liveSocket('new_battle')).toBe(0);
        expect(liveSocket('battle_consumable_ability_updated')).toBe(0);
        expect(liveEvent('character_switching')).toBe(0);
        expect(liveEvent('character_switched')).toBe(0);
        expect(collector.isInitialized).toBe(false);
    });

    test('a switch landing in the second read registers nothing either', async () => {
        await switchDuringInitialize('latestCombatRun');

        expect(liveSocket('new_battle')).toBe(0);
        expect(liveSocket('battle_consumable_ability_updated')).toBe(0);
        expect(collector.isInitialized).toBe(false);
    });

    test('a run of interrupted switches leaves the arriving character one handler each', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize(i % 2 === 0 ? 'consumableTracker' : 'latestCombatRun');
        // The switch's own re-initialise, which the flag never blocked
        await collector.initialize();

        // A second `new_battle` handler is every tick's damage counted twice;
        // a second consumable handler is every sip counted twice
        expect(liveSocket('new_battle')).toBe(1);
        expect(liveSocket('battle_consumable_ability_updated')).toBe(1);
        expect(liveEvent('character_switching')).toBe(1);
        expect(liveEvent('character_switched')).toBe(1);

        // …and that pair is the one the teardown can remove
        collector.cleanup();
        expect(liveSocket('new_battle')).toBe(0);
        expect(liveSocket('battle_consumable_ability_updated')).toBe(0);
    });
});
