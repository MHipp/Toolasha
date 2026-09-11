import { describe, test, expect, vi, beforeEach } from 'vitest';

import marketAPI from '../api/marketplace.js';
import expectedValueCalculator from '../features/market/expected-value-calculator.js';
import { parseEssenceFindBonus, parseRareFindBonus, parseRareFindBreakdown } from './equipment-parser.js';
import { calculateHouseRareFind } from './house-efficiency.js';
import { calculateBonusRevenue } from './bonus-revenue-calculator.js';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../api/marketplace.js', () => ({
    default: {
        getPrice: vi.fn(),
    },
}));

vi.mock('../features/market/expected-value-calculator.js', () => ({
    default: {
        getCachedValue: vi.fn(),
    },
}));

vi.mock('./equipment-parser.js', () => ({
    parseEssenceFindBonus: vi.fn(),
    parseRareFindBonus: vi.fn(),
    parseRareFindBreakdown: vi.fn(),
}));

vi.mock('./house-efficiency.js', () => ({
    calculateHouseRareFind: vi.fn(),
}));

// bonus-revenue-calculator.js now prices non-openable drops through market-data.js's real
// getItemPrice/getPricingMode, the same helper the main output price goes through — so the
// module boundary is pushed down to config (the pricingMode setting) and marketAPI (the
// ask/bid quote) instead of market-data.js itself. server-gate is pinned to "patch not live"
// so reconcileBook is a pure ask/bid pass-through and this file doesn't need to wire up the
// official-value-map machinery, which is not what this module is responsible for.
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key) => settings.values[key] },
}));
vi.mock('./server-gate.js', () => ({ isMarketplacePatchLive: () => false }));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPrice: () => null }));

describe('calculateBonusRevenue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        settings.values = { profitCalc_pricingMode: 'conservative' }; // sell side resolves to bid
        parseEssenceFindBonus.mockReturnValue(0);
        parseRareFindBonus.mockReturnValue(0);
        parseRareFindBreakdown.mockReturnValue([]);
        calculateHouseRareFind.mockReturnValue(0);
        marketAPI.getPrice.mockReturnValue({ ask: 60, bid: 50 });
        expectedValueCalculator.getCachedValue.mockReturnValue(200);
    });

    test('calculates bonus drops from base actions per hour', () => {
        const actionDetails = {
            type: '/action_types/gathering',
            essenceDropTable: [{ itemHrid: '/items/essence', minCount: 1, maxCount: 3, dropRate: 0.1 }],
            rareDropTable: [{ itemHrid: '/items/cache', minCount: 1, maxCount: 1, dropRate: 0.05 }],
        };
        const itemDetailMap = {
            '/items/essence': { name: 'Essence', isOpenable: false },
            '/items/cache': { name: 'Cache', isOpenable: true },
        };

        const result = calculateBonusRevenue(actionDetails, 100, new Map(), itemDetailMap);

        // essence: conservative mode prices the sell side at bid (50), matching the
        // pre-fix hardcoded bid — this pins the case where nothing should change.
        expect(result.totalBonusRevenue).toBe(2000);
        expect(result.bonusDrops).toHaveLength(2);

        const essenceDrop = result.bonusDrops.find((drop) => drop.itemHrid === '/items/essence');
        expect(essenceDrop.dropsPerHour).toBe(20);
        expect(essenceDrop.revenuePerHour).toBe(1000);

        const rareDrop = result.bonusDrops.find((drop) => drop.itemHrid === '/items/cache');
        expect(rareDrop.dropsPerHour).toBe(5);
        expect(rareDrop.revenuePerHour).toBe(1000);
    });

    test('a missing price is reported rather than priced at zero silently', () => {
        marketAPI.getPrice.mockReturnValue({ ask: null, bid: null });
        const actionDetails = {
            type: '/action_types/gathering',
            rareDropTable: [{ itemHrid: '/items/unpriced', minCount: 1, maxCount: 1, dropRate: 1 }],
        };
        const itemDetailMap = { '/items/unpriced': { name: 'Unpriced', isOpenable: false } };

        const result = calculateBonusRevenue(actionDetails, 100, new Map(), itemDetailMap);

        expect(result.bonusDrops[0].priceEach).toBe(0);
        expect(result.bonusDrops[0].missingPrice).toBe(true);
        expect(result.hasMissingPrices).toBe(true);
    });

    describe('pricing mode', () => {
        // ask=60, bid=50 (set in beforeEach). A regular (non-openable) drop must be priced
        // on the sell side of whatever profitCalc_pricingMode the user has set, the same way
        // the main output price is — not hardcoded to bid ("instant sell") regardless of mode.
        // Before the fix every one of these resolved to 50 (the hardcoded bid) whatever the
        // mode said; conservative and patientBuy still land on bid, so hybrid and optimistic
        // are the cases that actually change.
        test.each([
            ['conservative', 50],
            ['hybrid', 60],
            ['optimistic', 60],
            ['patientBuy', 50],
        ])('%s mode prices a rare drop at %i', (mode, expectedPrice) => {
            settings.values.profitCalc_pricingMode = mode;
            const actionDetails = {
                type: '/action_types/gathering',
                rareDropTable: [{ itemHrid: '/items/gem', minCount: 1, maxCount: 1, dropRate: 1 }],
            };
            const itemDetailMap = { '/items/gem': { name: 'Gem', isOpenable: false } };

            const result = calculateBonusRevenue(actionDetails, 10, new Map(), itemDetailMap);

            const drop = result.bonusDrops[0];
            expect(drop.priceEach).toBe(expectedPrice);
            expect(drop.revenuePerHour).toBe(10 * expectedPrice);
        });

        test('an openable container is still priced from expected value, not the pricing mode', () => {
            settings.values.profitCalc_pricingMode = 'hybrid'; // would price a regular drop at ask (60)
            const actionDetails = {
                type: '/action_types/gathering',
                rareDropTable: [{ itemHrid: '/items/cache', minCount: 1, maxCount: 1, dropRate: 1 }],
            };
            const itemDetailMap = { '/items/cache': { name: 'Cache', isOpenable: true } };

            const result = calculateBonusRevenue(actionDetails, 10, new Map(), itemDetailMap);

            expect(result.bonusDrops[0].priceEach).toBe(200); // expectedValueCalculator.getCachedValue mock
        });
    });
});
