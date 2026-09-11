/**
 * @vitest-environment happy-dom
 *
 * Which layout is in force, across a reload.
 *
 * The Update button and the "Showing: X" line both hang off one field, and that
 * field used to live only in memory. F5 and the panel had no idea what it was
 * showing: no Update button, no line, and the player was back to Save as… and
 * retyping the name — the exact friction the Update button was built to remove.
 *
 * A reload is simulated the only way it can be for a module-scope singleton:
 * the field is cleared, `isInitialized` is dropped, and `initialize()` is asked
 * to build the panel again from what is in storage. Storage is a map in memory,
 * because the question is never whether IndexedDB works.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map(), transactions: [] }));
/** The per-character side of storage, which is where the applied name lives */
const scoped = vi.hoisted(() => ({ data: new Map(), unbatched: [] }));

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
    // The panel reads its three records in one batch now; the batch is keyed,
    // but what the scoped read means is still "whatever is filed under base"
    readScopedFrom: async (base, _values, storeName, defaultValue = null) =>
        scoped.data.has(base) ? scoped.data.get(base) : defaultValue,
    readScoped: async (base, storeName, defaultValue = null) => {
        // Un-batched: one transaction of its own, and up to two. Counted so a
        // test can say the start-up path no longer takes any.
        scoped.unbatched.push(base);
        return scoped.data.has(base) ? scoped.data.get(base) : defaultValue;
    },
    writeScoped: async (base, value) => {
        scoped.data.set(base, value === undefined ? null : value);
        return true;
    },
}));
const dialog = vi.hoisted(() => ({ answer: null }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => dialog.answer }));

const { registerRow } = await import('../../utils/overlay-rows.js');
const overlayPanel = (await import('./overlay-panel.js')).default;

/** Where the name is kept, which the panel must not quietly rename */
const APPLIED_KEY = 'overlayAppliedLayout';

/**
 * Put an arrangement on the panel as though it had been dragged there.
 * @param {Object} layout - What to apply
 */
function wear(layout) {
    overlayPanel.settings = { ...overlayPanel.settings, ...layout };
}

/** An arrangement worth telling apart from another one. @returns {Object} */
function dungeonLayout() {
    return {
        version: 2,
        order: ['dps', 'luck'],
        span: { luck: 2 },
        visible: { dps: true, luck: true },
        zoom: { dps: 130 },
        textScale: 110,
    };
}

/**
 * Everything the panel forgets when the page goes away, and nothing it keeps.
 *
 * `initialize` is what a reload actually runs, so it is what is run here —
 * including the settings read, so nothing is restored by having been left in
 * memory from before.
 * @returns {Promise<void>}
 */
async function reload() {
    overlayPanel.hide();
    overlayPanel.appliedLayout = null;
    overlayPanel.savedLayouts = null;
    overlayPanel.isInitialized = false;
    await overlayPanel.initialize();
    overlayPanel.show();
}

/** The popover, opened. @returns {HTMLElement} */
function openGear() {
    overlayPanel.openPicker();
    return overlayPanel.pickerEl;
}

beforeEach(async () => {
    store.data.clear();
    store.transactions = [];
    scoped.data.clear();
    scoped.unbatched = [];
    dialog.answer = null;
    document.body.replaceChildren();

    registerRow({ key: 'dps', name: 'DPS', render: (el) => (el.textContent = 'dps') });
    registerRow({ key: 'luck', name: 'Luck', render: (el) => (el.textContent = 'luck') });

    overlayPanel.isInitialized = false;
    overlayPanel.settings = {
        visible: {},
        order: [],
        span: {},
        zoom: {},
        locked: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
    };
    overlayPanel.savedLayouts = null;
    overlayPanel.undoState = null;
    overlayPanel.appliedLayout = null;
    overlayPanel.show();
});

afterEach(() => {
    overlayPanel.hide();
});

describe('the applied layout name survives a reload', () => {
    test('the name is stored when a layout is applied, and read back on init', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');
        expect(scoped.data.get(APPLIED_KEY)).toBe('Dungeon');

        await reload();

        expect(overlayPanel.appliedLayout).toBe('Dungeon');
    });

    test('after a reload the popover still offers Update and says what is showing', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        await reload();
        const picker = openGear();

        expect(picker.querySelector('[data-overlay-active-layout]').textContent).toContain('Showing: Dungeon');
        const buttons = [...picker.querySelectorAll('button')].map((button) => button.textContent);
        expect(buttons).toContain('Update "Dungeon"');
    });

    test('a restored name is still checked against the saved copy, not trusted as clean', async () => {
        // The whole reason only the name is stored: a layout that changed while
        // this character was away must read as edited, not as clean because it
        // was clean when the name was written
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');
        await reload();

        // The screen drifts from what "Dungeon" was saved as
        overlayPanel.settings.span = { dps: 2, luck: 2 };
        const picker = openGear();
        const line = picker.querySelector('[data-overlay-active-layout]');
        await vi.waitFor(() => expect(line.textContent).toBe('Showing: Dungeon (edited)'));
    });

    test('an unedited restored name says so, with no marker', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');
        await reload();

        const picker = openGear();
        const line = picker.querySelector('[data-overlay-active-layout]');
        // Give the drift check its beat; it must decide "clean" and leave it
        await Promise.resolve();
        await Promise.resolve();
        expect(line.textContent).toBe('Showing: Dungeon');
    });

    test('deleting the layout in force clears the name, and the reload agrees', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        dialog.answer = 'Dungeon';
        await overlayPanel._promptDeleteLayout(document.createElement('select'));

        expect(overlayPanel.appliedLayout).toBeNull();
        await reload();
        expect(overlayPanel.appliedLayout).toBeNull();
    });

    test('deleting a different layout leaves the name alone', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.saveNamedLayout('Market');
        await overlayPanel.applyNamedLayout('Dungeon');

        dialog.answer = 'Market';
        await overlayPanel._promptDeleteLayout(document.createElement('select'));

        expect(overlayPanel.appliedLayout).toBe('Dungeon');
        await reload();
        expect(overlayPanel.appliedLayout).toBe('Dungeon');
    });

    test('Reset puts the tiles back, so no named layout is in force any more', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        dialog.answer = 'reset';
        await overlayPanel._resetLayout();

        expect(overlayPanel.appliedLayout).toBeNull();
        await reload();
        expect(overlayPanel.appliedLayout).toBeNull();
    });

    test('a cancelled Reset changes nothing', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        dialog.answer = null;
        await overlayPanel._resetLayout();

        expect(overlayPanel.appliedLayout).toBe('Dungeon');
    });
});

/**
 * A reload used to make three scoped reads one after another — the layout, the
 * pre-migration layout, and the applied layout's name — each its own readonly
 * transaction, and up to two where the bare key had to be checked. At start-up
 * every one of those queues behind a dozen other features' reads.
 */
describe('what a reload costs the settings store', () => {
    test('the whole start-up read is one transaction, carrying every key', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        store.transactions = [];
        scoped.unbatched = [];
        await reload();

        expect(store.transactions).toHaveLength(1);
        expect(store.transactions[0]).toEqual([
            'overlayPanelV2_scoped',
            'overlayPanelV2',
            'overlayPanel_scoped',
            'overlayPanel',
            'overlayAppliedLayout_scoped',
            'overlayAppliedLayout',
        ]);
        expect(scoped.unbatched).toEqual([]);
    });

    test('and the name still comes back off it', async () => {
        wear(dungeonLayout());
        await overlayPanel.saveNamedLayout('Dungeon');
        await overlayPanel.applyNamedLayout('Dungeon');

        await reload();

        expect(overlayPanel.appliedLayout).toBe('Dungeon');
    });
});
