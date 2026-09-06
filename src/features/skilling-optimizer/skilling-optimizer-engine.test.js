/**
 * Tests for the Skilling Optimizer Engine
 *
 * The engine's job is candidate selection and the enhancement-breakpoint sweep:
 * which items can go in a slot, which of them wins at each breakpoint, and when
 * the winner changes. The scoring itself lives in utils/tea-optimizer.js and is
 * mocked here — each test states, as data, what a given item/enhancement pair is
 * worth, so the sweep's choices are checkable by hand.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
}));

const scoring = vi.hoisted(() => ({
    /** `${itemHrid}@${enhancementLevel}` → score, per goal */
    scores: {},
    baseline: { xp: 100, gold: 1000 },
    /** Every scoreEquipmentSetup call, for asserting what got asked */
    calls: [],
    teaResults: { xp: { teas: ['xp-tea'] }, gold: { teas: ['gold-tea'] } },
    teaCalls: [],
    goldHasMissingPrices: false,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getSkills: () => game.skills,
    },
}));

vi.mock('../../utils/tea-optimizer.js', () => ({
    scoreEquipmentSetup: (skillName, goal, equipment, playerLevel, selectedActionHrids) => {
        scoring.calls.push({ skillName, goal, equipment, playerLevel, selectedActionHrids });
        if (!equipment || equipment.size === 0) return scoring.baseline[goal];
        const [{ itemHrid, enhancementLevel }] = [...equipment.values()];
        return scoring.scores[goal]?.[`${itemHrid}@${enhancementLevel}`] ?? scoring.baseline[goal];
    },
    findOptimalTeas: (skillName, goal, _a, _b, _c, _d, equipment, selectedActionHrids) => {
        scoring.teaCalls.push({ skillName, goal, equipment, selectedActionHrids });
        return scoring.teaResults[goal];
    },
    getSkillActionsForDisplay: () => [],
    calculateSkillPerformance: () => ({}),
    skillGoldHasUnpricedMaterials: () => scoring.goldHasMissingPrices,
}));

// calculateSlotUpgradeCost is the only consumer. Each entry is keyed by side so a test can
// state, as data, what each leg of a buy/sell comparison resolves to — including a leg that
// resolves to nothing at all.
const priceBook = vi.hoisted(() => ({ entries: {}, calls: [] }));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: (itemHrid, options = {}) => {
        priceBook.calls.push({ itemHrid, options });
        const { side, enhancementLevel = 0 } = options;
        const price = priceBook.entries[`${side}:${itemHrid}@${enhancementLevel}`];
        if (typeof price !== 'number') return { price: null, missing: true, estimated: false, custom: false };
        return { price, missing: false, estimated: false, custom: false };
    },
}));

const {
    calculateSlotUpgradeCost,
    getPlayerSkillLevel,
    getItemsForSlot,
    getSkillDrinkItems,
    optimizeSkill,
    SKILLING_LOCATIONS,
    SKILL_TOOL_LOCATION,
    SLOT_DISPLAY_NAMES,
} = await import('./skilling-optimizer-engine.js');

const CHEESE_TOOL = '/items/cheese_brush';
const VERDANT_TOOL = '/items/verdant_brush';
const HAT = '/items/chefs_hat';

function itemDetailMap() {
    return {
        [CHEESE_TOOL]: {
            name: 'Cheese Brush',
            itemLevel: 10,
            equipmentDetail: {
                type: '/equipment_types/cheesesmithing_tool',
                noncombatStats: { cheesesmithingSpeed: 0.1, cheesesmithingEfficiency: 0.05 },
                levelRequirements: [{ levelTypeHrid: '/level_types/cheesesmithing', level: 10 }],
            },
        },
        [VERDANT_TOOL]: {
            name: 'Verdant Brush',
            itemLevel: 50,
            equipmentDetail: {
                type: '/equipment_types/cheesesmithing_tool',
                noncombatStats: { cheesesmithingSpeed: 0.2, skillingEfficiency: 0.05 },
                levelRequirements: [{ levelTypeHrid: '/level_types/cheesesmithing', level: 50 }],
            },
        },
        [HAT]: {
            name: "Chef's Hat",
            itemLevel: 20,
            equipmentDetail: {
                type: '/equipment_types/head',
                noncombatStats: { cookingEfficiency: 0.06 },
                levelRequirements: [{ levelTypeHrid: '/level_types/cooking', level: 20 }],
            },
        },
        '/items/plain_shirt': {
            name: 'Plain Shirt',
            itemLevel: 5,
            // Equipment with no noncombat stats is never a candidate
            equipmentDetail: { type: '/equipment_types/body', levelRequirements: [] },
        },
        '/items/milk': { name: 'Milk', itemLevel: 1 },
        '/items/efficiency_tea': {
            name: 'Efficiency Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
        },
        '/items/cheesesmithing_tea': {
            name: 'Cheesesmithing Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/cheesesmithing_level', flatBoost: 3 }] },
        },
        '/items/orange_juice': {
            name: 'Orange Juice',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/combat_drop_quantity', flatBoost: 0.1 }] },
        },
        '/items/plain_coffee': { name: 'Plain Coffee', consumableDetail: { buffs: [] } },
    };
}

beforeEach(() => {
    game.initClientData = { itemDetailMap: itemDetailMap() };
    game.skills = [
        { skillHrid: '/skills/cheesesmithing', level: 60 },
        { skillHrid: '/skills/cooking', level: 15 },
    ];
    scoring.scores = {};
    scoring.baseline = { xp: 100, gold: 1000 };
    scoring.calls = [];
    scoring.teaResults = { xp: { teas: ['xp-tea'] }, gold: { teas: ['gold-tea'] } };
    scoring.teaCalls = [];
    scoring.goldHasMissingPrices = false;
});

describe('getPlayerSkillLevel', () => {
    test('reads the character sheet', () => {
        expect(getPlayerSkillLevel('Cheesesmithing')).toBe(60);
        expect(getPlayerSkillLevel('cooking')).toBe(15);
    });

    test('defaults to 1 for a skill the character has never trained', () => {
        expect(getPlayerSkillLevel('Alchemy')).toBe(1);
    });
});

describe('slot metadata', () => {
    test('every skill tool location is one of the optimizable slots', () => {
        for (const location of Object.values(SKILL_TOOL_LOCATION)) {
            expect(SKILLING_LOCATIONS).toContain(location);
        }
    });

    test('every optimizable slot has a display name', () => {
        for (const location of SKILLING_LOCATIONS) {
            expect(SLOT_DISPLAY_NAMES[location]).toBeTruthy();
        }
    });
});

describe('getItemsForSlot', () => {
    test('keeps only items with a stat that matters to the skill', () => {
        const items = getItemsForSlot('/item_locations/cheesesmithing_tool', 'Cheesesmithing');

        expect(items.map((i) => i.hrid)).toEqual([VERDANT_TOOL, CHEESE_TOOL]); // itemLevel 50 before 10
        expect(items[0]).toMatchObject({ name: 'Verdant Brush', available: true, maxReq: 50, itemLevel: 50 });
    });

    test('marks items the character cannot yet equip', () => {
        game.skills = [{ skillHrid: '/skills/cheesesmithing', level: 20 }];

        const items = getItemsForSlot('/item_locations/cheesesmithing_tool', 'Cheesesmithing');

        expect(items.find((i) => i.hrid === VERDANT_TOOL).available).toBe(false);
        expect(items.find((i) => i.hrid === CHEESE_TOOL).available).toBe(true);
    });

    test('a head item that only helps cooking is invisible to cheesesmithing', () => {
        expect(getItemsForSlot('/item_locations/head', 'Cheesesmithing')).toEqual([]);
        expect(getItemsForSlot('/item_locations/head', 'Cooking').map((i) => i.hrid)).toEqual([HAT]);
    });

    test('gathering skills also care about gathering quantity', () => {
        game.initClientData.itemDetailMap['/items/gathering_necklace'] = {
            name: 'Necklace of Gathering',
            itemLevel: 30,
            equipmentDetail: {
                type: '/equipment_types/neck',
                noncombatStats: { gatheringQuantity: 0.06 },
                levelRequirements: [],
            },
        };

        expect(getItemsForSlot('/item_locations/neck', 'Milking').map((i) => i.hrid)).toEqual([
            '/items/gathering_necklace',
        ]);
        // Not a gathering skill → gatheringQuantity is not a relevant stat
        expect(getItemsForSlot('/item_locations/neck', 'Cheesesmithing')).toEqual([]);
    });

    test('returns nothing for an unknown slot or missing game data', () => {
        expect(getItemsForSlot('/item_locations/nonsense', 'Cooking')).toEqual([]);

        game.initClientData = null;
        expect(getItemsForSlot('/item_locations/head', 'Cooking')).toEqual([]);
    });
});

describe('getSkillDrinkItems', () => {
    test('keeps drinks with a skilling buff and drops the rest, sorted by name', () => {
        const drinks = getSkillDrinkItems();

        expect(drinks.map((d) => d.name)).toEqual(['Cheesesmithing Tea', 'Efficiency Tea']);
    });

    test('returns nothing without game data', () => {
        game.initClientData = null;

        expect(getSkillDrinkItems()).toEqual([]);
    });
});

describe('optimizeSkill', () => {
    test('production skills are optimized for XP, gathering skills for gold', () => {
        expect(optimizeSkill('Cheesesmithing', 60).goal).toBe('xp');
        expect(optimizeSkill('Milking', 60).goal).toBe('gold');
    });

    test('returns null without game data', () => {
        game.initClientData = null;

        expect(optimizeSkill('Cheesesmithing', 60)).toBeNull();
    });

    test('sweeps the default breakpoints and picks the best item at each one', () => {
        // Cheese Brush is the cheap early pick; Verdant Brush overtakes it from +12 up.
        scoring.scores.xp = {
            [`${CHEESE_TOOL}@7`]: 150,
            [`${CHEESE_TOOL}@10`]: 160,
            [`${CHEESE_TOOL}@12`]: 170,
            [`${VERDANT_TOOL}@7`]: 140,
            [`${VERDANT_TOOL}@10`]: 155,
            [`${VERDANT_TOOL}@12`]: 200,
        };

        const result = optimizeSkill('Cheesesmithing', 60);
        const slot = result.slots['/item_locations/cheesesmithing_tool'];

        expect(slot.name).toBe('Cheesesmithing Tool');
        expect(slot.candidateCount).toBe(2);
        expect(slot.progression.map((p) => p.breakpoint)).toEqual([7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
        expect(slot.progression[0]).toMatchObject({ breakpoint: 7, itemHrid: CHEESE_TOOL, score: 150 });
        expect(slot.progression[1]).toMatchObject({ breakpoint: 10, itemHrid: CHEESE_TOOL, score: 160 });
        expect(slot.progression[2]).toMatchObject({ breakpoint: 12, itemHrid: VERDANT_TOOL, score: 200 });
    });

    test('flags only the breakpoints where the winning item actually changes', () => {
        scoring.scores.xp = {
            [`${CHEESE_TOOL}@7`]: 150,
            [`${CHEESE_TOOL}@10`]: 160,
            [`${VERDANT_TOOL}@12`]: 200,
            [`${VERDANT_TOOL}@13`]: 210,
        };

        const progression = optimizeSkill('Cheesesmithing', 60).slots['/item_locations/cheesesmithing_tool']
            .progression;

        expect(progression[0].isChange).toBe(true); // nothing → Cheese Brush
        expect(progression[1].isChange).toBe(false); // still Cheese Brush
        expect(progression[2].isChange).toBe(true); // → Verdant Brush
        expect(progression[3].isChange).toBe(false); // still Verdant Brush
        expect(progression[4].isChange).toBe(true); // nothing scores above baseline at +14
    });

    test('an item that never beats the empty slot is left out entirely', () => {
        scoring.scores.xp = { [`${CHEESE_TOOL}@7`]: 90 }; // baseline is 100

        const result = optimizeSkill('Cheesesmithing', 60);

        expect(result.slots['/item_locations/cheesesmithing_tool']).toBeUndefined();
        expect(result.xpBaseline).toBe(100);
        expect(result.goldBaseline).toBe(1000);
    });

    test('a tie with the baseline is not an upgrade', () => {
        scoring.scores.xp = { [`${CHEESE_TOOL}@7`]: 100 };

        expect(optimizeSkill('Cheesesmithing', 60).slots['/item_locations/cheesesmithing_tool']).toBeUndefined();
    });

    test('refined items sweep their own breakpoints and never enhance below +10', () => {
        game.initClientData.itemDetailMap['/items/brush_refined'] = {
            name: 'Refined Brush',
            itemLevel: 70,
            equipmentDetail: {
                type: '/equipment_types/cheesesmithing_tool',
                noncombatStats: { cheesesmithingEfficiency: 0.2 },
                levelRequirements: [],
            },
        };
        scoring.scores.xp = { '/items/brush_refined@10': 300 };

        const result = optimizeSkill('Cheesesmithing', 60);
        const progression = result.slots['/item_locations/cheesesmithing_tool'].progression;

        // +7 exists in the union of breakpoints, but the refined item is scored at +10 there
        const atSeven = progression.find((p) => p.breakpoint === 7);
        expect(atSeven.itemHrid).toBe('/items/brush_refined');
        expect(atSeven.score).toBe(300);

        const refinedCalls = scoring.calls.filter(
            (c) => c.equipment?.size && [...c.equipment.values()][0].itemHrid === '/items/brush_refined'
        );
        expect(refinedCalls.every((c) => [...c.equipment.values()][0].enhancementLevel >= 10)).toBe(true);
    });

    test('jewellery slots start their sweep at +5', () => {
        game.initClientData.itemDetailMap['/items/efficiency_ring'] = {
            name: 'Ring of Efficiency',
            itemLevel: 30,
            equipmentDetail: {
                type: '/equipment_types/ring',
                noncombatStats: { skillingEfficiency: 0.04 },
                levelRequirements: [],
            },
        };
        scoring.scores.xp = { '/items/efficiency_ring@5': 120 };

        const progression = optimizeSkill('Cheesesmithing', 60).slots['/item_locations/ring'].progression;

        expect(progression[0].breakpoint).toBe(5);
        expect(progression[0].itemHrid).toBe('/items/efficiency_ring');
    });

    test('scores the winner against the other goal too, so both columns are filled', () => {
        scoring.scores.xp = { [`${CHEESE_TOOL}@7`]: 150 };
        scoring.scores.gold = { [`${CHEESE_TOOL}@7`]: 2500 };

        const entry = optimizeSkill('Cheesesmithing', 60).slots['/item_locations/cheesesmithing_tool'].progression[0];

        expect(entry.score).toBe(150); // primary goal for a production skill
        expect(entry.xpScore).toBe(150);
        expect(entry.goldScore).toBe(2500);
    });

    test('breakpoints with no winner fall back to the baselines for both columns', () => {
        scoring.scores.xp = { [`${CHEESE_TOOL}@7`]: 150 };

        const progression = optimizeSkill('Cheesesmithing', 60).slots['/item_locations/cheesesmithing_tool']
            .progression;

        expect(progression[1].itemHrid).toBeNull();
        expect(progression[1].xpScore).toBe(100);
        expect(progression[1].goldScore).toBe(1000);
    });

    test('hands the tea optimizer the best gear at +20 and runs it for both goals', () => {
        scoring.scores.xp = {
            [`${CHEESE_TOOL}@7`]: 150,
            [`${VERDANT_TOOL}@20`]: 400,
        };

        const result = optimizeSkill('Cheesesmithing', 60, new Set(['/actions/cheesesmithing/cheese']));

        expect(scoring.teaCalls.map((c) => c.goal)).toEqual(['xp', 'gold']);
        const equipment = scoring.teaCalls[0].equipment;
        expect(equipment.get('/item_locations/cheesesmithing_tool')).toEqual({
            itemHrid: VERDANT_TOOL,
            enhancementLevel: 20,
        });
        expect(scoring.teaCalls[0].selectedActionHrids).toEqual(new Set(['/actions/cheesesmithing/cheese']));
        expect(result.xpTeaResult).toEqual({ teas: ['xp-tea'] });
        expect(result.goldTeaResult).toEqual({ teas: ['gold-tea'] });
    });

    test('a failed tea optimization is reported as no result rather than an error object', () => {
        scoring.teaResults = { xp: { error: 'no actions' }, gold: null };

        const result = optimizeSkill('Cheesesmithing', 60);

        expect(result.xpTeaResult).toBeNull();
        expect(result.goldTeaResult).toBeNull();
    });

    test('a gold-goal skill forwards whether the equipment ranking leans on an unpriced material', () => {
        // Gathering skills rank equipment by gold, so a material the ranking could not price
        // (treated as free rather than excluded — see actionHasUnpricedMaterials in
        // tea-optimizer.js) can make an item look like the winner when its true value is
        // unknown. The equipment-optimizer surface had no such signal at all before this,
        // unlike the tea-optimizer's own Gold/hr stat.
        scoring.goldHasMissingPrices = true;

        const result = optimizeSkill('Milking', 60);

        expect(result.goal).toBe('gold');
        expect(result.goldHasMissingPrices).toBe(true);
    });

    test('an xp-goal skill does not claim an unpriced-material warning it never checked', () => {
        scoring.goldHasMissingPrices = true; // would only matter for a gold-ranked skill

        const result = optimizeSkill('Cheesesmithing', 60);

        expect(result.goal).toBe('xp');
        expect(result.goldHasMissingPrices).toBe(false);
    });

    test('candidates are gated on the requested level, not the character sheet', () => {
        game.skills = [{ skillHrid: '/skills/cheesesmithing', level: 5 }];
        scoring.scores.xp = { [`${VERDANT_TOOL}@7`]: 500 };

        // At the character's real level 5 the Verdant Brush (needs 50) is unusable...
        expect(optimizeSkill('Cheesesmithing', 5).slots['/item_locations/cheesesmithing_tool']).toBeUndefined();
        // ...but planning ahead at level 50 it becomes a candidate.
        const planned = optimizeSkill('Cheesesmithing', 50);
        expect(planned.playerLevel).toBe(50);
        expect(planned.slots['/item_locations/cheesesmithing_tool'].progression[0].itemHrid).toBe(VERDANT_TOOL);
    });
});

describe('calculateSlotUpgradeCost', () => {
    beforeEach(() => {
        priceBook.entries = {};
        priceBook.calls = [];
    });

    test('with no current item, the cost is the full buy price at the scored enhancement level', () => {
        priceBook.entries[`buy:${VERDANT_TOOL}@10`] = 750;
        expect(calculateSlotUpgradeCost(VERDANT_TOOL, 10, null)).toBe(750);
    });

    test('with a current item, the cost is netted against selling it', () => {
        priceBook.entries[`buy:${VERDANT_TOOL}@10`] = 750;
        priceBook.entries[`sell:${CHEESE_TOOL}@3`] = 200;
        const cost = calculateSlotUpgradeCost(VERDANT_TOOL, 10, { itemHrid: CHEESE_TOOL, enhancementLevel: 3 });
        expect(cost).toBe(550);
    });

    test('both legs resolve under the player pricing mode, so neither side is priced differently', () => {
        priceBook.entries[`buy:${VERDANT_TOOL}@0`] = 750;
        priceBook.entries[`sell:${CHEESE_TOOL}@0`] = 200;
        calculateSlotUpgradeCost(VERDANT_TOOL, 0, { itemHrid: CHEESE_TOOL, enhancementLevel: 0 });
        expect(priceBook.calls.map((c) => c.options.context)).toEqual(['profit', 'profit']);
        // A hard-coded `mode` would override the player's setting on that leg only — the exact
        // one-sided-basis bug this comparison must not have.
        expect(priceBook.calls.every((c) => c.options.mode === undefined)).toBe(true);
    });

    test('a current item worth more than the upgrade floors at zero rather than paying you', () => {
        priceBook.entries[`buy:${VERDANT_TOOL}@0`] = 100;
        priceBook.entries[`sell:${CHEESE_TOOL}@0`] = 900;
        const cost = calculateSlotUpgradeCost(VERDANT_TOOL, 0, { itemHrid: CHEESE_TOOL, enhancementLevel: 0 });
        expect(cost).toBe(0);
    });

    test('an unpriceable upgrade is null, not free', () => {
        expect(calculateSlotUpgradeCost(VERDANT_TOOL, 10, null)).toBeNull();
    });

    test('an unpriceable current item makes the net cost unknown rather than the gross price', () => {
        priceBook.entries[`buy:${VERDANT_TOOL}@10`] = 750;
        const cost = calculateSlotUpgradeCost(VERDANT_TOOL, 10, { itemHrid: CHEESE_TOOL, enhancementLevel: 3 });
        expect(cost).toBeNull();
    });

    test('no item to buy is unpriceable, not free', () => {
        expect(calculateSlotUpgradeCost(null, 10, null)).toBeNull();
    });
});
