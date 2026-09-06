/**
 * Tests for Material Calculator Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    settings: {},
    gameData: null,
    inventory: [],
    currentActions: [],
    equipment: new Map(),
    drinks: [],
    enhancingParams: { enhancingLevel: 1, houseLevel: 0, toolBonus: 0, speedBonus: 0, teas: {}, guzzlingBonus: 1 },
    enhancementResult: { attempts: 1, protectionCount: 0 },
    marketListings: [],
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in state.settings ? state.settings[key] : fallback),
    },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getInventory: () => state.inventory,
        getCurrentActions: () => state.currentActions,
        getActionDetails: (hrid) => state.gameData?.actionDetailMap?.[hrid] || null,
        getActionDrinkSlots: () => state.drinks,
        getMarketListings: () => state.marketListings,
    },
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: state.equipment, drinks: state.drinks }),
}));

vi.mock('./enhancement-config.js', () => ({
    getEnhancingParams: () => state.enhancingParams,
}));

vi.mock('./enhancement-calculator.js', () => ({
    calculateEnhancement: () => state.enhancementResult,
}));

const {
    calculateMaterialRequirements,
    calculateQueuedMaterialsForAction,
    calculateArtisanBonus,
    isArtisanTeaOutOfStock,
    calculateEnhancementMaterialRequirements,
    ARTISAN_MATERIAL_MODE,
    affordableActions,
} = await import('./material-calculator.js');

beforeEach(() => {
    state.settings = {};
    state.gameData = {
        itemDetailMap: {
            '/items/plank': { name: 'Plank', isTradable: true },
            '/items/nail': { name: 'Nail', isTradable: true },
            '/items/table': { name: 'Table', isTradable: true },
            '/items/protection_scroll': { name: 'Protection Scroll', isTradable: true },
        },
        actionDetailMap: {
            '/actions/crafting/table': {
                type: '/action_types/crafting',
                inputItems: [
                    { itemHrid: '/items/plank', count: 4 },
                    { itemHrid: '/items/nail', count: 2 },
                ],
            },
        },
    };
    state.inventory = [];
    state.currentActions = [];
    state.equipment = new Map();
    state.drinks = [];
    state.marketListings = [];
});

describe('affordableActions', () => {
    test('floors a genuinely partial action down', () => {
        expect(affordableActions(129, 10)).toBe(12);
        expect(affordableActions(65, 4.5)).toBe(14);
    });

    test('an exact multiple of a fractional cost is not read one short', () => {
        // 8880 / 8.88 evaluates to 999.9999999999999 in IEEE arithmetic; a
        // plain floor answered 999 for a bag holding exactly 1000 actions
        expect(8880 / 8.88).toBeLessThan(1000); // the trap this guards against
        expect(affordableActions(8880, 8.88)).toBe(1000);
        expect(affordableActions(888, 0.888)).toBe(1000);
        expect(affordableActions(9, 0.9)).toBe(10);
    });

    test('a cost of zero affords infinitely many actions', () => {
        expect(affordableActions(5, 0)).toBe(Infinity);
    });

    test('inverts the expected-mode requirement: ceil(perAction × N) never exceeds the stack', () => {
        for (const [available, perAction] of [
            [8880, 8.88],
            [129, 10],
            [65, 4.5],
            [7, 0.7],
        ]) {
            const actions = affordableActions(available, perAction);
            expect(Math.ceil(perAction * actions)).toBeLessThanOrEqual(available);
            expect(perAction * (actions + 1)).toBeGreaterThan(available);
        }
    });
});

describe('calculateMaterialRequirements', () => {
    test('returns [] for an unknown action', () => {
        expect(calculateMaterialRequirements('/actions/crafting/unknown', 10)).toEqual([]);
    });

    test('computes required, have, and missing with no artisan bonus', () => {
        state.inventory = [{ itemHrid: '/items/plank', count: 10 }];
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);

        const plank = result.find((m) => m.itemHrid === '/items/plank');
        expect(plank.required).toBe(20); // 4 * 5
        expect(plank.have).toBe(10);
        expect(plank.missing).toBe(10);

        const nail = result.find((m) => m.itemHrid === '/items/nail');
        expect(nail.required).toBe(10);
        expect(nail.have).toBe(0);
        expect(nail.missing).toBe(10);
    });

    test('excludes enhanced copies from the "have" count', () => {
        state.inventory = [{ itemHrid: '/items/plank', count: 5, enhancementLevel: 3 }];
        const result = calculateMaterialRequirements('/actions/crafting/table', 1);
        const plank = result.find((m) => m.itemHrid === '/items/plank');
        expect(plank.have).toBe(0);
    });

    test('accounts for queued materials when accountForQueue is true', () => {
        state.inventory = [{ itemHrid: '/items/plank', count: 20 }];
        state.currentActions = [
            {
                actionHrid: '/actions/crafting/table',
                hasMaxCount: true,
                maxCount: 10,
                currentCount: 0,
            },
        ];
        const result = calculateMaterialRequirements('/actions/crafting/table', 1, true);
        const plank = result.find((m) => m.itemHrid === '/items/plank');
        // queued = 4*10=40, have=20 => available = max(0, 20-40) = 0
        expect(plank.available).toBe(0);
        expect(plank.missing).toBe(4); // required 4, available 0
    });

    test('applies expected (average) artisan mode by default', () => {
        state.drinks = [{ itemHrid: '/items/artisan_tea' }];
        state.gameData.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
        };
        // 4 * (1-0.1) = 3.6 per action * 5 = 18, ceil = 18
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);
        const plank = result.find((m) => m.itemHrid === '/items/plank');
        expect(plank.required).toBe(18);
    });

    test('worst-case artisan mode rounds up per action before multiplying', () => {
        state.settings['actions_artisanMaterialMode'] = ARTISAN_MATERIAL_MODE.WORST_CASE;
        state.drinks = [{ itemHrid: '/items/artisan_tea' }];
        state.gameData.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
        };
        // per-action: 4*(1-0.1)=3.6 -> ceil = 4 per action * 5 = 20 (vs. 18 in expected mode)
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);
        const plank = result.find((m) => m.itemHrid === '/items/plank');
        expect(plank.required).toBe(20);
    });

    describe('hybrid artisan mode', () => {
        // 4 planks/action with a 0.1 artisan bonus = 3.6/action: expected ceils the product,
        // worst-case ceils each craft to 4. Hybrid must agree with whichever mode is right at
        // each end of the range, so these assertions pin it against both.
        beforeEach(() => {
            state.settings['actions_artisanMaterialMode'] = ARTISAN_MATERIAL_MODE.HYBRID;
            state.drinks = [{ itemHrid: '/items/artisan_tea' }];
            state.gameData.itemDetailMap['/items/artisan_tea'] = {
                consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
            };
        });

        const planksFor = (numActions) =>
            calculateMaterialRequirements('/actions/crafting/table', numActions).find(
                (m) => m.itemHrid === '/items/plank'
            ).required;

        test('matches worst-case below the 100-action threshold', () => {
            expect(planksFor(5)).toBe(20); // ceil(3.6) * 5
            expect(planksFor(99)).toBe(396); // ceil(3.6) * 99
        });

        test('matches expected value at exactly the threshold and above', () => {
            expect(planksFor(100)).toBe(360); // ceil(3.6 * 100)
            expect(planksFor(250)).toBe(900); // ceil(3.6 * 250)
        });

        test('an unbounded queue takes expected-value rounding', () => {
            expect(planksFor(Infinity)).toBe(Infinity);
        });
    });

    test('an unrecognized mode value falls back to expected value', () => {
        state.settings['actions_artisanMaterialMode'] = 'not-a-real-mode';
        state.drinks = [{ itemHrid: '/items/artisan_tea' }];
        state.gameData.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
        };
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);
        expect(result.find((m) => m.itemHrid === '/items/plank').required).toBe(18);
    });

    test('includes the upgrade item at 1-per-action with no artisan reduction', () => {
        state.gameData.actionDetailMap['/actions/crafting/table'].upgradeItemHrid = '/items/table';
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);
        const upgrade = result.find((m) => m.isUpgradeItem);
        expect(upgrade.itemHrid).toBe('/items/table');
        expect(upgrade.required).toBe(5);
    });

    test('counts unclaimed buy-order fills toward the upgrade item, same as a regular input', () => {
        // Regular inputs already count unclaimedBoughtCount(); the upgrade item
        // used to skip it, leaving "Missing" stuck high even after a buy order
        // for the upgrade item partially filled.
        state.gameData.actionDetailMap['/actions/crafting/table'].upgradeItemHrid = '/items/table';
        state.marketListings = [{ itemHrid: '/items/table', isSell: false, unclaimedItemCount: 3 }];
        const result = calculateMaterialRequirements('/actions/crafting/table', 5);
        const upgrade = result.find((m) => m.isUpgradeItem);
        expect(upgrade.have).toBe(3);
        expect(upgrade.missing).toBe(2);
    });
});

describe('calculateQueuedMaterialsForAction', () => {
    test('returns an empty map with no queued actions', () => {
        expect(calculateQueuedMaterialsForAction().size).toBe(0);
    });

    test('skips infinite (no maxCount) actions', () => {
        state.currentActions = [{ actionHrid: '/actions/crafting/table', hasMaxCount: false }];
        expect(calculateQueuedMaterialsForAction().size).toBe(0);
    });

    test('sums materials for the remaining count (maxCount - currentCount)', () => {
        state.currentActions = [
            { actionHrid: '/actions/crafting/table', hasMaxCount: true, maxCount: 10, currentCount: 4 },
        ];
        const map = calculateQueuedMaterialsForAction();
        expect(map.get('/items/plank')).toBe(24); // 4 * (10-4)
    });

    test('filters to a specific actionHrid when provided', () => {
        state.currentActions = [
            { actionHrid: '/actions/crafting/table', hasMaxCount: true, maxCount: 5, currentCount: 0 },
            { actionHrid: '/actions/crafting/other', hasMaxCount: true, maxCount: 5, currentCount: 0 },
        ];
        const map = calculateQueuedMaterialsForAction('/actions/crafting/other');
        expect(map.has('/items/plank')).toBe(false);
    });
});

describe('calculateArtisanBonus', () => {
    test('returns 0 without game data', () => {
        state.gameData = null;
        expect(calculateArtisanBonus({ type: '/action_types/crafting' })).toBe(0);
    });

    test('reads artisan bonus from active drinks', () => {
        state.drinks = [{ itemHrid: '/items/artisan_tea' }];
        state.gameData.itemDetailMap['/items/artisan_tea'] = {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
        };
        expect(calculateArtisanBonus({ type: '/action_types/crafting' })).toBeCloseTo(0.1, 6);
    });
});

describe('isArtisanTeaOutOfStock', () => {
    test('returns false for an unknown action', () => {
        expect(isArtisanTeaOutOfStock('/actions/crafting/unknown')).toBe(false);
    });

    test('returns false when no artisan tea is slotted at all', () => {
        expect(isArtisanTeaOutOfStock('/actions/crafting/table')).toBe(false);
    });
});

describe('calculateEnhancementMaterialRequirements', () => {
    beforeEach(() => {
        state.gameData.itemDetailMap['/items/sword'] = {
            name: 'Sword',
            itemLevel: 10,
            enhancementCosts: [
                { itemHrid: '/items/coin', count: 100 },
                { itemHrid: '/items/nail', count: 2 },
            ],
        };
        state.enhancementResult = { attempts: 10, protectionCount: 0 };
    });

    test('returns [] for an unknown item', () => {
        expect(calculateEnhancementMaterialRequirements('/items/unknown', 0, 5, null, 0)).toEqual([]);
    });

    test('excludes coins from the material list', () => {
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, null, 0);
        expect(result.find((m) => m.itemHrid === '/items/coin')).toBeUndefined();
    });

    test('scales material cost by expected attempts from the Markov chain result', () => {
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, null, 0);
        const nail = result.find((m) => m.itemHrid === '/items/nail');
        expect(nail.required).toBe(20); // 2 * 10 attempts
    });

    test('respects an explicit repeatCount override instead of the calculated attempts', () => {
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, null, 0, 3);
        const nail = result.find((m) => m.itemHrid === '/items/nail');
        expect(nail.required).toBe(6); // 2 * 3
    });

    test('adds a protection item entry when protectionCount > 0', () => {
        state.enhancementResult = { attempts: 10, protectionCount: 2.5 };
        state.gameData.itemDetailMap['/items/protection_scroll'] = { name: 'Protection Scroll', isTradable: true };
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, '/items/protection_scroll', 2);
        const protection = result.find((m) => m.itemHrid === '/items/protection_scroll');
        expect(protection.required).toBe(3); // ceil(2.5)
    });

    test("never lists Philosopher's Mirror as a consumed protection item", () => {
        state.enhancementResult = { attempts: 10, protectionCount: 3 };
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, '/items/philosophers_mirror', 2);
        expect(result.find((m) => m.itemHrid === '/items/philosophers_mirror')).toBeUndefined();
    });

    test('counts unclaimed buy-order fills toward the protection item, same as a regular enhancement cost', () => {
        state.enhancementResult = { attempts: 10, protectionCount: 2.5 };
        state.gameData.itemDetailMap['/items/protection_scroll'] = { name: 'Protection Scroll', isTradable: true };
        state.marketListings = [{ itemHrid: '/items/protection_scroll', isSell: false, unclaimedItemCount: 1 }];
        const result = calculateEnhancementMaterialRequirements('/items/sword', 0, 5, '/items/protection_scroll', 2);
        const protection = result.find((m) => m.itemHrid === '/items/protection_scroll');
        expect(protection.have).toBe(1);
        expect(protection.missing).toBe(2); // ceil(2.5) - 1
    });
});
