/**
 * Monster stat check — panel
 *
 * A floating panel that, when the setting is on, mirrors the in-game monster
 * detail panel: click a monster and the game emits `battle_unit_fetched` with
 * that unit's live combat details; this catches it, builds the same monster in
 * the sim, and shows the two columns side by side with a verdict on each gap.
 *
 * The arithmetic — which fields, how to back the room level out, how to tell a
 * live buff from a modelling bug — is in `monster-stat-check.js`. This owns the
 * DOM, the drag, the minimize, and the one thing that has to happen here rather
 * than there: building the sim monster, which needs live game data seeded first.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { setGameData } from '../combat-sim/engine/game-data.js';
import Monster from '../combat-sim/engine/monster.js';
import {
    deriveRoomLevel,
    buildComparison,
    buildExportPayload,
    captureContextMismatches,
    compareBuffProduction,
    buffSignature,
    buffedStatKeys,
    planBuffFold,
    simPlayerLabel,
    combatEffectNames,
    styleKeyOf,
    unionProducedBuffs,
} from './monster-stat-check.js';
import guildTrialDamage from '../guild/guild-trial-damage.js';
import { tierFromLevel } from '../guild/guild-trials-math.js';
import { tierMonsterHp } from '../guild/guild-trial-forecast.js';
import { describeFights, MIN_REAL_CASTS } from './labyrinth-uptime-harness.js';
import { downloadFile } from '../../utils/csv-export.js';
import labyrinthClearRate from './labyrinth-clear-rate.js';
import { captureFile, startCapture } from './labyrinth-tick-capture.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

const BLIND_VERDICT = {
    match: { glyph: '✓', color: '#6fce7f' },
    missing: { glyph: '⚠', color: '#e56b6b' },
    magnitude: { glyph: '≠', color: '#e0b64a' },
    stacks: { glyph: '×', color: 'rgba(255,255,255,0.6)' },
    notInSnapshot: { glyph: '·', color: 'rgba(255,255,255,0.4)' },
    // Legacy rows persisted before 'extra' was renamed to 'notInSnapshot'
    extra: { glyph: '·', color: 'rgba(255,255,255,0.4)' },
};

/** Hover text per blind verdict — what the glyph is claiming, in one line. */
const BLIND_TITLE = {
    match: 'match',
    missing: 'the game shows this effect; the sim never produced it across the probe fights',
    magnitude: 'both produce it, at different strength — a derivation gap',
    stacks: 'integer multiple of the single-stack strength — a stack-count difference, not a magnitude gap',
    notInSnapshot: 'not active in snapshot — the game column is one clicked instant, so this is timing, not modelling',
    extra: 'not active in snapshot',
};

/**
 * Probe runs unioned per blind-sim press. One run's fights can miss a
 * low-uptime effect, and "never produced" must keep meaning never. The runner
 * currently pins the probe's seed, so today's repeats coincide (each run
 * already spans five internal fights, unioned by the engine's capture sink);
 * the union here is what makes a seed-varied probe a drop-in improvement.
 */
const BLIND_PROBE_RUNS = 3;

const UPTIME_VERDICT = {
    ok: { glyph: '✓', color: '#6fce7f' },
    'sim-under': { glyph: '⚠', color: '#e56b6b' },
    'sim-over': { glyph: '≠', color: '#e0b64a' },
    'sim-missing': { glyph: '⚠', color: '#e56b6b' },
    'sim-extra': { glyph: '+', color: '#7aa2d0' },
    buff: { glyph: '·', color: 'rgba(255,255,255,0.4)' },
    inconclusive: { glyph: '?', color: 'rgba(255,255,255,0.35)' },
};

/** Hover text for the uptime verdicts that need more than their own name. */
const UPTIME_TITLE = {
    buff: 'non-damaging buff — not in the damage tally; verify via blind probe',
    inconclusive: `fewer than ${MIN_REAL_CASTS} real casts — too few to grade`,
};

/**
 * Why a guild trial boss gets no sim column beyond its health.
 *
 * The trial's health ladder is derived and verified here; its armour,
 * resistances, evasion, accuracy and max hit have no known per-tier law, and
 * the sim's own `difficultyTier` scaling is a different law that would invent
 * numbers if it were pointed at a trial tier.
 */
const TRIAL_NOT_MODELLED =
    'Trial scaling not modelled — only the health ladder is derived; the boss’s other ratings have no known tier law.';

const SETTING_KEY = 'labyrinthMonsterStatCheck';
const PANEL_ID = 'toolasha-monster-stat-check';

/**
 * Where the panel's top edge sits and how tall it may grow, both as fractions
 * of the visible viewport's height.
 *
 * They are constants rather than literals in the style string because the one
 * thing that can be wrong here is their sum, and a sum is checkable. It was
 * wrong: `top: 8%` with `max-height: 94vh` is 102% of the viewport, so the
 * bottom 2% — including the `resize: both` corner handle — was off screen on
 * every device, before the mobile address bar took its own slice on top. The
 * shared clamp never caught it: the panel is centred with a `transform`, and
 * `clampPanelToViewport` deliberately refuses transformed elements
 * (`panel-geometry.js`) because a viewport-relative `left` would move them.
 *
 * Measured against `--toolasha-visual-viewport-height` (published on `<html>`
 * by `src/utils/visual-viewport.js`) rather than `vh`, so the cap follows the
 * mobile address bar and keyboard instead of the layout viewport, which does
 * not move for either. `100vh` is the fallback where `visualViewport` is
 * missing. Both must read from the same height: an 8% top taken from the
 * layout viewport against a max-height taken from the visible one overflows
 * again the moment the two differ.
 *
 * `PANEL_HEIGHT_BUDGET` asserts the invariant — see the test.
 */
export const PANEL_TOP_FRACTION = 0.08;
/** Tallest the panel may grow, as a fraction of the visible viewport's height */
export const PANEL_MAX_HEIGHT_FRACTION = 0.88;
/** Fraction of the viewport the panel occupies at full height. Must stay below 1. */
export const PANEL_HEIGHT_BUDGET = PANEL_TOP_FRACTION + PANEL_MAX_HEIGHT_FRACTION;

/** The visible viewport's height, with a layout-viewport fallback */
const VIEWPORT_HEIGHT = 'var(--toolasha-visual-viewport-height, 100vh)';
const PANEL_KEY = 'monsterStatCheck';
/** Discrepancy records kept, deduped by monster+room, oldest evicted. */
const MAX_HISTORY = 100;
/** Where the log persists across refreshes. */
const STORE_NAME = 'labyrinth';
const STORE_KEY = 'monsterStatCheckLog';

const VERDICT_STYLE = {
    match: { glyph: '✓', color: '#6fce7f', label: 'match' },
    buff: { glyph: '↑', color: '#e0b64a', label: 'buff' },
    debuff: { glyph: '↓', color: '#e0b64a', label: 'debuff' },
    mismatch: { glyph: '⚠', color: '#e56b6b', label: 'off' },
    unknown: { glyph: '–', color: 'rgba(255,255,255,0.35)', label: '' },
};

/** @param {number|null} n */
function fmt(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString();
}

/** @param {number|null} pct */
function fmtDelta(pct) {
    if (pct == null || !Number.isFinite(pct)) return '';
    const sign = pct >= 0 ? '+' : '−';
    return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Coarse "how long ago" for the paging label. @param {number} [ts] */
function relTime(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
}

/**
 * Build the sim monster for a fetched unit, scaled to match the game's numbers.
 * Room level is recovered from the unit's defense so the sim scales identically;
 * a gap that remains is then a modelling difference, not a room-level mismatch.
 *
 * With `applyBuffs`, the unit's live effects are folded into the sim before it
 * computes stats (buffed-against-buffed); without it, the sim is the unbuffed
 * baseline. The game's combatBuffMap records are the engine's own buff shape —
 * `{ typeHrid, ratioBoost, flatBoost }` — so they land on the accuracy, evasion,
 * damage, armour and resistance ratings exactly as the game's did.
 *
 * @param {Object} gameUnit - The `unit` from a `battle_unit_fetched` payload
 * @param {boolean} applyBuffs - Whether to inject the unit's live effects
 * @returns {{monster: Monster, roomLevel: number, buffApplied: boolean}|null}
 */
function buildSimMonster(gameUnit, applyBuffs) {
    try {
        const hrid = gameUnit?.hrid;
        if (!hrid) return null;
        const payload = buildGameDataPayload();
        if (!payload) return null;
        setGameData(payload);

        const tier = Number(gameUnit?.difficultyTier) || 0;
        const gameDefense = Number(gameUnit?.combatDetails?.defenseLevel);
        const baseDefense = Number(payload.combatMonsterDetailMap?.[hrid]?.combatDetails?.defenseLevel);
        // Only labyrinth (tier 0) scales by room level; a higher-tier monster's
        // defense carries the tier multipliers and must not be read as one.
        const roomLevel = tier === 0 ? deriveRoomLevel(gameDefense, baseDefense) : 0;

        const monster = new Monster(hrid, tier, roomLevel, true);
        const buffMap = gameUnit?.combatBuffMap;
        const buffApplied = !!(applyBuffs && buffMap && typeof buffMap === 'object' && Object.keys(buffMap).length);
        if (buffApplied) monster.combatBuffs = { ...buffMap };
        monster.updateCombatDetails();
        return { monster, roomLevel, buffApplied };
    } catch (error) {
        console.error('[MonsterStatCheck] Failed to build sim monster:', error);
        return null;
    }
}

/**
 * Whether the fetched unit is a guild trial boss.
 *
 * A trial boss arrives on the same message as any other unit and reports
 * `difficultyTier: 0`, exactly like a labyrinth monster — so the tier field
 * cannot separate them. What can: the trial monsters live under
 * `/monsters/trial_*` and are named "Trial …", and while a trial is being
 * watched the damage module knows a trial battle is open (which is what catches
 * the Trial Swarm, whose four component monsters are named individually).
 *
 * @param {Object} gameUnit - The fetched unit
 * @returns {boolean}
 */
function isTrialUnit(gameUnit) {
    const hrid = String(gameUnit?.hrid || '');
    const name = String(gameUnit?.name || '');
    if (/^\/monsters\/trial_/.test(hrid) || /\btrial\b/i.test(name)) return true;
    // Read straight off the module rather than through `breakdown()`, which
    // rebuilds the whole damage split to answer three fields.
    return Boolean(guildTrialDamage?.active);
}

/**
 * The trial tier a boss is being fought at.
 *
 * The wire states it on `new_guild_battle`/`guild_battle_updated`, which the
 * damage module keeps; a bare `battle_unit_fetched` carries no tier at all, so
 * the fallback reads it back out of the boss's own combat level (T1 is Lv.100
 * and each tier is ten levels).
 *
 * @param {Object} gameUnit - The fetched unit
 * @returns {number} The tier, or 0 when it cannot be told
 */
function trialTierFor(gameUnit) {
    const stated = Number(guildTrialDamage?.tier) || 0;
    if (stated > 0) return stated;
    const level = Number(gameUnit?.combatDetails?.combatLevel) || 0;
    return level > 0 ? Number(tierFromLevel(level)) || 0 : 0;
}

/**
 * Where this unit was met: a guild trial, a regular combat zone, or a labyrinth
 * room. The three build genuinely different players and monsters, so the
 * decision has to be right before anything else runs.
 *
 * The order matters. A trial boss is checked first because it looks like a
 * labyrinth monster on every field the other two branches read. Then the tier:
 * **a tiered unit is never a labyrinth monster** — the labyrinth runs
 * everything at tier 0 — so a zone fight opened while a labyrinth run sits
 * paused (the header still says "Labyrinth") resolves as the zone it is.
 * Only an untiered unit falls back to the header, which is the same reading
 * `labyrinthClearRate.inLabyrinthFight()` takes.
 *
 * @param {Object} gameUnit - The fetched unit
 * @returns {{trial: {tier: number}}|{zone: {hrid: string, tier: number}}|null}
 *   The context, or null for the labyrinth
 */
function contextFor(gameUnit) {
    try {
        if (isTrialUnit(gameUnit)) return { trial: { tier: trialTierFor(gameUnit) } };
        const tier = Number(gameUnit?.difficultyTier) || 0;
        const action = (dataManager.getCurrentActions?.() || [])[0];
        const hrid = action?.actionHrid || null;
        const zoneHrid = hrid && /\/actions\/combat\//.test(hrid) && !/labyrinth/i.test(hrid) ? hrid : null;
        if (tier > 0) return zoneHrid ? { zone: { hrid: zoneHrid, tier } } : null;
        if (labyrinthClearRate.inLabyrinthFight()) return null;
        return zoneHrid ? { zone: { hrid: zoneHrid, tier } } : null;
    } catch {
        return null;
    }
}

/**
 * The probe context a stored snapshot carries: a guild trial, a zone fight, or
 * the labyrinth.
 * @param {Object} snap - A panel snapshot
 * @returns {Object|null}
 */
function probeContext(snap) {
    if (snap?.trial?.tier) return { trial: snap.trial };
    return snap?.zone?.hrid ? { zone: snap.zone } : null;
}

/**
 * What the sim can honestly say about a guild trial boss.
 *
 * Only one rung of the trial's scaling is derived and verified in this
 * codebase: the health ladder, `baseHp × (10 + level) / 110 × (1 + 0.01 ×
 * participants)` with `level = 100 + 10 × (tier − 1)` (see
 * guild-trial-forecast.js, checked against observed T2/T3 sheets). Nothing
 * anywhere derives a trial boss's armour, resistances, evasion, accuracy or max
 * hit per tier — the sim's `difficultyTier` law is a different law entirely and
 * feeding the trial tier to it would invent numbers. So this returns the one
 * row it can stand behind and leaves the rest empty, and the panel says so
 * rather than showing the blanks as a modelling gap.
 *
 * @param {Object} gameUnit - The fetched trial boss
 * @param {number} tier - The trial tier
 * @returns {{details: Object|null, participants: number|null}}
 */
function buildTrialSimDetails(gameUnit, tier) {
    try {
        const hrid = gameUnit?.hrid;
        const participants = Number(guildTrialDamage?.participants);
        const baseHp = Number(
            dataManager.getInitClientData()?.combatMonsterDetailMap?.[hrid]?.combatDetails?.maxHitpoints
        );
        if (!(tier > 0) || !(baseHp > 0) || !Number.isFinite(participants)) {
            return { details: null, participants: Number.isFinite(participants) ? participants : null };
        }
        const maxHitpoints = tierMonsterHp({ baseHp, tier, participants });
        return { details: maxHitpoints ? { maxHitpoints } : null, participants };
    } catch (error) {
        console.error('[MonsterStatCheck] Failed to derive the trial boss health:', error);
        return { details: null, participants: null };
    }
}

class MonsterStatCheckPanel {
    constructor() {
        this.container = null;
        this.body = null;
        this.header = null;
        this.titleEl = null;
        this.minimize = null;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.dragMoveHandler = null;
        this.dragUpHandler = null;
        /** The most recent comparison, for the console dump. */
        this.last = null;
        /** The snapshot currently on screen (live, or a history entry being browsed). */
        this.displayed = null;
        /** Recorded comparisons for the session, keyed by `${hrid}|${roomLevel}`. */
        this.history = new Map();
        /** Which history key is on screen, so the arrows know where they are. */
        this.viewKey = null;
        /** Paging filter: 'all' pages every view; 'discrepancies' only mismatches. */
        this.viewMode = 'all';
        /** 'buffed' compares with the unit's effects on the sim; 'baseline' without. */
        this.simMode = 'buffed';
        /**
         * Whether the player check folds your live combat buffs onto the sim
         * player ('folded') or shows the raw fight-start build ('raw'). Folded
         * by default — that is the like-for-like comparison — with the raw gap
         * one click away, because the gap itself is sometimes the finding.
         */
        this.foldMode = 'folded';
        /** Whether the pointer is over the panel, so arrows only steer it then. */
        this.hovered = false;
        this.keyHandler = null;
        /** Your last live combat stats (from clicking yourself), for the build check. */
        this.lastPlayerUnit = null;
        /** The player-build comparison result (panel-level, not per monster). */
        this.playerCheck = null;
        /**
         * Your `combatBuffMap` as the current fight opened, from `new_battle`.
         * The offense fold subtracts this so persistent ratios (guild damage,
         * the labyrinth combat-damage upgrade) — already in the sim's build —
         * are not applied to the sim column a second time. Null until a fight
         * starts while the feature is on; the fold then falls back to the whole
         * live map, its pre-delta behavior.
         */
        this.fightStartBuffMap = null;
    }

    /** Remember the character's live stats from a self-click, for the build check. */
    noteChar(unit) {
        this.lastPlayerUnit = unit;
        if (this.container && this.container.style.display !== 'none') this._render();
    }

    /**
     * Remember your buff map as a fight opens, for the offense fold's delta.
     * @param {Object} payload - A `new_battle` payload
     */
    noteBattleStart(payload) {
        const players = Array.isArray(payload?.players) ? payload.players : Object.values(payload?.players || {});
        if (!players.length) return;
        const characterId = dataManager.getCurrentCharacterId?.();
        const characterName = dataManager.getCurrentCharacterName?.();
        const mine =
            players.find((player) => characterId && player?.character?.id === characterId) ||
            players.find(
                (player) =>
                    characterName && (player?.character?.name === characterName || player?.name === characterName)
            ) ||
            (players.length === 1 ? players[0] : null);
        // A payload without a buff map (older shape, trimmed replay) resets to
        // null rather than keeping the previous fight's map, which would
        // subtract someone else's yesterday from today's fold
        this.fightStartBuffMap = mine?.combatBuffMap ? { ...mine.combatBuffMap } : null;
    }

    /**
     * Show (building on first use) and refresh for a freshly fetched monster.
     * A fresh click always jumps back to the live view, even if you were browsing
     * history a moment ago.
     * @param {Object} gameUnit
     */
    showFor(gameUnit) {
        // Where this unit was met: a guild trial, a regular zone (with its
        // tier), or the labyrinth. The probes build a different player for
        // each — the character as they stand for a zone or a trial, the lab
        // setup for a room — and a trial boss cannot be built by the sim at all
        const context = contextFor(gameUnit);
        const trial = context?.trial?.tier ? context.trial : null;

        // Build both views up front: the buffed sim (effects folded in — the
        // trustworthy like-for-like check) and the unbuffed baseline (raw sim
        // stats, so the effect the game applied is visible). The toggle then
        // switches between them, and both travel with the history entry.
        // A trial boss skips this entirely: its tier is not the sim's tier, so
        // building one would scale by the wrong law and report the difference
        // as a modelling gap.
        const trialSim = trial ? buildTrialSimDetails(gameUnit, trial.tier) : null;
        const baseBuilt = trial ? null : buildSimMonster(gameUnit, false);
        const buffedBuilt = trial ? null : buildSimMonster(gameUnit, true);
        const baseDetails = trial ? trialSim.details : baseBuilt?.monster?.combatDetails || null;
        const buffedDetails = trial ? trialSim.details : buffedBuilt?.monster?.combatDetails || null;
        const baselineCmp = buildComparison(gameUnit, baseDetails, { simBuffed: false });
        const buffedCmp = buildComparison(gameUnit, buffedDetails, {
            simBuffed: Boolean(buffedBuilt?.buffApplied),
        });
        this.last = {
            recordedAt: Date.now(),
            hrid: gameUnit?.hrid,
            name: gameUnit?.name,
            roomLevel: buffedBuilt?.roomLevel ?? baseBuilt?.roomLevel ?? 0,
            zone: context?.zone || null,
            trial,
            trialParticipants: trialSim?.participants ?? null,
            // A trial boss is "built" as far as the panel is concerned — the one
            // row it can stand behind is there — but the rest is unmodelled, not
            // broken, and the footer has to say which
            simBuilt: trial ? Boolean(trialSim.details) : Boolean(buffedBuilt?.monster?.combatDetails),
            // Kept so the blind-sim button can diff produced buffs against the live set.
            combatBuffMap: gameUnit?.combatBuffMap || {},
            buffs: buffedCmp.buffs,
            // The buffed verdict is canonical for the log, title and ordering.
            hasMismatch: buffedCmp.hasMismatch,
            buffed: { groups: buffedCmp.groups, hasMismatch: buffedCmp.hasMismatch, simBuffed: buffedCmp.simBuffed },
            baseline: { groups: baselineCmp.groups, hasMismatch: baselineCmp.hasMismatch, simBuffed: false },
        };
        this._record();
        this.displayed = this.last;
        this.viewKey = this._recordKey(this.last);

        this._ensureBuilt();
        this.container.style.display = 'flex';
        bringPanelToFront(this.container);
        this._render();
    }

    close() {
        if (this.container) this.container.style.display = 'none';
    }

    /** Whether there is anything recorded to reopen onto */
    get hasHistory() {
        return this.history.size > 0;
    }

    /**
     * Reopen onto the most recent comparison, or put the panel away.
     *
     * The only way in was clicking a monster in a tooltip, which both opens
     * the panel and takes a fresh reading — so there was no way to go back
     * and read the session's log without picking a fight with something.
     * This opens onto what is already recorded and takes no reading at all.
     * @returns {boolean} Whether the panel ended up open
     */
    toggle() {
        if (this.container && this.container.style.display !== 'none') {
            this.close();
            return false;
        }
        // Paging order, so the discrepancies the panel exists to surface
        // are what it opens onto
        const key = this._pagingKeys()[0] || this._orderedKeys()[0];
        const snap = key ? this.history.get(key) : null;
        if (!snap) return false;
        this.displayed = snap;
        this.viewKey = key;
        this._ensureBuilt();
        this.container.style.display = 'flex';
        bringPanelToFront(this.container);
        this._render();
        return true;
    }

    /**
     * Note the current comparison in the session log. Every clicked monster is
     * kept so the arrows can page back through them; deduped by monster and room
     * (a re-click refreshes that entry), capped so a long session can't grow
     * without bound.
     */
    /** Log key: monster + room + effect set, so each distinct buff state is kept. */
    _recordKey(snap) {
        return `${snap.hrid}|${snap.roomLevel}|${buffSignature(snap.combatBuffMap)}`;
    }

    _record() {
        if (!this.last?.hrid) return;
        const key = this._recordKey(this.last);
        // Every clicked monster is kept — the "⚠ only" filter changes what you
        // page through, never what is stored, so switching it can't lose views.
        // Re-insert so the map stays newest-last for eviction and paging.
        this.history.delete(key);
        this.history.set(key, this.last);
        while (this.history.size > MAX_HISTORY) {
            this.history.delete(this.history.keys().next().value);
        }
        this._persist();
    }

    /**
     * Keys to page through, honouring the "⚠ only" filter — discrepancies-first
     * ordering, optionally narrowed to just the mismatches.
     * @returns {string[]}
     */
    _pagingKeys() {
        const ordered = this._orderedKeys();
        return this.viewMode === 'discrepancies' ? ordered.filter((k) => this.history.get(k)?.hasMismatch) : ordered;
    }

    /**
     * Keys in paging order: discrepancies first (newest first by capture time),
     * then the clean views (newest first). So paging surfaces the mismatches
     * before anything else, and the ordering is by time rather than insertion
     * order — robust to entries restored from storage arriving out of order.
     * @returns {string[]}
     */
    _orderedKeys() {
        const entries = [...this.history.entries()];
        const byTimeDesc = (a, b) => (b[1].recordedAt || 0) - (a[1].recordedAt || 0);
        const sortedKeys = (predicate) =>
            entries
                .filter(([, s]) => predicate(s))
                .sort(byTimeDesc)
                .map(([k]) => k);
        return [...sortedKeys((s) => s.hasMismatch), ...sortedKeys((s) => !s.hasMismatch)];
    }

    /** Save the log and the view choices so a refresh keeps them. */
    _persist() {
        try {
            const payload = {
                mode: this.viewMode,
                simMode: this.simMode,
                foldMode: this.foldMode,
                entries: [...this.history.values()],
            };
            Promise.resolve(storage.set(STORE_KEY, payload, STORE_NAME)).catch(() => {});
        } catch {
            /* storage unavailable — the log simply stays in-memory */
        }
    }

    /** Restore a persisted log on start, without clobbering anything just clicked. */
    async _loadPersisted() {
        try {
            const saved = await storage.get(STORE_KEY, STORE_NAME, null);
            if (!saved) return;
            if (saved.mode === 'all' || saved.mode === 'discrepancies') this.viewMode = saved.mode;
            if (saved.simMode === 'buffed' || saved.simMode === 'baseline') this.simMode = saved.simMode;
            if (saved.foldMode === 'folded' || saved.foldMode === 'raw') this.foldMode = saved.foldMode;
            for (const entry of saved.entries || []) {
                if (!entry?.hrid) continue;
                // The same key the entry was recorded under — monster, room AND
                // buff signature. An earlier restore rebuilt only the first two,
                // which collapsed every distinct effect-state snapshot of one
                // monster/level down to the oldest and then persisted the loss.
                const key = this._recordKey(entry);
                if (!this.history.has(key)) this.history.set(key, entry);
            }
            if (this.container && this.displayed) this._render();
        } catch (error) {
            console.error('[MonsterStatCheck] Failed to load persisted log:', error);
        }
    }

    /** Page through recorded views. dir −1 is previous (Up), +1 is next (Down). */
    _navigate(dir) {
        const keys = this._pagingKeys();
        if (keys.length < 2) return;
        let index = keys.indexOf(this.viewKey);
        if (index === -1) index = 0;
        const next = Math.min(keys.length - 1, Math.max(0, index + dir));
        if (next === index) return;
        this.viewKey = keys[next];
        this.displayed = this.history.get(this.viewKey);
        this._render();
    }

    /** Wipe the log, keeping the current view on screen. */
    _clearHistory() {
        this.history.clear();
        this.viewKey = null;
        this._persist();
        this._render();
    }

    /** Flip the paging filter between all views and only the discrepancies. */
    _toggleViewMode() {
        this.viewMode = this.viewMode === 'all' ? 'discrepancies' : 'all';
        this._persist();
        this._render();
    }

    /** Flip the sim column between the buffed and the unbuffed-baseline view. */
    _toggleSimMode() {
        this.simMode = this.simMode === 'buffed' ? 'baseline' : 'buffed';
        this._persist();
        this._render();
    }

    /** Flip the player check between the buff-folded sim and the raw one. */
    _toggleFoldMode() {
        this.foldMode = this.foldMode === 'folded' ? 'raw' : 'folded';
        this._persist();
        this._render();
    }

    /** The player-check view the fold toggle is asking for, with a fallback. */
    _playerView() {
        const pc = this.playerCheck;
        if (!pc) return null;
        return (this.foldMode === 'folded' ? pc.folded : pc.raw) || pc.folded || pc.raw || null;
    }

    /**
     * Run blind sim fights for the shown monster and diff the buffs the sim
     * produces on its own against the game's live effects. Several probe runs,
     * produced-effects unioned (see BLIND_PROBE_RUNS) — the probe sims are
     * short, so the repeats stay well under a button press's patience.
     */
    async _runBlindSim() {
        const snap = this.displayed;
        if (!snap?.hrid) return;
        if (snap.trial) {
            snap.blind = { rows: [], ran: false, notModelled: true, at: Date.now() };
            this._render();
            return;
        }
        const simPlayer = this._simPlayerSource(snap);
        try {
            const runs = [];
            let ran = false;
            for (let n = 0; n < BLIND_PROBE_RUNS; n++) {
                const probe = await labyrinthClearRate.blindBuffProbe(snap.hrid, snap.roomLevel, probeContext(snap));
                if (probe?.ran) {
                    ran = true;
                    runs.push(probe.produced || []);
                }
            }
            snap.blind = {
                rows: compareBuffProduction(snap.combatBuffMap || {}, unionProducedBuffs(runs)),
                ran,
                simPlayer,
                at: Date.now(),
            };
        } catch (error) {
            console.error('[MonsterStatCheck] Blind sim failed:', error);
            snap.blind = { rows: [], ran: false, simPlayer, at: Date.now() };
        }
        // Only re-render if this snapshot is still the one on screen.
        if (this.displayed === snap) this._render();
        this._persist();
    }

    /**
     * Decompose the monster's incoming damage per ability from the armed tick
     * capture and compare it against the sim, to localise a timing/uptime gap.
     */
    async _runUptimeHarness() {
        const snap = this.displayed;
        if (!snap?.hrid) return;
        if (snap.trial) {
            snap.uptime = { notModelled: true };
            this._render();
            return;
        }
        const simPlayer = this._simPlayerSource(snap);
        try {
            const capture = captureFile();
            // The build the sim would run with right now — the same fingerprint
            // the fight recorder pools by. Ticks fought in other gear compared
            // against a sim of this gear read as findings that are really a
            // loadout change.
            const fingerprint = labyrinthClearRate._snapshotContentFingerprint?.() || null;
            // A capture is usable if it holds ticks and matches this monster,
            // this room level AND this build (unlabelled fields pass) —
            // comparing ticks from one context against a sim of another reads
            // as a finding when it is a context mismatch.
            const mismatches = captureContextMismatches(capture?.context, {
                monsterHrid: snap.hrid,
                roomLevel: snap.roomLevel,
                fingerprint,
            });
            const usable = capture?.ticks?.length && mismatches.length === 0;
            if (usable) {
                const result = await labyrinthClearRate.uptimeHarness(
                    snap.hrid,
                    snap.roomLevel,
                    capture.ticks,
                    probeContext(snap)
                );
                snap.uptime = result
                    ? {
                          simPlayer,
                          rows: result.comparison.rows,
                          // The other direction, from the same capture and the
                          // same sim run: the sim's model of YOUR abilities.
                          outgoingRows: result.outgoing?.comparison?.rows || null,
                          fightsLabel: describeFights(result.real),
                          at: Date.now(),
                      }
                    : { error: 'Sim run failed.' };
            } else {
                // Arm a capture bound to this monster, room and build. When a
                // held capture was refused, name what differed rather than
                // silently starting over.
                startCapture({ monsterHrid: snap.hrid, roomLevel: snap.roomLevel, fingerprint });
                const refusal = capture?.ticks?.length
                    ? `Held capture is from a different ${mismatches.join(' / ')} — starting a fresh one. `
                    : '';
                snap.uptime = {
                    armed: true,
                    message: `${refusal}Capturing — fight this monster, then click “Run uptime harness” again.`,
                };
            }
        } catch (error) {
            console.error('[MonsterStatCheck] Uptime harness failed:', error);
            snap.uptime = { error: 'Uptime harness failed (see console).' };
        }
        if (this.displayed === snap) this._render();
    }

    /**
     * Compare the sim's build of your character against your live in-game stats,
     * to catch a player-init bug (gear, ability levels, applied buffs) directly.
     */
    async _runPlayerCheck() {
        if (!this.lastPlayerUnit) {
            this.playerCheck = { error: 'Click yourself in combat first, so I have your live stats.' };
            this._render();
            return;
        }
        const snap = this.displayed;
        if (!snap?.hrid) {
            this.playerCheck = { error: 'Open a monster’s panel first — the sim needs a fight to build the player.' };
            this._render();
            return;
        }
        try {
            const context = probeContext(snap);
            const source = labyrinthClearRate.probeSource(snap.hrid, context);
            const buffMap = this.lastPlayerUnit?.combatBuffMap;
            // What to hand the sim player so both sides carry the same effects:
            // the per-type delta between your live buffs and the ones the fight
            // opened with (the latter are already inside the sim's build).
            const fold = planBuffFold(buffMap, this.fightStartBuffMap);
            const probe = await labyrinthClearRate.simPlayerDetails(snap.hrid, snap.roomLevel, context, fold.buffs);
            // Tolerate the pre-fold flat shape, so a stubbed or older runner
            // still produces the raw column rather than an error
            const base = probe?.base || (probe && !probe.buffed && probe.combatStats ? probe : null);
            if (!base) {
                this.playerCheck = { error: 'Sim player build failed.' };
            } else {
                const styleKey = styleKeyOf(this.lastPlayerUnit?.combatDetails?.combatStats);
                // Raw: the sim's fight-start build against your buffed live
                // sheet — every self-buff shows as a gap, which is the view the
                // fold exists to replace but still the one that shows its size.
                // Buff-aware leniency keeps those rows reading as buffs.
                const raw = buildComparison(this.lastPlayerUnit, base, {
                    simBuffed: false,
                    leniencyKeys: buffedStatKeys(buffMap, styleKey),
                });
                // Folded: buffed against buffed, graded sharply. The fold is
                // applied as per-type targets in the engine (only the difference
                // over what the sim already holds), so a persistent buff can no
                // longer be counted twice and no leniency is needed.
                const folded = probe?.buffed
                    ? buildComparison(this.lastPlayerUnit, probe.buffed, { simBuffed: true, leniencyKeys: null })
                    : null;
                this.playerCheck = {
                    raw: { groups: raw.groups, hasMismatch: raw.hasMismatch, buffs: raw.buffs },
                    folded: folded
                        ? { groups: folded.groups, hasMismatch: folded.hasMismatch, buffs: folded.buffs }
                        : null,
                    fold: {
                        folded: fold.folded,
                        inBuild: fold.inBuild,
                        notModelled: fold.notModelled,
                        hasStartMap: fold.hasStartMap,
                    },
                    source,
                    effects: combatEffectNames(buffMap),
                    at: Date.now(),
                };
                this._logHpGap(base);
            }
        } catch (error) {
            console.error('[MonsterStatCheck] Player check failed:', error);
            this.playerCheck = { error: 'Player check failed (see console).' };
        }
        this._render();
    }

    /**
     * When Max HP disagrees, the term-by-term breakdown says which input differs
     * — stamina level, the flat HP from gear, or a % HP buff — which is the
     * actual lead, not the total. Logged against the *unfolded* sim build, so
     * the buff carrying the gap is still visible as a gap. Console only.
     * @param {Object} simDetails - The sim player's fight-start combatDetails
     */
    _logHpGap(simDetails) {
        const hpTerms = (cd) => ({
            staminaLevel: cd?.staminaLevel,
            flatMaxHp: cd?.combatStats?.maxHitpoints,
            maxHpRatio: cd?.combatStats?.maxHitpointsRatio,
            maxHitpoints: cd?.maxHitpoints,
        });
        const you = hpTerms(this.lastPlayerUnit?.combatDetails);
        const sim = hpTerms(simDetails);
        if (!you.maxHitpoints || !sim.maxHitpoints) return;
        if (Math.abs(you.maxHitpoints - sim.maxHitpoints) / you.maxHitpoints <= 0.01) return;
        console.log('[MonsterStatCheck] Max HP gap — you vs sim, by input term:');
        console.table({ you, sim });
        // The buff carrying the missing HP ratio — its typeHrid is what the
        // engine has to map. List the ones with a nonzero boost.
        const buffs = Object.entries(this.lastPlayerUnit?.combatBuffMap || {})
            .map(([uniqueHrid, b]) => ({
                uniqueHrid,
                typeHrid: b?.typeHrid,
                ratioBoost: b?.ratioBoost,
                flatBoost: b?.flatBoost,
            }))
            .filter((b) => b.ratioBoost || b.flatBoost);
        if (buffs.length) {
            console.log('[MonsterStatCheck] Your active buffs (find the max-HP one — its typeHrid is the fix):');
            console.table(buffs);
        }
    }

    /**
     * The player-build result plus the raw live buffs behind it, for export.
     * The buff map is what pins a build gap — an accuracy or max-HP delta is
     * almost always a live buff the sim did not seed, so ship it alongside the
     * comparison rather than making the reader guess.
     * @returns {Object|null}
     */
    _playerBuildForExport() {
        if (!this.playerCheck) return null;
        return {
            ...this.playerCheck,
            playerBuffMap: this.lastPlayerUnit?.combatBuffMap || null,
            // What the fold deltas against, so a reader can re-derive it —
            // null means the fold ran against the whole live map
            fightStartBuffMap: this.fightStartBuffMap || null,
        };
    }

    /**
     * Which player the sim was built from for the view on screen, in the shape
     * the export carries. Read from the same accessor the probes use, so the
     * label and the run can never disagree.
     * @param {Object} [snap] - The snapshot to name a source for
     * @returns {{source: string, zoneHrid: string|null, tier: number, loadoutName: string|null}|null}
     */
    _simPlayerSource(snap = this.displayed) {
        if (!snap?.hrid) return null;
        try {
            return labyrinthClearRate.probeSource(snap.hrid, probeContext(snap));
        } catch (error) {
            console.error('[MonsterStatCheck] Failed to name the sim player source:', error);
            return null;
        }
    }

    /** Download the session's discrepancy log plus the current snapshot as JSON. */
    _export() {
        const source = this.playerCheck?.source || this._simPlayerSource();
        const payload = buildExportPayload(
            Array.from(this.history.values()),
            this.last,
            Date.now(),
            this._playerBuildForExport(),
            source
                ? {
                      source: source.source,
                      zoneHrid: source.zoneHrid ?? null,
                      tier: Number(source.tier) || 0,
                      loadoutName: source.loadoutName ?? null,
                  }
                : null
        );
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadFile(`toolasha-monster-stat-check-${stamp}.json`, JSON.stringify(payload), 'application/json');
    }

    /** @returns {Object|null} The most recent comparison, for the console. */
    dump() {
        const view = this.last?.buffed || (this.last?.groups ? this.last : null);
        if (this.last && view) {
            const rows = view.groups.flatMap((g) =>
                g.rows.map((r) => ({
                    group: g.group,
                    stat: r.label,
                    game: r.game,
                    sim: r.sim,
                    delta: r.deltaPct == null ? '' : `${r.deltaPct.toFixed(1)}%`,
                    verdict: r.verdict,
                }))
            );
            console.log(
                `[MonsterStatCheck] ${this.last.name || this.last.hrid} (room ${this.last.roomLevel})`,
                this.last.buffs.length ? `buffs: ${this.last.buffs.join(', ')}` : 'no buffs'
            );
            console.table(rows);
        }
        return this.last;
    }

    /** @returns {Array<Object>} The session discrepancy log, newest last. */
    logEntries() {
        return Array.from(this.history.values());
    }

    /** Build a plain-text rendering of the view on screen, for the clipboard. */
    _copyText(snapshot) {
        if (!snapshot) return '';
        const view =
            snapshot[this.simMode] || snapshot.buffed || snapshot.baseline || (snapshot.groups ? snapshot : null);
        const lines = [];
        const room = snapshot.roomLevel > 0 ? ` — Room ${snapshot.roomLevel}` : '';
        lines.push(`${snapshot.name || 'Monster'}${room}  (sim: ${this.simMode})`);
        if (view) {
            for (const g of view.groups) {
                lines.push(`[${g.group}]`);
                for (const r of g.rows) {
                    const d = r.deltaPct == null ? '' : ` (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%)`;
                    lines.push(`  ${r.label}: game ${fmt(r.game)} / sim ${fmt(r.sim)}${d} — ${r.verdict}`);
                }
            }
        }
        if (snapshot.buffs?.length) lines.push(`Active effects: ${snapshot.buffs.join(', ')}`);
        if (snapshot.blind?.rows?.length) {
            lines.push('Blind sim — buffs it produces (game / sim):');
            for (const r of snapshot.blind.rows) {
                lines.push(`  ${r.name}: ${this._blindBoost(r.game)} / ${this._blindBoost(r.sim)} — ${r.verdict}`);
            }
        }
        if (snapshot.uptime?.rows?.length) {
            const fights = snapshot.uptime.fightsLabel ? ` (${snapshot.uptime.fightsLabel})` : '';
            const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);
            const pushRows = (rows) => {
                for (const r of rows) {
                    const rd = pct(r.real?.dmgSharePct);
                    const sd = pct(r.sim?.dmgSharePct);
                    const rc = pct(r.real?.castSharePct);
                    const sc = pct(r.sim?.castSharePct);
                    const n = r.samples != null ? `, n=${r.samples}` : '';
                    lines.push(`  ${r.ability}: dmg ${rd}/${sd}, cast ${rc}/${sc}${n} — ${r.verdict}`);
                }
            };
            lines.push(`Uptime harness — incoming damage / ability (real vs sim)${fights}:`);
            pushRows(snapshot.uptime.rows);
            if (snapshot.uptime.outgoingRows?.length) {
                lines.push(`Uptime harness — outgoing damage / ability (real vs sim)${fights}:`);
                pushRows(snapshot.uptime.outgoingRows);
            }
        }
        return lines.join('\n');
    }

    /** The player-build (you vs sim) section as text, or '' if never run. */
    _playerBuildText() {
        const pc = this.playerCheck;
        if (!pc) return '';
        if (pc.error) return `Player build — you vs sim: ${pc.error}`;
        const view = this._playerView();
        const mode = this.foldMode === 'folded' && pc.folded ? 'buffs folded into sim' : 'raw sim build';
        const lines = [`Player build — you vs sim (${mode}):`];
        const label = simPlayerLabel(pc.source);
        if (label) lines.push(label);
        for (const g of view?.groups || []) {
            lines.push(`[${g.group}]`);
            for (const r of g.rows) {
                const d = r.deltaPct == null ? '' : ` (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%)`;
                lines.push(`  ${r.label}: you ${fmt(r.game)} / sim ${fmt(r.sim)}${d} — ${r.verdict}`);
            }
        }
        if (pc.fold?.folded?.length) lines.push(`Folded into the sim: ${pc.fold.folded.join(', ')}`);
        if (pc.fold?.notModelled?.length) lines.push(`Not modelled by the sim: ${pc.fold.notModelled.join(', ')}`);
        if (view?.buffs?.length) lines.push(`Your active buffs: ${view.buffs.join(', ')}`);
        return lines.join('\n');
    }

    /**
     * Copy the whole session to the clipboard as text, with a brief ✓ on the
     * button — the player build, then every monster checked (not just the one on
     * screen), so one paste carries the full sim-vs-real picture to a bug report.
     */
    _copyToClipboard(btn) {
        const parts = [];
        const playerText = this._playerBuildText();
        if (playerText) parts.push(playerText);

        const entries = Array.from(this.history.values());
        // Include the on-screen monster even if it was never logged as a record.
        const seen = new Set(entries.map((e) => `${e.hrid}:${e.roomLevel}`));
        if (this.displayed && !seen.has(`${this.displayed.hrid}:${this.displayed.roomLevel}`)) {
            entries.push(this.displayed);
        }
        for (const entry of entries) {
            const text = this._copyText(entry);
            if (text) parts.push(text);
        }

        const joined = parts.join(`\n\n${'─'.repeat(32)}\n\n`);
        if (!joined || !navigator.clipboard) return;
        navigator.clipboard
            .writeText(joined)
            .then(() => {
                btn.textContent = '✓';
                setTimeout(() => (btn.textContent = '⧉'), 1200);
            })
            .catch((error) => console.error('[MonsterStatCheck] Copy failed:', error));
    }

    _ensureBuilt() {
        if (this.container) return;

        const container = document.createElement('div');
        container.id = PANEL_ID;
        container.style.cssText = `
            position: fixed;
            top: calc(${VIEWPORT_HEIGHT} * ${PANEL_TOP_FRACTION});
            left: 50%;
            transform: translateX(-50%);
            z-index: ${config.Z_FLOATING_PANEL};
            width: 340px;
            min-width: 260px;
            min-height: 140px;
            display: flex;
            flex-direction: column;
            /* Height grows to fit the content (header + body), so a full readout
               shows without a scrollbar; capped so the panel's bottom edge —
               the resize handle included — stays on screen once the top offset
               above is paid for, and resizable from the corner. */
            max-height: calc(${VIEWPORT_HEIGHT} * ${PANEL_MAX_HEIGHT_FRACTION});
            resize: both;
            background: rgba(10, 10, 20, 0.96);
            border: 2px solid ${config.COLOR_ACCENT};
            border-radius: 8px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.8);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #fff;
            user-select: none;
            overflow: hidden;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            cursor: grab;
            background: rgba(255,255,255,0.04);
            flex-shrink: 0;
        `;

        const title = document.createElement('span');
        title.style.cssText = `font-size: 0.85rem; font-weight: 600; color: ${config.COLOR_ACCENT}; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
        title.textContent = 'Monster Stat Check';

        const controls = document.createElement('div');
        controls.style.cssText = 'display: flex; align-items: center; flex-shrink: 0;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '⧉';
        copyBtn.title = 'Copy all results (player build + every monster) to the clipboard (as text)';
        copyBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 4px;`;
        copyBtn.addEventListener('mouseenter', () => (copyBtn.style.color = '#fff'));
        copyBtn.addEventListener('mouseleave', () => (copyBtn.style.color = '#aaa'));
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._copyToClipboard(copyBtn);
        });

        const exportBtn = document.createElement('button');
        exportBtn.textContent = '⭳';
        exportBtn.title = 'Export the session’s discrepancy log (JSON)';
        exportBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1rem; line-height: 1; cursor: pointer; padding: 0 4px;`;
        exportBtn.addEventListener('mouseenter', () => (exportBtn.style.color = '#fff'));
        exportBtn.addEventListener('mouseleave', () => (exportBtn.style.color = '#aaa'));
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._export();
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.title = 'Close';
        closeBtn.style.cssText = `background: none; border: none; color: #aaa; font-size: 1.2rem; line-height: 1; cursor: pointer; padding: 0 2px;`;
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#fff'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#aaa'));
        closeBtn.addEventListener('click', () => this.close());

        controls.appendChild(copyBtn);
        controls.appendChild(exportBtn);
        controls.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(controls);

        const body = document.createElement('div');
        body.style.cssText = `flex: 1; overflow-y: auto; padding: 10px 12px;`;

        container.appendChild(header);
        container.appendChild(body);
        document.body.appendChild(container);
        registerFloatingPanel(container);

        this.container = container;
        this.header = header;
        this.body = body;
        this.titleEl = title;

        this.minimize = attachMinimize({
            panel: container,
            header,
            body,
            panelKey: PANEL_KEY,
            beforeEl: closeBtn,
            restore: false,
        });

        this._setupDragging(header);

        // Arrows page through history, but only while the pointer is over the
        // panel — otherwise they'd fight the game's own keyboard handling.
        container.addEventListener('pointerenter', () => (this.hovered = true));
        container.addEventListener('pointerleave', () => (this.hovered = false));
        this.keyHandler = (e) => {
            if (!this.hovered || this.container?.style.display === 'none' || this.minimize?.collapsed) return;
            if (e.key === 'ArrowUp') {
                this._navigate(-1);
                e.preventDefault();
            } else if (e.key === 'ArrowDown') {
                this._navigate(1);
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', this.keyHandler);
    }

    /** A small header-style icon button for the nav bar. */
    _navButton(glyph, title, onClick, enabled) {
        const b = document.createElement('button');
        b.textContent = glyph;
        b.title = title;
        b.disabled = !enabled;
        b.style.cssText = `background:none; border:none; color:${enabled ? '#aaa' : 'rgba(255,255,255,0.2)'}; font-size:0.8rem; cursor:${enabled ? 'pointer' : 'default'}; padding:0 2px; line-height:1;`;
        if (enabled) {
            b.addEventListener('mouseenter', () => (b.style.color = '#fff'));
            b.addEventListener('mouseleave', () => (b.style.color = '#aaa'));
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
            });
        }
        return b;
    }

    /** A small text pill button for the nav bar (store toggle, Clear). */
    _pillButton(text, title, onClick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText =
            'background:none; border:1px solid rgba(255,255,255,0.15); border-radius:4px; color:#aaa; font-size:0.64rem; cursor:pointer; padding:1px 5px; white-space:nowrap;';
        b.addEventListener('mouseenter', () => (b.style.color = '#fff'));
        b.addEventListener('mouseleave', () => (b.style.color = '#aaa'));
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    /**
     * The paging bar. The controls (view filter, sim toggle, Clear) always show
     * so they can never strand the user; the arrows and position only appear once
     * there is something to page through.
     */
    _renderNav(body) {
        const keys = this._pagingKeys();
        const total = keys.length;
        const index = keys.indexOf(this.viewKey);
        const misCount = [...this.history.values()].filter((s) => s.hasMismatch).length;

        const nav = document.createElement('div');
        nav.style.cssText =
            'display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-bottom:8px; font-size:0.7rem; color:rgba(255,255,255,0.55);';

        if (total > 0) {
            nav.appendChild(this._navButton('▲', 'Previous (↑)', () => this._navigate(-1), index > 0));
            nav.appendChild(this._navButton('▼', 'Next (↓)', () => this._navigate(1), index >= 0 && index < total - 1));
        }

        const label = document.createElement('span');
        label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        if (!total) {
            label.innerHTML =
                this.viewMode === 'discrepancies'
                    ? 'no discrepancies logged'
                    : `<span style="opacity:0.6;">nothing recorded yet</span>`;
        } else {
            const pos = index === -1 ? `${total}` : `${index + 1} / ${total}`;
            const mis = misCount ? ` · <span style="color:#e56b6b;">⚠ ${misCount}</span>` : '';
            const rel = index >= 0 ? relTime(this.displayed?.recordedAt) : '';
            label.innerHTML = `${pos}${mis}${rel ? ` · ${rel}` : ''}`;
        }
        nav.appendChild(label);

        nav.appendChild(
            this._pillButton(
                this.simMode === 'buffed' ? 'Sim: buffed' : 'Sim: baseline',
                'Compare against the sim with the unit’s effects applied (buffed) or the unbuffed baseline',
                () => this._toggleSimMode()
            )
        );
        nav.appendChild(
            this._pillButton(
                this.viewMode === 'all' ? 'Show: all' : 'Show: ⚠ only',
                'Page through every recorded view, or only the discrepancies (nothing is deleted)',
                () => this._toggleViewMode()
            )
        );
        nav.appendChild(this._pillButton('Clear', 'Clear the session log', () => this._clearHistory()));

        body.appendChild(nav);
    }

    _render() {
        const snapshot = this.displayed;
        if (!snapshot) return;
        const body = this.body;
        body.innerHTML = '';
        const { name, roomLevel, buffs, simBuilt } = snapshot;
        // Pick the requested view; fall back through buffed/baseline, and for an
        // entry persisted before the two-view split, treat the snapshot itself.
        const view =
            snapshot[this.simMode] || snapshot.buffed || snapshot.baseline || (snapshot.groups ? snapshot : null);
        if (!view) return;
        const { groups, simBuffed } = view;
        const hasMismatch = view.hasMismatch;

        // Title carries the monster, its room level, and a ⚠ when this view is off
        const levelLabel = snapshot.trial?.tier
            ? ` — Guild trial T${snapshot.trial.tier}`
            : roomLevel > 0
              ? ` — Room ${roomLevel}`
              : '';
        const flag = snapshot.hasMismatch ? '⚠ ' : '';
        this.titleEl.textContent = `${flag}${name || 'Monster'}${levelLabel}`;
        this.titleEl.style.color = snapshot.hasMismatch ? '#e56b6b' : config.COLOR_ACCENT;

        this._renderNav(body);

        // Column header: Stat | Game | Sim | Δ
        body.appendChild(
            this._rowEl({ label: 'Stat', game: 'Game', sim: 'Sim', delta: '', verdict: null }, { headerRow: true })
        );

        if (snapshot.trial) {
            // A trial boss is not "unbuilt" — it is deliberately only partly
            // modelled, and saying so is the whole point of the branch.
            const note = document.createElement('div');
            note.style.cssText = 'font-size: 0.72rem; color: #e0b64a; padding: 6px 0; font-style: italic;';
            note.textContent = `Trial boss at T${snapshot.trial.tier} (trial scaling). ${TRIAL_NOT_MODELLED}`;
            body.appendChild(note);
            if (!simBuilt) {
                body.appendChild(
                    this._caption(
                        snapshot.trialParticipants == null
                            ? 'Health not derived either: the participant count is unknown until a trial battle is seen.'
                            : 'Health could not be derived for this boss.',
                        'rgba(255,255,255,0.45)'
                    )
                );
            } else {
                body.appendChild(
                    this._caption(
                        `Health from the trial ladder: base × (10 + level)/110 × (1 + 0.01 × ${snapshot.trialParticipants} participants).`,
                        'rgba(255,255,255,0.45)'
                    )
                );
            }
        } else if (!simBuilt) {
            const warn = document.createElement('div');
            warn.style.cssText = 'font-size: 0.72rem; color: #e56b6b; padding: 8px 0; font-style: italic;';
            warn.textContent = 'Sim could not build this monster — showing game values only.';
            body.appendChild(warn);
        }

        for (const group of groups) {
            const heading = document.createElement('div');
            heading.style.cssText = `font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.4); margin: 8px 0 2px;`;
            heading.textContent = group.group;
            body.appendChild(heading);

            for (const row of group.rows) {
                body.appendChild(
                    this._rowEl({
                        label: row.label,
                        game: fmt(row.game),
                        sim: fmt(row.sim),
                        delta: fmtDelta(row.deltaPct),
                        verdict: row.verdict,
                    })
                );
            }
        }

        // Footer: active buffs and the legend that reads a gap.
        const footer = document.createElement('div');
        footer.style.cssText = `margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 0.7rem; line-height: 1.5; color: rgba(255,255,255,0.55);`;

        const buffLine = document.createElement('div');
        if (buffs.length) {
            const applied = simBuffed ? ' (applied to sim)' : '';
            buffLine.innerHTML = `<span style="color:#e0b64a;">Active effects${applied}:</span> ${buffs.join(', ')}`;
        } else {
            buffLine.textContent = 'No active effects — clean baseline; every row should match.';
        }
        footer.appendChild(buffLine);

        const legend = document.createElement('div');
        legend.style.cssText = 'margin-top: 4px;';
        if (simBuffed) {
            // The sim carries the effects too, so every row is a like-for-like check.
            legend.innerHTML = hasMismatch
                ? '<span style="color:#e56b6b;">⚠ off</span> = game and sim disagree with the same effects applied — a real modelling gap.'
                : 'Sim built with the active effects applied — every row matches, so the sim models this monster and its effects correctly.';
        } else {
            legend.innerHTML = hasMismatch
                ? '<span style="color:#e56b6b;">⚠ off</span> = a gap with no active effect to explain it — the sim may be wrong here.'
                : 'No active effects, so the sim’s baseline is compared directly.';
        }
        footer.appendChild(legend);

        this._renderBlind(footer, snapshot);
        this._renderUptime(footer, snapshot);
        this._renderPlayerCheck(footer);

        body.appendChild(footer);
    }

    /** A small caption line under a section heading. */
    _caption(text, color = 'rgba(255,255,255,0.45)') {
        const el = document.createElement('div');
        el.style.cssText = `font-size:0.66rem; color:${color}; margin-bottom:2px;`;
        el.textContent = text;
        return el;
    }

    /** The player-build section: a Check button, and your-vs-sim stat diff. */
    _renderPlayerCheck(footer) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);';

        const pc = this.playerCheck;
        if (pc) {
            const head = document.createElement('div');
            head.style.cssText =
                'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin-bottom:2px;';
            head.textContent = 'Player build — you vs sim';
            wrap.appendChild(head);

            // Which player the sim actually built, said plainly. Without it a
            // reader cannot tell a modelling gap from a comparison against the
            // labyrinth loadout when they were standing in a zone.
            const sourceLabel = simPlayerLabel(pc.source);
            if (sourceLabel) wrap.appendChild(this._caption(sourceLabel, 'rgba(255,255,255,0.55)'));

            if (pc.error) {
                const err = document.createElement('div');
                err.style.cssText = 'font-size:0.72rem; color:#e0b64a; font-style:italic;';
                err.textContent = pc.error;
                wrap.appendChild(err);
            } else {
                const view = this._playerView();
                const foldable = Boolean(pc.folded);
                const folding = foldable && this.foldMode === 'folded';

                const toggle = this._pillButton(
                    folding ? 'Fold my active buffs: on' : 'Fold my active buffs: off',
                    foldable
                        ? 'Apply your live combat buffs to the sim player so both columns carry the same effects, or compare against the raw fight-start build'
                        : 'The sim did not return a buffed build — showing the raw one',
                    () => this._toggleFoldMode()
                );
                toggle.style.marginBottom = '4px';
                if (!foldable) toggle.disabled = true;
                wrap.appendChild(toggle);

                if (view) {
                    wrap.appendChild(
                        this._rowEl(
                            { label: 'Stat', game: 'You', sim: 'Sim', delta: '', verdict: null },
                            { headerRow: true }
                        )
                    );
                    for (const group of view.groups) {
                        const heading = document.createElement('div');
                        heading.style.cssText =
                            'font-size:0.66rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.35); margin:6px 0 1px;';
                        heading.textContent = group.group;
                        wrap.appendChild(heading);
                        for (const row of group.rows) {
                            wrap.appendChild(
                                this._rowEl({
                                    label: row.label,
                                    game: fmt(row.game),
                                    sim: fmt(row.sim),
                                    delta: fmtDelta(row.deltaPct),
                                    verdict: row.verdict,
                                })
                            );
                        }
                    }
                }

                // What the fold did with each of your live effects, named. A
                // buff the sim has no term for is called out rather than
                // dropped — that silence is how a modelling hole hides.
                const fold = pc.fold || {};
                if (folding && fold.folded?.length) {
                    const fx = document.createElement('div');
                    fx.style.cssText = 'margin-top:4px; font-size:0.66rem; color:rgba(255,255,255,0.55);';
                    fx.innerHTML = `<span style="color:#e0b64a;">Folded into the sim:</span> ${fold.folded.join(', ')}`;
                    wrap.appendChild(fx);
                }
                if (folding && fold.inBuild?.length) {
                    wrap.appendChild(
                        this._caption(`Already in the sim’s build: ${fold.inBuild.join(', ')}`, 'rgba(255,255,255,0.4)')
                    );
                }
                if (fold.notModelled?.length) {
                    const nm = document.createElement('div');
                    nm.style.cssText = 'margin-top:2px; font-size:0.66rem; color:#e0b64a;';
                    nm.textContent = `Not modelled by the sim: ${fold.notModelled.join(', ')}`;
                    nm.title = 'The sim engine has no term for these buff types, so neither column carries them';
                    wrap.appendChild(nm);
                }
                if (!folding && pc.effects?.length) {
                    const fx = document.createElement('div');
                    fx.style.cssText = 'margin-top:4px; font-size:0.66rem; color:rgba(255,255,255,0.55);';
                    fx.innerHTML = `<span style="color:#e0b64a;">Effects on you (not applied to sim):</span> ${pc.effects.join(', ')}`;
                    wrap.appendChild(fx);
                }

                const note = document.createElement('div');
                note.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
                if (folding) {
                    note.innerHTML = view?.hasMismatch
                        ? '<span style="color:#e56b6b;">⚠ off</span> = a gap with your own buffs applied to both sides — a gear, ability-level or buff-init gap in the sim.'
                        : 'Every row matches with your active buffs applied to both sides — the sim builds your character correctly.';
                } else {
                    note.innerHTML =
                        'Raw view: the sim’s fight-start build, before your live buffs. A gap here is the size of the buffs you are carrying.';
                }
                wrap.appendChild(note);

                if (folding && !fold.hasStartMap) {
                    wrap.appendChild(
                        this._caption(
                            'No fight-start buff map seen yet, so the buffs listed as folded include persistent ones the sim already had — applied as per-type targets, so nothing is counted twice.',
                            'rgba(255,255,255,0.4)'
                        )
                    );
                }
            }
        }

        const btn = document.createElement('button');
        btn.textContent = this._playerView() ? 'Re-check my build' : 'Check my build';
        btn.title = 'Compare the sim’s build of your character against your live in-game stats (click yourself first)';
        btn.style.cssText =
            'margin-top:6px; background:none; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#cbd5e8; font-size:0.7rem; cursor:pointer; padding:3px 8px;';
        btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.06)'));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.textContent = 'Running…';
            btn.disabled = true;
            setTimeout(() => this._runPlayerCheck(), 0);
        });
        wrap.appendChild(btn);

        footer.appendChild(wrap);
    }

    /** The uptime-harness section: a Run button, and the incoming-damage diff. */
    _renderUptime(footer, snapshot) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);';

        const up = snapshot.uptime;
        if (up) {
            const head = document.createElement('div');
            head.style.cssText =
                'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin-bottom:2px;';
            head.textContent = 'Uptime harness — incoming damage / ability';
            wrap.appendChild(head);
            const label = simPlayerLabel(up.simPlayer);
            if (label) wrap.appendChild(this._caption(label, 'rgba(255,255,255,0.5)'));

            // How much real evidence the rows rest on: complete fights counted,
            // partials excluded, and whether the capture opened mid-fight.
            if (up.fightsLabel) {
                const fights = document.createElement('div');
                fights.style.cssText = 'font-size:0.66rem; color:rgba(255,255,255,0.45); margin-bottom:2px;';
                fights.textContent = up.fightsLabel;
                wrap.appendChild(fights);
            }

            if (up.notModelled) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:#e0b64a; font-style:italic;';
                none.textContent = TRIAL_NOT_MODELLED;
                wrap.appendChild(none);
            } else if (up.armed) {
                const armed = document.createElement('div');
                armed.style.cssText = 'font-size:0.72rem; color:#6fce7f; font-style:italic;';
                armed.textContent = up.message;
                wrap.appendChild(armed);
            } else if (up.error) {
                const err = document.createElement('div');
                err.style.cssText = 'font-size:0.72rem; color:#e0b64a; font-style:italic;';
                err.textContent = up.error;
                wrap.appendChild(err);
            } else if (!up.rows?.length) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:rgba(255,255,255,0.5);';
                none.textContent = 'No attacks found in the capture.';
                wrap.appendChild(none);
            } else {
                this._uptimeTable(wrap, up.rows, false);

                // The other direction from the same capture and sim run: your
                // swings paid off by the monster's damage counter — the sim's
                // model of YOUR abilities, checked the same way.
                const outHead = document.createElement('div');
                outHead.style.cssText =
                    'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin:8px 0 2px;';
                outHead.textContent = 'Uptime harness — outgoing damage / ability';
                wrap.appendChild(outHead);
                if (up.outgoingRows?.length) {
                    this._uptimeTable(wrap, up.outgoingRows, true);
                } else {
                    const none = document.createElement('div');
                    none.style.cssText = 'font-size:0.72rem; color:rgba(255,255,255,0.5);';
                    // null = a result saved before the outgoing direction
                    // existed; [] = a run that genuinely found no swings.
                    none.textContent = up.outgoingRows
                        ? 'No attacks of yours found in the capture.'
                        : 'Re-run the harness to compute the outgoing direction.';
                    wrap.appendChild(none);
                }
            }
        }

        const btn = document.createElement('button');
        btn.textContent = up?.rows?.length ? 'Re-run uptime harness' : 'Run uptime harness';
        btn.disabled = Boolean(snapshot.trial);
        btn.title = snapshot.trial
            ? TRIAL_NOT_MODELLED
            : 'Decompose the monster’s incoming damage per ability vs the sim. With no capture yet, arms one for the next fight.';
        btn.style.cssText =
            'margin-top:6px; background:none; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#cbd5e8; font-size:0.7rem; cursor:pointer; padding:3px 8px;';
        btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.06)'));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.textContent = 'Running…';
            btn.disabled = true;
            setTimeout(() => this._runUptimeHarness(), 0);
        });
        wrap.appendChild(btn);

        footer.appendChild(wrap);
    }

    /**
     * One direction's harness table: column header, a row per ability with the
     * hover detail, and the legend. Identical for both directions except the
     * wording of whose damage the shares describe.
     * @param {HTMLElement} wrap - Where the table lands
     * @param {Array<Object>} rows - Comparison rows (from compareIncoming)
     * @param {boolean} outgoing - True for the player→monster direction
     */
    _uptimeTable(wrap, rows, outgoing) {
        const header = document.createElement('div');
        header.style.cssText =
            'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; font-size:0.64rem; color:rgba(255,255,255,0.4); padding:1px 0;';
        header.innerHTML =
            '<span>ability</span><span style="text-align:right;">real dmg%</span><span style="text-align:right;">sim dmg%</span><span></span>';
        wrap.appendChild(header);

        for (const r of rows) {
            const style = UPTIME_VERDICT[r.verdict] || UPTIME_VERDICT.ok;
            const line = document.createElement('div');
            line.style.cssText =
                'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; align-items:baseline; font-size:0.74rem; padding:1px 0;';
            const num = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}`);
            const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);
            const name = document.createElement('span');
            name.textContent = r.ability;
            name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            // Cast share, means and sample size on hover, so the row
            // stays compact. Cast share is '—' for the DoT row, whose
            // ticks are not casts.
            name.title =
                `casts: real ${pct(r.real?.castSharePct)} / sim ${pct(r.sim?.castSharePct)}` +
                `  ·  mean/cast: real ${num(r.real?.meanDmgPerCast)} / sim ${num(r.sim?.meanDmgPerCast)}` +
                `  ·  mean/hit: real ${num(r.real?.meanDmgPerHit)} / sim ${num(r.sim?.meanDmgPerHit)}` +
                `  ·  ${r.samples ?? 0} real casts`;
            const g = document.createElement('span');
            g.textContent = pct(r.real?.dmgSharePct);
            g.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums;';
            const s = document.createElement('span');
            s.textContent = pct(r.sim?.dmgSharePct);
            s.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums; color:rgba(255,255,255,0.75);';
            const v = document.createElement('span');
            v.textContent = style.glyph;
            v.style.cssText = `text-align:right; color:${style.color};`;
            v.title = UPTIME_TITLE[r.verdict] || r.verdict;
            line.append(name, g, s, v);
            wrap.appendChild(line);
        }
        const key = document.createElement('div');
        key.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
        const whose = outgoing ? 'your outgoing damage' : 'incoming damage';
        key.innerHTML =
            `<span style="color:#e56b6b;">⚠ sim-under</span> = sim gives this ability a smaller share of ${whose} than reality (or lands it for a smaller mean). ` +
            '<span style="color:rgba(255,255,255,0.5);">?</span> = too few real casts to grade. ' +
            'Hover for cast%, means and sample size: a matching cast% with a damage gap is a per-cast magnitude (buff-uptime) issue, a cast% gap is cadence.';
        wrap.appendChild(key);
    }

    /** Boost as a short string: a ratio as a percent, else the flat value. */
    _blindBoost(rec) {
        if (!rec) return '—';
        if (rec.ratioBoost) return `${(rec.ratioBoost * 100).toFixed(0)}%`;
        if (rec.flatBoost) return `${Math.round(rec.flatBoost * 1000) / 1000}`;
        return '0';
    }

    /** The blind-sim section: a Run button, and the produced-vs-live buff diff. */
    _renderBlind(footer, snapshot) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);';

        const blind = snapshot.blind;
        if (blind) {
            const head = document.createElement('div');
            head.style.cssText =
                'font-size:0.68rem; text-transform:uppercase; letter-spacing:0.5px; color:rgba(255,255,255,0.4); margin-bottom:2px;';
            head.textContent = 'Blind sim — buffs it produces';
            wrap.appendChild(head);
            const label = simPlayerLabel(blind.simPlayer);
            if (label) wrap.appendChild(this._caption(label, 'rgba(255,255,255,0.5)'));

            if (blind.notModelled) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:#e0b64a; font-style:italic;';
                none.textContent = TRIAL_NOT_MODELLED;
                wrap.appendChild(none);
            } else if (!blind.ran) {
                const err = document.createElement('div');
                err.style.cssText = 'font-size:0.72rem; color:#e56b6b; font-style:italic;';
                err.textContent = 'Blind fight could not run (no loadout or sim data).';
                wrap.appendChild(err);
            } else if (!blind.rows.length) {
                const none = document.createElement('div');
                none.style.cssText = 'font-size:0.72rem; color:rgba(255,255,255,0.5);';
                none.textContent = 'No buffs on either side.';
                wrap.appendChild(none);
            } else {
                for (const r of blind.rows) {
                    const style = BLIND_VERDICT[r.verdict] || BLIND_VERDICT.match;
                    const line = document.createElement('div');
                    line.style.cssText =
                        'display:grid; grid-template-columns: 1.4fr 0.8fr 0.8fr auto; gap:4px; align-items:baseline; font-size:0.74rem; padding:1px 0;';
                    const name = document.createElement('span');
                    name.textContent = r.name;
                    name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    const g = document.createElement('span');
                    g.textContent = this._blindBoost(r.game);
                    g.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums;';
                    const s = document.createElement('span');
                    s.textContent = this._blindBoost(r.sim);
                    s.style.cssText =
                        'text-align:right; font-variant-numeric:tabular-nums; color:rgba(255,255,255,0.75);';
                    const v = document.createElement('span');
                    v.textContent = r.verdict === 'stacks' && r.stackMultiple ? `×${r.stackMultiple}` : style.glyph;
                    v.style.cssText = `text-align:right; color:${style.color};`;
                    v.title =
                        r.verdict === 'stacks' && r.stackMultiple
                            ? `${r.stackMultiple}× the single-stack strength — ${BLIND_TITLE.stacks}`
                            : BLIND_TITLE[r.verdict] || r.verdict;
                    line.append(name, g, s, v);
                    wrap.appendChild(line);
                }
                const key = document.createElement('div');
                key.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
                key.innerHTML =
                    '<span style="color:#e56b6b;">⚠ missing</span> = the sim never produced an effect the game shows · ' +
                    '<span style="color:#e0b64a;">≠</span> different strength · ' +
                    '<span style="color:rgba(255,255,255,0.6);">×n</span> stack-count difference · ' +
                    '<span style="color:rgba(255,255,255,0.5);">·</span> not active in snapshot (timing, not modelling). Game vs sim columns.';
                wrap.appendChild(key);
            }
        }

        const btn = document.createElement('button');
        btn.textContent = blind ? 'Re-run blind sim' : 'Run blind sim';
        btn.disabled = Boolean(snapshot.trial);
        btn.title = snapshot.trial
            ? TRIAL_NOT_MODELLED
            : 'Simulate a fight fed only the monster + level (no live buffs) and list the buffs the sim produces';
        btn.style.cssText =
            'margin-top:6px; background:none; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#cbd5e8; font-size:0.7rem; cursor:pointer; padding:3px 8px;';
        btn.addEventListener('mouseenter', () => (btn.style.background = 'rgba(255,255,255,0.06)'));
        btn.addEventListener('mouseleave', () => (btn.style.background = 'none'));
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.textContent = 'Running…';
            btn.disabled = true;
            // Yield a frame so the label paints before the synchronous fight.
            setTimeout(() => this._runBlindSim(), 0);
        });
        wrap.appendChild(btn);

        footer.appendChild(wrap);
    }

    /**
     * One four-column line: stat, game, sim, delta+verdict.
     * @param {{label,game,sim,delta,verdict}} cells
     * @param {{headerRow?: boolean}} [options]
     */
    _rowEl({ label, game, sim, delta, verdict }, { headerRow = false } = {}) {
        const row = document.createElement('div');
        row.style.cssText = `display: grid; grid-template-columns: 1.35fr 1fr 1fr 0.9fr; gap: 4px; align-items: baseline; padding: 2px 0; font-size: ${headerRow ? '0.66rem' : '0.78rem'};`;
        if (headerRow) row.style.color = 'rgba(255,255,255,0.4)';

        const name = document.createElement('span');
        name.textContent = label;
        name.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const gameEl = document.createElement('span');
        gameEl.textContent = game;
        gameEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums;';

        const simEl = document.createElement('span');
        simEl.textContent = sim;
        simEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.75);';

        const deltaEl = document.createElement('span');
        deltaEl.style.cssText = 'text-align: right; font-variant-numeric: tabular-nums; font-size: 0.72rem;';
        const style = verdict ? VERDICT_STYLE[verdict] : null;
        if (headerRow) {
            deltaEl.textContent = 'Δ';
        } else if (style) {
            deltaEl.textContent = `${style.glyph}${delta ? ' ' + delta : ''}`;
            deltaEl.style.color = style.color;
        }

        row.appendChild(name);
        row.appendChild(gameEl);
        row.appendChild(simEl);
        row.appendChild(deltaEl);
        return row;
    }

    _setupDragging(header) {
        header.style.touchAction = 'none';
        header.addEventListener('pointerdown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            bringPanelToFront(this.container);
            this.isDragging = true;
            const rect = this.container.getBoundingClientRect();
            this.container.style.transform = 'none';
            this.container.style.top = `${rect.top}px`;
            this.container.style.left = `${rect.left}px`;
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });

        this.dragMoveHandler = (e) => {
            if (!this.isDragging) return;
            let x = e.clientX - this.dragOffset.x;
            let y = e.clientY - this.dragOffset.y;
            const minVisible = 80;
            y = Math.max(0, Math.min(y, window.innerHeight - minVisible));
            x = Math.max(-this.container.offsetWidth + minVisible, Math.min(x, window.innerWidth - minVisible));
            this.container.style.top = `${y}px`;
            this.container.style.left = `${x}px`;
        };

        this.dragUpHandler = () => {
            if (!this.isDragging) return;
            this.isDragging = false;
            header.style.cursor = 'grab';
        };

        document.addEventListener('pointermove', this.dragMoveHandler);
        document.addEventListener('pointerup', this.dragUpHandler);
        document.addEventListener('pointercancel', this.dragUpHandler);
    }

    teardown() {
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.dragMoveHandler) {
            document.removeEventListener('pointermove', this.dragMoveHandler);
            this.dragMoveHandler = null;
        }
        if (this.dragUpHandler) {
            document.removeEventListener('pointerup', this.dragUpHandler);
            document.removeEventListener('pointercancel', this.dragUpHandler);
            this.dragUpHandler = null;
        }
        if (this.minimize) {
            this.minimize.destroy();
            this.minimize = null;
        }
        if (this.container) {
            unregisterFloatingPanel(this.container);
            this.container.remove();
            this.container = null;
        }
        this.body = null;
        this.header = null;
        this.isDragging = false;
        // The three panel fields that describe a person rather than a monster.
        // The monster log is game data and deliberately not character-scoped;
        // these are your live stats, the verdict drawn from them, and the buff
        // map the offense fold deltas against, and teardown is how a character
        // switch arrives here. Left standing, "Check my build" answers for the
        // character who left instead of asking the arriving one to click
        // themselves.
        this.lastPlayerUnit = null;
        this.playerCheck = null;
        this.fightStartBuffMap = null;
    }
}

const panel = new MonsterStatCheckPanel();

/** The `battle_unit_fetched` handler, kept as a reference so it can be removed. */
let fetchHandler = null;

/** The `new_battle` handler — the fight-start buff snapshot the offense fold deltas against. */
let battleHandler = null;

/** The unregister function `onSettingChange` handed back, undone in `disable()`. */
let unregisterSettingChange = null;

/**
 * Whether a fetched player unit (`isPlayer: true`) is the character being
 * played, not a party member or someone else's profile sheet opened mid-fight
 * — both ride the exact same `battle_unit_fetched` message and both set
 * `isPlayer: true`, `combatDetails`, the lot. combat-summary and
 * combat-drop-luck hit this same confusion this week (6e2a4da8) on the totals
 * shape of the message; this is the stats shape of it. Same fix: key off
 * `character.id` against the current character, the way `noteBattleStart`
 * already does for `new_battle`'s player list. A payload naming nobody (an
 * older/trimmed shape) is left passing rather than dropped.
 * @param {Object} unit - A unit with `isPlayer: true`
 * @returns {boolean}
 */
function isOwnPlayerUnit(unit) {
    const owner = unit?.character?.id;
    if (owner == null) return true;
    return String(owner) === String(dataManager.getCurrentCharacterId());
}

function handleFetched(data) {
    try {
        const unit = data?.unit;
        if (!unit) return;
        // Clicking yourself fires this too — keep the live stats for the "Check my
        // build" button, but don't open the panel on it. A party member's or
        // another player's own sheet fires the identical shape and must not
        // overwrite the remembered build with someone else's stats.
        if (unit.isPlayer) {
            if (isOwnPlayerUnit(unit)) panel.noteChar(unit);
            return;
        }
        if (!unit.hrid) return;
        panel.showFor(unit);
    } catch (error) {
        console.error('[MonsterStatCheck] Failed to handle fetched unit:', error);
    }
}

function initialize() {
    if (!fetchHandler) {
        fetchHandler = handleFetched;
        webSocketHook.on('battle_unit_fetched', fetchHandler);
    }
    if (!battleHandler) {
        battleHandler = (data) => {
            try {
                panel.noteBattleStart(data);
            } catch (error) {
                console.error('[MonsterStatCheck] Failed to note a battle start:', error);
            }
        };
        webSocketHook.on('new_battle', battleHandler);
    }

    // Restore the log saved from an earlier session so the panel opens with it.
    panel._loadPersisted();

    // Offered only once something has been recorded: the panel has nothing
    // to draw before the first monster is clicked, and a palette entry that
    // opens onto nothing is worse than one that is missing. `_loadPersisted`
    // is async, so this is asked at open time rather than answered here.
    registerCommand({
        name: 'Monster Stat Check',
        hint: "Where the sim's monster stats differ from the game's",
        run: () => panel.toggle(),
        when: () => panel.hasHistory,
    });

    // Turning the setting off mid-session should take the panel away without a
    // refresh. Turning it on relies on the registry initialising the feature.
    unregisterSettingChange = config.onSettingChange(SETTING_KEY, (enabled) => {
        if (!enabled) disable();
    });
}

function disable() {
    unregisterCommand('Monster Stat Check');
    if (unregisterSettingChange) {
        unregisterSettingChange();
        unregisterSettingChange = null;
    }
    if (fetchHandler) {
        webSocketHook.off('battle_unit_fetched', fetchHandler);
        fetchHandler = null;
    }
    if (battleHandler) {
        webSocketHook.off('new_battle', battleHandler);
        battleHandler = null;
    }
    panel.teardown();
}

/** Console: dump the last comparison as a table. Exposed on Toolasha.Debug. */
function dumpLast() {
    return panel.dump();
}

/** Console: the session's discrepancy log (also downloadable from the panel). */
function logEntries() {
    return panel.logEntries();
}

export default {
    name: 'Monster Stat Check',
    initialize,
    disable,
    dumpLast,
    logEntries,
};

/** The panel singleton, exported for tests. */
export { panel };
