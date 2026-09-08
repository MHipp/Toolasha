/**
 * The join between the game and the planner, tested at the join.
 *
 * `goal-planner.test.js` covers what the planner decides given rates;
 * `alchemy-rankings.test.js` and `combat-rates.test.js` cover what each
 * provider says. What is left — and what nothing else can catch — is the
 * *wiring*: that four sources of income end up in one ranked list, that a
 * provider with nothing to say leaves a note rather than a silence, and that
 * adding alchemy and combat did not quietly corrupt the per-action gold map the
 * experience rates read.
 *
 * Every calculator is mocked. This file is about plumbing, and a plumbing test
 * that also runs the profit calculators is a slow test of somebody else's file.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetailMap: {},
    skills: [],
    inventory: [],
}));

const rates = vi.hoisted(() => ({
    gathering: {},
    production: {},
    alchemy: [],
    combat: { rates: [], best: null, status: { note: null } },
    /** What each mocked provider was asked, so a test can see it was asked once */
    alchemyCalls: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ actionDetailMap: game.actionDetailMap, levelExperienceTable: [0, 1, 2] }),
        getItemDetails: () => null,
        getActionDetails: (hrid) => game.actionDetailMap[hrid] || null,
        getSkills: () => game.skills,
        getEquipment: () => new Map(),
        getInventory: () => game.inventory,
        getHouseRoomLevel: () => 0,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, lastFetchTimestamp: 12345 },
}));
vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async (hrid) => rates.gathering[hrid] || null,
}));
vi.mock('../actions/production-profit.js', () => ({
    calculateProductionProfit: async (hrid) => rates.production[hrid] || null,
}));
vi.mock('../alchemy/alchemy-rankings.js', () => ({
    alchemyGoldRates: (options) => {
        rates.alchemyCalls.push(options);
        return rates.alchemy;
    },
}));
vi.mock('./combat-rates.js', () => ({ loadCombatRates: async () => rates.combat }));
const liquidity = vi.hoisted(() => ({ measured: true }));
// Bounding rates by market volume reaches a third-party history server, and what
// this file is about is which rates get ranked, not how fast they sell. The
// liquidity bound has its own tests; here it passes everything through and says
// it measured, so the "not being checked" note stays out of the note assertions.
vi.mock('./market-liquidity.js', () => ({
    applyLiquidityLimits: async (rates) => ({ rates, measured: liquidity.measured }),
}));
vi.mock('../crafting-plan/crafting-plan-calculator.js', () => ({ computeBestCraftingPlan: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    getProductionChainTime: () => 0,
    getCheapestProtectionPrice: () => null,
    getEnhancementMaterialPrice: () => 0,
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateSuccessXP: () => 0, calculateFailureXP: () => 0 }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    getTooltipEnhancementParams: () => ({ enhancingLevel: 1, houseLevel: 0 }),
    describeEnhancementSource: () => ({ kind: 'own', detail: '' }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    initialize: async () => {},
    calculateCumulativeCost: async () => null,
    getItemName: () => '',
}));
vi.mock('../../utils/enhancement-calculator.js', () => ({ calculateEnhancement: () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: () => ({ expPerHour: 1000, modifiedXP: 10, actionTime: 10, totalEfficiency: 0 }),
}));
vi.mock('../../utils/market-data.js', () => ({ getPriceAgeString: () => 'a moment ago' }));

/**
 * The reservation ledger, doubled at the seam the context uses it through.
 * `utils/inventory-reservations.test.js` owns the arithmetic; what matters here
 * is that the context passes the asking goal's own owner id, so a goal is never
 * deducted from itself.
 */
const reservations = vi.hoisted(() => ({ claims: {}, calls: [] }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    effectiveInventory: (itemHrid, level, { excludeOwner, held } = {}) => {
        reservations.calls.push({ itemHrid, excludeOwner, held });
        let elsewhere = 0;
        for (const [owner, byItem] of Object.entries(reservations.claims)) {
            if (owner === excludeOwner) continue;
            elsewhere += byItem[itemHrid] || 0;
        }
        return Math.max(0, held - elsewhere);
    },
    shortfallNote: (short, itemHrid, level, { excludeOwner } = {}) =>
        excludeOwner === 'goal:mine' ? '' : `${short} short — reserved`,
}));

const { buildPlannerContext } = await import('./goal-planner-context.js');

/**
 * A combat provider result with one zone.
 * @param {number} goldPerHour - What the zone pays
 * @param {Object} [extra] - Extra fields on the rate
 * @returns {Object} What `loadCombatRates` would return
 */
function combat(goldPerHour, extra = {}) {
    const rate = {
        actionHrid: '/actions/combat/fly',
        label: 'Fly Zone T2 — from your all-zones run 3d ago',
        goldPerHour,
        kind: 'combat',
        ...extra,
    };
    return { rates: [rate], best: rate, status: { note: null } };
}

beforeEach(() => {
    reservations.claims = {};
    reservations.calls = [];
    liquidity.measured = true;
    game.actionDetailMap = {
        '/actions/milking/cow': {
            type: '/action_types/milking',
            name: 'Milk a Cow',
            levelRequirement: { skillHrid: '/skills/milking', level: 1 },
            experienceGain: { skillHrid: '/skills/milking', value: 10 },
        },
        '/actions/cooking/stew': {
            type: '/action_types/cooking',
            name: 'Cook Stew',
            levelRequirement: { skillHrid: '/skills/cooking', level: 1 },
            experienceGain: { skillHrid: '/skills/cooking', value: 20 },
        },
        '/actions/alchemy/transmute': {
            type: '/action_types/alchemy',
            name: 'Transmute',
            experienceGain: { skillHrid: '/skills/alchemy', value: 30 },
        },
    };
    game.skills = [
        { skillHrid: '/skills/milking', level: 50, experience: 0 },
        { skillHrid: '/skills/cooking', level: 50, experience: 0 },
        { skillHrid: '/skills/alchemy', level: 50, experience: 0 },
    ];
    game.inventory = [];

    rates.gathering = { '/actions/milking/cow': { profitPerHour: 100_000 } };
    rates.production = { '/actions/cooking/stew': { profitPerHour: 50_000 } };
    rates.alchemy = [];
    rates.combat = { rates: [], best: null, status: { note: null } };
    rates.alchemyCalls = [];
});

describe('goldRates — four providers, one ranking', () => {
    test('ranks alchemy against gathering and production on the one number', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        const ranked = context.goldRates();

        expect(ranked.map((rate) => rate.kind)).toEqual(['alchemy', 'gathering', 'production']);
        expect(ranked[0].label).toBe('Transmute Ore');
    });

    test('combat joins the same ranking and wins when it wins', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
        ];
        rates.combat = combat(2_100_000);

        const context = await buildPlannerContext();
        const [best] = context.goldRates();

        expect(best.kind).toBe('combat');
        expect(best.label).toContain('all-zones run 3d ago');
    });

    test('alchemy that loses to milking sorts below it rather than being hidden', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 1_000, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production', 'alchemy']);
    });

    test('a provider with nothing to offer simply is not in the list', async () => {
        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
    });

    test('the alchemy ranking is told which market fetch it is pricing against', async () => {
        await buildPlannerContext();
        expect(rates.alchemyCalls).toEqual([{ priceStamp: 12345 }]);
    });
});

describe('a cost that could not be priced is not a cost of zero', () => {
    test('a production margin with an unpriceable material is dropped, not quoted', async () => {
        rates.production = {
            '/actions/cooking/stew': {
                profitPerHour: 7_400_000_000,
                materialCosts: [{ itemHrid: '/items/truffle', missingPrice: true }],
            },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering']);
        expect(context.rateNotes[0]).toContain('no market listing');
    });

    test('and the experience rates lose its gold with it, rather than inheriting a fantasy', async () => {
        rates.production = {
            '/actions/cooking/stew': {
                profitPerHour: 7_400_000_000,
                materialCosts: [{ itemHrid: '/items/truffle', missingPrice: true }],
            },
        };

        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(0);
    });

    test('an unpriceable drink costs a gathering rate its place too', async () => {
        rates.gathering = {
            '/actions/milking/cow': { profitPerHour: 100_000, drinkCosts: [{ missingPrice: true }] },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['production']);
    });

    test('a missing output price is conservative, so the rate is kept', async () => {
        // `hasMissingPrices` would be true here; only the cost side is fatal
        rates.production = {
            '/actions/cooking/stew': { profitPerHour: 50_000, hasMissingPrices: true, materialCosts: [{}] },
        };

        const context = await buildPlannerContext();
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
        expect(context.rateNotes).toEqual([]);
    });

    test('gathering and production say they have no ceiling, since they have none', async () => {
        const context = await buildPlannerContext();
        for (const rate of context.goldRates()) {
            expect(rate.sustainable).toEqual({ unbounded: true });
        }
    });
});

describe('rateNotes — what the panel says about a provider', () => {
    test('carries the combat provider’s note when there is no saved run', async () => {
        rates.combat = { rates: [], best: null, status: { note: 'Combat is not ranked — run an all-zones sim.' } };

        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual(['Combat is not ranked — run an all-zones sim.']);
    });

    test('carries a staleness note alongside the rates it is about', async () => {
        rates.combat = combat(2_100_000);
        rates.combat.status.note = 'Combat rates are from an all-zones run 9d ago — over a week old.';

        const context = await buildPlannerContext();
        expect(context.goldRates()).toHaveLength(3);
        expect(context.rateNotes[0]).toContain('9d ago');
    });

    test('says nothing when every provider is happy', async () => {
        rates.combat = combat(2_100_000);
        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual([]);
    });

    test('says out loud when market volume could not be checked at all', async () => {
        // The pooled-history setting is off, or the server did not answer. A rate
        // here is then what its output is *worth*, which is not the same claim.
        rates.combat = combat(2_100_000);
        liquidity.measured = false;

        const context = await buildPlannerContext();
        expect(context.rateNotes.join(' ')).toContain('Market volume is not being checked');
    });

    test('a provider that throws is reported rather than swallowed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        rates.combat = null; // loadCombatRates resolves to null → reading .rates throws

        const context = await buildPlannerContext();
        expect(context.rateNotes).toEqual(['Combat could not be ranked — see the console.']);
        expect(context.goldRates().map((rate) => rate.kind)).toEqual(['gathering', 'production']);
        vi.restoreAllMocks();
    });
});

describe('the per-action gold map the experience rates read', () => {
    test('an experience rate is paired with its own action’s gold', async () => {
        const context = await buildPlannerContext();
        const [cooking] = context.xpRates('/skills/cooking');
        expect(cooking.goldPerHour).toBe(50_000);
    });

    test('alchemy rates do not leak into it, since many of them share one action', async () => {
        rates.alchemy = [
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Ore', goldPerHour: 400_000, kind: 'alchemy' },
            { actionHrid: '/actions/alchemy/transmute', label: 'Transmute Milk', goldPerHour: 7, kind: 'alchemy' },
        ];

        const context = await buildPlannerContext();
        const [alchemy] = context.xpRates('/skills/alchemy');

        // Not 7 — the worst of two rates against the same action is not what
        // transmuting pays, and it is what a naive map would have stored
        expect(alchemy.goldPerHour).toBe(0);
    });
});

describe('measureRates: false', () => {
    test('skips every provider, which is the point of it', async () => {
        const context = await buildPlannerContext({ measureRates: false });
        expect(context.goldRates()).toEqual([]);
        expect(context.rateNotes).toEqual([]);
        expect(rates.alchemyCalls).toEqual([]);
    });
});

describe('what one goal may plan against', () => {
    /**
     * @returns {Promise<Object>} A context over a bag holding 500 logs
     */
    async function contextOver500Logs() {
        game.inventory = [
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 500 },
        ];
        return buildPlannerContext();
    }

    test('with nothing claimed, `owned` is the bag', async () => {
        const context = await contextOver500Logs();
        expect(context.owned('/items/log', 'a')).toBe(500);
    });

    test('another goal’s claim comes off; the asking goal’s own does not', async () => {
        reservations.claims = { 'goal:mine': { '/items/log': 200 }, 'goal:other': { '/items/log': 300 } };
        const context = await contextOver500Logs();

        expect(context.owned('/items/log', 'mine')).toBe(200);
        expect(context.owned('/items/log', 'other')).toBe(300);
    });

    test('the ledger is asked with the goal’s own owner id and the bag count', async () => {
        const context = await contextOver500Logs();
        context.owned('/items/log', 'mine');

        expect(reservations.calls.at(-1)).toEqual({
            itemHrid: '/items/log',
            excludeOwner: 'goal:mine',
            held: 500,
        });
    });

    test('an equipped or enhanced copy is not stock, as it never was', async () => {
        game.inventory = [
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 0, count: 500 },
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/equipment', enhancementLevel: 0, count: 9 },
            { itemHrid: '/items/log', itemLocationHrid: '/item_locations/inventory', enhancementLevel: 3, count: 4 },
        ];
        const context = await buildPlannerContext();
        expect(context.owned('/items/log', 'mine')).toBe(500);
    });

    test('the visibility line is asked under the goal’s own owner id too', async () => {
        const context = await contextOver500Logs();
        expect(context.reservationNote(120, '/items/log', 'mine')).toBe('');
        expect(context.reservationNote(120, '/items/log', 'other')).toBe('120 short — reserved');
    });
});
