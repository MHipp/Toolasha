/**
 * Foundation Utils Library
 * All utility modules
 *
 * Exports to: window.Toolasha.Utils
 */

// All utils
import * as formatters from '../utils/formatters.js';
import * as efficiency from '../utils/efficiency.js';
import * as profitHelpers from '../utils/profit-helpers.js';
import * as profitConstants from '../utils/profit-constants.js';
import * as serverGate from '../utils/server-gate.js';
import * as scriptVersion from '../utils/script-version.js';
import * as dom from '../utils/dom.js';
import * as mobile from '../utils/mobile.js';
import * as visualViewport from '../utils/visual-viewport.js';
import * as domObserverHelpers from '../utils/dom-observer-helpers.js';
import * as timerRegistry from '../utils/timer-registry.js';
import * as bonusRevenueCalculator from '../utils/bonus-revenue-calculator.js';
import * as enhancementMultipliers from '../utils/enhancement-multipliers.js';
import * as experienceParser from '../utils/experience-parser.js';
import * as marketListings from '../utils/market-listings.js';
import * as actionCalculator from '../utils/action-calculator.js';
import * as actionPanelHelper from '../utils/action-panel-helper.js';
import * as teaParser from '../utils/tea-parser.js';
import * as buffParser from '../utils/buff-parser.js';
import * as selectors from '../utils/selectors.js';
import * as houseEfficiency from '../utils/house-efficiency.js';
import * as communityBuffs from '../utils/community-buffs.js';
import * as experienceCalculator from '../utils/experience-calculator.js';
import * as marketData from '../utils/market-data.js';
import * as marketValues from '../utils/market-values.js';
import * as abilityCalc from '../utils/ability-cost-calculator.js';
import * as equipmentParser from '../utils/equipment-parser.js';
import * as uiComponents from '../utils/ui-components.js';
import * as enhancementConfig from '../utils/enhancement-config.js';
import * as enhancementGearDetector from '../utils/enhancement-gear-detector.js';
import * as reactInput from '../utils/react-input.js';
import * as materialCalculator from '../utils/material-calculator.js';
import * as tokenValuation from '../utils/token-valuation.js';
import * as pricingHelper from '../utils/pricing-helper.js';
import * as cleanupRegistry from '../utils/cleanup-registry.js';
// Owned here so the ui bundle's Settings writes and the utils bundle's price
// reads share one overridesCache (otherwise overrides don't apply until reload)
import * as customPriceOverrides from '../features/settings/custom-price-overrides.js';
import * as houseCostCalculator from '../utils/house-cost-calculator.js';
import * as enhancementCalculator from '../utils/enhancement-calculator.js';
import * as enhancementPricing from '../utils/enhancement-pricing.js';
import * as enhancementProtectSweep from '../utils/enhancement-protect-sweep.js';
import * as commandRegistry from '../utils/command-registry.js';
import * as overlayRows from '../utils/overlay-rows.js';
import * as overlayFlow from '../utils/overlay-flow.js';
import * as overlayFormat from '../utils/overlay-format.js';
import * as orderBook from '../utils/order-book.js';
import * as combatLevel from '../utils/combat-level.js';
import * as opanelConfig from '../utils/opanel-config.js';
import * as skillProgress from '../utils/skill-progress.js';
import * as skillHistory from '../utils/skill-history.js';
import * as abilityBooks from '../utils/ability-books.js';
import * as damageAttribution from '../utils/damage-attribution.js';
import * as panelGeometry from '../utils/panel-geometry.js';
import * as choiceDialog from '../utils/choice-dialog.js';
import * as simplePanel from '../utils/simple-panel.js';
import * as panelEscape from '../utils/panel-escape.js';
import * as consumableTarget from '../utils/consumable-target.js';
import * as dropLuck from '../utils/drop-luck.js';
import * as complexFft from '../utils/complex-fft.js';
import * as combatDropModel from '../utils/combat-drop-model.js';
import * as spawnExpectation from '../utils/spawn-expectation.js';
import * as chestTally from '../utils/chest-tally.js';
import * as floatingPanel from '../utils/floating-panel.js';
import * as floatingWidget from '../utils/floating-widget.js';
import * as workerPool from '../utils/worker-pool.js';
import * as evWorkerManager from '../utils/ev-worker-manager.js';
import * as enhancementWorkerManager from '../utils/enhancement-worker-manager.js';
import * as networthWorkerManager from '../utils/networth-worker-manager.js';
import * as panelZIndex from '../utils/panel-z-index.js';
// performance-monitor is deliberately absent: the initialized copy lives in the
// core bundle (which loads first) and is shared as Toolasha.Core.performanceMonitor.
import * as gameLookups from '../utils/game-lookups.js';
import * as productionIndex from '../utils/production-index.js';
import * as itemNavigation from '../utils/item-navigation.js';
import * as marketplaceTabs from '../utils/marketplace-tabs.js';
import * as marketplaceAutofill from '../utils/marketplace-autofill.js';
import * as shoppingList from '../utils/shopping-list.js';
import * as scrollBuffValues from '../utils/scroll-buff-values.js';
import * as toast from '../utils/toast.js';
// The display-side market-volume cap, shared so the actions and sim bundles
// apply the same bound (see utils/liquidity-cap.js). Needs a matching
// utilsExternalGlobals entry in rollup.config.js to be deduplicated.
import * as liquidityCap from '../utils/liquidity-cap.js';
// The calibration badges beside the forecasts, shared so the actions and sim
// bundles read one cached ledger (see utils/calibration-badge.js).
import * as calibrationBadge from '../utils/calibration-badge.js';
// The buy-versus-craft costing for dungeon keys, shared so the ROI board
// (combat) and the readiness card (ui) quote one figure for the same key.
import * as keyCost from '../utils/key-cost.js';
// Everything below was surfaced by scripts/check-bundle-sharing.mjs: reachable
// from two or more production bundles, so it must be exported here (and mapped
// in utilsExternalGlobals) or every bundle silently carries its own copy.
import * as actionContext from '../utils/action-context.js';
import * as adoptionConsent from '../utils/adoption-consent.js';
import * as alchemyFees from '../utils/alchemy-fees.js';
import * as allZonesSnapshot from '../utils/all-zones-snapshot.js';
// Default import on purpose: every consumer default-imports this module, and a
// default import of an external resolves to the global itself — so the global
// must be the default export, not the module namespace.
import assetManifest from '../utils/asset-manifest.js';
import * as backgroundWork from '../utils/background-work.js';
import * as battlePanelMonsters from '../utils/battle-panel-monsters.js';
import * as characterKey from '../utils/character-key.js';
import * as chestImport from '../utils/chest-import.js';
import * as chunkedHistory from '../utils/chunked-history.js';
import * as dailyCheckpoints from '../utils/daily-checkpoints.js';
import * as classWeapon from '../utils/class-weapon.js';
import * as damageBoard from '../utils/damage-board.js';
import * as persistedRecord from '../utils/persisted-record.js';
import * as syncMergeRegistry from '../utils/sync-merge-registry.js';
import * as reactClick from '../utils/react-click.js';
import * as consumableForecast from '../utils/consumable-forecast.js';
import * as csvExport from '../utils/csv-export.js';
import * as deferredLoad from '../utils/deferred-load.js';
import * as dropSources from '../utils/drop-sources.js';
import * as dungeonKeyForecast from '../utils/dungeon-key-forecast.js';
import * as dungeonKeys from '../utils/dungeon-keys.js';
import * as dungeonLevelGap from '../utils/dungeon-level-gap.js';
import * as equipmentSavings from '../utils/equipment-savings.js';
import * as gameServer from '../utils/game-server.js';
import * as testerShop from '../utils/tester-shop.js';
import * as bestiary from '../utils/bestiary.js';
import * as gameText from '../utils/game-text.js';
import * as guildCreditPricing from '../utils/guild-credit-pricing.js';
import * as itemIcon from '../utils/item-icon.js';
import * as keyLedger from '../utils/key-ledger.js';
import * as numberParser from '../utils/number-parser.js';
import * as partyLint from '../utils/party-lint.js';
import * as profileCommand from '../utils/profile-command.js';
import * as progressEta from '../utils/progress-eta.js';
// Risk of Ruin: the panel is in the ui bundle and market-depth-cap.js (market) reads its last
// result, so the engine, the worker-pool manager and the three adapters are reachable from two
// bundles. The worker manager owns the pool singleton — one copy, or two pools spin up.
import * as riskOfRuinEngine from '../utils/risk-of-ruin-engine.js';
import * as riskOfRuinWorkerManager from '../utils/risk-of-ruin-worker-manager.js';
import * as optimalBankrollShare from '../utils/optimal-bankroll-share.js';
import * as riskOfRuinAlchemyAdapter from '../utils/risk-of-ruin-adapters/alchemy-adapter.js';
import * as riskOfRuinDungeonChestAdapter from '../utils/risk-of-ruin-adapters/dungeon-chest-adapter.js';
import * as riskOfRuinEnhancementAdapter from '../utils/risk-of-ruin-adapters/enhancement-adapter.js';
import * as roomSkills from '../utils/room-skills.js';
import * as tableColumns from '../utils/table-columns.js';
import * as watchlist from '../utils/watchlist.js';
import * as bundleBridge from '../utils/bundle-bridge.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Utils = {
    formatters,
    efficiency,
    communityBuffs,
    profitHelpers,
    profitConstants,
    serverGate,
    scriptVersion,
    dom,
    mobile,
    visualViewport,
    domObserverHelpers,
    timerRegistry,
    bonusRevenueCalculator,
    enhancementMultipliers,
    experienceParser,
    marketListings,
    actionCalculator,
    actionPanelHelper,
    teaParser,
    buffParser,
    selectors,
    houseEfficiency,
    experienceCalculator,
    marketData,
    marketValues,
    abilityCalc,
    equipmentParser,
    uiComponents,
    enhancementConfig,
    enhancementGearDetector,
    reactInput,
    materialCalculator,
    tokenValuation,
    pricingHelper,
    cleanupRegistry,
    customPriceOverrides,
    houseCostCalculator,
    enhancementCalculator,
    enhancementPricing,
    enhancementProtectSweep,
    commandRegistry,
    overlayRows,
    overlayFlow,
    overlayFormat,
    orderBook,
    combatLevel,
    opanelConfig,
    skillProgress,
    skillHistory,
    abilityBooks,
    damageAttribution,
    panelGeometry,
    choiceDialog,
    simplePanel,
    panelEscape,
    consumableTarget,
    dropLuck,
    complexFft,
    combatDropModel,
    spawnExpectation,
    chestTally,
    floatingPanel,
    floatingWidget,
    workerPool,
    evWorkerManager,
    enhancementWorkerManager,
    networthWorkerManager,
    panelZIndex,
    gameLookups,
    productionIndex,
    itemNavigation,
    marketplaceTabs,
    marketplaceAutofill,
    shoppingList,
    scrollBuffValues,
    toast,
    liquidityCap,
    calibrationBadge,
    keyCost,
    actionContext,
    adoptionConsent,
    alchemyFees,
    allZonesSnapshot,
    assetManifest,
    backgroundWork,
    battlePanelMonsters,
    characterKey,
    chestImport,
    chunkedHistory,
    dailyCheckpoints,
    classWeapon,
    damageBoard,
    persistedRecord,
    syncMergeRegistry,
    reactClick,
    consumableForecast,
    csvExport,
    deferredLoad,
    dropSources,
    dungeonKeyForecast,
    dungeonKeys,
    dungeonLevelGap,
    equipmentSavings,
    gameServer,
    testerShop,
    bestiary,
    gameText,
    guildCreditPricing,
    itemIcon,
    keyLedger,
    numberParser,
    partyLint,
    profileCommand,
    progressEta,
    optimalBankrollShare,
    riskOfRuinAlchemyAdapter,
    riskOfRuinDungeonChestAdapter,
    riskOfRuinEngine,
    riskOfRuinEnhancementAdapter,
    riskOfRuinWorkerManager,
    roomSkills,
    tableColumns,
    watchlist,
    bundleBridge,
};

console.log('[Toolasha] Utils library loaded');
