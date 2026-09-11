/** @vitest-environment happy-dom
 *
 * Tests for the panel the notice log is read in.
 *
 * The assertion that earns its place is the one that says nothing failed to
 * draw. The panel shell catches a per-panel error and replaces the body with
 * "This could not be drawn", so a renamed helper or an entry shape that changed
 * underneath it produces a panel that opens, looks plausible and contains
 * nothing — which no arithmetic test can catch.
 *
 * Geometry lives in IndexedDB and is never what a test about a list of notices
 * is about, so the panel shell's storage is mocked away.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const log = vi.hoisted(() => ({ entries: [], seenAt: 0 }));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));

vi.mock('./notice-log.js', () => ({
    MAX_ENTRIES: 200,
    loadNoticeLog: vi.fn(async () => {}),
    readNotices: (limit = 200) => log.entries.slice(0, limit),
    noticeCount: () => log.entries.length,
    unreadNoticeCount: () => log.entries.filter((entry) => entry.at > log.seenAt).length,
    markNoticesSeen: vi.fn(() => {
        log.seenAt = Date.now();
    }),
    clearNotices: vi.fn(async () => {
        log.entries = [];
    }),
}));

const { noticePanel, noticeTime, noticeDay, VISIBLE_LIMIT, resetNoticeCategoryFilter } =
    await import('./notice-log-panel.js');
const { registerRow } = await import('../../utils/overlay-rows.js');
const { markNoticesSeen, clearNotices } = await import('./notice-log.js');

// The row is registered once, at import — which is the point of it — so it is
// captured here rather than read in the test, where `clearAllMocks` has been
const registeredRow = registerRow.mock.calls.at(-1)?.[0];

/** One log entry, newest-first order being the caller's problem */
function entry(overrides = {}) {
    return {
        at: Date.now(),
        key: 'market-undercut-1',
        category: 'market',
        subject: 'Cheese',
        text: 'Cheese sell listing undercut: ask now 274K.',
        urgency: 'normal',
        channels: ['toast'],
        ...overrides,
    };
}

/** Everything the open panel says */
function text() {
    return noticePanel.panel?.textContent || '';
}

beforeEach(() => {
    log.entries = [];
    log.seenAt = 0;
    document.body.replaceChildren();
    vi.clearAllMocks();
});

afterEach(() => {
    noticePanel.hide({ remember: false });
    resetNoticeCategoryFilter();
});

describe('drawing', () => {
    test('an empty log says so rather than drawing an empty box', () => {
        noticePanel.show({ remember: false });
        expect(text()).toContain('Nothing has been announced yet');
        expect(text()).not.toContain('could not be drawn');
    });

    test('a notice is drawn with its time, category and message', () => {
        const at = new Date(2026, 4, 17, 14, 7).getTime();
        log.entries = [entry({ at })];

        noticePanel.show({ remember: false });

        expect(text()).toContain('14:07');
        expect(text()).toContain('Market');
        expect(text()).toContain('ask now 274K');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the subject is only repeated when the message does not already carry it', () => {
        log.entries = [
            entry({ subject: 'Cheese', text: 'Cheese undercut.' }),
            entry({ subject: 'Flax', text: 'A listing was undercut.' }),
        ];

        noticePanel.show({ remember: false });
        const rows = noticePanel.panel.querySelectorAll('.toolasha-notice-row');

        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).not.toContain('Cheese — ');
        expect(rows[1].textContent).toContain('Flax — ');
    });

    test('notices are grouped by day', () => {
        const now = Date.now();
        // Yesterday at noon, not "26 hours ago": just after midnight that would
        // be the day before yesterday and carry a date rather than the label
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(12, 0, 0, 0);
        log.entries = [entry({ at: now }), entry({ at: yesterday.getTime() })];

        noticePanel.show({ remember: false });

        expect(text()).toContain('Today');
        expect(text()).toContain('Yesterday');
    });

    test('a critical notice is drawn differently from a routine one', () => {
        log.entries = [entry({ urgency: 'critical', category: 'combat', text: 'You died.' })];

        noticePanel.show({ remember: false });
        const row = noticePanel.panel.querySelector('.toolasha-notice-row');

        expect(row.dataset.noticeUrgency).toBe('critical');
        expect(row.dataset.noticeCategory).toBe('combat');
    });

    test('a notice that reached nothing is marked as such', () => {
        log.entries = [entry({ channels: [] })];

        noticePanel.show({ remember: false });
        const row = noticePanel.panel.querySelector('.toolasha-notice-row');

        expect(row.title).toContain('reached no channel');
    });

    test('a long log is cut to what is worth scrolling', () => {
        log.entries = Array.from({ length: VISIBLE_LIMIT + 40 }, (_, index) => entry({ at: Date.now() - index }));

        noticePanel.show({ remember: false });

        expect(noticePanel.panel.querySelectorAll('.toolasha-notice-row')).toHaveLength(VISIBLE_LIMIT);
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the category filter', () => {
    const chip = (category) => noticePanel.panel.querySelector(`[data-notice-category-chip="${category}"]`);

    test('no chips appear when every visible notice is the same category', () => {
        log.entries = [entry({ category: 'market' }), entry({ category: 'market' })];
        noticePanel.show({ remember: false });

        expect(chip('market')).toBeNull();
    });

    test('a chip per category present, and nothing failed to draw', () => {
        log.entries = [entry({ category: 'market' }), entry({ category: 'combat', text: 'You died.' })];
        noticePanel.show({ remember: false });

        expect(chip('market')).toBeTruthy();
        expect(chip('combat')).toBeTruthy();
        expect(text()).not.toContain('could not be drawn');
    });

    test('clicking a chip narrows the list to the other categories', () => {
        log.entries = [
            entry({ category: 'market', text: 'Cheese undercut.' }),
            entry({ category: 'combat', text: 'You died.' }),
        ];
        noticePanel.show({ remember: false });

        chip('market').click();

        expect(text()).not.toContain('Cheese undercut');
        expect(text()).toContain('You died');
    });

    test('clicking it again brings the category back', () => {
        log.entries = [
            entry({ category: 'market', text: 'Cheese undercut.' }),
            entry({ category: 'combat', text: 'You died.' }),
        ];
        noticePanel.show({ remember: false });

        chip('market').click();
        chip('market').click();

        expect(text()).toContain('Cheese undercut');
        expect(text()).toContain('You died');
    });

    test('hiding every category present says so rather than an empty list', () => {
        log.entries = [
            entry({ category: 'market', text: 'Cheese undercut.' }),
            entry({ category: 'combat', text: 'You died.' }),
        ];
        noticePanel.show({ remember: false });

        chip('market').click();
        chip('combat').click();

        expect(text()).toContain('hidden by the category filter');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('reading and clearing', () => {
    test('opening the panel is reading it', () => {
        log.entries = [entry()];
        noticePanel.show({ remember: false });
        expect(markNoticesSeen).toHaveBeenCalled();
    });

    test('clearing empties the log and redraws', async () => {
        log.entries = [entry()];
        noticePanel.show({ remember: false });

        const clear = [...noticePanel.panel.querySelectorAll('button')].find(
            (button) => button.textContent === 'Clear'
        );
        expect(clear).toBeTruthy();
        clear.click();
        await vi.waitFor(() => expect(clearNotices).toHaveBeenCalled());
        await vi.waitFor(() => expect(text()).toContain('Nothing has been announced yet'));
    });
});

describe('the overlay tile', () => {
    test('it registers a row that opens the panel', () => {
        const row = registeredRow;
        expect(row).toBeTruthy();
        expect(row.key).toBe('noticeLog');
        expect(typeof row.onOpen).toBe('function');
    });

    test('the tile counts what has not been read, and falls back to the total', () => {
        const row = registeredRow;

        const drawTile = () => {
            const container = document.createElement('div');
            row.render(container);
            return container.textContent;
        };

        log.entries = [entry({ at: 10 }), entry({ at: 20 })];
        log.seenAt = 0;
        expect(drawTile()).toBe('2 unread');

        log.seenAt = 30;
        expect(drawTile()).toBe('2 logged');
    });
});

describe('time formatting', () => {
    test('a time is the local hour and minute, zero-padded', () => {
        expect(noticeTime(new Date(2026, 4, 17, 9, 5).getTime())).toBe('09:05');
        expect(noticeTime(Number.NaN)).toBe('--:--');
    });

    test('a day is named relative to now before it is dated', () => {
        const now = new Date(2026, 4, 17, 12, 0).getTime();
        expect(noticeDay(now, now)).toBe('Today');
        expect(noticeDay(now - 20 * 3_600_000, now)).toBe('Yesterday');
        expect(noticeDay(now - 5 * 86_400_000, now)).not.toBe('Today');
    });
});
