/**
 * Centralized DOM Observer
 * Single MutationObserver that dispatches to registered handlers
 * Replaces 15 separate observers watching document.body
 * Supports optional debouncing to reduce CPU usage during bulk DOM changes
 *
 * Class handlers (`onClass`) share one subtree query. Some 150 features
 * watch for a class substring, and an inserted container used to be walked
 * once per watched class — a chat message, which is a container, cost ~150
 * attribute-substring `querySelectorAll` calls, none of which could match.
 * Now every inserted container is walked once with a combined selector and
 * each match is handed to the handlers whose class it carries.
 */

import performanceMonitor from '../utils/performance-monitor.js';

/** Distinct class attributes remembered before the dispatch cache is dropped. */
const CLASSNAME_CACHE_LIMIT = 2000;

class DOMObserver {
    constructor() {
        this.observer = null;
        this.handlers = [];
        this.readyHandlers = []; // Callbacks fired when the shared observer is actually attached to document.body
        this.isObserving = false;
        this.debounceTimers = new Map(); // Track debounce timers per handler
        this.debouncedLatest = new Map(); // Latest {node, mutation} per handler — O(1) retention
        this.debounceMaxStart = new Map(); // When the oldest un-fired mutation arrived, for maxWait
        this.DEFAULT_DEBOUNCE_DELAY = 50; // 50ms default delay
        this._combinedSelector = undefined; // Built on demand from the class handlers; undefined = stale
        // className string -> the class handlers it satisfies, in registration
        // order. Rebuilt lazily and invalidated with `_combinedSelector`.
        this._handlersByClassName = new Map();
        // How many `dispatch` calls are on the stack. While that is non-zero an
        // unregister marks its handler dead instead of splicing it out — see
        // `_add`. Splicing under the dispatch loop shifted the handler behind it
        // into the vacated index and the loop stepped straight over it, so a
        // one-shot handler (fire once, unregister itself) silently cost its
        // neighbour that insertion. A depth counter rather than a boolean because
        // a handler is free to dispatch again from inside its own callback.
        this._dispatchDepth = 0;
        this._hasDeadHandlers = false;
    }

    /**
     * Start observing DOM changes
     */
    start() {
        if (this.isObserving) return;

        // Wait for document.body to exist (critical for @run-at document-start)
        const startObserver = () => {
            if (!document.body) {
                // Body doesn't exist yet, wait and try again
                setTimeout(startObserver, 10);
                return;
            }

            this.observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;
                        this.dispatch(node, mutation);
                    }
                }
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
            });

            this.isObserving = true;
            this.notifyReadyHandlers();
        };

        startObserver();
    }

    /**
     * Notify handlers that depend on the observer being attached to the current body.
     * Important for @run-at document-start: start() may have returned before document.body existed.
     * @private
     */
    notifyReadyHandlers() {
        for (const handler of [...this.readyHandlers]) {
            try {
                const result = handler.callback();
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => {
                        console.error(`[DOM Observer] Ready handler error (${handler.name}):`, error);
                    });
                }
            } catch (error) {
                console.error(`[DOM Observer] Ready handler error (${handler.name}):`, error);
            }
        }
    }

    /**
     * Register a callback that runs whenever the centralized observer has actually attached to
     * document.body. If it is already attached, the callback runs immediately. This is a bounded
     * lifecycle/catch-up signal, not a polling mechanism.
     * @param {string} name - Handler name for diagnostics
     * @param {Function} callback - Called with no arguments when observing is ready
     * @returns {Function} Unregister function
     */
    onReady(name, callback) {
        const handler = { name, callback };
        this.readyHandlers.push(handler);

        if (this.isObserving) {
            try {
                const result = callback();
                if (result && typeof result.catch === 'function') {
                    result.catch((error) => {
                        console.error(`[DOM Observer] Ready handler error (${name}):`, error);
                    });
                }
            } catch (error) {
                console.error(`[DOM Observer] Ready handler error (${name}):`, error);
            }
        }

        return () => {
            const index = this.readyHandlers.indexOf(handler);
            if (index > -1) this.readyHandlers.splice(index, 1);
        };
    }

    /**
     * Hand an added element to every handler it concerns.
     *
     * Generic handlers see every node. Class handlers see the node when its
     * own class matches, and otherwise its matching descendants — found with
     * one combined query over the subtree rather than one per handler.
     * @param {Element} node - The added element
     * @param {MutationRecord} mutation - The record it arrived in
     */
    dispatch(node, mutation) {
        this._dispatchDepth += 1;
        try {
            this._dispatch(node, mutation);
        } finally {
            this._dispatchDepth -= 1;
            if (this._dispatchDepth === 0 && this._hasDeadHandlers) {
                this.handlers = this.handlers.filter((handler) => !handler.dead);
                this._hasDeadHandlers = false;
            }
        }
    }

    /**
     * The dispatch body, run with removals deferred. See `dispatch`.
     * @param {Element} node - The added element
     * @param {MutationRecord} mutation - The record it arrived in
     * @private
     */
    _dispatch(node, mutation) {
        const className = typeof node.className === 'string' ? node.className : '';

        // The combined subtree query, run at most once per node and only if a
        // handler actually needs it. Descendants, when a container subtree is
        // inserted; leaf nodes are skipped, which is the bulk of React's init
        // burst.
        let matches;
        const descendants = () => {
            if (matches === undefined) {
                const selector = node.childElementCount === 0 ? null : this._selector();
                matches = selector ? node.querySelectorAll(selector) : [];
            }
            return matches;
        };

        // Which descendants concern which handler, computed once per node
        // rather than once per handler.
        //
        // The old shape asked every class handler "does any of your classes
        // appear in this match?" for every match, which is a substring search
        // per (handler, match) pair — some 150 handlers against the couple of
        // dozen elements in an inserted panel, on every insertion, forever.
        // Here each match is resolved once, through a per-className cache of
        // the handlers that className satisfies, and the handler loop below
        // just reads its own list. Document order within a handler's list is
        // preserved because the matches are walked in document order.
        let matchesByHandler;
        const matchesFor = (handler) => {
            if (matchesByHandler === undefined) {
                matchesByHandler = new Map();
                for (const match of descendants()) {
                    const matchClass = typeof match.className === 'string' ? match.className : '';
                    if (!matchClass) continue;
                    for (const matched of this._handlersFor(matchClass)) {
                        const list = matchesByHandler.get(matched);
                        if (list) list.push(match);
                        else matchesByHandler.set(matched, [match]);
                    }
                }
            }
            return matchesByHandler.get(handler);
        };

        // One pass in registration order. Two handlers watching the same
        // insertion — one on the container's own class, one on a class inside
        // it — must fire in the order they registered, because that is the
        // only ordering a feature can rely on; deciding container-matches for
        // everybody before descendant-matches for anybody reordered them by
        // where the class sits rather than by who asked first.
        for (const handler of this.handlers) {
            // Unregistered while this dispatch was running — its removal from the
            // array is deferred to the end of the dispatch, so skip it here.
            if (handler.dead) continue;
            if (!handler.classes) {
                this._run(handler, handler.callback, node, mutation);
                continue;
            }
            if (classMatches(handler.classes, className)) {
                // A class handler satisfied by the node itself does not also
                // get its descendants: one call per node per handler, as before.
                // A debounced one is handed the container and matches for
                // itself when it fires, as it always did; an immediate one gets
                // the match straight away.
                this._run(handler, handler.debounce ? handler.callback : handler.onMatch, node, mutation);
                continue;
            }
            const matched = matchesFor(handler);
            if (!matched) continue;
            if (handler.debounce) {
                // Once per container: the matcher finds every match when it fires
                this._run(handler, handler.callback, node, mutation);
                continue;
            }
            for (const match of matched) {
                this._run(handler, handler.onMatch, match, mutation);
            }
        }
    }

    /**
     * The class handlers a className satisfies, in registration order.
     *
     * Cached per className string, which is what makes the dispatch above
     * cheap: the game reuses a small set of class attributes across thousands
     * of elements, so the substring scan runs once per distinct className
     * instead of once per element per handler.
     *
     * The scan itself is still `classMatches`, deliberately. A watched string
     * is a substring of a className, not necessarily a whole class token nor
     * even a token prefix: `GuildPanel_` matches the hashed
     * `GuildPanel_dataGrid__1x2Yz`, but nothing stops a feature watching a
     * fragment from the middle of one. Indexing by token prefix would be
     * faster still and would quietly stop firing for any such handler.
     * @param {string} className - The element's class attribute
     * @returns {Array<Object>} Matching class handlers, registration order
     * @private
     */
    _handlersFor(className) {
        const cached = this._handlersByClassName.get(className);
        if (cached) return cached;

        const result = [];
        for (const handler of this.handlers) {
            // `dead` is a handler unregistered during a dispatch still in flight;
            // excluding it here keeps the cache correct for after the sweep too
            if (!handler.classes || handler.dead) continue;
            if (classMatches(handler.classes, className)) result.push(handler);
        }

        // A page that generates unique class attributes would otherwise grow
        // this without bound; the cache is an optimisation, so dropping it
        // wholesale is always safe.
        if (this._handlersByClassName.size >= CLASSNAME_CACHE_LIMIT) this._handlersByClassName.clear();
        this._handlersByClassName.set(className, result);
        return result;
    }

    /**
     * Run one handler for one node — debounced, timed or plain
     * @private
     */
    _run(handler, fn, node, mutation) {
        try {
            if (handler.debounce) {
                this.debouncedCallback(handler, node, mutation);
            } else if (performanceMonitor.enabled) {
                const start = performance.now();
                fn(node, mutation);
                performanceMonitor.record(`dom:${handler.name}`, performance.now() - start);
            } else {
                fn(node, mutation);
            }
        } catch (error) {
            console.error(`[DOM Observer] Handler error (${handler.name}):`, error);
        }
    }

    /**
     * The combined descendant selector over every watched class, rebuilt
     * after a registration change. Null when no class handler is registered.
     * @private
     */
    _selector() {
        if (this._combinedSelector !== undefined) return this._combinedSelector;
        const classes = new Set();
        for (const handler of this.handlers) {
            if (handler.dead) continue;
            for (const cls of handler.classes || []) {
                // A class token never carries a quote or backslash; one that did
                // would break the selector, so it is left to the direct match only
                if (cls && !/["\\]/.test(cls)) classes.add(cls);
            }
        }
        this._combinedSelector = classes.size ? [...classes].map((cls) => `[class*="${cls}"]`).join(',') : null;
        return this._combinedSelector;
    }

    /**
     * Debounced callback handler
     * Collects elements and fires callback after delay
     * @private
     */
    debouncedCallback(handler, node, mutation) {
        const delay = handler.debounceDelay || this.DEFAULT_DEBOUNCE_DELAY;
        const maxWait = handler.debounceMaxWait || 0;
        const fn = handler.callback;

        // Only the newest node/mutation is ever handed to the callback, so overwrite
        // rather than append: under churn faster than the debounce delay the timer never
        // fires, and an array would retain every intermediate node and MutationRecord.
        // Keyed by the handler itself — two handlers registered under one name
        // (a feature watching several classes) must not share a record.
        this.debouncedLatest.set(handler, { node, mutation });

        const invoke = () => {
            if (this.debounceTimers.has(handler)) {
                clearTimeout(this.debounceTimers.get(handler));
                this.debounceTimers.delete(handler);
            }
            this.debounceMaxStart.delete(handler);

            const latest = this.debouncedLatest.get(handler);
            this.debouncedLatest.delete(handler);

            // Only the final state matters (e.g. a task list rewritten several times)
            if (!latest) return;
            if (performanceMonitor.enabled) {
                const start = performance.now();
                fn(latest.node, latest.mutation);
                performanceMonitor.record(`dom:${handler.name}`, performance.now() - start);
            } else {
                fn(latest.node, latest.mutation);
            }
        };

        // maxWait bounds the trailing debounce. A burst arriving faster than
        // `delay` keeps resetting the timer, so a handler watching a container
        // that never stops mutating — a live panel with a bar ticking every
        // second — would starve and never run. Once the oldest un-fired mutation
        // is `maxWait` old, the next one fires the callback instead of deferring
        // it again, so first paint still happens under continuous churn. Opt-in:
        // maxWait 0 (the default) is the exact prior trailing-only behaviour.
        if (maxWait > 0) {
            const startedAt = this.debounceMaxStart.get(handler);
            if (startedAt === undefined) {
                this.debounceMaxStart.set(handler, Date.now());
            } else if (Date.now() - startedAt >= maxWait) {
                invoke();
                return;
            }
        }

        // Clear existing timer and set a new one. Counted because this is the
        // multiplier on timer creation across the whole script: a re-arm per
        // *dispatched node*, not per fire, so the rate follows DOM mutation
        // volume — high through combat — and nothing could see it before.
        // A property increment, so counting it costs nothing measurable.
        //
        // Off the monitor instance rather than through the named export: this
        // module and performance-monitor.js are in different production
        // bundles, so a named import here compiles to a property read on
        // `Toolasha.Core.performanceMonitor` anyway (see
        // libraries/cross-bundle-globals.test.js), and the guard keeps a
        // counter that is somehow absent from breaking DOM dispatch.
        const counters = performanceMonitor.timerCounters;
        if (counters) counters.domRearm += 1;
        if (this.debounceTimers.has(handler)) {
            clearTimeout(this.debounceTimers.get(handler));
        }
        this.debounceTimers.set(handler, setTimeout(invoke, delay));
    }

    /**
     * Stop observing DOM changes
     */
    stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        // Clear all debounce timers
        this.debounceTimers.forEach((timer) => clearTimeout(timer));
        this.debounceTimers.clear();
        this.debouncedLatest.clear();
        this.debounceMaxStart.clear();

        this.isObserving = false;
    }

    /**
     * Register a handler for DOM changes
     * @param {string} name - Handler name for debugging
     * @param {Function} callback - Function to call when nodes are added (receives node, mutation)
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing (default: false)
     * @param {number} options.debounceDelay - Debounce delay in ms (default: 50)
     * @param {number} options.debounceMaxWait - Max ms the debounce may defer under continuous churn before firing (default: 0 = unbounded)
     * @returns {Function} Unregister function
     */
    register(name, callback, options = {}) {
        return this._add({
            name,
            callback,
            debounce: options.debounce || false,
            debounceDelay: options.debounceDelay,
            debounceMaxWait: options.debounceMaxWait,
        });
    }

    /**
     * Add a handler and hand back its unregister function
     * @private
     */
    _add(handler) {
        this.handlers.push(handler);
        this._combinedSelector = undefined;
        this._handlersByClassName.clear();

        // Return unregister function
        return () => {
            const index = this.handlers.indexOf(handler);
            if (index === -1 || handler.dead) return;

            if (this._dispatchDepth > 0) {
                // Mid-dispatch: mark rather than splice, so the loop's index does
                // not shift under it. `dispatch` sweeps the dead ones when the
                // outermost call unwinds. Everything else below is unaffected —
                // the handler is dead from this moment either way.
                handler.dead = true;
                this._hasDeadHandlers = true;
            } else {
                this.handlers.splice(index, 1);
            }
            this._combinedSelector = undefined;
            this._handlersByClassName.clear();

            // Clean up any pending debounced callbacks
            if (this.debounceTimers.has(handler)) {
                clearTimeout(this.debounceTimers.get(handler));
                this.debounceTimers.delete(handler);
            }
            this.debouncedLatest.delete(handler);
            this.debounceMaxStart.delete(handler);
        };
    }

    /**
     * Register a handler for specific class names
     * @param {string} name - Handler name for debugging
     * @param {string|string[]} classNames - Class name(s) to watch for (supports partial matches)
     * @param {Function} callback - Function to call when matching elements appear
     * @param {Object} options - Optional configuration
     * @param {boolean} options.debounce - Enable debouncing (default: false for immediate response)
     * @param {number} options.debounceDelay - Debounce delay in ms (default: 50)
     * @returns {Function} Unregister function
     */
    onClass(name, classNames, callback, options = {}) {
        const classArray = Array.isArray(classNames) ? classNames : [classNames];

        // `callback` stays a self-contained matcher so the handler can be driven
        // directly (tests, manual re-scans); the observer itself dispatches
        // through `onMatch` and the shared subtree query instead
        const debounce = options.debounce || false;
        const matcher = (node) => {
            const className = typeof node.className === 'string' ? node.className : '';
            if (classMatches(classArray, className)) {
                callback(node);
                return; // Only call once per node
            }
            if (node.childElementCount === 0) return;
            // A debounced handler is collapsed to one call, which is the whole
            // point of debouncing it: `_dispatch` hands it the inserted
            // container and this resolves the match, so fanning out over every
            // match here undoes the collapse. The inventory panel arrives as
            // one container holding ~200 item tiles, each carrying both
            // `Item_itemContainer` and `Item_item` — 400 matches for
            // `EquipmentLevelDisplay`'s one watched class, and its callback
            // ignores the argument and re-scans the whole document every time.
            // Every debounced class handler in the codebase but one takes no
            // argument at all for exactly that reason.
            if (debounce) {
                for (const targetClass of classArray) {
                    const match = node.querySelector(`[class*="${targetClass}"]`);
                    if (match) {
                        callback(match);
                        return;
                    }
                }
                return;
            }
            for (const targetClass of classArray) {
                node.querySelectorAll(`[class*="${targetClass}"]`).forEach((match) => callback(match));
            }
        };

        return this._add({
            name,
            callback: matcher,
            onMatch: callback,
            classes: classArray,
            debounce,
            debounceDelay: options.debounceDelay,
            debounceMaxWait: options.debounceMaxWait,
        });
    }

    /**
     * Just the counts, with nothing allocated per handler.
     *
     * `getStats()` below builds an object per registered handler, which is
     * right for a one-off inspection and wrong for something sampled every
     * second — the leak canary wants four numbers, not 150 objects a tick.
     * Additive: nothing else changed to add it.
     * @returns {{handlers: number, readyHandlers: number, pendingDebounces: number, classNameCache: number}}
     */
    getCounts() {
        let handlers = this.handlers.length;
        if (this._hasDeadHandlers) {
            handlers = 0;
            for (const handler of this.handlers) if (!handler.dead) handlers += 1;
        }
        return {
            handlers,
            readyHandlers: this.readyHandlers.length,
            pendingDebounces: this.debounceTimers.size,
            classNameCache: this._handlersByClassName.size,
        };
    }

    /**
     * Get stats about registered handlers
     */
    getStats() {
        const live = this._hasDeadHandlers ? this.handlers.filter((h) => !h.dead) : this.handlers;
        return {
            isObserving: this.isObserving,
            handlerCount: live.length,
            readyHandlerCount: this.readyHandlers.length,
            handlers: live.map((h) => ({
                name: h.name,
                debounced: h.debounce || false,
            })),
            pendingCallbacks: this.debounceTimers.size,
        };
    }
}

/**
 * Whether a class string carries any of the watched substrings
 * @param {string[]} classes
 * @param {string} className
 * @returns {boolean}
 */
function classMatches(classes, className) {
    if (!className) return false;
    for (const cls of classes) {
        if (className.includes(cls)) return true;
    }
    return false;
}

const domObserver = new DOMObserver();

export default domObserver;
