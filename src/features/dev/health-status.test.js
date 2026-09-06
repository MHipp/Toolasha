/** @vitest-environment happy-dom */

/**
 * The report is the point of the panel.
 *
 * A user who says "the net worth number is gone" cannot say which build they are
 * on, which fork, or what the startup was waiting for — so the report has to
 * carry all of it without being asked. Everything here is a check that one of
 * those things is in the text, because each was chosen after being missing from
 * a bug report at least once.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Both reach storage, and neither is what this is about
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    PANEL_Z_CAP: 1199,
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

/** The database, as the panel sees it: numbers to report and a listener to fire */
const storageMock = vi.hoisted(() => ({
    diag: {},
    budgets: [],
    listener: null,
    default: null,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        diagnostics: () => storageMock.diag,
        estimate: async () => storageMock.diag.estimate,
        budgetReport: async () => storageMock.budgets,
        onQuotaExceeded: (fn) => {
            storageMock.listener = fn;
            return () => {};
        },
    },
}));

import healthStatusPanel, {
    buildDiagnosticReport,
    diagnosticData,
    reportFailures,
    refreshStorageFacts,
} from './health-status.js';
import { dismissAllToasts } from '../../utils/toast.js';

const FAILURES = [
    { key: 'networth', name: 'Net Worth', reason: 'Health check returned false' },
    { key: 'taskIcons', name: 'Task Icons', reason: 'Initialization threw: boom' },
];

beforeEach(() => {
    document.body.innerHTML = '';
    storageMock.diag = {
        dbName: 'ToolashaDB',
        dbVersion: 17,
        available: true,
        pendingWrites: 0,
        activeTimers: 0,
        quotaExceeded: false,
        quotaFailures: 0,
        lastQuotaTarget: null,
        estimate: { usage: 25_000_000, quota: 100_000_000, percent: 25, at: 0 },
    };
    storageMock.budgets = [
        { storeName: 'lootLogHistory', keys: 41, unknown: false, perCharacter: false, budget: 40, over: true },
        { storeName: 'settings', keys: 120, unknown: false, perCharacter: false, budget: 500, over: false },
    ];
    window.Toolasha = {
        version: '2.88.0',
        fork: 'Millennium44/Toolasha',
        Core: {
            performanceMonitor: {
                getMarks: () => [
                    { name: 'script:start', at: 0 },
                    { name: 'character:data', at: 4200 },
                ],
                getSnapshots: () => new Map([['init:networth', { duration: 120, startedAt: 4300 }]]),
                getAllStats: () => new Map(),
                spans: new Map(),
            },
        },
    };
});

afterEach(() => {
    healthStatusPanel.disable();
    dismissAllToasts();
});

describe('the diagnostic report', () => {
    test('names the build, the fork and the browser', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('script: 2.88.0');
        expect(report).toContain('fork: Millennium44/Toolasha');
        expect(report).toContain(navigator.userAgent);
    });

    test('lists every failure with its key and its reason', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('Features that did not start (2)');
        expect(report).toContain('- Net Worth [networth]: Health check returned false');
        expect(report).toContain('- Task Icons [taskIcons]: Initialization threw: boom');
    });

    test('carries the startup trace, gaps and all', () => {
        const report = buildDiagnosticReport(FAILURES);
        expect(report).toContain('Toolasha startup trace');
        expect(report).toContain('character:data');
        expect(report).toContain('script:start → character:data');
    });

    test('survives a monitor that is not there yet', () => {
        window.Toolasha.Core = {};
        expect(buildDiagnosticReport(FAILURES)).toContain('No startup trace was recorded.');
    });

    test('the machine-readable copy carries the same facts', () => {
        const data = diagnosticData(FAILURES);
        expect(data.script).toBe('2.88.0');
        expect(data.failures).toHaveLength(2);
        expect(data.startup.features[0].name).toBe('init:networth');
    });
});

describe('what the report says about storage', () => {
    test('how full the database is, in units a person can read', async () => {
        await refreshStorageFacts();
        const report = buildDiagnosticReport([]);

        expect(report).toContain('Storage');
        expect(report).toContain('usage: 23.8 MB of 95.4 MB (25.0%)');
    });

    test('a browser that will not say is said to have not said', async () => {
        storageMock.diag.estimate = null;
        await refreshStorageFacts();

        expect(buildDiagnosticReport([])).toContain('usage: not reported by this browser');
    });

    test('a healthy database still states that no write has failed', async () => {
        await refreshStorageFacts();
        expect(buildDiagnosticReport([])).toContain('quota: no failed writes this session');
    });

    test('a full database says so, and says what stopped', async () => {
        storageMock.diag.quotaExceeded = true;
        storageMock.diag.quotaFailures = 3;
        storageMock.diag.lastQuotaTarget = { storeName: 'networthHistory', key: 'networth_1' };
        await refreshStorageFacts();

        const report = buildDiagnosticReport([]);
        expect(report).toContain('QUOTA EXCEEDED — 3 failed write(s), most recently networthHistory:networth_1');
        expect(report).toContain('History recording has stood down');
    });

    test('stores that have outgrown their soft budget are named', async () => {
        await refreshStorageFacts();

        const report = buildDiagnosticReport([]);
        expect(report).toContain('stores over their soft budget (1)');
        expect(report).toContain('- lootLogHistory: 41 keys (budget 40)');
    });

    test('nothing over budget is stated as nothing, not left out', async () => {
        storageMock.budgets = [
            { storeName: 'settings', keys: 10, unknown: false, perCharacter: false, budget: 500, over: false },
        ];
        await refreshStorageFacts();

        expect(buildDiagnosticReport([])).toContain('stores over their soft budget: none');
    });

    /*
     * `budgetReport` reports a store the browser could not list as `keys: null,
     * unknown: true` rather than as zero. Printing that null as a number would
     * put back the "0 keys, comfortably under budget" reading the null exists
     * to remove, so the report says the word instead.
     */
    test('a store that could not be listed reads as unreadable, never as a count', async () => {
        storageMock.budgets = [
            { storeName: 'lootLogHistory', keys: null, unknown: true, perCharacter: false, budget: 40, over: false },
            { storeName: 'settings', keys: 120, unknown: false, perCharacter: false, budget: 500, over: false },
        ];
        await refreshStorageFacts();

        const report = buildDiagnosticReport([]);
        expect(report).toContain('stores that could not be listed (1): lootLogHistory=unreadable');
        expect(report).toContain('unknown, not zero');
        expect(report).toContain('largest stores by key count: lootLogHistory=unreadable, settings=120');
        expect(report).not.toContain('lootLogHistory=0');
        expect(report).not.toContain('lootLogHistory=null');
        // It is not over budget either — nothing was counted to compare
        expect(report).toContain('stores over their soft budget: none');
    });

    test('nothing unlistable adds no line about it', async () => {
        await refreshStorageFacts();

        expect(buildDiagnosticReport([])).not.toContain('could not be listed');
    });

    test('the machine-readable copy carries the same storage facts', async () => {
        await refreshStorageFacts();

        const data = diagnosticData([]);
        expect(data.storage.estimate.usage).toBe(25_000_000);
        expect(data.storage.budgets[0].storeName).toBe('lootLogHistory');
    });
});

describe('a full database reaching the player', () => {
    test('one toast, which leads to what it means', async () => {
        expect(typeof storageMock.listener).toBe('function');

        storageMock.listener({ key: 'lootLog_1', storeName: 'lootLogHistory', at: Date.now() });

        const toasts = document.querySelectorAll('.toolasha-toast');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].textContent).toContain('ran out of storage');

        toasts[0].click();
        const panel = document.getElementById('toolasha-health-status');
        expect(panel.textContent).toContain('Storage (IndexedDB)');
        expect(panel.textContent).toContain('lootLogHistory:lootLog_1');
    });

    test('the panel shows the usage line and the full-storage warning', async () => {
        storageMock.diag.quotaExceeded = true;
        healthStatusPanel.show([]);

        // The quota warning is drawn in the first, synchronous pass, so waiting
        // on it waits for nothing: the budget line only appears once `show()`'s
        // background refresh has landed. Waiting on the quota element instead
        // meant this test passed only when an earlier test had already left
        // budget rows in the panel module's cache.
        await vi.waitFor(() => {
            const pending = document.querySelector('.toolasha-health-storage');
            expect(pending.textContent).toContain('Over soft budget: lootLogHistory (41)');
        });
        const block = document.querySelector('.toolasha-health-storage');
        expect(block.textContent).toContain('Storage: 23.8 MB of 95.4 MB');
        expect(document.querySelector('.toolasha-health-quota')).toBeTruthy();
    });

    test('the panel says which stores it could not look inside', async () => {
        storageMock.budgets = [
            { storeName: 'lootLogHistory', keys: null, unknown: true, perCharacter: false, budget: 40, over: false },
        ];
        healthStatusPanel.show([]);

        await vi.waitFor(() => {
            const block = document.querySelector('.toolasha-health-storage');
            expect(block.textContent).toContain('Could not be listed: lootLogHistory');
        });
        const block = document.querySelector('.toolasha-health-storage');
        expect(block.textContent).toContain('unknown, not zero');
        expect(block.textContent).not.toContain('Over soft budget');
    });
});

describe('surfacing', () => {
    test('one toast for many failures, not one each', () => {
        reportFailures(FAILURES);
        const toasts = document.querySelectorAll('.toolasha-toast');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].textContent).toContain('2 Toolasha features failed to start');
    });

    test('says nothing at all when nothing failed', () => {
        expect(reportFailures([])).toBeNull();
        expect(document.querySelectorAll('.toolasha-toast')).toHaveLength(0);
    });

    test('clicking it opens the list of what broke', () => {
        reportFailures(FAILURES);
        document.querySelector('.toolasha-toast').click();

        const panel = document.getElementById('toolasha-health-status');
        expect(panel).toBeTruthy();
        expect(panel.textContent).toContain('Net Worth');
        expect(panel.textContent).toContain('Task Icons');
        expect(panel.querySelector('.toolasha-health-copy')).toBeTruthy();
    });

    test('the copy button puts the report on the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        healthStatusPanel.show(FAILURES);
        document.querySelector('.toolasha-health-copy').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

        expect(writeText.mock.calls[0][0]).toContain('- Net Worth [networth]');
    });

    test('reopening replaces the panel rather than stacking a second one', () => {
        healthStatusPanel.show(FAILURES);
        healthStatusPanel.show(FAILURES.slice(0, 1));
        expect(document.querySelectorAll('#toolasha-health-status')).toHaveLength(1);
        expect(document.getElementById('toolasha-health-status').textContent).toContain('1 feature did not start');
    });
});
