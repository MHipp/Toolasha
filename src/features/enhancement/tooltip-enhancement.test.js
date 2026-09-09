/**
 * Tests for the enhancement tooltip's path builder.
 *
 * The interesting question is not what the numbers are — the Markov chain has its own tests —
 * but whether the breakdown the tooltip prints actually adds up to the total it prints beside
 * it. A mirror plan that expands into items the DP never bought produces a table that does not
 * reconcile, and only a sum can catch that.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as mathjs from 'mathjs';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const ITEM = '/items/test_sword';
const MATERIAL = '/items/test_material';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';

// Prices the mocked market answers with. Tuned so mirroring is worth it: the base item and the
// mirror are cheap while every enhancement attempt burns an expensive material.
const REFINED = '/items/test_sword_refined';
// An enhancement recipe with one material nobody quotes, and one that is quoted
const PARTLY_PRICED = '/items/test_dagger';
const UNPRICED_MATERIAL = '/items/unpriced_material';

const prices = {
    [ITEM]: { ask: 100, bid: 90 },
    // The refined piece: the same enhancement bill on a far dearer +0
    [REFINED]: { ask: 400000, bid: 390000 },
    [MATERIAL]: { ask: 5000, bid: 4800 },
    [MIRROR]: { ask: 2000, bid: 1900 },
    [PROTECTION]: { ask: 900000, bid: 850000 },
    [PARTLY_PRICED]: { ask: 100, bid: 90 },
};

/** Settings the mocked config answers with, reset per test */
const settings = vi.hoisted(() => ({ checkboxes: {}, values: {} }));

/** Market prices for enhanced levels, keyed `hrid::level`; empty unless a test sets one */
const enhancedPrices = vi.hoisted(() => ({}));

/** Price-update listeners the module registered with the mocked market API */
const priceListeners = vi.hoisted(() => []);

const gameData = {
    itemDetailMap: {
        [ITEM]: {
            name: 'Test Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: MATERIAL, count: 1 }],
        },
        [REFINED]: {
            name: 'Test Sword (Refined)',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: MATERIAL, count: 1 }],
        },
        [PARTLY_PRICED]: {
            name: 'Test Dagger',
            itemLevel: 10,
            enhancementCosts: [
                { itemHrid: MATERIAL, count: 1 },
                { itemHrid: UNPRICED_MATERIAL, count: 2 },
            ],
        },
        [MATERIAL]: { name: 'Test Material', sellPrice: 100 },
        // Deliberately no sellPrice and no market quote: nothing can price it
        [UNPRICED_MATERIAL]: { name: 'Unpriced Material' },
        [MIRROR]: { name: "Philosopher's Mirror", sellPrice: 1 },
        [PROTECTION]: { name: 'Mirror of Protection', sellPrice: 1 },
    },
    actionDetailMap: {},
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getAchievementBuffFlatBoost: () => 0,
        characterData: null,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        // getSetting answers checkboxes only; getSettingValue is the accessor for text
        // settings. Keeping them distinct here is what makes a getSetting() read of a text
        // setting visible as a test failure rather than a silent false.
        getSetting: (key) => settings.checkboxes[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        COLOR_MIRROR: '#fff',
        COLOR_BORDER: '#fff',
        COLOR_TOOLTIP_INFO: '#fff',
        COLOR_TOOLTIP_PROFIT: '#fff',
        COLOR_TOOLTIP_LOSS: '#fff',
        COLOR_XP_RATE: '#fff',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { on: (cb) => priceListeners.push(cb), getPrice: (hrid) => prices[hrid] || null },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => prices[hrid]?.ask ?? 0,
    getItemPrices: (hrid, level) =>
        level === 0 ? (prices[hrid] ?? null) : (enhancedPrices[`${hrid}::${level}`] ?? null),
}));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => 0,
    getDrinkConcentration: () => 0,
}));

let calculateEnhancementPath;
let buildEnhancementTooltipHTML;
let buildEnhancementMilestonesHTML;
let calculateMinimumSellPrice;
let calculatePerAttemptMaterialCost;
let getCheapestProtectionPrice;
let getRealisticBaseItemPrice;

beforeAll(async () => {
    globalThis.math = mathjs;
    ({
        calculateEnhancementPath,
        buildEnhancementTooltipHTML,
        buildEnhancementMilestonesHTML,
        calculateMinimumSellPrice,
        calculatePerAttemptMaterialCost,
        getCheapestProtectionPrice,
        getRealisticBaseItemPrice,
    } = await import('./tooltip-enhancement.js'));
});

beforeEach(() => {
    settings.checkboxes = {};
    settings.values = {};
    for (const key of Object.keys(enhancedPrices)) delete enhancedPrices[key];
});

const enhancingConfig = {
    enhancingLevel: 100,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
};

describe('calculateEnhancementPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('a traditional path prices the base item, the materials and the protections', () => {
        const data = calculateEnhancementPath(ITEM, 1, enhancingConfig);
        const strategy = data.optimalStrategy;

        const lineItems =
            strategy.baseCost + strategy.materialCost + strategy.protectionCost + (strategy.philosopherMirrorCost || 0);

        expect(lineItems).toBeCloseTo(strategy.totalCost, 6);
    });

    test('a mirrored path is used when mirroring is the cheaper way up', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);

        expect(data.optimalStrategy.usedMirror).toBe(true);
        expect(data.optimalStrategy.mirrorCount).toBeGreaterThan(0);
    });

    test('every mirrored line item together adds up to the quoted total', () => {
        for (let level = 2; level <= 12; level++) {
            const data = calculateEnhancementPath(ITEM, level, enhancingConfig);
            const strategy = data.optimalStrategy;
            if (!strategy.usedMirror) continue;

            const consumed = strategy.consumedItems.reduce((sum, item) => sum + item.totalCost, 0);
            const lineItems = consumed + strategy.philosopherMirrorCost;

            expect(lineItems).toBeCloseTo(strategy.totalCost, 6);
        }
    });

    test('a mirrored line item is priced at what one item at that level costs', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);

        for (const item of data.optimalStrategy.consumedItems) {
            expect(item.quantity).toBeGreaterThan(0);
            expect(item.totalCost).toBeCloseTo(item.quantity * item.costEach, 6);
            // A consumed item is one the plan buys outright, so it is never itself mirrored
            expect(item.level).toBeLessThan(data.targetLevel);
        }
    });

    test('the mirror plan only claims levels the DP actually mirrored', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        const strategy = data.optimalStrategy;

        // Every level named in the breakdown is a real, buildable level
        for (const item of strategy.consumedItems) {
            expect(item.level).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(item.costEach)).toBe(true);
        }
        // The first mirrored level is one the walk back from the target actually reaches
        expect(strategy.mirrorStartLevel).toBeGreaterThanOrEqual(2);
        expect(strategy.mirrorStartLevel).toBeLessThanOrEqual(data.targetLevel);
    });

    test('mirroring is considered at +2, not only from +3 up', () => {
        // Make the mirror nearly free so combining a +0 and a +1 must beat enhancing to +2
        const cheapMirror = { ...prices[MIRROR] };
        prices[MIRROR] = { ask: 1, bid: 1 };
        try {
            const data = calculateEnhancementPath(ITEM, 2, enhancingConfig);
            expect(data.optimalStrategy.usedMirror).toBe(true);
            expect(data.optimalStrategy.mirrorStartLevel).toBe(2);
        } finally {
            prices[MIRROR] = cheapMirror;
        }
    });

    test('protection nobody can price is refused, not costed at zero', () => {
        // The bug the shared sweep engine fixed on the way through. This module
        // used to run every protect-from strategy and leave protectionCost at 0
        // when getCheapestProtectionPrice came back with nothing — which made a
        // protected run free by construction, so it won the minimum at every
        // level and the tooltip quoted a plan whose protections nobody sells.
        const saved = { ...prices };
        // The piece protects itself, so it has to lose its price too before
        // there is genuinely nothing to protect with. The Philosopher's Mirror
        // goes as well, so the answer is a plain enhance path rather than a
        // mirror plan, which is a different shape with no protection line.
        delete prices[PROTECTION];
        delete prices[ITEM];
        delete prices[MIRROR];
        try {
            const data = calculateEnhancementPath(ITEM, 5, enhancingConfig);
            const strategy = data.optimalStrategy;

            expect(strategy.protectFrom).toBe(0);
            expect(strategy.protectionCost).toBe(0);
            expect(strategy.protectionCount).toBe(0);
            expect(strategy.protectionItemHrid).toBeNull();
            // And the quote is the honest, dearer unprotected run
            expect(strategy.materialCost).toBeGreaterThan(0);
            expect(strategy.totalCost).toBeCloseTo(strategy.baseCost + strategy.materialCost, 6);
        } finally {
            Object.assign(prices, saved);
        }
    });

    test('a priced protection still bills protections at what they cost', () => {
        const savedMirror = prices[MIRROR];
        // Priced out of reach, so the quote is a plain enhance path and not a
        // mirror plan — the protection line only exists on the former
        prices[MIRROR] = { ask: 1e12, bid: 1e12 };
        try {
            const strategy = calculateEnhancementPath(ITEM, 5, enhancingConfig).optimalStrategy;

            expect(strategy.protectFrom).toBeGreaterThan(0);
            expect(strategy.protectionItemHrid).toBe(ITEM);
            expect(strategy.protectionCost).toBeCloseTo(strategy.protectionCount * strategy.protectionAskPrice, 6);
        } finally {
            prices[MIRROR] = savedMirror;
        }
    });

    test('time and attempts count only the levels the plan builds', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        const strategy = data.optimalStrategy;

        expect(strategy.totalTime).toBeGreaterThan(0);
        expect(strategy.expectedAttempts).toBeGreaterThan(0);
        // Mirror combinations are instant, so a mirrored path is never slower than the
        // traditional one it replaced
        expect(strategy.totalCost).toBeLessThanOrEqual(strategy.traditionalCost);
    });
});

/**
 * The totals a strategy quotes are enough to compare two strategies and not enough to go and
 * buy anything. The bill is the same arithmetic said as a list, so what it has to be is
 * *consistent with the totals beside it* — a list that does not reconcile is worse than none.
 */
describe('the material bill a path expects to consume', () => {
    /**
     * @param {Array<Object>} bill - A material bill
     * @param {string} kind - Which line kind to total
     * @returns {number} What those lines cost between them
     */
    const spentOn = (bill, kind) =>
        bill.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.totalCost, 0);

    test('a traditional path bills the materials the total already charged for', () => {
        // Only the un-mirrored levels: a mirror plan reports materialCost 0 because its whole
        // cost is folded into the items it consumes, and its bill is checked separately below
        let checked = 0;
        for (let level = 1; level <= 10; level++) {
            const strategy = calculateEnhancementPath(ITEM, level, enhancingConfig).optimalStrategy;
            if (strategy.usedMirror) continue;
            checked += 1;

            expect(spentOn(strategy.materialBill, 'material')).toBeCloseTo(strategy.materialCost, 6);
            expect(spentOn(strategy.materialBill, 'protection')).toBeCloseTo(strategy.protectionCost, 6);
        }
        expect(checked).toBeGreaterThan(0);
    });

    test('the count is attempts times the per-attempt recipe, as an expectation', () => {
        const strategy = calculateEnhancementPath(ITEM, 4, enhancingConfig).optimalStrategy;
        const material = strategy.materialBill.find((line) => line.itemHrid === MATERIAL);

        // One material per attempt, so the count is the expected attempts themselves —
        // fractional, because an expectation is not a number of trips to the marketplace
        expect(material.count).toBeCloseTo(strategy.expectedAttempts, 6);
        expect(material.name).toBe('Test Material');
    });

    test('a mirrored path bills the mirrors and the base copies it combines', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        const strategy = data.optimalStrategy;
        expect(strategy.usedMirror).toBe(true);

        const mirrors = strategy.materialBill.find((line) => line.kind === 'mirror');
        expect(mirrors.itemHrid).toBe(MIRROR);
        expect(mirrors.count).toBe(strategy.mirrorCount);

        // A mirror plan for +8 is several items combined, and the totals-only answer says
        // nothing about that at all — a plan that buys one base item cannot be run
        const base = strategy.materialBill.find((line) => line.kind === 'base');
        expect(base.itemHrid).toBe(ITEM);
        expect(base.count).toBe(strategy.consumedItems.reduce((sum, item) => sum + item.quantity, 0));
    });

    test("a mirrored path's materials scale with the attempts it actually makes", () => {
        const strategy = calculateEnhancementPath(ITEM, 8, enhancingConfig).optimalStrategy;
        const material = strategy.materialBill.find((line) => line.itemHrid === MATERIAL);

        // One material per attempt again, so the whole plan's attempts is the whole plan's count
        expect(material.count).toBeCloseTo(strategy.expectedAttempts, 6);
    });

    test('every line names something buyable and costs what it says', () => {
        for (let level = 1; level <= 10; level++) {
            const strategy = calculateEnhancementPath(ITEM, level, enhancingConfig).optimalStrategy;
            for (const line of strategy.materialBill) {
                expect(line.itemHrid).toMatch(/^\/items\//);
                expect(line.count).toBeGreaterThan(0);
                expect(line.totalCost).toBeCloseTo(line.count * line.unitPrice, 6);
                expect(['material', 'protection', 'mirror', 'base']).toContain(line.kind);
            }
        }
    });
});

describe('calculateMinimumSellPrice', () => {
    test('is the total cost plus the target rate for the time spent', () => {
        // one hour at 10M/hr on top of a 5M cost
        expect(calculateMinimumSellPrice(5_000_000, 3600, 10_000_000, false)).toBe(15_000_000);
    });

    test('charges the rate pro rata for part of an hour', () => {
        expect(calculateMinimumSellPrice(5_000_000, 1800, 10_000_000, false)).toBe(10_000_000);
    });

    test('grosses up by the seller tax so the rate survives the sale', () => {
        expect(calculateMinimumSellPrice(5_000_000, 3600, 10_000_000, true)).toBeCloseTo(
            15_000_000 / (1 - MARKET_TAX),
            5
        );
    });

    test('with no rate or no time it is just the cost', () => {
        expect(calculateMinimumSellPrice(5_000_000, 3600, 0, false)).toBe(5_000_000);
        expect(calculateMinimumSellPrice(5_000_000, 0, 10_000_000, false)).toBe(5_000_000);
    });
});

describe('buildEnhancementTooltipHTML — minimum sell price', () => {
    const html = (level = 1) => buildEnhancementTooltipHTML(calculateEnhancementPath(ITEM, level, enhancingConfig));

    test('is absent until a rate is configured', () => {
        expect(html()).not.toContain('Minimum sell');
    });

    test('appears once a rate is set, and reads the rate as a text setting', () => {
        // The rate lives under .value — read through getSetting() it would be `false`,
        // parse to 0, and the row would never render however much the user typed.
        settings.values.itemTooltip_enhancingHourlyRate = '50m';

        const out = html();

        expect(out).toContain('Your rate: 50.0M/hr');
        expect(out).toContain('Minimum sell');
    });

    test('a blank or zero rate keeps the row hidden', () => {
        settings.values.itemTooltip_enhancingHourlyRate = '';
        expect(html()).not.toContain('Minimum sell');

        settings.values.itemTooltip_enhancingHourlyRate = '0';
        expect(html()).not.toContain('Minimum sell');
    });

    test('the tax option raises the minimum it asks for', () => {
        settings.values.itemTooltip_enhancingHourlyRate = '50m';
        const withoutTax = html();
        settings.checkboxes.itemTooltip_enhancingHourlyRateTax = true;
        const withTax = html();

        expect(withTax).not.toBe(withoutTax);
        expect(withTax).toContain('Minimum sell');
    });

    test('the row is priced off a mirrored plan too, not left at zero', () => {
        settings.values.itemTooltip_enhancingHourlyRate = '50m';
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        expect(data.optimalStrategy.usedMirror).toBe(true);

        const out = buildEnhancementTooltipHTML(data);
        const minimum = out.match(/Minimum sell: <span[^>]*>([^<]+)<\/span>/)?.[1];

        // A mirrored path leaves totalAsk populated by the consumed-item rows; if the
        // hoisting were wrong this would read 0
        expect(minimum).toBeTruthy();
        expect(minimum).not.toBe('0');
    });

    test('distinguishes nearby billion-scale rates instead of rounding them all to the same label', () => {
        settings.values.itemTooltip_enhancingHourlyRate = '1200000000';
        const html1200m = html();

        settings.values.itemTooltip_enhancingHourlyRate = '1250000000';
        const html1250m = html();

        settings.values.itemTooltip_enhancingHourlyRate = '1290000000';
        const html1290m = html();

        expect(html1200m).toContain('Your rate: 1.20B/hr');
        expect(html1250m).toContain('Your rate: 1.25B/hr');
        expect(html1290m).toContain('Your rate: 1.29B/hr');
    });
});

describe('buildEnhancementTooltipHTML — stats source indicator', () => {
    const withSource = (extra) => ({ ...enhancingConfig, ...extra });
    const html = (params, level = 1) => buildEnhancementTooltipHTML(calculateEnhancementPath(ITEM, level, params));

    test('the header says whose stats produced the numbers', () => {
        expect(html(withSource({ paramsSource: 'auto', manualOverrides: [] }))).toContain('Yours');
    });

    test('pro rates are named on the header, not left to look like your own', () => {
        const out = html(withSource({ paramsSource: 'pro' }));

        expect(out).toContain('Pro');
        expect(out).not.toContain('>Yours');
        // The kit is spelled out underneath, so "Pro" is a claim the tooltip can back up
        expect(out).toContain('Celestial enhancer');
    });

    test('hand-entered parameters are named, with the fields that were edited', () => {
        const out = html(withSource({ paramsSource: 'manual', manualOverrides: ['Enhancing level', 'Tea'] }));

        expect(out).toContain('Manual');
        expect(out).toContain('manual params: Enhancing level, Tea');
    });

    test('the section carries the item and level a redraw needs', () => {
        const out = html(enhancingConfig, 5);

        expect(out).toContain('data-toolasha-enh-section="path"');
        expect(out).toContain(`data-toolasha-enh-item="${ITEM}"`);
        expect(out).toContain('data-toolasha-enh-level="5"');
    });
});

describe('buildEnhancementMilestonesHTML — stats source indicator', () => {
    test('the milestone table names its source too, and is redrawable', () => {
        const out = buildEnhancementMilestonesHTML(ITEM, { ...enhancingConfig, paramsSource: 'auto' });

        expect(out).toContain('Enhancement Milestones');
        expect(out).toContain('Yours');
        expect(out).toContain('data-toolasha-enh-section="milestones"');
    });

    test('pro rates are called pro on the milestone table', () => {
        const out = buildEnhancementMilestonesHTML(ITEM, { ...enhancingConfig, paramsSource: 'pro' });

        expect(out).toContain('Pro');
        expect(out).toContain('Celestial enhancer');
    });
});

describe('an input nobody can price', () => {
    // A material with no quote contributes 0 to the bill, so the quoted total is an
    // under-quote — and the tooltip colours that total green against the enhanced item's ask,
    // which reads as "enhancing this is profitable". The XP/hr table and the enhancing panel
    // both say when a bill is partial; the tooltip's own tally did not.
    test('the analysis flags the quote as partial', () => {
        expect(calculateEnhancementPath(ITEM, 3, enhancingConfig).pricesPartial).toBe(false);
        expect(calculateEnhancementPath(PARTLY_PRICED, 3, enhancingConfig).pricesPartial).toBe(true);
    });

    test('the tooltip says the costs are understated, and says nothing when they are not', () => {
        const partial = buildEnhancementTooltipHTML(calculateEnhancementPath(PARTLY_PRICED, 3, enhancingConfig));
        expect(partial).toContain('costs are understated');

        const full = buildEnhancementTooltipHTML(calculateEnhancementPath(ITEM, 3, enhancingConfig));
        expect(full).not.toContain('costs are understated');
    });
});

describe('calculatePerAttemptMaterialCost', () => {
    test('sums coin line items 1:1 and priced materials at ask, marking hasCost true', () => {
        const result = calculatePerAttemptMaterialCost({
            enhancementCosts: [
                { itemHrid: '/items/coin', count: 5000 },
                { itemHrid: MATERIAL, count: 3 },
            ],
        });

        expect(result.cost).toBe(5000 + 3 * 5000);
        expect(result.hasCost).toBe(true);
        expect(result.costPartial).toBe(false);
    });

    test('flags costPartial when a material has no price, without discarding priced materials', () => {
        const result = calculatePerAttemptMaterialCost({
            enhancementCosts: [
                { itemHrid: MATERIAL, count: 2 },
                { itemHrid: '/items/unpriced_material', count: 1 },
            ],
        });

        expect(result.cost).toBe(10000);
        expect(result.hasCost).toBe(true);
        expect(result.costPartial).toBe(true);
    });

    test('returns a zero-cost, non-partial result when there are no enhancement costs', () => {
        expect(calculatePerAttemptMaterialCost({ enhancementCosts: [] })).toEqual({
            cost: 0,
            hasCost: false,
            costPartial: false,
        });
    });
});

describe('mirroring a refined piece', () => {
    test('the primary lineage is the refined item; every consumed copy is the plain base', () => {
        const data = calculateEnhancementPath(REFINED, 8, enhancingConfig);
        const strategy = data.optimalStrategy;
        expect(strategy.usedMirror).toBe(true);

        const primary = strategy.consumedItems.filter((item) => item.primary);
        const copies = strategy.consumedItems.filter((item) => !item.primary);
        // One refined base is built up the spine; everything combined into it is a copy
        expect(primary.reduce((sum, item) => sum + item.quantity, 0)).toBe(1);
        expect(primary.every((item) => item.itemHrid === REFINED)).toBe(true);
        expect(copies.length).toBeGreaterThan(0);
        expect(copies.every((item) => item.itemHrid === ITEM)).toBe(true);

        // A copy at a level costs the plain item's +0 plus the same climb, not the refined +0
        for (const copy of copies) {
            const refinedAtLevel = strategy.consumedItems.find((i) => i.primary && i.level === copy.level);
            if (refinedAtLevel) expect(copy.costEach).toBeLessThan(refinedAtLevel.costEach);
        }

        // And the bill reconciles: consumed copies + mirrors is the quoted total
        const consumed = strategy.consumedItems.reduce((sum, item) => sum + item.totalCost, 0);
        expect(consumed + strategy.philosopherMirrorCost).toBeCloseTo(strategy.totalCost, 6);

        // The shopping list names both: the one refined base and the plain copies
        const bases = strategy.materialBill.filter((line) => line.kind === 'base');
        expect(bases.find((line) => line.itemHrid === REFINED)?.count).toBe(1);
        expect(bases.find((line) => line.itemHrid === ITEM)?.count).toBe(
            copies.reduce((sum, item) => sum + item.quantity, 0)
        );
    });

    test('a plain item is unchanged: one item, every leaf the same hrid', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        expect(data.optimalStrategy.consumedItems.every((item) => item.itemHrid === ITEM)).toBe(true);
        expect(data.optimalStrategy.materialBill.filter((line) => line.kind === 'base')).toHaveLength(1);
    });
});

describe('production cost memo', () => {
    const CRAFTED = '/items/test_crafted';

    test('is served from cache until a price update, then recomputed against the new prices', async () => {
        const { getProductionCost, getProductionChainTime } = await import('./tooltip-enhancement.js');
        gameData.itemDetailMap[CRAFTED] = { name: 'Test Crafted' };
        gameData.actionDetailMap = {
            '/actions/crafting/test_crafted': {
                type: '/action_types/crafting',
                baseTimeCost: 20e9,
                inputItems: [{ itemHrid: MATERIAL, count: 2 }],
                outputItems: [{ itemHrid: CRAFTED, count: 1 }],
            },
        };
        const originalAsk = prices[MATERIAL].ask;
        try {
            expect(getProductionCost(CRAFTED, 'ask')).toBe(2 * originalAsk);
            expect(getProductionChainTime(CRAFTED)).toBe(20);

            // The market moves but nobody has said so: the memo still answers
            prices[MATERIAL].ask = originalAsk + 1000;
            expect(getProductionCost(CRAFTED, 'ask')).toBe(2 * originalAsk);

            // A price update invalidates every memo at once, without a sweep
            expect(priceListeners.length).toBeGreaterThan(0);
            for (const listener of priceListeners) listener();
            expect(getProductionCost(CRAFTED, 'ask')).toBe(2 * (originalAsk + 1000));
            expect(getProductionChainTime(CRAFTED)).toBe(20);
        } finally {
            prices[MATERIAL].ask = originalAsk;
            for (const listener of priceListeners) listener();
            delete gameData.itemDetailMap[CRAFTED];
            gameData.actionDetailMap = {};
        }
    });
});

/**
 * What a price is when there is not one.
 *
 * Both of these read a missing figure as a number: the cheapest protection came
 * back as 0 when nothing could be priced, which makes protection free to
 * anything that multiplies by it; and a one-sided market book was tested with
 * `bid < 0`, which is never true of a null, so the quote that did exist was
 * thrown away in favour of the vendor price.
 */
describe('a price that is not there', () => {
    test('protection nobody can price comes back as null, not as free', () => {
        const original = { ...prices[PROTECTION] };
        const originalItem = { ...prices[ITEM] };
        delete prices[PROTECTION];
        delete prices[ITEM];

        try {
            const result = getCheapestProtectionPrice(ITEM);
            expect(result.price).toBe(null);
            expect(result.itemHrid).toBe(null);
        } finally {
            prices[PROTECTION] = original;
            prices[ITEM] = originalItem;
        }
    });

    test('a priced option still comes back as a number', () => {
        expect(getCheapestProtectionPrice(ITEM).price).toBeGreaterThan(0);
    });

    test('a bid-only book is read at the bid rather than the vendor price', () => {
        const original = { ...prices[MATERIAL] };
        prices[MATERIAL] = { ask: null, bid: 4800 };

        try {
            // The vendor sell price is 100; the fallback would have picked it
            expect(getRealisticBaseItemPrice(MATERIAL, 'ask')).toBe(4800);
        } finally {
            prices[MATERIAL] = original;
        }
    });

    test('an ask-only book is read at the ask on the bid side too', () => {
        const original = { ...prices[MATERIAL] };
        prices[MATERIAL] = { ask: 5000, bid: null };

        try {
            expect(getRealisticBaseItemPrice(MATERIAL, 'bid')).toBe(5000);
        } finally {
            prices[MATERIAL] = original;
        }
    });
});
