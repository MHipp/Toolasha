/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Geometry lives in IndexedDB and is never what these tests are about
const geometry = vi.hoisted(() => ({ saveOpenState: vi.fn(async () => {}), reopen: vi.fn(async () => {}) }));
vi.mock('./panel-geometry.js', () => ({
    restoreGeometry: vi.fn(),
    saveGeometry: vi.fn(),
    saveOpenState: geometry.saveOpenState,
    wasOpen: async () => false,
    reopenIfLeftOpen: (key, reopen) => geometry.reopen(key, reopen),
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
}));

/** The data manager's event bus, reduced to the one event these panels listen for */
const bus = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));

// The stacking order and the opening cascade are panel-z-index's own tests;
// here they only need to be askable and to be seen to be used
const stacking = vi.hoisted(() => ({ frontmost: true, opening: { left: 170, top: 170 } }));
vi.mock('./panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
    isPanelFrontmost: vi.fn(() => stacking.frontmost),
    cascadedPanelPosition: vi.fn(() => stacking.opening),
}));

vi.mock('./floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: vi.fn(() => vi.fn()),
    makeResizable: vi.fn(() => vi.fn()),
}));

// The real minimize control folds the panel and persists the choice; the tests
// below only need to say whether it is folded, and to be handed the toggle
const minimize = vi.hoisted(() => ({ collapsed: false, onToggle: null, setCollapsed: null }));
vi.mock('./panel-minimize.js', () => ({
    attachMinimize: ({ onToggle }) => {
        minimize.onToggle = onToggle;
        minimize.setCollapsed = vi.fn();
        return {
            get collapsed() {
                return minimize.collapsed;
            },
            setCollapsed: minimize.setCollapsed,
            destroy: vi.fn(),
        };
    },
}));

const { createPanel, panelCard, panelLine, panelNote } = await import('./simple-panel.js');
const { restoreGeometry } = await import('./panel-geometry.js');
const { holdEscapeWhile } = await import('./panel-escape.js');
const { bringPanelToFront, cascadedPanelPosition } = await import('./panel-z-index.js');
const { default: dataManager } = await import('../core/data-manager.js');

const SIZE = { width: 300, height: 200 };

// `minimize` is one hoisted object shared by every panel the file builds, and
// the fold state is read live through a getter — so a test that folds a panel
// and ends there leaves every later panel folded, and `refresh()` skips a body
// it thinks nobody can see. Put it back before each test rather than in the one
// block that happens to fold.
beforeEach(() => {
    minimize.collapsed = false;
    minimize.onToggle = null;
    minimize.setCollapsed = null;
    stacking.frontmost = true;
    stacking.opening = { left: 170, top: 170 };
    restoreGeometry.mockReset();
});

describe('createPanel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('toggle opens and closes', () => {
        const panel = createPanel({ id: 'test', title: 'Test', size: SIZE, draw: (body) => body.append('hello') });

        panel.toggle();
        expect(document.getElementById('toolasha-test-panel')).toBeTruthy();
        expect(panel.panel.textContent).toContain('hello');

        panel.toggle();
        expect(document.getElementById('toolasha-test-panel')).toBeNull();
        expect(panel.panel).toBeNull();
    });

    test('showing an open panel raises it rather than opening a second one', () => {
        const panel = createPanel({ id: 'twice', title: 'Twice', size: SIZE, draw: () => {} });

        panel.show();
        panel.show();
        expect(document.querySelectorAll('#toolasha-twice-panel')).toHaveLength(1);
        panel.hide();
    });

    test('a draw that throws says so instead of leaving an empty panel', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = createPanel({
            id: 'broken',
            title: 'Broken',
            size: SIZE,
            draw: () => {
                throw new Error('no data');
            },
        });

        panel.show();
        expect(panel.panel.textContent).toContain('could not be drawn');
        expect(panel.panel.textContent).toContain('no data');

        panel.hide();
        spy.mockRestore();
    });

    test('closing stops the refresh, so a hidden panel does no work', () => {
        const draw = vi.fn();
        const panel = createPanel({ id: 'timer', title: 'Timer', size: SIZE, refreshMs: 1000, draw });

        panel.show();
        vi.advanceTimersByTime(3000);
        const drawsWhileOpen = draw.mock.calls.length;
        expect(drawsWhileOpen).toBeGreaterThan(1);

        panel.hide();
        vi.advanceTimersByTime(10_000);
        expect(draw).toHaveBeenCalledTimes(drawsWhileOpen);
    });

    test('a control being used is not rebuilt under the pointer', () => {
        // A refresh rebuilds the body, and rebuilding a select closes its
        // dropdown — scroll a long list for a few seconds and it shuts under you
        const panel = createPanel({
            id: 'busy',
            title: 'Busy',
            size: SIZE,
            refreshMs: 1000,
            draw: (body) => body.appendChild(document.createElement('select')),
        });
        panel.show();

        const select = panel.panel.querySelector('select');
        select.focus();
        vi.advanceTimersByTime(5000);

        // Same element, so nothing was torn down and rebuilt
        expect(panel.panel.querySelector('select')).toBe(select);

        select.blur();
        vi.advanceTimersByTime(1000);
        expect(panel.panel.querySelector('select')).not.toBe(select);
        panel.hide();
    });

    test('the close button closes it', () => {
        const panel = createPanel({ id: 'close', title: 'Close', size: SIZE, draw: () => {} });
        panel.show();

        [...panel.panel.querySelectorAll('button')].find((b) => b.textContent === '✕').click();
        expect(document.getElementById('toolasha-close-panel')).toBeNull();
    });

    test('render on a closed panel is a no-op rather than a crash', () => {
        const draw = vi.fn();
        const panel = createPanel({ id: 'closed', title: 'Closed', size: SIZE, draw });

        expect(() => panel.render()).not.toThrow();
        expect(draw).not.toHaveBeenCalled();
    });
});

describe('panel pieces', () => {
    test('a card appends itself and returns somewhere to put lines', () => {
        const body = document.createElement('div');
        const card = panelCard(body, 'Heading');

        expect(body.children).toHaveLength(1);
        card.appendChild(panelLine('Fights', '12'));
        expect(card.textContent).toContain('Heading');
        expect(card.textContent).toContain('Fights');
        expect(card.textContent).toContain('12');
    });

    test('a note is plain text with nothing to read into it', () => {
        expect(panelNote('Nothing cast yet.').textContent).toBe('Nothing cast yet.');
    });
});

/**
 * When a panel is allowed to redraw.
 *
 * Every panel in the script is one of these, and each rebuilds its whole body on
 * a timer. Twenty-odd of them redrawing a body nobody can see — a background tab,
 * a panel folded to its header — is the same work as redrawing them in front of
 * somebody, for none of the benefit.
 */
describe('a body nobody can see is not redrawn', () => {
    let draw;
    let panel;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        minimize.collapsed = false;
        draw = vi.fn((body) => body.append('something'));
        panel = createPanel({ id: 'unseen', title: 'Unseen', size: SIZE, refreshMs: 1000, draw });
        panel.show();
        draw.mockClear();
    });

    afterEach(() => {
        panel.hide();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('a hidden tab is skipped, and picked up again on return', () => {
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

        vi.advanceTimersByTime(3000);
        expect(draw).not.toHaveBeenCalled();

        hidden.mockReturnValue(false);
        vi.advanceTimersByTime(1000);
        expect(draw).toHaveBeenCalledTimes(1);
    });

    test('a panel folded to its header is skipped', () => {
        minimize.collapsed = true;

        vi.advanceTimersByTime(3000);
        expect(draw).not.toHaveBeenCalled();
    });

    test('unfolding draws at once rather than a refresh later', () => {
        minimize.collapsed = true;
        vi.advanceTimersByTime(1000);
        expect(draw).not.toHaveBeenCalled();

        minimize.collapsed = false;
        minimize.onToggle(false);
        expect(draw).toHaveBeenCalledTimes(1);
    });
});

describe('where a newly opened panel sits', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        bringPanelToFront.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a panel created after another was raised is brought to the front too', () => {
        // The bug: a panel takes the base z-index at create, and every panel
        // raised since the page loaded is already above it — so the panel you
        // just asked for opens behind the ones you did not
        const panel = createPanel({ id: 'late', title: 'Late', size: SIZE, draw: () => {} });

        panel.show();

        expect(bringPanelToFront).toHaveBeenCalledWith(panel.panel);
    });

    test('showing a panel whose element was taken out of the document rebuilds it once', () => {
        const draw = vi.fn();
        const panel = createPanel({ id: 'detached', title: 'Detached', size: SIZE, draw });

        panel.show();
        const first = panel.panel;
        // What the game does to a docked panel when it takes the column away
        first.remove();

        panel.show();
        draw.mockClear();

        vi.advanceTimersByTime(3000);

        // One interval, not two: the old panel's timer was cleared rather than
        // left running alongside the new one
        expect(draw).toHaveBeenCalledTimes(1);
        expect(panel.panel).not.toBe(first);
    });
});

/**
 * Escape closes the panel in front.
 *
 * One document-level listener in `panel-escape.js`, a stack of open panels
 * under it, and three things the keypress must never reach past: a control
 * being typed in, a game modal, and anything of ours holding Escape for
 * itself. Exercised through `createPanel` because that is how every panel
 * joins the stack.
 */
describe('Escape closes the panel in front', () => {
    const escape = (target = document) =>
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        minimize.collapsed = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('the most recently opened panel goes first, and the next keypress peels the next', () => {
        const first = createPanel({ id: 'esc-first', title: 'First', size: SIZE, draw: () => {} });
        const second = createPanel({ id: 'esc-second', title: 'Second', size: SIZE, draw: () => {} });
        first.show();
        second.show();

        escape();
        expect(second.panel).toBeNull();
        expect(first.panel).not.toBeNull();

        escape();
        expect(first.panel).toBeNull();
    });

    test('re-showing an open panel makes it the one Escape closes', () => {
        const behind = createPanel({ id: 'esc-behind', title: 'Behind', size: SIZE, draw: () => {} });
        const front = createPanel({ id: 'esc-front', title: 'Front', size: SIZE, draw: () => {} });
        front.show();
        behind.show();
        // What clicking its hotkey again does to a panel already up
        front.show();

        escape();
        expect(front.panel).toBeNull();
        expect(behind.panel).not.toBeNull();
        behind.hide();
    });

    test('closing by any other gesture leaves Escape pointed at what remains', () => {
        const stays = createPanel({ id: 'esc-stays', title: 'Stays', size: SIZE, draw: () => {} });
        const goes = createPanel({ id: 'esc-goes', title: 'Goes', size: SIZE, draw: () => {} });
        stays.show();
        goes.show();
        // The ✕ rather than Escape — a stale stack entry here would leave the
        // next keypress closing a panel that is already gone, and nothing else
        goes.hide();

        escape();
        expect(stays.panel).toBeNull();
    });

    test('a keystroke aimed at something that takes text is not a close', () => {
        const panel = createPanel({
            id: 'esc-typing',
            title: 'Typing',
            size: SIZE,
            draw: (body) => body.appendChild(document.createElement('input')),
        });
        panel.show();

        escape(panel.panel.querySelector('input'));
        expect(panel.panel).not.toBeNull();

        escape();
        expect(panel.panel).toBeNull();
    });

    test('a game modal on screen owns the keypress', () => {
        const modal = document.createElement('div');
        modal.className = 'Modal_modalContainer__3B80m';
        document.body.appendChild(modal);

        const panel = createPanel({ id: 'esc-modal', title: 'Modal', size: SIZE, draw: () => {} });
        panel.show();

        escape();
        expect(panel.panel).not.toBeNull();

        // The game closed its modal on that same keypress; the next one is ours
        modal.remove();
        escape();
        expect(panel.panel).toBeNull();
    });

    test('a hold keeps Escape off the panels for exactly as long as it is true', () => {
        let popoverUp = true;
        const release = holdEscapeWhile(() => popoverUp);
        const panel = createPanel({ id: 'esc-hold', title: 'Hold', size: SIZE, draw: () => {} });
        panel.show();

        escape();
        expect(panel.panel).not.toBeNull();

        popoverUp = false;
        escape();
        expect(panel.panel).toBeNull();
        release();
    });

    test('an Escape something else already acted on is not acted on twice', () => {
        const panel = createPanel({ id: 'esc-spent', title: 'Spent', size: SIZE, draw: () => {} });
        panel.show();

        const spend = (event) => event.preventDefault();
        document.addEventListener('keydown', spend, true);
        escape(document.body);
        document.removeEventListener('keydown', spend, true);

        expect(panel.panel).not.toBeNull();
        panel.hide();
    });

    test('with every panel shut, a stray Escape has nothing to do and does it quietly', () => {
        const panel = createPanel({ id: 'esc-shut', title: 'Shut', size: SIZE, draw: () => {} });
        panel.show();
        panel.hide();

        expect(() => escape()).not.toThrow();
    });
});

describe('switching character', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        bus.handlers = {};
        geometry.saveOpenState.mockClear();
        geometry.reopen.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('the departing character’s panel is closed without recording a close', () => {
        const panel = createPanel({ id: 'switch', title: 'Switch', size: SIZE, draw: () => {} });
        panel.show();
        geometry.saveOpenState.mockClear();

        dataManager.emit('character_switched', {});

        expect(panel.panel).toBe(null);
        // A switch is not the user closing the panel; writing `false` here would
        // put the departing character's arrangement into the arriving one's flags
        expect(geometry.saveOpenState).not.toHaveBeenCalled();
    });

    test('the arriving character’s reopen pass runs again', () => {
        createPanel({ id: 'switch', title: 'Switch', size: SIZE, draw: () => {} });
        geometry.reopen.mockClear();

        dataManager.emit('character_switched', {});

        expect(geometry.reopen).toHaveBeenCalledWith('switch', expect.any(Function));
    });

    test('a panel the arriving character left open comes back', () => {
        const panel = createPanel({ id: 'switch', title: 'Switch', size: SIZE, draw: () => {} });
        geometry.reopen.mockClear();

        dataManager.emit('character_switched', {});

        // What `reopenIfLeftOpen` does once it has read the new character's flags
        const [, reopen] = geometry.reopen.mock.calls.at(-1);
        reopen();

        expect(panel.panel).not.toBe(null);
        expect(geometry.saveOpenState).not.toHaveBeenCalled();
    });
});

describe('a panel that opens where nothing is already sitting', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        cascadedPanelPosition.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('opens at the cascaded position rather than a hardcoded corner', () => {
        // Every panel used to open at 170,170, so two panels the user had never
        // dragged sat exactly on top of each other and the newer one was
        // invisible unless something happened to raise it
        stacking.opening = { left: 230, top: 230 };
        const panel = createPanel({ id: 'cascaded', title: 'Cascaded', size: SIZE, draw: () => {} });

        panel.show();

        expect(cascadedPanelPosition).toHaveBeenCalledWith(SIZE);
        expect(panel.panel.style.left).toBe('230px');
        expect(panel.panel.style.top).toBe('230px');
    });

    test('saved geometry still wins over the cascade', () => {
        stacking.opening = { left: 230, top: 230 };
        restoreGeometry.mockImplementation((el) => {
            el.style.left = '640px';
            el.style.top = '80px';
        });
        const panel = createPanel({ id: 'remembered', title: 'Remembered', size: SIZE, draw: () => {} });

        panel.show();

        expect(panel.panel.style.left).toBe('640px');
        expect(panel.panel.style.top).toBe('80px');
    });
});

describe('what a panel can say about itself', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a folded panel says it is minimized, and expand unfolds it', () => {
        const panel = createPanel({ id: 'folded', title: 'Folded', size: SIZE, draw: () => {} });
        panel.show();
        minimize.collapsed = true;

        expect(panel.isMinimized()).toBe(true);

        panel.expand();

        expect(minimize.setCollapsed).toHaveBeenCalledWith(false);
    });

    test('a closed panel is neither minimized nor in front', () => {
        const panel = createPanel({ id: 'shut', title: 'Shut', size: SIZE, draw: () => {} });

        expect(panel.isMinimized()).toBe(false);
        expect(panel.isFrontmost()).toBe(false);
    });

    test('an open panel takes its idea of "in front" from the stacking order', () => {
        const panel = createPanel({ id: 'stacked', title: 'Stacked', size: SIZE, draw: () => {} });
        panel.show();

        expect(panel.isFrontmost()).toBe(true);

        stacking.frontmost = false;

        expect(panel.isFrontmost()).toBe(false);
    });
});

/**
 * Letting go of a shell.
 *
 * `createPanel` subscribes to `character_switched` for the life of the shell,
 * so the arriving character gets back the panel they left open. A feature that
 * builds its shell inside `initialize()` and drops the handle in its teardown
 * has no way to release that subscription, and a switch is exactly when both
 * things happen: the old shell's listener stays, a new shell registers another,
 * and the bus grows by one panel per switch for the life of the tab.
 */
describe('releasing a panel shell', () => {
    const switchHandlers = () => bus.handlers.character_switched?.length ?? 0;

    test('destroy removes the shell’s character-switch subscription', () => {
        const before = switchHandlers();
        const panel = createPanel({ id: 'released', title: 'Released', size: SIZE, draw: () => {} });
        expect(switchHandlers()).toBe(before + 1);

        panel.destroy();

        expect(switchHandlers()).toBe(before);
    });

    test('destroy closes an open panel without recording it as closed', () => {
        geometry.saveOpenState.mockClear();
        const panel = createPanel({ id: 'released-open', title: 'Released', size: SIZE, draw: () => {} });
        panel.show({ remember: false });
        expect(panel.isOpen()).toBe(true);

        panel.destroy();

        expect(panel.isOpen()).toBe(false);
        expect(geometry.saveOpenState).not.toHaveBeenCalledWith('released-open', false);
    });

    test('a destroyed shell is inert — no redraw, and destroy again is a no-op', () => {
        const before = switchHandlers();
        const draw = vi.fn();
        const panel = createPanel({ id: 'inert', title: 'Inert', size: SIZE, draw });
        panel.show({ remember: false });
        panel.destroy();
        draw.mockClear();

        for (const handler of bus.handlers.character_switched || []) handler();
        expect(draw).not.toHaveBeenCalled();

        expect(() => panel.destroy()).not.toThrow();
        expect(switchHandlers()).toBe(before);
    });

    test('build-and-release cycles leave the bus where they found it', () => {
        const before = switchHandlers();

        for (let cycle = 0; cycle < 3; cycle++) {
            const panel = createPanel({ id: 'cycled', title: 'Cycled', size: SIZE, draw: () => {} });
            panel.show({ remember: false });
            panel.destroy();
        }

        expect(switchHandlers()).toBe(before);
    });
});
