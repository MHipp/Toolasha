/**
 * Feature Registry
 * Centralized feature initialization system
 */

import config from './config.js';
import dataManager from './data-manager.js';
import performanceMonitor from '../utils/performance-monitor.js';

/**
 * Feature Registry
 * Populated at runtime by the entrypoint to avoid bundling feature code in core.
 */
const featureRegistry = [];

/**
 * Feature startup, published as something other code can wait for.
 *
 * Background work used to be scheduled on idleness alone, and idleness is not
 * the same question. On Chrome the feature chain's storage awaits *look* idle:
 * a real trace has net worth's idle callback firing 280 ms after
 * `features:start` and running for 2.06 s straight through the middle of a
 * 3.97 s chain, with both sides roughly doubling as they took turns on
 * IndexedDB. The same build on Firefox happened to fire 268 ms after startup
 * had finished and cost 268 ms. Nothing in `src/` read this completion signal
 * before; the only trace of it was the `features:done` mark below.
 *
 * Settled once per session, never re-armed. A caller arriving after startup has
 * finished must find it already open — an "await the next startup" signal would
 * strand every feature that starts late (a character switch re-initialises, and
 * its `initializeFeatures()` can return early without ever completing) on a
 * startup that is not coming.
 */
let startupSettled = false;

/** Called once to open the gate; replaced by the promise's own resolver below. */
let releaseStartup = () => {};

/** Resolves the first time feature startup finishes, or gives up trying. */
const startupComplete = new Promise((resolve) => {
    releaseStartup = resolve;
});

/**
 * Open the gate, once.
 *
 * Called from a `finally`, so the paths that never reach `features:done` — a
 * `initializeFeatures()` that returns early because a character switch is under
 * way, or one that throws before the mark — release waiters rather than leaving
 * them to the caller-side timeout. There is no startup in progress in either
 * case, which is exactly what a waiter wants to know.
 *
 * @returns {void}
 */
function settleStartup() {
    if (startupSettled) return;
    startupSettled = true;
    releaseStartup();
}

/**
 * Has feature startup finished (or been given up on) this session?
 *
 * Lets a caller skip the await entirely rather than yielding a microtask for an
 * answer it can have synchronously.
 *
 * @returns {boolean} True once startup has settled
 */
function isStartupComplete() {
    return startupSettled;
}

/**
 * A promise that resolves when feature startup has finished.
 *
 * Already resolved for anyone who asks after the fact. It never rejects: a
 * feature that throws is caught and recorded by `initializeFeatures`, and the
 * gate is about *when* startup stopped occupying the main thread, not whether
 * it went well.
 *
 * @returns {Promise<void>} Resolves once, then stays resolved
 */
function whenStartupComplete() {
    return startupComplete;
}

/**
 * Initialize all enabled features
 *
 * Returns what failed rather than only logging it. An initializer that throws
 * used to reach the player as a feature that is simply absent, with the reason
 * in a console nobody has open; the caller needs the list to be able to say so.
 *
 * Features are initialized in registry order and each is awaited before the next
 * one starts, *unless* its registry entry sets `concurrent: true`. Such a
 * feature is still started in its turn — its synchronous half runs at exactly
 * the same point it always did — but the waiting is deferred to the end, so its
 * `await` overlaps everything after it instead of delaying it.
 *
 * Why that is worth a flag. Almost none of feature startup is our own CPU: six
 * features between them spent 2.9 s inside `initialize()` and half a millisecond
 * of it running code, the rest parked on an IndexedDB read that nothing else
 * wanted. Awaited one after another those reads add up; overlapped, the group
 * costs what its slowest member costs.
 *
 * Why it is opt-in rather than the default. Serial initialization is load-bearing
 * in places that are not obvious from the registry: tooltip sections and the
 * task panel's buttons appear in the order their observers were registered,
 * which for a post-`await` registration means the order the reads happened to
 * finish in; and a feature that populates a shared singleton after its await
 * (loadout snapshots, the expected-value calculator) is read by later features
 * that assume it is already full. A feature is safe to mark only when what it
 * awaits is its own — its own storage record, its own panel — and nothing
 * downstream is ordered against what it does afterwards. (The market data
 * load is no longer a reason to serialize: the entrypoint starts the one
 * startup fetch itself and `marketAPI.fetch()` folds concurrent callers onto
 * the in-flight request.)
 *
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
 */
async function initializeFeatures() {
    try {
        return await runFeatureInitialization();
    } finally {
        // Whatever happened — an early return, a throw, a clean pass — startup
        // is no longer occupying the main thread, so anything gated on it runs.
        settleStartup();
    }
}

/**
 * The body of `initializeFeatures`, separated only so the gate above can be
 * released in a `finally` without indenting the whole routine.
 *
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
 */
async function runFeatureInitialization() {
    // Block feature initialization during character switch
    if (dataManager.getIsCharacterSwitching()) {
        return [];
    }

    performanceMonitor.mark('features:start', { registered: featureRegistry.length });

    // One slot per started feature, filled in place, so failures come back in
    // registry order however the promises happen to settle.
    const slots = [];
    const pending = [];

    /**
     * Record what a feature's initializer cost, once it has finished.
     *
     * The timing is split on purpose. A single wall-clock span around
     * `await feature.initialize()` blamed a feature for time it merely *parked*
     * in — a sync feature (e.g. autoAllButton) that happens to `await undefined`
     * at the moment a heavy storage read resolves elsewhere would absorb that
     * read's cost and top the "slowest features" list while doing nothing.
     * `own` is the feature's synchronous work up to the point it returns or
     * suspends; `total` still spans the await so a genuinely async initializer
     * is not undercounted. A large gap between them means the cost is time spent
     * waiting, not this feature's own work — and now that the waits overlap,
     * those totals overlap too, so they are a timeline and not a sum.
     *
     * @param {Object} feature - Registry entry
     * @param {number} startedAt - Boot-relative start of its initializer
     * @param {number} ownMs - Synchronous self-time
     * @returns {void}
     */
    const recordTiming = (feature, startedAt, ownMs) => {
        const totalMs = performanceMonitor.sinceBoot() - startedAt;
        performanceMonitor.snapshot(`init:${feature.key}`, totalMs, startedAt);
        if (totalMs - ownMs >= 1) {
            performanceMonitor.snapshot(`init:${feature.key}:own`, ownMs, startedAt);
        }
    };

    for (const feature of featureRegistry) {
        const isEnabled = (() => {
            try {
                return feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);
            } catch (error) {
                console.error(`[Toolasha] Enabled check for ${feature.name} threw:`, error);
                return false;
            }
        })();

        if (!isEnabled) {
            continue;
        }

        const slot = { key: feature.key, name: feature.name, reason: null };
        slots.push(slot);

        const startedAt = performanceMonitor.sinceBoot();
        let started;
        try {
            started = feature.initialize();
        } catch (error) {
            // A synchronous throw never becomes a promise, so it is settled here.
            slot.reason = `Initialization threw: ${error.message}`;
            console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
            continue;
        }
        const ownMs = performanceMonitor.sinceBoot() - startedAt;

        if (!started || typeof started.then !== 'function') {
            recordTiming(feature, startedAt, ownMs);
            continue;
        }

        // Attach the handlers now rather than at the end: an initializer that
        // rejects before anything awaits it is an unhandled rejection otherwise.
        const settled = started.then(
            () => recordTiming(feature, startedAt, ownMs),
            (error) => {
                recordTiming(feature, startedAt, ownMs);
                slot.reason = `Initialization threw: ${error?.message}`;
                console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
            }
        );

        if (feature.concurrent) {
            pending.push(settled);
        } else {
            await settled;
        }
    }

    if (pending.length > 0) {
        await Promise.all(pending);
    }

    const errors = slots.filter((slot) => slot.reason !== null).map(({ key, name, reason }) => ({ key, name, reason }));

    performanceMonitor.mark('features:done', { failed: errors.length });

    // Log errors if any occurred
    if (errors.length > 0) {
        console.error(`[Toolasha] ${errors.length} feature(s) failed to initialize`, errors);
    }

    return errors;
}

/**
 * Get feature by key
 * @param {string} key - Feature key
 * @returns {Object|null} Feature definition or null
 */
function getFeature(key) {
    return featureRegistry.find((f) => f.key === key) || null;
}

/**
 * Get all features
 * @returns {Array} Feature registry
 */
function getAllFeatures() {
    return [...featureRegistry];
}

/**
 * Get features by category
 * @param {string} category - Category name
 * @returns {Array} Features in category
 */
function getFeaturesByCategory(category) {
    return featureRegistry.filter((f) => f.category === category);
}

/**
 * Check health of all initialized features
 * @returns {Array<Object>} Array of failed features with details
 */
function checkFeatureHealth() {
    const failed = [];

    for (const feature of featureRegistry) {
        // Skip if feature has no health check
        if (!feature.healthCheck) continue;

        // Skip if feature is not enabled
        const isEnabled = (() => {
            try {
                return feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);
            } catch (error) {
                console.error(`[Toolasha] Enabled check for ${feature.name} threw:`, error);
                return false;
            }
        })();

        if (!isEnabled) continue;

        try {
            const result = feature.healthCheck();

            // null = can't verify (DOM not ready), false = failed, true = healthy
            if (result === false) {
                failed.push({
                    key: feature.key,
                    name: feature.name,
                    reason: 'Health check returned false',
                });
            }
        } catch (error) {
            failed.push({
                key: feature.key,
                name: feature.name,
                reason: `Health check error: ${error.message}`,
            });
        }
    }

    return failed;
}

/**
 * Setup character switch handler
 * Re-initializes all features when character switches
 */
/**
 * Feature keys whose most recent teardown threw. Read by `getDisableFailures()`.
 * @type {Set<string>}
 */
const disableFailures = new Set();

/**
 * Record — loudly — that a feature's teardown threw.
 *
 * A teardown that throws part-way is the shape of bug that costs a player the
 * feature for the rest of the session: the old log said only "Failed to disable
 * X" among a screenful of other noise, while the actual damage was that the
 * feature had removed its own UI and then thrown before clearing its
 * initialised flag, so the re-initialise on `character_switched` returned early
 * and the feature stayed dead until a page reload. Every feature's teardown now
 * clears that flag in a `finally`, so this should not happen — which is exactly
 * why it deserves a line that names the feature and says what it costs, visible
 * in the first console screenshot anybody sends.
 *
 * @param {Object} feature - Registry entry that failed
 * @param {Error} error - What its teardown threw
 * @returns {void}
 */
function noteDisableFailure(feature, error) {
    disableFailures.add(feature.key);
    console.error(
        `[FeatureRegistry] ${feature.name} (${feature.key}) threw while disabling — if it did not clear its own ` +
            'initialised flag it will not re-initialise cleanly until the page is reloaded:',
        error
    );
}

/**
 * Feature keys whose last teardown threw, newest state only.
 * @returns {Array<string>} Keys, in insertion order
 */
function getDisableFailures() {
    return [...disableFailures];
}

/**
 * Disable every active feature — the cleanup half of a character switch.
 * @returns {Promise<void>}
 */
async function disableAllFeatures() {
    const cleanupPromises = [];
    disableFailures.clear();
    for (const feature of featureRegistry) {
        try {
            const featureInstance = getFeatureInstance(feature.key);
            if (featureInstance && typeof featureInstance.disable === 'function') {
                const result = featureInstance.disable();
                if (result && typeof result.then === 'function') {
                    cleanupPromises.push(
                        result.catch((error) => {
                            noteDisableFailure(feature, error);
                        })
                    );
                }
            }
        } catch (error) {
            noteDisableFailure(feature, error);
        }
    }
    if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
    }
    if (disableFailures.size > 0) {
        console.error(
            `[FeatureRegistry] ${disableFailures.size} feature(s) threw while disabling: ${[...disableFailures].join(', ')}`
        );
    }
}

/**
 * Re-initialize all features when the character switches.
 *
 * The switch is driven off two events — `character_switching` (tear down) and
 * `character_switched` (reload settings, re-enable) — and rapid switches used to
 * corrupt the result two ways: a boolean "reinit scheduled" guard silently
 * *dropped* a later switch (A→B→A ended with B's per-character settings applied
 * under A), and `Promise.race([cleanup, setTimeout(500)])` let a rebuild start
 * before the previous character's teardown finished, so init overlapped cleanup.
 *
 * This serializes the whole lifecycle through one promise chain — cleanup and
 * reinit for any switch, and successive switches, run strictly in order, none
 * dropped. And each reinit verifies it is still for the current character
 * (`currentCharacterId` is updated to the new target before `character_switched`
 * fires) before and after every await, so a reinit a newer switch has
 * superseded aborts instead of clobbering the newer character's state — the
 * "latest character wins" invariant. Ported from upstream Celasha/Toolasha#622.
 *
 * A burst of switches — four characters in one browser, clicked through faster
 * than a second apart — is coalesced here rather than upstream. Every switch
 * still emits both events (they are what reloads per-character settings and
 * lets each feature persist and clear the departing character's state), but the
 * *expensive* half runs once per burst: the first switch tears the feature
 * layer down, the rest find it already down and skip, and only the switch that
 * is still current when the burst settles re-initialises. Data-manager used to
 * do this by dropping the events outright, which meant the second character ran
 * on the first character's settings until some later, slower switch fixed it.
 *
 * @param {Function} [onInitFailures] - Called with the array `initializeFeatures()`
 *   returns after each switch's re-init. Boot has always followed its own
 *   `initializeFeatures()` with a health check, one retry pass, and a
 *   user-facing report of what is still broken; before this parameter existed
 *   the switch path discarded that return value entirely, so a feature that
 *   threw during a switch stayed dead — silently — until the page reloaded.
 *   The entrypoint passes the same recovery routine boot uses so both paths
 *   get the same treatment.
 */
function setupCharacterSwitchHandler(onInitFailures) {
    // One chain that every switch step is appended to, so no two ever overlap.
    let lifecycleChain = Promise.resolve();
    const enqueue = (step) => {
        lifecycleChain = lifecycleChain.then(step).catch((error) => {
            console.error('[FeatureRegistry] Character-switch lifecycle step failed:', error);
        });
        return lifecycleChain;
    };

    // Whether this chain has torn the feature layer down and not yet brought it
    // back up. Starts false: at boot the layer is up (entrypoint initialises it
    // before this handler can ever fire), so the first switch of the session
    // does a real teardown.
    let tornDown = false;

    // Cleanup phase
    dataManager.on('character_switching', () => {
        // Clear the config cache synchronously, before the chain awaits anything,
        // so nothing reads the previous character's settings in the gap.
        if (config && typeof config.clearSettingsCache === 'function') {
            config.clearSettingsCache();
        }
        // Returned, not merely enqueued.
        //
        // `character_switching` is data-manager's one awaited emit, and it is
        // awaited for a reason: it fires *before* `currentCharacterId` moves so
        // that a feature's disable() can persist the departing character's
        // state under the departing character's key, and data-manager must not
        // move the pointer until that has happened. Handing back only
        // `undefined` made the await a formality — the teardown was queued and
        // the pointer moved on the next microtask, so every disable() that
        // crossed an await before writing (a read-modify-write through
        // `readScoped`/`writeScoped` is the normal shape) evaluated
        // `characterKey()` against the *arriving* character and filed the
        // departing character's state under their key, overwriting whatever
        // they had.
        //
        // `enqueue` returns the chain as of this step, so this promise settles
        // when this teardown has run and not when later steps have — the emit
        // waits for the teardown it asked for, and no longer.
        return enqueue(async () => {
            // Mid-burst the layer is already down and every feature's disable()
            // is a no-op — a hundred of them per switch is the storm the old
            // rapid-switch guard was defending against. Skip, and let the
            // settling switch bring the layer back up for whoever is current.
            if (tornDown) return;
            tornDown = true;
            await disableAllFeatures();
        });
    });

    // Re-initialization phase
    dataManager.on('character_switched', (data) => {
        const targetId = data?.newId ?? null;
        // Still the character this reinit is for? A newer switch updates
        // currentCharacterId synchronously, so a mismatch means this one is stale.
        const isStale = () => targetId !== null && dataManager.getCurrentCharacterId() !== targetId;

        enqueue(async () => {
            if (isStale()) return;
            // A newer switch is already under way. `currentCharacterId` has not
            // moved yet — it moves after the awaited `character_switching` — so
            // `isStale()` cannot see this one, and doing the work anyway would
            // be worse than wasted now that the newer switch's teardown waits
            // behind this step: `initializeFeatures()` refuses during a switch
            // regardless, so all this could contribute is a settings reload and
            // a settle delay holding up the character the player is actually
            // looking at. Leave `tornDown` set, so the switch that settles is
            // the one that brings the layer back up.
            if (dataManager.getIsCharacterSwitching()) return;

            // Load settings BEFORE any feature initialization so every feature
            // sees the new character's values (loadSettings reads the current id).
            await config.loadSettings();
            config.applyColorSettings();
            if (isStale()) return;

            // Small delay to let game state settle, then re-init with fresh settings
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (isStale()) return;

            const initFailures = await initializeFeatures();
            // The layer is up again for the character that is current now, so
            // the next switch owes a real teardown.
            tornDown = false;

            if (typeof onInitFailures === 'function') {
                onInitFailures(initFailures);
            }
        });
    });
}

/**
 * Get feature instance from imported module
 * @param {string} key - Feature key
 * @returns {Object|null} Feature instance or null
 * @private
 */
function getFeatureInstance(key) {
    const feature = getFeature(key);
    if (!feature) {
        return null;
    }

    return feature.module || feature;
}

/**
 * Retry initialization for specific features
 *
 * Reports back what is still broken afterwards, so a caller can tell the
 * difference between a feature that recovered on the second attempt — the
 * common case, where the game panel it anchors to had not been drawn yet — and
 * one that is genuinely not coming up. Only the second is worth interrupting
 * anybody about.
 *
 * @param {Array<Object>} failedFeatures - Array of failed feature objects
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Those still failing
 */
async function retryFailedFeatures(failedFeatures) {
    const stillFailed = [];

    for (const failed of failedFeatures) {
        // A switch starting inside this retry's delay (retryFailedFeatures is
        // always called from a setTimeout, so there is a window for one) must
        // not initialize features into a character that is already on its way
        // out — the same guard initializeFeatures applies.
        if (dataManager.getIsCharacterSwitching()) break;

        const feature = getFeature(failed.key);
        if (!feature) continue;

        try {
            await feature.initialize();

            // Verify the retry actually worked by running health check
            if (feature.healthCheck) {
                const healthResult = feature.healthCheck();
                if (healthResult === false) {
                    console.warn(`[Toolasha] ${feature.name} retry completed but health check still fails`);
                    stillFailed.push({
                        key: feature.key,
                        name: feature.name,
                        reason: 'Retried, but its health check still fails',
                    });
                }
            }
        } catch (error) {
            console.error(`[Toolasha] ${feature.name} retry failed:`, error);
            stillFailed.push({
                key: feature.key,
                name: feature.name,
                reason: `Retry threw: ${error.message}`,
            });
        }
    }

    return stillFailed;
}

/**
 * Replace the feature registry (for library split)
 * @param {Array} newFeatures - New feature registry array
 */
function replaceFeatures(newFeatures) {
    featureRegistry.length = 0; // Clear existing array
    featureRegistry.push(...newFeatures); // Add new features
}

export default {
    initializeFeatures,
    isStartupComplete,
    whenStartupComplete,
    disableAllFeatures,
    getDisableFailures,
    setupCharacterSwitchHandler,
    checkFeatureHealth,
    retryFailedFeatures,
    getFeature,
    getAllFeatures,
    replaceFeatures,
    getFeaturesByCategory,
};
