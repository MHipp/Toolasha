/**
 * @vitest-environment happy-dom
 *
 * The Overlay switch in the character tabs.
 *
 * The overlay was opened from a button inside the settings dialog, which is two
 * clicks and a scroll away from something people turn on and off several times
 * an hour. Here it is one click, in the strip already used to change what that
 * column shows — and it has to read as a switch rather than a tab, because it
 * opens a panel instead of selecting a page.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

/** What the module has written to the device-local hidden key, and its value */
const deviceStorage = vi.hoisted(() => ({ data: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) =>
            Object.hasOwn(deviceStorage.data, key) ? deviceStorage.data[key] : fallback,
        set: async (key, value) => {
            deviceStorage.data[key] = value;
            return true;
        },
    },
}));

/** Toasts shown, so the drag-to-dismiss confirmation can be checked without a real DOM toast */
const toasts = vi.hoisted(() => ({ shown: [] }));
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.shown.push({ message, options });
        return null;
    },
}));

/** Whether the script is acting like a phone, decided per test */
const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => device.mobile,
    hasCoarsePointer: () => device.mobile,
}));

/** Where the launcher was left, and what it wrote when it was dragged */
const geometry = vi.hoisted(() => ({ saved: {}, written: null }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async (element, key) => {
        const spot = geometry.saved[key];
        if (!spot) return;
        element.style.left = `${spot.left}px`;
        element.style.top = `${spot.top}px`;
    },
    saveGeometry: async (key, value) => {
        geometry.written = { key, value };
    },
}));

const panel = vi.hoisted(() => ({ open: false, toggles: 0 }));

vi.mock('./overlay-panel.js', () => ({
    VISIBILITY_EVENT: 'toolasha:overlay-visibility',
    default: {
        get panel() {
            return panel.open ? {} : null;
        },
        toggle() {
            panel.open = !panel.open;
            panel.toggles += 1;
            document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility', { detail: { open: panel.open } }));
        },
    },
}));

const overlayTabButton = (await import('./overlay-tab-button.js')).default;

/**
 * The character column's tab strip, with a tab shaped the way the game's are.
 * @param {string[]} labels - Tab names, in order
 * @returns {HTMLElement} The strip
 */
function buildTabs(labels = ['Equipment', 'Inventory']) {
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.className = 'MuiTabs-flexContainer';
    for (const label of labels) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.className = 'MuiTab-root TabsComponent_tab__x1';
        tab.innerHTML = `<span class="TabsComponent_badge__y2"><div>${label}</div></span>`;
        list.appendChild(tab);
    }
    document.body.appendChild(list);
    return list;
}

/** @returns {HTMLElement|null} */
function theButton() {
    return document.getElementById('toolasha-overlay-tab');
}

/** @returns {HTMLElement|null} */
function theLauncher() {
    return document.getElementById('toolasha-overlay-launcher');
}

/**
 * A pointer gesture on the launcher, from one point to another.
 * @param {HTMLElement} element - What is being pressed
 * @param {number[]} from - `[x, y]` where the finger went down
 * @param {number[]} to - `[x, y]` where it came up
 */
function press(element, from, to) {
    const at = (type, [x, y], target) =>
        target.dispatchEvent(
            new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true })
        );

    at('pointerdown', from, element);
    at('pointermove', to, document);
    at('pointerup', to, document);
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** Flush the microtask queue so a pending storage.get()/set() promise settles */
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

/** @returns {HTMLElement|null} */
function theDropZone() {
    return document.getElementById('toolasha-overlay-launcher-dropzone');
}

beforeEach(() => {
    panel.open = false;
    panel.toggles = 0;
    device.mobile = false;
    geometry.saved = {};
    geometry.written = null;
    deviceStorage.data = {};
    toasts.shown = [];
    window.innerWidth = 400;
    window.innerHeight = 800;
});

afterEach(() => {
    overlayTabButton.cleanup();
    document.body.replaceChildren();
});

describe('finding its place', () => {
    test('it joins the strip that has an Inventory tab', () => {
        const list = buildTabs();
        overlayTabButton.initialize();

        expect(theButton()).toBeTruthy();
        expect(theButton().parentElement).toBe(list);
    });

    test('a strip belonging to some other panel is left alone', () => {
        // Every tab strip in the game shares the same classes, so the contents
        // are the only thing that says which one this is
        buildTabs(['General', 'Market Listings']);
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });

    test('it sits in front of Optimizer', () => {
        const list = buildTabs(['Inventory', 'Loadouts', 'Optimizer']);
        overlayTabButton.initialize();

        const labels = [...list.children].map((tab) => tab.textContent.trim());
        expect(labels.indexOf('⧉ Overlay')).toBe(labels.indexOf('Optimizer') - 1);
    });

    test('Optimizer arriving late still ends up behind it', () => {
        // On a slow load the Optimizer tab is injected after this one, so where
        // this sits is re-checked rather than decided once
        const list = buildTabs(['Inventory', 'Loadouts']);
        overlayTabButton.initialize();

        const optimizer = document.createElement('button');
        optimizer.setAttribute('role', 'tab');
        optimizer.textContent = 'Optimizer';
        list.appendChild(optimizer);
        overlayTabButton.ensureButton();

        expect(theButton().nextElementSibling).toBe(optimizer);
    });

    test('a rebuilt strip gets the button back', () => {
        buildTabs();
        overlayTabButton.initialize();

        document.body.replaceChildren();
        const rebuilt = buildTabs();
        overlayTabButton.ensureButton();

        expect(theButton()?.parentElement).toBe(rebuilt);
    });

    test('running twice leaves one button', () => {
        buildTabs();
        overlayTabButton.initialize();
        overlayTabButton.ensureButton();

        expect(document.querySelectorAll('#toolasha-overlay-tab').length).toBe(1);
    });
});

describe('looking like the tabs beside it', () => {
    test('it is cloned from a real tab rather than styled to match one', () => {
        // A copy drifts at the next game build; a clone cannot
        buildTabs();
        overlayTabButton.initialize();

        expect(theButton().className).toContain('TabsComponent_tab__x1');
        expect(theButton().querySelector('[class*="TabsComponent_badge"]').textContent).toBe('⧉ Overlay');
    });

    test('it is not copied from a tab the game has hidden', () => {
        // With "show Toolasha tab by default" on, the game's own Inventory tab
        // is set to display: none — and it is the first in the strip, so it is
        // exactly what a naive search picks. The clone carries that inline style
        // with it, and the result is a button that is added, positioned, kept in
        // place, and invisible.
        const list = buildTabs(['Inventory', 'Equipment']);
        list.children[0].style.display = 'none';
        overlayTabButton.initialize();

        expect(theButton().style.display).not.toBe('none');
    });

    test('every tab hidden means no button rather than an invisible one', () => {
        const list = buildTabs(['Inventory']);
        list.children[0].style.display = 'none';
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
    });

    test('it does not inherit the position of the tab it was copied from', () => {
        // Tab Reorder lays the strip out with CSS order, and a clone brings that
        // number along — parking this button on top of its own model
        const list = buildTabs(['Inventory', 'Equipment']);
        for (const tab of list.children) tab.style.order = '4';
        overlayTabButton.initialize();

        expect(theButton().style.order).toBe('');
    });

    test('it is not left draggable without the handlers that made it so', () => {
        const list = buildTabs();
        for (const tab of list.children) tab.setAttribute('draggable', 'true');
        overlayTabButton.initialize();

        expect(theButton().hasAttribute('draggable')).toBe(false);
    });

    test('an injected tab is not used as the model', () => {
        // Cloning one would copy whatever that feature did to itself
        const list = buildTabs(['Inventory']);
        const ours = document.createElement('button');
        ours.setAttribute('role', 'tab');
        ours.className = 'toolasha-inv-tab injected-look';
        ours.textContent = 'Toolasha';
        list.insertBefore(ours, list.firstChild);
        overlayTabButton.initialize();

        expect(theButton().className).not.toContain('injected-look');
    });

    test('it never claims the selection the real tabs share', () => {
        // It opens a panel instead of choosing what this column shows, so a
        // column showing Inventory with Overlay highlighted would be a lie
        const list = buildTabs();
        list.children[1].classList.add('Mui-selected');
        overlayTabButton.initialize();

        expect(theButton().classList.contains('Mui-selected')).toBe(false);
        expect(theButton().getAttribute('aria-selected')).toBe('false');
    });
});

describe('working as a switch', () => {
    test('clicking it opens the overlay', () => {
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();

        expect(panel.open).toBe(true);
    });

    test('clicking it again closes it', () => {
        // A switch that only ever opens reads as broken the second time
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();
        theButton().click();

        expect(panel.toggles).toBe(2);
        expect(panel.open).toBe(false);
    });

    test('it is dim while the overlay is down and bright while it is up', () => {
        buildTabs();
        overlayTabButton.initialize();
        expect(Number(theButton().style.opacity)).toBeLessThan(1);

        theButton().click();
        expect(Number(theButton().style.opacity)).toBe(1);
    });

    test('closing the panel by its own ✕ dims the switch too', () => {
        buildTabs();
        overlayTabButton.initialize();
        theButton().click();

        // What the panel's close button ends up doing
        panel.open = false;
        document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility', { detail: { open: false } }));

        expect(Number(theButton().style.opacity)).toBeLessThan(1);
    });

    test('cleanup takes the button away and stops listening', () => {
        buildTabs();
        overlayTabButton.initialize();
        overlayTabButton.cleanup();

        expect(theButton()).toBeNull();
        expect(() => document.dispatchEvent(new CustomEvent('toolasha:overlay-visibility'))).not.toThrow();
    });
});

describe('opening the overlay from anywhere on a phone', () => {
    test('with no character column on screen there is still a way in', () => {
        // The bug, exactly: the game shows one panel at a time on a phone, so
        // the strip this switch lives in is not in the document while you are
        // fighting or trading — and the overlay could only be opened from the
        // inventory screen
        device.mobile = true;
        overlayTabButton.initialize();

        expect(theButton()).toBeNull();
        expect(theLauncher()).toBeTruthy();
    });

    test('it is fixed to the window rather than to any screen of the game', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        expect(theLauncher().style.position).toBe('fixed');
        expect(theLauncher().parentElement).toBe(document.body);
    });

    test('it survives the screen the game was showing being thrown away', () => {
        device.mobile = true;
        buildTabs();
        overlayTabButton.initialize();

        // Which is what changing screens looks like on a phone
        document.querySelector('[role="tablist"]').remove();
        overlayTabButton.ensureButton();

        expect(theLauncher()).toBeTruthy();
    });

    test('tapping it opens the overlay, and tapping again closes it', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        theLauncher().click();
        expect(panel.open).toBe(true);

        theLauncher().click();
        expect(panel.open).toBe(false);
    });

    test('it dims with the panel, like the tab switch does', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        expect(Number(theLauncher().style.opacity)).toBeLessThan(1);

        theLauncher().click();
        expect(Number(theLauncher().style.opacity)).toBe(1);
    });

    test('a desktop never gets one', () => {
        device.mobile = false;
        buildTabs();
        overlayTabButton.initialize();

        expect(theButton()).toBeTruthy();
        expect(theLauncher()).toBeNull();
    });

    test('turning mobile mode off takes it away again', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        expect(theLauncher()).toBeTruthy();

        device.mobile = false;
        overlayTabButton.ensureLauncher();

        expect(theLauncher()).toBeNull();
    });

    test('running twice leaves one launcher', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        overlayTabButton.ensureLauncher();

        expect(document.querySelectorAll('#toolasha-overlay-launcher').length).toBe(1);
    });

    test('cleanup takes it away', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        overlayTabButton.cleanup();

        expect(theLauncher()).toBeNull();
    });
});

describe('moving the launcher out of the way', () => {
    test('dragging it moves it and remembers where to', () => {
        // A fixed corner is a guess about a screen this has never seen, and on
        // the phone where the guess is wrong it covers a control for good
        device.mobile = true;
        overlayTabButton.initialize();

        // happy-dom measures every box at the origin, so the launcher starts at
        // 0,0 here and where it lands is the distance the finger travelled
        press(theLauncher(), [100, 100], [250, 400]);

        expect(theLauncher().style.left).toBe('150px');
        expect(theLauncher().style.top).toBe('300px');
        expect(geometry.written.key).toBe('overlayLauncher');
        expect(geometry.written.value).toEqual({ left: 150, top: 300 });
    });

    test('a drag does not also toggle the overlay', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        press(theLauncher(), [300, 700], [120, 300]);

        expect(panel.toggles).toBe(0);
    });

    test('a tap that wanders a pixel is still a tap', () => {
        // Every press on a touchscreen moves a little, and a switch that needs a
        // perfectly still finger is a switch that appears not to work
        device.mobile = true;
        overlayTabButton.initialize();

        press(theLauncher(), [300, 700], [302, 701]);

        expect(panel.toggles).toBe(1);
        expect(geometry.written).toBeNull();
    });

    test('it cannot be dragged off the screen', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        press(theLauncher(), [300, 700], [9000, 9000]);

        expect(Number.parseFloat(theLauncher().style.left)).toBeLessThanOrEqual(400);
        expect(Number.parseFloat(theLauncher().style.top)).toBeLessThanOrEqual(800);
    });

    test('it opens where it was last left', async () => {
        device.mobile = true;
        geometry.saved.overlayLauncher = { left: 30, top: 200 };
        overlayTabButton.initialize();
        await Promise.resolve();

        expect(theLauncher().style.left).toBe('30px');
        expect(theLauncher().style.top).toBe('200px');
    });
});

describe('dragging it away to dismiss it', () => {
    /**
     * A pointer gesture that stops short of releasing, so a test can inspect
     * mid-drag state (the drop zone) before the drag ends.
     * @param {HTMLElement} element - What is being pressed
     * @param {number[]} from - `[x, y]` where the finger went down
     * @param {number[]} to - `[x, y]` where it is now
     */
    function dragTo(element, from, to) {
        const at = (type, [x, y], target) =>
            target.dispatchEvent(
                new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true })
            );
        at('pointerdown', from, element);
        at('pointermove', to, document);
    }

    /** Release wherever the last `dragTo` left off */
    function release(at = [0, 0]) {
        document.dispatchEvent(new window.PointerEvent('pointerup', { clientX: at[0], clientY: at[1], pointerId: 1 }));
    }

    test('the drop zone is absent until a press actually becomes a drag', () => {
        device.mobile = true;
        overlayTabButton.initialize();
        expect(theDropZone()).toBeNull();

        // Still under DRAG_SLOP — a tap in progress, not a drag
        dragTo(theLauncher(), [300, 700], [302, 701]);
        expect(theDropZone()).toBeNull();

        release([302, 701]);
        expect(theDropZone()).toBeNull();
    });

    test('it appears once the press has travelled far enough to be a drag', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        dragTo(theLauncher(), [100, 100], [250, 400]);

        expect(theDropZone()).toBeTruthy();
    });

    test('releasing away from it removes it and still just moves the launcher', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        // Lands at left 150 / top 300 — nowhere near the centred zone hugging
        // the bottom of an 800px-tall screen
        press(theLauncher(), [100, 100], [250, 400]);

        expect(theDropZone()).toBeNull();
        expect(theLauncher()).toBeTruthy();
        expect(theLauncher().style.left).toBe('150px');
        expect(geometry.written).toEqual({ key: 'overlayLauncher', value: { left: 150, top: 300 } });
    });

    test('dropping it on the zone hides the launcher and writes the device-local key', async () => {
        device.mobile = true;
        overlayTabButton.initialize();

        // originX/Y are 0 in happy-dom, so the drop lands at left 150 / top 750 —
        // inside the centred 180×56 zone sitting 12px off the bottom of an
        // 800px-tall, 400px-wide screen
        dragTo(theLauncher(), [50, 50], [200, 800]);
        expect(theDropZone()).toBeTruthy();
        release([200, 800]);
        await flush();

        expect(theLauncher()).toBeNull();
        expect(theDropZone()).toBeNull();
        expect(deviceStorage.data['toolasha_local_overlayLauncherHidden']).toBe(true);
        // Dropping it must not also record it as moved-and-left-here
        expect(geometry.written).toBeNull();
    });

    test('dropping it on the zone does not toggle the overlay', async () => {
        device.mobile = true;
        overlayTabButton.initialize();

        dragTo(theLauncher(), [50, 50], [200, 800]);
        release([200, 800]);
        await flush();

        expect(panel.toggles).toBe(0);
    });

    test('it says where the launcher went, and how to get it back', async () => {
        device.mobile = true;
        overlayTabButton.initialize();

        dragTo(theLauncher(), [50, 50], [200, 800]);
        release([200, 800]);
        await flush();

        expect(toasts.shown).toHaveLength(1);
        expect(toasts.shown[0].message).toMatch(/Toolasha settings/i);
        expect(toasts.shown[0].message).toMatch(/Show the overlay button/i);
    });

    test('every write to the device-local key stays under the toolasha_local_ prefix', async () => {
        device.mobile = true;
        overlayTabButton.initialize();

        dragTo(theLauncher(), [50, 50], [200, 800]);
        release([200, 800]);
        await flush();

        for (const key of Object.keys(deviceStorage.data)) {
            expect(key.startsWith('toolasha_local_')).toBe(true);
        }
    });

    test('a corner the drag merely clamps to is not the drop zone', () => {
        // The existing off-screen clamp test drags to the extreme bottom-right
        // corner; that must keep being an ordinary clamp; not every drag that
        // lands near the bottom edge is a drop on the (small, centred) zone
        device.mobile = true;
        overlayTabButton.initialize();

        press(theLauncher(), [300, 700], [9000, 9000]);

        expect(theLauncher()).toBeTruthy();
        expect(geometry.written).not.toBeNull();
    });
});

describe('the settings-side control', () => {
    test('setLauncherHidden(true) hides the launcher immediately and persists it', async () => {
        device.mobile = true;
        overlayTabButton.initialize();
        expect(theLauncher()).toBeTruthy();

        await overlayTabButton.setLauncherHidden(true);

        expect(theLauncher()).toBeNull();
        expect(overlayTabButton.isLauncherHidden()).toBe(true);
        expect(deviceStorage.data['toolasha_local_overlayLauncherHidden']).toBe(true);
    });

    test('setLauncherHidden(false) creates the launcher again with no reload', async () => {
        device.mobile = true;
        deviceStorage.data['toolasha_local_overlayLauncherHidden'] = true;
        overlayTabButton.initialize();
        await flush();
        expect(theLauncher()).toBeNull();

        await overlayTabButton.setLauncherHidden(false);

        expect(theLauncher()).toBeTruthy();
        expect(overlayTabButton.isLauncherHidden()).toBe(false);
        expect(deviceStorage.data['toolasha_local_overlayLauncherHidden']).toBe(false);
    });
});

describe('a launcher left hidden', () => {
    test('the stored flag means no launcher is created on load', async () => {
        device.mobile = true;
        deviceStorage.data['toolasha_local_overlayLauncherHidden'] = true;
        overlayTabButton.initialize();
        await flush();

        expect(theLauncher()).toBeNull();
        expect(theDropZone()).toBeNull();
    });

    test('with the flag false, or unset, the launcher opens as usual', async () => {
        device.mobile = true;
        overlayTabButton.initialize();
        await flush();

        expect(theLauncher()).toBeTruthy();
    });

    test('desktop gets neither a launcher nor a drop zone regardless of the flag', async () => {
        device.mobile = false;
        deviceStorage.data['toolasha_local_overlayLauncherHidden'] = false;
        buildTabs();
        overlayTabButton.initialize();
        await flush();

        expect(theLauncher()).toBeNull();
        expect(theDropZone()).toBeNull();
    });

    test('a character switch tears the drop zone down along with everything else', () => {
        device.mobile = true;
        overlayTabButton.initialize();

        // Left mid-drag, deliberately not released — this is what a character
        // switch has to clean up if it lands mid-gesture, not just what a
        // normal release already tidies up on its own
        const at = (type, [x, y], target) =>
            target.dispatchEvent(
                new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true })
            );
        at('pointerdown', [100, 100], theLauncher());
        at('pointermove', [250, 400], document);
        expect(theDropZone()).toBeTruthy();

        overlayTabButton.cleanup();

        expect(theLauncher()).toBeNull();
        expect(theDropZone()).toBeNull();
    });
});
