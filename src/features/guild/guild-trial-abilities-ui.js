/**
 * The Trial Abilities panel: capture progress and aura coverage, live.
 *
 * The session logic lives in `guild-trial-abilities.js`; this file only draws
 * it. While the roster is still being clicked through, every claim on the
 * panel is hedged — an uncovered aura reads as its own denominator ("none
 * among 31 captured · 19 unseen"), never `MISSING`, because a kit nobody has
 * looked at is not an empty kit. Only when every current participant has an
 * authoritative capture does the panel say what is missing.
 *
 * The controls never skip anyone: a capture that times out leaves its player
 * outstanding and retryable, and nothing here auto-completes the roster.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { clickThroughReact } from '../../utils/react-click.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import guildMemberSkills, { findBattleUnits, orderUnitsToAsk, REQUEST_TIMEOUT_MS } from './guild-member-skills.js';
import guildTrialAbilities, { SESSION_MAX_AGE_MS } from './guild-trial-abilities.js';
import guildTrialPlan, { planStatusLine, planDiffSummary, describePlanChange } from './guild-trial-plan.js';
import { formatEta } from '../../utils/progress-eta.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { isAuraAbility } from '../../utils/party-lint.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { classTagIcon } from '../../utils/class-weapon.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';
import storage from '../../core/storage.js';

const ACCENT = '#a8d6a0';

/**
 * Make an element open a player's profile on click.
 * @param {HTMLElement} el - What to wire
 * @param {string} name - The player's name; an invalid one gets no click
 */
function wireProfileClick(el, name) {
    if (!name || !VALID_PLAYER_NAME_RE.test(name)) return;
    el.style.cursor = 'pointer';
    el.title = `${el.title ? `${el.title}\n` : ''}Click to open ${name}'s profile.`;
    el.addEventListener('click', (event) => {
        event.stopPropagation();
        openPlayerProfile(name, { logPrefix: 'TrialAbilities' });
    });
}

/** Which cards are folded, by key; loaded once in `initialize` */
const collapsedCards = new Set();

/** Where the folded-card set is written down */
const COLLAPSED_CARDS_KEY = 'guildTrialAbilities_collapsedCards';

/**
 * A card whose heading folds it.
 *
 * The heading always draws (with a ▾/▸ state marker) and clicking it toggles
 * the fold, remembered across reloads; the caller checks `collapsed` and skips
 * its rows when true, so a folded card is its one-line heading.
 *
 * @param {HTMLElement} body - Panel body
 * @param {string} title - Card title
 * @param {string} key - Storage key for this card's fold state
 * @returns {{card: HTMLElement, collapsed: boolean}}
 */
function collapsibleCard(body, title, key) {
    const collapsed = collapsedCards.has(key);
    const card = panelCard(body, '', ACCENT);
    const heading = document.createElement('div');
    heading.textContent = `${collapsed ? '▸' : '▾'} ${title}`;
    Object.assign(heading.style, {
        color: ACCENT,
        fontWeight: 'bold',
        marginBottom: '3px',
        cursor: 'pointer',
        userSelect: 'none',
    });
    heading.title = collapsed ? 'Expand' : 'Collapse';
    heading.addEventListener('click', () => {
        if (collapsedCards.has(key)) collapsedCards.delete(key);
        else collapsedCards.add(key);
        storage.setJSON(COLLAPSED_CARDS_KEY, [...collapsedCards], 'settings').catch(() => {});
        guildTrialAbilitiesPanel.render();
    });
    card.appendChild(heading);
    return { card, collapsed };
}

/** Exact section title — the label the export's readers key their eyes on too */
export const AURA_SECTION_TITLE = 'Equipped aura coverage';

/**
 * A tier as the panel writes one.
 * @param {number|string|null} tier - e.g. `4` or `'T4'`
 * @returns {string|null} e.g. `T4`
 */
export function tierText(tier) {
    if (tier === null || tier === undefined || tier === '') return null;
    const numeric = Number(tier);
    if (Number.isFinite(numeric)) return `T${numeric}`;
    return String(tier);
}

/**
 * The tiers a session's captures span, as one label.
 * @param {Array<number|string>} capturedTiers - From the session
 * @param {number|string|null} captureTier - Tier at first capture
 * @returns {string|null} `T4`, `T4-T5`, or null when no tier is known
 */
export function tierRangeLabel(capturedTiers, captureTier = null) {
    const tiers = [...new Set((capturedTiers || []).map((tier) => Number(tier)).filter(Number.isFinite))].sort(
        (a, b) => a - b
    );
    if (!tiers.length) return tierText(captureTier);
    if (tiers.length === 1) return `T${tiers[0]}`;
    return `T${tiers[0]}-T${tiers[tiers.length - 1]}`;
}

/**
 * The panel's headline while collecting and after.
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {string} e.g. `Trial abilities — 42/50 captured`
 */
export function headerLine(state) {
    return `Trial abilities — ${state.capturedCount}/${state.rosterCount} captured`;
}

/**
 * The completion line, once there is one.
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {string|null} e.g. `50/50 captured on T4` or `50/50 captured across T4-T5`
 */
export function completionLine(state) {
    if (!state.complete) return null;
    const range = tierRangeLabel(state.capturedTiers, state.captureTier);
    const mixed = new Set((state.capturedTiers || []).map(String)).size > 1;
    const where = range ? (mixed ? ` across ${range}` : ` on ${range}`) : '';
    return `${state.capturedCount}/${state.rosterCount} captured${where}`;
}

/**
 * The header's last-trial caption, once the session is older than a trial.
 *
 * A trial runs an hour, so a session past {@link SESSION_MAX_AGE_MS} belongs
 * to a trial that has ended — kept on purpose (the completed roster and its
 * aura coverage are exactly what is asked for after the hour) and named as
 * such, because a reader must never mistake it for the next trial's capture.
 * The next trial's first capture starts a fresh session by itself.
 *
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {number} [now] - Clock
 * @returns {string|null} The caption, or null while the session is current
 */
export function staleSessionNote(state, now = Date.now()) {
    if (!Number.isFinite(state?.startedAt)) return null;
    // Age since the trial last touched the session, not since it began: a
    // skilling-hour-into-combat-hour session is two hours old and current
    const last = Number.isFinite(state?.lastActivityAt)
        ? Math.max(state.lastActivityAt, state.startedAt)
        : state.startedAt;
    const age = now - last;
    if (age <= SESSION_MAX_AGE_MS) return null;
    return (
        `From the last trial — captured ${formatEta(age)} ago, and the trial has ended. ` +
        'A new trial’s first capture starts a fresh session; Recapture starts one now.'
    );
}

/**
 * Player rows in the order the panel shows them: outstanding first while
 * collecting (they are what the next click is for), alphabetical once done.
 *
 * @param {Array<Object>} participants - From `guildTrialAbilities.state()`
 * @param {boolean} complete - Whether every current participant is captured
 * @returns {Array<Object>} Sorted copy
 */
export function sortParticipants(participants, complete) {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const rows = [...(participants || [])];
    if (complete) return rows.sort(byName);
    return rows.sort((a, b) => Number(a.captured) - Number(b.captured) || byName(a, b));
}

/**
 * When each outstanding player's unit was last clicked, lowercased name → clock.
 *
 * The trial's own request ledger, deliberately separate from the roster
 * feature's. It only debounces: a click younger than
 * {@link REQUEST_TIMEOUT_MS} is a request still in flight, and once the window
 * lapses the player is simply offered again — a fetch that never answered is
 * retried, never skipped.
 */
const trialUnitRequests = {};

/** Forget every in-flight stamp — a recapture owes nobody a wait */
export function resetTrialUnitRequests() {
    for (const key of Object.keys(trialUnitRequests)) delete trialUnitRequests[key];
}

/**
 * Click the next outstanding trial participant's unit box.
 *
 * Gated by the *trial session's* outstanding list and nothing else. The roster
 * cycler in `guild-member-skills.js` skips any fighter whose combat sheet is
 * fresh in the shared loadout store — right for the roster panel, and exactly
 * what starved this panel: a sheet from `new_battle` or a stat-only popup
 * counts as fresh there while the trial session (which only accepts the
 * trial's own Battle Info) still needs the player. Here a player the session
 * has not captured is always clickable, the local player's own full card
 * included, however fresh their sheet looks to the roster feature.
 *
 * When the trial finder sees no unit boxes at all, the roster panel's own
 * opener ({@link guildMemberSkills.openNextUnit}) is invoked instead — the
 * exact routine behind the roster's "Open …'s battle info" button, which was
 * observed working at a live trial where this finder came up empty. Reused,
 * not reimplemented: it carries its own request window, so the fallback can
 * no more hammer a player than the button can. A fallback click is stamped
 * into the trial's own ledger too, so the moment the finder does see units
 * the same player is not immediately re-asked inside the window.
 *
 * @param {number} [now] - Clock
 * @returns {{opened: string|null, how: 'unit'|'awaiting'|'no-unit'}} What happened
 */
export function openNextTrialUnit(now = Date.now()) {
    const state = guildTrialAbilities.state();
    const units = findBattleUnits(state.outstanding);
    const localName = dataManager.getCurrentCharacterName?.() || dataManager.characterData?.characterInfo?.name;
    for (const unit of orderUnitsToAsk(units, trialUnitRequests, localName)) {
        const key = unit.name.toLowerCase();
        if (now - (Number(trialUnitRequests[key]) || 0) < REQUEST_TIMEOUT_MS) continue;
        trialUnitRequests[key] = now;
        clickThroughReact(unit.el, { reactFirst: true });
        return { opened: unit.name, how: 'unit' };
    }
    if (units.length) {
        // Every outstanding fighter on screen was asked moments ago — the
        // answer is a wait or (after the window) a retry, never a skip
        return { opened: null, how: 'awaiting' };
    }

    // No trial units found — fall back to the roster cycler's opener
    const fallback = guildMemberSkills.openNextUnit?.(now);
    if (fallback?.opened) {
        trialUnitRequests[String(fallback.opened).toLowerCase()] = now;
        return { opened: fallback.opened, how: 'unit' };
    }
    return { opened: null, how: 'no-unit' };
}

/**
 * Click one outstanding player's unit again, ignoring the request window.
 *
 * The "Retry current player" gesture: a capture that timed out or came back
 * without abilities is asked for again on demand.
 *
 * @param {string|null} [name] - Who to retry; defaults to the first outstanding unit
 * @param {number} [now] - Clock
 * @returns {{opened: string|null, how: 'unit'|'no-unit'}} What happened
 */
export function retryTrialUnit(name = null, now = Date.now()) {
    const state = guildTrialAbilities.state();
    const units = findBattleUnits(state.outstanding);
    const wanted = String(name || '')
        .trim()
        .toLowerCase();
    const unit = (wanted && units.find((entry) => entry.name.toLowerCase() === wanted)) || units[0] || null;
    if (!unit) return { opened: null, how: 'no-unit' };
    trialUnitRequests[unit.name.toLowerCase()] = now;
    clickThroughReact(unit.el, { reactFirst: true });
    return { opened: unit.name, how: 'unit' };
}

/**
 * Whether a capture request for this player is still in flight.
 *
 * The same window {@link openNextTrialUnit} debounces on, asked as a question
 * so the chips can draw it: a player asked less than
 * {@link REQUEST_TIMEOUT_MS} ago is awaiting an answer, and asking again
 * inside that window would only queue a second popup for the same sheet.
 *
 * @param {string} name - Player name
 * @param {number} [now] - Clock
 * @returns {boolean} True while the request window stands
 */
export function isAwaitingCapture(name, now = Date.now()) {
    const key = String(name || '')
        .trim()
        .toLowerCase();
    if (!key) return false;
    return now - (Number(trialUnitRequests[key]) || 0) < REQUEST_TIMEOUT_MS;
}

/**
 * Click one *named* outstanding participant's unit box — the chip's gesture.
 *
 * {@link openNextTrialUnit} aimed: the same session-gated outstanding list,
 * the same finder, the same ledger and the same window. One press is one
 * request and nothing here loops or schedules — the only difference is that
 * the player is chosen by the reader rather than by the ordering.
 *
 * Unlike the cycler there is no fallback to the roster opener when the finder
 * sees nothing: that opener picks its *own* next player, which is precisely
 * what a targeted request must not do. Better to answer `no-unit` than to
 * open somebody else's sheet under a chip bearing this name.
 *
 * Unlike {@link retryTrialUnit} the window is honoured, not ignored: a chip is
 * pressed in a rhythm, and the retry button is still there for the deliberate
 * re-ask.
 *
 * @param {string} name - Who to ask for
 * @param {number} [now] - Clock
 * @returns {{opened: string|null, how: 'unit'|'awaiting'|'no-unit'}} What happened
 */
export function openTrialUnitFor(name, now = Date.now()) {
    const wanted = String(name || '')
        .trim()
        .toLowerCase();
    if (!wanted) return { opened: null, how: 'no-unit' };
    const state = guildTrialAbilities.state();
    const row = (state.outstanding || []).find((entry) => String(entry?.name || '').toLowerCase() === wanted);
    if (!row) return { opened: null, how: 'no-unit' };
    if (isAwaitingCapture(wanted, now)) return { opened: null, how: 'awaiting' };
    const unit = findBattleUnits([row]).find((entry) => entry.name.toLowerCase() === wanted);
    if (!unit) return { opened: null, how: 'no-unit' };
    trialUnitRequests[wanted] = now;
    clickThroughReact(unit.el, { reactFirst: true });
    return { opened: unit.name, how: 'unit' };
}

/**
 * The controls, replaceable by the orchestrator.
 *
 * Defaults use the trial's own cycler above: one click opens one outstanding
 * participant's Battle Info, which is what makes the game send the sheet.
 * "Retry" is the same gesture aimed at a named player, window ignored.
 * `captureFor` is the chip's: the cycler aimed, window respected.
 */
const DEFAULT_CONTROLS = {
    openNext: () => openNextTrialUnit(),
    retryCurrent: (name) => retryTrialUnit(name),
    captureFor: (name) => openTrialUnitFor(name),
};

const controls = { ...DEFAULT_CONTROLS };

/** Put the built-in actions back — for tests, and for a panel left without an orchestrator */
export function resetControls() {
    Object.assign(controls, DEFAULT_CONTROLS);
}

/**
 * Let the orchestrator wire its own control actions.
 * @param {{openNext?: Function, retryCurrent?: Function, captureFor?: Function}} overrides - Replacements
 */
export function setControls(overrides = {}) {
    if (typeof overrides.openNext === 'function') controls.openNext = overrides.openNext;
    if (typeof overrides.retryCurrent === 'function') controls.retryCurrent = overrides.retryCurrent;
    if (typeof overrides.captureFor === 'function') controls.captureFor = overrides.captureFor;
}

/**
 * An ability's readable name.
 * @param {string} hrid - Ability hrid
 * @param {Object} abilityDetailMap - Game data
 * @returns {string} The name, or the hrid tail
 */
function abilityName(hrid, abilityDetailMap) {
    return abilityDetailMap?.[hrid]?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * How many chips draw before the rest fold behind a "+N more".
 *
 * A trial runs up to about fifty participants. Fifty compact chips is roughly
 * five rows, which is a header that has eaten the panel, so the row shows the
 * front of the queue — the ones the next presses are for — and says how many
 * it is not showing. Pressing "+N more" opens the whole roster and the choice
 * survives the redraws (it is a reading choice, not session state).
 */
export const CHIP_LIMIT = 24;

/** Whether the chip row is showing everyone */
let chipsExpanded = false;

/**
 * Where keyboard focus belongs after the next draw: `{name, index}`.
 *
 * By name first, because the block is rebuilt from scratch on every capture
 * and element identity does not survive that. The index is the fallback for
 * the case the name is gone — the player was captured — so focus lands where
 * that chip used to be rather than at the start of the row.
 */
let pendingChipFocus = null;

/** Forget the chip row's fold and focus intent — for tests and a fresh panel */
export function resetChipUi() {
    chipsExpanded = false;
    pendingChipFocus = null;
}

/**
 * The chip to focus after acting on the one at `index`.
 *
 * The next one that can actually be pressed, wrapping around, so the loop is
 * press-press-press: the chip just asked for is in flight and inert, and
 * focus should already be on the next player rather than on a dead control.
 *
 * @param {string[]} names - The chips drawn, in order
 * @param {number} index - Which was just acted on
 * @param {number} now - Clock
 * @returns {number} Index to focus
 */
function nextChipIndex(names, index, now) {
    for (let step = 1; step <= names.length; step++) {
        const at = (index + step) % names.length;
        if (!isAwaitingCapture(names[at], now)) return at;
    }
    return index;
}

/**
 * Put focus back on the chip the reader was on.
 *
 * @param {HTMLElement} row - The chip row just drawn
 */
function restoreChipFocus(row) {
    if (!pendingChipFocus) return;
    const chips = [...row.querySelectorAll('[data-trial-chip]')];
    if (!chips.length) return;
    const wanted = String(pendingChipFocus.name || '')
        .trim()
        .toLowerCase();
    const byName = chips.find((chip) => chip.dataset.trialChip === wanted);
    // No chip by that name means the player was captured — the whole point of
    // the press — so focus falls to whoever took their place in the row
    const index = Math.min(Math.max(Number(pendingChipFocus.index) || 0, 0), chips.length - 1);
    (byName || chips[index]).focus();
}

/**
 * One outstanding player, as a chip that asks for their Battle Info.
 *
 * The name is written with `textContent` and never parsed as markup — player
 * names are player-controlled text, and this file builds every node rather
 * than assembling HTML precisely so that a name can never be anything but a
 * name. (`escapeText` is for the surfaces that do build markup strings; here
 * escaping it would only make `A&B` read as `A&amp;B`.)
 *
 * A chip whose request is in flight is drawn dim, marked `aria-disabled` and
 * does nothing when pressed. It is deliberately not `disabled`: a disabled
 * button cannot hold focus, and focus landing on it is how the row keeps its
 * place while a sheet is on its way.
 *
 * @param {string} name - The player
 * @param {number} index - Position in the drawn row
 * @param {string[]} names - Every chip drawn, for the focus hop
 * @param {number} now - Clock
 * @returns {HTMLElement} The chip
 */
function playerChip(name, index, names, now) {
    const awaiting = isAwaitingCapture(name, now);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = name;
    chip.dataset.trialChip = name.toLowerCase();
    chip.setAttribute('aria-disabled', awaiting ? 'true' : 'false');
    chip.title = awaiting
        ? `${name}: Battle Info already asked for — waiting for the sheet. Askable again once the request times out.`
        : `Open ${name}'s Battle Info — one request per press, nothing automatic.`;
    chip.style.cssText =
        `background: rgba(255,255,255,${awaiting ? '0.03' : '0.08'}); ` +
        `border: 1px solid ${awaiting ? 'rgba(255,255,255,0.12)' : `${ACCENT}66`}; ` +
        `color: ${awaiting ? 'rgba(232,236,245,0.45)' : '#e8ecf5'}; ` +
        'border-radius: 9px; padding: 1px 7px; font-size: 11px; line-height: 16px; ' +
        `max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; ` +
        `cursor: ${awaiting ? 'default' : 'pointer'};`;

    chip.addEventListener('focus', () => {
        pendingChipFocus = { name, index };
    });
    chip.addEventListener('blur', (event) => {
        // Focus moving to something that is not a chip is the reader leaving
        // the row; a chip vanishing under a redraw is not, and that case must
        // keep the intent so the row can restore it. relatedTarget is null
        // BOTH for a redraw and for a click on something unfocusable (or the
        // tab losing focus) — the tell is whether the chip is still in the
        // document a beat later: still connected means the reader left and
        // every later refresh must not yank focus back into the row.
        const to = event.relatedTarget;
        if (to) {
            if (!to.dataset?.trialChip) pendingChipFocus = null;
            return;
        }
        setTimeout(() => {
            if (chip.isConnected && pendingChipFocus?.name === name) pendingChipFocus = null;
        }, 0);
    });
    chip.addEventListener('click', () => {
        const at = Date.now();
        // The in-flight window is enforced here as well as in the action: a
        // chip pressed inside it is inert, never a second request
        if (isAwaitingCapture(name, at)) return;
        controls.captureFor(name);
        const target = nextChipIndex(names, index, Date.now());
        pendingChipFocus = { name: names[target], index: target };
        guildTrialAbilitiesPanel.render();
    });
    return chip;
}

/**
 * The outstanding players as a row of chips, each one their own capture press.
 *
 * Drawn in the header because that is where the count is: "19 players still
 * need Battle Info" and then, immediately, which nineteen — and pressing one
 * asks for that player instead of whoever the fixed order would have reached.
 *
 * @param {HTMLElement} card - The header card
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {number} [now] - Clock
 * @returns {HTMLElement|null} The row, or null when nobody is outstanding
 */
function drawOutstandingChips(card, state, now = Date.now()) {
    const names = (state.outstanding || []).map((entry) => String(entry?.name || '').trim()).filter(Boolean);
    if (!names.length) return null;

    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        margin: '4px 0 2px',
        paddingLeft: '2px',
    });

    const shown = chipsExpanded ? names : names.slice(0, CHIP_LIMIT);
    shown.forEach((name, index) => row.appendChild(playerChip(name, index, shown, now)));

    const hidden = names.length - shown.length;
    if (hidden > 0) {
        const more = controlButton(`+${hidden} more`, 'Show every outstanding player as a chip.', () => {
            chipsExpanded = true;
            guildTrialAbilitiesPanel.render();
        });
        more.style.cssText += 'padding: 1px 7px; font-size: 11px; border-radius: 9px;';
        row.appendChild(more);
    }

    card.appendChild(row);
    restoreChipFocus(row);
    return row;
}

/**
 * The header card: progress, tier, and what the panel will not yet claim.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 */
function drawHeader(body, state) {
    const card = panelCard(body, headerLine(state), ACCENT);

    // Said first, because it reframes every claim below it: these are the
    // last trial's captures, kept viewable until the next trial replaces them
    const lastTrial = staleSessionNote(state);
    if (lastTrial) card.appendChild(panelNote(lastTrial));

    if (!state.rosterCount) {
        card.appendChild(panelNote('No trial roster yet — the participants are fed in when a trial is on.'));
        return;
    }

    const score = classChecksLine(state.classChecks);
    if (state.complete) {
        card.appendChild(panelLine('Complete', completionLine(state), ROW_COLORS.good));
        if (score) card.appendChild(panelLine('Class detection', score.text, score.color, score.title));
        return;
    }
    if (score) card.appendChild(panelLine('Class detection', score.text, score.color, score.title));

    const tier = tierRangeLabel(state.capturedTiers, state.captureTier);
    if (tier) card.appendChild(panelLine('Capture tier', tier, ROW_COLORS.gold));
    card.appendChild(
        panelLine(
            'Still needed',
            `${state.outstanding.length} player${state.outstanding.length === 1 ? '' : 's'} still need Battle Info`,
            ROW_COLORS.bad
        )
    );
    // Who they are, immediately under the count, each one their own press
    drawOutstandingChips(card, state);
    card.appendChild(panelNote('Press a name to ask for that player’s Battle Info — one request per press.'));
    card.appendChild(panelNote(`Aura coverage is read against the ${state.capturedCount} captured so far.`));
}

/**
 * What an uncovered aura reads as: the honest denominator, or the verdict.
 *
 * `Unknown` was the old answer for every uncovered aura until the very last
 * participant landed — and at fifty participants one click apiece inside a
 * sixty-five-minute trial, that headline is realistically never reached, so
 * the card said nothing at all for the whole hour. But `covered` was always
 * sound on partial data (a provider seen is a provider), and so is its
 * negative *over the captures in hand*. So the partial row says exactly what
 * has been looked at and exactly what has not, and only the full roster earns
 * the flat `MISSING` — which still means what it always meant: proven absent.
 *
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {{text: string, color: string, title: string}} The row's right-hand side
 */
export function auraGapText(state) {
    const captured = Number(state?.capturedCount) || 0;
    const roster = Number(state?.rosterCount) || 0;
    const unseen = Math.max(0, roster - captured);

    // No roster is not an empty roster. `unseen === 0` was standing in for
    // "everybody has been captured", and nobody-at-all satisfies it trivially
    // — so the panel opened outside a trial, or before the first roster
    // message, drew every aura as a proven MISSING.
    if (roster === 0) {
        return {
            text: 'no participants yet',
            color: ROW_COLORS.dim,
            title: 'Nobody is on the roster yet, so nothing has been looked at and nothing is missing.',
        };
    }

    if (state?.complete || unseen === 0) {
        return {
            text: 'MISSING',
            color: ROW_COLORS.bad,
            title: 'Every participant is captured and nobody equips it.',
        };
    }
    return {
        text: `none among ${captured} captured · ${unseen} unseen`,
        color: ROW_COLORS.dim,
        title:
            `No provider among the ${captured} captured; ${unseen} unseen. ` +
            'One of the unseen may equip it — this is not MISSING until every participant is captured.',
    };
}

/**
 * The aura coverage card: one row per aura the game data declares.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data
 */
function drawAuraCoverage(body, state, abilityDetailMap) {
    const { card, collapsed } = collapsibleCard(body, AURA_SECTION_TITLE, 'auras');
    if (collapsed) return;
    const hrids = Object.keys(state.coverage).sort((a, b) =>
        abilityName(a, abilityDetailMap).localeCompare(abilityName(b, abilityDetailMap))
    );
    if (!hrids.length) {
        card.appendChild(panelNote('No aura data in the game data yet.'));
        return;
    }

    for (const hrid of hrids) {
        const name = abilityName(hrid, abilityDetailMap);
        const aura = state.auras[hrid];
        const covered = state.coverage[hrid] === 'covered';

        if (covered) {
            const level = aura.highestLevel !== null ? `Lv${aura.highestLevel}` : 'Lv?';
            const extra = aura.duplicateCount
                ? ` · ${aura.duplicateCount} redundant cop${aura.duplicateCount === 1 ? 'y' : 'ies'}`
                : '';
            const providers = aura.providers
                .map((provider) => `${provider.name}${provider.level !== null ? ` Lv${provider.level}` : ''}`)
                .join(', ');
            const line = panelLine(
                name,
                `${level} — ${aura.provider}${extra}`,
                ROW_COLORS.good,
                `Highest equipped copy, not an effective value.\nProviders: ${providers}`
            );
            wireProfileClick(line, aura.provider);
            card.appendChild(line);
        } else {
            const gap = auraGapText(state);
            card.appendChild(panelLine(name, gap.text, gap.color, gap.title));
        }
    }
}

/**
 * The Plan section's own state, which survives a redraw but not a reload.
 *
 * `open` is the disclosure — a lead writing a plan wants it open across the
 * refreshes a live trial produces. `draft` is text typed and not yet saved:
 * the timed refresh already leaves a focused textarea alone, but a landed
 * Battle Info sheet redraws the panel outright, and that must not eat what is
 * half-written.
 */
const planUi = { open: false, draft: null };

/** Forget the section's draft and disclosure — for tests and a fresh panel */
export function resetPlanUi() {
    planUi.open = false;
    planUi.draft = null;
    planUiGuildName = undefined;
}

/**
 * The guild the Plan section's draft was last drawn for.
 *
 * `undefined` until the first draw, deliberately distinct from `null` (the
 * "no guild known yet" state), so a first draw with no guild known does not
 * itself look like a change and clear a draft nothing has touched.
 */
let planUiGuildName;

/**
 * Drop an unsaved draft that belongs to a guild this trial has left.
 *
 * `guildTrialPlan` is keyed per guild, so its saved text already changes
 * correctly under {@link drawPlan}'s `guildTrialPlan.text()` fallback — but
 * `planUi.draft` does not know a guild from a stack of characters, and once
 * typed it survives a redraw on purpose (so a live trial's ticks do not eat
 * what the lead is mid-sentence writing). Left unguarded, that same
 * durability leaks: a lead switches character mid-session (one account
 * running a main plus alts, each in a different guild) or the trial's own
 * guild name resolves late, the box still shows the previous guild's
 * half-written plan over the new guild's saved one, and "Save plan" would
 * write it there. Compared against the guild the *state* now carries, not
 * against `guildTrialPlan`'s own key, so the reset lands the moment the panel
 * itself starts speaking for a different guild.
 *
 * @param {string|null} guildName - `state.guildName` for this draw
 */
function guardPlanUiGuild(guildName) {
    if (planUiGuildName !== undefined && planUiGuildName !== guildName) resetPlanUi();
    planUiGuildName = guildName;
}

/**
 * One player's verdict against the plan, in a word and a list.
 * @param {Object} verdict - From `comparePlan`
 * @returns {{text: string, color: string, title: string}|null} What to draw, or null for silence
 */
export function verdictLine(verdict) {
    if (!verdict || verdict.status === 'uncaptured') return null;
    if (verdict.status === 'missing') {
        return {
            text: `missing: ${verdict.missing.join(', ')}`,
            color: ROW_COLORS.bad,
            title: 'Planned for this player and not equipped.',
        };
    }
    if (verdict.status === 'underLevel') {
        const under = verdict.underLevel
            .map((entry) => `${entry.name} ${entry.level ?? '?'} < ${entry.required}`)
            .join(', ');
        return { text: `under level: ${under}`, color: ROW_COLORS.gold, title: 'Equipped below the planned level.' };
    }
    if (verdict.extra.length) {
        return {
            text: `on plan · extra: ${verdict.extra.join(', ')}`,
            color: ROW_COLORS.good,
            title: 'Everything planned is equipped; the extras are informational.',
        };
    }
    return { text: 'on plan', color: ROW_COLORS.good, title: 'Everything planned is equipped.' };
}

/**
 * What keeps one player off the plan, in the export's words.
 *
 * A verdict can carry several deviations at once — `status` names only the
 * worst — so the export lists them all rather than the headline: a player
 * missing one aura and under level on another is both, and a lead fixing the
 * kit needs both named.
 *
 * @param {Object} verdict - From `comparePlan`
 * @returns {string} e.g. `missing: Aqua Aura · under level: Vampirism 120 < 150`
 */
function offPlanReasons(verdict) {
    const parts = [];
    if (verdict.status === 'uncaptured') parts.push('not captured — needs Battle Info');
    if (verdict.missing?.length) parts.push(`missing: ${verdict.missing.join(', ')}`);
    if (verdict.underLevel?.length) {
        const under = verdict.underLevel
            .map((entry) => `${entry.name} ${entry.level ?? '?'} < ${entry.required}`)
            .join(', ');
        parts.push(`under level: ${under}`);
    }
    return parts.join(' · ');
}

/**
 * The off-plan roster as shareable text, one player per line.
 *
 * ```text
 * Off plan 2/3 (T4, 2026-08-31)
 * Bob — missing: Aqua Aura
 * Cara — under level: Aqua Aura 90 < 150
 * ```
 *
 * Off plan is everyone the plan names whose verdict is not `ok` — the same
 * arithmetic as the status line's `N/M on plan`, from the other side. Extras
 * alone keep a player on plan and out of this list, exactly as they keep the
 * status green.
 *
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {number} [now] - Clock, for the date when the session has none
 * @returns {string|null} The list, or null with no plan or everyone on it
 */
export function offPlanExportText(state, now = Date.now()) {
    const compare = state?.planCompare;
    const summary = compare?.summary;
    if (!summary?.planLines || !summary.plannedPlayers) return null;

    const off = (compare.verdicts || []).filter((verdict) => verdict.status !== 'ok');
    if (!off.length) return null;

    const trial = tierRangeLabel(state.capturedTiers, state.captureTier) || 'trial';
    const at = Number.isFinite(state.startedAt) ? state.startedAt : now;
    const date = new Date(at).toISOString().slice(0, 10);
    const lines = off.map((verdict) => `${verdict.name} — ${offPlanReasons(verdict)}`);
    return [`Off plan ${off.length}/${summary.plannedPlayers} (${trial}, ${date})`, ...lines].join('\n');
}

/**
 * The Plan heading's export button: the off-plan list onto the clipboard.
 *
 * Lives in the heading row so it is reachable with the card folded — the
 * status line is, and this is that line made pasteable. With everyone on plan,
 * with no plan at all, or with a plan that names nobody who turned up, the
 * press says which of those it is instead of copying an empty list.
 *
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @returns {HTMLElement} The button
 */
function offPlanExportButton(state) {
    const button = controlButton(
        'Export off-plan',
        'Copy every player not on plan, one per line with what deviates.',
        async (event) => {
            // The heading it sits in folds the card on click
            event.stopPropagation();
            const flash = (label) => {
                button.textContent = label;
                setTimeout(() => {
                    button.textContent = 'Export off-plan';
                }, 1500);
            };
            const exportText = offPlanExportText(state);
            if (!exportText) {
                // Three different nothings, and only one of them is good news.
                // A plan whose every line names somebody not in this trial
                // compares nobody, and calling that "All on plan" is the one
                // claim this button must never make
                const summary = state?.planCompare?.summary;
                flash(
                    !summary?.planLines
                        ? 'No plan saved'
                        : summary.plannedPlayers
                          ? 'All on plan ✓'
                          : 'Nobody planned is here'
                );
                return;
            }
            try {
                await navigator.clipboard.writeText(exportText);
                flash('Copied ✓');
            } catch (error) {
                console.error('[GuildTrialAbilitiesUI] Copying the off-plan list failed:', error);
                flash('Copy failed');
            }
        }
    );
    button.style.cssText +=
        'padding: 0 6px; font-size: 11px; line-height: 16px; font-weight: normal; margin-left: auto;';
    return button;
}

/**
 * What the last save changed, as one line that opens into the full list.
 *
 * Drawn only when there is something to report: the first save of all has no
 * previous plan to compare against, and a save that changed nothing says so by
 * saying nothing.
 *
 * @param {Object|null} diff - From `guildTrialPlan.lastDiff()`
 * @returns {HTMLElement|null} The note, or null when the plan did not move
 */
function planChangeNote(diff) {
    const summary = planDiffSummary(diff);
    if (!summary) return null;

    const details = document.createElement('details');
    details.className = 'toolasha-plan-diff';
    const line = document.createElement('summary');
    line.textContent = `Since last save: ${summary}`;
    Object.assign(line.style, { cursor: 'pointer', color: ROW_COLORS.dim, fontSize: '11px', margin: '2px 0' });
    details.appendChild(line);

    const list = document.createElement('div');
    Object.assign(list.style, { paddingLeft: '10px', color: ROW_COLORS.dim, fontSize: '11px' });
    for (const entry of diff.changed) list.appendChild(planChangeRow(describePlanChange(entry)));
    for (const player of diff.added) list.appendChild(planChangeRow(`added: ${player}`));
    for (const player of diff.removed) list.appendChild(planChangeRow(`removed: ${player}`));
    details.appendChild(list);
    return details;
}

/**
 * One line of the expanded change list.
 * @param {string} text - The change
 * @returns {HTMLElement} The row
 */
function planChangeRow(text) {
    const row = document.createElement('div');
    row.textContent = text;
    return row;
}

/**
 * The Plan card: the text the lead wrote, and what it says about the roster.
 *
 * Collapsed by default — the panel's job is the capture, and the plan is
 * consulted rather than read — but its status line is always visible, because
 * that is the answer the section exists to give.
 *
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data, so a save can diff what it changed
 */
function drawPlan(body, state, abilityDetailMap) {
    // Checked before the fold check: a stale draft is wrong whether or not
    // the card happens to be collapsed on the draw that crosses the guild
    guardPlanUiGuild(state.guildName ?? null);
    const { card, collapsed } = collapsibleCard(body, 'Plan', 'plan');
    // Into the heading row, before the fold check: folded or not, the export
    // rides beside the title the way the fold marker does
    const heading = card.firstElementChild;
    Object.assign(heading.style, { display: 'flex', alignItems: 'center', gap: '8px' });
    heading.appendChild(offPlanExportButton(state));
    if (collapsed) return;
    card.appendChild(panelNote(planStatusLine(state.planCompare)));
    const changes = planChangeNote(guildTrialPlan.lastDiff());
    if (changes) card.appendChild(changes);

    const details = document.createElement('details');
    details.open = planUi.open;
    details.addEventListener('toggle', () => {
        planUi.open = details.open;
    });

    const summary = document.createElement('summary');
    summary.textContent = 'Edit plan';
    Object.assign(summary.style, { cursor: 'pointer', color: 'rgba(232, 236, 245, 0.7)', margin: '2px 0' });
    details.appendChild(summary);

    const box = document.createElement('textarea');
    box.rows = 6;
    box.spellcheck = false;
    box.value = planUi.draft ?? guildTrialPlan.text();
    box.placeholder = 'Alice: Fierce Aura 200, Vampirism\n# lines starting with # are ignored';
    box.style.cssText =
        'width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.35); color: #e8ecf5; ' +
        'border: 1px solid rgba(255,255,255,0.18); border-radius: 5px; padding: 5px; font-size: 12px; ' +
        'font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical;';
    box.addEventListener('input', () => {
        planUi.draft = box.value;
    });
    details.appendChild(box);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', marginTop: '4px' });
    row.appendChild(
        controlButton('Save plan', 'Store this plan for the guild and compare the captures against it.', async () => {
            planUi.draft = null;
            await guildTrialPlan.setText(box.value, abilityDetailMap);
            guildTrialAbilitiesPanel.render();
        })
    );
    details.appendChild(row);
    card.appendChild(details);

    if (state.planCompare?.notInTrial?.length) {
        card.appendChild(
            panelLine(
                'Not in trial',
                state.planCompare.notInTrial.join(', '),
                ROW_COLORS.dim,
                'Planned, but not among this trial’s participants.'
            )
        );
    }
    for (const entry of state.plan?.ambiguousTokens || []) {
        card.appendChild(
            panelLine(entry.token, `ambiguous: ${entry.matches.join(', ')}`, ROW_COLORS.gold, 'Name it more fully.')
        );
    }
}

/**
 * One player's abilities as inline spans, auras highlighted.
 * @param {Object} capture - The player's session entry
 * @param {Object} abilityDetailMap - Game data
 * @returns {HTMLElement} The line
 */
function abilityRow(capture, abilityDetailMap) {
    const line = document.createElement('div');
    Object.assign(line.style, { display: 'flex', flexWrap: 'wrap', gap: '4px 10px', paddingLeft: '10px' });

    if (!capture.abilities?.length) {
        const empty = document.createElement('span');
        empty.textContent = 'no abilities equipped';
        empty.style.color = 'rgba(232, 236, 245, 0.5)';
        line.appendChild(empty);
        return line;
    }

    // Slot order as captured — the order the payload listed them in
    for (const ability of capture.abilities) {
        const span = document.createElement('span');
        const level = ability.level !== null && ability.level !== undefined ? ` ${ability.level}` : '';
        span.textContent = `${abilityName(ability.hrid, abilityDetailMap)}${level}`;
        if (isAuraAbility(abilityDetailMap?.[ability.hrid])) {
            span.style.color = ROW_COLORS.gold;
            span.title = 'Aura — its buff reaches the whole party.';
        } else {
            span.style.color = 'rgba(232, 236, 245, 0.75)';
        }
        line.appendChild(span);
    }
    return line;
}

/**
 * How a class tag is coloured — one hue per role, so a roster reads as a shape
 * rather than as a column of identical chips.
 */
const CLASS_COLORS = {
    tank: ROW_COLORS.accent,
    healer: ROW_COLORS.good,
    fireMage: ROW_COLORS.bad,
    waterMage: ROW_COLORS.accent,
    mage: ROW_COLORS.violet,
    ranged: ROW_COLORS.gold,
    melee: ROW_COLORS.neutral,
};

/**
 * What a class chip says and what it says when hovered.
 *
 * Exported for its own sake: the wording is the whole of the honesty here — the
 * tag is an inference and the tooltip has to name the evidence it was drawn
 * from, or a reader has no way to tell a watched rotation from a guess off a
 * weapon.
 *
 * @param {Object|null} classTag - From `guildTrialAbilities.state()`
 * @returns {{text: string, title: string, color: string}|null} Null when there is no verdict
 */
export function classTagText(classTag) {
    if (!classTag?.short) return null;

    const seen = (classTag.evidence || [])
        .map((hrid) => String(hrid).split('/').pop().replace(/_/g, ' '))
        .filter(Boolean);

    return {
        text: classTag.short,
        color: CLASS_COLORS[classTag.key] || ROW_COLORS.dim,
        title:
            `${classTag.label} — inferred from ${classTag.basis}` +
            (seen.length ? `: ${seen.join(', ')}` : '') +
            '. An inference, not a statement: a Battle Info capture is the only authority on a kit.',
    };
}

/**
 * What to say about one player's class check.
 * @param {{guess: Object|null, actual: Object|null, agree: boolean|null}|null} check - From `state()`
 * @returns {{text: string, color: string, title: string}|null} Null when there is nothing to compare
 */
export function classCheckLine(check) {
    if (!check?.guess || !check?.actual) return null;
    if (check.agree) {
        return {
            text: `detection ✓ ${check.actual.label}`,
            color: ROW_COLORS.good,
            title: `The casts said ${check.guess.label} (${check.guess.basis}); Battle Info agrees (${check.actual.basis}).`,
        };
    }
    return {
        text: `detection ✗ guessed ${check.guess.label}, Battle Info says ${check.actual.label}`,
        color: ROW_COLORS.bad,
        title:
            `From casts: ${check.guess.label} — ${check.guess.basis}` +
            (check.guess.evidence?.length
                ? ` (${check.guess.evidence.map((h) => h.split('/').pop()).join(', ')})`
                : '') +
            `. From Battle Info: ${check.actual.label} — ${check.actual.basis}.`,
    };
}

/**
 * The detector's scorecard for the header: right, wrong, untested.
 * @param {{agree: number, disagree: number, untested: number}|null} checks - From `state()`
 * @returns {{text: string, color: string, title: string}|null} Null with nothing to score
 */
export function classChecksLine(checks) {
    if (!checks) return null;
    const tested = (checks.agree || 0) + (checks.disagree || 0);
    if (!tested && !checks.untested) return null;
    const pct = tested ? Math.round((checks.agree / tested) * 100) : null;
    const text = tested
        ? `${checks.agree}/${tested} right (${pct}%)` + (checks.untested ? ` · ${checks.untested} untested` : '')
        : `${checks.untested} captured, none cast yet`;
    return {
        text,
        color: !tested ? ROW_COLORS.dim : checks.disagree ? ROW_COLORS.gold : ROW_COLORS.good,
        title:
            'How the class guessed from the cast stream compares with Battle Info, per captured player. ' +
            'Untested players are captured but have not been seen casting yet.',
    };
}

/**
 * A participant's name line, with its class tag beside the name.
 *
 * @param {Object} row - A `state().participants` row
 * @param {string} value - The status text on the right
 * @param {string} color - Its colour
 * @param {string} [title] - Hover text for the line
 * @returns {HTMLElement}
 */
function playerLine(row, value, color, title = '') {
    const line = panelLine(row.name, value, color, title);
    wireProfileClick(line, row.name);
    const tag = classTagText(row.classTag);
    if (!tag) return line;

    // The weapon the game itself draws for this style, when the data can name
    // one — one glyph where six letters and a border used to sit. The chip is
    // the fallback, not the plan B nobody tested: it is what a client draws
    // before the init payload lands, every time.
    const icon = classTagIcon(row.classTag, { title: tag.title });
    if (icon) {
        icon.style.marginLeft = '5px';
        line.firstChild?.after(icon);
        return line;
    }

    const chip = document.createElement('span');
    chip.textContent = tag.text;
    chip.title = tag.title;
    Object.assign(chip.style, {
        color: tag.color,
        fontSize: '9px',
        letterSpacing: '0.5px',
        border: `1px solid ${tag.color}`,
        borderRadius: '3px',
        padding: '0 3px',
        marginLeft: '5px',
        opacity: '0.85',
        whiteSpace: 'nowrap',
    });
    // After the name span rather than at the end: the status text is
    // right-aligned, and a chip pushed against it would read as part of it
    line.firstChild?.after(chip);
    return line;
}

/**
 * The players card: capture status and kits, in the sort the moment calls for.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data
 */
function drawPlayers(body, state, abilityDetailMap) {
    const { card, collapsed } = collapsibleCard(
        body,
        `Players (${state.capturedCount}/${state.rosterCount})`,
        'players'
    );
    if (collapsed) return;
    if (!state.participants.length) {
        card.appendChild(panelNote('No participants fed in yet.'));
    }

    for (const row of sortParticipants(state.participants, state.complete)) {
        if (!row.capture) {
            card.appendChild(playerLine(row, 'needs Battle Info', ROW_COLORS.bad));
            continue;
        }
        if (!row.captured) {
            // Seen, but only as a stat sheet: unavailable is not the same claim
            // as "no abilities equipped", so the player stays outstanding
            card.appendChild(
                playerLine(
                    row,
                    'abilities unavailable — needs Battle Info',
                    ROW_COLORS.bad,
                    'A stat-only sighting; the popup payload carried no ability list.'
                )
            );
            continue;
        }
        const tier = tierText(row.capture.capturedTier);
        card.appendChild(playerLine(row, `captured${tier ? ` (${tier})` : ''}`, ROW_COLORS.good));
        card.appendChild(abilityRow(row.capture, abilityDetailMap));

        // The cast-stream guess against the sheet, for a player with both —
        // what the class detector got right and what it got wrong, by name
        const check = classCheckLine(row.classCheck);
        if (check) {
            const line = document.createElement('div');
            line.textContent = check.text;
            line.title = check.title;
            Object.assign(line.style, { paddingLeft: '10px', color: check.color, fontSize: '0.9em' });
            card.appendChild(line);
        }

        // Only a player the plan names says anything here: an unplanned player
        // gets no line at all, so the list stays about the capture
        const verdict = verdictLine(state.planCompare?.byName?.[String(row.name || '').toLowerCase()]);
        if (verdict) {
            const line = document.createElement('div');
            line.textContent = verdict.text;
            line.title = verdict.title;
            Object.assign(line.style, { paddingLeft: '10px', color: verdict.color });
            card.appendChild(line);
        }
    }

    for (const player of state.notCurrent) {
        const line = panelLine(
            player.name || '(unnamed)',
            'not in the current roster',
            ROW_COLORS.dim,
            'Captured this session, then left the trial — the capture is kept.'
        );
        wireProfileClick(line, player.name);
        card.appendChild(line);
    }
}

/** The non-aura abilities worth a headcount: party-saving utility picks */
export const UTILITY_ABILITY_HRIDS = ['/abilities/revive', '/abilities/invincible', '/abilities/insanity'];

/**
 * The utility headcount card: how many captured players run Revive,
 * Invincible and Insanity, named in the tooltip.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 * @param {Object} abilityDetailMap - Game data
 */
function drawUtilityCounts(body, state, abilityDetailMap) {
    const { card, collapsed } = collapsibleCard(body, 'Utility coverage', 'utility');
    if (collapsed) return;
    for (const hrid of UTILITY_ABILITY_HRIDS) {
        const users = state.participants
            .filter((row) => row.captured && row.capture?.abilities?.some((ability) => ability.hrid === hrid))
            .map((row) => row.name);
        const name = abilityName(hrid, abilityDetailMap);
        if (users.length) {
            // The count on the line, the names under it — a figure stays on
            // its line, a roster of nine names does not
            card.appendChild(
                panelLine(
                    name,
                    `${users.length} player${users.length === 1 ? '' : 's'}`,
                    ROW_COLORS.good,
                    'Among captured players.'
                )
            );
            const who = document.createElement('div');
            users.forEach((user, index) => {
                if (index) who.appendChild(document.createTextNode(', '));
                const span = document.createElement('span');
                span.textContent = user;
                wireProfileClick(span, user);
                who.appendChild(span);
            });
            Object.assign(who.style, {
                color: 'rgba(232, 236, 245, 0.6)',
                fontSize: '0.9em',
                padding: '0 0 4px 12px',
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
            });
            card.appendChild(who);
        } else {
            card.appendChild(
                panelLine(
                    name,
                    'none',
                    state.complete ? ROW_COLORS.bad : ROW_COLORS.dim,
                    state.complete
                        ? 'Every participant is captured and nobody equips it.'
                        : 'Not seen yet — some participants still need Battle Info.'
                )
            );
        }
    }
}

/**
 * A small control button in the panel's idiom.
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

/**
 * The controls card.
 * @param {HTMLElement} body - Panel body
 * @param {Object} state - From `guildTrialAbilities.state()`
 */
function drawControls(body, state) {
    const { card, collapsed } = collapsibleCard(body, 'Controls', 'controls');
    if (collapsed) return;
    Object.assign(card.style, { flexDirection: 'row', flexWrap: 'wrap', gap: '6px' });

    card.appendChild(
        controlButton(
            'Open next Battle Info',
            'Click the next outstanding fighter’s unit box — one popup per click, nothing automatic.',
            () => {
                controls.openNext();
                guildTrialAbilitiesPanel.render();
            }
        )
    );
    card.appendChild(
        controlButton(
            'Retry current player',
            'Ask again for the player still outstanding. A timed-out capture is retryable, never skipped.',
            () => {
                controls.retryCurrent(state.outstanding[0]?.name ?? null);
                guildTrialAbilitiesPanel.render();
            }
        )
    );
    card.appendChild(
        controlButton(
            'Recapture trial roster',
            'Throw this session’s captures away and collect the roster again from nothing.',
            () => {
                guildTrialAbilities.recapture();
                resetTrialUnitRequests();
                guildTrialAbilitiesPanel.render();
            }
        )
    );
}

export const guildTrialAbilitiesPanel = createPanel({
    id: 'guildTrialAbilities',
    title: 'Trial Abilities',
    size: { width: 440, height: 520 },
    accent: ACCENT,
    draw: (body) => {
        const abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap || {};
        adoptStoredCaptures();
        const state = guildTrialAbilities.state(abilityDetailMap);
        // Controls first, above even the summary, on purpose: everything below
        // grows — the plan, the coverage lists, a row per capture — and buttons
        // that keep moving down are buttons you miss
        drawControls(body, state);
        drawHeader(body, state);
        drawPlan(body, state, abilityDetailMap);
        drawAuraCoverage(body, state, abilityDetailMap);
        drawUtilityCounts(body, state, abilityDetailMap);
        drawPlayers(body, state, abilityDetailMap);
    },
});

/**
 * Open the panel — the hook the trials UI calls.
 */
export function openTrialAbilitiesPanel() {
    guildTrialAbilitiesPanel.show();
}

/**
 * Fold in any Battle Info sheet the roster store already holds for an
 * outstanding player, taken since this session began.
 *
 * The store and this session are fed by the same `battle_unit_fetched`
 * events, but the store is the one that cannot miss them — it is the
 * persistence — while the session hears about them through a listener. A
 * reload, an event that lands before the session is up, anything that drops
 * one: the roster panel shows "seen 1m" and this panel still says "needs
 * Battle Info" for the same player. So on every draw the session adopts what
 * the store has. Only authoritative sheets (the popup and `battle_unit_fetched`,
 * never a `new_battle` kit — see {@link onCapturedEvent}), only sightings no
 * older than the session — last trial's sheets are last trial's kit.
 *
 * @returns {number} How many were adopted
 */
export function adoptStoredCaptures() {
    try {
        const state = guildTrialAbilities.state();
        if (!state?.outstanding?.length) return 0;
        // With no session yet (one begins on the first capture) the horizon is
        // the session's own maximum age: anything older would have started a
        // fresh session anyway, and last trial's sheets are older than that
        const horizon = state.startedAt || Date.now() - SESSION_MAX_AGE_MS;
        let adopted = 0;
        for (const row of state.outstanding) {
            const snapshot = row?.name ? guildLoadoutCapture.forPlayer?.(row.name) : null;
            if (!snapshot || snapshot.source === 'new_battle' || snapshot.abilitiesAuthoritative !== true) continue;
            const at = Number(snapshot.abilitiesAt ?? snapshot.at) || 0;
            if (at < horizon) continue;
            // `now` is what the session's age is measured against: several
            // sheets read more than the session's maximum age apart are still
            // being adopted in one pass, and adopting them must not restart
            // the session and discard the ones already folded in
            guildTrialAbilities.recordCapture(snapshot, { at, now: Date.now() });
            delete trialUnitRequests[String(row.name).toLowerCase()];
            adopted++;
        }
        return adopted;
    } catch (error) {
        console.error('[GuildTrialAbilitiesUI] Adopting stored captures failed:', error);
        return 0;
    }
}

/** Unsubscribe from the loadout capture's events; set in `initialize` */
let offCaptured = null;

/** The trial-tick handler, kept so cleanup can unsubscribe exactly it */
let onTrialTick = null;

/** The lifecycle messages a live trial announces itself with */
const TRIAL_TICK_MESSAGES = ['new_guild_battle', 'new_guild_skilling'];

/**
 * A loadout landed somewhere in the client — fold it in and redraw.
 *
 * The event only names who; the snapshot itself (abilities included) is read
 * back off the capture store, which has already folded it.
 *
 * @param {{name: string|null}} event - From `guildLoadoutCapture.onCaptured`
 */
function onCapturedEvent(event) {
    try {
        if (!event?.name) return;
        // Your own zone fight's `new_battle` carries your combatAbilities —
        // your *current* kit, not the one this trial was entered with — and
        // folding it in marked the local player "captured" with the wrong
        // abilities while everyone else honestly said "needs Battle Info".
        // The trial session takes only what the trial itself can show: the
        // Battle Info popups, the same source for every participant.
        //
        // Judged on the *event's* source rather than the stored snapshot's.
        // The event says a sheet landed; the store is only read back for the
        // abilities the event does not carry, and what comes back is the
        // *folded* record — a `new_battle` sighting one wave later has already
        // taken over its `source` and `at` (and a fold whose sighting is older
        // than one already held is dropped entirely, event and all). Reading
        // the source off that read-back is what silently discarded Battle Info
        // popups that had genuinely arrived: three opened in a live trial, the
        // sheets on disk, the panel still saying "needs Battle Info".
        if (event.source === 'new_battle') return;
        const stored = guildLoadoutCapture.forPlayer?.(event.name);
        if (!stored) return;
        const snapshot = {
            ...stored,
            name: stored.name || event.name,
            characterId: stored.characterId ?? event.characterId ?? null,
            source: event.source ?? stored.source ?? null,
        };
        // The kit is stamped with when it was *read* — `abilitiesAt` survives a
        // later stat-only sighting folding over it, `at` does not
        const at = Number(snapshot.abilitiesAt ?? snapshot.at ?? event.at);
        guildTrialAbilities.recordCapture(snapshot, {
            at: Number.isFinite(at) ? at : undefined,
            now: Date.now(),
        });
        // An answered request is over: the next click moves on to the next
        // player at once instead of waiting out the request window. Only an
        // authoritative sheet clears it — a stat-only popup sighting leaves
        // the window standing so the same popup is not hammered.
        if (snapshot.abilitiesAuthoritative === true && event.name) {
            delete trialUnitRequests[String(event.name).toLowerCase()];
        }
        guildTrialAbilitiesPanel.render();
    } catch (error) {
        console.error('[GuildTrialAbilitiesUI] Handling a capture failed:', error);
    }
}

export default {
    name: 'Guild Trial Abilities',
    /**
     * @param {string|null} [guildName] - The key the session is stored under
     * @returns {Promise<void>}
     */
    initialize: async (guildName = null) => {
        // Subscribed *before* the session is restored, not after. The restore
        // is an IndexedDB read and a Battle Info popup that landed while it was
        // in flight had nobody listening — the sheet reached the store and
        // never reached the session. The restore merges what arrived in the
        // meantime rather than replacing it, so the order is safe both ways.
        offCaptured?.();
        offCaptured = guildLoadoutCapture.onCaptured?.((event) => onCapturedEvent(event)) ?? null;

        // Which cards the player keeps folded, restored before the first draw
        try {
            const saved = await storage.getJSON(COLLAPSED_CARDS_KEY, 'settings', []);
            collapsedCards.clear();
            for (const key of Array.isArray(saved) ? saved : []) collapsedCards.add(String(key));
        } catch (error) {
            console.error('[GuildTrialAbilitiesUI] Loading fold state failed:', error);
        }

        // A new trial's first tick blanks a session left over from the last
        // one, so the panel never opens onto a roster the trial has outlived;
        // a tick inside the session window is this trial's own and changes
        // nothing (the store guards the age, not this handler)
        if (onTrialTick) for (const type of TRIAL_TICK_MESSAGES) webSocketHook.off(type, onTrialTick);
        onTrialTick = () => {
            try {
                const before = guildTrialAbilities.session?.startedAt ?? null;
                guildTrialAbilities.noteTrialActivity(Date.now());
                if ((guildTrialAbilities.session?.startedAt ?? null) !== before) guildTrialAbilitiesPanel.render();
            } catch (error) {
                console.error('[GuildTrialAbilitiesUI] Trial tick handling failed:', error);
            }
        };
        for (const type of TRIAL_TICK_MESSAGES) webSocketHook.on(type, onTrialTick);

        await guildTrialAbilities.initialize(guildName);
    },
    cleanup: () => {
        offCaptured?.();
        offCaptured = null;
        if (onTrialTick) for (const type of TRIAL_TICK_MESSAGES) webSocketHook.off(type, onTrialTick);
        onTrialTick = null;
        guildTrialAbilitiesPanel.hide({ remember: false });
        guildTrialAbilities.cleanup();
    },
};
