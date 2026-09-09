/**
 * @vitest-environment happy-dom
 *
 * Docking the overlay into the character column.
 *
 * Floating over the game is the wrong default for a panel that is always up:
 * whatever it covers is covered permanently, and moving it out of the way means
 * moving it somewhere else that is also in the way. Docked, it has its own space
 * and the tab body gives up the height — which only works if the column is
 * turned into a flex column while the panel is in it, and only stays working if
 * the panel is put back after React rebuilds that column.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/floating-panel.js', () => ({
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => [{ key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') }],
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

const DOCK_HOST_CLASS = 'toolasha-overlay-dock-host';

/**
 * The character column as the game builds it: a tab strip and the body it
 * switches, side by side under one container.
 * @returns {HTMLElement} The container the panel should join
 */
function buildColumn() {
    const column = document.createElement('div');
    column.id = 'column';
    column.innerHTML = `
        <div class="TabsComponent_tabsContainer__aB1">
            <div role="tablist">
                <button role="tab">Equipment</button>
                <button role="tab">Inventory</button>
            </div>
        </div>
        <div class="TabsComponent_tabPanelsContainer__cD2"></div>
    `;
    document.body.appendChild(column);
    return column;
}

beforeEach(() => {
    overlayPanel.settings.docked = false;
    overlayPanel.settings.dockHeightPx = null;
    overlayPanel.settings.locked = true;
    window.innerHeight = 900;
});

afterEach(() => {
    overlayPanel.hide();
    document.getElementById('column')?.remove();
});

describe('docked into the character column', () => {
    test('the panel becomes a child of the column, not of the body', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.panel.parentElement).toBe(column);
        expect(overlayPanel.panel.dataset.docked).toBe('true');
    });

    test('the column is marked so the tab body gives up the height', () => {
        // The mark is the whole mechanism: without it the panel is simply a
        // third child and the column grows instead of the inventory shrinking
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('the sheet gives the tab body the leftover height and nothing else', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        const css = document.getElementById('toolasha-overlay-dock').textContent;
        expect(css).toContain('TabsComponent_tabPanelsContainer');
        // A flex item will not shrink under its content without this, so the
        // body would keep its full height and push the panel off the screen
        expect(css).toContain('min-height: 0');
    });

    test('the column is given a height measured against the window', () => {
        // This is the whole fix. The sheet first said `max-height: 100%`, which
        // resolves against a parent with no definite height and so constrains
        // nothing at all — the column grew and the panel hung off the bottom of
        // the screen with its tiles cut in half.
        const column = buildColumn();
        window.innerHeight = 900;
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(Number.parseInt(column.style.height, 10)).toBeGreaterThan(0);
        expect(document.getElementById('toolasha-overlay-dock').textContent).not.toContain('max-height: 100%');
    });

    test('a shorter window gives the column less', () => {
        const column = buildColumn();
        window.innerHeight = 900;
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const tall = Number.parseInt(column.style.height, 10);

        window.innerHeight = 500;
        overlayPanel._fitDock();

        expect(Number.parseInt(column.style.height, 10)).toBeLessThan(tall);
    });

    test('the column is handed back its own height when the panel leaves', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        overlayPanel.hide();

        expect(column.style.height).toBe('');
    });

    test('it is not dragged, since it has nowhere to be dragged to', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.detachDrag).toBeNull();
        expect(overlayPanel.panel.style.position).toBe('relative');
    });

    test('it takes the height it was left at', () => {
        buildColumn();
        window.innerHeight = 2000;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = 300;
        overlayPanel.show();

        expect(overlayPanel.panel.style.height).toBe('300px');
    });

    test('it never takes so much that the inventory has nowhere to draw', () => {
        // A height remembered from a tall window, reopened in a short one, would
        // otherwise leave a column that is entirely overlay
        buildColumn();
        window.innerHeight = 500;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = 40000;
        overlayPanel.show();

        const column = Number.parseInt(document.getElementById('column').style.height, 10);
        const panel = Number.parseInt(overlayPanel.panel.style.height, 10);
        expect(column - panel).toBeGreaterThanOrEqual(140);
    });

    test('until the edge is dragged the height follows the tiles', () => {
        // A fixed starting height is a guess about a layout it has never seen,
        // and a guess that is too small cuts the bottom row of tiles in half —
        // which is exactly what docking used to do
        buildColumn();
        window.innerHeight = 2000;
        overlayPanel.settings.docked = true;
        overlayPanel.settings.dockHeightPx = null;
        overlayPanel.show();

        // happy-dom measures nothing, so the canvas is the only real figure
        // here. Measured rather than read off a style: nothing writes the canvas
        // a height since the grid rework, because the grid works one out.
        Object.defineProperty(overlayPanel.canvasEl, 'scrollHeight', { value: 640, configurable: true });
        overlayPanel._fitDock();

        expect(Number.parseInt(overlayPanel.panel.style.height, 10)).toBeGreaterThanOrEqual(640);
    });

    test('closing it puts the column back the way it was', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        overlayPanel.hide();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(false);
        expect(column.querySelector('#toolasha-overlay-panel')).toBeNull();
    });

    test('it goes back to floating when undocked, and the column is released', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        overlayPanel.toggleDock();

        expect(overlayPanel.settings.docked).toBe(false);
        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(false);
        expect(overlayPanel.panel.parentElement).toBe(document.body);
        expect(overlayPanel.panel.style.position).toBe('fixed');
    });

    test('asked to dock with no column yet, it opens floating rather than not at all', () => {
        // Which is what a reload looks like: the setting is read back before the
        // game has drawn the column it names
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        expect(overlayPanel.panel.parentElement).toBe(document.body);
        expect(overlayPanel.panel.dataset.docked).toBeUndefined();
    });
});

describe('after React rebuilds the column', () => {
    test('the panel is put back into the new one', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        // Switching tabs throws the container away and builds another
        document.getElementById('column').remove();
        const rebuilt = buildColumn();
        overlayPanel._ensureDocked();

        expect(overlayPanel.panel.parentElement).toBe(rebuilt);
        expect(rebuilt.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('a column that kept the panel but lost the mark is marked again', () => {
        const column = buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        column.className = '';
        overlayPanel._ensureDocked();

        expect(column.classList.contains(DOCK_HOST_CLASS)).toBe(true);
    });

    test('with the column gone for good, the switch still opens the overlay', () => {
        // Which is every screen but the inventory on a phone: the column is not
        // rebuilt, it is simply not there, and the docked panel goes with it.
        // The switch then has a panel in hand and nothing on screen, and used to
        // answer a press by "closing" the invisible one
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();

        document.getElementById('column').remove();
        expect(overlayPanel.isOpen).toBe(false);

        overlayPanel.toggle();

        expect(overlayPanel.isOpen).toBe(true);
        expect(overlayPanel.panel.parentElement).toBe(document.body);
    });

    test('reopening it that way does not leave the old one refreshing', () => {
        buildColumn();
        overlayPanel.settings.docked = true;
        overlayPanel.show();
        const first = overlayPanel.refreshId;

        document.getElementById('column').remove();
        overlayPanel.toggle();

        expect(overlayPanel.refreshId).not.toBe(first);
    });

    test('a floating panel is left where it is', () => {
        buildColumn();
        overlayPanel.show();
        overlayPanel._ensureDocked();

        expect(overlayPanel.panel.parentElement).toBe(document.body);
    });
});

describe('saying when it opened and closed', () => {
    test('opening and closing each announce themselves', () => {
        // The tab switch has no other way to know it was closed by its own ✕
        const seen = [];
        const listener = (event) => seen.push(event.detail.open);
        document.addEventListener('toolasha:overlay-visibility', listener);

        overlayPanel.show();
        overlayPanel.hide();
        document.removeEventListener('toolasha:overlay-visibility', listener);

        expect(seen).toEqual([true, false]);
    });
});
