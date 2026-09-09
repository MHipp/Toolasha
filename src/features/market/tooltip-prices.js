/**
 * Market Tooltip Prices Feature
 * Adds market prices to item tooltips
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import marketAPI from '../../api/marketplace.js';
import profitCalculator from './profit-calculator.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
import expectedValueCalculator from './expected-value-calculator.js';
import {
    calculateEnhancementPath,
    buildEnhancementTooltipHTML,
    buildEnhancementMilestonesHTML,
    getProductionCost,
    installEnhancementSourceToggle,
    uninstallEnhancementSourceToggle,
} from '../enhancement/tooltip-enhancement.js';
import { enhancementParamsFor } from '../enhancement/enhancement-params-source.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import {
    numberFormatter,
    formatKMB,
    networthFormatter,
    formatPercentage,
    isAbbreviationEnabled,
} from '../../utils/formatters.js';
import { getItemPrices } from '../../utils/market-data.js';
import { explainAbilityCost } from '../../utils/ability-cost-calculator.js';
import { resolveItemPrice, calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { MARKET_TAX, COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';
import dom from '../../utils/dom.js';
import { parseItemCount, parseGameNumber, gameDigitsSource } from '../../utils/number-parser.js';
import { DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { getKeyUnitCost } from '../../utils/key-cost.js';
import { calculateArtisanBonus } from '../../utils/material-calculator.js';
import { getActionHridFromName } from '../../utils/game-lookups.js';
import { findProducingAction } from '../../utils/production-index.js';

// Compiled regex patterns (created once, reused for performance)
const REGEX_ENHANCEMENT_STRIP = /\s*\+\d+$/;
const REGEX_REFINED_STAR = /\s*★/g;

// Once-per-session canary for tooltip shape drift. Tooltips are hover-transient,
// so the startup anchor canary can never see one — this in-handler check is the
// only place a rename of the tooltip content classes can be caught instead of
// failing every price injection silently, one bare return at a time.
let tooltipShapeWarned = false;

// Every section this module injects has its own toggle, but they all share one
// DOM observer and the same "anything to do?" guards. Init and those guards key
// off this list so that enabling any one feature — even with prices off — still
// draws it, instead of a blank tooltip because the observer never started.
const TOOLTIP_FEATURE_SETTINGS = [
    'itemTooltip_prices',
    'itemTooltip_pinTop',
    'itemTooltip_expectedValue',
    'itemTooltip_profit',
    'itemTooltip_multiActionProfit',
    'itemTooltip_gathering',
    'itemTooltip_gatheringRareDrops',
    'itemTooltip_abilityStatus',
    'itemTooltip_abilityFreshCost',
    'itemTooltip_enhancementPath',
    'itemTooltip_enhancementMilestones',
];

/** Whether any tooltip-injection feature is enabled. */
function anyTooltipFeatureEnabled() {
    return TOOLTIP_FEATURE_SETTINGS.some((id) => config.getSetting(id));
}

/**
 * Get the items sprite URL from the DOM (matches pattern used across other display modules)
 * @returns {string|null} Sprite URL or null if not found
 */
function getItemsSpriteUrl() {
    const el = document.querySelector('use[href*="items_sprite"]');
    return el ? el.getAttribute('href').split('#')[0] : null;
}

/**
 * Format price for tooltip display based on user setting
 * @param {number} num - The number to format
 * @returns {string} Formatted number
 */
function formatTooltipPrice(num) {
    const useKMB = isAbbreviationEnabled();
    return useKMB ? networthFormatter(num) : numberFormatter(num);
}

/**
 * The highest level a cumulative experience total has reached.
 *
 * @param {number[]} table - The game's cumulative `levelExperienceTable`
 * @param {number} experience - A cumulative experience total
 * @returns {number|null} The level, or null without a table to read
 */
function levelAtExperience(table, experience) {
    if (!Array.isArray(table)) return null;
    let reached = 0;
    for (let level = 1; level < Math.min(table.length, 201); level++) {
        if (table[level] <= experience) reached = level;
        else break;
    }
    return reached;
}

/**
 * TooltipPrices class handles injecting market prices into item tooltips
 */
/**
 * The order-book side a `profitCalc_pricingMode` buys at.
 *
 * Same table `getPricingMode` applies for `{ context: 'profit', side: 'buy' }`,
 * duplicated rather than called because this module holds a plain profitData
 * object, not an item hrid. Acquiring is always a buy, so only the buy column
 * matters: 'conservative' and 'hybrid' insta-buy at ask, 'optimistic' and
 * 'patientBuy' wait at bid. An unrecognised mode falls to ask exactly as
 * `getPricingMode` does, so the two halves still agree.
 *
 * @param {string|undefined} pricingMode - `profitData.pricingMode`
 * @returns {'ask'|'bid'}
 */
function ownUseBuyBasis(pricingMode) {
    const mode = pricingMode || config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    return mode === 'optimistic' || mode === 'patientBuy' ? 'bid' : 'ask';
}

/**
 * Buying versus making, for an item that will be consumed rather than sold.
 *
 * Every profit figure in this module is a seller's: the crafted output is
 * priced at market minus the sales tax, because the question is "should I
 * craft this to sell". A dungeon key or a meal is never sold, so that tax
 * belongs on neither side here — buying costs whatever acquiring it costs
 * under the user's pricing mode, and making costs the materials and teas your
 * own bench burns per finished item (efficiency and Gourmet included, which is
 * why the per-hour figures are the ones divided: teas amortize over the extra
 * actions efficiency repeats).
 *
 * Both sides are quoted on that one mode. The make side already is, because
 * every material and tea was resolved at `{ context: 'profit', side: 'buy' }`;
 * the buy side reads the same mode off `profitData.pricingMode` so the
 * comparison cannot be half optimistic and half conservative. Costing the
 * materials at bid while quoting the alternative at ask would tilt every such
 * line toward "make is cheaper" by the width of the spread.
 *
 * Deliberately not the same model as the dungeon ROI board's `describeKeyCost`:
 * that one prices a replacement key from materials alone, each sourced at the
 * cheaper of buying and crafting, with no tea cost — a board ranking dungeons
 * must not move with whichever teas happen to be equipped. This line is about
 * the bench as it stands right now, teas and all, so the two can quote
 * different make costs for the same key and both be right about their question.
 *
 * @param {Object|null} profitData - From `profitCalculator.calculateProfit`
 * @param {Object|null} [actionDetail] - The producing action's detail, for the
 *   multi-output gate; null skips that gate rather than failing it
 * @returns {{make: number, buy: number|null, saves: number|null,
 *   cheaper: 'make'|'buy'|'even'|null, priceBasis: 'ask'|'bid'}|null} The
 *   comparison, or null when the make side cannot be priced. `priceBasis` is
 *   the order-book side the buy figure came from — and would have come from
 *   had one been listed, so a null `buy` can still say which book was empty.
 */
export function ownUseCompare(profitData, actionDetail = null) {
    // A recipe with several outputs bills its whole bench spend to whichever
    // output the calculator picked, so a per-item make figure for that output
    // charges it for items the other outputs also are. No single-output split
    // is honest without pricing the co-products, so say nothing.
    if ((actionDetail?.outputItems?.length ?? 0) > 1) {
        return null;
    }

    // An unpriceable material or tea was costed at zero upstream, which here
    // would dress a bench that cannot be priced up as one that is cheap
    const unpriced = (entries) => Array.isArray(entries) && entries.some((entry) => entry.missingPrice);
    if (unpriced(profitData?.materialCosts) || unpriced(profitData?.teaCosts)) {
        return null;
    }

    const madePerHour = Number(profitData?.totalItemsPerHour);
    const spendPerHour = Number(profitData?.materialCostPerHour) + Number(profitData?.totalTeaCostPerHour || 0);
    if (!Number.isFinite(madePerHour) || madePerHour <= 0 || !Number.isFinite(spendPerHour) || spendPerHour < 0) {
        return null;
    }
    const make = spendPerHour / madePerHour;

    const priceBasis = ownUseBuyBasis(profitData?.pricingMode);
    const buy = Number(profitData?.itemPrice?.[priceBasis]);
    if (!(buy > 0)) return { make, buy: null, saves: null, cheaper: null, priceBasis };

    const saves = Math.abs(buy - make);
    // Within a percent of the price you would pay the two are the same
    // decision, and calling a winner on that margin is precision the inputs do
    // not have. The band tracks the buy side deliberately: on a bid basis the
    // reference is lower, so the band narrows with the number it qualifies.
    const cheaper = saves < buy * 0.01 ? 'even' : make < buy ? 'make' : 'buy';
    return { make, buy, saves, cheaper, priceBasis };
}

/**
 * The own-use line's text and color, ready for the tooltip.
 *
 * The color carries the same answer the text does and never carries it alone:
 * profit green when making wins, loss red when buying does, informational blue
 * when the two are even or there is no buy price to compare against.
 *
 * @param {Object|null} comparison - From {@link ownUseCompare}
 * @returns {{text: string, color: string}|null} Null when there is nothing to say
 */
export function ownUseLine(comparison) {
    if (!comparison) return null;
    const make = formatKMB(comparison.make);
    const basis = comparison.priceBasis === 'bid' ? 'bid' : 'ask';
    if (comparison.buy === null) {
        return { text: `Own use: make ≈${make} (no ${basis}s)`, color: config.COLOR_TOOLTIP_INFO };
    }
    // The basis rides on the buy figure rather than the end of the line: it
    // qualifies that number and nothing else, and the reader can no longer
    // assume ask.
    const buy = `${formatKMB(comparison.buy)} (${basis})`;
    if (comparison.cheaper === 'even') {
        return { text: `Own use: make ≈${make} vs buy ${buy} — even`, color: config.COLOR_TOOLTIP_INFO };
    }
    // The winning action is the subject of "saves". An unqualified "save" was
    // read as an endorsement of the bench the line sits on, so a line telling
    // you to buy still read as "crafting is worth it". The colour repeats the
    // same answer and never carries it alone: profit green when the bench
    // wins, loss red when it does not. The percent is of the price avoided —
    // the side the cheaper choice spares you.
    const wins = comparison.cheaper === 'make' ? 'make' : 'buy';
    const avoided = comparison.cheaper === 'make' ? comparison.buy : comparison.make;
    const pct = ((comparison.saves / avoided) * 100).toFixed(0);
    return {
        text: `Own use: make ≈${make} vs buy ${buy} — ${wins} saves ${formatKMB(comparison.saves)} (${pct}%)`,
        color: comparison.cheaper === 'make' ? config.COLOR_TOOLTIP_PROFIT : config.COLOR_TOOLTIP_LOSS,
    };
}

class TooltipPrices {
    constructor() {
        this.unregisterObserver = null;
        this.isActive = false;
        this.isInitialized = false;
        this.itemNameToHridCache = null; // Lazy-loaded reverse lookup cache
        this.itemNameToHridCacheSource = null; // Track source for invalidation
    }

    /**
     * Whether the feature registry should start this feature. True when any
     * tooltip section is enabled — not just prices/pin-to-top — so the registry
     * doesn't skip the feature (and never call initialize) for someone running
     * only profit, expected value, or the enhancement sections.
     * @returns {boolean}
     */
    shouldEnable() {
        return anyTooltipFeatureEnabled();
    }

    /**
     * Initialize the tooltip prices feature
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!anyTooltipFeatureEnabled()) {
            return;
        }

        this.isInitialized = true;

        // Every section except pin-to-top and ability-book status reads market
        // prices (prices, profit, expected value, enhancement costs, gathering
        // value), so load market data unless those two are the only things on.
        const needsMarketData = TOOLTIP_FEATURE_SETTINGS.filter(
            (id) => id !== 'itemTooltip_pinTop' && id !== 'itemTooltip_abilityStatus'
        ).some((id) => config.getSetting(id));

        if (needsMarketData && !marketAPI.isLoaded()) {
            // Not forced: the entrypoint starts the startup fetch as soon as the
            // character arrives, so this joins that in-flight load (or reads the
            // 15-minute cache) instead of queuing a second network round trip
            await marketAPI.fetch();
        }

        // Add CSS to prevent tooltip cutoff
        this.addTooltipStyles();

        // Make the "Yours / Pro" chip on enhancement sections clickable (and P-pressable)
        installEnhancementSourceToggle();

        // Register with centralized DOM observer
        this.setupObserver();
    }

    /**
     * Add CSS styles to prevent tooltip cutoff
     *
     * CRITICAL: CSS alone is not enough! MUI uses JavaScript to position tooltips
     * with transform3d(), which can place them off-screen. We need both:
     * 1. CSS: Enables scrolling when tooltip is taller than viewport
     * 2. JavaScript: Repositions tooltip when it extends beyond viewport (see fixTooltipOverflow)
     */
    addTooltipStyles() {
        // Check if styles already exist (might be added by tooltip-consumables)
        if (document.getElementById('mwi-tooltip-fixes')) {
            return; // Already added
        }

        const css = `
            /* Ensure tooltip content is scrollable if too tall */
            .MuiTooltip-tooltip {
                max-height: calc(100vh - 20px) !important;
                overflow-y: auto !important;
            }

            /* Also target the popper container */
            .MuiTooltip-popper {
                max-height: 100vh !important;
            }

            /* Add subtle scrollbar styling */
            .MuiTooltip-tooltip::-webkit-scrollbar {
                width: 6px;
            }

            .MuiTooltip-tooltip::-webkit-scrollbar-track {
                background: rgba(0, 0, 0, 0.2);
            }

            .MuiTooltip-tooltip::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.3);
                border-radius: 3px;
            }

            .MuiTooltip-tooltip::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.5);
            }
        `;

        dom.addStyles(css, 'mwi-tooltip-fixes');
    }

    /**
     * Set up observer to watch for tooltip elements
     */
    setupObserver() {
        // Subscribe to the shared tooltip observer, which classifies each
        // popper once and hands every tooltip feature the result
        tooltipObserver.subscribe('TooltipPrices', (tooltipElement, eventType, info) => {
            if (eventType !== 'opened' || !info?.isTooltipPopper) return;
            this.handleTooltip(tooltipElement, info);
        });
        this.unregisterObserver = () => tooltipObserver.unsubscribe('TooltipPrices');

        this.isActive = true;
    }

    /**
     * Handle a tooltip element
     * @param {Element} tooltipElement - The tooltip popper element
     * @param {import('../../core/tooltip-observer.js').TooltipInfo} [info] - Its classification
     *   (probed here when a caller has none)
     */
    async handleTooltip(tooltipElement, info = tooltipObserver.classify(tooltipElement)) {
        // Collection tooltip / regular item tooltip, as classified once on arrival
        const isCollectionTooltip = info.isCollectionTooltip;
        const isItemTooltip = info.isItemTooltip;

        // Drift canary: the popper carries item-tooltip (or collection-tooltip)
        // content, but the class this file keys everything on did not match — a
        // game rename of the name/content classes. Without this, every price,
        // profit and enhancement injection would just stop, with nothing said.
        if (
            !tooltipShapeWarned &&
            !isItemTooltip &&
            !isCollectionTooltip &&
            tooltipElement.querySelector('[class*="ItemTooltipText_"], [class*="Collection_tooltip"]')
        ) {
            tooltipShapeWarned = true;
            console.warn(
                '[TooltipPrices] A game tooltip rendered content this script no longer recognizes — ' +
                    'the game may have renamed its tooltip classes. Price/profit tooltip injections ' +
                    'are likely broken until the selectors are updated.'
            );
        }

        // Hovering an ability itself (in a loadout / ability slot / another
        // player's profile), not its book item: the game's tooltip shows level
        // and description but not what that level cost. Add a "Fresh to Lv" line,
        // priced at the level the tooltip shows — so on another player's profile
        // it uses THEIR level, not yours. The ability tooltip is text-only, so it
        // is identified by its container class and the name it prints. Opt-in via
        // its own setting, independent of the item-price gates below.
        const abilityTooltip = info.abilityTooltip;
        if (
            !isCollectionTooltip &&
            !isItemTooltip &&
            abilityTooltip &&
            config.getSetting('itemTooltip_abilityFreshCost')
        ) {
            const abilityName = abilityTooltip.querySelector('[class*="Ability_name"]')?.textContent?.trim();
            const abilityHrid = this.abilityHridFromName(abilityName);
            if (abilityHrid) {
                this.injectAbilityFreshCost(tooltipElement, abilityTooltip, abilityHrid);
            }
            return;
        }

        // Skip if no tooltip features are enabled
        if (!anyTooltipFeatureEnabled()) {
            return;
        }

        if (!isCollectionTooltip && !isItemTooltip) {
            return; // Not a tooltip we can enhance
        }

        // Suppress item tooltip when hovering items in the enhance item selector
        if (
            isItemTooltip &&
            config.getSetting('itemTooltip_hideInEnhanceSelector') &&
            document.querySelector('[class*="EnhancingPanel_enhancingPanel"]') &&
            document.querySelector('[class*="ItemSelector_itemList"]')
        ) {
            tooltipElement.style.display = 'none';
            return;
        }

        // Apply pin-to-top positioning only to item/collection tooltips
        if (config.getSetting('itemTooltip_pinTop')) {
            dom.fixTooltipOverflow(tooltipElement, { forceTop: true });
        }

        // Skip all injection if no injecting feature is enabled. Pin-to-top is
        // excluded here — it was already applied just above and draws nothing —
        // so a pin-only tooltip still short-circuits before the name lookup.
        const anyInjectingFeature = TOOLTIP_FEATURE_SETTINGS.filter((id) => id !== 'itemTooltip_pinTop').some((id) =>
            config.getSetting(id)
        );
        if (!anyInjectingFeature) {
            return;
        }

        // Extract item name from appropriate element
        let itemName;
        if (isCollectionTooltip) {
            const collectionNameElement = info.collectionNameEl;
            if (!collectionNameElement) {
                return; // No name element in collection tooltip
            }
            itemName = collectionNameElement.textContent.trim();
        } else {
            itemName = info.itemName;
        }

        // Guard against duplicate processing for the same item.
        // Use the full item name (includes enhancement suffix e.g. "+3") as the key so
        // that switching to a different item — or a different enhancement level of the same
        // item — clears stale injected content and re-processes.
        if (tooltipElement.dataset.pricesProcessedItem === itemName) {
            return;
        }

        // Item changed (or first visit) — remove any previously injected elements so
        // stale data from the previous item doesn't bleed through.
        if (tooltipElement.dataset.pricesProcessedItem) {
            const tooltipText = tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');
            if (tooltipText) {
                const staleSelectors = [
                    '.market-price-injected',
                    '.market-profit-injected',
                    '.market-ev-injected',
                    '.market-gathering-injected',
                    '.market-multi-action-injected',
                    '.market-enhancement-injected',
                    '.mwi-enhancement-milestones',
                    '.mwi-ability-status',
                ];
                for (const sel of staleSelectors) {
                    tooltipText.querySelector(sel)?.remove();
                }
            }
        }

        tooltipElement.dataset.pricesProcessedItem = itemName;

        // Get the item HRID from the name
        const itemHrid = this.extractItemHridFromName(itemName);

        if (!itemHrid) {
            return;
        }

        // Get item details
        const itemDetails = dataManager.getItemDetails(itemHrid);

        if (!itemDetails) {
            return;
        }

        // Check if this is an openable container first (they have no market price)
        if (itemDetails.isOpenable && config.getSetting('itemTooltip_expectedValue')) {
            const evData = expectedValueCalculator.calculateExpectedValue(itemHrid);
            if (evData) {
                // Compute chest key deduction for dungeon chests
                let keyPrice = 0;
                const chestKeyHrid = DUNGEON_CHEST_CHEST_KEYS[itemHrid];
                if (chestKeyHrid) {
                    const keyDetails = dataManager.getItemDetails(chestKeyHrid);
                    keyPrice = getKeyUnitCost(chestKeyHrid) ?? 0;
                    this.injectExpectedValueDisplay(
                        tooltipElement,
                        evData,
                        isCollectionTooltip,
                        keyPrice,
                        keyDetails?.name
                    );
                } else {
                    this.injectExpectedValueDisplay(tooltipElement, evData, isCollectionTooltip);
                }
            }
            // Fix tooltip overflow before returning
            dom.fixTooltipOverflow(tooltipElement, { forceTop: config.getSetting('itemTooltip_pinTop') });
            return; // Skip price/profit display for containers
        }

        // Only check enhancement level for regular item tooltips (not collection tooltips)
        let enhancementLevel = 0;
        if (isItemTooltip && !isCollectionTooltip) {
            enhancementLevel = info.enhancementLevel;
        }

        // Get market price for the specific enhancement level (0 for base items, 1-20 for enhanced)
        const price = getItemPrices(itemHrid, enhancementLevel);

        // Inject price display only if we have market data and prices are enabled
        if (config.getSetting('itemTooltip_prices') && price && (price.ask > 0 || price.bid > 0)) {
            // Get item amount from tooltip (for stacks)
            const amount = this.extractItemAmount(tooltipElement);
            const artisanAmount = this._getArtisanAdjustedAmount(tooltipElement, amount);
            this.injectPriceDisplay(tooltipElement, price, amount, isCollectionTooltip, artisanAmount, itemHrid);
        }

        // Always show detailed craft profit if enabled
        if (config.getSetting('itemTooltip_profit') && enhancementLevel === 0) {
            // Original single-action craft profit display
            // Only run for base items (enhancementLevel = 0), not enhanced items
            // Enhanced items show their cost in the enhancement path section instead
            const profitData = await profitCalculator.calculateProfit(itemHrid);
            if (profitData) {
                this.injectProfitDisplay(tooltipElement, profitData, isCollectionTooltip);
            }
        }

        // Optionally show alternative alchemy actions below craft profit
        if (config.getSetting('itemTooltip_multiActionProfit')) {
            // Multi-action profit display (alchemy actions only - craft shown above)
            await this.injectMultiActionProfitDisplay(tooltipElement, itemHrid, enhancementLevel, isCollectionTooltip);
        }

        // Check for gathering sources (Foraging, Woodcutting, Milking)
        if (config.getSetting('itemTooltip_gathering') && enhancementLevel === 0) {
            const gatheringData = await this.findGatheringSources(itemHrid);
            if (gatheringData && (gatheringData.soloActions.length > 0 || gatheringData.zoneActions.length > 0)) {
                this.injectGatheringDisplay(tooltipElement, gatheringData, isCollectionTooltip);
            }
        }

        // Check if this is an ability book and show ability status
        if (config.getSetting('itemTooltip_abilityStatus') && itemDetails.abilityBookDetail && enhancementLevel === 0) {
            const abilityStatus = this.getAbilityStatus(itemHrid);
            if (abilityStatus) {
                this.injectAbilityStatusDisplay(tooltipElement, abilityStatus, isCollectionTooltip);
            }
        }

        // Show enhancement milestones for unenhanced equipment items
        if (enhancementLevel === 0 && config.getSetting('itemTooltip_enhancementMilestones')) {
            // Whose stats these are — the character's, or the pro kit the chip lets you
            // compare against — is decided in one place so tooltip and chip cannot disagree
            const enhancementConfig = enhancementParamsFor('tooltip', itemHrid);
            if (enhancementConfig) {
                const milestonesHTML = buildEnhancementMilestonesHTML(itemHrid, enhancementConfig);
                if (milestonesHTML) {
                    const tooltipText = tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');
                    if (tooltipText && !tooltipText.querySelector('.mwi-enhancement-milestones')) {
                        const div = dom.createStyledDiv(
                            { color: config.COLOR_TOOLTIP_INFO },
                            '',
                            'mwi-enhancement-milestones'
                        );
                        div.innerHTML = milestonesHTML;
                        tooltipText.appendChild(div);
                    }
                }
            }
        }

        // Show enhancement path for enhanced items (1-20)
        if (enhancementLevel > 0 && config.getSetting('itemTooltip_enhancementPath')) {
            // Untradeable items are always quoted from your own stats; everything else follows
            // the source chip on the section header
            const enhancementConfig = enhancementParamsFor('tooltip', itemHrid);
            if (enhancementConfig) {
                // Calculate optimal enhancement path
                const enhancementData = calculateEnhancementPath(itemHrid, enhancementLevel, enhancementConfig);

                if (enhancementData) {
                    // Inject enhancement analysis into tooltip
                    this.injectEnhancementDisplay(tooltipElement, enhancementData);
                }
            }
        }

        // Fix tooltip overflow (ensure it stays in viewport)
        dom.fixTooltipOverflow(tooltipElement, { forceTop: config.getSetting('itemTooltip_pinTop') });
    }

    /**
     * Extract enhancement level from tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @returns {number} Enhancement level (0 if not enhanced)
     */
    extractEnhancementLevel(tooltipElement) {
        return tooltipObserver.classify(tooltipElement).enhancementLevel;
    }

    /**
     * Inject enhancement display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} enhancementData - Enhancement analysis data
     */
    injectEnhancementDisplay(tooltipElement, enhancementData) {
        const tooltipText = tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        if (tooltipText.querySelector('.market-enhancement-injected')) {
            return;
        }

        // Create enhancement display container
        const enhancementDiv = dom.createStyledDiv(
            { color: config.COLOR_TOOLTIP_INFO },
            '',
            'market-enhancement-injected'
        );

        // Build HTML using the tooltip-enhancement module
        enhancementDiv.innerHTML = buildEnhancementTooltipHTML(enhancementData);

        tooltipText.appendChild(enhancementDiv);
    }

    /**
     * Extract item HRID from tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @returns {string|null} Item HRID or null
     */
    extractItemHrid(tooltipElement) {
        // Try to find the item HRID from the tooltip's data attributes or content
        // The game uses React, so we need to find the HRID from the displayed name

        const nameElement = tooltipElement.querySelector('div[class*="ItemTooltipText_name"]');
        if (!nameElement) {
            return null;
        }

        let itemName = nameElement.textContent.trim();

        // Strip enhancement level only (e.g., "+10" from "Griffin Bulwark ★ +10")
        // Leave ★ intact so extractItemHridFromName can try the (R) variant first
        itemName = itemName.replace(REGEX_ENHANCEMENT_STRIP, '').trim();

        return this.extractItemHridFromName(itemName);
    }

    /**
     * Extract item HRID from item name
     * @param {string} itemName - Item name
     * @returns {string|null} Item HRID or null
     */
    extractItemHridFromName(itemName) {
        // Strip enhancement level (e.g., "+10" from "Griffin Bulwark ★ +10")
        itemName = itemName.replace(REGEX_ENHANCEMENT_STRIP, '').trim();

        const initData = dataManager.getInitClientData();
        if (!initData || !initData.itemDetailMap) {
            return null;
        }

        // Build or return cached itemName -> HRID map
        let map;
        if (this.itemNameToHridCache && this.itemNameToHridCacheSource === initData.itemDetailMap) {
            map = this.itemNameToHridCache;
        } else {
            map = new Map();
            for (const [hrid, item] of Object.entries(initData.itemDetailMap)) {
                map.set(item.name, hrid);
            }

            // Only cache if we got actual entries (avoid poisoning with empty map)
            if (map.size > 0) {
                this.itemNameToHridCache = map;
                this.itemNameToHridCacheSource = initData.itemDetailMap;
            }
        }

        // 1. Exact match (handles base items and items already in "(R)" form)
        if (map.has(itemName)) return map.get(itemName);

        // 2. ★ → (R) substitution for refined items ("Dodocamel Gauntlets ★" → "Dodocamel Gauntlets (R)")
        if (itemName.includes('★')) {
            const refinedVariant = itemName.replace(/\s*★/g, ' (R)').replace(/\s+/g, ' ').trim();
            if (map.has(refinedVariant)) return map.get(refinedVariant);

            // 3. Strip ★ entirely as a last-resort fallback
            const baseName = itemName.replace(REGEX_REFINED_STAR, '').trim();
            return map.get(baseName) || null;
        }

        return null;
    }

    /**
     * Extract item amount from tooltip (for stacks)
     * @param {Element} tooltipElement - Tooltip element
     * @returns {number} Item amount (default 1)
     */
    extractItemAmount(tooltipElement) {
        const text = tooltipElement.textContent;
        return parseItemCount(text, 1);
    }

    /**
     * Get artisan-adjusted amount if tooltip is inside an action panel.
     * @param {Element} tooltipElement - Tooltip popper element
     * @param {number} baseAmount - Base recipe amount from tooltip
     * @returns {number|null} Adjusted amount, or null if not applicable
     */
    _getArtisanAdjustedAmount(tooltipElement, baseAmount) {
        if (baseAmount <= 1) return null;
        if (!config.getSetting('itemTooltip_artisanPrices')) return null;

        const trigger = document.querySelector(`[aria-describedby="${tooltipElement.id}"]`);
        if (!trigger) return null;

        const actionPanel =
            trigger.closest('[class*="SkillActionDetail_regularComponent"]') ||
            trigger.closest('[class*="SkillActionDetail_enhancingComponent"]');
        if (!actionPanel) return null;

        const actionNameEl = actionPanel.querySelector('[class*="SkillActionDetail_name"]');
        if (!actionNameEl) return null;

        const actionHrid = getActionHridFromName(actionNameEl.textContent.trim());
        if (!actionHrid) return null;

        const actionDetails = dataManager.getActionDetails(actionHrid);
        if (!actionDetails) return null;

        const artisanBonus = calculateArtisanBonus(actionDetails);
        if (artisanBonus <= 0) return null;

        const adjusted = Math.ceil(baseAmount * (1 - artisanBonus));
        if (adjusted >= baseAmount) return null;

        return adjusted;
    }

    /**
     * Inject price display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} price - { ask, bid }
     * @param {number} amount - Item amount (base recipe amount)
     * @param {boolean} isCollectionTooltip - True if this is a collection tooltip
     * @param {number|null} artisanAmount - Artisan-adjusted amount, or null if not applicable
     * @param {string|null} itemHrid - Item HRID for tax rate lookup
     */
    injectPriceDisplay(
        tooltipElement,
        price,
        amount,
        isCollectionTooltip = false,
        artisanAmount = null,
        itemHrid = null
    ) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            console.warn('[TooltipPrices] Could not find tooltip text container');
            return;
        }

        if (tooltipText.querySelector('.market-price-injected')) {
            return;
        }

        // Create price display
        const priceDiv = dom.createStyledDiv({ color: config.COLOR_TOOLTIP_INFO }, '', 'market-price-injected');

        // Show message if no market data at all
        if (price.ask <= 0 && price.bid <= 0) {
            priceDiv.innerHTML = `Price: <span style="color: ${config.COLOR_TEXT_SECONDARY}; font-style: italic;">No market data</span>`;
            tooltipText.appendChild(priceDiv);
            return;
        }

        // Format prices, using "-" for missing values
        const askDisplay = price.ask > 0 ? formatTooltipPrice(price.ask) : '-';
        const bidDisplay = price.bid > 0 ? formatTooltipPrice(price.bid) : '-';

        // Calculate totals when at least ask exists and amount > 1
        const effectiveAmount = artisanAmount || amount;
        let totalDisplay = '';
        if (effectiveAmount > 1 && price.ask > 0) {
            const amountLabel = ` ×${numberFormatter(effectiveAmount)}`;
            const totalAsk = formatTooltipPrice(price.ask * effectiveAmount);
            if (price.bid > 0) {
                const totalBid = formatTooltipPrice(price.bid * effectiveAmount);
                totalDisplay = ` (${totalAsk} / ${totalBid}${amountLabel})`;
            } else {
                totalDisplay = ` (${totalAsk}${amountLabel})`;
            }
        }

        // Format: "Price: 1,200 / 950" or "Price: 1,200 / -" or "Price: - / 950"
        priceDiv.innerHTML = `Price: ${askDisplay} / ${bidDisplay}${totalDisplay}`;

        if (config.getSetting('itemTooltip_effectivePrices') && (price.ask > 0 || price.bid > 0)) {
            const taxRate = itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;
            const effAsk = price.ask > 0 ? formatTooltipPrice(calculatePriceAfterTax(price.ask, taxRate)) : '-';
            const effBid = price.bid > 0 ? formatTooltipPrice(calculatePriceAfterTax(price.bid, taxRate)) : '-';
            priceDiv.innerHTML += `<br><span style="color: ${config.COLOR_TEXT_SECONDARY};">Eff: ${effAsk} / ${effBid}</span>`;
        }

        tooltipText.appendChild(priceDiv);
    }

    /**
     * Inject profit display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} profitData - Profit calculation data
     * @param {boolean} isCollectionTooltip - True if this is a collection tooltip
     */
    injectProfitDisplay(tooltipElement, profitData, isCollectionTooltip = false) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        if (tooltipText.querySelector('.market-profit-injected')) {
            return;
        }

        // Create profit display container
        const profitDiv = dom.createStyledDiv(
            { color: config.COLOR_TOOLTIP_INFO, marginTop: '8px' },
            '',
            'market-profit-injected'
        );

        // Check if detailed view is enabled
        const showDetailed = config.getSetting('itemTooltip_detailedProfit');

        // Build profit display
        let html = '<div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">';

        if (profitData.itemPrice.bid > 0 && profitData.itemPrice.ask > 0) {
            // Market data available - show profit
            html += '<div style="font-weight: bold; margin-bottom: 4px;">PROFIT</div>';
            html += '<div style="font-size: 0.9em; margin-left: 8px;">';

            const profitPerDay = profitData.profitPerDay;
            const profitColor = profitData.profitPerHour >= 0 ? config.COLOR_TOOLTIP_PROFIT : config.COLOR_TOOLTIP_LOSS;

            html += `<div style="color: ${profitColor}; font-weight: bold;">Net: ${formatKMB(profitData.profitPerHour)}/hr (${formatKMB(profitPerDay)}/day)</div>`;

            // Show detailed breakdown if enabled
            if (showDetailed) {
                html += this.buildDetailedProfitDisplay(profitData);
            }
        } else {
            // No market data - show cost summary (compact) or materials table (detailed)
            html += '<div style="font-size: 0.9em; margin-left: 8px;">';

            if (showDetailed) {
                html += this.buildDetailedProfitDisplay(profitData, false);
            } else {
                html += `<div style="font-weight: bold; color: ${config.COLOR_TOOLTIP_INFO};">Cost: ${formatKMB(profitData.totalMaterialCost)}/item</div>`;
            }
        }

        if (config.getSetting('itemTooltip_ownUseCompare')) {
            // The producing action, for the multi-output gate; a lookup that
            // cannot run (no game data yet) skips the gate rather than the line
            const ownUseAction = dataManager.getActionDetails?.(profitData.actionHrid) ?? null;
            const line = ownUseLine(ownUseCompare(profitData, ownUseAction));
            if (line) {
                const title =
                    'Buying vs crafting at your own bench cost per item (materials + teas, your efficiency and ' +
                    'Gourmet). Both sides use your profit pricing mode, so the buy figure is the ask or the bid ' +
                    'that mode would pay. No sales tax on either side — a consumed item is never sold.';
                html += `<div style="color: ${line.color}; margin-top: 4px;" title="${title}">${line.text}</div>`;
            }
        }

        html += '</div>';
        html += '</div>';

        profitDiv.innerHTML = html;
        tooltipText.appendChild(profitDiv);
    }

    /**
     * Get upgrade chain sub-rows for a crafted upgrade item (recursive).
     * Each row represents one level of the chain with its direct inputs cost only.
     * @param {string} itemHrid - Upgrade item to expand
     * @param {number} depth - Current nesting depth
     * @returns {Array} Flat array of sub-row objects
     */
    _getUpgradeChainRows(itemHrid, depth) {
        const action = findProducingAction(itemHrid, { primaryOnly: true })?.action;
        if (!action || !action.upgradeItemHrid) return [];

        const upgradeHrid = action.upgradeItemHrid;
        const upgradeDetails = dataManager.getItemDetails(upgradeHrid);
        if (!upgradeDetails) return [];

        let askPrice = resolveItemPrice(upgradeHrid, { mode: 'ask', side: 'buy' }).price ?? 0;
        let bidPrice = resolveItemPrice(upgradeHrid, { mode: 'bid', side: 'buy' }).price ?? 0;

        const craftAsk = getProductionCost(upgradeHrid, 'ask');
        const craftBid = getProductionCost(upgradeHrid, 'bid');
        const isCrafted = craftAsk > 0 && (askPrice === 0 || craftAsk < askPrice);

        if (isCrafted) {
            const deeperRows = this._getUpgradeChainRows(upgradeHrid, depth + 1);
            const deeperAsk = deeperRows.reduce((s, r) => s + r.askPrice * r.amount, 0);
            const deeperBid = deeperRows.reduce((s, r) => s + r.bidPrice * r.amount, 0);
            askPrice = craftAsk - deeperAsk;
            bidPrice = (craftBid || craftAsk) - deeperBid;
            return [{ itemName: `Craft ${upgradeDetails.name}`, amount: 1, askPrice, bidPrice, depth }, ...deeperRows];
        }

        if (craftBid > 0 && (bidPrice === 0 || craftBid < bidPrice)) bidPrice = craftBid;
        return [{ itemName: `Buy ${upgradeDetails.name}`, amount: 1, askPrice, bidPrice, depth }];
    }

    /**
     * Build detailed profit display with materials table
     * @param {Object} profitData - Profit calculation data
     * @returns {string} HTML string for detailed display
     */
    buildDetailedProfitDisplay(profitData, showProfitSummary = true) {
        let html = '';

        // Materials table
        if (profitData.materialCosts && profitData.materialCosts.length > 0) {
            html += '<div style="margin-top: 8px;">';
            html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em; color: ${config.COLOR_TOOLTIP_INFO};">`;

            // Table header
            html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
            html += '<th style="padding: 2px 4px; text-align: left;">Material</th>';
            html += '<th style="padding: 2px 4px; text-align: center;">Count</th>';
            html += '<th style="padding: 2px 4px; text-align: right;">Ask</th>';
            html += '<th style="padding: 2px 4px; text-align: right;">Bid</th>';
            html += '</tr>';

            // Resolve prices for all materials through unified chain
            const materialsWithPrices = profitData.materialCosts.map((material) => {
                if (material.itemHrid === '/items/coin') {
                    return { ...material, askPrice: 1, bidPrice: 1 };
                }

                let askPrice = resolveItemPrice(material.itemHrid, { mode: 'ask', side: 'buy' }).price ?? 0;
                let bidPrice = resolveItemPrice(material.itemHrid, { mode: 'bid', side: 'buy' }).price ?? 0;

                if (material.isUpgradeItem) {
                    const craftEnabled = config.getSetting('profitCalc_craftUpgradeItems');
                    // Flat mode: price each ingredient at market and stop, instead
                    // of recursing into how a craftable ingredient is itself made.
                    // Zeroing the craft cost makes isCrafted false, so the row is a
                    // plain "Buy X" at market with no sub-rows.
                    const expandChain = craftEnabled && !config.getSetting('itemTooltip_detailedProfitFlat');
                    const craftAsk = expandChain ? getProductionCost(material.itemHrid, 'ask') : 0;
                    const craftBid = expandChain ? getProductionCost(material.itemHrid, 'bid') : 0;
                    const isCrafted = craftAsk > 0 && (askPrice === 0 || craftAsk < askPrice);
                    if (isCrafted) {
                        // Split: show only direct inputs cost on this row, sub-rows handle deeper chain
                        const subRows = this._getUpgradeChainRows(material.itemHrid, 1);
                        const subAskTotal = subRows.reduce((s, r) => s + r.askPrice * r.amount, 0);
                        const subBidTotal = subRows.reduce((s, r) => s + r.bidPrice * r.amount, 0);
                        askPrice = craftAsk - subAskTotal;
                        bidPrice = (craftBid || craftAsk) - subBidTotal;
                        return { ...material, itemName: `Craft ${material.itemName}`, askPrice, bidPrice, subRows };
                    }
                    if (craftBid > 0 && (bidPrice === 0 || craftBid < bidPrice)) bidPrice = craftBid;
                    return { ...material, itemName: `Buy ${material.itemName}`, askPrice, bidPrice };
                }

                return { ...material, askPrice, bidPrice };
            });

            // Calculate totals (include sub-rows for correct additive sum)
            let totalCount = 0;
            let totalAsk = 0;
            let totalBid = 0;
            for (const m of materialsWithPrices) {
                totalCount += m.amount;
                totalAsk += m.askPrice * m.amount;
                totalBid += m.bidPrice * m.amount;
                if (m.subRows) {
                    for (const sub of m.subRows) {
                        totalCount += sub.amount;
                        totalAsk += sub.askPrice * sub.amount;
                        totalBid += sub.bidPrice * sub.amount;
                    }
                }
            }

            // Total row
            html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
            html += '<td style="padding: 2px 4px; font-weight: bold;">Total</td>';
            html += `<td style="padding: 2px 4px; text-align: center;">${totalCount.toFixed(1)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(totalAsk)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(totalBid)}</td>`;
            html += '</tr>';

            // Material rows
            for (const material of materialsWithPrices) {
                html += '<tr>';
                html += `<td style="padding: 2px 4px;">${material.itemName}</td>`;
                html += `<td style="padding: 2px 4px; text-align: center;">${material.amount.toFixed(1)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(material.askPrice)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(material.bidPrice)}</td>`;
                html += '</tr>';
                if (material.subRows) {
                    for (const sub of material.subRows) {
                        const indent = 8 + sub.depth * 10;
                        html += '<tr>';
                        html += `<td style="padding: 2px 4px; padding-left: ${indent}px; opacity: 0.8;">${sub.itemName}</td>`;
                        html += `<td style="padding: 2px 4px; text-align: center; opacity: 0.8;">${sub.amount.toFixed(1)}</td>`;
                        html += `<td style="padding: 2px 4px; text-align: right; opacity: 0.8;">${formatKMB(sub.askPrice)}</td>`;
                        html += `<td style="padding: 2px 4px; text-align: right; opacity: 0.8;">${formatKMB(sub.bidPrice)}</td>`;
                        html += '</tr>';
                    }
                }
            }

            html += '</table>';
            html += '</div>';
        }

        // Detailed profit breakdown (only when output has market data)
        if (showProfitSummary) {
            html += '<div style="margin-top: 8px; font-size: 0.85em;">';
            const profitPerAction = profitData.profitPerAction;
            const profitPerDay = profitData.profitPerDay;
            const profitColor = profitData.profitPerHour >= 0 ? config.COLOR_TOOLTIP_PROFIT : config.COLOR_TOOLTIP_LOSS;

            html += `<div style="color: ${profitColor};">Profit: ${formatKMB(profitPerAction)}/action, ${formatKMB(profitData.profitPerHour)}/hour, ${formatKMB(profitPerDay)}/day</div>`;
            html += '</div>';
        }

        return html;
    }

    /**
     * Inject expected value display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} evData - Expected value calculation data
     * @param {boolean} isCollectionTooltip - True if this is a collection tooltip
     */
    injectExpectedValueDisplay(tooltipElement, evData, isCollectionTooltip = false, keyPrice = 0, keyName = null) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        if (tooltipText.querySelector('.market-ev-injected')) {
            return;
        }

        // Create EV display container
        const evDiv = dom.createStyledDiv(
            { color: config.COLOR_TOOLTIP_INFO, marginTop: '8px' },
            '',
            'market-ev-injected'
        );

        // Build EV display
        let html = '<div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">';

        // Header
        html += '<div style="font-weight: bold; margin-bottom: 4px;">EXPECTED VALUE</div>';
        html += '<div style="font-size: 0.9em; margin-left: 8px;">';

        // Expected value. Drops nobody can price contributed nothing to the total, so it is a
        // lower bound rather than an estimate — the display says which of the two it is.
        const evPrefix = evData.isPartial ? '\u2265 ' : '';
        const evSuffix = evData.isPartial
            ? ` <span style="color: ${config.COLOR_TEXT_SECONDARY}; font-weight: normal;">(${evData.missingCount} drop${evData.missingCount === 1 ? '' : 's'} unpriced)</span>`
            : '';
        html += `<div style="color: ${config.COLOR_TOOLTIP_PROFIT}; font-weight: bold;">Expected Return: ${evPrefix}${formatTooltipPrice(evData.expectedValue)}${evSuffix}</div>`;
        if (keyPrice > 0) {
            const keyLabel = keyName ? `Key Cost (${keyName})` : 'Key Cost';
            html += `<div style="color: ${config.COLOR_TOOLTIP_LOSS};">- ${keyLabel}: ${formatTooltipPrice(keyPrice)}</div>`;
            html += `<div style="color: ${config.COLOR_TOOLTIP_PROFIT}; font-weight: bold;">Net Value: ${formatTooltipPrice(evData.expectedValue - keyPrice)}</div>`;
        }

        html += '</div>'; // Close summary section

        // Drop breakdown (if configured to show)
        const showDropsSetting = config.getSettingValue('expectedValue_showDrops', 'All');

        if (showDropsSetting !== 'None' && evData.drops.length > 0) {
            html += '<div style="border-top: 1px solid rgba(255,255,255,0.2); margin: 8px 0;"></div>';

            // Determine how many drops to show
            let dropsToShow = evData.drops;
            let headerLabel = 'All Drops';

            if (showDropsSetting === 'Top 5') {
                dropsToShow = evData.drops.slice(0, 5);
                headerLabel = 'Top 5 Drops';
            } else if (showDropsSetting === 'Top 10') {
                dropsToShow = evData.drops.slice(0, 10);
                headerLabel = 'Top 10 Drops';
            }

            html += `<div style="font-weight: bold; margin-bottom: 4px;">${headerLabel} (${evData.drops.length} total):</div>`;
            html += '<div style="font-size: 0.9em; margin-left: 8px;">';

            // List each drop
            for (const drop of dropsToShow) {
                if (!drop.hasPriceData) {
                    // Show item without price data in gray
                    html += `<div style="color: ${config.COLOR_TEXT_SECONDARY};">• ${drop.itemName} (${formatPercentage(drop.dropRate, 2)}): ${drop.avgCount.toFixed(2)} avg → No price data</div>`;
                } else {
                    // Format drop rate percentage
                    const dropRatePercent = formatPercentage(drop.dropRate, 2);

                    // Show full drop breakdown (formatPercentage already appends '%')
                    html += `<div>• ${drop.itemName} (${dropRatePercent}): ${drop.avgCount.toFixed(2)} avg → ${formatTooltipPrice(drop.expectedValue)}</div>`;
                }
            }

            html += '</div>'; // Close drops list

            // Show total
            html += '<div style="border-top: 1px solid rgba(255,255,255,0.2); margin: 4px 0;"></div>';
            html += `<div style="font-size: 0.9em; margin-left: 8px; font-weight: bold;">Total from ${evData.drops.length} drops: ${formatTooltipPrice(evData.expectedValue)}</div>`;
            if (keyPrice > 0) {
                html += `<div style="font-size: 0.9em; margin-left: 8px; font-weight: bold;">Net after key: ${formatTooltipPrice(evData.expectedValue - keyPrice)}</div>`;
            }
        }

        html += '</div>'; // Close main container

        evDiv.innerHTML = html;

        tooltipText.appendChild(evDiv);
    }

    /**
     * Find gathering sources for an item
     * @param {string} itemHrid - Item HRID
     * @returns {Object|null} { soloActions: [...], zoneActions: [...] }
     */
    async findGatheringSources(itemHrid) {
        const gameData = dataManager.getInitClientData();
        if (!gameData || !gameData.actionDetailMap) {
            return null;
        }

        const GATHERING_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

        const soloActions = [];
        const zoneActions = [];

        // Search through all actions
        for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
            // Skip non-gathering actions
            if (!GATHERING_TYPES.includes(action.type)) {
                continue;
            }

            // Check if this action produces our item
            let foundInDrop = false;
            let dropRate = 0;
            let isSolo = false;

            // Check drop table (both solo and zone actions)
            if (action.dropTable) {
                for (const drop of action.dropTable) {
                    if (drop.itemHrid === itemHrid) {
                        foundInDrop = true;
                        dropRate = drop.dropRate;
                        // Solo gathering has 100% drop rate (dropRate === 1)
                        // Zone gathering has < 100% drop rate
                        isSolo = dropRate === 1;
                        break;
                    }
                }
            }

            // Check rare drop table (rare finds - always zone actions)
            if (!foundInDrop && action.rareDropTable) {
                for (const drop of action.rareDropTable) {
                    if (drop.itemHrid === itemHrid) {
                        foundInDrop = true;
                        dropRate = drop.dropRate;
                        isSolo = false; // Rare drops are never solo
                        break;
                    }
                }
            }

            if (foundInDrop || isSolo) {
                const actionData = {
                    actionHrid,
                    actionName: action.name,
                    dropRate,
                };

                if (isSolo) {
                    soloActions.push(actionData);
                } else {
                    zoneActions.push(actionData);
                }
            }
        }

        // Only return if we found something
        if (soloActions.length === 0 && zoneActions.length === 0) {
            return null;
        }

        // Calculate profit for solo actions
        for (const action of soloActions) {
            const profitData = await calculateGatheringProfit(action.actionHrid);
            if (profitData) {
                action.itemsPerHour = profitData.baseOutputs?.[0]?.itemsPerHour || 0;
                action.profitPerHour = profitData.profitPerHour || 0;
            }
        }

        // Calculate items/hr for zone actions using calculateGatheringProfit for accuracy
        // (accounts for speed bonuses, gathering quantity bonus, efficiency multiplier, and avg drop amount)
        for (const action of zoneActions) {
            const profitData = await calculateGatheringProfit(action.actionHrid);
            const output = profitData?.baseOutputs?.find((o) => o.itemHrid === itemHrid);
            const itemsPerHour = output?.itemsPerHour ?? 0;

            // For rare drops (< 1%), store items/day instead for better readability
            // For regular drops (>= 1%), store items/hr
            if (action.dropRate < 0.01) {
                action.itemsPerDay = itemsPerHour * 24;
                action.isRareDrop = true;
            } else {
                action.itemsPerHour = itemsPerHour;
                action.isRareDrop = false;
            }
        }

        return { soloActions, zoneActions };
    }

    /**
     * Inject gathering display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} gatheringData - { soloActions: [...], zoneActions: [...] }
     * @param {boolean} isCollectionTooltip - True if collection tooltip
     */
    injectGatheringDisplay(tooltipElement, gatheringData, isCollectionTooltip = false) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        if (tooltipText.querySelector('.market-gathering-injected')) {
            return;
        }

        // Filter out rare drops if setting is disabled
        const showRareDrops = config.getSetting('itemTooltip_gatheringRareDrops');
        let zoneActions = gatheringData.zoneActions;
        if (!showRareDrops) {
            zoneActions = zoneActions.filter((action) => !action.isRareDrop);
        }

        // Skip if no actions to show
        if (gatheringData.soloActions.length === 0 && zoneActions.length === 0) {
            return;
        }

        // Create gathering display container
        const gatheringDiv = dom.createStyledDiv(
            { color: config.COLOR_TOOLTIP_INFO, marginTop: '8px' },
            '',
            'market-gathering-injected'
        );

        let html = '<div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">';
        html += '<div style="font-weight: bold; margin-bottom: 4px;">GATHERING</div>';

        // Solo actions section
        if (gatheringData.soloActions.length > 0) {
            html += '<div style="font-size: 0.9em; margin-left: 8px; margin-bottom: 6px;">';
            html += '<div style="font-weight: 500; margin-bottom: 2px;">Solo:</div>';

            for (const action of gatheringData.soloActions) {
                const itemsPerHourStr = action.itemsPerHour ? Math.round(action.itemsPerHour) : '?';
                const profitStr = action.profitPerHour ? formatKMB(Math.round(action.profitPerHour)) : '?';
                const profitDayStr = action.profitPerHour ? formatKMB(Math.round(action.profitPerHour * 24)) : '?';

                html += `<div style="margin-left: 8px;">• ${action.actionName}: ${itemsPerHourStr} items/hr | ${profitStr}/hr (${profitDayStr}/day)</div>`;
            }

            html += '</div>';
        }

        // Zone actions section
        if (zoneActions.length > 0) {
            html += '<div style="font-size: 0.9em; margin-left: 8px;">';
            html += '<div style="font-weight: 500; margin-bottom: 2px;">Found in:</div>';

            for (const action of zoneActions) {
                // Use more decimal places for very rare drops (< 0.1%)
                const percentValue = action.dropRate * 100;
                const dropRatePercent = percentValue < 0.1 ? percentValue.toFixed(4) : percentValue.toFixed(1);

                // Show items/day for rare drops (< 1%), items/hr for regular drops
                let itemsDisplay;
                if (action.isRareDrop) {
                    const itemsPerDayStr = action.itemsPerDay ? action.itemsPerDay.toFixed(2) : '?';
                    itemsDisplay = `${itemsPerDayStr} items/day`;
                } else {
                    const itemsPerHourStr = action.itemsPerHour ? Math.round(action.itemsPerHour) : '?';
                    itemsDisplay = `${itemsPerHourStr} items/hr`;
                }

                html += `<div style="margin-left: 8px;">• ${action.actionName}: ${itemsDisplay} (${dropRatePercent}% drop)</div>`;
            }

            html += '</div>';
        }

        html += '</div>'; // Close main container

        gatheringDiv.innerHTML = html;

        tooltipText.appendChild(gatheringDiv);
    }

    /**
     * Inject multi-action profit display into tooltip
     * Shows all profitable actions (craft, coinify, decompose, transmute) with best highlighted
     * @param {Element} tooltipElement - Tooltip element
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @param {boolean} isCollectionTooltip - True if this is a collection tooltip
     */
    async injectMultiActionProfitDisplay(tooltipElement, itemHrid, enhancementLevel, isCollectionTooltip = false) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        if (tooltipText.querySelector('.market-multi-action-injected')) {
            return;
        }

        // Collect alchemy profit data (craft profit is shown separately via injectProfitDisplay)
        const allProfits = [];

        // Try alchemy profits (coinify, decompose, transmute)
        const alchemyProfits = alchemyProfitCalculator.calculateAllProfits(itemHrid, enhancementLevel);

        if (alchemyProfits.coinify) {
            allProfits.push(alchemyProfits.coinify);
        }
        if (alchemyProfits.decompose) {
            allProfits.push(alchemyProfits.decompose);
        }
        if (alchemyProfits.transmute) {
            allProfits.push(alchemyProfits.transmute);
        }

        // If no profitable actions found, return
        if (allProfits.length === 0) {
            return;
        }

        // Sort by profitPerHour descending
        allProfits.sort((a, b) => b.profitPerHour - a.profitPerHour);

        // Check if item is craftable (has a production action)
        const isCraftable = profitCalculator.findProductionAction(itemHrid) !== null;

        // Create profit display container
        const profitDiv = dom.createStyledDiv(
            { color: config.COLOR_TOOLTIP_INFO, marginTop: '8px' },
            '',
            'market-multi-action-injected'
        );

        // Build display
        let html = '<div style="border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;">';

        // Show heading based on whether item is craftable
        const heading = isCraftable ? 'Alternative Actions:' : 'Profits:';
        html += `<div style="font-weight: bold; margin-bottom: 4px;">${heading}</div>`;
        html += '<div style="font-size: 0.9em; margin-left: 8px;">';

        for (let i = 0; i < allProfits.length; i++) {
            const profit = allProfits[i];
            const label = profit.actionType.charAt(0).toUpperCase() + profit.actionType.slice(1);
            const color = profit.profitPerHour >= 0 ? config.COLOR_TOOLTIP_INFO : config.COLOR_TOOLTIP_LOSS;
            html += `<div style="color: ${color};">• ${label}: ${formatKMB(profit.profitPerHour)}/hr`;

            // Show profit per action for alchemy actions
            if (profit.profitPerAction !== undefined) {
                const perActionColor = profit.profitPerAction >= 0 ? 'inherit' : config.COLOR_TOOLTIP_LOSS;
                html += ` <span style="opacity: 0.7; color: ${perActionColor};">(${formatKMB(profit.profitPerAction)}/action)</span>`;
            }

            // Show item icons for the winning catalyst and/or tea (silence = no modifiers needed)
            if (profit.winningCatalystHrid || profit.winningTeaUsed) {
                const spriteUrl = getItemsSpriteUrl();
                if (spriteUrl) {
                    html += ` <span style="display:inline-flex;align-items:center;gap:2px;vertical-align:middle;">`;
                    if (profit.winningCatalystHrid) {
                        const slug = profit.winningCatalystHrid.split('/').pop();
                        html += `<svg role="img" style="width:14px;height:14px;"><use href="${spriteUrl}#${slug}"></use></svg>`;
                    }
                    if (profit.winningTeaUsed) {
                        html += `<svg role="img" style="width:14px;height:14px;"><use href="${spriteUrl}#catalytic_tea"></use></svg>`;
                    }
                    html += `</span>`;
                }
            }

            html += '</div>';
        }

        html += '</div>';

        html += '</div>';

        profitDiv.innerHTML = html;
        tooltipText.appendChild(profitDiv);
    }

    /**
     * Get ability status for an ability book
     * @param {string} itemHrid - Item HRID (e.g., /items/ice_shield)
     * @returns {Object|null} {learned, level, xp, xpToNext, percentToNext, abilityName,
     *   loadouts, heldBooks, levelWithHeld, freshCost} or null
     */
    getAbilityStatus(itemHrid) {
        const characterData = dataManager.characterData;
        const gameData = dataManager.getInitClientData();

        if (!characterData || !gameData) {
            return null;
        }

        // Convert item HRID to ability HRID (e.g., /items/ice_shield -> /abilities/ice_shield)
        const abilityHrid = itemHrid.replace('/items/', '/abilities/');

        // Get ability details from game data
        const abilityDetails = gameData.abilityDetailMap?.[abilityHrid];

        if (!abilityDetails) {
            return null;
        }

        // Which saved loadouts slot this ability, by name — the answer to "can
        // I coinify these books, or does something still use it"
        const loadouts = [];
        for (const loadout of Object.values(characterData.characterLoadoutMap || {})) {
            if (!loadout?.name) continue;
            if (Object.values(loadout.abilityMap || {}).includes(abilityHrid)) loadouts.push(loadout.name);
        }

        // What reading every held copy would reach, from where the ability is
        const heldBooks = (dataManager.getInventory?.() || [])
            .filter((item) => item?.itemHrid === itemHrid && item?.itemLocationHrid === '/item_locations/inventory')
            .reduce((sum, item) => sum + (Number(item.count) || 0), 0);
        const xpPerBook = Number(gameData.itemDetailMap?.[itemHrid]?.abilityBookDetail?.experienceGain) || 0;

        // Check if player has this ability
        const ability = characterData.characterAbilities?.find((a) => a.abilityHrid === abilityHrid);

        if (!ability) {
            // Not learned. The first held book teaches; the rest level.
            return {
                learned: false,
                abilityName: abilityDetails.name,
                loadouts,
                heldBooks,
                levelWithHeld:
                    heldBooks > 0
                        ? levelAtExperience(gameData.levelExperienceTable, (heldBooks - 1) * xpPerBook)
                        : null,
            };
        }

        // Learned - calculate progress to next level
        const currentLevel = ability.level || 0;
        const currentXp = ability.experience || 0;
        const levelXpTable = gameData.levelExperienceTable;

        if (!levelXpTable) {
            return {
                learned: true,
                level: currentLevel,
                abilityName: abilityDetails.name,
            };
        }

        // Calculate XP to next level
        const nextLevel = currentLevel + 1;
        if (nextLevel > 200 || !levelXpTable[nextLevel]) {
            // Max level
            return {
                learned: true,
                level: currentLevel,
                abilityName: abilityDetails.name,
                maxLevel: true,
            };
        }

        const currentLevelXp = levelXpTable[currentLevel] || 0;
        const nextLevelXp = levelXpTable[nextLevel];
        const xpIntoLevel = currentXp - currentLevelXp;
        const xpToNext = nextLevelXp - currentXp;
        const xpForLevel = nextLevelXp - currentLevelXp;
        const percentToNext = xpIntoLevel / xpForLevel;

        return {
            learned: true,
            level: currentLevel,
            xp: currentXp,
            xpToNext,
            percentToNext,
            abilityName: abilityDetails.name,
            loadouts,
            heldBooks,
            levelWithHeld:
                heldBooks > 0 && xpPerBook > 0
                    ? levelAtExperience(levelXpTable, currentXp + heldBooks * xpPerBook)
                    : null,
            // What the level already reached would cost to buy today, from
            // nothing — the books to learn and level it, at the book's price
            freshCost: explainAbilityCost(abilityHrid, currentLevel),
        };
    }

    /**
     * Inject ability status display into tooltip
     * @param {Element} tooltipElement - Tooltip element
     * @param {Object} abilityStatus - Ability status data
     * @param {boolean} isCollectionTooltip - Whether this is a collection tooltip
     */
    injectAbilityStatusDisplay(tooltipElement, abilityStatus, isCollectionTooltip) {
        const tooltipText = isCollectionTooltip
            ? tooltipElement.querySelector('div[class*="Collection_tooltipContent"]')
            : tooltipElement.querySelector('div[class*="ItemTooltipText_itemTooltipText"]');

        if (!tooltipText) {
            return;
        }

        // Check if already injected
        if (tooltipText.querySelector('.mwi-ability-status')) {
            return;
        }

        const statusDiv = document.createElement('div');
        statusDiv.className = 'mwi-ability-status';
        statusDiv.style.cssText = 'margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px;';

        let html = '';

        // What reading every held copy would reach, said the same way for a
        // learned book and an unlearned one
        const heldLine =
            abilityStatus.heldBooks > 0 && abilityStatus.levelWithHeld !== null
                ? `<div>Books held: ${numberFormatter(abilityStatus.heldBooks)} \u2192 Lv ${abilityStatus.levelWithHeld}</div>`
                : '';

        if (!abilityStatus.learned) {
            // Not learned
            html += `<div style="color: ${config.COLOR_TOOLTIP_LOSS}; font-weight: 600;">`;
            html += `\u26A0 Unlearned</div>`;
            if (heldLine) {
                html += `<div style="margin-top: 4px; margin-left: 8px; font-size: 0.9em;">${heldLine}</div>`;
            }
        } else {
            // Learned
            html += `<div style="color: ${config.COLOR_TOOLTIP_INFO}; font-weight: 600;">`;
            html += `\u2714 Learned</div>`;

            // Show level and progress
            html += `<div style="margin-top: 4px; margin-left: 8px; font-size: 0.9em;">`;
            html += `<div>Level: ${abilityStatus.level}</div>`;

            if (abilityStatus.maxLevel) {
                html += `<div style="color: ${config.COLOR_TOOLTIP_INFO};">Max Level Reached</div>`;
            } else if (abilityStatus.percentToNext !== undefined) {
                html += `<div>Progress: ${formatPercentage(abilityStatus.percentToNext)}</div>`;
                html += `<div style="opacity: 0.7;">XP to Next: ${numberFormatter(abilityStatus.xpToNext)}</div>`;
            }

            html += heldLine;

            // What the level already reached would cost to buy today \u2014 the
            // sunk value a "should I coinify these" decision weighs
            const fresh = abilityStatus.freshCost;
            if (fresh?.total > 0) {
                html +=
                    `<div style="opacity: 0.7;">Fresh to Lv ${abilityStatus.level}: ` +
                    `${formatTooltipPrice(Math.round(fresh.total))} (${numberFormatter(Math.ceil(fresh.books))} books)</div>`;
            }

            html += '</div>';
        }

        // Named rather than counted: "in 2 loadouts" still makes you open the
        // loadouts tab to find out which two
        if (abilityStatus.loadouts?.length) {
            html +=
                `<div style="margin-top: 4px; color: ${config.COLOR_TOOLTIP_INFO}; font-size: 0.9em;">` +
                `In loadouts: ${abilityStatus.loadouts.join(', ')}</div>`;
        }

        // Nothing worth a bordered section (e.g. a maxed ability hovered with no
        // held books and no loadouts) — leave the tooltip untouched.
        if (!html) {
            return;
        }

        statusDiv.innerHTML = html;
        tooltipText.appendChild(statusDiv);
    }

    /**
     * Add the ability-status block to a tooltip shown for an ability itself
     * (in a loadout or ability slot), not its book item. Reuses the book
     * tooltip's computation; dedups per ability on the popper.
     * @param {HTMLElement} tooltipElement - The MuiTooltip popper
     * @param {string} abilityHrid - e.g. '/abilities/precision'
     */
    /**
     * Map an ability's display name (as the tooltip prints it) back to its hrid.
     * @param {string} name - e.g. 'Berserk'
     * @returns {string|null} e.g. '/abilities/berserk', or null if unknown
     */
    abilityHridFromName(name) {
        if (!name) return null;
        const map = dataManager.getInitClientData()?.abilityDetailMap;
        if (!map) return null;
        const wanted = name.toLowerCase();
        for (const [hrid, detail] of Object.entries(map)) {
            if ((detail?.name || '').toLowerCase() === wanted) return hrid;
        }
        return null;
    }

    /**
     * The level an ability tooltip is showing, from its "Level: N" line. On
     * another player's profile this is that player's level.
     * @param {HTMLElement} abilityTooltip
     * @returns {number} the level, or 0 if not found
     */
    _abilityTooltipLevel(abilityTooltip) {
        const digits = gameDigitsSource({ decimal: false });
        const match = (abilityTooltip.textContent || '').match(new RegExp(`Level:\\s*(${digits})`));
        return match ? Math.trunc(parseGameNumber(match[1], 0)) : 0;
    }

    /**
     * Append a "Fresh to Lv N" line to an ability's own tooltip, priced at the
     * level the tooltip shows (so it is correct on other players' profiles).
     * @param {HTMLElement} tooltipElement - The MuiTooltip popper
     * @param {HTMLElement} abilityTooltip - The ability-tooltip content node
     * @param {string} abilityHrid - e.g. '/abilities/berserk'
     */
    injectAbilityFreshCost(tooltipElement, abilityTooltip, abilityHrid) {
        if (tooltipElement.dataset.abilityFreshProcessed === abilityHrid) {
            return;
        }
        tooltipElement.dataset.abilityFreshProcessed = abilityHrid;

        const level = this._abilityTooltipLevel(abilityTooltip);
        if (!level || level < 1) return;

        const fresh = explainAbilityCost(abilityHrid, level);
        if (!fresh || !(fresh.total > 0)) return;

        const container = tooltipElement.querySelector('.MuiTooltip-tooltip') || tooltipElement;
        if (container.querySelector('.mwi-ability-fresh')) return;

        const div = document.createElement('div');
        div.className = 'mwi-ability-fresh';
        div.style.cssText =
            'margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8px; opacity: 0.85;';
        div.textContent =
            `Fresh to Lv ${level}: ${formatTooltipPrice(Math.round(fresh.total))} ` +
            `(${numberFormatter(Math.ceil(fresh.books))} books)`;
        container.appendChild(div);
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

            uninstallEnhancementSourceToggle();

            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Tooltip Prices] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const tooltipPrices = new TooltipPrices();

export default tooltipPrices;
