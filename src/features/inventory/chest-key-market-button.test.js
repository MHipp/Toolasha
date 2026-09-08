/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const game = vi.hoisted(() => ({
    clientData: {
        itemDetailMap: {
            '/items/chimerical_chest': { name: 'Chimerical Chest' },
            '/items/chimerical_chest_key': { name: 'Chimerical Chest Key' },
            '/items/cheese': { name: 'Cheese' },
        },
    },
    settings: { chestKeyMarketButton: true },
    navigated: [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => game.settings[key] },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.clientData },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (hrid) => game.navigated.push(hrid),
}));

import { chestKeyFor, chestKeyMarketButton } from './chest-key-market-button.js';

/**
 * The game's item action menu, as the feature finds it: an Item_name heading
 * and a Link to Chat button in one container.
 * @param {string} name - What the heading says
 * @returns {HTMLElement}
 */
function menuFor(name) {
    const menu = document.createElement('div');
    const heading = document.createElement('div');
    heading.className = 'Item_name__abc';
    heading.textContent = name;
    const link = document.createElement('button');
    link.textContent = 'Link to Chat';
    menu.append(heading, link);
    document.body.appendChild(menu);
    return menu;
}

afterEach(() => {
    chestKeyMarketButton.disable();
    document.body.innerHTML = '';
    game.navigated.length = 0;
    game.settings.chestKeyMarketButton = true;
    localStorage.removeItem('i18nextLng');
    _resetGameNumberSeparators();
});

describe('chestKeyFor', () => {
    it('names the key of a keyed chest', () => {
        expect(chestKeyFor('/items/chimerical_chest', game.clientData.itemDetailMap)).toBe(
            '/items/chimerical_chest_key'
        );
    });

    it('says nothing for an item with no key sibling', () => {
        expect(chestKeyFor('/items/cheese', game.clientData.itemDetailMap)).toBeNull();
    });

    it('does not offer a key its own key', () => {
        expect(chestKeyFor('/items/chimerical_chest_key', game.clientData.itemDetailMap)).toBeNull();
    });
});

describe('the button in the chest popup', () => {
    it('appears on a keyed chest and opens the key on the marketplace', () => {
        const menu = menuFor('Chimerical Chest');
        chestKeyMarketButton.initialize();

        const btn = menu.querySelector('.mwi-chest-key-market-btn');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('Buy Keys on Marketplace');

        btn.click();
        expect(game.navigated).toEqual(['/items/chimerical_chest_key']);
    });

    it('reads the name past a leading count', () => {
        const menu = menuFor('3 Chimerical Chest');
        chestKeyMarketButton.initialize();

        expect(menu.querySelector('.mwi-chest-key-market-btn')).not.toBeNull();
    });

    it('reads the name past a comma-grouped leading count (en-US)', () => {
        localStorage.setItem('i18nextLng', 'en-US');
        _resetGameNumberSeparators();
        const menu = menuFor('1,234 Chimerical Chest');
        chestKeyMarketButton.initialize();

        expect(menu.querySelector('.mwi-chest-key-market-btn')).not.toBeNull();
    });

    it('reads the name past a period-grouped leading count (de-DE) — the bug this replaces', () => {
        // A hardcoded `[\d,]+\s+` leaves the leftover ".234 Chimerical Chest"
        // glued onto the name in a period-grouping locale, and the lookup misses.
        localStorage.setItem('i18nextLng', 'de-DE');
        _resetGameNumberSeparators();
        const menu = menuFor('1.234 Chimerical Chest');
        chestKeyMarketButton.initialize();

        expect(menu.querySelector('.mwi-chest-key-market-btn')).not.toBeNull();
    });

    it('leaves keyless items alone', () => {
        const menu = menuFor('Cheese');
        chestKeyMarketButton.initialize();

        expect(menu.querySelector('.mwi-chest-key-market-btn')).toBeNull();
    });

    it('injects once however many times the menu is scanned', () => {
        const menu = menuFor('Chimerical Chest');
        chestKeyMarketButton.initialize();
        chestKeyMarketButton.disable();
        chestKeyMarketButton.initialize();

        expect(menu.querySelectorAll('.mwi-chest-key-market-btn').length).toBe(1);
    });

    it('stays out of the way when switched off', () => {
        game.settings.chestKeyMarketButton = false;
        const menu = menuFor('Chimerical Chest');
        chestKeyMarketButton.initialize();

        expect(menu.querySelector('.mwi-chest-key-market-btn')).toBeNull();
    });
});
