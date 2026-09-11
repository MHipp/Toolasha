/**
 * Party Luck panel
 *
 * LYuck: every drop the run produced, against what it owed, per player.
 *
 * The Drop Luck tile carries one figure and the panel behind it carries the run
 * in coins. Neither answers the question that actually gets asked after a long
 * session, which is **which drop is the reason** — a run reads as unlucky
 * because one rare did not come, and no total can say that.
 *
 * ## What each panel is for
 *
 * - **Session Statistics** — the run itself: battles, party, and what the model
 *   was built from. Every figure below depends on these being right, so they are
 *   visible rather than assumed.
 * - **Revenue** — expected against actual per player and for the party, which is
 *   the headline and the only place the party total appears.
 * - **Per player** — the item table. Quantity, value, what was owed, and how far
 *   off it landed, biggest haul first.
 *
 * MCS draws these as separate draggable panes. They are sections of one panel
 * here, because six panes that each have to be positioned is six panes that end
 * up overlapping, and the reason this script has a panel shell at all is that
 * per-panel geometry was where the bugs were.
 *
 * The arithmetic is in `party-luck.js`, and the model under it is the same one
 * the Drop Luck tile uses — so the two cannot disagree about a session.
 *
 * The model is LYuck's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import combatDropLuck, { formatOrdinal, describeLuck, describeChestRun } from './combat-drop-luck.js';
import { partyLuck } from './party-luck.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, signedPercent, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { isLevelGapped } from '../../utils/dungeon-level-gap.js';

const ACCENT = '#7fd6a3';

/** How many item rows a player's table shows before it is more list than answer */
const MAX_ITEMS = 25;

/**
 * An item's name, or something readable when the game has not said.
 * @param {string} itemHrid - The item
 * @returns {string}
 */
function nameOf(itemHrid) {
    return (
        dataManager.getItemDetails?.(itemHrid)?.name ||
        String(itemHrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/** One row of the item table's grid */
function itemRow() {
    const line = document.createElement('div');
    Object.assign(line.style, {
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) 46px 60px 54px 56px',
        gap: '5px',
        alignItems: 'center',
        padding: '1px 0',
    });
    return line;
}

/**
 * @param {string} text - What it says
 * @param {string} [color] - Ink
 * @returns {HTMLElement}
 */
function cell(text, color) {
    const span = document.createElement('span');
    span.textContent = text;
    Object.assign(span.style, { textAlign: 'right', whiteSpace: 'nowrap' });
    if (color) span.style.color = color;
    return span;
}

/**
 * The run itself, which every figure below depends on.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} party - From `partyLuck`
 */
function drawSessionStats(body, party) {
    const context = combatDropLuck.context;
    const card = panelCard(body, 'Session Statistics', ACCENT);

    card.append(
        panelLine('Battles', formatWithSeparator(party.battles)),
        panelLine('Party', String(party.players.length)),
        panelLine(
            'Zone',
            nameOf(context?.actionHrid) || '—',
            ROW_COLORS.neutral,
            'The zone the expectation was built from.'
        ),
        panelLine('Difficulty tier', String(context?.difficultyTier ?? 0))
    );
}

/**
 * The verdict the Drop Luck tile carries, in words.
 *
 * It used to have a panel of its own. Two panels split one question — a
 * percentile in one and the item table that explains it in the other — so the
 * answer was always in the half you did not open. It is a card here.
 *
 * @param {HTMLElement} body - Where it goes
 */
function drawVerdict(body) {
    const result = combatDropLuck.lastResult;
    if (!result) return;

    // `describeLuck` returns `{text, tone}`; the object itself reaching a line
    // is how this last went wrong
    const verdict = describeLuck(result.percentile);
    const card = panelCard(body, 'Verdict', ACCENT);
    const difference = (result.income || 0) - (result.expected || 0);

    card.append(
        panelLine('Percentile', formatOrdinal(result.percentile), ROW_COLORS.accent),
        panelLine(
            'In words',
            verdict.text,
            { lucky: ROW_COLORS.good, unlucky: ROW_COLORS.bad, normal: ROW_COLORS.neutral }[verdict.tone]
        ),
        // The percentile alone cannot say whether the verdict is about a
        // fortune or a rounding error
        panelLine(
            'Difference',
            `${difference >= 0 ? '+' : ''}${formatKMB(difference)}`,
            difference >= 0 ? ROW_COLORS.good : ROW_COLORS.bad,
            'How many coins the verdict is actually about.'
        )
    );

    if (result.hasBonuses) {
        card.appendChild(
            panelNote('Drop-rate bonuses were included in the expectation, so this is luck against your own setup.')
        );
    }
}

/**
 * Expected against actual, per player and for the party.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} party - From `partyLuck`
 */
function drawRevenue(body, party) {
    const card = panelCard(body, 'Revenue', ACCENT);

    for (const player of party.players) {
        const verdict = signedPercent(player.percent ?? 0);
        card.appendChild(
            panelLine(
                player.name,
                `${formatKMB(player.actualValue)} of ${formatKMB(player.expectedValue)}   ` +
                    `${player.percent === null ? '—' : verdict.text}`,
                player.percent === null ? ROW_COLORS.dim : verdict.color,
                `Against what ${player.name}'s own drop gear was owed over ${formatWithSeparator(party.battles)} battles.\n` +
                    `Drop rate +${((player.bonuses.combatDropRate || 0) * 100).toFixed(1)}%, ` +
                    `rare find +${((player.bonuses.combatRareFind || 0) * 100).toFixed(1)}%, ` +
                    `quantity +${((player.bonuses.combatDropQuantity || 0) * 100).toFixed(1)}%.`
            )
        );
    }

    if (party.total) {
        const total = signedPercent(party.total.percent ?? 0);
        const line = panelLine(
            'TOTAL',
            `${formatKMB(party.total.actualValue)} of ${formatKMB(party.total.expectedValue)}   ` +
                `${party.total.percent === null ? '—' : total.text}`,
            party.total.percent === null ? ROW_COLORS.dim : total.color,
            'The party against the party, not an average of the percentages.'
        );
        line.style.borderTop = '1px solid rgba(255, 255, 255, 0.10)';
        line.style.paddingTop = '3px';
        line.style.fontWeight = 'bold';
        card.appendChild(line);
    }
}

/**
 * One player's drops: what came, what it was worth, what was owed.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} player - From `partyLuck`
 */
function drawPlayerTable(body, player) {
    const card = panelCard(body, player.name, player.isCurrentPlayer ? ROW_COLORS.gold : ACCENT);

    const heading = itemRow();
    Object.assign(heading.style, {
        color: 'rgba(232, 236, 245, 0.5)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.10)',
        paddingBottom: '3px',
    });
    const name = cell('Item');
    name.style.textAlign = 'left';
    heading.append(document.createElement('span'), name, cell('Qty'), cell('Value'), cell('Owed'), cell('%'));
    card.appendChild(heading);

    if (!player.items.length) {
        card.appendChild(panelNote('Nothing dropped yet.'));
        return;
    }

    for (const item of player.items.slice(0, MAX_ITEMS)) {
        const line = itemRow();

        const icon = itemIcon(item.itemHrid, 16);
        linkToMarketplace(icon, item.itemHrid, navigateToMarketplace);

        const label = document.createElement('span');
        label.textContent = nameOf(item.itemHrid);
        Object.assign(label.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        linkToMarketplace(label, item.itemHrid, navigateToMarketplace);

        const verdict = signedPercent(item.percent ?? 0);
        line.append(
            icon,
            label,
            cell(formatWithSeparator(item.count)),
            cell(formatKMB(item.value), ROW_COLORS.gold),
            // The count it was owed, not the coins: a drop that came twice when
            // it was owed once is the interesting row, whatever it sells for
            cell(item.expected >= 10 ? formatKMB(item.expected) : item.expected.toFixed(2), ROW_COLORS.dim),
            cell(item.percent === null ? '—' : verdict.text, item.percent === null ? ROW_COLORS.dim : verdict.color)
        );
        line.title =
            `${formatWithSeparator(item.count)} dropped, ${item.expected.toFixed(3)} owed.` +
            (item.percent === null ? '\nNothing was owed, so there is nothing to be over or under.' : '');
        card.appendChild(line);
    }

    if (player.items.length > MAX_ITEMS) {
        card.appendChild(panelNote(`${player.items.length - MAX_ITEMS} more, smallest hauls, not shown.`));
    }
}

/**
 * A dungeon, which is measured by its chests rather than by its monsters.
 *
 * The per-monster model cannot place a dungeon haul — a dungeon pays once, from
 * a reward table, on completion. But the drop-quantity bonus turns the
 * guaranteed chest into a guaranteed chest plus a chance of another, and that
 * chance is the only randomness in the payout, which makes it the whole of the
 * luck. Completions are counted by watching the chest count rise, because the
 * game never states them.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} chest - From `combatDropLuck.dungeonChestLuck()`
 */
function drawDungeonChests(body, chest) {
    const card = panelCard(body, 'Dungeon chests', ACCENT);

    for (const player of chest.players) {
        const luck = player.luck;
        if (!luck) {
            card.appendChild(panelLine(player.name, 'no completion yet', ROW_COLORS.dim, describeChestRun(player)));
            continue;
        }

        const verdict = signedPercent(luck.expected > 0 ? (luck.chests / luck.expected - 1) * 100 : 0);
        const percentile = luck.percentile === null ? '—' : formatOrdinal(luck.percentile);

        card.appendChild(
            panelLine(
                player.name,
                `${formatWithSeparator(luck.chests)} of ${luck.expected.toFixed(1)}   ${verdict.text}   ${percentile}`,
                verdict.color,
                describeChestRun(player)
            )
        );

        // The gap is inside the expectation above rather than replacing it, so
        // the percentile means what it usually does. It still gets its own line:
        // a character being paid a tenth of a share should not have to be
        // inferred from an expectation that looks oddly small.
        if (isLevelGapped(player.levelGap)) {
            card.appendChild(
                panelLine(
                    `  level gap`,
                    `−${Math.round(Math.abs(player.levelGap) * 100)}%, ` +
                        `${player.mean.toFixed(2)} a completion` +
                        (player.observed === null ? '' : ` (${player.observed.toFixed(2)} seen)`),
                    ROW_COLORS.bad,
                    'Far enough below the top of the party for the game to cut what drops for them. Below one ' +
                        'chest a completion there is no guaranteed chest at all — the fraction becomes the chance ' +
                        'of getting one, which is why the payout is usually nothing and occasionally one.\n' +
                        'The size of the cut is the debuff the simulator uses for monster drops; nothing has ' +
                        'confirmed a dungeon uses the same number, so the seen rate is shown beside it.'
                )
            );
        }
    }

    card.appendChild(
        panelLine(
            'Party',
            String(chest.partySize),
            ROW_COLORS.neutral,
            'A completion pays five chests split across the party, so a bigger party is fewer each.'
        )
    );

    // Where the completion count came from, because the two differ in what they
    // can see and the difference decides whether a zero is visible
    card.appendChild(
        panelLine(
            'Completions',
            chest.counted === 'tracker' ? 'from the dungeon tracker' : 'inferred from chests',
            chest.counted === 'tracker' ? ROW_COLORS.neutral : ROW_COLORS.dim,
            chest.counted === 'tracker'
                ? 'Counted from the party’s key-count messages, so a run that paid somebody nothing still ' +
                      'counts as a run for them.' +
                      (chest.restored
                          ? `\n${chest.restored} finished before this page loaded and were read back from the ` +
                            'tracker’s history. The chests need no recovering — the loot total belongs to the ' +
                            'combat session rather than to the tab, and the server re-sends all of it.'
                          : '')
                : 'Counted by watching the chests arrive, which is the fallback — it cannot see a run that ' +
                      'paid nothing, because nothing is what a run that paid nothing looks like.'
        )
    );

    if (chest.entryKey?.spent) {
        card.appendChild(
            panelLine(
                'Entry keys spent',
                formatWithSeparator(chest.entryKey.spent),
                ROW_COLORS.neutral,
                'Counted from every inventory change rather than from a count at each end, so keys bought ' +
                    'mid-run are recorded as acquired and never subtracted from what was spent' +
                    (chest.entryKey.gained ? `. ${formatWithSeparator(chest.entryKey.gained)} acquired.` : '.')
            )
        );
    }

    card.appendChild(
        panelNote('A dungeon already in progress is measured from the moment this saw it rather than from the start.')
    );
}

/**
 * Everything currently on screen, as plain text for the clipboard.
 *
 * The whole point of this panel is a figure people compare with each other, so
 * the summary mirrors it: the verdict first, then the session it was measured
 * over, then revenue per player and for the party — or, inside a dungeon, the
 * chest count each player is measured against, since there is no per-drop
 * expectation there to lead with.
 *
 * @param {Object} party - From `partyLuck`
 * @param {Object|null} chest - From `combatDropLuck.dungeonChestLuck()`
 * @returns {string} Empty when there is nothing measured yet
 */
export function buildPartyLuckSummaryText(party, chest) {
    if (chest) {
        const lines = ['Party Luck — dungeon chests'];
        for (const player of chest.players) {
            if (!player.luck) {
                lines.push(`${player.name}: no completion yet`);
                continue;
            }
            const verdict = signedPercent(
                player.luck.expected > 0 ? (player.luck.chests / player.luck.expected - 1) * 100 : 0
            );
            const percentile = player.luck.percentile === null ? '' : `, ${formatOrdinal(player.luck.percentile)}`;
            lines.push(
                `${player.name}: ${formatWithSeparator(player.luck.chests)} of ${player.luck.expected.toFixed(1)} ` +
                    `${verdict.text}${percentile}`
            );
        }
        return lines.join('\n');
    }

    if (!party?.players?.length) return '';

    const lines = ['Party Luck'];
    const result = combatDropLuck.lastResult;
    if (result) {
        const verdict = describeLuck(result.percentile);
        const difference = (result.income || 0) - (result.expected || 0);
        lines.push(
            `Verdict: ${formatOrdinal(result.percentile)} percentile — ${verdict.text} ` +
                `(${difference >= 0 ? '+' : ''}${formatKMB(difference)})`
        );
    }
    lines.push(`Battles: ${formatWithSeparator(party.battles)}, Party: ${party.players.length}`);
    lines.push('');

    for (const player of party.players) {
        const verdict = signedPercent(player.percent ?? 0);
        lines.push(
            `${player.name}: ${formatKMB(player.actualValue)} of ${formatKMB(player.expectedValue)} ` +
                `${player.percent === null ? '—' : verdict.text}`
        );
    }
    if (party.total) {
        const total = signedPercent(party.total.percent ?? 0);
        lines.push(
            `TOTAL: ${formatKMB(party.total.actualValue)} of ${formatKMB(party.total.expectedValue)} ` +
                `${party.total.percent === null ? '—' : total.text}`
        );
    }
    return lines.join('\n');
}

/**
 * A single copy affordance, right-aligned above the sections it summarises.
 *
 * Same shape as Party Loot's — a glyph rather than a word, because the panel
 * is dense enough already, and a tick in its place rather than a colour change,
 * because the flash has to read at a glance.
 *
 * @param {string} text - What clicking it copies
 * @returns {HTMLElement}
 */
function copyBar(text) {
    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', justifyContent: 'flex-end' });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Copy this reading as plain text — the figure people compare with each other.';
    Object.assign(copyBtn.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        color: ROW_COLORS.dim,
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontSize: '11px',
        cursor: 'pointer',
    });
    copyBtn.addEventListener('click', () => {
        if (!navigator.clipboard) return;
        navigator.clipboard
            .writeText(text)
            .then(() => {
                copyBtn.textContent = '✓';
                setTimeout(() => (copyBtn.textContent = '⧉'), 1200);
            })
            .catch((error) => console.error('[PartyLuck] Copy failed:', error));
    });
    bar.appendChild(copyBtn);
    return bar;
}

/**
 * Every drop the run produced, against what it owed.
 */
export const partyLuckPanel = createPanel({
    id: 'partyLuck',
    title: 'Party Luck',
    size: { width: 480, height: 560 },
    accent: ACCENT,
    refreshMs: 5000,
    draw: (body) => {
        const party = partyLuck(combatDropLuck.context);
        const chest = combatDropLuck.dungeonChestLuck();

        // A dungeon has no per-monster expectation to draw, so the chest card is
        // the panel rather than a section of it
        if (chest) {
            body.appendChild(copyBar(buildPartyLuckSummaryText(party, chest)));
            drawDungeonChests(body, chest);
            body.appendChild(
                panelNote(
                    'A dungeon pays from a reward table on completion, not per monster, so there is no per-drop ' +
                        'expectation to compare against — only the chests.'
                )
            );
            return;
        }

        if (!party.players.length) {
            body.appendChild(panelNote('No run measured yet.'));
            body.appendChild(
                panelNote(
                    'The zone and the battle count are only on the wire during combat, so this fills in once a run ' +
                        'is under way.'
                )
            );
            return;
        }

        body.appendChild(copyBar(buildPartyLuckSummaryText(party, chest)));
        drawVerdict(body);
        drawSessionStats(body, party);
        drawRevenue(body, party);
        for (const player of party.players) drawPlayerTable(body, player);

        body.appendChild(
            panelNote(
                'Each player is measured against what their own drop gear was owed. Somebody with no drop gear is ' +
                    'owed less, so par for them is a smaller haul — this answers "am I unlucky", not "am I carrying".'
            )
        );
    },
});
