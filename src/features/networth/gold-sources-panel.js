/**
 * The gold source attribution panel.
 *
 * A stacked bar per day and a totals table, opened from the coin button beside
 * the net worth history chart.
 *
 * ## What the drawing is trying to say
 *
 * Each day's bar is the day's *measured* net worth change, cut into the pieces
 * the recordings can account for — plus one grey piece, the residual, which is
 * everything they cannot. The grey is not an error bar and not a rounding
 * remainder: it is market movement, activity older than a recorder's window,
 * and activity nothing records. Drawing it at the same weight as the rest is
 * the whole point of the panel; a chart whose colours summed to the total would
 * be claiming a certainty that does not exist.
 *
 * Sources that cost coins — consumables burned, market tax paid — are negative,
 * and are drawn at the left of the bar and dimmed, so a day where the food bill
 * ate the drops looks like what it was rather than like a shorter good day.
 *
 * ## Tooltips
 *
 * Every source names the recording it came from and the date that recording
 * starts, because "you earned nothing from production last week" and "nothing
 * was recording production last week" are completely different statements and
 * the numbers alone cannot tell them apart.
 *
 * That distinction is why the combat row's Basis cell no longer says a flat
 * "Measured": combat is fed by the loot log where it spoke and by the archived
 * battle runs where it did not, and a day neither covered is a gap the row says
 * out loud rather than a zero it reports with confidence.
 */

import config from '../../core/config.js';
import { networthFormatter } from '../../utils/formatters.js';
import { attributeGoldSources, SOURCE_KEYS, SOURCE_META, CATEGORY_KEYS, dayStart, localDayId } from './gold-sources.js';
import { collectGoldSourceInputs } from './gold-sources-collect.js';
import { buildNetworthCalendar, CALENDAR_WEEKS } from './networth-calendar.js';

export const MODAL_ID = 'mwi-gold-sources-modal';
export const BUTTON_ID = 'mwi-gold-sources-btn';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The windows the panel offers */
export const WINDOWS = [
    { key: 'day', label: 'Day', days: 1 },
    { key: 'week', label: 'Week', days: 7 },
    { key: 'month', label: '30 days', days: 30 },
];

/** One colour per source, warm for income and cold for costs */
const SOURCE_COLORS = {
    combat: '#ef4444',
    gathering: '#22c55e',
    production: '#3b82f6',
    tasks: '#f472b6',
    taskRerolls: '#9d174d',
    chests: '#c084fc',
    alchemy: '#a855f7',
    enhancement: '#f97316',
    marketplace: '#eab308',
    offline: '#14b8a6',
    consumables: '#94a3b8',
    dungeonKeys: '#78716c',
    skillingDrinks: '#a8a29e',
    marketTax: '#64748b',
    residual: '#4b5563',
};

const RESIDUAL_NOTE =
    'Everything the recordings cannot account for: market movement repricing what you already own, ' +
    'activity older than a recorder’s window, and activity nothing records (quests, task rewards, ' +
    'chests, gifts). It is shown as it falls out, never spread over the other rows.';

/** What each category of the residual decomposition is called on screen */
const CATEGORY_LABELS = { gold: 'gold', items: 'items', fixed: 'fixed' };

/**
 * The residual decomposition, as one line.
 *
 * The residual is one grey number and it cannot say which of its four causes it
 * was. These three can: the same two snapshots the day's delta is measured from
 * also carry the coins, the item valuations and the house-and-abilities cost
 * separately, so a residual that is all `items` is the market repricing stock
 * that never moved, and one that is all `gold` is coins arriving from something
 * nothing here records.
 *
 * Nothing is subtracted from them — a marketplace fill moves gold and items at
 * once, and splitting the sources across the three would be an invention. A
 * category the snapshots cannot measure says so rather than reading zero.
 *
 * @param {Object|null} categories - A row's or the totals' `categories`
 * @returns {string} The line, or '' when there is nothing measurable to say
 */
export function categoryLineText(categories) {
    if (!categories) return '';
    const parts = [];
    for (const key of CATEGORY_KEYS) {
        const value = categories[key];
        parts.push(
            `${CATEGORY_LABELS[key]} ` +
                (Number.isFinite(value)
                    ? (value > 0 ? '+' : '') + networthFormatter(Math.round(value))
                    : 'not recorded')
        );
    }
    if (parts.length === 0) return '';
    return `Measured change by asset: ${parts.join(' · ')}`;
}

/**
 * The longer version, for a tooltip: what the three are and why they may not
 * add up to the figure beside them.
 * @param {Object|null} categories - A row's or the totals' `categories`
 * @returns {string} Tooltip text, or '' when there is nothing to say
 */
export function categoryTooltipText(categories) {
    if (!categories) {
        return (
            'There is no pair of net worth snapshots to difference here, so the change cannot be split by asset ' +
            'category. It is not a change of zero in each.'
        );
    }

    const lines = [
        'Where the measured change actually sat, from the same two snapshots the change itself is measured from.',
        'gold — coins on hand. items — inventory, equipment and open listings. fixed — houses, abilities and shrines.',
        'These are the raw category changes, not the residual split up: no source is subtracted from them, because ' +
            'a marketplace fill moves gold and items at once and any split would be invented.',
    ];

    const unmeasured = CATEGORY_KEYS.filter((key) => !Number.isFinite(categories[key]));
    if (unmeasured.length > 0) {
        lines.push(
            `${unmeasured.map((key) => CATEGORY_LABELS[key]).join(' and ')} could not be measured — one of the two ` +
                'snapshots predates the field, so it is left blank rather than counted as no change.'
        );
    }

    if (Number.isFinite(categories.sum) && Number.isFinite(categories.total) && categories.sum !== categories.total) {
        lines.push(
            `The three add to ${networthFormatter(Math.round(categories.sum))} against a total change of ` +
                `${networthFormatter(Math.round(categories.total))}; the difference is assets you excluded from ` +
                'net worth, which the total carries and the categories do not.'
        );
    }

    return lines.join('\n');
}

/**
 * The market movement line: price drift on stock held through the detail
 * snapshots' own window.
 *
 * Scoped out loud to the hours it actually covers, because that window is
 * whatever the tab has been open for and is not one of the local days in the
 * table above.
 *
 * @param {Object|null} movement - `attribution.marketMovement`
 * @returns {string} The line, or '' when there is nothing to report
 */
export function marketMovementText(movement) {
    if (!movement || !Number.isFinite(movement.value)) {
        return (
            'Market movement: not enough recorded — item-level snapshots are taken hourly while the game is open, ' +
            'and two of them are needed to compare a price against itself.'
        );
    }
    const hours = movement.hours >= 1 ? Math.round(movement.hours) : Math.round(movement.hours * 10) / 10;
    const amount = (movement.value > 0 ? '+' : '') + networthFormatter(Math.round(movement.value));
    return (
        `Market movement (last ${hours}h): ${amount} on ${plural(movement.heldItems, 'item')} held right ` +
        'through that window'
    );
}

/**
 * The whole attribution as plain text, for pasting into a chat or a note.
 *
 * Mirrors what the bars and table already draw — the same day rows, the same
 * source order, the same residual — so what a user copies out says exactly
 * what the panel on screen said, not a re-derived summary that could drift
 * from it.
 *
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {string} Plain text block
 */
export function formatAttributionAsText(attribution) {
    const lines = [];
    const from = attribution?.from;
    const to = attribution?.to;
    lines.push(
        Number.isFinite(from) && Number.isFinite(to)
            ? `Where the gold came from — ${localDayId(from)} to ${localDayId(to)}`
            : 'Where the gold came from'
    );
    lines.push('');

    const rows = attribution?.days || [];
    if (rows.length > 0) {
        lines.push('By day:');
        for (const row of rows) {
            const value = Number.isFinite(row.delta)
                ? `${row.delta > 0 ? '+' : ''}${networthFormatter(Math.round(row.delta))}`
                : 'no data';
            lines.push(`  ${row.day}: ${value}`);
        }
        lines.push('');
    }

    lines.push('By source:');
    const totals = attribution?.totals?.sources || {};
    for (const key of SOURCE_KEYS) {
        const meta = SOURCE_META[key];
        const value = totals[key] || 0;
        lines.push(`  ${meta.label}: ${value > 0 ? '+' : ''}${networthFormatter(Math.round(value))}`);
    }
    const residual = attribution?.totals?.residual;
    lines.push(
        `  Unexplained residual: ${
            Number.isFinite(residual) ? (residual > 0 ? '+' : '') + networthFormatter(Math.round(residual)) : '—'
        }`
    );
    lines.push('');

    const delta = attribution?.totals?.delta;
    lines.push(
        `Measured net worth change: ${
            Number.isFinite(delta) ? (delta > 0 ? '+' : '') + networthFormatter(Math.round(delta)) : 'not measured'
        }`
    );

    return lines.join('\n');
}

/**
 * A day id as `MM-DD`, which is what a per-day axis needs.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {string} Short label
 */
function shortDay(dayId) {
    return String(dayId || '').slice(5);
}

/**
 * When a recording starts, phrased for a tooltip.
 * @param {number|null} since - Milliseconds since the epoch, or null
 * @returns {string} A sentence
 */
export function coverageText(since) {
    if (!Number.isFinite(since)) return 'Nothing has been recorded for this source yet.';
    return `Covers activity since ${localDayId(since)}, when recording began.`;
}

/** `n thing` / `n things` */
function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * What the combat row's Basis cell says.
 *
 * "Measured" alone was the whole bug in one word: it read the same whether the
 * loot log had recorded the week, whether the archived runs had filled in for
 * it, or whether nothing had recorded anything and the zero was ignorance. The
 * vocabulary is kept — a measured figure still says Measured — and what
 * measured it is said after it.
 *
 * @param {Object|null} basis - `attribution.combatBasis`
 * @returns {string|null} The cell text, or null when there is nothing extra to say
 */
export function combatBasisLabel(basis) {
    if (!basis) return null;
    const loot = basis.lootLogDays || 0;
    const feed = basis.sessionDays || 0;
    if (loot > 0 && feed > 0) return `Measured — loot log ${loot}d, battle feed ${feed}d`;
    if (loot > 0) return 'Measured — loot log';
    if (feed > 0) return 'Measured — battle feed';
    return basis.combatRan ? 'Not recorded' : 'Measured';
}

/**
 * The combat row's coverage sentences: which recording spoke, when it last did,
 * and what neither of them covers.
 *
 * @param {Object|null} basis - `attribution.combatBasis`
 * @returns {string} A sentence or three, or '' when there is nothing to add
 */
export function combatCoverageText(basis) {
    if (!basis) return '';
    const parts = [];

    parts.push(
        Number.isFinite(basis.lastLootLog)
            ? `The loot log last recorded combat on ${localDayId(basis.lastLootLog)}.`
            : 'The loot log has never recorded combat — the game only sends it while its own panel is open.'
    );

    if (basis.sessionDays > 0) {
        const live = basis.liveDays > 0 ? `, ${plural(basis.liveDays, 'day')} of it recorded live as it happened` : '';
        parts.push(`The battle feed filled ${plural(basis.sessionDays, 'day')}${live}.`);
    }
    if (basis.emptySessions > 0) {
        parts.push(`${plural(basis.emptySessions, 'recorded run')} carried no loot of your own.`);
    }
    // An attribution from before the live record existed has no `capReached`
    if (basis.capReached ?? basis.sessionsHeld >= basis.sessionCap) {
        parts.push(
            Number.isFinite(basis.liveSince)
                ? `Only the ${basis.sessionCap} most recent runs are archived and the live record starts on ` +
                      `${localDayId(basis.liveSince)}, so days before both are not covered by the feed.`
                : `Only the ${basis.sessionCap} most recent runs are kept, so days before them are not covered by ` +
                      'the feed.'
        );
    }
    if (basis.offlineCombat > 0) {
        parts.push(
            'Combat loot that fell while you were offline is left to the offline row, which already counts it ' +
                'from the Welcome Back summary.'
        );
    }
    if (basis.ambiguousEntries > 0) {
        parts.push(
            `${plural(basis.ambiguousEntries, 'loot log record')} lay across a different run and ` +
                `${basis.ambiguousEntries === 1 ? 'was' : 'were'} set aside rather than counted twice.`
        );
    }
    if (basis.uncoveredDays > 0) {
        parts.push(
            `${plural(basis.uncoveredDays, 'day')} in this window have neither recording, so whatever combat ` +
                'earned on them is in the residual.'
        );
    }

    return parts.join(' ');
}

/**
 * The tooltip for one source row.
 * @param {string} key - Source key
 * @param {Object} coverage - `attributeGoldSources` coverage map
 * @param {Object} [combatBasis] - `attribution.combatBasis`, for the combat row
 * @returns {string} Tooltip text
 */
export function sourceTooltip(key, coverage, combatBasis = null) {
    const meta = SOURCE_META[key];
    if (!meta) return '';
    const kind =
        (key === 'combat' ? combatBasisLabel(combatBasis) : null) || (meta.measured ? 'Measured' : 'Estimated');
    const extra = key === 'combat' ? combatCoverageText(combatBasis) : '';
    return (
        `${meta.label} — ${kind}\nData source: ${meta.source}\n${meta.note}\n${coverageText(coverage?.[key])}` +
        (extra ? ` ${extra}` : '')
    );
}

/**
 * A signed gold figure, coloured.
 * @param {number|null} value - Coins
 * @returns {HTMLElement} A span
 */
function goldCell(value) {
    const span = document.createElement('span');
    if (!Number.isFinite(value)) {
        span.textContent = '—';
        span.style.color = '#6b7280';
        return span;
    }
    span.textContent = (value > 0 ? '+' : '') + networthFormatter(Math.round(value));
    span.style.color = value > 0 ? '#22c55e' : value < 0 ? '#f87171' : '#9ca3af';
    return span;
}

/**
 * The per-day stacked bars.
 *
 * Scaled to the largest single day in the window, so the bars are comparable
 * with each other rather than each being full width.
 *
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {HTMLElement} The chart block
 */
export function buildBars(attribution) {
    const block = document.createElement('div');
    block.className = 'mwi-gold-sources-bars';
    block.style.cssText = 'display: flex; flex-direction: column; gap: 3px; margin: 10px 0;';

    const rows = attribution?.days || [];

    // The scale is the biggest one-sided total any day reaches, so a day of
    // pure income and a day of pure loss are drawn at the same weight
    let scale = 0;
    for (const row of rows) {
        let positive = 0;
        let negative = 0;
        for (const key of SOURCE_KEYS) {
            const value = row.sources[key];
            if (value > 0) positive += value;
            else negative -= value;
        }
        if (Number.isFinite(row.residual)) {
            if (row.residual > 0) positive += row.residual;
            else negative -= row.residual;
        }
        scale = Math.max(scale, positive, negative);
    }
    if (scale <= 0) scale = 1;

    for (const row of rows) {
        const line = document.createElement('div');
        line.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px;';

        const label = document.createElement('span');
        label.textContent = shortDay(row.day);
        label.style.cssText = 'width: 38px; flex: 0 0 38px; color: #9ca3af;';
        line.appendChild(label);

        const track = document.createElement('div');
        track.className = 'mwi-gold-sources-track';
        track.style.cssText = 'flex: 1; display: flex; height: 14px; background: rgba(255,255,255,0.04);';

        const segments = [];
        for (const key of SOURCE_KEYS) segments.push([key, row.sources[key]]);
        if (Number.isFinite(row.residual)) segments.push(['residual', row.residual]);

        // Costs first so they read as a block on the left, then income
        const ordered = [...segments.filter(([, value]) => value < 0), ...segments.filter(([, value]) => value > 0)];

        for (const [key, value] of ordered) {
            const segment = document.createElement('div');
            const width = (Math.abs(value) / scale) * 100;
            const meta = SOURCE_META[key];
            segment.className = `mwi-gold-sources-seg mwi-gold-sources-seg-${key}`;
            segment.style.cssText = [
                `width: ${width.toFixed(2)}%`,
                `background: ${SOURCE_COLORS[key] || '#6b7280'}`,
                value < 0 ? 'opacity: 0.55' : 'opacity: 0.9',
            ].join('; ');
            segment.title = `${meta ? meta.label : 'Unexplained'} on ${row.day}: ${
                value > 0 ? '+' : ''
            }${networthFormatter(Math.round(value))}`;
            track.appendChild(segment);
        }

        line.appendChild(track);

        const total = document.createElement('span');
        total.style.cssText = 'width: 74px; flex: 0 0 74px; text-align: right;';
        total.appendChild(goldCell(row.delta));
        const categoryLine = categoryLineText(row.categories);
        total.title =
            row.delta === null
                ? 'No net worth snapshot on this day, so there is no measured change to split.'
                : `Measured net worth change on ${row.day}` + (categoryLine ? `\n${categoryLine}` : '');
        line.appendChild(total);

        block.appendChild(line);
    }

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = 'No days in this window yet.';
        empty.style.cssText = 'color: #9ca3af; font-size: 11px;';
        block.appendChild(empty);
    }

    return block;
}

/**
 * The totals table, residual included as a row of its own.
 * @param {Object} attribution - From `attributeGoldSources`
 * @returns {HTMLElement} The table block
 */
export function buildTotalsTable(attribution) {
    const table = document.createElement('table');
    table.className = 'mwi-gold-sources-table';
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px;';

    const head = document.createElement('tr');
    for (const [text, align] of [
        ['Source', 'left'],
        ['Total', 'right'],
        ['Share of change', 'right'],
        ['Basis', 'left'],
    ]) {
        const cell = document.createElement('th');
        cell.textContent = text;
        cell.style.cssText = `text-align: ${align}; padding: 3px 6px; color: #9ca3af; font-weight: 600;
            border-bottom: 1px solid rgba(255,255,255,0.12);`;
        head.appendChild(cell);
    }
    table.appendChild(head);

    const totals = attribution?.totals?.sources || {};
    const delta = attribution?.totals?.delta ?? null;
    const residual = attribution?.totals?.residual ?? null;

    // Both sides of the share are magnitudes, so the rows answer "how much of
    // what happened was this" and never a negative percentage. Dividing a
    // signed amount by a signed delta flipped the sign on a losing window;
    // dividing a signed amount by an unsigned delta fixed the gaining window
    // and left the both-negative case reading -80% of a loss it in fact
    // explains 80% of. The direction stays on the amount in the column beside
    // it. With no measured change there is nothing honest to divide by
    const scale = Number.isFinite(delta) ? Math.abs(delta) : 0;
    const share = (value) => {
        if (!(scale > 0) || !Number.isFinite(value)) return '—';
        return `${((Math.abs(value) / scale) * 100).toFixed(0)}%`;
    };

    const addRow = (key, label, value, tooltip, basis, emphasis = false) => {
        const tr = document.createElement('tr');
        tr.className = `mwi-gold-sources-row mwi-gold-sources-row-${key}`;
        tr.title = tooltip;

        const name = document.createElement('td');
        name.style.cssText = `padding: 3px 6px; ${emphasis ? 'font-weight: 700;' : ''}`;
        const swatch = document.createElement('span');
        swatch.style.cssText = `display: inline-block; width: 8px; height: 8px; margin-right: 6px;
            background: ${SOURCE_COLORS[key] || '#6b7280'};`;
        name.appendChild(swatch);
        name.appendChild(document.createTextNode(label));
        tr.appendChild(name);

        const amount = document.createElement('td');
        amount.style.cssText = 'padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums;';
        amount.appendChild(goldCell(value));
        tr.appendChild(amount);

        const shareCell = document.createElement('td');
        shareCell.textContent = share(value);
        shareCell.style.cssText = 'padding: 3px 6px; text-align: right; color: #9ca3af;';
        tr.appendChild(shareCell);

        const basisCell = document.createElement('td');
        basisCell.textContent = basis;
        basisCell.style.cssText = 'padding: 3px 6px; color: #9ca3af;';
        tr.appendChild(basisCell);

        table.appendChild(tr);
    };

    const combatBasis = attribution?.combatBasis || null;
    for (const key of SOURCE_KEYS) {
        const meta = SOURCE_META[key];
        const basis =
            (key === 'combat' ? combatBasisLabel(combatBasis) : null) || (meta.measured ? 'Measured' : 'Estimated');
        addRow(key, meta.label, totals[key] || 0, sourceTooltip(key, attribution?.coverage, combatBasis), basis);
    }

    addRow('residual', 'Unexplained residual', residual, RESIDUAL_NOTE, 'Not attributed', true);

    // The sub-line under the residual: not a split of the residual, but the
    // same window's change read off the snapshots by asset category, which is
    // what separates "the market repriced the vault" from "coins appeared"
    const categories = attribution?.totals?.categories || null;
    const categoryRow = document.createElement('tr');
    categoryRow.className = 'mwi-gold-sources-row-categories';
    categoryRow.title = categoryTooltipText(categories);
    const categoryCell = document.createElement('td');
    categoryCell.colSpan = 4;
    categoryCell.style.cssText = 'padding: 0 6px 4px 20px; font-size: 10px; color: #9ca3af;';
    categoryCell.textContent =
        categoryLineText(categories) ||
        'No pair of snapshots in this window, so the change cannot be split by asset category.';
    categoryRow.appendChild(categoryCell);
    table.appendChild(categoryRow);

    const totalRow = document.createElement('tr');
    totalRow.className = 'mwi-gold-sources-row-total';
    totalRow.title = 'The net worth history’s own figure for this window: the last snapshot against the one before it.';
    const totalName = document.createElement('td');
    totalName.textContent = 'Measured net worth change';
    totalName.style.cssText = `padding: 5px 6px; font-weight: 700;
        border-top: 1px solid rgba(255,255,255,0.12);`;
    totalRow.appendChild(totalName);
    const totalValue = document.createElement('td');
    totalValue.style.cssText = `padding: 5px 6px; text-align: right; font-weight: 700;
        border-top: 1px solid rgba(255,255,255,0.12); font-variant-numeric: tabular-nums;`;
    totalValue.appendChild(goldCell(delta));
    totalRow.appendChild(totalValue);
    for (let i = 0; i < 2; i += 1) {
        const filler = document.createElement('td');
        filler.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.12);';
        totalRow.appendChild(filler);
    }
    table.appendChild(totalRow);

    return table;
}

/**
 * The whole body of the panel for one attribution.
 *
 * Split out from the modal so a test can render it without opening anything.
 *
 * @param {Object} attribution - From `attributeGoldSources`
 * @param {Object} [options] - Extras the attribution does not carry
 * @param {Array<Object>} [options.series] - Net worth snapshots, for the calendar section
 * @param {number} [options.now] - Clock, injectable for tests
 * @param {Function|null} [options.onSelectDay] - Called with a calendar cell's `day` id when clicked
 * @returns {HTMLElement} The body element
 */
export function buildPanelBody(attribution, { series = null, now = undefined, onSelectDay = null } = {}) {
    const body = document.createElement('div');
    body.className = 'mwi-gold-sources-body';

    const summary = document.createElement('div');
    summary.className = 'mwi-gold-sources-summary';
    summary.style.cssText = 'font-size: 12px; color: #d1d5db; margin-bottom: 4px;';
    const delta = attribution?.totals?.delta;
    const explained = attribution?.totals?.explained ?? 0;
    if (Number.isFinite(delta)) {
        // Magnitude over magnitude, for the same reason the table's share
        // column is: -16M explained out of a -20M change is 80% accounted for,
        // not -80%, and a signed numerator said the latter
        const pct = delta === 0 ? null : Math.round((Math.abs(explained) / Math.abs(delta)) * 100);
        summary.textContent =
            `Net worth changed by ${networthFormatter(Math.round(delta))}; ` +
            `the recordings account for ${networthFormatter(Math.round(explained))}` +
            (pct === null ? '.' : ` (${pct}%).`);
    } else {
        summary.textContent =
            'There are not two net worth snapshots in this window, so there is no measured change to split. ' +
            'The sources below still show what was recorded.';
    }
    body.appendChild(summary);

    const note = document.createElement('div');
    note.className = 'mwi-gold-sources-note';
    note.style.cssText = 'font-size: 10px; color: #9ca3af; margin-bottom: 6px;';
    note.textContent =
        'Days run midnight to midnight in your local time. Everything is priced at today’s market, not the day’s.';
    body.appendChild(note);

    body.appendChild(buildBars(attribution));
    body.appendChild(buildTotalsTable(attribution));

    // Deliberately outside the table and outside the per-day bars: the detail
    // snapshots cover whatever the tab has been open for, which is not a local
    // day, and folding this figure into a day row would claim an alignment it
    // does not have
    const movement = document.createElement('div');
    movement.className = 'mwi-gold-sources-market-movement';
    movement.style.cssText = 'font-size: 11px; color: #d1d5db; margin-top: 8px;';
    movement.textContent = marketMovementText(attribution?.marketMovement);
    movement.title =
        'The one thing the today’s-prices caveat says this panel cannot see. Each item-level snapshot recorded ' +
        'both a count and a value, so value ÷ count is that holding’s price at the time. This is the shares held ' +
        'through the whole window times the change in their price — quantity changes are excluded, and coins, ' +
        'houses and abilities are not counted because they do not reprice on the order book. It overlaps the days ' +
        'above rather than being one of them, so it is not added to anything.';
    body.appendChild(movement);

    const unpricedAlchemy = attribution?.unpricedAlchemySessions || 0;
    if (unpricedAlchemy > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced-alchemy';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        warning.textContent =
            `${unpricedAlchemy} alchemy session${unpricedAlchemy === 1 ? '' : 's'} could not be valued — the ` +
            'input consumed has no market price and no material cost to fall back to — so they are in the ' +
            'residual rather than the alchemy row.';
        body.appendChild(warning);
    }

    const unpriced = attribution?.unpricedEnhancementSessions || 0;
    if (unpriced > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        warning.textContent =
            `${unpriced} enhancement session${unpriced === 1 ? '' : 's'} could not be valued — the item has no ` +
            'market price at one of its two levels and no material cost to fall back to — so they are in the ' +
            'residual rather than the enhancement row.';
        body.appendChild(warning);
    }

    // The combat row's own version of the unpriced-production warning: a day
    // neither recording covers is not a day of no combat, and a zero on the row
    // without this line said it was
    const combatBasis = attribution?.combatBasis || null;
    if (combatBasis?.combatRan && (combatBasis.uncoveredDays > 0 || combatBasis.emptySessions > 0)) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-combat-gap';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        const pieces = [];
        if (combatBasis.uncoveredDays > 0) {
            pieces.push(
                `${plural(combatBasis.uncoveredDays, 'day')} in this window have no combat record at all — the ` +
                    'live record was not running, the loot log was closed and the archived runs do not reach ' +
                    'back that far'
            );
        }
        if (combatBasis.emptySessions > 0) {
            pieces.push(`${plural(combatBasis.emptySessions, 'recorded run')} carried no loot of your own`);
        }
        warning.textContent =
            `${pieces.join(', and ')} — so the combat row is short by whatever they earned and the ` +
            'difference sits in the residual. Only the ' +
            `${combatBasis.sessionCap} most recent runs are kept.`;
        body.appendChild(warning);
    }

    const unpricedProduction = attribution?.unpricedProductionActions || 0;
    if (unpricedProduction > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced-production';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        warning.textContent =
            `${unpricedProduction} production action${unpricedProduction === 1 ? '' : 's'} could not be valued — ` +
            'an input or output has no market price — so the production row is short by whatever they were worth ' +
            'and the difference sits in the residual.';
        body.appendChild(warning);
    }

    // The chest row's own version of the same warning: an opening nothing could
    // price is not an opening that paid nothing
    const unpricedChests = attribution?.unpricedChests || 0;
    const unpricedChestItems = attribution?.unpricedChestItems || 0;
    if (unpricedChests > 0 || unpricedChestItems > 0) {
        const warning = document.createElement('div');
        warning.className = 'mwi-gold-sources-unpriced-chests';
        warning.style.cssText = 'font-size: 10px; color: #fbbf24; margin-top: 6px;';
        const pieces = [];
        if (unpricedChests > 0) {
            pieces.push(
                `${plural(unpricedChests, 'chest')} had no market price, expected value, or material cost of their own, so what they paid ` +
                    'could not be netted against what they were worth and the whole opening was left out'
            );
        }
        if (unpricedChestItems > 0) {
            pieces.push(`${plural(unpricedChestItems, 'item')} that came out of a chest could not be priced`);
        }
        warning.textContent = `${pieces.join(', and ')} — the chest row is short by that much, and it sits in the residual.`;
        body.appendChild(warning);
    }

    if (Array.isArray(series)) {
        body.appendChild(buildCalendarSection(series, now === undefined ? {} : { now }, onSelectDay));
    }

    return body;
}

/** Row labels down the side of the grid, Sunday first */
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Colour classing is by sign; the depth of the colour is by magnitude */
const CALENDAR_COLORS = { gain: '#22c55e', loss: '#f87171' };

/**
 * Which of the four kinds of cell a day is.
 * @param {Object|null} cell - A calendar cell
 * @returns {string} `gain`, `loss`, `flat` or `nodata`
 */
export function calendarCellKind(cell) {
    if (!cell || !Number.isFinite(cell.delta)) return 'nodata';
    if (cell.delta > 0) return 'gain';
    if (cell.delta < 0) return 'loss';
    return 'flat';
}

/**
 * The tooltip on one day cell.
 * @param {Object} cell - A calendar cell
 * @returns {string} Tooltip text
 */
export function calendarCellTitle(cell) {
    if (!cell) return '';
    if (!Number.isFinite(cell.delta)) {
        return (
            `${cell.day} — no data. There is no snapshot on this day and an earlier one to measure it against, ` +
            'so no change can be shown. It is not a day of zero change.'
        );
    }
    const amount = (cell.delta > 0 ? '+' : '') + networthFormatter(Math.round(cell.delta));
    let text = `${cell.day} — ${amount}`;
    if (cell.spansGap) {
        text +=
            `\nThe snapshot before this one is ${cell.gapDays} days back, so this cell holds the whole change ` +
            'since then rather than one day of it.';
    }
    return text;
}

/**
 * The one line above the grid: the two extremes and the up/down split.
 * @param {Object} summary - From `buildNetworthCalendar`
 * @returns {string} The line
 */
export function calendarSummaryText(summary) {
    if (!summary || !summary.measured) {
        return 'No day in this window has a measured change yet.';
    }
    const figure = (cell) => (cell.delta > 0 ? '+' : '') + networthFormatter(Math.round(cell.delta));
    return (
        `Best ${figure(summary.best)} on ${summary.best.day} · ` +
        `worst ${figure(summary.worst)} on ${summary.worst.day} · ` +
        `${summary.positive} up / ${summary.negative} down`
    );
}

/**
 * The grid itself, one column per week and one cell per day.
 * @param {Object} calendar - From `buildNetworthCalendar`
 * @param {Function|null} [onSelectDay] - Called with a cell's `day` id when it is clicked
 * @returns {HTMLElement} The grid block
 */
export function buildCalendarGrid(calendar, onSelectDay = null) {
    const block = document.createElement('div');
    block.className = 'mwi-nw-calendar-grid';
    block.style.cssText = 'display: flex; gap: 3px; margin: 6px 0;';

    const labels = document.createElement('div');
    labels.className = 'mwi-nw-calendar-labels';
    labels.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';
    for (const label of WEEKDAY_LABELS) {
        const cell = document.createElement('div');
        cell.textContent = label;
        cell.style.cssText = 'width: 12px; height: 12px; font-size: 9px; line-height: 12px; color: #6b7280;';
        labels.appendChild(cell);
    }
    block.appendChild(labels);

    const scale = calendar?.maxMagnitude > 0 ? calendar.maxMagnitude : 1;

    for (const week of calendar?.weeks || []) {
        const column = document.createElement('div');
        column.className = 'mwi-nw-calendar-week';
        column.style.cssText = 'display: flex; flex-direction: column; gap: 3px;';

        for (const cell of week) {
            const box = document.createElement('div');
            const kind = calendarCellKind(cell);
            box.className = `mwi-nw-calendar-cell mwi-nw-calendar-cell-${kind}`;
            // A floor under the opacity so a small but real day is still
            // visibly coloured rather than fading into the no-data grey
            const weight = kind === 'gain' || kind === 'loss' ? 0.28 + 0.72 * (Math.abs(cell.delta) / scale) : 1;
            const background =
                CALENDAR_COLORS[kind] || (kind === 'flat' ? 'rgba(156,163,175,0.45)' : 'rgba(255,255,255,0.05)');
            box.style.cssText = [
                'width: 12px; height: 12px; border-radius: 2px',
                `background: ${background}`,
                `opacity: ${weight.toFixed(2)}`,
                cell?.isToday ? 'outline: 1px solid rgba(255,255,255,0.45)' : '',
            ]
                .filter(Boolean)
                .join('; ');
            if (cell) {
                box.dataset.day = cell.day;
                box.title = calendarCellTitle(cell);
                if (cell.spansGap) {
                    // The mark says "this is more than one day of change", which
                    // is the only thing separating it from a spectacular day
                    box.classList.add('mwi-nw-calendar-cell-gap');
                    box.textContent = '·';
                    box.style.cssText += '; font-size: 12px; line-height: 9px; text-align: center; color: #111827';
                }
                // The calendar and the day-by-day gold breakdown are two views of
                // the same history; a cell that already names its own day is the
                // natural door from one into the other
                if (typeof onSelectDay === 'function') {
                    box.style.cursor = 'pointer';
                    box.title += '\nClick to open the gold breakdown for this day.';
                    box.addEventListener('click', () => onSelectDay(cell.day));
                }
            }
            column.appendChild(box);
        }

        block.appendChild(column);
    }

    return block;
}

/**
 * The calendar section's contents: summary line, grid, and what a cell means.
 * @param {Array<Object>} series - Net worth snapshots `{t, total}`
 * @param {Object} [options] - Passed through to `buildNetworthCalendar`
 * @param {Function|null} [onSelectDay] - Called with a cell's `day` id when it is clicked
 * @returns {HTMLElement} The block
 */
export function buildCalendarBody(series, options = {}, onSelectDay = null) {
    const holder = document.createElement('div');
    holder.className = 'mwi-nw-calendar';

    const calendar = buildNetworthCalendar(series, options);

    const summary = document.createElement('div');
    summary.className = 'mwi-nw-calendar-summary';
    summary.style.cssText = 'font-size: 11px; color: #d1d5db;';
    summary.textContent = calendarSummaryText(calendar.summary);
    holder.appendChild(summary);

    holder.appendChild(buildCalendarGrid(calendar, onSelectDay));

    const note = document.createElement('div');
    note.className = 'mwi-nw-calendar-note';
    note.style.cssText = 'font-size: 10px; color: #9ca3af;';
    note.textContent =
        'One cell per day in your own timezone, the day’s last snapshot against the previous day’s. ' +
        'Dim means no data, never a day of zero change; a dot means the snapshot before it is more than a day ' +
        'back, so that cell carries the whole change across the gap.';
    holder.appendChild(note);

    return holder;
}

/**
 * The collapsible calendar section.
 *
 * Collapsed until asked for, and the grid is built on expand rather than with
 * the rest of the body: the panel is redrawn whenever it opens or the window
 * changes, and a section nobody has opened should not cost a pass over the
 * whole history each time.
 *
 * @param {Array<Object>} series - Net worth snapshots `{t, total}`
 * @param {Object} [options] - Passed through to `buildNetworthCalendar`
 * @param {Function|null} [onSelectDay] - Called with a cell's `day` id when it is clicked
 * @returns {HTMLElement} The section
 */
export function buildCalendarSection(series, options = {}, onSelectDay = null) {
    const section = document.createElement('div');
    section.className = 'mwi-nw-calendar-section';
    section.style.cssText = 'margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 6px;';

    const weeks = Math.round(options.weeks || CALENDAR_WEEKS);
    const toggle = document.createElement('button');
    toggle.className = 'mwi-nw-calendar-toggle';
    toggle.type = 'button';
    toggle.style.cssText = `background: none; border: none; padding: 0; cursor: pointer; color: #d1d5db;
        font-size: 12px; font-weight: 600;`;

    const body = document.createElement('div');
    body.className = 'mwi-nw-calendar-holder';
    body.style.display = 'none';

    let drawn = false;
    const label = (open) => `${open ? '▾' : '▸'} Daily net worth calendar (last ${weeks} weeks)`;
    toggle.textContent = label(false);

    toggle.addEventListener('click', () => {
        const open = body.style.display === 'none';
        body.style.display = open ? '' : 'none';
        toggle.textContent = label(open);
        if (open && !drawn) {
            drawn = true;
            try {
                body.appendChild(buildCalendarBody(series, options, onSelectDay));
            } catch (error) {
                console.error('[GoldSources] The calendar could not be drawn:', error);
                body.textContent = 'The calendar could not be drawn.';
            }
        }
    });

    section.appendChild(toggle);
    section.appendChild(body);
    return section;
}

class GoldSourcesPanel {
    constructor() {
        this.modal = null;
        this.activeWindow = 'week';
        // Set when a calendar cell is clicked: the end of that local day, so the
        // active window is read relative to the day chosen rather than to now.
        // Null means "now", which is what every window button resets it to.
        this.anchorTo = null;
        // The attribution behind the panel currently on screen, so the copy
        // button can format exactly what is drawn without rebuilding it.
        this._lastAttribution = null;
    }

    /**
     * Open the panel, or close it if it is already open.
     * @returns {Promise<void>}
     */
    async toggleModal() {
        if (this.modal) {
            this.closeModal();
            return;
        }
        await this.openModal();
    }

    /**
     * Build the attribution for the active window.
     *
     * The series comes back beside it because the calendar section covers eight
     * weeks whatever window the rest of the panel is on, and re-reading the
     * history for it would be a second pass over the same array.
     *
     * @returns {Promise<{attribution: Object, series: Array<Object>}>} The attribution and the snapshots behind it
     */
    async buildAttribution() {
        const days = WINDOWS.find((entry) => entry.key === this.activeWindow)?.days || 7;
        const to = Number.isFinite(this.anchorTo) ? this.anchorTo : Date.now();
        // localDayId, not toISOString(): the ISO slice is the UTC date, and
        // feeding a UTC id to a LOCAL dayStart put the window's start in the
        // future for any evening west of Greenwich — an empty Day view
        const from = dayStart(localDayId(to - (days - 1) * DAY_MS));
        const inputs = await collectGoldSourceInputs();
        return {
            attribution: attributeGoldSources({ ...inputs, from, to }),
            series: Array.isArray(inputs?.series) ? inputs.series : [],
        };
    }

    /**
     * Draw the modal.
     * @returns {Promise<void>}
     */
    async openModal() {
        if (this.modal) return;

        const modal = document.createElement('div');
        modal.id = MODAL_ID;
        modal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            width: min(640px, 94vw); max-height: 82vh; overflow-y: auto; padding: 12px 14px;
            background: #12141c; border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
            color: #e5e7eb; font-size: 12px; z-index: ${config.Z_FLOATING_PANEL || 1100};`;

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
        const title = document.createElement('h3');
        title.textContent = Number.isFinite(this.anchorTo)
            ? `Where the gold came from — ${localDayId(this.anchorTo)}`
            : 'Where the gold came from';
        title.style.cssText = 'margin: 0; flex: 1; font-size: 14px;';
        header.appendChild(title);

        if (Number.isFinite(this.anchorTo)) {
            const today = document.createElement('button');
            today.textContent = 'Back to today';
            today.title =
                'Drop the day picked from the calendar and go back to what the window buttons mean by default.';
            today.style.cssText =
                'background: none; border: 1px solid rgba(255,255,255,0.16); color: #9ca3af; ' +
                'border-radius: 3px; padding: 3px 8px; cursor: pointer; font-size: 11px;';
            today.addEventListener('click', async () => {
                this.anchorTo = null;
                this.closeModal();
                await this.openModal();
            });
            header.appendChild(today);
        }

        const copyBtn = document.createElement('button');
        copyBtn.id = 'mwi-gold-sources-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy this breakdown as text';
        copyBtn.style.cssText =
            'background: none; border: 1px solid rgba(255,255,255,0.16); color: #9ca3af; ' +
            'border-radius: 3px; padding: 3px 8px; cursor: pointer; font-size: 11px;';
        copyBtn.addEventListener('click', async () => {
            const text = formatAttributionAsText(this._lastAttribution);
            const original = copyBtn.textContent;
            try {
                await navigator.clipboard.writeText(text);
                copyBtn.textContent = 'Copied!';
            } catch (error) {
                console.error('[GoldSources] Copy to clipboard failed:', error);
                copyBtn.textContent = 'Copy failed';
            }
            setTimeout(() => {
                copyBtn.textContent = original;
            }, 1500);
        });
        header.appendChild(copyBtn);

        const close = document.createElement('button');
        close.textContent = '✕';
        close.style.cssText = 'background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px;';
        close.addEventListener('click', () => this.closeModal());
        header.appendChild(close);
        modal.appendChild(header);

        const rangeRow = document.createElement('div');
        rangeRow.className = 'mwi-gold-sources-ranges';
        rangeRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 8px;';
        for (const window of WINDOWS) {
            const button = document.createElement('button');
            button.textContent = window.label;
            button.dataset.window = window.key;
            button.style.cssText = `padding: 3px 10px; font-size: 11px; cursor: pointer; border-radius: 3px;
                border: 1px solid rgba(255,255,255,0.16); background: ${
                    window.key === this.activeWindow ? 'rgba(34,197,94,0.18)' : 'transparent'
                }; color: ${window.key === this.activeWindow ? '#22c55e' : '#9ca3af'};`;
            button.addEventListener('click', async () => {
                this.activeWindow = window.key;
                // A window button is an explicit choice of "the current N days";
                // it always overrides a day picked from the calendar
                this.anchorTo = null;
                this.closeModal();
                await this.openModal();
            });
            rangeRow.appendChild(button);
        }
        modal.appendChild(rangeRow);

        const bodyHolder = document.createElement('div');
        bodyHolder.className = 'mwi-gold-sources-holder';
        bodyHolder.textContent = 'Reading the recordings…';
        modal.appendChild(bodyHolder);

        document.body.appendChild(modal);
        this.modal = modal;

        try {
            const { attribution, series } = await this.buildAttribution();
            if (!this.modal) return;
            this._lastAttribution = attribution;
            bodyHolder.textContent = '';
            const onSelectDay = async (dayId) => {
                this.activeWindow = 'day';
                // The end of that local day, so the "Day" window's own
                // now-minus-(days-1) arithmetic lands on exactly that day
                this.anchorTo = dayStart(dayId) + DAY_MS - 1;
                this.closeModal();
                await this.openModal();
            };
            bodyHolder.appendChild(buildPanelBody(attribution, { series, onSelectDay }));
        } catch (error) {
            console.error('[GoldSources] The panel could not be drawn:', error);
            bodyHolder.textContent = 'The attribution could not be drawn.';
        }
    }

    /** Take the modal down. */
    closeModal() {
        this.modal?.remove();
        this.modal = null;
        this._lastAttribution = null;
    }
}

const goldSourcesPanel = new GoldSourcesPanel();
export default goldSourcesPanel;
