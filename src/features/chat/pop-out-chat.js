/**
 * Pop-Out Chat Window
 * Opens game chat in a separate browser window with multi-channel split-pane support.
 * Game tab relays WebSocket messages via BroadcastChannel; pop-out is a pure UI shell.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import domObserver from '../../core/dom-observer.js';
import { formatKMB, isTwelveHourClock } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { initVisualViewportTracking } from '../../utils/visual-viewport.js';
import { chatBlockList } from './chat-block-list.js';
import { ANNOUNCE_RE, KICK_RE, PARTY_RE, UPGRADE_RE, VALID_NAME_RE, getProfileLinkNames } from './chat-profile-link.js';

const RELAY_CHANNEL = 'mwi-chat-relay';
const SEND_CHANNEL = 'mwi-chat-send';
const MAX_BUFFER = 500;
const PING_INTERVAL_MS = 10_000;
// A blob: URL's document inherits the origin of the page that created it, so localStorage
// here is the same store the game page itself uses — good enough for a UI convenience like
// remembered window geometry, without needing a BroadcastChannel round trip to save it.
const POPOUT_GEOMETRY_KEY = 'mwi-chat-popout-geometry';
const DEFAULT_POPOUT_WIDTH = 960;
const DEFAULT_POPOUT_HEIGHT = 720;
const MIN_POPOUT_WIDTH = 320;
const MIN_POPOUT_HEIGHT = 240;
// Size (not position) is still bounded to a multiple of the primary screen's available area.
// We can't know a second monitor's actual size from Firefox (no Window Management API), so
// this is a generous sanity cap against corrupted/absurd saved values, not a real screen fit.
const MAX_SIZE_SCREEN_MULTIPLIER = 2;

const CHANNELS = [
    { hrid: '/chat_channel_types/general', name: 'General' },
    { hrid: '/chat_channel_types/trade', name: 'Trade' },
    { hrid: '/chat_channel_types/global', name: 'Global' },
    { hrid: '/chat_channel_types/local', name: 'Local' },
    { hrid: '/chat_channel_types/help', name: 'Help' },
    { hrid: '/chat_channel_types/party', name: 'Party' },
    { hrid: '/chat_channel_types/guild', name: 'Guild' },
    { hrid: '/chat_channel_types/whisper', name: 'Whisper' },
    { hrid: '/chat_channel_types/beginner', name: 'Beginner' },
    { hrid: '/chat_channel_types/recruit', name: 'Recruit' },
    { hrid: '/chat_channel_types/ironcow', name: 'Ironcow' },
    { hrid: '/chat_channel_types/russian', name: 'Русский' },
    { hrid: '/chat_channel_types/chinese', name: '中文' },
    { hrid: '/chat_channel_types/korean', name: '한국어' },
    { hrid: '/chat_channel_types/japanese', name: '日本語' },
    { hrid: '/chat_channel_types/portuguese', name: 'Português' },
    { hrid: '/chat_channel_types/spanish', name: 'Español' },
    { hrid: '/chat_channel_types/french', name: 'Français' },
    { hrid: '/chat_channel_types/german', name: 'Deutsch' },
];

const CHANNEL_NAME_MAP = Object.fromEntries(CHANNELS.map((c) => [c.hrid, c.name]));

const SKILL_HRID_TO_NAME = {
    '/skills/total_level': 'Total Level',
    '/skills/milking': 'Milking',
    '/skills/foraging': 'Foraging',
    '/skills/woodcutting': 'Woodcutting',
    '/skills/cheesesmithing': 'Cheesesmithing',
    '/skills/crafting': 'Crafting',
    '/skills/tailoring': 'Tailoring',
    '/skills/cooking': 'Cooking',
    '/skills/brewing': 'Brewing',
    '/skills/alchemy': 'Alchemy',
    '/skills/enhancing': 'Enhancing',
    '/skills/stamina': 'Stamina',
    '/skills/intelligence': 'Intelligence',
    '/skills/attack': 'Attack',
    '/skills/melee': 'Melee',
    '/skills/defense': 'Defense',
    '/skills/ranged': 'Ranged',
    '/skills/magic': 'Magic',
};

/**
 * Resolve a system message with systemMetadata into a human-readable string.
 * @param {string} messageKey - e.g. "systemChatMessage.characterLeveledUp"
 * @param {Object} meta - Parsed systemMetadata
 * @returns {string|null} Rendered string, or null if unrecognized
 */
function resolveSystemMessage(messageKey, meta) {
    if (messageKey === 'systemChatMessage.characterLeveledUp') {
        const skillName = SKILL_HRID_TO_NAME[meta.skillHrid] || meta.skillHrid.split('/').pop().replace(/_/g, ' ');
        return `🎉 ${meta.name} reached ${skillName} ${meta.level}!`;
    }
    return null;
}

/**
 * Resolve a single linksMetadata link entry to a display string.
 * @param {Object} link
 * @returns {string}
 */
function resolveLink(link) {
    if (link.linkType === '/chat_link_types/market_listing') {
        const itemDetails = dataManager.getItemDetails(link.itemHrid);
        const itemName = itemDetails?.name || link.itemHrid.split('/').pop().replace(/_/g, ' ');
        const enhancement = link.itemEnhancementLevel > 0 ? ` +${link.itemEnhancementLevel}` : '';
        const count = link.itemCount > 1 ? ` ×${link.itemCount}` : '';
        const price = formatKMB(link.price);
        const side = link.isSell ? 'Sell' : 'Buy';
        return `[${itemName}${enhancement}${count} @ ${price} ${side}]`;
    }
    if (link.linkType === '/chat_link_types/item') {
        const itemDetails = dataManager.getItemDetails(link.itemHrid);
        const itemName = itemDetails?.name || link.itemHrid.split('/').pop().replace(/_/g, ' ');
        const enhancement = link.itemEnhancementLevel > 0 ? ` +${link.itemEnhancementLevel}` : '';
        const count = link.itemCount > 1 ? ` ×${link.itemCount}` : '';
        return `[${itemName}${enhancement}${count}]`;
    }
    if (link.linkType === '/chat_link_types/ability') {
        const abilityDetails = dataManager.getInitClientData()?.abilityDetailMap?.[link.abilityHrid];
        const abilityName = abilityDetails?.name || link.abilityHrid.split('/').pop().replace(/_/g, ' ');
        return `[${abilityName} Lv.${link.abilityLevel}]`;
    }
    if (link.linkType === '/chat_link_types/skill') {
        const skillName = SKILL_HRID_TO_NAME[link.skillHrid] || link.skillHrid.split('/').pop().replace(/_/g, ' ');
        return `[${skillName} Lv.${link.skillLevel}]`;
    }
    if (link.linkType === '/chat_link_types/party') {
        const actionDetails = dataManager.getActionDetails(link.partyActionHrid);
        const zoneName = actionDetails?.name || link.partyActionHrid.split('/').pop().replace(/_/g, ' ');
        const tier = ` T${link.partyDifficultyTier ?? 0}`;
        return `[Party: ${zoneName}${tier}]`;
    }
    if (link.linkType === '/chat_link_types/collection') {
        const itemDetails = dataManager.getItemDetails(link.itemHrid);
        const itemName = itemDetails?.name || link.itemHrid.split('/').pop().replace(/_/g, ' ');
        return `[Collection: ${itemName} ×${formatKMB(link.itemCount)}]`;
    }
    if (link.linkType === '/chat_link_types/bestiary') {
        const monsterDetails = dataManager.getInitClientData()?.combatMonsterDetailMap?.[link.monsterHrid];
        const monsterName = monsterDetails?.name || link.monsterHrid.split('/').pop().replace(/_/g, ' ');
        return `[Bestiary: ${monsterName} ×${link.monsterCount}]`;
    }
    // Fallback: humanize the HRID
    return `[${link.linkType.split('/').pop().replace(/_/g, ' ')}]`;
}

/**
 * Resolve a raw WebSocket message into a serializable relay object.
 * @param {Object} message - Raw message from chat_message_received
 * @returns {Object}
 */
function resolveMessage(message) {
    let renderedLinks = [];
    if (message.linksMetadata) {
        try {
            const links = JSON.parse(message.linksMetadata);
            renderedLinks = links.map(resolveLink);
        } catch {
            // ignore malformed linksMetadata
        }
    }

    let resolvedText = message.m || '';
    if (message.isSystemMessage && message.systemMetadata) {
        try {
            const meta = JSON.parse(message.systemMetadata);
            const rendered = resolveSystemMessage(message.m || '', meta);
            if (rendered !== null) {
                resolvedText = rendered;
            }
        } catch {
            // ignore malformed systemMetadata
        }
    }

    return {
        type: 'chat_message',
        channel: message.chan || '',
        sName: message.sName || '',
        m: resolvedText,
        t: message.t || '',
        isSystem: !!message.isSystemMessage,
        renderedLinks,
    };
}

/**
 * Build the `window.open` features string for the pop-out window, restoring a previously
 * saved size/position when one is available.
 *
 * Position is trusted verbatim, including negative values or values beyond the primary
 * screen's availWidth/availHeight — that's exactly what a window parked on a second monitor
 * looks like from the primary screen's coordinate origin. Firefox has no Window Management
 * API to enumerate monitors, so there is no way to tell a legitimate second-monitor position
 * apart from a bogus one; clamping to the primary screen (the old behavior) meant a pop-out
 * placed on a second monitor always reopened on the primary one instead.
 *
 * Size is still bounded (to a generous multiple of the primary screen, since we can't know a
 * second monitor's real size either) so a corrupted saved value can't produce an absurd window.
 * @param {{width:number, height:number, left:number, top:number}|null|undefined} geometry
 * @param {{availWidth:number, availHeight:number}|null|undefined} screenBounds
 * @returns {string}
 */
function buildPopoutWindowFeatures(geometry, screenBounds) {
    const availWidth = screenBounds?.availWidth > 0 ? screenBounds.availWidth : DEFAULT_POPOUT_WIDTH;
    const availHeight = screenBounds?.availHeight > 0 ? screenBounds.availHeight : DEFAULT_POPOUT_HEIGHT;

    let width = DEFAULT_POPOUT_WIDTH;
    let height = DEFAULT_POPOUT_HEIGHT;
    if (Number.isFinite(geometry?.width) && Number.isFinite(geometry?.height)) {
        width = geometry.width;
        height = geometry.height;
    }
    width = Math.min(Math.max(width, MIN_POPOUT_WIDTH), availWidth * MAX_SIZE_SCREEN_MULTIPLIER);
    height = Math.min(Math.max(height, MIN_POPOUT_HEIGHT), availHeight * MAX_SIZE_SCREEN_MULTIPLIER);

    const parts = [`width=${Math.round(width)}`, `height=${Math.round(height)}`, 'resizable=yes'];

    if (Number.isFinite(geometry?.left) && Number.isFinite(geometry?.top)) {
        parts.push(`left=${Math.round(geometry.left)}`, `top=${Math.round(geometry.top)}`);
    }

    return parts.join(',');
}

class PopOutChat {
    constructor() {
        this.relayChannel = null;
        this.sendChannel = null;
        this.popoutWindow = null;
        // Teardown for the visual-viewport tracking running inside the pop-out
        // document; null whenever no pop-out is open.
        this.popoutViewportCleanup = null;
        // Identifies *this tab's* currently open pop-out window so a second
        // game tab (a second character logged in in another browser tab, common
        // in this genre) doesn't answer this tab's handshake or execute sends
        // meant for it — BroadcastChannel is origin-wide, not per-tab.
        this.popoutInstanceId = null;
        this.messageBuffer = new Map(); // hrid → Array<resolved message>
        this.discoveredChannels = new Map(); // hrid → {hrid, name} for channels seen via messages but not in DOM
        // Count of live messages dropped by chatBlockList since this tab's game session
        // started, shown in the pop-out topbar so a block is visibly doing something.
        this.blockedCount = 0;
        this.wsHandler = null;
        this.initialized = false;
        this.timerRegistry = createTimerRegistry();
        this.unregisterObserver = null;
        this.unregisterReady = null;
        this.popoutBtn = null;
        this.resetGeometryBtn = null;
    }

    /**
     * Initialize the pop-out chat feature.
     */
    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('chat_popOut')) return;

        this.initialized = true;

        // Set up BroadcastChannels
        this.relayChannel = new BroadcastChannel(RELAY_CHANNEL);
        this.sendChannel = new BroadcastChannel(SEND_CHANNEL);

        // Listen for messages from pop-out
        this.sendChannel.onmessage = ({ data }) => this._onSendChannelMessage(data);

        // Listen for incoming chat messages from WebSocket
        this.wsHandler = (data) => this._onChatMessage(data);
        webSocketHook.on('chat_message_received', this.wsHandler);

        // Start keepalive ping
        const pingTimer = setInterval(() => {
            this._relayPost({ type: 'ping' });
        }, PING_INTERVAL_MS);
        this.timerRegistry.registerInterval(pingTimer);

        // Inject pop-out button next to the ▼ collapse button in the chat tabs row
        this.unregisterObserver = domObserver.onClass('PopOutChat', 'Chat_tabsComponentContainer', (container) => {
            const parent = container.parentElement;
            if (parent) this._injectButton(parent);
        });

        // @run-at document-start: a chat tabs row rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('PopOutChatCatchUp', () => {
            const existing = document.querySelector('[class*="Chat_tabsComponentContainer"]');
            if (existing?.parentElement) this._injectButton(existing.parentElement);
        });
    }

    /**
     * Inject the pop-out button next to the overflow arrow in the chat tabs row.
     * @param {HTMLElement} container - parent of Chat_tabsComponentContainer
     */
    _injectButton(container) {
        if (container.querySelector('[data-mwi-popout-chat]')) return;

        const btn = document.createElement('button');
        btn.setAttribute('data-mwi-popout-chat', 'true');
        btn.textContent = '⧉';
        btn.title = 'Pop out chat';
        btn.style.cssText = `
            padding: 2px 6px;
            font-size: 13px;
            background: none;
            color: #8b949e;
            border: none;
            cursor: pointer;
            user-select: none;
            flex-shrink: 0;
            line-height: 1;
            opacity: 0.75;
        `;
        btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
        btn.addEventListener('mouseleave', () => (btn.style.opacity = '0.75'));
        btn.addEventListener('click', () => this._openPopout());

        // Small recovery affordance sitting right next to the pop-out button: clears the
        // saved window geometry so the next pop-out opens at the default centered spot
        // instead of wherever was last saved. Exists for the case where that saved spot was
        // on a second monitor that's since been unplugged/disconnected — Firefox has no
        // Window Management API to detect or auto-correct that, so a manual reset is it.
        const resetBtn = document.createElement('button');
        resetBtn.setAttribute('data-mwi-popout-chat-reset', 'true');
        resetBtn.textContent = '⟲';
        resetBtn.title = 'Reset pop-out chat window position (use if it opens off-screen)';
        resetBtn.style.cssText = `
            padding: 2px 6px;
            font-size: 13px;
            background: none;
            color: #8b949e;
            border: none;
            cursor: pointer;
            user-select: none;
            flex-shrink: 0;
            line-height: 1;
            opacity: 0.75;
        `;
        resetBtn.addEventListener('mouseenter', () => (resetBtn.style.opacity = '1'));
        resetBtn.addEventListener('mouseleave', () => (resetBtn.style.opacity = '0.75'));
        resetBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._resetSavedGeometry();
        });

        // Insert into the same parent as the expandCollapseButton, after it
        const collapseBtn = container.querySelector('[class*="TabsComponent_expandCollapseButton"]');
        if (collapseBtn?.parentElement) {
            collapseBtn.parentElement.insertBefore(btn, collapseBtn.nextSibling);
            collapseBtn.parentElement.insertBefore(resetBtn, btn.nextSibling);
        } else {
            // Fallback: append to the tabsComponentContainer
            const tabsContainer = container.querySelector('[class*="Chat_tabsComponentContainer"]') || container;
            tabsContainer.appendChild(btn);
            tabsContainer.appendChild(resetBtn);
        }

        this.popoutBtn = btn;
        this.resetGeometryBtn = resetBtn;
    }

    /**
     * Handle an incoming chat_message_received WebSocket event.
     * @param {Object} data
     */
    _onChatMessage(data) {
        const message = data?.message;
        if (!message || !message.chan) return;

        const resolved = resolveMessage(message);

        // Drop messages from blocked players
        if (!resolved.isSystem && chatBlockList.isBlocked(resolved.sName)) {
            this.blockedCount++;
            this._relayPost({ type: 'blocked_count', count: this.blockedCount });
            return;
        }

        // Track channels seen via messages that aren't in the hardcoded list
        if (!CHANNELS.some((c) => c.hrid === resolved.channel) && !this.discoveredChannels.has(resolved.channel)) {
            const name = resolved.channel
                .split('/')
                .pop()
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase());
            this.discoveredChannels.set(resolved.channel, { hrid: resolved.channel, name });
            // Notify pop-out of the updated channel list
            this._relayPost({ type: 'channels_updated', channels: this._getLiveChannels() });
        }

        // Buffer the message
        if (!this.messageBuffer.has(resolved.channel)) {
            this.messageBuffer.set(resolved.channel, []);
        }
        const buf = this.messageBuffer.get(resolved.channel);
        buf.push(resolved);
        if (buf.length > MAX_BUFFER) buf.shift();

        // Relay to pop-out if open
        this._relayPost(resolved);
    }

    /**
     * Post a message to this tab's pop-out via the relay channel, tagged with
     * this tab's pop-out instance id.
     * @param {Object} msg
     */
    _relayPost(msg) {
        if (!this.relayChannel) return;
        this.relayChannel.postMessage({ ...msg, instanceId: this.popoutInstanceId });
    }

    /**
     * Handle messages received from the pop-out window.
     * @param {Object} data
     */
    _onSendChannelMessage(data) {
        if (!data?.type) return;
        // BroadcastChannel is origin-wide: a second game tab (a second character
        // logged in in another tab) is on the same channel and would otherwise
        // answer this pop-out's handshake, or execute a send meant for this tab,
        // with its own character. Only react to a pop-out this tab itself opened.
        if (!this.popoutInstanceId || data.instanceId !== this.popoutInstanceId) return;

        if (data.type === 'ready') {
            this._sendInit();
        } else if (data.type === 'send') {
            this._executeSend(data.channel, data.text);
        }
    }

    /**
     * Read the currently visible channel tabs from the game DOM.
     * Falls back to the hardcoded CHANNELS list if the DOM isn't ready.
     * @returns {Array<{hrid: string, name: string}>}
     */
    _getLiveChannels() {
        const tabButtons = Array.from(
            document.querySelectorAll('[class*="Chat_tabsComponentContainer"] button[role="tab"]')
        );

        let domChannels;
        if (tabButtons.length === 0) {
            domChannels = CHANNELS;
        } else {
            domChannels = tabButtons
                .map((btn) => {
                    const hrid = btn.getAttribute('data-mention-channel');
                    const name = btn.textContent?.trim().replace(/\d+$/, '').trim();
                    if (!name) return null;
                    if (hrid) return { hrid, name };
                    // Tab without data-mention-channel: resolve HRID from known lists
                    const known = CHANNELS.find((c) => c.name === name);
                    if (known) return { hrid: known.hrid, name };
                    const discovered = Array.from(this.discoveredChannels.values()).find((c) => c.name === name);
                    if (discovered) return { hrid: discovered.hrid, name };
                    return { hrid: `__label__/${name}`, name };
                })
                .filter(Boolean);
        }

        // Merge in discovered channels only if they correspond to a visible tab name
        const visibleHrids = new Set(domChannels.map((c) => c.hrid));
        const visibleNames = new Set(domChannels.map((c) => c.name));
        const extra = Array.from(this.discoveredChannels.values()).filter(
            (c) => !visibleHrids.has(c.hrid) && visibleNames.has(c.name)
        );

        return [...domChannels, ...extra];
    }

    /**
     * Send initialization data to the pop-out.
     */
    _sendInit() {
        if (!this.relayChannel) return;

        // Serialize buffer: Map → plain object, filtering blocked players
        const bufferSnapshot = {};
        for (const [hrid, messages] of this.messageBuffer.entries()) {
            bufferSnapshot[hrid] = messages.filter((msg) => msg.isSystem || !chatBlockList.isBlocked(msg.sName));
        }

        this._relayPost({
            type: 'init',
            channels: this._getLiveChannels(),
            characterName: dataManager.getCurrentCharacterName() || '',
            messageBuffer: bufferSnapshot,
            blockedCount: this.blockedCount,
        });
    }

    /**
     * Open the pop-out window and write the self-contained HTML into it.
     */
    _openPopout() {
        if (this.popoutWindow && !this.popoutWindow.closed) {
            this.popoutWindow.focus();
            return;
        }

        // Fresh id per window: ties this specific pop-out to this specific tab
        // so BroadcastChannel traffic from/to another tab's pop-out is ignored.
        this.popoutInstanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

        const html = this._buildPopoutHTML();
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);

        // No automatic recovery here for a pop-out reopened onto a since-unplugged monitor:
        // Firefox exposes no Window Management API, so there's no "list of real monitors" to
        // compare the restored screenX/screenY against, and window.open's placement request
        // is a hint the OS/WM is free to reposition however it likes anyway — a window.open'd
        // window on a disconnected monitor typically gets shoved back onto a live screen by
        // the OS/WM before this code ever sees it, and where it doesn't, an arbitrarily large
        // or negative screenX/screenY is indistinguishable from a legitimate, if unusual,
        // second-monitor layout (ultrawide + portrait secondary, monitors above/left of
        // primary, etc.). There is no threshold that reliably separates "off a real monitor"
        // from "on a real monitor we don't know about". The manual reset button next to the
        // pop-out button (_resetSavedGeometry) is the recovery path for this case.
        const features = buildPopoutWindowFeatures(this._readSavedGeometry(), window.screen);
        this.popoutWindow = window.open(url, 'mwi-chat-popout', features);

        // Defer revocation — revoking synchronously races the new window's fetch of the blob
        this.timerRegistry.registerTimeout(setTimeout(() => URL.revokeObjectURL(url), 10000));

        if (!this.popoutWindow) {
            console.error('[PopOutChat] Popup blocked by browser');
            return;
        }

        this._startPopoutViewportTracking();
    }

    /**
     * Publish `--toolasha-visual-viewport-height` inside the pop-out document.
     *
     * entrypoint.js stamps that property onto the *game* document's <html>. A
     * `window.open`ed window is a separate document with its own
     * documentElement and its own `visualViewport`, so nothing defines it there
     * and the pane grid would silently fall back to its `100vh` default — the
     * exact value that does not shrink for the mobile on-screen keyboard, which
     * is what the fallback exists to avoid.
     *
     * initVisualViewportTracking already takes the window and document it
     * should work on (they were injectable for tests), so the game tab can
     * drive the pop-out's tracking directly — the blob: URL document is
     * same-origin — rather than duplicating the module into the pop-out's
     * inline script.
     */
    _startPopoutViewportTracking() {
        const popout = this.popoutWindow;
        if (!popout) return;

        this._stopPopoutViewportTracking();

        let stopTracking = null;
        const attach = () => {
            if (popout.closed) return;
            stopTracking?.();
            try {
                stopTracking = initVisualViewportTracking({ windowRef: popout, documentRef: popout.document });
            } catch (error) {
                console.error('[PopOutChat] Failed to track the pop-out viewport:', error);
                stopTracking = null;
            }
        };
        const detach = () => {
            stopTracking?.();
            stopTracking = null;
        };

        // `window.open` hands back a window still showing about:blank; the
        // documentElement a property written now would land on is discarded when
        // the blob document commits, so wait for the load.
        popout.addEventListener('load', attach);
        // ...and stop the moment the window goes away. A sub-module started by a
        // registered feature and never stopped is a known bug class in this repo;
        // `disable()` alone would not cover the user simply closing the window.
        popout.addEventListener('pagehide', detach);
        // A reopened window can already be loaded, in which case 'load' has been
        // and gone and will not fire again.
        if (popout.document?.readyState === 'complete') attach();

        this.popoutViewportCleanup = () => {
            try {
                popout.removeEventListener('load', attach);
                popout.removeEventListener('pagehide', detach);
            } catch {
                // A closed window can refuse listener removal; the listeners died with it
            }
            detach();
        };
    }

    /**
     * Tear down the pop-out's visual-viewport tracking, if any is running.
     */
    _stopPopoutViewportTracking() {
        if (!this.popoutViewportCleanup) return;
        const cleanup = this.popoutViewportCleanup;
        this.popoutViewportCleanup = null;
        try {
            cleanup();
        } catch (error) {
            console.error('[PopOutChat] Failed to stop pop-out viewport tracking:', error);
        }
    }

    /**
     * Read the pop-out window's last saved size/position, written by the pop-out itself
     * on resize/move. Best-effort: any missing/malformed value falls back to defaults.
     * @returns {{width:number, height:number, left:number, top:number}|null}
     */
    _readSavedGeometry() {
        try {
            const raw = localStorage.getItem(POPOUT_GEOMETRY_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    /**
     * Clear the saved pop-out window geometry so the next open falls back to the default
     * centered placement, instead of whatever position/size was last saved. This is the
     * recovery affordance for a pop-out that was left on a monitor that's since been
     * unplugged or rearranged: the position is trusted verbatim on reopen (see
     * buildPopoutWindowFeatures), so nothing else clamps it back onto a visible screen.
     */
    _resetSavedGeometry() {
        try {
            localStorage.removeItem(POPOUT_GEOMETRY_KEY);
        } catch (error) {
            console.error('[PopOutChat] Failed to reset saved window geometry:', error);
        }
    }

    /**
     * Execute a send request from the pop-out: switch to the right channel tab,
     * set the input value, and dispatch Enter.
     * @param {string} channelHrid
     * @param {string} text
     */
    _executeSend(channelHrid, text) {
        if (!text?.trim()) return;

        const chatPanel = document.querySelector('[class*="GamePage_chatPanel"]');
        if (!chatPanel) return;

        // Resolve channel name from HRID
        let channelName;
        if (channelHrid.startsWith('__label__/')) {
            channelName = channelHrid.slice('__label__/'.length);
        } else {
            channelName = CHANNEL_NAME_MAP[channelHrid] || this.discoveredChannels.get(channelHrid)?.name;
        }
        if (!channelName) return;

        const tabButtons = Array.from(chatPanel.querySelectorAll('button[role="tab"]'));
        const tabBtn = tabButtons.find((btn) => {
            const label = btn.textContent?.trim().replace(/\d+$/, '').trim();
            return label === channelName;
        });

        const doSend = () => {
            const input = chatPanel.querySelector('[class*="Chat_chatInputContainer"] input');
            if (!input) return;

            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, text.trim());
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // Yield to let React process the state update, then fire Enter
            const t = setTimeout(() => {
                input.focus();
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            }, 0);
            this.timerRegistry.registerTimeout(t);
        };

        if (tabBtn) {
            tabBtn.click();
            const t = setTimeout(doSend, 80);
            this.timerRegistry.registerTimeout(t);
        } else {
            doSend();
        }
    }

    /**
     * Build the self-contained HTML string for the pop-out window.
     * @returns {string}
     */
    _buildPopoutHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MWI Chat</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0b0e14;
    --topbg: #0d1117;
    --accent: #d7b7ff;
    --text: #cfd6e6;
    --muted: #8b949e;
    --border: rgba(255,255,255,0.07);
    --input-bg: #0f1216;
    --send-bg: #238636;
    --system: #8b949e;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: Inter, system-ui, sans-serif; font-size: 13px; overflow: hidden; }

  /* Top bar */
  #topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; height: 46px;
    background: var(--topbg); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  #topbar-title { font-weight: 700; color: var(--accent); font-size: 13px; }
  #topbar-name { color: var(--muted); font-size: 11px; }
  #blocked-count {
    color: var(--muted); font-size: 11px;
    padding: 2px 7px; border-radius: 5px;
    background: rgba(255,255,255,0.05); border: 1px solid var(--border);
  }
  #blocked-count.has-blocked { color: #ff9999; border-color: rgba(220,50,50,0.3); }
  #add-pane-btn {
    margin-left: 4px; padding: 4px 10px; font-size: 11px;
    background: rgba(215,183,255,0.1); color: var(--accent);
    border: 1px solid rgba(215,183,255,0.25); border-radius: 6px; cursor: pointer;
  }
  #add-pane-btn:hover { background: rgba(215,183,255,0.2); }
  #add-pane-btn:disabled { opacity: 0.4; cursor: default; }
  #vertical-label {
    display: flex; align-items: center; gap: 4px;
    font-size: 12px; color: #8b949e; cursor: pointer; user-select: none;
  }
  #vertical-label input { cursor: pointer; accent-color: #d7b7ff; }
  #disconnect-banner {
    display: none; margin-left: auto;
    padding: 3px 10px; background: rgba(220,50,50,0.2);
    border: 1px solid rgba(220,50,50,0.4); border-radius: 5px;
    color: #ff9999; font-size: 11px;
  }
  #disconnect-banner.visible { display: block; }

  /* Pane grid */
  #panes {
    display: grid;
    grid-template-rows: 1fr;
    /* Against the *visible* viewport, not the layout one: each pane has a chat
       input at its bottom, and 100vh does not shrink when the mobile on-screen
       keyboard covers the lower part of the screen — so a 100vh-tall grid puts
       the input the user is typing into underneath the keyboard. This is a
       separate document, so the property is published here by the game tab's
       _startPopoutViewportTracking(), not by entrypoint.js. */
    height: calc(var(--toolasha-visual-viewport-height, 100vh) - 46px);
    gap: 0;
    overflow: hidden;
  }

  /* Individual pane */
  .pane {
    display: flex; flex-direction: column;
    border-right: 1px solid var(--border);
    min-width: 0; overflow: hidden;
  }
  .pane:last-child { border-right: none; }

  /* Pane header */
  .pane-header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; background: var(--topbg);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .pane-drag-handle {
    color: var(--muted); font-size: 14px; cursor: grab;
    padding: 0 2px; line-height: 1; user-select: none; flex-shrink: 0;
  }
  .pane-drag-handle:active { cursor: grabbing; }
  .pane-channel-select {
    flex: 1; background: var(--input-bg); color: var(--text);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 5px;
    padding: 4px 6px; font-size: 12px; outline: none; cursor: pointer;
  }
  /* This window is its own document: the option-contrast rule entrypoint.js
     injects into the game page cannot reach it, so the class the selects
     carry does nothing here without this copy. Firefox draws the open
     dropdown on a native popup that ignores the select's inline background,
     so options need an explicit background AND text color of their own. */
  .toolasha-select option { background-color: #1a1a2e; color: var(--text); }
  .pane-close-btn {
    background: none; border: none; color: var(--muted);
    font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1;
  }
  .pane-close-btn:hover { color: var(--text); }
  .pane.drag-over-before { box-shadow: -3px 0 0 0 var(--accent); }
  .pane.drag-over-after  { box-shadow:  3px 0 0 0 var(--accent); }
  .pane.drag-over-before.vertical-drop { box-shadow: 0 -3px 0 0 var(--accent); }
  .pane.drag-over-after.vertical-drop  { box-shadow: 0  3px 0 0 var(--accent); }

  /* Filter row */
  .pane-filter {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 10px; background: var(--topbg);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .pane-filter-preset {
    background: var(--input-bg); color: var(--text);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 5px;
    padding: 3px 5px; font-size: 11px; outline: none; cursor: pointer; flex-shrink: 0;
  }
  .pane-filter-input {
    flex: 1; background: var(--input-bg); color: var(--text);
    border: 1px solid rgba(255,255,255,0.12); border-radius: 5px;
    padding: 3px 6px; font-size: 11px; outline: none;
  }
  .pane-filter-input:focus { border-color: var(--accent); }
  .pane-filter-input.invalid { border-color: #f87171; }

  /* Message list */
  .pane-messages {
    flex: 1; overflow-y: auto; padding: 8px 10px;
    display: flex; flex-direction: column; gap: 3px;
    scroll-behavior: smooth;
  }
  .msg { line-height: 1.45; padding: 2px 4px; border-radius: 3px; word-break: break-word; }
  .msg:hover { background: rgba(255,255,255,0.03); }
  .msg-time { color: var(--muted); font-size: 10px; margin-right: 5px; }
  .msg-name { color: var(--accent); font-weight: 600; margin-right: 4px; }
  .msg-text { color: var(--text); }
  .msg-link { color: #60a5fa; font-size: 11px; margin-left: 4px; }
  .msg-system { color: var(--system); font-style: italic; }
  .msg-name-link { cursor: pointer; }
  .msg-name-link:hover { text-decoration: underline; }
  .msg-system .msg-name-link { color: var(--accent); font-style: normal; }

  /* Footer / input */
  .pane-footer {
    display: flex; gap: 6px; align-items: center;
    padding: 8px 10px; border-top: 1px solid var(--border);
    background: var(--topbg); flex-shrink: 0;
  }
  .pane-input {
    flex: 1; background: var(--input-bg); color: var(--text);
    border: 1px solid #30363d; border-radius: 5px;
    padding: 7px 10px; font-size: 13px; outline: none;
    font-family: inherit;
  }
  .pane-input:focus { border-color: rgba(215,183,255,0.4); }
  .pane-send-btn {
    background: var(--send-bg); color: #fff;
    border: none; border-radius: 5px;
    padding: 7px 14px; font-size: 12px; font-weight: bold; cursor: pointer;
    white-space: nowrap;
  }
  .pane-send-btn:hover { opacity: 0.85; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
</style>
</head>
<body>
<div id="topbar">
  <span id="topbar-title">MWI Chat</span>
  <span id="topbar-name"></span>
  <span id="blocked-count" title="Messages hidden by your block list this session">0 blocked</span>
  <button id="add-pane-btn">+ Pane</button>
  <label id="vertical-label"><input type="checkbox" id="vertical-toggle"> Vertical</label>
  <div id="disconnect-banner">⚠ Disconnected from game tab</div>
</div>
<div id="panes"></div>

<script>
(function () {
  'use strict';

  const RELAY = '${RELAY_CHANNEL}';
  const SEND  = '${SEND_CHANNEL}';
  // Ties this window to the tab that opened it: BroadcastChannel is shared by
  // every same-origin tab, so without this a second game tab (a second
  // character logged in in another tab) would answer this window's handshake
  // and execute sends meant for the tab that actually opened it.
  const INSTANCE_ID = '${this.popoutInstanceId}';
  const MAX_PER_CHANNEL = 500;
  const STORAGE_KEY = 'mwi-chat-popout-layout';
  const GEOMETRY_KEY = '${POPOUT_GEOMETRY_KEY}';
  // Shared with chat-profile-link.js — same "click a name to fill /profile <name>" behavior,
  // reusing its exact regexes, name-validity rule, and name-selection logic (the whole
  // getProfileLinkNames function, interpolated by source) instead of re-deriving them here.
  const ANNOUNCE_RE = ${ANNOUNCE_RE};
  const KICK_RE = ${KICK_RE};
  const UPGRADE_RE = ${UPGRADE_RE};
  const PARTY_RE = ${PARTY_RE};
  const VALID_NAME_RE = ${VALID_NAME_RE};
  const getProfileLinkNames = ${getProfileLinkNames.toString()};

  function fillProfileCommand(paneObj, name) {
    if (!paneObj || !paneObj.input) return;
    paneObj.input.value = '/profile ' + name;
    paneObj.input.focus();
  }

  // Wrap each linkable name in an announcement's text into a clickable span, mirroring
  // chat-profile-link.js's wrapping: a kick line gets both names, every other shape one.
  function appendAnnouncementText(textEl, text, paneObj) {
    const spans = [];
    getProfileLinkNames(text).forEach((target) => {
      if (!VALID_NAME_RE.test(target.name)) return;
      let from = 0;
      let idx;
      while ((idx = text.indexOf(target.name, from)) !== -1) {
        const before = text.slice(0, idx);
        const after = text.slice(idx + target.name.length);
        const beforeOk = !target.beforeSuffix || before.endsWith(target.beforeSuffix);
        const afterOk = !target.afterPrefixes || target.afterPrefixes.some((p) => after.startsWith(p));
        if (beforeOk && afterOk) {
          spans.push({ start: idx, end: idx + target.name.length, name: target.name });
          break;
        }
        from = idx + target.name.length;
      }
    });
    if (spans.length === 0) {
      textEl.textContent = text;
      return;
    }
    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    spans.forEach((s) => {
      if (s.start > cursor) textEl.appendChild(document.createTextNode(text.slice(cursor, s.start)));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'msg-name-link';
      nameSpan.textContent = s.name;
      nameSpan.title = 'Fill "/profile ' + s.name + '" into chat';
      nameSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        fillProfileCommand(paneObj, s.name);
      });
      textEl.appendChild(nameSpan);
      cursor = s.end;
    });
    if (cursor < text.length) textEl.appendChild(document.createTextNode(text.slice(cursor)));
  }

  const FILTER_PRESETS = [
    { value: 'none',         label: 'No filter',      regex: null },
    { value: 'enhanced_buy', label: 'Enhanced Buy',   regex: /\\+\\d+.*Buy\\]/i },
    { value: 'enhanced_sell',label: 'Enhanced Sell',  regex: /\\+\\d+.*Sell\\]/i },
    { value: 'buy_only',     label: 'Buy only',       regex: /Buy\\]/i },
    { value: 'sell_only',    label: 'Sell only',      regex: /Sell\\]/i },
    { value: 'custom',       label: 'Custom\u2026',   regex: null },
  ];

  function buildCustomRegex(text) {
    if (!text) return null;
    const m = text.match(/^\\/(.+)\\/([gimsuy]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2] || 'i'); } catch { return null; }
    }
    const esc = text.replace(/[-.*+?^\x24{}()|\\\\]/g, '\\\\$&').replace(/\\[/g, '\\\\[').replace(/\\]/g, '\\\\]');
    return new RegExp(esc, 'i');
  }

  function matchesFilter(paneObj, msg) {
    if (!paneObj.filterRegex) return true;
    const parts = [msg.m || ''];
    if (msg.renderedLinks) parts.push(...msg.renderedLinks);
    return parts.some(p => paneObj.filterRegex.test(p));
  }

  const relay  = new BroadcastChannel(RELAY);
  const sendCh = new BroadcastChannel(SEND);

  let channels     = [];
  let characterName = '';
  let messageBuffer = {}; // hrid → Array<msg>
  let panes        = [];
  let pingTimeout  = null;
  let paneIdSeq    = 0;

  // ── DOM refs ──────────────────────────────────────────────────
  const panesEl        = document.getElementById('panes');
  const addPaneBtn     = document.getElementById('add-pane-btn');
  const verticalToggle = document.getElementById('vertical-toggle');
  const nameEl         = document.getElementById('topbar-name');
  const disconnectEl   = document.getElementById('disconnect-banner');
  const blockedEl      = document.getElementById('blocked-count');

  function setBlockedCount(count) {
    const n = count || 0;
    blockedEl.textContent = n + ' blocked';
    blockedEl.classList.toggle('has-blocked', n > 0);
  }

  // ── Ping watchdog ─────────────────────────────────────────────
  function resetPingWatchdog() {
    clearTimeout(pingTimeout);
    disconnectEl.classList.remove('visible');
    pingTimeout = setTimeout(() => disconnectEl.classList.add('visible'), 15000);
  }

  // ── BroadcastChannel messages ─────────────────────────────────
  relay.onmessage = ({ data }) => {
    // Ignore relay traffic from any game tab other than the one that opened us.
    if (data.instanceId !== INSTANCE_ID) return;
    if (data.type === 'ping') {
      resetPingWatchdog();
      return;
    }
    if (data.type === 'init') {
      channels      = data.channels || [];
      characterName = data.characterName || '';
      messageBuffer = data.messageBuffer || {};
      nameEl.textContent = characterName ? '— ' + characterName : '';
      setBlockedCount(data.blockedCount);
      panes.forEach(p => refreshPaneSelect(p));
      resetPingWatchdog();
      return;
    }
    if (data.type === 'channels_updated') {
      channels = data.channels || [];
      panes.forEach(p => refreshPaneSelect(p));
      return;
    }
    if (data.type === 'blocked_count') {
      setBlockedCount(data.count);
      return;
    }
    if (data.type === 'chat_message') {
      // Buffer incoming
      if (!messageBuffer[data.channel]) messageBuffer[data.channel] = [];
      messageBuffer[data.channel].push(data);
      if (messageBuffer[data.channel].length > MAX_PER_CHANNEL) {
        messageBuffer[data.channel].shift();
      }
      // Route to matching panes
      panes.forEach(p => {
        if (p.channelHrid === data.channel) appendMessage(p, data);
      });
    }
  };

  // Signal ready
  sendCh.postMessage({ type: 'ready', instanceId: INSTANCE_ID });
  resetPingWatchdog();

  // ── Pane management ───────────────────────────────────────────
  function createPane(initialHrid, savedFilterPreset, savedFilterCustom) {
    const id = ++paneIdSeq;
    const hrid = initialHrid || (channels[0]?.hrid || '');

    const pane = document.createElement('div');
    pane.className = 'pane';
    pane.dataset.paneId = id;

    // Header
    const header = document.createElement('div');
    header.className = 'pane-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'pane-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder';

    const select = document.createElement('select');
    select.className = 'pane-channel-select';
    select.classList.add('toolasha-select');
    populateSelect(select, channels, hrid);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close pane';
    closeBtn.addEventListener('click', () => removePane(id));

    header.appendChild(dragHandle);
    header.appendChild(select);
    header.appendChild(closeBtn);

    // Filter row
    const filterRow = document.createElement('div');
    filterRow.className = 'pane-filter';

    const filterSelect = document.createElement('select');
    filterSelect.className = 'pane-filter-preset';
    filterSelect.classList.add('toolasha-select');
    FILTER_PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = savedFilterPreset || 'none';

    const filterInput = document.createElement('input');
    filterInput.className = 'pane-filter-input';
    filterInput.type = 'text';
    filterInput.placeholder = 'text or /regex/';
    filterInput.value = savedFilterCustom || '';
    filterInput.style.display = filterSelect.value === 'custom' ? '' : 'none';

    filterRow.appendChild(filterSelect);
    filterRow.appendChild(filterInput);

    // Messages
    const messages = document.createElement('div');
    messages.className = 'pane-messages';

    // Footer
    const footer = document.createElement('div');
    footer.className = 'pane-footer';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pane-input';
    input.placeholder = 'Type a message...';
    input.maxLength = 500;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'pane-send-btn';
    sendBtn.textContent = 'SEND';

    const doSend = () => {
      const text = input.value.trim();
      if (!text || !paneObj.channelHrid) return;
      sendCh.postMessage({ type: 'send', channel: paneObj.channelHrid, text, instanceId: INSTANCE_ID });
      input.value = '';
      input.focus();
    };

    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    footer.appendChild(input);
    footer.appendChild(sendBtn);

    pane.appendChild(header);
    pane.appendChild(filterRow);
    pane.appendChild(messages);
    pane.appendChild(footer);

    // Drag-to-reorder
    pane.draggable = true;
    pane.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
      // Use the handle as the drag image anchor so the whole pane moves naturally
      setTimeout(() => pane.style.opacity = '0.5', 0);
    });
    pane.addEventListener('dragend', () => {
      pane.style.opacity = '';
      clearDragOver();
    });
    pane.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDragOver();
      const vertical = verticalToggle.checked;
      const rect = pane.getBoundingClientRect();
      const mid = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      const before = vertical ? e.clientY < mid : e.clientX < mid;
      pane.classList.add(before ? 'drag-over-before' : 'drag-over-after');
      if (vertical) pane.classList.add('vertical-drop');
    });
    pane.addEventListener('dragleave', () => clearDragOver());
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      const srcId = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (srcId === id) return;
      const srcIdx = panes.findIndex(p => p.id === srcId);
      const tgtIdx = panes.findIndex(p => p.id === id);
      if (srcIdx === -1 || tgtIdx === -1) return;
      const vertical = verticalToggle.checked;
      const rect = pane.getBoundingClientRect();
      const mid = vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      const insertBefore = vertical ? e.clientY < mid : e.clientX < mid;
      // Reorder DOM
      if (insertBefore) {
        panesEl.insertBefore(panes[srcIdx].pane, pane);
      } else {
        pane.insertAdjacentElement('afterend', panes[srcIdx].pane);
      }
      // Sync panes array to match DOM order
      const [moved] = panes.splice(srcIdx, 1);
      const newTgtIdx = panes.findIndex(p => p.id === id);
      panes.splice(insertBefore ? newTgtIdx : newTgtIdx + 1, 0, moved);
      clearDragOver();
      saveLayout();
    });

    panesEl.appendChild(pane);

    const paneObj = { id, pane, select, messages, input, channelHrid: hrid };
    panes.push(paneObj);

    // Initialize filter state
    const initPreset = FILTER_PRESETS.find(p => p.value === (savedFilterPreset || 'none')) || FILTER_PRESETS[0];
    paneObj.filterPreset = initPreset.value;
    paneObj.filterCustom = savedFilterCustom || '';
    paneObj.filterRegex = initPreset.value === 'custom'
      ? buildCustomRegex(paneObj.filterCustom)
      : initPreset.regex;

    filterSelect.addEventListener('change', () => {
      const preset = FILTER_PRESETS.find(p => p.value === filterSelect.value) || FILTER_PRESETS[0];
      paneObj.filterPreset = preset.value;
      filterInput.style.display = preset.value === 'custom' ? '' : 'none';
      paneObj.filterRegex = preset.value === 'custom'
        ? buildCustomRegex(paneObj.filterCustom)
        : preset.regex;
      refilterPane(paneObj);
      saveLayout();
    });

    let filterDebounce;
    filterInput.addEventListener('input', () => {
      paneObj.filterCustom = filterInput.value;
      filterInput.classList.remove('invalid');
      const regex = buildCustomRegex(filterInput.value);
      if (filterInput.value && !regex) {
        filterInput.classList.add('invalid');
        return;
      }
      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(() => {
        paneObj.filterRegex = regex;
        refilterPane(paneObj);
        saveLayout();
      }, 300);
    });

    select.addEventListener('change', () => {
      paneObj.channelHrid = select.value;
      messages.innerHTML = '';
      (messageBuffer[paneObj.channelHrid] || []).forEach(msg => appendMessage(paneObj, msg));
      saveLayout();
    });

    // Pre-populate with buffered messages
    (messageBuffer[hrid] || []).forEach(msg => appendMessage(paneObj, msg));

    updateGrid();
    updateAddButton();
    return paneObj;
  }

  function removePane(id) {
    if (panes.length <= 1) return; // Keep at least one pane
    const idx = panes.findIndex(p => p.id === id);
    if (idx === -1) return;
    panes[idx].pane.remove();
    panes.splice(idx, 1);
    updateGrid();
    updateAddButton();
    saveLayout();
  }

  function clearDragOver() {
    document.querySelectorAll('.pane').forEach(el => {
      el.classList.remove('drag-over-before', 'drag-over-after', 'vertical-drop');
    });
  }

  function updateGrid() {
    const vertical = document.getElementById('vertical-toggle')?.checked;
    if (vertical) {
      panesEl.style.gridTemplateRows = '1fr';
      panesEl.style.gridTemplateColumns = panes.map(() => '1fr').join(' ');
    } else {
      panesEl.style.gridTemplateColumns = '1fr';
      panesEl.style.gridTemplateRows = panes.map(() => '1fr').join(' ');
    }
  }

  function updateAddButton() {
    // No pane limit
  }

  function populateSelect(select, channelList, activeHrid) {
    select.innerHTML = '';
    channelList.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.hrid;
      opt.textContent = ch.name;
      if (ch.hrid === activeHrid) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function refreshPaneSelect(paneObj) {
    const current = paneObj.channelHrid;
    populateSelect(paneObj.select, channels, current);
    paneObj.select.value = current;
  }

  // ── Message rendering ─────────────────────────────────────────
  function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const use12Hour = ${isTwelveHourClock(config.getSettingValue('market_listingTimeFormat', '24hour'))};
    return d
        .toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: use12Hour })
        .trim();
  }

  function linkifyText(el, text) {
    // Use RegExp constructor to avoid literal slashes being misread by document.write HTML parser
    const URL_RE = new RegExp('https?://[^ \\t\\r\\n<>\\x22\\x27]+', 'g');
    let last = 0;
    let match;
    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > last) {
        el.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const a = document.createElement('a');
      a.href = match[0];
      a.textContent = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'color: #60a5fa; word-break: break-all;';
      el.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      el.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function refilterPane(paneObj) {
    paneObj.messages.innerHTML = '';
    (messageBuffer[paneObj.channelHrid] || []).forEach(msg => appendMessage(paneObj, msg));
  }

  function appendMessage(paneObj, msg) {
    if (!matchesFilter(paneObj, msg)) return;
    const { messages } = paneObj;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;

    const row = document.createElement('div');
    row.className = msg.isSystem ? 'msg msg-system' : 'msg';

    if (msg.isSystem) {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = formatTime(msg.t);
      const textEl = document.createElement('span');
      textEl.className = 'msg-text';

      // Announcement names get the same clickable treatment as the main chat window
      // (chat-profile-link.js) and as regular sender names below — including the kick
      // line's two names — via the shared getProfileLinkNames logic.
      appendAnnouncementText(textEl, msg.m || '', paneObj);

      row.appendChild(timeEl);
      row.appendChild(textEl);
    } else {
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = formatTime(msg.t);

      const nameEl = document.createElement('span');
      nameEl.className = 'msg-name';
      nameEl.textContent = msg.sName;
      if (msg.sName && VALID_NAME_RE.test(msg.sName)) {
        nameEl.classList.add('msg-name-link');
        nameEl.title = 'Fill "/profile ' + msg.sName + '" into chat';
        nameEl.addEventListener('click', (e) => {
          e.stopPropagation();
          fillProfileCommand(paneObj, msg.sName);
        });
      }

      const textEl = document.createElement('span');
      textEl.className = 'msg-text';
      linkifyText(textEl, msg.m);

      row.appendChild(timeEl);
      row.appendChild(nameEl);
      row.appendChild(textEl);

      if (msg.renderedLinks && msg.renderedLinks.length > 0) {
        msg.renderedLinks.forEach(linkStr => {
          const linkEl = document.createElement('span');
          linkEl.className = 'msg-link';
          linkEl.textContent = linkStr;
          row.appendChild(linkEl);
        });
      }
    }

    messages.appendChild(row);

    // Trim to MAX_PER_CHANNEL rendered rows
    while (messages.children.length > MAX_PER_CHANNEL) {
      messages.removeChild(messages.firstChild);
    }

    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  // ── Layout persistence ────────────────────────────────────────
  function saveLayout() {
    try {
      const layout = {
        vertical: verticalToggle.checked,
        panes: panes.map(p => ({
          channelHrid: p.channelHrid,
          filterPreset: p.filterPreset || 'none',
          filterCustom: p.filterCustom || '',
        })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch { /* ignore */ }
  }

  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  // ── Window geometry persistence ─────────────────────────────────
  // Saves this window's size/position so the next pop-out opens where this one was left,
  // instead of always at the same fixed spot. Read back by the opener (pop-out-chat.js
  // _readSavedGeometry) before the *next* window.open call — window features can only be
  // set at creation time, so this window can't resize itself, only inform the next one.
  function saveGeometry() {
    try {
      localStorage.setItem(GEOMETRY_KEY, JSON.stringify({
        width: window.outerWidth,
        height: window.outerHeight,
        left: window.screenX,
        top: window.screenY,
      }));
    } catch { /* ignore */ }
  }

  let geometryDebounce;
  window.addEventListener('resize', () => {
    clearTimeout(geometryDebounce);
    geometryDebounce = setTimeout(saveGeometry, 400);
  });
  window.addEventListener('beforeunload', saveGeometry);

  // ── Init ──────────────────────────────────────────────────────
  verticalToggle.addEventListener('change', () => { updateGrid(); saveLayout(); });

  addPaneBtn.addEventListener('click', () => {
    // Pick a channel not already in use if possible
    const usedHrids = new Set(panes.map(p => p.channelHrid));
    const next = channels.find(c => !usedHrids.has(c.hrid)) || channels[0];
    createPane(next?.hrid);
    saveLayout();
  });

  // Restore saved layout, or create a single default pane
  const savedLayout = loadLayout();
  if (savedLayout) {
    if (savedLayout.vertical) {
      verticalToggle.checked = true;
    }
    const savedPanes = savedLayout.panes || [];
    if (savedPanes.length > 0) {
      savedPanes.forEach(p => createPane(p.channelHrid, p.filterPreset, p.filterCustom));
    } else {
      createPane(channels[0]?.hrid || '/chat_channel_types/general');
    }
  } else {
    // Create initial pane (default to General, or first available)
    const defaultHrid = channels[0]?.hrid || '/chat_channel_types/general';
    createPane(defaultHrid);
  }

})();
</script>
</body>
</html>`;
    }

    /**
     * Disable the feature and clean up all resources.
     */
    disable() {
        if (this.wsHandler) {
            webSocketHook.off('chat_message_received', this.wsHandler);
            this.wsHandler = null;
        }

        if (this.relayChannel) {
            this.relayChannel.close();
            this.relayChannel = null;
        }

        if (this.sendChannel) {
            this.sendChannel.close();
            this.sendChannel = null;
        }

        this._stopPopoutViewportTracking();

        if (this.popoutWindow && !this.popoutWindow.closed) {
            this.popoutWindow.close();
        }
        this.popoutWindow = null;
        this.popoutInstanceId = null;

        this.timerRegistry.clearAll();

        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }

        if (this.unregisterReady) {
            this.unregisterReady();
            this.unregisterReady = null;
        }

        if (this.popoutBtn && document.contains(this.popoutBtn)) {
            this.popoutBtn.remove();
        }
        this.popoutBtn = null;

        if (this.resetGeometryBtn && document.contains(this.resetGeometryBtn)) {
            this.resetGeometryBtn.remove();
        }
        this.resetGeometryBtn = null;

        this.messageBuffer.clear();
        this.blockedCount = 0;
        this.initialized = false;
    }
}

// Exported for tests: the pop-out window is a separate self-contained document, so its
// generated markup/script is what a test can actually inspect.
export { PopOutChat, buildPopoutWindowFeatures, POPOUT_GEOMETRY_KEY };

export default {
    name: 'Pop-Out Chat',
    initialize: async () => {
        const instance = new PopOutChat();
        await instance.initialize();
        return instance;
    },
    cleanup: (instance) => {
        if (instance) instance.disable();
    },
};
