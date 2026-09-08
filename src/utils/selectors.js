/**
 * DOM Selector Constants
 * Centralized selector strings for querying game elements
 * If game class names change, update here only
 */

/**
 * Game UI Selectors (class names from game code)
 */
export const GAME = {
    // Header
    TOTAL_LEVEL: '[class*="Header_totalLevel"]',
    // The header's current-action block, and the community-buff row drawn
    // inside it. A mirrored pair: the buff row is a descendant of the action
    // info, so a header that draws one without the other is a refactor.
    HEADER_ACTION_INFO: '[class*="Header_actionInfo"]',
    HEADER_COMMUNITY_BUFFS: '[class*="Header_communityBuffs"]',

    // Settings Panel
    SETTINGS_PANEL_TITLE: '[class*="SettingsPanel_title"]',
    SETTINGS_TABS_CONTAINER: 'div[class*="SettingsPanel_tabsComponentContainer"]',
    TABS_FLEX_CONTAINER: '[class*="MuiTabs-flexContainer"]',
    TAB_PANELS_CONTAINER: '[class*="TabsComponent_tabPanelsContainer"]',
    TAB_PANEL: '[class*="TabPanel_tabPanel"]',

    // Tab strips (shared by every game panel that draws tabs)
    TABS_CONTAINER: '[class*="TabsComponent_tabsContainer"]',
    TAB_BADGE: '[class*="TabsComponent_badge"]',

    // Game Panel
    GAME_PANEL: 'div[class*="GamePage_gamePanel"]',
    // The full-screen "Disconnected…" / "Connecting…" message (with its Refresh
    // button) that replaces the game when the socket is gone — e.g. after the
    // account logs in from another tab. While it is up, the header and nav are
    // torn down, so their absence is a connection fact and not a selector break.
    CONNECTION_MESSAGE: '[class*="GamePage_connectionMessage"]',

    // Skill Action Detail
    SKILL_ACTION_DETAIL: '[class*="SkillActionDetail_skillActionDetail"]',
    // Only the gathering/production/crafting detail panel; the alchemy and
    // enhancing variants share the SKILL_ACTION_DETAIL wrapper but draw no name.
    SKILL_ACTION_DETAIL_REGULAR: '[class*="SkillActionDetail_regularComponent"]',
    SKILL_ACTION_NAME: '[class*="SkillActionDetail_name"]',
    SKILL_ACTION_ITEM_REQUIREMENTS: '[class*="SkillActionDetail_itemRequirements"]',
    ENHANCING_COMPONENT: 'div[class*="SkillActionDetail_enhancingComponent"]',

    // Action Queue
    QUEUED_ACTIONS: '[class*="QueuedActions_action"]',
    MAX_ACTION_COUNT_INPUT: '[class*="maxActionCountInput"]',

    // Tasks
    TASK_PANEL: '[class*="TasksPanel_taskSlotCount"]',
    TASK_LIST: '[class*="TasksPanel_taskList"]',
    TASK_CARD: '[class*="RandomTask_randomTask"]',
    TASK_NAME: '[class*="RandomTask_name"]',
    TASK_INFO: '[class*="RandomTask_taskInfo"]',
    TASK_ACTION: '[class*="RandomTask_action"]',
    TASK_REWARDS: '[class*="RandomTask_rewards"]',
    TASK_CONTENT: '[class*="RandomTask_content"]',
    TASK_NAME_DIV: 'div[class*="RandomTask_name"]',
    // Buttons within a task card. "Button_button" is the shared base class every
    // button carries, so it is paired with the variant class ("Button_buy"/
    // "Button_success") that actually distinguishes a claim button from any other.
    TASK_CLAIM_BUTTON: 'button[class*="Button_button"][class*="Button_buy"]',
    TASK_GO_BUTTON: 'button[class*="Button_success"]',
    // The Tasks panel's own <h1> title, used to anchor the sprite-warning banner
    TASKS_PANEL_TITLE: 'h1[class*="TasksPanel_title"]',

    // House Panel
    HOUSE_HEADER: '[class*="HousePanel_header"]',
    HOUSE_COSTS: '[class*="HousePanel_costs"]',
    HOUSE_ITEM_REQUIREMENTS: '[class*="HousePanel_itemRequirements"]',

    // Loot Log
    LOOT_LOG_CONTAINER: '[class*="LootLogPanel_actionLoots"]',
    // "actionLoot" is a prefix of "actionLoots" (the container above), so this
    // needs the trailing "__" — the point where the CSS-module hash begins — to
    // stay a single entry rather than also matching the whole container.
    LOOT_LOG_ENTRY: '[class*="LootLogPanel_actionLoot__"]',

    // Inventory
    INVENTORY_ITEMS: '[class*="Inventory_items"]',
    INVENTORY_CATEGORY_BUTTON: '[class*="Inventory_categoryButton"]',
    INVENTORY_LABEL: '[class*="Inventory_label"]',

    // Items
    ITEM_CONTAINER: '[class*="Item_itemContainer"]',
    // "Item_item" is a prefix of "Item_itemContainer" (above), so this needs the
    // trailing "__" too, or it would match every item container as well.
    ITEM_ITEM: '[class*="Item_item__"]',
    ITEM_COUNT: '[class*="Item_count"]',
    ITEM_NAME: '[class*="Item_name"]',
    ITEM_TOOLTIP_TEXT: '[class*="ItemTooltipText_itemTooltipText"]',

    // Navigation/Experience Bars
    NAV_LEVEL: '[class*="NavigationBar_level"]',
    NAV_CURRENT_EXPERIENCE: '[class*="NavigationBar_currentExperience"]',
    // Matches loosely on purpose — consumers use it via closest() the same way
    NAV_BAR: '[class*="NavigationBar_nav"]',

    // Chat
    CHAT_MESSAGE: '[class*="ChatMessage_chatMessage"]',
    CHAT_INPUT_CONTAINER: '[class*="Chat_chatInputContainer"]',

    // Combat
    COMBAT_UNIT: '[class*="CombatUnit_combatUnit"]',
    COMBAT_UNIT_NAME: '[class*="CombatUnit_name"]',
    // Party members beside a full combat card are drawn as mini units — small
    // clickable boxes with their own name line (guild trial fights draw the
    // whole party this way next to the player's own card)
    MINI_UNIT: '[class*="MiniUnit_miniUnit"]',
    MINI_UNIT_NAME: '[class*="MiniUnit_name"]',
    BATTLE_PANEL: '[class*="BattlePanel_battlePanel"]',
    BATTLE_MONSTERS_AREA: '[class*="BattlePanel_monstersArea"]',

    // Marketplace
    // Prefix-matched on purpose: the game ships these with a CSS-module hash
    // suffix (e.g. MarketplacePanel_currentItem__3ercC) that changes on every
    // rebuild, so a marketplace UI rework rehashes them. Match the stable base.
    MARKETPLACE_PANEL: '[class*="MarketplacePanel_marketplacePanel"]',
    MARKETPLACE_ITEMS: '[class*="MarketplacePanel_marketItems"]',
    MARKETPLACE_CURRENT_ITEM: '[class*="MarketplacePanel_currentItem"]',
    MARKETPLACE_ORDER_BOOKS: '[class*="MarketplacePanel_orderBooksContainer"]',
    MARKETPLACE_MY_LISTINGS: '[class*="MarketplacePanel_myListingsTableContainer"]',
    MARKETPLACE_NEW_LISTING_BUTTONS: '[class*="MarketplacePanel_newListingButtonsContainer"]',
    // The generic sub-panel wrapper the marketplace (and other panels) sit inside
    SUBPANEL_CONTAINER: '[class*="MainPanel_subPanelContainer"]',

    // Enhancement
    PROTECTION_ITEM_INPUT: '[class*="protectionItemInputContainer"]',

    // Leaderboard. The table is drawn both in the standalone Leaderboard panel
    // and inside the guild panel; `LeaderboardPanel_content` wraps it in both
    // (leaderboard-xp-display reaches it with closest()), so it witnesses an
    // open leaderboard without being the table itself.
    LEADERBOARD_TABLE: 'table[class*="LeaderboardPanel_leaderboardTable"]',
    LEADERBOARD_CONTENT: '[class*="LeaderboardPanel_content"]',

    // Item pickers — alchemy's Alchemize/Consumed Item slots and the Enhance
    // Item slot are one component. A picker is drawn as `ItemSelector_emptySlot`
    // until something is in it and as `ItemSelector_itemSelector` afterwards, so
    // a check that must hold on any picker screen has to accept either.
    // `ItemSelector_menu` is the dropdown, and exists only while one is open.
    ITEM_SELECTOR_MENU: 'div[class*="ItemSelector_menu"]',
    ITEM_SELECTOR_SLOT: '[class*="ItemSelector_itemSelector"]',
    ITEM_SELECTOR_EMPTY_SLOT: '[class*="ItemSelector_emptySlot"]',
    /** The action panel's own container for the primary picker — a different component */
    SKILL_ACTION_PRIMARY_ITEM_SELECTOR: '[class*="SkillActionDetail_primaryItemSelectorContainer"]',

    // Guild trial stats modal (test server): the game's own per-member totals.
    // Names carry the exact value in `data-name`; the visible text is truncated.
    GUILD_TRIAL_STATS_TABLE: 'table[class*="GuildPanel_trialStatsTable"]',
    CHARACTER_NAME: '[class*="CharacterName_name"][data-name]',

    // Shared profile popup (the modal another player's name opens)
    SHARABLE_PROFILE_OVERVIEW: 'div[class*="SharableProfile_overviewTab"]',

    // Tooltips
    MUI_TOOLTIP: '.MuiTooltip-tooltip',

    // Frequently used inline prefixes.
    //
    // These were each written out by hand at a dozen or more call sites and never
    // registered, which meant the selector audit had nothing to check them against —
    // a game update could rename any of them and the audit would still report all
    // clear. Registered here so the audit covers them; call sites are free to keep
    // their inline literal, since the audit checks the name, not who spells it.
    ITEM_ENHANCEMENT_LEVEL: '[class*="Item_enhancementLevel"]',
    COLLECTION_TOOLTIP_CONTENT: '[class*="Collection_tooltipContent"]',
    GUILD_PANEL: '[class*="GuildPanel"]',
    MARKETPLACE_MY_LISTINGS_TABLE: '[class*="MarketplacePanel_myListingsTable"]',
    MARKETPLACE_HEADER: '[class*="MarketplacePanel_header"]',

    // The game's own confirm button inside a sell modal. Registered here so the
    // selector audit reports a rename: the Bulk Sell Assistant's Confirm button
    // presses this, and its guard fails CLOSED — on a rename the button would
    // simply refuse for every item with "the modal's own confirm button was not
    // found", which is safe but silent. The game's own button keeps working
    // either way, so a rename costs the shortcut, not the sale.
    MARKETPLACE_SELL_BUTTON: '[class*="Button_sell"]',
    BATTLE_PLAYERS_AREA: '[class*="BattlePanel_playersArea"]',
    SKILL_ACTION_DETAIL_ALCHEMY: '[class*="SkillActionDetail_alchemyComponent"]',
    ENHANCING_PANEL: '[class*="EnhancingPanel_enhancingPanel"]',
    HEADER_ACTION_NAME: '[class*="Header_actionName"]',
    NAVIGATION_BAR_NAV: '[class*="NavigationBar_nav__"]',
};

/**
 * Toolasha-specific selectors (our injected elements)
 */
export const TOOLASHA = {
    // Settings
    SETTINGS_TAB: '#toolasha-settings-tab',
    SETTING_WITH_DEPS: '.toolasha-setting[data-dependencies]',

    // Task features
    TASK_PROFIT: '.mwi-task-profit',
    REROLL_COST_DISPLAY: '.mwi-reroll-cost-display',
    TASK_STATS_BTN: '.toolasha-task-stats-btn',
    TASK_STATS_OVERLAY: '.toolasha-task-stats-overlay',
    TASK_REROLL_SPEND_BADGE: '.toolasha-reroll-spend-badge',

    // Action features
    QUEUE_TOTAL_TIME: '#mwi-queue-total-time',
    FORAGING_PROFIT: '#mwi-foraging-profit',
    PRODUCTION_PROFIT: '#mwi-production-profit',

    // House features
    HOUSE_PRICING: '.mwi-house-pricing',
    HOUSE_PRICING_EMPTY: '.mwi-house-pricing-empty',
    HOUSE_TOTAL: '.mwi-house-total',
    HOUSE_TO_LEVEL: '.mwi-house-to-level',

    // Profile/Combat Score
    SCORE_CLOSE_BTN: '#mwi-score-close-btn',
    SCORE_TOGGLE: '#mwi-score-toggle',
    SCORE_DETAILS: '#mwi-score-details',
    HOUSE_TOGGLE: '#mwi-house-toggle',
    HOUSE_BREAKDOWN: '#mwi-house-breakdown',
    ABILITY_TOGGLE: '#mwi-ability-toggle',
    ABILITY_BREAKDOWN: '#mwi-ability-breakdown',
    EQUIPMENT_TOGGLE: '#mwi-equipment-toggle',
    EQUIPMENT_BREAKDOWN: '#mwi-equipment-breakdown',

    // Market features
    MARKET_PRICE_INJECTED: '.market-price-injected',
    MARKET_PROFIT_INJECTED: '.market-profit-injected',
    MARKET_EV_INJECTED: '.market-ev-injected',
    MARKET_ENHANCEMENT_INJECTED: '.market-enhancement-injected',

    // UI features
    ALCHEMY_DIMMED: '.mwi-alchemy-dimmed',
    EXP_PERCENTAGE: '.mwi-exp-percentage',
    STACK_PRICE: '.mwi-stack-price',
    NETWORTH_HEADER: '.mwi-networth-header',

    // Enhancement
    ENHANCEMENT_STATS: '#mwi-enhancement-stats',

    // Generic
    COLLAPSIBLE_SECTION: '.mwi-collapsible-section',
    EXPANDABLE_HEADER: '.mwi-expandable-header',
    SECTION_HEADER_NEXT: '.mwi-section-header + div',

    // Legacy/cleanup markers
    INSERTED_SPAN: '.insertedSpan',
    SCRIPT_INJECTED: '.script-injected',
    CONSUMABLE_STATS_INJECTED: '.consumable-stats-injected',
};

/**
 * Enhancement-specific input IDs
 */
export const ENHANCEMENT = {
    TILL_LEVEL: '#tillLevel',
    TILL_LEVEL_INPUT: '#tillLevelInput',
    TILL_LEVEL_NUMBER: '#tillLevelNumber',
};

/**
 * Combat Sim Integration
 */
export const COMBAT_SIM = {
    GROUP_COMBAT_TAB: 'a#group-combat-tab',
    GET_PRICES_BUTTON: 'button#buttonGetPrices',
};
