/** @vitest-environment happy-dom
 *
 * Dragging a panel by its header, with whatever pointer the device has.
 *
 * Two things live here. The click-versus-drag distinction: `onDrop` is how a
 * panel records where it was put, and for the Treasure popup also how it is
 * told to stop following the chest dialog, so firing it on a press that never
 * moved silently pinned the popup. And the event model: every drag used mouse
 * events, and mousedown never fires on a touchscreen — every panel was simply
 * immovable on a phone. These tests drive the drags with pointer events and
 * would fail against the mouse-event code outright.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('./panel-z-index.js', () => ({ bringPanelToFront: () => {} }));
vi.mock('./mobile.js', () => ({ hasCoarsePointer: vi.fn(() => false) }));

// The real one lives in IndexedDB; only the interaction stamp is wanted here
const grabbed = vi.hoisted(() => vi.fn());
vi.mock('./panel-geometry.js', () => ({ markPanelInteracted: grabbed }));

const { makeDraggable, makeResizable } = await import('./floating-panel.js');
const { hasCoarsePointer } = await import('./mobile.js');

let panel;
let handle;
let dropped;

beforeEach(() => {
    document.body.innerHTML = '<div id="panel"><div id="handle"></div></div>';
    panel = document.getElementById('panel');
    handle = document.getElementById('handle');
    panel.style.left = '100px';
    panel.style.top = '100px';
    dropped = vi.fn();
    makeDraggable(panel, handle, dropped);
});

const press = (x, y) => handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: x, clientY: y }));
const move = (x, y) => document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
const release = () => document.dispatchEvent(new MouseEvent('pointerup'));
const interrupt = () => document.dispatchEvent(new MouseEvent('pointercancel'));

describe('what counts as having been moved', () => {
    test('a drag reports where it ended', () => {
        press(120, 120);
        move(200, 180);
        release();

        expect(dropped).toHaveBeenCalledTimes(1);
        expect(panel.style.left).not.toBe('100px');
        expect(dropped.mock.calls[0][0]).toEqual({ left: panel.style.left, top: panel.style.top });
    });

    test('a click on the header is not a drag', () => {
        // It used to be. The Treasure popup reads `onDrop` as "stay here", so
        // one click on its header stopped it following the chest dialog.
        press(120, 120);
        release();

        expect(dropped).not.toHaveBeenCalled();
    });

    test('and a second press after a drag starts from not-moved again', () => {
        press(120, 120);
        move(200, 180);
        release();
        dropped.mockClear();

        press(220, 200);
        release();

        expect(dropped).not.toHaveBeenCalled();
    });

    test('a press on a control in the header does not drag at all', () => {
        handle.innerHTML = '<button id="close"></button>';
        document
            .getElementById('close')
            .dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true, clientX: 1, clientY: 1 }));
        move(300, 300);
        release();

        expect(dropped).not.toHaveBeenCalled();
        expect(panel.style.left).toBe('100px');
    });
});

describe('a finger as the pointer', () => {
    test('the handle opts out of the browser scroll gesture', () => {
        // Without touch-action:none the browser claims the gesture for
        // scrolling and the pointermove stream ends after a few pixels
        expect(handle.style.touchAction).toBe('none');
    });

    test('an interrupted touch releases the panel rather than gluing it on', () => {
        // A system notification cancels the pointer instead of lifting it
        press(120, 120);
        interrupt();
        const before = panel.style.left;

        move(500, 500);

        expect(panel.style.left).toBe(before);
    });
});

describe('pointer capture, so a release outside the browser window still ends the drag', () => {
    // Without capture, a mouse button released while the cursor is outside the
    // browser window never reaches the document at all — no pointerup fires,
    // `dragging` stays true forever, and the panel keeps following every
    // pointermove for the rest of the session. Capturing the pointer on the
    // handle is what makes the browser still deliver that pointerup to it.
    test('taking hold of the header captures the pointer', () => {
        const capture = vi.spyOn(handle, 'setPointerCapture');

        press(120, 120);

        expect(capture).toHaveBeenCalled();
    });

    test('releasing ends the capture', () => {
        const release_ = vi.spyOn(handle, 'releasePointerCapture');

        press(120, 120);
        move(200, 180);
        release();

        expect(release_).toHaveBeenCalled();
    });

    test('a cancelled touch ends the capture too', () => {
        const release_ = vi.spyOn(handle, 'releasePointerCapture');

        press(120, 120);
        interrupt();

        expect(release_).toHaveBeenCalled();
    });

    test('the resize grip captures its own pointer the same way', () => {
        panel.getBoundingClientRect = () => ({ left: 100, top: 100, width: 300, height: 200, right: 400, bottom: 300 });
        makeResizable(panel, { minWidth: 100, minHeight: 50 });
        const grip = panel.lastElementChild;
        const capture = vi.spyOn(grip, 'setPointerCapture');

        grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));

        expect(capture).toHaveBeenCalled();
    });
});

describe('the resize grip', () => {
    test('resizes by pointer', () => {
        panel.getBoundingClientRect = () => ({ left: 100, top: 100, width: 300, height: 200, right: 400, bottom: 300 });
        makeResizable(panel, { minWidth: 100, minHeight: 50 });
        const grip = panel.lastElementChild;

        grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));
        document.dispatchEvent(new MouseEvent('pointermove', { clientX: 460, clientY: 330 }));
        document.dispatchEvent(new MouseEvent('pointerup'));

        expect(panel.style.width).toBe('360px');
        expect(panel.style.height).toBe('230px');
    });

    test('and is finger-sized on a coarse pointer', () => {
        // 14px is a mouse target; on a touchscreen the grip is the feature
        hasCoarsePointer.mockReturnValue(true);
        makeResizable(panel, {});

        expect(panel.lastElementChild.style.width).toBe('26px');
        hasCoarsePointer.mockReturnValue(false);
    });
});

describe('telling a slow geometry restore that it is out of date', () => {
    test('taking hold of the header stamps the panel', () => {
        grabbed.mockClear();

        press(120, 120);

        expect(grabbed).toHaveBeenCalledWith(panel);
    });

    test('a press on a control in the header is not taking hold of the panel', () => {
        grabbed.mockClear();

        const button = document.createElement('button');
        handle.appendChild(button);
        button.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 120, clientY: 120, bubbles: true }));

        expect(grabbed).not.toHaveBeenCalled();
    });

    test('taking hold of the resize grip stamps it too', () => {
        grabbed.mockClear();

        makeResizable(panel, {});
        const grip = panel.querySelector('.toolasha-resize-grip');
        grip.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));

        expect(grabbed).toHaveBeenCalledWith(panel);
    });
});

/**
 * A control sitting in a drag handle must keep receiving clicks.
 *
 * Starting a drag captures the pointer on the handle, and a captured pointer
 * makes the browser dispatch the resulting `click` at the capturing element
 * rather than the thing under the cursor — so a control inside a handle stops
 * being clickable at all. The profile card's "breakdown" link is a `<span>` in
 * the card's header, the header is the handle, and the old guard named only
 * `button, input, select`: pressing it dragged the card and the link did
 * nothing. These pin the rule that fixed it.
 */
describe('a press aimed at a control in the handle is not a drag', () => {
    const pressOn = (el, x = 200, y = 200) =>
        el.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true }));

    // Whether the press started a drag. Judged by the interaction stamp, which
    // `onPointerDown` writes only once it has decided this is a drag — the
    // panel's own position cannot say, since a zero-sized rect in this
    // environment makes the computed offset cancel the movement exactly.
    const dragStarted = () => {
        const started = grabbed.mock.calls.length > 0;
        move(300, 300);
        release();
        return started;
    };

    beforeEach(() => grabbed.mockClear());

    test('a span that styles itself as clickable is a control, not drag surface', () => {
        handle.innerHTML = '<span id="link" style="cursor: pointer;">breakdown</span>';
        pressOn(document.getElementById('link'));
        expect(dragStarted()).toBe(false);
    });

    test('a control nested inside a clickable span counts too', () => {
        handle.innerHTML = '<span style="cursor: pointer;"><span id="inner">x</span></span>';
        pressOn(document.getElementById('inner'));
        expect(dragStarted()).toBe(false);
    });

    test('a real button is still a control', () => {
        handle.innerHTML = '<button id="btn">x</button>';
        pressOn(document.getElementById('btn'));
        expect(dragStarted()).toBe(false);
    });

    test('anything marked as not-drag-surface is a control whatever it looks like', () => {
        handle.innerHTML = '<span id="tagged" data-drag-ignore="">x</span>';
        pressOn(document.getElementById('tagged'));
        expect(dragStarted()).toBe(false);
    });

    test('the bare handle still drags', () => {
        press(200, 200);
        expect(dragStarted()).toBe(true);
    });

    test('a handle that styles itself as a pointer still drags', () => {
        // The walk stops at the handle, so a handle's own cursor cannot disarm it
        handle.style.cursor = 'pointer';
        press(200, 200);
        expect(dragStarted()).toBe(true);
    });

    test('plain text in the handle still drags', () => {
        handle.innerHTML = '<span id="label" style="cursor: move;">Build Score</span>';
        pressOn(document.getElementById('label'));
        expect(dragStarted()).toBe(true);
    });
});
