/**
 * Actions Library
 * Production, gathering, and alchemy features
 *
 * Exports to: window.Toolasha.Actions
 */

// Action features
import { initActionPanelObserver } from '../features/actions/panel-observer.js';
import actionTimeDisplay from '../features/actions/action-time-display.js';
import actionCountdown from '../features/actions/action-countdown.js';
import actionTimingMonitor from '../features/actions/action-timing-monitor.js';
import quickInputButtons from '../features/actions/quick-input-buttons.js';
import outputTotals from '../features/actions/output-totals.js';
import maxProduceable from '../features/actions/max-produceable.js';
import gatheringStats from '../features/actions/gathering-stats.js';
import actionPanelSort from '../features/actions/action-panel-sort.js';
import requiredMaterials from '../features/actions/required-materials.js';
import missingMaterialsButton from '../features/actions/missing-materials-button.js';
import budgetCalculator from '../features/actions/budget-calculator.js';
import costSummary from '../features/actions/cost-summary.js';
import actionPanelLayout from '../features/actions/action-panel-layout.js';
import craftingPlan from '../features/crafting-plan/index.js';
// The task board's merged crafting walk. Its own registry feature, but it rides
// in this bundle rather than the ui one: it is built out of the crafting-plan
// calculator and the walk singleton, and importing it from src/libraries/ui.js
// would copy both into a second bundle — a second walk instance for the same
// surface the action panel drives.
import taskCraftingTrain from '../features/crafting-plan/task-crafting-train.js';
import productionArbitrageBoard from '../features/actions/production-arbitrage-board.js';
import * as craftingPlanCalculator from '../features/crafting-plan/crafting-plan-calculator.js';
import * as craftArbitrage from '../features/crafting-plan/craft-arbitrage-adapter.js';
import teaRecommendation from '../features/actions/tea-recommendation.js';
import inventoryCountDisplay from '../features/actions/inventory-count-display.js';
import pinnedActionsPage from '../features/actions/pinned-actions-page.js';
import drinkTimer from '../features/actions/drink-timer.js';

// Alchemy features
import alchemyProfitDisplay from '../features/alchemy/alchemy-profit-display.js';
import alchemyBestItems from '../features/alchemy/alchemy-best-items.js';
import alchemyItemPins from '../features/alchemy/alchemy-item-pins.js';
import { describeAlchemyMenus } from '../features/alchemy/alchemy-item-selector.js';

// Skilling optimizer
import skillingOptimizer from '../features/skilling-optimizer/skilling-optimizer-ui.js';

// Goal planner. It lives here rather than in the ui bundle because everything it
// composes already does: the buy-vs-craft model above, and the enhancement path
// optimiser the missing-materials button pulls in.
import goalPlanner from '../features/planner/goal-planner-ui.js';
// Side-effect import: registers the Next Goal Step overlay row
import '../features/planner/goal-planner-row.js';
// The market-volume measurement behind the planner's liquidity bound. Exported
// because the shared display cap (utils/liquidity-cap.js) reaches for this
// initialized copy at runtime — its volume cache must be the same one the goal
// planner fills, not a per-bundle duplicate asking the server twice.
import marketLiquidity from '../features/planner/market-liquidity.js';

// Character Activity Status. It lives in this bundle rather than the ui one because its
// projection engine reuses Action Time Display's per-action duration and material-limit maths:
// imported from ui, that whole engine would be copied into a second bundle as a second, stale
// singleton. Its two halves ship together so nothing has to cross a bundle boundary at all.
import characterActivity from '../features/character-activity/character-activity.js';
import characterSelectRenderer from '../features/character-activity/character-select-renderer.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Actions = {
    initActionPanelObserver,
    actionTimeDisplay,
    actionCountdown,
    actionTimingMonitor,
    quickInputButtons,
    outputTotals,
    maxProduceable,
    gatheringStats,
    requiredMaterials,
    missingMaterialsButton,
    budgetCalculator,
    costSummary,
    actionPanelLayout,
    craftingPlan,
    taskCraftingTrain,
    productionArbitrageBoard,
    // Reached by Equipment Watch, which lives in the market bundle: importing
    // it there would copy the whole recursive costing model into a second bundle
    craftingPlanCalculator,
    // The same costing model, narrowed to one read-only question — what would
    // one of these cost *me* to make — for callers outside this bundle
    craftArbitrage,
    alchemyProfitDisplay,
    alchemyBestItems,
    alchemyItemPins,
    teaRecommendation,
    inventoryCountDisplay,
    pinnedActionsPage,
    // Shared so cross-bundle readers (task profit in ui/market, alchemy pin
    // protection in ui) see the live cachedStats/pinnedActions this bundle fills
    actionPanelSort,
    drinkTimer,
    skillingOptimizer,
    goalPlanner,
    marketLiquidity,
    characterActivity,
    // Started by the entrypoint outside the feature lifecycle — character select renders before
    // any character exists, so the registry is not running yet when this has to draw
    characterSelectRenderer,
};

// Console-driven debug tools, kept out of the feature namespaces because
// nothing registers or schedules them — they only run when typed
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    alchemyMenu: () => describeAlchemyMenus(),
    // Recent actions whose progress bar finished early and then sat full, with the
    // buff snapshot for each. Needs the 'Action bar: Timing diagnostic' setting on.
    actionTimingReport: () => actionTimingMonitor.report(),
};

console.log('[Toolasha] Actions library loaded');
