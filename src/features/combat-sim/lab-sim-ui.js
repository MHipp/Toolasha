/**
 * Lab Sim UI
 * Floating panel for configuring and running labyrinth simulations.
 * Four tabs: Configure (editor + crate selectors), Single Sim, Upgrade, Skilling.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    getCombatZones,
    getCommunityBuffs,
    getLabyrinthMonsters,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
} from './combat-sim-adapter.js';
import { runLabyrinthSimulation, cancelActiveSimulations } from './combat-sim-runner.js';
import { wilsonInterval } from './engine/wilson.js';
import { findMaxLabyrinthLevel, defaultThreshold } from './labyrinth-level-finder.js';
import {
    runLabyrinthUpgradeAnalysis,
    runLabyrinthAllFightsAnalysis,
    computeSkillingClearRatesFromEditor,
    runSkillingUpgradeAnalysis,
    getStyleExcludedSkills,
    planWithinBudget,
    goldPerPercent,
    runLabyrinthCombinationCheck,
    generateCandidates,
    generateHouseCandidates,
    describeHouseScan,
    houseRoomMovesWinRate,
    MAX_HOUSE_LEVEL,
    MAX_GUILD_SHRINE_LEVEL,
} from './upgrade-advisor.js';
import {
    LabComparisonStore,
    makeLabRunEntry,
    renderLabComparisonPanel,
    wireLabComparisonPanel,
} from './lab-sim-comparison.js';
import {
    LAB_UPGRADE_DIMENSIONS,
    LAB_SCOPES,
    LAB_LEVEL_SOURCES,
    sanitizeLabUpgradeSelection,
    sanitizeLabLevelSource,
    resolveLabTargetLevel,
    labScopeTargetCount,
    labDimensionAvailability,
    labAbilityLevelTypeAvailability,
    estimateLabUpgradeSims,
    planLabUpgradeRun,
} from './lab-sim-upgrade-modes.js';
import {
    LAB_TOKEN_BUFF_GROUPS,
    MAX_LAB_TOKEN_LEVEL,
    readLiveTokenLevels,
    sanitizeTokenLevels,
    resolveTokenLevels,
    buildLabyrinthCombatBuffs,
    describeTokenOverrides,
} from './lab-token-buffs.js';
import { scopeEquipmentToSkill } from './skilling-gear-candidates.js';
import { generateSkillingCommunityBuffCandidates, MAX_COMMUNITY_BUFF_LEVEL } from './skilling-sim-helpers.js';
// The upgrade-row vocabulary — what a row would have you buy, and the handoff
// buttons for it — belongs to the combat sim panel; a labyrinth pick is the same
// candidate shape, so it gets the same two buttons rather than a second pair.
//
// Through the default export rather than as named imports: this file is reached
// by a bundle that does not own the combat sim panel, and a cross-bundle named
// import compiles to a property read off a global that carries only the default.
import combatSimUI from './combat-sim-ui.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable } from '../../utils/floating-panel.js';
import {
    createMaterialTab,
    removeMaterialTabs,
    visibleTabsContainer,
    navigateToMarketplace,
    ensureClearAllTabsControl,
    setupMarketplaceCleanupObserver,
    watchTabForAcquisition,
} from '../../utils/marketplace-tabs.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { saveUpgradeResults, loadUpgradeResults, clearUpgradeResults } from './upgrade-results-store.js';
import { formatWithSeparator, formatKMB, parseKMB } from '../../utils/formatters.js';
import { createEtaTracker } from '../../utils/progress-eta.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { SimEditor } from './sim-editor.js';
import bundledLabyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import { labyrinthFloorClearLevel } from '../combat/labyrinth-formulas.js';
import { ROOM_LEVEL_SHORTLIST_SIZE } from './labyrinth-upgrade-levels.js';
import { labyrinthClearRate, loadoutSnapshot } from '../../utils/bundle-bridge.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';

const PANEL_ID = 'mwi-lab-sim-panel';

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
const GEOMETRY_KEY = 'labSimPanel';

/**
 * Storage key for the last Upgrade-tab results, remembered across refreshes
 * (opt-in). The `-fullkit` suffix orphans results persisted before lab sims
 * defaulted to the monster's full ability kit — a baseline computed against a
 * tier-0 subset monster must not be re-shown beside full-kit runs.
 */
const LAB_UPGRADE_RESULTS_KEY = 'labSimUpgradeResults-fullkit';

/** Floor sizes the resize grips will not take the panel below. */
const MIN_PANEL_WIDTH = 400;
const MIN_PANEL_HEIGHT = 300;

/** Which candidate sets the Upgrade tab has checked. */
const UPGRADE_DIMENSIONS_KEY = 'labSimUpgradeDimensions';

/** Which fights the Upgrade tab is weighing them for: `{ mode, monsters }`. */
const UPGRADE_SCOPE_KEY = 'labSimUpgradeScope';

/** Where the Configure-fight scope takes its room level from. */
const UPGRADE_LEVEL_SOURCE_KEY = 'labSimUpgradeLevelSource';

/**
 * Whether Ability Swaps is narrowed to the build guide's signature swaps.
 *
 * Remembered with the rest of the selection, and for the same reason: it is how
 * swaps should be ranked rather than something about one particular run, and an
 * unremembered narrowing means the next Analyze quietly costs several times as
 * much across a whole labyrinth.
 */
const UPGRADE_SWAP_AURA_KEY = 'labSimSwapAuraOnly';

/**
 * Whether the Guild Shrine set is capped to what the guild's own shrine
 * buildings can sell. Its own key, independent of Combat Sim's — the two
 * panels remember this choice separately. Defaults on: a shrine level the
 * guild cannot sell is not an upgrade anyone can buy.
 */
const SHRINE_CAP_GUILD_KEY = 'labSimShrineCapToGuild';

/**
 * Whether the Upgrade tab follows its win-rate pass with the room-level search.
 *
 * Off until asked for: the search is a binary search of simulations per
 * shortlisted candidate on top of what is already the panel's dearest run, and
 * the table it adds to is exactly today's while it is off.
 */
const UPGRADE_ROOM_LEVELS_KEY = 'labSimUpgradeRoomLevels';

/** The floor the room-level pass is aiming at, 0 for none. */
const UPGRADE_TARGET_FLOOR_KEY = 'labSimUpgradeTargetFloor';

/**
 * Labyrinth token levels the Configure tab is simulating under.
 *
 * Only the ones typed over the live run are stored, so a character who buys the
 * level they were exploring stops being told they differ from themselves — an
 * override equal to what is owned is simply an override that no longer shows.
 * Scoped per character alongside the rest of this tab's configuration, because
 * the tokens are a character's own and an alt has bought different ones.
 */
const TOKEN_BUFF_LEVELS_KEY = 'labSimTokenBuffLevels';

/**
 * The retired single `Mode` dropdown's value.
 *
 * Read once, on the way to the new keys, so anyone who had a mode remembered
 * lands on the equivalent dimension-and-scope selection instead of on the
 * defaults. Never written.
 */
const LEGACY_UPGRADE_MODE_KEY = 'labSimUpgradeMode';

/** What a skilling upgrade row is actually paid for with, for the CSV column. */
const CSV_PAID_IN = {
    token: 'tokens',
    guild: 'credits + tokens',
    community: 'donated cowbells',
    gold: 'gold',
};

/** The skills the labyrinth runs a skilling room for, in the tab's own order. */
const SKILLING_SKILL_HRIDS = [
    '/skills/milking',
    '/skills/foraging',
    '/skills/woodcutting',
    '/skills/cheesesmithing',
    '/skills/crafting',
    '/skills/tailoring',
    '/skills/cooking',
    '/skills/brewing',
    '/skills/alchemy',
    '/skills/enhancing',
];

/**
 * The house-room option every labyrinth analysis passes.
 *
 * This tab ranks one number — the share of attempts that end in a clear — so the
 * rooms it can weigh are the rooms whose buffs can change a fight's outcome.
 * Every house room grants a global experience and rare-find buff for existing at
 * all, and admitting a room on those put all ten skilling rooms in a combat
 * table with nothing but the baseline's sampling noise to report.
 */
const HOUSE_WIN_RATE_ONLY = { winRateOnly: true };

/**
 * What to call an item, falling back to a readable form of its own hrid.
 * @param {string} hrid - Item hrid
 * @returns {string} Display name
 */
function itemName(hrid) {
    return (
        dataManager.getItemDetails?.(hrid)?.name ||
        String(hrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/**
 * Make text safe to sit inside a double-quoted HTML attribute.
 * Item names come from game data, and one apostrophe would end the attribute.
 * @param {string} value - Raw text
 * @returns {string} Escaped text
 */
function escapeHtmlAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Why a forced labyrinth armor swap does not credit the resale of what it
 * replaces: the run wants every element available, so the replaced set is kept.
 * A setting exists because these two really are alternatives.
 */
const KEPT_REASON_LABYRINTH =
    'since the labyrinth needs every set. Turn off "Keep gear the forced armor swaps replace" in settings to ' +
    'price these as straight swaps.';

/**
 * Why a *skilling* piece does not credit it. Different answer, and deliberately
 * not a setting: the body slot holds a plate while you fight and an outfit while
 * you chop, and nobody sells the plate to buy the outfit — so there is no second
 * position to switch to.
 */
const KEPT_REASON_SKILLING =
    'since it is combat gear you keep in a loadout — selling it to fund skilling gear is not a trade anybody makes.';

/**
 * The Cost cell of a gold row, in the wording the all-fights table uses.
 *
 * Four different things used to render as the same em dash or as a bare
 * negative number: a price, a free row, a row funded by its own resale, and a
 * row nobody could price. `cost ? formatWithSeparator(cost) : '—'` blanked the
 * free ones and printed the credit-funded ones as "-17,700,000", which reads as
 * a cost rather than as money coming back.
 *
 * @param {number|null|undefined} cost - Net coin cost; negative is a credit
 * @returns {string} Cell text
 */
function goldCostCell(cost) {
    if (cost > 0) return formatWithSeparator(cost);
    if (cost === 0) return 'free';
    return Number.isFinite(cost) ? `+${formatKMB(-cost)} back` : '—';
}

/**
 * The Gold/1% cell for a row, alongside the figure it sorts on.
 *
 * @param {number|null|undefined} cost - Net coin cost
 * @param {number} deltaPct - Improvement in percentage points
 * @returns {string} Cell text
 */
function goldPerPctCell(cost, deltaPct) {
    const value = goldPerPercent(cost, deltaPct);
    if (!Number.isFinite(value)) return '—';
    return value <= 0 ? 'pays for itself' : formatWithSeparator(value);
}

const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

/** Shared styling for the small inputs and buttons inside an upgrade chip. */
const CHIP_INPUT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:3px 5px; font-size:12px;';
const CHIP_BUTTON_STYLE =
    'background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 8px; border-radius:4px; ' +
    'font-size:11px; cursor:pointer; font-family:inherit;';

/**
 * Options that belong to one candidate set, drawn inside that set's chip.
 *
 * Same arrangement as the combat sim panel: an option sits with the checkbox it
 * modifies, so it is never ambiguous which box the +Levels box is about. They
 * stay in the DOM while their set is unchecked and are hidden by
 * `_onUpgradeSelectionChanged`.
 */
const LAB_MODE_OPTIONS = {
    ability_level: `
        <span id="mwi-labsim-upgrade-level-group" data-lab-mode-options="ability_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <select class="toolasha-select" id="mwi-labsim-upgrade-level-type" style="${CHIP_INPUT_STYLE}">
                <option value="increment">+Levels</option>
                <option value="target">Target Lv</option>
            </select>
            <input id="mwi-labsim-upgrade-target-level" type="number" min="1" max="200" value="5" style="
                width:55px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Number of levels to add to each ability">
            <button id="mwi-labsim-ability-targets-toggle" title="Set a desired target level per ability instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    ability_swap: `
        <span id="mwi-labsim-swap-group" data-lab-mode-options="ability_swap" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label id="mwi-labsim-swap-aura-label" title="Sim only the aura swap: the guide's aura group for the loadout's archetype, both sides of its OR — Critical Aura or Mystic Aura for magic, Critical Aura or Fierce Aura for melee/ranged, Invincible for a wark. Everything else in the guide's set is left out, which is most of the run. Across several fights each loadout is read for its own archetype, so a labyrinth mixing a melee and a magic loadout gets each build's own aura choice." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-labsim-swap-aura-only" style="margin:0; cursor:pointer;">
                Aura only
            </label>
        </span>`,
    combat_level: `
        <span id="mwi-labsim-combat-group" data-lab-mode-options="combat_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <button id="mwi-labsim-combat-targets-toggle" title="Set a desired target level per skill instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    house: `
        <span id="mwi-labsim-house-group" data-lab-mode-options="house" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-house-target-level" type="number" min="1" max="${MAX_HOUSE_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Buy every room up to this level in one row — Lv2 → Lv5 is costed at levels 3, 4 and 5 together. Blank means one level up. Capped at ${MAX_HOUSE_LEVEL}.">
            <button id="mwi-labsim-house-targets-toggle" title="Set a target level per room instead of one number for all of them" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    guild_shrine: `
        <span id="mwi-labsim-shrine-group" data-lab-mode-options="guild_shrine" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-shrine-target-level" type="number" min="1" max="${MAX_GUILD_SHRINE_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Buy every shrine buff up to this level in one row, costed at every level in between. Blank means one level up. Capped at each buff's own maximum.">
            <button id="mwi-labsim-shrine-targets-toggle" title="Set a target level per shrine instead of one number for all of them" style="${CHIP_BUTTON_STYLE}">Targets</button>
            <label id="mwi-labsim-shrine-cap-label" title="Only rank shrine levels your guild's shrine buildings can actually sell you: a shrine the guild has not built is left out entirely, and one built to Lv4 stops at Lv4. Uncheck to plan against shrines the guild would have to upgrade first — those rows say so." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-labsim-shrine-cap-guild" checked style="margin:0; cursor:pointer;">
                Guild-allowed only
            </label>
        </span>`,
    community_buff: `
        <span id="mwi-labsim-community-group" data-lab-mode-options="community_buff" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-community-target-level" type="number" min="1" max="${MAX_COMMUNITY_BUFF_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Sim the buff at this level rather than one level up — Lv3 → Lv8 in one row. Capped at ${MAX_COMMUNITY_BUFF_LEVEL}, which is what the game calls max. The cowbell figure is per minute of uptime either way; a level has no price of its own.">
        </span>`,
};

/**
 * Display name for a guild shrine, from its hrid.
 *
 * The same reading `generateGuildShrineCandidates` gives its rows, so a target
 * input and the row it produces name the same shrine the same way.
 * @param {string} shrineHrid - e.g. `/guild_shrines/force`
 * @returns {string} e.g. `Force`
 */
function shrineDisplayName(shrineHrid) {
    const slug = String(shrineHrid || '')
        .split('/')
        .filter(Boolean)
        .pop();
    if (!slug) return 'Shrine';
    return slug
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(0);
    return `${m}m ${s}s`;
}

/**
 * The purchases a budget plan comes to, deduplicated.
 *
 * Two picks can name the same item at the same enhancement — a plan covering
 * several loadouts often does — and a shopping list with the same tab twice is
 * a shopping list nobody trusts.
 *
 * @param {Array<Object>} picks - Picks from `planWithinBudget`
 * @returns {Array<Object>} From `upgradeRowPurchase`, in plan order
 */
function planPurchases(picks) {
    const seen = new Set();
    const items = [];

    for (const pick of picks || []) {
        const buy = combatSimUI.upgradeRowPurchase(pick);
        if (!buy) continue;

        const key = `${buy.itemHrid}+${buy.enhancementLevel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(buy);
    }

    return items;
}

/**
 * Tabs `openPlanInMarketplace` has pinned to the marketplace, so the cleanup
 * observer below has something to watch. Cleared (not reassigned) whenever the
 * tabs themselves are cleared, so the observer's reference to this array stays
 * valid.
 */
const marketPlanTabs = [];

/** Whether `setupMarketplaceCleanupObserver` has been started for `marketPlanTabs`. */
let marketPlanCleanupStarted = false;

/**
 * Drop every tab this panel pinned, and the bookkeeping array alongside them —
 * called both when the marketplace is closed out from under them and when the
 * user clears them by hand, so neither path leaves the other thinking tabs are
 * still live.
 */
function clearMarketPlanTabs() {
    removeMaterialTabs();
    marketPlanTabs.length = 0;
}

/**
 * Wait for the marketplace's own tab bar to exist.
 *
 * Polled rather than observed: `handleGoToMarketplace` renders asynchronously
 * and the bar we want is whichever one is on screen, which only
 * `visibleTabsContainer` can decide — and it can only decide it once.
 *
 * @param {number} [attempts] - How many 100 ms tries before giving up
 * @returns {Promise<HTMLElement|null>} The visible tab bar, or null
 */
async function waitForMarketplaceTabs(attempts = 30) {
    for (let i = 0; i < attempts; i++) {
        const container = visibleTabsContainer();
        if (container) return container;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
}

/**
 * Put the whole budget plan on the marketplace as tabs.
 *
 * The same machinery the missing-materials list uses: open the market on the
 * first item so the tab bar exists, then clone one tab per purchase, each of
 * which jumps to its own item. A plan is a shopping trip, and a shopping trip
 * with eight items should not be eight round trips through this panel.
 *
 * @param {Array<Object>} picks - Picks from `planWithinBudget`
 * @returns {Promise<number>} How many tabs were added
 */
async function openPlanInMarketplace(picks) {
    const items = planPurchases(picks);
    if (!items.length) return 0;

    navigateToMarketplace(items[0].itemHrid, items[0].enhancementLevel);

    const container = await waitForMarketplaceTabs();
    const reference = container
        ? Array.from(container.children).find((tab) => tab.textContent?.includes('My Listings'))
        : null;
    if (!reference) return 0;

    // Ours are the only custom tabs the market should be carrying
    clearMarketPlanTabs();
    container.style.flexWrap = 'wrap';

    for (const item of items) {
        const material = {
            // One of each is what a plan buys, so "missing 1" is literally the
            // count this list is asking you to acquire
            itemHrid: item.itemHrid,
            itemName: item.name,
            missing: 1,
            required: 1,
            isTradeable: true,
        };
        const tab = createMaterialTab(
            material,
            reference,
            () => navigateToMarketplace(item.itemHrid, item.enhancementLevel),
            {
                onDismiss: () => {
                    const idx = marketPlanTabs.indexOf(tab);
                    if (idx !== -1) marketPlanTabs.splice(idx, 1);
                },
            }
        );
        container.appendChild(tab);
        marketPlanTabs.push(tab);

        // Retire the tab on its own once the item is in inventory, instead of
        // leaving "missing: 1" pinned forever — see watchTabForAcquisition for
        // the enhancement-level matching this relies on.
        watchTabForAcquisition(tab, {
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel,
            requiredCount: 1,
            itemName: item.name,
            onRetire: () => {
                const idx = marketPlanTabs.indexOf(tab);
                if (idx !== -1) marketPlanTabs.splice(idx, 1);
            },
        });
    }

    ensureClearAllTabsControl(container, reference, () => {
        marketPlanTabs.length = 0;
    });

    // Started once, lazily — it only acts once `marketPlanTabs` is non-empty, so
    // there is nothing to watch before the first plan is ever opened.
    if (!marketPlanCleanupStarted) {
        marketPlanCleanupStarted = true;
        setupMarketplaceCleanupObserver(clearMarketPlanTabs, marketPlanTabs);
    }

    return items.length;
}

/**
 * The room-level cells one result row contributes, or null when the pass was
 * not run.
 *
 * A measured row reads `+0` rather than a blank or a dash: "we looked and it
 * does nothing" is the answer for most upgrades and is the one thing a ranking
 * in room levels must not hide.
 *
 * "We did not look" is a different answer, and only the shortlist is looked at
 * — so an unmeasured row reads as a muted dash instead, the same mark this
 * table already uses for a cell with no number in it. Printing `+0` there made
 * the two indistinguishable at a glance, which quietly turned "unranked" into
 * "worthless". Both keep the tooltip that spells out which they are.
 *
 * @param {Object} result - One result row, annotated by `measureRoomLevelGains`
 * @param {Object} roomLevels - The analysis's `roomLevels` summary
 * @returns {{delta: number, deltaStr: string, deltaColor: string, floor: number,
 *   floorStr: string, title: string, reachesTarget: boolean}}
 */
function roomLevelCells(result, roomLevels) {
    const delta = Math.round(Number(result.roomLevelDelta) || 0);
    const measured = Boolean(result.roomLevelMeasured);
    const baselineFloor = roomLevels?.baselineFloor || 0;
    const floor = measured ? result.floorReached || 0 : baselineFloor;
    const targetFloor = Math.max(0, Math.floor(Number(roomLevels?.targetFloor) || 0));
    const level = measured ? result.maxRoomLevel : roomLevels?.baselineLevel || 0;
    return {
        delta,
        // `delta` above is still 0 for an unmeasured row, so the ranking is
        // unchanged; only what the cell says about it is.
        deltaStr: measured ? (delta >= 0 ? '+' : '') + delta : '—',
        deltaColor: !measured ? '#666' : delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888',
        floor,
        floorStr: floor > 0 ? `F${floor}` : '\u2014',
        reachesTarget: targetFloor > 0 && floor >= targetFloor,
        title: measured
            ? `Clears room level ${level}, which finishes floor ${floor} (its exit room is level ` +
              `${labyrinthFloorClearLevel(floor)}).`
            : 'Not searched — this upgrade did not rank inside the measured shortlist, so it has no ' +
              'level figure at all. A dash here is not a measured zero.',
    };
}

class LabSimUI {
    constructor() {
        this.panel = null;
        this._editor = null;
        this._skillingEditor = null;
        this.isRunning = false;
        this._detachDrag = null;
        this.elapsedTimer = null;
        this._activeTab = 'configure';
        this._maxLevel = null;
        // Monster hrid → the level its last Find Max search cleared at. Per
        // monster because a max level belongs to a fight, not to the panel.
        this._maxLevelByMonster = {};
        this._labyFindMaxMode = false;
        this._labyResults = null;
        this._upgradeAborted = false;
        // Guards _onUpgradeAnalyze against a second click landing while the
        // first is still in the async window before the Run button is hidden
        // (e.g. the editor isn't ready yet and buildAllPlayerDTOs is awaited) —
        // without it, two concurrent runs share _upgradeAborted and both write
        // resultsEl/saveUpgradeResults, so the loser's Stop silently no-ops and
        // its results vanish under the winner's.
        this._upgradeRunning = false;
        this._skillingAborted = false;
        this._skillLoadouts = {};
        /**
         * The scoped key `_skillLoadouts` was read from, i.e. whose loadout
         * assignments are in memory. Null until the Skilling tab first loads
         * them; every write goes back to this key rather than to whoever is
         * current at the moment of the write.
         * @type {string|null}
         */
        this._skillLoadoutsKey = null;
        this._loadoutsCollapsed = true;
        this._upgradeSortHandler = null;
        this._skillingSortHandler = null;
        // Recorded single-target runs, so a fight can be read against the last
        // time it was asked rather than only against itself
        this._comparison = new LabComparisonStore();
        // Which labyrinth fights the target picker was last built from
        this._upgradeTargetHrids = null;
        // Labyrinth token levels typed over the live run's, buffKey → level.
        // Only the ones deliberately set: an empty object is "simulate what this
        // character actually owns", which is where every panel starts.
        this._tokenBuffOverrides = {};
    }

    buildPanel() {
        if (this.panel) return;

        // Labyrinth tile right-clicks request a preconfigured open via this event
        this._openRequestHandler = (e) => {
            this.openPreconfigured(e.detail || {});
        };
        document.addEventListener('mwi-labsim-open', this._openRequestHandler);

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
            width: min(900px, 96vw);
            height: min(700px, 84vh);
            min-width: min(400px, 92vw);
            min-height: 300px;
            max-width: 90vw;
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
            <span style="font-weight:700; font-size:14px; color:${ACCENT}; flex:1;">Lab Simulator</span>
            <button id="mwi-labsim-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">\u00d7</button>
        `;
        this._setupDrag(header);

        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.id = 'mwi-labsim-tabbar';
        tabBar.style.cssText = 'display:flex; gap:0; padding:0; flex-shrink:0; border-bottom:1px solid #222;';
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
            <button id="mwi-labsim-tab-configure" style="${tabStyle(true)}">Configure</button>
            <button id="mwi-labsim-tab-maxlevel" style="${tabStyle(false)}">Single Sim</button>
            <button id="mwi-labsim-tab-upgrade" style="${tabStyle(false)}">Upgrade</button>
            <button id="mwi-labsim-tab-skilling" style="${tabStyle(false)}">Skilling</button>
        `;

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; flex:1; min-width:0;';
        const inputStyle =
            'width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        // ── Configure tab ──
        const configureContent = document.createElement('div');
        configureContent.id = 'mwi-labsim-configure-content';
        configureContent.style.cssText = 'display:flex; flex-direction:column; flex:1; overflow:hidden;';

        const configureControls = document.createElement('div');
        configureControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        configureControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Monster</label>
            <select class="toolasha-select" id="mwi-labsim-monster" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Level</label>
            <input id="mwi-labsim-level" type="number" min="1" max="1300" value="100" style="${inputStyle}">
        `;

        const crateRow = document.createElement('div');
        crateRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
            font-size: 12px;
        `;
        const crateSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        crateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select class="toolasha-select" id="mwi-labsim-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Coffee</label>
            <select class="toolasha-select" id="mwi-labsim-coffee" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_coffee_crate">Basic</option>
                <option value="/items/advanced_coffee_crate">Advanced</option>
                <option value="/items/expert_coffee_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Food</label>
            <select class="toolasha-select" id="mwi-labsim-food" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_food_crate">Basic</option>
                <option value="/items/advanced_food_crate">Advanced</option>
                <option value="/items/expert_food_crate" selected>Expert</option>
            </select>
        `;

        const editorArea = document.createElement('div');
        editorArea.id = 'mwi-labsim-editor';
        editorArea.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';
        editorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        this._editor = new SimEditor({ editorEl: editorArea, labMode: true });

        configureContent.appendChild(configureControls);
        configureContent.appendChild(crateRow);

        // Collapsible Labyrinth Buffs section
        const buffsSection = document.createElement('div');
        buffsSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';

        const buffsHeader = document.createElement('div');
        buffsHeader.id = 'mwi-labsim-buffs-header';
        buffsHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        buffsHeader.innerHTML = `
            <span>Labyrinth Buffs</span>
            <span style="display:inline-flex; align-items:center; gap:8px;">
                <span id="mwi-labsim-buffs-note" style="color:#ffb74d; font-size:11px;"></span>
                <span id="mwi-labsim-buffs-toggle" style="font-size:10px;">\u25B6</span>
            </span>
        `;

        const buffsBody = document.createElement('div');
        buffsBody.id = 'mwi-labsim-buffs-body';
        buffsBody.style.cssText = 'display:none; padding:4px 14px 8px; font-size:11px;';

        buffsHeader.addEventListener('click', () => {
            const isOpen = buffsBody.style.display !== 'none';
            buffsBody.style.display = isOpen ? 'none' : 'block';
            this.panel.querySelector('#mwi-labsim-buffs-toggle').textContent = isOpen ? '\u25B6' : '\u25BC';
            if (!isOpen) this._renderBuffsSection();
        });

        buffsSection.appendChild(buffsHeader);
        buffsSection.appendChild(buffsBody);
        configureContent.appendChild(buffsSection);

        configureContent.appendChild(editorArea);

        // ── Max Level tab ──
        const maxLevelContent = document.createElement('div');
        maxLevelContent.id = 'mwi-labsim-maxlevel-content';
        maxLevelContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const maxLevelControls = document.createElement('div');
        maxLevelControls.style.cssText = `
            display: flex; align-items: center; gap: 12px;
            padding: 8px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        maxLevelControls.innerHTML = `
            <button id="mwi-labsim-run" style="
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Simulate</button>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Binary search for highest beatable level at the specified win rate threshold">
                <input type="checkbox" id="mwi-labsim-findmax" style="margin:0; cursor:pointer;">
                Find Max \u2265
            </label>
            <input id="mwi-labsim-threshold" type="number" min="1" max="100" value="${config.getSettingValue('labyrinthRecommendTargetRate', 70)}" style="width:44px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            <span style="color:#888; font-size:12px;">%</span>
            <span style="width:1px; height:16px; background:#333; margin:0 2px;"></span>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="How tightly to pin each fight's win rate down before its sim stops, in percentage points. A settled fight reaches it in a few hundred trials; one near a coin toss needs thousands. Lower is more accurate but slower.">
                Precision ±
                <input id="mwi-labsim-precision" type="number" min="0.1" max="10" step="0.5" value="${Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1))))}" style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
                <span style="font-size:12px;">%</span>
            </label>
            <span style="width:1px; height:16px; background:#333; margin:0 2px;"></span>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Stop the run after at most this many fights, whatever the precision. Tick Uncapped to ignore this.">
                Max fights
                <input id="mwi-labsim-maxfights" type="number" min="1" step="1000" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthSimMaxTrials', 20000)) || 20000)}" style="width:64px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Simulated-time ceiling for the run, in hours. Precision usually ends it first. Tick Uncapped to ignore this.">
                Max hrs
                <input id="mwi-labsim-maxhours" type="number" min="1" step="1" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthSimMaxHours', 24)) || 24)}" style="width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Ignore both caps above (the numbers stay put) and run until the precision target is met.">
                <input type="checkbox" id="mwi-labsim-uncapped" style="margin:0; cursor:pointer;"${config.getSettingValue('labyrinthSimUncapped', false) ? ' checked' : ''}>
                Uncapped
            </label>
        `;

        const maxLevelProgress = document.createElement('div');
        maxLevelProgress.id = 'mwi-labsim-progress';
        maxLevelProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        maxLevelProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0%</span>
                </div>
                <button id="mwi-labsim-stop" style="
                    background:rgba(255,80,80,0.2); color:#f44; border:1px solid rgba(255,80,80,0.4);
                    border-radius:4px; padding:2px 10px; font-size:11px; cursor:pointer; font-weight:600;">Stop</button>
            </div>
        `;

        const maxLevelResults = document.createElement('div');
        maxLevelResults.id = 'mwi-labsim-results';
        maxLevelResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        maxLevelContent.appendChild(maxLevelControls);
        maxLevelContent.appendChild(maxLevelProgress);
        maxLevelContent.appendChild(maxLevelResults);

        // ── Upgrade tab ──
        const upgradeContent = document.createElement('div');
        upgradeContent.id = 'mwi-labsim-upgrade-content';
        upgradeContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const upgradeControls = document.createElement('div');
        upgradeControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        // The shared select style is `flex:1; min-width:0`, which is right for a
        // row of two and wrong for this one: seven controls sharing the width
        // squeezed Player and Mode down to a caret and nothing else. These size
        // to their content with a floor, and the row wraps instead of crushing.
        const upgradeSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; ' +
            'padding:3px 6px; font-size:12px; flex:0 1 auto; min-width:150px; max-width:100%;';
        upgradeControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Player</label>
            <select class="toolasha-select" id="mwi-labsim-upgrade-player" style="${upgradeSelectStyle}"></select>
            <label style="color:#888; font-size:12px;">Include</label>
            ${LAB_UPGRADE_DIMENSIONS.map(
                (dimension) => `
            <span data-lab-mode-chip="${dimension.key}" style="display:inline-flex; align-items:center; gap:6px;
                padding:3px 8px; border:1px solid #2a2a4a; border-radius:6px;">
                <label data-lab-mode-label="${dimension.key}" title="${dimension.title.replace(/"/g, '&quot;')}"
                    style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                    <input type="checkbox" data-lab-upgrade-dimension="${dimension.key}" style="margin:0; cursor:pointer;"${
                        dimension.defaultOn ? ' checked' : ''
                    }>
                    ${dimension.label}
                </label>
                ${LAB_MODE_OPTIONS[dimension.key] || ''}
            </span>`
            ).join('')}
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="How tightly to pin each comparison's win rate down before its baseline sim stops, in percentage points. Lower is more accurate but slower. Shared with the Single Sim tab and Settings.">
                Precision ±
                <input id="mwi-labsim-upgrade-precision" type="number" min="0.1" max="10" step="0.5" value="${Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1))))}" style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
                <span style="font-size:12px;">%</span>
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Cap the baseline sim's fight count for each comparison, whatever the precision. Tick Uncapped to ignore this.">
                Max fights
                <input id="mwi-labsim-upgrade-maxfights" type="number" min="1" step="1000" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthUpgradeMaxTrials', 20000)) || 20000)}" style="width:64px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Simulated-time ceiling for each comparison sim, in hours. Precision usually ends it first. Tick Uncapped to ignore this.">
                Max hrs
                <input id="mwi-labsim-upgrade-maxhours" type="number" min="1" step="1" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthUpgradeMaxHours', 24)) || 24)}" style="width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Ignore the max-fights and time-ceiling numbers above (they stay put) and run each comparison's baseline to the precision target.">
                <input type="checkbox" id="mwi-labsim-upgrade-uncapped" style="margin:0; cursor:pointer;"${config.getSettingValue('labyrinthUpgradeUncapped', false) ? ' checked' : ''}>
                Uncapped
            </label>
            <button id="mwi-labsim-upgrade-run" style="
                margin-left: auto; flex-shrink: 0;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Analyze</button>
            <button id="mwi-labsim-upgrade-stop" style="
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

        // Which fights the checked candidate sets are weighed for. Orthogonal to
        // the sets themselves, which is why it is its own row rather than more
        // entries in a mode list.
        const upgradeScopeRow = document.createElement('div');
        upgradeScopeRow.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        upgradeScopeRow.innerHTML = `
            <label style="color:#888; font-size:12px;">Targets</label>
            <select class="toolasha-select" id="mwi-labsim-upgrade-scope" style="${upgradeSelectStyle}">
                ${LAB_SCOPES.map(
                    (scope) =>
                        `<option value="${scope.key}" title="${scope.title.replace(/"/g, '&quot;')}">${scope.label}</option>`
                ).join('')}
            </select>
            <label id="mwi-labsim-allfights-useskip-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="Sim each fight at its automation skip level (effective combat level + skip − 1) instead of the current run's live room levels">
                <input type="checkbox" id="mwi-labsim-allfights-useskip" checked style="margin:0; cursor:pointer;">
                Use Skip Levels
            </label>
            <label id="mwi-labsim-level-source-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="Which level the Configure fight is analysed at. The other scopes take each fight's own room level from the automation table.">
                At
                <select class="toolasha-select" id="mwi-labsim-level-source" style="${upgradeSelectStyle}">
                    ${LAB_LEVEL_SOURCES.map(
                        (levelSource) =>
                            `<option value="${levelSource.key}" title="${levelSource.title.replace(/"/g, '&quot;')}">${levelSource.label}</option>`
                    ).join('')}
                </select>
                <span id="mwi-labsim-level-source-resolved" style="color:#666; font-size:11px; white-space:nowrap;"></span>
            </label>
            <label id="mwi-labsim-room-levels-label" style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="After the win-rate pass, measure the top ${ROOM_LEVEL_SHORTLIST_SIZE} upgrades in room levels: how much deeper this character clears at the Target Win % bar, and which floor that reaches. Floor N runs levels 20N to 20N+20, and reaching a floor means clearing the TOP of its band — the exit sits in the far corner, so a floor you cannot finish is a floor you have not got. Configure-fight scope only, and it adds a binary search of sims per measured upgrade.">
                <input type="checkbox" id="mwi-labsim-upgrade-room-levels" style="margin:0; cursor:pointer;">
                Room levels
            </label>
            <label id="mwi-labsim-target-floor-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="The floor you are trying to finish. Its requirement is the top of its own band — floor N needs room level 20N+20, the exit room — and the rows say which upgrades reach it.">
                Floor
                <input id="mwi-labsim-upgrade-target-floor" type="number" min="1" step="1" placeholder="—" style="
                    width:48px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                    border-radius:4px; padding:3px 4px; font-size:12px;">
            </label>
            <span id="mwi-labsim-scope-summary" style="color:#666; font-size:11px;"></span>
        `;

        // The subset picker itself: one checkbox per labyrinth fight, filled in
        // when the tab is opened because game data is not loaded when the panel
        // is built
        const labTargetList = document.createElement('div');
        labTargetList.id = 'mwi-labsim-target-list';
        labTargetList.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:6px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';

        // Per-ability target levels for Ability Levels / combined modes
        // (hidden until toggled; inputs built from equipped abilities on open)
        const labAbilityTargets = document.createElement('div');
        labAbilityTargets.id = 'mwi-labsim-ability-targets';
        labAbilityTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        // Per-skill target levels for the Combat Levels modes (hidden until toggled)
        const labCombatTargets = document.createElement('div');
        labCombatTargets.id = 'mwi-labsim-combat-targets';
        labCombatTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';
        labCombatTargets.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level skips the skill; used instead of the +Levels boost while open):</span>' +
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
                    <input type="number" min="1" max="200" data-lab-combat-target="${key}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');

        // Per-room house target levels (hidden until toggled; built from the
        // rooms that can move a win rate when it is opened)
        const labHouseTargets = document.createElement('div');
        labHouseTargets.id = 'mwi-labsim-house-targets';
        labHouseTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        // Per-shrine target levels, on exactly the House grid's terms: a shrine
        // sitting at Lv2 and one sitting at Lv14 have no business sharing a
        // single Lv box, which is what the one spinner made them do
        const labShrineTargets = document.createElement('div');
        labShrineTargets.id = 'mwi-labsim-shrine-targets';
        labShrineTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        const upgradeProgress = document.createElement('div');
        upgradeProgress.id = 'mwi-labsim-upgrade-progress';
        upgradeProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        upgradeProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-upgrade-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-upgrade-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const upgradeResults = document.createElement('div');
        upgradeResults.id = 'mwi-labsim-upgrade-results';
        upgradeResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        upgradeContent.appendChild(upgradeControls);
        upgradeContent.appendChild(upgradeScopeRow);
        upgradeContent.appendChild(labTargetList);
        upgradeContent.appendChild(labAbilityTargets);
        upgradeContent.appendChild(labCombatTargets);
        upgradeContent.appendChild(labHouseTargets);
        upgradeContent.appendChild(labShrineTargets);
        upgradeContent.appendChild(upgradeProgress);
        upgradeContent.appendChild(upgradeResults);

        // ── Skilling tab ──
        const skillingContent = document.createElement('div');
        skillingContent.id = 'mwi-labsim-skilling-content';
        // The whole tab scrolls as one page so expanded sections (Player Setup,
        // loadouts) are never clipped by their own tiny scroll areas
        skillingContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow-y:auto;';

        const skillingControls = document.createElement('div');
        skillingControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        skillingControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Room Level</label>
            <input id="mwi-labsim-skilling-level" type="number" min="1" max="1300" value="100" disabled style="${inputStyle}">
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="Use each skill's automation skip level to derive its room level (effective level + skip - 1)">
                <input type="checkbox" id="mwi-labsim-skilling-useskip" checked style="margin:0; cursor:pointer;">
                Use Skip Levels
            </label>
            <label style="color:#888; font-size:12px;">Skill</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-filter" title="Restrict calculations, upgrade analysis, and the loadout table to one skill" style="
                background:#1a1a2e;
                color:#e0e0e0;
                border:1px solid #444;
                border-radius:4px;
                padding:4px 6px;
                font-size:11px;
                font-family:inherit;">
                <option value="">All Skills</option>
                <option value="/skills/woodcutting">Woodcutting</option>
                <option value="/skills/foraging">Foraging</option>
                <option value="/skills/milking">Milking</option>
                <option value="/skills/cooking">Cooking</option>
                <option value="/skills/brewing">Brewing</option>
                <option value="/skills/cheesesmithing">Cheesesmithing</option>
                <option value="/skills/crafting">Crafting</option>
                <option value="/skills/tailoring">Tailoring</option>
                <option value="/skills/alchemy">Alchemy</option>
                <option value="/skills/enhancing">Enhancing</option>
            </select>
            <label style="color:#888; font-size:12px;">Community Lv</label>
            <input id="mwi-labsim-skilling-community-level" type="number" min="1" max="${MAX_COMMUNITY_BUFF_LEVEL}"
                placeholder="Lv" title="Sim each community buff at this level rather than one level up — Lv3 → Lv8 in one row. Capped at ${MAX_COMMUNITY_BUFF_LEVEL}, which the game calls max. The cowbell figure is per minute of uptime either way; a level has no price of its own." style="
                width:52px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:4px; padding:4px 6px; font-size:11px; font-family:inherit;">
            <button id="mwi-labsim-skilling-calc" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Calculate</button>
            <button id="mwi-labsim-skilling-upgrade" title="Sims token upgrades one level up and each equipment piece at its next enhancement breakpoint — when a breakpoint doesn't move the clear rate, the target keeps ticking up one level at a time until it has a positive impact (which is why some rows show a higher level than the next breakpoint)" style="
                background: rgba(255,255,255,0.04);
                border: 1px solid #333;
                color: #aaa;
                border-radius: 6px;
                padding: 5px 10px;
                font-size: 12px;
                cursor: pointer;
                font-family: inherit;">Analyze Upgrades</button>
            <button id="mwi-labsim-skilling-stop" style="
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

        const skillingCrateRow = document.createElement('div');
        skillingCrateRow.style.cssText = `
            display: flex; align-items: center; gap: 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        skillingCrateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Coffee</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-coffee" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_coffee_crate">Basic</option>
                <option value="/items/advanced_coffee_crate">Advanced</option>
                <option value="/items/expert_coffee_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Food</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-food" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_food_crate">Basic</option>
                <option value="/items/advanced_food_crate">Advanced</option>
                <option value="/items/expert_food_crate" selected>Expert</option>
            </select>
        `;

        const skillingLoadoutArea = document.createElement('div');
        skillingLoadoutArea.id = 'mwi-labsim-skilling-loadouts';
        skillingLoadoutArea.style.cssText = 'padding:8px 14px; border-bottom:1px solid #222; flex-shrink:0;';

        // Player setup (skill levels, house rooms, token upgrades, community
        // buffs) is collapsed by default to keep the tab compact — it's only
        // needed when overriding the live character's values
        const skillingEditorSection = document.createElement('div');
        skillingEditorSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';
        const skillingEditorHeader = document.createElement('div');
        skillingEditorHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        skillingEditorHeader.innerHTML = `
            <span>Player Setup</span>
            <span id="mwi-labsim-skilling-editor-toggle" style="font-size:10px;">▶</span>
        `;

        const skillingEditorArea = document.createElement('div');
        skillingEditorArea.id = 'mwi-labsim-skilling-editor';
        skillingEditorArea.style.cssText = 'display:none; padding:10px 14px; flex-shrink:0;';
        skillingEditorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        skillingEditorHeader.addEventListener('click', () => {
            const isOpen = skillingEditorArea.style.display !== 'none';
            skillingEditorArea.style.display = isOpen ? 'none' : 'block';
            skillingEditorHeader.querySelector('#mwi-labsim-skilling-editor-toggle').textContent = isOpen ? '▶' : '▼';
        });
        skillingEditorSection.appendChild(skillingEditorHeader);
        skillingEditorSection.appendChild(skillingEditorArea);

        this._skillingEditor = new SimEditor({ editorEl: skillingEditorArea, labMode: true, skillingMode: true });

        const skillingProgress = document.createElement('div');
        skillingProgress.id = 'mwi-labsim-skilling-progress';
        skillingProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        skillingProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-skilling-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-skilling-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const skillingResults = document.createElement('div');
        skillingResults.id = 'mwi-labsim-skilling-results';
        skillingResults.style.cssText = 'padding:10px 14px; flex-shrink:0;';

        skillingContent.appendChild(skillingControls);
        skillingContent.appendChild(skillingCrateRow);
        skillingContent.appendChild(skillingLoadoutArea);
        skillingContent.appendChild(skillingEditorSection);
        skillingContent.appendChild(skillingProgress);
        skillingContent.appendChild(skillingResults);

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-labsim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a monster in Configure, then use Single Sim or Upgrade to simulate.';

        // Assemble
        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(configureContent);
        this.panel.appendChild(maxLevelContent);
        this.panel.appendChild(upgradeContent);
        this.panel.appendChild(skillingContent);
        this.panel.appendChild(status);

        // Both crate dropdown trios (combat + skilling) default to the character's
        // equipped labyrinth crates rather than a hardcoded Expert — see
        // _applyEquippedCratesTo. A manual pick opts that trio out, so "what if I
        // ran Expert" still works.
        for (const id of ['#mwi-labsim-skilling-tea', '#mwi-labsim-skilling-coffee', '#mwi-labsim-skilling-food']) {
            this.panel.querySelector(id)?.addEventListener('change', () => {
                this._skillingCratesUserSet = true;
            });
        }
        for (const id of ['#mwi-labsim-tea', '#mwi-labsim-coffee', '#mwi-labsim-food']) {
            this.panel.querySelector(id)?.addEventListener('change', () => {
                this._combatCratesUserSet = true;
            });
        }
        this._applyEquippedSkillingCrates();
        this._applyEquippedCombatCrates();

        // Both bottom corners: a panel docked against the right of the screen
        // can only be widened by dragging its left edge, and the right-hand grip
        // just pushes it off the screen
        const grip = (corner) => {
            const handle = document.createElement('div');
            handle.className = 'toolasha-resize-grip';
            const onLeft = corner === 'left';
            handle.style.cssText = `
                position: absolute;
                bottom: 0;
                ${onLeft ? 'left' : 'right'}: 0;
                width: 16px;
                height: 16px;
                cursor: ${onLeft ? 'nesw-resize' : 'nwse-resize'};
                background: linear-gradient(${onLeft ? '225deg' : '135deg'}, transparent 50%, rgba(74, 158, 255, 0.4) 50%);
                border-radius: ${onLeft ? '0 0 0 8px' : '0 0 8px 0'};
                z-index: 1;
            `;
            this.panel.appendChild(handle);
            this._setupResize(handle, corner);
        };
        grip('right');
        grip('left');

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        // Over the top-right default above, once storage answers
        this._restorePanelGeometry();

        // Minimize: fold the whole panel to its header, remembering the state.
        // Every non-header child is a content sibling to hide.
        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: [tabBar, configureContent, maxLevelContent, upgradeContent, skillingContent, status],
            panelKey: GEOMETRY_KEY,
            beforeEl: header.querySelector('#mwi-labsim-close'),
            accent: '#aaa',
        });

        // Event listeners
        this.panel.querySelector('#mwi-labsim-close').addEventListener('click', () => this.hide());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Tab switching
        this.panel
            .querySelector('#mwi-labsim-tab-configure')
            .addEventListener('click', () => this._switchTab('configure'));
        this.panel
            .querySelector('#mwi-labsim-tab-maxlevel')
            .addEventListener('click', () => this._switchTab('maxlevel'));
        this.panel.querySelector('#mwi-labsim-tab-upgrade').addEventListener('click', () => this._switchTab('upgrade'));
        this.panel
            .querySelector('#mwi-labsim-tab-skilling')
            .addEventListener('click', () => this._switchTab('skilling'));

        // Configure listeners
        this.panel.querySelector('#mwi-labsim-monster').addEventListener('change', (e) => {
            this._onMonsterChange(e.target.value);
            // Every level source is per monster, so the readout is stale the
            // moment the fight changes
            this._refreshLevelSourceReadout();
        });
        this.panel.querySelector('#mwi-labsim-level').addEventListener('change', () => {
            this._refreshLevelSourceReadout();
        });

        // Max Level listeners
        this.panel.querySelector('#mwi-labsim-run').addEventListener('click', () => this._onSimulate());
        this.panel.querySelector('#mwi-labsim-stop').addEventListener('click', () => {
            // Stops the run, keeps the warm workers - see the Combat Sim Stop
            cancelActiveSimulations();
            this.isRunning = false;
            this._setStatus('Labyrinth simulation cancelled.');
            this.panel.querySelector('#mwi-labsim-progress').style.display = 'none';
        });
        this.panel.querySelector('#mwi-labsim-findmax').addEventListener('change', (e) => {
            this._labyFindMaxMode = e.target.checked;
            const levelInput = this.panel.querySelector('#mwi-labsim-level');
            levelInput.disabled = e.target.checked;
            levelInput.style.opacity = e.target.checked ? '0.4' : '1';
        });
        // Precision is read live from the setting at sim time (see _onSimulate),
        // so persisting the input's value is all it takes for the next run — and
        // the same knob in Settings and the labyrinth tile calculator stays in
        // step, since all three read and write the one setting.
        this.panel.querySelector('#mwi-labsim-precision').addEventListener('change', (e) => {
            const n = Math.min(10, Math.max(0.1, Number(e.target.value) || 1));
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimPrecision', n);
        });
        // Max fights / Max hours / Uncapped are read live at sim time (see
        // _onSimulate). Persist so the choice survives a refresh.
        this.panel.querySelector('#mwi-labsim-maxfights').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || 20000);
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimMaxTrials', n);
        });
        this.panel.querySelector('#mwi-labsim-maxhours').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || 24);
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimMaxHours', n);
        });
        this.panel.querySelector('#mwi-labsim-uncapped').addEventListener('change', (e) => {
            config.setSettingValue('labyrinthSimUncapped', e.target.checked);
        });

        // Upgrade listeners
        this.panel.querySelector('#mwi-labsim-upgrade-run').addEventListener('click', () => this._onUpgradeAnalyze());
        // Remember the chosen player by name so a tab switch (which rebuilds the
        // dropdown) restores it instead of snapping back to the first entry.
        this.panel.querySelector('#mwi-labsim-upgrade-player').addEventListener('change', (e) => {
            const opt = e.target.selectedOptions?.[0];
            this._upgradePlayerName = opt?.dataset?.name || opt?.textContent || null;
        });
        this.panel.querySelector('#mwi-labsim-upgrade-precision').addEventListener('change', (e) => {
            const n = Math.min(10, Math.max(0.1, Number(e.target.value) || 1));
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimPrecision', n);
            // Keep the Single Sim tab's precision box in step — they share one setting
            const twin = this.panel.querySelector('#mwi-labsim-precision');
            if (twin) twin.value = String(n);
        });
        this.panel.querySelector('#mwi-labsim-upgrade-maxfights').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || 20000);
            e.target.value = String(n);
            config.setSettingValue('labyrinthUpgradeMaxTrials', n);
        });
        this.panel.querySelector('#mwi-labsim-upgrade-maxhours').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || 24);
            e.target.value = String(n);
            config.setSettingValue('labyrinthUpgradeMaxHours', n);
        });
        this.panel.querySelector('#mwi-labsim-upgrade-uncapped').addEventListener('change', (e) => {
            config.setSettingValue('labyrinthUpgradeUncapped', e.target.checked);
        });
        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            box.addEventListener('change', () => {
                this._onUpgradeSelectionChanged();
                void this._saveUpgradeSelection();
            });
        });
        this.panel.querySelector('#mwi-labsim-upgrade-scope').addEventListener('change', () => {
            this._populateUpgradeTargets();
            this._onUpgradeSelectionChanged();
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-allfights-useskip').addEventListener('change', () => {
            this._populateUpgradeTargets(this._getChosenTargets());
            this._onUpgradeSelectionChanged();
        });
        this.panel.querySelector('#mwi-labsim-level-source').addEventListener('change', () => {
            this._refreshLevelSourceReadout();
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-swap-aura-only')?.addEventListener('change', () => {
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-shrine-cap-guild')?.addEventListener('change', () => {
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-room-levels')?.addEventListener('change', () => {
            this._refreshRoomLevelControls();
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-target-floor')?.addEventListener('change', (e) => {
            const floor = Math.max(0, parseInt(e.target.value, 10) || 0);
            e.target.value = floor ? String(floor) : '';
            void this._saveUpgradeSelection();
        });
        void this._restoreUpgradeSelection();
        void this._restoreTokenBuffLevels();
        void this._restoreUpgradeResults();
        this.panel.querySelector('#mwi-labsim-ability-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-ability-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillAbilityTargets(grid, '#mwi-labsim-upgrade-player', '#mwi-labsim-upgrade-target-level');
            }
        });
        this.panel.querySelector('#mwi-labsim-combat-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillLabCombatTargets();
            }
        });
        this.panel.querySelector('#mwi-labsim-house-targets-toggle')?.addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-house-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) this._buildLabHouseTargets();
        });
        this.panel.querySelector('#mwi-labsim-shrine-targets-toggle')?.addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-shrine-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) this._buildLabShrineTargets();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-stop').addEventListener('click', () => {
            this._upgradeAborted = true;
            // The flag alone only ends the run BETWEEN sims: the analysis polls
            // `abortSignal` between one simulation and the next, so whatever is
            // already in flight still runs to completion. With Uncapped ticked
            // that sim has a million-hour budget and no trial cap, so Stop looked
            // dead — it had in fact been honoured and was waiting on a sim that
            // was never going to end. Terminating the workers is what actually
            // stops it, which is what the Single Sim and Skilling Stop buttons
            // have always done.
            cancelActiveSimulations();
            this.panel.querySelector('#mwi-labsim-upgrade-progress')?.style.setProperty('display', 'none');
            this._setStatus('Upgrade analysis cancelled.');
        });

        // Skilling listeners
        this.panel
            .querySelector('#mwi-labsim-skilling-calc')
            .addEventListener('click', () => this._onSkillingCalculate());
        this.panel
            .querySelector('#mwi-labsim-skilling-upgrade')
            .addEventListener('click', () => this._onSkillingUpgradeAnalyze());
        this.panel.querySelector('#mwi-labsim-skilling-useskip').addEventListener('change', (e) => {
            const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
            if (levelInput) levelInput.disabled = e.target.checked;
        });
        this.panel.querySelector('#mwi-labsim-skilling-stop').addEventListener('click', () => {
            this._skillingAborted = true;
        });
        this.panel.querySelector('#mwi-labsim-skilling-filter').addEventListener('change', () => {
            this._renderSkillLoadoutTable();
        });

        this._populateMonsters();
        // Recorded runs outlive the session, so they are read back as the panel
        // is built rather than when the first one is added
        void this._comparison.load();
        // Here rather than at module scope, where the other panels ask: this one
        // is built by its feature module and only if the setting is on, so
        // asking any earlier would be asking about a panel that does not exist
        this.restore();
    }

    /** @private */
    _populateMonsters() {
        const select = this.panel?.querySelector('#mwi-labsim-monster');
        if (!select) return;

        const monsters = getLabyrinthMonsters();
        select.innerHTML = '';
        for (const monster of monsters) {
            const option = document.createElement('option');
            option.value = monster.hrid;
            option.textContent = monster.name;
            select.appendChild(option);
        }
    }

    /** @private */
    _onMonsterChange(monsterHrid) {
        if (!monsterHrid || !this._editor?.isInitialized()) return;
        const monsterId = monsterHrid.split('/').pop();
        const pascal = monsterId
            .split('_')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join('');
        const loadoutId = dataManager.characterData?.characterSetting?.[`labyrinthLoadout${pascal}`];
        if (!loadoutId) return;
        const snapshot = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots[loadoutId];
        if (!snapshot?.name) return;
        this._editor.applyLoadoutByName(snapshot.name);
    }

    /** @private */
    _populateUpgradePlayerSelector() {
        const select = this.panel?.querySelector('#mwi-labsim-upgrade-player');
        if (!select) return;

        const playerInfo = this._editor?.getPlayerInfo() || [];
        select.innerHTML = '';
        playerInfo.forEach((p, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = p.name || `Player ${i + 1}`;
            option.dataset.name = p.name || '';
            select.appendChild(option);
        });

        if (playerInfo.length === 0) {
            const option = document.createElement('option');
            option.value = 0;
            option.textContent = 'Player 1';
            select.appendChild(option);
            return;
        }

        // Restore the remembered pick (so switching tabs does not reset it),
        // else default to the local character rather than whichever party member
        // happens to be first, else the first entry.
        const nameIndex = (name) =>
            name ? playerInfo.findIndex((p) => (p.name || '').toLowerCase() === String(name).toLowerCase()) : -1;
        let index = nameIndex(this._upgradePlayerName);
        if (index < 0) index = nameIndex(dataManager.getCurrentCharacterName?.());
        if (index < 0) index = 0;
        select.value = String(index);
        // Pin what we landed on so the next rebuild keeps it.
        this._upgradePlayerName = playerInfo[index]?.name || null;
    }

    /**
     * What the Configure tab's Level box holds.
     * @returns {number} 0 when it holds nothing usable
     * @private
     */
    _configureLevel() {
        return Math.max(0, Math.floor(Number(this.panel?.querySelector('#mwi-labsim-level')?.value) || 0));
    }

    /**
     * The room level this monster's skip threshold sends the character to.
     *
     * A Recommend run's answer when there is one — that is the threshold with an
     * objective behind it, the highest one whose rooms still clear at the Target
     * Win % — and the threshold actually configured in the automation table
     * otherwise.
     * @param {string} monsterHrid - Labyrinth monster
     * @returns {number} 0 when neither resolves
     * @private
     */
    _skipRoomLevel(monsterHrid) {
        if (!monsterHrid) return 0;
        const recommended =
            (labyrinthClearRate() || bundledLabyrinthClearRate).getRecommendedCombatRoomLevel?.(monsterHrid) || 0;
        return (
            recommended || (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatSkipRoomLevel(monsterHrid) || 0
        );
    }

    /**
     * Which level the Configure-fight scope is being analysed at, resolved.
     *
     * The Sim max figure is whatever the last Find Max run produced for this
     * monster, kept per monster for the life of the panel — it is a property of
     * the fight rather than of the panel, and the box it used to be written into
     * was overwritten by the next monster's search. It is not persisted: a max
     * level is a statement about the gear it was searched with, and gear changes
     * between sessions far more often than it does inside one.
     *
     * @param {string} [monsterHrid] - Defaults to the Configure tab's monster
     * @returns {{level: number, usedSource: string, label: string, fellBack: boolean}}
     * @private
     */
    _resolveTargetLevel(monsterHrid = this.panel?.querySelector('#mwi-labsim-monster')?.value || '') {
        return resolveLabTargetLevel({
            source: this._getLevelSource(),
            simMaxLevel: this._maxLevelByMonster[monsterHrid] || 0,
            skipLevel: this._skipRoomLevel(monsterHrid),
            configureLevel: this._configureLevel(),
        });
    }

    /**
     * Which of the three level sources the Configure-fight scope is set to.
     * @returns {string} A key from `LAB_LEVEL_SOURCES`
     * @private
     */
    _getLevelSource() {
        return this.panel?.querySelector('#mwi-labsim-level-source')?.value || 'configure';
    }

    /**
     * Show the level the current source comes to, beside the source itself.
     *
     * The whole point of the control is that the number it produces is visible
     * before Analyze is pressed — a scope that quietly ran at 100 because that
     * is what the Level box opens on is what it replaces.
     * @private
     */
    _refreshLevelSourceReadout() {
        const label = this.panel?.querySelector('#mwi-labsim-level-source-label');
        const readout = this.panel?.querySelector('#mwi-labsim-level-source-resolved');
        if (!label || !readout) return;

        label.style.display = this._getUpgradeScopeMode() === 'current' ? 'inline-flex' : 'none';

        const source = this._getLevelSource();
        const resolved = this._resolveTargetLevel();
        if (source === 'sim_max' && resolved.usedSource !== 'sim_max') {
            // Not "unavailable": Analyze runs the search itself. Saying which
            // level it would use instead would be a promise it does not keep.
            readout.textContent = 'not simmed yet — Analyze will search';
            readout.title = 'Find Max has not run for this monster this session. Analyze runs it before the analysis.';
            return;
        }
        readout.textContent = resolved.level ? `= L${resolved.level}` : 'no level resolves';
        readout.title = resolved.fellBack
            ? `${resolved.label} — the level you asked for has no value, so this is what will be used.`
            : resolved.label;
    }

    /**
     * The candidate sets currently checked on the Upgrade tab.
     * @returns {string[]}
     * @private
     */
    _getUpgradeDimensions() {
        return [...(this.panel?.querySelectorAll('[data-lab-upgrade-dimension]') || [])]
            .filter((box) => box.checked && !box.disabled)
            .map((box) => box.getAttribute('data-lab-upgrade-dimension'));
    }

    /**
     * Which fights the Upgrade tab is weighing them for.
     * @returns {string} `current` | `all` | `selected`
     * @private
     */
    _getUpgradeScopeMode() {
        return this.panel?.querySelector('#mwi-labsim-upgrade-scope')?.value || 'current';
    }

    /**
     * The monsters ticked in the subset picker.
     * @returns {string[]}
     * @private
     */
    _getChosenTargets() {
        return [...(this.panel?.querySelectorAll('[data-lab-target]') || [])]
            .filter((box) => box.checked)
            .map((box) => box.getAttribute('data-lab-target'));
    }

    /**
     * Every labyrinth fight the current Use Skip Levels setting can resolve.
     *
     * Served from what the picker was last built with rather than recollected:
     * collecting fights builds a player DTO per monster, and this is asked once
     * per checkbox click.
     * @returns {string[]} Monster hrids, in labyrinth order
     * @private
     */
    _allUpgradeTargets() {
        if (!this._upgradeTargetHrids) {
            const useSkipLevels = this.panel?.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
            this._upgradeTargetHrids = this._collectLabyrinthFights(useSkipLevels).map((fight) => fight.monsterHrid);
        }
        return this._upgradeTargetHrids;
    }

    /**
     * How many fights the current scope comes to — what the availability rules
     * and the summary line are both asking about.
     * @returns {number}
     * @private
     */
    _upgradeTargetCount() {
        return labScopeTargetCount(
            this._getUpgradeScopeMode(),
            this._allUpgradeTargets().length,
            this._getChosenTargets().length
        );
    }

    /**
     * Build the subset picker from the labyrinth's own fight list.
     *
     * Called on the way into the tab and whenever the scope changes, because
     * game data — and the player's skip thresholds — are not available when the
     * panel is built. Ticks are preserved across rebuilds; a fight that has
     * stopped resolving simply drops out.
     * @param {string[]} [preselect] - Monsters to tick, defaulting to whatever
     *   is ticked now
     * @private
     */
    _populateUpgradeTargets(preselect = null) {
        const grid = this.panel?.querySelector('#mwi-labsim-target-list');
        if (!grid) return;

        const previouslyChosen = new Set(preselect || this._getChosenTargets());
        const useSkipLevels = this.panel.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
        const fights = this._collectLabyrinthFights(useSkipLevels);
        this._upgradeTargetHrids = fights.map((fight) => fight.monsterHrid);

        if (!fights.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No labyrinth fights resolve to a room level yet — ' +
                'set combat skip levels in the game, or enter the labyrinth.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Rooms to weigh — leave out the ones you ' +
            'already clear comfortably:</span>' +
            '<span style="display:inline-flex; gap:6px; flex-basis:100%; margin-bottom:2px;">' +
            `<button data-lab-target-all="1" style="${CHIP_BUTTON_STYLE}">All</button>` +
            `<button data-lab-target-none="1" style="${CHIP_BUTTON_STYLE}">None</button>` +
            '</span>' +
            fights
                .map(
                    (fight) => `
                <label style="display:inline-flex; align-items:center; gap:4px; color:#aaa; font-size:11px; cursor:pointer;"
                    title="${fight.loadoutName} · room level ${fight.roomLevel}">
                    <input type="checkbox" data-lab-target="${fight.monsterHrid}" style="margin:0; cursor:pointer;"${
                        previouslyChosen.has(fight.monsterHrid) ? ' checked' : ''
                    }>
                    ${fight.monsterName} <span style="color:#666;">L${fight.roomLevel}</span>
                </label>`
                )
                .join('');

        grid.querySelectorAll('[data-lab-target]').forEach((box) => {
            box.addEventListener('change', () => {
                this._onUpgradeSelectionChanged();
                void this._saveUpgradeSelection();
            });
        });
        const setAll = (checked) => {
            grid.querySelectorAll('[data-lab-target]').forEach((box) => {
                box.checked = checked;
            });
            this._onUpgradeSelectionChanged();
            void this._saveUpgradeSelection();
        };
        grid.querySelector('[data-lab-target-all]')?.addEventListener('click', () => setAll(true));
        grid.querySelector('[data-lab-target-none]')?.addEventListener('click', () => setAll(false));
    }

    /**
     * Show only the controls the current selection actually uses, and grey out
     * the ones this target scope cannot answer.
     *
     * A checkbox that would be quietly ignored is worse than one that is
     * visibly unavailable and says why, so an unavailable dimension is
     * disabled with the reason on its tooltip rather than dropped at run time.
     * @private
     */
    _onUpgradeSelectionChanged() {
        if (!this.panel) return;

        const scopeMode = this._getUpgradeScopeMode();
        const targetCount = this._upgradeTargetCount();
        const availability = labDimensionAvailability(scopeMode, targetCount);

        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            const key = box.getAttribute('data-lab-upgrade-dimension');
            const state = availability[key] || { enabled: true, reason: '' };
            box.disabled = !state.enabled;
            const label = this.panel.querySelector(`[data-lab-mode-label="${key}"]`);
            // Restored rather than left behind when the reason no longer
            // applies: a set refused for one scope kept explaining itself in
            // every other scope, where the explanation was untrue
            if (label) {
                label.title = state.reason || LAB_UPGRADE_DIMENSIONS.find((d) => d.key === key)?.title || '';
            }
        });

        const dimensions = new Set(this._getUpgradeDimensions());
        const isLevelMode = dimensions.has('ability_level');
        const isCombatLevelMode = dimensions.has('combat_level');

        this.panel.querySelectorAll('[data-lab-mode-chip]').forEach((chip) => {
            const key = chip.getAttribute('data-lab-mode-chip');
            const on = dimensions.has(key);
            const usable = availability[key]?.enabled !== false;
            chip.style.borderColor = on ? ACCENT_BTN_BORDER : '#2a2a4a';
            chip.style.background = on ? ACCENT_BG : 'transparent';
            chip.style.opacity = usable ? '1' : '0.45';
            const label = chip.querySelector('label');
            if (label) label.style.color = on ? '#e0e0e0' : '#888';
        });
        this.panel.querySelectorAll('[data-lab-mode-options]').forEach((group) => {
            group.style.display = dimensions.has(group.getAttribute('data-lab-mode-options')) ? 'inline-flex' : 'none';
        });

        // Combat Levels borrows the Ability Lv boost box when Ability Lv is off,
        // since one number drives both — same arrangement as the combat sim
        const levelGroup = this.panel.querySelector('#mwi-labsim-upgrade-level-group');
        if (levelGroup) levelGroup.style.display = isLevelMode || isCombatLevelMode ? 'inline-flex' : 'none';

        const levelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type');
        const levelInput = this.panel.querySelector('#mwi-labsim-upgrade-target-level');
        const levelTypeState = labAbilityLevelTypeAvailability(scopeMode, targetCount);
        if (levelType) {
            levelType.style.display = isLevelMode ? '' : 'none';
            levelType.disabled = !levelTypeState.enabled;
            levelType.title = levelTypeState.reason;
            if (!levelTypeState.enabled) levelType.value = 'increment';
        }
        if (levelInput) {
            levelInput.title =
                isLevelMode && isCombatLevelMode
                    ? 'Levels added to each ability and each combat skill'
                    : isCombatLevelMode
                      ? 'Levels added to each combat skill'
                      : 'Number of levels to add to each ability';
            if (isCombatLevelMode && !parseInt(levelInput.value, 10)) levelInput.value = '5';
        }

        const abilityGrid = this.panel.querySelector('#mwi-labsim-ability-targets');
        if (!isLevelMode) abilityGrid.style.display = 'none';
        if (!isCombatLevelMode) this.panel.querySelector('#mwi-labsim-combat-targets').style.display = 'none';

        // The grid lists whatever the target scope covers, so a scope change is
        // a change to the list — leaving it showing one loadout's abilities
        // after the scope grew to ten fights is exactly the bug it had
        if (isLevelMode && abilityGrid.style.display !== 'none') {
            this._prefillAbilityTargets(abilityGrid, '#mwi-labsim-upgrade-player', '#mwi-labsim-upgrade-target-level');
        }

        // Scope row: the subset picker and the skip-level rule only mean
        // something once the analysis is walking the labyrinth's own fight list
        const targetList = this.panel.querySelector('#mwi-labsim-target-list');
        const useSkipLabel = this.panel.querySelector('#mwi-labsim-allfights-useskip-label');
        if (targetList) targetList.style.display = scopeMode === 'selected' ? 'flex' : 'none';
        if (useSkipLabel) useSkipLabel.style.display = scopeMode === 'current' ? 'none' : 'flex';

        this._refreshLevelSourceReadout();

        const summary = this.panel.querySelector('#mwi-labsim-scope-summary');
        if (summary) {
            summary.textContent =
                scopeMode === 'current'
                    ? 'One fight, from the Configure tab — the only scope that also ranks labyrinth token buffs.'
                    : targetCount === 0
                      ? 'No fights resolve to a room level yet.'
                      : `${targetCount} fight${targetCount === 1 ? '' : 's'}, each with its assigned loadout.`;
        }
    }

    /**
     * The analysis the Upgrade tab's controls currently describe.
     *
     * The whole point of splitting the old Mode dropdown in two is that the
     * combination is worked out rather than enumerated, so this is the one
     * place that reads the controls and the only thing Analyze consults.
     * @returns {Object} From `planLabUpgradeRun`
     * @private
     */
    _planFromControls() {
        return planLabUpgradeRun({
            dimensions: this._getUpgradeDimensions(),
            scopeMode: this._getUpgradeScopeMode(),
            chosenMonsters: this._getChosenTargets(),
            allMonsters: this._allUpgradeTargets(),
            configureMonsterHrid: this.panel?.querySelector('#mwi-labsim-monster')?.value || '',
        });
    }

    /**
     * Persist the checked sets and the target scope so the next Analyze starts
     * where the last one left off.
     * @private
     */
    async _saveUpgradeSelection() {
        try {
            // Issued together rather than awaited one after another. Each
            // `writeScoped` resolves its key as it is called, but a
            // non-immediate `storage.set` resolves only when its debounce fires
            // — seconds later — so awaiting between them let a character switch
            // land in the middle and split one selection across two characters:
            // the arriving character keeping their own checked sets while
            // inheriting the departing character's target scope, which is a
            // combination neither of them ever chose.
            await Promise.all([
                writeScoped(UPGRADE_DIMENSIONS_KEY, this._getUpgradeDimensions(), 'settings'),
                writeScoped(
                    UPGRADE_SCOPE_KEY,
                    { mode: this._getUpgradeScopeMode(), monsters: this._getChosenTargets() },
                    'settings'
                ),
                writeScoped(UPGRADE_LEVEL_SOURCE_KEY, this._getLevelSource(), 'settings'),
                // The box's own state, not the gated answer below: unchecking
                // Ability Swaps would otherwise save a false over the tick and
                // lose it the moment the set is checked again
                writeScoped(
                    UPGRADE_SWAP_AURA_KEY,
                    Boolean(this.panel?.querySelector('#mwi-labsim-swap-aura-only')?.checked),
                    'settings'
                ),
                // The box's own state too — gating it on whether Guild Shrine is
                // checked would save a stale true over an unchecking that happened
                // while the set itself was off
                writeScoped(
                    SHRINE_CAP_GUILD_KEY,
                    Boolean(this.panel?.querySelector('#mwi-labsim-shrine-cap-guild')?.checked),
                    'settings'
                ),
                writeScoped(UPGRADE_ROOM_LEVELS_KEY, this._getRankByRoomLevels(), 'settings'),
                writeScoped(UPGRADE_TARGET_FLOOR_KEY, this._getTargetFloor(), 'settings'),
            ]);
        } catch (error) {
            console.error('[LabSimUI] Failed to save upgrade selection:', error);
        }
    }

    /**
     * Whether Ability Swaps is narrowed to the guide's signature swaps.
     *
     * False whenever the set itself is unchecked: the flag only ever qualifies
     * swaps, and a remembered tick sitting behind an unchecked box should not
     * read as an instruction to anything.
     * @returns {boolean}
     * @private
     */
    _getAuraSwapsOnly() {
        if (!this._getUpgradeDimensions().includes('ability_swap')) return false;
        return Boolean(this.panel?.querySelector('#mwi-labsim-swap-aura-only')?.checked);
    }

    /**
     * Whether the Upgrade tab should measure room levels after ranking win rates.
     * @returns {boolean}
     * @private
     */
    _getRankByRoomLevels() {
        return Boolean(this.panel?.querySelector('#mwi-labsim-upgrade-room-levels')?.checked);
    }

    /**
     * The floor the room-level pass is aiming at, 0 when none is set.
     * @returns {number}
     * @private
     */
    _getTargetFloor() {
        return Math.max(0, parseInt(this.panel?.querySelector('#mwi-labsim-upgrade-target-floor')?.value, 10) || 0);
    }

    /**
     * Show the target-floor box only while the room-level pass is on — the floor
     * is read off that measurement and means nothing without it.
     * @private
     */
    _refreshRoomLevelControls() {
        const label = this.panel?.querySelector('#mwi-labsim-target-floor-label');
        if (label) label.style.display = this._getRankByRoomLevels() ? 'flex' : 'none';
    }

    /**
     * Restore the remembered selection, migrating anyone still carrying the
     * retired single-mode value.
     * @private
     */
    async _restoreUpgradeSelection() {
        let selection;
        let savedLevelSource = null;
        let savedAuraOnly = false;
        // Defaults on: a shrine level the guild's shrine building cannot sell
        // is not an upgrade the character can buy, however well it would rank
        let savedShrineCapGuild = true;
        let savedRoomLevels = false;
        let savedTargetFloor = 0;
        try {
            // Every key resolved before the first await, for the same reason
            // the save issues its writes together: read one at a time, a switch
            // between two of them restored half of one character's selection
            // over half of another's — and the next change to any box saved
            // that mixture back over whichever character was current.
            let savedDimensions;
            let savedScope;
            [
                savedDimensions,
                savedScope,
                savedLevelSource,
                savedAuraOnly,
                savedShrineCapGuild,
                savedRoomLevels,
                savedTargetFloor,
            ] = await Promise.all([
                readScoped(UPGRADE_DIMENSIONS_KEY, 'settings', null),
                readScoped(UPGRADE_SCOPE_KEY, 'settings', null),
                readScoped(UPGRADE_LEVEL_SOURCE_KEY, 'settings', null),
                readScoped(UPGRADE_SWAP_AURA_KEY, 'settings', false),
                readScoped(SHRINE_CAP_GUILD_KEY, 'settings', true),
                readScoped(UPGRADE_ROOM_LEVELS_KEY, 'settings', false),
                readScoped(UPGRADE_TARGET_FLOOR_KEY, 'settings', 0),
            ]);
            savedAuraOnly = Boolean(savedAuraOnly);
            savedShrineCapGuild = Boolean(savedShrineCapGuild);
            const legacyMode =
                savedDimensions === null && savedScope === null
                    ? await readScoped(LEGACY_UPGRADE_MODE_KEY, 'settings', null)
                    : null;
            selection = sanitizeLabUpgradeSelection(savedDimensions ?? legacyMode, savedScope);
        } catch (error) {
            console.error('[LabSimUI] Failed to restore upgrade selection:', error);
            selection = sanitizeLabUpgradeSelection(null, null);
        }

        if (!this.panel) return;
        const wanted = new Set(selection.dimensions);
        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            box.checked = wanted.has(box.getAttribute('data-lab-upgrade-dimension'));
        });
        const scopeSelect = this.panel.querySelector('#mwi-labsim-upgrade-scope');
        if (scopeSelect) scopeSelect.value = selection.scopeMode;
        // Nothing saved falls to the rule rather than to a fixed option: a Level
        // box left on its default means Sim max, a Level box that was typed into
        // means the number that was typed
        const levelSourceSelect = this.panel.querySelector('#mwi-labsim-level-source');
        if (levelSourceSelect) {
            levelSourceSelect.value = sanitizeLabLevelSource(savedLevelSource, this._configureLevel());
        }
        const signatureBox = this.panel.querySelector('#mwi-labsim-swap-aura-only');
        if (signatureBox) signatureBox.checked = savedAuraOnly;
        const shrineCapBox = this.panel.querySelector('#mwi-labsim-shrine-cap-guild');
        if (shrineCapBox) shrineCapBox.checked = savedShrineCapGuild;
        const roomLevelsBox = this.panel.querySelector('#mwi-labsim-upgrade-room-levels');
        if (roomLevelsBox) roomLevelsBox.checked = Boolean(savedRoomLevels);
        const targetFloorInput = this.panel.querySelector('#mwi-labsim-upgrade-target-floor');
        if (targetFloorInput) {
            const floor = Math.max(0, Math.floor(Number(savedTargetFloor) || 0));
            targetFloorInput.value = floor ? String(floor) : '';
        }
        this._refreshRoomLevelControls();
        this._populateUpgradeTargets(selection.monsters);
        this._onUpgradeSelectionChanged();
    }

    /**
     * The token levels the live run has bought.
     * @returns {Object} buffKey → level
     * @private
     */
    _liveTokenLevels() {
        return readLiveTokenLevels(dataManager.characterData?.characterInfo);
    }

    /**
     * The token levels every simulation this panel runs should use: the live
     * ones, with whatever the Configure tab has been set to on top.
     *
     * Null when nothing is known and nothing has been set, which is not the
     * same answer as "every token at level 0": the Token Upgrades rows read
     * this, and a character the client cannot read would be offered nine
     * purchases off levels nobody has established.
     * @returns {Object|null} buffKey → level
     * @private
     */
    _resolvedTokenLevels() {
        const info = dataManager.characterData?.characterInfo;
        if (!info && !Object.keys(this._tokenBuffOverrides || {}).length) return null;
        return resolveTokenLevels(info, this._tokenBuffOverrides);
    }

    /**
     * The labyrinth combat buff array to hand a simulation.
     *
     * Every lab-sim path reads this rather than `labyrinthClearRate`: the live
     * getter answers "what is this run carrying", which is the right question
     * for a tile badge and the wrong one for a simulator being asked what a
     * different set of tokens would do.
     * @returns {Array<Object>}
     * @private
     */
    _labyrinthCombatBuffs() {
        return buildLabyrinthCombatBuffs(this._resolvedTokenLevels() || {});
    }

    /**
     * Draw the Labyrinth Buffs section: the live levels, and the ones being
     * simulated where those differ.
     *
     * Only the Combat four take an input. They are the tokens the combat engine
     * reads — the rest are levels no fight simulation consults, and an input
     * that silently changes nothing is worse than a readout that admits it is
     * one. The Skilling tab's Player Setup edits the skilling levels, which is
     * where they do change an answer.
     * @private
     */
    _renderBuffsSection() {
        const container = this.panel?.querySelector('#mwi-labsim-buffs-body');
        if (!container) return;

        const info = dataManager.characterData?.characterInfo;
        if (!info) {
            container.innerHTML = '<div style="color:#555;">No character data available.</div>';
            return;
        }

        const live = this._liveTokenLevels();
        const simulated = this._resolvedTokenLevels();

        let html =
            '<div style="color:#666; padding:2px 0 4px;">Combat levels are what the sims run under — change one ' +
            'to ask what those tokens would do. Blank restores the live level.</div>';

        for (const group of LAB_TOKEN_BUFF_GROUPS) {
            html += `<div style="color:#666; font-weight:600; font-size:10px; text-transform:uppercase; margin-top:4px; margin-bottom:2px;">${group.label}</div>`;
            html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:1px 16px;">';
            for (const buff of group.buffs) {
                const liveLevel = live[buff.key];
                const isMaxed = liveLevel >= MAX_LAB_TOKEN_LEVEL;
                if (!buff.uniqueKey) {
                    const color = isMaxed ? '#4caf50' : '#e0e0e0';
                    html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:1px 0;">
                        <span style="color:#aaa;">${buff.name}</span>
                        <span style="color:${color}; font-weight:${isMaxed ? '600' : '400'};">${liveLevel}/${MAX_LAB_TOKEN_LEVEL}</span>
                    </div>`;
                    continue;
                }
                const chosen = simulated[buff.key];
                const differs = chosen !== liveLevel;
                html += `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:1px 0;">
                    <span style="color:#aaa;">${buff.name}</span>
                    <span style="display:inline-flex; align-items:center; gap:4px;">
                        <input type="number" min="0" max="${MAX_LAB_TOKEN_LEVEL}" value="${chosen}"
                            data-lab-token-buff="${buff.key}"
                            title="Level to simulate. Live: ${liveLevel}/${MAX_LAB_TOKEN_LEVEL}."
                            style="width:44px; text-align:center; background:#1a1a2e;
                            color:${differs ? '#ffb74d' : '#e0e0e0'};
                            border:1px solid ${differs ? '#ffb74d' : '#444'};
                            border-radius:3px; padding:1px 3px; font-size:11px;">
                        <span style="color:${differs ? '#ffb74d' : '#666'}; min-width:56px;">${
                            differs ? `live ${liveLevel}` : `/${MAX_LAB_TOKEN_LEVEL}`
                        }</span>
                    </span>
                </div>`;
            }
            html += '</div>';
        }

        html +=
            '<div style="display:flex; align-items:center; gap:8px; margin-top:6px;">' +
            `<button id="mwi-labsim-buffs-reset" style="${CHIP_BUTTON_STYLE}">Reset to live</button>` +
            '<span id="mwi-labsim-buffs-body-note" style="color:#ffb74d;"></span>' +
            '</div>';

        container.innerHTML = html;

        container.querySelectorAll('[data-lab-token-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.labTokenBuff;
                const raw = input.value.trim();
                if (raw === '') {
                    delete this._tokenBuffOverrides[key];
                } else {
                    const level = Math.min(MAX_LAB_TOKEN_LEVEL, Math.max(0, parseInt(raw, 10) || 0));
                    this._tokenBuffOverrides[key] = level;
                }
                void this._saveTokenBuffLevels();
                this._renderBuffsSection();
            });
        });
        container.querySelector('#mwi-labsim-buffs-reset')?.addEventListener('click', () => {
            this._tokenBuffOverrides = {};
            void this._saveTokenBuffLevels();
            this._renderBuffsSection();
        });

        const note = container.querySelector('#mwi-labsim-buffs-body-note');
        const summary = describeTokenOverrides(info, this._tokenBuffOverrides);
        if (note) note.textContent = summary ? `Simulating ${summary}` : '';
        this._refreshBuffsHeaderNote();
    }

    /**
     * Say on the collapsed header that the sims are not running on the live
     * tokens — the section is shut by default, and a silent override is a run
     * reported as the live character that never was.
     * @private
     */
    _refreshBuffsHeaderNote() {
        const note = this.panel?.querySelector('#mwi-labsim-buffs-note');
        if (!note) return;
        const summary = describeTokenOverrides(dataManager.characterData?.characterInfo, this._tokenBuffOverrides);
        note.textContent = summary ? `simulating ${summary}` : '';
    }

    /**
     * Persist the token levels being simulated, per character.
     * @private
     */
    async _saveTokenBuffLevels() {
        try {
            this._tokenBuffOverrides = sanitizeTokenLevels(this._tokenBuffOverrides);
            await writeScoped(TOKEN_BUFF_LEVELS_KEY, this._tokenBuffOverrides, 'settings');
        } catch (error) {
            console.error('[LabSimUI] Failed to save labyrinth token levels:', error);
        }
    }

    /**
     * Read the remembered token levels back.
     * @private
     */
    async _restoreTokenBuffLevels() {
        try {
            this._tokenBuffOverrides = sanitizeTokenLevels(await readScoped(TOKEN_BUFF_LEVELS_KEY, 'settings', null));
        } catch (error) {
            console.error('[LabSimUI] Failed to restore labyrinth token levels:', error);
            this._tokenBuffOverrides = {};
        }
        this._refreshBuffsHeaderNote();
        const body = this.panel?.querySelector('#mwi-labsim-buffs-body');
        if (body && body.style.display !== 'none') this._renderBuffsSection();
    }

    /**
     * Get selected crate HRIDs from the Configure tab.
     * @returns {string[]}
     */
    getSelectedCrates() {
        // Default the combat crates to what the character has equipped, in case
        // the panel was built before data loaded; a manual pick has opted out.
        this._applyEquippedCombatCrates();
        const crates = [];
        const teaHrid = this.panel?.querySelector('#mwi-labsim-tea')?.value;
        const coffeeHrid = this.panel?.querySelector('#mwi-labsim-coffee')?.value;
        const foodHrid = this.panel?.querySelector('#mwi-labsim-food')?.value;
        if (teaHrid) crates.push(teaHrid);
        if (coffeeHrid) crates.push(coffeeHrid);
        if (foodHrid) crates.push(foodHrid);
        return crates;
    }

    /** @private */
    _switchTab(tab) {
        this._activeTab = tab;
        const configureContent = this.panel.querySelector('#mwi-labsim-configure-content');
        const maxLevelContent = this.panel.querySelector('#mwi-labsim-maxlevel-content');
        const upgradeContent = this.panel.querySelector('#mwi-labsim-upgrade-content');
        const skillingContent = this.panel.querySelector('#mwi-labsim-skilling-content');
        const tabConfigure = this.panel.querySelector('#mwi-labsim-tab-configure');
        const tabMaxLevel = this.panel.querySelector('#mwi-labsim-tab-maxlevel');
        const tabUpgrade = this.panel.querySelector('#mwi-labsim-tab-upgrade');
        const tabSkilling = this.panel.querySelector('#mwi-labsim-tab-skilling');

        const activeStyle = `flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:${ACCENT_BG}; color:${ACCENT}; border-bottom:2px solid ${ACCENT};`;
        const inactiveStyle =
            'flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:transparent; color:#888; border-bottom:2px solid transparent;';

        configureContent.style.display = 'none';
        maxLevelContent.style.display = 'none';
        upgradeContent.style.display = 'none';
        skillingContent.style.display = 'none';
        tabConfigure.style.cssText = inactiveStyle;
        tabMaxLevel.style.cssText = inactiveStyle;
        tabUpgrade.style.cssText = inactiveStyle;
        tabSkilling.style.cssText = inactiveStyle;

        if (tab === 'configure') {
            configureContent.style.display = 'flex';
            tabConfigure.style.cssText = activeStyle;
        } else if (tab === 'maxlevel') {
            maxLevelContent.style.display = 'flex';
            tabMaxLevel.style.cssText = activeStyle;
        } else if (tab === 'upgrade') {
            upgradeContent.style.display = 'flex';
            tabUpgrade.style.cssText = activeStyle;
            this._populateUpgradePlayerSelector();
            // Redrawn on the way in rather than only when the panel opens: a
            // skip level that has moved on should not need a reload to be
            // noticed
            this._populateUpgradeTargets();
            this._onUpgradeSelectionChanged();
        } else if (tab === 'skilling') {
            skillingContent.style.display = 'flex';
            tabSkilling.style.cssText = activeStyle;
            void this._showSkillingTab();
        }
    }

    /** @private */
    async _showSkillingTab() {
        try {
            if (!this._skillingEditor.isInitialized()) {
                await this._skillingEditor.initEditor();
            }
            await this._renderSkillLoadoutTable();
        } catch (error) {
            console.error('[LabSimUI] Failed to show skilling tab:', error);
            this._setStatus('Failed to load skilling tab: ' + error.message);
        }
    }

    /** @private */
    _setStatus(text) {
        const el = this.panel?.querySelector('#mwi-labsim-status');
        if (el) el.textContent = text;
    }

    /** @private */
    async _onSimulate() {
        if (this.isRunning) {
            cancelActiveSimulations();
            this._setStatus('Labyrinth simulation cancelled.');
            return;
        }

        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();

        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        const roomLevel = parseInt(this.panel.querySelector('#mwi-labsim-level')?.value) || 100;

        // Single Sim run caps. "Uncapped" ignores both numbers (they stay in the
        // fields) and runs to the precision target; otherwise the Max fights and
        // Max hrs inputs bound the run. When uncapped, fall back to a ceiling
        // high enough that only precision can end the run — a finite sentinel
        // keeps the engine's stop rule and the progress/ETA math well-defined.
        const uncapped = this.panel.querySelector('#mwi-labsim-uncapped')?.checked;
        const maxFightsCap = Math.max(1, parseInt(this.panel.querySelector('#mwi-labsim-maxfights')?.value) || 20000);
        const maxHoursCap = Math.max(1, parseInt(this.panel.querySelector('#mwi-labsim-maxhours')?.value) || 24);
        const maxTrials = uncapped ? Number.MAX_SAFE_INTEGER : maxFightsCap;
        const hours = uncapped ? 1e6 : maxHoursCap;

        if (!monsterHrid) {
            this._setStatus('Select a monster first.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const crates = this.getSelectedCrates();
        const labyrinthCombatBuffs = this._labyrinthCombatBuffs();

        let selfDTO;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            const selfHrid = this._editor.getSelfHrid();
            selfDTO = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        } else {
            const result = await buildAllPlayerDTOs();
            selfDTO = result.players.find((p) => p.hrid === result.selfHrid) || result.players[0];
        }

        if (!selfDTO) {
            this._setStatus('No character data available.');
            return;
        }

        const playerDTOs = [selfDTO];

        const communityBuffs = getCommunityBuffs();
        const zones = getCombatZones();
        const zoneHrid = zones[0]?.hrid || '/actions/combat/fly';

        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-labsim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-labsim-progress');
        const progressFill = this.panel.querySelector('#mwi-labsim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-labsim-progress-text');
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';

        const simStartTime = Date.now();
        // What is left of the run, measured from the run itself — the only
        // source for it, since the same sim takes wildly different times by
        // hours, party size and machine
        const eta = createEtaTracker();

        try {
            if (this._labyFindMaxMode) {
                // Same bar the labyrinth panel's Recommend button uses when the
                // field is blank — a hardcoded 95 here meant the two features
                // disagreed about what "clears" means
                const entered = parseInt(this.panel.querySelector('#mwi-labsim-threshold')?.value, 10);
                const threshold =
                    Number.isFinite(entered) && entered > 0
                        ? Math.min(100, Math.max(1, entered)) / 100
                        : defaultThreshold();
                // The search window follows the character rather than a fixed
                // 20-300, so it covers every room the automation table could
                // send them to and nothing else
                const referenceLevel = (
                    labyrinthClearRate() || bundledLabyrinthClearRate
                ).getPlayerEffectiveCombatLevel();
                const maxResult = await findMaxLabyrinthLevel(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        crates,
                        simHours: hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        threshold,
                        referenceLevel,
                    },
                    (progress) => {
                        const percent = Math.round((progress.step / progress.totalSteps) * 100);
                        const { text: remaining } = eta.update(progress.step / progress.totalSteps);
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent =
                            `Level ${progress.level} — ${(progress.winRate * 100).toFixed(0)}% ` +
                            `(step ${progress.step}/${progress.totalSteps})` +
                            (remaining ? ` · ${remaining}` : '');
                    }
                );

                this._maxLevel = maxResult.maxLevel;
                // Filed against the monster it was searched for, so the Upgrade
                // tab's "Sim max" can use it without re-searching and without
                // reading whichever fight happened to be searched last
                if (maxResult.cleared) this._maxLevelByMonster[monsterHrid] = maxResult.maxLevel;
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                // Nothing cleared means there is no level to put in the box —
                // writing 0 would sim a room that does not exist
                if (levelInput && maxResult.cleared) levelInput.value = maxResult.maxLevel;
                this._refreshLevelSourceReadout();

                this._displayFindMaxResults(maxResult, monsterHrid, simStartTime);
            } else {
                const simResult = await runLabyrinthSimulation(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        roomLevel,
                        crates,
                        hours,
                        // Same rule as the tile badges: stop once the win rate
                        // is pinned down, with Max hrs as the time ceiling and
                        // Max fights as the trial cap (both 0 = unlimited above)
                        precision: {
                            targetHalfWidth:
                                Math.min(
                                    10,
                                    Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1)))
                                ) / 100,
                            minTrials: 100,
                            maxTrials,
                        },
                        communityBuffs,
                        labyrinthCombatBuffs,
                        // Build the monster with its full tier-gated kit (stun,
                        // defence shred, self-buffs), same as the tile badges and
                        // calibration replay — a bare auto-attacker over-predicts
                        // the clear, which was rosier here than the tile it sits on.
                        fullAbilities: true,
                        // Never a task fight. A labyrinth monster is not your
                        // combat task, so taskDamage pays nothing here — the
                        // panel used to offer a checkbox for it, which could
                        // only ever be ticked to get a wrong answer.
                        isTaskFight: false,
                    },
                    (percent) => {
                        const { text: remaining } = eta.update(percent / 100);
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                    }
                );

                this._displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerDTOs[0].hrid);
                await this._recordSingleTargetRun(simResult, {
                    monsterHrid,
                    roomLevel,
                    hours,
                    crates,
                    playerHrid: playerDTOs[0].hrid,
                    ownerId,
                });
            }
        } catch (error) {
            if (error.message !== 'Cancelled') {
                console.error('[LabSimUI] Simulation failed:', error);
                this._setStatus('Simulation failed: ' + error.message);
            }
        } finally {
            this.isRunning = false;
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.style.cursor = 'pointer';
            progressContainer.style.display = 'none';
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
    }

    /** @private */
    _displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerHrid) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const attempts = simResult.labyAttemptCount || 0;
        const encounters = simResult.encounters || 0;
        const deaths = simResult.deaths?.[playerHrid || 'player1'] || 0;
        const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
        const winRate = attempts > 0 ? ((encounters / attempts) * 100).toFixed(2) : '0.00';
        // The win rate is a proportion off a sample, so the sample size and the
        // band around it are part of the answer rather than trivia
        const band = wilsonInterval(encounters, attempts);
        const bandText = Number.isFinite(band.halfWidth)
            ? `\u00b1${(band.halfWidth * 100).toFixed(2)}%${simResult.labyStoppedOnPrecision ? '' : ' (capped)'}`
            : 'not enough fights';

        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Level ${roomLevel}
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:12px;">
                    <div><span style="color:#888;">Win Rate:</span> <span style="color:${parseFloat(winRate) >= 95 ? '#4caf50' : parseFloat(winRate) >= 50 ? '#ff9800' : '#f44336'}; font-weight:600;">${winRate}%</span> <span style="color:#888;">${bandText}</span></div>
                    <div><span style="color:#888;">Encounters:</span> ${formatWithSeparator(attempts)}</div>
                    <div><span style="color:#888;">Deaths:</span> <span style="color:${deaths > 0 ? '#f44336' : '#4caf50'};">${formatWithSeparator(deaths)}</span></div>
                    <div><span style="color:#888;">Sim Time:</span> ${simHours.toFixed(1)}h</div>
                </div>
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed}</div>
            </div>
            <div id="mwi-labsim-comparison"></div>
        `;

        this._renderComparisonSection();
        this._setStatus(`Simulation complete \u2014 ${winRate}% win rate at level ${roomLevel}.`);
    }

    /**
     * Whether the character a run was started for is still the one logged in.
     *
     * A labyrinth run takes minutes, and everything recorded after it — the
     * comparison entry, the remembered upgrade analysis — is filed under a key
     * resolved at the moment of the write. A switch inside that window recorded
     * the departing character's run against the arriving character's gear
     * history and overwrote the analysis the arriving character was keeping.
     *
     * Compared rather than merely required, so a run with no character on
     * either side records exactly as it always has.
     *
     * @param {string|null|undefined} ownerId - The id captured before the run's first await
     * @returns {boolean} True when the results still belong to whoever is current
     * @private
     */
    _stillSameCharacter(ownerId) {
        return dataManager.getCurrentCharacterId() === ownerId;
    }

    /**
     * Keep a finished single-target run so the next one has something to be
     * read against.
     *
     * Only fixed-level fights are recorded. A Find Max run answers a different
     * question with a different headline number, and putting the two in one
     * table would invite a comparison that does not mean anything.
     *
     * @param {Object} simResult - From `runLabyrinthSimulation`
     * @param {Object} context - `{ monsterHrid, roomLevel, hours, crates, playerHrid, ownerId }`
     * @returns {Promise<void>}
     * @private
     */
    async _recordSingleTargetRun(simResult, { monsterHrid, roomLevel, hours, crates, playerHrid, ownerId }) {
        try {
            // The run measured the character it started under. Recorded after a
            // switch it would join the arriving character's comparison table,
            // where it reads as their own "before" and skews every delta.
            if (!this._stillSameCharacter(ownerId)) return;
            await this._comparison.load();
            await this._comparison.add(
                makeLabRunEntry({
                    monsterHrid,
                    monsterName: getLabyrinthMonsters().find((m) => m.hrid === monsterHrid)?.name,
                    roomLevel,
                    hours,
                    crates,
                    gearLabel: this._editor?.generateSimLabel?.() || '',
                    attempts: simResult.labyAttemptCount || 0,
                    encounters: simResult.encounters || 0,
                    deaths: simResult.deaths?.[playerHrid || 'player1'] || 0,
                    simHours: (simResult.simulatedTime || 0) / (3600 * 1e9) || hours,
                })
            );
            this._renderComparisonSection();
        } catch (error) {
            console.error('[LabSimUI] Failed to record run for comparison:', error);
        }
    }

    /**
     * Draw the comparison table under the latest single-target result, and
     * attach its controls.
     * @private
     */
    _renderComparisonSection() {
        const host = this.panel?.querySelector('#mwi-labsim-comparison');
        if (!host) return;

        host.innerHTML = renderLabComparisonPanel(this._comparison.runs, this._comparison.baselineId);
        wireLabComparisonPanel(host, {
            onBaseline: async (id) => {
                await this._comparison.setBaseline(id);
                this._renderComparisonSection();
            },
            onDelete: async (id) => {
                await this._comparison.remove(id);
                this._renderComparisonSection();
            },
            onClear: async () => {
                await this._comparison.clear();
                this._renderComparisonSection();
            },
        });
    }

    /**
     * Render a Find Max result.
     *
     * The objective is unchanged and stays unchanged: the highest room level
     * that still clears at the target rate. Experience per hour is shown beside
     * it as information \u2014 what that level is worth once losses and the walk are
     * paid for \u2014 not as something the search optimised.
     *
     * Two cases the old version got wrong. Nothing clearing anywhere in the
     * window used to print `0 - combatLevel + 1`, a large negative "recommended
     * skip" that reads like advice; it now says so in words. And a character
     * whose combat level is not known yet cannot have a skip derived at all,
     * since skip is a level offset.
     * @private
     */
    _displayFindMaxResults(maxResult, monsterHrid, simStartTime) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
        const barPct = ((maxResult.threshold ?? 0) * 100).toFixed(0);
        const effectiveCombatLevel = (
            labyrinthClearRate() || bundledLabyrinthClearRate
        ).getPlayerEffectiveCombatLevel();

        let headline;
        let detail;
        if (!maxResult.cleared) {
            headline = `<div style="font-size:16px; font-weight:700; color:#f44336; margin-bottom:6px;">
                    Nothing clears at ${barPct}%
                </div>`;
            detail = `<div style="font-size:12px; color:#888;">
                    No room between level ${maxResult.minLevel} and ${maxResult.maxSearched} met the target.
                    Lower the target win %, or bring stronger gear.
                </div>`;
        } else {
            const xpPerHour = (labyrinthClearRate() || bundledLabyrinthClearRate).estimateCombatXpPerHour(
                maxResult.maxLevel,
                maxResult.avgFightSeconds,
                maxResult.winRate
            );
            // Skip is a level offset, so it only exists once there is a level
            // to offset from; and it never sensibly goes below 1
            const rawSkip = effectiveCombatLevel > 0 ? maxResult.maxLevel - Math.floor(effectiveCombatLevel) + 1 : null;
            const skipText =
                rawSkip === null
                    ? 'unavailable until your combat level is known'
                    : rawSkip < 1
                      ? `1 (the lowest the game accepts \u2014 level ${maxResult.maxLevel} is below your own level)`
                      : String(rawSkip);

            headline = `<div style="font-size:24px; font-weight:700; color:#4caf50; margin-bottom:6px;">
                    Level ${maxResult.maxLevel}${maxResult.atCeiling ? '+' : ''}
                </div>`;
            detail =
                `<div style="font-size:12px; color:#888;">
                    Win Rate: <span style="color:#e0e0e0; font-weight:600;">${(maxResult.winRate * 100).toFixed(1)}%</span>
                    at level ${maxResult.maxLevel} (target ${barPct}%)
                </div>` +
                (xpPerHour > 0
                    ? `<div style="font-size:12px; color:#888; margin-top:4px;"
                            title="Experience per hour at this level, once lost attempts and the walk to the room are paid for. Shown for information \u2014 the search still picks the highest level clearing at the target rate, not the best experience.">
                            XP/hr here: <span style="color:#e0e0e0; font-weight:600;">${formatKMB(xpPerHour)}</span>
                        </div>`
                    : '') +
                `<div style="font-size:12px; color:#888; margin-top:4px;">
                    Recommended skip: <span style="color:#e0e0e0; font-weight:600;">${skipText}</span>
                </div>` +
                (maxResult.atCeiling
                    ? `<div style="font-size:11px; color:#ff9800; margin-top:4px;">
                            Still clearing at the top of the searched range (${maxResult.maxSearched}) \u2014 the true maximum may be higher.
                        </div>`
                    : '');
        }

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Find Max Result
                </div>
                ${headline}
                ${detail}
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed} (${maxResult.steps} steps, levels ${maxResult.minLevel}\u2013${maxResult.maxSearched})</div>
            </div>
        `;

        this._setStatus(
            maxResult.cleared
                ? `Max beatable level: ${maxResult.maxLevel} (${(maxResult.winRate * 100).toFixed(1)}% win rate).`
                : `No room cleared at ${barPct}% between levels ${maxResult.minLevel} and ${maxResult.maxSearched}.`
        );
    }

    /** @private */
    async _onUpgradeAnalyze() {
        // Checked synchronously, before any await below (buildAllPlayerDTOs in
        // particular): the Run button isn't hidden until well into this
        // function, so a second click landing in that window would otherwise
        // start a concurrent run sharing this._upgradeAborted and clobbering
        // the first run's results.
        if (this._upgradeRunning) return;
        this._upgradeRunning = true;

        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();

        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        // "Uncapped" ignores the Max fights / Max hrs numbers (they stay in the
        // fields) and lets each comparison's baseline run to the precision
        // target; the finite sentinels keep progress/ETA math well-defined.
        const upgradeUncapped = this.panel.querySelector('#mwi-labsim-upgrade-uncapped')?.checked;
        const upgradeMaxHours = Math.max(
            1,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-maxhours')?.value) || 24
        );
        const upgradeMaxFights = Math.max(
            1,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-maxfights')?.value) || 20000
        );
        const hours = upgradeUncapped ? 1e6 : upgradeMaxHours;
        // Bounds the baseline sim each comparison is paired against: it stops at
        // the precision target, the fight cap, or the time ceiling — whichever
        // first. Candidates then inherit the baseline's fight count (paired).
        const precision = {
            targetHalfWidth:
                Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1)))) / 100,
            minTrials: 100,
            maxTrials: upgradeUncapped ? Number.MAX_SAFE_INTEGER : upgradeMaxFights,
        };

        // The checked candidate sets and the chosen fights, resolved into the
        // one analysis they describe
        const useSkipLevels = this.panel.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
        const allFights = this._collectLabyrinthFights(useSkipLevels);
        this._upgradeTargetHrids = allFights.map((fight) => fight.monsterHrid);
        const plan = this._planFromControls();
        if (plan.kind === 'none') {
            this._setStatus(plan.error);
            this._upgradeRunning = false;
            return;
        }
        const isAllFights = plan.kind === 'allFights';

        const crates = this.getSelectedCrates();

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            this._upgradeRunning = false;
            return;
        }

        let playerDTOs;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
        }

        if (!playerDTOs?.length || !playerDTOs[playerIndex]) {
            this._setStatus('No player data available.');
            this._upgradeRunning = false;
            return;
        }

        const communityBuffs = getCommunityBuffs();
        // Both halves of the same answer: the buff array the sims run under, and
        // the levels those buffs came from — a Token Upgrades row steps up from
        // the level being simulated, not from the level the live run owns
        const tokenLevels = this._resolvedTokenLevels();
        const labyrinthCombatBuffs = this._labyrinthCombatBuffs();

        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-upgrade-results');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        runBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._upgradeAborted = false;
        // One tracker per run: it starts its clock where it is made
        const eta = createEtaTracker();

        const selectedDimensions = new Set(isAllFights ? plan.modes : [plan.upgradeMode, ...plan.extraModes]);
        // `combined` is the single-fight analysis's name for equipment plus
        // ability levels, so the two it stands for are what the options below
        // should be read for
        if (selectedDimensions.delete('combined')) {
            selectedDimensions.add('equipment');
            selectedDimensions.add('ability_level');
        }
        const abilityLevelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type')?.value || 'increment';
        let abilityTargetLevel = Math.min(
            200,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value, 10) || 0
        );
        const isCombatLevelMode = selectedDimensions.has('combat_level');
        // Combat levels are ranked as "+N on each skill", and N is this box —
        // an empty box would generate no candidates at all
        if (isCombatLevelMode && !abilityTargetLevel) abilityTargetLevel = 5;
        const combatLevelTargets = isCombatLevelMode ? this._getLabCombatLevelTargets() : null;
        const abilityTargets = selectedDimensions.has('ability_level')
            ? this._getAbilityTargets('#mwi-labsim-ability-targets')
            : null;
        // Blank boxes mean "one level up", which is what every generator does
        // with a zero, so an unopened option costs nothing to read
        const houseTargetLevel = selectedDimensions.has('house') ? this._getHouseTargetLevel() : 0;
        const houseTargets = selectedDimensions.has('house') ? this._getHouseTargets() : null;
        const guildShrineTargetLevel = selectedDimensions.has('guild_shrine') ? this._getShrineTargetLevel() : 0;
        const guildShrineTargets = selectedDimensions.has('guild_shrine') ? this._getShrineTargets() : null;
        // Default on: a shrine level the guild's shrine building cannot sell is
        // not an upgrade the character can buy, however well it would rank
        const guildShrineCapToGuild = selectedDimensions.has('guild_shrine')
            ? Boolean(this.panel.querySelector('#mwi-labsim-shrine-cap-guild')?.checked)
            : false;

        if (plan.dropped.length) {
            this._setStatus(
                `Skipped ${plan.dropped.join(', ')} — not available for this target scope. See the checkbox tooltip.`
            );
        }

        // Only worth a word when House Rooms is checked and the scan found
        // nothing to weigh; the rows speak for themselves when it did
        this._houseScanNote = selectedDimensions.has('house')
            ? this._describeHouseScan(playerDTOs[playerIndex], gameData)
            : '';

        // Which level the Configure fight is analysed at. Resolved from the
        // level source rather than read off the Level box, which opens on 100
        // and so quietly decided most of this panel's analyses. The whole-run
        // scopes never come through here — each of their fights carries its own
        // room level from the automation table.
        let roomLevel = 0;
        if (!isAllFights) {
            roomLevel = await this._resolveUpgradeRoomLevel({
                monsterHrid,
                gameData,
                playerDTOs,
                playerIndex,
                crates,
                hours,
                communityBuffs,
                labyrinthCombatBuffs,
            });
            if (!roomLevel || this._upgradeAborted) {
                if (!this._upgradeAborted) {
                    this._setStatus(
                        'No room level resolves for this fight. Pick a level source with a value behind it, ' +
                            'or put a level in the Configure tab.'
                    );
                }
                progressEl.style.display = 'none';
                runBtn.style.display = '';
                stopBtn.style.display = 'none';
                this._upgradeRunning = false;
                return;
            }
        }

        if (isAllFights) {
            try {
                const chosen = new Set(plan.monsterHrids);
                const fights = allFights.filter((fight) => chosen.has(fight.monsterHrid));
                if (!fights.length) {
                    this._setStatus(
                        'No labyrinth fights found — set combat skip levels in the game (or enter the labyrinth) so fights have room levels.'
                    );
                    return;
                }
                // Nothing is refused for being large any more, so the size is
                // said instead — first from the rough per-dimension estimate,
                // which needs nothing but the checkboxes, then replaced by the
                // analysis's own count the moment it has pooled its candidates.
                // Both land before the first simulation, while Stop still means
                // "I did not mean to ask for that".
                const estimate = estimateLabUpgradeSims(plan.modes, fights.length);
                this._setStatus(`Starting: ${estimate.text}. Stop cancels at any point.`);
                const analysisResult = await runLabyrinthAllFightsAnalysis(
                    {
                        fights,
                        crates,
                        hours,
                        precision,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        abilityTargetLevel,
                        combatLevelTargets,
                        abilityTargets,
                        modes: plan.modes,
                        auraSwapsOnly: this._getAuraSwapsOnly(),
                        houseTargetLevel,
                        houseTargets,
                        guildShrineTargetLevel,
                        guildShrineTargets,
                        guildShrineCapToGuild,
                        tokenLevels,
                    },
                    ({ current, total, description, plan: runPlan }) => {
                        if (this._upgradeAborted) return;
                        if (runPlan) this._setStatus(describeAllFightsPlan(runPlan));
                        const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                        const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                        const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                        if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                        if (text) {
                            text.textContent =
                                `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                        }
                    },
                    { abortSignal: () => this._upgradeAborted }
                );

                this._renderAllFightsResults(analysisResult, resultsEl);
            } catch (error) {
                if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                    console.error('[LabSimUI] All-fights analysis failed:', error);
                    this._setStatus('All-fights analysis failed: ' + error.message);
                }
            } finally {
                progressEl.style.display = 'none';
                runBtn.style.display = '';
                stopBtn.style.display = 'none';
                this._upgradeRunning = false;
            }
            return;
        }

        try {
            const analysisResult = await runLabyrinthUpgradeAnalysis(
                {
                    playerDTOs,
                    playerIndex,
                    monsterHrid,
                    roomLevel,
                    crates,
                    hours,
                    precision,
                    communityBuffs,
                    labyrinthCombatBuffs,
                    upgradeMode: plan.upgradeMode,
                    abilityLevelType,
                    abilityTargetLevel,
                    combatLevelTargets,
                    abilityTargets,
                    auraSwapsOnly: this._getAuraSwapsOnly(),
                    // The single-fight analysis takes one mode, and ranks
                    // anything else it is handed beside whatever that mode
                    // generated — which is how a multi-set selection lands in
                    // one table, against one baseline, at one shared seed
                    houseTargetLevel,
                    houseTargets,
                    guildShrineTargetLevel,
                    guildShrineTargets,
                    guildShrineCapToGuild,
                    tokenLevels,
                    // The second ranking pass, and the two numbers it needs:
                    // the window the level search runs over (the character's
                    // own level) and this tab's fight cap, so a search probe is
                    // bounded by the same Max fights every other sim here is.
                    rankByRoomLevels: this._getRankByRoomLevels(),
                    referenceLevel: (labyrinthClearRate() || bundledLabyrinthClearRate).getPlayerEffectiveCombatLevel(),
                    maxTrials: upgradeUncapped ? undefined : upgradeMaxFights,
                    extraCandidates: this._extraDimensionCandidates(
                        plan.extraModes,
                        playerDTOs[playerIndex],
                        gameData,
                        {
                            abilityTargetLevel,
                            abilityLevelType,
                            combatLevelTargets,
                            abilityTargets,
                            auraSwapsOnly: this._getAuraSwapsOnly(),
                            houseTargetLevel,
                            houseTargets,
                            guildShrineTargetLevel,
                            guildShrineTargets,
                            guildShrineCapToGuild,
                            communityBuffs,
                            communityBuffTargetLevel: this._getCommunityTargetLevel(),
                        }
                    ),
                },
                ({ current, total, description }) => {
                    if (this._upgradeAborted) return;
                    const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                    }
                },
                { abortSignal: () => this._upgradeAborted }
            );

            // A fresh run supersedes any restored set — drop the "from a previous
            // run" note before drawing, and remember the new results (opt-in).
            this._restoredUpgradeAt = null;
            this._restoredUpgradeMeta = null;
            // Travels with the results rather than being read at draw time: a
            // restored set was measured against whatever floor was set then
            if (analysisResult?.roomLevels) analysisResult.roomLevels.targetFloor = this._getTargetFloor();
            this._renderUpgradeResults(analysisResult, resultsEl);
            // The remembered set is per character and has no undo: writing this
            // run under the character who arrived mid-analysis would delete the
            // analysis they were keeping
            if (analysisResult?.results?.length && this._stillSameCharacter(ownerId)) {
                const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
                saveUpgradeResults(LAB_UPGRADE_RESULTS_KEY, analysisResult, {
                    characterName: (this._editor?.getPlayerInfo?.() || [])[playerIndex]?.name || null,
                });
            }
        } catch (error) {
            if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                console.error('[LabSimUI] Upgrade analysis failed:', error);
                this._setStatus('Upgrade analysis failed: ' + error.message);
            }
        } finally {
            progressEl.style.display = 'none';
            runBtn.style.display = '';
            stopBtn.style.display = 'none';
            this._upgradeRunning = false;
        }
    }

    /**
     * The candidates for every checked set the single-fight analysis is not
     * generating itself.
     *
     * `runLabyrinthUpgradeAnalysis` takes one mode and generates from it, then
     * ranks any `extraCandidates` beside the result. Generating the rest here
     * with the same exported generator keeps a multi-set selection to a single
     * analysis — one baseline sim, one shared random seed, one ranked table —
     * rather than one run per checked box with a separate baseline each.
     *
     * @param {string[]} modes - Sets the analysis's own mode does not cover
     * @param {Object} playerDTO - The loadout being analyzed
     * @param {Object} gameData - From `buildGameDataPayload`
     * @param {Object} options - `{ abilityTargetLevel, abilityLevelType, combatLevelTargets, abilityTargets,
     *   auraSwapsOnly, houseTargetLevel, houseTargets, guildShrineTargetLevel, guildShrineTargets,
     *   guildShrineCapToGuild }`
     * @returns {Array<Object>} Candidates, deduplicated by the analysis itself
     * @private
     */
    _extraDimensionCandidates(modes, playerDTO, gameData, options = {}) {
        if (!modes?.length || !playerDTO || !gameData) return [];
        const {
            abilityTargetLevel,
            abilityLevelType,
            combatLevelTargets,
            abilityTargets,
            auraSwapsOnly = false,
            houseTargetLevel = 0,
            houseTargets = null,
            guildShrineTargetLevel = 0,
            guildShrineTargets = null,
            guildShrineCapToGuild = false,
            communityBuffs = null,
            communityBuffTargetLevel = 0,
        } = options;
        try {
            return modes.flatMap((mode) =>
                generateCandidates(
                    playerDTO,
                    gameData,
                    mode,
                    abilityTargetLevel,
                    abilityLevelType,
                    false,
                    combatLevelTargets,
                    abilityTargets,
                    houseTargetLevel,
                    houseTargets,
                    communityBuffs,
                    guildShrineTargetLevel,
                    {
                        auraSwapsOnly,
                        houseWinRateOnly: true,
                        communityBuffTargetLevel,
                        guildShrineTargets,
                        guildShrineCapToGuild,
                    }
                )
            );
        } catch (error) {
            console.error('[LabSimUI] Failed to generate candidates for', modes, error);
            return [];
        }
    }

    /**
     * The room level the Configure-fight analysis should run at.
     *
     * Everything but Sim max is already known and costs nothing to look up. Sim
     * max is a binary search over simulations, so it is run here — once per
     * monster per panel session, on the way into the analysis, with its progress
     * on the analysis's own bar. Doing it here rather than making the player run
     * Find Max first is the point of offering it as a default at all.
     *
     * A search that clears nothing leaves the source with no level, and the
     * resolver falls through to the skip level and then to the Configure box
     * rather than analysing a room that does not exist.
     *
     * @param {Object} params - `{ monsterHrid, gameData, playerDTOs, playerIndex,
     *   crates, hours, communityBuffs, labyrinthCombatBuffs }`
     * @returns {Promise<number>} Room level, 0 when nothing resolves
     * @private
     */
    async _resolveUpgradeRoomLevel({
        monsterHrid,
        gameData,
        playerDTOs,
        playerIndex,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs,
    }) {
        if (this._getLevelSource() === 'sim_max' && monsterHrid && !this._maxLevelByMonster[monsterHrid]) {
            try {
                const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
                const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
                if (text) text.textContent = 'Finding the highest level this loadout clears…';

                const maxResult = await findMaxLabyrinthLevel(
                    {
                        gameData,
                        playerDTOs: [playerDTOs[playerIndex]],
                        zoneHrid: getCombatZones()[0]?.hrid || '/actions/combat/fly',
                        monsterHrid,
                        crates,
                        simHours: hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        threshold: defaultThreshold(),
                        referenceLevel: (
                            labyrinthClearRate() || bundledLabyrinthClearRate
                        ).getPlayerEffectiveCombatLevel(),
                    },
                    (progress) => {
                        // Stop cannot cut the search short — it has no abort of
                        // its own — but the flag is honoured the moment it ends
                        if (this._upgradeAborted) return;
                        if (fill) fill.style.width = `${Math.round((progress.step / progress.totalSteps) * 100)}%`;
                        if (text) {
                            text.textContent =
                                `Find Max: level ${progress.level} — ${(progress.winRate * 100).toFixed(0)}% ` +
                                `(step ${progress.step}/${progress.totalSteps})`;
                        }
                    }
                );

                if (maxResult?.cleared) this._maxLevelByMonster[monsterHrid] = maxResult.maxLevel;
                this._refreshLevelSourceReadout();
            } catch (error) {
                if (error?.message !== 'Cancelled') {
                    console.error('[LabSimUI] Find Max for the upgrade level failed:', error);
                }
            }
        }

        return this._resolveTargetLevel(monsterHrid).level;
    }

    /**
     * What to say about house rooms when the set came back empty.
     *
     * House candidates ride along inside the shared analyses now — the applier
     * they build each candidate's character with has a branch for a room level,
     * so a room goes in the same table, against the same baseline, on the same
     * seed as every other row. What no table can say for itself is *why* it has
     * no house rows in it: every combat room already at the cap is a different
     * answer from a game with no combat-relevant rooms in it, and neither of
     * them reads as "nothing worth buying".
     *
     * Costs nothing to ask — it is a scan of the room map, not a simulation.
     *
     * @param {Object} playerDTO - The character being analyzed
     * @param {Object} gameData - From `buildGameDataPayload`
     * @returns {string} A phrase for the status line, empty when rooms were found
     * @private
     */
    _describeHouseScan(playerDTO, gameData) {
        try {
            if (!playerDTO || !gameData) return '';
            if (generateHouseCandidates(playerDTO, gameData, 0, null, HOUSE_WIN_RATE_ONLY).length) return '';
            const scan = describeHouseScan(playerDTO, gameData, HOUSE_WIN_RATE_ONLY);
            return scan.combatRelevant
                ? `all ${scan.combatRelevant} combat house rooms are already maxed`
                : 'no house rooms whose buffs can move a win rate';
        } catch (error) {
            console.error('[LabSimUI] House room scan failed:', error);
            return '';
        }
    }

    /**
     * Build the per-room target inputs, prefilled from the uniform Lv box.
     *
     * Only the rooms this tab can rank: the labyrinth reads one number off a
     * simulation and a room that cannot move it has no target worth setting.
     * Levels come from the edited loadout where there is one, so a room raised
     * in the Player Setup editor is offered from where the editor put it.
     * @private
     */
    _buildLabHouseTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-house-targets');
        if (!grid) return;

        const gameData = buildGameDataPayload();
        const roomMap = gameData?.houseRoomDetailMap || {};
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(MAX_HOUSE_LEVEL, Math.max(0, parseInt(this._getHouseTargetLevelInput()) || 0));

        const rooms = Object.entries(roomMap)
            .filter(([, detail]) => houseRoomMovesWinRate(detail))
            .map(([hrid, detail]) => ({
                hrid,
                name: detail.name || hrid.split('/').pop().replace(/_/g, ' '),
                level: Math.max(0, Math.floor(Number(dto?.houseRooms?.[hrid]) || 0)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!rooms.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No house room in this game data carries a buff that could ' +
                'move a labyrinth win rate.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>House</b> target levels (blank or ≤ ' +
            'current level skips the room; used instead of the Lv box while open):</span>' +
            rooms
                .map(
                    (room) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${room.name} (${room.level})</label>
                    <input type="number" min="1" max="${MAX_HOUSE_LEVEL}" data-lab-house-target="${room.hrid}"
                        value="${room.level >= MAX_HOUSE_LEVEL ? '' : Math.min(MAX_HOUSE_LEVEL, Math.max(uniform, room.level + 1))}"
                        ${room.level >= MAX_HOUSE_LEVEL ? 'disabled title="Already at max level"' : ''} style="
                        width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Build the per-shrine target inputs, prefilled from the uniform Lv box.
     *
     * The House grid's arrangement, for the same reason it exists there: one Lv
     * box across the board asks every shrine for the same absolute level, and
     * shrines are not at the same level as each other — a single 6 was a no-op
     * for everything already past 6 and a five-level purchase for everything
     * below it, in one undifferentiated row set.
     *
     * Combat shrines only, matching what `generateGuildShrineCandidates` is
     * asked for here: this tab ranks win rate, and a skilling shrine has no
     * column it could move.
     * @private
     */
    _buildLabShrineTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-shrine-targets');
        if (!grid) return;

        const detailMap = getGuildBuffDetailMap();
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(MAX_GUILD_SHRINE_LEVEL, Math.max(0, this._getShrineTargetLevel()));

        const shrines = Object.entries(detailMap)
            .filter(([, detail]) => Boolean(detail?.isCombat))
            .map(([buffHrid, detail]) => ({
                buffHrid,
                name: shrineDisplayName(detail.shrineHrid || buffHrid),
                level: Math.max(0, Math.floor(Number(dto?.guildShrineLevels?.[buffHrid]) || 0)),
                maxLevel: Math.min(MAX_GUILD_SHRINE_LEVEL, guildBuffMaxLevel(detail) || MAX_GUILD_SHRINE_LEVEL),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!shrines.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No combat guild shrine reached the client — join a ' +
                'guild, or open the shrine screen once, so the levels are known.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>Guild Shrine</b> target levels (blank ' +
            'or ≤ current level evaluates one level up; <b>0 skips the shrine</b>; used instead of the Lv ' +
            'box while open):</span>' +
            shrines
                .map(
                    (shrine) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${shrine.name} (${shrine.level})</label>
                    <input type="number" min="0" max="${shrine.maxLevel}" data-lab-shrine-target="${shrine.buffHrid}"
                        value="${
                            shrine.level >= shrine.maxLevel
                                ? ''
                                : Math.min(shrine.maxLevel, Math.max(uniform, shrine.level + 1))
                        }"
                        ${shrine.level >= shrine.maxLevel ? 'disabled title="Already at max level"' : ''} style="
                        width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Per-shrine target levels, or null when the grid is closed.
     *
     * Three readings, the same contract the combat sim's grid sends and
     * `generateGuildShrineCandidates` reads off `perBuffTargets`: a level buys
     * up to it, an explicit **0 drops that shrine** from the run, and a blank
     * box sends -1 for "one level up". This grid used to emit positives only
     * and leave a blank box out of the map, which the advisor reads as a skip —
     * so two grids in the same panel family disagreed about what an empty box
     * meant, and clearing one here quietly dropped the shrine instead of
     * stepping it once.
     *
     * A box disabled because the buff is already maxed is left out of the map
     * entirely, which the advisor also reads as a skip.
     *
     * @returns {Object|null} buffHrid → target level
     * @private
     */
    _getShrineTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-shrine-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-shrine-target]').forEach((input) => {
            if (input.disabled) return;
            const value = parseInt(input.value, 10);
            if (!Number.isFinite(value)) {
                targets[input.dataset.labShrineTarget] = -1;
            } else if (value <= 0) {
                targets[input.dataset.labShrineTarget] = 0;
            } else {
                targets[input.dataset.labShrineTarget] = Math.min(MAX_GUILD_SHRINE_LEVEL, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * The community buff level the Skilling tab should sim at, 0 when the box is
     * empty (one level up).
     * @returns {number}
     * @private
     */
    _getSkillingCommunityTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-skilling-community-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_COMMUNITY_BUFF_LEVEL, value) : 0;
    }

    /** @returns {string} Whatever the uniform house Lv box holds @private */
    _getHouseTargetLevelInput() {
        return this.panel?.querySelector('#mwi-labsim-house-target-level')?.value || '';
    }

    /**
     * The uniform house target level, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getHouseTargetLevel() {
        const value = parseInt(this._getHouseTargetLevelInput(), 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_HOUSE_LEVEL, value) : 0;
    }

    /**
     * Per-room house target levels, or null when the grid is closed.
     * @returns {Object|null} roomHrid → target level
     * @private
     */
    _getHouseTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-house-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-house-target]').forEach((input) => {
            const value = parseInt(input.value, 10);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.labHouseTarget] = Math.min(MAX_HOUSE_LEVEL, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * The shrine level to buy up to, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getShrineTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-shrine-target-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_GUILD_SHRINE_LEVEL, value) : 0;
    }

    /**
     * The community buff level to sim at, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getCommunityTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-community-target-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_COMMUNITY_BUFF_LEVEL, value) : 0;
    }

    /**
     * Prefill the per-skill target inputs from the selected player's current
     * levels plus the +Levels boost. For a single fight, skills the weapon
     * style can't train are hidden; a multi-fight scope keeps every skill
     * visible, since assigned loadouts can differ in style.
     * @private
     */
    _prefillLabCombatTargets() {
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const boost = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value) || 5;
        const isAllFights = this._upgradeTargetCount() > 1;

        const gameData = buildGameDataPayload();
        const excluded = !isAllFights && dto && gameData ? getStyleExcludedSkills(dto, gameData) : new Set();

        this.panel.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const isExcluded = excluded.has(input.dataset.labCombatTarget);
            const wrapper = input.closest('span');
            if (wrapper) wrapper.style.display = isExcluded ? 'none' : 'inline-flex';
            if (isExcluded) {
                input.value = '';
                return;
            }
            const current = Math.max(1, Math.floor(dto?.[input.dataset.labCombatTarget] || 1));
            input.value = Math.min(200, current + boost);
        });
    }

    /**
     * Every ability the current target scope can level, deduplicated.
     *
     * For the Configure fight that is one loadout, which is what this grid
     * always showed. For a whole run — or a chosen subset — it is the *union*
     * across the loadouts those fights are assigned, which is what it showed
     * before and should have: ten fights across a melee and a magic loadout
     * offered targets for five magic abilities, and every melee ability in the
     * run had no way to be given one at all.
     *
     * An ability slotted in two loadouts is one entry, because a target is a
     * level on the ability itself and applies wherever it is equipped. The
     * loadouts it belongs to come with it, so the label can say so when they
     * are not all of them, and the levels come as a set, because the same
     * ability is often held at different levels in different loadouts.
     *
     * @param {string} [playerSelector] - Which player select the single-loadout
     *   fallback reads its index from
     * @returns {Array<Object>} `[{ hrid, name, levels, loadouts, shared }]`, by name
     * @private
     */
    _upgradeAbilityEntries(playerSelector = '#mwi-labsim-upgrade-player') {
        const gameData = buildGameDataPayload();
        const nameOf = (hrid) => gameData?.abilityDetailMap?.[hrid]?.name || hrid.split('/').pop();

        const scopeMode = this._getUpgradeScopeMode();
        if (scopeMode !== 'current') {
            const chosen = scopeMode === 'selected' ? new Set(this._getChosenTargets()) : null;
            const useSkipLevels = this.panel?.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
            const fights = this._collectLabyrinthFights(useSkipLevels).filter(
                (fight) => !chosen || chosen.has(fight.monsterHrid)
            );
            const loadoutCount = new Set(fights.map((fight) => fight.loadoutName)).size;
            const byHrid = new Map();
            for (const fight of fights) {
                for (const ability of fight.dto?.abilities || []) {
                    if (!ability?.hrid) continue;
                    let entry = byHrid.get(ability.hrid);
                    if (!entry) {
                        entry = { hrid: ability.hrid, levels: new Set(), loadouts: new Set() };
                        byHrid.set(ability.hrid, entry);
                    }
                    entry.levels.add(Math.max(1, Math.floor(Number(ability.level) || 1)));
                    entry.loadouts.add(fight.loadoutName);
                }
            }
            if (byHrid.size) {
                return [...byHrid.values()]
                    .map((entry) => ({
                        hrid: entry.hrid,
                        name: nameOf(entry.hrid),
                        levels: [...entry.levels].sort((a, b) => a - b),
                        loadouts: [...entry.loadouts],
                        // Unlabelled when every loadout in the set casts it —
                        // a label on all of them is noise on all of them
                        shared: entry.loadouts.size >= loadoutCount,
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
            // No fight resolves a loadout yet; the Configure loadout below is a
            // better answer than an empty grid
        }

        const playerIndex = parseInt(this.panel?.querySelector(playerSelector)?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        return (dto?.abilities || [])
            .filter((ability) => ability?.hrid)
            .map((ability) => ({
                hrid: ability.hrid,
                name: nameOf(ability.hrid),
                levels: [Math.max(1, Math.floor(Number(ability.level) || 1))],
                loadouts: [],
                shared: true,
            }));
    }

    /**
     * Rebuild and prefill the per-ability target inputs for whatever the target
     * scope covers (highest current level + the +Levels boost).
     *
     * Anything already typed survives the rebuild: the grid is redrawn whenever
     * the scope changes, and a target typed for Fireball should not be lost
     * because a second fight was ticked.
     * @private
     */
    _prefillAbilityTargets(grid, playerSelector, levelSelector) {
        const boost = parseInt(this.panel.querySelector(levelSelector)?.value) || 5;
        const typed = {};
        grid.querySelectorAll('[data-ability-target]').forEach((input) => {
            const value = parseInt(input.value, 10);
            if (Number.isFinite(value) && value > 0) typed[input.dataset.abilityTarget] = value;
        });

        const entries = this._upgradeAbilityEntries(playerSelector);
        if (!entries.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No abilities equipped — configure a simulation first.</span>';
            return;
        }

        const multiLoadout = entries.some((entry) => entry.loadouts.length > 0);
        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level ' +
            'skips the ability; used instead of the +Levels boost while open)' +
            (multiLoadout ? ' — every ability across the checked fights, with the loadouts it is slotted in' : '') +
            ':</span>' +
            entries
                .map((entry) => {
                    const lowest = entry.levels[0];
                    const highest = entry.levels[entry.levels.length - 1];
                    const levelText = lowest === highest ? `${lowest}` : `${lowest}–${highest}`;
                    const loadoutText = entry.shared ? '' : ` [${entry.loadouts.join(', ')}]`;
                    // Off the highest of them, so the boost is a real boost in
                    // every loadout rather than a no-op in the ones already past it
                    const target = Math.min(200, typed[entry.hrid] || highest + boost);
                    return `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;" title="${entry.loadouts.join(', ')}">${entry.name} (${levelText})<span style="color:#666;">${loadoutText}</span></label>
                    <input type="number" min="1" max="200" data-ability-target="${entry.hrid}" value="${target}" style="
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

    /**
     * Read the per-skill target map when the targets grid is open.
     * @private
     * @returns {Object|null} {skillKey: targetLevel} or null when not in use
     */
    _getLabCombatLevelTargets() {
        const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.labCombatTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Collect every labyrinth combat fight: each monster with a resolvable
     * room level paired with the player DTO wearing its assigned labyrinth
     * loadout. Room levels come from the automation skip thresholds
     * (effective combat level + skip − 1) unless useSkipLevels is false, in
     * which case an active run's live room levels take precedence.
     * @private
     * @param {boolean} [useSkipLevels=true]
     * @returns {Array<{monsterHrid: string, monsterName: string, roomLevel: number, dto: Object, loadoutName: string}>}
     */
    _collectLabyrinthFights(useSkipLevels = true) {
        const fights = [];
        for (const monster of getLabyrinthMonsters()) {
            const roomLevel = useSkipLevels
                ? (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatSkipRoomLevel(monster.hrid)
                : (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatRoomLevel(monster.hrid);
            if (!roomLevel) continue; // no skip threshold configured for this monster
            const loadoutId = (labyrinthClearRate() || bundledLabyrinthClearRate).getLabyrinthLoadoutId(monster.hrid);
            const dto = (labyrinthClearRate() || bundledLabyrinthClearRate).buildLabyrinthPlayerDTO(loadoutId);
            if (!dto) continue;
            const loadoutName =
                (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots[loadoutId]?.name ||
                (loadoutId ? `Loadout #${loadoutId}` : 'Current gear');
            fights.push({ monsterHrid: monster.hrid, monsterName: monster.name, roomLevel, dto, loadoutName });
        }
        return fights;
    }

    /**
     * Put an Export CSV button above a results table.
     *
     * A ranked table in a panel is read once and closed; the same numbers in a
     * spreadsheet can be sorted another way, kept beside last week's run, and
     * shown to someone else — which is most of what people do with an analysis
     * that took minutes to produce.
     *
     * The button is a sibling of the container rather than inside it: sorting a
     * column re-renders the container's whole innerHTML, and a button living in
     * there would vanish the first time anyone clicked a header.
     *
     * @param {HTMLElement} container - The results container
     * @param {string} stem - Filename stem, e.g. `labsim-upgrades`
     * @param {Function} build - Returns `{ rows, columns }` at click time, so the
     *   export is of what is on screen now rather than what was there at render
     * @private
     */
    _addCsvExport(container, stem, build) {
        const previous = container.previousElementSibling;
        if (previous?.dataset?.csvExport) previous.remove();

        const bar = document.createElement('div');
        bar.dataset.csvExport = stem;
        bar.style.cssText = 'display:flex; justify-content:flex-end; margin:0 0 6px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.style.cssText =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer;';

        const flash = (text) => {
            button.textContent = text;
            clearTimeout(this._csvFlash);
            this._csvFlash = setTimeout(() => {
                button.textContent = 'Export CSV';
            }, 1600);
        };

        button.addEventListener('click', () => {
            try {
                const { rows, columns } = build();
                if (!rows?.length) {
                    flash('Nothing to export');
                    return;
                }
                flash(downloadCsv(csvFilename(stem), toCsv(rows, columns)) ? 'Saved \u2713' : 'Failed');
            } catch (error) {
                console.error('[LabSimUI] CSV export failed:', error);
                flash('Failed');
            }
        });

        bar.appendChild(button);
        container.parentNode?.insertBefore(bar, container);
    }

    /**
     * The shopping list a budget buys, above the table it came from.
     *
     * The table answers "what is the best single thing"; nobody buys one thing.
     * This answers the question people actually have — "I have 500M, what should
     * I get" — by walking the table in value order and taking what fits, one
     * upgrade per slot, skipping anything whose gain is inside the simulation's
     * own error.
     *
     * @param {Array<Object>} results - Ranked results
     * @param {Object} baseline - Baseline metrics, for valuing room coverage
     * @returns {string} HTML
     * @private
     */
    _renderBudgetPlan(results, baseline) {
        const budget = this._allFightsBudget ?? 0;
        const baselineFights = baseline?.fights || [];
        const money = (value) => formatKMB(Math.round(value));
        const inputStyle =
            'width:90px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; ' +
            'padding:2px 6px; font-size:11px;';
        const btnStyle =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer;';

        let body = '';
        if (budget > 0) {
            const plan = planWithinBudget(results, budget, { baselineFights });
            if (!plan.picks.length) {
                body = `<div style="color:#888; font-size:11px;">Nothing in the list fits ${money(budget)}${
                    plan.skipped.length ? ' — the cheapest measured upgrade costs more.' : '.'
                }</div>`;
            } else {
                const rows = plan.picks
                    .map((pick) => {
                        // The saving credited to this pick is what it adds
                        // *beyond the others* — a second piece for a slot is
                        // worth only the rooms it improves on the first
                        const rooms = pick.rooms ?? 0;
                        return `<div style="display:flex; justify-content:space-between; gap:10px; padding:1px 0;">
                                <span style="color:#e0e0e0;">${pick.candidate.description}
                                    <span style="color:#666;">· ${rooms} room${rooms === 1 ? '' : 's'}</span>
                                    ${combatSimUI.upgradeRowActionsHtml(pick)}</span>
                                <span style="white-space:nowrap; color:#aaa;">${goldCostCell(pick.cost)}
                                    <span style="color:#4caf50;">−${(pick.marginalAttemptsSaved ?? -pick.attemptsDelta).toFixed(1)} attempts</span></span>
                            </div>`;
                    })
                    .join('');
                const noise = plan.skipped.filter((s) => s.reason.startsWith('within the noise')).length;
                body =
                    rows +
                    `<div style="margin-top:4px; padding-top:4px; border-top:1px solid #222; color:#aaa; font-size:11px;">
                        ${plan.picks.length} upgrades ·
                        ${
                            // A plan whose resales outrun its purchases spends
                            // nothing at all — "−17.7M of 500M" reads as an
                            // outlay, and it is the opposite of one
                            plan.totalCost < 0
                                ? `${money(-plan.totalCost)} back, none of ${money(budget)} spent`
                                : `${money(plan.totalCost)} of ${money(budget)}`
                        } ·
                        <span style="color:#4caf50; font-weight:600;">−${plan.attemptsSaved.toFixed(1)} attempts</span>
                        <span style="color:#666;"> if gains in different slots add up</span>
                        <button id="mwi-labsim-verify-combo" style="${btnStyle} margin-left:8px;"
                            title="Runs the whole run again with every pick installed at once — each loadout wearing all of the picks that apply to it, and the better one where two picks share a slot. Upgrades that fix the same failing room overlap, and the total above counts that room twice.">Verify together</button>
                        ${
                            planPurchases(plan.picks).length
                                ? `<button id="mwi-labsim-budget-market" style="${btnStyle} margin-left:4px;"
                            title="Opens the marketplace with one tab per purchase in this plan, so the whole list is one trip.">Open all in marketplace</button>`
                                : ''
                        }
                    </div>` +
                    (noise
                        ? `<div style="color:#666; font-size:10px; margin-top:2px;">${noise} skipped as within the simulation's own error</div>`
                        : '') +
                    `<div id="mwi-labsim-combo-result" style="margin-top:4px; font-size:11px;"></div>`;
            }
        }

        return `<div id="mwi-labsim-budget" style="margin-bottom:8px; padding:6px 8px; background:#0d0d1a;
            border:1px solid #222; border-radius:4px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:11px; color:#888;">
                <span style="color:${ACCENT}; font-weight:700;">Budget</span>
                <input id="mwi-labsim-budget-input" type="text" inputmode="numeric" placeholder="e.g. 500m"
                    value="${this._allFightsBudgetText || ''}" style="${inputStyle}">
                <button id="mwi-labsim-budget-plan" style="${btnStyle}">Plan</button>
                <span style="color:#555;">best set that fits — most rooms covered per coin, skipping gains inside the noise</span>
            </div>
            ${body ? `<div style="margin-top:6px;">${body}</div>` : ''}
        </div>`;
    }

    /**
     * Make the budget box work: parse what was typed, re-render on Plan, and run
     * the combination check on Verify.
     * @private
     */
    _wireBudgetPlan(container, results, baseline) {
        const input = container.querySelector('#mwi-labsim-budget-input');
        const plan = () => {
            this._allFightsBudgetText = input?.value || '';
            const typed = parseKMB(this._allFightsBudgetText);
            this._allFightsBudget = Number.isFinite(typed) ? typed : 0;
            this._renderAllFightsResults(this._allFightsResult, container);
        };
        container.querySelector('#mwi-labsim-budget-plan')?.addEventListener('click', plan);
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') plan();
        });

        // "Save for this" and "Watch" on each pick
        combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');

        container.querySelector('#mwi-labsim-budget-market')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const label = button.textContent;
            const picks = planWithinBudget(results, this._allFightsBudget ?? 0, {
                baselineFights: baseline?.fights || [],
            }).picks;

            button.disabled = true;
            button.textContent = 'Opening…';
            try {
                const opened = await openPlanInMarketplace(picks);
                button.textContent = opened ? `${opened} tab${opened === 1 ? '' : 's'} ✓` : 'Marketplace unavailable';
            } catch (error) {
                console.error('[LabSimUI] Opening the plan in the marketplace failed:', error);
                button.textContent = 'Failed';
            } finally {
                button.disabled = false;
                setTimeout(() => {
                    button.textContent = label;
                }, 1600);
            }
        });

        container.querySelector('#mwi-labsim-verify-combo')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const output = container.querySelector('#mwi-labsim-combo-result');
            const picks = planWithinBudget(results, this._allFightsBudget ?? 0, {
                baselineFights: baseline?.fights || [],
            }).picks;
            if (!picks.length || !output) return;

            button.disabled = true;
            button.textContent = 'Checking…';
            try {
                const check = await runLabyrinthCombinationCheck(
                    {
                        picks,
                        baseline,
                        pairing: this._allFightsResult?.pairing,
                        context: this._allFightsResult?.context,
                    },
                    ({ current, total, description }) => {
                        button.textContent = `${current} / ${total} ${description}`;
                    },
                    { abortSignal: () => this._upgradeAborted }
                );
                output.innerHTML = check ? this._renderComboCheck(check) : '';
            } catch (error) {
                console.error('[LabSimUI] Combination check failed:', error);
                output.innerHTML = '<span style="color:#f44336;">Combination check failed — see console.</span>';
            } finally {
                button.disabled = false;
                button.textContent = 'Verify together';
            }
        });
    }

    /**
     * What the set turned out to be worth, next to what the parts promised.
     * @private
     */
    _renderComboCheck(check) {
        const worn = check.fights?.length ? Math.max(...check.fights.map((f) => f.installed?.length || 0)) : 0;
        const promised = -check.summedDelta;
        const actual = -check.attemptsDelta;
        // Overlap is the usual outcome and not a fault: two upgrades that both
        // rescue the same failing room cannot both be the thing that rescued it
        const lost = promised - actual;
        const share = promised > 0 ? Math.round((lost / promised) * 100) : 0;
        const colour = lost > check.noise ? '#ff9800' : '#4caf50';
        return `<span style="color:#e0e0e0;">Together: <b>−${actual.toFixed(1)}</b> attempts</span>
            <span style="color:#666;">(each loadout wearing every pick that fits it, up to ${worn} at once)</span>
            <span style="color:#888;">vs −${promised.toFixed(1)} promised by the parts</span>
            <span style="color:${colour};">${
                lost > check.noise
                    ? `— ${share}% of it was double-counted (they overlap)`
                    : '— they do not overlap, the sum holds'
            }</span>
            <span style="color:#555;">±${check.noise.toFixed(1)}</span>`;
    }

    /**
     * Render the all-fights combat level analysis: candidates ranked by how
     * many expected combat attempts they save across the whole run (retrying
     * failed rooms), with a per-fight breakdown on click.
     * @private
     */
    _renderAllFightsResults(analysisResult, container) {
        const baseline = analysisResult?.baseline;
        const results = analysisResult?.results;
        if (!baseline || !results?.length) {
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No results — check that combat skip levels and loadouts are set.</div>';
            this._setStatus('All-fights analysis produced no results.');
            return;
        }

        // Kept so a header click can re-render without re-running the analysis
        this._allFightsResult = analysisResult;
        this._allFightsContainer = container;

        // Two currencies, two sections — the same split the Configure fight's
        // table makes. A token buff has no coin price at all, so it cannot share
        // a Cost column, a Per 1M column or the budget planner with the gear.
        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType !== 'token');

        const pct = (v) => `${(v * 100).toFixed(1)}%`;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const deltaColor = (v) => (v > 0.0001 ? '#4caf50' : v < -0.0001 ? '#f44336' : '#888');
        // Fewer expected attempts = better, so the good direction is negative
        const attemptsDeltaColor = (v) => (v < -0.05 ? '#4caf50' : v > 0.05 ? '#f44336' : '#888');
        const fmtAttempts = (v) => v.toFixed(1);
        // Per-million values run small — two decimals would print most of them
        // as 0.00, which reads as "no value" rather than "a modest one"
        const fmtPerMillion = (v) => (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2));
        const fmtAttemptsDelta = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
        const expectedTries = (winRate) => 1 / Math.max(winRate, 0.001);
        // Sticky needs an opaque background or rows scroll through the header.
        // The offset is the results pane's own padding, so the header parks flush
        // with the top of the scroll area rather than floating below it.
        const thStyle =
            'padding:4px 6px; text-align:left; border-bottom:1px solid #333; color:#888; font-weight:600; ' +
            'white-space:nowrap; position:sticky; top:-10px; z-index:2; background:#12121f;';
        const tdStyle = 'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap;';
        // Only the Upgrade name reflows; a two-piece swap label is long enough
        // to push every measured column off the panel if it is kept to one line
        const tdNameStyle =
            'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';
        const bestDelta = Math.min(...results.map((r) => r.attemptsDelta));
        const sharedStyles = { thStyle, tdStyle, tdNameStyle, fmtAttempts, fmtAttemptsDelta, attemptsDeltaColor };

        // What each column sorts by, and which way round is "good" — clicking
        // Cost wants the cheapest first, clicking Avg ΔWin the biggest gain
        const SORTS = {
            upgrade: { get: (r) => r.candidate?.description || '', dir: 'asc' },
            cost: { get: (r) => r.cost, dir: 'asc' },
            perMillion: { get: (r) => r.attemptsSavedPerMillion, dir: 'desc' },
            attempts: { get: (r) => r.expectedAttempts, dir: 'asc' },
            attemptsDelta: { get: (r) => r.attemptsDelta, dir: 'asc' },
            rooms: { get: (r) => r.appliedFights ?? r.fights.length, dir: 'desc' },
            avgWinDelta: { get: (r) => r.avgWinDelta, dir: 'desc' },
        };
        const sort = this._allFightsSort;
        const sorted = goldResults.slice();
        if (sort && SORTS[sort.key]) {
            const { get } = SORTS[sort.key];
            const sign = sort.dir === 'asc' ? 1 : -1;
            sorted.sort((a, b) => {
                const av = get(a);
                const bv = get(b);
                // A candidate with no coin price sorts last either way rather
                // than pretending to be free or infinitely expensive
                if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
                if (bv === null || bv === undefined) return -1;
                if (typeof av === 'string') return sign * av.localeCompare(bv);
                return sign * (av - bv);
            });
        }
        const arrow = (key) => (sort?.key === key ? (sort.dir === 'asc' ? ' \u25B2' : ' \u25BC') : '');
        const th = (key, label, title) =>
            `<th data-af-sort="${key}" style="${thStyle} cursor:pointer; user-select:none;" title="${title}">` +
            `${label}${arrow(key)}</th>`;

        let html = this._renderBudgetPlan(goldResults, baseline);
        html += `
            <div style="margin-bottom:8px; font-size:12px; color:#888;">
                Baseline: <span style="color:#e0e0e0; font-weight:700;">${fmtAttempts(baseline.expectedAttempts)}</span>
                expected combat attempts to clear all ${baseline.fights.length} fights
                <span style="color:#555; font-size:10px; margin-left:6px;">Σ 1/win rate per fight, at its skip level with its assigned loadout — retries included</span>
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                ${th('upgrade', 'Upgrade', 'Sort by name')}
                ${th('cost', 'Cost', 'What it would cost in coins. Combat levels cost experience, not gold.')}
                ${th('perMillion', 'Per 1M', 'Attempts saved across a whole run per million coins spent — the value figure. Blank where there is no coin price; "pays for itself" where selling the replaced piece covers the purchase.')}
                ${th('attempts', 'Attempts', 'Expected combat attempts to clear every fight once (retrying failed rooms)')}
                ${th('attemptsDelta', 'ΔAttempts', 'Change in expected attempts vs baseline — negative is better. The ± is one standard error of the simulation; a change smaller than about twice that has not been measured, and is shown grey.')}
                ${th('rooms', 'Rooms', 'How many fights this upgrade actually reaches. A combat level is every fight; a piece of gear only the loadouts that wear what it replaces.')}
                ${th('avgWinDelta', 'Avg ΔWin', 'Average win rate change across the rooms it reaches')}
            </tr></thead><tbody>`;

        sorted.forEach((r, i) => {
            const isBest = r.attemptsDelta === bestDelta && bestDelta < -0.05;
            const attemptsStyle = isBest ? 'color:#4caf50; font-weight:700;' : '';
            // A dash rather than a zero where there is no coin price: a combat
            // level is not free, it is paid for in experience, and a zero here
            // would read as "costs nothing" instead of "not a coin question"
            // Negative is real: a swap whose sold piece brings back more than
            // the new one costs is a credit, not a row with no price
            const cost =
                r.cost > 0
                    ? formatKMB(r.cost)
                    : r.cost === 0
                      ? 'free'
                      : Number.isFinite(r.cost)
                        ? `+${formatKMB(-r.cost)} back`
                        : '—';
            // How many rooms it reaches — a sword upgrade is only about the
            // loadouts carrying that sword, and a row that does not say so
            // reads as an upgrade to the whole run
            const reach = r.appliedFights ?? r.fights.length;
            const total = r.fights.length;
            const perGold =
                r.attemptsSavedPerMillion === null
                    ? '—'
                    : r.attemptsSavedPerMillion === Infinity
                      ? 'pays for itself'
                      : `${r.attemptsSavedPerMillion >= 0 ? '' : '−'}${fmtPerMillion(Math.abs(r.attemptsSavedPerMillion))}`;
            // A change smaller than the sampling error of the sims behind it has
            // not been measured — colouring it green sells an upgrade on noise
            const measured = r.significant !== false;
            const noise =
                r.attemptsDeltaNoise > 0 ? ` <span style="color:#555;">±${r.attemptsDeltaNoise.toFixed(1)}</span>` : '';
            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-row="${i}">
                <td style="${tdNameStyle}${measured ? '' : ' opacity:0.55;'}">${r.candidate.description}${combatSimUI.upgradeRowActionsHtml(r)}</td>
                <td style="${tdStyle} color:#aaa;">${cost}</td>
                <td style="${tdStyle} color:${measured && r.attemptsSavedPerMillion > 0 ? '#4caf50' : '#888'}; font-weight:600;">${perGold}</td>
                <td style="${tdStyle} ${attemptsStyle}">${fmtAttempts(r.expectedAttempts)}</td>
                <td style="${tdStyle} color:${measured ? attemptsDeltaColor(r.attemptsDelta) : '#666'}; ${isBest && measured ? 'font-weight:700;' : ''}"
                    title="${measured ? '' : 'Smaller than the simulation’s own error — not a measured gain'}">${fmtAttemptsDelta(r.attemptsDelta)}${noise}</td>
                <td style="${tdStyle} color:${reach === total ? '#888' : '#8ab4f8'};">${reach} / ${total}</td>
                <td style="${tdStyle} color:${deltaColor(r.avgWinDelta)};">${deltaPct(r.avgWinDelta)}</td>
            </tr>`;

            // Per-fight breakdown (hidden until the row is clicked)
            let fightRows = '';
            for (let f = 0; f < r.fights.length; f++) {
                const fight = r.fights[f];
                const base = baseline.fights[f];
                const triesBase = expectedTries(base.winRate);
                const triesNew = expectedTries(fight.winRate);
                // Untouched rooms are named rather than dropped: "this upgrade
                // does nothing here" is an answer, and a fight missing from the
                // list looks like a fight that was not run
                const outcome =
                    fight.applied === false
                        ? `<span style="color:#666;">not in this loadout — ${pct(base.winRate)} unchanged</span>`
                        : `${pct(base.winRate)} → ${pct(fight.winRate)}
                        <span style="color:${deltaColor(fight.winRateDelta)};">(${deltaPct(fight.winRateDelta)})</span>
                        <span style="color:#666;">| ${fmtAttempts(triesBase)} → ${fmtAttempts(triesNew)} tries` +
                          `${fight.replaced ? `, over ${fight.replaced}` : ''}</span>`;
                fightRows += `<div style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">
                    <span style="color:#aaa;">${fight.monsterName} <span style="color:#666;">(Lv ${fight.roomLevel}, "${fight.loadoutName}")</span></span>
                    <span style="white-space:nowrap;">${outcome}</span>
                </div>`;
            }
            html += `<tr data-allfights-detail="${i}" style="display:none;">
                <td colspan="7" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">
                    ${fightRows}${this._renderAllFightsNotes(r)}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        html += this._renderAllFightsTokenSection(tokenResults, sharedStyles);
        container.innerHTML = html;

        this._addCsvExport(container, 'labsim-all-fights', () => ({
            columns: [
                { key: 'upgrade', label: 'Upgrade' },
                { key: 'cost', label: 'Cost' },
                { key: 'perMillion', label: 'Attempts saved per 1M' },
                { key: 'attempts', label: 'Expected attempts' },
                { key: 'attemptsDelta', label: 'Change in attempts' },
                { key: 'attemptsNoise', label: 'Change std error' },
                { key: 'measured', label: 'Above noise' },
                { key: 'roomsApplied', label: 'Rooms reached' },
                { key: 'roomsTotal', label: 'Rooms total' },
                { key: 'avgWinDelta', label: 'Avg win rate change' },
                { key: 'tokenCost', label: 'Token cost' },
            ],
            // Raw numbers rather than the formatted cells: a spreadsheet cannot
            // sort "1.2B" or sum "+0.32%". Both sections, since a spreadsheet
            // has no trouble holding two currencies in two columns.
            rows: [...sorted, ...tokenResults].map((r) => ({
                upgrade: r.candidate?.description || '',
                cost: r.cost ?? null,
                // Infinity does not survive a spreadsheet; the credit-funded
                // row's value figure is its (negative) cost column
                perMillion: r.attemptsSavedPerMillion === Infinity ? null : (r.attemptsSavedPerMillion ?? null),
                attempts: r.expectedAttempts,
                attemptsDelta: r.attemptsDelta,
                attemptsNoise: r.attemptsDeltaNoise ?? null,
                measured: r.significant !== false,
                roomsApplied: r.appliedFights ?? r.fights.length,
                roomsTotal: r.fights.length,
                avgWinDelta: r.avgWinDelta,
                tokenCost: r.tokenCost ?? null,
            })),
        }));

        container.querySelectorAll('[data-allfights-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(`[data-allfights-detail="${row.dataset.allfightsRow}"]`);
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });
        container.querySelectorAll('[data-allfights-token-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(
                    `[data-allfights-token-detail="${row.dataset.allfightsTokenRow}"]`
                );
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });

        this._wireBudgetPlan(container, goldResults, baseline);

        container.querySelectorAll('[data-af-sort]').forEach((header) => {
            header.addEventListener('click', () => {
                const key = header.dataset.afSort;
                // Second click on the same column reverses it; a new column
                // starts at whichever end of it is the good news
                this._allFightsSort =
                    this._allFightsSort?.key === key
                        ? { key, dir: this._allFightsSort.dir === 'asc' ? 'desc' : 'asc' }
                        : { key, dir: SORTS[key].dir };
                this._renderAllFightsResults(this._allFightsResult, container);
            });
        });

        const budget = analysisResult.budget;
        this._setStatus(
            `All-fights analysis complete: ${results.length} upgrades across ${baseline.fights.length} fights` +
                (budget?.sims ? `, ${budget.sims.toLocaleString()} simulations` : '') +
                (budget?.reduced
                    ? ` at ${Math.round(budget.trialScale * 100)}% of the ${budget.requestedHours}h per fight — every fight simulated, win rates noisier.`
                    : '.') +
                describeArchetypes(analysisResult.archetypes) +
                (this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '')
        );
    }

    /**
     * The labyrinth token buffs, as their own section of a whole-run table.
     *
     * A section rather than more rows in the gear table, for the reason the
     * Configure fight has always split them: the two are paid for in different
     * currencies. A token buff has no coin price, so it cannot share a Cost
     * column, it cannot be ranked on attempts-per-million, and it cannot be
     * planned around by a budget in gold. What it can be ranked on is its own
     * currency, which is what the last column does.
     *
     * Unsorted by the table's own header clicks: those belong to the gear table
     * above, and four rows sorted by the analysis's own best-first order need no
     * affordance of their own.
     *
     * @param {Array<Object>} tokenResults - Rows with `costType === 'token'`
     * @param {Object} styles - The shared cell styles and formatters
     * @returns {string} HTML, empty when the run ranked no token buffs
     * @private
     */
    _renderAllFightsTokenSection(tokenResults, styles) {
        if (!tokenResults?.length) return '';
        const { thStyle, tdStyle, tdNameStyle, fmtAttempts, fmtAttemptsDelta, attemptsDeltaColor } = styles;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const perTokens = (v) =>
            v === null ? '—' : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2);

        let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin:14px 0 4px;">Labyrinth Token Buffs</div>
            <div style="color:#666; font-size:10px; margin-bottom:4px;">Bought once with labyrinth tokens and paid
                for in every room, so each is simulated against every fight and aggregated exactly like a combat
                level. Ranked in tokens rather than coins, and left out of the budget plan above, which is a plan
                in gold.</div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                <th style="${thStyle}">Upgrade</th>
                <th style="${thStyle}" title="Labyrinth tokens for this level">Tokens</th>
                <th style="${thStyle}" title="Attempts saved across a whole run per 100 tokens spent — the value figure, in the currency these are actually bought with">Per 100</th>
                <th style="${thStyle}" title="Expected combat attempts to clear every fight once (retrying failed rooms)">Attempts</th>
                <th style="${thStyle}" title="Change in expected attempts vs baseline — negative is better. The ± is one standard error of the simulation.">ΔAttempts</th>
                <th style="${thStyle}" title="Average win rate change across every fight — a token level reaches all of them">Avg ΔWin</th>
            </tr></thead><tbody>`;

        tokenResults.forEach((r, i) => {
            const measured = r.significant !== false;
            const noise =
                r.attemptsDeltaNoise > 0 ? ` <span style="color:#555;">±${r.attemptsDeltaNoise.toFixed(1)}</span>` : '';
            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-token-row="${i}">
                <td style="${tdNameStyle}${measured ? '' : ' opacity:0.55;'}">${r.candidate.description}</td>
                <td style="${tdStyle} color:#aaa;">${formatWithSeparator(r.tokenCost || 0)}</td>
                <td style="${tdStyle} color:${measured && r.attemptsSavedPerHundredTokens > 0 ? '#4caf50' : '#888'}; font-weight:600;">${perTokens(r.attemptsSavedPerHundredTokens ?? null)}</td>
                <td style="${tdStyle}">${fmtAttempts(r.expectedAttempts)}</td>
                <td style="${tdStyle} color:${measured ? attemptsDeltaColor(r.attemptsDelta) : '#666'};"
                    title="${measured ? '' : 'Smaller than the simulation’s own error — not a measured gain'}">${fmtAttemptsDelta(r.attemptsDelta)}${noise}</td>
                <td style="${tdStyle} color:${r.avgWinDelta > 0.0001 ? '#4caf50' : r.avgWinDelta < -0.0001 ? '#f44336' : '#888'};">${deltaPct(r.avgWinDelta)}</td>
            </tr>`;

            const fightRows = r.fights
                .map(
                    (fight) => `<div style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">
                        <span style="color:#aaa;">${fight.monsterName}
                            <span style="color:#666;">(Lv ${fight.roomLevel}, "${fight.loadoutName}")</span></span>
                        <span style="white-space:nowrap; color:#888;">${(fight.winRate * 100).toFixed(1)}%
                            <span style="color:${fight.winRateDelta > 0.0001 ? '#4caf50' : fight.winRateDelta < -0.0001 ? '#f44336' : '#888'};">(${deltaPct(fight.winRateDelta || 0)})</span></span>
                    </div>`
                )
                .join('');
            html += `<tr data-allfights-token-detail="${i}" style="display:none;">
                <td colspan="6" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">
                    ${fightRows}</td>
            </tr>`;
        });

        return html + '</tbody></table>';
    }

    /**
     * The notes a row's own numbers cannot carry.
     *
     * The forced armor swaps are priced without crediting the resale of what
     * they replace, because the labyrinth wants every element kept — a gross
     * price that reads as an overcharge unless the row says why. And a pooled
     * ability swap is measured at a different level in every loadout it reaches,
     * which the description no longer states now that it is one row for the
     * whole run.
     *
     * @param {Object} result - One all-fights result row
     * @returns {string} HTML, empty where there is nothing to add
     * @private
     */
    _renderAllFightsNotes(result) {
        const notes = [];
        const kept = result.costDetail?.kept;
        if (kept?.length) {
            notes.push(
                `Keeping ${kept.map((k) => `${k.name} +${k.enhancementLevel}`).join(', ')} — resale of ` +
                    `${formatKMB(Math.round(result.costDetail.keptValue || 0))} deliberately not credited, since the labyrinth needs ` +
                    'every set. Turn off "Keep gear the forced armor swaps replace" in settings to price these as ' +
                    'straight swaps.'
            );
        }
        if (result.candidate?.caveat) notes.push(result.candidate.caveat);
        if (!notes.length) return '';
        return notes
            .map(
                (note) =>
                    `<div style="color:#8ab4f8; margin-top:6px; white-space:normal; line-height:1.4;">${note}</div>`
            )
            .join('');
    }

    /** @private */
    /**
     * Restore the last Upgrade-tab results after a refresh, when the option is on
     * and a fresh run has not already drawn its own. Fire-and-forget from panel
     * open; draws into the (possibly hidden) Upgrade tab so the results are there
     * when the tab is next shown.
     * @private
     */
    async _restoreUpgradeResults() {
        try {
            const container = this.panel?.querySelector('#mwi-labsim-upgrade-results');
            if (!container || container.querySelector('table')) return;
            const payload = await loadUpgradeResults(LAB_UPGRADE_RESULTS_KEY);
            if (!payload) return;
            if (!this.panel || container.querySelector('table')) return;
            this._restoredUpgradeAt = payload.savedAt || null;
            this._restoredUpgradeMeta = { characterName: payload.characterName || null };
            this._renderUpgradeResults(payload.data, container);
        } catch (error) {
            console.error('[LabSimUI] Restoring upgrade results failed:', error);
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
        // A payload from before the name was stored renders the old sentence.
        // No zone half here - the lab is the zone
        const who = meta?.characterName ? escapeHtmlAttribute(meta.characterName) : null;
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

    _renderUpgradeResults(analysisResult, container) {
        const results = analysisResult?.results;
        if (!results || !results.length) {
            // The house note matters most here: an empty table is exactly where
            // "every combat room is already at the cap" reads as "nothing to buy"
            const note = this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '';
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.' +
                (note ? `<div style="margin-top:6px; color:#666; font-size:11px;">${note.trim()}</div>` : '') +
                '</div>';
            this._setStatus(`No upgrade candidates found.${note}`);
            return;
        }

        // The second ranking pass, when it was run. Its columns are added to the
        // token and gold tables; the community rows are ranked on experience and
        // never touched whether a room is cleared, so they get none.
        const roomLevels = analysisResult?.roomLevels || null;
        const targetFloor = Math.max(0, Math.floor(Number(roomLevels?.targetFloor) || 0));

        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const communityResults = results.filter((r) => r.costType === 'community');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        // Numbers right-align and never wrap; only the Upgrade name reflows —
        // the same division the combat sim's table makes, and what stops a
        // two-piece swap label ("Royal Nature Robe Top +7 + Royal Nature Robe
        // Bottoms +7 → …") from running off the edge of the panel on one line
        const tdStyle = 'padding:3px 4px; text-align:right; white-space:nowrap;';
        const tdNameStyle =
            'padding:3px 4px; color:#e0e0e0; text-align:left; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';

        // Pre-compute row data for sorting
        const tokenRows = tokenResults.map((r) => {
            let rateVal, deltaVal, rateStr;

            if (r.metricType === 'clearRate') {
                rateVal = (r.clearRate || 0) * 100;
                deltaVal = (r.clearRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(1) + '%';
            } else {
                rateVal = (r.winRate || 0) * 100;
                deltaVal = (r.winRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(2) + '%';
            }

            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const deltaStr = (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%';

            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;
            const tokensPerPctStr = deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014';

            const levels = roomLevels ? roomLevelCells(r, roomLevels) : null;

            return {
                ...(levels
                    ? {
                          roomLevelDelta: levels.delta,
                          roomLevelStr: levels.deltaStr,
                          roomLevelColor: levels.deltaColor,
                          floorVal: levels.floor,
                          floorStr: levels.floorStr,
                          levelTitle: levels.title,
                          reachesTarget: levels.reachesTarget,
                      }
                    : {}),
                desc: r.candidate?.description || '',
                // Whatever handoff buttons the shared builder emits for this
                // row — never a hand-picked subset of them, so a button added
                // to the combat sim's rows turns up here without being asked for
                actions: combatSimUI.upgradeRowActionsHtml(r),
                tokenCost,
                rateVal,
                rateStr,
                deltaVal,
                deltaStr,
                deltaColor,
                tokensPerPct,
                tokensPerPctStr,
            };
        });

        const goldRows = goldResults.map((r) => {
            const delta = (r.winRateDelta || 0) * 100;
            const deltaColor = delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888';
            const winRate = (r.winRate || 0) * 100;
            const goldPerPct = goldPerPercent(r.cost, delta);

            const levels = roomLevels ? roomLevelCells(r, roomLevels) : null;

            return {
                ...(levels
                    ? {
                          roomLevelDelta: levels.delta,
                          roomLevelStr: levels.deltaStr,
                          roomLevelColor: levels.deltaColor,
                          floorVal: levels.floor,
                          floorStr: levels.floorStr,
                          levelTitle: levels.title,
                          reachesTarget: levels.reachesTarget,
                      }
                    : {}),
                desc: r.candidate?.description || '',
                actions: combatSimUI.upgradeRowActionsHtml(r),
                // Unpriced sorts last rather than as the cheapest thing on the
                // table, which is where `r.cost || 0` put a combat level
                cost: Number.isFinite(r.cost) ? r.cost : Infinity,
                costStr: goldCostCell(r.cost),
                winRate,
                winRateStr: winRate.toFixed(2) + '%',
                deltaVal: delta,
                deltaStr: (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, delta),
                detailHtml: this._renderUpgradeCostDetail(r, analysisResult?.baseline),
            };
        });

        // Neither community buff a combat fight reads can change whether it is
        // won, so the clear-chance columns stay at the baseline and the row is
        // read on what it does move: experience per attempt. The same treatment
        // the Skilling tab gives the Experience token, for the same reason.
        const communityRows = communityResults.map((r) => {
            const xpDelta = r.xpPerRoomDelta || 0;
            return {
                desc: r.candidate?.description || '',
                cowbellCost: r.cowbellCost ?? Infinity,
                cowbellCostStr: r.cowbellCost == null ? '\u2014' : formatWithSeparator(r.cowbellCost) + '/min',
                xpPerRoom: r.xpPerRoom || 0,
                xpPerRoomStr: (r.xpPerRoom || 0).toFixed(1),
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
            };
        });

        // Sort state
        // With the room-level pass on, the table opens on the currency it was
        // asked for. The cost-efficiency columns are untouched and one click
        // away, so nothing that was on this table has changed meaning.
        const sortState = {
            token: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'tokensPerPct', dir: 'asc' },
            gold: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'goldPerPct', dir: 'asc' },
            community: { key: 'xpDelta', dir: 'desc' },
        };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        /**
         * The Levels and Floor cells, empty when the pass was not run.
         * @param {Object} row - A prepared token or gold row
         * @returns {string} HTML
         */
        const roomLevelCellsHtml = (row) => {
            if (!roomLevels) return '';
            const reached = row.reachesTarget ? ' font-weight:700;' : '';
            const floorColor = row.reachesTarget ? '#4caf50' : '#888';
            return (
                `<td style="${tdStyle} color:${row.roomLevelColor}; font-weight:600;" title="${escapeHtmlAttribute(row.levelTitle)}">${row.roomLevelStr}</td>` +
                `<td style="${tdStyle} color:${floorColor};${reached}" title="${escapeHtmlAttribute(row.levelTitle)}">${row.floorStr}</td>`
            );
        };

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Rate', 'rateVal', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${roomLevels ? th('Levels', 'roomLevelDelta', 'right') : ''}
                ${roomLevels ? th('Floor', 'floorVal', 'right') : ''}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}${row.actions}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.rateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Gold Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Win Rate', 'winRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${roomLevels ? th('Levels', 'roomLevelDelta', 'right') : ''}
                ${roomLevels ? th('Floor', 'floorVal', 'right') : ''}
                ${th('Gold/1%', 'goldPerPct', 'right')}
            </tr></thead><tbody>`;

            goldRows.forEach((row, i) => {
                html += `<tr data-gold-row="${i}" style="border-bottom:1px solid #1a1a1a; cursor:pointer;" title="Click for the cost breakdown">
                    <td style="${tdNameStyle}">${row.desc}${row.actions}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.winRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                </tr>
                <tr data-gold-detail="${i}" style="display:none;">
                    <td colspan="${roomLevels ? 7 : 5}" style="padding:6px 10px; background:#0d0d1a; border-bottom:1px solid #222;">
                        ${row.detailHtml}
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            return html;
        };

        const renderCommunityTable = () => {
            const s = sortState.community;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="community" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Community Buffs</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cowbells', 'cowbellCost', 'right')}
                ${th('Win Rate', 'winRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('XP/Attempt', 'xpPerRoom', 'right')}
                ${th('ΔXP', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of communityRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.cowbellCostStr}</td>
                    <td style="${tdStyle} color:#666;">\u2014</td>
                    <td style="${tdStyle} color:#666;">\u2014</td>
                    <td style="${tdStyle} color:#ccc;">${row.xpPerRoomStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                A community buff's level is what the whole server's donated minutes add up to, so there is no price
                for one more level to rank on — the cowbell figure is what the game charges per minute to keep the
                buff running. Neither of these can change whether a fight is won, so the win-rate columns are left
                blank rather than filled in with the simulation's own noise; they are read on experience instead.
                The Combat Drop buff is left out entirely — it moves what a win pays out, and this table does not
                price drops. Capped at Lv${MAX_COMMUNITY_BUFF_LEVEL} (max).
            </div>`;
            return html;
        };

        /**
         * What the room-level pass measured, above the tables it annotated.
         * @returns {string} HTML
         */
        const renderRoomLevelSummary = () => {
            const bar = `${Math.round((roomLevels.threshold || defaultThreshold()) * 100)}%`;
            const parts = [];
            if (roomLevels.baselineCleared) {
                parts.push(
                    `Today this loadout clears room level <b>${roomLevels.baselineLevel}</b> at ${bar} — ` +
                        `floor <b>${roomLevels.baselineFloor}</b> finished` +
                        (roomLevels.baselineFloor > 0
                            ? ` (its exit room is level ${labyrinthFloorClearLevel(roomLevels.baselineFloor)})`
                            : '') +
                        '.'
                );
                parts.push(
                    `Levels is what the top ${roomLevels.shortlistSize} upgrades move that by; every other row ` +
                        'reads +0 because it was not searched.'
                );
            } else {
                parts.push(`No room in this character’s range cleared at ${bar}, so there is no level to move.`);
            }
            if (targetFloor > 0) {
                const need = labyrinthFloorClearLevel(targetFloor);
                parts.push(
                    `Floor ${targetFloor} needs room level <b>${need}</b> — its exit room, not its average one — ` +
                        `which is ${need - roomLevels.baselineLevel > 0 ? `${need - roomLevels.baselineLevel} levels away` : 'already cleared'}.`
                );
            }
            if (roomLevels.aborted) parts.push('Stopped early: the rows below it were never searched.');
            return (
                `<div style="margin:0 0 8px; padding:5px 8px; font-size:11px; color:#9ab; line-height:1.5; ` +
                `background:rgba(120,150,190,0.10); border:1px solid rgba(120,150,190,0.25); border-radius:5px;">` +
                parts.join(' ') +
                `</div>`
            );
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            sortRows(communityRows, sortState.community.key, sortState.community.dir);
            let html = '';
            if (this._restoredUpgradeAt) {
                html += this._restoredUpgradeNote(this._restoredUpgradeAt, this._restoredUpgradeMeta);
            }
            if (roomLevels) html += renderRoomLevelSummary();
            if (tokenResults.length > 0) html += renderTokenTable();
            if (communityResults.length > 0) html += renderCommunityTable();
            if (goldResults.length > 0) html += renderGoldTable();
            container.innerHTML = html;
            // Re-wired on every render: a sort rebuilds the table, and buttons
            // wired to the elements it threw away do nothing at all
            combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');

            // Forgets the saved run only — the table on screen came from this
            // render call and stays right there
            const clearBtn = container.querySelector('[data-clear-remembered-upgrade]');
            if (clearBtn) {
                clearBtn.addEventListener('click', async () => {
                    clearBtn.disabled = true;
                    await clearUpgradeResults(LAB_UPGRADE_RESULTS_KEY);
                    this._restoredUpgradeAt = null;
                    this._restoredUpgradeMeta = null;
                    clearBtn.closest('div')?.remove();
                });
            }
        };

        renderAll();

        this._addCsvExport(container, 'labsim-upgrades', () => ({
            columns: [
                { key: 'upgrade', label: 'Upgrade' },
                { key: 'paidIn', label: 'Paid in' },
                { key: 'cost', label: 'Gold cost' },
                { key: 'tokenCost', label: 'Token cost' },
                { key: 'rate', label: 'Win rate' },
                { key: 'rateDelta', label: 'Win rate change' },
                { key: 'perPercent', label: 'Cost per +1%' },
            ],
            rows: results.map((r) => {
                const rate = r.winRate ?? r.clearRate ?? null;
                const delta = r.winRateDelta ?? r.clearRateDelta ?? null;
                const paid = r.costType === 'token' ? r.tokenCost : r.cost;
                const gain = (delta || 0) * 100;
                return {
                    upgrade: r.candidate?.description || '',
                    paidIn: CSV_PAID_IN[r.costType] || 'gold',
                    cost: r.costType === 'gold' ? (r.cost ?? null) : null,
                    // Shrine rows are paid in gold *and* guild tokens; the token
                    // half rides on the candidate rather than the result row
                    tokenCost: r.costType === 'token' ? (r.tokenCost ?? null) : (r.candidate?.guildTokenCost ?? null),
                    rate,
                    rateDelta: delta,
                    perPercent: gain > 0 && paid ? Math.round(paid / gain) : null,
                };
            }),
        }));

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        if (this._upgradeSortHandler) {
            container.removeEventListener('click', this._upgradeSortHandler);
        }
        this._upgradeSortHandler = (e) => {
            const expandable = e.target.closest('tr[data-gold-row]');
            if (expandable) {
                const detail = container.querySelector(`[data-gold-detail="${expandable.dataset.goldRow}"]`);
                if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                return;
            }
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this._upgradeSortHandler);

        this._setStatus(
            `${results.length} upgrade candidates analyzed.` +
                (this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '')
        );
    }

    /**
     * Cost breakdown shown when a gold-upgrade row is expanded: what gets bought
     * at what price, what the swap credits or keeps, and — when the Cost column
     * reads as a dash — which item has no price behind it.
     * @param {Object} result - Analysis result row
     * @param {Object} [baseline] - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeCostDetail(result, baseline) {
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;

        const parts = [];

        const baseWinRate = baseline?.winRate != null ? (baseline.winRate * 100).toFixed(2) + '%' : null;
        parts.push(
            line(
                `Win rate ${((result.winRate || 0) * 100).toFixed(2)}%` +
                    (baseWinRate ? ` vs ${baseWinRate} baseline` : '') +
                    ` · ${(result.winRateDelta || 0) >= 0 ? '+' : ''}${((result.winRateDelta || 0) * 100).toFixed(2)}%`,
                '#ccc'
            )
        );

        // A room level is not a listing, so the breakdown says what it is: a
        // build cost, and a number measured against a baseline of its own
        if (result.candidate?.type === 'house') {
            parts.push(
                line(
                    `House room level ${result.candidate.currentLevel} → ${result.candidate.upgradeLevel}. ` +
                        'Cost is the build cost of that one level — coins at face value plus the materials at ' +
                        'their buy price.'
                )
            );
            parts.push(
                line(
                    'Weighed in a pass of its own, against its own baseline at its own seed, so the delta is ' +
                        'paired. The absolute win rate can sit a fraction of a percent off the rows above it.',
                    '#888'
                )
            );
        }

        parts.push(this._renderCostBreakdown(result.costDetail));
        return parts.join('');
    }

    /**
     * The same expansion, for a table ranked on clear rate rather than win rate.
     *
     * The Skilling tab's Gear Upgrades rows had a Cost column and no way to ask
     * what the number was made of — including the two cases where the number is
     * least self-explanatory: a dash, which means the market has no listing at
     * that enhancement rather than that the piece is free; and a cost that looks
     * far too high, which is a skilling piece priced without crediting the combat
     * armour it goes in place of, because that armour stays in its loadout.
     *
     * Everything below the header lines is the same breakdown the combat rows
     * draw. What differs is the header: the rate this table measures, and what
     * kind of purchase the row is, since "enhance what you wear" and "buy a piece
     * you do not own yet, at +5" are priced in completely different ways.
     *
     * @param {Object} result - Skilling analysis result row
     * @param {Object} [baseline] - `{ clearRate }` from the analysis
     * @returns {string} HTML
     * @private
     */
    _renderClearRateCostDetail(result, baseline) {
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;
        const parts = [];
        const candidate = result.candidate || {};

        const baseRate = baseline?.clearRate != null ? (baseline.clearRate * 100).toFixed(2) + '%' : null;
        const delta = (result.clearRateDelta || 0) * 100;
        parts.push(
            line(
                `Avg clear rate ${((result.clearRate || 0) * 100).toFixed(2)}%` +
                    (baseRate ? ` vs ${baseRate} baseline` : '') +
                    ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`,
                '#ccc'
            )
        );

        if (candidate.type === 'enhancement') {
            parts.push(
                line(
                    `Enhancing a piece you already wear, +${candidate.currentLevel} → +${candidate.upgradeLevel}. ` +
                        'Cost is the cheapest priced way to reach that level — the piece itself is already yours, ' +
                        'so nothing is bought and nothing is sold back.'
                )
            );
        } else if (candidate.type === 'skilling_gear') {
            parts.push(
                line(
                    `A piece you do not own yet, priced and simulated at +${candidate.upgradeLevel}. Nobody buys ` +
                        'one of these and leaves it at +0, so costing it there would understate both the price ' +
                        'and the gain against every other row.'
                )
            );
            if (candidate.skillKey) {
                parts.push(
                    line(
                        `Counted for ${String(candidate.skillKey).replace('/skills/', '')} alone — its stats do ` +
                            'nothing in any other skill’s room.',
                        '#888'
                    )
                );
            }
        }

        parts.push(this._renderCostBreakdown(result.costDetail, { keptReason: KEPT_REASON_SKILLING }));
        return parts.join('');
    }

    /**
     * What a cost is made of: bought, credited, kept, or missing a price.
     *
     * Shared by every expandable row in the panel, because the answer does not
     * depend on which rate the table above it is ranked on. Only the header lines
     * differ, and those belong to the renderers that call this.
     *
     * @param {Object|null} detail - `costDetail` from the analysis
     * @param {Object} [options] - `keptReason`: why an uncredited resale is uncredited,
     *   which is a different answer for the labyrinth's forced armor sets than for a
     *   skilling piece that goes in place of combat gear
     * @returns {string} HTML
     * @private
     */
    _renderCostBreakdown(detail, { keptReason = KEPT_REASON_LABYRINTH } = {}) {
        const money = (value) => formatWithSeparator(Math.round(value));
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;
        const parts = [];

        if (!detail) {
            return line('No cost breakdown available for this candidate.', '#666');
        }

        // A shrine level is bought with guild credits and guild tokens. Credits
        // have a gold value (the cheapest items that convert into them); tokens
        // are priced through the guild shop's token→credit exchange when a rate
        // is known — the note names which ranking applied
        if (detail.guild) {
            const guild = detail.guild;
            const tokenText =
                guild.tokenNote || `${formatWithSeparator(guild.tokens)} guild token${guild.tokens === 1 ? '' : 's'}`;
            parts.push(
                line(
                    `Costs ${tokenText} + ` +
                        `credits worth ${guild.creditGold == null ? 'no price' : money(guild.creditGold)}. ` +
                        (guild.rankedNote || '')
                )
            );
            for (const credit of guild.credits) {
                const each =
                    credit.goldEach === null ? '<span style="color:#ff9800;">no rate</span>' : money(credit.gold);
                parts.push(line(`${formatWithSeparator(credit.count)} × ${credit.name} — ${each}`, '#888'));
            }
            if (guild.needsShrineLevel) {
                parts.push(
                    line(
                        `Your guild's ${guild.shrineName} shrine is level ${guild.shrineLevel}; buying level ` +
                            `${guild.needsShrineLevel} needs the shrine there first — a guild-wide upgrade this ` +
                            'cost does not include.',
                        '#ff9800'
                    )
                );
            } else if (!guild.shrineLevelKnown) {
                parts.push(
                    line('No guild shrine levels reached the client, so any cap on this level is unknown.', '#888')
                );
            }
            return parts.join('');
        }

        // An ability is paid for in books, and nothing comes back — it is not an
        // item, so there is no listing at a level to buy and nothing to sell back
        if (detail.books) {
            const books = detail.books;
            const each =
                books.bookPrice === null
                    ? '<span style="color:#ff9800;">no price found</span>'
                    : `${money(books.bookPrice)} each`;
            parts.push(line(`Buy ${formatWithSeparator(Math.ceil(books.books))} × ${books.bookName} — ${each}`));
            if (books.learnBook) {
                parts.push(line('Includes the one book that learns it, on top of the levels.', '#888'));
            }
            parts.push(line('Abilities cannot be sold back, so nothing is credited against this.', '#888'));
        }

        for (const buy of detail.buys || []) {
            const price = buy.price === null ? '<span style="color:#ff9800;">no price found</span>' : money(buy.price);
            parts.push(line(`Buy ${buy.name} +${buy.enhancementLevel} — ${price}`));
        }

        // Nothing is listed at that enhancement, so half the figure above is a
        // simulated enhance path — and the same path costs different money on
        // different benches. Named in the words the enhancement tooltip's chip
        // uses, so one source reads identically wherever it turns up.
        if (detail.enhanceSource) {
            const rates = detail.enhanceSource;
            parts.push(line(`Enhance rates: ${rates.label}${rates.detail ? ` — ${rates.detail}` : ''}.`, '#888'));
        }

        if (detail.unpriced?.length > 0) {
            // "The measured delta is still accurate" rather than naming win rate:
            // the same breakdown is drawn under a table ranked on clear rate, and
            // the point holds either way — a missing listing costs the row its
            // price, not its measurement
            parts.push(
                line(
                    detail.books
                        ? `Cost shows as \u2014 because ${detail.unpriced.join(' and ')} has no market listing ` +
                              'right now. The measured delta is still accurate.'
                        : `Cost shows as \u2014 because ${detail.unpriced.join(' and ')} has no market listing at ` +
                              'that enhancement and no priced path to reach it. The measured delta is still accurate.',
                    '#ff9800'
                )
            );
        }

        if (detail.kept?.length) {
            parts.push(
                line(
                    `Keeping ${detail.kept.map((k) => `${k.name} +${k.enhancementLevel}`).join(', ')} ` +
                        `— resale of ${money(detail.keptValue)} deliberately not credited, ${keptReason}`,
                    '#8ab4f8'
                )
            );
        } else if (detail.credits?.length > 0) {
            for (const credit of detail.credits) {
                parts.push(
                    line(`Sell ${credit.name} +${credit.enhancementLevel} — ${money(credit.price)} back`, '#8bc34a')
                );
            }
        }

        if (detail.gross !== null) {
            const net = detail.net;
            parts.push(
                line(
                    `Total ${money(detail.gross)}` + (net !== detail.gross ? ` \u2212 credit = ${money(net)}` : ''),
                    '#e0e0e0'
                )
            );
        }

        return parts.join('');
    }

    /**
     * The labyrinth crates the character actually has equipped — the same source
     * the live clear-rate reader scores a room with (getCrateBuffs). Shared by
     * the skilling and combat crate dropdowns, which point at one equipped set.
     * @private
     */
    _equippedCrateHrids() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return {
            tea: labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            coffee: labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            food: labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        };
    }

    /**
     * Point one crate dropdown trio at the equipped crates.
     *
     * The sim's room level already comes from the live equipped crate (via
     * getTargetRoomLevel → getEffectiveLevel for skilling, the effective combat
     * level for combat), so the success calc must use the same crates or the two
     * halves disagree — a room set from the equipped crate and a fight scored
     * against a hardcoded Expert crate the player may not own. That mismatch reads
     * a higher clear than the live tile / recommendation for the same threshold
     * (e.g. the Expert coffee crate's +15 combat levels). Skipped once the user
     * picks a crate by hand, so exploring a different crate still works.
     * @param {{tea:string,coffee:string,food:string}} ids - Select element ids
     * @param {string} userSetKey - The "user has overridden" flag to honour
     * @private
     */
    _applyEquippedCratesTo(ids, userSetKey) {
        if (this[userSetKey]) return;
        // Before character data loads there is nothing to read; leave the
        // dropdowns as they are rather than forcing them to None.
        if (!dataManager.characterData) return;
        const equipped = this._equippedCrateHrids();
        const set = (id, hrid) => {
            const select = this.panel?.querySelector(id);
            if (!select) return;
            if (!hrid) {
                select.value = '';
            } else if ([...select.options].some((option) => option.value === hrid)) {
                // Leave an unrecognised crate on its current value rather than blanking it
                select.value = hrid;
            }
        };
        set(ids.tea, equipped.tea);
        set(ids.coffee, equipped.coffee);
        set(ids.food, equipped.food);
    }

    /** @private */
    _applyEquippedSkillingCrates() {
        this._applyEquippedCratesTo(
            {
                tea: '#mwi-labsim-skilling-tea',
                coffee: '#mwi-labsim-skilling-coffee',
                food: '#mwi-labsim-skilling-food',
            },
            '_skillingCratesUserSet'
        );
    }

    /** @private */
    _applyEquippedCombatCrates() {
        this._applyEquippedCratesTo(
            { tea: '#mwi-labsim-tea', coffee: '#mwi-labsim-coffee', food: '#mwi-labsim-food' },
            '_combatCratesUserSet'
        );
    }

    /** @private */
    _getSkillingCrates() {
        // Re-point at the equipped crates in case the panel was built before
        // character data arrived; a manual pick has already opted out.
        this._applyEquippedSkillingCrates();
        const crates = [];
        const tea = this.panel?.querySelector('#mwi-labsim-skilling-tea')?.value;
        const coffee = this.panel?.querySelector('#mwi-labsim-skilling-coffee')?.value;
        const food = this.panel?.querySelector('#mwi-labsim-skilling-food')?.value;
        if (tea) crates.push(tea);
        if (coffee) crates.push(coffee);
        if (food) crates.push(food);
        return crates;
    }

    /** @private */
    async _renderSkillLoadoutTable() {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-loadouts');
        if (!container) return;

        const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
        const nonCombatSnapshots = allSnapshots.filter(
            (s) => s.actionTypeHrid && s.actionTypeHrid !== '/action_types/combat'
        );
        const allSkillsSnapshots = allSnapshots.filter((s) => !s.actionTypeHrid);

        const skills = [
            { hrid: '/skills/woodcutting', label: 'Woodcutting', actionType: '/action_types/woodcutting' },
            { hrid: '/skills/foraging', label: 'Foraging', actionType: '/action_types/foraging' },
            { hrid: '/skills/milking', label: 'Milking', actionType: '/action_types/milking' },
            { hrid: '/skills/cooking', label: 'Cooking', actionType: '/action_types/cooking' },
            { hrid: '/skills/brewing', label: 'Brewing', actionType: '/action_types/brewing' },
            { hrid: '/skills/cheesesmithing', label: 'Cheesesmithing', actionType: '/action_types/cheesesmithing' },
            { hrid: '/skills/crafting', label: 'Crafting', actionType: '/action_types/crafting' },
            { hrid: '/skills/tailoring', label: 'Tailoring', actionType: '/action_types/tailoring' },
            { hrid: '/skills/alchemy', label: 'Alchemy', actionType: '/action_types/alchemy' },
            { hrid: '/skills/enhancing', label: 'Enhancing', actionType: '/action_types/enhancing' },
        ];

        // Load persisted overrides once per character. A plain latch kept the
        // first character's assignments in memory for the life of the page: the
        // table then offered the wrong character's loadouts, the auto-populate
        // below saw a full map and never filled from the arriving character's
        // own lab automation settings, and changing any row wrote that whole
        // stale map back — over assignments the arriving character had made.
        const loadoutsKey = characterKey('labSimSkillingLoadouts');
        if (this._skillLoadoutsKey !== loadoutsKey) {
            this._skillLoadoutsKey = loadoutsKey;
            this._skillLoadouts = {};
            // Discard any legacy global value: loadout names resolve against
            // this character's snapshots, so another character's map is noise.
            const persisted = await readScoped('labSimSkillingLoadouts', 'settings', null, { migrate: 'discard' });
            // A switch during the read means a later render is loading the
            // character who is actually here; this one's result is not theirs
            if (this._skillLoadoutsKey !== loadoutsKey) return;
            if (persisted && typeof persisted === 'object') {
                this._skillLoadouts = persisted;
            }
        }

        // Auto-populate from game's lab automation settings for any skill not already set
        if (Object.keys(this._skillLoadouts).length < skills.length) {
            const charSetting = dataManager.characterData?.characterSetting;
            const snapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots || {};
            for (const skill of skills) {
                if (this._skillLoadouts[skill.hrid]) continue;
                const skillId = skill.hrid.replace('/skills/', '');
                const pascal = skillId.charAt(0).toUpperCase() + skillId.slice(1);
                const loadoutId = charSetting?.[`labyrinthLoadout${pascal}`];
                if (loadoutId && snapshots[loadoutId]?.name) {
                    this._skillLoadouts[skill.hrid] = snapshots[loadoutId].name;
                } else {
                    const match = nonCombatSnapshots.find((s) => s.actionTypeHrid === skill.actionType);
                    if (match) {
                        this._skillLoadouts[skill.hrid] = match.name;
                    } else if (allSkillsSnapshots.length > 0) {
                        this._skillLoadouts[skill.hrid] = allSkillsSnapshots[0].name;
                    }
                }
            }
        }

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:1px 4px; font-size:11px; width:100%;';

        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || '';
        const visibleSkills = targetSkill ? skills.filter((s) => s.hrid === targetSkill) : skills;
        const collapsed = this._loadoutsCollapsed || false;

        const arrow = collapsed ? '&#9654;' : '&#9660;';
        let html = `<div id="mwi-labsim-loadout-toggle" style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px; cursor:pointer; user-select:none;">
            <span style="display:inline-block; width:14px; font-size:10px;">${arrow}</span> Skill Loadouts
        </div>`;
        html += `<div id="mwi-labsim-loadout-grid" style="display:${collapsed ? 'none' : 'grid'}; grid-template-columns:1fr 1fr; gap:3px 10px;">`;

        for (const skill of visibleSkills) {
            const current = this._skillLoadouts[skill.hrid] || '';
            html += `<div style="display:flex; align-items:center; gap:4px; font-size:11px;">`;
            html += `<span style="color:#888; width:85px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${skill.label}">${skill.label}</span>`;
            html += `<select class="toolasha-select" data-skill-loadout="${skill.hrid}" style="${selectStyle}">`;
            html += `<option value=""${!current ? ' selected' : ''}>Current Gear</option>`;
            for (const snap of [...nonCombatSnapshots, ...allSkillsSnapshots]) {
                const label = snap.name + (snap.actionTypeHrid ? '' : ' (All)');
                const selected = current === snap.name ? ' selected' : '';
                html += `<option value="${snap.name}"${selected}>${label}</option>`;
            }
            html += '</select></div>';
        }

        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('[data-skill-loadout]').forEach((select) => {
            select.addEventListener('change', () => {
                const skillHrid = select.dataset.skillLoadout;
                this._skillLoadouts[skillHrid] = select.value;
                // The key the map was read from, not whoever is current: a
                // table left on screen across a switch is still the departing
                // character's, and their edit belongs to them
                storage.set(this._skillLoadoutsKey, this._skillLoadouts, 'settings');
            });
        });

        container.querySelector('#mwi-labsim-loadout-toggle')?.addEventListener('click', () => {
            this._loadoutsCollapsed = !this._loadoutsCollapsed;
            this._renderSkillLoadoutTable();
        });
    }

    /**
     * Build per-skill equipment map from loadout assignments.
     * @param {Object} gameData
     * @returns {Object} { '/skills/woodcutting': { '/equipment_types/...': { hrid, enhancementLevel } }, ... }
     */
    _buildSkillEquipmentMap(gameData) {
        const itemDetailMap = gameData?.itemDetailMap || {};
        const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
        const equipmentMap = {};

        for (const [skillHrid, loadoutName] of Object.entries(this._skillLoadouts)) {
            if (!loadoutName) continue;
            const snapshot = allSnapshots.find((s) => s.name === loadoutName);
            if (!snapshot?.equipment?.length) continue;

            const equipment = {};
            // Levels from the loadout's own rule rather than the stored number:
            // a loadout in "highest owned" mode wears the best copy you have
            // now, and the previous fallback only looked at what was equipped
            // this moment — so every loadout except the active one reported the
            // enhancement it had when it was last saved, often +0
            for (const equip of (loadoutSnapshot() || bundledLoadoutSnapshot).resolveEquipment(snapshot)) {
                const itemDetail = itemDetailMap[equip.itemHrid];
                const equipType = itemDetail?.equipmentDetail?.type;
                if (!equipType) continue;
                equipment[equipType] = { hrid: equip.itemHrid, enhancementLevel: equip.enhancementLevel };
            }
            equipmentMap[skillHrid] = equipment;
        }

        return equipmentMap;
    }

    /** @private */
    /**
     * Room level(s) for skilling calculations: a per-skill map derived from
     * each skill's automation skip level when "Use Skip Levels" is checked,
     * otherwise the single manual room level.
     * @private
     */
    _getSkillingRoomLevels() {
        const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip')?.checked;
        if (!useSkip) {
            return parseInt(this.panel.querySelector('#mwi-labsim-skilling-level')?.value, 10) || 100;
        }
        const skillHrids = [
            '/skills/milking',
            '/skills/foraging',
            '/skills/woodcutting',
            '/skills/cheesesmithing',
            '/skills/crafting',
            '/skills/tailoring',
            '/skills/cooking',
            '/skills/brewing',
            '/skills/alchemy',
            '/skills/enhancing',
        ];
        const levels = {};
        for (const skillHrid of skillHrids) {
            levels[skillHrid] = (labyrinthClearRate() || bundledLabyrinthClearRate).getTargetRoomLevel(skillHrid);
        }
        return levels;
    }

    _onSkillingCalculate() {
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const skillEquipmentMap = this._buildSkillEquipmentMap(gameData);
        const results = computeSkillingClearRatesFromEditor(roomLevel, dto, crateHrids, gameData, skillEquipmentMap);
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const filtered = targetSkill ? results.filter((r) => r.skillHrid === targetSkill) : results;
        this._renderSkillingClearResults(filtered, roomLevel);
    }

    /** @private */
    /**
     * The success/clear working for one skilling row, as hover text. Spells out
     * how the room level is assigned (skip basis + trigger, from base + tea, the
     * way the game does it) versus the effective level the success rate uses
     * (base + every buff) — the two are different, which is what makes a skip
     * trigger read as one room here and another in the automation panel.
     * @private
     */
    _skillingRowBreakdown(r, usesSkipLevels, clearRate, crateSummary) {
        const room = r.roomLevel;
        const lines = [r.skillName];
        if (usesSkipLevels && r.skillHrid && clearRate) {
            const skip = clearRate.getSkipThreshold?.(r.skillHrid);
            const basis = clearRate.getEffectiveLevel?.(r.skillHrid);
            if (Number.isFinite(skip) && Number.isFinite(basis) && skip > 0) {
                // Explain the − 1: the trigger is the gap at which skipping starts,
                // so the hardest room you actually enter is one below it.
                lines.push(`Room ${room} — the hardest room you still fight`);
                lines.push(
                    `  trigger ${skip}: rooms ${basis + skip}+ (≥${skip} above you) are skipped, so ${room} is the top`
                );
            }
        }
        const bonus = Number(r.skillLevelBonus) || 0;
        lines.push(
            `Effective level ${r.effectiveLevel} = base ${r.baseLevel}${bonus ? ` + ${+bonus.toFixed(2)} buffs` : ''}`
        );
        const delta = Number.isFinite(r.levelDelta) ? r.levelDelta : r.effectiveLevel - room;
        lines.push(`Level gap: ${r.effectiveLevel} − ${room} = ${delta >= 0 ? '+' : ''}${delta}`);
        const lb = Number(r.levelBonus) || 0;
        const sb = Number(r.successBonus) || 0;
        lines.push(
            `Success = 0.8 × (1 ${lb >= 0 ? '+' : '−'} ${Math.abs(lb * 100).toFixed(1)}%` +
                `${sb ? ` + ${(sb * 100).toFixed(1)}% gear` : ''}) = ${((r.successChance || 0) * 100).toFixed(1)}%`
        );
        if (Number.isFinite(r.doubleChance) && r.doubleChance > 0) {
            lines.push(`Double progress: ${(r.doubleChance * 100).toFixed(0)}%`);
        }
        if (Number.isFinite(r.workPower)) {
            lines.push(
                `Work power ${r.workPower.toFixed(1)} → ${r.progressPerSuccess}/success, room needs ${r.targetProgress}`
            );
        }
        lines.push(`Clear ${((r.clearChance || 0) * 100).toFixed(1)}% over ${r.attempts || 0} attempts`);
        if (crateSummary) lines.push(`Crates: ${crateSummary}`);
        return lines.join('\n');
    }

    /**
     * "Expert tea" from an /items/expert_tea_crate hrid, for the breakdown's
     * crate line so it is clear which crate tier drove the numbers.
     * @private
     */
    _crateTierLabel(hrid) {
        const match = /\/items\/(\w+?)_(tea|coffee|food)_crate/.exec(hrid || '');
        return match ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}` : '';
    }

    _renderSkillingClearResults(results, roomLevel) {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-results');
        if (!container) return;

        const usesSkipLevels = roomLevel && typeof roomLevel === 'object';
        const clearRate = labyrinthClearRate() || bundledLabyrinthClearRate;
        // The crate tiers behind every row's numbers, for the breakdown's crate line
        const crateSummary = this._getSkillingCrates()
            .map((h) => this._crateTierLabel(h))
            .filter(Boolean)
            .join(' · ');
        // Hover text carries newlines and the odd math symbol — encode for an attr
        const attr = (text) =>
            String(text)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '&#10;');
        const activeResults = results.filter((r) => !r.skipped);
        const avgClearRate = activeResults.length
            ? activeResults.reduce((s, r) => s + (r.clearChance || 0), 0) / activeResults.length
            : 0;

        const thStyle = 'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const thLeftStyle = 'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const tdStyle = 'padding:3px 4px; text-align:right; font-size:11px;';

        const headerText = usesSkipLevels ? 'Skip-Level Rooms' : `Skilling Room Level ${roomLevel}`;
        let html = `<div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
            ${headerText}
            <span style="color:#888; font-weight:400; font-size:11px; margin-left:8px;">
                Avg Clear: <span style="color:${avgClearRate >= 0.95 ? '#4caf50' : avgClearRate >= 0.5 ? '#ff9800' : '#f44336'}; font-weight:600;">${(avgClearRate * 100).toFixed(1)}%</span>
                <span style="margin-left:8px; opacity:0.7;">· hover a row for the calculation</span>
            </span>
        </div>`;

        html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
        html += `<thead><tr>
            <th style="${thLeftStyle}">Skill</th>
            <th style="${thStyle}">Room</th>
            <th style="${thStyle}">Level</th>
            <th style="${thStyle}">Eff. Lvl</th>
            <th style="${thStyle}">Success</th>
            <th style="${thStyle}">Clear</th>
            <th style="${thStyle}">XP/Room</th>
            <th style="${thStyle}">Actions</th>
        </tr></thead><tbody>`;

        for (const r of results) {
            if (r.skipped) {
                html += `<tr style="border-bottom:1px solid #1a1a1a; opacity:0.55;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                    <td style="${tdStyle} color:#888;">Skip</td>
                    <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                </tr>`;
                continue;
            }
            const clearColor = r.clearChance >= 0.95 ? '#4caf50' : r.clearChance >= 0.5 ? '#ff9800' : '#f44336';
            const successPct = ((r.successChance || 0) * 100).toFixed(1);
            const clearPct = ((r.clearChance || 0) * 100).toFixed(1);
            const rowRoomLevel = r.roomLevel ?? roomLevel;
            const xpPerRoom = r.xpPerRoom > 0 ? formatKMB(r.xpPerRoom) : '—';
            const breakdown = attr(this._skillingRowBreakdown(r, usesSkipLevels, clearRate, crateSummary));

            html += `<tr style="border-bottom:1px solid #1a1a1a; cursor:help;" title="${breakdown}">
                <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                <td style="${tdStyle} color:#ccc;">${rowRoomLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.effectiveLevel}</td>
                <td style="${tdStyle} color:#ccc;">${successPct}%</td>
                <td style="${tdStyle} color:${clearColor}; font-weight:600;">${clearPct}%</td>
                <td style="${tdStyle} color:#ccc;">${xpPerRoom}</td>
                <td style="${tdStyle} color:#888;">${r.attempts || 0}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
        this._setStatus(
            usesSkipLevels
                ? 'Skilling clear rates calculated from automation skip levels.'
                : `Skilling clear rates calculated for level ${roomLevel}.`
        );
    }

    /** @private */
    async _onSkillingUpgradeAnalyze() {
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const skillEquipmentMap = this._scopeSkillEquipmentMap(
            this._buildSkillEquipmentMap(gameData),
            dto,
            targetSkill,
            gameData
        );

        const progressEl = this.panel.querySelector('#mwi-labsim-skilling-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-skilling-results');
        const calcBtn = this.panel.querySelector('#mwi-labsim-skilling-calc');
        const upgradeBtn = this.panel.querySelector('#mwi-labsim-skilling-upgrade');
        const stopBtn = this.panel.querySelector('#mwi-labsim-skilling-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        calcBtn.style.display = 'none';
        upgradeBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._skillingAborted = false;
        const eta = createEtaTracker();

        try {
            const analysisResult = await runSkillingUpgradeAnalysis(
                { editorDTO: dto, roomLevel, crateHrids, skillEquipmentMap, targetSkill },
                ({ current, total, description }) => {
                    if (this._skillingAborted) return;
                    const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                    }
                },
                { abortSignal: () => this._skillingAborted }
            );

            // Community buffs are an argument to the skilling calculation rather
            // than anything on the character, so the shared analysis — which
            // works by applying a candidate to a DTO — has nowhere to put one.
            // They get a pass of their own, for the same reason house rooms do.
            await this._runSkillingCommunityPass({
                dto,
                roomLevel,
                crateHrids,
                skillEquipmentMap,
                targetSkill,
                gameData,
                analysisResult,
                onProgress: ({ current, total, description }) => {
                    if (this._skillingAborted) return;
                    const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                    if (fill) fill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 100}%`;
                    if (text) text.textContent = `Community buffs ${current} / ${total}: ${description}`;
                },
            });

            // The results element this run started drawing into, still where it
            // was. A skilling analysis is not a worker run — it is a main-thread
            // loop that yields between candidates — so the `cancelSimulation()`
            // a feature teardown fires never reached it, and a run that outlived
            // a character switch came back to a panel that had been rebuilt for
            // somebody else. Drawn anyway, it replaced `_skillingSortHandler`
            // with one bound to the torn-down container, leaving the arriving
            // character's own sort handler orphaned on their table — every
            // later render stacked another, and sorting the skilling results
            // silently stopped working.
            if (this.panel?.contains(resultsEl)) {
                this._renderSkillingUpgradeResults(analysisResult, resultsEl);
            }
        } catch (error) {
            console.error('[LabSimUI] Skilling upgrade analysis failed:', error);
            this._setStatus('Skilling upgrade analysis failed: ' + error.message);
        } finally {
            progressEl.style.display = 'none';
            calcBtn.style.display = '';
            upgradeBtn.style.display = '';
            stopBtn.style.display = 'none';
        }
    }

    /**
     * The per-skill kits, with the pieces a single-skill run cannot feel removed.
     *
     * A skilling run over one skill used to weigh every noncombat piece the kit
     * had on — a Cooking run spent a full room evaluation on "Holy Chisel +5 →
     * +7", a crafting tool that cannot change a cooking room by any amount, and
     * then printed the +0.00% as though it were a finding. `scopeEquipmentToSkill`
     * decides what stays from the item's own stats, so it keeps up with the item
     * data rather than with a list kept here.
     *
     * Only for a single-skill run. Across every skill each kit is the kit some
     * room is actually wearing, and a chisel is exactly what the Crafting room
     * wants weighed.
     *
     * The kit is materialised for the target skill even when no loadout is
     * assigned to it, because the analysis falls back to the character's base
     * equipment when the map has no entry — and the base equipment is the
     * unscoped kit this is trying to avoid.
     *
     * @private
     * @param {Object} skillEquipmentMap - From `_buildSkillEquipmentMap`
     * @param {Object} dto - The editor's player
     * @param {string|null} targetSkill - The skill being simmed, when only one is
     * @param {Object} gameData - From `buildGameDataPayload`
     * @returns {Object} A per-skill equipment map
     */
    _scopeSkillEquipmentMap(skillEquipmentMap, dto, targetSkill, gameData) {
        if (!targetSkill) return skillEquipmentMap;
        const worn = skillEquipmentMap?.[targetSkill] || dto?.equipment || {};
        return {
            ...skillEquipmentMap,
            [targetSkill]: scopeEquipmentToSkill(worn, targetSkill, gameData?.itemDetailMap || {}),
        };
    }

    /**
     * Weigh one more level of each community buff the rooms being run can feel.
     *
     * The skilling tab could see the buffs — they have been part of the baseline
     * since the adapter started reading them — but never asked what another
     * level of one would do, which is the question a player who watches the
     * Gathering Quantity buff tick up actually has.
     *
     * Results are appended to the analysis the shared advisor returned, so one
     * table set covers the whole run. The XP baseline is filled in here when the
     * advisor did not need one: it only pays for the XP pass when something it
     * generated is ranked on XP, and the Experience buff is not something it
     * generates.
     *
     * @private
     * @param {Object} params - The run, plus `analysisResult` to append to
     * @returns {Promise<void>}
     */
    async _runSkillingCommunityPass({
        dto,
        roomLevel,
        crateHrids,
        skillEquipmentMap,
        targetSkill,
        gameData,
        analysisResult,
        onProgress,
    }) {
        if (!analysisResult || this._skillingAborted) return;

        const skills = targetSkill ? [targetSkill] : SKILLING_SKILL_HRIDS;
        const actionTypes = skills.map((hrid) => hrid.replace('/skills/', '/action_types/'));
        const candidates = generateSkillingCommunityBuffCandidates(
            dto.communityBuffLevels,
            actionTypes,
            this._getSkillingCommunityTargetLevel()
        );
        if (!candidates.length) return;

        // The same average the advisor's own baseline is, computed from the same
        // per-skill results so a delta is a difference rather than a comparison
        // of two ways of measuring
        const average = (results, key) => {
            const active = results.filter((r) => !r.skipped && (!targetSkill || r.skillHrid === targetSkill));
            if (!active.length) return 0;
            return active.reduce((sum, r) => sum + (r[key] || 0), 0) / active.length;
        };
        const evaluate = (player) =>
            computeSkillingClearRatesFromEditor(roomLevel, player, crateHrids, gameData, skillEquipmentMap);

        const baselineResults = evaluate(dto);
        const baselineClearRate = average(baselineResults, 'clearChance');
        const baselineXpPerRoom = average(baselineResults, 'xpPerRoom');

        if (analysisResult.baseline && !analysisResult.baseline.xpPerRoom) {
            analysisResult.baseline.xpPerRoom = baselineXpPerRoom;
        }

        let current = 0;
        for (const candidate of candidates) {
            // Yield so a Stop click and the progress paint can land between runs
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (this._skillingAborted) break;

            onProgress?.({ current, total: candidates.length, description: candidate.description });

            const modified = JSON.parse(JSON.stringify(dto));
            modified.communityBuffLevels = { ...(modified.communityBuffLevels || {}) };
            modified.communityBuffLevels[candidate.buffKey] = candidate.upgradeLevel;

            const results = evaluate(modified);
            const clearRate = average(results, 'clearChance');
            const xpPerRoom = average(results, 'xpPerRoom');

            analysisResult.results.push({
                candidate,
                // Neither gold nor tokens nor guild credits: donated cowbells,
                // and the level is the whole server's donations rather than a
                // purchase, so these rows are read on their delta
                costType: 'community',
                cost: null,
                cowbellCost: candidate.cowbellCost,
                clearRate,
                clearRateDelta: clearRate - baselineClearRate,
                xpPerRoom,
                xpPerRoomDelta: xpPerRoom - baselineXpPerRoom,
                metricType: candidate.metric,
            });

            current++;
            onProgress?.({ current, total: candidates.length, description: candidate.description });
        }
    }

    /** @private */
    _renderSkillingUpgradeResults(analysisResult, container) {
        const results = analysisResult?.results;
        if (!results || !results.length) {
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.</div>';
            this._setStatus('No skilling upgrade candidates found.');
            return;
        }

        const baseline = analysisResult.baseline;
        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const guildResults = results.filter((r) => r.costType === 'guild');
        const communityResults = results.filter((r) => r.costType === 'community');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const tdStyle = 'padding:3px 4px; text-align:right;';
        // The same division the combat Upgrade tab makes: numbers right-aligned
        // and never wrapped, only the name column reflowing. A gear row's label
        // — "Maelstrom Plate Body ★ → Lumberjack's Top +5 (woodcutting)" — is
        // long enough to push every measured column off the panel on one line.
        const tdNameStyle =
            'padding:3px 4px; color:#e0e0e0; text-align:left; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';

        const tokenRows = tokenResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;
            // The Experience token buys XP, not clears, so its two columns are
            // the ones that carry its case; every other row leaves them blank
            const isXpRow = r.metricType === 'xpPerRoom';
            const xpDelta = r.xpPerRoomDelta || 0;
            const tokensPerXp = r.tokensPerXp ?? Infinity;

            return {
                desc: r.candidate?.description || '',
                tokenCost,
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: isXpRow ? '\u2014' : (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor: isXpRow ? '#888' : deltaColor,
                tokensPerPct,
                tokensPerPctStr: !isXpRow && deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014',
                xpDelta,
                xpDeltaStr: isXpRow ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: isXpRow && xpDelta > 0 ? '#4caf50' : '#888',
                tokensPerXp,
                tokensPerXpStr:
                    isXpRow && Number.isFinite(tokensPerXp) ? formatWithSeparator(Math.round(tokensPerXp)) : '\u2014',
            };
        });

        const goldRows = goldResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const goldPerPct = goldPerPercent(r.cost, deltaVal);
            // A skilling piece replacing combat armour is priced at the piece
            // alone — the plate goes back in the loadout, not on the market — and
            // a row whose cost is suspiciously *high* has to say why, the same
            // way the labyrinth's forced armor swaps do
            const kept = r.candidate?.keptItems || [];

            return {
                desc: r.candidate?.description || '',
                cost: Number.isFinite(r.cost) ? r.cost : Infinity,
                costStr: goldCostCell(r.cost),
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, deltaVal),
                // Whatever handoff buttons the shared builder emits — the same
                // ones the combat Upgrade tab's gear rows carry, since a
                // skilling tool is bought in exactly the same marketplace
                actions: combatSimUI.upgradeRowActionsHtml(r),
                keptNote: kept.length
                    ? `Costed as the new piece alone. ${kept
                          .map(
                              (item) =>
                                  itemName(item.hrid) + (item.enhancementLevel ? ` +${item.enhancementLevel}` : '')
                          )
                          .join(
                              ', '
                          )} is combat gear you keep in a loadout, so its resale is deliberately not credited — selling it to fund skilling gear is not a trade anybody makes.`
                    : '',
                // The same click-to-expand the combat tab's gold rows carry. A
                // Cost column with no way to ask what is behind it is exactly
                // where a dash reads as free and a kept-gear price reads as wrong
                detailHtml: this._renderClearRateCostDetail(r, baseline),
            };
        });

        // A shrine level is bought with guild credits and guild tokens at once \u2014
        // neither the token table nor the gold table can price it, so it gets its
        // own with both halves side by side
        const guildRows = guildResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const cost = r.cost || 0;
            const goldPerPct = goldPerPercent(r.cost, deltaVal);
            const xpDelta = r.xpPerRoomDelta || 0;

            return {
                desc: r.candidate?.description || '',
                cost,
                costStr: r.cost == null ? '\u2014' : formatWithSeparator(cost),
                tokenCost: r.tokenCost || 0,
                tokenCostStr: formatWithSeparator(r.tokenCost || 0),
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, deltaVal),
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
                shrineNote: r.candidate?.needsShrineLevel
                    ? `Needs your guild's shrine at level ${r.candidate.needsShrineLevel} first`
                    : '',
            };
        });

        // A community buff level is not bought by anybody in particular — it is
        // what the server's donated minutes add up to — so there is no cost
        // column to rank on and the rows are read on their delta alone. The
        // cowbells-per-minute the game charges to keep the buff running is the
        // one real price there is, and it is shown as what it is.
        const communityRows = communityResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const xpDelta = r.xpPerRoomDelta || 0;
            const isXpRow = r.metricType === 'xpPerRoom';

            return {
                desc: r.candidate?.description || '',
                cowbellCost: r.cowbellCost ?? Infinity,
                cowbellCostStr: r.cowbellCost == null ? '—' : formatWithSeparator(r.cowbellCost) + '/min',
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: isXpRow ? '—' : (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor: isXpRow ? '#888' : deltaColor,
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '—',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
            };
        });

        const sortState = {
            token: { key: 'tokensPerPct', dir: 'asc' },
            gold: { key: 'goldPerPct', dir: 'asc' },
            guild: { key: 'goldPerPct', dir: 'asc' },
            community: { key: 'deltaVal', dir: 'desc' },
        };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
                ${th('XP/Room', 'xpDelta', 'right')}
                ${th('Tokens/XP', 'tokensPerXp', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.tokensPerXpStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGuildTable = () => {
            const s = sortState.guild;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="guild" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Guild Shrines</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Credits', 'cost', 'right')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Gold/1%', 'goldPerPct', 'right')}
                ${th('XP/Room', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of guildRows) {
                const note = row.shrineNote ? ` title="${row.shrineNote}"` : '';
                html += `<tr style="border-bottom:1px solid #1a1a1a;"${note}>
                    <td style="${tdNameStyle}">${row.desc}${row.shrineNote ? ' <span style="color:#ff9800;">*</span>' : ''}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCostStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                Credits are valued at the cheapest items that convert into them. Guild tokens are counted, not
                priced — nothing converts into them — so Gold/1% covers the credits only.${
                    guildRows.some((row) => row.shrineNote)
                        ? ' <span style="color:#ff9800;">*</span> needs a guild shrine upgrade first.'
                        : ''
                }
            </div>`;
            return html;
        };

        const renderCommunityTable = () => {
            const s = sortState.community;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="community" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Community Buffs</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cowbells', 'cowbellCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('XP/Room', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of communityRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.cowbellCostStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                A community buff's level is what the whole server's donated minutes add up to, so there is no price
                for one more level to rank on — the cowbell figure is what the game charges per minute to keep the
                buff running. A buff already at Lv${MAX_COMMUNITY_BUFF_LEVEL} (max) has no next level and is left out.
            </div>`;
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Gear Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Gold/1%', 'goldPerPct', 'right')}
            </tr></thead><tbody>`;

            goldRows.forEach((row, i) => {
                const note = ` title="${escapeHtmlAttribute(row.keptNote || 'Click for the cost breakdown')}"`;
                html += `<tr data-skilling-gold-row="${i}" style="border-bottom:1px solid #1a1a1a; cursor:pointer;"${note}>
                    <td style="${tdNameStyle}">${row.desc}${row.actions}${row.keptNote ? ' <span style="color:#ff9800;">*</span>' : ''}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                </tr>
                <tr data-skilling-gold-detail="${i}" style="display:none;">
                    <td colspan="5" style="padding:6px 10px; background:#0d0d1a; border-bottom:1px solid #222;">
                        ${row.detailHtml}
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            if (goldRows.some((row) => row.keptNote)) {
                html += `<div style="color:#666; font-size:10px; margin-top:4px;">
                    <span style="color:#ff9800;">*</span> priced as the new piece alone: the combat gear it goes in
                    place of is kept for its loadout, so its resale is not credited against the purchase.
                </div>`;
            }
            return html;
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            sortRows(guildRows, sortState.guild.key, sortState.guild.dir);
            sortRows(communityRows, sortState.community.key, sortState.community.dir);
            const baselineXp = baseline?.xpPerRoom || 0;
            let html = `<div style="color:#888; font-size:11px; margin-bottom:8px;">
                Baseline Avg Clear: <span style="color:#e0e0e0; font-weight:600;">${((baseline?.clearRate || 0) * 100).toFixed(1)}%</span>
                ${baselineXp > 0 ? ` · Avg XP/Room: <span style="color:#e0e0e0; font-weight:600;">${baselineXp.toFixed(1)}</span>` : ''}
            </div>`;
            if (tokenRows.length > 0) html += renderTokenTable();
            if (guildRows.length > 0) html += renderGuildTable();
            if (communityRows.length > 0) html += renderCommunityTable();
            if (goldRows.length > 0) html += renderGoldTable();
            container.innerHTML = html;
            // Re-wired on every render: a sort rebuilds the tables, and buttons
            // wired to the elements it threw away do nothing at all
            combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');
        };

        renderAll();

        this._addCsvExport(container, 'labsim-skilling-upgrades', () => ({
            columns: [
                { key: 'upgrade', label: 'Upgrade' },
                { key: 'skill', label: 'Skill' },
                { key: 'paidIn', label: 'Paid in' },
                { key: 'cost', label: 'Gold cost' },
                { key: 'tokenCost', label: 'Token cost' },
                { key: 'clearRate', label: 'Avg clear rate' },
                { key: 'clearRateDelta', label: 'Clear rate change' },
                { key: 'perPercent', label: 'Cost per +1%' },
                { key: 'xpPerRoomDelta', label: 'XP/room change' },
                { key: 'tokensPerXp', label: 'Tokens per +1 XP/room' },
            ],
            rows: results.map((r) => {
                const paid = r.costType === 'token' ? r.tokenCost : r.cost;
                const gain = (r.clearRateDelta || 0) * 100;
                return {
                    upgrade: r.candidate?.description || '',
                    // Gear bought for one skill says which; an enhancement of
                    // something worn everywhere has no one skill to name
                    skill: (r.candidate?.skillKey || '').replace('/skills/', ''),
                    paidIn: CSV_PAID_IN[r.costType] || 'gold',
                    cost: r.costType === 'token' ? null : (r.cost ?? null),
                    tokenCost: r.costType === 'gold' || r.costType === 'community' ? null : (r.tokenCost ?? null),
                    clearRate: r.clearRate ?? null,
                    clearRateDelta: r.clearRateDelta ?? null,
                    perPercent: gain > 0 && paid ? Math.round(paid / gain) : null,
                    xpPerRoomDelta: r.xpPerRoomDelta ?? null,
                    tokensPerXp: Number.isFinite(r.tokensPerXp) ? Math.round(r.tokensPerXp) : null,
                };
            }),
        }));

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        if (this._skillingSortHandler) {
            container.removeEventListener('click', this._skillingSortHandler);
        }
        this._skillingSortHandler = (e) => {
            // A row's own handoff buttons come first — a click on "Buy" is not a
            // request to unfold the row it sits in
            const expandable = e.target.closest('tr[data-skilling-gold-row]');
            if (expandable && !e.target.closest('[data-buy-action]')) {
                const detail = container.querySelector(
                    `[data-skilling-gold-detail="${expandable.dataset.skillingGoldRow}"]`
                );
                if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                return;
            }
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this._skillingSortHandler);

        this._setStatus(`${results.length} skilling upgrade candidates analyzed.`);
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
        this._populateMonsters();

        if (!this._editor.isInitialized()) {
            this._editor.initEditor();
            // The first monster in the list is selected but was never chosen,
            // so the handler that applies its labyrinth loadout never ran — the
            // default monster opened on whatever gear happened to be on, which
            // is the one case where the panel silently disagreed with every
            // other monster in the list.
            //
            // Only on the first initialization: reapplying on every open would
            // throw away gear changed by hand since.
            this._whenEditorReady().then(() => {
                const selected = this.panel?.querySelector('#mwi-labsim-monster')?.value;
                if (selected) this._onMonsterChange(selected);
            });
        }
    }

    /** @param {Object} [options] - `remember: false` to close without forgetting it was open */
    hide({ remember = true } = {}) {
        if (!this.panel) return;
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this.panel.style.display = 'none';
    }

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
     * Open the panel preconfigured from a labyrinth tile: combat tiles select
     * the monster (applying its assigned labyrinth loadout) at the tile's room
     * level; skilling tiles open the Skilling tab with the room level set and
     * the skill's loadout row filtered.
     * @param {Object} detail - { monsterHrid?, skillHrid?, roomLevel? }
     */
    async openPreconfigured(detail = {}) {
        if (!this.panel) return;
        if (this.panel.style.display === 'none') {
            this.show();
        } else {
            bringPanelToFront(this.panel);
        }

        const roomLevel = Math.round(Number(detail.roomLevel) || 0);

        if (detail.monsterHrid) {
            this._switchTab('configure');
            const select = this.panel.querySelector('#mwi-labsim-monster');
            if (select) select.value = detail.monsterHrid;
            if (roomLevel > 0) {
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                if (levelInput) levelInput.value = roomLevel;
            }
            // Applying the assigned loadout needs the editor loaded
            await this._whenEditorReady();
            this._onMonsterChange(detail.monsterHrid);
        } else if (detail.skillHrid) {
            this._switchTab('skilling');
            if (roomLevel > 0) {
                const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip');
                const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
                if (useSkip) useSkip.checked = false;
                if (levelInput) {
                    levelInput.disabled = false;
                    levelInput.value = roomLevel;
                }
            }
            const filter = this.panel.querySelector('#mwi-labsim-skilling-filter');
            if (filter && [...filter.options].some((o) => o.value === detail.skillHrid)) {
                filter.value = detail.skillHrid;
                filter.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    /**
     * Wait (up to ~10s) for the configure editor to finish initializing.
     * @private
     * @returns {Promise<boolean>} True when the editor is ready
     */
    async _whenEditorReady() {
        for (let i = 0; i < 40; i++) {
            if (this._editor?.isInitialized()) return true;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return this._editor?.isInitialized() || false;
    }

    destroy() {
        if (this._openRequestHandler) {
            document.removeEventListener('mwi-labsim-open', this._openRequestHandler);
            this._openRequestHandler = null;
        }
        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
        this._detachDrag?.();
        this._detachDrag = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
        this.isRunning = false;
        if (this._editor) this._editor.reset();
        if (this._skillingEditor) this._skillingEditor.reset();
        this._maxLevel = null;
        this._labyResults = null;
        this._upgradeTargetHrids = null;
        // "I picked a crate by hand" is a choice about the panel that is being
        // torn down here, not a standing preference. destroy() runs on a
        // character switch (the feature is disabled and re-initialised around
        // it), so leaving these set means the arriving character's freshly
        // built dropdowns skip _applyEquippedCratesTo and sit on the markup's
        // hardcoded Expert — scoring their fight against crates they may not
        // own, silently, until they notice and touch the dropdown themselves.
        this._skillingCratesUserSet = false;
        this._combatCratesUserSet = false;
        // Every sim behind this panel is a worker run, and the feature's
        // `disable()` rejects all of them through `cancelSimulation()` — except
        // the Skilling tab's upgrade analysis, which is main-thread arithmetic
        // that yields between candidates and stops only when this flag is set.
        // Nothing set it here, so a switch left it running against the
        // departing character's build: it kept burning CPU, and its progress
        // callbacks re-read `this.panel` on every tick, so once the arriving
        // character's panel was built it drove *their* progress bar and text
        // from a run that was never theirs — with the Stop button that could
        // have ended it torn down along with the panel it belonged to.
        this._skillingAborted = true;
        // Everything below is a reading of one character's build. None of it is
        // re-derived on the way back in — `_maxLevelByMonster` is consulted only
        // when a monster is missing from it, and the rest is simply redrawn — so
        // left standing it becomes the arriving character's answer.
        //
        // `_maxLevelByMonster` is the worst of them: the highest room level that
        // character could clear, fed straight into the next fight setup as
        // `simMaxLevel`.
        this._maxLevelByMonster = {};
        this._allFightsResult = null;
        this._upgradePlayerName = null;
        this._houseScanNote = null;
        this._restoredUpgradeAt = null;
        this._restoredUpgradeMeta = null;
        // A fresh store rather than a cleared one: the runs live in storage, and
        // the next panel should read them back rather than start empty
        this._comparison = new LabComparisonStore();
    }

    /**
     * Let the panel be dragged by its header, remembering where it is dropped.
     *
     * The shared helper rather than a local copy: it carries the click-vs-drag
     * guard and the pointer/touch handling, and — the point of the change — a
     * drop that actually goes somewhere is written to the geometry store, so the
     * panel stops snapping back to the top-right corner on every reload.
     *
     * @param {HTMLElement} handle - The bar you grab
     * @private
     */
    _setupDrag(handle) {
        this._detachDrag?.();
        this._detachDrag = makeDraggable(this.panel, handle, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
    }

    /**
     * Remember how big the panel is, and where its left edge ended up.
     *
     * The left grip moves the left edge as it resizes, so a saved size without
     * the position it was reached at would put the panel back somewhere it never
     * was.
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
     * Clamping lives in `panel-geometry.js`, so geometry saved in a larger window
     * cannot open the panel off-screen or wider than it can be resized back from.
     *
     * @private
     */
    _restorePanelGeometry() {
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT });
    }

    /**
     * The two bottom corner grips.
     *
     * Kept bespoke rather than moved to `makeResizable`, which only offers the
     * bottom-right corner — the left grip, which holds the right edge still while
     * the left one follows the cursor, is the whole reason a panel docked against
     * the right of the screen can be widened at all.
     *
     * @param {HTMLElement} handle - The grip
     * @param {'left'|'right'} [corner] - Which corner it sits in
     * @private
     */
    _setupResize(handle, corner = 'right') {
        handle.style.touchAction = 'none';
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = this.panel.offsetWidth;
            const startHeight = this.panel.offsetHeight;
            // The panel opens anchored to the right of the window; growing it
            // leftwards means moving its left edge, so pin the position it is
            // at now and drive it from the left from here on
            const startLeft = this.panel.getBoundingClientRect().left;
            this.panel.style.left = `${startLeft}px`;
            this.panel.style.right = 'auto';
            bringPanelToFront(this.panel);

            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const newWidth = Math.max(MIN_PANEL_WIDTH, corner === 'left' ? startWidth - dx : startWidth + dx);
                const newHeight = Math.max(MIN_PANEL_HEIGHT, startHeight + (ev.clientY - startY));
                // Clamped at the minimum the left edge stops moving too, rather
                // than sliding the panel along while it refuses to shrink
                if (corner === 'left') this.panel.style.left = `${startLeft + (startWidth - newWidth)}px`;
                this.panel.style.width = `${newWidth}px`;
                this.panel.style.height = `${newHeight}px`;
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                this._persistPanelGeometry();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }
}

/**
 * What a whole-run analysis has just committed to, in one sentence.
 *
 * Nothing about the Upgrade tab is refused for being large any more — ability
 * swaps across a full labyrinth used to be, and the refusal landed on the one
 * scope where the question is most worth asking. What replaces the refusal is
 * this: the count is put in front of the player before the first simulation,
 * while Stop still costs nothing, and if the run is large enough that each
 * simulation has been shortened to fit, the sentence says so rather than letting
 * a noisier table pass for the same table.
 *
 * @param {Object} plan - The `plan` an all-fights analysis reports up front
 * @returns {string} Status line text
 */
export function describeAllFightsPlan(plan) {
    if (!plan) return '';
    const head =
        `${plan.candidates.toLocaleString()} upgrades across ${plan.fights} fights — ` +
        `${plan.sims.toLocaleString()} simulations (each upgrade only in the rooms it reaches)`;
    if (!plan.reduced) return `${head}. Stop cancels at any point.`;
    return (
        `${head}. Big enough that each one runs ${Math.round(plan.trialScale * 100)}% of the ${plan.requestedHours}h ` +
        'asked for — every fight is still simulated, the win rates are just noisier. Stop cancels at any point.'
    );
}

/**
 * Which build guide each loadout was read as playing, in one clause.
 *
 * The swap generator narrows a loadout to its archetype's own ability set when
 * it can name the archetype off the weapon, and falls back to offering every
 * style-compatible ability in the game when it cannot. Those are different
 * questions producing differently trustworthy tables, and after pooling the
 * results carry no trace of which loadout got which. A loadout that fell back is
 * the one a reader most needs to know about: its rows came out of a search wide
 * enough that the guide's own answer may not be in them at all.
 *
 * @param {Array<Object>} archetypes - `[{loadoutName, archetype, label}]` from the analysis
 * @returns {string} Status clause, empty when there is nothing to report
 */
export function describeArchetypes(archetypes) {
    if (!archetypes?.length) return '';
    const parts = archetypes.map((entry) => {
        const name = entry.loadoutName || 'Loadout';
        if (!entry.archetype) return `${name} → no archetype (all abilities offered)`;
        return `${name} → ${entry.label || entry.archetype}`;
    });
    return ` Swaps: ${parts.join(', ')}.`;
}

const labSimUI = new LabSimUI();
export default labSimUI;
