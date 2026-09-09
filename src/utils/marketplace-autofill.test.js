/** @vitest-environment happy-dom */
/**
 * Tests for Marketplace Buy Modal Autofill Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handlers: {}, registrations: 0, unregistrations: 0 }));

vi.mock('../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((name, _classNames, callback) => {
            observerState.registrations += 1;
            observerState.handlers[name] = callback;
            return () => {
                observerState.unregistrations += 1;
                delete observerState.handlers[name];
            };
        }),
    },
}));

const { createAutofillManager, findQuantityInput, modalItemHrid } = await import('./marketplace-autofill.js');

function buildModal({ headerText = 'Buy Now', inputs = [{ label: 'Quantity' }], itemHrid = null } = {}) {
    const modal = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'MarketplacePanel_header';
    header.textContent = headerText;
    modal.appendChild(header);

    // The icon is the only place a buy modal says which item it is about
    if (itemHrid) {
        modal.innerHTML += `<svg><use href="/static/media/items_sprite.svg#${itemHrid.split('/').pop()}"></use></svg>`;
    }

    for (const input of inputs) {
        const wrapper = document.createElement('div');
        // A row class (as the game marks its Price/Quantity rows) is the reliable
        // anchor; when present the label need not be an ancestor, matching the
        // real DOM where it is a sibling.
        if (input.rowClass) wrapper.className = input.rowClass;
        if (!input.rowClass) wrapper.textContent = input.label || '';
        const el = document.createElement('input');
        // The marketplace fields became typable text inputs on 8/13/2026; default
        // to number so the pre-patch tests are unchanged.
        el.type = input.type || 'number';
        wrapper.appendChild(el);
        modal.appendChild(wrapper);
    }
    document.body.appendChild(modal);
    return modal;
}

// Value setter shim: happy-dom supports value assignment directly via the native setter,
// so nativeInputValueSetter.call still works against a real <input>.
describe('createAutofillManager', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        observerState.handlers = {};
        observerState.registrations = 0;
        observerState.unregistrations = 0;
    });

    test('initialize() registers a domObserver handler under the given id', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        expect(observerState.handlers['Test-Observer']).toBeTypeOf('function');
    });

    test('fills the quantity input in a Buy Now modal and then clears the static quantity (one-shot)', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(42);
        manager.initialize();

        const modal = buildModal();
        observerState.handlers['Test-Observer'](modal);

        const input = modal.querySelector('input');
        expect(input.value).toBe('42');
        expect(manager.getQuantity()).toBeNull(); // one-shot cleared after use
    });

    test('does nothing when quantity is not set', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        const modal = buildModal();
        observerState.handlers['Test-Observer'](modal);
        expect(modal.querySelector('input').value).toBe('');
    });

    test('fills the Shop’s own buy dialog — Quantity, You Pay, a Buy button, no header', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(8);
        manager.initialize();
        const modal = document.createElement('div');
        modal.innerHTML =
            '<div>Philosopher&#39;s Mirror</div><div>Quantity</div><input type="text">' +
            '<div>You Pay: 10,000,000 Coin</div><button>Buy</button>';
        document.body.appendChild(modal);
        observerState.handlers['Test-Observer'](modal);
        expect(modal.querySelector('input').value).toBe('8');
    });

    test('a headerless dialog about selling is left alone', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(8);
        manager.initialize();
        const modal = document.createElement('div');
        modal.innerHTML = '<div>Quantity</div><input type="text"><div>You Pay: 1</div><button>Sell</button>';
        document.body.appendChild(modal);
        observerState.handlers['Test-Observer'](modal);
        expect(modal.querySelector('input').value).toBe('');
    });

    test('ignores modals whose header is not a Buy Now/Buy Listing modal', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(5);
        manager.initialize();
        const modal = buildModal({ headerText: 'Sell Now' });
        observerState.handlers['Test-Observer'](modal);
        // Input is untouched: the header didn't match, so no fill happened
        expect(modal.querySelector('input').value).toBe('');
    });

    test('setPendingCalculation takes priority and is recomputed on every modal open', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(999); // should be overridden
        let counter = 10;
        manager.setPendingCalculation(() => counter++);
        manager.initialize();

        const modal1 = buildModal();
        observerState.handlers['Test-Observer'](modal1);
        expect(modal1.querySelector('input').value).toBe('10');

        const modal2 = buildModal();
        observerState.handlers['Test-Observer'](modal2);
        expect(modal2.querySelector('input').value).toBe('11');
    });

    test('clearQuantity resets both static and pending quantity', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(5);
        manager.clearQuantity();
        expect(manager.getQuantity()).toBeNull();
    });

    test('finds the quantity input among multiple inputs, avoiding the enhancement level input', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(7);
        manager.initialize();

        const modal = buildModal({ inputs: [{ label: 'Enhancement Level' }, { label: 'Quantity' }] });
        observerState.handlers['Test-Observer'](modal);

        const inputs = modal.querySelectorAll('input');
        expect(inputs[0].value).toBe(''); // enhancement level untouched
        expect(inputs[1].value).toBe('7'); // quantity filled
    });

    test('fills a typable text quantity input (8/13/2026 marketplace update made the fields text)', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(48);
        manager.initialize();

        // Price is a text input too; the quantity is found among all inputs, not
        // only number ones — the regression was a type="number" selector.
        const modal = buildModal({
            headerText: 'Buy Listing',
            inputs: [
                { label: 'Price', type: 'text' },
                { label: 'Quantity', type: 'text' },
            ],
        });
        observerState.handlers['Test-Observer'](modal);

        const inputs = modal.querySelectorAll('input');
        expect(inputs[1].value).toBe('48');
    });

    test('finds the quantity input by the game row class even when the label is not an ancestor', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(9);
        manager.initialize();

        const modal = buildModal({
            headerText: 'Buy Listing',
            inputs: [
                { rowClass: 'MarketplacePanel_priceInputs', type: 'text' },
                { rowClass: 'MarketplacePanel_quantityInputs', type: 'text' },
            ],
        });
        observerState.handlers['Test-Observer'](modal);

        expect(modal.querySelector('[class*="MarketplacePanel_quantityInputs"] input').value).toBe('9');
    });

    test('initialize() twice registers one observer, not two', () => {
        // The shopping list calls initialize() on every open. Each call used to
        // register another handler and overwrite the unregister for the previous
        // one, so every open leaked a DOM observer that nothing could remove.
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        manager.initialize();
        manager.initialize();

        expect(observerState.registrations).toBe(1);
    });

    test('a re-initialized manager can still be cleaned up completely', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        manager.initialize();
        manager.cleanup();

        expect(observerState.handlers['Test-Observer']).toBeUndefined();
        expect(observerState.unregistrations).toBe(1);
    });

    test('initialize() after cleanup() registers again, so a manager can be restarted', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        manager.cleanup();
        manager.initialize();

        expect(observerState.registrations).toBe(2);
        expect(observerState.handlers['Test-Observer']).toBeTypeOf('function');
    });

    test('cleanup() unregisters the observer and clears quantity', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.setQuantity(3);
        manager.initialize();
        manager.cleanup();

        expect(observerState.handlers['Test-Observer']).toBeUndefined();
        expect(manager.getQuantity()).toBeNull();
    });

    test('the manager whose quantity was set last is the only one that fills', () => {
        // Two features, both watching: one left a lazily recomputed 20 standing
        // (they persist on purpose), the other was just clicked for 400
        const stale = createAutofillManager('Stale-Feature');
        const clicked = createAutofillManager('Clicked-Feature');
        stale.initialize();
        clicked.initialize();
        stale.setPendingCalculation(() => 20);
        clicked.setPendingCalculation(() => 400);

        const modal = buildModal();
        // Observer order used to decide the winner; the stale one runs last here
        observerState.handlers['Clicked-Feature'](modal);
        observerState.handlers['Stale-Feature'](modal);

        expect(modal.querySelector('input').value).toBe('400');
    });

    test('setting a quantity again hands the fill back to that manager', () => {
        const a = createAutofillManager('A');
        const b = createAutofillManager('B');
        a.initialize();
        b.initialize();
        a.setQuantity(20);
        b.setQuantity(400);
        a.setQuantity(7);

        const modal = buildModal();
        observerState.handlers['B'](modal);
        observerState.handlers['A'](modal);

        expect(modal.querySelector('input').value).toBe('7');
    });

    test('a static quantity survives an unrelated modal and fills the buy form that follows', () => {
        const manager = createAutofillManager('Test-Observer');
        manager.initialize();
        manager.setQuantity(25);

        const other = buildModal({ headerText: 'Confirm' });
        observerState.handlers['Test-Observer'](other);
        expect(manager.getQuantity()).toBe(25);

        const buy = buildModal();
        observerState.handlers['Test-Observer'](buy);
        expect(buy.querySelector('input').value).toBe('25');
        expect(manager.getQuantity()).toBeNull();
    });

    test('modalItemHrid reads the item off the modal icon, and null when there is none', () => {
        expect(modalItemHrid(buildModal({ itemHrid: '/items/berserk' }))).toBe('/items/berserk');
        expect(modalItemHrid(buildModal())).toBeNull();
    });

    // A modal draws icons that are not its item — an info badge, a coin, the
    // close ×. The first `<use>` in the modal is whichever the layout happens
    // to put first, and reading one of those as the item produced a confident
    // `/items/<icon-name>` that matched no arming.
    describe('the item icon, not merely the first icon', () => {
        /** @param {HTMLElement} modal @returns {HTMLElement} the same modal, with a decoy icon first */
        const withDecoyIconFirst = (modal) => {
            modal.insertAdjacentHTML('afterbegin', '<svg><use href="/static/media/misc_sprite.svg#info"></use></svg>');
            return modal;
        };

        test('a non-item sprite drawn ahead of the item icon is not mistaken for the item', () => {
            expect(modalItemHrid(withDecoyIconFirst(buildModal({ itemHrid: '/items/berserk' })))).toBe(
                '/items/berserk'
            );
        });

        test('a modal whose only icons are not items names no item, rather than naming the icon', () => {
            expect(modalItemHrid(withDecoyIconFirst(buildModal()))).toBeNull();
        });

        test('an item icon inside the game’s item container is read even off an unfamiliar sheet', () => {
            const modal = buildModal();
            modal.insertAdjacentHTML(
                'beforeend',
                '<div class="Item_itemContainer__x9k"><svg><use href="/sprite.svg#berserk"></use></svg></div>'
            );
            expect(modalItemHrid(modal)).toBe('/items/berserk');
        });

        test('an arming survives a buy box that draws an info icon before the item', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setQuantity(760, { itemHrid: '/items/berserk' });

            const book = withDecoyIconFirst(buildModal({ itemHrid: '/items/berserk' }));
            observerState.handlers['Test-Observer'](book);

            expect(book.querySelector('input').value).toBe('760');
        });
    });

    // The armed-count-outlives-its-errand bug. An ability row armed 760 books
    // with a lazily recomputed constant, which persists by design and was
    // scoped to nothing — so it went on filling every later buy box, for any
    // item, until the page reloaded.
    describe('an arming belongs to one item and one errand', () => {
        test('a buy box for a different item is left alone', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setPendingCalculation(() => 760, { itemHrid: '/items/berserk' });

            const key = buildModal({ headerText: 'Buy Listing', itemHrid: '/items/chimerical_key' });
            observerState.handlers['Test-Observer'](key);

            expect(key.querySelector('input').value).toBe('');
        });

        test('and the arming is retired, so it cannot ambush the buy box after that either', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setPendingCalculation(() => 760, { itemHrid: '/items/berserk' });

            observerState.handlers['Test-Observer'](
                buildModal({ headerText: 'Buy Listing', itemHrid: '/items/chimerical_key' })
            );

            const book = buildModal({ headerText: 'Buy Now', itemHrid: '/items/berserk' });
            observerState.handlers['Test-Observer'](book);
            expect(book.querySelector('input').value).toBe('');
            expect(manager.getQuantity()).toBeNull();
        });

        test('the item it WAS armed for still fills', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setQuantity(760, { itemHrid: '/items/berserk' });

            const book = buildModal({ itemHrid: '/items/berserk' });
            observerState.handlers['Test-Observer'](book);
            expect(book.querySelector('input').value).toBe('760');
        });

        test('a one-shot arming applies exactly once, even to its own item', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setQuantity(760, { itemHrid: '/items/berserk' });

            observerState.handlers['Test-Observer'](buildModal({ itemHrid: '/items/berserk' }));
            const second = buildModal({ itemHrid: '/items/berserk' });
            observerState.handlers['Test-Observer'](second);

            expect(second.querySelector('input').value).toBe('');
        });

        test('an unscoped arming still fills a modal that names no item — the Shop dialog', () => {
            const manager = createAutofillManager('Test-Observer');
            manager.initialize();
            manager.setQuantity(8);

            const modal = buildModal();
            observerState.handlers['Test-Observer'](modal);
            expect(modal.querySelector('input').value).toBe('8');
        });
    });

    test('clearing or cleaning up a manager releases the fill to nobody, not to a stale one', () => {
        const stale = createAutofillManager('Stale');
        const current = createAutofillManager('Current');
        stale.initialize();
        current.initialize();
        stale.setPendingCalculation(() => 20);
        current.setQuantity(400);
        current.clearQuantity();

        const modal = buildModal();
        observerState.handlers['Stale'](modal);
        observerState.handlers['Current'](modal);

        expect(modal.querySelector('input').value).toBe('');
    });
});

/**
 * The buy modal's quantity box, or nothing.
 *
 * The walk used to end by returning the first input, which is the worst guess
 * available rather than a neutral one: that line is only reached once every
 * input has been rejected as an enhancement-level field, so the first input is
 * precisely what the walk was trying to avoid. `buyOneMissingMaterial` presses
 * Buy after filling, so a wrong field there is a wrong order rather than a
 * cosmetic miss.
 */
describe('findQuantityInput refuses rather than guesses', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('a modal whose every input reads as an enhancement level yields nothing', () => {
        const modal = buildModal({
            inputs: [{ label: 'Enhancement Level' }, { label: 'Enhancement Level' }],
        });
        expect(findQuantityInput(modal)).toBeNull();
    });

    test('a labelled quantity field is still found', () => {
        const modal = buildModal({
            inputs: [{ label: 'Enhancement Level' }, { label: 'Quantity' }],
        });
        const inputs = modal.querySelectorAll('input');
        expect(findQuantityInput(modal)).toBe(inputs[1]);
    });

    test('a lone input is still an identification, not a guess', () => {
        const modal = buildModal({ inputs: [{ label: '' }] });
        expect(findQuantityInput(modal)).toBe(modal.querySelector('input'));
    });

    test('the game’s own quantity row still wins outright', () => {
        const modal = buildModal({
            inputs: [{ label: 'Enhancement Level' }, { rowClass: 'MarketplacePanel_quantityInputs__abc' }],
        });
        const inputs = modal.querySelectorAll('input');
        expect(findQuantityInput(modal)).toBe(inputs[1]);
    });
});
