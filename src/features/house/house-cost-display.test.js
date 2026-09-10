/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

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
    getCurrentRoomLevel: () => 5,
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
vi.mock('../../core/dom-observer.js', () => ({
    default: { observe: () => () => {}, onClass: () => () => {}, disconnect: () => {} },
}));

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

describe('the section holds its own height inside the panel flex column', () => {
    // What this can and cannot show: happy-dom does no layout, so none of these
    // assert that anything actually fits, scrolls or is reachable — only that
    // the two declarations the browser needs are both present and that the
    // game-element rule is scoped so it undoes itself. Whether the resulting
    // layout is right was settled in a real browser against a reproduction of
    // the game's box structure, not here.

    // The module is a singleton that remembers it has been initialized, so each
    // test starts it from a known stopped state rather than inheriting the last.
    beforeEach(() => {
        houseCostDisplay.disable();
    });

    test('the section refuses to be shrunk below its contents', async () => {
        const section = await render();
        expect(section.style.flexShrink).toBe('0');
        // The declaration this replaced. `min-height: 0` invited the flex line
        // to squeeze the section past its own bounded list, which put the list,
        // the total and the button outside the section's border.
        expect(section.style.minHeight).toBe('');
    });

    test('the panel is allowed to grow, so nothing else has to shrink', () => {
        houseCostDisplay.initialize();
        const sheet = document.getElementById('toolasha-house-panel-layout');

        expect(sheet).toBeTruthy();
        expect(sheet.textContent).toContain('HousePanel_modalContent');
        // `min-height` outranks a height or a max-height at used-value time, so
        // this holds however the panel was being clamped. Without it, a section
        // that will not shrink hands the whole deficit to the game's Build
        // button, which collapses to 0px.
        expect(sheet.textContent).toContain('min-height: fit-content');
    });

    test('the panel rule is scoped to panels this file has drawn into', () => {
        houseCostDisplay.initialize();
        const sheet = document.getElementById('toolasha-house-panel-layout');

        // This is the undo. No house panel without our section matches, so a
        // room switch, a removed column or a renamed game class all restore the
        // game's own layout with nothing to remember.
        expect(sheet.textContent).toContain(':has(.mwi-house-to-level)');
    });

    test('disabling the feature takes the stylesheet back out', () => {
        houseCostDisplay.initialize();
        expect(document.getElementById('toolasha-house-panel-layout')).toBeTruthy();

        houseCostDisplay.disable();
        expect(document.getElementById('toolasha-house-panel-layout')).toBeNull();
    });
});

describe('the panel min-height fallback on browsers without :has()', () => {
    // What this can and cannot show: happy-dom does no layout, so nothing here
    // proves the Build button survives — only that the declaration a browser
    // would need is set on exactly the browsers whose stylesheet rule was
    // dropped, and taken off again on teardown. That the value is the right one
    // was settled in a real browser against a reproduction of the game's box
    // structure, with `:has()` simulated away.

    const realCSS = globalThis.CSS;

    /** Make `CSS.supports('selector(:has(*))')` answer `answer` */
    function withHasSupport(answer) {
        globalThis.CSS = { supports: () => answer };
    }

    /** Make the whole support probe throw, the way a hostile shim would */
    function withThrowingSupports() {
        globalThis.CSS = {
            supports: () => {
                throw new Error('nope');
            },
        };
    }

    /** The game's boxes: HousePanel_modalContent wrapping HousePanel_costs */
    function buildPanel() {
        const modalContent = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__abc123';
        const costsSection = document.createElement('div');
        costsSection.className = 'HousePanel_costs__def456';
        modalContent.appendChild(costsSection);
        document.body.appendChild(modalContent);
        return { modalContent, costsSection };
    }

    beforeEach(() => {
        houseCostDisplay.disable();
    });

    afterEach(() => {
        globalThis.CSS = realCSS;
    });

    test('sets the panel min-height when :has() is unsupported', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeTruthy();
        // The stylesheet rule was dropped whole, so `flex-shrink: 0` on the
        // section would otherwise hand the entire deficit to the game's Build
        // button. This is the same value the rule would have set.
        expect(modalContent.style.minHeight).toContain('fit-content');
    });

    test('leaves the panel alone when :has() is supported', async () => {
        withHasSupport(true);
        const { modalContent, costsSection } = buildPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeTruthy();
        // The sheet is doing the job. An inline style here would be a second
        // opinion on the same property with no way to be overruled.
        expect(modalContent.style.minHeight).toBe('');
    });

    test('treats a throwing or absent CSS.supports as unsupported', async () => {
        withThrowingSupports();
        const first = buildPanel();
        await houseCostDisplay.addCostColumn(first.costsSection, '/house_rooms/mystical_study', first.modalContent);
        expect(first.modalContent.style.minHeight).toContain('fit-content');

        houseCostDisplay.disable();
        globalThis.CSS = undefined;
        const second = buildPanel();
        await houseCostDisplay.addCostColumn(second.costsSection, '/house_rooms/mystical_study', second.modalContent);
        // Failing this way costs one inline style on a browser that did not
        // need it; failing the other way costs the Build button.
        expect(second.modalContent.style.minHeight).toContain('fit-content');
    });

    test('tearing the section down clears it', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(modalContent.style.minHeight).toContain('fit-content');

        // A room switch: the same panel redrawn for another room removes the
        // old section first. An inline style has no `:has()` to stop matching.
        houseCostDisplay.removeExistingColumn(modalContent);

        expect(modalContent.querySelector('.mwi-house-to-level')).toBeNull();
        expect(modalContent.style.minHeight).toBe('');
    });

    test('disabling the feature clears it', async () => {
        withHasSupport(false);
        const { modalContent, costsSection } = buildPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(modalContent.style.minHeight).toContain('fit-content');

        houseCostDisplay.disable();

        expect(modalContent.style.minHeight).toBe('');
    });

    test('does not clear a min-height the game set itself', () => {
        const { modalContent } = buildPanel();
        modalContent.style.minHeight = '320px';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(modalContent.style.minHeight).toBe('320px');
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
