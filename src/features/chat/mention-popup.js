/**
 * Mention Popup
 * Draggable popup showing all @mention messages for a chat channel
 */

import config from '../../core/config.js';
import { markAsProfileLink } from './chat-profile-link.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { formatDateTime } from '../../utils/formatters.js';

/** The copy button at rest — what a flash restores it to */
const COPY_BUTTON_GLYPH = '⧉';

class MentionPopup {
    constructor() {
        this.container = null;
        this.currentChannel = null;
        this.currentMentions = null;
        this.currentDisplayName = null;
        this.onCloseFn = null;

        // Dragging state
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.dragMoveHandler = null;
        this.dragUpHandler = null;

        // Click-outside handler
        this.clickOutsideHandler = null;
    }

    /**
     * Format a UTC ISO timestamp string using the user's market date/time settings
     * @param {string} isoString - ISO 8601 timestamp (e.g. "2026-02-24T16:59:59.046Z")
     * @returns {string} Formatted date/time string
     */
    formatTimestamp(isoString) {
        if (!isoString) return '';
        return formatDateTime(new Date(isoString));
    }

    /**
     * Render mentions as plain text for the clipboard, one line per mention:
     * "[timestamp] sender: message". Pure of any DOM so it can be unit tested directly.
     * @param {Array<{sName: string, m: string, t: string}>} mentions
     * @param {string} channelDisplayName
     * @returns {string}
     */
    formatMentionsForCopy(mentions, channelDisplayName) {
        const header = `Mentions — ${channelDisplayName}`;
        if (!mentions || mentions.length === 0) {
            return `${header}\n(no mentions)`;
        }
        const lines = mentions.map((mention) => {
            const ts = this.formatTimestamp(mention.t);
            const prefix = ts ? `[${ts}] ` : '';
            return `${prefix}${mention.sName}: ${mention.m}`;
        });
        return [header, ...lines].join('\n');
    }

    /**
     * Open (or replace) the popup for a given channel
     * @param {string} channel - Channel HRID
     * @param {Array<{sName: string, m: string, t: string}>} mentions - Mention list
     * @param {string} channelDisplayName - Human-readable channel name
     * @param {Function} onClose - Callback when popup is closed (to clear mentions)
     */
    open(channel, mentions, channelDisplayName, onClose) {
        this.currentChannel = channel;
        this.onCloseFn = onClose;
        this.currentMentions = mentions;
        this.currentDisplayName = channelDisplayName;

        if (this.container) {
            // Already open — replace content for new channel
            this._updateContent(mentions, channelDisplayName);
            return;
        }

        this._build(mentions, channelDisplayName);
    }

    /**
     * Close the popup and invoke the onClose callback
     */
    close() {
        if (this.onCloseFn) {
            this.onCloseFn();
            this.onCloseFn = null;
        }

        this._teardown();
    }

    /**
     * Build and insert the popup DOM
     * @param {Array} mentions
     * @param {string} channelDisplayName
     */
    _build(mentions, channelDisplayName) {
        this.container = document.createElement('div');
        this.container.id = 'mwi-mention-popup';
        this.container.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: ${config.Z_FLOATING_PANEL};
            min-width: min(420px, 92vw);
            max-width: min(600px, 92vw);
            /* Centred with translate(-50%, -50%), so the shell's top edge sits
               half its own height above the middle of the screen: anything
               taller than the viewport pushes the header — and the close button
               in it — off the top. The shared clamp cannot rescue it, because
               clampPanelToViewport bails on transformed elements
               (panel-geometry.js). Bound the shell against the *visible*
               viewport instead: 100vh does not shrink for the mobile on-screen
               keyboard, so a popup opened while it is up would size as if it
               were not there. --toolasha-visual-viewport-height is published on
               <html> by src/utils/visual-viewport.js. Flex column so the body
               below gives up the space rather than overflowing the shell. */
            display: flex;
            flex-direction: column;
            max-height: calc(var(--toolasha-visual-viewport-height, 100vh) * 0.9);
            background: rgba(0, 0, 0, 0.92);
            border: 2px solid ${config.COLOR_ACCENT};
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #fff;
            user-select: none;
        `;

        // Header
        const header = document.createElement('div');
        header.id = 'mwi-mention-popup-header';
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            cursor: grab;
            border-radius: 6px 6px 0 0;
            background: rgba(255,255,255,0.05);
            /* The whole point of the bound above is that the header stays on
               screen and at full size; the list below it is what gives. */
            flex-shrink: 0;
        `;

        const title = document.createElement('span');
        title.id = 'mwi-mention-popup-title';
        title.style.cssText = `
            font-size: 0.9rem;
            font-weight: 600;
            color: ${config.COLOR_ACCENT};
        `;
        title.textContent = `Mentions — ${channelDisplayName}`;

        const headerBtns = document.createElement('div');
        headerBtns.style.cssText = `display: flex; align-items: center; gap: 8px;`;

        const copyBtn = document.createElement('button');
        copyBtn.textContent = COPY_BUTTON_GLYPH;
        copyBtn.title = 'Copy mentions to clipboard';
        copyBtn.style.cssText = `
            background: none;
            border: none;
            color: #aaa;
            font-size: 0.95rem;
            line-height: 1;
            cursor: pointer;
            padding: 0 2px;
        `;
        copyBtn.addEventListener('mouseenter', () => (copyBtn.style.color = '#fff'));
        copyBtn.addEventListener('mouseleave', () => (copyBtn.style.color = '#aaa'));
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._copyToClipboard(copyBtn);
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: #aaa;
            font-size: 1.2rem;
            line-height: 1;
            cursor: pointer;
            padding: 0 2px;
        `;
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#fff'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#aaa'));
        closeBtn.addEventListener('click', () => this.close());

        headerBtns.appendChild(copyBtn);
        headerBtns.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(headerBtns);

        // Body
        const body = document.createElement('div');
        body.id = 'mwi-mention-popup-body';
        body.style.cssText = `
            /* min-height:0 is what lets this shrink below its content inside
               the flex shell above — without it the list keeps its natural
               height and pushes the header back off the top of the screen. */
            flex: 1 1 auto;
            min-height: 0;
            max-height: 400px;
            overflow-y: auto;
            padding: 8px 0;
        `;

        this._renderMentions(body, mentions);

        this.container.appendChild(header);
        this.container.appendChild(body);
        document.body.appendChild(this.container);
        registerFloatingPanel(this.container);

        this._setupDragging(header);
        this._setupClickOutside();
    }

    /**
     * Update title and body content without rebuilding the whole popup
     * @param {Array} mentions
     * @param {string} channelDisplayName
     */
    _updateContent(mentions, channelDisplayName) {
        const title = this.container.querySelector('#mwi-mention-popup-title');
        if (title) title.textContent = `Mentions — ${channelDisplayName}`;

        const body = this.container.querySelector('#mwi-mention-popup-body');
        if (body) {
            body.innerHTML = '';
            this._renderMentions(body, mentions);
        }
    }

    /**
     * Render mention rows into the body element
     * @param {HTMLElement} body
     * @param {Array<{sName: string, m: string, t: string}>} mentions
     */
    _renderMentions(body, mentions) {
        if (!mentions || mentions.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = `
                padding: 16px 14px;
                color: #888;
                font-size: 0.85rem;
                text-align: center;
            `;
            empty.textContent = 'No mentions';
            body.appendChild(empty);
            return;
        }

        for (const mention of mentions) {
            const row = document.createElement('div');
            row.style.cssText = `
                padding: 7px 14px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
                font-size: 0.85rem;
                line-height: 1.4;
                user-select: text;
            `;
            row.style.cursor = 'default';

            const timestamp = document.createElement('span');
            timestamp.style.cssText = `
                color: #888;
                font-size: 0.78rem;
                margin-right: 8px;
                white-space: nowrap;
            `;
            timestamp.textContent = this.formatTimestamp(mention.t);

            const sender = document.createElement('span');
            sender.style.cssText = `
                color: ${config.COLOR_ACCENT};
                font-weight: 600;
                margin-right: 6px;
            `;
            sender.textContent = mention.sName;
            // Click-to-fill "/profile <name>", same behavior as announcement names in chat
            markAsProfileLink(sender, mention.sName);

            const msg = document.createElement('span');
            msg.style.cssText = `color: #e7e7e7;`;
            msg.textContent = mention.m;

            row.appendChild(timestamp);
            row.appendChild(sender);
            row.appendChild(msg);
            body.appendChild(row);
        }
    }

    /**
     * Copy the currently displayed mentions to the clipboard as plain text, flashing
     * the button briefly to confirm it landed (or that it was refused).
     * @param {HTMLButtonElement} button
     */
    async _copyToClipboard(button) {
        const text = this.formatMentionsForCopy(this.currentMentions, this.currentDisplayName);
        const flash = (symbol) => {
            button.textContent = symbol;
            // The resting glyph is a constant, not whatever the button happens
            // to read now: a second click inside the 1200ms window would
            // otherwise capture '✓' as the thing to restore, and the later
            // timer would put the checkmark back after the earlier one had
            // already cleared it — leaving the button stuck on '✓' until the
            // popup is rebuilt. The pending timer is cleared for the same
            // reason, so the last click is the one that decides.
            clearTimeout(this._flashTimer);
            this._flashTimer = setTimeout(() => {
                this._flashTimer = null;
                if (button.isConnected) button.textContent = COPY_BUTTON_GLYPH;
            }, 1200);
        };
        if (!navigator.clipboard) {
            flash('✗');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            flash('✓');
        } catch (error) {
            console.error('[MentionPopup] Copying the mentions failed:', error);
            flash('✗');
        }
    }

    /**
     * Close the popup when clicking outside of it
     */
    _setupClickOutside() {
        this.clickOutsideHandler = (e) => {
            if (!this.container || this.container.contains(e.target)) return;
            // The mention badge that opened this popup lives outside `this.container`.
            // Its own 'click' handler re-opens/refreshes the popup for its channel, but
            // that handler runs on 'click', after this 'mousedown' listener. Closing here
            // first would call onCloseFn (clearMentions) and, on count 0, remove the badge
            // from the DOM before its paired click ever runs — wiping the unread mentions
            // a re-click on the same badge was meant to bring back into view.
            if (e.target.closest?.('.mwi-mention-badge')) return;
            this.close();
        };
        // Use mousedown so it fires before any other click handlers
        document.addEventListener('mousedown', this.clickOutsideHandler);
    }

    /**
     * Set up drag behaviour on the header element
     * @param {HTMLElement} header
     */
    _setupDragging(header) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        header.style.touchAction = 'none';

        header.addEventListener('pointerdown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            bringPanelToFront(this.container);
            this.isDragging = true;

            // Switch from transform-based centering to explicit coordinates
            const rect = this.container.getBoundingClientRect();
            this.container.style.transform = 'none';
            this.container.style.top = `${rect.top}px`;
            this.container.style.left = `${rect.left}px`;

            this.dragOffset = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            };
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });

        this.dragMoveHandler = (e) => {
            if (!this.isDragging) return;

            let x = e.clientX - this.dragOffset.x;
            let y = e.clientY - this.dragOffset.y;

            const minVisible = 80;
            y = Math.max(0, Math.min(y, window.innerHeight - minVisible));
            x = Math.max(-this.container.offsetWidth + minVisible, Math.min(x, window.innerWidth - minVisible));

            this.container.style.top = `${y}px`;
            this.container.style.left = `${x}px`;
        };

        this.dragUpHandler = () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            header.style.cursor = 'grab';
        };

        document.addEventListener('pointermove', this.dragMoveHandler);
        document.addEventListener('pointerup', this.dragUpHandler);
        document.addEventListener('pointercancel', this.dragUpHandler);
    }

    /**
     * Remove popup from DOM and clean up event listeners
     */
    _teardown() {
        if (this.dragMoveHandler) {
            document.removeEventListener('pointermove', this.dragMoveHandler);
            this.dragMoveHandler = null;
        }
        if (this.dragUpHandler) {
            document.removeEventListener('pointerup', this.dragUpHandler);
            document.removeEventListener('pointercancel', this.dragUpHandler);
            this.dragUpHandler = null;
        }
        if (this.clickOutsideHandler) {
            document.removeEventListener('mousedown', this.clickOutsideHandler);
            this.clickOutsideHandler = null;
        }
        if (this._flashTimer) {
            clearTimeout(this._flashTimer);
            this._flashTimer = null;
        }

        if (this.container) {
            unregisterFloatingPanel(this.container);
            this.container.remove();
            this.container = null;
        }

        this.currentChannel = null;
        this.currentMentions = null;
        this.currentDisplayName = null;
        this.isDragging = false;
    }
}

const mentionPopup = new MentionPopup();

export default mentionPopup;
