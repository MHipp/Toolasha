/**
 * @vitest-environment happy-dom
 *
 * The layout, now that it is a grid.
 *
 * This replaces `overlay-panel.narrow.test.js` and most of
 * `overlay-panel.stability.test.js`, both of which described behaviours that
 * have stopped being possible rather than merely stopped being wrong. Two tiles
 * cannot overlap, nothing can be drawn past the right edge, nothing can arrive
 * unplaced, and no arrangement can fail to fit a width — none of that is a
 * property to test any more, because none of it is representable.
 *
 * What is left worth asserting is small and is all here: the column count is an
 * integer the panel measures once, a saved layout is the same layout at every
 * width, reading order is document order, and a tile going quiet leaves the flow
 * without taking anything else with it.
 *
 * The tiles are read off the canvas rather than off `settings.order` filtered by
 * `settings.visible`, deliberately. That pair was telling the truth while the
 * panel drew something else once before, and it matters more now, not less: with
 * order and visibility being the whole of the layout it would be very easy to
 * write a suite that only ever checks its own inputs.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

const registry = vi.hoisted(() => ({ rows: [] }));

// Only the registry is stood in for — the empty-tile policy the same module
// exports is the real one, because what a quiet tile does is half of this
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => registry.rows,
    moveRow: (order) => order,
}));
// Mocked for the rest of the file, which never imports anything; the import
// tests below reach for the real reader, because the round trip is the point
vi.mock('../../utils/opanel-config.js', async (importActual) => {
    const real = await importActual();
    return { ...real, toOPanelConfig: () => ({}) };
});
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;
const { COLUMN_MIN, GAP, MAX_SPAN } = await import('../../utils/overlay-flow.js');
const { fromOPanelConfig: realFromOPanelConfig } = await import('../../utils/opanel-config.js');

/**
 * A row that always has something to say.
 * @param {string} key - Row key
 * @param {Object} [size] - Its declared default size
 * @returns {Object} A row definition
 */
function speaking(key, size = { width: 200, height: 30 }) {
    return {
        key,
        name: key,
        defaultVisible: true,
        defaultSize: size,
        render: (element) => (element.textContent = key),
    };
}

/**
 * A row that says nothing until it is told to.
 * @param {string} key - Row key
 * @returns {Object} A row definition with a `quiet` flag on it
 */
function sometimes(key) {
    const row = {
        ...speaking(key),
        tileClass: 'measurement',
        render: (element) => (row.quiet ? element.replaceChildren() : (element.textContent = key)),
    };
    row.quiet = true;
    return row;
}

/**
 * Tell the panel how wide its scroller is. The one measurement in the system.
 * @param {number} outer - The scroller's border box, in pixels
 */
function scrollerIs(outer) {
    for (const property of ['offsetWidth', 'clientWidth']) {
        Object.defineProperty(overlayPanel.scrollEl, property, { value: outer, configurable: true });
    }
    overlayPanel._applyColumns();
    overlayPanel._renderBody();
}

/** The tiles on screen, in the order the document holds them. @returns {string[]} */
function drawn() {
    return [...overlayPanel.canvasEl.querySelectorAll('[data-overlay-row]')]
        .filter((tile) => tile.style.display !== 'none')
        .map((tile) => tile.dataset.overlayRow);
}

/**
 * What the grid says about one tile.
 * @param {string} key - Row key
 * @returns {string} Its `grid-column`
 */
function column(key) {
    return overlayPanel.tiles.get(key).style.gridColumn;
}

beforeEach(() => {
    registry.rows = [];
    overlayPanel.settings = {
        ...overlayPanel.settings,
        version: 2,
        visible: {},
        order: [],
        span: {},
        zoom: {},
        locked: true,
        separators: true,
        textScale: 100,
        curatedDefaults: false,
        emptyTiles: 'auto',
        // The two the measurement depends on. Importing a nine-column layout
        // leaves `columns: 9` in the settings, and an authored count can only
        // raise the answer — so every later test measuring a 464px scroller
        // read nine columns instead of two.
        columns: 2,
        columnsPinned: false,
    };
    // The brake counts across panels, deliberately: a cooldown a reopen could
    // clear is not a cooldown. So a test that trips it on purpose would leave
    // every test after it drawing nothing at all.
    overlayPanel.drawPausedUntil = 0;
    overlayPanel.drawsInWindow = 0;
    overlayPanel.drawWindowAt = 0;
});

afterEach(() => {
    overlayPanel.hide();
    vi.restoreAllMocks();
});

describe('the canvas', () => {
    test('is a grid whose column count is a custom property', () => {
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.display).toBe('grid');
        expect(overlayPanel.canvasEl.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
        expect(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns')).toBe('2');
    });

    test('is told its column count again every time it is rebuilt', () => {
        // The count is memoised so a resize can tell a change from a nudge, and
        // the memo used to outlive the canvas it described: a panel closed and
        // reopened at the same width measured the same count, took the "nothing
        // changed" path, and left the brand-new canvas with no
        // `--overlay-columns` at all — so it fell back to the two in its
        // `repeat()` however wide it was. Four columns pinned by hand is the
        // clearest case, being a count that does not move with the width.
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.settings.columns = 4;
        overlayPanel.settings.columnsPinned = true;
        overlayPanel.show();
        expect(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns')).toBe('4');

        overlayPanel.hide();
        overlayPanel.show();

        expect(overlayPanel.columns).toBe(4);
        expect(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns')).toBe('4');
    });

    test('keeps `minmax(0, 1fr)` rather than a bare `1fr`', () => {
        // Load-bearing: `1fr` is `minmax(auto, 1fr)`, and `auto` lets one long
        // unbreakable item name force its track wider than its share
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.gridTemplateColumns).not.toMatch(/repeat\([^,]+, 1fr\)/);
    });

    test('draws every tile in a row to the height of the tallest', () => {
        // Which used to be computed and written into both of them
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.alignItems).toBe('stretch');
    });

    test('is never given a width or a height of its own', () => {
        // The draw used to write both, which the resize observer then saw — the
        // loop that observer had to be guarded against no longer exists
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.width).toBe('');
        expect(overlayPanel.canvasEl.style.height).toBe('');
    });
});

describe('how many columns there are', () => {
    beforeEach(() => {
        registry.rows = [speaking('a'), speaking('b')];
        overlayPanel.settings.visible = { a: true, b: true };
        overlayPanel.settings.order = ['a', 'b'];
        overlayPanel.show();
    });

    test('two on the panel every preset is written for', () => {
        // The first thing to check: if the default panel ever reads as one
        // column, every preset is wrong
        scrollerIs(464);
        expect(overlayPanel.columns).toBe(2);
    });

    test('one on a phone, more on a wide panel, never past the ceiling', () => {
        scrollerIs(382);
        expect(overlayPanel.columns).toBe(1);

        scrollerIs(712);
        expect(overlayPanel.columns).toBe(3);

        scrollerIs(2600);
        expect(overlayPanel.columns).toBe(MAX_SPAN);
    });

    test('a scrollbar appearing cannot change it', () => {
        // The oscillation of two rounds ago, now unrepresentable: the count is
        // an integer taken from the border box, which a scrollbar does not move
        scrollerIs(2 * COLUMN_MIN + GAP + 40);
        const before = overlayPanel.columns;

        Object.defineProperty(overlayPanel.scrollEl, 'clientWidth', {
            value: overlayPanel.scrollEl.offsetWidth - 15,
            configurable: true,
        });
        overlayPanel._applyColumns();

        expect(overlayPanel.columns).toBe(before);
    });
});

describe('a saved layout', () => {
    beforeEach(() => {
        registry.rows = [speaking('first'), speaking('wide'), speaking('last')];
        overlayPanel.settings.visible = { first: true, wide: true, last: true };
        overlayPanel.settings.order = ['first', 'wide', 'last'];
        overlayPanel.settings.span = { wide: 2 };
        overlayPanel.show();
    });

    test('is drawn in reading order, which is document order', () => {
        expect(drawn()).toEqual(['first', 'wide', 'last']);
    });

    test('gives each tile the columns it asked for', () => {
        scrollerIs(464);
        expect(column('first')).toBe('span 1');
        expect(column('wide')).toBe('span 2');
    });

    test('is the same layout at every width, with no second code path', () => {
        // A span clamps to the columns there are. That is the whole of the
        // narrow-screen story now — no flow, no squeeze, no arrangement that
        // has to be abandoned and re-dealt.
        for (const outer of [382, 464, 712, 2000]) {
            scrollerIs(outer);
            expect(drawn()).toEqual(['first', 'wide', 'last']);
            expect(column('wide')).toBe(`span ${Math.min(2, overlayPanel.columns)}`);
        }
    });

    test('survives a resize without anything being written back to it', () => {
        const before = JSON.stringify({ order: overlayPanel.settings.order, span: overlayPanel.settings.span });

        scrollerIs(382);
        scrollerIs(2000);
        scrollerIs(464);

        expect(JSON.stringify({ order: overlayPanel.settings.order, span: overlayPanel.settings.span })).toBe(before);
    });

    test('carries a height floor from the row rather than a height', () => {
        // Heights are content. The floor is what stops a tile whose figures
        // change every second from resizing the grid under the reader.
        registry.rows = [speaking('roomy', { width: 200, height: 70 })];
        overlayPanel.settings.visible = { roomy: true };
        overlayPanel.settings.order = ['roomy'];
        overlayPanel._renderBody();

        const tile = overlayPanel.tiles.get('roomy');
        expect(tile.style.minHeight).toBe('70px');
        expect(tile.style.height).toBe('');
    });
});

describe('a tile with nothing to say', () => {
    /** @returns {Object} The middle row, with a `quiet` flag on it */
    function threeTiles() {
        const middle = sometimes('middle');
        registry.rows = [speaking('above'), middle, speaking('below')];
        overlayPanel.settings.visible = { above: true, middle: true, below: true };
        overlayPanel.settings.order = ['above', 'middle', 'below'];
        overlayPanel.show();
        return middle;
    }

    test('keeps its place in the order and names itself', () => {
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'middle', 'below']);
        expect(overlayPanel.tiles.get('middle')._content.textContent).toBe('middle');
    });

    test('leaves the flow entirely when told to hide, and nothing is left behind', () => {
        // Which used to be a trap: a vanished tile left its coordinates behind
        // as a hole. On a grid, `display: none` closes the flow perfectly.
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel.settings.emptyTiles = 'hide';
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'below']);
        expect(overlayPanel.tiles.get('middle').style.display).toBe('none');
    });

    test('comes back into the flow the moment it has something to say', () => {
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel.settings.emptyTiles = 'hide';
        overlayPanel._renderBody();
        expect(drawn()).toEqual(['above', 'below']);

        middle.quiet = false;
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'middle', 'below']);
    });

    test('filling in and emptying moves nothing around it', () => {
        const middle = threeTiles();

        for (let tick = 0; tick < 8; tick += 1) {
            middle.quiet = tick % 2 === 0;
            overlayPanel._renderBody();

            expect(drawn()).toEqual(['above', 'middle', 'below']);
            expect(column('below')).toBe('span 1');
        }
    });
});

describe('a row the saved order has never heard of', () => {
    test('is drawn after the ones it has, without disturbing them', () => {
        registry.rows = [speaking('known'), speaking('newcomer')];
        overlayPanel.settings.visible = { known: true, newcomer: true };
        overlayPanel.settings.order = ['known'];
        overlayPanel.show();

        expect(drawn()).toEqual(['known', 'newcomer']);
    });

    test('and takes the columns its own row declared', () => {
        registry.rows = [speaking('known'), speaking('broad', { width: 460, height: 30 })];
        overlayPanel.settings.visible = { known: true, broad: true };
        overlayPanel.settings.order = ['known'];
        overlayPanel.show();
        scrollerIs(464);

        expect(column('broad')).toBe('span 2');
    });
});

describe('arranging by hand', () => {
    /**
     * Put three tiles up, unlocked, with rectangles happy-dom will not measure
     * for us — the drag arithmetic is pure given the boxes, so the boxes are
     * what a test has to supply.
     * @returns {Array<HTMLElement>} The tiles, in order
     */
    function threeUnlocked() {
        registry.rows = [speaking('a'), speaking('b'), speaking('c')];
        overlayPanel.settings.visible = { a: true, b: true, c: true };
        overlayPanel.settings.order = ['a', 'b', 'c'];
        overlayPanel.settings.locked = false;
        overlayPanel.show();

        const rects = { a: [0, 0], b: [100, 0], c: [0, 40] };
        for (const [key, [left, top]] of Object.entries(rects)) {
            overlayPanel.tiles.get(key).getBoundingClientRect = () => ({
                left,
                top,
                right: left + 100,
                bottom: top + 40,
                width: 100,
                height: 40,
            });
        }
        return ['a', 'b', 'c'].map((key) => overlayPanel.tiles.get(key));
    }

    /**
     * @param {HTMLElement} tile - What to drag
     * @param {number} x - Where to drop it
     * @param {number} y - Where to drop it
     */
    function drag(tile, x, y) {
        tile.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true }));
        document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        document.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
    }

    test('dragging a tile past another swaps their places in the order', () => {
        const [first] = threeUnlocked();

        // Onto the right half of the second tile
        drag(first, 180, 20);

        expect(overlayPanel.settings.order).toEqual(['b', 'a', 'c']);
        expect(drawn()).toEqual(['b', 'a', 'c']);
    });

    test('dragging to the line below moves it there rather than to the start', () => {
        const [first] = threeUnlocked();

        drag(first, 10, 60);

        expect(overlayPanel.settings.order[overlayPanel.settings.order.indexOf('a')]).toBe('a');
        expect(overlayPanel.settings.order).not.toEqual(['a', 'b', 'c']);
    });

    test('a drop keeps every tile, exactly once', () => {
        const [first] = threeUnlocked();

        drag(first, 500, 500);

        expect([...overlayPanel.settings.order].sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(overlayPanel.settings.order).size).toBe(3);
    });

    test('nothing moves while the layout is locked', () => {
        const [first] = threeUnlocked();
        overlayPanel.settings.locked = true;
        overlayPanel._renderBody();

        drag(first, 180, 20);

        expect(overlayPanel.settings.order).toEqual(['a', 'b', 'c']);
    });

    test('the right-edge handle steps the span in whole columns', () => {
        const [first] = threeUnlocked();
        Object.defineProperty(overlayPanel.canvasEl, 'clientWidth', { value: 200, configurable: true });
        overlayPanel.columns = 2;

        const grip = first._grip;
        grip.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true, clientX: 0 }));
        document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 100, bubbles: true }));
        document.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));

        expect(overlayPanel.settings.span.a).toBe(2);
    });

    test('and never past the columns there are', () => {
        const [first] = threeUnlocked();
        Object.defineProperty(overlayPanel.canvasEl, 'clientWidth', { value: 200, configurable: true });
        overlayPanel.columns = 2;

        const grip = first._grip;
        grip.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true, clientX: 0 }));
        document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 5000, bubbles: true }));
        document.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));

        expect(overlayPanel.settings.span.a).toBe(2);
    });
});

describe('a panel that grew and then shrank again', () => {
    /** Three tiles, the middle one wide enough to want every column there is */
    function wideMiddle() {
        registry.rows = [speaking('a'), speaking('b'), speaking('c')];
        overlayPanel.settings.visible = { a: true, b: true, c: true };
        overlayPanel.settings.order = ['a', 'b', 'c'];
        overlayPanel.settings.span = { b: 3 };
        overlayPanel.show();
    }

    test('the column count comes back down, not only up', () => {
        wideMiddle();

        scrollerIs(712);
        expect(overlayPanel.columns).toBe(3);

        scrollerIs(492);
        expect(overlayPanel.columns).toBe(2);

        scrollerIs(382);
        expect(overlayPanel.columns).toBe(1);
    });

    test('and no tile is left spanning more columns than the grid has', () => {
        // A grid item spanning past the explicit tracks makes the grid create
        // implicit ones, sized to content — which is exactly a canvas that will
        // not come back down and a horizontal scrollbar on everything around it
        wideMiddle();

        for (const outer of [712, 492, 382, 712, 382]) {
            scrollerIs(outer);

            const tracks = Number(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns'));
            for (const key of ['a', 'b', 'c']) {
                const span = Number(column(key).replace('span ', ''));
                expect(span).toBeLessThanOrEqual(tracks);
            }
        }
    });

    test('implicit tracks can never be sized by content', () => {
        // Belt and braces for the same failure: even a span left stale for one
        // frame must not be able to widen the grid past its container
        wideMiddle();
        expect(overlayPanel.canvasEl.style.gridAutoColumns).toBe('minmax(0, 1fr)');
    });
});

describe('importing the layout a pre-rework build exported', () => {
    const file = JSON.parse(readFileSync('src/utils/__fixtures__/overlay-v1-export.json', 'utf8'));

    test('applies it, rather than storing it and drawing the old one', () => {
        const keys = Object.keys(file.toolasha.settings.positions);
        registry.rows = keys.map((key) => speaking(key));
        overlayPanel.settings.visible = Object.fromEntries(keys.map((key) => [key, true]));
        overlayPanel.settings.order = [...keys].reverse();
        overlayPanel.settings.columns = 2;
        overlayPanel.show();

        const read = realFromOPanelConfig(file);
        expect(read).toBeTruthy();
        expect(read.native).toBe(true);

        return overlayPanel._applyLayout(read, 'Import').then(() => {
            // The grid is told the layout's own column count, not the one the
            // last layout happened to use
            expect(overlayPanel.settings.columns).toBe(9);
            expect(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns')).toBe('9');

            // And it is on screen, in the order the file described
            expect(drawn().slice(0, 4)).toEqual(['battleTimer', 'experiencePerHour', 'deathsPerHour', 'combatStatus']);
            expect(column('totalProfit')).toBe('span 6');
            expect(column('combatRevenue')).toBe('span 3');
        });
    });

    test('carries across everything that was never geometry', () => {
        registry.rows = [speaking('battleTimer')];
        overlayPanel.settings.visible = { battleTimer: true };
        overlayPanel.settings.order = ['battleTimer'];
        overlayPanel.show();

        return overlayPanel._applyLayout(realFromOPanelConfig(file), 'Import').then(() => {
            expect(overlayPanel.settings.textScale).toBe(80);
            expect(overlayPanel.settings.zoom.timeToLevel).toBe(100);
            // And drops what has nothing left to mean
            expect(overlayPanel.settings.snapToGrid).toBeUndefined();
            expect(overlayPanel.settings.positions).toBeUndefined();
        });
    });
});

describe('the brake on a runaway redraw', () => {
    /** @returns {number} How many times the panel actually drew */
    function drawsWhile(run) {
        const drawn = vi.spyOn(overlayPanel, '_drawRow');
        drawn.mockClear();
        run();
        const count = drawn.mock.calls.length;
        drawn.mockRestore();
        return count;
    }

    beforeEach(() => {
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();
        overlayPanel.drawPausedUntil = 0;
        overlayPanel.drawsInWindow = 0;
        overlayPanel.drawWindowAt = 0;
    });

    test('a storm of redraws nobody asked for is stopped', () => {
        // A userscript must never be able to freeze the game tab. Whatever the
        // loop turns out to be, this is the floor under it.
        const drew = drawsWhile(() => {
            for (let tick = 0; tick < 200; tick += 1) overlayPanel._renderBody('a test pretending to be a loop');
        });

        expect(drew).toBeLessThanOrEqual(21);
        expect(overlayPanel.drawPausedUntil).toBeGreaterThan(Date.now());
    });

    test('and says what asked for the last one, so the loop can be found', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (let tick = 0; tick < 40; tick += 1) overlayPanel._renderBody('the panel being resized');

        expect(errors).toHaveBeenCalled();
        expect(errors.mock.calls.at(-1).join(' ')).toContain('the panel being resized');
        errors.mockRestore();
    });

    test('a redraw somebody actually asked for is never braked', () => {
        // A preset applied, a row toggled, a drag — these come in bursts and are
        // not loops however fast they go
        const drew = drawsWhile(() => {
            for (let tick = 0; tick < 200; tick += 1) overlayPanel._renderBody();
        });

        expect(drew).toBe(200);
        expect(overlayPanel.drawPausedUntil).toBe(0);
    });

    test('and clears a tally the automatic ones had run up', () => {
        for (let tick = 0; tick < 15; tick += 1) overlayPanel._renderBody('resize');
        expect(overlayPanel.drawsInWindow).toBe(15);

        overlayPanel._renderBody();
        expect(overlayPanel.drawsInWindow).toBe(0);
    });

    test('the panel comes back once the cooldown is over', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        for (let tick = 0; tick < 40; tick += 1) overlayPanel._renderBody('resize');
        expect(drawsWhile(() => overlayPanel._renderBody('resize'))).toBe(0);

        overlayPanel.drawPausedUntil = Date.now() - 1;
        expect(drawsWhile(() => overlayPanel._renderBody('resize'))).toBeGreaterThan(0);
        vi.restoreAllMocks();
    });
});

describe('a resize that the redraw itself causes', () => {
    /**
     * Rows whose render inserts content of a height that changes every time —
     * the closest a test DOM gets to the live case, where a real renderer
     * changing a tile's contents changes the panel's measured size.
     * @param {number} count - How many
     * @returns {Array<Object>} Row definitions
     */
    function restless(count) {
        return Array.from({ length: count }, (_, index) => {
            const row = { ...speaking(`r${index}`), lines: 1 };
            row.render = (element) => {
                element.replaceChildren();
                row.lines = row.lines === 1 ? 3 : 1;
                for (let line = 0; line < row.lines; line += 1) {
                    const div = document.createElement('div');
                    div.textContent = `r${index} line ${line}`;
                    element.appendChild(div);
                }
            };
            return row;
        });
    }

    /**
     * A scroller whose width follows its own content, which is the shape that
     * made the live panel unrecoverable: draw changes content, content changes
     * width, width asks for a draw.
     * @param {number[]} widths - The widths it reports, in turn
     */
    function widthCycles(widths) {
        let at = 0;
        Object.defineProperty(overlayPanel.scrollEl, 'offsetWidth', {
            configurable: true,
            get: () => widths[at++ % widths.length],
        });
    }

    beforeEach(() => {
        registry.rows = restless(8);
        overlayPanel.settings.visible = Object.fromEntries(registry.rows.map((row) => [row.key, true]));
        overlayPanel.settings.order = registry.rows.map((row) => row.key);
        overlayPanel.show();
        overlayPanel.drawPausedUntil = 0;
        overlayPanel.drawsInWindow = 0;
        // Showing the panel books a frame of its own; this suite is about what
        // happens to the bookings after that
        overlayPanel.resizePending = false;
        overlayPanel.dockPending = false;
    });

    test('a redraw cannot ask for another from inside itself', () => {
        // Every observer on the panel checks this, which is what stops a draw
        // that disturbs a watched box from calling the watcher back
        const draws = vi.spyOn(overlayPanel, '_drawBody');
        overlayPanel.redrawing = true;

        overlayPanel._onPanelResized();
        overlayPanel._onDockResized();

        expect(draws).not.toHaveBeenCalled();
        expect(overlayPanel.resizePending).toBe(false);
        overlayPanel.redrawing = false;
        draws.mockRestore();
    });

    test('a width flickering between two values settles instead of alternating', () => {
        // The loop as it actually was: compared against the width it last *saw*,
        // an A/B/A/B measurement differs every time and redraws forever.
        // Compared against the width it last *drew for*, it stops.
        widthCycles([500, 501, 500, 501, 500, 501]);
        overlayPanel.lastWidth = 500;

        const draws = vi.spyOn(overlayPanel, '_drawBody');
        for (let event = 0; event < 6; event += 1) overlayPanel._onPanelResized();

        // Coalesced to one booking a frame, and the deadband swallows the rest
        expect(draws.mock.calls.length).toBeLessThanOrEqual(1);
        draws.mockRestore();
    });

    test('a burst of observations is one redraw, not one each', () => {
        widthCycles([900, 900, 900, 900, 900]);
        overlayPanel.lastWidth = 500;

        // Five observations, one frame booked between them
        let booked = 0;
        const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
            booked += 1;
            return 0;
        });
        for (let event = 0; event < 5; event += 1) overlayPanel._onPanelResized();

        expect(booked).toBe(1);
        frames.mockRestore();
    });

    test('a real redraw that changes every tile does not book another', () => {
        // Rows whose content changes on every render, which is what the live
        // panel had and the null-rendering fixtures did not
        let booked = 0;
        const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
            booked += 1;
            return 0;
        });

        overlayPanel._renderBody();

        // The draw is over, so nothing it disturbed was able to book a frame
        // from inside it, and the brake was never approached
        expect(booked).toBe(0);
        expect(overlayPanel.drawPausedUntil).toBe(0);
        frames.mockRestore();
    });

    test('and the dock no longer watches a box that lives inside what it sizes', () => {
        // `_fitDock` sets the panel's height; the canvas is inside the panel.
        // Observing both is a loop with no exit.
        expect(overlayPanel.dockObserver).toBeTruthy();
        const watched = [];
        overlayPanel.dockObserver.observe = (element) => watched.push(element);
        overlayPanel._watchDock();

        expect(watched).not.toContain(overlayPanel.canvasEl);
    });
});
