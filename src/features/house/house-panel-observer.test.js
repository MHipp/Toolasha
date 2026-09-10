/** @vitest-environment happy-dom
 *
 * The house observer's teardown, and the sub-module it owns.
 *
 * `housePanelObserver.initialize()` starts `houseCostDisplay`, which is not a
 * registered feature and so is never handed to the registry's teardown. The
 * observer's `disable()` used to tear down only its own DOM observers, so the
 * display's two data-manager listeners survived every character switch and a
 * new pair was registered on the re-initialise — one pair per switch, for the
 * life of the tab.
 *
 * The assertion that matters is the second cycle: a single leaked pair is a
 * bug you can argue about, and accumulation is the one that ends the session.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The data manager's event bus, reduced to what these modules subscribe to */
const bus = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((entry) => entry !== handler);
        },
        emit: (event, payload) => {
            for (const handler of [...(bus.handlers[event] || [])]) handler(payload);
        },
        getInitClientData: () => ({ houseRoomDetailMap: {} }),
        getCurrentCharacterId: () => 'char-1',
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {},
    },
}));

const observers = vi.hoisted(() => ({ registered: 0 }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => {
            observers.registered++;
            return () => {
                observers.registered--;
            };
        },
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));

// The marketplace tabs live in the game's own DOM and are never what a
// lifecycle test is about
vi.mock('../../utils/marketplace-tabs.js', () => ({
    createMaterialTab: () => null,
    createClearAllTabsControl: () => null,
    removeMaterialTabs: () => {},
    setupMarketplaceCleanupObserver: () => () => {},
    navigateToMarketplace: () => {},
    navigateToMarketListingsTab: () => {},
    visibleTabsContainer: () => null,
    attachRegularTabClearListener: () => {},
}));

vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        cleanup: () => {},
        clearQuantity: () => {},
        setQuantity: () => {},
    }),
}));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    initialize: async () => {},
    calculateUpgradeCost: () => null,
    getCumulativeCost: () => null,
}));

const housePanelObserver = (await import('./house-panel-observer.js')).default;
const houseCostDisplay = (await import('./house-cost-display.js')).default;

/** How many handlers the display owns on the data-manager bus */
function displayListeners() {
    return (bus.handlers.items_updated?.length || 0) + (bus.handlers.house_rooms_updated?.length || 0);
}

beforeEach(() => {
    bus.handlers = {};
    observers.registered = 0;
    housePanelObserver.disable();
    houseCostDisplay.disable();
    bus.handlers = {};
});

afterEach(() => {
    housePanelObserver.disable();
    houseCostDisplay.disable();
});

describe('house panel observer teardown', () => {
    test('starting the observer starts the cost display', async () => {
        expect(displayListeners()).toBe(0);
        await housePanelObserver.initialize();
        expect(displayListeners()).toBe(2);
    });

    test('tearing the observer down removes the cost display listeners', async () => {
        await housePanelObserver.initialize();
        expect(displayListeners()).toBe(2);

        housePanelObserver.disable();

        expect(displayListeners()).toBe(0);
    });

    test('a second init/teardown cycle leaves the listener count where it started', async () => {
        const before = displayListeners();

        for (let cycle = 0; cycle < 3; cycle++) {
            await housePanelObserver.initialize();
            housePanelObserver.disable();
        }

        expect(displayListeners()).toBe(before);
    });

    test('the display disable is safe to call when it never initialised', () => {
        expect(() => houseCostDisplay.disable()).not.toThrow();
        expect(() => houseCostDisplay.disable()).not.toThrow();
        expect(displayListeners()).toBe(0);
    });
});
