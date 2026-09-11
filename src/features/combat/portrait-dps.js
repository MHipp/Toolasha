/**
 * Portrait DPS
 *
 * Each character's damage, drawn on their own portrait in the battle panel.
 *
 * The DPS tile already ranks the party, and a ranked list is the wrong shape for
 * the question people actually ask mid-fight, which is "is *that* one pulling
 * their weight" while looking straight at them. A figure on the portrait answers
 * it without a lookup between a name in a list and a face in a row.
 *
 * ## Matched by name, not by position
 *
 * The obvious join is index: the payload's player 0 is the leftmost portrait.
 * It is also the join that produced the bug this script has already had once —
 * a slot is a position in *this* fight, and the moment somebody leaves, every
 * index after them means a different person. The portraits carry their names in
 * the DOM, so the name is the join, and a portrait whose name is not in the
 * tally simply gets nothing rather than getting somebody else's damage.
 *
 * ## Attaching to a panel React owns
 *
 * The battle panel is rebuilt by the game whenever the fight changes, taking any
 * injected node with it. So the meters are re-attached on a `MutationObserver`
 * rather than created once, and each one is tagged with a `data-` attribute so a
 * rebuild that *did* keep them does not produce two.
 *
 * The class names carry a build hash — `CombatUnit_combatUnit__1p2q3` — which
 * changes with every game update, so every selector here is a prefix match. This
 * is the most fragile feature in the script for that reason: it reaches into the
 * game's own DOM rather than into the payload. It fails by drawing nothing.
 *
 * ## The guild trial's fight view draws nothing
 *
 * A spectated trial renders the *same* players/monsters areas and unit tiles
 * inside the Guild panel, with this fight's own tally nowhere in them — the
 * watcher's own name still joins onto the trial tile, and the monsters are
 * worse: joined by slot, so the trial's boss would wear whatever slot 0 of the
 * live fight was carrying. `_ownArea` skips a players or monsters area inside
 * the guild panel and removes any meter already in it, the same fence
 * `combat-unit-buff-bars.js`'s `isTrialArea` uses and for the same reason: it
 * is structural rather than a stream flag, so it needs no timeout coming back
 * out either.
 *
 * The idea is DPs', from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { isTrialArea } from './combat-unit-buff-bars.js';
import { damageBreakdown, battleBreakdown, manaSamples } from './damage-tracker.js';
import { takenBreakdown, battleTakenBreakdown } from './damage-taken-tracker.js';
import {
    timeToKillSeconds,
    timeToKillText,
    waveClearSeconds,
    waveClearText,
    manaRunwaySeconds,
    manaRunwayText,
    sustainLine,
    accuracyText,
    outgoingText,
    enrageSecondsLeft,
    enrageLine,
} from './combat-estimates.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';

/** Where the party's portraits live */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';
/** And where the things they are fighting live */
const MONSTERS_AREA = '[class*="BattlePanel_monstersArea"]';
/** One character's tile inside it */
const UNIT = '[class*="CombatUnit_combatUnit"]';
/** The name inside a tile, which is what a meter is matched on */
const UNIT_NAME = '[class*="CombatUnit_name"]';

/** Marks a meter as ours, so a rebuild cannot leave two */
const MARK = 'data-toolasha-portrait-dps';

/** Slow enough not to fight the game's own redraw, fast enough to feel live */
const REFRESH_MS = 1000;

/**
 * The name shown on a portrait.
 *
 * @param {HTMLElement} unit - A combat unit tile
 * @returns {string} Trimmed name, or '' when the tile has none
 */
export function portraitName(unit) {
    return unit?.querySelector(UNIT_NAME)?.textContent?.trim() || '';
}

/**
 * Pair each portrait with the tally row belonging to the character on it.
 *
 * Exported for its own sake: this is the whole of the logic worth testing, and
 * it is testable without a battle panel.
 *
 * @param {Array<HTMLElement>} units - Portrait tiles, in DOM order
 * @param {Array<Object>} players - From `damageBreakdown().players`
 * @returns {Array<{unit: HTMLElement, player: Object}>} Only the matches
 */
export function matchPortraits(units, players) {
    const byName = new Map();
    for (const player of players || []) {
        if (player?.name) byName.set(player.name, player);
    }

    const pairs = [];
    for (const unit of units || []) {
        const player = byName.get(portraitName(unit));
        // No match is no meter. The alternative — falling back to position —
        // is what puts one character's damage on another's face the moment
        // somebody leaves the party.
        if (player) pairs.push({ unit, player });
    }
    return pairs;
}

/**
 * What a meter says.
 *
 * DPS first because it is the comparable figure — total damage rewards whoever
 * has been in the fight longest, which in a party is everybody equally and after
 * a death is not.
 *
 * ## Every player gets the same lines
 *
 * A line one player has earned and another has not still renders on both — as
 * a figure on one and a dash on the other — because a line that comes and goes
 * per player gives five portraits five different heights. The `extras` flags
 * decide which lines exist at all, and they change for everybody at once.
 *
 * @param {Object} player - From `damageBreakdown().players`
 * @param {Object|null} [current] - This fight's row for them, from `battleBreakdown`
 * @param {Object|null} [extras] - Which optional lines to draw, and their inputs:
 *   `{showSustain, taken, showAccuracy, showMana, manaRunway}` — `taken` is
 *   their row from `takenBreakdown().players`, `manaRunway` from
 *   `manaRunwaySeconds`
 * @returns {{lines: Array<string|{text: string, color: string}>, title: string}}
 */
export function meterText(player, current = null, extras = null) {
    // Null until there is enough to divide by, which is a different thing from
    // zero and should not be drawn as one
    const rate = (value) => (value === null || value === undefined ? null : Math.round(value));

    // The rate in full and the damage abbreviated, as DPs draws it. They are read
    // differently: a rate is compared against another rate, where 1,052 against
    // 1.1K is the comparison, while a running total only has to convey a size.
    const line = (dps, damage, label) => {
        const shown = rate(dps);
        const figure = shown === null ? '—' : formatWithSeparator(shown);
        return `${figure} DPS ${formatLargeNumber(Math.round(damage || 0))} ${label}`;
    };

    // This fight above the run, as DPs has it. The order is the point: the fight
    // in front of you is the one you can still change, and the run is the
    // context you read it against.
    //
    // The cur line is always there, dashed when there is nothing to say yet.
    // It used to render only once a player had acted this fight, which gave
    // that player's tile a taller meter than their neighbours' — five portraits
    // at three different heights, shifting again at every fight boundary.
    const lines = [current ? line(current.dps, current.damage, 'cur') : '— cur'];
    lines.push(line(player.dps, player.damage, 'total'));

    let title =
        `${player.name}\n` +
        (current
            ? `This fight: ${formatLargeNumber(Math.round(current.damage || 0))} damage` +
              (rate(current.dps) === null
                  ? ', too early for a rate.'
                  : `, ${formatWithSeparator(rate(current.dps))}/s.`)
            : '') +
        `\nThis run: ${formatLargeNumber(Math.round(player.damage || 0))} damage` +
        (rate(player.dps) === null
            ? ', not yet long enough to give a rate.'
            : `, ${formatWithSeparator(rate(player.dps))}/s.`);

    if (extras?.showSustain) {
        const sustain = sustainLine(extras.taken);
        lines.push(
            sustain
                ? { text: sustain.text, color: sustain.negative ? ROW_COLORS.bad : ROW_COLORS.good }
                : { text: '— taken', color: ROW_COLORS.dim }
        );
        title += sustain
            ? '\nTaken and net sustain this run; a negative net is losing health.'
            : '\nNo incoming rate to show yet.';
    }

    if (extras?.showAccuracy) {
        const accuracy = accuracyText(player);
        lines.push(accuracy ? { text: accuracy, color: ROW_COLORS.neutral } : { text: '— hit', color: ROW_COLORS.dim });
        title += accuracy
            ? '\nHit and crit rate this run.'
            : '\nToo few swings this run for a hit rate to be a measurement.';
    }

    if (extras?.showMana) {
        const mana = manaRunwayText(extras.manaRunway);
        lines.push(mana ? { text: mana, color: ROW_COLORS.gold } : { text: '— mana', color: ROW_COLORS.dim });
        title += mana
            ? '\nMana is draining; this is the time until empty at the measured rate.'
            : '\nMana steady, rising, or not yet measured — no runway to warn about.';
    }

    return { lines, title };
}

/**
 * What a monster's tile says: how fast it is being taken down, and — line by
 * optional line — how long it has left, how long the wave has, what it is
 * doing to the party, and when it enrages.
 *
 * Per slot rather than per name, so two of the same monster side by side each
 * carry their own rate — averaging them would put a number on both tiles that
 * was true of neither.
 *
 * The same equal-lines rule as the players: an enabled line renders on every
 * enemy tile, dashed where its input is missing, so the tiles keep one height.
 *
 * @param {Object} enemy - From `battleBreakdown().enemies`
 * @param {Object|null} [extras] - Which optional lines to draw, and their
 *   inputs: `{showTimeToKill, showWaveClear, waveSeconds, showOutgoing,
 *   outgoingDps, showEnrage, now}`. `waveSeconds` is passed only for the tile
 *   the one wave figure lives on; the rest dash it.
 * @returns {{text: string, lines: Array<string|{text: string, color: string}>, title: string}}
 */
export function enemyMeterText(enemy, extras = null) {
    const dps = enemy.dps === null || enemy.dps === undefined ? null : Math.round(enemy.dps);

    const first = dps === null ? '—' : `${formatWithSeparator(dps)}/s`;
    const lines = [first];
    let title =
        `${enemy.name || 'This enemy'}: ${formatWithSeparator(Math.round(enemy.damage || 0))} damage dealt to ` +
        'it this fight' +
        (dps === null ? ', too early for a rate.' : `, ${formatWithSeparator(dps)} per second.`);

    if (extras?.showTimeToKill) {
        const ttk = timeToKillText(timeToKillSeconds(enemy.hp, enemy.dps));
        lines.push(ttk ? { text: ttk, color: ROW_COLORS.good } : { text: '— dead', color: ROW_COLORS.dim });
        title += ttk
            ? '\nRemaining health over the rate it is being hit at.'
            : '\nNo time to kill yet: its health or a rate on it is still unknown.';
    }

    if (extras?.showWaveClear) {
        const wave = waveClearText(extras.waveSeconds);
        lines.push(wave ? { text: wave, color: ROW_COLORS.good } : { text: '— wave', color: ROW_COLORS.dim });
        title += wave
            ? "\nThe whole wave's remaining health over the party's combined rate."
            : '\nThe wave figure lives on the topmost tile, and only once every health bar and a rate are known.';
    }

    if (extras?.showOutgoing) {
        const outgoing = outgoingText(extras.outgoingDps);
        lines.push(outgoing ? { text: outgoing, color: ROW_COLORS.bad } : { text: '— hits', color: ROW_COLORS.dim });
        title += outgoing
            ? '\nWhat it is doing to the party this fight.'
            : '\nNo attributable hit from it this fight yet.';
    }

    if (extras?.showEnrage) {
        const enrage = enrageLine(enrageSecondsLeft(enemy.enrageAt, extras.now ?? Date.now()));
        lines.push(
            enrage
                ? { text: enrage.text, color: enrage.warn ? ROW_COLORS.gold : ROW_COLORS.neutral }
                : { text: '— enrage', color: ROW_COLORS.dim }
        );
        title += enrage
            ? '\nCounting down to its enrage, from its own sheet.'
            : '\nIts sheet states no enrage timer this battle.';
    }

    return { text: first, lines, title };
}

/**
 * A cheap fingerprint of what the meters would be drawn from.
 *
 * Rates move with the clock, so they are left out on purpose: the interval
 * redraw keeps those ticking. This only has to tell "something landed or the
 * line-up changed" from "the panel mutated for a reason of its own", so the
 * frame-rate observer can skip the draws that would have written nothing.
 *
 * @param {Object} run - From `damageBreakdown`
 * @param {Object} fight - From `battleBreakdown`
 * @returns {string}
 */
export function drawSignature(run, fight) {
    let text = '';
    for (const player of run?.players || []) {
        text += `${player.name}:${player.damage}:${player.hits}:${player.misses};`;
    }
    text += '|';
    for (const [slot, entry] of Object.entries(fight?.players || {})) {
        text += `${slot}:${entry?.name}:${entry?.damage};`;
    }
    text += '|';
    for (const [slot, enemy] of Object.entries(fight?.enemies || {})) {
        text += `${slot}:${enemy?.name}:${enemy?.damage}:${enemy?.hp}:${enemy?.enrageAt};`;
    }
    return text;
}

class PortraitDps {
    constructor() {
        this.isInitialized = false;
        this.observer = null;
        this.panel = null;
        this.unregisterClass = null;
        this.unregisterReady = null;
        this.timers = createTimerRegistry();
        this._lastSignature = null;
        this._lastMeterCount = 0;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('portraitDps')) return;
        this.isInitialized = true;

        // Two triggers, and both are needed. The observer catches the panel
        // being rebuilt — which is when the meters are lost — and the timer
        // keeps the figures moving between rebuilds.
        //
        // The observer is scoped to the battle panel rather than the whole app,
        // so the rest of the page writing text (which other features do ten
        // times a second) does not ask for a redraw here. The panel comes and
        // goes with the fight, so the shared DOM observer re-acquires it each
        // time the players area is rendered.
        this.unregisterClass = domObserver.onClass('PortraitDps', 'BattlePanel_playersArea', () => this._attach());

        this.timers.registerInterval(
            setInterval(() => {
                if (document.hidden) return;
                // Through the signature diff, not straight to _draw: out of
                // combat the breakdowns stop changing, and this tick was the
                // one caller still rebuilding every meter once a second anyway
                this._drawIfChanged();
            }, REFRESH_MS),
            'portraitDps.tick'
        );
        // @run-at document-start: a battle panel rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('PortraitDpsCatchUp', () => {
            this._attach();
            this._draw();
        });
    }

    disable() {
        this.observer?.disconnect();
        this.observer = null;
        this.panel = null;
        this.unregisterClass?.();
        this.unregisterClass = null;
        this.unregisterReady?.();
        this.unregisterReady = null;
        this.timers.clearAll();
        if (this._drawScheduled) {
            cancelAnimationFrame(this._drawScheduled);
            this._drawScheduled = null;
        }
        for (const meter of document.querySelectorAll(`[${MARK}]`)) meter.remove();
        this._lastSignature = null;
        this._lastMeterCount = 0;
        this.isInitialized = false;
    }

    /** Watch the battle panel that currently holds the portraits, if any */
    _attach() {
        const area = this._ownArea(PLAYERS_AREA);
        if (!area) return;
        const panel = area.closest('[class*="BattlePanel_battlePanel"]') || area.parentElement || area;
        if (panel === this.panel && this.observer) return;

        this.observer?.disconnect();
        this.panel = panel;
        this.observer = new MutationObserver(() => this._scheduleDraw());
        this.observer.observe(panel, { childList: true, subtree: true });
        this._scheduleDraw();
    }

    /** At most one redraw per frame, however many mutations asked for it */
    _scheduleDraw() {
        if (this._drawScheduled) return;
        this._drawScheduled = requestAnimationFrame(() => {
            this._drawScheduled = null;
            this._drawIfChanged();
        });
    }

    /**
     * The observer's draw: skipped when nothing it would write has changed and
     * every meter from the last draw is still in place. The panel mutates at
     * frame rate in a fight (health bars, effects), and most of those frames
     * would have re-derived the same lines only to find them already there.
     */
    _drawIfChanged() {
        const run = damageBreakdown();
        const fight = battleBreakdown();
        const signature = drawSignature(run, fight);
        if (signature === this._lastSignature && this._metersIntact()) return;
        this._draw(run, fight);
    }

    /**
     * Whether every meter drawn last time is still in the panel. Nothing drawn
     * yet never counts as intact: tiles may have just appeared for a tally
     * that has not changed, and those want their meters now, not next tick.
     */
    _metersIntact() {
        if (this._lastMeterCount === 0) return false;
        const panel = this.panel?.isConnected ? this.panel : document;
        return panel.querySelectorAll(`[${MARK}]`).length === this._lastMeterCount;
    }

    /** Which of the optional lines are on, read fresh so a toggle takes hold next draw */
    _settings() {
        return {
            timeToKill: config.getSetting('portraitDps_timeToKill'),
            waveClear: config.getSetting('portraitDps_waveClear'),
            manaRunway: config.getSetting('portraitDps_manaRunway'),
            sustain: config.getSetting('portraitDps_sustain'),
            accuracy: config.getSetting('portraitDps_accuracy'),
            enemyOutgoing: config.getSetting('portraitDps_enemyOutgoing'),
            enrage: config.getSetting('portraitDps_enrage'),
        };
    }

    /**
     * Put a meter on every portrait, and a rate on every monster.
     * @param {Object} [run] - From `damageBreakdown`, read fresh when omitted
     * @param {Object} [fight] - From `battleBreakdown`, read fresh when omitted
     */
    _draw(run = damageBreakdown(), fight = battleBreakdown()) {
        try {
            const settings = this._settings();
            this._lastMeterCount = 0;
            this._drawPlayers(run, fight, settings);
            this._drawEnemies(fight, settings);
            this._lastSignature = drawSignature(run, fight);
        } catch (error) {
            console.error('[PortraitDps] Drawing the portrait meters failed:', error);
        }
    }

    /**
     * @param {Object} run - From `damageBreakdown`
     * @param {Object} fight - From `battleBreakdown`
     * @param {Object} settings - From `_settings`
     */
    _drawPlayers(run, fight, settings) {
        const area = this._ownArea(PLAYERS_AREA);
        if (!area) return;

        const units = [...area.querySelectorAll(UNIT)];
        const pairs = matchPortraits(units, run.players);

        // The current-fight row is keyed by slot, and the run's row is keyed by
        // name — so the join between them goes through the name, which is the
        // only thing meaningful in both
        const currentByName = new Map();
        for (const entry of Object.values(fight.players || {})) {
            if (entry?.name) currentByName.set(entry.name, entry);
        }

        // The incoming tracker's rows, by name for the same reason. Only read
        // when the sustain line exists to spend them on.
        const takenByName = new Map();
        if (settings.sustain) {
            for (const entry of takenBreakdown().players || []) {
                if (entry?.name) takenByName.set(entry.name, entry);
            }
        }

        const mana = settings.manaRunway ? manaSamples() : null;

        this._prune(area, new Set(pairs.map((pair) => pair.unit)));
        for (const { unit, player } of pairs) {
            const extras = {
                showSustain: settings.sustain,
                taken: takenByName.get(player.name) || null,
                showAccuracy: settings.accuracy,
                showMana: settings.manaRunway,
                manaRunway: mana ? manaRunwaySeconds(mana[player.index]) : null,
            };
            this._meter(unit, meterText(player, currentByName.get(player.name) || null, extras));
        }
    }

    /**
     * @param {Object} fight - From `battleBreakdown`
     * @param {Object} settings - From `_settings`
     */
    _drawEnemies(fight, settings) {
        const area = this._ownArea(MONSTERS_AREA);
        if (!area) return;

        // Monsters are joined by slot rather than by name, which is the opposite
        // of the players and right for the opposite reason: two of the same
        // monster are two different fights, and their names cannot tell them
        // apart. A slot is stable for the length of a battle, and the tiles are
        // rebuilt when it ends.
        const units = [...area.querySelectorAll(UNIT)];
        const wanted = new Set();

        // One figure for the whole wave, drawn on the topmost tile
        const waveSeconds = settings.waveClear ? waveClearSeconds(fight.enemies) : null;
        const outgoing = settings.enemyOutgoing ? battleTakenBreakdown().enemies : null;
        const now = Date.now();

        units.forEach((unit, index) => {
            const enemy = fight.enemies?.[index];
            if (!enemy) return;

            wanted.add(unit);
            const extras = {
                showTimeToKill: settings.timeToKill,
                showWaveClear: settings.waveClear,
                waveSeconds: index === 0 ? waveSeconds : null,
                showOutgoing: settings.enemyOutgoing,
                outgoingDps: outgoing?.[index]?.dps ?? null,
                showEnrage: settings.enrage,
                now,
            };
            this._meter(unit, enemyMeterText(enemy, extras), true);
        });

        this._prune(area, wanted);
    }

    /**
     * This character's own area of a kind, and no trial's.
     *
     * A spectated guild trial draws the same `BattlePanel_playersArea` /
     * `BattlePanel_monstersArea` into the guild panel, with this fight's own
     * units nowhere in them — see `combat-unit-buff-bars.js`'s `isTrialArea` for
     * why the guild panel is the fence and why it needs no timeout in either
     * direction. A trial area is never drawn on, and any meter left in one from
     * before the trial view opened is taken out here, so nothing is left to
     * flash on the way in or out. The first area outside the guild panel is the
     * party's own; there is only ever one, and taking the first keeps the old
     * `querySelector` behaviour when no trial is on screen.
     *
     * @param {string} selector - `PLAYERS_AREA` or `MONSTERS_AREA`
     * @returns {HTMLElement|null} The party's own area, or null when only a
     *   trial's is on screen
     */
    _ownArea(selector) {
        let own = null;
        for (const area of document.querySelectorAll(selector)) {
            if (isTrialArea(area)) {
                for (const meter of area.querySelectorAll(`[${MARK}]`)) meter.remove();
            } else if (!own) own = area;
        }
        return own;
    }

    /**
     * Take away meters whose tile is no longer one we are drawing on.
     *
     * @param {HTMLElement} area - Players or monsters
     * @param {Set<HTMLElement>} wanted - Tiles that should keep theirs
     */
    _prune(area, wanted) {
        for (const meter of area.querySelectorAll(`[${MARK}]`)) {
            if (!wanted.has(meter.parentElement)) meter.remove();
        }
    }

    /**
     * @param {HTMLElement} unit - The tile
     * @param {{text: string, lines: Array<string>, title: string}} content - What it says
     * @param {boolean} [atBottom] - Force it under the tile, as monsters want
     */
    _meter(unit, content, atBottom = false) {
        const below = atBottom || config.getSettingValue('portraitDpsPosition', 'above') === 'below';
        const lines = content.lines || [content.text];

        this._lastMeterCount += 1;
        let meter = unit.querySelector(`:scope > [${MARK}]`);
        if (!meter) {
            meter = document.createElement('div');
            meter.setAttribute(MARK, '1');
            // In the flow of the tile rather than positioned over it. The first
            // version hung the meter outside the tile's box at `top: -14px`,
            // which drew nothing visible: the battle panel clips its children,
            // so the meter was there and cropped away. DPs makes room for its
            // own lines the same way — the tile simply gets taller.
            Object.assign(meter.style, {
                textAlign: 'center',
                fontSize: '11px',
                fontWeight: 'bold',
                lineHeight: '1.25',
                pointerEvents: 'none',
                textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                padding: '1px 2px',
                color: ROW_COLORS.bad,
            });
        }

        // Re-seated on every draw, because the setting can move between renders
        // and because React rebuilding the tile puts its own children back in
        // whatever order it likes
        const wanted = below ? unit.lastElementChild : unit.firstElementChild;
        if (wanted !== meter) {
            if (below) unit.appendChild(meter);
            else unit.insertBefore(meter, unit.firstChild);
        }

        // A line is a string, or `{text, color}` when it carries its own colour
        const text = lines
            .map((line) => (typeof line === 'string' ? line : `${line.text}|${line.color || ''}`))
            .join('\n');
        if (meter.dataset.text !== text) {
            meter.dataset.text = text;
            meter.replaceChildren();
            for (const line of lines) {
                const row = document.createElement('div');
                row.textContent = typeof line === 'string' ? line : line.text;
                if (typeof line !== 'string' && line.color) row.style.color = line.color;
                meter.appendChild(row);
            }
        }
        meter.title = content.title;
    }
}

const portraitDps = new PortraitDps();

/** The singleton, exposed for tests. */
export { portraitDps as _instance };

export default {
    name: 'Portrait DPS',
    initialize: () => portraitDps.initialize(),
    cleanup: () => {
        try {
            return portraitDps.disable();
        } catch (error) {
            console.error('[Portrait DPS] Disable failed part-way:', error);
        } finally {
            portraitDps.isInitialized = false;
        }
    },
    /** Draw now rather than on the next tick — for tests, and for a settings change */
    redraw: () => portraitDps._draw(),
};
