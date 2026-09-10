/**
 * Guild roster
 *
 * Who is actually carrying the guild, and who has stopped.
 *
 * The game shows each member's total guild XP, which is a career figure: it
 * ranks whoever joined first, not whoever contributed this week, and a member
 * who quit a month ago still sits near the top of it. The tracker has been
 * recording per-member XP over time for its XP/h columns, and that same series
 * answers the questions the total cannot — what share of the last week's XP each
 * member produced, and whose rate has collapsed since yesterday.
 *
 * ## Shares are of what was actually observed
 *
 * A share is one member's XP gain over a window divided by the whole roster's
 * gain over the same window. Members with fewer than two samples in the window
 * contribute nothing to either side rather than counting as zero — the
 * difference between "earned nothing" and "was not being watched" is the whole
 * point of the gone-quiet flag below, and folding the second into the first
 * would make every newly tracked member look idle.
 *
 * ## Gone quiet is a comparison, not a threshold
 *
 * "Idle" cannot be a fixed XP/h, because a strong member coasting still outpaces
 * a weak one going flat out. The flag is each member against *themselves*: a
 * day rate that has collapsed against their own week rate. That catches the
 * member who stopped playing on Tuesday and leaves the steady one alone.
 *
 * The arithmetic below is pure and exported for tests; the tracker is asked for
 * its samples through its read API rather than reaching into storage.
 */

import config from '../../core/config.js';
import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import guildMemberSkills from './guild-member-skills.js';
import { describeLoadoutAge } from './guild-loadouts.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';

/** How many stat rows of a snapshot the roster panel shows before it stops */
export const LOADOUT_PREVIEW_ROWS = 6;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const WINDOW_7D = 7 * DAY;
export const WINDOW_30D = 30 * DAY;

/** A day rate this far below the week rate reads as having stopped */
export const QUIET_RATIO = 0.25;

/** Below this the week rate is too small for its collapse to mean anything */
export const QUIET_MIN_WEEK_RATE = 1;

const ACCENT = '#c0b0ff';

/**
 * The contribution card's search box, as typed. Lives outside the panel's own
 * state because the panel has none — every other section is recomputed fresh
 * from the tracker on each draw, and a search term is the one thing among them
 * a redraw must not throw away.
 */
let rosterFilterText = '';

/** Reset the remembered search text. Exported for tests, which must not inherit a run. */
export function resetRosterFilter() {
    rosterFilterText = '';
}

/**
 * XP gained inside a window, and how much of the window the samples cover.
 *
 * Both matter: a delta over twenty minutes and a delta over six days are not
 * comparable, and a caller that only sees the delta cannot tell them apart.
 *
 * @param {Array<{t: number, xp: number}>} series - Samples, oldest first
 * @param {number} windowMs - How far back to look
 * @param {number} [now] - Clock
 * @returns {{delta: number, spanMs: number}|null} Null when fewer than two samples land in the window
 */
export function seriesDelta(series, windowMs, now = Date.now()) {
    if (!Array.isArray(series) || series.length < 2) return null;
    const cutoff = now - windowMs;
    const inWindow = series.filter((sample) => sample && sample.t >= cutoff);
    if (inWindow.length < 2) return null;

    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs <= 0) return null;

    return { delta: Math.max(0, last.xp - first.xp), spanMs };
}

/**
 * XP per hour across a window.
 * @param {Array<{t: number, xp: number}>} series - Samples, oldest first
 * @param {number} windowMs - How far back to look
 * @param {number} [now] - Clock
 * @returns {number|null} XP/hr, or null when the window holds no measurable span
 */
export function ratePerHour(series, windowMs, now = Date.now()) {
    const measured = seriesDelta(series, windowMs, now);
    if (!measured) return null;
    return (measured.delta / measured.spanMs) * HOUR;
}

/**
 * Has this member stopped?
 * @param {number|null} dayRate - Their XP/hr over the last day
 * @param {number|null} weekRate - Their XP/hr over the last week
 * @returns {boolean} True when the day rate has collapsed against their own week
 */
export function isGoneQuiet(dayRate, weekRate) {
    if (!Number.isFinite(weekRate) || weekRate < QUIET_MIN_WEEK_RATE) return false;
    // No day measurement at all is the loudest version of this signal
    const day = Number.isFinite(dayRate) ? dayRate : 0;
    return day < weekRate * QUIET_RATIO;
}

/**
 * Turn deltas into percentage shares of the roster's total.
 * @param {Array<{delta: number|null}>} entries - Anything with a delta
 * @returns {number[]} Share per entry, 0-100; all zero when nothing was earned
 */
export function contributionShares(entries) {
    const total = (entries || []).reduce((sum, entry) => sum + (Number.isFinite(entry?.delta) ? entry.delta : 0), 0);
    if (total <= 0) return (entries || []).map(() => 0);
    return (entries || []).map((entry) => ((Number.isFinite(entry?.delta) ? entry.delta : 0) / total) * 100);
}

/**
 * Where a guild's XP lands after a stretch at its current rate.
 * @param {number} currentXP - XP now
 * @param {number|null} xpPerHour - Current rate
 * @param {number} hours - How far ahead
 * @returns {number|null} Projected XP, or null without a rate
 */
export function projectGuildXP(currentXP, xpPerHour, hours) {
    if (!Number.isFinite(currentXP) || !Number.isFinite(xpPerHour) || xpPerHour <= 0) return null;
    return currentXP + xpPerHour * hours;
}

/**
 * The roster, ranked by what each member did this week.
 *
 * ## Who is on it
 *
 * The **current** roster, and that is a correction. This walked the *history*
 * map — every character ever sampled — which never forgets, so a member who left
 * the guild kept their weekly rate, did nothing all day because they were gone,
 * and sat in "Gone quiet" permanently. They had no metadata either, having been
 * dropped from the member list when they left, so the row was headed with the
 * only thing left to head it with: `#9349`.
 *
 * Both defects are one defect. The member list the tracker rebuilds on every
 * roster message *is* the statement of who is in the guild, so it decides who
 * gets a row and the history is only consulted for the people on it.
 *
 * Before any roster message has arrived the list is empty, and an empty list is
 * "not known yet" rather than "nobody is in this guild" — so the history stands
 * in, exactly as it did, until the game says otherwise.
 *
 * @param {Object} input - Everything this needs, so it can be tested without the tracker
 * @param {Object<string, Array<{t: number, xp: number}>>} input.series - characterID → samples
 * @param {Object<string, {name: string}>} input.meta - characterID → metadata, and the roster
 * @param {number} [input.now] - Clock
 * @returns {Array<Object>} One row per current member, best 7-day share first
 */
export function buildRoster({ series, meta = {}, now = Date.now() }) {
    const current = Object.keys(meta || {});
    const ids = current.length ? current : Object.keys(series || {});

    const rows = ids.map((characterID) => {
        const samples = series[characterID] || [];
        const week = seriesDelta(samples, WINDOW_7D, now);
        const month = seriesDelta(samples, WINDOW_30D, now);
        const dayRate = ratePerHour(samples, DAY, now);
        const weekRate = ratePerHour(samples, WINDOW_7D, now);

        return {
            characterID,
            // Never a `#id`. A numeric tag where a name belongs reads as a
            // member whose name is a number, and every row that ever showed one
            // was a member who should not have been on the list at all
            name: meta[characterID]?.name || null,
            samples: samples.length,
            delta: week ? week.delta : null,
            delta7d: week ? week.delta : null,
            delta30d: month ? month.delta : null,
            spanMs: week ? week.spanMs : 0,
            dayRate,
            weekRate,
            quiet: isGoneQuiet(dayRate, weekRate),
            totalXP: samples.length ? samples[samples.length - 1].xp : null,
        };
    });

    const shares7d = contributionShares(rows);
    const shares30d = contributionShares(rows.map((r) => ({ delta: r.delta30d })));
    rows.forEach((memberRow, index) => {
        memberRow.share7d = shares7d[index];
        memberRow.share30d = shares30d[index];
    });

    return rows.sort((a, b) => (b.share7d ?? 0) - (a.share7d ?? 0) || (b.totalXP ?? 0) - (a.totalXP ?? 0));
}

/**
 * What to head a member's row with when their name was never captured.
 *
 * Withheld rather than faked. The tracker learns a name from the same message
 * that says somebody is in the guild, so a member on the list with no name is a
 * message this script could not read — which is worth saying, and is not worth
 * printing an internal id for. `#9349` is not a name and nobody can act on it.
 *
 * @param {Object} member - A row from {@link buildRoster}
 * @returns {string} Something a person can read
 */
export function memberLabel(member) {
    return member?.name || 'Unnamed member';
}

/**
 * Make a member's line open their profile on click.
 *
 * The same one-keypress trick the profile cycler uses — `/profile <name>` when
 * the game core is not reachable. A name that fails validation gets no click
 * rather than a broken one.
 *
 * @param {HTMLElement} line - The row to wire
 * @param {string} name - The member's name
 */
export function wireProfileClick(line, name) {
    if (!name || !VALID_PLAYER_NAME_RE.test(name)) return;
    line.style.cursor = 'pointer';
    line.title = `${line.title ? `${line.title}\n` : ''}Click to open ${name}'s profile.`;
    line.addEventListener('click', () => {
        if (!openPlayerProfile(name, { logPrefix: 'GuildRoster' })) {
            line.title = 'Could not open the profile — open the chat panel and try again.';
        }
    });
}

/** The contribution table's CSV columns: raw numbers, so a spreadsheet can sort and chart them */
export const ROSTER_CSV_COLUMNS = [
    { key: 'name', label: 'Member' },
    { key: 'samples', label: 'XP samples recorded' },
    { key: 'delta7d', label: 'XP gained (7d)' },
    { key: 'share7d', label: 'Share of guild XP (7d %)' },
    { key: 'delta30d', label: 'XP gained (30d)' },
    { key: 'share30d', label: 'Share of guild XP (30d %)' },
    { key: 'dayRate', label: 'XP/h (day)' },
    { key: 'weekRate', label: 'XP/h (week)' },
    { key: 'totalXP', label: 'Total guild XP' },
    { key: 'quiet', label: 'Gone quiet' },
];

/**
 * The contribution rows as CSV rows.
 *
 * A blank cell where the panel shows a dash: "not measured" and "measured
 * zero" must stay apart in a spreadsheet too, and `csvCell` already turns a
 * non-finite number into an empty cell — so nulls are left as nulls rather
 * than coerced to 0.
 *
 * @param {Array<Object>} rows - From {@link buildRoster}
 * @returns {Array<Object>} Rows for `toCsv`
 */
export function rosterCsvRows(rows) {
    return (rows || []).map((row) => ({
        name: memberLabel(row),
        samples: row.samples,
        delta7d: Number.isFinite(row.delta7d) ? Math.round(row.delta7d) : null,
        share7d: Number.isFinite(row.share7d) ? Math.round(row.share7d * 10) / 10 : null,
        delta30d: Number.isFinite(row.delta30d) ? Math.round(row.delta30d) : null,
        share30d: Number.isFinite(row.share30d) ? Math.round(row.share30d * 10) / 10 : null,
        dayRate: Number.isFinite(row.dayRate) ? Math.round(row.dayRate) : null,
        weekRate: Number.isFinite(row.weekRate) ? Math.round(row.weekRate) : null,
        totalXP: Number.isFinite(row.totalXP) ? Math.round(row.totalXP) : null,
        quiet: Boolean(row.quiet),
    }));
}

/**
 * The roster as the panel and the tile both need it, read from the tracker.
 * @returns {{guildName: string|null, rows: Array<Object>, level: Object|null, guildRate: number|null}|null}
 */
export function rosterSnapshot() {
    const guildName = guildXPTracker.getOwnGuildName();
    const series = guildXPTracker.getAllMemberSeries();
    const meta = {};
    for (const member of guildXPTracker.getMemberList()) meta[member.characterID] = member;

    const guildSeries = guildName ? guildXPTracker.getGuildSeries(guildName) : [];

    return {
        guildName,
        rows: buildRoster({ series, meta }),
        level: guildName ? guildXPTracker.getGuildLevelProgress(guildName) : null,
        guildRate: ratePerHour(guildSeries, WINDOW_7D),
        guildDayRate: ratePerHour(guildSeries, DAY),
    };
}

/**
 * A percentage, or a dash.
 * @param {number|null} value - 0-100
 * @returns {string}
 */
function percent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

/**
 * XP, or a dash.
 * @param {number|null} value - XP
 * @returns {string}
 */
function xp(value) {
    return Number.isFinite(value) ? formatKMB(Math.round(value)) : '—';
}

/**
 * The profile cycler: one click, one guildmate's skills.
 *
 * A skilling trial's forecast needs the party's skill levels, and the only place
 * those appear is a member's own profile — `profile_shared` is sent when a
 * profile is opened and at no other time. So they have to be collected, and the
 * collecting is a person clicking a button, once per member, which is both what
 * was asked for and the only version worth building: nothing here opens profiles
 * on its own.
 *
 * @param {HTMLElement} body - The panel body
 * @param {Object} [capture] - The skills store, injectable for tests
 * @returns {HTMLElement} The card
 */
export function drawProfileCycler(body, capture = guildMemberSkills) {
    const state = capture.progress?.() || { logged: 0, total: 0, next: null, stale: 0 };
    const card = panelCard(body, `Member skills (logged ${state.logged}/${state.total})`, ACCENT);

    if (!state.total) {
        card.appendChild(panelNote('No roster yet — open the guild page once.'));
        return card;
    }

    const status = panelNote('');
    status.style.display = 'none';

    // The battle-info collection is its own tool, not a fallback of the
    // profile walk: a unit's popup is the only source of a combat stat sheet,
    // a profile carries skills but no sheet, and letting one button silently
    // degrade into the other collected the wrong thing while looking done.
    // Only drawn while a fight on screen actually offers a clickable unit.
    const unit = capture.nextBattleUnit?.();
    if (unit?.el) {
        const battleButton = document.createElement('button');
        battleButton.className = 'mwi-battleinfo-cycler';
        battleButton.textContent = `Open ${unit.name}\u2019s battle info`;
        battleButton.style.cssText =
            'width:100%; margin:4px 0 0; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;' +
            `background:transparent; border:1px solid ${ACCENT}; color:${ACCENT};`;
        battleButton.title =
            'Opens one fighting member\u2019s Battle Info popup per click, so the game sends their combat ' +
            'stat sheet. Only on offer while a fight is on screen \u2014 a profile cannot carry a combat sheet.';
        battleButton.addEventListener('click', () => {
            const result = capture.openNextUnit?.();
            status.style.display = '';
            status.style.color = ROW_COLORS.dim;
            if (result?.how === 'unit') {
                status.textContent = `Waiting for ${result.opened}\u2019s battle info\u2026`;
                battleButton.textContent = `Asked for ${result.opened}\u2026`;
            } else {
                status.textContent = 'No fighting member is due right now.';
            }
        });
        card.appendChild(battleButton);
    } else if (capture.anyBattleUnits?.()) {
        // A fight is on screen but nobody is due — an absent button reads as
        // broken, so the freshness that hid it is said out loud instead
        card.appendChild(
            panelNote(
                'Everyone in the fight has a fresh combat sheet — the battle-info button returns when one goes stale.'
            )
        );
    }

    const button = document.createElement('button');
    button.className = 'mwi-profile-cycler';
    button.textContent = state.next ? `Open ${state.next.name}\u2019s profile` : 'Every member logged';
    button.disabled = !state.next;
    button.style.cssText =
        'width:100%; margin:4px 0; padding:4px 8px; border-radius:4px; font-size:11px;' +
        `cursor:${state.next ? 'pointer' : 'default'}; background:transparent;` +
        `border:1px solid ${state.next ? ACCENT : 'rgba(255,255,255,0.2)'};` +
        `color:${state.next ? ACCENT : ROW_COLORS.dim};`;
    button.title =
        'Opens one member\u2019s profile per click, so the game sends their skill levels and this can keep ' +
        'them. Nothing is opened automatically.\n' +
        'A profile carries every skill level, which is what the skilling forecast needs; combat stat sheets ' +
        'come only from the battle-info button during a fight.';

    button.addEventListener('click', () => {
        const result = capture.openNextProfile?.();
        status.style.display = '';

        if (result?.how === 'no-chat') {
            // The only route to a skilling participant's profile is the chat
            // command, and a hidden chat swallows it silently — which is how a
            // roster came to read "every member logged" with one missing
            status.textContent = 'Open the chat panel first — that is how a profile is asked for.';
            status.style.color = ROW_COLORS.bad;
            button.textContent = `Open ${result.opened}’s profile`;
            return;
        }

        status.style.color = ROW_COLORS.dim;
        if (result?.how === 'chat') {
            status.textContent = `Press Enter in chat to open ${result.opened}.`;
            button.textContent = `Asked for ${result.opened}…`;
        } else if (result?.opened) {
            status.textContent = `Waiting for ${result.opened}’s profile…`;
            button.textContent = `Asked for ${result.opened}…`;
        }
    });

    card.appendChild(button);

    // Redo: a capture goes stale on its own after a week, which is too slow for
    // a player who has just watched half the guild level up. It only changes who
    // is considered due — it never asks for a profile itself
    if (state.logged > 0) {
        const redo = document.createElement('button');
        redo.className = 'mwi-profile-redo';
        redo.textContent = `⟲ Redo all ${state.logged}`;
        redo.style.cssText =
            'width:100%; margin:0 0 4px; padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer;' +
            `background:transparent; border:1px solid rgba(255,255,255,0.2); color:${ROW_COLORS.dim};`;
        redo.title =
            'Marks every capture as due again, so the button above walks the roster once more. Nothing is ' +
            'thrown away — the levels already stored stand until a fresh profile replaces them.';
        redo.addEventListener('click', () => {
            capture.redoAll?.();
            redo.textContent = 'Every member due again';
            button.textContent = 'Open the next profile';
        });
        card.appendChild(redo);
    }

    card.appendChild(status);
    if (state.pending) {
        card.appendChild(panelNote(`Waiting for ${state.pending.name}’s profile to open.`));
    }
    if (state.stale) {
        card.appendChild(panelNote(`${state.stale} capture${state.stale === 1 ? '' : 's'} older than a week.`));
    }
    return card;
}

/**
 * Only the snapshots naming somebody on the roster, when a roster is known.
 *
 * The storage is guild-keyed now, but a record written before that shipped —
 * or adopted from the character-only key — can still carry another guild's
 * people: reported live, "Seen loadouts" listing Cream and ICMeow eighteen
 * hours after the character left their guild. The roster is the test of who
 * belongs; with no roster to test against, everything is kept rather than
 * everything hidden.
 *
 * @param {Array<Object>} seen - Snapshots
 * @param {string[]} memberNames - The current guild's members
 * @returns {{kept: Array<Object>, hidden: number}} What the panel may show
 */
export function filterSeenToRoster(seen, memberNames) {
    const roster = new Set((memberNames || []).map((name) => String(name || '').toLowerCase()).filter(Boolean));
    if (!roster.size) return { kept: seen || [], hidden: 0 };

    const kept = (seen || []).filter((player) => roster.has(String(player?.name || '').toLowerCase()));
    return { kept, hidden: (seen || []).length - kept.length };
}

/**
 * The stat sheets that have been seen, with the date on every one of them.
 *
 * The only place a guild member's build is visible is the unit popup, and it is
 * gone when the popup closes — so what this shows is a history of glances, not a
 * roster. Every line therefore leads with when it was taken: a build seen last
 * month is not what that member is wearing now, and the numbers being correct is
 * exactly what makes an undated sheet misleading.
 *
 * @param {HTMLElement} body - The panel body
 * @param {Array<Object>} [allSeen] - Snapshots, newest first; the capture's own by default
 * @param {number} [now] - Clock
 * @param {string[]} [memberNames] - The current roster, for the guild filter
 */
export function drawSeenLoadouts(
    body,
    allSeen = guildLoadoutCapture.seen(),
    now = Date.now(),
    memberNames = guildXPTracker.getMemberList().map((member) => member?.name || '')
) {
    const { kept: seen, hidden } = filterSeenToRoster(allSeen, memberNames);
    const card = panelCard(body, `Seen loadouts (${seen.length})`, ACCENT);

    if (!seen.length) {
        card.appendChild(panelNote('No stat sheets seen yet.'));
        card.appendChild(
            panelNote('Click a member’s icon in the guild In Progress view, or fight a trial beside them.')
        );
        if (hidden) card.appendChild(panelNote(`${hidden} from outside this guild’s roster, not shown.`));
        return;
    }

    for (const player of seen) {
        const headline = player.rows
            .slice(0, LOADOUT_PREVIEW_ROWS)
            .map((entry) => `${entry.label} ${entry.value}`)
            .join(' · ');

        const abilities = player.abilities?.length
            ? `\nAbilities: ${player.abilities
                  .map((ability) => `${ability.label}${ability.level ? ` ${ability.level}` : ''}`)
                  .join(', ')}`
            : '\nAbilities: not carried by this reading.';

        const line = panelLine(
            // A captured combat level is a weighted average and arrives as
            // floating point — "Lv.151.60000000000002" reached the screen —
            // so one decimal is as much as it means
            `${player.name}${player.level ? ` Lv.${Math.round(player.level * 10) / 10}` : ''}`,
            describeLoadoutAge(player.at, now),
            ROW_COLORS.gold,
            `${headline || 'No stat rows in this reading.'}${abilities}\n` +
                `A snapshot from when it was read (${player.source}) — not a live figure.`
        );
        wireProfileClick(line, player.name);
        card.appendChild(line);
    }

    if (hidden) {
        card.appendChild(
            panelNote(
                `${hidden} sighting${hidden === 1 ? '' : 's'} from outside this guild’s roster, not shown — ` +
                    'they stay stored under the guild they were seen in.'
            )
        );
    }
}

/**
 * Only the members whose name contains the typed text.
 *
 * A search of who is already on the list, not a fresh query: it never touches
 * who is "contributing" (two samples in the window and a positive delta), only
 * which of those rows are shown. Blank or whitespace-only text is "not
 * searching", so an empty box shows everyone.
 *
 * @param {Array<Object>} members - From {@link buildRoster}
 * @param {string} query - As typed into the search box
 * @returns {Array<Object>} The members whose name matches
 */
export function filterRosterRows(members, query) {
    const wanted = String(query || '')
        .trim()
        .toLowerCase();
    if (!wanted) return members || [];
    return (members || []).filter((member) =>
        String(member?.name || '')
            .toLowerCase()
            .includes(wanted)
    );
}

/**
 * The "Export CSV" button for the contribution card.
 *
 * The card's own numbers, raw: a guild leader comparing this week against last
 * month's export wants `0.0032`, not `0.3%`, or the two files cannot be
 * diffed against each other.
 *
 * @param {Array<Object>} rows - From {@link buildRoster}
 * @returns {HTMLElement} The button
 */
function exportRosterCsvButton(rows) {
    const button = document.createElement('button');
    button.textContent = 'Export CSV';
    button.title = 'The contribution table as it stands, with raw numbers a spreadsheet can sort.';
    button.style.cssText =
        'align-self:flex-start; margin:2px 0 4px; background:rgba(255,255,255,0.08);' +
        'border:1px solid rgba(255,255,255,0.18); color:#e8ecf5; border-radius:5px; padding:3px 8px;' +
        'cursor:pointer; font-size:11px;';
    button.addEventListener('click', () => {
        const csv = toCsv(rosterCsvRows(rows), ROSTER_CSV_COLUMNS);
        downloadCsv(csvFilename('guild-roster-contribution'), csv);
    });
    return button;
}

export const guildRosterPanel = createPanel({
    id: 'guildRoster',
    title: 'Guild Roster',
    size: { width: 430, height: 470 },
    accent: ACCENT,
    draw: (body) => {
        const snapshot = rosterSnapshot();
        if (!snapshot?.guildName) {
            body.appendChild(panelNote('No guild data yet.'));
            body.appendChild(panelNote('Open the Guild tab once so the tracker has something to record.'));
            return;
        }

        const { guildName, rows, level, guildRate, guildDayRate } = snapshot;

        const guild = panelCard(body, guildName, ACCENT);
        if (level) {
            guild.appendChild(panelLine('Level', String(level.level), ROW_COLORS.gold));
            guild.appendChild(panelLine('Guild XP', xp(level.currentXP), ROW_COLORS.dim));
            if (level.xpToNext !== null) {
                guild.appendChild(panelLine('To next level', xp(level.xpToNext), ROW_COLORS.dim));
            }
        }
        guild.appendChild(panelLine('XP/h (week)', xp(guildRate), ROW_COLORS.dim));
        guild.appendChild(panelLine('XP/h (day)', xp(guildDayRate), ROW_COLORS.dim));

        const rate = Number.isFinite(guildRate) && guildRate > 0 ? guildRate : guildDayRate;
        const in7d = projectGuildXP(level?.currentXP ?? NaN, rate, 7 * 24);
        const in30d = projectGuildXP(level?.currentXP ?? NaN, rate, 30 * 24);
        if (in7d !== null) {
            guild.appendChild(
                panelLine(
                    'Projected in 7d',
                    xp(in7d),
                    ROW_COLORS.good,
                    'Current rate held flat — a projection, not a promise.'
                )
            );
            guild.appendChild(panelLine('Projected in 30d', xp(in30d), ROW_COLORS.good));
        }

        const quiet = rows.filter((member) => member.quiet);
        if (quiet.length) {
            const card = panelCard(body, `Gone quiet (${quiet.length})`, ROW_COLORS.bad);
            for (const member of quiet) {
                const line = panelLine(
                    memberLabel(member),
                    `${xp(member.dayRate)}/h today vs ${xp(member.weekRate)}/h this week`,
                    ROW_COLORS.bad
                );
                wireProfileClick(line, member.name);
                card.appendChild(line);
            }
        }

        drawProfileCycler(body);
        drawSeenLoadouts(body);

        const contributing = rows.filter((member) => Number.isFinite(member.delta7d) && member.delta7d > 0);
        const shown = filterRosterRows(contributing, rosterFilterText);
        const card = panelCard(body, `Contribution (${contributing.length} of ${rows.length} measured)`, ACCENT);
        if (!contributing.length) {
            card.appendChild(panelNote('No member has two samples in the last week yet.'));
        } else {
            const search = document.createElement('input');
            search.type = 'text';
            search.id = 'mwi-roster-filter-input';
            search.placeholder = 'Filter by name…';
            search.value = rosterFilterText;
            search.title = 'Narrows this list to members whose name contains this.';
            search.style.cssText =
                'width: 100%; box-sizing: border-box; margin: 0 0 4px; background: rgba(255,255,255,0.08); ' +
                'border: 1px solid rgba(255,255,255,0.18); color: #e8ecf5; border-radius: 5px; padding: 3px 6px; ' +
                'font-size: 12px;';
            search.addEventListener('input', () => {
                rosterFilterText = search.value;
                const cursor = search.selectionStart;
                guildRosterPanel.render();
                // A redraw rebuilds this very box; put the caret back where it
                // was, or the next keystroke lands on a box that just lost focus
                const revived = document.getElementById('mwi-roster-filter-input');
                if (revived) {
                    revived.focus();
                    revived.setSelectionRange(cursor, cursor);
                }
            });
            card.appendChild(search);

            card.appendChild(exportRosterCsvButton(shown));
            if (!shown.length) card.appendChild(panelNote(`No match for "${rosterFilterText}".`));
        }
        for (const member of shown) {
            const line = panelLine(
                `${memberLabel(member)}${member.quiet ? ' ·' : ''}`,
                `${percent(member.share7d)} 7d · ${percent(member.share30d)} 30d · ${xp(member.delta7d)} XP`,
                member.quiet ? ROW_COLORS.bad : ROW_COLORS.gold,
                `${member.samples} samples recorded.\nShares are of the XP actually observed, not of career totals.`
            );
            wireProfileClick(line, member.name);
            card.appendChild(line);
        }
    },
});

/**
 * Register the overlay tile. Called from `initialize` so a switched-off feature
 * leaves no tile and no command palette entry behind.
 */
export function registerGuildRosterRow() {
    registerRow({
        key: 'guildRoster',
        name: 'Guild Roster',
        empty: 'No guild data',
        defaultVisible: false,
        defaultSize: { width: 230, height: 30 },
        render: (container) => {
            const snapshot = rosterSnapshot();
            const top = snapshot?.rows?.find((member) => Number.isFinite(member.share7d) && member.share7d > 0);
            if (!top) return blank(container);

            const quiet = snapshot.rows.filter((member) => member.quiet).length;
            // `memberLabel`, not the raw name: a row whose name was never
            // captured carries null, and the tile is the one place that read it
            // straight through — `null produced 58.1%` on a tile drawn before
            // the first roster message, where the panel beside it said
            // "Unnamed member"
            const label = memberLabel(top);
            row(container, [
                { text: label, color: ROW_COLORS.dim, ellipsis: true, title: label },
                { text: percent(top.share7d), color: ROW_COLORS.gold },
                { text: quiet ? `${quiet} quiet` : 'all active', color: quiet ? ROW_COLORS.bad : ROW_COLORS.good },
            ]);
            container.title =
                `${label} produced ${percent(top.share7d)} of the guild XP observed this week.` +
                (quiet ? `\n${quiet} member(s) have gone quiet against their own weekly rate.` : '') +
                '\nDouble-click for the whole roster.';
        },
        onOpen: () => guildRosterPanel.toggle(),
    });
}

/** Unsubscribe from the loadout capture's events; set in `initialize` */
let offCaptured = null;

/**
 * Whether this feature is currently one of the capture's counted owners.
 *
 * `guildLoadoutCapture` is reference counted (`owners`) precisely because two
 * features start it, and a count only works if every `initialize()` is paired
 * with exactly one `cleanup()`. This one was not: the roster incremented on
 * every character switch's re-init and never decremented, so `owners` could
 * not reach zero and the capture was never torn down. It then kept
 * `characterId`, `guildName` and `record` — all resolved once, in
 * `initialize()` — pointed at the *departing* character for the rest of the
 * tab's life, and `setGuildName()` filed the arriving character's guild roster
 * under the departing character's storage key.
 *
 * Worse, which of the two shapes a user got depended on their settings. With
 * Guild Trials on and the roster off, `owners` went 1 → 0 and the capture was
 * correctly rebuilt per character; with the roster on, it never was. The safe
 * build was the accident.
 */
let capturing = false;

export default {
    name: 'Guild Roster',
    initialize: async () => {
        if (!config.getSetting('guildRoster', true)) return;
        registerGuildRosterRow();
        // Idempotent, and the trials feature starts it too: either being on is
        // reason enough to be writing down what goes past
        //
        // The flag is set from the *synchronous* half of that call — `owners`
        // is incremented on its first line, before its own storage read — so a
        // character switch tearing this feature down while that read is in
        // flight still finds an owner to give back. Setting it after the await
        // is how the count would go wrong again, just more rarely.
        const started = guildLoadoutCapture.initialize();
        capturing = true;
        await started;
        // A landed sheet redraws the open panel at once — the Battle Info
        // cycler was waiting out the 3s refresh tick before offering the next
        // fighter. The timer stays as the fallback; `render` is a no-op while
        // the panel is closed, and nothing here opens the next popup — that is
        // still one player per explicit click.
        offCaptured = guildLoadoutCapture.onCaptured?.(() => guildRosterPanel.render()) ?? null;
    },
    cleanup: () => {
        offCaptured?.();
        offCaptured = null;
        // Give the owner back, once. `cleanup()` on the capture decrements and
        // returns early while anything else still holds it, so this stops the
        // capture only when Guild Trials is off — the whole point of counting.
        if (capturing) {
            capturing = false;
            guildLoadoutCapture.cleanup();
        }
        guildRosterPanel.hide({ remember: false });
        resetRosterFilter();
    },
};
