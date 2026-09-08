/**
 * Mirrors `window.visualViewport` onto CSS custom properties on `<html>`.
 *
 * The layout viewport (`100vh`/`100dvh`, `window.innerHeight`) does not shrink
 * when the mobile on-screen keyboard covers part of the screen — only the
 * *visual* viewport does. A panel sized off the layout viewport therefore
 * renders as if the keyboard were not there, and its bottom (often the close
 * button or a submit control) ends up hidden underneath it. Publishing the
 * visual viewport's height as a CSS variable lets panel styles opt into the
 * value that actually matches what is on screen, with a `100vh` fallback for
 * whenever `visualViewport` does not exist.
 *
 * Adapted from MWITools src/features/mobile-viewport-fix.js, CC-BY-NC-SA-4.0,
 * see third-party/mwitools/.
 */

/** CSS custom property holding the visible viewport's height, in pixels */
export const VISUAL_VIEWPORT_HEIGHT_PROPERTY = '--toolasha-visual-viewport-height';

/** CSS custom property holding how far the visible viewport has scrolled down from the layout viewport's top */
export const VISUAL_VIEWPORT_OFFSET_PROPERTY = '--toolasha-visual-viewport-offset-top';

/**
 * Start mirroring `window.visualViewport` onto the two properties above.
 *
 * Writes are throttled to one per animation frame — `resize` and `scroll` on
 * `visualViewport` can both fire several times as the keyboard animates in,
 * and a style write per event is wasted work the frame budget does not need.
 *
 * A no-op, safely, when `visualViewport` does not exist: older browsers, and
 * every non-mobile test environment that has not mocked it in.
 *
 * @param {Object} [options]
 * @param {Window} [options.windowRef] - Injected for tests
 * @param {Document} [options.documentRef] - Injected for tests
 * @returns {Function} Cleanup — removes the listeners and the properties
 */
export function initVisualViewportTracking({ windowRef = window, documentRef = document } = {}) {
    const viewport = windowRef?.visualViewport;
    const root = documentRef?.documentElement;
    if (!viewport || !root) return () => {};

    let frame = null;

    const write = () => {
        frame = null;
        root.style.setProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY, `${viewport.height}px`);
        root.style.setProperty(VISUAL_VIEWPORT_OFFSET_PROPERTY, `${viewport.offsetTop}px`);
    };

    const schedule = () => {
        if (frame !== null) return;
        if (typeof windowRef.requestAnimationFrame === 'function') {
            frame = windowRef.requestAnimationFrame(write);
        } else {
            frame = windowRef.setTimeout(write, 16);
        }
    };

    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    write();

    return function cleanup() {
        if (frame !== null) {
            if (typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(frame);
            else windowRef.clearTimeout(frame);
            frame = null;
        }
        viewport.removeEventListener('resize', schedule);
        viewport.removeEventListener('scroll', schedule);
        root.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_PROPERTY);
        root.style.removeProperty(VISUAL_VIEWPORT_OFFSET_PROPERTY);
    };
}
