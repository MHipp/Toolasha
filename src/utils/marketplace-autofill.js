/**
 * Marketplace Buy Modal Autofill Utility
 * Provides shared functionality for auto-filling quantity in marketplace buy modals
 * Used by missing materials features (actions, houses, etc.)
 */

import domObserver from '../core/dom-observer.js';
import { setReactInputValue } from './react-input.js';

/**
 * Find the quantity input in the buy modal
 * For equipment items, there are multiple number inputs (enhancement level + quantity)
 * We need to find the correct one by checking parent containers for label text
 * @param {HTMLElement} modal - Modal container element
 * @returns {HTMLInputElement|null} Quantity input element or null
 */
export function findQuantityInput(modal) {
    // The game's own quantity row settles it, and is the reliable path since the
    // 8/13/2026 marketplace update made the price and quantity fields typable —
    // they are `type="text"` now, so the old `input[type="number"]` selector
    // below matched nothing and the quantity stopped being filled.
    const rowInput = modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input');
    if (rowInput) {
        return rowInput;
    }

    // Fallback: read every input (any type — the fields are text now), and tell
    // the quantity box from the enhancement-level box by its surrounding label.
    const allInputs = Array.from(modal.querySelectorAll('input'));

    if (allInputs.length === 0) {
        return null;
    }

    if (allInputs.length === 1) {
        // Only one input - must be quantity
        return allInputs[0];
    }

    // Multiple inputs - identify by checking CLOSEST parent first
    // Strategy 1: Check each parent level individually, prioritizing closer parents
    // This prevents matching on the outermost container that has all text
    for (let level = 0; level < 4; level++) {
        for (let i = 0; i < allInputs.length; i++) {
            const input = allInputs[i];
            let parent = input.parentElement;

            // Navigate to the specific level
            for (let j = 0; j < level && parent; j++) {
                parent = parent.parentElement;
            }

            if (!parent) continue;

            const text = parent.textContent;

            // At this specific level, check if it contains "Quantity" but NOT "Enhancement Level"
            if (text.includes('Quantity') && !text.includes('Enhancement Level')) {
                return input;
            }
        }
    }

    // Strategy 2: Exclude inputs that have "Enhancement Level" in close parents (level 0-2)
    for (let i = 0; i < allInputs.length; i++) {
        const input = allInputs[i];
        let parent = input.parentElement;
        let isEnhancementInput = false;

        // Check only the first 3 levels (not the outermost container)
        for (let j = 0; j < 3 && parent; j++) {
            const text = parent.textContent;

            if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                isEnhancementInput = true;
                break;
            }

            parent = parent.parentElement;
        }

        if (!isEnhancementInput) {
            return input;
        }
    }

    // Nothing identified it, so nothing is filled.
    //
    // The old ending here returned `allInputs[0]`, which is the worst available
    // guess rather than a neutral one: this line is only reached when strategy 2
    // rejected *every* input as an enhancement-level field, so the first input is
    // the field the walk was trying hardest to avoid. Writing a material count
    // into it and then pressing Buy — which `buyOneMissingMaterial` does — orders
    // one item at enhancement level N instead of N items at the level asked for.
    //
    // Both callers already treat null as "this modal cannot be filled" and say so
    // ("no quantity box"), so refusing costs a keystroke and telling the player
    // why, where guessing costs a wrong order.
    console.warn('[MarketplaceAutofill] Could not identify the quantity input; leaving the modal alone');
    return null;
}

/**
 * Whether a modal is the Shop's buy dialog: a Quantity field, a "You Pay"
 * line and a Buy button, and nothing about selling.
 * @param {HTMLElement} modal - Modal container element
 * @returns {boolean}
 */
export function isShopBuyModal(modal) {
    const text = String(modal?.textContent || '');
    if (!/quantity/i.test(text) || !/you pay/i.test(text)) return false;
    if (/sell/i.test(text)) return false;
    return Array.from(modal.querySelectorAll('button')).some((button) => /^\s*buy\s*$/i.test(button.textContent || ''));
}

/**
 * The item a buy modal is about, read off the icon it draws.
 *
 * The modal names its item nowhere in text — the icon's `<use href="…#slug">`
 * is the only handle on it, and it is the same one the buy-modal "Owned: N"
 * line resolves the item by.
 *
 * Only an *item* sprite counts. A modal draws other `<use>` icons too — an info
 * badge, a coin, a close × — and the first one in document order need not be
 * the item's. Reading one of those yielded a confident `/items/<icon-name>`
 * that matched no arming, which retired the arming and left the quantity
 * unfilled. The item's own icon is identified the way the rest of the codebase
 * identifies one: inside an `Item_itemContainer`, or drawn from the items
 * sprite sheet. Anything else reads as "this modal names no item" (null), which
 * leaves the header checks to decide, exactly as a modal with no icon does.
 *
 * @param {HTMLElement} modal - Modal container element
 * @returns {string|null} Item HRID, or null when the modal draws no item icon
 */
export function modalItemHrid(modal) {
    const useEl =
        modal?.querySelector?.(
            '[class*="Item_itemContainer"] svg use[href], [class*="Item_itemContainer"] svg use[xlink\\:href]'
        ) || modal?.querySelector?.('svg use[href*="items_sprite"], svg use[xlink\\:href*="items_sprite"]');
    if (!useEl) return null;
    const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
    const slug = href && href.match(/#(.+)$/)?.[1];
    return slug ? `/items/${slug}` : null;
}

/**
 * Handle buy modal appearance and auto-fill quantity if available
 * @param {HTMLElement} modal - Modal container element
 * @param {number|null} activeQuantity - Static quantity to auto-fill (null if using pending fn)
 * @param {Function|null} pendingCalculation - Lazy fn that returns current quantity (takes priority)
 */
function handleBuyModal(modal, activeQuantity, pendingCalculation) {
    // Resolve quantity: prefer lazy recalculation over stored static value
    const quantity = pendingCalculation ? pendingCalculation() : activeQuantity;

    // Check if we have a quantity to fill
    if (!quantity || quantity <= 0) {
        return false;
    }

    // Check if this is a "Buy Now" modal — or the Shop's own buy modal, which
    // has no marketplace header: an item name, a Quantity box, "You Pay" and a
    // Buy button. The test server's Tester shop is bought through it
    const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
    if (header) {
        const headerText = header.textContent.trim();
        if (!headerText.includes('Buy Now') && !headerText.includes('Buy Listing')) {
            return false;
        }
    } else if (!isShopBuyModal(modal)) {
        return false;
    }

    // Find the quantity input - need to be specific to avoid enhancement level input
    const quantityInput = findQuantityInput(modal);
    if (!quantityInput) {
        return false;
    }

    // The shared React-input helper does the same value-tracker rewind this
    // carried inline: set the value, rewind the tracker so a strictly-controlled
    // input reads the event as a real change rather than snapping back, then
    // dispatch input and change (the fields commit on blur). `focus: false`
    // keeps the fill from stealing the caret, which the inline copy did not do.
    setReactInputValue(quantityInput, quantity.toString(), { focus: false, dispatchChange: true });
    return true;
}

/**
 * The manager whose quantity was set most recently — the only one that fills.
 *
 * Ten features each keep a manager, and every one of them watches every buy
 * modal. Left to themselves they all write into the same quantity box and the
 * last observer to run wins, so a feature's lazily recomputed quantity (kept
 * alive on purpose, so the next purchase fills the remaining amount) went on
 * overriding the quantity the feature you had just clicked in meant to fill —
 * "needs 20 of one and 400 of the other, and both tabs say 20". The intent set
 * last is the intent the player acted on last, so it is the one that stands;
 * every other manager stays quiet until something sets it again.
 */
let latestIntentOwner = null;

/**
 * Create an autofill manager instance
 * Manages storing quantity to autofill and observing buy modals
 * @param {string} observerId - Unique ID for this observer (e.g., 'MissingMats-Actions')
 * @returns {Object} Autofill manager with methods: setQuantity, setPendingCalculation, clearQuantity, initialize, cleanup
 */
export function createAutofillManager(observerId) {
    let activeQuantity = null;
    let pendingCalculation = null;
    let armedItemHrid = null;
    let observerUnregister = null;
    const self = {};

    /** Stand down from filling, without touching another manager's claim */
    const releaseIntent = () => {
        if (latestIntentOwner === self) latestIntentOwner = null;
    };

    const forget = () => {
        activeQuantity = null;
        pendingCalculation = null;
        armedItemHrid = null;
        releaseIntent();
    };

    return {
        /**
         * Set a static quantity to auto-fill in the next buy modal
         * @param {number} quantity - Quantity to auto-fill
         * @param {Object} [options] - Options
         * @param {string} [options.itemHrid] - Arm for this item only. A buy modal for anything
         *   else is left alone AND retires the arming: the errand it was armed for is over the
         *   moment the player is buying something else. Omitted means "any buy modal", which is
         *   what a caller that cannot know the item (the Shop's own dialog) needs.
         */
        setQuantity(quantity, { itemHrid = null } = {}) {
            activeQuantity = quantity;
            pendingCalculation = null;
            armedItemHrid = itemHrid;
            latestIntentOwner = self;
        },

        /**
         * Set a lazy calculation function that is called each time a buy modal opens.
         * Takes priority over setQuantity — quantity is recomputed fresh on every modal open,
         * so subsequent purchases within the same session always autofill the remaining needed amount.
         *
         * A persisting arming with no `itemHrid` outlives its errand: it goes on filling every
         * later buy box, for any item, until something else claims the fill. Pass the item unless
         * the modal genuinely cannot be identified.
         *
         * @param {Function} fn - Function returning the current quantity to fill
         * @param {Object} [options] - Options
         * @param {string} [options.itemHrid] - Arm for this item only; see `setQuantity`
         */
        setPendingCalculation(fn, { itemHrid = null } = {}) {
            pendingCalculation = fn;
            activeQuantity = null;
            armedItemHrid = itemHrid;
            latestIntentOwner = self;
        },

        /**
         * Clear the stored quantity (cancel autofill)
         */
        clearQuantity() {
            forget();
        },

        /**
         * Get the current active quantity
         * @returns {number|null} Current quantity or null
         */
        getQuantity() {
            return pendingCalculation ? pendingCalculation() : activeQuantity;
        },

        /**
         * Initialize buy modal observer
         * Sets up watching for buy modals to appear and auto-fills them
         *
         * Idempotent. Callers reach for this defensively — the shopping list ran
         * `autofill.initialize?.()` on every open — and each call used to register
         * a second observer while dropping the previous unregister on the floor,
         * so the handler could never be taken away again. One live observer per
         * manager is all this needs: the quantity it fills is read fresh from the
         * closure every time, so a re-registered handler was not doing anything
         * the first one was not already doing.
         *
         * @returns {Function} The unregister function for the live observer
         */
        initialize() {
            if (observerUnregister) return observerUnregister;

            const attempt = (modal) => {
                // Only the most recently set intent fills; see latestIntentOwner
                if (latestIntentOwner !== self) return false;

                // An arming belongs to one item. A buy box for a different one
                // is not this errand — and it is proof the errand was abandoned,
                // so the arming is dropped rather than left to ambush the next
                // buy box too. A modal that names no item (the Shop's dialog)
                // cannot be told apart and is left to the header checks below.
                if (armedItemHrid) {
                    const modalItem = modalItemHrid(modal);
                    if (modalItem && modalItem !== armedItemHrid) {
                        forget();
                        return false;
                    }
                }

                const filled = handleBuyModal(modal, activeQuantity, pendingCalculation);
                // Clear static quantity once it has actually gone into a buy
                // form (one-shot) — not on whatever modal happened to open
                // first. pendingCalculation persists intentionally.
                if (filled && activeQuantity !== null && !pendingCalculation) {
                    activeQuantity = null;
                    armedItemHrid = null;
                    releaseIntent();
                }
                return filled;
            };
            observerUnregister = domObserver.onClass(observerId, 'Modal_modalContainer', (modal) => {
                // The container can appear a beat before its content — the
                // Shop's dialog renders its body after the frame — so a miss
                // is tried once more shortly after
                if (!attempt(modal)) {
                    setTimeout(() => {
                        if (document.body.contains(modal)) attempt(modal);
                    }, 250);
                }
            });
            return observerUnregister;
        },

        /**
         * Cleanup observer
         * Stops watching for buy modals and clears quantity
         */
        cleanup() {
            if (observerUnregister) {
                observerUnregister();
                observerUnregister = null;
            }
            forget();
        },
    };
}
