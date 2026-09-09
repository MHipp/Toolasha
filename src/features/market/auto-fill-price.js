/**
 * Auto-Fill Market Price
 * Automatically fills marketplace order forms with optimal competitive pricing
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { parseItemCount } from '../../utils/number-parser.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { tradableRangeFrom, clampToRange } from '../../utils/tradable-range.js';

/**
 * Re-exported from `utils/tradable-range.js`, where the band lives now so the
 * buy-modal autofill (a util reached by every feature bundle) can honour the
 * same one without importing this feature module.
 */
export { tradableRangeFrom, clampToRange };

class AutoFillPrice {
    constructor() {
        this.isActive = false;
        this.unregisterHandlers = [];
        this.processedModals = new WeakSet(); // Track processed modals to prevent duplicates
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Initialize auto-fill price feature
     */
    initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('fillMarketOrderPrice')) {
            return;
        }

        this.isInitialized = true;

        // Register DOM observer for marketplace order modals
        this.registerDOMObservers();

        this.isActive = true;
    }

    /**
     * Register DOM observers for order modals
     */
    registerDOMObservers() {
        // Watch for order modals appearing
        const unregister = domObserver.onClass('auto-fill-price', 'Modal_modalContainer', (modal) => {
            // Check if this is a marketplace order modal (not instant buy/sell)
            const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
            if (!header) return;

            const headerText = header.textContent.trim();

            // Skip instant buy/sell modals (contain "Now" in title)
            if (headerText.includes(' Now')) {
                return;
            }

            // Handle the order modal
            this.handleOrderModal(modal);
        });

        this.unregisterHandlers.push(unregister);
    }

    /**
     * Handle new order modal
     * @param {HTMLElement} modal - Modal container element
     */
    handleOrderModal(modal) {
        // Prevent duplicate processing (dom-observer can fire multiple times for same modal)
        //
        // Marked only once the work has actually happened. The observer can fire
        // on a modal React has committed the shell of but not yet the controls,
        // and marking on entry spent the one shot on that fire — every later
        // fire, including the one that would have worked, was then refused and
        // the price was never filled.
        if (this.processedModals.has(modal)) {
            return;
        }

        // Find the "Best Price" button/label
        const bestPriceLabel = modal.querySelector('span[class*="MarketplacePanel_bestPrice"]');
        if (!bestPriceLabel) {
            return;
        }

        // Determine if this is a buy or sell order
        const labelParent = bestPriceLabel.parentElement;
        const labelText = labelParent.textContent.toLowerCase();

        const isBuyOrder = labelText.includes('best buy');
        const isSellOrder = labelText.includes('best sell');

        if (!isBuyOrder && !isSellOrder) {
            return;
        }

        // Click the best price label to populate the suggested price
        this.processedModals.add(modal);
        bestPriceLabel.click();

        // Adjust price after clicking to be optimally competitive
        // For buy orders: increment by 1 to outbid
        // For sell orders: depends on user setting (match or undercut)
        const adjustTimeout = setTimeout(() => {
            this.adjustPrice(modal, isBuyOrder, isSellOrder);
        }, 50);
        this.timerRegistry.registerTimeout(adjustTimeout);

        // Once the strategy click has settled, pull a price the band no longer
        // admits back inside it — matching a stale offer under the floor fills
        // a listing nobody can trade against
        const clampTimeout = setTimeout(() => {
            this.clampPriceToTradableRange(modal);
        }, 150);
        this.timerRegistry.registerTimeout(clampTimeout);

        this.watchPriceBand(modal);
    }

    /**
     * Keep the clamp live for the modal's lifetime, not just the opening fill.
     *
     * The range and best offer both re-render inside the open modal — changing
     * the enhancement level swaps in a different item's band, and a best-price
     * click refills the input — so a one-shot clamp at open leaves a later fill
     * sitting outside the band (a buy at a stale best offer under the floor).
     * The input is left alone while it holds focus: a price being typed passes
     * through below-the-floor prefixes that are not the price.
     * @param {HTMLElement} modal - Modal container element
     */
    watchPriceBand(modal) {
        const interval = setInterval(() => {
            if (!modal.isConnected) {
                clearInterval(interval);
                return;
            }
            const input = modal.querySelector(
                'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"] input'
            );
            if (!input || document.activeElement === input) return;
            this.clampPriceToTradableRange(modal);
        }, 300);
        this.timerRegistry.registerInterval(interval);
    }

    /**
     * Adjust the price to be optimally competitive
     * @param {HTMLElement} modal - Modal container element
     * @param {boolean} isBuyOrder - True if buy order
     * @param {boolean} isSellOrder - True if sell order
     */
    adjustPrice(modal, isBuyOrder, isSellOrder) {
        // Find the price input container
        const inputContainer = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"]'
        );
        if (!inputContainer) {
            return;
        }

        // Find the increment/decrement buttons
        const buttonContainers = inputContainer.querySelectorAll('div[class*="MarketplacePanel_buttonContainer"]');

        if (buttonContainers.length < 3) {
            return;
        }

        if (isBuyOrder) {
            const buyStrategy = config.getSettingValue('market_autoFillBuyStrategy', 'outbid');

            if (buyStrategy === 'outbid') {
                // Click the 3rd button container's button (increment)
                const button = buttonContainers[2].querySelector('div button');
                if (button) button.click();
            } else if (buyStrategy === 'undercut') {
                // Click the 2nd button container's button (decrement)
                const button = buttonContainers[1].querySelector('div button');
                if (button) button.click();
            }
            // If 'match', do nothing (use best buy price as-is)
        } else if (isSellOrder) {
            const sellStrategy = config.getSettingValue('market_autoFillSellStrategy', 'match');

            if (sellStrategy === 'undercut') {
                // Click the 2nd button container's button (decrement)
                const button = buttonContainers[1].querySelector('div button');
                if (button) button.click();
            }
            // If 'match', do nothing (use best sell price as-is)
        }
    }

    /**
     * Rewrite the filled price to the nearest bound of the modal's tradable
     * range when it landed outside it. Modals stating no range (or in a locale
     * whose wording differs) are left exactly as filled.
     * @param {HTMLElement} modal - Modal container element
     */
    clampPriceToTradableRange(modal) {
        const range = tradableRangeFrom(modal.textContent);
        if (!range) return;

        const input = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"] input'
        );
        if (!input) return;

        const price = parseItemCount(input.value, NaN);
        if (!Number.isFinite(price)) return;

        const clamped = clampToRange(price, range);
        if (clamped !== price) {
            setReactInputValue(input, String(clamped));
        }
    }

    /**
     * Cleanup on disable
     */
    disable() {
        try {
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Auto Fill Price] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const autoFillPrice = new AutoFillPrice();

export default autoFillPrice;
