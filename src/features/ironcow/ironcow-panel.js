/**
 * Iron Bell Farming panel
 *
 * The plan an iron cow follows to farm gold for cowbells, and what that plan is
 * currently worth per hour, per day and per week of bells.
 *
 * The panel does no arithmetic of its own. The plan derives itself in
 * `ironcow-plan.js` from the character's own state; the loop is costed in
 * `starfruit-loop.js` out of the calculators the rest of the script already
 * uses. Anything a figure here disagrees with the action panel about is one
 * calculator being wrong, not a second opinion grown inside a panel.
 *
 * ## Refresh is a button
 *
 * Costing the loop runs the gathering calculator and the alchemy calculator
 * twice each, against game data and market prices that do not move minute to
 * minute. So it is computed on demand, the last result is kept so the panel has
 * something to show the moment it opens, and the time it was priced at is
 * printed beside the figures.
 *
 * ## It is shown to characters it is not for
 *
 * Gated by game mode would mean an alt on a standard account cannot read the
 * plan they are considering, and a panel that refuses to open looks broken. So
 * a non-iron-cow character gets the panel with a line at the top saying the
 * plan is written for an iron cow — and, more usefully, that the loop's gold is
 * costed on the assumption that nothing is sold, which is not the best a
 * standard character could do with the same fruit.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatKMB, formatPercentage, formatWithSeparator } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { HOURS_PER_DAY } from '../../utils/profit-constants.js';
import { deriveStages, isIronCowMode, readCharacterState } from './ironcow-plan.js';
import {
    ASSUMED_OFFLINE_HOURS,
    balanceBatch,
    bellsForHours,
    calculateStarfruitLoop,
    cowbellPricing,
    hoursForBells,
    loopWarnings,
    offlineWindow,
} from './starfruit-loop.js';
import { startQueueWalk } from './ironcow-queue-walk.js';
import {
    loadOverrides,
    loadPlanCollapsed,
    loadSnapshot,
    saveSnapshot,
    setOverride,
    setPlanCollapsed,
} from './ironcow-store.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import ironCowRuntime from './ironcow-runtime.js';
// Side effect only: registers the "Iron Bell next step" overlay tile. Imported
// here — rather than where the rest of the overlay's rows are wired in, a
// bundle this feature does not otherwise touch — so the tile exists wherever
// this panel does. The tile reads `ironcow-runtime.js`, not this module, so
// this import does not become a cycle.
import './ironcow-overlay-row.js';

const PANEL_ID = 'toolasha-ironcow-farm-panel';
// Display name changed to "Iron Bell Farming" — this key is kept as-is
// (ironCowFarmPanel) so it keeps reading the geometry an existing user already
// saved under it. Renaming it would orphan that saved position and size.
const GEOMETRY_KEY = 'ironCowFarmPanel';
const DEFAULT_PANEL = { width: 520, height: 620 };

const COLORS = {
    background: 'rgba(10, 12, 20, 0.97)',
    headerBg: 'rgba(18, 26, 40, 0.92)',
    border: 'rgba(120, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    card: 'rgba(255, 255, 255, 0.04)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#7fb0ff',
    good: '#7fd6a3',
    bad: '#f0776c',
    warn: '#ffb020',
};

/**
 * @param {string} text - Contents
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A span
 */
function span(text, style = {}) {
    const element = document.createElement('span');
    element.textContent = text;
    Object.assign(element.style, style);
    return element;
}

/**
 * A small control that looks like the rest of the panel.
 * @param {string} label - Button text
 * @param {Function} onClick - Click handler
 * @param {Object} [style] - Extra styles
 * @returns {HTMLElement} A button
 */
function button(label, onClick, style = {}) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    Object.assign(element.style, {
        background: 'rgba(255, 255, 255, 0.07)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '3px',
        color: COLORS.accent,
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 8px',
        ...style,
    });
    element.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return element;
}

/**
 * A small number box that looks like the rest of the panel.
 * @param {number|string} value - Starting value
 * @param {Function} onInput - Called with the raw string on every keystroke
 * @returns {HTMLInputElement} The box
 */
function numberBox(value, onInput) {
    const element = document.createElement('input');
    element.type = 'number';
    element.min = '0';
    element.value = String(value);
    Object.assign(element.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: '3px',
        color: COLORS.text,
        fontSize: '11px',
        padding: '1px 4px',
        width: '84px',
    });
    element.addEventListener('input', () => onInput(element.value));
    return element;
}

/** The durations worth one press, in hours */
const QUEUE_PRESETS = [
    { label: '8h', hours: 8 },
    { label: '16h', hours: 16 },
    { label: '1 day', hours: 24 },
    { label: '1 week', hours: 168 },
];

/** A batch longer than this is not a queue, it is a typo */
const MAX_QUEUE_HOURS = 24 * 30;

/**
 * A titled block.
 * @param {string} title - Heading
 * @returns {HTMLElement} The card, to append rows to
 */
function card(title) {
    const element = document.createElement('div');
    Object.assign(element.style, {
        background: COLORS.card,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '6px',
        padding: '7px 9px',
        marginBottom: '7px',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
    });
    if (title) {
        const heading = span(title, { color: COLORS.accent, fontWeight: 'bold', marginBottom: '2px' });
        element.appendChild(heading);
    }
    return element;
}

/**
 * A labelled figure on its own line.
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} [color] - Ink for the value
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement} The row
 */
function line(label, value, color = COLORS.text, title = '') {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });
    const name = span(label, { color: COLORS.textDim, flex: '1' });
    const figure = span(value, { color, whiteSpace: 'nowrap' });
    if (title) row.title = title;
    row.append(name, figure);
    return row;
}

/**
 * Coins, said the way this panel says them.
 * @param {number|null|undefined} value - Coins
 * @returns {string} e.g. "1.2M", or "—"
 */
function coins(value) {
    if (!Number.isFinite(value)) return '—';
    return formatKMB(Math.round(value));
}

/**
 * One decimal, and no trailing zero on a whole number.
 * @param {number} value - Hours, usually
 * @returns {string} e.g. "16", "7.8"
 */
function round1(value) {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value * 10) / 10);
}

/**
 * Bells, which are small enough numbers to want in full.
 * @param {number|null|undefined} value - Bells
 * @returns {string} e.g. "1,204", or "—"
 */
function bells(value) {
    if (!Number.isFinite(value)) return '—';
    return formatWithSeparator(Math.round(value));
}

/**
 * What a folded plan says instead of its stages.
 *
 * Stage 6 is the loop itself and is never "done" — it is the thing the other
 * five stages unlock — so it is counted as ready or waiting rather than as a
 * sixth box to tick.
 *
 * @param {Array<Object>} stages - From `deriveStages`
 * @returns {string} e.g. "4 of 5 stages done · the loop is waiting"
 */
function planSummary(stages) {
    const gates = stages.filter((stage) => stage.id !== 'loop');
    if (!gates.length) return '';
    const done = gates.filter((stage) => stage.done).length;
    const loop = stages.find((stage) => stage.id === 'loop');
    const tail = loop ? ` · the loop is ${loop.ready ? 'ready' : 'waiting'}` : '';
    return `${done} of ${gates.length} stages done${tail}`;
}

class IronCowFarmPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
        this._loop = null;
        this.pricedAt = null;
        this._overrides = {};
        // Today's appearance until the stored answer lands: the section opens,
        // and a character who shut it sees it shut a moment later rather than
        // everyone seeing it fold up on upgrade.
        this.planCollapsed = false;
        // The duration the queue helper is sizing for. The plan's assumed
        // window until `load()` asks for the real one — read there rather than
        // here because this runs at import, before any game data exists.
        this.batchHours = ASSUMED_OFFLINE_HOURS;
        /** Which unit the duration box is being typed in: 'h' or 'd' */
        this.batchUnit = 'h';
        this.queueRefs = null;
        this.busy = false;
        this.loaded = null;
        // The overlay tile opens the same panel this toggles, and reads the
        // loop and the overrides through the same runtime object this keeps
        // current below.
        ironCowRuntime.toggle = () => this.toggle();
    }

    /** @returns {Object|null} The last costed loop */
    get loop() {
        return this._loop;
    }

    /** @param {Object|null} value - The last costed loop */
    set loop(value) {
        this._loop = value;
        ironCowRuntime.loop = value;
    }

    /** @returns {Object} This character's manual stage ticks */
    get overrides() {
        return this._overrides;
    }

    /** @param {Object} value - This character's manual stage ticks */
    set overrides(value) {
        this._overrides = value;
        ironCowRuntime.overrides = value;
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    /**
     * Put the panel away.
     * @param {Object} [options] - `remember: false` to close without recording it
     */
    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    /** Feature-registry entry point: read the state back and reopen if left open */
    async initialize() {
        await this.load();
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));

        registerCommand({
            name: 'Iron Bell Farming',
            hint: 'The cowbell plan, and what it earns',
            run: () => this.toggle(),
        });
    }

    /** Feature-registry teardown */
    disable() {
        unregisterCommand('Iron Bell Farming');
        this._remove();
    }

    /**
     * Read the stage ticks and the last costed loop.
     * @returns {Promise<void>}
     */
    async load() {
        this.overrides = await loadOverrides();
        // Unconditional: disable()/_remove() only tears down the DOM, not
        // this.loop/this.pricedAt, so on a character switch a character with
        // no snapshot of their own must still overwrite whatever the previous
        // character's numbers were — otherwise this character's panel (and
        // the overlay tile, which reads ironCowRuntime.loop) would keep
        // showing the departing character's costed gold/hour, bells/week,
        // and "costed <time>" as if they were this character's.
        this.planCollapsed = await loadPlanCollapsed();
        // Per character, like everything else here: the window a batch is sized
        // against is this character's, and a duration typed for the last one is
        // not an answer for this one.
        const window = offlineWindow();
        if (window?.hours > 0) this.batchHours = window.hours;
        this.batchUnit = 'h';
        const snapshot = await loadSnapshot();
        this.loop = snapshot;
        this.pricedAt = snapshot?.computedAt || null;
        this._render();
    }

    /**
     * Re-cost the loop against the character and the market as they stand now.
     * @returns {Promise<void>}
     */
    async refresh() {
        if (this.busy) return;
        // _create() fires load() without awaiting it (a floating panel opens
        // instantly, then fills in). Wait for that read to land first so it
        // can never resolve after this and clobber the freshly-costed loop
        // back to whatever (or nothing) was last on disk.
        if (this.loaded) await this.loaded;
        // Captured before the slow costing below: `calculateStarfruitLoop()`
        // runs the gathering and alchemy calculators against whatever game
        // data is loaded, which can take long enough for the player to switch
        // characters while it is in flight. `this.loop`/`saveSnapshot` both
        // resolve the *current* character at the moment they run — `loop` via
        // the `ironCowRuntime` setter, `saveSnapshot` via `characterKey()`
        // inside `writeScoped` — so without this guard a switch landing
        // mid-costing applies the departing character's freshly-priced loop
        // to the arriving character, in memory and in storage, clobbering
        // whatever `load()` had just correctly set up for them.
        const charId = dataManager.getCurrentCharacterId();
        this.busy = true;
        this._status('Costing…');
        try {
            const loop = await calculateStarfruitLoop();
            if (dataManager.getCurrentCharacterId() !== charId) {
                // The character this costing was for is gone; their panel
                // already loaded its own state, and this stale result must
                // not overwrite it.
                return;
            }
            if (loop) {
                this.loop = loop;
                this.pricedAt = loop.computedAt || Date.now();
                await saveSnapshot(loop);
            } else {
                this._status('Nothing to cost — game data has not loaded.');
            }
        } catch (error) {
            console.error('[IronCow] Costing the loop failed:', error);
            this._status('Costing failed — see the console.');
        } finally {
            this.busy = false;
            this._render();
        }
    }

    /**
     * Turn one stage's manual tick on or off and redraw.
     * @param {string} stageId - Which stage
     * @param {boolean} ticked - On or off
     * @returns {Promise<void>}
     */
    async toggleStage(stageId, ticked) {
        this.overrides = await setOverride(stageId, ticked);
        this._render();
    }

    /**
     * Fold the plan section away, or open it, and remember which.
     * @returns {Promise<void>}
     */
    async togglePlan() {
        this.planCollapsed = !this.planCollapsed;
        // Drawn before the write: the fold is the player's own click and must
        // land at once, whatever storage does next.
        this._render();
        await setPlanCollapsed(this.planCollapsed);
    }

    // -------------------------------------------------------------------------
    // Panel construction
    // -------------------------------------------------------------------------

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '130px',
            left: '110px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `min(${DEFAULT_PANEL.width}px, 94vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 82vh)`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px 10px 12px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 360,
            minHeight: 220,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 360, height: 220 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        if (!this.loaded) this.loaded = this.load();
    }

    _remove() {
        this.detachDrag?.();
        this.detachResize?.();
        this.detachDrag = null;
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
        this.statusEl = null;
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = span('Iron Bell Farming', { fontWeight: 'bold', color: COLORS.accent });
        this.statusEl = span('', { color: COLORS.textDim, fontSize: '11px' });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const refresh = button('Refresh', () => this.refresh());
        refresh.title = 'Re-cost the loop against your rates and the market data loaded now.';

        const close = button('✕', () => this.hide(), {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            fontSize: '13px',
            padding: '2px 4px',
        });

        header.append(title, this.statusEl, spacer, refresh, close);
        return header;
    }

    /**
     * @param {string} text - What the header's status line says
     */
    _status(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    _render() {
        if (!this.bodyEl) return;
        this.bodyEl.replaceChildren();
        // Rebuilt below, or left null when the helper does not draw
        this.queueRefs = null;

        if (!this.busy) {
            this._status(this.pricedAt ? `costed ${new Date(this.pricedAt).toLocaleTimeString()}` : 'not costed yet');
        }

        const state = this._safeState();
        const stages = state ? deriveStages(state, this.overrides) : [];

        const sections = [
            () => this._modeNote(state),
            () => this._planCard(stages),
            () => this._loopCard(),
            () => this._bellsCard(),
            () => this._queueCard(),
            () => this._checksCard(state),
        ];
        for (const build of sections) this._section(build);
    }

    /**
     * Reading the character can throw if the game data is half-loaded, and a
     * plan that cannot be read should not take the loop figures with it.
     * @returns {Object|null} The character state, or null
     */
    _safeState() {
        try {
            return readCharacterState();
        } catch (error) {
            console.error('[IronCow] Reading the character failed:', error);
            return null;
        }
    }

    /**
     * Draw one section, or say which one could not be drawn.
     *
     * Without this the panel is all-or-nothing: one section that throws takes
     * every section after it, and half a panel reads as a missing feature
     * rather than as a bug.
     *
     * @param {Function} build - Returns the section's element, or null to skip it
     */
    _section(build) {
        try {
            const element = build();
            if (element) this.bodyEl.appendChild(element);
        } catch (error) {
            console.error('[IronCow] A section could not be drawn:', error);
            this.bodyEl.appendChild(
                span(`This section could not be drawn: ${error.message}`, { display: 'block', color: COLORS.bad })
            );
        }
    }

    /**
     * The line that says who the plan is for, when it is not for this character.
     * @param {Object|null} state - Character state
     * @returns {HTMLElement|null} A note, or nothing when this is an iron cow
     */
    _modeNote(state) {
        if (!state) {
            return span('Game data has not loaded yet, so the plan cannot be checked against this character.', {
                display: 'block',
                color: COLORS.warn,
                marginBottom: '7px',
            });
        }
        if (isIronCowMode(state.gameMode)) return null;

        const holder = card('');
        holder.appendChild(
            span(
                `This character is ${state.gameMode || 'not an iron cow'}. The plan below is written for one, and ` +
                    'the loop is costed on the iron cow rule that nothing is ever sold — all its gold comes out of ' +
                    'coinify. A character with market access can do better with the same fruit.',
                { color: COLORS.warn }
            )
        );
        return holder;
    }

    /**
     * The numbered plan, each stage answered against the character.
     *
     * Foldable, because once the stages are done the checklist is six settled
     * lines across the whole top of the panel and the figures below it are what
     * the player came for. Folded, the bar carries the count so it is still
     * saying something rather than sitting there as a lid.
     *
     * @param {Array<Object>} stages - From `deriveStages`
     * @returns {HTMLElement} The card
     */
    _planCard(stages) {
        const holder = card('');
        holder.appendChild(this._planHeader(stages));

        if (this.planCollapsed) return holder;

        if (!stages.length) {
            holder.appendChild(span('No character state to check the plan against yet.', { color: COLORS.textDim }));
            return holder;
        }

        for (const stage of stages) {
            holder.appendChild(this._stageRow(stage));
        }
        return holder;
    }

    /**
     * The plan's own title bar, which is also the control that folds it.
     * @param {Array<Object>} stages - From `deriveStages`
     * @returns {HTMLElement} The bar
     */
    _planHeader(stages) {
        const summary = this.planCollapsed ? planSummary(stages) : '';
        const label = `${this.planCollapsed ? '▸' : '▾'} The plan${summary ? ` — ${summary}` : ''}`;

        const bar = button(label, () => this.togglePlan(), {
            background: 'none',
            border: 'none',
            color: COLORS.accent,
            fontWeight: 'bold',
            fontSize: '12px',
            padding: '0',
            marginBottom: '2px',
            textAlign: 'left',
        });
        bar.title = this.planCollapsed ? 'Show the stages' : 'Fold the stages away';
        return bar;
    }

    /**
     * One stage: its mark, its title, and what it looked at.
     * @param {Object} stage - From `deriveStages`
     * @returns {HTMLElement} The row
     */
    _stageRow(stage) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '7px', alignItems: 'baseline', padding: '2px 0' });

        const isLoop = stage.id === 'loop';
        const mark = isLoop ? (stage.ready ? '▶' : '⋯') : stage.done ? '☑' : '☐';
        const markColor = isLoop
            ? stage.ready
                ? COLORS.good
                : COLORS.textDim
            : stage.done
              ? COLORS.good
              : COLORS.warn;

        // Only a stage the character's own state could not answer is tickable.
        // Ticking one it did answer would let the panel disagree with the game.
        const tickable = !isLoop && !stage.derived;
        const glyph = tickable
            ? button(mark, () => this.toggleStage(stage.id, !stage.done), {
                  background: 'none',
                  border: 'none',
                  color: markColor,
                  padding: '0',
                  fontSize: '12px',
              })
            : span(mark, { color: markColor });
        if (tickable) glyph.title = 'Nothing here can be measured — tick it yourself.';

        const text = document.createElement('div');
        text.style.flex = '1';

        const heading = span(`${stage.number}. ${stage.title}`, {
            display: 'block',
            color: stage.done ? COLORS.textDim : COLORS.text,
            textDecoration: stage.done ? 'line-through' : 'none',
        });
        text.appendChild(heading);

        const parts = (stage.parts || [])
            .map((part) =>
                part.level === undefined
                    ? `${part.done ? '✓' : '·'} ${part.label}`
                    : `${part.done ? '✓' : '·'} ${part.label} ${part.level}${part.target ? `/${part.target}` : ''}`
            )
            .join('   ');
        if (parts) text.appendChild(span(parts, { display: 'block', color: COLORS.textDim, fontSize: '11px' }));

        if (isLoop && !stage.ready && stage.blockedBy?.length) {
            text.appendChild(
                span(`Waiting on: ${stage.blockedBy.join(', ')}`, {
                    display: 'block',
                    color: COLORS.warn,
                    fontSize: '11px',
                })
            );
        }

        if (stage.detail) {
            text.appendChild(span(stage.detail, { display: 'block', color: COLORS.textDim, fontSize: '11px' }));
        }

        row.append(glyph, text);
        return row;
    }

    /**
     * What the loop earns, and where its time goes.
     * @returns {HTMLElement} The card
     */
    _loopCard() {
        const holder = card('The loop');
        const loop = this.loop;

        if (!loop) {
            holder.appendChild(span('Press Refresh to cost the loop.', { color: COLORS.textDim }));
            return holder;
        }
        if (loop.missing?.length) {
            holder.appendChild(
                span(`Could not cost ${loop.missing.join(', ')} — no market data for the calculator's input yet.`, {
                    color: COLORS.warn,
                })
            );
            return holder;
        }

        const name = loop.items?.starfruitName || 'Star Fruit';

        holder.append(
            line(
                'Gold / hour',
                coins(loop.goldPerHour),
                loop.goldPerHour > 0 ? COLORS.good : COLORS.bad,
                'All of it coinify output. Nothing in this loop is sold.'
            ),
            line('Gold / day', coins(loop.goldPerDay), COLORS.text, '24 hours of the loop, uninterrupted.'),
            line(`${name} / hour`, bells(loop.fruitPerHour), COLORS.text, 'Foraged, at your rates.'),
            line(
                'Essence per fruit',
                loop.essencePerFruit.toFixed(2),
                COLORS.text,
                `${loop.items?.essencePerDecompose ?? 0} on a success, at ` +
                    `${formatPercentage(loop.decomposeRate)} decompose success.`
            ),
            line(
                'Coins per fruit',
                coins(loop.netPerFruit),
                COLORS.text,
                `${coins(loop.goldInPerFruit)} coinified at ${formatPercentage(loop.coinifyRate)} success, ` +
                    `less ${coins(loop.goldOutPerFruit)} of decompose fee.`
            ),
            line(
                'Time per fruit',
                `${(loop.hoursPerFruit * 3600).toFixed(1)}s`,
                COLORS.textDim,
                'Forage, decompose and coinify all run from the same queue, one at a time.'
            ),
            line(
                'Split',
                `forage ${formatPercentage(loop.timeShare.forage, 0)} · ` +
                    `decompose ${formatPercentage(loop.timeShare.decompose, 0)} · ` +
                    `coinify ${formatPercentage(loop.timeShare.coinify, 0)}`,
                COLORS.textDim
            ),
            line('Alchemy fees / hour', coins(loop.alchemyFeePerHour), COLORS.bad, 'What the buffer is for.')
        );

        holder.appendChild(
            span(loop.basis?.note || '', {
                display: 'block',
                color: COLORS.textDim,
                fontSize: '11px',
                marginTop: '3px',
            })
        );
        return holder;
    }

    /**
     * What that gold buys in bells.
     * @returns {HTMLElement} The card
     */
    _bellsCard() {
        const holder = card('Cowbells');
        const loop = this.loop;

        const pricing = loop?.bellPricing || cowbellPricing();
        if (!pricing.price) {
            holder.appendChild(span('No market price for a cowbell yet.', { color: COLORS.warn }));
            return holder;
        }

        holder.appendChild(
            line(
                'Per bell',
                coins(pricing.price),
                COLORS.text,
                `Cheaper of loose (${coins(pricing.loose)}) and by the bag (${coins(pricing.bag)} each). ` +
                    `Priced at ${pricing.pricingMode}.`
            )
        );
        holder.appendChild(
            line(
                'Buy them',
                pricing.source === 'bag' ? 'in bags of ten' : 'loose',
                COLORS.good,
                'Bags are not always ten times the loose price.'
            )
        );

        if (!loop || loop.missing?.length || !loop.bells) {
            holder.appendChild(
                span('Cost the loop to see what it earns in bells.', {
                    display: 'block',
                    color: COLORS.textDim,
                    marginTop: '3px',
                })
            );
            return holder;
        }

        holder.append(
            line('Bells / hour', bells(loop.bells.perHour), COLORS.good),
            line('Bells / day', bells(loop.bells.perDay), COLORS.good, '24 hours of the loop.'),
            line('A week of this', `${bells(loop.bells.perWeek)} bells`, COLORS.good, '168 hours of the loop.')
        );

        const offline = offlineWindow();
        const dutyCycle = Math.min(1, offline.hours / 24);
        holder.appendChild(
            line(
                `Realistic / day (${offline.hours}h queued)`,
                bells(loop.bells.perDay * dutyCycle),
                COLORS.text,
                offline.assumed
                    ? 'Assumes you log in once a day and the queue runs dry after the offline window.'
                    : 'Your offline window, once a day.'
            )
        );

        holder.appendChild(
            span(`Pricing mode: ${loop.pricingMode}.`, {
                display: 'block',
                color: COLORS.textDim,
                fontSize: '11px',
                marginTop: '3px',
            })
        );
        return holder;
    }

    /**
     * How many of each action to queue, and a walk that puts you in front of
     * each one.
     *
     * The panel already told the player to queue all three actions and to cover
     * their offline window; this is that advice as three numbers they can type,
     * balanced so each leg eats what the leg before it grew. The duration and
     * the cowbell target are the same figure said two ways, and each fills the
     * other in.
     *
     * @returns {HTMLElement} The card
     */
    _queueCard() {
        const holder = card('Queue helper');
        const loop = this.loop;

        if (!loop || loop.missing?.length) {
            holder.appendChild(span('Cost the loop to size a batch.', { color: COLORS.textDim }));
            return holder;
        }

        const hasBellPrice = Number.isFinite(loop.bellPrice) && loop.bellPrice > 0;
        const batch = balanceBatch(loop, this.batchHours);
        if (!batch) {
            holder.appendChild(span('This loop cannot be sized into a batch.', { color: COLORS.warn }));
            return holder;
        }

        const hoursBox = numberBox(round1(this.batchHours), (raw) => this._setBatchHours(Number(raw), 'hours'));
        const unit = document.createElement('select');
        for (const [value, label] of [
            ['h', 'hours'],
            ['d', 'days'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            unit.appendChild(option);
        }
        Object.assign(unit.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
        });
        unit.value = this.batchUnit || 'h';
        unit.addEventListener('change', () => {
            this.batchUnit = unit.value;
            hoursBox.value = String(round1(this.batchUnit === 'd' ? this.batchHours / HOURS_PER_DAY : this.batchHours));
        });

        const durationRow = document.createElement('div');
        Object.assign(durationRow.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });
        durationRow.append(span('Queue for', { color: COLORS.textDim }), hoursBox, unit);
        for (const preset of QUEUE_PRESETS) {
            durationRow.appendChild(button(preset.label, () => this._setBatchHours(preset.hours, 'preset')));
        }
        holder.appendChild(durationRow);

        const bellsBox = numberBox(hasBellPrice ? Math.round(bellsForHours(loop, this.batchHours) || 0) : '', (raw) =>
            this._setBatchBells(Number(raw))
        );
        const bellsRow = document.createElement('div');
        Object.assign(bellsRow.style, { display: 'flex', gap: '6px', alignItems: 'center' });
        bellsRow.append(span('or bells', { color: COLORS.textDim }), bellsBox);
        holder.appendChild(bellsRow);

        if (!hasBellPrice) {
            // Never a blank box or a zero that reads as a real target: an empty
            // field the player can type into is a promise the panel cannot keep
            // without a price to convert at.
            bellsBox.disabled = true;
            bellsBox.value = '';
            bellsBox.placeholder = '—';
            bellsBox.style.opacity = '0.5';
            bellsBox.title = 'No market price for a cowbell yet.';
            holder.appendChild(
                span('No cowbell price yet, so a bell target cannot be worked back — the duration still can.', {
                    display: 'block',
                    color: COLORS.warn,
                    fontSize: '11px',
                })
            );
        }

        const counts = document.createElement('div');
        counts.style.marginTop = '3px';
        holder.appendChild(counts);

        const summary = span('', { display: 'block', color: COLORS.textDim, fontSize: '11px' });
        holder.appendChild(summary);

        const walk = button('Walk it — three actions, one press each', () => this._walkQueue());
        walk.style.marginTop = '4px';
        walk.style.alignSelf = 'flex-start';
        walk.title =
            'Opens each action in turn and types the count into the game\u2019s own box. ' +
            'It never presses anything — the press that queues each action is yours.';
        holder.appendChild(walk);

        this.queueRefs = { hoursBox, unit, bellsBox, counts, summary, hasBellPrice };
        this._drawBatch(batch);
        return holder;
    }

    /**
     * Redraw the three counts and the summary, without rebuilding the fields the
     * player may be typing in.
     * @param {Object} batch - From `balanceBatch`
     * @private
     */
    _drawBatch(batch) {
        const refs = this.queueRefs;
        if (!refs) return;
        const loop = this.loop;
        const fruit = loop?.items?.starfruitName || 'Star Fruit';
        const essence = loop?.items?.essenceName || 'essence';

        refs.counts.replaceChildren(
            line('Forage', formatWithSeparator(batch.forageActions), COLORS.good, `Grows the ${fruit}.`),
            line(
                'Decompose',
                formatWithSeparator(batch.decomposeActions),
                COLORS.good,
                `Sized to the ${formatWithSeparator(Math.floor(batch.fruit))} ${fruit} the forage leg yields.`
            ),
            line(
                'Coinify',
                formatWithSeparator(batch.coinifyActions),
                COLORS.good,
                `Sized to the ${formatWithSeparator(Math.floor(batch.essence))} ${essence} the decompose leg yields, ` +
                    `${loop?.coinifyBulk || 1} to an action.`
            )
        );

        const earns = batch.bells === null ? '' : ` · about ${bells(batch.bells)} bells`;
        refs.summary.textContent = `Keeps the queue busy about ${round1(batch.hours)}h${earns}.`;
    }

    /**
     * Move the batch to a new duration and bring everything else with it.
     * @param {number} hours - The new duration, in hours
     * @param {'hours'|'bells'|'preset'} source - Which field the player touched
     * @private
     */
    _setBatchHours(hours, source) {
        if (!Number.isFinite(hours) || hours <= 0) return;
        const inDays = source === 'hours' && this.batchUnit === 'd';
        this.batchHours = Math.min(MAX_QUEUE_HOURS, inDays ? hours * HOURS_PER_DAY : hours);

        const refs = this.queueRefs;
        const batch = balanceBatch(this.loop, this.batchHours);
        if (!refs || !batch) return;

        // The field the player is typing in is left alone; the other two follow.
        if (source !== 'hours') {
            refs.hoursBox.value = String(
                round1(this.batchUnit === 'd' ? this.batchHours / HOURS_PER_DAY : this.batchHours)
            );
        }
        if (source !== 'bells' && refs.hasBellPrice) {
            refs.bellsBox.value = String(Math.round(bellsForHours(this.loop, this.batchHours) || 0));
        }
        this._drawBatch(batch);
    }

    /**
     * Work a cowbell target back into a duration.
     * @param {number} target - Bells wanted
     * @private
     */
    _setBatchBells(target) {
        const hours = hoursForBells(this.loop, target);
        if (hours === null) return;
        this._setBatchHours(hours, 'bells');
    }

    /**
     * Hand the current batch to the guided walk.
     * @private
     */
    _walkQueue() {
        const batch = balanceBatch(this.loop, this.batchHours);
        if (!startQueueWalk(this.loop, batch)) {
            this._status('Nothing to walk — cost the loop first.');
        }
    }

    /**
     * What is wrong with the loop as it is set up right now.
     * @param {Object|null} state - Character state
     * @returns {HTMLElement} The card
     */
    _checksCard(state) {
        const holder = card('Check');
        if (!state) {
            holder.appendChild(span('No character state to check.', { color: COLORS.textDim }));
            return holder;
        }

        holder.appendChild(line('Gold', coins(state.coins), state.coins > 0 ? COLORS.text : COLORS.bad));
        holder.appendChild(line('Queued actions', String(state.queueLength), COLORS.text));

        for (const warning of loopWarnings(state, this.loop)) {
            holder.appendChild(
                span(`${warning.severity === 'warn' ? '⚠' : 'ℹ'} ${warning.text}`, {
                    display: 'block',
                    color: warning.severity === 'warn' ? COLORS.warn : COLORS.textDim,
                    fontSize: '11px',
                    marginTop: '3px',
                })
            );
        }
        return holder;
    }
}

export const ironCowFarmPanel = new IronCowFarmPanel();
export default ironCowFarmPanel;
