/**
 * Configuration Module
 * Manages all script constants and user settings
 */

import settingsStorage from './settings-storage.js';
import { settingsGroups } from './settings-schema.js';
import dataManager from './data-manager.js';
import storage from './storage.js';

/**
 * Every setting key in the schema mapped to its declared default.
 *
 * Built once at module load rather than rediscovered by scanning the groups on
 * each lookup — the schema is static, so the flattened map cannot go stale.
 */
const SCHEMA_DEFAULTS = (() => {
    const defaults = Object.create(null);
    for (const group of Object.values(settingsGroups)) {
        for (const [key, setting] of Object.entries(group.settings || {})) {
            defaults[key] = setting.default;
        }
    }
    return defaults;
})();

/**
 * How long an emptied settings map may stay empty before config reloads it
 * itself. Comfortably longer than the character-switch chain takes to reach its
 * own `loadSettings()` (a teardown of every feature plus a 50 ms settle), so
 * the watchdog only ever fires for a clear whose reload never came.
 */
const RELOAD_WATCHDOG_MS = 15000;

/**
 * Config class manages all script configuration
 * - Constants (colors, URLs, formatters)
 * - User settings with persistence
 */
class Config {
    constructor() {
        // Number formatting separators (locale-aware)
        this.THOUSAND_SEPARATOR = new Intl.NumberFormat().format(1111).replaceAll('1', '').at(0) || '';
        this.DECIMAL_SEPARATOR = new Intl.NumberFormat().format(1.1).replaceAll('1', '').at(0);

        // Extended color palette (configurable)
        // Dark background colors (for UI elements on dark backgrounds)
        this.COLOR_PROFIT = '#047857'; // Emerald green for positive values
        this.COLOR_LOSS = '#f87171'; // Red for negative values
        this.COLOR_WARNING = '#ffa500'; // Orange for warnings
        this.COLOR_INFO = '#60a5fa'; // Blue for informational
        this.COLOR_ESSENCE = '#c084fc'; // Purple for essences

        // Tooltip colors (for text on light/tooltip backgrounds)
        this.COLOR_TOOLTIP_PROFIT = '#047857'; // Green for tooltips
        this.COLOR_TOOLTIP_LOSS = '#dc2626'; // Darker red for tooltips
        this.COLOR_TOOLTIP_INFO = '#2563eb'; // Darker blue for tooltips
        this.COLOR_TOOLTIP_WARNING = '#ea580c'; // Darker orange for tooltips

        // General colors
        this.COLOR_TEXT_PRIMARY = '#ffffff'; // Primary text color
        this.COLOR_TEXT_SECONDARY = '#888888'; // Secondary text color
        this.COLOR_BORDER = '#444444'; // Border color
        this.COLOR_GOLD = '#ffa500'; // Gold/currency color
        this.COLOR_MIRROR = '#ffd700'; // Philosopher's Mirror highlight color
        this.COLOR_LISTING_PRICE_1M = '#ffd700'; // Listing total price 1M+
        this.COLOR_LISTING_PRICE_100K = '#22c55e'; // Listing total price 100K+
        this.COLOR_LISTING_PRICE_10K = '#ffffff'; // Listing total price 10K+
        this.COLOR_LISTING_PRICE_LOW = '#888888'; // Listing total price <10K
        this.COLOR_ACCENT = '#22c55e'; // Script accent color (green)
        this.COLOR_REMAINING_XP = '#FFFFFF'; // Remaining XP text color
        this.COLOR_XP_RATE = '#ffffff'; // XP/hr rate text color
        this.COLOR_HOURS_TO_LEVEL = '#ffffff'; // Hours to level text color
        this.COLOR_INV_COUNT = '#ffffff'; // Inventory count display color

        // Legacy color constants (mapped to COLOR_ACCENT)
        this.SCRIPT_COLOR_MAIN = this.COLOR_ACCENT;
        this.SCRIPT_COLOR_TOOLTIP = this.COLOR_ACCENT;
        this.SCRIPT_COLOR_ALERT = 'red';

        // Z-index tiers
        this.Z_HUD = 50; // In-game HUD overlays — below game interactive UI
        this.Z_FLOATING_PANEL = 1100; // Persistent panels — below MUI modals (game = ~1300)
        this.Z_POPUP = 9000; // Contextual popups / short-lived overlays
        this.Z_MODAL = 9000; // Full-screen intentional modals
        this.Z_NOTIFICATION = 99999; // Transient notifications (above everything)

        // Market API URL
        this.MARKET_API_URL = 'https://www.milkywayidle.com/game_data/marketplace.json';

        // Settings loaded from settings-schema via settings-storage.js
        this.settingsMap = {};
        /** Whose settings `settingsMap` holds — see loadSettings() */
        this.settingsOwner = null;

        // Map of setting keys to callback functions
        this.settingChangeCallbacks = {};

        // Callbacks fired whenever loadSettings() repopulates the map, regardless
        // of whether any individual value changed. A character switch clears the
        // cache and reloads it with previousMap empty, so the per-key change
        // callbacks above are all skipped — a persistent feature that never
        // re-initializes (the Action Filter) has no other signal that fresh
        // per-character settings have arrived. See onSettingsLoaded().
        this.settingsLoadedCallbacks = [];

        // Writes made while `settingsMap` is empty, applied once loadSettings()
        // refills it. A character switch clears the map and only reloads it
        // several awaits later; a settings-panel toggle in that window found no
        // entry to write to and was dropped without a save or a notify, leaving
        // the checkbox flipped over a value nothing had recorded. One entry per
        // key, last write winning. See _deferWriteDuringReload().
        this._pendingWrites = [];

        /**
         * The same queued writes keyed for reading, so `getSetting` answers a
         * write it has taken but not yet stored. Cleared with the queue.
         */
        this._pendingValues = Object.create(null);

        /** Timer that reloads a map left empty by a clear nobody followed — see _armReloadWatchdog() */
        this._reloadWatchdog = null;

        /**
         * Bumped by every `loadSettings()` entry. A load whose generation has
         * moved by the time its read settles is stale and must not adopt its
         * result — see loadSettings().
         */
        this._loadGeneration = 0;

        // Feature toggles with metadata for future UI
        this.features = {
            // Market Features
            tooltipPrices: {
                enabled: true,
                name: 'Market Prices in Tooltips',
                category: 'Market',
                description: 'Shows bid/ask prices in item tooltips',
                settingKey: 'itemTooltip_prices',
            },
            tooltipArtisanPrices: {
                enabled: true,
                name: 'Artisan-Adjusted Tooltip Prices',
                category: 'Market',
                description: 'Adjusts tooltip price totals for Artisan Tea material reduction',
                settingKey: 'itemTooltip_artisanPrices',
            },
            tooltipProfit: {
                enabled: true,
                name: 'Profit Calculator in Tooltips',
                category: 'Market',
                description: 'Shows production cost and profit in tooltips',
                settingKey: 'itemTooltip_profit',
            },
            tooltipConsumables: {
                enabled: true,
                name: 'Consumable Effects in Tooltips',
                category: 'Market',
                description: 'Shows buff effects and durations for food/drinks',
                settingKey: 'showConsumTips',
            },
            dungeonTokenTooltips: {
                enabled: true,
                name: 'Currency Token Tooltips',
                category: 'Inventory',
                description: 'Shows shop values for tokens, seals, and cowbells',
                settingKey: 'dungeonTokenTooltips',
            },
            expectedValueCalculator: {
                enabled: true,
                name: 'Expected Value Calculator',
                category: 'Market',
                description: 'Shows EV for openable containers (crates, chests)',
                settingKey: 'itemTooltip_expectedValue',
            },
            market_showListingPrices: {
                enabled: true,
                name: 'Market Listing Price Display',
                category: 'Market',
                description: 'Shows top order price, total value, and listing age on My Listings',
                settingKey: 'market_showListingPrices',
            },
            market_collectableListingsToTop: {
                enabled: true,
                name: 'Collectable Listings to Top',
                category: 'Market',
                description: 'Moves listings with something to collect to the top of My Listings',
                settingKey: 'market_collectableListingsToTop',
            },
            market_showEstimatedListingAge: {
                enabled: true,
                name: 'Estimated Listing Age',
                category: 'Market',
                description: 'Estimates creation time for all market listings using listing ID interpolation',
                settingKey: 'market_showEstimatedListingAge',
            },
            market_showOrderTotals: {
                enabled: true,
                name: 'Market Order Totals',
                category: 'Market',
                description: 'Shows buy orders, sell orders, and unclaimed coins in header',
                settingKey: 'market_showOrderTotals',
            },
            market_showHistoryViewer: {
                enabled: true,
                name: 'Market History Viewer',
                category: 'Market',
                description: 'View and export all market listing history',
                settingKey: 'market_showHistoryViewer',
            },
            market_listingRefreshNavigator: {
                enabled: true,
                name: 'Listing Refresh Navigator',
                category: 'Market',
                description: 'Refresh on My Listings, then Next/Back to My Listings on each order-book page',
                settingKey: 'market_listingRefreshNavigator',
            },
            // Keyed by the feature-registry key (see entrypoint.js), not the setting id, so the
            // registry's own enabled check finds it and routes through settingKey below.
            marketItemHop: {
                enabled: false,
                name: 'Market Item Hop',
                category: 'Market',
                description: 'Step to the previous/next marketplace item without returning to the item grid',
                settingKey: 'market_itemHop',
            },
            market_showPhiloCalculator: {
                enabled: true,
                name: 'Philo Gamba Calculator',
                category: 'Market',
                description: "Calculate expected value of transmuting items into Philosopher's Stones",
                settingKey: 'market_showPhiloCalculator',
            },

            // Action Features
            actionTimeDisplay: {
                enabled: true,
                name: 'Action Queue Time Display',
                category: 'Actions',
                description: 'Shows total time and completion time for queued actions',
                settingKey: 'actionBar_enabled',
            },
            actionCountdown: {
                enabled: true,
                name: 'Action Bar Countdown',
                category: 'Actions',
                description: 'Live countdown timer on the action progress bar',
            },
            actionTimingMonitor: {
                enabled: true,
                name: 'Action Timing Monitor',
                category: 'Actions',
                description: 'Diagnostic: records actions whose progress bar finishes early and then sits full',
                settingKey: 'actionTiming_monitor',
            },
            quickInputButtons: {
                enabled: true,
                name: 'Quick Input Buttons',
                category: 'Actions',
                description: 'Adds 1/10/100/1000 buttons to action inputs',
                settingKey: 'actionPanel_totalTime_quickInputs',
            },
            actionPanelProfit: {
                enabled: true,
                name: 'Action Profit Display',
                category: 'Actions',
                description: 'Shows profit/loss for gathering and production',
                settingKey: 'actionPanel_foragingTotal',
            },
            requiredMaterials: {
                enabled: true,
                name: 'Required Materials Display',
                category: 'Actions',
                description: 'Shows total required and missing materials for production actions',
                settingKey: 'requiredMaterials',
            },

            drinkTimer: {
                enabled: true,
                name: 'Drink Timer',
                category: 'Actions',
                description: 'Shows remaining drink supply time and queue coverage in skill panels',
                settingKey: 'drinkTimer',
            },

            // Combat Features
            abilityBookCalculator: {
                enabled: true,
                name: 'Ability Book Requirements',
                category: 'Combat',
                description: 'Shows books needed to reach target level',
                settingKey: 'skillbook',
            },
            zoneIndices: {
                enabled: true,
                name: 'Combat Zone Indices',
                category: 'Combat',
                description: 'Shows zone numbers in combat location list',
                settingKey: 'mapIndex',
            },
            taskZoneIndices: {
                enabled: true,
                name: 'Task Zone Indices',
                category: 'Tasks',
                description: 'Shows zone numbers on combat tasks',
                settingKey: 'taskMapIndex',
            },
            combatScore: {
                enabled: true,
                name: 'Profile Gear Score',
                category: 'Combat',
                description: 'Shows gear score on profile',
                settingKey: 'combatScore',
            },
            dungeonTracker: {
                enabled: true,
                name: 'Dungeon Tracker',
                category: 'Combat',
                description:
                    'Real-time dungeon progress tracking in top bar with wave times, statistics, and party chat completion messages',
                settingKey: 'dungeonTracker',
            },
            combatStats: {
                enabled: true,
                name: 'Combat Statistics',
                category: 'Combat',
                description: 'Tracks combat data and consumable usage; shows Statistics tab in Combat panel',
                settingKey: 'combatStats',
            },
            combatSimIntegration: {
                enabled: true,
                name: 'Combat Simulator Integration',
                category: 'Combat',
                description: 'Auto-import character/party data into the Shykai or szerra Combat Simulator',
                settingKey: null, // New feature, no legacy setting
            },
            enhancementSimulator: {
                enabled: true,
                name: 'Enhancement Simulator',
                category: 'Market',
                description: 'Shows enhancement cost calculations in item tooltips',
                settingKey: 'enhanceSim',
            },

            // UI Features
            equipmentLevelDisplay: {
                enabled: true,
                name: 'Equipment Level on Icons',
                category: 'UI',
                description: 'Shows item level number on equipment icons',
                settingKey: 'itemIconLevel',
            },
            alchemyItemDimming: {
                enabled: true,
                name: 'Alchemy Item Dimming',
                category: 'UI',
                description: 'Dims items requiring higher Alchemy level',
                settingKey: 'alchemyItemDimming',
            },
            skillExperiencePercentage: {
                enabled: true,
                name: 'Skill Experience Percentage',
                category: 'UI',
                description: 'Shows XP progress percentage in left sidebar',
                settingKey: 'expPercentage',
            },
            combatLevelProgress: {
                enabled: true,
                name: 'Decimal Combat Level',
                category: 'UI',
                description: 'Shows the unfloored Combat Level formula value in the left sidebar',
                settingKey: 'combatLevelProgress',
            },
            largeNumberFormatting: {
                enabled: true,
                name: 'Use K/M/B Number Formatting',
                category: 'UI',
                description: 'Display large numbers as 1.5M instead of 1,500,000',
                settingKey: 'formatting_useKMBFormat',
            },

            // Task Features
            taskProfitDisplay: {
                enabled: true,
                name: 'Task Profit Calculator',
                category: 'Tasks',
                description: 'Shows expected profit from task rewards',
                settingKey: 'taskProfitCalculator',
            },
            taskEfficiencyRating: {
                enabled: true,
                name: 'Task Efficiency Rating',
                category: 'Tasks',
                description: 'Shows tokens or profit per hour on task cards',
                settingKey: 'taskEfficiencyRating',
            },
            taskRerollTracker: {
                enabled: true,
                name: 'Task Reroll Tracker',
                category: 'Tasks',
                description: 'Tracks reroll costs and history',
                settingKey: 'taskRerollTracker',
            },
            taskSorter: {
                enabled: true,
                name: 'Task Sorting',
                category: 'Tasks',
                description: 'Adds button to sort tasks by skill type',
                settingKey: 'taskSorter',
            },
            taskIcons: {
                enabled: true,
                name: 'Task Icons',
                category: 'Tasks',
                description: 'Shows visual icons on task cards',
                settingKey: 'taskIcons',
            },
            taskIconsDungeons: {
                enabled: false,
                name: 'Task Icons - Dungeons',
                category: 'Tasks',
                description: 'Shows dungeon icons for combat tasks',
                settingKey: 'taskIconsDungeons',
                dependencies: ['taskIcons'],
            },

            // Skills Features
            skillRemainingXP: {
                enabled: true,
                name: 'Remaining XP Display',
                category: 'Skills',
                description: 'Shows remaining XP to next level on skill bars',
                settingKey: 'skillRemainingXP',
            },
            skillingOptimizer: {
                enabled: true,
                name: 'Skilling Simulator/Optimizer',
                category: 'Skills',
                description: 'Optimizer tab in the character panel',
                settingKey: 'skillingOptimizer',
            },

            // House Features
            houseCostDisplay: {
                enabled: true,
                name: 'House Upgrade Costs',
                category: 'House',
                description: 'Shows market value of upgrade materials',
                settingKey: 'houseUpgradeCosts',
            },

            // Economy Features
            networth: {
                enabled: true,
                name: 'Net Worth Calculator',
                category: 'Economy',
                description: 'Shows total asset value in header (Current Assets)',
                settingKey: 'networth',
            },
            inventorySummary: {
                enabled: true,
                name: 'Inventory Summary Panel',
                category: 'Economy',
                description: 'Shows detailed networth breakdown below inventory',
                settingKey: 'invWorth',
            },
            inventorySort: {
                enabled: true,
                name: 'Inventory Sort',
                category: 'Economy',
                description: 'Sorts inventory by Ask/Bid price',
                settingKey: 'invSort',
            },
            inventorySortBadges: {
                enabled: false,
                name: 'Inventory Sort Price Badges',
                category: 'Economy',
                description: 'Shows stack value badges on items when sorting',
                settingKey: 'invSort_showBadges',
            },
            inventoryBadgePrices: {
                enabled: false,
                name: 'Inventory Price Badges',
                category: 'Economy',
                description: 'Shows stack value badges on items (independent of sorting)',
                settingKey: 'invBadgePrices',
            },

            // Enhancement Features
            enhancementTracker: {
                enabled: false,
                name: 'Enhancement Tracker',
                category: 'Enhancement',
                description: 'Tracks enhancement attempts, costs, and statistics',
                settingKey: 'enhancementTracker',
            },

            // Notification Features
            notifiEmptyAction: {
                enabled: false,
                name: 'Empty Queue Notification',
                category: 'Notifications',
                description: 'Browser notification when action queue becomes empty',
                settingKey: 'notifiEmptyAction',
            },
        };

        // Note: loadSettings() must be called separately (async)
    }

    /**
     * Initialize config (async) - loads settings from storage
     * @returns {Promise<void>}
     */
    async initialize() {
        await this.loadSettings();
        this.applyColorSettings();
    }

    /**
     * Load settings from storage (async)
     * @returns {Promise<void>}
     */
    async loadSettings() {
        const generation = ++this._loadGeneration;

        // Set character ID in settings storage for per-character settings
        const characterId = dataManager.getCurrentCharacterId();

        // Before character ID is known, only populate schema defaults (no storage access)
        // This prevents loading from the wrong storage key during early initialization
        if (!characterId) {
            this.settingsMap = settingsStorage.buildDefaults();
            this.characterSettingsLoaded = false;
            this._flushPendingWrites();
            return;
        }

        settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName());

        const previousMap = this.settingsMap;

        // Load settings from settings-storage (which uses settings-schema as source of truth)
        const loadedMap = await settingsStorage.loadSettings();

        // Captured before the read, checked after it. `settingsOwner` records
        // whose map is in hand but cannot arbitrate two loads in flight at
        // once: a switch A→B starts B's load while A's is still outstanding,
        // and if A's read settles second it overwrote both `settingsMap` and
        // `settingsOwner` with A's data — config then served character A's
        // settings to every reader while the player was on B. `setSetting`'s
        // key check catches the resulting cross-character *write*, but the
        // features initializing off this map and the panels drawing from it
        // read the wrong values with nothing to catch them.
        //
        // Stale means either: a later `loadSettings()` has since started (its
        // result is the one to keep, whether it has landed yet or not), or the
        // player has moved off the character this read was for. Discard rather
        // than adopt. The map may be left empty by that, which is why the
        // discard leaves `_pendingWrites` queued for the winning load to drain
        // and leaves the `clearSettingsCache()` watchdog armed to refill a map
        // no later load ever reaches.
        const stale = generation !== this._loadGeneration || dataManager.getCurrentCharacterId() !== characterId;
        if (stale) {
            console.warn('[Config] Settings load discarded: the character changed while they loaded');
            return;
        }

        if (settingsStorage.lastLoadReadable === false) {
            // The store could not be read, so what came back is schema defaults
            // standing in for the user's settings. Keep the map in hand when it
            // is this character's — it was read properly once — and take the
            // defaults only when there is nothing better; either way the map
            // does not count as loaded, so saveSettings() will not write it
            // whole over what is stored.
            const keep = this.characterSettingsLoaded && this.settingsOwner === characterId;
            console.warn(
                `[Config] Settings for this character could not be read; ${keep ? 'keeping the settings in hand' : 'using defaults until they can be'}`
            );
            if (!keep) {
                this.settingsMap = loadedMap;
                this.settingsOwner = characterId;
                this.characterSettingsLoaded = false;
            }
        } else {
            this.settingsMap = loadedMap;
            this.settingsOwner = characterId;
            this.characterSettingsLoaded = true;
        }

        // Apply anything written while the map was empty, before either fan-out
        // below: the write is the newer intent, and a settings-loaded subscriber
        // reading the key must see the value the player just set rather than the
        // one that came off storage. Each replayed write saves and notifies for
        // itself.
        this._flushPendingWrites();

        // Fire change callbacks for settings that differ from what was previously loaded
        for (const key of Object.keys(this.settingChangeCallbacks)) {
            const prev = previousMap[key];
            const curr = this.settingsMap[key];
            if (!prev || !curr) continue;
            const prevVal = prev.hasOwnProperty('value') ? prev.value : prev.isTrue;
            const currVal = curr.hasOwnProperty('value') ? curr.value : curr.isTrue;
            if (prevVal !== currVal) {
                this._notifySettingChange(key, currVal);
            }
        }

        // Fire the settings-loaded channel unconditionally: the map has just been
        // repopulated, which is the one signal a persistent feature can use to
        // resync after a character switch (when previousMap was empty and no
        // per-key change callback fired).
        for (const cb of this.settingsLoadedCallbacks) {
            try {
                cb();
            } catch (error) {
                console.error('[Config] settings-loaded callback failed:', error);
            }
        }
    }

    /**
     * Clear settings cache (for character switching)
     */
    clearSettingsCache() {
        this.settingsMap = {};
        this.characterSettingsLoaded = false;
        this._armReloadWatchdog();
    }

    /**
     * Make sure an emptied map gets refilled even if the caller forgets.
     *
     * Clearing is only ever half of a pair — the character-switch chain clears
     * on the way down and reloads on the way up — but the reload is not
     * guaranteed by anything: the chain's re-init step returns early when a
     * newer switch is already in flight, and a `loadSettings()` that rejects
     * leaves the map empty with nothing else scheduled to try again. An empty
     * map is not a neutral state: every read falls through to the shipped schema
     * default (so settings the player turned off come back on) and every write
     * goes to `_pendingWrites`, which only a load drains — so nothing is stored
     * until one happens.
     *
     * Re-armed rather than cancelled by a load: the check is "is the map still
     * empty when the timer fires", which costs one no-op timer per character
     * switch and cannot be defeated by a load that starts and then throws.
     * @returns {void}
     * @private
     */
    _armReloadWatchdog() {
        if (typeof setTimeout !== 'function') return;
        clearTimeout(this._reloadWatchdog);
        this._reloadWatchdog = setTimeout(() => {
            this._reloadWatchdog = null;
            if (Object.keys(this.settingsMap).length > 0) return;
            console.warn('[Config] Settings map has stayed empty since it was cleared; reloading it');
            this.loadSettings().catch((error) => {
                console.error('[Config] Watchdog reload of the settings failed:', error);
            });
        }, RELOAD_WATCHDOG_MS);
        // Node (the test runner) counts a pending timer as work keeping the
        // process alive; browsers have no unref and need none.
        this._reloadWatchdog?.unref?.();
    }

    /**
     * Save settings to storage (immediately).
     *
     * A map that was read back for this character is written whole, as it
     * always was. One that was not — the store could not be read, or no
     * character is known yet — is not: that map is schema defaults plus
     * whatever was changed this session, and writing it whole would put the
     * defaults over the user's settings. It goes through the merge-save
     * instead, which keeps each stored entry the session left at its default
     * and refuses when the store still cannot be read.
     * @returns {Promise<void|boolean>} Resolves when the write completes
     */
    saveSettings() {
        if (this.characterSettingsLoaded) return settingsStorage.saveSettings(this.settingsMap);
        return settingsStorage.saveSettingsKeepingStored(this.settingsMap);
    }

    /**
     * Get a setting value.
     * Checkbox settings return their boolean; select/number/color settings return their stored value.
     * @param {string} key - Setting key
     * @param {*} [defaultValue=false] - Value returned when the setting is unknown
     * @returns {*} Setting value
     */
    getSetting(key, defaultValue = false) {
        // A write taken during the reload window is the newest intent for this
        // key and outranks anything the map or the schema says
        if (key in this._pendingValues) return this._pendingValues[key];

        // Check loaded settings first
        const setting = this.settingsMap[key];
        if (setting) {
            if (Object.hasOwn(setting, 'isTrue')) {
                return setting.isTrue ?? defaultValue;
            }
            if (Object.hasOwn(setting, 'value')) {
                return setting.value ?? defaultValue;
            }
        }

        // Fallback: the schema default (fixes a race condition on load).
        //
        // This used to walk every group's settings object on every miss, and a
        // miss is not rare: features read their settings before the character's
        // stored settings have loaded, and a handful of settings have no stored
        // value at all, so the scan ran on hot paths. SCHEMA_DEFAULTS flattens
        // the same lookup to one map read.
        if (Object.hasOwn(SCHEMA_DEFAULTS, key)) {
            return SCHEMA_DEFAULTS[key] ?? defaultValue;
        }

        // Ultimate fallback
        return defaultValue;
    }

    /**
     * Get the display label for a pricing mode key, respecting the naming convention setting.
     * @param {string} mode - Pricing mode key ('conservative', 'hybrid', 'optimistic', 'patientBuy')
     * @returns {string} Display label
     */
    getPricingModeLabel(mode) {
        const useInstant = this.getSetting('profitCalc_pricingNaming');
        const labels = useInstant
            ? {
                  conservative: 'Instant Buy / Instant Sell',
                  hybrid: 'Instant Buy / Patient Sell',
                  optimistic: 'Patient Buy / Patient Sell',
                  patientBuy: 'Patient Buy / Instant Sell',
              }
            : {
                  conservative: 'Buy: Ask / Sell: Bid',
                  hybrid: 'Buy: Ask / Sell: Ask',
                  optimistic: 'Buy: Bid / Sell: Ask',
                  patientBuy: 'Buy: Bid / Sell: Bid',
              };
        return labels[mode] || labels.hybrid;
    }

    /**
     * Get a setting value (for non-boolean settings)
     * @param {string} key - Setting key
     * @param {*} defaultValue - Default value if key doesn't exist
     * @returns {*} Setting value
     */
    /**
     * The setting IDs the previous build saved — see settingsStorage.
     * Exposed here because config already crosses the bundle boundary.
     * @returns {Promise<Array<string>|null>}
     */
    async storedSettingIds() {
        return settingsStorage.storedSettingIds();
    }

    getSettingValue(key, defaultValue = null) {
        if (key in this._pendingValues) return this._pendingValues[key];

        const setting = this.settingsMap[key];
        if (!setting) {
            return defaultValue;
        }
        // Handle both boolean (isTrue) and value-based settings
        if (setting.hasOwnProperty('value')) {
            let value = setting.value;

            // Parse JSON strings for template-type settings
            if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
                try {
                    value = JSON.parse(value);
                } catch (e) {
                    console.warn(`[Config] Failed to parse JSON for setting '${key}':`, e);
                    // Return as-is if parsing fails
                }
            }

            return value;
        } else if (setting.hasOwnProperty('isTrue')) {
            return setting.isTrue;
        }
        return defaultValue;
    }

    /**
     * Write a value into the field the setting actually uses, and leave no other.
     *
     * A checkbox lives in `isTrue`; everything else lives in `value`. Writing the
     * wrong one does not throw and does not even look wrong at first, because
     * `getSettingValue` prefers `value` when it is present: the entry ends up
     * holding both, the freshly written `value` answers every read this session,
     * and the stale `isTrue` answers every read after the next reload, when the
     * entry is rebuilt from the schema shape and the stray field is gone. That is
     * the shape of the Lab Sim "Uncapped" box that could not be unticked -- it
     * unticked, saved `{isTrue: true, value: false}`, and came back ticked.
     *
     * So the other field is deleted rather than left: an entry carrying two
     * answers is one reload away from picking the wrong one.
     * @param {Object} setting - Entry from `settingsMap`
     * @param {*} value - The value to store
     * @private
     */
    _writeSettingField(setting, value) {
        const usesIsTrue = Object.hasOwn(setting, 'isTrue')
            ? true
            : Object.hasOwn(setting, 'value')
              ? false
              : typeof value === 'boolean';
        if (usesIsTrue) {
            setting.isTrue = value;
            delete setting.value;
        } else {
            setting.value = value;
            delete setting.isTrue;
        }
    }

    /**
     * Set a setting value (auto-saves)
     * Writes to the field the setting actually uses: isTrue for checkboxes, value otherwise.
     * @param {string} key - Setting key
     * @param {*} value - Setting value
     */
    setSetting(key, value) {
        if (this._deferWriteDuringReload('setSetting', key, value)) return;
        const setting = this.settingsMap[key];
        if (setting) {
            this._writeSettingField(setting, value);
            this.saveSettings();

            // Re-apply colors if color setting changed
            if (key === 'useOrangeAsMainColor') {
                this.applyColorSettings();
            }

            // Trigger registered callbacks for this setting
            this._notifySettingChange(key, value);
        }
    }

    /**
     * Set a setting value (for non-boolean settings, auto-saves)
     * @param {string} key - Setting key
     * @param {*} value - Setting value
     */
    setSettingValue(key, value) {
        if (this._deferWriteDuringReload('setSettingValue', key, value)) return;
        if (this.settingsMap[key]) {
            this._writeSettingField(this.settingsMap[key], value);
            this.saveSettings();

            // Re-apply color settings if this is a color setting
            if (key.startsWith('color_')) {
                this.applyColorSettings();
            }

            // Trigger registered callbacks for this setting
            this._notifySettingChange(key, value);
        }
    }

    /**
     * Hold a write made while the settings map is empty.
     *
     * The map is empty only between `clearSettingsCache()` and the
     * `loadSettings()` that refills it — the character-switch window. Both
     * setters key off `settingsMap[key]`, so a write there used to fall out of
     * its `if` and vanish: nothing saved, no change callback, and a settings
     * panel left showing a state that was never recorded. Queued here instead
     * and replayed by `_flushPendingWrites()` at the end of the load, where the
     * entry exists and the normal save-and-notify path runs.
     *
     * Emptiness, not a missing key, is the test: a key the map genuinely does
     * not have (a typo, a setting dropped from the schema) must keep falling
     * through as before rather than queueing for a load that will never claim it.
     * @param {string} method - Setter to replay: 'setSetting' or 'setSettingValue'
     * @param {string} key - Setting key
     * @param {*} value - Value written
     * @returns {boolean} Whether the write was queued instead of applied
     * @private
     */
    _deferWriteDuringReload(method, key, value) {
        if (Object.keys(this.settingsMap).length > 0) return false;
        this._pendingWrites = this._pendingWrites.filter((write) => write.key !== key);
        // Stamped with whoever the write was made for. The reload window this
        // queue exists for is normally one character's own — but
        // `clearSettingsCache()` fires on `character_switching`, so the window
        // routinely spans a switch, and the load that drains the queue is then
        // the ARRIVING character's. Unstamped, a toggle flipped on the way out
        // of one character was replayed into the other's map and saved under
        // their key: a setting they never touched, changed for them, live.
        this._pendingWrites.push({ method, key, value, characterId: dataManager.getCurrentCharacterId() ?? null });
        // Queued for storage, but answered now. The read side never deferred:
        // with the map empty, getSetting answers every key from SCHEMA_DEFAULTS,
        // so a queued write left the reader on the shipped default while the
        // writer believed the value had changed — two switches on the Watchlist
        // dots saying "off" over a renderer still reading `true`, neither switch
        // able to move it. The window is meant to be short, but nothing forces
        // the load that closes it (settings-ui's destroy() clears the cache on
        // its own; a character switch that never settles leaves it cleared), so
        // read and write have to agree for as long as it lasts.
        this._pendingValues[key] = value;
        this._notifySettingChange(key, value);
        return true;
    }

    /**
     * Apply the writes held during the reload window, now that the map is back.
     *
     * Taken and cleared before replaying, so a setter that queues again (the
     * map is populated by now, so it should not) cannot loop.
     *
     * A key the refilled map has no entry for cannot be replayed: both setters
     * key off `settingsMap[key]` and fall out of their `if`. That is the right
     * outcome for a key the schema no longer has, but it is a write being
     * dropped after `getSetting` has been answering it since it was queued — so
     * it says so rather than going quiet, which is the whole failure mode the
     * queue exists to end.
     *
     * A sync pull's restore latch is the other way a replay cannot land. The
     * latch refuses every write to the settings store until the page reloads,
     * precisely so nothing from before the restore is put back on top of it —
     * and a write queued during the reload window is from before it. Replaying
     * it anyway changed the map, fired the change callbacks and then had the
     * save refused down in storage, leaving the running page showing a value
     * that was not stored and will not survive the reload. It is dropped here,
     * by name, instead.
     * @returns {void}
     * @private
     */
    _flushPendingWrites() {
        if (!this._pendingWrites.length) return;
        const pending = this._pendingWrites;
        this._pendingWrites = [];
        this._pendingValues = Object.create(null);
        const current = dataManager.getCurrentCharacterId() ?? null;
        const latched = storage.isRestorePending?.('settings') === true;
        for (const { method, key, value, characterId } of pending) {
            try {
                if (latched) {
                    console.warn(
                        `[Config] Held write of '${key}' dropped: a restore replaced the settings store and the ` +
                            'page has not reloaded yet. Reload and set it again.'
                    );
                    continue;
                }
                if (characterId !== null && characterId !== current) {
                    console.warn(
                        `[Config] Held write of '${key}' dropped: it was made on another character, ` +
                            'and replaying it here would change a setting this character never touched'
                    );
                    continue;
                }
                if (!this.settingsMap[key]) {
                    console.warn(
                        `[Config] Held write of '${key}' cannot be applied: the loaded settings have no such key`
                    );
                }
                this[method](key, value);
            } catch (error) {
                console.error(`[Config] Deferred write of '${key}' failed:`, error);
            }
        }
    }

    /**
     * Hand a setting's new value to everyone watching that key.
     *
     * Each listener is isolated. The loop this replaces was unguarded, so one
     * feature's listener throwing took out every listener registered behind it for
     * that key, and the throw escaped `setSetting` into whichever toggle handler
     * made the change — which then did not finish either. Worst on the
     * `loadSettings` path, where the fan-out is the character-switch resync and a
     * single throw stopped the resync for every key after it. The two dispatch
     * sites in core that fan out to many subscribers (`domObserver`,
     * `webSocketHook`) already isolate each one; so does `settingsLoadedCallbacks`
     * a few lines above the first caller.
     * @param {string} key - Setting key that changed
     * @param {*} value - Its new value
     * @returns {void}
     * @private
     */
    _notifySettingChange(key, value) {
        const callbacks = this.settingChangeCallbacks[key];
        if (!callbacks) return;
        for (const cb of callbacks) {
            try {
                cb(value);
            } catch (error) {
                console.error(`[Config] Setting-change listener for '${key}' failed:`, error);
            }
        }
    }

    /**
     * Register a callback to be called when a specific setting changes.
     * Multiple callbacks per key are supported.
     *
     * Returns its own unregister function, like every other subscribe in core. A
     * feature that tears down and comes back — which is every feature, on every
     * character switch — otherwise has to remember both the key and the exact
     * callback reference to call `offSettingChange` with, and a caller that
     * assumed this shape (custom-tabs-ui pushes the return value onto its
     * teardown list, where `undefined` is silently skipped) accumulated a fresh
     * pair of listeners per switch, each firing into a torn-down panel.
     * @param {string} key - Setting key to watch
     * @param {Function} callback - Callback function to call when setting changes
     * @returns {Function} Unregister function; safe to call more than once
     */
    onSettingChange(key, callback) {
        if (!this.settingChangeCallbacks[key]) {
            this.settingChangeCallbacks[key] = [];
        }
        this.settingChangeCallbacks[key].push(callback);
        return () => this.offSettingChange(key, callback);
    }

    /**
     * Unregister a specific callback for a setting change
     * @param {string} key - Setting key to stop watching
     * @param {Function} callback - The exact callback reference to remove
     */
    offSettingChange(key, callback) {
        if (this.settingChangeCallbacks[key]) {
            this.settingChangeCallbacks[key] = this.settingChangeCallbacks[key].filter((cb) => cb !== callback);
        }
    }

    /**
     * Register a callback fired every time loadSettings() repopulates the map —
     * including a character switch, where per-key change callbacks are skipped
     * because the previous map was empty. For persistent features that never
     * re-initialize and so need to resync their UI to the new character's values.
     * @param {Function} callback - Called with no arguments after settings load
     * @returns {Function} Unregister function; safe to call more than once
     */
    onSettingsLoaded(callback) {
        this.settingsLoadedCallbacks.push(callback);
        return () => this.offSettingsLoaded(callback);
    }

    /**
     * Unregister a settings-loaded callback.
     * @param {Function} callback - The exact callback reference to remove
     */
    offSettingsLoaded(callback) {
        this.settingsLoadedCallbacks = this.settingsLoadedCallbacks.filter((cb) => cb !== callback);
    }

    /**
     * Toggle a setting (auto-saves)
     * @param {string} key - Setting key
     * @returns {boolean} New value
     */
    toggleSetting(key) {
        const newValue = !this.getSetting(key);
        this.setSetting(key, newValue);
        return newValue;
    }

    /**
     * Get all settings as an array (useful for UI)
     * @returns {Array} Array of setting objects
     */
    getAllSettings() {
        return Object.values(this.settingsMap);
    }

    /**
     * Reset all settings to defaults
     */
    async resetToDefaults() {
        this.settingsMap = settingsStorage.buildDefaults();
        await settingsStorage.saveSettings(this.settingsMap);
        this.applyColorSettings();
    }

    /**
     * Sync current settings to all other characters
     * @returns {Promise<{success: boolean, count: number, error?: string}>} Result object
     */
    async syncSettingsToAllCharacters(targetIds) {
        try {
            const characterId = dataManager.getCurrentCharacterId();
            if (!characterId) {
                return { success: false, count: 0, error: 'No character ID available' };
            }
            settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName());
            const syncedCount = await settingsStorage.syncSettingsToAllCharacters(this.settingsMap, targetIds);
            return { success: true, count: syncedCount };
        } catch (error) {
            console.error('[Config] Failed to sync settings:', error);
            return { success: false, count: 0, error: error.message };
        }
    }

    /**
     * Copy another character's settings onto the current one and apply them live.
     * @param {string} sourceId - The character to copy from
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async copySettingsFromCharacter(sourceId) {
        try {
            const characterId = dataManager.getCurrentCharacterId();
            if (!characterId) {
                return { success: false, error: 'No character ID available' };
            }
            settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName());
            const copied = await settingsStorage.copySettingsFromCharacter(sourceId);
            if (copied) {
                await this.loadSettings();
                this.applyColorSettings();
            }
            return { success: copied };
        } catch (error) {
            console.error('[Config] Failed to copy settings from character:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * The other characters that have settings worth copying from.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async charactersWithSettings() {
        try {
            return await settingsStorage.charactersWithSettings();
        } catch (error) {
            console.error('[Config] Failed to list characters with settings:', error);
            return [];
        }
    }

    /**
     * Get list of known characters as [{id, name}] objects.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getKnownCharacters() {
        try {
            return await settingsStorage.getKnownCharacters();
        } catch (error) {
            console.error('[Config] Failed to get known characters:', error);
            return [];
        }
    }

    /**
     * Get number of known characters (including current)
     * @returns {Promise<number>} Number of characters
     */
    async getKnownCharacterCount() {
        try {
            const knownCharacters = await settingsStorage.getKnownCharacters();
            return knownCharacters.length;
        } catch (error) {
            console.error('[Config] Failed to get character count:', error);
            return 0;
        }
    }

    /**
     * Apply color settings to color constants
     */
    applyColorSettings() {
        // Apply extended color palette from settings
        this.COLOR_PROFIT = this.getSettingValue('color_profit', '#047857');
        this.COLOR_LOSS = this.getSettingValue('color_loss', '#f87171');
        this.COLOR_WARNING = this.getSettingValue('color_warning', '#ffa500');
        this.COLOR_INFO = this.getSettingValue('color_info', '#60a5fa');
        this.COLOR_ESSENCE = this.getSettingValue('color_essence', '#c084fc');
        this.COLOR_TOOLTIP_PROFIT = this.getSettingValue('color_tooltip_profit', '#047857');
        this.COLOR_TOOLTIP_LOSS = this.getSettingValue('color_tooltip_loss', '#dc2626');
        this.COLOR_TOOLTIP_INFO = this.getSettingValue('color_tooltip_info', '#2563eb');
        this.COLOR_TOOLTIP_WARNING = this.getSettingValue('color_tooltip_warning', '#ea580c');
        this.COLOR_TEXT_PRIMARY = this.getSettingValue('color_text_primary', '#ffffff');
        this.COLOR_TEXT_SECONDARY = this.getSettingValue('color_text_secondary', '#888888');
        this.COLOR_BORDER = this.getSettingValue('color_border', '#444444');
        this.COLOR_GOLD = this.getSettingValue('color_gold', '#ffa500');
        this.COLOR_MIRROR = this.getSettingValue('color_mirror', '#ffd700');
        this.COLOR_LISTING_PRICE_1M = this.getSettingValue('color_listing_price_1m', '#ffd700');
        this.COLOR_LISTING_PRICE_100K = this.getSettingValue('color_listing_price_100k', '#22c55e');
        this.COLOR_LISTING_PRICE_10K = this.getSettingValue('color_listing_price_10k', '#ffffff');
        this.COLOR_LISTING_PRICE_LOW = this.getSettingValue('color_listing_price_low', '#888888');
        this.COLOR_ACCENT = this.getSettingValue('color_accent', '#22c55e');
        this.COLOR_REMAINING_XP = this.getSettingValue('color_remaining_xp', '#FFFFFF');
        this.COLOR_XP_RATE = this.getSettingValue('color_xp_rate', '#ffffff');
        this.COLOR_HOURS_TO_LEVEL = this.getSettingValue('color_hours_to_level', '#ffffff');
        this.COLOR_INV_COUNT = this.getSettingValue('color_inv_count', '#ffffff');
        this.COLOR_INVBADGE_ASK = this.getSettingValue('color_invBadge_ask', '#047857');
        this.COLOR_INVBADGE_BID = this.getSettingValue('color_invBadge_bid', '#60a5fa');
        this.COLOR_TRANSMUTE = this.getSettingValue('color_transmute', '#ffffff');

        // Set legacy SCRIPT_COLOR_MAIN to accent color
        this.SCRIPT_COLOR_MAIN = this.COLOR_ACCENT;
        this.SCRIPT_COLOR_TOOLTIP = this.COLOR_ACCENT; // Keep tooltip same as main
    }

    /**
     * Check if a feature is enabled
     * Uses legacy settingKey if available, otherwise uses feature.enabled
     * @param {string} featureKey - Feature key (e.g., 'tooltipPrices')
     * @returns {boolean} Whether feature is enabled
     */
    isFeatureEnabled(featureKey) {
        const feature = this.features?.[featureKey];
        if (!feature) {
            return true; // Default to enabled if not found
        }

        // Check legacy setting first (for backward compatibility)
        if (feature.settingKey && this.settingsMap[feature.settingKey]) {
            return this.settingsMap[feature.settingKey].isTrue ?? true;
        }

        // Otherwise use feature.enabled
        return feature.enabled ?? true;
    }

    /**
     * Enable or disable a feature
     * @param {string} featureKey - Feature key
     * @param {boolean} enabled - Enable state
     */
    async setFeatureEnabled(featureKey, enabled) {
        const feature = this.features?.[featureKey];
        if (!feature) {
            console.warn(`Feature '${featureKey}' not found`);
            return;
        }

        // Update legacy setting if it exists
        if (feature.settingKey && this.settingsMap[feature.settingKey]) {
            this.settingsMap[feature.settingKey].isTrue = enabled;
        }

        // Update feature registry
        feature.enabled = enabled;

        await this.saveSettings();
    }

    /**
     * Toggle a feature
     * @param {string} featureKey - Feature key
     * @returns {boolean} New enabled state
     */
    async toggleFeature(featureKey) {
        const current = this.isFeatureEnabled(featureKey);
        await this.setFeatureEnabled(featureKey, !current);
        return !current;
    }

    /**
     * Get all features grouped by category
     * @returns {Object} Features grouped by category
     */
    getFeaturesByCategory() {
        const grouped = {};

        for (const [key, feature] of Object.entries(this.features)) {
            const category = feature.category || 'Other';
            if (!grouped[category]) {
                grouped[category] = [];
            }
            grouped[category].push({
                key,
                name: feature.name,
                description: feature.description,
                enabled: this.isFeatureEnabled(key),
            });
        }

        return grouped;
    }

    /**
     * Get all feature keys
     * @returns {string[]} Array of feature keys
     */
    getFeatureKeys() {
        return Object.keys(this.features || {});
    }

    /**
     * Get feature info
     * @param {string} featureKey - Feature key
     * @returns {Object|null} Feature info with current enabled state
     */
    getFeatureInfo(featureKey) {
        const feature = this.features?.[featureKey];
        if (!feature) {
            return null;
        }

        return {
            key: featureKey,
            name: feature.name,
            category: feature.category,
            description: feature.description,
            enabled: this.isFeatureEnabled(featureKey),
        };
    }
}

const config = new Config();

export default config;
