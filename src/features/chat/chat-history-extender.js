/**
 * Chat History Extender
 * Preserves chat messages that the game evicts from the live buffer,
 * keeping them visible in a history section above the live messages.
 * Based on the original script by SilkyPanda.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import chatHistoryPersistence, {
    handleRestoredClick,
    parseStoredMessage,
    rewireRestoredMessage,
    serializeMessage,
    TAB_KEY_PREFIX,
} from './chat-history-persistence.js';

const STYLE_ID = 'mwi-chat-history-extender-css';
const CSS = `
    .mwi-history-buffer {
        display: flex;
        flex-direction: column;
        width: 100%;
        background-color: rgba(0, 0, 0, 0.45);
        border-bottom: 2px dashed #555;
        margin-bottom: 5px;
    }
    .mwi-history-buffer > div { opacity: 0.9; position: relative; }
    .mwi-history-buffer > div:hover { opacity: 1; background-color: rgba(255, 255, 255, 0.05); }
    .mwi-interactive { cursor: pointer; }
    .mwi-history-restore-anchor { display: none; }
`;

/** The tab strip. Scoped: the game has other tab widgets, and none of them is chat. */
const TAB_STRIP_SELECTOR = '[class*="Chat_tabsComponentContainer"]';

/** A chat message container — one of these, for the open tab only. */
const CHAT_CONTAINER_SELECTOR = '[class*="ChatHistory_chatHistory"]';

/**
 * The label part of a tab's key, namespaced by where it was read from.
 *
 * The two sources disagree about what a label looks like: channel tabs carry
 * `data-mention-channel` (`/chat_channel_types/global`), while the rest —
 * language rooms, Help, whispers — have none and are named by their button
 * text (`English`, `Help`, a player name). Namespacing rather than mixing them
 * into one flat label keeps a whisper from a player called `Help` out of the
 * Help tab's record; the channel form additionally cannot collide with a text
 * label, because a player name cannot contain `/`.
 *
 * The trailing-digit trim takes off the unread badge the button renders after
 * its name, which would otherwise make the key change every time a message
 * arrives.
 *
 * @param {Element} button - A tab button
 * @returns {string} The namespaced label, or '' when the button names nothing
 */
function tabLabel(button) {
    const channel = button?.getAttribute?.('data-mention-channel');
    if (channel) return `ch:${channel}`;
    const text = button?.textContent?.trim().replace(/\d+$/, '').trim();
    return text ? `name:${text}` : '';
}

/**
 * The identity of one chat tab's message container: its name, or nothing.
 *
 * The game renders a container for the **open tab only** — one container, eight
 * buttons — so the tab is named by the button carrying `aria-selected="true"`,
 * never by the container's position. Naming it by position is what this
 * function used to do, and with a single container `indexOf` was always 0, so
 * every tab's history went under the first button's name and was restored into
 * whichever tab happened to be open. That is the failure the docstring here
 * used to warn about and then commit.
 *
 * Two ways the container is tied to that button, strongest first:
 *
 * 1. `aria-controls` on the button naming the panel the container sits in. This
 *    is a real link and holds however many containers the game decides to
 *    render, so it is preferred wherever the markup provides it.
 * 2. Otherwise, the fact that exactly one container exists. This is only sound
 *    while that is true, so it is *checked* rather than assumed: two containers
 *    means the claim has stopped holding and nothing is keyed.
 *
 * There is no mid-switch window to worry about: the button's `aria-selected`
 * and the container's contents are written by the same React commit, and the
 * DOM mutations of one commit are applied before any MutationObserver callback
 * — which is every path into here — is delivered. No caller can observe half a
 * switch.
 *
 * Whispers get their own tabs and so their own keys, which is the point — every
 * tab is persisted, private ones included.
 *
 * There is deliberately no positional fallback, and nothing is guessed. An
 * unnamed tab is not keyed at all: its history is skipped until the strip names
 * it. A tab whose history is missing is recoverable; a private conversation in
 * a public tab's scrollback is not.
 *
 * @param {Element} containerEl - A `ChatHistory_chatHistory` element
 * @returns {string|null} `tab2:<label>`, or null when the tab cannot be named
 */
export function chatTabKey(containerEl) {
    try {
        if (!containerEl || !containerEl.isConnected) return null;

        const strip = document.querySelector(TAB_STRIP_SELECTOR);
        if (!strip) return null;

        const selected = [...strip.querySelectorAll('button[role="tab"]')].filter(
            (button) => button.getAttribute('aria-selected') === 'true'
        );
        // Zero means the strip has not settled; more than one means the markup
        // no longer means what this reads it as. Neither is a tab identity.
        if (selected.length !== 1) return null;

        const label = tabLabel(selected[0]);
        if (!label) return null;

        const panelId = selected[0].getAttribute('aria-controls');
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel) return panel.contains(containerEl) ? `${TAB_KEY_PREFIX}${label}` : null;

        const containers = document.querySelectorAll(CHAT_CONTAINER_SELECTOR);
        if (containers.length !== 1 || containers[0] !== containerEl) return null;
        return `${TAB_KEY_PREFIX}${label}`;
    } catch {
        return null;
    }
}

/**
 * Read React props for a batch of DOM nodes via the fiber tree.
 *
 * The `__reactProps$…`/`__reactFiber$…` expando keys these nodes used to carry
 * were removed in the February 2026 update; `_reactRootContainer` on `#root`
 * was not, so props have to be read by walking down from there instead (same
 * pattern as `src/utils/react-click.js` and `src/features/tasks/task-card-quest.js`).
 * One tree walk serves every node in `domNodes` rather than one walk per node.
 * @param {Iterable<Element>} domNodes
 * @returns {Map<Element, object>} Only nodes whose fiber was found and had props
 */
function getReactPropsForNodes(domNodes) {
    const result = new Map();
    if (typeof document === 'undefined') return result;

    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return result;

    const targets = new Set(domNodes);
    const stack = [rootFiber];
    let guard = 0;
    while (stack.length && targets.size && guard++ < 500000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (targets.has(fiber.stateNode)) {
            if (fiber.memoizedProps) result.set(fiber.stateNode, fiber.memoizedProps);
            targets.delete(fiber.stateNode);
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    return result;
}

/**
 * Manages the history buffer for a single chat tab container.
 */
class ChatTabHandler {
    /**
     * @param {Element} containerEl - The ChatHistory_chatHistory element
     * @param {Map} interactionCache - Shared cache of UID → React handlers
     * @param {() => number} getMaxHistory - Returns current max history setting
     * @param {string|null} tabKey - Persistence key for this tab, from {@link chatTabKey}
     */
    constructor(containerEl, interactionCache, getMaxHistory, tabKey = null) {
        this.container = containerEl;
        this.interactionCache = interactionCache;
        this.getMaxHistory = getMaxHistory;
        this.tabKey = tabKey;
        /** Whether a restore has already been fired for this tab; see {@link _resolveTabKey}. */
        this.restoreStarted = false;

        this.bufferEl = document.createElement('div');
        this.bufferEl.className = 'mwi-history-buffer';
        this.container.insertBefore(this.bufferEl, this.container.firstChild);

        /**
         * Where restored messages end and this session's evictions begin.
         *
         * Inserted synchronously; the restore that fills above it is async, so
         * without an anchor a message evicted in the first second would sit
         * above history older than itself. Hidden, and skipped by every count
         * and trim below, which look for message nodes rather than children.
         */
        this.restoreAnchor = document.createElement('div');
        this.restoreAnchor.className = 'mwi-history-restore-anchor';
        this.bufferEl.appendChild(this.restoreAnchor);

        const events = ['click', 'contextmenu', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout'];
        events.forEach((evt) => this.bufferEl.addEventListener(evt, this._handleEmulatedEvent.bind(this), true));
        // Restored links carry no captured React callback, so they are served by
        // this script's own navigation instead — see chat-history-persistence.js.
        this.bufferEl.addEventListener('click', handleRestoredClick, true);

        this.observer = new MutationObserver(this._onMutation.bind(this));
        this.observer.observe(this.container, { childList: true });
    }

    /**
     * The message nodes in the buffer, in order. Not `children`: the restore
     * anchor is a child too and must never be counted or trimmed.
     * @returns {Array<Element>} Buffered message elements, oldest first
     */
    _messageNodes() {
        return [...this.bufferEl.children].filter((el) => el.className?.includes?.('ChatMessage_chatMessage'));
    }

    /**
     * Empty the buffer of rendered messages, keeping the restore anchor.
     *
     * Used when the container stops being the tab it was: what it is showing
     * belongs to the tab that was open before, and leaving it on screen is the
     * whole reported symptom — a private conversation in a public tab's
     * scrollback. Nothing on disk is touched; both tabs' records are intact and
     * the new tab's is restored straight after.
     */
    _clearBuffer() {
        for (const node of this._messageNodes()) {
            node.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (node.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(node.getAttribute('data-mwi-uid'));
            }
            node.remove();
        }
    }

    /**
     * This tab's persistence key, re-read rather than remembered.
     *
     * Deliberately not cached for the life of the handler. The game renders one
     * container for the open tab, and there is no guarantee it builds a fresh
     * one per tab — React is free to reuse the node and swap its contents, in
     * which case a remembered key would file a whisper under whichever tab was
     * open when the container first appeared. The key is a property of what the
     * container is showing *now*, so it is asked for now: one scoped query per
     * mutation batch, not per message.
     *
     * Three transitions matter:
     *
     * - Unnamed → named (the tab strip rendered late): the buffer holds this
     *   tab's own evictions, so it is kept, and the restore that could not run
     *   while the tab was unnamed is fired here, once.
     * - Named → a *different* name (the container is now another tab): the
     *   buffer is emptied before anything else, and the new tab's history is
     *   restored into it.
     * - Named → unnamed (the strip stopped naming things): recording stops,
     *   because a guess is what this module exists to avoid. The buffer is left
     *   alone; the container has not changed tab, we have merely stopped being
     *   able to say which tab it is.
     *
     * @returns {string|null} `tab2:<label>`, or null while the tab is unnamed
     */
    _resolveTabKey() {
        const key = chatTabKey(this.container);
        if (key === this.tabKey) return key;

        const previous = this.tabKey;
        this.tabKey = key;

        if (previous && key && key !== previous) {
            this._clearBuffer();
            this.restoreStarted = false;
        }

        if (key && !this.restoreStarted) {
            this.restore(key).catch((error) => {
                console.error('[ChatHistoryExtender] Late restore failed:', error);
            });
        }
        return key;
    }

    /**
     * Put this tab's stored history back above the anchor.
     *
     * Off the critical path on purpose: the caller does not await it, so chat
     * is usable the moment the buffer exists and history arrives when the read
     * does. Any single message that will not parse or re-wire is skipped; the
     * rest still render.
     *
     * @param {string} tabKey - From {@link chatTabKey}
     * @returns {Promise<number>} How many messages were restored
     */
    async restore(tabKey) {
        if (!tabKey) return 0;
        this.restoreStarted = true;

        let stored;
        try {
            stored = (await chatHistoryPersistence.load())[tabKey];
        } catch (error) {
            console.error('[ChatHistoryExtender] Could not load stored history:', error);
            return 0;
        }
        if (!Array.isArray(stored) || !stored.length) return 0;
        // The container may have been torn down while the read was in flight
        if (!this.bufferEl.isConnected) return 0;

        let restored = 0;
        for (const html of stored) {
            try {
                const el = parseStoredMessage(html);
                if (!el) continue;
                rewireRestoredMessage(el);
                el.dataset.mwiRestored = '1';
                this.bufferEl.insertBefore(el, this.restoreAnchor);
                restored += 1;
            } catch (error) {
                console.error('[ChatHistoryExtender] Skipped an unrestorable message:', error);
            }
        }

        this._trim(this.getMaxHistory());
        return restored;
    }

    /**
     * Trim the buffer to `maxHistory` messages, oldest first.
     * @param {number} maxHistory
     */
    _trim(maxHistory) {
        const nodes = this._messageNodes();
        while (nodes.length > maxHistory) {
            const oldNode = nodes.shift();
            oldNode.querySelectorAll('[data-mwi-uid]').forEach((u) => {
                this.interactionCache.delete(u.getAttribute('data-mwi-uid'));
            });
            if (oldNode.hasAttribute('data-mwi-uid')) {
                this.interactionCache.delete(oldNode.getAttribute('data-mwi-uid'));
            }
            oldNode.remove();
        }
    }

    /**
     * Hydrate a live message node by caching its React event handlers before the game removes it.
     * @param {Element} messageNode
     */
    hydrateMessage(messageNode) {
        if (messageNode.dataset.mwiHydrated) return;

        const eventsOfInterest = [
            'onClick',
            'onContextMenu',
            'onDoubleClick',
            'onMouseEnter',
            'onMouseLeave',
            'onMouseOver',
            'onMouseOut',
            'onMouseDown',
            'onMouseUp',
        ];

        const elements = [messageNode, ...messageNode.querySelectorAll('*')];
        const propsByNode = getReactPropsForNodes(elements);

        elements.forEach((el) => {
            const props = propsByNode.get(el);
            if (!props) return;

            const handlers = {};
            let hasHandler = false;

            eventsOfInterest.forEach((evtName) => {
                if (typeof props[evtName] === 'function') {
                    handlers[evtName] = props[evtName];
                    hasHandler = true;
                }
            });

            if (typeof props.goToMarketplaceHandler === 'function') {
                handlers.onClick = (e) => props.goToMarketplaceHandler(e, true);
                hasHandler = true;
            }

            if (hasHandler) {
                const uid = Date.now().toString(36) + Math.random().toString(36).substring(2);
                el.setAttribute('data-mwi-uid', uid);
                el.classList.add('mwi-interactive');
                this.interactionCache.set(uid, handlers);
            }
        });

        messageNode.dataset.mwiHydrated = 'true';
    }

    /**
     * Re-emit a React synthetic event for history buffer interactions.
     * @param {Event} e
     */
    _handleEmulatedEvent(e) {
        const targetEl = e.target.closest('[data-mwi-uid]');
        if (!targetEl) return;

        const uid = targetEl.getAttribute('data-mwi-uid');
        const handlers = this.interactionCache.get(uid);
        if (!handlers) return;

        const eventMap = {
            click: 'onClick',
            contextmenu: 'onContextMenu',
            dblclick: 'onDoubleClick',
            mousedown: 'onMouseDown',
            mouseup: 'onMouseUp',
            mouseover: 'onMouseOver',
            mouseout: 'onMouseOut',
        };

        let reactEventName = eventMap[e.type];

        if (e.type === 'mouseover') {
            reactEventName = handlers.onMouseEnter ? 'onMouseEnter' : 'onMouseOver';
        }
        if (e.type === 'mouseout') {
            reactEventName = handlers.onMouseLeave ? 'onMouseLeave' : 'onMouseOut';
        }

        const handler = handlers[reactEventName];
        if (typeof handler !== 'function') return;

        const fakeEvent = {
            ...e,
            nativeEvent: e,
            target: e.target,
            currentTarget: targetEl,
            preventDefault: () => e.preventDefault(),
            stopPropagation: () => e.stopPropagation(),
            persist: () => {},
            isDefaultPrevented: () => e.defaultPrevented,
            isPropagationStopped: () => e.cancelBubble,
            type: e.type,
        };

        if (e.clientX !== undefined) {
            fakeEvent.clientX = e.clientX;
            fakeEvent.clientY = e.clientY;
        }

        try {
            handler(fakeEvent);
        } catch (err) {
            console.error('[ChatHistoryExtender] Handler failed:', err);
        }
    }

    /**
     * Handle mutations on the chat container.
     * @param {MutationRecord[]} mutations
     */
    _onMutation(mutations) {
        const isAtBottom = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 50;
        const maxHistory = this.getMaxHistory();
        // Once per batch, before anything is buffered or recorded: a tab switch
        // arrives as a batch of mutations, and a message must never be filed
        // under, or rendered beside, the tab that was open a moment ago.
        const previousKey = this.tabKey;
        const tabKey = this._resolveTabKey();
        // A switch tears the outgoing tab's messages out of the pane, and those
        // removals look exactly like evictions. They are not: the buffer has
        // just been emptied for the incoming tab, and treating them as
        // evictions would clone the outgoing tab's lines — whispers among them
        // — straight back onto the incoming tab's scrollback and into its
        // record under the incoming tab's key.
        const switched = Boolean(previousKey) && Boolean(tabKey) && tabKey !== previousKey;

        mutations.forEach((mut) => {
            mut.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.className?.includes('ChatMessage_chatMessage')) {
                    this.hydrateMessage(node);
                }
            });

            // The buffer element itself still has to be kept in place below,
            // so this skips the evictions rather than the whole batch.
            if (!switched) {
                mut.removedNodes.forEach((node) => {
                    if (
                        node.nodeType === 1 &&
                        node.className?.includes('ChatMessage_chatMessage') &&
                        node !== this.bufferEl
                    ) {
                        const clone = node.cloneNode(true);
                        this.bufferEl.appendChild(clone);

                        // Serialized from the clone, before the trim below can take
                        // it away again: the record is capped separately from the
                        // buffer, so a message can leave the screen and stay stored.
                        const html = serializeMessage(clone);
                        if (html && tabKey) chatHistoryPersistence.record(tabKey, html);

                        this._trim(maxHistory);
                    }
                });
            }

            if (this.container.firstChild !== this.bufferEl) {
                this.container.prepend(this.bufferEl);
            }
        });

        if (isAtBottom) {
            this.container.scrollTop = this.container.scrollHeight;
        }
    }

    /**
     * Disconnect the observer and remove the buffer element.
     */
    destroy() {
        this.observer.disconnect();
        this.bufferEl.querySelectorAll('[data-mwi-uid]').forEach((el) => {
            this.interactionCache.delete(el.getAttribute('data-mwi-uid'));
        });
        this.bufferEl.remove();
    }
}

class ChatHistoryExtender {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.interactionCache = new Map();
        this.tabHandlers = new WeakMap();
        this.activeHandlers = new Set();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('chatHistoryExtender')) return;

        this.isInitialized = true;
        addStyles(CSS, STYLE_ID);

        const getMaxHistory = () => {
            const raw = parseInt(config.getSettingValue('chatHistoryExtender_maxHistory'));
            return isFinite(raw) && raw > 0 ? raw : 150;
        };

        chatHistoryPersistence.enable(getMaxHistory);

        const attachHandler = (containerEl) => {
            if (this.tabHandlers.has(containerEl)) return;
            const handler = new ChatTabHandler(
                containerEl,
                this.interactionCache,
                getMaxHistory,
                chatTabKey(containerEl)
            );
            this.tabHandlers.set(containerEl, handler);
            this.activeHandlers.add(handler);
            containerEl.querySelectorAll('[class*="ChatMessage_chatMessage"]').forEach((msg) => {
                handler.hydrateMessage(msg);
            });
            // Deliberately not awaited: the read is IndexedDB and chat must be
            // usable before it lands. A failure inside is logged, not thrown.
            handler.restore(handler.tabKey).catch((error) => {
                console.error('[ChatHistoryExtender] Restore failed:', error);
            });
        };

        // Watch for new chat tab containers
        const unregister = domObserver.onClass('ChatHistoryExtender', 'ChatHistory_chatHistory', attachHandler);
        this.unregisterHandlers.push(unregister);

        // @run-at document-start: containers rendered before the shared observer attaches to
        // document.body are invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(
            domObserver.onReady('ChatHistoryExtenderCatchUp', () => {
                document.querySelectorAll('[class*="ChatHistory_chatHistory"]').forEach(attachHandler);
            })
        );

        // Periodic cache cleanup to prevent unbounded memory growth
        const cleanupInterval = setInterval(() => {
            // Destroy handlers whose container left the DOM (also drops their cached uids)
            for (const handler of this.activeHandlers) {
                if (!document.contains(handler.container)) {
                    handler.destroy();
                    this.activeHandlers.delete(handler);
                    this.tabHandlers.delete(handler.container);
                }
            }
            // Evict only entries no longer referenced by any live/buffered node — a global
            // clear() would permanently break handlers still wired to rendered clones
            if (this.interactionCache.size > 8000) {
                const liveUids = new Set();
                document.querySelectorAll('[data-mwi-uid]').forEach((el) => {
                    liveUids.add(el.getAttribute('data-mwi-uid'));
                });
                for (const uid of this.interactionCache.keys()) {
                    if (!liveUids.has(uid)) {
                        this.interactionCache.delete(uid);
                    }
                }
            }
        }, 600000);
        this.timerRegistry.registerInterval(cleanupInterval);
    }

    disable() {
        try {
            // Land what the session recorded before the state goes; a disable
            // is not a wipe, and the record on disk is left where it is.
            chatHistoryPersistence.flush()?.catch?.(() => {});
            chatHistoryPersistence.reset();
            for (const handler of this.activeHandlers) {
                handler.destroy();
            }
            this.activeHandlers.clear();
            this.tabHandlers = new WeakMap();
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.interactionCache.clear();
            removeStyles(STYLE_ID);
            this.isInitialized = false;
        } catch (error) {
            console.error('[Chat History Extender] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const chatHistoryExtender = new ChatHistoryExtender();
export default chatHistoryExtender;
