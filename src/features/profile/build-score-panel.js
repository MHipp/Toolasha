/**
 * Build Score panel
 *
 * What your build score is made of.
 *
 * The overlay's Build Score tile prints one figure and, until now, was the only
 * tile with nothing behind it — double-clicking it did nothing, because the only
 * detailed view that existed was the game's own profile modal, which you cannot
 * open on yourself without going and finding yourself in a chat line.
 *
 * ## What the number is
 *
 * A score is a **price**: the coin cost of the build, divided by a million. A
 * score of 340 means the kit, the ability books, the house levels and the shrine
 * levels would cost about 340 million coins to buy today. That convention is
 * stated at the top of the panel, because a bare "340" is otherwise a magic
 * number that people assume is a rating out of something.
 *
 * ## Where the lines come from
 *
 * All of it out of `calculateCombatScore`. Nothing here re-prices anything: the
 * calculator already produces a row per house room, per equipped ability, per
 * worn item and per guild shrine, each with the coins it cost, and this panel
 * arranges them. Where the calculator does not know something — a house room's
 * hrid, so no icon; a guild token's gold value, so no price — the panel says so
 * rather than inventing it.
 *
 * ## Whose build
 *
 * Usually yours, and that is the panel's resting state — the overlay row hands
 * it a reader for the current character and it keeps it. But the same breakdown
 * is worth having for a profile you are looking at, and the score behind that
 * profile card has already been computed by the time the card is drawn, so the
 * profile card can point the panel at it instead. One setter does both, and the
 * header says whose build is on screen whenever it is not yours.
 *
 * What is *not* the same for another player is what the game shares: a profile
 * with equipment hidden prices no gear at all. The panel says so rather than
 * presenting the remainder as a total, which is the same rule it already
 * followed for an item the market could not price.
 *
 * ## Why the score arrives from outside
 *
 * The figure is owned by the overlay row, which recomputes it on equipment and
 * house changes rather than on a timer — pricing a +13 means simulating what it
 * cost to get there. The row hands the panel a reader rather than the panel
 * importing the row, so the imports run one way: row → panel.
 */

import { formatWithSeparator } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';

/** The convention behind every figure in the panel, said once at the top */
const HEADER_NOTE = 'Score = what this kit would cost to buy, in millions of coins.';

/** How many lines the "biggest contributors" summary lists */
const TOP_CONTRIBUTORS = 5;

const COMBAT_ACCENT = '#8fb4ff';
const SKILLER_ACCENT = '#c9a0ff';

/** The header when the panel is showing your own build */
const OWN_TITLE = 'Build Score';

/**
 * Where the score comes from.
 *
 * Injected rather than imported so this module does not depend on the overlay
 * row that owns the figure — the row imports the panel to wire its tile, and a
 * cycle between the two is a module-initialisation hazard for the sake of one
 * property read.
 *
 * @type {Function}
 */
let readScore = () => null;

/**
 * Whose build the panel is currently about, or null for your own.
 *
 * Kept beside the source rather than derived from it because it is the thing
 * that has to be *checked*: pointing the panel at a profile and never pointing
 * it back is how a viewer ends up reading somebody else's numbers under their
 * own name, and a name is what makes that visible.
 *
 * @type {string|null}
 */
let scoreOwner = null;

/**
 * Tell the panel whose score to read, and from where.
 *
 * The single way in. The overlay row calls it once with the current character's
 * reader and no owner; a profile card calls it with that profile's already
 * computed score and the name on the card, and calls it again with the row's
 * reader when the profile is yours.
 *
 * @param {Function} source - `() => Object|null`, the result of `calculateCombatScore`
 * @param {string|null} [owner] - The player whose build this is, or null for yours
 * @returns {boolean} Whether this changed whose build the panel is about — the
 *   caller's cue to redraw a panel that is already open rather than close it
 */
export function setScoreSource(source, owner = null) {
    readScore = typeof source === 'function' ? source : () => null;

    const next = owner || null;
    const changed = next !== scoreOwner;
    scoreOwner = next;
    buildScorePanel.setTitle(scoreOwner ? `Build Score — ${scoreOwner}` : OWN_TITLE);
    return changed;
}

/**
 * Whose build the panel is showing.
 * @returns {string|null} The player's name, or null when it is your own
 */
export function scoreSourceOwner() {
    return scoreOwner;
}

/**
 * Which sections are folded open.
 *
 * Held outside the draw because the draw is where it would be lost: the panel
 * rebuilds its whole body every few seconds, so a fold living in the DOM would
 * spring shut again a moment after being opened.
 *
 * @type {Object<string, boolean>}
 */
let sectionOpen = {};

/** Put the folds back and the panel on your own build, for a test that must not inherit either */
export function resetBuildScorePanel() {
    sectionOpen = {};
    readScore = () => null;
    scoreOwner = null;
    buildScorePanel.setTitle(OWN_TITLE);
}

/**
 * What a breakdown row cost, in coins.
 *
 * The calculator supplies this directly. The fallback re-inflates the rounded
 * display string, which is only ever a tenth of a million out and is better than
 * dropping a line from the ordering because a row arrived in an older shape.
 *
 * @param {Object} row - A breakdown row
 * @returns {number} Coins
 */
function rowCost(row) {
    if (Number.isFinite(row?.cost)) return row.cost;
    const parsed = parseFloat(row?.value);
    return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
}

/**
 * The tail of an hrid, in words.
 * @param {string} hrid - Anything `/…/like_this`
 * @returns {string} `Like This`
 */
function hridLabel(hrid) {
    return String(hrid || '')
        .split('/')
        .pop()
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * One line of a breakdown: what it is, and what it is worth.
 *
 * @param {Object} entry - A breakdown row from `calculateCombatScore`
 * @param {string} [suffix] - A dim note after the name, such as the slot it sits in
 * @returns {HTMLElement}
 */
function breakdownLine(entry, suffix = '') {
    const line = document.createElement('div');
    Object.assign(line.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '1px 0 1px 12px',
    });

    if (entry.itemHrid) {
        const icon = itemIcon(entry.itemHrid, 16);
        linkToMarketplace(icon, entry.itemHrid, navigateToMarketplace);
        line.appendChild(icon);
    }

    const name = document.createElement('span');
    name.textContent = entry.name;
    Object.assign(name.style, { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    line.appendChild(name);

    if (suffix) {
        const note = document.createElement('span');
        note.textContent = suffix;
        Object.assign(note.style, { color: ROW_COLORS.dim, whiteSpace: 'nowrap', fontSize: '11px' });
        line.appendChild(note);
    }

    const value = document.createElement('span');
    value.textContent = entry.value;
    // A row nobody is selling the parts for is dim rather than gold: it is not a
    // small contribution, it is one the market cannot put a number on, and it is
    // not in the total above it
    Object.assign(value.style, { color: entry.unpriced ? ROW_COLORS.dim : ROW_COLORS.gold, whiteSpace: 'nowrap' });
    line.appendChild(value);

    if (entry.unpriced) {
        const books = entry.books ? `${formatWithSeparator(Math.ceil(entry.books))} books, ` : '';
        line.title = `${entry.name}: ${books}none of them listed on the market, so it is not counted in the score`;
    } else {
        line.title = `${entry.name}: ${formatWithSeparator(Math.round(rowCost(entry)))} coins`;
    }
    if (entry.tokens > 0) line.title += `, and ${formatWithSeparator(entry.tokens)} guild tokens, which have no price`;
    return line;
}

/**
 * A contribution and the lines it is made of, folded away until asked for.
 *
 * @param {HTMLElement} host - Where it goes
 * @param {Object} definition - The section
 * @param {string} definition.id - Stable key the fold is remembered under
 * @param {string} definition.title - What the contribution is
 * @param {number} definition.score - Its share of the total
 * @param {Array<Object>} definition.rows - Its constituents
 * @param {Function} [definition.suffixOf] - `(row) => string`, a dim note per line
 * @param {string} [definition.note] - Something to say under the lines
 */
function contributionSection(host, { id, title, score, rows, suffixOf = null, note = '' }) {
    const open = sectionOpen[id] ?? false;

    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        cursor: rows.length ? 'pointer' : 'default',
        userSelect: 'none',
        padding: '1px 0',
    });
    header.dataset.section = id;

    const label = document.createElement('span');
    label.textContent = `${rows.length ? (open ? '▼' : '▶') : '·'} ${title}`;
    label.style.flex = '1';

    const value = document.createElement('span');
    value.textContent = score.toFixed(1);
    Object.assign(value.style, { color: ROW_COLORS.good, whiteSpace: 'nowrap' });

    header.append(label, value);
    header.title = rows.length
        ? `${rows.length} ${rows.length === 1 ? 'line' : 'lines'} — click to ${open ? 'fold away' : 'break down'}`
        : 'Nothing here to break down';
    if (rows.length) {
        header.addEventListener('click', () => {
            // Recorded before the redraw, so the next draw finds the choice
            sectionOpen[id] = !open;
            buildScorePanel.render();
        });
    }
    host.appendChild(header);

    if (!open || !rows.length) return;

    const content = document.createElement('div');
    content.dataset.sectionBody = id;
    Object.assign(content.style, { display: 'flex', flexDirection: 'column', margin: '2px 0 5px' });
    for (const entry of rows) content.appendChild(breakdownLine(entry, suffixOf ? suffixOf(entry) : ''));
    if (note) {
        const footer = panelNote(note);
        footer.style.padding = '2px 0 0 12px';
        footer.style.fontSize = '11px';
        content.appendChild(footer);
    }
    host.appendChild(content);
}

/**
 * The panel's contents as plain text, for the clipboard.
 *
 * This is a score people screenshot to compare builds, so the summary leads
 * with the two totals and then, like the panel, breaks each down by section —
 * largest contribution first, same ordering as {@link combatSections} and
 * {@link skillerSections}.
 *
 * @param {Object} score - Result of `calculateCombatScore`
 * @param {string|null} owner - Whose build this is, or null for your own
 * @returns {string} Empty when there is no score yet
 */
export function buildScoreSummaryText(score, owner) {
    if (!score) return '';

    const lines = [owner ? `Build Score — ${owner}` : 'Build Score'];
    lines.push(`Combat Score: ${(score.total || 0).toFixed(1)}`);
    for (const section of combatSections(score)) {
        lines.push(`  ${section.title}: ${section.score.toFixed(1)}`);
    }
    lines.push(`Skiller Score: ${(score.skillerTotal || 0).toFixed(1)}`);
    for (const section of skillerSections(score)) {
        lines.push(`  ${section.title}: ${section.score.toFixed(1)}`);
    }
    return lines.join('\n');
}

/**
 * A single copy affordance, right-aligned above the score cards.
 *
 * Same shape as Party Loot's and Party Luck's — a glyph rather than a word,
 * and a tick in its place rather than a colour change on click, so the flash
 * reads at a glance.
 *
 * @param {string} text - What clicking it copies
 * @returns {HTMLElement}
 */
function copyBar(text) {
    const bar = document.createElement('div');
    Object.assign(bar.style, { display: 'flex', justifyContent: 'flex-end' });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '⧉';
    copyBtn.title = 'Copy this score as plain text — the figure people compare builds with.';
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
            .catch((error) => console.error('[BuildScore] Copy failed:', error));
    });
    bar.appendChild(copyBtn);
    return bar;
}

/**
 * A score and the contributions under it.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {string} title - What score this is
 * @param {number} total - The figure
 * @param {string} accent - Ink
 * @returns {HTMLElement} The card, to add sections to
 */
function scoreCard(body, title, total, accent) {
    const card = panelCard(body, undefined, accent);

    const header = document.createElement('div');
    Object.assign(header.style, {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontWeight: 'bold',
        marginBottom: '4px',
    });

    const label = document.createElement('span');
    label.textContent = title;
    Object.assign(label.style, { color: accent, flex: '1' });

    const value = document.createElement('span');
    value.textContent = total.toFixed(1);
    Object.assign(value.style, { color: ROW_COLORS.good, whiteSpace: 'nowrap' });

    header.append(label, value);
    card.appendChild(header);
    return card;
}

/**
 * The shrine section's footnote: the tokens spent, plus the credit costs nothing
 * could price. A shrine figure short by an unpriced credit is a floor, and a
 * floor presented as a price is the one thing the rest of this panel refuses to
 * do — an unpriced gear piece is drawn as "no price" rather than dropped.
 *
 * @param {number} tokens - Guild tokens spent on these shrines
 * @param {number} unpricedCredits - Credit costs with no gold conversion
 * @returns {string} The note
 */
function shrineNote(tokens, unpricedCredits) {
    const note = `${formatWithSeparator(tokens || 0)} guild tokens also spent, which have no price.`;
    if (!(unpricedCredits > 0)) return note;
    return (
        `${note} ${unpricedCredits} credit cost${unpricedCredits === 1 ? '' : 's'} could not be priced either, ` +
        'so this figure is a floor.'
    );
}

/**
 * The sections of the combat score, largest first.
 *
 * Ordered by what they are worth rather than by the order the calculator
 * happens to produce them, because the question the panel is answering is which
 * part of the build the score is actually coming from.
 *
 * @param {Object} score - Result of `calculateCombatScore`
 * @returns {Array<Object>} Section definitions for `contributionSection`
 */
function combatSections(score) {
    const sections = [
        {
            id: 'combat-equipment',
            title: 'Equipment',
            score: score.equipment || 0,
            rows: score.breakdown?.equipment || [],
            suffixOf: (entry) => hridLabel(entry.slot),
        },
        {
            id: 'combat-abilities',
            title: 'Abilities',
            score: score.ability || 0,
            rows: score.breakdown?.abilities || [],
        },
        {
            id: 'combat-house',
            title: 'House',
            score: score.house || 0,
            rows: score.breakdown?.houses || [],
        },
    ];

    // Shrine levels are shared on every profile now, so a bought shrine is worth
    // a line — and it is counted in the combat total above, like everything else.
    if (score.guildShrineKnown && score.guildShrineCombat > 0) {
        sections.push({
            id: 'combat-shrines',
            title: 'Guild shrines',
            score: score.guildShrineCombat,
            rows: score.breakdown?.guildShrinesCombat || [],
            note: shrineNote(score.guildShrineCombatTokens, score.guildShrineCombatUnpricedCredits),
        });
    }

    return sections.sort((a, b) => b.score - a.score);
}

/**
 * The sections of the skiller score, largest first.
 * @param {Object} score - Result of `calculateCombatScore`
 * @returns {Array<Object>} Section definitions for `contributionSection`
 */
function skillerSections(score) {
    const sections = [
        {
            id: 'skiller-equipment',
            title: 'Equipment',
            score: score.skillerEquipment || 0,
            rows: score.skillerBreakdown?.equipment || [],
            suffixOf: (entry) => hridLabel(entry.slot),
            note: 'Gear with no skill requirement is counted in both scores, so the two do not add up.',
        },
    ];

    if (score.guildShrineKnown && score.skillerGuildShrine > 0) {
        sections.push({
            id: 'skiller-shrines',
            title: 'Guild shrines',
            score: score.skillerGuildShrine,
            rows: score.skillerBreakdown?.guildShrines || [],
            note: shrineNote(score.skillerGuildShrineTokens, score.skillerGuildShrineUnpricedCredits),
        });
    }

    return sections.sort((a, b) => b.score - a.score);
}

/**
 * The individual lines that most of the score is sitting in.
 *
 * Across both scores, deduplicated: a piece of gear with no level requirement is
 * counted in the combat score and the skiller score both, and listing it twice
 * would read as owning two of it.
 *
 * @param {Object} score - Result of `calculateCombatScore`
 * @returns {Array<Object>} `{name, value, cost, itemHrid, from}`, largest first
 */
export function topContributors(score) {
    const seen = new Map();
    const add = (rows, from) => {
        for (const entry of rows || []) {
            // Keyed by section and name, so the same item reached through both
            // equipment lists lands on the same key and is kept once
            const key = `${from}:${entry.name}`;
            if (seen.has(key)) continue;
            seen.set(key, { ...entry, from });
        }
    };

    add(score.breakdown?.equipment, 'Equipment');
    add(score.skillerBreakdown?.equipment, 'Equipment');
    add(score.breakdown?.abilities, 'Ability');
    add(score.breakdown?.houses, 'House');
    if (score.guildShrineKnown) add(score.breakdown?.guildShrines, 'Shrine');

    return [...seen.values()].sort((a, b) => rowCost(b) - rowCost(a)).slice(0, TOP_CONTRIBUTORS);
}

/**
 * Where the score is concentrated, without unfolding anything.
 * @param {HTMLElement} body - Where it goes
 * @param {Object} score - Result of `calculateCombatScore`
 */
function drawContributors(body, score) {
    const top = topContributors(score);
    if (!top.length) return;

    const card = panelCard(body, `Biggest ${top.length} contributors`, ROW_COLORS.gold);
    for (const entry of top) card.appendChild(breakdownLine(entry, entry.from));
}

/**
 * What a build score is made of — yours by default, or whoever's profile is open.
 */
export const buildScorePanel = createPanel({
    id: 'buildScore',
    title: OWN_TITLE,
    size: { width: 380, height: 480 },
    accent: COMBAT_ACCENT,
    draw: (body) => {
        const note = panelNote(HEADER_NOTE);
        note.title =
            'Houses, ability books, worn gear and shrine levels, priced at what they would cost to buy today, ' +
            'divided by a million. The same figure as the one on the profile card.';
        body.appendChild(note);

        const score = readScore();
        if (!score) {
            const whose = scoreOwner ? `${scoreOwner}'s build` : 'your build';
            body.appendChild(panelNote(`Scoring ${whose} — this needs the marketplace prices and a moment.`));
            return;
        }

        body.appendChild(copyBar(buildScoreSummaryText(score, scoreOwner)));

        const combat = scoreCard(body, 'Combat Score', score.total || 0, COMBAT_ACCENT);
        for (const definition of combatSections(score)) contributionSection(combat, definition);

        const skiller = scoreCard(body, 'Skiller Score', score.skillerTotal || 0, SKILLER_ACCENT);
        for (const definition of skillerSections(score)) contributionSection(skiller, definition);

        drawContributors(body, score);

        if (score.equipmentHidden && !score.hasEquipmentData) {
            body.appendChild(panelNote('Equipment is hidden on this profile, so none of it is priced.'));
        }
    },
});

export default buildScorePanel;
