/**
 * @vitest-environment happy-dom
 *
 * happy-dom (like jsdom) does not implement `visualViewport`, so every test
 * builds its own fake — a tiny `EventTarget` with the two fields the module
 * reads plus the listener bookkeeping needed to assert on cleanup.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    initVisualViewportTracking,
    VISUAL_VIEWPORT_HEIGHT_PROPERTY,
    VISUAL_VIEWPORT_OFFSET_PROPERTY,
} from './visual-viewport.js';

function fakeViewport({ height = 600, offsetTop = 0 } = {}) {
    const listeners = new Map();
    return {
        height,
        offsetTop,
        addEventListener(type, handler) {
            listeners.set(type, (listeners.get(type) || new Set()).add(handler));
        },
        removeEventListener(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        _fire(type) {
            for (const handler of listeners.get(type) || []) handler();
        },
        _listenerCount(type) {
            return listeners.get(type)?.size ?? 0;
        },
    };
}

let rafCallbacks;

function fakeWindow(viewport) {
    rafCallbacks = [];
    return {
        visualViewport: viewport,
        requestAnimationFrame: (cb) => rafCallbacks.push(cb) && rafCallbacks.length,
        cancelAnimationFrame: vi.fn(),
    };
}

function runFrame() {
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    callbacks.forEach((cb) => cb());
}

beforeEach(() => {
    document.documentElement.style.cssText = '';
});

describe('mirroring the visible viewport', () => {
    test('writes the property on init and again on resize', () => {
        const viewport = fakeViewport({ height: 600 });
        const windowRef = fakeWindow(viewport);

        initVisualViewportTracking({ windowRef, documentRef: document });

        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe('600px');

        viewport.height = 340;
        viewport._fire('resize');
        runFrame();

        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe('340px');
    });

    test('also tracks the offset from scroll, throttled to one write per frame', () => {
        const viewport = fakeViewport({ height: 600, offsetTop: 0 });
        const windowRef = fakeWindow(viewport);

        initVisualViewportTracking({ windowRef, documentRef: document });

        viewport.offsetTop = 120;
        viewport._fire('scroll');
        viewport.offsetTop = 150;
        viewport._fire('scroll');
        // Two events before the frame runs — only the latest value should land,
        // in one write, not two
        expect(rafCallbacks.length).toBe(1);
        runFrame();

        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_OFFSET_PROPERTY)).toBe('150px');
    });

    test('cleanup removes both listeners and both properties', () => {
        const viewport = fakeViewport();
        const windowRef = fakeWindow(viewport);

        const cleanup = initVisualViewportTracking({ windowRef, documentRef: document });
        expect(viewport._listenerCount('resize')).toBe(1);
        expect(viewport._listenerCount('scroll')).toBe(1);

        cleanup();

        expect(viewport._listenerCount('resize')).toBe(0);
        expect(viewport._listenerCount('scroll')).toBe(0);
        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe('');
        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_OFFSET_PROPERTY)).toBe('');
    });

    test('a pending frame is cancelled by cleanup rather than writing after teardown', () => {
        const viewport = fakeViewport();
        const windowRef = fakeWindow(viewport);

        const cleanup = initVisualViewportTracking({ windowRef, documentRef: document });
        viewport._fire('resize');
        expect(rafCallbacks.length).toBe(1);

        cleanup();
        expect(windowRef.cancelAnimationFrame).toHaveBeenCalled();
    });

    test('a browser with no visualViewport is a silent no-op', () => {
        const windowRef = { visualViewport: undefined };

        const cleanup = initVisualViewportTracking({ windowRef, documentRef: document });

        expect(document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_PROPERTY)).toBe('');
        expect(() => cleanup()).not.toThrow();
    });
});
