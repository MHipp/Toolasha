/**
 * Timer Registry Utility
 * Centralized registration for intervals and timeouts.
 */

/**
 * How many timers every live timer registry in this bundle is holding.
 *
 * Additive, O(1), and holds no references — see `getCleanupRegistryCensus` in
 * cleanup-registry.js for why the leak canary needs a count per kind rather
 * than one total.
 */
const census = { intervals: 0, timeouts: 0 };

/**
 * A snapshot of what the live timer registries hold.
 * @returns {{intervals: number, timeouts: number}}
 */
export function getTimerRegistryCensus() {
    return { ...census };
}

/**
 * Create a timer registry for deterministic teardown.
 * @returns {{
 *   registerInterval: (intervalId: number) => void,
 *   registerTimeout: (timeoutId: number) => void,
 *   clearAll: () => void
 * }} Timer registry API
 */
export function createTimerRegistry() {
    const intervals = [];
    const timeouts = [];

    const registerInterval = (intervalId) => {
        if (!intervalId) {
            console.warn('[TimerRegistry] registerInterval called with invalid interval id');
            return;
        }

        intervals.push(intervalId);
        census.intervals += 1;
    };

    const registerTimeout = (timeoutId) => {
        if (!timeoutId) {
            console.warn('[TimerRegistry] registerTimeout called with invalid timeout id');
            return;
        }

        timeouts.push(timeoutId);
        census.timeouts += 1;
    };

    const clearAll = () => {
        intervals.forEach((intervalId) => {
            try {
                clearInterval(intervalId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear interval:', error);
            }
        });
        census.intervals -= intervals.length;
        intervals.length = 0;

        timeouts.forEach((timeoutId) => {
            try {
                clearTimeout(timeoutId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear timeout:', error);
            }
        });
        census.timeouts -= timeouts.length;
        timeouts.length = 0;
    };

    return {
        registerInterval,
        registerTimeout,
        clearAll,
    };
}
