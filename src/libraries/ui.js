/**
 * UI Library
 * UI enhancements, tasks, skills, house, settings, and misc features
 *
 * Exports to: window.Toolasha.UI
 */

// UI features
import equipmentLevelDisplay from '../features/ui/equipment-level-display.js';
import alchemyItemDimming from '../features/ui/alchemy-item-dimming.js';
import skillExperiencePercentage from '../features/ui/skill-experience-percentage.js';
import combatLevelProgress from '../features/ui/combat-level-progress.js';
import externalLinks from '../features/ui/external-links.js';
import hideLabyrinthBadge from '../features/ui/hide-labyrinth-badge.js';
import hideGuildBadge from '../features/ui/hide-guild-badge.js';
import panelSizeMemory from '../features/ui/panel-size-memory.js';
import tabReorder from '../features/ui/tab-reorder.js';
import draggableModals from '../features/ui/draggable-modals.js';
import overlayPanel from '../features/ui/overlay-panel.js';
import overlayTabButton from '../features/ui/overlay-tab-button.js';
import commandPalette from '../features/ui/command-palette.js';
// Side-effect import: registers the Houses overlay row at module scope
import { describeHouses } from '../features/house/house-affordability.js';
import combatPanelScale from '../features/ui/combat-panel-scale.js';
import updateCheck from '../features/ui/update-check.js';
import welcomeBackValue from '../features/ui/welcome-back-value.js';
import combatText from '../features/ui/combat-text.js';
import { dpsPanel, deathsPanel, profitPanel, combatProfitView } from '../features/ui/combat-panels.js';
import { partyLootPanel } from '../features/ui/party-loot-panel.js';

// Navigation features
import altClickNavigation from '../features/navigation/alt-click-navigation.js';
import collectionNavigation from '../features/collection/collection-navigation.js';
import collectionFilters from '../features/collection/collection-filters.js';

// Chat features
import chatCommands from '../features/chat/chat-commands.js';
import chatProfileLink from '../features/chat/chat-profile-link.js';
import mentionTracker from '../features/chat/mention-tracker.js';
import popOutChat from '../features/chat/pop-out-chat.js';
import chatBlockList from '../features/chat/chat-block-list.js';
import chatHistoryExtender from '../features/chat/chat-history-extender.js';

// Task features
import taskProfitDisplay from '../features/tasks/task-profit-display.js';
import taskRerollTracker from '../features/tasks/task-reroll-tracker.js';
import taskSorter from '../features/tasks/task-sorter.js';
import taskIcons from '../features/tasks/task-icons.js';
import taskInventoryHighlighter from '../features/tasks/task-inventory-highlighter.js';
import taskStatistics from '../features/tasks/task-statistics.js';
// The websocket-fed copies of the records Gold Sources (market bundle) reads.
// Market loads before this bundle, so it reaches these at call time through
// the bundle bridge rather than the externals map.
import taskCompletionTracker from '../features/tasks/task-completion-tracker.js';
import lootLogHistory from '../features/actions/loot-log-history.js';
import * as enhancementStorage from '../features/enhancement/enhancement-storage.js';
// Side-effect import: registers the Task Tokens overlay row
import '../features/tasks/task-tokens-row.js';
import taskClaimCollector from '../features/tasks/task-claim-collector.js';
import taskClaimToast from '../features/tasks/task-claim-toast.js';
import taskRerollBadge from '../features/tasks/task-reroll-badge.js';
import taskRerollProtection from '../features/tasks/task-reroll-protection.js';
import taskAutoReroll from '../features/tasks/task-auto-reroll.js';
import taskRerollWalk from '../features/tasks/task-reroll-walk.js';

// Skills
import remainingXP from '../features/skills/remaining-xp.js';
import xpTracker from '../features/skills/xp-tracker.js';
import skillCheckpoints from '../features/skills/skill-checkpoints.js';
// Side-effect import: registers the Time to Level overlay row
import '../features/skills/skill-ttl-row.js';
// Side-effect import: registers the Skill Level overlay row
import '../features/skills/skill-level-row.js';

// Action features
import lootLogStats from '../features/actions/loot-log-stats.js';
import lootLogPivot from '../features/actions/loot-log-pivot-panel.js';

// House
import housePanelObserver from '../features/house/house-panel-observer.js';

// Settings UI
import settingsUI from '../features/settings/settings-ui.js';
import whatsNew from '../features/settings/whats-new.js';
import forkBackupPrompt from '../features/settings/fork-backup-prompt.js';

// Dictionary
import transmuteRates from '../features/dictionary/transmute-rates.js';
import viewActionButton from '../features/dictionary/view-action-button.js';

// Alchemy History
import transmuteHistoryTracker from '../features/alchemy/transmute-history-tracker.js';
import transmuteHistoryViewer from '../features/alchemy/transmute-history-viewer.js';
import coinifyHistoryTracker from '../features/alchemy/coinify-history-tracker.js';
import coinifyHistoryViewer from '../features/alchemy/coinify-history-viewer.js';
import decomposeHistoryTracker from '../features/alchemy/decompose-history-tracker.js';
import decomposeHistoryViewer from '../features/alchemy/decompose-history-viewer.js';
import alchemyActionProtection from '../features/alchemy/alchemy-action-protection.js';

// Enhancement
import enhancementFeature from '../features/enhancement/enhancement-feature.js';
// Side-effect import: registers the Enhancement Session overlay row
import '../features/enhancement/enhancement-session-row.js';
import xphCalculator from '../features/enhancement/xph-calculator.js';
import enhancementItemPins from '../features/enhancement/enhancement-item-pins.js';

// Risk of Ruin
import riskOfRuinUI from '../features/risk-of-ruin/risk-of-ruin-ui.js';

// Insights
import predictionCalibration from '../features/insights/index.js';

// Leaderboard
import leaderboardXPTracker from '../features/leaderboard/leaderboard-xp-tracker.js';
import leaderboardXPDisplay from '../features/leaderboard/leaderboard-xp-display.js';

// Notifications
import emptyQueueNotification from '../features/notifications/empty-queue-notification.js';
import communityBuffAlerts from '../features/notifications/community-buff-alerts.js';
import labyrinthRunAlerts from '../features/notifications/labyrinth-run-alerts.js';
import combatConsumableAlerts from '../features/notifications/combat-consumable-alerts.js';
import labyrinthEntryAlerts from '../features/notifications/labyrinth-entry-alerts.js';
import combatDeathAlerts from '../features/notifications/combat-death-alerts.js';
import skillLevelUpAlerts from '../features/notifications/skill-level-up-alerts.js';
import ttlTargetAlerts from '../features/notifications/ttl-target-alerts.js';
import enhancementTargetAlerts from '../features/notifications/enhancement-target-alerts.js';
import taskSlotAlerts from '../features/notifications/task-slot-alerts.js';
import marketUndercutAlerts from '../features/notifications/market-undercut-alerts.js';
import notificationService from '../features/notifications/notification-service.js';
// The record of everything the service has announced, and the panel that reads
// it. It rides in this bundle rather than beside each alert because it is one
// log, and because the overlay row it registers is what puts it in the palette.
import noticeLogPanel from '../features/notifications/notice-log-panel.js';

// Queue Monitor
import queueMonitor from '../features/queue-monitor/queue-monitor.js';
// Side-effect import: registers the Queue Time Left overlay row
import '../features/queue-monitor/queue-time-row.js';

// Session Briefing. Reads the queue, task, consumable, listing, enhancement and
// labyrinth sources this bundle already carries, so it costs the bundle only
// its own panel.
import sessionBriefing from '../features/briefing/session-briefing.js';

// Account
import accountView from '../features/account/index.js';

// Dev tools
import pformancePanel from '../features/dev/pformance-panel.js';
import * as healthStatus from '../features/dev/health-status.js';
// The selector audit rides beside the health tooling: same job (what did a
// game update break), different evidence (the stylesheets, not the page)
import * as selectorAudit from '../features/dev/selector-audit.js';
// The websocket-shape canary. It lives in core/ because that is what it asserts
// about, and is handed out here beside healthStatus because that is where its
// findings go.
import * as schemaCanary from '../core/schema-canary.js';
import { consumablesPanel } from '../features/ui/consumables-panel.js';
import { combatLevelPanel } from '../features/ui/combat-level-panel.js';

// Iron Bell Farming. It composes the gathering and alchemy profit calculators,
// both of which the market bundle already owns and hands out as globals, so
// living here costs this bundle nothing but the panel itself.
import ironCowFarmPanel from '../features/ironcow/ironcow-panel.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
// Shared console-only debug namespace; nothing schedules these
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    // Why the Houses overlay row is or is not showing anything
    houses: () => describeHouses(),
};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.UI = {
    equipmentLevelDisplay,
    alchemyItemDimming,
    skillExperiencePercentage,
    combatLevelProgress,
    externalLinks,
    hideLabyrinthBadge,
    hideGuildBadge,
    panelSizeMemory,
    tabReorder,
    draggableModals,
    overlayPanel,
    overlayTabButton,
    commandPalette,
    combatPanelScale,
    updateCheck,
    welcomeBackValue,
    altClickNavigation,
    collectionNavigation,
    collectionFilters,
    chatCommands,
    chatProfileLink,
    mentionTracker,
    popOutChat,
    chatBlockList,
    chatHistoryExtender,
    taskProfitDisplay,
    taskRerollTracker,
    taskSorter,
    taskIcons,
    taskInventoryHighlighter,
    taskStatistics,
    taskClaimCollector,
    taskClaimToast,
    taskRerollBadge,
    taskRerollProtection,
    taskAutoReroll,
    taskRerollWalk,
    remainingXP,
    xpTracker,
    skillCheckpoints,
    lootLogStats,
    lootLogPivot,
    housePanelObserver,
    settingsUI,
    whatsNew,
    forkBackupPrompt,
    transmuteRates,
    viewActionButton,
    transmuteHistoryTracker,
    transmuteHistoryViewer,
    coinifyHistoryTracker,
    coinifyHistoryViewer,
    decomposeHistoryTracker,
    decomposeHistoryViewer,
    alchemyActionProtection,
    enhancementFeature,
    xphCalculator,
    enhancementItemPins,
    riskOfRuinUI,
    predictionCalibration,
    leaderboardXPTracker,
    leaderboardXPDisplay,
    emptyQueueNotification,
    communityBuffAlerts,
    labyrinthRunAlerts,
    combatConsumableAlerts,
    labyrinthEntryAlerts,
    combatDeathAlerts,
    skillLevelUpAlerts,
    ttlTargetAlerts,
    enhancementTargetAlerts,
    taskSlotAlerts,
    marketUndercutAlerts,
    notificationService,
    noticeLogPanel,
    queueMonitor,
    sessionBriefing,
    accountView,
    pformancePanel,
    healthStatus,
    schemaCanary,
    selectorAudit,
    consumablesPanel,
    combatLevelPanel,
    ironCowFarmPanel,
    combatText,
    dpsPanel,
    deathsPanel,
    profitPanel,
    partyLootPanel,
    combatProfitView,
    taskCompletionTracker,
    lootLogHistory,
    enhancementStorage,
};

console.log('[Toolasha] UI library loaded');
