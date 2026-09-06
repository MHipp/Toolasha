/**
 * Tests for Tea Optimizer Utility
 *
 * Scoped to the pure, self-contained pieces (getRelevantTeas, getTeaBuffDescription).
 * findOptimalTeas/scoreEquipmentSetup/calculateSkillPerformance compose a dozen other
 * calculators (efficiency, experience, equipment, bonus-revenue, alchemy profit) behind
 * private helpers and are exercised end-to-end by their own feature/UI tests instead of
 * being re-mocked wholesale here.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, skills: [] }));
const prices = vi.hoisted(() => ({ byHrid: {}, estimated: new Set() }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getSkills: () => state.skills,
        getEquipment: () => new Map(),
        getHouseRooms: () => new Map(),
        getCommunityBuffLevel: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
        characterData: {},
    },
}));

// calculateAlchemyXpPerHour (and, incorrectly pre-fix, scoreEquipmentSetup's
// alchemy branch under the gold goal too) reaches the real experience-parser
// for a wisdom multiplier, which in turn wants house rooms, community/personal
// buffs and guild data — none of which this file otherwise wires up. Stubbed
// to a neutral multiplier since the tests below only care which calculator was
// asked, not the wisdom arithmetic.
vi.mock('./experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalWisdom: 0, breakdown: { consumableWisdom: 0 }, charmExperience: 0 }),
}));

const alchemyCalc = vi.hoisted(() => ({ decompose: null, coinify: null, transmute: null }));
vi.mock('../features/market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => alchemyCalc.coinify?.(...args) ?? null,
        calculateDecomposeProfit: (...args) => alchemyCalc.decompose?.(...args) ?? null,
        calculateTransmuteProfit: (...args) => alchemyCalc.transmute?.(...args) ?? null,
    },
}));

// actionHasUnpricedMaterials needs the same distinction the real module draws: a price from a
// live order book, a price filled in from the game's value map (`estimated`), or none at all.
// The real module reaches through config/marketAPI/custom-price-overrides, which this file
// otherwise avoids wiring up (see file docblock).
vi.mock('./market-data.js', () => ({
    getItemPrice: (itemHrid) => (itemHrid in prices.byHrid ? prices.byHrid[itemHrid] : null),
    getItemPriceInfo: (itemHrid) => {
        if (!(itemHrid in prices.byHrid)) return { price: null, source: null, estimated: false };
        const estimated = prices.estimated.has(itemHrid);
        return { price: prices.byHrid[itemHrid], source: estimated ? 'value' : 'book', estimated };
    },
}));

const {
    getRelevantTeas,
    getTeaBuffDescription,
    actionHasUnpricedMaterials,
    scoreEquipmentSetup,
    calculateSkillPerformance,
    findOptimalTeas,
    getSkillActionsForDisplay,
} = await import('./tea-optimizer.js');

const knownItems = [
    '/items/milking_tea',
    '/items/super_milking_tea',
    '/items/ultra_milking_tea',
    '/items/efficiency_tea',
    '/items/artisan_tea',
    '/items/wisdom_tea',
    '/items/gathering_tea',
    '/items/processing_tea',
    '/items/gourmet_tea',
    '/items/catalytic_tea',
];

beforeEach(() => {
    state.gameData = { itemDetailMap: Object.fromEntries(knownItems.map((hrid) => [hrid, {}])) };
    state.skills = [];
    prices.byHrid = {};
    prices.estimated = new Set();
    alchemyCalc.decompose = null;
    alchemyCalc.coinify = null;
    alchemyCalc.transmute = null;
});

describe('getRelevantTeas', () => {
    test('artisan tea is production-only — never offered for a gathering skill', () => {
        // Confirmed by the maintainer 2026-08-29: the game does not let Artisan
        // buff gathering actions, so recommending it there scored combos on a
        // bonus that would never apply
        for (const skill of ['milking', 'foraging', 'woodcutting']) {
            for (const goal of ['xp', 'gold']) {
                expect(getRelevantTeas(skill, goal).generalTeas).not.toContain('/items/artisan_tea');
            }
        }
        expect(getRelevantTeas('cooking', 'gold').generalTeas).toContain('/items/artisan_tea');
        expect(getRelevantTeas('cheesesmithing', 'xp').generalTeas).toContain('/items/artisan_tea');
    });

    test('returns empty arrays without game data', () => {
        state.gameData = null;
        expect(getRelevantTeas('milking', 'xp')).toEqual({ skillTeas: [], generalTeas: [] });
    });

    test('gathering skill + gold goal includes gathering and processing teas', () => {
        const { skillTeas, generalTeas } = getRelevantTeas('milking', 'gold');
        expect(skillTeas).toEqual(['/items/milking_tea', '/items/super_milking_tea', '/items/ultra_milking_tea']);
        expect(generalTeas).toContain('/items/gathering_tea');
        expect(generalTeas).toContain('/items/processing_tea');
        expect(generalTeas).not.toContain('/items/artisan_tea'); // production-only, and milking gathers
        expect(generalTeas).not.toContain('/items/catalytic_tea'); // alchemy-only
    });

    test('alchemy skill swaps artisan tea for catalytic tea', () => {
        const { generalTeas } = getRelevantTeas('alchemy', 'gold');
        expect(generalTeas).toContain('/items/catalytic_tea');
        expect(generalTeas).not.toContain('/items/artisan_tea');
    });

    test('cooking/brewing + gold goal includes gourmet tea, gathering skills do not', () => {
        state.gameData.itemDetailMap['/items/cooking_tea'] = {};
        state.gameData.itemDetailMap['/items/super_cooking_tea'] = {};
        state.gameData.itemDetailMap['/items/ultra_cooking_tea'] = {};
        const cooking = getRelevantTeas('cooking', 'gold');
        expect(cooking.generalTeas).toContain('/items/gourmet_tea');

        const milking = getRelevantTeas('milking', 'gold');
        expect(milking.generalTeas).not.toContain('/items/gourmet_tea');
    });

    test('xp goal for cooking/brewing also shows gourmet tea', () => {
        const { generalTeas } = getRelevantTeas('brewing', 'xp');
        expect(generalTeas).toContain('/items/gourmet_tea');
    });

    test('filters out teas that do not exist in game data', () => {
        state.gameData = { itemDetailMap: {} };
        const { skillTeas, generalTeas } = getRelevantTeas('milking', 'gold');
        expect(skillTeas).toEqual([]);
        expect(generalTeas).toEqual([]);
    });

    test('wisdom tea is always included regardless of goal', () => {
        expect(getRelevantTeas('milking', 'xp').generalTeas).toContain('/items/wisdom_tea');
        expect(getRelevantTeas('milking', 'gold').generalTeas).toContain('/items/wisdom_tea');
    });
});

describe('getTeaBuffDescription', () => {
    test('returns empty string without game data or unknown tea', () => {
        state.gameData = null;
        expect(getTeaBuffDescription('/items/efficiency_tea')).toBe('');

        state.gameData = { itemDetailMap: {} };
        expect(getTeaBuffDescription('/items/unknown')).toBe('');
    });

    test('formats an efficiency buff as a percentage with no DC bonus shown at 0 concentration', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/efficiency_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
                },
            },
        };
        expect(getTeaBuffDescription('/items/efficiency_tea', 0)).toBe('+10% eff');
    });

    test('includes the drink-concentration bonus in parentheses when present', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/efficiency_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
                },
            },
        };
        const description = getTeaBuffDescription('/items/efficiency_tea', 0.12);
        expect(description).toContain('+11.2% eff');
        // dcBonus >= 1 is rounded to a whole percent by formatBuffWithDC
        expect(description).toContain('(+1%)');
    });

    test('formats a skill-level buff without a percent sign', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/ultra_milking_tea': {
                    consumableDetail: { buffs: [{ typeHrid: '/buff_types/milking_level', flatBoost: 8 }] },
                },
            },
        };
        expect(getTeaBuffDescription('/items/ultra_milking_tea', 0)).toBe('+8 milking');
    });

    test('joins multiple buffs with a comma', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/multi_tea': {
                    consumableDetail: {
                        buffs: [
                            { typeHrid: '/buff_types/efficiency', flatBoost: 0.1 },
                            { typeHrid: '/buff_types/wisdom', flatBoost: 0.12 },
                        ],
                    },
                },
            },
        };
        const description = getTeaBuffDescription('/items/multi_tea', 0);
        expect(description).toBe('+10% eff, +12% XP');
    });
});

describe('actionHasUnpricedMaterials', () => {
    // calculateGatheringGoldPerHour / calculateProductionGoldPerHour treat a missing price as
    // 0 (revenue for an unpriced output, cost for an unpriced input) — the same convention the
    // live action tile uses. actionHasUnpricedMaterials is the parity piece the tile has that
    // the optimizer didn't: a signal that a gold/hour number rests on treating something as
    // free/worthless rather than on an actual quote.
    const gameData = { actionDetailMap: {} };

    test('a gathering action with every drop priced is not flagged', () => {
        prices.byHrid = { '/items/log': 10, '/items/bark': 5 };
        const action = {
            dropTable: [{ itemHrid: '/items/log' }, { itemHrid: '/items/bark' }],
        };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(false);
    });

    test('a gathering action with one unpriced drop is flagged', () => {
        prices.byHrid = { '/items/log': 10 }; // bark left unpriced -> getItemPrice returns null
        const action = {
            dropTable: [{ itemHrid: '/items/log' }, { itemHrid: '/items/bark' }],
        };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(true);
    });

    test('a production action with an unpriced input is flagged even though the output is priced', () => {
        prices.byHrid = { '/items/cheese': 100 }; // milk left unpriced
        const action = {
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('a production action with an unpriced output is flagged even though inputs are priced', () => {
        prices.byHrid = { '/items/milk': 2 }; // cheese left unpriced
        const action = {
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('coins never count as unpriced, on either side', () => {
        prices.byHrid = { '/items/widget': 50 };
        const action = {
            inputItems: [{ itemHrid: '/items/coin', count: 10 }],
            outputItems: [{ itemHrid: '/items/widget', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(false);
    });

    test('an unpriced upgrade item is flagged', () => {
        prices.byHrid = { '/items/milk': 2, '/items/cheese': 100 };
        const action = {
            upgradeItemHrid: '/items/rare_starter_culture', // unpriced
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });

    test('a gathering drop that feeds an unpriced processing conversion is flagged', () => {
        prices.byHrid = { '/items/raw_hide': 5 }; // tanned_leather (the conversion output) left unpriced
        gameData.actionDetailMap = {
            '/actions/tailoring/tan_hide': {
                type: '/action_types/tailoring',
                inputItems: [{ itemHrid: '/items/raw_hide', count: 1 }],
                outputItems: [{ itemHrid: '/items/tanned_leather', count: 1 }],
            },
        };
        const action = { dropTable: [{ itemHrid: '/items/raw_hide' }] };
        expect(actionHasUnpricedMaterials(action, true, gameData)).toBe(true);
        gameData.actionDetailMap = {};
    });

    test('an item priced only from the value map is flagged — the case a null-price check misses', () => {
        // This is what "unpriced" means since value-filling landed. An item with
        // an empty order book still comes back with a number, from the game's
        // official value map, so `getItemPrice(...) !== null` is true for very
        // nearly everything and a check built on it never fires. `estimated` is
        // the signal market-data.js says replaced it, and it is the one that
        // matches what this flag claims: the gold/hour number rests on a guess
        // rather than on a quote somebody would actually trade at.
        prices.byHrid = { '/items/milk': 2, '/items/cheese': 100 };
        prices.estimated = new Set(['/items/cheese']);
        const action = {
            inputItems: [{ itemHrid: '/items/milk', count: 1 }],
            outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
        };
        expect(actionHasUnpricedMaterials(action, false, gameData)).toBe(true);
    });
});

describe('scoreEquipmentSetup — alchemy', () => {
    // Alchemy XP is derived from item level rather than action data, so the
    // function special-cases it with a representative item — but the special
    // case returned calculateAlchemyXpPerHour unconditionally, ignoring the
    // `goal` argument entirely. The skilling optimizer calls this with
    // goal: 'gold' to rank alchemy equipment by profit
    // (skilling-optimizer-engine.js's goldBaseline/per-candidate scoring, and
    // skilling-optimizer-ui.js's slotGoldBaseline); every one of those calls
    // was silently scored on XP/hour instead.
    beforeEach(() => {
        state.gameData.itemDetailMap['/items/scrap_trinket'] = { alchemyDetail: {}, itemLevel: 5 };
        state.gameData.actionDetailMap = {
            '/actions/alchemy/decompose': {
                type: '/action_types/alchemy',
                name: 'Decompose',
                levelRequirement: { level: 1 },
            },
        };
        state.skills = [{ skillHrid: '/skills/alchemy', level: 10 }];
    });

    test('a gold-goal score comes from the alchemy profit calculator, not the XP path', () => {
        alchemyCalc.decompose = () => ({ profitPerHour: 4321 });

        const score = scoreEquipmentSetup('alchemy', 'gold', new Map(), 10);

        expect(alchemyCalc.decompose).toBeTruthy();
        expect(score).toBe(4321);
    });

    test('an xp-goal score is unaffected by the fix', () => {
        // Not asserting an exact figure (that is calculateAlchemyXpPerHour's own
        // arithmetic to pin) — only that the xp path still runs and does not
        // accidentally get routed through the gold calculator instead.
        alchemyCalc.decompose = () => ({ profitPerHour: 4321 });

        const score = scoreEquipmentSetup('alchemy', 'xp', new Map(), 10);

        expect(score).not.toBe(4321);
        expect(score).toBeGreaterThan(0);
    });
});

describe('calculateSkillPerformance — alchemy', () => {
    // Unlike scoreEquipmentSetup and findOptimalTeas, calculateSkillPerformance had
    // no alchemy special case at all — it ran alchemy actions through the same
    // generic per-action loop as every other production skill. calculateXpPerHour
    // returns 0 for alchemy by design (see its own doc comment: alchemy XP comes
    // from item level, not actionDetails.experienceGain), and
    // calculateProductionGoldPerHour never looks at buffs.alchemySuccess, so a
    // catalytic tea's entire effect on the gold figure was dropped, and the XP
    // figure always read as zero. This feeds the skilling optimizer's simulation
    // panel (skilling-optimizer-ui.js's _runSimulation) whenever Alchemy is picked.
    beforeEach(() => {
        state.gameData.itemDetailMap['/items/scrap_trinket'] = { alchemyDetail: {}, itemLevel: 5 };
        state.gameData.actionDetailMap = {
            '/actions/alchemy/decompose': {
                type: '/action_types/alchemy',
                name: 'Decompose',
                levelRequirement: { level: 1 },
            },
        };
    });

    test('goldPerHour comes from the alchemy profit calculator instead of always reading zero', () => {
        alchemyCalc.decompose = () => ({ profitPerHour: 555 });

        const result = calculateSkillPerformance('alchemy', new Map(), [], 10);

        expect(alchemyCalc.decompose).toBeTruthy();
        expect(result.goldPerHour).toBe(555);
    });
});

describe('an unpriced tea is flagged rather than charged as free', () => {
    // calculateTeaCostPerHour billed a tea with no real book price at
    // `getItemPrice(...) || 0` — i.e. free — with no signal that the number
    // rests on a guess, unlike an unpriced action material
    // (actionHasUnpricedMaterials), which the surrounding gold figure is
    // already careful to flag. A combo that only clears a profit because its
    // tea reads as free could win the ranking with no indication of that.
    beforeEach(() => {
        state.gameData.itemDetailMap['/items/unpriced_tea'] = {};
        state.gameData.actionDetailMap = {
            '/actions/cheesesmithing/make_cheese': {
                type: '/action_types/cheesesmithing',
                name: 'Make Cheese',
                levelRequirement: { level: 1 },
                inputItems: [{ itemHrid: '/items/cheap_input', count: 1 }],
                outputItems: [{ itemHrid: '/items/pricey_output', count: 1 }],
            },
        };
        // The tea itself is deliberately left out of prices.byHrid — getItemPriceInfo
        // reports it as null, matching "nobody has ever listed this"
        prices.byHrid = { '/items/cheap_input': 1, '/items/pricey_output': 1000 };
    });

    test('calculateSkillPerformance flags a profitable action whose tea cost is unpriced', () => {
        const result = calculateSkillPerformance('cheesesmithing', new Map(), ['/items/unpriced_tea'], 10);

        expect(result.goldPerHour).toBeGreaterThan(0); // the action is genuinely profitable either way
        expect(result.hasMissingPrices).toBe(true);
    });

    test('a fully priced tea does not raise the flag', () => {
        prices.byHrid['/items/unpriced_tea'] = 5;

        const result = calculateSkillPerformance('cheesesmithing', new Map(), ['/items/unpriced_tea'], 10);

        expect(result.hasMissingPrices).toBe(false);
    });
});

describe('findOptimalTeas — gold ranking picks the best average, not the best sum', () => {
    // Every caller headlines avgScore, not totalScore (tea-recommendation.js,
    // skilling-optimizer-ui.js), but "optimal" used to mean whichever combo
    // scored the highest totalScore. For the gold goal the two are not
    // proportional: avgScore's divisor is profitableCount, which differs
    // combo to combo, so a combo that makes many actions barely profitable
    // can out-sum (and so get picked as "optimal") a combo with a single,
    // far more profitable action — and the UI then headlines *that worse
    // combo's own* (much lower) avgScore as the best figure available, while
    // a combo with a genuinely higher average sat un-picked in the same
    // results list.
    //
    // "richer" is always profitable and unaffected by either tea (no
    // inputs). Five "filler" actions are unprofitable at baseline and turn
    // only barely profitable once artisan tea halves their input cost. The
    // artisan-alone combo racks up a bigger sum (richer + five slim
    // margins) than the efficiency-alone combo (richer alone, scaled up a
    // little) — but its average is dragged down by the five slim fillers,
    // well below efficiency-alone's clean, single-action average.
    beforeEach(() => {
        const itemDetailMap = {
            '/items/efficiency_tea': {
                consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
            },
            '/items/artisan_tea': {
                consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.5 }] },
            },
            '/items/filler_input': {},
            '/items/filler_output': {},
            '/items/richer_output': {},
        };
        const actionDetailMap = {
            '/actions/cheesesmithing/richer': {
                type: '/action_types/cheesesmithing',
                name: 'Richer',
                levelRequirement: { level: 1 },
                outputItems: [{ itemHrid: '/items/richer_output', count: 1 }],
            },
        };
        // Five actions that only clear a profit once artisan tea's 50% input
        // reduction applies: baseline profit is 450 - 800 = -350/action;
        // with artisan it is 450 - 400 = 50/action, enough to survive the
        // market tax on the full 450 of output revenue
        for (let i = 0; i < 5; i++) {
            actionDetailMap[`/actions/cheesesmithing/filler_${i}`] = {
                type: '/action_types/cheesesmithing',
                name: `Filler ${i}`,
                levelRequirement: { level: 1 },
                inputItems: [{ itemHrid: '/items/filler_input', count: 10 }],
                outputItems: [{ itemHrid: '/items/filler_output', count: 1 }],
            };
        }
        state.gameData.itemDetailMap = itemDetailMap;
        state.gameData.actionDetailMap = actionDetailMap;
        prices.byHrid = {
            '/items/filler_input': 80,
            '/items/filler_output': 450,
            '/items/richer_output': 300,
        };
        state.skills = [{ skillHrid: '/skills/cheesesmithing', level: 1 }];
    });

    test('optimal is the combo with the best avgScore among everything evaluated', () => {
        const result = findOptimalTeas('cheesesmithing', 'gold', null, null, null, null, new Map());

        expect(result.error).toBeUndefined();
        const bestAvg = Math.max(...result.allResults.map((r) => r.avgScore));
        expect(result.optimal.avgScore).toBeCloseTo(bestAvg, 6);
    });
});

describe('getSkillActionsForDisplay — game order', () => {
    // The picker used to sort by level then name, which reorders actions that share a level
    // requirement against the order the game itself lists them in (Foraging's level-1 actions
    // are the visible case). The game's sortIndex is the authority.
    beforeEach(() => {
        state.gameData.actionDetailMap = {
            '/actions/foraging/egg': {
                type: '/action_types/foraging',
                name: 'Egg',
                levelRequirement: { level: 1 },
                sortIndex: 3,
            },
            '/actions/foraging/apple': {
                type: '/action_types/foraging',
                name: 'Apple',
                levelRequirement: { level: 1 },
                sortIndex: 1,
            },
            '/actions/foraging/blueberry': {
                type: '/action_types/foraging',
                name: 'Blueberry',
                levelRequirement: { level: 20 },
                sortIndex: 2,
            },
            '/actions/milking/cow': {
                type: '/action_types/milking',
                name: 'Cow',
                levelRequirement: { level: 1 },
                sortIndex: 1,
            },
        };
    });

    test('orders by sortIndex, not by level then name', () => {
        const actions = getSkillActionsForDisplay('Foraging', 30);
        expect(actions.map((a) => a.name)).toEqual(['Apple', 'Blueberry', 'Egg']);
    });

    test('an action with no sortIndex sorts first, ties broken by name', () => {
        state.gameData.actionDetailMap['/actions/foraging/zucchini'] = {
            type: '/action_types/foraging',
            name: 'Zucchini',
            levelRequirement: { level: 1 },
        };
        state.gameData.actionDetailMap['/actions/foraging/acorn'] = {
            type: '/action_types/foraging',
            name: 'Acorn',
            levelRequirement: { level: 1 },
        };
        const actions = getSkillActionsForDisplay('Foraging', 30);
        expect(actions.slice(0, 2).map((a) => a.name)).toEqual(['Acorn', 'Zucchini']);
    });

    test('still reports availability against the player level', () => {
        const actions = getSkillActionsForDisplay('Foraging', 5);
        expect(actions.find((a) => a.name === 'Blueberry')).toMatchObject({ requiredLevel: 20, available: false });
        expect(actions.find((a) => a.name === 'Apple')).toMatchObject({ requiredLevel: 1, available: true });
    });
});
