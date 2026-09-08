/** @vitest-environment happy-dom */
/**
 * Tooltip prices — the routing of a popper by the shared tooltip observer's
 * classification (item / collection / ability / other) and the per-item
 * dedupe on top of it. The price, profit and enhancement maths live in their
 * own modules and are mocked away here.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const observerState = vi.hoisted(() => ({ handler: null }));
const settings = vi.hoisted(() => ({ hideInEnhanceSelector: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => (id === 'itemTooltip_hideInEnhanceSelector' ? settings.hideInEnhanceSelector : true),
        getSettingValue: (_id, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_BORDER: '#444',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/cheese': { name: 'Cheese' },
        '/items/griffin_bulwark': { name: 'Griffin Bulwark' },
    };
    return {
        default: {
            getInitClientData: () => ({
                itemDetailMap,
                abilityDetailMap: { '/abilities/berserk': { name: 'Berserk' } },
            }),
            getItemDetails: (hrid) => itemDetailMap[hrid] || null,
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null },
}));
vi.mock('./profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('./alchemy-profit-calculator.js', () => ({ default: { calculateAllProfits: async () => ({}) } }));
vi.mock('./expected-value-calculator.js', () => ({ default: { calculateExpectedValue: () => null } }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    buildEnhancementTooltipHTML: () => '',
    buildEnhancementMilestonesHTML: () => '',
    getProductionCost: () => 0,
    installEnhancementSourceToggle: () => {},
    uninstallEnhancementSourceToggle: () => {},
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ enhancementParamsFor: () => null }));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({ ask: 10, bid: 9 }) }));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ total: 1234, books: 3 }),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: () => 0,
    calculatePriceAfterTax: (price) => price,
}));
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => 0 }));
vi.mock('../../utils/game-lookups.js', () => ({ getActionHridFromName: () => null }));
vi.mock('../../utils/production-index.js', () => ({ findProducingAction: () => null }));
vi.mock('../../utils/dom.js', () => ({
    default: {
        addStyles: vi.fn(),
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, text, className) => {
            const div = document.createElement('div');
            div.className = className;
            div.textContent = text;
            return div;
        },
    },
}));

const { default: tooltipPrices, ownUseCompare, ownUseLine } = await import('./tooltip-prices.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} innerHTML
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function popper(innerHTML, className = 'MuiTooltip-popper') {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = `<div class="MuiTooltip-tooltip">${innerHTML}</div>`;
    document.body.appendChild(el);
    return el;
}

const itemTooltip = (name) =>
    popper(`<div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>${name}</span></div></div>`);

const abilityTooltip = () =>
    popper(
        `<div class="Ability_abilityTooltip__1"><div class="Ability_name__2">Berserk</div><div>Level: 42</div></div>`
    );

/** Let the async handler run past its awaits */
const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(async () => {
    document.body.innerHTML = '';
    settings.hideInEnhanceSelector = false;
    await tooltipPrices.initialize();
});

afterEach(() => {
    tooltipPrices.disable();
    tooltipObserver.disable();
});

describe('routing by classification', () => {
    test('subscribes to the shared observer', () => {
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(true);
    });

    test('an item tooltip gets its price section, keyed on the item name', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Cheese');
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('the same popper handed over twice is processed once', async () => {
        const el = itemTooltip('Cheese');
        observerState.handler(el);
        observerState.handler(el);
        await settle();
        expect(el.querySelectorAll('.market-price-injected')).toHaveLength(1);
    });

    test('an enhanced item is priced at its enhancement level, not as the base item', async () => {
        const el = itemTooltip('Griffin Bulwark +7');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBe('Griffin Bulwark +7');
        // Enhanced items skip the craft-profit path; the price section still lands
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('an ability tooltip gets its fresh-cost line and nothing else', async () => {
        const el = abilityTooltip();
        observerState.handler(el);
        await settle();
        expect(el.querySelector('.mwi-ability-fresh')?.textContent).toContain('Fresh to Lv 42');
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    describe('_abilityTooltipLevel — locale-grouped level', () => {
        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        const tooltipWithLevel = (levelText) =>
            popper(
                `<div class="Ability_abilityTooltip__1"><div class="Ability_name__2">Berserk</div>` +
                    `<div>Level: ${levelText}</div></div>`
            );

        test('en-US comma grouping', () => {
            localStorage.setItem('i18nextLng', 'en-US');
            _resetGameNumberSeparators();
            expect(tooltipPrices._abilityTooltipLevel(tooltipWithLevel('1,042'))).toBe(1042);
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+` reads "Level: 1.042" as "Level: 1": the
            // period isn't in the class, so the match stops at the first group
            // boundary.
            localStorage.setItem('i18nextLng', 'de-DE');
            _resetGameNumberSeparators();
            expect(tooltipPrices._abilityTooltipLevel(tooltipWithLevel('1.042'))).toBe(1042);
        });
    });

    test('a tooltip that is neither is left alone', async () => {
        const el = popper('<div class="QueuedActions_queuedActionsTooltip__1">3 queued</div>');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
        expect(el.querySelector('.market-price-injected')).toBeNull();
    });

    test('a popper that is not a tooltip is not touched', async () => {
        const el = popper('<div class="ItemTooltipText_name__2JAHA"><span>Cheese</span></div>', 'MuiPopper-root');
        observerState.handler(el);
        await settle();
        expect(el.dataset.pricesProcessedItem).toBeUndefined();
    });

    test('handleTooltip classifies for itself when called without a classification', async () => {
        const el = itemTooltip('Cheese');
        await tooltipPrices.handleTooltip(el);
        expect(el.querySelector('.market-price-injected')).not.toBeNull();
    });

    test('disable unsubscribes', () => {
        tooltipPrices.disable();
        expect(tooltipObserver.subscribers.has('TooltipPrices')).toBe(false);
    });
});

describe('own-use make vs buy', () => {
    /** Per-hour figures for a bench making 100 items from 4M of spend */
    const data = (overrides = {}) => ({
        totalItemsPerHour: 100,
        materialCostPerHour: 3_500_000,
        totalTeaCostPerHour: 500_000,
        itemPrice: { ask: 50_000, bid: 45_000 },
        pricingMode: 'hybrid',
        ...overrides,
    });

    test('the make side is the whole hourly spend over the whole hourly output', () => {
        const compared = ownUseCompare(data());
        // (3.5M + 500K) / 100 — teas amortized over efficiency's extra items
        expect(compared.make).toBe(40_000);
        expect(compared.buy).toBe(50_000);
        expect(compared.cheaper).toBe('make');
        expect(compared.saves).toBe(10_000);
    });

    test('neither side carries a sales tax', () => {
        // Buying costs exactly the ask; making costs exactly the bench spend.
        // A consumed item is never sold, so no side is taxed.
        const compared = ownUseCompare(data({ itemPrice: { ask: 40_000, bid: 1 } }));
        expect(compared.cheaper).toBe('even');
    });

    test('within a percent of the buy price no winner is called', () => {
        const compared = ownUseCompare(data({ itemPrice: { ask: 40_300, bid: 0 } }));
        expect(compared.cheaper).toBe('even');
        // The band is a percent of the buy side whichever book it came from, so
        // on a bid basis it narrows with the number it qualifies: 40.3K is
        // within a percent of itself, 40.5K is not once the reference is 40.0K
        const bidBand = ownUseCompare(data({ pricingMode: 'patientBuy', itemPrice: { ask: 99_999, bid: 40_300 } }));
        expect(bidBand.cheaper).toBe('even');
        const outsideBidBand = ownUseCompare(
            data({ pricingMode: 'patientBuy', itemPrice: { ask: 99_999, bid: 40_500 } })
        );
        expect(outsideBidBand.cheaper).toBe('make');
    });

    test('an item with no asks still prices the making of it', () => {
        const compared = ownUseCompare(data({ itemPrice: { ask: 0, bid: 9_999 } }));
        expect(compared.make).toBe(40_000);
        expect(compared.buy).toBeNull();
        expect(ownUseLine(compared).text).toBe('Own use: make ≈40.0K (no asks)');
    });

    test('each pricing mode buys on the side that mode would actually pay', () => {
        // getPricingMode's buy column: conservative/hybrid insta-buy at ask,
        // optimistic/patientBuy wait at bid
        for (const mode of ['conservative', 'hybrid']) {
            const compared = ownUseCompare(data({ pricingMode: mode }));
            expect(compared.priceBasis).toBe('ask');
            expect(compared.buy).toBe(50_000);
        }
        for (const mode of ['optimistic', 'patientBuy']) {
            const compared = ownUseCompare(data({ pricingMode: mode }));
            expect(compared.priceBasis).toBe('bid');
            expect(compared.buy).toBe(45_000);
        }
    });

    test('a mode nobody recognises, or none at all, lands on ask like the make side did', () => {
        // config's mock answers getSettingValue with the caller's fallback,
        // which for profitCalc_pricingMode is 'hybrid'
        expect(ownUseCompare(data({ pricingMode: undefined })).priceBasis).toBe('ask');
        expect(ownUseCompare(data({ pricingMode: 'sideways' })).priceBasis).toBe('ask');
    });

    test('the line names the book the buy figure came from', () => {
        expect(ownUseLine(ownUseCompare(data({ pricingMode: 'hybrid' }))).text).toContain('buy 50.0K (ask)');
        expect(ownUseLine(ownUseCompare(data({ pricingMode: 'optimistic' }))).text).toContain('buy 45.0K (bid)');
        // The even line declares it too — it is still a claim about two prices
        const even = ownUseCompare(data({ pricingMode: 'optimistic', itemPrice: { ask: 50_000, bid: 40_000 } }));
        expect(ownUseLine(even).text).toBe('Own use: make ≈40.0K vs buy 40.0K (bid) — even');
    });

    test('a missing price under a bid mode says the bids are missing, not that buying is free', () => {
        // An ask sitting right there is no substitute: nobody is bidding, and
        // reading the other book would quote a price this mode never pays
        const compared = ownUseCompare(data({ pricingMode: 'optimistic', itemPrice: { ask: 50_000, bid: 0 } }));
        expect(compared.buy).toBeNull();
        expect(compared.saves).toBeNull();
        expect(compared.cheaper).toBeNull();
        expect(ownUseLine(compared).text).toBe('Own use: make ≈40.0K (no bids)');
        // And the mirror: an ask mode ignores a healthy bid
        const askSide = ownUseCompare(data({ pricingMode: 'conservative', itemPrice: { ask: 0, bid: 45_000 } }));
        expect(askSide.buy).toBeNull();
        expect(ownUseLine(askSide).text).toBe('Own use: make ≈40.0K (no asks)');
    });

    test('a bid mode does not tilt the verdict toward making by costing the alternative at ask', () => {
        // Materials came in at bid upstream, so the bench is cheap; quoting the
        // alternative at ask would have called this 'make' on the spread alone
        const compared = ownUseCompare(
            data({ pricingMode: 'patientBuy', materialCostPerHour: 3_800_000, itemPrice: { ask: 50_000, bid: 41_000 } })
        );
        expect(compared.buy).toBe(41_000);
        expect(compared.cheaper).toBe('buy');
        expect(compared.saves).toBe(2_000);
    });

    test('a make side that cannot be priced says nothing at all', () => {
        expect(ownUseCompare(data({ totalItemsPerHour: 0 }))).toBeNull();
        expect(ownUseCompare(null)).toBeNull();
        expect(ownUseLine(null)).toBeNull();
    });

    test('an unpriceable material or tea silences the line rather than riding as free', () => {
        // The calculator costs a missing price at zero, so the per-hour spend
        // still parses — only the missingPrice flags say the figure is fiction
        const missingMaterial = data({ materialCosts: [{ itemHrid: '/items/coal', missingPrice: true }] });
        expect(ownUseCompare(missingMaterial)).toBeNull();
        const missingTea = data({ teaCosts: [{ itemHrid: '/items/artisan_tea', missingPrice: true }] });
        expect(ownUseCompare(missingTea)).toBeNull();
        // Priced entries keep the line
        const priced = data({
            materialCosts: [{ itemHrid: '/items/coal', missingPrice: false }],
            teaCosts: [{ itemHrid: '/items/artisan_tea', missingPrice: false }],
        });
        expect(ownUseCompare(priced)).not.toBeNull();
    });

    test('a recipe with several outputs is not costed as if one output paid for all of them', () => {
        const multiOutput = {
            outputItems: [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/whey' }],
        };
        expect(ownUseCompare(data(), multiOutput)).toBeNull();
        // One output — or no action detail to check — leaves the line alone
        expect(ownUseCompare(data(), { outputItems: [{ itemHrid: '/items/cheese' }] })).not.toBeNull();
        expect(ownUseCompare(data(), null)).not.toBeNull();
    });

    test('the line carries the saving and the percent of the price avoided', () => {
        expect(ownUseLine(ownUseCompare(data())).text).toBe(
            'Own use: make ≈40.0K vs buy 50.0K (ask) — save 10.0K (20%)'
        );
        // Buying at 50K instead of making at 80K avoids the 80K — the saving
        // is measured against what the cheaper choice spares you
        const buyingWins = ownUseCompare(data({ materialCostPerHour: 7_500_000 }));
        expect(ownUseLine(buyingWins).text).toContain('save 30.0K (38%)');
    });
});
