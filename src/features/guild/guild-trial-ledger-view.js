/**
 * The ledger and the planner, drawn.
 *
 * Two questions a guild leader asks that no surface in the game answers, in one
 * panel because they are the same conversation held at two ends of a week: who
 * turned up and what they did (`guild-trial-ledger.js`), and whether the list
 * about to sign up can actually clear the tier (`guild-trial-composition.js`).
 *
 * Everything below is drawing. The arithmetic, the lint rules and the storage
 * all live in those two modules and are tested without a DOM; what is here is
 * the sortable table, the window selector, the coverage line, the CSV button and
 * the paste box — plus the one piece of state a redraw must not lose, which is
 * whatever the user has half-typed into the roster box.
 *
 * ## Why a panel and not a tab on the guild page
 *
 * `guild-trials.js` decorates the game's own trial cards, and those cards are
 * only on screen while the guild page is open on the right tab. The ledger is
 * read *between* trials — on a Sunday, deciding who to message — so it is a
 * floating panel and an overlay row, reachable whatever the page is showing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import { loadLoadouts } from './guild-loadouts.js';
import {
    LEDGER_COLUMNS,
    LEDGER_CSV_COLUMNS,
    LEDGER_WINDOWS,
    foldLedgerCycles,
    ledgerCsvRows,
    ledgerTotalsRow,
    loadLedgerCycles,
    observedCoverage,
    sortLedgerRows,
} from './guild-trial-ledger.js';
import {
    compositionStatusLine,
    lintComposition,
    parseRosterNames,
    resolveRosterKits,
} from './guild-trial-composition.js';
import {
    ACCURACY_METRICS,
    OUTLIER_THRESHOLD_PCT,
    archivedAccuracyTrend,
    summarizeWeekAccuracy,
    traceGapAccuracyPairing,
} from './guild-trial-accuracy.js';
import { loadTrialRecord, loadTrialStats } from './guild-trials-store.js';

const ACCENT = '#b0d8ff';

/** Ink per check status, so the checklist reads at a glance */
const STATUS_COLOR = {
    ok: ROW_COLORS.good,
    gap: ROW_COLORS.bad,
    unknown: ROW_COLORS.gold,
};

/** The mark in front of a check */
const STATUS_MARK = { ok: '✓', gap: '✗', unknown: '?' };

/**
 * Everything the panel remembers between redraws.
 *
 * A panel rebuilds its whole body every few seconds, so anything the user is in
 * the middle of — a sort they chose, a roster they pasted — has to live out here
 * or it is thrown away under their hands.
 */
const state = {
    /** Cycle records as last read; the panel never reads storage while drawing */
    cycles: [],
    /** Whether a read has happened at all, so "empty" and "not looked yet" differ */
    loaded: false,
    /** Which {@link LEDGER_WINDOWS} key is selected */
    window: '4',
    sortKey: 'damageShare',
    sortDirection: 'desc',
    /** Substring the member column is filtered to, as typed into the search box */
    filterText: '',
    /** The roster box's contents, as typed */
    rosterText: '',
    /** Whether the box has ever been filled from the last cycle */
    rosterSeeded: false,
    /** The tier being aimed at, as typed */
    tier: '',
    /** Kits, keyed by lowercased name, from the stored loadouts */
    loadouts: {},
    /** This week's per-trial attribution accuracy, from `summarizeWeekAccuracy` */
    accuracy: [],
    /** Archived cycles' compact accuracy, from `archivedAccuracyTrend`, oldest first */
    accuracyTrend: [],
};

/**
 * Bumped at the start of every {@link refreshLedgerView} call, so a call whose
 * reads land after a newer one's can tell it is stale.
 *
 * Two quick window changes both fire-and-forget a refresh, and storage reads
 * are not FIFO: a "4 cycles" read outstanding when the selector jumps to
 * "12 cycles" can resolve *after* the twelve-cycle read does, overwriting the
 * freshly drawn table with the stale, narrower window's data.
 */
let refreshGeneration = 0;

/** Reset every remembered thing. Exported for tests, which must not inherit a run. */
export function resetLedgerView() {
    state.cycles = [];
    state.loaded = false;
    state.window = '4';
    state.sortKey = 'damageShare';
    state.sortDirection = 'desc';
    state.filterText = '';
    state.rosterText = '';
    state.rosterSeeded = false;
    state.tier = '';
    state.loadouts = {};
    state.accuracy = [];
    state.accuracyTrend = [];
    // Bumped, never zeroed. Zeroing it handed the *next* refresh the same
    // generation number an in-flight one was already holding: the switch
    // handler below calls this and then `refreshLedgerView()`, so after a
    // single-refresh session the departing character's outstanding reads
    // carried generation 1 and the arriving character's fresh run was also
    // generation 1 — the staleness guard passed, and whichever set of reads
    // resolved last drew. Storage reads are explicitly not FIFO here, so the
    // departed guild's cycles, kits and accuracy could land on top of the
    // arriving one's. A reset means "abandon everything in flight", which is
    // what a bump says and what a zero cannot.
    refreshGeneration += 1;
}

/** @returns {string|null} The guild whose ledger is being drawn */
function guildName() {
    return guildXPTracker.getOwnGuildName?.() || null;
}

/** @returns {string[]} Every member the XP tracker knows, for the no-show rows */
function rosterNames() {
    return (guildXPTracker.getMemberList?.() || []).map((member) => member?.name).filter(Boolean);
}

/**
 * Read the ledger and the stored kits, then redraw.
 *
 * Fire-and-forget from the panel's opening and from the window selector: a
 * storage read has no business holding up a draw, and the panel refreshes on its
 * own timer anyway.
 *
 * @returns {Promise<void>}
 */
export async function refreshLedgerView() {
    const generation = ++refreshGeneration;
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    const guild = guildName();
    const chosen = LEDGER_WINDOWS.find((entry) => entry.key === state.window) || LEDGER_WINDOWS[0];

    try {
        const cycles = await loadLedgerCycles(guild, characterId, { cycles: chosen.cycles });
        const record = await loadLoadouts(characterId, guild);
        // The accuracy card reads a different pair of stores from the ledger's:
        // this week's measured-vs-reported blob, which the ladder's rollover
        // discards, and the four archived cycles the rollover folds a compact
        // summary into. Both are tolerated failing — an unreadable accuracy
        // section must not cost the panel its table
        const stats = await loadTrialStats().catch(() => null);
        const trialRecord = await loadTrialRecord(guild, Date.now(), characterId).catch(() => null);
        // A newer refresh already started while these reads were in flight —
        // storage reads do not resolve in call order, so writing this one's
        // answer now would draw the window the user has already moved past
        if (generation !== refreshGeneration) return;
        // …and the answer belongs to the character it was asked for. The
        // generation alone covers a switch only because the switch handler
        // starts a refresh of its own; a guild change, or any teardown that
        // does not, would leave this writing one character's ledger into
        // another's panel.
        if (characterId !== (dataManager.getCurrentCharacterId?.() ?? null)) return;

        state.cycles = cycles;
        state.loaded = true;
        state.accuracy = summarizeWeekAccuracy(stats?.trials);
        state.accuracyTrend = archivedAccuracyTrend(trialRecord?.history);

        const kits = {};
        for (const entry of Object.values(record?.players || {})) {
            const key = String(entry?.name || '')
                .trim()
                .toLowerCase();
            if (!key) continue;
            kits[key] = { name: entry.name, abilities: entry.abilities || [], stats: entry.stats || null };
        }
        state.loadouts = kits;
    } catch (error) {
        console.error('[GuildTrialLedgerView] Refreshing the ledger failed:', error);
        if (generation !== refreshGeneration) return;
        state.loaded = true;
    }

    guildTrialLedgerPanel.render();
}

/**
 * Only the rows whose member name contains the typed text.
 *
 * A member search, not a data filter: `trialsRun` and the coverage sentence
 * stay computed from the whole window regardless, because a search narrowing
 * the table to one name must not make the ledger claim fewer trials happened.
 * Blank or whitespace-only text is "not searching" rather than "match
 * nothing", so an empty box shows the whole table.
 *
 * @param {Array<Object>} rows - From {@link foldLedgerCycles}
 * @param {string} query - As typed into the search box
 * @returns {Array<Object>} The rows whose name matches
 */
export function filterLedgerRows(rows, query) {
    const wanted = String(query || '')
        .trim()
        .toLowerCase();
    if (!wanted) return rows || [];
    return (rows || []).filter((row) =>
        String(row?.name || '')
            .toLowerCase()
            .includes(wanted)
    );
}

/**
 * The table as it currently stands: folded, filtered, sorted, and with its coverage.
 *
 * Exported because it is the whole of the table's logic and the drawing below is
 * not worth a test — a caller hands it cycles and a roster and gets back exactly
 * what the panel puts on screen.
 *
 * @param {Object} [options] - Overrides, for tests
 * @param {Array<Object>} [options.cycles] - Cycle records
 * @param {Array<string>} [options.roster] - Guild members, for no-show rows
 * @param {string} [options.sortKey] - A {@link LEDGER_COLUMNS} key
 * @param {'asc'|'desc'} [options.sortDirection] - Which way
 * @param {string} [options.filterText] - Member-name search, from {@link filterLedgerRows}
 * @returns {{rows: Array<Object>, trialsRun: number, coverage: Object, cycles: number}} The table
 */
export function buildLedgerTable({
    cycles = state.cycles,
    roster = null,
    sortKey = state.sortKey,
    sortDirection = state.sortDirection,
    filterText = state.filterText,
} = {}) {
    const folded = foldLedgerCycles(cycles, { rosterNames: roster ?? rosterNames() });
    return {
        rows: sortLedgerRows(filterLedgerRows(folded.rows, filterText), sortKey, sortDirection),
        trialsRun: folded.trialsRun,
        trialsKnown: folded.trialsKnown,
        cycles: folded.cycles,
        coverage: observedCoverage(cycles),
    };
}

/**
 * The observed-coverage sentence.
 *
 * The current week is excluded from the ratio — its trials have not all been
 * run — so the sentence says so rather than letting the reader assume the
 * figure covers everything on screen.
 *
 * @param {Object} coverage - From `observedCoverage`
 * @returns {string} e.g. `4 of 8 trials watched across 4 cycles`
 */
export function coverageLine(coverage) {
    const thisWeek = coverage?.inProgress ? ' This week is still running and is not counted yet.' : '';
    if (!coverage?.cycles) {
        return coverage?.inProgress ? `No completed cycles yet.${thisWeek}` : 'No cycles recorded yet.';
    }
    return (
        `${coverage.observed} of ${coverage.expected} trials watched across ${coverage.cycles} cycle` +
        `${coverage.cycles === 1 ? '' : 's'}${thisWeek}`
    );
}

/** A percentage, or a dash for a figure nothing measured */
function percent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

/** Minutes, or a dash */
function minutes(ms) {
    return Number.isFinite(ms) && ms > 0 ? `${Math.round(ms / 60000)}m` : '—';
}

/**
 * A timestamp as the local calendar day it fell on, `YYYY-MM-DD`.
 *
 * The reader's own day, not Greenwich's: an evening trial folded through
 * `toISOString` would print tomorrow's date for anyone west of Greenwich.
 *
 * @param {number} timestamp - Epoch ms
 * @returns {string} `YYYY-MM-DD`
 */
function localDay(timestamp) {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * One member's participation as a sentence, with what is unknown said outright.
 *
 * The guild runs several trials at once and this client watches at most one, so
 * "took part in 1 of 1" alongside "2 trials nothing here could see" is the whole
 * of what is honestly known. The old wording — "joined 1 of 4 recorded trials" —
 * read as an accusation about three trials nobody could have seen them in.
 *
 * @param {Object} row - A folded ledger row
 * @returns {string} e.g. `Alice took part in 2 of 2 trials (1 more nothing here could see)`
 */
export function participationText(row) {
    const unknown = Number(row?.unknownTrials) || 0;
    const tail = unknown ? ` (${unknown} more nothing here could see)` : '';
    if (!row?.observable) {
        return unknown
            ? `${row.name} was in none of the trials this client watched; ${unknown} ran that it could not see`
            : `${row.name} has no trials recorded`;
    }
    return `${row.name} took part in ${row.participated} of ${row.observable} trials${tail}`;
}

/**
 * "Last attended" as a sentence fragment, from a row's `lastSeen` timestamp.
 *
 * `lastSeen` is folded from whichever cycles are in the current window, so a
 * member outside the window entirely has never had a chance to set it — that
 * is a different claim from "watched and never showed", which is what
 * {@link ledgerCellText}'s no-show label already says.
 *
 * @param {Object} row - A folded ledger row
 * @returns {string} e.g. `last attended 2026-08-14` or `never attended in this window`
 */
export function lastAttendedText(row) {
    if (!Number.isFinite(row?.lastSeen)) return 'never attended in this window';
    return `last attended ${localDay(row.lastSeen)}`;
}

/**
 * The cell text for one column of one row.
 * @param {Object} row - A folded row
 * @param {string} key - A {@link LEDGER_COLUMNS} key
 * @returns {string} What the cell says
 */
export function ledgerCellText(row, key) {
    switch (key) {
        case 'name':
            if (row.absent) return `${row.name} (no-show)`;
            // Nothing here could see any trial they might have been in — a
            // different claim from having skipped the ones it did see
            if (row.observable === 0 && row.unknownTrials > 0) return `${row.name} (not seen)`;
            return row.name;
        case 'trials':
            return String(row.trials);
        case 'attendance':
            // A percentage of a denominator that does not cover every trial the
            // member could have been in is a made-up figure. Where anything is
            // unknown the cell counts instead of dividing.
            if (!Number.isFinite(row.attendance)) return '—';
            if (row.unknownTrials > 0) return `${row.participated} of ${row.observable}`;
            return percent(row.attendance);
        case 'damageShare':
            return percent(row.damageShare);
        case 'healingShare':
            return percent(row.healingShare);
        case 'tankShare':
            return percent(row.tankShare);
        case 'deaths':
            return String(row.deaths);
        case 'starvedMs':
            return minutes(row.starvedMs);
        default:
            return '—';
    }
}

/**
 * One row's line for {@link ledgerTableText}: the same figures the table cells
 * show, in a sentence rather than a grid — plain text has no columns to line
 * cells up under.
 * @param {Object} row - A folded row, or the totals row from {@link ledgerTotalsRow}
 * @returns {string} e.g. `Alice — 4 trials (50.0%), dmg 32.1%, heal 10.0%, tank 5.0%, 1 death`
 */
function ledgerRowLine(row) {
    const attendance = row?.absent
        ? 'no-show'
        : row?.observable === 0 && row?.unknownTrials > 0
          ? 'not seen'
          : `${row.trials} trials (${ledgerCellText(row, 'attendance')})`;
    const deaths = Number(row?.deaths) || 0;
    return (
        `${row.name} — ${attendance}, dmg ${ledgerCellText(row, 'damageShare')}, ` +
        `heal ${ledgerCellText(row, 'healingShare')}, tank ${ledgerCellText(row, 'tankShare')}, ` +
        `${deaths} death${deaths === 1 ? '' : 's'}`
    );
}

/**
 * The table as it currently stands, as plain text, for pasting into chat.
 *
 * The same rows the table shows — already filtered, sorted and windowed — plus
 * the totals line, since a report without the sum is the one thing a reader
 * would go back and add up themselves.
 *
 * @param {Object} table - From {@link buildLedgerTable}
 * @returns {string} A short report, one row per line
 */
export function ledgerTableText(table) {
    const rows = table?.rows || [];
    if (!rows.length) return 'No ledger rows to copy.';

    const trialsRun = table?.trialsRun || 0;
    const header = `Guild trial ledger — ${trialsRun} trial${trialsRun === 1 ? '' : 's'} in window`;
    const lines = rows.map(ledgerRowLine);
    const totals = ledgerTotalsRow(rows, trialsRun);

    return [header, ...lines, ...(totals ? [ledgerRowLine(totals)] : [])].join('\n');
}

/**
 * A small control button in the guild panels' idiom.
 * @param {string} label - Button text
 * @param {string} title - Tooltip
 * @param {Function} onClick - Action
 * @returns {HTMLElement} The button
 */
function controlButton(label, title, onClick) {
    const button = document.createElement('button');
    button.textContent = label;
    button.title = title;
    button.style.cssText =
        'background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; ' +
        'border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 12px;';
    button.addEventListener('click', onClick);
    return button;
}

/** Draw the window selector and the CSV button */
function drawControls(card, table) {
    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });

    const select = document.createElement('select');
    select.classList.add('toolasha-select');
    select.style.cssText =
        'background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; ' +
        'border-radius: 5px; padding: 3px 6px; font-size: 12px;';
    for (const window of LEDGER_WINDOWS) {
        const option = document.createElement('option');
        option.value = window.key;
        option.textContent = window.label;
        if (window.key === state.window) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener('change', () => {
        state.window = select.value;
        refreshLedgerView();
    });

    bar.appendChild(select);

    const search = document.createElement('input');
    search.type = 'text';
    search.id = 'mwi-ledger-filter-input';
    search.placeholder = 'Filter by name…';
    search.value = state.filterText;
    search.title = 'Narrows the table to members whose name contains this. Trials run and coverage stay unaffected.';
    search.style.cssText =
        'flex: 1 1 100px; min-width: 80px; background: rgba(255,255,255,0.08); ' +
        'border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; border-radius: 5px; padding: 3px 6px; ' +
        'font-size: 12px;';
    search.addEventListener('input', () => {
        state.filterText = search.value;
        const cursor = search.selectionStart;
        guildTrialLedgerPanel.render();
        // A full redraw rebuilds this very box; find the new one and put the
        // caret back where it was, or the second keystroke would type into a
        // box that just lost focus under the user's hands
        const revived = document.getElementById('mwi-ledger-filter-input');
        if (revived) {
            revived.focus();
            revived.setSelectionRange(cursor, cursor);
        }
    });
    bar.appendChild(search);

    bar.appendChild(
        controlButton('Export CSV', 'The table as it stands, with raw numbers a spreadsheet can sort.', () => {
            const csv = toCsv(ledgerCsvRows(table.rows, table.trialsRun), LEDGER_CSV_COLUMNS);
            downloadCsv(csvFilename('guild-trial-ledger'), csv);
        })
    );
    bar.appendChild(
        controlButton('Copy as text', 'The table as it stands, as a report a guild chat can read.', (event) => {
            const button = event.currentTarget;
            navigator.clipboard
                ?.writeText?.(ledgerTableText(table))
                ?.then(() => {
                    const original = button.textContent;
                    button.textContent = 'Copied!';
                    setTimeout(() => {
                        button.textContent = original;
                    }, 1500);
                })
                ?.catch(() => {});
        })
    );
    card.appendChild(bar);
}

/** Draw the sortable table itself */
function drawTable(card, table) {
    if (!table.rows.length) {
        card.appendChild(
            panelNote(
                state.loaded
                    ? 'Nothing recorded yet. The ledger fills in as trials you have the guild panel open for finish.'
                    : 'Reading the ledger…'
            )
        );
        return;
    }

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, { overflowX: 'auto' });

    const element = document.createElement('table');
    Object.assign(element.style, { borderCollapse: 'collapse', width: '100%', fontSize: '11px' });

    const head = document.createElement('tr');
    for (const column of LEDGER_COLUMNS) {
        const cell = document.createElement('th');
        const active = state.sortKey === column.key;
        cell.textContent = active ? `${column.label} ${state.sortDirection === 'asc' ? '▲' : '▼'}` : column.label;
        Object.assign(cell.style, {
            textAlign: column.numeric ? 'right' : 'left',
            padding: '2px 5px',
            cursor: 'pointer',
            color: active ? ACCENT : 'rgba(232, 236, 245, 0.6)',
            whiteSpace: 'nowrap',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
        });
        cell.addEventListener('click', () => {
            if (state.sortKey === column.key) {
                state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortKey = column.key;
                state.sortDirection = column.numeric ? 'desc' : 'asc';
            }
            guildTrialLedgerPanel.render();
        });
        head.appendChild(cell);
    }
    element.appendChild(head);

    for (const entry of table.rows) {
        const line = document.createElement('tr');
        for (const column of LEDGER_COLUMNS) {
            const cell = document.createElement('td');
            cell.textContent = ledgerCellText(entry, column.key);
            Object.assign(cell.style, {
                textAlign: column.numeric ? 'right' : 'left',
                padding: '2px 5px',
                whiteSpace: 'nowrap',
                color: entry.absent ? ROW_COLORS.bad : entry.observable === 0 ? ROW_COLORS.dim : '#e8ecf5',
            });
            line.appendChild(cell);
        }
        line.title =
            `${participationText(entry)}, ${lastAttendedText(entry)}.\n` +
            `${formatKMB(entry.damage)} damage · ${formatKMB(entry.healing)} healing · ` +
            `${formatKMB(entry.damageTaken)} taken · ${entry.deaths} death${entry.deaths === 1 ? '' : 's'}.\n` +
            'Shares are of what was actually measured over the selected window.';
        element.appendChild(line);
    }

    const totals = ledgerTotalsRow(table.rows, table.trialsRun);
    if (totals) {
        const line = document.createElement('tr');
        for (const column of LEDGER_COLUMNS) {
            const cell = document.createElement('td');
            cell.textContent = ledgerCellText(totals, column.key);
            Object.assign(cell.style, {
                textAlign: column.numeric ? 'right' : 'left',
                padding: '3px 5px',
                whiteSpace: 'nowrap',
                color: ACCENT,
                borderTop: '1px solid rgba(255,255,255,0.18)',
                fontWeight: '600',
            });
            line.appendChild(cell);
        }
        line.title =
            `Sum of every row shown, over the same window.\n` +
            `${formatKMB(totals.damage)} damage · ${formatKMB(totals.healing)} healing · ` +
            `${formatKMB(totals.damageTaken)} taken · ${totals.deaths} death${totals.deaths === 1 ? '' : 's'}.`;
        element.appendChild(line);
    }

    wrapper.appendChild(element);
    card.appendChild(wrapper);
}

/**
 * The names the box starts with: whoever was in the most recent recorded cycle.
 * @param {Array<Object>} cycles - Cycle records, oldest first
 * @returns {string[]} Names
 */
export function lastCycleParticipants(cycles) {
    const latest = (cycles || []).filter(Boolean).slice(-1)[0];
    return Object.values(latest?.members || {})
        .filter((member) => (member?.trials || 0) > 0)
        .map((member) => member.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

// ─── Attribution accuracy ───────────────────────────────────────────────────

/**
 * A signed percentage difference, or a word for the cases a number would lie about.
 *
 * `Infinity` is what {@link module:./guild-trial-accuracy.deltaPct} produces when
 * the game reported nothing and the stream measured something — real, and not a
 * percentage. Null is "nothing to compare", which is a dash.
 *
 * @param {number|null} value - Signed percent
 * @returns {string} e.g. `+3.2%`, `-11.0%`, `unreported`, `—`
 */
export function accuracyDeltaText(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (!Number.isFinite(value)) return 'unreported';
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/**
 * The match line: how many of the game's names the measurement actually found.
 *
 * The join is by display name and nothing else — see the module note in
 * `guild-trial-accuracy.js`. A name that did not join is stated as unmatched
 * rather than folded into the medians as a perfect or a total miss.
 *
 * @param {Object} accuracy - From `summarizeTrialAccuracy`
 * @returns {string} e.g. `9 of 10 names matched · 1 unmatched`
 */
export function accuracyMatchText(accuracy) {
    const players = accuracy?.players || 0;
    if (!players) return 'No names to match';
    const parts = [`${accuracy.matched} of ${players} names matched`];
    if (accuracy.unmatched) parts.push(`${accuracy.unmatched} unmatched`);
    if (accuracy.measuredOnly) parts.push(`${accuracy.measuredOnly} measured only`);
    return parts.join(' · ');
}

/**
 * One metric's line: the middle player's miss, and the worst one's.
 * @param {Object|null} held - A metric block from `summarizeTrialAccuracy`
 * @returns {string} e.g. `median +2.1% · worst -18.4% (8 players)`
 */
export function accuracyMetricText(held) {
    if (!held || !held.players) return 'nothing reported';
    return (
        `median ${accuracyDeltaText(held.median)} · worst ${accuracyDeltaText(held.worst)} ` +
        `(${held.players} player${held.players === 1 ? '' : 's'})`
    );
}

/** What the card says about its own join, wherever a tooltip has room for it */
const ACCURACY_JOIN_NOTE =
    'The game reports per-member totals at the end of a trial; the panel measures the same fight tick by tick. ' +
    'The two are joined by display name, so a rename mid-week leaves a name on one side only — counted as ' +
    'unmatched and kept out of every median rather than scored as a perfect or a total miss.';

/** Ink for a delta: past the outlier threshold is news, inside it is not */
function deltaColor(value, threshold = OUTLIER_THRESHOLD_PCT) {
    if (value === null || value === undefined) return ROW_COLORS.dim;
    if (!Number.isFinite(value)) return ROW_COLORS.bad;
    return Math.abs(value) >= threshold ? ROW_COLORS.gold : ROW_COLORS.good;
}

/** Draw one trial's accuracy block */
function drawTrialAccuracy(card, entry) {
    const { accuracy } = entry;
    const when = Number.isFinite(entry.at) ? ` (${localDay(entry.at)})` : '';

    card.appendChild(
        panelLine(
            `${entry.encounter}${when}`,
            accuracyDeltaText(accuracy.totals.damage.deltaPct),
            deltaColor(accuracy.totals.damage.deltaPct),
            'The whole party’s measured damage against the whole party’s reported damage, ' +
                'summed over the names that matched. The per-metric lines below are per player.'
        )
    );
    card.appendChild(panelLine('Names', accuracyMatchText(accuracy), ROW_COLORS.dim, ACCURACY_JOIN_NOTE));

    for (const metric of ACCURACY_METRICS) {
        const held = accuracy.metrics[metric.key];
        card.appendChild(
            panelLine(`  ${metric.label}`, accuracyMetricText(held), deltaColor(held?.median), metric.expectation)
        );
    }

    if (!accuracy.outliers.length) {
        card.appendChild(panelNote(`  No player past ${accuracy.threshold}% on any metric.`));
        return;
    }
    for (const row of accuracy.outliers.slice(0, 6)) {
        const label = ACCURACY_METRICS.find((metric) => metric.key === row.worstMetric)?.label || row.worstMetric;
        card.appendChild(
            panelLine(
                `  ${row.name}`,
                `${label} ${accuracyDeltaText(row.worstDeltaPct)}`,
                deltaColor(row.worstDeltaPct),
                `${formatKMB(row[row.worstMetric].measured)} measured against ` +
                    `${formatKMB(row[row.worstMetric].reported)} reported.`
            )
        );
    }
}

/**
 * Draw the attribution-accuracy card.
 *
 * The retrospective home for a figure that used to exist only inside a debug
 * export: how close the tick-by-tick measurement got to the game's own
 * accounting, this week and across the archived cycles.
 *
 * @param {HTMLElement} body - The panel body
 */
function drawAccuracy(body) {
    const card = panelCard(body, 'Attribution accuracy', ACCENT);

    card.appendChild(
        panelNote(
            'Healing and taken are inferred from health deltas and are expected to run wider than damage. ' +
                'A double-digit miss on those two is normal, not a fault.'
        )
    );

    if (!state.loaded) {
        card.appendChild(panelNote('Reading this week’s comparisons…'));
        return;
    }

    if (!state.accuracy.length) {
        card.appendChild(
            panelNote(
                'No comparison recorded this week. A trial only produces one if the panel was open when the ' +
                    'game sent its end-of-trial totals.'
            )
        );
    }
    for (const entry of state.accuracy) drawTrialAccuracy(card, entry);

    const trend = [...state.accuracyTrend].reverse();
    if (!trend.length) return;

    card.appendChild(panelLine('Archived cycles', `${trend.length} kept`, ROW_COLORS.dim, ACCURACY_JOIN_NOTE));
    for (const cycle of trend) {
        const label = Number.isFinite(cycle.weekStart) ? localDay(cycle.weekStart) : 'unknown week';
        if (!cycle.hasAccuracy) {
            card.appendChild(
                panelLine(
                    `  ${label}`,
                    'no accuracy data',
                    ROW_COLORS.dim,
                    'Archived before the accuracy summary existed. There is nothing in the entry to reconstruct it from.'
                )
            );
            continue;
        }
        const unmatched = cycle.unmatched ? `, ${cycle.unmatched} unmatched` : '';
        card.appendChild(
            panelLine(
                `  ${label}`,
                `dmg ${accuracyDeltaText(cycle.metrics.damage?.median)}`,
                deltaColor(cycle.metrics.damage?.median),
                `${cycle.trials} trial${cycle.trials === 1 ? '' : 's'}${unmatched}.\n` +
                    ACCURACY_METRICS.map(
                        (metric) => `${metric.label}: ${accuracyMetricText(cycle.metrics[metric.key])}`
                    ).join('\n')
            )
        );
    }

    // The pairing the trace-quality field was archived for: does a week with a
    // gappy trace sit alongside a wider damage delta than a clean one? Drawn
    // from the archive alone, and it refuses until there is enough on both
    // sides to say anything — one point per side is an anecdote, not a pairing.
    const pairing = traceGapAccuracyPairing(state.accuracyTrend);
    if (pairing.verdict === 'insufficient') {
        card.appendChild(
            panelLine(
                'Trace gaps vs accuracy',
                `too few to pair (${pairing.usable} usable)`,
                ROW_COLORS.dim,
                `Needs at least ${pairing.minCycles} archived cycles carrying both an accuracy figure and a ` +
                    `traced gap count, with clean and gappy traces both represented ` +
                    `(clean: ${pairing.clean}, gappy: ${pairing.gappy}). It fills in as cycles archive.`
            )
        );
    } else {
        card.appendChild(
            panelLine(
                'Trace gaps vs accuracy',
                `gappy ${accuracyDeltaText(pairing.gappy.medianAbsDelta)} over ${pairing.gappy.cycles} · ` +
                    `clean ${accuracyDeltaText(pairing.clean.medianAbsDelta)} over ${pairing.clean.cycles}`,
                ROW_COLORS.dim,
                'Median |damage delta| across archived cycles, split by whether that week’s trace had gaps over ' +
                    '5s. A pairing, not a cause — the same week produced both readings, and a roster change or a ' +
                    'mid-fight join cannot be told apart from trace damage here.'
            )
        );
    }
}

/** Draw the composition planner section */
function drawPlanner(body) {
    const card = panelCard(body, 'Roster composition', ACCENT);

    if (!state.rosterSeeded && !state.rosterText) {
        const seeded = lastCycleParticipants(state.cycles);
        if (seeded.length) {
            state.rosterText = seeded.join('\n');
            state.rosterSeeded = true;
        }
    }

    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });

    const tier = document.createElement('input');
    tier.type = 'number';
    tier.min = '1';
    tier.placeholder = 'Tier';
    tier.value = state.tier;
    tier.title = 'The tier you are going for — how many tanks the check wants depends on it.';
    tier.style.cssText =
        'width: 60px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); ' +
        'color: #e8ecf5; border-radius: 5px; padding: 3px 6px; font-size: 12px;';
    tier.addEventListener('input', () => {
        state.tier = tier.value;
    });
    bar.appendChild(tier);
    bar.appendChild(
        controlButton('Use last cycle', 'Replace the list with everyone the last recorded cycle saw.', () => {
            state.rosterText = lastCycleParticipants(state.cycles).join('\n');
            state.rosterSeeded = true;
            guildTrialLedgerPanel.render();
        })
    );
    card.appendChild(bar);

    const box = document.createElement('textarea');
    box.value = state.rosterText;
    box.placeholder = 'One name per line, or comma-separated.';
    box.rows = 4;
    box.style.cssText =
        'width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); color: #e8ecf5; ' +
        'border: 1px solid rgba(255,255,255,0.18); border-radius: 5px; padding: 4px 6px; ' +
        'font-size: 11px; font-family: inherit; resize: vertical;';
    box.addEventListener('input', () => {
        state.rosterText = box.value;
        state.rosterSeeded = true;
    });
    card.appendChild(box);

    const names = parseRosterNames(state.rosterText);
    if (!names.length) {
        card.appendChild(panelNote('Paste a roster, or press "Use last cycle", to check it.'));
        return;
    }

    const abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap || {};
    const members = resolveRosterKits(names, { loadouts: state.loadouts, abilityDetailMap });

    const onRoster = new Set(names.map((name) => name.toLowerCase()));
    const benchNames = Object.keys(state.loadouts).filter((key) => !onRoster.has(key));
    const bench = resolveRosterKits(
        benchNames.map((key) => state.loadouts[key]?.name || key),
        { loadouts: state.loadouts, abilityDetailMap }
    );

    const lint = lintComposition({
        members,
        bench,
        tier: Number(state.tier) || null,
        abilityDetailMap,
    });

    card.appendChild(panelLine('Status', compositionStatusLine(lint), ACCENT, lint.coverage.line));

    for (const entry of lint.checks) {
        const line = panelLine(
            `${STATUS_MARK[entry.status] || '·'} ${entry.text}`,
            entry.suggestions.length ? `swap in: ${entry.suggestions.slice(0, 3).join(', ')}` : '',
            STATUS_COLOR[entry.status] || ROW_COLORS.dim,
            entry.detail
        );
        card.appendChild(line);
    }
}

// `simple-panel.js`'s own character-switch handling reopens a panel that was
// left open by calling `api.show()` directly — it has no idea this panel's
// body depends on `state`, so it never goes through `openTrialLedgerPanel()`
// (and therefore never calls `refreshLedgerView()`). Left alone, a panel (or
// the overlay row, which reads the same `state` with no refresh trigger of
// its own) kept drawing the *departed* guild's cycles, roster and kits after
// a character or guild switch, until the window selector was touched or the
// panel was closed and reopened by hand. `resetLedgerView()` first, so a
// slow read landing after a second switch cannot be mistaken for the first
// switch's answer (its `refreshGeneration` guard already covers that), and so
// the departed guild's rows do not sit on screen for however long the read
// takes.
dataManager.on('character_switched', () => {
    resetLedgerView();
    return refreshLedgerView();
});

export const guildTrialLedgerPanel = createPanel({
    id: 'guildTrialLedger',
    title: 'Trial Ledger',
    size: { width: 520, height: 520 },
    accent: ACCENT,
    draw: (body) => {
        const guild = guildName();
        const table = buildLedgerTable();

        const header = panelCard(body, guild || 'Guild trials', ACCENT);
        header.appendChild(
            panelLine(
                'Observed',
                coverageLine(table.coverage),
                ROW_COLORS.dim,
                'A trial only reaches the ledger if the guild panel was open while it ran. ' +
                    'Attendance is against the trials recorded here, never against the ones you missed.'
            )
        );
        header.appendChild(panelLine('Trials in window', String(table.trialsRun), ROW_COLORS.dim));
        drawControls(header, table);

        const ledger = panelCard(body, `Attendance and contribution (${table.rows.length})`, ACCENT);
        drawTable(ledger, table);

        // Between the table and the planner on purpose: the accuracy card is a
        // caveat on the figures directly above it — how much to trust the
        // shares — and belongs beside them rather than in the live-fight
        // scoreboard, which has a trial to watch and no room for a retrospective
        drawAccuracy(body);

        drawPlanner(body);
    },
});

/** Open the panel, reading the ledger first so it does not draw an empty table */
export function openTrialLedgerPanel() {
    guildTrialLedgerPanel.show();
    refreshLedgerView();
}

/**
 * Register the overlay tile. Called from `initialize`, so a switched-off feature
 * leaves no tile and no command palette entry behind.
 */
export function registerTrialLedgerRow() {
    registerRow({
        key: 'guildTrialLedger',
        name: 'Trial Ledger',
        empty: 'No trials recorded',
        defaultVisible: false,
        defaultSize: { width: 230, height: 30 },
        render: (container) => {
            const table = buildLedgerTable();
            if (!table.trialsRun) return blank(container);

            // Only members a roster actually places outside every trial. A
            // member nothing here could see is not a no-show and never counts
            const noShows = table.rows.filter((entry) => entry.absent).length;
            const top = table.rows.find((entry) => Number.isFinite(entry.damageShare) && entry.damageShare > 0);
            row(container, [
                { text: top?.name || '—', color: ROW_COLORS.dim, ellipsis: true, title: top?.name || '' },
                { text: percent(top?.damageShare), color: ROW_COLORS.gold },
                {
                    text: noShows ? `${noShows} no-show` : `${table.trialsRun} trials`,
                    color: noShows ? ROW_COLORS.bad : ROW_COLORS.good,
                },
            ]);
            container.title =
                `${table.trialsRun} watched trials of ${table.trialsKnown} known, over ${table.cycles} cycle(s).` +
                (noShows ? `\n${noShows} rostered member(s) took part in none of them.` : '') +
                '\nDouble-click for the whole ledger.';
        },
        onOpen: () => openTrialLedgerPanel(),
    });
}

export default {
    name: 'Guild Trial Ledger',
    initialize: async () => {
        if (!config.getSetting('guildTrialLedger', true)) return;
        registerTrialLedgerRow();
        await refreshLedgerView();
    },
    cleanup: () => {
        guildTrialLedgerPanel.hide({ remember: false });
        resetLedgerView();
    },
};
