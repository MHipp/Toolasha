/**
 * Auto-Fill Market Price
 * Automatically fills marketplace order forms with optimal competitive pricing
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { parseItemCount } from '../../utils/number-parser.js';
import { tradableRangeFrom, clampToRange } from '../../utils/tradable-range.js';

/**
 * Re-exported from `utils/tradable-range.js`, where the band lives now so the
 * buy-modal autofill (a util reached by every feature bundle) can honour the
 * same one without importing this feature module.
 */
export { tradableRangeFrom, clampToRange };

/**
 * A marketplace price row's own bound/step controls, found by position
 * rather than by button label (the game is localised — "最低", "最高", not
 * "Min"/"Max") or by array index. `marketplace-shortcuts.js` splices its own
 * ÷2/×2 buttons onto either end of this same row, as containers carrying the
 * game's own button-container class plus `mwi-mp-multiplier`, so an
 * index-based pick shifts by one the moment those exist.
 *
 * Row layout, left to right: `[Min] - <input|priceDisplay> + [Max]`. Min and
 * Max exist only when the modal states a tradable range for the item.
 *
 * @param {HTMLElement} row - The `MarketplacePanel_priceInputs` row
 * @returns {{dec: HTMLButtonElement|null, inc: HTMLButtonElement|null, min: HTMLButtonElement|null, max: HTMLButtonElement|null}|null}
 *   The row's controls, or null when the row has no recognizable center cell
 */
function priceRowControls(row) {
    if (!row) return null;

    const center = row.querySelector(
        'div[class*="MarketplacePanel_input"]:not([class*="buttonContainer"]):not([class*="priceInputs"]):not([class*="inputContainer"])'
    );
    if (!center) return null;

    // The row's own controls, in DOM order, with the shortcuts feature's
    // ÷2/×2 wrappers filtered out regardless of which end they landed on.
    const ordered = Array.from(row.children).filter(
        (el) =>
            el === center ||
            (el.matches('div[class*="MarketplacePanel_buttonContainer"]') &&
                !el.classList.contains('mwi-mp-multiplier'))
    );
    const centerIndex = ordered.indexOf(center);
    if (centerIndex === -1) return null;

    const buttonOf = (el) => el?.querySelector('button') || null;
    return {
        dec: buttonOf(ordered[centerIndex - 1]),
        inc: buttonOf(ordered[centerIndex + 1]),
        min: buttonOf(ordered[centerIndex - 2]),
        max: buttonOf(ordered[centerIndex + 2]),
    };
}

class AutoFillPrice {
    constructor() {
        this.isActive = false;
        this.unregisterHandlers = [];
        this.processedModals = new WeakSet(); // Track processed modals to prevent duplicates
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
        // Per-modal: the out-of-range price the last bound-press produced, so
        // a game bound that is itself outside a range parsed from rounded
        // text ("77.8M" ceiling, exact button target 77,84x,xxx) is not
        // pressed again on every 300ms tick. See clampPriceToTradableRange.
        this.clampState = new WeakMap();
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
                this.clampState.delete(modal);
                return;
            }
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
        const row = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"]'
        );
        if (!row) {
            return;
        }

        const controls = priceRowControls(row);
        if (!controls) {
            return;
        }

        if (isBuyOrder) {
            const buyStrategy = config.getSettingValue('market_autoFillBuyStrategy', 'outbid');

            if (buyStrategy === 'outbid') {
                controls.inc?.click();
            } else if (buyStrategy === 'undercut') {
                controls.dec?.click();
            }
            // If 'match', do nothing (use best buy price as-is)
        } else if (isSellOrder) {
            const sellStrategy = config.getSettingValue('market_autoFillSellStrategy', 'match');

            if (sellStrategy === 'undercut') {
                controls.dec?.click();
            }
            // If 'match', do nothing (use best sell price as-is)
        }
    }

    /**
     * Pull the filled price back to the nearest bound of the modal's tradable
     * range when it landed outside it, by pressing the game's own Min/Max
     * button rather than writing the field directly. The row usually has no
     * `<input>` to write at all — the price renders as plain text until the
     * player clicks into it — and the game's own button commits its own
     * exact, binned bound through its own state either way, editing or not.
     * Modals stating no range (or in a locale whose wording differs) are left
     * exactly as filled.
     *
     * A price being typed is left alone: the input is read only when it is
     * not focused. And a bound already pressed is not pressed again while the
     * price still reads as what that press produced — the range is parsed
     * from rounded text ("77.8M"), while the game's own exact bound can be
     * e.g. 77,84x,xxx, which still reads "above 77.8M" forever if every tick
     * presses Max again.
     * @param {HTMLElement} modal - Modal container element
     */
    clampPriceToTradableRange(modal) {
        const range = tradableRangeFrom(modal.textContent);
        if (!range) return;

        const row = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"]'
        );
        if (!row) return;

        const input = row.querySelector('input');
        if (input && document.activeElement === input) return;

        const price = input
            ? parseItemCount(input.value, NaN)
            : parseItemCount(row.querySelector('div[class*="MarketplacePanel_priceDisplay"]')?.textContent, NaN);
        if (!Number.isFinite(price)) return;

        if (clampToRange(price, range) === price) {
            // Back in range: a later excursion is a fresh event, not a repeat.
            this.clampState.delete(modal);
            return;
        }

        const state = this.clampState.get(modal);

        if (state?.armed) {
            // The tick right after a bound press: this is the price it produced.
            this.clampState.set(modal, { armed: false, lastActedPrice: price });
            return;
        }

        if (state && state.lastActedPrice === price) {
            return;
        }

        const controls = priceRowControls(row);
        const button = price < range.min ? controls?.min : controls?.max;
        if (!button) return;

        button.click();
        this.clampState.set(modal, { armed: true, lastActedPrice: state?.lastActedPrice });
    }

    /**
     * Cleanup on disable
     */
    disable() {
        try {
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.clampState = new WeakMap();
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
