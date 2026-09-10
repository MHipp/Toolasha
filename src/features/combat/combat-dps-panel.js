/**
 * Who is carrying a normal fight, on the same board a guild trial gets.
 *
 * `guild-trial-scoreboard.js` answers "who did what" for a guild trial — ranks,
 * shares, bars, a rate per player and a tab per quantity. A party farming a
 * zone asks exactly the same question and had nowhere to ask it: the numbers
 * were already being collected (`damage-tracker.js` per player, and
 * `damage-taken-tracker.js` for what comes back), and the only place any of it
 * surfaced per player was the DPS panel's flat list and, since recently, a
 * badge on a portrait.
 *
 * So this is that panel, pointed at the run-side trackers. Everything about
 * *drawing* a ranked board — the headline, the tab strip, the row with its
 * share bar, the copy text — comes from `utils/damage-board.js`, which the
 * trial panel now draws with too. What is written here is the part that is
 * genuinely different: which tracker feeds which tab, and what each figure
 * honestly is.
 *
 * ## Three tabs, and the third one is not "healing done"
 *
 * - **Damage** — `damageBreakdown()`. Per player, including damage-over-time
 *   and reflect, which move a monster's health with no swing behind them.
 * - **Taken** — `takenBreakdown()`. Health actually lost, after mitigation, and
 *   a floor at that: damage healed on the same tick was never visible.
 * - **Healed** — the same tracker's `regen`, which is health *restored*: a
 *   heal, a life-steal and the game's own regeneration are one number here
 *   because nothing on the wire separates them. It is therefore healing
 *   **received**, not healing done, and it is labelled that way rather than
 *   being quietly ranked as if it credited a healer. The run side exposes no
 *   per-caster healing at all — that only exists for a spectated trial, where
 *   the stream carries a lone caster to attribute a rise to.
 *
 * ## A fourth tab that is not about the party at all
 *
 * - **Rotation** — your own abilities, from `rotation-tracker.js`. Three tabs of
 *   "who is carrying this" answer nothing you can act on mid-fight; the one
 *   thing you can change is your own bar, and the question there is per ability
 *   rather than per player: which of them fire, which are ready and cannot be
 *   paid for, and what each one buys per cast, per point of mana and per second
 *   of the cooldown it occupies. The starvation arithmetic is the guild trial
 *   support module's, generalised in `utils/rotation-audit.js` rather than
 *   written twice. Its third scope, History, is the tracker's ring of finished
 *   fights: a session average hides the wave the bar ran dry on, and the fight
 *   scope has already been cleared by the time you look at it.
 *
 * ## Everything is the party's, and in a party nothing says who struck
 *
 * The attribution is `utils/damage-attribution.js`' and its limits are its own:
 * a tick where two players hit the same monster is split between them, and a
 * split is not a measurement. The panel says so once, at the top, rather than
 * footnoting each row — a reader who takes a shared-out estimate for a measured
 * figure has been misled by the panel.
 *
 * Off by default (`combatDpsPanel`), like every panel that has to be asked for.
 * Position, size, collapsed state and whether it was left open all live in
 * `panel-geometry` through `createPanel`, the same as the rest.
 *
 * The idea of a per-player meter for a normal fight is DPs', from MWI Combat
 * Suite by Frotty (MIT), and the board's shape is KikiMeter's by ZhuLiMoon
 * (MIT) — see `third-party/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { damageBreakdown, actionLabel } from './damage-tracker.js';
import { takenBreakdown } from './damage-taken-tracker.js';
import { rotationAudit, startRotationTracker, stopRotationTracker } from './rotation-tracker.js';
import { createPanel } from '../../utils/simple-panel.js';
import {
    BOARD_COLORS,
    boardButtonsHTML,
    boardHeadHTML,
    boardNoteHTML,
    boardRowHTML,
    boardTabsHTML,
    boardLines,
    escapeText,
    rankRows,
} from '../../utils/damage-board.js';
import { classTagIconHTML } from '../../utils/class-weapon.js';
import { MIN_SECONDS } from '../../utils/rotation-audit.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/**
 * How often the opener is re-offered when the observer missed the panel.
 *
 * The observer is the primary signal, but a battle panel that existed before
 * initialize ran — or that React rebuilt in a way the observer's descendant
 * scan did not see — left the button missing until a manual re-init. Every
 * couple of seconds `inject` is asked again; it is a no-op while the button
 * stands, so the cost is one getElementById.
 */
const REINJECT_MS = 2000;
/** How often the timer may scan the document for a battle panel nothing told it about */
const DISCOVERY_MS = 10000;

/** Geometry key and DOM id stem — `toolasha-combatDpsPanel-panel` */
export const PANEL_ID = 'combatDpsPanel';

/** The opener injected into the battle panel */
export const BUTTON_ID = 'toolasha-combat-dps-panel-button';

/** Where the party's tiles live, which is what the opener sits above */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/** The tabs, in the order the trial board puts its own */
export const TABS = [
    { key: 'damage', label: 'Damage' },
    { key: 'taken', label: 'Taken' },
    { key: 'healed', label: 'Healed' },
    { key: 'rotation', label: 'Rotation' },
];

/** Which tab is showing. Remembered between openings, the way a panel should */
let tab = 'damage';

/**
 * Which scope the Rotation tab shows: the fight on screen, or the whole run.
 * The run by default — a fight can be two seconds long, and a tab that empties
 * itself every two seconds reads as a tab that keeps resetting
 */
let scope = 'session';

/**
 * The Rotation tab's scopes, in display order.
 *
 * `history` is not a summary like the other two: it draws the tracker's ring of
 * finished fights, one row each, and answers *which* fight rather than what the
 * run averages to.
 */
export const ROTATION_SCOPES = [
    { key: 'fight', label: 'This fight' },
    { key: 'session', label: 'Session' },
    { key: 'history', label: 'History' },
];

/**
 * The rows one tab shows, ranked, with shares.
 *
 * Pure over its inputs, so the arithmetic is tested without a DOM or a live
 * fight. Each tab keeps the tracker's own per-second figure rather than
 * re-deriving one: a tracker that returns null is saying "not enough of a run
 * to divide by", which is a different statement from a rate of nothing and
 * must not be overwritten with one.
 *
 * @param {string} which - A key of {@link TABS}
 * @param {Object} [sources] - Injectable for tests
 * @param {Function} [sources.dealt] - `damageBreakdown`
 * @param {Function} [sources.taken] - `takenBreakdown`
 * @returns {{rows: Array<Object>, total: number, perSecond: number|null, seconds: number}}
 */
export function panelRows(which, { dealt = damageBreakdown, taken = takenBreakdown } = {}) {
    // The Rotation tab is not a ranked board of players: its rows are your own
    // abilities and it builds them itself
    if (which === 'rotation') return rankRows([], 0);

    const dealtRun = dealt() || {};
    if (which === 'damage') {
        return rankRows(
            (dealtRun.players || []).map((row) => ({
                name: row.name,
                value: row.damage || 0,
                perSecond: row.dps ?? null,
                classTag: row.classTag || null,
            })),
            dealtRun.seconds || 0
        );
    }

    // The taken tracker knows nothing about casts, so the class comes from the
    // dealt side by name — the same party, keyed differently
    const classByName = {};
    for (const row of dealtRun.players || []) {
        if (row?.name && row.classTag) classByName[row.name] = row.classTag;
    }

    const run = taken() || {};
    const rows = (run.players || []).map((row) => ({
        name: row.name,
        value: (which === 'healed' ? row.regen : row.damage) || 0,
        perSecond: (which === 'healed' ? row.hps : row.dps) ?? null,
        classTag: classByName[row.name] || null,
    }));
    return rankRows(rows, run.seconds || 0);
}

/**
 * The class chip for one row: the T95 weapon of the inferred role, or a dim
 * text chip when the icon cannot be resolved, or nothing when there is no
 * verdict yet.
 * @param {Object|null} verdict - A row's `classTag`, from `inferClass`
 * @returns {string} HTML, possibly empty
 */
export function classTagHTML(verdict) {
    const label = String(verdict?.short || '').replace(/[^A-Z]/g, '');
    if (!label) return '';

    const title = `${label} — inferred from what this player was seen casting this run.`;
    const icon = classTagIconHTML(verdict, { title, size: 13 });
    if (icon) return icon;

    const { dim } = BOARD_COLORS;
    return (
        `<span title="${title}" style="color:${dim}; font-size:9px; letter-spacing:0.5px; ` +
        `border:1px solid ${dim}; border-radius:3px; padding:0 3px;">${label}</span>`
    );
}

/** What each tab's figures are, said once at the top rather than per row */
const NOTES = {
    damage: {
        strong: 'Attributed off this client’s own battle feed.',
        color: BOARD_COLORS.good,
        detail:
            'Damage is inferred from health lost between combat ticks — the game sends no damage figure — so ' +
            'overkill is not counted and a tick two players both hit on is shared between them. Includes ' +
            'damage-over-time and reflect, which move health with no swing behind them.',
    },
    taken: {
        strong: 'Health actually lost, after mitigation.',
        color: BOARD_COLORS.warn,
        detail:
            'A floor rather than a total: damage healed back on the same tick was never visible. This is not the ' +
            'game’s pre-mitigation figure and the two do not match by design.',
    },
    healed: {
        strong: 'Health restored — received, not healing done.',
        color: BOARD_COLORS.accent,
        detail:
            'A heal, a life-steal and the zone’s own regeneration are one number here, because nothing on the ' +
            'wire separates them. Ranking this does not say who healed: the run feed carries no caster to credit ' +
            'a rise to, and inventing one would be worse than saying so.',
    },
};

/** The ink each verdict is drawn in — the two that want acting on stand out */
const VERDICT_COLORS = {
    starved: BOARD_COLORS.warn,
    pinched: BOARD_COLORS.warn,
    idle: BOARD_COLORS.dim,
    fine: BOARD_COLORS.good,
    unknown: BOARD_COLORS.dim,
    measuring: BOARD_COLORS.dim,
};

/**
 * A figure or an em dash — never a zero standing in for "nothing to divide by".
 * @param {number|null} value - The figure
 * @param {Function} [format] - How to draw it
 * @returns {string}
 */
function figure(value, format = (n) => formatKMB(Math.round(n))) {
    return value === null || value === undefined || !Number.isFinite(value) ? '—' : format(value);
}

/** @param {number|null} share - 0..1 @returns {string} A percentage or a dash */
function percent(share) {
    return share === null || share === undefined || !Number.isFinite(share) ? '—' : `${Math.round(share * 100)}%`;
}

/**
 * One ability's row: what it produced, what it cost, and whether it fires.
 *
 * The bar behind it is **uptime**, not a share of damage — this tab ranks by
 * whether an ability is in the rotation at all, and a heavy ability cast twice
 * would otherwise draw a longer bar than the one holding the fight together.
 *
 * @param {Object} row - From `summariseRotation`
 * @returns {string} HTML
 */
export function rotationRowHTML(row) {
    const { dim } = BOARD_COLORS;
    const color = VERDICT_COLORS[row?.verdict?.kind] || BOARD_COLORS.accent;
    const width = Math.max(2, Math.min(100, (row?.uptime ?? 0) * 100));

    const perMana = row.damagePerMana === null ? '—' : formatKMB(Math.round(row.damagePerMana * 10) / 10);
    const perCooldown = figure(row.damagePerCooldownSecond);
    const detail =
        `${formatWithSeparator(row.casts)} casts · ${figure(row.outputPerCast)}/cast · ${perMana}/mana · ` +
        `${perCooldown}/cd-s · starved ${percent(row.starvedShare)} of ready`;

    return (
        `<div style="position:relative; margin:3px 0; padding:3px 6px; border-radius:3px;` +
        `background:linear-gradient(to right, ${color}44 ${width}%, rgba(255,255,255,0.04) ${width}%);">` +
        `<div style="display:flex; gap:6px; align-items:baseline;">` +
        `<span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
        `${escapeText(actionLabel(row.hrid))}</span>` +
        (row.equipped && row.casts === 0
            ? `<span style="color:${dim}; font-size:9px; border:1px solid ${dim}; border-radius:3px; padding:0 3px;"` +
              ` title="On the bar and never seen firing this scope.">slotted</span>`
            : '') +
        `<span style="margin-left:auto; color:${color}; font-weight:600;">${percent(row.uptime)}</span>` +
        `</div>` +
        `<div style="color:${dim}; font-size:10px;">${escapeText(detail)}</div>` +
        `<div style="color:${color}; font-size:10px; line-height:1.4;">${escapeText(row.verdict.text)}</div>` +
        `</div>`
    );
}

/**
 * The lines under the rows: what mana did over the scope, and the one change
 * the numbers point at.
 *
 * @param {Object} summary - From `summariseRotation`
 * @returns {string} HTML
 */
export function rotationSummaryHTML(summary) {
    const { dim, warn, good } = BOARD_COLORS;
    const balance = summary.manaBalance;
    const balanceColor = balance === null ? dim : balance < 0 ? warn : good;

    const lines = [
        [
            'Mana',
            `${figure(summary.manaPerMinute)}/min spent · ${figure(summary.regenPerMinute)}/min restored`,
            balanceColor,
        ],
        [
            'Starved',
            summary.starvedSeconds === null
                ? '—'
                : `${summary.starvedSeconds.toFixed(1)}s per fight under the cheapest cast` +
                  (summary.castFloor === null ? '' : ` (${formatWithSeparator(summary.castFloor)} mana)`),
            summary.starvedSeconds > 0 ? warn : dim,
        ],
        [
            'Measured',
            `${summary.seconds.toFixed(0)}s of fighting over ${formatWithSeparator(summary.fights)} fights`,
            dim,
        ],
    ];

    const rows = lines
        .map(
            ([label, value, color]) =>
                `<div style="display:flex; gap:8px; font-size:11px; line-height:1.6;">` +
                `<span style="color:${dim};">${escapeText(label)}</span>` +
                `<span style="margin-left:auto; color:${color}; text-align:right;">${escapeText(value)}</span></div>`
        )
        .join('');

    const suggestion = summary.suggestion
        ? `<div style="margin-top:6px; padding:4px 6px; border-left:2px solid ${BOARD_COLORS.accent};` +
          ` color:${BOARD_COLORS.accent}; font-size:10px; line-height:1.5;">${escapeText(summary.suggestion.text)}</div>`
        : '';

    return `<div style="margin-top:8px;">${rows}${suggestion}</div>`;
}

/**
 * The summary a scope key names.
 *
 * `history` has none of its own — it is a list of fights, not an audit — so the
 * things that need a summary while it is showing (the variance copy, and the
 * head) read the session's, which is the scope the history is a slice of.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {Object|undefined} The summary
 */
function scopeSummary(audit, which) {
    if (which === 'history') return audit?.session || audit?.fight;
    return audit?.[which] || audit?.fight;
}

/**
 * One finished fight, as a history row.
 *
 * Two lines rather than an expander: the per-ability casts are the reason to
 * look at a history at all — "which fight was the one it stopped firing in" —
 * and a count behind a click is a count nobody reads.
 *
 * @param {Object} record - From `fightRecord`
 * @param {number} index - Its place in the buffer, newest first
 * @returns {string} HTML
 */
export function rotationHistoryRowHTML(record, index) {
    const { dim, warn } = BOARD_COLORS;
    const manaPerMinute = record.seconds > 0 ? (record.manaSpent / record.seconds) * 60 : null;
    const casts = record.abilities.length
        ? record.abilities.map((row) => `${actionLabel(row.hrid)} ${row.casts}`).join(' · ')
        : 'no casts seen';

    return (
        `<div style="margin:3px 0; padding:3px 6px; border-radius:3px; background:rgba(255,255,255,0.04);">` +
        `<div style="display:flex; gap:6px; align-items:baseline; font-size:11px;">` +
        `<span style="color:${dim}; width:22px;">#${index + 1}</span>` +
        `<span style="font-weight:600;">${record.seconds.toFixed(0)}s</span>` +
        `<span style="color:${dim};">${formatWithSeparator(record.casts)} casts</span>` +
        `<span style="margin-left:auto; color:${dim};">${figure(manaPerMinute)} mana/min</span>` +
        `<span style="color:${record.starvedSeconds > 0 ? warn : dim}; width:56px; text-align:right;">` +
        `starved ${record.starvedSeconds.toFixed(1)}s</span>` +
        `</div>` +
        `<div style="color:${dim}; font-size:10px; line-height:1.4;">${escapeText(casts)}</div>` +
        `</div>`
    );
}

/**
 * The History scope's body: the finished fights, newest first.
 *
 * @param {Array<Object>} history - From `rotationAudit`
 * @returns {string} HTML
 */
export function rotationHistoryHTML(history) {
    const fights = Array.isArray(history) ? history : [];

    return (
        boardNoteHTML('The last fights, newest first — one row each.', {
            color: BOARD_COLORS.good,
            strong: true,
        }) +
        boardNoteHTML(
            `Kept in memory only, for this character and this session: switching character or resetting the run ` +
                `empties it. A fight shorter than ${MIN_SECONDS}s is left out, because every figure over it is one ` +
                'lucky swing rather than a measurement. The second line is what fired, and how often.'
        ) +
        (fights.length
            ? fights.map(rotationHistoryRowHTML).join('')
            : boardNoteHTML('No finished fights yet — a fight is recorded when the next one begins.'))
    );
}

/**
 * The history as plain text, one line per fight.
 * @param {Array<Object>} history - From `rotationAudit`
 * @returns {string}
 */
export function rotationHistoryText(history) {
    const fights = Array.isArray(history) ? history : [];
    const head = `Rotation history — the last ${fights.length} fights, newest first`;
    if (!fights.length) return `${head}\nNo finished fights recorded yet.`;

    const lines = fights.map((record, index) => {
        const manaPerMinute = record.seconds > 0 ? (record.manaSpent / record.seconds) * 60 : null;
        const casts = record.abilities.map((row) => `${actionLabel(row.hrid)} ${row.casts}`).join(', ') || 'none';
        return (
            `#${index + 1}: ${record.seconds.toFixed(0)}s, ${record.casts} casts, ` +
            `${figure(manaPerMinute)} mana/min spent, starved ${record.starvedSeconds.toFixed(1)}s — ${casts}`
        );
    });

    return [head, ...lines].join('\n');
}

/**
 * The Rotation tab's whole body.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string} HTML
 */
export function rotationHTML(audit, which) {
    const summary = scopeSummary(audit, which);
    const { dim } = BOARD_COLORS;

    const scopes =
        `<div style="display:flex; gap:6px; margin:6px 0;">` +
        ROTATION_SCOPES.map((entry) => {
            const on = entry.key === which;
            const color = on ? BOARD_COLORS.accent : dim;
            return (
                `<button data-scope="${entry.key}" style="flex:1; cursor:pointer; padding:2px 0; border-radius:4px;` +
                ` border:1px solid ${color}66; background:${on ? `${color}22` : 'transparent'}; color:${color};` +
                ` font-size:10px;">${entry.label}</button>`
            );
        }).join('') +
        `</div>`;

    // The history stands on its own: it needs no slot to have been named — a
    // fight it recorded already had one — and it has no verdicts to draw
    if (which === 'history') return scopes + rotationHistoryHTML(audit?.history);

    if (!audit?.tracking) {
        // Rows can exist before a battle names the slot — a previous session's
        // kit, or a loadout read ahead of the first fight. Throwing them away
        // and showing only the notice loses the one thing worth reading, so the
        // notice goes *above* whatever has been seeded rather than instead of it
        const seeded = summary?.abilities?.length
            ? summary.abilities.map(rotationRowHTML).join('')
            : boardNoteHTML('Nothing on the bar yet.');

        return (
            scopes +
            boardNoteHTML('Waiting for a battle to name your slot.', { color: dim, strong: true }) +
            boardNoteHTML(
                'Your abilities are read from the loadout the game states for your own character at the start of a ' +
                    'battle, so nothing is measured until one begins. Nobody else’s row appears here — this tab is ' +
                    'about the bar you can change.'
            ) +
            seeded
        );
    }

    const rows = summary.abilities.length
        ? summary.abilities.map(rotationRowHTML).join('')
        : `<div style="color:${dim}; padding:6px 0; line-height:1.5;">Nothing on the bar yet.</div>`;

    return (
        boardHeadHTML({
            value: summary.manaPerMinute,
            label: 'mana/min spent',
            right: summary.measurable ? `${percent(summary.starvedShare)} starved` : '—',
            color: BOARD_COLORS.accent,
        }) +
        scopes +
        boardNoteHTML('Your own abilities: whether each one fires, and what it buys.', {
            color: BOARD_COLORS.good,
            strong: true,
        }) +
        boardNoteHTML(
            'Uptime is the share of the fight an ability spent on cooldown, against the cooldown the game states — ' +
                'haste is not on the wire, so a hasted ability reads low rather than being guessed at. “Starved” is ' +
                'time it was off cooldown with the bar below its cost: the ability could not fire, which is a ' +
                'different problem from the rotation never reaching it. Mana spent and restored are measured off ' +
                'the bar; per-ability mana is the stated cost times casts.'
        ) +
        rows +
        rotationSummaryHTML(summary) +
        (summary.incomplete
            ? boardNoteHTML('Some abilities state no mana cost, so the per-mana figures are a lower bound.')
            : '')
    );
}

/**
 * The Rotation tab as plain text, for the clipboard.
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string}
 */
export function rotationText(audit, which) {
    // The history is a record of fights that already happened, so it copies
    // whether or not a slot is named right now
    if (which === 'history') return rotationHistoryText(audit?.history);
    if (!audit?.tracking) return 'Rotation: waiting for a battle to name your slot.';

    const summary = audit[which] || audit.fight;
    const label = which === 'session' ? 'session' : 'this fight';
    const head =
        `Rotation (${label}) — ${summary.seconds.toFixed(0)}s over ${summary.fights} fights, ` +
        `${figure(summary.manaPerMinute)} mana/min spent against ${figure(summary.regenPerMinute)}/min restored, ` +
        `${summary.starvedSeconds === null ? '—' : `${summary.starvedSeconds.toFixed(1)}s`} per fight starved`;

    const rows = summary.abilities.map(
        (row) =>
            `${actionLabel(row.hrid)}: ${percent(row.uptime)} uptime, ${row.casts} casts, ` +
            `${figure(row.outputPerCast)}/cast, starved ${percent(row.starvedShare)} of ready — ${row.verdict.text}`
    );

    return [head, ...rows, summary.suggestion ? summary.suggestion.text : ''].filter(Boolean).join('\n');
}

/**
 * The gap between the bar the game states and what actually fired, as plain
 * text for the clipboard.
 *
 * Only the deviating rows are listed — the point of this copy is the variance,
 * not another full table. Three shapes qualify: an ability stated on the bar
 * that never fired, one seen firing that the game never stated, and one whose
 * own verdict already says it fires short of what it should (starved, idle,
 * pinched, or uncomputable). A row doing what its numbers promise is left off,
 * and an aura is skipped on the audit's own reasoning — cast once and kept up,
 * it has no cadence to vary from.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string}
 */
export function rotationVarianceText(audit, which) {
    if (!audit?.tracking) return 'Rotation variances: waiting for a battle to name your slot.';

    const summary = scopeSummary(audit, which);
    const label = which === 'fight' ? 'this fight' : 'session';
    const head =
        `Rotation variances (${label}) — the stated bar against what fired, ` +
        `over ${summary.seconds.toFixed(0)}s and ${summary.fights} fights`;

    const lines = [];
    for (const row of summary.abilities) {
        if (row.verdict.kind === 'aura') continue;
        const name = actionLabel(row.hrid);

        if (!row.equipped && row.casts > 0) {
            lines.push(`${name}: fired ${row.casts}x, but the game never stated it on the bar.`);
            continue;
        }
        if (row.equipped && row.casts === 0) {
            lines.push(`${name}: stated on the bar and never fired — ${row.verdict.text}`);
            continue;
        }
        if (row.verdict.kind === 'starved' || row.verdict.kind === 'idle' || row.verdict.kind === 'pinched') {
            // The casts its stated cooldown allowed, so the shortfall is a figure
            // rather than only a verdict
            const possible =
                row.cooldownSeconds > 0 && summary.seconds > 0
                    ? Math.floor(summary.seconds / row.cooldownSeconds)
                    : null;
            const cadence = possible !== null && possible > row.casts ? ` (≈${possible} allowed by cooldown)` : '';
            lines.push(`${name}: ${row.casts} casts${cadence} — ${row.verdict.text}`);
            continue;
        }
        if (row.verdict.kind === 'unknown' && row.casts > 0) {
            lines.push(`${name}: ${row.casts} casts — ${row.verdict.text}`);
        }
    }

    if (!lines.length) {
        return `${head}\nNo variances: everything the game states on the bar fired, at a cadence its cooldown allows.`;
    }
    return [head, ...lines].join('\n');
}

/**
 * The panel's contents as plain text, for the clipboard.
 * @param {string} which - A key of {@link TABS}
 * @param {Object} [sources] - As {@link panelRows}
 * @returns {string}
 */
export function panelText(which, sources) {
    if (which === 'rotation') return rotationText((sources?.audit || rotationAudit)(), scope);

    const { rows, total, perSecond, seconds } = panelRows(which, sources);
    const label = which === 'healed' ? 'health restored' : which === 'taken' ? 'damage taken' : 'damage';

    if (!rows.length) return `Party ${label}: nothing measured yet.`;

    const heading =
        `Party ${label} — ${formatWithSeparator(Math.round(total))} total` +
        (perSecond === null ? '' : `, ${formatWithSeparator(Math.round(perSecond))}/s`) +
        ` over ${Math.round(seconds)}s (attributed from this client’s battle feed)`;
    return boardLines(heading, rows);
}

/**
 * Draw the board into a panel body.
 *
 * Takes the body rather than reaching for it, so a test can hand it a bare
 * `<div>` and read what came out.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} [sources] - As {@link panelRows}
 */
export function drawBoard(body, sources) {
    if (tab === 'rotation') {
        body.innerHTML =
            boardTabsHTML(TABS, tab) +
            rotationHTML((sources?.audit || rotationAudit)(), scope) +
            boardButtonsHTML([
                { key: 'copy', label: 'Copy stats' },
                { key: 'copy-variance', label: 'Copy variances' },
            ]);
        wireBoard(body, sources);
        return;
    }

    const { rows, total, perSecond } = panelRows(tab, sources);
    const note = NOTES[tab] || NOTES.damage;
    const unit = tab === 'healed' ? 'hps' : 'dps';

    const list = rows.length
        ? rows.map((row) => boardRowHTML(row, { tagHTML: classTagHTML(row.classTag) })).join('')
        : `<div style="color:${BOARD_COLORS.dim}; padding:6px 0; line-height:1.5;">` +
          'Nothing measured yet — the table fills in as the fight goes on. A run that has only just started has ' +
          'no seconds to divide by, which is why a rate can be dashed while a total is not.</div>';

    body.innerHTML =
        boardHeadHTML({
            value: perSecond,
            label: `party ${unit}`,
            right: total,
            color: BOARD_COLORS.accent,
        }) +
        boardTabsHTML(TABS, tab) +
        boardNoteHTML(note.strong, { color: note.color, strong: true }) +
        boardNoteHTML(note.detail) +
        list +
        boardButtonsHTML([{ key: 'copy', label: 'Copy stats' }]);

    wireBoard(body, sources);
}

/**
 * Attach the tab strip, the Rotation tab's scope switch and the copy button.
 *
 * One function for both branches of {@link drawBoard}: a tab that wired its own
 * buttons is a tab that can forget one, and the Rotation tab did not exist when
 * the wiring lived inline.
 *
 * @param {HTMLElement} body - The board's container
 * @param {Object} [sources] - As {@link panelRows}
 */
function wireBoard(body, sources) {
    body.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            tab = button.dataset.tab;
            drawBoard(body, sources);
        });
    });
    body.querySelectorAll('[data-scope]').forEach((button) => {
        button.addEventListener('click', () => {
            scope = button.dataset.scope;
            drawBoard(body, sources);
        });
    });
    body.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
        navigator.clipboard?.writeText?.(panelText(tab, sources))?.catch?.(() => {});
    });
    body.querySelector('[data-action="copy-variance"]')?.addEventListener('click', () => {
        navigator.clipboard
            ?.writeText?.(rotationVarianceText((sources?.audit || rotationAudit)(), scope))
            ?.catch?.(() => {});
    });
}

/** The panel shell, built the first time the feature is switched on */
let panel = null;

/**
 * The panel, created on demand.
 *
 * Built lazily rather than at import, because `createPanel` reopens a panel
 * that was left open when the page was last closed — and a panel whose setting
 * is off must not come back on its own. Creating it inside `initialize` puts
 * that behind the setting without a second switch to keep in step.
 *
 * @returns {Object} The shell, with `show`, `hide` and `toggle`
 */
export function getPanel() {
    if (panel) return panel;

    panel = createPanel({
        id: PANEL_ID,
        title: 'Party damage',
        size: { width: 320, height: 360 },
        accent: BOARD_COLORS.accent,
        draw: (body) => {
            // The shell's body is a flex column with a gap; the board is one
            // block that manages its own spacing, as it does in the trial panel
            body.style.display = 'block';
            body.style.padding = '8px 10px';
            drawBoard(body);
        },
    });
    return panel;
}

let unregister = null;
let unregisterReady = null;

/** The re-inject timer; cleared in cleanup */
const timers = createTimerRegistry();

/**
 * Put the opener on the battle panel, beside the party's tiles.
 *
 * The trial side lives its equivalent in the In Progress header, which is where
 * somebody watching a trial already is. The equivalent place for a normal fight
 * is the fight itself — a control on the combat page rather than a settings
 * round-trip. Re-injected on a DOM observer for the same reason the badges are:
 * React throws the battle panel away whenever the Combat tab is left and
 * returned to, and an anchor captured once is stale with nothing to notice it.
 */
/** Whether an element sits inside the guild panel — a trial's battle, not the party's */
function inGuildPanel(element) {
    return Boolean(element?.closest?.('[class*="GuildPanel"]'));
}

/** The button last injected, so the re-inject timer can tell "still there" cheaply */
let injected = null;

/**
 * The battle-panel area the button was last hung on.
 *
 * Out of combat there is no battle panel, and the timer below used to prove that
 * with two whole-document `[class*=]` scans every two seconds. Holding the area
 * the class watcher handed us turns "am I in a fight" into an `isConnected` read.
 */
let lastArea = null;

function inject() {
    if (typeof document === 'undefined') return;
    // The button already placed is the common case for the slow timer below;
    // it is answered off the cached element before any document query
    if (injected?.isConnected && !inGuildPanel(injected)) return;
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        // A button that landed in the trial's battle panel (In Progress tab)
        // comes back out: the trial has its own per-player board
        if (inGuildPanel(existing)) existing.remove();
        else return;
    }

    // The party's own battle, never the guild trial's: that panel renders the
    // same players area inside the Guild tab and has a scoreboard of its own
    const area =
        Array.from(document.querySelectorAll(PLAYERS_AREA)).find((el) => !inGuildPanel(el)) ||
        Array.from(document.querySelectorAll(GAME.BATTLE_PANEL)).find((el) => !inGuildPanel(el));
    if (!area) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Per-player';
    button.title = 'Damage, damage taken and health restored per party member, ranked.';
    button.style.cssText =
        'position:absolute; top:2px; right:2px; z-index:5; padding:1px 6px; border-radius:4px;' +
        `border:1px solid ${BOARD_COLORS.accent}66; background:rgba(18,20,28,0.85); color:${BOARD_COLORS.accent};` +
        'font-size:10px; line-height:1.4; cursor:pointer;';
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        getPanel().toggle();
    });

    // Absolute to the tile area, or it escapes to whatever the nearest
    // positioned ancestor happens to be
    if (!area.style.position) area.style.position = 'relative';
    area.appendChild(button);
    injected = button;
    lastArea = area;
}

/** When the last speculative scan for a missed battle panel was made */
let lastDiscoveryAt = 0;

/**
 * The timer's inject: nothing to do for a hidden tab.
 *
 * With a battle panel in hand this is the cheap path — `inject()` answers off the
 * cached button without touching the document. With nothing in hand the only way
 * to find a panel the class watcher missed is a pair of whole-document scans, and
 * that is the case that holds for hours at a time while nobody is fighting. So it
 * stays a safety net and drops to once every ten seconds.
 */
function reinject() {
    if (typeof document === 'undefined' || document.hidden) return;

    if (injected?.isConnected || lastArea?.isConnected) {
        inject();
        return;
    }

    const now = Date.now();
    if (now - lastDiscoveryAt < DISCOVERY_MS) return;
    lastDiscoveryAt = now;
    inject();
}

export default {
    name: 'Combat DPS Panel',
    initialize: () => {
        if (!config.getSetting('combatDpsPanel')) return;
        if (unregister) return;
        // Building the shell here is also what lets it reopen where it was
        // left, since that is `createPanel`'s doing
        getPanel();
        // The Rotation tab is the only reader of this, so it starts and stops
        // with the panel rather than carrying a setting of its own
        startRotationTracker();
        const onArea = (el) => {
            if (el && !inGuildPanel(el)) lastArea = el;
            inject();
        };
        unregister = domObserver.onClass('CombatDpsPanel', ['BattlePanel_playersArea'], onArea, {
            debounce: true,
            debounceDelay: 200,
            debounceMaxWait: 1000,
        });
        // @run-at document-start: a battle panel rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        unregisterReady = domObserver.onReady('CombatDpsPanelCatchUp', () => {
            inject();
            lastDiscoveryAt = Date.now();
        });
        timers.registerInterval(setInterval(reinject, REINJECT_MS));
    },
    cleanup: () => {
        try {
            unregister?.();
            unregister = null;
            unregisterReady?.();
            unregisterReady = null;
            stopRotationTracker();
            timers.clearAll();
            const button = typeof document === 'undefined' ? null : document.getElementById(BUTTON_ID);
            injected = null;
            lastArea = null;
            // The tile area was made a positioning context for the button's
            // sake; a game-owned element should not keep that once it is gone
            const area = button?.parentElement;
            button?.remove();
            if (area?.style?.position === 'relative') area.style.position = '';
            // Released rather than hidden, because the handle goes with it and
            // `initialize()` builds a fresh shell. `hide()` leaves the shell's
            // `character_switched` subscription in place — which is right for a
            // panel that will be shown again through the same handle, and a leak
            // here: a character switch runs this teardown and then that init, so
            // every switch left another shell's listener on the bus with nothing
            // holding its handle. Not remembered, for the same reason as before:
            // switching the feature off is not the user closing the panel.
            panel?.destroy();
            panel = null;
        } catch (error) {
            console.error('[Combat DPS Panel] Disable failed part-way:', error);
        }
    },
    /** For tests, and for a settings change that wants the board now */
    getPanel,
    /** Reset the remembered tab and scope — for tests, which must not inherit either */
    _resetTab: () => {
        tab = 'damage';
        scope = 'session';
    },
    /** Show a tab directly — for tests, which cannot click one */
    _setTab: (which, which2) => {
        tab = which;
        if (which2) scope = which2;
    },
};
