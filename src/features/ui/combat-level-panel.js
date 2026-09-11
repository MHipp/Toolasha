/**
 * Combat Level panel
 *
 * How close the next combat level is, which skill gets you there, and what the
 * session has actually earned.
 *
 * The game shows a whole number. That hides both facts worth acting on: combat
 * level is a weighted average, so the fraction you have already earned is
 * invisible, and the skill that would finish it soonest is usually not the one
 * being trained.
 *
 * ## The bar is not the fraction of the formula
 *
 * The obvious reading of "how far to the next combat level" is the fraction the
 * displayed whole number throws away — `126.300` is 30% of the way to 127. That
 * is wrong, and wrong in a way that matters. Combat level is computed from whole
 * skill levels, so it steps; feed it the part-finished levels instead and it
 * becomes continuous. A build at `126.300` whose Melee is 81.7% of the way to
 * its next level is **79%** of the way to Combat 127, not 30% — because most of
 * the Melee level carrying the doubled term is already in the bank.
 *
 * So the panel runs the formula twice. Whole levels give the number the game
 * shows and the arithmetic spelled out beside it; fractional levels give the
 * bar. The bar is drawn in two colours for the same reason: the part banked from
 * completed levels, then the part contributed by the level in progress.
 *
 * ## What is on it
 *
 * - the session: when it started, how long, how much experience, at what rate
 * - a target selector: any skill, any level, the time to get there
 * - the combat level, the formula, and the two-tone bar above
 * - a block per skill actually gaining, with its share of the experience
 * - Time to Level, where reassigning the primary and focus skills answers "what
 *   if I trained something else instead" without training it
 * - the skills not gaining, compactly, and the charms and wisdom multiplying it
 * - experience between any two levels
 *
 * The arithmetic is in `utils/combat-level.js` and `utils/exp-session.js`,
 * checked against the figures GWhiz shows for the same build — `126.300`, the
 * 79% bar, "2 Levels of Melee", and the 8d 22h behind it are all reproduced.
 *
 * The panel is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { formatWithSeparator, formatKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { shortDuration, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import {
    COMBAT_SKILLS,
    OFFENSE_SKILLS,
    combatLevel,
    combatValueOf,
    levelsToNextCombat,
    cheapestRouteToNextCombat,
    levelFraction,
    fractionalLevels,
    experienceBetween,
    timeToTargetLevel,
    timeToCombatLevel,
} from '../../utils/combat-level.js';
import { beginSession, sessionProgress, sessionIsStale } from '../../utils/exp-session.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { skillName } from '../../utils/skill-progress.js';
import { createSkillHistory } from '../../utils/skill-history.js';
import { registerRow } from '../../utils/overlay-rows.js';

const PANEL_ID = 'toolasha-combat-level-panel';
const GEOMETRY_KEY = 'combatLevelPanel';
const DEFAULT_PANEL = { width: 560, height: 720 };
const REFRESH_MS = 5000;
const COMBAT_ACTION_TYPE = '/action_types/combat';

/**
 * The switch the background session tracker obeys.
 *
 * The panel has no entry of its own in the settings schema — it is reached from
 * the overlay and the command palette rather than switched on — so this reads
 * as on unless somebody has explicitly turned it off. Written as a setting
 * rather than as `true` so that adding the switch is all adding the switch
 * takes: nothing here has to change to be obeyed.
 */
const TRACKING_SETTING = 'combatLevelPanel';

/** How far back the rate behind each countdown is measured */
const WINDOW_MS = 10 * 60 * 1000;
const SAMPLE_MS = 5000;

/** How many segments the combat bar is divided into, as GWhiz draws it */
const BAR_SEGMENTS = 10;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(28, 20, 34, 0.9)',
    border: 'rgba(190, 150, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    track: 'rgba(255, 255, 255, 0.08)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#c9a0ff',
    combat: '#f0a030',
};

/**
 * A colour per combat skill, so the formula reads as the build it describes.
 *
 * The terms of a weighted average are anonymous numbers in a row; colouring them
 * is what lets you see at a glance which of the five the doubled term repeats.
 */
const SKILL_COLORS = {
    stamina: '#f0776c',
    intelligence: '#4fc3d9',
    attack: '#e8c14a',
    defense: '#7fd6c0',
    melee: '#e05555',
    ranged: '#5fd0a0',
    magic: '#b47ae8',
};

/**
 * This panel's own record of how fast each skill is going up.
 *
 * Its own rather than shared with the Time to Level row: neither should be able
 * to reset the other's measurement by being opened or closed. The awkward parts
 * — a clock that goes backwards, a reading from a different character — are in
 * `utils/skill-history.js`, once, rather than in a loop copied into both.
 */
const history = createSkillHistory({ windowMs: WINDOW_MS, sampleMs: SAMPLE_MS });

/** Take a reading of every skill, if one is due */
function sample() {
    history.sample(dataManager.getSkills?.());
}

/**
 * The session, kept at module scope so closing the panel does not reset it.
 *
 * Closing a panel is not the same gesture as starting a new measurement, and
 * conflating them means the one number you cannot recover — how long you have
 * been at this — is thrown away by tidying up.
 *
 * Opening one is not that gesture either, which is the bug this used to have:
 * the clock started on the first render, so a panel opened an hour into a grind
 * said `Duration: 5s`, `Exp: 0` and `Exp/Hr: measuring…` — three figures that
 * were all about the panel rather than about the run. It is started by combat
 * now (see {@link watchCombat}), so opening the panel joins a session already in
 * progress rather than beginning one.
 */
let session = null;

/**
 * Whether a fight is under way.
 *
 * The session is armed on the first battle after this goes false, which is what
 * makes "a session" mean a run rather than a page load: leaving combat arms the
 * next start, and every battle in between is the same session.
 */
let inCombat = false;

/**
 * Combat has started, so the session starts with it.
 *
 * Deliberately cheap — a settings read, the skill list the data manager already
 * holds, and a baseline object — because this runs off a WebSocket message that
 * every other combat feature is also listening to, and none of it touches the
 * DOM. The panel is not involved and does not need to exist.
 *
 * Skills that have not loaded yet leave this disarmed rather than baselined
 * against nothing: battles arrive every few seconds, so the next one starts it.
 */
function combatStarted() {
    try {
        if (inCombat) return;
        if (!config.getSetting(TRACKING_SETTING, true)) return;

        const state = combatSkillState();
        if (!state?.skills.length) return;

        inCombat = true;
        resetSession(state.skills);
    } catch (error) {
        console.error('[CombatLevel] Starting the session with combat failed:', error);
    }
}

/**
 * Combat is over, so the next battle is a new session.
 *
 * The figures are left standing rather than cleared: the tile and the panel are
 * read *after* a run as often as during one, and the clock going on ticking
 * through the idle afterwards is the behaviour this panel has always had.
 */
function combatEnded() {
    inCombat = false;
}

/**
 * Listen for combat, from module scope.
 *
 * At module scope because this file has no feature entry to be initialised from
 * — it is imported for its panel and its two overlay rows — and because a
 * tracker that only runs while something else is open is the thing being fixed.
 * Subscribing costs a map entry; the handlers do nothing until a battle arrives.
 */
function watchCombat() {
    // `new_battle` is the signal the rest of the combat features start on, and
    // `battle_unit_fetched` is the one they treat as leaving combat
    webSocketHook.on('new_battle', combatStarted);
    webSocketHook.on('battle_unit_fetched', combatEnded);
}
watchCombat();

/**
 * The current character's combat skills, levels and measured rates.
 *
 * Exported because it is the join between the game's data and the arithmetic,
 * and a disagreement between the panel and the game would be here rather than
 * in the formula.
 *
 * @returns {{levels: Object, skills: Array<Object>, table: number[], totalPerHour: number}|null}
 */
export function combatSkillState() {
    const all = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!all || !table) return null;

    const levels = {};
    const skills = [];
    let totalPerHour = 0;

    for (const name of COMBAT_SKILLS) {
        const hrid = `/skills/${name}`;
        const skill = all.find((entry) => entry.skillHrid === hrid);
        if (!skill) continue;

        levels[name] = skill.level;

        const perHour = history.rateFor(hrid);
        if (perHour) totalPerHour += perHour;

        skills.push({
            name,
            hrid,
            level: skill.level,
            experience: skill.experience,
            perHour,
            fraction: levelFraction(skill.experience, skill.level, table),
            remaining: Math.max(0, (table[skill.level + 1] ?? skill.experience) - skill.experience),
            atCap: table[skill.level + 1] === undefined,
        });
    }

    // Share of the run's experience, which is what makes "what if I trained
    // something else" answerable — the split is a property of the setup, not of
    // the skills that happen to be receiving it
    for (const skill of skills) skill.share = totalPerHour > 0 ? (skill.perHour || 0) / totalPerHour : 0;

    return { levels, skills, table, totalPerHour };
}

/**
 * What the Target Selector is pointed at, and where the shares are assigned.
 *
 * At module scope rather than on the panel because the Time to Level overlay row
 * reads them, and that row is on screen while the panel is closed — which is
 * most of the time. State that only exists while a panel is open cannot drive
 * something that outlives the panel.
 *
 * Persisted, because a tile is a thing you set once and then read for a week. A
 * choice that resets on every page load is a choice you stop making.
 */
const selection = { skill: null, level: null, primary: null, focus: null };
const SELECTION_KEY = 'combatLevelSelection';

/**
 * What the Target Selector holds when it is pointed at the combat level itself.
 *
 * Not a skill, and deliberately not spelled like one: combat level has no
 * experience of its own, so anything that treats it as a skill and looks it up
 * in the table gets nothing rather than something wrong.
 */
const COMBAT_TARGET = 'combat';

/**
 * Load this character's selection, replacing whatever character's was held.
 *
 * Scoped per character: a target is a choice about one character's skills, and
 * under the old bare key a Melee target picked on the combat main followed the
 * account onto every alt, pinning their Time to Level tiles to a skill gaining
 * nothing. `migrate: 'discard'` drops any legacy bare-key value rather than
 * adopting it, for the same reason — inheriting another character's target IS
 * the leak being fixed.
 *
 * Fire and forget: the panel opens on today's defaults and settles a moment
 * later, which is the same trade `restoreGeometry` makes for the same reason.
 */
async function reloadSelection() {
    clearSelection();
    try {
        await storage.ready;
        const saved = await readScoped(SELECTION_KEY, 'settings', null, { migrate: 'discard' });
        if (saved) Object.assign(selection, saved);
    } catch (error) {
        console.error('[CombatLevel] Reading the target selection failed:', error);
    }
}

// Once the character is known (a module-scope read would key on 'default'),
// and again on every switch so one character's target never outlives them
dataManager.on('character_initialized', reloadSelection);
dataManager.on('character_switched', reloadSelection);

/**
 * What the Target Selector and the share assignment are set to.
 * @returns {{skill: string|null, level: number|null, primary: string|null, focus: string|null}}
 */
export function currentSelection() {
    return { ...selection };
}

/**
 * Change part of the selection, and remember it.
 * @param {Object} change - Any of `skill`, `level`, `primary`, `focus`
 */
export function select(change) {
    Object.assign(selection, change);
    writeScoped(SELECTION_KEY, { ...selection }, 'settings').catch((error) =>
        console.error('[CombatLevel] Saving the target failed:', error)
    );
}

/** Forget the selection, so the defaults apply again. Exported for tests. */
export function clearSelection() {
    Object.assign(selection, { skill: null, level: null, primary: null, focus: null });
}

/**
 * The chosen skill and target, resolved against the character.
 *
 * Returns null when nothing has been chosen, which is not the same as an error —
 * it means the Time to Level row should go on answering its own question rather
 * than this one.
 *
 * @returns {{name: string, hrid: string, level: number, target: number,
 *   perHour: number|undefined, seconds: number|null}|null}
 */
export function selectedTarget() {
    if (!selection.skill) return null;

    sample();
    return resolveTarget(combatSkillState(), selection.skill, selection.level);
}

/**
 * The answer for one choice of skill and level.
 *
 * Shared with the panel's own Target Selector, which asks the same question of
 * whatever is currently picked rather than of what has been committed — so the
 * two cannot give different answers to the same choice.
 *
 * @param {Object} state - From `combatSkillState`
 * @param {string} what - A combat skill name, or `COMBAT_TARGET`
 * @param {number|null} level - Target level, or null for the next one
 * @returns {{name: string, hrid: string, level: number, target: number,
 *   perHour: number|undefined, seconds: number|null}|null}
 */
export function resolveTarget(state, what, level) {
    if (!state?.skills.length) return null;

    // Combat level has no experience table of its own — it moves because the
    // skills underneath it do, at different rates and different weights — so it
    // is answered by running the clock forward rather than by dividing
    if (what === COMBAT_TARGET) {
        const now = combatProgress(state).partial.exact;
        const target = level ?? Math.floor(now) + 1;
        return {
            name: 'Combat',
            hrid: COMBAT_TARGET,
            level: Math.floor(now),
            target,
            perHour: state.totalPerHour || undefined,
            seconds: timeToCombatLevel({
                skills: state.skills,
                table: state.table,
                rates: projectedRates(state, selection).rates,
                target,
            }),
        };
    }

    const skill = state.skills.find((entry) => entry.name === what);
    if (!skill) return null;

    const target = level ?? skill.level + 1;
    const perHour = projectedRates(state, selection).rates[skill.name];

    return {
        name: skillName(skill.hrid),
        hrid: skill.hrid,
        level: skill.level,
        target,
        perHour,
        seconds: timeToTargetLevel({ experience: skill.experience, target, table: state.table, perHour }),
    };
}

/**
 * The skill gaining fastest, which is the one a selector should open on.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {Object|null} The skill, or null when nothing is measurably moving
 */
export function busiest(state) {
    let best = null;
    for (const skill of state?.skills || []) {
        if (skill.perHour && (!best || skill.perHour > best.perHour)) best = skill;
    }
    return best;
}

/**
 * What each skill would be gaining under a given assignment of the shares.
 *
 * The split between the two skills receiving experience is a property of the
 * setup rather than of those skills — swap which style you attack with and the
 * same proportions land somewhere else. So the shares are measured from whatever
 * is actually gaining, and where they are pointed is the caller's to say.
 *
 * Only the two assigned skills get a rate. That is the model, not an oversight:
 * under "what if I trained Defense instead", Melee would not be gaining either.
 *
 * @param {Object} state - From `combatSkillState`
 * @param {{primary: string|null, focus: string|null}} [assigned] - Where to point them
 * @returns {{rates: Object<string, number>, primary: string|null, focus: string|null,
 *   measuredPrimary: Object|null, measuredFocus: Object|null}}
 */
export function projectedRates(state, assigned = {}) {
    const gaining = (state?.skills || []).filter((skill) => skill.perHour).sort((a, b) => b.perHour - a.perHour);

    const measuredFocus = gaining.find((skill) => OFFENSE_SKILLS.includes(skill.name)) || gaining[0] || null;
    const measuredPrimary = gaining.find((skill) => skill !== measuredFocus) || null;

    const focus = assigned.focus ?? measuredFocus?.name ?? null;
    const primary = assigned.primary ?? measuredPrimary?.name ?? null;

    const rates = {};
    // Added rather than assigned, so pointing both shares at one skill gives it
    // both rather than silently dropping the first
    if (measuredPrimary && primary) rates[primary] = (rates[primary] || 0) + measuredPrimary.perHour;
    if (measuredFocus && focus) rates[focus] = (rates[focus] || 0) + measuredFocus.perHour;

    return { rates, primary, focus, measuredPrimary, measuredFocus };
}

/**
 * Start or restart the session against the current readings.
 * @param {Array<Object>} skills - From `combatSkillState`
 */
export function resetSession(skills) {
    session = beginSession(
        skills.map((skill) => ({ hrid: skill.hrid, experience: skill.experience })),
        Date.now()
    );
}

/**
 * The session so far, starting one if there is not one yet.
 *
 * A session whose baseline is above the current readings belongs to a different
 * character, so it is replaced rather than reported as a loss.
 *
 * @param {Array<Object>} skills - From `combatSkillState`
 * @returns {Object} From `sessionProgress`, plus when it started
 */
function sessionFor(skills) {
    const readings = skills.map((skill) => ({ hrid: skill.hrid, experience: skill.experience }));
    if (!session || sessionIsStale(session, readings)) resetSession(skills);

    return { ...sessionProgress(session, readings, Date.now()), startedAt: session.startedAt };
}

/**
 * The combat level as a continuous figure, from part-finished levels.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {{whole: Object, partial: Object}} The formula run on whole and on fractional levels
 */
export function combatProgress(state) {
    return {
        whole: combatLevel(state.levels),
        partial: combatLevel(fractionalLevels(state.skills, state.table)),
    };
}

/**
 * How long the next combat level is away, by the shortest route.
 *
 * The route is a number of levels of one skill; the time is what those levels
 * cost at the rate that skill is actually gaining. Both parts have to come from
 * the same skill or the answer is a mixture of two plans.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {{skill: string, levels: number, seconds: number|null}|null}
 */
export function nextCombatLevel(state) {
    const route = cheapestRouteToNextCombat(state.levels);
    if (!route) return null;

    const skill = state.skills.find((entry) => entry.name === route.skill);
    if (!skill) return { ...route, seconds: null };

    return {
        ...route,
        seconds: timeToTargetLevel({
            experience: skill.experience,
            target: skill.level + route.levels,
            table: state.table,
            perHour: skill.perHour,
        }),
    };
}

class CombatLevelPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        /** Per skill, the level being aimed at; blank means the next one */
        this.targets = {};
        /** The two ends of the experience lookup */
        this.lookup = { from: null, to: null };
        /** Sections folded away */
        this.collapsed = {};
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        // Held but no longer in the document — torn down rather than abandoned,
        // or its refresh timer and its listeners would still be running and each
        // reopen would leave another set behind
        if (this.panel) this._remove();
        this._create();
        // A new panel opens at the base z-index, which is *underneath* every
        // panel raised since the page loaded — so the panel you just asked for
        // appears behind the ones you did not
        bringPanelToFront(this.panel);
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '90px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height),
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

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 420,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 420, height: 240 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header: this.headerEl,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: this.headerEl.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            // Sampled here as well as in `_render`, and before the fold guard:
            // the exp/hr figures are a rate measured between readings, so a
            // panel folded away for ten minutes would come back with a hole in
            // its history and a rate starting from nothing. `sample` is rate
            // limited to one reading per SAMPLE_MS, so the reading `_render`
            // takes a line later on an expanded panel is the same one.
            sample();
            // Nobody can see a folded panel, and rebuilding its body every five
            // seconds for the rest of the session buys nothing — expanding
            // re-renders on the way out
            if (this.minimizeCtl?.collapsed) return;
            this._refresh();
        }, REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Combat Level';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The two figures worth having on the title bar when the rest is scrolled
        // away: what the run is earning, and when the next level lands
        this.headerRate = document.createElement('span');
        this.headerRate.style.color = ROW_COLORS.good;

        this.headerNext = document.createElement('span');
        this.headerNext.style.color = COLORS.combat;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

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

        header.append(title, this.headerRate, this.headerNext, spacer, close);
        return header;
    }

    /**
     * The five-second redraw.
     *
     * This is the one that must not pull the rug from under a field: rebuilding
     * the body under a box being typed into takes the caret with it, and under
     * an open dropdown closes it.
     *
     * A redraw the user asked for is a different thing, and must always happen —
     * guarding both is what made changing a dropdown appear to do nothing. The
     * `change` event fires while the dropdown still has focus, so the redraw it
     * asked for was skipped, and the new figures only turned up whenever focus
     * next moved and the clock came round.
     */
    _refresh() {
        const active = document.activeElement;
        if (this.panel?.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
        this._render();
    }

    _render() {
        if (!this.bodyEl) return;

        // The control being used, so it can be handed its focus back after the
        // rebuild that its own change asked for
        const focused = document.activeElement?.dataset?.control;

        sample();

        const state = combatSkillState();
        this.bodyEl.replaceChildren();

        if (!state?.skills.length) {
            this.headerRate.textContent = '';
            this.headerNext.textContent = '';
            this.bodyEl.appendChild(this._note('No combat skills loaded yet.'));
            return;
        }

        const next = nextCombatLevel(state);
        this.headerRate.textContent = state.totalPerHour
            ? `${formatWithSeparator(Math.round(state.totalPerHour))} exp/hr`
            : '';
        this.headerNext.textContent =
            next && next.seconds !== null
                ? `Combat ${combatLevel(state.levels).level + 1}: ${shortDuration(next.seconds)}`
                : '';

        // Computed once and handed down, so the Target Selector and the table
        // cannot disagree about what a skill would be gaining
        const projected = projectedRates(state, selection);

        const sections = [
            () => this._sessionBar(state),
            () => this._targetSelector(state),
            () => this._combatBlock(state, next),
            ...state.skills.filter((entry) => entry.perHour).map((skill) => () => this._skillBlock(skill, state)),
            () => this._timeToLevel(state, projected),
            () => this._charms(state),
            () => this._expLookup(state),
        ];
        for (const build of sections) this._section(build);

        if (focused) this.bodyEl.querySelector(`[data-control="${focused}"]`)?.focus();
    }

    /**
     * Draw one section, or say which one could not be drawn.
     *
     * Without this the panel is all-or-nothing: one section that throws takes
     * every section after it with it, and what you see is a panel that stops
     * halfway with nothing to say why. Half a panel looks like a missing feature
     * rather than a bug, which is exactly the wrong thing for it to look like.
     *
     * @param {Function} build - Returns the section's element
     */
    _section(build) {
        try {
            this.bodyEl.appendChild(build());
        } catch (error) {
            console.error('[CombatLevel] A section could not be drawn:', error);
            const failed = this._note(`This section could not be drawn: ${error.message}`);
            failed.style.color = ROW_COLORS.bad;
            this.bodyEl.appendChild(failed);
        }
    }

    /**
     * When the session started, how long it has run, and what it earned.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _sessionBar(state) {
        const card = this._card();
        Object.assign(card.style, { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' });

        const progress = sessionFor(state.skills);
        const started = new Date(progress.startedAt);

        const start = this._value(
            started.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        );
        start.title =
            'The session starts when combat does, not when this panel opens — so these figures are the run’s ' +
            'rather than the panel’s.';

        card.append(
            this._label('Start:'),
            start,
            this._label('Duration:'),
            this._value(timeReadable(Math.round(progress.seconds))),
            this._label('Exp:'),
            this._value(formatWithSeparator(Math.round(progress.total)), ROW_COLORS.gold),
            this._label('Exp/Hr:'),
            // Nothing rather than a made-up figure for the first twenty seconds,
            // so the panel is not briefly claiming millions an hour on opening
            this._value(
                progress.perHour === null ? 'measuring…' : `${formatWithSeparator(Math.round(progress.perHour))}/hr`,
                progress.perHour === null ? COLORS.textDim : ROW_COLORS.good
            )
        );

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const reset = this._button('Reset', () => {
            resetSession(state.skills);
            this._render();
        });
        reset.title = 'Start the clock and the totals again from right now.';

        card.append(spacer, reset);
        return card;
    }

    /**
     * Any skill, any level, how long.
     *
     * The rates it uses come from `resolveTarget`, which reads the same
     * projection the table below does — so the two cannot disagree about what a
     * skill would be gaining.
     *
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _targetSelector(state) {
        const card = this._card('Target Selector');
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        const chosen = selection.skill ?? busiest(state)?.name ?? state.skills[0].name;
        const answering = resolveTarget(state, chosen, selection.level) || { target: 1, seconds: null };
        const target = answering.target;

        // The only selector that offers Combat: Primary and Focus are shares of
        // experience, and combat level does not receive experience
        const picker = this._select(
            state,
            chosen,
            'ttl-skill',
            (value) => {
                // The level was for the old skill, so it is not carried across —
                // "level 135" means something different for a skill at 106
                select({ skill: value, level: null });
                this._render();
            },
            true
        );
        picker.style.width = '128px';

        const level = this._number(target, 'ttl-level', (value) => {
            select({ skill: chosen, level: value });
            this._render();
        });
        level.style.width = '68px';

        const seconds = answering.seconds;
        const answer = this._value(seconds === null ? '—' : shortDuration(seconds), COLORS.accent);
        answer.title =
            chosen === COMBAT_TARGET
                ? 'Combat level has no experience table of its own — this runs the clock forward at the rates ' +
                  'below and asks the formula when it crosses.'
                : answering.perHour
                  ? `At ${formatWithSeparator(Math.round(answering.perHour))} exp/hr.`
                  : 'Nothing is pointed at this skill, so there is no honest time to give. Assign it a share under Time to Level.';

        line.append(picker, level, answer);
        card.appendChild(line);
        return card;
    }

    /**
     * The combat level, the formula, and how far through the next one you are.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {Object|null} next - From `nextCombatLevel`
     * @returns {HTMLElement}
     */
    _combatBlock(state, next) {
        const card = this._card();
        const { whole, partial } = combatProgress(state);

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '10px' });

        const level = document.createElement('span');
        level.textContent = String(whole.level);
        Object.assign(level.style, { fontSize: '22px', fontWeight: 'bold', color: COLORS.combat });

        const heading = document.createElement('span');
        heading.textContent = 'Combat';
        heading.style.fontWeight = 'bold';

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const eta = this._value(next?.seconds != null ? shortDuration(next.seconds) : '—', COLORS.accent);
        eta.title = next
            ? `${next.levels} level(s) of ${skillName(next.skill)} at the rate it is currently gaining.`
            : 'No route measured yet.';

        top.append(level, heading, spacer, eta);
        card.appendChild(top);

        // The terms coloured by the skill each one is, so the repeated one is
        // visible rather than inferred
        card.appendChild(this._formula(state, whole));
        card.appendChild(this._combatBar(whole.progress, partial.progress, partial.doubled));

        const note = document.createElement('div');
        note.style.color = COLORS.textDim;
        if (next) {
            note.append(
                document.createTextNode(`${next.levels} level${next.levels === 1 ? '' : 's'} of `),
                this._value(skillName(next.skill), SKILL_COLORS[next.skill]),
                document.createTextNode(' needed to level Combat')
            );
        } else {
            note.textContent = 'No single skill reaches the next combat level within the search.';
        }
        card.appendChild(note);
        return card;
    }

    /**
     * The formula, spelled out and coloured.
     *
     * The doubled term is its own skill's level rather than the last term of the
     * sum: the sum takes the best of the three offensive skills and the doubled
     * term the best of five, and they part company whenever Attack or Defense
     * leads.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {Object} whole - `combatLevel` on whole levels
     * @returns {HTMLElement}
     */
    _formula(state, whole) {
        const line = document.createElement('div');
        Object.assign(line.style, {
            fontFamily: 'monospace',
            fontSize: '13px',
            margin: '4px 0',
            whiteSpace: 'nowrap',
            overflowX: 'auto',
        });

        const named = ['stamina', 'intelligence', 'attack', 'defense'];
        line.append(this._value('0.1×(', COLORS.textDim));

        named.forEach((skill, index) => {
            if (index) line.append(this._value('+', COLORS.textDim));
            line.append(this._value(String(state.levels[skill] ?? 0), SKILL_COLORS[skill]));
        });
        line.append(
            this._value('+', COLORS.textDim),
            this._value(String(whole.terms[4]), SKILL_COLORS[whole.best]),
            this._value(')+0.5×', COLORS.textDim),
            this._value(String(whole.doubledLevel), SKILL_COLORS[whole.doubled]),
            this._value('=', COLORS.textDim),
            this._value(whole.exact.toFixed(3), COLORS.combat)
        );

        line.title =
            `The sum takes the highest of Melee, Ranged and Magic (${skillName(whole.best)}); ` +
            `the doubled term takes the highest of those three plus Attack and Defense (${skillName(whole.doubled)}).`;
        return line;
    }

    /**
     * The two-tone segmented bar.
     *
     * @param {number} banked - Progress from whole levels alone
     * @param {number} earned - Progress including the level in progress
     * @param {string} doubled - The skill carrying the doubled term
     * @returns {HTMLElement}
     */
    _combatBar(banked, earned, doubled) {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 5px' });

        const track = document.createElement('div');
        Object.assign(track.style, {
            position: 'relative',
            flex: '1',
            height: '12px',
            background: COLORS.track,
            borderRadius: '3px',
            overflow: 'hidden',
        });

        // Drawn as one fill under another rather than two side by side, so a
        // rounding disagreement between them cannot leave a seam
        const partial = document.createElement('div');
        Object.assign(partial.style, {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${(Math.min(1, earned) * 100).toFixed(2)}%`,
            background: SKILL_COLORS[doubled] || COLORS.accent,
        });
        const whole = document.createElement('div');
        Object.assign(whole.style, {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${(Math.min(1, banked) * 100).toFixed(2)}%`,
            background: COLORS.combat,
        });

        // Ten notches, which is what makes a bar readable as a fraction without
        // reading the number beside it
        const notches = document.createElement('div');
        Object.assign(notches.style, {
            position: 'absolute',
            inset: '0',
            display: 'grid',
            gridTemplateColumns: `repeat(${BAR_SEGMENTS}, 1fr)`,
        });
        for (let index = 1; index < BAR_SEGMENTS; index++) {
            const notch = document.createElement('div');
            notch.style.borderRight = `1px solid ${COLORS.background}`;
            notches.appendChild(notch);
        }

        track.append(partial, whole, notches);

        const percent = this._value(`${(earned * 100).toFixed(1)}%`, COLORS.combat);
        percent.style.fontWeight = 'bold';
        percent.title =
            `${(banked * 100).toFixed(1)}% from levels already finished, and the rest from the ` +
            `${skillName(doubled)} level in progress.`;

        wrap.append(track, percent);
        return wrap;
    }

    /**
     * One skill that is actually gaining: level, remaining, rate, share, bar.
     *
     * @param {Object} skill - From `combatSkillState`
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _skillBlock(skill, state) {
        const card = this._card();
        const color = SKILL_COLORS[skill.name];

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '8px' });

        const level = document.createElement('span');
        level.textContent = String(skill.level);
        Object.assign(level.style, { fontSize: '18px', fontWeight: 'bold', color });

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        name.style.fontWeight = 'bold';

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const remaining = this._value(
            skill.atCap ? 'At the cap' : `Remaining: ${formatWithSeparator(Math.round(skill.remaining))}`,
            ROW_COLORS.good
        );

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target: skill.level + 1,
            table: state.table,
            perHour: skill.perHour,
        });
        const eta = this._value(seconds === null ? '—' : shortDuration(seconds), COLORS.accent);

        top.append(level, name, spacer, remaining, eta);
        card.appendChild(top);

        const bar = document.createElement('div');
        Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 3px' });

        const track = document.createElement('div');
        Object.assign(track.style, {
            flex: '1',
            height: '10px',
            background: COLORS.track,
            borderRadius: '3px',
            overflow: 'hidden',
        });
        const fill = document.createElement('div');
        Object.assign(fill.style, {
            height: '100%',
            width: `${(skill.fraction * 100).toFixed(2)}%`,
            background: color,
        });
        track.appendChild(fill);

        const percent = this._value(`${(skill.fraction * 100).toFixed(1)}%`, color);
        percent.style.fontWeight = 'bold';

        bar.append(track, percent);
        card.appendChild(bar);

        const progress = sessionFor(state.skills);
        const earned = progress.bySkill.find((entry) => entry.hrid === skill.hrid)?.gained ?? 0;

        const footer = document.createElement('div');
        footer.style.color = COLORS.textDim;
        footer.textContent =
            `${formatWithSeparator(Math.round(skill.perHour))}/hr (${(skill.share * 100).toFixed(1)}%)` +
            `  ·  ${formatWithSeparator(Math.round(earned))} exp this session`;
        card.appendChild(footer);

        return card;
    }

    /**
     * What every skill would take, and what it would take if you trained
     * something else instead.
     *
     * The split between the two skills receiving experience is a property of the
     * setup rather than of those skills — swap which style you attack with and
     * the same proportions land somewhere else. So the shares are measured and
     * the skills they apply to are yours to reassign, which answers "how long
     * would Ranged take" without spending a day finding out.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {Object} projected - From `projectedRates`
     * @returns {HTMLElement}
     */
    _timeToLevel(state, projected) {
        const card = this._card();
        card.appendChild(this._foldHeading('Time to Level', 'ttl'));
        if (this.collapsed.ttl) return card;

        const { measuredPrimary, measuredFocus, primary, focus } = projected;

        if (!measuredPrimary && !measuredFocus) {
            card.appendChild(this._note('Nothing measurable yet — the split appears once experience is coming in.'));
        } else {
            card.appendChild(
                this._assignment('Primary', primary, measuredPrimary, state, 'assign-primary', (value) => {
                    select({ primary: value });
                    this._render();
                })
            );
            card.appendChild(
                this._assignment('Focus', focus, measuredFocus, state, 'assign-focus', (value) => {
                    select({ focus: value });
                    this._render();
                })
            );
        }

        const heading = this._tableRow();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.hairline}`;
        heading.style.padding = '4px 0 3px';
        for (const text of ['Skill', 'Current', 'Exp/Hr', 'To Combat', 'Target', 'Time']) {
            const cell = document.createElement('span');
            cell.textContent = text;
            if (text !== 'Skill') cell.style.textAlign = 'right';
            heading.appendChild(cell);
        }
        card.appendChild(heading);

        const doubled = combatLevel(state.levels).doubled;
        for (const skill of state.skills)
            card.appendChild(this._skillRow(skill, state, doubled, projected.rates[skill.name]));
        return card;
    }

    /**
     * One of the two reassignable shares.
     *
     * @param {string} label - "Primary" or "Focus"
     * @param {string|null} chosen - Which skill it is pointed at
     * @param {Object|null} measured - The skill the share was measured from
     * @param {Object} state - From `combatSkillState`
     * @param {string} control - Stable id, so focus survives the redraw
     * @param {Function} onChange - Called with the new skill name
     * @returns {HTMLElement}
     */
    _assignment(label, chosen, measured, state, control, onChange) {
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 0' });

        const name = this._label(`${label}:`);
        name.style.minWidth = '52px';

        const detail = document.createElement('span');
        if (measured) {
            detail.append(
                this._value(`${(measured.share * 100).toFixed(1)}%`, ROW_COLORS.gold),
                document.createTextNode(' '),
                this._value(`(${formatWithSeparator(Math.round(measured.perHour))} exp/hr)`, COLORS.textDim)
            );
        } else {
            detail.append(this._value('not measured', COLORS.textDim));
        }

        const picker = this._select(state, chosen, control, onChange);
        picker.style.width = '128px';
        picker.title = `Apply this share to a different skill to see what training it instead would take.`;

        line.append(name, detail, picker);
        return line;
    }

    /**
     * @param {Object} skill - One combat skill
     * @param {Object} state - From `combatSkillState`
     * @param {string} doubled - The skill carrying the doubled term
     * @param {number|undefined} projected - The rate under the current assignment
     * @returns {HTMLElement}
     */
    _skillRow(skill, state, doubled, projected) {
        const line = this._tableRow();
        line.style.padding = '2px 0';

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        name.style.color = SKILL_COLORS[skill.name];
        // The doubled skill is the one every plan turns on, so it reads as such
        if (skill.name === doubled) {
            name.style.fontWeight = 'bold';
            name.title = 'Carries the doubled term, so a level of it is worth six of anything else.';
        }

        const level = this._cell(String(skill.level));
        const rate = this._cell(projected ? formatWithSeparator(Math.round(projected)) : '—');
        rate.style.color = projected ? ROW_COLORS.good : COLORS.textDim;
        if (projected && projected !== skill.perHour) {
            rate.style.fontStyle = 'italic';
            rate.title = 'Projected from the measured share, not measured on this skill.';
        }

        // What a level of this is worth, and how many of them are needed
        const needed = levelsToNextCombat(state.levels, skill.name);
        const worth = combatValueOf(state.levels, skill.name);
        const toCombat = this._cell(needed === null ? '—' : `${needed} × ${worth.toFixed(1)}`);
        toCombat.style.color = needed === null ? COLORS.textDim : ROW_COLORS.gold;
        toCombat.title =
            needed === null
                ? 'More levels than the search looks ahead, so no honest number to give.'
                : `Each level is worth ${worth.toFixed(1)} combat levels right now.`;

        const target = this.targets[skill.name] ?? skill.level + 1;
        const targetInput = this._number(target, `target-${skill.name}`, (value) => {
            this.targets[skill.name] = value;
            this._render();
        });

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target,
            table: state.table,
            perHour: projected,
        });
        const time = this._cell(seconds === null ? '—' : shortDuration(seconds));
        time.style.color = seconds === null ? COLORS.textDim : COLORS.accent;

        const owed = experienceBetween(skill.level, target, state.table);
        time.title =
            owed === null
                ? 'That level is not on the game’s experience table.'
                : `${formatWithSeparator(owed)} experience from level ${skill.level} to ${target}.`;

        line.append(name, level, rate, toCombat, targetInput, time);
        return line;
    }

    /**
     * The skills not gaining, and what is multiplying the ones that are.
     *
     * The compact half is GWhiz's: a skill with no rate has nothing to say about
     * time, so it gets a tile with its level and how far into it rather than a
     * row of dashes. The wisdom and charm figures beneath come from Toolasha's
     * own experience parser, so they agree with the action panels.
     *
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _charms(state) {
        const card = this._card();
        card.appendChild(this._foldHeading('Charms & Idle Skills', 'charms'));
        if (this.collapsed.charms) return card;

        const idle = state.skills.filter((skill) => !skill.perHour);
        if (idle.length) {
            const grid = document.createElement('div');
            Object.assign(grid.style, {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: '5px',
                margin: '2px 0 6px',
            });

            for (const skill of idle) {
                const tile = document.createElement('div');
                Object.assign(tile.style, {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '6px',
                    background: COLORS.track,
                    borderRadius: '4px',
                    padding: '3px 7px',
                });

                const level = this._value(String(skill.level), SKILL_COLORS[skill.name]);
                level.style.fontWeight = 'bold';

                const name = document.createElement('span');
                name.textContent = skillName(skill.hrid);
                name.style.flex = '1';

                const percent = this._value(`${Math.round(skill.fraction * 100)}%`, ROW_COLORS.good);
                percent.title = 'How far into this level it already is.';

                tile.append(level, name, percent);
                grid.appendChild(tile);
            }
            card.appendChild(grid);
        }

        let wisdom = null;
        const charmed = [];
        for (const skill of state.skills) {
            let result = null;
            try {
                result = calculateExperienceMultiplier(skill.hrid, COMBAT_ACTION_TYPE);
            } catch (error) {
                console.error('[CombatLevel] Could not read the experience multiplier:', error);
                continue;
            }
            if (wisdom === null) wisdom = result.totalWisdom;
            if (result.charmExperience > 0) charmed.push({ skill, result });
        }

        if (wisdom === null) {
            card.appendChild(this._note('Nothing loaded to read bonuses from yet.'));
            return card;
        }

        const summary = document.createElement('div');
        summary.append(
            this._label('Wisdom'),
            document.createTextNode(' '),
            this._value(`${wisdom.toFixed(2)}%`, ROW_COLORS.good),
            document.createTextNode(' on every combat skill')
        );
        summary.title = 'Wisdom and charm experience add together before multiplying, rather than compounding.';
        card.appendChild(summary);

        if (!charmed.length) {
            card.appendChild(this._note('No charm is boosting a combat skill.'));
            return card;
        }

        for (const { skill, result } of charmed) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', gap: '8px', padding: '1px 0' });

            const name = this._value(skillName(skill.hrid), SKILL_COLORS[skill.name]);
            name.style.minWidth = '86px';

            const source = document.createElement('span');
            Object.assign(source.style, {
                color: COLORS.textDim,
                flex: '1',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            });
            source.textContent = result.charmBreakdown.map((entry) => entry.name).join(', ');

            line.append(
                name,
                this._value(`+${result.charmExperience.toFixed(2)}%`, COLORS.accent),
                source,
                this._value(`×${result.totalMultiplier.toFixed(3)}`, ROW_COLORS.gold)
            );
            card.appendChild(line);
        }
        return card;
    }

    /**
     * Experience between any two levels, which the game never shows.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _expLookup(state) {
        const card = this._card();
        card.appendChild(this._foldHeading('Exp Lookup', 'lookup'));
        if (this.collapsed.lookup) return card;

        const from = this.lookup.from ?? 1;
        const to = this.lookup.to ?? Math.min(from + 99, state.table.length - 1);

        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        const fromInput = this._number(from, 'lookup-from', (value) => {
            this.lookup.from = value;
            this._render();
        });
        fromInput.style.width = '72px';

        const toInput = this._number(to, 'lookup-to', (value) => {
            this.lookup.to = value;
            this._render();
        });
        toInput.style.width = '72px';

        line.append(fromInput, this._label('→'), toInput);
        card.appendChild(line);

        // The subtraction rather than only its result, because the thresholds
        // are the answer to the next question you were going to ask
        const answer = document.createElement('div');
        answer.style.marginTop = '3px';
        const owed = experienceBetween(from, to, state.table);
        if (owed === null) {
            answer.append(this._value('One of those levels is not on the game’s table.', COLORS.textDim));
        } else {
            answer.append(
                this._value(formatWithSeparator(state.table[to]), ROW_COLORS.good),
                this._label(' − '),
                this._value(formatWithSeparator(state.table[from]), ROW_COLORS.good),
                this._label(' = '),
                this._value(`${formatWithSeparator(owed)} exp`, ROW_COLORS.gold)
            );
        }
        card.appendChild(answer);
        return card;
    }

    /**
     * A block, optionally titled, so the panel reads as cards rather than a list.
     * @param {string} [title] - Heading text
     * @returns {HTMLElement}
     */
    _card(title) {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });

        if (title) {
            const heading = document.createElement('div');
            heading.textContent = title;
            Object.assign(heading.style, { color: ROW_COLORS.good, fontWeight: 'bold', marginBottom: '4px' });
            card.appendChild(heading);
        }
        return card;
    }

    /**
     * A heading that folds its section away.
     * @param {string} title - Heading text
     * @param {string} key - Where the folded state is remembered
     * @returns {HTMLElement}
     */
    _foldHeading(title, key) {
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            color: ROW_COLORS.good,
            fontWeight: 'bold',
            cursor: 'pointer',
            userSelect: 'none',
            marginBottom: '4px',
        });
        heading.textContent = `${this.collapsed[key] ? '▶' : '▼'} ${title}`;
        heading.addEventListener('click', () => {
            this.collapsed[key] = !this.collapsed[key];
            this._render();
        });
        return heading;
    }

    /** The one grid every table line shares, so the columns line up */
    _tableRow() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 52px 76px 72px 62px 66px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    /**
     * @param {string} text - Cell contents
     * @returns {HTMLElement}
     */
    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    /**
     * @param {string} text - Label contents
     * @returns {HTMLElement}
     */
    _label(text) {
        const label = document.createElement('span');
        label.textContent = text;
        label.style.color = COLORS.textDim;
        return label;
    }

    /**
     * @param {string} text - Contents
     * @param {string} [color] - Ink
     * @returns {HTMLElement}
     */
    _value(text, color) {
        const value = document.createElement('span');
        value.textContent = text;
        if (color) value.style.color = color;
        value.style.whiteSpace = 'nowrap';
        return value;
    }

    /**
     * A combat-skill dropdown.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {string|null} chosen - Which is selected
     * @param {string} control - Stable id, so focus survives the redraw
     * @param {Function} onChange - Called with the new skill name
     * @param {boolean} [withCombat] - Offer the combat level as well as the skills
     * @returns {HTMLElement}
     */
    _select(state, chosen, control, onChange, withCombat = false) {
        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        select.dataset.control = control;
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 4px',
        });

        const entries = [
            ...state.skills.map((skill) => ({ value: skill.name, label: `${skillName(skill.hrid)} ${skill.level}` })),
        ];
        if (withCombat) {
            // First, because it is the question the panel is named after
            entries.unshift({
                value: COMBAT_TARGET,
                label: `Combat ${combatLevel(state.levels).level}`,
            });
        }

        for (const entry of entries) {
            const option = document.createElement('option');
            option.value = entry.value;
            option.textContent = entry.label;
            option.style.background = COLORS.background;
            if (entry.value === chosen) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener('change', () => onChange(select.value));
        select.addEventListener('keydown', (event) => event.stopPropagation());
        return select;
    }

    /**
     * A level box.
     *
     * Committed on change and on Enter rather than on every keystroke, because
     * re-rendering mid-type takes the caret away — and typing "120" through a
     * live render means being told about levels 1 and 12 on the way.
     *
     * @param {number} value - What it starts at
     * @param {string} control - Stable id, so focus survives the redraw
     * @param {Function} onCommit - Called with the new number
     * @returns {HTMLElement}
     */
    _number(value, control, onCommit) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = String(value);
        input.dataset.control = control;
        Object.assign(input.style, {
            width: '100%',
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 3px',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
        });

        const commit = () => {
            const parsed = Math.max(1, Math.round(Number(input.value)));
            if (!Number.isFinite(parsed)) return;
            onCommit(parsed);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                input.blur();
            }
            // The game listens for keys globally, and a level typed into a box
            // should not also be a hotkey
            event.stopPropagation();
        });
        return input;
    }

    /**
     * @param {string} text - Button label
     * @param {Function} onClick - What it does
     * @returns {HTMLElement}
     */
    _button(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.1)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 10px',
        });
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * @param {string} text - What there is to say
     * @returns {HTMLElement}
     */
    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const combatLevelPanel = new CombatLevelPanel();

// The panel reads one character's skills, so it cannot simply carry on into the
// next one. Torn down and rebuilt rather than left to redraw, because the levels
// it is aiming at and the two ends of its experience lookup are answers about
// the character that has just been left. Which sections are folded is not — that
// is how you like the panel laid out — so it stays. Reopened only if it was
// already up: a switch is not the user opening a panel, or closing one.
//
// `session` and `history` are module scope and unconditional here, unlike the
// panel rebuild below — they drive the always-visible overlay rows too, which
// keep sampling whether or not the panel is open. Both only self-correct when a
// reading goes *backwards* (`sessionIsStale`, and the per-skill reset inside
// `skill-history.js`), because that is the one case that cannot be a real gain.
// A switch from a character with less combat experience to one with more —
// an iron cow to the main, the ordinary direction for this account — goes the
// other way: nothing looks stale, so the old baseline is kept and the next
// render reports the *other* character's whole experience total as gained in
// this session, and a rate history spanning two characters as an impossible
// spike. Clearing both here is the same "different character, start again"
// rule `sessionIsStale` already states, applied to the one case its own check
// cannot see.
function clearSessionState() {
    session = null;
    inCombat = false;
    history.clear();
}

// Cleared again here, at `character_switching`, rather than only below at
// `character_switched`. `dataManager` sets `characterSkills` to the *arriving*
// character's data synchronously, before `character_switched` is emitted —
// but that event is deliberately deferred (see data-manager.js), so there is a
// real gap between the new skills becoming readable and this file's own
// listener running to clear the old session against them. The overlay's 1s
// redraw is on its own timer and can land in that gap, at which point
// `combatSkillState()` already reads the arriving character while `session`
// and `history` still hold the departing one's baseline — the forward-jump
// case the comment above describes, just arriving a tick earlier than
// `character_switched` does. Clearing here, while `characterSkills` still
// belongs to the departing character (this listener is awaited before
// dataManager clears it), closes that gap without changing anything about the
// panel rebuild below, which still waits for the arriving character's data.
dataManager.on('character_switching', clearSessionState);

dataManager.on('character_switched', () => {
    clearSessionState();

    // Before the panel guard, not after it. Both are levels one character was
    // aiming at, keyed by skill name — which every character shares — and the
    // early return below fires whenever the panel happens to be closed at the
    // moment of the switch. The arriving character then opened the panel on the
    // departing character's goals, with every "time to target" measured against
    // a level they never chose.
    combatLevelPanel.targets = {};
    combatLevelPanel.lookup = { from: null, to: null };

    if (!combatLevelPanel.panel) return;
    combatLevelPanel.hide();
    combatLevelPanel.show();
});

registerRow({
    key: 'combatLevel',
    empty: 'No combat data',
    name: 'Combat Level',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        sample();

        const state = combatSkillState();
        if (!state?.skills.length) return blank(container);

        const { whole, partial } = combatProgress(state);
        const next = nextCombatLevel(state);

        row(container, [
            { text: 'Combat', color: ROW_COLORS.dim },
            { text: String(whole.level), color: COLORS.combat, bold: true },
            { text: `${(partial.progress * 100).toFixed(1)}%`, color: ROW_COLORS.dim, push: true },
            next ? { text: `${next.levels}× ${skillName(next.skill)}`, color: ROW_COLORS.gold, ellipsis: true } : null,
        ]);
        container.title = next
            ? `${next.levels} level(s) of ${skillName(next.skill)} is the shortest route to Combat ${whole.level + 1}` +
              (next.seconds === null ? '.' : `, about ${shortDuration(next.seconds)} away.`)
            : `${(partial.progress * 100).toFixed(1)}% of the way to Combat ${whole.level + 1}.`;
    },
    onOpen: () => combatLevelPanel.toggle(),
});

registerRow({
    key: 'combatSession',
    empty: 'No session yet',
    name: 'Combat Session',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        sample();

        const state = combatSkillState();
        if (!state?.skills.length) return blank(container);

        const progress = sessionFor(state.skills);
        row(container, [
            { text: 'Session', color: ROW_COLORS.dim },
            { text: timeReadable(Math.round(progress.seconds)), color: ROW_COLORS.accent },
            { text: `${formatKMB(progress.total)} exp`, color: ROW_COLORS.gold, push: true },
            progress.perHour === null
                ? null
                : { text: `${formatKMB(progress.perHour)}/hr`, color: ROW_COLORS.good, ellipsis: true },
        ]);
        container.title = 'Combat experience since the session started. Reset it from the Combat Level panel.';
    },
    onOpen: () => combatLevelPanel.toggle(),
});
