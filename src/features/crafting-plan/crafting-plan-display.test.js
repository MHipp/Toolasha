/** @vitest-environment happy-dom
 *
 * The "Buy Missing Materials" button routes through the shared missing-mats
 * mechanism (openMaterialsList), the same one the "Missing Mats Marketplace"
 * button uses, so its tabs get live inventory tracking instead of a frozen
 * shortfall that re-arms the full amount on every buy.
 *
 * What is worth asserting here is the contract at the seam: the button hands
 * the shared path the REQUIRED totals (openMaterialsList subtracts inventory
 * and tracks the shortfall itself), one line per tradeable material — never the
 * bespoke createCraftingPlanTabs the panel used to call.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    plan: null,
    missing: [],
    openMaterialsList: vi.fn(async () => true),
    settings: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            actionDetailMap: {
                '/actions/crafting/wooden_bow': {
                    type: '/action_types/crafting',
                    outputItems: [{ itemHrid: '/items/wooden_bow', count: 1 }],
                },
            },
            itemDetailMap: {},
        }),
        getInventory: () => state.inventory,
        getItemDetails: () => ({ isTradable: true }),
        getSkills: () => ({}),
        getEquipment: () => ({}),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => state.settings[key],
        setSetting: (key, value) => {
            state.settings[key] = value;
        },
    },
}));
vi.mock('./crafting-plan-calculator.js', () => ({
    computeBestCraftingPlan: () => state.plan,
    collectMissingMaterials: () => state.missing,
}));
vi.mock('../actions/missing-materials-button.js', () => ({
    openMaterialsList: (...args) => state.openMaterialsList(...args),
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: () => ({ value: '2' }),
    onDetailPanel: () => () => {},
}));
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 0, totalEfficiency: 0 }),
}));
vi.mock('../../utils/efficiency.js', () => ({ calculateEfficiencyMultiplier: () => 1 }));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: () => ({ expPerHour: 0, actionsPerHour: 0 }),
}));

/**
 * The reservation ledger, doubled at the seam. What matters at this join is
 * that the panel excludes ITS OWN owner id from what it deducts, claims the
 * required totals when the player commits, and says who took the stock when
 * that is the only reason it is buying — never the ledger's own arithmetic,
 * which `utils/inventory-reservations.test.js` owns.
 */
const ledger = vi.hoisted(() => ({
    enabled: false,
    held: 0,
    claimedElsewhere: 0,
    rowsCalls: [],
    reserveCalls: [],
}));
vi.mock('../../utils/inventory-reservations.js', () => ({
    reservationsEnabled: () => ledger.enabled,
    heldInInventory: () => ledger.held,
    effectiveInventory: (hrid, level, { held } = {}) => Math.max(0, held - ledger.claimedElsewhere),
    effectiveInventoryRows: (rows, options) => {
        ledger.rowsCalls.push(options);
        return rows;
    },
    reserve: async (ownerId, lines, options) => {
        ledger.reserveCalls.push({ ownerId, lines, options });
        return true;
    },
    shortfallNote: (short) =>
        ledger.claimedElsewhere > 0
            ? `${short} short — ${ledger.claimedElsewhere} reserved by "Goal: Cheese sword"`
            : '',
}));

const { buildPlanUI } = await import('./crafting-plan-display.js');

/** A craft-strategy plan whose one leaf is a market buy, so the shopping list
 *  (and its Buy button) renders. The root has no actionHrid, so no craft-step
 *  section is drawn — keeping the fixture to the button under test. */
function craftPlanBuying(itemHrid, itemName, quantity) {
    return {
        strategy: 'craft',
        actionHrid: null,
        craftCost: 1000,
        buyPrice: 2000,
        unitCost: 5,
        children: [
            {
                strategy: 'buy',
                itemHrid,
                itemName,
                quantity,
                unitCost: 5,
                totalCost: quantity * 5,
                children: [],
            },
        ],
    };
}

function findBuyButton(section) {
    return [...section.querySelectorAll('button')].find((b) => b.textContent === 'Buy Missing Materials');
}

describe('the Buy Missing Materials button', () => {
    beforeEach(() => {
        state.inventory = [];
        state.settings = {};
        state.openMaterialsList.mockClear();
        ledger.enabled = false;
        ledger.held = 0;
        ledger.claimedElsewhere = 0;
        ledger.rowsCalls = [];
        ledger.reserveCalls = [];
    });

    test('hands the shared path the required totals, one line per tradeable material', async () => {
        state.plan = craftPlanBuying('/items/wood', 'Wood', 100);
        // 200 needed in total, 40 already held: the shared path is given 200 and
        // subtracts the 40 itself, rather than the panel pre-subtracting to 160.
        state.missing = [{ itemHrid: '/items/wood', itemName: 'Wood', missing: 160, required: 200, isTradeable: true }];

        const section = buildPlanUI('/actions/crafting/wooden_bow');
        const button = findBuyButton(section);
        expect(button).toBeTruthy();

        button.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(state.openMaterialsList).toHaveBeenCalledTimes(1);
        expect(state.openMaterialsList).toHaveBeenCalledWith([{ itemHrid: '/items/wood', count: 200 }], {
            ownerId: 'craftingPlan:/items/wooden_bow',
        });
    });

    test('untradeable materials are left off the bill', async () => {
        state.plan = craftPlanBuying('/items/wood', 'Wood', 100);
        state.missing = [
            { itemHrid: '/items/wood', itemName: 'Wood', missing: 10, required: 10, isTradeable: true },
            { itemHrid: '/items/bound_soul', itemName: 'Bound Soul', missing: 3, required: 3, isTradeable: false },
        ];

        const section = buildPlanUI('/actions/crafting/wooden_bow');
        findBuyButton(section).click();
        await Promise.resolve();
        await Promise.resolve();

        expect(state.openMaterialsList).toHaveBeenCalledWith([{ itemHrid: '/items/wood', count: 10 }], {
            ownerId: 'craftingPlan:/items/wooden_bow',
        });
    });

    test('does not open the marketplace when nothing is missing', async () => {
        state.plan = craftPlanBuying('/items/wood', 'Wood', 100);
        state.missing = [];

        const section = buildPlanUI('/actions/crafting/wooden_bow');
        findBuyButton(section).click();
        await Promise.resolve();
        await Promise.resolve();

        expect(state.openMaterialsList).not.toHaveBeenCalled();
    });
});

describe('the crafting plan and the reservation ledger', () => {
    beforeEach(() => {
        state.inventory = [];
        state.settings = {};
        state.openMaterialsList.mockClear();
        ledger.enabled = false;
        ledger.held = 0;
        ledger.claimedElsewhere = 0;
        ledger.rowsCalls = [];
        ledger.reserveCalls = [];
        state.plan = craftPlanBuying('/items/wood', 'Wood', 100);
        state.missing = [{ itemHrid: '/items/wood', itemName: 'Wood', missing: 160, required: 200, isTradeable: true }];
    });

    test('the plan nets off other owners’ claims, never its own', async () => {
        const section = buildPlanUI('/actions/crafting/wooden_bow');
        findBuyButton(section).click();
        await Promise.resolve();
        await Promise.resolve();

        expect(ledger.rowsCalls).toEqual([{ excludeOwner: 'craftingPlan:/items/wooden_bow' }]);
    });

    test('committing to the plan claims the required totals under its own owner', async () => {
        const section = buildPlanUI('/actions/crafting/wooden_bow');
        findBuyButton(section).click();
        await Promise.resolve();
        await Promise.resolve();

        expect(ledger.reserveCalls).toHaveLength(1);
        expect(ledger.reserveCalls[0].ownerId).toBe('craftingPlan:/items/wooden_bow');
        expect(ledger.reserveCalls[0].lines).toEqual([{ itemHrid: '/items/wood', count: 200 }]);
    });

    test('with the ledger off the panel draws no reservation line at all', () => {
        ledger.enabled = false;
        ledger.held = 500;
        ledger.claimedElsewhere = 450;
        const section = buildPlanUI('/actions/crafting/wooden_bow');
        expect(section.querySelector('.mwi-crafting-plan-reserved')).toBeNull();
    });

    test('a shortfall that is only somebody else’s claim is named', () => {
        ledger.enabled = true;
        ledger.held = 500;
        ledger.claimedElsewhere = 450;
        const section = buildPlanUI('/actions/crafting/wooden_bow');
        expect(section.querySelector('.mwi-crafting-plan-reserved').textContent).toBe(
            'Wood: 50 short — 450 reserved by "Goal: Cheese sword"'
        );
    });

    test('an ordinary shortfall — the bag simply has not got it — says nothing', () => {
        ledger.enabled = true;
        ledger.held = 10;
        ledger.claimedElsewhere = 450;
        const section = buildPlanUI('/actions/crafting/wooden_bow');
        expect(section.querySelector('.mwi-crafting-plan-reserved')).toBeNull();
    });
});
