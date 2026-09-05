/** @vitest-environment happy-dom */

/**
 * Market Item Hop — stepping between marketplace items without the round trip through the grid.
 *
 * The guards get more attention than the happy path on purpose: a document-level keydown that
 * fires when it should not swallows typing, which is a far worse failure than the tedium the
 * feature removes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    settingOn: true,
    itemDetailMap: { '/items/plank': {}, '/items/sword': {}, '/items/cheese': {}, '/items/gem': {} },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => mocks.settingOn } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: mocks.itemDetailMap }) },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: mocks.navigate }));

const { default: itemHop } = await import('./market-item-hop.js');

const GRID_ITEMS = ['plank', 'sword', 'cheese'];

/** Draw the marketplace with the item grid showing, the way the game does. */
function drawGrid({ hidden = [] } = {}) {
    const tiles = GRID_ITEMS.map(
        (id) =>
            `<div class="Item_itemContainer__x" style="${hidden.includes(id) ? 'display: none' : ''}">
                <svg><use href="/static/media/items_sprite.svg#${id}"></use></svg>
            </div>`
    ).join('');
    document.body.innerHTML = `
        <div class="MarketplacePanel_marketplacePanel__a">
            <div class="MarketplacePanel_marketItems__b">${tiles}</div>
        </div>
    `;
}

/**
 * Draw one item's order-book page, the view the grid is replaced by.
 * @param {string} spriteId - Icon sprite id, e.g. 'sword'
 */
function drawItemPage(spriteId) {
    document.body.innerHTML = `
        <div class="MarketplacePanel_marketplacePanel__a">
            <div class="MarketplacePanel_currentItem__c">
                <svg><use href="/static/media/items_sprite.svg#${spriteId}"></use></svg>
            </div>
            <div class="MarketplacePanel_marketNavButtonContainer__d">
                <button id="native-back">View All Items</button>
                <button id="native-refresh">Refresh</button>
            </div>
        </div>
    `;
}

/**
 * Press a key at the document level.
 * @param {string} key - `event.key` value
 * @param {Object} [init] - Extra KeyboardEventInit fields (modifiers, target overrides)
 * @returns {KeyboardEvent} The dispatched event, so `defaultPrevented` can be read
 */
function press(key, init = {}) {
    const { target = document.body, ...rest } = init;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
    target.dispatchEvent(event);
    return event;
}

/** Run the module's DOM pass synchronously, without waiting on MutationObserver delivery. */
function settle() {
    itemHop._update();
}

/** Walk the grid then open one item, which is how a user reaches an order book. */
function openFromGrid(spriteId, gridOptions) {
    drawGrid(gridOptions);
    settle();
    drawItemPage(spriteId);
    settle();
}

describe('Market Item Hop', () => {
    beforeEach(() => {
        mocks.settingOn = true;
        mocks.navigate.mockClear();
        itemHop.initialize();
    });

    afterEach(() => {
        itemHop.cleanup();
        document.body.innerHTML = '';
    });

    describe('stepping', () => {
        test(']  opens the next item in the grid order', () => {
            openFromGrid('plank');
            const event = press(']');
            expect(mocks.navigate).toHaveBeenCalledWith('/items/sword', 0);
            expect(event.defaultPrevented).toBe(true);
        });

        test('[ opens the previous item', () => {
            openFromGrid('cheese');
            press('[');
            expect(mocks.navigate).toHaveBeenCalledWith('/items/sword', 0);
        });

        test('stops at the ends rather than wrapping', () => {
            openFromGrid('plank');
            expect(press('[').defaultPrevented).toBe(false);
            openFromGrid('cheese');
            expect(press(']').defaultPrevented).toBe(false);
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('skips items the grid filter hid', () => {
            openFromGrid('plank', { hidden: ['sword'] });
            press(']');
            expect(mocks.navigate).toHaveBeenCalledWith('/items/cheese', 0);
        });

        test('does nothing for an item that was not in the grid', () => {
            drawGrid();
            settle();
            drawItemPage('gem');
            settle();
            press(']');
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('Escape presses the game’s own back button', () => {
            openFromGrid('sword');
            const back = document.getElementById('native-back');
            const clicked = vi.fn();
            back.addEventListener('click', clicked);
            expect(press('Escape').defaultPrevented).toBe(true);
            expect(clicked).toHaveBeenCalled();
        });

        test('Escape is left to a modal while one is open', () => {
            openFromGrid('sword');
            document.body.insertAdjacentHTML('beforeend', '<div class="Modal_modalContainer__z"></div>');
            expect(press('Escape').defaultPrevented).toBe(false);
        });
    });

    describe('guards', () => {
        test('does nothing while typing in an input', () => {
            openFromGrid('plank');
            const input = document.createElement('input');
            document.body.appendChild(input);
            input.focus();
            expect(press(']', { target: input }).defaultPrevented).toBe(false);
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing while typing in a textarea or contenteditable', () => {
            openFromGrid('plank');
            document.body.insertAdjacentHTML(
                'beforeend',
                '<textarea id="ta"></textarea><div contenteditable="true" id="ce"><span id="inner">x</span></div>'
            );
            press(']', { target: document.getElementById('ta') });
            press(']', { target: document.getElementById('inner') });
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing when a modifier is held', () => {
            openFromGrid('plank');
            press(']', { ctrlKey: true });
            press(']', { altKey: true });
            press(']', { metaKey: true });
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing during IME composition', () => {
            openFromGrid('plank');
            press(']', { isComposing: true });
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing when the marketplace is closed', () => {
            drawGrid();
            settle();
            document.body.innerHTML = '<div class="SomeOtherPanel_x"></div>';
            press(']');
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing on the grid view itself', () => {
            drawGrid();
            settle();
            press(']');
            expect(mocks.navigate).not.toHaveBeenCalled();
        });

        test('does nothing when the setting is off', () => {
            itemHop.cleanup();
            mocks.settingOn = false;
            itemHop.initialize();
            openFromGrid('plank');
            press(']');
            expect(mocks.navigate).not.toHaveBeenCalled();
            expect(document.getElementById('mwi-item-hop-next')).toBeNull();
        });
    });

    describe('buttons', () => {
        test('injects a disabled-at-the-ends pair showing the position', () => {
            openFromGrid('plank');
            const prev = document.getElementById('mwi-item-hop-prev');
            const next = document.getElementById('mwi-item-hop-next');
            expect(prev.disabled).toBe(true);
            expect(next.disabled).toBe(false);
            expect(next.textContent).toContain('1/3');

            next.click();
            expect(mocks.navigate).toHaveBeenCalledWith('/items/sword', 0);
        });

        test('names the hotkeys in its tooltips', () => {
            openFromGrid('plank');
            expect(document.getElementById('mwi-item-hop-prev').title).toContain('[');
            expect(document.getElementById('mwi-item-hop-next').title).toContain(']');
        });

        test('are absent on an item the grid never listed', () => {
            drawGrid();
            settle();
            drawItemPage('gem');
            settle();
            expect(document.getElementById('mwi-item-hop-prev')).toBeNull();
        });
    });

    describe('teardown', () => {
        test('removes the key listener and the buttons', () => {
            openFromGrid('plank');
            expect(document.getElementById('mwi-item-hop-next')).not.toBeNull();

            itemHop.cleanup();

            expect(document.getElementById('mwi-item-hop-next')).toBeNull();
            press(']');
            expect(mocks.navigate).not.toHaveBeenCalled();
        });
    });
});
