/**
 * @vitest-environment happy-dom
 *
 * What the once-a-second redraw is allowed to cost.
 *
 * The panel redraws every visible tile on a timer, and it used to redraw them
 * whether or not anything had changed: eleven style writes and a full render per
 * tile per second, with a forced layout on top for the docked case. None of that
 * is visible in a screenshot, so it is asserted here instead — a row that can say
 * "nothing changed" is not re-rendered, and a tile whose position has not moved
 * is not re-styled.
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
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));

const rowDef = vi.hoisted(() => ({ current: null }));

vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => [rowDef.current],
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

/** @returns {HTMLElement} The one tile the mocked row list produces */
function findTile() {
    return [...overlayPanel.panel.querySelectorAll('div')].find((el) => el._grip);
}

/**
 * Count what is written to a tile's inline style from now on.
 * @param {HTMLElement} tile - The tile
 * @returns {{count: number, stop: Function}} A live counter
 */
function countStyleWrites(tile) {
    const WATCHED = ['display', 'gridColumn', 'minHeight', 'fontSize', 'cursor', 'touchAction', 'border'];
    const real = tile.style;
    const held = {};
    for (const property of WATCHED) held[property] = real[property];

    const counter = { count: 0, written: [] };
    const stand = new Proxy(held, {
        set(target, property, value) {
            counter.count += 1;
            counter.written.push(property);
            target[property] = value;
            return true;
        },
    });
    Object.defineProperty(tile, 'style', { get: () => stand, configurable: true });
    counter.stop = () => Object.defineProperty(tile, 'style', { get: () => real, configurable: true });
    return counter;
}

afterEach(() => {
    overlayPanel.hide();
    vi.restoreAllMocks();
});

describe('a row that can say nothing has changed', () => {
    beforeEach(() => {
        overlayPanel.settings.locked = true;
    });

    test('is not re-rendered while its version stands', () => {
        const render = vi.fn((el) => (el.textContent = '27.3%'));
        const version = vi.fn(() => 'v1');
        rowDef.current = { key: 'luck', name: 'Drop Luck', render, version };
        overlayPanel.show();

        expect(render).toHaveBeenCalledTimes(1);

        overlayPanel._renderBody();
        overlayPanel._renderBody();
        expect(render).toHaveBeenCalledTimes(1);
        expect(version).toHaveBeenCalledTimes(3);
        expect(findTile()._content.textContent).toBe('27.3%');
    });

    test('is redrawn the moment the version moves', () => {
        let reading = '27.3%';
        const render = vi.fn((el) => (el.textContent = reading));
        rowDef.current = { key: 'luck', name: 'Drop Luck', render, version: () => reading };
        overlayPanel.show();

        reading = '31.0%';
        overlayPanel._renderBody();

        expect(render).toHaveBeenCalledTimes(2);
        expect(findTile()._content.textContent).toBe('31.0%');
    });

    test('a row without a version is drawn every time, as they all used to be', () => {
        const render = vi.fn((el) => (el.textContent = '27.3%'));
        rowDef.current = { key: 'luck', name: 'Drop Luck', render };
        overlayPanel.show();

        overlayPanel._renderBody();
        overlayPanel._renderBody();

        expect(render).toHaveBeenCalledTimes(3);
    });

    test('a render that threw is tried again next tick rather than trusted', () => {
        let broken = true;
        const render = vi.fn((el) => {
            if (broken) throw new Error('nope');
            el.textContent = 'fine now';
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        rowDef.current = { key: 'luck', name: 'Drop Luck', render, version: () => 'steady' };
        overlayPanel.show();

        broken = false;
        overlayPanel._renderBody();

        expect(render).toHaveBeenCalledTimes(2);
        expect(findTile()._content.textContent).toBe('fine now');
    });
});

describe('the tile styling', () => {
    test('writes nothing when the layout has not moved', () => {
        rowDef.current = { key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') };
        overlayPanel.settings.locked = true;
        overlayPanel.show();

        const tile = findTile();
        const writes = countStyleWrites(tile);
        overlayPanel._renderBody();
        writes.stop();

        expect(writes.count).toBe(0);
    });

    test('still writes what actually changed', () => {
        rowDef.current = { key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') };
        overlayPanel.settings.locked = true;
        overlayPanel.show();

        const tile = findTile();
        expect(tile.style.cursor).toBe('default');

        // Unlocking swaps the cursor, the touch handling and the border
        overlayPanel.settings.locked = false;
        const writes = countStyleWrites(tile);
        overlayPanel._renderBody();
        writes.stop();

        expect(writes.written).toContain('cursor');
        expect(writes.written).toContain('touchAction');

        // And on the real element, with the stand-in out of the way again
        overlayPanel._renderBody();
        expect(tile.style.cursor).toBe('move');
    });

    test('unlocking puts the dashed editing outline on', () => {
        rowDef.current = { key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') };
        overlayPanel.settings.locked = true;
        overlayPanel.show();

        // Read off one side: with a separator rule under the tile the four sides
        // differ, and the `border` shorthand reads back as an empty string
        const tile = findTile();
        expect(tile.style.borderTopStyle).toBe('solid');

        overlayPanel.settings.locked = false;
        overlayPanel._renderBody();
        expect(tile.style.borderTopStyle).toBe('dashed');

        overlayPanel.settings.locked = true;
        overlayPanel._renderBody();
        expect(tile.style.borderTopStyle).toBe('solid');
    });
});
