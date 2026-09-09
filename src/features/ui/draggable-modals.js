/**
 * Draggable Modals
 * Makes game modals draggable and remembers their last position per modal title.
 *
 * DOM structure (confirmed via console inspection):
 *   Modal_modalContainer  — position:fixed, top:0, left:0, full-viewport flex overlay
 *     Modal_background    — dark backdrop
 *     Modal_modal         — visible dialog (display:grid) ← transform applied here
 *       Modal_modalContent
 *         MarketplacePanel_modalContent (display:flex)
 *           MarketplacePanel_header  ← "Buy Now" title lives here
 *           ...fields...
 *       Modal_closeButton
 *
 * Selector: watch 'Modal_modalContent' (not 'Modal_modal') — otherwise the observer
 * also fires for 'Modal_modalContainer' since it contains the same substring.
 *
 * Positioning: transform:translate(dx,dy) on Modal_modal — moves the visual element
 * without touching layout, so backdrop and flex container are completely unaffected.
 */

import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY = 'modalPositions3';
const STORE_NAME = 'settings';

/**
 * Capture a pointer on the element that started tracking it.
 *
 * Without this, a drag ended by releasing the mouse button outside the
 * browser window's content area never reaches any DOM listener — the OS
 * keeps the event, no `pointerup` fires anywhere, and `dragging` never
 * clears. Guarded because a synthetic event in a test, or a pointer type
 * that does not support capture, should not be able to throw out of a
 * pointerdown handler. Mirrors `floating-panel.js`'s helper of the same name.
 * @param {HTMLElement} el - The element that owns this pointer stream
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
 * @param {HTMLElement} el - The element
 * @param {PointerEvent} event - The pointerup or pointercancel ending it
 */
function releaseCapture(el, event) {
    try {
        el.releasePointerCapture?.(event.pointerId);
    } catch {
        // Already released, or never captured — nothing to undo
    }
}

class DraggableModals {
    constructor() {
        this.offsets = {}; // title → { dx, dy }
        this.unregisterObserver = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('draggableModals', true)) return;

        // Taken before the read, checked after it. A `character_switching`
        // teardown landing inside it used to leave a live `Modal_modalContent`
        // observer and `initialized = true` behind. `domObserver` is a
        // singleton a switch does not tear down, so that observer kept firing
        // and modals stayed draggable — the damage was instead that the flag
        // disagreed with the teardown (a `disable()` for the setting being
        // turned off mid-read left the feature running with the registry
        // believing it off) and that `unregisterObserver` holds only the LAST
        // handle, so two switches inside overlapping reads orphaned an
        // observer nothing could ever unregister.
        const ticket = captureOwner(this);
        const stored = await storage.get(STORAGE_KEY, STORE_NAME, {});
        if (!stillOurs(ticket)) return;
        this.offsets = stored || {};

        // Watch Modal_modalContent — unique to the inner dialog content element.
        // Its parentElement is Modal_modal (the box we apply transform to).
        this.unregisterObserver = domObserver.onClass('DraggableModals', 'Modal_modalContent', (contentEl) => {
            const modalBox = contentEl.parentElement;
            if (!modalBox) return;
            // Guard against double-processing (e.g. if observer fires twice)
            if (modalBox.dataset.mwiDraggable) return;
            modalBox.dataset.mwiDraggable = '1';
            this._makeDraggable(modalBox, contentEl);
        });

        this.initialized = true;
    }

    _getTitle(contentEl) {
        // Title is inside the inner content element, not directly in Modal_modal
        const h = contentEl.querySelector('h1, h2, h3, h4, [class*="header"], [class*="Header"]');
        return h?.textContent?.trim().substring(0, 40) || 'modal';
    }

    _applyTransform(modalBox, dx, dy) {
        modalBox.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    /**
     * Clamp an offset so the modal box (at its natural, untransformed rect) stays
     * reachable: the drag bar sits along its top edge, so keeping the top inside
     * the viewport and a strip of width visible is enough to always grab it again.
     * @param {{left: number, top: number, width: number}} naturalRect
     * @param {number} dx
     * @param {number} dy
     * @returns {{dx: number, dy: number}}
     */
    _clampOffset(naturalRect, dx, dy) {
        const minVisible = 60;
        const barHeight = 30;

        const top = naturalRect.top + dy;
        const clampedTop = Math.max(0, Math.min(top, window.innerHeight - barHeight));

        const left = naturalRect.left + dx;
        const clampedLeft = Math.min(Math.max(left, minVisible - naturalRect.width), window.innerWidth - minVisible);

        return { dx: clampedLeft - naturalRect.left, dy: clampedTop - naturalRect.top };
    }

    _makeDraggable(modalBox, contentEl) {
        const title = this._getTitle(contentEl);

        // Inject drag bar into contentEl (Modal_modalContent), not the grid parent.
        // contentEl is a plain wrapper so prepending places the bar at the top visually.
        const bar = document.createElement('div');
        bar.className = 'mwi-drag-bar';
        bar.title = 'Drag to move';
        bar.style.cssText = [
            'width: 100%',
            'padding: 4px 0',
            'text-align: center',
            'cursor: grab',
            'font-size: 11px',
            'color: rgba(255,255,255,0.4)',
            'letter-spacing: 4px',
            'user-select: none',
            'border-bottom: 1px solid rgba(255,255,255,0.08)',
            'box-sizing: border-box',
        ].join(';');
        bar.textContent = '· · · · ·';
        contentEl.insertBefore(bar, contentEl.firstChild);

        // Apply saved offset, healing (and re-saving) one that would put the
        // modal off-screen — a modal type stuck out of reach from a past drag
        if (this.offsets[title]) {
            requestAnimationFrame(() => {
                const { dx, dy } = this.offsets[title];
                const naturalRect = modalBox.getBoundingClientRect();
                const clamped = this._clampOffset(naturalRect, dx, dy);
                this._applyTransform(modalBox, clamped.dx, clamped.dy);
                if (clamped.dx !== dx || clamped.dy !== dy) {
                    this.offsets[title] = clamped;
                    storage.set(STORAGE_KEY, this.offsets, STORE_NAME);
                }
            });
        }

        let dragging = false;
        let startMouseX = 0;
        let startMouseY = 0;
        let startDx = 0;
        let startDy = 0;
        let naturalRect = null;

        const onPointerDown = (e) => {
            if (e.button !== 0) return;
            dragging = true;
            startMouseX = e.clientX;
            startMouseY = e.clientY;

            const t = new DOMMatrix(window.getComputedStyle(modalBox).transform);
            startDx = isNaN(t.m41) ? 0 : t.m41;
            startDy = isNaN(t.m42) ? 0 : t.m42;
            const rect = modalBox.getBoundingClientRect();
            naturalRect = { left: rect.left - startDx, top: rect.top - startDy, width: rect.width };

            bar.style.cursor = 'grabbing';
            e.preventDefault();

            // Attach document listeners only for the duration of the drag
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
            // Captured on the bar so the browser still delivers the matching
            // pointerup here even if the button is released outside the
            // browser window entirely — without capture that release reaches
            // no DOM listener at all, `dragging` never clears, and the modal
            // keeps following every later pointermove.
            captureFrom(bar, e);
        };

        const onPointerMove = (e) => {
            if (!dragging) return;
            const rawDx = startDx + (e.clientX - startMouseX);
            const rawDy = startDy + (e.clientY - startMouseY);
            const { dx, dy } = this._clampOffset(naturalRect, rawDx, rawDy);
            this._applyTransform(modalBox, dx, dy);
        };

        const onPointerUp = (e) => {
            if (!dragging) return;
            dragging = false;
            bar.style.cursor = 'grab';

            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
            releaseCapture(bar, e);

            const t = new DOMMatrix(window.getComputedStyle(modalBox).transform);
            const dx = isNaN(t.m41) ? 0 : t.m41;
            const dy = isNaN(t.m42) ? 0 : t.m42;
            this.offsets[title] = { dx, dy };
            storage.set(STORAGE_KEY, this.offsets, STORE_NAME);
        };

        // A finger works like a cursor, and the bar's gesture is a drag, not a scroll
        bar.style.touchAction = 'none';
        bar.addEventListener('pointerdown', onPointerDown);
    }

    disable() {
        noteTeardown(this);
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this.offsets = {};
        this.initialized = false;
    }
}

const draggableModals = new DraggableModals();

export { draggableModals };

export default {
    name: 'Draggable Modals',
    initialize: () => draggableModals.initialize(),
    cleanup: () => {
        try {
            return draggableModals.disable();
        } catch (error) {
            console.error('[Draggable Modals] Disable failed part-way:', error);
        } finally {
            draggableModals.initialized = false;
        }
    },
};
