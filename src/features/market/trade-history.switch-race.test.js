/**
 * A character switch tearing the tracker down while its initialize() is parked
 * on the stored-history read.
 *
 * This module holds its own `character_switched` listener, so the survey's
 * "dead until reload" shape does not apply to it: `handleCharacterSwitch()`
 * re-disables and re-initialises, and where the interrupted read lands BEFORE
 * that listener runs it does self-heal. It does not self-heal in the ordering
 * that matters, though — the read landing while `handleCharacterSwitch()` is
 * itself parked on the re-initialise. Then both initialize() calls register,
 * `marketUpdateHandler` keeps only the second handle, and the first listener
 * can never be removed: every fill is recorded twice, for as long as the tab
 * lives.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the history read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    listeners: new Map(),
    getCurrentCharacterId: () => dataManagerMock.characterId,
    on: (event, handler) => {
        if (!dataManagerMock.listeners.has(event)) dataManagerMock.listeners.set(event, []);
        dataManagerMock.listeners.get(event).push(handler);
    },
    off: (event, handler) => {
        const list = dataManagerMock.listeners.get(event) || [];
        const at = list.indexOf(handler);
        if (at !== -1) list.splice(at, 1);
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (storageMock.gate) await storageMock.gate;
            return { found: key in storageMock.stored, value: storageMock.stored[key] };
        },
        get: async (key) => storageMock.stored[key] ?? null,
        set: async (key, value) => {
            storageMock.stored[key] = value;
            return true;
        },
    },
}));
vi.mock('../../utils/sync-merge-registry.js', () => ({ registerSyncMerge: () => {} }));

const { default: tradeHistory } = await import('./trade-history.js');

/** @returns {Array<Function>} The live `market_listings_updated` listeners */
function marketListeners() {
    return dataManagerMock.listeners.get('market_listings_updated') || [];
}

describe('a character switch landing inside the stored-history read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        tradeHistory.disable();
        dataManagerMock.listeners.clear();
        tradeHistory.history = {};
        tradeHistory.isLoaded = false;
    });

    /**
     * Start an initialize() whose read is held open, tear the tracker down
     * inside it the way `disableAllFeatures()` does, then run the module's own
     * `character_switched` handler while the read is still out.
     * @returns {Promise<void>} Resolves once both have finished
     */
    async function switchDuringInitialize() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = tradeHistory.initialize();
        // `character_switching` — the registry brings the feature layer down
        tradeHistory.disable();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        // `character_switched` — this module's own listener, which re-disables
        // and re-initialises, and parks on the same read
        const switched = tradeHistory.handleCharacterSwitch();
        release();
        storageMock.gate = null;
        await Promise.all([pending, switched]);
    }

    test('the interrupted initialize leaves no second, unremovable listener', async () => {
        await switchDuringInitialize();

        expect(marketListeners().length).toBe(1);
        expect(tradeHistory.isInitialized).toBe(true);

        // The one handle the module holds releases everything it registered
        tradeHistory.disable();
        expect(marketListeners().length).toBe(0);
        expect(tradeHistory.isInitialized).toBe(false);
    });

    test("the arriving character's prices are read back and recorded once", async () => {
        storageMock.stored.tradeHistory_char2 = { 'item/log:0': { buy: 120 } };

        await switchDuringInitialize();

        expect(tradeHistory.characterId).toBe('char2');
        // char2's own map, under char2's key — not char1's folded in
        expect(tradeHistory.history['item/log:0']).toEqual({ buy: 120 });

        // A fill reaches exactly one listener, so it is recorded once
        const seen = [];
        const [handler] = marketListeners();
        const spy = vi.spyOn(tradeHistory, 'handleMarketUpdate').mockImplementation((data) => seen.push(data));
        for (const listener of marketListeners()) listener({ endMarketListings: [] });
        expect(typeof handler).toBe('function');
        expect(seen.length).toBe(1);
        spy.mockRestore();
    });
});
