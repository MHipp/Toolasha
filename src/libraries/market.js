/**
 * Market Library
 * Market, inventory, and economy features
 *
 * Exports to: window.Toolasha.Market
 */

// Market features
import tooltipPrices from '../features/market/tooltip-prices.js';
import expectedValueCalculator from '../features/market/expected-value-calculator.js';
import tooltipConsumables from '../features/market/tooltip-consumables.js';
import marketFilter from '../features/market/market-filter.js';
import marketSort from '../features/market/market-sort.js';
import autoFillPrice from '../features/market/auto-fill-price.js';
import autoClickMax from '../features/market/auto-click-max.js';
import itemCountDisplay from '../features/market/item-count-display.js';
import listingPriceDisplay from '../features/market/listing-price-display.js';
import collectableListingsSort from '../features/market/collectable-listings-sort.js';
import estimatedListingAge from '../features/market/estimated-listing-age.js';
import queueLengthEstimator from '../features/market/queue-length-estimator.js';
import marketDepthCap from '../features/market/market-depth-cap.js';
import marketOrderTotals from '../features/market/market-order-totals.js';
import marketHistoryViewer from '../features/market/market-history-viewer.js';
import listingRefreshNavigator from '../features/market/listing-refresh-navigator.js';
import listingNextNavigator from '../features/market/listing-next-navigator.js';
import marketItemHop from '../features/market/market-item-hop.js';
import bulkSellAssistant from '../features/market/bulk-sell-assistant.js';
import listingMarkers from '../features/market/listing-markers.js';
import marketplaceBadgeFilter from '../features/market/marketplace-badge-filter.js';
import marketHistoryPanel from '../features/market/mooket/index.js';
import myListingsPriceRefresh from '../features/market/mooket/my-listings-price-refresh.js';
// The pooled history and the arithmetic over it, shared rather than copied: the
// goal planner (actions bundle) bounds its gold rates by how fast an item
// actually sells, and a second copy would mean a second five-minute fetch cache
// asking the same third-party server the same questions.
import marketHistoryAPI from '../features/market/mooket/market-history-api.js';
import * as marketHistoryData from '../features/market/mooket/market-history-data.js';
import philoCalculator from '../features/market/philo-calculator.js';
import tradeHistory from '../features/market/trade-history.js';
import tradeHistoryDisplay from '../features/market/trade-history-display.js';
import networkAlert from '../features/market/network-alert.js';
import profitCalculator from '../features/market/profit-calculator.js';
import alchemyProfitCalculator from '../features/market/alchemy-profit-calculator.js';
import marketplaceShortcuts from '../features/market/marketplace-shortcuts.js';
import sellQueue from '../features/market/sell-queue.js';

// Not market features, but this is the bundle that owns them: the actions,
// combat and ui bundles all import these two calculators and all load after
// market, so exporting them here is what stops each of those bundles carrying
// its own copy. See marketExternalGlobals in rollup.config.js.
import * as gatheringProfit from '../features/actions/gathering-profit.js';
import * as productionProfit from '../features/actions/production-profit.js';

// Networth/Economy features
import networthFeature from '../features/networth/index.js';
import * as networthCalculator from '../features/networth/networth-calculator.js';
// Side-effect import: registers the coins, listings, inventory and books overlay rows
import '../features/networth/networth-rows.js';
import { abilityBookPanel } from '../features/abilities/ability-book-panel.js';
import abilityCheckpoints from '../features/abilities/ability-checkpoints.js';
// Side-effect import: registers the Charm Value overlay row
import '../features/inventory/charm-value-row.js';

// Offline Progress features
import offlineProgressEconomics from '../features/offline-progress/offline-progress-economics.js';

// Inventory features
import inventoryBadgeManager from '../features/inventory/inventory-badge-manager.js';
import inventorySort from '../features/inventory/inventory-sort.js';
import inventoryBadgePrices from '../features/inventory/inventory-badge-prices.js';
import dungeonTokenTooltips from '../features/inventory/dungeon-token-tooltips.js';
import treasureTracker from '../features/inventory/treasure-tracker.js';
import tradeLedgerStore from '../features/market/trade-ledger-store.js';
import tradeLedgerView from '../features/market/trade-ledger-view.js';
import staleCapitalView from '../features/market/stale-capital-view.js';
import watchlist, { watchlistPanel, watchItem } from '../features/inventory/watchlist.js';
import autoAllButton from '../features/inventory/auto-all-button.js';
import inventoryCategoryTotals from '../features/inventory/inventory-category-totals.js';
import customTabsFeature from '../features/inventory/custom-tabs/custom-tabs-feature.js';
import equipmentSavings, { equipmentSavingsPanel, watchTarget } from '../features/inventory/equipment-savings-row.js';
// The savings-goal alert reads the three costed lists the panel above draws, so
// it rides in this bundle rather than beside the other alerts in the UI one — a
// second copy of that panel's costing machinery in another bundle would be the
// alternative. `notification-service.js` keeps its cooldowns and its digest
// buffer on a global for exactly this case, so being reached from two bundles
// costs nothing.
import savingsGoalAlerts from '../features/notifications/savings-goal-alerts.js';
// Likewise: the price-target alert reads the pins the price history panel above
// keeps, and its evidence is that panel's own pooled dataset.
import priceTargetAlerts from '../features/notifications/price-target-alerts.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Market = {
    tooltipPrices,
    expectedValueCalculator,
    tooltipConsumables,
    marketFilter,
    marketSort,
    autoFillPrice,
    autoClickMax,
    itemCountDisplay,
    listingPriceDisplay,
    collectableListingsSort,
    estimatedListingAge,
    queueLengthEstimator,
    marketDepthCap,
    marketOrderTotals,
    marketHistoryViewer,
    listingRefreshNavigator,
    listingNextNavigator,
    marketItemHop,
    bulkSellAssistant,
    listingMarkers,
    marketplaceBadgeFilter,
    marketHistoryPanel,
    myListingsPriceRefresh,
    marketHistoryAPI,
    marketHistoryData,
    philoCalculator,
    tradeHistory,
    tradeHistoryDisplay,
    networkAlert,
    profitCalculator,
    alchemyProfitCalculator,
    networthFeature,
    networthCalculator,
    offlineProgressEconomics,
    inventoryBadgeManager,
    inventorySort,
    inventoryBadgePrices,
    dungeonTokenTooltips,
    treasureTracker,
    tradeLedgerStore,
    tradeLedgerView,
    staleCapitalView,
    abilityBookPanel,
    abilityCheckpoints,
    watchlist,
    watchlistPanel,
    // The combat sim's Watch/Save buttons run in the sim bundle, which loads
    // before this one and so cannot import these at all; it reaches the live
    // write paths through these two at call time instead. It no longer carries
    // inline copies as a fallback — see check-bundle-sharing's single-copy list.
    watchItem,
    watchTarget,
    autoAllButton,
    inventoryCategoryTotals,
    customTabsFeature,
    equipmentSavings,
    equipmentSavingsPanel,
    savingsGoalAlerts,
    priceTargetAlerts,
    marketplaceShortcuts,
    sellQueue,
    gatheringProfit,
    productionProfit,
};

// Why the sidebar's Marketplace badge is or is not showing. The feature's only
// output is the absence of a badge, which looks the same as the setting being
// off, the game not badging, and every listing still working.
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    marketBadge: () => marketplaceBadgeFilter.describe(),
};

console.log('[Toolasha] Market library loaded');
