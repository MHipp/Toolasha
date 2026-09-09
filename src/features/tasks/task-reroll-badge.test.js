/** @vitest-environment happy-dom */
/**
 * The reroll spend badge's arithmetic, and the one piece of wiring that is not
 * arithmetic: whether the badge appears on a Tasks panel that is already open.
 *
 * The one thing worth getting wrong here is scope: the live map keeps a
 * just-retired task for a grace window (see `task-reroll-tracker.js`), and a
 * sum that did not filter by the active id set would count it twice — once on
 * its own card before it left, and again in the badge after.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'taskRerollSpendBadge',
        onSettingChange: () => {},
        COLOR_LOSS: '#ef4444',
    },
}));
// The observer reports elements that *appear*; a no-op here is exactly the
// production behaviour for a panel that was already on the page.
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
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterQuests() {
            return board.quests;
        },
    },
}));

const board = { quests: [] };

const {
    default: taskRerollBadge,
    sumBoardRerollSpend,
    formatRerollSpendBadge,
} = await import('./task-reroll-badge.js');

describe('sumBoardRerollSpend', () => {
    const quest = (id, coin, cowbell) => ({ id, coinRerollCount: coin, cowbellRerollCount: cowbell });

    test('sums gold and cowbells across the active tasks only', () => {
        const taskRerollData = new Map([
            [1, { coinRerollCount: 2, cowbellRerollCount: 0 }], // 10K + 20K = 30K
            [2, { coinRerollCount: 0, cowbellRerollCount: 2 }], // 1 + 2 = 3
            [3, { coinRerollCount: 5, cowbellRerollCount: 5 }], // retired, not counted
        ]);
        const activeQuests = [quest(1, 0, 0), quest(2, 0, 0)];

        expect(sumBoardRerollSpend(taskRerollData, activeQuests)).toEqual({ gold: 30000, cowbells: 3 });
    });

    test('a task with no reroll data yet contributes nothing', () => {
        const taskRerollData = new Map([[1, { coinRerollCount: 0, cowbellRerollCount: 0 }]]);
        expect(sumBoardRerollSpend(taskRerollData, [quest(1, 0, 0)])).toEqual({ gold: 0, cowbells: 0 });
    });

    test('an empty board is zero, not a throw', () => {
        expect(sumBoardRerollSpend(new Map(), [])).toEqual({ gold: 0, cowbells: 0 });
        expect(sumBoardRerollSpend(null, null)).toEqual({ gold: 0, cowbells: 0 });
    });

    test('an untracked quest falls back to the server payload rather than reading zero', () => {
        // The tracker loads its map behind an await; a board summed before
        // that lands has no tracked entries at all, and the map alone would
        // render a rerolled board as "spent nothing"
        expect(sumBoardRerollSpend(new Map(), [quest(1, 2, 0), quest(2, 0, 2)])).toEqual({
            gold: 30000,
            cowbells: 3,
        });
        // The whole map missing is the same case, one step earlier
        expect(sumBoardRerollSpend(undefined, [quest(1, 2, 0)])).toEqual({ gold: 30000, cowbells: 0 });
    });

    test('a tracked count wins over the server payload', () => {
        // The tracker carries rerolls the payload has not caught up on
        const taskRerollData = new Map([[1, { coinRerollCount: 2, cowbellRerollCount: 0 }]]);
        expect(sumBoardRerollSpend(taskRerollData, [quest(1, 0, 0)])).toEqual({ gold: 30000, cowbells: 0 });
    });

    test('a tracked zero stays zero instead of collapsing into the payload', () => {
        // `??`, not `||`: tracked-zero and untracked are different things, and
        // a task the tracker knows has no rerolls must not re-read the payload
        const taskRerollData = new Map([[1, { coinRerollCount: 0, cowbellRerollCount: 0 }]]);
        expect(sumBoardRerollSpend(taskRerollData, [quest(1, 5, 5)])).toEqual({ gold: 0, cowbells: 0 });
    });

    test('each currency falls back on its own', () => {
        const taskRerollData = new Map([[1, { coinRerollCount: 2 }]]);
        expect(sumBoardRerollSpend(taskRerollData, [quest(1, 5, 2)])).toEqual({ gold: 30000, cowbells: 3 });
    });
});

describe('formatRerollSpendBadge', () => {
    test('nothing spent draws nothing', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 0 })).toBe('');
    });

    test('gold only', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 0 })).toBe('Rerolls: 30.0K\u{1f4b0}');
    });

    test('cowbells only', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 3 })).toBe('Rerolls: 3\u{1f514}');
    });

    test('both currencies, cowbells first', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 3 })).toBe('Rerolls: 3\u{1f514} + 30.0K\u{1f4b0}');
    });
});

describe('appearing on a panel that is already open', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        board.quests = [];
        taskRerollBadge.disable();
    });

    test('initialize() draws onto a task slot count that is already on the page', () => {
        // domObserver.onClass only fires for elements that appear after
        // registration — it does not scan the existing DOM. Ticking the setting
        // on while the Tasks panel is open is therefore an initialize() with
        // nothing to react to, and without an immediate pass the badge stays
        // missing until the panel is navigated away from and back.
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        taskRerollBadge.initialize();

        expect(header.querySelector('.toolasha-reroll-spend-badge')).not.toBeNull();
    });

    test('the badge is right before the tracker map arrives, and stays right after', async () => {
        // The catch-up pass draws the moment the badge initializes, which can
        // be before the tracker's storage load resolves. Without the payload
        // fallback that first draw reads an empty map as "spent nothing" and
        // stays wrong until the next task-list mutation.
        const { default: taskRerollTracker } = await import('./task-reroll-tracker.js');
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        board.quests = [
            {
                id: 1,
                category: '/quest_category/random_task',
                status: '/quest_status/in_progress',
                coinRerollCount: 2,
                cowbellRerollCount: 0,
            },
        ];
        const savedData = taskRerollTracker.taskRerollData;
        taskRerollTracker.taskRerollData = new Map();
        try {
            taskRerollBadge.initialize();
            const badge = header.querySelector('.toolasha-reroll-spend-badge');
            expect(badge.textContent).toBe('Rerolls: 30.0K\u{1f4b0}');

            // The load lands, carrying a reroll the payload had not caught up on
            taskRerollTracker.taskRerollData = new Map([[1, { coinRerollCount: 3, cowbellRerollCount: 0 }]]);
            taskRerollBadge._render();
            expect(badge.textContent).toBe('Rerolls: 70.0K\u{1f4b0}');
        } finally {
            taskRerollTracker.taskRerollData = savedData;
        }
    });

    test('an unchanged spend leaves the badge’s text node alone', async () => {
        const { default: taskRerollTracker } = await import('./task-reroll-tracker.js');
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        board.quests = [{ id: 1, category: '/quest_category/random_task', status: '/quest_status/in_progress' }];
        const savedData = taskRerollTracker.taskRerollData;
        taskRerollTracker.taskRerollData = new Map([[1, { coinRerollCount: 2, cowbellRerollCount: 0 }]]);
        try {
            taskRerollBadge.initialize();
            const badge = header.querySelector('.toolasha-reroll-spend-badge');
            expect(badge.textContent).toContain('Rerolls');
            const textNode = badge.firstChild;

            // The observer fires for every task-list mutation; the same spend
            // must not rewrite the text node it would only replace in kind
            taskRerollBadge._render();
            expect(badge.firstChild).toBe(textNode);
        } finally {
            taskRerollTracker.taskRerollData = savedData;
        }
    });
});
