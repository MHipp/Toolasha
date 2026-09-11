/**
 * Panel Geometry
 *
 * Where a floating panel was left, and how big it was left.
 *
 * Every panel in this script had its own answer to this, which is to say most of
 * them had none: they opened at a hardcoded corner at a hardcoded width, and a
 * panel you have to drag and resize on every page load is a panel you stop
 * opening. One store, keyed by panel, so a new panel gets the behaviour by
 * calling one function.
 *
 * The clamping is the part worth having apart from the DOM. A panel remembers
 * the window it was left in, and that window may since have been narrower — a
 * saved position restored blindly puts the panel somewhere you cannot reach it,
 * which looks exactly like a feature that stopped working.
 *
 * Geometry is deliberately shared by every character on the account: a panel
 * should sit where you put it whichever character you logged in as. Whether a
 * panel was *open* is not — the market character's eight open panels reopening
 * on top of the iron cow is the one part of this that is per-character, and it
 * lives in its own key, `panelOpenState_<characterId>`.
 */

import storage from '../core/storage.js';
import dataManager from '../core/data-manager.js';
import { characterKey, readScoped } from './character-key.js';

const STORAGE_KEY = 'panelGeometry';
/** Per-character open flags: `{ [panelKey]: boolean }` */
const OPEN_KEY = 'panelOpenState';

/** Cache of every panel's geometry, so opening a panel does not wait on storage */
let cache = null;
let loading = null;

/**
 * Open flags per scoped key, so switching characters loads the new set rather
 * than reusing the old one — the key is derived at read time, never at import.
 */
const openCache = new Map();
const openLoading = new Map();

/** Enough of a panel to see and grab, when the whole of it cannot be shown */
const EDGE_KEEP = 30;

/**
 * How many times each panel has been grabbed, so a slow restore can tell whether
 * it is still describing the panel it was called about.
 *
 * `restoreGeometry` is called and not awaited, and what it waits on is an
 * IndexedDB read. On a cold database that read can land seconds after the panel
 * opened — long enough for the panel to have been dragged somewhere and resized
 * — and it then writes the *stored* left/top/width/height over the top, so the
 * panel jumps back under the pointer and the drag reads as having been refused.
 * A counter rather than a flag: a panel opened, dragged, closed and reopened is
 * a fresh restore that should apply again, and the counter compares only against
 * the value taken when this particular call started.
 */
const interactions = new WeakMap();

/**
 * Note that the user has just taken hold of a panel.
 *
 * Called by the drag and resize handles on pointerdown, which is before the
 * panel has actually moved — taking hold of it is already enough to say that
 * whatever storage is about to answer is out of date.
 *
 * @param {HTMLElement} panel - The panel being grabbed
 */
export function markPanelInteracted(panel) {
    if (!panel) return;
    interactions.set(panel, (interactions.get(panel) || 0) + 1);
}

/**
 * @param {HTMLElement} panel - The panel
 * @returns {number} How many times it has been grabbed
 */
function interactionCount(panel) {
    return (panel && interactions.get(panel)) || 0;
}

/**
 * Hold a saved geometry inside the current window.
 *
 * Size is capped at the viewport, since a panel restored wider than the screen
 * cannot be resized back — its resize grip is off the edge. Position then puts
 * the panel *fully* on screen rather than merely leaving a strip of it: the
 * close button lives at the top right of every panel here, and a panel hanging
 * off the right edge of a phone is one you cannot close. Only a panel bigger
 * than the window falls back to showing as much as there is room for.
 *
 * @param {Object} geometry - `{left, top, width, height}` in pixels
 * @param {{width: number, height: number}} viewport - The window
 * @param {{width: number, height: number}} [min] - Smallest allowed size
 * @returns {Object|null} A usable geometry, or null when there is nothing to use
 */
export function clampGeometry(geometry, viewport, min = { width: 200, height: 80 }) {
    if (!geometry) return null;

    const result = {};

    // A minimum wider than the screen is not a minimum, it is the bug it was
    // written to prevent: the Treasure panel asks for 420px back on a 400px
    // phone and comes back wider than the phone.
    const minWidth = Math.min(min.width, viewport.width);
    const minHeight = Math.min(min.height, viewport.height);

    const width = Number(geometry.width);
    const height = Number(geometry.height);
    if (Number.isFinite(width)) {
        result.width = Math.max(minWidth, Math.min(width, viewport.width));
    }
    if (Number.isFinite(height)) {
        result.height = Math.max(minHeight, Math.min(height, viewport.height));
    }

    const left = Number(geometry.left);
    const top = Number(geometry.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
        // What the panel will actually occupy once the size above is applied
        const boxWidth = Math.min(result.width ?? minWidth, viewport.width);
        const boxHeight = Math.min(result.height ?? EDGE_KEEP, viewport.height);
        result.left = Math.min(Math.max(left, 0), Math.max(0, viewport.width - boxWidth));
        result.top = Math.min(Math.max(top, 0), Math.max(0, viewport.height - boxHeight));
    }

    return Object.keys(result).length ? result : null;
}

/**
 * The window as much of it as is actually visible.
 *
 * `window.innerHeight` is the *layout* viewport, and iOS does not shrink it
 * when the on-screen keyboard comes up — it does not even fire `resize`. A
 * clamp measured against it therefore concludes every panel still fits at the
 * exact moment half the screen has just been taken away. `visualViewport` is
 * the only thing that sees the keyboard, which is why the CSS height cap
 * (`panelHeightCap` in `floating-panel.js`) is written against it too.
 *
 * Pinch-zoom shrinks `visualViewport` as well, and unlike the keyboard it is
 * not a reason to permanently shrink a panel — the clamp writes inline styles
 * that do not come back when the zoom does. `scale` is how the two are told
 * apart: the keyboard leaves it at 1.
 *
 * @returns {{width: number, height: number}} Pixels
 */
function visibleViewport() {
    const layout = { width: window.innerWidth, height: window.innerHeight };
    const visual = window.visualViewport;
    if (!visual || !(visual.height > 0) || !(visual.width > 0)) return layout;
    if (Number.isFinite(visual.scale) && visual.scale > 1.01) return layout;
    return { width: Math.min(layout.width, visual.width), height: Math.min(layout.height, visual.height) };
}

/**
 * Hold a panel that is already on screen inside the window it is on screen in.
 *
 * The saved-geometry clamp only ever ran on what was *stored*, so a panel that
 * had never been moved opened wherever it was written to open — 80px in from
 * the right of a desktop, which on a 400px phone is off the side — and stayed
 * there. This measures the panel as it stands instead, which covers the default
 * position, a width in `vw` that still overflows, and a window that has since
 * been resized, with one rule.
 *
 * Nothing is touched unless it is out of bounds: a panel that fits keeps sizing
 * and anchoring itself however it likes. Anchoring is what the two guards are
 * about — an absolutely positioned panel measures from its offset parent, and a
 * centred one is offset by its own transform, so a viewport-relative `left`
 * would move either of them somewhere nobody asked for.
 *
 * @param {HTMLElement} panel - The panel, already in the document
 * @param {{width: number, height: number}} [min] - Smallest allowed size
 * @returns {Object|null} What was changed, or null when nothing needed to be
 */
export function clampPanelToViewport(panel, min) {
    if (typeof window === 'undefined' || !panel?.isConnected) return null;

    const viewport = visibleViewport();
    if (!(viewport.width > 0) || !(viewport.height > 0)) return null;

    if (typeof getComputedStyle === 'function') {
        const computed = getComputedStyle(panel);
        if (computed.position !== 'fixed') return null;
        if (computed.transform && computed.transform !== 'none') return null;
    }

    const rect = panel.getBoundingClientRect();
    // Not laid out yet — in a test DOM it never will be, and guessing at a
    // position from zeroes would move every panel to the top left corner
    if (!(rect.width > 0) && !(rect.height > 0)) return null;

    const clamped = clampGeometry(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport,
        min
    );
    if (!clamped) return null;

    const applied = {};
    if (rect.width > viewport.width && clamped.width) {
        panel.style.width = `${clamped.width}px`;
        applied.width = clamped.width;
    }
    // The same for height, and for the same reason: the position clamp below can
    // only push `top` as far as 0, so a panel taller than the window keeps
    // hanging off the bottom however far up it is moved — and its footer is
    // where the close button is. Shrinking is the only thing that gets it back.
    if (rect.height > viewport.height && clamped.height) {
        panel.style.height = `${clamped.height}px`;
        applied.height = clamped.height;
    }
    if (Math.round(clamped.left) !== Math.round(rect.left) || Math.round(clamped.top) !== Math.round(rect.top)) {
        panel.style.left = `${clamped.left}px`;
        panel.style.top = `${clamped.top}px`;
        // Anchored from the left from here on; a panel positioned from the right
        // edge would jump the moment the window is resized
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        applied.left = clamped.left;
        applied.top = clamped.top;
    }

    return Object.keys(applied).length ? applied : null;
}

/**
 * Every panel's saved geometry.
 * @returns {Promise<Object>} `{ [panelKey]: geometry }`
 */
export async function allGeometry() {
    // Module-scope callers run before the database is open, and an unguarded
    // read there comes back with the default — indistinguishable from nothing
    // having been stored
    await storage.ready;
    if (cache) return cache;
    if (!loading) {
        loading = storage
            .getJSON(STORAGE_KEY, 'settings', {})
            .then((saved) => {
                cache = saved || {};
                return cache;
            })
            .catch((error) => {
                console.error('[PanelGeometry] Loading saved geometry failed:', error);
                cache = {};
                return cache;
            });
    }
    return loading;
}

/**
 * Remember a panel's geometry.
 * @param {string} panelKey - Which panel
 * @param {Object} geometry - `{left, top, width, height}`
 */
export async function saveGeometry(panelKey, geometry) {
    const all = await allGeometry();
    all[panelKey] = { ...all[panelKey], ...geometry };
    try {
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Saving geometry failed:', error);
    }
}

/**
 * Forget a panel's geometry, so it opens where it was designed to.
 * @param {string} panelKey - Which panel
 */
export async function clearGeometry(panelKey) {
    const all = await allGeometry();
    delete all[panelKey];
    try {
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Clearing geometry failed:', error);
    }
}

/**
 * Forget where a panel was, but not how big it was.
 *
 * For a panel that places itself and is only pinned by being moved: unpinning
 * has to drop the position, and dropping the size with it would be an unasked-for
 * second change.
 *
 * @param {string} panelKey - Which panel
 */
export async function clearPosition(panelKey) {
    const all = await allGeometry();
    if (!all[panelKey]) return;

    const { left: _left, top: _top, ...rest } = all[panelKey];
    all[panelKey] = rest;
    try {
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Clearing a panel position failed:', error);
    }
}

/**
 * Remember whether a panel was left minimized (collapsed to its header).
 *
 * Stored in the same shared geometry record as position and size — a panel you
 * minimize to get it out of the way should stay that way through a refresh, the
 * same as where you dragged it. Shared across characters for the same reason
 * geometry is.
 *
 * @param {string} panelKey - Which panel
 * @param {boolean} collapsed - Whether it is minimized now
 * @returns {Promise<void>}
 */
export async function saveCollapsed(panelKey, collapsed) {
    await saveGeometry(panelKey, { collapsed: Boolean(collapsed) });
}

/**
 * @param {string} panelKey - Which panel
 * @returns {Promise<boolean>} Whether it was left minimized
 */
export async function wasCollapsed(panelKey) {
    try {
        const all = await allGeometry();
        return Boolean(all[panelKey]?.collapsed);
    } catch (error) {
        console.error('[PanelGeometry] Reading whether a panel was minimized failed:', error);
        return false;
    }
}

/**
 * The saved size of a panel, if any — so a panel reopened already-minimized
 * knows how tall to spring back to without waiting for a resize.
 * @param {string} panelKey - Which panel
 * @returns {Promise<{width?: number, height?: number}|null>}
 */
export async function savedSize(panelKey) {
    try {
        const all = await allGeometry();
        const rec = all[panelKey];
        if (!rec) return null;
        return { width: rec.width, height: rec.height };
    } catch (error) {
        console.error('[PanelGeometry] Reading a saved panel size failed:', error);
        return null;
    }
}

/**
 * Put a panel back where it was left.
 *
 * Applied after the panel is on screen rather than before, because the geometry
 * comes from storage and the alternative is holding every panel closed until a
 * database answers. Opening at the default and settling a frame later is the
 * lesser of the two.
 *
 * @param {HTMLElement} panel - The panel
 * @param {string} panelKey - Which panel
 * @param {{width: number, height: number}} [min] - Smallest allowed size
 * @param {Object} [options] - `position: false` to restore the size only, for a
 *   panel that places itself and only remembers how big it was
 * @returns {Promise<void>}
 */
export async function restoreGeometry(panel, panelKey, min, { position = true } = {}) {
    const grabsBefore = interactionCount(panel);
    const all = await allGeometry();
    const clamped = clampGeometry(all[panelKey], { width: window.innerWidth, height: window.innerHeight }, min);
    if (!panel?.isConnected) return;

    // Moved or resized while the read was in flight — where the panel is now is
    // what the user just asked for, and is newer than anything stored. The clamp
    // below still runs: a panel dragged off the edge should come back either way.
    const grabbed = interactionCount(panel) !== grabsBefore;

    if (clamped && !grabbed) {
        if (clamped.width) panel.style.width = `${clamped.width}px`;
        if (clamped.height) panel.style.height = `${clamped.height}px`;
        if (position && clamped.left !== undefined) {
            panel.style.left = `${clamped.left}px`;
            panel.style.top = `${clamped.top}px`;
            // Anchored from the left from here on; a panel positioned from the
            // right edge would jump the moment the window is resized
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
    }

    // Whether or not anything was stored: a panel opening at the position it
    // was written to open at is off the side of a phone just as surely as one
    // restoring a position saved on a desktop.
    clampPanelToViewport(panel, min);
}

/**
 * Lift the `open` flags out of the shared geometry record, once.
 *
 * They used to live beside `left`/`top`, which is why every panel the market
 * character left open reopened on the iron cow. Moving them to the bare
 * `panelOpenState` key turns them into an ordinary legacy value, which
 * {@link readScoped} then hands to whichever character is entitled to adopt it —
 * the geometry stays exactly where it is, shared, which is what it should be.
 *
 * @returns {Promise<void>}
 */
async function liftLegacyOpenFlags() {
    const all = await allGeometry();

    const flags = {};
    let found = false;
    for (const [panelKey, geometry] of Object.entries(all)) {
        if (geometry && typeof geometry === 'object' && 'open' in geometry) {
            found = true;
            flags[panelKey] = Boolean(geometry.open);
            const { open: _open, ...rest } = geometry;
            all[panelKey] = rest;
        }
    }
    if (!found) return;

    // An earlier character may have lifted a set already and not been allowed to
    // adopt it; that copy is the newer one and wins
    const waiting = await storage.get(OPEN_KEY, 'settings', null);
    await storage.set(OPEN_KEY, { ...flags, ...(waiting || {}) }, 'settings', true);
    await storage.setJSON(STORAGE_KEY, all, 'settings');
}

/**
 * This character's open flags, loaded once per character.
 * @returns {Promise<Object>} `{ [panelKey]: boolean }`
 */
async function openFlags() {
    await storage.ready;

    const key = characterKey(OPEN_KEY);
    if (openCache.has(key)) return openCache.get(key);

    if (!openLoading.has(key)) {
        const load = (async () => {
            let flags = {};
            let ours = true;
            try {
                await liftLegacyOpenFlags();
                // `readScoped` resolves `characterKey(OPEN_KEY)` again when it
                // runs, and the lift above is four storage round trips wide. A
                // switch landing in it read the ARRIVING character's flags and
                // cached them under `key`, which is the DEPARTING character's —
                // where they stayed for the life of the tab, reopening somebody
                // else's panels for them and, on the next `saveOpenState`, being
                // written over their own stored record.
                if (characterKey(OPEN_KEY) !== key) ours = false;
                else {
                    const saved = await readScoped(OPEN_KEY, 'settings', null, { migrate: 'adopt' });
                    if (characterKey(OPEN_KEY) !== key) ours = false;
                    else if (saved && typeof saved === 'object') flags = saved;
                }
            } catch (error) {
                console.error('[PanelGeometry] Loading which panels were open failed:', error);
            }
            // Not cached, and the in-flight entry is dropped: nothing was read
            // for this character, so the next caller must be able to try again
            // rather than inherit an empty answer forever.
            if (!ours) {
                if (openLoading.get(key) === load) openLoading.delete(key);
                return {};
            }
            openCache.set(key, flags);
            return flags;
        })();
        openLoading.set(key, load);
    }
    return openLoading.get(key);
}

/**
 * Whether a panel was open when the page was last left.
 *
 * Per character, unlike the geometry: a panel belongs where you left it on every
 * character, but the eight panels one character had up are that character's. A
 * panel that has to be reopened after every refresh is a panel that gets opened
 * once and then not bothered with.
 *
 * @param {string} panelKey - The panel's key
 * @param {boolean} open - Whether it is open now
 * @returns {Promise<void>}
 */
export async function saveOpenState(panelKey, open) {
    try {
        // Captured before the load, checked after it. `openFlags()` caches by
        // the key that is current when it starts, and `writeScoped` used to
        // recompute the key when it ran — so a character switch during the
        // first load of the flags wrote the departing character's whole set of
        // open panels under the arriving character's key, which is the leak the
        // per-character split exists to close.
        const key = characterKey(OPEN_KEY);
        const flags = await openFlags();
        if (characterKey(OPEN_KEY) !== key) {
            console.warn('[PanelGeometry] Open panels not saved: the character changed while they loaded');
            return;
        }
        flags[panelKey] = Boolean(open);
        await storage.set(key, flags, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Remembering whether a panel was open failed:', error);
    }
}

/**
 * @param {string} panelKey - The panel's key
 * @returns {Promise<boolean>} Whether it should be reopened
 */
export async function wasOpen(panelKey) {
    try {
        const flags = await openFlags();
        return Boolean(flags[panelKey]);
    } catch (error) {
        console.error('[PanelGeometry] Reading whether a panel was open failed:', error);
        return false;
    }
}

/**
 * Resolves once there is a `<body>` to append a panel to.
 *
 * The script runs at `document-start`, so at the moment these modules are
 * imported there is no body — a panel reopening itself then would throw on the
 * append and take the rest of the module's start-up with it.
 *
 * @returns {Promise<void>}
 */
function bodyReady() {
    if (typeof document === 'undefined' || document.body) return Promise.resolve();
    return new Promise((resolve) => {
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
}

/**
 * Resolves once there is a character to ask about.
 *
 * Panels ask at module scope, which is long before the websocket has said who
 * logged in — and asking then reads the *wrong character's* key, which comes
 * back empty and looks exactly like "nothing was left open". Waiting is the
 * difference between per-character open state working and never reopening
 * anything again.
 *
 * @returns {Promise<void>}
 */
function characterReady() {
    if (dataManager.getCurrentCharacterId()) return Promise.resolve();
    return new Promise((resolve) => {
        const onInitialized = () => {
            dataManager.off('character_initialized', onInitialized);
            resolve();
        };
        dataManager.on('character_initialized', onInitialized);
    });
}

/**
 * Reopen a panel that was open when the page was last left.
 *
 * The waiting is the whole of it, and is why this is one function rather than a
 * `wasOpen` call in each panel. Panels ask at module scope, which is before the
 * database is open *and* before there is a body to draw into; asking then gets
 * the default back, which is indistinguishable from having been closed. That is
 * why remembering appeared to work and reopening never did. Which character is
 * logged in is the third thing not yet known at that moment, and now matters as
 * much as the other two.
 *
 * @param {string} panelKey - The panel's key
 * @param {Function} reopen - Called only if it was open
 * @returns {Promise<void>}
 */
export async function reopenIfLeftOpen(panelKey, reopen) {
    try {
        await characterReady();
        if (!(await wasOpen(panelKey))) return;
        await bodyReady();
        reopen();
    } catch (error) {
        console.error('[PanelGeometry] Reopening a panel failed:', error);
    }
}

/**
 * Test-only: forget the loaded geometry and open flags.
 */
export function _resetCaches() {
    cache = null;
    loading = null;
    openCache.clear();
    openLoading.clear();
}
