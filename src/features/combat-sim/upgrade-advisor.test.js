/**
 * Tests for Upgrade Advisor candidate generation
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const guild = vi.hoisted(() => ({
    /** buffHrid → detail, as initClientData.guildBuffDetailMap sends it */
    detailMap: {},
    /** shrineHrid → the level the guild has built it to */
    shrineLevels: {},
    /** Calls the advisor made to rebuild a combat buff array */
    applied: [],
}));

/** The books this character has read, which is what an ability swap is costed from */
const character = vi.hoisted(() => ({ characterAbilities: [] }));

/**
 * What a guild token is worth, in gold. Null is the state a player is in when
 * neither the client nor their settings name a token→credit exchange rate, and
 * is what every test that is not about token pricing runs with.
 */
const token = vi.hoisted(() => ({ goldPerToken: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getGuildBuildingLevel: (hrid) => guild.shrineLevels[hrid] || 0,
        // What the forced armor candidates read to price a piece at the level
        // you already own it at; nothing in these tests owns anything
        getInventory: () => [],
        // Read by the shared params resolver, to ask whether the piece being costed could be
        // bought finished from anybody. Nothing in this suite is untradable, so the sweeps here
        // all run on whichever bench the simulator settings resolve to.
        getInitClientData: () => ({ itemDetailMap: {} }),
        // The same object throughout, so a test can put books in it
        characterData: character,
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    // The synthesis itself is the adapter's business and is tested there; what
    // matters here is that the advisor asks for the right level and puts the
    // answer where the engine reads it
    getGuildBuffDetailMap: () => guild.detailMap,
    guildBuffMaxLevel: (detail) =>
        Math.max(
            0,
            ...Object.keys(detail?.levelCosts || {})
                .map(Number)
                .filter(Number.isFinite)
        ),
    applyGuildBuffLevel: (buffs, detail, level) => {
        guild.applied.push({ hrid: detail.hrid, level });
        return [{ typeHrid: detail.buffs[0].typeHrid, level }];
    },
}));
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: vi.fn(() => ({})),
    priceGuildCreditCosts: vi.fn((costs) => {
        const lines = (costs || []).map(({ itemHrid, count }) => ({
            itemHrid,
            name: itemHrid,
            count,
            goldEach: itemHrid === '/items/unpriced_credit' ? null : 100,
            gold: itemHrid === '/items/unpriced_credit' ? null : 100 * count,
        }));
        const unpriced = lines.filter((line) => line.gold === null).map((line) => line.name);
        return {
            lines,
            total: unpriced.length > 0 ? null : lines.reduce((sum, line) => sum + line.gold, 0),
            unpriced,
        };
    }),
}));
// The exchange chain itself (client rate → credit price → gold) is tested in
// guild-token-value.test.js; here only the one number it hands over matters
vi.mock('../guild/guild-token-value.js', () => {
    const valuation = () => ({
        gold: token.goldPerToken,
        creditsPerToken: 1,
        creditItemHrid: '/items/guild_credit_1',
        goldPerCredit: token.goldPerToken,
        source: token.goldPerToken ? 'client' : 'unknown',
        assumed: false,
        note: token.goldPerToken ? 'via credit exchange at 1 credit/token' : null,
    });
    return {
        explainGuildTokenValue: vi.fn(valuation),
        describeGuildTokenGold: vi.fn((tokens, _mode, options = {}) => {
            const rate = (options.valuation || valuation()).gold;
            if (!(tokens > 0) || !(rate > 0)) return null;
            return {
                gold: tokens * rate,
                text: `≈${tokens * rate}g via credit exchange`,
                title: 'priced through the guild shop exchange',
                valuation: options.valuation || valuation(),
            };
        }),
    };
});
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
const clearRate = vi.hoisted(() => ({
    /** Which skills the XP metric actually asked about */
    xpAskedFor: [],
    impl: {},
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({
    default: {
        getSkillingMetricsFromOverrides: (...args) => clearRate.impl.getSkillingMetricsFromOverrides?.(...args),
        computeSkillingClearWithParams: (...args) => clearRate.impl.computeSkillingClearWithParams?.(...args),
        computeEnhancingClearWithParams: (...args) => clearRate.impl.computeEnhancingClearWithParams?.(...args),
    },
}));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: vi.fn() }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: vi.fn() }));
// Partial: the chain solve is stubbed so a test can say how many attempts a run
// takes, but the cost statistics the shared sweep reads off that solve are the
// real ones — stubbing them would test nothing
vi.mock('../../utils/enhancement-calculator.js', async (importOriginal) => ({
    ...(await importOriginal()),
    calculateEnhancement: vi.fn(),
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: vi.fn(),
    getAutoDetectedParams: vi.fn(),
    getProRatesParams: vi.fn(),
    // Read by `describeEnhancementSource`, which names whose bench a sweep ran on
    describeParamsSource: vi.fn(() => null),
}));
// The enhancement pricing rules moved to utils so every bundle could share one
// copy; this file drives the advisor's use of them, not the rules themselves,
// which have their own suite in src/utils/enhancement-pricing.test.js
vi.mock('../../utils/enhancement-pricing.js', () => ({
    getCheapestProtectionPrice: vi.fn(),
    perAttemptMaterialCost: vi.fn(),
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityLevelUpCost: vi.fn(() => ({
        bookHrid: '/items/fireball',
        bookName: 'Fireball',
        books: 12.4,
        xpPerBook: 50,
        bookPrice: 1000,
        total: 12_400,
        learnBook: false,
    })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const {
    generateCandidates,
    applyPathBootsSimLevel,
    addRefinedPathBootCandidates,
    runUpgradeAnalysis,
    applyCandidateToDTO,
    calculateUpgradeCost,
    findMatchingCharmForSkill,
    getMainTrainingSkills,
    getPrimaryTrainingSkill,
    primaryLevelsAlongside,
    runLabyrinthAllFightsAnalysis,
    runLabyrinthCombinationCheck,
    labAllFightsTrialBudget,
    ALL_FIGHTS_SIM_BUDGET,
    MIN_TRIAL_FRACTION,
    generateSkillingEquipmentCandidates,
    canMoveSkillingClearRate,
    runSkillingUpgradeAnalysis,
    generateLabyrinthBuffCandidates,
    generateLabyrinthBuffCandidatesFromEditor,
    generateGuildShrineCandidates,
    generateHouseCandidates,
    houseRoomAffectsCombat,
    houseRoomMovesWinRate,
    houseUpgradeMaterials,
    describeHouseScan,
    resolveCandidateModes,
    candidateAssignmentKey,
    candidateAppliesToDTO,
    applyToEquipment,
    attemptsNoise,
    rateDeltaNoisePct,
    significantDeltas,
    generateDrinkCandidates,
    generateCommunityBuffCandidates,
    generateScrollCandidates,
    conflictKey,
    conflictKeys,
    planWithinBudget,
    valuePerMillion,
    goldPerPercent,
    replacedIn,
    explainUpgradeCost,
    computeEconomics,
    assignRankScores,
    RANK_PLACES,
    SCORE_METRICS,
    DEFAULT_SCORE_KEYS,
} = await import('./upgrade-advisor.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { getItemPrices } = await import('../../utils/market-data.js');
const { calculateEnhancement } = await import('../../utils/enhancement-calculator.js');
const { getCheapestProtectionPrice, perAttemptMaterialCost } = await import('../../utils/enhancement-pricing.js');
const { getEnhancingParams } = await import('../../utils/enhancement-config.js');
const { explainAbilityLevelUpCost } = await import('../../utils/ability-cost-calculator.js');
const { runSimulation, plannedWorkerCount } = await import('./combat-sim-runner.js');
const { buildGameDataPayload, calculateSimRevenue } = await import('./combat-sim-adapter.js');
const { runLabyrinthSimulation } = await import('./combat-sim-runner.js');

// The advisor asks the shared pricing rule what one attempt's materials come to.
// Most tests here are not about that number, so give it a default they can ignore
// and let the ones that care override it.
// The same goes for the shared price lookup: the real one always answers with a
// `{ price }` object, so a bare `vi.fn()` returning undefined is a shape the
// callers are entitled not to guard against. Without a default here, a describe
// that does not price anything itself ("the materials behind a house level")
// only worked while some earlier test's `mockImplementation` was still
// installed, and threw on destructuring as soon as it ran first.
beforeEach(() => {
    perAttemptMaterialCost.mockReturnValue({ cost: 0, hasCost: false, hasMissingPrices: true });
    resolveItemPrice.mockReturnValue({ price: 0, custom: false, missing: true, estimated: false });
});

const MAIN_HAND = '/equipment_types/main_hand';
const BACK = '/equipment_types/back';

function buildGameData() {
    return {
        actionDetailMap: {},
        itemDetailMap: {
            '/items/fine_sword': {
                name: 'Fine Sword',
                itemLevel: 50,
                sortIndex: 1,
                equipmentDetail: {
                    type: MAIN_HAND,
                    combatStats: { slashDamage: 10 },
                },
            },
            '/items/regal_sword_refined': {
                name: 'Regal Sword (R)',
                itemLevel: 60,
                sortIndex: 2,
                equipmentDetail: {
                    type: MAIN_HAND,
                    combatStats: { slashDamage: 15 },
                },
            },
            '/items/plain_cape': {
                name: 'Plain Cape',
                itemLevel: 50,
                sortIndex: 3,
                equipmentDetail: {
                    type: BACK,
                    combatStats: { slashDamage: 3 },
                },
            },
            '/items/grand_cape_refined': {
                name: 'Grand Cape (R)',
                itemLevel: 60,
                sortIndex: 4,
                equipmentDetail: {
                    type: BACK,
                    combatStats: { slashDamage: 5 },
                },
            },
        },
    };
}

function buildPlayer(hrid, enhancementLevel) {
    return {
        equipment: {
            [MAIN_HAND]: { hrid, enhancementLevel },
        },
    };
}

describe('generateCandidates refined-equipment gating', () => {
    test('clamps refined recommendations below +10 up to +10', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 4), buildGameData(), 'equipment');

        // The refined tier upgrade is still suggested, but at +10 (refined items
        // cannot exist below +10). The clamp is exactly the case where the two
        // sides of the swap stop sharing a level, so the label must carry both:
        // one trailing "(+10)" would have quoted the new level for the sword
        // being handed in as well.
        const refinedTier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        expect(refinedTier).toBeDefined();
        expect(refinedTier.upgradeLevel).toBe(10);
        expect(refinedTier.description).toBe('Fine Sword +4 → Regal Sword (R) +10');

        // The regular enhancement candidate on the current item is still present
        expect(candidates.some((c) => c.type === 'enhancement' && c.upgradeHrid === '/items/fine_sword')).toBe(true);
    });

    test('recommends refined gear at +10 and above', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 10), buildGameData(), 'equipment');

        const refinedTier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        expect(refinedTier).toBeDefined();
        expect(refinedTier.upgradeLevel).toBe(10);
    });

    test('still generates enhancement candidates for an already-equipped refined item', () => {
        const candidates = generateCandidates(
            buildPlayer('/items/regal_sword_refined', 10),
            buildGameData(),
            'equipment'
        );

        const enhancement = candidates.find(
            (c) => c.type === 'enhancement' && c.upgradeHrid === '/items/regal_sword_refined'
        );
        expect(enhancement).toBeDefined();
        expect(enhancement.upgradeLevel).toBeGreaterThanOrEqual(10);
    });

    test('does not clamp refined capes — the back slot is exempt', () => {
        const player = {
            equipment: {
                [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 4 },
            },
        };
        const candidates = generateCandidates(player, buildGameData(), 'equipment');

        const refinedCape = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/grand_cape_refined');
        expect(refinedCape).toBeDefined();
        expect(refinedCape.upgradeLevel).toBe(4);
        expect(refinedCape.description).toBe('Plain Cape +4 → Grand Cape (R) +4');
    });

    test('equipped refined capes below +10 use the back breakpoints', () => {
        const player = {
            equipment: {
                [BACK]: { hrid: '/items/grand_cape_refined', enhancementLevel: 3 },
            },
        };
        const candidates = generateCandidates(player, buildGameData(), 'equipment');

        const enhancement = candidates.find(
            (c) => c.type === 'enhancement' && c.upgradeHrid === '/items/grand_cape_refined'
        );
        expect(enhancement).toBeDefined();
        // Next back-slot breakpoint after +3 is +5, not the refined table's +10
        expect(enhancement.upgradeLevel).toBe(5);
    });
});

describe('applyPathBootsSimLevel', () => {
    const swap = (upgradeHrid, upgradeLevel, extra = {}) => ({
        type: 'tier',
        currentHrid: '/items/centaur_boots',
        upgradeHrid,
        upgradeLevel,
        description: `Centaur Boots +10 → X (+${upgradeLevel})`,
        ...extra,
    });

    test('pins a base path boot to +7 when the worn piece is below +10', () => {
        const c = swap('/items/pathfinder_boots', 10, { currentLevel: 8 });
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(7);
        expect(c.description).toBe('Centaur Boots +10 → X (+7)');
    });

    test('recommends +10 when the worn boots are already +10 or higher', () => {
        const c = swap('/items/pathfinder_boots', 7, { currentLevel: 10 });
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(10);
        expect(c.description).toBe('Centaur Boots +10 → X (+10)');
    });

    test('raises a path boot below +7 up to +7 as well', () => {
        const c = swap('/items/pathbreaker_boots', 3, { currentLevel: 3 });
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(7);
    });

    test('a refined path boot lands at +7 when the worn piece is below +10', () => {
        const c = swap('/items/pathseeker_boots_refined', 10, { currentLevel: 7 });
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(7);
    });

    test('a refined path boot keeps +10 when the worn boots are +10 or higher', () => {
        const c = swap('/items/pathseeker_boots_refined', 10, { currentLevel: 12 });
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(10);
    });

    test('a refined path boot with a swapLabel redraws its description to +7', () => {
        const c = {
            type: 'tier',
            currentHrid: '/items/pathfinder_boots',
            currentLevel: 7,
            upgradeHrid: '/items/pathfinder_boots_refined',
            upgradeLevel: 10, // as left by the refined +10 clamp
            swapLabel: { from: 'Pathfinder Boots', to: ['Pathfinder Boots (R)'] },
            description: 'Pathfinder Boots +7 → Pathfinder Boots (R) +10',
        };
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(7);
        expect(c.description).toContain('Pathfinder Boots (R) +7');
    });

    test('leaves non-path-boot swaps alone', () => {
        const c = swap('/items/regal_sword_refined', 10);
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(10);
    });

    test('does not touch an enhancement candidate on an already-worn path boot', () => {
        const c = {
            type: 'enhancement',
            currentHrid: '/items/pathfinder_boots',
            upgradeHrid: '/items/pathfinder_boots',
            upgradeLevel: 12,
            description: 'Pathfinder Boots +10 → +12',
        };
        applyPathBootsSimLevel(c);
        expect(c.upgradeLevel).toBe(12);
    });
});

describe('addRefinedPathBootCandidates', () => {
    const gameData = {
        itemDetailMap: {
            '/items/pathfinder_boots_refined': { name: 'Pathfinder Boots (R)' },
            '/items/pathbreaker_boots_refined': { name: 'Pathbreaker Boots (R)' },
            '/items/pathseeker_boots_refined': { name: 'Pathseeker Boots (R)' },
        },
    };

    const baseCandidate = () => ({
        slot: '/equipment_types/feet',
        currentHrid: '/items/centaur_boots',
        currentLevel: 10,
        upgradeHrid: '/items/pathfinder_boots',
        upgradeLevel: 10,
        swapLabel: { from: 'Centaur Boots', to: ['Pathfinder Boots'] },
        description: 'Centaur Boots +10 → Pathfinder Boots +10',
        type: 'tier',
    });

    test('adds a refined sibling for a base path-boot swap', () => {
        const candidates = [baseCandidate()];
        addRefinedPathBootCandidates(candidates, gameData);
        expect(candidates).toHaveLength(2);
        const refined = candidates.find((c) => c.upgradeHrid === '/items/pathfinder_boots_refined');
        expect(refined).toBeDefined();
        expect(refined.currentHrid).toBe('/items/centaur_boots');
        expect(refined.swapLabel.to).toEqual(['Pathfinder Boots (R)']);
        expect(refined.type).toBe('tier');
    });

    test('the added refined sibling follows the worn level through the passes', () => {
        // baseCandidate wears +10, so the sibling it inherits from is recommended
        // at +10 (a +10 wearer would enhance the path boots to +10 too).
        const candidates = [baseCandidate()];
        addRefinedPathBootCandidates(candidates, gameData);
        candidates.forEach(applyPathBootsSimLevel);
        const refined = candidates.find((c) => c.upgradeHrid === '/items/pathfinder_boots_refined');
        expect(refined.upgradeLevel).toBe(10);
        expect(refined.description).toContain('Pathfinder Boots (R) +10');
    });

    test('the sibling normalizes to +7 when the worn boots are below +10', () => {
        const candidates = [{ ...baseCandidate(), currentLevel: 8 }];
        addRefinedPathBootCandidates(candidates, gameData);
        candidates.forEach(applyPathBootsSimLevel);
        const refined = candidates.find((c) => c.upgradeHrid === '/items/pathfinder_boots_refined');
        expect(refined.upgradeLevel).toBe(7);
        expect(refined.description).toContain('Pathfinder Boots (R) +7');
    });

    test('does not duplicate a refined swap that already exists for the same worn boot', () => {
        const candidates = [
            baseCandidate(),
            {
                slot: '/equipment_types/feet',
                currentHrid: '/items/centaur_boots',
                currentLevel: 10,
                upgradeHrid: '/items/pathfinder_boots_refined',
                upgradeLevel: 7,
                swapLabel: { from: 'Centaur Boots', to: ['Pathfinder Boots (R)'] },
                description: 'Centaur Boots +10 → Pathfinder Boots (R) +7',
                type: 'tier',
            },
        ];
        addRefinedPathBootCandidates(candidates, gameData);
        const refined = candidates.filter((c) => c.upgradeHrid === '/items/pathfinder_boots_refined');
        expect(refined).toHaveLength(1);
    });

    test('leaves non-path-boot candidates alone', () => {
        const candidates = [
            {
                slot: '/equipment_types/feet',
                currentHrid: '/items/centaur_boots',
                currentLevel: 10,
                upgradeHrid: '/items/collectors_boots',
                upgradeLevel: 10,
                type: 'tier',
            },
        ];
        addRefinedPathBootCandidates(candidates, gameData);
        expect(candidates).toHaveLength(1);
    });

    test('skips a base path boot whose refined form is absent from game data', () => {
        const candidates = [baseCandidate()];
        addRefinedPathBootCandidates(candidates, { itemDetailMap: {} });
        expect(candidates).toHaveLength(1);
    });
});

describe('generateCandidates combat_level mode', () => {
    test('generates one +N candidate per style-relevant combat skill', () => {
        const player = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 95,
            attackLevel: 100,
            meleeLevel: 100,
            defenseLevel: 88,
            rangedLevel: 110,
            magicLevel: 70,
        };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 5);

        // Melee weapon → Ranged and Magic are irrelevant and excluded
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'meleeLevel',
            'defenseLevel',
        ]);
        const melee = candidates.find((c) => c.skillKey === 'meleeLevel');
        expect(melee.currentLevel).toBe(100);
        expect(melee.upgradeLevel).toBe(105);
        expect(melee.description).toBe('Melee 100 → 105');
        expect(candidates.every((c) => c.type === 'combat_level')).toBe(true);
    });

    test('ranged weapons exclude the melee and magic skills', () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        const player = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 90,
        };
        const candidates = generateCandidates(player, gameData, 'combat_level', 5);

        // Attack stays — it trains under every style via the XP split
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'defenseLevel',
            'rangedLevel',
        ]);
    });

    test('magic weapons exclude the melee and ranged skills', () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_staff'] = {
            name: 'Fine Staff',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { magicDamage: 12 } },
        };
        const player = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_staff', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 90,
        };
        const candidates = generateCandidates(player, gameData, 'combat_level', 5);

        // Melee and Ranged are excluded for magic weapons; Attack stays
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'defenseLevel',
            'magicLevel',
        ]);
    });

    test('defaults the boost to 5 and combat level costs are null', () => {
        const player = { equipment: {}, staminaLevel: 50 };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 0);

        const stamina = candidates.find((c) => c.skillKey === 'staminaLevel');
        expect(stamina.upgradeLevel).toBe(55);
        expect(calculateUpgradeCost(stamina, buildGameData())).toBeNull();
        // Unarmed counts as melee — Ranged and Magic are excluded here too
        expect(candidates.some((c) => c.skillKey === 'rangedLevel' || c.skillKey === 'magicLevel')).toBe(false);
    });

    test('per-skill target levels override the uniform boost', () => {
        const player = { equipment: {}, staminaLevel: 50, attackLevel: 100, defenseLevel: 80 };
        const targets = { staminaLevel: 60, attackLevel: 90, defenseLevel: 85 };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 5, 'increment', false, targets);

        // attack target (90) is below current (100) → skipped; others use targets
        expect(candidates.find((c) => c.skillKey === 'attackLevel')).toBeUndefined();
        expect(candidates.find((c) => c.skillKey === 'staminaLevel').upgradeLevel).toBe(60);
        expect(candidates.find((c) => c.skillKey === 'defenseLevel').upgradeLevel).toBe(85);
        // skills without a target entry are skipped too
        expect(candidates.find((c) => c.skillKey === 'magicLevel')).toBeUndefined();
    });
});

describe('generateCandidates ability_level targets', () => {
    test('per-ability target levels override the uniform increment', () => {
        const gameData = buildGameData();
        gameData.abilityDetailMap = {
            '/abilities/cleave': { name: 'Cleave' },
            '/abilities/insanity': { name: 'Insanity' },
        };
        const player = {
            equipment: {},
            abilities: [
                { hrid: '/abilities/cleave', level: 60 },
                { hrid: '/abilities/insanity', level: 20 },
            ],
        };
        const targets = { '/abilities/insanity': 25 };
        const candidates = generateCandidates(player, gameData, 'ability_level', 5, 'increment', false, null, targets);

        // Only the targeted ability produces a candidate, at its target level;
        // Cleave has no entry and is skipped
        expect(candidates).toHaveLength(1);
        expect(candidates[0].upgradeHrid).toBe('/abilities/insanity');
        expect(candidates[0].upgradeLevel).toBe(25);
        expect(candidates[0].description).toBe('Insanity Lv20 → Lv25');
    });

    test('a target at or below the current level skips the ability', () => {
        const gameData = buildGameData();
        gameData.abilityDetailMap = { '/abilities/cleave': { name: 'Cleave' } };
        const player = { equipment: {}, abilities: [{ hrid: '/abilities/cleave', level: 60 }] };
        const candidates = generateCandidates(player, gameData, 'ability_level', 5, 'increment', false, null, {
            '/abilities/cleave': 55,
        });
        expect(candidates).toHaveLength(0);
    });
});

describe('findMatchingCharmForSkill', () => {
    const CHARM = '/equipment_types/charm';
    function charmGameData() {
        const charm = (name, itemLevel, skill) => ({
            name,
            itemLevel,
            equipmentDetail: { type: CHARM, combatStats: { focusTraining: `/skills/${skill}` } },
        });
        return {
            itemDetailMap: {
                '/items/basic_melee_charm': charm('Basic Melee Charm', 10, 'melee'),
                '/items/expert_melee_charm': charm('Expert Melee Charm', 60, 'melee'),
                '/items/basic_defense_charm': charm('Basic Defense Charm', 10, 'defense'),
                '/items/expert_defense_charm': charm('Expert Defense Charm', 60, 'defense'),
            },
        };
    }
    const equipped = { hrid: '/items/expert_melee_charm', enhancementLevel: 5 };

    test('matches the equipped charm tier for another skill, keeping enhancement', () => {
        const result = findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_defense_charm', enhancementLevel: 5 });
    });

    test('keeps the equipped charm when it already focuses the skill', () => {
        const result = findMatchingCharmForSkill(equipped, 'meleeLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_melee_charm', enhancementLevel: 5 });
    });

    test('an explicit tier overrides the equipped charm tier', () => {
        const result = findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData(), 'Basic');
        expect(result).toEqual({ hrid: '/items/basic_defense_charm', enhancementLevel: 5 });
    });

    test('tier "none" simulates without a charm', () => {
        expect(findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData(), 'none')).toBeNull();
    });

    test('falls back to the highest-level charm when nothing is equipped', () => {
        const result = findMatchingCharmForSkill(null, 'defenseLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_defense_charm', enhancementLevel: 0 });
    });

    test('an explicit enhancement level overrides the equipped one, on every path', () => {
        expect(findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData(), 'Basic', 12)).toEqual({
            hrid: '/items/basic_defense_charm',
            enhancementLevel: 12,
        });
        expect(findMatchingCharmForSkill(equipped, 'meleeLevel', charmGameData(), 'auto', 3)).toEqual({
            hrid: '/items/expert_melee_charm',
            enhancementLevel: 3,
        });
        expect(findMatchingCharmForSkill(null, 'defenseLevel', charmGameData(), 'auto', 7)).toEqual({
            hrid: '/items/expert_defense_charm',
            enhancementLevel: 7,
        });
    });
});

describe('primaryLevelsAlongside', () => {
    // XP table: level L needs 1000 * L XP
    const gameData = { levelExperienceTable: Array.from({ length: 201 }, (_, level) => 1000 * level) };
    const sim = (target, primary) => ({ experienceGained: { me: { defense: target, melee: primary } } });

    test('the primary skill earns in proportion to its XP rate over the same grind', () => {
        // Defense 150 → 155 needs 5000 XP at 70%; melee earns 30% → ~2143 XP → 2 levels
        const along = primaryLevelsAlongside(
            { skillKey: 'defenseLevel', currentLevel: 150, upgradeLevel: 155 },
            'melee',
            sim(700, 300),
            gameData,
            'me',
            { meleeLevel: 150 }
        );
        expect(along.skillKey).toBe('meleeLevel');
        expect(along.label).toBe('Melee');
        expect(along.currentLevel).toBe(150);
        expect(along.upgradeLevel).toBe(152);
        expect(along.xpGained).toBeCloseTo(5000 * (300 / 700), 6);
    });

    test('no XP in the target skill means no estimate', () => {
        expect(
            primaryLevelsAlongside(
                { skillKey: 'defenseLevel', currentLevel: 150, upgradeLevel: 155 },
                'melee',
                sim(0, 300),
                gameData,
                'me',
                { meleeLevel: 150 }
            )
        ).toBeNull();
    });

    test('a bulwark with a defense charm leaves nothing for anybody else', () => {
        // Primary is defense too — caller never asks; but a zero primary rate reads as no levels
        const along = primaryLevelsAlongside(
            { skillKey: 'staminaLevel', currentLevel: 150, upgradeLevel: 151 },
            'defense',
            { experienceGained: { me: { stamina: 700, defense: 0 } } },
            gameData,
            'me',
            { defenseLevel: 150 }
        );
        expect(along.upgradeLevel).toBe(150);
    });
});

describe('getMainTrainingSkills', () => {
    test('is the weapon primary training skill alone — a spear trains attack, the charm takes the rest', () => {
        const gameData = {
            itemDetailMap: {
                '/items/spear': {
                    equipmentDetail: {
                        type: MAIN_HAND,
                        combatStats: { primaryTraining: '/skills/attack', combatStyleHrids: ['/combat_styles/stab'] },
                    },
                },
            },
            combatStyleDetailMap: {
                '/combat_styles/stab': {
                    // Real skillExpMaps include stamina/intelligence/defense too —
                    // only the offensive skills count as "main"
                    skillExpMap: {
                        '/skills/attack': 0.2,
                        '/skills/melee': 0.2,
                        '/skills/stamina': 0.2,
                        '/skills/intelligence': 0.2,
                        '/skills/defense': 0.2,
                    },
                },
            },
        };
        const player = { equipment: { [MAIN_HAND]: { hrid: '/items/spear', enhancementLevel: 0 } } };
        expect(getMainTrainingSkills(player, gameData)).toEqual(['attack']);
        expect(getPrimaryTrainingSkill(player, gameData)).toBe('attack');
    });

    test('a bulwark names defense', () => {
        const gameData = {
            itemDetailMap: {
                '/items/griffin_bulwark': {
                    equipmentDetail: {
                        type: MAIN_HAND,
                        combatStats: { primaryTraining: '/skills/defense', combatStyleHrids: ['/combat_styles/smash'] },
                    },
                },
            },
            combatStyleDetailMap: {},
        };
        const player = { equipment: { [MAIN_HAND]: { hrid: '/items/griffin_bulwark', enhancementLevel: 0 } } };
        expect(getPrimaryTrainingSkill(player, gameData)).toBe('defense');
    });

    test('defaults to melee with no weapon equipped', () => {
        expect(getMainTrainingSkills({ equipment: {} }, { itemDetailMap: {}, combatStyleDetailMap: {} })).toEqual([
            'melee',
        ]);
    });
});

describe('a swap says what it takes and what it gives, each at its own level', () => {
    test('a single-slot tier swap writes the level against both pieces', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 10), buildGameData(), 'equipment');

        const tier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        expect(tier.description).toBe('Fine Sword +10 → Regal Sword (R) +10');
    });

    test('and a piece at +0 carries no level at all, rather than "+0"', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 0), buildGameData(), 'equipment');

        const tier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        // Clamped to +10 on the way in, which is what the two sides differing looks like
        expect(tier.description).toBe('Fine Sword → Regal Sword (R) +10');
    });

    test('a two-piece cross-slot swap labels each piece it hands you', () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/great_axe'] = {
            name: 'Great Axe',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { smashDamage: 20 } },
        };
        gameData.itemDetailMap['/items/hand_axe'] = {
            name: 'Hand Axe',
            itemLevel: 60,
            equipmentDetail: { type: '/equipment_types/main_hand', combatStats: { smashDamage: 12 } },
        };
        gameData.itemDetailMap['/items/buckler'] = {
            name: 'Buckler',
            itemLevel: 55,
            equipmentDetail: { type: '/equipment_types/off_hand', combatStats: { armor: 8 } },
        };
        const player = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/great_axe', enhancementLevel: 5 } },
        };

        const cross = generateCandidates(player, gameData, 'equipment').find((c) => c.type === 'cross_slot');

        expect(cross).toBeDefined();
        expect(cross.description).toBe('Great Axe +5 → Hand Axe +5 + Buckler +5');
    });
});

describe('the charm slot is in the equipment candidates', () => {
    const CHARM = '/equipment_types/charm';

    /**
     * A charm carries only `focusTraining` — a skill hrid, not a ranked stat —
     * which is exactly the shape that used to be read as "no combat stats" and
     * skipped, so no charm level or tier ever reached the table.
     */
    function charmGameData() {
        const charm = (name, itemLevel, skill) => ({
            name,
            itemLevel,
            sortIndex: itemLevel,
            equipmentDetail: { type: CHARM, combatStats: { focusTraining: `/skills/${skill}` } },
        });
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/basic_melee_charm': charm('Basic Melee Charm', 10, 'melee'),
                '/items/expert_melee_charm': charm('Expert Melee Charm', 60, 'melee'),
                '/items/grand_melee_charm': charm('Grand Melee Charm', 90, 'melee'),
                '/items/expert_magic_charm': charm('Expert Magic Charm', 60, 'magic'),
            },
        };
    }

    const wearing = (hrid, enhancementLevel = 3) => ({ equipment: { [CHARM]: { hrid, enhancementLevel } } });

    test('the equipped charm gets its next enhancement breakpoint', () => {
        const candidates = generateCandidates(wearing('/items/expert_melee_charm', 3), charmGameData(), 'equipment');

        const enhancement = candidates.find((c) => c.type === 'enhancement');
        expect(enhancement).toBeDefined();
        expect(enhancement.slot).toBe(CHARM);
        expect(enhancement.upgradeHrid).toBe('/items/expert_melee_charm');
        expect(enhancement.upgradeLevel).toBeGreaterThan(3);
    });

    test('and the next charm up, keeping the focus skill it trains', () => {
        const candidates = generateCandidates(wearing('/items/expert_melee_charm'), charmGameData(), 'equipment');

        const tier = candidates.filter((c) => c.type === 'tier' && c.slot === CHARM);
        expect(tier.map((c) => c.upgradeHrid)).toEqual(['/items/grand_melee_charm']);
        // Its enhancement level rides along, like every other tier candidate
        expect(tier[0].upgradeLevel).toBe(3);
        expect(tier[0].description).toContain('Grand Melee Charm');
    });

    test('one step at a time — the top of the family is not offered from the bottom', () => {
        const candidates = generateCandidates(wearing('/items/basic_melee_charm'), charmGameData(), 'equipment');

        const tier = candidates.filter((c) => c.type === 'tier' && c.slot === CHARM);
        expect(tier.map((c) => c.upgradeHrid)).toEqual(['/items/expert_melee_charm']);
    });

    test('the best charm of a family has no tier left to buy', () => {
        const candidates = generateCandidates(wearing('/items/grand_melee_charm'), charmGameData(), 'equipment');

        expect(candidates.filter((c) => c.type === 'tier' && c.slot === CHARM)).toHaveLength(0);
        // The enhancement candidate is still there — the charm can still improve
        expect(candidates.some((c) => c.type === 'enhancement' && c.slot === CHARM)).toBe(true);
    });

    test('changing which skill the charm trains is never offered as an upgrade', () => {
        // That is a decision about what to train, not something to rank on gold
        const candidates = generateCandidates(wearing('/items/expert_melee_charm'), charmGameData(), 'equipment');

        expect(candidates.some((c) => c.upgradeHrid === '/items/expert_magic_charm')).toBe(false);
    });
});

describe('runLabyrinthAllFightsAnalysis', () => {
    test('unions candidates across loadout styles and ranks by run-clear delta', async () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);

        const levels = {
            staminaLevel: 50,
            intelligenceLevel: 50,
            attackLevel: 50,
            meleeLevel: 50,
            defenseLevel: 50,
            rangedLevel: 50,
            magicLevel: 50,
        };
        const meleeDTO = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            ...levels,
        };
        const rangedDTO = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            ...levels,
        };

        // Boosting melee improves the goblin fight only; nothing else moves
        runLabyrinthSimulation.mockImplementation(async ({ playerDTOs, monsterHrid }) => {
            let winRate = monsterHrid === '/monsters/goblin' ? 0.8 : 0.5;
            if (monsterHrid === '/monsters/goblin' && playerDTOs[0].meleeLevel === 55) winRate = 0.9;
            return { labyAttemptCount: 100, encounters: winRate * 100 };
        });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    { monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto: meleeDTO },
                    { monsterHrid: '/monsters/wisp', monsterName: 'Wisp', roomLevel: 110, dto: rangedDTO },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
            },
            null,
            {}
        );

        // Candidate union: melee loadout contributes Melee, ranged loadout
        // contributes Ranged; Magic stays excluded (no loadout trains it)
        expect(result.results.map((r) => r.candidate.skillKey).sort()).toEqual([
            'attackLevel',
            'defenseLevel',
            'intelligenceLevel',
            'meleeLevel',
            'rangedLevel',
            'staminaLevel',
        ]);

        expect(result.baseline.runClearChance).toBeCloseTo(0.8 * 0.5, 5);
        expect(result.baseline.expectedAttempts).toBeCloseTo(1 / 0.8 + 1 / 0.5, 5);

        // Melee gives the only improvement (fewest expected attempts) and ranks first
        expect(result.results[0].candidate.skillKey).toBe('meleeLevel');
        const meleeRow = result.results[0];
        expect(meleeRow.fights[0].winRate).toBeCloseTo(0.9, 5);
        expect(meleeRow.fights[0].winRateDelta).toBeCloseTo(0.1, 5);
        expect(meleeRow.runClearChance).toBeCloseTo(0.9 * 0.5, 5);
        expect(meleeRow.expectedAttempts).toBeCloseTo(1 / 0.9 + 1 / 0.5, 5);
        expect(meleeRow.attemptsDelta).toBeCloseTo(1 / 0.9 - 1 / 0.8, 5);
    });

    test('per-skill target levels flow through to the candidate union', async () => {
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });

        const dto = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            staminaLevel: 50,
            meleeLevel: 50,
        };
        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [{ monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto }],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        // Only the targeted skill produces a candidate, at its target level
        expect(result.results).toHaveLength(1);
        expect(result.results[0].candidate.skillKey).toBe('meleeLevel');
        expect(result.results[0].candidate.upgradeLevel).toBe(60);
    });

    test('a weapon upgrade is only simmed against the loadouts carrying that weapon', async () => {
        // Installing a melee sword into a ranged loadout replaces the bow with a
        // sword: not an upgrade, a costume change, and it comes back as a large
        // negative for a room nobody would ever have applied it to
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            sortIndex: 5,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });

        const meleeDTO = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            meleeLevel: 50,
        };
        const rangedDTO = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            rangedLevel: 50,
        };

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    { monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto: meleeDTO },
                    { monsterHrid: '/monsters/wisp', monsterName: 'Wisp', roomLevel: 110, dto: rangedDTO },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
                modes: ['equipment'],
            },
            null,
            {}
        );

        const sword = result.results.find((r) => r.candidate.currentHrid === '/items/fine_sword');
        expect(sword.appliedFights).toBe(1);
        expect(sword.fights[0].applied).toBe(true);
        expect(sword.fights[1]).toMatchObject({ applied: false, winRateDelta: 0 });
    });

    test('and the room it does not reach keeps its baseline exactly', async () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            sortIndex: 5,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);
        // The ranged room would come back at a different rate if it were simmed
        // with a sword in hand; it must not be simmed at all
        // The wisp room reads completely differently with a sword in hand — so
        // if it were simmed with one, the baseline comparison would say so
        runLabyrinthSimulation.mockImplementation(async ({ monsterHrid, playerDTOs }) => {
            if (monsterHrid !== '/monsters/wisp') return { labyAttemptCount: 100, encounters: 50 };
            const armed = Boolean(playerDTOs[0].equipment?.[MAIN_HAND]);
            return { labyAttemptCount: 100, encounters: armed ? 90 : 20 };
        });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } } },
                    },
                    {
                        monsterHrid: '/monsters/wisp',
                        monsterName: 'Wisp',
                        roomLevel: 110,
                        // A two-hander: a main-hand sword cannot go in beside it
                        dto: {
                            equipment: {
                                '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 },
                                [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 0 },
                            },
                        },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            null,
            {}
        );

        const sword = result.results.find(
            (r) => r.candidate.slot === MAIN_HAND && r.candidate.currentHrid === '/items/fine_sword'
        );
        expect(sword.fights[1].winRate).toBe(result.baseline.fights[1].winRate);
    });

    test('each result carries the error behind its own number', async () => {
        // Without it a lucky run on one 30% room reads as an upgrade worth
        // billions, and nothing in the table says otherwise
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 200, encounters: 100 });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { staminaLevel: 50, meleeLevel: 50 },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        const row = result.results[0];
        expect(row.attemptsDeltaNoise).toBeGreaterThan(0);
        // Identical sims mean a delta of exactly zero, which is the clearest
        // case of "not measured" there is
        expect(row.significant).toBe(false);
    });

    test('fights run several at a time rather than one after another', async () => {
        // Each fight is its own worker with its own seed, so running them in
        // series left the rest of the machine idle for the length of the run
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        let running = 0;
        let peak = 0;
        runLabyrinthSimulation.mockImplementation(async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 0));
            running--;
            return { labyAttemptCount: 100, encounters: 50 };
        });

        const fights = [0, 1, 2, 3].map((i) => ({
            monsterHrid: `/monsters/m${i}`,
            monsterName: `M${i}`,
            roomLevel: 100,
            dto: { staminaLevel: 50, meleeLevel: 50 },
        }));

        await runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        expect(peak).toBeGreaterThan(1);
    });

    test('the progress total counts the sims it will actually run', async () => {
        // A total that assumed every candidate against every fight would leave
        // the bar stuck short of the end, which reads as a run that hung
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        runLabyrinthSimulation.mockClear();
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });
        const seen = [];

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } } },
                    },
                    {
                        monsterHrid: '/monsters/wisp',
                        monsterName: 'Wisp',
                        roomLevel: 110,
                        dto: { equipment: { [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 0 } } },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            (progress) => seen.push(progress),
            {}
        );
        const candidateCount = result.results.length;

        const { total } = seen[seen.length - 1];
        const everyCandidateEverywhere = 2 * (candidateCount + 1);
        expect(runLabyrinthSimulation.mock.calls.length).toBe(total);
        expect(total).toBeLessThan(everyCandidateEverywhere);
    });
});

/**
 * The two candidate sets that used to be single-fight only.
 *
 * Ability Swaps were refused outright for a multi-fight scope on size, and the
 * forced labyrinth armor sets — the Anchorbound plate, the elemental robes, and
 * the combined weapon-and-robes swaps that read as one row — were simply never
 * generated for one, so the scope that is about the whole run was missing the
 * upgrades the whole run turns on. Both are here now, and the tests are about
 * what "here" has to mean: measured only where they belong, aggregated the way
 * every other row is, priced the way the single-fight table prices them.
 */
describe('swaps and forced armor sets across a whole labyrinth', () => {
    const BODY = '/equipment_types/body';
    const LEGS = '/equipment_types/legs';
    const TWO_HAND = '/equipment_types/two_hand';

    /** Ability entries with no effects read as universal, so any weapon may cast them */
    function withAbilities(data, hrids) {
        data.abilityDetailMap = Object.fromEntries(
            hrids.map((hrid) => [hrid, { name: hrid.split('/').pop().replace(/_/g, ' ') }])
        );
        return data;
    }

    /** A melee loadout casting `hrid` at `level` from its second ability slot */
    function caster(hrid, level) {
        return {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            abilities: [null, { hrid, level }],
            meleeLevel: 50,
        };
    }

    const fight = (name, dto) => ({
        monsterHrid: `/monsters/${name}`,
        monsterName: name,
        roomLevel: 100,
        loadoutName: name,
        dto,
    });

    beforeEach(() => {
        runLabyrinthSimulation.mockReset();
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });
    });

    test('a swap is weighed only in the loadouts that cast the ability it replaces', async () => {
        // The prefilter that makes the run finite, and the reason it is also the
        // more honest answer: "Smack → Cleave" measured against a loadout that
        // has never slotted Smack is a different change from the one the row
        // names, and the row would carry the average of the two
        buildGameDataPayload.mockReturnValue(
            withAbilities(buildGameData(), ['/abilities/smack', '/abilities/cleave', '/abilities/quick_shot'])
        );

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    fight('goblin', caster('/abilities/smack', 30)),
                    fight('wisp', caster('/abilities/cleave', 12)),
                ],
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['ability_swap'],
            },
            null,
            {}
        );

        const byDescription = new Map(result.results.map((r) => [r.candidate.description, r]));
        // The slot number and the level it was generated at are gone from the
        // row: one decision, one row, whichever slot each loadout keeps it in
        expect([...byDescription.keys()].sort()).toEqual([
            'cleave → quick shot',
            'cleave → smack',
            'smack → cleave',
            'smack → quick shot',
        ]);

        const smackRow = byDescription.get('smack → quick shot');
        expect(smackRow.appliedFights).toBe(1);
        expect(smackRow.fights[0]).toMatchObject({ monsterName: 'goblin', applied: true });
        expect(smackRow.fights[1]).toMatchObject({ monsterName: 'wisp', applied: false, winRateDelta: 0 });

        const cleaveRow = byDescription.get('cleave → smack');
        expect(cleaveRow.fights.map((f) => f.applied)).toEqual([false, true]);
    });

    test('and lands at the level that loadout holds the replaced ability at', async () => {
        // The swap rule is that the newcomer is tried at the level of the one it
        // displaces — which is a different level in every room, so the level the
        // candidate was generated with cannot be the one it is simmed at
        buildGameDataPayload.mockReturnValue(
            withAbilities(buildGameData(), ['/abilities/smack', '/abilities/quick_shot'])
        );

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    fight('goblin', caster('/abilities/smack', 30)),
                    fight('wisp', caster('/abilities/smack', 12)),
                ],
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['ability_swap'],
            },
            null,
            {}
        );

        const row = result.results.find((r) => r.candidate.description === 'smack → quick shot');
        expect(row.appliedFights).toBe(2);
        // Books are bought once, to the highest of the levels it has to serve
        expect(row.candidate.upgradeLevel).toBe(30);
        expect(row.candidate.caveat).toMatch(/level that loadout holds it at/);

        const swapped = runLabyrinthSimulation.mock.calls
            .map(([call]) => ({ monster: call.monsterHrid, ability: call.playerDTOs[0].abilities[1] }))
            .filter((call) => call.ability?.hrid === '/abilities/quick_shot');
        expect(swapped).toEqual([
            { monster: '/monsters/goblin', ability: { hrid: '/abilities/quick_shot', level: 30, triggers: null } },
            { monster: '/monsters/wisp', ability: { hrid: '/abilities/quick_shot', level: 12, triggers: null } },
        ]);
    });

    /**
     * A labyrinth's worth of gear: the Anchorbound plate every loadout can wear,
     * two elemental robe sets, and a trident in each of their elements.
     */
    function labyrinthGear() {
        const data = withAbilities(buildGameData(), ['/abilities/fireball']);
        data.abilityDetailMap['/abilities/fireball'] = {
            name: 'Fireball',
            abilityEffects: [{ damageType: '/damage_types/fire' }],
        };
        const piece = (name, type, combatStats) => ({ name, itemLevel: 95, equipmentDetail: { type, combatStats } });
        Object.assign(data.itemDetailMap, {
            '/items/anchorbound_plate_body': piece('Anchorbound Plate Body', BODY, { armor: 50 }),
            '/items/anchorbound_plate_legs': piece('Anchorbound Plate Legs', LEGS, { armor: 40 }),
            '/items/royal_nature_robe_top': piece('Royal Nature Robe Top', BODY, { natureAmplify: 0.1 }),
            '/items/royal_nature_robe_bottoms': piece('Royal Nature Robe Bottoms', LEGS, { natureAmplify: 0.08 }),
            '/items/royal_fire_robe_top': piece('Royal Fire Robe Top', BODY, { fireAmplify: 0.1 }),
            '/items/royal_fire_robe_bottoms': piece('Royal Fire Robe Bottoms', LEGS, { fireAmplify: 0.08 }),
            '/items/blooming_trident': piece('Blooming Trident', TWO_HAND, {
                magicDamage: 20,
                damageType: '/damage_types/nature',
            }),
            '/items/blazing_trident': piece('Blazing Trident', TWO_HAND, {
                magicDamage: 20,
                damageType: '/damage_types/fire',
            }),
        });
        return data;
    }

    /** The nature-trident, fire-spell loadout the combined swap exists for */
    function tridentLoadout() {
        return {
            equipment: {
                [TWO_HAND]: { hrid: '/items/blooming_trident', enhancementLevel: 7 },
                [BODY]: { hrid: '/items/royal_nature_robe_top', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/royal_nature_robe_bottoms', enhancementLevel: 7 },
            },
            abilities: [null, { hrid: '/abilities/fireball', level: 20 }],
            magicLevel: 50,
        };
    }

    test('the combined weapon-and-robes swap is offered across several fights, as one row', async () => {
        // The row the whole feature is about: "Blooming Trident + Royal Nature
        // Robe Top + Bottoms → Blazing Trident + Royal Fire Robe Top + Bottoms".
        // The tier progression cannot reach it — it is three slots at once, and
        // sideways in two of them — so it is forced in, and it was being forced
        // in for one fight only.
        buildGameDataPayload.mockReturnValue(labyrinthGear());

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [fight('mimic', tridentLoadout()), fight('gobo', tridentLoadout())],
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            null,
            {}
        );

        const combined = result.results.find(
            (r) =>
                r.candidate.description.includes('Blazing Trident') &&
                r.candidate.description.includes('Royal Fire Robe Bottoms')
        );
        expect(combined).toBeDefined();
        // Every piece carries its own level on both sides of the arrow, so a
        // multi-slot swap needs no key to say which level belonged to which item
        expect(combined.candidate.description).toBe(
            'Blooming Trident +7 + Royal Nature Robe Top +7 + Royal Nature Robe Bottoms +7 → ' +
                'Blazing Trident +7 + Royal Fire Robe Top +7 + Royal Fire Robe Bottoms +7'
        );
        // Both loadouts wield the trident, so both rooms are measured — and the
        // aggregate columns are the ones every other row uses
        expect(combined.appliedFights).toBe(2);
        expect(combined.fights.every((f) => f.applied)).toBe(true);
        expect(combined.avgWinDelta).toBeDefined();
        expect(combined.expectedAttempts).toBeGreaterThan(0);
        expect(combined.attemptsDeltaNoise).toBeGreaterThan(0);
    });

    test('the resale of what it replaces is still deliberately not credited', async () => {
        buildGameDataPayload.mockReturnValue(labyrinthGear());

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [fight('mimic', tridentLoadout())],
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            null,
            {}
        );

        const combined = result.results.find(
            (r) =>
                r.candidate.description.includes('Blazing Trident') &&
                r.candidate.description.includes('Royal Fire Robe Bottoms')
        );
        // Kept rather than sold: the labyrinth wants every element available, so
        // the price is what leaves the bank, not what nets out
        expect(combined.candidate.removedItems).toEqual([]);
        expect(combined.candidate.keptItems.map((item) => item.hrid)).toEqual([
            '/items/blooming_trident',
            '/items/royal_nature_robe_top',
            '/items/royal_nature_robe_bottoms',
        ]);
        // And the breakdown the panel writes the note from comes back with it
        expect(combined.costDetail.kept.map((k) => k.name)).toContain('Blooming Trident');
        expect(combined.costDetail.keptValue).toBeGreaterThan(0);
    });

    test('a set that comes with a weapon is not installed in a loadout swinging something else', async () => {
        // The elemental weapon variant exists to fix *this* loadout's unused
        // element. Put on a melee loadout it is a costume change, and would drag
        // that room's number into the row's average
        buildGameDataPayload.mockReturnValue(labyrinthGear());

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    fight('mimic', tridentLoadout()),
                    fight('gobo', {
                        equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
                        abilities: [],
                        meleeLevel: 50,
                    }),
                ],
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            null,
            {}
        );

        const combined = result.results.find((r) => r.candidate.description.includes('Blazing Trident'));
        expect(combined.fights.map((f) => f.applied)).toEqual([true, false]);

        // The armour-only set has no such quarrel with the melee loadout: one
        // purchase, worn in both rooms
        const plate = result.results.find(
            (r) =>
                r.candidate.addedSlots?.[BODY]?.hrid === '/items/anchorbound_plate_body' &&
                r.candidate.addedSlots?.[LEGS]?.hrid === '/items/anchorbound_plate_legs'
        );
        expect(plate.appliedFights).toBe(2);
    });
});

describe('what a big whole-run analysis gives up to fit', () => {
    test('a small run is not shortened at all', () => {
        expect(labAllFightsTrialBudget(ALL_FIGHTS_SIM_BUDGET, 10)).toEqual({ scale: 1, hours: 10, reduced: false });
    });

    test('a large one trades trial length, proportionally', () => {
        const budget = labAllFightsTrialBudget(ALL_FIGHTS_SIM_BUDGET * 2, 10);
        expect(budget.reduced).toBe(true);
        expect(budget.scale).toBeCloseTo(0.5, 5);
        expect(budget.hours).toBeCloseTo(5, 5);
    });

    test('but never below the floor, however large the run', () => {
        const budget = labAllFightsTrialBudget(ALL_FIGHTS_SIM_BUDGET * 1000, 10);
        expect(budget.scale).toBe(MIN_TRIAL_FRACTION);
        expect(budget.hours).toBe(10 * MIN_TRIAL_FRACTION);
    });

    test('the run says what it comes to before it starts, and shortens sims rather than dropping fights', async () => {
        // The rule the whole budget hangs on: a row's headline is attempts to
        // clear *every* fight, so a run that left fights out would be answering
        // a question about some other, smaller labyrinth. Trials are bounded;
        // fights never are.
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockReset();
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });

        const fights = Array.from({ length: 100 }, (_, i) => ({
            monsterHrid: `/monsters/m${i}`,
            monsterName: `M${i}`,
            roomLevel: 100,
            dto: { staminaLevel: 50, meleeLevel: 50, equipment: {}, abilities: [] },
        }));
        const seen = [];

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 10,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
                modes: ['combat_level'],
            },
            (progress) => seen.push(progress),
            {}
        );

        // Reported once, before a single simulation, while Stop still costs nothing
        const plan = seen[0].plan;
        expect(plan).toMatchObject({ fights: 100, reduced: true });
        expect(plan.sims).toBeGreaterThan(ALL_FIGHTS_SIM_BUDGET);
        expect(plan.requestedHours).toBe(10);
        expect(plan.hours).toBeLessThan(10);
        expect(result.budget).toMatchObject({ sims: plan.sims, reduced: true, requestedHours: 10 });

        // Every fight still simulated — the baseline pass alone covers all 100
        const simmed = new Set(runLabyrinthSimulation.mock.calls.map(([call]) => call.monsterHrid));
        expect(simmed.size).toBe(100);
        // And what gave instead is the time each one was allowed
        const hours = new Set(runLabyrinthSimulation.mock.calls.map(([call]) => call.hours));
        expect(Math.min(...hours)).toBeCloseTo(10 * plan.trialScale, 5);
        expect(Math.max(...hours)).toBeLessThanOrEqual(10 * plan.trialScale * 3);
    });
});

describe('whether an upgrade is about this loadout at all', () => {
    const swordDTO = {
        equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 3 } },
        abilities: [{ hrid: '/abilities/fierce_aura', level: 10 }, { hrid: '/abilities/smack', level: 20 }, null],
    };

    test('a combat level is every fight, because levels are not worn', () => {
        expect(candidateAppliesToDTO({ type: 'combat_level', skillKey: 'meleeLevel' }, swordDTO)).toBe(true);
    });

    test('a tier upgrade where the piece it replaces is worn', () => {
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
    });

    test('and anywhere else the same purchase would be an upgrade too', () => {
        // One purchase serves every loadout. Matching only the exact item it was
        // generated against credited it for one room and charged full price
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const otherSword = { equipment: { [MAIN_HAND]: { hrid: '/items/plain_sword', enhancementLevel: 0 } } };
        const gameData = {
            itemDetailMap: {
                '/items/regal_sword_refined': {
                    itemLevel: 60,
                    equipmentDetail: { combatStats: { slashDamage: 15 } },
                },
                '/items/plain_sword': { itemLevel: 40, equipmentDetail: { combatStats: { slashDamage: 5 } } },
                '/items/master_sword': { itemLevel: 80, equipmentDetail: { combatStats: { slashDamage: 25 } } },
                '/items/fine_staff': { itemLevel: 40, equipmentDetail: { combatStats: { magicDamage: 9 } } },
            },
        };

        expect(candidateAppliesToDTO(candidate, otherSword, gameData)).toBe(true);
    });

    test('but never a step down, nor into a loadout that fights another way', () => {
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const gameData = {
            itemDetailMap: {
                '/items/regal_sword_refined': {
                    itemLevel: 60,
                    equipmentDetail: { combatStats: { slashDamage: 15 } },
                },
                '/items/master_sword': { itemLevel: 80, equipmentDetail: { combatStats: { slashDamage: 25 } } },
                '/items/fine_staff': { itemLevel: 40, equipmentDetail: { combatStats: { magicDamage: 9 } } },
            },
        };
        const better = { equipment: { [MAIN_HAND]: { hrid: '/items/master_sword', enhancementLevel: 0 } } };
        const caster = { equipment: { [MAIN_HAND]: { hrid: '/items/fine_staff', enhancementLevel: 0 } } };

        expect(candidateAppliesToDTO(candidate, better, gameData)).toBe(false);
        expect(candidateAppliesToDTO(candidate, caster, gameData)).toBe(false);
    });

    test('and not into a hand that a two-hander is already using', () => {
        // A sword installed beside a bow is a kit the game would never wear;
        // trading between them is what the cross-slot candidates are for
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const archer = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
        };

        expect(candidateAppliesToDTO(candidate, archer, {})).toBe(false);
    });

    test('an enhancement not once the piece is already at that level', () => {
        const candidate = {
            type: 'enhancement',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/fine_sword',
            upgradeLevel: 3,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(false);
        expect(candidateAppliesToDTO({ ...candidate, upgradeLevel: 7 }, swordDTO)).toBe(true);
    });

    test('filling a bare slot only where the slot is bare', () => {
        const candidate = { type: 'tier', slot: BACK, currentHrid: '', upgradeHrid: '/items/plain_cape' };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(candidate, { equipment: { [BACK]: { hrid: '/items/plain_cape' } } })).toBe(false);
    });

    test('an ability level only where the loadout casts it', () => {
        const candidate = {
            type: 'ability_level',
            slot: 'ability_1',
            upgradeHrid: '/abilities/smack',
            upgradeLevel: 30,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO({ ...candidate, upgradeHrid: '/abilities/fireball' }, swordDTO)).toBe(false);
    });

    test('but an ability swap brings its own, so it applies anywhere it is not already up', () => {
        const swap = {
            type: 'ability_swap',
            slot: 'ability_0',
            upgradeHrid: '/abilities/critical_aura',
            upgradeLevel: 20,
        };

        expect(candidateAppliesToDTO(swap, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(swap, { abilities: [{ hrid: '/abilities/critical_aura', level: 20 }] })).toBe(
            false
        );
    });

    test('a cross-slot swap needs every piece it would remove', () => {
        const candidate = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/fine_bow' } },
            clearedSlots: [MAIN_HAND],
            removedItems: [{ hrid: '/items/fine_sword' }],
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(candidate, { equipment: {} })).toBe(false);
    });

    test('nothing to apply it to is not an application', () => {
        expect(candidateAppliesToDTO({ type: 'tier', slot: MAIN_HAND }, null)).toBe(false);
        expect(candidateAppliesToDTO(null, swordDTO)).toBe(false);
    });
});

describe('generateSkillingEquipmentCandidates targetSkill filtering', () => {
    beforeEach(() => {
        // Every candidate is now priced *and* explained on generation, so both
        // price lookups have to answer rather than leaking from another describe
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 5_000_000, bid: 4_000_000 });
    });

    function skillingGameData() {
        return {
            itemDetailMap: {
                '/items/spatula': {
                    name: 'Spatula',
                    itemLevel: 50,
                    equipmentDetail: { type: '/equipment_types/tool', noncombatStats: { cookingSpeed: 0.1 } },
                },
                '/items/wisdom_necklace': {
                    name: 'Wisdom Necklace',
                    itemLevel: 50,
                    equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingSpeed: 0.05 } },
                },
            },
        };
    }

    test('restricts candidates to the target skill loadout when set', () => {
        const editorDTO = {
            equipment: { '/equipment_types/tool': { hrid: '/items/spatula', enhancementLevel: 0 } },
        };
        const map = {
            '/skills/alchemy': {
                '/equipment_types/neck': { hrid: '/items/wisdom_necklace', enhancementLevel: 0 },
            },
        };

        const all = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), map);
        const enhancements = all.filter((c) => c.type === 'enhancement');
        expect(enhancements.map((c) => c.currentHrid).sort()).toEqual(['/items/spatula', '/items/wisdom_necklace']);

        // The necklace is generic skilling gear, so every skill not already
        // wearing it is offered one — and each offer names the skill it is for
        const offers = all.filter((c) => c.type === 'skilling_gear');
        expect(offers.length).toBeGreaterThan(0);
        expect(offers.every((c) => c.skillKey)).toBe(true);
        expect(offers.some((c) => c.skillKey === '/skills/alchemy')).toBe(false);

        const alchemyOnly = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), map, '/skills/alchemy');
        expect(alchemyOnly.map((c) => c.currentHrid)).toEqual(['/items/wisdom_necklace']);
    });

    test('every candidate carries the breakdown its row can be expanded into', () => {
        // Without it the Skilling tab had a Cost column and no way to ask what
        // the number was made of — the one place a dash reads as free
        const editorDTO = {
            equipment: { '/equipment_types/tool': { hrid: '/items/spatula', enhancementLevel: 0 } },
        };

        const all = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), {});

        expect(all.length).toBeGreaterThan(0);
        expect(all.every((c) => c.costDetail)).toBe(true);
        for (const candidate of all) {
            expect(Array.isArray(candidate.costDetail.buys)).toBe(true);
            expect(Array.isArray(candidate.costDetail.unpriced)).toBe(true);
        }
    });

    test('a skilling piece replacing combat gear records what it keeps, so the row can say why it costs so much', () => {
        const gameData = skillingGameData();
        gameData.itemDetailMap['/items/plate_body'] = {
            name: 'Plate Body',
            itemLevel: 80,
            equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 20 }, noncombatStats: {} },
        };
        gameData.itemDetailMap['/items/lumberjack_top'] = {
            name: "Lumberjack's Top",
            itemLevel: 80,
            equipmentDetail: { type: '/equipment_types/body', noncombatStats: { woodcuttingSpeed: 0.2 } },
        };
        const editorDTO = {
            equipment: { '/equipment_types/body': { hrid: '/items/plate_body', enhancementLevel: 3 } },
        };

        const all = generateSkillingEquipmentCandidates(editorDTO, gameData, {}, '/skills/woodcutting');
        const swap = all.find((c) => c.upgradeHrid === '/items/lumberjack_top');

        expect(swap).toBeDefined();
        expect(swap.costDetail.kept?.map((k) => k.name)).toEqual(['Plate Body']);
        // The resale it deliberately does not credit, which is the whole
        // explanation for a cost that looks too high
        expect(swap.costDetail.keptValue).toBeGreaterThanOrEqual(0);
    });

    test('philo-accessory dedup keys on enhancement level, so two loadouts wearing the same ring at different levels each get their own candidate', () => {
        // Regression: the philo dedup key used to omit currentLevel, so the
        // second loadout's candidate (same slot/upgrade/current hrid, different
        // level) was silently dropped as "already seen" — and since
        // applyToEquipment matches on the exact (hrid, enhancementLevel) pair,
        // that loadout's Philosopher's-ring upgrade never got offered at all.
        const gameData = skillingGameData();
        gameData.itemDetailMap['/items/ring_of_speed'] = {
            name: 'Ring of Speed',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/ring', noncombatStats: {} },
        };
        gameData.itemDetailMap['/items/philosophers_ring'] = {
            name: "Philosopher's Ring",
            itemLevel: 1,
            equipmentDetail: { type: '/equipment_types/ring', noncombatStats: { skillingSpeed: 0.02 } },
        };

        const editorDTO = {
            equipment: { '/equipment_types/ring': { hrid: '/items/ring_of_speed', enhancementLevel: 10 } },
        };
        const map = {
            '/skills/alchemy': {
                '/equipment_types/ring': { hrid: '/items/ring_of_speed', enhancementLevel: 5 },
            },
        };

        const all = generateSkillingEquipmentCandidates(editorDTO, gameData, map);
        // type 'tier' is specific to addPhiloAccessoryCandidates — the generic
        // "gear you aren't wearing" generator can also offer this same item as
        // a 'skilling_gear' candidate for unrelated skills, which isn't what
        // this regression is about
        const philoCandidates = all.filter((c) => c.type === 'tier' && c.upgradeHrid === '/items/philosophers_ring');

        expect(philoCandidates.map((c) => c.currentLevel).sort((a, b) => a - b)).toEqual([5, 10]);
    });
});

describe("Philosopher's accessories are offered wherever the slot is worn", () => {
    const NECK = '/equipment_types/neck';
    const neckGameData = () => ({
        actionDetailMap: {},
        itemDetailMap: {
            '/items/necklace_of_speed': {
                name: 'Necklace Of Speed',
                itemLevel: 75,
                equipmentDetail: { type: NECK, combatStats: { attackSpeed: 0.03, castSpeed: 0.03 } },
            },
            '/items/philosophers_necklace': {
                name: "Philosopher's Necklace",
                itemLevel: 90,
                equipmentDetail: {
                    type: NECK,
                    // The real shape: every style's damage and accuracy at once
                    combatStats: {
                        attackSpeed: 0.03,
                        castSpeed: 0.03,
                        slashDamage: 0.04,
                        stabDamage: 0.04,
                        smashDamage: 0.04,
                        rangedDamage: 0.04,
                        magicDamage: 0.04,
                        slashAccuracy: 0.04,
                        stabAccuracy: 0.04,
                        smashAccuracy: 0.04,
                        rangedAccuracy: 0.04,
                        magicAccuracy: 0.04,
                        defensiveDamage: 0.04,
                    },
                },
            },
        },
    });

    test('the necklace swap applies to a loadout wearing a styleless speed necklace', () => {
        // Regression: the all-style Philosopher's Necklace tie-broke to
        // 'melee_stab' while the speed necklace read 'defensive', and the
        // role-substitution filter refused the swap in every loadout — the row
        // vanished from the all-fights table while the ring and earrings
        // (both sides styleless) sailed through.
        const dto = {
            equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 5 } },
            abilities: [],
        };
        const gameData = neckGameData();
        const candidates = generateCandidates(dto, gameData, 'equipment');
        const philo = candidates.find((c) => c.upgradeHrid === '/items/philosophers_necklace');

        expect(philo).toBeTruthy();
        expect(candidateAppliesToDTO(philo, dto, gameData)).toBe(true);
    });

    test('already wearing it that high is the one refusal; lower is still an upgrade', () => {
        const gameData = neckGameData();
        const candidate = {
            slot: NECK,
            currentHrid: '/items/necklace_of_speed',
            currentLevel: 5,
            upgradeHrid: '/items/philosophers_necklace',
            upgradeLevel: 5,
            type: 'tier',
        };
        const wearingHigh = {
            equipment: { [NECK]: { hrid: '/items/philosophers_necklace', enhancementLevel: 5 } },
        };
        const wearingLow = {
            equipment: { [NECK]: { hrid: '/items/philosophers_necklace', enhancementLevel: 3 } },
        };
        expect(candidateAppliesToDTO(candidate, wearingHigh, gameData)).toBe(false);
        expect(candidateAppliesToDTO(candidate, wearingLow, gameData)).toBe(true);
    });
});

describe('the off-hand a two-hander is traded for', () => {
    const TWO_HAND = '/equipment_types/two_hand';
    const MAIN = '/equipment_types/main_hand';
    const OFF = '/equipment_types/off_hand';

    function weaponGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/cursed_bow': {
                    name: 'Cursed Bow',
                    itemLevel: 80,
                    equipmentDetail: { type: TWO_HAND, combatStats: { rangedDamage: 30, rangedAccuracy: 10 } },
                },
                '/items/sundering_crossbow': {
                    name: 'Sundering Crossbow',
                    itemLevel: 90,
                    equipmentDetail: { type: MAIN, combatStats: { rangedDamage: 25, rangedAccuracy: 8 } },
                },
                '/items/manticore_shield': {
                    name: 'Manticore Shield',
                    itemLevel: 70,
                    equipmentDetail: { type: OFF, combatStats: { rangedAccuracy: 5, armor: 2 } },
                },
                '/items/knights_aegis': {
                    name: "Knight's Aegis",
                    itemLevel: 85,
                    equipmentDetail: { type: OFF, combatStats: { slashAccuracy: 9, armor: 12 } },
                },
                '/items/plain_buckler': {
                    name: 'Plain Buckler',
                    itemLevel: 75,
                    equipmentDetail: { type: OFF, combatStats: { armor: 8 } },
                },
            },
        };
    }

    const offHandsOffered = (gameData) => {
        const player = { equipment: { [TWO_HAND]: { hrid: '/items/cursed_bow', enhancementLevel: 10 } } };
        return generateCandidates(player, gameData, 'equipment')
            .filter((c) => c.type === 'cross_slot' && c.addedSlots?.[OFF])
            .map((c) => c.addedSlots[OFF].hrid);
    };

    test('never one built for another style, however high its item level', () => {
        // A shield with melee accuracy paired with a crossbow offers a ranged
        // build a piece whose whole offensive contribution is dead weight
        expect(offHandsOffered(weaponGameData())).not.toContain('/items/knights_aegis');
    });

    test('the one that matches the weapon is offered', () => {
        expect(offHandsOffered(weaponGameData())).toContain('/items/manticore_shield');
    });

    test('and a purely defensive one, which suits anybody', () => {
        expect(offHandsOffered(weaponGameData())).toContain('/items/plain_buckler');
    });

    test('a melee weapon is offered the melee shield, which is what it is for', () => {
        const gameData = weaponGameData();
        gameData.itemDetailMap['/items/cursed_bow'].equipmentDetail.combatStats = {
            slashDamage: 30,
            slashAccuracy: 10,
        };
        gameData.itemDetailMap['/items/sundering_crossbow'].equipmentDetail.combatStats = {
            slashDamage: 25,
            slashAccuracy: 8,
        };

        expect(offHandsOffered(gameData)).toContain('/items/knights_aegis');
    });
});

describe('what a set of upgrades is worth together', () => {
    const MAIN = '/equipment_types/main_hand';

    function comboSetup() {
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        const fights = [
            {
                monsterHrid: '/monsters/goblin',
                monsterName: 'Goblin',
                roomLevel: 100,
                dto: { equipment: { [MAIN]: { hrid: '/items/fine_sword', enhancementLevel: 0 } }, meleeLevel: 50 },
            },
        ];
        return {
            picks: [
                {
                    candidate: {
                        type: 'combat_level',
                        skillKey: 'meleeLevel',
                        slot: 'combat_level|meleeLevel',
                        upgradeLevel: 55,
                        description: 'Melee 50 → 55',
                    },
                    attemptsDelta: -1,
                },
                {
                    candidate: {
                        type: 'tier',
                        slot: MAIN,
                        currentHrid: '/items/fine_sword',
                        upgradeHrid: '/items/regal_sword_refined',
                        upgradeLevel: 10,
                        description: 'Fine Sword → Regal Sword',
                    },
                    attemptsDelta: -1,
                },
            ],
            baseline: {
                fights: [{ monsterHrid: '/monsters/goblin', roomLevel: 100, winRate: 0.5, trials: 100 }],
                expectedAttempts: 2,
            },
            context: { fights, crates: [], hours: 1, communityBuffs: {}, labyrinthCombatBuffs: [] },
            pairing: { seed: 7, rules: [] },
        };
    }

    test('the pair is simulated wearing both at once', async () => {
        const setup = comboSetup();
        runLabyrinthSimulation.mockImplementation(async ({ playerDTOs }) => {
            const dto = playerDTOs[0];
            const both = dto.meleeLevel === 55 && dto.equipment[MAIN].hrid === '/items/regal_sword_refined';
            return { labyAttemptCount: 100, encounters: both ? 80 : 50 };
        });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].winRate).toBeCloseTo(0.8, 5);
        expect(check.fights[0].installed).toHaveLength(2);
    });

    test('and the overlap is what the parts promised but the set did not deliver', async () => {
        // Two upgrades that both rescue the same room each got credited with
        // rescuing it; only one of them can be the reason it is now won
        const setup = comboSetup();
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 66.7 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.summedDelta).toBe(-2);
        expect(check.attemptsDelta).toBeCloseTo(1.5 - 2, 1);
        expect(check.overlap).toBeGreaterThan(0);
    });

    test('an upgrade that does not belong in a loadout is not installed there', async () => {
        const setup = comboSetup();
        setup.context.fights[0].dto.equipment = {
            '/equipment_types/two_hand': { hrid: '/items/grand_cape_refined', enhancementLevel: 0 },
        };
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].installed).toEqual(['Melee 50 → 55']);
    });

    test('two picks for one slot are not both worn — the room gets the better one', async () => {
        // The plan buys a second chestpiece for the rooms the first cannot
        // reach; a room that both fit wears whichever is better *there*, which
        // is exactly what the second one was valued at
        const setup = comboSetup();
        setup.picks = [
            {
                candidate: {
                    type: 'tier',
                    slot: MAIN,
                    currentHrid: '/items/fine_sword',
                    upgradeHrid: '/items/regal_sword_refined',
                    upgradeLevel: 10,
                    description: 'Regal Sword',
                },
                attemptsDelta: -1,
                fights: [{ winRateDelta: 0.02 }],
            },
            {
                candidate: {
                    type: 'tier',
                    slot: MAIN,
                    currentHrid: '/items/fine_sword',
                    upgradeHrid: '/items/grand_cape_refined',
                    upgradeLevel: 10,
                    description: 'Other Sword',
                },
                attemptsDelta: -1,
                fights: [{ winRateDelta: 0.11 }],
            },
        ];
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 60 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].installed).toEqual(['Other Sword']);
    });

    test('nothing to check is an error rather than a confident zero', async () => {
        const setup = comboSetup();

        await expect(runLabyrinthCombinationCheck({ ...setup, picks: [] }, null, {})).rejects.toThrow();
    });
});

describe('how many simulations run at once', () => {
    function combatSetup(hours) {
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        calculateSimRevenue.mockReturnValue({ totalRevenue: 0, itemRevenues: [] });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });
        return {
            playerDTOs: [
                {
                    equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
                    abilities: [],
                    hrid: '/players/me',
                },
            ],
            playerIndex: 0,
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            hours,
            communityBuffs: {},
            upgradeMode: 'equipment',
        };
    }

    function trackPeak() {
        let running = 0;
        const seen = { peak: 0 };
        // Call history accumulates across tests, and this one reads it
        runSimulation.mockClear();
        runSimulation.mockImplementation(async () => {
            running++;
            seen.peak = Math.max(seen.peak, running);
            await new Promise((resolve) => setTimeout(resolve, 0));
            running--;
            return { simulatedTime: 3.6e12, deaths: 0, playerRanOutOfFood: false };
        });
        return seen;
    }

    test('several, when each simulation is only one worker', async () => {
        // A short run does not split itself, so the rest of the machine was idle
        plannedWorkerCount.mockReturnValue(1);
        const seen = trackPeak();

        await runUpgradeAnalysis(combatSetup(4), null, {});

        expect(seen.peak).toBeGreaterThan(1);
    });

    test('several at long hours too, one worker each rather than one split run', async () => {
        // Splitting a candidate across the workers makes it pay the startup and
        // the game-data clone once per chunk, and it cannot start the next
        // candidate until its own slowest chunk lands. Measured on four workers
        // that is 3.3× slower at 100 hours and never faster at any length.
        plannedWorkerCount.mockReturnValue(4);
        const seen = trackPeak();

        await runUpgradeAnalysis(combatSetup(200), null, {});

        expect(seen.peak).toBeGreaterThan(1);
    });

    test('and every sim in the analysis — baseline included — is chunked the same', async () => {
        // The shared seed pairs two runs only while they draw the same streams,
        // and the chunking decides the streams. A baseline split four ways
        // against candidates run unsplit is an independent sample, and every
        // combat-inert candidate wears the same phantom delta against it — a
        // skilling house room "improving" DPS
        plannedWorkerCount.mockReturnValue(4);
        trackPeak();

        await runUpgradeAnalysis(combatSetup(200), null, {});

        expect(runSimulation.mock.calls.length).toBeGreaterThan(1);
        expect(runSimulation.mock.calls.every((call) => call[2]?.workers === 1)).toBe(true);
    });

    test('one simulation failing stops the queue handing out more', async () => {
        // Otherwise the other lanes keep starting runs for an analysis whose
        // result has already been thrown away
        plannedWorkerCount.mockReturnValue(1);
        let started = 0;
        runSimulation.mockClear();
        runSimulation.mockImplementation(async () => {
            started++;
            if (started === 2) throw new Error('worker died');
            await new Promise((resolve) => setTimeout(resolve, 0));
            return { simulatedTime: 3.6e12, deaths: 0, playerRanOutOfFood: false };
        });

        await expect(runUpgradeAnalysis(combatSetup(4), null, {})).rejects.toThrow('worker died');

        // The baseline, the one that failed, and at most the lanes already in
        // flight — not the whole candidate list
        expect(started).toBeLessThanOrEqual(2 + 6);
    });

    test('and a batch never preempts itself', async () => {
        // runSimulation cancels whatever is running when it starts, which is
        // right for a button and fatal for a batch: each candidate would kill
        // the one before it
        plannedWorkerCount.mockReturnValue(1);
        trackPeak();

        await runUpgradeAnalysis(combatSetup(4), null, {});

        const batchCalls = runSimulation.mock.calls.slice(1);
        expect(batchCalls.length).toBeGreaterThan(0);
        expect(batchCalls.every((call) => call[2]?.preempt === false)).toBe(true);
    });
});

describe('how much of a gain is measurement', () => {
    const fight = (winRate, trials, monsterHrid = '/monsters/goblin', roomLevel = 100) => ({
        monsterHrid,
        roomLevel,
        winRate,
        trials,
    });

    test('a bigger sample is a smaller error', () => {
        const few = attemptsNoise([fight(0.5, 100)], [fight(0.5, 100)]);
        const many = attemptsNoise([fight(0.5, 10_000)], [fight(0.5, 10_000)]);

        expect(many).toBeLessThan(few / 5);
    });

    test('a low win rate is far noisier, because 1/p magnifies it', () => {
        // The tries figure at 5% moves twenty times as far per point of win
        // rate as it does at 50% — which is exactly where a lucky run reads as
        // an upgrade worth billions
        const middling = attemptsNoise([fight(0.5, 1000)], [fight(0.5, 1000)]);
        const desperate = attemptsNoise([fight(0.05, 1000)], [fight(0.05, 1000)]);

        expect(desperate).toBeGreaterThan(middling * 10);
    });

    test('every room the upgrade touches adds its own', () => {
        const one = attemptsNoise([fight(0.5, 1000)], [fight(0.5, 1000)]);
        const four = attemptsNoise(
            [fight(0.5, 1000, '/monsters/a'), fight(0.5, 1000, '/monsters/b')],
            [fight(0.5, 1000, '/monsters/a'), fight(0.5, 1000, '/monsters/b')]
        );

        expect(four).toBeCloseTo(one * Math.SQRT2, 5);
    });

    test('rooms it does not touch add none', () => {
        // They are not simulated — the number is copied from the baseline, so
        // it carries no error of its own into the comparison
        expect(attemptsNoise([], [fight(0.5, 1000)])).toBe(0);
    });

    test('a certain win is not an infinite error', () => {
        expect(Number.isFinite(attemptsNoise([fight(1, 1000)], [fight(1, 1000)]))).toBe(true);
        expect(Number.isFinite(attemptsNoise([fight(0, 1000)], [fight(0, 1000)]))).toBe(true);
    });
});

describe('what cannot be bought together', () => {
    const SMACK = '/abilities/smack';
    const POKE = '/abilities/poke';
    const FIREBALL = '/abilities/fireball';
    /** Whether the planner would refuse to buy both */
    const sharesConflict = (a, b) => conflictKeys(a).some((key) => conflictKeys(b).includes(key));

    test('two upgrades to one slot are alternatives', () => {
        const boots = (hrid) => ({ type: 'tier', slot: '/equipment_types/feet', upgradeHrid: hrid });

        expect(conflictKey(boots('/items/a'))).toBe(conflictKey(boots('/items/b')));
    });

    test('different slots are not', () => {
        expect(conflictKey({ type: 'tier', slot: '/equipment_types/feet' })).not.toBe(
            conflictKey({ type: 'tier', slot: '/equipment_types/head' })
        );
    });

    test('a two-hander competes with a main hand, whatever the slot names say', () => {
        const twoHand = { type: 'tier', slot: '/equipment_types/two_hand' };
        const mainHand = { type: 'tier', slot: '/equipment_types/main_hand' };
        const swap = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/main_hand': {} },
            clearedSlots: ['/equipment_types/two_hand'],
        };

        expect(conflictKey(twoHand)).toBe(conflictKey(mainHand));
        expect(conflictKey(swap)).toBe(conflictKey(twoHand));
    });

    test('two targets for one ability are one purchase, not two', () => {
        const level = (upgradeLevel) => ({
            type: 'ability_level',
            slot: 'ability_1',
            upgradeHrid: '/abilities/fireball',
            upgradeLevel,
        });

        expect(conflictKey(level(50))).toBe(conflictKey(level(60)));
    });

    test('nor are two levels of one combat skill', () => {
        expect(conflictKey({ type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel: 105 })).toBe(
            conflictKey({ type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel: 110 })
        );
    });

    test('a swap conflicts at both ends: the book it buys and the ability it displaces', () => {
        const swap = { type: 'ability_swap', slot: 'ability_1', replacesHrid: SMACK, upgradeHrid: FIREBALL };

        expect(conflictKeys(swap)).toEqual(expect.arrayContaining([`ability:${SMACK}`, `ability:${FIREBALL}`]));
    });

    test('two swaps into one equipped ability share a key', () => {
        const into = (newcomer) => ({
            type: 'ability_swap',
            slot: 'ability_1',
            replacesHrid: SMACK,
            upgradeHrid: newcomer,
        });

        expect(sharesConflict(into(FIREBALL), into(POKE))).toBe(true);
    });

    test('so do two offers of one newcomer', () => {
        const from = (outgoing, slot) => ({
            type: 'ability_swap',
            slot,
            replacesHrid: outgoing,
            upgradeHrid: FIREBALL,
        });

        expect(sharesConflict(from(SMACK, 'ability_1'), from(POKE, 'ability_2'))).toBe(true);
    });

    test('a free-slot fill has only the one end, and still collides with a swap for the same book', () => {
        const fill = { type: 'ability_swap', slot: 'ability_2', fillsFreeSlot: true, upgradeHrid: FIREBALL };
        const swap = { type: 'ability_swap', slot: 'ability_1', replacesHrid: SMACK, upgradeHrid: FIREBALL };

        expect(conflictKeys(fill)).toEqual([`ability:${FIREBALL}`]);
        expect(sharesConflict(fill, swap)).toBe(true);
    });

    test('levelling an ability collides with swapping it away', () => {
        const level = { type: 'ability_level', slot: 'ability_1', upgradeHrid: SMACK, upgradeLevel: 60 };
        const swap = { type: 'ability_swap', slot: 'ability_1', replacesHrid: SMACK, upgradeHrid: FIREBALL };

        expect(sharesConflict(level, swap)).toBe(true);
    });

    test('unrelated swaps share nothing', () => {
        const a = { type: 'ability_swap', slot: 'ability_1', replacesHrid: SMACK, upgradeHrid: FIREBALL };
        const b = { type: 'ability_swap', slot: 'ability_2', replacesHrid: POKE, upgradeHrid: '/abilities/entangle' };

        expect(sharesConflict(a, b)).toBe(false);
    });
});

describe('the value figure a row is ranked on', () => {
    test('a plain purchase is attempts saved per million', () => {
        expect(valuePerMillion(2_000_000, 4)).toBe(2);
    });

    test('a swap whose resale beats its purchase is the best value there is', () => {
        // Selling a Cursed Bow +7 funded a Sundering Crossbow +7 with 17.7M
        // left over; `cost > 0` read that as "no coin price" and the table's
        // best row lost its Cost and Per-1M cells and its place in the ranking
        expect(valuePerMillion(-17_700_000, 2.5)).toBe(Infinity);
        expect(valuePerMillion(0, 2.5)).toBe(Infinity);
    });

    test('costing nothing does not rank a row that does not help', () => {
        expect(valuePerMillion(-17_700_000, 0)).toBeNull();
        expect(valuePerMillion(-17_700_000, -1)).toBeNull();
    });

    test('a row with no coin price at all has no value figure', () => {
        expect(valuePerMillion(null, 5)).toBeNull();
        expect(valuePerMillion(undefined, 5)).toBeNull();
    });
});

describe('what a budget buys', () => {
    const pick = (over = {}) => ({
        candidate: { type: 'tier', slot: over.slot || '/equipment_types/feet', upgradeHrid: over.hrid || '/items/x' },
        cost: over.cost ?? 100,
        attemptsDelta: over.attemptsDelta ?? -1,
        attemptsSavedPerMillion: over.per ?? 10,
        significant: over.significant ?? true,
    });

    // Three rooms, all at a 50% win rate, so each is two expected attempts
    const BASELINE = [0, 1, 2].map((i) => ({ monsterHrid: `/monsters/m${i}`, roomLevel: 100, winRate: 0.5 }));
    /** A candidate that lifts the named rooms to `winRate` and misses the rest */
    const covering = (rooms, over = {}) => ({
        ...pick(over),
        fights: BASELINE.map((fight, i) =>
            rooms.includes(i) ? { ...fight, winRate: over.winRate ?? 1, applied: true } : { ...fight, applied: false }
        ),
        attemptsDelta: -1,
    });
    const planFor = (results, budget) => planWithinBudget(results, budget, { baselineFights: BASELINE });

    test('best value first, until the money runs out', () => {
        const plan = planWithinBudget(
            [
                pick({ cost: 100, attemptsDelta: -0.5, slot: '/equipment_types/head' }),
                pick({ cost: 100, attemptsDelta: -2, slot: '/equipment_types/feet' }),
            ],
            100
        );

        expect(plan.picks).toHaveLength(1);
        expect(plan.picks[0].candidate.slot).toBe('/equipment_types/feet');
        expect(plan.skipped.some((s) => s.reason === 'over budget')).toBe(true);
    });

    test('two pieces for one slot, when they serve different rooms', () => {
        // One chestpiece for the melee loadouts and one for the casters is two
        // purchases doing two jobs, not a mistake
        const plan = planFor([covering([0], { hrid: '/items/a' }), covering([1, 2], { hrid: '/items/b' })], 1000);

        expect(plan.picks).toHaveLength(2);
        expect(plan.picks.map((p) => p.rooms).sort()).toEqual([1, 2]);
    });

    test('but not a second piece for the rooms the first already covers', () => {
        const plan = planFor(
            [covering([0, 1, 2], { hrid: '/items/a', cost: 10 }), covering([0, 1], { hrid: '/items/b', cost: 10 })],
            1000
        );

        expect(plan.picks).toHaveLength(1);
        expect(plan.skipped.some((s) => s.reason.includes('already cover'))).toBe(true);
    });

    test('a second piece is valued only at what it adds', () => {
        // The cheap piece is the best thing room 0 can wear; the broad one is
        // better than nothing in room 1 and worse than the first in room 0, so
        // only room 1 is its to claim
        const plan = planFor(
            [
                covering([0], { hrid: '/items/sharp', cost: 5, winRate: 1 }),
                covering([0, 1], { hrid: '/items/broad', cost: 20, winRate: 0.75 }),
            ],
            1000
        );

        expect(plan.picks.map((p) => p.candidate.upgradeHrid)).toEqual(['/items/sharp', '/items/broad']);
        // 2 tries at 50% down to 1.333 at 75% — and only in room 1
        expect(plan.picks[1].marginalAttemptsSaved).toBeCloseTo(2 - 1 / 0.75, 3);
    });

    test('and a piece nobody would wear any more is taken back out', () => {
        // Bought early because it was cheap, then beaten everywhere it applied:
        // leaving it in the plan spends gold on a piece that never gets worn
        const plan = planFor(
            [
                covering([0], { hrid: '/items/cheap', cost: 1, winRate: 0.6 }),
                covering([0, 1, 2], { hrid: '/items/better', cost: 20, winRate: 1 }),
            ],
            1000
        );

        expect(plan.picks.map((p) => p.candidate.upgradeHrid)).toEqual(['/items/better']);
        expect(plan.totalCost).toBe(20);
        expect(plan.skipped.some((s) => s.reason.includes('covers every room'))).toBe(true);
    });

    test('a skill level is still one purchase, however many rooms it touches', () => {
        const level = (upgradeLevel, cost) => ({
            ...covering([0, 1, 2], { cost }),
            candidate: { type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel },
        });

        const plan = planFor([level(55, 10), level(60, 10)], 1000);

        expect(plan.picks).toHaveLength(1);
    });

    test('nothing whose gain is inside the noise', () => {
        const plan = planWithinBudget([pick({ per: 99, significant: false })], 1000);

        expect(plan.picks).toHaveLength(0);
        expect(plan.skipped[0].reason).toContain('noise');
    });

    test('unless you ask for it anyway', () => {
        const plan = planWithinBudget([pick({ per: 99, significant: false })], 1000, { includeUnmeasured: true });

        expect(plan.picks).toHaveLength(1);
    });

    test('and nothing priceless, since a budget is in coins', () => {
        const plan = planWithinBudget([{ ...pick(), cost: null }], 1000);

        expect(plan.picks).toHaveLength(0);
    });

    test('nor anything that made the run worse', () => {
        const plan = planWithinBudget([pick({ attemptsDelta: 0.4 }), pick({ attemptsDelta: 0 })], 1000);

        expect(plan.picks).toHaveLength(0);
    });

    test('a zero budget buys nothing that costs coin, and does not throw', () => {
        const plan = planWithinBudget([pick({ cost: 100 }), pick({ cost: 250, slot: '/equipment_types/head' })], 0);

        expect(plan.picks).toHaveLength(0);
        expect(plan.totalCost).toBe(0);
        expect(plan.skipped.every((s) => s.reason === 'over budget')).toBe(true);
    });

    test('a zero budget still takes a swap that pays for itself and helps', () => {
        // A refund does not spend from the budget, so a budget of nothing can
        // still afford it — leaving it out would forgo a strictly-good swap
        const plan = planWithinBudget([pick({ cost: -50, attemptsDelta: -1 })], 0);

        expect(plan.picks).toHaveLength(1);
        expect(plan.totalCost).toBe(-50);
    });

    test('a budget below the cheapest candidate plans nothing rather than crashing', () => {
        const plan = planWithinBudget([pick({ cost: 5000 }), pick({ cost: 9000, slot: '/equipment_types/head' })], 100);

        expect(plan.picks).toHaveLength(0);
        expect(plan.totalCost).toBe(0);
        expect(plan.skipped.some((s) => s.reason === 'over budget')).toBe(true);
    });

    test('the totals are what was actually picked', () => {
        const plan = planWithinBudget(
            [
                pick({ per: 20, cost: 100, attemptsDelta: -2, slot: '/equipment_types/feet' }),
                pick({ per: 10, cost: 250, attemptsDelta: -1, slot: '/equipment_types/head' }),
            ],
            1000
        );

        expect(plan.totalCost).toBe(350);
        expect(plan.attemptsSaved).toBe(3);
    });

    describe('one book, one slot', () => {
        // A budget planner that keyed a swap on the incoming ability alone bought
        // two books to read one; keyed on the outgoing one alone it bought the
        // same stack twice. Both directions have to hold at once.
        const swap = (replacesHrid, upgradeHrid, over = {}) => ({
            ...covering([0, 1, 2], over),
            candidate: {
                type: 'ability_swap',
                slot: over.slot || 'ability_1',
                replacesHrid,
                upgradeHrid,
            },
        });

        test('two swaps into the same equipped ability buy one book', () => {
            const plan = planFor(
                [
                    swap('/abilities/smack', '/abilities/fireball', { cost: 10 }),
                    swap('/abilities/smack', '/abilities/poke', { cost: 10 }),
                ],
                1000
            );

            expect(plan.picks).toHaveLength(1);
            expect(plan.totalCost).toBe(10);
        });

        test('one newcomer offered for two slots is still one book', () => {
            const plan = planFor(
                [
                    swap('/abilities/smack', '/abilities/fireball', { cost: 10, slot: 'ability_1' }),
                    swap('/abilities/poke', '/abilities/fireball', { cost: 10, slot: 'ability_2' }),
                ],
                1000
            );

            expect(plan.picks).toHaveLength(1);
            expect(plan.totalCost).toBe(10);
        });

        test('two swaps sharing neither end are two purchases', () => {
            const plan = planFor(
                [
                    swap('/abilities/smack', '/abilities/fireball', { cost: 10, slot: 'ability_1' }),
                    swap('/abilities/poke', '/abilities/entangle', { cost: 10, slot: 'ability_2' }),
                ],
                1000
            );

            expect(plan.picks).toHaveLength(2);
            expect(plan.totalCost).toBe(20);
        });

        test('the loser is skipped for the reason it was actually skipped', () => {
            const plan = planFor(
                [
                    swap('/abilities/smack', '/abilities/fireball', { cost: 10 }),
                    swap('/abilities/smack', '/abilities/poke', { cost: 10 }),
                ],
                1000
            );

            expect(plan.skipped).toHaveLength(1);
            expect(plan.skipped[0].reason).toBe('a pick already uses what this needs');
        });
    });

    test('and the saving counts each room once, not once per piece', () => {
        // Two pieces both lifting room 0 from two attempts to one is still one
        // attempt saved there, whichever of them the room wears
        const plan = planFor(
            [covering([0], { hrid: '/items/a', cost: 10 }), covering([0, 1], { hrid: '/items/b', cost: 10 })],
            1000
        );

        expect(plan.attemptsSaved).toBeCloseTo(2, 5);
    });
});

/**
 * A token row steps up from a level, and which level that is stopped being
 * obvious once the Lab Sim could simulate tokens the character has not bought.
 * A run made under Damage 8 that offers "Damage Lv3 → Lv4" is pricing a
 * purchase the sims already assumed — the row and the simulation have to agree
 * on where the character is standing.
 */
describe('which levels the labyrinth token rows step up from', () => {
    const byName = (candidates, name) => candidates.find((c) => c.description.startsWith(name));

    test('the live character, when nothing else is said', () => {
        character.characterInfo = { labyrinthCombatDamageLevel: 3 };

        expect(byName(generateLabyrinthBuffCandidates(), 'Combat Damage')).toMatchObject({
            currentLevel: 3,
            description: 'Combat Damage Lv3→4',
        });

        delete character.characterInfo;
    });

    test('and the levels being simulated, when they are', () => {
        character.characterInfo = { labyrinthCombatDamageLevel: 3 };

        const candidate = byName(generateLabyrinthBuffCandidates({ labyrinthCombatDamageLevel: 8 }), 'Combat Damage');

        expect(candidate).toMatchObject({ currentLevel: 8, description: 'Combat Damage Lv8→9' });
        // Nine levels in rather than one, so the token price is the ninth's
        expect(candidate.tokenCost).toBe(40 * 9);

        delete character.characterInfo;
    });

    test('a token simulated at its cap stops being offered, whatever the character owns', () => {
        character.characterInfo = { labyrinthCombatDamageLevel: 0 };

        const candidates = generateLabyrinthBuffCandidates({ labyrinthCombatDamageLevel: 12 });

        expect(byName(candidates, 'Combat Damage')).toBeUndefined();
        expect(byName(candidates, 'Attack Speed')).toBeDefined();

        delete character.characterInfo;
    });

    test('and a character the client cannot read is offered nothing rather than nine level-ones', () => {
        delete character.characterInfo;

        expect(generateLabyrinthBuffCandidates()).toEqual([]);
    });
});

describe('labyrinth token candidates for the skilling tab', () => {
    const byName = (candidates, name) => candidates.find((c) => c.description.startsWith(name));

    test('the Experience token is offered, not filtered out', () => {
        // It buys no clear rate, so both of the old filters — category
        // 'skilling' here, combat-only there — dropped it and it appeared in
        // neither tab at any level
        const candidates = generateLabyrinthBuffCandidatesFromEditor({
            speed: 0,
            efficiency: 0,
            success: 0,
            doubleProgress: 0,
            experience: 0,
        });

        const experience = byName(candidates, 'Experience');
        expect(experience).toBeDefined();
        expect(experience.category).toBe('experience');
        expect(experience.editorKey).toBe('experience');
        expect(experience.step).toBe(0.01);
    });

    test('and costs 80 tokens a level, not the 40 every other token costs', () => {
        const candidates = generateLabyrinthBuffCandidatesFromEditor({ experience: 0, speed: 0 });

        expect(byName(candidates, 'Experience').tokenCost).toBe(80);
        expect(byName(candidates, 'Skilling Speed').tokenCost).toBe(40);
    });

    test('with the cost rising by one level each time', () => {
        const atThree = generateLabyrinthBuffCandidatesFromEditor({ experience: 3 });
        const experience = byName(atThree, 'Experience');

        expect(experience.currentLevel).toBe(3);
        expect(experience.tokenCost).toBe(320);
        expect(experience.description).toBe('Experience Lv3→4');
    });

    test('a maxed Experience token stops being offered', () => {
        const candidates = generateLabyrinthBuffCandidatesFromEditor({ experience: 12, speed: 0 });

        expect(byName(candidates, 'Experience')).toBeUndefined();
        expect(byName(candidates, 'Skilling Speed')).toBeDefined();
    });

    test('the skilling tokens still come through unchanged', () => {
        const candidates = generateLabyrinthBuffCandidatesFromEditor({
            speed: 1,
            efficiency: 0,
            success: 0,
            doubleProgress: 0,
            experience: 0,
        });

        expect(candidates.map((c) => c.category).sort()).toEqual([
            'experience',
            'skilling',
            'skilling',
            'skilling',
            'skilling',
        ]);
        expect(byName(candidates, 'Skilling Speed').tokenCost).toBe(80);
        expect(byName(candidates, 'Success Rate').metric).toBe('successBonus');
    });
});

describe('where a skilling upgrade lands', () => {
    const TOOL = '/equipment_types/milking_tool';
    const BODY = '/equipment_types/body';
    const payload = { hrid: '/items/celestial_brush', enhancementLevel: 5 };

    test('a piece bought for one skill goes into that skill alone', () => {
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 0 } },
            '/skills/crafting': {},
        };
        applyToEquipment({ skillKey: '/skills/milking', slot: TOOL }, payload, { equipment: {} }, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/crafting'][TOOL]).toBeUndefined();
    });

    test('a skill with no loadout gets a kit of its own rather than the shared one', () => {
        // Its room runs in the base kit, so writing the piece there would put a
        // Milking outfit into every other skill that also has no loadout
        const dto = { equipment: { [BODY]: { hrid: '/items/plain_shirt', enhancementLevel: 0 } } };
        const map = {};

        applyToEquipment({ skillKey: '/skills/milking', slot: TOOL }, payload, dto, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/milking'][BODY]).toEqual(dto.equipment[BODY]);
        expect(dto.equipment[TOOL]).toBeUndefined();
    });

    test('enhancing an item you own upgrades it in every kit wearing it', () => {
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const dto = { equipment: { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } } };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
        };

        applyToEquipment(candidate, payload, dto, map, null);

        expect(dto.equipment[TOOL]).toBe(payload);
        expect(map['/skills/milking'][TOOL]).toBe(payload);
    });

    test('but not a second copy of it worn at a different level', () => {
        // Matching on hrid alone dragged the +7 copy down to the +5 this
        // candidate was about, which reads as an upgrade making things worse
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
            '/skills/foraging': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 7 } },
        };

        applyToEquipment(candidate, payload, { equipment: {} }, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/foraging'][TOOL].enhancementLevel).toBe(7);
    });

    test('and only the skill under analysis when one skill is being analysed', () => {
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
            '/skills/foraging': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
        };

        applyToEquipment(candidate, payload, { equipment: {} }, map, '/skills/milking');

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/foraging'][TOOL]).not.toBe(payload);
    });
});

describe('calculateUpgradeCost for items without high-level listings', () => {
    test('uses the market ask when the target enhancement level has a listing', () => {
        getItemPrices.mockReturnValue({ ask: 200_000_000, bid: 150_000_000 });
        resolveItemPrice.mockImplementation((hrid, { side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            return { price: 5_000_000 };
        });

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBe(199_000_000);
    });

    test('falls back to base price plus enhancement cost when the level has no listing', () => {
        getItemPrices.mockImplementation((hrid) =>
            hrid === '/items/enhance_mat' ? { ask: 100_000, bid: 90_000 } : null
        );
        resolveItemPrice.mockImplementation((hrid, { enhancementLevel, side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            if (enhancementLevel === 10) return { price: 0 };
            return { price: 5_000_000 };
        });
        calculateEnhancement.mockReturnValue({ attempts: 3, protectionCount: 0 });
        getCheapestProtectionPrice.mockReturnValue({ price: 0 });
        // The per-attempt bill is the shared rule's answer; what this test is
        // about is that the sweep's figure is added to the base price at all
        perAttemptMaterialCost.mockReturnValue({ cost: 100_000, hasCost: true, hasMissingPrices: false });
        getEnhancingParams.mockReturnValue({
            enhancingLevel: 100,
            toolBonus: 0,
            speedBonus: 0,
            teas: {},
            guzzlingBonus: 1,
        });

        const gameData = buildGameData();
        gameData.itemDetailMap['/items/regal_sword_refined'].enhancementCosts = [
            { itemHrid: '/items/enhance_mat', count: 1 },
        ];

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            gameData
        );

        // Base price (5M) + enhancement path cost - sell current (1M); the exact
        // enhance cost depends on the mocked attempt count, so just assert the shape
        expect(cost).toBeGreaterThan(4_000_000);
    });

    test('reports unknown (null) instead of free when the item has no enhancement recipe', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation((hrid, { enhancementLevel, side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            if (enhancementLevel === 10) return { price: 0 };
            return { price: 5_000_000 };
        });

        // buildGameData()'s items carry no enhancementCosts — pricing a +10 buy
        // is impossible, and reporting 0 would rank this as the best-value upgrade
        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBeNull();
    });

    test('enhancement candidates report unknown when the enhance path cannot be priced', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            {
                type: 'enhancement',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 5,
                upgradeHrid: '/items/fine_sword',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBeNull();
    });

    test('returns null instead of 0 when no price is known at all', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 5,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBeNull();
    });
});

/**
 * What an enhancement path is quoted at.
 *
 * The material rule itself now lives in `utils/enhancement-pricing.js` and is
 * tested there — a one-sided book cross-fills rather than falling through to a
 * vendor price, and trainee charms take the one shop-price constant. What is
 * left for this suite is the advisor's own two decisions: that it asks the
 * shared rule rather than carrying a transcription of it, and that protection
 * nobody can price makes a protected strategy *unavailable* rather than free.
 * A zero read as a price made the most-protected path win every comparison on a
 * quote it had no basis for.
 */
describe('pricing an enhancement path', () => {
    /** Wire the mocks this suite shares. */
    function setup() {
        resolveItemPrice.mockImplementation((hrid, { side }) =>
            side === 'sell' ? { price: 1_000_000 } : { price: 5_000_000 }
        );
        // The chain is solved from the level the piece is at, so a +5 → +6 run
        // is one attempt. An unprotected failure falls all the way to +0, which
        // is why the unprotected run costs the whole climb rather than one step.
        calculateEnhancement.mockImplementation(({ targetLevel, startLevel = 0, protectFrom }) =>
            protectFrom > 0
                ? { attempts: targetLevel - startLevel, protectionCount: 1 }
                : { attempts: targetLevel, protectionCount: 0 }
        );
        getCheapestProtectionPrice.mockReturnValue({ price: null, itemHrid: null });
        perAttemptMaterialCost.mockReturnValue({ cost: 90_000, hasCost: true, hasMissingPrices: false });
        getEnhancingParams.mockReturnValue({
            enhancingLevel: 100,
            toolBonus: 0,
            speedBonus: 0,
            teas: {},
            guzzlingBonus: 1,
        });

        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_sword'].enhancementCosts = [{ itemHrid: '/items/enhance_mat', count: 1 }];
        gameData.itemDetailMap['/items/enhance_mat'] = { name: 'Mat', sellPrice: 100 };
        getItemPrices.mockReturnValue(null);
        return gameData;
    }

    /**
     * The cost of taking the fine sword from +5 to +6.
     * @param {Object} gameData - Game data payload
     * @returns {number|null} Cost, or null when it cannot be priced
     */
    function enhanceCost(gameData) {
        return calculateUpgradeCost(
            {
                type: 'enhancement',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 5,
                upgradeHrid: '/items/fine_sword',
                upgradeLevel: 6,
            },
            gameData
        );
    }

    test('the bill is the shared per-attempt figure times the attempts', () => {
        const gameData = setup();

        // Only the unprotected run can be priced here, and an unprotected
        // failure drops to +0 — six attempts at 90,000 the attempt
        expect(enhanceCost(gameData)).toBe(540_000);

        // The item's own recipe is what gets priced, through the shared rule
        expect(perAttemptMaterialCost).toHaveBeenCalledWith(gameData.itemDetailMap['/items/fine_sword']);
    });

    test('unpriceable protection does not make a protected path free', () => {
        const gameData = setup();
        // Protecting takes one attempt against the unprotected six, so at a
        // price of zero it would undercut the unprotected path every time
        getCheapestProtectionPrice.mockReturnValue({ price: null, itemHrid: null });

        expect(enhanceCost(gameData)).toBe(540_000);
    });

    test('protection that has a price is used, and can win', () => {
        const gameData = setup();
        getCheapestProtectionPrice.mockReturnValue({ price: 10_000, itemHrid: '/items/mirror_of_protection' });

        // One attempt at 90,000 plus one protection at 10,000, against 540,000
        expect(enhanceCost(gameData)).toBe(100_000);
    });

    test('a recipe nothing in which can be priced is unknown, not free', () => {
        const gameData = setup();
        perAttemptMaterialCost.mockReturnValue({ cost: 0, hasCost: false, hasMissingPrices: true });

        expect(enhanceCost(gameData)).toBeNull();
    });
});

describe('Philosopher accessory candidates', () => {
    const NECK = '/equipment_types/neck';
    const RING = '/equipment_types/ring';

    function buildJewelryGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/necklace_of_speed': {
                    name: 'Necklace Of Speed',
                    itemLevel: 60,
                    equipmentDetail: { type: NECK, combatStats: { slashDamage: 2 } },
                },
                '/items/philosophers_necklace': {
                    name: "Philosopher's Necklace",
                    itemLevel: 60,
                    equipmentDetail: { type: NECK, combatStats: { slashDamage: 1 } },
                },
                '/items/philosophers_ring': {
                    name: "Philosopher's Ring",
                    itemLevel: 60,
                    equipmentDetail: { type: RING, combatStats: { slashDamage: 1 } },
                },
            },
        };
    }

    test('offers the philo accessory at +5 even when current jewelry is enhanced higher', () => {
        const player = { equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 12 } } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');
        const philo = candidates.find((c) => c.upgradeHrid === '/items/philosophers_necklace');

        expect(philo).toBeDefined();
        expect(philo.upgradeLevel).toBe(5);
        expect(philo.currentLevel).toBe(12);
    });

    test('does not offer a philo swap when the philo accessory is already worn', () => {
        const player = { equipment: { [NECK]: { hrid: '/items/philosophers_necklace', enhancementLevel: 3 } } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');
        const philoSwaps = candidates.filter(
            (c) => c.type === 'tier' && c.upgradeHrid === '/items/philosophers_necklace'
        );

        expect(philoSwaps).toHaveLength(0);
    });

    test('skips jewelry slots with nothing equipped', () => {
        const player = { equipment: { [NECK]: null } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');

        expect(candidates.filter((c) => c.upgradeHrid?.startsWith('/items/philosophers_'))).toHaveLength(0);
    });

    test('skilling candidates also include the philo accessory at +5', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
        getItemPrices.mockReturnValue(null);
        const gameData = buildJewelryGameData();
        gameData.itemDetailMap['/items/necklace_of_speed'].equipmentDetail.noncombatStats = { skillingSpeed: 1 };

        const editorDTO = { equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 12 } } };
        const candidates = generateSkillingEquipmentCandidates(editorDTO, gameData);
        const philo = candidates.find((c) => c.upgradeHrid === '/items/philosophers_necklace');

        expect(philo).toBeDefined();
        expect(philo.upgradeLevel).toBe(5);
    });
});

describe('tier progression sidegrade guard', () => {
    function buildSiblingGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                // Two T50 melee swords: same slot, same role, same item level
                '/items/sword_a': {
                    name: 'Sword A',
                    itemLevel: 50,
                    sortIndex: 1,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 10 } },
                },
                '/items/sword_b': {
                    name: 'Sword B',
                    itemLevel: 50,
                    sortIndex: 2,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 10 } },
                },
                '/items/sword_c': {
                    name: 'Sword C',
                    itemLevel: 70,
                    sortIndex: 3,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 20 } },
                },
            },
        };
    }

    test('skips a same-item-level sibling and suggests the next real tier instead', () => {
        const candidates = generateCandidates(buildPlayer('/items/sword_a', 5), buildSiblingGameData(), 'equipment');
        const tiers = candidates.filter((c) => c.type === 'tier');

        // Sword B is the immediate neighbour but the same tier — a paid sidegrade
        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_b')).toBe(false);
        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_c')).toBe(true);
    });

    test('still suggests a refined variant sharing the base item level', () => {
        const gameData = buildSiblingGameData();
        gameData.itemDetailMap['/items/sword_a_refined'] = {
            name: 'Sword A (R)',
            itemLevel: 50,
            sortIndex: 4,
            equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 14 } },
        };

        const candidates = generateCandidates(buildPlayer('/items/sword_a', 10), gameData, 'equipment');
        const tiers = candidates.filter((c) => c.type === 'tier');

        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_a_refined')).toBe(true);
    });
});

describe('melee damage styles form separate tier groups', () => {
    function buildMeleeStyleGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/fine_spear': {
                    name: 'Fine Spear',
                    itemLevel: 50,
                    sortIndex: 1,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { stabDamage: 10 } },
                },
                // Higher tier, but slash — a spear user swinging it trains nothing it has
                '/items/regal_sword': {
                    name: 'Regal Sword',
                    itemLevel: 60,
                    sortIndex: 2,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 15 } },
                },
                '/items/regal_mace': {
                    name: 'Regal Mace',
                    itemLevel: 60,
                    sortIndex: 3,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { smashDamage: 15 } },
                },
                '/items/furious_spear': {
                    name: 'Furious Spear',
                    itemLevel: 70,
                    sortIndex: 4,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { stabDamage: 20 } },
                },
            },
        };
    }

    test('a stab user is offered the next stab weapon, not the cheaper slash/smash neighbours', () => {
        const candidates = generateCandidates(
            buildPlayer('/items/fine_spear', 5),
            buildMeleeStyleGameData(),
            'equipment'
        );
        const tiers = candidates.filter((c) => c.type === 'tier');

        expect(tiers.some((c) => c.upgradeHrid === '/items/furious_spear')).toBe(true);
        expect(tiers.some((c) => c.upgradeHrid === '/items/regal_sword')).toBe(false);
        expect(tiers.some((c) => c.upgradeHrid === '/items/regal_mace')).toBe(false);
    });

    test('accuracy-only melee gear splits by style too', () => {
        const gameData = buildMeleeStyleGameData();
        gameData.itemDetailMap['/items/fine_spear'].equipmentDetail.combatStats = { stabAccuracy: 10 };
        gameData.itemDetailMap['/items/furious_spear'].equipmentDetail.combatStats = { stabAccuracy: 20 };
        gameData.itemDetailMap['/items/regal_sword'].equipmentDetail.combatStats = { slashAccuracy: 15 };

        const candidates = generateCandidates(buildPlayer('/items/fine_spear', 5), gameData, 'equipment');
        const tiers = candidates.filter((c) => c.type === 'tier');

        expect(tiers.some((c) => c.upgradeHrid === '/items/furious_spear')).toBe(true);
        expect(tiers.some((c) => c.upgradeHrid === '/items/regal_sword')).toBe(false);
    });
});

describe('resolveCandidateModes', () => {
    test('uses the checked sets and drops the food pseudo-mode', () => {
        expect(resolveCandidateModes(['equipment', 'house', 'food'])).toEqual(['equipment', 'house']);
    });

    test('deduplicates repeated sets', () => {
        expect(resolveCandidateModes(['equipment', 'equipment'])).toEqual(['equipment']);
    });

    test('expands the legacy combined mode', () => {
        expect(resolveCandidateModes(undefined, 'combined')).toEqual(['equipment', 'ability_level']);
    });

    test('passes a legacy single mode through', () => {
        expect(resolveCandidateModes(undefined, 'ability_swap')).toEqual(['ability_swap']);
    });

    test('falls back to equipment with nothing specified', () => {
        expect(resolveCandidateModes(undefined, undefined)).toEqual(['equipment']);
        expect(resolveCandidateModes([], undefined)).toEqual(['equipment']);
    });
});

describe('house upgrade candidates', () => {
    const ROOM_TAGGED = { usableInActionTypeMap: { '/action_types/combat': true } };
    const BUFF_TAGGED = { typeHrid: '/buff_types/mystery', usableInActionTypeMap: { '/action_types/combat': true } };
    const COMBAT_TYPE_BUFF = { typeHrid: '/buff_types/armor' };
    const SKILL_BUFF = {
        typeHrid: '/buff_types/action_speed',
        usableInActionTypeMap: { '/action_types/brewing': true },
    };

    function houseGameData() {
        return {
            houseRoomDetailMap: {
                '/house_rooms/dojo': {
                    name: 'Dojo',
                    actionBuffs: [COMBAT_TYPE_BUFF],
                    upgradeCostsMap: {
                        4: [
                            { itemHrid: '/items/coin', count: 1_000_000 },
                            { itemHrid: '/items/lumber', count: 10 },
                        ],
                        5: [{ itemHrid: '/items/coin', count: 2_000_000 }],
                    },
                },
                '/house_rooms/brewery': {
                    name: 'Brewery',
                    actionBuffs: [SKILL_BUFF],
                    upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 100 }] },
                },
                '/house_rooms/gym': {
                    name: 'Gym',
                    globalBuffs: [COMBAT_TYPE_BUFF],
                    upgradeCostsMap: {},
                },
            },
        };
    }

    describe('combat relevance', () => {
        test('accepts a room tagged for combat on the room itself', () => {
            expect(houseRoomAffectsCombat({ ...ROOM_TAGGED, actionBuffs: [SKILL_BUFF] })).toBe(true);
        });

        test('accepts a room whose buff is tagged for combat', () => {
            expect(houseRoomAffectsCombat({ actionBuffs: [BUFF_TAGGED] })).toBe(true);
        });

        test('accepts a room whose buff type the combat engine reads', () => {
            expect(houseRoomAffectsCombat({ globalBuffs: [COMBAT_TYPE_BUFF] })).toBe(true);
        });

        test('rejects a skilling-only room', () => {
            expect(houseRoomAffectsCombat({ actionBuffs: [SKILL_BUFF] })).toBe(false);
        });

        test('rejects a room with no buffs at all', () => {
            expect(houseRoomAffectsCombat({ name: 'Empty' })).toBe(false);
            expect(houseRoomAffectsCombat(null)).toBe(false);
        });
    });

    test('offers one level per combat-relevant room and skips skilling rooms', () => {
        const candidates = generateHouseCandidates(
            { houseRooms: { '/house_rooms/dojo': 3, '/house_rooms/brewery': 0, '/house_rooms/gym': 0 } },
            houseGameData()
        );

        expect(candidates.map((c) => c.roomHrid).sort()).toEqual(['/house_rooms/dojo', '/house_rooms/gym']);
        const dojo = candidates.find((c) => c.roomHrid === '/house_rooms/dojo');
        expect(dojo.currentLevel).toBe(3);
        expect(dojo.upgradeLevel).toBe(4);
        expect(dojo.description).toBe('Dojo Lv3 → Lv4');
    });

    test('skips rooms already at the level cap', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 8 } }, houseGameData());
        expect(candidates.some((c) => c.roomHrid === '/house_rooms/dojo')).toBe(false);
    });

    test('jumps straight to a target level when one is given', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 3 } }, houseGameData(), 6);
        const dojo = candidates.find((c) => c.roomHrid === '/house_rooms/dojo');

        expect(dojo.upgradeLevel).toBe(6);
        expect(dojo.description).toBe('Dojo Lv3 → Lv6');
    });

    test('skips rooms already at or above the target level', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 6 } }, houseGameData(), 6);
        expect(candidates.some((c) => c.roomHrid === '/house_rooms/dojo')).toBe(false);
    });

    test('per-room targets take precedence over the uniform target', () => {
        const candidates = generateHouseCandidates(
            { houseRooms: { '/house_rooms/dojo': 3, '/house_rooms/gym': 0 } },
            houseGameData(),
            5,
            { '/house_rooms/dojo': 7 }
        );

        // Dojo follows its own target; Gym was left blank in the grid, so it's skipped
        expect(candidates).toHaveLength(1);
        expect(candidates[0].roomHrid).toBe('/house_rooms/dojo');
        expect(candidates[0].upgradeLevel).toBe(7);
    });

    test('per-room target at or below the current level skips the room', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 5 } }, houseGameData(), 0, {
            '/house_rooms/dojo': 5,
        });
        expect(candidates).toHaveLength(0);
    });

    test('clamps a target level above the cap', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 3 } }, houseGameData(), 99);
        expect(candidates.find((c) => c.roomHrid === '/house_rooms/dojo').upgradeLevel).toBe(8);
    });

    test('costs coins at face value plus the market price of each material', () => {
        resolveItemPrice.mockImplementation((hrid) => ({ price: hrid === '/items/lumber' ? 2_000 : 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 4 },
            houseGameData()
        );

        expect(cost).toBe(1_000_000 + 10 * 2_000);
    });

    test('sums every level when jumping more than one', () => {
        resolveItemPrice.mockImplementation((hrid) => ({ price: hrid === '/items/lumber' ? 2_000 : 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 5 },
            houseGameData()
        );

        expect(cost).toBe(1_000_000 + 10 * 2_000 + 2_000_000);
    });

    test('reports unknown when a material has no price', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 4 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    test('reports unknown when any level in the span has no cost recipe', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 2_000 }));

        const cost = calculateUpgradeCost(
            // Level 6 has no recipe in the fixture
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 6 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    test('reports unknown when the level has no cost recipe', () => {
        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/gym', currentLevel: 0, upgradeLevel: 1 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    describe('describeHouseScan', () => {
        test('counts rooms, buffed rooms, combat rooms and upgradable rooms', () => {
            const scan = describeHouseScan({ houseRooms: { '/house_rooms/dojo': 8 } }, houseGameData());

            expect(scan).toEqual({ rooms: 3, withBuffs: 3, combatRelevant: 2, belowCap: 1 });
        });

        test('reports zeroes with no house data', () => {
            expect(describeHouseScan({}, {})).toEqual({ rooms: 0, withBuffs: 0, combatRelevant: 0, belowCap: 0 });
        });
    });
});

describe('candidateAssignmentKey', () => {
    const BODY = '/equipment_types/body';
    const LEGS = '/equipment_types/legs';

    test('a pair is distinct from either piece alone', () => {
        const bodyOnly = { type: 'cross_slot', addedSlots: { [BODY]: { hrid: '/items/a', enhancementLevel: 7 } } };
        const legsOnly = { type: 'cross_slot', addedSlots: { [LEGS]: { hrid: '/items/b', enhancementLevel: 7 } } };
        const pair = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };

        const keys = [bodyOnly, legsOnly, pair].map(candidateAssignmentKey);
        expect(new Set(keys).size).toBe(3);
    });

    test('two pairs sharing a body piece stay distinct', () => {
        const withB = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };
        const withC = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/c', enhancementLevel: 7 },
            },
        };

        expect(candidateAssignmentKey(withB)).not.toBe(candidateAssignmentKey(withC));
    });

    test('a single-slot cross_slot matches the equivalent tier candidate', () => {
        const tier = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 7 };
        const crossSlot = {
            type: 'cross_slot',
            slot: BODY,
            addedSlots: { [BODY]: { hrid: '/items/a', enhancementLevel: 7 } },
            clearedSlots: [],
        };

        expect(candidateAssignmentKey(crossSlot)).toBe(candidateAssignmentKey(tier));
    });

    test('slot order does not change the key', () => {
        const a = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };
        const b = {
            type: 'cross_slot',
            addedSlots: {
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
            },
        };

        expect(candidateAssignmentKey(a)).toBe(candidateAssignmentKey(b));
    });

    test('a weapon swap that clears slots differs from one that does not', () => {
        const twoHand = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/w', enhancementLevel: 7 } },
            clearedSlots: ['/equipment_types/main_hand', '/equipment_types/off_hand'],
        };
        const bare = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/w', enhancementLevel: 7 } },
            clearedSlots: [],
        };

        expect(candidateAssignmentKey(twoHand)).not.toBe(candidateAssignmentKey(bare));
    });

    test('enhancement levels separate the same item at different levels', () => {
        const plus7 = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 7 };
        const plus10 = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 10 };
        expect(candidateAssignmentKey(plus7)).not.toBe(candidateAssignmentKey(plus10));
    });

    test('non-equipment candidates key off their own type', () => {
        const house = { type: 'house', slot: 'house|/house_rooms/dojo', upgradeLevel: 4 };
        const level = { type: 'combat_level', slot: 'combat_level|meleeLevel', upgradeLevel: 105 };
        const ability = { type: 'ability_level', slot: 'ability_1', upgradeHrid: '/abilities/x', upgradeLevel: 75 };

        const keys = [house, level, ability].map(candidateAssignmentKey);
        expect(new Set(keys).size).toBe(3);
        expect(keys[0]).toContain('house');
        expect(keys[1]).toContain('combat_level');
    });
});

describe('explainUpgradeCost', () => {
    const BODY = '/equipment_types/body';
    const LEGS = '/equipment_types/legs';

    function costGameData() {
        return {
            itemDetailMap: {
                '/items/fire_top': { name: 'Fire Top', equipmentDetail: { type: BODY } },
                '/items/fire_bottoms': { name: 'Fire Bottoms', equipmentDetail: { type: LEGS } },
                '/items/nature_top': { name: 'Nature Top', equipmentDetail: { type: BODY } },
            },
        };
    }

    test('itemises every purchase in a multi-slot swap', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 5_000_000, bid: 4_000_000 });

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: {
                    [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 },
                    [LEGS]: { hrid: '/items/fire_bottoms', enhancementLevel: 7 },
                },
                removedItems: [{ hrid: '/items/nature_top', enhancementLevel: 7 }],
            },
            costGameData()
        );

        expect(detail.buys.map((b) => b.name)).toEqual(['Fire Top', 'Fire Bottoms']);
        expect(detail.credits.map((c) => c.name)).toEqual(['Nature Top']);
        expect(detail.credit).toBe(1_000_000);
    });

    test('names the unpriced item that makes a cost unknown', () => {
        // No listing at +7 and no enhancement recipe leaves the buy price unknown
        getItemPrices.mockReturnValue({ ask: 0, bid: 0 });
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: { [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 } },
                removedItems: [],
            },
            costGameData()
        );

        expect(detail.unpriced).toEqual(['Fire Top']);
        expect(detail.gross).toBe(null);
        expect(detail.net).toBe(null);
    });

    test('a figure with a sweep in it names whose enhancing stats it ran on', () => {
        // A `sim` figure is half a simulated enhance path, and the same path
        // costs different money on different benches. The row's detail is where
        // that gets said — in the same word the enhancement tooltip's chip uses
        getItemPrices.mockImplementation((hrid) =>
            hrid === '/items/enhance_mat' ? { ask: 100_000, bid: 90_000 } : null
        );
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        calculateEnhancement.mockReturnValue({ attempts: 3, protectionCount: 0 });
        getCheapestProtectionPrice.mockReturnValue({ price: 0 });
        perAttemptMaterialCost.mockReturnValue({ cost: 100_000, hasCost: true, hasMissingPrices: false });
        getEnhancingParams.mockReturnValue({
            enhancingLevel: 100,
            toolBonus: 0,
            speedBonus: 0,
            teas: {},
            guzzlingBonus: 1,
            paramsSource: 'auto',
        });

        const gameData = costGameData();
        gameData.itemDetailMap['/items/fire_top'].itemLevel = 50;
        gameData.itemDetailMap['/items/fire_top'].enhancementCosts = [{ itemHrid: '/items/enhance_mat', count: 1 }];

        const detail = explainUpgradeCost(
            { type: 'tier', slot: BODY, upgradeHrid: '/items/fire_top', upgradeLevel: 7, removedItems: [] },
            gameData
        );

        expect(detail.source).toBe('sim');
        expect(detail.enhanceSource).toMatchObject({ kind: 'yours', label: 'Yours' });
    });

    test('a figure the market quoted outright ran no sweep, and says nothing about benches', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 5_000_000, bid: 4_000_000 });

        const detail = explainUpgradeCost(
            { type: 'tier', slot: BODY, upgradeHrid: '/items/fire_top', upgradeLevel: 7, removedItems: [] },
            costGameData()
        );

        expect(detail.source).toBe('market');
        expect(detail.enhanceSource).toBeNull();
    });

    test('an enhancement row falling back to the sweep names the bench too', () => {
        // Both levels listed is a market delta and runs no sweep; anything else
        // falls through to the enhance path, which is nothing but one
        getItemPrices.mockReturnValue({ ask: 0, bid: 0 });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getEnhancingParams.mockReturnValue({ enhancingLevel: 100, teas: {}, paramsSource: 'auto' });

        const detail = explainUpgradeCost(
            {
                type: 'enhancement',
                slot: BODY,
                currentHrid: '/items/fire_top',
                currentLevel: 4,
                upgradeLevel: 7,
                removedItems: [],
            },
            costGameData()
        );

        expect(detail.source).toBe('sim');
        expect(detail.enhanceSource?.label).toBe('Yours');
    });

    test('reports no credit when nothing is replaced', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
        getItemPrices.mockReturnValue({ ask: 3_000_000, bid: 2_000_000 });

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: { [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 } },
                removedItems: [],
            },
            costGameData()
        );

        expect(detail.credits).toEqual([]);
        expect(detail.credit).toBe(0);
        expect(detail.net).toBe(detail.gross);
    });
});

describe('what an ability upgrade costs', () => {
    const levelUp = {
        type: 'ability_level',
        slot: 'ability_1',
        currentHrid: '/abilities/fireball',
        currentLevel: 48,
        upgradeHrid: '/abilities/fireball',
        upgradeLevel: 53,
    };
    const gameData = { levelExperienceTable: [0, 100, 200], itemDetailMap: {} };
    const swap = { type: 'ability_swap', upgradeHrid: '/abilities/critical_aura', upgradeLevel: 20 };

    beforeEach(() => {
        character.characterAbilities = [];
    });

    test('it is books, not a listing for the ability at that level', () => {
        // An ability is not an item: asking the market for "fireball +53" finds
        // nothing, and the row reads "no price found" for something anyone can
        // buy books for today
        const detail = explainUpgradeCost(levelUp, gameData);

        expect(detail.books).toMatchObject({ bookName: 'Fireball', bookPrice: 1000 });
        expect(detail.buys).toEqual([]);
        expect(detail.gross).toBe(12_400);
    });

    test('nothing is credited back, because levels cannot be sold', () => {
        const detail = explainUpgradeCost(levelUp, gameData);

        expect(detail.credits).toEqual([]);
        expect(detail.credit).toBe(0);
        expect(detail.net).toBe(detail.gross);
    });

    test('it is priced from where the ability is now', () => {
        explainUpgradeCost(levelUp, gameData);

        // XP at the current level, not from zero — the books already read count
        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/fireball', 48, 0, 53);
    });

    test('a level-up is priced from the experience already into the level', () => {
        // An ability part-way to its next level has already read some of the
        // books; pricing from the level floor bought them all over again and
        // overstated every ability row by up to a level's worth of books
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 48, experience: 99_999 }];
        explainUpgradeCost(levelUp, gameData);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/fireball', 48, 99_999, 53);
    });

    test('a live book that disagrees about its level falls back to the floor', () => {
        // Experience is a position within a level; carried onto a different
        // level it means nothing, so the floor is the honest reading
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 47, experience: 99_999 }];
        explainUpgradeCost(levelUp, gameData);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/fireball', 48, 0, 53);
    });

    test('a swap to an ability you have never read is learned from scratch', () => {
        const detail = explainUpgradeCost(swap, gameData);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 0, 0, 20);
        expect(detail.freshBook).toBe(true);
        expect(detail.ownedFromLevel).toBeNull();
    });

    test('but one already in the book bag is topped up from where it is', () => {
        // Quoting the whole path again for a book sitting at Lv14 prices an
        // afternoon's reading as a fresh 900M ability, which is what sank
        // perfectly affordable swaps to the bottom of the table
        character.characterAbilities = [
            { abilityHrid: '/abilities/critical_aura', level: 14, experience: 12_345 },
            { abilityHrid: '/abilities/fireball', level: 48, experience: 99 },
        ];
        const detail = explainUpgradeCost(swap, gameData);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 14, 12_345, 20);
        expect(detail.freshBook).toBe(false);
        expect(detail.ownedFromLevel).toBe(14);
    });

    test("a stranger's swap is not priced off the live character's book bag", () => {
        // The book at Lv14 above belongs to the character actually playing —
        // pricing an imported profile's or a party member's row from it would
        // quote a fireball-level book path as "already at Lv14" for someone who
        // never read a page of it. isSelf: false must price it as unread.
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 14, experience: 12_345 }];
        const detail = explainUpgradeCost(swap, gameData, false);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 0, 0, 20);
        expect(detail.freshBook).toBe(true);
        expect(detail.ownedFromLevel).toBeNull();
    });

    test('the cost the table ranks on reads the same book bag the breakdown prints', () => {
        // `calculateUpgradeCost` is what the ranking uses and `explainUpgradeCost`
        // is what the row prints. They must price a swap from the same place: a
        // book sitting at Lv14 that the breakdown calls a top-up but the Cost
        // column quotes as a fresh path is the exact bug fresh-book pricing was
        // introduced to kill, and it came back when the isSelf flag was threaded
        // through the breakdown and not through here.
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 14, experience: 12_345 }];
        calculateUpgradeCost(swap, gameData);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 14, 12_345, 20);
    });

    test("the ranking cost of a stranger's swap still ignores the live book bag", () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 14, experience: 12_345 }];
        calculateUpgradeCost(swap, gameData, false);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 0, 0, 20);
    });

    test("a stranger's level-up ignores the live character owning the same ability at the same level", () => {
        // `owned` used to be read unconditionally for level-ups too, not just
        // swaps — a live character who happens to own Fireball at Lv48 with XP
        // banked would silently donate that XP to any other player's Lv48
        // Fireball row, understating what they need to buy
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 48, experience: 99_999 }];
        explainUpgradeCost(levelUp, gameData, false);

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/fireball', 48, 0, 53);
    });

    test('an owned book with no experience recorded starts at its level, not at zero', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 1 }];
        explainUpgradeCost(swap, gameData);

        // levelExperienceTable[1] — the floor of the level it is on, which is
        // the same reading a level-up candidate takes
        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 1, 100, 20);
    });

    test('a book already past the target buys nothing, not a negative number of books', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 40, experience: 50_000 }];
        explainAbilityLevelUpCost.mockReturnValueOnce({
            bookName: 'Critical Aura',
            books: -8,
            bookPrice: 1000,
            total: -8000,
        });
        const detail = explainUpgradeCost(swap, gameData);

        expect(detail.books.books).toBe(0);
        expect(detail.net).toBe(0);
    });

    test('a fill of a book already at the level wanted is marked as owned, not slotted', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 20, experience: 50_000 }];
        explainAbilityLevelUpCost.mockReturnValueOnce({
            bookName: 'Critical Aura',
            books: 0,
            bookPrice: 1000,
            total: 0,
        });
        const detail = explainUpgradeCost({ ...swap, fillsFreeSlot: true }, gameData);

        expect(detail.ownedNotSlotted).toBe(true);
        expect(detail.net).toBe(0);
    });

    test('and one you own that still needs books is not', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 14, experience: 12_345 }];
        const detail = explainUpgradeCost(swap, gameData);

        expect(detail.ownedNotSlotted).toBe(false);
    });

    test('an unlisted book you already own is free, not unpriceable', () => {
        // Zero books is free whatever the market says; reading the clamp off the
        // price left an ability you own showing "no price" for buying nothing
        character.characterAbilities = [{ abilityHrid: '/abilities/critical_aura', level: 20, experience: 50_000 }];
        explainAbilityLevelUpCost.mockReturnValueOnce({
            bookName: 'Critical Aura',
            books: -3,
            bookPrice: null,
            total: null,
        });
        const detail = explainUpgradeCost({ ...swap, fillsFreeSlot: true }, gameData);

        expect(detail.net).toBe(0);
        expect(detail.unpriced).toEqual([]);
        expect(detail.ownedNotSlotted).toBe(true);
    });

    test('a level-up is never a fresh book, however the swap rule reads', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 48, experience: 4321 }];
        const detail = explainUpgradeCost(levelUp, gameData);

        expect(detail.freshBook).toBe(false);
        expect(detail.ownedFromLevel).toBeNull();
    });

    test('an ability nobody is selling costs unknown rather than nothing', () => {
        explainAbilityLevelUpCost.mockReturnValueOnce({
            bookName: 'Fireball',
            books: 12,
            bookPrice: null,
            total: null,
        });

        expect(calculateUpgradeCost(levelUp, gameData)).toBe(null);
    });

    test('and the cost is the books, when there is a price', () => {
        expect(calculateUpgradeCost(levelUp, gameData)).toBe(12_400);
    });
});

describe('computeEconomics', () => {
    const base = { profitPerHour: 1000 };

    test('payback is cost over current profit, repay is cost over the gain', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 1500 });
        expect(e.profitGainPerHour).toBe(500);
        expect(e.paybackHours).toBe(10); // 10,000 / 1,000
        expect(e.repayHours).toBe(20); // 10,000 / 500
    });

    test('an upgrade that does not raise profit never repays', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 1000 });
        expect(e.repayHours).toBe(Infinity);
        // Still affordable, though — payback is about the wallet, not the upgrade
        expect(e.paybackHours).toBe(10);
    });

    test('a profit loss never repays rather than reporting a negative period', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 400 });
        expect(e.profitGainPerHour).toBe(-600);
        expect(e.repayHours).toBe(Infinity);
    });

    test('unknown cost is unknown, never free', () => {
        const e = computeEconomics(null, base, { profitPerHour: 1500 });
        expect(e.paybackHours).toBe(Infinity);
        expect(e.repayHours).toBe(Infinity);
    });

    test('a free upgrade costs no time on either measure', () => {
        const e = computeEconomics(0, base, { profitPerHour: 1500 });
        expect(e.paybackHours).toBe(0);
        expect(e.repayHours).toBe(0);
    });

    test('payback preserves the cost ordering, which is why it is not scored', () => {
        // Every row divides by the same baseline rate, so payback cannot reorder
        // candidates relative to Cost — the claim the column tooltip makes
        const costs = [500, 10_000, 2_500, 40_000];
        const paybacks = costs.map((c) => computeEconomics(c, base, { profitPerHour: 1500 }).paybackHours);

        const byCost = [...costs].sort((a, b) => a - b);
        const byPayback = costs
            .map((c, i) => [c, paybacks[i]])
            .sort((a, b) => a[1] - b[1])
            .map(([c]) => c);
        expect(byPayback).toEqual(byCost);
    });

    test('nothing is affordable on zero profit', () => {
        const e = computeEconomics(10_000, { profitPerHour: 0 }, { profitPerHour: 500 });
        expect(e.paybackHours).toBe(Infinity);
        expect(e.repayHours).toBe(20); // the gain still repays it
    });
});

describe('assignRankScores', () => {
    const row = (name, dps, xp, profit, repayHours) => ({
        candidate: { description: name },
        goldPer: { dps, xp, profit },
        economics: { repayHours },
    });

    test('awards descending points and sums them into a score', () => {
        const rows = [row('best', 1, 1, 1, 1), row('second', 2, 2, 2, 2)];
        assignRankScores(rows);

        // Four metrics, first place in each
        expect(rows[0].score).toBe(RANK_PLACES * 4);
        expect(rows[1].score).toBe((RANK_PLACES - 1) * 4);
        expect(rows[0].rankPoints.dps).toMatchObject({ place: 1, points: RANK_PLACES });
    });

    test('an all-rounder can outscore a single-column winner', () => {
        const rows = [
            row('spiky', 1, 900, 900, 900), // wins DPS outright, last everywhere else
            row('rounded', 2, 2, 2, 2), // second in all four
        ];
        assignRankScores(rows);

        expect(rows[1].score).toBeGreaterThan(rows[0].score);
    });

    test('ties share a placing rather than being split by list order', () => {
        const rows = [row('a', 5, 5, 5, 5), row('b', 5, 5, 5, 5)];
        assignRankScores(rows);

        expect(rows[0].score).toBe(rows[1].score);
        expect(rows[0].rankPoints.dps.place).toBe(1);
        expect(rows[1].rankPoints.dps.place).toBe(1);
    });

    test('unmeasurable metrics score nothing instead of ranking last', () => {
        const rows = [row('known', 1, 1, 1, 1), row('unknown', Infinity, Infinity, Infinity, Infinity)];
        assignRankScores(rows);

        expect(rows[1].score).toBe(0);
        expect(rows[1].rankPoints).toEqual({});
    });

    test('only the top placings earn points', () => {
        const rows = Array.from({ length: RANK_PLACES + 3 }, (_, i) => row(`r${i}`, i + 1, i + 1, i + 1, i + 1));
        assignRankScores(rows);

        expect(rows[RANK_PLACES - 1].score).toBe(4); // last scoring place, 1 point per metric
        expect(rows[RANK_PLACES].score).toBe(0);
    });
});

describe('ROI and configurable scoring', () => {
    const base = { profitPerHour: 1000 };

    test('ROI annualises the profit gain against the outlay', () => {
        // 500/hr extra on a 10,000 outlay = 4,380,000 a year = 43,800%
        const e = computeEconomics(10_000, base, { profitPerHour: 1500 });
        expect(e.roiAnnualPct).toBeCloseTo(43_800, 5);
    });

    test('ROI is unknown rather than zero when the cost is unknown', () => {
        expect(computeEconomics(null, base, { profitPerHour: 1500 }).roiAnnualPct).toBeNull();
    });

    test('ROI ranks identically to repay time, which is why scoring both double-counts', () => {
        const rows = [10_000, 50_000, 25_000].map((cost) => computeEconomics(cost, base, { profitPerHour: 1500 }));

        const byRepay = [...rows].sort((a, b) => a.repayHours - b.repayHours);
        const byRoi = [...rows].sort((a, b) => b.roiAnnualPct - a.roiAnnualPct);
        expect(byRoi).toEqual(byRepay);
    });

    test('only the selected metrics contribute to the score', () => {
        const row = (dps, xp) => ({
            candidate: {},
            goldPer: { dps, xp, profit: Infinity, encounters: Infinity, deaths: Infinity },
            economics: { repayHours: Infinity, roiAnnualPct: null },
        });
        const rows = [row(1, 900), row(900, 1)];

        assignRankScores(rows, { keys: ['dps'] });
        expect(rows[0].score).toBe(RANK_PLACES);
        expect(rows[1].score).toBe(RANK_PLACES - 1);
        expect(rows[0].rankPoints.xp).toBeUndefined();

        // Scoring the other metric alone flips the order
        assignRankScores(rows, { keys: ['xp'] });
        expect(rows[1].score).toBe(RANK_PLACES);
    });

    test('higher-is-better metrics rank downward', () => {
        const row = (roi) => ({ candidate: {}, goldPer: {}, economics: { roiAnnualPct: roi } });
        const rows = [row(100), row(900)];

        assignRankScores(rows, { keys: ['roi'] });
        expect(rows[1].score).toBe(RANK_PLACES); // the bigger return places first
        expect(rows[0].score).toBe(RANK_PLACES - 1);
    });

    test('an empty selection scores nothing rather than throwing', () => {
        const rows = [{ candidate: {}, goldPer: { dps: 1 }, economics: { repayHours: 1 } }];
        assignRankScores(rows, { keys: [] });
        expect(rows[0].score).toBe(0);
    });

    test('every default score key is a real metric, and ROI is not among them', () => {
        const known = SCORE_METRICS.map((m) => m.key);
        for (const key of DEFAULT_SCORE_KEYS) expect(known).toContain(key);
        expect(DEFAULT_SCORE_KEYS).not.toContain('roi');
    });
});

describe('default score selection', () => {
    test('counts every gold-per metric plus repay, and not ROI', () => {
        expect([...DEFAULT_SCORE_KEYS].sort()).toEqual(['deaths', 'dps', 'encounters', 'profit', 'repay', 'xp'].sort());
    });

    test('the Time column is not among the scored metrics', () => {
        // It is cost divided by a constant, so it duplicates Cost exactly
        expect(SCORE_METRICS.map((m) => m.key)).not.toContain('payback');
    });
});

describe('applying one candidate to a player', () => {
    const player = () => ({
        hrid: '/players/me',
        magicLevel: 100,
        abilities: [{ hrid: '/abilities/fierce_aura', level: 10, triggers: ['keep me'] }, null, null, null, null],
        equipment: { '/equipment_types/head': { hrid: '/items/hat', enhancementLevel: 2 } },
    });

    test('a piece of equipment lands in its slot', () => {
        const dto = applyCandidateToDTO(player(), {
            slot: '/equipment_types/head',
            upgradeHrid: '/items/better_hat',
            upgradeLevel: 5,
            type: 'enhancement',
        });

        expect(dto.equipment['/equipment_types/head']).toEqual({ hrid: '/items/better_hat', enhancementLevel: 5 });
    });

    test('levelling the ability already slotted keeps its triggers', () => {
        // They were configured on purpose; a level-up is not a reason to lose them
        const dto = applyCandidateToDTO(player(), {
            slot: 'ability_0',
            upgradeHrid: '/abilities/fierce_aura',
            upgradeLevel: 25,
        });

        expect(dto.abilities[0]).toMatchObject({ level: 25, triggers: ['keep me'] });
    });

    test('swapping in a different one does not inherit them', () => {
        const dto = applyCandidateToDTO(player(), {
            slot: 'ability_0',
            upgradeHrid: '/abilities/critical_aura',
            upgradeLevel: 20,
        });

        expect(dto.abilities[0]).toEqual({ hrid: '/abilities/critical_aura', level: 20, triggers: null });
    });

    test('a combat level sets the skill', () => {
        const dto = applyCandidateToDTO(player(), {
            type: 'combat_level',
            skillKey: 'magicLevel',
            upgradeLevel: 110,
        });

        expect(dto.magicLevel).toBe(110);
    });

    test('a house room raises the room, and touches no equipment slot', () => {
        // Without a branch of its own it fell through to the equipment write at
        // the bottom, storing the room under a slot named after it: the
        // character simulated completely unchanged, and every house row came
        // back a confident +0.00%
        const dto = applyCandidateToDTO(
            { ...player(), houseRooms: { '/house_rooms/dairy_barn': 3 } },
            {
                type: 'house',
                slot: 'house|/house_rooms/dairy_barn',
                roomHrid: '/house_rooms/dairy_barn',
                currentLevel: 3,
                upgradeLevel: 4,
            }
        );

        expect(dto.houseRooms['/house_rooms/dairy_barn']).toBe(4);
        expect(Object.keys(dto.equipment)).toEqual(['/equipment_types/head']);
        expect(dto.equipment['/equipment_types/head']).toEqual({ hrid: '/items/hat', enhancementLevel: 2 });
    });

    test('a room the character has never built starts from nothing', () => {
        const dto = applyCandidateToDTO(player(), {
            type: 'house',
            roomHrid: '/house_rooms/observatory',
            currentLevel: 0,
            upgradeLevel: 1,
        });

        expect(dto.houseRooms).toEqual({ '/house_rooms/observatory': 1 });
    });

    test('and the player it was given is never touched', () => {
        // A dozen candidates measured against a DTO carrying the last one's
        // change would each be measuring the pile rather than the piece
        const original = player();
        applyCandidateToDTO(original, {
            slot: '/equipment_types/head',
            upgradeHrid: '/items/better_hat',
            upgradeLevel: 5,
        });

        expect(original.equipment['/equipment_types/head'].hrid).toBe('/items/hat');
    });
});

describe('guild shrine candidates', () => {
    const FORCE = {
        hrid: '/guild_buffs/force_combat',
        shrineHrid: '/guild_shrines/force',
        isCombat: true,
        buffs: [{ typeHrid: '/buff_types/damage', ratioBoost: 0.003, ratioBoostLevelBonus: 0.003 }],
        levelCosts: {
            4: { guildTokenCost: 40, creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 30 }] },
            5: { guildTokenCost: 50, creditCosts: [] },
        },
    };
    const RARITY_SKILLING = {
        hrid: '/guild_buffs/rarity_skilling',
        shrineHrid: '/guild_shrines/rarity',
        isCombat: false,
        buffs: [{ typeHrid: '/buff_types/rare_find', flatBoost: 0.01, flatBoostLevelBonus: 0.01 }],
        levelCosts: { 1: { guildTokenCost: 10, creditCosts: [] } },
    };
    const FORCE_SKILLING = {
        hrid: '/guild_buffs/force_skilling',
        shrineHrid: '/guild_shrines/force',
        isCombat: false,
        buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.002, flatBoostLevelBonus: 0.002 }],
        levelCosts: { 1: { guildTokenCost: 10, creditCosts: [] } },
    };

    beforeEach(() => {
        guild.detailMap = {
            '/guild_buffs/force_combat': FORCE,
            '/guild_buffs/rarity_skilling': RARITY_SKILLING,
            '/guild_buffs/force_skilling': FORCE_SKILLING,
        };
        guild.shrineLevels = {};
        guild.applied = [];
        // No exchange rate is the default state; the tests about token pricing
        // set one for themselves
        token.goldPerToken = null;
    });

    test('one level up from where the character is', () => {
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);

        expect(candidate).toMatchObject({
            type: 'guild_shrine',
            buffHrid: '/guild_buffs/force_combat',
            currentLevel: 3,
            upgradeLevel: 4,
            guildTokenCost: 40,
            description: 'Force Shrine Lv3 → Lv4',
        });
    });

    test('nothing past the top of the cost table', () => {
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 5 } };
        expect(generateGuildShrineCandidates(dto)).toEqual([]);
    });

    describe('a target level', () => {
        test('buys every level up to it, and charges for all of them', () => {
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [candidate] = generateGuildShrineCandidates(dto, { targetLevel: 5 });

            expect(candidate).toMatchObject({
                currentLevel: 3,
                upgradeLevel: 5,
                levelsBought: 2,
                // 40 for Lv4 plus 50 for Lv5, not just the last one
                guildTokenCost: 90,
                description: 'Force Shrine Lv3 → Lv5',
            });
            expect(candidate.creditCosts).toEqual([{ itemHrid: '/items/guild_credit_1', count: 30 }]);
        });

        test('the benefit is measured at the target, so that is the level applied', () => {
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [candidate] = generateGuildShrineCandidates(dto, { targetLevel: 5 });
            applyCandidateToDTO({ equipment: {}, guildShrineLevels: {}, guildCombatBuffs: [] }, candidate);

            expect(guild.applied).toEqual([{ hrid: '/guild_buffs/force_combat', level: 5 }]);
        });

        test('is clamped to the top of the cost table rather than dropping the shrine', () => {
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [candidate] = generateGuildShrineCandidates(dto, { targetLevel: 40 });

            expect(candidate.upgradeLevel).toBe(5);
        });

        test('skips a buff already at or past it instead of offering a no-op', () => {
            // One number typed once, against shrines sitting at different levels
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 4 } };

            expect(generateGuildShrineCandidates(dto, { targetLevel: 4 })).toEqual([]);
            expect(generateGuildShrineCandidates(dto, { targetLevel: 3 })).toEqual([]);
        });

        test('the cap warning still reads off the guild building, not the target', () => {
            guild.shrineLevels['/guild_shrines/force'] = 4;
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [candidate] = generateGuildShrineCandidates(dto, { targetLevel: 5 });

            expect(candidate.needsShrineLevel).toBe(5);
            expect(candidate.shrineLevelKnown).toBe(true);
        });

        test('costs the whole span in gold, so the ranking is not the last level only', () => {
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [oneUp] = generateGuildShrineCandidates(dto);
            const [toTop] = generateGuildShrineCandidates(dto, { targetLevel: 5 });

            expect(calculateUpgradeCost(oneUp, buildGameData())).toBe(3000);
            // Lv5 adds tokens but no credits, so the gold half is unchanged —
            // and the token count is what grew
            expect(calculateUpgradeCost(toTop, buildGameData())).toBe(3000);
            expect(toTop.guildTokenCost).toBeGreaterThan(oneUp.guildTokenCost);
        });

        test('reaches the shrine set through generateCandidates', () => {
            const dto = { equipment: {}, guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
            const [candidate] = generateCandidates(
                dto,
                buildGameData(),
                'guild_shrine',
                0,
                'increment',
                false,
                null,
                null,
                0,
                null,
                null,
                5
            );

            expect(candidate.upgradeLevel).toBe(5);
        });

        test('left unset, every caller still gets the single level it always got', () => {
            const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };

            expect(generateGuildShrineCandidates(dto, { targetLevel: 0 })[0].upgradeLevel).toBe(4);
            expect(generateGuildShrineCandidates(dto)[0].upgradeLevel).toBe(4);
        });
    });

    /**
     * One Lv box across five shrines sitting at five different levels is the
     * same complaint the House grid answered: the number that is a two-level
     * purchase for one shrine is a no-op for the next. These are the House
     * grid's semantics, which is the point — the two grids must mean the same
     * thing by a blank box or neither can be trusted.
     */
    describe('per-shrine targets', () => {
        const AEGIS = {
            hrid: '/guild_buffs/aegis_combat',
            shrineHrid: '/guild_shrines/aegis',
            isCombat: true,
            buffs: [{ typeHrid: '/buff_types/armor', flatBoost: 1, flatBoostLevelBonus: 1 }],
            levelCosts: {
                2: { guildTokenCost: 20, creditCosts: [] },
                3: { guildTokenCost: 30, creditCosts: [] },
                4: { guildTokenCost: 40, creditCosts: [] },
            },
        };

        beforeEach(() => {
            guild.detailMap['/guild_buffs/aegis_combat'] = AEGIS;
        });

        const dto = () => ({
            guildShrineLevels: { '/guild_buffs/force_combat': 3, '/guild_buffs/aegis_combat': 1 },
        });

        test('each shrine gets the level its own box asks for', () => {
            const byHrid = Object.fromEntries(
                generateGuildShrineCandidates(dto(), {
                    perBuffTargets: { '/guild_buffs/force_combat': 5, '/guild_buffs/aegis_combat': 3 },
                }).map((candidate) => [candidate.buffHrid, candidate])
            );

            expect(byHrid['/guild_buffs/force_combat'].upgradeLevel).toBe(5);
            expect(byHrid['/guild_buffs/aegis_combat'].upgradeLevel).toBe(3);
            expect(byHrid['/guild_buffs/aegis_combat'].levelsBought).toBe(2);
        });

        test('a shrine the grid does not name is left out — a blank box means skip', () => {
            const hrids = generateGuildShrineCandidates(dto(), {
                perBuffTargets: { '/guild_buffs/aegis_combat': 3 },
            }).map((candidate) => candidate.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/aegis_combat']);
        });

        test('and one named at or below where it already is, the same way', () => {
            expect(
                generateGuildShrineCandidates(dto(), { perBuffTargets: { '/guild_buffs/force_combat': 3 } })
            ).toEqual([]);
        });

        test('the grid wins over the single Lv box while it is open', () => {
            const hrids = generateGuildShrineCandidates(dto(), {
                targetLevel: 5,
                perBuffTargets: { '/guild_buffs/aegis_combat': 4 },
            }).map((candidate) => candidate.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/aegis_combat']);
        });

        test('an explicit 0 drops that shrine from the run', () => {
            const hrids = generateGuildShrineCandidates(dto(), {
                perBuffTargets: { '/guild_buffs/force_combat': 0, '/guild_buffs/aegis_combat': 3 },
            }).map((candidate) => candidate.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/aegis_combat']);
        });

        test('a negative target — a blank box in the grid — steps that shrine one level', () => {
            const byHrid = Object.fromEntries(
                generateGuildShrineCandidates(dto(), {
                    perBuffTargets: { '/guild_buffs/force_combat': -1, '/guild_buffs/aegis_combat': 3 },
                }).map((candidate) => [candidate.buffHrid, candidate])
            );

            expect(byHrid['/guild_buffs/force_combat'].upgradeLevel).toBe(4);
            expect(byHrid['/guild_buffs/force_combat'].levelsBought).toBe(1);
            expect(byHrid['/guild_buffs/aegis_combat'].upgradeLevel).toBe(3);
        });

        test('a target past the cost table is clamped rather than priced off the end', () => {
            const [candidate] = generateGuildShrineCandidates(dto(), {
                perBuffTargets: { '/guild_buffs/aegis_combat': 40 },
            });

            expect(candidate.upgradeLevel).toBe(4);
        });

        test('and the whole map reaches the set through generateCandidates', () => {
            const hrids = generateCandidates(
                { equipment: {}, ...dto() },
                buildGameData(),
                'guild_shrine',
                0,
                'increment',
                false,
                null,
                null,
                0,
                null,
                null,
                0,
                { guildShrineTargets: { '/guild_buffs/aegis_combat': 4 } }
            ).map((candidate) => candidate.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/aegis_combat']);
        });
    });

    /**
     * The cap and the per-shrine targets are two halves of one decision, read off
     * the same `options` bag by `generateCandidates`. They went out of step once:
     * `runUpgradeAnalysis` forwarded both, while the two labyrinth wrappers
     * forwarded only the targets — so Lab Sim's checkbox was drawn, saved and
     * restored while the table still ranked shrine levels the guild cannot sell.
     * Nothing about that is visible in a result, since the uncapped rows look like
     * ordinary rows, so this pins the two together at the source rather than at a
     * figure.
     */
    describe('the guild cap travels with the per-shrine targets', () => {
        const source = readFileSync(new URL('./upgrade-advisor.js', import.meta.url), 'utf8');
        const sourceLines = source.split(/\r?\n/).filter((line) => !/^\s*\*/.test(line));

        test('every analysis entry point that takes targets also takes the cap', () => {
            const takesTargets = sourceLines.filter((line) => /^\s*guildShrineTargets = null,$/.test(line));
            const takesCap = sourceLines.filter((line) => /^\s*guildShrineCapToGuild = false,$/.test(line));

            expect(takesTargets.length).toBeGreaterThanOrEqual(3);
            expect(takesCap.length).toBe(takesTargets.length);
        });

        test('every options bag that forwards targets also forwards the cap', () => {
            const forwarding = sourceLines
                .filter((line) => /guildShrineTargets/.test(line))
                .filter((line) => !/perBuffTargets/.test(line))
                .filter((line) => !/guildShrineTargets = null,/.test(line));

            expect(forwarding.length).toBeGreaterThanOrEqual(3);
            for (const line of forwarding) {
                expect(line, `forwards targets without the cap: ${line.trim()}`).toMatch(/guildShrineCapToGuild/);
            }
        });
    });

    describe('capped to what the guild built', () => {
        const AEGIS = {
            hrid: '/guild_buffs/aegis_combat',
            shrineHrid: '/guild_shrines/aegis',
            isCombat: true,
            buffs: [{ typeHrid: '/buff_types/armor', flatBoost: 1, flatBoostLevelBonus: 1 }],
            levelCosts: {
                1: { guildTokenCost: 10, creditCosts: [] },
                2: { guildTokenCost: 20, creditCosts: [] },
                3: { guildTokenCost: 30, creditCosts: [] },
            },
        };

        beforeEach(() => {
            guild.detailMap['/guild_buffs/aegis_combat'] = AEGIS;
        });

        const dto = () => ({
            guildShrineLevels: { '/guild_buffs/force_combat': 3, '/guild_buffs/aegis_combat': 0 },
        });

        test('a shrine the guild has not built at all is left out', () => {
            guild.shrineLevels['/guild_shrines/force'] = 5;

            const hrids = generateGuildShrineCandidates(dto(), { capToGuildLevel: true }).map((c) => c.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/force_combat']);
        });

        test('and a target above the building level stops at it', () => {
            guild.shrineLevels['/guild_shrines/force'] = 4;

            const [candidate] = generateGuildShrineCandidates(dto(), {
                capToGuildLevel: true,
                perBuffTargets: { '/guild_buffs/force_combat': 5 },
            });

            expect(candidate.upgradeLevel).toBe(4);
            expect(candidate.needsShrineLevel).toBeNull();
        });

        test('a shrine already at its guild-allowed level offers nothing', () => {
            guild.shrineLevels['/guild_shrines/force'] = 3;
            guild.shrineLevels['/guild_shrines/aegis'] = 2;

            const hrids = generateGuildShrineCandidates(dto(), { capToGuildLevel: true }).map((c) => c.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/aegis_combat']);
        });

        test('unchecked, the unbuilt shrine comes back with its needs-a-level note', () => {
            guild.shrineLevels['/guild_shrines/force'] = 3;

            const byHrid = Object.fromEntries(
                generateGuildShrineCandidates(dto()).map((candidate) => [candidate.buffHrid, candidate])
            );

            expect(byHrid['/guild_buffs/aegis_combat']).toBeDefined();
            expect(byHrid['/guild_buffs/force_combat'].needsShrineLevel).toBe(4);
        });

        test('no guild building data at all is unknown, not a cap that empties the table', () => {
            // Every shrine reads 0 when nothing reached the client; capping on
            // that would silently drop every row
            const hrids = generateGuildShrineCandidates(dto(), { capToGuildLevel: true }).map((c) => c.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/force_combat', '/guild_buffs/aegis_combat']);
        });

        test('a guild that built only skilling shrines is still capped on the combat side', () => {
            // The "nothing arrived" valve has to read every shrine, not the half
            // in scope: a real guild that has built the Rarity Shrine and no
            // combat shrine reads 0 across the combat set, and taking that for
            // missing data hands the table back the "Lv0 → Lv1 in a shrine nobody
            // built" row the cap exists to remove — with the guild's own data on
            // screen the whole time
            guild.shrineLevels['/guild_shrines/rarity'] = 3;

            expect(generateGuildShrineCandidates(dto(), { capToGuildLevel: true })).toEqual([]);
        });

        test('and the flag reaches the set through generateCandidates', () => {
            guild.shrineLevels['/guild_shrines/force'] = 5;

            const hrids = generateCandidates(
                { equipment: {}, ...dto() },
                buildGameData(),
                'guild_shrine',
                0,
                'increment',
                false,
                null,
                null,
                0,
                null,
                null,
                0,
                { guildShrineCapToGuild: true }
            ).map((candidate) => candidate.buffHrid);

            expect(hrids).toEqual(['/guild_buffs/force_combat']);
        });
    });

    test('a player whose guild we know nothing about gets no candidates', () => {
        // Not the same as a guildless character: an imported DTO simply carries
        // no shrine levels, and guessing zero would invent a purchase for them
        expect(generateGuildShrineCandidates({})).toEqual([]);
    });

    test('a level past what the guild has built is still offered, and says so', () => {
        guild.shrineLevels['/guild_shrines/force'] = 3;
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);

        expect(candidate.needsShrineLevel).toBe(4);
        expect(candidate.shrineLevelKnown).toBe(true);
    });

    test('a shrine level that never reached the client is unknown, not a cap', () => {
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);

        expect(candidate.needsShrineLevel).toBeNull();
        expect(candidate.shrineLevelKnown).toBe(false);
    });

    test('skilling candidates cover only buffs the clear-rate metrics can measure', () => {
        const dto = { guildShrineLevels: {} };
        const hrids = generateGuildShrineCandidates(dto, { combat: false }).map((c) => c.buffHrid);

        // Rare find changes a run and changes none of the numbers reported, so a
        // row for it could only ever read 0.00%
        expect(hrids).toEqual(['/guild_buffs/force_skilling']);
    });

    test('with no exchange rate for tokens, cost is the credit gold and says so', () => {
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);

        expect(calculateUpgradeCost(candidate, buildGameData())).toBe(3000);

        const detail = explainUpgradeCost(candidate, buildGameData());
        expect(detail.guild).toMatchObject({ tokens: 40, shrineName: 'Force', tokenGold: null, creditGold: 3000 });
        expect(detail.net).toBe(3000);
        expect(detail.guild.rankedNote).toContain('credit half only');
    });

    test('a priced token is folded into the cost, with both halves still reported', () => {
        token.goldPerToken = 50;
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);

        // 30 credits at 100 each, plus 40 tokens at 50 each
        expect(calculateUpgradeCost(candidate, buildGameData())).toBe(5000);

        const detail = explainUpgradeCost(candidate, buildGameData());
        expect(detail.guild).toMatchObject({ tokens: 40, creditGold: 3000, tokenGold: 2000, goldPerToken: 50 });
        expect(detail.guild.tokenNote).toContain('via credit exchange');
        expect(detail.guild.rankedNote).toContain('credits plus tokens');
        expect(detail.net).toBe(5000);
    });

    test('an unpriced credit stays unknown rather than being rescued by the token half', () => {
        token.goldPerToken = 50;
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);
        candidate.creditCosts = [{ itemHrid: '/items/unpriced_credit', count: 5 }];

        expect(calculateUpgradeCost(candidate, buildGameData())).toBeNull();
    });

    test('the ranking flips when the token half is the larger one', () => {
        // Two levels a player could buy: one cheap in credits and enormously
        // expensive in tokens, one the other way round. Ranked on credits alone
        // the first wins; ranked on what it actually costs, it does not
        const tokenHeavy = {
            type: 'guild_shrine',
            guildTokenCost: 1000,
            creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 10 }],
        };
        const creditHeavy = {
            type: 'guild_shrine',
            guildTokenCost: 1,
            creditCosts: [{ itemHrid: '/items/guild_credit_1', count: 30 }],
        };
        const cheaper = () =>
            calculateUpgradeCost(tokenHeavy, buildGameData()) < calculateUpgradeCost(creditHeavy, buildGameData())
                ? 'tokenHeavy'
                : 'creditHeavy';

        token.goldPerToken = null;
        expect(cheaper()).toBe('tokenHeavy');

        token.goldPerToken = 50;
        expect(cheaper()).toBe('creditHeavy');
    });

    test('an unpriced credit leaves the cost unknown rather than free', () => {
        const dto = { guildShrineLevels: { '/guild_buffs/force_combat': 3 } };
        const [candidate] = generateGuildShrineCandidates(dto);
        candidate.creditCosts = [{ itemHrid: '/items/unpriced_credit', count: 5 }];

        expect(calculateUpgradeCost(candidate, buildGameData())).toBeNull();
    });

    test('applying one moves the level and rebuilds the combat buffs behind it', () => {
        const dto = applyCandidateToDTO(
            { equipment: {}, guildShrineLevels: { '/guild_buffs/force_combat': 3 }, guildCombatBuffs: [] },
            {
                type: 'guild_shrine',
                buffHrid: '/guild_buffs/force_combat',
                upgradeLevel: 4,
            }
        );

        expect(dto.guildShrineLevels['/guild_buffs/force_combat']).toBe(4);
        expect(guild.applied).toEqual([{ hrid: '/guild_buffs/force_combat', level: 4 }]);
        expect(dto.guildCombatBuffs).toEqual([{ typeHrid: '/buff_types/damage', level: 4 }]);
    });

    test('a skilling shrine moves the level and leaves the combat buffs alone', () => {
        const dto = applyCandidateToDTO(
            { equipment: {}, guildShrineLevels: {}, guildCombatBuffs: [{ typeHrid: '/buff_types/damage' }] },
            {
                type: 'guild_shrine',
                buffHrid: '/guild_buffs/force_skilling',
                upgradeLevel: 1,
            }
        );

        expect(dto.guildShrineLevels['/guild_buffs/force_skilling']).toBe(1);
        expect(guild.applied).toEqual([]);
        expect(dto.guildCombatBuffs).toEqual([{ typeHrid: '/buff_types/damage' }]);
    });

    test('the shrine level is one purchase, so the plan never buys two of it', () => {
        expect(conflictKey({ type: 'guild_shrine', buffHrid: '/guild_buffs/force_combat' })).toBe(
            'guild:/guild_buffs/force_combat'
        );
    });
});

describe('how much of a combat delta is measurement', () => {
    const run = (encounters, deaths) => ({ encounters, deaths: { player1: deaths } });

    test('a bigger sample is a smaller error', () => {
        const few = rateDeltaNoisePct(run(100, 2), run(100, 2), 'player1');
        const many = rateDeltaNoisePct(run(10_000, 2), run(10_000, 2), 'player1');

        expect(many.dps).toBeLessThan(few.dps);
        expect(many.dps).toBeCloseTo(Math.sqrt(2 / 10_000) * 100, 6);
    });

    test('both runs contribute, added in quadrature', () => {
        const noise = rateDeltaNoisePct(run(400, 1), run(100, 1), 'player1');

        expect(noise.profit).toBeCloseTo(Math.sqrt(1 / 400 + 1 / 100) * 100, 6);
    });

    test('deaths are counted, not summed, so a handful of them is enormous', () => {
        const noise = rateDeltaNoisePct(run(5_000, 2), run(5_000, 2), 'player1');

        expect(noise.deaths).toBeGreaterThan(noise.dps * 10);
    });

    test('a run with no deaths at all does not divide by zero', () => {
        const noise = rateDeltaNoisePct(run(5_000, 0), run(5_000, 0), 'player1');

        expect(Number.isFinite(noise.deaths)).toBe(true);
    });

    test('a gain inside the error is not a gain', () => {
        const noise = { dps: 2, profit: 2 };
        const verdict = significantDeltas({ dps: 1.5, profit: 9 }, noise);

        expect(verdict.dps).toBe(false);
        expect(verdict.profit).toBe(true);
    });

    test('an unmeasurable error leaves the delta believed rather than discarded', () => {
        expect(significantDeltas({ dps: 0.1 }, {}).dps).toBe(true);
    });
});

describe('an upgrade that pays for itself', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('costs less than nothing rather than being floored at free', () => {
        getItemPrices.mockReturnValue({ ask: 10_000_000, bid: 9_000_000 });
        resolveItemPrice.mockImplementation((hrid, { side }) =>
            side === 'sell' ? { price: 50_000_000 } : { price: 10_000_000 }
        );

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/regal_sword_refined',
                currentLevel: 10,
                upgradeHrid: '/items/fine_sword',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBe(-40_000_000);
    });

    test('an enhancement whose target level sells for more than the current one, too', () => {
        getItemPrices.mockImplementation((hrid, level) =>
            level === 10 ? { ask: 1_000_000, bid: 900_000 } : { ask: 5_000_000, bid: 4_000_000 }
        );

        const cost = calculateUpgradeCost(
            {
                type: 'enhancement',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 7,
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBe(1_000_000 - 4_000_000);
    });

    test('the budget planner spends it rather than discarding it as malformed', () => {
        const refunding = {
            candidate: { type: 'tier', slot: '/equipment_types/head', upgradeHrid: '/items/a' },
            cost: -50,
            attemptsDelta: -1,
            significant: true,
        };
        const plan = planWithinBudget([refunding], 10);

        expect(plan.picks).toHaveLength(1);
        expect(plan.totalCost).toBe(-50);
    });

    test('and the bigger refund is taken first, not the one with the thinnest gain', () => {
        const entry = (hrid, slot, cost, attemptsDelta) => ({
            candidate: { type: 'tier', slot, upgradeHrid: hrid },
            cost,
            attemptsDelta,
            significant: true,
        });
        const plan = planWithinBudget(
            [
                entry('/items/small', '/equipment_types/head', -10, -0.01),
                entry('/items/big', '/equipment_types/feet', -900, -5),
            ],
            0
        );

        expect(plan.picks[0].candidate.upgradeHrid).toBe('/items/big');
    });
});

describe('drink candidates', () => {
    const COFFEE_FAMILY = '/buff_uniques/power_coffee';

    function drinkGameData() {
        const coffee = (hrid, name, itemLevel, family = COFFEE_FAMILY) => [
            hrid,
            {
                name,
                itemLevel,
                categoryHrid: '/item_categories/drink',
                consumableDetail: {
                    hitpointRestore: 0,
                    manapointRestore: 0,
                    cooldownDuration: 300,
                    buffs: [{ uniqueHrid: family, typeHrid: '/buff_types/damage', flatBoost: 0.05 }],
                    defaultCombatTriggers: [{ dependencyHrid: '/combat_trigger_dependencies/self' }],
                },
            },
        ];
        return {
            itemDetailMap: Object.fromEntries([
                coffee('/items/power_coffee', 'Power Coffee', 20),
                coffee('/items/super_power_coffee', 'Super Power Coffee', 50),
                coffee('/items/ultra_power_coffee', 'Ultra Power Coffee', 80),
                coffee('/items/wisdom_coffee', 'Wisdom Coffee', 30, '/buff_uniques/wisdom_coffee'),
                // Restores hitpoints, so it belongs to the food search, not here
                [
                    '/items/healing_tea',
                    {
                        name: 'Healing Tea',
                        itemLevel: 10,
                        categoryHrid: '/item_categories/drink',
                        consumableDetail: {
                            hitpointRestore: 100,
                            cooldownDuration: 10,
                            buffs: [{ uniqueHrid: '/buff_uniques/tea', typeHrid: '/buff_types/damage' }],
                        },
                    },
                ],
            ]),
        };
    }

    beforeEach(() => {
        resolveItemPrice.mockImplementation(() => ({ price: 1000 }));
    });

    test('walks one tier up in a family already being drunk', () => {
        const player = { drinks: [{ hrid: '/items/power_coffee' }, null, null] };
        const candidates = generateDrinkCandidates(player, drinkGameData());
        const tierUp = candidates.find((c) => c.currentHrid === '/items/power_coffee');

        expect(tierUp.upgradeHrid).toBe('/items/super_power_coffee');
        expect(tierUp.description).toBe('Power Coffee → Super Power Coffee');
        expect(tierUp.drinkIndex).toBe(0);
    });

    test('offers the best of a family you run none of, into the free slot', () => {
        const player = { drinks: [{ hrid: '/items/power_coffee' }, null, null] };
        const candidates = generateDrinkCandidates(player, drinkGameData());
        const added = candidates.find((c) => c.currentHrid === null);

        expect(added.upgradeHrid).toBe('/items/wisdom_coffee');
        expect(added.drinkIndex).toBe(1);
        expect(added.description).toBe('Add Wisdom Coffee');
    });

    test('a family at its top tier has nothing to offer', () => {
        const player = { drinks: [{ hrid: '/items/ultra_power_coffee' }, null, null] };
        const candidates = generateDrinkCandidates(player, drinkGameData());

        expect(candidates.some((c) => c.buffFamily === COFFEE_FAMILY)).toBe(false);
    });

    test('nothing new is offered with every slot full', () => {
        const player = {
            drinks: [{ hrid: '/items/ultra_power_coffee' }, { hrid: '/items/wisdom_coffee' }, { hrid: '/items/x' }],
        };

        expect(generateDrinkCandidates(player, drinkGameData())).toEqual([]);
    });

    test('a drink that restores hitpoints is the food search, not this', () => {
        const player = { drinks: [null, null, null] };
        const candidates = generateDrinkCandidates(player, drinkGameData());

        expect(candidates.some((c) => c.upgradeHrid === '/items/healing_tea')).toBe(false);
    });

    test('cost is zero, because the hourly spend is already in Profit/hr', () => {
        expect(calculateUpgradeCost({ type: 'drink', upgradeHrid: '/items/x' }, drinkGameData())).toBe(0);
    });

    test('two coffees of one family conflict, whichever slots they sit in', () => {
        expect(conflictKey({ type: 'drink', buffFamily: COFFEE_FAMILY, slot: 'drink_0' })).toBe(
            conflictKey({ type: 'drink', buffFamily: COFFEE_FAMILY, slot: 'drink_2' })
        );
    });

    test('a drink lands in its slot with the item’s own triggers', () => {
        const dto = applyCandidateToDTO(
            { drinks: [null, null, null] },
            { type: 'drink', drinkIndex: 1, upgradeHrid: '/items/wisdom_coffee', triggers: [{ value: 3 }] }
        );

        expect(dto.drinks[1]).toEqual({ hrid: '/items/wisdom_coffee', triggers: [{ value: 3 }] });
    });
});

describe('community buff candidates', () => {
    test('one level up from wherever the buff is now', () => {
        const candidates = generateCommunityBuffCandidates({ comExp: 4, comDrop: 0 });

        expect(candidates.map((c) => [c.buffKey, c.currentLevel, c.upgradeLevel])).toEqual([
            ['comExp', 4, 5],
            ['comDrop', 0, 1],
        ]);
    });

    test('the server sitting at Lv20 (Max) is not "no upgrades" — that emptied the whole set', () => {
        // 20 is the game's cap — a maxed buff reads "Level: 20 (Max)" — and both
        // buffs live there most of the time. Returning nothing for a capped buff
        // meant an analysis with only Community ticked produced zero candidates
        // and the equipment-shaped "ensure equipment is configured" message
        const candidates = generateCommunityBuffCandidates({ comExp: 20, comDrop: 20 });

        expect(candidates).toHaveLength(2);
        expect(candidates.every((c) => c.measuresLoss)).toBe(true);
        expect(candidates.every((c) => c.upgradeLevel === 0)).toBe(true);
        expect(candidates[0].description).toContain('what the buff is worth');
    });

    test('a buff below the cap still gets an ordinary one-level-up row', () => {
        const candidates = generateCommunityBuffCandidates({ comExp: 3, comDrop: 19 });

        expect(candidates.map((c) => c.upgradeLevel)).toEqual([4, 20]);
        expect(candidates.every((c) => c.measuresLoss === false)).toBe(true);
        expect(candidates[1].description).toContain('Lv19 → Lv20');
    });

    test('a level past the cap is still read as capped, not as a further upgrade', () => {
        const candidates = generateCommunityBuffCandidates({ comExp: 21, comDrop: 30 });

        expect(candidates.every((c) => c.measuresLoss)).toBe(true);
        expect(candidates.every((c) => c.upgradeLevel === 0)).toBe(true);
    });

    test('a run with only Community ticked ranks both buffs', async () => {
        buildGameDataPayload.mockReturnValue(buildGameData());
        calculateSimRevenue.mockReturnValue({ netPerHour: 0 });
        runSimulation.mockResolvedValue({
            simulatedTime: 3600 * 1e9,
            encounters: 100,
            deaths: { player1: 0 },
            totalDamageDealt: { player1: 1000 },
            experienceGained: { player1: { attack: 1000 } },
        });

        const { results } = await runUpgradeAnalysis({
            playerDTOs: [{ hrid: 'player1', equipment: {}, abilities: [], drinks: [] }],
            playerIndex: 0,
            zoneHrid: '/actions/combat/zone',
            difficultyTier: 0,
            hours: 1,
            communityBuffs: { comExp: 20, comDrop: 20 },
            upgradeModes: ['community_buff'],
        });

        expect(results.map((r) => r.candidate.buffKey).sort()).toEqual(['comDrop', 'comExp']);
    });

    test('a community buff is every fight, not a piece of gear a loadout might not wear', () => {
        // It is an argument to the simulation rather than something on the DTO,
        // so the equipment test below it answered "this loadout is not wearing
        // community_buff|comExp" and dropped the row from a multi-fight run
        expect(candidateAppliesToDTO({ type: 'community_buff', buffKey: 'comExp' }, { equipment: {} })).toBe(true);
        expect(candidateAppliesToDTO({ type: 'drink', drinkIndex: 0 }, { equipment: {} })).toBe(true);
    });

    test('unknown rather than free, so it lands in the unpriced group', () => {
        expect(calculateUpgradeCost({ type: 'community_buff', buffKey: 'comExp' }, buildGameData())).toBe(null);
    });

    test('nothing on the character changes — it is an argument to the sim', () => {
        const player = { equipment: {}, drinks: [] };
        const dto = applyCandidateToDTO(player, { type: 'community_buff', buffKey: 'comExp', upgradeLevel: 5 });

        expect(dto).toEqual(player);
    });
});

describe('scroll candidates', () => {
    test('a scroll the player is not carrying is offered as one to add', () => {
        const candidates = generateScrollCandidates({ scrollBuffs: [] });

        expect(candidates.every((c) => c.enable && !c.measuresLoss)).toBe(true);
        expect(candidates[0].description).toContain('Add');
    });

    test('a scroll already active is measured by turning it off, not read as a gain', () => {
        const candidates = generateScrollCandidates({ scrollBuffs: ['/buff_types/damage'] });
        const damage = candidates.find((c) => c.buffTypeHrid === '/buff_types/damage');

        expect(damage.enable).toBe(false);
        expect(damage.measuresLoss).toBe(true);
        expect(damage.description).toContain('what the scroll is worth');
    });

    test('every combat scroll is offered — DPS, loot and the two dual-purpose ones', () => {
        const candidates = generateScrollCandidates({ scrollBuffs: [] });
        expect(candidates.map((c) => c.buffTypeHrid)).toEqual([
            '/buff_types/damage',
            '/buff_types/attack_speed',
            '/buff_types/cast_speed',
            '/buff_types/critical_rate',
            '/buff_types/combat_drop_quantity',
            '/buff_types/wisdom',
            '/buff_types/rare_find',
        ]);
    });

    test('a scroll carries no price, so it lands in the unpriced group', () => {
        expect(calculateUpgradeCost({ type: 'scroll', buffTypeHrid: '/buff_types/damage' }, buildGameData())).toBe(
            null
        );
    });

    test('turning a scroll on writes it onto the DTO', () => {
        const dto = applyCandidateToDTO(
            { equipment: {}, drinks: [], scrollBuffs: [] },
            { type: 'scroll', buffTypeHrid: '/buff_types/rare_find', enable: true }
        );
        expect(dto.scrollBuffs).toEqual(['/buff_types/rare_find']);
    });

    test('turning a scroll off removes it from the DTO', () => {
        const dto = applyCandidateToDTO(
            { equipment: {}, drinks: [], scrollBuffs: ['/buff_types/wisdom', '/buff_types/rare_find'] },
            { type: 'scroll', buffTypeHrid: '/buff_types/wisdom', enable: false }
        );
        expect(dto.scrollBuffs).toEqual(['/buff_types/rare_find']);
    });

    test('a scroll applies to every fight, not a slot a loadout might leave empty', () => {
        expect(candidateAppliesToDTO({ type: 'scroll', buffTypeHrid: '/buff_types/wisdom' }, { equipment: {} })).toBe(
            true
        );
    });

    test('a scroll’s two answers about one buff can never both be taken', () => {
        expect(conflictKeys({ type: 'scroll', buffTypeHrid: '/buff_types/wisdom' })).toEqual([
            'scroll:/buff_types/wisdom',
        ]);
    });
});

describe('trinkets are listed, but their taskDamage stays out of the ranking', () => {
    const TRINKET = '/equipment_types/trinket';

    function trinketGameData() {
        const data = buildGameData();
        data.itemDetailMap['/items/task_badge'] = {
            name: 'Task Badge',
            itemLevel: 50,
            sortIndex: 1,
            equipmentDetail: { type: TRINKET, combatStats: { taskDamage: 0.05 } },
        };
        data.itemDetailMap['/items/task_crystal'] = {
            name: 'Task Crystal',
            itemLevel: 70,
            sortIndex: 2,
            equipmentDetail: { type: TRINKET, combatStats: { taskDamage: 0.1 } },
        };
        // Trinkets carry no offensive stat, so they classify as utility gear and
        // upgrade along the crafting chain rather than a role tier ladder
        data.actionDetailMap['/actions/crafting/task_crystal'] = {
            upgradeItemHrid: '/items/task_badge',
            outputItems: [{ itemHrid: '/items/task_crystal' }],
        };
        return data;
    }

    test('a worn trinket produces a tier candidate instead of being skipped', () => {
        const player = { equipment: { [TRINKET]: { hrid: '/items/task_badge', enhancementLevel: 0 } } };
        const candidates = generateCandidates(player, trinketGameData(), 'equipment');

        expect(candidates.some((c) => c.upgradeHrid === '/items/task_crystal')).toBe(true);
    });

    test('and every trinket row says the ranked delta excludes the task bonus', () => {
        const player = { equipment: { [TRINKET]: { hrid: '/items/task_badge', enhancementLevel: 0 } } };
        const candidates = generateCandidates(player, trinketGameData(), 'equipment');

        expect(candidates.every((c) => c.caveat?.includes('not in the ranked delta'))).toBe(true);
    });

    test('the caveat names what the stat would be worth on task', () => {
        const player = { equipment: { [TRINKET]: { hrid: '/items/task_badge', enhancementLevel: 0 } } };
        const candidates = generateCandidates(player, trinketGameData(), 'equipment');
        const tierUp = candidates.find((c) => c.upgradeHrid === '/items/task_crystal');

        // The number is the item's own taskDamage, not a simulated gain — the
        // sims behind these rows run off task, where it contributes nothing
        expect(tierUp.caveat).toContain('+10.0% task damage');
    });
});

describe('the grind time for combat levels', () => {
    test('levels bought make the grind faster, so the estimate is not one division', async () => {
        // Two identical analyses differing only in how much faster the boosted
        // run earns XP; the faster one must not simply take the same time
        const analysisFor = async (boostedXp) => {
            buildGameDataPayload.mockReturnValue({
                ...buildGameData(),
                levelExperienceTable: Array.from({ length: 40 }, (_, level) => level * 1_000_000),
            });
            calculateSimRevenue.mockReturnValue({ netPerHour: 0 });
            runSimulation.mockImplementation(async ({ playerDTOs }) => ({
                simulatedTime: 3600 * 1e9,
                encounters: 1000,
                deaths: { player1: 0 },
                totalDamageDealt: { player1: 1000 },
                experienceGained: {
                    player1: { attack: playerDTOs[0].attackLevel > 10 ? boostedXp : 100_000 },
                },
            }));

            const { results } = await runUpgradeAnalysis({
                playerDTOs: [{ hrid: 'player1', equipment: {}, abilities: [], attackLevel: 10, drinks: [] }],
                playerIndex: 0,
                zoneHrid: '/actions/combat/zone',
                difficultyTier: 0,
                hours: 1,
                communityBuffs: {},
                upgradeModes: ['combat_level'],
                abilityTargetLevel: 20,
                combatLevelTargets: { attackLevel: 30 },
            });
            return results.find((r) => r.candidate.type === 'combat_level');
        };

        const flat = await analysisFor(100_000);
        const faster = await analysisFor(400_000);

        expect(flat.levelXpSpeedup).toBeCloseTo(1, 6);
        // The same XP gap, earned at a rate that climbs to 4× — strictly faster
        // than the flat run, and strictly slower than if it were 4× throughout
        expect(faster.levelTimeHours).toBeLessThan(flat.levelTimeHours);
        expect(faster.levelTimeHours).toBeGreaterThan(flat.levelTimeHours / 4);
    });
});

describe('the XP a skilling labyrinth room pays out', () => {
    beforeEach(() => {
        clearRate.xpAskedFor = [];
        clearRate.impl = {
            getSkillingMetricsFromOverrides: (skillId) => ({ skillId }),
            computeSkillingClearWithParams: (metrics) => {
                clearRate.xpAskedFor.push(metrics.skillId);
                return { clearChance: 0.5, xpPerRoom: 1000 };
            },
            computeEnhancingClearWithParams: (metrics) => {
                clearRate.xpAskedFor.push(metrics.skillId);
                return { clearChance: 0.5, xpPerRoom: 4000 };
            },
        };
        buildGameDataPayload.mockReturnValue(buildGameData());
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
    });

    const analyse = () =>
        runSkillingUpgradeAnalysis({
            editorDTO: {
                equipment: {},
                houseRooms: {},
                tokenUpgrades: { experience: 0 },
                communityBuffLevels: {},
                enhancingLevel: 100,
                alchemyLevel: 100,
            },
            roomLevel: 100,
            crateHrids: [],
        });

    test('an enhancing room counts, now that it reports an XP figure', async () => {
        const { results } = await analyse();
        const experience = results.find((r) => r.metricType === 'xpPerRoom');

        // The skip used to leave enhancing out of the average entirely
        expect(clearRate.xpAskedFor).toContain('enhancing');
        expect(experience.xpPerRoom).toBeGreaterThan(0);
    });

    test('and it is averaged in on its own model, not the generic skilling one', async () => {
        const { results } = await analyse();
        const experience = results.find((r) => r.metricType === 'xpPerRoom');

        // Nine ordinary rooms at 1000 plus the enhancing room at 4000, over ten
        // rooms. Skipping enhancing gave 1000; averaging it in as an ordinary
        // skilling room would give 1000 too — only its own model gives 1300
        expect(experience.xpPerRoom).toBeCloseTo(1300, 6);
    });
});

/**
 * Ability swaps, once the community build guide decides what to offer.
 *
 * The old generator offered every style-compatible ability for every slot,
 * which for a fire mage meant simulating Puncture — a stab ability the build
 * cannot use, in a slot the guide has an answer for. The guide narrows the
 * question to the build the weapon says you are playing, and these tests are
 * about the three rules that narrowing has to obey: only this archetype's
 * abilities, only in place of abilities the guide did not ask for (the aura's
 * OR-half excepted), and a full fallback to the old behaviour whenever the
 * archetype cannot be read rather than a confident wrong answer.
 */
describe('guide-driven ability swaps', () => {
    const TWO_HAND_SLOT = '/equipment_types/two_hand';

    /** Every ability these tests need, as game data. Auras are special-slot. */
    const ABILITIES = {
        '/abilities/critical_aura': { name: 'Critical Aura', isSpecialAbility: true },
        '/abilities/fierce_aura': { name: 'Fierce Aura', isSpecialAbility: true },
        '/abilities/mystic_aura': { name: 'Mystic Aura', isSpecialAbility: true },
        '/abilities/invincible': { name: 'Invincible', isSpecialAbility: true },
        '/abilities/frenzy': { name: 'Frenzy' },
        '/abilities/berserk': { name: 'Berserk' },
        '/abilities/precision': { name: 'Precision' },
        '/abilities/puncture': { name: 'Puncture' },
        '/abilities/maim': { name: 'Maim' },
        '/abilities/shield_bash': { name: 'Shield Bash' },
        '/abilities/retribution': { name: 'Retribution' },
        '/abilities/toughness': { name: 'Toughness' },
        '/abilities/spikeshell': { name: 'Spikeshell' },
        '/abilities/elemental_affinity': { name: 'Elemental Affinity' },
        '/abilities/smoke_burst': { name: 'Smoke Burst' },
        '/abilities/fireball': { name: 'Fireball' },
        '/abilities/entangle': { name: 'Entangle' },
        '/abilities/smack': { name: 'Smack' },
    };

    const ITEMS = {
        '/items/blazing_trident': {
            name: 'Blazing Trident',
            equipmentDetail: {
                type: TWO_HAND_SLOT,
                combatStats: { magicDamage: 50, damageType: '/damage_types/fire' },
            },
        },
        '/items/griffin_bulwark': {
            name: 'Griffin Bulwark',
            equipmentDetail: { type: TWO_HAND_SLOT, combatStats: { smashDamage: 40 } },
        },
        '/items/furious_spear': {
            name: 'Furious Spear',
            equipmentDetail: { type: MAIN_HAND, combatStats: { stabDamage: 40 } },
        },
        '/items/driftwood_bat': {
            name: 'Driftwood Bat',
            equipmentDetail: { type: MAIN_HAND, combatStats: {} },
        },
    };

    const data = () => ({ actionDetailMap: {}, itemDetailMap: ITEMS, abilityDetailMap: ABILITIES });

    /** A loadout: one weapon in `slot`, and the ability bar as given */
    const loadout = (slot, hrid, abilities) => ({ equipment: { [slot]: { hrid } }, abilities });

    const swaps = (dto, options) =>
        generateCandidates(dto, data(), 'ability_swap', 0, 'increment', false, null, null, 0, null, null, 0, options);

    const incoming = (candidates) => [...new Set(candidates.map((c) => c.upgradeHrid))].sort();

    beforeEach(() => {
        character.characterAbilities = [];
    });

    /** A fire mage with one off-guide ability and two empty slots */
    const fireMage = () =>
        loadout(TWO_HAND_SLOT, '/items/blazing_trident', [
            { hrid: '/abilities/critical_aura', level: 20 },
            { hrid: '/abilities/elemental_affinity', level: 40 },
            { hrid: '/abilities/smack', level: 30 },
            null,
            null,
        ]);

    test('a fire mage is offered the fire set and nothing from another build', () => {
        const candidates = swaps(fireMage());

        expect(incoming(candidates)).toEqual([
            '/abilities/fireball',
            '/abilities/mystic_aura',
            '/abilities/precision',
            '/abilities/smoke_burst',
        ]);
        // Not one melee, ranged or other-element ability in sight — the old
        // generator offered all of them
        for (const stranger of ['/abilities/puncture', '/abilities/maim', '/abilities/entangle', '/abilities/frenzy']) {
            expect(incoming(candidates)).not.toContain(stranger);
        }
    });

    test('the off-guide ability is what gets replaced', () => {
        const candidates = swaps(fireMage());
        const replaced = new Set(candidates.filter((c) => c.replacesHrid).map((c) => c.replacesHrid));

        // Smack is not in the fire set, so it is the one on the way out; the
        // Elemental Affinity the guide asked for is left exactly where it is
        expect(replaced).toContain('/abilities/smack');
        expect(replaced).not.toContain('/abilities/elemental_affinity');
    });

    test('except the aura, which its OR-alternative may replace', () => {
        const candidates = swaps(fireMage());
        const auraSwap = candidates.find((c) => c.upgradeHrid === '/abilities/mystic_aura');

        // Critical Aura is on-guide, and would be untouchable under the rule
        // above — but Mystic Aura is the other half of the same OR, which is
        // the choice the guide is actually asking the player to make
        expect(auraSwap).toMatchObject({
            slot: 'ability_0',
            replacesHrid: '/abilities/critical_aura',
            upgradeLevel: 20,
        });
    });

    test('and the empty slots get filled, at the level of the book you own', () => {
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 37, experience: 0 }];
        const filled = swaps(fireMage()).filter((c) => !c.replacesHrid);

        // One candidate per ability, into the first free slot — not one per
        // ability per empty slot
        expect(filled.every((c) => c.slot === 'ability_3')).toBe(true);
        expect(incoming(filled)).toEqual(['/abilities/fireball', '/abilities/precision', '/abilities/smoke_burst']);
        const fireball = filled.find((c) => c.upgradeHrid === '/abilities/fireball');
        expect(fireball.upgradeLevel).toBe(37);
        expect(fireball.description).toBe('Empty slot → Fireball (Lv37)');
        // One you have never read is what the book would get you
        expect(filled.find((c) => c.upgradeHrid === '/abilities/precision').upgradeLevel).toBe(1);
    });

    test("an imported or party member's empty slots fill at Lv1, not the live character's book level", () => {
        // The Lv37 Fireball above belongs to whoever is actually playing. Simming
        // an imported profile or a party member with `isSelf: false` must not
        // credit them with a book they never read — the loadout guide has no way
        // to know what is in a stranger's book bag, so it can only offer what
        // buying the book fresh would get: Lv1
        character.characterAbilities = [{ abilityHrid: '/abilities/fireball', level: 37, experience: 0 }];
        const filled = swaps(fireMage(), { isSelf: false }).filter((c) => !c.replacesHrid);

        expect(filled.find((c) => c.upgradeHrid === '/abilities/fireball').upgradeLevel).toBe(1);
    });

    test('a wark gets the defensive set, not the mace set its damage type says', () => {
        const wark = loadout(TWO_HAND_SLOT, '/items/griffin_bulwark', [
            { hrid: '/abilities/invincible', level: 10 },
            { hrid: '/abilities/smack', level: 30 },
            null,
            null,
            null,
        ]);
        const candidates = swaps(wark);

        expect(incoming(candidates)).toEqual([
            '/abilities/precision',
            '/abilities/retribution',
            '/abilities/shield_bash',
            '/abilities/spikeshell',
            '/abilities/toughness',
        ]);
        // A bulwark measures as smash, and the mace build's Frenzy/Berserk/aura
        // are exactly what a wark does not run
        expect(incoming(candidates)).not.toContain('/abilities/frenzy');
        expect(incoming(candidates)).not.toContain('/abilities/critical_aura');
        // Invincible fills the special slot and is already slotted, so nothing
        // is offered against it
        expect(candidates.some((c) => c.replacesHrid === '/abilities/invincible')).toBe(false);
    });

    test('aura-only narrows to just the aura choice', () => {
        const candidates = swaps(fireMage(), { auraSwapsOnly: true });

        // Only the other aura is offered; the signature (Fireball) and the rest
        // of the guide's set are left out — aura-only is only about which aura.
        expect(incoming(candidates)).toEqual(['/abilities/mystic_aura']);
        expect(candidates.some((c) => c.replacesHrid === '/abilities/elemental_affinity')).toBe(false);
    });

    test('aura-only does not reach a wark signature — its aura slot is Invincible', () => {
        const wark = loadout(TWO_HAND_SLOT, '/items/griffin_bulwark', [
            { hrid: '/abilities/invincible', level: 10 },
            { hrid: '/abilities/smack', level: 30 },
            null,
            null,
            null,
        ]);
        // A wark's aura group is just Invincible (no OR alternative) and it is
        // equipped, so aura-only offers nothing: the signature group (Shield
        // Bash / Retribution) is no longer reached.
        expect(incoming(swaps(wark, { auraSwapsOnly: true }))).toEqual([]);
    });

    test('a loadout already running the whole guide is offered nothing at all', () => {
        const done = loadout(MAIN_HAND, '/items/furious_spear', [
            { hrid: '/abilities/fierce_aura', level: 20 },
            { hrid: '/abilities/frenzy', level: 20 },
            { hrid: '/abilities/berserk', level: 20 },
            { hrid: '/abilities/precision', level: 20 },
            { hrid: '/abilities/puncture', level: 20 },
        ]);

        // Everything but the other aura, which is the one comparison left
        expect(incoming(swaps(done))).toEqual(['/abilities/critical_aura']);
    });

    test('a slot fill goes into whichever slot the loadout it is measured against has spare', () => {
        // Pooled across a labyrinth, a fill is one decision — "start casting
        // Fireball" — measured against every loadout with room for it. The slot
        // index it was generated with belongs to one bar, and writing to it in
        // another would overwrite an ability that loadout chose on purpose
        const fill = swaps(fireMage()).find((c) => c.upgradeHrid === '/abilities/fireball' && c.fillsFreeSlot);
        expect(fill.slot).toBe('ability_3');

        const otherBar = {
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 20 },
                null,
                { hrid: '/abilities/precision', level: 10 },
                { hrid: '/abilities/smoke_burst', level: 10 },
                { hrid: '/abilities/elemental_affinity', level: 10 },
            ],
        };
        expect(candidateAppliesToDTO(fill, otherBar)).toBe(true);
        expect(applyCandidateToDTO(otherBar, fill).abilities[1]).toMatchObject({ hrid: '/abilities/fireball' });
        // And the abilities it had are all still there
        expect(applyCandidateToDTO(otherBar, fill).abilities[3].hrid).toBe('/abilities/smoke_burst');
    });

    test('and does not apply to a loadout with no room for it', () => {
        const fill = swaps(fireMage()).find((c) => c.upgradeHrid === '/abilities/fireball' && c.fillsFreeSlot);
        const fullBar = {
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 20 },
                { hrid: '/abilities/precision', level: 10 },
                { hrid: '/abilities/smoke_burst', level: 10 },
                { hrid: '/abilities/elemental_affinity', level: 10 },
                { hrid: '/abilities/smack', level: 10 },
            ],
        };
        expect(candidateAppliesToDTO(fill, fullBar)).toBe(false);
        // Nor to one already casting it
        const already = { abilities: [null, { hrid: '/abilities/fireball', level: 5 }, null, null, null] };
        expect(candidateAppliesToDTO(fill, already)).toBe(false);
    });

    test('an unreadable weapon falls all the way back to every compatible ability', () => {
        // A weapon with no damage stats places no build, and a wrong build
        // would hide the swaps that matter — so the old behaviour stands
        const unknown = loadout(MAIN_HAND, '/items/driftwood_bat', [
            { hrid: '/abilities/critical_aura', level: 20 },
            { hrid: '/abilities/smack', level: 30 },
            null,
            null,
            null,
        ]);
        const offered = incoming(swaps(unknown));

        expect(offered).toContain('/abilities/puncture');
        expect(offered).toContain('/abilities/entangle');
        expect(offered).toContain('/abilities/maim');
        // And it is genuinely everything: every non-special ability in the data
        // bar the one already slotted
        expect(offered.length).toBe(Object.keys(ABILITIES).length - 2);
    });
});

/**
 * Which house rooms a labyrinth combat table is allowed to offer.
 *
 * A lab Upgrade run showed "Mystical Study Lv2 → Lv3" with a win-rate delta
 * identical to an unrelated row's — the baseline's own sampling noise, wearing a
 * room's name. Every house room in the game grants a global experience and
 * rare-find buff just for existing, both of which the combat engine reads, so
 * `houseRoomAffectsCombat` admitted all seventeen rooms including the ten
 * skilling ones. That is the right answer for the combat sim's Upgrade tab,
 * whose table has profit and XP columns those buffs genuinely move, and the
 * wrong one for a table that ranks nothing but the share of attempts that clear.
 */
describe('house rooms a win rate can feel', () => {
    const global = (typeHrid) => ({ typeHrid });
    const scoped = (typeHrid, actionType) => ({ typeHrid, usableInActionTypeMap: { [actionType]: true } });

    // What every room carries, and what admitted the whole house
    const GLOBALS = [global('/buff_types/wisdom'), global('/buff_types/rare_find')];

    const DAIRY_BARN = {
        name: 'Dairy Barn',
        globalBuffs: GLOBALS,
        actionBuffs: [scoped('/buff_types/efficiency', '/action_types/milking')],
    };
    const ARMORY = {
        name: 'Armory',
        globalBuffs: GLOBALS,
        actionBuffs: [scoped('/buff_types/armor', '/action_types/combat')],
    };
    const XP_ONLY_COMBAT_ROOM = {
        name: 'Mystical Study',
        globalBuffs: GLOBALS,
        actionBuffs: [scoped('/buff_types/wisdom', '/action_types/combat')],
    };

    test('a skilling room is no longer admitted on the global buffs every room grants', () => {
        // The old test still holds — this is the pair that makes the point
        expect(houseRoomAffectsCombat(DAIRY_BARN)).toBe(true);
        expect(houseRoomMovesWinRate(DAIRY_BARN)).toBe(false);
    });

    test('a room granting a fighting stat is kept', () => {
        expect(houseRoomMovesWinRate(ARMORY)).toBe(true);
    });

    test('and a combat-tagged buff that only pays experience is not a fighting stat', () => {
        expect(houseRoomMovesWinRate(XP_ONLY_COMBAT_ROOM)).toBe(false);
    });

    test('loot buffs are excluded too — this table prices no drops', () => {
        for (const typeHrid of [
            '/buff_types/rare_find',
            '/buff_types/combat_drop_rate',
            '/buff_types/combat_drop_quantity',
        ]) {
            expect(houseRoomMovesWinRate({ globalBuffs: [global(typeHrid)] })).toBe(false);
        }
    });

    test('every fighting stat the engine reads keeps its room', () => {
        for (const typeHrid of [
            '/buff_types/damage',
            '/buff_types/armor',
            '/buff_types/accuracy',
            '/buff_types/evasion',
            '/buff_types/attack_speed',
            '/buff_types/cast_speed',
            '/buff_types/critical_rate',
            '/buff_types/physical_amplify',
            '/buff_types/fire_resistance',
            '/buff_types/life_steal',
            '/buff_types/hp_regen',
            '/buff_types/tenacity',
        ]) {
            expect(houseRoomMovesWinRate({ globalBuffs: [global(typeHrid)] })).toBe(true);
        }
    });

    test('a buff type this version has never heard of is kept when the game says it is combat', () => {
        // Forward compatibility in the one direction that matters: a stat added
        // next patch should show up as an upgrade, not be silently dropped
        expect(houseRoomMovesWinRate({ actionBuffs: [scoped('/buff_types/moon_phase', '/action_types/combat')] })).toBe(
            true
        );
    });

    test('a room with no buffs at all is nothing, either way round', () => {
        expect(houseRoomMovesWinRate({ name: 'Empty' })).toBe(false);
        expect(houseRoomMovesWinRate(null)).toBe(false);
    });

    const houseData = {
        houseRoomDetailMap: {
            '/house_rooms/dairy_barn': {
                ...DAIRY_BARN,
                upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 1 }] },
            },
            '/house_rooms/armory': { ...ARMORY, upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 1 }] } },
        },
    };

    test('the generator offers both sets of rooms or one, depending on which question is asked', () => {
        const all = generateHouseCandidates({ houseRooms: {} }, houseData).map((c) => c.roomHrid);
        const winRate = generateHouseCandidates({ houseRooms: {} }, houseData, 0, null, { winRateOnly: true }).map(
            (c) => c.roomHrid
        );

        expect(all.sort()).toEqual(['/house_rooms/armory', '/house_rooms/dairy_barn']);
        expect(winRate).toEqual(['/house_rooms/armory']);
    });

    test('and the scan counts the same rooms the generator offers', () => {
        expect(describeHouseScan({ houseRooms: {} }, houseData).combatRelevant).toBe(2);
        expect(describeHouseScan({ houseRooms: {} }, houseData, { winRateOnly: true }).combatRelevant).toBe(1);
    });
});

/**
 * Buying several house levels at once.
 *
 * "Mystical Study Lv2 → Lv5" is one row and one simulation rather than three of
 * each, and its cost is levels 3, 4 and 5 added together.
 */
describe('a house target level', () => {
    const roomData = {
        houseRoomDetailMap: {
            '/house_rooms/dojo': {
                name: 'Dojo',
                actionBuffs: [{ typeHrid: '/buff_types/damage' }],
                upgradeCostsMap: {
                    3: [{ itemHrid: '/items/coin', count: 1_000_000 }],
                    4: [{ itemHrid: '/items/coin', count: 2_000_000 }],
                    5: [{ itemHrid: '/items/coin', count: 4_000_000 }],
                },
            },
        },
    };

    test('one row spans every level between where you are and where you asked for', () => {
        const [candidate] = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 2 } }, roomData, 5);

        expect(candidate).toMatchObject({ currentLevel: 2, upgradeLevel: 5, levelsBought: 3 });
        expect(candidate.description).toBe('Dojo Lv2 → Lv5');
    });

    test('and it is costed at all of them, not just the last', () => {
        const [candidate] = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 2 } }, roomData, 5);

        expect(calculateUpgradeCost(candidate, roomData)).toBe(7_000_000);
    });

    test('a target above the cap is the cap rather than a room the game has not got', () => {
        const [candidate] = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 2 } }, roomData, 99);

        expect(candidate.upgradeLevel).toBe(8);
    });
});

/** What a house level actually buys, for the row's Market handoff. */
describe('the materials behind a house level', () => {
    const gameData = {
        itemDetailMap: {
            '/items/lumber': { name: 'Lumber' },
            '/items/bag_of_10_cowbells': { name: 'Bag of 10 Cowbells' },
        },
        houseRoomDetailMap: {
            '/house_rooms/dojo': {
                upgradeCostsMap: {
                    3: [
                        { itemHrid: '/items/coin', count: 5_000_000 },
                        { itemHrid: '/items/lumber', count: 100 },
                    ],
                    4: [
                        { itemHrid: '/items/lumber', count: 200 },
                        { itemHrid: '/items/bag_of_10_cowbells', count: 2 },
                    ],
                },
            },
        },
    };

    test('counts are summed across the levels in the jump, and coins left out', () => {
        const materials = houseUpgradeMaterials(
            { roomHrid: '/house_rooms/dojo', currentLevel: 2, upgradeLevel: 4 },
            gameData
        );

        expect(materials.map((m) => m.itemHrid)).not.toContain('/items/coin');
        expect(materials.find((m) => m.itemHrid === '/items/lumber').count).toBe(300);
        expect(materials.find((m) => m.itemHrid === '/items/bag_of_10_cowbells').count).toBe(2);
    });

    test('a room the game data has nothing for is an empty list rather than a throw', () => {
        expect(houseUpgradeMaterials({ roomHrid: '/house_rooms/nowhere' }, gameData)).toEqual([]);
        expect(houseUpgradeMaterials({}, null)).toEqual([]);
    });
});

/** Several community buff levels in one row. */
describe('a community buff target level', () => {
    test('the row spans from where the buff is to where it was asked for', () => {
        const [expBuff] = generateCommunityBuffCandidates({ comExp: 3, comDrop: 3 }, 8);

        expect(expBuff).toMatchObject({ currentLevel: 3, upgradeLevel: 8, levelsBought: 5 });
        expect(expBuff.description).toContain('Lv3 → Lv8');
    });

    test('a target at or below where it already is falls back to one level up', () => {
        const [expBuff] = generateCommunityBuffCandidates({ comExp: 9 }, 4);

        expect(expBuff.upgradeLevel).toBe(10);
    });

    test('and the ceiling is 20, whatever was typed', () => {
        const [expBuff] = generateCommunityBuffCandidates({ comExp: 3 }, 99);

        expect(expBuff.upgradeLevel).toBe(20);
    });

    test('a buff already at the ceiling still measures the loss rather than a level 21', () => {
        const [expBuff] = generateCommunityBuffCandidates({ comExp: 20 }, 20);

        expect(expBuff).toMatchObject({ measuresLoss: true, upgradeLevel: 0, levelsBought: 0 });
    });
});

/**
 * What a swap is allowed to sell.
 *
 * A skilling piece replacing combat armour arrives carrying `keptItems` and an
 * empty `removedItems` — the skilling generator's way of saying "this trade
 * sells nothing" — and the costing has to honour it. It did not: the tier branch
 * read `currentHrid` directly and credited the plate anyway, producing the
 * −410,000,000 the Skilling tab was showing.
 */
describe('crediting the resale of what a swap replaces', () => {
    const gameData = { itemDetailMap: { '/items/new': { name: 'New' }, '/items/old': { name: 'Old' } } };

    beforeEach(() => {
        resolveItemPrice.mockImplementation((hrid, { side }) => ({
            price: side === 'sell' ? 400_000_000 : 10_000_000,
        }));
        // A listing at the level being bought, so the buy side is the market
        // rather than a simulated enhance path this test is not about
        getItemPrices.mockReturnValue({ ask: 10_000_000, bid: 9_000_000 });
    });

    const candidate = (over = {}) => ({
        type: 'skilling_gear',
        slot: '/equipment_types/body',
        currentHrid: '/items/old',
        currentLevel: 8,
        upgradeHrid: '/items/new',
        upgradeLevel: 5,
        ...over,
    });

    test('an ordinary trade still nets the old piece off the new one', () => {
        expect(calculateUpgradeCost(candidate(), gameData)).toBe(10_000_000 - 400_000_000);
    });

    test('a swap that keeps what it replaces is priced at the new piece alone', () => {
        const kept = candidate({
            keptItems: [{ hrid: '/items/old', enhancementLevel: 8 }],
            removedItems: [],
        });

        expect(calculateUpgradeCost(kept, gameData)).toBe(10_000_000);
    });

    test('and the breakdown agrees with the ranked figure rather than contradicting it', () => {
        const kept = candidate({
            keptItems: [{ hrid: '/items/old', enhancementLevel: 8 }],
            removedItems: [],
        });
        const detail = explainUpgradeCost(kept, gameData);

        expect(detail.credits).toEqual([]);
        expect(detail.net).toBe(10_000_000);
    });
});

describe('what a cross-slot swap displaces', () => {
    const TWO_HAND = '/equipment_types/two_hand';
    const OFF_HAND = '/equipment_types/off_hand';
    const gameData = {
        itemDetailMap: {
            '/items/cursed_bow': { name: 'Cursed Bow' },
            '/items/sundering_crossbow': { name: 'Sundering Crossbow' },
            '/items/manticore_shield': { name: 'Manticore Shield' },
            '/items/vampiric_bow': { name: 'Vampiric Bow' },
        },
    };

    test('a two-hander traded for a one-hander and a shield names the two-hander', () => {
        // The bow is in the slot the swap *clears*, not in either slot it adds
        // to, so a walk of `addedSlots` alone finds two empty slots and reports
        // that the swap displaces nothing
        const candidate = {
            type: 'cross_slot',
            addedSlots: {
                [MAIN_HAND]: { hrid: '/items/sundering_crossbow', enhancementLevel: 7 },
                [OFF_HAND]: { hrid: '/items/manticore_shield', enhancementLevel: 7 },
            },
            clearedSlots: [TWO_HAND],
        };
        const dto = { equipment: { [TWO_HAND]: { hrid: '/items/cursed_bow', enhancementLevel: 7 } } };

        expect(replacedIn(candidate, dto, gameData)).toBe('Cursed Bow +7');
    });

    test('and a one-hander and shield traded for a two-hander names both of them', () => {
        const candidate = {
            type: 'cross_slot',
            addedSlots: { [TWO_HAND]: { hrid: '/items/vampiric_bow', enhancementLevel: 5 } },
            clearedSlots: [MAIN_HAND, OFF_HAND],
        };
        const dto = {
            equipment: {
                [MAIN_HAND]: { hrid: '/items/sundering_crossbow', enhancementLevel: 7 },
                [OFF_HAND]: { hrid: '/items/manticore_shield', enhancementLevel: 0 },
            },
        };

        expect(replacedIn(candidate, dto, gameData)).toBe('Sundering Crossbow +7 + Manticore Shield');
    });

    test('a slot named on both sides is not counted twice', () => {
        const candidate = {
            type: 'cross_slot',
            addedSlots: { [MAIN_HAND]: { hrid: '/items/sundering_crossbow', enhancementLevel: 7 } },
            clearedSlots: [MAIN_HAND],
        };
        const dto = { equipment: { [MAIN_HAND]: { hrid: '/items/vampiric_bow', enhancementLevel: 1 } } };

        expect(replacedIn(candidate, dto, gameData)).toBe('Vampiric Bow +1');
    });
});

describe('the gold-per-percent figure a lab table sorts on', () => {
    test('a purchase is its cost over the percentage points it buys', () => {
        expect(goldPerPercent(2_000_000, 2)).toBe(1_000_000);
    });

    test('a row with no gain, or no coin price, has no figure to rank on', () => {
        expect(goldPerPercent(2_000_000, 0)).toBe(Infinity);
        expect(goldPerPercent(2_000_000, -1)).toBe(Infinity);
        expect(goldPerPercent(null, 2)).toBe(Infinity);
        expect(goldPerPercent(undefined, 2)).toBe(Infinity);
    });

    test('costing nothing beats every purchase instead of sorting with the unpriced', () => {
        // `cost ? cost / delta : Infinity` sent a free upgrade that helps to the
        // bottom of an ascending Gold/1% sort, beside the rows nobody could price
        expect(goldPerPercent(0, 2)).toBe(0);
        expect(goldPerPercent(0, 2)).toBeLessThan(goldPerPercent(2_000_000, 2));
    });

    test('a swap funded by its own resale is ordered by the credit, biggest first', () => {
        // Dividing a credit by the gain makes the *worst* paying-for-itself swap
        // the one that sorts first: a 1M refund for a hair of win rate reads as
        // −20M/%, ahead of a 17.7M refund for five points at −3.5M/%
        const great = goldPerPercent(-17_700_000, 5);
        const feeble = goldPerPercent(-1_000_000, 0.05);

        expect(great).toBeLessThan(feeble);
        expect(feeble).toBeLessThan(goldPerPercent(0, 2));
    });
});

describe('the skilling escalation walk only climbs items the clear-rate model can see', () => {
    const NECK = '/equipment_types/neck';

    beforeEach(() => {
        clearRate.impl = {
            getSkillingMetricsFromOverrides: (skillId) => ({ skillId }),
            computeSkillingClearWithParams: () => ({ clearChance: 0.5, xpPerRoom: 1000 }),
            computeEnhancingClearWithParams: () => ({ clearChance: 0.5, xpPerRoom: 1000 }),
        };
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
        getItemPrices.mockReturnValue(null);
    });

    test('reads only the stats the model is built from, base and enhancement bonuses alike', () => {
        const item = (noncombatStats, noncombatEnhancementBonuses) => ({
            equipmentDetail: { noncombatStats, noncombatEnhancementBonuses },
        });

        expect(canMoveSkillingClearRate(item({ skillingSpeed: 0.05 }))).toBe(true);
        expect(canMoveSkillingClearRate(item({ brewingEfficiency: 0.03 }))).toBe(true);
        expect(canMoveSkillingClearRate(item({ alchemySuccess: 0.02 }))).toBe(true);
        expect(canMoveSkillingClearRate(item({ gatheringQuantity: 0.04 }))).toBe(true);
        // Zero base, growing with enhancement: still measurable
        expect(canMoveSkillingClearRate(item({}, { skillingSpeed: 0.002 }))).toBe(true);

        // Experience feeds xpPerRoom, never the clear rate; rare find feeds nothing here
        expect(canMoveSkillingClearRate(item({ skillingExperience: 0.05 }))).toBe(false);
        expect(canMoveSkillingClearRate(item({ skillingRareFind: 0.05 }))).toBe(false);
        expect(canMoveSkillingClearRate(item({}))).toBe(false);
        expect(canMoveSkillingClearRate(null)).toBe(false);
    });

    test('an experience-only Philosopher swap keeps its +5 instead of being requoted at +20', async () => {
        // The walk exists for breakpoint jumps that land between improvement
        // thresholds. A Philosopher's accessory carries no stat the clear-rate
        // model reads, so its delta stays zero at EVERY level - and the walk
        // used to climb it to +20 anyway, quoting a cost twenty levels deep on
        // a row whose payoff never moved
        buildGameDataPayload.mockReturnValue({
            actionDetailMap: {},
            itemDetailMap: {
                '/items/necklace_of_speed': {
                    name: 'Necklace Of Speed',
                    itemLevel: 60,
                    equipmentDetail: { type: NECK, noncombatStats: { skillingSpeed: 0.05 } },
                },
                '/items/philosophers_necklace': {
                    name: "Philosopher's Necklace",
                    itemLevel: 90,
                    equipmentDetail: {
                        type: NECK,
                        combatStats: { stabDamage: 0.05 },
                        noncombatStats: { skillingExperience: 0.05 },
                    },
                },
            },
        });

        const { results } = await runSkillingUpgradeAnalysis({
            editorDTO: {
                equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 12 } },
                houseRooms: {},
                tokenUpgrades: {},
                communityBuffLevels: {},
            },
            roomLevel: 100,
            crateHrids: [],
        });

        const philo = results.find((r) => r.candidate.upgradeHrid === '/items/philosophers_necklace');
        expect(philo).toBeDefined();
        expect(philo.candidate.upgradeLevel).toBe(5);
        expect(philo.clearRateDelta).toBe(0);

        // The worn speed necklace CAN move the clear rate, so under the same
        // flat mock its walk runs to the cap - proof the gate discriminates
        // rather than switching the escalation off for everybody
        const speed = results.find(
            (r) => r.candidate.type === 'enhancement' && r.candidate.currentHrid === '/items/necklace_of_speed'
        );
        expect(speed.candidate.upgradeLevel).toBe(20);
    });
});
