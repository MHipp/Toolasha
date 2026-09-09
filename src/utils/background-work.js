/**
 * Work that should not hold up the rest of the start.
 *
 * Features are initialised one after another and each is awaited, so anything a
 * feature does inside `initialize()` is time every feature behind it spends
 * waiting. That is right for wiring up listeners, which is fast, and wrong for
 * reading a year of history out of IndexedDB or repricing an entire inventory —
 * work whose result nobody is looking at yet, and which cost the page thirteen
 * seconds between two features alone.
 *
 * The rule this expresses: **register synchronously, compute later**. A feature
 * hands its heavy part to `runInBackground`, gets a promise back, and awaits that
 * promise anywhere its own correctness depends on the work being done. Everything
 * else gets to start.
 *
 * "Later" means after feature startup has finished *and* the browser is idle —
 * see `whenFeatureStartupIsDone`. Idleness alone is not a proxy for startup
 * being over, and on Chrome it demonstrably is not.
 */

import featureRegistry from '../core/feature-registry.js';
import performanceMonitor from './performance-monitor.js';

/**
 * How long to wait for feature startup before running anyway.
 *
 * The gate below has to survive a startup that never signals: a feature registry
 * that is never run at all (unit tests, any bundle that carries this module
 * without Core's registry), or an `initializeFeatures()` that is prevented from
 * finishing. There is no way to tell "not finished yet" from "never will be", so
 * the wait is bounded rather than conditional.
 *
 * 10 s because it must never fire on a healthy start and must still be short
 * enough to be a hiccup rather than a hang. The two real startup traces this was
 * built from finished their feature chains at 4.7 s (Firefox) and 4.0 s
 * (Chrome), so this is roughly double the worst measured startup; and the cost
 * of firing early is only that background work goes back to competing with the
 * chain, which is exactly the behaviour that existed before the gate.
 */
const STARTUP_GATE_TIMEOUT_MS = 10_000;

/**
 * Wait for feature startup to be out of the way.
 *
 * Returns synchronously-fast once startup has settled, so work handed over
 * afterwards — a character switch, a panel opened an hour in — is not made to
 * wait for a signal that has already fired and will not fire again.
 *
 * Degrades to "do not gate" when the registry is not reachable at all. This
 * module is shared through `Toolasha.Utils.backgroundWork` while the registry
 * arrives as `Toolasha.Core.featureRegistry`; Core loads first, so the binding
 * is there in every real build, and a missing one means there is no feature
 * startup to wait for.
 *
 * @returns {Promise<void>}
 */
async function whenFeatureStartupIsDone() {
    if (typeof featureRegistry?.isStartupComplete !== 'function') return;
    if (featureRegistry.isStartupComplete()) return;

    let timer;
    const giveUp = new Promise((resolve) => {
        timer = setTimeout(() => {
            console.warn(
                `[Toolasha] Feature startup has not finished after ${STARTUP_GATE_TIMEOUT_MS} ms; ` +
                    'running background work anyway.'
            );
            resolve();
        }, STARTUP_GATE_TIMEOUT_MS);
    });

    try {
        await Promise.race([featureRegistry.whenStartupComplete(), giveUp]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wait for a quiet moment, or the next tick if the browser will not say.
 *
 * @returns {Promise<void>}
 */
function whenIdle() {
    return new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), { timeout: 2000 });
        } else {
            setTimeout(resolve, 0);
        }
    });
}

/**
 * Run something after the page has drawn, and time it.
 *
 * Timed under `bg:` so a startup trace can tell work that delayed the page from
 * work that merely happened afterwards — the difference between a slow start and
 * a busy one, which a flat list of durations cannot show.
 *
 * Failures are logged and swallowed: this is work nobody is waiting on, and a
 * rejected promise nobody awaits is an unhandled rejection in the console for
 * every user who has that feature on.
 *
 * @param {string} name - What it is, e.g. `networth`
 * @param {Function} work - The heavy part
 * @returns {Promise<*>} Resolves when the work is done, never rejects
 */
export async function runInBackground(name, work) {
    // Startup first, then idleness. Idleness alone was the bug: a browser that
    // counts the feature chain's storage awaits as idle time will start this in
    // the middle of the chain, and the two then contend for the same one-key-per-
    // transaction IndexedDB reads and roughly double each other.
    await whenFeatureStartupIsDone();
    await whenIdle();
    const startedAt = performanceMonitor.sinceBoot();
    try {
        return await work();
    } catch (error) {
        console.error(`[Toolasha] Background work "${name}" failed:`, error);
        return null;
    } finally {
        performanceMonitor.snapshot(`bg:${name}`, performanceMonitor.sinceBoot() - startedAt, startedAt);
    }
}

/**
 * Hand the main thread back to the event loop.
 *
 * A long synchronous loop — pricing an entire enhanced inventory, say — freezes
 * the page for as long as it runs. Awaiting this between slices turns one long
 * blocking macrotask into several short ones, so the browser gets to paint,
 * handle input, and let other awaited work (feature init behind it) proceed.
 *
 * A macrotask (`setTimeout`) rather than a microtask on purpose: a microtask
 * runs before the browser paints or handles input, which is the freeze this is
 * meant to break, not defer.
 *
 * @returns {Promise<void>}
 */
export function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
