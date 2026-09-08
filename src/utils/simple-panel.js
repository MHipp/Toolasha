/**
 * Simple panel
 *
 * The floating-panel shell, once.
 *
 * Every panel in this script wants the same six things: a header you can drag
 * by, a close button, a scrolling body, a resize grip, a remembered position and
 * a refresh on a timer. Written out per panel that is six chances to open
 * somewhere unreachable, and it has already happened.
 *
 * What differs between panels is only what fills the body, so that is the only
 * thing a caller supplies.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from './panel-z-index.js';
import { makeDraggable, makeResizable } from './floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from './panel-geometry.js';
import { attachMinimize } from './panel-minimize.js';
import { registerEscapeClose } from './panel-escape.js';
import { ROW_COLORS } from './overlay-format.js';

const DEFAULT_REFRESH_MS = 3000;

/**
 * @param {Object} definition - What makes this panel itself
 * @param {string} definition.id - DOM id and geometry key
 * @param {string} definition.title - Header text
 * @param {{width: number, height: number}} definition.size - Opening size
 * @param {Function} definition.draw - `(body, panel) => void`, called each refresh
 * @param {string} [definition.accent] - Header and title colour
 * @param {number} [definition.refreshMs] - How often to redraw
 * @returns {Object} A panel with `show`, `hide` and `toggle`
 */
export function createPanel({ id, title, size, draw, accent = '#8fb4ff', refreshMs = DEFAULT_REFRESH_MS }) {
    let panel = null;
    let bodyEl = null;
    let refreshId = null;
    let detachDrag = null;
    let detachResize = null;
    let minimizeCtl = null;
    let escapeReg = null;

    /** Draw, or say which panel could not be drawn */
    function render() {
        if (!bodyEl) return;
        bodyEl.replaceChildren();

        try {
            draw(bodyEl, panel);
        } catch (error) {
            console.error(`[Panel] ${title} could not be drawn:`, error);
            const failed = document.createElement('div');
            failed.textContent = `This could not be drawn: ${error.message}`;
            failed.style.color = ROW_COLORS.bad;
            bodyEl.appendChild(failed);
        }
    }

    /**
     * The timed redraw, which leaves a control being used alone.
     *
     * A refresh rebuilds the whole body, and rebuilding a `<select>` closes its
     * dropdown. Scroll through a long list of equipment for more than a few
     * seconds and the list shuts under the pointer — which reads as the panel
     * refusing to be used rather than as a redraw. A control the pointer or the
     * keyboard is in is a control somebody is in the middle of.
     *
     * It also leaves alone a panel nobody can see. A hidden tab and a minimized
     * panel both redraw a body that is not on screen; with twenty-odd of these
     * shells alive that is twenty rebuilds a few seconds apart for nothing. Both
     * states end by drawing again — `show`/expand re-renders, and the interval
     * picks the panel back up on the next tick once the tab is visible.
     */
    function refresh() {
        if (document.hidden) return;
        if (minimizeCtl?.collapsed) return;

        const active = document.activeElement;
        const busy = panel?.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
        if (busy) return;

        render();
    }

    /**
     * Whether the panel is on the page, as opposed to merely held.
     *
     * These two are not the same thing, which `show()` has always known and
     * `toggle()` did not: the shell keeps its element in a closure, and anything
     * that detaches that element without going through `hide()` — an outside
     * teardown, or a `create()` that threw before the append — leaves a handle
     * to a panel nobody can see. Asking the document instead of the closure is
     * the difference between a link that opens a panel and one that appears to
     * do nothing at all.
     *
     * @returns {boolean}
     */
    function isOpen() {
        return Boolean(panel && document.body?.contains(panel));
    }

    function create() {
        panel = document.createElement('div');
        panel.id = `toolasha-${id}-panel`;
        Object.assign(panel.style, {
            position: 'fixed',
            top: '170px',
            left: '170px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${size.width}px`,
            height: `${size.height}px`,
            background: 'rgba(14, 16, 22, 0.97)',
            border: `1px solid ${accent}55`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: '#e8ecf5',
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: 'rgba(24, 24, 34, 0.9)',
            borderBottom: `1px solid ${accent}55`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const heading = document.createElement('span');
        heading.textContent = title;
        Object.assign(heading.style, { fontWeight: 'bold', color: accent, flex: '1' });

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: '#e8ecf5',
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            api.hide();
        });

        header.append(heading, close);
        panel.appendChild(header);

        bodyEl = document.createElement('div');
        Object.assign(bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            fontVariantNumeric: 'tabular-nums',
        });
        panel.appendChild(bodyEl);

        minimizeCtl = attachMinimize({
            panel,
            header,
            body: bodyEl,
            panelKey: id,
            beforeEl: close,
            defaultHeight: size.height,
            // Expanding shows a body that stopped refreshing while folded, so
            // it is redrawn on the way out rather than a refresh interval later.
            onToggle: (collapsed) => {
                if (!collapsed) render();
            },
        });

        detachDrag = makeDraggable(panel, header, (position) => {
            saveGeometry(id, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        detachResize = makeResizable(panel, {
            minWidth: 280,
            minHeight: 160,
            onResize: (next) => saveGeometry(id, next),
        });

        document.body.appendChild(panel);
        registerFloatingPanel(panel);
        // Escape closes the panel in front, and a brand-new panel is in front
        escapeReg = registerEscapeClose(() => api.hide());
        restoreGeometry(panel, id, { width: 280, height: 160 });

        render();
        refreshId = setInterval(refresh, refreshMs);
    }

    const api = {
        show({ remember = true } = {}) {
            if (remember) saveOpenState(id, true);
            if (panel && document.body.contains(panel)) {
                bringPanelToFront(panel);
                // Escape's idea of "in front" has to follow the eye's
                escapeReg?.raise();
                return;
            }
            // Held but no longer in the document — torn down rather than
            // abandoned, or its refresh timer and its listeners would still be
            // running and each reopen would leave another set behind
            if (panel) api.hide({ remember: false });

            // A shell that fails half-built must not keep the handle: the next
            // click would read it as an open panel and "close" something that
            // was never on screen, so one failure would kill the control that
            // opens it for the rest of the session.
            try {
                create();
            } catch (error) {
                console.error(`[Panel] ${title} could not be opened:`, error);
                api.hide({ remember: false });
                return;
            }

            // A new panel opens at the base z-index, which is *underneath* every
            // panel that has been raised since the page loaded — so the panel you
            // just asked for appears behind the ones you did not
            bringPanelToFront(panel);
        },
        hide({ remember = true } = {}) {
            if (remember) saveOpenState(id, false);
            clearInterval(refreshId);
            refreshId = null;
            detachDrag?.();
            detachResize?.();
            detachDrag = null;
            detachResize = null;
            minimizeCtl?.destroy();
            minimizeCtl = null;
            escapeReg?.release();
            escapeReg = null;

            if (!panel) return;
            unregisterFloatingPanel(panel);
            panel.remove();
            panel = null;
            bodyEl = null;
        },
        toggle() {
            if (isOpen()) api.hide();
            else api.show();
        },
        render,
        get panel() {
            return panel;
        },
    };
    // Reopen if it was open when the page was last left. Fire and forget, since
    // this is module scope and a storage read has no business holding it up —
    // the panel appears a moment after the rest of the page, which is what a
    // remembered panel looks like anyway.
    reopenIfLeftOpen(id, () => api.show({ remember: false }));

    // And again on every character switch. The open flags are per character, so
    // running this once at module scope meant the panels the *first* character
    // logged in as had left open were the only ones that ever came back. The
    // teardown is the other half and the reason `remember: false` matters: a
    // switch is not the user closing the panel, and recording it as one would
    // write the departing character's arrangement into the arriving character's
    // flags.
    dataManager.on('character_switched', () => {
        api.hide({ remember: false });
        reopenIfLeftOpen(id, () => api.show({ remember: false }));
    });

    return api;
}

/**
 * A titled block to put lines in.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {string} [title] - Heading
 * @param {string} [accent] - Heading colour
 * @returns {HTMLElement}
 */
export function panelCard(body, title, accent = '#8fb4ff') {
    const card = document.createElement('div');
    Object.assign(card.style, {
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        borderRadius: '6px',
        padding: '7px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    });

    if (title) {
        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, { color: accent, fontWeight: 'bold', marginBottom: '3px' });
        card.appendChild(heading);
    }
    body.appendChild(card);
    return card;
}

/**
 * A labelled figure on its own line.
 *
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} [color] - Ink for the value
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement}
 */
export function panelLine(label, value, color = '#e8ecf5', title = '') {
    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });

    const name = document.createElement('span');
    name.textContent = label;
    name.style.color = 'rgba(232, 236, 245, 0.5)';
    name.style.flex = '1';

    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.color = color;
    figure.style.whiteSpace = 'nowrap';

    if (title) line.title = title;
    line.append(name, figure);
    return line;
}

/**
 * Something to say when there is nothing to show.
 * @param {string} text - What to say
 * @returns {HTMLElement}
 */
export function panelNote(text) {
    const note = document.createElement('div');
    note.textContent = text;
    note.style.color = 'rgba(232, 236, 245, 0.5)';
    return note;
}
