/**
 * A startup trace somebody can read, or send.
 *
 * The arithmetic is the part worth testing: which stretch of a slow start was
 * work and which was waiting, and whether the report says so plainly enough to
 * be pasted into a chat window and understood by someone who was not there.
 */

import { describe, test, expect } from 'vitest';
import { gapsBetween, initTimeline, initSummary, formatReport, reportData } from './performance-report.js';

const MARKS = [
    { name: 'script:start', at: 0 },
    { name: 'storage:open', at: 40 },
    { name: 'character:data', at: 8200 },
    { name: 'features:start', at: 8300 },
    { name: 'features:done', at: 21000 },
];

const SNAPSHOTS = new Map([
    ['init:guildXPTracker', { duration: 6525, startedAt: 8400 }],
    ['init:networth', { duration: 6253, startedAt: 14925 }],
    ['init:xpTracker', { duration: 66, startedAt: 21178 }],
    ['bg:networth', { duration: 4000, startedAt: 21200 }],
    ['dom:MarketFilter', { duration: 12, startedAt: 30000 }],
]);

describe('where the waiting went', () => {
    test('the gaps between marks, longest first', () => {
        // Durations only ever add up to the work; the answer to a slow start is
        // often the stretch where nothing was being timed at all — here, eight
        // seconds waiting for the game's own data to arrive
        const gaps = gapsBetween(MARKS);

        expect(gaps[0]).toMatchObject({ from: 'features:start', to: 'features:done', ms: 12700 });
        expect(gaps[1]).toMatchObject({ from: 'storage:open', to: 'character:data', ms: 8160 });
    });

    test('marks out of order still describe the same timeline', () => {
        const shuffled = [MARKS[3], MARKS[0], MARKS[4], MARKS[1], MARKS[2]];

        expect(gapsBetween(shuffled).map((gap) => gap.ms)).toEqual(gapsBetween(MARKS).map((gap) => gap.ms));
    });

    test('one mark is no gaps rather than a NaN', () => {
        expect(gapsBetween([{ name: 'only', at: 5 }])).toEqual([]);
        expect(gapsBetween([])).toEqual([]);
    });
});

describe('the feature timeline', () => {
    test('is ordered by when things started, not by how long they took', () => {
        // The question is what everything else was queued behind, and that is
        // answered by order
        const names = initTimeline(SNAPSHOTS).map((row) => row.name);

        expect(names).toEqual(['init:guildXPTracker', 'init:networth', 'init:xpTracker', 'bg:networth']);
    });

    test('and leaves out what is not part of starting up', () => {
        expect(initTimeline(SNAPSHOTS).some((row) => row.name.startsWith('dom:'))).toBe(false);
    });

    test('each row knows when it ended', () => {
        const [first] = initTimeline(SNAPSHOTS);

        expect(first.endedAt).toBe(8400 + 6525);
    });

    test('background work is marked as such', () => {
        const background = initTimeline(SNAPSHOTS).filter((row) => row.background);

        expect(background.map((row) => row.name)).toEqual(['bg:networth']);
    });

    test('an :own snapshot annotates its parent instead of counting as a feature', () => {
        // A sync feature that merely parked in `await` while a heavy read
        // resolved should show its true self-time, not the read's cost, and
        // the `:own` half must never appear as a feature of its own
        const withOwn = new Map([
            ['init:autoAllButton', { duration: 1244, startedAt: 2993 }],
            ['init:autoAllButton:own', { duration: 1, startedAt: 2993 }],
        ]);
        const rows = initTimeline(withOwn);

        expect(rows.map((row) => row.name)).toEqual(['init:autoAllButton']);
        expect(rows[0].ownMs).toBe(1);
        // The blocking total is the wall-clock span, counted once
        expect(initSummary(rows).blocking).toBe(1244);
    });
});

describe('what the summary adds up', () => {
    test('blocking and background are counted apart', () => {
        // Time spent after the page is usable is not time the player waited
        const summary = initSummary(initTimeline(SNAPSHOTS));

        expect(summary.blocking).toBe(6525 + 6253 + 66);
        expect(summary.background).toBe(4000);
    });

    test('overlapping features are counted once, not added up', () => {
        // Feature initializers are started together, so their waits overlap.
        // Three features that each waited a second, all at once, held the page
        // up for a second — reporting three would be reporting the old design.
        const overlapping = new Map([
            ['init:a', { duration: 1000, startedAt: 100 }],
            ['init:b', { duration: 900, startedAt: 150 }],
            ['init:c', { duration: 800, startedAt: 200 }],
        ]);

        expect(initSummary(initTimeline(overlapping)).blocking).toBe(1000);
    });

    test('features separated by a gap still add up', () => {
        const apart = new Map([
            ['init:a', { duration: 100, startedAt: 0 }],
            ['init:b', { duration: 100, startedAt: 500 }],
        ]);

        expect(initSummary(initTimeline(apart)).blocking).toBe(200);
    });

    test('the span runs to the last thing that finished', () => {
        expect(initSummary(initTimeline(SNAPSHOTS)).span).toBe(21200 + 4000);
    });

    test('and the slowest are named', () => {
        expect(initSummary(initTimeline(SNAPSHOTS)).slowest[0].name).toBe('init:guildXPTracker');
    });
});

describe('the report itself', () => {
    const spans = new Map([
        [
            'init:networth',
            [
                { part: 'recalculate', duration: 5800, startedAt: 15000 },
                { part: 'exclusions', duration: 200, startedAt: 14930 },
            ],
        ],
    ]);
    const build = () =>
        formatReport({
            marks: MARKS,
            snapshots: SNAPSHOTS,
            spans,
            stats: new Map([['dom:MarketFilter', { calls: 40, totalMs: 480, avgMs: 12, cpuPercent: 9.6 }]]),
            environment: { cores: 8, script: '2.88.0' },
        });

    test('carries the environment, because the machine is half the answer', () => {
        expect(build()).toContain('cores: 8');
    });

    test('names the slowest feature and when it started', () => {
        const report = build();

        expect(report).toContain('init:guildXPTracker');
        expect(report).toContain('started 8400ms');
    });

    test('breaks a slow feature into the parts that were timed inside it', () => {
        // "networth took six seconds" is a question; "recalculate took 5.8 of
        // them" is the answer
        expect(build()).toContain('recalculate');
    });

    test('and shows the gap nothing was being timed in', () => {
        expect(build()).toContain('storage:open → character:data');
    });

    test('a feature that only parked in await is shown as waiting, not blamed', () => {
        const report = formatReport({
            marks: MARKS,
            snapshots: new Map([
                ['init:autoAllButton', { duration: 1244, startedAt: 2993 }],
                ['init:autoAllButton:own', { duration: 1, startedAt: 2993 }],
            ]),
            environment: { cores: 8 },
        });

        expect(report).toContain('waiting on other work');
    });

    test('an empty monitor still produces a report rather than throwing', () => {
        expect(() => formatReport()).not.toThrow();
        expect(formatReport()).toContain('Toolasha startup trace');
    });
});

describe('the machine-readable copy', () => {
    test('is JSON-safe and carries the same timeline', () => {
        const data = reportData({ marks: MARKS, snapshots: SNAPSHOTS, environment: { cores: 4 } });

        expect(() => JSON.stringify(data)).not.toThrow();
        expect(data.features[0].name).toBe('init:guildXPTracker');
        expect(data.environment.cores).toBe(4);
    });

    test('and turns the maps into objects, which JSON can hold', () => {
        const data = reportData({ spans: new Map([['init:x', [{ part: 'a', duration: 1 }]]]) });

        expect(JSON.parse(JSON.stringify(data)).spans['init:x'][0].part).toBe('a');
    });
});

describe('the stall ledger in the report', () => {
    test('stalls print with their suspects, largest evidence first', () => {
        const text = formatReport({
            stalls: [
                { time: 1, sinceBoot: 12000, duration: 182, suspects: [{ name: 'networth:recalculate', ms: 171 }] },
                { time: 2, sinceBoot: 15500, duration: 60, suspects: [] },
            ],
        });

        expect(text).toContain('Main-thread stalls since measuring began (2, worst 182ms)');
        expect(text).toContain('networth:recalculate 171ms');
        expect(text).toContain('nothing instrumented overlapped it');
    });

    test('no stalls, no section', () => {
        expect(formatReport({})).not.toContain('Main-thread stalls');
    });

    test('a session-lifetime worst that exceeds what is still in the window is called out', () => {
        // The ring behind `stalls` is capped at 200, so a slow stall from
        // early in a long session can have been dropped by the time a report
        // is asked for — the windowed max alone would then understate it.
        const text = formatReport({
            stalls: [{ time: 1, sinceBoot: 12000, duration: 182, suspects: [] }],
            worstStallMs: 5000,
        });

        expect(text).toContain('worst 182ms shown, 5000ms this session');
    });

    test('a session-lifetime worst no larger than the window changes nothing', () => {
        const text = formatReport({
            stalls: [{ time: 1, sinceBoot: 12000, duration: 182, suspects: [] }],
            worstStallMs: 182,
        });

        expect(text).toContain('Main-thread stalls since measuring began (1, worst 182ms)');
        expect(text).not.toContain('this session');
    });
});

describe('the rolling window, split by what it measures', () => {
    const build = () =>
        formatReport({
            stats: new Map([
                [
                    'networth:recalculate',
                    { calls: 1, totalMs: 452.6, avgMs: 452.6, kind: 'elapsed', wallPercent: 9.05 },
                ],
                ['dom:MarketFilter', { calls: 40, totalMs: 480, avgMs: 12, kind: 'blocking', cpuPercent: 9.6 }],
            ]),
        });

    test('a yielding metric is listed apart from the CPU block', () => {
        const text = build();
        const busiest = text.indexOf('Busiest since the panel opened');
        const elapsed = text.indexOf('Elapsed, not CPU');

        expect(elapsed).toBeGreaterThan(busiest);
        // The biggest line by total ms, yet it does not head the CPU block
        expect(text.slice(busiest, elapsed)).not.toContain('networth:recalculate');
        expect(text.slice(elapsed)).toContain('9.1% wall  networth:recalculate');
        expect(text.slice(elapsed)).toContain('avg 452.60ms elapsed');
    });

    test('a blocking metric reads exactly as it did before', () => {
        expect(build()).toContain('   9.6%  dom:MarketFilter');
    });

    test('no yielding metric, no second block', () => {
        const text = formatReport({
            stats: new Map([['dom:MarketFilter', { calls: 40, totalMs: 480, avgMs: 12, cpuPercent: 9.6 }]]),
        });

        expect(text).toContain('Busiest since the panel opened');
        expect(text).not.toContain('Elapsed, not CPU');
    });

    test('the exported data carries the tag beside the number', () => {
        const data = reportData({
            stats: new Map([
                [
                    'networth:recalculate',
                    { calls: 1, totalMs: 452.6, avgMs: 452.6, kind: 'elapsed', wallPercent: 9.05 },
                ],
            ]),
        });

        expect(data.rolling['networth:recalculate'].kind).toBe('elapsed');
        expect(data.rolling['networth:recalculate'].cpuPercent).toBeUndefined();
    });
});
