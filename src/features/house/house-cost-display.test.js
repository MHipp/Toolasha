/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

// A Mystical Study 5 -> 6 upgrade, the shape of the user's bug report: many
// materials, several of them short, so the marketplace button is built too.
const MATERIALS = Array.from({ length: 14 }, (_, i) => ({
    itemHrid: `/items/mat_${i}`,
    count: 1000,
    totalValue: 10_000,
}));

const itemDetailMap = Object.fromEntries(MATERIALS.map((m, i) => [m.itemHrid, { name: `Mat ${i}`, isTradable: true }]));

vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateCumulativeCost: async () => ({
        coins: 5000,
        materials: MATERIALS,
        totalValue: 1_000_000,
    }),
    // Nothing in the inventory, so every material is short
    getInventoryCount: () => 0,
    getItemName: (hrid) => itemDetailMap[hrid]?.name ?? hrid,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap }),
        getInventory: () => [],
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: null }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false }));
vi.mock('../../core/dom-observer.js', () => ({ default: { observe: () => () => {}, disconnect: () => {} } }));

const { default: houseCostDisplay } = await import('./house-cost-display.js');

/** Build the game's costs section and let the module hang its own section off it */
async function render(currentLevel = 5) {
    const modal = document.createElement('div');
    const costsSection = document.createElement('div');
    modal.appendChild(costsSection);
    document.body.appendChild(modal);
    await houseCostDisplay.addCompactToLevel(costsSection, '/house_rooms/mystical_study', currentLevel);
    return modal.querySelector('.mwi-house-to-level');
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('cumulative cost list height bound', () => {
    // happy-dom does no layout at all: clientHeight and scrollHeight are both 0
    // here, so nothing below measures scrolling. What is assertable is that the
    // declarations a browser needs in order to scroll are present, and that the
    // button is not inside the box that scrolls.
    test('the materials list carries a real height bound, not a bare overflow', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');

        expect(list).toBeTruthy();
        expect(list.style.overflowY).toBe('auto');
        // `overflow-y: auto` on an unbounded box can never scroll - the box just
        // grows to fit. The bound is what makes the overflow mean anything.
        expect(list.style.maxHeight).not.toBe('');
        expect(list.style.maxHeight).toContain('--toolasha-visual-viewport-height');
        expect(list.style.maxHeight).toContain('100vh'); // fallback for no visualViewport
    });

    test('the section itself does not claim to scroll without a bound', async () => {
        const section = await render();
        // It has no max-height and no height-constraining ancestor, so an
        // `overflow-y` here would be inert and misleading.
        expect(section.style.overflowY).toBe('');
    });
});

describe('Missing Mats Marketplace button placement', () => {
    test('the button lives below the scrolling list, not inside it', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');
        const button = [...section.querySelectorAll('button')].find(
            (b) => b.textContent === 'Missing Mats Marketplace'
        );

        expect(button).toBeTruthy();
        expect(list.contains(button)).toBe(false);
        expect(section.contains(button)).toBe(true);
    });

    test('rows scroll; total and button are siblings after the list', async () => {
        const section = await render();
        const container = section.querySelector('.mwi-cumulative-cost-container');
        const children = [...container.children];

        expect(children[0].className).toBe('mwi-cumulative-materials-list');
        expect(children[1].textContent).toContain('Total Market Value');
        expect(children[2].textContent).toBe('Missing Mats Marketplace');
        // Coins plus every material
        expect(children[0].children.length).toBe(MATERIALS.length + 1);
    });
});
