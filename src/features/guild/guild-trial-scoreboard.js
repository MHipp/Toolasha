/**
 * Who is carrying the trial, as a panel rather than four lines under a card.
 *
 * The per-player split already exists (`guild-trial-damage.js`) and is drawn as
 * a short list under the combat trial's card. That is the right size for a
 * glance and the wrong size for the question a guild actually argues about after
 * a tier fails, which wants ranks, shares, bars, and the healing beside the
 * damage. So the same numbers get a panel.
 *
 * ## Two tabs, three sources, and every figure says which one it is
 *
 * A trial fight is real and server-run, and opening the In Progress **fight
 * view** streams it here as `guild_battle_updated` — so these tabs can be
 * measured after all, for the stretch somebody was watching. Three things can
 * therefore be on screen, and they are never mixed:
 *
 * 1. **Measured** — folded from spectated ticks. Preferred whenever it exists.
 * 2. **Estimated** — each member's captured build worth per second, shared out.
 *    The fallback when nothing has been watched, labelled at the top rather than
 *    footnoted. Members with no captured build are named, not dropped.
 * 3. **Nothing** — with a reason that says what to do about it, which is now
 *    "open the fight view" rather than an apology.
 *
 * **Healing** has no estimate to fall back on: a build says nothing about how
 * much healing a fight will call for. Watched, it fills from the same ticks the
 * damage does — health rising, attributed to a lone healer on the tick and kept
 * unattributed otherwise (`guild-trial-support.js`).
 *
 * The party-wide rate on the trial card stays where it is and stays measured;
 * this panel never competes with it.
 *
 * ## Colour
 *
 * By damage type, from the loadouts already captured off `battle_unit_fetched`
 * (`combatStats.damageType`, or the combat style when the type is absent) —
 * which is a fact about the player rather than a guess from their name. A player
 * whose loadout has never been seen gets the neutral accent, because a colour
 * that means "unknown" and a colour that means "physical" must not be the same
 * colour.
 */

import dataManager from '../../core/data-manager.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import guildTrialDamage, {
    attributionCoverage,
    encounterOf,
    estimateDamageSplit,
    SPECTATED_TRIAL_NOTE,
} from './guild-trial-damage.js';
import guildTrialStatsModal from './guild-trial-stats-modal.js';
import { guildLoadoutCapture } from './guild-loadout-capture.js';
import guildTrialAbilities from './guild-trial-abilities.js';
import { guildTrialRecorder } from './guild-trial-recorder.js';
// The diagnostic trace, for one line about holes in the recording. Safe to
// import here where the trials feature is not: the trace imports neither this
// panel nor that feature, so nothing points back.
import guildTrialTrace, { traceGapWarning } from './guild-trial-trace.js';
import { buildGuildReport } from './guild-trial-report.js';
import {
    abilityActionLabel,
    abilityBreakdownRows,
    abilityLineHTML,
    boardHeadHTML,
    boardRowHTML,
    boardTabsHTML,
    rankRows,
    escapeText,
} from '../../utils/damage-board.js';
import { classTagIconHTML } from '../../utils/class-weapon.js';

/** Class every part of this panel carries, so teardown is one query */
export const PANEL_CLASS = 'mwi-trial-scoreboard';

const ACCENT = '#8fd3ff';
const DIM = '#9ca3af';
const GOOD = '#4ade80';
const WARN = '#f0a830';

/**
 * Bar colour per damage type.
 *
 * Read from the loadout rather than inferred from a name. The neutral accent is
 * reserved for "no loadout seen", which is a different statement from any of the
 * others and must look different.
 */
export const TYPE_COLORS = {
    physical: '#f0a830',
    water: '#5aa9e6',
    nature: '#4ade80',
    fire: '#ef6f5a',
    slash: '#f0a830',
    stab: '#f0a830',
    smash: '#f0a830',
    ranged: '#c084fc',
    magic: '#5aa9e6',
};

/**
 * A role marker beside a name on the board, or nothing.
 *
 * Drawn as the class's representative weapon where the game's item data can
 * name one (`class-weapon.js`): a row here is a rank, a name, a figure and a
 * bar inside 320 pixels, and a six-letter bordered chip was taking its width
 * out of the name — "Estevao [WATER] 175.8K" with the name ellipsing to make
 * room for a word.
 *
 * The chip is the fallback rather than the replacement, because it is what
 * every client draws until the init payload lands. Its visible label comes from
 * `class-inference.js`' own bucket table — a fixed set of words this file
 * controls — and is stripped to letters before it goes into the string, so
 * nothing off the wire can reach the markup through it.
 *
 * @param {Object|null} verdict - From `guildTrialAbilities.classes()`
 * @returns {string} HTML, or '' when nothing is known about this player
 */
export function classTagHTML(verdict) {
    const label = String(verdict?.short || '').replace(/[^A-Z]/g, '');
    if (!label) return '';

    const title = `${label} — inferred from what this player was seen casting this trial, not from a Battle Info capture.`;

    const icon = classTagIconHTML(verdict, { title, size: 13 });
    if (icon) return icon;

    return (
        `<span title="${title}" style="color:${DIM}; font-size:9px; letter-spacing:0.5px; ` +
        `border:1px solid ${DIM}; border-radius:3px; padding:0 3px;">${label}</span>`
    );
}

/**
 * A live mana marker for a row: dry, starved of their cheapest cast, or low.
 * @param {Object|null|undefined} support - The player's support row
 * @returns {string} HTML, or '' when their mana is fine or unknown
 */
export function manaMarkerHTML(support) {
    if (!support) return '';
    const chip = (text, color, title) =>
        `<span title="${title}" style="color:${color}; font-size:9px; letter-spacing:0.3px; border:1px solid ${color}; ` +
        `border-radius:3px; padding:0 3px; margin-left:4px; opacity:0.9; white-space:nowrap;">${text}</span>`;
    if (support.outOfMana) return chip('⚡ dry', '#f87171', 'Mana is at zero right now.');
    if (support.starved) {
        return chip(
            '⚡ can’t cast',
            WARN,
            `Mana is under the cheapest ability they cast (${support.castFloor}) — the rotation has stalled.`
        );
    }
    if (support.lowMana) return chip('⚡ low', DIM, 'Mana is under a fifth of the bar.');
    return '';
}

/**
 * The damage type a player fights with, from their captured loadout.
 * @param {string} name - Player name
 * @param {Object} [capture] - The loadout store, injectable for tests
 * @returns {string|null} A key of {@link TYPE_COLORS}, or null when unseen
 */
export function damageTypeOf(name, capture = guildLoadoutCapture) {
    const stats = capture?.forPlayer?.(name)?.stats;
    if (!stats) return null;

    const type = String(stats.damageType || '')
        .split('/')
        .pop();
    if (type && TYPE_COLORS[type]) return type;

    const style = String(stats.combatStyleHrids?.[0] || '')
        .split('/')
        .pop();
    return style && TYPE_COLORS[style] ? style : null;
}

/**
 * The rows one tab shows, ranked, with shares.
 *
 * Pure: it takes a breakdown and returns numbers, so the arithmetic is tested
 * without a DOM. Rows with nothing in them are dropped — a healer with no damage
 * on the damage tab is a zero-length bar and a rank nobody wanted.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {'damage'|'healing'} tab - Which figures
 * @returns {{rows: Array<Object>, total: number, perSecond: number|null, seconds: number}} The tab
 */
export function scoreboardRows(breakdown, tab = 'damage', modalStats = null) {
    const seconds = breakdown?.seconds || 0;

    // The game's own post-trial stats, when they have been captured, are the
    // authoritative full-trial totals — preferred over the stream, which only
    // ever saw the stretch the fight view was open (here, a mid-fight restart
    // left it at ~5%) and barely sees damage taken at all (health falling per
    // tick, most of it masked by healing). No per-second: the modal states
    // whole-trial totals, not a rate.
    const modalField = { damage: 'damage', healing: 'healing', taken: 'damageTaken' }[tab] || 'damage';
    if (Array.isArray(modalStats) && modalStats.length) {
        const raw = modalStats.map((member) => ({
            index: member.name,
            name: member.name,
            value: Number(member[modalField]) || 0,
        }));
        // Ranked by the shared board, so this table and the run-side one order
        // and share out their rows by exactly one rule. No per-second: the
        // modal states whole-trial totals, not a rate
        const ranked = rankRows(
            raw.map((row) => ({ ...row, perSecond: null })),
            seconds
        );
        const { rows, total } = ranked;

        // The stream's own measurement of the same figure, so each authoritative
        // row can say how far the plugin's tick-by-tick estimate ran from it —
        // the point of capturing the game's numbers in the first place.
        const measuredSource =
            tab === 'healing' || tab === 'taken' ? breakdown?.support?.players || [] : breakdown?.players || [];
        const measuredField = tab === 'healing' ? 'healingDone' : tab === 'taken' ? 'damageTaken' : 'damage';
        const measuredByName = new Map(
            measuredSource.filter((row) => row?.name).map((row) => [row.name, Number(row[measuredField]) || 0])
        );

        return {
            rows: rows.map((row) => {
                const measuredValue = measuredByName.has(row.name) ? measuredByName.get(row.name) : null;
                return {
                    ...row,
                    measured: true,
                    measuredValue,
                    measuredDeltaPct:
                        measuredValue !== null && row.value > 0
                            ? ((measuredValue - row.value) / row.value) * 100
                            : null,
                };
            }),
            total,
            perSecond: null,
            seconds,
            source: 'game',
        };
    }

    const support = breakdown?.support?.players || [];
    const raw =
        tab === 'healing'
            ? support.map((row) => ({ index: row.index, name: row.name, value: row.healingDone || 0 }))
            : tab === 'taken'
              ? support.map((row) => ({ index: row.index, name: row.name, value: row.damageTaken || 0 }))
              : (breakdown?.players || []).map((row) => ({ index: row.index, name: row.name, value: row.damage || 0 }));

    const measuredBy = new Map((breakdown?.players || []).map((row) => [row.index, row.measured]));
    const ranked = rankRows(raw, seconds);

    return {
        rows: ranked.rows.map((row) => ({
            ...row,
            // Per row, not per table: the game streams action counters for one
            // unit — yours — so one row can be measured while the rest are not
            measured: measuredBy.get(row.index) ?? null,
        })),
        total: ranked.total,
        perSecond: ranked.perSecond,
        seconds,
        source: breakdown?.source === 'spectated' ? 'stream' : null,
    };
}

/** How far a measured total may sit over the boss-HP ceiling before it is flagged. */
const CEILING_MARGIN = 0.02;

/**
 * Whether a measured damage total has run past what the bosses could have lost.
 *
 * The summed health of every boss seen is a hard ceiling on the party's damage
 * (see `bossHpCeiling`): a split above it is over-attributing, or — less often —
 * the boss healed itself. One-sided, so a total below the ceiling is not thereby
 * confirmed; an unkilled last boss always leaves real headroom. Returns null when
 * there is no ceiling to check or the total sits within it.
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {number} total - The measured per-player damage total
 * @returns {{overBy: number, ceiling: number, fights: number}|null}
 */
export function damageOverCeiling(breakdown, total) {
    const ceiling = breakdown?.damageCeiling?.hp;
    if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
    if (!Number.isFinite(total) || total <= ceiling * (1 + CEILING_MARGIN)) return null;
    return { overBy: total / ceiling - 1, ceiling, fights: breakdown?.damageCeiling?.fights || 0 };
}

/**
 * The game's post-trial Stats modal for the trial a breakdown is watching.
 *
 * The modal is keyed by trial name ("Trial Swarm"); the breakdown carries the
 * encounter and this week's trial names, so the two are joined here. Returns
 * null unless a combat modal has been captured for that trial.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {Object} [modal] - The stats-modal store, injectable for tests
 * @returns {Array<{name: string, damage: number|null, healing: number|null,
 *   damageTaken: number|null}>|null} Per-member totals, or null
 */
export function modalStatsForBreakdown(breakdown, modal = guildTrialStatsModal) {
    if (!breakdown?.encounter) return null;
    // The wire stats (`guild_trial_stats_updated`) are the same authoritative
    // per-member totals as the game's post-trial modal, but they do not need the
    // modal opened and they survive a refresh, so they are preferred where
    // present. The scraped modal is the fallback for a build that has not seen
    // the message, or a trial watched before this feature existed.
    const wire = breakdown.reported;
    if (wire && typeof wire === 'object' && Object.keys(wire).length) {
        return Object.entries(wire).map(([name, stats]) => ({
            name,
            damage: stats?.damage ?? null,
            healing: stats?.healing ?? null,
            damageTaken: stats?.taken ?? null,
        }));
    }
    const trialName = (breakdown.trialNames || []).find((name) => encounterOf(name) === breakdown.encounter);
    return trialName ? modal.getCombatStats?.(trialName) || null : null;
}

/**
 * The panel's contents as plain text, for the clipboard.
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {'damage'|'healing'} tab - Which figures
 * @returns {string} One line per player
 */
export function scoreboardText(breakdown, tab = 'damage', estimate = null, modalStats = null) {
    const { rows, total, perSecond, source } = scoreboardRows(breakdown, tab, modalStats);
    const label = tab === 'healing' ? 'healing' : tab === 'taken' ? 'damage taken' : 'damage';

    if (source === 'game') {
        if (!rows.length) return `Trial ${label}: the game's stats modal lists none.`;
        const head = `Trial ${label} — ${formatWithSeparator(Math.round(total))} total, from the game's post-trial stats`;
        const lines = rows.map(
            (row) =>
                `${row.rank}. ${row.name} — ${formatWithSeparator(Math.round(row.value))}` +
                (row.share === null ? '' : ` (${row.share.toFixed(1)}%)`)
        );
        return [head, ...lines].join('\n');
    }

    if (!rows.length && tab === 'damage' && estimate?.players?.length) {
        const head =
            `Trial damage, ESTIMATED FROM BUILDS — the game does not expose real per-player trial figures. ` +
            `${estimate.covered} of ${estimate.of} builds captured.`;
        const lines = estimate.players.map(
            (row, position) =>
                `${position + 1}. ${row.name} — ~${formatWithSeparator(Math.round(row.dps))}/s` +
                (row.share === null ? '' : ` (${row.share.toFixed(1)}%)`)
        );
        if (estimate.unestimated.length) {
            lines.push(`Unestimated (no build captured): ${estimate.unestimated.join(', ')}`);
        }
        return [head, ...lines].join('\n');
    }

    if (!rows.length) return `Trial ${label}: nothing measured — ${breakdown?.reason || SPECTATED_TRIAL_NOTE}`;

    const header =
        `Trial ${label} — ${formatWithSeparator(Math.round(total))} total` +
        (perSecond === null ? '' : `, ${formatWithSeparator(Math.round(perSecond))}/s`) +
        ` over ${Math.round(breakdown?.seconds || 0)}s (estimated from the battle feed)`;

    const lines = rows.map(
        (row) =>
            `${row.rank}. ${row.name} — ${formatWithSeparator(Math.round(row.value))}` +
            (row.perSecond === null ? '' : ` (${formatWithSeparator(Math.round(row.perSecond))}/s`) +
            (row.share === null ? ')' : `, ${row.share.toFixed(1)}%)`)
    );

    // Damage summing to 100% across a subset of the party reads as the whole
    // party unless it says otherwise — a spectated split only names the players
    // who had a tick of their own, so "3 of 7" is stated here too
    if (tab === 'damage') {
        const coverage = attributionCoverage(breakdown);
        if (coverage.partial) {
            lines.push(
                `${coverage.attributed} of ${coverage.party} players attributed — shares are of that damage, ` +
                    'and the party rate is a lower bound; the rest fill in as their hits land alone on the boss.'
            );
        }
    }

    if (tab === 'healing') {
        const regen = breakdown?.support?.regenHealing || 0;
        if (regen > 0) {
            lines.push(`Regeneration: ${formatWithSeparator(Math.round(regen))} (the trial’s flat regen, nobody’s)`);
        }
        const unattributed = breakdown?.support?.unattributedHealing || 0;
        if (unattributed > 0) {
            lines.push(
                `Unattributed: ${formatWithSeparator(Math.round(unattributed))} ` +
                    '(overlapping heals, or an on-cast proc from a player without streamed counters)'
            );
        }
    }

    return [header, ...lines].join('\n');
}

class GuildTrialScoreboard {
    constructor() {
        this.container = null;
        this.tab = 'damage';
        this.refreshId = null;
        /** Redraws on the way back from a hidden tab; removed on close */
        this._visibilityHandler = null;
        /** The trials feature's expected-tier forecast, pushed in rather than imported */
        this.forecast = null;
        /** The trial's name, tier and shortfall, likewise pushed in */
        this.context = null;
        /**
         * Which damage rows are opened to their per-ability breakdown, by
         * lowercased player name — the key the mana markers already use.
         * Survives the five-second redraw, so an open row stays open.
         */
        this.expanded = new Set();
    }

    /**
     * Take the expected-tier forecast from the trials feature.
     *
     * Pushed rather than pulled, the same way the damage gate is told which
     * encounters this week's trials are: the trials feature imports this panel,
     * so this panel must not import it back.
     *
     * @param {Object|null} forecast - From `guild-trial-forecast.js`
     */
    noteForecast(forecast) {
        this.forecast = forecast || null;
    }

    /** @returns {boolean} Whether the panel is on screen */
    get isOpen() {
        return Boolean(this.container?.isConnected);
    }

    /** Open it, or bring it forward if it is already open */
    open() {
        if (this.isOpen) {
            bringPanelToFront?.(this.container);
            this.render();
            return;
        }
        this._build();
        this.render();
    }

    /**
     * Close it.
     *
     * Also lets go of `context`/`forecast`. Both are pushed in from outside —
     * the trials feature's Trials-tab DOM scan — and a character or guild
     * switch calls this before it can know the arriving guild's own trial
     * name, roster or forecast. Leaving the departed guild's values in place
     * would have a report copied (or the panel reopened) right after a switch
     * mix the new guild's fresh damage breakdown with the old guild's trial
     * name and member list — the same cross-guild bleed the switch handler
     * takes care to avoid everywhere else. The scan re-pushes fresh values
     * once it runs again for the new guild.
     */
    close() {
        if (this.refreshId) clearInterval(this.refreshId);
        this.refreshId = null;
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        // The drag listeners live on the document rather than on the panel, so
        // closing has to take them off by hand or every open leaves a pair
        this._release?.();
        this._release = null;
        if (this.container) {
            unregisterFloatingPanel?.(this.container);
            this.container.remove();
        }
        this.container = null;
        this.context = null;
        this.forecast = null;
        // Expansion state is about the trial being watched; the next open may
        // be a different trial, or a different guild's
        this.expanded.clear();
    }

    /** Open when shut, shut when open — what the command palette calls */
    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    /** Build the shell once; the body is redrawn in place */
    _build() {
        const container = document.createElement('div');
        container.className = PANEL_CLASS;
        container.style.cssText =
            'position:fixed; top:80px; right:24px; width:320px; z-index:9000;' +
            'background:rgba(18,20,28,0.97); border:1px solid rgba(255,255,255,0.12); border-radius:8px;' +
            'box-shadow:0 6px 24px rgba(0,0,0,0.45); font-size:12px; color:#e8ecf5;' +
            'display:flex; flex-direction:column; max-height:70vh;';

        const header = document.createElement('div');
        header.className = `${PANEL_CLASS}__header`;
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:8px;' +
            'padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.08); cursor:move;';
        header.innerHTML = `<span style="font-weight:700; color:${ACCENT};">Trial damage</span>`;

        const close = document.createElement('button');
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close');
        close.style.cssText =
            'background:none; border:none; color:#aaa; font-size:16px; line-height:1; cursor:pointer; padding:0 2px;';
        close.addEventListener('click', () => this.close());
        header.appendChild(close);

        const body = document.createElement('div');
        body.className = `${PANEL_CLASS}__body`;
        body.style.cssText = 'padding:8px 10px; overflow-y:auto;';

        container.appendChild(header);
        container.appendChild(body);
        document.body.appendChild(container);
        registerFloatingPanel?.(container);

        this.container = container;
        this._drag(header);

        // A trial is live while this is open; five seconds is the cadence the
        // rest of the feature samples at. A hidden tab is skipped — the whole
        // board is rebuilt each pass, and nobody is looking at it.
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            this.render();
        }, 5000);
        // Coming back to the tab should show the trial as it stands now, not as
        // it stood when the tab was left.
        this._visibilityHandler = () => {
            if (!document.hidden) this.render();
        };
        document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    /**
     * Make the header drag the panel.
     * @param {Element} header - The drag handle
     */
    _drag(header) {
        let from = null;
        header.addEventListener('mousedown', (event) => {
            if (event.target.tagName === 'BUTTON') return;
            const box = this.container.getBoundingClientRect();
            from = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
            event.preventDefault();
        });
        const move = (event) => {
            if (!from || !this.container) return;
            this.container.style.left = `${from.left + event.clientX - from.x}px`;
            this.container.style.top = `${from.top + event.clientY - from.y}px`;
            this.container.style.right = 'auto';
        };
        const up = () => {
            from = null;
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        this._release = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
    }

    /** Redraw the body from the current breakdown */
    render() {
        if (!this.isOpen) return;
        const body = this.container.querySelector(`.${PANEL_CLASS}__body`);
        if (!body) return;

        const breakdown = guildTrialDamage.breakdown?.() || null;
        body.innerHTML = this._bodyHTML(breakdown);

        body.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.tab = button.dataset.tab;
                this.render();
            });
        });
        // A damage row opens to its per-ability breakdown and shuts again on
        // the next click; the whole body is one string, so a toggle is a redraw
        body.querySelectorAll('[data-player]').forEach((rowEl) => {
            rowEl.addEventListener('click', () => {
                const key = rowEl.dataset.player;
                if (this.expanded.has(key)) this.expanded.delete(key);
                else this.expanded.add(key);
                this.render();
            });
        });
        body.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
            this._copy(scoreboardText(breakdown, this.tab, this._estimate(), modalStatsForBreakdown(breakdown)));
        });
        body.querySelector('[data-action="report"]')?.addEventListener('click', () => {
            this._copy(this.reportText(breakdown));
        });
        body.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
            guildTrialRecorder.restart();
            this.render();
        });
    }

    /**
     * Put something on the clipboard.
     * @param {string} text - What to copy
     */
    _copy(text) {
        navigator.clipboard?.writeText?.(text)?.catch?.(() => {});
    }

    /**
     * The guild-shareable report, with whatever context the panel has.
     *
     * The trial's name, the tiers it banked and how close it came all live with
     * the trials feature, which pushes them here the same way it pushes the
     * forecast — this panel imports neither.
     *
     * @param {Object} [breakdown] - From `guildTrialDamage.breakdown()`
     * @returns {string} The report
     */
    reportText(breakdown = guildTrialDamage.breakdown?.()) {
        return buildGuildReport({ ...(this.context || {}), breakdown, estimate: this._estimate() });
    }

    /**
     * Which rows the stream's own attack counters single out, when it singles
     * any out at all.
     *
     * This was written for a stream that carried action counters for **one**
     * unit — the viewer's — where naming that row was the whole point: it said
     * which single row of thirty had a counter behind it. The game now streams
     * counters for every present player, so `countedNames` is the whole party
     * (57 of 57 in the captured trial) and the same sentence renders as "…and
     * 55 more carry own attack counters that confirm it directly" — an
     * assertion that every row is directly confirmed, which is precisely the
     * claim the note existed to *avoid* making, and which the attribution does
     * not support: the counter rung and the equal-split rung disagree on 0.6%
     * of damaging ticks and one rung's behaviour on full snapshots is still
     * under review.
     *
     * So it is gated rather than dropped. Silent when the counters cover the
     * whole party (they then distinguish nobody, and the caveat sentence next
     * to it, `_coverageNote`, is the one with something to say); silent too
     * when the party size is unknown, since "a subset" cannot be established
     * without it. It speaks only when the counters really do single out fewer
     * rows than there are players — the case it was written for, where the
     * wording is exactly right.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _ownRowNote(breakdown) {
        const named = breakdown?.countedNames || [];
        if (!named.length) return '';

        const { party } = attributionCoverage(breakdown);
        if (!party || named.length >= party) return '';

        // `countedNames` is player-controlled text off the wire — the same
        // reason every other name this file interpolates (`boardRowHTML`,
        // `boardHeadHTML`) goes through `escapeText` first.
        const escaped = named.map((name) => escapeText(name));
        return (
            ` Each row is attributed off the ticks the server groups by actor;` +
            ` ${escaped.slice(0, 2).join(' and ')}${escaped.length > 2 ? ` and ${escaped.length - 2} more` : ''}` +
            ` ${escaped.length === 1 ? 'carries' : 'carry'} own attack counters that confirm it directly.`
        );
    }

    /**
     * How the units in a watched fight were identified, when it is worth saying.
     *
     * A spectated tick names its units by index only, so a row headed "Player 3"
     * has to be legible as a placeholder rather than as somebody's name.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _namingNote(breakdown) {
        const coverage = breakdown?.nameCoverage;
        if (!coverage?.of) return '';
        if (!coverage.placeholders.length) return '';

        const listed = coverage.placeholders.slice(0, 4).join(', ');
        return (
            ` ${coverage.named} of ${coverage.of} units could be named from the fight view or a captured ` +
            `build; ${listed} ${coverage.placeholders.length === 1 ? 'is a placeholder' : 'are placeholders'}.`
        );
    }

    /**
     * How much of the party the split covers, when it is only a part.
     *
     * A spectated split names its attacker by presence — the lone player who
     * changed on a tick the boss lost health — because the stream carries no
     * other player's attack counters. A member who never had a tick of their
     * own earns no row, so three names at 100% can sit under a party of seven.
     * Saying "3 of 7" is what keeps that from reading as a claim the party is
     * three people. Silent when the whole party is covered, or its size is
     * unknown.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _coverageNote(breakdown) {
        const coverage = attributionCoverage(breakdown);
        if (!coverage.partial) return '';

        return (
            ` ${coverage.attributed} of ${coverage.party} players had a tick that could be split out this` +
            ` window; the shares are of that attributed damage and the party rate is a lower bound, with the` +
            ` rest filling in as their hits land alone on the boss.`
        );
    }

    /**
     * How much of the split is damage no hit counter confirmed.
     *
     * Bleeds and reflects move the boss's health without moving its hit
     * counter. They used to be discarded, which is why this table used to add
     * up to less than the boss bar; they are inside the damage figures now and
     * carry no swing, no crit and no ability, so a row's hit count can look
     * small beside its damage without either being wrong. Silent when there is
     * none of it.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _dotNote(breakdown) {
        const dot = Number(breakdown?.totalDotDamage) || 0;
        const total = Number(breakdown?.totalDamage) || 0;
        if (!(dot > 0)) return '';

        const share = total > 0 ? ` (${((dot / total) * 100).toFixed(0)}% of the total)` : '';
        return (
            ` Includes ${formatKMB(dot)} of DoT/reflect${share} — health lost with no hit counter behind it,` +
            ` so it moves the damage and not the hit or crit rates.`
        );
    }

    /**
     * The per-player split as the builds predict it.
     *
     * Rebuilt on every draw rather than cached: a build captured mid-trial has to
     * appear without the panel being closed and reopened.
     *
     * @returns {Object} From `estimateDamageSplit`
     */
    _estimate() {
        return estimateDamageSplit({
            loadouts: guildLoadoutCapture.seen?.() || [],
            members: this.context?.members || [],
        });
    }

    /**
     * Take the trial's own context from the trials feature.
     * @param {Object} context - `{trialName, tier, tiersCleared, shortfall, pastWeeks}`
     */
    noteContext(context) {
        this.context = context || null;
    }

    /**
     * The body's markup.
     * @param {Object|null} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} HTML
     */
    _bodyHTML(breakdown) {
        const modalStats = modalStatsForBreakdown(breakdown);
        const { rows, total, perSecond, source } = scoreboardRows(breakdown, this.tab, modalStats);
        const fromGame = source === 'game';
        const healing = this.tab === 'healing';
        const taken = this.tab === 'taken';
        const unit = healing ? 'hps' : 'dps';

        // Measurement is impossible for a trial (see the module note), so the
        // damage tab falls through to the estimate rather than to an apology —
        // but never over the game's own stats or the damage-taken tab.
        const estimate = !rows.length && !healing && !taken && !fromGame ? this._estimate() : null;
        const estimated = Boolean(estimate?.players?.length);

        const head = estimated
            ? boardHeadHTML({
                  value: estimate.total,
                  prefix: '~',
                  label: 'est. party dps',
                  color: WARN,
                  right: `${estimate.covered}/${estimate.of} builds`,
                  rightColor: DIM,
              })
            : fromGame
              ? boardHeadHTML({
                    value: total,
                    label: `trial ${taken ? 'damage taken' : healing ? 'healing' : 'damage'} · game stats`,
                    color: GOOD,
                })
              : boardHeadHTML({ value: perSecond, label: `party ${unit}`, color: ACCENT, right: total });

        const tabs = boardTabsHTML(
            [
                { key: 'damage', label: 'Damage' },
                { key: 'healing', label: 'Healing' },
                { key: 'taken', label: 'Taken' },
            ],
            this.tab
        );

        // The headline of the section, not a caveat under it: a reader who takes
        // an estimate for the game's own figures has been misled by the panel,
        // and one who takes a measurement for a guess distrusts a real number
        const spectated = breakdown?.source === 'spectated';
        const disclaimer = fromGame
            ? `<div style="color:${GOOD}; font-size:11px; font-weight:600; line-height:1.5;">` +
              'From the game’s post-trial stats — the authoritative full-trial totals.</div>' +
              `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
              'Read off the Combat Trial Stats modal, so these are the whole trial rather than the stretch the ' +
              'fight view happened to be open for. Damage taken and healing are only reliable here — the live ' +
              'stream reads them from health falling and rising per tick and captures a fraction of the real ' +
              'totals.</div>'
            : estimated
              ? `<div style="color:${WARN}; font-size:11px; font-weight:600; line-height:1.5;">` +
                'Estimated from builds — nothing has been watched yet.</div>' +
                `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
                'A trial fight runs on the game’s own server and streams here only while the In Progress ' +
                'fight view is open — open it and these become measured. Until then this is each captured ' +
                'sheet’s auto-attack worth per second, shared out: abilities are not modelled, and a build is ' +
                'only as current as the last time it was seen.</div>'
              : spectated
                ? `<div style="color:${GOOD}; font-size:11px; font-weight:600; line-height:1.5;">` +
                  `Measured from the trial fight — ${Math.round(breakdown?.seconds || 0)}s watched.</div>` +
                  `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
                  'Folded from the stream the In Progress fight view subscribes to. Once started, the stream ' +
                  'often keeps flowing while other tabs are open — every tick received is counted, and a gap ' +
                  'in the stream pauses these rather than ending them.' +
                  this._ownRowNote(breakdown) +
                  this._namingNote(breakdown) +
                  this._coverageNote(breakdown) +
                  this._dotNote(breakdown) +
                  '</div>'
                : `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
                  'Attributed off this client’s own battle feed.</div>';

        // The two "damage taken" figures are different quantities and must not be
        // read as one: the game modal reports gross incoming *before* mitigation,
        // while the stream only ever sees the health actually lost then restored —
        // post-mitigation, and a floor at that. Say which is which so nobody
        // compares them.
        const takenNote = !taken
            ? ''
            : fromGame
              ? `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin:-2px 0 6px;">` +
                'The game counts damage taken <b>before</b> your mitigation — gross incoming — so it reads higher ' +
                'than the health you actually lost.</div>'
              : `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin:-2px 0 6px;">` +
                'This is health actually lost and then healed back — <b>after</b> mitigation, and a floor at that ' +
                '(damage healed on the same tick is invisible). Not the game’s pre-mitigation figure; the two do ' +
                'not match by design.</div>';

        // A measured split that exceeds every boss's health bar is over-attributing
        // — the guardrail is one-sided and only fires on the live damage tab, where
        // the number is ours to trust or not (the game modal is authoritative).
        const over = !fromGame && !healing && !taken && !estimated ? damageOverCeiling(breakdown, total) : null;
        const ceilingNote = over
            ? `<div style="color:${WARN}; font-size:10px; line-height:1.5; margin:-2px 0 6px;">` +
              `Measured damage runs ${Math.round(over.overBy * 100)}% over the bosses’ combined health, so the ` +
              'per-player split is over-attributing (a fast damage-over-time build collecting shared ticks is the ' +
              'usual cause). Trust the shares less than the total, and the game’s post-trial stats over both.</div>'
            : '';

        // A hole in the diagnostic recording, when one is being made. This is
        // about the trace and only the trace: the coverage note above accounts
        // for ticks that arrived but could not be split across players, while
        // this is about ticks that never arrived. A fully-covered attribution
        // computed over a feed with a forty-second hole in it is still short by
        // forty seconds, and only this line says so.
        const traceGap = traceGapWarning(guildTrialTrace.status?.());
        const traceNote = traceGap
            ? `<div style="color:${WARN}; font-size:10px; line-height:1.5; margin:-2px 0 6px;">` +
              `${escapeText(traceGap)}</div>`
            : '';

        const unestimated =
            estimated && estimate.unestimated.length
                ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">No build captured, so not ` +
                  `estimated: ${estimate.unestimated.slice(0, 8).map(escapeText).join(', ')}` +
                  `${estimate.unestimated.length > 8 ? `, +${estimate.unestimated.length - 8} more` : ''}.</div>`
                : '';

        // A watched fight with nothing attributed yet: between fights, or a
        // view opened moments ago — the next boss hit fills the table in
        const unsplit =
            !rows.length && !estimated && spectated
                ? `<div style="color:${DIM}; padding:6px 0; line-height:1.5;">` +
                  'Watched, but no damage has been attributed yet — the split fills in as hits land on the ' +
                  'boss. The tank-and-healer figures on the Healing tab come from the same ticks.</div>'
                : '';

        const nothing =
            `<div style="color:${DIM}; padding:6px 0; line-height:1.5;">` +
            (healing
                ? spectated
                    ? 'Watched, but no heal could be attributed: a rise in health is only credited when the tick ' +
                      'names its actor — a lone heal cast, or a lone ability cast whose non-regeneration rises ' +
                      'are then that cast’s effect. Regeneration is set aside by its shape, and anything else is ' +
                      'kept as unattributed rather than assigned to whoever looked likely.'
                    : `No healing has been watched — ${SPECTATED_TRIAL_NOTE}. ` +
                      'Open it during a trial and this fills from the same ticks the damage does; a build ' +
                      'cannot be used to guess healing, so there is no estimate to show meanwhile.'
                : `Nothing to show yet — ${breakdown?.reason || SPECTATED_TRIAL_NOTE}. ` +
                  'No member builds have been captured either, so there is nothing to estimate from.') +
            '</div>';

        // Read once for the whole table rather than per row: the map is built
        // off the roster, and rebuilding it forty times a redraw would be forty
        // passes over the same participants
        const classes = guildTrialAbilities.classes?.() || {};
        // Live mana state by name, for the marker beside a caster who is dry,
        // starved or low right now
        const manaByName = new Map(
            (breakdown?.support?.players || []).map((row) => [
                String(row.name || '')
                    .trim()
                    .toLowerCase(),
                row,
            ])
        );

        // The stream's per-ability split by lowercased name, for the damage
        // tab's expandable rows. Only the stream carries one — the game's
        // post-trial stats state totals per member and nothing per ability —
        // so a game-sourced row expands to the stretch the stream measured,
        // and a player the stream never split gets an honest "none captured"
        const abilitySplit =
            this.tab === 'damage'
                ? new Map(
                      (breakdown?.players || []).map((player) => [
                          String(player.name || '')
                              .trim()
                              .toLowerCase(),
                          player,
                      ])
                  )
                : null;

        const list = rows.length
            ? rows.map((row) => this._rowHTML(row, classes, manaByName, abilitySplit, breakdown?.seconds || 0)).join('')
            : estimated
              ? estimate.players
                    .map((row, position) =>
                        this._rowHTML(
                            {
                                name: row.name,
                                rank: position + 1,
                                value: null,
                                perSecond: row.dps,
                                share: row.share,
                            },
                            classes
                        )
                    )
                    .join('') + unestimated
              : unsplit || nothing;

        // Regeneration and unattributed are different claims and get different
        // lines: "the game healed everyone" is not a failure to attribute, and
        // lumping the two together read as one — "0 party hps" over a bucket
        // that was mostly the trial's own flat regen
        const unattributed = breakdown?.support?.unattributedHealing || 0;
        const regen = breakdown?.support?.regenHealing || 0;
        const footnote =
            healing && (unattributed > 0 || regen > 0)
                ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">` +
                  (regen > 0
                      ? `${formatKMB(Math.round(regen))} regeneration — the trial’s own flat regen, ` +
                        'identified by its uniform per-unit size and credited to nobody.'
                      : '') +
                  (regen > 0 && unattributed > 0 ? ' ' : '') +
                  (unattributed > 0
                      ? `${formatKMB(Math.round(unattributed))} unattributed — nothing on those ticks names a ` +
                        'caster: overlapping heals, or an on-cast proc (a Blooming Trident’s Bloom, say) from a ' +
                        'player whose counters this stream does not carry.'
                      : '') +
                  '</div>'
                : '';

        const forecast = this.forecast;
        const expected =
            forecast && forecast.tier !== null
                ? `<div style="color:${DIM}; font-size:10px; margin-top:6px;">` +
                  `Expected to reach <span style="color:${GOOD}; font-weight:600;">T${forecast.tier}</span> ` +
                  `in the hour — ${forecast.source === 'measured' ? 'from the party\u2019s measured rate' : 'estimated from captured loadouts'}` +
                  `${Number.isFinite(forecast.enragedFrom) ? ', with the boss fully enraged by then' : ''}.</div>`
                : '';

        // One line rather than a tab of its own: running dry is worth knowing
        // and is not worth a page
        const supportRows = breakdown?.support?.players || [];
        // Escaped like every other name this file interpolates: these come off
        // the wire through the support rows, and the mana line was the one
        // place a name reached `innerHTML` raw
        const nameList = (rows, field) =>
            rows
                .sort((a, b) => (b[field] || 0) - (a[field] || 0))
                .slice(0, 4)
                .map((row) => `${escapeText(row.name)} ${Number(row[field]) || 0}×`)
                .join(', ');
        const dry = supportRows.filter((row) => row.manaOuts > 0);
        const starvedRows = supportRows.filter((row) => row.starvedOuts > 0);
        const lowRows = supportRows.filter((row) => row.lowManaOuts > 0);
        const manaBits = [];
        if (dry.length) manaBits.push(`Ran out of mana: ${nameList([...dry], 'manaOuts')}`);
        if (starvedRows.length) {
            manaBits.push(
                `<span title="Mana under the cheapest ability they have been seen casting — the rotation stalls there, before the bar is empty.">Couldn’t afford a cast: ${nameList([...starvedRows], 'starvedOuts')}</span>`
            );
        }
        if (lowRows.length) {
            manaBits.push(
                `<span title="Mana under a fifth of the bar.">Low on mana: ${nameList([...lowRows], 'lowManaOuts')}</span>`
            );
        }
        const manaLine = manaBits.length
            ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">${manaBits.join(' · ')}</div>`
            : '';

        const buttons =
            `<div style="display:flex; gap:6px; margin-top:8px;">` +
            `<button data-action="copy" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(255,255,255,0.15); background:transparent; color:${DIM}; font-size:11px;">` +
            'Copy stats</button>' +
            `<button data-action="report" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid ${ACCENT}66; background:transparent; color:${ACCENT}; font-size:11px;">` +
            'Copy guild report</button>' +
            `<button data-action="restart" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(240,168,48,0.5); background:transparent; color:${WARN}; font-size:11px;">` +
            'End &amp; start new</button></div>';

        return (
            head +
            tabs +
            disclaimer +
            takenNote +
            ceilingNote +
            traceNote +
            list +
            footnote +
            manaLine +
            expected +
            buttons
        );
    }

    /**
     * One ranked row, with its bar — and, on the damage tab, the click-to-open
     * per-ability breakdown under it.
     *
     * @param {Object} row - From {@link scoreboardRows}
     * @param {Object} [classes] - Lowercased name → verdict, from `guildTrialAbilities.classes()`
     * @param {Map|null} [manaByName] - Lowercased name → support row
     * @param {Map|null} [abilitySplit] - Lowercased name → the stream's player
     *   row (carrying `abilities` and `damage`); null on tabs with no split
     * @param {number} [seconds] - The measurement window, for the per-ability rates
     * @returns {string} HTML
     */
    _rowHTML(row, classes = {}, manaByName = null, abilitySplit = null, seconds = 0) {
        // Every part of the drawing is the shared board's; what stays here is
        // the trial's own facts about a row — the colour comes from the
        // player's captured damage type, the marker beside the name comes
        // from what they were seen casting this trial, and a mana marker says
        // when their bar is empty, under their cheapest cast, or low right now
        const type = damageTypeOf(row.name);
        const key = String(row.name || '')
            .trim()
            .toLowerCase();
        const open = abilitySplit !== null && this.expanded.has(key);
        const caret =
            abilitySplit === null
                ? ''
                : `<span style="color:${DIM}; font-size:9px; margin-left:4px;">${open ? '▾' : '▸'}</span>`;
        const base = boardRowHTML(row, {
            color: type ? TYPE_COLORS[type] : ACCENT,
            tagHTML: classTagHTML(classes?.[key]) + manaMarkerHTML(manaByName?.get?.(key)) + caret,
        });
        if (abilitySplit === null) return base;

        const wrapped =
            `<div data-player="${escapeText(key)}" style="cursor:pointer;" ` +
            `title="Click for the per-ability breakdown.">${base}</div>`;
        if (!open) return wrapped;
        return wrapped + this._breakdownHTML(row.name, abilitySplit.get(key), seconds);
    }

    /**
     * One player's per-ability breakdown, or an honest line about not having one.
     *
     * The rows come from the same builder the DPS panel's expandable rows use
     * (`abilityBreakdownRows`), over the split the trial attribution already
     * keeps per ability — nothing is re-collected here. The share is of the
     * player's own stream-measured damage, which is also what the abilities sum
     * to; a game-stats row above it can carry a larger full-trial total, and the
     * breakdown is still only of the stretch the stream saw.
     *
     * @param {string} name - The player, for the empty line
     * @param {Object|undefined} player - The stream's row for them, if any
     * @param {number} seconds - The measurement window
     * @returns {string} HTML
     */
    _breakdownHTML(name, player, seconds) {
        const abilities = player?.abilities || [];
        if (!abilities.length) {
            return (
                `<div style="color:${DIM}; font-size:10px; padding:1px 6px 4px 26px; line-height:1.4;">` +
                `No breakdown captured for ${escapeText(name)} — the watched stream has not named their casts.</div>`
            );
        }

        const detailMap = dataManager.getInitClientData?.()?.abilityDetailMap;
        const lines = abilityBreakdownRows(abilities, { total: player?.damage || 0, seconds }).map((entry) =>
            abilityLineHTML(entry, { label: abilityActionLabel(entry.action, detailMap) })
        );
        return `<div style="margin:0 0 4px;">${lines.join('')}</div>`;
    }
}

const guildTrialScoreboard = new GuildTrialScoreboard();

export default guildTrialScoreboard;
export { guildTrialScoreboard };
