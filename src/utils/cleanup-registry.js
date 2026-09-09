/**
 * Cleanup Registry Utility
 * Centralized registration for listeners, observers, timers, and custom cleanup.
 */

/**
 * How many things every live cleanup registry in this bundle is holding right
 * now, by kind.
 *
 * Additive and O(1): each `register*` increments, `cleanupAll` decrements by
 * what it released. Nothing is retained here that the registries were not
 * already retaining — these are counters, not references — so reading them
 * cannot itself leak, and sampling them costs a property read.
 *
 * The point of counting by kind rather than in total is that "which of our
 * registries is growing" is the only actionable half of a leak report.
 */
const census = {
    listeners: 0,
    observers: 0,
    intervals: 0,
    timeouts: 0,
    cleanups: 0,
};

/**
 * A snapshot of what the live cleanup registries hold.
 * @returns {{listeners: number, observers: number, intervals: number, timeouts: number, cleanups: number}}
 */
export function getCleanupRegistryCensus() {
    return { ...census };
}

/**
 * Create a cleanup registry for deterministic teardown.
 * @returns {{
 *   registerListener: (target: EventTarget, event: string, handler: Function, options?: Object) => void,
 *   registerObserver: (observer: MutationObserver|{ disconnect: Function }) => void,
 *   registerInterval: (intervalId: number) => void,
 *   registerTimeout: (timeoutId: number) => void,
 *   registerCleanup: (cleanupFn: Function) => void,
 *   cleanupAll: () => void
 * }} Cleanup registry API
 */
export function createCleanupRegistry() {
    const listeners = [];
    const observers = [];
    const intervals = [];
    const timeouts = [];
    const customCleanups = [];

    const registerListener = (target, event, handler, options) => {
        if (!target || !event || !handler) {
            console.warn('[CleanupRegistry] registerListener called with invalid arguments');
            return;
        }

        target.addEventListener(event, handler, options);
        listeners.push({ target, event, handler, options });
        census.listeners += 1;
    };

    const registerObserver = (observer) => {
        if (!observer || typeof observer.disconnect !== 'function') {
            console.warn('[CleanupRegistry] registerObserver called with invalid observer');
            return;
        }

        observers.push(observer);
        census.observers += 1;
    };

    const registerInterval = (intervalId) => {
        if (!intervalId) {
            console.warn('[CleanupRegistry] registerInterval called with invalid interval id');
            return;
        }

        intervals.push(intervalId);
        census.intervals += 1;
    };

    const registerTimeout = (timeoutId) => {
        if (!timeoutId) {
            console.warn('[CleanupRegistry] registerTimeout called with invalid timeout id');
            return;
        }

        timeouts.push(timeoutId);
        census.timeouts += 1;
    };

    const registerCleanup = (cleanupFn) => {
        if (typeof cleanupFn !== 'function') {
            console.warn('[CleanupRegistry] registerCleanup called with invalid function');
            return;
        }

        customCleanups.push(cleanupFn);
        census.cleanups += 1;
    };

    const cleanupAll = () => {
        listeners.forEach(({ target, event, handler, options }) => {
            try {
                target.removeEventListener(event, handler, options);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to remove listener:', error);
            }
        });
        census.listeners -= listeners.length;
        listeners.length = 0;

        observers.forEach((observer) => {
            try {
                observer.disconnect();
            } catch (error) {
                console.error('[CleanupRegistry] Failed to disconnect observer:', error);
            }
        });
        census.observers -= observers.length;
        observers.length = 0;

        intervals.forEach((intervalId) => {
            try {
                clearInterval(intervalId);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to clear interval:', error);
            }
        });
        census.intervals -= intervals.length;
        intervals.length = 0;

        timeouts.forEach((timeoutId) => {
            try {
                clearTimeout(timeoutId);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to clear timeout:', error);
            }
        });
        census.timeouts -= timeouts.length;
        timeouts.length = 0;

        customCleanups.forEach((cleanupFn) => {
            try {
                cleanupFn();
            } catch (error) {
                console.error('[CleanupRegistry] Custom cleanup failed:', error);
            }
        });
        census.cleanups -= customCleanups.length;
        customCleanups.length = 0;
    };

    return {
        registerListener,
        registerObserver,
        registerInterval,
        registerTimeout,
        registerCleanup,
        cleanupAll,
    };
}
