/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing the display down while its initialize() is parked
 * on the shared sort manager's read of the pins and sort mode.
 *
 * `isInitialized` is set *before* that await, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `disable()`
 * had nulled every handler field and dropped the tile observer, and re-stored
 * its own handles into those same fields. The listeners and the observer the
 * teardown had removed handles for stayed live with nothing left to remove them
 * by: one leak per switch, each a full profit/exp recompute and a DOM pass over
 * every visible action tile on every inventory change.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the sort manager's read */
    gate: null,
    characterId: 'char1',
}));

/** Every live dataManager listener, by event, so leaks are countable. */
const events = vi.hoisted(() => ({ handlers: {} }));
/** How many tile observers are registered and how many have been dropped. */
const tiles = vi.hoisted(() => ({ registered: 0, unregistered: 0 }));
const settingListeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        getActionDetails: () => null,
        getInventory: () => [],
        on: (event, handler) => {
            (events.handlers[event] ??= []).push(handler);
        },
        off: (event, handler) => {
            events.handlers[event] = (events.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
        },
        offSettingChange: (key, callback) => {
            settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
        },
    },
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        initialize: async () => {
            if (world.gate) await world.gate;
        },
        clearAllPanels: () => {},
    },
}));
vi.mock('./action-filter.js', () => ({ default: {} }));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => null }));
vi.mock('../../utils/action-panel-helper.js', () => ({
    onActionTile: () => {
        tiles.registered += 1;
        return () => {
            tiles.unregistered += 1;
        };
    },
    resolveActionTile: () => ({ actionHrid: null, actionDetails: null }),
}));

const gatheringStats = (await import('./gathering-stats.js')).default;

const liveCount = (event) => (events.handlers[event] || []).length;

describe('a character switch landing inside the sort manager read', () => {
    beforeEach(() => {
        gatheringStats.disable();
        world.gate = null;
        world.characterId = 'char1';
        events.handlers = {};
        tiles.registered = 0;
        tiles.unregistered = 0;
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    afterEach(() => {
        gatheringStats.disable();
    });

    /**
     * Start an initialize() whose read is held open, tear the display down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = gatheringStats.initialize();
        // `character_switching` — the feature layer comes down mid-read
        gatheringStats.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        expect(liveCount('items_updated')).toBe(0);
        expect(liveCount('consumables_updated')).toBe(0);
        expect(liveCount('character_switching')).toBe(0);
        expect(tiles.registered).toBe(0);
        expect(settingListeners.profitCalc_pricingMode ?? []).toHaveLength(0);
        expect(gatheringStats.isInitialized).toBe(false);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await gatheringStats.initialize();

        expect(liveCount('items_updated')).toBe(1);
        expect(liveCount('consumables_updated')).toBe(1);
        expect(liveCount('character_switching')).toBe(1);
        expect(tiles.registered - tiles.unregistered).toBe(1);
        expect(settingListeners.actionPanel_showProfitPerHour_gathering).toHaveLength(1);

        // …and that one set is the one the teardown can remove
        gatheringStats.disable();
        expect(liveCount('items_updated')).toBe(0);
        expect(tiles.registered - tiles.unregistered).toBe(0);
    });
});
