/**
 * @vitest-environment happy-dom
 *
 * Panel z-index ordering, and the resize re-clamp that keeps a panel
 * reachable after the window it was left in gets smaller.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../core/config.js';
import {
    registerFloatingPanel,
    unregisterFloatingPanel,
    bringPanelToFront,
    isPanelFrontmost,
    cascadedPanelPosition,
    PANEL_Z_CAP,
} from './panel-z-index.js';
import { askChoice } from './choice-dialog.js';

/** A minimal stand-in for a floating panel, positioned and sized like a real one */
function makePanel({ left = 100, top = 100, width = 300, height = 200 } = {}) {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        zIndex: String(config.Z_FLOATING_PANEL),
    });
    // happy-dom does not lay elements out, so getBoundingClientRect has to be
    // told the size a real browser would have computed from the style
    panel.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    });
    document.body.appendChild(panel);
    return panel;
}

describe('PANEL_Z_CAP', () => {
    test('matches the documented cap of Z_FLOATING_PANEL + 99', () => {
        expect(PANEL_Z_CAP).toBe(config.Z_FLOATING_PANEL + 99);
    });
});

describe('a panel that keeps its own z-index', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
    });

    /** @param {HTMLElement} el - Panel @param {Object} [opts] - Registration options */
    function keep(el, opts) {
        registerFloatingPanel(el, opts);
        registered.push(el);
        return el;
    }

    test('the cap-overflow renumber leaves it alone', () => {
        // The overlay: always up, so it deliberately sits below the game's own
        // UI rather than over the tabs and the ability bar
        const overlay = keep(makePanel(), { managedZ: false });
        overlay.style.zIndex = String(config.Z_HUD);

        const a = keep(makePanel());
        const b = keep(makePanel());

        // Enough raises to walk past the cap and force the renumber
        for (let i = 0; i < 120; i += 1) {
            bringPanelToFront(i % 2 ? a : b);
        }

        expect(parseInt(overlay.style.zIndex, 10)).toBe(config.Z_HUD);
        expect(parseInt(a.style.zIndex, 10)).toBeLessThanOrEqual(PANEL_Z_CAP);
        expect(parseInt(b.style.zIndex, 10)).toBeLessThanOrEqual(PANEL_Z_CAP);
    });

    test('is not raised by bringPanelToFront either', () => {
        const overlay = keep(makePanel(), { managedZ: false });
        overlay.style.zIndex = String(config.Z_HUD);

        bringPanelToFront(overlay);

        expect(overlay.style.zIndex).toBe(String(config.Z_HUD));
    });

    test('a docked panel never picks up an inline z-index from the renumber', () => {
        const overlay = keep(makePanel(), { managedZ: false });
        overlay.dataset.docked = 'true';
        overlay.style.zIndex = 'auto';

        const other = keep(makePanel());
        for (let i = 0; i < 120; i += 1) bringPanelToFront(other);

        expect(overlay.style.zIndex).toBe('auto');
    });

    test('re-registering the same element as managed puts it back in the band', () => {
        const panel = keep(makePanel(), { managedZ: false });
        registerFloatingPanel(panel);

        bringPanelToFront(panel);

        expect(parseInt(panel.style.zIndex, 10)).toBeGreaterThan(config.Z_FLOATING_PANEL);
    });
});

describe('bringPanelToFront', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
    });

    test('never raises a panel above PANEL_Z_CAP', () => {
        const panel = makePanel();
        registerFloatingPanel(panel);
        registered.push(panel);

        // Repeated raises used to walk a panel past the cap that the choice
        // dialog assumed it could never reach
        for (let i = 0; i < 150; i++) {
            bringPanelToFront(panel);
        }

        expect(parseInt(panel.style.zIndex, 10)).toBeLessThanOrEqual(PANEL_Z_CAP);
    });
});

describe('choice dialog vs. a raised panel', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
        document.querySelectorAll('body > div').forEach((el) => el.remove());
    });

    test('the dialog backdrop always outranks the highest achievable panel z-index', async () => {
        const panel = makePanel();
        registerFloatingPanel(panel);
        registered.push(panel);

        // Raise it past the point (~10 raises) where it used to overtake the
        // dialog's old fixed z-index of Z_FLOATING_PANEL + 10
        for (let i = 0; i < 50; i++) {
            bringPanelToFront(panel);
        }
        const panelZ = parseInt(panel.style.zIndex, 10);

        const pending = askChoice({ title: 'Delete all history?', choices: [{ value: 'yes', label: 'Yes' }] });
        const backdrop = document.body.lastElementChild;
        const dialogZ = parseInt(backdrop.style.zIndex, 10);

        expect(dialogZ).toBeGreaterThan(panelZ);

        backdrop.querySelector('button').click();
        await pending;
    });
});

describe('window resize re-clamp', () => {
    const registered = [];
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    });

    function resizeWindowTo(width, height) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
        window.dispatchEvent(new Event('resize'));
    }

    /**
     * Register a panel and let the frame-deferred open-time clamp run.
     *
     * Registration clamps too now, a frame later — a panel that opens at a
     * hardcoded corner is off the side of a phone before any resize happens.
     * Under fake timers that frame has to be handed over deliberately, or it
     * lands in the middle of whatever the test does next.
     *
     * @param {HTMLElement} panel - The panel
     */
    function registerAndSettle(panel) {
        registerFloatingPanel(panel);
        registered.push(panel);
        vi.advanceTimersByTime(20);
    }

    test('nudges a panel stranded off-screen back into view after the debounce', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        // Near the right edge of a wide window, and comfortably inside it
        const panel = makePanel({ left: 1200, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);
        expect(panel.style.left).toBe('1200px');

        // Shrink the window so the panel is now well past the right edge
        resizeWindowTo(800, 600);

        // Not yet — the listener is debounced
        expect(panel.style.left).toBe('1200px');

        vi.advanceTimersByTime(250);

        const left = parseFloat(panel.style.left);
        expect(left).toBeLessThan(1200);
        expect(left).toBeLessThanOrEqual(800 - 60);
    });

    test('a panel opening off the side of a narrow window is pulled in on registration', () => {
        // The phone case: nothing was saved and nothing was resized. The panel
        // opens where it was written to open, 80px in from the right of a
        // desktop, and on a 400px screen that is off the side with the close
        // button on it.
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

        const panel = makePanel({ left: 340, top: 80, width: 380, height: 400 });
        registerAndSettle(panel);

        expect(parseFloat(panel.style.left)).toBe(400 - 380);
        expect(panel.style.right).toBe('auto');
    });

    test('leaves a panel alone when it still fits after the resize', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 100, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);

        resizeWindowTo(1400, 900);
        vi.advanceTimersByTime(250);

        expect(panel.style.left).toBe('100px');
        expect(panel.style.top).toBe('100px');
    });

    test('a panel wider than the window it is now in is narrowed to fit', () => {
        // A phone turned back to portrait, or a desktop-sized width restored on
        // one: a panel wider than the screen cannot be resized back, because
        // its resize grip is off the edge.
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 0, top: 40, width: 700, height: 400 });
        registerAndSettle(panel);

        resizeWindowTo(400, 800);
        vi.advanceTimersByTime(250);

        expect(parseFloat(panel.style.width)).toBe(400);
        expect(parseFloat(panel.style.left)).toBe(0);
    });

    test('debounces rapid resize events into a single re-clamp', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 1200, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);

        resizeWindowTo(1000, 900);
        vi.advanceTimersByTime(50);
        resizeWindowTo(800, 900);
        vi.advanceTimersByTime(50);
        resizeWindowTo(700, 900);

        // Only the last resize's debounce window has run out so far
        expect(panel.style.left).toBe('1200px');

        vi.advanceTimersByTime(250);

        const left = parseFloat(panel.style.left);
        expect(left).toBeLessThanOrEqual(700 - 60);
    });
});

describe('isPanelFrontmost', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
    });

    /** @param {Object} [opts] - Registration options @returns {HTMLElement} */
    function keep(opts) {
        const el = makePanel();
        registerFloatingPanel(el, opts);
        registered.push(el);
        return el;
    }

    test('a panel raised over another is the front-most one', () => {
        const under = keep();
        const over = keep();

        bringPanelToFront(over);

        expect(isPanelFrontmost(over)).toBe(true);
        expect(isPanelFrontmost(under)).toBe(false);
    });

    test('raising the buried one puts it in front', () => {
        const a = keep();
        const b = keep();
        bringPanelToFront(b);

        bringPanelToFront(a);

        expect(isPanelFrontmost(a)).toBe(true);
        expect(isPanelFrontmost(b)).toBe(false);
    });

    test('a panel nobody has raised is front-most; the cascade keeps the tie harmless', () => {
        const only = keep();
        keep();

        expect(isPanelFrontmost(only)).toBe(true);
    });

    test('a panel that was never registered is not in front of anything', () => {
        const loose = makePanel();

        expect(isPanelFrontmost(loose)).toBe(false);

        loose.remove();
    });

    test('a panel that keeps its own z-index is not part of the order', () => {
        const overlay = keep({ managedZ: false });
        overlay.style.zIndex = String(config.Z_HUD);

        expect(isPanelFrontmost(overlay)).toBe(false);
    });
});

describe('cascadedPanelPosition', () => {
    const registered = [];
    const viewport = { width: 1400, height: 900 };
    const size = { width: 300, height: 200 };

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
    });

    /** @param {Object} at - `{left, top}` @returns {HTMLElement} */
    function keepAt(at) {
        const el = makePanel({ ...at, ...size });
        registerFloatingPanel(el);
        registered.push(el);
        return el;
    }

    test('the first panel opens at the default corner', () => {
        expect(cascadedPanelPosition(size, viewport)).toEqual({ left: 170, top: 170 });
    });

    test('a second panel does not open on top of the first', () => {
        const first = cascadedPanelPosition(size, viewport);
        keepAt(first);

        const second = cascadedPanelPosition(size, viewport);

        expect(second).not.toEqual(first);
        expect(second.left).toBeGreaterThan(first.left);
        expect(second.top).toBeGreaterThan(first.top);
    });

    test('a third panel clears both of the first two', () => {
        keepAt(cascadedPanelPosition(size, viewport));
        keepAt(cascadedPanelPosition(size, viewport));

        const third = cascadedPanelPosition(size, viewport);

        expect(registered.some((el) => parseFloat(el.style.left) === third.left)).toBe(false);
    });

    test('a panel the user has dragged elsewhere does not push the next one along', () => {
        keepAt({ left: 800, top: 400 });

        expect(cascadedPanelPosition(size, viewport)).toEqual({ left: 170, top: 170 });
    });

    test('the cascade stays on screen rather than walking off the bottom right', () => {
        const small = { width: 600, height: 500 };
        for (let i = 0; i < 20; i++) {
            const at = cascadedPanelPosition(size, small);
            expect(at.left + size.width).toBeLessThanOrEqual(small.width);
            expect(at.top + size.height).toBeLessThanOrEqual(small.height);
            keepAt(at);
        }
    });
});

describe('on-screen keyboard re-clamp', () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;

    afterEach(() => {
        vi.useRealTimers();
        delete window.visualViewport;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
        document.body.replaceChildren();
        vi.resetModules();
    });

    test('a keyboard that window.resize never reports still shortens a panel', async () => {
        // iOS fires no `resize` and does not change `innerHeight` when the
        // keyboard comes up, so the window listener is not merely late here —
        // it never runs at all. Only `visualViewport` sees it.
        const listeners = {};
        const visual = {
            width: 400,
            height: 800,
            scale: 1,
            addEventListener: vi.fn((type, fn) => {
                listeners[type] = fn;
            }),
            removeEventListener: vi.fn(),
        };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

        // A fresh copy, because the subscription is made once at import
        vi.resetModules();
        const fresh = await import('./panel-z-index.js');
        expect(visual.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));

        vi.useFakeTimers();
        const panel = makePanel({ left: 0, top: 0, width: 300, height: 600 });
        fresh.registerFloatingPanel(panel);
        vi.advanceTimersByTime(20);
        expect(panel.style.height).toBe('600px');

        // The keyboard takes the bottom 400px. `innerHeight` is deliberately
        // left alone — that is the whole point of the case.
        visual.height = 400;
        listeners.resize(new Event('resize'));
        vi.advanceTimersByTime(250);

        expect(panel.style.height).toBe('400px');
    });
});
