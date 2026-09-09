/**
 * Combat Simulator UI
 * Floating panel for configuring and running combat simulations.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import bundledExpectedValueCalculator from '../market/expected-value-calculator.js';
import {
    expectedValueCalculator,
    missingMaterialsButton,
    dungeonTrackerStorage,
    marketHistoryPanel,
    labyrinthClearRate,
    loadoutSnapshot,
    marketWatchTarget,
    marketWatchItem,
} from '../../utils/bundle-bridge.js';
import {
    isGearCandidate,
    projectedFingerprint,
    rankInvalidatedRooms,
    describeInvalidatedRooms,
} from '../combat/labyrinth-upgrade-invalidation.js';
// No bundled fallbacks for the two handoffs below. They used to be imported as
// standalone-build fallbacks, but the standalone build loads every library into
// one graph and publishes `window.Toolasha.Market` before any click can happen,
// so the bridge answers there too — and in the packaged build the fallback was
// never the right answer: this bundle loads before market, so a bundle-local
// `watchItem`/`watchTarget` writes into a copy the visible panel never reads.
// The imports also dragged watchlist.js, equipment-savings-row.js and their
// subtrees — inventory-badge-manager and its price caches among them — into
// this bundle as a second, divergent set of module state.
import { addAbilityGoal, addHouseGoal } from '../../utils/equipment-savings.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { explainAbilityLevelUpCost } from '../../utils/ability-cost-calculator.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { saveUpgradeResults, loadUpgradeResults, clearUpgradeResults } from './upgrade-results-store.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import {
    ALL_ZONES_SNAPSHOT_KEY,
    ALL_ZONES_SNAPSHOT_STORE,
    saveAllZonesSnapshot,
    loadAllZonesSnapshot,
} from '../../utils/all-zones-snapshot.js';
import { formatWithSeparator, formatKMB, parseKMB, timeReadable } from '../../utils/formatters.js';
import { monsterKillsPerHour, countsByMonster, zoneBestiaryOutlook } from '../../utils/bestiary.js';
import { planBestiaryRoute, rescaleDungeonRates, formatPlanHours, formatPlanText } from '../../utils/bestiary-plan.js';
import { capProfitRate, liquidityMarkerHtml } from '../../utils/liquidity-cap.js';
import { badgeHtml, calibrationBadgeFor } from '../../utils/calibration-badge.js';
import {
    isSkillingGearItem,
    isAuraAbility,
    skillingGearWarnings,
    duplicateAuraWarnings,
    partyLintWarnings,
} from '../../utils/party-lint.js';
import { createEtaTracker } from '../../utils/progress-eta.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    getCombatZones,
    getCurrentCombatZone,
    getCommunityBuffs,
    calculateExpectedDrops,
    calculateDungeonKeyCosts,
    calculateSimRevenue,
    taxedDropValue,
    getZonesThatDropItem,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
} from './combat-sim-adapter.js';
import { runSimulation, cancelActiveSimulations } from './combat-sim-runner.js';
import { runAllZonesSimulation, cancelAllZonesSimulation } from './all-zones-runner.js';
import {
    runUpgradeAnalysis,
    getStyleExcludedSkills,
    houseRoomAffectsCombat,
    houseUpgradeMaterials,
    assignRankScores,
    planWithinBudget,
    explainUpgradeCost,
    COST_SOURCES,
    RANK_PLACES,
    SCORE_METRICS,
    DEFAULT_SCORE_KEYS,
    MAX_GUILD_SHRINE_LEVEL,
    shrineName,
} from './upgrade-advisor.js';
import { applyMaxTierFood } from './food-optimizer.js';
import { SimEditor } from './sim-editor.js';
import storage from '../../core/storage.js';

const PANEL_ID = 'mwi-combat-sim-panel';
const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

/** Storage key for the remembered Upgrade-tab candidate sets */
const UPGRADE_MODES_KEY = 'combatSimUpgradeModes';
const UPGRADE_COLUMNS_KEY = 'combatSimUpgradeColumns';
/** Storage key for the last Upgrade-tab results, remembered across refreshes (opt-in) */
const UPGRADE_RESULTS_KEY = 'combatSimUpgradeResults';

/**
 * Storage key for the Ability Swaps "Aura only" sub-option.
 *
 * Remembered with the candidate sets themselves, and for the same reason: it is
 * how you want swaps ranked rather than something about one particular run, and
 * an unremembered narrowing means the next Analyze quietly costs several times
 * as much.
 */
const SWAP_AURA_ONLY_KEY = 'combatSimSwapAuraOnly';
const SHRINE_CAP_GUILD_KEY = 'combatSimShrineCapToGuild';

/**
 * Storage key for the all-zones Max-tier Food toggle.
 *
 * Remembered, unlike the Sim All Zones and Sim All Solo checkboxes beside it,
 * which are deliberately per-session: those decide *what this run is*, and a
 * panel that opens already in all-zones mode would have you simulate sixty-six
 * zones because you did last week. This one decides how a comparison is read,
 * which is a standing preference — whoever wants the max-food ranking wants it
 * every time they open the ranking.
 */
const ALL_ZONES_MAX_FOOD_KEY = 'combatSimAllZonesMaxTierFood';

/** The Bestiary planner's time budget, remembered across sessions */
const BESTIARY_PLAN_HOURS_KEY = 'combatSimBestiaryPlanHours';
const BESTIARY_PLAN_DEFAULT_HOURS = 24;

/**
 * Which way round the planner is asked its question — a time budget ("what can
 * I earn in a day") or a points target ("how long until twenty more") — and the
 * target itself. Both are remembered for the same reason the hours are: whoever
 * plans in points plans in points.
 */
const BESTIARY_PLAN_MODE_KEY = 'combatSimBestiaryPlanMode';
const BESTIARY_PLAN_POINTS_KEY = 'combatSimBestiaryPlanPoints';
const BESTIARY_PLAN_DEFAULT_POINTS = 20;

/**
 * Whether an All Zones run also simulates every dungeon at every tier.
 *
 * Off by default: dungeons roughly double the run, and a Bestiary route that
 * sends you into one is only honest if your own clear times back it up. On, the
 * dungeons join the results table marked `[D]` and the planner rescales their
 * simulated kill rates to the clear time your run history measured.
 */
const ALL_ZONES_DUNGEONS_KEY = 'combatSimAllZonesIncludeDungeons';

/** Dungeons run T0-T2 where an ordinary zone runs T0-T5 */
const DUNGEON_MAX_TIER = 2;

/**
 * What the Max-tier Food checkbox promises, in one hover.
 *
 * No double quotes anywhere in it: this string is interpolated straight into a
 * `title="..."` attribute in two places, and one apostrophe-shaped quotation
 * mark would end the attribute early and spill the rest into the markup.
 */
const MAX_FOOD_TOOLTIP =
    'Simulate every zone with the best food of each kind you already run, instead of what you happen to be ' +
    'carrying. Low-tier food makes hard zones look bad for the wrong reason — the deaths are the food, not the ' +
    'zone — so a ranking taken on cheese answers which zone tolerates my cheese rather than which zone is best ' +
    'for me. Each food slot moves to the highest-restore food of its own kind (healing stays healing, mana ' +
    'stays mana); buff-only foods, empty slots and drinks are left alone. Nothing is capped by level: the game ' +
    'puts no level requirement on consumables, so every substitute is one this character could eat. Your real ' +
    'loadout is never touched — the swap exists only inside the run.';

/**
 * Where this panel was left, in the shared panel-geometry store.
 *
 * Geometry *and* the open flag. This deliberately went the other way once — the
 * argument being that a simulator is opened when you have a question, so
 * reopening it on every load would be in the way. In practice the question
 * outlives the page: a refresh mid-analysis, or the game reloading itself,
 * closed a panel that was being read and lost where you were in it. A panel you
 * left open is a panel you were using, and closing it says so.
 */
const GEOMETRY_KEY = 'combatSimPanel';

/** Floor sizes the resize grips will not take the panel below. */
const MIN_PANEL_WIDTH = 400;
const MIN_PANEL_HEIGHT = 300;

/**
 * Columns hidden until asked for.
 *
 * The raw deltas restate what the gold-per columns already price, and ROI is
 * repay time inverted — all six are worth having on demand, none is worth the
 * width by default. Sixteen columns at once is what forced the panel wider.
 */
const DEFAULT_HIDDEN_COLUMNS = ['deltaDps', 'deltaXp', 'deltaProfit', 'deltaEph', 'deltaDph', 'roi'];

/**
 * How deep into each metric's ladder the Score pays points.
 *
 * Five was the only depth there was, and it is a strong opinion: on a run of a
 * hundred and forty candidates it means a hundred and thirty-five of them score
 * literally zero, and the column stops separating anything below the podium.
 * That is the right answer when the question is "what is the shortlist" and the
 * wrong one when it is "where does *this* row sit" — so the depth is a choice,
 * with five kept as the default so nobody's table changes under them.
 *
 * `null` means every distinct value on the ladder places, which turns the score
 * from a podium into a full ranking.
 */
export const SCORE_DEPTHS = [
    { key: '5', places: 5, label: 'Top 5' },
    { key: '10', places: 10, label: 'Top 10' },
    { key: '15', places: 15, label: 'Top 15' },
    { key: 'all', places: null, label: 'All rows' },
];

/** The depth used when nothing has been chosen — the behaviour that predates the option. */
export const DEFAULT_SCORE_DEPTH = '5';

/**
 * How many placings a depth key actually pays out over.
 * @param {string} depthKey - A `SCORE_DEPTHS` key
 * @param {number} rowCount - Rows being scored, for the "all" case
 * @returns {number} Placings that earn points
 */
export function scoreDepthPlaces(depthKey, rowCount) {
    const depth = SCORE_DEPTHS.find((d) => d.key === depthKey);
    if (!depth) return RANK_PLACES;
    return depth.places ?? Math.max(1, rowCount || 1);
}

/** What a depth key is called, for a header that has to say which one is on. */
export function scoreDepthLabel(depthKey) {
    return (SCORE_DEPTHS.find((d) => d.key === depthKey) || SCORE_DEPTHS[0]).label;
}

/**
 * How many places down the Score gradient reaches.
 *
 * Nine, because it is what a reader can hold: green for the ones worth looking
 * at, amber for the middle, red for the tail of what still ranked at all. Past
 * that the colour would be saying "worse than ninth", which the position in the
 * table already says.
 */
export const SCORE_GRADIENT_PLACES = 9;

/**
 * Green → amber → red across the top nine scores.
 *
 * The three stops are the table's own colours — the same `#4caf50` that marks a
 * best-in-column cell and the same `#f44336` that marks a regression — so the
 * gradient reads as more of the vocabulary already in use rather than a second
 * palette laid over it. Interpolated in plain RGB: over this short a span the
 * difference from a perceptual blend is not visible, and the endpoints are
 * exactly the two colours everything else in the table uses.
 *
 * @param {number} place - 1-based rank among the scored rows
 * @returns {string|null} A CSS colour, or null past the ninth place
 */
export function scoreGradientColor(place) {
    if (!Number.isFinite(place) || place < 1 || place > SCORE_GRADIENT_PLACES) return null;

    const stops = [
        [76, 175, 80], // #4caf50 — best
        [255, 152, 0], // #ff9800 — middle
        [244, 67, 54], // #f44336 — ninth
    ];
    // 0 at first place, 1 at the ninth, so the middle stop lands on fifth
    const t = (place - 1) / (SCORE_GRADIENT_PLACES - 1);
    const half = t < 0.5 ? 0 : 1;
    const local = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const from = stops[half];
    const to = stops[half + 1];
    const channel = (i) => Math.round(from[i] + (to[i] - from[i]) * local);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/**
 * Where each row's Score places among the rows shown, ties sharing a place.
 *
 * Built from the scores rather than from the table order so a sort by Cost does
 * not repaint the gradient — the colour is about the score, and it has to mean
 * the same thing whichever column the table is sorted on. Rows that scored
 * nothing never place: a zero is the absence of a ranking, not the bottom of one.
 *
 * @param {Array<Object>} rows - Scored result rows
 * @returns {Map<Object, number>} Row → 1-based place
 */
export function scorePlaces(rows) {
    // A zero is the absence of a ranking rather than the bottom of one, so it is
    // filtered out before the ladder is built — which is the one thing that
    // makes the Score ladder different from a metric's
    return metricPlaces(rows, (row) => (Number.isFinite(row?.score) && row.score > 0 ? row.score : null), false);
}

/**
 * Where each row places within one column, ties sharing a place.
 *
 * The same ladder the Score column has always used, asked of any column. Two
 * things it has to get right and a per-column version can get wrong. Direction:
 * a Gold/0.01% column and a Repay time are cheaper-is-better, so first place is
 * the *lowest* number, while an ROI is the other way up — reading the direction
 * off the metric rather than assuming one is what keeps the greenest cell from
 * being the worst row in the column. And absence: a row whose value is `—`
 * never places, in either direction, because there is nothing to place.
 *
 * Built from the values rather than from the table order, so sorting on another
 * column does not repaint anything.
 *
 * @param {Array<Object>} rows - The rows being drawn
 * @param {Function} valueOf - (row) => number|null|undefined
 * @param {boolean} lowerIsBetter - Whether first place is the smallest value
 * @returns {Map<Object, number>} Row → 1-based place
 */
export function metricPlaces(rows, valueOf, lowerIsBetter) {
    const read = (row) => {
        const value = valueOf(row);
        return Number.isFinite(value) ? value : null;
    };

    const ladder = [...new Set((rows || []).map(read).filter((v) => v !== null))].sort((a, b) =>
        lowerIsBetter ? a - b : b - a
    );

    const places = new Map();
    for (const row of rows || []) {
        const value = read(row);
        if (value === null) continue;
        const index = ladder.indexOf(value);
        if (index >= 0) places.set(row, index + 1);
    }
    return places;
}

/**
 * The gradient ladder for every column the colouring covers, keyed by column.
 *
 * The Score plus every metric the Score is currently built from — which is the
 * point of the change that introduced it. Colouring only the total said which
 * rows were good all round and nothing about what any of them was good *at*; a
 * ladder per column says "this one is the cheapest DPS, that one the cheapest
 * EXP" at a glance, and the Score column still says who wins on aggregate.
 *
 * Only the metrics actually counting toward the Score get one. A column excluded
 * in ⚙ Columns is a column the reader has said not to weigh, and colouring it
 * would go on recommending it.
 *
 * @param {Array<Object>} rows - The rows about to be drawn
 * @param {Set<string>|Array<string>} scoredKeys - `SCORE_METRICS` keys that count
 * @returns {Map<string, Map<Object, number>>} Column key → row → place
 */
export function gradientLadders(rows, scoredKeys) {
    const scored = scoredKeys instanceof Set ? scoredKeys : new Set(scoredKeys || []);
    const ladders = new Map([['score', scorePlaces(rows)]]);

    for (const metric of SCORE_METRICS) {
        if (!scored.has(metric.key)) continue;
        ladders.set(metric.key, metricPlaces(rows, metric.value, metric.lowerIsBetter));
    }
    return ladders;
}

/**
 * What the Upgrade-tab budget planner can shop for.
 *
 * A labyrinth plan has one axis — attempts saved — because every fight is the
 * same kind of failure. A combat zone does not: the same 500M spent for DPS,
 * for profit and for EXP buys three different lists, and which one is right is
 * the player's question, not the panel's. So the axis is a choice, and each
 * entry knows how to read its gain off a result row and how to say it.
 */
export const UPGRADE_PLAN_METRICS = [
    {
        key: 'profit',
        label: 'Profit/hr',
        gain: (row, baseline) =>
            row?.economics?.profitGainPerHour ?? (row?.metrics?.profitPerHour ?? 0) - (baseline?.profitPerHour ?? 0),
        format: (value) => `${formatKMB(Math.round(value))}/hr profit`,
    },
    {
        key: 'dps',
        label: 'DPS',
        gain: (row, baseline) => (row?.metrics?.dps ?? 0) - (baseline?.dps ?? 0),
        format: (value) => `+${value.toFixed(2)} DPS`,
    },
    {
        key: 'xp',
        label: 'EXP/hr',
        gain: (row, baseline) => (row?.metrics?.xpPerHour ?? 0) - (baseline?.xpPerHour ?? 0),
        format: (value) => `+${formatKMB(Math.round(value))} EXP/hr`,
    },
];

/**
 * The best set of upgrades a budget will buy, on one improvement axis.
 *
 * The planner itself lives in the upgrade advisor and speaks labyrinth: it
 * values a candidate by how far it drives `attemptsDelta` below zero. Combat
 * results have no attempts, so the gain on the chosen axis goes in negated —
 * "one fewer attempt" and "one more coin per hour" are the same arithmetic, and
 * the slot-conflict rules that stop it buying two chestpieces are the part
 * worth reusing.
 *
 * Combat levels are dropped: they are not purchases, so a list of what a budget
 * buys has nothing to say about them.
 *
 * ## Why it plans twice
 *
 * `planWithinBudget` throws away every row whose gain has not cleared the
 * simulation's own error bar, and on the profit axis that is very nearly every
 * row. The error model is per-encounter and deliberately coarse — a run of a few
 * thousand encounters carries a couple of percent of noise, and 1.96σ of it is
 * four or five — while a real profit gain from one piece of gear is a fraction
 * of a percent. So a table full of affordable, positive, sensibly-priced rows
 * planned to *nothing at all*, and the panel said "nothing fits 500M", which is
 * not what it had measured and not what the reader could see.
 *
 * "Not proven" is not "worth zero". The first pass still prefers the rows that
 * cleared their error bar, because a plan made of measurements is worth more
 * than one made of point estimates. Only when that pass buys nothing does the
 * second one run over everything, and what comes back is flagged `provisional`
 * so the panel can say which of the two it is looking at.
 *
 * @param {Array<Object>} rows - Upgrade results (`{candidate, cost, metrics, economics}`)
 * @param {number} budget - Coins available
 * @param {Object} [options] - `{ baseline, metricKey }`
 * @returns {{picks: Array<Object>, totalCost: number, gainTotal: number,
 *   skipped: Array<Object>, budget: number, metric: Object, provisional: boolean}}
 */
export function planUpgradeBudget(rows, budget, { baseline = {}, metricKey = 'profit' } = {}) {
    const metric = UPGRADE_PLAN_METRICS.find((m) => m.key === metricKey) || UPGRADE_PLAN_METRICS[0];
    const planRows = (rows || [])
        .filter((row) => row?.candidate && row.candidate.type !== 'combat_level')
        .map((row) => ({
            ...row,
            attemptsDelta: -metric.gain(row, baseline),
            // "Inside the error" is a question about one metric at a time — a
            // swap can move DPS well clear of the noise while its profit delta
            // is pure sampling. The axis being shopped for is the one that has
            // to clear it
            significant: row.significantBy?.[metric.key] ?? row.significant ?? true,
        }));
    const coins = Number.isFinite(budget) ? budget : 0;

    const measured = planWithinBudget(planRows, coins);
    if (measured.picks.length) {
        return { ...measured, gainTotal: measured.attemptsSaved, metric, provisional: false };
    }

    const estimated = planWithinBudget(planRows, coins, { includeUnmeasured: true });
    return {
        ...estimated,
        gainTotal: estimated.attemptsSaved,
        metric,
        provisional: estimated.picks.length > 0,
    };
}

/**
 * A column's name where there is room for one line.
 *
 * The table header stacks the qualifier under the label to save width, so five
 * separate columns all read `Gold/0.01%` with `DPS`, `EXP`, `Profit`, `EPH` and
 * `DPH` beneath. In a list of checkboxes there is no second line to stack it on,
 * and five identical labels are five checkboxes nobody can tell apart.
 *
 * @param {Object} column - A column definition from `_upgradeColumns`
 * @returns {string} Label, with the qualifier joined on where there is one
 */
export function columnMenuLabel(column) {
    return column?.sub ? `${column.label} ${column.sub}` : column?.label || '';
}

/**
 * A name for a result row that survives the table being rebuilt.
 *
 * The rows carry their index in the *sorted* array, which is the one thing about
 * them that changes every time a header is clicked. Keying an open detail row by
 * that index reopened whatever had since landed in that position; keying it by
 * the candidate it describes reopens the same upgrade.
 *
 * Escaped for an attribute, because these come from item names and a stray quote
 * would end the attribute early and take the rest of the row with it.
 *
 * @param {Object} result - A row from the upgrade analysis
 * @returns {string} A key stable across sorts, column changes and re-scores
 */
export function upgradeRowKey(result) {
    const c = result?.candidate || {};
    const parts = [c.type || 'equipment', c.slot ?? '', c.upgradeHrid ?? '', c.upgradeLevel ?? '', c.description ?? ''];
    return parts.join('|').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * The Cost cell: a number, or the fact that there is no number.
 *
 * Three states, and they used to be two. Unknown stays `?`. A positive cost is
 * a cost. A cost at or below zero is the case the old `Math.max(0, …)` floor
 * erased: a swap whose resale covers what it replaces hands gold back, and
 * flattening that to "free" both lost the size of the refund and made the row
 * divide into an unbounded value on every ladder. It reads as a credit now,
 * with its own sign.
 *
 * @param {Object} result - An upgrade result row
 * @returns {{text: string, color: string|null, title: string}}
 */
export function upgradeCostCell(result) {
    const cost = result?.cost;
    if (cost == null) {
        return { text: '?', color: '#888', title: 'No price could be found for part of this upgrade.' };
    }
    if (cost < 0) {
        return {
            text: `+${formatKMB(-cost)}`,
            color: '#4caf50',
            title:
                'Pays for itself: what the gear it replaces sells for is more than this costs, so the swap ' +
                'hands you gold back.',
        };
    }
    if (cost === 0) {
        return { text: 'free', color: '#4caf50', title: 'Costs nothing up front.' };
    }
    return { text: formatKMB(cost), color: null, title: '' };
}

/**
 * The small tag saying what kind of number a cost is.
 *
 * A market delta, an expected enhancement path and a production cost all land
 * in one column and are not equally solid. Three characters of tag is the
 * cheapest honest way to say which one a reader is looking at.
 *
 * @param {string|null} source - A key of `COST_SOURCES`
 * @returns {string} HTML, empty when the basis is unknown
 */
export function costSourceTagHtml(source) {
    const entry = COST_SOURCES[source];
    if (!entry) return '';
    return `<span title="${entry.title}" style="color:#666; font-size:9px; margin-left:3px;">${entry.label}</span>`;
}

/**
 * What a row's headline delta could be measurement error.
 *
 * Every percentage in the table is read off a finite sample, and until now
 * nothing in the combat tables said so — a 0.2% gain measured over eighty
 * encounters looked exactly like a 15% one. This is the ± that goes beside a
 * delta, and the tag that appears when the delta has not cleared it.
 *
 * @param {Object} result - An upgrade result row
 * @param {string} [metricKey='dps'] - Which metric to speak about
 * @returns {{noisePct: number|null, significant: boolean}}
 */
export function upgradeNoiseFor(result, metricKey = 'dps') {
    const noisePct = result?.noise?.[metricKey];
    return {
        noisePct: Number.isFinite(noisePct) ? noisePct : null,
        significant: result?.significantBy?.[metricKey] ?? true,
    };
}

/** Shared styling for the small qualifier chips that sit beside a row's name */
const ROW_NOTE_STYLE = 'font-size:9px; margin-left:4px; padding:0 3px; border-radius:2px; vertical-align:middle;';

/**
 * The qualifiers a row cannot be read correctly without.
 *
 * Both of them were previously invisible or buried in a tab tooltip:
 *
 * - **fresh book** / **from LvN** / **book owned** — which book an ability
 *   *swap* was priced from. An ability you have never read is a book learned and
 *   levelled from zero; one already in your book bag is topped up from the level
 *   it is at, which is a completely different figure; and one already *at* the
 *   level the row wants costs nothing at all, because slotting it is not a
 *   purchase. That term is the largest in the cost, and it lived only in the
 *   Ability Swaps checkbox tooltip, where a row quoting 900M gave no hint of
 *   which of the three it meant — and a row quoting 0 gave none either.
 * - **on task** — the row's ranked gain was simulated off task, where taskDamage
 *   pays nothing, so a task trinket's headline stat is deliberately not in the
 *   number. The chip's tooltip names what it would add on task instead.
 *
 * @param {Object} result - An upgrade result row
 * @returns {string} HTML, empty when the row needs no qualifier
 */
export function upgradeRowNotesHtml(result) {
    const notes = [];
    const candidate = result?.candidate || {};

    // No "within noise" chip here. It used to sit in the collapsed row title,
    // where it competed with the row's own name on every second row and said
    // nothing about *which* figure was inside the error bar. The per-metric
    // annotation in the expanded detail says exactly that, beside the number it
    // is about, and is where the qualification belongs.
    if (candidate.type === 'ability_swap') {
        const detail = result?.costDetail;
        const books = detail?.books;
        const count = Number.isFinite(books?.books) ? Math.ceil(books.books) : null;
        // An ability already in the book bag is topped up from where it is, not
        // learned again — two different costs, and the chip is where the reader
        // finds out which one the row is quoting
        const owned = detail?.ownedFromLevel != null;
        let label;
        let title;
        if (detail?.ownedNotSlotted) {
            // A row costing nothing is the one row a reader is right to distrust,
            // so it says what makes it free rather than leaving a 0 unattributed
            label = 'book owned';
            title =
                `Free because you already own this ability at Lv${detail.ownedFromLevel ?? 0} — it is just not ` +
                'slotted. Nothing to buy; the only cost is the slot it goes in.';
        } else if (owned) {
            label = `from Lv${detail.ownedFromLevel}`;
            title =
                `You already own this ability at Lv${detail.ownedFromLevel}, so the cost is the ` +
                `${count ? `${count} ${books.bookName}${count === 1 ? '' : 's'}` : 'books'} that take it from there ` +
                'to the target — not a book learned from nothing.';
        } else {
            label = 'fresh book';
            title = count
                ? `Cost assumes ${count} ${books.bookName}${count === 1 ? '' : 's'} — learning the ability and ` +
                  'levelling it from nothing, which is what an ability you do not own costs.'
                : 'Cost assumes learning the ability and levelling a book from nothing, which is what an ability ' +
                  'you do not own costs.';
        }
        notes.push(
            `<span title="${title}" style="${ROW_NOTE_STYLE} background:#1a2030; color:#8ab4f8;">${label}</span>`
        );
    }

    if (candidate.caveat) {
        notes.push(
            `<span title="${candidate.caveat}" style="${ROW_NOTE_STYLE} background:#1a2030; color:#8ab4f8;">on task</span>`
        );
    }

    return notes.join('');
}

// The snapshot's home moved to `utils/all-zones-snapshot.js` so read-only
// consumers need not import this whole module; re-exported here because this
// is where every existing consumer looks for it
export { ALL_ZONES_SNAPSHOT_KEY, ALL_ZONES_SNAPSHOT_STORE };

/** Candidate types paid for in ability books rather than at the equipment market */
const ABILITY_CANDIDATE_TYPES = new Set(['ability_level', 'ability_swap']);

/**
 * A short, stable digest of a long string.
 *
 * djb2, because the fingerprint is only ever compared with another fingerprint —
 * nothing is looked up by it, so collision resistance beyond "different gear
 * reads differently" buys nothing, and a 1.5 KB equipment list stored verbatim
 * on every run does not.
 *
 * @param {string} text - What to digest
 * @returns {string} Base-36 digest
 */
function digest(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/**
 * A signature for the gear a run was simulated in.
 *
 * Every player's equipped items and their enhancement levels, sorted so that the
 * same loadout always digests the same way whatever order the slots arrive in.
 * Party membership counts: a three-player result is not a claim about a solo
 * one, so losing a member has to read as "this no longer describes you".
 *
 * Equipment only. Levels and abilities move constantly and would flag every
 * saved run as stale within an hour, which is the same as having no flag.
 *
 * @param {Array<Object>} playerDTOs - Player DTOs the run was given
 * @returns {string|null} Digest, or null when there is nothing to sign
 */
export function gearFingerprint(playerDTOs) {
    const players = Array.isArray(playerDTOs) ? playerDTOs.filter(Boolean) : [];
    if (!players.length) return null;

    const parts = players
        .map((dto) => {
            const slots = Object.entries(dto.equipment || {})
                .filter(([, item]) => item?.hrid)
                .map(([slot, item]) => `${slot}=${item.hrid}+${item.enhancementLevel || 0}`)
                .sort();
            return `${dto.hrid || 'player'}[${slots.join(',')}]`;
        })
        .sort();

    return digest(parts.join(';'));
}

/**
 * The gear currently worn, signed the same way a run signs itself.
 * @returns {Promise<string|null>} Digest, or null when character data is unavailable
 */
export async function currentGearFingerprint() {
    try {
        const { players } = await buildAllPlayerDTOs();
        return gearFingerprint(players);
    } catch (error) {
        console.error('[CombatSimUI] Reading the current gear fingerprint failed:', error);
        return null;
    }
}

/**
 * Reduce a finished all-zones run to what outlives the panel.
 *
 * Profit/hr and XP/hr per zone/tier and nothing else: the full SimResults are
 * megabytes of per-monster detail that only the table that just drew them can
 * read, and a ranked list needs two numbers and a name.
 *
 * @param {Array<Object>} zoneResults - `{zone, simResult, revenue}` per zone/tier
 * @param {Object} [options] - Run context
 * @param {number} [options.hours] - Hours simulated, as a fallback for the rate divisor
 * @param {string} [options.playerHrid] - Which player's XP is being reported
 * @param {string|null} [options.fingerprint] - Gear signature of the run
 * @param {number} [options.savedAt] - When it finished
 * @param {boolean} [options.maxTierFood] - Whether the run substituted max-tier food
 * Dungeon rows additionally carry `dungeon` — completions, party size,
 * consumable cost and deaths per simulated hour — which is what the dungeon
 * ROI board needs to quote a simulated clear time for a tier nobody has run.
 * Additive, so a reader that predates it sees the same row it always did.
 *
 * @returns {Object} `{version, savedAt, hours, fingerprint, maxTierFood, zones}`
 */
export function buildAllZonesSnapshot(zoneResults, options = {}) {
    const {
        hours = 0,
        playerHrid = 'player1',
        fingerprint = null,
        savedAt = Date.now(),
        maxTierFood = false,
    } = options;

    const zones = (Array.isArray(zoneResults) ? zoneResults : [])
        .filter((result) => result?.simResult && result.zone)
        .map((result) => {
            // The simulator's own clock where it reported one, since early exit
            // and cancellation both cut a run short of the hours asked for
            const simHours = (result.simResult.simulatedTime || 0) / (3600 * 1e9) || hours || 1;
            const xp = result.simResult.experienceGained?.[playerHrid] || {};
            const totalXp = Object.values(xp).reduce((sum, value) => sum + (value || 0), 0);

            const sim = result.simResult;
            const dungeon = sim.isDungeon
                ? {
                      completions: sim.dungeonsCompleted || 0,
                      failed: sim.dungeonsFailed || 0,
                      simHours,
                      partySize: sim.numberOfPlayers || 1,
                      // Consumables only, which is what the name promises and what the
                      // Dungeon ROI board's measured branch counts. `costPerHour` also
                      // carries the entry and chest keys for a dungeon, and that board
                      // subtracts keys itself (`keyCostPerRun`) — handed the combined
                      // figure it charged for them twice, and the sim and measured
                      // readings of the same column stopped meaning the same thing.
                      consumableCostPerHour: Number.isFinite(result.revenue?.costPerHour)
                          ? result.revenue.costPerHour - (Number(result.revenue.keyCostPerHour) || 0)
                          : null,
                      deathsPerHour: (sim.deaths?.[playerHrid] || 0) / simHours,
                  }
                : null;

            return {
                zoneHrid: result.zone.zoneHrid || result.zone.hrid || '',
                zoneName: result.zone.name || '',
                difficultyTier: result.zone.difficultyTier ?? 0,
                ...(dungeon ? { dungeon } : {}),
                // Deliberately the sim's raw, uncapped claim: the calibration
                // surfaces that compare sim-vs-measured read this figure, and a
                // market-volume cap is a display truth, not a sim truth. The
                // per-item composition below is what lets a *display* reading
                // the snapshot apply the cap at rank time.
                profitPerHour: Number.isFinite(result.revenue?.netPerHour) ? result.revenue.netPerHour : null,
                xpPerHour: totalXp / simHours,
                sells: (result.revenue?.dropEntries || [])
                    .filter((entry) => entry?.itemHrid && Number(entry.countPerHour) > 0)
                    .map((entry) => ({
                        itemHrid: entry.itemHrid,
                        name: entry.name || null,
                        unitsPerHour: entry.countPerHour,
                    })),
            };
        })
        .filter((zone) => zone.zoneHrid);

    // `maxTierFood` is additive and always present, false included: a reader
    // that has never heard of it goes on reading `zones` and `fingerprint`
    // unchanged, and a reader that has can tell "this run was on substituted
    // food" apart from "this run predates the flag" only if the flag is written
    // every time rather than only when it is true.
    return { version: 1, savedAt, hours, fingerprint, maxTierFood: Boolean(maxTierFood), zones };
}

/**
 * The per-skill XP columns the all-zones table can show, in display order.
 *
 * Separate from the headline columns because they are the ones that go missing:
 * a single-style build earns in two or three of the seven, and the rest are a
 * column of zeros each.
 */
export const ALL_ZONES_SKILL_COLUMNS = [
    { key: 'stamina', label: 'Stam' },
    { key: 'intelligence', label: 'Int' },
    { key: 'attack', label: 'Atk' },
    { key: 'melee', label: 'Melee' },
    { key: 'defense', label: 'Def' },
    { key: 'ranged', label: 'Ranged' },
    { key: 'magic', label: 'Magic' },
];

/**
 * Which per-skill XP columns this run has anything to say about.
 *
 * A column whose every row reads 0 is width spent on a fact the reader already
 * has — the build does not train that skill — and six of them at once is what
 * pushed the table into a horizontal scroll. Total XP/hr is never dropped: it
 * is the headline, and a run that earns nothing anywhere should still show a
 * zero rather than lose the column.
 *
 * @param {Array<Object>} rows - Table rows carrying per-skill XP rates
 * @returns {Array<Object>} The subset of ALL_ZONES_SKILL_COLUMNS worth drawing
 */
export function visibleAllZonesSkillColumns(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return ALL_ZONES_SKILL_COLUMNS.filter((col) => list.some((row) => Math.abs(Number(row?.[col.key]) || 0) > 0));
}

/**
 * The metrics the all-zones Score blends, and which direction is good.
 *
 * Deaths are deliberately not among them. They are a constraint rather than a
 * quantity to trade off — a zone that kills you four times an hour is not
 * two-thirds of a good zone — so they stay red in their own column where they
 * cannot be averaged away, and the Score header says so.
 */
const ALL_ZONES_SCORE_METRICS = [
    { key: 'totalXP', label: 'XP/hr' },
    { key: 'profitDay', label: 'Profit/day' },
];

/**
 * Score each zone by how well it places across XP and profit at once.
 *
 * The same ordinal idea the Upgrade tab's Score uses — rank within each metric,
 * then blend — with one deliberate difference: the upgrade ladder awards points
 * to the top five only, which across sixty-six zones would leave all but five
 * rows at zero. Here every row gets its position in each ladder as a fraction
 * (1 for best, 0 for worst), and the Score is the mean of those, out of 100.
 *
 * Ties share a position, so two zones that measure identically cannot be
 * separated by list order. A single row scores 100: with nothing to rank
 * against, it is trivially the best of what was simulated.
 *
 * Mutates and returns the rows, adding `score`.
 *
 * @param {Array<Object>} rows - Table rows carrying `totalXP` and `profitDay`
 * @returns {Array<Object>} The same rows
 */
export function scoreAllZoneRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return list;

    const fractions = new Map(list.map((row) => [row, []]));
    for (const metric of ALL_ZONES_SCORE_METRICS) {
        const values = list.map((row) => (Number.isFinite(row[metric.key]) ? row[metric.key] : 0));
        // Best first, duplicates collapsed, so equal figures share a position
        const ladder = [...new Set(values)].sort((a, b) => b - a);
        if (ladder.length < 2) {
            for (const row of list) fractions.get(row).push(1);
            continue;
        }
        list.forEach((row, i) => {
            const place = ladder.indexOf(values[i]);
            fractions.get(row).push(1 - place / (ladder.length - 1));
        });
    }

    for (const row of list) {
        const parts = fractions.get(row);
        row.score = Math.round((100 * parts.reduce((sum, value) => sum + value, 0)) / parts.length);
    }
    return list;
}

/**
 * The two rows worth naming above the table: most XP and most profit.
 *
 * Null where there is nothing to pick — no rows, or a run in which every zone
 * earned exactly the same, where declaring a winner would be an artefact of
 * list order rather than a finding.
 *
 * @param {Array<Object>} rows - Table rows
 * @returns {{xp: Object|null, profit: Object|null}}
 */
export function bestAllZoneRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const bestBy = (key) => {
        if (list.length < 2) return null;
        const values = list.map((row) => (Number.isFinite(row[key]) ? row[key] : 0));
        const top = Math.max(...values);
        if (values.every((value) => value === top)) return null;
        return list[values.indexOf(top)];
    };
    return { xp: bestBy('totalXP'), profit: bestBy('profitDay') };
}

export { saveAllZonesSnapshot, loadAllZonesSnapshot };

/**
 * What an upgrade row would have you buy, if anything.
 *
 * Two kinds of row are not a purchase and get nothing: combat levels are paid
 * for in experience, and anything whose candidate names no item at all.
 *
 * A house room is a third case rather than a fourth non-case. It buys no single
 * item — a level is a shopping list of materials, and a multi-level jump is
 * several of those lists — so it carries `house` instead of an item to reserve:
 * a room-level *goal*, which Equipment Savings keeps beside the gear and ability
 * targets, and a `materials` list. The Market button is offered for the one
 * material the bill is mostly made of, with the rest named in its tooltip, so
 * nobody clicks it believing one tab covers the room. A level whose materials
 * are all coin has no marketable line and gets no Market button.
 *
 * Ability rows are a purchase — the books are ordinary marketplace goods — so
 * they can be watched, bought at the market, and saved for. Saving for one is
 * not the gear list's slot-by-slot reservation, which a stack of books could
 * never fill; it is an ability *goal*, which Equipment Savings keeps beside the
 * gear targets. `ability` carries what that goal needs, and `savable` stays
 * about the slot reservation so nothing downstream conflates the two.
 *
 * `quantity` is how many of the item the row actually has you buy. For gear that
 * is one — a slot holds one sword — but an ability row is priced in *books*, and
 * "go to the market" for a row costing 140M of Berserk books meant arriving at a
 * buy box defaulted to 1 with the real figure left in the table behind you. It
 * is the same book count the cost was computed from, rounded up, because there
 * is no such thing as buying four-fifths of a book.
 *
 * `items` is every item the row buys, and only exists where that is more than
 * one: a cross-slot swap replaces a two-hander with a main hand *and* an off
 * hand, and an armour pair buys both pieces. It is read off the candidate's
 * `addedSlots`, which is also what `explainUpgradeCost` prices, so the list
 * cannot name something the row was not costed for. The single-item fields
 * stay as they are — the savings list reserves one slot and the watchlist
 * watches one item, and neither is being asked to grow a second here.
 *
 * @param {Object} result - A row from the upgrade analysis, or a budget pick
 * @returns {Object|null} `{itemHrid, enhancementLevel, name, quantity, items, savable, ability}`, or null
 */
export function upgradeRowPurchase(result) {
    const candidate = result?.candidate;
    if (!candidate) return null;

    const type = candidate.type || 'equipment';
    if (type === 'combat_level' || type === 'community_buff' || type === 'scroll') return null;
    if (type === 'house') return houseRowPurchase(candidate, result);

    const isBook = ABILITY_CANDIDATE_TYPES.has(type);
    // A coffee is a consumable, so it can be watched but never saved for — the
    // savings list is slot-by-slot gear and a drink fills no slot
    const isConsumable = type === 'drink';
    // The book for an ability shares its slug: /abilities/fireball → /items/fireball
    const itemHrid = isBook
        ? String(candidate.upgradeHrid || '').replace('/abilities/', '/items/')
        : candidate.upgradeHrid;
    if (!itemHrid || !String(itemHrid).startsWith('/items/')) return null;

    const enhancementLevel = isBook ? 0 : Number(candidate.upgradeLevel) || 0;
    // Where the row's own figure came from, in one word — `market`, `craft`,
    // `tester shop`. It rides along with the price so the savings list can say
    // whose number it is showing rather than presenting it as its own.
    const costSource = result?.costDetail?.source || candidate.costSource || '';
    const baseName = dataManager.getItemDetails?.(itemHrid)?.name || itemHrid.split('/').pop().replace(/_/g, ' ');

    // The books cost, read off the row the sim just costed rather than guessed
    // at again here. Null when the row could not be priced, which the goal
    // stores as unpriced rather than as free.
    const cost = Number.isFinite(result?.cost) ? result.cost : null;
    const targetLevel = Math.max(0, Math.floor(Number(candidate.upgradeLevel) || 0));

    // What a price pin on the watched ITEM should be targeted at. `cost` is the
    // row's net — purchase minus the resale credit of what it replaces — and the
    // price panel's pin compares against the item's own ask, which never falls
    // to net-of-your-resale (an enhancement row's net is the target level's ask
    // minus the current piece's bid: a target unreachable by construction). The
    // breakdown's buy line for this exact item is a figure the market can hit;
    // its gross, then the net, stand in when there is no such line.
    const buyLine = (result?.costDetail?.buys || []).find(
        (line) => line?.hrid === itemHrid && (line.enhancementLevel || 0) === enhancementLevel
    );
    const watchCost = Number.isFinite(buyLine?.price)
        ? buyLine.price
        : Number.isFinite(result?.costDetail?.gross)
          ? result.costDetail.gross
          : cost;

    return {
        itemHrid,
        enhancementLevel,
        name: enhancementLevel > 0 ? `${baseName} +${enhancementLevel}` : baseName,
        quantity: isBook ? abilityBookCount(result) : 1,
        items: isBook ? null : multiItemPurchase(candidate),
        savable: !isBook && !isConsumable,
        // The gear side's equivalent of `ability.cost`: the price this row was
        // costed at, so the savings list shows the figure that was on screen
        // when the button was pressed rather than re-deriving its own
        cost,
        watchCost,
        costSource,
        ability: isBook
            ? {
                  abilityHrid: candidate.upgradeHrid,
                  targetLevel,
                  cost,
                  label: `${baseName} Lv${targetLevel}`,
              }
            : null,
    };
}

/**
 * Every item a candidate puts on, when that is more than one.
 *
 * `addedSlots` is how the advisor states a swap that fills several slots at
 * once — the two_hand → main_hand + off_hand case, and the armour pairs — and
 * every entry in it is a purchase, since `explainUpgradeCost` prices exactly
 * those entries. One slot is an ordinary single-item row and gets null, so
 * nothing downstream has to tell "a list of one" from "no list".
 *
 * A piece the swap takes off and puts straight back on is not a purchase.
 * `lab-armor-candidates` offers a multi-slot assignment as soon as ONE of its
 * slots differs — `isAlreadyEquipped` rejects only the assignment that matches
 * in every slot — so a body/legs pair whose legs are the ones already worn
 * names those legs in `addedSlots` AND in `removedItems`. The bill counts held
 * copies from the inventory, and a worn piece is not in the inventory, so the
 * tab said "Missing: 1" for trousers the player had on. Matched on hrid and
 * level, which is what makes two pieces the same piece here.
 *
 * @param {Object} candidate - An equipment candidate
 * @returns {Array<{itemHrid: string, enhancementLevel: number, count: number, name: string}>|null}
 */
function multiItemPurchase(candidate) {
    const all = candidate?.addedSlots ? Object.values(candidate.addedSlots) : [];
    if (all.length < 2) return null;
    const levelOf = (item) => Math.max(0, Math.floor(Number(item?.enhancementLevel) || 0));
    const kept = new Set((candidate.removedItems || []).map((item) => `${item?.hrid}|${levelOf(item)}`));
    const added = all.filter((item) => !kept.has(`${item?.hrid}|${levelOf(item)}`));
    if (!added.length) return null;
    return added.map((item) => {
        const level = levelOf(item);
        const base =
            dataManager.getItemDetails?.(item.hrid)?.name || String(item.hrid).split('/').pop().replace(/_/g, ' ');
        return {
            itemHrid: item.hrid,
            enhancementLevel: level,
            // One of each: a slot holds one piece, however many slots the swap fills
            count: 1,
            name: level > 0 ? `${base} +${level}` : base,
        };
    });
}

/**
 * A house row, as a handoff.
 *
 * The goal is the room and the level it is being taken to — one target per room,
 * so re-adding replaces rather than stacks — priced at whatever the row was
 * costed at, null when it could not be priced.
 *
 * The Market side is the honest part. A house level buys materials, and the
 * marketplace opens one item at a time, so what is offered is the biggest line
 * on the bill with its full count armed in the buy box, and the tooltip names
 * the rest. Where the level is coins and nothing tradeable, there is nothing to
 * open and `itemHrid` is null, which the markup reads as "no Market button".
 *
 * @param {Object} candidate - A `house` candidate
 * @param {Object} result - The row it came from, for the costed price
 * @returns {Object|null} The same shape as a gear purchase, plus `house`
 */
function houseRowPurchase(candidate, result) {
    const roomName = candidate.roomName || candidate.roomHrid?.split('/').pop().replace(/_/g, ' ') || 'House room';
    const targetLevel = Math.max(0, Math.floor(Number(candidate.upgradeLevel) || 0));
    const cost = Number.isFinite(result?.cost) ? result.cost : null;

    let materials = [];
    try {
        materials = houseUpgradeMaterials(candidate, buildGameDataPayload() || {});
    } catch (error) {
        console.error('[CombatSimUI] Reading a house room’s materials failed:', error);
    }

    const biggest = materials[0] || null;
    return {
        itemHrid: biggest?.itemHrid || null,
        enhancementLevel: 0,
        name: `${roomName} Lv${targetLevel}`,
        quantity: biggest?.count || 1,
        // Nothing to reserve in the gear list: a room is not a slot
        savable: false,
        ability: null,
        house: {
            houseRoomHrid: candidate.roomHrid,
            targetLevel,
            cost,
            label: `${roomName} Lv${targetLevel}`,
        },
        materials,
    };
}

/**
 * What the Market button on a house row should say it does.
 *
 * Explicit about its own limits: one click is one material, and a room level
 * usually wants three or four. Naming the others with their counts is what stops
 * "Opened ✓" from reading as "shopping done".
 *
 * @param {Object} buy - From `houseRowPurchase`
 * @returns {string} Tooltip text
 */
function houseMarketTitle(buy) {
    const lines = buy.materials || [];
    if (!lines.length) return 'Open this in the marketplace';

    return (
        'Opens the marketplace with a tab per material this level needs, each arming the buy box with what ' +
        'you are still short of — ' +
        lines.map((line) => `${line.count.toLocaleString()}× ${line.name}`).join(', ') +
        '.'
    );
}

/**
 * How many books an ability row buys.
 *
 * The advisor already worked this out to price the row — `costDetail.books.books`
 * is the fractional count the cost was multiplied out of — so it is read back
 * rather than derived a second time from levels and XP tables that could drift
 * out of step with it. Fractional because the last book is usually a partial
 * one; you still have to buy it, hence the ceiling.
 *
 * @param {Object} result - An upgrade result row
 * @returns {number} Books to buy, at least one, or 1 when the row never priced
 */
export function abilityBookCount(result) {
    const books = result?.costDetail?.books?.books;
    if (Number.isFinite(books) && books > 0) return Math.max(1, Math.ceil(books));

    // A row that never priced (no book on the market) still knows its levels:
    // count the books from the character's own progress in the ability
    try {
        const candidate = result?.candidate;
        const abilityHrid = candidate?.upgradeHrid;
        const targetLevel = Math.floor(Number(candidate?.upgradeLevel) || 0);
        if (abilityHrid && targetLevel > 0) {
            const owned = (dataManager.getLearnedAbilities?.() || []).find(
                (entry) => entry?.abilityHrid === abilityHrid
            );
            const level = Math.floor(Number(owned?.level) || 0);
            const floorXp = dataManager.getInitClientData?.()?.levelExperienceTable?.[level] || 0;
            const xp = Number.isFinite(Number(owned?.experience)) ? Number(owned.experience) : floorXp;
            const fromLive = explainAbilityLevelUpCost(abilityHrid, level, xp, targetLevel)?.books;
            if (Number.isFinite(fromLive) && fromLive > 0) return Math.max(1, Math.ceil(fromLive));
        }
    } catch (error) {
        console.error('[CombatSimUI] Counting an ability row’s books failed:', error);
    }
    return 1;
}

/**
 * The buy-modal autofill the Market button arms, made on first use.
 *
 * Lazy because it registers a document-wide modal observer, and a panel nobody
 * has clicked Market in has no business watching for marketplace modals. One
 * manager for the whole module: two rows cannot be handed off at once.
 */
let marketAutofill = null;

/** @returns {Object} The shared autofill manager, initialising it once */
function upgradeMarketAutofill() {
    if (!marketAutofill) {
        marketAutofill = createAutofillManager('CombatSimUpgrade-Market');
        marketAutofill.initialize();
    }
    return marketAutofill;
}

/**
 * Stop watching for buy modals and forget any armed quantity.
 * Called when the panel goes away, so a closed simulator leaves nothing behind.
 */
export function cleanupUpgradeMarketAutofill() {
    marketAutofill?.cleanup();
    marketAutofill = null;
}

/** Shared styling for the small per-row handoff buttons */
const ROW_ACTION_STYLE =
    'background:none; border:1px solid #333; border-radius:3px; color:#8ab4f8; font-size:9px; ' +
    'padding:0 4px; margin-left:4px; cursor:pointer; font-family:inherit; vertical-align:middle;';

/**
 * The "Save for this", "Watch" and "Market" buttons for one upgrade row.
 *
 * Returned as markup rather than elements because every table that wants them is
 * built as an HTML string; `wireUpgradeRowActions` gives them their behaviour
 * once the string is in the document.
 *
 * Both kinds of row can be saved for, by two different routes: gear reserves a
 * slot in Equipment Savings, an ability book records a level goal. Market opens
 * whatever the row actually buys — for an ability that is the book, which is an
 * ordinary marketplace item — so it is offered by anything that buys at all. A
 * row that buys a *stack*, or more than one item, carries what it buys as a
 * bill and goes through the missing-materials tabs, the same machinery a house
 * level's bill uses.
 *
 * @param {Object} result - A row from the upgrade analysis, or a budget pick
 * @returns {string} HTML, empty for rows that buy nothing
 */
export function upgradeRowActionsHtml(result) {
    const buy = upgradeRowPurchase(result);
    if (!buy) return '';

    const attrs =
        `data-buy-hrid="${buy.itemHrid || ''}" data-buy-level="${buy.enhancementLevel}" ` +
        `data-buy-quantity="${buy.quantity}"`;

    // A house room reserves nothing and watches nothing — there is no one item
    // to watch — so it gets its own pair: the room-level goal, and the market
    // handoff for the material the bill is mostly made of
    if (buy.house) {
        const cost = buy.house.cost == null ? '' : String(buy.house.cost);
        const saveHouse = `<button type="button" data-buy-action="save-house"
            data-house-hrid="${buy.house.houseRoomHrid}" data-house-level="${buy.house.targetLevel}"
            data-house-cost="${cost}" data-house-label="${escapeAttribute(buy.house.label)}"
            title="Save towards ${escapeAttribute(buy.house.label)} in Equipment Savings"
            style="${ROW_ACTION_STYLE}">Save for this</button>`;
        if (!buy.itemHrid) return saveHouse;
        // The whole bill rides the button, so the click can open every line at
        // once through the missing-materials tabs; the single-item attributes
        // stay as the fallback when that module is not loaded
        const bill = (buy.materials || []).map((line) => ({ itemHrid: line.itemHrid, count: line.count }));
        return `${saveHouse}<button type="button" ${attrs} data-buy-action="market"
            data-buy-materials="${escapeAttribute(JSON.stringify(bill))}"
            title="${escapeAttribute(houseMarketTitle(buy))}" style="${ROW_ACTION_STYLE}">Market</button>`;
    }

    let save = '';
    if (buy.savable) {
        // The costed price rides the button exactly as it does on the ability
        // and house rows. Without it the savings list re-derived the price with
        // a different model, and the two surfaces disagreed about one target.
        const cost = buy.cost == null ? '' : String(buy.cost);
        save = `<button type="button" ${attrs} data-buy-action="save"
            data-buy-cost="${cost}" data-buy-cost-source="${escapeAttribute(buy.costSource || '')}"
            title="Save for this in Equipment Savings"
            style="${ROW_ACTION_STYLE}">Save for this</button>`;
    } else if (buy.ability) {
        const cost = buy.ability.cost == null ? '' : String(buy.ability.cost);
        save = `<button type="button" ${attrs} data-buy-action="save-ability"
            data-ability-hrid="${buy.ability.abilityHrid}" data-ability-level="${buy.ability.targetLevel}"
            data-ability-cost="${cost}" data-ability-label="${escapeAttribute(buy.ability.label)}"
            title="Save towards ${escapeAttribute(buy.ability.label)} in Equipment Savings"
            style="${ROW_ACTION_STYLE}">Save for this</button>`;
    }

    // A row that buys a stack — an ability's books — is a one-line bill, and
    // goes through the same missing-materials tabs a house level does: a tab
    // that arms the buy box with what is still short of the stack and stands
    // down when you leave the marketplace. A cross-slot swap buys two pieces
    // and takes the same road for the other reason: one click has to end at
    // both of them, and a bill line carries its enhancement level, so a +7
    // pair opens as two +7 tabs. A single piece is one item at one level and
    // keeps the plain open, which needs no module loaded to work.
    const lines = buy.items?.length
        ? buy.items.map((item) => ({
              itemHrid: item.itemHrid,
              count: item.count,
              enhancementLevel: item.enhancementLevel,
          }))
        : buy.quantity > 1 && buy.enhancementLevel === 0
          ? [{ itemHrid: buy.itemHrid, count: buy.quantity }]
          : null;
    const bill = lines ? ` data-buy-materials="${escapeAttribute(JSON.stringify(lines))}"` : '';
    const marketTitle = buy.items?.length
        ? `Opens the marketplace with a tab for each of ${buy.items.map((item) => item.name).join(' and ')}`
        : bill
          ? `Opens the marketplace with a tab for this, arming the buy box with what you are still short of the ` +
            `${buy.quantity.toLocaleString()} this upgrade needs`
          : 'Open this in the marketplace';

    // A costed price rides the Watch button as well as the Save one: watching
    // an item you have just been quoted a price for almost always means "tell
    // me when it costs that", and the price panel's pin can carry that as a
    // target rather than making the reader retype a figure already on screen.
    // The WATCH price, not the row's net cost — see `upgradeRowPurchase`: the
    // pin fires on the item's own ask, which resale credit never reaches.
    const watchCost = buy.watchCost == null ? '' : String(buy.watchCost);
    return `${save}<button type="button" ${attrs} data-buy-action="watch" data-buy-cost="${watchCost}"
        title="Add to the watchlist" style="${ROW_ACTION_STYLE}">Watch</button><button type="button" ${attrs} data-buy-action="market"${bill}
        title="${escapeAttribute(marketTitle)}" style="${ROW_ACTION_STYLE}">Market</button>`;
}

/**
 * Make a value safe to sit inside a double-quoted HTML attribute.
 * Item and ability names come from game data, and one apostrophe or quote in a
 * name would otherwise end the attribute early.
 * @param {string} value - Raw text
 * @returns {string} Escaped text
 */
function escapeAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Also pin the item on the price panel, targeted at what the row costed it.
 *
 * Strictly an *addition* to what Watch already does — the inventory watchlist
 * entry is made either way, and nothing here can prevent or alter it. The price
 * panel keeps its own separate list of pins, and this is the second half of the
 * same intention: the row quoted a figure, and a pin targeted at that figure is
 * what turns "watch this" into "tell me when it gets there".
 *
 * Quiet whenever the price panel is not running — it is off by default, being
 * the feature that talks to a third-party dataset — and quiet for a row that
 * could not be priced, since a target of nothing is not a target. Reached
 * through the bundle bridge because the panel lives in the Market bundle and
 * only that copy holds the pins.
 *
 * @param {string} itemHrid - The item the row buys
 * @param {number} enhancementLevel - At the level the row buys it
 * @param {string|null} rawCost - The row's costed price, off the button
 */
/**
 * The live writer for a row handoff, or a throw naming what is missing.
 *
 * There is no bundle-local fallback to take instead: this bundle loads before
 * market, so its own copy of those writers keeps memory the visible panel never
 * reads — a handoff into it looks like it worked and is gone by the next
 * repaint. The throw lands in the click handler's catch, which labels the
 * button "Failed", which is what actually happened.
 *
 * @param {Function|null} writer - What the bridge answered
 * @param {string} name - Its name, for the message
 * @returns {Function} The writer
 */
function requireHandoff(writer, name) {
    if (typeof writer !== 'function') {
        throw new Error(`Market bundle's ${name} is not available; the row cannot be handed off`);
    }
    return writer;
}

function seedWatchlistPriceTarget(itemHrid, enhancementLevel, rawCost) {
    const cost = rawCost === '' || rawCost == null ? null : Number(rawCost);
    if (!Number.isFinite(cost) || !(cost > 0)) return;

    try {
        marketHistoryPanel()?.seedPriceTarget?.(itemHrid, enhancementLevel, cost);
    } catch (error) {
        // Never at the expense of the watch that did work: the inventory entry
        // is already made, and a failed pin is not a failed handoff
        console.error('[CombatSimUI] Seeding a price target failed:', error);
    }
}

/**
 * Make the per-row handoff buttons work, wherever they were drawn.
 *
 * The click is stopped from propagating: every table puts these inside a row
 * whose own click opens the detail panel, and saving for a sword should not also
 * unfold the breakdown of it.
 *
 * Five handoffs, told apart by `data-buy-action`: `save` reserves a gear slot,
 * `save-ability` records a book-level goal, `save-house` records a room-level
 * goal, `market` opens the item's marketplace tab with the row's quantity
 * waiting in the buy box, and anything else watches the item.
 *
 * @param {HTMLElement} container - Anything containing rendered rows
 * @param {string} [logPrefix] - Module name for error logs
 */
export function wireUpgradeRowActions(container, logPrefix = 'CombatSimUI') {
    container?.querySelectorAll('[data-buy-action]').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();

            const itemHrid = button.getAttribute('data-buy-hrid');
            const enhancementLevel = Number(button.getAttribute('data-buy-level')) || 0;
            const label = button.textContent;

            try {
                const action = button.getAttribute('data-buy-action');
                if (action === 'save') {
                    const rawCost = button.getAttribute('data-buy-cost');
                    requireHandoff(marketWatchTarget(), 'watchTarget')(itemHrid, enhancementLevel, {
                        cost: rawCost === '' || rawCost == null ? null : Number(rawCost),
                        costSource: button.getAttribute('data-buy-cost-source') || '',
                    });
                    button.textContent = 'Saving ✓';
                } else if (action === 'save-ability') {
                    // Fire-and-forget: the goal write is asynchronous and the
                    // button is a handoff, not a form. A failed write logs from
                    // inside the savings module rather than freezing the row.
                    const rawCost = button.getAttribute('data-ability-cost');
                    addAbilityGoal({
                        abilityHrid: button.getAttribute('data-ability-hrid'),
                        targetLevel: Number(button.getAttribute('data-ability-level')) || 0,
                        cost: rawCost === '' || rawCost == null ? null : Number(rawCost),
                        label: button.getAttribute('data-ability-label') || '',
                    });
                    button.textContent = 'Saving ✓';
                } else if (action === 'save-house') {
                    // Same fire-and-forget as the ability goal: the write is
                    // asynchronous, the button is a handoff rather than a form
                    const rawCost = button.getAttribute('data-house-cost');
                    addHouseGoal({
                        houseRoomHrid: button.getAttribute('data-house-hrid'),
                        targetLevel: Number(button.getAttribute('data-house-level')) || 0,
                        cost: rawCost === '' || rawCost == null ? null : Number(rawCost),
                        label: button.getAttribute('data-house-label') || '',
                    });
                    button.textContent = 'Saving ✓';
                } else if (action === 'market') {
                    // A house level is a bill of several materials: hand the
                    // whole of it to the missing-materials tabs, one per line,
                    // each arming what is still short. Falls through to the
                    // one-item open when that module is not around
                    // Anything with a bill — a house level's materials, an
                    // ability row's stack of books — goes to the missing-mats
                    // tabs, one per line, each arming what is still short.
                    // Falls through to the one-item open when that module is
                    // not around
                    const rawBill = button.getAttribute('data-buy-materials');
                    const openBill = missingMaterialsButton()?.openMaterialsList;
                    if (rawBill && typeof openBill === 'function') {
                        marketAutofill?.clearQuantity();
                        openBill(JSON.parse(rawBill));
                        button.textContent = 'Opened ✓';
                    } else {
                        // The fallback arms the count itself. One-shot and tied
                        // to this item: a standing arming for a book you never
                        // bought used to go on filling every later buy box, for
                        // any item, until the page reloaded
                        const quantity = Number(button.getAttribute('data-buy-quantity')) || 1;
                        if (quantity > 1) {
                            upgradeMarketAutofill().setQuantity(quantity, { itemHrid });
                        } else {
                            marketAutofill?.clearQuantity();
                        }
                        navigateToMarketplace(itemHrid, enhancementLevel);
                        button.textContent = 'Opened ✓';
                    }
                } else {
                    // The level goes with it, as it does to the Market button
                    // on the same row: a "+5" watched as a +0 lands on the list
                    // priced at a fraction of what the row was quoting
                    requireHandoff(marketWatchItem(), 'watchItem')(itemHrid, null, enhancementLevel);
                    seedWatchlistPriceTarget(itemHrid, enhancementLevel, button.getAttribute('data-buy-cost'));
                    button.textContent = 'Watching ✓';
                }
            } catch (error) {
                console.error(`[${logPrefix}] Handing the row off failed:`, error);
                button.textContent = 'Failed';
            }

            // The table is rebuilt by every sort and re-render, so a button that
            // has since been replaced simply never sees this fire
            setTimeout(() => {
                button.textContent = label;
            }, 1600);
        });
    });
}

// The party lint lives in `utils/party-lint.js` now, so the DPS panel can run
// the same checks on the live party without importing the simulator UI. It is
// re-exported here because this is where callers and tests found it first.
export { isSkillingGearItem, isAuraAbility, skillingGearWarnings, duplicateAuraWarnings, partyLintWarnings };

/**
 * Sort result rows by a computed key, treating Infinity as "worst" so unknown
 * values land at the end rather than dominating the comparison.
 * @param {Array<Object>} rows - Result rows
 * @param {Function} keyOf - (row) => number|string
 * @param {boolean} asc - Ascending when true
 * @returns {Array<Object>} New sorted array
 */
function sortRowsBy(rows, keyOf, asc) {
    return [...rows].sort((a, b) => {
        const va = keyOf(a);
        const vb = keyOf(b);
        let cmp;
        if (typeof va === 'string') {
            cmp = va.localeCompare(vb);
        } else {
            const na = va === Infinity ? Number.MAX_VALUE : va;
            const nb = vb === Infinity ? Number.MAX_VALUE : vb;
            cmp = na - nb;
        }
        return asc ? cmp : -cmp;
    });
}

/** Shared styling for the small inputs inside a mode chip */
const CHIP_INPUT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:3px 5px; font-size:12px;';
const CHIP_BUTTON_STYLE =
    'background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 8px; border-radius:4px; ' +
    'font-size:11px; cursor:pointer; font-family:inherit;';

/**
 * Options that belong to a specific candidate set. Each lives inside that set's
 * chip in the controls row, so it's visible which checkbox an option modifies —
 * Skip Back sits with Equipment, the level boost with Ability Lv, and so on.
 * Options stay in the DOM when their set is unchecked and are hidden by
 * `_onUpgradeModesChanged`.
 */
const MODE_OPTIONS = {
    equipment: `
        <span data-mode-options="equipment" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label id="mwi-csim-skip-back-label" title="Leave the back slot out of the candidate list" style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-csim-upgrade-skip-back" style="margin:0; cursor:pointer;">
                Skip Back
            </label>
        </span>`,
    ability_level: `
        <span id="mwi-csim-upgrade-level-group" data-mode-options="ability_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <select class="toolasha-select" id="mwi-csim-upgrade-level-type" style="${CHIP_INPUT_STYLE}">
                <option value="increment">+Levels</option>
                <option value="target">Target Lv</option>
            </select>
            <input id="mwi-csim-upgrade-target-level" type="number" min="1" max="200" value="5" placeholder="+5" style="
                width:55px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Number of levels to add to each ability">
            <button id="mwi-csim-ability-targets-toggle" title="Set a desired target level per ability instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    ability_swap: `
        <span data-mode-options="ability_swap" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label id="mwi-csim-swap-aura-label" title="Sim only the aura swap: the guide's aura group for your archetype, both sides of its OR — Critical Aura or Mystic Aura for magic, Critical Aura or Fierce Aura for melee/ranged, Invincible for a wark. Everything else in the guide's set is left out, which is most of the run." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-csim-swap-aura-only" style="margin:0; cursor:pointer;">
                Aura only
            </label>
        </span>`,
    combat_level: `
        <span id="mwi-csim-charm-group" data-mode-options="combat_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label style="color:#888; font-size:12px;">Charm</label>
            <select class="toolasha-select" id="mwi-csim-charm-select" title="Which charm family to swap in per skill when estimating leveling time — Auto matches the equipped charm's tier" style="${CHIP_INPUT_STYLE}"></select>
            <input id="mwi-csim-charm-enh" type="number" min="0" max="20" placeholder="+" style="
                width:44px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Enhancement level to sim the charm at (e.g. 5 for Expert +5). Leave blank to keep the equipped charm's level.">
            <button id="mwi-csim-combat-targets-toggle" title="Set a desired target level per skill instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    house: `
        <span id="mwi-csim-house-group" data-mode-options="house" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label style="color:#888; font-size:12px;">Lv</label>
            <input id="mwi-csim-house-target-level" type="number" min="1" max="8" placeholder="+1" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Target level to sim every combat house room at. Leave blank to sim one level up from where each room is now.">
            <button id="mwi-csim-house-targets-toggle" title="Set a desired target level per room instead of one level for all" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    guild_shrine: `
        <span id="mwi-csim-shrine-group" data-mode-options="guild_shrine" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label style="color:#888; font-size:12px;">Lv</label>
            <input id="mwi-csim-shrine-target-level" type="number" min="1" max="100" placeholder="+1" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Target level to buy every combat shrine buff up to. Cost is every level from where the buff is now to this one; the improvement is measured at this one. Leave blank to evaluate one level up.">
            <button id="mwi-csim-shrine-targets-toggle" title="Set a target level per shrine instead of one number for all of them" style="${CHIP_BUTTON_STYLE}">Targets</button>
            <label id="mwi-csim-shrine-cap-label" title="Only rank shrine levels your guild's shrine buildings can actually sell you: a shrine the guild has not built is left out entirely, and one built to Lv4 stops at Lv4. Uncheck to plan against shrines the guild would have to upgrade first — those rows say so." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-csim-shrine-cap-guild" checked style="margin:0; cursor:pointer;">
                Guild-allowed only
            </label>
        </span>`,
    community_buff: `
        <span id="mwi-csim-community-group" data-mode-options="community_buff" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label style="color:#888; font-size:12px;">Lv</label>
            <input id="mwi-csim-community-target-level" type="number" min="1" max="20" placeholder="+1" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Level to sim each community buff at, rather than one level up — Lv3 → Lv8 in one row. Capped at 20, which the game calls max. It changes nothing about the cost: a community buff's level is what the whole server's donated minutes add up to, so there is no per-level price either way. A buff already at 20 still measures what the whole buff is worth, by simulating it off.">
        </span>`,
};

/**
 * Candidate sets the Upgrade tab can include. Each is independent, so several can
 * run in one analysis and land in one ranked list.
 */
const UPGRADE_MODES = [
    {
        key: 'equipment',
        label: 'Equipment',
        defaultOn: true,
        title: 'Enhancement breakpoints and tier swaps for every combat slot',
    },
    {
        key: 'ability_level',
        label: 'Ability Lv',
        defaultOn: true,
        title: 'Leveling the abilities you already have equipped',
    },
    {
        key: 'ability_swap',
        label: 'Ability Swaps',
        defaultOn: false,
        title:
            'Replacing an equipped ability with a different one.\n\n' +
            'Offers come from the community build guide. Your weapon says which build you are playing — spear, ' +
            'sword, mace, wark, bow, crossbow, or fire/water/nature magic — and the swaps offered are that ' +
            "build's own ability set, both sides of every OR, minus what you already run. Abilities the guide " +
            'asks for are left where they are; the ones it does not are what the newcomers replace. A weapon ' +
            'the guide cannot place falls back to offering every style-compatible ability for every slot, which ' +
            'is far slower.\n\n' +
            'A swapped-in ability is simmed at the level of the ability it replaces with that ability book’s ' +
            'default triggers, so it gets none of the trigger tuning your equipped abilities have. Cost is ' +
            'counted from the book you actually own — from its current level for an ability in your book bag, ' +
            'from scratch only for one you have never read. Treat the ranking as a hint about which abilities ' +
            'are worth trying by hand, not a verdict.',
    },
    {
        key: 'combat_level',
        label: 'Combat Lv',
        defaultOn: false,
        title: 'Raising combat skill levels. Levels cost grind time rather than gold, so they get their own results box below the gold-cost list.',
    },
    { key: 'house', label: 'House', defaultOn: false, title: 'One level on each combat-relevant house room' },
    {
        key: 'guild_shrine',
        label: 'Guild Shrine',
        defaultOn: false,
        title:
            'One level on each combat guild shrine buff.\n\n' +
            'Cost is the gold value of the guild credits only — guild tokens are shown in the row detail and ' +
            'are not priced, because nothing converts into them. A level past what your guild has built is ' +
            'still listed, and says so.',
    },
    {
        key: 'drink',
        label: 'Drinks',
        defaultOn: false,
        title:
            'A tier up in each buff drink you already run, and the best drink of each family you have a free ' +
            'slot for.\n\n' +
            'Cost shows as free because a coffee is not bought once — its hourly spend is already subtracted ' +
            'from Profit/hr by the sim, so charging it again as an outlay would count it twice. Read these ' +
            'rows on their deltas rather than on a value ranking.',
    },
    {
        key: 'community_buff',
        label: 'Community',
        defaultOn: false,
        title:
            'One more level on the community EXP and combat-drop buffs — or, for a buff already at Lv20 ' +
            "(the game's max), what the whole buff is currently worth to you, measured by simulating it off.\n\n" +
            'Nobody buys these, so they carry no price and land in the "measured, but not priced" box — but ' +
            'the sim can still tell you exactly what a level is worth to you.',
    },
    {
        key: 'scroll',
        label: 'Scrolls',
        defaultOn: false,
        title:
            'What each Labyrinth combat scroll is worth in this fight: turning on one you are not carrying, ' +
            'or — for one already on — what you would lose by dropping it.\n\n' +
            'Damage, attack and cast speed, crit rate, combat drop, wisdom and rare find are all offered. The ' +
            'per-run seal cost is not priced, so these land in the "measured, but not priced" box next to ' +
            'Community — read them on their deltas.',
    },
    {
        key: 'food',
        label: 'Food',
        defaultOn: false,
        title: 'Search for the cheapest food that still avoids deaths and running out of mana',
    },
];

/**
 * Marker the Results tab reserves for its summary block.
 *
 * The summary reports totals the sections below it produce, so it is written
 * last and spliced in first. A comment node rather than a bare token so a
 * failure to substitute shows up as nothing rather than as literal text.
 */
const RESULTS_SUMMARY_SLOT = '<!--mwi-csim-summary-->';

/**
 * Format elapsed seconds as "Xs" or "Xm Ys".
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(0);
    return `${m}m ${s}s`;
}

class CombatSimUI {
    constructor() {
        this.panel = null;
        this._editor = null;
        this.isRunning = false;
        this._upgradeRunning = false;
        this._detachDrag = null;
        this.elapsedTimer = null;
        this._activePlayerTab = 'player1';
        this._playerInfo = [];
        this._lastSimResult = null;
        this._lastSimHours = null;
        this._lastGameData = null;
        this._lastPartyWarnings = [];
        // Session history for multi-scenario comparison
        this._simHistory = [];
        this._comparisonIndex = null;
        // Comparison table state
        this._comparisonBaseline = null; // index into _simHistory
        this._comparisonSlots = []; // array of _simHistory indices to compare
        this._activeDetailIndex = null; // which history entry's details are shown
        this._activeMainTab = 'configure';
        // All Zones state
        this._allZonesMode = null; // null = off, 'group' or 'solo'
        this._allZonesResults = null; // Array of {zone, simResult, revenue}
        this._allZonesSortCol = 'score'; // default the Results table to score, descending
        this._allZonesSortAsc = false;
        this._earlyExitEnabled = true; // default on
        this._maxTierFoodEnabled = false; // sim all zones on the best food of each kind you run
        this._includeDungeons = false; // whether an all-zones run also simulates every dungeon
        // Bestiary planner: a time budget by default, a points target on request
        this._bestiaryPlanMode = 'hours';
        this._bestiaryPlanHours = BESTIARY_PLAN_DEFAULT_HOURS;
        this._bestiaryPlanPoints = BESTIARY_PLAN_DEFAULT_POINTS;
        // What the displayed results were actually run on, so a re-sort keeps
        // saying so and a saved comparison can never be read as a real-loadout run
        this._allZonesMaxTierFood = false;
        this._allZonesFoodSwaps = []; // [{playerHrid, fromName, toName}] behind the note
        // Seek state
        this._seekItems = []; // [{itemHrid, name}] — droppable items across all combat zones
        this._seekSelectedItem = null;
        this._seekResults = null;
        this._seekSortCol = null;
        this._seekSortAsc = true;
    }

    /**
     * Build and append the floating panel to the document body.
     */
    buildPanel() {
        if (this.panel) return;

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        this.panel.style.cssText = `
            position: fixed;
            top: 60px;
            right: 60px;
            z-index: ${config.Z_FLOATING_PANEL};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid ${ACCENT_BORDER};
            border-radius: 10px;
            width: min(600px, 92vw);
            height: min(600px, 80vh);
            min-width: min(400px, 92vw);
            min-height: 300px;
            max-width: 92vw;
            max-height: 90vh;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            cursor: grab;
            background: ${ACCENT_BG};
            border-bottom: 1px solid ${ACCENT_BORDER};
            border-radius: 8px 8px 0 0;
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:${ACCENT}; flex:1;">Combat Simulator</span>
            <button id="mwi-csim-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">×</button>
        `;
        this._setupDrag(header);

        // Tab bar (Configure | Results)
        const tabBar = document.createElement('div');
        tabBar.id = 'mwi-csim-tabbar';
        tabBar.style.cssText = `
            display: flex;
            gap: 0;
            padding: 0;
            flex-shrink: 0;
            border-bottom: 1px solid #222;
        `;
        const tabStyle = (active) => `
            flex: 1;
            padding: 7px 0;
            text-align: center;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            border: none;
            font-family: inherit;
            transition: all 0.1s;
            background: ${active ? ACCENT_BG : 'transparent'};
            color: ${active ? ACCENT : '#888'};
            border-bottom: 2px solid ${active ? ACCENT : 'transparent'};
        `;
        tabBar.innerHTML = `
            <button id="mwi-csim-tab-configure" style="${tabStyle(true)}">Configure</button>
            <button id="mwi-csim-tab-results" style="${tabStyle(false)}">Results</button>
            <button id="mwi-csim-tab-seek" style="${tabStyle(false)}">Seek</button>
            <button id="mwi-csim-tab-upgrade" style="${tabStyle(false)}">Upgrade</button>
        `;

        // Configure tab content
        const configureContent = document.createElement('div');
        configureContent.id = 'mwi-csim-configure-content';
        configureContent.style.cssText = 'display:flex; flex-direction:column; flex:1; overflow:hidden;';

        // Controls (zone, tier, hours, simulate)
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            padding: 10px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; flex:1; min-width:0;';
        const inputStyle =
            'width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        controls.innerHTML = `
            <label style="color:#888; font-size:12px;">Zone</label>
            <select class="toolasha-select" id="mwi-csim-zone" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Tier</label>
            <select class="toolasha-select" id="mwi-csim-tier" style="${selectStyle} flex:0; width:64px; min-width:64px;">
            </select>
            <label style="color:#888; font-size:12px;">Hours</label>
            <input id="mwi-csim-hours" type="number" min="1" max="10000" value="${config.getSettingValue('combatSim_defaultHours', 100)}" style="${inputStyle}">
            <button id="mwi-csim-run" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Simulate</button>
        `;

        // All Zones controls row
        const allZonesRow = document.createElement('div');
        allZonesRow.id = 'mwi-csim-allzones-row';
        allZonesRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 6px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
            font-size: 12px;
        `;
        const checkboxStyle = 'margin:0; cursor:pointer;';
        const labelStyle = 'display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;';
        allZonesRow.innerHTML = `
            <label style="${labelStyle}">
                <input type="checkbox" id="mwi-csim-allzones-group" style="${checkboxStyle}">
                Sim All Zones
            </label>
            <label style="${labelStyle}">
                <input type="checkbox" id="mwi-csim-allzones-solo" style="${checkboxStyle}">
                Sim All Solo
            </label>
            <label id="mwi-csim-allzones-hours-label" style="color:#888; font-size:12px; display:none;">Hours</label>
            <input id="mwi-csim-allzones-hours" type="number" min="1" max="10000" value="${config.getSettingValue('combatSim_allZonesDefaultHours', 10)}" style="display:none; width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;">
            <label id="mwi-csim-earlyexit-label" style="${labelStyle} display:none;" title="Stop simming higher tiers for a zone if both XP/hr and profit/hr declined vs the previous tier">
                <input type="checkbox" id="mwi-csim-earlyexit" style="${checkboxStyle}" checked>
                Skip Worse Tiers
            </label>
            <label id="mwi-csim-maxfood-label" style="${labelStyle} opacity:0.45; cursor:not-allowed;" title="${MAX_FOOD_TOOLTIP}">
                <input type="checkbox" id="mwi-csim-maxfood" style="${checkboxStyle}" disabled>
                Max-tier Food
            </label>
            <label style="${labelStyle}" title="Treat every fight in this run as your combat task's monster, so taskDamage from trinkets and task badges applies. Off by default: a zone is a mix of monsters and only one of them is your task, so counting the bonus everywhere overstates the run.">
                <input type="checkbox" id="mwi-csim-taskfight" style="${checkboxStyle}">
                Task Fight
            </label>
        `;

        // Zone checklist (hidden by default)
        const zoneChecklist = document.createElement('div');
        zoneChecklist.id = 'mwi-csim-zone-checklist';
        zoneChecklist.style.cssText = `
            display: none;
            max-height: 150px;
            overflow-y: auto;
            padding: 6px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;

        // Loadout editor area (scrollable)
        const editorArea = document.createElement('div');
        editorArea.id = 'mwi-csim-editor';
        editorArea.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';
        editorArea.innerHTML = `<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>`;

        this._editor = new SimEditor({ editorEl: editorArea, labMode: false });

        configureContent.appendChild(controls);
        configureContent.appendChild(allZonesRow);
        configureContent.appendChild(zoneChecklist);
        configureContent.appendChild(editorArea);

        // Results tab content (hidden by default)
        const resultsContent = document.createElement('div');
        resultsContent.id = 'mwi-csim-results-content';
        resultsContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        // Progress bar container (hidden by default). It lives beside the status
        // line rather than inside the Results tab: Stop is the only way to end a
        // run, and a tab switch used to take it off screen while the Simulate
        // button stayed disabled — no way forward and no way back.
        const progressContainer = document.createElement('div');
        progressContainer.id = 'mwi-csim-progress-container';
        progressContainer.style.cssText =
            'display:none; padding:6px 14px; flex-shrink:0; border-top:1px solid #1a1a1a;';
        progressContainer.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="
                    flex:1;
                    background:#1a1a2e;
                    border-radius:4px;
                    height:18px;
                    overflow:hidden;
                    position:relative;
                    border:1px solid #333;">
                    <div id="mwi-csim-progress-fill" style="
                        height:100%;
                        width:0%;
                        background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT});
                        border-radius:3px;
                        transition:width 0.2s ease;"></div>
                    <span id="mwi-csim-progress-text" style="
                        position:absolute;
                        top:0; left:0; right:0;
                        text-align:center;
                        font-size:11px;
                        line-height:18px;
                        color:#e0e0e0;
                        font-weight:600;">0%</span>
                </div>
                <button id="mwi-csim-stop" style="
                    background:rgba(244, 67, 54, 0.2);
                    border:1px solid rgba(244, 67, 54, 0.4);
                    color:#f44336;
                    border-radius:4px;
                    padding:2px 10px;
                    font-size:11px;
                    font-weight:600;
                    cursor:pointer;
                    font-family:inherit;
                    flex-shrink:0;">Stop</button>
            </div>
        `;

        // Results container
        const resultsContainer = document.createElement('div');
        resultsContainer.id = 'mwi-csim-results';
        resultsContainer.style.cssText = 'display:none; overflow-y:auto; flex:1; padding:10px 14px;';

        resultsContent.appendChild(resultsContainer);

        // Seek tab content (hidden by default)
        const seekContent = document.createElement('div');
        seekContent.id = 'mwi-csim-seek-content';
        seekContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const seekControls = document.createElement('div');
        seekControls.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            padding: 10px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;
        seekControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Item</label>
            <input id="mwi-csim-seek-input" type="text" placeholder="Search item..." style="
                flex:1; min-width:0;
                background:#1a1a2e; color:#e0e0e0;
                border:1px solid #444; border-radius:4px;
                padding:3px 6px; font-size:12px; font-family:inherit;">
            <label style="color:#888; font-size:12px;">Hours</label>
            <input id="mwi-csim-seek-hours" type="number" min="1" max="10000" value="${config.getSettingValue('combatSim_seekDefaultHours', 10)}" style="
                width:60px; background:#1a1a2e; color:#e0e0e0;
                border:1px solid #444; border-radius:4px;
                padding:3px 6px; font-size:12px; text-align:center;">
            <button id="mwi-csim-seek-run" style="
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Seek</button>
            <button id="mwi-csim-seek-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        const seekSuggestions = document.createElement('div');
        seekSuggestions.id = 'mwi-csim-seek-suggestions';
        seekSuggestions.style.cssText = `
            display: none;
            max-height: 140px;
            overflow-y: auto;
            padding: 4px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;

        const seekProgress = document.createElement('div');
        seekProgress.id = 'mwi-csim-seek-progress';
        seekProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        seekProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-csim-seek-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-csim-seek-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0%</span>
                </div>
            </div>
        `;

        const seekResults = document.createElement('div');
        seekResults.id = 'mwi-csim-seek-results';
        seekResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        seekContent.appendChild(seekControls);
        seekContent.appendChild(seekSuggestions);
        seekContent.appendChild(seekProgress);
        seekContent.appendChild(seekResults);

        // Upgrade tab content (hidden by default)
        const upgradeContent = document.createElement('div');
        upgradeContent.id = 'mwi-csim-upgrade-content';
        upgradeContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const upgradeControls = document.createElement('div');
        upgradeControls.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            padding: 10px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;
        // Upgrade-row selects size to their content instead of inheriting the
        // Configure row's flex:1/min-width:0, which let them shrink to slivers
        const upgradeSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        upgradeControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Player</label>
            <select class="toolasha-select" id="mwi-csim-upgrade-player" style="${upgradeSelectStyle}"></select>
            <label style="color:#888; font-size:12px;">Include</label>
            ${UPGRADE_MODES.map(
                (mode) => `
            <span data-mode-chip="${mode.key}" style="display:inline-flex; align-items:center; gap:6px;
                padding:3px 8px; border:1px solid #2a2a4a; border-radius:6px;">
                <label title="${mode.title}" style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                    <input type="checkbox" data-upgrade-mode="${mode.key}" style="margin:0; cursor:pointer;"${
                        mode.defaultOn ? ' checked' : ''
                    }>
                    ${mode.label}
                </label>
                ${MODE_OPTIONS[mode.key] || ''}
            </span>`
            ).join('')}
            <button id="mwi-csim-upgrade-run" style="
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Analyze</button>
            <button id="mwi-csim-upgrade-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        // Per-skill target levels for Combat Levels mode (hidden until toggled)
        const combatTargets = document.createElement('div');
        combatTargets.id = 'mwi-csim-combat-targets';
        combatTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';
        combatTargets.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>Combat Lv</b> target levels (blank or ≤ current level skips the skill; used instead of the +Levels boost while open):</span>' +
            [
                ['staminaLevel', 'Stamina'],
                ['intelligenceLevel', 'Int'],
                ['attackLevel', 'Attack'],
                ['meleeLevel', 'Melee'],
                ['defenseLevel', 'Defense'],
                ['rangedLevel', 'Ranged'],
                ['magicLevel', 'Magic'],
            ]
                .map(
                    ([key, label]) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${label}</label>
                    <input type="number" min="1" max="200" data-combat-target="${key}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');

        // Per-ability target levels for Ability Levels / combined modes
        // (hidden until toggled; inputs built from the player's equipped
        // abilities when opened)
        const abilityTargetsGrid = document.createElement('div');
        abilityTargetsGrid.id = 'mwi-csim-ability-targets';
        abilityTargetsGrid.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';

        const upgradeProgress = document.createElement('div');
        upgradeProgress.id = 'mwi-csim-upgrade-progress';
        upgradeProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        upgradeProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-csim-upgrade-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-csim-upgrade-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const upgradeResults = document.createElement('div');
        upgradeResults.id = 'mwi-csim-upgrade-results';
        upgradeResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        // Per-room target levels for House mode (hidden until toggled; inputs
        // built from the combat-relevant rooms in game data when opened)
        const houseTargetsGrid = document.createElement('div');
        houseTargetsGrid.id = 'mwi-csim-house-targets';
        houseTargetsGrid.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';

        // Per-shrine target levels for guild_shrine mode (hidden until toggled;
        // inputs built from the combat shrines in game data when opened), on the
        // same terms as the House grid: one Lv box asks five shrines sitting at
        // five different levels for the same absolute level, which was a no-op
        // for anything already past it and a several-level purchase for the rest
        const shrineTargetsGrid = document.createElement('div');
        shrineTargetsGrid.id = 'mwi-csim-shrine-targets';
        shrineTargetsGrid.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';

        upgradeContent.appendChild(upgradeControls);
        upgradeContent.appendChild(combatTargets);
        upgradeContent.appendChild(abilityTargetsGrid);
        upgradeContent.appendChild(houseTargetsGrid);
        upgradeContent.appendChild(shrineTargetsGrid);
        upgradeContent.appendChild(upgradeProgress);
        upgradeContent.appendChild(upgradeResults);

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-csim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a zone and click Simulate.';

        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(configureContent);
        this.panel.appendChild(resultsContent);
        this.panel.appendChild(seekContent);
        this.panel.appendChild(upgradeContent);
        this.panel.appendChild(progressContainer);
        this.panel.appendChild(status);

        // Three grips, not one. The corner alone meant aiming at 16 square pixels
        // to make the panel wider; the edges give the whole side as a target.
        const addGrip = (css, axis) => {
            const grip = document.createElement('div');
            grip.className = 'toolasha-resize-grip';
            grip.style.cssText = `position:absolute; z-index:1; ${css}`;
            this.panel.appendChild(grip);
            this._setupResize(grip, axis);
        };

        addGrip('top:44px; bottom:18px; right:0; width:8px; cursor:ew-resize;', 'e');
        addGrip('top:44px; bottom:18px; left:0; width:8px; cursor:ew-resize;', 'w');
        addGrip('left:18px; right:18px; bottom:0; height:8px; cursor:ns-resize;', 's');
        addGrip(
            `bottom:0; right:0; width:18px; height:18px; cursor:nwse-resize; z-index:2;
             background:linear-gradient(135deg, transparent 50%, rgba(74, 158, 255, 0.4) 50%);
             border-radius:0 0 8px 0;`,
            'se'
        );
        addGrip(
            `bottom:0; left:0; width:18px; height:18px; cursor:nesw-resize; z-index:2;
             background:linear-gradient(225deg, transparent 50%, rgba(74, 158, 255, 0.4) 50%);
             border-radius:0 0 0 8px;`,
            'sw'
        );

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        // Minimize: fold the whole panel to its header, remembering the state.
        // Every non-header child is a content sibling to hide.
        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: [tabBar, configureContent, resultsContent, seekContent, upgradeContent, progressContainer, status],
            panelKey: GEOMETRY_KEY,
            beforeEl: header.querySelector('#mwi-csim-close'),
            accent: '#aaa',
        });

        // Event listeners
        this.panel.querySelector('#mwi-csim-close').addEventListener('click', () => this.hide());
        this.panel.querySelector('#mwi-csim-run').addEventListener('click', () => this._onSimulate());
        this.panel.querySelector('#mwi-csim-stop').addEventListener('click', () => this._onSimulate());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Tab switching
        this.panel
            .querySelector('#mwi-csim-tab-configure')
            .addEventListener('click', () => this._switchTab('configure'));
        this.panel.querySelector('#mwi-csim-tab-results').addEventListener('click', () => this._switchTab('results'));
        this.panel.querySelector('#mwi-csim-tab-seek').addEventListener('click', () => this._switchTab('seek'));
        this.panel.querySelector('#mwi-csim-tab-upgrade').addEventListener('click', () => this._switchTab('upgrade'));
        this.panel.querySelector('#mwi-csim-upgrade-run').addEventListener('click', () => this._onUpgradeAnalyze());
        this.panel.querySelector('#mwi-csim-upgrade-stop').addEventListener('click', () => {
            this._upgradeAborted = true;
        });
        this.panel.querySelectorAll('[data-upgrade-mode]').forEach((box) => {
            box.addEventListener('change', () => {
                this._onUpgradeModesChanged();
                this._saveUpgradeModes();
            });
        });
        this.panel.querySelector('#mwi-csim-swap-aura-only')?.addEventListener('change', () => {
            this._saveSwapAuraOnly();
        });
        this._restoreUpgradeModes();
        this._restoreSwapAuraOnly();
        this._restoreShrineCapToGuild();
        this._loadUpgradeColumnPrefs();
        this._loadMaxTierFoodPref();
        this._loadBestiaryPlanPrefs();
        this._restoreUpgradeResults();
        this._restorePanelGeometry();
        this.panel.querySelector('#mwi-csim-ability-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-csim-ability-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillAbilityTargets(grid, '#mwi-csim-upgrade-player', '#mwi-csim-upgrade-target-level');
            }
        });
        this.panel.querySelector('#mwi-csim-combat-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-csim-combat-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillCombatTargets();
            }
        });
        this.panel.querySelector('#mwi-csim-house-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-csim-house-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._buildHouseTargets();
            }
        });
        this.panel.querySelector('#mwi-csim-shrine-cap-guild')?.addEventListener('change', () => {
            this._saveShrineCapToGuild();
        });
        this.panel.querySelector('#mwi-csim-shrine-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-csim-shrine-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._buildShrineTargets();
            }
        });
        this.panel.querySelector('#mwi-csim-upgrade-level-type').addEventListener('change', (e) => {
            const input = this.panel.querySelector('#mwi-csim-upgrade-target-level');
            if (e.target.value === 'increment') {
                input.value = '5';
                input.placeholder = '+5';
                input.title = 'Number of levels to add to each ability';
            } else {
                input.value = '';
                input.placeholder = 'e.g. 80';
                input.title = 'Absolute target level for all abilities';
            }
        });
        this.panel.querySelector('#mwi-csim-upgrade-target-level').addEventListener('change', (e) => {
            const val = parseInt(e.target.value);
            if (val > 200) e.target.value = 200;
            if (val < 1 && e.target.value !== '') e.target.value = 1;
        });

        // Zone change → update tier dropdown
        this.panel.querySelector('#mwi-csim-zone').addEventListener('change', () => this._updateTierDropdown());

        // All Zones toggles
        this.panel.querySelector('#mwi-csim-allzones-group').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.panel.querySelector('#mwi-csim-allzones-solo').checked = false;
                this._allZonesMode = 'group';
            } else {
                this._allZonesMode = null;
            }
            this._updateAllZonesUI();
        });
        this.panel.querySelector('#mwi-csim-allzones-solo').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.panel.querySelector('#mwi-csim-allzones-group').checked = false;
                this._allZonesMode = 'solo';
            } else {
                this._allZonesMode = null;
            }
            this._updateAllZonesUI();
        });

        // Early exit toggle
        this.panel.querySelector('#mwi-csim-earlyexit').addEventListener('change', (e) => {
            this._earlyExitEnabled = e.target.checked;
        });

        // Max-tier food toggle
        this.panel.querySelector('#mwi-csim-maxfood').addEventListener('change', (e) => {
            this._maxTierFoodEnabled = e.target.checked;
            this._persistMaxTierFoodPref();
        });

        // Seek: item search input
        this.panel.querySelector('#mwi-csim-seek-input').addEventListener('input', (e) => {
            this._updateSeekSuggestions(e.target.value);
        });
        this.panel.querySelector('#mwi-csim-seek-input').addEventListener('focus', (e) => {
            this._updateSeekSuggestions(e.target.value);
        });
        this.panel.querySelector('#mwi-csim-seek-input').addEventListener('blur', () => {
            // Delay hide to allow click on suggestion
            setTimeout(() => {
                const sug = this.panel.querySelector('#mwi-csim-seek-suggestions');
                if (sug) sug.style.display = 'none';
            }, 150);
        });
        this.panel.querySelector('#mwi-csim-seek-run').addEventListener('click', () => this._onSeek());
        this.panel.querySelector('#mwi-csim-seek-stop').addEventListener('click', () => {
            cancelAllZonesSimulation();
        });

        this.populateZones();
        // Here rather than at module scope, where the other panels ask: this one
        // is built by its feature module and only if the setting is on, so
        // asking any earlier would be asking about a panel that does not exist
        this.restore();
    }

    /**
     * Fill the zone dropdown from getCombatZones() and select the current zone.
     */
    populateZones() {
        const zoneSelect = this.panel?.querySelector('#mwi-csim-zone');
        if (!zoneSelect) return;

        const zones = getCombatZones();
        zoneSelect.innerHTML = '';

        for (const zone of zones) {
            const option = document.createElement('option');
            option.value = zone.hrid;
            option.textContent = zone.isDungeon ? `[D] ${zone.name}` : zone.name;
            zoneSelect.appendChild(option);
        }

        // Select current zone and tier if available
        const current = getCurrentCombatZone();
        if (current) {
            zoneSelect.value = current.zoneHrid;
        }

        this._updateTierDropdown();

        // Restore current tier after dropdown is rebuilt
        if (current) {
            const tierSelect = this.panel.querySelector('#mwi-csim-tier');
            if (tierSelect) {
                tierSelect.value = String(current.difficultyTier);
            }
        }
    }

    /**
     * Update the tier dropdown based on the currently selected zone.
     * Regular zones: T0-T5, Dungeons: T0-T2.
     * @private
     */
    _updateTierDropdown() {
        const zoneSelect = this.panel?.querySelector('#mwi-csim-zone');
        const tierSelect = this.panel?.querySelector('#mwi-csim-tier');
        if (!zoneSelect || !tierSelect) return;

        const selectedHrid = zoneSelect.value;
        const zones = getCombatZones();
        const zone = zones.find((z) => z.hrid === selectedHrid);
        const maxTier = zone?.isDungeon ? DUNGEON_MAX_TIER : 5;

        const currentTier = parseInt(tierSelect.value) || 0;
        tierSelect.innerHTML = Array.from({ length: maxTier + 1 }, (_, i) => `<option value="${i}">${i}</option>`).join(
            ''
        );
        tierSelect.value = String(Math.min(currentTier, maxTier));
    }

    /**
     * Update UI visibility when All Zones mode changes.
     * Shows/hides zone checklist, hides single-zone controls.
     * @private
     */
    _updateAllZonesUI() {
        const checklist = this.panel?.querySelector('#mwi-csim-zone-checklist');
        const zoneSelect = this.panel?.querySelector('#mwi-csim-zone');
        const tierSelect = this.panel?.querySelector('#mwi-csim-tier');
        const zoneLabel = zoneSelect?.previousElementSibling;
        const tierLabel = tierSelect?.previousElementSibling;
        const earlyExitLabel = this.panel?.querySelector('#mwi-csim-earlyexit-label');
        const allZonesHoursInput = this.panel?.querySelector('#mwi-csim-allzones-hours');
        const allZonesHoursLabel = this.panel?.querySelector('#mwi-csim-allzones-hours-label');
        const mainHoursInput = this.panel?.querySelector('#mwi-csim-hours');
        const mainHoursLabel = mainHoursInput?.previousElementSibling;

        if (!checklist) return;

        // Greyed rather than hidden when all-zones is off: it is the one option
        // here that answers a question people do not know they can ask, and a
        // control that vanishes cannot advertise itself. It stays checkable only
        // where it means something, since it changes nothing in a single-zone run.
        this._setMaxTierFoodEnabled(Boolean(this._allZonesMode));

        if (this._allZonesMode) {
            // Hide single-zone controls
            if (zoneSelect) zoneSelect.style.display = 'none';
            if (tierSelect) tierSelect.style.display = 'none';
            if (zoneLabel) zoneLabel.style.display = 'none';
            if (tierLabel) tierLabel.style.display = 'none';
            if (mainHoursInput) mainHoursInput.style.display = 'none';
            if (mainHoursLabel) mainHoursLabel.style.display = 'none';
            if (earlyExitLabel) earlyExitLabel.style.display = 'flex';
            if (allZonesHoursInput) allZonesHoursInput.style.display = '';
            if (allZonesHoursLabel) allZonesHoursLabel.style.display = '';

            // Show checklist with zones
            checklist.style.display = 'block';
            this._populateZoneChecklist();
        } else {
            // Show single-zone controls
            if (zoneSelect) zoneSelect.style.display = '';
            if (tierSelect) tierSelect.style.display = '';
            if (zoneLabel) zoneLabel.style.display = '';
            if (tierLabel) tierLabel.style.display = '';
            if (mainHoursInput) mainHoursInput.style.display = '';
            if (mainHoursLabel) mainHoursLabel.style.display = '';
            if (earlyExitLabel) earlyExitLabel.style.display = 'none';
            if (allZonesHoursInput) allZonesHoursInput.style.display = 'none';
            if (allZonesHoursLabel) allZonesHoursLabel.style.display = 'none';

            // Hide checklist
            checklist.style.display = 'none';
        }
    }

    /**
     * Grey the Max-tier Food checkbox out, or bring it back.
     * @param {boolean} enabled - Whether an all-zones mode is selected
     * @private
     */
    _setMaxTierFoodEnabled(enabled) {
        const label = this.panel?.querySelector('#mwi-csim-maxfood-label');
        const input = this.panel?.querySelector('#mwi-csim-maxfood');
        if (input) input.disabled = !enabled;
        if (label) {
            label.style.opacity = enabled ? '' : '0.45';
            label.style.cursor = enabled ? 'pointer' : 'not-allowed';
        }
    }

    /** @private */
    async _persistMaxTierFoodPref() {
        try {
            await storage.set(ALL_ZONES_MAX_FOOD_KEY, this._maxTierFoodEnabled, 'settings');
        } catch (error) {
            console.error('[CombatSimUI] Failed to save the max-tier food preference:', error);
        }
    }

    /** @private */
    async _loadMaxTierFoodPref() {
        try {
            const saved = await storage.get(ALL_ZONES_MAX_FOOD_KEY, 'settings', false);
            this._maxTierFoodEnabled = Boolean(saved);
            const input = this.panel?.querySelector('#mwi-csim-maxfood');
            if (input) input.checked = this._maxTierFoodEnabled;
        } catch (error) {
            console.error('[CombatSimUI] Failed to read the max-tier food preference:', error);
        }
    }

    /**
     * Populate the zone checklist based on current all-zones mode.
     * @private
     */
    _populateZoneChecklist() {
        const checklist = this.panel?.querySelector('#mwi-csim-zone-checklist');
        if (!checklist) return;

        const zones = getCombatZones().filter((z) => {
            if (z.isDungeon) return false;
            if (this._allZonesMode === 'group') return z.maxSpawnCount > 1;
            if (this._allZonesMode === 'solo') return z.maxSpawnCount === 1;
            return false;
        });

        const checkAllId = 'mwi-csim-checkall';
        checklist.innerHTML = `
            <label style="display:flex; align-items:center; gap:4px; color:${ACCENT}; font-size:11px; font-weight:600; margin-bottom:4px; cursor:pointer;">
                <input type="checkbox" id="${checkAllId}" checked style="margin:0; cursor:pointer;">
                Check All
            </label>
        `;

        for (const zone of zones) {
            const label = document.createElement('label');
            label.style.cssText =
                'display:flex; align-items:center; gap:4px; color:#ccc; font-size:11px; padding:1px 0; cursor:pointer;';
            label.innerHTML = `<input type="checkbox" class="mwi-csim-zone-cb" data-hrid="${zone.hrid}" checked style="margin:0; cursor:pointer;"> ${zone.name}`;
            checklist.appendChild(label);
        }

        // Check All toggle
        checklist.querySelector(`#${checkAllId}`).addEventListener('change', (e) => {
            checklist.querySelectorAll('.mwi-csim-zone-cb').forEach((cb) => {
                cb.checked = e.target.checked;
            });
        });
    }

    /**
     * Get selected zones expanded into all difficulty tiers.
     * @returns {Array<{zoneHrid: string, difficultyTier: number, name: string}>}
     * @private
     */
    _getSelectedAllZones() {
        const checklist = this.panel?.querySelector('#mwi-csim-zone-checklist');
        if (!checklist) return [];

        const allZones = getCombatZones();
        const selected = [];

        checklist.querySelectorAll('.mwi-csim-zone-cb:checked').forEach((cb) => {
            const hrid = cb.dataset.hrid;
            const zone = allZones.find((z) => z.hrid === hrid);
            if (!zone) return;

            for (let t = 0; t <= zone.maxDifficulty; t++) {
                selected.push({ zoneHrid: zone.hrid, difficultyTier: t, name: zone.name });
            }
        });

        // Dungeons are not in the checklist — there are only a handful of them
        // and they are all-or-nothing, so one preference decides it. Appended
        // last so an ordinary run's rows keep the order they always had.
        if (this._includeDungeons) {
            for (const zone of allZones.filter((z) => z.isDungeon)) {
                // T0-T2, the same range the Configure tier dropdown offers
                for (let t = 0; t <= DUNGEON_MAX_TIER; t++) {
                    selected.push({ zoneHrid: zone.hrid, difficultyTier: t, name: zone.name });
                }
            }
        }

        return selected;
    }

    /**
     * Turn a button into a CSV export, with its own "Saved ✓" feedback.
     *
     * The rows are built at click time rather than at render time, so a table
     * that has since been re-sorted exports in the order on screen — and a
     * button wired once against a stale array cannot quietly export last run.
     *
     * @param {HTMLElement} button - The button to wire
     * @param {string} stem - Filename stem, e.g. `combatsim-upgrades`
     * @param {Function} build - Returns `{ rows, columns }`
     * @private
     */
    _wireCsvButton(button, stem, build) {
        if (!button) return;

        const flash = (text) => {
            button.textContent = text;
            clearTimeout(this._csvFlash);
            this._csvFlash = setTimeout(() => {
                button.textContent = 'Export CSV';
            }, 1600);
        };

        button.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                const { rows, columns } = build();
                if (!rows?.length) {
                    flash('Nothing to export');
                    return;
                }
                flash(downloadCsv(csvFilename(stem), toCsv(rows, columns)) ? 'Saved ✓' : 'Failed');
            } catch (error) {
                console.error('[CombatSimUI] CSV export failed:', error);
                flash('Failed');
            }
        });
    }

    /**
     * An Export CSV bar at the top of a results container.
     *
     * Inside the container rather than beside it: every caller rebuilds the
     * container's innerHTML, so a bar placed within it is replaced along with
     * the table it belongs to instead of outliving it on a different view.
     *
     * @param {HTMLElement} container - The results container, already rendered
     * @param {string} stem - Filename stem
     * @param {Function} build - Returns `{ rows, columns }` at click time
     * @private
     */
    _addCsvExport(container, stem, build) {
        if (!container) return;
        container.querySelector('[data-csv-export]')?.remove();

        const bar = document.createElement('div');
        bar.dataset.csvExport = stem;
        bar.style.cssText = 'display:flex; justify-content:flex-end; margin:0 0 6px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.style.cssText =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit;';
        this._wireCsvButton(button, stem, build);

        bar.appendChild(button);
        container.insertBefore(bar, container.firstChild);
    }

    /**
     * The one line above the all-zones table naming its two winners.
     *
     * The table can be sorted to answer either question, but only one at a time,
     * and the reader who wants both ends up sorting twice and remembering the
     * first answer. Saying both up front costs a line.
     *
     * @param {{xp: Object|null, profit: Object|null}} best - From `bestAllZoneRows`
     * @returns {string} HTML, empty when there is no winner to name
     * @private
     */
    _allZonesHeadline(best) {
        const parts = [];
        const foodNote = this._allZonesFoodNoteHtml();
        if (foodNote) parts.push(foodNote);
        const name = (row) => `${row.zone} T${row.tier}`;
        if (best.xp) {
            parts.push(
                `<span style="color:#8ab4f8;">Best XP</span> <span style="color:#e0e0e0;">${name(best.xp)}</span>` +
                    ` <span style="color:#888;">${formatKMB(Math.round(best.xp.totalXP))}/hr</span>`
            );
        }
        if (best.profit) {
            parts.push(
                `<span style="color:#4caf50;">Best profit</span> <span style="color:#e0e0e0;">${name(best.profit)}</span>` +
                    ` <span style="color:#888;">${formatKMB(Math.round(best.profit.profitDay))}/day</span>`
            );
        }
        if (!parts.length) return '';

        return `<div style="display:flex; flex-wrap:wrap; gap:6px 18px; font-size:11px; padding:0 0 6px 2px;">
            ${parts.join('')}
        </div>`;
    }

    /**
     * The line that says this table is not about the food you carry.
     *
     * Above the table rather than in a column, and repeated in the status line
     * and the exported filename: a max-food ranking mistaken for a real-loadout
     * one is worse than no ranking, because it reads as a promise about zones
     * you would in fact die in. The hover names the actual substitutions, so
     * "max-tier food" is checkable rather than something to take on trust.
     *
     * @returns {string} HTML, empty when the run used the loadout as configured
     * @private
     */
    _allZonesFoodNoteHtml() {
        if (!this._allZonesMaxTierFood) return '';

        const swaps = this._allZonesFoodSwaps || [];
        const detail = swaps.length
            ? swaps.map((swap) => `${swap.fromName} → ${swap.toName}`).join(', ')
            : 'nothing to substitute — every food slot was already at the top of its kind';
        const title = `${MAX_FOOD_TOOLTIP} This run: ${detail}.`;

        return (
            `<span title="${title}" style="${ROW_NOTE_STYLE} background:rgba(255,183,77,0.14); color:#ffb74d;">` +
            `max-tier food</span>`
        );
    }

    /**
     * Display all-zones comparison results in a sortable table.
     *
     * The Profit columns and the Score built on them are bounded by market
     * volume before anything is ranked: a zone whose loot the market cannot
     * absorb is quoted at the pace it can actually be sold, with a marker
     * saying so. The sim results themselves — and the snapshot they are saved
     * to — keep the raw claim.
     *
     * @param {Array<Object>} zoneResults - Array of {zone, simResult, revenue}
     * @param {number} hours - Simulation hours
     * @param {Object} gameData - Game data maps
     * @private
     */
    /**
     * Ask the game for the Bestiary (`get_monsters`), as its own tab does on
     * open, at most once a minute; the data manager keeps the answer and the
     * All Zones table redraws on it. A data fetch, not a game action.
     */
    _requestBestiary() {
        const now = Date.now();
        if (this._bestiaryRequestedAt && now - this._bestiaryRequestedAt < 60_000) return;
        this._bestiaryRequestedAt = now;
        if (!this._bestiaryListener) {
            this._bestiaryListener = () => {
                try {
                    const args = this._allZonesRedrawArgs;
                    if (this._allZonesResults && args) {
                        this._displayAllZonesResults(this._allZonesResults, args.hours, args.gameData);
                    }
                } catch (error) {
                    console.error('[CombatSimUI] Redrawing All Zones on the Bestiary failed:', error);
                }
            };
            dataManager.on?.('monsters_updated', this._bestiaryListener);
        }
        try {
            const rootEl = document.getElementById('root');
            const rootFiber =
                rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
            const find = (fiber, depth = 0) => {
                if (!fiber || depth > 4000) return null;
                if (typeof fiber.stateNode?.handleGetMonsters === 'function') return fiber.stateNode;
                return find(fiber.child, depth + 1) || find(fiber.sibling, depth + 1);
            };
            const game = find(rootFiber);
            game?.handleGetMonsters?.();
        } catch (error) {
            console.error('[CombatSimUI] Requesting the Bestiary failed:', error);
        }
    }

    async _displayAllZonesResults(zoneResults, hours, gameData) {
        const container = this.panel?.querySelector('#mwi-csim-results');
        if (!container) return;

        this._allZonesResults = zoneResults;
        container.style.display = 'block';

        // Build row data
        const playerHrid = this._activePlayerTab || 'player1';
        // The Bestiary, when the Achievements tab has loaded it: what each zone's
        // kill rates are worth in points over the next day, from the counts held
        // Off by the setting: no column, no planner, and the Bestiary is not
        // asked for either
        const bestiaryOn = config.getSettingValue('combatSim_bestiary', true) !== false;
        const bestiaryRows = bestiaryOn ? dataManager.getCharacterMonsters?.() || null : null;
        const bestiaryCounts = bestiaryRows ? countsByMonster(bestiaryRows) : null;
        // Not loaded yet: ask the game for it the way the Bestiary tab does,
        // and redraw when it lands so the column fills in by itself
        this._allZonesRedrawArgs = { hours, gameData };
        if (bestiaryOn && !bestiaryRows) this._requestBestiary();
        const rows = zoneResults
            .filter((r) => r && r.simResult)
            .map((r) => {
                const sim = r.simResult;
                const simHours = (sim.simulatedTime || 0) / (3600 * 1e9) || hours;
                const xp = sim.experienceGained?.[playerHrid] || {};

                const totalXP = Object.values(xp).reduce((s, v) => s + v, 0) / simHours;
                const playerDeaths = (sim.deaths?.[playerHrid] || 0) / simHours;
                const encounters = (sim.encounters || 0) / simHours;
                const killsPerHour = monsterKillsPerHour(sim, simHours);
                const bestiary = bestiaryCounts
                    ? zoneBestiaryOutlook({
                          killsPerHour,
                          counts: bestiaryCounts,
                          hours: 24,
                      })
                    : null;

                // A dungeon row is marked the way the Configure select marks
                // one, and carries what the planner needs to restate its kill
                // rates at a real clear time
                const dungeon = sim.isDungeon
                    ? { completions: sim.dungeonsCompleted || 0, simHours, name: r.zone.name }
                    : null;

                return {
                    zone: dungeon ? `[D] ${r.zone.name}` : r.zone.name,
                    zoneHrid: r.zone.zoneHrid || r.zone.hrid,
                    tier: r.zone.difficultyTier,
                    _dungeon: dungeon,
                    encounters,
                    deaths: playerDeaths,
                    totalXP,
                    bestiary: bestiary ? bestiary.pointsPerDay : null,
                    _bestiary: bestiary,
                    _killsPerHour: killsPerHour,
                    stamina: (xp.stamina || 0) / simHours,
                    intelligence: (xp.intelligence || 0) / simHours,
                    attack: (xp.attack || 0) / simHours,
                    melee: (xp.melee || 0) / simHours,
                    defense: (xp.defense || 0) / simHours,
                    ranged: (xp.ranged || 0) / simHours,
                    magic: (xp.magic || 0) / simHours,
                    revenue: r.revenue?.revenuePerHour || 0,
                    expenses: r.revenue?.costPerHour || 0,
                    profit: r.revenue?.netPerHour || 0,
                    profitDay: (r.revenue?.netPerHour || 0) * 24,
                    _sells: (r.revenue?.dropEntries || [])
                        .filter((entry) => entry?.itemHrid && Number(entry.countPerHour) > 0)
                        .map((entry) => ({
                            itemHrid: entry.itemHrid,
                            name: entry.name || null,
                            unitsPerHour: entry.countPerHour,
                        })),
                };
            });

        // Bound the profit pace before scoring or ranking anything — a Score
        // blended from an unsellable rate would smuggle the fiction back in.
        // The cap is display-only: `zoneResults` and the snapshot keep the raw
        // figures, and a capped row always carries its marker.
        for (const row of rows) {
            try {
                const capped = await capProfitRate({ goldPerHour: row.profit, sells: row._sells });
                if (capped.capped) {
                    row.uncappedProfit = row.profit;
                    row.profit = capped.goldPerHour;
                    row.profitDay = capped.goldPerHour * 24;
                    row.liquidityLimit = capped.limit;
                }
            } catch (error) {
                console.error('[CombatSimUI] Bounding a zone row by market volume failed:', error);
            }
        }

        // The Score and the two winners are decided over the whole run, before
        // any sort or column hiding — neither is a property of the current view
        scoreAllZoneRows(rows);
        const best = bestAllZoneRows(rows);
        // The Bestiary's own winner: most points in a day, ties to the earlier first point
        const bestBestiary = bestiaryCounts
            ? rows.reduce((top, row) => {
                  if (!row._bestiary || !(row.bestiary > 0)) return top;
                  if (!top) return row;
                  if (row.bestiary !== top.bestiary) return row.bestiary > top.bestiary ? row : top;
                  return (row._bestiary.firstPointHours ?? Infinity) < (top._bestiary.firstPointHours ?? Infinity)
                      ? row
                      : top;
              }, null)
            : null;

        // What the route planner works from: the zones (in run order — ties in
        // the plan go to the earlier one), the counts, and how many zones had
        // no result to plan with
        this._bestiaryPlanZones = await this._buildBestiaryPlanZones(rows);
        this._bestiaryPlanCounts = bestiaryCounts;
        this._bestiaryPlanSkipped = zoneResults.filter((r) => !r || !r.simResult).length;
        this._bestiaryPlanGameData = gameData;

        // Six columns of zeros is what a single-style build normally produces,
        // and it is why the table needed a horizontal scrollbar
        const cols = [
            { key: 'zone', label: 'Zone' },
            { key: 'tier', label: 'T' },
            { key: 'encounters', label: 'Enc/hr' },
            { key: 'deaths', label: 'Deaths/hr' },
            { key: 'totalXP', label: 'Total XP/hr' },
            { key: 'profitDay', label: 'Profit/day' },
            {
                key: 'score',
                label: 'Score',
                title:
                    'How well the zone places on XP/hr and Profit/day at once, out of 100 — the same rank-blend ' +
                    'the Upgrade tab scores with. Deaths are not scored: they are a constraint, not something to ' +
                    'trade against gold, so read the red Deaths/hr column alongside this.',
            },
            ...visibleAllZonesSkillColumns(rows),
            { key: 'revenue', label: 'Rev/hr' },
            { key: 'expenses', label: 'Cost/hr' },
            {
                key: 'profit',
                // The sim's track record against archived sessions rides on
                // the header; a zone with enough sessions of its own gets its
                // own mark on the cell
                label: `Profit/hr${badgeHtml(calibrationBadgeFor('combat', { label: 'all-zones sim profit' }))}`,
            },
            ...(bestiaryOn
                ? [
                      {
                          key: 'bestiary',
                          label: 'Bestiary pts/day',
                          title: bestiaryCounts
                              ? 'Bestiary points a day of fighting here would earn — the simulated kills per monster against ' +
                                'your defeated counts, points landing on each power of ten (1 at the first kill, +2 at 10, +3 ' +
                                'at 100 …). Hover a cell for the monsters and when the first point lands.'
                              : 'Open Achievements → Bestiary once (or press Refresh there) so the defeated counts are known; ' +
                                'the column fills in on the next render.',
                      },
                  ]
                : []),
        ];

        // Sort
        if (this._allZonesSortCol) {
            const col = this._allZonesSortCol;
            const asc = this._allZonesSortAsc;
            rows.sort((a, b) => {
                const va = a[col] ?? 0;
                const vb = b[col] ?? 0;
                if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
                if (va !== vb) return asc ? va - vb : vb - va;
                // Equal Bestiary points — most rows at 0.0 — order by how soon
                // the first point lands, soonest first whichever way the
                // column sorts; a zone with no first point at all goes last
                if (col === 'bestiary') {
                    const fa = a._bestiary?.firstPointHours ?? Infinity;
                    const fb = b._bestiary?.firstPointHours ?? Infinity;
                    return fa - fb;
                }
                return 0;
            });
        }

        // Find max values per numeric column for highlighting
        const maxVals = {};
        const minVals = {};
        for (const col of cols) {
            if (col.key === 'zone' || col.key === 'tier') continue;
            const values = rows.map((r) => r[col.key] || 0);
            maxVals[col.key] = Math.max(...values);
            minVals[col.key] = Math.min(...values);
        }

        // Render table
        const headerCells = cols
            .map((col) => {
                const arrow = this._allZonesSortCol === col.key ? (this._allZonesSortAsc ? ' ▲' : ' ▼') : '';
                const align = col.key === 'zone' ? 'left' : col.key === 'tier' ? 'center' : 'right';
                const title = col.title ? ` title="${col.title}"` : '';
                return (
                    `<th data-col="${col.key}"${title} style="padding:3px 4px; cursor:pointer; white-space:nowrap; ` +
                    `font-size:10px; font-weight:600; color:#888; border-bottom:1px solid #333; user-select:none; ` +
                    `text-align:${align};">${col.label}${arrow}</th>`
                );
            })
            .join('');

        // Small labels on the two rows worth finding without reading the table
        const badge = (text, color) =>
            `<span style="${ROW_NOTE_STYLE} background:rgba(74,158,255,0.12); color:${color};">${text}</span>`;

        const bodyRows = rows
            .map((row, rowIndex) => {
                const cells = cols
                    .map((col) => {
                        const val = row[col.key];
                        let display;
                        let style = 'padding:2px 4px; font-size:10px; white-space:nowrap;';

                        if (col.key === 'zone') {
                            const marks =
                                (row === best.xp ? badge('best XP', '#8ab4f8') : '') +
                                (row === best.profit ? badge('best profit', '#4caf50') : '') +
                                (bestBestiary && row === bestBestiary ? badge('best bestiary', '#ffb74d') : '');
                            // Set this zone + tier as the Configure target
                            const targetBtn = row.zoneHrid
                                ? `<button class="mwi-csim-target-btn" data-hrid="${row.zoneHrid}" data-tier="${row.tier}" title="Set as Configure target" style="margin-left:6px; background:rgba(74,158,255,0.15); border:1px solid rgba(74,158,255,0.4); color:#8ab4f8; border-radius:4px; padding:0 5px; font-size:10px; line-height:1.4; cursor:pointer;">&#9678;</button>`
                                : '';
                            display = `${val}${marks}${targetBtn}`;
                            style += ' color:#e0e0e0; text-align:left;';
                        } else if (col.key === 'tier') {
                            display = `T${val}`;
                            style += ' color:#888; text-align:center;';
                        } else if (col.key === 'bestiary') {
                            const outlook = row._bestiary;
                            if (!outlook) {
                                display = '—';
                                style += ' text-align:right; color:#666;';
                            } else {
                                const first = Number.isFinite(outlook.firstPointHours)
                                    ? outlook.firstPointHours < 1
                                        ? `${Math.max(1, Math.round(outlook.firstPointHours * 60))}m`
                                        : `${outlook.firstPointHours.toFixed(1)}h`
                                    : null;
                                display =
                                    `${outlook.pointsPerDay.toFixed(1)}` +
                                    (first ? `<span style="color:#888; font-size:9px;"> · 1st ${first}</span>` : '');
                                const lines = outlook.monsters
                                    .slice(0, 8)
                                    .map((m) => {
                                        const name =
                                            gameData?.combatMonsterDetailMap?.[m.monsterHrid]?.name || m.monsterHrid;
                                        const eta =
                                            m.hoursToNext < 1
                                                ? `${Math.max(1, Math.round(m.hoursToNext * 60))}m`
                                                : `${m.hoursToNext.toFixed(1)}h`;
                                        return `${name}: ${m.count} defeated, ${m.killsPerHour.toFixed(1)}/hr → next point at ${m.nextAt} in ${eta} (+${m.pointsGained} in 24h)`;
                                    })
                                    .join('\n');
                                const cellTitle = `${outlook.pointsGained} points in the first 24 h here.\n${lines}`;
                                style += ' text-align:right; font-variant-numeric:tabular-nums;';
                                const bestVal = maxVals[col.key];
                                if (bestVal !== undefined && val === bestVal && val > 0 && rows.length > 1) {
                                    style += ' color:#4caf50; font-weight:600;';
                                } else {
                                    style += ' color:#e0e0e0;';
                                }
                                return `<td style="${style}" title="${cellTitle.replace(/"/g, '&quot;')}">${display}</td>`;
                            }
                        } else if (col.key === 'deaths') {
                            display = val.toFixed(2);
                            style += ' text-align:right; font-variant-numeric:tabular-nums;';

                            const bestVal = minVals[col.key];
                            const isBest = bestVal !== undefined && val === bestVal && rows.length > 1;
                            if (isBest) {
                                style += ' color:#4caf50; font-weight:600;';
                            } else if (val > 0) {
                                style += ' color:#f44336;';
                            } else {
                                style += ' color:#e0e0e0;';
                            }
                        } else {
                            // The Score is a placing out of 100, not a quantity
                            // of anything, so it is never abbreviated
                            display = col.key === 'score' ? String(val ?? 0) : formatKMB(Math.round(val));
                            style += ' text-align:right; font-variant-numeric:tabular-nums;';

                            // A volume-bounded figure is never shown silently
                            if ((col.key === 'profitDay' || col.key === 'profit') && row.liquidityLimit) {
                                display += liquidityMarkerHtml(row.liquidityLimit, { compact: true });
                            }

                            // How the sim's forecast for this zone and tier has
                            // fared against the sessions actually fought there
                            if (col.key === 'profit' && row.zoneHrid) {
                                display += badgeHtml(
                                    calibrationBadgeFor('combat', {
                                        actionHrid: row.zoneHrid,
                                        difficultyTier: Number(row.tier) || 0,
                                        exact: true,
                                        label: 'sim profit for this zone',
                                    })
                                );
                            }

                            // Highlight best value per column in green
                            const isLowerBetter = col.key === 'expenses';
                            const bestVal = isLowerBetter ? minVals[col.key] : maxVals[col.key];
                            const isBest = bestVal !== undefined && val === bestVal && rows.length > 1;

                            if (isBest) {
                                style += ' color:#4caf50; font-weight:600;';
                            } else if ((col.key === 'profit' || col.key === 'profitDay') && val < 0) {
                                style += ' color:#f44336;';
                            } else {
                                style += ' color:#e0e0e0;';
                            }
                        }

                        return `<td style="${style}">${display}</td>`;
                    })
                    .join('');
                // Striping rather than a rule under every row: sixty-six rows of
                // borders is a grid, and the eye tracks a band across a wide
                // table better than it tracks a line under it
                const stripe = rowIndex % 2 ? ' background:rgba(255,255,255,0.02);' : '';
                return `<tr style="border-bottom:1px solid #1a1a1a;${stripe}">${cells}</tr>`;
            })
            .join('');

        // Wide enough that the remaining columns are legible, narrow enough that
        // hiding the untrained skills actually buys back the horizontal scroll
        const minWidth = Math.max(420, cols.length * 56);

        container.innerHTML = `
            ${this._allZonesHeadline(best)}
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; min-width:${minWidth}px;">
                    <thead><tr>${headerCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        `;
        if (bestiaryOn) this._renderBestiaryPlanner(container);

        // A max-food run says so in the filename *and* in a column. The filename
        // is what you see in a folder six weeks later; the column is what
        // survives being pasted into a sheet that already has last month's run
        // under it. Neither exists for an ordinary run, so nothing downstream
        // of the normal export changes shape.
        const maxTierFood = this._allZonesMaxTierFood;
        if (maxTierFood) for (const row of rows) row.food = 'Max-tier';

        // Raw numbers, not the formatted cells: a spreadsheet cannot sort "1.2B"
        this._addCsvExport(container, maxTierFood ? 'combatsim-all-zones-maxfood' : 'combatsim-all-zones', () => ({
            columns: [
                { key: 'zone', label: 'Zone' },
                { key: 'tier', label: 'Tier' },
                ...(maxTierFood ? [{ key: 'food', label: 'Food' }] : []),
                { key: 'encounters', label: 'Encounters/hr' },
                { key: 'deaths', label: 'Deaths/hr' },
                { key: 'score', label: 'Score' },
                { key: 'totalXP', label: 'Total XP/hr' },
                { key: 'stamina', label: 'Stamina XP/hr' },
                { key: 'intelligence', label: 'Intelligence XP/hr' },
                { key: 'attack', label: 'Attack XP/hr' },
                { key: 'melee', label: 'Melee XP/hr' },
                { key: 'defense', label: 'Defense XP/hr' },
                { key: 'ranged', label: 'Ranged XP/hr' },
                { key: 'magic', label: 'Magic XP/hr' },
                { key: 'revenue', label: 'Revenue/hr' },
                { key: 'expenses', label: 'Cost/hr' },
                { key: 'profit', label: 'Profit/hr' },
                { key: 'profitDay', label: 'Profit/day' },
                ...(bestiaryOn ? [{ key: 'bestiary', label: 'Bestiary pts/day' }] : []),
            ],
            rows,
        }));

        // Add sort listeners
        container.querySelectorAll('th[data-col]').forEach((th) => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (this._allZonesSortCol === col) {
                    this._allZonesSortAsc = !this._allZonesSortAsc;
                } else {
                    this._allZonesSortCol = col;
                    this._allZonesSortAsc = col === 'zone'; // Ascending for zone name, descending for numbers
                }
                this._displayAllZonesResults(zoneResults, hours, gameData);
            });
        });

        // Each row's ⌖ button sets that zone + tier as the Configure target and
        // jumps there. Reattached on every re-render, like the sort listeners.
        container.querySelectorAll('.mwi-csim-target-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._targetZoneFromResults(btn.dataset.hrid, parseInt(btn.dataset.tier, 10) || 0);
            });
        });
    }

    /**
     * The zones the route planner works from: every simulated zone in run order
     * (ties in the plan go to the earlier one), at the kill rates it should be
     * planned at.
     *
     * An ordinary zone is planned at the rates the sim reported. A dungeon is
     * not: the sim clears one at a pace nobody sustains, and a route that sent
     * you there on that promise would be wrong by however much your party
     * actually hesitates. What the sim is right about is the *contents* of a
     * clear, so the rates are restated as "one clear's worth of kills, at the
     * clears an hour your own run history manages" — see `rescaleDungeonRates`.
     *
     * @param {Array<Object>} rows - The results table's rows
     * @returns {Promise<Array<Object>>} Planner zones
     * @private
     */
    async _buildBestiaryPlanZones(rows) {
        let runs = [];
        if (rows.some((row) => row._dungeon)) {
            try {
                runs = (await dungeonTrackerStorage()?.getAllRuns()) || [];
            } catch (error) {
                console.error('[CombatSimUI] Reading the dungeon run history for the plan failed:', error);
            }
        }

        return rows.map((row) => {
            const zone = {
                zoneHrid: `${row.zoneHrid || row.zone}|T${row.tier}`,
                name: `${row.zone} T${row.tier}`,
                killsPerHour: row._killsPerHour,
                encountersPerHour: row.encounters,
            };
            if (!row._dungeon) return zone;

            const simHours = Number(row._dungeon.simHours) || 0;
            const scaled = rescaleDungeonRates({
                killsPerHour: row._killsPerHour,
                simClearsPerHour: simHours > 0 ? row._dungeon.completions / simHours : 0,
                runs: runs.filter((run) => run?.dungeonName === row._dungeon.name || run?.dungeonHrid === row.zoneHrid),
                tier: row.tier,
            });
            if (!scaled) return { ...zone, isDungeon: true };

            return {
                ...zone,
                killsPerHour: scaled.killsPerHour,
                // A dungeon's "fights" are clears, which is also what the plan
                // table calls them
                encountersPerHour: scaled.clearsPerHour,
                isDungeon: true,
                note:
                    scaled.source === 'measured'
                        ? `measured (${scaled.runs} run${scaled.runs === 1 ? '' : 's'})`
                        : scaled.source === 'measured-all-tiers'
                          ? `measured, all tiers (${scaled.runs} run${scaled.runs === 1 ? '' : 's'})`
                          : 'sim clear time',
            };
        });
    }

    /**
     * Read back the planner's remembered budget, mode, points target and
     * whether dungeons join the run.
     * @private
     */
    async _loadBestiaryPlanPrefs() {
        try {
            const savedHours = Number(await storage.get(BESTIARY_PLAN_HOURS_KEY, 'settings', null));
            if (savedHours > 0) this._bestiaryPlanHours = savedHours;
            const savedMode = await storage.get(BESTIARY_PLAN_MODE_KEY, 'settings', null);
            if (savedMode === 'points' || savedMode === 'hours') this._bestiaryPlanMode = savedMode;
            const savedPoints = Number(await storage.get(BESTIARY_PLAN_POINTS_KEY, 'settings', null));
            if (savedPoints > 0) this._bestiaryPlanPoints = savedPoints;
            this._includeDungeons = Boolean(await storage.get(ALL_ZONES_DUNGEONS_KEY, 'settings', false));
        } catch (error) {
            console.error('[CombatSimUI] Failed to read the Bestiary plan preferences:', error);
        }
    }

    /** @private */
    async _persistBestiaryPlanPrefs() {
        try {
            await Promise.all([
                storage.set(
                    BESTIARY_PLAN_HOURS_KEY,
                    this._bestiaryPlanHours || BESTIARY_PLAN_DEFAULT_HOURS,
                    'settings'
                ),
                storage.set(BESTIARY_PLAN_MODE_KEY, this._bestiaryPlanMode || 'hours', 'settings'),
                storage.set(
                    BESTIARY_PLAN_POINTS_KEY,
                    this._bestiaryPlanPoints || BESTIARY_PLAN_DEFAULT_POINTS,
                    'settings'
                ),
                storage.set(ALL_ZONES_DUNGEONS_KEY, Boolean(this._includeDungeons), 'settings'),
            ]);
        } catch (error) {
            console.error('[CombatSimUI] Failed to save the Bestiary plan preferences:', error);
        }
    }

    /**
     * The Bestiary route planner under the All Zones table: an hours budget,
     * a Plan button, and — once planned — the ordered list of zones that earns
     * the most points in that time, against the best single zone.
     *
     * Lives inside the results container like the CSV bar, so a re-sort or a
     * Bestiary refresh rebuilds it along with the table; `_bestiaryPlanActive`
     * is what survives the rebuild, so a plan once asked for is redrawn — and
     * a plan asked for before the Bestiary had loaded fills in when it lands.
     *
     * @param {HTMLElement} container - The results container, table already drawn
     * @private
     */
    _renderBestiaryPlanner(container) {
        if (!container) return;
        container.querySelector('#mwi-csim-bestiary-plan')?.remove();

        const box = document.createElement('div');
        box.id = 'mwi-csim-bestiary-plan';
        box.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px solid #333;';
        const mode = this._bestiaryPlanMode === 'points' ? 'points' : 'hours';
        const hours = this._bestiaryPlanHours || BESTIARY_PLAN_DEFAULT_HOURS;
        const points = this._bestiaryPlanPoints || BESTIARY_PLAN_DEFAULT_POINTS;
        const inputStyle =
            'width:56px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; ' +
            'padding:2px 4px; font-size:11px; text-align:center;';
        box.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11px;">
                <span style="color:#ffb74d; font-weight:600;" title="Which zones, in which order, earn the most Bestiary points in the time given: fight wherever the next point lands soonest, then move on. Uses the kills per hour this run simulated and your current defeated counts.">Bestiary plan</span>
                <select class="toolasha-select" id="mwi-csim-bestiary-plan-mode" title="Hours: what a time budget earns. Points: how long a points target takes, and where." style="background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:2px 4px; font-size:11px; font-family:inherit; cursor:pointer;">
                    <option value="hours"${mode === 'hours' ? ' selected' : ''}>Hours</option>
                    <option value="points"${mode === 'points' ? ' selected' : ''}>Points</option>
                </select>
                <label style="color:#888; display:flex; align-items:center; gap:4px;"><span id="mwi-csim-bestiary-plan-label">${mode === 'points' ? 'Points wanted' : 'Hours'}</span>
                    <input id="mwi-csim-bestiary-plan-value" type="number" min="${mode === 'points' ? '1' : '0.1'}" max="100000" step="any" value="${mode === 'points' ? points : hours}" style="${inputStyle}">
                </label>
                <button id="mwi-csim-bestiary-plan-btn" style="background:${ACCENT_BTN_BG}; border:1px solid ${ACCENT_BTN_BORDER}; color:#8ab4f8; border-radius:4px; padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit;">Plan</button>
                <button id="mwi-csim-bestiary-plan-copy" style="display:none; background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit;">Copy</button>
                <label style="color:#888; display:flex; align-items:center; gap:4px; cursor:pointer;" title="Simulate every dungeon at T0-T2 as well, and let the plan send you into one. Dungeon rows are marked [D] and are planned at the clear time your own run history measured, not the simulator's. Takes effect on the next All Zones run.">
                    <input id="mwi-csim-bestiary-plan-dungeons" type="checkbox"${this._includeDungeons ? ' checked' : ''} style="margin:0; cursor:pointer;">
                    Include dungeons
                </label>
            </div>
            <div id="mwi-csim-bestiary-plan-out" style="margin-top:6px;"></div>
        `;
        container.appendChild(box);

        const input = box.querySelector('#mwi-csim-bestiary-plan-value');
        const label = box.querySelector('#mwi-csim-bestiary-plan-label');
        const modeSelect = box.querySelector('#mwi-csim-bestiary-plan-mode');
        // What the one box means depends on the mode, so the switch banks the
        // value it is leaving before it swaps the field under the cursor
        const readInput = () => {
            const value = parseFloat(input.value);
            if (this._bestiaryPlanMode === 'points') {
                this._bestiaryPlanPoints = value > 0 ? value : BESTIARY_PLAN_DEFAULT_POINTS;
                input.value = String(this._bestiaryPlanPoints);
            } else {
                this._bestiaryPlanHours = value > 0 ? value : BESTIARY_PLAN_DEFAULT_HOURS;
                input.value = String(this._bestiaryPlanHours);
            }
        };
        modeSelect.addEventListener('change', (event) => {
            event.stopPropagation();
            readInput();
            this._bestiaryPlanMode = modeSelect.value === 'points' ? 'points' : 'hours';
            const nowPoints = this._bestiaryPlanMode === 'points';
            label.textContent = nowPoints ? 'Points wanted' : 'Hours';
            input.min = nowPoints ? '1' : '0.1';
            input.value = String(
                nowPoints
                    ? this._bestiaryPlanPoints || BESTIARY_PLAN_DEFAULT_POINTS
                    : this._bestiaryPlanHours || BESTIARY_PLAN_DEFAULT_HOURS
            );
            this._persistBestiaryPlanPrefs();
            if (this._bestiaryPlanActive) this._drawBestiaryPlan();
        });
        box.querySelector('#mwi-csim-bestiary-plan-dungeons').addEventListener('change', (event) => {
            event.stopPropagation();
            this._includeDungeons = event.target.checked;
            this._persistBestiaryPlanPrefs();
        });
        box.querySelector('#mwi-csim-bestiary-plan-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            readInput();
            this._persistBestiaryPlanPrefs();
            this._bestiaryPlanActive = true;
            this._drawBestiaryPlan();
        });
        const copyBtn = box.querySelector('#mwi-csim-bestiary-plan-copy');
        copyBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const text = this._bestiaryPlanText();
            if (!text) return;
            const flash = (label) => {
                copyBtn.textContent = label;
                clearTimeout(this._bestiaryPlanCopyFlash);
                this._bestiaryPlanCopyFlash = setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                }, 1600);
            };
            let copied = false;
            try {
                await navigator.clipboard.writeText(text);
                copied = true;
            } catch {
                // The async clipboard refuses an unfocused document; the
                // selection-based copy still works there
                const area = document.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.style.cssText = 'position:fixed; top:-1000px; left:-1000px; opacity:0;';
                document.body.appendChild(area);
                area.select();
                try {
                    copied = Boolean(document.execCommand && document.execCommand('copy'));
                } catch {
                    copied = false;
                }
                area.remove();
            }
            if (!copied) console.error('[CombatSimUI] Copying the Bestiary plan failed');
            flash(copied ? 'Copied ✓' : 'Failed');
        });

        if (this._bestiaryPlanActive) this._drawBestiaryPlan();
    }

    /**
     * The plan the planner would draw now, or null without the Bestiary.
     * @returns {Object|null}
     * @private
     */
    _currentBestiaryPlan() {
        if (!this._bestiaryPlanCounts || !this._bestiaryPlanZones) return null;
        return planBestiaryRoute({
            zones: this._bestiaryPlanZones,
            counts: this._bestiaryPlanCounts,
            hours: this._bestiaryPlanHours || BESTIARY_PLAN_DEFAULT_HOURS,
            targetPoints:
                this._bestiaryPlanMode === 'points' ? this._bestiaryPlanPoints || BESTIARY_PLAN_DEFAULT_POINTS : null,
        });
    }

    /** @private */
    _bestiaryMonsterName(hrid) {
        return this._bestiaryPlanGameData?.combatMonsterDetailMap?.[hrid]?.name || hrid;
    }

    /**
     * The plan as plain text, what the Copy button puts on the clipboard.
     * @returns {string}
     * @private
     */
    _bestiaryPlanText() {
        const plan = this._currentBestiaryPlan();
        return plan ? formatPlanText(plan, { monsterName: (hrid) => this._bestiaryMonsterName(hrid) }) : '';
    }

    /**
     * Draw (or redraw) the plan into the planner's output slot.
     * @private
     */
    _drawBestiaryPlan() {
        const out = this.panel?.querySelector('#mwi-csim-bestiary-plan-out');
        const copyBtn = this.panel?.querySelector('#mwi-csim-bestiary-plan-copy');
        if (!out) return;

        if (!this._bestiaryPlanCounts) {
            this._requestBestiary();
            out.innerHTML =
                '<span style="color:#888; font-size:11px;">waiting for bestiary… (open Achievements → Bestiary once ' +
                'if this does not fill in)</span>';
            if (copyBtn) copyBtn.style.display = 'none';
            return;
        }

        const plan = this._currentBestiaryPlan();
        if (copyBtn) copyBtn.style.display = plan?.segments.length ? '' : 'none';
        const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const skipped = this._bestiaryPlanSkipped || 0;
        const skippedNote = skipped
            ? `<div style="color:#888; font-size:10px; margin-bottom:4px;">${skipped} zone${
                  skipped === 1 ? '' : 's'
              } without a sim result skipped.</div>`
            : '';
        if (!plan || !plan.segments.length) {
            out.innerHTML = `${skippedNote}<span style="color:#888; font-size:11px;">No zone in this run earns a Bestiary point.</span>`;
            return;
        }

        const th = (label, align = 'right') =>
            `<th style="padding:3px 4px; white-space:nowrap; font-size:10px; font-weight:600; color:#888; ` +
            `border-bottom:1px solid #333; text-align:${align};">${label}</th>`;
        const tdStyle = 'padding:2px 4px; font-size:10px; white-space:nowrap;';
        // A dungeon's stay is quoted in clears — "≈3 fights" for three trips
        // through a fortress would be nonsense
        const fightsCell = (segment) =>
            segment.encounters === null || segment.encounters === undefined
                ? '—'
                : `≈${Math.round(segment.encounters).toLocaleString()}${segment.isDungeon ? ' clears' : ''}`;
        const body = plan.segments
            .map((segment, index) => {
                const crossings = segment.monsters.filter((m) => m.reached);
                const pending = segment.monsters.filter((m) => !m.reached);
                const crossText = crossings
                    .map((m) => `${esc(this._bestiaryMonsterName(m.monsterHrid))} ${m.from} → ${m.to}`)
                    .join(', ');
                const partialText = segment.partial
                    ? pending
                          .slice(0, 3)
                          .map((m) => `${esc(this._bestiaryMonsterName(m.monsterHrid))} ${Math.floor(m.count)}/${m.to}`)
                          .join(', ')
                    : '';
                const detail =
                    (crossText ? `<span style="color:#e0e0e0;">${crossText}</span>` : '') +
                    (partialText
                        ? `<span style="color:#888;">${crossText ? ' · ' : ''}partial: ${partialText}</span>`
                        : '');
                const stripe = index % 2 ? ' background:rgba(255,255,255,0.02);' : '';
                const fightsTitle = segment.isDungeon
                    ? `About how many clears that stay is, at your clear time for this dungeon — ${
                          segment.note || 'sim clear time'
                      }`
                    : 'About how many fights that stay is, at the fights per hour this run simulated for the zone';
                const nameTitle = segment.note ? ` title="Clear time: ${esc(segment.note)}"` : '';
                return (
                    `<tr style="border-bottom:1px solid #1a1a1a;${stripe}">` +
                    `<td style="${tdStyle} color:#888; text-align:right;">${index + 1}</td>` +
                    `<td style="${tdStyle} color:#e0e0e0; text-align:left;"${nameTitle}>${esc(segment.name)}</td>` +
                    `<td style="${tdStyle} color:#e0e0e0; text-align:right; font-variant-numeric:tabular-nums;">${formatPlanHours(segment.hours)}</td>` +
                    `<td style="${tdStyle} color:#bbb; text-align:right; font-variant-numeric:tabular-nums;" title="${esc(fightsTitle)}">${fightsCell(segment)}</td>` +
                    `<td style="${tdStyle} color:${segment.points > 0 ? '#4caf50' : '#888'}; text-align:right; font-variant-numeric:tabular-nums;">+${segment.points}</td>` +
                    `<td style="${tdStyle} text-align:left; white-space:normal;">${detail || '—'}</td>` +
                    `</tr>`
                );
            })
            .join('');
        // Points mode compares in time, not in points: the single zone that
        // reaches the same target soonest, or that it never does
        let single;
        if (!plan.bestSingle) {
            single = plan.mode === 'points' ? 'no single zone reaches it' : 'no single zone earns a point';
        } else if (plan.mode === 'points') {
            single =
                plan.bestSingle.hours === null || plan.bestSingle.hours === undefined
                    ? `no single zone reaches ${plan.targetPoints}`
                    : `best single zone ${esc(plan.bestSingle.name)} reaches ${plan.targetPoints} in ` +
                      `<span style="color:#e0e0e0;">${formatPlanHours(plan.bestSingle.hours)} h</span>`;
        } else {
            single = `best single zone ${esc(plan.bestSingle.name)}: <span style="color:#e0e0e0;">${plan.bestSingle.points}</span>`;
        }
        const shortfall = plan.unreachable
            ? `<div style="color:#ffb74d; font-size:10px; margin-top:2px;">Every zone ran dry before ` +
              `${plan.targetPoints} points — this is as far as they get.</div>`
            : '';
        out.innerHTML = `
            ${skippedNote}
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; min-width:360px;">
                    <thead><tr>${th('#')}${th('Zone', 'left')}${th('Time')}${th('Fights')}${th('Points')}${th('Thresholds crossed', 'left')}</tr></thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
            <div id="mwi-csim-bestiary-plan-footer" style="font-size:11px; color:#888; margin-top:4px;">
                Route: <span style="color:#4caf50; font-weight:600;">${plan.totalPoints} points</span> in ${formatPlanHours(plan.hoursUsed)} h · ${single}
            </div>
            ${shortfall}
        `;
    }

    /**
     * Point the Configure tab at a single zone + tier chosen from the all-zones
     * Results table, leaving all-zones mode so the single-zone selects show.
     * @param {string} zoneHrid
     * @param {number} tier
     * @private
     */
    _targetZoneFromResults(zoneHrid, tier) {
        if (!zoneHrid) return;

        // The Results table only exists after an all-zones run, which hides the
        // single-zone selects — clear that mode so they come back.
        this._allZonesMode = null;
        const groupBox = this.panel.querySelector('#mwi-csim-allzones-group');
        const soloBox = this.panel.querySelector('#mwi-csim-allzones-solo');
        if (groupBox) groupBox.checked = false;
        if (soloBox) soloBox.checked = false;
        this._updateAllZonesUI();

        const zoneSelect = this.panel.querySelector('#mwi-csim-zone');
        const tierSelect = this.panel.querySelector('#mwi-csim-tier');
        if (zoneSelect) zoneSelect.value = zoneHrid;
        this._updateTierDropdown();
        if (tierSelect) tierSelect.value = String(tier);

        this._switchTab('configure');
    }

    /**
     * Populate (or refresh) the seekable item list from all combat zone drop tables.
     * Only called once per game data session; subsequent calls are no-ops if list is cached.
     * @private
     */
    _populateSeekItems() {
        if (this._seekItems.length > 0) return;

        const gameData = buildGameDataPayload();
        if (!gameData) return;

        const { actionDetailMap, combatMonsterDetailMap } = gameData;
        if (!actionDetailMap || !combatMonsterDetailMap) return;

        const itemHridSet = new Set();

        for (const action of Object.values(actionDetailMap)) {
            if (action.type !== '/action_types/combat') continue;
            const isDungeon = action.combatZoneInfo?.isDungeon || false;

            if (isDungeon) {
                for (const drop of action.combatZoneInfo?.dungeonInfo?.rewardDropTable || []) {
                    if (drop.itemHrid) itemHridSet.add(drop.itemHrid);
                }
            } else {
                const spawns = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns || [];
                const bossSpawns = action.combatZoneInfo?.fightInfo?.bossSpawns || [];
                for (const spawn of [...spawns, ...bossSpawns]) {
                    const monster = combatMonsterDetailMap[spawn.combatMonsterHrid];
                    if (!monster) continue;
                    for (const drop of monster.dropTable || []) {
                        if (drop.itemHrid) itemHridSet.add(drop.itemHrid);
                    }
                    for (const drop of monster.rareDropTable || []) {
                        if (drop.itemHrid) itemHridSet.add(drop.itemHrid);
                    }
                }
            }
        }

        const clientData = dataManager.getInitClientData();
        const itemDetailMap = clientData?.itemDetailMap || {};

        this._seekItems = Array.from(itemHridSet)
            .map((hrid) => ({ itemHrid: hrid, name: itemDetailMap[hrid]?.name || hrid.split('/').pop() }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Update the seek suggestion list based on the current search text.
     * @param {string} query
     * @private
     */
    _updateSeekSuggestions(query) {
        const container = this.panel?.querySelector('#mwi-csim-seek-suggestions');
        if (!container) return;

        this._populateSeekItems();

        const q = (query || '').toLowerCase().trim();
        if (!q) {
            container.style.display = 'none';
            return;
        }

        const matches = this._seekItems.filter((item) => item.name.toLowerCase().includes(q)).slice(0, 20);

        if (!matches.length) {
            container.style.display = 'none';
            return;
        }

        container.innerHTML = '';
        for (const item of matches) {
            const el = document.createElement('div');
            el.style.cssText =
                'padding:3px 0; font-size:12px; color:#ccc; cursor:pointer; border-bottom:1px solid #1a1a2e;';
            el.textContent = item.name;
            el.addEventListener('mousedown', () => {
                this._seekSelectedItem = item;
                const input = this.panel.querySelector('#mwi-csim-seek-input');
                if (input) input.value = item.name;
                container.style.display = 'none';
            });
            container.appendChild(el);
        }
        container.style.display = 'block';
    }

    /**
     * Run the Seek simulation: find all zones that drop the selected item and rank by items/hr.
     * @private
     */
    async _onSeek() {
        if (this.isRunning) {
            this._setStatus('A simulation is already running.');
            return;
        }

        const input = this.panel?.querySelector('#mwi-csim-seek-input');
        const queryText = input?.value?.trim() || '';

        // Resolve selected item — either from prior click or by exact name match
        if (!this._seekSelectedItem || this._seekSelectedItem.name !== queryText) {
            const match = this._seekItems.find((i) => i.name.toLowerCase() === queryText.toLowerCase());
            if (match) {
                this._seekSelectedItem = match;
            } else {
                this._setStatus('No item selected. Type a name and pick from the list.');
                return;
            }
        }

        const { itemHrid, name: itemName } = this._seekSelectedItem;

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const zones = getZonesThatDropItem(itemHrid, gameData);
        if (!zones.length) {
            const resultsEl = this.panel?.querySelector('#mwi-csim-seek-results');
            if (resultsEl)
                resultsEl.innerHTML =
                    '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No zones drop this item.</div>';
            return;
        }

        const hoursEl = this.panel?.querySelector('#mwi-csim-seek-hours');
        const hours = Math.min(
            10000,
            Math.max(1, parseInt(hoursEl?.value) || config.getSettingValue('combatSim_seekDefaultHours', 10))
        );

        let playerDTOs;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
            // Revenue/drops below are computed for whichever player
            // `_activePlayerTab` names, and that field doubles as "which
            // player's tab is open in a previous single-zone result" — left
            // alone here, a party where self isn't player1 would price this
            // run for whoever's tab a past result happened to leave selected.
            this._activePlayerTab = this._editor?.getSelfHrid() || playerDTOs[0]?.hrid || 'player1';
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
            this._playerInfo = result.playerInfo;
            this._activePlayerTab = result.selfHrid;
        }

        if (!playerDTOs.length) {
            this._setStatus('No character data available.');
            return;
        }

        const communityBuffs = getCommunityBuffs();

        // UI setup
        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-csim-seek-run');
        const stopBtn = this.panel.querySelector('#mwi-csim-seek-stop');
        const progressEl = this.panel.querySelector('#mwi-csim-seek-progress');
        const progressFill = this.panel.querySelector('#mwi-csim-seek-progress-fill');
        const progressText = this.panel.querySelector('#mwi-csim-seek-progress-text');
        const resultsEl = this.panel.querySelector('#mwi-csim-seek-results');

        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';
        stopBtn.style.display = '';
        progressEl.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        resultsEl.innerHTML = '';

        const simStartTime = Date.now();
        // What is left of the run, taken from the run's own pace
        const eta = createEtaTracker();
        const zoneCount = zones.length;
        // Local timer handle — a shared instance field could be overwritten by a
        // concurrent run, leaking the interval permanently
        const elapsedTimer = setInterval(() => {
            const elapsed = (Date.now() - simStartTime) / 1000;
            this._setStatus(`Seeking ${itemName} in ${zoneCount} zone/tiers... ${formatElapsed(elapsed)}`);
        }, 100);

        try {
            const simZones = zones.map((z) => ({ zoneHrid: z.zoneHrid, difficultyTier: z.difficultyTier }));

            const simResults = await runAllZonesSimulation(
                { gameData, playerDTOs, zones: simZones, hours, communityBuffs, useEarlyExit: false },
                (percent) => {
                    const { text: remaining } = eta.update(percent / 100);
                    progressFill.style.width = `${percent}%`;
                    progressText.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                }
            );

            clearInterval(elapsedTimer);
            const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);

            const playerHrid = this._activePlayerTab || 'player1';

            const seekRows = simResults
                .map((simResult, i) => {
                    if (!simResult) return null;
                    const zone = zones[i];
                    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;

                    const dropMap = calculateExpectedDrops(simResult, gameData, playerHrid);
                    const itemCount = dropMap.get(itemHrid) || 0;
                    const itemsPerHour = itemCount / simHours;
                    if (itemsPerHour <= 0) return null;

                    let profitPerHour = 0;
                    let costPerHour = 0;
                    try {
                        const revenue = calculateSimRevenue(simResult, gameData, playerHrid, simHours);
                        profitPerHour = revenue.netPerHour;
                        costPerHour = revenue.costPerHour;
                    } catch {
                        // Revenue may not be available
                    }

                    const costPerDrop = itemsPerHour > 0 ? costPerHour / itemsPerHour : 0;

                    return { zone, itemsPerHour, profitPerHour, costPerHour, costPerDrop };
                })
                .filter(Boolean);

            this._seekResults = seekRows;
            this._seekSortCol = 'itemsPerHour';
            this._seekSortAsc = false;
            this._displaySeekResults(seekRows, itemName);
            this._setStatus(`Seek complete in ${totalElapsed}: ${seekRows.length} sources found for ${itemName}`);
        } catch (error) {
            if (error.message === 'Cancelled') {
                this._setStatus('Seek cancelled.');
            } else {
                console.error('[CombatSimUI] Seek simulation failed:', error);
                this._setStatus(`Seek error: ${error.message || 'Unknown error'}`);
            }
        } finally {
            clearInterval(elapsedTimer);
            this.isRunning = false;
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.style.cursor = 'pointer';
            stopBtn.style.display = 'none';
            progressEl.style.display = 'none';
        }
    }

    /**
     * Render seek results in a sortable table.
     * @param {Array<Object>} rows - seek result rows
     * @param {string} itemName - display name of the sought item
     * @private
     */
    _displaySeekResults(rows, itemName) {
        const container = this.panel?.querySelector('#mwi-csim-seek-results');
        if (!container) return;

        if (!rows.length) {
            container.innerHTML = `<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No zones drop ${itemName}.</div>`;
            return;
        }

        const cols = [
            { key: 'zone', label: 'Zone' },
            { key: 'tier', label: 'T' },
            { key: 'itemsPerHour', label: 'Items/hr' },
            { key: 'profitPerHour', label: 'Profit/hr' },
            { key: 'costPerHour', label: 'Cost/hr' },
            { key: 'costPerDrop', label: 'Cost/Drop' },
        ];

        // Sort
        const sortCol = this._seekSortCol || 'itemsPerHour';
        const sortAsc = this._seekSortAsc;
        const sorted = [...rows].sort((a, b) => {
            const va =
                sortCol === 'zone' ? a.zone.name : sortCol === 'tier' ? a.zone.difficultyTier : (a[sortCol] ?? 0);
            const vb =
                sortCol === 'zone' ? b.zone.name : sortCol === 'tier' ? b.zone.difficultyTier : (b[sortCol] ?? 0);
            if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            return sortAsc ? va - vb : vb - va;
        });

        // Best per numeric column (for green highlight)
        const bestItemsPerHour = Math.max(...rows.map((r) => r.itemsPerHour));
        const bestProfitPerHour = Math.max(...rows.map((r) => r.profitPerHour));
        const lowestCostPerHour =
            rows.filter((r) => r.costPerHour > 0).length > 0
                ? Math.min(...rows.filter((r) => r.costPerHour > 0).map((r) => r.costPerHour))
                : null;
        const lowestCostPerDrop =
            rows.filter((r) => r.costPerDrop > 0).length > 0
                ? Math.min(...rows.filter((r) => r.costPerDrop > 0).map((r) => r.costPerDrop))
                : null;

        const arrow = (col) => (this._seekSortCol === col ? (this._seekSortAsc ? ' ▲' : ' ▼') : '');

        const headerCells = cols
            .map(
                (col) =>
                    `<th data-col="${col.key}" style="padding:3px 4px; cursor:pointer; white-space:nowrap; font-size:10px; font-weight:600; color:#888; border-bottom:1px solid #333; user-select:none;">${col.label}${arrow(col.key)}</th>`
            )
            .join('');

        const bodyRows = sorted
            .map((row) => {
                const cells = cols
                    .map((col) => {
                        let display = '';
                        let highlight = false;
                        const cellStyle = 'padding:2px 4px; font-size:10px; white-space:nowrap;';

                        if (col.key === 'zone') {
                            display = row.zone.name;
                        } else if (col.key === 'tier') {
                            display = String(row.zone.difficultyTier);
                        } else if (col.key === 'itemsPerHour') {
                            display = row.itemsPerHour.toFixed(3);
                            highlight = row.itemsPerHour === bestItemsPerHour;
                        } else if (col.key === 'profitPerHour') {
                            display = formatKMB(row.profitPerHour);
                            highlight = row.profitPerHour === bestProfitPerHour && row.profitPerHour > 0;
                        } else if (col.key === 'costPerHour') {
                            display = row.costPerHour > 0 ? formatKMB(row.costPerHour) : '—';
                            highlight = lowestCostPerHour !== null && row.costPerHour === lowestCostPerHour;
                        } else if (col.key === 'costPerDrop') {
                            display = row.costPerDrop > 0 ? formatKMB(row.costPerDrop) : '—';
                            highlight = lowestCostPerDrop !== null && row.costPerDrop === lowestCostPerDrop;
                        }

                        const color = highlight ? '#4caf50' : '#ccc';
                        return `<td style="${cellStyle} color:${color};">${display}</td>`;
                    })
                    .join('');
                return `<tr style="border-bottom:1px solid #1a1a2e;">${cells}</tr>`;
            })
            .join('');

        container.innerHTML = `
            <div style="font-size:11px; color:#888; margin-bottom:8px;">Best sources for <strong style="color:${ACCENT};">${itemName}</strong></div>
            <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; min-width:400px;">
                    <thead><tr>${headerCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        `;

        this._addCsvExport(container, 'combatsim-seek', () => ({
            columns: [
                { key: 'item', label: 'Item' },
                { key: 'zone', label: 'Zone' },
                { key: 'tier', label: 'Tier' },
                { key: 'itemsPerHour', label: 'Items/hr' },
                { key: 'profitPerHour', label: 'Profit/hr' },
                { key: 'costPerHour', label: 'Cost/hr' },
                { key: 'costPerDrop', label: 'Cost per drop' },
            ],
            rows: sorted.map((r) => ({
                item: itemName,
                zone: r.zone.name,
                tier: r.zone.difficultyTier,
                itemsPerHour: r.itemsPerHour,
                profitPerHour: r.profitPerHour,
                costPerHour: r.costPerHour,
                costPerDrop: r.costPerDrop,
            })),
        }));

        container.querySelectorAll('th[data-col]').forEach((th) => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (this._seekSortCol === col) {
                    this._seekSortAsc = !this._seekSortAsc;
                } else {
                    this._seekSortCol = col;
                    this._seekSortAsc = col === 'zone' || col === 'tier';
                }
                this._displaySeekResults(rows, itemName);
            });
        });
    }

    /**
     * Reset the Simulate button to its default state.
     * @param {HTMLElement} btn
     * @private
     */
    _resetRunButton(btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
    }

    /**
     * Switch between Configure and Results tabs.
     * @param {string} tab - 'configure' or 'results'
     * @private
     */
    _switchTab(tab) {
        this._activeMainTab = tab;
        const configureContent = this.panel.querySelector('#mwi-csim-configure-content');
        const resultsContent = this.panel.querySelector('#mwi-csim-results-content');
        const seekContent = this.panel.querySelector('#mwi-csim-seek-content');
        const upgradeContent = this.panel.querySelector('#mwi-csim-upgrade-content');
        const tabConfigure = this.panel.querySelector('#mwi-csim-tab-configure');
        const tabResults = this.panel.querySelector('#mwi-csim-tab-results');
        const tabSeek = this.panel.querySelector('#mwi-csim-tab-seek');
        const tabUpgrade = this.panel.querySelector('#mwi-csim-tab-upgrade');

        const activeStyle = `flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:${ACCENT_BG}; color:${ACCENT}; border-bottom:2px solid ${ACCENT};`;
        const inactiveStyle =
            'flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:transparent; color:#888; border-bottom:2px solid transparent;';

        configureContent.style.display = 'none';
        resultsContent.style.display = 'none';
        if (seekContent) seekContent.style.display = 'none';
        if (upgradeContent) upgradeContent.style.display = 'none';
        tabConfigure.style.cssText = inactiveStyle;
        tabResults.style.cssText = inactiveStyle;
        if (tabSeek) tabSeek.style.cssText = inactiveStyle;
        if (tabUpgrade) tabUpgrade.style.cssText = inactiveStyle;

        // A run owns the status line. The prompts below describe what the tab is
        // for, which is true when nothing is happening and a lie mid-run — the
        // elapsed timer and the progress description are the only honest text
        // while a simulation or an analysis is in flight.
        const idle = !this._isBusy();

        if (tab === 'configure') {
            configureContent.style.display = 'flex';
            tabConfigure.style.cssText = activeStyle;
            if (idle) this._setStatus('Select a zone and click Simulate.');
        } else if (tab === 'seek') {
            if (seekContent) seekContent.style.display = 'flex';
            if (tabSeek) tabSeek.style.cssText = activeStyle;
            this._populateSeekItems();
            if (idle) this._setStatus('Search for a combat drop item, then click Seek.');
        } else if (tab === 'upgrade') {
            if (upgradeContent) upgradeContent.style.display = 'flex';
            if (tabUpgrade) tabUpgrade.style.cssText = activeStyle;
            this._populateUpgradePlayerSelector();
            if (idle) this._setStatus('Select a player and click Analyze.');
        } else {
            resultsContent.style.display = 'flex';
            tabResults.style.cssText = activeStyle;
            if (idle && !this._lastSimResult && !this._allZonesResults) {
                this._setStatus('No results yet. Run a simulation first.');
            }
        }
    }

    /**
     * Whether anything long-running is in flight — a simulation, a seek, or an
     * upgrade analysis. The status line belongs to whichever of them is running.
     * @returns {boolean}
     * @private
     */
    _isBusy() {
        return Boolean(this.isRunning || this._upgradeRunning);
    }

    /**
     * Handle the Simulate button click.
     * @private
     */
    async _onSimulate() {
        if (this.isRunning) {
            // Stop the running simulation. The warm workers stay: Stop here is
            // almost always "that is not what I meant" followed by an edit and
            // another Simulate, and the state left behind is the same one a run
            // that finished normally leaves - bounded by the idle reaper, and
            // emptied outright by a feature teardown or a character switch.
            cancelActiveSimulations();
            cancelAllZonesSimulation();
            this._setStatus('Simulation cancelled.');
            this._switchTab('configure');
            return;
        }

        // Route to all-zones simulation if active
        if (this._allZonesMode) {
            return this._onSimulateAllZones();
        }

        // Captured before the first await: the run below takes minutes, and
        // everything persisted after it is otherwise keyed by whoever is
        // current by the time it finishes
        const ownerId = dataManager.getCurrentCharacterId();

        const zoneHrid = this.panel.querySelector('#mwi-csim-zone')?.value;
        const difficultyTier = parseInt(this.panel.querySelector('#mwi-csim-tier')?.value) || 0;
        const hours = Math.min(
            10000,
            Math.max(
                1,
                parseInt(this.panel.querySelector('#mwi-csim-hours')?.value) ||
                    config.getSettingValue('combatSim_defaultHours', 100)
            )
        );

        if (!zoneHrid) {
            this._setStatus('No zone selected.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        // Use edited DTOs if available, otherwise auto-fill
        let playerDTOs;
        let playerInfo;
        let selfHrid;
        // The real answer to "which loaded player is the live character", not
        // the "pick someone to show" fallback below `selfHrid` carries — an
        // imported profile (openWithExternalDTO) is nobody's self, and
        // `_persistConsumableRates` must not mistake their consumption for the
        // live character's own and overwrite it in storage
        let trueSelfHrid;
        let missingMembers;

        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
            playerInfo = this._editor?.getPlayerInfo() || [];
            trueSelfHrid = this._editor?.getSelfHrid() || null;
            selfHrid = trueSelfHrid || playerDTOs[0]?.hrid || 'player1';
            missingMembers = this._editor?.getMissingMembers() || [];
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
            playerInfo = result.playerInfo;
            trueSelfHrid = result.selfHrid;
            selfHrid = result.selfHrid;
            missingMembers = result.missingMembers;
        }

        if (!playerDTOs.length) {
            this._setStatus('No character data available.');
            return;
        }

        // Enforce 3-player max for non-dungeon zones
        const zones = getCombatZones();
        const selectedZone = zones.find((z) => z.hrid === zoneHrid);
        if (selectedZone && !selectedZone.isDungeon && playerDTOs.length > 3) {
            this._showWarning(
                `Non-dungeon zones support max 3 players (you have ${playerDTOs.length}). Remove players to continue.`
            );
            return;
        }

        this._playerInfo = playerInfo;
        this._activePlayerTab = selfHrid;

        // Loadout lint: mistakes a party would want called out before reading
        // any of the numbers they distort
        this._lastPartyWarnings = partyLintWarnings(playerDTOs, playerInfo, gameData);

        const communityBuffs = getCommunityBuffs();

        // Show party info
        const partyInfo =
            playerDTOs.length > 1
                ? `Party (${playerDTOs.length} loaded${missingMembers.length ? ', ' + missingMembers.length + ' missing' : ''})`
                : 'Solo';

        // Disable Simulate button during run
        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-csim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-csim-progress-container');
        const progressFill = this.panel.querySelector('#mwi-csim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-csim-progress-text');
        const resultsContainer = this.panel.querySelector('#mwi-csim-results');

        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        resultsContainer.style.display = 'none';

        // Switch to results tab to show progress
        this._switchTab('results');

        const simStartTime = Date.now();
        // What is left of the run, taken from the run's own pace
        const eta = createEtaTracker();
        // Local timer handle — a shared instance field could be overwritten by a
        // concurrent run, leaking the interval permanently
        const elapsedTimer = setInterval(() => {
            const elapsed = (Date.now() - simStartTime) / 1000;
            this._setStatus(`Simulating (${partyInfo})... ${formatElapsed(elapsed)}`);
        }, 100);

        try {
            const simResult = await runSimulation(
                {
                    gameData,
                    playerDTOs,
                    zoneHrid,
                    difficultyTier,
                    hours,
                    communityBuffs,
                    isTaskFight: Boolean(this.panel.querySelector('#mwi-csim-taskfight')?.checked),
                },
                (percent) => {
                    const { text: remaining } = eta.update(percent / 100);
                    progressFill.style.width = `${percent}%`;
                    progressText.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                }
            );

            clearInterval(elapsedTimer);
            const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);

            this._lastSimResult = simResult;
            this._lastSimHours = hours;
            this._lastGameData = gameData;
            this._persistConsumableRates(simResult, trueSelfHrid, ownerId);

            // Generate label before displaying (display may re-render)
            const historyLabel = this._editor?.generateSimLabel() || 'Current Gear';

            // Add history entry (metrics filled after _displayResults computes them)
            const historyEntry = {
                label: historyLabel,
                simResult,
                hours,
                gameData,
                metrics: null, // Filled by _displayResults
                partyWarnings: this._lastPartyWarnings,
                timestamp: Date.now(),
            };

            // Auto-set comparison baseline to first entry when adding second+ result
            if (this._simHistory.length > 0 && this._comparisonBaseline === null) {
                this._comparisonBaseline = 0;
            }
            if (this._simHistory.length > 0 && this._comparisonIndex === null) {
                this._comparisonIndex = 0;
            }

            this._simHistory.push(historyEntry);
            if (this._simHistory.length > 10) {
                this._simHistory.shift();
                // Adjust comparison indices
                if (this._comparisonIndex !== null) {
                    this._comparisonIndex = Math.max(0, this._comparisonIndex - 1);
                }
                if (this._comparisonBaseline !== null) {
                    this._comparisonBaseline = Math.max(0, this._comparisonBaseline - 1);
                }
                this._comparisonSlots = this._comparisonSlots.map((i) => i - 1).filter((i) => i >= 0);
                if (this._activeDetailIndex !== null) {
                    this._activeDetailIndex = Math.max(0, this._activeDetailIndex - 1);
                }
            }

            // Show the newly run sim's details
            this._activeDetailIndex = this._simHistory.length - 1;
            this._displayResults(simResult, hours, gameData);
            this._switchTab('results');
            const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
            const modeLabel = config.getPricingModeLabel(mode);
            const missingNote = missingMembers.length
                ? ` | Missing: ${missingMembers.join(', ')} (open their profiles)`
                : '';
            this._setStatus(
                `Simulation complete in ${totalElapsed}: ${formatWithSeparator(hours)} hours · ${partyInfo} · Pricing: ${modeLabel}${missingNote}`
            );
        } catch (error) {
            if (error.message === 'Cancelled') {
                this._setStatus('Simulation cancelled.');
            } else {
                console.error('[CombatSimUI] Simulation failed:', error);
                this._setStatus(`Simulation error: ${error.message || 'Unknown error'}`);
            }
        } finally {
            clearInterval(elapsedTimer);
            this.isRunning = false;
            this._resetRunButton(runBtn);
            progressContainer.style.display = 'none';
        }
    }

    /**
     * Run simulations for all selected zones.
     * @private
     */
    async _onSimulateAllZones() {
        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();
        const selectedZones = this._getSelectedAllZones();
        if (!selectedZones.length) {
            this._setStatus('No zones selected.');
            return;
        }

        const hours = Math.min(
            10000,
            Math.max(
                1,
                parseInt(this.panel.querySelector('#mwi-csim-allzones-hours')?.value) ||
                    config.getSettingValue('combatSim_allZonesDefaultHours', 10)
            )
        );

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        // Use edited DTOs if available, otherwise auto-fill
        let playerDTOs;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
            // Revenue/drops below are computed for whichever player
            // `_activePlayerTab` names, and that field doubles as "which
            // player's tab is open in a previous single-zone result" — left
            // alone here, a party where self isn't player1 would price this
            // run for whoever's tab a past result happened to leave selected.
            this._activePlayerTab = this._editor?.getSelfHrid() || playerDTOs[0]?.hrid || 'player1';
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
            this._playerInfo = result.playerInfo;
            this._activePlayerTab = result.selfHrid;
        }

        if (!playerDTOs.length) {
            this._setStatus('No character data available.');
            return;
        }

        // All-zones is always non-dungeon — enforce 3-player max
        if (playerDTOs.length > 3) {
            this._showWarning(
                `Non-dungeon zones support max 3 players (you have ${playerDTOs.length}). Remove players to continue.`
            );
            return;
        }

        // Sim-only, and only here. The substituted DTOs replace the local
        // variable and nothing else — the editor keeps its own objects, the
        // loadout store is never written, and the single-zone and Seek paths
        // build their DTOs separately and never see this.
        const useMaxTierFood = this._maxTierFoodEnabled && Boolean(this._allZonesMode);
        let foodSwaps = [];
        if (useMaxTierFood) {
            const substituted = applyMaxTierFood(playerDTOs, gameData);
            playerDTOs = substituted.playerDTOs;
            foodSwaps = substituted.swaps;
        }
        this._allZonesMaxTierFood = useMaxTierFood;
        this._allZonesFoodSwaps = foodSwaps;

        const communityBuffs = getCommunityBuffs();

        // UI: disable Simulate button, show progress
        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-csim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-csim-progress-container');
        const progressFill = this.panel.querySelector('#mwi-csim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-csim-progress-text');
        const resultsContainer = this.panel.querySelector('#mwi-csim-results');

        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        resultsContainer.style.display = 'none';

        this._switchTab('results');

        const simStartTime = Date.now();
        // What is left of the run, taken from the run's own pace
        const eta = createEtaTracker();
        const zoneCount = selectedZones.length;
        // Local timer handle — a shared instance field could be overwritten by a
        // concurrent run, leaking the interval permanently
        const elapsedTimer = setInterval(() => {
            const elapsed = (Date.now() - simStartTime) / 1000;
            this._setStatus(`Simulating ${zoneCount} zones... ${formatElapsed(elapsed)}`);
        }, 100);

        try {
            const zones = selectedZones.map((z) => ({ zoneHrid: z.zoneHrid, difficultyTier: z.difficultyTier }));

            const simResults = await runAllZonesSimulation(
                {
                    gameData,
                    playerDTOs,
                    zones,
                    hours,
                    communityBuffs,
                    useEarlyExit: this._earlyExitEnabled,
                    // The early-exit decision must read the same player the ranked
                    // table shows, or it prunes tiers by a figure the user never sees
                    playerHrid: this._activePlayerTab || 'player1',
                },
                (percent) => {
                    const { text: remaining } = eta.update(percent / 100);
                    progressFill.style.width = `${percent}%`;
                    progressText.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                }
            );

            clearInterval(elapsedTimer);
            const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);

            // The worker pool is done, but the results are not: revenue and
            // liquidity capping run per zone (with real market-history fetches
            // on a cache miss) and the table itself still has to render before
            // anything can be saved. Left showing the frozen "Simulating…"
            // text through all of that, the panel looks hung at 100% — say
            // what is actually happening instead of freezing on stale words.
            this._setStatus(`Finalizing ${zoneCount} zones' results...`);

            // Build zone results with revenue calculations
            const playerHrid = this._activePlayerTab || 'player1';
            const zoneResults = simResults
                .map((simResult, i) => {
                    if (!simResult) return null;

                    let revenue = null;
                    try {
                        revenue = calculateSimRevenue(simResult, gameData, playerHrid, hours);
                    } catch {
                        // Revenue calculation may not be available
                    }

                    return {
                        zone: selectedZones[i],
                        simResult,
                        revenue,
                    };
                })
                .filter(Boolean);

            this._allZonesSortCol = 'score';
            this._allZonesSortAsc = false;
            await this._displayAllZonesResults(zoneResults, hours, gameData);

            // Outlives the panel: the ranked action list reads this to put combat
            // zones next to skilling actions long after the results pane is gone.
            // Which is exactly why a run that outlived its character must not be
            // written — the snapshot carries no character of its own, so one
            // filed under the arriving character quotes the departing
            // character's zone profits to every reader, indefinitely.
            if (this._stillSameCharacter(ownerId)) {
                await saveAllZonesSnapshot(
                    buildAllZonesSnapshot(zoneResults, {
                        hours,
                        playerHrid,
                        fingerprint: gearFingerprint(playerDTOs),
                        maxTierFood: useMaxTierFood,
                    })
                );
            }

            this._switchTab('results');
            this._setStatus(
                `All zones complete in ${totalElapsed}: ${zoneCount} zones · ${formatWithSeparator(hours)} hours each` +
                    (useMaxTierFood ? ' · max-tier food' : '')
            );
        } catch (error) {
            if (error.message === 'Cancelled') {
                this._setStatus('Simulation cancelled.');
            } else {
                console.error('[CombatSimUI] All zones simulation failed:', error);
                this._setStatus(`Simulation error: ${error.message || 'Unknown error'}`);
            }
        } finally {
            clearInterval(elapsedTimer);
            this.isRunning = false;
            this._resetRunButton(runBtn);
            progressContainer.style.display = 'none';
        }
    }

    /**
     * Format and display simulation results.
     * @param {Object} simResult - SimResult from the combat simulator engine
     * @param {number} hours - Number of hours simulated
     * @param {Object} gameData - Game data maps for drop calculation
     * @private
     */
    /**
     * Whether the character a run was started for is still the one logged in.
     *
     * Everything this panel persists after a run — the all-zones snapshot, the
     * consumable rates, the remembered upgrade analysis — is filed under a key
     * resolved at the moment of the write, but the run that produced it takes
     * minutes. A character switch landing inside that window files the
     * departing character's results under the arriving character's key,
     * silently destroying results the arriving character waited just as long
     * for and, for the snapshot, feeding another character's zone profits to
     * the ranked action list long after the panel is gone.
     *
     * Compared rather than merely required, so a run started before login (no
     * id on either side) still persists exactly as it always has — a guard
     * that refuses more than the switch is its own bug.
     *
     * @param {string|null|undefined} ownerId - The id captured before the run's first await
     * @returns {boolean} True when the results still belong to whoever is current
     * @private
     */
    _stillSameCharacter(ownerId) {
        return dataManager.getCurrentCharacterId() === ownerId;
    }

    /**
     * Keep the last sim's per-hour consumable use where a reload cannot lose it.
     *
     * The one figure the Consumables panel cannot compute for itself: food has
     * no arithmetic rate (it fires on health and mana triggers), so the sim is
     * the only thing that can say how fast a zone eats it while nothing is
     * being fought. The sim's own character only — named explicitly by the
     * caller rather than guessed from key order: `consumablesUsed`'s keys
     * mirror party-slot order, and self is not always `player1` or first in
     * that order (a character who joined a party after others sits at
     * whatever slot the game gave them). A falsy `selfHrid` means the run had
     * no self at all — an imported profile simmed on its own — and must return
     * without persisting anything: guessing the first key back would file a
     * stranger's consumption under the live character's own saved rate, in
     * storage scoped to the live character.
     *
     * @param {Object} simResult - The finished SimResult
     * @param {string|null} selfHrid - The character's own hrid in this run's DTOs, or null
     *   when nothing in the run is the live character
     */
    _persistConsumableRates(simResult, selfHrid, ownerId) {
        try {
            if (!selfHrid) return;
            if (!this._stillSameCharacter(ownerId)) return;
            const used = simResult?.consumablesUsed?.[selfHrid];
            if (!used) return;
            const simHours = (Number(simResult.simulatedTime) || 0) / (3600 * 1e9) || 1;
            const perHour = {};
            for (const [itemHrid, count] of Object.entries(used)) {
                if (Number(count) > 0) perHour[itemHrid] = Number(count) / simHours;
            }
            if (!Object.keys(perHour).length) return;
            const record = {
                zoneHrid: simResult.zoneName || null,
                difficultyTier: simResult.difficultyTier ?? 0,
                savedAt: Date.now(),
                perHour,
            };
            writeScoped('simConsumableRates', record, 'combatExport').catch(() => {});
            // Also filed under the zone itself, so the Consumables panel can
            // pin "always rate my food from this zone at this tier" and keep
            // that rating across sims of other zones
            //
            // A read-modify-write: `readScoped` resolves its key now,
            // `writeScoped` resolves its own only once the read has settled. A
            // switch in between wrote this character's whole by-zone map back
            // under the arriving character's key, replacing every zone rating
            // they had recorded with someone else's. Re-checked after the read.
            const zoneKey = `${record.zoneHrid || 'unknown'}|${record.difficultyTier}`;
            readScoped('simConsumableRatesByZone', 'combatExport', {})
                .then((byZone) => {
                    if (!this._stillSameCharacter(ownerId)) return undefined;
                    return writeScoped(
                        'simConsumableRatesByZone',
                        { ...(byZone || {}), [zoneKey]: record },
                        'combatExport'
                    );
                })
                .catch(() => {});
        } catch (error) {
            console.error('[CombatSimUI] Persisting consumable rates failed:', error);
        }
    }

    _displayResults(simResult, hours, gameData) {
        // If an active detail index is set, show that history entry's details instead
        let partyWarnings = this._lastPartyWarnings || [];
        if (this._activeDetailIndex !== null && this._simHistory[this._activeDetailIndex]) {
            const entry = this._simHistory[this._activeDetailIndex];
            simResult = entry.simResult;
            hours = entry.hours;
            gameData = entry.gameData;
            partyWarnings = entry.partyWarnings || [];
        }

        const container = this.panel.querySelector('#mwi-csim-results');
        if (!container) return;

        const activeTab = this._activePlayerTab;
        const playerInfo = this._playerInfo;
        const numberOfPlayers = simResult.numberOfPlayers || 1;

        const sectionStyle = 'margin-bottom:12px;';
        const headingStyle = `color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; border-bottom:1px solid #222; padding-bottom:4px;`;
        const rowStyle = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
        const labelStyle = 'color:#aaa;';
        const valueStyle = 'color:#e0e0e0; font-weight:600;';

        let html = '';

        // Pre-compute metrics for history entries (recomputed on player-tab change)
        this._ensureHistoryMetrics(activeTab);

        // Mechanics the engine could not model. Shown above everything because
        // it changes how every number below should be read.
        if (simResult.warnings?.length) {
            html += `<div style="margin-bottom:10px; padding:6px 8px; border:1px solid #6b5a1f; background:rgba(255,200,60,0.08); border-radius:4px; font-size:11px; color:#e8c66c;">`;
            for (const warning of simResult.warnings) {
                html += `<div>&#9888; ${warning}</div>`;
            }
            html += '</div>';
        }

        // The headline numbers a player actually opens this tab for are worked
        // out by the sections below — revenue by the Drops table, expenses by
        // the Consumables one — so the summary cannot be built until they have
        // run. It is stitched in at this marker afterwards rather than
        // recomputed, so the tiles and the tables can never disagree.
        html += RESULTS_SUMMARY_SLOT;

        // Party loadout lint, directly under the summary: a warning about the
        // inputs belongs beside the headline numbers it distorts. Same amber
        // treatment as the engine's own warnings above.
        if (partyWarnings.length > 0) {
            html +=
                `<div style="margin-bottom:10px; padding:6px 8px; border:1px solid #6b5a1f; ` +
                `background:rgba(255,200,60,0.08); border-radius:4px; font-size:11px; color:#e8c66c;">`;
            for (const warning of partyWarnings) {
                html += `<div>&#9888; ${warning}</div>`;
            }
            html += '</div>';
        }

        // History panel (above everything)
        if (this._simHistory.length > 0) {
            html += this._renderHistoryPanel();
        }

        // Player tabs (only shown for party sims)
        if (numberOfPlayers > 1) {
            html += `<div style="display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap;">`;
            for (const { hrid, name } of playerInfo) {
                const isActive = hrid === activeTab;
                const tabStyle = isActive
                    ? `background:${ACCENT_BG}; border:1px solid ${ACCENT_BORDER}; color:${ACCENT}; font-weight:700;`
                    : 'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;';
                html += `<button data-tab="${hrid}" style="
                    ${tabStyle}
                    padding:3px 10px; border-radius:5px; font-size:12px; cursor:pointer;
                    font-family:inherit; transition:all 0.1s;
                ">${name}</button>`;
            }
            html += '</div>';
        }

        // Compute previous values for delta comparison (from history)
        // Use baseline for deltas (comparison table baseline, not the old comparisonIndex)
        const compIdx = this._comparisonBaseline ?? this._comparisonIndex;
        const compEntry = compIdx !== null ? this._simHistory[compIdx] : null;
        const compResult = compEntry?.simResult;
        const compHours = compEntry?.hours;
        const compMetrics = compEntry?.metrics;
        const hasPrev = compResult && compHours;
        const prevEncPerHr = hasPrev ? compResult.encounters / compHours : null;
        // Gated on the active player actually appearing in the baseline run
        // (not just `hasPrev`), the same way the XP section already does below —
        // a player who wasn't in the comparison run coalesced to 0 deaths
        // rather than "no data", drawing a real delta badge off a fabricated
        // baseline whenever the party changed between the two runs.
        const prevDeathsPerHr =
            hasPrev && compResult.deaths?.[activeTab] !== undefined ? compResult.deaths[activeTab] / compHours : null;

        // Overview: encounters/hr (party-wide) + deaths/hr (per active player)
        const encountersPerHr = simResult.encounters / hours;
        const playerDeaths = simResult.deaths?.[activeTab] || 0;
        const deathsPerHr = playerDeaths / hours;

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Overview</div>`;
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Encounters/hr</span>`;
        html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(encountersPerHr))}${this._formatDelta(encountersPerHr, prevEncPerHr)}</span>`;
        html += '</div>';
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Deaths/hr</span>`;
        html += `<span style="${valueStyle}">${this._formatDeathsPerHour(deathsPerHr)}${this._formatDelta(deathsPerHr, prevDeathsPerHr, false)}</span>`;
        html += '</div>';

        // Mana Run Out
        const ranOutOfMana = simResult.playerRanOutOfMana?.[activeTab] ?? false;
        const oomColor = ranOutOfMana ? '#ff6b6b' : '#4ade80';
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Mana Run Out</span>`;
        html += `<span style="color:${oomColor}; font-weight:600;">${ranOutOfMana ? 'Yes' : 'No'}</span>`;
        html += '</div>';
        if (ranOutOfMana && simResult.playerRanOutOfManaTime?.[activeTab] && simResult.simulatedTime) {
            const stat = simResult.playerRanOutOfManaTime[activeTab];
            const openWindow = stat.isOutOfMana ? simResult.simulatedTime - stat.startTimeForOutOfMana : 0;
            const totalOomTime = stat.totalTimeForOutOfMana + openWindow;
            const oomRatio = ((totalOomTime / simResult.simulatedTime) * 100).toFixed(2);
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Run Out Ratio</span>`;
            html += `<span style="color:#ff6b6b; font-weight:600;">${oomRatio}%</span>`;
            html += '</div>';
        }

        // Debuff on level gap — only shown when non-zero
        const debuff = simResult.debuffOnLevelGap?.[activeTab] ?? 0;
        if (debuff !== 0) {
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Debuff on Level Gap</span>`;
            html += `<span style="color:#ff6b6b; font-weight:600;">${Math.round(Math.abs(debuff) * 100)}%</span>`;
            html += '</div>';
        }

        // DPS — from actual damage dealt per player
        let summaryDps = null;
        let summaryPrevDps = null;
        if (simResult.totalDamageDealt && simResult.simulatedTime > 0) {
            const simSeconds = simResult.simulatedTime / 1e9;
            let partyDamage = 0;
            for (const { hrid } of playerInfo) {
                partyDamage += simResult.totalDamageDealt[hrid] || 0;
            }
            const partyDps = partyDamage / simSeconds;
            this._lastComputedDps = partyDps;
            summaryDps = partyDps;

            let prevPartyDps = null;
            // Every current player has to have actually fought in the
            // comparison run — otherwise a party that grew between the two
            // runs would count the new member's damage as 0 rather than
            // leaving the whole party figure as "no data", quietly deflating
            // the previous total and inflating the delta.
            if (
                hasPrev &&
                compResult.totalDamageDealt &&
                compResult.simulatedTime > 0 &&
                playerInfo.every(({ hrid }) => compResult.totalDamageDealt[hrid] !== undefined)
            ) {
                const compSimSeconds = compResult.simulatedTime / 1e9;
                let prevDamage = 0;
                for (const { hrid } of playerInfo) {
                    prevDamage += compResult.totalDamageDealt[hrid] || 0;
                }
                prevPartyDps = prevDamage / compSimSeconds;
            }
            summaryPrevDps = prevPartyDps;

            const dpsLabel = numberOfPlayers > 1 ? 'Party DPS' : 'DPS';
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">${dpsLabel}</span>`;
            html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(partyDps))}${this._formatDelta(partyDps, prevPartyDps)}</span>`;
            html += '</div>';

            if (numberOfPlayers > 1) {
                for (const { hrid, name } of playerInfo) {
                    const playerDps = (simResult.totalDamageDealt[hrid] || 0) / simSeconds;
                    let prevPlayerDps = null;
                    if (hasPrev && compResult.totalDamageDealt?.[hrid] !== undefined && compResult.simulatedTime > 0) {
                        prevPlayerDps = compResult.totalDamageDealt[hrid] / (compResult.simulatedTime / 1e9);
                    }
                    html += `<div style="${rowStyle}">`;
                    html += `<span style="color:#888; padding-left:12px;">${name}</span>`;
                    html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(playerDps))}${this._formatDelta(playerDps, prevPlayerDps)}</span>`;
                    html += '</div>';
                }
            }
        }

        // Dungeon stats if applicable
        if (simResult.isDungeon) {
            const completedPerHr = simResult.dungeonsCompleted / hours;
            const failedPerHr = simResult.dungeonsFailed / hours;

            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Dungeons completed/hr</span>`;
            html += `<span style="${valueStyle}">${this._formatRate(completedPerHr)}</span>`;
            html += '</div>';
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Dungeons failed/hr</span>`;
            html += `<span style="${valueStyle}">${this._formatRate(failedPerHr)}</span>`;
            html += '</div>';
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Total completed / failed</span>`;
            html += `<span style="${valueStyle}">${formatWithSeparator(simResult.dungeonsCompleted)} / ${formatWithSeparator(simResult.dungeonsFailed)}</span>`;
            html += '</div>';
            if (simResult.dungeonsCompleted > 0) {
                const formatClear = (ns) => {
                    const sec = ns / 1e9;
                    if (config.getSettingValue('combatSim_decimalMinutes', false)) {
                        return `${(sec / 60).toFixed(2)} min`;
                    }
                    return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
                };

                // Two clear-time numbers answer two different questions.
                //
                // Clean: mean interval between consecutive successful clears
                // (no wipe between), which matches the in-game dungeon tracker —
                // "how fast is a run when it works".
                if (simResult.dungeonCleanClearCount > 0) {
                    const cleanNs = simResult.dungeonCleanClearTimeTotal / simResult.dungeonCleanClearCount;
                    html += `<div style="${rowStyle}">`;
                    html += `<span style="${labelStyle}" title="Mean time between consecutive successful clears, failed attempts excluded. Matches the in-game dungeon tracker.">Avg clear (clean)</span>`;
                    html += `<span style="${valueStyle}">${formatClear(cleanNs)}</span>`;
                    html += '</div>';
                }

                // Effective: total simulated time amortised over every
                // completion, so wipe time and the unfinished tail are charged
                // against throughput — "effective time per clear including
                // failures". Above the clean number by the cost of failures,
                // which is the figure for judging whether a higher tier that
                // occasionally wipes is still worth pushing.
                const effectiveNs = simResult.simulatedTime / simResult.dungeonsCompleted;
                html += `<div style="${rowStyle}">`;
                html += `<span style="${labelStyle}" title="Total simulated time divided by dungeons completed — includes failed attempts and the unfinished final run. Compare with the clean number to see the cost of failures at this tier.">Avg clear (incl. fails)</span>`;
                html += `<span style="${valueStyle}">${formatClear(effectiveNs)}</span>`;
                html += '</div>';
            }
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Max wave reached</span>`;
            html += `<span style="${valueStyle}">${simResult.maxWaveReached}</span>`;
            html += '</div>';
        }
        html += '</div>';

        // Sustain — HP/MP the engine has always tracked per source and never shown
        html += this._renderSustainBreakdown(simResult, hours, gameData, activeTab);

        // XP/hr by skill — per active tab player
        const xpTotals = {};
        if (simResult.experienceGained[activeTab]) {
            for (const [skill, amount] of Object.entries(simResult.experienceGained[activeTab])) {
                xpTotals[skill] = (xpTotals[skill] || 0) + amount;
            }
        }

        // Build previous XP map for delta comparison
        const prevXpPerHr = {};
        if (hasPrev && compResult.experienceGained?.[activeTab]) {
            for (const [skill, amount] of Object.entries(compResult.experienceGained[activeTab])) {
                prevXpPerHr[skill] = Math.round(amount / compHours);
            }
        }

        const xpEntries = Object.entries(xpTotals).filter(([, total]) => total > 0);
        // Rounded per skill before summing, so the summary tile and the Total
        // row of the XP section are the same number rather than two roundings
        const xpPerHrBySkill = xpEntries.map(([skill, total]) => [skill, Math.round(total / hours)]);
        const summaryXpPerHr = xpPerHrBySkill.reduce((sum, [, perHr]) => sum + perHr, 0);
        const summaryPrevXpPerHr = hasPrev ? Object.values(prevXpPerHr).reduce((sum, v) => sum + v, 0) : null;
        if (xpEntries.length > 0) {
            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">XP/hr</div>`;
            for (const [skill, total] of xpEntries) {
                const perHr = Math.round(total / hours);
                const prevVal = hasPrev ? prevXpPerHr[skill] || null : null;
                const skillLabel = skill.charAt(0).toUpperCase() + skill.slice(1);
                html += `<div style="${rowStyle}">`;
                html += `<span style="${labelStyle}">${skillLabel}</span>`;
                html += `<span style="${valueStyle}">${formatWithSeparator(perHr)}${this._formatDelta(perHr, prevVal)}</span>`;
                html += '</div>';
            }
            // Total XP/hr row
            const totalXpPerHr = summaryXpPerHr;
            const prevTotalXpPerHr = summaryPrevXpPerHr;
            html += `<div style="display:flex; justify-content:space-between; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px;">`;
            html += `<span style="color:#aaa; font-weight:700;">Total</span>`;
            html += `<span style="${valueStyle}">${formatWithSeparator(totalXpPerHr)}${this._formatDelta(totalXpPerHr, prevTotalXpPerHr)}</span>`;
            html += '</div>';
            html += '</div>';
        }

        // Consumable costs — per active tab player
        const consumableTotals = {};
        const selfConsumables = simResult.consumablesUsed?.[activeTab] || {};
        for (const [itemHrid, count] of Object.entries(selfConsumables)) {
            consumableTotals[itemHrid] = (consumableTotals[itemHrid] || 0) + count;
        }

        // Track totals for net profit calculation
        let dropGoldPerHr = 0;
        let dropGoldTotal = 0;
        let consumableGoldPerHr = 0;
        let consumableGoldTotal = 0;
        let keyCostPerHr = 0;
        let keyCostTotal = 0;
        let dungeonKeyCosts = [];

        // Drops — calculated from kill counts × drop tables × multipliers
        if (gameData) {
            const dropMap = calculateExpectedDrops(simResult, gameData, activeTab);

            // Pre-compute gold values for sorting
            const dropData = [...dropMap.entries()]
                .filter(([, total]) => total > 0)
                .map(([itemHrid, total]) => {
                    const price = marketAPI.getPrice(itemHrid);
                    // Revenue: sell price for the pricing mode, net of the sale tax
                    let unitValue = taxedDropValue(itemHrid, this._getSellPrice(price));
                    if (unitValue === 0 && itemHrid === '/items/coin') {
                        unitValue = 1;
                    }
                    if (unitValue === 0) {
                        // Use cached EV or calculate directly (matches combat stats approach)
                        const evc = expectedValueCalculator() || bundledExpectedValueCalculator;
                        const ev = evc.getCachedValue(itemHrid) || evc.calculateSingleContainer(itemHrid);
                        if (ev !== null && ev > 0) unitValue = ev;
                    }
                    return { itemHrid, total, unitValue, totalGold: total * unitValue };
                })
                .sort((a, b) => b.totalGold - a.totalGold); // Sort by gold value descending

            if (dropData.length > 0) {
                const dropRowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
                const colNum = 'flex:0; white-space:nowrap; min-width:56px; text-align:right;';
                const colGold = 'flex:0; white-space:nowrap; min-width:76px; text-align:right; white-space:normal;';

                html += `<div style="${sectionStyle}">`;
                html += `<div style="${headingStyle}">Drops</div>`;
                // Column headers
                html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
                html += `<span style="flex:1;">Item</span>`;
                html += `<span style="${colNum}">/hr</span>`;
                html += `<span style="${colNum}">/day</span>`;
                html += `<span style="${colGold}">Gold/hr</span>`;
                html += `<span style="${colGold}">Gold/day</span>`;
                html += `<span style="${colNum}">Total</span>`;
                html += `<span style="${colGold}">Total Gold</span>`;
                html += '</div>';

                for (const drop of dropData) {
                    const perHr = drop.total / hours;
                    const itemDetails = dataManager.getItemDetails(drop.itemHrid);
                    const name = itemDetails?.name || drop.itemHrid.split('/').pop();

                    const perHrStr = perHr >= 1 ? formatWithSeparator(Math.round(perHr)) : perHr.toFixed(2);
                    const perDay = perHr * 24;
                    const perDayStr = perDay >= 1 ? formatWithSeparator(Math.round(perDay)) : perDay.toFixed(2);
                    const totalStr =
                        drop.total >= 1 ? formatWithSeparator(Math.round(drop.total)) : drop.total.toFixed(2);

                    const goldPerHr = perHr * drop.unitValue;
                    dropGoldPerHr += goldPerHr;
                    dropGoldTotal += drop.totalGold;

                    const goldHrStr = drop.unitValue > 0 ? formatKMB(Math.round(goldPerHr)) : '—';
                    const goldDayStr = drop.unitValue > 0 ? formatKMB(Math.round(goldPerHr * 24)) : '—';
                    const goldTotalStr = drop.unitValue > 0 ? formatKMB(Math.round(drop.totalGold)) : '—';
                    const goldColor = drop.unitValue > 0 ? '#e8a87c' : '#444';

                    html += `<div style="${dropRowStyle}">`;
                    html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${perDayStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldHrStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldDayStr}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldTotalStr}</span>`;
                    html += '</div>';
                }
                // Totals row
                const prevRevPerHr = compMetrics?.revenuePerHr ?? null;
                const revDelta =
                    prevRevPerHr !== null && prevRevPerHr !== undefined
                        ? this._formatDelta(dropGoldPerHr, prevRevPerHr, true, true)
                        : '';
                html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
                html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Revenue</span>`;
                const revDayDelta =
                    prevRevPerHr !== null && prevRevPerHr !== undefined
                        ? this._formatDelta(dropGoldPerHr * 24, prevRevPerHr * 24, true, true)
                        : '';
                html += `<span style="${colNum}"></span>`;
                html += `<span style="${colNum}"></span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldPerHr))}<br>${revDelta}</span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldPerHr * 24))}<br>${revDayDelta}</span>`;
                html += `<span style="${colNum}"></span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldTotal))}</span>`;
                html += '</div>';
                html += '</div>';
            }

            // Compute dungeon key costs from drop map
            if (simResult.isDungeon) {
                const getBuyPriceForKey = (keyHrid) => {
                    const price = marketAPI.getPrice(keyHrid);
                    return this._getBuyPrice(price);
                };
                dungeonKeyCosts = calculateDungeonKeyCosts(dropMap, getBuyPriceForKey);
                for (const key of dungeonKeyCosts) {
                    keyCostPerHr += (key.count / hours) * key.unitCost;
                    keyCostTotal += key.totalCost;
                }
            }
        }

        // Consumable costs — same column layout as drops
        const consumableEntries = Object.entries(consumableTotals)
            .map(([itemHrid, total]) => {
                const price = marketAPI.getPrice(itemHrid);
                const unitCost = this._getBuyPrice(price);
                return { itemHrid, total, unitCost, totalCost: total * unitCost };
            })
            .sort((a, b) => b.totalCost - a.totalCost);

        if (consumableEntries.length > 0) {
            const costRowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
            const colNum = 'flex:0; white-space:nowrap; min-width:56px; text-align:right;';
            const colGold = 'flex:0; white-space:nowrap; min-width:76px; text-align:right; white-space:normal;';
            const costColor = '#ff6b6b';

            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">Consumable Costs</div>`;
            // Column headers
            html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
            html += `<span style="flex:1;">Item</span>`;
            html += `<span style="${colNum}">/hr</span>`;
            html += `<span style="${colNum}">/day</span>`;
            html += `<span style="${colGold}">Cost/hr</span>`;
            html += `<span style="${colGold}">Cost/day</span>`;
            html += `<span style="${colNum}">Total</span>`;
            html += `<span style="${colGold}">Total Cost</span>`;
            html += '</div>';

            for (const cons of consumableEntries) {
                const perHr = cons.total / hours;
                const itemDetails = dataManager.getItemDetails(cons.itemHrid);
                const name = itemDetails?.name || cons.itemHrid.split('/').pop();

                const perHrStr = formatWithSeparator(Math.round(perHr));
                const perDayStr = formatWithSeparator(Math.round(perHr * 24));
                const totalStr = formatWithSeparator(Math.round(cons.total));

                const costPerHr = perHr * cons.unitCost;
                consumableGoldPerHr += costPerHr;
                consumableGoldTotal += cons.totalCost;

                const costHrStr = cons.unitCost > 0 ? formatKMB(Math.round(costPerHr)) : '—';
                const costDayStr = cons.unitCost > 0 ? formatKMB(Math.round(costPerHr * 24)) : '—';
                const costTotalStr = cons.unitCost > 0 ? formatKMB(Math.round(cons.totalCost)) : '—';
                const cColor = cons.unitCost > 0 ? costColor : '#444';

                html += `<div style="${costRowStyle}">`;
                html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perDayStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costHrStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costDayStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costTotalStr}</span>`;
                html += '</div>';
            }
            // Totals row
            const prevConsumableCostPerHr = compMetrics?.consumableCostPerHr ?? null;
            const expDelta =
                prevConsumableCostPerHr !== null && prevConsumableCostPerHr !== undefined
                    ? this._formatDelta(consumableGoldPerHr, prevConsumableCostPerHr, false, true)
                    : '';
            const expDayDelta =
                prevConsumableCostPerHr !== null && prevConsumableCostPerHr !== undefined
                    ? this._formatDelta(consumableGoldPerHr * 24, prevConsumableCostPerHr * 24, false, true)
                    : '';
            html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
            html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Expenses</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldPerHr))}<br>${expDelta}</span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldPerHr * 24))}<br>${expDayDelta}</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldTotal))}</span>`;
            html += '</div>';
            html += '</div>';
        }

        // Dungeon key costs
        if (dungeonKeyCosts.length > 0) {
            const costRowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
            const colNum = 'flex:0; white-space:nowrap; min-width:56px; text-align:right;';
            const colGold = 'flex:0; white-space:nowrap; min-width:76px; text-align:right; white-space:normal;';
            const costColor = '#ff6b6b';

            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">Key Costs</div>`;
            html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
            html += `<span style="flex:1;">Item</span>`;
            html += `<span style="${colNum}">/hr</span>`;
            html += `<span style="${colNum}">/day</span>`;
            html += `<span style="${colGold}">Cost/hr</span>`;
            html += `<span style="${colGold}">Cost/day</span>`;
            html += `<span style="${colNum}">Total</span>`;
            html += `<span style="${colGold}">Total Cost</span>`;
            html += '</div>';

            for (const key of dungeonKeyCosts) {
                const perHr = key.count / hours;
                const perHrStr = perHr >= 1 ? formatWithSeparator(Math.round(perHr)) : perHr.toFixed(2);
                const perDayStr = formatWithSeparator(Math.round(perHr * 24));
                const totalStr = key.count >= 1 ? formatWithSeparator(Math.round(key.count)) : key.count.toFixed(2);

                const costPerHr = perHr * key.unitCost;
                const costHrStr = key.unitCost > 0 ? formatKMB(Math.round(costPerHr)) : '—';
                const costDayStr = key.unitCost > 0 ? formatKMB(Math.round(costPerHr * 24)) : '—';
                const costTotalStr = key.unitCost > 0 ? formatKMB(Math.round(key.totalCost)) : '—';
                const cColor = key.unitCost > 0 ? costColor : '#444';

                html += `<div style="${costRowStyle}">`;
                html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${key.name}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perDayStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costHrStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costDayStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costTotalStr}</span>`;
                html += '</div>';
            }

            // Totals row
            html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
            html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Key Costs</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(keyCostPerHr))}</span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(keyCostPerHr * 24))}</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(keyCostTotal))}</span>`;
            html += '</div>';
            html += '</div>';
        }

        // Net Profit (includes consumable costs + key costs)
        const totalExpensesPerHr = consumableGoldPerHr + keyCostPerHr;
        const totalExpensesTotal = consumableGoldTotal + keyCostTotal;
        const netProfitPerHr = dropGoldPerHr - totalExpensesPerHr;
        const netProfitTotal = dropGoldTotal - totalExpensesTotal;
        const profitColor = netProfitPerHr >= 0 ? '#7ec87e' : '#ff6b6b';
        const profitSign = netProfitPerHr >= 0 ? '' : '-';
        const totalProfitSign = netProfitTotal >= 0 ? '' : '-';

        // Metrics already pre-computed by _ensureHistoryMetrics

        // Compute delta from comparison entry
        const prevProfit = compMetrics?.profitPerHr ?? null;
        const profitDelta =
            prevProfit !== null && prevProfit !== undefined
                ? this._formatDelta(netProfitPerHr, prevProfit, true, true)
                : '';

        const netProfitPerDay = netProfitPerHr * 24;
        const profitDaySign = netProfitPerDay >= 0 ? '' : '-';

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Net Profit</div>`;
        const netColGold = 'flex:0; white-space:nowrap; min-width:76px; text-align:right; white-space:normal;';
        const netColNum = 'flex:0; white-space:nowrap; min-width:56px; text-align:right;';
        // Column headers
        html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
        html += `<span style="flex:1;"></span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColGold}">/hr</span>`;
        html += `<span style="${netColGold}">/day</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColGold}">Total</span>`;
        html += '</div>';
        html += `<div style="display:flex; align-items:center; padding:2px 0; font-size:13px; gap:6px;">`;
        html += `<span style="color:#aaa; font-weight:700; flex:1;">Profit</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColNum}"></span>`;
        const profitDayDelta =
            prevProfit !== null && prevProfit !== undefined
                ? this._formatDelta(netProfitPerDay, prevProfit * 24, true, true)
                : '';
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${profitSign}${formatKMB(Math.abs(Math.round(netProfitPerHr)))}<br>${profitDelta}</span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${profitDaySign}${formatKMB(Math.abs(Math.round(netProfitPerDay)))}<br>${profitDayDelta}</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${totalProfitSign}${formatKMB(Math.abs(Math.round(netProfitTotal)))}</span>`;
        html += '</div>';
        html += '</div>';

        // Wipe Events
        const wipeEvents = simResult.wipeEvents;
        if (wipeEvents && wipeEvents.length > 0) {
            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">Wipe Events (${wipeEvents.length})</div>`;
            for (let wi = 0; wi < wipeEvents.length; wi++) {
                const event = wipeEvents[wi];
                const wave = event.wave ?? '?';
                const timeSec = ((event.simulationTime || 0) / 1e9).toFixed(2);
                const eventId = `mwi-wipe-${wi}`;
                html += `<div style="margin-bottom:6px; border:1px solid #333; border-radius:4px; overflow:hidden;">`;
                html += `<div id="${eventId}-header" data-wipe-toggle="${wi}" style="
                    display:flex; justify-content:space-between; align-items:center;
                    padding:4px 8px; background:#1a1a1a; cursor:pointer; font-size:12px;
                ">`;
                html += `<span style="color:#aaa;">Wipe #${wi + 1} — Wave ${wave} @ ${timeSec}s</span>`;
                html += `<span style="color:#666; font-size:10px;">▶</span>`;
                html += `</div>`;
                html += `<div id="${eventId}-body" style="display:none; padding:6px 8px; font-size:11px; font-family:monospace; background:#111; max-height:300px; overflow-y:auto;">`;

                // Group logs by time
                const logs = event.logs || [];
                const groups = [];
                for (const log of logs) {
                    if (log?.error) continue;
                    const last = groups[groups.length - 1];
                    if (last && last.time === log.time) {
                        last.logs.push(log);
                    } else {
                        groups.push({ time: log.time, wave: log.wave, logs: [log] });
                    }
                }

                const baseTime = groups.length > 0 ? groups[0].time : 0;
                for (const group of groups) {
                    const rel = ((group.time - baseTime) / 1e9).toFixed(2);
                    html += `<div style="margin-top:6px; color:#666; border-top:1px solid #222; padding-top:4px;">[+${rel}s] Wave ${group.wave ?? '?'}</div>`;
                    const damagedPlayers = new Set(group.logs.map((l) => l.target));
                    for (const log of group.logs) {
                        const abilityLabel =
                            log.ability === 'autoAttack'
                                ? 'Auto Attack'
                                : log.ability === 'damageOverTime'
                                  ? 'DoT'
                                  : log.ability === 'physicalThorns'
                                    ? 'Physical Thorns'
                                    : log.ability === 'elementalThorns'
                                      ? 'Elemental Thorns'
                                      : log.ability === 'retaliation'
                                        ? 'Retaliation'
                                        : log.ability;
                        const critMark = log.isCrit ? '!!!' : '';
                        html += `<div style="padding:1px 0; color:#ccc;">`;
                        html += `<span style="color:#9ca3af;">${log.source}</span>`;
                        html += ` cast <span style="color:#c4b5fd;">${abilityLabel}</span>`;
                        html += ` → <span style="color:#93c5fd;">${log.target}</span>`;
                        html += ` <span style="color:#ff6b6b;">${log.damage}${critMark}</span>`;
                        html += ` <span style="color:#666;">HP ${log.beforeHp}→${log.afterHp}</span>`;
                        html += `</div>`;
                    }
                    // Players HP summary at end of each time group
                    if (group.logs.length > 0 && group.logs[group.logs.length - 1].playersHp) {
                        const playersHp = group.logs[group.logs.length - 1].playersHp;
                        const hpParts = playersHp.map((p) => {
                            const color = p.current <= 0 ? '#ff6b6b' : damagedPlayers.has(p.hrid) ? '#93c5fd' : '#666';
                            return `<span style="color:${color};">${p.hrid}: ${p.current}/${p.max}</span>`;
                        });
                        html += `<div style="padding:2px 0; font-size:10px;">Players HP: ${hpParts.join(' | ')}</div>`;
                    }
                }

                html += `</div>`; // body
                html += `</div>`; // card
            }
            html += `</div>`;
        }

        const summaryHtml = this._renderResultsSummary({
            simResult,
            hours,
            encountersPerHr,
            prevEncountersPerHr: prevEncPerHr,
            deathsPerHr,
            prevDeathsPerHr,
            dps: summaryDps,
            prevDps: summaryPrevDps,
            xpPerHr: summaryXpPerHr,
            prevXpPerHr: summaryPrevXpPerHr,
            xpPerHrBySkill,
            revenuePerHr: dropGoldPerHr,
            expensesPerHr: totalExpensesPerHr,
            netProfitPerHr,
            prevProfitPerHr: prevProfit,
            numberOfPlayers,
        });
        // Function replacement: a literal one would read `$&` and friends in the
        // summary as capture references
        html = html.replace(RESULTS_SUMMARY_SLOT, () => summaryHtml);

        container.innerHTML = html;
        container.style.display = 'block';

        // Tab click handler — re-render with new active player
        container.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._activePlayerTab = btn.dataset.tab;
                this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
            });
        });

        // History row click handler — show detail view for that scenario
        container.querySelectorAll('[data-history-idx]').forEach((row) => {
            const idx = parseInt(row.dataset.historyIdx, 10);
            row.addEventListener('click', () => {
                this._activeDetailIndex = idx;
                this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
            });
        });

        // Comparison: baseline selector
        const baselineSelect = container.querySelector('#mwi-csim-baseline-select');
        if (baselineSelect) {
            baselineSelect.addEventListener('change', () => {
                const newBase = parseInt(baselineSelect.value, 10);
                this._comparisonBaseline = newBase;
                // Remove the new baseline from comparison slots if present
                this._comparisonSlots = this._comparisonSlots.filter((i) => i !== newBase);
                this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
            });
        }

        // Comparison: add sim dropdown
        const addCompSelect = container.querySelector('#mwi-csim-add-comparison');
        if (addCompSelect) {
            addCompSelect.addEventListener('change', () => {
                const idx = parseInt(addCompSelect.value, 10);
                if (!isNaN(idx) && !this._comparisonSlots.includes(idx)) {
                    this._comparisonSlots.push(idx);
                    this._activeDetailIndex = idx;
                    this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
                }
            });
        }

        // Comparison: every run of the session, not just the rows on screen —
        // the point of the export is to keep runs that will scroll off the list
        this._wireCsvButton(container.querySelector('#mwi-csim-history-csv'), 'combatsim-comparison', () => ({
            columns: [
                { key: 'scenario', label: 'Scenario' },
                { key: 'role', label: 'Role' },
                { key: 'hours', label: 'Simulated hours' },
                { key: 'encountersPerHr', label: 'Encounters/hr' },
                { key: 'dps', label: 'DPS' },
                { key: 'totalXpPerHr', label: 'XP/hr' },
                { key: 'revenuePerHr', label: 'Revenue/hr' },
                { key: 'expensesPerHr', label: 'Cost/hr' },
                { key: 'consumableCostPerHr', label: 'Consumable cost/hr' },
                { key: 'keyCostPerHr', label: 'Key cost/hr' },
                { key: 'profitPerHr', label: 'Profit/hr' },
                { key: 'successRate', label: 'Dungeon success rate' },
                { key: 'ranAt', label: 'Run at' },
            ],
            rows: this._simHistory.map((entry, idx) => {
                const m = entry.metrics || {};
                const isBase = idx === (this._comparisonBaseline ?? 0);
                return {
                    scenario: entry.label,
                    role: isBase ? 'baseline' : this._comparisonSlots.includes(idx) ? 'compared' : '',
                    hours: entry.hours ?? null,
                    encountersPerHr: m.encountersPerHr ?? null,
                    dps: m.dps ?? null,
                    totalXpPerHr: m.totalXpPerHr ?? null,
                    revenuePerHr: m.revenuePerHr ?? null,
                    expensesPerHr: m.expensesPerHr ?? null,
                    consumableCostPerHr: m.consumableCostPerHr ?? null,
                    keyCostPerHr: m.keyCostPerHr ?? null,
                    profitPerHr: m.profitPerHr ?? null,
                    successRate: m.successRate ?? null,
                    ranAt: entry.timestamp ? new Date(entry.timestamp).toISOString() : '',
                };
            }),
        }));

        // Comparison: clear every saved run at once
        const clearAllBtn = container.querySelector('#mwi-csim-history-clear');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._clearAllHistory();
            });
        }

        // Comparison: remove × buttons
        container.querySelectorAll('[data-remove-comparison]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.removeComparison, 10);
                this._comparisonSlots = this._comparisonSlots.filter((i) => i !== idx);
                this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
            });
        });

        // History: delete result buttons
        container.querySelectorAll('[data-delete-history]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.deleteHistory, 10);
                this._deleteHistoryEntry(idx);
            });
        });

        // Wipe event collapsible toggles
        container.querySelectorAll('[data-wipe-toggle]').forEach((header) => {
            header.addEventListener('click', () => {
                const wi = header.dataset.wipeToggle;
                const body = container.querySelector(`#mwi-wipe-${wi}-body`);
                const arrow = header.querySelector('span:last-child');
                if (body) {
                    const isOpen = body.style.display !== 'none';
                    body.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.textContent = isOpen ? '▶' : '▼';
                }
            });
        });

        // Healing & Mana collapsible toggle
        container.querySelectorAll('[data-toggle="sustain-section"]').forEach((el) => {
            el.addEventListener('click', () => {
                const section = container.querySelector('#mwi-csim-sustain-section');
                const arrow = container.querySelector('[data-arrow="sustain-section"]');
                if (section) {
                    const isOpen = section.style.display !== 'none';
                    section.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
                }
            });
        });

        // History collapsible toggle
        container.querySelectorAll('[data-toggle="history-section"]').forEach((el) => {
            el.addEventListener('click', () => {
                const section = container.querySelector('#mwi-csim-history-section');
                const arrow = container.querySelector('[data-arrow="history-section"]');
                if (section) {
                    const isOpen = section.style.display !== 'none';
                    section.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
                }
            });
        });
    }

    /**
     * The answer to "was this fight worth it", above everything that argues it.
     *
     * A run's verdict is a handful of numbers — what a day of it earns, what a
     * day of it levels, how fast it kills and whether it kills you — and every
     * one of them was previously several sections apart, with the profit figure
     * last of all because it depends on the drop and consumable tables. Those
     * tables still hold the working; this holds the conclusions, and takes them
     * from the same variables the tables printed rather than recomputing.
     *
     * Profit and deaths are quoted per day: nobody fights a zone for an hour,
     * and a day is the unit a player weighs against the other things they
     * could be doing. XP is per hour, the same unit the XP section below and
     * every zone ranking use, so the tile can be read against them directly;
     * a dungeon's pace reads best as the average length of one clear.
     *
     * @param {Object} data - Values already computed by `_displayResults`
     * @returns {string} HTML for the summary block
     * @private
     */
    _renderResultsSummary(data) {
        const {
            simResult,
            hours,
            encountersPerHr,
            prevEncountersPerHr,
            deathsPerHr,
            prevDeathsPerHr,
            dps,
            prevDps,
            xpPerHr,
            prevXpPerHr,
            xpPerHrBySkill = [],
            revenuePerHr,
            expensesPerHr,
            netProfitPerHr,
            prevProfitPerHr,
            numberOfPlayers = 1,
        } = data;

        const tileStyle =
            'flex:1 1 100px; min-width:100px; padding:5px 8px; border:1px solid #2a2a4a; border-radius:5px; ' +
            'background:rgba(74, 158, 255, 0.06);';
        const tileLabel = 'display:block; color:#888; font-size:10px; white-space:nowrap;';
        const tileValue = 'display:block; font-size:15px; font-weight:700; line-height:1.3;';

        /**
         * One tile.
         * @param {string} label - Caption
         * @param {string} value - Preformatted value, may carry a delta span
         * @param {string} [color='#e0e0e0'] - Value colour
         * @returns {string} HTML
         */
        const tile = (label, value, color = '#e0e0e0') =>
            `<div style="${tileStyle}"><span style="${tileLabel}">${label}</span>` +
            `<span style="${tileValue} color:${color};">${value}</span></div>`;

        const profitPerDay = netProfitPerHr * 24;
        const profitColor = profitPerDay >= 0 ? '#7ec87e' : '#ff6b6b';
        const profitSign = profitPerDay >= 0 ? '' : '-';
        const profitDelta =
            prevProfitPerHr === null || prevProfitPerHr === undefined
                ? ''
                : this._formatDelta(profitPerDay, prevProfitPerHr * 24, true, true);

        const tiles = [];
        tiles.push(
            tile(
                'Profit/day',
                `${profitSign}${formatKMB(Math.abs(Math.round(profitPerDay)))}${profitDelta}`,
                profitColor
            )
        );
        tiles.push(
            tile(
                'XP/hr',
                `${formatKMB(Math.round(xpPerHr))}` + this._formatDelta(xpPerHr, prevXpPerHr ?? null, true, true)
            )
        );

        // Dungeons are entered, not encountered — the pace a player plans a
        // session around is how long one clear takes, not a wave count
        if (simResult.isDungeon) {
            const completed = simResult.dungeonsCompleted || 0;
            const attempts = completed + (simResult.dungeonsFailed || 0);
            tiles.push(tile('Avg clear', completed > 0 ? timeReadable((hours * 3600) / completed) : '—'));
            tiles.push(tile('Success', attempts > 0 ? `${((completed / attempts) * 100).toFixed(1)}%` : '—'));
        } else {
            tiles.push(
                tile(
                    'Kills/hr',
                    formatWithSeparator(Math.round(encountersPerHr)) +
                        this._formatDelta(encountersPerHr, prevEncountersPerHr ?? null)
                )
            );
        }

        if (dps !== null && dps !== undefined) {
            tiles.push(
                tile(
                    numberOfPlayers > 1 ? 'Party DPS' : 'DPS',
                    formatWithSeparator(Math.round(dps)) + this._formatDelta(dps, prevDps ?? null)
                )
            );
        }

        // Per hour, to three decimals, matching the Overview row below.
        //
        // This tile used to read per DAY, because rounding an hourly death rate
        // to an integer collapses every survivable build onto "0" and reads as
        // "never". Three decimals is the answer to that rather than a change of
        // unit: 0.042 is legible as a real rate, and the tile now agrees with
        // the Overview and with the DPH column instead of being the one figure
        // on screen in a different unit.
        tiles.push(
            tile(
                'Deaths/hr',
                this._formatDeathsPerHour(deathsPerHr) + this._formatDelta(deathsPerHr, prevDeathsPerHr, false),
                deathsPerHr > 0 ? '#ff6b6b' : '#e0e0e0'
            )
        );

        // The two halves of Profit/day, so the tile is auditable without
        // scrolling to the tables that produced them
        const subLine =
            `<div style="margin-top:5px; font-size:10px; color:#666;">` +
            `Revenue ${formatKMB(Math.round(revenuePerHr * 24))}/day &nbsp;·&nbsp; ` +
            `Costs ${formatKMB(Math.round(expensesPerHr * 24))}/day` +
            (xpPerHrBySkill.length > 0
                ? ` &nbsp;·&nbsp; ` +
                  xpPerHrBySkill
                      .slice()
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 4)
                      .map(
                          ([skill, perHr]) =>
                              `${skill.charAt(0).toUpperCase() + skill.slice(1)} ${formatKMB(Math.round(perHr * 24))}`
                      )
                      .join(', ')
                : '') +
            `</div>`;

        return (
            `<div style="margin-bottom:12px; padding:8px; border:1px solid ${ACCENT_BORDER}; border-radius:6px; background:${ACCENT_BG};">` +
            `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px;">Summary</div>` +
            `<div style="display:flex; flex-wrap:wrap; gap:6px;">${tiles.join('')}</div>` +
            subLine +
            `</div>`
        );
    }

    /**
     * Human name for a healing/mana source. The engine writes either a bare
     * label it made up ('regen', 'lifesteal') or an hrid of whatever did it.
     * @param {string} source - Source key from the SimResult
     * @param {Object} gameData - Game data payload, for ability names
     * @returns {string} Display name
     * @private
     */
    _sustainSourceName(source, gameData) {
        const labels = {
            regen: 'Regen',
            lifesteal: 'Lifesteal',
            manaLeech: 'Mana Leech',
            ripple: 'Ripple',
        };
        if (labels[source]) return labels[source];

        if (source.startsWith('/abilities/')) {
            return gameData?.abilityDetailMap?.[source]?.name || source.split('/').pop();
        }
        if (source.startsWith('/items/')) {
            return dataManager.getItemDetails(source)?.name || source.split('/').pop();
        }
        return source;
    }

    /**
     * Where the active player's hitpoints and manapoints came from and went.
     *
     * The engine has always recorded this per unit per source — food, regen,
     * lifesteal, each healing ability — and nothing ever displayed it, so a
     * loadout that survives on food and one that survives on lifesteal looked
     * identical. Collapsed by default: it answers a question most runs do not
     * raise.
     * @param {Object} simResult - Merged SimResult
     * @param {number} hours - Simulated hours
     * @param {Object} gameData - Game data payload
     * @param {string} activeTab - Player hrid whose numbers are shown
     * @returns {string} HTML, or '' when the player neither healed nor spent
     * @private
     */
    _renderSustainBreakdown(simResult, hours, gameData, activeTab) {
        const groups = [
            { key: 'hitpointsGained', label: 'HP gained', color: '#7ec87e' },
            { key: 'manapointsGained', label: 'MP gained', color: '#93c5fd' },
            { key: 'hitpointsSpent', label: 'HP spent', color: '#ff6b6b' },
        ];

        const sections = [];
        for (const group of groups) {
            const bySource = simResult[group.key]?.[activeTab];
            if (!bySource) continue;

            const rows = Object.entries(bySource)
                .filter(([, amount]) => amount > 0)
                .map(([source, amount]) => ({ name: this._sustainSourceName(source, gameData), amount }))
                .sort((a, b) => b.amount - a.amount);
            if (rows.length === 0) continue;

            sections.push({ ...group, rows, total: rows.reduce((sum, row) => sum + row.amount, 0) });
        }

        if (sections.length === 0) return '';

        const rowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
        const colNum = 'flex:0; white-space:nowrap; min-width:70px; text-align:right;';
        const perHour = (amount) => (hours > 0 ? amount / hours : 0);
        const fmt = (value) => (value >= 1 ? formatWithSeparator(Math.round(value)) : value.toFixed(2));

        const headline = sections
            .map((section) => `${section.label} ${formatKMB(Math.round(perHour(section.total)))}/hr`)
            .join(' · ');

        let html = `<div style="margin-bottom:12px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; border-bottom:1px solid #222; padding-bottom:4px; cursor:pointer; user-select:none;" data-toggle="sustain-section">`;
        html += `<span data-arrow="sustain-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Healing &amp; Mana`;
        html += `<span style="color:#666; font-weight:400; font-size:10px; margin-left:6px;">${headline}</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-sustain-section" style="display:none;">`;

        for (const section of sections) {
            html += `<div style="color:#888; font-size:10px; margin:6px 0 2px;">${section.label}</div>`;
            html += `<div style="display:flex; align-items:center; padding:0 0 2px; font-size:10px; gap:6px; color:#666;">`;
            html += `<span style="flex:1;">Source</span>`;
            html += `<span style="${colNum}">/hr</span>`;
            html += `<span style="${colNum}">Total</span>`;
            html += '</div>';

            for (const row of section.rows) {
                html += `<div style="${rowStyle}">`;
                html += `<span style="color:#aaa; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${row.name}</span>`;
                html += `<span style="color:${section.color}; font-weight:600; ${colNum}">${fmt(perHour(row.amount))}</span>`;
                html += `<span style="color:#e0e0e0; font-weight:600; ${colNum}">${fmt(row.amount)}</span>`;
                html += '</div>';
            }

            html += `<div style="display:flex; align-items:center; padding:3px 0 0; font-size:12px; border-top:1px solid #333; margin-top:3px; gap:6px;">`;
            html += `<span style="color:#aaa; font-weight:700; flex:1;">Total</span>`;
            html += `<span style="color:${section.color}; font-weight:700; ${colNum}">${fmt(perHour(section.total))}</span>`;
            html += `<span style="color:#e0e0e0; font-weight:700; ${colNum}">${fmt(section.total)}</span>`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * Ensure all history entries have metrics for the active player tab.
     * Metrics are per-player — entries cached for a different tab are recomputed
     * from their own stored sim data so deltas and comparisons never mix players.
     * @private
     */
    _ensureHistoryMetrics(activeTab) {
        for (const entry of this._simHistory) {
            if (!entry.metrics || entry.metricsTab !== activeTab) {
                entry.metrics = this._computeMetrics(entry.simResult, entry.hours, entry.gameData, activeTab);
                entry.metricsTab = activeTab;
            }
        }
    }

    /**
     * Compute metrics for a sim result.
     * @private
     */
    _computeMetrics(simResult, hours, gameData, activeTab) {
        // Encounters
        const encountersPerHr = simResult.encounters / hours;

        // DPS from actual damage dealt
        const simSeconds = simResult.simulatedTime > 0 ? simResult.simulatedTime / 1e9 : hours * 3600;
        let totalDamage = 0;
        for (const [hrid, damage] of Object.entries(simResult.totalDamageDealt || {})) {
            if (hrid.startsWith('player')) totalDamage += damage;
        }
        const dps = simSeconds > 0 ? totalDamage / simSeconds : 0;

        // XP/hr for active player
        let totalXpPerHr = 0;
        if (simResult.experienceGained?.[activeTab]) {
            for (const amount of Object.values(simResult.experienceGained[activeTab])) {
                totalXpPerHr += Math.round(amount / hours);
            }
        }

        // Revenue from drops
        let revenuePerHr = 0;
        if (gameData) {
            const dropMap = calculateExpectedDrops(simResult, gameData, activeTab);
            for (const [itemHrid, total] of dropMap.entries()) {
                if (total <= 0) continue;
                const price = marketAPI.getPrice(itemHrid);
                let unitValue = taxedDropValue(itemHrid, this._getSellPrice(price));
                if (unitValue === 0 && itemHrid === '/items/coin') unitValue = 1;
                if (unitValue === 0) {
                    const evData = (expectedValueCalculator() || bundledExpectedValueCalculator).calculateExpectedValue(
                        itemHrid
                    );
                    if (evData?.expectedValue > 0) unitValue = evData.expectedValue;
                }
                revenuePerHr += (total / hours) * unitValue;
            }
        }

        // Expenses from consumables
        let consumableCostPerHr = 0;
        const selfConsumables = simResult.consumablesUsed?.[activeTab] || {};
        for (const [itemHrid, count] of Object.entries(selfConsumables)) {
            const price = marketAPI.getPrice(itemHrid);
            const unitCost = this._getBuyPrice(price);
            consumableCostPerHr += (count / hours) * unitCost;
        }

        // Dungeon key costs
        let keyCostPerHrMetric = 0;
        if (simResult.isDungeon && gameData) {
            const dropMap = calculateExpectedDrops(simResult, gameData, activeTab);
            const getBuyPriceForKey = (keyHrid) => {
                const price = marketAPI.getPrice(keyHrid);
                return this._getBuyPrice(price);
            };
            const keyCosts = calculateDungeonKeyCosts(dropMap, getBuyPriceForKey);
            for (const key of keyCosts) {
                keyCostPerHrMetric += (key.count / hours) * key.unitCost;
            }
        }

        const expensesPerHr = consumableCostPerHr + keyCostPerHrMetric;

        return {
            encountersPerHr,
            dps,
            totalXpPerHr,
            revenuePerHr,
            expensesPerHr,
            consumableCostPerHr,
            keyCostPerHr: keyCostPerHrMetric,
            profitPerHr: revenuePerHr - expensesPerHr,
            successRate: simResult.isDungeon
                ? simResult.dungeonsCompleted / Math.max(1, simResult.dungeonsCompleted + simResult.dungeonsFailed)
                : null,
        };
    }

    /**
     * Render the comparison panel with baseline + selected comparison sims.
     * @returns {string} HTML string
     * @private
     */
    /**
     * Throw away every saved run, along with the baseline and the comparison
     * picks that only mean anything relative to them.
     *
     * History is in-memory for the life of the panel — the same place the ✕ on
     * a row deletes from — so this is that delete applied to all of them, not a
     * second store. The results box is emptied rather than re-rendered: with no
     * runs left there is nothing it could honestly show, and leaving the last
     * one up would suggest the comparison it was drawn against still exists.
     * @private
     */
    _clearAllHistory() {
        if (this._simHistory.length === 0) return;

        this._simHistory = [];
        this._comparisonBaseline = null;
        this._comparisonIndex = null;
        this._comparisonSlots = [];
        this._activeDetailIndex = null;
        this._lastSimResult = null;
        this._lastSimHours = null;
        this._lastGameData = null;
        this._lastPartyWarnings = [];

        const container = this.panel?.querySelector('#mwi-csim-results');
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
        this._setStatus('Cleared all saved runs. Run a simulation to start a new comparison.');
    }

    /**
     * Delete a history entry by index and re-render results.
     * @param {number} idx - Index in _simHistory to remove
     * @private
     */
    _deleteHistoryEntry(idx) {
        if (idx < 0 || idx >= this._simHistory.length) return;

        this._simHistory.splice(idx, 1);

        // If only one or zero results remain, clear all comparison state
        if (this._simHistory.length <= 1) {
            this._comparisonBaseline = null;
            this._comparisonIndex = null;
            this._comparisonSlots = [];
        } else {
            // Adjust comparisonBaseline
            if (this._comparisonBaseline === idx) {
                this._comparisonBaseline = Math.max(0, this._simHistory.length - 1);
            } else if (this._comparisonBaseline !== null && this._comparisonBaseline > idx) {
                this._comparisonBaseline--;
            }

            // Adjust comparisonSlots
            this._comparisonSlots = this._comparisonSlots.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i));

            // Adjust comparisonIndex
            if (this._comparisonIndex === idx) {
                this._comparisonIndex = null;
            } else if (this._comparisonIndex !== null && this._comparisonIndex > idx) {
                this._comparisonIndex--;
            }
        }

        // Adjust activeDetailIndex
        if (this._activeDetailIndex === idx) {
            this._activeDetailIndex = this._simHistory.length > 0 ? this._simHistory.length - 1 : null;
        } else if (this._activeDetailIndex !== null && this._activeDetailIndex > idx) {
            this._activeDetailIndex--;
        }

        // If history is now empty, clear results display
        if (this._simHistory.length === 0) {
            this._lastSimResult = null;
            this._lastSimHours = null;
            this._lastGameData = null;
            this._lastPartyWarnings = [];
            const container = this.panel?.querySelector('#mwi-csim-results');
            if (container) container.style.display = 'none';
            return;
        }

        // Re-render with the active entry
        const activeEntry =
            this._activeDetailIndex !== null
                ? this._simHistory[this._activeDetailIndex]
                : this._simHistory[this._simHistory.length - 1];
        this._lastSimResult = activeEntry.simResult;
        this._lastSimHours = activeEntry.hours;
        this._lastGameData = activeEntry.gameData;
        this._displayResults(activeEntry.simResult, activeEntry.hours, activeEntry.gameData);
    }

    _renderHistoryPanel() {
        const history = this._simHistory;
        if (history.length < 2) return '';

        const baseIdx = this._comparisonBaseline ?? 0;
        const baseEntry = history[baseIdx];
        const baseM = baseEntry?.metrics;

        // Check if any sim is a dungeon
        const hasDungeon = history.some((e) => e.simResult?.isDungeon);

        let html = '<div style="margin-bottom:12px;">';
        html +=
            '<div style="color:' +
            ACCENT +
            '; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="history-section">';
        html +=
            '<span data-arrow="history-section" style="display:inline-block; width:14px; font-size:10px;">&#9660;</span> Comparison (' +
            history.length +
            ' runs)';
        html += '</div>';
        html += '<div id="mwi-csim-history-section" style="display:block;">';

        // Baseline selector
        html += '<div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:11px;">';
        html += '<span style="color:#888;">Baseline:</span>';
        html +=
            // min-width:0 so the select can shrink below its widest option: a
            // select's intrinsic width is its longest label, and one long saved
            // run pushed the whole row (buttons included) past the panel edge
            '<select class="toolasha-select" id="mwi-csim-baseline-select" style="flex:1 1 0; min-width:0; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:1px 4px; font-size:11px; font-family:inherit;">';
        for (let i = 0; i < history.length; i++) {
            const sel = i === baseIdx ? ' selected' : '';
            html += '<option value="' + i + '"' + sel + '>' + history[i].label + '</option>';
        }
        html += '</select>';
        html +=
            '<button id="mwi-csim-history-csv" style="background:#1a1a2e; color:#8ab4f8; border:1px solid #333; ' +
            'border-radius:3px; padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit; ' +
            'flex-shrink:0;">Export CSV</button>';
        // Deleting saved runs one ✕ at a time is the only way out of a full
        // history, and a run left behind keeps skewing every delta below
        html +=
            '<button id="mwi-csim-history-clear" title="Delete every saved run, baseline and comparison" ' +
            'style="background:#1a1a2e; color:#ff9a9a; border:1px solid #333; ' +
            'border-radius:3px; padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit; ' +
            'flex-shrink:0;">Clear all</button>';
        html += '</div>';

        // Table
        html += '<table style="width:100%; font-size:11px; border-collapse:collapse;">';
        html += '<tr style="border-bottom:1px solid #333; color:#666;">';
        html += '<th style="text-align:left; padding:2px 4px;">Scenario</th>';
        html += '<th style="text-align:right; padding:2px 4px;">EPH</th>';
        html += '<th style="text-align:right; padding:2px 4px;">DPS</th>';
        html += '<th style="text-align:right; padding:2px 4px;">Profit/hr</th>';
        html += '<th style="text-align:right; padding:2px 4px;">XP/hr</th>';
        if (hasDungeon) html += '<th style="text-align:right; padding:2px 4px;">Success</th>';
        html += '<th style="width:20px;"></th>';
        html += '<th style="width:20px;"></th>';
        html += '</tr>';

        // Baseline row
        const baseProfitColor = baseM?.profitPerHr >= 0 ? '#7ec87e' : '#ff6b6b';
        html += '<tr style="background:rgba(232,168,124,0.08); cursor:pointer;" data-history-idx="' + baseIdx + '">';
        html +=
            '<td style="padding:2px 4px; color:#e8a87c; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' +
            baseEntry.label +
            '">★ ' +
            baseEntry.label +
            '</td>';
        html +=
            '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
            (baseM ? formatWithSeparator(Math.round(baseM.encountersPerHr)) : '—') +
            '</td>';
        html +=
            '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
            (baseM ? formatWithSeparator(Math.round(baseM.dps)) : '—') +
            '</td>';
        html +=
            '<td style="text-align:right; padding:2px 4px; color:' +
            baseProfitColor +
            ';">' +
            (baseM ? formatKMB(Math.round(baseM.profitPerHr)) : '—') +
            '</td>';
        html +=
            '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
            (baseM ? formatWithSeparator(Math.round(baseM.totalXpPerHr)) : '—') +
            '</td>';
        if (hasDungeon) {
            html +=
                '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
                (baseM?.successRate != null ? (baseM.successRate * 100).toFixed(1) + '%' : '—') +
                '</td>';
        }
        html += '<td></td>';
        html +=
            '<td style="text-align:center; padding:2px; cursor:pointer; color:#555;" data-delete-history="' +
            baseIdx +
            '" title="Delete result">✕</td>';
        html += '</tr>';
        for (const idx of this._comparisonSlots) {
            if (idx === baseIdx || idx >= history.length) continue;
            const entry = history[idx];
            const m = entry.metrics;
            const profitColor = m?.profitPerHr >= 0 ? '#7ec87e' : '#ff6b6b';

            const ephDelta = baseM && m ? this._formatDelta(m.encountersPerHr, baseM.encountersPerHr, true) : '';
            const dpsDelta = baseM && m ? this._formatDelta(m.dps, baseM.dps, true) : '';
            const profitDelta = baseM && m ? this._formatDelta(m.profitPerHr, baseM.profitPerHr, true, true) : '';
            const xpDelta = baseM && m ? this._formatDelta(m.totalXpPerHr, baseM.totalXpPerHr, true) : '';

            html += '<tr style="cursor:pointer;" data-history-idx="' + idx + '">';
            html +=
                '<td style="padding:2px 4px; color:#ccc; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' +
                entry.label +
                '">' +
                entry.label +
                '</td>';
            html +=
                '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
                (m ? formatWithSeparator(Math.round(m.encountersPerHr)) : '—') +
                ephDelta +
                '</td>';
            html +=
                '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
                (m ? formatWithSeparator(Math.round(m.dps)) : '—') +
                dpsDelta +
                '</td>';
            html +=
                '<td style="text-align:right; padding:2px 4px; color:' +
                profitColor +
                ';">' +
                (m ? formatKMB(Math.round(m.profitPerHr)) : '—') +
                profitDelta +
                '</td>';
            html +=
                '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
                (m ? formatWithSeparator(Math.round(m.totalXpPerHr)) : '—') +
                xpDelta +
                '</td>';
            if (hasDungeon) {
                const successDelta =
                    baseM?.successRate != null && m?.successRate != null
                        ? this._formatDelta(m.successRate * 100, baseM.successRate * 100, true)
                        : '';
                html +=
                    '<td style="text-align:right; padding:2px 4px; color:#e0e0e0;">' +
                    (m?.successRate != null ? (m.successRate * 100).toFixed(1) + '%' : '—') +
                    successDelta +
                    '</td>';
            }
            html +=
                '<td style="text-align:center; padding:2px; cursor:pointer; color:#666;" data-remove-comparison="' +
                idx +
                '" title="Remove from comparison">×</td>';
            html +=
                '<td style="text-align:center; padding:2px; cursor:pointer; color:#555;" data-delete-history="' +
                idx +
                '" title="Delete result">✕</td>';
            html += '</tr>';
        }

        html += '</table>';

        // Add to comparison dropdown
        const available = [];
        for (let i = 0; i < history.length; i++) {
            if (i === baseIdx || this._comparisonSlots.includes(i)) continue;
            available.push(i);
        }
        if (available.length > 0) {
            html += '<div style="margin-top:6px;">';
            html +=
                '<select class="toolasha-select" id="mwi-csim-add-comparison" style="width:100%; background:#1a1a2e; color:#aaa; border:1px solid #444; border-radius:4px; padding:2px 4px; font-size:11px; font-family:inherit;">';
            html += '<option value="">+ Add sim to comparison...</option>';
            for (const i of available) {
                html += '<option value="' + i + '">' + history[i].label + '</option>';
            }
            html += '</select></div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * Format a delta value as colored HTML span.
     * Returns empty string if no previous value or delta is zero.
     * @param {number} current - Current value
     * @param {number|null} previous - Previous value (null if no comparison)
     * @param {boolean} [higherIsBetter=true] - Whether higher values are positive
     * @param {boolean} [useKMB=false] - Use KMB formatting for the delta
     * @returns {string} HTML span or empty string
     * @private
     */
    _formatDelta(current, previous, higherIsBetter = true, useKMB = false) {
        if (previous === null || previous === undefined) return '';
        const delta = current - previous;
        if (Math.abs(delta) < 0.5) return '';
        const isPositive = higherIsBetter ? delta > 0 : delta < 0;
        const color = isPositive ? '#7ec87e' : '#ff6b6b';
        const sign = delta > 0 ? '+' : '';
        const formatted = useKMB ? formatKMB(Math.round(delta)) : formatWithSeparator(Math.round(delta));
        return ` <span style="color:${color}; font-size:11px;">(${sign}${formatted})</span>`;
    }

    /**
     * Format the Overview's Deaths/hr, always to three decimals.
     *
     * Rounding an hourly rate to an integer collapses 0.042 and 1.4 deaths/hr
     * onto "0" and "1", and the difference between them is the whole story of
     * how safe a build is. Three fixed decimals is the same treatment the drop
     * table gives its fractional items/hr rates, and keeping the width constant
     * means two builds can be compared digit by digit.
     *
     * The Summary tile uses this too. It used to read per day with variable
     * precision, to dodge that rounding; three decimals answers the same
     * objection without making one tile the odd unit out.
     *
     * @param {number} value - Deaths per hour
     * @returns {string} e.g. "0.042", "1.000"
     * @private
     */
    _formatDeathsPerHour(value) {
        if (!Number.isFinite(value)) return '0.000';
        return value.toFixed(3);
    }

    /**
     * Format a rate value with one decimal place.
     * @param {number} value
     * @returns {string}
     * @private
     */
    _formatRate(value) {
        if (value === 0) return '0';
        if (value < 0.1) return value.toFixed(2);
        return (Math.round(value * 10) / 10).toString();
    }

    /**
     * Set the status bar text.
     * @param {string} text
     * @private
     */
    _setStatus(text) {
        const status = this.panel?.querySelector('#mwi-csim-status');
        if (status) status.textContent = text;
    }

    /**
     * Show a temporary warning toast overlaid on the panel.
     * @param {string} text - Warning message
     * @param {number} [duration=3000] - Duration in ms before auto-dismiss
     * @private
     */
    _showWarning(text, duration = 3000) {
        // Remove existing warning
        this.panel?.querySelector('.mwi-csim-warning')?.remove();

        const toast = document.createElement('div');
        toast.className = 'mwi-csim-warning';
        toast.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(30, 20, 10, 0.97);
            border: 1px solid rgba(255, 152, 0, 0.6);
            border-radius: 8px;
            padding: 12px 20px;
            color: #ffb74d;
            font-size: 13px;
            font-weight: 600;
            text-align: center;
            z-index: 10;
            max-width: 80%;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            animation: mwi-csim-fade-in 0.15s ease;
        `;
        toast.textContent = text;
        this.panel.appendChild(toast);

        setTimeout(() => {
            toast.style.transition = 'opacity 0.3s ease';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    /**
     * Let the panel be dragged by its header, remembering where it is dropped.
     *
     * The shared helper rather than a local copy: it carries the click-vs-drag
     * guard (a press on the header that never moved is not a move worth saving)
     * and the pointer/touch handling the bespoke version here had drifted from.
     *
     * @param {HTMLElement} header - The bar you grab
     * @private
     */
    _setupDrag(header) {
        this._detachDrag?.();
        this._detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
    }

    /**
     * @private
     */
    _setupResize(handle, mode = 'se') {
        handle.style.touchAction = 'none';
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = this.panel.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            const { width: startWidth, height: startHeight, right: startRight } = rect;
            bringPanelToFront(this.panel);

            // The panel opens anchored to its right edge, which makes a widening
            // drag push the *opposite* side across the screen. Pin it by the left
            // edge before resizing so each grip moves the side you grabbed.
            this.panel.style.left = `${rect.left}px`;
            this.panel.style.right = 'auto';

            // Without this, dragging over the page selects text instead of resizing
            const priorSelect = document.body.style.userSelect;
            document.body.style.userSelect = 'none';

            const onMove = (ev) => {
                if (mode.includes('e')) {
                    this.panel.style.width = `${Math.max(MIN_PANEL_WIDTH, startWidth + (ev.clientX - startX))}px`;
                }
                if (mode.includes('w')) {
                    const width = Math.max(MIN_PANEL_WIDTH, startWidth - (ev.clientX - startX));
                    this.panel.style.width = `${width}px`;
                    // Hold the right edge still while the left one follows the cursor
                    this.panel.style.left = `${startRight - width}px`;
                }
                if (mode.includes('s')) {
                    this.panel.style.height = `${Math.max(MIN_PANEL_HEIGHT, startHeight + (ev.clientY - startY))}px`;
                }
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = priorSelect;
                this._persistPanelGeometry();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    /**
     * Remember the panel's size, and its left edge with it.
     *
     * The west and south-west grips move the left edge as they resize, so saving
     * the size alone would put the panel back at a width it never had at that
     * position — it would appear to jump sideways on the next open.
     *
     * @private
     */
    _persistPanelGeometry() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        saveGeometry(GEOMETRY_KEY, {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
        });
    }

    /**
     * Put the panel back where and how it was left.
     *
     * Clamping lives in `panel-geometry.js`, so a size or position saved on a
     * larger monitor cannot open the panel somewhere it can neither be reached
     * nor resized back.
     *
     * @private
     */
    _restorePanelGeometry() {
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT });
    }

    /**
     * Open the sim panel pre-loaded with an external player DTO.
     * Used by the profile page "Sim Character" button.
     * @param {Object} dto - Player DTO in sim engine format
     * @param {string} playerName - Display name for the player tab
     */
    openWithExternalDTO(dto, playerName) {
        if (!this.panel) {
            this.buildPanel();
        }

        this._editor.openWithExternalDTO(dto, playerName);

        this.show();
        this._switchTab('configure');
    }

    /**
     * Open the panel.
     *
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (!this.panel) return;
        if (remember) saveOpenState(GEOMETRY_KEY, true);

        this.panel.style.display = 'flex';
        bringPanelToFront(this.panel);
        this.populateZones();
        if (!this._editor.isInitialized()) {
            this._editor.initEditor();
        }
    }

    /** @param {Object} [options] - `remember: false` to close without forgetting it was open */
    hide({ remember = true } = {}) {
        if (!this.panel) return;
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this.panel.style.display = 'none';
    }

    /**
     * Toggle panel visibility.
     */
    toggle() {
        if (!this.panel) return;
        if (this.panel.style.display !== 'none') this.hide();
        else this.show();
    }

    /**
     * Reopen if the page was left with this panel up.
     *
     * The waiting is `panel-geometry.js`'s: the answer lives in IndexedDB, which
     * is not open yet when the panel is built.
     */
    restore() {
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /**
     * Remove the panel and clean up.
     */
    destroy() {
        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
        this._detachDrag?.();
        this._detachDrag = null;
        cleanupUpgradeMarketAutofill();
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
        this.isRunning = false;
        this._upgradeRunning = false;

        // Clear cached character data so next open loads fresh state
        if (this._editor) this._editor.reset();
        // Which party slot the results are being read for is that party's, and
        // the next open is a fresh one — a slot left pointing at the party that
        // has gone is read by All Zones and Seek as the character to measure,
        // and a hrid nobody in the new party has reads as no experience and no
        // deaths at all
        this._activePlayerTab = 'player1';
        this._lastSimResult = null;
        this._lastSimHours = null;
        this._lastGameData = null;
        this._lastPartyWarnings = [];
        // `_restoreUpgradeResults` refuses to draw over a result set that is
        // already in hand, and a character switch tears the panel down and
        // rebuilds it. Left set, the departing character's results kept the
        // arriving character's own remembered analysis from ever restoring —
        // silently, and for the rest of the session.
        this._upgradeResultsData = null;
        this._restoredUpgradeAt = null;
        this._restoredUpgradeMeta = null;
        this._simHistory = [];
        this._comparisonIndex = null;
        this._comparisonBaseline = null;
        this._comparisonSlots = [];
        this._activeDetailIndex = null;
        this._allZonesResults = null;
        this._allZonesMaxTierFood = false;
        this._allZonesFoodSwaps = [];
        this._seekResults = null;
        this._bestiaryPlanActive = false;
        this._bestiaryPlanZones = null;
        if (this._bestiaryListener) {
            dataManager.off?.('monsters_updated', this._bestiaryListener);
            this._bestiaryListener = null;
        }
    }

    /**
     * Get the sell price for an item based on the global pricing mode.
     * @param {Object} priceData - { bid, ask } from marketAPI
     * @returns {number}
     * @private
     */
    _getSellPrice(priceData) {
        if (!priceData) return 0;
        const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        // conservative/patientBuy → bid; hybrid/optimistic → ask
        if (mode === 'conservative' || mode === 'patientBuy') {
            return priceData.bid > 0 ? priceData.bid : 0;
        }
        return priceData.ask > 0 ? priceData.ask : 0;
    }

    /**
     * Get the buy price for an item based on the global pricing mode.
     * @param {Object} priceData - { bid, ask } from marketAPI
     * @returns {number}
     * @private
     */
    _getBuyPrice(priceData) {
        if (!priceData) return 0;
        const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        // optimistic/patientBuy → bid; conservative/hybrid → ask
        if (mode === 'optimistic' || mode === 'patientBuy') {
            return priceData.bid > 0 ? priceData.bid : 0;
        }
        return priceData.ask > 0 ? priceData.ask : 0;
    }

    /**
     * Populate the player selector dropdown in the Upgrade tab.
     * @private
     */
    _populateUpgradePlayerSelector() {
        const select = this.panel?.querySelector('#mwi-csim-upgrade-player');
        if (!select) return;

        const playerInfo = this._editor?.getPlayerInfo() || [];
        select.innerHTML = '';
        playerInfo.forEach((p, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = p.name || `Player ${i + 1}`;
            select.appendChild(option);
        });

        if (playerInfo.length === 0) {
            const option = document.createElement('option');
            option.value = 0;
            option.textContent = 'Player 1';
            select.appendChild(option);
        }
    }

    /**
     * Set default ability target level input to increment mode with value 5.
     * @private
     */
    /**
     * Populate the charm selector for Combat Levels mode with the charm tiers
     * found in game data (charm names follow "<Tier> <Skill> Charm"). The
     * selection controls which charm family gets swapped in per skill when
     * estimating leveling time: Auto matches the equipped charm's tier, a
     * named tier forces that family, None estimates without any charm.
     * @private
     */
    _populateCharmSelect() {
        const select = this.panel.querySelector('#mwi-csim-charm-select');
        if (!select || select.options.length > 0) return;

        const tiers = new Map(); // tier prefix → lowest charm itemLevel (for sorting)
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
        for (const item of Object.values(itemDetailMap)) {
            if (item?.equipmentDetail?.type !== '/equipment_types/charm') continue;
            const focus = item.equipmentDetail.combatStats?.focusTraining;
            if (!focus || !item.name) continue;
            const skillWord = focus.split('/').pop();
            const suffix = new RegExp(` ${skillWord} charm$`, 'i');
            const tier = suffix.test(item.name) ? item.name.replace(suffix, '') : item.name.split(' ')[0];
            if (!tier) continue;
            const level = item.itemLevel || 0;
            if (!tiers.has(tier) || level < tiers.get(tier)) {
                tiers.set(tier, level);
            }
        }

        const addOption = (value, label) => {
            const el = document.createElement('option');
            el.value = value;
            el.textContent = label;
            select.appendChild(el);
        };

        addOption('auto', 'Auto (equipped)');
        [...tiers.entries()].sort((a, b) => a[1] - b[1]).forEach(([tier]) => addOption(tier, tier));
        addOption('none', 'No charm');
    }

    /**
     * Prefill the per-skill target inputs from the selected player's current
     * levels plus the +Levels boost.
     * @private
     */
    _prefillCombatTargets() {
        const playerIndex = parseInt(this.panel.querySelector('#mwi-csim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const boost = parseInt(this.panel.querySelector('#mwi-csim-upgrade-target-level')?.value) || 5;

        // Hide skills the weapon style can't train (matches candidate filtering)
        const gameData = buildGameDataPayload();
        const excluded = dto && gameData ? getStyleExcludedSkills(dto, gameData) : new Set();

        this.panel.querySelectorAll('[data-combat-target]').forEach((input) => {
            const isExcluded = excluded.has(input.dataset.combatTarget);
            const wrapper = input.closest('span');
            if (wrapper) wrapper.style.display = isExcluded ? 'none' : 'inline-flex';
            if (isExcluded) {
                input.value = '';
                return;
            }
            const current = Math.max(1, Math.floor(dto?.[input.dataset.combatTarget] || 1));
            input.value = Math.min(200, current + boost);
        });
    }

    /**
     * Read the per-skill target map when the targets grid is open.
     * @private
     * @returns {Object|null} {skillKey: targetLevel} or null when not in use
     */
    _getCombatLevelTargets() {
        const grid = this.panel.querySelector('#mwi-csim-combat-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-combat-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.combatTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Rebuild and prefill the per-ability target inputs from the selected
     * player's equipped abilities (current level + the +Levels boost).
     * @private
     */
    _prefillAbilityTargets(grid, playerSelector, levelSelector) {
        const playerIndex = parseInt(this.panel.querySelector(playerSelector)?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const abilities = (dto?.abilities || []).filter(Boolean);
        const boost = parseInt(this.panel.querySelector(levelSelector)?.value) || 5;
        const gameData = buildGameDataPayload();

        if (!abilities.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No abilities equipped — configure a simulation first.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>Ability Lv</b> target levels (blank or ≤ current level skips the ability; used instead of the +Levels boost while open):</span>' +
            abilities
                .map((ability) => {
                    const name = gameData?.abilityDetailMap?.[ability.hrid]?.name || ability.hrid.split('/').pop();
                    const target = Math.min(200, (ability.level || 1) + boost);
                    return `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${name} (${ability.level})</label>
                    <input type="number" min="1" max="200" data-ability-target="${ability.hrid}" value="${target}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`;
                })
                .join('');
    }

    /**
     * Read the per-ability target map when the grid is open.
     * @private
     * @returns {Object|null} {abilityHrid: targetLevel} or null when not in use
     */
    _getAbilityTargets(gridSelector) {
        const grid = this.panel.querySelector(gridSelector);
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-ability-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.abilityTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    _setDefaultAbilityTargetLevel() {
        const typeSelect = this.panel.querySelector('#mwi-csim-upgrade-level-type');
        const input = this.panel.querySelector('#mwi-csim-upgrade-target-level');
        if (!input) return;
        if (typeSelect) typeSelect.value = 'increment';
        input.value = '5';
        input.placeholder = '+5';
        input.title = 'Number of levels to add to each ability';
    }

    /**
     * Candidate sets currently checked on the Upgrade tab.
     * @returns {string[]}
     * @private
     */
    _getUpgradeModes() {
        return [...this.panel.querySelectorAll('[data-upgrade-mode]')]
            .filter((box) => box.checked)
            .map((box) => box.getAttribute('data-upgrade-mode'));
    }

    /**
     * Show only the controls the checked candidate sets actually use.
     * @private
     */
    _onUpgradeModesChanged() {
        const modes = new Set(this._getUpgradeModes());
        const levelType = this.panel.querySelector('#mwi-csim-upgrade-level-type');
        const levelInput = this.panel.querySelector('#mwi-csim-upgrade-target-level');

        const isLevelMode = modes.has('ability_level');
        const isCombatLevelMode = modes.has('combat_level');

        // Light up the chip of each checked set and reveal the options it owns, so
        // it reads as "these controls belong to this checkbox"
        this.panel.querySelectorAll('[data-mode-chip]').forEach((chip) => {
            const on = modes.has(chip.getAttribute('data-mode-chip'));
            chip.style.borderColor = on ? ACCENT_BTN_BORDER : '#2a2a4a';
            chip.style.background = on ? ACCENT_BG : 'transparent';
            const label = chip.querySelector('label');
            if (label) label.style.color = on ? '#e0e0e0' : '#888';
        });
        this.panel.querySelectorAll('[data-mode-options]').forEach((group) => {
            group.style.display = modes.has(group.getAttribute('data-mode-options')) ? 'inline-flex' : 'none';
        });

        // Combat Levels borrows the Ability Lv boost box when Ability Lv is off,
        // since one number drives both; show that chip's options in either case
        const levelGroup = this.panel.querySelector('#mwi-csim-upgrade-level-group');
        if (levelGroup) {
            levelGroup.style.display = isLevelMode || isCombatLevelMode ? 'inline-flex' : 'none';
        }
        levelType.style.display = isLevelMode ? '' : 'none';
        levelInput.title =
            isLevelMode && isCombatLevelMode
                ? 'Levels added to each ability and each combat skill'
                : isCombatLevelMode
                  ? 'Levels added to each combat skill'
                  : 'Number of levels to add to each ability';
        if (isCombatLevelMode && !parseInt(levelInput.value)) {
            levelInput.value = '5';
            levelInput.placeholder = '+5';
        }

        if (isCombatLevelMode) {
            this._populateCharmSelect();
        } else {
            this.panel.querySelector('#mwi-csim-combat-targets').style.display = 'none';
        }

        // Per-ability targets only apply to ability-level candidates
        const abilityTargetsToggle = this.panel.querySelector('#mwi-csim-ability-targets-toggle');
        if (abilityTargetsToggle) abilityTargetsToggle.style.display = isLevelMode ? '' : 'none';
        if (!isLevelMode) {
            this.panel.querySelector('#mwi-csim-ability-targets').style.display = 'none';
        } else {
            this._setDefaultAbilityTargetLevel();
        }

        if (!modes.has('house')) {
            this.panel.querySelector('#mwi-csim-house-targets').style.display = 'none';
        }

        if (!modes.has('guild_shrine')) {
            this.panel.querySelector('#mwi-csim-shrine-targets').style.display = 'none';
        }
    }

    /**
     * Build the per-room house target inputs from the combat-relevant rooms in
     * game data, prefilled to the uniform House Lv value (or one level up).
     * @private
     */
    _buildHouseTargets() {
        const grid = this.panel.querySelector('#mwi-csim-house-targets');
        if (!grid) return;

        const roomMap = dataManager.getInitClientData()?.houseRoomDetailMap || {};
        const playerIndex = parseInt(this.panel.querySelector('#mwi-csim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(
            8,
            Math.max(0, parseInt(this.panel.querySelector('#mwi-csim-house-target-level')?.value) || 0)
        );

        const rooms = Object.entries(roomMap)
            .filter(([, detail]) => houseRoomAffectsCombat(detail))
            .map(([hrid, detail]) => ({
                hrid,
                name: detail.name || hrid.split('/').pop().replace(/_/g, ' '),
                // A loaded DTO's house rooms are sparse — only rooms actually built
                // appear in it — so a missing key here means level 0, not "look it
                // up". Falling through to dataManager for a missing key would read
                // the *live* character's own room level onto whichever player is
                // selected, which is wrong for anyone but them (an imported profile,
                // a party member). dataManager is only consulted before any DTO has
                // loaded at all, when there is nothing else to show.
                level: Math.max(
                    0,
                    Math.floor(Number(dto ? dto.houseRooms?.[hrid] || 0 : dataManager.getHouseRoomLevel?.(hrid)) || 0)
                ),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (rooms.length === 0) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No combat-relevant house rooms found in game data.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>House</b> target levels (blank or ≤ current level skips the room; used instead of the Lv value while open):</span>' +
            rooms
                .map(
                    (room) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${room.name} (${room.level})</label>
                    <input type="number" min="1" max="8" data-house-target="${room.hrid}"
                        value="${room.level >= 8 ? '' : Math.min(8, Math.max(uniform, room.level + 1))}"
                        ${room.level >= 8 ? 'disabled title="Already at max level"' : ''} style="
                        width:44px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Per-room house target levels, or null when the grid is closed.
     * @returns {Object|null} roomHrid → target level
     * @private
     */
    _getHouseTargets() {
        const grid = this.panel.querySelector('#mwi-csim-house-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-house-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.houseTarget] = Math.min(8, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Build the per-shrine target inputs from the combat guild shrines in game
     * data, prefilled to the uniform shrine Lv value (or one level up).
     *
     * Mirrors `_buildHouseTargets`: combat shrines only (this tab ranks combat
     * outcomes, and a skilling shrine has no column it could move), each capped
     * at its own maximum, a shrine already at its max shown disabled.
     * @private
     */
    _buildShrineTargets() {
        const grid = this.panel.querySelector('#mwi-csim-shrine-targets');
        if (!grid) return;

        const detailMap = getGuildBuffDetailMap();
        const playerIndex = parseInt(this.panel.querySelector('#mwi-csim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(
            MAX_GUILD_SHRINE_LEVEL,
            Math.max(0, parseInt(this.panel.querySelector('#mwi-csim-shrine-target-level')?.value) || 0)
        );

        const shrines = Object.entries(detailMap)
            .filter(([, detail]) => Boolean(detail?.isCombat))
            .map(([buffHrid, detail]) => ({
                buffHrid,
                name: shrineName(detail.shrineHrid || buffHrid),
                level: Math.max(0, Math.floor(Number(dto?.guildShrineLevels?.[buffHrid]) || 0)),
                maxLevel: Math.min(MAX_GUILD_SHRINE_LEVEL, guildBuffMaxLevel(detail) || MAX_GUILD_SHRINE_LEVEL),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (shrines.length === 0) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No combat guild shrine reached the client — join a ' +
                'guild, or open the shrine screen once, so the levels are known.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>Guild Shrine</b> target levels (blank ' +
            'or ≤ current level evaluates one level up; <b>0 skips the shrine</b>; used instead of the Lv ' +
            'value while open):</span>' +
            shrines
                .map(
                    (shrine) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${shrine.name} (${shrine.level})</label>
                    <input type="number" min="0" max="${shrine.maxLevel}" data-shrine-target="${shrine.buffHrid}"
                        value="${
                            shrine.level >= shrine.maxLevel
                                ? ''
                                : Math.min(shrine.maxLevel, Math.max(uniform, shrine.level + 1))
                        }"
                        ${shrine.level >= shrine.maxLevel ? 'disabled title="Already at max level"' : ''} style="
                        width:44px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Per-shrine target levels, or null when the grid is closed.
     *
     * Three readings, matching what `generateGuildShrineCandidates` documents:
     * a level buys up to it, an explicit **0 drops that shrine** from the run,
     * and a blank box sends -1 for "one level up" — blank used to drop the
     * shrine too, which left no way to say "not this one" that a habit of
     * clearing boxes could not trip over.
     *
     * A box disabled because the buff is already maxed is left out of the map
     * entirely, which the advisor also reads as a skip.
     *
     * @returns {Object|null} buffHrid → target level
     * @private
     */
    _getShrineTargets() {
        const grid = this.panel.querySelector('#mwi-csim-shrine-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-shrine-target]').forEach((input) => {
            if (input.disabled) return;
            const value = parseInt(input.value);
            if (!Number.isFinite(value)) {
                targets[input.dataset.shrineTarget] = -1;
            } else if (value <= 0) {
                targets[input.dataset.shrineTarget] = 0;
            } else {
                targets[input.dataset.shrineTarget] = Math.min(MAX_GUILD_SHRINE_LEVEL, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Persist the checked candidate sets so the next Analyze starts where you left off.
     * @private
     */
    async _saveUpgradeModes() {
        try {
            await writeScoped(UPGRADE_MODES_KEY, this._getUpgradeModes());
        } catch (error) {
            console.error('[CombatSimUI] Failed to save upgrade modes:', error);
        }
    }

    /**
     * Restore the remembered candidate sets, leaving the defaults in place when
     * nothing has been saved yet.
     * @private
     */
    async _restoreUpgradeModes() {
        try {
            const saved = await readScoped(UPGRADE_MODES_KEY, 'settings', null);
            if (Array.isArray(saved) && saved.length > 0) {
                const wanted = new Set(saved);
                this.panel?.querySelectorAll('[data-upgrade-mode]').forEach((box) => {
                    box.checked = wanted.has(box.getAttribute('data-upgrade-mode'));
                });
            }
        } catch (error) {
            console.error('[CombatSimUI] Failed to restore upgrade modes:', error);
        }
        this._onUpgradeModesChanged();
    }

    /**
     * Persist the Ability Swaps "Aura only" sub-option.
     * @private
     */
    async _saveSwapAuraOnly() {
        try {
            const box = this.panel?.querySelector('#mwi-csim-swap-aura-only');
            await writeScoped(SWAP_AURA_ONLY_KEY, Boolean(box?.checked));
        } catch (error) {
            console.error('[CombatSimUI] Failed to save the signature-swap option:', error);
        }
    }

    /**
     * Restore the remembered "Aura only" sub-option.
     * @private
     */
    async _restoreSwapAuraOnly() {
        try {
            const saved = await readScoped(SWAP_AURA_ONLY_KEY, 'settings', false);
            const box = this.panel?.querySelector('#mwi-csim-swap-aura-only');
            if (box) box.checked = Boolean(saved);
        } catch (error) {
            console.error('[CombatSimUI] Failed to restore the signature-swap option:', error);
        }
    }

    /**
     * Persist the Guild Shrine "Guild-allowed only" sub-option.
     * @private
     */
    async _saveShrineCapToGuild() {
        try {
            const box = this.panel?.querySelector('#mwi-csim-shrine-cap-guild');
            await writeScoped(SHRINE_CAP_GUILD_KEY, Boolean(box?.checked));
        } catch (error) {
            console.error('[CombatSimUI] Failed to save the shrine cap option:', error);
        }
    }

    /**
     * Restore the remembered "Guild-allowed only" sub-option, which defaults on:
     * a shrine level the guild cannot sell is not an upgrade anyone can buy.
     * @private
     */
    async _restoreShrineCapToGuild() {
        try {
            const saved = await readScoped(SHRINE_CAP_GUILD_KEY, 'settings', true);
            const box = this.panel?.querySelector('#mwi-csim-shrine-cap-guild');
            if (box) box.checked = Boolean(saved);
        } catch (error) {
            console.error('[CombatSimUI] Failed to restore the shrine cap option:', error);
        }
    }

    /**
     * Run upgrade analysis when Analyze button is clicked.
     * @private
     */
    async _onUpgradeAnalyze() {
        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();
        const zoneHrid = this.panel.querySelector('#mwi-csim-zone')?.value;
        const difficultyTier = parseInt(this.panel.querySelector('#mwi-csim-tier')?.value) || 0;
        const hours = Math.min(
            10000,
            Math.max(
                1,
                parseInt(this.panel.querySelector('#mwi-csim-hours')?.value) ||
                    config.getSettingValue('combatSim_defaultHours', 100)
            )
        );
        const playerIndex = parseInt(this.panel.querySelector('#mwi-csim-upgrade-player')?.value) || 0;
        const upgradeModes = this._getUpgradeModes();
        const abilityLevelType = this.panel.querySelector('#mwi-csim-upgrade-level-type')?.value || 'increment';
        let abilityTargetLevel = Math.min(
            200,
            parseInt(this.panel.querySelector('#mwi-csim-upgrade-target-level')?.value) || 0
        );
        let charmTier = null;
        let charmEnhancement = null;
        if (upgradeModes.includes('combat_level')) {
            if (!abilityTargetLevel) abilityTargetLevel = 5;
            charmTier = this.panel.querySelector('#mwi-csim-charm-select')?.value || 'auto';
            const enhRaw = this.panel.querySelector('#mwi-csim-charm-enh')?.value;
            charmEnhancement =
                enhRaw === '' || enhRaw === undefined ? null : Math.max(0, Math.min(20, parseInt(enhRaw) || 0));
        }

        if (!upgradeModes.length) {
            this._setStatus('Check at least one upgrade type to include.');
            return;
        }

        if (!zoneHrid) {
            this._setStatus('Select a zone in Configure tab first.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        // Get player DTOs (edited or live)
        let playerDTOs;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
        }

        if (!playerDTOs?.length || !playerDTOs[playerIndex]) {
            this._setStatus('No player data available. Configure a simulation first.');
            return;
        }

        // Show progress, hide results
        const progressEl = this.panel.querySelector('#mwi-csim-upgrade-progress');
        const resultsEl = this.panel.querySelector('#mwi-csim-upgrade-results');
        const runBtn = this.panel.querySelector('#mwi-csim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-csim-upgrade-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        // A new run replaces the table the menu was configuring, so the menu
        // goes with it rather than reappearing over the results that arrive
        this._setUpgradeColumnMenuOpen(false);
        runBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._upgradeAborted = false;
        this._upgradeRunning = true;
        // One tracker per run: it starts its clock where it is made
        const eta = createEtaTracker();

        try {
            // Reading the buffs can throw on unexpected game data, and outside the
            // try that left the progress bar up and the Stop button stuck forever
            const communityBuffs = getCommunityBuffs();
            const skipBackSlot = this.panel.querySelector('#mwi-csim-upgrade-skip-back')?.checked || false;
            const isHouseMode = upgradeModes.includes('house');
            const houseTargetLevel = isHouseMode
                ? Math.min(
                      8,
                      Math.max(0, parseInt(this.panel.querySelector('#mwi-csim-house-target-level')?.value) || 0)
                  )
                : 0;
            const houseTargets = isHouseMode ? this._getHouseTargets() : null;
            // Blank means "one level up", which is what the advisor reads a 0 as
            const guildShrineTargetLevel = upgradeModes.includes('guild_shrine')
                ? Math.max(0, parseInt(this.panel.querySelector('#mwi-csim-shrine-target-level')?.value) || 0)
                : 0;
            // Per-shrine grid, when open, overrides the uniform Lv above — the
            // advisor's `guildShrineTargets` takes precedence over the single
            // number, exactly as the House grid overrides the House Lv value
            const guildShrineTargets = upgradeModes.includes('guild_shrine') ? this._getShrineTargets() : null;
            // Default on: a level the guild's shrine building cannot sell is not
            // an upgrade the character can buy, however well it would rank
            const guildShrineCapToGuild =
                upgradeModes.includes('guild_shrine') &&
                Boolean(this.panel.querySelector('#mwi-csim-shrine-cap-guild')?.checked);
            // Blank means one level up here too — and a level is not a purchase
            // either way, so this only changes what gets simulated
            const communityBuffTargetLevel = upgradeModes.includes('community_buff')
                ? Math.min(
                      20,
                      Math.max(0, parseInt(this.panel.querySelector('#mwi-csim-community-target-level')?.value) || 0)
                  )
                : 0;
            const combatLevelTargets = upgradeModes.includes('combat_level') ? this._getCombatLevelTargets() : null;
            const abilityTargets = upgradeModes.includes('ability_level')
                ? this._getAbilityTargets('#mwi-csim-ability-targets')
                : null;
            const auraSwapsOnly =
                upgradeModes.includes('ability_swap') &&
                Boolean(this.panel.querySelector('#mwi-csim-swap-aura-only')?.checked);
            const results = await runUpgradeAnalysis(
                {
                    playerDTOs,
                    playerIndex,
                    selfHrid: this._editor?.getSelfHrid() || null,
                    zoneHrid,
                    difficultyTier,
                    hours,
                    communityBuffs,
                    upgradeModes,
                    optimizeFood: upgradeModes.includes('food'),
                    abilityLevelType,
                    abilityTargetLevel,
                    skipBackSlot,
                    combatLevelTargets,
                    abilityTargets,
                    charmTier,
                    charmEnhancement,
                    houseTargetLevel,
                    houseTargets,
                    guildShrineTargetLevel,
                    guildShrineTargets,
                    guildShrineCapToGuild,
                    communityBuffTargetLevel,
                    auraSwapsOnly,
                },
                ({ current, total, description }) => {
                    if (this._upgradeAborted) return;
                    const fill = this.panel.querySelector('#mwi-csim-upgrade-progress-fill');
                    const text = this.panel.querySelector('#mwi-csim-upgrade-progress-text');
                    // The food search's sim count is an estimate, so cap the bar
                    const pct = Math.min(100, Math.round((current / total) * 100));
                    const { text: remaining } = eta.update(total > 0 ? Math.min(1, current / total) : 0);
                    if (fill) fill.style.width = pct + '%';
                    if (text) text.textContent = `${current} / ${total}` + (remaining ? ` · ${remaining}` : '');
                    this._setStatus(description);
                },
                { abortSignal: () => this._upgradeAborted }
            );

            // Stopping is a decision about how long to wait, not about whether
            // the answer is wanted: every candidate already simulated is a real
            // measurement, and throwing them away meant a run stopped one short
            // of the end showed nothing at all
            const completed = results?.results?.length || 0;
            // A fresh run supersedes any restored set — drop the "from a previous
            // run" note before drawing, and remember the new results (opt-in).
            this._restoredUpgradeAt = null;
            this._restoredUpgradeMeta = null;
            if (this._upgradeAborted) {
                if (completed) {
                    this._renderUpgradeResults(results);
                    this._setStatus(
                        `Analysis cancelled — showing ${completed} completed candidate${completed === 1 ? '' : 's'}.`
                    );
                } else {
                    this._setStatus('Analysis cancelled.');
                }
            } else {
                this._renderUpgradeResults(results);
                const foodNote = results.food ? ' Food search complete.' : '';
                this._setStatus(`Analysis complete. ${completed} upgrades evaluated.${foodNote}`);
            }
            // The remembered set is per character and has no undo: writing this
            // run under the character who arrived mid-analysis would delete the
            // analysis they were keeping
            if (completed && this._stillSameCharacter(ownerId)) {
                // Who and where, so a restored set can say whose run it was -
                // the selector may hold a different player, or another zone,
                // by the time these come back
                saveUpgradeResults(UPGRADE_RESULTS_KEY, results, {
                    characterName: (this._editor?.getPlayerInfo?.() || [])[playerIndex]?.name || null,
                    zoneName: getCombatZones().find((z) => z.hrid === zoneHrid)?.name || null,
                    difficultyTier,
                });
            }
        } catch (error) {
            console.error('[CombatSimUI] Upgrade analysis failed:', error);
            this._setStatus('Analysis failed: ' + error.message);
        } finally {
            this._upgradeRunning = false;
            progressEl.style.display = 'none';
            runBtn.style.display = 'inline-block';
            stopBtn.style.display = 'none';
        }
    }

    /**
     * Explain an empty House result: whether the game data was readable, whether
     * any room looked combat-relevant, and whether they're simply all maxed.
     * @param {Object|null} scan - houseScan from the analysis
     * @returns {string} HTML fragment, empty when House wasn't part of the run
     * @private
     */
    _houseScanNote(scan) {
        if (!scan) return '';
        if (scan.rooms === 0) {
            return '<br><span style="font-size:11px;">House: no house room data available.</span>';
        }
        if (scan.combatRelevant === 0) {
            return `<br><span style="font-size:11px;">House: none of ${scan.rooms} rooms (${scan.withBuffs} with buffs) look combat-relevant — the game's buff data may have changed shape.</span>`;
        }
        if (scan.belowCap === 0) {
            return `<br><span style="font-size:11px;">House: all ${scan.combatRelevant} combat rooms are already at max level.</span>`;
        }
        return '';
    }

    /**
     * Render the cheapest-viable-food card.
     * Food isn't a ranked upgrade — it's a spend floor at fixed survival — so it
     * gets its own block above the table instead of a gold-per-improvement row.
     * @param {Object} food - Result from runFoodOptimization
     * @returns {string} HTML
     * @private
     */
    _renderFoodRecommendation(food) {
        const rec = food.recommendation;
        const current = food.current;
        const pct = (fraction) => `${((fraction || 0) * 100).toFixed(1)}%`;

        const restoreLabel = (slot) => {
            const parts = [];
            if (slot.hpRestore > 0) parts.push(`${formatKMB(slot.hpRestore)} HP`);
            if (slot.mpRestore > 0) parts.push(`${formatKMB(slot.mpRestore)} MP`);
            return parts.join(' / ');
        };

        let picksText;
        if (food.keepCurrent) {
            picksText =
                '<span style="color:#4caf50;">Keep your current food</span> — it already survives this zone and nothing cheaper of the same types does.';
        } else {
            const lines = rec.slots.map((slot) => {
                if (!slot.hrid) {
                    return `${slot.fromName} → <span style="color:#4caf50;">empty</span> <span style="color:#666;">(not needed here)</span>`;
                }
                if (!slot.changed) {
                    return `${slot.fromName} <span style="color:#666;">(kept, ${restoreLabel(slot)})</span>`;
                }
                return `${slot.fromName} → <span style="color:#e0e0e0;">${slot.name}</span> <span style="color:#666;">(${restoreLabel(slot)})</span>`;
            });
            picksText = lines.join('<br>');
        }

        const savings = current.costPerHour != null ? current.costPerHour - rec.costPerHour : null;
        let savingsText = '';
        if (savings != null && !food.keepCurrent) {
            if (savings > 1) {
                savingsText = `<span style="color:#4caf50;">saves ${formatKMB(savings)}/hr</span>`;
            } else if (savings < -1) {
                savingsText = `<span style="color:#f44336;">costs ${formatKMB(-savings)}/hr more</span>`;
            } else {
                savingsText = '<span style="color:#888;">same spend as your current food</span>';
            }
        }

        const currentLine =
            current.items.length > 0
                ? `Current: ${current.items.join(' + ')} — ${
                      current.costPerHour != null ? formatKMB(current.costPerHour) + '/hr' : 'cost unknown'
                  }, ${(current.deathsPerHour ?? 0).toFixed(2)} deaths/hr, ${pct(current.oomFraction)} out of mana`
                : 'Current: no food equipped';

        const shortfalls = [];
        if (food.ceilingDies) {
            shortfalls.push(`deaths (target relaxed to ${food.deathTarget.toFixed(2)}/hr)`);
        }
        if (food.ceilingOoms) {
            shortfalls.push(`mana (target relaxed to ${pct(food.oomTarget)} out of mana)`);
        }
        const caveat = shortfalls.length
            ? `<div style="color:#ff9800; font-size:10px; margin-top:4px;">Even the best tiers of your food types fall short on ${shortfalls.join(' and ')} at this zone.</div>`
            : '';

        const statsLine = food.keepCurrent
            ? ''
            : `<div style="color:#aaa; font-size:11px; margin-top:4px;">
                ${formatKMB(rec.costPerHour)}/hr in consumables ${savingsText ? '— ' + savingsText : ''}
                <span style="color:#666;">
                    · ${rec.deathsPerHour.toFixed(2)} deaths/hr · ${pct(rec.oomFraction)} out of mana
                </span>
            </div>`;

        return `<div style="margin:0 0 10px; padding:8px 10px; background:#0d0d1a; border:1px solid #2a2a4a; border-radius:6px;">
            <div style="color:${ACCENT}; font-size:12px; font-weight:600; margin-bottom:4px;">Cheapest viable food</div>
            <div style="color:#e0e0e0; font-size:12px; line-height:1.5;">${picksText}</div>
            ${statsLine}
            <div style="color:#666; font-size:10px; margin-top:4px;">${currentLine}</div>
            <div style="color:#666; font-size:10px; margin-top:2px;">
                ${food.simCount} sims searched. Starting from your equipped foods, each slot steps down a tier at a
                time within its own food type until survival breaks (or climbs until it holds). Buff foods stay
                equipped.
            </div>
            ${caveat}
        </div>`;
    }

    /**
     * Metric grid shown when an upgrade row is expanded. Identical for gold-cost
     * and combat-level rows, so both tables share it.
     * @param {Object} r - Result row
     * @param {Object} baseline - Baseline metrics
     * @returns {string} HTML for the detail cell contents
     * @private
     */
    _renderUpgradeDetailCells(r, baseline) {
        const dpsValueDelta = r.metrics.dps - baseline.dps;
        const xpValueDelta = r.metrics.xpPerHour - baseline.xpPerHour;
        // Shown per DAY: an upgrade's hourly profit delta is often a few
        // thousand coins, which reads as noise next to a cost in the hundreds of
        // millions. The percentage either side of it is identical whichever unit
        // this is in, so only the absolute figures are scaled.
        const profitValueDelta = (r.metrics.profitPerHour - baseline.profitPerHour) * 24;
        const ephDelta = r.metrics.encountersPerHour - baseline.encountersPerHour;
        const dphDelta = r.metrics.deathsPerHour - baseline.deathsPerHour;
        const fmtDelta = (val) => {
            if (Math.abs(val) < 0.5) return '—';
            return (val >= 0 ? '+' : '') + formatKMB(val);
        };
        const fmtDeltaSmall = (val) => {
            if (Math.abs(val) < 0.01) return '—';
            return (val >= 0 ? '+' : '') + val.toFixed(1);
        };
        const deltaColor = (val) => (val > 0.5 ? '#4caf50' : val < -0.5 ? '#f44336' : '#888');
        // For deaths, lower is better (inverted color)
        const deathDeltaColor = (val) => (val < -0.01 ? '#4caf50' : val > 0.01 ? '#f44336' : '#888');

        // The error bar on each percentage, and a note when the delta has not
        // cleared it. Without this a 0.2% "gain" off ninety encounters reads
        // exactly like a 15% one off nine thousand
        const errorBar = (key) => {
            const { noisePct, significant } = upgradeNoiseFor(r, key);
            if (noisePct == null) return '';
            const bar = `<span style="color:#666;"> ±${noisePct.toFixed(2)}%</span>`;
            return significant
                ? bar
                : `${bar}<span style="color:#c9a227;" title="Smaller than this run's sampling error — sim for longer before trusting it."> within noise</span>`;
        };

        return `<div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr 1fr; gap:8px; font-size:11px;">
                <div>
                    <div style="color:#888;">DPS</div>
                    <div style="color:#e0e0e0;">${formatKMB(r.metrics.dps)}</div>
                    <div style="color:${deltaColor(dpsValueDelta)};">${fmtDelta(dpsValueDelta)} (${r.deltas.dps >= 0 ? '+' : ''}${r.deltas.dps.toFixed(2)}%)${errorBar('dps')}</div>
                </div>
                <div>
                    <div style="color:#888;">EXP/hr</div>
                    <div style="color:#e0e0e0;">${formatKMB(r.metrics.xpPerHour)}</div>
                    <div style="color:${deltaColor(xpValueDelta)};">${fmtDelta(xpValueDelta)} (${r.deltas.xp >= 0 ? '+' : ''}${r.deltas.xp.toFixed(2)}%)${errorBar('xp')}</div>
                </div>
                <div>
                    <div style="color:#888;">Profit/day</div>
                    <div style="color:#e0e0e0;">${formatKMB(r.metrics.profitPerHour * 24)}</div>
                    <div style="color:${deltaColor(profitValueDelta)};">${fmtDelta(profitValueDelta)} (${r.deltas.profit >= 0 ? '+' : ''}${r.deltas.profit.toFixed(2)}%)${errorBar('profit')}</div>
                </div>
                <div>
                    <div style="color:#888;">EPH</div>
                    <div style="color:#e0e0e0;">${r.metrics.encountersPerHour.toFixed(1)}</div>
                    <div style="color:${deltaColor(ephDelta)};">${fmtDeltaSmall(ephDelta)} (${r.deltas.encounters >= 0 ? '+' : ''}${r.deltas.encounters.toFixed(2)}%)${errorBar('encounters')}</div>
                </div>
                <div>
                    <div style="color:#888;">DPH</div>
                    <div style="color:#e0e0e0;">${r.metrics.deathsPerHour.toFixed(1)}</div>
                    <div style="color:${deathDeltaColor(dphDelta)};">${fmtDeltaSmall(dphDelta)} (${r.deltas.deaths >= 0 ? '+' : ''}${r.deltas.deaths.toFixed(2)}%)${errorBar('deaths')}</div>
                </div>
            </div>
            <div style="margin-top:6px; color:#666; font-size:10px;">
                Baseline: DPS ${formatKMB(baseline.dps)} | EXP ${formatKMB(baseline.xpPerHour)} | Profit/day ${formatKMB(baseline.profitPerHour * 24)} | EPH ${baseline.encountersPerHour.toFixed(1)} | DPH ${baseline.deathsPerHour.toFixed(1)}
            </div>
            ${this._renderUpgradeCostBasis(r)}
            ${this._renderGuildShrineCost(r)}
            ${this._renderUpgradeScoreBreakdown(r)}`;
    }

    /**
     * What re-simulating this upgrade would cost the labyrinth cache.
     *
     * The advisor ranks a candidate on damage and gold. It has never said that
     * equipping the thing throws away every cached labyrinth room — the cache
     * key does not encode gear, so a gear change clears both layers wholesale —
     * nor which of those rooms was sitting near enough to its decision bar that
     * the re-sim might come back with a different recommendation.
     *
     * It names candidates and decides nothing. A room 1pp under its bar is not
     * a room this upgrade fixes; it is a room whose cached answer is about to
     * stop being evidence. Which way it lands is unknown until it is re-simmed,
     * and the wording says "would stale" and "within Npp of their bar" —
     * statements about the cache, not predictions about the rooms.
     *
     * Silent on a candidate outside the fingerprint's coverage. A house room, an
     * ability swap or a combat level does move the fingerprint, but nothing here
     * can model what the changed build would hash to, so those rows say nothing
     * rather than reporting a projection they cannot make — and "would stale 0
     * cached rooms" on them would claim the opposite of the truth.
     *
     * @param {Object} r - Result row
     * @returns {string} HTML, empty when there is nothing true to say
     * @private
     */
    _renderUpgradeInvalidation(r) {
        try {
            const candidate = r?.candidate || r;
            if (!isGearCandidate(candidate)) return '';

            const context = this._invalidationContext();
            if (!context) return '';

            const projected = projectedFingerprint(context, candidate, context.hash);
            const summary = rankInvalidatedRooms(context.entries, { targetRate: context.targetRate });
            const text = describeInvalidatedRooms(summary, projected !== context.current);
            if (!text) return '';

            const closest = summary.ranked[0];
            const detail = closest
                ? `Closest to its bar: ${closest.name || closest.room} at ${(closest.clearChance * 100).toFixed(1)}% ` +
                  `against a ${(context.targetRate * 100).toFixed(0)}% target` +
                  (closest.trials ? ` (${formatWithSeparator(closest.trials)} trials` : '') +
                  (closest.trials && closest.halfWidthPp != null ? `, ±${closest.halfWidthPp.toFixed(1)}pp)` : '') +
                  (closest.trials && closest.halfWidthPp == null ? ')' : '') +
                  '.'
                : '';

            const title =
                'Equipping this changes the gear fingerprint every cached labyrinth sim is stamped with, and the ' +
                'cache key does not encode gear — so all of them are dropped and re-simulated.\n' +
                `${detail}\n` +
                'This names what would need re-simming. It does not say which rooms would still clear their bar ' +
                'afterwards: the honest answer to that needs the re-sim.';

            return `<span style="color:#aaa;" title="${escapeAttribute(title)}">${text}.</span>`;
        } catch (error) {
            console.error('[UpgradeAdvisor] Reading what this upgrade would stale failed:', error);
            return '';
        }
    }

    /**
     * The pieces the invalidation line reads, gathered once per cache state.
     *
     * Every advisor row asks the same question of the same cache, and the answer
     * only moves when the cache or the gear does. Memoised on the cache's size
     * and the current fingerprint, which between them change on every event that
     * could make the answer stale.
     *
     * @returns {Object|null} `{stored, loadouts, levels, abilities, houseRooms, current,
     *   entries, targetRate, hash}`, or null when the labyrinth bundle is absent
     *   or the cache is empty
     * @private
     */
    _invalidationContext() {
        const lab = labyrinthClearRate();
        if (!lab?.combatCache?.size) return null;

        let current = null;
        try {
            current = lab._snapshotContentFingerprint();
        } catch {
            return null;
        }
        const stamp = `${current}|${lab.combatCache.size}`;
        if (this._invalidationCache?.stamp === stamp) return this._invalidationCache.context;

        const store = loadoutSnapshot();
        // No snapshot store means no way to build the projected fingerprint, and
        // an unbuildable projection is not a projection of "no change"
        if (!store) return null;
        const snapshots = store.snapshots || {};
        const stored = JSON.stringify(snapshots, (key, value) => (key === 'savedAt' ? undefined : value));
        const loadouts = Object.values(snapshots).map((snapshot) => store.resolveEquipment(snapshot) || []);

        // Only entries simmed under the gear worn now are evidence that this
        // upgrade would destroy. One already stamped with other gear is stale
        // already, and crediting the upgrade with staling it would be wrong.
        const entries = [];
        for (const [key, result] of lab.combatCache) {
            if ((result?.snapshotFingerprint ?? current) !== current) continue;
            entries.push({ key, result });
        }

        // The parts of the hashed input a gear candidate does not move. The
        // projection carries all of them through unchanged — without any one of
        // them the projected value would differ from `current` on every row and
        // every candidate would read as cache-invalidating.
        const build = lab._simBuildInputs?.() ?? null;

        const context = {
            stored,
            loadouts,
            levels: lab._combatSkillLevels?.() ?? null,
            abilities: build?.abilities ?? null,
            houseRooms: build?.houseRooms ?? null,
            current,
            entries,
            targetRate: (lab.getRecommendTargetPct?.() || 70) / 100,
            hash: (value) => lab._hashString(value),
        };
        this._invalidationCache = { stamp, context };
        return context;
    }

    /**
     * What kind of number the Cost column is holding, spelled out.
     *
     * The column shows one figure and the tag beside it is three characters.
     * This is where the three characters get their sentence: which basis, what
     * the purchase and the resale each came to, the fresh-book assumption on an
     * ability swap, and any caveat the candidate itself carries.
     *
     * @param {Object} r - Result row
     * @returns {string} HTML, empty when there is nothing to qualify
     * @private
     */
    _renderUpgradeCostBasis(r) {
        const parts = [];
        const source = COST_SOURCES[r.costSource];
        const detail = r.costDetail;

        if (source) parts.push(`<span style="color:#aaa;">Cost basis: ${source.label} — ${source.title}</span>`);

        // A `sim` figure is an enhancement path, and the same path costs
        // different money on different benches: the player's own stats, the
        // simulator's manual fields, or the shipped professional kit. Which one
        // it was is not a new column — it is the missing half of the sentence
        // "an expected cost over a random process" the basis line already
        // gives. Same words the enhancement tooltip's chip uses, so a reader who
        // has seen "Pro" there does not have to learn a second vocabulary here.
        if (detail?.enhanceSource) {
            const rates = detail.enhanceSource;
            parts.push(
                `<span style="color:#aaa;">Enhance rates: ${rates.label}` +
                    `${rates.detail ? ` — ${rates.detail}` : ''}.</span>`
            );
        }

        if (detail && (detail.gross != null || detail.credit)) {
            const gross = detail.gross == null ? 'no price' : formatKMB(detail.gross);
            parts.push(
                `<span style="color:#888;">Buys ${gross}, resale credit ${formatKMB(detail.credit || 0)}.</span>`
            );
        }

        if (detail?.freshBook && detail.books) {
            const count = Number.isFinite(detail.books.books) ? Math.ceil(detail.books.books) : null;
            parts.push(
                `<span style="color:#8ab4f8;">Priced as a fresh ${detail.books.bookName}: ` +
                    `${count == null ? 'the whole level path' : `${formatWithSeparator(count)} books`} from nothing, ` +
                    `since you do not own this ability.</span>`
            );
        } else if (detail?.ownedFromLevel != null && detail.books) {
            const count = Number.isFinite(detail.books.books) ? Math.ceil(detail.books.books) : null;
            parts.push(
                `<span style="color:#8ab4f8;">Priced from the ${detail.books.bookName} you already own at ` +
                    `Lv${detail.ownedFromLevel}: ` +
                    `${count == null ? 'the level path from there' : `${formatWithSeparator(count)} more books`}.</span>`
            );
        }

        if (detail?.unpriced?.length) {
            parts.push(`<span style="color:#ff9800;">No price found for ${detail.unpriced.join(', ')}.</span>`);
        }

        if (r.candidate?.caveat) parts.push(`<span style="color:#ff9800;">${r.candidate.caveat}</span>`);

        // What equipping this would throw away, for candidates the labyrinth
        // gear fingerprint actually covers. Last, because it is the only line
        // here that is not about the money.
        const staled = this._renderUpgradeInvalidation(r);
        if (staled) parts.push(staled);

        if (!parts.length) return '';
        return `<div style="margin-top:4px; font-size:10px; line-height:1.4; display:flex; flex-direction:column; gap:1px;">${parts.join('')}</div>`;
    }

    /**
     * What a guild shrine row actually costs, which the Cost column cannot say.
     *
     * The column holds gold, and a shrine level is bought with credits *and*
     * guild tokens. Credits have a gold value — the cheapest items that convert
     * into them — and tokens are priced through the guild shop's token→credit
     * exchange when a rate is known. The note names which ranking applied, so
     * a missing exchange rate never reads as the tokens being free.
     *
     * @param {Object} r - Result row
     * @returns {string} HTML, empty for every other kind of row
     * @private
     */
    _renderGuildShrineCost(r) {
        const candidate = r.candidate;
        if (candidate?.type !== 'guild_shrine') return '';

        const guild = explainUpgradeCost(candidate, null)?.guild || {};
        const tokens = guild.tokens ?? (candidate.guildTokenCost || 0);
        const gold = guild.creditGold == null ? 'no price' : formatKMB(guild.creditGold);
        const tokenText = guild.tokenNote || `${formatWithSeparator(tokens)} guild token${tokens === 1 ? '' : 's'}`;
        // A target level buys several levels at once, and the cost is all of
        // them — say so, or the figure reads as the price of the last level
        const levels = candidate.levelsBought ?? candidate.upgradeLevel - candidate.currentLevel;
        const span =
            levels > 1
                ? ` for all ${levels} levels from Lv${candidate.currentLevel} to Lv${candidate.upgradeLevel}`
                : '';
        const parts = [
            `<div style="color:#aaa;">Costs ${tokenText} + credits worth ${gold}${span}. ${guild.rankedNote || ''}</div>`,
        ];

        if (candidate.needsShrineLevel) {
            parts.push(
                `<div style="color:#ff9800;">Your guild's ${String(candidate.shrineHrid || '')
                    .split('/')
                    .pop()} shrine is level
                ${candidate.shrineLevel}; buying level ${candidate.needsShrineLevel} needs the shrine there first —
                a guild-wide upgrade this cost does not include.</div>`
            );
        } else if (!candidate.shrineLevelKnown) {
            parts.push(
                `<div style="color:#888;">No guild shrine levels reached the client, so whether the shrine can
                already support this level is unknown.</div>`
            );
        }

        return `<div style="margin-top:4px; font-size:10px; line-height:1.4;">${parts.join('')}</div>`;
    }

    /**
     * Where a row's Score came from, so the number is auditable rather than magic.
     * @param {Object} r - Upgrade result row
     * @returns {string} HTML, empty when the row scored nothing
     * @private
     */
    _renderUpgradeScoreBreakdown(r) {
        const entries = Object.values(r.rankPoints || {});
        if (!entries.length) return '';

        const parts = entries
            .sort((a, b) => b.points - a.points)
            .map((e) => `${e.label} #${e.place} (+${e.points})`)
            .join(' &nbsp;·&nbsp; ');

        return `<div style="margin-top:4px; color:#666; font-size:10px;">
            Score ${r.score}: ${parts}
        </div>`;
    }

    /**
     * Gold-cost upgrade table: everything you can buy, ranked by gold per 0.01%.
     * @param {Array<Object>} rows - Non-combat-level results
     * @param {Object} baseline - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeGoldTable(rows, baseline) {
        if (!this._upgradeSort) this._upgradeSort = { key: 'score', asc: true };
        const { key: sortKey, asc: sortAsc } = this._upgradeSort;

        const columns = this._upgradeColumns(baseline, rows).filter((c) => c.visible);
        const column = columns.find((c) => c.key === sortKey) || columns[0];
        // Higher-is-better columns are negated so one ascending sort serves all
        const sortValue = (r) => (column.lowerIsBetter === false ? -column.value(r) : column.value(r));
        const sorted = sortRowsBy(rows, sortValue, sortAsc);

        // Sticky needs an opaque background or rows scroll through the header.
        // The offset is the results pane's own padding, so the header parks flush
        // with the top of the scroll area rather than floating below it.
        const thBase =
            'padding:3px 4px; border-bottom:1px solid #333; color:#888; font-weight:600; cursor:pointer; ' +
            'user-select:none; position:sticky; top:-10px; z-index:2; background:#12121f; line-height:1.15;';
        const tdBase = 'padding:3px 4px; border-bottom:1px solid #1a1a2e;';
        // Numbers right-align and never wrap; only the Upgrade name may reflow,
        // which is what keeps sixteen columns inside a panel this wide
        const align = (c) => (c.numeric ? 'text-align:right; white-space:nowrap;' : 'text-align:left;');
        const arrow = (k) => (sortKey === k ? (sortAsc ? ' ▴' : ' ▾') : '');

        // Best value per column, for the green highlight
        const best = new Map();
        for (const c of columns) {
            if (!c.highlight) continue;
            let winner = c.lowerIsBetter === false ? -Infinity : Infinity;
            for (const r of rows) {
                const v = c.value(r);
                if (!Number.isFinite(v)) continue;
                if (c.lowerIsBetter === false ? v > winner : v < winner) winner = v;
            }
            best.set(c.key, winner);
        }

        let html = `${this._renderUpgradeColumnMenu()}
        <table style="width:100%; border-collapse:collapse; font-size:10px;">
            <thead><tr>`;
        for (const c of columns) {
            const title = c.title ? ` title="${c.title}"` : '';
            // The second line carries the qualifier, so "Gold/0.01% Profit" costs
            // the width of "Gold/0.01%" rather than the whole phrase
            const heading = c.sub ? `${c.label}<br>${c.sub}${arrow(c.key)}` : `${c.label}${arrow(c.key)}`;
            html += `<th style="${thBase} ${align(c)}" data-sort-key="${c.key}"${title}>${heading}</th>`;
        }
        html += '</tr></thead><tbody>';

        sorted.forEach((r, i) => {
            const rowColor = r.deltas.dps > 0 || r.deltas.profit > 0 ? '#e0e0e0' : '#888';
            const rowKey = upgradeRowKey(r);

            html += `<tr style="cursor:pointer; color:${rowColor};" data-upgrade-row="${i}" data-row-key="${rowKey}">`;
            for (const c of columns) {
                const value = c.value(r);
                const isBest = c.highlight && Number.isFinite(value) && value === best.get(c.key) && rows.length > 1;
                const style = `${tdBase} ${align(c)}${isBest ? ' color:#4caf50; font-weight:700;' : ''}`;
                const title = c.title ? ` title="${c.title}"` : '';
                html += `<td style="${style}"${title}>${c.render(r, value)}</td>`;
            }
            html += `</tr>
            <tr data-upgrade-detail="${i}" data-row-key="${rowKey}" style="display:none;">
                <td colspan="${columns.length}" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222;">
                    ${this._renderUpgradeDetailCells(r, baseline)}
                </td>
            </tr>`;
        });

        return html + '</tbody></table>';
    }

    /**
     * The ⚙ Columns popover: what the table shows, and what the Score counts.
     *
     * The two lists are deliberately separate. Hiding a column is about screen
     * width; dropping one from the score changes the ranking. Tying them
     * together would mean you could not read a metric without scoring it.
     *
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeColumnMenu() {
        const hidden = this._upgradeHiddenColumns || new Set(DEFAULT_HIDDEN_COLUMNS);
        const scored = new Set(this._upgradeScoreKeys || DEFAULT_SCORE_KEYS);
        // One `display` declaration, and it is the only one. Prepending
        // `display:none;` to a style string that went on to say `display:flex`
        // later lost to the later declaration every time, so the popover was
        // rebuilt *open* by every sort, every column tick, every budget replan
        // and every fresh analysis — it read as a menu opening itself.
        const display = this._upgradeColumnMenuOpen ? 'flex' : 'none';

        const optional = this._upgradeColumns().filter((c) => !c.fixed);
        const box = 'display:flex; align-items:center; gap:6px; cursor:pointer; color:#ccc; padding:1px 0;';

        const showList = optional
            .map(
                (c) => `<label style="${box}">
                    <input type="checkbox" data-upgrade-col="${c.key}" ${hidden.has(c.key) ? '' : 'checked'}>
                    ${columnMenuLabel(c)}
                </label>`
            )
            .join('');

        const scoreList = SCORE_METRICS.map(
            (m) => `<label style="${box}">
                <input type="checkbox" data-upgrade-score="${m.key}" ${scored.has(m.key) ? 'checked' : ''}>
                ${m.label}
            </label>`
        ).join('');

        const depthKey = this._upgradeScoreDepth || DEFAULT_SCORE_DEPTH;
        const depthOptions = SCORE_DEPTHS.map(
            (d) => `<option value="${d.key}"${d.key === depthKey ? ' selected' : ''}>${d.label}</option>`
        ).join('');
        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:1px 4px; ' +
            'font-size:11px; font-family:inherit;';

        return `<div style="position:relative; margin-bottom:6px;">
            <button id="mwi-csim-upgrade-cols-btn" style="background:#1a1a2e; color:#ccc; border:1px solid #333;
                border-radius:3px; padding:2px 8px; font-size:11px; cursor:pointer;">⚙ Columns</button>
            <div id="mwi-csim-upgrade-cols-menu" style="display:${display}; position:absolute; top:100%; left:0; z-index:5;
                background:#12121f; border:1px solid #333; border-radius:4px; padding:8px 10px; margin-top:2px;
                font-size:11px; gap:18px; box-shadow:0 4px 12px rgba(0,0,0,0.6);">
                <div>
                    <div style="color:#888; font-weight:600; margin-bottom:4px;">Show</div>
                    ${showList}
                </div>
                <div>
                    <div style="color:#888; font-weight:600; margin-bottom:4px;">Counts toward Score</div>
                    ${scoreList}
                    <div style="color:#666; margin-top:6px; max-width:190px; line-height:1.35;">
                        Repay and ROI are the same ratio inverted — scoring both counts it twice.
                    </div>
                    <div style="color:#888; font-weight:600; margin:8px 0 4px;">Score</div>
                    <label style="${box}" title="How far down each metric's ladder a row can still earn points.
                        Five is a podium and leaves most of a long run on zero; deeper turns the column into a
                        ranking of the whole table.">
                        <span>Places</span>
                        <select class="toolasha-select" id="mwi-csim-score-depth" style="${selectStyle}">${depthOptions}</select>
                    </label>
                    <label style="${box}" title="Colour the nine best values in Score and in every column that
                        counts toward it — green through amber to red — so you can see at a glance which row is
                        the cheapest DPS, which the cheapest EXP, and which wins on aggregate. Each column is
                        ranked on its own values and in its own direction: cheapest first for the Gold/0.01%
                        columns and Repay, highest first for ROI. A row with no value in a column never places
                        there, and rows below ninth stay uncoloured — their position already says so.">
                        <input type="checkbox" id="mwi-csim-score-gradient"
                            ${this._upgradeScoreGradient ? 'checked' : ''}>
                        Colour the top ${SCORE_GRADIENT_PLACES} in each scored column
                    </label>
                </div>
            </div>
        </div>`;
    }

    /**
     * Every column the gold table can show, in display order.
     *
     * One definition per column carries its label, how to read it off a row, how
     * to draw it, whether lower is better and whether it is currently shown, so
     * sorting, highlighting, the visibility menu and rendering cannot drift apart.
     *
     * @param {Object} [baseline] - Baseline metrics
     * @param {Array<Object>} [rows] - The rows about to be drawn, for the Score gradient
     * @returns {Array<Object>} Column definitions
     * @private
     */
    _upgradeColumns(baseline = {}, rows = []) {
        const hidden = this._upgradeHiddenColumns || new Set(DEFAULT_HIDDEN_COLUMNS);
        const scored = new Set(this._upgradeScoreKeys || DEFAULT_SCORE_KEYS);
        const depthKey = this._upgradeScoreDepth || DEFAULT_SCORE_DEPTH;
        // Only paid for when the gradient is on: each ladder is a sort over
        // every row, and the popover is where a reader says they want them
        const gradientPlaces = this._upgradeScoreGradient ? gradientLadders(rows, scored) : null;

        // At or below zero cost the figure stops being a rate and becomes the
        // net gold itself (see computeGoldPerImprovement), so it is drawn as
        // what it is rather than as a nonsense "−40M per 0.01%"
        const goldPer = (val) => {
            if (!Number.isFinite(val)) return '—';
            if (val < 0) {
                return `<span style="color:#4caf50;" title="Pays for itself — hands back ${formatKMB(-val)}.">
                    +${formatKMB(-val)}</span>`;
            }
            if (val === 0) return '<span style="color:#4caf50;" title="Costs nothing up front.">free</span>';
            return formatKMB(val);
        };
        const delta = (val, digits = 1) => {
            if (!Number.isFinite(val) || Math.abs(val) < 1e-9) return '—';
            return `${val > 0 ? '+' : ''}${Math.abs(val) >= 1000 ? formatKMB(val) : val.toFixed(digits)}`;
        };
        // Same rendering as `delta`, but with the two measurements it was
        // subtracted from in a tooltip — "how was this number arrived at" for
        // a reader who does not take a Δ column's word for it
        const deltaWithArithmetic = (baselineVal, currentVal, digits = 1) => {
            const body = delta(currentVal - (baselineVal ?? 0), digits);
            if (!Number.isFinite(baselineVal) || !Number.isFinite(currentVal)) return body;
            const fmt = (v) => (Math.abs(v) >= 1000 ? formatKMB(v) : v.toFixed(digits));
            const title = `${fmt(baselineVal)} baseline → ${fmt(currentVal)} with this upgrade = ${delta(currentVal - baselineVal, digits)}`;
            return `<span title="${escapeAttribute(title)}">${body}</span>`;
        };
        // Never-repays shows blank rather than ∞: the column is a duration, and
        // "infinite hours" reads as a measurement when it is really an absence
        const hours = (h) => {
            if (!Number.isFinite(h)) return '—';
            if (h <= 0) return 'free';
            if (h < 24) return `${h.toFixed(1)}h`;
            const days = h / 24;
            return days < 90 ? `${days.toFixed(1)}d` : `${(days / 30.44).toFixed(1)}mo`;
        };

        const scoreNote = (key) => (scored.has(key) ? ' Counts toward Score.' : '');

        const defs = [
            {
                key: 'upgrade',
                label: 'Upgrade',
                fixed: true,
                // Sorted and exported by the description alone: the handoff
                // buttons are chrome on the cell, not part of what the row says
                value: (r) => r.candidate.description.toLowerCase(),
                render: (r) => `${r.candidate.description}${upgradeRowNotesHtml(r)}${upgradeRowActionsHtml(r)}`,
            },
            {
                key: 'cost',
                label: 'Cost',
                fixed: true,
                numeric: true,
                title:
                    'What the upgrade nets out at: purchases minus what the gear it replaces sells for. ' +
                    'A green credit means the resale is larger, so the swap hands gold back. The small tag ' +
                    'says which kind of number it is — a market quote, a simulated enhance path, or a craft cost.',
                value: (r) => (r.cost == null ? Infinity : r.cost),
                render: (r) => {
                    const cell = upgradeCostCell(r);
                    const body = cell.color
                        ? `<span style="color:${cell.color};" title="${cell.title}">${cell.text}</span>`
                        : cell.text;
                    return `${body}${costSourceTagHtml(r.costSource)}`;
                },
            },
            {
                key: 'payback',
                label: 'Time',
                numeric: true,
                title:
                    'How long you grind at your current profit rate to afford this. Every row divides by ' +
                    'that same rate, so this orders candidates exactly as Cost does — it is the Cost ' +
                    'column in hours, which is why it cannot be scored.',
                value: (r) => r.economics?.paybackHours ?? Infinity,
                render: (r, v) => hours(v),
            },
            {
                key: 'repay',
                label: 'Repay',
                numeric: true,
                highlight: true,
                title:
                    'How long the extra profit takes to earn the cost back. Blank means the upgrade does ' +
                    'not raise profit, so it never repays — which does not make it a bad buy if you ' +
                    'bought it for DPS.' +
                    scoreNote('repay'),
                value: (r) => r.economics?.repayHours ?? Infinity,
                render: (r, v) => hours(v),
            },
            {
                key: 'roi',
                label: 'ROI',
                sub: '1yr',
                numeric: true,
                lowerIsBetter: false,
                highlight: true,
                title:
                    'A year of the added profit against the outlay. This is repay time inverted, so it ' +
                    'ranks candidates identically — scoring both counts one signal twice.' +
                    scoreNote('roi'),
                value: (r) => r.economics?.roiAnnualPct ?? -Infinity,
                render: (r, v) => (Number.isFinite(v) ? `${v.toFixed(0)}%` : '—'),
            },
            {
                key: 'deltaDps',
                label: 'ΔDPS',
                numeric: true,
                lowerIsBetter: false,
                value: (r) => r.metrics.dps - (baseline.dps ?? 0),
                render: (r) => deltaWithArithmetic(baseline.dps ?? 0, r.metrics.dps, 2),
            },
            {
                key: 'dps',
                label: 'Gold/0.01%',
                sub: 'DPS',
                numeric: true,
                highlight: true,
                title: 'Cost of one 0.01% DPS improvement. Lower is better.' + scoreNote('dps'),
                value: (r) => r.goldPer.dps,
                render: (r, v) => goldPer(v),
            },
            {
                key: 'deltaXp',
                label: 'ΔEXP',
                sub: '/hr',
                numeric: true,
                lowerIsBetter: false,
                value: (r) => r.metrics.xpPerHour - (baseline.xpPerHour ?? 0),
                render: (r) => deltaWithArithmetic(baseline.xpPerHour ?? 0, r.metrics.xpPerHour),
            },
            {
                key: 'xp',
                label: 'Gold/0.01%',
                sub: 'EXP',
                numeric: true,
                highlight: true,
                title: 'Cost of one 0.01% EXP/hr improvement. Lower is better.' + scoreNote('xp'),
                value: (r) => r.goldPer.xp,
                render: (r, v) => goldPer(v),
            },
            {
                key: 'deltaProfit',
                label: 'ΔProfit',
                sub: '/hr',
                numeric: true,
                lowerIsBetter: false,
                value: (r) => r.economics?.profitGainPerHour ?? 0,
                render: (r) => deltaWithArithmetic(baseline.profitPerHour ?? 0, r.metrics.profitPerHour),
            },
            {
                key: 'profit',
                label: 'Gold/0.01%',
                sub: 'Profit',
                numeric: true,
                highlight: true,
                title: 'Cost of one 0.01% profit improvement. Lower is better.' + scoreNote('profit'),
                value: (r) => r.goldPer.profit,
                render: (r, v) => goldPer(v),
            },
            {
                key: 'deltaEph',
                label: 'ΔEPH',
                numeric: true,
                lowerIsBetter: false,
                value: (r) => r.metrics.encountersPerHour - (baseline.encountersPerHour ?? 0),
                render: (r) => deltaWithArithmetic(baseline.encountersPerHour ?? 0, r.metrics.encountersPerHour, 2),
            },
            {
                key: 'encounters',
                label: 'Gold/0.01%',
                sub: 'EPH',
                numeric: true,
                highlight: true,
                title: 'Cost of one 0.01% encounters-per-hour improvement.' + scoreNote('encounters'),
                value: (r) => r.goldPer.encounters,
                render: (r, v) => goldPer(v),
            },
            {
                key: 'deltaDph',
                label: 'ΔDPH',
                numeric: true,
                value: (r) => r.metrics.deathsPerHour - (baseline.deathsPerHour ?? 0),
                render: (r) => deltaWithArithmetic(baseline.deathsPerHour ?? 0, r.metrics.deathsPerHour, 2),
            },
            {
                key: 'deaths',
                label: 'Gold/0.01%',
                sub: 'DPH',
                numeric: true,
                highlight: true,
                title:
                    'Cost of one 0.01% reduction in deaths per hour. Blank when deaths did not fall.' +
                    scoreNote('deaths'),
                value: (r) => r.goldPer.deaths,
                render: (r, v) => goldPer(v),
            },
            {
                key: 'score',
                label: 'Score',
                fixed: true,
                numeric: true,
                lowerIsBetter: false,
                highlight: true,
                sub: scoreDepthLabel(depthKey),
                title:
                    `Points for placing in each scored metric's ${scoreDepthLabel(depthKey).toLowerCase()}, ` +
                    'summed. Finds all-rounders that never top a single column. Ordinal, so winning a metric ' +
                    'narrowly scores the same as winning it outright. Use ⚙ Columns to choose what counts, ' +
                    'how deep the placings go, and whether to colour them.',
                value: (r) => r.score ?? 0,
                render: (r, v) => (v ? String(v) : '—'),
            },
        ];

        // The colour goes on afterwards rather than inside each column's own
        // renderer: a column should say how to draw its number, not how to draw
        // a ranking of it, and wrapping keeps the special cases the renderers
        // already carry — a "free", a "pays for itself" — with their own colour
        // intact, since an inner span wins over the one put round it.
        return defs.map((column) => {
            const ladder = gradientPlaces?.get(column.key);
            const withGradient = ladder
                ? {
                      ...column,
                      render: (r, v) => {
                          const drawn = column.render(r, v);
                          const color = scoreGradientColor(ladder.get(r));
                          return color ? `<span style="color:${color};">${drawn}</span>` : drawn;
                      },
                  }
                : column;
            return { ...withGradient, visible: column.fixed || !hidden.has(column.key) };
        });
    }

    /**
     * Combat-level table, in its own box below the gold-cost list. Levels are not
     * purchasable, so they get grind time and raw deltas instead of a gold column
     * and can't be ranked against gear on the same axis.
     * @param {Array<Object>} rows - combat_level results
     * @param {Object} baseline - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeLevelTable(rows, baseline) {
        if (!this._upgradeLevelSort) this._upgradeLevelSort = { key: 'dps', asc: true };
        const { key: sortKey, asc: sortAsc } = this._upgradeLevelSort;
        // What the grind actually ends with: the skill at its target plus the
        // weapon's primary skill wherever the same hours carried it. Rows with
        // no primary gain (or the primary skill's own row) read off the solo sim
        const effective = (r) => (r.alongside?.metrics ? r.alongside : r);

        const sortValue = (r) => {
            const e = effective(r);
            // Negated deltas so ascending sort puts the biggest gain first
            switch (sortKey) {
                case 'upgrade':
                    return r.candidate.description.toLowerCase();
                case 'time':
                    return r.levelTimeHours ?? Infinity;
                case 'xp':
                    return -(e.metrics.xpPerHour - baseline.xpPerHour);
                case 'profit':
                    return -(e.metrics.profitPerHour - baseline.profitPerHour);
                default:
                    return -(e.metrics.dps - baseline.dps);
            }
        };
        const sorted = sortRowsBy(rows, sortValue, sortAsc);

        const thStyle =
            'padding:4px 6px; text-align:left; border-bottom:1px solid #333; color:#888; font-weight:600; cursor:pointer; user-select:none; white-space:nowrap;';
        const tdStyle = 'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap;';
        const arrow = (k) => (sortKey === k ? (sortAsc ? ' ▴' : ' ▾') : '');
        const fmtLevelTime = (h) => {
            if (!Number.isFinite(h)) return '—';
            if (h < 24) return `${h.toFixed(1)}h`;
            return `${(h / 24).toFixed(1)}d`;
        };

        let bestDpsDelta = -Infinity;
        let bestXpDelta = -Infinity;
        let bestProfitDelta = -Infinity;
        for (const r of rows) {
            const e = effective(r);
            bestDpsDelta = Math.max(bestDpsDelta, e.metrics.dps - baseline.dps);
            bestXpDelta = Math.max(bestXpDelta, e.metrics.xpPerHour - baseline.xpPerHour);
            bestProfitDelta = Math.max(bestProfitDelta, e.metrics.profitPerHour - baseline.profitPerHour);
        }

        const detailColspan = 5;
        const primaryName = rows.find((r) => r.primarySkill)?.primarySkill;
        const primaryNote = primaryName
            ? ` Your weapon trains ${primaryName.charAt(0).toUpperCase() + primaryName.slice(1)} with 30% of all combat XP whatever charm is worn, so each row also shows where that skill lands by the time the grind is done — the Δ columns are for both together.`
            : '';

        let html = `<div style="margin-top:14px; padding:8px 10px; background:#0d0d1a; border:1px solid #2a2a4a; border-radius:6px;">
            <div style="color:${ACCENT}; font-size:12px; font-weight:600; margin-bottom:2px;">Combat levels</div>
            <div style="color:#666; font-size:10px; margin-bottom:6px;">
                Levels can't be bought, so these are ranked by improvement and the grind time to earn them — not
                against the gold costs above.${primaryNote}
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                <th style="${thStyle}" data-level-sort-key="upgrade">Skill${arrow('upgrade')}</th>
                <th style="${thStyle}" data-level-sort-key="time">Level Time${arrow('time')}</th>
                <th style="${thStyle}" data-level-sort-key="dps">ΔDPS${arrow('dps')}</th>
                <th style="${thStyle}" data-level-sort-key="xp">ΔEXP/hr${arrow('xp')}</th>
                <th style="${thStyle}" data-level-sort-key="profit">ΔProfit/hr${arrow('profit')}</th>
            </tr></thead><tbody>`;

        sorted.forEach((r, i) => {
            const e = effective(r);
            const dpsDelta = e.metrics.dps - baseline.dps;
            const xpDelta = e.metrics.xpPerHour - baseline.xpPerHour;
            const profitDelta = e.metrics.profitPerHour - baseline.profitPerHour;
            const rowColor = e.deltas.dps > 0 || e.deltas.profit > 0 ? '#e0e0e0' : '#888';
            const fmtCell = (delta, pct) => {
                if (Math.abs(delta) < 1e-9) return '—';
                const sign = delta >= 0 ? '+' : '';
                return `${sign}${formatKMB(delta)} (${sign}${pct.toFixed(2)}%)`;
            };
            const deltaStyle = (delta, best) => {
                if (delta === best && Number.isFinite(best) && best > 0) return 'color:#4caf50; font-weight:700;';
                if (delta > 0) return 'color:#8bc34a;';
                if (delta < 0) return 'color:#f44336;';
                return 'color:#888;';
            };
            const charmNote = r.levelingCharmName ? ` (wearing ${r.levelingCharmName})` : '';
            const timeTitle = Number.isFinite(r.levelTimeHours)
                ? `Grinding time at this zone’s XP rates to earn these levels${charmNote}`
                : `No XP accrues in this skill at this zone${charmNote}`;

            // Where the primary skill lands along the way, under the skill name
            let alongLine = '';
            let alongTitle = '';
            if (r.alongside) {
                const a = r.alongside;
                if (a.upgradeLevel > a.currentLevel) {
                    alongLine = `<div style="color:#777; font-size:10px;">+ ${a.label} ${a.currentLevel} → ${a.upgradeLevel} along the way</div>`;
                    const solo = (delta, pct) => fmtCell(delta, pct);
                    alongTitle =
                        ` Δ columns are for both together; ${r.candidate.description} alone: DPS ${solo(r.metrics.dps - baseline.dps, r.deltas.dps)}, ` +
                        `EXP/hr ${solo(r.metrics.xpPerHour - baseline.xpPerHour, r.deltas.xp)}, ` +
                        `Profit/hr ${solo(r.metrics.profitPerHour - baseline.profitPerHour, r.deltas.profit)}.`;
                } else {
                    alongLine = `<div style="color:#555; font-size:10px;">${a.label} gains no level along the way</div>`;
                }
            } else if (r.isMainSkill) {
                alongLine = `<div style="color:#555; font-size:10px;">your weapon's own skill</div>`;
            }
            const deltaTitle = alongTitle ? `title="${alongTitle.trim()}"` : '';

            html += `<tr style="cursor:pointer; color:${rowColor};" data-level-row="${i}" data-row-key="${upgradeRowKey(r)}">
                <td style="${tdStyle}">${r.candidate.description}${alongLine}</td>
                <td style="${tdStyle}" title="${timeTitle}">${fmtLevelTime(r.levelTimeHours)}</td>
                <td style="${tdStyle} ${deltaStyle(dpsDelta, bestDpsDelta)}" ${deltaTitle}>${fmtCell(dpsDelta, e.deltas.dps)}</td>
                <td style="${tdStyle} ${deltaStyle(xpDelta, bestXpDelta)}" ${deltaTitle}>${fmtCell(xpDelta, e.deltas.xp)}</td>
                <td style="${tdStyle} ${deltaStyle(profitDelta, bestProfitDelta)}" ${deltaTitle}>${fmtCell(profitDelta, e.deltas.profit)}</td>
            </tr>
            <tr data-level-detail="${i}" data-row-key="${upgradeRowKey(r)}" style="display:none;">
                <td colspan="${detailColspan}" style="padding:6px 12px; background:#0a0a14; border-bottom:1px solid #222;">
                    ${this._renderUpgradeDetailCells(r, baseline)}
                </td>
            </tr>`;
        });

        return html + '</tbody></table></div>';
    }

    /**
     * Everything that was simulated but could not be priced, in its own box.
     *
     * Three kinds of row land here and they are all real answers: a piece with
     * no listing anywhere and no craftable path, a guild shrine level whose
     * credits could not be valued, and a community buff level, which nobody
     * buys at all. What they share is that the Cost column has nothing to put
     * in it — so they carry no gold-per figure, cannot be scored, and cannot be
     * planned against a budget.
     *
     * They used to sit in the main table at cost Infinity, which sorted them
     * underneath the regressions. A reader scanning from the top saw the ranked
     * upgrades, then the things that made the character worse, and then these —
     * indistinguishable from more of the same. Their deltas are measured just
     * as carefully as any other row's; only the price is missing, and that is
     * what this box says.
     *
     * @param {Array<Object>} rows - Results whose cost is null
     * @param {Object} baseline - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUnpricedUpgradeTable(rows, baseline) {
        if (!this._unpricedSort) this._unpricedSort = { key: 'dps', asc: true };
        const { key: sortKey, asc: sortAsc } = this._unpricedSort;

        const sortValue = (r) => {
            switch (sortKey) {
                case 'upgrade':
                    return r.candidate.description.toLowerCase();
                case 'why':
                    return (r.costDetail?.unpriced || []).join(',');
                case 'xp':
                    return -(r.deltas?.xp ?? 0);
                case 'profit':
                    return -(r.deltas?.profit ?? 0);
                default:
                    return -(r.deltas?.dps ?? 0);
            }
        };
        const sorted = sortRowsBy(rows, sortValue, sortAsc);

        const thStyle =
            'padding:4px 6px; text-align:left; border-bottom:1px solid #333; color:#888; font-weight:600; ' +
            'cursor:pointer; user-select:none; white-space:nowrap;';
        const tdStyle = 'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap;';
        const arrow = (k) => (sortKey === k ? (sortAsc ? ' ▴' : ' ▾') : '');

        // Greyed rather than coloured when the delta is inside the run's own
        // error, so an unpriced row cannot imply a finding it did not make
        const cell = (r, key) => {
            const value = r.deltas?.[key];
            if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return '<span style="color:#888;">—</span>';
            const { significant } = upgradeNoiseFor(r, key);
            const color = !significant ? '#888' : value > 0 ? '#8bc34a' : '#f44336';
            return `<span style="color:${color};">${value > 0 ? '+' : ''}${value.toFixed(2)}%</span>`;
        };

        let html = `<div style="margin-top:14px; padding:8px 10px; background:#0d0d1a; border:1px solid #2a2a4a; border-radius:6px;">
            <div style="color:${ACCENT}; font-size:12px; font-weight:600; margin-bottom:2px;">Measured, but not priced</div>
            <div style="color:#666; font-size:10px; margin-bottom:6px;">
                Simulated the same way as everything above; only the gold is missing, so these cannot be ranked by
                value, scored, or bought by the budget planner. The deltas are real.
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                <th style="${thStyle}" data-unpriced-sort-key="upgrade">Upgrade${arrow('upgrade')}</th>
                <th style="${thStyle}" data-unpriced-sort-key="why">Why no price${arrow('why')}</th>
                <th style="${thStyle}" data-unpriced-sort-key="dps">ΔDPS${arrow('dps')}</th>
                <th style="${thStyle}" data-unpriced-sort-key="xp">ΔEXP${arrow('xp')}</th>
                <th style="${thStyle}" data-unpriced-sort-key="profit">ΔProfit${arrow('profit')}</th>
            </tr></thead><tbody>`;

        sorted.forEach((r, i) => {
            const rowKey = upgradeRowKey(r);
            const missing = r.costDetail?.unpriced?.length
                ? `no listing for ${r.costDetail.unpriced.join(', ')}`
                : r.candidate?.type === 'community_buff'
                  ? 'not a purchase — nobody buys a community buff level'
                  : r.candidate?.type === 'scroll'
                    ? 'a per-run seal cost the advisor does not price'
                    : 'no price could be resolved';

            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-unpriced-row="${i}" data-row-key="${rowKey}">
                <td style="padding:4px 6px; border-bottom:1px solid #1a1a2e;">${r.candidate.description}${upgradeRowNotesHtml(r)}</td>
                <td style="${tdStyle} color:#888;">${missing}</td>
                <td style="${tdStyle}">${cell(r, 'dps')}</td>
                <td style="${tdStyle}">${cell(r, 'xp')}</td>
                <td style="${tdStyle}">${cell(r, 'profit')}</td>
            </tr>
            <tr data-unpriced-detail="${i}" data-row-key="${rowKey}" style="display:none;">
                <td colspan="5" style="padding:6px 12px; background:#0a0a14; border-bottom:1px solid #222;">
                    ${this._renderUpgradeDetailCells(r, baseline)}
                </td>
            </tr>`;
        });

        return html + '</tbody></table></div>';
    }

    /**
     * The shopping list a budget buys, above the table it came from.
     *
     * The table answers "what is the best single thing"; nobody buys one thing.
     * This answers the question people actually have — "I have 500M, what should
     * I get" — by walking the ranked list and taking what fits. Exclusivity is by
     * what a purchase actually competes with rather than by kind: two chestpieces
     * fight over one slot, two targets for one ability are the same purchase
     * twice, and two *different* abilities are simply two purchases, so a plan
     * can hold as many of them as the budget covers.
     *
     * @param {Array<Object>} rows - Purchasable upgrade results
     * @param {Object} baseline - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeBudget(rows, baseline) {
        const budget = this._upgradeBudget ?? 0;
        const metricKey = this._upgradePlanMetric || UPGRADE_PLAN_METRICS[0].key;
        const money = (value) => formatKMB(Math.round(value));
        const inputStyle =
            'width:90px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; ' +
            'padding:2px 6px; font-size:11px; font-family:inherit;';
        const btnStyle =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit;';
        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; ' +
            'padding:2px 4px; font-size:11px; font-family:inherit;';

        let body = '';
        if (budget > 0) {
            const plan = planUpgradeBudget(rows, budget, { baseline, metricKey });
            if (!plan.picks.length) {
                body = `<div style="color:#888; font-size:11px;">Nothing in the list both fits ${money(budget)}
                    and improves ${plan.metric.label}.</div>`;
            } else {
                const picks = plan.picks
                    .map(
                        (pick) => `<div style="display:flex; justify-content:space-between; gap:10px; padding:1px 0;">
                            <span style="color:#e0e0e0;">${pick.candidate.description}</span>
                            <span style="white-space:nowrap; color:#aaa;">${money(pick.cost)}
                                <span style="color:#4caf50;">${plan.metric.format(pick.marginalAttemptsSaved)}</span>
                            </span>
                        </div>`
                    )
                    .join('');
                // A plan built from gains that never cleared their error bar is
                // still the best reading of what was measured — it just must not
                // be presented as a measurement
                const provisional = plan.provisional
                    ? `<div style="margin-top:4px; color:#e8a87c; font-size:10px; line-height:1.35;"
                        title="Every gain on this axis is smaller than the simulation's own sampling error, so
                        nothing here is proven. Ranked on the point estimates, which is the best the run can say.
                        Simulate for longer to separate them.">Ranked on estimates: no gain on
                        ${plan.metric.label} clears the run's error bar.</div>`
                    : '';
                body =
                    picks +
                    `<div style="margin-top:4px; padding-top:4px; border-top:1px solid #222; color:#aaa; font-size:11px;">
                        ${plan.picks.length} upgrade${plan.picks.length === 1 ? '' : 's'} ·
                        ${money(plan.totalCost)} of ${money(budget)} ·
                        <span style="color:#4caf50; font-weight:600;">${plan.metric.format(plan.gainTotal)}</span>
                        <span style="color:#666;"> if gains in different slots add up</span>
                    </div>${provisional}`;
            }
        }

        const options = UPGRADE_PLAN_METRICS.map(
            (m) => `<option value="${m.key}"${m.key === metricKey ? ' selected' : ''}>${m.label}</option>`
        ).join('');

        return `<div id="mwi-csim-upgrade-budget" style="margin-bottom:8px; padding:6px 8px; background:#0d0d1a;
            border:1px solid #222; border-radius:4px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:11px; color:#888; flex-wrap:wrap;">
                <span style="color:${ACCENT}; font-weight:700;">Budget</span>
                <input id="mwi-csim-budget-input" type="text" inputmode="numeric" placeholder="e.g. 500m"
                    value="${this._upgradeBudgetText || ''}" style="${inputStyle}">
                <span style="color:#666;">for</span>
                <select class="toolasha-select" id="mwi-csim-budget-metric" style="${selectStyle}">${options}</select>
                <button id="mwi-csim-budget-plan" style="${btnStyle}">Plan</button>
                <span style="color:#555;" title="Two pieces for one equipment slot cannot both be worn, and two
                    targets for one ability are the same purchase twice — so the plan takes the better of each.
                    Different abilities are different purchases and can all be in the same plan.">best set that
                    fits — one per slot, one per ability</span>
            </div>
            ${body ? `<div style="margin-top:6px;">${body}</div>` : ''}
        </div>`;
    }

    /**
     * Make the budget box work: parse what was typed and re-render on Plan, on
     * Enter, or when the axis being shopped for changes.
     * @param {HTMLElement} container - Upgrade results container
     * @private
     */
    _wireUpgradeBudget(container) {
        const input = container.querySelector('#mwi-csim-budget-input');
        const select = container.querySelector('#mwi-csim-budget-metric');
        const replan = () => {
            this._upgradeBudgetText = input?.value || '';
            const typed = parseKMB(this._upgradeBudgetText);
            this._upgradeBudget = Number.isFinite(typed) ? typed : 0;
            this._upgradePlanMetric = select?.value || UPGRADE_PLAN_METRICS[0].key;
            this._renderUpgradeResults(this._upgradeResultsData);
        };

        container.querySelector('#mwi-csim-budget-plan')?.addEventListener('click', replan);
        select?.addEventListener('change', replan);
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') replan();
        });
    }

    /**
     * Which detail rows are open, by candidate rather than by position.
     * @param {HTMLElement} container - Upgrade results container
     * @returns {Set<string>} Row keys whose detail row is showing
     * @private
     */
    _openUpgradeDetails(container) {
        const open = new Set();
        container
            .querySelectorAll('[data-upgrade-detail], [data-level-detail], [data-unpriced-detail]')
            .forEach((detail) => {
                const key = detail.getAttribute('data-row-key');
                if (key && detail.style.display !== 'none') open.add(key);
            });
        return open;
    }

    /**
     * Render upgrade analysis results: the food card, the gold-cost table, and
     * combat levels in their own box.
     *
     * Every sort click, column toggle and re-score comes back through here and
     * rebuilds the container's HTML wholesale, which by itself throws away two
     * things the table was holding: the detail rows you had opened, and where you
     * had scrolled to. Both are read off the old DOM first and put back after —
     * the expansions by candidate key, since their row numbers are exactly what
     * a sort changes.
     *
     * @param {Object} results - { baseline, results: [{candidate, cost, metrics, deltas, goldPer}], food }
     * @private
     */
    /**
     * Restore the last Upgrade-tab results after a refresh, when the option is on
     * and a fresh run has not already drawn its own. Fire-and-forget from panel
     * open; draws into the (possibly hidden) Upgrade tab so the results are there
     * when the tab is next shown.
     * @private
     */
    async _restoreUpgradeResults() {
        try {
            if (this._upgradeResultsData) return;
            const payload = await loadUpgradeResults(UPGRADE_RESULTS_KEY);
            if (!payload || this._upgradeResultsData) return;
            if (!this.panel?.querySelector('#mwi-csim-upgrade-results')) return;
            this._restoredUpgradeAt = payload.savedAt || null;
            this._restoredUpgradeMeta = {
                characterName: payload.characterName || null,
                zoneName: payload.zoneName || null,
                difficultyTier: payload.difficultyTier,
            };
            this._renderUpgradeResults(payload.data);
        } catch (error) {
            console.error('[CombatSimUI] Restoring upgrade results failed:', error);
        }
    }

    /**
     * A quiet banner saying the shown results are remembered from a previous run.
     * @param {number} savedAt - Epoch ms the results were saved
     * @returns {string} HTML
     * @private
     */
    _restoredUpgradeNote(savedAt, meta = null) {
        const when = savedAt ? new Date(savedAt).toLocaleString() : 'a previous session';
        // A payload from before these fields existed renders the old sentence
        const zone = meta?.zoneName
            ? `${meta.zoneName}${Number.isFinite(meta.difficultyTier) ? ` (T${meta.difficultyTier})` : ''}`
            : null;
        const who = [meta?.characterName, zone].filter(Boolean).map(escapeAttribute).join(', ');
        return (
            `<div style="margin:0 0 8px; padding:5px 8px; font-size:11px; color:#9ab; display:flex; ` +
            `align-items:center; justify-content:space-between; gap:8px; ` +
            `background:rgba(120,150,190,0.10); border:1px solid rgba(120,150,190,0.25); border-radius:5px;">` +
            `<span>Showing results remembered from ${when}${who ? ` — ${who}` : ''}. Run a new analysis to refresh them.</span>` +
            `<button data-clear-remembered-upgrade title="Forget these remembered results. Does not affect a running analysis." ` +
            `style="flex:0 0 auto; background:transparent; color:#9ab; border:1px solid rgba(120,150,190,0.4); ` +
            `border-radius:3px; padding:1px 6px; font-size:10px; cursor:pointer; font-family:inherit;">Clear</button>` +
            `</div>`
        );
    }

    _renderUpgradeResults(results) {
        const container = this.panel.querySelector('#mwi-csim-upgrade-results');
        if (!container) return;

        const openDetails = this._openUpgradeDetails(container);
        const priorScroll = container.scrollTop;

        const foodHtml = results.food ? this._renderFoodRecommendation(results.food) : '';

        if (!results.results.length) {
            container.innerHTML =
                foodHtml ||
                `<div style="color:#888; text-align:center; padding:20px;">No upgrade candidates found. Ensure equipment is configured.${this._houseScanNote(results.houseScan)}</div>`;
            return;
        }

        this._upgradeResultsData = results;
        // The analysis scores with the defaults; re-rank here so a saved score
        // selection applies to results that were computed before it was loaded
        this._rescoreUpgrades();
        const levelRows = results.results.filter((r) => r.candidate?.type === 'combat_level');
        const purchasable = results.results.filter((r) => r.candidate?.type !== 'combat_level');
        // A row with no price is not a bad row, and it used to be shown as one:
        // sorted into the same table with cost Infinity, it sank to the bottom
        // beside the genuine regressions with nothing to say it was there for a
        // different reason. Its measured deltas are perfectly good — it is only
        // the gold that is missing — so it gets its own group where the deltas
        // can be read without a value ranking they cannot take part in.
        const goldRows = purchasable.filter((r) => r.cost != null);
        const unpricedRows = purchasable.filter((r) => r.cost == null);

        let html = foodHtml;
        if (this._restoredUpgradeAt) {
            html = this._restoredUpgradeNote(this._restoredUpgradeAt, this._restoredUpgradeMeta) + html;
        }
        if (goldRows.length) html += this._renderUpgradeBudget(goldRows, results.baseline);
        if (goldRows.length) html += this._renderUpgradeGoldTable(goldRows, results.baseline);
        if (levelRows.length) html += this._renderUpgradeLevelTable(levelRows, results.baseline);
        if (unpricedRows.length) html += this._renderUnpricedUpgradeTable(unpricedRows, results.baseline);
        container.innerHTML = html;

        // Reopen what was open. Walked rather than selected by attribute, because
        // these keys carry item names — a quote in one would end the selector
        // early. A candidate that has since dropped out of the results simply has
        // no row to reopen, which is the right outcome.
        if (openDetails.size) {
            container
                .querySelectorAll('[data-upgrade-detail], [data-level-detail], [data-unpriced-detail]')
                .forEach((detail) => {
                    if (openDetails.has(detail.getAttribute('data-row-key'))) detail.style.display = 'table-row';
                });
        }

        // Row click expands the metric detail; the two tables keep separate
        // namespaces so a row in one never toggles a row in the other
        const wireRows = (rowAttr, detailAttr) => {
            container.querySelectorAll(`[${rowAttr}]`).forEach((row) => {
                row.addEventListener('click', () => {
                    const detail = container.querySelector(`[${detailAttr}="${row.getAttribute(rowAttr)}"]`);
                    if (detail) {
                        detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                    }
                });
            });
        };
        wireRows('data-upgrade-row', 'data-upgrade-detail');
        wireRows('data-level-row', 'data-level-detail');
        wireRows('data-unpriced-row', 'data-unpriced-detail');

        // Header click sorts that table (second click flips direction)
        const wireSort = (attr, stateKey) => {
            container.querySelectorAll(`[${attr}]`).forEach((th) => {
                th.addEventListener('click', () => {
                    // Sorting is the table talking, not the menu — get it out of the way
                    this._setUpgradeColumnMenuOpen(false);
                    const key = th.getAttribute(attr);
                    if (this[stateKey].key === key) {
                        this[stateKey].asc = !this[stateKey].asc;
                    } else {
                        this[stateKey] = { key, asc: true };
                    }
                    // A sort is a standing preference the same way the shown
                    // columns are — worth having the table open the same way
                    // next time rather than snapping back to Score every visit
                    this._persistUpgradeColumnPrefs();
                    this._renderUpgradeResults(this._upgradeResultsData);
                });
            });
        };
        wireSort('data-sort-key', '_upgradeSort');
        wireSort('data-level-sort-key', '_upgradeLevelSort');
        wireSort('data-unpriced-sort-key', '_unpricedSort');

        // Forgets the saved run only — the table on screen came from this
        // render call and stays right there; there is simply nothing left to
        // restore on the next reload.
        const clearBtn = container.querySelector('[data-clear-remembered-upgrade]');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                clearBtn.disabled = true;
                await clearUpgradeResults(UPGRADE_RESULTS_KEY);
                this._restoredUpgradeAt = null;
                this._restoredUpgradeMeta = null;
                clearBtn.closest('div')?.remove();
            });
        }
        this._wireUpgradeColumnMenu(container);
        this._wireUpgradeBudget(container);
        wireUpgradeRowActions(container);

        // Every measured figure, whatever the ⚙ menu is currently showing — the
        // point of a spreadsheet is the columns you did not think to look at
        this._addCsvExport(container, 'combatsim-upgrades', () => ({
            columns: [
                { key: 'upgrade', label: 'Upgrade' },
                { key: 'type', label: 'Type' },
                { key: 'cost', label: 'Cost' },
                { key: 'costSource', label: 'Cost basis' },
                { key: 'score', label: 'Score' },
                { key: 'dps', label: 'DPS' },
                { key: 'xpPerHour', label: 'XP/hr' },
                { key: 'profitPerHour', label: 'Profit/hr' },
                { key: 'encountersPerHour', label: 'Encounters/hr' },
                { key: 'deathsPerHour', label: 'Deaths/hr' },
                { key: 'dpsPct', label: 'DPS change %' },
                { key: 'xpPct', label: 'XP change %' },
                { key: 'profitPct', label: 'Profit change %' },
                { key: 'encountersPct', label: 'Encounters change %' },
                { key: 'deathsPct', label: 'Deaths change %' },
                { key: 'goldPerDps', label: 'Gold/0.01% DPS' },
                { key: 'goldPerXp', label: 'Gold/0.01% EXP' },
                { key: 'goldPerProfit', label: 'Gold/0.01% Profit' },
                { key: 'goldPerEncounters', label: 'Gold/0.01% EPH' },
                { key: 'goldPerDeaths', label: 'Gold/0.01% DPH' },
                { key: 'profitGainPerHour', label: 'Profit gain/hr' },
                { key: 'paybackHours', label: 'Hours to afford' },
                { key: 'repayHours', label: 'Hours to repay' },
                { key: 'roiAnnualPct', label: 'ROI 1yr %' },
                { key: 'levelTimeHours', label: 'Hours to level' },
                { key: 'dpsNoisePct', label: 'DPS error ±%' },
                { key: 'profitNoisePct', label: 'Profit error ±%' },
                { key: 'measured', label: 'Clears the noise' },
            ],
            // Infinity is not a number a spreadsheet can hold; blank says the
            // same thing ("never repays") without pretending to be a measurement
            rows: (this._upgradeResultsData?.results || []).map((r) => {
                const finite = (value) => (Number.isFinite(value) ? value : null);
                return {
                    upgrade: r.candidate?.description || '',
                    type: r.candidate?.type || 'equipment',
                    cost: finite(r.cost),
                    costSource: r.costSource || '',
                    score: r.score ?? null,
                    dps: finite(r.metrics?.dps),
                    xpPerHour: finite(r.metrics?.xpPerHour),
                    profitPerHour: finite(r.metrics?.profitPerHour),
                    encountersPerHour: finite(r.metrics?.encountersPerHour),
                    deathsPerHour: finite(r.metrics?.deathsPerHour),
                    dpsPct: finite(r.deltas?.dps),
                    xpPct: finite(r.deltas?.xp),
                    profitPct: finite(r.deltas?.profit),
                    encountersPct: finite(r.deltas?.encounters),
                    deathsPct: finite(r.deltas?.deaths),
                    goldPerDps: finite(r.goldPer?.dps),
                    goldPerXp: finite(r.goldPer?.xp),
                    goldPerProfit: finite(r.goldPer?.profit),
                    goldPerEncounters: finite(r.goldPer?.encounters),
                    goldPerDeaths: finite(r.goldPer?.deaths),
                    profitGainPerHour: finite(r.economics?.profitGainPerHour),
                    paybackHours: finite(r.economics?.paybackHours),
                    repayHours: finite(r.economics?.repayHours),
                    roiAnnualPct: finite(r.economics?.roiAnnualPct),
                    levelTimeHours: finite(r.levelTimeHours),
                    dpsNoisePct: finite(r.noise?.dps),
                    profitNoisePct: finite(r.noise?.profit),
                    measured: r.significant === undefined ? '' : r.significant ? 'yes' : 'no',
                };
            }),
        }));

        // Last, after the export bar has been inserted and the reopened details
        // have taken their height back — restoring earlier would clamp against a
        // shorter table and land you somewhere above where you were
        container.scrollTop = priorScroll;
    }

    /**
     * Wire the ⚙ Columns popover: toggling, visibility, and score membership.
     * @param {HTMLElement} container - Upgrade results container
     * @private
     */
    _wireUpgradeColumnMenu(container) {
        const button = container.querySelector('#mwi-csim-upgrade-cols-btn');
        const menu = container.querySelector('#mwi-csim-upgrade-cols-menu');
        if (!button || !menu) return;

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this._setUpgradeColumnMenuOpen(!this._upgradeColumnMenuOpen);
        });
        // Clicks inside must not close it, or every checkbox would shut the menu
        menu.addEventListener('click', (e) => e.stopPropagation());

        menu.querySelectorAll('[data-upgrade-col]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.getAttribute('data-upgrade-col');
                if (!this._upgradeHiddenColumns) this._upgradeHiddenColumns = new Set();
                if (input.checked) this._upgradeHiddenColumns.delete(key);
                else this._upgradeHiddenColumns.add(key);
                this._persistUpgradeColumnPrefs();
                this._renderUpgradeResults(this._upgradeResultsData);
            });
        });

        menu.querySelectorAll('[data-upgrade-score]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.getAttribute('data-upgrade-score');
                const keys = new Set(this._upgradeScoreKeys || DEFAULT_SCORE_KEYS);
                if (input.checked) keys.add(key);
                else keys.delete(key);
                this._upgradeScoreKeys = [...keys];
                this._persistUpgradeColumnPrefs();
                this._rescoreUpgrades();
                this._renderUpgradeResults(this._upgradeResultsData);
            });
        });

        menu.querySelector('#mwi-csim-score-depth')?.addEventListener('change', (event) => {
            this._upgradeScoreDepth = event.target.value || DEFAULT_SCORE_DEPTH;
            this._persistUpgradeColumnPrefs();
            this._rescoreUpgrades();
            this._renderUpgradeResults(this._upgradeResultsData);
        });

        // Colour only — the scores are unchanged, so there is nothing to re-rank
        menu.querySelector('#mwi-csim-score-gradient')?.addEventListener('change', (event) => {
            this._upgradeScoreGradient = Boolean(event.target.checked);
            this._persistUpgradeColumnPrefs();
            this._renderUpgradeResults(this._upgradeResultsData);
        });
    }

    /**
     * Open or close the ⚙ Columns popover.
     *
     * While open it holds one document-level listener so a click anywhere else
     * dismisses it; closing removes that listener again, so nothing accumulates.
     * The open flag survives re-renders on purpose — toggling a checkbox rebuilds
     * the table underneath and the menu should stay put while you configure —
     * but sorting closes it, since that is the table talking, not the menu, and
     * so does starting a new analysis. Closed is closed: `_renderUpgradeColumnMenu`
     * writes this flag into a single `display` declaration, which is what stops a
     * re-render from putting the menu back up on its own.
     *
     * @param {boolean} open - Desired state
     * @private
     */
    _setUpgradeColumnMenuOpen(open) {
        this._upgradeColumnMenuOpen = open;
        const menu = this.panel?.querySelector('#mwi-csim-upgrade-cols-menu');
        if (menu) menu.style.display = open ? 'flex' : 'none';

        if (open && !this._upgradeColumnMenuAway) {
            this._upgradeColumnMenuAway = () => this._setUpgradeColumnMenuOpen(false);
            document.addEventListener('click', this._upgradeColumnMenuAway);
        } else if (!open && this._upgradeColumnMenuAway) {
            document.removeEventListener('click', this._upgradeColumnMenuAway);
            this._upgradeColumnMenuAway = null;
        }
    }

    /**
     * Re-rank the stored results against the current score selection.
     *
     * Scoring is pure ranking over figures already measured, so changing what
     * counts never means re-running a simulation.
     * @private
     */
    _rescoreUpgrades() {
        const rows = this._upgradeResultsData?.results;
        if (!rows) return;
        const scorable = rows.filter((r) => r.candidate?.type !== 'combat_level');
        assignRankScores(scorable, {
            keys: this._upgradeScoreKeys || DEFAULT_SCORE_KEYS,
            places: scoreDepthPlaces(this._upgradeScoreDepth || DEFAULT_SCORE_DEPTH, scorable.length),
        });
    }

    /** @private */
    async _persistUpgradeColumnPrefs() {
        try {
            await storage.set(
                UPGRADE_COLUMNS_KEY,
                {
                    hidden: [...(this._upgradeHiddenColumns || DEFAULT_HIDDEN_COLUMNS)],
                    scored: this._upgradeScoreKeys || DEFAULT_SCORE_KEYS,
                    scoreDepth: this._upgradeScoreDepth || DEFAULT_SCORE_DEPTH,
                    scoreGradient: Boolean(this._upgradeScoreGradient),
                    sort: this._upgradeSort || null,
                    levelSort: this._upgradeLevelSort || null,
                    unpricedSort: this._unpricedSort || null,
                },
                'settings'
            );
        } catch (error) {
            console.error('[CombatSimUI] Failed to save upgrade column preferences:', error);
        }
    }

    /** @private */
    async _loadUpgradeColumnPrefs() {
        try {
            const saved = await storage.get(UPGRADE_COLUMNS_KEY, 'settings', null);
            if (!saved) return;
            this._upgradeHiddenColumns = new Set(Array.isArray(saved.hidden) ? saved.hidden : []);
            if (Array.isArray(saved.scored)) this._upgradeScoreKeys = saved.scored;
            // A depth key from a build that offered a different set is ignored
            // rather than trusted, so the column cannot end up scoring over a
            // ladder length nothing in the menu can name
            if (SCORE_DEPTHS.some((d) => d.key === saved.scoreDepth)) this._upgradeScoreDepth = saved.scoreDepth;
            this._upgradeScoreGradient = Boolean(saved.scoreGradient);
            // A sort key from a build that offered different columns is not
            // validated here — every sorter already falls back to its default
            // column for a key it does not recognise, the same way it always
            // has for a fresh panel with no saved sort at all
            const isSortShape = (s) => s && typeof s.key === 'string' && typeof s.asc === 'boolean';
            if (isSortShape(saved.sort)) this._upgradeSort = saved.sort;
            if (isSortShape(saved.levelSort)) this._upgradeLevelSort = saved.levelSort;
            if (isSortShape(saved.unpricedSort)) this._unpricedSort = saved.unpricedSort;
        } catch (error) {
            console.error('[CombatSimUI] Failed to load upgrade column preferences:', error);
        }
    }
}

const combatSimUI = new CombatSimUI();

/**
 * The cross-bundle handles, hung off the instance as well as exported.
 *
 * This module is one of the ones rollup replaces with a global: an import of it
 * from another bundle compiles to a property read off `Toolasha.Sim.combatSimUI`,
 * which is this object. A named import from another bundle would therefore read
 * `undefined` in the production bundles while working perfectly in the dev
 * standalone, which bundles everything and has no externals at all — so the
 * things other bundles need are reached through the default export.
 *
 * Same-bundle callers and tests use the named exports; both are the same
 * functions.
 */
Object.assign(combatSimUI, {
    loadAllZonesSnapshot,
    currentGearFingerprint,
    upgradeRowPurchase,
    upgradeRowActionsHtml,
    wireUpgradeRowActions,
});

export default combatSimUI;
