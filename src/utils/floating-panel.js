/**
 * Floating Panel helpers
 *
 * The drag behaviour every floating panel needs, in one place.
 *
 * Written for the overlay shell, which has to remember where it was left. The
 * PFormance and Treasure panels each carry their own copy of this and could
 * adopt it; they are left alone here because moving working code is a separate
 * change from adding new code.
 */

import { bringPanelToFront } from './panel-z-index.js';
import { markPanelInteracted } from './panel-geometry.js';
import { hasCoarsePointer } from './mobile.js';

/**
 * Capture a pointer on the element that started tracking it.
 *
 * Without this, a drag or resize ended by releasing the mouse button outside
 * the browser window's content area never reaches any DOM listener — the OS
 * keeps the event, no `pointerup` fires anywhere, and whatever flag was
 * tracking "is this still happening" never clears. Capture is what makes the
 * browser keep delivering that pointer's events to this element regardless of
 * what is or is not under the cursor when it happens. Guarded because a
 * synthetic event in a test, or a pointer type that does not support capture,
 * should not be able to throw out of a pointerdown handler.
 *
 * @param {HTMLElement} el - The handle or grip that owns this pointer stream
 * @param {PointerEvent} event - The pointerdown that started it
 */
function captureFrom(el, event) {
    try {
        el.setPointerCapture?.(event.pointerId);
    } catch {
        // A pointer id the browser already dropped, or a target that cannot
        // capture — either way the drag still works via the document
        // listeners, just without the outside-the-window guarantee.
    }
}

/**
 * Let go of a capture taken by {@link captureFrom}.
 *
 * The browser releases capture on its own once the pointer lifts, but not on
 * `pointercancel`, and calling it here regardless costs nothing and leaves no
 * doubt that a cancelled touch does not leave the handle still capturing.
 *
 * @param {HTMLElement} el - The handle or grip
 * @param {PointerEvent} event - The pointerup or pointercancel ending it
 */
function releaseCapture(el, event) {
    try {
        el.releasePointerCapture?.(event.pointerId);
    } catch {
        // Already released, or never captured — nothing to undo
    }
}

/**
 * Whether a press inside a drag handle was aimed at a control rather than the
 * handle itself.
 *
 * Starting a drag is not free: it captures the pointer on the handle and calls
 * `preventDefault()`, and a captured pointer makes the browser dispatch the
 * resulting `click` at the capturing element instead of the thing under the
 * cursor. So a control inside a handle stops receiving clicks at all. That is
 * how the profile card's "breakdown" link came to do nothing — it is a `<span>`
 * in the card's header, the header is the drag handle, and the old test here
 * named only `button, input, select`.
 *
 * Tag names alone cannot answer this: the panels in this script are built from
 * spans as often as buttons, across 28 handles, and each new one is another
 * chance to forget. What every control does say is `cursor: pointer`, against
 * the handle's own `cursor: move` — that is the convention throughout, and it
 * is what the user sees before they press. The handle itself is excluded from
 * the walk so a handle that styles itself as a pointer stays draggable.
 *
 * @param {EventTarget} target - What the press landed on
 * @param {HTMLElement} handle - The drag handle
 * @returns {boolean}
 */
function isHandleControl(target, handle) {
    if (!(target instanceof Element)) return false;
    if (target.closest('button, input, select, textarea, a, [data-drag-ignore]')) return true;

    for (let el = target; el && el !== handle; el = el.parentElement) {
        if (getComputedStyle(el).cursor === 'pointer') return true;
    }
    return false;
}

/**
 * The opening height for a floating panel, capped against the *visible* viewport.
 *
 * `80vh`, `80dvh` and `window.innerHeight` all measure the **layout** viewport,
 * which does not shrink when the mobile on-screen keyboard covers the bottom of
 * the screen. A panel sized off any of them while the keyboard is up therefore
 * renders as if it were not there, and its footer — the close button on most of
 * these panels, a submit control on the rest — ends up underneath it. Only
 * `visualViewport` tracks the keyboard, and `src/utils/visual-viewport.js`
 * publishes its height as `--toolasha-visual-viewport-height`; the `100vh`
 * fallback inside the `var()` covers browsers with no `visualViewport` and any
 * environment where the tracking never started.
 *
 * Nine panels each carried this expression as their own `vh` literal and were
 * missed when the overlay shell was fixed, which is why it is a function now
 * rather than a string to copy. Adapted from MWITools
 * src/features/mobile-viewport-fix.js, CC-BY-NC-SA-4.0, see third-party/mwitools/.
 *
 * @param {number} px - The panel's preferred height, in pixels
 * @param {number} [fraction] - How much of the visible viewport it may take
 * @returns {string} A CSS `height` value
 */
export function panelHeightCap(px, fraction = 0.8) {
    return `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`;
}

/**
 * Let a panel be dragged by one of its parts.
 *
 * Listeners live on the document rather than the handle, because a fast drag
 * outruns the element under the cursor and the panel would be left stuck to the
 * pointer. They are attached on mousedown and removed on mouseup, so nothing
 * stays bound while the panel sits still.
 *
 * @param {HTMLElement} panel - The thing that moves
 * @param {HTMLElement} handle - The part you grab
 * @param {Function} [onDrop] - Called with `{left, top}` once the panel has
 *   actually been moved. A click that never moved is not a drag.
 * @returns {Function} Detaches the handle's listener
 */
export function makeDraggable(panel, handle, onDrop) {
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let moved = false;

    // Pointer events rather than mouse events, so a finger works the same as a
    // cursor — mousedown never fires on a touchscreen and every panel was
    // simply immovable there. touch-action:none is the half that is easy to
    // forget: without it the browser claims the gesture for scrolling and the
    // pointermove stream ends after a few pixels.
    handle.style.touchAction = 'none';

    const onPointerMove = (event) => {
        if (!dragging) return;
        moved = true;
        // Anchored left/top from here on: a panel positioned from the right edge
        // would jump the moment the window is resized
        panel.style.left = `${event.clientX - offsetX}px`;
        panel.style.top = `${event.clientY - offsetY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };

    const onPointerUp = (event) => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);
        releaseCapture(handle, event);

        // A press that never moved is a click, not a drag. Saving one is
        // harmless for a panel that only remembers where it is, and wrong for
        // the Treasure popup, where being moved is how you tell it to stop
        // following the chest dialog — clicking its header once silently
        // pinned it somewhere and auto-placement appeared to stop working.
        if (!moved) return;
        onDrop?.({ left: panel.style.left, top: panel.style.top });
    };

    const onPointerDown = (event) => {
        // Only the primary button, and never a click that was meant for a
        // control sitting in the handle
        if (event.button !== 0 || isHandleControl(event.target, handle)) return;

        bringPanelToFront(panel);
        // Before the panel has moved, so a `restoreGeometry` still waiting on
        // storage knows its answer is stale and does not snap the panel back
        markPanelInteracted(panel);
        dragging = true;
        moved = false;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        // A touch interrupted by the system (notification, palm rejection)
        // cancels rather than lifts; without this the panel stays glued
        document.addEventListener('pointercancel', onPointerUp);
        // Captured on the handle so the browser still delivers the matching
        // pointerup here even if the button is released outside the browser
        // window entirely — without capture that release reaches no DOM
        // listener at all, `dragging` never clears, and the panel keeps
        // following every later pointermove until the next click-drag cycle.
        captureFrom(handle, event);
        event.preventDefault();
    };

    handle.addEventListener('pointerdown', onPointerDown);

    return () => {
        handle.removeEventListener('pointerdown', onPointerDown);
        onPointerUp();
    };
}

/**
 * Give a panel a corner you can drag to resize it.
 *
 * A grip rather than CSS `resize: both`, because the native handle needs the
 * element to scroll its own overflow — these panels hide theirs so the rounded
 * corners stay rounded — and it cannot be styled to be visible against a dark
 * panel. It also gives us the minimums, which the native handle does not
 * enforce below the content size.
 *
 * @param {HTMLElement} panel - The thing that resizes
 * @param {Object} [options] - Options
 * @param {number} [options.minWidth] - Smallest width
 * @param {number} [options.minHeight] - Smallest height
 * @param {Function} [options.onResize] - Called with `{width, height}` once the drag ends
 * @returns {Function} Removes the grip
 */
export function makeResizable(panel, { minWidth = 200, minHeight = 80, onResize } = {}) {
    const grip = document.createElement('div');
    grip.className = 'toolasha-resize-grip';
    grip.title = 'Drag to resize';
    Object.assign(grip.style, {
        position: 'absolute',
        right: '0',
        bottom: '0',
        width: '14px',
        height: '14px',
        cursor: 'nwse-resize',
        // Two hairlines reading as a corner, rather than an icon that would need
        // to be legible against whatever the panel's last row happens to be
        background:
            'linear-gradient(135deg, transparent 0 45%, rgba(158, 196, 255, 0.55) 45% 55%, transparent 55% 72%, ' +
            'rgba(158, 196, 255, 0.55) 72% 82%, transparent 82%)',
        zIndex: '2',
    });

    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let resizing = false;

    // Same pointer-events story as the drag handle; and a 14px grip is a
    // mouse-sized target, so a coarse pointer gets a bigger one
    grip.style.touchAction = 'none';
    if (hasCoarsePointer()) {
        grip.style.width = '26px';
        grip.style.height = '26px';
    }

    const onPointerMove = (event) => {
        if (!resizing) return;
        panel.style.width = `${Math.max(minWidth, startWidth + event.clientX - startX)}px`;
        panel.style.height = `${Math.max(minHeight, startHeight + event.clientY - startY)}px`;
    };

    const onPointerUp = (event) => {
        if (!resizing) return;
        resizing = false;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);
        releaseCapture(grip, event);
        const rect = panel.getBoundingClientRect();
        onResize?.({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        markPanelInteracted(panel);
        resizing = true;
        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
        // Same reasoning as the drag handle: without this, releasing the
        // mouse outside the window mid-resize leaves `resizing` stuck true
        captureFrom(grip, event);
        event.preventDefault();
        event.stopPropagation();
    };

    grip.addEventListener('pointerdown', onPointerDown);
    panel.appendChild(grip);

    return () => {
        grip.removeEventListener('pointerdown', onPointerDown);
        onPointerUp();
        grip.remove();
    };
}

// A `clampToViewport` lived here and had no callers. Panels are clamped by
// `panel-geometry.js` on restore and by the overlay's own `_clampToViewport`,
// both of which keep the whole panel on screen; this one kept a 40px strip of
// it, on the reasoning that a strip is enough to grab and drag back. Nothing
// agreed, so it was two rules and one of them was never applied.
