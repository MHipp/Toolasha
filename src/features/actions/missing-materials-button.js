/**
 * Missing Materials Marketplace Button
 * Adds button to production and enhancement panels that opens marketplace with tabs for missing materials
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import {
    findActionInput,
    attachInputListeners,
    performInitialUpdate,
    onActionPanelsRefresh,
    onDetailPanel,
    resolveDetailPanel,
} from '../../utils/action-panel-helper.js';
import {
    calculateMaterialRequirements,
    calculateEnhancementMaterialRequirements,
    unclaimedBoughtCount,
} from '../../utils/material-calculator.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createAutofillManager, findQuantityInput } from '../../utils/marketplace-autofill.js';
import {
    createMaterialTab,
    updateTabBadge,
    createClearAllTabsControl,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
    navigateToMarketListingsTab,
    visibleTabsContainer,
    attachRegularTabClearListener,
} from '../../utils/marketplace-tabs.js';
import { getProtectionItemFromUI, getProtectFromLevelFromUI } from './enhancement-display.js';
import { calculateEnhancementPath } from '../enhancement/tooltip-enhancement.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { clickThroughReact } from '../../utils/react-click.js';
import { testerShopEnabled, testerShopCoinCost } from '../../utils/tester-shop.js';
// The walk to the Tester tab is shared with the Item Dictionary's ability-book
// panel — see utils/tester-shop-nav.js
import { findTesterTab, setShopFilter, openTesterShopPage } from '../../utils/tester-shop-nav.js';
import { runningAction } from '../../utils/combat-actions.js';
import {
    effectiveInventory,
    release,
    reserve,
    reservedElsewhere,
    shortfallNote,
} from '../../utils/inventory-reservations.js';

/**
 * The owner this feature claims stock under, while its tabs are open.
 *
 * One id and not one per action: only one bill of materials is ever open at a
 * time (`storedActionHrid` and its siblings are single-valued), so a second bill
 * replacing the first is exactly right. Transient — the claim goes when the
 * player leaves the marketplace, and the ledger's TTL is only a backstop for
 * tabs that were never left properly.
 */
const RESERVATION_OWNER = 'missingMats';

/**
 * Module-level state
 */
let cleanupObserver = null;
const currentMaterialsTabs = [];
let domObserverUnregister = null;
let enhancementDomObserverUnregister = null;
let unsubscribeRefresh = null;
let processedPanels = new WeakSet();
let processedEnhancingPanels = new WeakSet();
let enhancingPanelWatchers = [];
let inventoryUpdateHandler = null;
let storedActionHrid = null;
let storedNumActions = 0;
let storedEnhancementContext = null;
/** A plain bill of materials opened from elsewhere (a house level), kept for live updates */
let storedMaterialList = null;
/** The level the open bill's upgrade item is wanted at, kept so live updates do not lose it */
let storedUpgradeItemLevel = 0;
const timerRegistry = createTimerRegistry();
const autofillManager = createAutofillManager('MissingMats-Actions');

/**
 * Enhancement panel debounce timeout
 */
let enhancementDebounceTimeout = null;

/**
 * Production action types (where button should appear)
 */
const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

/**
 * Initialize missing materials button feature
 */
export function initialize() {
    cleanupObserver = setupMarketplaceCleanupObserver(handleMarketplaceCleanup, currentMaterialsTabs);
    autofillManager.initialize();

    // Watch for production action panels appearing
    domObserverUnregister = onDetailPanel((context) => processActionPanel(context.panel));

    // Watch for enhancement panels appearing
    enhancementDomObserverUnregister = domObserver.onClass(
        'MissingMaterialsButton-EnhancingPanel',
        'SkillActionDetail_enhancingComponent__17bOx',
        (panel) => processEnhancingPanel(panel)
    );

    // The button's missing list reads the action queue; a finite queue change
    // must redraw a panel already on screen
    unsubscribeRefresh = onActionPanelsRefresh((panel, value) => updateButtonForPanel(panel, value));

    // Process existing panels
    processActionPanels();
    processExistingEnhancingPanels();
}

/**
 * Cleanup function
 */
export function cleanup() {
    if (domObserverUnregister) {
        domObserverUnregister();
        domObserverUnregister = null;
    }
    if (unsubscribeRefresh) {
        unsubscribeRefresh();
        unsubscribeRefresh = null;
    }

    if (enhancementDomObserverUnregister) {
        enhancementDomObserverUnregister();
        enhancementDomObserverUnregister = null;
    }

    // Disconnect marketplace cleanup observer
    if (cleanupObserver) {
        cleanupObserver();
        cleanupObserver = null;
    }

    autofillManager.cleanup();

    // Remove any existing custom tabs
    handleMarketplaceCleanup();

    // Disconnect enhancing panel mutation watchers
    enhancingPanelWatchers.forEach((unwatch) => unwatch());
    enhancingPanelWatchers = [];

    // Clear processed panels
    processedPanels = new WeakSet();
    processedEnhancingPanels = new WeakSet();

    // Clear enhancement debounce
    if (enhancementDebounceTimeout) {
        clearTimeout(enhancementDebounceTimeout);
        enhancementDebounceTimeout = null;
    }

    timerRegistry.clearAll();
}

/**
 * Process action panels - watch for input changes
 */
function processActionPanels() {
    const panels = document.querySelectorAll('[class*="SkillActionDetail_skillActionDetail"]');
    panels.forEach((panel) => processActionPanel(panel));
}

/**
 * Attach to one action panel, once
 * @param {HTMLElement} panel - Action panel element
 */
function processActionPanel(panel) {
    if (processedPanels.has(panel)) {
        return;
    }

    // Find the input box using utility
    const inputField = findActionInput(panel);
    if (!inputField) {
        return;
    }

    // Mark as processed
    processedPanels.add(panel);

    // Attach input listeners using utility
    attachInputListeners(panel, inputField, (value) => {
        updateButtonForPanel(panel, value);
    });

    // Initial update if there's already a value
    performInitialUpdate(inputField, (value) => {
        updateButtonForPanel(panel, value);
    });
}

/**
 * Update button visibility and content for a panel based on input value
 * @param {HTMLElement} panel - Action panel element
 * @param {string} value - Input value (number of actions)
 */
function updateButtonForPanel(panel, value) {
    const numActions = parseInt(value) || 0;

    // Remove existing button
    const existingButton = panel.querySelector('#mwi-missing-mats-button');
    if (existingButton) {
        existingButton.remove();
    }

    // Check setting early
    if (!config.getSetting('actions_missingMaterialsButton')) {
        return;
    }

    const actionHrid = getActionHridFromPanel(panel);
    if (!actionHrid) {
        return;
    }

    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData.actionDetailMap[actionHrid];
    if (!actionDetail) {
        return;
    }

    // Verify this is a production action
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) {
        return;
    }

    // Check if action has input materials
    if (!actionDetail.inputItems || actionDetail.inputItems.length === 0) {
        return;
    }

    // Determine disabled state: no quantity entered (∞ parses to 0)
    let missingMaterials = [];
    let disabled = false;

    if (numActions <= 0) {
        disabled = true;
    } else {
        // Get missing materials using shared utility
        // Check if user wants to ignore queue (default: false, meaning we DO account for queue)
        const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
        const accountForQueue = !ignoreQueue; // Invert: ignoreQueue=false means accountForQueue=true
        missingMaterials = calculateMaterialRequirements(actionHrid, numActions, accountForQueue, {
            ownerId: RESERVATION_OWNER,
        });
        if (missingMaterials.length === 0) {
            disabled = true;
        }
    }

    // Create and insert button with actionHrid and numActions for live updates
    const button = createMissingMaterialsButton(missingMaterials, actionHrid, numActions, disabled);

    // Find insertion point (beneath item requirements field)
    const itemRequirements = panel.querySelector('.SkillActionDetail_itemRequirements__3SPnA');
    if (itemRequirements) {
        itemRequirements.parentNode.insertBefore(button, itemRequirements.nextSibling);
    } else {
        // Fallback: insert at top of panel
        panel.insertBefore(button, panel.firstChild);
    }

    // Don't manipulate modal styling - let the game handle it
    // The modal will scroll naturally if content overflows
}

/**
 * Get action HRID from panel
 * @param {HTMLElement} panel - Action panel element
 * @returns {string|null} Action HRID or null
 */
function getActionHridFromPanel(panel) {
    return resolveDetailPanel(panel).actionHrid;
}

/**
 * Process existing enhancing panels on the page
 */
function processExistingEnhancingPanels() {
    const panels = document.querySelectorAll('[class*="SkillActionDetail_enhancingComponent"]');
    panels.forEach((panel) => processEnhancingPanel(panel));
}

/**
 * Process an enhancing panel - set up mutation watcher and create button
 * @param {HTMLElement} panel - Enhancing panel element
 */
function processEnhancingPanel(panel) {
    if (!panel || processedEnhancingPanels.has(panel)) {
        return;
    }

    processedEnhancingPanels.add(panel);

    // Watch for changes (item swap, level change, protection change) with debounce
    const unwatch = createMutationWatcher(
        panel,
        (mutations) => {
            // Ignore mutations caused by our own button insertion/removal
            const isOwnButton = mutations.every((m) => {
                const nodes = [...m.addedNodes, ...m.removedNodes];
                return nodes.length > 0 && nodes.every((n) => n.id === 'mwi-missing-mats-button');
            });
            if (isOwnButton) return;

            if (enhancementDebounceTimeout) {
                clearTimeout(enhancementDebounceTimeout);
            }
            enhancementDebounceTimeout = setTimeout(() => {
                enhancementDebounceTimeout = null;
                updateEnhancementButton(panel);
            }, 500);
        },
        { childList: true, subtree: true, attributes: true }
    );
    enhancingPanelWatchers.push(unwatch);

    // Initial button creation (delay to let panel-observer set mwiItemHrid first)
    setTimeout(() => updateEnhancementButton(panel), 600);
}

/**
 * Get current enhancement level from action queue or DOM
 * @param {HTMLElement} panel - Enhancing panel element
 * @returns {number} Current enhancement level (0-19)
 */
function getCurrentEnhancementLevel(panel) {
    // Try action queue first
    const currentActions = dataManager.getCurrentActions();
    // The enhance action running now, not the first enhance entry in array
    // order (a queued one, with several items lined up)
    const enhancingAction = runningAction(currentActions, (a) => a.actionHrid === '/actions/enhancing/enhance');
    if (enhancingAction?.primaryItemHash) {
        const parts = enhancingAction.primaryItemHash.split('::');
        const lastPart = parts[parts.length - 1];
        if (lastPart && !lastPart.startsWith('/')) {
            const parsed = parseInt(lastPart, 10);
            if (!isNaN(parsed)) return parsed;
        }
    }

    // Fallback: read from DOM text (e.g., "Dairyhand's Top +5")
    const inputItems = panel.querySelectorAll('.SkillActionDetail_item__2vEAz .Item_name__2C42x');
    if (inputItems.length > 0) {
        const inputName = inputItems[0].textContent.trim();
        const levelMatch = inputName.match(/\+(\d+)$/);
        if (levelMatch) return parseInt(levelMatch[1], 10);
    }

    return 0;
}

/**
 * Get target enhancement level from UI input
 * @param {HTMLElement} panel - Enhancing panel element
 * @returns {number|null} Target level (1-20) or null if not found
 */
/**
 * Get repeat count from enhancement panel UI
 * @param {HTMLElement} panel - Enhancing panel element
 * @returns {number} Repeat count (defaults to 1 if not found)
 */
function getRepeatCountFromUI(panel) {
    const labels = Array.from(panel.querySelectorAll('*')).filter(
        (el) => el.textContent.trim() === 'Repeat' && el.children.length === 0
    );

    if (labels.length > 0) {
        const parent = labels[0].parentElement;
        const input = parent.querySelector('input[type="number"], input[type="text"]');
        if (input) {
            if (input.value === '∞') return null;
            const value = parseInt(input.value, 10);
            if (!isNaN(value) && value > 0) return value;
        }
    }

    return 1;
}

function getTargetLevelFromUI(panel) {
    const labels = Array.from(panel.querySelectorAll('*')).filter(
        (el) => el.textContent.trim() === 'Target Level' && el.children.length === 0
    );

    if (labels.length > 0) {
        const parent = labels[0].parentElement;
        const input = parent.querySelector('input[type="number"], input[type="text"]');
        if (input && input.value) {
            const value = parseInt(input.value, 10);
            if (!isNaN(value)) return Math.max(1, Math.min(20, value));
        }
    }

    return null;
}

/**
 * Update the missing materials button on an enhancement panel
 * @param {HTMLElement} panel - Enhancing panel element
 */
function updateEnhancementButton(panel) {
    // Remove existing button
    const existingButton = panel.querySelector('#mwi-missing-mats-button');
    if (existingButton) {
        existingButton.remove();
    }

    if (!config.getSetting('actions_missingMaterialsButton')) {
        return;
    }

    // Get item HRID (set by panel-observer.js)
    const itemHrid = panel.dataset.mwiItemHrid;
    if (!itemHrid) {
        return;
    }

    // Get current and target levels
    const startLevel = getCurrentEnhancementLevel(panel);
    const targetLevel = getTargetLevelFromUI(panel);
    if (targetLevel === null || targetLevel <= startLevel) {
        return;
    }

    // Get protection settings from UI
    const protectionItemHrid = getProtectionItemFromUI(panel);
    const protectFromLevel = getProtectFromLevelFromUI(panel);
    const repeatCount = getRepeatCountFromUI(panel);

    // Auto-calculate optimal protection if user hasn't set one
    let resolvedProtectFrom = protectFromLevel;
    let resolvedProtectionItem = protectionItemHrid;
    let autoProtection = false;
    if (protectFromLevel === 0) {
        const enhancingConfig = getEnhancingParams();
        const pathResult = calculateEnhancementPath(itemHrid, targetLevel, enhancingConfig);
        if (pathResult?.optimalStrategy) {
            resolvedProtectFrom = pathResult.optimalStrategy.protectFrom;
            resolvedProtectionItem = pathResult.optimalStrategy.protectionItemHrid || protectionItemHrid;
            autoProtection = true;
        }
    }

    // Calculate missing materials
    const missingMaterials = calculateEnhancementMaterialRequirements(
        itemHrid,
        startLevel,
        targetLevel,
        resolvedProtectionItem,
        resolvedProtectFrom,
        repeatCount
    );

    const disabled = missingMaterials.length === 0;

    // Create button
    const strategyInfo = autoProtection
        ? { protectFrom: resolvedProtectFrom, protectionItemHrid: resolvedProtectionItem }
        : null;
    const button = createEnhancementMissingMaterialsButton(
        missingMaterials,
        itemHrid,
        startLevel,
        targetLevel,
        resolvedProtectionItem,
        resolvedProtectFrom,
        repeatCount,
        disabled,
        strategyInfo
    );

    // Find insertion point
    const itemRequirements = panel.querySelector('.SkillActionDetail_itemRequirements__3SPnA');
    if (itemRequirements) {
        itemRequirements.parentNode.insertBefore(button, itemRequirements.nextSibling);
    } else {
        const enhancementStats = panel.querySelector('#mwi-enhancement-stats');
        if (enhancementStats) {
            enhancementStats.parentNode.insertBefore(button, enhancementStats);
        } else {
            panel.appendChild(button);
        }
    }
}

/**
 * Create missing materials button for enhancement panels
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} itemHrid - Item being enhanced
 * @param {number} startLevel - Current enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {string|null} protectionItemHrid - Protection item HRID
 * @param {number} protectFromLevel - Protect from level
 * @param {boolean} disabled - Whether button should be disabled
 * @returns {HTMLElement} Button element
 */
function createEnhancementMissingMaterialsButton(
    missingMaterials,
    itemHrid,
    startLevel,
    targetLevel,
    protectionItemHrid,
    protectFromLevel,
    repeatCount,
    disabled,
    strategyInfo
) {
    const button = document.createElement('button');
    button.id = 'mwi-missing-mats-button';
    button.textContent = 'Missing Mats Marketplace';
    button.disabled = disabled;
    button.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 10px 16px;
        margin: 8px 0 16px 0;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
        color: #ffffff;
        border: 1px solid rgba(91, 141, 239, 0.4);
        border-radius: 8px;
        cursor: ${disabled ? 'default' : 'pointer'};
        font-size: 14px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        opacity: ${disabled ? '0.45' : '1'};
    `;

    if (!disabled) {
        button.addEventListener('mouseenter', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.35) 0%, rgba(91, 141, 239, 0.25) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.6)';
            button.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.4)';
            button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
        });

        button.addEventListener('click', async () => {
            await handleEnhancementMissingMaterialsClick(
                itemHrid,
                startLevel,
                targetLevel,
                protectionItemHrid,
                protectFromLevel,
                repeatCount,
                strategyInfo
            );
        });
    }

    return button;
}

/**
 * Handle enhancement missing materials button click
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} itemHrid - Item being enhanced
 * @param {number} startLevel - Current enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {string|null} protectionItemHrid - Protection item HRID
 * @param {number} protectFromLevel - Protect from level
 */
async function handleEnhancementMissingMaterialsClick(
    itemHrid,
    startLevel,
    targetLevel,
    protectionItemHrid,
    protectFromLevel,
    repeatCount,
    strategyInfo
) {
    // Store context for live updates (already resolved values)
    storedEnhancementContext = {
        itemHrid,
        startLevel,
        targetLevel,
        protectionItemHrid,
        protectFromLevel,
        repeatCount,
        strategyInfo,
    };
    storedActionHrid = null;
    storedNumActions = 0;
    storedUpgradeItemLevel = 0;

    // Recalculate materials fresh (inventory may have changed since button was rendered)
    const freshMaterials = calculateEnhancementMaterialRequirements(
        itemHrid,
        startLevel,
        targetLevel,
        protectionItemHrid,
        protectFromLevel,
        repeatCount
    );

    // Open the marketplace, or the Tester shop, with a tab per material
    if (!(await openWhereBought(freshMaterials, strategyInfo))) return;

    // Setup inventory listener for live updates
    setupInventoryListener();
}

/**
 * Create missing materials marketplace button
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} actionHrid - Action HRID for recalculating materials
 * @param {number} numActions - Number of actions for recalculating materials
 * @param {boolean} disabled - Whether the button should be rendered in a disabled state
 * @returns {HTMLElement} Button element
 */
function createMissingMaterialsButton(missingMaterials, actionHrid, numActions, disabled = false) {
    const button = document.createElement('button');
    button.id = 'mwi-missing-mats-button';
    button.textContent = 'Missing Mats Marketplace';
    button.disabled = disabled;
    button.title = disabled && numActions <= 0 ? 'Enter a quantity to check missing materials' : '';
    button.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 10px 16px;
        margin: 8px 0 16px 0;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
        color: #ffffff;
        border: 1px solid rgba(91, 141, 239, 0.4);
        border-radius: 8px;
        cursor: ${disabled ? 'default' : 'pointer'};
        font-size: 14px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        opacity: ${disabled ? '0.45' : '1'};
    `;

    if (!disabled) {
        // Hover effect
        button.addEventListener('mouseenter', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.35) 0%, rgba(91, 141, 239, 0.25) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.6)';
            button.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.4)';
            button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
        });

        // Click handler
        button.addEventListener('click', async () => {
            await handleMissingMaterialsClick(actionHrid, numActions);
        });
    }

    return button;
}

/**
 * Handle missing materials button click
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} actionHrid - Action HRID for recalculating materials
 * @param {number} numActions - Number of actions for recalculating materials
 */
async function handleMissingMaterialsClick(actionHrid, numActions, upgradeItemLevel = 0) {
    // Store context for live updates
    storedActionHrid = actionHrid;
    storedNumActions = numActions;
    storedEnhancementContext = null;
    storedMaterialList = null;
    storedUpgradeItemLevel = Math.max(0, Math.floor(Number(upgradeItemLevel) || 0));

    // Recalculate materials fresh (inventory may have changed since button was rendered)
    const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
    const accountForQueue = !ignoreQueue;
    const freshMaterials = atUpgradeItemLevel(
        calculateMaterialRequirements(actionHrid, numActions, accountForQueue, {
            ownerId: RESERVATION_OWNER,
        }),
        storedUpgradeItemLevel
    );

    if (!(await openWhereBought(freshMaterials))) return;

    await claimOpenBill(freshMaterials);

    // Setup inventory listener for live updates
    setupInventoryListener();
}

/**
 * Re-read the bill's upgrade item at the enhancement level it is really wanted at.
 *
 * `calculateMaterialRequirements` costs every line as the unenhanced item, which
 * is right for an action panel: the game's own craft consumes whatever copy you
 * point it at, and the panel is looking at the piece in your bag. It is wrong for
 * a caller saving towards a refinement that RETAINS enhancement — a ★+12 is made
 * from a +12 base, so a +0 in the bag is not stock against it and the +0 order
 * book is not where it is bought.
 *
 * Only the upgrade item moves. The inputs are consumables and stay +0 whatever
 * the output's level. `queued` is dropped to 0 on a levelled line because queue
 * accounting counted +0 copies: a queued craft eating unenhanced bases is not
 * competing for the +12, and carrying its figure across would understate the
 * shortfall. Reservations are re-read at the level, which the ledger keys on.
 *
 * @param {Array<Object>} materials - From `calculateMaterialRequirements`
 * @param {number} level - The level the upgrade item is wanted at; 0 leaves the bill alone
 * @returns {Array<Object>} The same lines, the upgrade item re-counted at `level`
 */
function atUpgradeItemLevel(materials, level) {
    if (!(level > 0) || !Array.isArray(materials)) return materials;
    const inventory = dataManager.getInventory?.() || [];

    return materials.map((material) => {
        if (!material?.isUpgradeItem) return material;

        // Exact match: a +13 is not spendable as a +12 either, since the craft
        // would carry the wrong level through to the output
        const have = inventory
            .filter((item) => item.itemHrid === material.itemHrid && (item.enhancementLevel || 0) === level)
            .reduce((sum, item) => sum + (item.count || 0), 0);
        const reserved = reservedElsewhere(material.itemHrid, level, { excludeOwner: RESERVATION_OWNER });
        const available = Math.max(0, have - reserved);
        const missing = Math.max(0, material.required - available);
        const reservedNote =
            missing > 0 && have >= material.required
                ? shortfallNote(missing, material.itemHrid, level, { excludeOwner: RESERVATION_OWNER })
                : '';

        const updated = { ...material, enhancementLevel: level, have, queued: 0, available, missing };
        // The +0 line's reservation fields described a different piece
        delete updated.reserved;
        delete updated.reservedNote;
        if (reserved > 0) updated.reserved = reserved;
        if (reservedNote) updated.reservedNote = reservedNote;
        return updated;
    });
}

/**
 * Claim what the tabs now on screen are asking for, for as long as they are up.
 *
 * The REQUIRED totals rather than the shortfall: what is already in the bag for
 * this bill is spoken for too, and claiming only the missing part would leave
 * the rest looking free to every other plan.
 *
 * @param {Array<Object>} materials - The material lines the tabs were built from
 * @returns {Promise<boolean>} Whether a write landed
 */
async function claimOpenBill(materials) {
    return reserve(
        RESERVATION_OWNER,
        (materials || []).map((material) => ({
            itemHrid: material.itemHrid,
            count: material.required,
            enhancementLevel: material.enhancementLevel || 0,
        })),
        { label: 'Missing materials panel' }
    );
}

/**
 * Navigate to marketplace by simulating click on navbar
 * @returns {Promise<boolean>} True if successful
 */
async function openMarketplacePage() {
    // Find marketplace navbar button
    const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
    const marketplaceButton = Array.from(navButtons).find((nav) => {
        const svg = nav.querySelector('svg[aria-label="navigationBar.marketplace"]');
        return svg !== null;
    });

    if (!marketplaceButton) {
        console.error('[MissingMats] Marketplace navbar button not found');
        return false;
    }

    // Simulate click
    marketplaceButton.click();

    // Wait for marketplace panel to appear
    return await waitForMarketplace();
}

/**
 * Wait for marketplace panel to appear
 * @returns {Promise<boolean>} True if marketplace appeared within timeout
 */
async function waitForMarketplace() {
    const maxAttempts = 50;
    const delayMs = 100;

    for (let i = 0; i < maxAttempts; i++) {
        // Check for marketplace panel by looking for tabs container
        const tabsContainer = visibleTabsContainer();
        if (tabsContainer) {
            // Verify it's the marketplace tabs (has "Market Listings" tab)
            const hasMarketListings = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (hasMarketListings) {
                return true;
            }
        }

        await new Promise((resolve) => {
            const delayTimeout = setTimeout(resolve, delayMs);
            timerRegistry.registerTimeout(delayTimeout);
        });
    }

    console.error('[MissingMats] Marketplace did not open within timeout');
    return false;
}

/**
 * Build the click handler for a material tab.
 * Defined outside the loop to satisfy the no-loop-func lint rule.
 * @param {{ tab: HTMLElement|null }} tabRef - Holder updated to the tab element after creation
 * @returns {Function}
 */
function makeMaterialClickHandler(tabRef) {
    return (_e, mat) => {
        // Read the current missing quantity from the tab's data attribute,
        // which is kept up-to-date by the inventory listener. Armed for this
        // tab's item: the calculation persists on purpose, so without the item
        // it would go on filling buy boxes long after this tab is gone.
        autofillManager.setPendingCalculation(
            () => parseInt(tabRef.tab?.getAttribute('data-missing-quantity') || '0', 10),
            { itemHrid: mat.itemHrid }
        );
        // A material is the unenhanced item; a bill line may name a level — a
        // piece of gear the Upgrade tab wants at +7 — and the listing to open
        // is that level's, not the +0 one underneath it
        navigateToMarketplace(mat.itemHrid, mat.enhancementLevel || 0);
    };
}

/**
 * Whether a bill should be bought in the Tester shop: pricing is on, and the
 * shop sells at least one line of it.
 * @param {Array<{itemHrid: string}>} materials
 * @returns {boolean}
 */
function wantsTesterShop(materials) {
    if (!testerShopEnabled()) return false;
    return (materials || []).some((material) => testerShopCoinCost(material?.itemHrid) > 0);
}

/**
 * Pin the missing-material tabs into the Shop's Tester strip.
 *
 * Same tabs, same live badges, same dismiss — a click filters the shop to the
 * item and arms the buy dialog with what is still missing. A line the shop
 * does not sell keeps the marketplace as its click, and says so.
 *
 * @param {Array<Object>} missingMaterials - Material objects
 * @param {HTMLElement} testerTab - The selected Tester tab, to clone
 */
function createTesterShopTabs(missingMaterials, testerTab) {
    const tabsContainer = testerTab?.parentElement;
    if (!tabsContainer) {
        console.error('[MissingMats] Tester tab strip not found');
        return;
    }
    removeMaterialTabs();
    currentMaterialsTabs.length = 0;
    tabsContainer.style.flexWrap = 'wrap';

    attachRegularTabClearListener(tabsContainer, () => autofillManager.clearQuantity());

    for (const material of missingMaterials) {
        const sold = testerShopCoinCost(material.itemHrid) > 0;
        const tabRef = { tab: null };
        const handler = sold
            ? (_e, mat) => {
                  // Stay in the Tester tab and narrow it to this item — and
                  // only then arm the quantity: selecting a game tab is what
                  // clears an armed quantity (the strip's own listener)
                  findTesterTab()?.click();
                  setShopFilter(mat.itemName);
                  // Armed for this line's item, as the marketplace strip's tabs
                  // are: the calculation persists on purpose, so unscoped it
                  // went on filling every later buy box, for any item. A dialog
                  // that names no item (the Shop's own, when it draws no item
                  // icon) still fills — see modalItemHrid.
                  autofillManager.setPendingCalculation(
                      () => parseInt(tabRef.tab?.getAttribute('data-missing-quantity') || '0', 10),
                      { itemHrid: mat.itemHrid }
                  );
              }
            : makeMaterialClickHandler(tabRef);
        const tab = createMaterialTab(material, testerTab, handler);
        tabRef.tab = tab;
        tab.setAttribute('data-tester-sold', sold ? 'true' : 'false');
        tab.setAttribute('data-item-name', material.itemName || '');
        if (!sold) tab.title = 'Not sold in the Tester shop — opens the marketplace';
        tabsContainer.appendChild(tab);
        currentMaterialsTabs.push(tab);
    }

    // One press, one purchase: the next line still short, bought for what it
    // is short of. Pressed again, the line after it
    const control = createBuyNextControl();
    tabsContainer.appendChild(control);
    currentMaterialsTabs.push(control);

    // One click, every pinned line gone — already on the Tester tab, which is
    // its own "normal view", so nothing to navigate back to
    const clearAllControl = createClearAllTabsControl(testerTab, () => handleClearAllClick(false));
    tabsContainer.appendChild(clearAllControl);
    currentMaterialsTabs.push(clearAllControl);
}

/**
 * The "Buy next" control for the Tester strip.
 *
 * Each press buys exactly one thing: the first pinned line the shop sells
 * that is still short, for the amount it is short of — the shop is filtered
 * to it, its card opened, the quantity typed, Buy pressed. One press is one
 * purchase, so holding the button down does nothing and a line that did not
 * buy (no card, no dialog) is simply the next press's line again. The badges
 * refresh off the inventory as the purchases land, which is what moves the
 * press on to the next line.
 *
 * @returns {HTMLElement}
 */
function createBuyNextControl() {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-mwi-custom-tab', 'true');
    button.setAttribute('data-mwi-buy-next', 'true');
    button.style.cssText =
        'display:inline-flex; align-items:center; gap:6px; margin:4px 8px; padding:4px 10px; font-size:12px; ' +
        'border:1px solid #4caf50; border-radius:4px; background:rgba(76,175,80,0.12); color:#8bc34a; cursor:pointer; ' +
        'font-family:inherit; white-space:nowrap;';
    const label = document.createElement('span');
    label.textContent = 'Buy next ▸';
    const note = document.createElement('span');
    note.style.cssText = 'color:#aaa; font-size:11px;';
    button.append(label, note);
    button.title =
        'Buys the next pinned line the Tester shop sells, for what you are still short of — one purchase per press. ' +
        'Press again for the line after it.';

    let busy = false;
    const refreshNote = () => {
        const next = nextBuyableTab();
        note.textContent = next
            ? `${next.getAttribute('data-item-name')} × ${next.getAttribute('data-missing-quantity')}`
            : 'nothing left to buy';
    };
    refreshNote();
    button.addEventListener('mouseenter', refreshNote);
    // The badges move as purchases land; the note follows them
    button.addEventListener('mwi-tabs-updated', refreshNote);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        const tab = nextBuyableTab();
        if (!tab) {
            note.textContent = 'nothing left to buy';
            return;
        }
        busy = true;
        const name = tab.getAttribute('data-item-name') || '';
        const quantity = parseInt(tab.getAttribute('data-missing-quantity') || '0', 10);
        note.textContent = `buying ${name} × ${quantity}…`;
        try {
            const outcome = await buyOneFromTesterShop(name, quantity);
            note.textContent = outcome.ok ? `bought ${name} × ${quantity}` : `${name}: ${outcome.reason}`;
        } catch (error) {
            console.error('[MissingMats] Buy next failed:', error);
            note.textContent = `${name}: failed`;
        } finally {
            busy = false;
            // The arming buyOneFromTesterShop sets is a bare constant, for the
            // one dialog this press opens. Left standing it filled that count
            // into every later buy box, for any item — it cannot be scoped to
            // the item (the flow has only the shop's display name), so it ends
            // with the press.
            autofillManager.clearQuantity();
            timerRegistry.registerTimeout(setTimeout(refreshNote, 1500));
        }
    });
    return button;
}

/** The first pinned tab the shop sells that is still short */
function nextBuyableTab() {
    return (
        currentMaterialsTabs.find(
            (tab) =>
                tab.getAttribute('data-tester-sold') === 'true' &&
                parseInt(tab.getAttribute('data-missing-quantity') || '0', 10) > 0 &&
                document.body.contains(tab)
        ) || null
    );
}

/**
 * The shop card for an item, on screen.
 *
 * The game's own card class first (`ShopPanel_shopItem`); failing that, the
 * deepest visible element whose text reads as a card — the item name first,
 * a coin price last — since a filtered shop holds the card inside several
 * containers that carry the very same text.
 *
 * @param {string} itemName - As the shop names it
 * @returns {HTMLElement|null}
 */
function findShopCard(itemName) {
    const wanted = String(itemName || '')
        .trim()
        .toLowerCase();
    if (!wanted) return null;
    // The whole name, then straight into the price — "Lumber" must not read
    // "Lumberjack's Top 3,500,000 Coin" as its card
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cardText = new RegExp(`^${escaped}\\s*[\\d,.]+\\s*coins?$`);
    const reads = (el) => cardText.test((el.textContent || '').trim().toLowerCase());
    // The card class, not the `shopItems` container that also matches the
    // substring — the token is followed by its hash
    const card = Array.from(document.querySelectorAll('[class*="ShopPanel_shopItem"]')).find(
        (el) => /(^|\s)ShopPanel_shopItem__/.test(el.className || '') && el.offsetParent !== null && reads(el)
    );
    if (card) return card;

    let best = null;
    for (const el of document.querySelectorAll('div, button, span')) {
        if (el.offsetParent === null || !reads(el)) continue;
        // Equal text means nested containers: keep the deepest one
        if (!best || (el.textContent || '').trim().length <= (best.textContent || '').trim().length) best = el;
    }
    return best;
}

/**
 * Buy one pinned line from the Tester shop: filter, open its card, type the
 * quantity, press Buy. Resolves when the dialog is gone or a step could not be
 * found.
 *
 * @param {string} itemName - The item, as the shop names it
 * @param {number} quantity - How many
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function buyOneFromTesterShop(itemName, quantity) {
    const wait = (ms) =>
        new Promise((resolve) => {
            timerRegistry.registerTimeout(setTimeout(resolve, ms));
        });
    if (!(quantity > 0)) return { ok: false, reason: 'nothing short' };

    findTesterTab()?.click();
    await wait(100);
    setShopFilter(itemName);
    // Armed after the tab click, which would have cleared it: the quantity we
    // are about to type is what any buy dialog should carry, including one
    // the game opens from this card
    autofillManager.setPendingCalculation(() => quantity);

    let card = null;
    for (let i = 0; i < 20 && !card; i++) {
        await wait(100);
        card = findShopCard(itemName);
    }
    if (!card) return { ok: false, reason: 'not found in the shop' };
    // The game ignores a plain synthetic click on many of its elements; go
    // through React's own handler first
    clickThroughReact(card, { reactFirst: true });

    let modal = null;
    for (let i = 0; i < 20 && !modal; i++) {
        await wait(100);
        // Fixed-position: `offsetParent` is null even when shown, so the box
        // on screen is the test
        modal = Array.from(document.querySelectorAll('[class*="Modal_modalContainer"]')).find(
            (el) => el.getClientRects().length > 0 && /quantity/i.test(el.textContent || '')
        );
    }
    if (!modal) return { ok: false, reason: 'no buy dialog' };

    // The Quantity box, not the Enhancement Level box an equipment dialog
    // puts first — the same label-reading the marketplace autofill does
    const input = findQuantityInput(modal);
    if (!input) return { ok: false, reason: 'no quantity box' };
    setReactInputValue(input, String(quantity), { dispatchInput: true, dispatchChange: true });
    await wait(150);

    const buy = Array.from(modal.querySelectorAll('button')).find((b) => /^\s*buy\s*$/i.test(b.textContent || ''));
    if (!buy) return { ok: false, reason: 'no Buy button' };
    // Disabled is the dialog refusing the order (a level out of range, more
    // than you can pay); pressing it would do nothing, so say why instead
    for (let i = 0; i < 10 && buy.disabled; i++) await wait(100);
    if (buy.disabled) return { ok: false, reason: 'Buy is disabled in the dialog' };
    // A plain .click() closes the dialog without buying — the game's handler
    // wants the real event path; React's own handler first, like the card
    clickThroughReact(buy, { reactFirst: true });

    // The dialog closing is the purchase going through; the inventory update
    // behind it is what moves the badge
    for (let i = 0; i < 20; i++) {
        await wait(100);
        if (!document.body.contains(modal) || modal.getClientRects().length === 0) break;
    }
    return { ok: true };
}

/**
 * Open whatever a bill is bought from: the Tester shop when it is priced in
 * and sells some of it, the marketplace otherwise — and draw the tabs there.
 *
 * @param {Array<Object>} materials - Material objects for the tabs
 * @param {Object|null} [strategyInfo] - Enhancement protection strategy, marketplace only
 * @returns {Promise<boolean>} Whether a page opened and tabs were drawn
 */
async function openWhereBought(materials, strategyInfo = null) {
    if (wantsTesterShop(materials)) {
        const testerTab = await openTesterShopPage();
        if (testerTab) {
            createTesterShopTabs(materials, testerTab);
            return true;
        }
        // The shop could not be reached: the marketplace is still a place to buy
    }

    const success = await openMarketplacePage();
    if (!success) {
        console.error('[MissingMats] Failed to navigate to marketplace');
        return false;
    }
    await new Promise((resolve) => {
        const delayTimeout = setTimeout(resolve, 200);
        timerRegistry.registerTimeout(delayTimeout);
    });
    createMissingMaterialTabs(materials, strategyInfo);
    return true;
}

/**
 * Create a strategy indicator element for the marketplace tab row
 * @param {Object} strategyInfo - Auto-calculated protection strategy
 * @returns {HTMLElement}
 */
function createStrategyIndicator(strategyInfo) {
    const indicator = document.createElement('div');
    indicator.setAttribute('data-mwi-custom-tab', 'true');
    indicator.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12px;
        color: #aaa;
        white-space: nowrap;
    `;

    if (strategyInfo.protectFrom === 0) {
        indicator.textContent = 'No protection needed';
    } else {
        // Get item sprite URL from existing DOM
        const spriteUse = document.querySelector('use[href*="items_sprite"]');
        if (spriteUse && strategyInfo.protectionItemHrid) {
            const spriteUrl = spriteUse.getAttribute('href').split('#')[0];
            const iconName = strategyInfo.protectionItemHrid.split('/').pop();
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '20');
            svg.setAttribute('height', '20');
            svg.style.flexShrink = '0';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${spriteUrl}#${iconName}`);
            svg.appendChild(use);
            indicator.appendChild(svg);
        }

        const label = document.createElement('span');
        label.textContent = `From: +${strategyInfo.protectFrom}`;
        indicator.appendChild(label);
    }

    return indicator;
}

/**
 * Get game object via React fiber tree traversal
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToAction) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Create a "Return to Action" tab for navigating back after buying materials
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @returns {HTMLElement|null} Return tab element, or null if no stored context
 */
function createReturnTab(referenceTab) {
    let displayName;

    if (storedActionHrid) {
        const details = dataManager.getActionDetails(storedActionHrid);
        displayName = details?.name || storedActionHrid.split('/').pop();
        if (storedNumActions > 0) displayName += ` (\u00d7${formatWithSeparator(storedNumActions)})`;
    } else if (storedEnhancementContext) {
        const ctx = storedEnhancementContext;
        const itemName = dataManager.getItemDetails(ctx.itemHrid)?.name || '...';
        displayName = `${itemName} +${ctx.startLevel}\u2192+${ctx.targetLevel}`;
    } else {
        return null;
    }

    const tab = referenceTab.cloneNode(true);
    tab.setAttribute('data-mwi-custom-tab', 'true');
    tab.classList.remove('Mui-selected');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('tabindex', '-1');

    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>\u21a9 Return</div>
                <div style="font-size: 0.75em; color: #60a5fa;">${displayName}</div>
            </div>
        `;
    }

    tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleReturnToAction();
    });

    return tab;
}

/**
 * Navigate back to the stored action and restore input values
 */
async function handleReturnToAction() {
    const game = getGameObject();
    if (!game) return;

    if (storedActionHrid) {
        game.handleGoToAction(storedActionHrid);
    } else if (storedEnhancementContext) {
        game.handleChangeNavTarget('enhancing');
    } else {
        return;
    }

    // Restore input value for production actions — poll for the input to appear
    if (storedActionHrid && storedNumActions > 0) {
        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise((resolve) => {
                const t = setTimeout(resolve, 100);
                timerRegistry.registerTimeout(t);
            });

            const input =
                document.querySelector('[class*="maxActionCountInput"] input') ||
                document.querySelector('[class*="SkillActionDetail_skillActionDetail"] input[type="number"]');
            if (input) {
                setReactInputValue(input, storedNumActions);
                break;
            }
        }
    }
}

/**
 * Create custom tabs for missing materials
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {Object|null} strategyInfo - Auto-calculated protection strategy info
 */
function createMissingMaterialTabs(missingMaterials, strategyInfo = null) {
    const tabsContainer = visibleTabsContainer();

    if (!tabsContainer) {
        console.error('[MissingMats] Tabs container not found');
        return;
    }

    // Remove any existing custom tabs first (preserve stored context — we're recreating, not leaving)
    removeMaterialTabs();
    currentMaterialsTabs.length = 0;

    // Get reference tab for cloning (use "My Listings" as template)
    const referenceTab = Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'));

    if (!referenceTab) {
        console.error('[MissingMats] Reference tab not found');
        return;
    }

    // Enable flex wrapping for multiple rows (like game's native tabs)
    if (tabsContainer) {
        tabsContainer.style.flexWrap = 'wrap';
    }

    // See attachRegularTabClearListener: clears the armed quantity when a
    // *different* native tab is picked, but not on "+ New Buy Listing" /
    // "+ New Sell Listing" — those live in the same flex row but aren't MUI
    // Tabs.
    attachRegularTabClearListener(tabsContainer, () => autofillManager.clearQuantity());

    // Create tab for each missing material
    currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)

    // Add strategy indicator if auto-calculated
    if (strategyInfo) {
        const indicator = createStrategyIndicator(strategyInfo);
        tabsContainer.appendChild(indicator);
        currentMaterialsTabs.push(indicator);
    }

    for (const material of missingMaterials) {
        const tabRef = { tab: null };
        const handler = makeMaterialClickHandler(tabRef);
        const tab = createMaterialTab(material, referenceTab, handler);
        tabRef.tab = tab;
        tabsContainer.appendChild(tab);
        currentMaterialsTabs.push(tab);
    }

    // Add "Return to Action" tab at the end
    const returnTab = createReturnTab(referenceTab);
    if (returnTab) {
        tabsContainer.appendChild(returnTab);
        currentMaterialsTabs.push(returnTab);
    }

    // One click, every pinned tab (material tabs, the strategy indicator, and
    // Return) gone, landing back on the plain Market Listings view
    const clearAllControl = createClearAllTabsControl(referenceTab, () => handleClearAllClick(true));
    tabsContainer.appendChild(clearAllControl);
    currentMaterialsTabs.push(clearAllControl);
}

/**
 * Setup inventory listener for live tab updates
 * Listens for inventory changes via websocket and updates tabs accordingly
 */
function setupInventoryListener() {
    // Remove existing listener if any
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
    }

    // Create new listener that watches for inventory-related messages
    inventoryUpdateHandler = (data) => {
        // Check if this message might affect inventory
        // Common message types that update inventory:
        // - item_added, item_removed, items_updated
        // - market_buy_complete, market_sell_complete
        // - Or any message with inventory field
        if (
            data.type?.includes('item') ||
            data.type?.includes('inventory') ||
            data.type?.includes('market') ||
            data.inventory ||
            data.characterItems
        ) {
            updateTabsOnInventoryChange();
        }
    };

    webSocketHook.on('*', inventoryUpdateHandler);
}

/**
 * Update all custom tabs when inventory changes
 * Recalculates materials and updates badge display
 */
function updateTabsOnInventoryChange() {
    // Check if tabs still exist
    if (currentMaterialsTabs.length === 0) {
        return;
    }

    let updatedMaterials;

    if (storedEnhancementContext) {
        // Enhancement mode
        const ctx = storedEnhancementContext;
        updatedMaterials = calculateEnhancementMaterialRequirements(
            ctx.itemHrid,
            ctx.startLevel,
            ctx.targetLevel,
            ctx.protectionItemHrid,
            ctx.protectFromLevel,
            ctx.repeatCount
        );
    } else if (storedActionHrid && storedNumActions > 0) {
        // Production mode
        const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
        const accountForQueue = !ignoreQueue;
        updatedMaterials = atUpgradeItemLevel(
            calculateMaterialRequirements(storedActionHrid, storedNumActions, accountForQueue, {
                ownerId: RESERVATION_OWNER,
            }),
            storedUpgradeItemLevel
        );
    } else if (storedMaterialList) {
        updatedMaterials = materialsFromList(storedMaterialList.lines, storedMaterialList.ownerId || RESERVATION_OWNER);
    } else {
        return;
    }

    // The bill has been recomputed; the claim behind it moves with it — but a
    // bill opened under a caller's own owner id is that caller's claim, made
    // once when it opened the tabs. Restating it here under the tabs' own owner
    // would put a second claim on one shopping trip, and since the tabs net
    // against every owner but the caller's, the trip would then be short
    // against itself.
    if (!storedMaterialList?.ownerId) claimOpenBill(updatedMaterials);

    // Update each existing tab
    currentMaterialsTabs.forEach((tab) => {
        const itemHrid = tab.getAttribute('data-item-hrid');
        const material = updatedMaterials.find((m) => m.itemHrid === itemHrid);

        if (material) {
            updateTabBadge(tab, material);
        }
    });
    // Controls pinned beside the tabs (Buy next) re-read the badges
    currentMaterialsTabs.forEach((tab) => {
        if (tab.hasAttribute('data-mwi-buy-next')) tab.dispatchEvent(new Event('mwi-tabs-updated'));
    });
}

/**
 * Handle the "× All" control: the same teardown as leaving the marketplace
 * (every pinned tab and the Return tab gone, the armed quantity cleared, the
 * inventory listener dropped), triggered by the player instead of by navigation.
 * @param {boolean} returnToMarketListings - Click the native Market Listings tab
 *   afterward, so the strip that just lost its selected custom tab does not sit
 *   on nothing. Skipped for the Tester shop hand-off, which has no such tab —
 *   the Tester tab itself is already the "normal" view there.
 */
function handleClearAllClick(returnToMarketListings) {
    handleMarketplaceCleanup();
    if (returnToMarketListings) {
        navigateToMarketListingsTab();
    }
}

/**
 * Handle marketplace cleanup (when leaving marketplace)
 * Called by the marketplace cleanup observer
 */
function handleMarketplaceCleanup() {
    removeMaterialTabs();
    currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)

    // Clean up inventory listener
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
        inventoryUpdateHandler = null;
    }

    // The tabs are the panel: leaving the marketplace closes it, and a
    // transient claim does not outlive what made it
    release(RESERVATION_OWNER);

    // Clear stored context — only when genuinely leaving the marketplace
    storedActionHrid = null;
    storedNumActions = 0;
    storedEnhancementContext = null;
    storedMaterialList = null;
    autofillManager.clearQuantity();
}

/**
 * A bill of materials against the inventory, in the shape the tabs draw.
 *
 * Only unenhanced copies count as "have", as in the action calculator — an
 * enhanced piece is not what a house level or a recipe consumes. Nothing is
 * reserved for the action queue here: a house level is not an action.
 *
 * A line may name an enhancement level, which is how the simulators' Upgrade
 * tab asks for a piece of gear rather than a material: the tab then opens that
 * level's listing, and only copies already at that level count as held. The
 * field is carried only where it means something, so a plain bill's line is
 * the object it has always been. `unclaimedBoughtCount` is +0-only, so a
 * levelled line does not consult it — a buy order for the unenhanced item is
 * not progress towards a +7.
 *
 * @param {Array<{itemHrid: string, count: number, enhancementLevel?: number}>} lines - What is needed, in total
 * @param {string|null} [ownerId] - Who is asking, for the reservation ledger. The asking
 *   owner's own claim is never deducted, and nothing is deducted while the ledger is off
 *   or when no owner is named — omitting it is how every caller that predates the ledger
 *   calls this, and it must go on meaning "the ledger is not part of these figures"
 * @returns {Array<Object>} Material objects for `createMaterialTab`
 */
export function materialsFromList(lines, ownerId = null) {
    const inventory = dataManager.getInventory?.() || [];
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const out = [];
    for (const line of lines || []) {
        const required = Math.max(0, Math.floor(Number(line?.count) || 0));
        if (!line?.itemHrid || required <= 0) continue;
        const details = itemDetailMap[line.itemHrid];
        const level = Math.max(0, Math.floor(Number(line.enhancementLevel) || 0));
        // Bought-but-unclaimed units on the player's own buy orders count as
        // held — it is what makes the Missing figure fall while the order
        // fills instead of only after a trip to My Listings
        const have =
            (level > 0 ? 0 : unclaimedBoughtCount(line.itemHrid)) +
            inventory
                .filter((i) => i.itemHrid === line.itemHrid && (i.enhancementLevel || 0) === level)
                .reduce((sum, i) => sum + (i.count || 0), 0);
        // Stock another plan has claimed is not this bill's to spend
        const available = ownerId
            ? effectiveInventory(line.itemHrid, level, { excludeOwner: ownerId, held: have })
            : have;
        const missing = Math.max(0, required - available);
        const reserved = ownerId ? reservedElsewhere(line.itemHrid, level, { excludeOwner: ownerId }) : 0;
        // Only when a claim is what put the line short: an empty bag needs no explanation
        const reservedNote =
            missing > 0 && have >= required
                ? shortfallNote(missing, line.itemHrid, level, { excludeOwner: ownerId })
                : '';
        out.push({
            itemHrid: line.itemHrid,
            itemName: details?.name || line.itemHrid.split('/').pop().replace(/_/g, ' '),
            ...(level > 0 ? { enhancementLevel: level } : {}),
            required,
            have,
            queued: 0,
            available,
            missing,
            isTradeable: details?.isTradable === true,
            isUpgradeItem: false,
            ...(reserved > 0 ? { reserved } : {}),
            ...(reservedNote ? { reservedNote } : {}),
        });
    }
    return out;
}

/**
 * Open the marketplace on a bill of materials that is not an action's — a
 * house level's materials, or the two pieces a cross-slot gear swap buys, from
 * the simulators' Upgrade tab — one tab per item, each arming the buy box with
 * what is still missing, kept live as the inventory changes. The same tabs the
 * action panel button builds, from a list instead of a recipe. A line that
 * names an enhancement level opens that level's listing.
 *
 * @param {Array<{itemHrid: string, count: number, enhancementLevel?: number}>} lines - Totals needed
 * @param {Object} [options] - Options
 * @param {string|null} [options.ownerId] - The caller's reservation-ledger owner id, when it
 *   keeps a claim of its own; without one the open tabs claim the bill themselves
 * @returns {Promise<boolean>} Whether the marketplace opened and the tabs were drawn
 */
export async function openMaterialsList(lines, { ownerId = null } = {}) {
    const wanted = (lines || []).filter((line) => line?.itemHrid && Number(line.count) > 0);
    if (!wanted.length) return false;

    storedActionHrid = null;
    storedNumActions = 0;
    storedEnhancementContext = null;
    storedUpgradeItemLevel = 0;
    storedMaterialList = { lines: wanted, ownerId };

    // A caller that keeps a claim of its own has already made it (the crafting
    // plan does, on the click that opened this); only an anonymous bill is
    // claimed here, under the tabs' own transient owner
    const materials = materialsFromList(wanted, ownerId || RESERVATION_OWNER);
    if (!(await openWhereBought(materials))) return false;
    if (!ownerId) await claimOpenBill(materials);
    setupInventoryListener();
    return true;
}

/**
 * The reservation owner behind the bill of materials currently on screen, when
 * that bill was opened by a caller holding a claim of its own.
 *
 * The seam a caller needs to answer "is my shopping trip still open?". A
 * crafting plan's claim is supposed to live exactly as long as the player can
 * see the plan, and clicking Buy Missing Materials navigates away from the
 * action panel — so without this the claim behind the very trip the player is
 * on would be swept the moment the panel unmounted.
 *
 * Null once the tabs are gone (leaving the marketplace, the × All control) or
 * for a bill the tabs claimed themselves.
 *
 * @returns {string|null} The caller's owner id, or null
 */
export function openBillOwner() {
    if (!currentMaterialsTabs.length) return null;
    return storedMaterialList?.ownerId || null;
}

/**
 * Open the marketplace on the materials an action is short of.
 *
 * The same thing the button in the action panel does, reachable from anywhere.
 * Equipment Watch wants it for a craft it is saving towards, and that card is
 * in another bundle — so this is the seam rather than a second implementation
 * of the tab-building, which is where the two would drift apart.
 *
 * @param {string} actionHrid - The action whose inputs are wanted
 * @param {number} [numActions] - How many of it
 * @param {Object} [options] - Options
 * @param {number} [options.upgradeItemLevel] - The enhancement level the action's upgrade item
 *   is wanted at. A refinement that retains enhancement is made FROM a base already at the
 *   output's level, so a caller saving towards a ★+12 needs the +12 listing rather than the
 *   +0 one. Defaults to 0, which is every action panel and every plain craft — unchanged.
 * @returns {Promise<void>}
 */
export async function openMissingMaterials(actionHrid, numActions = 1, { upgradeItemLevel = 0 } = {}) {
    await handleMissingMaterialsClick(actionHrid, numActions, upgradeItemLevel);
}

export default {
    initialize,
    cleanup,
    openMissingMaterials,
    openMaterialsList,
    openBillOwner,
    openTesterShopPage,
};
