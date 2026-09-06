/**
 * Loot & XP Log Analytics panel
 *
 * A pivot over every action the loot log remembers: one row per action (and per
 * difficulty tier), with the time spent on it, what its drops came to, and the
 * XP per hour it actually paid per skill.
 *
 * ## Why this is not the calibration panel again
 *
 * Every other per-hour figure this script draws is a *prediction* — the action
 * calculators' model of what a character's buffs and the drop tables ought to
 * produce. The calibration panel then asks whether that model is systematically
 * wrong. Neither answers "what did this action actually pay me", because neither
 * ever adds up what happened. This does, and only that: it reads the recorded
 * runs and divides.
 *
 * ## Ask and bid, side by side
 *
 * Value and gold/hr are shown as a pair rather than resolved through the pricing
 * mode. A pricing mode is a decision about how to value something you have not
 * sold yet, and it belongs where a single number has to be committed to (a
 * profit tile, a budget). Here the two ends of the spread are themselves the
 * answer: an action whose drops are thin at bid and fat at ask is an action
 * whose income depends on patience, and collapsing that to one figure hides the
 * only thing the row had to say.
 *
 * ## The panel, not an overlay
 *
 * `simple-panel` supplies the shell — dragging, resizing, remembered geometry,
 * z-index, Escape, minimize, teardown on character switch — so this file is the
 * table and nothing else. The body is rebuilt on every refresh, which is why the
 * sort, the filter and which rows are expanded live at module scope rather than
 * on the elements.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { formatKMB, numberFormatter, formatDateTime } from '../../utils/formatters.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { spriteIcon, skillIcon, ROW_COLORS, shortDuration } from '../../utils/overlay-format.js';
import lootLogHistory from './loot-log-history.js';
import lootLogStats from './loot-log-stats.js';
import { mergeCurrentAndHistoricalEntries, aggregatePivotRows, computeRowRates } from './loot-log-analytics.js';

/** Panel id, which is also its geometry key */
export const PANEL_ID = 'lootLogPivot';

const ACCENT = '#8fd0a0';

/** Nothing on the table moves unless a loot message lands, so the timer is slow */
const REFRESH_MS = 15_000;

/**
 * How many rows are drawn before the "Show more" line.
 *
 * The row count is bounded by distinct actions rather than by entries, so it is
 * usually well under this — but a long-lived character who has touched every
 * zone and every recipe is several hundred rows, each with a nested XP list, and
 * building all of them on a 15-second timer is a stutter with nothing to show
 * for it. The page grows on demand and resets when the panel is reopened.
 */
export const PAGE_SIZE = 60;

/** The columns, in order; `sortValue` is what a click on the heading sorts by */
export const COLUMNS = [
    { key: 'name', label: 'Action', sortValue: (view) => view.displayName.toLowerCase() },
    { key: 'actions', label: 'Actions', sortValue: (view) => view.row.actionCount },
    { key: 'time', label: 'Time', sortValue: (view) => view.row.totalTimeMs },
    { key: 'xp', label: 'XP/hr', sortValue: (view) => view.totalXpPerHour },
    { key: 'value', label: 'Value (ask/bid)', sortValue: (view) => view.askTotal },
    { key: 'gold', label: 'Gold/hr (ask/bid)', sortValue: (view) => view.goldPerHourAsk },
];

/** Sort, filter and folds, at module scope because the body is rebuilt every refresh */
let sortKey = 'time';
let sortDesc = true;
let filterText = '';
let rowLimit = PAGE_SIZE;
const expanded = new Set();

/** The live `loot_log_updated` payload, and the stored history behind it */
let currentEntries = [];
let historicalEntries = [];
let historyLoaded = false;

/**
 * Forget everything the panel is holding.
 *
 * Called on cleanup and on a character switch: the history belongs to whoever
 * was logged in when it was read, and serving it to the next character would
 * report their predecessor's income as their own.
 * @returns {void}
 */
export function resetPivotState() {
    sortKey = 'time';
    sortDesc = true;
    filterText = '';
    rowLimit = PAGE_SIZE;
    expanded.clear();
    currentEntries = [];
    historicalEntries = [];
    historyLoaded = false;
}

/**
 * Read stored history and redraw once it lands.
 *
 * `draw` is synchronous — the shell calls it on a timer — so the first draw
 * shows the current session and this fills the rest in a moment later. Fire and
 * forget for the same reason `party-loot-panel` does it: a storage read has no
 * business holding up a redraw.
 * @returns {Promise<void>}
 */
async function refreshHistory() {
    try {
        const loaded = await lootLogHistory._load();
        // The first read always redraws, even when it came back empty: the body
        // on screen is the "reading…" note, and leaving it there reads as the
        // panel having hung rather than as an empty history
        const changed = !historyLoaded || loaded.length !== historicalEntries.length;
        historicalEntries = loaded;
        historyLoaded = true;
        if (changed) lootLogPivotPanel.render();
    } catch (error) {
        console.error('[LootLogPivot] Reading stored history failed:', error);
        historyLoaded = true;
    }
}

/**
 * The game's own display order for a skill, so the XP lines read the way the
 * skill list does rather than in whatever order the payload arrived in.
 * @param {string} skillHrid - e.g. `/skills/milking`
 * @returns {number}
 */
function skillSortIndex(skillHrid) {
    return dataManager.getInitClientData()?.skillDetailMap?.[skillHrid]?.sortIndex ?? 999;
}

/**
 * A skill's display name, for the icon's tooltip.
 * @param {string} skillHrid - e.g. `/skills/milking`
 * @returns {string}
 */
function skillName(skillHrid) {
    const details = dataManager.getInitClientData()?.skillDetailMap?.[skillHrid];
    return details?.name || skillHrid.split('/').pop().replace(/_/g, ' ');
}

/**
 * Everything one row needs to be drawn and sorted.
 *
 * Prices are resolved here rather than in `loot-log-analytics.js` so the
 * arithmetic stays testable without a market: `calculateTotalValue` is reused
 * from the loot log itself, which is what makes a row's Value agree with the
 * figure the same run shows in the panel it came from.
 *
 * @param {Object} row - From `aggregatePivotRows`
 * @returns {Object}
 */
export function buildRowView(row) {
    const { askTotal, bidTotal } = lootLogStats.calculateTotalValue(row.drops);
    const rates = computeRowRates(row, askTotal, bidTotal, skillSortIndex);

    const name = lootLogStats.getActionName(row.actionHrid);
    const category = lootLogStats.getActionCategory(row.actionHrid);
    const tier = row.difficultyTier ? ` (Tier ${row.difficultyTier})` : '';

    return {
        row,
        key: `${row.actionHrid}::${row.difficultyTier ?? ''}`,
        displayName: category ? `${category} — ${name}${tier}` : `${name}${tier}`,
        askTotal,
        bidTotal,
        ...rates,
    };
}

/**
 * The rows to draw: aggregated, priced, filtered and sorted.
 * @returns {Array<Object>}
 */
function visibleRows() {
    const entries = mergeCurrentAndHistoricalEntries(currentEntries, historicalEntries);
    const views = aggregatePivotRows(entries).map(buildRowView);

    const needle = filterText.trim().toLowerCase();
    const matching = needle ? views.filter((view) => view.displayName.toLowerCase().includes(needle)) : views;

    const column = COLUMNS.find((col) => col.key === sortKey) || COLUMNS[2];
    matching.sort((a, b) => {
        const left = column.sortValue(a);
        const right = column.sortValue(b);
        if (left < right) return sortDesc ? 1 : -1;
        if (left > right) return sortDesc ? -1 : 1;
        return 0;
    });
    return matching;
}

/**
 * Re-sort by a column: the same column again reverses it, a new one starts
 * descending, which is what a table of "how much" is asked for first.
 * @param {string} key - A `COLUMNS` key
 * @returns {void}
 */
function sortBy(key) {
    if (sortKey === key) {
        sortDesc = !sortDesc;
    } else {
        sortKey = key;
        sortDesc = true;
    }
    lootLogPivotPanel.render();
}

/**
 * A cell.
 * @param {string} text - What it says
 * @param {string} [color] - Ink
 * @returns {HTMLElement}
 */
function cell(text, color = '#e8ecf5') {
    const td = document.createElement('td');
    td.textContent = text;
    Object.assign(td.style, {
        padding: '4px 6px',
        verticalAlign: 'top',
        whiteSpace: 'nowrap',
        color,
    });
    return td;
}

/**
 * A pair of figures at ask and bid, or an em dash when both are nothing.
 * @param {number} ask - At ask
 * @param {number} bid - At bid
 * @returns {HTMLElement}
 */
function pairCell(ask, bid) {
    if (!ask && !bid) return cell('—', ROW_COLORS.dim);
    return cell(`${formatKMB(ask)} / ${formatKMB(bid)}`, ROW_COLORS.gold);
}

/**
 * The XP cell: one line per skill, plus a summed line for the actions that pay
 * more than one. A single-skill row's total would only repeat the line above it.
 * @param {Object} view - From `buildRowView`
 * @returns {HTMLElement}
 */
function xpCell(view) {
    const td = document.createElement('td');
    Object.assign(td.style, { padding: '4px 6px', verticalAlign: 'top' });

    if (view.xpEntries.length === 0) {
        td.textContent = '—';
        td.style.color = ROW_COLORS.dim;
        return td;
    }

    for (const xp of view.xpEntries) {
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' });

        const icon = skillIcon(xp.skillHrid.split('/').pop(), 13);
        line.title = skillName(xp.skillHrid);
        line.appendChild(icon);

        const rate = document.createElement('span');
        rate.textContent = `${formatKMB(xp.perHour)}/hr`;
        rate.style.color = ROW_COLORS.accent;

        const total = document.createElement('span');
        total.textContent = ` (${formatKMB(xp.amount)})`;
        total.style.color = ROW_COLORS.dim;

        line.append(rate, total);
        td.appendChild(line);
    }

    if (view.xpEntries.length > 1) {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            whiteSpace: 'nowrap',
            marginTop: '3px',
            paddingTop: '3px',
            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
        });

        const label = document.createElement('span');
        label.textContent = 'Total';
        label.style.color = ROW_COLORS.dim;

        const rate = document.createElement('span');
        rate.textContent = `${formatKMB(view.totalXpPerHour)}/hr`;
        Object.assign(rate.style, { color: ROW_COLORS.accent, fontWeight: 'bold' });

        line.append(label, rate);
        line.className = 'mwi-loot-log-xp-total';
        td.appendChild(line);
    }

    return td;
}

/**
 * One action's row, and the fold underneath it holding the date range and the
 * item-by-item breakdown.
 * @param {HTMLElement} tbody - Where it goes
 * @param {Object} view - From `buildRowView`
 * @returns {void}
 */
function drawRow(tbody, view) {
    const { row } = view;
    const tr = document.createElement('tr');
    Object.assign(tr.style, { borderBottom: '1px solid rgba(255, 255, 255, 0.06)', cursor: 'pointer' });

    const nameCell = document.createElement('td');
    Object.assign(nameCell.style, { padding: '4px 6px', verticalAlign: 'top' });
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px' });
    wrap.appendChild(spriteIcon(row.actionHrid, 16, 'actions'));
    const label = document.createElement('span');
    label.textContent = view.displayName;
    wrap.appendChild(label);
    nameCell.appendChild(wrap);

    const sessions = document.createElement('div');
    sessions.textContent = `${numberFormatter(row.entryCount)} session${row.entryCount === 1 ? '' : 's'}`;
    Object.assign(sessions.style, { color: ROW_COLORS.dim, fontSize: '0.85em', marginTop: '1px' });
    nameCell.appendChild(sessions);
    tr.appendChild(nameCell);

    tr.appendChild(cell(numberFormatter(row.actionCount)));
    tr.appendChild(cell(shortDuration(row.totalTimeMs / 1000)));
    tr.appendChild(xpCell(view));
    tr.appendChild(pairCell(view.askTotal, view.bidTotal));
    tr.appendChild(pairCell(view.goldPerHourAsk, view.goldPerHourBid));
    tbody.appendChild(tr);

    if (!expanded.has(view.key)) {
        tr.addEventListener('click', () => {
            expanded.add(view.key);
            lootLogPivotPanel.render();
        });
        return;
    }

    tr.addEventListener('click', () => {
        expanded.delete(view.key);
        lootLogPivotPanel.render();
    });

    const detailRow = document.createElement('tr');
    const detailCell = document.createElement('td');
    detailCell.colSpan = COLUMNS.length;
    Object.assign(detailCell.style, { padding: '2px 6px 8px 22px', background: 'rgba(255, 255, 255, 0.02)' });

    if (row.earliestStartMs != null && row.latestEndMs != null) {
        const range = document.createElement('div');
        range.textContent = `${formatDateTime(new Date(row.earliestStartMs))} → ${formatDateTime(
            new Date(row.latestEndMs)
        )}`;
        Object.assign(range.style, { color: ROW_COLORS.dim, fontSize: '0.9em', marginBottom: '3px' });
        detailCell.appendChild(range);
    }

    // The same breakdown the loot log's own entries expand into, so an action's
    // drops read identically in both places
    detailCell.appendChild(lootLogStats.buildItemBreakdown(row.drops));
    detailRow.appendChild(detailCell);
    tbody.appendChild(detailRow);
}

/**
 * The search box and what it is searching.
 * @param {HTMLElement} body - Panel body
 * @param {number} rowCount - How many actions matched
 * @returns {void}
 */
function drawToolbar(body, rowCount) {
    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' });

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Filter by action…';
    search.value = filterText;
    Object.assign(search.style, {
        flex: '1',
        minWidth: '0',
        padding: '3px 6px',
        borderRadius: '4px',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        background: 'rgba(255, 255, 255, 0.05)',
        color: '#e8ecf5',
        fontSize: '11px',
    });
    // A redraw while the box has focus is suppressed by the shell, so the value
    // is only ever read back out of module state when the caret is elsewhere
    search.addEventListener('input', () => {
        filterText = search.value;
        rowLimit = PAGE_SIZE;
        lootLogPivotPanel.render();
        const box = lootLogPivotPanel.panel?.querySelector('input[type="text"]');
        box?.focus();
        box?.setSelectionRange(box.value.length, box.value.length);
    });
    bar.appendChild(search);

    const count = document.createElement('span');
    count.textContent = `${numberFormatter(rowCount)} action${rowCount === 1 ? '' : 's'}`;
    count.style.color = ROW_COLORS.dim;
    count.style.whiteSpace = 'nowrap';
    bar.appendChild(count);

    body.appendChild(bar);
}

/**
 * The grand total, over everything the filter left showing.
 * @param {HTMLElement} body - Panel body
 * @param {Array<Object>} views - Rows after filtering
 * @returns {void}
 */
function drawFooter(body, views) {
    const totalMs = views.reduce((sum, view) => sum + view.row.totalTimeMs, 0);
    const totalActions = views.reduce((sum, view) => sum + view.row.actionCount, 0);
    const ask = views.reduce((sum, view) => sum + view.askTotal, 0);
    const bid = views.reduce((sum, view) => sum + view.bidTotal, 0);

    const footer = document.createElement('div');
    Object.assign(footer.style, {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '10px',
        paddingTop: '5px',
        borderTop: '1px solid rgba(255, 255, 255, 0.15)',
        color: ROW_COLORS.dim,
        flex: '0 0 auto',
    });

    const left = document.createElement('span');
    left.textContent = `${numberFormatter(totalActions)} actions over ${shortDuration(totalMs / 1000)}`;

    const right = document.createElement('span');
    right.textContent = `Total value (ask/bid): ${formatKMB(ask)} / ${formatKMB(bid)}`;
    right.style.color = ROW_COLORS.gold;

    footer.append(left, right);
    body.appendChild(footer);
}

/**
 * Draw the whole panel body.
 * @param {HTMLElement} body - Panel body
 * @returns {void}
 */
export function draw(body) {
    if (!historyLoaded) refreshHistory();

    const views = visibleRows();
    drawToolbar(body, views.length);

    if (views.length === 0) {
        body.appendChild(
            panelNote(
                historyLoaded
                    ? 'Nothing recorded yet. Open the Loot Log after an action finishes and this fills in.'
                    : 'Reading stored history…'
            )
        );
        return;
    }

    const scroller = document.createElement('div');
    Object.assign(scroller.style, { flex: '1', overflow: 'auto', minHeight: '0' });

    const table = document.createElement('table');
    Object.assign(table.style, { width: '100%', borderCollapse: 'collapse', fontSize: '11px' });

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const column of COLUMNS) {
        const th = document.createElement('th');
        th.textContent = sortKey === column.key ? `${column.label} ${sortDesc ? '▼' : '▲'}` : column.label;
        Object.assign(th.style, {
            textAlign: 'left',
            padding: '4px 6px',
            borderBottom: `1px solid ${ACCENT}55`,
            color: ROW_COLORS.dim,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            position: 'sticky',
            top: '0',
            background: 'rgba(14, 16, 22, 0.97)',
        });
        th.addEventListener('click', () => sortBy(column.key));
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    for (const view of views.slice(0, rowLimit)) drawRow(tbody, view);

    table.append(thead, tbody);
    scroller.appendChild(table);
    body.appendChild(scroller);

    if (views.length > rowLimit) {
        const more = document.createElement('button');
        more.textContent = `Show ${Math.min(PAGE_SIZE, views.length - rowLimit)} more of ${numberFormatter(
            views.length
        )}`;
        Object.assign(more.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            color: ROW_COLORS.dim,
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '4px',
            padding: '2px 6px',
            fontSize: '11px',
            cursor: 'pointer',
            flex: '0 0 auto',
        });
        more.addEventListener('click', () => {
            rowLimit += PAGE_SIZE;
            lootLogPivotPanel.render();
        });
        body.appendChild(more);
    }

    drawFooter(body, views);
}

/**
 * What the recorded runs actually paid.
 */
export const lootLogPivotPanel = createPanel({
    id: PANEL_ID,
    title: '📊 Loot & XP Analytics',
    size: { width: 640, height: 480 },
    accent: ACCENT,
    refreshMs: REFRESH_MS,
    draw,
});

/**
 * Put the 📊 button beside the loot log's own Refresh.
 * @param {HTMLElement} anchor - An element inside the loot log panel
 * @returns {void}
 */
export function injectPivotButton(anchor) {
    const panel = anchor?.closest?.('[class*="LootLogPanel_lootLogPanel"]') || anchor?.parentElement;
    if (!panel) return;
    if (panel.querySelector('.mwi-loot-log-pivot-btn')) return;

    const refresh = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Refresh');
    if (!refresh) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mwi-loot-log-pivot-btn';
    button.textContent = '📊';
    button.title = 'Loot & XP Analytics — what every recorded action actually paid, per hour';
    Object.assign(button.style, {
        marginLeft: '8px',
        background: 'none',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '1em',
        padding: '2px 8px',
        lineHeight: '1.4',
    });
    button.addEventListener('click', () => lootLogPivotPanel.toggle());
    refresh.insertAdjacentElement('afterend', button);
}

const unregisterHandlers = [];

export default {
    name: 'Loot Log Analytics',
    initialize: async () => {
        if (!config.getSetting('lootLogPivot')) return;

        // Its own subscription rather than borrowing `lootLogStats`': the pivot
        // is a separate setting and has to work with the loot log's other
        // features switched off
        const onLootLog = (data) => {
            if (!data || !Array.isArray(data.lootLog)) return;
            currentEntries = data.lootLog;
        };
        webSocketHook.on('loot_log_updated', onLootLog);
        unregisterHandlers.push(() => webSocketHook.off('loot_log_updated', onLootLog));

        unregisterHandlers.push(
            domObserver.onClass('LootLogPivotButton', 'LootLogPanel_actionLoots__3oTid', injectPivotButton)
        );

        // The stored history is per character; the shell already closes the
        // panel on a switch, and this makes sure it does not reopen holding the
        // departing character's runs
        const onSwitch = () => resetPivotState();
        dataManager.on?.('character_switched', onSwitch);
        unregisterHandlers.push(() => dataManager.off?.('character_switched', onSwitch));
    },
    cleanup: () => {
        lootLogPivotPanel.hide?.({ remember: false });
        document.querySelectorAll('.mwi-loot-log-pivot-btn').forEach((btn) => btn.remove());
        unregisterHandlers.forEach((fn) => fn?.());
        unregisterHandlers.length = 0;
        resetPivotState();
    },
};
