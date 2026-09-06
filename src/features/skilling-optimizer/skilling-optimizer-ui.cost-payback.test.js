/** @vitest-environment happy-dom */
/**
 * Coverage for the Equipment Progression rows' cost / value-for-money line.
 *
 * Before this, a row showed XP and Gold deltas with no price at all, so "which of these should
 * I actually buy" was unanswerable. _makeCostPaybackEl adds the net cost plus two ratios, and
 * has to stay honest in three awkward cases: an upgrade that cannot be priced (reported as
 * unpriced, never as free), a row with no gain on an axis (no ratio, and no division by zero),
 * and an upgrade that nets out to nothing (no line at all).
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

    test('a net-zero cost renders nothing at all', () => {
        expect(ui._makeCostPaybackEl(0, 2000, 500, null)).toBeNull();
    });
});
