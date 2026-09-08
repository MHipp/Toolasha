/**
 * Alchemy panel reader.
 *
 * Reads the open alchemy panel's item rows and turns them into priced inputs
 * and outputs, plus a fingerprint of the panel's visible state so the display
 * only recomputes when something the player can see has moved.
 *
 * This module reads; it does not calculate. Every profit figure the panel shows
 * comes from `alchemy-profit-calculator.js`, which works off game data rather
 * than off the DOM. This file once carried a second, DOM-derived model of the
 * same arithmetic — success rate, efficiency, action speed, rare/essence find,
 * tea duration — reached only through an `extractActionData()` that nothing had
 * called in a long time. Its efficiency stack keyed the level requirement off
 * the panel's notes text while the live calculator keys it off
 * `itemDetails.itemLevel`, so the two could not have agreed had anyone picked
 * it back up. It was deleted rather than left as a trap.
 */

import marketAPI from '../../api/marketplace.js';
import dataManager from '../../core/data-manager.js';
import { runningAction } from '../../utils/combat-actions.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { parseGameNumber } from '../../utils/number-parser.js';

class AlchemyProfit {
    /**
     * Get current alchemy action HRID
     * @returns {string|null} Action HRID or null
     */
    getCurrentActionHrid() {
        try {
            // Get current actions from dataManager
            const currentActions = dataManager.getCurrentActions();
            if (!currentActions || currentActions.length === 0) return null;

            // The running alchemy action, by execution order — the first alchemy
            // entry in array order can be one queued behind it, and the panel
            // would price that one instead
            const action = runningAction(currentActions, (a) => a.actionHrid?.startsWith('/actions/alchemy/'));
            return action?.actionHrid ?? null;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to get current action HRID:', error);
            return null;
        }
    }

    /**
     * Extract requirements (input materials) from the DOM
     * @returns {Promise<Array>} Array of requirement objects
     */
    async extractRequirements() {
        try {
            const elements = document.querySelectorAll(
                '[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"]'
            );
            const requirements = [];

            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const itemData = await this.extractItemData(el, true, i);
                if (itemData) {
                    requirements.push(itemData);
                }
            }

            return requirements;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract requirements:', error);
            return [];
        }
    }

    /**
     * Extract drops (outputs) from the DOM
     * @returns {Promise<Array>} Array of drop objects
     */
    async extractDrops(actionHrid) {
        try {
            const elements = document.querySelectorAll(
                '[class*="SkillActionDetail_dropTable"] [class*="Item_itemContainer"]'
            );
            const drops = [];

            // Get action details from game data for drop rates
            const gameData = dataManager.getInitClientData();
            const actionDetail = actionHrid && gameData ? gameData.actionDetailMap?.[actionHrid] : null;

            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const itemData = await this.extractItemData(el, false, i, actionDetail);
                if (itemData) {
                    drops.push(itemData);
                }
            }

            return drops;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract drops:', error);
            return [];
        }
    }

    /**
     * Calculate the cost to create an enhanced item
     * @param {string} itemHrid - Item HRID
     * @param {number} targetLevel - Target enhancement level
     * @param {string} priceType - 'ask' or 'bid'
     * @returns {number} Total cost to create the enhanced item
     */
    calculateEnhancementCost(itemHrid, targetLevel, priceType) {
        if (targetLevel === 0) {
            const priceData = marketAPI.getPrice(itemHrid, 0);
            return priceType === 'ask' ? priceData?.ask || 0 : priceData?.bid || 0;
        }

        const gameData = dataManager.getInitClientData();
        if (!gameData) return 0;

        const itemData = gameData.itemDetailMap?.[itemHrid];
        if (!itemData) return 0;

        // Start with base item cost
        const basePriceData = marketAPI.getPrice(itemHrid, 0);
        let totalCost = priceType === 'ask' ? basePriceData?.ask || 0 : basePriceData?.bid || 0;

        // Add enhancement material costs for each level
        const enhancementMaterials = itemData.enhancementCosts;
        if (!enhancementMaterials || !Array.isArray(enhancementMaterials)) {
            return totalCost;
        }

        // Enhance from level 0 to targetLevel
        for (let level = 0; level < targetLevel; level++) {
            for (const cost of enhancementMaterials) {
                const materialHrid = cost.itemHrid;
                const materialCount = cost.count || 0;

                if (materialHrid === '/items/coin') {
                    totalCost += materialCount; // Coins are 1:1
                } else {
                    const materialPrice = marketAPI.getPrice(materialHrid, 0);
                    const price = priceType === 'ask' ? materialPrice?.ask || 0 : materialPrice?.bid || 0;
                    totalCost += price * materialCount;
                }
            }
        }

        return totalCost;
    }

    /**
     * Extract item data (HRID, prices, count, drop rate) from DOM element
     * @param {HTMLElement} element - Item container element
     * @param {boolean} isRequirement - True if this is a requirement (has count), false if drop (has drop rate)
     * @param {number} index - Index in the list (for extracting count/rate text)
     * @returns {Promise<Object|null>} Item data object or null
     */
    async extractItemData(element, isRequirement, index, actionDetail = null) {
        try {
            // Get item HRID from SVG use element
            const use = element.querySelector('svg use');
            if (!use) return null;

            const href = use.getAttribute('href');
            if (!href) return null;

            const itemId = href.split('#')[1];
            if (!itemId) return null;

            const itemHrid = `/items/${itemId}`;

            // Get enhancement level
            let enhancementLevel = 0;
            if (isRequirement) {
                const enhEl = element.querySelector('[class*="Item_enhancementLevel"]');
                if (enhEl) {
                    const match = enhEl.textContent.match(/\+(\d+)/);
                    enhancementLevel = match ? parseInt(match[1]) : 0;
                }
            }

            // Get market prices
            let ask = 0,
                bid = 0;
            if (itemHrid === '/items/coin') {
                ask = bid = 1;
            } else {
                // Check if this is an openable container (loot crate)
                const itemDetails = dataManager.getItemDetails(itemHrid);
                if (itemDetails?.isOpenable) {
                    // Use expected value calculator for openable containers
                    const containerValue = expectedValueCalculator.getCachedValue(itemHrid);
                    if (containerValue !== null && containerValue > 0) {
                        ask = bid = containerValue;
                    } else {
                        // Fallback to marketplace if EV not available
                        const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
                        ask = priceData?.ask || 0;
                        bid = priceData?.bid || 0;
                    }
                } else {
                    // Regular item - use marketplace price
                    const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
                    if (priceData && (priceData.ask > 0 || priceData.bid > 0)) {
                        // Market data exists for this specific enhancement level
                        ask = priceData.ask || 0;
                        bid = priceData.bid || 0;
                    } else {
                        // No market data for this enhancement level - calculate cost
                        ask = this.calculateEnhancementCost(itemHrid, enhancementLevel, 'ask');
                        bid = this.calculateEnhancementCost(itemHrid, enhancementLevel, 'bid');
                    }
                }
            }

            const result = { itemHrid, ask, bid, enhancementLevel };

            // Get count or drop rate
            if (isRequirement && index >= 0) {
                // Extract count from requirement
                const countElements = document.querySelectorAll(
                    '[class*="SkillActionDetail_itemRequirements"] [class*="SkillActionDetail_inputCount"]'
                );

                if (countElements[index]) {
                    const text = countElements[index].textContent.trim();
                    // Extract number after the "/" character (format: "/ 2" or "/ 450")
                    const match = text.match(/\/\s*([\d,]+)/);
                    let parsedCount = 1;

                    if (match) {
                        parsedCount = parseGameNumber(match[1]);
                    }

                    result.count = parsedCount || 1;
                } else {
                    result.count = 1;
                }
            } else if (!isRequirement) {
                // Extract count and drop rate from action detail (game data) or DOM fallback
                let dropRateFromGameData = null;

                // Try to get drop rate from game data first
                if (actionDetail && actionDetail.dropTable) {
                    const dropEntry = actionDetail.dropTable.find((drop) => drop.itemHrid === itemHrid);
                    if (dropEntry) {
                        dropRateFromGameData = dropEntry.dropRate;
                    }
                }

                // Extract count from DOM
                const dropElements = document.querySelectorAll(
                    '[class*="SkillActionDetail_drop"], [class*="SkillActionDetail_essence"], [class*="SkillActionDetail_rare"]'
                );

                for (const dropElement of dropElements) {
                    // Check if this drop element contains our item
                    const dropItemElement = dropElement.querySelector('[class*="Item_itemContainer"] svg use');
                    if (dropItemElement) {
                        const dropHref = dropItemElement.getAttribute('href');
                        const dropItemId = dropHref ? dropHref.split('#')[1] : null;
                        const dropItemHrid = dropItemId ? `/items/${dropItemId}` : null;

                        if (dropItemHrid === itemHrid) {
                            // Found the matching drop element
                            const text = dropElement.textContent.trim();

                            // Extract count (at start of text)
                            const countMatch = text.match(/^([\d\s,.]+)/);
                            if (countMatch) {
                                result.count = parseGameNumber(countMatch[1]) || 1;
                            } else {
                                result.count = 1;
                            }

                            // Use drop rate from game data if available, otherwise try DOM
                            if (dropRateFromGameData !== null) {
                                result.dropRate = dropRateFromGameData;
                            } else {
                                // Extract drop rate percentage from DOM (handles both "7.29%" and "~7.29%")
                                const rateMatch = text.match(/~?([\d,.]+)%/);
                                if (rateMatch) {
                                    result.dropRate = parseGameNumber(rateMatch[1]) / 100 || 1;
                                } else {
                                    result.dropRate = 1;
                                }
                            }

                            break; // Found it, stop searching
                        }
                    }
                }

                // If we didn't find a matching drop element, set defaults
                if (result.count === undefined) {
                    result.count = 1;
                }
                if (result.dropRate === undefined) {
                    // Use game data drop rate if available, otherwise default to 1
                    result.dropRate = dropRateFromGameData !== null ? dropRateFromGameData : 1;
                }
            }

            return result;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract item data:', error);
            return null;
        }
    }

    /**
     * Generate state fingerprint for change detection
     * @returns {string} Fingerprint string
     */
    getStateFingerprint() {
        try {
            const successRate =
                document.querySelector('[class*="SkillActionDetail_successRate"] [class*="SkillActionDetail_value"]')
                    ?.textContent || '';
            const consumables = Array.from(
                document.querySelectorAll(
                    '[class*="ActionTypeConsumableSlots_consumableSlots"] [class*="Item_itemContainer"]'
                )
            )
                .map((el) => el.querySelector('svg use')?.getAttribute('href') || 'empty')
                .join('|');

            // Get catalyst (from the catalyst input container)
            // Use Item_itemContainer to avoid the info icon's use[href]; item icons use xlink:href
            const catalystUse = document.querySelector(
                '[class*="SkillActionDetail_catalystItemInputContainer"] [class*="Item_itemContainer"] svg use'
            );
            const catalyst = catalystUse?.getAttribute('xlink:href') || catalystUse?.getAttribute('href') || 'none';

            // Get requirements (input materials)
            const requirements = Array.from(
                document.querySelectorAll('[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"]')
            )
                .map((el) => {
                    const href = el.querySelector('svg use')?.getAttribute('href') || 'empty';
                    const enh = el.querySelector('[class*="Item_enhancementLevel"]')?.textContent || '0';
                    return `${href}${enh}`;
                })
                .join('|');

            // Get selected alchemy tab (Coinify/Decompose/Transmute/etc)
            const alchemyContainer = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
            const selectedTab =
                alchemyContainer?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() || '';

            // Don't include infoText - it contains our profit display which causes update loops
            return `${selectedTab}:${successRate}:${consumables}:${catalyst}:${requirements}`;
        } catch {
            return '';
        }
    }
}

const alchemyProfit = new AlchemyProfit();

export default alchemyProfit;
