/** @vitest-environment happy-dom
 *
 * The PFormance panel's one button.
 *
 * There is a single button for this panel, in Toolasha's settings, and it used
 * to only ever open. Pressing it again raised a panel that was already up,
 * which on a phone — where the panel's own ✕ is the first thing to fall off a
 * narrow header — left no way to close it at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = {};
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSettingValue: (key, fallback) => (key in settings ? settings[key] : fallback),
        setSettingValue: (key, value) => {
            settings[key] = value;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));

const { default: pformancePanel } = await import('./pformance-panel.js');

/** @returns {HTMLElement|null} The panel, if it is up */
const onScreen = () => document.getElementById('toolasha-pformance-panel');

/** The monitor the panel switches on while it is open */
const monitor = {
    enabled: false,
    getAllStats: () => new Map(),
    getSnapshots: () => new Map(),
    getSpans: () => [],
    getMarks: () => [],
};

beforeEach(() => {
    window.Toolasha = { Core: { performanceMonitor: monitor } };
    monitor.enabled = false;
    for (const key of Object.keys(settings)) delete settings[key];
});

afterEach(() => {
    pformancePanel.hide();
    document.body.replaceChildren();
    delete window.Toolasha;
});

describe('opening and closing', () => {
    test('the first press opens it and the second closes it', () => {
        pformancePanel.toggle();
        expect(onScreen()).not.toBe(null);
        expect(pformancePanel.isVisible()).toBe(true);

        pformancePanel.toggle();
        expect(onScreen()).toBe(null);
        expect(pformancePanel.isVisible()).toBe(false);
    });

    test('closing stops the measuring it turned on', () => {
        pformancePanel.toggle();
        expect(monitor.enabled).toBe(true);

        pformancePanel.toggle();
        expect(monitor.enabled).toBe(false);
    });

    test('the ✕ in its header does the same thing the button does', () => {
        pformancePanel.show();
        const close = [...onScreen().querySelectorAll('button')].find((button) => button.textContent === '✕');

        close.click();

        expect(onScreen()).toBe(null);
    });

    test('closing a panel that was never opened is not a crash', () => {
        expect(() => pformancePanel.hide()).not.toThrow();
    });

    test('and neither is opening one with no monitor to switch on', () => {
        // The panel can be opened from contexts where the script's global is
        // not published, and an assignment through nothing took the open with it
        delete window.Toolasha;

        expect(() => pformancePanel.toggle()).not.toThrow();
        expect(onScreen()).not.toBe(null);
    });
});

/**
 * The attribution extras: unattributed stall time, the registry leak canary
 * and the heap trend. All three are one setting, off by default, and with it
 * off the panel must render exactly what it rendered before they existed.
 */
let leakSamples = [];
let leakReport = [];
let leakReset = 0;

/** A monitor that can answer the extras' questions */
const richMonitor = {
    ...monitor,
    windowMs: 5000,
    getStalls: () => [
        { duration: 300, coveredMs: 0, sinceBoot: 1000, time: Date.now(), suspects: [], recentEvents: [] },
        {
            duration: 200,
            coveredMs: 100,
            sinceBoot: 2000,
            time: Date.now(),
            suspects: [{ name: 'networth', ms: 100 }],
            recentEvents: [],
        },
    ],
    stallCoverage: (stall) => {
        const coverage = (stall.coveredMs || 0) / stall.duration;
        return {
            coverage,
            verdict: coverage >= 0.8 ? 'ours' : coverage <= 0.2 ? 'not-ours' : 'partly-ours',
        };
    },
    createLeakCanary: () => ({
        sample: (counts) => leakSamples.push(counts),
        getReport: () => leakReport,
        reset: () => {
            leakReset += 1;
        },
    }),
    getStallAttribution: () => ({
        windowMs: 5000,
        stalls: 2,
        totalMs: 500,
        ourStalls: 0,
        partlyOursStalls: 1,
        unattributedStalls: 1,
        unattributedMs: 400,
    }),
};

describe('attribution extras', () => {
    /** @returns {string} Everything the panel body currently says */
    const body = () => onScreen().children[1].textContent;

    beforeEach(() => {
        window.Toolasha = { Core: { performanceMonitor: richMonitor } };
        leakSamples = [];
        leakReport = [];
        leakReset = 0;
    });

    test('with the setting off the panel body says nothing about attribution', () => {
        pformancePanel.show();

        expect(body()).not.toContain('Not ours');
        expect(body()).not.toContain('not ours');
        expect(body()).not.toContain('Leak canary');
        expect(body()).not.toContain('Heap');
    });

    test('with the setting on the unattributed stall time is shown, with what it does not mean', () => {
        settings.pformanceAttribution = true;
        pformancePanel.show();

        expect(body()).toContain('Not ours: 1/2 stalls, 400ms');
        // The claim is bounded in the UI text itself, not only in the JSDoc
        expect(body()).toContain('no measured Toolasha span overlapped');
        expect(body()).toContain('other extensions');
    });

    test('the partial-overlap rule is visible per row rather than rounded away', () => {
        settings.pformanceAttribution = true;
        pformancePanel.show();

        expect(body()).toContain('not ours 0%');
        expect(body()).toContain('partly ours 50%');
    });

    test('the header toggle flips it and persists the choice', () => {
        pformancePanel.show();
        const toggle = [...onScreen().querySelectorAll('button')].find((b) => b.textContent === '◎');

        toggle.click();

        expect(settings.pformanceAttribution).toBe(true);
        expect(body()).toContain('Not ours');
    });

    test('a monitor too old to answer is not a crash', () => {
        settings.pformanceAttribution = true;
        window.Toolasha = { Core: { performanceMonitor: monitor } };

        expect(() => pformancePanel.show()).not.toThrow();
        expect(onScreen()).not.toBe(null);
    });

    test('the panel still renders where the page has no PerformanceObserver at all', () => {
        settings.pformanceAttribution = true;
        const saved = globalThis.PerformanceObserver;
        delete globalThis.PerformanceObserver;
        try {
            expect(() => pformancePanel.show()).not.toThrow();
            expect(onScreen()).not.toBe(null);
        } finally {
            if (saved) globalThis.PerformanceObserver = saved;
        }
    });
});

describe('the leak canary in the panel', () => {
    beforeEach(() => {
        window.Toolasha = { Core: { performanceMonitor: richMonitor } };
        leakSamples = [];
        leakReport = [];
        leakReset = 0;
    });

    test('is not sampled at all while the extras are off', () => {
        pformancePanel.show();

        expect(leakSamples).toEqual([]);
    });

    test('samples each of our registries separately on the panel refresh', () => {
        settings.pformanceAttribution = true;
        pformancePanel.show();

        expect(leakSamples).toHaveLength(1);
        const keys = Object.keys(leakSamples[0]);
        expect(keys).toContain('cleanup:listeners');
        expect(keys).toContain('timers:intervals');
        expect(keys).toContain('dom:handlers');
        expect(keys).toContain('dom:pendingDebounces');
        // Per source, never one total
        expect(keys.length).toBeGreaterThan(5);
    });

    test('a growing source is marked, a stable one is not', () => {
        settings.pformanceAttribution = true;
        leakReport = [
            { source: 'chat:processedMessages', latest: 4200, lowest: 12, samples: 90, decreases: 0, growing: true },
            { source: 'dom:handlers', latest: 151, lowest: 150, samples: 90, decreases: 3, growing: false },
        ];
        pformancePanel.show();

        const body = onScreen().children[1].textContent;
        expect(body).toContain('Leak canary');
        expect(body).toContain('⚠ chat:processedMessages');
        expect(body).toContain('4200');
        expect(body).not.toContain('⚠ dom:handlers');
    });

    test('closing the panel drops what the canary held', () => {
        settings.pformanceAttribution = true;
        pformancePanel.show();
        pformancePanel.hide();

        expect(leakReset).toBe(1);
    });
});

/**
 * The heap row. Chrome-only, and where it is not available the row must be
 * absent rather than zeroed — "we cannot see it" and "it is flat" are opposite
 * answers.
 */
describe('the heap trend in the panel', () => {
    let heapSupported = true;
    let trendValue = null;

    beforeEach(() => {
        heapSupported = true;
        trendValue = { usedMb: 412.5, changeMb: 30.25, perMinuteMb: 6.1, samples: 30, spanMs: 300000 };
        window.Toolasha = {
            Core: {
                performanceMonitor: {
                    ...richMonitor,
                    heapMemorySupported: () => heapSupported,
                    createHeapTrend: () => ({
                        sample: () => (heapSupported ? 1 : null),
                        getTrend: () => trendValue,
                        reset: () => {},
                    }),
                },
            },
        };
    });

    test('is absent while the extras are off', () => {
        pformancePanel.show();

        expect(onScreen().children[1].textContent).not.toContain('Tab heap');
    });

    test('shows the trend, and says it covers the whole tab', () => {
        settings.pformanceAttribution = true;
        pformancePanel.show();

        const body = onScreen().children[1].textContent;
        expect(body).toContain('Tab heap: 412.5MB');
        expect(body).toContain('+30.3MB');
        expect(body).toContain('Whole tab');
        expect(body).toContain('never whose');
    });

    test('is omitted entirely where the browser has no heap figure — not zeroed, not dashed', () => {
        settings.pformanceAttribution = true;
        heapSupported = false;
        pformancePanel.show();

        const body = onScreen().children[1].textContent;
        expect(body).not.toContain('Tab heap');
        expect(body).not.toContain('0.0MB');
        expect(body).not.toContain('—MB');
        // and the rest of the panel is unharmed
        expect(body).toContain('Leak canary');
    });

    test('is omitted before there are two readings to compare', () => {
        settings.pformanceAttribution = true;
        trendValue = null;
        pformancePanel.show();

        expect(onScreen().children[1].textContent).not.toContain('Tab heap');
    });
});
