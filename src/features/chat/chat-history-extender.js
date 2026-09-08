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

/**
 * A stable-ish identity for one chat tab's message container.
 *
 * The game gives these containers nothing to be named by, so the tab strip is
 * used instead: containers and tab buttons are rendered in the same order, so
 * the button at the container's index names it. Whispers get their own tabs and
 * so their own keys, which is the point — every tab is persisted, private ones
 * included.
 *
 * The index fallback is what makes this safe when the tab strip has not
 * rendered yet or has been restyled: history keyed by position is history in
 * the wrong tab at worst, never a throw.
 *
 * @param {Element} containerEl - A `ChatHistory_chatHistory` element
 * @returns {string|null} Tab key, or null when the container is not in the document
 */
export function chatTabKey(containerEl) {
    try {
        const containers = [...document.querySelectorAll('[class*="ChatHistory_chatHistory"]')];
        const index = containers.indexOf(containerEl);
        if (index < 0) return null;

        const buttons = [...document.querySelectorAll('[class*="Chat_tabsComponentContainer"] button[role="tab"]')];
        const button = buttons[index];
        const label =
            button?.getAttribute('data-mention-channel') ||
            button?.textContent?.trim().replace(/\d+$/, '').trim() ||
            '';
        return label ? `tab:${label}` : `idx:${index}`;
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

        mutations.forEach((mut) => {
            mut.addedNodes.forEach((node) => {
                if (node.nodeType === 1 && node.className?.includes('ChatMessage_chatMessage')) {
                    this.hydrateMessage(node);
                }
            });

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
                    if (html) chatHistoryPersistence.record(this.tabKey, html);

                    this._trim(maxHistory);
                }
            });

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
