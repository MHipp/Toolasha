/**
 * Floating Panel Z-Index Manager
 * Manages bring-to-front ordering for persistent floating panels.
 * All panels are capped below PANEL_Z_CAP (config.Z_FLOATING_PANEL + 99, i.e. 1199)
 * so they never cross the game's MUI modal layer (~1300).
 */

import config from '../core/config.js';
import { clampPanelToViewport } from './panel-geometry.js';

const panels = new Set();

/**
 * Panels that keep their own z-index.
 *
 * The overlay is the one of these: it is always up, so at rest it deliberately
 * sits at `Z_HUD` — *below* the game's own interactive UI — and rises to the
 * panel band only while it is being arranged. The cap-overflow renumber below
 * rewrites every registered panel from the base upward, which would promote that
 * always-on panel over the game's tabs and ability bar after enough raises in a
 * session, and would stamp an inline z-index on a docked panel that has no
 * business having one. A panel registered with `managedZ: false` is left alone.
 */
const selfManaged = new WeakSet();

/**
 * The highest z-index any registered floating panel may reach.
 *
 * Exported so anything that must sit above every panel — the choice dialog's
 * backdrop, for one — can derive its own z-index from this instead of
 * guessing a number that has to be kept in sync by hand.
 */
export const PANEL_Z_CAP = config.Z_FLOATING_PANEL + 99;

/** How long to wait after the last resize event before re-clamping panels */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * Register a floating panel element for z-index management.
 *
 * Every floating panel in the script comes through here, which makes it the one
 * place a viewport clamp reaches all of them — including the panels that open
 * at a hardcoded corner and never ask `restoreGeometry` for anything. The clamp
 * waits a frame because a panel is commonly registered in the same tick it is
 * appended, and an element the browser has not laid out yet measures as nothing.
 *
 * @param {HTMLElement} el - The panel element
 * @param {Object} [options] - Options
 * @param {boolean} [options.managedZ=true] - `false` for a panel that decides
 *   its own z-index; it still gets the viewport clamp, but is never renumbered
 *   and never raised by {@link bringPanelToFront}
 */
export function registerFloatingPanel(el, { managedZ = true } = {}) {
    panels.add(el);
    if (managedZ) selfManaged.delete(el);
    else selfManaged.add(el);
    afterLayout(() => {
        try {
            if (panels.has(el)) clampPanelToViewport(el);
        } catch (error) {
            console.error('[PanelZIndex] Holding a panel inside the window failed:', error);
        }
    });
}

/**
 * Run something once the browser has had a chance to lay the page out.
 * @param {Function} run - What to run
 */
function afterLayout(run) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
    else setTimeout(run, 0);
}

/**
 * Unregister a floating panel element
 * @param {HTMLElement} el - The panel element
 */
export function unregisterFloatingPanel(el) {
    panels.delete(el);
    selfManaged.delete(el);
}

/**
 * Bring a panel to the front among all registered panels,
 * without exceeding PANEL_Z_CAP.
 * @param {HTMLElement} el - The panel to bring forward
 */
export function bringPanelToFront(el) {
    // A panel that owns its own stacking is not raised by anyone else — the
    // overlay drops back to Z_HUD the moment it is locked again, so a raise here
    // would be undone at best and would leave a docked panel with a stray inline
    // z-index at worst
    if (selfManaged.has(el)) return;

    const base = config.Z_FLOATING_PANEL;
    const cap = PANEL_Z_CAP;

    let maxZ = base;
    for (const p of panels) {
        if (selfManaged.has(p)) continue;
        const z = parseInt(p.style.zIndex) || base;
        if (z > maxZ) maxZ = z;
    }

    const next = maxZ + 1;
    if (next > cap) {
        // Overflow — reassign all from base upward, put el last
        let i = base;
        for (const p of panels) {
            if (p === el || selfManaged.has(p)) continue;
            p.style.zIndex = String(i++);
        }
        el.style.zIndex = String(i);
    } else {
        el.style.zIndex = String(next);
    }
}

/**
 * Whether a panel is the front-most of the registered floating panels.
 *
 * "In front" is the stacking order this module already keeps, asked rather
 * than guessed: a panel is in front when no other managed panel sits at a
 * higher z-index. Panels that manage their own z-index are not part of the
 * order and are not consulted — the overlay in particular sits below the
 * game's UI at rest and would answer for a layer nobody is competing in.
 *
 * Deliberately not a hit-test. Whether one panel visually covers another
 * depends on sizes and positions that are only knowable once the browser has
 * laid the page out, and a wrong answer there is worse than a coarse one: the
 * caller uses this to decide whether a click means "show me" or "put it away".
 * Equal z-indexes therefore count as front-most, which is honest — two panels
 * that have never been raised are ordered by nothing but DOM order.
 *
 * @param {HTMLElement} el - The panel to ask about
 * @returns {boolean} True when nothing managed is stacked above it
 */
export function isPanelFrontmost(el) {
    if (!el || !panels.has(el) || selfManaged.has(el)) return false;

    const base = config.Z_FLOATING_PANEL;
    const mine = parseInt(el.style.zIndex) || base;
    for (const p of panels) {
        if (p === el || selfManaged.has(p)) continue;
        if ((parseInt(p.style.zIndex) || base) > mine) return false;
    }
    return true;
}

/**
 * Nudge every registered panel that is now out of bounds back on screen.
 *
 * A panel remembers where it was left, and a resize does not go through
 * `restoreGeometry` — nothing was re-checking the saved position against a
 * window that has since shrunk, so a panel dragged toward the right edge was
 * stranded off-screen the moment the window got smaller. A phone rotating is
 * the same event, and the reason the size is re-checked here too and not only
 * the position. Only panels that are actually out of bounds are touched, and
 * the result is never persisted — the saved geometry is still what a larger
 * window restores to.
 */
function reclampRegisteredPanels() {
    for (const panel of panels) {
        try {
            clampPanelToViewport(panel);
        } catch (error) {
            console.error('[PanelZIndex] Re-clamping a panel after a resize failed:', error);
        }
    }
}

let resizeTimer = null;

function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reclampRegisteredPanels, RESIZE_DEBOUNCE_MS);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize);
}
