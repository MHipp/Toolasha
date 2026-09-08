/**
 * Bundle Bridge
 *
 * The one place cross-bundle reach-throughs live.
 *
 * The production build is several iife bundles that load in order and publish
 * their initialized singletons on `window.Toolasha.*`. A module that needs a
 * singleton from a bundle that loads after its own — or one whose import would
 * copy a second, uninitialized instance into its own bundle — cannot import it;
 * it has to read the namespace at call time. Those reads used to be ~80 bare
 * `window.Toolasha?...` expressions scattered across the codebase, invisible to
 * grep-by-intent and unmockable in tests.
 *
 * Every accessor here returns the live, initialized module the namespace holds
 * — or `null`, honestly, when the owning bundle has not loaded (or the code is
 * running off-page, as in tests and workers). No accessor caches anything: the
 * namespace is the state, this module has none, which is also why a copy of it
 * per bundle would be harmless.
 *
 * Callers keep their own fallbacks where they had them (`loadoutSnapshot() ||
 * bundledCopy` for the single-bundle dev build); the bridge only answers "what
 * does the namespace hold right now".
 */

/**
 * The published namespace itself, or null off-page.
 * @returns {Object|null} `window.Toolasha`, or null when there is no window or no namespace
 */
export function toolashaRoot() {
    return globalThis.window?.Toolasha || null;
}

/**
 * The running script's version, with the dev build stamp when there is one.
 *
 * The dev bundle shares its version number with the release it was cut from,
 * so a report saying "3.28.0" cannot tell a dev-loader tab from a GreasyFork
 * install — during the 2026-08-28 freeze hunt that ambiguity cost hours. The
 * dev build's outro stamps the namespace, and this reads it back.
 *
 * @returns {string|null} e.g. `3.28.0 (dev build 2026-08-29T03:15:01Z)`, the bare
 *   version, or null off-page like every other accessor here
 */
export function scriptBuildLabel() {
    const root = toolashaRoot();
    if (!root?.version) return null;
    return root.buildStamp ? `${root.version} (dev build ${root.buildStamp})` : root.version;
}

// ---------------------------------------------------------------------------
// Core (loads first; reached from later bundles whose own copy is uninstalled)
// ---------------------------------------------------------------------------

/**
 * The installed WebSocket hook. Only the Core bundle's instance has
 * `install()` called on it; a bundle-local copy hears nothing.
 * @returns {Object|null} The hook, or null before Core has loaded
 */
export function webSocketHook() {
    return toolashaRoot()?.Core?.webSocketHook || null;
}

/**
 * The initialized data manager, for the rare caller that cannot import it.
 * @returns {Object|null} The manager, or null before Core has loaded
 */
export function dataManager() {
    return toolashaRoot()?.Core?.dataManager || null;
}

/**
 * The performance monitor the startup timeline was recorded on.
 * @returns {Object|null} The monitor, or null before Core has loaded
 */
export function performanceMonitor() {
    return toolashaRoot()?.Core?.performanceMonitor || null;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * The enhancement Markov-chain calculator module (namespace with
 * `calculateEnhancement`), read lazily by code that only sometimes needs it.
 * @returns {Object|null} The module, or null before the utils bundle has loaded
 */
export function enhancementCalculator() {
    return toolashaRoot()?.Utils?.enhancementCalculator || null;
}

/**
 * The enhancement config module (namespace with `getAutoDetectedParams`).
 * @returns {Object|null} The module, or null before the utils bundle has loaded
 */
export function enhancementConfig() {
    return toolashaRoot()?.Utils?.enhancementConfig || null;
}

// ---------------------------------------------------------------------------
// Market bundle singletons
// ---------------------------------------------------------------------------

/**
 * The treasure tracker's measured chest returns.
 * @returns {Object|null} The tracker, or null when the market bundle is absent
 */
export function treasureTracker() {
    return toolashaRoot()?.Market?.treasureTracker || null;
}

/**
 * The price history panel — the one copy holding this character's pins.
 *
 * Only the Market bundle's instance has `initialize()` called on it, so only
 * that one has a watchlist; a bundle-local copy would be an empty panel that
 * silently accepted pins nobody would ever see.
 *
 * @returns {Object|null} The panel, or null when the market bundle is absent
 *   or the price history feature is off
 */
export function marketHistoryPanel() {
    return toolashaRoot()?.Market?.marketHistoryPanel || null;
}

/**
 * The Risk of Ruin panel, for its last depth-cap context.
 *
 * Reached through the global rather than imported: the panel is a ui-bundle
 * feature, and importing its module from the market bundle bundled a SECOND
 * copy of the singleton there — whose module-level setting listener
 * initialized alongside the real one and injected a second "Risk of Ruin"
 * tab on every live (multi-bundle) install. Dev single-bundle builds never
 * showed it.
 * @returns {Object|null} The panel singleton, or null when the ui bundle is absent
 */
export function riskOfRuinUI() {
    return toolashaRoot()?.UI?.riskOfRuinUI || null;
}

/**
 * The order-book cache behind the queue-length estimator.
 * @returns {Object|null} The estimator, or null when the market bundle is absent
 */
export function queueLengthEstimator() {
    return toolashaRoot()?.Market?.queueLengthEstimator || null;
}

/**
 * The listing-age tracker, for its persisted order-book cache.
 *
 * The one cache of whole books that outlives the browsing session (a week, up
 * to 200 items), so a feature outside the marketplace panel — the guild credit
 * exchange advisor — can value a batch against real depth instead of the top
 * of the book. Reached through the global because the tracker is a market
 * bundle singleton and only that copy runs `initialize()`.
 *
 * @returns {Object|null} The tracker, or null when the market bundle is absent
 */
export function estimatedListingAge() {
    return toolashaRoot()?.Market?.estimatedListingAge || null;
}

/**
 * The market-order totals calculator (coins committed to listings).
 * @returns {Object|null} The module, or null when the market bundle is absent
 */
export function marketOrderTotals() {
    return toolashaRoot()?.Market?.marketOrderTotals || null;
}

/**
 * The expected-value calculator for openable containers — the one copy that ran
 * initialize() (its cache is empty and calculateExpectedValue() returns null
 * until then, which only the market bundle's copy does).
 * @returns {Object|null} The calculator, or null when the market bundle is absent
 */
export function expectedValueCalculator() {
    return toolashaRoot()?.Market?.expectedValueCalculator || null;
}

/**
 * The Philo Gamba calculator, for its `openModal()`.
 * @returns {Object|null} The calculator, or null when the market bundle is absent
 */
export function philoCalculator() {
    return toolashaRoot()?.Market?.philoCalculator || null;
}

// ---------------------------------------------------------------------------
// Actions bundle singletons
// ---------------------------------------------------------------------------

/**
 * The planner's market-volume measurement — the one copy with the cache in it.
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function marketLiquidity() {
    return toolashaRoot()?.Actions?.marketLiquidity || null;
}

/**
 * The action-panel sort/pin singleton — the one copy the actions bundle fills
 * with per-action cachedStats and the persisted pinned-action set. Other
 * bundles' copies stay empty, and writing to them can clobber the shared store.
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function actionPanelSort() {
    return toolashaRoot()?.Actions?.actionPanelSort || null;
}

/**
 * The buy-versus-craft planner (namespace with `computeBestCraftingPlan`).
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function craftingPlanCalculator() {
    return toolashaRoot()?.Actions?.craftingPlanCalculator || null;
}

/**
 * The action panel's missing-materials marketplace opener.
 * @returns {Object|null} The module, or null when the feature is off or absent
 */
export function missingMaterialsButton() {
    return toolashaRoot()?.Actions?.missingMaterialsButton || null;
}

/**
 * The goal planner panel.
 * @returns {Object|null} The panel, or null when the actions bundle is absent
 */
export function goalPlanner() {
    return toolashaRoot()?.Actions?.goalPlanner || null;
}

// ---------------------------------------------------------------------------
// Combat bundle singletons
// ---------------------------------------------------------------------------

/**
 * The initialized loadout snapshot store. Every other bundle's copy never
 * reads storage and answers "no loadout" to everything.
 * @returns {Object|null} The store, or null when the combat bundle is absent
 */
export function loadoutSnapshot() {
    return toolashaRoot()?.Combat?.loadoutSnapshot || null;
}

/**
 * The dungeon run history store. The combat bundle's copy is the one the
 * tracker writes to; another bundle's would read an empty list.
 * @returns {Object|null} The store, or null when the combat bundle is absent
 */
export function dungeonTrackerStorage() {
    return toolashaRoot()?.Combat?.dungeonTrackerStorage || null;
}

/**
 * The dungeon tracker the websocket feeds. Its current run holds the party's
 * key counts, parsed from the game's own chat message; another bundle's copy
 * has never heard a message and holds nothing.
 * @returns {Object|null} The tracker, or null when the combat bundle is absent
 */
export function dungeonTracker() {
    return toolashaRoot()?.Combat?.dungeonTracker || null;
}

/**
 * The combat recorder the websocket actually feeds.
 * @returns {Object|null} The recorder, or null when the combat bundle is absent
 */
export function combatRecorder() {
    return toolashaRoot()?.Combat?.combatRecorder || null;
}

/**
 * The scroll simulator (per-loadout scroll/buff sets), loaded from storage by
 * the combat bundle's initialize(); other bundles' copies stay empty.
 * @returns {Object|null} The simulator, or null when the combat bundle is absent
 */
export function scrollSimulator() {
    return toolashaRoot()?.Combat?.scrollSimulator || null;
}

/**
 * The labyrinth clear-rate singleton — its live-run roomData and recommendations
 * are fed by the websocket only in the combat bundle.
 * @returns {Object|null} The module, or null when the combat bundle is absent
 */
export function labyrinthClearRate() {
    return toolashaRoot()?.Combat?.labyrinthClearRate || null;
}

/**
 * The guild-token-exchange capture module (Guild Shop rate), whose `captured`
 * map is filled and hydrated only in the combat bundle.
 * @returns {Object|null} The module namespace, or null when combat is absent
 */
export function guildTokenExchangeCapture() {
    return toolashaRoot()?.Combat?.guildTokenExchangeCapture || null;
}

/**
 * The guild-trials singleton (guildName + record), fed by the websocket only in
 * the combat bundle.
 * @returns {Object|null} The store, or null when the combat bundle is absent
 */
export function guildTrialsStore() {
    return toolashaRoot()?.Combat?.guildTrialsStore || null;
}

/**
 * The guild XP tracker (own guild name + member history), combat-owned.
 * @returns {Object|null} The tracker, or null when the combat bundle is absent
 */
export function guildXpTracker() {
    return toolashaRoot()?.Combat?.guildXPTracker || null;
}

/**
 * The guild-trial export builder module (buildTrialExport/downloadTrialExport);
 * its data-gathering reads the trial singletons live only in the combat bundle.
 * @returns {Object|null} The module namespace, or null when combat is absent
 */
export function guildTrialExport() {
    return toolashaRoot()?.Combat?.guildTrialExport || null;
}

/**
 * The party drop-luck panel.
 * @returns {Object|null} The panel, or null when the combat bundle is absent
 */
export function partyLuckPanel() {
    return toolashaRoot()?.Combat?.partyLuckPanel || null;
}

/**
 * The stateful combat-stats collector the websocket feeds.
 * @returns {Object|null} The collector, or null when the combat bundle is absent
 */
export function combatStatsDataCollector() {
    return toolashaRoot()?.Combat?.combatStatsDataCollector || null;
}

/**
 * The combat-stats calculator that reads the collector's data — shared with it
 * because the two are read together.
 * @returns {Object|null} The calculator module, or null when the combat bundle is absent
 */
export function combatStatsCalculator() {
    return toolashaRoot()?.Combat?.combatStatsCalculator || null;
}

/**
 * The gear-target writer on the market bundle's savings row — the copy whose
 * in-memory list the visible panel and the savings-goal alerts read. A
 * bundle-local `watchTarget` writes into a copy those never hear about, and
 * the next persist from the live copy silently drops the target.
 * @returns {Function|null} watchTarget, or null when the market bundle is absent
 */
export function marketWatchTarget() {
    return toolashaRoot()?.Market?.watchTarget || null;
}

/**
 * The pin writer on the market bundle's watchlist — same story as
 * {@link marketWatchTarget}: only that copy's memory backs the panel.
 * @returns {Function|null} watchItem, or null when the market bundle is absent
 */
export function marketWatchItem() {
    return toolashaRoot()?.Market?.watchItem || null;
}

/**
 * The task-completion tracker the websocket actually feeds (ui bundle). The
 * market bundle's inline copy never wires `character_switching`, so it serves
 * the previous character's completions after a switch and never refreshes
 * mid-session.
 * @returns {Object|null} The tracker, or null when the ui bundle is absent
 */
export function taskCompletionTracker() {
    return toolashaRoot()?.UI?.taskCompletionTracker || null;
}

/**
 * The loot-log history the loot-log recorder writes into (ui bundle); a
 * bundle-local copy is frozen at whatever storage held on its first read.
 * @returns {Object|null} The history, or null when the ui bundle is absent
 */
export function lootLogHistory() {
    return toolashaRoot()?.UI?.lootLogHistory || null;
}

/**
 * The enhancement session store whose memory the tracker writes through (ui
 * bundle) — reading it skips the debounce window a fresh storage read lags by.
 * @returns {Object|null} The storage module, or null when the ui bundle is absent
 */
export function enhancementSessionStore() {
    return toolashaRoot()?.UI?.enhancementStorage || null;
}

// ---------------------------------------------------------------------------
// Sim bundle singletons
// ---------------------------------------------------------------------------

/**
 * The combat simulator's panel instance.
 * @returns {Object|null} The panel, or null when the sim bundle is absent
 */
export function combatSimUI() {
    return toolashaRoot()?.Sim?.combatSimUI || null;
}

/**
 * The labyrinth simulator's panel instance, when one has been published.
 * @returns {Object|null} The panel, or null when there is none
 */
export function labSimUI() {
    return toolashaRoot()?.Sim?.labSimUI || null;
}

// ---------------------------------------------------------------------------
// UI bundle singletons (the ui bundle loads last, so everything below is
// reached at call time — usually a panel behind an overlay tile)
// ---------------------------------------------------------------------------

/**
 * The DPS panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function dpsPanel() {
    return toolashaRoot()?.UI?.dpsPanel || null;
}

/**
 * The settings UI (namespace with `onSettingsPanelAppear`).
 * @returns {Object|null} The module, or null when the ui bundle is absent
 */
export function settingsUI() {
    return toolashaRoot()?.UI?.settingsUI || null;
}

/**
 * The profit panel's view function — maps raw stats to the reading the panel
 * itself would show, so tiles agree with the panel behind them.
 * @returns {Function|null} The view function, or null when the ui bundle is absent
 */
export function combatProfitView() {
    return toolashaRoot()?.UI?.combatProfitView || null;
}

/**
 * The combat profit panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function profitPanel() {
    return toolashaRoot()?.UI?.profitPanel || null;
}

/**
 * The combat level / experience panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function combatLevelPanel() {
    return toolashaRoot()?.UI?.combatLevelPanel || null;
}

/**
 * The deaths panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function deathsPanel() {
    return toolashaRoot()?.UI?.deathsPanel || null;
}

/**
 * The party loot panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function partyLootPanel() {
    return toolashaRoot()?.UI?.partyLootPanel || null;
}

/**
 * The consumables panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function consumablesPanel() {
    return toolashaRoot()?.UI?.consumablesPanel || null;
}

/**
 * The overlay panel that owns the tile rows' shared display options.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function overlayPanel() {
    return toolashaRoot()?.UI?.overlayPanel || null;
}

/**
 * The Iron Bell farming panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function ironCowFarmPanel() {
    return toolashaRoot()?.UI?.ironCowFarmPanel || null;
}

/**
 * The PFormance panel (the script's own timings).
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function pformancePanel() {
    return toolashaRoot()?.UI?.pformancePanel || null;
}

// ---------------------------------------------------------------------------
// Root-level singletons
// ---------------------------------------------------------------------------

/**
 * The guild trial damage scoreboard, published at the namespace root.
 * @returns {Object|null} The scoreboard, or null when the combat bundle is absent
 */
export function guildTrialScoreboard() {
    return toolashaRoot()?.guildTrialScoreboard || null;
}
