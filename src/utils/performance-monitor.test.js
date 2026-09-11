/**
 * Tests for Performance Monitor
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import performanceMonitor, {
    installIntervalTracing,
    timerCallSite,
    timerCounters,
    stallCoverage,
    createLeakCanary,
    createHeapTrend,
    heapMemorySupported,
    registerCountSource,
    readCountSources,
} from './performance-monitor.js';

describe('PerformanceMonitor', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('record() is a no-op when disabled', () => {
        performanceMonitor.enabled = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('record() is a no-op when the tab is not visible', () => {
        performanceMonitor._tabVisible = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('getStats aggregates calls, totalMs, avgMs within the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('feature', 10);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(2);
        expect(stats.totalMs).toBe(30);
        expect(stats.avgMs).toBe(15);
        vi.useRealTimers();
    });

    test('getStats excludes measurements older than the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        performanceMonitor.record('feature', 10);

        vi.setSystemTime(performanceMonitor.windowMs + 1);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(1);
        expect(stats.totalMs).toBe(20);
        vi.useRealTimers();
    });

    test('getStats returns null for an unknown metric', () => {
        expect(performanceMonitor.getStats('nonexistent')).toBeNull();
    });

    test('cpuPercent is capped at 100', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('busy', performanceMonitor.windowMs * 5);
        expect(performanceMonitor.getStats('busy').cpuPercent).toBe(100);
        vi.useRealTimers();
    });

    test('getAllStats cleans up and returns stats for every active metric', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('a', 5);
        performanceMonitor.record('b', 15);

        const all = performanceMonitor.getAllStats();
        expect(all.get('a').totalMs).toBe(5);
        expect(all.get('b').totalMs).toBe(15);
        vi.useRealTimers();
    });

    test('snapshot() stores a one-time measurement independent of the rolling window', () => {
        performanceMonitor.snapshot('init:feature', 42, 100);
        const snap = performanceMonitor.getSnapshots().get('init:feature');
        expect(snap.duration).toBe(42);
        expect(snap.startedAt).toBe(100);
    });

    test('mark() records name and time, and getMarks() sorts chronologically', () => {
        performanceMonitor.mark('second');
        performanceMonitor.marks[0].at = 200;
        performanceMonitor.mark('first');
        performanceMonitor.marks[1].at = 50;

        const marks = performanceMonitor.getMarks();
        expect(marks.map((m) => m.name)).toEqual(['first', 'second']);
    });

    test('startSpan()/getSpans() records a duration and sorts longest first', () => {
        const end1 = performanceMonitor.startSpan('parent', 'partA');
        end1();
        const end2 = performanceMonitor.startSpan('parent', 'partB');
        end2();

        // Force distinguishable durations for a deterministic sort
        performanceMonitor.spans.get('parent')[0].duration = 5;
        performanceMonitor.spans.get('parent')[1].duration = 50;

        const spans = performanceMonitor.getSpans('parent');
        expect(spans[0].part).toBe('partB');
        expect(spans[0].duration).toBe(50);
    });

    test('span() times an async function and always records even on throw', async () => {
        await performanceMonitor.span('parent', 'ok', async () => 'result');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(1);

        await expect(
            performanceMonitor.span('parent', 'fails', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(2);
    });

    test('wrap() times a synchronous function and re-throws on error while still recording', () => {
        performanceMonitor.enabled = true;
        const wrapped = performanceMonitor.wrap('sync', () => {
            throw new Error('fail');
        });
        expect(() => wrapped()).toThrow('fail');
        expect(performanceMonitor.getStats('sync').calls).toBe(1);
    });

    test('wrap() passes through untimed when disabled', () => {
        performanceMonitor.enabled = false;
        const fn = vi.fn(() => 'value');
        const wrapped = performanceMonitor.wrap('sync', fn);
        expect(wrapped()).toBe('value');
        expect(performanceMonitor.getStats('sync')).toBeNull();
    });

    test('reset() clears measurements, snapshots, and spans', () => {
        performanceMonitor.record('a', 5);
        performanceMonitor.snapshot('b', 5);
        const end = performanceMonitor.startSpan('c', 'x');
        end();

        performanceMonitor.reset();

        expect(performanceMonitor.getStats('a')).toBeNull();
        expect(performanceMonitor.getSnapshots().size).toBe(0);
        expect(performanceMonitor.getSpans('c')).toEqual([]);
    });
});

describe('measurement history bounds', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('a metric never read between stat pulls stays bounded per name', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        // An enabled session with the panel closed: hours of ticks, no reads
        for (let i = 0; i < 2500; i++) {
            vi.setSystemTime(1000 + i);
            performanceMonitor.record('interval:busy@1', 2);
        }
        expect(performanceMonitor.measurements.get('interval:busy@1').length).toBeLessThanOrEqual(1000);
        vi.useRealTimers();
    });

    test('bounding prefers dropping entries the rolling window no longer covers', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        for (let i = 0; i < 1200; i++) {
            performanceMonitor.record('interval:old@1', 2);
        }
        // Move past the window, then one more record triggers the prune
        vi.setSystemTime(performanceMonitor.windowMs + 1);
        performanceMonitor.record('interval:old@1', 7);

        const entries = performanceMonitor.measurements.get('interval:old@1');
        expect(entries.length).toBe(1);
        expect(entries[0].duration).toBe(7);
        vi.useRealTimers();
    });

    test('the freshest entries survive the cap, so stats stay correct', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        for (let i = 0; i < 1500; i++) {
            performanceMonitor.record('interval:hot@1', 1);
        }
        performanceMonitor.record('interval:hot@1', 99);
        const entries = performanceMonitor.measurements.get('interval:hot@1');
        expect(entries[entries.length - 1].duration).toBe(99);
        vi.useRealTimers();
    });
});

describe('stall attribution', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('work recorded inside the stall window is named as a suspect, biggest first', () => {
        performanceMonitor.record('event:items_updated', 12);
        performanceMonitor.record('networth:recalculate', 171);
        performanceMonitor.record('dom:Tiny', 1); // under the 5ms floor

        const now = performance.now();
        const suspects = performanceMonitor._suspectsFor({ startTime: now - 200, duration: 200 });

        expect(suspects.map((s) => s.name)).toEqual(['networth:recalculate', 'event:items_updated']);
    });

    test('work recorded long before the stall is not blamed for it', () => {
        performanceMonitor.record('networth:recalculate', 171);
        const suspects = performanceMonitor._suspectsFor({ startTime: performance.now() + 5000, duration: 100 });
        expect(suspects).toEqual([]);
    });

    test('getStalls() is empty and safe before the watch ever starts', () => {
        expect(performanceMonitor.getStalls()).toEqual([]);
    });

    test('getWorstStallMs() is 0 before anything is recorded', () => {
        expect(performanceMonitor.getWorstStallMs()).toBe(0);
    });

    test('the session-lifetime worst survives the display ring dropping the stall that set it', () => {
        performanceMonitor.stalls = [];
        performanceMonitor.worstStallMs = 0;

        // One very slow stall, then enough small ones to push it out of the
        // 200-entry ring `getStalls()` shows.
        performanceMonitor._recordStall({ startTime: 0, duration: 5000 });
        for (let i = 0; i < 200; i++) {
            performanceMonitor._recordStall({ startTime: i + 1, duration: 60 });
        }

        expect(performanceMonitor.getStalls()).toHaveLength(200);
        expect(performanceMonitor.getStalls().some((stall) => stall.duration === 5000)).toBe(false);
        expect(performanceMonitor.getWorstStallMs()).toBe(5000);
    });

    test('reset() clears the session-lifetime worst along with the ring', () => {
        performanceMonitor._recordStall({ startTime: 0, duration: 999 });
        expect(performanceMonitor.getWorstStallMs()).toBe(999);

        performanceMonitor.reset();

        expect(performanceMonitor.getWorstStallMs()).toBe(0);
        expect(performanceMonitor.getStalls()).toEqual([]);
    });
});

describe('interval tracing', () => {
    test('a traced interval reports its ticks into the rolling stats under a call-site name', async () => {
        installIntervalTracing();
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;

        const id = setInterval(() => {
            const t0 = performance.now();
            while (performance.now() - t0 < 3) {
                // burn >1ms so the tick clears the recording floor
            }
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 40));
        clearInterval(id);

        const traced = [...performanceMonitor.measurements.keys()].filter((name) => name.startsWith('interval:'));
        expect(traced.length).toBeGreaterThan(0);
    });

    test('installing twice does not double-wrap', () => {
        installIntervalTracing();
        const once = globalThis.setInterval;
        installIntervalTracing();
        expect(globalThis.setInterval).toBe(once);
    });

    test('clearInterval/clearTimeout still work with ids returned by the traced timers', async () => {
        installIntervalTracing();
        performanceMonitor.enabled = true;

        const tick = vi.fn();
        const intervalId = setInterval(tick, 5);
        clearInterval(intervalId);
        const timeoutId = setTimeout(tick, 5);
        clearTimeout(timeoutId);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(tick).not.toHaveBeenCalled();
    });

    test('a traced handler scheduling another timeout inside its tick does not re-wrap the globals', async () => {
        installIntervalTracing();
        const tracedTimeout = globalThis.setTimeout;
        const tracedInterval = globalThis.setInterval;

        let innerRan = false;
        await new Promise((resolve) => {
            setTimeout(() => {
                setTimeout(() => {
                    innerRan = true;
                    resolve();
                }, 0);
            }, 0);
        });

        expect(innerRan).toBe(true);
        expect(globalThis.setTimeout).toBe(tracedTimeout);
        expect(globalThis.setInterval).toBe(tracedInterval);
    });
});

describe('interval tracing wrapper semantics (against a fake target)', () => {
    /** A fake timer host that records registrations and lets tests fire ticks by hand. */
    function makeTarget() {
        const registered = { interval: [], timeout: [] };
        return {
            registered,
            setInterval: vi.fn(function (handler, delay, ...args) {
                registered.interval.push({ handler, delay, args, thisArg: this });
                return 111;
            }),
            setTimeout: vi.fn(function (handler, delay, ...args) {
                registered.timeout.push({ handler, delay, args, thisArg: this });
                return 222;
            }),
        };
    }

    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('string handlers pass through untouched to the original timers', () => {
        const target = makeTarget();
        const original = { setInterval: target.setInterval, setTimeout: target.setTimeout };
        installIntervalTracing(target);

        target.setInterval('code()', 50);
        target.setTimeout('code()', 50);

        expect(original.setInterval).toHaveBeenCalledWith('code()', 50);
        expect(original.setTimeout).toHaveBeenCalledWith('code()', 50);
        expect(target.registered.interval[0].handler).toBe('code()');
        expect(target.registered.timeout[0].handler).toBe('code()');
    });

    test('extra arguments are forwarded to the registration and to the handler on tick', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const handler = vi.fn();
        const id = target.setInterval(handler, 10, 'a', 42);
        expect(id).toBe(111);
        expect(target.registered.interval[0].delay).toBe(10);
        expect(target.registered.interval[0].args).toEqual(['a', 42]);

        // The host fires the tick with the extra args, like real timers do
        target.registered.interval[0].handler('a', 42);
        expect(handler).toHaveBeenCalledWith('a', 42);
    });

    test('`this` is preserved both when registering and when the tick fires', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const handler = vi.fn();
        const someThis = { site: 'window-like' };
        target.setTimeout.call(someThis, handler, 5);
        expect(target.registered.timeout[0].thisArg).toBe(someThis);

        const tickThis = { tick: true };
        target.registered.timeout[0].handler.call(tickThis);
        expect(handler.mock.contexts[0]).toBe(tickThis);
    });

    test('repeated install does not double-wrap either timer on the target', () => {
        const target = makeTarget();
        installIntervalTracing(target);
        const tracedInterval = target.setInterval;
        const tracedTimeout = target.setTimeout;
        installIntervalTracing(target);
        expect(target.setInterval).toBe(tracedInterval);
        expect(target.setTimeout).toBe(tracedTimeout);
    });

    test('wrapper functions carry their names in source, so keep_fnames preserves them in prod stacks', () => {
        // timerCallSite skips wrapper frames by NAME. In the dev build an
        // anonymous `const traced = function (…)` gets its name inferred from
        // the variable, but terser mangles variables and keep_fnames only
        // protects functions that are named in source — an anonymous wrapper
        // ships with a mangled stack name, the skip misses, and every timer
        // collapses into one call site. Assert the names are in the source.
        const target = makeTarget();
        installIntervalTracing(target);
        expect(target.setInterval.toString()).toMatch(/^function traced\(/);
        expect(target.setTimeout.toString()).toMatch(/^function tracedTimeout\(/);
    });

    test('a restored setTimeout is re-netted on reinstall even though setInterval is still traced', () => {
        const target = makeTarget();
        const bareTimeout = target.setTimeout;
        installIntervalTracing(target);
        expect(target.setTimeout).not.toBe(bareTimeout);

        // Page code saved setTimeout before install and put it back afterwards
        target.setTimeout = bareTimeout;
        installIntervalTracing(target);

        expect(target.setTimeout).not.toBe(bareTimeout);
        expect(target.setTimeout.__toolashaTraced).toBe(true);
        expect(target.setInterval.__toolashaTraced).toBe(true);
    });
});

describe('timerCallSite parsing (synthetic stacks)', () => {
    test('Chrome: first frame past the trace internals names the caller and line', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/toolasha.user.js:100:15)',
            '    at Object.traced (https://host/toolasha.user.js:120:20)',
            '    at _startRefreshing (https://host/toolasha.user.js:53201:9)',
            '    at initialize (https://host/toolasha.user.js:53300:5)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('_startRefreshing@53201');
    });

    test('Chrome: an async-prefixed caller frame keeps its name', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at async loadPrices (https://host/t.js:4210:11)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('loadPrices@4210');
    });

    test('Chrome: a constructor frame ("new Foo") keeps its name', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at tracedTimeout (https://host/t.js:150:20)',
            '    at new MarketFilter (https://host/t.js:900:7)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('MarketFilter@900');
    });

    test('Chrome: an anonymous frame (arrow in minified prod) yields anon plus line', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at https://host/t.js:7777:3',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@7777');
    });

    test('Chrome: "Object.<anonymous>" normalizes to anon instead of leaking "<anonymous>"', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at Object.<anonymous> (https://host/t.js:88:1)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@88');
    });

    test("a frame from another file is tagged as the page's, both stack formats", () => {
        // The wrapper shares the page's window, so game timers land in the
        // net too — an 80ms game interval wearing a bare label sent a stall
        // hunt through our bundle for a call site that was never in it
        const chrome = [
            'Error',
            '    at traced (https://host/toolasha.user.js:120:20)',
            '    at create (https://game.example/bundle.js:34705:5)',
        ].join('\n');
        expect(timerCallSite(chrome)).toBe('create@34705 (page)');

        const firefox = [
            'traced@https://host/toolasha.user.js:120:20',
            'create@https://game.example/bundle.js:34705:5',
        ].join('\n');
        expect(timerCallSite(firefox)).toBe('create@34705 (page)');
    });

    test('Chrome: an eval frame is parsed without crashing and keeps a line number', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at eval (eval at run (https://host/t.js:10:5), <anonymous>:3:7)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('eval@3');
    });

    test('Firefox: named frames skip the internals with @-syntax', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            '_startRefreshing@https://host/t.js:53201:9',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('_startRefreshing@53201');
    });

    test('Firefox: a bare "@" frame with no name yields anon plus line', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            '@https://host/t.js:640:5',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@640');
    });

    test('Firefox: an async* caller marker does not swallow the name', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            'async*refreshLoop@https://host/t.js:311:9',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('refreshLoop@311');
    });

    test('Firefox: eval frames ("line 10 > eval") still parse to a name and line', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'tracedTimeout@https://host/t.js:150:20',
            'runMacro@https://host/t.js line 10 > eval:2:3',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('runMacro@2');
    });

    test('an unparseable stack falls back to "unknown"', () => {
        expect(timerCallSite('')).toBe('unknown');
        expect(timerCallSite('Error\n    at <anonymous>')).toBe('unknown');
        expect(timerCallSite('total garbage')).toBe('unknown');
    });

    test('without an injected stack it reads its own call stack', () => {
        const site = timerCallSite();
        expect(typeof site).toBe('string');
        expect(site.length).toBeGreaterThan(0);
    });
});

describe('stall attribution on the monotonic clock', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
        performanceMonitor.events = [];
    });

    test('a wall-clock (NTP) jump between the work and the read does not lose the suspect', () => {
        performanceMonitor.record('networth:recalculate', 171);

        // NTP steps Date.now() forward a minute; performance.now() is unmoved
        const jumped = Date.now() + 60_000;
        const spy = vi.spyOn(Date, 'now').mockReturnValue(jumped);
        try {
            const now = performance.now();
            const suspects = performanceMonitor._suspectsFor({ startTime: now - 200, duration: 200 });
            expect(suspects.map((s) => s.name)).toEqual(['networth:recalculate']);
        } finally {
            spy.mockRestore();
        }
    });

    test('a backwards wall-clock jump does not blame stale work', () => {
        performanceMonitor.record('networth:recalculate', 171);
        const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 60_000);
        try {
            const suspects = performanceMonitor._suspectsFor({
                startTime: performance.now() + 5000,
                duration: 100,
            });
            expect(suspects).toEqual([]);
        } finally {
            spy.mockRestore();
        }
    });

    test('work that started before the stall window but finished inside it is a suspect', () => {
        // End stamp lands inside the stall even though the work began long before it
        performanceMonitor.measurements.set('init:slowFeature', [
            { time: Date.now(), perfTime: 1010, duration: 500 }, // ran 510..1010
        ]);
        const suspects = performanceMonitor._suspectsFor({ startTime: 1000, duration: 100 });
        expect(suspects).toEqual([{ name: 'init:slowFeature', ms: 500 }]);
    });

    test('suspect window edges: the -50 lead and +100 tail are inclusive, beyond them is out', () => {
        performanceMonitor.measurements.set('dom:edge', [
            { time: Date.now(), perfTime: 949, duration: 10 }, // just before the lead
            { time: Date.now(), perfTime: 950, duration: 20 }, // exactly on the lead
            { time: Date.now(), perfTime: 1200, duration: 30 }, // exactly on the tail
            { time: Date.now(), perfTime: 1201, duration: 40 }, // just past the tail
        ]);
        const suspects = performanceMonitor._suspectsFor({ startTime: 1000, duration: 100 });
        expect(suspects.map((s) => s.ms).sort((a, b) => a - b)).toEqual([20, 30]);
    });

    test('noteEvent attribution survives a wall-clock jump and respects the window edges', () => {
        performanceMonitor.events = [
            { name: 'ws:too_early', time: 0, perfTime: 699 }, // just before the 300ms lead
            { name: 'ws:on_the_lead', time: 0, perfTime: 700 }, // exactly on it
            { name: 'ws:during', time: 0, perfTime: 1050 },
            { name: 'ws:at_stall_end', time: 0, perfTime: 1100 }, // inclusive end
            { name: 'ws:after', time: 0, perfTime: 1101 },
        ];
        const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
        try {
            const names = performanceMonitor._eventsFor({ startTime: 1000, duration: 100 });
            expect(names).toEqual(['ws:on_the_lead', 'ws:during', 'ws:at_stall_end']);
        } finally {
            spy.mockRestore();
        }
    });

    test('_eventsFor keeps only the five most recent names inside the window', () => {
        performanceMonitor.events = Array.from({ length: 8 }, (_, i) => ({
            name: `ws:e${i}`,
            time: 0,
            perfTime: 1000 + i,
        }));
        const names = performanceMonitor._eventsFor({ startTime: 1000, duration: 100 });
        expect(names).toEqual(['ws:e3', 'ws:e4', 'ws:e5', 'ws:e6', 'ws:e7']);
    });

    test('noteEvent ring stays bounded at 300', () => {
        for (let i = 0; i < 400; i++) performanceMonitor.noteEvent(`ws:n${i}`);
        expect(performanceMonitor.events.length).toBe(300);
        expect(performanceMonitor.events[0].name).toBe('ws:n100');
    });
});

describe('timer tracing does no work while measuring is off', () => {
    /** A fake timer host that records registrations and lets tests fire ticks by hand. */
    function makeTarget() {
        const registered = { interval: [], timeout: [] };
        return {
            registered,
            setInterval(handler, delay, ...args) {
                registered.interval.push({ handler, delay, args });
                return 111;
            },
            setTimeout(handler, delay, ...args) {
                registered.timeout.push({ handler, delay, args });
                return 222;
            },
        };
    }

    /**
     * Burn past the wrapper's 1ms recording floor, so the tick is actually
     * written into the rolling stats under whatever name it ended up with.
     */
    function spin() {
        const until = performance.now() + 2;
        while (performance.now() < until) {
            /* deliberate */
        }
    }

    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor._tabVisible = true;
        timerCounters.interval = 0;
        timerCounters.timeout = 0;
        timerCounters.domRearm = 0;
        timerCounters.named = 0;
    });

    test('no stack is captured when a timer is created with measuring off', () => {
        // The wrapper used to name every creation unconditionally: a
        // `new Error().stack` plus a regex parse, roughly 10µs, for every
        // `setTimeout` on the page for every user from boot. Nothing about
        // that work is useful until somebody is measuring.
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);

        const captureStack = vi.spyOn(globalThis, 'Error');

        target.setTimeout(function work() {}, 10);
        target.setInterval(function tick() {}, 10);

        expect(captureStack).not.toHaveBeenCalled();
        captureStack.mockRestore();
    });

    test('the creation is still counted, so the rate is visible without measuring', () => {
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);

        target.setTimeout(() => {}, 10);
        target.setTimeout(() => {}, 10);
        target.setInterval(() => {}, 10);

        expect(timerCounters.timeout).toBe(2);
        expect(timerCounters.interval).toBe(1);
        // Nothing was named, which is the whole point of the counter pair
        expect(timerCounters.named).toBe(0);
    });

    test('a non-function handler is not counted — it never gets a wrapper', () => {
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);

        target.setTimeout('code()', 10);
        expect(timerCounters.timeout).toBe(0);
    });

    test('naming still happens at creation when measuring is on', () => {
        performanceMonitor.enabled = true;
        const target = makeTarget();
        installIntervalTracing(target);

        target.setInterval(function tick() {
            spin();
        }, 10);
        target.registered.interval[0].handler();

        expect(timerCounters.named).toBe(1);
        const names = [...performanceMonitor.measurements.keys()].filter((n) => n.startsWith('interval:'));
        // A real call site, with a line number — not the degraded late name
        expect(names.length).toBe(1);
        expect(names[0]).not.toMatch(/@\?$/);
    });

    test('a timer created before the panel opened is named from its function at first tick', () => {
        // Its creation stack is gone and unrecoverable — the stack at tick time
        // is the event loop. The function name survives, so the timer still
        // shows up under something readable instead of vanishing from the
        // panel; `@?` marks the line number as the part that is missing.
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);
        target.setInterval(function _startRefreshing() {
            spin();
        }, 10);

        performanceMonitor.enabled = true;
        const tick = target.registered.interval[0].handler;
        tick();

        expect([...performanceMonitor.measurements.keys()]).toContain('interval:_startRefreshing@?');
    });

    test('the late name is computed once, not on every tick', () => {
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);
        target.setTimeout(function poll() {
            spin();
        }, 10);

        performanceMonitor.enabled = true;
        const tick = target.registered.timeout[0].handler;
        tick();
        tick();

        const names = [...performanceMonitor.measurements.keys()].filter((n) => n.startsWith('timeout:'));
        expect(names).toEqual(['timeout:poll@?']);
    });

    test('an anonymous handler created with measuring off still gets a usable name', () => {
        performanceMonitor.enabled = false;
        const target = makeTarget();
        installIntervalTracing(target);
        target.setTimeout(
            Object.defineProperty(() => spin(), 'name', { value: '' }),
            10
        );

        performanceMonitor.enabled = true;
        target.registered.timeout[0].handler();

        // Never the bare `timeout:anon@?` it used to be: that one name was
        // shared by every anonymous timer in the script, so the row it made
        // was the biggest line in a live dump and named nothing
        const [name] = [...performanceMonitor.measurements.keys()];
        expect(name).toMatch(/^timeout:anon#\d+/);
    });

    test('the counters hang off the monitor, which is how the panel reaches them', () => {
        expect(performanceMonitor.timerCounters).toBe(timerCounters);
    });
});

describe('unattributed stall time', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
        performanceMonitor.stalls = [];
    });

    /**
     * Record a stall as if the observer had seen it, with `covered` of its
     * milliseconds accounted for by measured Toolasha work.
     * @param {number} duration - Stall length
     * @param {number} covered - Covered milliseconds
     * @returns {Object} The stall
     */
    const stallCovering = (duration, covered) => ({ duration, coveredMs: covered, time: Date.now() });

    test('a stall no measured span overlapped counts toward the unattributed figure', () => {
        // Nothing recorded, so nothing can overlap
        performanceMonitor._recordStall({ startTime: performance.now(), duration: 300 });

        const attribution = performanceMonitor.getStallAttribution(Infinity);

        expect(attribution.stalls).toBe(1);
        expect(attribution.unattributedStalls).toBe(1);
        expect(attribution.unattributedMs).toBe(300);
        expect(attribution.ourStalls).toBe(0);
    });

    test('a stall a measured span ran through does not', () => {
        const now = performance.now();
        // A 300ms span that finished right now: it covers the whole stall
        performanceMonitor.record('networth:recalculate', 300);
        performanceMonitor._recordStall({ startTime: now - 300, duration: 300 });

        const attribution = performanceMonitor.getStallAttribution(Infinity);

        expect(attribution.stalls).toBe(1);
        expect(attribution.ourStalls).toBe(1);
        expect(attribution.unattributedStalls).toBe(0);
        expect(attribution.unattributedMs).toBeLessThan(60);
    });

    test('nested spans covering the same milliseconds are not counted twice', () => {
        const now = performance.now();
        performanceMonitor.record('outer', 100);
        performanceMonitor.record('inner', 90);

        performanceMonitor._recordStall({ startTime: now - 200, duration: 200 });

        // Both spans end at ~now, so their union is ~100ms of a 200ms stall,
        // not 190ms. That is the partly-ours band.
        const stall = performanceMonitor.getStalls()[0];
        expect(stall.coveredMs).toBeGreaterThan(90);
        expect(stall.coveredMs).toBeLessThan(120);
    });

    describe('the partial-overlap rule', () => {
        test('80% covered or more is ours', () => {
            expect(stallCoverage(stallCovering(100, 80)).verdict).toBe('ours');
            expect(stallCoverage(stallCovering(100, 100)).verdict).toBe('ours');
        });

        test('20% covered or less is not ours', () => {
            expect(stallCoverage(stallCovering(100, 20)).verdict).toBe('not-ours');
            expect(stallCoverage(stallCovering(100, 0)).verdict).toBe('not-ours');
        });

        test('in between is partly ours, and lands in neither bucket', () => {
            expect(stallCoverage(stallCovering(100, 50)).verdict).toBe('partly-ours');

            performanceMonitor.stalls = [stallCovering(100, 50)];
            const attribution = performanceMonitor.getStallAttribution(Infinity);

            expect(attribution.partlyOursStalls).toBe(1);
            expect(attribution.ourStalls).toBe(0);
            expect(attribution.unattributedStalls).toBe(0);
        });

        test('a partly-ours stall contributes only its uncovered half to the millisecond figure', () => {
            performanceMonitor.stalls = [stallCovering(200, 60)];

            expect(performanceMonitor.getStallAttribution(Infinity).unattributedMs).toBe(140);
        });

        test('coverage can never exceed the stall it is measured against', () => {
            // A span longer than the stall is clipped to the stall's window
            const now = performance.now();
            performanceMonitor.record('long', 5000);
            performanceMonitor._recordStall({ startTime: now - 100, duration: 100 });

            const stall = performanceMonitor.getStalls()[0];
            expect(stall.coveredMs).toBeLessThanOrEqual(100);
            expect(stallCoverage(stall).coverage).toBeLessThanOrEqual(1);
        });

        test('a stall with no coverage field at all reads as not ours rather than throwing', () => {
            expect(stallCoverage({ duration: 120 }).verdict).toBe('not-ours');
            expect(stallCoverage(undefined).coverage).toBe(0);
        });
    });

    test('the rolling window excludes stalls older than it', () => {
        performanceMonitor.stalls = [
            { duration: 100, coveredMs: 0, time: Date.now() - 60000 },
            { duration: 100, coveredMs: 0, time: Date.now() },
        ];

        expect(performanceMonitor.getStallAttribution(5000).stalls).toBe(1);
        expect(performanceMonitor.getStallAttribution(Infinity).stalls).toBe(2);
    });

    test('the stall ring stays capped, so the attribution figure cannot grow without bound', () => {
        for (let i = 0; i < 500; i++) {
            performanceMonitor._recordStall({ startTime: i, duration: 60 });
        }

        expect(performanceMonitor.getStalls()).toHaveLength(200);
        expect(performanceMonitor.getStallAttribution(Infinity).stalls).toBe(200);
    });
});

describe('leak canary', () => {
    /**
     * Feed the canary a series of counts for one source.
     * @param {Object} canary - The canary
     * @param {string} name - Source name
     * @param {number[]} series - Counts, oldest first
     */
    const feed = (canary, name, series) => {
        for (const value of series) canary.sample({ [name]: value });
    };

    test('a count that only ever climbs past the floor is flagged', () => {
        const canary = createLeakCanary();
        feed(
            canary,
            'chat:processedMessages',
            Array.from({ length: 20 }, (_, i) => 20 + i * 5)
        );

        const row = canary.getReport().find((r) => r.source === 'chat:processedMessages');
        expect(row.growing).toBe(true);
        expect(row.latest).toBe(115);
        expect(row.lowest).toBe(20);
    });

    test('a count that rises and falls is not', () => {
        const canary = createLeakCanary();
        feed(canary, 'dom:pendingDebounces', [20, 40, 60, 80, 30, 90, 120, 160, 200, 240, 280, 320]);

        expect(canary.getReport()[0].growing).toBe(false);
        expect(canary.getReport()[0].decreases).toBe(1);
    });

    test('one decrease disqualifies a source for the rest of the session', () => {
        const canary = createLeakCanary();
        feed(canary, 'cleanup:listeners', [50, 10]);
        feed(
            canary,
            'cleanup:listeners',
            Array.from({ length: 40 }, (_, i) => 20 + i * 10)
        );

        expect(canary.getReport()[0].growing).toBe(false);
    });

    test('a small count that climbs stays quiet — the floor stops it crying wolf', () => {
        const canary = createLeakCanary();
        feed(canary, 'timers:intervals', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

        expect(canary.getReport()[0].growing).toBe(false);
        expect(canary.getReport()[0].latest).toBe(12);
    });

    test('a big but flat count stays quiet too — growth is the signal, not size', () => {
        const canary = createLeakCanary();
        feed(
            canary,
            'dom:handlers',
            Array.from({ length: 30 }, () => 150)
        );

        expect(canary.getReport()[0].growing).toBe(false);
    });

    test('a source with too few samples is not judged yet', () => {
        const canary = createLeakCanary();
        feed(canary, 'cleanup:listeners', [20, 60, 200]);

        expect(canary.getReport()[0].growing).toBe(false);
    });

    test('every source is reported separately, not as one total', () => {
        const canary = createLeakCanary();
        for (let i = 0; i < 15; i++) {
            canary.sample({ 'cleanup:listeners': 30 + i * 10, 'dom:handlers': 150 });
        }

        const report = canary.getReport();
        expect(report).toHaveLength(2);
        expect(report.map((r) => r.source).sort()).toEqual(['cleanup:listeners', 'dom:handlers']);
        // Growing ones sort first so the actionable row is at the top
        expect(report[0].source).toBe('cleanup:listeners');
        expect(report[0].growing).toBe(true);
        expect(report[1].growing).toBe(false);
    });

    test('the thresholds are tunable rather than baked in', () => {
        const canary = createLeakCanary({ floor: 2, minSamples: 3, growthFactor: 1.1 });
        feed(canary, 'tiny', [2, 3, 4]);

        expect(canary.getReport()[0].growing).toBe(true);
    });

    describe('what the canary retains is capped', () => {
        test('the per-source history never exceeds maxSamples', () => {
            const canary = createLeakCanary({ maxSamples: 10 });
            feed(
                canary,
                'cleanup:listeners',
                Array.from({ length: 500 }, (_, i) => i)
            );

            const row = canary.getReport()[0];
            expect(row.samples).toBe(500);
            expect(row.latest).toBe(499);
            // The verdict still covers the whole session even though only the
            // last 10 readings are kept
            expect(row.lowest).toBe(0);
        });

        test('the number of tracked sources never exceeds maxSources', () => {
            const canary = createLeakCanary({ maxSources: 4 });
            for (let i = 0; i < 200; i++) canary.sample({ [`source${i}`]: i });

            expect(canary.getReport()).toHaveLength(4);
        });

        test('reset drops everything, so a closed panel holds nothing', () => {
            const canary = createLeakCanary();
            feed(canary, 'cleanup:listeners', [10, 20, 30]);
            canary.reset();

            expect(canary.getReport()).toEqual([]);
        });

        test('a non-numeric or missing reading is ignored rather than thrown on', () => {
            const canary = createLeakCanary();
            expect(() => canary.sample(null)).not.toThrow();
            canary.sample({ ok: 5, bad: undefined, worse: NaN });

            expect(canary.getReport().map((r) => r.source)).toEqual(['ok']);
        });
    });
});

describe('heap trend', () => {
    let saved;

    beforeEach(() => {
        saved = Object.getOwnPropertyDescriptor(performance, 'memory');
    });

    afterEach(() => {
        if (saved) Object.defineProperty(performance, 'memory', saved);
        else delete performance.memory;
    });

    /**
     * Pretend to be Chrome, with a heap we control.
     * @param {{used: number}} state - Mutable heap state
     */
    const fakeMemory = (state) => {
        Object.defineProperty(performance, 'memory', {
            configurable: true,
            get: () => ({ usedJSHeapSize: state.used }),
        });
    };

    test('with performance.memory absent nothing is reported and nothing throws', () => {
        delete performance.memory;

        expect(heapMemorySupported()).toBe(false);
        const trend = createHeapTrend();
        expect(() => trend.sample()).not.toThrow();
        expect(trend.sample()).toBe(null);
        expect(trend.getTrend()).toBe(null);
    });

    test('with performance present but memory absent it still degrades rather than throwing', () => {
        Object.defineProperty(performance, 'memory', { configurable: true, get: () => undefined });

        expect(heapMemorySupported()).toBe(false);
        expect(createHeapTrend().getTrend()).toBe(null);
    });

    test('a single reading is a number, not yet a trend', () => {
        const state = { used: 50 * 1048576 };
        fakeMemory(state);
        const trend = createHeapTrend();
        trend.sample();

        expect(trend.getTrend()).toBe(null);
    });

    test('a climbing heap reports how far it climbed and how fast', () => {
        const state = { used: 50 * 1048576 };
        fakeMemory(state);
        const trend = createHeapTrend();

        trend.sample();
        state.used = 80 * 1048576;
        trend.sample();

        const report = trend.getTrend();
        expect(report.usedMb).toBeCloseTo(80, 5);
        expect(report.changeMb).toBeCloseTo(30, 5);
        expect(report.samples).toBe(2);
    });

    test('the retained readings are capped, and the trend still spans them', () => {
        const state = { used: 0 };
        fakeMemory(state);
        const trend = createHeapTrend({ maxSamples: 10 });

        for (let i = 0; i < 500; i++) {
            state.used = i * 1048576;
            trend.sample();
        }

        // 500 readings taken, at most 10 kept
        expect(trend.getTrend().samples).toBe(10);
        expect(trend.getTrend().usedMb).toBeCloseTo(499, 5);
        expect(trend.getTrend().changeMb).toBeCloseTo(9, 5);
    });

    test('reset drops the readings', () => {
        const state = { used: 1048576 };
        fakeMemory(state);
        const trend = createHeapTrend();
        trend.sample();
        trend.sample();
        trend.reset();

        expect(trend.getTrend()).toBe(null);
    });
});

/**
 * The registration the canary's own doc promised: a feature hands over a named
 * count getter, and the panel folds it in beside the registry counts.
 *
 * The collections most likely to be leaking are plain fields on a feature
 * instance — a Map, an object of Maps — which no registry knows about, so
 * without this the canary is blind to exactly what it exists to find.
 */
describe('registered count sources', () => {
    const registered = [];

    /**
     * Register and remember, so nothing leaks into the next test.
     * @param {string} name
     * @param {() => number} getCount
     * @returns {Function} The unregister function
     */
    const register = (name, getCount) => {
        const off = registerCountSource(name, getCount);
        registered.push(off);
        return off;
    };

    afterEach(() => {
        while (registered.length) registered.pop()();
    });

    test('a registered source is read by name', () => {
        const messages = new Map([['a', 1]]);
        register('dungeon:processedMessages', () => messages.size);

        expect(readCountSources()['dungeon:processedMessages']).toBe(1);
        messages.set('b', 2);
        expect(readCountSources()['dungeon:processedMessages']).toBe(2);
    });

    test('a registered source can raise the canary growth flag', () => {
        let size = 20;
        register('dungeon:processedMessages', () => size);
        const canary = createLeakCanary();

        for (let i = 0; i < 15; i++) {
            canary.sample(readCountSources());
            size += 10;
        }

        const row = canary.getReport().find((r) => r.source === 'dungeon:processedMessages');
        expect(row.growing).toBe(true);
        expect(row.lowest).toBe(20);
    });

    test('a getter that throws costs its own row and nothing else', () => {
        register('broken', () => {
            throw new Error('gone');
        });
        register('fine', () => 7);

        let counts;
        expect(() => {
            counts = readCountSources();
        }).not.toThrow();
        expect(counts).toEqual({ fine: 7 });
    });

    test('a getter that answers with something that is not a number is skipped', () => {
        register('nan', () => NaN);
        register('text', () => 'lots');
        register('fine', () => 3);

        expect(readCountSources()).toEqual({ fine: 3 });
    });

    test('unregistering removes the source, and doing it twice is harmless', () => {
        const off = register('going', () => 5);
        expect(readCountSources().going).toBe(5);

        off();
        expect(readCountSources().going).toBeUndefined();
        expect(() => off()).not.toThrow();
    });

    test('registering the same name again replaces rather than duplicates', () => {
        register('dungeon:processedMessages', () => 1);
        register('dungeon:processedMessages', () => 2);

        expect(readCountSources()).toEqual({ 'dungeon:processedMessages': 2 });
    });

    test('a registration with no name or no getter is refused, not stored', () => {
        expect(() => registerCountSource('', () => 1)).not.toThrow();
        expect(() => registerCountSource('x', null)).not.toThrow();
        expect(readCountSources()).toEqual({});
    });

    test('the API is reachable from the published instance, which is how later bundles get it', () => {
        expect(typeof performanceMonitor.registerCountSource).toBe('function');
        expect(typeof performanceMonitor.readCountSources).toBe('function');
    });
});

describe('late naming of timers created before measuring started', () => {
    /** A fake timer host: registrations are captured and ticks are fired by hand. */
    function makeTarget() {
        const registered = { interval: [], timeout: [] };
        return {
            registered,
            setInterval: vi.fn((handler, delay, ...args) => {
                registered.interval.push({ handler, delay, args });
                return 111;
            }),
            setTimeout: vi.fn((handler, delay, ...args) => {
                registered.timeout.push({ handler, delay, args });
                return 222;
            }),
        };
    }

    /** Register a handler with measuring off, then tick it with measuring on. */
    function tickLate(target, kind, handler) {
        performanceMonitor.enabled = false;
        target[kind === 'interval' ? 'setInterval' : 'setTimeout'](handler, 5);
        performanceMonitor.enabled = true;
        const entry = target.registered[kind].at(-1);
        entry.handler();
        return entry;
    }

    /** A body slow enough to clear the 1ms recording floor. */
    function burn() {
        const t0 = performance.now();
        while (performance.now() - t0 < 2) {
            // spin
        }
    }

    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor._tabVisible = true;
    });

    afterEach(() => {
        performanceMonitor.enabled = false;
    });

    test('two different anonymous intervals get different labels', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const first = tickLate(target, 'interval', () => burn());
        const second = tickLate(target, 'interval', () => burn());

        const names = [...performanceMonitor.measurements.keys()];
        expect(names).toHaveLength(2);
        expect(names[0]).not.toBe(names[1]);
        for (const name of names) expect(name).toMatch(/^interval:anon#\d+/);
        expect(first.handler).not.toBe(second.handler);
    });

    test('an anonymous handler keeps the same label across its own later ticks', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const entry = tickLate(target, 'interval', () => burn());
        const afterFirst = [...performanceMonitor.measurements.keys()];
        expect(afterFirst).toHaveLength(1);

        entry.handler();
        entry.handler();

        expect([...performanceMonitor.measurements.keys()]).toEqual(afterFirst);
        expect(performanceMonitor.measurements.get(afterFirst[0])).toHaveLength(3);
    });

    test('the same anonymous handler registered twice reports under one label', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        // One handler, two timers: keying labels by handler identity keeps the
        // two registrations aggregated, the way one captured call site does.
        // Via an array so no name is inferred — a `const f = function () {}`
        // is not anonymous, it is named `f`.
        const [shared] = [
            function () {
                burn();
            },
        ];
        expect(shared.name).toBe('');
        tickLate(target, 'interval', shared);
        tickLate(target, 'interval', shared);

        const names = [...performanceMonitor.measurements.keys()];
        expect(names).toHaveLength(1);
        expect(performanceMonitor.measurements.get(names[0])).toHaveLength(2);
    });

    test('the label carries a word lifted from the handler source, so it can be grepped', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const panel = { refreshTheMarketPanel: () => {} };
        tickLate(target, 'interval', () => {
            panel.refreshTheMarketPanel();
            burn();
        });

        const [name] = [...performanceMonitor.measurements.keys()];
        expect(name).toMatch(/^interval:anon#\d+\.refreshTheMarketPanel@\?$/);
    });

    test('timeouts are labelled the same way, not collapsed into one anon row', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        tickLate(target, 'timeout', () => burn());
        tickLate(target, 'timeout', () => burn());

        const names = [...performanceMonitor.measurements.keys()];
        expect(names).toHaveLength(2);
        expect(names[0]).not.toBe(names[1]);
        for (const name of names) expect(name).toMatch(/^timeout:anon#\d+/);
    });

    test('a named handler is unaffected by the anonymous labelling', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        tickLate(target, 'interval', function _startRefreshing() {
            burn();
        });

        expect([...performanceMonitor.measurements.keys()]).toEqual(['interval:_startRefreshing@?']);
    });

    test('nothing is named while measuring is off, so the disabled tick path is untouched', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const inner = vi.fn();
        const [probe] = [
            function () {
                inner();
            },
        ];
        // toString is the only thing labelling can call on the handler, so a
        // spy on it catches any naming work that leaked onto the disabled path
        const toString = vi.spyOn(Function.prototype, 'toString');

        performanceMonitor.enabled = false;
        target.setInterval(probe, 5);
        const entry = target.registered.interval.at(-1);
        entry.handler();
        entry.handler();

        expect(inner).toHaveBeenCalledTimes(2);
        expect(toString).not.toHaveBeenCalled();
        expect(performanceMonitor.measurements.size).toBe(0);
        toString.mockRestore();
    });

    test('the timerCallSite naming path still names timers created while measuring', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        performanceMonitor.enabled = true;
        target.setInterval(() => burn(), 5);
        target.registered.interval.at(-1).handler();

        const [name] = [...performanceMonitor.measurements.keys()];
        // A real line number, not `@?`: the call site was captured at creation
        expect(name).toMatch(/^interval:\S+@\d+/);
        expect(name).not.toContain('anon#');
    });
});

describe('explicit timer labels', () => {
    // Shared across every test in this block, never reset: `timerLabels` in
    // performance-monitor.js is module-scoped state, not something
    // `performanceMonitor.reset()` touches, so two tests' fake hosts handing
    // out the same id (e.g. both starting a fresh counter at 1) would leak a
    // label from one test into the next. A monotonically increasing id across
    // the whole file rules that out; the "reused id" tests below force a
    // repeat deliberately instead.
    let nextId = 1;

    /** A fake timer host with incrementing ids and a working clearInterval/clearTimeout. */
    function makeTarget() {
        const registered = { interval: [], timeout: [] };
        return {
            registered,
            setInterval: vi.fn((handler, delay, ...args) => {
                const id = nextId++;
                registered.interval.push({ id, handler, delay, args });
                return id;
            }),
            setTimeout: vi.fn((handler, delay, ...args) => {
                const id = nextId++;
                registered.timeout.push({ id, handler, delay, args });
                return id;
            }),
            clearInterval: vi.fn(),
            clearTimeout: vi.fn(),
        };
    }

    /** A body slow enough to clear the 1ms recording floor. */
    function burn() {
        const t0 = performance.now();
        while (performance.now() - t0 < 2) {
            // spin
        }
    }

    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('a labelled interval records under its label instead of the guessed call site', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const id = target.setInterval(() => burn(), 10);
        performanceMonitor.labelTimer(id, 'overlayPanel.refresh');
        target.registered.interval.at(-1).handler();

        expect([...performanceMonitor.measurements.keys()]).toEqual(['interval:overlayPanel.refresh']);
    });

    test("an unlabelled interval still falls back to today's guessed name", () => {
        const target = makeTarget();
        installIntervalTracing(target);

        target.setInterval(() => burn(), 10);
        target.registered.interval.at(-1).handler();

        const [name] = [...performanceMonitor.measurements.keys()];
        // Created with measuring on, so it is the timerCallSite name (a real
        // line number), not the label and not the late `anon#` fallback.
        expect(name).toMatch(/^interval:\S+@\d+/);
        expect(name).not.toBe('interval:overlayPanel.refresh');
    });

    test('a label attached after creation still applies at the first tick', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        // Measuring off at registration, like a timer created before the panel
        // opened — the label still has to win once one is attached.
        performanceMonitor.enabled = false;
        const id = target.setInterval(() => burn(), 10);
        performanceMonitor.enabled = true;
        performanceMonitor.labelTimer(id, 'overlayPanel.refresh');
        target.registered.interval.at(-1).handler();

        expect([...performanceMonitor.measurements.keys()]).toEqual(['interval:overlayPanel.refresh']);
    });

    test('clearing a labelled timer drops the label, so a reused id starts unlabelled', () => {
        const target = makeTarget();
        // installIntervalTracing replaces target.setInterval with its traced
        // wrapper, so mocking a later call has to go through the original
        // vi.fn the wrapper still closes over, not the outer property.
        const originalSetInterval = target.setInterval;
        installIntervalTracing(target);

        const id = target.setInterval(() => burn(), 10);
        performanceMonitor.labelTimer(id, 'overlayPanel.refresh');
        target.clearInterval(id);

        // Browsers can hand the same numeric id to the very next timer created;
        // force that here to prove the label doesn't leak onto whatever gets it.
        originalSetInterval.mockImplementationOnce((handler, delay, ...args) => {
            target.registered.interval.push({ id, handler, delay, args });
            return id;
        });
        target.setInterval(() => burn(), 10);
        target.registered.interval.at(-1).handler();

        const [name] = [...performanceMonitor.measurements.keys()];
        expect(name).not.toBe('interval:overlayPanel.refresh');
    });

    test('timeouts can be labelled the same way', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const id = target.setTimeout(() => burn(), 10);
        performanceMonitor.labelTimer(id, 'combatSim.poll');
        target.registered.timeout.at(-1).handler();

        expect([...performanceMonitor.measurements.keys()]).toEqual(['timeout:combatSim.poll']);
    });

    test('clearing a labelled timeout drops the label', () => {
        const target = makeTarget();
        const originalSetTimeout = target.setTimeout;
        installIntervalTracing(target);

        const id = target.setTimeout(() => burn(), 10);
        performanceMonitor.labelTimer(id, 'combatSim.poll');
        target.clearTimeout(id);

        originalSetTimeout.mockImplementationOnce((handler, delay, ...args) => {
            target.registered.timeout.push({ id, handler, delay, args });
            return id;
        });
        target.setTimeout(() => burn(), 10);
        target.registered.timeout.at(-1).handler();

        const [name] = [...performanceMonitor.measurements.keys()];
        expect(name).not.toBe('timeout:combatSim.poll');
    });

    test('labelTimer ignores a falsy id or label rather than poisoning the map', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        performanceMonitor.labelTimer(0, 'overlayPanel.refresh');
        performanceMonitor.labelTimer(undefined, 'overlayPanel.refresh');
        const id = target.setInterval(() => burn(), 10);
        performanceMonitor.labelTimer(id, '');
        target.registered.interval.at(-1).handler();

        const [name] = [...performanceMonitor.measurements.keys()];
        expect(name).not.toBe('interval:overlayPanel.refresh');
    });
});

describe('elapsed versus blocking measurements', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('a yielding span quotes wall time and no CPU percentage', () => {
        // The live figure: one recalculate, 452ms of wall clock across yields,
        // reported for days as 9% CPU in a window with zero stalls
        performanceMonitor.recordElapsed('networth:recalculate', 452.6);

        const stats = performanceMonitor.getStats('networth:recalculate');

        expect(stats.kind).toBe('elapsed');
        expect(stats.cpuPercent).toBeNull();
        // Not lost: half a second is still half a second of waiting
        expect(stats.totalMs).toBeCloseTo(452.6);
        expect(stats.wallPercent).toBeCloseTo((452.6 / performanceMonitor.windowMs) * 100);
    });

    test('a blocking measurement still quotes CPU, unchanged', () => {
        performanceMonitor.record('dom:MarketFilter', 250);

        const stats = performanceMonitor.getStats('dom:MarketFilter');

        expect(stats.kind).toBe('blocking');
        expect(stats.cpuPercent).toBe(5);
        expect(stats.wallPercent).toBeNull();
    });

    test('a yielding span is not blamed for a stall it merely spanned', () => {
        const now = performance.now();
        // 300ms of wall clock ending now, of which almost none was on the
        // thread — the stall underneath it is somebody else's
        performanceMonitor.recordElapsed('networth:recalculate', 300);
        performanceMonitor._recordStall({ startTime: now - 300, duration: 300 });

        const attribution = performanceMonitor.getStallAttribution(Infinity);

        expect(performanceMonitor.getStalls()[0].suspects).toEqual([]);
        expect(attribution.ourStalls).toBe(0);
        expect(attribution.unattributedStalls).toBe(1);
    });

    test('one blocking phase inside a yielding run is still attributed', () => {
        const now = performance.now();
        performanceMonitor.record('networth:updateDisplays', 300);
        performanceMonitor.recordElapsed('networth:recalculate', 300);
        performanceMonitor._recordStall({ startTime: now - 300, duration: 300 });

        const stall = performanceMonitor.getStalls()[0];

        expect(stall.suspects.map((suspect) => suspect.name)).toEqual(['networth:updateDisplays']);
    });

    test('recordElapsed() is a no-op when disabled, and tags nothing', () => {
        performanceMonitor.enabled = false;
        performanceMonitor.recordElapsed('networth:recalculate', 452);

        expect(performanceMonitor.getStats('networth:recalculate')).toBeNull();
        expect(performanceMonitor.isElapsedMetric('networth:recalculate')).toBe(false);
    });

    test('wrap() times an async function as elapsed, a sync one as blocking', async () => {
        await performanceMonitor.wrap('asyncThing', async () => {
            await Promise.resolve();
        })();
        performanceMonitor.wrap('syncThing', () => 1)();

        expect(performanceMonitor.getStats('asyncThing').kind).toBe('elapsed');
        expect(performanceMonitor.getStats('syncThing').kind).toBe('blocking');
    });

    test('reset() forgets the tagging along with the measurements', () => {
        performanceMonitor.recordElapsed('networth:recalculate', 452);
        performanceMonitor.reset();

        expect(performanceMonitor.isElapsedMetric('networth:recalculate')).toBe(false);
    });
});
