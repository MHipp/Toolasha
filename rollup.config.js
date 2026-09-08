import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { rollup } from 'rollup';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, normalize } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the userscript headers
const userscriptHeader = readFileSync(join(__dirname, 'userscript-header.txt'), 'utf-8');
const libraryHeaderCore = readFileSync(join(__dirname, 'library-headers/core.txt'), 'utf-8');
const libraryHeaderUtils = readFileSync(join(__dirname, 'library-headers/utils.txt'), 'utf-8');
const libraryHeaderMarket = readFileSync(join(__dirname, 'library-headers/market.txt'), 'utf-8');
const libraryHeaderActions = readFileSync(join(__dirname, 'library-headers/actions.txt'), 'utf-8');
const libraryHeaderSim = readFileSync(join(__dirname, 'library-headers/sim.txt'), 'utf-8');
const libraryHeaderCombat = readFileSync(join(__dirname, 'library-headers/combat.txt'), 'utf-8');
const libraryHeaderUI = readFileSync(join(__dirname, 'library-headers/ui.txt'), 'utf-8');
const entrypointHeader = readFileSync(join(__dirname, 'library-headers/entrypoint.txt'), 'utf-8');

const normalizeModuleId = (id) => (id ? normalize(id.split('?')[0]) : id);

const coreExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/core/storage.js')), 'Toolasha.Core.storage'],
    [normalize(join(__dirname, 'src/core/config.js')), 'Toolasha.Core.config'],
    [normalize(join(__dirname, 'src/core/websocket.js')), 'Toolasha.Core.webSocketHook'],
    [normalize(join(__dirname, 'src/core/dom-observer.js')), 'Toolasha.Core.domObserver'],
    [normalize(join(__dirname, 'src/core/tooltip-observer.js')), 'Toolasha.Core.tooltipObserver'],
    [normalize(join(__dirname, 'src/core/data-manager.js')), 'Toolasha.Core.dataManager'],
    // One connection state machine: it registers its own socket open/close/error
    // listeners at construction, so a second copy is a second set of listeners
    // and a second `state` — and marketAPI (core) gating fetches on
    // isConnected() must agree with what Net Worth's pause logic (market) sees.
    [normalize(join(__dirname, 'src/core/connection-state.js')), 'Toolasha.Core.connectionState'],
    [normalize(join(__dirname, 'src/core/feature-registry.js')), 'Toolasha.Core.featureRegistry'],
    // One ring buffer: the core bundle installs the hooks, the ui bundle's
    // Diagnostics section reads what they caught
    [normalize(join(__dirname, 'src/core/error-log.js')), 'Toolasha.Core.errorLog'],
    [normalize(join(__dirname, 'src/core/settings-storage.js')), 'Toolasha.Core.settingsStorage'],
    [normalize(join(__dirname, 'src/core/settings-schema.js')), 'Toolasha.Core'],
    [normalize(join(__dirname, 'src/core/profile-manager.js')), 'Toolasha.Core.profileManager'],
    [normalize(join(__dirname, 'src/api/marketplace.js')), 'Toolasha.Core.marketAPI'],
    // A utils path, but Core's module: feature-registry and dom-observer feed it,
    // so the initialized copy lives in the core bundle (which loads first and
    // cannot reference Toolasha.Utils.*). Mapping it here points every later
    // bundle at that copy — before this entry each of them default-imported the
    // Utils namespace object and called methods that were not on it.
    [normalize(join(__dirname, 'src/utils/performance-monitor.js')), 'Toolasha.Core.performanceMonitor'],
    // A market path, but the core bundle's marketAPI is what calls show()/hide()
    // on it — with a copy each, the initialized one never showed and the showing
    // one was never initialized (two alert containers, one observer-less).
    [normalize(join(__dirname, 'src/features/market/network-alert.js')), 'Toolasha.Core.networkAlert'],
]);

const utilsExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/utils/formatters.js')), 'Toolasha.Utils.formatters'],
    [normalize(join(__dirname, 'src/utils/liquidity-cap.js')), 'Toolasha.Utils.liquidityCap'],
    // The calibration badges' ledger cache: one read of the ledger and one set
    // of memoised summaries, reached from the actions and sim bundles
    [normalize(join(__dirname, 'src/utils/calibration-badge.js')), 'Toolasha.Utils.calibrationBadge'],
    [normalize(join(__dirname, 'src/utils/class-weapon.js')), 'Toolasha.Utils.classWeapon'],
    // The one ledger of who has claimed what is in the bag. Five features in
    // three bundles read and write it, and a second copy would be a second
    // ledger — each plan invisible to the others, which is the bug the module
    // exists to fix.
    [normalize(join(__dirname, 'src/utils/inventory-reservations.js')), 'Toolasha.Utils.inventoryReservations'],
    // What an entry key costs bought against crafted: the ROI board (combat)
    // ranks dungeons with it and the consumables panel's readiness card (ui)
    // prices its key shortfall with it. One copy so the two cannot quote
    // different costs for the same key, and so its craft memo is shared.
    [normalize(join(__dirname, 'src/utils/key-cost.js')), 'Toolasha.Utils.keyCost'],
    [normalize(join(__dirname, 'src/utils/damage-board.js')), 'Toolasha.Utils.damageBoard'],
    [normalize(join(__dirname, 'src/utils/efficiency.js')), 'Toolasha.Utils.efficiency'],
    [normalize(join(__dirname, 'src/utils/profit-helpers.js')), 'Toolasha.Utils.profitHelpers'],
    [normalize(join(__dirname, 'src/utils/profit-constants.js')), 'Toolasha.Utils.profitConstants'],
    [normalize(join(__dirname, 'src/utils/server-gate.js')), 'Toolasha.Utils.serverGate'],
    [normalize(join(__dirname, 'src/utils/script-version.js')), 'Toolasha.Utils.scriptVersion'],
    [normalize(join(__dirname, 'src/utils/dom.js')), 'Toolasha.Utils.dom'],
    [normalize(join(__dirname, 'src/utils/dom-observer-helpers.js')), 'Toolasha.Utils.domObserverHelpers'],
    [normalize(join(__dirname, 'src/utils/timer-registry.js')), 'Toolasha.Utils.timerRegistry'],
    [normalize(join(__dirname, 'src/utils/bonus-revenue-calculator.js')), 'Toolasha.Utils.bonusRevenueCalculator'],
    [normalize(join(__dirname, 'src/utils/enhancement-multipliers.js')), 'Toolasha.Utils.enhancementMultipliers'],
    [normalize(join(__dirname, 'src/utils/experience-parser.js')), 'Toolasha.Utils.experienceParser'],
    [normalize(join(__dirname, 'src/utils/market-listings.js')), 'Toolasha.Utils.marketListings'],
    [normalize(join(__dirname, 'src/utils/action-calculator.js')), 'Toolasha.Utils.actionCalculator'],
    [normalize(join(__dirname, 'src/utils/action-panel-helper.js')), 'Toolasha.Utils.actionPanelHelper'],
    [normalize(join(__dirname, 'src/utils/tea-parser.js')), 'Toolasha.Utils.teaParser'],
    [normalize(join(__dirname, 'src/utils/buff-parser.js')), 'Toolasha.Utils.buffParser'],
    [normalize(join(__dirname, 'src/utils/selectors.js')), 'Toolasha.Utils.selectors'],
    [normalize(join(__dirname, 'src/utils/house-efficiency.js')), 'Toolasha.Utils.houseEfficiency'],
    [normalize(join(__dirname, 'src/utils/community-buffs.js')), 'Toolasha.Utils.communityBuffs'],
    [normalize(join(__dirname, 'src/utils/experience-calculator.js')), 'Toolasha.Utils.experienceCalculator'],
    [normalize(join(__dirname, 'src/utils/market-data.js')), 'Toolasha.Utils.marketData'],
    [normalize(join(__dirname, 'src/utils/market-values.js')), 'Toolasha.Utils.marketValues'],
    [normalize(join(__dirname, 'src/utils/ability-cost-calculator.js')), 'Toolasha.Utils.abilityCalc'],
    [normalize(join(__dirname, 'src/utils/equipment-parser.js')), 'Toolasha.Utils.equipmentParser'],
    [normalize(join(__dirname, 'src/utils/ui-components.js')), 'Toolasha.Utils.uiComponents'],
    [normalize(join(__dirname, 'src/utils/enhancement-config.js')), 'Toolasha.Utils.enhancementConfig'],
    [normalize(join(__dirname, 'src/utils/enhancement-gear-detector.js')), 'Toolasha.Utils.enhancementGearDetector'],
    [normalize(join(__dirname, 'src/utils/react-input.js')), 'Toolasha.Utils.reactInput'],
    [normalize(join(__dirname, 'src/utils/material-calculator.js')), 'Toolasha.Utils.materialCalculator'],
    [normalize(join(__dirname, 'src/utils/token-valuation.js')), 'Toolasha.Utils.tokenValuation'],
    [normalize(join(__dirname, 'src/utils/pricing-helper.js')), 'Toolasha.Utils.pricingHelper'],
    [normalize(join(__dirname, 'src/utils/cleanup-registry.js')), 'Toolasha.Utils.cleanupRegistry'],
    [normalize(join(__dirname, 'src/utils/house-cost-calculator.js')), 'Toolasha.Utils.houseCostCalculator'],
    [normalize(join(__dirname, 'src/utils/enhancement-calculator.js')), 'Toolasha.Utils.enhancementCalculator'],
    // The one enhancement pricing rule (materials, protection, base item, production
    // cost). Reached from the enhancement feature (utils bundle), the sim's upgrade
    // advisor (combat) and the inventory savings card (market); each used to carry its
    // own drifted copy, which is what this shares away.
    [normalize(join(__dirname, 'src/utils/enhancement-pricing.js')), 'Toolasha.Utils.enhancementPricing'],
    // The one protect-from sweep: the enhancing panel's column (actions) and the
    // savings card's single-run cost (market) are the same walk over the same chain.
    [normalize(join(__dirname, 'src/utils/enhancement-protect-sweep.js')), 'Toolasha.Utils.enhancementProtectSweep'],
    // Not under src/utils, but shared here so Settings' writes (ui bundle) and
    // price reads (market-data/profit-helpers, utils bundle) hit one cache
    [
        normalize(join(__dirname, 'src/features/settings/custom-price-overrides.js')),
        'Toolasha.Utils.customPriceOverrides',
    ],
    // Shared or the overlay's row list is duplicated per bundle and the panel renders nothing
    // Every src/utils module used by more than one bundle is declared here.
    // Anything omitted is silently copied into each bundle that imports it,
    // which is how the combat bundle grew to within 3 KB of its bundle-size ceiling (2.5 MiB in CI — a duplication guard, not a hosting limit).
    [normalize(join(__dirname, 'src/utils/drop-luck.js')), 'Toolasha.Utils.dropLuck'],
    [normalize(join(__dirname, 'src/utils/complex-fft.js')), 'Toolasha.Utils.complexFft'],
    [normalize(join(__dirname, 'src/utils/combat-drop-model.js')), 'Toolasha.Utils.combatDropModel'],
    [normalize(join(__dirname, 'src/utils/spawn-expectation.js')), 'Toolasha.Utils.spawnExpectation'],
    [normalize(join(__dirname, 'src/utils/chest-tally.js')), 'Toolasha.Utils.chestTally'],
    [normalize(join(__dirname, 'src/utils/floating-panel.js')), 'Toolasha.Utils.floatingPanel'],
    // The guided walks' shared control strip: bulk sell (market) and the reroll
    // walk plus the Consumables Buy-all (ui) all draw it
    [normalize(join(__dirname, 'src/utils/floating-widget.js')), 'Toolasha.Utils.floatingWidget'],
    [normalize(join(__dirname, 'src/utils/worker-pool.js')), 'Toolasha.Utils.workerPool'],
    [normalize(join(__dirname, 'src/utils/ev-worker-manager.js')), 'Toolasha.Utils.evWorkerManager'],
    [normalize(join(__dirname, 'src/utils/enhancement-worker-manager.js')), 'Toolasha.Utils.enhancementWorkerManager'],
    [normalize(join(__dirname, 'src/utils/networth-worker-manager.js')), 'Toolasha.Utils.networthWorkerManager'],
    [normalize(join(__dirname, 'src/utils/panel-z-index.js')), 'Toolasha.Utils.panelZIndex'],
    [normalize(join(__dirname, 'src/utils/game-lookups.js')), 'Toolasha.Utils.gameLookups'],
    // One reverse index of outputItem → actions, cached on the action map's
    // identity; reached from market (profit calculator, tooltips) and actions
    // (crafting plan), so a copy each would build and hold the index twice
    [normalize(join(__dirname, 'src/utils/production-index.js')), 'Toolasha.Utils.productionIndex'],
    [normalize(join(__dirname, 'src/utils/item-navigation.js')), 'Toolasha.Utils.itemNavigation'],
    [normalize(join(__dirname, 'src/utils/marketplace-tabs.js')), 'Toolasha.Utils.marketplaceTabs'],
    [normalize(join(__dirname, 'src/utils/marketplace-autofill.js')), 'Toolasha.Utils.marketplaceAutofill'],
    // One marketplace tab bar, so one list watching it. The consumables panel is
    // in the ui bundle and the goal planner is in actions; a copy each meant two
    // `watchTimer`s tearing down each other's tabs for six seconds after an open.
    [normalize(join(__dirname, 'src/utils/shopping-list.js')), 'Toolasha.Utils.shoppingList'],
    [normalize(join(__dirname, 'src/utils/scroll-buff-values.js')), 'Toolasha.Utils.scrollBuffValues'],
    [normalize(join(__dirname, 'src/utils/command-registry.js')), 'Toolasha.Utils.commandRegistry'],
    [normalize(join(__dirname, 'src/utils/overlay-rows.js')), 'Toolasha.Utils.overlayRows'],
    [normalize(join(__dirname, 'src/utils/overlay-flow.js')), 'Toolasha.Utils.overlayFlow'],
    [normalize(join(__dirname, 'src/utils/overlay-format.js')), 'Toolasha.Utils.overlayFormat'],
    [normalize(join(__dirname, 'src/utils/order-book.js')), 'Toolasha.Utils.orderBook'],
    [normalize(join(__dirname, 'src/utils/combat-level.js')), 'Toolasha.Utils.combatLevel'],
    [normalize(join(__dirname, 'src/utils/opanel-config.js')), 'Toolasha.Utils.opanelConfig'],
    [normalize(join(__dirname, 'src/utils/skill-progress.js')), 'Toolasha.Utils.skillProgress'],
    // A factory rather than a singleton, so sharing it changes nothing about the
    // measurements — each caller still gets its own history. It is here because
    // two bundles want it and a second copy is only weight.
    [normalize(join(__dirname, 'src/utils/skill-history.js')), 'Toolasha.Utils.skillHistory'],
    [normalize(join(__dirname, 'src/utils/experience-parser.js')), 'Toolasha.Utils.experienceParser'],
    [normalize(join(__dirname, 'src/utils/ability-books.js')), 'Toolasha.Utils.abilityBooks'],
    [normalize(join(__dirname, 'src/utils/damage-attribution.js')), 'Toolasha.Utils.damageAttribution'],
    // Shared above all for its cache: a private copy per bundle means the overlay
    // and the Treasure panel each hold a stale map of every panel's geometry, and
    // whichever saves last wipes the other's entry
    [normalize(join(__dirname, 'src/utils/panel-geometry.js')), 'Toolasha.Utils.panelGeometry'],
    [normalize(join(__dirname, 'src/utils/choice-dialog.js')), 'Toolasha.Utils.choiceDialog'],
    // One stack for the whole script: a second copy in another bundle would put
    // up a second container, and two overlapping stacks in the same corner is
    // exactly the mess the shared toast replaced
    [normalize(join(__dirname, 'src/utils/toast.js')), 'Toolasha.Utils.toast'],
    [normalize(join(__dirname, 'src/utils/simple-panel.js')), 'Toolasha.Utils.simplePanel'],
    // One Escape stack for the whole script: a copy per bundle would close one
    // panel per bundle on a single keypress instead of the panel in front
    [normalize(join(__dirname, 'src/utils/panel-escape.js')), 'Toolasha.Utils.panelEscape'],
    // Holds the chosen target in memory, and the panel that sets it is in a
    // different bundle from the tile that colours against it. Two copies means
    // the tile never hears about a change and quietly keeps its own answer.
    [normalize(join(__dirname, 'src/utils/consumable-target.js')), 'Toolasha.Utils.consumableTarget'],
    // Everything below was found by scripts/check-bundle-sharing.mjs: each was
    // reachable from two or more production bundles and silently copied into
    // every one of them. The stateful ones were live bugs — adoption-consent's
    // consent cache, character-key's decision cache and equipment-savings'
    // goals record each existed once per bundle, so whichever bundle answered
    // last won. The stateless ones are here for weight: the combat and ui
    // bundles both sit near the bundle-size ceiling.
    [normalize(join(__dirname, 'src/utils/action-context.js')), 'Toolasha.Utils.actionContext'],
    [normalize(join(__dirname, 'src/utils/adoption-consent.js')), 'Toolasha.Utils.adoptionConsent'],
    [normalize(join(__dirname, 'src/utils/alchemy-fees.js')), 'Toolasha.Utils.alchemyFees'],
    [normalize(join(__dirname, 'src/utils/all-zones-snapshot.js')), 'Toolasha.Utils.allZonesSnapshot'],
    [normalize(join(__dirname, 'src/utils/asset-manifest.js')), 'Toolasha.Utils.assetManifest'],
    [normalize(join(__dirname, 'src/utils/background-work.js')), 'Toolasha.Utils.backgroundWork'],
    [normalize(join(__dirname, 'src/utils/battle-panel-monsters.js')), 'Toolasha.Utils.battlePanelMonsters'],
    [normalize(join(__dirname, 'src/utils/character-key.js')), 'Toolasha.Utils.characterKey'],
    [normalize(join(__dirname, 'src/utils/chest-import.js')), 'Toolasha.Utils.chestImport'],
    [normalize(join(__dirname, 'src/utils/chunked-history.js')), 'Toolasha.Utils.chunkedHistory'],
    // The skill checkpoints (ui bundle) and the ability checkpoints (market
    // bundle) both build one of these, and a `ChunkedHistory` registers its
    // sync merges at construction into a registry that must be the one
    // instance — a second copy of this module would register into whichever
    // registry its own bundle happened to import.
    [normalize(join(__dirname, 'src/utils/daily-checkpoints.js')), 'Toolasha.Utils.dailyCheckpoints'],
    [normalize(join(__dirname, 'src/utils/persisted-record.js')), 'Toolasha.Utils.persistedRecord'],
    // Combat clears the records, the consumables panel reads one of them, and
    // the sim bundle pulls it in transitively. Three copies would each hold
    // their own idea of what a Reset cleared.
    [normalize(join(__dirname, 'src/utils/cleared-record.js')), 'Toolasha.Utils.clearedRecord'],
    // The sync feature (ui bundle) asks it; market/guild/combat register into
    // it. One instance, or a pull would find an empty registry
    [normalize(join(__dirname, 'src/utils/sync-merge-registry.js')), 'Toolasha.Utils.syncMergeRegistry'],
    [normalize(join(__dirname, 'src/utils/react-click.js')), 'Toolasha.Utils.reactClick'],
    [normalize(join(__dirname, 'src/utils/consumable-forecast.js')), 'Toolasha.Utils.consumableForecast'],
    [normalize(join(__dirname, 'src/utils/csv-export.js')), 'Toolasha.Utils.csvExport'],
    [normalize(join(__dirname, 'src/utils/deferred-load.js')), 'Toolasha.Utils.deferredLoad'],
    [normalize(join(__dirname, 'src/utils/drop-sources.js')), 'Toolasha.Utils.dropSources'],
    [normalize(join(__dirname, 'src/utils/dungeon-key-forecast.js')), 'Toolasha.Utils.dungeonKeyForecast'],
    [normalize(join(__dirname, 'src/utils/dungeon-keys.js')), 'Toolasha.Utils.dungeonKeys'],
    [normalize(join(__dirname, 'src/utils/dungeon-level-gap.js')), 'Toolasha.Utils.dungeonLevelGap'],
    [normalize(join(__dirname, 'src/utils/equipment-savings.js')), 'Toolasha.Utils.equipmentSavings'],
    [normalize(join(__dirname, 'src/utils/game-server.js')), 'Toolasha.Utils.gameServer'],
    [normalize(join(__dirname, 'src/utils/tester-shop.js')), 'Toolasha.Utils.testerShop'],
    [normalize(join(__dirname, 'src/utils/bestiary.js')), 'Toolasha.Utils.bestiary'],
    [normalize(join(__dirname, 'src/utils/game-text.js')), 'Toolasha.Utils.gameText'],
    [normalize(join(__dirname, 'src/utils/guild-credit-pricing.js')), 'Toolasha.Utils.guildCreditPricing'],
    [normalize(join(__dirname, 'src/utils/item-icon.js')), 'Toolasha.Utils.itemIcon'],
    [normalize(join(__dirname, 'src/utils/key-ledger.js')), 'Toolasha.Utils.keyLedger'],
    [normalize(join(__dirname, 'src/utils/mobile.js')), 'Toolasha.Utils.mobile'],
    [normalize(join(__dirname, 'src/utils/number-parser.js')), 'Toolasha.Utils.numberParser'],
    [normalize(join(__dirname, 'src/utils/party-lint.js')), 'Toolasha.Utils.partyLint'],
    [normalize(join(__dirname, 'src/utils/profile-command.js')), 'Toolasha.Utils.profileCommand'],
    [normalize(join(__dirname, 'src/utils/progress-eta.js')), 'Toolasha.Utils.progressEta'],
    [normalize(join(__dirname, 'src/utils/room-skills.js')), 'Toolasha.Utils.roomSkills'],
    [normalize(join(__dirname, 'src/utils/table-columns.js')), 'Toolasha.Utils.tableColumns'],
    [normalize(join(__dirname, 'src/utils/watchlist.js')), 'Toolasha.Utils.watchlist'],
    // The runtime accessors over window.Toolasha itself (see part C of the
    // shared-state work). One shared copy keeps reach-throughs greppable at
    // runtime; core still carries its own inline copy because it loads first.
    [normalize(join(__dirname, 'src/utils/bundle-bridge.js')), 'Toolasha.Utils.bundleBridge'],
    // Risk of Ruin: the panel lives in ui, and market-depth-cap.js (market) reads the last
    // computed cost-per-action off it, so every module the panel pulls in is reachable from
    // both bundles. The worker manager holds the pool singleton — a second copy would spin up
    // a second set of workers.
    [normalize(join(__dirname, 'src/utils/risk-of-ruin-engine.js')), 'Toolasha.Utils.riskOfRuinEngine'],
    [normalize(join(__dirname, 'src/utils/risk-of-ruin-worker-manager.js')), 'Toolasha.Utils.riskOfRuinWorkerManager'],
    [normalize(join(__dirname, 'src/utils/optimal-bankroll-share.js')), 'Toolasha.Utils.optimalBankrollShare'],
    [
        normalize(join(__dirname, 'src/utils/risk-of-ruin-adapters/alchemy-adapter.js')),
        'Toolasha.Utils.riskOfRuinAlchemyAdapter',
    ],
    [
        normalize(join(__dirname, 'src/utils/risk-of-ruin-adapters/dungeon-chest-adapter.js')),
        'Toolasha.Utils.riskOfRuinDungeonChestAdapter',
    ],
    [
        normalize(join(__dirname, 'src/utils/risk-of-ruin-adapters/enhancement-adapter.js')),
        'Toolasha.Utils.riskOfRuinEnhancementAdapter',
    ],
]);

// The combat simulator engine, which is its own bundle.
// About a megabyte of source reached into by four features across three bundles;
// left inline it was copied into each of them, and both the combat and the UI
// bundle carried the same `Monster` class while sitting a few kilobytes under
// the bundle-size ceiling (2.5 MiB in CI — a duplication guard, not a hosting limit).
const simExternalGlobals = new Map([
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim.js')), 'Toolasha.Sim.combatSim'],
    [normalize(join(__dirname, 'src/features/combat-sim/lab-sim.js')), 'Toolasha.Sim.labSim'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-ui.js')), 'Toolasha.Sim.combatSimUI'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-adapter.js')), 'Toolasha.Sim.combatSimAdapter'],
    [normalize(join(__dirname, 'src/features/combat-sim/combat-sim-runner.js')), 'Toolasha.Sim.combatSimRunner'],
    // The ability tooltip (combat bundle) needs it, and it pulls Player and the
    // adapter behind it — inline that is the whole engine copied into combat.
    [
        normalize(join(__dirname, 'src/features/combat-sim/ability-timing-calculator.js')),
        'Toolasha.Sim.abilityTimingCalculator',
    ],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/wilson.js')), 'Toolasha.Sim.wilson'],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/game-data.js')), 'Toolasha.Sim.gameData'],
    [normalize(join(__dirname, 'src/features/combat-sim/engine/monster.js')), 'Toolasha.Sim.monster'],
]);

// Combat feature modules imported cross-library (by ui)
// Must be external so they reference the shared Combat.* globals instead of bundling duplicates
const combatFeatureExternals = new Map([
    // loadout-snapshot is accessed lazily at runtime via window.Toolasha.Combat.loadoutSnapshot
    // The collector is a stateful singleton fed by the websocket: a second copy in
    // another bundle would sit there receiving nothing, so it is shared rather
    // than duplicated. The calculator comes with it because they are read together.
    [
        normalize(join(__dirname, 'src/features/combat-stats/combat-stats-data-collector.js')),
        'Toolasha.Combat.combatStatsDataCollector',
    ],
    [
        normalize(join(__dirname, 'src/features/combat-stats/combat-stats-calculator.js')),
        'Toolasha.Combat.combatStatsCalculator',
    ],
    // Both are stateful singletons fed by the websocket, so a second copy in
    // another bundle would sit there receiving nothing and report zeroes
    [normalize(join(__dirname, 'src/features/combat/combat-dps.js')), 'Toolasha.Combat.combatDPS'],
    [normalize(join(__dirname, 'src/features/combat/combat-drop-luck.js')), 'Toolasha.Combat.combatDropLuck'],
    [normalize(join(__dirname, 'src/features/combat/damage-tracker.js')), 'Toolasha.Combat.damageTracker'],
    [normalize(join(__dirname, 'src/features/combat/damage-taken-tracker.js')), 'Toolasha.Combat.damageTakenTracker'],
    // The tax toggle's flag lives at module scope: with a ui-bundle copy the
    // toggle flipped one flag while the income calculator read the other, so
    // Tax On/Off did nothing until a reload.
    [normalize(join(__dirname, 'src/features/combat-stats/sales-tax-view.js')), 'Toolasha.Combat.salesTaxView'],
    // Its target-restore cache is per copy; two copies raced each other's
    // load-in-flight guard from the DPS and Sim Accuracy panels.
    [normalize(join(__dirname, 'src/features/combat/combat-record-control.js')), 'Toolasha.Combat.combatRecordControl'],
    // The defaults popup reads and REWRITES the simulator's per-loadout scroll
    // selections; the ui bundle's uninitialized copy showed everything blank
    // and saved that blankness over the real record.
    [normalize(join(__dirname, 'src/features/combat/scroll-simulator-ui.js')), 'Toolasha.Combat.scrollSimulatorUI'],
    // The chat commands (ui bundle) import these five guild roots, which used
    // to drag the ENTIRE guild feature graph into the ui bundle as dead inline
    // copies (~30 modules; the live ones all run in combat, reached via the
    // bridge). Externalizing the roots prunes the whole subtree.
    [normalize(join(__dirname, 'src/features/guild/guild-token-value.js')), 'Toolasha.Combat.guildTokenValue'],
    [normalize(join(__dirname, 'src/features/guild/guild-trial-recorder.js')), 'Toolasha.Combat.guildTrialExport'],
    [normalize(join(__dirname, 'src/features/guild/guild-trials-store.js')), 'Toolasha.Combat.guildTrialStore'],
    [normalize(join(__dirname, 'src/features/guild/guild-xp-tracker.js')), 'Toolasha.Combat.guildXPTracker'],
    [normalize(join(__dirname, 'src/features/guild/guild-trials.js')), 'Toolasha.Combat.guildTrialsModule'],
]);

// Market modules imported cross-library (by combat, actions, ui)
// Must be external so they reference the shared Market.* globals instead of bundling duplicates
const marketExternalGlobals = new Map([
    [
        normalize(join(__dirname, 'src/features/market/expected-value-calculator.js')),
        'Toolasha.Market.expectedValueCalculator',
    ],
    [normalize(join(__dirname, 'src/features/market/profit-calculator.js')), 'Toolasha.Market.profitCalculator'],
    [
        normalize(join(__dirname, 'src/features/market/alchemy-profit-calculator.js')),
        'Toolasha.Market.alchemyProfitCalculator',
    ],
    // Not market features, but they live here because of load order. Both are
    // pure calculators reached by seven modules across the actions, combat and
    // ui bundles, and the market bundle already pulls them in through
    // market-sort and tooltip-prices — so market is the earliest @require that
    // has them, and the only bundle that can own them without a forward
    // reference. Left inline they were copied whole into every bundle that
    // imports them, which is ~29 KB of source each time and the largest single
    // contributor to the ui bundle sitting over its bundle-size ceiling (2.5 MiB in CI — a duplication guard, not a hosting limit).
    // The pooled market history: fetched by the mooket panel, read by the goal
    // planner in the actions bundle to bound a rate by how fast its output sells.
    // The API is a cache in front of a third-party server, so two copies means
    // two caches and twice the requests.
    [
        normalize(join(__dirname, 'src/features/market/mooket/market-history-api.js')),
        'Toolasha.Market.marketHistoryAPI',
    ],
    [
        normalize(join(__dirname, 'src/features/market/mooket/market-history-data.js')),
        'Toolasha.Market.marketHistoryData',
    ],
    [normalize(join(__dirname, 'src/features/actions/gathering-profit.js')), 'Toolasha.Market.gatheringProfit'],
    [normalize(join(__dirname, 'src/features/actions/production-profit.js')), 'Toolasha.Market.productionProfit'],
    // A stateful singleton holding the chest tally, reached by the settings
    // panel's Treasure button (ui bundle). Left inline, the ui bundle carried a
    // second, never-initialized tracker whose module-scope registerRow won the
    // overlay's 'treasure' row — so the tile and the panel it opened were blank
    // while the real ledger sat in the market bundle.
    [normalize(join(__dirname, 'src/features/inventory/treasure-tracker.js')), 'Toolasha.Market.treasureTracker'],
]);

const buildGlobals = (globalsMap) => Object.fromEntries(globalsMap.entries());
const buildExternal = (globalsMap) => (id) => globalsMap.has(normalizeModuleId(id));

// Custom plugin to import CSS as raw strings
/**
 * Embed the current fork-changelog section as a virtual module.
 *
 * The what's-new popup wants to show what changed, and CHANGELOG.md is where
 * that is already written — maintaining a second copy in code would drift by
 * the second release. The first "## Unreleased" section is what a dev build's
 * user is actually receiving, so that is the slice that ships, capped so a
 * long-lived branch cannot balloon the bundle.
 */
function changelogPlugin() {
    const id = 'virtual:fork-changelog';
    return {
        name: 'fork-changelog',
        resolveId(source) {
            return source === id ? `\0${id}` : null;
        },
        load(moduleId) {
            if (moduleId !== `\0${id}`) return null;
            let section = '';
            try {
                const changelog = readFileSync('CHANGELOG.md', 'utf-8');
                const start = changelog.search(/^## Unreleased/m);
                if (start !== -1) {
                    const rest = changelog.slice(start);
                    const end = rest.slice(3).search(/^## /m);
                    section = end === -1 ? rest : rest.slice(0, end + 3);
                }
            } catch {
                section = '';
            }
            return `export default ${JSON.stringify(section.slice(0, 20000))};`;
        },
    };
}

/**
 * Embed the whole newcomer overview as a virtual module.
 *
 * The what's-new popup greets a fresh install — and someone arriving from
 * upstream Toolasha — with an at-a-glance tour of what this fork adds. That copy
 * lives in OVERVIEW.md so it can be edited as prose rather than buried in code;
 * the whole file ships, capped so it cannot balloon the bundle.
 */
function overviewPlugin() {
    const id = 'virtual:fork-overview';
    return {
        name: 'fork-overview',
        resolveId(source) {
            return source === id ? `\0${id}` : null;
        },
        load(moduleId) {
            if (moduleId !== `\0${id}`) return null;
            let text = '';
            try {
                text = readFileSync('OVERVIEW.md', 'utf-8');
            } catch {
                text = '';
            }
            return `export default ${JSON.stringify(text.slice(0, 20000))};`;
        },
    };
}

function cssRawPlugin() {
    const suffix = '?raw';
    return {
        name: 'css-raw',
        resolveId(source, importer) {
            if (source.endsWith(suffix)) {
                // Resolve relative to importer
                if (importer) {
                    const basePath = dirname(importer);
                    const cssPath = join(basePath, source.replace(suffix, ''));
                    return cssPath + suffix; // Keep marker for load phase
                }
            }
            return null;
        },
        load(id) {
            if (id.endsWith(suffix)) {
                const cssPath = id.replace(suffix, '');
                const css = readFileSync(cssPath, 'utf-8');
                return `export default ${JSON.stringify(css)};`;
            }
            return null;
        },
    };
}

/**
 * Custom plugin to bundle JS worker entry points into inline strings.
 * Import with '?worker' suffix: import code from './my-worker.js?worker';
 * The imported value is the bundled worker source as a string.
 */
function workerBundlePlugin() {
    const suffix = '?worker';
    const cache = new Map();
    return {
        name: 'worker-bundle',
        resolveId(source, importer) {
            if (source.endsWith(suffix)) {
                if (importer) {
                    const basePath = dirname(importer);
                    const workerPath = join(basePath, source.replace(suffix, ''));
                    return workerPath + suffix;
                }
            }
            return null;
        },
        async load(id) {
            if (!id.endsWith(suffix)) return null;

            const entryPath = id.replace(suffix, '');

            // Cache to avoid re-bundling on watch rebuilds within same run
            if (cache.has(entryPath)) return cache.get(entryPath);

            // Bundle the worker entry with its own rollup build
            const bundle = await rollup({
                input: entryPath,
                plugins: [resolve({ browser: true, preferBuiltins: false }), commonjs()],
                // Suppress circular dependency warnings from heap-js
                onwarn(warning, warn) {
                    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
                    warn(warning);
                },
            });

            const { output } = await bundle.generate({
                format: 'iife',
                name: 'CombatSimWorker',
            });

            const code = output[0].code;
            const result = `export default ${JSON.stringify(code)};`;
            cache.set(entryPath, result);
            return result;
        },
    };
}

// Check if we should build for production (multi-bundle)
const isProduction = process.env.BUILD_MODE === 'production';
const buildTarget = process.env.BUILD_TARGET || 'dev';
const devOutputFile = buildTarget === 'dev-standalone' ? 'dist/Toolasha-dev.user.js' : 'dist/Toolasha.user.js';

/**
 * When this build was made.
 *
 * The dev script and the published one carry the same @name and the same
 * @version, so Tampermonkey cannot tell them apart and neither can you — a stale
 * install looks exactly like a fresh one that is missing a feature. This stamp
 * is the difference: whatever the console prints is what is actually running.
 */
const buildStamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The @version the dev bundle installs under.
 *
 * The dev script and the published one share a @name and a @version, so once a
 * release ships its number (say 2.93.0) a dev build of the same number reads as
 * "already installed" — Tampermonkey will not replace 2.93.0 with 2.93.0, and a
 * fresh dev file silently keeps the old code. Appending the build stamp as a
 * fourth version segment (2.93.0.20260810213045) makes every dev build sort
 * newer than the release and newer than the last dev build, so a reinstall always
 * takes. A later real release (2.94.0) still supersedes it, comparing higher at
 * the minor segment. Only the standalone dev file is stamped; the published
 * header is left exactly as release-please wrote it.
 */
const devHeader =
    buildTarget === 'dev-standalone'
        ? userscriptHeader.replace(/(@version\s+)(\S+)/, `$1$2.${buildStamp.replace(/\D/g, '').slice(0, 14)}`)
        : userscriptHeader;

/**
 * Terser settings shared by every minified bundle. Keep the function and class
 * names — the codebase reads them at runtime (React-fiber traversal,
 * feature-registry lookups, error labels) — and let terser only strip
 * whitespace/comments and shorten the local scope.
 *
 * Comments: only `@license` / `@preserve` survive. The library banners carry an
 * `@license` line for that reason. A userscript header is a run of `//` lines,
 * each a comment of its own to terser, so one that is passed in as Rollup's
 * `banner` comes out as just its `@license` line; it goes in as terser's
 * `preamble` instead, which is emitted first and untouched.
 * @param {string} [preamble] - Text to emit verbatim ahead of the minified code
 * @returns {Object} Options for @rollup/plugin-terser
 */
function terserOptions(preamble) {
    return {
        keep_classnames: true,
        keep_fnames: true,
        format: {
            comments: /@preserve|@license/,
            ...(preamble ? { preamble } : {}),
        },
    };
}

// Development build configuration (single bundle for local testing)
const devConfig = {
    input: 'src/dev-entrypoint.js',
    output: {
        file: devOutputFile,
        format: 'iife',
        name: 'Toolasha',
        // A minified dev build gets the header from terser's preamble instead
        ...(process.env.MINIFY ? {} : { banner: devHeader }),
        // The stamp lives on the namespace as well as in the console line: the
        // startup trace and health report print it, so a paste from a tab says
        // which dev build it was running instead of just the release number the
        // dev bundle shares with GreasyFork.
        outro:
            `console.log('[Toolasha] dev build ${buildStamp}');` +
            `if (typeof window !== 'undefined' && window.Toolasha) window.Toolasha.buildStamp = '${buildStamp}';`,
    },
    plugins: [
        cssRawPlugin(),
        changelogPlugin(),
        overviewPlugin(),
        workerBundlePlugin(),
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        commonjs(),
        // Opt-in: `MINIFY=1 npm run build:dev` produces a minified standalone,
        // the same terser settings the production bundles use, so the minified
        // code can be smoke-tested in-game before a release ships it. Off by
        // default so ordinary dev builds stay readable.
        ...(process.env.MINIFY ? [terser(terserOptions(devHeader))] : []),
    ],
};

// Production build configuration (multi-bundle for Greasyfork)
const prodLibraries = [
    {
        key: 'core',
        input: 'src/libraries/core.js',
        output: {
            file: 'dist/libraries/toolasha-core.js',
            format: 'iife',
            name: 'ToolashaCore',
            banner: libraryHeaderCore,
        },
    },
    {
        key: 'utils',
        input: 'src/libraries/utils.js',
        output: {
            file: 'dist/libraries/toolasha-utils.js',
            format: 'iife',
            name: 'ToolashaUtils',
            banner: libraryHeaderUtils,
        },
    },
    {
        key: 'market',
        input: 'src/libraries/market.js',
        output: {
            file: 'dist/libraries/toolasha-market.js',
            format: 'iife',
            name: 'ToolashaMarket',
            banner: libraryHeaderMarket,
        },
    },
    {
        key: 'actions',
        input: 'src/libraries/actions.js',
        output: {
            file: 'dist/libraries/toolasha-actions.js',
            format: 'iife',
            name: 'ToolashaActions',
            banner: libraryHeaderActions,
        },
    },
    {
        key: 'sim',
        input: 'src/libraries/sim.js',
        output: {
            file: 'dist/libraries/toolasha-sim.js',
            format: 'iife',
            name: 'ToolashaSim',
            banner: libraryHeaderSim,
        },
    },
    {
        key: 'combat',
        input: 'src/libraries/combat.js',
        output: {
            file: 'dist/libraries/toolasha-combat.js',
            format: 'iife',
            name: 'ToolashaCombat',
            banner: libraryHeaderCombat,
        },
    },
    {
        key: 'ui',
        input: 'src/libraries/ui.js',
        output: {
            file: 'dist/libraries/toolasha-ui.js',
            format: 'iife',
            name: 'ToolashaUI',
            banner: libraryHeaderUI,
        },
    },
];

const prodEntrypoint = {
    input: 'src/entrypoint.js',
    output: {
        file: 'dist/Toolasha.user.js',
        format: 'iife',
        name: 'ToolashaEntrypoint',
    },
    // The entrypoint only uses window.Toolasha, so it needs no resolution
    // plugins — just the same minification as the libraries. Its userscript
    // header rides in as terser's preamble so the `// ==UserScript==` block
    // stays first and intact (see terserOptions).
    plugins: [terser(terserOptions(entrypointHeader))],
};

const sharedCoreGlobals = buildGlobals(coreExternalGlobals);
const sharedFeatureGlobals = buildGlobals(new Map([...coreExternalGlobals, ...utilsExternalGlobals]));

const prodConfig = [
    ...prodLibraries.map((lib) => {
        const { key, ...libraryConfig } = lib;
        let external = null;
        let globals = null;

        if (key === 'utils') {
            external = buildExternal(coreExternalGlobals);
            globals = sharedCoreGlobals;
        } else if (key === 'sim') {
            // The engine is self-contained apart from core and utils; it must
            // NOT treat itself as external or the bundle would be empty
            external = buildExternal(new Map([...coreExternalGlobals, ...utilsExternalGlobals]));
            globals = sharedFeatureGlobals;
        } else if (key === 'market') {
            external = buildExternal(new Map([...coreExternalGlobals, ...utilsExternalGlobals, ...simExternalGlobals]));
            globals = buildGlobals(new Map([...coreExternalGlobals, ...utilsExternalGlobals, ...simExternalGlobals]));
        } else if (key !== 'core') {
            // actions, combat, ui — need core + utils + sim + market externals
            const allExternals = new Map([
                ...coreExternalGlobals,
                ...utilsExternalGlobals,
                ...simExternalGlobals,
                ...marketExternalGlobals,
            ]);
            // ui and actions also treat combat feature singletons as externals to avoid duplicate instances
            if (key === 'ui' || key === 'actions') {
                for (const [k, v] of combatFeatureExternals) allExternals.set(k, v);
            }
            external = buildExternal(allExternals);
            globals = buildGlobals(allExternals);
        }

        return {
            ...libraryConfig,
            external: external || undefined,
            output: {
                ...libraryConfig.output,
                ...(globals ? { globals } : {}),
            },
            plugins: [
                cssRawPlugin(),
                changelogPlugin(),
                overviewPlugin(),
                workerBundlePlugin(),
                resolve({
                    browser: true,
                    preferBuiltins: false,
                }),
                commonjs(),
                // Minify the @require library bundles. The Steam Extension
                // Manager refuses to fetch a single @require larger than ~2 MB,
                // which the unminified sim/combat/ui bundles exceeded. The
                // library's own banner survives on its @license line.
                terser(terserOptions()),
            ],
        };
    }),
    prodEntrypoint,
];

export default isProduction ? prodConfig : devConfig;
