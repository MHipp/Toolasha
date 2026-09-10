/** @vitest-environment happy-dom
 *
 * The armed buy quantity, across a character switch.
 *
 * "Buy books" arms the marketplace autofill with *this* character's shortfall
 * and then navigates away. The arming is one-shot but not time-bounded: it
 * waits for a buy box for that book to actually open, which is a trip to the
 * marketplace and any number of clicks later — comfortably long enough for the
 * player to change character on the way. Nothing dropped it when they did, so
 * the arriving character's New Buy Listing for that book came up with the
 * departed character's count already typed in.
 *
 * The real `createAutofillManager` is used here, and its own read API is the
 * assertion: a mock could only show that a call was made, and what matters is
 * that the number is gone from the closure that would fill the box.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, prices: {}, character: null }));
const bus = vi.hoisted(() => ({ handlers: {} }));
/** Every autofill manager the module under test made, in order */
const managers = vi.hoisted(() => ({ made: [] }));

vi.mock('../../utils/marketplace-autofill.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        createAutofillManager: (observerId) => {
            const manager = real.createAutofillManager(observerId);
            managers.made.push(manager);
            return manager;
        },
    };
});

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerShopCoinCost: () => 0,
}));
vi.mock('../../utils/tester-shop-nav.js', () => ({
    openTesterShopPage: async () => null,
    setShopFilter: () => {},
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        get characterData() {
            return game.character;
        },
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => false } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./ability-checkpoints.js', () => ({ rateFor: () => null, rateWindowLabel: () => '' }));

const { buyBooks } = await import('./ability-book-panel.js');
const { default: dataManager } = await import('../../core/data-manager.js');

/** The one manager the panel makes, at module scope */
const autofill = () => managers.made[0];

const BOOK = '/items/puncture_book';

describe('an armed book quantity does not follow the player to another character', () => {
    beforeEach(() => {
        game.data = { itemDetailMap: { [BOOK]: { name: 'Puncture' } } };
        autofill().clearQuantity();
    });

    test('the arming is dropped when the character changes', () => {
        // 2,809 books is an answer about *this* character's Puncture level
        buyBooks(BOOK, 2809);
        expect(autofill().getQuantity()).toBe(2809);

        dataManager.emit('character_switching');

        expect(autofill().getQuantity()).toBe(null);
    });

    test('the arming survives everything that is not a character switch', () => {
        buyBooks(BOOK, 2809);
        dataManager.emit('items_updated');
        expect(autofill().getQuantity()).toBe(2809);
    });

    test('the observer is not torn down with it, so the next arming still fills', () => {
        buyBooks(BOOK, 2809);
        dataManager.emit('character_switching');

        // The arriving character asks for their own count and it takes, which
        // is what a `cleanup()` here would have broken: the observer is
        // registered once behind a flag nothing resets.
        buyBooks(BOOK, 41);
        expect(autofill().getQuantity()).toBe(41);
    });
});
