/**
 * Combat panels
 *
 * The four combat tiles, opened up.
 *
 * Each of DPS, Deaths/hr, Drop Luck and Combat Revenue is one number on a tile,
 * and one number is the summary of something with parts. A DPS figure does not
 * say whether you are winning the exchange; a deaths-per-hour figure does not
 * say when the last one was; a luck percentile does not say how many coins the
 * verdict is about; a profit figure does not say which side of it moved.
 *
 * ## Why one module
 *
 * Four panels that read four existing collectors and do no arithmetic of their
 * own. They share a shell — header, body, drag, resize, remembered geometry —
 * because four copies of that is four places for a panel to open somewhere you
 * cannot reach it.
 *
 * Nothing here computes anything the tiles do not already compute. If a panel
 * and its tile ever disagree, the disagreement is in the collector.
 *
 * The panels correspond to DPs, IHurt, LYuck and HWhat from MWI Combat Suite by
 * Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import combatDPS from '../../features/combat/combat-dps.js';
import combatStatsDataCollector from '../../features/combat-stats/combat-stats-data-collector.js';
import { calculatePlayerStats } from '../../features/combat-stats/combat-stats-calculator.js';
import { salesTaxNetted, setSalesTaxNetted } from '../../features/combat-stats/sales-tax-view.js';
import {
    damageBreakdown,
    actionLabel,
    isFilteringNonDamaging,
    setFilterNonDamaging,
    resetDamageTracker,
} from '../../features/combat/damage-tracker.js';
import { takenBreakdown } from '../../features/combat/damage-taken-tracker.js';
import { primeRecordTarget, recordControlState, toggleRecording } from '../../features/combat/combat-record-control.js';
import { formatWithSeparator, formatKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { getItemPrices } from '../../utils/market-data.js';
import { expectedKills, killComparison } from '../../utils/expected-kills.js';
import { loadAllZonesSnapshot, bestSoloZone, zoneFromSnapshot } from '../../utils/all-zones-snapshot.js';
import { partyLintWarnings, battleLintInputs } from '../../utils/party-lint.js';
import { abilityBreakdownRows, abilityDamageText, abilityRateText } from '../../utils/damage-board.js';

const REFRESH_MS = 2000;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(24, 24, 34, 0.9)',
    border: 'rgba(150, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#8fb4ff',
};

/**
 * The current player's slice of the combat statistics.
 * @returns {Object|null}
 */
function runSeconds(data) {
    let duration = data?.durationSeconds || 0;
    if (data?.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }
    return duration;
}

/**
 * The current player's statistics, costed.
 *
 * Through `calculatePlayerStats`, which is where `dailyIncome`, `dailyProfit`
 * and the cost figures are produced — the raw player carries none of them. The
 * Profit panel first shipped reading the raw player and showed a column of
 * zeroes for it, which is what a missing field looks like when every branch
 * defaults to nought.
 *
 * @returns {Object|null}
 */
function playerStats() {
    const data = combatStatsDataCollector.getLatestData?.();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    const duration = runSeconds(data);
    return { ...calculatePlayerStats(player, duration), duration, encounters: data.totalEncounters || 0 };
}

/**
 * Everybody's figures, not just yours.
 *
 * The rest of this panel answers "what is this run worth to me", which is one
 * character's question. In a party it is also worth asking who is actually
 * being paid — five people splitting a zone do not split it evenly, because
 * loot is rolled per character against their own drop gear.
 *
 * The calculator has always been able to do this; the panel only ever asked it
 * about one player.
 *
 * @returns {Array<Object>} Stats per player, yours first
 */
function partyStats() {
    const data = combatStatsDataCollector.getLatestData?.();
    const players = data?.players || [];
    if (players.length < 2) return [];

    const duration = runSeconds(data);
    return players
        .map((player) => ({
            ...calculatePlayerStats(player, duration),
            name: player.name || player.characterName || 'Unknown',
            isCurrentPlayer: Boolean(player.isCurrentPlayer),
        }))
        .sort((a, b) => Number(b.isCurrentPlayer) - Number(a.isCurrentPlayer));
}

/**
 * What each character is earning, in whichever case the panel is showing.
 *
 * Revenue beside profit rather than profit alone: in a dungeon the two are very
 * far apart, because the keys are bought up front and the chests only pay at
 * the end, and a profit figure on its own makes a run look like a disaster
 * until the moment it does not.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {string} mode - Which of the four cases is selected
 * @param {number} tax - The MooPass, per day, or zero
 */
function drawPartyProfit(body, mode, tax) {
    const party = partyStats();
    if (!party.length) return;

    const card_ = card(body, 'Per player');
    const dungeon = party.some((player) => player.isDungeonRun);

    for (const player of party) {
        const cases = profitCases(player);
        const scenario = cases.find((entry) => entry.key === mode) || cases[1];
        const profit = scenario.revenue - (profitView.costsOn ? scenario.cost : 0) - tax;

        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto auto',
            gap: '10px',
            alignItems: 'baseline',
            fontVariantNumeric: 'tabular-nums',
        });

        const name = piece(player.name, player.isCurrentPlayer ? ROW_COLORS.gold : COLORS.text);
        if (player.isCurrentPlayer) name.style.fontWeight = 'bold';
        Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

        row.append(
            name,
            piece(`${formatKMB(scenario.revenue)}/day`, ROW_COLORS.good),
            piece(`${formatKMB(profit)}/day`, profit >= 0 ? ROW_COLORS.good : ROW_COLORS.bad)
        );
        row.title =
            `${player.name}: ${scenario.equation}.\n` +
            `Revenue ${formatWithSeparator(Math.round(scenario.revenue))}/day, ` +
            `cost ${formatWithSeparator(Math.round(scenario.cost))}/day.`;
        card_.appendChild(row);
    }

    card_.appendChild(
        note(
            dungeon
                ? 'Loot is rolled per character against their own drop gear, so a party does not split a zone ' +
                      'evenly. In a dungeon the chests are counted at their expected value, and the keys are ' +
                      'charged when the chest drops — so a run reads as a loss until it pays out.'
                : 'Loot is rolled per character against their own drop gear, so a party does not split a zone evenly.'
        )
    );

    if (dungeon) drawSoloComparison(card_, party, mode, tax);
}

/**
 * The last all-zones sim, cached for the panel's synchronous redraws.
 *
 * `undefined` means never asked, `null` means asked and nothing stored. The
 * load is kicked off on first draw and the line appears on the next refresh —
 * the panel redraws every couple of seconds, so nobody waits on it.
 */
let soloSnapshot;

/**
 * Whose sim run {@link soloSnapshot} holds.
 *
 * The snapshot is stored per character, so it must not outlive the character it
 * was loaded for. Nothing in this module is torn down on a switch, so without
 * this the cache is a one-shot: the first character to open the profit panel
 * owns the "solo comparison" and the "sim said here" lines for the rest of the
 * session.
 */
let soloSnapshotOwner;

/**
 * The cached snapshot, kicking off the one load on the first ask.
 *
 * A load is restarted whenever the character has moved on, and one already in
 * flight is discarded on arrival if the player has left in the meantime —
 * caching one character's simulated profit under another's name is worse than
 * drawing no line at all, because the line reads as a verdict on this
 * character's gear.
 * @returns {Object|null} The snapshot, or null until the load lands
 */
function cachedSnapshot() {
    const owner = dataManager.getCurrentCharacterId?.() ?? null;
    if (soloSnapshot === undefined || soloSnapshotOwner !== owner) {
        soloSnapshot = null;
        soloSnapshotOwner = owner;
        loadAllZonesSnapshot()
            .then((snapshot) => {
                if (soloSnapshotOwner !== owner) return;
                soloSnapshot = snapshot;
            })
            .catch(() => {});
    }
    return soloSnapshot;
}

/**
 * What the same hours would earn solo, next to what the dungeon is measuring.
 *
 * The opportunity-cost line: your best solo zone's simulated profit against
 * your own measured share of the dungeon. Simulated against measured is an
 * honest comparison only when it says so, so the line names the zone, marks
 * the figure as simulated, and dates the run it came from — a snapshot from
 * last week's gear is context, not a verdict.
 *
 * @param {HTMLElement} card_ - The per-player card, appended to
 * @param {Array<Object>} party - From `partyStats`
 * @param {string} mode - The profit scenario key in force
 * @param {number} tax - The MooPass share subtracted from each profit figure
 */
function drawSoloComparison(card_, party, mode, tax) {
    const isDungeonZone = (zoneHrid) => dataManager.getActionDetails?.(zoneHrid)?.combatZoneInfo?.isDungeon === true;
    const best = bestSoloZone(cachedSnapshot(), { isDungeonZone });
    if (!best) return;

    const you = party.find((player) => player.isCurrentPlayer);
    if (!you) return;
    const cases = profitCases(you);
    const scenario = cases.find((entry) => entry.key === mode) || cases[1];
    const yours = scenario.revenue - (profitView.costsOn ? scenario.cost : 0) - tax;

    const soloPerDay = best.profitPerHour * 24;
    const ahead = yours >= soloPerDay;
    const aged = best.savedAt ? ` on ${new Date(best.savedAt).toLocaleDateString()}` : '';

    const line_ = line(
        'vs best solo (sim)',
        `${best.zoneName} · ${formatKMB(soloPerDay)}/day`,
        ahead ? COLORS.textDim : ROW_COLORS.bad,
        `Your best solo zone in the last all-zones sim, simulated${aged} — against your measured ` +
            `${formatKMB(yours)}/day here. A simulated figure beside a measured one: the sim knows nothing ` +
            'about this run, and a snapshot from older gear understates what solo would earn now.'
    );
    card_.appendChild(line_);
}

/**
 * What the sim promised for the very zone being measured.
 *
 * Beside the measured revenue, the last all-zones run's figure for this zone
 * at this tier — the one comparison that says whether the run is living up to
 * its forecast. Same honesty rules as the solo line: dated, marked simulated,
 * and the tooltip says outright that the sim knows nothing about this run.
 * Nothing is drawn unless the snapshot holds exactly this zone and tier — a
 * neighbouring tier's figure would be a comparison of nothing.
 *
 * It sits at the foot of the panel, in its own dim card, not in the headline:
 * the number the panel is *for* is the live measured rate, and a simulated
 * figure from another day should not compete with it for the eye.
 *
 * @param {HTMLElement} body - The panel body; a small card is added only when
 *   there is a forecast to show
 */
function drawSimHere(body) {
    const action = dataManager
        .getCurrentActions?.()
        ?.find((entry) => entry.actionHrid?.startsWith('/actions/combat/') && !entry.isDone);
    if (!action) return;

    const row = zoneFromSnapshot(cachedSnapshot(), action.actionHrid, action.difficultyTier || 0);
    if (!row) return;

    const card_ = card(body);
    const perDay = row.profitPerHour * 24;
    const dated = row.savedAt ? new Date(row.savedAt).toLocaleDateString() : null;
    const ageDays = row.savedAt ? Math.max(0, Math.round((Date.now() - row.savedAt) / 86_400_000)) : null;

    card_.appendChild(
        line(
            'sim said here',
            `${formatKMB(perDay)}/day · simulated${dated ? ` ${dated}` : ', undated'}`,
            COLORS.textDim,
            `The last all-zones sim's figure for ${row.zoneName}` +
                (row.difficultyTier ? ` at tier ${row.difficultyTier}` : '') +
                (dated ? `, from a run saved ${dated}` : ', from an undated run') +
                (ageDays !== null
                    ? ` — ${ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`}`
                    : '') +
                '. A simulated figure beside a measured one: the sim knows nothing about this run, its party or ' +
                'its luck, and a snapshot from older gear or prices does not describe today.'
        )
    );
}

/**
 * One panel, built from a function that fills its body.
 *
 * The shell is shared so a panel cannot open off-screen in one place and not
 * another, and so "remembered where I left it" is true of all four.
 */
class CombatPanel {
    /**
     * @param {Object} definition - What makes this panel itself
     * @param {string} definition.id - DOM id and geometry key
     * @param {string} definition.title - Header text
     * @param {{width: number, height: number}} definition.size - Opening size
     * @param {Function} definition.draw - `(body) => void`, called on every refresh
     * @param {Function} [definition.controls] - `(bar) => void`, header buttons,
     *   redrawn with the body so a toggle shows the state it is actually in
     */
    constructor({ id, title, size, minSize, draw, controls }) {
        this.id = id;
        this.title = title;
        this.size = size;
        // A table has a width below which it is no longer a table, and a panel
        // remembers whatever it was last dragged to — including a width set
        // before it held a table at all
        this.minSize = minSize || { width: 300, height: 180 };
        this.draw = draw;
        this.controls = controls;
        this.panel = null;
        this.refreshId = null;
    }

    show({ remember = true } = {}) {
        if (remember) saveOpenState(this.id, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    /**
     * Reopen if the page was left with this panel up.
     *
     * Called once per panel at module scope. Fire and forget — a storage read
     * has no business holding up the library load, and a panel appearing a
     * moment after the page is exactly what a remembered panel looks like.
     */
    restore() {
        reopenIfLeftOpen(this.id, () => this.show({ remember: false }));
    }

    hide({ remember = true } = {}) {
        if (remember) saveOpenState(this.id, false);
        clearInterval(this.refreshId);
        this.refreshId = null;
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
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = `toolasha-${this.id}-panel`;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '160px',
            left: '150px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${this.size.width}px, 92vw)`,
            height: panelHeightCap(this.size.height),
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

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = this.title;
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;
        title.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });
        // Between the title and the close button, as HWhat has them
        this.controlsEl = document.createElement('div');
        Object.assign(this.controlsEl.style, { display: 'flex', gap: '4px', marginRight: '6px' });
        // The bar is part of the header, which drags — a button that drags the
        // panel instead of pressing is a button that reads as broken
        this.controlsEl.addEventListener('mousedown', (event) => event.stopPropagation());

        header.append(title, this.controlsEl, close);
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: this.bodyEl,
            panelKey: this.id,
            beforeEl: close,
            defaultHeight: this.size.height,
            accent: COLORS.text,
        });

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(this.id, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: this.minSize.width,
            minHeight: this.minSize.height,
            onResize: (size) => saveGeometry(this.id, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, this.id, this.minSize);

        // A remembered width from before this panel held a table is a width the
        // table cannot be read at, and nothing else would ever widen it again
        if (parseFloat(this.panel.style.width) < this.minSize.width) {
            this.panel.style.width = `${this.size.width}px`;
        }

        this._render();
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            this._render();
        }, REFRESH_MS);
    }

    /** Redraw now rather than on the next tick, after a control is pressed */
    refresh() {
        this._render();
    }

    _render() {
        if (!this.bodyEl) return;

        if (this.controls && this.controlsEl) {
            this.controlsEl.replaceChildren();
            try {
                this.controls(this.controlsEl);
            } catch (error) {
                console.error(`[CombatPanels] ${this.title} controls could not be drawn:`, error);
            }
        }

        // Drawn into a detached scratch box and swapped in only when the
        // markup actually changed: the tick rebuilds every open panel once per
        // REFRESH_MS, and out of combat (or on a quiet panel) that was a full
        // teardown, rebuild, and layout for pixels identical to the ones on
        // screen. Comparing serialised markup costs microseconds against that.
        // Controls are exempt above — they hold focusable inputs whose state
        // is not in their markup.
        //
        // One panel that cannot be drawn says so rather than showing an empty
        // box, which reads as a feature that has nothing to report
        const scratch = document.createElement('div');
        try {
            this.draw(scratch);
        } catch (error) {
            console.error(`[CombatPanels] ${this.title} could not be drawn:`, error);
            scratch.appendChild(note(`This could not be drawn: ${error.message}`, ROW_COLORS.bad));
        }
        if (scratch.innerHTML === this.bodyEl.innerHTML) return;
        this.bodyEl.replaceChildren(...scratch.childNodes);
    }
}

/**
 * @param {string} text - What to say
 * @param {string} [color] - Ink
 * @returns {HTMLElement}
 */
function note(text, color = COLORS.textDim) {
    const element = document.createElement('div');
    element.textContent = text;
    element.style.color = color;
    return element;
}

/**
 * A labelled figure on its own line.
 *
 * @param {string} label - What it is
 * @param {string} value - What it says
 * @param {string} [color] - Ink for the value
 * @param {string} [title] - Tooltip
 * @returns {HTMLElement}
 */
function line(label, value, color = COLORS.text, title = '') {
    const element = document.createElement('div');
    Object.assign(element.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });

    const name = document.createElement('span');
    name.textContent = label;
    name.style.color = COLORS.textDim;
    name.style.flex = '1';

    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.color = color;
    figure.style.whiteSpace = 'nowrap';

    if (title) element.title = title;
    element.append(name, figure);
    return element;
}

/**
 * A titled block.
 * @param {HTMLElement} body - Where it goes
 * @param {string} title - Heading
 * @returns {HTMLElement} The card, to append lines to
 */
function card(body, title) {
    const element = document.createElement('div');
    Object.assign(element.style, {
        background: COLORS.card,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '6px',
        padding: '7px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    });

    if (title) {
        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, { color: COLORS.accent, fontWeight: 'bold', marginBottom: '3px' });
        element.appendChild(heading);
    }
    body.appendChild(element);
    return element;
}

/**
 * Which rows are open, kept between redraws.
 *
 * In the DOM it would be lost every two seconds when the panel repaints, which
 * is a row that closes itself while you are reading it.
 */
const expandedRows = new Set([
    // IHurt's two sections open by default, as MCS has them. They are the panel
    // rather than an appendix to it — collapsed, opening the panel shows two
    // banners and a card and nothing about what is doing the hitting.
    'hurt:enemies',
    'hurt:waves',
    'hurt:kills',
]);

/**
 * The table's columns, proportional rather than fixed.
 *
 * Fixed pixels add up to more than a panel somebody has narrowed, and the
 * column that pays for it is the first one — so the name, which is the only
 * cell you cannot infer from context, becomes "Mi…". Proportions share the
 * squeeze out instead, and the minimums stop any column collapsing to nothing.
 */
const DPS_COLUMNS =
    'minmax(72px, 1.7fr) minmax(38px, 0.7fr) minmax(74px, 1.35fr) ' +
    'minmax(32px, 0.55fr) minmax(62px, 1.05fr) minmax(58px, 1fr) minmax(58px, 1fr)';

/**
 * One line of the damage table.
 *
 * A grid rather than a flex row: the columns have to line up between the player
 * row and the ability rows underneath it, and a table that does not line up is
 * a table you read one cell at a time.
 *
 * @param {Array<{text: string, color?: string, bold?: boolean, align?: string}>} cells - Seven of them
 * @param {Object} [options] - `{dim, indent}`
 * @returns {HTMLElement}
 */
function dpsRow(cells, { dim = false, indent = 0 } = {}) {
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: DPS_COLUMNS,
        gap: '4px',
        alignItems: 'center',
        padding: '2px 0',
        fontSize: dim ? '10.5px' : '11.5px',
        // Digits of one width, so a column of figures reads as a column rather
        // than as a ragged edge that shifts every time a number changes
        fontVariantNumeric: 'tabular-nums',
    });

    cells.forEach((cell, index) => {
        const span = document.createElement('span');
        span.textContent = cell.text;
        // A cell that has been ellipsised is still worth reading, and the name
        // column is the one that truncates first and matters most
        span.title = cell.text;
        Object.assign(span.style, {
            color: cell.color || (dim ? COLORS.textDim : COLORS.text),
            fontWeight: cell.bold ? 'bold' : 'normal',
            textAlign: index === 0 ? 'left' : 'right',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            paddingLeft: index === 0 ? `${indent}px` : '0',
        });
        row.appendChild(span);
    });
    return row;
}

/**
 * A count with its share of the attempts, as MCS writes them: `193 (78.8%)`.
 *
 * The bare count says nothing without the attempts it came from, and the bare
 * percentage hides how few swings it was computed over.
 *
 * @param {number} count - How many
 * @param {number} outOf - Of how many
 * @returns {string}
 */
function countAndShare(count, outOf) {
    // Rounded at the last moment: a tick shared between several actors carries a
    // fractional swing, and the ledger keeps the fraction so the sum stays exact
    const whole = Math.round(count || 0);
    if (!(outOf > 0)) return formatWithSeparator(whole);
    return `${formatWithSeparator(whole)} (${((count / outOf) * 100).toFixed(1)}%)`;
}

/**
 * The damage-over-time share of a row, for a tooltip.
 *
 * Bleeds and reflects move a monster's health without moving its hit counter,
 * so they carry no swing, no crit and no ability — they are inside the damage
 * figure and invisible in every column beside it. Saying so is the difference
 * between a row that looks miscounted and one that explains itself.
 *
 * @param {Object} row - Anything carrying `damage` and `dotDamage`
 * @returns {string} A sentence with a trailing newline, or nothing
 */
function dotNote(row) {
    const dot = Number(row?.dotDamage) || 0;
    if (!(dot > 0)) return '';
    const share = row.damage > 0 ? ` (${((dot / row.damage) * 100).toFixed(1)}% of it)` : '';
    return `Damage incl. ${formatKMB(dot)} DoT/reflect${share} — no swing, crit or ability behind it.\n`;
}

/**
 * DPs' second reading of the same run: what the corpses say.
 *
 * The table measures attributed hits, and attribution has holes — a bleed, a
 * tick before the counters were known, a fight where two people cast together.
 * The health bars do not: a monster is dead or it is not, and its bar was worth
 * exactly what it was worth. So the same run gets a second figure that cannot
 * drift, and where the two disagree the difference is what attribution missed.
 *
 * It is quoted twice, as DPs quotes it. Against **battle time** it says how
 * hard the party hits; against **total time** it says what the run actually
 * produced, and the gap between them is time spent walking rather than
 * fighting. No rotation fixes that gap — a zone with a shorter respawn does.
 *
 * @param {Object} breakdown - From `damageBreakdown`
 * @returns {HTMLElement}
 */
function enemyHealthCard(breakdown) {
    const holder = document.createElement('div');
    Object.assign(holder.style, {
        border: `1px solid ${ROW_COLORS.gold}`,
        borderRadius: '6px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: 'rgba(255, 214, 102, 0.04)',
    });

    const killed = breakdown.enemies.filter((enemy) => enemy.kills > 0 && enemy.maxHP > 0);

    const title = document.createElement('div');
    title.textContent = 'DPS based off enemy HPs';
    Object.assign(title.style, { color: ROW_COLORS.gold, fontWeight: 'bold' });

    if (!killed.length) {
        holder.append(title, note('Nothing has died yet, so there are no health bars to count.'));
        return holder;
    }

    const health = killed.reduce((sum, enemy) => sum + enemy.kills * enemy.maxHP, 0);
    const kills = killed.reduce((sum, enemy) => sum + enemy.kills, 0);
    const battleTime = breakdown.seconds;
    const totalTime = Math.max(breakdown.logging, battleTime);

    const totalDPS = totalTime > 0 ? health / totalTime : null;
    const battleDPS = battleTime > 0 ? health / battleTime : null;

    // Title on the left, the three figures on the right, as DPs arranges them —
    // the caption under each is what makes three similar numbers legible
    const heading = document.createElement('div');
    Object.assign(heading.style, {
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: '10px',
        flexWrap: 'wrap',
    });
    const figures = document.createElement('div');
    Object.assign(figures.style, { display: 'flex', gap: '14px', marginLeft: 'auto' });
    figures.append(
        bigFigure(totalDPS, 'total time DPS', ROW_COLORS.gold),
        bigFigure(battleDPS, 'battle time DPS', ROW_COLORS.gold),
        bigFigure(
            totalDPS === null || battleDPS === null ? null : battleDPS - totalDPS,
            'DPS loss between battles',
            ROW_COLORS.bad
        )
    );
    heading.append(title, figures);
    holder.appendChild(heading);
    holder.appendChild(note('Based on enemy max HP only.'));

    // One strip rather than four rows: they are the inputs to the figures
    // above, and a column of labels reads as if they were findings themselves
    const strip = document.createElement('div');
    Object.assign(strip.style, {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 16px',
        fontSize: '11px',
        color: COLORS.textDim,
        borderTop: `1px solid ${COLORS.hairline}`,
        paddingTop: '5px',
    });
    strip.append(
        statPair('Time logging', timeReadable(Math.round(totalTime)), ROW_COLORS.good),
        statPair('Time in battle', timeReadable(Math.round(battleTime)), ROW_COLORS.good),
        statPair('Total health destroyed', formatKMB(health), ROW_COLORS.good),
        statPair('Total enemies killed', formatWithSeparator(kills), COLORS.text)
    );
    holder.appendChild(strip);

    // Two to a row, each its own tile, as DPs draws them. A flat list of four
    // similar sentences is read one at a time; a grid is read at a glance.
    const grid = document.createElement('div');
    Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '6px',
    });
    for (const enemy of killed) grid.appendChild(enemyTile(enemy));
    holder.appendChild(grid);

    holder.appendChild(
        note(
            'Counted from full health bars rather than from attributed hits, so it does not drift where ' +
                'attribution cannot see — a bleed, or a tick before the counters were known.'
        )
    );
    return holder;
}

/**
 * One of the three headline figures, with the caption that tells them apart.
 *
 * @param {number|null} value - The figure
 * @param {string} caption - What it is
 * @param {string} color - Ink
 * @returns {HTMLElement}
 */
function bigFigure(value, caption, color) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { textAlign: 'right' });

    const figure = document.createElement('div');
    figure.textContent = value === null ? '—' : value.toFixed(1);
    Object.assign(figure.style, { color, fontSize: '17px', fontWeight: 'bold', lineHeight: '1.2' });

    const label = document.createElement('div');
    label.textContent = caption;
    Object.assign(label.style, { color: COLORS.textDim, fontSize: '10px', fontStyle: 'italic' });

    wrap.append(figure, label);
    return wrap;
}

/**
 * A label and its figure, side by side, for the strip under the headline.
 *
 * @param {string} label - What it is
 * @param {string} value - The figure
 * @param {string} color - Ink for the figure
 * @returns {HTMLElement}
 */
function statPair(label, value, color) {
    const wrap = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = `${label}: `;
    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.color = color;
    figure.style.fontWeight = 'bold';
    wrap.append(name, figure);
    return wrap;
}

/**
 * What one kind of monster contributed, as its own tile.
 *
 * Named and priced, because "fifty kills" is a different run depending on
 * whether they were rats or bosses.
 *
 * @param {Object} enemy - From `damageBreakdown`
 * @returns {HTMLElement}
 */
function enemyTile(enemy) {
    const tile = document.createElement('div');
    Object.assign(tile.style, {
        borderLeft: `3px solid ${ROW_COLORS.bad}`,
        borderRadius: '4px',
        background: 'rgba(248, 113, 113, 0.08)',
        padding: '4px 8px',
    });

    const name = document.createElement('div');
    name.textContent = enemy.name;
    Object.assign(name.style, { color: ROW_COLORS.bad, fontWeight: 'bold', fontSize: '11.5px' });

    const sum = document.createElement('div');
    sum.textContent =
        `${formatWithSeparator(enemy.kills)} kills × ${formatKMB(enemy.maxHP)} HP = ` +
        `${formatKMB(enemy.kills * enemy.maxHP)}`;
    Object.assign(sum.style, { color: COLORS.textDim, fontSize: '10.5px' });

    tile.append(name, sum);
    return tile;
}

/**
 * Loadout mistakes in the party on screen, as the sim lints a loaded one.
 *
 * The same two checks the Combat Sim runs before a party simulation — skilling
 * gear in a combat slot, the same aura equipped twice — fired on the live
 * roster instead of a loaded one. `new_battle` carries every player's equipped
 * kit whole, so the aura check covers the whole party; it carries nobody's
 * wearables, so the gear check covers only the current player, whose equipment
 * the client tracks itself — and the block says so rather than staying quiet
 * about four unchecked loadouts. Parties of one draw nothing: solo, both
 * checks are moot.
 *
 * Same amber treatment as the sim's own warnings block, because it is the same
 * warning about the same mistake.
 *
 * @param {HTMLElement} body - Where it goes
 */
function drawPartyLint(body) {
    if (!config.getSetting('partyLint_live', true)) return;

    const battle = dataManager.battleData;
    if (!Array.isArray(battle?.players) || battle.players.length < 2) return;

    const clientData = dataManager.getInitClientData?.() || {};
    const { playerDTOs, playerInfo } = battleLintInputs(battle, {
        currentCharacterId: dataManager.getCurrentCharacterId?.(),
        ownEquipment: [...(dataManager.characterEquipment?.values?.() || [])],
        itemDetailMap: clientData.itemDetailMap || {},
    });

    const warnings = partyLintWarnings(playerDTOs, playerInfo, clientData);
    if (!warnings.length) return;

    const block = document.createElement('div');
    Object.assign(block.style, {
        border: '1px solid #6b5a1f',
        background: 'rgba(255, 200, 60, 0.08)',
        borderRadius: '4px',
        padding: '6px 8px',
        fontSize: '11px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    });
    for (const warning of warnings) block.appendChild(note(`⚠ ${warning}`, '#e8c66c'));
    block.appendChild(
        note(
            'The battle payload carries abilities for the whole party but equipment for nobody, so gear is ' +
                'checked for you only.'
        )
    );
    body.appendChild(block);
}

export const dpsPanel = new CombatPanel({
    id: 'dpsPanel',
    title: 'DPs',
    size: { width: 620, height: 460 },
    minSize: { width: 460, height: 220 },
    controls: (bar) => {
        // The two buttons DPs carries in its header, where it carries them
        bar.appendChild(
            toggleButton(
                `Filter Nondamage: ${isFilteringNonDamaging() ? 'Enabled' : 'Off'}`,
                isFilteringNonDamaging(),
                () => {
                    setFilterNonDamaging(!isFilteringNonDamaging());
                    dpsPanel.refresh();
                }
            )
        );
        bar.appendChild(
            toggleButton('Reset', false, () => {
                resetDamageTracker();
                dpsPanel.refresh();
            })
        );

        // Attribution is inferred, and every inference is a place to be wrong.
        // Two panels disagreeing cannot be settled from two screenshots — both
        // are summaries of a fight that has already happened. A recording can be
        // replayed offline until it is understood, and then kept as a fixture.
        // Same button as the one on Sim Accuracy, driving the same recorder —
        // see combat-record-control.js for why the decision is not made here.
        // The restore is a separate call from the state read on purpose: what
        // the button says is the recorder's business and nothing else's, and a
        // read that also wrote could change a running recording's target.
        primeRecordTarget();
        const state = recordControlState();
        if (!state) return;

        const button = toggleButton(state.label, state.recording, () => {
            // Handed over as a file: a recording started from here exists to be
            // replayed somewhere else, and it is the whole session — every
            // banked segment — rather than whatever the last rotation left
            toggleRecording({ download: true });
            dpsPanel.refresh();
        });
        button.title = state.title;
        bar.appendChild(button);
    },
    draw: (body) => {
        const breakdown = damageBreakdown();
        const partyDamage = breakdown.players.reduce((sum, player) => sum + player.damage, 0);

        // The header line DPs leads with: the one figure, and what it was
        // computed from, before any of the breakdown
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            display: 'flex',
            gap: '10px',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            paddingBottom: '4px',
            borderBottom: `1px solid ${COLORS.hairline}`,
        });
        const dpsFigure = document.createElement('span');
        dpsFigure.textContent = `DPS ${Number.isFinite(combatDPS.dps) ? combatDPS.dps.toFixed(1) : '—'}`;
        Object.assign(dpsFigure.style, { color: ROW_COLORS.gold, fontWeight: 'bold', fontSize: '14px' });
        heading.append(
            dpsFigure,
            piece(`Total Damage: ${formatKMB(partyDamage)}`, COLORS.textDim),
            piece(timeReadable(Math.round(breakdown.seconds)), COLORS.textDim)
        );
        body.appendChild(heading);

        // Mistakes that distort every number below, called out before them
        drawPartyLint(body);

        if (!breakdown.players.length) {
            body.appendChild(
                note('No attributed hits yet. Damage is credited by whose mana fell, so it needs a cast to start.')
            );
            return;
        }

        const header = dpsRow(
            [
                { text: 'Character / Ability' },
                { text: 'DPS' },
                { text: 'Damage' },
                { text: 'Atks' },
                { text: 'Hit' },
                { text: 'Crit' },
                { text: 'Miss' },
            ],
            { dim: true }
        );
        header.style.borderBottom = `1px solid ${COLORS.hairline}`;
        header.style.color = COLORS.textDim;
        body.appendChild(header);

        for (const player of breakdown.players) {
            const open = expandedRows.has(player.index);
            const swings = player.hits + player.misses;

            const row = dpsRow([
                { text: `${open ? '▼' : '▶'}  ${player.name}`, color: ROW_COLORS.accent, bold: true },
                {
                    text: player.dps === null ? '—' : String(Math.round(player.dps)),
                    color: ROW_COLORS.good,
                    bold: true,
                },
                // The bare figure, as DPs shows it on a character row. The share
                // of a party total is on the rows underneath, where it says
                // something; on the only player in a solo run it says 100%.
                { text: formatKMB(player.damage), color: ROW_COLORS.good },
                { text: formatWithSeparator(Math.round(swings)) },
                { text: countAndShare(player.hits, swings), color: ROW_COLORS.good },
                { text: countAndShare(player.crits, player.hits), color: ROW_COLORS.gold },
                { text: countAndShare(player.misses, swings), color: ROW_COLORS.bad },
            ]);
            row.style.cursor = 'pointer';
            row.title = dotNote(player) + 'Click for the per-ability breakdown.';
            row.addEventListener('click', () => {
                if (open) expandedRows.delete(player.index);
                else expandedRows.add(player.index);
                dpsPanel.refresh();
            });
            body.appendChild(row);

            if (!open) continue;

            // Ranked and shared out by the same builder the trial scoreboard's
            // expandable rows use, so the two breakdowns cannot drift apart
            for (const ability of abilityBreakdownRows(player.abilities, {
                total: player.damage,
                seconds: breakdown.seconds,
            })) {
                const attempts = ability.hits + ability.misses;
                body.appendChild(
                    dpsRow(
                        [
                            { text: `• ${actionLabel(ability.action)}` },
                            { text: abilityRateText(ability), color: ROW_COLORS.good },
                            { text: abilityDamageText(ability), color: ROW_COLORS.good },
                            { text: formatWithSeparator(attempts) },
                            { text: countAndShare(ability.hits, attempts), color: ROW_COLORS.good },
                            { text: countAndShare(ability.crits, ability.hits), color: ROW_COLORS.gold },
                            { text: countAndShare(ability.misses, attempts), color: ROW_COLORS.bad },
                        ],
                        { dim: true, indent: 14 }
                    )
                );
            }

            // Under the player who fought them, as DPs nests them: collapsing a
            // player takes their enemies with them. A party's enemy rows at the
            // top level would average two people's fights into neither.
            for (const enemy of player.enemies || []) {
                const enemyKey = `enemy:${player.index}:${enemy.name}`;
                const enemyOpen = expandedRows.has(enemyKey);
                const enemySwings = enemy.hits + enemy.misses;
                const enemyShare = player.damage > 0 ? (enemy.damage / player.damage) * 100 : 0;

                const enemyRow = dpsRow(
                    [
                        { text: `${enemyOpen ? '▼' : '▶'}  ${enemy.name}`, color: ROW_COLORS.bad, bold: true },
                        { text: Number.isFinite(enemy.dps) ? enemy.dps.toFixed(1) : '—', color: ROW_COLORS.good },
                        { text: `${formatKMB(enemy.damage)} (${enemyShare.toFixed(1)}%)`, color: ROW_COLORS.good },
                        { text: formatWithSeparator(enemySwings) },
                        { text: countAndShare(enemy.hits, enemySwings), color: ROW_COLORS.good },
                        { text: countAndShare(enemy.crits, enemy.hits), color: ROW_COLORS.gold },
                        { text: countAndShare(enemy.misses, enemySwings), color: ROW_COLORS.bad },
                    ],
                    { indent: 10 }
                );
                enemyRow.style.cursor = 'pointer';
                enemyRow.title = 'Click for what was used against it.';
                enemyRow.addEventListener('click', () => {
                    if (enemyOpen) expandedRows.delete(enemyKey);
                    else expandedRows.add(enemyKey);
                    dpsPanel.refresh();
                });
                body.appendChild(enemyRow);

                if (!enemyOpen) continue;

                // The question an enemy row raises: is it tanky, or is the
                // wrong thing being pointed at it
                for (const ability of abilityBreakdownRows(enemy.abilities, {
                    total: enemy.damage,
                    seconds: breakdown.seconds,
                })) {
                    const attempts = ability.hits + ability.misses;
                    body.appendChild(
                        dpsRow(
                            [
                                { text: `• ${actionLabel(ability.action)}` },
                                { text: abilityRateText(ability), color: ROW_COLORS.good },
                                { text: abilityDamageText(ability), color: ROW_COLORS.good },
                                { text: formatWithSeparator(attempts) },
                                { text: countAndShare(ability.hits, attempts), color: ROW_COLORS.good },
                                { text: countAndShare(ability.crits, ability.hits), color: ROW_COLORS.gold },
                                { text: countAndShare(ability.misses, attempts), color: ROW_COLORS.bad },
                            ],
                            { dim: true, indent: 24 }
                        )
                    );
                }
            }
        }

        body.appendChild(enemyHealthCard(breakdown));

        // The exchange, which the table cannot show: a party doing well on
        // paper is still losing if it is taking more than it deals
        const exchange = card(body, 'Party');
        exchange.append(
            line('Taken per second', formatWithSeparator(Math.round(combatDPS.dtps ?? 0)), ROW_COLORS.bad),
            line(
                'Exchange',
                combatDPS.dtps > 0 ? `${(combatDPS.dps / combatDPS.dtps).toFixed(1)}× in your favour` : 'untouched',
                ROW_COLORS.gold
            ),
            line('Time fighting', timeReadable(Math.round(combatDPS.seconds)), COLORS.text)
        );

        body.appendChild(
            note(
                'Attribution comes from whose mana fell on each tick, which is the only join the game offers. ' +
                    'A tick where two players cast at once credits the last one seen.'
            )
        );
    },
});

/**
 * A banner of name-and-figure pairs, the way IHurt leads.
 *
 * The party total and every member on one line, rather than a card per member.
 * Deaths are the figure you check rather than study — the interesting reading is
 * "is anyone dying", and that is one glance across a line. The cards below are
 * for when the answer is yes.
 *
 * @param {string} label - What the row counts
 * @param {Array<{name: string, value: string}>} parts - One per player
 * @param {string} total - The party figure
 * @param {string} tone - Ink for the figures
 * @returns {HTMLElement}
 */
function hurtBanner(label, parts, total, tone) {
    const row = document.createElement('div');
    Object.assign(row.style, {
        background: 'rgba(248, 113, 113, 0.10)',
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '5px',
        padding: '5px 9px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '5px',
        fontSize: '11.5px',
        fontVariantNumeric: 'tabular-nums',
    });

    const heading = document.createElement('span');
    heading.textContent = label;
    Object.assign(heading.style, { color: ROW_COLORS.bad, fontWeight: 'bold' });
    row.appendChild(heading);

    const pieces = [...parts.map((part) => ({ ...part, gold: true })), { name: 'Total', value: total }];
    pieces.forEach((part, index) => {
        if (index > 0) row.appendChild(piece(' | ', COLORS.textDim));

        const wrap = document.createElement('span');
        const name = document.createElement('span');
        name.textContent = `${part.name}: `;
        name.style.color = part.gold ? ROW_COLORS.gold : ROW_COLORS.bad;
        if (!part.gold) name.style.fontWeight = 'bold';

        const figure = document.createElement('span');
        figure.textContent = part.value;
        Object.assign(figure.style, { color: tone, fontWeight: 'bold' });

        wrap.append(name, figure);
        row.appendChild(wrap);
    });

    return row;
}

/**
 * One player's card: what they took, what they healed, and what it cost them.
 *
 * Damage and regeneration side by side rather than netted. A net figure of −200
 * describes both a comfortable zone and one you barely survive, and the pair
 * tells them apart: 3,400 taken against 3,600 healed is sustainable, 3,400
 * against 200 is a run that ends.
 *
 * @param {Object} player - From `takenBreakdown`
 * @param {number} deaths - From the server's own count
 * @param {number} hours - Elapsed, for the rate
 * @returns {HTMLElement}
 */
function hurtPlayerCard(player, deaths, hours) {
    const tile = document.createElement('div');
    Object.assign(tile.style, {
        background: COLORS.card,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: '6px',
        padding: '6px 9px',
        fontSize: '11.5px',
        fontVariantNumeric: 'tabular-nums',
    });

    const name = document.createElement('div');
    name.textContent = player.name;
    Object.assign(name.style, { color: ROW_COLORS.gold, fontWeight: 'bold', marginBottom: '3px' });
    tile.appendChild(name);

    tile.append(
        line('Damage/s', player.dps === null ? '—' : player.dps.toFixed(1), ROW_COLORS.bad),
        line('Regen/s', player.hps === null ? '—' : player.hps.toFixed(1), ROW_COLORS.good),
        hairline(),
        line('Total dmg', formatKMB(player.damage), ROW_COLORS.bad),
        line('Total regen', formatKMB(player.regen), ROW_COLORS.good),
        hairline(),
        line('Deaths', formatWithSeparator(deaths), deaths ? ROW_COLORS.bad : ROW_COLORS.good),
        line('Deaths/hr', hours > 0 ? (deaths / hours).toFixed(1) : '0.0', deaths ? ROW_COLORS.bad : ROW_COLORS.good)
    );
    return tile;
}

/** A rule between groups of lines inside a card */
function hairline() {
    const rule = document.createElement('div');
    Object.assign(rule.style, { borderTop: `1px solid ${COLORS.hairline}`, margin: '4px 0' });
    return rule;
}

/**
 * A range, written the way IHurt writes it: `[66-88]`.
 *
 * The range is the point of the section rather than a decoration. A wave whose
 * average hit is forty is comfortable until one of its members hits for two
 * hundred, and only the maximum says so.
 *
 * @param {number|null} min - Smallest hit seen
 * @param {number|null} max - Largest
 * @returns {string} Empty when nothing has landed
 */
function hitRange(min, max) {
    if (min === null || max === null) return '';
    return `[${formatWithSeparator(min)}-${formatWithSeparator(max)}]`;
}

/**
 * What one kind of monster has done to the party.
 *
 * @param {Object} enemy - From `takenBreakdown`
 * @returns {HTMLElement}
 */
function hurtEnemyCard(enemy) {
    const tile = document.createElement('div');
    Object.assign(tile.style, {
        borderLeft: `3px solid ${ROW_COLORS.bad}`,
        borderRadius: '4px',
        background: 'rgba(248, 113, 113, 0.08)',
        padding: '5px 8px',
        fontSize: '11px',
        fontVariantNumeric: 'tabular-nums',
    });

    const name = document.createElement('div');
    name.textContent = enemy.name;
    Object.assign(name.style, { color: ROW_COLORS.bad, fontWeight: 'bold', fontSize: '11.5px' });
    tile.appendChild(name);

    tile.appendChild(note(`Total: ${formatKMB(enemy.damage)}`, COLORS.textDim));
    const range = hitRange(enemy.min, enemy.max);
    if (range) tile.appendChild(note(`Range: ${range}`, COLORS.textDim));

    // Only worth the rows when there is more than one player to tell apart —
    // solo, they would repeat the card's own total under the player's name
    if (enemy.players.length > 1 || enemy.players.some((entry) => entry.damage !== enemy.damage)) {
        for (const entry of enemy.players) {
            const row = document.createElement('div');
            Object.assign(row.style, {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                gap: '6px',
                alignItems: 'baseline',
                background: 'rgba(248, 113, 113, 0.10)',
                borderRadius: '3px',
                padding: '2px 5px',
                marginTop: '3px',
            });
            row.append(
                piece(`${entry.name}:`, ROW_COLORS.bad),
                piece(formatKMB(entry.damage), COLORS.text),
                piece(hitRange(entry.min, entry.max), COLORS.textDim)
            );
            tile.appendChild(row);
        }
    }
    return tile;
}

/**
 * A collapsible section heading, with a figure on the right.
 *
 * @param {string} key - Where its open state is remembered
 * @param {string} label - The heading
 * @param {string} right - A figure for the right-hand side, or empty
 * @param {string} arrowColor - Ink for the triangle
 * @param {Function} onToggle - Redraw
 * @returns {HTMLElement}
 */
function hurtSectionHeader(key, label, right, arrowColor, onToggle) {
    const open = expandedRows.has(key);
    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        cursor: 'pointer',
        userSelect: 'none',
        padding: '2px 0',
    });

    const left = document.createElement('div');
    Object.assign(left.style, { display: 'flex', gap: '6px', alignItems: 'baseline' });
    left.append(piece(open ? '▼' : '▶', arrowColor), piece(label, ROW_COLORS.gold));
    left.querySelector('span:last-child').style.fontWeight = 'bold';

    header.appendChild(left);
    if (right) {
        const figure = piece(right, ROW_COLORS.bad);
        figure.style.fontWeight = 'bold';
        header.appendChild(figure);
    }

    header.addEventListener('click', () => {
        if (open) expandedRows.delete(key);
        else expandedRows.add(key);
        onToggle();
    });
    return header;
}

export const deathsPanel = new CombatPanel({
    id: 'deathsPanel',
    title: 'IHurt',
    size: { width: 460, height: 420 },
    draw: (body) => {
        const taken = takenBreakdown();
        const data = combatStatsDataCollector.getLatestData?.();
        const statPlayers = data?.players || [];

        const players = taken?.players || [];
        if (!players.length && !statPlayers.length) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        // Deaths come from the server, damage is derived here. Two sources for
        // one number is two numbers that eventually disagree, and the server's
        // is the one that is right — so each supplies only what it knows.
        const deathsFor = (name) =>
            statPlayers.find((entry) => (entry.name || entry.characterName) === name)?.deathCount || 0;

        const duration = runSeconds(data);
        const hours = duration / 3600;
        const totalDeaths = statPlayers.reduce((sum, player) => sum + (player.deathCount || 0), 0);

        const cards = players.length
            ? players
            : statPlayers.map((entry) => ({
                  name: entry.name || entry.characterName || 'Unknown',
                  damage: 0,
                  regen: 0,
                  dps: null,
                  hps: null,
              }));

        body.append(
            hurtBanner(
                'Session Deaths:',
                cards.map((player) => ({ name: player.name, value: formatWithSeparator(deathsFor(player.name)) })),
                formatWithSeparator(totalDeaths),
                totalDeaths ? ROW_COLORS.bad : ROW_COLORS.good
            ),
            hurtBanner(
                'Session Deaths/hr:',
                cards.map((player) => ({
                    name: player.name,
                    value: hours > 0 ? (deathsFor(player.name) / hours).toFixed(1) : '0.0',
                })),
                hours > 0 ? (totalDeaths / hours).toFixed(1) : '0.0',
                totalDeaths ? ROW_COLORS.bad : ROW_COLORS.good
            )
        );

        const grid = document.createElement('div');
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '6px',
        });
        for (const player of cards) grid.appendChild(hurtPlayerCard(player, deathsFor(player.name), hours));
        body.appendChild(grid);

        body.appendChild(line('Time fighting', timeReadable(Math.round(taken?.seconds || 0)), COLORS.text));

        if (!taken || !taken.enemies.length) {
            body.appendChild(
                note(
                    'Nothing has hit the party yet this session. Damage taken, what dealt it and how hard it ' +
                        'hits appear here once it does.'
                )
            );
            return;
        }

        const totalTaken = taken.enemies.reduce((sum, enemy) => sum + enemy.damage, 0);
        body.appendChild(
            hurtSectionHeader(
                'hurt:enemies',
                'Enemy Damage to Party:',
                `Total: ${formatKMB(totalTaken)}`,
                ROW_COLORS.bad,
                () => deathsPanel.refresh()
            )
        );
        if (expandedRows.has('hurt:enemies')) {
            const enemies = document.createElement('div');
            Object.assign(enemies.style, {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: '6px',
            });
            for (const enemy of taken.enemies) enemies.appendChild(hurtEnemyCard(enemy));
            body.appendChild(enemies);
        }

        if (taken.waves.length) {
            body.appendChild(
                hurtSectionHeader(
                    'hurt:waves',
                    'Damage Profiles (Enemy Group Compositions):',
                    '',
                    ROW_COLORS.gold,
                    () => deathsPanel.refresh()
                )
            );
            if (expandedRows.has('hurt:waves')) {
                for (const wave of taken.waves) {
                    const tile = card(body, '');
                    const name = document.createElement('div');
                    name.textContent = wave.name;
                    Object.assign(name.style, { color: ROW_COLORS.gold, fontWeight: 'bold', fontSize: '11.5px' });

                    const stats = document.createElement('div');
                    Object.assign(stats.style, { color: COLORS.textDim, fontSize: '10.5px' });
                    stats.append(
                        piece(`Encounters: ${formatWithSeparator(wave.encounters)} | Total Damage: `, COLORS.textDim),
                        piece(formatKMB(wave.damage), COLORS.text),
                        piece(' | Avg/Encounter: ', COLORS.textDim),
                        piece(formatKMB(Math.round(wave.average)), ROW_COLORS.bad)
                    );
                    const range = hitRange(wave.min, wave.max);
                    if (range) stats.appendChild(piece(` | Hit Range: ${range}`, COLORS.textDim));

                    tile.append(name, stats);
                }
            }
        }

        drawEncountersAndKills(body, taken.encounters);

        body.appendChild(
            note(
                'A monster casting is identified by its mana; an auto-attack spends none, so in a wave the ' +
                    'attacker is a proxy and unattributed hits are shown as Unknown Enemy.'
            )
        );
    },
});

/**
 * What died, against what the zone owed you.
 *
 * The count on its own is not a fact about the run: seven Eyes is a lot or a
 * little entirely depending on how often the zone spawns them, and nobody
 * carries that number around. Against the expectation it becomes "+21%", which
 * is something you can act on — it is the same reading Drop Luck gives for coins,
 * applied to the spawns that produced them.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {number} encounters - Battles entered this run
 */
function drawEncountersAndKills(body, encounters) {
    const killed = (damageBreakdown().enemies || []).filter((enemy) => enemy.kills > 0);
    if (!killed.length) return;

    const action = dataManager.getCurrentActions?.()?.find((entry) => entry.actionHrid?.startsWith('/actions/combat/'));
    const expected = action
        ? expectedKills({
              actionDetail: dataManager.getActionDetails?.(action.actionHrid),
              monsterDetailMap: dataManager.getInitClientData?.()?.combatMonsterDetailMap,
              battles: encounters,
          })
        : {};

    const rows = killComparison(killed, expected);
    const total = killed.reduce((sum, enemy) => sum + enemy.kills, 0);

    body.appendChild(
        hurtSectionHeader(
            'hurt:kills',
            'Encounters & Kills:',
            `Encounters: ${formatWithSeparator(encounters)} | Kills: ${formatWithSeparator(total)}`,
            COLORS.accent,
            () => deathsPanel.refresh()
        )
    );
    if (!expandedRows.has('hurt:kills')) return;

    const grid = document.createElement('div');
    Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '6px',
    });

    for (const row of rows) {
        const tile = document.createElement('div');
        Object.assign(tile.style, {
            borderLeft: `3px solid ${COLORS.accent}`,
            borderRadius: '4px',
            background: 'rgba(143, 180, 255, 0.08)',
            padding: '5px 8px',
            fontSize: '11px',
            fontVariantNumeric: 'tabular-nums',
            // A monster the zone owes you and has not produced is the row worth
            // noticing, but it is not a measurement of anything yet
            opacity: row.kills === 0 ? '0.65' : '1',
        });

        const name = document.createElement('div');
        name.textContent = row.name;
        Object.assign(name.style, { color: COLORS.accent, fontWeight: 'bold', fontSize: '11.5px' });

        const stats = document.createElement('div');
        Object.assign(stats.style, { display: 'flex', flexWrap: 'wrap', gap: '7px', alignItems: 'baseline' });
        const actual = piece(`Actual: ${formatWithSeparator(row.kills)}`, COLORS.text);
        actual.style.fontWeight = 'bold';
        stats.appendChild(actual);

        if (row.expected !== null) {
            stats.appendChild(piece(`Expected: ${row.expected.toFixed(1)}`, COLORS.textDim));
            if (row.share !== null) {
                const share = piece(
                    `(${row.share >= 0 ? '+' : ''}${(row.share * 100).toFixed(1)}%)`,
                    row.share >= 0 ? ROW_COLORS.good : ROW_COLORS.bad
                );
                share.style.fontWeight = 'bold';
                stats.appendChild(share);
            }
        }

        tile.append(name, stats);
        grid.appendChild(tile);
    }
    body.appendChild(grid);
}

/**
 * How the profit is being read: which case, and what is subtracted.
 *
 * HWhat keeps the same three settings, because the cases are not equally
 * interesting to everybody — somebody who sells into bids and buys from asks
 * is always reading the Lazy line and never the other three.
 *
 * Persisted rather than held for the session. The overlay tile follows these
 * now, and a tile that silently reverts to a different reading of profit every
 * time the page reloads is worse than one that never followed at all.
 */
const PROFIT_SETTINGS_KEY = 'combatProfitView';

const profitView = { mode: 'mid', costsOn: true, moopassOn: false };

// This runs at module scope, long before the database opens — reading without
// waiting on storage.ready returned the default every load and the remembered
// view never came back.
async function loadProfitView() {
    try {
        await storage.ready;
        const saved = await storage.getJSON(PROFIT_SETTINGS_KEY, 'settings', null);
        if (saved) Object.assign(profitView, saved);
        // `taxOn` was this toggle's old name, back when the MooPass weekly cost
        // was labelled "Tax"; carry a remembered choice across the rename.
        if ('taxOn' in profitView) {
            if (profitView.moopassOn === undefined) profitView.moopassOn = profitView.taxOn;
            delete profitView.taxOn;
        }
    } catch (error) {
        console.error('[CombatPanels] Reading the profit view failed:', error);
    }
}
loadProfitView();

/**
 * Remember how profit is being read, and redraw what follows it.
 */
function saveProfitView() {
    storage
        .setJSON(PROFIT_SETTINGS_KEY, { ...profitView }, 'settings')
        .catch((error) => console.error('[CombatPanels] Saving the profit view failed:', error));
    profitPanel.refresh();
}

/**
 * A profit box in HWhat's shape: the case, the figure, the rule, the sum.
 *
 * The arithmetic line is the part worth copying. "55.6M/day" is a conclusion,
 * and `67.6M - 12.0M = 55.6M` is the same conclusion with its working shown —
 * which is what tells you whether a bad number is a revenue problem or a cost
 * problem without opening anything else.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} scenario - `{title, colour, equation, revenue, cost}`
 * @returns {HTMLElement}
 */
function profitBox(body, scenario, tax = 0) {
    const value = scenario.revenue - (profitView.costsOn ? scenario.cost : 0) - tax;
    const colour = value >= 0 ? scenario.colour : ROW_COLORS.bad;

    const block = card(body);
    block.style.borderLeft = `3px solid ${colour}`;

    const heading = document.createElement('div');
    heading.textContent = scenario.shorthand ? `${scenario.title}  (${scenario.shorthand})` : scenario.title;
    Object.assign(heading.style, { color: colour, fontWeight: 'bold' });

    const figure = document.createElement('div');
    figure.textContent = `${formatKMB(value)} coin/day`;
    Object.assign(figure.style, { color: colour, fontSize: '17px', fontWeight: 'bold', lineHeight: '1.3' });

    const rule = document.createElement('div');
    rule.textContent =
        (profitView.costsOn ? scenario.equation : scenario.equation.split(' - ')[0]) + (tax ? ' - MooPass' : '');
    Object.assign(rule.style, { color: COLORS.textDim, fontSize: '11px' });

    const terms = [formatKMB(scenario.revenue)];
    if (profitView.costsOn) terms.push(formatKMB(scenario.cost));
    if (tax) terms.push(formatKMB(tax));

    const sum = document.createElement('div');
    sum.textContent = terms.length > 1 ? `${terms.join(' - ')} = ${formatKMB(value)}` : terms[0];
    Object.assign(sum.style, {
        color: colour,
        opacity: '0.75',
        fontSize: '11px',
        fontFamily: 'monospace',
        marginTop: '2px',
    });

    block.append(heading, figure, rule, sum);
    return block;
}

/**
 * A header toggle, in HWhat's pill shape.
 *
 * @param {string} label - What it says
 * @param {boolean} on - Whether it reads as engaged
 * @param {Function} onClick - What pressing it does
 * @returns {HTMLElement}
 */
function toggleButton(label, on, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    Object.assign(button.style, {
        background: on ? 'rgba(143, 180, 255, 0.22)' : 'rgba(255, 255, 255, 0.05)',
        border: `1px solid ${on ? COLORS.accent : COLORS.hairline}`,
        borderRadius: '4px',
        color: on ? COLORS.accent : COLORS.textDim,
        cursor: 'pointer',
        fontSize: '11px',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
    });
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

/**
 * The three cases, each a revenue side and a cost side.
 *
 * They are not "at ask" and "at bid": you sell and buy on opposite sides of the
 * book, so each case mixes one side of each.
 *
 * @param {Object} stats - From `playerStats`
 * @returns {Array<Object>}
 */
function profitCases(stats) {
    const revenue = { ask: stats.dailyIncome?.ask ?? 0, bid: stats.dailyIncome?.bid ?? 0 };
    const cost = {
        ask:
            (stats.dailyConsumableCosts?.ask ?? stats.dailyConsumableCosts ?? 0) +
            (stats.dailyKeyCosts?.ask ?? stats.dailyKeyCosts ?? 0),
        bid:
            (stats.dailyConsumableCosts?.bid ?? stats.dailyConsumableCosts ?? 0) +
            (stats.dailyKeyCosts?.bid ?? stats.dailyKeyCosts ?? 0),
    };

    // All four ways round the book, each once. Lazy, Mid and Patient are the
    // three worth a name; Ask - Ask is the fourth corner — everything at the
    // asking price, which is the optimistic reading and the one HWhat shows
    // last.
    return [
        {
            key: 'lazy',
            title: 'Lazy Profit',
            shorthand: 'Bid - Ask',
            colour: ROW_COLORS.good,
            equation: 'Revenue (Bid) - Cost (Ask)',
            revenue: revenue.bid,
            cost: cost.ask,
        },
        {
            key: 'mid',
            title: 'Mid Profit',
            shorthand: 'Bid - Bid',
            colour: ROW_COLORS.accent,
            equation: 'Revenue (Bid) - Cost (Bid)',
            revenue: revenue.bid,
            cost: cost.bid,
        },
        {
            key: 'patient',
            title: 'Patient Profit',
            shorthand: 'Ask - Bid',
            colour: ROW_COLORS.gold,
            equation: 'Revenue (Ask) - Cost (Bid)',
            revenue: revenue.ask,
            cost: cost.bid,
        },
        {
            key: 'askask',
            title: 'Ask - Ask',
            shorthand: '',
            colour: '#c79ae8',
            equation: 'Revenue (Ask) - Cost (Ask)',
            revenue: revenue.ask,
            cost: cost.ask,
        },
    ];
}

/**
 * How the overlay tile should read profit, given stats it has already computed.
 *
 * The tile used to be hard-wired to bid revenue less every cost, which is one
 * of four readings and not the one somebody who has chosen Patient in the panel
 * is thinking in. Rather than have the tile guess, the panel says: the case
 * that is selected, with the tax in it if the tax is on.
 *
 * Takes the caller's stats rather than fetching its own, so the tile keeps its
 * own cache and nothing is priced twice per tick.
 *
 * @param {Object} stats - From `calculatePlayerStats`
 * @returns {{title: string, revenue: number, cost: number, tax: number, profit: number}|null}
 */
export function combatProfitView(stats) {
    if (!stats) return null;

    const cases = profitCases(stats);
    const headline = cases.find((scenario) => scenario.key === profitView.mode) || cases[1];
    const cost = profitView.costsOn ? headline.cost : 0;
    const tax = profitView.moopassOn ? cowbellTax().perDay : 0;

    return { title: headline.title, revenue: headline.revenue, cost, tax, profit: headline.revenue - cost - tax };
}

export const profitPanel = new CombatPanel({
    id: 'profitPanel',
    title: 'Combat Profit',
    size: { width: 440, height: 470 },
    controls: (bar) => {
        const stats = playerStats();
        if (!stats) return;

        bar.appendChild(
            toggleButton(profitView.costsOn ? 'Costs On' : 'Costs Off', profitView.costsOn, () => {
                profitView.costsOn = !profitView.costsOn;
                saveProfitView();
            })
        );

        // The MooPass is a real weekly cost, and a profit figure that ignores it
        // is a profit figure that has not paid the rent
        bar.appendChild(
            toggleButton(profitView.moopassOn ? 'Moopass On' : 'Moopass Off', profitView.moopassOn, () => {
                profitView.moopassOn = !profitView.moopassOn;
                saveProfitView();
            })
        );

        // The market sale tax comes off what a drop actually sells for. Netted
        // at the source (`calculateIncome`), so flipping it re-reads income on
        // the next draw — refresh rather than a display-time subtraction.
        bar.appendChild(
            toggleButton(salesTaxNetted() ? 'Tax On' : 'Tax Off', salesTaxNetted(), () => {
                setSalesTaxNetted(!salesTaxNetted());
                profitPanel.refresh();
            })
        );

        // Cycles rather than three buttons: the header is narrow and the three
        // cases are an order, not a set
        const cases = profitCases(stats);
        const index = Math.max(
            0,
            cases.findIndex((scenario) => scenario.key === profitView.mode)
        );
        bar.appendChild(
            toggleButton(cases[index].title.split(' ')[0], true, () => {
                profitView.mode = cases[(index + 1) % cases.length].key;
                saveProfitView();
            })
        );
    },
    draw: (body) => {
        const stats = playerStats();
        if (!stats) {
            body.appendChild(note('No combat data yet.'));
            return;
        }

        const cases = profitCases(stats);
        const headline = cases.find((scenario) => scenario.key === profitView.mode) || cases[1];
        const tax = profitView.moopassOn ? cowbellTax().perDay : 0;

        // The header sum HWhat carries: revenue, cost and what is left, in one
        // line, so the panel answers its own question before it is scrolled
        const summary = card(body);
        summary.style.borderLeft = `3px solid ${headline.colour}`;
        const total = headline.revenue - (profitView.costsOn ? headline.cost : 0) - tax;
        const equation = document.createElement('div');
        Object.assign(equation.style, { fontSize: '14px', fontWeight: 'bold' });
        equation.appendChild(piece(formatKMB(headline.revenue), ROW_COLORS.good));
        if (tax) {
            equation.append(piece(' - ', COLORS.textDim), piece(formatKMB(tax), '#e8b4d8'));
        }
        if (profitView.costsOn) {
            equation.append(piece(' - ', COLORS.textDim), piece(formatKMB(headline.cost), ROW_COLORS.bad));
        }
        if (tax || profitView.costsOn) equation.appendChild(piece(' = ', COLORS.textDim));
        equation.appendChild(piece(`${formatKMB(total)}/day`, ROW_COLORS.gold));
        summary.append(equation, note(`${headline.title} · ${formatKMB(total / 24)}/hr`));

        // Before the four cases, since "who is being paid" is a coarser question
        // than "which price to sell at" and answering it changes what you do next
        drawPartyProfit(body, profitView.mode, tax);

        for (const scenario of cases) profitBox(body, scenario, tax);

        const spread = card(body, 'Difference');
        // Patient against lazy: the tax is in both, so it cancels
        const best = cases[2].revenue - (profitView.costsOn ? cases[2].cost : 0);
        const worst = cases[0].revenue - (profitView.costsOn ? cases[0].cost : 0);
        spread.append(
            line('Patient over lazy', formatKMB(best - worst), ROW_COLORS.gold),
            line('Consumables/day', formatKMB(cases[0].cost), ROW_COLORS.bad),
            line('Run length', timeReadable(Math.round(stats.duration)), COLORS.text)
        );
        spread.appendChild(
            note('How much the same run is worth for being patient with the order book rather than taking the spread.')
        );

        body.appendChild(taxCard(stats));

        // The last all-zones sim's forecast for this zone, kept to the foot of
        // the panel so it never competes with the live rate at the top
        drawSimHere(body);
    },
});

/**
 * One coloured span of the header sum.
 * @param {string} text - What it says
 * @param {string} color - Ink
 * @returns {HTMLElement}
 */
function piece(text, color) {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.color = color;
    return span;
}

/** A week of membership, in bags of ten cowbells, as the game charges it */
const BAGS_PER_WEEK = 25;
const COWBELL_BAG = '/items/bag_of_10_cowbells';
const COWBELL = '/items/cowbell';
const COWBELLS_PER_BAG = 10;

/**
 * What the weekly tax still costs, given what is already in the bag.
 *
 * Not the price of twenty-five bags. Cowbells accumulate — from dailies, from
 * drops, from bags bought and not yet spent — and a figure that ignores the
 * hundred and twenty you are already holding overstates the tax by half and
 * makes a run look like it is not covering something it comfortably covers.
 * Loose cowbells and bagged ones are the same thing at ten to one.
 *
 * @returns {{perWeek: number, perDay: number, bagsNeeded: number, bagPrice: number}}
 */
function cowbellTax() {
    const bagPrice = getItemPrices(COWBELL_BAG)?.ask || 0;

    let held = 0;
    for (const item of dataManager.getInventory?.() || []) {
        if (item.itemHrid === COWBELL) held += item.count || 0;
        else if (item.itemHrid === COWBELL_BAG) held += (item.count || 0) * COWBELLS_PER_BAG;
    }

    const owed = Math.max(0, BAGS_PER_WEEK * COWBELLS_PER_BAG - held);
    const bagsNeeded = Math.ceil(owed / COWBELLS_PER_BAG);
    const perWeek = bagPrice * bagsNeeded;

    return { perWeek, perDay: perWeek / 7, bagsNeeded, bagPrice };
}

/**
 * What the tax costs, and whether this run pays it.
 *
 * The figure worth having is not the price of a bag but whether the run covers
 * it: a profit that does not clear the weekly tax is not profit, it is a slower
 * way of running down.
 *
 * @param {Object} stats - From `playerStats`
 * @returns {HTMLElement}
 */
function taxCard(stats) {
    const holder = document.createElement('div');
    const block = card(holder, profitView.moopassOn ? 'Paying the MooPass' : 'Pay the MooPass');

    const tax = cowbellTax();
    if (!tax.bagPrice) {
        block.appendChild(note('No market price for a Bag of 10 Cowbells yet.'));
        return holder;
    }

    const profit = stats.dailyProfit?.bid ?? 0;

    block.append(
        line(
            'Per week',
            `${formatKMB(tax.perWeek)}  (${tax.bagsNeeded} of ${BAGS_PER_WEEK} bags)`,
            ROW_COLORS.bad,
            'Twenty-five bags a week, less the cowbells you are already holding.'
        ),
        line('Per day', formatKMB(tax.perDay), ROW_COLORS.bad),
        line(
            'This run covers it',
            profit >= tax.perDay ? 'yes' : 'no',
            profit >= tax.perDay ? ROW_COLORS.good : ROW_COLORS.bad,
            'Daily profit at bid against the daily cost of the weekly MooPass.'
        )
    );
    if (profit > 0) {
        block.appendChild(
            line('Days of profit per week of MooPass', (tax.perWeek / profit).toFixed(1), ROW_COLORS.accent)
        );
    }
    if (!profitView.moopassOn) {
        block.appendChild(note('Not counted against the figures above — press Moopass in the header to include it.'));
    }
    return holder;
}

// Panels reopen themselves if the page was left with them up. At module scope
// rather than inside a feature's initialize, because these are created here and
// nothing else owns their lifetime.
dpsPanel.restore();
deathsPanel.restore();
profitPanel.restore();
