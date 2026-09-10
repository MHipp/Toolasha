/**
 * House Upgrade Cost Display
 * UI rendering for house upgrade costs
 */

import config from '../../core/config.js';
import * as houseCostCalculator from '../../utils/house-cost-calculator.js';
import { coinFormatter, formatWithSeparator } from '../../utils/formatters.js';
import dataManager from '../../core/data-manager.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { testerShopEnabled } from '../../utils/tester-shop.js';
import { missingMaterialsButton } from '../../utils/bundle-bridge.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import {
    createMaterialTab,
    createClearAllTabsControl,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
    navigateToMarketListingsTab,
    visibleTabsContainer,
    attachRegularTabClearListener,
} from '../../utils/marketplace-tabs.js';

/**
 * Height bound for the cumulative materials list.
 *
 * `overflow-y: auto` only ever scrolls a box that something stops from growing,
 * so the list needs a real bound of its own — it has no height-constraining
 * ancestor (the game's modal lets its content run as long as it likes).
 *
 * The unit is the visual viewport, not `vh`: `vh` on mobile is measured against
 * the *largest* viewport and ignores the address bar and the on-screen keyboard,
 * which is exactly the space that is missing when the list runs off a phone
 * screen. `--toolasha-visual-viewport-height` is published by
 * `src/utils/visual-viewport.js` and tracks what is actually visible; the `100vh`
 * fallback covers browsers without `visualViewport`, and a browser that does not
 * understand `max()` simply drops the declaration and gets today's behaviour.
 *
 * The floor keeps a very short viewport from producing a two-row peephole, and
 * 55% is loose enough that a desktop viewport (~1000px+) fits a full eight-level
 * material list without scrolling at all — the bound only bites when the content
 * genuinely does not fit.
 */
const MATERIALS_LIST_MAX_HEIGHT = 'max(200px, calc(var(--toolasha-visual-viewport-height, 100vh) * 0.55))';

const PANEL_LAYOUT_STYLE_ID = 'toolasha-house-panel-layout';

/**
 * The one game element this file restyles, and why it has to.
 *
 * `HousePanel_modalContent` is a flex column, so everything in it — the game's
 * own costs, the game's **Build** button, and the section this file appends —
 * is a flex item, and a flex line that asks for more height than the panel has
 * takes the difference back out of its items.
 *
 * That is a fight nobody wins. Whichever item is willing to shrink is the one
 * that gets ruined:
 *
 * - Leave our section shrinkable (`min-height: 0`, added in f094f9adc to stop
 *   the Build button collapsing) and the section is squeezed below its own
 *   contents — measured at 155px around a 352px materials list — so the list,
 *   the total and the marketplace button all render *outside* the section's
 *   rounded border. And the Build button still ends up 11px tall, because
 *   shrinkage is shared out in proportion, not handed to one volunteer.
 * - Make our section refuse to shrink (`flex-shrink: 0`) and the whole deficit
 *   lands on the Build button, whose `overflow: hidden` resolves its automatic
 *   minimum size to zero. It collapses to 0px. That is f094f9adc's bug, back.
 *
 * There is no split of a fixed height that is not somebody's bug, so the fix is
 * to stop the height being fixed. `min-height` beats both `height` and
 * `max-height` at used-value time, so `fit-content` makes the panel grow to
 * hold its items however it was being clamped — a shrunken flex item, a
 * percentage height, a max-height. Nothing has to give, and the modal's own
 * scroller (`Modal_modalContent`, which is what the game provides for content
 * that runs long) sees the true height and can reach the bottom of it.
 *
 * `:has(.mwi-house-to-level)` is the restore path. The rule only ever matches a
 * house panel that is currently carrying this file's section, so removing the
 * section — a room switch, `removeExistingColumn()`, a game update that renames
 * the class — leaves the panel exactly as the game styles it, with no undo to
 * remember. `disable()` takes the stylesheet out as well.
 */
const PANEL_LAYOUT_CSS = `
    [class*="HousePanel_modalContent"]:has(.mwi-house-to-level) {
        min-height: fit-content;
    }
`;

class HouseCostDisplay {
    constructor() {
        this.isActive = false;
        this.currentModalContent = null; // Track current modal to detect room switches
        this.isInitialized = false;
        this.currentMaterialsTabs = []; // Track marketplace tabs
        this.cleanupObserver = null; // Marketplace cleanup observer
        this.timerRegistry = createTimerRegistry();
        this.autofillManager = createAutofillManager('MissingMats-Houses');
        this._itemsUpdatedHandler = null; // Inventory change listener
        this._houseRoomsUpdatedHandler = null; // House room level change listener
        this._cumulativeState = null; // State for refreshing cumulative display
        this._costContext = null; // { houseRoomHrid, currentLevel, targetLevel } for recalculating missing mats
        this._refreshGen = 0; // Generation counter to discard stale async refreshes
    }

    /**
     * Setup settings listeners for feature toggle and color changes
     */
    setupSettingListener() {
        config.onSettingChange('houseUpgradeCosts', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        config.onSettingChange('color_accent', () => {
            if (this.isInitialized) {
                this.refresh();
            }
        });
    }

    /**
     * Initialize the display system
     */
    initialize() {
        if (!config.getSetting('houseUpgradeCosts')) {
            return;
        }
        // Two callers — the panel observer's `initialize()` and the setting's
        // own toggle — and neither knows about the other, so a toggle while the
        // observer is up used to register a second pair of bus listeners on top
        // of the first. `disable()` clears the flag, so a real restart still runs.
        if (this.isInitialized) {
            return;
        }

        this.isActive = true;
        this.isInitialized = true;

        // See PANEL_LAYOUT_CSS: lets the game's house panel grow to hold the
        // section this file appends, instead of squeezing it — or the game's
        // Build button — to make room.
        addStyles(PANEL_LAYOUT_CSS, PANEL_LAYOUT_STYLE_ID);

        // Setup cleanup observer for marketplace tabs (consistent with actions feature)
        this.cleanupObserver = setupMarketplaceCleanupObserver(
            () => this.handleMarketplaceCleanup(),
            this.currentMaterialsTabs
        );

        // Listen for inventory changes to refresh the cumulative display
        this._itemsUpdatedHandler = () => this._onInventoryChanged();
        dataManager.on('items_updated', this._itemsUpdatedHandler);

        // Listen for house room level changes to refresh the dropdown and display
        this._houseRoomsUpdatedHandler = () => this._onHouseRoomUpdated();
        dataManager.on('house_rooms_updated', this._houseRoomsUpdatedHandler);

        this.autofillManager.initialize();

        // The House tab's button row: a one-press "pin every room's bill" for
        // the Tester shop, drawn only while that pricing is on
        this._unregisterButtonRow = domObserver.onClass(
            'HouseCostDisplay-ButtonRow',
            'HousePanel_buttonContainer',
            (row) => this.injectAllRoomsButton(row)
        );
    }

    /**
     * Every material every room still needs to reach `targetLevel`, summed.
     *
     * Coins are left out (the shop sells no coins), and so is a room already
     * at or past the target. Inventory is not subtracted here — the tabs net
     * it out themselves, live.
     *
     * @param {number} targetLevel - 1..8
     * @returns {Array<{itemHrid: string, count: number}>}
     */
    allRoomsBill(targetLevel = 8) {
        const map = dataManager.getInitClientData()?.houseRoomDetailMap || {};
        const counts = new Map();
        for (const [roomHrid, detail] of Object.entries(map)) {
            const current = Number(dataManager.getHouseRoomLevel?.(roomHrid)) || 0;
            const costs = detail?.upgradeCostsMap || {};
            for (let level = current + 1; level <= targetLevel; level++) {
                for (const entry of costs[level] ?? costs[String(level)] ?? []) {
                    const count = Number(entry?.count) || 0;
                    if (!entry?.itemHrid || count <= 0 || entry.itemHrid === '/items/coin') continue;
                    counts.set(entry.itemHrid, (counts.get(entry.itemHrid) || 0) + count);
                }
            }
        }
        return [...counts.entries()].map(([itemHrid, count]) => ({ itemHrid, count }));
    }

    /**
     * Add the "all rooms → Lv N" button beside the House tab's own buttons.
     * @param {HTMLElement} row - `HousePanel_buttonContainer`
     */
    injectAllRoomsButton(row) {
        if (!row || row.querySelector('.mwi-house-all-rooms')) return;
        if (!testerShopEnabled()) return;

        const wrap = document.createElement('span');
        wrap.className = 'mwi-house-all-rooms';
        wrap.style.cssText = 'display:inline-flex; align-items:center; gap:4px; margin-left:8px;';

        const level = document.createElement('input');
        level.type = 'number';
        level.min = '1';
        level.max = '8';
        level.value = '8';
        level.style.cssText =
            'width:40px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:2px 4px; font-size:12px;';
        level.title = 'Target level for every room';

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Tester: pin all rooms → Lv';
        button.style.cssText =
            'background:rgba(76,175,80,0.12); border:1px solid #4caf50; color:#8bc34a; border-radius:4px; padding:3px 8px; font-size:12px; cursor:pointer; font-family:inherit;';
        button.title =
            'Pins every material every room still needs to reach the level into the Tester shop strip — one tab per ' +
            'material, counts net of what you hold — ready for Buy next, one press per material.';
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const target = Math.max(1, Math.min(8, parseInt(level.value, 10) || 8));
            const lines = this.allRoomsBill(target);
            const openBill = missingMaterialsButton()?.openMaterialsList;
            if (!lines.length) {
                button.textContent = 'Nothing left to buy';
            } else if (typeof openBill === 'function') {
                button.textContent = `Pinning ${lines.length} materials…`;
                try {
                    await openBill(lines);
                    button.textContent = 'Pinned ✓';
                } catch (error) {
                    console.error('[HouseCostDisplay] Pinning the all-rooms bill failed:', error);
                    button.textContent = 'Failed';
                }
            } else {
                button.textContent = 'Missing-materials module not loaded';
            }
            this.timerRegistry.registerTimeout(
                setTimeout(() => {
                    button.textContent = 'Tester: pin all rooms → Lv';
                }, 2500)
            );
        });

        wrap.append(button, level);
        row.appendChild(wrap);
    }

    /**
     * Augment native costs section with market pricing
     * @param {Element} costsSection - The native HousePanel_costs element
     * @param {string} houseRoomHrid - House room HRID
     * @param {Element} modalContent - The modal content element
     */
    async addCostColumn(costsSection, houseRoomHrid, modalContent) {
        // Remove any existing augmentation first
        this.removeExistingColumn(modalContent);

        const currentLevel = houseCostCalculator.getCurrentRoomLevel(houseRoomHrid);

        // Don't show if already max level
        if (currentLevel >= 8) {
            return;
        }

        try {
            // Add "Cumulative to Level" section
            await this.addCompactToLevel(costsSection, houseRoomHrid, currentLevel);

            // Mark this modal as processed
            this.currentModalContent = modalContent;
        } catch {
            // Silently fail - augmentation is optional
        }
    }

    /**
     * Remove existing augmentations
     * @param {Element} modalContent - The modal content element
     */
    removeExistingColumn(modalContent) {
        // Remove all MWI-added elements
        modalContent
            .querySelectorAll('.mwi-house-pricing, .mwi-house-pricing-empty, .mwi-house-total, .mwi-house-to-level')
            .forEach((el) => el.remove());

        // Restore original grid columns
        const itemRequirementsGrid = modalContent.querySelector('[class*="HousePanel_itemRequirements"]');
        if (itemRequirementsGrid) {
            itemRequirementsGrid.style.gridTemplateColumns = '';
        }

        // The panel's own `min-height` needs no undo here: PANEL_LAYOUT_CSS is
        // gated on `:has(.mwi-house-to-level)`, so removing the section above
        // has already stopped it matching.
    }

    /**
     * Augment native cost items with market pricing
     * @param {Element} costsSection - Native costs section
     * @param {Object} costData - Cost data from calculator
     */
    async augmentNativeCosts(costsSection, costData) {
        // Find the item requirements grid container
        const itemRequirementsGrid = costsSection.querySelector('[class*="HousePanel_itemRequirements"]');
        if (!itemRequirementsGrid) {
            return;
        }

        // Modify the grid to accept 4 columns instead of 3
        // Native grid is: icon | inventory count | input count
        // We want: icon | inventory count | input count | pricing
        const currentGridStyle = window.getComputedStyle(itemRequirementsGrid).gridTemplateColumns;

        // Add a 4th column for pricing (auto width)
        itemRequirementsGrid.style.gridTemplateColumns = currentGridStyle + ' auto';

        // Find all item containers (these have the icons)
        const itemContainers = itemRequirementsGrid.querySelectorAll('[class*="Item_itemContainer"]');
        if (itemContainers.length === 0) {
            return;
        }

        for (const itemContainer of itemContainers) {
            // Game uses SVG sprites, not img tags
            const svg = itemContainer.querySelector('svg');
            if (!svg) continue;

            // Extract item name from href (e.g., #lumber -> lumber)
            const useElement = svg.querySelector('use');
            const hrefValue = useElement?.getAttribute('href') || '';
            const itemName = hrefValue.split('#')[1];
            if (!itemName) continue;

            // Convert to item HRID
            const itemHrid = `/items/${itemName}`;

            // Find matching material in costData
            let materialData;
            if (itemHrid === '/items/coin') {
                materialData = {
                    itemHrid: '/items/coin',
                    count: costData.coins,
                    marketPrice: 1,
                    totalValue: costData.coins,
                };
            } else {
                materialData = costData.materials.find((m) => m.itemHrid === itemHrid);
            }

            if (!materialData) continue;

            // Skip coins (no pricing needed)
            if (materialData.itemHrid === '/items/coin') {
                // Add empty cell to maintain grid structure
                this.addEmptyCell(itemRequirementsGrid, itemContainer);
                continue;
            }

            // Add pricing as a new grid cell to the right
            this.addPricingCell(itemRequirementsGrid, itemContainer, materialData);
        }
    }

    /**
     * Add empty cell for coins to maintain grid structure
     * @param {Element} grid - The requirements grid
     * @param {Element} itemContainer - The item icon container (badge)
     */
    addEmptyCell(grid, itemContainer) {
        const emptyCell = document.createElement('span');
        emptyCell.className = 'mwi-house-pricing-empty HousePanel_itemRequirementCell__3hSBN';

        // Insert immediately after the item badge
        itemContainer.after(emptyCell);
    }

    /**
     * Add pricing as a new grid cell to the right of the item
     * @param {Element} grid - The requirements grid
     * @param {Element} itemContainer - The item icon container (badge)
     * @param {Object} materialData - Material data with pricing
     */
    addPricingCell(grid, itemContainer, materialData) {
        // Check if already augmented
        const nextSibling = itemContainer.nextElementSibling;
        if (nextSibling?.classList.contains('mwi-house-pricing')) {
            return;
        }

        const inventoryCount = houseCostCalculator.getInventoryCount(materialData.itemHrid);
        const hasEnough = inventoryCount >= materialData.count;
        const amountNeeded = Math.max(0, materialData.count - inventoryCount);

        // Create pricing cell
        const pricingCell = document.createElement('span');
        pricingCell.className = 'mwi-house-pricing HousePanel_itemRequirementCell__3hSBN';
        pricingCell.style.cssText = `
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 8px;
            font-size: 0.75rem;
            color: ${config.COLOR_ACCENT};
            padding-left: 8px;
            white-space: nowrap;
        `;

        pricingCell.innerHTML = `
            <span style="color: ${config.COLOR_TEXT_SECONDARY};">@ ${coinFormatter(materialData.marketPrice)}</span>
            <span style="color: ${config.COLOR_ACCENT}; font-weight: bold;">= ${coinFormatter(materialData.totalValue)}</span>
            <span style="color: ${hasEnough ? '#4ade80' : '#f87171'}; margin-left: auto; text-align: right;">${coinFormatter(amountNeeded)}</span>
        `;

        // Insert immediately after the item badge
        itemContainer.after(pricingCell);
    }

    /**
     * Add total cost below native costs section
     * @param {Element} costsSection - Native costs section
     * @param {Object} costData - Cost data
     */
    addTotalCost(costsSection, costData) {
        const totalDiv = document.createElement('div');
        totalDiv.className = 'mwi-house-total';
        totalDiv.style.cssText = `
            margin-top: 12px;
            padding-top: 12px;
            border-top: 2px solid ${config.COLOR_ACCENT};
            font-weight: bold;
            font-size: 1rem;
            color: ${config.COLOR_ACCENT};
            text-align: center;
        `;
        totalDiv.textContent = `Total Market Value: ${coinFormatter(costData.totalValue)}`;
        costsSection.appendChild(totalDiv);
    }

    /**
     * Add compact "To Level" section
     * @param {Element} costsSection - Native costs section
     * @param {string} houseRoomHrid - House room HRID
     * @param {number} currentLevel - Current level
     */
    async addCompactToLevel(costsSection, houseRoomHrid, currentLevel) {
        const section = document.createElement('div');
        section.className = 'mwi-house-to-level';
        // `flex-shrink: 0` replaces the `min-height: 0` that used to sit here.
        // The list already has its own bound and its own scrollbar, so a section
        // squeezed below that bound is not saving space, it is spilling its
        // contents out of its own border. It is safe to refuse only because
        // PANEL_LAYOUT_CSS lets the panel grow rather than pushing the deficit
        // onto the game's Build button — the two go together.
        section.style.cssText = `
            margin-top: 8px;
            padding: 8px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            border: 1px solid ${config.COLOR_BORDER};
            flex-shrink: 0;
        `;

        // Compact header with inline dropdown
        const headerRow = document.createElement('div');
        headerRow.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-bottom: 8px;
        `;

        const label = document.createElement('span');
        label.style.cssText = `
            color: ${config.COLOR_ACCENT};
            font-weight: bold;
            font-size: 0.875rem;
        `;
        label.textContent = 'Cumulative to Level:';

        const dropdown = document.createElement('select');
        dropdown.classList.add('toolasha-select');
        dropdown.style.cssText = `
            padding: 4px 8px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid ${config.COLOR_BORDER};
            color: ${config.SCRIPT_COLOR_MAIN};
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
        `;

        // Add options
        for (let level = currentLevel + 1; level <= 8; level++) {
            const option = document.createElement('option');
            option.value = level;
            option.textContent = level;
            dropdown.appendChild(option);
        }

        // Default to next level (currentLevel + 1)
        const defaultLevel = currentLevel + 1;
        dropdown.value = defaultLevel;

        headerRow.appendChild(label);
        headerRow.appendChild(dropdown);
        section.appendChild(headerRow);

        // Cost display container
        const costContainer = document.createElement('div');
        costContainer.className = 'mwi-cumulative-cost-container';
        costContainer.style.cssText = `
            font-size: 0.875rem;
            margin-top: 8px;
            text-align: left;
        `;
        section.appendChild(costContainer);

        // Initial render
        await this.updateCompactCumulativeDisplay(costContainer, houseRoomHrid, currentLevel, parseInt(dropdown.value));

        // Store state for inventory-change refresh
        this._cumulativeState = { costContainer, houseRoomHrid, currentLevel, dropdown };
        this._costContext = { houseRoomHrid, currentLevel, targetLevel: parseInt(dropdown.value) };

        // Update on change
        dropdown.addEventListener('change', async () => {
            this._costContext = { houseRoomHrid, currentLevel, targetLevel: parseInt(dropdown.value) };
            await this.updateCompactCumulativeDisplay(
                costContainer,
                houseRoomHrid,
                currentLevel,
                parseInt(dropdown.value)
            );
        });

        costsSection.parentElement.appendChild(section);
    }

    /**
     * Update compact cumulative display
     * @param {Element} container - Container element
     * @param {string} houseRoomHrid - House room HRID
     * @param {number} currentLevel - Current level
     * @param {number} targetLevel - Target level
     */
    async updateCompactCumulativeDisplay(container, houseRoomHrid, currentLevel, targetLevel) {
        // Concurrent calls (items_updated + house_rooms_updated fire in the same turn)
        // must not interleave clear/append — only the latest call may write to the DOM
        const gen = ++this._refreshGen;

        const costData = await houseCostCalculator.calculateCumulativeCost(houseRoomHrid, currentLevel, targetLevel);
        if (gen !== this._refreshGen) return;

        // Build into a detached fragment, then clear+append in one synchronous swap
        const fragment = document.createDocumentFragment();

        // Materials list as vertical stack of single-line rows
        // Only the rows scroll; the total and the marketplace button below stay
        // pinned under them so the button is reachable without scrolling to the
        // end of a fourteen-material list.
        const materialsList = document.createElement('div');
        materialsList.className = 'mwi-cumulative-materials-list';
        materialsList.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: ${MATERIALS_LIST_MAX_HEIGHT};
            overflow-y: auto;
            overscroll-behavior: contain;
        `;

        // Coins first
        if (costData.coins > 0) {
            this.appendMaterialRow(materialsList, {
                itemHrid: '/items/coin',
                count: costData.coins,
                totalValue: costData.coins,
            });
        }

        // Materials
        for (const material of costData.materials) {
            this.appendMaterialRow(materialsList, material);
        }

        fragment.appendChild(materialsList);

        // Total
        const totalDiv = document.createElement('div');
        totalDiv.style.cssText = `
            margin-top: 12px;
            padding-top: 12px;
            border-top: 2px solid ${config.COLOR_ACCENT};
            font-weight: bold;
            font-size: 1rem;
            color: ${config.COLOR_ACCENT};
            text-align: center;
        `;
        totalDiv.textContent = `Total Market Value: ${coinFormatter(costData.totalValue)}`;
        fragment.appendChild(totalDiv);

        // Add Missing Mats Marketplace button if any materials are missing
        const missingMaterials = this.getMissingMaterials(costData);
        if (missingMaterials.length > 0) {
            const button = this.createMissingMaterialsButton(missingMaterials);
            fragment.appendChild(button);
        }

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    /**
     * Append material row as single-line compact format
     * @param {Element} container - The container element
     * @param {Object} material - Material data
     */
    appendMaterialRow(container, material) {
        const itemName = houseCostCalculator.getItemName(material.itemHrid);
        const inventoryCount = houseCostCalculator.getInventoryCount(material.itemHrid);
        const hasEnough = inventoryCount >= material.count;
        const amountNeeded = Math.max(0, material.count - inventoryCount);
        const isCoin = material.itemHrid === '/items/coin';

        const row = document.createElement('div');
        row.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.875rem;
            line-height: 1.4;
        `;

        // [inv / req] - left side
        const inventorySpan = document.createElement('span');
        inventorySpan.style.cssText = `
            color: ${hasEnough ? 'white' : '#f87171'};
            min-width: 120px;
            text-align: right;
        `;
        inventorySpan.textContent = `${coinFormatter(inventoryCount)} / ${coinFormatter(material.count)}`;
        row.appendChild(inventorySpan);

        // [Badge] Material Name
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = `
            color: white;
            min-width: 140px;
        `;
        nameSpan.textContent = itemName;
        row.appendChild(nameSpan);

        // @ price = total (skip for coins)
        if (!isCoin) {
            const pricingSpan = document.createElement('span');
            pricingSpan.style.cssText = `
                color: ${config.COLOR_ACCENT};
                min-width: 180px;
            `;
            pricingSpan.textContent = `@ ${coinFormatter(material.marketPrice)} = ${coinFormatter(material.totalValue)}`;
            row.appendChild(pricingSpan);
        } else {
            // Empty spacer for coins
            const spacer = document.createElement('span');
            spacer.style.minWidth = '180px';
            row.appendChild(spacer);
        }

        // Missing: X - right side
        const missingSpan = document.createElement('span');
        missingSpan.style.cssText = `
            color: ${hasEnough ? '#4ade80' : '#f87171'};
            margin-left: auto;
            text-align: right;
        `;
        missingSpan.textContent = `Missing: ${coinFormatter(amountNeeded)}`;
        row.appendChild(missingSpan);

        container.appendChild(row);
    }

    /**
     * Get missing materials from cost data
     * @param {Object} costData - Cost data from calculator
     * @returns {Array} Array of missing materials in marketplace format
     */
    getMissingMaterials(costData) {
        const gameData = dataManager.getInitClientData();
        const inventory = dataManager.getInventory();
        const missing = [];

        // Process all materials (skip coins)
        for (const material of costData.materials) {
            // Only count items in inventory (not equipped) with no enhancement
            // Enhanced items and equipped items cannot be used for house construction
            const inventoryItem = inventory.find(
                (i) =>
                    i.itemHrid === material.itemHrid &&
                    i.itemLocationHrid === '/item_locations/inventory' &&
                    (!i.enhancementLevel || i.enhancementLevel === 0)
            );
            const have = inventoryItem?.count || 0;
            const missingAmount = Math.max(0, material.count - have);

            // Only include if missing > 0
            if (missingAmount > 0) {
                const itemDetails = gameData.itemDetailMap[material.itemHrid];
                if (itemDetails) {
                    missing.push({
                        itemHrid: material.itemHrid,
                        itemName: itemDetails.name,
                        required: material.count,
                        missing: missingAmount,
                        isTradeable: itemDetails.isTradable === true,
                    });
                }
            }
        }

        return missing;
    }

    /**
     * Create missing materials marketplace button
     * @param {Array} missingMaterials - Array of missing material objects
     * @returns {HTMLElement} Button element
     */
    createMissingMaterialsButton(missingMaterials) {
        const button = document.createElement('button');
        button.style.cssText = `
            width: 100%;
            padding: 10px 16px;
            margin-top: 12px;
            background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
            color: #ffffff;
            border: 1px solid rgba(91, 141, 239, 0.4);
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        `;
        button.textContent = 'Missing Mats Marketplace';

        // Hover effects
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
            await this.handleMissingMaterialsClick(missingMaterials);
        });

        return button;
    }

    /**
     * Handle missing materials button click
     * @param {Array} missingMaterials - Array of missing material objects
     */
    async handleMissingMaterialsClick(missingMaterials) {
        // Tester shop priced in: hand the whole bill to the actions module,
        // which opens the shop's Tester tab with a tab per line and arms the
        // buy dialog — the same thing its own button does
        const openBill = missingMaterialsButton()?.openMaterialsList;
        if (testerShopEnabled() && typeof openBill === 'function') {
            const lines = (missingMaterials || []).map((m) => ({
                itemHrid: m.itemHrid,
                count: Number(m.required) > 0 ? Number(m.required) : Number(m.missing) || 0,
            }));
            if (await openBill(lines)) return;
        }

        // Navigate to marketplace
        const success = await this.navigateToMarketplace();
        if (!success) {
            console.error('[HouseCostDisplay] Failed to navigate to marketplace');
            return;
        }

        // Wait for marketplace to settle
        await new Promise((resolve) => {
            const delayTimeout = setTimeout(resolve, 200);
            this.timerRegistry.registerTimeout(delayTimeout);
        });

        // Create custom tabs
        this.createMissingMaterialTabs(missingMaterials);
    }

    /**
     * Navigate to marketplace by clicking navbar
     * @returns {Promise<boolean>} True if successful
     */
    async navigateToMarketplace() {
        // Find marketplace navbar button
        const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
        const marketplaceButton = Array.from(navButtons).find((nav) => {
            const svg = nav.querySelector('svg[aria-label="navigationBar.marketplace"]');
            return svg !== null;
        });

        if (!marketplaceButton) {
            console.error('[HouseCostDisplay] Marketplace navbar button not found');
            return false;
        }

        // Click button
        marketplaceButton.click();

        // Wait for marketplace to appear
        return await this.waitForMarketplace();
    }

    /**
     * Wait for marketplace panel to appear
     * @returns {Promise<boolean>} True if marketplace appeared
     */
    async waitForMarketplace() {
        const maxAttempts = 50;
        const delayMs = 100;

        for (let i = 0; i < maxAttempts; i++) {
            const tabsContainer = visibleTabsContainer();
            if (tabsContainer) {
                const hasMarketListings = Array.from(tabsContainer.children).some((btn) =>
                    btn.textContent.includes('Market Listings')
                );
                if (hasMarketListings) {
                    return true;
                }
            }

            await new Promise((resolve) => {
                const delayTimeout = setTimeout(resolve, delayMs);
                this.timerRegistry.registerTimeout(delayTimeout);
            });
        }

        console.error('[HouseCostDisplay] Marketplace did not open within timeout');
        return false;
    }

    /**
     * Create custom tabs for missing materials
     * @param {Array} missingMaterials - Array of missing material objects
     */
    createMissingMaterialTabs(missingMaterials) {
        const tabsContainer = visibleTabsContainer();
        if (!tabsContainer) {
            console.error('[HouseCostDisplay] Tabs container not found');
            return;
        }

        // Remove existing custom tabs
        removeMaterialTabs();

        // Get reference tab
        const referenceTab = Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'));
        if (!referenceTab) {
            console.error('[HouseCostDisplay] Reference tab not found');
            return;
        }

        // Enable flex wrapping
        tabsContainer.style.flexWrap = 'wrap';

        // See attachRegularTabClearListener: clears the armed quantity when a
        // *different* native tab is picked, but not on "+ New Buy Listing" /
        // "+ New Sell Listing" — those live in the same flex row but aren't MUI
        // Tabs.
        attachRegularTabClearListener(tabsContainer, () => this.autofillManager.clearQuantity());

        // Create tab for each missing material
        this.currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)
        for (const material of missingMaterials) {
            let tabEl = null;
            const tab = createMaterialTab(material, referenceTab, (_e, mat) => {
                // Read the current missing quantity from the tab's data attribute,
                // which is kept up-to-date by the inventory listener.
                // Armed for this tab's item, so a buy box for anything else is
                // left alone — the calculation persists between modals
                this.autofillManager.setPendingCalculation(
                    () => parseInt(tabEl?.getAttribute('data-missing-quantity') || '0', 10),
                    { itemHrid: mat.itemHrid }
                );
                // Navigate to marketplace
                navigateToMarketplace(mat.itemHrid, 0);
            });
            tabEl = tab;
            tab.setAttribute('data-item-name', material.itemName);
            tabsContainer.appendChild(tab);
            this.currentMaterialsTabs.push(tab);
        }

        // One click, every pinned tab gone, landing back on the plain Market
        // Listings view — same control the action-panel button uses
        const clearAllControl = createClearAllTabsControl(referenceTab, () => this.handleClearAllClick());
        tabsContainer.appendChild(clearAllControl);
        this.currentMaterialsTabs.push(clearAllControl);
    }

    /**
     * Handle the "× All" control: the same teardown as leaving the marketplace,
     * plus returning to the native Market Listings tab so the strip that just
     * lost its selected custom tab does not sit on nothing.
     */
    handleClearAllClick() {
        this.handleMarketplaceCleanup();
        navigateToMarketListingsTab();
    }

    /**
     * Handle marketplace cleanup (when leaving marketplace)
     * Called by the marketplace cleanup observer
     */
    handleMarketplaceCleanup() {
        removeMaterialTabs();
        this.currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)
        this.autofillManager.clearQuantity();
    }

    /**
     * Refresh colors on existing displays
     */
    refresh() {
        // Update pricing cell colors
        document.querySelectorAll('.mwi-house-pricing').forEach((cell) => {
            cell.style.color = config.COLOR_ACCENT;
            const boldSpan = cell.querySelector('span[style*="font-weight: bold"]');
            if (boldSpan) {
                boldSpan.style.color = config.COLOR_ACCENT;
            }
        });

        // Update total cost colors
        document.querySelectorAll('.mwi-house-total').forEach((total) => {
            total.style.borderTopColor = config.COLOR_ACCENT;
            total.style.color = config.COLOR_ACCENT;
        });

        // Update "To Level" label colors
        document.querySelectorAll('.mwi-house-to-level span[style*="font-weight: bold"]').forEach((label) => {
            label.style.color = config.COLOR_ACCENT;
        });

        // Update cumulative total colors
        document.querySelectorAll('.mwi-cumulative-cost-container span[style*="font-weight: bold"]').forEach((span) => {
            span.style.color = config.COLOR_ACCENT;
        });
    }

    /**
     * Handle inventory changes — refresh the cumulative display if visible
     */
    async _onInventoryChanged() {
        // Update marketplace tabs (visible while shopping)
        this._updateMarketplaceTabs();

        if (!this._cumulativeState) return;
        const { costContainer, houseRoomHrid, currentLevel, dropdown } = this._cumulativeState;
        // Only refresh if the container is still in the DOM
        if (!costContainer.isConnected) {
            this._cumulativeState = null;
            return;
        }
        await this.updateCompactCumulativeDisplay(costContainer, houseRoomHrid, currentLevel, parseInt(dropdown.value));
    }

    /**
     * Handle house room level changes — refresh the dropdown and cumulative display
     */
    async _onHouseRoomUpdated() {
        if (!this._cumulativeState) return;
        const { costContainer, houseRoomHrid, dropdown } = this._cumulativeState;
        if (!costContainer.isConnected) {
            this._cumulativeState = null;
            return;
        }

        const newLevel = houseCostCalculator.getCurrentRoomLevel(houseRoomHrid);
        if (newLevel >= 8) {
            costContainer.innerHTML = '';
            this._cumulativeState = null;
            this._costContext = null;
            return;
        }

        // Remove dropdown options at or below the new current level
        while (dropdown.options.length > 0 && parseInt(dropdown.options[0].value) <= newLevel) {
            dropdown.remove(0);
        }

        if (dropdown.options.length === 0) {
            costContainer.innerHTML = '';
            this._cumulativeState = null;
            this._costContext = null;
            return;
        }

        dropdown.value = dropdown.options[0].value;
        const targetLevel = parseInt(dropdown.value);

        this._cumulativeState.currentLevel = newLevel;
        this._costContext = { houseRoomHrid, currentLevel: newLevel, targetLevel };

        await this.updateCompactCumulativeDisplay(costContainer, houseRoomHrid, newLevel, targetLevel);
    }

    /**
     * Update marketplace tab badges when inventory changes.
     * Recalculates missing amounts and updates each tab's display.
     */
    async _updateMarketplaceTabs() {
        if (this.currentMaterialsTabs.length === 0) return;
        if (!this._costContext) return;

        const { houseRoomHrid, currentLevel, targetLevel } = this._costContext;
        const costData = await houseCostCalculator.calculateCumulativeCost(houseRoomHrid, currentLevel, targetLevel);
        const updatedMaterials = this.getMissingMaterials(costData);

        for (const tab of this.currentMaterialsTabs) {
            const itemHrid = tab.getAttribute('data-item-hrid');
            const material = updatedMaterials.find((m) => m.itemHrid === itemHrid);

            const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
            if (!badgeSpan) continue;

            let statusColor;
            let statusText;
            let displayName = tab.getAttribute('data-item-name') || itemHrid;

            if (!material) {
                statusColor = '#4ade80';
                statusText = 'Complete';
            } else if (!material.isTradeable) {
                statusColor = '#888888';
                statusText = 'Not Tradeable';
                displayName = material.itemName;
            } else {
                statusColor = '#ef4444';
                statusText = `Missing: ${formatWithSeparator(material.missing)}`;
                displayName = material.itemName;
            }

            const titleCaseName = displayName
                .split(' ')
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');

            badgeSpan.innerHTML = `
                <div style="text-align: center;">
                    <div>${titleCaseName}</div>
                    <div style="font-size: 0.75em; color: ${statusColor};">
                        ${statusText}
                    </div>
                </div>
            `;

            tab.setAttribute('data-missing-quantity', material ? material.missing.toString() : '0');
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        removeStyles(PANEL_LAYOUT_STYLE_ID);
        this._unregisterButtonRow?.();
        this._unregisterButtonRow = null;
        document.querySelectorAll('.mwi-house-all-rooms').forEach((el) => el.remove());
        // Remove all MWI-added elements
        document
            .querySelectorAll('.mwi-house-pricing, .mwi-house-pricing-empty, .mwi-house-total, .mwi-house-to-level')
            .forEach((el) => el.remove());

        // Restore all grid columns
        document.querySelectorAll('[class*="HousePanel_itemRequirements"]').forEach((grid) => {
            grid.style.gridTemplateColumns = '';
        });

        // Clean up marketplace tabs and observer
        this.handleMarketplaceCleanup();
        if (this.cleanupObserver) {
            this.cleanupObserver();
            this.cleanupObserver = null;
        }

        // Remove inventory listener
        if (this._itemsUpdatedHandler) {
            dataManager.off('items_updated', this._itemsUpdatedHandler);
            this._itemsUpdatedHandler = null;
        }

        // Remove house room listener
        if (this._houseRoomsUpdatedHandler) {
            dataManager.off('house_rooms_updated', this._houseRoomsUpdatedHandler);
            this._houseRoomsUpdatedHandler = null;
        }

        this._cumulativeState = null;
        this._costContext = null;

        this.autofillManager.cleanup();
        this.timerRegistry.clearAll();

        this.currentModalContent = null;
        this.isActive = false;
        this.isInitialized = false;
    }
}

const houseCostDisplay = new HouseCostDisplay();
houseCostDisplay.setupSettingListener();

export default houseCostDisplay;
