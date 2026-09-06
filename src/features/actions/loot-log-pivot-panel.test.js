/**
 * @vitest-environment happy-dom
 *
 * The pivot panel, built rather than reasoned about.
 *
 * The arithmetic has its own file; what this one is for is the thing arithmetic
 * cannot catch — a helper renamed on `lootLogStats`, a formatter that stopped
 * being exported, a property read off a row that no longer has it. `simple-panel`
 * catches a failed draw and writes it into the body, so the load-bearing
 * assertion in every test here is that the body does not say so.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** What the mocked game and storage serve, swapped between tests */
const world = vi.hoisted(() => ({ history: [], skills: {}, settingOn: true, askPerDrop: 2 }));

/** How many times the panel summed the history, so the memo can be pinned */
const analytics = vi.hoisted(() => ({ aggregateCalls: 0 }));
vi.mock('./loot-log-analytics.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        aggregatePivotRows: (entries) => {
            analytics.aggregateCalls += 1;
            return actual.aggregatePivotRows(entries);
        },
    };
});

/** The data manager's bus, reduced to the one event the feature listens for */
const bus = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char-1',
        getInitClientData: () => ({ skillDetailMap: world.skills }),
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

// Geometry lives in IndexedDB, which is never what a panel test is about
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    clampPanelToViewport: () => null,
    markPanelInteracted: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => world.settingOn,
        getSettingValue: (_key, fallback) => fallback,
        Z_FLOATING_PANEL: 9000,
    },
}));

const socket = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            (socket.handlers[type] ||= []).push(handler);
        },
        off: (type, handler) => {
            socket.handlers[type] = (socket.handlers[type] || []).filter((h) => h !== handler);
        },
    },
}));

const observers = vi.hoisted(() => ({ registered: [] }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            observers.registered.push({ name, className, callback });
            return () => {};
        },
    },
}));

vi.mock('./loot-log-history.js', () => ({
    default: { _load: async () => world.history },
}));

// The real one drags in the enhancement calculators and the market; what the
// panel actually needs from it is four small methods
vi.mock('./loot-log-stats.js', () => ({
    default: {
        // Two coins per item at ask, one at bid, so a row's Value is predictable
        calculateTotalValue: (drops) => {
            const count = Object.values(drops || {}).reduce((sum, n) => sum + n, 0);
            return { askTotal: count * world.askPerDrop, bidTotal: count };
        },
        getActionName: (hrid) => hrid.split('/').pop().replace(/_/g, ' '),
        getActionCategory: (hrid) => hrid.split('/')[2] || null,
        buildItemBreakdown: (drops) => {
            const div = document.createElement('div');
            div.className = 'breakdown';
            div.textContent = Object.keys(drops || {}).join(',');
            return div;
        },
    },
}));

const { default: dataManager } = await import('../../core/data-manager.js');
const {
    default: lootLogPivot,
    lootLogPivotPanel,
    injectPivotButton,
    resetPivotState,
    PAGE_SIZE,
    COLUMNS,
} = await import('./loot-log-pivot-panel.js');

const HOUR = 3_600_000;

/**
 * A stored loot log entry.
 * @param {Object} fields - What this one differs by
 * @returns {Object}
 */
function entry(fields = {}) {
    return {
        characterActionId: 1,
        actionHrid: '/actions/milking/cow',
        startTime: '2026-09-01T00:00:00Z',
        endTime: '2026-09-01T01:00:00Z',
        totalActiveMillis: HOUR,
        actionCount: 100,
        drops: { '/items/milk': 100 },
        xpGains: { '/skills/milking': 3000 },
        ...fields,
    };
}

/** @returns {string} Everything the open panel says */
const text = () => lootLogPivotPanel.panel?.textContent || '';

/** @returns {Array<HTMLElement>} The table's data rows */
const bodyRows = () => Array.from(lootLogPivotPanel.panel?.querySelectorAll('tbody tr') || []);

/**
 * Open the panel and let the history read resolve into a second draw.
 * @returns {Promise<void>}
 */
async function open() {
    lootLogPivotPanel.show({ remember: false });
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    world.history = [];
    world.skills = {
        '/skills/milking': { name: 'Milking', sortIndex: 1 },
        '/skills/attack': { name: 'Attack', sortIndex: 2 },
        '/skills/defense': { name: 'Defense', sortIndex: 3 },
    };
    world.settingOn = true;
    world.askPerDrop = 2;
    analytics.aggregateCalls = 0;
    socket.handlers = {};
    observers.registered = [];
    bus.handlers = {};
    resetPivotState();
});

afterEach(() => {
    lootLogPivotPanel.hide({ remember: false });
    resetPivotState();
    document.body.replaceChildren();
});

describe('drawing the pivot', () => {
    test('an empty history draws the panel and says there is nothing yet', async () => {
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Nothing recorded yet');
        expect(bodyRows()).toHaveLength(0);
    });

    test('one row per action, with its rates, and nothing fails to draw', async () => {
        world.history = [
            entry({ characterActionId: 1 }),
            entry({ characterActionId: 2, totalActiveMillis: HOUR, actionCount: 50 }),
        ];
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(bodyRows()).toHaveLength(1);
        // 150 actions over two hours, 200 milk at 2/1 → 400 ask, 200 bid
        expect(text()).toContain('2 sessions');
        expect(text()).toContain('400 / 200');
        // 6,000 XP over two hours
        expect(text()).toContain('3.0K/hr');
    });

    test('an action at two difficulty tiers is two rows, each labelled', async () => {
        world.history = [
            entry({ characterActionId: 1, actionHrid: '/actions/combat/dungeon', difficultyTier: 1 }),
            entry({ characterActionId: 2, actionHrid: '/actions/combat/dungeon', difficultyTier: 3 }),
        ];
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(bodyRows()).toHaveLength(2);
        expect(text()).toContain('(Tier 1)');
        expect(text()).toContain('(Tier 3)');
    });

    test('a multi-skill action gets a summed XP line and a single-skill one does not', async () => {
        world.history = [
            entry({
                characterActionId: 1,
                actionHrid: '/actions/combat/zone',
                xpGains: { '/skills/attack': 1000, '/skills/defense': 3000 },
            }),
        ];
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(lootLogPivotPanel.panel.querySelectorAll('.mwi-loot-log-xp-total')).toHaveLength(1);
        expect(text()).toContain('Total');

        lootLogPivotPanel.hide({ remember: false });
        resetPivotState();
        world.history = [entry({ characterActionId: 2 })];
        await open();
        expect(lootLogPivotPanel.panel.querySelectorAll('.mwi-loot-log-xp-total')).toHaveLength(0);
    });

    test('a run with no elapsed time draws zeroes rather than Infinity', async () => {
        world.history = [entry({ totalActiveMillis: 0, startTime: null, endTime: null })];
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).not.toContain('Infinity');
        expect(text()).not.toContain('NaN');
    });

    test('the live session merges over the stored copy of the same action', async () => {
        world.history = [entry({ characterActionId: 7, actionCount: 10 })];
        await lootLogPivot.initialize();
        socket.handlers.loot_log_updated[0]({ lootLog: [entry({ characterActionId: 7, actionCount: 900 })] });
        await open();

        expect(text()).not.toContain('could not be drawn');
        expect(bodyRows()).toHaveLength(1);
        expect(text()).toContain('900');
    });

    test('the money columns show ask and bid rather than one pricing-mode figure', async () => {
        world.history = [entry()];
        await open();

        const headings = Array.from(lootLogPivotPanel.panel.querySelectorAll('th')).map((th) => th.textContent);
        expect(headings.join(' ')).toContain('Value (ask/bid)');
        expect(headings.join(' ')).toContain('Gold/hr (ask/bid)');
    });
});

describe('re-summing the history', () => {
    // The cap went from 500 sessions to 2,000, and summing a full one is ~13 ms. A
    // keystroke in the filter box and a click on a heading each re-render, and neither
    // changes an entry, so neither has any business re-summing them.
    test('filtering and sorting reuse the aggregation instead of re-summing', async () => {
        world.history = [
            entry({ characterActionId: 1, actionHrid: '/actions/milking/cow' }),
            entry({ characterActionId: 2, actionHrid: '/actions/brewing/tea' }),
        ];
        await open();
        const afterFirstDraw = analytics.aggregateCalls;
        expect(afterFirstDraw).toBeGreaterThan(0);

        const box = lootLogPivotPanel.panel.querySelector('input[type="text"]');
        for (const value of ['t', 'te', 'tea']) {
            box.value = value;
            box.dispatchEvent(new Event('input'));
        }
        Array.from(lootLogPivotPanel.panel.querySelectorAll('th'))
            .find((th) => th.textContent.startsWith('Actions'))
            .click();

        expect(analytics.aggregateCalls).toBe(afterFirstDraw);
        expect(bodyRows()).toHaveLength(1);
        expect(text()).not.toContain('could not be drawn');
    });

    test('a new loot message is re-summed rather than served from the memo', async () => {
        world.history = [entry({ characterActionId: 1, actionCount: 10 })];
        await lootLogPivot.initialize();
        await open();
        const before = analytics.aggregateCalls;

        socket.handlers.loot_log_updated[0]({ lootLog: [entry({ characterActionId: 2, actionCount: 900 })] });
        lootLogPivotPanel.render();

        expect(analytics.aggregateCalls).toBeGreaterThan(before);
        expect(text()).toContain('910');
        expect(text()).not.toContain('could not be drawn');
    });

    test('prices are resolved per draw, so a market move lands without an entry changing', async () => {
        world.history = [entry({ drops: { '/items/milk': 100 } })];
        await open();
        expect(text()).toContain('200 / 100');

        world.askPerDrop = 5;
        lootLogPivotPanel.render();

        expect(text()).toContain('500 / 100');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('sorting, filtering and paging', () => {
    test('clicking a heading sorts by it, and clicking again reverses', async () => {
        world.history = [
            entry({ characterActionId: 1, actionHrid: '/actions/milking/cow', actionCount: 10 }),
            entry({ characterActionId: 2, actionHrid: '/actions/milking/zebra', actionCount: 900 }),
        ];
        await open();

        const named = () => bodyRows().map((tr) => tr.firstChild.textContent);
        const heading = (label) =>
            Array.from(lootLogPivotPanel.panel.querySelectorAll('th')).find((th) => th.textContent.startsWith(label));

        heading('Actions').click();
        expect(named()[0]).toContain('zebra');
        heading('Actions').click();
        expect(named()[0]).toContain('cow');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the filter box narrows the table and the footer follows it', async () => {
        world.history = [
            entry({ characterActionId: 1, actionHrid: '/actions/milking/cow', actionCount: 10 }),
            entry({ characterActionId: 2, actionHrid: '/actions/brewing/tea', actionCount: 900 }),
        ];
        await open();
        expect(bodyRows()).toHaveLength(2);

        const box = lootLogPivotPanel.panel.querySelector('input[type="text"]');
        box.value = 'tea';
        box.dispatchEvent(new Event('input'));

        expect(bodyRows()).toHaveLength(1);
        expect(text()).toContain('tea');
        expect(text()).not.toContain('cow');
        expect(text()).not.toContain('could not be drawn');
    });

    test('past a page of actions the rest are behind a Show more', async () => {
        world.history = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
            entry({ characterActionId: i + 1, actionHrid: `/actions/milking/cow_${i}` })
        );
        await open();

        expect(bodyRows()).toHaveLength(PAGE_SIZE);
        const more = Array.from(lootLogPivotPanel.panel.querySelectorAll('button')).find((b) =>
            b.textContent.startsWith('Show ')
        );
        expect(more).toBeTruthy();

        more.click();
        expect(bodyRows()).toHaveLength(PAGE_SIZE + 5);
        expect(text()).not.toContain('could not be drawn');
    });

    test('clicking a row folds out its date range and item breakdown, and folds it back', async () => {
        world.history = [entry()];
        await open();

        bodyRows()[0].click();
        expect(lootLogPivotPanel.panel.querySelector('.breakdown')?.textContent).toBe('/items/milk');
        expect(text()).not.toContain('could not be drawn');

        bodyRows()[0].click();
        expect(lootLogPivotPanel.panel.querySelector('.breakdown')).toBeNull();
    });

    test('every column can be sorted without a draw failing', async () => {
        world.history = [
            entry({ characterActionId: 1, actionHrid: '/actions/milking/cow' }),
            entry({ characterActionId: 2, actionHrid: '/actions/brewing/tea', xpGains: {}, drops: {} }),
        ];
        await open();

        for (const column of COLUMNS) {
            const th = Array.from(lootLogPivotPanel.panel.querySelectorAll('th')).find((cell) =>
                cell.textContent.startsWith(column.label)
            );
            th.click();
            expect(text()).not.toContain('could not be drawn');
        }
    });
});

describe('the button and the feature lifecycle', () => {
    /**
     * The game's loot log panel, with its Refresh button.
     * @returns {HTMLElement} The `actionLoots` container the observer fires on
     */
    function gamePanel() {
        const panel = document.createElement('div');
        panel.className = 'LootLogPanel_lootLogPanel__2013X';
        const refresh = document.createElement('button');
        refresh.textContent = 'Refresh';
        const container = document.createElement('div');
        container.className = 'LootLogPanel_actionLoots__3oTid';
        panel.append(refresh, container);
        document.body.appendChild(panel);
        return container;
    }

    test('the button lands after Refresh, once, and opens the panel', () => {
        const container = gamePanel();

        injectPivotButton(container);
        injectPivotButton(container);

        const buttons = document.querySelectorAll('.mwi-loot-log-pivot-btn');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].previousElementSibling.textContent).toBe('Refresh');

        buttons[0].click();
        expect(lootLogPivotPanel.panel).toBeTruthy();
    });

    test('a loot log panel with no Refresh button gets no button', () => {
        const container = gamePanel();
        container.parentElement.querySelector('button').remove();

        injectPivotButton(container);
        expect(document.querySelectorAll('.mwi-loot-log-pivot-btn')).toHaveLength(0);
    });

    test('the feature stays out of the way when its setting is off', async () => {
        world.settingOn = false;
        await lootLogPivot.initialize();

        expect(observers.registered).toHaveLength(0);
        expect(socket.handlers.loot_log_updated).toBeUndefined();
    });

    test('cleanup removes the button, closes the panel and drops the handlers', async () => {
        const container = gamePanel();
        await lootLogPivot.initialize();
        expect(observers.registered).toHaveLength(1);

        injectPivotButton(container);
        await open();
        expect(lootLogPivotPanel.panel).toBeTruthy();

        lootLogPivot.cleanup();

        expect(lootLogPivotPanel.panel).toBeNull();
        expect(document.querySelectorAll('.mwi-loot-log-pivot-btn')).toHaveLength(0);
        expect(socket.handlers.loot_log_updated).toHaveLength(0);
    });

    test('a character switch does not carry the previous character’s runs over', async () => {
        world.history = [entry()];
        await lootLogPivot.initialize();
        socket.handlers.loot_log_updated[0]({ lootLog: [entry({ characterActionId: 55 })] });
        await open();
        expect(bodyRows()).toHaveLength(1);

        world.history = [];
        dataManager.emit('character_switched');
        // The shell's own switch handler closes the panel; this file's mocked bus
        // is wired fresh per test, so the close is done explicitly here
        lootLogPivotPanel.hide({ remember: false });
        await open();

        expect(text()).toContain('Nothing recorded yet');
        expect(text()).not.toContain('could not be drawn');
    });
});
