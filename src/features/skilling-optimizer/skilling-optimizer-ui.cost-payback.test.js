/** @vitest-environment happy-dom */
/**
 * Coverage for the Equipment Progression rows' cost / value-for-money line.
 *
 * Before this, a row showed XP and Gold deltas with no price at all, so "which of these should
 * I actually buy" was unanswerable. _makeCostPaybackEl adds the net cost plus two ratios, and
 * has to stay honest in three awkward cases: an upgrade that cannot be priced (reported as
 * unpriced, never as free), a row with no gain on an axis (no ratio, and no division by zero),
 * and an upgrade the sale of the current item pays for outright (said out loud, because the
 * sort ranks exactly that row first).
 *
 * The sort comparator is here too, for the same reason: its awkward cases are the ones this
 * cost line produces — an unpriceable row and a free one both score an infinity, and a
 * difference of two infinities is NaN.
 *
 * Like skilling-optimizer-ui.unpriced-warning.test.js, this exercises the plain instance method
 * directly against happy-dom rather than standing up the whole panel.
 */
import { describe, test, expect } from 'vitest';

import { skillingSimulatorUI } from './skilling-optimizer-ui.js';

const ui = skillingSimulatorUI;

describe('_makeCostPaybackEl', () => {
    test('shows the cost, XP bought per 1M gold, and payback time', () => {
        // 1M cost, +2000 XP/hr and +500 gold/hr → 2K XP/hr per 1M, 2000h payback
        const el = ui._makeCostPaybackEl(1_000_000, 2000, 500, null);
        expect(el.textContent).toContain('Cost: 1.0M');
        expect(el.textContent).toContain('2.0K XP/hr per 1M gold');
        expect(el.textContent).toContain('Payback:');
    });

    test('a row with no gold gain shows no payback rather than dividing by zero', () => {
        const el = ui._makeCostPaybackEl(1_000_000, 2000, 0, null);
        expect(el.textContent).not.toContain('Payback');
        expect(el.textContent).not.toContain('Infinity');
        expect(el.textContent).not.toContain('NaN');
    });

    test('a row with no XP gain shows no XP-per-gold ratio', () => {
        const el = ui._makeCostPaybackEl(1_000_000, 0, 500, null);
        expect(el.textContent).not.toContain('per 1M gold');
        expect(el.textContent).toContain('Payback:');
    });

    test('a row with no gain at all still shows the cost, and no ratios', () => {
        const el = ui._makeCostPaybackEl(1_000_000, 0, 0, null);
        expect(el.textContent).toBe('Cost: 1.0M G');
    });

    test('an unpriceable upgrade says so instead of being costed at zero', () => {
        const el = ui._makeCostPaybackEl(null, 2000, 500, null);
        expect(el.textContent).toContain('unpriced');
        expect(el.textContent).not.toContain('Cost: 0');
        // A price-less row must not claim an infinitely good ratio or an instant payback either
        expect(el.textContent).not.toContain('per 1M gold');
        expect(el.textContent).not.toContain('Payback');
        expect(el.querySelector('span[title]')).not.toBeNull();
    });

    test('a net-zero cost says the sale covers it, because the sort ranks it first', () => {
        // _computeSlotMetrics scores a zero net cost as instant payback and an infinite
        // XP-per-gold ratio, so this row sorts to the top of Payback, Cost and Value.
        // It rendered nothing at all, which put a blank row above every priced one.
        const el = ui._makeCostPaybackEl(0, 2000, 500, null);
        expect(el).not.toBeNull();
        expect(el.textContent).toContain('Cost: free');
        // Still no ratios: both would be Infinity against a zero cost
        expect(el.textContent).not.toContain('per 1M gold');
        expect(el.textContent).not.toContain('Payback');
        expect(el.textContent).not.toContain('Infinity');
    });
});

describe('the slot sort comparator', () => {
    /**
     * A metrics object as _computeSlotMetrics returns one.
     * @param {Object} over - Fields to override
     * @returns {Object}
     */
    const metrics = (over = {}) => ({
        entry: { itemHrid: '/items/x' },
        cost: null,
        xpPct: 0,
        goldPct: 0,
        xpPerMillion: null,
        paybackHours: null,
        ...over,
    });

    /**
     * The order _renderOptimizerResults would draw these slots in.
     * @param {Array<Object>} views - `{index, metrics}` entries
     * @param {string} mode - Sort mode
     * @param {string} [goal] - Skill goal
     * @returns {Array<number>} The indices, in sorted order
     */
    const order = (views, mode, goal = 'xp') =>
        [...views].sort((a, b) => ui._compareSlotViews(a, b, goal, mode)).map((v) => v.index);

    test('unpriceable rows sort last under every cost-denominated mode', () => {
        const views = [
            { index: 0, metrics: metrics() },
            { index: 1, metrics: metrics({ cost: 5_000_000, paybackHours: 40, xpPerMillion: 100 }) },
            { index: 2, metrics: metrics({ cost: 1_000_000, paybackHours: 10, xpPerMillion: 900 }) },
        ];
        for (const mode of ['cost', 'payback', 'value']) {
            expect(order(views, mode)).toEqual([2, 1, 0]);
        }
    });

    test('every row unpriceable keeps slot order rather than an undefined one', () => {
        // Each of these scores Infinity, and Infinity − Infinity is NaN: a comparator
        // that returns NaN is not a total order, and the index tiebreak was never reached.
        const views = [0, 1, 2, 3].map((index) => ({ index, metrics: metrics() }));
        for (const mode of ['cost', 'payback', 'value']) {
            expect(order(views, mode)).toEqual([0, 1, 2, 3]);
        }
    });

    test('two equally free rows keep slot order under the value mode', () => {
        // A zero net cost scores an Infinite xpPerMillion, and -Infinity − -Infinity is NaN too
        const free = metrics({ cost: 0, xpPerMillion: Infinity, paybackHours: 0 });
        const views = [
            { index: 0, metrics: free },
            { index: 1, metrics: metrics({ cost: 1_000_000, xpPerMillion: 900, paybackHours: 10 }) },
            { index: 2, metrics: free },
        ];
        expect(order(views, 'value')).toEqual([0, 2, 1]);
    });

    test('a slot with nothing actionable sorts last whatever the mode', () => {
        const views = [
            { index: 0, metrics: metrics({ entry: null }) },
            {
                index: 1,
                metrics: metrics({ cost: 1_000_000, xpPct: 3, goldPct: 4, xpPerMillion: 900, paybackHours: 10 }),
            },
        ];
        for (const mode of ['cost', 'payback', 'value', 'xpGain', 'goldGain']) {
            expect(order(views, mode)).toEqual([1, 0]);
        }
    });
});
