/** @vitest-environment happy-dom */
/**
 * Regression coverage for the budget calculator's panel-position observer.
 *
 * `_attachToPanel` starts a MutationObserver per panel to keep the widget
 * pinned after the missing-mats button (which other features can recreate).
 * The observer used to be stashed in a WeakMap keyed by panel, on the theory
 * that GC would take care of tearing it down — but a live MutationObserver is
 * a strong reference the *other* direction (the panel keeps the observer
 * alive, not the reverse), so nothing was ever collected while the panel
 * stayed open, and disable() never actually disconnected anything. What this
 * pins: after disable(), a later mutation on a still-open panel must not
 * bring the widget back.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const world = vi.hoisted(() => ({
    settings: { actions_budgetCalculator: true },
    gameData: null,
    prices: {},
    materials: [],
    /** Every owner id the calculator asked the material calculator under */
    ownerIds: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => world.settings[key] ?? false,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => world.gameData },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => world.prices[hrid] ?? null },
}));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: (_hrid, n, _queue, options) => {
        world.ownerIds.push(options?.ownerId ?? null);
        return world.materials.map((m) => ({
            ...m,
            required: m.perUnit * n,
            missing: Math.max(0, m.perUnit * n - m.have),
        }));
    },
}));

/**
 * The reservation ledger, doubled: what matters at this join is that the
 * calculator asks under its own owner id, claims the required totals while its
 * breakdown is up, and gives them back by every route the modal closes.
 *
 * `reservationsMock` holds the actual `reserve`/`release` implementations behind a
 * mutable indirection, so a single test can swap in a throwing `reserve` (to
 * prove a failure after the claim point still leaves the modal closable and no
 * claim held) and restore the normal one afterward.
 */
const ledger = vi.hoisted(() => ({ reserved: [], released: [] }));
const reservationsMock = vi.hoisted(() => ({
    reserve: async (ownerId, lines) => {
        ledger.reserved.push({ ownerId, lines });
        return true;
    },
    release: async (ownerId) => {
        ledger.released.push(ownerId);
        return true;
    },
}));
vi.mock('../../utils/inventory-reservations.js', () => ({
    reserve: (...args) => reservationsMock.reserve(...args),
    release: (...args) => reservationsMock.release(...args),
}));
vi.mock('../../utils/react-input.js', () => ({
    setReactInputValue: () => {},
}));

const dispatcher = vi.hoisted(() => ({ callback: null }));
vi.mock('../../utils/action-panel-helper.js', () => ({
    onDetailPanel: (cb) => {
        dispatcher.callback = cb;
        return () => {
            dispatcher.callback = null;
        };
    },
    resolveDetailPanel: (panel) => ({
        panel,
        actionHrid: panel.dataset.actionHrid || null,
        actionDetails: panel.dataset.actionHrid
            ? { type: '/action_types/cooking', inputItems: [{ itemHrid: '/items/egg', count: 1 }] }
            : null,
    }),
}));

const { default: budgetCalculator } = await import('./budget-calculator.js');
const { resolveDetailPanel } = await import('../../utils/action-panel-helper.js');

/** A mounted production action panel with a missing-mats-button anchor. */
function mountPanel() {
    const panel = document.createElement('div');
    panel.dataset.actionHrid = '/actions/cooking/omelette';
    const anchor = document.createElement('div');
    anchor.id = 'mwi-missing-mats-button';
    panel.appendChild(anchor);
    document.body.appendChild(panel);
    return panel;
}

beforeEach(() => {
    document.body.innerHTML = '';
    dispatcher.callback = null;
    world.gameData = null;
    world.prices = {};
    world.materials = [];
});

afterEach(() => {
    budgetCalculator.disable();
    vi.restoreAllMocks();
});

describe('budget calculator panel observer teardown', () => {
    test('disable() disconnects the panel observer so it never reinserts the widget again', async () => {
        const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect');

        budgetCalculator.initialize();
        const panel = mountPanel();
        dispatcher.callback(resolveDetailPanel(panel));

        expect(panel.querySelector('#mwi-budget-calculator')).not.toBeNull();

        budgetCalculator.disable();
        expect(disconnectSpy).toHaveBeenCalled();

        // The widget is gone immediately after disable()
        expect(panel.querySelector('#mwi-budget-calculator')).toBeNull();

        // A later mutation on the still-open panel (another feature recreating
        // the missing-mats button) must not resurrect the disabled widget —
        // that would mean the observer kept running past disable().
        panel.querySelector('#mwi-missing-mats-button')?.remove();
        const newAnchor = document.createElement('div');
        newAnchor.id = 'mwi-missing-mats-button';
        panel.appendChild(newAnchor);

        // MutationObserver callbacks flush as a microtask
        await Promise.resolve();
        await Promise.resolve();

        expect(panel.querySelector('#mwi-budget-calculator')).toBeNull();
    });
});

describe('budget calculator unpriced materials', () => {
    const ACTION = '/actions/cooking/omelette';

    /** A production recipe whose second ingredient has no market ask. */
    function stageRecipe() {
        world.gameData = {
            actionDetailMap: {
                [ACTION]: {
                    type: '/action_types/cooking',
                    inputItems: [{ itemHrid: '/items/egg' }, { itemHrid: '/items/truffle' }],
                },
            },
            itemDetailMap: {
                '/items/egg': { isTradable: true },
                '/items/truffle': { isTradable: true },
            },
        };
        world.prices = { '/items/egg': { ask: 10 } };
        world.materials = [
            { itemHrid: '/items/egg', itemName: 'Egg', perUnit: 1, have: 0, isTradeable: true },
            { itemHrid: '/items/truffle', itemName: 'Truffle', perUnit: 1, have: 0, isTradeable: true },
        ];
    }

    /** Click Calculate with a budget and hand back the breakdown modal. */
    function calculate(budget) {
        budgetCalculator.initialize();
        dispatcher.callback(resolveDetailPanel(mountPanel()));
        const ui = document.getElementById('mwi-budget-calculator');
        ui.querySelector('input').value = String(budget);
        ui.querySelector('button').click();
        return document.getElementById('mwi-budget-modal-overlay');
    }

    test('warns that the unit count is an upper bound when a needed material has no price', () => {
        stageRecipe();
        // Only the egg is charged for, so 1000g "affords" 100 omelettes — the truffles are free
        const modal = calculate(1000);
        expect(modal.textContent).toContain('100 units');
        expect(modal.querySelector('#mwi-budget-unpriced-note')).not.toBeNull();
    });

    test('stays quiet when every material a shortfall covers is priced', () => {
        stageRecipe();
        world.prices['/items/truffle'] = { ask: 40 };
        const modal = calculate(1000);
        expect(modal.textContent).toContain('20 units');
        expect(modal.querySelector('#mwi-budget-unpriced-note')).toBeNull();
    });
});

describe('budget calculator breakdown modal Escape listener', () => {
    const ACTION = '/actions/cooking/omelette';

    beforeEach(() => {
        world.gameData = {
            actionDetailMap: {
                [ACTION]: { type: '/action_types/cooking', inputItems: [{ itemHrid: '/items/egg' }] },
            },
            itemDetailMap: { '/items/egg': { isTradable: true } },
        };
        world.prices = { '/items/egg': { ask: 10 } };
        world.materials = [{ itemHrid: '/items/egg', itemName: 'Egg', perUnit: 1, have: 0, isTradeable: true }];
    });

    /** Open the breakdown modal via Calculate and return it. */
    function openModal() {
        budgetCalculator.initialize();
        dispatcher.callback(resolveDetailPanel(mountPanel()));
        const ui = document.getElementById('mwi-budget-calculator');
        ui.querySelector('input').value = '1000';
        ui.querySelector('button').click();
        return document.getElementById('mwi-budget-modal-overlay');
    }

    test('dismissing via the × button removes the document-level Escape listener, not just the overlay', () => {
        const addSpy = vi.spyOn(document, 'addEventListener');
        const removeSpy = vi.spyOn(document, 'removeEventListener');

        const modal = openModal();
        const keydownAdds = addSpy.mock.calls.filter((call) => call[0] === 'keydown').length;
        expect(keydownAdds).toBe(1);

        modal.querySelector('#mwi-budget-modal-close').click();

        const keydownRemoves = removeSpy.mock.calls.filter((call) => call[0] === 'keydown').length;
        expect(keydownRemoves).toBe(1);
    });

    test('opening and closing the modal by mouse repeatedly never grows the document listener count', () => {
        for (let i = 0; i < 5; i++) {
            const modal = openModal();
            modal.querySelector('#mwi-budget-modal-close').click();
        }

        // A stray Escape press after every dismissal must trigger no leftover close() calls
        // beyond whatever the still-open modal (there is none) would need.
        const overlaysBefore = document.querySelectorAll('#mwi-budget-modal-overlay').length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.querySelectorAll('#mwi-budget-modal-overlay').length).toBe(overlaysBefore);
    });

    test('clicking the backdrop also detaches its Escape listener', () => {
        const removeSpy = vi.spyOn(document, 'removeEventListener');
        const overlay = openModal();

        // Dispatched straight on the overlay, so e.target === overlay (a click on the modal
        // content itself would bubble from a descendant and correctly not close it).
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        const keydownRemoves = removeSpy.mock.calls.filter((call) => call[0] === 'keydown').length;
        expect(keydownRemoves).toBe(1);
    });
});

describe('the budget calculator and the reservation ledger', () => {
    const ACTION = '/actions/cooking/omelette';

    beforeEach(() => {
        world.ownerIds = [];
        ledger.reserved = [];
        ledger.released = [];
        reservationsMock.reserve = async (ownerId, lines) => {
            ledger.reserved.push({ ownerId, lines });
            return true;
        };
        reservationsMock.release = async (ownerId) => {
            ledger.released.push(ownerId);
            return true;
        };
        world.gameData = {
            actionDetailMap: {
                [ACTION]: { type: '/action_types/cooking', inputItems: [{ itemHrid: '/items/egg' }] },
            },
            itemDetailMap: { '/items/egg': { isTradable: true } },
        };
        world.prices = { '/items/egg': { ask: 10 } };
        world.materials = [{ itemHrid: '/items/egg', itemName: 'Egg', perUnit: 1, have: 0, isTradeable: true }];
    });

    afterEach(() => {
        budgetCalculator.disable();
        document.body.innerHTML = '';
    });

    /**
     * @param {number} budget - What to type into the box
     * @returns {HTMLElement} The breakdown modal overlay
     */
    function calculate(budget) {
        budgetCalculator.initialize();
        dispatcher.callback(resolveDetailPanel(mountPanel()));
        const ui = document.getElementById('mwi-budget-calculator');
        ui.querySelector('input').value = String(budget);
        ui.querySelector('button').click();
        return document.getElementById('mwi-budget-modal-overlay');
    }

    test('every costing is done under the calculator\u2019s own owner id', () => {
        calculate(1000);
        expect(world.ownerIds.length).toBeGreaterThan(0);
        expect(new Set(world.ownerIds)).toEqual(new Set(['budgetCalculator']));
    });

    test('the open breakdown claims the required totals', () => {
        calculate(1000);
        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'budgetCalculator',
            lines: [{ itemHrid: '/items/egg', count: 100 }],
        });
    });

    test('closing the breakdown via the × button gives the claim back', () => {
        const modal = calculate(1000);
        modal.querySelector('#mwi-budget-modal-close').click();
        expect(ledger.released).toContain('budgetCalculator');
    });

    test('closing the breakdown via the backdrop gives the claim back', () => {
        const overlay = calculate(1000);
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(ledger.released).toContain('budgetCalculator');
    });

    test('closing the breakdown via Escape gives the claim back', () => {
        calculate(1000);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(ledger.released).toContain('budgetCalculator');
    });

    test('a shortfall the bag would have covered names who claimed it', () => {
        world.materials = [
            {
                itemHrid: '/items/egg',
                itemName: 'Egg',
                perUnit: 1,
                have: 500,
                isTradeable: true,
                reservedNote: '80 short — 400 reserved by "Goal: Cheese sword"',
            },
        ];
        const modal = calculate(1000);
        expect(modal.querySelector('#mwi-budget-reserved-note').textContent).toBe(
            'Egg: 80 short — 400 reserved by "Goal: Cheese sword"'
        );
    });

    test('with no claim on the line the modal says nothing about reservations', () => {
        const modal = calculate(1000);
        expect(modal.querySelector('#mwi-budget-reserved-note')).toBeNull();
    });

    test('a throw at the claim point leaves no claim held and the modal still closable', () => {
        // Simulates reserve() writing the ledger entry and then failing before returning —
        // the bug this guards against was claiming *before* the close handlers were wired,
        // so a throw here used to leave the modal stuck open with the claim orphaned: no
        // close route existed yet to run release().
        reservationsMock.reserve = (ownerId, lines) => {
            ledger.reserved.push({ ownerId, lines });
            throw new Error('boom');
        };

        const overlay = calculate(1000);

        // The claim point threw, but the modal must still be on screen and closable.
        expect(overlay).not.toBeNull();
        const closeBtn = overlay.querySelector('#mwi-budget-modal-close');
        expect(closeBtn).not.toBeNull();

        closeBtn.click();

        expect(document.getElementById('mwi-budget-modal-overlay')).toBeNull();
        // Whatever reserve() wrote before throwing must have been given back, not left
        // held with no owner left able to release it.
        expect(ledger.released).toContain('budgetCalculator');
    });
});
