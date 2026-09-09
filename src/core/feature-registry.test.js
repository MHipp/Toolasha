/**
 * Tests for Feature Registry
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    isCharacterSwitching: false,
    enabledFeatures: new Set(),
    currentCharacterId: null,
    handlers: {},
    calls: [],
}));

vi.mock('./config.js', () => ({
    default: {
        isFeatureEnabled: (key) => state.enabledFeatures.has(key),
        clearSettingsCache: () => state.calls.push('clearCache'),
        loadSettings: async () => state.calls.push('loadSettings'),
        applyColorSettings: () => state.calls.push('applyColors'),
    },
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getIsCharacterSwitching: () => state.isCharacterSwitching,
        getCurrentCharacterId: () => state.currentCharacterId,
        on: (event, handler) => {
            state.handlers[event] = handler;
        },
    },
}));

vi.mock('../utils/performance-monitor.js', () => ({
    default: {
        mark: vi.fn(),
        sinceBoot: () => 0,
        snapshot: vi.fn(),
    },
}));

const featureRegistry = (await import('./feature-registry.js')).default;

beforeEach(() => {
    state.isCharacterSwitching = false;
    state.enabledFeatures = new Set();
    state.currentCharacterId = null;
    state.handlers = {};
    state.calls = [];
    featureRegistry.replaceFeatures([]);
});

describe('initializeFeatures', () => {
    test('returns [] immediately during a character switch', async () => {
        state.isCharacterSwitching = true;
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn() }]);
        const errors = await featureRegistry.initializeFeatures();
        expect(errors).toEqual([]);
        expect(featureRegistry.getFeature('a').initialize).not.toHaveBeenCalled();
    });

    test('skips features that are not enabled', async () => {
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'disabled', name: 'Disabled', initialize }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).not.toHaveBeenCalled();
    });

    test('initializes enabled features', async () => {
        state.enabledFeatures.add('enabled');
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'enabled', name: 'Enabled', initialize }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    test('uses customCheck instead of config when provided', async () => {
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'custom', name: 'Custom', initialize, customCheck: () => true }]);
        await featureRegistry.initializeFeatures();
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    test('collects an error entry when a feature initializer throws, and continues to the next feature', async () => {
        state.enabledFeatures.add('broken');
        state.enabledFeatures.add('fine');
        const fineInit = vi.fn();
        featureRegistry.replaceFeatures([
            {
                key: 'broken',
                name: 'Broken',
                initialize: () => {
                    throw new Error('init failed');
                },
            },
            { key: 'fine', name: 'Fine', initialize: fineInit },
        ]);

        const errors = await featureRegistry.initializeFeatures();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({ key: 'broken', name: 'Broken', reason: 'Initialization threw: init failed' });
        expect(fineInit).toHaveBeenCalledTimes(1);
    });

    test('awaits a rejecting async initializer and reports it as failed', async () => {
        state.enabledFeatures.add('rejects');
        featureRegistry.replaceFeatures([
            {
                key: 'rejects',
                name: 'Rejects',
                initialize: async () => {
                    throw new Error('async fail');
                },
            },
        ]);

        const errors = await featureRegistry.initializeFeatures();
        expect(errors[0].reason).toBe('Initialization threw: async fail');
    });
});

describe('concurrent features do not serialize', () => {
    /** A feature whose initialize parks on a promise the test resolves by hand. */
    function slowFeature(key, concurrent = true) {
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const startedAt = [];
        return {
            release,
            startedAt,
            entry: {
                key,
                name: key,
                concurrent,
                initialize: async () => {
                    startedAt.push(true);
                    await held;
                },
            },
        };
    }

    test('every enabled feature is started before any of them is waited on', async () => {
        // The point of the change: six features each parked on a storage read
        // used to cost the sum of those reads. Nothing here resolves until all
        // three have started, so this deadlocks if the loop awaits one at a time.
        const a = slowFeature('a');
        const b = slowFeature('b');
        const c = slowFeature('c');
        for (const key of ['a', 'b', 'c']) state.enabledFeatures.add(key);
        featureRegistry.replaceFeatures([a.entry, b.entry, c.entry]);

        const done = featureRegistry.initializeFeatures();
        await Promise.resolve();

        expect([a.startedAt.length, b.startedAt.length, c.startedAt.length]).toEqual([1, 1, 1]);

        a.release();
        b.release();
        c.release();
        await expect(done).resolves.toEqual([]);
    });

    test('a slow feature still holds up the resolve, so callers see a finished startup', async () => {
        const slow = slowFeature('slow');
        state.enabledFeatures.add('slow');
        featureRegistry.replaceFeatures([slow.entry]);

        let settled = false;
        const done = featureRegistry.initializeFeatures().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        slow.release();
        await done;
        expect(settled).toBe(true);
    });

    test('a feature that has not opted in is still awaited before the next one starts', async () => {
        // Serial init is load-bearing where features race for the same endpoint
        // or inject into the same container, so overlapping is opt-in.
        const blocking = slowFeature('blocking', false);
        const behind = slowFeature('behind');
        state.enabledFeatures.add('blocking');
        state.enabledFeatures.add('behind');
        featureRegistry.replaceFeatures([blocking.entry, behind.entry]);

        const done = featureRegistry.initializeFeatures();
        await Promise.resolve();
        expect(behind.startedAt).toHaveLength(0);

        blocking.release();
        await vi.waitFor(() => expect(behind.startedAt).toHaveLength(1));
        behind.release();
        await done;
    });

    test('the synchronous half of each initializer still runs in registry order', async () => {
        // Ordering is what makes this safe: only the waiting overlaps.
        const order = [];
        for (const key of ['first', 'second', 'third']) state.enabledFeatures.add(key);
        featureRegistry.replaceFeatures([
            {
                key: 'first',
                name: 'First',
                concurrent: true,
                initialize: async () => {
                    order.push('first');
                    await Promise.resolve();
                    order.push('first:after');
                },
            },
            { key: 'second', name: 'Second', initialize: () => order.push('second') },
            {
                key: 'third',
                name: 'Third',
                concurrent: true,
                initialize: async () => {
                    order.push('third');
                },
            },
        ]);

        await featureRegistry.initializeFeatures();
        expect(order.slice(0, 3)).toEqual(['first', 'second', 'third']);
        expect(order).toContain('first:after');
    });

    test('a rejection from one feature does not stop the others from finishing', async () => {
        state.enabledFeatures.add('boom');
        state.enabledFeatures.add('ok');
        const okInit = vi.fn(async () => {});
        featureRegistry.replaceFeatures([
            {
                key: 'boom',
                name: 'Boom',
                concurrent: true,
                initialize: async () => {
                    throw new Error('nope');
                },
            },
            { key: 'ok', name: 'Ok', initialize: okInit },
        ]);

        const errors = await featureRegistry.initializeFeatures();
        expect(errors).toEqual([{ key: 'boom', name: 'Boom', reason: 'Initialization threw: nope' }]);
        expect(okInit).toHaveBeenCalledTimes(1);
    });

    test('failures come back in registry order however the promises settle', async () => {
        for (const key of ['early', 'late']) state.enabledFeatures.add(key);
        featureRegistry.replaceFeatures([
            {
                key: 'early',
                name: 'Early',
                concurrent: true,
                initialize: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    throw new Error('slow failure');
                },
            },
            {
                key: 'late',
                name: 'Late',
                concurrent: true,
                initialize: async () => {
                    throw new Error('fast failure');
                },
            },
        ]);

        const errors = await featureRegistry.initializeFeatures();
        expect(errors.map((error) => error.key)).toEqual(['early', 'late']);
    });
});

describe('getFeature / getAllFeatures / getFeaturesByCategory', () => {
    test('getFeature returns null for an unknown key', () => {
        expect(featureRegistry.getFeature('nonexistent')).toBeNull();
    });

    test('getFeature finds a registered feature by key', () => {
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: () => {} }]);
        expect(featureRegistry.getFeature('x').name).toBe('X');
    });

    test('getAllFeatures returns a copy, not the live array', () => {
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: () => {} }]);
        const list = featureRegistry.getAllFeatures();
        list.push({ key: 'y' });
        expect(featureRegistry.getAllFeatures()).toHaveLength(1);
    });

    test('getFeaturesByCategory filters by category', () => {
        featureRegistry.replaceFeatures([
            { key: 'a', name: 'A', category: 'market', initialize: () => {} },
            { key: 'b', name: 'B', category: 'combat', initialize: () => {} },
        ]);
        expect(featureRegistry.getFeaturesByCategory('market')).toHaveLength(1);
        expect(featureRegistry.getFeaturesByCategory('market')[0].key).toBe('a');
    });
});

describe('checkFeatureHealth — a throwing customCheck does not kill the pass', () => {
    test('a registry with one throwing customCheck still health-checks the rest', () => {
        state.enabledFeatures.add('fine');
        featureRegistry.replaceFeatures([
            {
                key: 'broken',
                name: 'Broken',
                initialize: () => {},
                healthCheck: () => false,
                customCheck: () => {
                    throw new Error('customCheck boom');
                },
            },
            { key: 'fine', name: 'Fine', initialize: () => {}, healthCheck: () => false },
        ]);

        // Must not throw — checkFeatureHealth runs in a detached setTimeout in
        // production, so an unguarded throw here becomes an unhandled rejection
        // that silently kills the whole health/retry pass.
        const failed = featureRegistry.checkFeatureHealth();

        expect(failed).toEqual([{ key: 'fine', name: 'Fine', reason: 'Health check returned false' }]);
    });
});

describe('checkFeatureHealth', () => {
    test('skips features with no healthCheck', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {} }]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('skips disabled features even if they define healthCheck', () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {}, healthCheck: () => false }]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('reports a feature whose healthCheck returns false', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {}, healthCheck: () => false }]);
        const failed = featureRegistry.checkFeatureHealth();
        expect(failed).toEqual([{ key: 'a', name: 'A', reason: 'Health check returned false' }]);
    });

    test('does not report a feature whose healthCheck returns true or null', () => {
        state.enabledFeatures.add('a');
        state.enabledFeatures.add('b');
        featureRegistry.replaceFeatures([
            { key: 'a', name: 'A', initialize: () => {}, healthCheck: () => true },
            { key: 'b', name: 'B', initialize: () => {}, healthCheck: () => null },
        ]);
        expect(featureRegistry.checkFeatureHealth()).toEqual([]);
    });

    test('reports a feature whose healthCheck throws', () => {
        state.enabledFeatures.add('a');
        featureRegistry.replaceFeatures([
            {
                key: 'a',
                name: 'A',
                initialize: () => {},
                healthCheck: () => {
                    throw new Error('check failed');
                },
            },
        ]);
        const failed = featureRegistry.checkFeatureHealth();
        expect(failed[0].reason).toBe('Health check error: check failed');
    });
});

describe('retryFailedFeatures', () => {
    test('re-runs initialize and reports still-failing features via a false health check', async () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn(), healthCheck: () => false }]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed).toEqual([{ key: 'a', name: 'A', reason: 'Retried, but its health check still fails' }]);
    });

    test('does not report a feature that recovers on retry', async () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn(), healthCheck: () => true }]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed).toEqual([]);
    });

    test('reports a feature whose retry itself throws', async () => {
        featureRegistry.replaceFeatures([
            {
                key: 'a',
                name: 'A',
                initialize: () => {
                    throw new Error('still broken');
                },
            },
        ]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);
        expect(stillFailed[0].reason).toBe('Retry threw: still broken');
    });

    test('skips a failed feature that is no longer in the registry', async () => {
        featureRegistry.replaceFeatures([]);
        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'gone', name: 'Gone' }]);
        expect(stillFailed).toEqual([]);
    });

    test('does not initialize features into a character switch that started mid-retry', async () => {
        // retryFailedFeatures always runs off a setTimeout (the entrypoint's
        // 1000ms retry delay), which is a window for a switch to start before
        // it fires — the same race initializeFeatures already guards against.
        state.isCharacterSwitching = true;
        const initialize = vi.fn();
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize }]);

        const stillFailed = await featureRegistry.retryFailedFeatures([{ key: 'a', name: 'A' }]);

        expect(initialize).not.toHaveBeenCalled();
        expect(stillFailed).toEqual([]);
    });
});

describe('replaceFeatures', () => {
    test('replaces the registry contents entirely', () => {
        featureRegistry.replaceFeatures([{ key: 'a', name: 'A', initialize: () => {} }]);
        featureRegistry.replaceFeatures([{ key: 'b', name: 'B', initialize: () => {} }]);
        expect(featureRegistry.getAllFeatures().map((f) => f.key)).toEqual(['b']);
    });
});

describe('setupCharacterSwitchHandler — serialized lifecycle', () => {
    /** Register one enabled feature that logs its disable/initialize into state.calls */
    function oneFeature() {
        state.enabledFeatures = new Set(['x']);
        const initialize = vi.fn(() => state.calls.push('init:x'));
        const disable = vi.fn(() => state.calls.push('disable:x'));
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize, disable }]);
        return { initialize, disable };
    }

    test('clears the cache, tears down, reloads settings, then re-inits — in that order', async () => {
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        await vi.advanceTimersByTimeAsync(100);

        // Cleanup finished before reinit started — no overlap
        expect(state.calls).toEqual(['clearCache', 'disable:x', 'loadSettings', 'applyColors', 'init:x']);
        vi.useRealTimers();
    });

    test('a reinit a newer switch has superseded does not re-initialize', async () => {
        // The current character is B, but this character_switched is for A — a
        // stale event a newer switch overtook. Without the target-id check the old
        // handler would init A over B; now it aborts.
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        const { initialize } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'A' });
        await vi.advanceTimersByTimeAsync(100);

        expect(initialize).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    test('a second switch in flight is not dropped', async () => {
        // The old boolean guard returned early on the second character_switched
        // while the first reinit was still running, dropping it. Serialized, both
        // run.
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        const { initialize } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        await vi.advanceTimersByTimeAsync(200);

        expect(initialize).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    test('a rapid burst tears the layer down once and re-initializes once, for the settling character', async () => {
        // A→B→C clicked through faster than the reinit for B can run. Every
        // switch still emits both events — data-manager no longer drops them —
        // so the coalescing has to happen here: one teardown, and one reinit
        // for C, the character still current when the burst settles.
        vi.useFakeTimers();
        state.currentCharacterId = 'C';
        const { initialize, disable } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'C' });
        await vi.advanceTimersByTimeAsync(200);

        expect(disable).toHaveBeenCalledTimes(1);
        expect(initialize).toHaveBeenCalledTimes(1);
        // Settings were reloaded once, for C, before C's features came up
        expect(state.calls).toEqual(['clearCache', 'clearCache', 'disable:x', 'loadSettings', 'applyColors', 'init:x']);
        vi.useRealTimers();
    });

    test('reports a switch-init failure to the recovery callback instead of discarding it', async () => {
        // Before this, initializeFeatures()'s return value was thrown away on
        // the switch path — a feature that threw here was silently dead until
        // a page reload, unlike boot, which gets a health check + retry + report.
        vi.useFakeTimers();
        state.currentCharacterId = 'B';
        state.enabledFeatures = new Set(['broken']);
        featureRegistry.replaceFeatures([
            {
                key: 'broken',
                name: 'Broken',
                initialize: () => {
                    throw new Error('switch init failed');
                },
            },
        ]);

        const onInitFailures = vi.fn();
        featureRegistry.setupCharacterSwitchHandler(onInitFailures);
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        await vi.advanceTimersByTimeAsync(100);

        expect(onInitFailures).toHaveBeenCalledTimes(1);
        expect(onInitFailures.mock.calls[0][0]).toEqual([
            { key: 'broken', name: 'Broken', reason: 'Initialization threw: switch init failed' },
        ]);
        vi.useRealTimers();
    });

    test('the switch after a burst gets a real teardown again', async () => {
        vi.useFakeTimers();
        state.currentCharacterId = 'C';
        const { disable } = oneFeature();

        featureRegistry.setupCharacterSwitchHandler();
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'B' });
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'C' });
        await vi.advanceTimersByTimeAsync(200);

        // Burst over, layer back up for C — a later switch must tear it down
        state.currentCharacterId = 'D';
        state.handlers.character_switching();
        state.handlers.character_switched({ newId: 'D' });
        await vi.advanceTimersByTimeAsync(200);

        expect(disable).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});

describe('the startup-complete signal', () => {
    /**
     * A registry instance nobody else in this file has run yet, so its gate is
     * still closed. The mocks above are module-level and survive resetModules.
     * @returns {Promise<Object>} A fresh feature-registry default export
     */
    const freshRegistry = async () => {
        vi.resetModules();
        const fresh = (await import('./feature-registry.js')).default;
        fresh.replaceFeatures([]);
        return fresh;
    };

    /**
     * Whether a promise has already resolved, without waiting on it.
     * @param {Promise<*>} promise - The promise to probe
     * @returns {Promise<boolean>} True if it settled within a few microtasks
     */
    const hasResolved = async (promise) => {
        const pendingMarker = Symbol('pending');
        return (await Promise.race([promise, Promise.resolve(pendingMarker)])) !== pendingMarker;
    };

    test('is closed until feature startup has run', async () => {
        const fresh = await freshRegistry();

        expect(fresh.isStartupComplete()).toBe(false);
        expect(await hasResolved(fresh.whenStartupComplete())).toBe(false);
    });

    test('opens when startup finishes', async () => {
        const fresh = await freshRegistry();
        fresh.replaceFeatures([{ key: 'a', name: 'A', initialize: vi.fn() }]);
        state.enabledFeatures = new Set(['a']);

        await fresh.initializeFeatures();

        expect(fresh.isStartupComplete()).toBe(true);
        expect(await hasResolved(fresh.whenStartupComplete())).toBe(true);
    });

    test('opens even when startup returns early because a switch is under way', async () => {
        // Nothing is initializing, so there is nothing for a waiter to wait for
        const fresh = await freshRegistry();
        state.isCharacterSwitching = true;

        await fresh.initializeFeatures();

        expect(fresh.isStartupComplete()).toBe(true);
    });

    test('opens even when a feature initializer throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const fresh = await freshRegistry();
        fresh.replaceFeatures([
            {
                key: 'broken',
                name: 'Broken',
                initialize: () => {
                    throw new Error('nope');
                },
            },
        ]);
        state.enabledFeatures = new Set(['broken']);

        await fresh.initializeFeatures();

        expect(fresh.isStartupComplete()).toBe(true);
    });

    test('closes again while a character switch re-initialises, and reopens after', async () => {
        // The once-only latch left every batch after the first completely
        // ungated: `initializeFeatures()` runs again on `character_switched`,
        // and background work handed over during it went straight back to
        // competing with the arriving character's storage reads.
        const fresh = await freshRegistry();
        await fresh.initializeFeatures();
        expect(fresh.isStartupComplete()).toBe(true);

        let release;
        fresh.replaceFeatures([
            {
                key: 'slow',
                name: 'Slow',
                concurrent: true,
                initialize: () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            },
        ]);
        state.enabledFeatures = new Set(['slow']);

        const second = fresh.initializeFeatures();
        const waiter = fresh.whenStartupComplete();
        expect(fresh.isStartupComplete()).toBe(false);
        expect(await hasResolved(waiter)).toBe(false);

        release();
        await second;

        expect(fresh.isStartupComplete()).toBe(true);
        expect(await hasResolved(waiter)).toBe(true);
    });

    test('stays open across a character switch rather than re-arming', async () => {
        // A waiter arriving later must not be parked on the next startup: the
        // re-init after a switch can return early and never complete.
        const fresh = await freshRegistry();
        await fresh.initializeFeatures();
        state.isCharacterSwitching = true;
        await fresh.initializeFeatures();

        expect(fresh.isStartupComplete()).toBe(true);
        expect(await hasResolved(fresh.whenStartupComplete())).toBe(true);
    });
});
