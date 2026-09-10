/**
 * Queue Monitor UI
 * Floating widget showing estimated queue time remaining for other characters.
 * Countdown ticks every 30 seconds. Color-coded: green > 1hr, yellow < 30min, red = 0.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { timeReadable } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';
import queueSnapshot from './queue-snapshot.js';

const PANEL_ID = 'toolasha-queue-monitor';
const UPDATE_INTERVAL = 30_000; // 30 seconds
const STALE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';

class QueueMonitorUI {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.timers = createTimerRegistry();
        this.collapsed = false;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this._expandedChars = new Set();
        this._initialized = false;
    }

    /**
     * Initialize the UI
     *
     * Two separate guards, because the leak has two shapes.
     *
     * `character_initialized` fires on a plain WebSocket reconnect to the same
     * character, not only on a character switch, and the entrypoint's own
     * "first load" path re-runs `featureRegistry.initializeFeatures()` whenever
     * that event's `_isCharacterSwitch` flag is false — which it is on a
     * reconnect. Unguarded, a reconnect would register a second `setInterval`
     * redraw loop and a second `character_initialized` listener every time it
     * happened; only the most recently stored one could ever be torn down
     * again, so every earlier one leaked for the rest of the session.
     *
     * The `_initialized` flag closes only the *same-tick* case: a second call
     * arriving before the first has suspended. It cannot close a teardown that
     * lands inside the collapse-state read below, because `disable()` clears
     * the flag — the suspended call then resumes past a guard that is no
     * longer set and registers its interval and listener anyway, on top of
     * whatever the fresh call registered. That is what the ownership ticket is
     * for: it survives the flag being cleared and reset.
     */
    async initialize() {
        if (this._initialized) return;
        this._initialized = true;

        // Load collapse state
        const ticket = captureOwner(this);
        this.collapsed = await storage.get('queueMonitor_collapsed', 'settings', false);
        if (!stillOurs(ticket)) return;

        this._buildPanel();
        this._updateDisplay();

        // Refresh display periodically
        this.timers.registerInterval(setInterval(() => this._updateDisplay(), UPDATE_INTERVAL));

        // Also refresh when switching characters (new snapshot available after re-init)
        this._boundOnInit = () => {
            // Delay slightly to allow snapshot to be saved
            setTimeout(() => this._updateDisplay(), 500);
        };
        dataManager.on('character_initialized', this._boundOnInit);
    }

    /**
     * Show the panel if it is hidden, hide it if it is up.
     *
     * The panel has no button of its own — it appears with the feature and
     * stays — so this is the only way to put it away without switching the
     * whole feature off in Settings.
     * @returns {boolean} Whether there was a panel to toggle
     */
    toggle() {
        if (!this.panel) return false;
        const hidden = this.panel.style.display === 'none';
        this.panel.style.display = hidden ? '' : 'none';
        if (hidden) bringPanelToFront(this.panel);
        return true;
    }

    /**
     * Disable and clean up
     */
    disable() {
        // First of all, so an `initialize()` parked on the collapse-state read
        // cannot resume into the interval and listener this is tearing down.
        noteTeardown(this);
        this.timers.clearAll();
        if (this._boundOnInit) {
            dataManager.off('character_initialized', this._boundOnInit);
            this._boundOnInit = null;
        }
        // A drag in progress holds document-level pointermove/pointerup
        // listeners that only remove themselves on pointerup — closing the
        // panel mid-drag (e.g. the queueMonitor setting is switched off while
        // the user is dragging it) would otherwise leak them for the rest of
        // the page's life, each one then throwing against the panel this is
        // about to null out.
        this._endDrag();
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
        this._initialized = false;
    }

    /**
     * Build the floating panel
     */
    _buildPanel() {
        if (this.panel) return;

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        this.panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: ${config.Z_FLOATING_PANEL};
            background: rgba(10, 10, 20, 0.95);
            border: 1px solid ${ACCENT_BORDER};
            border-radius: 8px;
            min-width: 220px;
            max-width: 320px;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 12px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            cursor: grab;
            background: ${ACCENT_BG};
            border-bottom: 1px solid ${ACCENT_BORDER};
            border-radius: 7px 7px 0 0;
            user-select: none;
        `;
        header.innerHTML = `
            <span style="font-weight:600; font-size:12px; color:${ACCENT};">Queue Monitor</span>
            <button id="toolasha-qm-toggle" style="
                background:none; border:none; color:#aaa; font-size:16px;
                cursor:pointer; padding:0; line-height:1;">${this.collapsed ? '+' : '−'}</button>
        `;
        this._setupDrag(header);

        // Body
        this.bodyEl = document.createElement('div');
        this.bodyEl.style.cssText = `
            padding: 8px 10px;
            display: ${this.collapsed ? 'none' : 'block'};
            max-height: 300px;
            overflow-y: auto;
        `;

        this.panel.appendChild(header);
        this.panel.appendChild(this.bodyEl);
        document.body.appendChild(this.panel);

        registerFloatingPanel(this.panel);

        // Bring to front on click
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Toggle collapse
        header.querySelector('#toolasha-qm-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            this.collapsed = !this.collapsed;
            this.bodyEl.style.display = this.collapsed ? 'none' : 'block';
            e.target.textContent = this.collapsed ? '+' : '−';
            storage.set('queueMonitor_collapsed', this.collapsed, 'settings');
        });
    }

    /**
     * Setup dragging on header
     * @param {HTMLElement} header
     */
    _setupDrag(header) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        header.style.touchAction = 'none';
        this._dragHeader = header;

        // Stored on the instance, rather than kept as closures private to this
        // method, so `disable()` can remove them from `document` if it runs
        // mid-drag instead of only ever being able to remove them from a
        // `pointerup` that already fired.
        this._onPointerMove = (e) => {
            if (!this.isDragging || !this.panel) return;
            const x = e.clientX - this.dragOffset.x;
            const y = e.clientY - this.dragOffset.y;
            this.panel.style.left = `${x}px`;
            this.panel.style.top = `${y}px`;
            this.panel.style.right = 'auto';
            this.panel.style.bottom = 'auto';
        };

        this._onPointerUp = () => {
            this._endDrag();
        };

        this._onPointerDown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            this.isDragging = true;
            this.dragOffset.x = e.clientX - this.panel.getBoundingClientRect().left;
            this.dragOffset.y = e.clientY - this.panel.getBoundingClientRect().top;
            header.style.cursor = 'grabbing';
            e.preventDefault();

            // Attach document listeners only for the duration of the drag
            document.addEventListener('pointermove', this._onPointerMove);
            document.addEventListener('pointerup', this._onPointerUp);
            document.addEventListener('pointercancel', this._onPointerUp);
        };

        header.addEventListener('pointerdown', this._onPointerDown);
    }

    /**
     * End a drag in progress and remove the document-level listeners it holds,
     * however it ends: a normal pointerup/pointercancel, or `disable()` cutting
     * the panel down mid-drag.
     */
    _endDrag() {
        document.removeEventListener('pointermove', this._onPointerMove);
        document.removeEventListener('pointerup', this._onPointerUp);
        document.removeEventListener('pointercancel', this._onPointerUp);
        if (this.isDragging) {
            this.isDragging = false;
            if (this._dragHeader) this._dragHeader.style.cursor = 'grab';
        }
    }

    /**
     * Update the display with current snapshot data
     */
    _updateDisplay() {
        if (!this.bodyEl) return;

        const snapshots = queueSnapshot.getOtherCharacterSnapshots();

        if (snapshots.length === 0) {
            this.bodyEl.innerHTML = `<div style="color:#666; font-size:11px; text-align:center; padding:4px 0;">
                No other character data yet.<br>Switch characters to capture queue state.
            </div>`;
            return;
        }

        // Sort by character name
        snapshots.sort((a, b) => a.characterName.localeCompare(b.characterName));

        let html = '';
        for (const snap of snapshots) {
            const elapsed = (Date.now() - snap.timestamp) / 1000;
            const remaining = Math.max(0, snap.totalQueueSeconds - elapsed);
            const isStale = Date.now() - snap.timestamp > STALE_THRESHOLD;
            const isExpanded = this._expandedChars.has(String(snap.characterId));

            // Color coding
            let dotColor;
            if (snap.actions.length === 0) {
                dotColor = '#666'; // No actions = grey
            } else if (remaining <= 0 && !snap.hasInfiniteAction) {
                dotColor = '#e74c3c'; // Red — likely idle
            } else if (remaining < 1800 && !snap.hasInfiniteAction) {
                dotColor = '#f39c12'; // Yellow — less than 30 min
            } else {
                dotColor = '#2ecc71'; // Green — more than 30 min or infinite
            }

            // Time display
            let timeDisplay;
            if (snap.actions.length === 0) {
                timeDisplay = 'Idle';
            } else if (snap.hasInfiniteAction && remaining <= 0) {
                timeDisplay = '∞';
            } else if (remaining <= 0) {
                timeDisplay = 'Done';
            } else {
                timeDisplay = timeReadable(remaining);
                if (snap.hasInfiniteAction) {
                    timeDisplay += ' + ∞';
                }
            }

            html += `<div style="margin-bottom:6px;">`;
            html += `<div style="display:flex; align-items:center; gap:6px; cursor:pointer;" data-char-id="${snap.characterId}">`;
            html += `<span style="width:8px; height:8px; border-radius:50%; background:${dotColor}; flex-shrink:0;"></span>`;
            html += `<span style="font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this._escapeHtml(snap.characterName)}</span>`;
            html += `<span style="color:#aaa; font-size:11px; white-space:nowrap;">${timeDisplay}</span>`;
            html += `<span style="color:#555; font-size:10px;">${isExpanded ? '▾' : '▸'}</span>`;
            html += `</div>`;

            if (isStale) {
                html += `<div style="color:#f39c12; font-size:10px; margin-left:14px; margin-top:2px;">Stale (>${Math.round((Date.now() - snap.timestamp) / 3600000)}h ago)</div>`;
            }

            // Expanded action details
            if (isExpanded && snap.actions.length > 0) {
                html += `<div style="margin-left:14px; margin-top:4px; font-size:11px; color:#999;">`;
                // Actions run sequentially — consume elapsed time through the queue in order
                let remainingElapsed = Math.max(0, elapsed);
                for (const action of snap.actions) {
                    let actionTimeStr;
                    if (action.isInfinite) {
                        actionTimeStr = '∞';
                        remainingElapsed = 0; // nothing after an infinite action has started
                    } else if (action.estimatedSeconds !== null) {
                        const actionRemaining = Math.max(0, action.estimatedSeconds - remainingElapsed);
                        remainingElapsed = Math.max(0, remainingElapsed - action.estimatedSeconds);
                        actionTimeStr = actionRemaining <= 0 ? 'Done' : timeReadable(actionRemaining);
                    } else {
                        actionTimeStr = '?';
                        remainingElapsed = 0; // unknown duration — nothing after it has started
                    }

                    const countStr = action.hasMaxCount ? `${action.currentCount}/${action.maxCount}` : '';

                    html += `<div style="display:flex; justify-content:space-between; gap:8px; padding:1px 0;">`;
                    html += `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this._escapeHtml(action.actionName)}</span>`;
                    html += `<span style="white-space:nowrap; color:#777;">${countStr ? countStr + ' · ' : ''}${actionTimeStr}</span>`;
                    html += `</div>`;
                }
                html += `</div>`;
            }

            html += `</div>`;
        }

        this.bodyEl.innerHTML = html;

        // Attach click handlers for expand/collapse
        const charRows = this.bodyEl.querySelectorAll('[data-char-id]');
        for (const row of charRows) {
            row.addEventListener('click', () => {
                const charId = row.dataset.charId;
                if (this._expandedChars.has(charId)) {
                    this._expandedChars.delete(charId);
                } else {
                    this._expandedChars.add(charId);
                }
                this._updateDisplay();
            });
        }
    }

    /**
     * Escape HTML special characters
     * @param {string} str
     * @returns {string}
     */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

const queueMonitorUI = new QueueMonitorUI();
export default queueMonitorUI;
