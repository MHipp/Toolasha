/**
 * Ability Book Calculator
 * Shows number of books needed to reach target ability level
 * Appears in Item Dictionary when viewing ability books
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { numberFormatter, formatKMB } from '../../utils/formatters.js';
import dom from '../../utils/dom.js';
import domObserver from '../../core/dom-observer.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { booksToLevel } from '../../utils/ability-books.js';
import { testerShopEnabled, testerShopCoinCost } from '../../utils/tester-shop.js';
import { openTesterShopPage, setShopFilter } from '../../utils/tester-shop-nav.js';

/**
 * AbilityBookCalculator class handles ability book calculations in Item Dictionary
 */
class AbilityBookCalculator {
    constructor() {
        this.unregisterObserver = null; // Unregister function from centralized observer
        this.isActive = false;
        this.isInitialized = false;
        this.autofillManager = createAutofillManager('AbilityBookCalculator');
    }

    /**
     * Setup settings listeners for feature toggle and color changes
     */
    setupSettingListener() {
        config.onSettingChange('skillbook', (value) => {
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
     * Initialize the ability book calculator
     */
    initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('skillbook')) {
            return;
        }

        this.isInitialized = true;

        this.autofillManager.initialize();

        // Register with centralized observer to watch for Item Dictionary modal
        this.unregisterObserver = domObserver.onClass(
            'AbilityBookCalculator',
            'ItemDictionary_modalContent__WvEBY',
            (dictContent) => {
                this.handleItemDictionary(dictContent);
            }
        );

        this.isActive = true;
    }

    /**
     * Handle Item Dictionary modal
     * @param {Element} panel - Item Dictionary content element
     */
    async handleItemDictionary(panel) {
        try {
            // Extract ability HRID from modal title
            const abilityHrid = this.extractAbilityHrid(panel);
            if (!abilityHrid) {
                return; // Not an ability book
            }

            // Get ability book data
            const itemHrid = abilityHrid.replace('/abilities/', '/items/');
            const gameData = dataManager.getInitClientData();
            if (!gameData) return;

            const itemDetails = gameData.itemDetailMap[itemHrid];
            if (!itemDetails?.abilityBookDetail) {
                return; // Not an ability book
            }

            const xpPerBook = itemDetails.abilityBookDetail.experienceGain;

            // Get current ability level and XP
            const abilityData = this.getCurrentAbilityData(abilityHrid);

            // Inject calculator UI
            this.injectCalculator(panel, abilityData, xpPerBook, itemHrid);
        } catch (error) {
            console.error('[AbilityBookCalculator] Error handling dictionary:', error);
        }
    }

    /**
     * Extract ability HRID from modal title
     * @param {Element} panel - Item Dictionary content element
     * @returns {string|null} Ability HRID or null
     */
    extractAbilityHrid(panel) {
        const titleElement = panel.querySelector('h1.ItemDictionary_title__27cTd');
        if (!titleElement) return null;

        // Get the item name from title
        const itemName = titleElement.textContent.trim().toLowerCase().replaceAll(' ', '_').replaceAll("'", '');

        // Look up ability HRID from name
        const gameData = dataManager.getInitClientData();
        if (!gameData) return null;

        for (const abilityHrid of Object.keys(gameData.abilityDetailMap)) {
            if (abilityHrid.includes('/' + itemName)) {
                return abilityHrid;
            }
        }

        return null;
    }

    /**
     * Get current ability level and XP from character data
     * @param {string} abilityHrid - Ability HRID
     * @returns {Object} {level, xp}
     */
    getCurrentAbilityData(abilityHrid) {
        // Get character abilities from live character data (NOT static game data)
        const characterData = dataManager.characterData;
        if (!characterData?.characterAbilities) {
            return { level: 0, xp: 0 };
        }

        // characterAbilities is an ARRAY of ability objects
        const ability = characterData.characterAbilities.find((a) => a.abilityHrid === abilityHrid);
        if (ability) {
            return {
                level: ability.level || 0,
                xp: ability.experience || 0,
            };
        }

        return { level: 0, xp: 0 };
    }

    /**
     * Calculate books needed to reach target level
     * @param {number} currentLevel - Current ability level
     * @param {number} currentXp - Current ability XP
     * @param {number} targetLevel - Target ability level
     * @param {number} xpPerBook - XP gained per book
     * @returns {number|null} Number of books needed, or null when the target level
     *   is beyond what the game's experience table describes (past the level 200
     *   cap) — distinct from needing zero books, which means "already there"
     */
    calculateBooksNeeded(currentLevel, currentXp, targetLevel, xpPerBook) {
        // The same arithmetic the Watchlist-era book panel uses, in one place:
        // two copies of "and one more book if the ability is unlearned" is two
        // places for it to go missing
        const table = dataManager.getInitClientData()?.levelExperienceTable;
        return booksToLevel({
            level: currentLevel,
            experience: currentXp,
            targetLevel,
            perBookExperience: xpPerBook,
            table,
        });
    }

    /**
     * Inject calculator UI into Item Dictionary modal
     * @param {Element} panel - Item Dictionary content element
     * @param {Object} abilityData - {level, xp}
     * @param {number} xpPerBook - XP per book
     * @param {string} itemHrid - Item HRID for market prices
     */
    async injectCalculator(panel, abilityData, xpPerBook, itemHrid) {
        // Check if already injected
        if (panel.querySelector('.tillLevel')) {
            return;
        }

        const { level: currentLevel, xp: currentXp } = abilityData;
        // 200 is the level cap: an ability already there has no "next level" to
        // buy towards, and the arithmetic below returns null for it (the
        // experience table has nothing past 200) rather than a books count
        const atMaxLevel = currentLevel >= 200;
        const targetLevel = currentLevel + 1;

        // Calculate initial books needed
        const booksNeeded = atMaxLevel
            ? null
            : this.calculateBooksNeeded(currentLevel, currentXp, targetLevel, xpPerBook);

        // Get market prices
        const prices = marketAPI.getPrice(itemHrid, 0);
        const marketAsk = prices?.ask || 0;
        const marketBid = prices?.bid || 0;

        // The Tester shop as a buy-side floor, the same shape `resolveItemPrice`
        // uses: the shop replaces a price only when it is strictly cheaper, and
        // only when there is no quote at all does it stand in for a missing one.
        // Both columns here are buy-side — the ask is buying now, the bid is
        // buying by waiting — so both take the floor. Taking it on the ask alone
        // would leave a bid above the shop price reading as the cheap way to buy
        // a book you can walk in and buy for less.
        const shopCost = testerShopEnabled() ? testerShopCoinCost(itemHrid) : 0;
        const floors = (price) => shopCost > 0 && (!(price > 0) || shopCost < price);
        const askFloored = floors(marketAsk);
        const bidFloored = floors(marketBid);
        const ask = askFloored ? shopCost : marketAsk;
        const bid = bidFloored ? shopCost : marketBid;
        // Where the buy button goes. Sold in the shop and priced against it is
        // the whole condition: `shopCost` is already 0 when the setting is off
        const useTesterShop = shopCost > 0;
        const itemName = dataManager.getItemDetails?.(itemHrid)?.name || '';

        /**
         * The cost line for a book count, naming which price each figure is —
         * a shop-floored figure is not a market quote and must not read as one.
         * @param {number} books - Books needed
         * @returns {string}
         */
        const costLine = (books) => {
            const askText = formatKMB(Math.ceil(books * ask));
            const bidText = formatKMB(Math.ceil(books * bid));
            if (askFloored && bidFloored) return `Cost: ${askText} (Tester shop)`;
            const labels = `${askFloored ? 'shop' : 'ask'} / ${bidFloored ? 'shop' : 'bid'}`;
            return `Cost: ${askText} / ${bidText} (${labels})`;
        };

        // Create calculator HTML
        const calculatorDiv = dom.createStyledDiv(
            {
                color: config.COLOR_ACCENT,
                textAlign: 'left',
                marginTop: '16px',
                padding: '12px',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
            },
            '',
            'tillLevel'
        );

        // At the cap there is nothing to aim an input at — min would be 201
        // against a max of 200, and a coerced-to-zero books count would read
        // as "buy nothing" rather than "cannot go further"
        calculatorDiv.innerHTML = atMaxLevel
            ? `
            <div style="font-size: 0.95em;">
                <strong>Current level:</strong> ${currentLevel} (max)
            </div>
            <div id="tillLevelNumber" style="font-size: 0.95em; margin-top: 8px;">
                Already at the level cap — nothing more to buy.
            </div>
        `
            : `
            <div style="margin-bottom: 8px; font-size: 0.95em;">
                <strong>Current level:</strong> ${currentLevel}
            </div>
            <div style="margin-bottom: 8px;">
                <label for="tillLevelInput">To level: </label>
                <input
                    id="tillLevelInput"
                    type="number"
                    value="${targetLevel}"
                    min="${currentLevel + 1}"
                    max="200"
                    style="width: 60px; padding: 4px; background: #2a2a2a; color: white; border: 1px solid #555; border-radius: 3px;"
                >
            </div>
            <div id="tillLevelNumber" style="font-size: 0.95em;">
                Books needed: <strong>${numberFormatter(booksNeeded)}</strong>
                <br>
                ${costLine(booksNeeded)}
            </div>
            <div style="font-size: 0.85em; color: #999; margin-top: 8px; font-style: italic;">
                Refresh page to update current level
            </div>
        `;

        // Add event listeners for input changes
        const input = calculatorDiv.querySelector('#tillLevelInput');
        const display = calculatorDiv.querySelector('#tillLevelNumber');

        let currentBooks = booksNeeded;

        const updateDisplay = () => {
            const target = parseInt(input.value);

            if (target > currentLevel && target <= 200) {
                const books = this.calculateBooksNeeded(currentLevel, currentXp, target, xpPerBook);
                currentBooks = books;
                display.innerHTML = `
                    Books needed: <strong>${numberFormatter(books)}</strong>
                    <br>
                    ${costLine(books)}
                `;
            } else {
                currentBooks = 0;
                display.innerHTML = `<span style="color: ${config.COLOR_LOSS};">Invalid target level</span>`;
            }
        };

        if (input) {
            input.addEventListener('change', updateDisplay);
            input.addEventListener('keyup', updateDisplay);
        }

        // Buy on Marketplace button
        const buyButton = document.createElement('button');
        buyButton.textContent = useTesterShop ? 'Buy in Tester shop' : 'Buy on Marketplace';
        buyButton.style.cssText = `
            margin-top: 8px;
            padding: 4px 10px;
            font-size: 0.85em;
            background: #2a2a2a;
            color: white;
            border: 1px solid #555;
            border-radius: 3px;
            cursor: pointer;
        `;
        buyButton.addEventListener('click', async () => {
            if (!(currentBooks > 0)) return;
            const quantity = Math.ceil(currentBooks);
            if (useTesterShop) {
                const testerTab = await openTesterShopPage();
                if (testerTab) {
                    // Filter and arm only after the tab is selected: selecting a
                    // shop tab is what clears an armed quantity. Nothing here
                    // opens the item's card or presses Buy — the player does
                    setShopFilter(itemName);
                    this.autofillManager.setPendingCalculation(() => quantity, { itemHrid });
                    return;
                }
                // The shop could not be reached; the marketplace still sells books
            }
            this.autofillManager.setQuantity(quantity, { itemHrid });
            navigateToMarketplace(itemHrid);
        });
        calculatorDiv.appendChild(buyButton);

        // Try to find the left column by looking for the modal's main content structure
        // The Item Dictionary modal typically has its content in direct children of the panel
        const directChildren = Array.from(panel.children);

        // Look for a container that has exactly 2 children (two-column layout)
        for (const child of directChildren) {
            const grandchildren = Array.from(child.children).filter((c) => {
                // Filter for visible elements that look like content columns
                const style = window.getComputedStyle(c);
                return style.display !== 'none' && c.offsetHeight > 50; // At least 50px tall
            });

            if (grandchildren.length === 2) {
                // Found the two-column container! Use the left column (first child)
                const leftColumn = grandchildren[0];
                leftColumn.appendChild(calculatorDiv);
                return;
            }
        }

        // Fallback: append to panel bottom (original behavior)
        panel.appendChild(calculatorDiv);
    }

    /**
     * Refresh colors on existing calculator displays
     */
    refresh() {
        // Update all .tillLevel elements
        document.querySelectorAll('.tillLevel').forEach((calc) => {
            calc.style.color = config.COLOR_ACCENT;
        });
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this.autofillManager.cleanup();
            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Ability Book Calculator] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const abilityBookCalculator = new AbilityBookCalculator();
abilityBookCalculator.setupSettingListener();

export default abilityBookCalculator;
