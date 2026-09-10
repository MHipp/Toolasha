/** @vitest-environment happy-dom */
/**
 * Tests for DOM Utilities Module — the branching helpers, not the pure DOM
 * construction wrappers (createStyledDiv/Span are simple pass-throughs).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/config.js', () => ({
    default: {
        SCRIPT_COLOR_MAIN: '#111111',
        SCRIPT_COLOR_TOOLTIP: '#222222',
        SCRIPT_COLOR_ALERT: '#333333',
    },
}));

const {
    createColoredText,
    insertBefore,
    insertAfter,
    removeElements,
    getOriginalText,
    addStyles,
    removeStyles,
    dismissTooltips,
} = await import('./dom.js');

beforeEach(() => {
    document.body.innerHTML = '';
    document.head.querySelectorAll('style').forEach((s) => s.remove());
});

describe('createColoredText', () => {
    test('uses the main color by default', () => {
        const span = createColoredText('hello');
        expect(span.style.color).toBe('#111111');
        expect(span.textContent).toBe('hello');
    });

    test('resolves tooltip and alert color types', () => {
        expect(createColoredText('x', 'tooltip').style.color).toBe('#222222');
        expect(createColoredText('x', 'alert').style.color).toBe('#333333');
    });

    test('falls back to main color for an unrecognized type', () => {
        expect(createColoredText('x', 'bogus').style.color).toBe('#111111');
    });
});

describe('insertBefore / insertAfter', () => {
    test('inserts a new element immediately before the reference', () => {
        const parent = document.createElement('div');
        const ref = document.createElement('span');
        parent.appendChild(ref);
        document.body.appendChild(parent);

        const newEl = document.createElement('b');
        insertBefore(newEl, ref);

        expect(Array.from(parent.children)).toEqual([newEl, ref]);
    });

    test('inserts a new element immediately after the reference', () => {
        const parent = document.createElement('div');
        const ref = document.createElement('span');
        parent.appendChild(ref);
        document.body.appendChild(parent);

        const newEl = document.createElement('b');
        insertAfter(newEl, ref);

        expect(Array.from(parent.children)).toEqual([ref, newEl]);
    });

    test('warns and does nothing when the reference has no parent', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const detached = document.createElement('span');
        expect(() => insertBefore(document.createElement('b'), detached)).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});

describe('removeElements', () => {
    test('removes every element matching the selector and returns the count', () => {
        document.body.innerHTML = '<div class="x"></div><div class="x"></div><div class="y"></div>';
        const count = removeElements('.x');
        expect(count).toBe(2);
        expect(document.querySelectorAll('.x')).toHaveLength(0);
        expect(document.querySelectorAll('.y')).toHaveLength(1);
    });

    test('returns 0 when nothing matches', () => {
        expect(removeElements('.nonexistent')).toBe(0);
    });
});

describe('getOriginalText', () => {
    test('strips injected spans before reading text content', () => {
        const el = document.createElement('div');
        el.innerHTML = 'Base <span class="insertedSpan">EXTRA</span> text';
        expect(getOriginalText(el)).toBe('Base  text');
    });

    test('strips script-injected elements too', () => {
        const el = document.createElement('div');
        el.innerHTML = 'Base<div class="script-injected">EXTRA</div>';
        expect(getOriginalText(el)).toBe('Base');
    });

    test('returns empty string for a null element', () => {
        expect(getOriginalText(null)).toBe('');
    });

    test('does not mutate the original element', () => {
        const el = document.createElement('div');
        el.innerHTML = 'Base <span class="insertedSpan">EXTRA</span>';
        getOriginalText(el);
        expect(el.querySelector('.insertedSpan')).not.toBeNull();
    });
});

describe('addStyles / removeStyles', () => {
    test('adds a style element with the given id and CSS', () => {
        addStyles('.foo { color: red; }', 'my-style');
        const style = document.getElementById('my-style');
        expect(style).not.toBeNull();
        expect(style.textContent).toBe('.foo { color: red; }');
    });

    test('removeStyles removes the style element by id', () => {
        addStyles('.foo {}', 'my-style');
        removeStyles('my-style');
        expect(document.getElementById('my-style')).toBeNull();
    });

    test('removeStyles does nothing when the id does not exist', () => {
        expect(() => removeStyles('nonexistent')).not.toThrow();
    });

    test('an id is written once however many times its caller runs', () => {
        // Every caller re-runs on a character switch. Appending each time left
        // one dead sheet per switch in the head, for the life of the tab.
        for (let i = 0; i < 5; i++) addStyles('.foo { color: red; }', 'repeat-style');
        expect(document.querySelectorAll('#repeat-style').length).toBe(1);
    });

    test('running again with new CSS rewrites the sheet rather than skipping it', () => {
        addStyles('.foo { color: red; }', 'themed-style');
        addStyles('.foo { color: blue; }', 'themed-style');
        expect(document.querySelectorAll('#themed-style').length).toBe(1);
        expect(document.getElementById('themed-style').textContent).toBe('.foo { color: blue; }');
    });

    test('without an id every call still appends, since nothing identifies the sheet', () => {
        const before = document.querySelectorAll('head style').length;
        addStyles('.bar { color: red; }');
        addStyles('.bar { color: red; }');
        expect(document.querySelectorAll('head style').length).toBe(before + 2);
    });
});

describe('dismissTooltips', () => {
    test('dispatches mouseleave/mouseout on the trigger for each visible tooltip', () => {
        const trigger = document.createElement('div');
        trigger.setAttribute('aria-describedby', 'tt-1');
        document.body.appendChild(trigger);

        const tooltip = document.createElement('div');
        tooltip.className = 'MuiTooltip-popper';
        tooltip.id = 'tt-1';
        document.body.appendChild(tooltip);

        const leaveSpy = vi.fn();
        trigger.addEventListener('mouseleave', leaveSpy);

        dismissTooltips();

        expect(leaveSpy).toHaveBeenCalledTimes(1);
    });

    test('does nothing when there are no tooltip poppers', () => {
        expect(() => dismissTooltips()).not.toThrow();
    });
});
