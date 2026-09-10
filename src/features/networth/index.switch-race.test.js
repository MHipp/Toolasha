/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing Net Worth down while its initialize() is parked
 * on the exclusions read.
 *
 * `initialize()` had no ownership check of any kind — not even the character-id
 * comparison other sites in this class started from. `isActive` is set only
 * *after* `await initExclusions()`, so a `disableAllFeatures()` landing inside
 * that read nulled `priceUpdateHandler`, `pricingModeHandler` and
 * `itemsUpdateHandler` and then the resumed tail called `setupEventListeners()`
 * unconditionally, refilling all three fields with fresh closures. Those are
 * single fields, not an array, so the arriving character's own initialize()
 * overwrites the handles and the leaked registrations can never be removed:
 * one orphaned price / settings / inventory listener per interrupted switch,
 * each re-pricing the whole inventory on every subsequent event, for the life
 * of the tab.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside initExclusions() */
    gate: null,
    characterId: 'char1',
}));

/** Live registrations, so leaks are countable. */
const live = vi.hoisted(() => ({
    price: [],
    settings: {},
    items: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.characterId,
        on: (event, handler) => {
            if (event === 'items_updated') live.items.push(handler);
        },
        off: (event, handler) => {
            if (event === 'items_updated') live.items = live.items.filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        on: (handler) => live.price.push(handler),
        off: (handler) => {
            live.price = live.price.filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        getSetting: () => false,
        onSettingChange: (key, handler) => {
            (live.settings[key] ??= []).push(handler);
        },
        offSettingChange: (key, handler) => {
            live.settings[key] = (live.settings[key] || []).filter((h) => h !== handler);
        },
    },
}));

vi.mock('./networth-exclusions.js', () => ({
    initExclusions: async () => {
        // The one read initialize() parks on
        if (world.gate) await world.gate;
    },
}));

vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => false } }));
vi.mock('../../utils/background-work.js', () => ({ runInBackground: async () => {} }));
vi.mock('../../utils/performance-monitor.js', () => ({
    default: {
        span: async (_a, _b, fn) => await fn(),
        record: () => {},
        recordElapsed: () => {},
    },
}));
vi.mock('./networth-calculator.js', () => ({ calculateNetworth: async () => null }));
vi.mock('./networth-display.js', () => ({
    networthHeaderDisplay: { setNetworthFeature: () => {}, initialize: () => {}, update: () => {}, disable: () => {} },
    networthInventoryDisplay: {
        setNetworthFeature: () => {},
        initialize: () => {},
        update: () => {},
        disable: () => {},
    },
}));
vi.mock('./networth-cache.js', () => ({ default: { clear: () => {} } }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));
vi.mock('./networth-history.js', () => ({ default: { initialize: async () => {}, disable: () => {} } }));
vi.mock('./networth-history-chart.js', () => ({
    default: { setNetworthFeature: () => {}, closeModal: () => {}, toggleModal: async () => {} },
}));
vi.mock('./production-income-recorder.js', () => ({ default: { initialize: async () => {}, cleanup: () => {} } }));
vi.mock('./chest-opening-recorder.js', () => ({ default: { initialize: async () => {}, cleanup: () => {} } }));
vi.mock('./gold-sources-panel.js', () => ({ default: { closeModal: () => {} } }));
vi.mock('./networth-exclusion-popup.js', () => ({ default: { refresh: () => {}, close: () => {} } }));
vi.mock('../../utils/networth-worker-manager.js', () => ({ terminateItemValueWorkerPool: () => {} }));

const networthFeature = (await import('./index.js')).default;

describe('a character switch landing inside the exclusions read', () => {
    beforeEach(() => {
        networthFeature.disable();
        world.gate = null;
        world.characterId = 'char1';
        live.price = [];
        live.settings = {};
        live.items = [];
    });

    afterEach(() => {
        networthFeature.disable();
    });

    /**
     * Start an initialize() whose exclusions read is held open, tear the
     * feature down inside it the way `disableAllFeatures()` does, then let the
     * read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = networthFeature.initialize();
        // `character_switching` — the feature layer comes down mid-read
        networthFeature.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers no listeners on the way out', async () => {
        await switchDuringInitialize();

        expect(live.price).toHaveLength(0);
        expect(live.settings.networth_pricingMode ?? []).toHaveLength(0);
        expect(live.settings.networth_valueSource ?? []).toHaveLength(0);
        expect(live.items).toHaveLength(0);
        // Nothing registered, and no flag left set for the arriving character
        expect(networthFeature.isActive).toBe(false);
    });

    test('the arriving character ends up with exactly one of each listener', async () => {
        await switchDuringInitialize();

        await networthFeature.initialize();

        expect(live.price).toHaveLength(1);
        expect(live.settings.networth_pricingMode).toHaveLength(1);
        expect(live.settings.networth_valueSource).toHaveLength(1);
        expect(live.items).toHaveLength(1);
    });

    test('a switch after the interrupted one can still remove every listener', async () => {
        await switchDuringInitialize();
        await networthFeature.initialize();

        networthFeature.disable();

        expect(live.price).toHaveLength(0);
        expect(live.settings.networth_pricingMode).toHaveLength(0);
        expect(live.settings.networth_valueSource).toHaveLength(0);
        expect(live.items).toHaveLength(0);
    });
});
