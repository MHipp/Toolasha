/**
 * Settings Configuration
 * Organizes all script settings into logical groups for the settings UI
 */

import { loadoutSnapshot } from '../utils/bundle-bridge.js';
import { isTestServer } from '../utils/game-server.js';

export const settingsGroups = {
    ironCow: {
        title: 'Iron Cow Mode',
        icon: '🐄',
        settings: {
            ironCow_enabled: {
                id: 'ironCow_enabled',
                label: 'Iron Cow Mode',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'Disable all market and profit features for a no-marketplace playthrough.',
            },
        },
    },

    general: {
        title: 'General Settings',
        icon: '⚙️',
        settings: {
            whatsNew_showPopup: {
                id: 'whatsNew_showPopup',
                label: "Show what's new after an update",
                type: 'checkbox',
                default: true,
                help:
                    'Once per new version, shows what changed and lists any new settings with live switches — ' +
                    'so an update never quietly rearranges things.',
            },
            whatsNew_newDefaultsOff: {
                id: 'whatsNew_newDefaultsOff',
                label: 'New settings start turned off',
                type: 'checkbox',
                default: false,
                help:
                    'When an update introduces a new on-by-default switch, keep it off until you turn it on ' +
                    'yourself. Numbers and dropdowns keep their defaults — only behaviour switches are held back.',
            },
            mobileMode: {
                id: 'mobileMode',
                label: 'Mobile mode',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto-detect' },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                ],
                help:
                    'Adjusts for touch screens: bigger resize grips, panels sized to the viewport. Auto-detect keys ' +
                    'on whether the primary pointer is a finger, which a touchscreen laptop can override here.',
            },
            chatCommands: {
                id: 'chatCommands',
                label: 'Enable chat commands (/item, /wiki, /market)',
                type: 'checkbox',
                default: true,
                help: 'Type /item, /wiki, or /market followed by an item name in chat. Example: /item radiant fiber',
            },
            chat_mentionTracker: {
                id: 'chat_mentionTracker',
                label: 'Show badge when mentioned in chat',
                type: 'checkbox',
                default: true,
                help: 'Displays a red badge on chat tabs when someone @mentions you',
            },
            chat_profileLink: {
                id: 'chat_profileLink',
                label: 'Chat: Clickable names in announcements',
                type: 'checkbox',
                default: true,
                help: 'Makes the player name in system announcements (e.g. "PlayerName has reached level 150 Magic!" or "PlayerName has joined the guild!") clickable — clicking it fills "/profile name" into the chat input.',
            },
            chat_popOut: {
                id: 'chat_popOut',
                label: 'Enable Pop-out Chat Window button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to the chat panel to open chat in a separate browser window with multi-channel split view',
            },
            chatHistoryExtender: {
                id: 'chatHistoryExtender',
                label: 'Chat: Extend chat history',
                type: 'checkbox',
                default: true,
                help: 'Preserves messages that the game removes from the live buffer, keeping them visible above the live chat',
            },
            chatHistoryExtender_maxHistory: {
                id: 'chatHistoryExtender_maxHistory',
                label: 'Chat: Max messages to retain per tab',
                type: 'text',
                default: '150',
            },
            altClickNavigation: {
                id: 'altClickNavigation',
                label: 'Alt+click items to navigate to crafting/gathering or dictionary',
                type: 'checkbox',
                default: true,
                help: 'Hold Alt/Option and click any item to navigate to its crafting/gathering page, or item dictionary if not craftable',
            },
            collectionNavigation: {
                id: 'collectionNavigation',
                label: 'Add navigation buttons to collection items',
                type: 'checkbox',
                default: true,
                help: 'Adds View Action and Item Dictionary buttons when clicking collection items',
            },
            queueMonitor: {
                id: 'queueMonitor',
                label: 'Cross-character queue monitor',
                type: 'checkbox',
                default: false,
                help: 'Shows estimated queue time remaining for your other characters in a floating widget',
            },
            characterSelect_activityStatus: {
                id: 'characterSelect_activityStatus',
                label: 'Character select: Show activity status',
                type: 'checkbox',
                default: true,
                help: 'On the character-select screen, shows what each character is expected to be doing and the earliest point it may need attention (action or queue end, materials, or offline cap)',
            },
            startupRecovery_autoReload: {
                id: 'startupRecovery_autoReload',
                label: 'Recover by itself when Toolasha misses the login data',
                type: 'checkbox',
                default: false,
                help:
                    'Once in a while the game sends its opening character data a moment before Toolasha is ' +
                    'listening, and there is no second copy — every panel stays empty for the rest of the ' +
                    'session. Left off, you are asked: the offer arrives as a notice with a Reload button, so ' +
                    'nothing is lost either way. Turn this on and, when that has actually happened and only ' +
                    'then, the connection is dropped about five seconds in, before you have clicked anything: ' +
                    'the game opens a new one by itself and the data arrives with it, so nothing you have typed ' +
                    'or opened is lost. Only if that has not worked a few seconds later does the page reload. A ' +
                    'page that comes back broken always asks rather than trying again.',
            },
        },
    },

    actionBar: {
        title: 'Action Bar',
        icon: '⚡',
        settings: {
            actionBar_enabled: {
                id: 'actionBar_enabled',
                label: 'Action bar: Enable action bar display',
                type: 'checkbox',
                default: true,
            },
            actionBar_compactWidth: {
                id: 'actionBar_compactWidth',
                label: 'Action bar: Compact width (800px limit)',
                type: 'checkbox',
                default: false,
                help: 'Limits action bar width to 800px and clips instead of wrapping. Useful for wide monitors. Always on in mobile mode, where clipping the long stats line keeps it from overflowing the narrow header.',
            },
            actionBar_showQueueCount: {
                id: 'actionBar_showQueueCount',
                label: 'Action bar: Queue/remaining count',
                type: 'checkbox',
                default: true,
            },
            actionBar_showActionDuration: {
                id: 'actionBar_showActionDuration',
                label: 'Action bar: Time per action (e.g. 14.94s/action)',
                type: 'checkbox',
                default: true,
            },
            actionBar_showActionsPerHour: {
                id: 'actionBar_showActionsPerHour',
                label: 'Action bar: Actions/hr and items/hr',
                type: 'checkbox',
                default: true,
            },
            actionBar_showTimeRemaining: {
                id: 'actionBar_showTimeRemaining',
                label: 'Action bar: Time remaining and completion ETA',
                type: 'checkbox',
                default: true,
            },
            actionBar_showRecycleTime: {
                id: 'actionBar_showRecycleTime',
                label: 'Action bar: Transmute recycle time estimate',
                type: 'checkbox',
                default: true,
                help: 'Shows estimated total time accounting for self-return recycling during transmute actions',
            },
            actionBar_showProfit: {
                id: 'actionBar_showProfit',
                label: 'Action bar: Show current action profit',
                type: 'checkbox',
                default: false,
                help: 'Displays profit/hr and remaining profit for the current action (gathering and production)',
            },
            actionPanel_liveCountdown: {
                id: 'actionPanel_liveCountdown',
                label: 'Action bar: Live countdown timer',
                type: 'checkbox',
                default: false,
                help: 'Replaces the static time display on the action progress bar with a live countdown in seconds',
            },
            actionTiming_monitor: {
                id: 'actionTiming_monitor',
                label: 'Action bar: Timing diagnostic',
                type: 'checkbox',
                default: false,
                help: 'Diagnostic. Measures how long each action really takes from the progress bar animation and records the ones where the bar finishes early and then sits full. Read the results with Toolasha.Debug.actionTimingReport() in the browser console.',
            },
        },
    },

    skillPageTiles: {
        title: 'Skill Page & Tiles',
        icon: '🗃️',
        settings: {
            actionPanel_showFilter: {
                id: 'actionPanel_showFilter',
                label: 'Skill page: Filter actions input',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showSort: {
                id: 'actionPanel_showSort',
                label: 'Skill page: Sort button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showPricingMode: {
                id: 'actionPanel_showPricingMode',
                label: 'Skill page: Pricing mode button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showCraftToggle: {
                id: 'actionPanel_showCraftToggle',
                label: 'Skill page: Craft toggle button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showProfitPerHour_gathering: {
                id: 'actionPanel_showProfitPerHour_gathering',
                label: 'Action page: Show profit/hr on gathering tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
            },
            actionPanel_showProfitPerHour_production: {
                id: 'actionPanel_showProfitPerHour_production',
                label: 'Action page: Show profit/hr on production tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hr on production action tiles (Crafting, Tailoring, etc.)',
            },
            actionPanel_showExpPerHour_gathering: {
                id: 'actionPanel_showExpPerHour_gathering',
                label: 'Action page: Show exp/hr on gathering tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays exp/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
            },
            actionPanel_showExpPerHour_production: {
                id: 'actionPanel_showExpPerHour_production',
                label: 'Action page: Show exp/hr on production tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays exp/hr on production action tiles (Crafting, Tailoring, etc.)',
            },
            actionPanel_hideNegativeProfit: {
                id: 'actionPanel_hideNegativeProfit',
                label: 'Action panel: Hide actions with negative profit',
                type: 'checkbox',
                default: false,
                help: 'Hides action panels that would result in a loss (negative profit/hr)',
            },
            inventoryCountDisplay: {
                id: 'inventoryCountDisplay',
                label: 'Action panels: Show current inventory count of output item',
                type: 'checkbox',
                default: true,
                help: 'Shows how many of the output item you currently own, on action tiles and in the action detail panel',
            },
            actions_pinnedPage: {
                id: 'actions_pinnedPage',
                label: 'Pinned actions: Enable pinned actions page and pin icons',
                type: 'checkbox',
                default: true,
                help: 'Adds a Pinned button to the left nav bar showing all pinned actions, and shows pin icons on action tiles.',
            },
        },
    },

    actionPanel: {
        title: 'Action Panel',
        icon: '📄',
        settings: {
            actionPanel_totalTime_quickInputs: {
                id: 'actionPanel_totalTime_quickInputs',
                label: 'Action panel: Quick input buttons (hours, count presets, Max)',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
            },
            actionPanel_quickInputs_countPresets: {
                id: 'actionPanel_quickInputs_countPresets',
                label: 'Action panel: Custom count presets (comma-separated, e.g. 100,1000,1000000)',
                type: 'text',
                default: '',
            },
            actionPanel_quickInputs_hourPresets: {
                id: 'actionPanel_quickInputs_hourPresets',
                label: 'Action panel: Custom hour presets (comma-separated, e.g. 0.5,1,24,168,720)',
                type: 'text',
                default: '',
            },
            actionPanel_foragingTotal: {
                id: 'actionPanel_foragingTotal',
                label: 'Action panel: Overall profit for multi-outcome foraging',
                type: 'checkbox',
                default: true,
            },
            actionPanel_outputTotals: {
                id: 'actionPanel_outputTotals',
                label: 'Action panel: Show total expected outputs below per-action outputs',
                type: 'checkbox',
                default: true,
                help: 'Displays calculated totals when you enter a quantity in the action input',
            },
            actionPanel_maxProduceable: {
                id: 'actionPanel_maxProduceable',
                label: 'Action panel: Show max produceable count on crafting actions',
                type: 'checkbox',
                default: true,
                help: 'Displays how many items you can make based on current inventory',
            },
            actionPanel_showProfitDetail: {
                id: 'actionPanel_showProfitDetail',
                label: 'Action panel: Show profitability detail',
                type: 'checkbox',
                default: true,
                help: 'Displays the profitability breakdown section inside gathering, production, and alchemy action panels',
            },
            actionPanel_showLevelProgress: {
                id: 'actionPanel_showLevelProgress',
                label: 'Action panel: Show level progress',
                type: 'checkbox',
                default: true,
                help: 'Displays XP and level progress estimates inside action panels',
            },
            actionPanel_showSpeedTime: {
                id: 'actionPanel_showSpeedTime',
                label: 'Action panel: Show action speed & time',
                type: 'checkbox',
                default: true,
                help: 'Displays speed breakdown, efficiency, and total time inside action panels',
            },
            requiredMaterials: {
                id: 'requiredMaterials',
                label: 'Action panel: Show total required and missing materials',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Displays total materials needed and shortfall when entering quantity',
            },
            actionPanel_enhanceMatLimitProtections: {
                id: 'actionPanel_enhanceMatLimitProtections',
                label: 'Enhancement material limit: Include protection items',
                type: 'checkbox',
                default: true,
                help: 'When enabled, protection item availability is factored into the material limit estimate. Disable to see material limit based only on enhancement materials.',
            },
        },
    },

    actionQueue: {
        title: 'Action Queue',
        icon: '📌',
        settings: {
            actionQueue: {
                id: 'actionQueue',
                label: 'Queued actions: Show total time and completion time',
                type: 'checkbox',
                default: true,
            },
            actionQueue_showValue: {
                id: 'actionQueue_showValue',
                label: 'Queued actions: Show profit/value for queued actions',
                type: 'checkbox',
                default: true,
            },
            actionQueue_valueMode: {
                id: 'actionQueue_valueMode',
                label: 'Queued actions: Value calculation mode',
                type: 'select',
                default: 'profit',
                options: [
                    { value: 'profit', label: 'Total Profit (revenue - all costs)' },
                    { value: 'estimated_value', label: 'Estimated Value (revenue after tax)' },
                ],
                help: 'Choose how to calculate the total value for queued actions. Profit shows net earnings after materials and drinks. Estimated Value shows gross revenue after market tax (always positive).',
            },
        },
    },

    alchemy: {
        title: 'Alchemy',
        icon: '⚗️',
        settings: {
            alchemy_profitDisplay: {
                id: 'alchemy_profitDisplay',
                label: 'Alchemy panel: Show profit calculator',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hour and profit/day for alchemy actions based on success rate and market prices',
            },
            alchemy_bestItems: {
                id: 'alchemy_bestItems',
                label: 'Alchemy panel: Show best items button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to see items ranked by profit or XP for each alchemy type.',
            },
            alchemyItemPins: {
                id: 'alchemyItemPins',
                label: 'Alchemy panel: Pin items in the item picker',
                type: 'checkbox',
                default: true,
                help: 'Adds a 📌 to each item in the Alchemize Item list that moves it to the front. Kept per action, since what is worth coinifying is rarely what is worth decomposing. Pins reorder but do not exempt: a pinned item that does not match the filter box stays hidden',
            },
            alchemy_transmuteHistory: {
                id: 'alchemy_transmuteHistory',
                label: 'Alchemy panel: Track and view transmute session history',
                type: 'checkbox',
                default: true,
                help: 'Records transmutation sessions and displays history in a viewer tab in the Alchemy panel',
            },
            alchemy_coinifyHistory: {
                id: 'alchemy_coinifyHistory',
                label: 'Alchemy panel: Track and view coinify session history',
                type: 'checkbox',
                default: true,
                help: 'Records coinify sessions and displays history in a viewer tab in the Alchemy panel',
            },
            alchemy_decomposeHistory: {
                id: 'alchemy_decomposeHistory',
                label: 'Alchemy panel: Track and view decompose session history',
                type: 'checkbox',
                default: true,
                help: 'Records decompose sessions and displays history in a viewer tab in the Alchemy panel',
            },
            alchemy_actionProtection: {
                id: 'alchemy_actionProtection',
                label: 'Alchemy panel: Protect categories from accidental alchemy actions',
                type: 'checkbox',
                default: true,
                help: 'Blocks alchemy action buttons for 3 seconds when the selected item belongs to a protected category. A shield icon appears in the alchemy panel to configure protected categories.',
            },
            alchemyItemDimming: {
                id: 'alchemyItemDimming',
                label: 'Alchemy panel: Dim items requiring higher level',
                type: 'checkbox',
                default: true,
            },
        },
    },

    missingMaterials: {
        title: 'Missing Materials & Crafting Plan',
        icon: '🛒',
        settings: {
            actionPanelLayout: {
                id: 'actionPanelLayout',
                label: 'Keep the action panel on screen',
                type: 'checkbox',
                default: true,
                help: 'Stops the action detail panel growing past the window: it scrolls instead, and the Queue and Start buttons stay pinned to the bottom rather than falling off it. Also tightens the spacing of the added sections.',
            },
            actions_missingMaterialsButton: {
                id: 'actions_missingMaterialsButton',
                label: 'Show "Missing Mats Marketplace" button on production panels',
                type: 'checkbox',
                default: true,
                help: 'Adds button to production panels that opens marketplace with tabs for missing materials',
            },
            actions_missingMaterialsButton_ignoreQueue: {
                id: 'actions_missingMaterialsButton_ignoreQueue',
                label: 'Ignore queued actions when calculating missing materials',
                type: 'checkbox',
                default: false,
                help: 'When enabled, missing materials calculation only considers current action request, ignoring materials already reserved by queued actions. Default (off) accounts for queue.',
            },
            actions_budgetCalculator: {
                id: 'actions_budgetCalculator',
                label: 'Action panel: Budget calculator',
                type: 'checkbox',
                default: true,
                help: 'Adds a budget input below the Missing Mats button. Enter a gold budget (e.g. 50m) to calculate how many units you can produce by buying missing tradeable materials at ask price.',
            },
            actions_costSummary: {
                id: 'actions_costSummary',
                label: 'Action panel: Show cost summary',
                type: 'checkbox',
                default: true,
                help: 'Compact 4-line cost comparison for the selected produce quantity: direct recipe cost, missing direct mats, best crafting plan, and finished item market price.',
            },
            actions_arbitrageBoard: {
                id: 'actions_arbitrageBoard',
                label: 'Skill pages: Production arbitrage board',
                type: 'checkbox',
                default: true,
                help: 'Adds an "Arbitrage" button to the cheesesmithing, crafting, tailoring, cooking and brewing pages that opens one ranked table of every recipe: your material cost per unit, sale value after tax, margin per unit, action, hour and day (bounded by what the market absorbs), level requirement and a data-quality flag. Click a row to open the action.',
            },
            actionPanel_bestCraftingPlan: {
                id: 'actionPanel_bestCraftingPlan',
                label: 'Action panel: Show best crafting plan',
                type: 'checkbox',
                default: true,
                help: 'Shows the cheapest way to obtain a crafted item by comparing buy vs craft at each material tier.',
            },
            actionPanel_craftingPlanBuyIntermediates: {
                id: 'actionPanel_craftingPlanBuyIntermediates',
                label: 'Action panel: Crafting plan buys raw materials only',
                type: 'checkbox',
                default: false,
                help: 'Always craft items that have a recipe — only buy uncraftable raw materials from the market.',
            },
            actionPanel_craftingPlanNoProcessing: {
                id: 'actionPanel_craftingPlanNoProcessing',
                label: 'Action panel: Crafting plan no processing',
                type: 'checkbox',
                default: false,
                help: 'Only craft the final item — buy all sub-materials from the market instead of processing them yourself.',
            },
            actionPanel_craftingPlanTaskMode: {
                id: 'actionPanel_craftingPlanTaskMode',
                label: 'Action panel: Crafting plan task mode',
                type: 'checkbox',
                default: false,
                help: 'Forces the final craft step (for task credit) but allows buying intermediate materials if cheaper.',
            },
            actionPanel_craftingPlanTimeCost: {
                id: 'actionPanel_craftingPlanTimeCost',
                label: 'Action panel: Crafting plan time cost',
                type: 'checkbox',
                default: false,
                help: 'Factor in the time cost of crafting when deciding buy vs craft. Uses your gold/hr value to determine if crafting is worth your time.',
            },
            actionPanel_craftingPlanGoldPerHour: {
                id: 'actionPanel_craftingPlanGoldPerHour',
                label: 'Action panel: Crafting plan gold/hr value',
                type: 'number',
                default: 0,
                help: 'Your time value in gold per hour. Used to calculate if crafting intermediates is worth the time. Set to your typical hourly profit (e.g., 500000).',
            },
            actionPanel_craftingPlanThinMarket: {
                id: 'actionPanel_craftingPlanThinMarket',
                label: 'Action panel: Crafting plan re-routes thin buys to craft',
                type: 'checkbox',
                default: false,
                help: 'When the plan would buy an intermediate but the community price data shows fewer units listed at that cheap ask than the plan needs, craft it instead so the plan stays achievable. Only acts when the data positively shows a thin listing; falls back to buying when no depth is known. Never overrides "buys raw materials only" or "no processing".',
            },
            craftingPlan_guidedWalk: {
                id: 'craftingPlan_guidedWalk',
                label: 'Crafting plan: guided walk through the plan, one step at a time',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a “Start guided walk” button under the plan’s crafting steps. The walk takes the ' +
                    'steps leaves first: for each one it opens the game on that action and types the count into ' +
                    'the game’s own box, then waits — it never presses the button, so one click is always ' +
                    'exactly one game action. A step the plan says to buy opens the marketplace instead and waits ' +
                    'for the item to arrive. Skip and Stop are on the strip; a reload or a character switch ends it.',
            },
            inventoryReservations: {
                id: 'inventoryReservations',
                label: 'Share one inventory between plans (reservation ledger)',
                type: 'checkbox',
                default: false,
                help: 'Every plan works out what it is short of against the same bag, so two plans that each need 500 logs both read those 500 as theirs and both say nothing is missing. With this on, a plan writes down what it has claimed and the others plan against what is left — the goal planner and the crafting plan hold their claims until you change or delete them, the missing-materials and budget panels hold theirs only while they are open, and an item queued for selling stops counting as a crafting material. Where a shortfall exists only because something else claimed the stock first, the line says which plan claimed it.',
            },
            actions_artisanMaterialMode: {
                id: 'actions_artisanMaterialMode',
                label: 'Missing materials: Artisan requirement mode',
                type: 'select',
                default: 'expected',
                options: [
                    { value: 'expected', label: 'Expected value (average)' },
                    { value: 'worst-case', label: 'Worst-case per action (ceil per craft)' },
                    { value: 'hybrid', label: 'Hybrid (ceil below 100 actions, average at 100+)' },
                ],
                help: 'How missing materials accounts for Artisan Tea reductions when suggesting what to buy. Expected value averages the fractional saving across the whole queue — right for long queues, but it can under-buy on a short one, since a single craft still consumes whole units. Worst-case ceils every craft — right for a handful of actions, but on a long queue it over-buys by up to one unit per craft. Hybrid uses worst-case below 100 actions and expected value at 100 or more, which is the right end of that trade in each case.',
            },
        },
    },

    lootLog: {
        title: 'Loot Log',
        icon: '📦',
        settings: {
            treasureTracker_popup: {
                id: 'treasureTracker_popup',
                label: "Treasure Tracker: Pop up what an opening paid, beside the game's loot dialog",
                type: 'checkbox',
                default: true,
                help: "The game's Opened Loot dialog says what you got; this says whether it was good, item by item, against what the drop table owed",
            },
            treasureTracker: {
                id: 'treasureTracker',
                label: 'Treasure Tracker: Record chest openings and compare against expected value',
                type: 'checkbox',
                default: true,
                help: 'Tracks what every chest you open actually paid out against what its drop table says it owes. Open the panel from the Treasure button on the settings page',
            },
            watchlist: {
                id: 'watchlist',
                label: "Watchlist: Track chosen items, a zone's drops, or a chest's contents",
                type: 'checkbox',
                default: true,
                help: 'A list of items with what you hold and what it is worth. Tick a combat zone to add everything it drops, or a chest to add everything it contains. Tracked items get a dot in the inventory, and anything the vendor pays more for than the market is flagged. Open it from the Watchlist overlay row',
            },
            watchlist_menuButton: {
                id: 'watchlist_menuButton',
                label: 'Watchlist: Add a Track button to the item menu in your inventory',
                type: 'checkbox',
                default: false,
                help: 'Puts a Track / Untrack button beside Sell when you click an inventory item. Off by default because it changes a menu you use for other things — the Watchlist panel has the same switch',
            },
            watchlist_inventoryDots: {
                id: 'watchlist_inventoryDots',
                label: 'Watchlist: Dot tracked items in the inventory',
                type: 'checkbox',
                default: true,
                help: 'Puts a small dot in the corner of every inventory tile holding a tracked item. The point of a watchlist is knowing what is on it while you are looking at your inventory rather than while you are looking at the list — but it is one more mark on a busy grid, so it can be turned off. The Watchlist panel has the same switch',
            },
            equipmentSavings_menuButton: {
                id: 'equipmentSavings_menuButton',
                label: 'Equipment Savings: Add a Save for button to the item menu',
                type: 'checkbox',
                default: false,
                help: 'Puts a Save for / Stop saving button beside Sell when you click a piece of equipment, which is how a target gets onto the Equipment Savings list. Off by default because it changes a menu you use for other things',
            },
            combatText_floating: {
                id: 'combatText_floating',
                label: 'Floating Combat Text: Damage numbers over the units taking them',
                type: 'checkbox',
                default: false,
                help: 'A health bar tells you the state, not the event — "did that hit for 400 or 4,000" is a question a number answers and a bar does not',
            },
            combatText_scrolling: {
                id: 'combatText_scrolling',
                label: 'Scrolling Combat Text: Keep a log of recent hits',
                type: 'checkbox',
                default: false,
                help: 'Adds a Combat Log overlay row with the last few hits, for anything that went past too fast to read',
            },
            manaTracker: {
                id: 'manaTracker',
                label: 'Mana Tracker: Count what your abilities cost per fight',
                type: 'checkbox',
                default: true,
                help: 'Mana is the constraint nobody watches — it shows up only as the moment an ability does not fire. Adds a Mana/fight overlay row',
            },
            lootLogStats: {
                id: 'lootLogStats',
                label: 'Loot Log Statistics',
                type: 'checkbox',
                default: true,
                help: 'Display total value, average time, and daily output in loot logs',
            },
            lootLogHistory: {
                id: 'lootLogHistory',
                label: 'Loot Log: Persist and display historical entries',
                type: 'checkbox',
                default: true,
                help: 'Saves loot log entries and displays older entries below current ones in the loot log panel',
            },
            lootLogPivot: {
                id: 'lootLogPivot',
                label: 'Loot Log: Analytics pivot table (📊 button beside Refresh)',
                type: 'checkbox',
                default: false,
                help: 'Every other XP/hr and gold/hr figure in this script is predicted from game data; this is the one built from what your runs actually paid. A sortable table over the current session plus stored history — one row per action and per difficulty tier, with time spent, drop value at ask and bid, and XP/hr per skill (plus a combined line for actions that train several). Off by default because it adds a button to the game’s own panel',
            },
            lootLogDropLuck: {
                id: 'lootLogDropLuck',
                label: 'Loot Log: Drop luck percentile for gathering runs',
                type: 'checkbox',
                default: true,
                help: "Places a run's drop value in the distribution of everything those actions could have paid — 50 is typical, 5 means nineteen runs in twenty do better. Only for actions with their own drop table (gathering); combat has its own verdict and production rolls nothing",
            },
            lootLogEnhancingCost: {
                id: 'lootLogEnhancingCost',
                label: 'Loot Log: Enhancing cost, luck and profit',
                type: 'checkbox',
                default: false,
                help: 'Adds a summary to enhancing loot-log entries: material and protection cost vs the statistically expected cost (how lucky the run was), and the profit — the finished item’s after-fee value minus the base and what you spent. Reconstructed from the run’s per-level results, assuming the cost-optimal protect level.',
            },
        },
    },

    tooltips: {
        title: 'Item Tooltip Enhancements',
        icon: '💬',
        settings: {
            itemTooltip_prices: {
                id: 'itemTooltip_prices',
                label: 'Show 24-hour average market prices',
                type: 'checkbox',
                default: true,
            },
            itemTooltip_effectivePrices: {
                id: 'itemTooltip_effectivePrices',
                label: 'Show effective (after-tax) prices',
                type: 'checkbox',
                default: false,
                help: 'Shows what you actually receive after the 5% marketplace tax next to ask/bid prices in item tooltips',
            },
            itemTooltip_artisanPrices: {
                id: 'itemTooltip_artisanPrices',
                label: 'Adjust tooltip prices for Artisan Tea reduction',
                type: 'checkbox',
                default: true,
                help: 'When viewing a recipe on an action panel, adjusts the total price to reflect actual material cost after Artisan Tea reduction',
            },
            itemTooltip_profit: {
                id: 'itemTooltip_profit',
                label: 'Show production cost and profit',
                type: 'checkbox',
                default: true,
            },
            itemTooltip_ownUseCompare: {
                id: 'itemTooltip_ownUseCompare',
                label: 'Show make-vs-buy line for own use (no sales tax)',
                type: 'checkbox',
                default: true,
                help: 'Adds a line to the profit section comparing buying the item at the current ask against crafting it for your own consumption — materials and teas at your efficiency, with no sales tax on either side, since a dungeon key or a meal you use is never sold. The profit figures above it stay seller-priced.',
            },
            itemTooltip_detailedProfit: {
                id: 'itemTooltip_detailedProfit',
                label: 'Show detailed materials breakdown in profit display',
                type: 'checkbox',
                default: false,
                help: 'Shows material costs table with Ask/Bid prices, actions/hour, and profit breakdown',
            },
            itemTooltip_detailedProfitFlat: {
                id: 'itemTooltip_detailedProfitFlat',
                label: 'Profit: direct recipe only (buy base items, no sub-craft chain)',
                type: 'checkbox',
                default: false,
                help: 'Costs each recipe ingredient at its own market Ask/Bid and stops there, instead of recursing into how a craftable ingredient is itself made. The detailed breakdown collapses to the direct ingredients, and the profit/hr is figured for buying the base items and crafting just this one step (no upgrade-item craft cost or chain time). Overrides "Use crafting cost for upgrade items if cheaper" while on.',
            },
            itemTooltip_multiActionProfit: {
                id: 'itemTooltip_multiActionProfit',
                label: 'Show profit comparison for all item actions',
                type: 'checkbox',
                default: false,
                help: 'Displays best profit/hr highlighted, with other alternative actions (craft, coinify, decompose, transmute) summarized below',
            },
            itemTooltip_expectedValue: {
                id: 'itemTooltip_expectedValue',
                label: 'Show expected value for openable containers',
                type: 'checkbox',
                default: true,
            },
            expectedValue_showDrops: {
                id: 'expectedValue_showDrops',
                label: 'Expected value drop display',
                type: 'select',
                default: 'All',
                options: [
                    { value: 'Top 5', label: 'Top 5' },
                    { value: 'Top 10', label: 'Top 10' },
                    { value: 'All', label: 'All Drops' },
                    { value: 'None', label: 'Summary Only' },
                ],
            },
            expectedValue_respectPricingMode: {
                id: 'expectedValue_respectPricingMode',
                label: 'Use pricing mode for expected value calculations',
                type: 'checkbox',
                default: true,
            },
            expectedValue_includeCowbells: {
                id: 'expectedValue_includeCowbells',
                label: 'Include cowbell value in expected value calculations',
                type: 'checkbox',
                default: true,
            },
            showConsumTips: {
                id: 'showConsumTips',
                label: 'HP/MP consumables: Restore speed, cost performance',
                type: 'checkbox',
                default: true,
            },
            dungeonTokenTooltips: {
                id: 'dungeonTokenTooltips',
                label: 'Currency tooltips: Show shop values for tokens, seals, and cowbells',
                type: 'checkbox',
                default: true,
            },
            itemTooltip_gathering: {
                id: 'itemTooltip_gathering',
                label: 'Show gathering sources and profit',
                type: 'checkbox',
                default: true,
                help: 'Shows gathering actions that produce this item (foraging, woodcutting, milking)',
            },
            itemTooltip_gatheringRareDrops: {
                id: 'itemTooltip_gatheringRareDrops',
                label: 'Show rare drops from gathering',
                type: 'checkbox',
                default: true,
                help: 'Shows rare find drops from gathering zones (e.g., Thread of Expertise from Asteroid Belt)',
            },
            itemTooltip_abilityStatus: {
                id: 'itemTooltip_abilityStatus',
                label: 'Show ability book status',
                type: 'checkbox',
                default: true,
                help: 'Shows whether ability is learned and current level/progress on ability book tooltips',
            },
            itemTooltip_abilityFreshCost: {
                id: 'itemTooltip_abilityFreshCost',
                label: 'Show fresh-to-level cost on ability hovers',
                type: 'checkbox',
                default: false,
                help: 'When hovering an ability (in a loadout or ability slot, including on another player’s profile), adds what it would cost to buy that ability up to the level shown. Uses the level in the tooltip, so it is correct on other players’ profiles too.',
            },
            abilityTooltip_effectiveTiming: {
                id: 'abilityTooltip_effectiveTiming',
                label: 'Show effective cooldown/cast time on ability hovers',
                type: 'checkbox',
                default: true,
                help: 'The game’s ability tooltip always shows base Cooldown and Cast Time. This adds, in parentheses, what they actually are with your Ability Haste, Cast Speed and Attack level applied — and adds nothing when the figures match.',
            },
            itemTooltip_enhancementMilestones: {
                id: 'itemTooltip_enhancementMilestones',
                label: 'Show enhancement milestones (+5/+7/+10/+12)',
                type: 'checkbox',
                default: false,
                help: 'Shows expected cost and XP to reach +5, +7, +10, and +12 on unenhanced equipment tooltips',
            },
            itemTooltip_enhancementPath: {
                id: 'itemTooltip_enhancementPath',
                label: 'Show enhancement path on enhanced items',
                type: 'checkbox',
                default: true,
                help: 'Shows the optimal enhancement path cost breakdown when hovering over enhanced (+1 to +20) items',
            },
            itemTooltip_enhancementProRates: {
                id: 'itemTooltip_enhancementProRates',
                label: 'Quote enhancement predictions at pro rates instead of your stats',
                type: 'checkbox',
                default: false,
                help: 'Prices the enhancement path and milestones as a top-end enhancer (level 140, Observatory 8, ultra + blessed tea, +13 Celestial enhancer, +10 gear) instead of your own gear and level. Also toggled from the "Yours / Pro" chip on the tooltip section header, or by pressing P while the tooltip is open.',
            },
            itemTooltip_enhancingHourlyRate: {
                id: 'itemTooltip_enhancingHourlyRate',
                label: 'Target hourly rate for enhancing (e.g. 50m)',
                type: 'text',
                default: '',
                help: 'Adds a minimum sell price to the enhancement tooltip that covers total cost plus this rate for time spent. Leave blank to disable.',
            },
            itemTooltip_enhancingHourlyRateTax: {
                id: 'itemTooltip_enhancingHourlyRateTax',
                label: 'Include marketplace tax in minimum sell price',
                type: 'checkbox',
                default: false,
                help: 'Accounts for the 5% marketplace seller tax so listing at minimum sell still nets your target rate after tax',
            },
            itemTooltip_pinTop: {
                id: 'itemTooltip_pinTop',
                label: 'Pin tooltips to top-center of screen',
                type: 'checkbox',
                default: false,
                help: 'Forces item tooltips to always appear centered at the top of the screen instead of near the hovered item',
            },
            itemTooltip_hideInEnhanceSelector: {
                id: 'itemTooltip_hideInEnhanceSelector',
                label: 'Hide tooltip extras in enhance item selector',
                type: 'checkbox',
                default: false,
                help: 'Suppresses injected tooltip content (prices, profit, milestones) when browsing items in the enhancement selector',
            },
            itemDictionary_transmuteRates: {
                id: 'itemDictionary_transmuteRates',
                label: 'Item Dictionary: Show transmutation success rates',
                type: 'checkbox',
                default: true,
                help: 'Displays success rate percentages in the "Transmuted From (Alchemy)" section',
            },
            itemDictionary_transmuteIncludeBaseRate: {
                id: 'itemDictionary_transmuteIncludeBaseRate',
                label: 'Item Dictionary: Include base success rate in transmutation percentages',
                type: 'checkbox',
                default: true,
                help: 'When enabled, shows total probability (base rate × drop rate). When disabled, shows conditional probability (drop rate only, matching "Transmutes Into" section)',
            },
        },
    },

    enhancementSimulator: {
        title: 'Enhancement Simulator Settings',
        icon: '✨',
        settings: {
            enhanceSim: {
                id: 'enhanceSim',
                label: 'Show enhancement simulator calculations',
                type: 'checkbox',
                default: true,
            },
            enhanceSim_baseItemCraftingCost: {
                id: 'enhanceSim_baseItemCraftingCost',
                label: 'Enhancement path: Use crafting cost for base item if cheaper',
                type: 'checkbox',
                default: false,
                help: 'When enabled, uses the lower of crafting cost or market price for the base item in enhancement path calculations, applied independently to both the Ask and Bid columns',
            },
            enhanceSim_autoTargetLevel: {
                id: 'enhanceSim_autoTargetLevel',
                label: 'Enhancement: Auto-fill target level on panel open (0 = disabled)',
                type: 'number',
                default: 0,
                min: 0,
                max: 20,
                help: "When non-zero, automatically sets the Target Level input to this value whenever you open an item's enhancement panel. Re-applies each time you switch items.",
            },
            enhanceSim_autoProtectFrom: {
                id: 'enhanceSim_autoProtectFrom',
                label: 'Enhancement: Auto-fill optimal protect-from level when protection item is set',
                type: 'checkbox',
                default: false,
                help: 'When enabled, automatically fills the Protect From Level input with the optimal (cheapest) value whenever a protection item is placed in the slot.',
            },
            enhancementItemPins: {
                id: 'enhancementItemPins',
                label: 'Enhancing panel: Pin items in the item picker',
                type: 'checkbox',
                default: true,
                help: 'Adds a 📌 to each item in the Enhance Item list that moves it to the front. Pins reorder but do not exempt: a pinned item that does not match the filter box stays hidden',
            },
            enhanceSim_autoDetect: {
                id: 'enhanceSim_autoDetect',
                label: 'Auto-detect your stats (false = use settings below)',
                type: 'checkbox',
                default: false,
                help: 'Most players should leave this off to see realistic professional enhancer costs',
            },
            enhanceSim_resetProDefaults: {
                id: 'enhanceSim_resetProDefaults',
                label: 'Reset the bench below to the pro defaults',
                type: 'button',
                buttonLabel: 'Reset to pro defaults',
                help: 'Puts every setting below back to the shipped professional-enhancer bench - the same values Pro rates quote.',
            },
            // --- ENHANCING ---
            enhanceSim_enhancingLevel: {
                id: 'enhanceSim_enhancingLevel',
                label: 'Enhancing skill level',
                type: 'number',
                default: 140,
                min: 1,
                max: 200,
                help: 'Default: 140 (professional enhancer level)',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_houseLevel: {
                id: 'enhanceSim_houseLevel',
                label: 'Observatory house room level',
                type: 'number',
                default: 8,
                min: 0,
                max: 8,
                help: 'Default: 8 (max level)',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_achievement: {
                id: 'enhanceSim_achievement',
                label: 'Achievement bonus (+0.2%)',
                type: 'checkbox',
                default: true,
                help: 'Include enhancing achievement success bonus',
                disabledBy: 'enhanceSim_autoDetect',
            },
            // --- GEAR (compact rows: checkbox + optional tier + enhancement level) ---
            enhanceSim_gear_enhancer: {
                id: 'enhanceSim_gear_enhancer',
                label: 'Enhancer',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'celestial', level: 15 },
                tiers: [
                    { value: 'cheese', label: 'Cheese' },
                    { value: 'verdant', label: 'Verdant' },
                    { value: 'azure', label: 'Azure' },
                    { value: 'burble', label: 'Burble' },
                    { value: 'crimson', label: 'Crimson' },
                    { value: 'rainbow', label: 'Rainbow' },
                    { value: 'holy', label: 'Holy' },
                    { value: 'celestial', label: 'Celestial' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_gloves: {
                id: 'enhanceSim_gear_gloves',
                label: 'Gloves',
                type: 'enhanceGear',
                default: { enabled: true, level: 12 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_top: {
                id: 'enhanceSim_gear_top',
                label: 'Top',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_bottoms: {
                id: 'enhanceSim_gear_bottoms',
                label: 'Bottoms',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_neck: {
                id: 'enhanceSim_gear_neck',
                label: 'Neck',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'speed', label: 'Speed' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_ring: {
                id: 'enhanceSim_gear_ring',
                label: 'Ring',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'rarefind', label: 'Rare Find' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_earring: {
                id: 'enhanceSim_gear_earring',
                label: 'Earring',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'rarefind', label: 'Rare Find' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_cape: {
                id: 'enhanceSim_gear_cape',
                label: 'Cape',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'refined', level: 10 },
                tiers: [
                    { value: 'normal', label: 'Normal' },
                    { value: 'refined', label: 'Refined' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_guzzling: {
                id: 'enhanceSim_gear_guzzling',
                label: 'Guzzling',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_charm: {
                id: 'enhanceSim_gear_charm',
                label: 'Charm',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'grandmaster', level: 0 },
                tiers: [
                    { value: 'trainee', label: 'Trainee' },
                    { value: 'basic', label: 'Basic' },
                    { value: 'advanced', label: 'Advanced' },
                    { value: 'expert', label: 'Expert' },
                    { value: 'master', label: 'Master' },
                    { value: 'grandmaster', label: 'Grandmaster' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            // --- BUFFS ---
            enhanceSim_tea: {
                id: 'enhanceSim_tea',
                label: 'Enhancing tea',
                type: 'select',
                default: 'ultra',
                options: [
                    { value: 'none', label: 'None' },
                    { value: 'basic', label: 'Enhancing Tea (+3)' },
                    { value: 'super', label: 'Super Enhancing Tea (+6)' },
                    { value: 'ultra', label: 'Ultra Enhancing Tea (+8)' },
                ],
                help: 'Enhancing tea provides skill level bonus',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_blessedTea: {
                id: 'enhanceSim_blessedTea',
                label: 'Blessed Tea active',
                type: 'checkbox',
                default: true,
                help: 'Professional enhancers use this to reduce attempts',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_communityBuff: {
                id: 'enhanceSim_communityBuff',
                label: 'Community Buff',
                type: 'enhanceGear',
                default: { enabled: true, level: 1 },
                help: 'Enhancing speed community buff. Checked = auto-detect from game.',
                checkedMeansAuto: true,
                disabledBy: 'enhanceSim_autoDetect',
            },
        },
    },

    enhancementTracker: {
        title: 'Enhancement Tracker',
        icon: '📊',
        settings: {
            enhancementTracker: {
                id: 'enhancementTracker',
                label: 'Enable Enhancement Tracker',
                type: 'checkbox',
                default: false,
                help: 'Track enhancement attempts, costs, and statistics',
            },
            enhancementTracker_showOnlyOnEnhancingScreen: {
                id: 'enhancementTracker_showOnlyOnEnhancingScreen',
                label: 'Show tracker only on Enhancing screen',
                type: 'checkbox',
                default: false,
                help: 'Hide tracker when not on the Enhancing screen',
            },
            enhancementXPH: {
                id: 'enhancementXPH',
                label: 'Enhancement: XPH calculator',
                type: 'checkbox',
                default: true,
                help: 'Ranks all enhanceable items by expected XP per hour at your current stats',
            },
            enhancementXPH_maxLevel: {
                id: 'enhancementXPH_maxLevel',
                label: 'Enhancement XPH: Default max enhancement level (1–20)',
                type: 'text',
                default: '6',
            },
            enhancementXPH_protectFrom: {
                id: 'enhancementXPH_protectFrom',
                label: 'Enhancement XPH: Default protect from level (0 = no protection)',
                type: 'text',
                default: '0',
            },
        },
    },

    riskOfRuin: {
        title: 'Risk of Ruin',
        icon: '🎲',
        settings: {
            riskOfRuin: {
                id: 'riskOfRuin',
                label: 'Enable Risk of Ruin calculator',
                type: 'checkbox',
                default: false,
                help: 'Adds a standalone calculator estimating the chance of hitting 0 gold before reaching a target number of dungeon chests, alchemy Transmute actions, or an enhancement level.',
            },
            riskOfRuin_showLauncher: {
                id: 'riskOfRuin_showLauncher',
                label: 'Risk of Ruin: Show the corner launcher button',
                type: 'checkbox',
                default: false,
                help: 'The "Risk of Ruin" button pinned to the bottom-right corner. Turn it off (or press its ✕) to get the corner back — the ⧉ Risk of Ruin tab beside Inventory still opens the calculator.',
            },
            riskOfRuin_trials: {
                id: 'riskOfRuin_trials',
                label: 'Risk of Ruin: Monte Carlo trial count',
                type: 'text',
                default: '10000',
                help: 'Higher trial counts give a more precise probability estimate at the cost of a slower calculation.',
            },
        },
    },

    marketplace: {
        title: 'Marketplace',
        icon: '🏪',
        settings: {
            sellQueue: {
                id: 'sellQueue',
                label: 'Sell Queue (Shift+RightClick inventory items)',
                type: 'checkbox',
                default: true,
                help: 'Shift+RightClick an inventory item to open the marketplace and create a tab for it. Tabs close automatically when the item sells out.',
            },
            networkAlert: {
                id: 'networkAlert',
                label: 'Show alert when market price data cannot be fetched',
                type: 'checkbox',
                default: true,
            },
            marketFilter: {
                id: 'marketFilter',
                label: 'Marketplace: Filter by level, class, slot',
                type: 'checkbox',
                default: true,
            },
            marketSort: {
                id: 'marketSort',
                label: 'Marketplace: Sort items by profitability',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to sort marketplace items by profit/hour. Items without profit data (drop-only) appear at the end.',
            },
            marketSort_mode: {
                id: 'marketSort_mode',
                label: 'Marketplace: Sort mode',
                type: 'select',
                default: 'profit',
                options: [
                    { value: 'profit', label: 'Production/gathering profit per hour' },
                    { value: 'alchemyProfit', label: 'Alchemy profit per item' },
                    { value: 'alchemyProfitPerHour', label: 'Alchemy profit per hour' },
                ],
                help:
                    'Which figure the marketplace sort button ranks by. The alchemy modes insta-buy the item at ask, ' +
                    'run its best alchemy action, and insta-sell the outputs at bid, whatever the global pricing mode is. ' +
                    'The dropdown next to the sort button changes this too.',
            },
            fillMarketOrderPrice: {
                id: 'fillMarketOrderPrice',
                label: 'Auto-fill marketplace orders with optimal price',
                type: 'checkbox',
                default: true,
            },
            market_raiseBuyPriceToCoverQuantity: {
                id: 'market_raiseBuyPriceToCoverQuantity',
                label: 'Buy Now: raise the price until it covers the whole quantity',
                type: 'checkbox',
                default: true,
                help:
                    'When a filled buy quantity is more than the best ask has in stock, raise the price to the ' +
                    'lowest one whose listings add up to the whole amount. The price is a limit, not what every ' +
                    'unit costs: each listing still sells at its own price, so only the units the cheapest ' +
                    "listings could not cover pay more. Never goes above the modal's tradable range, never " +
                    'lowers a price, and never presses the buy button.',
            },
            market_autoFillSellStrategy: {
                id: 'market_autoFillSellStrategy',
                label: 'Auto-fill sell price strategy',
                type: 'select',
                default: 'match',
                options: [
                    { value: 'match', label: 'Match best sell price' },
                    { value: 'undercut', label: 'Undercut by 1 (best sell - 1)' },
                ],
                help: 'When creating sell listings, choose whether to match or undercut the current best sell price',
            },
            market_autoFillBuyStrategy: {
                id: 'market_autoFillBuyStrategy',
                label: 'Auto-fill buy price strategy',
                type: 'select',
                // 'match' applies to new installs only. This deliberately has no
                // entry in settings-storage.js's DEFAULT_REWRITES: an existing
                // user's stored 'outbid' (the old shipped default) is their
                // strategy, not a value to be moved off of, so it is left alone.
                default: 'match',
                options: [
                    { value: 'outbid', label: 'Outbid by 1 (best buy + 1)' },
                    { value: 'match', label: 'Match best buy price' },
                    { value: 'undercut', label: 'Undercut by 1 (best buy - 1)' },
                ],
                help: 'When creating buy listings, choose whether to outbid, match, or undercut the current best buy price',
            },
            market_autoClickMax: {
                id: 'market_autoClickMax',
                label: 'Auto-click Max button on sell listing dialogs',
                type: 'checkbox',
                default: true,
                help: 'Automatically clicks the Max button in the quantity field when opening Sell listing dialogs',
            },
            market_quickInputButtons: {
                id: 'market_quickInputButtons',
                label: 'Marketplace: Quick input buttons on order dialogs',
                type: 'checkbox',
                default: true,
                help: 'Adds 10, 100, 1000 preset quantity buttons to buy/sell dialogs',
            },
            market_quickInputButtons_presets: {
                id: 'market_quickInputButtons_presets',
                label: 'Marketplace: Custom quick input presets',
                type: 'text',
                default: '',
                help: 'Comma-separated preset values (e.g. 50,500,5000). Leave blank for defaults (10, 100, 1000). Max 8 values.',
            },
            market_multiplierButtons: {
                id: 'market_multiplierButtons',
                label: 'Marketplace: ÷2 and ×2 buttons on order dialogs',
                type: 'checkbox',
                default: true,
                help: 'Adds ÷2 and ×2 buttons to the price and quantity rows in buy/sell dialogs',
            },
            market_showOwnedInBuyModal: {
                id: 'market_showOwnedInBuyModal',
                label: 'Marketplace: Show owned count in buy dialogs',
                type: 'checkbox',
                default: true,
                help: 'Displays how many of the item you currently own in Buy Now and Buy Listing modals',
            },
            market_marketplaceShortcuts: {
                id: 'market_marketplaceShortcuts',
                label: 'Marketplace: Show "Marketplace Action" button on item menus',
                type: 'checkbox',
                default: true,
                help: 'Adds a Marketplace Action dropdown to item menus with Sell Now, Buy Now, and listing shortcuts',
            },
            market_visibleItemCount: {
                id: 'market_visibleItemCount',
                label: 'Market: Show inventory count on items',
                type: 'checkbox',
                default: true,
                help: 'Displays how many of each item you own when browsing the market',
            },
            market_visibleItemCountOpacity: {
                id: 'market_visibleItemCountOpacity',
                label: 'Market: Opacity for items not in inventory',
                type: 'slider',
                default: 0.25,
                min: 0,
                max: 1,
                step: 0.05,
                help: 'How transparent item tiles appear when you own zero of that item',
            },
            market_visibleItemCountIncludeEquipped: {
                id: 'market_visibleItemCountIncludeEquipped',
                label: 'Market: Count equipped items',
                type: 'checkbox',
                default: true,
                help: 'Include currently equipped items in the displayed count',
            },
            market_showListingPrices: {
                id: 'market_showListingPrices',
                label: 'Market: Show prices on individual listings',
                type: 'checkbox',
                default: true,
                help: 'Displays top order price and total value on each listing in My Listings table',
            },
            market_listingRefreshNavigator: {
                id: 'market_listingRefreshNavigator',
                label: 'Market: Show Refresh/Next buttons for cycling My Listings',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a "Refresh" button on My Listings that opens your first listing\'s order book, then a ' +
                    '"Next" button on each listing\'s page to move to the next one, ending in "Back to My Listings"',
            },
            market_itemHop: {
                id: 'market_itemHop',
                label: 'Market: Step between items without going back to the list',
                type: 'checkbox',
                default: true,
                help:
                    "On an item's marketplace page, [ and ] open the previous/next item from the item grid you " +
                    'came from (respecting any filter you had applied), and Escape goes back to the grid. The same ' +
                    'steps are on ◀ / ▶ buttons next to Refresh. Stepping stops at the ends of the list.',
            },
            market_collectableListingsToTop: {
                id: 'market_collectableListingsToTop',
                label: 'Market: Move collectable listings to top of My Listings',
                type: 'checkbox',
                default: true,
                help:
                    'Listings with something to collect are moved to the top so you can see what "Collect All" ' +
                    'grabbed without scrolling. Manually sorting a column takes over until sort is cleared',
            },
            market_bulkSellAssistant: {
                id: 'market_bulkSellAssistant',
                label: 'Market: Bulk Sell Assistant',
                type: 'checkbox',
                default: false,
                help: 'Adds a Bulk Sell button to the marketplace tab bar (next to Market History) that opens a floating panel for selling every tradable inventory item — most valuable stack first, optionally limited to one Toolasha inventory tab — via a prefilled sell modal for each: one confirm click per item, always in the same place. Insta-sells per the queue-age, supply-ratio, minimum-value and spread rules below; otherwise posts a sell listing.',
            },
            market_bulkSellQueueDays: {
                id: 'market_bulkSellQueueDays',
                label: 'Market: Bulk sell insta-sell queue age (days)',
                type: 'number',
                default: 2,
                min: 0,
                max: 30,
                help: 'If the oldest sell listing on an item has been waiting longer than this many days (the queue is not moving), the Bulk Sell Assistant insta-sells to the best bid instead of joining the queue. 0 turns this rule off. Default: 2.',
            },
            market_bulkSellSupplyRatio: {
                id: 'market_bulkSellSupplyRatio',
                label: 'Market: Bulk sell insta-sell supply ratio',
                type: 'number',
                default: 1,
                min: 0,
                max: 100,
                help: 'Insta-sell when sell-order supply exceeds buy-order demand × this ratio. 1 = insta-sell whenever sell orders outnumber buy orders; 2 = only when supply is at least double demand; 0 turns this rule off (only the queue-age rule insta-sells). Default: 1.',
            },
            market_bulkSellMaxSpreadPct: {
                id: 'market_bulkSellMaxSpreadPct',
                label: 'Market: Bulk sell insta-sell when the spread is under (%)',
                type: 'number',
                default: 0,
                min: 0,
                max: 100,
                help: 'Insta-sell when the gap between the best ask and the best bid is at most this percentage of the ask — with the finer price increments, a listing often earns only a sliver over selling instantly, and this rule says that sliver is not worth a listing slot and the wait. E.g. 2 insta-sells whenever ask and bid are within 2% of each other. 0 turns this rule off. Default: 0.',
            },
            market_bulkSellMinPatientPremium: {
                id: 'market_bulkSellMinPatientPremium',
                label: 'Market: Bulk sell insta-sell when a listing earns under (coins)',
                type: 'number',
                default: 0,
                min: 0,
                help: 'The spread rule in absolute coins: what the whole stack would earn by waiting in the sell queue instead of insta-selling — (ask − bid) × count, after the 5% tax. Under this amount the Bulk Sell Assistant insta-sells: the premium is not worth a listing slot and the wait. 0 turns this rule off. Default: 0.',
            },
            consumables_labPerRunBasis: {
                id: 'consumables_labPerRunBasis',
                label: 'Consumables: Labyrinth per-run basis',
                type: 'select',
                default: 'measured',
                options: [
                    { value: 'measured', label: 'Measured from recorded runs' },
                    { value: 'capacity', label: 'Full capacity every run' },
                ],
                help:
                    'What one labyrinth run is planned to consume: the average your recorded runs actually spent, ' +
                    'or the whole torch/shroud/beacon capacity every run. Also a click on the basis pill in the panel.',
            },
            consumables_idleLoadoutPlan: {
                id: 'consumables_idleLoadoutPlan',
                label: 'Consumables: plan from the default loadout while idle',
                type: 'checkbox',
                default: true,
                help: "With no combat being measured, the panel plans from the default combat loadout instead of showing nothing: drinks rated arithmetically (buff duration against drink concentration), food rated from the last combat sim's measured use for the zone it simmed — or listed unrated until a sim has run.",
            },
            market_consumableBuyMaxSpreadPct: {
                id: 'market_consumableBuyMaxSpreadPct',
                label: 'Market: Consumables buy instantly when the spread is under (%)',
                type: 'number',
                default: 2,
                min: 0,
                max: 100,
                help: 'The bulk-sell spread rule, mirrored for restocking: when the gap between the best ask and the best bid is at most this percentage of the ask, the Consumables panel recommends buying instantly — the saving from a buy order is a sliver not worth the wait. 0 turns this rule off. Default: 2.',
            },
            market_consumableBuyMinSaving: {
                id: 'market_consumableBuyMinSaving',
                label: 'Market: Consumables buy instantly when an order saves under (coins)',
                type: 'number',
                default: 0,
                min: 0,
                help: 'The same idea in absolute coins: what the whole restock would save by waiting at the bid instead of paying the ask — (ask − bid) × count. Under this amount the Consumables panel recommends buying instantly. 0 turns this rule off. Default: 0.',
            },
            market_consumableBuyMinOrderValue: {
                id: 'market_consumableBuyMinOrderValue',
                label: 'Market: Consumables minimum order value for a buy order',
                type: 'number',
                default: 0,
                min: 0,
                help: 'Restocks whose whole order (bid × count) is worth less than this are recommended as instant buys rather than using up a buy-order slot. 0 turns this rule off. Default: 0.',
            },
            market_consumableBuyOpenRecommended: {
                id: 'market_consumableBuyOpenRecommended',
                label: 'Market: Consumables buy links open the recommended order form',
                type: 'checkbox',
                default: true,
                help: "A Buy link in the Consumables panel opens the form its ⚡/⏳ recommendation points at — Buy Now for an instant buy, New Buy Listing for a patient order — with the quantity filled in, the way the Bulk Sell Assistant opens sell forms. Nothing is bought until you confirm the game's own button. Off: the link just opens the item in the marketplace with the quantity parked, as before.",
            },
            market_bulkSellVendorCheck: {
                id: 'market_bulkSellVendorCheck',
                label: 'Market: Bulk sell to vendor when market is no better',
                type: 'checkbox',
                default: true,
                help: 'When the game vendor pays at least as much per item as the market would net after the 5% tax (e.g. vendor 96 vs ask 100 → 95 net), the Bulk Sell Assistant opens the item\'s inventory menu with "All" selected so one click on "Sell For … Coins" vendors the whole stack instead. Only applies to unenhanced items.',
            },
            market_bulkSellMinListingValue: {
                id: 'market_bulkSellMinListingValue',
                label: 'Market: Bulk sell minimum stack value for a sell listing',
                type: 'number',
                default: 1500000,
                min: 0,
                help: 'Stacks worth less than this (count × ask price) are insta-sold to the best bid instead of using up a sell listing slot. 0 turns this rule off. Default: 1,500,000.',
            },
            market_tradeHistory: {
                id: 'market_tradeHistory',
                label: 'Market: Show personal trade history',
                type: 'checkbox',
                default: true,
                help: 'Displays your last buy/sell prices for items in marketplace',
            },
            market_tradeHistoryComparisonMode: {
                id: 'market_tradeHistoryComparisonMode',
                label: 'Market: Trade history comparison mode',
                type: 'select',
                default: 'instant',
                options: [
                    { value: 'instant', label: 'Instant' },
                    { value: 'listing', label: 'Orders' },
                ],
                help: 'Instant: Compare to instant buy/sell prices. Orders: Compare to buy/sell orders.',
            },
            market_tradeLedger: {
                id: 'market_tradeLedger',
                label: 'Market: Record trade ledger (realized flip profit)',
                type: 'checkbox',
                default: true,
                help: 'Passively records every fill on your own listings (partial fills included) and adds a "Ledger" tab to the marketplace showing per-item realized profit — sells matched against your average recorded buy cost, proceeds net of the 5% market tax — with weekly totals and CSV export.',
            },
            market_staleCapital: {
                id: 'market_staleCapital',
                label: 'Market: Show stale capital tab',
                type: 'checkbox',
                default: true,
                help: 'Adds a "Stale" tab to the marketplace ranking your open sell listings and buy orders by coins tied up, with each row\'s age and how its price compares to the current book.',
            },
            market_listingPricePrecision: {
                id: 'market_listingPricePrecision',
                label: 'Market: Listing price decimal precision',
                type: 'number',
                default: 1,
                min: 0,
                max: 4,
                help: 'Decimal places for the abbreviated Top Order and Total prices on My Listings (e.g. 1.2M vs 1.23M)',
            },
            market_showListingAge: {
                id: 'market_showListingAge',
                label: 'Market: Show listing age on My Listings',
                type: 'checkbox',
                default: false,
                help: 'Display how long ago each listing was created on the My Listings tab (e.g., "3h 45m")',
            },
            market_badgeOnlyWhenFinished: {
                id: 'market_badgeOnlyWhenFinished',
                label: 'Market: Sidebar badge only for finished listings',
                type: 'checkbox',
                default: false,
                help: 'The game badges Marketplace in the sidebar the moment anything is collectable, including a buy order that has taken 30 of 200 units and is still working — collecting those 30 does nothing except silence the badge until the next fill. This limits the sidebar badge to listings that have finished: filled completely, or cancelled and holding a refund. The badge on the My Listings tab is left alone, since once you are in the marketplace knowing there is something to collect is useful.',
            },
            market_pooledHistory: {
                id: 'market_pooledHistory',
                label: 'Market: Price history panel',
                type: 'checkbox',
                default: false,
                help: 'Adds a History tab to the marketplace: a floating chart of an item\u2019s ask, bid, average traded price and volume over the last day to six months, plus a row of pinned items. The game shows what an item costs now and nothing about what it cost before, which makes every price impossible to judge. The data comes from the pooled dataset the mooket project (by Q7, MIT) maintains at q7.nainai.eu.org. This talks to a third party in both directions and is off until you turn it on: it tells that server which items you look up, and it sends back the order books you open, which is where the history you read comes from \u2014 reading a pooled dataset without feeding it is what empties it.',
            },
            market_historySource: {
                id: 'market_historySource',
                label: 'Market: Price history data source',
                type: 'select',
                default: 'mooket2',
                options: [
                    { value: 'mooket2', label: 'mooket II \u2014 Q7 (q7.nainai.eu.org)' },
                    { value: 'mooket1', label: 'mooket I \u2014 IOMisaka (mooket.qi-e.top)' },
                ],
                help: 'Which pooled server the price history, the pinned-item prices and the My Listings "Mooket Refresh" read from \u2014 and, since you feed the pool you read, the one your opened order books are contributed back to. mooket II (the default) carries ask, bid, average traded price and volume. mooket I is a separate community pool: it carries only ask and bid, so on it the chart\u2019s third line is a computed midpoint of the quotes (shown as "Mid", not a real traded average), there are no volume bars, and the goal planner\u2019s market-volume limits switch off (it has no volume to measure). Both are third parties and both are governed by the switch above.',
            },
            market_showTopOrderAge: {
                id: 'market_showTopOrderAge',
                label: 'Market: Show top order age on My Listings',
                type: 'checkbox',
                default: false,
                help: 'Display estimated age of the top competing order for each of your listings (requires estimated listing age feature to be active)',
            },
            market_showEstimatedListingAge: {
                id: 'market_showEstimatedListingAge',
                label: 'Market: Show estimated age on order book',
                type: 'checkbox',
                default: true,
                help: 'Estimates creation time for all market listings using listing ID interpolation',
            },
            market_listingAgeFormat: {
                id: 'market_listingAgeFormat',
                label: 'Market: Listing age display format',
                type: 'select',
                default: 'datetime',
                options: [
                    { value: 'elapsed', label: 'Elapsed Time (e.g., "3h 45m")' },
                    { value: 'datetime', label: 'Date/Time (e.g., "01-13 14:30")' },
                ],
                help: 'Choose how to display listing creation times',
            },
            market_listingTimeFormat: {
                id: 'market_listingTimeFormat',
                label: 'Time format for date/time display',
                type: 'select',
                default: '24hour',
                options: [
                    { value: '24hour', label: '24-hour (14:30)' },
                    { value: '12hour', label: '12-hour (2:30 PM)' },
                ],
                help: 'Time format used in marketplace listings and action completion times',
            },
            market_listingDateFormat: {
                id: 'market_listingDateFormat',
                label: 'Date format for date/time display',
                type: 'select',
                default: 'MM-DD',
                options: [
                    { value: 'MM-DD', label: 'MM-DD (01-13)' },
                    { value: 'DD-MM', label: 'DD-MM (13-01)' },
                ],
                help: 'Date format used in marketplace listings and action completion times',
            },
            market_showOrderTotals: {
                id: 'market_showOrderTotals',
                label: 'Market: Show order totals in header',
                type: 'checkbox',
                default: true,
                help: 'Displays buy orders (BO), sell orders (SO), and unclaimed coins (💰) in the header area below gold',
            },
            market_showHistoryViewer: {
                id: 'market_showHistoryViewer',
                label: 'Market: Show history viewer button in settings',
                type: 'checkbox',
                default: true,
                help: 'Adds "View Market History" button to settings panel for viewing and exporting all market listing history',
            },
            market_showPhiloCalculator: {
                id: 'market_showPhiloCalculator',
                label: 'Market: Show Philo Gamba calculator button in settings',
                type: 'checkbox',
                default: true,
                help: 'Adds "Philo Gamba" button to settings panel for calculating transmutation ROI into Philosopher\'s Stones',
            },
            market_showQueueLength: {
                id: 'market_showQueueLength',
                label: 'Market: Show queue length estimates',
                type: 'checkbox',
                default: true,
                help: 'Displays total quantity at best price below Buy/Sell buttons. Estimated values (20+ orders at same price) are shown in a different color.',
            },
            market_depthCapEnabled: {
                id: 'market_depthCapEnabled',
                label: 'Market: Show sell depth cap (Risk of Ruin)',
                type: 'checkbox',
                default: true,
                help: "Shows how many actions worth of the currently-viewed item the order book can profitably absorb, based on the last Risk of Ruin calculation. Ignores the marketplace's tradable range floor, which isn't exposed in game data.",
            },
        },
    },

    pricingProfit: {
        title: 'Pricing & Profit',
        icon: '💹',
        settings: {
            profitCalc_pricingMode: {
                id: 'profitCalc_pricingMode',
                label: 'Profit calculation pricing mode',
                type: 'select',
                default: 'hybrid',
                options: [
                    { value: 'conservative', label: 'Buy: Ask / Sell: Bid (Instant Buy / Instant Sell)' },
                    { value: 'hybrid', label: 'Buy: Ask / Sell: Ask (Instant Buy / Patient Sell)' },
                    { value: 'optimistic', label: 'Buy: Bid / Sell: Ask (Patient Buy / Patient Sell)' },
                    { value: 'patientBuy', label: 'Buy: Bid / Sell: Bid (Patient Buy / Instant Sell)' },
                ],
            },
            pricing_testerShop: {
                id: 'pricing_testerShop',
                label: 'Test server: price purchases from the Tester shop',
                type: 'checkbox',
                default: false,
                hidden: !isTestServer(),
                help: "Test server only. Buy-side prices floor at the Tester shop's coin prices — house materials, ability books, enhancement materials — and the simulators' Upgrade tabs price equipment as bought from the shop at +10 and mirrored up with Philosopher's Mirrors (guaranteed, consuming a copy one level below) beyond that.",
            },
            profitCalc_pricingNaming: {
                id: 'profitCalc_pricingNaming',
                label: 'Pricing mode naming convention',
                type: 'checkbox',
                default: false,
                help: 'Show pricing modes as "Instant Buy / Instant Sell" instead of "Buy: Ask / Sell: Bid"',
            },
            profitCalc_keyPricingMode: {
                id: 'profitCalc_keyPricingMode',
                label: 'Key pricing mode',
                type: 'select',
                default: 'ask',
                options: [
                    { value: 'ask', label: 'Ask (instant buy)' },
                    { value: 'bid', label: 'Bid (patient buy)' },
                    { value: 'synced', label: 'Same as the profit calculation pricing mode' },
                    { value: 'craft', label: 'What it costs you to craft one' },
                ],
                help:
                    'How a dungeon key is valued everywhere the script prices one: item tooltips, net worth and the ' +
                    'inventory badges, combat income and the key-cost breakdown, the dungeon ROI board, the chest ' +
                    'risk-of-ruin model, and the consumables panel’s dungeon readiness card. Changing it moves your ' +
                    'net worth and your combat profit/hr, not only the dungeon card. “Same as the profit calculation ' +
                    'pricing mode” follows that setting’s buy side — keys are only ever bought, so its sell side has ' +
                    'nothing to say here. “What it costs you to craft one” values a key at your own crafting cost ' +
                    'instead of a market price, with the materials priced on that same buy side; a key you cannot ' +
                    'craft, or whose recipe has a material with no price, falls back to its market price rather than ' +
                    'being counted as free.',
            },
            profitCalc_liquidityCap: {
                id: 'profitCalc_liquidityCap',
                label: 'Profit: Cap displayed rates by market volume',
                type: 'checkbox',
                default: true,
                help: 'Bounds displayed and ranked profit/hr figures (alchemy Best Items, action-bar profit, pinned actions, the all-zones combat table) by how fast each method’s outputs actually trade, using the pooled market history — a method producing more per hour than the market absorbs cannot realize its quoted rate. Capped figures carry a "vol-capped" marker naming the limiting item. Needs the Market price history panel setting to have data; with it off, nothing is bounded. Turn this off to see raw rates.',
            },
            profitCalc_customPriceOverrides: {
                id: 'profitCalc_customPriceOverrides',
                label: 'Custom price overrides',
                type: 'customPriceOverrides',
                default: {},
                help: 'Set custom buy/sell prices for specific items. Overrides marketplace prices in profit calculations.',
            },
            profitCalc_craftUpgradeItems: {
                id: 'profitCalc_craftUpgradeItems',
                label: 'Profit: Use crafting cost for upgrade items if cheaper',
                type: 'checkbox',
                default: true,
                help: 'When enabled, uses crafting cost instead of market price for upgrade items if cheaper, and factors crafting time into profit/hr calculations.',
            },
            offlineProgressEconomics: {
                id: 'offlineProgressEconomics',
                label: 'Offline Progress: Show Revenue/Cost/Profit summary',
                type: 'checkbox',
                default: true,
                help: 'Adds a Revenue/Cost/Profit summary (with per-day projections, and each side expandable into the items behind it) to the native Welcome Back modal, priced with your Pricing & Profit settings from the server’s own offline item deltas. Overlaps with the UI setting “Welcome Back modal: What the time offline was worth” — turn that one off if you would rather have only this block.',
            },
        },
    },

    inventoryNetWorth: {
        title: 'Inventory & Net Worth',
        icon: '💎',
        settings: {
            networth: {
                id: 'networth',
                label: 'Net worth tracking (and gold count in the header)',
                type: 'checkbox',
                default: true,
                help: 'Master switch for the net worth calculator. Displays your current gold count next to Total Level in the page header; the inventory breakdown, history chart, and overlay rows below all need this on to have data',
            },
            invWorth: {
                id: 'invWorth',
                label: 'Below inventory: Show net worth breakdown',
                type: 'checkbox',
                default: true,
                help: 'Shows total net worth with a per-category breakdown (equipment, inventory, listings, houses, abilities) below the inventory panel. Requires net worth tracking to be enabled above',
            },
            invSort: {
                id: 'invSort',
                label: 'Sort inventory items by value',
                type: 'checkbox',
                default: true,
            },
            invSort_showBadges: {
                id: 'invSort_showBadges',
                label: 'Show stack value badges when sorting by Ask/Bid',
                type: 'checkbox',
                default: false,
            },
            invSort_badgesOnNone: {
                id: 'invSort_badgesOnNone',
                label: 'Badge type when "None" sort is selected',
                type: 'select',
                default: 'None',
                options: ['None', 'Ask', 'Bid'],
            },
            invSort_netOfTax: {
                id: 'invSort_netOfTax',
                label: 'Show badge values net of market tax',
                type: 'checkbox',
                default: false,
            },
            invSort_sortEquipment: {
                id: 'invSort_sortEquipment',
                label: 'Enable sorting for Equipment category',
                type: 'checkbox',
                default: false,
            },
            invBadgePrices: {
                id: 'invBadgePrices',
                label: 'Show price badges on item icons',
                type: 'checkbox',
                default: false,
                help: 'Displays per-item ask and bid prices on inventory items',
            },
            invCategoryTotals: {
                id: 'invCategoryTotals',
                label: 'Show category totals in inventory',
                type: 'checkbox',
                default: true,
                help: 'Displays the total market value of all items in each inventory category',
            },
            networth_valueSource: {
                id: 'networth_valueSource',
                label: 'Net worth value source',
                type: 'select',
                default: 'orderBook',
                options: [
                    { value: 'orderBook', label: 'Order book (ask/bid, by pricing mode below)' },
                    { value: 'officialValue', label: "Game's market value (matches inventory tooltip)" },
                ],
                help: "Order book prices your items from the live ask/bid using the pricing mode below. Game's market value uses the value the game itself publishes (behind the inventory's Total Market Value) — a single estimate per item, refreshed every ~10 min, so it stays fresher than the market feed and makes the net-worth total match the game. Only takes effect once the marketplace update is live.",
            },
            networth_pricingMode: {
                id: 'networth_pricingMode',
                label: 'Net worth pricing mode',
                type: 'select',
                default: 'ask',
                options: [
                    { value: 'ask', label: 'Ask price (patient sell value)' },
                    { value: 'bid', label: 'Bid price (instant liquidation value)' },
                ],
                help: "Ask shows what you could get by listing patiently. Bid shows what you could get by selling instantly. Ignored when the value source above is set to the game's market value.",
            },
            networth_highEnhancementUseCost: {
                id: 'networth_highEnhancementUseCost',
                label: 'Use enhancement cost for highly enhanced items',
                type: 'checkbox',
                default: true,
                help: 'Market prices are unreliable for highly enhanced items (+13 and above). Use calculated enhancement cost instead.',
            },
            networth_highEnhancementMinLevel: {
                id: 'networth_highEnhancementMinLevel',
                label: 'Minimum enhancement level to use cost',
                type: 'select',
                default: 13,
                options: [
                    { value: 10, label: '+10 and above' },
                    { value: 11, label: '+11 and above' },
                    { value: 12, label: '+12 and above' },
                    { value: 13, label: '+13 and above (recommended)' },
                    { value: 15, label: '+15 and above' },
                ],
                help: 'Enhancement level at which to stop trusting market prices',
            },
            networth_includeCowbells: {
                id: 'networth_includeCowbells',
                label: 'Include cowbells in net worth',
                type: 'checkbox',
                default: false,
                help: 'Cowbells are not tradeable, but they have a value based on Bag of 10 Cowbells market price',
            },
            networth_includeTaskTokens: {
                id: 'networth_includeTaskTokens',
                label: 'Include task tokens in net worth',
                type: 'checkbox',
                default: true,
                help: 'Value task tokens based on expected value from Task Shop chests. Disable to exclude them from net worth.',
            },
            networth_abilityBooksAsInventory: {
                id: 'networth_abilityBooksAsInventory',
                label: 'Count ability books as inventory (Current Assets)',
                type: 'checkbox',
                default: false,
                help: 'Move ability books from Fixed Assets to Current Assets inventory value. Useful if you plan to sell them.',
            },
            networth_historyChart: {
                id: 'networth_historyChart',
                label: 'Enable net worth history chart',
                type: 'checkbox',
                default: true,
                help: 'Records hourly net worth snapshots and shows a chart icon next to Total Net Worth. Disable to stop tracking and hide the chart button.',
            },
            networth_forecast: {
                id: 'networth_forecast',
                label: 'Enable net worth forecast',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a collapsed Forecast section to the net worth history chart: a Monte Carlo projection of the ' +
                    'daily series as a p10–p90 fan to 30, 60 or 90 days, with daily drift, EWMA volatility, ' +
                    'doubling time, and the odds of reaching a target you set. Needs the history chart enabled.',
            },
            networth_goldSources: {
                id: 'networth_goldSources',
                label: 'Enable gold source attribution',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a 💰 button beside Net Worth that splits your net worth change by activity — combat drops, ' +
                    'gathering, production, alchemy, enhancing, marketplace, offline — and shows what is left ' +
                    'unexplained rather than balancing it away. Also records production and offline income per day.',
            },
            autoAllButton: {
                id: 'autoAllButton',
                label: 'Auto-click "All" button when opening loot boxes',
                type: 'checkbox',
                default: true,
                help: 'Automatically clicks the "All" button when opening openable containers (crates, chests, caches)',
            },
            autoAllButton_excludeSeals: {
                id: 'autoAllButton_excludeSeals',
                label: 'Auto-click "All": Skip Scroll of... items',
                type: 'checkbox',
                default: true,
                help: 'When enabled, Scroll of... items from the Labyrinth are not auto-opened',
            },
        },
    },

    inventoryTabs: {
        title: 'Custom Inventory Tabs',
        icon: '🗂️',
        settings: {
            inventoryTabs: {
                id: 'inventoryTabs',
                label: 'Custom Inventory Tabs: Enable',
                type: 'checkbox',
                default: true,
                help: 'Adds a Toolasha tab to the character panel where you can organize inventory items into personal tabs.',
            },
            inventoryTabs_showUnorganized: {
                id: 'inventoryTabs_showUnorganized',
                label: 'Custom Inventory Tabs: Show Unorganized bucket',
                type: 'checkbox',
                default: true,
                help: 'Show an "Unorganized" section containing all items not assigned to any tab.',
            },
            inventoryTabs_categoryAddAll: {
                id: 'inventoryTabs_categoryAddAll',
                label: 'Custom Inventory Tabs: Add all items when adding category',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'When adding a category to a tab, add every item in that category (including items not in your inventory). When disabled, only items currently in your inventory are added.',
            },
            inventoryTabs_defaultTab: {
                id: 'inventoryTabs_defaultTab',
                label: 'Custom Inventory Tabs: Show Toolasha tab by default',
                type: 'checkbox',
                default: false,
                help: 'Hides the native Inventory tab and automatically activates the Toolasha tab whenever the character panel opens.',
            },
            inventoryTabs_tileGap: {
                id: 'inventoryTabs_tileGap',
                label: 'Custom Inventory Tabs: Item spacing (px)',
                type: 'number',
                default: 4,
                min: 0,
                max: 20,
                step: 1,
                help: 'Pixel gap between item tiles on the Toolasha tab.',
            },
            inventoryTabs_loadoutIncludeConsumables: {
                id: 'inventoryTabs_loadoutIncludeConsumables',
                label: 'Custom Inventory Tabs: Include food & drinks when adding from loadout',
                type: 'checkbox',
                default: false,
                help: 'When adding items from a loadout to a tab, also include food and drink items.',
            },
            inventoryTabs_topTabPriority: {
                id: 'inventoryTabs_topTabPriority',
                label: 'Custom Inventory Tabs: Items visible in topmost tab only',
                type: 'checkbox',
                default: true,
                help: 'When an item appears in multiple tabs, it only shows in the highest (topmost) tab that contains it. When disabled, collapsing a tab releases its items to lower tabs.',
            },
        },
    },

    skills: {
        title: 'Skills',
        icon: '📚',
        settings: {
            simulateScrollEffects: {
                id: 'simulateScrollEffects',
                label: 'Skills: Simulate missing scroll effects in calculations',
                type: 'checkboxWithButton',
                buttonLabel: 'Defaults...',
                default: false,
                help: 'When enabled, profit/XP/speed calculations show hypothetical results as if selected scrolls were active. Configure default scrolls with the button; override per-loadout from the Loadouts panel.',
            },
            xpTracker: {
                id: 'xpTracker',
                label: 'Left sidebar: Show XP/hr rate on skill bars',
                type: 'checkbox',
                default: true,
                help: 'Displays live XP/hr rate under each skill bar in the navigation panel',
            },
            xpTracker_timeTillLevel: {
                id: 'xpTracker_timeTillLevel',
                label: 'Skill tooltip: Show time till next level',
                type: 'checkbox',
                default: true,
                help: 'Shows estimated time remaining until the next level in the skill hover tooltip (based on current XP/hr)',
            },
            skillRemainingXP: {
                id: 'skillRemainingXP',
                label: 'Left sidebar: Show remaining XP to next level',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Displays how much XP needed to reach the next level under skill progress bars',
            },
            skillRemainingXP_blackBorder: {
                id: 'skillRemainingXP_blackBorder',
                label: 'Remaining XP: Add black text border for better visibility',
                type: 'checkbox',
                default: true,
                help: 'Adds a black outline/shadow to the XP text for better readability against progress bars',
            },
            skillbook: {
                id: 'skillbook',
                label: 'Skill books: Show books needed to reach target level (in the ability book item dictionary window)',
                type: 'checkbox',
                default: true,
            },
            drinkTimer: {
                id: 'drinkTimer',
                label: 'Drink timer: Show remaining drink supply time in skill panels',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Shows how long your drink stock lasts and whether it covers the queued actions. This switch existed internally but was never in the settings panel, so the feature could not be turned off.',
            },
            drinkTimer_warningThreshold: {
                id: 'drinkTimer_warningThreshold',
                label: 'Drink timer: warning threshold (hours)',
                type: 'number',
                default: 24,
                help: 'Show an amber warning on drink time displays when remaining supply falls below this many hours.',
            },
            skillingOptimizer: {
                id: 'skillingOptimizer',
                label: 'Skilling Simulator/Optimizer: Enable Optimizer tab in character panel',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
            },
        },
    },

    combat: {
        title: 'Combat Features',
        icon: '⚔️',
        settings: {
            damageTracker: {
                id: 'damageTracker',
                label: 'Damage Tracker: Attribute damage per player and per ability',
                type: 'checkbox',
                default: true,
                help: 'The game attributes nothing, so the caster is worked out from whose mana fell each tick. Feeds the Damage panel behind the DPS tile',
            },
            damageTakenTracker: {
                id: 'damageTakenTracker',
                label: 'Damage Taken Tracker: What is hitting you, and for how much',
                type: 'checkbox',
                default: true,
                help: 'Damage taken against health regenerated, broken out per monster and per wave with hit ranges. Feeds the Deaths panel behind the deaths/hr tile',
            },
            partyLint_live: {
                id: 'partyLint_live',
                label: 'Party lint: Flag loadout mistakes in the live party',
                type: 'checkbox',
                default: true,
                help: 'The same checks the Combat Sim runs before a party simulation — skilling gear in a combat slot, the same aura equipped twice — fired on the party you are actually fighting with, as an amber block in the Damage panel. Auras are checked for everyone; gear only for you, since the battle payload carries no one’s equipment. Parties of 2+ only',
            },
            combatRecorder_autoStart: {
                id: 'combatRecorder_autoStart',
                label: 'Auto-record combat on load',
                type: 'checkbox',
                default: false,
                help: 'Starts the combat recorder the moment the page loads and writes the file out on its own, then switches itself back off. The Record button in the Damage panel cannot capture the first seconds of a session, which is exactly when a reload lands mid-fight and the client never sees what it is fighting. Turn it on again for each recording you want',
            },
            combatRecorder_autoStartSeconds: {
                id: 'combatRecorder_autoStartSeconds',
                label: 'Auto-record length (seconds)',
                type: 'number',
                default: 60,
                min: 10,
                max: 600,
                help: 'How long the automatic recording runs before it saves itself',
            },
            replayCheck: {
                id: 'replayCheck',
                label: 'Sim Accuracy: Replay recorded fights against the simulator',
                type: 'checkbox',
                default: true,
                help: 'Derives damage dealt, damage taken and fight length from a recorded fight, runs the simulator for the same zone, and reports the deviation with a sampling-noise margin. Feeds the Sim Accuracy overlay row and the panel behind it',
            },
            combatScore: {
                id: 'combatScore',
                label: 'Profile panel: Show gear score',
                type: 'checkbox',
                default: true,
            },
            combatProfileButton: {
                id: 'combatProfileButton',
                label: 'Combat: Profile button on party members',
                type: 'checkbox',
                default: false,
                help: "Adds a 'Profile' button to the battle-unit popup when you click another player in group/party/dungeon combat, opening their profile directly (falls back to the /profile chat command if needed).",
            },
            abilitiesTriggers: {
                id: 'abilitiesTriggers',
                label: 'Profile panel: Show abilities & triggers',
                type: 'checkbox',
                default: true,
                help: 'Displays equipped abilities, consumables, and their combat triggers below the profile',
            },
            abilities_dictionaryButton: {
                id: 'abilities_dictionaryButton',
                label: 'Abilities: Add Open Item Dictionary to ability menus',
                type: 'checkbox',
                default: true,
                help: "Adds an Open Item Dictionary button to the popup shown when clicking an ability, and opens that ability's book entry on a right-click of any ability icon (slots, loadouts, the combat bar).",
            },
            chestKeyMarketButton: {
                id: 'chestKeyMarketButton',
                label: 'Chests: Add Buy Keys on Marketplace to chest menus',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to the popup shown when clicking a keyed chest, opening its key on the marketplace.',
            },
            characterCard: {
                id: 'characterCard',
                label: 'Profile panel: Show View Card button',
                type: 'checkbox',
                default: true,
                help: 'Adds button to open character sheet in external viewer',
            },
            eliteAchievementReminder: {
                id: 'eliteAchievementReminder',
                label: 'Profile panel: Show Elite achievement reminder icon',
                type: 'checkbox',
                default: true,
                help: "Shows a ✉️ icon next to a player's name if they haven't completed Elite achievements; click to pre-fill a whisper.",
            },
            eliteAchievementReminderMessage: {
                id: 'eliteAchievementReminderMessage',
                label: 'Elite achievement reminder: whisper message',
                type: 'text',
                default: 'Be Elite. Do your Elite achievements.',
                help: 'Message pre-filled into chat when the Elite achievement reminder icon is clicked.',
            },
            dungeonTracker: {
                id: 'dungeonTracker',
                label: 'Dungeon Tracker: Real-time progress tracking',
                type: 'checkbox',
                default: true,
                help: 'Tracks dungeon runs with server-validated duration from party messages',
            },
            dungeonTrackerUI: {
                id: 'dungeonTrackerUI',
                label: 'Show Dungeon Tracker UI panel',
                type: 'checkbox',
                default: true,
                help: 'Displays dungeon progress panel with wave counter, run history, and statistics',
            },
            dungeonTrackerChatAnnotations: {
                id: 'dungeonTrackerChatAnnotations',
                label: 'Show run time in party chat',
                type: 'checkbox',
                default: true,
                help: 'Adds colored timer annotations to "Key counts" messages (green if fast, red if slow)',
            },
            dungeonTrackerAverageWindow: {
                id: 'dungeonTrackerAverageWindow',
                label: 'Party chat average covers only the last N runs (0 = all runs)',
                type: 'number',
                default: 0,
                min: 0,
                max: 500,
                help: 'The average printed beside each run in party chat is a lifetime one by default, so a build or ability change takes hundreds of runs to show up in it. Set a window — 20 is a good starting point — and each line averages only the runs ending with it, labelled with how many it covered. The dungeon panel’s "Avg from here" button does the same job for one dungeon at a stroke.',
            },
            labyrinthRunLedger: {
                id: 'labyrinthRunLedger',
                label: 'Labyrinth: record what each run leaves unspent',
                type: 'checkbox',
                default: true,
                help: "Records each run's ending — the torches, shrouds and beacons it came back with and the deepest floor it reached — so the Consumables panel can say whether the rush-for-exit floor could come down. Kept per character, last 30 runs.",
            },
            labyrinthTracker: {
                id: 'labyrinthTracker',
                label: 'Labyrinth best level tracker',
                type: 'checkbox',
                default: true,
                help: 'Tracks the highest recommended level enemy defeated per monster type and shows it in the Automation tab',
            },
            labyrinthShopPrices: {
                id: 'labyrinthShopPrices',
                label: 'Labyrinth Shop: Show market prices',
                type: 'checkbox',
                default: true,
                help: 'Shows ask/bid market prices on tradeable items in the Labyrinth Shop tab',
            },
            labyrinthClearRate: {
                id: 'labyrinthClearRate',
                label: 'Labyrinth clear rate calculator',
                type: 'checkbox',
                default: true,
                help: 'Shows expected clear time and success rate on labyrinth skilling room tiles',
            },
            labyrinthMonsterStatCheck: {
                id: 'labyrinthMonsterStatCheck',
                label: 'Monster stat check (sim diagnostic)',
                type: 'checkbox',
                default: false,
                help: 'When you click a monster in combat, opens a panel comparing the game’s live buffed stats (armour, resistances, evasion, accuracy) against what the combat sim computes for the same monster — so a modelling gap or an active buff is visible at a glance. Diagnostic; off by default. Takes effect on refresh.',
            },
            labyrinthRecommendTargetRate: {
                id: 'labyrinthRecommendTargetRate',
                label: 'Labyrinth: Recommend target clear rate (%)',
                type: 'number',
                default: 70,
                min: 1,
                max: 100,
                step: 1,
                help: 'Default target clear rate for labyrinth skip threshold recommendations',
            },
            labyrinthSimPrecision: {
                id: 'labyrinthSimPrecision',
                label: 'Labyrinth: Combat sim precision (±%)',
                type: 'number',
                default: 1,
                min: 0.1,
                max: 10,
                step: 0.5,
                help: "A room's sim keeps fighting until its clear chance is pinned to within this many percentage points either side — the 95% confidence interval has to fit inside ±this before the run is allowed to stop. A settled room gets there in a few hundred fights and a close one needs thousands, so the work goes where the answer is still in doubt (lower = tighter interval, more fights, slower)",
            },
            labyrinthTileUncapped: {
                id: 'labyrinthTileUncapped',
                label: 'Labyrinth: Floor calc ignores the fight cap (run to precision)',
                type: 'checkbox',
                default: false,
                help: 'When on, a manual "Calc" on the labyrinth map keeps simulating each room until the precision target is met instead of stopping at the standard fight budget and reporting a wide "(capped)" band. A safety backstop of 100× that budget still ends a run that can never converge, and the calculate button becomes Cancel while one is going.',
            },
            labyrinthAutomationSimPrecision: {
                id: 'labyrinthAutomationSimPrecision',
                label: 'Labyrinth: Automation tab sim precision (±%)',
                type: 'number',
                default: 0,
                min: 0,
                max: 10,
                step: 0.5,
                help: 'Precision the Automation tab’s own per-room sims and Recommend searches run to, in percentage points. 0 follows the floor map’s precision, which is what these sims used before this setting existed.',
            },
            labyrinthAutomationUncapped: {
                id: 'labyrinthAutomationUncapped',
                label: 'Labyrinth: Automation tab ignores the fight cap',
                type: 'checkbox',
                default: false,
                help: 'When on, the Automation tab’s cached per-room calculations and Recommend searches run to their precision target rather than stopping at the standard fight budget. Bounded by the same 100× backstop, and cancellable from the Recommend button.',
            },
            labyrinthRecommendSimHours: {
                id: 'labyrinthRecommendSimHours',
                label: 'Labyrinth: Combat sim time ceiling (hours)',
                type: 'number',
                default: 3,
                min: 1,
                max: 100,
                step: 1,
                help: 'Upper bound on a single room simulation, in simulated hours. Precision normally ends a run well before this; the ceiling stops a room near a coin toss from running forever',
            },
            labyrinthSimMaxTrials: {
                id: 'labyrinthSimMaxTrials',
                label: 'Labyrinth: Single-sim max fights',
                type: 'number',
                default: 20000,
                min: 1,
                max: 10000000,
                step: 1000,
                help: 'Hard cap on the number of fights one Single Sim run may use before it stops, regardless of precision. Tick the Single Sim "Uncapped" box to ignore this (and the time ceiling) and run until the precision target is met.',
            },
            labyrinthSimMaxHours: {
                id: 'labyrinthSimMaxHours',
                label: 'Labyrinth: Single-sim time ceiling (hours)',
                type: 'number',
                default: 24,
                min: 1,
                max: 100000,
                step: 1,
                help: 'Simulated-time ceiling on one Single Sim run. Precision normally ends the run first. Tick the Single Sim "Uncapped" box to ignore this (and the max-fights cap). Only affects the Single Sim tab; the live labyrinth tile calculator keeps its own ceiling.',
            },
            labyrinthSimUncapped: {
                id: 'labyrinthSimUncapped',
                label: 'Labyrinth: Single-sim ignore caps (run to precision)',
                type: 'checkbox',
                default: false,
                help: 'When on, the Single Sim tab ignores both the max-fights and time-ceiling numbers (they stay in place) and runs until the precision target is met. Can be slow for a near-coin-toss room.',
            },
            labyrinthUpgradeMaxTrials: {
                id: 'labyrinthUpgradeMaxTrials',
                label: 'Labyrinth: Upgrade-sim max fights',
                type: 'number',
                default: 20000,
                min: 1,
                max: 10000000,
                step: 1000,
                help: 'Cap on the baseline sim\'s fight count for each Upgrade tab comparison (every candidate is paired to that count). Tick the Upgrade "Uncapped" box to ignore this and the time ceiling.',
            },
            labyrinthUpgradeMaxHours: {
                id: 'labyrinthUpgradeMaxHours',
                label: 'Labyrinth: Upgrade-sim time ceiling (hours)',
                type: 'number',
                default: 24,
                min: 1,
                max: 100000,
                step: 1,
                help: 'Simulated-time ceiling on each Upgrade tab comparison sim. Tick the Upgrade "Uncapped" box to ignore it and run to precision.',
            },
            labyrinthUpgradeUncapped: {
                id: 'labyrinthUpgradeUncapped',
                label: 'Labyrinth: Upgrade-sim ignore time ceiling',
                type: 'checkbox',
                default: false,
                help: 'When on, the Upgrade tab ignores its time-ceiling number (it stays in place) and runs each comparison to the precision target.',
            },
            labyrinthPathClearThreshold: {
                id: 'labyrinthPathClearThreshold',
                label: 'Labyrinth: Path clearable threshold (%)',
                type: 'number',
                default: 70,
                min: 1,
                max: 100,
                step: 1,
                help: 'Clear chance at or above which the labyrinth path planner treats a tile as clearable without a shroud (separate from the skip recommendation target)',
            },
            labyrinthPathUnknownMode: {
                id: 'labyrinthPathUnknownMode',
                label: 'Labyrinth: Path treats unrevealed rooms as',
                type: 'select',
                default: 'shroud',
                options: [
                    { value: 'clearable', label: 'Clearable (optimistic)' },
                    { value: 'shroud', label: 'Needing a shroud (pessimistic)' },
                    { value: 'avoid', label: 'Impassable (route revealed rooms only)' },
                ],
                help: 'How the labyrinth path planner costs rooms whose contents are not revealed yet',
            },
            labyrinthBeaconCount: {
                id: 'labyrinthBeaconCount',
                label: 'Labyrinth: Beacon plan count',
                type: 'number',
                default: 0,
                min: 0,
                max: 20,
                step: 1,
                help: 'Beacons the beacon planner places on the floor in view, sited to cover a revealed path to the exit first, a second independent route next, and the most rooms with what is left — 0 uses the fewest that cover a path, which every new floor resets to',
            },
            labyrinthSkipEditAutofill: {
                id: 'labyrinthSkipEditAutofill',
                label: 'Labyrinth: Autofill skip Edit input',
                type: 'checkbox',
                default: false,
                help: "Clicking a skip threshold's Edit button fills the input with the recommended threshold (or the current value when no recommendation exists), replacing whatever is in it",
            },
            labyrinthLiveProgress: {
                id: 'labyrinthLiveProgress',
                label: 'Labyrinth: Show live clear chance',
                type: 'checkbox',
                default: true,
                help: 'Shows a live clear chance in the action bar during labyrinth rooms — from the actions left in a skilling or enhancing room, and from how the fight is going in a combat room',
            },
            labyrinthLiveCombatSim: {
                id: 'labyrinthLiveCombatSim',
                label: 'Labyrinth: Replay the live fight for a better clear chance',
                type: 'checkbox',
                default: false,
                help: 'Replays the fight in progress hundreds of times from its current health and remaining time, instead of extrapolating from how fast health is being lost. Slower but far more accurate, since it runs the real combat engine',
            },
            labyrinthRoomLogs: {
                id: 'labyrinthRoomLogs',
                label: 'Labyrinth: Room action logs',
                type: 'checkbox',
                default: true,
                help: 'Records per-action success/fail/double logs for labyrinth skilling rooms and per-attempt win/death/timeout logs for combat rooms, each set beside the clear chance the calculator predicted, grouped by floor with experience per hour. A second tab totals every room ever recorded, so you can see where the calculator is being contradicted (Logs button in the labyrinth panel)',
            },
            labyrinthRoomLogSize: {
                id: 'labyrinthRoomLogSize',
                label: 'Labyrinth: Rooms of history to keep',
                type: 'number',
                default: 120,
                min: 20,
                max: 500,
                help: 'A floor is around thirty rooms, so anything near that shows barely one floor and nothing to compare it against. 120 keeps roughly three floors. Each room is a few hundred bytes, and the long-term accuracy record is kept separately and never trimmed',
            },
            labyrinthAutoCalcTiles: {
                id: 'labyrinthAutoCalcTiles',
                label: 'Labyrinth: Auto-calc revealed tiles',
                type: 'checkbox',
                default: false,
                help: 'Automatically calculates clear chances for newly revealed labyrinth tiles without clicking Calc Tiles',
            },
            combatBattleCounter: {
                id: 'combatBattleCounter',
                label: 'Show battle/wave counter in current action panel during combat',
                type: 'checkbox',
                default: true,
                help: 'Displays "Battle #N" for regular zones or "Wave N" for dungeons in the top-left action panel',
            },
            spawnCensus: {
                id: 'spawnCensus',
                label: 'Spawn Census: Tally which monsters each combat wave contains',
                type: 'checkbox',
                default: false,
                help: "Counts how often each set of monsters appears at each zone, difficulty and wave number, so the simulator's wave-draw rule can be checked against what the game actually does. Identical waves share one row and a counter, so weeks of play cost about a megabyte and nothing is written per battle. Shows nothing in game — use the Export button below to get the data out.",
            },
            spawnCensus_divergenceAlert: {
                id: 'spawnCensus_divergenceAlert',
                label: 'Spawn Census: Alert when the spawn tables stop matching',
                type: 'checkbox',
                default: false,
                help: "Checks the recorded rosters against the spawn tables the combat simulator was fitted to, and notifies you once when a dungeon's draws no longer match them or the game's tables themselves change - the day it happens, rather than when the clear-time estimates have been quietly wrong for a month. Needs the Spawn Census above switched on, and at least 100 recorded waves in a wave band before it says anything. The per-dungeon verdicts are in Toolasha.Debug.spawnCensus().",
            },
            spawnCensusExport: {
                id: 'spawnCensusExport',
                label: 'Spawn Census: Export the recorded data',
                type: 'button',
                buttonLabel: 'Export census',
                help: 'Downloads a JSON file of everything counted above - the wave rosters, durations and observed monster hitpoints. No character or account data is in it. Works whether the checkbox above is on or off, so turning it off does not lock away what was already collected.',
            },
            combatBossEta: {
                id: 'combatBossEta',
                label: 'Show battles/time until the boss is defeated next to the battle counter',
                type: 'checkbox',
                default: true,
                help: 'For zones with a boss cycle, shows how many battles remain and — once a few battles have been timed — an estimate of when the boss will be defeated and you are free to start another action',
            },
            combatSummary: {
                id: 'combatSummary',
                label: 'Combat Summary: Add rate stats to Battle Info panel',
                type: 'checkbox',
                default: true,
                help: 'Adds encounters/hour, revenue and experience rates to the Battle Info panel for the unit being viewed',
            },
            combatDropLuck: {
                id: 'combatDropLuck',
                label: 'Combat Drop Luck: Show how lucky a session was on return',
                type: 'checkbox',
                default: true,
                help: "Puts the session's drop value in the distribution of everything those battles could have paid, as a percentile. Skips dungeons, which pay from a reward table rather than per monster",
            },
            dropLuck_profitAdjust: {
                id: 'dropLuck_profitAdjust',
                label: 'Dungeon profit: value chests at my measured treasure rate',
                type: 'checkbox',
                default: false,
                help: "Scales a dungeon chest's expected value in profit estimates by your own treasure rate for that chest — what your recorded openings actually returned against the drop table's expectation, both at today's prices. Only applies once a few hundred openings back the measurement, and every adjusted figure is marked (*) with the measurement in its tooltip",
            },
            combatDps: {
                id: 'combatDps',
                label: 'Combat DPS: Measure damage per second during a run',
                type: 'checkbox',
                default: true,
                help: "Infers damage from health lost between combat ticks, since the game sends no damage figure. Overkill is not counted, and in a party it is the whole party's damage — nothing on the wire says who struck",
            },
            combatDpsPanel: {
                id: 'combatDpsPanel',
                label: 'Per-player panel: Rank the party’s damage during normal combat',
                type: 'checkbox',
                default: false,
                help: 'The guild trial’s per-player board, for ordinary party and solo fights: damage, damage taken and health restored per member, ranked with shares and rates. Opens from a “Per-player” button on the battle panel. Damage is inferred from health lost per tick and a tick two players both hit on is shared between them, so a share is an attribution rather than a measurement — the panel says so. Off by default',
            },
            portraitDps: {
                id: 'portraitDps',
                label: 'Portrait DPS: Show each character’s damage on their battle portrait',
                type: 'checkbox',
                default: false,
                help: "Draws the run's DPS and total damage over each character in the battle panel, matched by name. Off by default because the portraits are already busy with health and mana",
            },
            combatUnitBadges: {
                id: 'combatUnitBadges',
                label: 'Unit badges: Show each player’s DPS and share of the damage on their portrait',
                type: 'checkbox',
                default: false,
                help: "A small “1,240/s · 22%” on every party tile, matched by name. The narrow mini units get a compact “1,240/s” pinned to the bottom edge instead, so nothing lands on the name along their top. During a guild trial it reads the spectated trial split instead of this client's own fight. With Portrait DPS also on, the badge leaves the full cards to it and covers the mini units it never reaches — the two never state the same run twice. Off by default because the portraits are already busy",
            },
            combatUnitBuffBars: {
                id: 'combatUnitBuffBars',
                label: 'Buff bars: Show the buffs and debuffs on every combat unit',
                type: 'checkbox',
                default: false,
                help: "A strip of the game's own ability icons under each tile — yours, every party member's and every monster's — counting down what is on them. Read from the buff maps the server states each tick, so nothing is inferred from a cast: a debuff that was resisted never appears. Effects no ability declares (community buffs, drinks) show an abbreviation instead of an icon. Off by default because the tiles are already busy",
            },
            combatConsumableRunway: {
                id: 'combatConsumableRunway',
                label: 'Consumable runway: Show how long each food and drink lasts on the battle grid',
                type: 'checkbox',
                default: false,
                help: 'A small duration under each icon in the in-battle Consumables grid — how long that stock lasts at the rate it is actually being used, red once it drops under the low-consumable warning hours, ∞ for a slot that is filled but not being drunk. Same figure as the Consumables panel and the low-consumable alert, from the same forecast; what is new is only that it is readable mid-fight without a click. Needs Combat Statistics on, since its tracker measures the rate. Off by default.',
            },
            portraitDpsPosition: {
                id: 'portraitDpsPosition',
                label: 'Portrait DPS: Where to put it',
                type: 'select',
                default: 'above',
                options: [
                    { value: 'above', label: 'Above the portrait' },
                    { value: 'below', label: 'Below the portrait' },
                ],
                help: 'Above sits over the name; below sits under the ability bar',
            },
            portraitDps_timeToKill: {
                id: 'portraitDps_timeToKill',
                label: 'Portrait DPS: Time-to-kill on enemy tiles',
                type: 'checkbox',
                default: false,
                help: 'Adds "dead ~8s" to each enemy tile — its remaining health over the rate it is being hit at. Dashed until the fight has both a health reading and a rate; nothing is ever extrapolated from a guess',
            },
            portraitDps_waveClear: {
                id: 'portraitDps_waveClear',
                label: 'Portrait DPS: Wave-clear countdown',
                type: 'checkbox',
                default: false,
                help: 'One "wave ~19s" figure on the topmost enemy tile: every living enemy\'s remaining health over the party\'s combined rate. Dashed until every health bar is known and a rate exists — a countdown that silently excluded a monster would lie',
            },
            portraitDps_manaRunway: {
                id: 'portraitDps_manaRunway',
                label: 'Portrait DPS: Mana runway per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "mana ~40s" to a player\'s meter when their mana is draining and under a minute from empty, measured net of regeneration and refills. Steady or rising mana shows a dash — there is nothing to warn about',
            },
            portraitDps_sustain: {
                id: 'portraitDps_sustain',
                label: 'Portrait DPS: Damage taken and net sustain per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "taken 220/s" from the incoming-damage tracker, and "net −35/s" where regeneration is measurable — red when the net is negative, which is the reading that says a zone is not survivable',
            },
            portraitDps_accuracy: {
                id: 'portraitDps_accuracy',
                label: 'Portrait DPS: Hit and crit rate per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "94% hit · 31% crit" to each player\'s meter once 20 swings back it. Fewer swings show a dash rather than one fight\'s luck dressed up as a rate',
            },
            portraitDps_enemyOutgoing: {
                id: 'portraitDps_enemyOutgoing',
                label: 'Portrait DPS: Enemy outgoing damage',
                type: 'checkbox',
                default: false,
                help: 'A red "hits for 210/s" line on each enemy tile — what that enemy is doing to the party this fight, from the incoming-damage split. Dashed until a hit can be pinned to that enemy',
            },
            portraitDps_enrage: {
                id: 'portraitDps_enrage',
                label: 'Portrait DPS: Enrage countdown on enemy tiles',
                type: 'checkbox',
                default: false,
                help: 'Adds "enrage 1:42" counting down when the monster\'s sheet carries an enrage timer and spawn time, amber under 30 seconds. Monsters whose sheet states no timer show a dash',
            },
            dungeonPace: {
                id: 'dungeonPace',
                label: 'Dungeon Tracker: Pace vs your average',
                type: 'checkbox',
                default: true,
                help: 'A chip on the in-progress dungeon panel — "pace +6% vs your avg" — comparing this run\'s average wave time against your stored history for the same dungeon, green when faster. No stored history, or fewer than three waves in, shows nothing',
            },
            combatSim: {
                id: 'combatSim',
                label: 'Combat Simulator',
                type: 'checkbox',
                default: true,
                help: 'Simulate combat encounters to estimate XP/hr, deaths, and consumable usage',
            },
            labSim: {
                id: 'labSim',
                label: 'Lab Simulator',
                type: 'checkbox',
                default: true,
                help: 'Simulate labyrinth runs to estimate performance across skills and combat',
            },
            combatSim_defaultHours: {
                id: 'combatSim_defaultHours',
                label: 'Combat Simulator: Default hours (single zone)',
                type: 'number',
                default: 100,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for single-zone runs',
            },
            combatSim_allZonesDefaultHours: {
                id: 'combatSim_allZonesDefaultHours',
                label: 'Combat Simulator: Default hours (All Zones)',
                type: 'number',
                default: 10,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for All Zones runs',
            },
            combatSim_seekDefaultHours: {
                id: 'combatSim_seekDefaultHours',
                label: 'Combat Simulator: Default hours (Seek)',
                type: 'number',
                default: 10,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for Seek Best Source runs',
            },
            combatSim_decimalMinutes: {
                id: 'combatSim_decimalMinutes',
                label: 'Combat Simulator: Show completion time as decimal minutes',
                type: 'checkbox',
                default: false,
                help: 'Display avg completion time as "X.XX min" instead of "Xm Ys"',
            },
            combatSim_bestiary: {
                id: 'combatSim_bestiary',
                label: 'Combat Simulator: Bestiary column and route planner in All Zones',
                type: 'checkbox',
                default: true,
                help:
                    'Adds the Bestiary points/day column to the All Zones table and the Bestiary route planner under it. ' +
                    'Off: neither is drawn and the Bestiary is not requested from the game.',
            },
            combatSim_defaultLoadout: {
                id: 'combatSim_defaultLoadout',
                label: 'Combat Simulator: Default loadout',
                type: 'select',
                default: '',
                options: () => {
                    const snapshot = loadoutSnapshot();
                    const loadouts = snapshot
                        ? snapshot
                              .getAllSnapshots()
                              .filter((s) => !s.actionTypeHrid || s.actionTypeHrid === '/action_types/combat')
                        : [];
                    return [
                        { value: '', label: 'Current Gear' },
                        ...loadouts.map((s) => ({ value: s.name, label: s.name })),
                    ];
                },
                help: 'Loadout to use by default for combat estimates instead of currently equipped gear',
            },
            combatSim_autoEstimate: {
                id: 'combatSim_autoEstimate',
                label: 'Combat Simulator: Auto-run estimate on task cards',
                type: 'checkbox',
                default: false,
                help: 'Automatically run combat estimates using the default loadout when task cards appear',
            },
            combatSim_maxThreads: {
                id: 'combatSim_maxThreads',
                label: 'Combat Simulator: Max threads',
                type: 'number',
                default: 0,
                min: 0,
                max: 32,
                help: 'Maximum Web Worker threads for simulations (0 = auto: 4, or fewer on a smaller machine)',
            },
            combatSim_uncapThreads: {
                id: 'combatSim_uncapThreads',
                label: 'Combat Simulator: Ignore the thread caps',
                type: 'checkbox',
                default: false,
                help:
                    'Max threads is normally clamped to your core count, and an analysis runs at most 6 simulations ' +
                    'at once — each one holds its own copy of the game data, and the tab running the game needs a ' +
                    'core too. Turn this on to take the number above literally.',
            },
            labSim_keepReplacedGear: {
                id: 'labSim_keepReplacedGear',
                label: 'Lab Simulator: Keep gear the forced armor swaps replace',
                type: 'checkbox',
                default: true,
                help: 'The labyrinth needs every element set, so the Anchorbound / elemental robe / weapon swaps price as an added purchase with no resale credit for the gear they replace. Turn off to price them as a straight swap that sells the old piece.',
            },
            combatSim_sharedSeed: {
                id: 'combatSim_sharedSeed',
                label: 'Combat Simulator: Shared random seed for upgrade comparisons',
                type: 'checkbox',
                default: true,
                help: 'Runs the baseline and every candidate on the same random draws, so a small difference reflects the upgrade instead of luck. Turn off to give every sim independent randomness (the old behavior).',
            },
            combatSim_rememberUpgradeResults: {
                id: 'combatSim_rememberUpgradeResults',
                label: 'Combat & Lab Simulator: Remember upgrade results across refreshes',
                type: 'checkbox',
                default: false,
                help: 'Keeps the last Upgrade-tab results (Combat Sim and Lab Sim) after a page reload, until you run a new analysis, so a run you waited on is still there when you come back. Off by default because it stores the full result set (one blob per character per sim) in the browser database.',
            },
            combatStats: {
                id: 'combatStats',
                label: 'Combat Statistics: Show Statistics tab in Combat panel',
                type: 'checkbox',
                default: true,
                help: 'Adds a Statistics button to the Combat panel showing income, profit, consumable costs, EXP, and drop details',
            },
            combatStatsChatMessage: {
                id: 'combatStatsChatMessage',
                label: 'Combat Statistics: Chat message format',
                type: 'template',
                default: [
                    { type: 'text', value: 'Combat Stats: ' },
                    { type: 'variable', key: '{duration}', label: 'Duration' },
                    { type: 'text', value: ' duration | ' },
                    { type: 'variable', key: '{encountersPerHour}', label: 'Encounters/Hour' },
                    { type: 'text', value: ' EPH | ' },
                    { type: 'variable', key: '{income}', label: 'Total Income' },
                    { type: 'text', value: ' income | ' },
                    { type: 'variable', key: '{dailyIncome}', label: 'Daily Income' },
                    { type: 'text', value: ' income/d | ' },
                    { type: 'variable', key: '{dailyConsumableCosts}', label: 'Daily Consumable Costs' },
                    { type: 'text', value: ' consumables/d | ' },
                    { type: 'variable', key: '{dailyProfit}', label: 'Daily Profit' },
                    { type: 'text', value: ' profit/d | ' },
                    { type: 'variable', key: '{exp}', label: 'EXP/Hour' },
                    { type: 'text', value: ' exp/h | ' },
                    { type: 'variable', key: '{deathCount}', label: 'Deaths' },
                    { type: 'text', value: ' deaths' },
                ],
                help: 'Message format when Ctrl+clicking player card in Statistics. Click "Edit Template" to customize.',
                templateVariables: [
                    { key: '{duration}', label: 'Duration', description: 'Combat session duration' },
                    { key: '{encountersPerHour}', label: 'Encounters/Hour', description: 'Encounters per hour (EPH)' },
                    { key: '{income}', label: 'Total Income', description: 'Total income from combat' },
                    { key: '{dailyIncome}', label: 'Daily Income', description: 'Income per day' },
                    {
                        key: '{dailyConsumableCosts}',
                        label: 'Daily Consumable Costs',
                        description: 'Consumable costs per day',
                    },
                    { key: '{dailyProfit}', label: 'Daily Profit', description: 'Profit per day' },
                    { key: '{exp}', label: 'EXP/Hour', description: 'Experience per hour' },
                    { key: '{deathCount}', label: 'Deaths', description: 'Number of deaths' },
                ],
            },
        },
    },

    tasks: {
        title: 'Tasks',
        icon: '📋',
        settings: {
            taskProfitCalculator: {
                id: 'taskProfitCalculator',
                label: 'Show total profit for gathering/production tasks',
                type: 'checkbox',
                default: true,
            },
            taskSpeedBreakdown: {
                id: 'taskSpeedBreakdown',
                label: 'Show expandable speed & time breakdown on tasks',
                type: 'checkbox',
                default: true,
                help: 'Displays an expandable action speed, efficiency, and timing breakdown on task cards.',
            },
            taskCombatEstimate: {
                id: 'taskCombatEstimate',
                label: 'Show combat estimate on combat tasks',
                type: 'checkbox',
                default: true,
                help: 'Displays a loadout dropdown and estimate button on combat task cards.',
            },
            taskEfficiencyRating: {
                id: 'taskEfficiencyRating',
                label: 'Show task efficiency rating (tokens/profit per hour)',
                type: 'checkbox',
                default: true,
                help: 'Displays a color-graded efficiency score based on expected completion time.',
            },
            taskMaterialsIndicator: {
                id: 'taskMaterialsIndicator',
                label: 'Show materials availability on production tasks',
                type: 'checkbox',
                default: true,
                help: 'Shows how many task actions you can complete with current inventory.',
            },
            taskEfficiencyRatingMode: {
                id: 'taskEfficiencyRatingMode',
                label: 'Efficiency algorithm',
                type: 'select',
                default: 'gold',
                options: [
                    { value: 'tokens', label: 'Task tokens per hour' },
                    { value: 'gold', label: 'Task profit per hour' },
                ],
                help: 'Choose whether to rate by task token payout or total profit.',
            },
            taskEfficiencyGradient: {
                id: 'taskEfficiencyGradient',
                label: 'Use relative gradient colors',
                type: 'checkbox',
                default: false,
                help: 'Colors efficiency ratings relative to visible tasks.',
            },
            taskQueuedIndicator: {
                id: 'taskQueuedIndicator',
                label: 'Show "Queued" indicator on task cards',
                type: 'checkbox',
                default: true,
                help: 'Displays a status message on task cards when their action is in your action queue',
            },
            taskRerollTracker: {
                id: 'taskRerollTracker',
                label: 'Track task reroll costs',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Tracks how much gold/cowbells spent rerolling each task',
            },
            taskMapIndex: {
                id: 'taskMapIndex',
                label: 'Show combat zone index numbers on tasks',
                type: 'checkbox',
                default: true,
            },
            taskIcons: {
                id: 'taskIcons',
                label: 'Show visual icons on task cards',
                type: 'checkbox',
                default: true,
                help: 'Displays semi-transparent item/monster icons on task cards',
            },
            taskIconsDungeons: {
                id: 'taskIconsDungeons',
                label: 'Show dungeon icons on combat tasks',
                type: 'checkbox',
                default: false,
                help: 'Shows which dungeons contain the monster (requires Task Icons enabled)',
            },
            taskSorter: {
                id: 'taskSorter',
                label: 'Task sorter: Sort tasks by skill type',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Adds the sort button and sorting machinery to the task panel. This switch existed internally but was never in the settings panel, so the feature could not be turned off.',
            },
            taskSorter_autoSort: {
                id: 'taskSorter_autoSort',
                label: 'Automatically sort tasks when opening task panel',
                type: 'checkbox',
                default: false,
                help: 'Automatically sorts tasks by skill type when you open the task panel',
            },
            taskSorter_sortAfterRead: {
                id: 'taskSorter_sortAfterRead',
                label: 'Sort tasks after reading new ones',
                type: 'checkbox',
                default: false,
                help: 'Sorts the board again once you press Read, since new tasks always arrive at the end',
            },
            taskSorter_hideButton: {
                id: 'taskSorter_hideButton',
                label: 'Hide Sort Tasks button',
                type: 'checkbox',
                default: false,
                help: 'Hides the Sort Tasks button while keeping auto-sort functional',
            },
            taskSorter_sortMode: {
                id: 'taskSorter_sortMode',
                label: 'Task sort mode',
                type: 'select',
                default: 'skill',
                options: [
                    { value: 'skill', label: 'Skill / Zone' },
                    { value: 'time', label: 'Time to Completion' },
                    { value: 'protection', label: 'Protection (unprotected first)' },
                ],
                help: 'How tasks are ordered when clicking Sort Tasks. "Time to Completion" sorts fastest tasks first; combat and completed tasks go to the bottom. "Protection" puts unprotected tasks first.',
            },
            taskInventoryHighlighter: {
                id: 'taskInventoryHighlighter',
                label: 'Enable Task Inventory Highlighter button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to dim inventory items not needed for your current non-combat tasks',
            },
            taskStatistics: {
                id: 'taskStatistics',
                label: 'Show task statistics button on Tasks panel',
                type: 'checkbox',
                default: true,
                help: 'Adds a Statistics button to the Tasks panel showing overflow time, expected rewards, and completion estimates',
            },
            taskClaimCollector: {
                id: 'taskClaimCollector',
                label: 'Move Claim Reward buttons to top of task list',
                type: 'checkbox',
                default: true,
                help: 'Moves all Claim Reward buttons to a stack at the top of the task list so you can click the same spot repeatedly to claim all completed tasks',
            },
            taskClaimToast: {
                id: 'taskClaimToast',
                label: 'Show a toast summary when a task is claimed',
                type: 'checkbox',
                default: false,
                help: 'Pops a brief toast naming the coins, tokens, and items a claimed task paid out — the reward the claimed card no longer shows once it is gone.',
            },
            taskRerollSpendBadge: {
                id: 'taskRerollSpendBadge',
                label: 'Show total reroll spend next to the task slot count',
                type: 'checkbox',
                default: true,
                help: 'Sums the reroll cost already sunk into the tasks currently on the board and shows it next to the slot count, without opening Statistics.',
            },
            taskGoMerge: {
                id: 'taskGoMerge',
                label: 'Merge duplicate tasks on Go',
                type: 'checkbox',
                default: true,
                help: 'When clicking Go on a task, combines the required amounts of all in-progress tasks for the same action into a single pre-filled count',
            },
            taskRerollProtection: {
                id: 'taskRerollProtection',
                label: 'Task reroll protection',
                type: 'checkbox',
                default: true,
                help: 'Protect specific tasks from accidental rerolling. Protected tasks get a green highlight and require a confirmation click before rerolling. A shield icon appears in the task panel to configure protected zones.',
            },
            taskRerollProtection_hideHighlight: {
                id: 'taskRerollProtection_hideHighlight',
                label: 'Task reroll protection: Hide green highlight',
                type: 'checkbox',
                default: false,
                help: 'Removes the green outline/glow from protected tasks while keeping the reroll confirmation active.',
            },
            taskAutoReroll: {
                id: 'taskAutoReroll',
                label: 'Task auto-reroll reminder',
                type: 'checkbox',
                default: true,
                help: 'Highlights tasks you want to reroll with a red border and reminder badge. Configure per-character via the target icon in the task panel.',
            },
            taskAutoReroll_belowPar: {
                id: 'taskAutoReroll_belowPar',
                label: 'Also flag tasks rating below the board ("Below par")',
                type: 'checkbox',
                default: false,
                help:
                    'With the reminder on, also give the red border and a "Below par" badge to any task whose ' +
                    'rate sits below the board median by more than its next reroll would cost. Off (the default) ' +
                    'leaves only your auto-reroll list flagged.',
            },
            tasks_rerollWalk: {
                id: 'tasks_rerollWalk',
                label: 'Reroll walk: step through the board one click at a time',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a floating Reroll walk panel to the Tasks page (and a 🎲 in the task panel header to ' +
                    'show or hide it). It works down the board using your protection list and that popup’s ' +
                    '"Block rerolls at" thresholds, and tells you what the next click will do — nothing happens ' +
                    'until you press it. One click is always exactly one game action: the walk never chains ' +
                    'clicks, never runs on a timer, and stops the moment a card is not what it planned for.',
            },
            tasks_rerollWalkCurrency: {
                id: 'tasks_rerollWalkCurrency',
                label: 'Reroll walk: which currency to pay with',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Cheapest (compare in coins)' },
                    { value: 'cowbell', label: 'Prefer cowbells' },
                    { value: 'coin', label: 'Prefer coins' },
                ],
                help: 'Cheapest values a cowbell through the Bag of 10 Cowbells and picks whichever of the two rerolls costs less in coins. Either preference falls back to the other currency when its own is blocked. A free reroll is always taken first.',
            },
            tasks_mergedCraftingWalk: {
                id: 'tasks_mergedCraftingWalk',
                label: 'Tasks: walk several tasks that share a crafting chain as one',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a “Merged crafting walk” button to the task panel header. It plans each ' +
                    'production task on the board, groups the ones whose chains share a craft step, and ' +
                    'offers one guided walk per group — naming the tasks it covers and how many steps the ' +
                    'merge saves. A shared intermediate is then crafted once at the combined count instead ' +
                    'of twice at two part-counts. The walk is the same one the crafting plan uses: it opens ' +
                    'each step and fills in the count, and never presses the button.',
            },
            tasks_rerollWalkTrashAtLimit: {
                id: 'tasks_rerollWalkTrashAtLimit',
                label: 'Reroll walk: discard a task once both reroll options are blocked',
                type: 'checkbox',
                default: true,
                help: 'When both the coin and the cowbell reroll would cost at or over the shield popup’s "Block rerolls at" thresholds, offer to discard the task (the red trash can) rather than leaving it on the board. Turn off to skip past it instead.',
            },
        },
    },

    ui: {
        title: 'UI & Appearance',
        icon: '🎨',
        settings: {
            accountView: {
                id: 'accountView',
                label: 'Account view: All characters on one screen',
                type: 'checkbox',
                default: true,
                help:
                    'A single panel covering the whole account rather than the character you happen to be logged in ' +
                    'as: combined networth with each character’s share of it, per-character status (what each one is ' +
                    'doing, how long is left, whether anything is idle). Reads the data each character has already ' +
                    'recorded, so a character shows up once it has been played with Toolasha running.',
            },
            sessionBriefing: {
                id: 'sessionBriefing',
                label: 'Session briefing: One card on login saying what needs you',
                type: 'checkbox',
                default: true,
                // The briefing is drawn once, at login. Turning it on mid-session
                // has nothing left to draw and turning it off leaves the card
                // that is already up — so say so rather than look broken.
                requiresRefresh: true,
                help:
                    'Every other warning in the script fires while you are here, so the one thing none of them can ' +
                    'cover is the time you were away. This meets you at the door with only the lines that have ' +
                    'something to say — an empty queue and since when, tasks waiting or slots about to overflow, a ' +
                    'community buff about to lapse, the consumable that runs dry first, listings filled or ' +
                    'undercut, an unfinished enhancement run, your guild trial signup, labyrinth entries banked, ' +
                    'and any other character that has gone idle. Each line opens the panel that fixes it. Close it ' +
                    'to dismiss it until you switch character or reload; reopen it from the Briefing overlay row or ' +
                    'the command palette.',
            },
            equipmentMismatchWarning: {
                id: 'equipmentMismatchWarning',
                label: 'Warn when the gear contradicts the action',
                type: 'checkbox',
                default: true,
                help:
                    'A pulsing pill in the header when the kit and the running action disagree: a production piece ' +
                    'still worn in combat, or — the one that costs you hours — a cooking, gathering, crafting or ' +
                    'enhancing action running while the piece that would speed it up sits unequipped in your bag. ' +
                    'Each piece is checked against the game’s own item data before it is named, and the whole ' +
                    'thing goes quiet inside a labyrinth run, where the run picks the loadout rather than you',
            },
            overlayPanel: {
                id: 'overlayPanel',
                label: 'Overlay Panel: One floating panel other features add a row to',
                type: 'checkbox',
                default: true,
                // The overlay's `initialize` returns immediately when the switch
                // is off, and there is no matching teardown — turning it on does
                // nothing until the page reloads, and turning it off leaves the
                // panel running. Both are honest only with a reload.
                requiresRefresh: true,
                help: 'A configurable overlay. Open it from the Overlay tab beside Inventory, then use the gear to choose which rows show and in what order. Rows appear as features gain them. Its ⇲ button docks it below the character tabs, where it takes its own space instead of covering the game',
            },
            overlayTabButton: {
                id: 'overlayTabButton',
                label: 'Overlay tab button',
                type: 'checkbox',
                default: true,
                help: 'Adds an Overlay switch to the character tabs, beside Inventory and before Optimizer, so the overlay can be shown and hidden without opening settings. Needs the Overlay Panel above',
            },
            commandPalette: {
                id: 'commandPalette',
                label: 'Command palette (Ctrl+K)',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Ctrl+K (or Cmd+K) opens a search box listing every panel, every overlay row, every saved overlay layout and every setting by name — arrow keys and Enter to choose, Escape to dismiss. Ignored while you are typing in chat or any other input',
            },
            goalPlanner: {
                id: 'goalPlanner',
                label: 'Goal Planner: Ordered steps, cost and time to reach a goal',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help:
                    'A floating panel (Ctrl+K → Goal Planner) that turns a goal — 500M coins, Sinister Cape +10, ' +
                    'Enhancing 110, Observatory 8 — into the ordered steps to get there, each with its own cost and ' +
                    'time. Composes the calculators the rest of the script already uses: buy-versus-craft, the ' +
                    'enhancement path optimiser on your own stats, profit and experience per hour, house upgrade ' +
                    'costs. Press Refresh to re-price against the current market; steps you have since satisfied ' +
                    'come back struck through rather than disappearing',
            },
            ironCowFarm: {
                // Display name is "Iron Bell Farming"; the setting id is kept as
                // ironCowFarm since settings persist by id and renaming it would
                // drop an existing user's saved preference.
                id: 'ironCowFarm',
                label: 'Iron Bell Farming: The cowbell-farming plan, and what it earns',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help:
                    'A floating panel (Ctrl+K → Iron Bell Farming) holding the standard iron-cow route to farming gold ' +
                    'for cowbells — the skills to level, the jewelry to craft, then the endless Star Fruit → ' +
                    'decompose → coinify loop — with each stage ticking itself off against your own levels, gear ' +
                    'and house. Costs the loop from your actual rates through the gathering and alchemy ' +
                    'calculators, and converts it to bells per hour, per day and per week at the current cowbell ' +
                    'price. All its gold is coinify output, never a market sale, because an iron cow cannot sell',
            },
            draggableModals: {
                id: 'draggableModals',
                label: 'Draggable modals',
                type: 'checkbox',
                default: true,
                help: 'Makes game popup modals draggable. Position is remembered per modal type across sessions.',
            },
            formatting_useKMBFormat: {
                id: 'formatting_useKMBFormat',
                label: 'Number format mode',
                type: 'select',
                default: 'compact',
                options: [
                    { value: 'full', label: 'Full (1,250,000)' },
                    { value: 'threshold', label: 'Abbreviate after 4 digits (1,250K)' },
                    { value: 'compact', label: 'Always abbreviate (1.25M)' },
                ],
                help: 'Controls how large numbers are displayed throughout the UI',
            },
            formatting_precision: {
                id: 'formatting_precision',
                label: 'Abbreviation precision (decimal digits)',
                type: 'select',
                default: '2',
                options: [
                    { value: '1', label: '1 digit (1.2M)' },
                    { value: '2', label: '2 digits (1.25M)' },
                    { value: '3', label: '3 digits (1.250M)' },
                    { value: '4', label: '4 digits (1.2500M)' },
                ],
                help: 'Number of decimal places shown when numbers are abbreviated with K/M/B suffixes',
            },
            ui_externalLinks: {
                id: 'ui_externalLinks',
                label: 'Left sidebar: Show external tool links',
                type: 'checkbox',
                default: true,
                help: 'Adds quick links to Combat Sim, Market Tracker, Enhancelator, and Milkonomy',
            },
            hideLabyrinthBadge: {
                id: 'hideLabyrinthBadge',
                label: 'Left sidebar: Hide Labyrinth ping badge',
                type: 'checkbox',
                default: false,
            },
            hideGuildBadge: {
                id: 'hideGuildBadge',
                label: 'Left sidebar: Hide Guild notification badge',
                type: 'checkbox',
                default: false,
            },
            panelSizeMemory: {
                id: 'panelSizeMemory',
                label: 'Layout: Remember panel sizes you drag',
                type: 'checkbox',
                default: true,
                help: 'The game forgets panel widths on reload. This records whatever a divider drag changes and reapplies it next session — only styles the game itself wrote in response to your own drag are replayed, and a remembered size is dropped if the layout changes shape.',
            },
            tabReorder: {
                id: 'tabReorder',
                label: 'Character panel: Drag-and-drop tab reordering',
                type: 'checkbox',
                default: true,
                help: 'Drag tabs to rearrange the order of Inventory, Toolasha, Equipment, Houses, Abilities, and Loadout. Order persists through refresh.',
            },
            expPercentage: {
                id: 'expPercentage',
                label: 'Left sidebar: Show skill XP percentages',
                type: 'checkbox',
                default: true,
            },
            combatLevelProgress: {
                id: 'combatLevelProgress',
                label: 'Left sidebar: Show decimal Combat Level',
                type: 'checkbox',
                default: true,
                help: "Shows the unrounded Combat Level formula value from current whole skill levels (e.g. 133.2). MWI's native sidebar floors it to an integer for display. The XP-weighted progress toward the next Combat Level lives in the Combat Level panel.",
            },
            itemIconLevel: {
                id: 'itemIconLevel',
                label: 'Bottom left corner of icons: Show equipment level',
                type: 'checkbox',
                default: true,
            },
            loadoutEnhancementDisplay: {
                id: 'loadoutEnhancementDisplay',
                label: 'Loadout panel: Show highest-owned enhancement level on equipment icons',
                type: 'checkbox',
                default: true,
            },
            loadoutSnapshot: {
                id: 'loadoutSnapshot',
                label: 'Loadout panel: Use saved loadout snapshots in profit calculations',
                type: 'checkbox',
                default: true,
                help: "When you queue an action, Toolasha predicts its XP, time, and profit using the saved loadout for that skill (skill-default → all-skills-default → any saved loadout → currently-equipped). Save your loadouts in-game so they're captured. Disable to always predict using currently-equipped gear.",
            },
            showsKeyInfoInIcon: {
                id: 'showsKeyInfoInIcon',
                label: 'Bottom left corner of key icons: Show zone index',
                type: 'checkbox',
                default: true,
            },
            mapIndex: {
                id: 'mapIndex',
                label: 'Combat zones: Show zone index numbers',
                type: 'checkbox',
                default: true,
            },
            combatScale: {
                id: 'combatScale',
                label: 'Battle panel: Resize the fight',
                type: 'checkbox',
                default: false,
                help: 'Scale your side and the enemy side of the battle panel independently, and choose how they sit. A ten-monster wave and a solo fight get the same slab of screen, so one is cramped and the other mostly empty. Every setting below is stored per character, so each one keeps its own arrangement. Technique from Scaley Way Idle by Frotty. Turning this on or off takes a refresh; the numbers below apply as you change them',
            },
            combatScalePlayers: {
                id: 'combatScalePlayers',
                label: 'Battle panel: Your side (%)',
                type: 'number',
                default: 100,
                min: 25,
                max: 200,
                help: 'Size of your own combat units. 100 leaves them as the game draws them',
            },
            combatScaleMonsters: {
                id: 'combatScaleMonsters',
                label: 'Battle panel: Enemy side (%)',
                type: 'number',
                default: 100,
                min: 25,
                max: 200,
                help: 'Size of the enemy combat units, set separately from yours — a wave of ten and a single boss want opposite things',
            },
            combatScaleMethod: {
                id: 'combatScaleMethod',
                label: 'Battle panel: How to resize',
                type: 'select',
                default: 'zoom',
                options: [
                    { value: 'zoom', label: 'Zoom — reflows, so shrinking recovers the space' },
                    { value: 'transform', label: 'Transform — scales in place, leaves a gap' },
                ],
                help: 'Zoom changes the layout size, so a shrunk side actually gives its space back. Transform only redraws smaller and leaves the original box behind; use it if zoom misbehaves in your browser',
            },
            combatScaleOrigin: {
                id: 'combatScaleOrigin',
                label: 'Battle panel: Transform anchor',
                type: 'select',
                default: 'top center',
                options: [
                    { value: 'top center', label: 'Top centre' },
                    { value: 'top left', label: 'Top left' },
                    { value: 'center', label: 'Centre' },
                ],
                help: 'Which corner a scaled side shrinks toward. Only used when resizing by transform',
            },
            combatScaleLayout: {
                id: 'combatScaleLayout',
                label: 'Battle panel: Layout',
                type: 'select',
                default: 'game',
                options: [
                    { value: 'game', label: "Leave the game's own layout" },
                    { value: 'side', label: 'Force side by side' },
                    { value: 'stack', label: 'Force stacked' },
                ],
                help: 'Forcing a layout overrides how the game arranges the two sides at your window width, so it can fight future game changes. Leave it alone unless you want the override',
            },
            combatScalePanelHeight: {
                id: 'combatScalePanelHeight',
                label: 'Character panel: Height (% of window, 0 = leave alone)',
                type: 'number',
                default: 0,
                min: 0,
                max: 100,
                help: 'Height of the inventory/equipment panel beside the fight, as a percentage of the window. Set it taller to see more inventory at once, shorter to give the fight room. 0 leaves the height the game picks',
            },
            updateCheck: {
                id: 'updateCheck',
                label: 'Check for a newer Toolasha release',
                type: 'checkbox',
                default: false,
                help:
                    'On page load, compares the running version against the latest published release and shows a ' +
                    'toast when a newer one exists, with a click-through to the install page. The check is cached ' +
                    'and only goes to the network as often as the interval below allows. Your userscript manager ' +
                    'still updates on its own schedule either way.',
            },
            updateCheckHours: {
                id: 'updateCheckHours',
                label: 'Update check: Hours between checks (0 = every refresh)',
                type: 'number',
                default: 6,
                min: 0,
                max: 168,
                help:
                    'How long a checked answer is trusted before the network is asked again — on page load, and ' +
                    'on the same rhythm while a tab stays open, so hearing about a release needs no refresh. ' +
                    'Refreshes inside the window reuse the cached answer and cost nothing. At 0 every page load ' +
                    'asks the network (the in-tab repeat still paces itself at least an hour apart).',
            },
            welcomeBackValue: {
                id: 'welcomeBackValue',
                label: 'Welcome Back modal: What the time offline was worth',
                type: 'checkbox',
                default: false,
                help:
                    'Adds one line to the game’s Welcome Back modal valuing what you gained and what got consumed ' +
                    'while you were away — net coins, coins per hour offline and XP per hour — priced at market ' +
                    'using the pricing mode from the Market settings. Items with no market price are left out of ' +
                    'the total and counted instead, and the line is not drawn at all if nothing could be priced. ' +
                    'Off by default since the Offline Progress Economics block shows the same and more; turn this ' +
                    'on for the compact one-liner instead.',
            },
        },
    },

    guild: {
        title: 'Guild',
        icon: '👥',
        settings: {
            guildXPTracker: {
                id: 'guildXPTracker',
                label: 'Track guild and member XP over time',
                type: 'checkbox',
                default: true,
                help: 'Records guild and member XP data from WebSocket messages for XP/hr calculations on the Guild panel.',
            },
            guildXPDisplay: {
                id: 'guildXPDisplay',
                label: 'Show XP/hr stats on Guild panel',
                type: 'checkbox',
                default: true,
                help: 'Displays XP/hr rates, rankings, and a weekly chart on the Guild Overview, Members, and Guild Leaderboard tabs. Disable the standalone Guild XP/h userscript if using this.',
            },
            guildIdleDisplay: {
                id: 'guildIdleDisplay',
                label: 'Guild Overview: Show idle members list',
                type: 'checkbox',
                default: true,
                help: 'Displays a list of guild members with no action running on the Guild Overview tab (actions keep running while offline, so offline members without one count too — shown dimmed). Members hiding their online status are included; only their action state is shown, never their presence.',
            },
            guildTrialSignupDisplay: {
                id: 'guildTrialSignupDisplay',
                label: 'Guild Trials: Show unsigned members list',
                type: 'checkbox',
                default: true,
                help: "Displays which guild members have not yet signed up for the current week's skilling and combat trials.",
            },
            guildTrialWhisperTemplate: {
                id: 'guildTrialWhisperTemplate',
                label: 'Guild Trials: Whisper message when clicking a name',
                type: 'text',
                default: "/w {name} Why haven't you signed up for your trial(s) yet?!",
                help: "Message pre-filled in chat when clicking an unsigned member's name. Use {name} for the player's name.",
                templateVariables: [
                    { key: '{name}', label: 'Player Name', description: 'The name of the unsigned guild member' },
                ],
            },
            guildTrialsInfo: {
                id: 'guildTrialsInfo',
                label: 'Guild Trials: Show rates, pace and payout on the In Progress tab',
                type: 'checkbox',
                default: true,
                help:
                    'Measures the pool fill rate or party DPS off the trial cards and adds the ETA to clear the ' +
                    'current tier, how many tiers the hour is on pace for, the next tier’s projected size, and the ' +
                    'Guild Points and token payout the week’s tiers are worth.',
            },
            guildTrialAutoRecord: {
                id: 'guildTrialAutoRecord',
                label: 'Guild Trials: Record a trial automatically when one starts',
                type: 'checkbox',
                default: true,
                help:
                    'Starts a recording session by itself when a trial fight is seen or the In Progress tab ' +
                    'shows a live reading, so the whole hour is captured without having to press anything. ' +
                    'The Record button on the trials block starts and stops one by hand either way.',
            },
            guildTrialDiagnosticTrace: {
                id: 'guildTrialDiagnosticTrace',
                label: 'Guild Trials: Keep a raw diagnostic trace of trial combat',
                type: 'checkbox',
                default: false,
                help:
                    'Records every trial battle message exactly as it arrives, for exporting as a file an external ' +
                    'reviewer can reconstruct the fight from. The file is large — an hour of the spectator stream ' +
                    'is thousands of ticks — and it contains raw combat data, including participant names. ' +
                    'Nothing is uploaded anywhere; the trace lives in memory until you export or clear it.',
            },
            guildTrialsBuildersHallBonus: {
                id: 'guildTrialsBuildersHallBonus',
                label: 'Guild Trials: Builders Hall bonus override (%)',
                type: 'number',
                default: 0,
                help:
                    'Guild Points are Base × (1 + Builders Hall bonus). Leave at 0 to read it from the game once ' +
                    'the guild Buildings tab has been opened; set it here if your guild knows the number and the ' +
                    'game does not expose it.',
            },
            guildTrialsTreasuryBonus: {
                id: 'guildTrialsTreasuryBonus',
                label: 'Guild Trials: Treasury bonus override (%)',
                type: 'number',
                default: 0,
                help:
                    'Token payouts are 0.5 × TotalBasePoints × (1 + Treasury bonus). Leave at 0 to read it from ' +
                    'the game once the guild Buildings tab has been opened.',
            },
            guildMembersActivityTab: {
                id: 'guildMembersActivityTab',
                label: 'Guild Members: Show Activity column on',
                type: 'select',
                default: 'contributions',
                options: [
                    { value: 'status', label: 'Status tab only (native)' },
                    { value: 'contributions', label: 'Contributions tab only' },
                    { value: 'both', label: 'Both tabs' },
                ],
                help: 'Controls where the Activity column appears. "Contributions tab only" hides the native column on Status and shows it on Contributions instead.',
            },
            guildMembersShowGameMode: {
                id: 'guildMembersShowGameMode',
                label: 'Guild Members: Show Game Mode column',
                type: 'checkbox',
                default: false,
                help: 'Shows the MC/IC/LC game mode column (Status tab).',
            },
            guildMembersShowJoined: {
                id: 'guildMembersShowJoined',
                label: 'Guild Members: Show Joined column',
                type: 'checkbox',
                default: true,
                help: 'Shows the date each member joined the guild (Status tab).',
            },
            guildMembersShowLastXPH: {
                id: 'guildMembersShowLastXPH',
                label: 'Guild Members: Show Last XP/h column',
                type: 'checkbox',
                default: true,
                help: 'Shows recent XP/hr tracked by Toolasha (Contributions tab).',
            },
            guildMembersShowLastDayXPH: {
                id: 'guildMembersShowLastDayXPH',
                label: 'Guild Members: Show Last day XP/h column',
                type: 'checkbox',
                default: true,
                help: 'Shows 24-hour average XP/hr tracked by Toolasha (Contributions tab).',
            },
            guildTokenCreditRate: {
                id: 'guildTokenCreditRate',
                label: 'Guild Shop: Guild credits received per guild token',
                type: 'number',
                default: 1,
                min: 0,
                help:
                    'Guild tokens are never listed on the market, so they are priced through the Guild Shop ' +
                    'exchange instead: credits per token × the gold value of a credit, taking whichever credit ' +
                    'colour yields the most gold. This number is now the last resort. Opening a Guild Shop ' +
                    'exchange dialog with a Guild Token selected reads that colour’s real rate off the screen ' +
                    'and remembers it, and client data wins over even that — so in normal play the live rate is ' +
                    'what gets used and this setting is never consulted. It only stands in before any dialog ' +
                    'has been opened, and every figure derived from it is labelled “assumed rate”. Run ' +
                    'Toolasha.debug.tokenExchange() in the console to see every colour’s rate and which one was ' +
                    'picked. Set to 0 to leave tokens unpriced, as they were before.',
            },
            guildCreditValue: {
                id: 'guildCreditValue',
                label: 'Guild Shop: Show gold cost per credit table',
                type: 'checkbox',
                default: true,
                help: 'Injects a cost-efficiency table into each guild credit exchange modal, sorted cheapest first using your profit pricing mode.',
            },
            guildCreditExchangeAdvisor: {
                id: 'guildCreditExchangeAdvisor',
                label: 'Guild Shop: Show exchange advisor (sell → rebuy comparison)',
                type: 'checkbox',
                default: true,
                help: 'When the selected item is not the cheapest option, shows whether selling it and rebuying the best item would yield more credits (accounts for 5% seller tax).',
            },
            guildShrineUpgradePlanner: {
                id: 'guildShrineUpgradePlanner',
                label: 'Guild Shop: Show shrine upgrade planner',
                type: 'checkbox',
                default: true,
                help: 'Adds a shrine upgrade planner to the guild credit exchange panel, showing total credit and token costs to upgrade from your current level to a target level.',
            },
            guildTrialLedger: {
                id: 'guildTrialLedger',
                label: 'Guild Trials: Attendance ledger and roster composition planner',
                type: 'checkbox',
                default: true,
                help:
                    'Keeps a per-member tally of every trial recorded on this client — trials joined, share of ' +
                    'damage, healing and damage taken, deaths and mana-starved time — for far longer than the ' +
                    'four cycles the trials panel archives, and adds a Trial Ledger panel with a sortable table, a ' +
                    'window selector, a CSV export and a pre-sign-up composition check against the kits already ' +
                    'captured.',
            },
            guildRoster: {
                id: 'guildRoster',
                label: 'Guild Roster: Contribution shares and gone-quiet flags',
                type: 'checkbox',
                default: true,
                help: 'Adds a Guild Roster overlay tile and panel showing each member’s share of the XP actually observed over 7 and 30 days, who has gone quiet against their own weekly rate, and a guild level projection. Uses the XP the Guild XP Tracker has already recorded.',
            },
        },
    },

    insights: {
        title: 'Insights',
        icon: '🔍',
        settings: {
            insights_calibration: {
                id: 'insights_calibration',
                label: 'Prediction Calibration: Check profit forecasts against finished runs',
                type: 'checkbox',
                default: true,
                help: 'Records what the profit calculators predicted for an action beside what the loot log says the run actually paid, and flags skills where the forecast is persistently off. Adds a Prediction Calibration overlay tile and panel.',
            },
            insights_calibrationBadges: {
                id: 'insights_calibrationBadges',
                label: 'Prediction Calibration: Show track-record badges beside forecasts',
                type: 'checkbox',
                default: true,
                help: 'Marks profit forecasts (action panel, action bar, alchemy rankings, all-zones sim) with how that forecast has fared against finished runs — e.g. “−12% over 40 runs” when it has run hot, or “on target”. Nothing is shown until enough runs are measured.',
            },
        },
    },

    house: {
        title: 'House',
        icon: '🏠',
        settings: {
            houseUpgradeCosts: {
                id: 'houseUpgradeCosts',
                label: 'Show upgrade costs with market prices and inventory comparison',
                type: 'checkbox',
                default: true,
            },
        },
    },

    leaderboard: {
        title: 'Leaderboard',
        icon: '🏆',
        settings: {
            leaderboardXPTracker: {
                id: 'leaderboardXPTracker',
                label: 'Track player XP over time from Leaderboard',
                type: 'checkbox',
                default: true,
                help: 'Records player XP from leaderboard WebSocket messages for XP/hr calculations on the Leaderboard panel.',
            },
            leaderboardXPDisplay: {
                id: 'leaderboardXPDisplay',
                label: 'Show XP/hr columns on Leaderboard',
                type: 'checkbox',
                default: true,
                help: 'Adds Last XP/h and Last day XP/h columns to the player Leaderboard panel.',
            },
        },
    },

    notifications: {
        title: 'Notifications',
        icon: '🔔',
        settings: {
            notifications_browserEnabled: {
                id: 'notifications_browserEnabled',
                label: 'Allow desktop notifications',
                type: 'checkbox',
                default: false,
                help: 'Master switch for the desktop-notification channel. Ticking this asks the browser for permission — the ask happens here rather than at page load, because a prompt nobody expects is usually dismissed and a dismissed prompt is remembered. With this off, or permission refused, notifications still arrive as an in-page toast when the tab is visible and as a ❗ on the tab title when it is not.',
            },
            notifiEmptyAction: {
                id: 'notifiEmptyAction',
                label: 'Notify when the current character queue is empty',
                type: 'checkbox',
                default: false,
                help: 'Keys on the action queue going from having actions to having none, as reported by the game over the websocket. Covers only the character you are logged in as, and only while the game page is open.',
            },
            notifications_consumableLow: {
                id: 'notifications_consumableLow',
                label: 'Notify when drinks are running low',
                type: 'checkbox',
                default: false,
                help: 'Fires when the soonest drink to run out falls below the "Drink timer: warning threshold (hours)" setting — the same crossing that turns the drink timer amber. Once per crossing, and it re-arms when you restock above the threshold. Requires the Drink Timer feature, and reads the drink slots of the skill you are currently performing plus any skill panel you have open.',
            },
            notifications_marketListingFilled: {
                id: 'notifications_marketListingFilled',
                label: 'Notify when a market listing finishes',
                type: 'checkbox',
                default: false,
                help: 'Keys on the count of finished listings going up — an order that filled completely, or a cancelled one holding a refund. An order still partly filling is not counted, because collecting it achieves nothing. Same rule as the Marketplace badge filter, and works whether or not that filter is on.',
            },
            notifications_marketListingUndercut: {
                id: 'notifications_marketListingUndercut',
                label: 'Notify when a market listing of yours is undercut',
                type: 'checkbox',
                default: false,
                help: 'Compares each active sell listing of yours against the current best ask for that item and enhancement level, and each buy order against the best bid — a strictly better price than yours means you have been beaten; matching the best price is still competitive and says nothing. The figures come from the market data this script already holds, which can be up to 15 minutes old: the message carries the age of the figure it used, and data older than that — or an item with no cached price at all — is treated as unknown rather than as an undercut. Once per listing per undercut, re-arming when you reprice the listing or your price is the best again.',
            },
            notifications_savingsGoalReached: {
                id: 'notifications_savingsGoalReached',
                label: 'Notify when a savings goal becomes affordable',
                type: 'checkbox',
                default: false,
                help: 'Fires the first time a target on the Equipment Savings list — a piece of gear, an ability level or a house room — costs less than what you can spend, using exactly the figures that panel draws (trade-in value of the piece you are replacing, market orders counted or not per your setting, crafts costed from their inputs). Prices come from the market data this script already holds, so the message carries the age of the figures behind the cost and says outright when they are older than the 15-minute cache window. Once per goal, re-arming when you spend back below the cost, when a price puts it out of reach again, or when you change the target. A goal you reached by levelling up or building rather than buying is skipped rather than announced.',
            },
            notifications_priceTargetReached: {
                id: 'notifications_priceTargetReached',
                label: 'Notify when a watchlist price target is reached',
                type: 'checkbox',
                default: false,
                help: 'Fires when a pinned item on the price history panel reaches the target you set on its chip — an ask target when somebody is selling at or under your price, a bid target when somebody is buying at or above it. Set one with the ◎ button on the chip; it opens seeded with the current price, so a click and Enter is enough. The evidence is the pooled price history dataset, which is the only source that dates a sighting honestly, so this needs "Price history panel (pooled data)" switched on — with it off there is nothing to compare against and the alert stays silent. A sighting older than 15 minutes fires nothing, and the message says how old the one it used actually was. Once per target, re-arming when a fresh sighting puts the price back on the other side of it or when you change the target.',
            },
            notifications_otherCharacterIdle: {
                id: 'notifications_otherCharacterIdle',
                label: 'Notify when another character has run out of queue',
                type: 'checkbox',
                default: false,
                help: 'Projected, not observed. Each other character queue is captured when you switch away from it, and this fires once that much time has elapsed — it cannot see a character while you are not logged into it, so anything queued there from elsewhere is invisible to it. Characters with an unbounded action queued are skipped, and a character is announced again only after you next switch away from it.',
            },
            notifications_labyrinthRunFinished: {
                id: 'notifications_labyrinthRunFinished',
                label: 'Notify when the labyrinth stops',
                type: 'checkbox',
                default: false,
                help: "Keys on your current action leaving the labyrinth — the queued rooms ran out, or the run ended on a lost fight — and moving on to whatever was queued next, or to nothing. Read off the action queue rather than the run's active flag, because a run whose path has been walked stays active while you wander off, and that is the moment to queue more rooms. Reports the deepest floor reached and what the character is doing instead; it cannot say why, since the payload carries no reason. Once per stop; queuing the labyrinth again re-arms it.",
            },
            notifications_combatConsumableLow: {
                id: 'notifications_combatConsumableLow',
                label: 'Notify when a combat consumable is running low',
                type: 'checkbox',
                default: false,
                help: "Fires when the soonest food or drink in your current fight to run out falls under the hours below — the same 'stops in …' reading the Consumables panel shows for your character. Your own slots only. Once per crossing; restocking back above the threshold re-arms it.",
            },
            notifications_combatConsumableLowHours: {
                id: 'notifications_combatConsumableLowHours',
                label: 'Combat consumable warning threshold (hours)',
                type: 'number',
                default: 3,
                help: 'How many hours of supply are left when the alert above fires. Decimals are fine (0.5 is half an hour).',
            },
            notifications_labyrinthEntryAvailable: {
                id: 'notifications_labyrinthEntryAvailable',
                label: 'Notify when a labyrinth entry regenerates',
                type: 'checkbox',
                default: false,
                help: 'The Labyrinth holds up to five entries and regenerates one on a cooldown (a couple of days, less with cooldown upgrades). Fires when the stock rises — the server pushes the new count — or when the projected regeneration instant passes on an open tab, computed from lastLabyrinthTimestamp + labyrinthCooldownHours. Once per regeneration; a full stock is announced once so a regenerated entry does not sit wasted at the cap.',
            },
            notifications_combatDeath: {
                id: 'notifications_combatDeath',
                label: 'Notify when you die in combat',
                type: 'checkbox',
                default: false,
                help: 'Keys on the server’s own death count for your character going up between battles — your deaths only, not the party’s. One message per cooldown rather than one per death, so a zone that is killing you repeatedly says so once and the total in the message tells you how bad it got. Deaths that happened before you switched this on are not announced.',
            },
            notifications_skillLevelUp: {
                id: 'notifications_skillLevelUp',
                label: 'Notify when you hit a skill milestone',
                type: 'checkbox',
                default: false,
                help: 'Fires on the skill milestones the game broadcasts to guild chat as “… has reached level …” (100, 105, and so on) — not every single level. It keys off that broadcast itself (the structured system message, not the scraped sentence) and announces only the one whose subject is your character, so it needs a guild and guild chat coming through. One message per milestone.',
            },
            notifications_ttlTargetReached: {
                id: 'notifications_ttlTargetReached',
                label: 'Notify when a skill reaches its Time to Level target',
                type: 'checkbox',
                default: false,
                help: 'Reads the target level you set in the Time to Level tile (the Combat Level panel selection) and says so once the skill reaches it. Only a target you actually chose counts — the tile’s default “next level” is left to the level-up notification. Re-arms when you pick a new target; a target already passed when you switched this on is not announced.',
            },
            notifications_enhancementTarget: {
                id: 'notifications_enhancementTarget',
                label: 'Notify when an item reaches its enhancement target',
                type: 'checkbox',
                default: false,
                help: 'Reads the “enhance until +N” you set in the game’s own enhancing panel, and the level the item is at after each attempt — so it works whether or not the Enhancement Tracker is on. Nothing is announced when no target is set, since there is no ending to announce. Once per item and target, re-arming when that item is seen below the target again.',
            },
            notifications_trialStarting: {
                id: 'notifications_trialStarting',
                label: 'Notify when a guild trial is about to start',
                type: 'checkbox',
                default: false,
                help: 'The guild panel states the next trial’s schedule (“Scheduled Wed 04:00 PM 2h 24m”). This announces it once the countdown is inside the lead time below, and again the moment the trial actually starts. The countdown is only read while the guild panel is open — no socket message carries a trial schedule.',
            },
            notifications_trialStartLeadMinutes: {
                id: 'notifications_trialStartLeadMinutes',
                label: 'Guild trial warning lead time (minutes)',
                type: 'number',
                default: 10,
                min: 1,
                max: 120,
                help: 'How long before a scheduled guild trial to announce it.',
            },
            notifications_trialResults: {
                id: 'notifications_trialResults',
                label: 'Notify when a guild trial finishes, with what it paid',
                type: 'checkbox',
                default: false,
                help: 'Announces the Guild Points banked and the token payout — every eligible member’s share and a participant’s — as soon as the guild panel reports the cycle complete.',
            },
            notifications_taskSlotsFull: {
                id: 'notifications_taskSlotsFull',
                label: 'Notify before your task slots fill up',
                type: 'checkbox',
                default: false,
                help: 'A task that arrives with no free slot is simply not given — there is no queue behind the board. This projects when the last free slot fills, from the server’s own slot cap, task cooldown and last-task time, so it works with the task panel closed. It is a projection, not an observation: it assumes the cadence holds and that nothing frees a slot in the meantime, and it can only be as fresh as the last message the game sent this tab. Completing, claiming or discarding a task moves the deadline and re-arms the warning. A board that is already full says so once.',
            },
            notifications_taskSlotsLeadHours: {
                id: 'notifications_taskSlotsLeadHours',
                label: 'Task slots warning lead time (hours)',
                type: 'number',
                default: 8,
                min: 1,
                max: 48,
                help: 'How long before the last free task slot fills to warn you — enough notice to claim or clear something. Default: 8.',
            },
            notifications_communityBuffExpiring: {
                id: 'notifications_communityBuffExpiring',
                label: 'Notify before a community buff expires',
                type: 'checkbox',
                default: false,
                help: 'Reads the expiry the server sends with each community buff, so the warning is timed off the real end of the buff rather than a countdown read from the screen. Fires once per expiry; a donation that extends a buff pushes the expiry out and arms the warning again for the new one. Use the per-buff switches below to pick which ones you care about.',
            },
            notifications_communityBuffLeadMinutes: {
                id: 'notifications_communityBuffLeadMinutes',
                label: 'Community buff warning: minutes ahead',
                type: 'number',
                default: 15,
                min: 5,
                max: 120,
                help: 'How many minutes before a community buff’s actual expiry to warn you — enough notice to get to the Cowbell Store and donate. Default: 15.',
            },
            notifications_communityBuff_experience: {
                id: 'notifications_communityBuff_experience',
                label: 'Community buff: Experience',
                type: 'checkbox',
                default: true,
                help: 'Include the Experience community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_gatheringQuantity: {
                id: 'notifications_communityBuff_gatheringQuantity',
                label: 'Community buff: Gathering Quantity',
                type: 'checkbox',
                default: true,
                help: 'Include the Gathering Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_productionEfficiency: {
                id: 'notifications_communityBuff_productionEfficiency',
                label: 'Community buff: Production Efficiency',
                type: 'checkbox',
                default: true,
                help: 'Include the Production Efficiency community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_enhancingSpeed: {
                id: 'notifications_communityBuff_enhancingSpeed',
                label: 'Community buff: Enhancing Speed',
                type: 'checkbox',
                default: true,
                help: 'Include the Enhancing Speed community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_combatDropQuantity: {
                id: 'notifications_communityBuff_combatDropQuantity',
                label: 'Community buff: Combat Drop Quantity',
                type: 'checkbox',
                default: true,
                help: 'Include the Combat Drop Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_digestEnabled: {
                id: 'notifications_digestEnabled',
                label: 'Digest mode: batch routine notices into one summary',
                type: 'checkbox',
                default: false,
                help: 'Holds low-urgency notices back and delivers them as one line every few minutes — "Market: 3 undercuts (Cheese, Milk, Flax) · Buffs: 1 lapsing" — instead of one toast each. Nothing is lost: every held notice is written to the Notices log individually as it happens, and the categories on the critical allow-list below are never held. Changes only how you are told, never what you are told about.',
            },
            notifications_digestMinutes: {
                id: 'notifications_digestMinutes',
                label: 'Digest interval (minutes)',
                type: 'number',
                default: 15,
                min: 1,
                max: 240,
                help: 'How long a digest collects for before it goes out. The clock starts with the first held notice rather than restarting with each one, so a steady trickle still produces a summary on schedule. Default: 15.',
            },
            notifications_digestCategories: {
                id: 'notifications_digestCategories',
                label: 'Digest these categories (comma-separated)',
                type: 'text',
                default: 'market, buffs, tasks, labyrinth, guild, skills, enhancement, progress, other',
                help: 'Which categories batch when digest mode is on. Anything not listed here keeps arriving one notice at a time. Known categories: market, buffs, consumables, queue, combat, tasks, labyrinth, guild, skills, enhancement, progress, other.',
            },
            notifications_criticalCategories: {
                id: 'notifications_criticalCategories',
                label: 'Never delay or silence these categories (comma-separated)',
                type: 'text',
                default: 'combat, queue, consumables',
                help: 'The allow-list that outranks both digest mode and quiet hours. Dying, running out of queue and running out of drinks are the things worth waking up for, so they interrupt regardless. Same category names as the digest list above; emptying this makes everything digestible and silenceable.',
            },
            notifications_quietHoursEnabled: {
                id: 'notifications_quietHoursEnabled',
                label: 'Quiet hours: no desktop notifications in a set window',
                type: 'checkbox',
                default: false,
                help: 'Suppresses the desktop-notification channel between the two times below. Notices are still written to the Notices log, still counted on the overlay tile, and still shown in the page — a toast on a tab you are actively looking at is not what quiet hours are about. Categories on the critical allow-list are unaffected.',
            },
            notifications_quietHoursStart: {
                id: 'notifications_quietHoursStart',
                label: 'Quiet hours start (24h, local time)',
                type: 'text',
                default: '23:00',
                help: 'HH:MM in your own local time, read off the wall clock rather than from elapsed time — so the window stays put across a daylight-saving change. A window that ends before it starts crosses midnight, which is the usual case.',
            },
            notifications_quietHoursEnd: {
                id: 'notifications_quietHoursEnd',
                label: 'Quiet hours end (24h, local time)',
                type: 'text',
                default: '07:00',
                help: 'HH:MM in your own local time. Exclusive: an end of 07:00 means the last quiet minute is 06:59. Setting it equal to the start switches the window off rather than silencing the whole day.',
            },
        },
    },

    colors: {
        title: 'Color Customization',
        icon: '🎨',
        settings: {
            color_profit: {
                id: 'color_profit',
                label: 'Profit/Positive Values',
                type: 'color',
                default: '#047857',
                help: 'Color used for profit, gains, and positive values',
            },
            color_loss: {
                id: 'color_loss',
                label: 'Loss/Negative Values',
                type: 'color',
                default: '#f87171',
                help: 'Color used for losses, costs, and negative values',
            },
            color_warning: {
                id: 'color_warning',
                label: 'Warnings',
                type: 'color',
                default: '#ffa500',
                help: 'Color used for warnings and important notices',
            },
            color_info: {
                id: 'color_info',
                label: 'Informational',
                type: 'color',
                default: '#60a5fa',
                help: 'Color used for informational text and highlights',
            },
            color_essence: {
                id: 'color_essence',
                label: 'Essences',
                type: 'color',
                default: '#c084fc',
                help: 'Color used for essence drops and essence-related text',
            },
            color_tooltip_profit: {
                id: 'color_tooltip_profit',
                label: 'Tooltip Profit/Positive',
                type: 'color',
                default: '#047857',
                help: 'Color for profit/positive values in tooltips (light backgrounds)',
            },
            color_tooltip_loss: {
                id: 'color_tooltip_loss',
                label: 'Tooltip Loss/Negative',
                type: 'color',
                default: '#dc2626',
                help: 'Color for loss/negative values in tooltips (light backgrounds)',
            },
            color_tooltip_info: {
                id: 'color_tooltip_info',
                label: 'Tooltip Informational',
                type: 'color',
                default: '#2563eb',
                help: 'Color for informational text in tooltips (light backgrounds)',
            },
            color_tooltip_warning: {
                id: 'color_tooltip_warning',
                label: 'Tooltip Warnings',
                type: 'color',
                default: '#ea580c',
                help: 'Color for warnings in tooltips (light backgrounds)',
            },
            color_text_primary: {
                id: 'color_text_primary',
                label: 'Primary Text',
                type: 'color',
                default: '#ffffff',
                help: 'Main text color',
            },
            color_text_secondary: {
                id: 'color_text_secondary',
                label: 'Secondary Text',
                type: 'color',
                default: '#888888',
                help: 'Dimmed/secondary text color',
            },
            color_border: {
                id: 'color_border',
                label: 'Borders',
                type: 'color',
                default: '#444444',
                help: 'Border and separator color',
            },
            color_gold: {
                id: 'color_gold',
                label: 'Gold/Currency',
                type: 'color',
                default: '#ffa500',
                help: 'Color used for gold and currency displays',
            },
            color_mirror: {
                id: 'color_mirror',
                label: "Philosopher's Mirror",
                type: 'color',
                default: '#ffd700',
                help: "Color for the Philosopher's Mirror usage line in enhancement tooltips",
            },
            color_listing_price_1m: {
                id: 'color_listing_price_1m',
                label: 'Listing Total: 1M+',
                type: 'color',
                default: '#ffd700',
                help: 'Color for market listing total prices of 1 million or more',
            },
            color_listing_price_100k: {
                id: 'color_listing_price_100k',
                label: 'Listing Total: 100K+',
                type: 'color',
                default: '#22c55e',
                help: 'Color for market listing total prices of 100K or more',
            },
            color_listing_price_10k: {
                id: 'color_listing_price_10k',
                label: 'Listing Total: 10K+',
                type: 'color',
                default: '#ffffff',
                help: 'Color for market listing total prices of 10K or more',
            },
            color_listing_price_low: {
                id: 'color_listing_price_low',
                label: 'Listing Total: <10K',
                type: 'color',
                default: '#888888',
                help: 'Color for market listing total prices under 10K',
            },
            color_accent: {
                id: 'color_accent',
                label: 'Script Accent Color',
                type: 'color',
                default: '#22c55e',
                help: 'Primary accent color for script UI elements (buttons, headers, zone numbers, XP percentages, etc.)',
            },
            color_remaining_xp: {
                id: 'color_remaining_xp',
                label: 'Remaining XP Text',
                type: 'color',
                default: '#FFFFFF',
                help: 'Color for remaining XP text below skill bars in left navigation',
            },
            color_xp_rate: {
                id: 'color_xp_rate',
                label: 'XP Rate Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for XP/hr rate text on skill bars in left navigation',
            },
            color_hours_to_level: {
                id: 'color_hours_to_level',
                label: 'Hours to Level Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for "hours till next level" text in skill tooltips',
            },
            color_inv_count: {
                id: 'color_inv_count',
                label: 'Inventory Count Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for inventory count shown on action tiles and in the action detail panel',
            },
            color_invBadge_ask: {
                id: 'color_invBadge_ask',
                label: 'Inventory Badge: Ask Price',
                type: 'color',
                default: '#047857',
                help: 'Color for Ask price badges on inventory items (seller asking price - better selling value)',
            },
            color_invBadge_bid: {
                id: 'color_invBadge_bid',
                label: 'Inventory Badge: Bid Price',
                type: 'color',
                default: '#60a5fa',
                help: 'Color for Bid price badges on inventory items (buyer bid price - instant-sell value)',
            },
            color_transmute: {
                id: 'color_transmute',
                label: 'Transmutation Rates',
                type: 'color',
                default: '#ffffff',
                help: 'Color used for transmutation success rate percentages in Item Dictionary',
            },
            color_queueLength_known: {
                id: 'color_queueLength_known',
                label: 'Queue Length: Known Value',
                type: 'color',
                default: '#ffffff',
                help: 'Color for known queue lengths (when all visible orders are counted)',
            },
            color_queueLength_estimated: {
                id: 'color_queueLength_estimated',
                label: 'Queue Length: Estimated Value',
                type: 'color',
                default: '#60a5fa',
                help: 'Color for estimated queue lengths (extrapolated from 20+ orders at same price)',
            },
        },
    },

    collectionFilters: {
        title: 'Collection Filters',
        icon: '⭐',
        settings: {
            collectionFilters: {
                id: 'collectionFilters',
                label: 'Collection Filters: Count-range, dungeon, and skilling-outfit filters',
                type: 'checkbox',
                default: true,
            },
            collectionFavorites: {
                id: 'collectionFavorites',
                label: 'Collection Favorites: Star (★) items to mark and filter favorites',
                type: 'checkbox',
                default: true,
            },
            collectionFavoritesSection: {
                id: 'collectionFavoritesSection',
                label: 'Collection Favorites: Show favorites section at top of grid',
                type: 'checkbox',
                default: true,
            },
            collectionFilters_skillingBadges: {
                id: 'collectionFilters_skillingBadges',
                label: 'Show collection count badges on skilling action tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays your collection count on skilling actions (open Collections once to populate counts)',
            },
        },
    },

    sync: {
        title: 'Cross-Device Sync',
        icon: '☁️',
        settings: {
            sync_enabled: {
                id: 'sync_enabled',
                label: 'Enable cross-device sync (GitHub gist)',
                type: 'checkbox',
                default: false,
                help:
                    'Carries your Toolasha data between browsers through one private GitHub gist that you own. ' +
                    'Nothing goes to any server of ours, and nothing is sent until you press Push or turn on ' +
                    'automatic sync below.',
            },
            sync_token: {
                id: 'sync_token',
                label: 'GitHub personal access token',
                type: 'password',
                default: '',
                placeholder: 'ghp_… or github_pat_…',
                help:
                    'Needs the "gist" scope and nothing else — a classic token with only that box ticked, or a ' +
                    'fine-grained token with Gists set to read and write. SECURITY: the token is stored in this ' +
                    "browser's local database in plain text, exactly like every other setting, and any script or " +
                    'extension that can read this page can read it. Use a token that can only touch gists, and revoke ' +
                    'it at github.com/settings/tokens if you stop using sync. It is never written into the synced ' +
                    'payload, so pulling on another device will not plant it there.',
            },
            sync_passphrase: {
                id: 'sync_passphrase',
                label: 'Sync passphrase (optional encryption)',
                type: 'password',
                default: '',
                placeholder: 'Leave empty to sync unencrypted',
                help:
                    'When set, the gist holds AES-256 ciphertext instead of readable JSON, so the data is useless to ' +
                    'anyone who gets the gist URL, the token, or your GitHub account. Enter the SAME passphrase on ' +
                    'every device that shares the gist; there is no recovery — a forgotten passphrase means pushing ' +
                    'fresh from a device that still has the data. Like the token, the passphrase is stored in this ' +
                    "browser's local database in plain text, so it hides the gist from GitHub-side readers, not from " +
                    'extensions that can already read this page. It is never uploaded.',
            },
            sync_scope: {
                id: 'sync_scope',
                label: 'What to sync',
                type: 'select',
                default: 'settings',
                options: [
                    { value: 'settings', label: 'Settings only' },
                    { value: 'everything', label: 'Everything (settings + all tracked history)' },
                ],
                help:
                    'Settings only is small and fast. Everything also carries dungeon runs, XP history, loot logs and ' +
                    'the rest — the same contents as "Back Up Everything" — which on a played-in account can be many ' +
                    'megabytes and is split across several files inside the gist.',
            },
            sync_onSwitch: {
                id: 'sync_onSwitch',
                label: 'Push to GitHub on hand-off (character switch or session takeover)',
                type: 'checkbox',
                default: false,
                help:
                    'With sync configured, this device pushes when it stops being the active session: a few ' +
                    'seconds after switching characters, and immediately when another login takes the session ' +
                    'over (a phone, say) — whose own startup pulls then collect the changes. Skipped when ' +
                    'nothing changed.',
            },
            sync_auto: {
                id: 'sync_auto',
                label: 'Sync automatically',
                type: 'checkbox',
                default: false,
                help:
                    'Pulls once shortly after the page loads if the gist is newer than what this device last synced, ' +
                    'and pushes every 15 minutes if anything changed. When both sides have changed you are asked ' +
                    'which one wins rather than the older copy being overwritten quietly.',
            },
        },
    },
};

/**
 * Get all setting IDs in order
 * @returns {string[]} Array of setting IDs
 */
export function getAllSettingIds() {
    const ids = [];
    for (const group of Object.values(settingsGroups)) {
        for (const settingId of Object.keys(group.settings)) {
            ids.push(settingId);
        }
    }
    return ids;
}

/**
 * Get a setting definition by ID
 * @param {string} settingId - Setting ID
 * @returns {Object|null} Setting definition or null
 */
export function getSettingDefinition(settingId) {
    for (const group of Object.values(settingsGroups)) {
        if (group.settings[settingId]) {
            return group.settings[settingId];
        }
    }
    return null;
}

/**
 * Check if a setting has dependencies
 * @param {string} settingId - Setting ID
 * @returns {string[]} Array of dependency setting IDs
 */
export function getSettingDependencies(settingId) {
    const def = getSettingDefinition(settingId);
    return def?.dependencies || [];
}
