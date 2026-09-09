/**
 * Performance Monitor
 * Tracks execution time of features and DOM observer handlers
 * using a rolling window for CPU percentage calculations.
 */

const WINDOW_MS = 5000;

/**
 * Hard ceiling on entries kept per metric. Stale entries are pruned when the
 * stats are read, but a session with measuring on and the panel closed never
 * reads them — a busy interval would otherwise grow its array all afternoon.
 * The rolling window rarely holds more than a few hundred entries, so the cap
 * never bites a metric that is actually being watched.
 */
const MAX_ENTRIES_PER_METRIC = 1000;

/**
 * Where a stall stops being ours and starts being somebody else's.
 *
 * `coveredMs` on a stall is how many of its milliseconds a *measured* Toolasha
 * span was running for (union, so nested spans are not counted twice). The two
 * thresholds below turn that into a verdict:
 *
 * - covered >= 80% of the stall -> `ours`
 * - covered <= 20%              -> `not-ours`
 * - anything between            -> `partly-ours`, counted in neither bucket
 *
 * The middle band exists because silently rounding a half-covered stall to
 * either side is the one thing that would make this figure dishonest. A stall
 * we half-caused is shown as half-caused.
 */
const STALL_OURS_COVERAGE = 0.8;
const STALL_NOT_OURS_COVERAGE = 0.2;

/** @returns {number} The monotonic clock, safe where `performance` is absent */
function monotonicNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * When the script started, as the clock the rest of the timings are quoted
 * against. `performance.now()` is already relative to page navigation, but the
 * userscript runs at document-start and the difference matters when the
 * question is "what happened before my feature got a turn".
 */
const BOOT_AT = typeof performance !== 'undefined' ? performance.now() : 0;

/**
 * Total length of a set of possibly overlapping intervals.
 * @param {Array<[number, number]>} intervals - `[from, to]` pairs, unsorted
 * @returns {number} Milliseconds covered by at least one interval
 */
function unionLength(intervals) {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [from, to] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i];
        if (next[0] > to) {
            total += to - from;
            [from, to] = next;
        } else if (next[1] > to) {
            to = next[1];
        }
    }
    return total + (to - from);
}

/**
 * What a recorded stall can honestly be said to be.
 *
 * **This cannot name a culprit.** `not-ours` means exactly one thing: no
 * Toolasha span we were measuring was running while the main thread was
 * blocked. The game's own work, another browser extension's content script,
 * the browser's own layout or GC, and any of our code that is not instrumented
 * all land in the same bucket, and no browser API separates them — the Long
 * Task API's `TaskAttributionTiming` identifies iframe *containers*, nothing
 * about which script or extension ran.
 *
 * @param {{duration: number, coveredMs?: number}} stall - A stall from `getStalls()`
 * @returns {{coverage: number, verdict: 'ours'|'partly-ours'|'not-ours'}}
 */
export function stallCoverage(stall) {
    const duration = stall?.duration || 0;
    const coverage = duration > 0 ? Math.min((stall.coveredMs || 0) / duration, 1) : 0;
    const verdict =
        coverage >= STALL_OURS_COVERAGE ? 'ours' : coverage <= STALL_NOT_OURS_COVERAGE ? 'not-ours' : 'partly-ours';
    return { coverage, verdict };
}

class PerformanceMonitor {
    constructor() {
        this.measurements = new Map();
        this.snapshots = new Map();
        // Named moments on the startup timeline, in the order they happened
        this.marks = [];
        // Work that a snapshot was made of, broken into its parts
        this.spans = new Map();
        this.bootAt = BOOT_AT;
        this.windowMs = WINDOW_MS;
        this.enabled = false;
        this._onVisibilityChange = () => {
            this._tabVisible = !document.hidden;
        };
        this._tabVisible = true;
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibilityChange);
        }
    }

    /**
     * Record a timing measurement
     * @param {string} name - Metric name (e.g. "dom:MarketFilter", "init:tooltipPrices")
     * @param {number} durationMs - Duration in milliseconds
     */
    record(name, durationMs) {
        if (!this.enabled || !this._tabVisible) return;
        if (!this.measurements.has(name)) {
            this.measurements.set(name, []);
        }
        const entries = this.measurements.get(name);
        // `time` (wall clock) drives the rolling window; `perfTime` (monotonic)
        // is what stall attribution aligns on — see _suspectsFor
        entries.push({ time: Date.now(), perfTime: monotonicNow(), duration: durationMs });
        if (entries.length > MAX_ENTRIES_PER_METRIC) {
            // Prefer dropping what the window no longer covers; fall back to
            // dropping the oldest so the array is bounded even inside a window
            const cutoff = Date.now() - this.windowMs;
            let firstValid = 0;
            while (firstValid < entries.length && entries[firstValid].time < cutoff) {
                firstValid++;
            }
            if (firstValid < entries.length - MAX_ENTRIES_PER_METRIC) {
                firstValid = entries.length - MAX_ENTRIES_PER_METRIC;
            }
            if (firstValid > 0) entries.splice(0, firstValid);
        }
    }

    /**
     * Store a one-time snapshot measurement that persists beyond the rolling window
     *
     * `startedAt` is what makes a startup trace readable: a feature that took six
     * seconds is one fact, and whether it took them at second two or second
     * fourteen is a different one — and only the second says what else was
     * waiting behind it.
     *
     * @param {string} name - Metric name
     * @param {number} durationMs - Duration in milliseconds
     * @param {number} [startedAt] - Milliseconds since boot when it began
     */
    snapshot(name, durationMs, startedAt) {
        this.snapshots.set(name, {
            duration: durationMs,
            time: Date.now(),
            startedAt: startedAt ?? this.sinceBoot() - durationMs,
        });
    }

    /** @returns {number} Milliseconds since the script started */
    sinceBoot() {
        return (typeof performance !== 'undefined' ? performance.now() : 0) - this.bootAt;
    }

    /**
     * Note that something happened, and when.
     *
     * Marks answer the question a list of durations cannot: where did the gaps
     * go. Half of a slow start is usually spent waiting — for IndexedDB, for the
     * game's own data to arrive — and waiting shows up in nobody's duration.
     *
     * @param {string} name - What happened, e.g. `storage:open`
     * @param {Object} [detail] - Anything worth carrying alongside
     */
    mark(name, detail = null) {
        this.marks.push({ name, at: this.sinceBoot(), detail });
    }

    /**
     * Time a part of something already being timed.
     *
     * A feature that takes six seconds is a question, not an answer. Spans are
     * how the answer gets recorded — which call inside it was the six seconds —
     * and they are always on, because the run worth profiling is the one that
     * already happened.
     *
     * @param {string} name - Parent metric, e.g. `init:networth`
     * @param {string} part - What this piece is, e.g. `recalculate`
     * @returns {Function} Call it when the piece is done
     */
    startSpan(name, part) {
        const startedAt = this.sinceBoot();
        return () => {
            const duration = this.sinceBoot() - startedAt;
            if (!this.spans.has(name)) this.spans.set(name, []);
            this.spans.get(name).push({ part, duration, startedAt });
            return duration;
        };
    }

    /**
     * Run a function, recording how long its part took.
     *
     * @param {string} name - Parent metric
     * @param {string} part - What this piece is
     * @param {Function} fn - The work
     * @returns {*} Whatever the work returned
     */
    async span(name, part, fn) {
        const end = this.startSpan(name, part);
        try {
            return await fn();
        } finally {
            end();
        }
    }

    /** @returns {Array<Object>} The parts of one metric, longest first */
    getSpans(name) {
        return [...(this.spans.get(name) || [])].sort((a, b) => b.duration - a.duration);
    }

    /** @returns {Array<Object>} Every mark, in the order they happened */
    getMarks() {
        return [...this.marks].sort((a, b) => a.at - b.at);
    }

    /**
     * Wrap a function with automatic timing
     * @param {string} name - Metric name
     * @param {Function} fn - Function to wrap
     * @returns {Function} Wrapped function
     */
    wrap(name, fn) {
        const monitor = this;
        return function (...args) {
            if (!monitor.enabled || !monitor._tabVisible) return fn.apply(this, args);
            const start = performance.now();
            try {
                const result = fn.apply(this, args);
                if (result && typeof result.then === 'function') {
                    return result.finally(() => monitor.record(name, performance.now() - start));
                }
                monitor.record(name, performance.now() - start);
                return result;
            } catch (error) {
                monitor.record(name, performance.now() - start);
                throw error;
            }
        };
    }

    /**
     * Get stats for a single metric within the rolling window
     * @param {string} name - Metric name
     * @returns {{ calls: number, totalMs: number, avgMs: number, cpuPercent: number } | null}
     */
    getStats(name) {
        const entries = this.measurements.get(name);
        if (!entries || entries.length === 0) return null;

        const cutoff = Date.now() - this.windowMs;
        let calls = 0;
        let totalMs = 0;

        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].time < cutoff) break;
            calls++;
            totalMs += entries[i].duration;
        }

        if (calls === 0) return null;

        return {
            calls,
            totalMs,
            avgMs: totalMs / calls,
            cpuPercent: Math.min((totalMs / this.windowMs) * 100, 100),
        };
    }

    /**
     * Get stats for all metrics, cleaning up stale data
     * @returns {Map<string, { calls: number, totalMs: number, avgMs: number, cpuPercent: number }>}
     */
    getAllStats() {
        this._cleanup();
        const result = new Map();

        for (const [name, entries] of this.measurements) {
            if (entries.length === 0) continue;
            const stats = this.getStats(name);
            if (stats) {
                result.set(name, stats);
            }
        }

        return result;
    }

    /**
     * Remove measurements older than the rolling window
     * @private
     */
    _cleanup() {
        const cutoff = Date.now() - this.windowMs;
        for (const [name, entries] of this.measurements) {
            let firstValid = 0;
            while (firstValid < entries.length && entries[firstValid].time < cutoff) {
                firstValid++;
            }
            if (firstValid > 0) {
                entries.splice(0, firstValid);
            }
            if (entries.length === 0) {
                this.measurements.delete(name);
            }
        }
    }

    /**
     * Get all snapshot measurements
     * @returns {Map<string, { duration: number, time: number }>}
     */
    getSnapshots() {
        return new Map(this.snapshots);
    }

    /**
     * Start recording main-thread stalls, with attribution.
     *
     * A stall — a "longtask", any main-thread block over 50ms — is what a
     * player actually feels: the progress bars hitch. Every hunt so far has
     * started by hand-rolling exactly this observer in the console, then
     * guessing at attribution; the 2026-08-29 networth stutter took hours that
     * way. Recorded here instead, each stall is stamped with the instrumented
     * work (`record()` calls — dom handlers, event fan-outs, anything timed)
     * that finished inside or just after it, which is usually the culprit's
     * name.
     *
     * Runs while the pformance panel has measuring on, like the rolling stats.
     */
    startStallWatch() {
        if (this.stallObserver || typeof PerformanceObserver === 'undefined') return;
        this.stalls = this.stalls || [];
        this.worstStallMs = this.worstStallMs || 0;
        try {
            this.stallObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) this._recordStall(entry);
            });
            this.stallObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            this.stallObserver = null;
        }
    }

    /**
     * Record one observed stall: into the display ring, and into the
     * session-lifetime max.
     *
     * The ring above is capped so the array cannot grow without bound over a
     * long session, and that is right for "recent stalls to show" — but it
     * silently drops the oldest ones, so a single very slow stall early in a
     * long session can fall out of the ring while a report is still asked for
     * "the worst". `worstStallMs` survives the ring: a running max, never
     * trimmed, so the worst line cannot understate the session.
     *
     * @param {PerformanceEntry} entry - The longtask
     */
    _recordStall(entry) {
        const duration = Math.round(entry.duration);
        const attribution = this._attributionFor(entry);
        this.stalls.push({
            time: Date.now(),
            sinceBoot: Math.round(entry.startTime),
            duration,
            suspects: attribution.suspects,
            // How many of this stall's milliseconds a measured span was
            // running for. Computed here, once, while the measurements are
            // still in the window — reading it later is then O(1) per stall.
            coveredMs: attribution.coveredMs,
            recentEvents: this._eventsFor(entry),
        });
        if (duration > this.worstStallMs) this.worstStallMs = duration;
        if (this.stalls.length > 200) this.stalls.shift();
    }

    /** Stop recording stalls; what was recorded stays readable. */
    stopStallWatch() {
        this.stallObserver?.disconnect();
        this.stallObserver = null;
    }

    /**
     * The instrumented work that overlapped a stall.
     *
     * Measurements are stamped with the monotonic clock when they *finish*,
     * and a longtask entry carries `performance.now()` times — the same clock,
     * so no wall-clock alignment is involved. (An earlier version aligned via
     * `Date.now() - performance.now()`, which misattributed whenever NTP
     * stepped `Date.now()` between the work and the read.) Anything timed that
     * ended between the stall starting and shortly after it ended is a suspect
     * — "shortly after" because the observer and the recorder both run a beat
     * behind the work itself. Work that *started* before the window but ended
     * inside it is a suspect too: the end stamp is what lands in the window.
     *
     * @param {PerformanceEntry} entry - The longtask
     * @returns {Array<{name: string, ms: number}>} Largest first, at most five
     */
    _suspectsFor(entry) {
        return this._attributionFor(entry).suspects;
    }

    /**
     * The suspects for a stall, and how much of it they actually account for.
     *
     * Suspect naming is deliberately loose (a span that ended a beat after the
     * stall did is still a suspect — the observer and the recorder both run
     * behind the work). Coverage is deliberately strict: each candidate span is
     * clipped to the stall's own `[startTime, startTime + duration]` window and
     * the clipped intervals are unioned, so two nested spans covering the same
     * 40ms count as 40ms and not 80ms, and coverage can never exceed the
     * stall's length.
     *
     * A span's extent is inferred, not measured: `record()` stamps the
     * monotonic clock when the work *finishes* and carries its duration, so the
     * span is taken to be `[perfTime - duration, perfTime]`. The stamp is taken
     * a few microseconds after the work ends, which is the whole of the error.
     *
     * @param {PerformanceEntry} entry - The longtask
     * @returns {{suspects: Array<{name: string, ms: number}>, coveredMs: number}}
     */
    _attributionFor(entry) {
        const stallStart = entry.startTime;
        const stallEnd = entry.startTime + entry.duration;
        const windowStart = stallStart - 50;
        const windowEnd = stallEnd + 100;

        const suspects = [];
        const covered = [];
        for (const [name, entries] of this.measurements) {
            for (let i = entries.length - 1; i >= 0; i--) {
                const m = entries[i];
                if (m.perfTime < windowStart) break;
                if (m.perfTime <= windowEnd && m.duration >= 5) {
                    suspects.push({ name, ms: Math.round(m.duration) });
                    const from = Math.max(stallStart, m.perfTime - m.duration);
                    const to = Math.min(stallEnd, m.perfTime);
                    if (to > from) covered.push([from, to]);
                }
            }
        }
        return {
            suspects: suspects.sort((a, b) => b.ms - a.ms).slice(0, 5),
            coveredMs: unionLength(covered),
        };
    }

    /**
     * Note that something arrived or happened, without a duration.
     *
     * For work this script can see but cannot time — a game message whose
     * processing happens in the page's own handler. A stall carrying no
     * measured suspects but a `ws:action_completed` moments before it is the
     * game's work, and knowing that ends the hunt instead of widening it.
     *
     * @param {string} name - e.g. `ws:items_updated`
     */
    noteEvent(name) {
        if (!this.enabled) return;
        this.events = this.events || [];
        this.events.push({ name, time: Date.now(), perfTime: monotonicNow() });
        if (this.events.length > 300) this.events.shift();
    }

    /**
     * The noted events shortly before and inside a stall's window.
     * @param {PerformanceEntry} entry - The longtask
     * @returns {string[]} Names, most recent last, at most five
     */
    _eventsFor(entry) {
        if (!this.events?.length) return [];
        const windowStart = entry.startTime - 300;
        const windowEnd = entry.startTime + entry.duration;
        const names = [];
        for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (event.perfTime < windowStart) break;
            if (event.perfTime <= windowEnd) names.unshift(event.name);
        }
        return names.slice(-5);
    }

    /**
     * The recorded stalls, oldest first.
     * @returns {Array<{time: number, sinceBoot: number, duration: number, suspects: Array}>}
     */
    getStalls() {
        return [...(this.stalls || [])];
    }

    /**
     * The stall time nothing of ours was running for.
     *
     * A longtask observer sees *every* main-thread block over 50ms, whoever
     * caused it. Splitting them by whether any measured Toolasha span
     * overlapped gives the one number this script can state about the rest of
     * the page: how much of the hitching was not us. It says nothing about who
     * it *was* — see `stallCoverage` for why that is not knowable here.
     *
     * `unattributedMs` sums the *uncovered* milliseconds of every stall in the
     * window, partly-ours ones included, so a stall we half-caused contributes
     * only its other half. `unattributedStalls` counts only the ones that came
     * out `not-ours`.
     *
     * @param {number} [windowMs] - How far back to look; defaults to the panel's
     *   rolling window. Pass `Infinity` for everything the stall ring still holds
     *   (that ring is capped at 200 entries, so "everything" has a ceiling).
     * @returns {{windowMs: number, stalls: number, totalMs: number, ourStalls: number,
     *   partlyOursStalls: number, unattributedStalls: number, unattributedMs: number}}
     */
    /**
     * `stallCoverage` as an instance method.
     *
     * Callers in other bundles reach this module through the published
     * singleton (`Toolasha.Core.performanceMonitor`), not through an import —
     * a bare named import would be a second, uninitialized copy. Everything
     * they need has to hang off the instance.
     * @param {Object} stall - A stall from `getStalls()`
     * @returns {{coverage: number, verdict: 'ours'|'partly-ours'|'not-ours'}}
     */
    stallCoverage(stall) {
        return stallCoverage(stall);
    }

    getStallAttribution(windowMs = this.windowMs) {
        const cutoff = windowMs === Infinity ? -Infinity : Date.now() - windowMs;
        const totals = {
            windowMs,
            stalls: 0,
            totalMs: 0,
            ourStalls: 0,
            partlyOursStalls: 0,
            unattributedStalls: 0,
            unattributedMs: 0,
        };
        for (const stall of this.stalls || []) {
            if (stall.time < cutoff) continue;
            const { coverage, verdict } = stallCoverage(stall);
            totals.stalls += 1;
            totals.totalMs += stall.duration;
            totals.unattributedMs += stall.duration * (1 - coverage);
            if (verdict === 'ours') totals.ourStalls += 1;
            else if (verdict === 'partly-ours') totals.partlyOursStalls += 1;
            else totals.unattributedStalls += 1;
        }
        totals.unattributedMs = Math.round(totals.unattributedMs);
        return totals;
    }

    /**
     * The longest stall this session has seen, even one the ring above has
     * since dropped. Use this for "worst", not `Math.max` over `getStalls()`.
     * @returns {number} Milliseconds, 0 if none recorded yet
     */
    getWorstStallMs() {
        return this.worstStallMs || 0;
    }

    /**
     * Clear all measurements
     */
    reset() {
        this.measurements.clear();
        this.snapshots.clear();
        this.spans.clear();
        this.stalls = [];
        this.worstStallMs = 0;
        // Marks are the startup trace and cannot be taken again without a
        // reload, so resetting the rolling stats leaves them alone
    }
}

const performanceMonitor = new PerformanceMonitor();

/**
 * Name the code that asked for a timer, from the stack.
 *
 * Both stack formats are parsed: Chrome's (`Error` line, then `at name (url:line:col)`)
 * and Firefox's (`name@url:line:col` from the first line). Frames are skipped
 * by NAME, not by position — a fixed skip count picked the wrong frame on
 * Firefox and collapsed every interval into one call site (seen on the 3.29.0
 * trace). Production keeps function names, so the caller's name is part of the
 * label; line numbers only mean anything within one exact build.
 *
 * @returns {string} e.g. `_startRefreshing@53201`, or `unknown`
 */
const TIMER_TRACE_INTERNALS = new Set(['timerCallSite', 'traced', 'tracedTimeout', 'installIntervalTracing']);

export function timerCallSite(stack = new Error().stack || '') {
    // The wrapper shares the page's window, so the page's own timers land in
    // this net too — and an 80ms game interval wearing one of our labels sent
    // the 2026-08-29 trial hunt chasing `create@34705` through our bundle.
    // The skipped internal frames below carry THIS script's URL in the very
    // stack being parsed; a reported frame from any other file is the page's.
    let ownSource = null;
    for (const raw of stack.split('\n')) {
        const line = raw.trim();
        if (!line || line === 'Error') continue;
        // Chrome: "at name (url:line:col)" or "at url:line:col". Async
        // resumption frames carry an "async " prefix and constructor frames a
        // "new " prefix — both are call shape, not the name, and swallowing
        // them into the name test used to drop the name to "anon".
        // Firefox: "name@url:line:col", an empty name for anonymous frames,
        // and an "async*" prefix on awaiting callers.
        const chrome = /^at (?:async )?(?:new )?(?:(\S+) \()?(.*?):(\d+):\d+\)?$/.exec(line);
        const firefox = /^(?:async\*)?([^@\s]*)@(.*?):(\d+):\d+$/.exec(line);
        const match = chrome || firefox;
        if (!match) continue;
        // "Proxy.traced" / "Object.installIntervalTracing" — the qualifier is
        // the call shape, not the function; strip it before the internals check
        let name = (match[1] || '').split('.').pop() || '';
        if (name === '<anonymous>') name = '';
        if (TIMER_TRACE_INTERNALS.has(name)) {
            ownSource = match[2];
            continue;
        }
        // Containment rather than equality: an eval frame wraps the source
        // URL in "eval at …" / "line 10 > eval" but is still this script
        const foreign = ownSource !== null && !match[2].includes(ownSource);
        return `${name || 'anon'}@${match[3]}${foreign ? ' (page)' : ''}`;
    }
    return 'unknown';
}

/**
 * How much timer churn the page is actually producing, as plain counters.
 *
 * The traced wrappers below used to name every timer at creation — a
 * `new Error().stack` plus a regex parse, about 10µs, on every `setTimeout`
 * and `setInterval` on the page, whether or not anybody was measuring. What
 * nothing could answer was how often that ran: the shared DOM observer
 * re-arms a debounce per *dispatched node* (`dom-observer.js`
 * `debouncedCallback`), so the rate tracks DOM mutation volume, which during
 * combat is high and was never counted.
 *
 * These are counted always, measuring on or off, because a counter you have to
 * turn on cannot tell you what a normal session looks like. Incrementing a
 * property on a plain object allocates nothing and captures no stack, which is
 * the whole point — anything heavier here would be the bug it exists to size.
 *
 * - `interval` / `timeout`: creations that went through the wrappers
 * - `domRearm`: shared-observer debounce re-arms, the multiplier on the above
 * - `named`: creations whose call site was actually captured (measuring on)
 */
export const timerCounters = {
    interval: 0,
    timeout: 0,
    domRearm: 0,
    named: 0,
};

// Also hung off the monitor instance: the pformance panel reaches the monitor
// through the published global (`bundle-bridge.js`), not through this module,
// because it can be opened from a popped-out window with its own module graph.
performanceMonitor.timerCounters = timerCounters;

/**
 * The best name a timer can be given at tick time, when its creation stack is
 * long gone.
 *
 * A timer created while measuring was off was never named, and its call site
 * is unrecoverable — the stack at tick time is the event loop, not the caller.
 * The function's own name survives (production builds keep them), so a timer
 * that starts ticking after the panel opens still reports under something
 * readable rather than vanishing. The `@?` says the line number is the part
 * that is missing, in the same shape `timerCallSite` returns.
 * @param {Function} handler - The timer callback
 * @returns {string} e.g. `_startRefreshing@?`
 */
function lateTimerName(handler) {
    const name = handler.name;
    return `${name && name !== 'anonymous' ? name : 'anon'}@?`;
}

/**
 * Every interval this script creates reports into the rolling stats.
 *
 * The stall ledger can only name work that was measured, and hand-picking
 * which intervals to instrument is how the 2026-08-29 hunt kept finding
 * "nothing instrumented overlapped it". Wrapping the sandbox's setInterval
 * catches them all — the game is untouched, it has its own window — and while
 * measuring is off the wrapper costs one `enabled` check per tick plus one
 * counter increment per creation. It used to also name every creation, which
 * meant a stack capture and a regex parse on every `setTimeout` on the page
 * for every user at boot; see `timerCounters` above for what that cost and
 * what is given up by deferring it.
 */
export function installIntervalTracing(target = globalThis) {
    // Each timer is wrapped on its own merits: if the page (or a library)
    // saved a reference to setTimeout before install and restored it after,
    // the next install must re-net it even though setInterval is still
    // traced. A single early return here silently left setTimeout bare.
    const original = target.setInterval;
    if (typeof original === 'function' && !original.__toolashaTraced) {
        const traced = function traced(handler, delay, ...args) {
            if (typeof handler !== 'function') return original.call(this, handler, delay, ...args);
            timerCounters.interval += 1;
            // Naming costs a stack capture and a regex parse (~10µs) and this
            // runs for every timer the page creates, so it is paid only while
            // the numbers are being collected. A timer created before the panel
            // opened is named from its function at first tick instead.
            let name = null;
            if (performanceMonitor.enabled) {
                timerCounters.named += 1;
                name = `interval:${timerCallSite()}`;
            }
            const wrapped = function (...tickArgs) {
                if (!performanceMonitor.enabled) return handler.apply(this, tickArgs);
                if (name === null) name = `interval:${lateTimerName(handler)}`;
                const startedAt = performance.now();
                try {
                    return handler.apply(this, tickArgs);
                } finally {
                    const duration = performance.now() - startedAt;
                    if (duration >= 1) performanceMonitor.record(name, duration);
                }
            };
            return original.call(this, wrapped, delay, ...args);
        };
        traced.__toolashaTraced = true;
        target.setInterval = traced;
    }

    // Timeouts get the same net. Only ticks over the 1ms floor are recorded,
    // so the zero-delay yields sprinkled through chunked work stay invisible.
    const originalTimeout = target.setTimeout;
    if (typeof originalTimeout === 'function' && !originalTimeout.__toolashaTraced) {
        const tracedTimeout = function tracedTimeout(handler, delay, ...args) {
            if (typeof handler !== 'function') return originalTimeout.call(this, handler, delay, ...args);
            timerCounters.timeout += 1;
            // See the interval wrapper above: no stack capture while measuring
            // is off, which is nearly always and is where the cost lived.
            let name = null;
            if (performanceMonitor.enabled) {
                timerCounters.named += 1;
                name = `timeout:${timerCallSite()}`;
            }
            const wrapped = function (...tickArgs) {
                if (!performanceMonitor.enabled) return handler.apply(this, tickArgs);
                if (name === null) name = `timeout:${lateTimerName(handler)}`;
                const startedAt = performance.now();
                try {
                    return handler.apply(this, tickArgs);
                } finally {
                    const duration = performance.now() - startedAt;
                    if (duration >= 1) performanceMonitor.record(name, duration);
                }
            };
            return originalTimeout.call(this, wrapped, delay, ...args);
        };
        tracedTimeout.__toolashaTraced = true;
        target.setTimeout = tracedTimeout;
    }
}

export default performanceMonitor;
