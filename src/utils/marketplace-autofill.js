/**
 * Marketplace Buy Modal Autofill Utility
 * Provides shared functionality for auto-filling quantity in marketplace buy modals
 * Used by missing materials features (actions, houses, etc.)
 */

import config from '../core/config.js';
import domObserver from '../core/dom-observer.js';
import { setReactInputValue } from './react-input.js';
import { parseItemCount } from './number-parser.js';
import { estimatedListingAge } from './bundle-bridge.js';
import { priceCoveringQuantity, nextPriceAbove } from './order-book.js';
import { tradableRangeFrom, clampToRange } from './tradable-range.js';

/**
 * How many times the price may step up the ask ladder after the first raise.
 *
 * Each step only ever happens when the modal itself still says the order is
 * short, and each one has to land on a strictly higher rung of a finite
 * ladder, so the walk terminates on its own; this bound is the second lock,
 * so a book that disagrees with the modal forever cannot spin.
 */
const MAX_COVER_STEPS = 3;

/** Milliseconds to wait for the sleeping price control to swap its input in */
const PRICE_WAKE_MS = 120;

/** Milliseconds to wait for the modal to re-render its figures after a price write */
const PRICE_SETTLE_MS = 150;

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
 * @param {string|null} [itemHrid] - The item this fill is for, when it is known
 */
function handleBuyModal(modal, activeQuantity, pendingCalculation, itemHrid = null) {
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

    if (!fillQuantity(modal, quantity)) {
        return false;
    }

    raisePriceToCoverQuantity(modal, itemHrid, quantity);
    return true;
}

/**
 * Write a quantity into the modal's quantity box.
 *
 * The shared React-input helper does the value-tracker rewind this used to
 * carry inline; `focus: false` keeps the fill from stealing the caret, which
 * is what the inline copy did.
 *
 * @param {HTMLElement} modal - Modal container element
 * @param {number} quantity - Quantity to write
 * @returns {boolean} True when the box was found and written
 */
function fillQuantity(modal, quantity) {
    const quantityInput = findQuantityInput(modal);
    if (!quantityInput) return false;
    setReactInputValue(quantityInput, quantity.toString(), { focus: false, dispatchChange: true });
    return true;
}

/**
 * How many units the modal says are on offer at the price it is showing.
 *
 * The buy box states this itself ("Quantity (Available At Price: 15)"), and it
 * is the only figure that is certainly current — the cached order book can be
 * older than the modal. Null means the modal did not say, which is treated as
 * "no reason to touch anything".
 *
 * @param {string} text - The modal's text content
 * @returns {number|null} Units available at the shown price, or null when unstated
 */
export function availableAtPriceFrom(text) {
    const match = String(text || '').match(/available at price:?\s*([\d.,\s]+[kmbt]?)/i);
    if (!match) return null;
    const value = parseItemCount(match[1], NaN);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Whether the modal's own figures already cover the quantity being filled.
 *
 * A modal that states no availability counts as covered: nothing is known to be
 * wrong, so nothing is changed.
 *
 * @param {HTMLElement} modal - Modal container element
 * @param {number} quantity - Units wanted
 * @returns {boolean} True when the shown price already supplies the whole amount
 */
function modalCoversQuantity(modal, quantity) {
    const available = availableAtPriceFrom(modal?.textContent || '');
    return available === null || available >= quantity;
}

/**
 * The modal's price row, which since the 8/14/2026 update may hold either a
 * live `<input>` or the display div that stands in for one until clicked.
 * @param {HTMLElement} modal - Modal container element
 * @returns {HTMLElement|null} The row, or null when the modal shows no price
 */
function priceRow(modal) {
    return modal?.querySelector?.('div[class*="MarketplacePanel_priceInputs"]') || null;
}

/**
 * The price the modal is currently showing, read from the live input when the
 * control is awake and from the display div when it is not.
 * @param {HTMLElement} modal - Modal container element
 * @returns {number|null} The price, or null when it cannot be read
 */
function modalPrice(modal) {
    const row = priceRow(modal);
    if (!row) return null;
    const input = row.querySelector('input');
    const text = input ? input.value : row.querySelector('div[class*="MarketplacePanel_priceDisplay"]')?.textContent;
    const value = parseItemCount(text, NaN);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The enhancement level the modal is showing — the book is per level, so a +3
 * modal must not be priced off the +0 ladder.
 *
 * The label is a sibling of the field's wrapper rather than an ancestor of the
 * input, so the containers are walked outward a level at a time, taking the
 * tightest one that names Enhancement Level and not Quantity.
 *
 * @param {HTMLElement} modal - Modal container element
 * @returns {number} The level; 0 when the modal has no enhancement field
 */
function modalEnhancementLevel(modal) {
    const inputs = Array.from(modal?.querySelectorAll?.('input') || []);
    for (let depth = 0; depth < 4; depth++) {
        for (const input of inputs) {
            let parent = input.parentElement;
            for (let step = 0; step < depth && parent; step++) parent = parent.parentElement;
            if (!parent) continue;
            const text = parent.textContent || '';
            if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                return parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10) || 0;
            }
        }
    }
    return 0;
}

/**
 * Run `apply` against the price row's input, waking the control first if it is
 * asleep.
 *
 * The price control renders as a display div and only swaps a real input in
 * when clicked. That click is an affordance on a form field, not a game action:
 * nothing here ever presses a buy, post or confirm button.
 *
 * @param {HTMLElement} modal - Modal container element
 * @param {Function} apply - Called with the live input, now or once it wakes
 */
function withPriceInput(modal, apply) {
    const row = priceRow(modal);
    if (!row) return;
    const input = row.querySelector('input');
    if (input) {
        apply(input);
        return;
    }
    row.querySelector('div[class*="MarketplacePanel_priceDisplay"]')?.click();
    setTimeout(() => {
        const revealed = row.querySelector('input');
        if (revealed) apply(revealed);
    }, PRICE_WAKE_MS);
}

/**
 * Write one price, then check the modal's own figures and step again if the
 * order is still short.
 *
 * The cached book can be older than the modal, so a computed covering price is
 * a proposal and the modal's restated "Available At Price" is what settles it.
 * When a step does not cover, the next distinct rung of the ladder is tried, at
 * most {@link MAX_COVER_STEPS} times. When the ladder or the budget runs out
 * the last written price stands — the modal's own figures then state exactly
 * what pressing the button would buy.
 *
 * @param {HTMLElement} modal - Modal container element
 * @param {Array<{price: number, quantity: number}>} listings - Ask ladder, best first
 * @param {number} quantity - Units wanted
 * @param {number} target - Price to write
 * @param {number} budget - Steps left after this one
 */
function stepPriceToCover(modal, listings, quantity, target, budget) {
    const range = tradableRangeFrom(modal.textContent || '');
    const wanted = range ? clampToRange(target, range) : target;
    const current = modalPrice(modal);
    // Only ever raises. An unreadable price is not a licence to guess: without
    // it there is no way to be sure the write is not a cut.
    if (current === null || !(wanted > current)) return;

    withPriceInput(modal, (input) => {
        setReactInputValue(input, String(wanted), { focus: false, dispatchChange: true });
        // A price change can make the game re-derive the quantity, so the amount
        // that was asked for is written back after every step.
        fillQuantity(modal, quantity);

        if (budget <= 0) return;
        setTimeout(() => {
            if (!document.body.contains(modal)) return;
            if (modalCoversQuantity(modal, quantity)) return;
            const next = nextPriceAbove(listings, wanted);
            if (next === null) return;
            stepPriceToCover(modal, listings, quantity, next, budget - 1);
        }, PRICE_SETTLE_MS);
    });
}

/**
 * Raise a buy modal's price until it covers the quantity that was filled.
 *
 * The best ask only holds the units listed at that price, so a larger order
 * buys only those. The lowest price whose cumulative supply covers the whole
 * amount is filled in instead — never above the modal's tradable maximum,
 * never below the price already shown, and never further up the ladder than
 * coverage requires. Off by default; the player still presses the button.
 *
 * Nothing happens when the setting is off, when the modal already covers the
 * quantity, when it shows no price field, when it is the Shop's dialog (no
 * order book behind it), or when no book for the item and enhancement level is
 * cached — every one of those is today's behaviour, unchanged.
 *
 * @param {HTMLElement} modal - Modal container element
 * @param {string|null} itemHrid - The item the fill was armed for
 * @param {number} quantity - Units wanted
 */
function raisePriceToCoverQuantity(modal, itemHrid, quantity) {
    if (!config?.getSetting?.('market_raiseBuyPriceToCoverQuantity')) return;
    if (!itemHrid || isShopBuyModal(modal)) return;
    if (!priceRow(modal)) return;
    if (modalCoversQuantity(modal, quantity)) return;

    const listings = estimatedListingAge()?.cachedBookSide?.(itemHrid, modalEnhancementLevel(modal), true)?.listings;
    if (!Array.isArray(listings) || listings.length === 0) return;

    const target = priceCoveringQuantity(listings, quantity);
    if (!(target > 0)) return;

    stepPriceToCover(modal, listings, quantity, target, MAX_COVER_STEPS);
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

                const filled = handleBuyModal(
                    modal,
                    activeQuantity,
                    pendingCalculation,
                    armedItemHrid || modalItemHrid(modal)
                );
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
