/** @vitest-environment happy-dom
 *
 * The shell three guided walks share, and the two things it was taught to hold
 * still.
 *
 * Both are opt-in, and that is the point of most of what is here: the reroll
 * walk and the Consumables Buy-all draw their own labels of their own widths
 * and were not asking for either. A widget that quietly changed shape in a
 * feature nobody was looking at is exactly the regression this file exists to
 * refuse.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 9000, getSetting: () => false, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../core/storage.js', () => ({ default: { get: async () => null, set: async () => true } }));

const { createFloatingWidget } = await import('./floating-widget.js');

describe('by default the shell is exactly what it was', () => {
    test('the status line still sizes itself to its text', () => {
        const widget = createFloatingWidget({ id: 'plain' });

        expect(widget.status.style.maxWidth).toBe('340px');
        expect(widget.status.style.width).toBe('');
        expect(widget.status.style.flex).toBe('');
    });

    test('the main button is a plain button holding plain text', () => {
        const widget = createFloatingWidget({ id: 'plain' });

        expect(widget.main.style.display).toBe('');
        expect(widget.main.children.length).toBe(0);

        widget.setMainLabel('▶ Next: Cheese (12 left)');

        // What `main.textContent = …` did, so the two walks that write the
        // label straight onto the button are untouched either way
        expect(widget.main.textContent).toBe('▶ Next: Cheese (12 left)');
        expect(widget.main.children.length).toBe(0);
    });

    test('the row is still status, extras, main, gear, close', () => {
        const widget = createFloatingWidget({ id: 'plain' });

        expect([...widget.row.children]).toEqual([
            widget.status,
            widget.extras,
            widget.main,
            widget.gear,
            widget.close,
        ]);
    });
});

describe('a status line asked to hold one width', () => {
    test('takes a fixed slot instead of a maximum', () => {
        const widget = createFloatingWidget({ id: 'fixed', statusWidth: '340px' });

        expect(widget.status.style.width).toBe('340px');
        expect(widget.status.style.flex).toBe('0 0 340px');
        // Still one line with an ellipsis — the fold-out is the caller's job
        expect(widget.status.style.whiteSpace).toBe('nowrap');
        expect(widget.status.style.textOverflow).toBe('ellipsis');
    });
});

describe('a main button sized to the widest label it will ever carry', () => {
    const LABELS = ['▶ Bulk Sell', '⏭ Skip', '▶ Next'];

    test('carries all of them at once, in one grid cell, showing none until told', () => {
        const widget = createFloatingWidget({ id: 'reserved', mainLabels: LABELS });

        expect(widget.main.style.display).toBe('grid');
        expect([...widget.main.children].map((span) => span.dataset.label)).toEqual(LABELS);
        // All stacked in the same cell, so the button is as wide as the widest
        expect([...widget.main.children].every((span) => span.style.gridArea === '1 / 1')).toBe(true);
        expect([...widget.main.children].every((span) => span.style.visibility === 'hidden')).toBe(true);
    });

    test('showing a label hides the others and leaves the reservation alone', () => {
        const widget = createFloatingWidget({ id: 'reserved', mainLabels: LABELS });

        widget.setMainLabel('⏭ Skip');
        expect([...widget.main.children].filter((span) => span.style.visibility === 'visible')).toHaveLength(1);
        expect(widget.main.querySelector('[data-label="⏭ Skip"]').style.visibility).toBe('visible');

        widget.setMainLabel('▶ Next');
        expect(widget.main.querySelector('[data-label="⏭ Skip"]').style.visibility).toBe('hidden');
        expect(widget.main.querySelector('[data-label="▶ Next"]').style.visibility).toBe('visible');
        expect(widget.main.children.length).toBe(LABELS.length);
    });

    test('a label nobody declared is added to the reservation rather than dropped', () => {
        // A new walk state must never leave the button blank, and must never
        // leave it a width the declared labels did not account for
        const widget = createFloatingWidget({ id: 'reserved', mainLabels: LABELS });

        widget.setMainLabel('⏸ Paused');

        expect(widget.main.children.length).toBe(LABELS.length + 1);
        expect(widget.main.querySelector('[data-label="⏸ Paused"]').style.visibility).toBe('visible');

        widget.setMainLabel('▶ Next');
        widget.setMainLabel('⏸ Paused');

        // Declared once, not once per press
        expect(widget.main.children.length).toBe(LABELS.length + 1);
    });

    test('an empty list is no reservation at all', () => {
        const widget = createFloatingWidget({ id: 'reserved', mainLabels: [] });

        widget.setMainLabel('▶ Go');

        expect(widget.main.style.display).toBe('');
        expect(widget.main.textContent).toBe('▶ Go');
    });
});
