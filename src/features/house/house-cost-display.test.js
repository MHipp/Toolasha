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

describe('the materials list has no scroller of its own', () => {
    // One scroller now: the game's dialog (`Modal_modalContent`, bounded by
    // SCROLLER_MAX_HEIGHT). A second bound on the list here would recreate the
    // nested-scrollbar bug this replaces, so this asserts the bound is gone
    // rather than merely that a new one looks right.
    test('the list carries no inline max-height or overflow', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');

        expect(list).toBeTruthy();
        expect(list.style.maxHeight).toBe('');
        expect(list.style.overflowY).toBe('');
        expect(list.style.overscrollBehavior).toBe('');
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

describe('the scroller max-height fallback on browsers without :has()', () => {
    // What this can and cannot show: happy-dom does no layout, so nothing here
    // proves Firefox's scroller actually stays inside the frame — only that the
    // declarations a browser would need are set on exactly the ancestor whose
    // stylesheet rule was dropped, and taken off again on teardown. That the
    // values are the right ones was settled in a real browser (Firefox,
    // Chromium, WebKit) against a reproduction of the game's box structure,
    // with `:has()` simulated away.

    const realCSS = globalThis.CSS;

    /** Make `CSS.supports('selector(:has(*))')` answer `answer` */
    function withHasSupport(answer) {
        globalThis.CSS = { supports: () => answer };
    }

    /**
     * The game's full box structure between the section and the scroller:
     * Modal_modalContent (the game's scroller) wrapping HousePanel_modalContent
     * wrapping HousePanel_costs. `buildPanel()` above omits the outer scroller
     * entirely, which is fine for the min-height fallback (scoped to
     * HousePanel_modalContent itself) but leaves nothing for this fallback's
     * `closest('[class*="Modal_modalContent"]')` to find.
     */
    function buildNestedPanel() {
        const scroller = document.createElement('div');
        scroller.className = 'Modal_modalContent__xyz789';
        const modalContent = document.createElement('div');
        modalContent.className = 'HousePanel_modalContent__abc123';
        const costsSection = document.createElement('div');
        costsSection.className = 'HousePanel_costs__def456';
        modalContent.appendChild(costsSection);
        scroller.appendChild(modalContent);
        document.body.appendChild(scroller);
        return { scroller, modalContent, costsSection };
    }

    beforeEach(() => {
        houseCostDisplay.disable();
    });

    afterEach(() => {
        globalThis.CSS = realCSS;
    });

    test('caps the game scroller when :has() is unsupported', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        // The stylesheet rule was dropped whole, so without this the scroller
        // has nothing capping it to the frame in Firefox.
        expect(scroller.style.maxHeight).toContain('--toolasha-visual-viewport-height');
        expect(scroller.style.maxHeight).toContain('100vh'); // fallback for no visualViewport
        expect(scroller.style.boxSizing).toBe('border-box');
    });

    test('leaves the scroller alone when :has() is supported', async () => {
        withHasSupport(true);
        const { scroller, modalContent, costsSection } = buildNestedPanel();

        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);

        // The sheet is doing the job. An inline style here would be a second
        // opinion on the same properties with no way to be overruled.
        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('tearing the section down clears it', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.maxHeight).not.toBe('');

        // A room switch: the same panel redrawn for another room removes the
        // old section first. An inline style has no `:has()` to stop matching.
        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('disabling the feature clears it', async () => {
        withHasSupport(false);
        const { scroller, modalContent, costsSection } = buildNestedPanel();
        await houseCostDisplay.addCostColumn(costsSection, '/house_rooms/mystical_study', modalContent);
        expect(scroller.style.maxHeight).not.toBe('');

        houseCostDisplay.disable();

        expect(scroller.style.maxHeight).toBe('');
        expect(scroller.style.boxSizing).toBe('');
    });

    test('does not clear a max-height or box-sizing the game set itself', () => {
        const { scroller, modalContent } = buildNestedPanel();
        scroller.style.maxHeight = '640px';
        scroller.style.boxSizing = 'content-box';

        houseCostDisplay.removeExistingColumn(modalContent);

        expect(scroller.style.maxHeight).toBe('640px');
        expect(scroller.style.boxSizing).toBe('content-box');
    });
});

describe('Missing Mats Marketplace button placement', () => {
    test('the button lives in the pinned footer, not inside the list', async () => {
        const section = await render();
        const list = section.querySelector('.mwi-cumulative-materials-list');
        const footer = section.querySelector('.mwi-cumulative-footer');
        const button = [...section.querySelectorAll('button')].find(
            (b) => b.textContent === 'Missing Mats Marketplace'
        );

        expect(button).toBeTruthy();
        expect(list.contains(button)).toBe(false);
        expect(footer).toBeTruthy();
        expect(footer.contains(button)).toBe(true);
    });

    test('rows are followed by one footer holding the total and the button', async () => {
        const section = await render();
        const container = section.querySelector('.mwi-cumulative-cost-container');
        const children = [...container.children];

        expect(children[0].className).toBe('mwi-cumulative-materials-list');
        expect(children[1].className).toBe('mwi-cumulative-footer');
        expect(children[1].textContent).toContain('Total Market Value');
        expect(children[1].textContent).toContain('Missing Mats Marketplace');
        // Coins plus every material
        expect(children[0].children.length).toBe(MATERIALS.length + 1);
    });
});

describe('the footer is pinned to the bottom of the single scroller', () => {
    // happy-dom does no layout, so this cannot show the footer actually stays
    // visible — that was checked in real browsers against a reproduction. What
    // is assertable here is the sticky-positioning contract.
    //
    // The footer's opaque background is not asserted here: it is set as
    // `background: var(--color-midnight-900, #0a0a12)`, and happy-dom's
    // CSSStyleDeclaration rejects `var()` as a color value outright — it drops
    // the whole declaration rather than keeping the string, the same way it
    // drops `color: var(...)` — so `style.background` reads back empty
    // regardless of whether the source sets it. That the background is opaque
    // and not the section's translucent `rgba(0, 0, 0, 0.3)` was checked in a
    // real browser, not here.
    test('the footer is sticky and pinned to the bottom, above the rows', async () => {
        const section = await render();
        const footer = section.querySelector('.mwi-cumulative-footer');

        expect(footer.style.position).toBe('sticky');
        expect(footer.style.bottom).toBe('0px');
        expect(footer.style.zIndex).toBe('1');
    });
});

describe('the list has no scroll position of its own to carry across a redraw', () => {
    // Superseded by the single-scroller change: the list no longer scrolls on
    // its own, so it has no scrollTop worth carrying, and the fragment
    // clear+append is synchronous with no layout in between — so the dialog's
    // own scrollTop (the one real scroller now) is never touched by a rebuild.
    // This replaces the old "keeps its place" tests, which asserted a
    // scrollTop carry-over onto the list that no longer exists.
    test('a redraw does not put a scroll position on the rebuilt list', async () => {
        const section = await render();
        const container = section.querySelector('.mwi-cumulative-cost-container');
        const before = container.querySelector('.mwi-cumulative-materials-list');

        // What an `items_updated` does — the same call the handler makes
        await houseCostDisplay.updateCompactCumulativeDisplay(container, '/house_rooms/mystical_study', 5, 8);

        const after = container.querySelector('.mwi-cumulative-materials-list');
        expect(after).not.toBe(before); // genuinely rebuilt, not reused
        expect(after.scrollTop).toBe(0);
    });
});
