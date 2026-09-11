/**
 * @vitest-environment happy-dom
 *
 * The gear popover: getting out of it, and keeping up with what it is showing.
 *
 * Two complaints, and they are the same popover. It is a fixed element at popup
 * z-index anchored to a panel that moves, and it is a *live* control — the
 * layout it lists can be changed by the lock, by a narrow window, and by the
 * auto-switch ticking over underneath it.
 *
 * So: it must never cover the header that holds the ⚙ that opened it and the ✕
 * that closes the overlay — that is the whole of "blocks the ability to hide it
 * again", because there is no other gesture that dismisses it. And what it draws
 * has to be redrawn when the thing it is drawing changes.
 *
 * Geometry is stated rather than laid out: happy-dom measures nothing, and every
 * rule here is about where a rectangle lands.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map(), transactions: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: () => 'off', Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => (store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null),
        getMany: async (keys) => {
            // One transaction however many keys it carries, which is what the
            // panel's start-up read is counted on
            store.transactions.push([...keys]);
            return new Map(
                keys.map((key) => [key, store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null])
            );
        },
        setJSON: async (key, value) => {
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
        tryGet: async (key) =>
            store.data.has(key)
                ? { found: true, value: JSON.parse(JSON.stringify(store.data.get(key))) }
                : { found: false, value: null },
        set: async (key, value) => {
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
    PANEL_Z_CAP: 1199,
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
}));
vi.mock('../../utils/floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_scoped`,
    readScopedFrom: async () => null,
    readScoped: async () => null,
    writeScoped: async () => {},
}));
/** What the delete dialog answers, and whether the popover was up while it asked */
const dialog = vi.hoisted(() => ({ answer: null, sawPicker: null, seen: () => false }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async () => {
        dialog.sawPicker = dialog.seen();
        return dialog.answer;
    },
}));

// The real registry is module-level and has no way to take a row back out, so a
// row registered inside one test is offered to every test after it — which is
// two extra chips in the popover and a `chipState()` nobody wrote an
// expectation for. Only the list is stood in for; every rule about rows
// (`resolveRows`, the empty-tile policy) is the real one.
const registry = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => [...registry.rows],
}));

const { registerEscapeClose } = await import('../../utils/panel-escape.js');
const overlayPanel = (await import('./overlay-panel.js')).default;

/** The header band, which is the one part of the panel that must stay clickable */
const HEADER_HEIGHT = 28;

/**
 * Offer a row for the length of one test, replacing by key as the real registry does.
 * @param {Object} row - Row definition, as `registerRow` takes one
 */
function offerRow({ key, name, render, ...rest }) {
    const definition = {
        key,
        name: name || key,
        render,
        version: null,
        defaultVisible: true,
        onOpen: null,
        defaultSize: null,
        defaultZoom: null,
        empty: '',
        tileClass: '',
        whenEmpty: '',
        ...rest,
    };
    const existing = registry.rows.findIndex((row) => row.key === key);
    if (existing >= 0) registry.rows[existing] = definition;
    else registry.rows.push(definition);
}

/**
 * State a rectangle for something happy-dom would measure as nothing.
 *
 * @param {HTMLElement} element - What to measure
 * @param {{left: number, top: number, width: number, height: number}} box - Where it is
 */
function rectIs(element, { left, top, width, height }) {
    element.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
    });
}

/**
 * Put the panel somewhere, with a header of a known height.
 *
 * @param {{left: number, top: number, width: number, height: number}} box - Where the panel is
 */
function panelAt(box) {
    rectIs(overlayPanel.panel, box);
    rectIs(overlayPanel.panel.firstElementChild, {
        left: box.left,
        top: box.top,
        width: box.width,
        height: HEADER_HEIGHT,
    });
}

/**
 * The pixel value of a CSS length, in the two units this popover is written in.
 * @param {string} value - A CSS length
 * @returns {number|null} Pixels, or null when there is no length there
 */
function lengthPx(value) {
    const written = /^(-?\d+(?:\.\d+)?)(px|vh)$/.exec(String(value ?? '').trim());
    if (!written) return null;
    return written[2] === 'vh' ? (Number(written[1]) * window.innerHeight) / 100 : Number(written[1]);
}

/**
 * Say how tall the popover wants to be, however much room it is given.
 * @param {number} height - Its natural height
 */
function pickerWants(height) {
    const el = overlayPanel.pickerEl;
    el.getBoundingClientRect = () => {
        const left = Number.parseFloat(el.style.left) || 0;
        const top = Number.parseFloat(el.style.top) || 0;
        const width = Number.parseFloat(el.style.width) || 320;
        const cap = lengthPx(el.style.maxHeight);
        const drawn = cap === null ? height : Math.min(height, cap);
        return {
            left,
            top,
            width,
            height: drawn,
            right: left + width,
            bottom: top + drawn,
            x: left,
            y: top,
            toJSON: () => ({}),
        };
    };
}

/** Where the popover ended up. @returns {{top: number, bottom: number}} */
function pickerBand() {
    const box = overlayPanel.pickerEl.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
}

/**
 * Let every promise a click started run out.
 * @returns {Promise<void>}
 */
async function settle() {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

/** Open the gear the way a click on it does. */
function openGear() {
    overlayPanel.panel.querySelector('button[title^="Choose rows"]').click();
}

/** The popover's text, whatever it currently holds. @returns {string} */
function pickerText() {
    return overlayPanel.pickerEl.textContent;
}

/** The tile chips as the popover currently draws them. @returns {Object} */
function chipState() {
    const state = {};
    for (const chip of overlayPanel.pickerEl.querySelectorAll('[data-overlay-row-chip]')) {
        state[chip.dataset.overlayRowChip] = chip.querySelector('input[type="checkbox"]').checked;
    }
    return state;
}

beforeEach(() => {
    store.data.clear();
    dialog.answer = null;
    dialog.sawPicker = null;
    dialog.seen = () => overlayPanel.isPickerOpen;
    document.body.replaceChildren();
    window.innerWidth = 900;
    window.innerHeight = 800;

    registry.rows = [];
    offerRow({ key: 'dps', name: 'DPS', render: (el) => (el.textContent = 'dps') });
    offerRow({ key: 'luck', name: 'Luck', render: (el) => (el.textContent = 'luck') });

    overlayPanel.settings = {
        visible: { dps: true, luck: true },
        order: ['dps', 'luck'],
        positions: {},
        sizes: {},
        zoom: {},
        locked: true,
        snapToGrid: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
    };
    overlayPanel.savedLayouts = [];
    overlayPanel.undoState = null;
    overlayPanel.show();
});

afterEach(() => {
    overlayPanel.hide();
});

describe('getting out of the gear popover', () => {
    test('it never covers the header, even with no room above or below', () => {
        // A panel nearly as tall as the window: there is nowhere for a popover
        // of any size to stand clear of it
        panelAt({ left: 20, top: 40, width: 400, height: 720 });
        pickerWants(400);

        openGear();
        overlayPanel._placePicker();

        const band = pickerBand();
        expect(band.top).toBeGreaterThanOrEqual(40 + HEADER_HEIGHT);
    });

    test('it never covers the header when the clamp would push it up over the panel', () => {
        // The band that produced the report: too little room above to fit, and
        // below, the popover is taller than what is left — so it was clamped up
        // the window and landed on the panel's own header
        panelAt({ left: 20, top: 400, width: 400, height: 360 });
        pickerWants(400);

        openGear();
        overlayPanel._placePicker();

        const band = pickerBand();
        const coversHeader = band.top < 400 + HEADER_HEIGHT && band.bottom > 400;
        expect(coversHeader).toBe(false);
    });

    test('it still sits above the panel when there is room', () => {
        panelAt({ left: 20, top: 500, width: 400, height: 200 });
        pickerWants(300);

        openGear();
        overlayPanel._placePicker();

        expect(pickerBand().bottom).toBeLessThanOrEqual(500);
    });

    test('it clears the header even in a window with no room anywhere', () => {
        window.innerHeight = 220;
        panelAt({ left: 20, top: 90, width: 400, height: 120 });
        pickerWants(400);

        openGear();
        overlayPanel._placePicker();

        expect(pickerBand().top).toBeGreaterThanOrEqual(90 + HEADER_HEIGHT);
    });

    test('it is held inside the window rather than hanging off the bottom', () => {
        panelAt({ left: 20, top: 40, width: 400, height: 200 });
        pickerWants(900);

        openGear();
        overlayPanel._placePicker();

        expect(pickerBand().bottom).toBeLessThanOrEqual(window.innerHeight);
    });

    test('Escape closes it', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        expect(overlayPanel.isPickerOpen).toBe(true);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(overlayPanel.isPickerOpen).toBe(false);
    });

    test('the Escape that closes it does not also reach the panel stack', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();

        // A floating panel under the shared Escape-to-close, as far as the
        // stack is concerned
        const close = vi.fn();
        const reg = registerEscapeClose(close);

        // Cancelable like a real keystroke: the popover marks the Escape it
        // acts on as spent, which is what keeps it off the panel stack
        const keypress = () =>
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        keypress();
        expect(overlayPanel.isPickerOpen).toBe(false);
        expect(close).not.toHaveBeenCalled();

        // With the popover gone, the same key reaches the panels again
        keypress();
        expect(close).toHaveBeenCalledTimes(1);
        reg.release();
    });

    test('a press outside it closes it', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        const elsewhere = document.createElement('div');
        document.body.appendChild(elsewhere);
        elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        expect(overlayPanel.isPickerOpen).toBe(false);
    });

    test('a press inside it leaves it alone', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        overlayPanel.pickerEl
            .querySelector('[data-overlay-row-chip]')
            .dispatchEvent(new Event('pointerdown', { bubbles: true }));

        expect(overlayPanel.isPickerOpen).toBe(true);
    });

    test('a press on the panel it is arranging leaves it alone', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        overlayPanel.canvasEl.dispatchEvent(new Event('pointerdown', { bubbles: true }));

        expect(overlayPanel.isPickerOpen).toBe(true);
    });

    test('the gear still shuts it, rather than shutting and reopening it', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        expect(overlayPanel.isPickerOpen).toBe(true);
        openGear();
        expect(overlayPanel.isPickerOpen).toBe(false);
    });

    test('the ✕ hides the overlay while the popover is up, and takes it with it', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        overlayPanel.panel.querySelector('button[title="Close"]').click();

        expect(overlayPanel.isOpen).toBe(false);
        expect(document.querySelector('#toolasha-overlay-panel')).toBe(null);
        expect(overlayPanel.pickerEl).toBe(null);
    });

    test('nothing is left listening once the panel is closed', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);

        openGear();
        overlayPanel.hide();

        // Would throw on a listener still holding a torn-down popover
        expect(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        }).not.toThrow();

        overlayPanel.show();
        expect(overlayPanel.isOpen).toBe(true);
    });
});

describe('the popover keeps up with what it is showing', () => {
    test('locking and unlocking redraws its hint', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();

        expect(pickerText()).toContain('Unlock');

        overlayPanel.panel.querySelector('button[title^="Layout locked"]').click();

        expect(overlayPanel.settings.locked).toBe(false);
        expect(pickerText()).toContain('Drag a tile to move it');
    });

    test('the hint describes reordering, because that is what unlocking gives you', () => {
        // There is no "too narrow for your arrangement" case left to explain: a
        // layout is an order and a set of spans, and a span clamps to the
        // columns there are, so no arrangement can fail to fit
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();

        expect(pickerText()).not.toContain('flowed into columns');
        expect(pickerText()).toContain('reorder tiles');
    });

    test('switching layout redraws the tile checkboxes', async () => {
        overlayPanel.settings.visible = { dps: true, luck: true };
        await overlayPanel.saveNamedLayout('Both');
        overlayPanel.settings.visible = { dps: false, luck: true };
        await overlayPanel.saveNamedLayout('Luck only');

        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();
        expect(chipState()).toEqual({ dps: false, luck: true });

        await overlayPanel.applyNamedLayout('Both');
        expect(chipState()).toEqual({ dps: true, luck: true });
    });

    test('the delete dialog is asked with the popover out of the way, and the answer redraws it', async () => {
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.saveNamedLayout('Market run');

        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();
        await overlayPanel._refreshLayoutNames();

        dialog.answer = 'Dungeon';
        overlayPanel.pickerEl.querySelector('button[title="Forget a saved layout"]').click();
        // The button's handler is asynchronous and `click` does not wait for it
        await settle();
        // The popover draws above the dialog's own backdrop, so it has to stand
        // down or the question is asked underneath it
        expect(dialog.sawPicker).toBe(false);

        expect(overlayPanel.isPickerOpen).toBe(true);
        const offered = [...overlayPanel.pickerEl.querySelectorAll('[data-overlay-layout-select] option')].map(
            (option) => option.textContent
        );
        expect(offered).not.toContain('Dungeon');
        expect(offered).toContain('Market run');
    });

    test('docking keeps the popover up rather than dropping it on the floor', () => {
        panelAt({ left: 20, top: 100, width: 400, height: 200 });
        pickerWants(200);
        openGear();

        overlayPanel.toggleDock();

        expect(overlayPanel.isPickerOpen).toBe(true);
        expect(overlayPanel.pickerEl.querySelectorAll('[data-overlay-row-chip]').length).toBe(2);
    });
});

describe('resetting to the default tiles', () => {
    test('drops a drifted selection back to the curated set, and can be undone', () => {
        // A character who arranged the overlay under the old every-row-on
        // defaults: an explicit selection, a hand-set order, and no curated flag
        offerRow({ key: 'houses', name: 'Houses', render: (el) => (el.textContent = 'houses') });
        overlayPanel.settings.visible = { dps: false, luck: true, houses: true };
        overlayPanel.settings.order = ['houses', 'luck', 'dps'];
        overlayPanel.settings.curatedDefaults = false;

        panelAt({ left: 20, top: 100, width: 400, height: 400 });
        pickerWants(200);
        openGear();

        overlayPanel.pickerEl.querySelector('button[title^="Switch the rows back"]').click();

        // Opted into the curated set with the explicit opinions cleared, so the
        // two curated rows come back on and the non-curated one drops away
        expect(overlayPanel.settings.curatedDefaults).toBe(true);
        expect(overlayPanel.settings.visible).toEqual({});
        expect(chipState()).toEqual({ dps: true, luck: true, houses: false });

        // Reset tiles is a bulk change, so it takes the undo like the rest
        overlayPanel.pickerEl.querySelector('button[title="Put the layout back to before that"]').click();
        expect(overlayPanel.settings.curatedDefaults).toBe(false);
        expect(overlayPanel.settings.visible).toEqual({ dps: false, luck: true, houses: true });
        expect(chipState()).toEqual({ dps: false, luck: true, houses: true });
    });
    test('the empty-tile modes are named for what they do', () => {
        // "By tile" described how the panel decides to somebody who wanted to
        // know what they would see
        overlayPanel._renderPicker();
        const options = [...overlayPanel.pickerEl.querySelectorAll('[data-overlay-setting="emptyTiles"] option')];

        expect(options.map((option) => option.textContent)).toEqual([
            'Dim name',
            'Dim name, always',
            'Hide',
            'Full message',
        ]);
        // The values are what is stored, and none of them may drift
        expect(options.map((option) => option.value)).toEqual(['auto', 'compact', 'hide', 'full']);
    });
    test('the popover says which layout is in force', () => {
        // The dropdown deliberately reads "Switch to…" rather than the current
        // name, which left nothing at all saying what *is* in force — and with
        // auto-switching on, the panel changes layout without anybody pressing
        // anything
        overlayPanel.appliedLayout = null;
        openGear();
        expect(overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]')).toBeNull();

        overlayPanel.appliedLayout = 'Skilling';
        overlayPanel._renderPicker();

        expect(overlayPanel.pickerEl.querySelector('[data-overlay-active-layout]').textContent).toBe(
            'Showing: Skilling'
        );
    });

    test('Reset layout asks before throwing an arrangement away', async () => {
        // Import already asks, and this throws away as much — with the
        // difference that Import at least announces itself with a file picker
        openGear();
        overlayPanel.settings.span = { dps: 2 };

        dialog.answer = null;
        await overlayPanel._resetLayout();
        expect(overlayPanel.settings.span).toEqual({ dps: 2 });

        dialog.answer = 'reset';
        await overlayPanel._resetLayout();
        expect(overlayPanel.settings.span).not.toEqual({ dps: 2 });
    });

    test('Reset layout also unpins columns, so the shipped spans are not flattened', async () => {
        // A pin left over from a narrow window — columns stepped down to 1 and
        // held there — used to survive Reset. The Default preset's spans came
        // back, but pinned at 1 column every one of them draws as a single
        // column anyway: "the arrangement the script ships with" never actually
        // reappeared.
        openGear();
        overlayPanel.settings.columns = 1;
        overlayPanel.settings.columnsPinned = true;

        dialog.answer = 'reset';
        await overlayPanel._resetLayout();

        expect(overlayPanel.settings.columnsPinned).toBe(false);
        expect(overlayPanel.settings.columns).toBe(2);
    });
});
